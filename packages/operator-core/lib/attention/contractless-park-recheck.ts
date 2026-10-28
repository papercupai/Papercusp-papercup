/**
 * contractless-park-recheck.ts — re-check dates for durable parks that have NO release
 * contract (WI-6554700010030449; residue of WI-6554700010030346, blind gap review #110 G-5 of
 * event-wait-settlement-2026-10-20).
 *
 * durable-park-recheck.ts keeps its date inside `payload.claim_hold_release`, so it cannot reach
 * a park made without one: parks from before setWorkItemClaimHold required a complete contract
 * (P-006), and parks written straight into the payload (fleet pauses, drain-loop skips,
 * create-time `_claimHold`). Nothing releases such a park on an event,
 * and before this module nothing re-checked it either. Measured 2026-10-27 23:35Z
 * (papercusp-workspace, non-terminal, non-observation): 334 contract-less parks, of which 87
 * carry an active external blocker (the blocker re-check owns those), 1 is a bare liveness
 * lease (the lease reaper owns it), and 246 had nothing at all. The hold registry already names
 * their re-check (`park`/`park`: the parker named in `claim_hold_by`, one DAY); this module
 * delivers it, under the owner's ruling for unprovable waits (D-001 item 1: neither cleared nor
 * left silent).
 *
 * The date lives at `payload.claim_hold_recheck`, BOUND to the park it was stamped for
 * (`parkedBy` + `parkedAt` mirror `claim_hold_by` + `claim_hold_at`). A record whose binding
 * does not match the live park belongs to an earlier park and counts as absent, so a clearing
 * path that forgets the key cannot carry a stale date onto a later park. setWorkItemClaimHold
 * also strips the key on every clear and on every (re-)park that names a parker.
 *
 *   - {@link stampContractlessParkRecheckDates} gives each unstamped park its first date: one
 *     interval after it was parked, or, for a backlog park already past that point, a moment
 *     inside the next interval chosen from its id. A backlog is re-checked across a day, not in
 *     one burst of escalations.
 *   - {@link sweepDueContractlessParkRechecks} escalates each due park (advisory; the body names
 *     the parker and the recorded reason) and re-arms the date one interval out. A park that has
 *     since gained a release contract or an active external blocker drops its date instead,
 *     because another re-check now owns it.
 *
 * Neither leg clears, releases or re-parks anything. Every write is compare-and-set on the
 * park's identity and the raw re-check record.
 */
import { getOrgPg } from '@papercusp/db-org';
import { openEscalation } from '../agent-tools/coordination/escalations';
import { assertHoldRegistered } from '../hold-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { activeWorkspaceId } from '../workspace-registry';

/** Who stamped, re-checked, or escalated a contract-less park's re-check date. */
export const CONTRACTLESS_PARK_RECHECK_ACTOR = 'system:contractless-park-recheck';

/** The payload key the date lives under. setWorkItemClaimHold strips it on clear and re-park. */
export const CLAIM_HOLD_RECHECK_KEY = 'claim_hold_recheck';

/** The stored re-check record. `parkedBy`/`parkedAt` bind it to one park. */
export interface ContractlessParkRecheck {
  recheckAt: string;
  parkedBy: string | null;
  parkedAt: string | null;
  source: string;
  /** When the sweep last escalated this park. */
  recheckedAt?: string;
  /** How many times the sweep has escalated this park. */
  escalations?: number;
}

/** One parked item, as the listings read it. */
export interface ContractlessParkCandidate {
  id: string;
  harness: string;
  parkedBy: string | null;
  parkedAt: string | null;
  parkedReason: string | null;
  /** RAW `claim_hold_recheck` — the compare-and-set fence. */
  recheck: unknown;
  /** `claim_hold_release` is an object: durable-park-recheck.ts owns this park. */
  hasContract: boolean;
  /** An external blocker with status 'active': the blocker re-check owns this park. */
  hasActiveBlocker: boolean;
  /** A bare liveness lease (`held_open_by`, no `claim_hold_by`): the lease reaper owns it. */
  leaseOnly: boolean;
}

export interface ContractlessParkRecheckDeps {
  /** Non-terminal contract-less parks nothing else re-checks, with no record bound to them, ordered by id, after `afterId`. */
  listUnstamped(limit: number, afterId: string | null): Promise<ContractlessParkCandidate[]>;
  /** Non-terminal parks whose `claim_hold_recheck.recheckAt` is at or before `nowIso`. */
  listDue(nowIso: string, limit: number): Promise<ContractlessParkCandidate[]>;
  /** Replace (or with `null`, remove) `claim_hold_recheck` iff the same park is still in place and the record still equals `park.recheck`. */
  writeRecheck(park: ContractlessParkCandidate, next: ContractlessParkRecheck | null): Promise<boolean>;
  escalate(park: ContractlessParkCandidate, recheck: ContractlessParkRecheck): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The park/park hold-registry interval: the first-date offset and the re-arm step. */
function parkIntervalMs(): number {
  return assertHoldRegistered('park', 'park').recheckSec * 1000;
}

/**
 * The park's re-check record when it was stamped for THIS park, else null: absent, malformed,
 * or bound to an earlier park (a different `claim_hold_by` or `claim_hold_at`).
 */
export function boundRecheck(
  park: Pick<ContractlessParkCandidate, 'recheck' | 'parkedBy' | 'parkedAt'>,
): ContractlessParkRecheck | null {
  const record = asRecord(park.recheck);
  if (!record) return null;
  const recheckAt = text(record.recheckAt);
  if (!recheckAt || !Number.isFinite(Date.parse(recheckAt))) return null;
  if (text(record.parkedBy) !== text(park.parkedBy) || text(record.parkedAt) !== text(park.parkedAt)) return null;
  const escalations = typeof record.escalations === 'number' && Number.isFinite(record.escalations) ? record.escalations : undefined;
  return {
    recheckAt,
    parkedBy: text(park.parkedBy),
    parkedAt: text(park.parkedAt),
    source: text(record.source) ?? CONTRACTLESS_PARK_RECHECK_ACTOR,
    ...(text(record.recheckedAt) ? { recheckedAt: text(record.recheckedAt)! } : {}),
    ...(escalations !== undefined ? { escalations } : {}),
  };
}

/** FNV-1a (32-bit): a stable spread of ids over an interval, not a security hash. */
function spreadMs(id: string, spanMs: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % Math.max(1, Math.floor(spanMs));
}

/**
 * A park's first re-check: one interval after it was parked. A backlog park already past that
 * point (or one with no usable `claim_hold_at`) gets a moment inside the NEXT interval, chosen
 * from its id, so a backlog is spread across the interval instead of escalating in one burst.
 */
export function firstRecheckAt(park: Pick<ContractlessParkCandidate, 'id' | 'parkedAt'>, now: Date, intervalMs: number): string {
  const parkedMs = park.parkedAt ? Date.parse(park.parkedAt) : Number.NaN;
  const dueMs = parkedMs + intervalMs;
  if (Number.isFinite(dueMs) && dueMs > now.getTime()) {
    // A future claim_hold_at (clock skew) still waits no longer than one interval from now.
    return new Date(Math.min(dueMs, now.getTime() + intervalMs)).toISOString();
  }
  return new Date(now.getTime() + spreadMs(park.id, intervalMs)).toISOString();
}

/** Which other re-check owns this park now, if any. */
function coveredBy(park: ContractlessParkCandidate): 'contract' | 'blocker' | 'lease' | null {
  if (park.hasContract) return 'contract';
  if (park.hasActiveBlocker) return 'blocker';
  if (park.leaseOnly) return 'lease';
  return null;
}

const REASON_MAX_CHARS = 400;

type CandidateRow = {
  id: string;
  harness: string;
  parked_by: string | null;
  parked_at: string | null;
  parked_reason: string | null;
  recheck: unknown;
  has_contract: boolean;
  has_active_blocker: boolean;
  lease_only: boolean;
};

function toCandidate(row: CandidateRow): ContractlessParkCandidate {
  return {
    id: row.id,
    harness: row.harness,
    parkedBy: text(row.parked_by),
    parkedAt: text(row.parked_at),
    parkedReason: text(row.parked_reason),
    recheck: row.recheck ?? null,
    hasContract: row.has_contract === true,
    hasActiveBlocker: row.has_active_blocker === true,
    leaseOnly: row.lease_only === true,
  };
}

/** An element of `externalBlockers` whose status is 'active' (the shape readExternalBlockers reads). */
const ACTIVE_BLOCKER_SQL = `EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(w.payload->'externalBlockers') = 'array' THEN w.payload->'externalBlockers' ELSE '[]'::jsonb END
  ) AS b WHERE b->>'status' = 'active')`;
const LEASE_ONLY_SQL = `(w.payload ? 'held_open_by' AND NOT (w.payload ? 'claim_hold_by'))`;

export const defaultContractlessParkRecheckDeps: ContractlessParkRecheckDeps = {
  async listUnstamped(limit, afterId) {
    const { sql } = getOrgPg();
    const rows = await sql<CandidateRow[]>`
      SELECT w.feature_id AS id, w.harness_slug AS harness,
             w.payload->>'claim_hold_by' AS parked_by, w.payload->>'claim_hold_at' AS parked_at,
             w.payload->>'claim_hold_reason' AS parked_reason, w.payload->'claim_hold_recheck' AS recheck,
             FALSE AS has_contract, FALSE AS has_active_blocker, FALSE AS lease_only
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND w.lane IS DISTINCT FROM 'observation'
         AND w.payload->>'_claimHold' = 'true'
         AND jsonb_typeof(w.payload->'claim_hold_release') IS DISTINCT FROM 'object'
         AND NOT ${sql.unsafe(LEASE_ONLY_SQL)}
         AND NOT ${sql.unsafe(ACTIVE_BLOCKER_SQL)}
         AND (jsonb_typeof(w.payload->'claim_hold_recheck') IS DISTINCT FROM 'object'
              OR w.payload->'claim_hold_recheck'->>'recheckAt' IS NULL
              OR (w.payload->'claim_hold_recheck'->>'parkedBy') IS DISTINCT FROM (w.payload->>'claim_hold_by')
              OR (w.payload->'claim_hold_recheck'->>'parkedAt') IS DISTINCT FROM (w.payload->>'claim_hold_at'))
         AND w.feature_id > ${afterId ?? ''}
       ORDER BY w.feature_id
       LIMIT ${limit}
    `;
    return rows.map(toCandidate);
  },
  async listDue(nowIso, limit) {
    const { sql } = getOrgPg();
    const rows = await sql<CandidateRow[]>`
      SELECT w.feature_id AS id, w.harness_slug AS harness,
             w.payload->>'claim_hold_by' AS parked_by, w.payload->>'claim_hold_at' AS parked_at,
             w.payload->>'claim_hold_reason' AS parked_reason, w.payload->'claim_hold_recheck' AS recheck,
             COALESCE(jsonb_typeof(w.payload->'claim_hold_release') = 'object', FALSE) AS has_contract,
             ${sql.unsafe(ACTIVE_BLOCKER_SQL)} AS has_active_blocker,
             ${sql.unsafe(LEASE_ONLY_SQL)} AS lease_only
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND w.payload->>'_claimHold' = 'true'
         AND jsonb_typeof(w.payload->'claim_hold_recheck') = 'object'
         AND w.payload->'claim_hold_recheck'->>'recheckAt' <= ${nowIso}
       ORDER BY w.payload->'claim_hold_recheck'->>'recheckAt', w.feature_id
       LIMIT ${limit}
    `;
    return rows.map(toCandidate);
  },
  async writeRecheck(park, next) {
    const { sql } = getOrgPg();
    const expected = park.recheck === null || park.recheck === undefined ? null : JSON.stringify(park.recheck);
    const rows = await sql`
      UPDATE harness_shared.work_items
         SET payload = CASE
               WHEN ${next === null} THEN payload - 'claim_hold_recheck'
               ELSE jsonb_set(payload, '{claim_hold_recheck}', ${JSON.stringify(next)}::text::jsonb)
             END,
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${park.harness} AND feature_id = ${park.id}
         AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND payload->>'_claimHold' = 'true'
         AND (payload->>'claim_hold_by') IS NOT DISTINCT FROM ${park.parkedBy}::text
         AND (payload->>'claim_hold_at') IS NOT DISTINCT FROM ${park.parkedAt}::text
         AND COALESCE(payload->'claim_hold_recheck', 'null'::jsonb) = COALESCE(${expected}::text::jsonb, 'null'::jsonb)
      RETURNING feature_id`;
    return rows.length > 0;
  },
  async escalate(park, recheck) {
    const reason = park.parkedReason
      ? park.parkedReason.length > REASON_MAX_CHARS ? `${park.parkedReason.slice(0, REASON_MAX_CHARS)}…` : park.parkedReason
      : '(no reason recorded)';
    await openEscalation({ ownerId: CONTRACTLESS_PARK_RECHECK_ACTOR, ownerLabel: 'system · park re-check',
      source: 'principal', workspaceId: activeWorkspaceId(), userId: null }, {
      severity: 'advisory',
      summary: `${park.id}: durable park with no release contract reached its re-check date and is still parked.`,
      body: `Parked by ${park.parkedBy ?? '(unknown)'} at ${park.parkedAt ?? '(unknown)'}. Reason: ${reason}. ` +
        `Re-check was due ${recheck.recheckAt}. The park has no release contract and no active external blocker, ` +
        'so nothing will release it on its own. Next action: check whether the reason still holds, then clear the park ' +
        '(work_items:release { claimHold:false }), re-park it with a typed contract (work_items:release { claimHold:true, ' +
        'claimHoldRelease }), or record what it waits on (work_items:set_blocker). Expiry does not grant authority or ' +
        'prove that the reason cleared.',
      harness_slug: park.harness,
      meta: { subjectSignature: `park-recheck:${park.harness}:${park.id}` },
    });
  },
};

export interface ContractlessParkStampResult {
  /** Parks examined this pass. */
  parks: number;
  /** Parks given a first re-check date (0 on a dry run). */
  stamped: number;
  /** Parks a dry run would have stamped. */
  wouldStamp: number;
  skipped: Partial<Record<'covered' | 'already-stamped' | 'lost-race' | 'write-failed', number>>;
  /** The last id examined; pass it as `afterId` to continue, or null when the pass reached the end. */
  nextAfterId: string | null;
  truncatedByLimit: boolean;
}

/**
 * Give every contract-less park that nothing else re-checks its first re-check date (see
 * {@link firstRecheckAt}). Pages by id: pass the returned `nextAfterId` back as `afterId` and a
 * bounded pass still reaches every park. Idempotent — a stamped park is no longer a candidate.
 */
export async function stampContractlessParkRecheckDates(opts?: {
  now?: Date;
  limit?: number;
  afterId?: string | null;
  dryRun?: boolean;
  deps?: ContractlessParkRecheckDeps;
}): Promise<ContractlessParkStampResult> {
  const deps = opts?.deps ?? defaultContractlessParkRecheckDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 200;
  const intervalMs = parkIntervalMs();
  const rows = await deps.listUnstamped(limit + 1, opts?.afterId ?? null);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: ContractlessParkStampResult = {
    parks: batch.length, stamped: 0, wouldStamp: 0, skipped: {},
    nextAfterId: truncatedByLimit ? batch[batch.length - 1]!.id : null, truncatedByLimit,
  };
  const skip = (why: keyof ContractlessParkStampResult['skipped']) => {
    result.skipped[why] = (result.skipped[why] ?? 0) + 1;
  };
  for (const park of batch) {
    if (coveredBy(park)) { skip('covered'); continue; }
    if (boundRecheck(park)) { skip('already-stamped'); continue; }
    const next: ContractlessParkRecheck = {
      recheckAt: firstRecheckAt(park, now, intervalMs),
      parkedBy: park.parkedBy,
      parkedAt: park.parkedAt,
      source: CONTRACTLESS_PARK_RECHECK_ACTOR,
    };
    if (opts?.dryRun) { result.wouldStamp += 1; continue; }
    try {
      if (await deps.writeRecheck(park, next)) result.stamped += 1;
      else skip('lost-race');
    } catch (err) {
      skip('write-failed');
      console.warn(`[contractless-park-recheck] ! stamp ${park.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export interface ContractlessParkSweepResult {
  examined: number;
  /** Due parks escalated and re-armed one interval out. */
  escalated: number;
  /** Dates removed: another re-check now owns the park, or the record belonged to an earlier park. */
  dropped: Partial<Record<'contract' | 'blocker' | 'lease' | 'stale', number>>;
  skipped: Partial<Record<'not-due' | 'lost-race' | 'failed', number>>;
  truncatedByLimit: boolean;
}

/**
 * Escalate every contract-less park whose re-check date has passed, then re-arm it one
 * `park`/`park` interval out. The escalation is delivered BEFORE the date moves, so a failed
 * delivery leaves the park due for the next pass. A park another re-check now owns, or whose
 * record belongs to an earlier park, loses the date without an escalation.
 */
export async function sweepDueContractlessParkRechecks(opts?: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  deps?: ContractlessParkRecheckDeps;
}): Promise<ContractlessParkSweepResult> {
  const deps = opts?.deps ?? defaultContractlessParkRecheckDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 200;
  const intervalMs = parkIntervalMs();
  const rows = await deps.listDue(now.toISOString(), limit + 1);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: ContractlessParkSweepResult = { examined: batch.length, escalated: 0, dropped: {}, skipped: {}, truncatedByLimit };
  const skip = (why: keyof ContractlessParkSweepResult['skipped']) => {
    result.skipped[why] = (result.skipped[why] ?? 0) + 1;
  };
  const drop = async (park: ContractlessParkCandidate, why: keyof ContractlessParkSweepResult['dropped']) => {
    if (!opts?.dryRun && !(await deps.writeRecheck(park, null))) { skip('lost-race'); return; }
    result.dropped[why] = (result.dropped[why] ?? 0) + 1;
  };
  for (const park of batch) {
    try {
      const recheck = boundRecheck(park);
      if (!recheck) {
        if (asRecord(park.recheck)) await drop(park, 'stale');
        else skip('not-due');
        continue;
      }
      if (Date.parse(recheck.recheckAt) > now.getTime()) { skip('not-due'); continue; }
      const owner = coveredBy(park);
      if (owner) { await drop(park, owner); continue; }
      if (opts?.dryRun) { result.escalated += 1; continue; }
      await deps.escalate(park, recheck);
      const next: ContractlessParkRecheck = {
        ...recheck,
        recheckAt: new Date(now.getTime() + intervalMs).toISOString(),
        recheckedAt: now.toISOString(),
        escalations: (recheck.escalations ?? 0) + 1,
      };
      if (await deps.writeRecheck(park, next)) result.escalated += 1;
      else skip('lost-race');
    } catch (err) {
      skip('failed');
      console.warn(`[contractless-park-recheck] ! ${park.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
