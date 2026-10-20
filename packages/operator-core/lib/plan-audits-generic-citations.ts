/**
 * Generic (non-code) audit citations — plan-verification-profiles-2026-10-17 P-003 (R-7, R-8).
 *
 * `code`/`test` citations prove that SOURCE exists: they resolve against the tree and carry a
 * git blob SHA so a rewritten file makes the audit stale (plan-audits D-007). A non-code
 * deliverable (a report, a decision, an operation, a measurement) has no file to resolve, so
 * before this module its only honest citations were `doc`/`none` — explicitly NON-verifying.
 * Every non-code item therefore read as "unverified" however well it was evidenced.
 *
 * This module adds four kinds whose targets live in platform storage, each with a CONTENT
 * HASH that plays the role the blob SHA plays for code:
 *
 *   artifact     `ref`: `rpt_…` (report_library), `plan:<slug>` (harness_plans), or
 *                `doc:<id>` / `/internal/docs/<id>` (harness_docs).
 *   work-item    `ref`: `WI-…` / `EI-…` / `F-…`; must be terminally done.
 *   measurement  `ref`: `test-run:<id>` (the test_runs results ledger); must be a pass.
 *   external     `url` + `snapshotHash` (sha256 hex of the captured snapshot).
 *
 * Two boundaries keep D-008 intact (a work-item or a doc is a record of INTENT, never proof
 * that code exists):
 *   1. These kinds verify ONLY an item whose resolved deliverable is non-code
 *      (`genericCitationVerifies`). A code deliverable still needs `code`/`test`.
 *   2. The content hash is stamped by the server at audit time from the store, never taken
 *      from the auditor — except `external`, whose snapshot only the auditor captured.
 *
 * Everything here except `loadGenericCitationLookup` is pure, so the resolution and
 * freshness rules are unit-tested without a database.
 */
import { createHash } from 'node:crypto';

export const GENERIC_CITATION_KINDS = ['artifact', 'work-item', 'measurement', 'external'] as const;
export type GenericCitationKind = (typeof GENERIC_CITATION_KINDS)[number];

export function isGenericCitationKind(kind: unknown): kind is GenericCitationKind {
  return typeof kind === 'string' && (GENERIC_CITATION_KINDS as readonly string[]).includes(kind);
}

/** The fields a generic citation may carry (a structural subset of `AuditCitation`). */
export interface GenericCitationFields {
  kind: string;
  ref?: string;
  url?: string;
  snapshotHash?: string;
  /** Server-stamped at audit time; compared with the store's current hash (R-8). */
  contentHash?: string;
}

export type GenericCitationLocator =
  | { kind: 'artifact'; store: 'report' | 'plan' | 'doc'; id: string; key: string }
  | { kind: 'work-item'; id: string; key: string }
  | { kind: 'measurement'; store: 'test-run'; id: string; key: string }
  | { kind: 'external'; url: string; snapshotHash: string; key: string };

export type GenericCitationFailureReason =
  | 'ref_missing'
  | 'ref_unrecognized'
  | 'url_missing'
  | 'url_invalid'
  | 'snapshot_hash_missing'
  | 'snapshot_hash_invalid'
  | 'target_not_found'
  | 'target_unsettled'
  | 'target_unmeasured';

export type GenericCitationResolution =
  | { ok: true; contentHash: string; locator: GenericCitationLocator }
  | { ok: false; reason: GenericCitationFailureReason; detail?: string };

const REPORT_ID_RE = /^rpt_[A-Za-z0-9_-]+$/;
const WORK_ITEM_ID_RE = /^(?:WI|EI|F)-\d+$/;
const TEST_RUN_RE = /^test-run:(\d+)$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Parse a generic citation into the store row it names. Pure; no store access. */
export function parseGenericCitation(
  citation: GenericCitationFields,
): { ok: true; locator: GenericCitationLocator } | { ok: false; reason: GenericCitationFailureReason; detail?: string } {
  if (citation.kind === 'external') {
    const url = citation.url?.trim();
    if (!url) return { ok: false, reason: 'url_missing' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'url_invalid', detail: url };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, reason: 'url_invalid', detail: `${url} is not an http(s) URL` };
    }
    const snapshotHash = citation.snapshotHash?.trim().toLowerCase();
    if (!snapshotHash) return { ok: false, reason: 'snapshot_hash_missing' };
    if (!SHA256_HEX_RE.test(snapshotHash)) {
      return { ok: false, reason: 'snapshot_hash_invalid', detail: 'snapshotHash must be a 64-character sha256 hex digest' };
    }
    return { ok: true, locator: { kind: 'external', url, snapshotHash, key: `external:${url}#${snapshotHash}` } };
  }

  const ref = citation.ref?.trim();
  if (!ref) return { ok: false, reason: 'ref_missing' };

  if (citation.kind === 'artifact') {
    if (REPORT_ID_RE.test(ref)) return { ok: true, locator: { kind: 'artifact', store: 'report', id: ref, key: `report:${ref}` } };
    if (ref.startsWith('plan:') && ref.length > 'plan:'.length) {
      const id = ref.slice('plan:'.length);
      return { ok: true, locator: { kind: 'artifact', store: 'plan', id, key: `plan:${id}` } };
    }
    const docId = ref.startsWith('doc:') ? ref.slice('doc:'.length) : ref.startsWith('/internal/docs/') ? ref.slice('/internal/docs/'.length) : null;
    if (docId) return { ok: true, locator: { kind: 'artifact', store: 'doc', id: docId, key: `doc:${docId}` } };
    return {
      ok: false,
      reason: 'ref_unrecognized',
      detail: `artifact ref '${ref}' is not a report id (rpt_…), plan:<slug>, doc:<id> or /internal/docs/<id>`,
    };
  }
  if (citation.kind === 'work-item') {
    if (WORK_ITEM_ID_RE.test(ref)) return { ok: true, locator: { kind: 'work-item', id: ref, key: `work-item:${ref}` } };
    return { ok: false, reason: 'ref_unrecognized', detail: `work-item ref '${ref}' is not a WI-/EI-/F- id` };
  }
  if (citation.kind === 'measurement') {
    const m = TEST_RUN_RE.exec(ref);
    if (m) return { ok: true, locator: { kind: 'measurement', store: 'test-run', id: m[1]!, key: `test-run:${m[1]}` } };
    return { ok: false, reason: 'ref_unrecognized', detail: `measurement ref '${ref}' is not test-run:<id>` };
  }
  return { ok: false, reason: 'ref_unrecognized', detail: `'${citation.kind}' is not a generic citation kind` };
}

/** What the store says about one locator right now. */
export interface GenericTargetState {
  found: boolean;
  /** sha256 of the target's evidence-bearing content; null when not found. */
  contentHash: string | null;
  /** False when the target exists but is not evidence yet: an open work item, a failing run. */
  settled: boolean;
  detail?: string;
}

/** Locator key → current state. Built by `loadGenericCitationLookup`, or by a test. */
export type GenericCitationLookup = ReadonlyMap<string, GenericTargetState>;

/**
 * Resolve one generic citation against a lookup. `ok` means the citation is well formed and
 * its target exists and is settled; `contentHash` is the hash to stamp (audit) or compare (gate).
 * A target missing from the lookup is `target_unmeasured`: the caller did not load it, which
 * is never read as "exists".
 */
export function resolveGenericCitation(
  citation: GenericCitationFields,
  lookup: GenericCitationLookup,
): GenericCitationResolution {
  const parsed = parseGenericCitation(citation);
  if (!parsed.ok) return parsed;
  const { locator } = parsed;
  if (locator.kind === 'external') return { ok: true, contentHash: locator.snapshotHash, locator };
  const state = lookup.get(locator.key);
  if (!state) return { ok: false, reason: 'target_unmeasured', detail: locator.key };
  if (!state.found || !state.contentHash) {
    return { ok: false, reason: 'target_not_found', detail: state.detail ?? locator.key };
  }
  if (!state.settled) return { ok: false, reason: 'target_unsettled', detail: state.detail ?? locator.key };
  return { ok: true, contentHash: state.contentHash, locator };
}

/** The label a stale reason names: the ref or the URL. */
export function genericCitationLabel(citation: GenericCitationFields): string {
  return citation.kind === 'external' ? (citation.url ?? '(no url)') : (citation.ref ?? '(no ref)');
}

/**
 * R-8 — content-hash freshness. Returns why an audit citing this target is stale, or null
 * when the target still resolves to the hash stamped at audit time.
 */
export function genericCitationStaleReason(
  citation: GenericCitationFields,
  lookup: GenericCitationLookup,
  auditSeq?: number,
): string | null {
  const label = `${citation.kind} ${genericCitationLabel(citation)}`;
  const at = auditSeq != null ? ` (audit #${auditSeq})` : '';
  if (!citation.contentHash) return `${label} has no audit-time content hash${at}`;
  const current = resolveGenericCitation(citation, lookup);
  if (!current.ok) return `${label} no longer resolves: ${current.reason}${at}`;
  if (current.contentHash !== citation.contentHash) return `${label} changed since audit${at}`;
  return null;
}

/**
 * R-7 — a generic citation is VERIFYING evidence only for a non-code deliverable. An
 * unknown deliverable (`undefined`) fails safe to "does not verify", like an unknown
 * profile fails safe to coding (D-005).
 */
export function genericCitationVerifies(
  citation: { kind: string },
  item: { codeDeliverable?: boolean | null },
): boolean {
  return isGenericCitationKind(citation.kind) && item.codeDeliverable === false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Content hash of a work item: the fields that make it evidence. Exported for tests. */
export function workItemContentHash(row: { status: string | null; closed_at?: unknown; payload_completion?: unknown }): string {
  return sha256(JSON.stringify([row.status ?? null, row.closed_at == null ? null : String(row.closed_at), row.payload_completion ?? null]));
}

/** Content hash of a results-ledger row. Exported for tests. */
export function testRunContentHash(row: { status: string | null; commit_sha?: string | null; file_path?: string | null; finished_at?: unknown }): string {
  return sha256(JSON.stringify([row.status ?? null, row.commit_sha ?? null, row.file_path ?? null, row.finished_at == null ? null : String(row.finished_at)]));
}

/** Content hash of a report / plan / doc body. Exported for tests. */
export function bodyContentHash(body: string): string {
  return sha256(body);
}

const WORK_ITEM_DONE_STATES = new Set(['done', 'resolved', 'closed']);

export type GenericLookupQuery = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Load the current state of every target the citations name, in one query per store.
 * `workspaceId` scopes work items and reports (an id names one row per workspace). A plan
 * slug that exists in several harnesses is scoped by `harnessSlug` when given.
 */
export async function loadGenericCitationLookup(
  citations: readonly GenericCitationFields[],
  deps: { query: GenericLookupQuery; workspaceId?: string | null; harnessSlug?: string | null },
): Promise<Map<string, GenericTargetState>> {
  const lookup = new Map<string, GenericTargetState>();
  const byStore = { report: new Set<string>(), plan: new Set<string>(), doc: new Set<string>(), workItem: new Set<string>(), testRun: new Set<string>() };
  for (const citation of citations) {
    if (!isGenericCitationKind(citation.kind)) continue;
    const parsed = parseGenericCitation(citation);
    if (!parsed.ok) continue;
    const l = parsed.locator;
    if (l.kind === 'artifact') byStore[l.store].add(l.id);
    else if (l.kind === 'work-item') byStore.workItem.add(l.id);
    else if (l.kind === 'measurement') byStore.testRun.add(l.id);
  }
  const notFound = (key: string) => lookup.set(key, { found: false, contentHash: null, settled: false, detail: `${key} not found` });
  const ws = deps.workspaceId ?? null;

  if (byStore.report.size > 0) {
    const ids = [...byStore.report];
    const { rows } = await deps.query(
      `SELECT report_id, body_md, retired_at FROM harness_shared.report_library
        WHERE report_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ($2::text IS NULL OR workspace_id = $2)`,
      [JSON.stringify(ids), ws],
    );
    for (const id of ids) {
      const row = rows.find((r) => r.report_id === id);
      if (!row || row.retired_at != null) notFound(`report:${id}`);
      else lookup.set(`report:${id}`, { found: true, contentHash: bodyContentHash(String(row.body_md ?? '')), settled: true });
    }
  }
  if (byStore.plan.size > 0) {
    const ids = [...byStore.plan];
    const { rows } = await deps.query(
      `SELECT plan_slug, content FROM harness_shared.harness_plans
        WHERE plan_slug IN (SELECT jsonb_array_elements_text($1::jsonb))
          AND ($2::text IS NULL OR harness_slug = $2) AND ($3::text IS NULL OR workspace_id = $3)`,
      [JSON.stringify(ids), deps.harnessSlug ?? null, ws],
    );
    for (const id of ids) {
      const matches = rows.filter((r) => r.plan_slug === id);
      if (matches.length !== 1) {
        lookup.set(`plan:${id}`, {
          found: false,
          contentHash: null,
          settled: false,
          detail: matches.length === 0 ? `plan:${id} not found` : `plan:${id} is ambiguous across ${matches.length} harnesses`,
        });
      } else {
        lookup.set(`plan:${id}`, { found: true, contentHash: bodyContentHash(String(matches[0]!.content ?? '')), settled: true });
      }
    }
  }
  if (byStore.doc.size > 0) {
    const ids = [...byStore.doc];
    const { rows } = await deps.query(
      `SELECT doc_id, content, retired_at FROM harness_shared.harness_docs
        WHERE doc_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ($2::text IS NULL OR workspace_id = $2)`,
      [JSON.stringify(ids), ws],
    );
    for (const id of ids) {
      const live = rows.filter((r) => r.doc_id === id && r.retired_at == null);
      if (live.length === 0) notFound(`doc:${id}`);
      else lookup.set(`doc:${id}`, { found: true, contentHash: bodyContentHash(String(live[0]!.content ?? '')), settled: true });
    }
  }
  if (byStore.workItem.size > 0) {
    const ids = [...byStore.workItem];
    const { rows } = await deps.query(
      `SELECT feature_id, status, closed_ts AS closed_at, payload->'completion' AS payload_completion FROM harness_shared.work_items
        WHERE feature_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND ($2::text IS NULL OR workspace_id = $2)`,
      [JSON.stringify(ids), ws],
    );
    for (const id of ids) {
      const row = rows.find((r) => r.feature_id === id);
      if (!row) {
        notFound(`work-item:${id}`);
        continue;
      }
      const status = row.status == null ? null : String(row.status);
      const settled = status != null && WORK_ITEM_DONE_STATES.has(status);
      lookup.set(`work-item:${id}`, {
        found: true,
        contentHash: workItemContentHash({ status, closed_at: row.closed_at, payload_completion: row.payload_completion }),
        settled,
        ...(settled ? {} : { detail: `work-item:${id} is '${status ?? 'unknown'}', not done` }),
      });
    }
  }
  if (byStore.testRun.size > 0) {
    const ids = [...byStore.testRun];
    const { rows } = await deps.query(
      `SELECT id::text AS id, status, commit_sha, file_path, finished_at FROM harness_shared.test_runs
        WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::bigint)`,
      [JSON.stringify(ids)],
    );
    for (const id of ids) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) {
        notFound(`test-run:${id}`);
        continue;
      }
      const status = row.status == null ? null : String(row.status);
      lookup.set(`test-run:${id}`, {
        found: true,
        contentHash: testRunContentHash({
          status,
          commit_sha: row.commit_sha as string | null,
          file_path: row.file_path as string | null,
          finished_at: row.finished_at,
        }),
        settled: status === 'pass',
        ...(status === 'pass' ? {} : { detail: `test-run:${id} is '${status ?? 'unknown'}', not a pass` }),
      });
    }
  }
  return lookup;
}
