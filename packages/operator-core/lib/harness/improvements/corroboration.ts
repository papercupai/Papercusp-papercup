/**
 * Corroboration count (unified-bug-pipeline-and-honest-queue-2026-10-05 P-012, D-049).
 *
 * How many INDEPENDENT reporters filed the same condition. The record already exists:
 * `harness_shared.work_item_occurrences` holds one row per filing with its reporter
 * (capture appends one on mint and on every fold). The count is the number of distinct
 * non-empty reporters there. Filings (volume) are reported beside it, because one
 * chatty source can file the same thing thousands of times without corroborating it.
 *
 * What it is FOR: ordering verification work and showing reviewers how widely a
 * condition was seen. What it is NOT: a verification receipt. Nothing in the
 * acceptance seal (`evaluateImplementationAcceptance`) or the claim floor reads this
 * module, the ledger, `repeatCount`, `reporters` or `reporterKinds` — a bug becomes
 * claimable only with a recorded reproduction receipt, however many reporters it has.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../../work-items';
import { REPORTER_KINDS, type ReporterKind } from './provenance';

/**
 * Occurrence kinds that are a REPORT. 'promoted' is excluded: it records an admission
 * step on an existing filing (same reporter), not a new report of the condition.
 */
export const CORROBORATION_FILING_KINDS = ['canonical-created', 'coalesced', 'duplicate', 'regression'] as const;

export const CORROBORATION_NOTE =
  'Orders verification work only. It is never a verification receipt: a bug still needs a recorded reproduction receipt before it is claimable.';

/** What the ledger says about one item. */
export interface CorroborationLedgerRow {
  /** Distinct non-empty reporters across every occurrence row of the item. */
  reporters: number;
  /** Occurrence rows that are reports (see CORROBORATION_FILING_KINDS). */
  filings: number;
  firstFiledAt: string | null;
  lastFiledAt: string | null;
}

/** The corroboration block shown on an item. */
export interface CorroborationSummary extends CorroborationLedgerRow {
  /** Distinct reporter kinds that filed it (payload.reporterKinds, D-044 pt 4). */
  reporterKinds: ReporterKind[];
  note: typeof CORROBORATION_NOTE;
}

export const EMPTY_CORROBORATION: CorroborationLedgerRow = {
  reporters: 0,
  filings: 0,
  firstFiledAt: null,
  lastFiledAt: null,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The stored reporter-kind tally in canonical order; unknown entries are dropped. */
export function readReporterKinds(payload: unknown): ReporterKind[] {
  const stored = record(payload).reporterKinds;
  if (!Array.isArray(stored)) return [];
  const seen = new Set(stored.filter((k): k is string => typeof k === 'string'));
  return REPORTER_KINDS.filter((k) => seen.has(k));
}

/** Pure: the block `work_items:get` shows for one item. */
export function summarizeCorroboration(
  ledger: CorroborationLedgerRow | null | undefined,
  payload: unknown,
): CorroborationSummary {
  const row = ledger ?? EMPTY_CORROBORATION;
  return {
    reporters: row.reporters,
    filings: row.filings,
    firstFiledAt: row.firstFiledAt,
    lastFiledAt: row.lastFiledAt,
    reporterKinds: readReporterKinds(payload),
    note: CORROBORATION_NOTE,
  };
}

/** The subject id a verification task names (P-007 `payload.verification.subject`). */
type VerificationSubjectIdSql = "wi.payload -> 'verification' ->> 'subject'";
/** The fixed id expressions the ledger subquery may key on; never caller text. */
type IdColumn = 'wi.feature_id' | VerificationSubjectIdSql;

/**
 * SQL scalar: the corroboration count of the item named by `idColumn`, read from the
 * occurrence ledger in the same workspace and harness as the outer `wi` row. Keyed on
 * (workspace_id, canonical_harness_slug, canonical_work_item_id), the prefix of
 * `work_item_occurrences_canonical_idx`. Never NULL (an item with no rows counts 0),
 * so it can sit in an ORDER BY without a NULLS clause.
 *
 * Keep the direct and distinct-promotion canonical ids as separate UNION branches. An OR
 * between them makes Postgres scan and sort thousands of occurrence rows per candidate
 * while evaluating claim-next's ORDER BY; each branch here pins the canonical-id index to
 * one lookup.
 */
export function corroborationReportersSql(sql: OrgSql, idColumn: IdColumn = 'wi.feature_id') {
  return sql`(
    SELECT count(DISTINCT btrim(reports.reporter))
      FROM (
        SELECT o.reporter
          FROM harness_shared.work_item_occurrences o
         WHERE o.workspace_id = wi.workspace_id
           AND o.canonical_harness_slug = wi.harness_slug
           AND o.canonical_work_item_id = ${sql.unsafe(idColumn)}
           AND btrim(COALESCE(o.reporter, '')) <> ''
        UNION ALL
        SELECT o.reporter
          FROM harness_shared.work_items source
          JOIN harness_shared.work_item_occurrences o
            ON o.workspace_id = source.workspace_id
           AND o.canonical_harness_slug = source.harness_slug
           AND o.canonical_work_item_id = (source.payload -> 'intakeSource' ->> 'id')
           AND btrim(COALESCE(o.reporter, '')) <> ''
         WHERE source.workspace_id = wi.workspace_id
           AND source.harness_slug = wi.harness_slug
           AND source.feature_id = ${sql.unsafe(idColumn)}
           AND source.payload -> 'intakeSource' ->> 'mode' = 'distinct'
      ) reports
  )`;
}

/** The subject-of-a-verification-task form of {@link corroborationReportersSql}. */
export const VERIFICATION_SUBJECT_ID_SQL: VerificationSubjectIdSql = "wi.payload -> 'verification' ->> 'subject'";

/** Read the ledger for a batch of items in one query. Items with no rows are absent from the map. */
export async function readCorroboration(
  sql: OrgSql,
  input: { workspaceId: string; items: ReadonlyArray<{ id: string; harness: string | null | undefined }> },
): Promise<Map<string, CorroborationLedgerRow>> {
  const out = new Map<string, CorroborationLedgerRow>();
  const items = input.items.filter((i) => i.id && i.harness);
  if (items.length === 0) return out;
  const ids = items.map((i) => i.id);
  const harnesses = items.map((i) => i.harness as string);
  const rows = await sql<
    { id: string; reporters: string | number; filings: string | number; first_at: Date | string | null; last_at: Date | string | null }[]
  >`
    SELECT k.id AS id,
           count(DISTINCT btrim(o.reporter)) FILTER (WHERE btrim(COALESCE(o.reporter, '')) <> '') AS reporters,
           count(*) FILTER (WHERE o.report_kind = ANY(${[...CORROBORATION_FILING_KINDS]}::text[])) AS filings,
           min(o.occurred_at) AS first_at,
           max(o.occurred_at) AS last_at
      FROM harness_shared.work_item_occurrences o
      JOIN unnest(${ids}::text[], ${harnesses}::text[]) AS k(id, harness)
        ON o.canonical_harness_slug = k.harness
      LEFT JOIN harness_shared.work_items target
        ON target.workspace_id = ${input.workspaceId} AND target.harness_slug = k.harness AND target.feature_id = k.id
     WHERE o.workspace_id = ${input.workspaceId}
       AND (o.canonical_work_item_id = k.id OR (
         target.payload -> 'intakeSource' ->> 'mode' = 'distinct'
         AND o.canonical_work_item_id = target.payload -> 'intakeSource' ->> 'id'))
     GROUP BY k.id`;
  const iso = (v: Date | string | null): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  for (const r of rows) {
    out.set(r.id, {
      reporters: Number(r.reporters),
      filings: Number(r.filings),
      firstFiledAt: iso(r.first_at),
      lastFiledAt: iso(r.last_at),
    });
  }
  return out;
}

/** Reporter identities are evidence for independence, never an admission receipt. */
export async function readOccurrenceReporters(sql: OrgSql, input: { workspaceId: string; id: string; harness: string }): Promise<string[]> {
  const rows = await sql<{ reporter: string }[]>`
    SELECT DISTINCT btrim(o.reporter) AS reporter
      FROM harness_shared.work_item_occurrences o
      LEFT JOIN harness_shared.work_items target
        ON target.workspace_id = ${input.workspaceId} AND target.harness_slug = ${input.harness} AND target.feature_id = ${input.id}
     WHERE o.workspace_id = ${input.workspaceId} AND o.canonical_harness_slug = ${input.harness}
       AND (o.canonical_work_item_id = ${input.id} OR (
         target.payload -> 'intakeSource' ->> 'mode' = 'distinct'
         AND o.canonical_work_item_id = target.payload -> 'intakeSource' ->> 'id'))
       AND btrim(COALESCE(o.reporter, '')) <> ''
     ORDER BY reporter`;
  return rows.map((row) => row.reporter);
}

/**
 * The block shown on one item, or null when nothing corroborates it (no ledger rows
 * and no stored reporter kinds), so an ordinary feature read stays lean. Throws on a
 * failed read; the caller decides how to fail soft.
 */
export async function readCorroborationSummary(
  input: { workspaceId: string; id: string; harness: string | null | undefined; payload: unknown },
  sql: OrgSql = getOrgPg().sql as unknown as OrgSql,
): Promise<CorroborationSummary | null> {
  const ledger = (await readCorroboration(sql, { workspaceId: input.workspaceId, items: [input] })).get(input.id);
  const summary = summarizeCorroboration(ledger, input.payload);
  return ledger || summary.reporterKinds.length > 0 ? summary : null;
}
