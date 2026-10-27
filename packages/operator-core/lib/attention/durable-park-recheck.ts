/**
 * durable-park-recheck.ts — re-check dates for durable parks that no fire can prove
 * (WI-6554700010030346; blind gap review #110 G-5 of event-wait-settlement-2026-10-20).
 *
 * A durable park (`work_items:release { claimHold:true, claimHoldRelease }`) stores its wait in
 * `payload.claim_hold_release.trigger`, not in `externalBlockers`, so the unprovable-wait backfill
 * (work-item-blocker-reaper.ts) never sees it. Parks made before P-006 accepted ANY trigger —
 * free text, a broad wake, a change notification — and stamped it `reachability:'blocked'`;
 * nothing ever looked at them again except the report-only durable-park audit. The owner's
 * ruling for unprovable waits (D-001 item 1) is "neither cleared nor left silent: give each a
 * re-check", and it applies to parks too.
 *
 * Two legs, mirroring the blocker pair:
 *   - {@link backfillUnprovableParkRecheckDates} classifies each unstamped park's trigger with
 *     the releasing paths' own predicate (readEventConditionReachability with
 *     requireSpecificCondition, plus the release-contract contradictions) and stamps
 *     `claim_hold_release.recheckAt = now` on the ones no fire can prove.
 *   - {@link sweepDueParkRechecks} raises an advisory escalation for each due park and re-arms
 *     the date one hold-registry interval out (`park`/`park`, a day). A park whose trigger has
 *     since become provable drops its date.
 *
 * Neither leg clears, releases, or re-parks anything, and neither touches the contract's
 * condition/owner/trigger (the fields durableParkFingerprint binds a disposition to) or its
 * stored `reachability`/`evidence` (read by the scheduler and the audit). The date lives INSIDE
 * `claim_hold_release`, so a re-park (which replaces the contract) and a clear (which strips it)
 * both drop it with no extra writer. Every write is compare-and-set on the raw contract.
 */
import { getOrgPg } from '@papercusp/db-org';
import { openEscalation } from '../agent-tools/coordination/escalations';
import { releaseContractContradiction } from '../durable-park-release-contract';
import { readEventConditionReachability, type ExternalConditionReachability } from '../external-condition-reachability';
import { assertHoldRegistered } from '../hold-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { activeWorkspaceId } from '../workspace-registry';

/** Who stamped, re-checked, or escalated a park's re-check date. */
export const UNPROVABLE_PARK_RECHECK_ACTOR = 'system:unprovable-park-recheck';

/** One parked item, as the listing reads it. `release` is the RAW contract (the CAS fence). */
export interface ParkRecheckCandidate {
  id: string;
  harness: string;
  release: unknown;
  parkedBy: string | null;
  parkedAt: string | null;
}

export interface DurableParkRecheckDeps {
  /** Non-terminal parks with a string trigger and no recheckAt, ordered by id, after `afterId`. */
  listUnstampedParks(limit: number, afterId: string | null): Promise<ParkRecheckCandidate[]>;
  /** Non-terminal parks whose recheckAt is at or before `nowIso`. */
  listDueParks(nowIso: string, limit: number): Promise<ParkRecheckCandidate[]>;
  /** The releasing paths' own predicate: readEventConditionReachability with requireSpecificCondition. */
  classify(trigger: string): Promise<ExternalConditionReachability>;
  /** Replace `claim_hold_release` iff the item is still parked and its contract still equals `expected`. */
  writeRelease(id: string, harness: string, next: Record<string, unknown>, expected: unknown): Promise<boolean>;
  escalate(park: ParkRecheckCandidate, release: Record<string, unknown>, reachability: ExternalConditionReachability): Promise<void>;
}

type Verdict =
  | { kind: 'unprovable'; reason: string; reachability: ExternalConditionReachability }
  | { kind: 'provable'; reachability: ExternalConditionReachability }
  | { kind: 'unmeasured'; reachability: ExternalConditionReachability };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Classify one park. A pause/resume or self-release contradiction can never be proved by a fire
 * (no ledger read needed); otherwise the ledger verdict decides, exactly as for a blocker: an
 * uncertified key, or an announced key whose producer registration expired or was cancelled,
 * is unprovable. `unmeasured` without an uncertified reason means the read failed.
 */
async function classifyPark(
  park: ParkRecheckCandidate,
  release: Record<string, unknown>,
  ledger: (trigger: string) => Promise<ExternalConditionReachability>,
  now: Date,
): Promise<Verdict | null> {
  const trigger = text(release.trigger);
  if (!trigger) return null;
  const condition = text(release.condition);
  const contradiction = condition ? releaseContractContradiction(condition, trigger, park.id) : null;
  if (contradiction) {
    return {
      kind: 'unprovable', reason: 'contradiction',
      reachability: { verdict: 'unknown', basis: 'unmeasured', authoritative: false, evidence: contradiction,
        checkedAt: now.toISOString() },
    };
  }
  const reachability = await ledger(trigger);
  const reason = reachability.uncertifiedReason
    ?? (reachability.verdict === 'impossible' ? reachability.basis : undefined);
  if (reason) return { kind: 'unprovable', reason, reachability };
  if (reachability.basis === 'unmeasured') return { kind: 'unmeasured', reachability };
  return { kind: 'provable', reachability };
}

/** Memoize one classification per trigger, retrying an unmeasured read once (as the blocker backfill does). */
function memoLedger(deps: DurableParkRecheckDeps): (trigger: string) => Promise<ExternalConditionReachability> {
  const cache = new Map<string, Promise<ExternalConditionReachability>>();
  return (trigger) => {
    let verdict = cache.get(trigger);
    if (!verdict) {
      verdict = deps.classify(trigger).then((first) =>
        !first.uncertifiedReason && first.basis === 'unmeasured' ? deps.classify(trigger) : first);
      cache.set(trigger, verdict);
    }
    return verdict;
  };
}

/** Run `fn` over `items` with at most `width` in flight (ledger reads are independent). */
async function inPool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
}

const RECHECK_KEYS = ['recheckAt', 'recheckSource', 'recheckReason'] as const;

export const defaultDurableParkRecheckDeps: DurableParkRecheckDeps = {
  async listUnstampedParks(limit, afterId) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; harness: string; release: unknown; parked_by: string | null; parked_at: string | null }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.payload->'claim_hold_release' AS release,
             w.payload->>'claim_hold_by' AS parked_by, w.payload->>'claim_hold_at' AS parked_at
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND w.payload->>'_claimHold' = 'true'
         AND jsonb_typeof(w.payload->'claim_hold_release') = 'object'
         AND jsonb_typeof(w.payload->'claim_hold_release'->'trigger') = 'string'
         AND w.payload->'claim_hold_release'->>'recheckAt' IS NULL
         AND w.feature_id > ${afterId ?? ''}
       ORDER BY w.feature_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, harness: r.harness, release: r.release, parkedBy: r.parked_by, parkedAt: r.parked_at }));
  },
  async listDueParks(nowIso, limit) {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; harness: string; release: unknown; parked_by: string | null; parked_at: string | null }>>`
      SELECT w.feature_id AS id, w.harness_slug AS harness, w.payload->'claim_hold_release' AS release,
             w.payload->>'claim_hold_by' AS parked_by, w.payload->>'claim_hold_at' AS parked_at
        FROM harness_shared.work_items w
       WHERE w.workspace_id = ${activeWorkspaceId()}
         AND NOT (w.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND w.payload->>'_claimHold' = 'true'
         AND jsonb_typeof(w.payload->'claim_hold_release') = 'object'
         AND w.payload->'claim_hold_release'->>'recheckAt' <= ${nowIso}
       ORDER BY w.payload->'claim_hold_release'->>'recheckAt', w.feature_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, harness: r.harness, release: r.release, parkedBy: r.parked_by, parkedAt: r.parked_at }));
  },
  classify: (trigger) => readEventConditionReachability(trigger, { requireSpecificCondition: true }),
  async writeRelease(id, harness, next, expected) {
    const { sql } = getOrgPg();
    const rows = await sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(payload, '{claim_hold_release}', ${JSON.stringify(next)}::text::jsonb),
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${harness} AND feature_id = ${id}
         AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND payload->>'_claimHold' = 'true'
         AND payload->'claim_hold_release' = ${JSON.stringify(expected)}::text::jsonb
      RETURNING feature_id`;
    return rows.length > 0;
  },
  async escalate(park, release, reachability) {
    await openEscalation({ ownerId: UNPROVABLE_PARK_RECHECK_ACTOR, ownerLabel: 'system · park re-check',
      source: 'principal', workspaceId: activeWorkspaceId(), userId: null }, {
      severity: 'advisory',
      summary: `${park.id}: durable park on an unprovable trigger reached its re-check date and is still parked.`,
      body: `Trigger: ${String(release.trigger)}. Condition: ${String(release.condition ?? '(none)')}. ` +
        `Owner: ${String(release.owner ?? '(none)')}; parked by ${park.parkedBy ?? '(unknown)'} at ${park.parkedAt ?? '(unknown)'}. ` +
        `Re-check was due ${String(release.recheckAt)}; ${reachability.evidence}. ` +
        'No event can prove this trigger, so nothing will release the park on its own. Next action: verify the ' +
        'condition, then clear the park (work_items:release { claimHold:false }) or re-park it on a provable trigger. ' +
        'Expiry does not grant authority or prove that the condition cleared.',
      harness_slug: park.harness,
      meta: { subjectSignature: `park-recheck:${park.harness}:${park.id}` },
    });
  },
};

export interface ParkRecheckBackfillResult {
  /** Parks examined this pass. */
  parks: number;
  /** Of those, parks no fire can prove (contradiction, broad, change notification, uncatalogued, dead producer). */
  unprovable: number;
  /** Parks given a recheckAt (0 on a dry run). */
  stamped: number;
  /** Parks a fire can prove — left alone. */
  provable: number;
  skipped: Partial<Record<'unmeasured' | 'lost-race' | 'read-failed' | 'no-trigger', number>>;
  byReason: Partial<Record<string, number>>;
  /** The last id examined; pass it as `afterId` to continue, or null when the pass reached the end. */
  nextAfterId: string | null;
  truncatedByLimit: boolean;
}

/**
 * Give every existing durable park on an unprovable trigger a re-check date of `now`, so the
 * next {@link sweepDueParkRechecks} escalates it. Provable parks stay candidates (a producer
 * can later expire), so the pass pages by id: pass the returned `nextAfterId` back as
 * `afterId` and a bounded pass still reaches every park. Idempotent — a stamped park is no
 * longer a candidate.
 */
export async function backfillUnprovableParkRecheckDates(opts?: {
  now?: Date;
  limit?: number;
  afterId?: string | null;
  dryRun?: boolean;
  concurrency?: number;
  deps?: DurableParkRecheckDeps;
}): Promise<ParkRecheckBackfillResult> {
  const deps = opts?.deps ?? defaultDurableParkRecheckDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 100;
  const rows = await deps.listUnstampedParks(limit + 1, opts?.afterId ?? null);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: ParkRecheckBackfillResult = {
    parks: batch.length, unprovable: 0, stamped: 0, provable: 0, skipped: {}, byReason: {},
    nextAfterId: truncatedByLimit ? batch[batch.length - 1]!.id : null, truncatedByLimit,
  };
  const skip = (why: keyof ParkRecheckBackfillResult['skipped']) => {
    result.skipped[why] = (result.skipped[why] ?? 0) + 1;
  };
  const ledger = memoLedger(deps);
  const verdicts = new Map<string, Verdict | null | Error>();
  await inPool(batch, opts?.concurrency ?? 4, async (park) => {
    const release = asRecord(park.release);
    try {
      verdicts.set(park.id, release ? await classifyPark(park, release, ledger, now) : null);
    } catch (err) {
      verdicts.set(park.id, err instanceof Error ? err : new Error(String(err)));
    }
  });
  for (const park of batch) {
    const verdict = verdicts.get(park.id);
    if (verdict instanceof Error) {
      console.warn(`[unprovable-park-backfill] ! ${park.id}: ${verdict.message}`);
      skip('read-failed');
      continue;
    }
    if (!verdict) { skip('no-trigger'); continue; }
    if (verdict.kind === 'provable') { result.provable += 1; continue; }
    if (verdict.kind === 'unmeasured') { skip('unmeasured'); continue; }
    result.unprovable += 1;
    result.byReason[verdict.reason] = (result.byReason[verdict.reason] ?? 0) + 1;
    if (opts?.dryRun) continue;
    const next = {
      ...asRecord(park.release)!,
      recheckAt: now.toISOString(),
      recheckSource: UNPROVABLE_PARK_RECHECK_ACTOR,
      recheckReason: verdict.reason,
      recheckReachability: verdict.reachability,
    };
    try {
      if (await deps.writeRelease(park.id, park.harness, next, park.release)) result.stamped += 1;
      else skip('lost-race');
    } catch (err) {
      console.warn(`[unprovable-park-backfill] ! ${park.id}: ${err instanceof Error ? err.message : String(err)}`);
      skip('read-failed');
    }
  }
  return result;
}

export interface ParkRecheckSweepResult {
  examined: number;
  /** Due parks escalated to their owner and re-armed. */
  escalated: number;
  /** Due parks whose trigger is now provable: the date was dropped. */
  provable: number;
  skipped: Partial<Record<'lost-race' | 'read-failed' | 'not-due', number>>;
  truncatedByLimit: boolean;
}

/**
 * Escalate every durable park whose re-check date has passed, then re-arm the date one
 * `park`/`park` hold-registry interval out. The escalation is delivered BEFORE the date moves,
 * so a failed delivery leaves the park due for the next tick rather than silently deferred.
 * Clears nothing: an unprovable park stays parked until someone with the condition acts.
 */
export async function sweepDueParkRechecks(opts?: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
  deps?: DurableParkRecheckDeps;
}): Promise<ParkRecheckSweepResult> {
  const deps = opts?.deps ?? defaultDurableParkRecheckDeps;
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 200;
  const rows = await deps.listDueParks(now.toISOString(), limit + 1);
  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;
  const result: ParkRecheckSweepResult = { examined: batch.length, escalated: 0, provable: 0, skipped: {}, truncatedByLimit };
  const skip = (why: keyof ParkRecheckSweepResult['skipped']) => {
    result.skipped[why] = (result.skipped[why] ?? 0) + 1;
  };
  const ledger = memoLedger(deps);
  const rearmMs = assertHoldRegistered('park', 'park').recheckSec * 1000;
  for (const park of batch) {
    try {
      const release = asRecord(park.release);
      const dueAt = release ? Date.parse(String(release.recheckAt ?? '')) : NaN;
      if (!release || !Number.isFinite(dueAt) || dueAt > now.getTime()) { skip('not-due'); continue; }
      const verdict = await classifyPark(park, release, ledger, now);
      if (verdict?.kind === 'provable') {
        if (opts?.dryRun) { result.provable += 1; continue; }
        const next: Record<string, unknown> = { ...release };
        for (const key of RECHECK_KEYS) delete next[key];
        next.recheckedAt = now.toISOString();
        next.recheckDisposition = 'provable';
        next.recheckReachability = verdict.reachability;
        if (await deps.writeRelease(park.id, park.harness, next, park.release)) result.provable += 1;
        else skip('lost-race');
        continue;
      }
      // Unprovable, or a read that could not measure it: it was stamped as unprovable, so it
      // stays due and is escalated rather than quietly deferred on a failed read.
      const reachability = verdict?.reachability ?? {
        verdict: 'unknown', basis: 'unmeasured', authoritative: false,
        evidence: 'the park has no trigger', checkedAt: now.toISOString(),
      } satisfies ExternalConditionReachability;
      if (opts?.dryRun) { result.escalated += 1; continue; }
      await deps.escalate(park, release, reachability);
      const next = {
        ...release,
        recheckAt: new Date(now.getTime() + rearmMs).toISOString(),
        recheckedAt: now.toISOString(),
        recheckDisposition: 'escalated',
        recheckReachability: reachability,
      };
      if (await deps.writeRelease(park.id, park.harness, next, park.release)) result.escalated += 1;
      else skip('lost-race');
    } catch (err) {
      console.warn(`[park-recheck] ! ${park.id}: ${err instanceof Error ? err.message : String(err)}`);
      skip('read-failed');
    }
  }
  return result;
}
