/**
 * P-007 bar-critique gate for plans:start (plan verification-system-improvements-2026-10-10,
 * D-003 threshold, D-004 door, D-014 per-clause semantic pin, D-015 close-time pins,
 * removals, bar-set changes and lineage).
 *
 * A contracted plan may start only when every CURRENT clause and the current acceptance
 * bar set — and every clause removed or superseded since a critique pinned it — is covered
 * by the required number of closed-answered `bar-critique` consults answered from distinct
 * lineages outside the plan author's.
 *
 * Pins are SEMANTIC: a clause's identity for critique purposes is a hash over what it
 * promises (behavior, falsifier, class, evidence, layers, mutation, exemption, plane) and
 * deliberately excludes lifecycle, acceptance fields, revision numbers and timestamps,
 * because plans:start itself flips draft clauses active and that must never invalidate a
 * pre-start critique (SPEC-P-007-ACTIVATION-STABLE).
 *
 * 'Current' is the revision the clause store reports as current (`listSpecClauses`
 * without history, i.e. plans:get-specs), never `lifecycle_status='active'`: superseded
 * revisions stay active in the revision table (EI-25646079436389752).
 *
 * The pure core below takes no I/O. `loadBarCritiqueEvidence` is the only database
 * reader; it rebuilds each critique's record as of its `closed_at` from the immutable
 * revision history, so the pins are exactly what a close-time snapshot would have stored.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { lineagePartyKeys } from '../../acceptance-author-identity';
import { BAR_CRITIQUE_POLICY } from '../../consult/selection-policies';
import { listSpecClauses, type SpecClauseRevision, type SpecLifecycleStatus } from './spec-clauses-store';

export { BAR_CRITIQUE_POLICY };

/** Lifecycles that take a clause out of the plan's live contract. */
export const BAR_CRITIQUE_REMOVED_LIFECYCLES: ReadonlySet<SpecLifecycleStatus> = new Set<SpecLifecycleStatus>([
  'superseded',
  'retired',
]);

export type BarCritiqueClause = Pick<
  SpecClauseRevision,
  | 'specId'
  | 'revision'
  | 'behavior'
  | 'behaviorClass'
  | 'requiredEvidence'
  | 'requiredTestLayers'
  | 'mutationRequired'
  | 'exemption'
  | 'falsifier'
  | 'lifecycleStatus'
  | 'createdAt'
  | 'sourceBar'
>;

export type BarCritiqueGateCode = 'critique_missing' | 'critique_stale';

export interface BarCritiquePin {
  specId: string;
  revision: number;
  semanticHash: string;
}

export interface BarCritiqueRecord {
  schemaVersion: 1;
  planSlug: string;
  closedAt: string;
  answeredAt: string | null;
  barSetHash: string | null;
  /** Every live clause as of the close, pinned by semantic hash. */
  pins: BarCritiquePin[];
  /** Clause revisions created after the critic answered and up to the close. */
  dispositionRevisions: Array<{ specId: string; revision: number; createdAt: string }>;
}

export interface BarCritiqueEvidence {
  consultId: string;
  /** Who actually answered (the routed fork when the consult was routed). */
  criticId: string;
  /** Lineage key from `lineagePartyKeys`; a critic and its fork share one. */
  partyKey: string;
  record: BarCritiqueRecord;
}

export interface BarCritiqueGateInput {
  planSlug: string;
  currentClauses: readonly BarCritiqueClause[];
  critiques: readonly BarCritiqueEvidence[];
  /** Lineage keys of the plan author; critiques from these count zero. */
  authorPartyKeys: ReadonlySet<string>;
  threshold: number;
}

export interface BarCritiqueShortfall {
  specId: string;
  revision?: number;
  coveredBy: number;
  reason: 'missing' | 'stale' | 'removed';
}

export interface BarCritiqueGateVerdict {
  satisfied: boolean;
  planSlug: string;
  code?: BarCritiqueGateCode;
  message?: string;
  threshold: number;
  barSetHash: string | null;
  /** Counted (outside-lineage) critiques. */
  consultIds: string[];
  /** Distinct outside lineages that answered. */
  critics: string[];
  /** Critiques ignored because they came from the author's lineage. */
  authorLineageConsultIds: string[];
  clauseShortfalls: BarCritiqueShortfall[];
  barSetShortfall: { coveredBy: number; reason: 'missing' | 'stale' } | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Hash over what a clause promises; lifecycle, acceptance and timestamps excluded. */
export function clauseSemanticHash(clause: BarCritiqueClause): string {
  const f = clause.falsifier;
  const payload = {
    behavior: clause.behavior,
    behaviorClass: clause.behaviorClass,
    falsifier: f
      ? {
          observation: f.observation,
          probeMethod: f.probeMethod ?? null,
          requiredScenarios: f.requiredScenarios ? [...f.requiredScenarios].sort() : null,
          causalPairing: f.causalPairing ?? null,
        }
      : null,
    requiredEvidence: [...(clause.requiredEvidence ?? [])].sort(),
    requiredTestLayers: [...(clause.requiredTestLayers ?? [])].sort(),
    mutationRequired: Boolean(clause.mutationRequired),
    exemption: clause.exemption ?? null,
    evidencePlane: clause.sourceBar?.evidencePlane ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

export function isLiveBarCritiqueClause(clause: Pick<BarCritiqueClause, 'lifecycleStatus'>): boolean {
  return !BAR_CRITIQUE_REMOVED_LIFECYCLES.has(clause.lifecycleStatus);
}

/** Current bar set: the barSetHash pinned by the newest rubric revision among live BAR projections. */
export function barSetHashOf(clauses: readonly BarCritiqueClause[]): string | null {
  let best: { hash: string; revision: number } | null = null;
  for (const clause of clauses) {
    if (!isLiveBarCritiqueClause(clause) || !clause.sourceBar?.barSetHash) continue;
    const revision = Number(clause.sourceBar.rubricRevision) || 0;
    if (!best || revision > best.revision) best = { hash: clause.sourceBar.barSetHash, revision };
  }
  return best?.hash ?? null;
}

/** D-003: one critique, two when the plan has >8 non-dropped items or >3 mandatory outcome bars. */
export function barCritiqueThreshold(input: { nonDroppedItemCount: number; mandatoryOutcomeBarCount: number }): 1 | 2 {
  return input.nonDroppedItemCount > 8 || input.mandatoryOutcomeBarCount > 3 ? 2 : 1;
}

/**
 * Build the record a critique closing at `closedAt` pins. `clausesAsOfClose` is the
 * clause store's as-of snapshot at the close; `history` is every revision of the plan's
 * clauses (used only for the disposition window).
 */
export function buildBarCritiqueRecord(input: {
  planSlug: string;
  closedAt: string;
  answeredAt: string | null;
  clausesAsOfClose: readonly BarCritiqueClause[];
  history: readonly BarCritiqueClause[];
}): BarCritiqueRecord {
  const live = input.clausesAsOfClose.filter(isLiveBarCritiqueClause);
  const closedMs = Date.parse(input.closedAt);
  const answeredMs = input.answeredAt ? Date.parse(input.answeredAt) : Number.NaN;
  const dispositionRevisions = Number.isFinite(answeredMs)
    ? input.history
        .filter((rev) => {
          const at = Date.parse(rev.createdAt);
          return at > answeredMs && at <= closedMs;
        })
        .map((rev) => ({ specId: rev.specId, revision: rev.revision, createdAt: rev.createdAt }))
        .sort((a, b) => a.specId.localeCompare(b.specId) || a.revision - b.revision)
    : [];
  return {
    schemaVersion: 1,
    planSlug: input.planSlug,
    closedAt: input.closedAt,
    answeredAt: input.answeredAt,
    barSetHash: barSetHashOf(live),
    pins: live
      .map((c) => ({ specId: c.specId, revision: c.revision, semanticHash: clauseSemanticHash(c) }))
      .sort((a, b) => a.specId.localeCompare(b.specId)),
    dispositionRevisions,
  };
}

export function evaluateBarCritiqueGate(input: BarCritiqueGateInput): BarCritiqueGateVerdict {
  const threshold = Math.max(1, Math.trunc(input.threshold));
  const counted = input.critiques.filter((c) => !input.authorPartyKeys.has(c.partyKey));
  const authorLineageConsultIds = input.critiques
    .filter((c) => input.authorPartyKeys.has(c.partyKey))
    .map((c) => c.consultId);
  const live = input.currentClauses.filter(isLiveBarCritiqueClause);
  const liveIds = new Set(live.map((c) => c.specId));
  const clauseShortfalls: BarCritiqueShortfall[] = [];

  for (const clause of live) {
    const hash = clauseSemanticHash(clause);
    const parties = new Set<string>();
    let pinnedOtherHash = false;
    for (const critique of counted) {
      const pin = critique.record.pins.find((p) => p.specId === clause.specId);
      if (!pin) continue;
      if (pin.semanticHash === hash) parties.add(critique.partyKey);
      else pinnedOtherHash = true;
    }
    if (parties.size < threshold) {
      clauseShortfalls.push({
        specId: clause.specId,
        revision: clause.revision,
        coveredBy: parties.size,
        reason: pinnedOtherHash ? 'stale' : 'missing',
      });
    }
  }

  // A clause a counted critique pinned that is no longer live was removed or superseded.
  // It stays stale until `threshold` distinct lineages closed a later critique over a
  // contract that no longer contains it (a delta critique naming the change).
  const removedIds = new Set<string>();
  for (const critique of counted) {
    for (const pin of critique.record.pins) if (!liveIds.has(pin.specId)) removedIds.add(pin.specId);
  }
  for (const specId of [...removedIds].sort()) {
    const lastPinnedMs = Math.max(
      ...counted
        .filter((c) => c.record.pins.some((p) => p.specId === specId))
        .map((c) => Date.parse(c.record.closedAt)),
    );
    const parties = new Set(
      counted
        .filter(
          (c) => Date.parse(c.record.closedAt) > lastPinnedMs && !c.record.pins.some((p) => p.specId === specId),
        )
        .map((c) => c.partyKey),
    );
    if (parties.size < threshold) clauseShortfalls.push({ specId, coveredBy: parties.size, reason: 'removed' });
  }

  const barSetHash = barSetHashOf(live);
  let barSetShortfall: BarCritiqueGateVerdict['barSetShortfall'] = null;
  if (barSetHash) {
    const parties = new Set(counted.filter((c) => c.record.barSetHash === barSetHash).map((c) => c.partyKey));
    if (parties.size < threshold) {
      const pinnedOther = counted.some((c) => c.record.barSetHash && c.record.barSetHash !== barSetHash);
      barSetShortfall = { coveredBy: parties.size, reason: pinnedOther ? 'stale' : 'missing' };
    }
  }

  const stale =
    clauseShortfalls.some((s) => s.reason !== 'missing') || barSetShortfall?.reason === 'stale';
  const satisfied = clauseShortfalls.length === 0 && barSetShortfall === null;
  const verdict: BarCritiqueGateVerdict = {
    satisfied,
    planSlug: input.planSlug,
    threshold,
    barSetHash,
    consultIds: counted.map((c) => c.consultId),
    critics: [...new Set(counted.map((c) => c.partyKey))],
    authorLineageConsultIds,
    clauseShortfalls,
    barSetShortfall,
  };
  if (satisfied) return verdict;
  const code: BarCritiqueGateCode = stale ? 'critique_stale' : 'critique_missing';
  const named = clauseShortfalls
    .slice(0, 8)
    .map((s) => `${s.specId} (${s.reason}, ${s.coveredBy}/${threshold})`)
    .join(', ');
  verdict.code = code;
  verdict.message =
    `Plan '${input.planSlug}' needs ${threshold} closed-answered bar critique(s) from distinct lineages outside the ` +
    `author's covering its current contract. ` +
    (named ? `Short: ${named}${clauseShortfalls.length > 8 ? `, +${clauseShortfalls.length - 8} more` : ''}. ` : '') +
    (barSetShortfall ? `Bar set ${barSetHash?.slice(0, 12)}: ${barSetShortfall.reason}, ${barSetShortfall.coveredBy}/${threshold}. ` : '') +
    `Open one with consult:get_feedback { policy:'${BAR_CRITIQUE_POLICY}', origin_task_ref:'${input.planSlug}', question } ` +
    `naming the changed bars and clauses, then retry once it closes answered.`;
  return verdict;
}

/** Injectable readers so the loader is testable without a clause store. */
export interface LoadBarCritiqueEvidenceDeps {
  sql: Sql;
  listClauses?: typeof listSpecClauses;
  partyKeys?: (ownerIds: readonly string[]) => Promise<Map<string, string>>;
}

/**
 * The gate's only database reader. A plan's critiques are its closed-answered consults
 * under the bar-critique policy whose origin_task_ref is the plan slug
 * (SPEC-P-007-CRITIQUE-REF). The critic is the author of the first answer post, NOT
 * consult_state.responder_id: for a routed consult that column names the source expert
 * whose transcript was forked, not the session that answered. Each record is rebuilt as of
 * the consult's closed_at from the immutable revision history.
 */
export async function loadBarCritiqueEvidence(
  input: { workspaceId: string; harnessSlug: string; planSlug: string; authorIds: readonly string[] },
  deps: LoadBarCritiqueEvidenceDeps,
): Promise<{ critiques: BarCritiqueEvidence[]; authorPartyKeys: Set<string> }> {
  const rows = (await deps.sql`
    SELECT cs.conversation_id, cs.closed_at, cs.responder_id, ans.author_id, ans.created_at AS answered_at
      FROM harness_shared.consult_state cs
      LEFT JOIN LATERAL (
        SELECT m.author_id, m.created_at FROM harness_shared.consult_post_meta m
         WHERE m.workspace_id = cs.workspace_id AND m.conversation_id = cs.conversation_id AND m.kind = 'answer'
         ORDER BY m.created_at ASC, m.post_id ASC LIMIT 1
      ) ans ON true
     WHERE cs.workspace_id = ${input.workspaceId}
       AND cs.origin_task_ref = ${input.planSlug}
       AND cs.routing->>'policy' = ${BAR_CRITIQUE_POLICY}
       AND cs.state = 'closed_answered'
       AND cs.closed_at IS NOT NULL
     ORDER BY cs.closed_at ASC, cs.conversation_id ASC
  `) as unknown as Array<{
    conversation_id: string;
    closed_at: Date | string;
    responder_id: string | null;
    author_id: string | null;
    answered_at: Date | string | null;
  }>;
  const partyKeys = deps.partyKeys ?? ((ids) => lineagePartyKeys(ids, { sql: deps.sql, workspaceId: input.workspaceId }));
  const authorIds = input.authorIds.map((id) => id.trim()).filter(Boolean);
  const criticOf = (row: (typeof rows)[number]) => row.author_id?.trim() || row.responder_id?.trim() || null;
  // Authors first, so a critic in the author's lineage resolves to the AUTHOR's key.
  const keys = await partyKeys([...authorIds, ...rows.map(criticOf).filter((id): id is string => !!id)]);
  const authorPartyKeys = new Set(authorIds.map((id) => keys.get(id) ?? id));
  if (rows.length === 0) return { critiques: [], authorPartyKeys };
  const listClauses = deps.listClauses ?? listSpecClauses;
  const scope = { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, planSlug: input.planSlug };
  const history = await listClauses({ ...scope, includeHistory: true });
  const iso = (v: Date | string) => new Date(v).toISOString();
  const critiques: BarCritiqueEvidence[] = [];
  // These immutable close-time snapshots are independent. Bound concurrency so
  // readiness does not serialize one database round trip per historical consult
  // or admit unbounded reads for a plan with a long critique history.
  const attributableRows = rows.filter((row) => criticOf(row) !== null);
  const snapshotBatchSize = 4;
  for (let offset = 0; offset < attributableRows.length; offset += snapshotBatchSize) {
    const batch = await Promise.all(attributableRows.slice(offset, offset + snapshotBatchSize).map(async (row) => {
      const criticId = criticOf(row)!;
      const closedAt = iso(row.closed_at);
      const clausesAsOfClose = await listClauses({ ...scope, asOf: closedAt });
      return {
        consultId: row.conversation_id,
        criticId,
        partyKey: keys.get(criticId) ?? criticId,
        record: buildBarCritiqueRecord({
          planSlug: input.planSlug,
          closedAt,
          answeredAt: row.answered_at ? iso(row.answered_at) : null,
          clausesAsOfClose,
          history,
        }),
      };
    }));
    // Promise.all retains database order even when snapshots finish out of order.
    // A rejected read propagates; partial records never become an allowed verdict.
    critiques.push(...batch);
  }
  return { critiques, authorPartyKeys };
}

/**
 * Cohort boundary: plans created before this instant had no way to open a bar-critique
 * consult (the policy did not exist), so for them the verdict is recorded on the start
 * metadata and never refuses. Plans created at or after it are enforced.
 */
export const BAR_CRITIQUE_GATE_EFFECTIVE_AT = '2026-10-11T03:00:00.000Z';

/** Unknown creation time must still reach the full enforcement check. */
export function isPlanStartBarCritiqueInCohort(createdMs: number): boolean {
  return !Number.isFinite(createdMs) || createdMs >= Date.parse(BAR_CRITIQUE_GATE_EFFECTIVE_AT);
}

export interface PlanStartBarCritiqueOutcome {
  mode: 'enforced' | 'report-only';
  /** Why the mode is report-only; absent when enforced. */
  reportOnlyReason?: 'pre-cohort' | 'spec-quality-report-only';
  authorIds: string[];
  mandatoryOutcomeBarCount: number;
  nonDroppedItemCount: number;
  verdict: BarCritiqueGateVerdict;
}

/**
 * plans:start's entry point. Returns null for a plan with no current clauses (not a
 * contracted plan: nothing to critique). The author set is every identity the plan row and
 * its activation audits record as having authored or seeded it; their lineage counts zero.
 */
export async function evaluatePlanStartBarCritique(
  input: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    nonDroppedItemCount: number;
    /** True when the spec-quality gate enforces this plan's contract. */
    contractEnforced: boolean;
  },
  deps: Partial<LoadBarCritiqueEvidenceDeps> = {},
): Promise<PlanStartBarCritiqueOutcome | null> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const scope = { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, planSlug: input.planSlug };
  const currentClauses = await listClauses(scope);
  if (currentClauses.length === 0) return null;
  const sql = deps.sql ?? getOrgPg().sql;
  const [planRows, auditRows] = await Promise.all([
    sql<Array<{ owner: string | null; acceptance_bar_seeded_by: string | null; created_at: Date | string }>>`
      SELECT owner, acceptance_bar_seeded_by, created_at FROM harness_shared.harness_plans
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND plan_slug = ${input.planSlug}
    `,
    sql<Array<{ created_by: string | null }>>`
      SELECT created_by FROM harness_shared.plan_audits
       WHERE workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug} AND audit_kind = 'activation'
       ORDER BY audit_seq
    `,
  ]);
  const plan = planRows[0];
  const authorIds = [
    ...new Set(
      [plan?.owner, plan?.acceptance_bar_seeded_by, ...auditRows.map((r) => r.created_by)]
        .map((id) => id?.trim() ?? '')
        .filter(Boolean),
    ),
  ];
  const live = currentClauses.filter(isLiveBarCritiqueClause);
  const mandatoryOutcomeBarCount = new Set(
    live.map((c) => c.sourceBar?.barKey).filter((k): k is string => Boolean(k)),
  ).size;
  const threshold = barCritiqueThreshold({ nonDroppedItemCount: input.nonDroppedItemCount, mandatoryOutcomeBarCount });
  const evidence = await loadBarCritiqueEvidence(
    { ...scope, authorIds },
    { sql, listClauses, ...(deps.partyKeys ? { partyKeys: deps.partyKeys } : {}) },
  );
  const verdict = evaluateBarCritiqueGate({
    planSlug: input.planSlug,
    currentClauses,
    critiques: evidence.critiques,
    authorPartyKeys: evidence.authorPartyKeys,
    threshold,
  });
  const createdMs = plan ? Date.parse(new Date(plan.created_at).toISOString()) : Number.NaN;
  const inCohort = isPlanStartBarCritiqueInCohort(createdMs);
  const reportOnlyReason = !input.contractEnforced ? 'spec-quality-report-only' : !inCohort ? 'pre-cohort' : undefined;
  return {
    mode: reportOnlyReason ? 'report-only' : 'enforced',
    ...(reportOnlyReason ? { reportOnlyReason } : {}),
    authorIds,
    mandatoryOutcomeBarCount,
    nonDroppedItemCount: input.nonDroppedItemCount,
    verdict,
  };
}
