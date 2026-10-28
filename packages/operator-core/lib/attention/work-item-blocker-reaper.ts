/**
 * work-item-blocker-reaper.ts — the ENFORCEMENT half of the owner-attention ledger
 * (WI-10005010; the DECLARATION half is EI-23783029010995961).
 *
 * `work_items:set_blocker` already REQUIRES a `defaultIfUnanswered` on owner-capability
 * asks and the owner card/digest disclose it — but until this module nothing ENFORCED it,
 * so the declared default was only a promise. `gate-reaper.ts` does this for SESSION
 * gates (`session_pending_gates`); this is its work-item sibling and reuses its shape:
 * a PURE decide-fn (`decideBlockerDefault`, external-blockers.ts) feeding a sweep.
 *
 * OWNER-AUTHORITY SEMANTICS (the design ruling). An agent acting on an owner's silence
 * must never act on prose it did not author a closed meaning for, so:
 *   - ONLY the typed `defaultAction` (a closed vocabulary: `stay_parked` |
 *     `release_to_agents`) ever executes. The free-text default is never interpreted.
 *   - A blocker with a passed `decideBy` but no typed action is surfaced, not applied.
 *   - Exactly once: `defaultAppliedAt` is the fence, written in the same payload write
 *     that applies the action, and the history row records who/when/what.
 *   - Rollout is inert by construction: only blockers that carry BOTH `decideBy` and a
 *     typed `defaultAction` are candidates (measured 2026-10-01: 233 active human
 *     blockers, 0 with either), so nothing is applied retroactively.
 *
 * Hosted inside the existing `gate-watcher-tick` system action (gate-watch-action.ts) as
 * an additive, isolated try/catch — no new routine, no third scheduler.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  applyBlockerDefaultToHistory,
  decideBlockerDefault,
  readExternalBlockers,
  updateExternalBlockerHistory,
  type BlockerDefaultSkipReason,
  type ExternalBlockerRecord,
  type OwnerAskDefaultAction,
} from '../external-blockers';
import {
  getWorkItem,
  mergeWorkItemPayload,
  setWorkItemClaimHold,
  setWorkItemStateWithAliasInfo,
} from '../work-items';
import { assertHoldRegistered, hasActiveStrictHumanAsk } from '../hold-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { readEventConditionReachability, type ExternalConditionReachability } from '../external-condition-reachability';
import { openEscalation } from '../agent-tools/coordination/escalations';
import { activeWorkspaceId } from '../workspace-registry';
import { followUpSystemClears, type SystemClearedBlockerItem } from '../work-item-ref-blocker-auto-clear';

import { ISSUE_FAMILY_ROUTE_KINDS } from '../work-nature/agent-work-predicate';
export const BLOCKER_DEFAULT_REAPER_ACTOR = 'system:blocker-default-reaper';
/** event-wait-settlement-2026-10-20 P-005: who settles a missed proving fire on recovery. */
export const MISSED_FIRE_RECOVERY_ACTOR = 'system:event-settlement-recovery';
/** event-wait-settlement-2026-10-20 P-005: who returns a stranded blocked item to open. */
export const STRANDED_BLOCKED_REPAIR_ACTOR = 'system:blocker-stranded-repair';

/** A `blocked` item whose external blockers are all non-active (P-005, R-10). */
export interface StrandedBlockedCandidate {
  id: string;
  harness: string;
  family: 'feature' | 'issue';
  holder: string | null;
  /** When the item last changed lifecycle state (work_items.state_changed_at, migration 896). */
  stateChangedAt: string | null;
  /** The raw `payload.externalBlockers` array. */
  blockers: unknown;
}

export type StrandedSkipReason = 'no-blocker' | 'active-blocker' | 'no-clear-time' | 'no-state-time' | 'reblocked-after-clear';

/** What restoring one stranded item did: reconcileClearedDependencyBlockedState's outcome. */
export type StrandedRepairOutcome =
  | 'cleared' | 'not-blocked' | 'stale-control' | 'external-blocker' | 'reserved' | 'live-dependency'
  | 'plan-blocked' | 'read-failed';

/**
 * P-005 (R-10): is this `blocked` item stranded — left blocked by a clear that did not
 * restore its lifecycle? It is when it has at least one blocker, none is active, and it was
 * ALREADY blocked when its last blocker was cleared (state_changed_at at or before the latest
 * clear). An item moved into `blocked` after its blockers were all cleared was blocked for a
 * reason the blocker history does not record, so it is left alone (measured 2026-10-20: 6 of
 * 20 such items, re-blocked 24 minutes to 12 days after the last clear). A non-active record
 * without `clearedAt` contributes its `updatedAt`.
 */
export function decideStrandedRepair(input: { stateChangedAt: string | null; blockers: unknown }):
  | { repair: true; lastClearedAt: string }
  | { repair: false; why: StrandedSkipReason } {
  const records = Array.isArray(input.blockers)
    ? input.blockers.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b))
    : [];
  if (records.length === 0) return { repair: false, why: 'no-blocker' };
  if (records.some((b) => b.status === 'active')) return { repair: false, why: 'active-blocker' };
  let lastClear = NaN;
  for (const b of records) {
    const at = Date.parse(String(b.clearedAt ?? b.updatedAt ?? ''));
    if (Number.isFinite(at) && !(at <= lastClear)) lastClear = at;
  }
  if (!Number.isFinite(lastClear)) return { repair: false, why: 'no-clear-time' };
  const stateAt = input.stateChangedAt ? Date.parse(input.stateChangedAt) : NaN;
  if (!Number.isFinite(stateAt)) return { repair: false, why: 'no-state-time' };
  if (stateAt > lastClear) return { repair: false, why: 'reblocked-after-clear' };
  return { repair: true, lastClearedAt: new Date(lastClear).toISOString() };
}

export interface BlockerReapCandidate {
  id: string;
  harness: string;
  payload: unknown;
}

export interface BlockerReapDeps {
  listCandidates(limit: number): Promise<BlockerReapCandidate[]>;
  /** Fresh read so the apply is compare-and-set against CURRENT blocker history. */
  readPayload(
    id: string,
    harness: string,
  ): Promise<{ payload: unknown; family?: string; state?: string; holder?: string | null } | null>;
  writeBlockers(id: string, harness: string, blockers: ExternalBlockerRecord[], expected?: unknown): Promise<boolean>;
  resolveCondition?(blocker: ExternalBlockerRecord): Promise<ExternalConditionReachability>;
  escalate?(id: string, harness: string, blocker: ExternalBlockerRecord): Promise<void>;
  /** Return the item to the claimable pool (or the right parked state) after a release.
   *  Resolves to the lifecycle state it set, when it set one. */
  restoreLifecycle(args: {
    id: string;
    harness: string;
    family?: string;
    state?: string;
    remaining: ExternalBlockerRecord[];
  }): Promise<string | void>;
  /** After a re-check CLEARED a blocker: the shared system-clear follow-up (refresh
   *  claimable views, message and wake the holder — event-wait-settlement-2026-10-20
   *  P-003). Optional so a test's fake deps opt in; the production deps always run it. */
  followUp?(items: SystemClearedBlockerItem[]): Promise<unknown>;
  /** P-005 (Design 5, R-9): proving keys whose fire latch shows a fire after an active wait on
   *  them was created — a settlement the emit missed. Optional: absent, the pass is skipped. */
  listMissedFireKeys?(limit: number): Promise<{ keys: string[]; truncatedByLimit: boolean }>;
  /** Settle every wait on one proving key (settleProvingFire); resolves to how many it settled. */
  settleFiredKey?(key: string): Promise<number>;
  /** P-005 (R-10): `blocked` items whose external blockers are all non-active. Optional. */
  listStrandedBlocked?(limit: number): Promise<StrandedBlockedCandidate[]>;
  /** Return one stranded item to open under a row lock, re-checking every other hold. */
  repairStranded?(candidate: StrandedBlockedCandidate): Promise<StrandedRepairOutcome>;
  /** WI-6554700010030445: non-terminal items with an ACTIVE externalBlockers row that
   *  readExternalBlockers drops. The raw-payload SQL still parks such an item while every
   *  typed reader (this re-check, set_blocker's clear) ignores it. Optional: absent, skipped. */
  listMalformedActiveBlockers?(limit: number): Promise<Array<{ id: string; harness: string }>>;
}

export interface BlockerSweepResult {
  examined: number;
  applied: Record<OwnerAskDefaultAction, number>;
  rechecked: { cleared: number; escalated: number };
  skipped: Partial<Record<BlockerDefaultSkipReason | 'lost-race' | 'read-failed', number>>;
  truncatedByLimit: boolean;
  /** P-005 (R-9): missed proving fires the sweep settled. `settled` counts waits, `failed` keys. */
  recovered: { keys: number; settled: number; failed: number; truncatedByLimit: boolean };
  /** P-005 (R-10): stranded `blocked` items examined and returned to open, with why others stayed. */
  repaired: {
    examined: number;
    reopened: number;
    skipped: Partial<Record<StrandedSkipReason | Exclude<StrandedRepairOutcome, 'cleared'> | 'failed', number>>;
    truncatedByLimit: boolean;
  };
  /** WI-6554700010030445: items parked by an active blocker row no typed reader parses.
   *  `count` is a floor when `truncatedByLimit`; `sample` names up to 10 as harness/id;
   *  `failed` means the listing threw, so `count` measured nothing. */
  malformed: { count: number; sample: string[]; truncatedByLimit: boolean; failed: boolean };
}

function bump(result: BlockerSweepResult, why: keyof BlockerSweepResult['skipped']): void {
  result.skipped[why] = (result.skipped[why] ?? 0) + 1;
}

export const defaultBlockerReapDeps: BlockerReapDeps = {
  async listCandidates(limit) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; harness: string; payload: unknown }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.payload AS payload
        FROM harness_shared.work_items w
       WHERE NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(w.payload->'externalBlockers') b
                WHERE b->>'status' = 'active' AND (
                  (b->>'kind' = 'human' AND b->>'decideBy' IS NOT NULL
                    AND b->>'defaultAction' IS NOT NULL AND b->>'defaultAppliedAt' IS NULL)
                  OR b->>'recheckAt' <= ${new Date().toISOString()}))
       ORDER BY w.feature_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, harness: r.harness, payload: r.payload }));
  },
  async readPayload(id, harness) {
    const wi = await getWorkItem(id, harness);
    return wi ? { payload: wi.payload, family: wi.family, state: wi.state, holder: wi.assignee } : null;
  },
  async writeBlockers(id, harness, blockers, expected) {
    if (expected === undefined) {
      return (await mergeWorkItemPayload(id, { externalBlockers: blockers }, { harness })) !== null;
    }
    // Compare the RAW history, preserving unknown/legacy fields in the fence.
    // A fresh read alone does not stop a concurrent set/clear from being overwritten.
    const { sql } = getOrgPg();
    const rows = await sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{externalBlockers}', ${JSON.stringify(blockers)}::text::jsonb),
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${harness} AND feature_id = ${id}
         AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND COALESCE(payload->'externalBlockers', '[]'::jsonb) = ${JSON.stringify(expected)}::text::jsonb
      RETURNING feature_id`;
    return rows.length > 0;
  },
  async resolveCondition(blocker) {
    if (blocker.kind === 'event' || blocker.kind === 'gate') {
      // Releasing work requires proof of its specific condition, including on re-check.
      return readEventConditionReachability(blocker.ref, { requireSpecificCondition: true });
    }
    return { verdict: 'unknown', basis: 'unmeasured', authoritative: false,
      evidence: 'Runtime and owner capabilities require the named next action.', checkedAt: new Date().toISOString() };
  },
  async escalate(id, harness, blocker) {
    await openEscalation({ ownerId: BLOCKER_DEFAULT_REAPER_ACTOR, ownerLabel: 'system · blocker reaper',
      source: 'principal', workspaceId: activeWorkspaceId(), userId: null }, {
      severity: 'advisory', summary: `${id}: blocker ${blocker.ref} reached its re-check date and remains active.`,
      body: `Condition: ${blocker.kind}:${blocker.ref}. Next action: ${blocker.nextVerb}. ` +
        `Re-check was due ${blocker.recheckAt}; ${blocker.reachability?.evidence ?? 'no condition completion was proved'}. ` +
        'Expiry does not grant authority or prove that the condition cleared.',
      harness_slug: harness,
      meta: { subjectSignature: `blocker-recheck:${harness}:${id}:${blocker.kind}:${blocker.ref}` },
    });
  },
  // Mirrors work_items:set_blocker's lifecycle restore branch-for-branch: lifecycle
  // follows the blockers that REMAIN, never the shape of this request.
  async restoreLifecycle({ id, harness, family, state, remaining }) {
    if (remaining.length > 0) {
      // D-029: the hold registry's answerable ask, the predicate the needs-human writer refuses on.
      const strict = hasActiveStrictHumanAsk({ externalBlockers: remaining });
      const parked = strict ? 'needs-human' : 'blocked';
      await setWorkItemStateWithAliasInfo(id, parked, {
        harness,
        by: BLOCKER_DEFAULT_REAPER_ACTOR,
      });
      return parked;
    } else if (family === 'feature' && (state === 'blocked' || state === 'needs-human')) {
      await setWorkItemStateWithAliasInfo(id, 'open', { harness, by: BLOCKER_DEFAULT_REAPER_ACTOR });
      return 'open';
    } else if (family === 'issue') {
      await setWorkItemClaimHold(id, false, {
        harness,
        by: BLOCKER_DEFAULT_REAPER_ACTOR,
        reason: 'owner-ask decideBy passed; typed default release_to_agents applied',
      });
      // setWorkItemClaimHold only strips the payload hold keys — it never touches `status`.
      // An issue parked on a strict human ask is stored as `needs-human` (set_blocker
      // enters it via setWorkItemStateWithAliasInfo), so without this the item would be
      // left `needs-human` with ZERO active blockers: unclaimable AND unexplained. Found
      // by the real-PG integration test (WI-10005093); the fake-deps unit test could not.
      if (state === 'blocked' || state === 'needs-human') {
        await setWorkItemStateWithAliasInfo(id, 'open', { harness, by: BLOCKER_DEFAULT_REAPER_ACTOR });
        return 'open';
      }
    }
  },
  followUp: (items) => followUpSystemClears(items),
  // P-005: imported lazily — events/await/store and work-item-blocking are heavy, and this
  // module is loaded on the gate-watcher tick path.
  async listMissedFireKeys(limit) {
    const { listMissedProvingFireKeys } = await import('../events/await/store');
    return listMissedProvingFireKeys({ limit });
  },
  async settleFiredKey(key) {
    const { settleProvingFire } = await import('../events/await/store');
    return settleProvingFire(key, { firedBy: MISSED_FIRE_RECOVERY_ACTOR });
  },
  async listStrandedBlocked(limit) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      id: string; harness: string; item_kind: string | null; taken_by: string | null;
      state_changed_at: Date | string | null; blockers: unknown;
    }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.item_kind, w.taken_by,
             w.state_changed_at, w.payload -> 'externalBlockers' AS blockers
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND w.status = 'blocked'
         AND w.lane IS DISTINCT FROM 'observation'
         AND jsonb_array_length(CASE WHEN jsonb_typeof(w.payload -> 'externalBlockers') = 'array'
                                     THEN w.payload -> 'externalBlockers' ELSE '[]'::jsonb END) > 0
         AND NOT ((w.payload -> 'externalBlockers') @> '[{"status":"active"}]'::jsonb)
       ORDER BY w.feature_id
       LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      harness: r.harness,
      family: (ISSUE_FAMILY_ROUTE_KINDS as readonly string[]).includes(String(r.item_kind)) ? 'issue' as const : 'feature' as const,
      holder: r.taken_by?.trim() || null,
      stateChangedAt: r.state_changed_at ? new Date(r.state_changed_at).toISOString() : null,
      blockers: r.blockers,
    }));
  },
  async repairStranded(candidate) {
    const item = await getWorkItem(candidate.id, candidate.harness);
    if (!item) return 'read-failed';
    const { reconcileClearedDependencyBlockedState } = await import('../work-item-blocking');
    // The shared checked restore: under a row lock it re-reads the item and refuses when a
    // live dependency, an active blocker, a durable park, an owner reservation or a blocked
    // plan lane still holds it. Readiness and review floors survive the state change.
    return reconcileClearedDependencyBlockedState(item, 'external-blockers-all-cleared', {
      actor: STRANDED_BLOCKED_REPAIR_ACTOR,
    });
  },
  async listMalformedActiveBlockers(limit) {
    const { sql } = getOrgPg();
    // The inner predicate is readExternalBlockers' rejection rule (external-blockers.ts),
    // restricted to rows whose status is 'active'. The integration test runs both over the
    // same fixtures, so a change to one that the other does not follow fails there.
    const rows = await sql<Array<{ id: string; harness: string }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND w.lane IS DISTINCT FROM 'observation'
         AND (w.payload -> 'externalBlockers') @> '[{"status":"active"}]'::jsonb
         AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.payload -> 'externalBlockers') = 'array'
                                                THEN w.payload -> 'externalBlockers' ELSE '[]'::jsonb END) b
                WHERE b ->> 'status' = 'active'
                  AND (jsonb_typeof(b -> 'kind') IS DISTINCT FROM 'string'
                    OR b ->> 'kind' NOT IN ('event', 'gate', 'runtime', 'human', 'hold')
                    OR jsonb_typeof(b -> 'ref') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(b -> 'summary') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(b -> 'createdAt') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(b -> 'createdBy') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(b -> 'updatedAt') IS DISTINCT FROM 'string'))
       ORDER BY w.feature_id
       LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, harness: r.harness }));
  },
};

/**
 * P-005 (Design 5, R-9) — settle waits whose proving key fired but whose settlement never
 * ran (a crash between the latch and settlement, a settlement that threw, a wait committed
 * concurrently with the fire). One settlement per key: settleProvingFire takes the per-key
 * lock and settles every wait on it, then runs the shared follow-up. A failed key is
 * counted and the pass continues.
 */
async function recoverMissedFires(
  deps: BlockerReapDeps,
  limit: number,
  dryRun: boolean,
): Promise<BlockerSweepResult['recovered']> {
  const out: BlockerSweepResult['recovered'] = { keys: 0, settled: 0, failed: 0, truncatedByLimit: false };
  if (!deps.listMissedFireKeys || !deps.settleFiredKey) return out;
  let listed: { keys: string[]; truncatedByLimit: boolean };
  try {
    listed = await deps.listMissedFireKeys(limit);
  } catch (err) {
    console.warn(`[blocker-recheck] ! missed-fire listing: ${err instanceof Error ? err.message : String(err)}`);
    out.failed += 1;
    return out;
  }
  out.keys = listed.keys.length;
  out.truncatedByLimit = listed.truncatedByLimit;
  if (dryRun) return out;
  for (const key of listed.keys) {
    try {
      out.settled += await deps.settleFiredKey(key);
    } catch (err) {
      out.failed += 1;
      console.warn(`[blocker-recheck] ! missed-fire ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * P-005 (R-10) — return to open the items a clear left `blocked` with nothing holding them.
 * decideStrandedRepair picks them; the checked restore re-verifies every other hold under a
 * row lock; the holder is told through the shared system-clear follow-up.
 */
async function repairStrandedItems(
  deps: BlockerReapDeps,
  limit: number,
  dryRun: boolean,
): Promise<BlockerSweepResult['repaired']> {
  const out: BlockerSweepResult['repaired'] = { examined: 0, reopened: 0, skipped: {}, truncatedByLimit: false };
  if (!deps.listStrandedBlocked || !deps.repairStranded) return out;
  const skip = (why: keyof BlockerSweepResult['repaired']['skipped']) => {
    out.skipped[why] = (out.skipped[why] ?? 0) + 1;
  };
  let rows: StrandedBlockedCandidate[];
  try {
    rows = await deps.listStrandedBlocked(limit + 1);
  } catch (err) {
    console.warn(`[blocker-recheck] ! stranded listing: ${err instanceof Error ? err.message : String(err)}`);
    skip('failed');
    return out;
  }
  out.truncatedByLimit = rows.length > limit;
  const batch = out.truncatedByLimit ? rows.slice(0, limit) : rows;
  out.examined = batch.length;
  for (const candidate of batch) {
    const decision = decideStrandedRepair(candidate);
    if (!decision.repair) { skip(decision.why); continue; }
    if (dryRun) { out.reopened += 1; continue; }
    let outcome: StrandedRepairOutcome;
    try {
      outcome = await deps.repairStranded(candidate);
    } catch (err) {
      console.warn(`[blocker-recheck] ! stranded ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      skip('failed');
      continue;
    }
    if (outcome !== 'cleared') { skip(outcome); continue; }
    out.reopened += 1;
    if (deps.followUp) {
      try {
        await deps.followUp([{
          workspaceId: activeWorkspaceId(),
          featureId: candidate.id,
          harnessSlug: candidate.harness,
          family: candidate.family,
          status: 'open',
          holder: candidate.holder,
          restored: true,
          activeRemaining: 0,
          cleared: [],
          clearedBy: STRANDED_BLOCKED_REPAIR_ACTOR,
        }]);
      } catch (err) {
        console.warn(`[blocker-recheck] follow-up ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return out;
}

/** The follow-up input for one blocker the re-check sweep cleared. */
function recheckClearedItem(input: {
  id: string;
  harness: string;
  family?: string;
  stateBefore?: string;
  stateAfter: string | void;
  holder?: string | null;
  cleared: ExternalBlockerRecord;
  evidence: string;
  remaining: number;
}): SystemClearedBlockerItem {
  const status = typeof input.stateAfter === 'string' ? input.stateAfter : (input.stateBefore ?? null);
  return {
    workspaceId: activeWorkspaceId(),
    featureId: input.id,
    harnessSlug: input.harness,
    family: input.family === 'feature' ? 'feature' : 'issue',
    status,
    holder: input.holder ?? null,
    restored: input.stateAfter === 'open',
    activeRemaining: input.remaining,
    cleared: [{ kind: input.cleared.kind, ref: input.cleared.ref, evidence: input.evidence }],
    clearedBy: BLOCKER_DEFAULT_REAPER_ACTOR,
  };
}

const MALFORMED_SAMPLE_SIZE = 10;

/**
 * WI-6554700010030445 — report items parked by an active blocker row the typed parser
 * drops. Nothing can release such an item (the re-check and set_blocker's clear never see
 * the row), so the sweep names it instead of leaving it silent. Read-only.
 */
async function findMalformedActiveBlockers(
  deps: BlockerReapDeps,
  limit: number,
): Promise<BlockerSweepResult['malformed']> {
  const out: BlockerSweepResult['malformed'] = { count: 0, sample: [], truncatedByLimit: false, failed: false };
  if (!deps.listMalformedActiveBlockers) return out;
  let rows: Array<{ id: string; harness: string }>;
  try {
    rows = await deps.listMalformedActiveBlockers(limit + 1);
  } catch (err) {
    console.warn(`[blocker-recheck] ! malformed-blocker listing: ${err instanceof Error ? err.message : String(err)}`);
    out.failed = true;
    return out;
  }
  out.truncatedByLimit = rows.length > limit;
  const batch = out.truncatedByLimit ? rows.slice(0, limit) : rows;
  out.count = batch.length;
  out.sample = batch.slice(0, MALFORMED_SAMPLE_SIZE).map((r) => `${r.harness}/${r.id}`);
  return out;
}

/**
 * One sweep. Never throws for a single bad row: a per-item failure is counted and the
 * sweep continues, because one malformed payload must not strand every other deadline.
 */
export async function sweepWorkItemBlockerDefaults(opts?: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  deps?: BlockerReapDeps;
}): Promise<BlockerSweepResult> {
  const deps = opts?.deps ?? defaultBlockerReapDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 200;
  const dryRun = opts?.dryRun === true;
  // P-005: settle missed proving fires first, so the re-check below does not escalate a
  // wait whose key already fired.
  const recovered = await recoverMissedFires(deps, limit, dryRun);
  const rows = await deps.listCandidates(limit + 1);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: BlockerSweepResult = {
    examined: batch.length,
    applied: { stay_parked: 0, release_to_agents: 0 },
    rechecked: { cleared: 0, escalated: 0 },
    skipped: {},
    truncatedByLimit,
    recovered,
    repaired: { examined: 0, reopened: 0, skipped: {}, truncatedByLimit: false },
    malformed: { count: 0, sample: [], truncatedByLimit: false, failed: false },
  };

  for (const row of batch) {
    for (const blocker of readExternalBlockers(row.payload)) {
      const decision = decideBlockerDefault(blocker, now);
      if (!decision.apply) {
        const dueAt = blocker.recheckAt ? Date.parse(blocker.recheckAt) : NaN;
        if (blocker.status === 'active' && Number.isFinite(dueAt) && dueAt <= now.getTime()) {
          try {
            const fresh = await deps.readPayload(row.id, row.harness);
            if (!fresh) { bump(result, 'read-failed'); continue; }
            const current = readExternalBlockers(fresh.payload).find((b) => b.kind === blocker.kind &&
              b.ref === blocker.ref && b.status === 'active' && b.recheckAt === blocker.recheckAt);
            if (!current) { bump(result, 'lost-race'); continue; }
            const reachability = await deps.resolveCondition?.(current);
            const cleared = (current.kind === 'event' || current.kind === 'gate') &&
              reachability?.authoritative === true && reachability.basis === 'fired';
            if (opts?.dryRun) { result.rechecked[cleared ? 'cleared' : 'escalated'] += 1; continue; }
            if (!cleared && !deps.escalate) { bump(result, 'read-failed'); continue; }
            const history = updateExternalBlockerHistory(fresh.payload, {
              kind: current.kind, ref: current.ref, clear: cleared,
              // Keep an unresolved condition DUE until its escalation is delivered.
              // A crash or delivery failure must not silently defer it for another day.
              recheckAt: current.recheckAt,
              ...(cleared ? { evidence: reachability.evidence } : {}),
            }, BLOCKER_DEFAULT_REAPER_ACTOR, now.toISOString());
            const next = history.blockers.find((b) => b.kind === current.kind && b.ref === current.ref &&
              b.status === (cleared ? 'cleared' : 'active'))!;
            if (cleared) {
              next.recheckedAt = now.toISOString();
              next.recheckDisposition = 'cleared';
            }
            if (reachability) next.reachability = reachability;
            const expected = (fresh.payload as { externalBlockers?: unknown } | null)?.externalBlockers ?? [];
            if (!(await deps.writeBlockers(row.id, row.harness, history.blockers, expected))) {
              bump(result, 'lost-race'); continue;
            }
            if (cleared) {
              const remaining = history.blockers.filter((b) => b.status === 'active');
              const stateAfter = await deps.restoreLifecycle({ id: row.id, harness: row.harness, family: fresh.family,
                state: fresh.state, remaining });
              if (deps.followUp) {
                // P-003: the same follow-up as every other system clear. The clear already
                // committed, so a failed message or wake never undoes or miscounts it.
                try {
                  await deps.followUp([recheckClearedItem({ id: row.id, harness: row.harness, family: fresh.family,
                    stateBefore: fresh.state, stateAfter, holder: fresh.holder, cleared: current,
                    evidence: reachability.evidence, remaining: remaining.length })]);
                } catch (err) {
                  console.warn(`[blocker-recheck] follow-up ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else {
              await deps.escalate!(row.id, row.harness, { ...current, ...(reachability ? { reachability } : {}) });
              const deliveredHistory = JSON.parse(JSON.stringify(history.blockers)) as ExternalBlockerRecord[];
              next.recheckAt = new Date(now.getTime() + assertHoldRegistered('blocker', current.capability).recheckSec * 1000).toISOString();
              next.recheckedAt = now.toISOString();
              next.recheckDisposition = 'escalated';
              if (!(await deps.writeBlockers(row.id, row.harness, history.blockers, deliveredHistory))) {
                bump(result, 'lost-race');
              }
            }
            result.rechecked[cleared ? 'cleared' : 'escalated'] += 1;
          } catch (err) {
            console.warn(`[blocker-recheck] ! ${row.id} ${blocker.ref}: ${err instanceof Error ? err.message : String(err)}`);
            bump(result, 'read-failed');
          }
          continue;
        }
        // not-human / not-active / no-decide-by are the NORMAL shape of most rows on a
        // multi-blocker item; counting them would drown the signal, so only report the
        // two that mean "an owner-visible deadline is not being honoured".
        if (decision.why === 'no-typed-action' || decision.why === 'decide-by-unparseable') bump(result, decision.why);
        continue;
      }
      if (opts?.dryRun) {
        result.applied[decision.action] += 1;
        continue;
      }
      try {
        const fresh = await deps.readPayload(row.id, row.harness);
        if (!fresh) {
          bump(result, 'read-failed');
          continue;
        }
        const history = applyBlockerDefaultToHistory(
          fresh.payload,
          blocker.ref,
          decision.action,
          BLOCKER_DEFAULT_REAPER_ACTOR,
          now.toISOString(),
        );
        if (!history.changed) {
          bump(result, 'lost-race');
          continue;
        }
        const expected = (fresh.payload as { externalBlockers?: unknown } | null)?.externalBlockers ?? [];
        if (!(await deps.writeBlockers(row.id, row.harness, history.blockers, expected))) {
          bump(result, 'lost-race');
          continue;
        }
        if (decision.action === 'release_to_agents') {
          await deps.restoreLifecycle({
            id: row.id,
            harness: row.harness,
            family: fresh.family,
            state: fresh.state,
            remaining: history.blockers.filter((b) => b.status === 'active'),
          });
        }
        result.applied[decision.action] += 1;
      } catch (err) {
        console.warn(
          `[blocker-default-reaper]   ! ${row.id} ${blocker.ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
        bump(result, 'read-failed');
      }
    }
  }
  // P-005: last, so it also catches an item this tick's re-check or default left blocked.
  result.repaired = await repairStrandedItems(deps, limit, dryRun);
  result.malformed = await findMalformedActiveBlockers(deps, limit);
  return result;
}

/** event-wait-settlement-2026-10-20 P-006 (R-12): who stamped a backfilled re-check date. */
export const UNPROVABLE_WAIT_BACKFILL_ACTOR = 'system:unprovable-wait-backfill';

/**
 * `plan-lane:<plan>#<item>` gate rows are the plan-item lane's own marker, written and cleared
 * by the plan reconcile (plan-items/reconcile-linked-work-items.ts), never by an event — they
 * are not an agent's event wait, so the backfill leaves them alone.
 */
const PLAN_LANE_REF_RE = /^plan-lane:/;

export interface UnprovableWaitBackfillDeps {
  /** Non-terminal items carrying an active event/gate row with no recheckAt (plan-lane excluded). */
  listUnstampedWaits(limit: number): Promise<BlockerReapCandidate[]>;
  readPayload: BlockerReapDeps['readPayload'];
  writeBlockers: BlockerReapDeps['writeBlockers'];
  /** The releasing paths' own predicate: readEventConditionReachability with requireSpecificCondition. */
  classify(ref: string): Promise<ExternalConditionReachability>;
}

export interface UnprovableWaitBackfillResult {
  /** Items examined. */
  items: number;
  /** Active event/gate rows with no recheckAt that were classified. */
  examined: number;
  /** Of those, rows no fire can prove (broad, change notification, uncatalogued, free text). */
  unprovable: number;
  /** Rows given a recheckAt (0 on a dry run). */
  stamped: number;
  /** Rows a fire can prove — left alone. */
  provable: number;
  /** Rows the backfill never touches, by reason. */
  skipped: Partial<Record<'unmeasured' | 'lost-race' | 'read-failed', number>>;
  /** Unprovable rows by reason, for the before/after record (R-12). */
  byReason: Partial<Record<string, number>>;
  truncatedByLimit: boolean;
}

export const defaultUnprovableWaitBackfillDeps: UnprovableWaitBackfillDeps = {
  async listUnstampedWaits(limit) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; harness: string; payload: unknown }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.payload AS payload
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(w.payload->'externalBlockers') b
                WHERE b->>'status' = 'active' AND b->>'kind' IN ('event', 'gate')
                  AND b->>'recheckAt' IS NULL AND b->>'ref' !~ '^plan-lane:')
       ORDER BY w.feature_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, harness: r.harness, payload: r.payload }));
  },
  readPayload: defaultBlockerReapDeps.readPayload,
  writeBlockers: defaultBlockerReapDeps.writeBlockers,
  classify: (ref) => readEventConditionReachability(ref, { requireSpecificCondition: true }),
};

/**
 * event-wait-settlement-2026-10-20 P-006 (D-001 item 1, R-12): give every pre-existing active
 * event/gate wait that no fire can prove a re-check date of `now`, so the next re-check sweep
 * (sweepWorkItemBlockerDefaults above) escalates it to its holder. "No fire can prove" covers an
 * unprovable ref (broad, uncatalogued, change notification) and an announced key whose producer
 * registration expired or was cancelled (verdict impossible). It CLEARS NOTHING — the
 * owner ruled these are neither cleared nor left silent — and never touches a row that
 * already has a recheckAt, a provable row, or a row whose classification failed twice. New
 * unprovable waits are refused at write (wait-ref-admission.ts), so this is a backfill of the
 * existing population; it is idempotent (a stamped row is no longer a candidate).
 *
 * Compare-and-set on the raw history, like every reaper write: unknown/legacy fields on a
 * row are preserved, and a concurrent set/clear makes this item a counted lost race.
 */
export async function backfillUnprovableWaitRecheckDates(opts?: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  deps?: UnprovableWaitBackfillDeps;
}): Promise<UnprovableWaitBackfillResult> {
  const deps = opts?.deps ?? defaultUnprovableWaitBackfillDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 500;
  const dryRun = opts?.dryRun === true;
  const rows = await deps.listUnstampedWaits(limit + 1);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: UnprovableWaitBackfillResult = {
    items: batch.length, examined: 0, unprovable: 0, stamped: 0, provable: 0,
    skipped: {}, byReason: {}, truncatedByLimit,
  };
  const skip = (why: keyof UnprovableWaitBackfillResult['skipped']) => {
    result.skipped[why] = (result.skipped[why] ?? 0) + 1;
  };
  const verdicts = new Map<string, Promise<ExternalConditionReachability>>();
  for (const row of batch) {
    try {
      const fresh = await deps.readPayload(row.id, row.harness);
      const raw = (fresh?.payload as { externalBlockers?: unknown } | null | undefined)?.externalBlockers;
      if (!fresh || !Array.isArray(raw)) { skip('read-failed'); continue; }
      const next = JSON.parse(JSON.stringify(raw)) as Array<Record<string, unknown>>;
      let changed = 0;
      for (const entry of next) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const ref = typeof entry.ref === 'string' ? entry.ref : null;
        if (entry.status !== 'active' || (entry.kind !== 'event' && entry.kind !== 'gate')) continue;
        if (!ref || entry.recheckAt != null || PLAN_LANE_REF_RE.test(ref)) continue;
        result.examined += 1;
        let verdict = verdicts.get(ref);
        if (!verdict) {
          // A ledger read that fails under load comes back `unmeasured`; retry it once, so one slow
          // read does not leave the row unstamped (it did on the first live run, 2026-10-21).
          verdict = deps.classify(ref).then((first) =>
            !first.uncertifiedReason && first.basis === 'unmeasured' ? deps.classify(ref) : first);
          verdicts.set(ref, verdict);
        }
        const reachability = await verdict;
        // An announced wait whose producer registration expired or was cancelled can never fire
        // either, so it is stamped like an unprovable ref rather than left to strand silently.
        const reason = reachability.uncertifiedReason
          ?? (reachability.verdict === 'impossible' ? reachability.basis : undefined);
        if (!reason) {
          if (reachability.basis === 'unmeasured') skip('unmeasured');
          else result.provable += 1;
          continue;
        }
        result.unprovable += 1;
        result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
        entry.recheckAt = now.toISOString();
        entry.recheckSource = UNPROVABLE_WAIT_BACKFILL_ACTOR;
        entry.reachability = reachability;
        changed += 1;
      }
      if (changed === 0 || dryRun) continue;
      if (!(await deps.writeBlockers(row.id, row.harness, next as unknown as ExternalBlockerRecord[], raw))) {
        skip('lost-race');
        continue;
      }
      result.stamped += changed;
    } catch (err) {
      console.warn(`[unprovable-wait-backfill] ! ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      skip('read-failed');
    }
  }
  return result;
}
