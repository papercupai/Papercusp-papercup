/**
 * green-main-slo-watchdog — the delivery half of P-016 (green-main-cycle-time-2026-10-08,
 * AUTO-BAR-R-14; ruling D-030). `computeGreenMainSlo` decides WHAT is breached; this pass reads
 * its inputs and delivers each breach to the owner exactly once per episode.
 *
 * Why once-per-episode and not once-per-tick: during the 2026-10-02.. red the owner was paged
 * ~100 times a day by an age alarm that re-fired every 15 minutes (measured in
 * harness_shared.attention_notifications, D-030). Each breach carries an `episodeKey` derived from
 * the clock that started it, and `notifyAttentionOnce` reserves that key durably, so a page fires
 * on the first tick past its threshold and never again for that episode, across restarts.
 *
 * Unknown is not fine: a reader that fails leaves its input null (which can only SUPPRESS the
 * breach that input drives, never invent one), and the pass then records a failure in
 * watchdog_health so the silence is visible rather than read as "within SLO". The other inputs
 * still compute, so one broken read never silences the other page.
 *
 * Wired into `startGreenStallWatchdog` beside `checkGateLiveInvariants`.
 */
import type { Sql } from 'postgres';
import type { AttentionNotifyResult, ReplaySafeAttentionNotifyInput } from '../attention-notify';
import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';
import { broadcastSevereEvent } from '../severe-event-broadcast';
import type { ConditionState } from '../agent-tools/coordination/tools/conditions';
import { frozenRepairLatency } from './frozen-candidate-repair-queue';
import { readGateNonVerdictReasons, type GateNonVerdictReasons } from './gate-fire-ledger';
import type { GreenMainSloBreach } from './green-main-slo';
import {
  computeGreenMainSlo,
  syncTalliesFromDeltaCoverage,
  type GreenMainSlo,
  type GreenMainSloQueue,
  type GreenMainSloThresholds,
  type SyncBatchFleetTally,
} from './green-main-slo';

type NonVerdictReasonSkip = 'no-live-gate-owner' | 'covered-by-closed-item';
type NonVerdictReasonFiling = { id: string; assignee: string } | { skipped: NonVerdictReasonSkip };

export interface GreenMainSloPassDeps {
  installSlug: string;
  workspaceId: string;
  nowMs: number;
  thresholds?: GreenMainSloThresholds;
  readLastGreenAtMs: () => Promise<number | null>;
  readLastVerdictAtMs: () => Promise<number | null>;
  /** The live frozen queue, null when none is open. Throw when it cannot be read. */
  readQueue: () => Promise<GreenMainSloQueue | null>;
  /** Per-fleet sync tallies; omit until the sync-batch delta check exposes them. */
  readSyncTallies?: () => Promise<readonly SyncBatchFleetTally[] | null>;
  readNonVerdictReasons?: () => Promise<GateNonVerdictReasons | null>;
  fileNonVerdictReason?: (breach: GreenMainSloBreach) => Promise<NonVerdictReasonFiling>;
  notifyOnce: (input: ReplaySafeAttentionNotifyInput) => Promise<AttentionNotifyResult>;
  rail?: AlarmAttentionDeps;
  readConditions?: () => Promise<readonly SloCondition[]>;
}

type SloCondition = Pick<ConditionState, 'condition_key' | 'open' | 'open_since' | 'last_seen'>;

export interface GreenMainSloDelivery {
  episodeKey: string;
  severity: 'page' | 'alert';
  /** True when an earlier tick already delivered this episode (the steady state of a long red). */
  deduped: boolean;
  /** Set when delivery threw; the breach stays undelivered and the next tick retries it. */
  error?: string;
}

export interface GreenMainSloPassResult {
  slo: GreenMainSlo;
  deliveries: GreenMainSloDelivery[];
  /** Readers that failed this tick, by input name. Empty on a healthy pass. */
  readErrors: Array<{ input: 'lastGreenAt' | 'lastVerdictAt' | 'queue' | 'syncTallies' | 'nonVerdictReasons'; message: string }>;
  conditionErrors: string[];
  reasonItems: Array<{ reason: string; id: string; assignee: string }>;
  /**
   * Follow-ups intentionally skipped: no positively live gate owner can receive them, or an
   * earlier item for the same reason was closed and too few new outcomes have arrived since.
   */
  reasonFilingSkips: Array<{ reason: string; cause: NonVerdictReasonSkip }>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const conditionKey = (deps: GreenMainSloPassDeps, metric: string, episode: string, subject: string | null = null): string =>
  `alarm:green-main-slo:${encodeURIComponent(JSON.stringify([deps.workspaceId, deps.installSlug, metric, episode, subject]))}`;

const epoch = (value: unknown, nowMs: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= nowMs;

function measuredQueue(queue: GreenMainSloQueue | null, nowMs: number): boolean {
  if (queue === null) return true;
  if (!queue || typeof queue.candidate !== 'string' || !queue.candidate.trim() || !epoch(queue.openedAtMs, nowMs) ||
    !['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'].includes(queue.phase)) return false;
  for (const clock of ['fixerSpawnedAtMs', 'lastAdmittedAtMs', 'lastResumeRunStartedAtMs', 'lastVerdictAtMs'] as const) {
    const stamp = queue[clock];
    if (stamp != null && (!epoch(stamp, nowMs) || stamp < queue.openedAtMs)) return false;
  }
  return Array.isArray(queue.convergenceRounds ?? []) && Array.isArray(queue.admissions ?? []) &&
    (queue.convergenceRounds ?? []).every((r) => epoch(r.atMs, nowMs) && r.atMs >= queue.openedAtMs &&
      Number.isInteger(r.round) && r.round > 0 && Number.isInteger(r.failingCount) && r.failingCount >= 0) &&
    (queue.admissions ?? []).every((a) => epoch(a.atMs, nowMs) && a.atMs >= queue.openedAtMs &&
      typeof a.toRepairHead === 'string' && !!a.toRepairHead);
}

async function readSloConditions(): Promise<readonly SloCondition[]> {
  const { computeConditionStates, readConditionEnvelopes } = await import('../agent-tools/coordination/tools/conditions');
  return computeConditionStates(await readConditionEnvelopes());
}

/** Historical red-adding admissions clear only when a later measured round repairs their added failures. */
function repairedAdmissionAt(queue: GreenMainSloQueue | null, head: string, nowMs: number): number | null {
  if (!queue) return null;
  const admission = queue.admissions?.find((a) => a.toRepairHead === head);
  if (!admission || !epoch(admission.atMs, nowMs)) return null;
  const rounds = [...(queue.convergenceRounds ?? [])].sort((a, b) => a.atMs - b.atMs);
  const before = rounds.filter((r) => r.atMs <= admission.atMs).at(-1);
  const after = rounds.find((r) => r.atMs > admission.atMs);
  if (!before || !after || after.failingCount <= before.failingCount) return null;
  return rounds.find((r) => r.atMs > after.atMs && epoch(r.atMs, nowMs) &&
    Number.isInteger(r.failingCount) && r.failingCount >= 0 && r.failingCount <= before.failingCount)?.atMs ?? null;
}

/** Positive exact-subject observations only; a missing row or a skipped input never clears an episode. */
function measuredRecovery(
  metric: string, episode: string, exactSubject: string | null, openedAtMs: number, deps: GreenMainSloPassDeps, slo: GreenMainSlo,
  green: number | null, verdict: number | null, queue: GreenMainSloQueue | null,
  tallies: readonly SyncBatchFleetTally[] | null,
  reasons: GateNonVerdictReasons | null,
): boolean {
  if (!epoch(openedAtMs, deps.nowMs)) return false;
  const prefix = `green-main-slo:${deps.installSlug}:${metric}:`;
  if (!episode.startsWith(prefix)) return false;
  const subject = episode.slice(prefix.length);
  if (metric === 'time-since-green' || metric === 'time-since-verdict') {
    const stamp = metric === 'time-since-green' ? green : verdict;
    const threshold = metric === 'time-since-green' ? slo.thresholds.redPageMs : slo.thresholds.noVerdictPageMs;
    return epoch(stamp, deps.nowMs) && /^\d+$/.test(subject) && stamp > Number(subject) &&
      stamp >= openedAtMs && deps.nowMs - stamp < threshold;
  }
  if (metric === 'per-sync-red-rate') {
    return (tallies ?? []).some((t) => t.fleet === exactSubject && subject.startsWith(`${t.fleet ?? 'all'}:`) &&
      /^\d+$/.test(subject.slice(`${t.fleet ?? 'all'}:`.length)) &&
      Number(subject.slice(`${t.fleet ?? 'all'}:`.length)) <= Math.floor(deps.nowMs / 86_400_000) &&
      epoch(t.observedAtMs, deps.nowMs) && t.observedAtMs >= openedAtMs &&
      Number.isInteger(t.judgedBatches) && t.judgedBatches >= slo.thresholds.perSyncRedMinBatches &&
      Number.isInteger(t.redBatches) && t.redBatches >= 0 && t.redBatches <= t.judgedBatches &&
      t.redBatches / t.judgedBatches <= slo.thresholds.perSyncRedRateAlert);
  }
  if (metric === 'non-verdict-reason') {
    if (!reasons || !exactSubject || !subject.startsWith(`${exactSubject}:`) ||
        !/^\d+$/.test(subject.slice(exactSubject.length + 1)) || reasons.measuredAtMs < openedAtMs) return false;
    return (reasons.reasons.find((r) => r.reason === exactSubject)?.count ?? 0) < slo.thresholds.nonVerdictReasonMinCount;
  }
  if (!queue || !epoch(queue.openedAtMs, deps.nowMs) || typeof queue.candidate !== 'string' || queue.candidate !== exactSubject) return false;
  if (metric === 'red-adding-admission') {
    const repairedAt = repairedAdmissionAt(queue, subject, deps.nowMs);
    return repairedAt !== null && repairedAt >= openedAtMs;
  }
  if (!subject.startsWith(`${queue.candidate}:`)) return false;
  const rounds = queue.convergenceRounds ?? [];
  if (rounds.some((r) => !epoch(r.atMs, deps.nowMs) || !Number.isInteger(r.round) || r.round < 0)) return false;
  if (metric === 'round-cycle-time') {
    const latest = rounds.reduce<(typeof rounds)[number] | undefined>((a, r) => !a || r.atMs > a.atMs ? r : a, undefined);
    const oldRound = subject.slice(queue.candidate.length + 1);
    return !!latest && /^\d+$/.test(oldRound) && latest.round > Number(oldRound) && latest.atMs >= openedAtMs &&
      slo.metrics.roundCycleTime.lastMs !== null && slo.metrics.roundCycleTime.lastMs <= slo.thresholds.roundCycleAlertMs;
  }
  if (metric === 'queue-idle') {
    const latency = frozenRepairLatency(queue, deps.nowMs);
    return !latency.inadmissibleStamps?.length && slo.metrics.queueIdleMs !== null &&
      slo.metrics.queueIdleMs <= slo.thresholds.queueIdleAlertMs &&
      [latency.stamps.fixerSpawnedAtMs, latency.stamps.lastResumeRunStartedAtMs, latency.stamps.lastVerdictAtMs]
        .some((stamp) => epoch(stamp, deps.nowMs) && stamp >= openedAtMs);
  }
  return false;
}

/** One pass with injected IO. Never throws: read and delivery failures are reported in the result. */
export async function runGreenMainSloPass(deps: GreenMainSloPassDeps): Promise<GreenMainSloPassResult> {
  const readErrors: GreenMainSloPassResult['readErrors'] = [];
  const read = async <T>(
    input: GreenMainSloPassResult['readErrors'][number]['input'],
    fn: () => Promise<T>,
    fallback: T,
    valid: (value: T) => boolean = () => true,
  ): Promise<T> => {
    try {
      const value = await fn();
      if (!valid(value)) throw new Error(`invalid ${input} measurement`);
      return value;
    } catch (e) {
      readErrors.push({ input, message: message(e) });
      return fallback;
    }
  };

  const [lastGreenAtMs, lastVerdictAtMs, queue, syncTallies, nonVerdictReasons] = await Promise.all([
    read('lastGreenAt', deps.readLastGreenAtMs, null, (v) => v === null || epoch(v, deps.nowMs)),
    read('lastVerdictAt', deps.readLastVerdictAtMs, null, (v) => v === null || epoch(v, deps.nowMs)),
    read('queue', deps.readQueue, null, (v) => measuredQueue(v, deps.nowMs)),
    deps.readSyncTallies ? read('syncTallies', deps.readSyncTallies, null, (v) => v === null ||
      (Array.isArray(v) && v.every((t) => t && (t.fleet === null || typeof t.fleet === 'string') &&
        Number.isInteger(t.judgedBatches) && t.judgedBatches >= 0 && Number.isInteger(t.redBatches) &&
        t.redBatches >= 0 && t.redBatches <= t.judgedBatches &&
        (t.observedAtMs === undefined || epoch(t.observedAtMs, deps.nowMs))))) : Promise.resolve(null),
    deps.readNonVerdictReasons ? read('nonVerdictReasons', deps.readNonVerdictReasons, null, (v) => v === null ||
      (v.windowHours === 24 && epoch(v.measuredAtMs, deps.nowMs) && v.measuredAtMs === deps.nowMs &&
        v.sinceMs === v.measuredAtMs - 86_400_000 && Array.isArray(v.reasons) &&
        new Set(v.reasons.map((r) => r.reason)).size === v.reasons.length &&
        v.reasons.every((r) => typeof r.reason === 'string' && !!r.reason && Number.isSafeInteger(r.count) &&
          r.count > 0 && r.latestAtMs >= v.sinceMs && r.latestAtMs <= v.measuredAtMs))) : Promise.resolve(null),
  ]);

  const slo = computeGreenMainSlo(
    { installSlug: deps.installSlug, nowMs: deps.nowMs, lastGreenAtMs, lastVerdictAtMs, queue, syncTallies, nonVerdictReasons },
    deps.thresholds,
  );

  const deliveries: GreenMainSloDelivery[] = [];
  const conditionErrors: string[] = [];
  const reasonItems: GreenMainSloPassResult['reasonItems'] = [];
  const reasonFilingSkips: GreenMainSloPassResult['reasonFilingSkips'] = [];
  let conditions: readonly SloCondition[] | null = null;
  try {
    conditions = await (deps.readConditions ?? readSloConditions)();
    if (!Array.isArray(conditions)) throw new Error('invalid condition census');
  }
  catch (e) { conditions = null; conditionErrors.push(`read conditions: ${message(e)}`); }
  for (const breach of slo.breaches) {
    const key = conditionKey(deps, breach.metric, breach.episodeKey, breach.subject);
    if (breach.metric === 'non-verdict-reason') {
      try {
        if (!deps.fileNonVerdictReason) throw new Error('owned reason filer unavailable');
        const item = await deps.fileNonVerdictReason(breach);
        if ('skipped' in item) {
          reasonFilingSkips.push({ reason: breach.subject!, cause: item.skipped });
        } else {
          if (!item?.id || !item.assignee) throw new Error('reason filing returned no accountable holder');
          reasonItems.push({ reason: breach.subject!, ...item });
        }
      } catch (e) { conditionErrors.push(`file ${breach.subject}: ${message(e)}`); }
    }
    // A historical admission can remain in the SLO panel after a later round fixed it.
    const repaired = breach.metric === 'red-adding-admission' && repairedAdmissionAt(queue, breach.episodeKey.slice(
      `green-main-slo:${deps.installSlug}:${breach.metric}:`.length), deps.nowMs) !== null;
    if (!repaired && !conditions?.some((c) => c.condition_key === key && c.open)) {
      try {
        const event = { conditionKey: key, summary: breach.title, body: breach.detail, oneShot: true };
        const delivered = deps.rail?.broadcast
          ? await deps.rail.broadcast(event)
          : await broadcastSevereEvent(event);
        if (!delivered) conditionErrors.push(`open ${key}: delivery returned false`);
      } catch (e) { conditionErrors.push(`open ${key}: ${message(e)}`); }
    }
    try {
      const res = await deps.notifyOnce({
        kind: 'intervention',
        title: breach.title,
        body: breach.detail,
        importance: breach.severity === 'page' ? 'urgent' : 'normal',
        harnessSlug: deps.installSlug,
        workspaceId: deps.workspaceId,
        dedupeKey: breach.episodeKey,
        data: {
          source: 'green-main-slo',
          metric: breach.metric,
          severity: breach.severity,
          value: breach.value,
          threshold: breach.threshold,
          conditionKey: key,
        },
      });
      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: res.deduped });
    } catch (e) {
      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: false, error: message(e) });
    }
  }
  for (const condition of conditions ?? []) {
    if (!condition.open || !condition.condition_key.startsWith('alarm:green-main-slo:')) continue;
    try {
      const scope: unknown = JSON.parse(decodeURIComponent(condition.condition_key.slice('alarm:green-main-slo:'.length)));
      if (!Array.isArray(scope) || scope.length !== 5 || scope.slice(0, 4).some((s) => typeof s !== 'string') ||
        (scope[4] !== null && typeof scope[4] !== 'string') ||
        scope[0] !== deps.workspaceId || scope[1] !== deps.installSlug ||
        conditionKey(deps, scope[2], scope[3], scope[4]) !== condition.condition_key) continue;
      const openedAtMs = Date.parse(condition.open_since ?? condition.last_seen);
      if (measuredRecovery(scope[2], scope[3], scope[4], openedAtMs, deps, slo, lastGreenAtMs, lastVerdictAtMs, queue, syncTallies, nonVerdictReasons)) {
        const resolved = await resolveAlarm(condition.condition_key, 'green-main-slo', deps.rail);
        if (!resolved) conditionErrors.push(`resolve ${condition.condition_key}: delivery returned false`);
      }
    } catch (e) { conditionErrors.push(`reconcile ${condition.condition_key}: ${message(e)}`); }
  }
  return { slo, deliveries, readErrors, conditionErrors, reasonItems, reasonFilingSkips };
}

/**
 * EI-26555742295077041: a closed reason item already answered every outcome counted before its
 * close. The close nulls `condition_key`, so the create seam's open-key dedupe cannot see it,
 * and the rolling-day count keeps including those same outcomes until they age out. Without this
 * guard every close was followed by a fresh item for identical events
 * (WI-6554700010018575 -> WI-6554700010018662 -> WI-6554700010018758, all one set of 7 rows).
 */
export interface NonVerdictReasonRefileGuard {
  /** Newest close (epoch ms) of an earlier item this filer raised for the same install + reason; null if none. */
  readLastClosedAtMs: () => Promise<number | null>;
  /** Outcomes of this reason at or after `sinceMs`, counted exactly as readGateNonVerdictReasons counts them. */
  countSince: (sinceMs: number) => Promise<number>;
}

/** Newest close of an earlier green-main-slo reason item for this exact install + reason. */
export async function readLastClosedNonVerdictReasonItemMs(
  sql: Sql,
  target: { workspaceId: string; installSlug: string },
  reason: string,
): Promise<number | null> {
  const rows = await sql<{ closed_ms: string | number | null }[]>`
    SELECT max(closed_ts) AS closed_ms
      FROM harness_shared.work_items
     WHERE workspace_id = ${target.workspaceId} AND harness_slug = ${target.installSlug}
       AND payload->>'source' = 'green-main-slo' AND payload->>'reason' = ${reason}
       AND status IN ('done', 'dropped', 'resolved', 'closed') AND closed_ts IS NOT NULL`;
  const raw = rows[0]?.closed_ms;
  if (raw == null) return null;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`closed reason item has an invalid closed_ts: ${String(raw)}`);
  return ms;
}

/** Reuse the condition-key create/claim seam; adoption must never report an unowned success. */
export async function fileRecurringNonVerdictReason(
  target: { workspaceId: string; installSlug: string },
  breach: GreenMainSloBreach,
  refile: NonVerdictReasonRefileGuard,
): Promise<NonVerdictReasonFiling> {
  // Re-file only on enough NEW outcomes since the last close; the pre-close ones were answered.
  const closedAtMs = await refile.readLastClosedAtMs();
  if (closedAtMs !== null && (await refile.countSince(closedAtMs)) < breach.threshold) {
    return { skipped: 'covered-by-closed-item' };
  }
  const { readGateOwnership, ownershipHeldByLiveHolder } = await import('../coord/gate-ownership');
  const { createOneWorkItem } = await import('../agent-tools/work_items/_create-core');
  const { claimWorkItem, getWorkItem } = await import('../work-items');
  const owner = await readGateOwnership({ harness: target.installSlug });
  // The breach condition and owner notification are still delivered by the pass below. This
  // extra work-item follow-up needs a positively live assignee; its absence is a skip, not a
  // watchdog execution failure. Read/write errors still throw and remain visible as failures.
  if (!ownershipHeldByLiveHolder(owner) || !owner.takenBy) return { skipped: 'no-live-gate-owner' };
  const filed = await createOneWorkItem({
    kind: 'bug', title: breach.title, summary: breach.detail, harness: target.installSlug,
    workspace: target.workspaceId, assign_to: owner.takenBy, urgent: true,
    conditionKey: `green-main-non-verdict:${JSON.stringify([target.workspaceId, target.installSlug, breach.subject])}`,
    payload: { source: 'green-main-slo', reason: breach.subject, count: breach.value, threshold: breach.threshold },
  }, { ownerId: 'system:green-main-slo', workspaceId: target.workspaceId, harnessSlug: target.installSlug });
  if (!filed.ok) throw new Error(`reason filing refused: ${filed.error}`);
  let item = filed.workItem;
  if (!item.assignee) {
    item = await claimWorkItem(item.id, owner.takenBy, { harness: item.harness ?? undefined, assignedBy: 'system:green-main-slo' })
      ?? await getWorkItem(item.id, item.harness ?? undefined) ?? item;
  }
  if (!item.assignee) throw new Error(`reason item ${item.id} remains unassigned`);
  return { id: item.id, assignee: item.assignee };
}

/** Parse `gate_health.lastGreenAt` as stored (epoch ms, number or numeric string). */
export function parseLastGreenAtMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`gate_health.lastGreenAt is not an epoch ms: ${String(raw)}`);
  return n;
}

/** The production pass, wired into `startGreenStallWatchdog`. Never throws. */
export async function checkGreenMainSlo(
  sql: Sql,
  opts: { installSlug: string; nowMs?: () => number; thresholds?: GreenMainSloThresholds },
): Promise<GreenMainSloPassResult | null> {
  const installSlug = typeof opts.installSlug === 'string' ? opts.installSlug.trim() : '';
  if (!installSlug) {
    console.warn('[green-main-slo] skipped: installSlug is required');
    return null;
  }
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string; last_green_at: string | number | null }[]>`
      SELECT workspace_id, (metadata->'gate_health'->>'lastGreenAt') AS last_green_at
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = rows[0].workspace_id;
    const target = { workspaceId, installSlug };

    const { readVerdictRateWindow } = await import('./gate-verdict-rate-alarm');
    const { readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const { notifyAttentionOnce } = await import('../attention-notify');

    const nowMs = (opts.nowMs ?? Date.now)();
    const result = await runGreenMainSloPass({
      installSlug,
      workspaceId,
      nowMs,
      thresholds: opts.thresholds,
      readLastGreenAtMs: async () => parseLastGreenAtMs(rows[0].last_green_at),
      readLastVerdictAtMs: async () => (await readVerdictRateWindow(sql, target)).lastVerdictBearingAtMs,
      readNonVerdictReasons: () => readGateNonVerdictReasons(sql, target, nowMs),
      fileNonVerdictReason: (breach) => fileRecurringNonVerdictReason(target, breach, {
        readLastClosedAtMs: () => readLastClosedNonVerdictReasonItemMs(sql, target, breach.subject ?? ''),
        countSince: async (sinceMs) => (await readGateNonVerdictReasons(sql, target, nowMs, { sinceMs }))
          .reasons.find((r) => r.reason === breach.subject)?.count ?? 0,
      }),
      readQueue: async () => {
        const q = await readFrozenCandidateRepairQueueState(target);
        if (q.status === 'value') return q.queue;
        if (q.status === 'absent') return null;
        throw new Error(`frozen repair queue unreadable: ${q.reason}`);
      },
      readSyncTallies: async () => {
        const delta = await sql<{ sync_delta: unknown }[]>`
          SELECT metadata->'sync_delta' AS sync_delta FROM harness_shared.routines
           WHERE install_slug = ${installSlug} AND name = 'sync-batch-delta-check'
           LIMIT 1`;
        return syncTalliesFromDeltaCoverage(delta[0]?.sync_delta);
      },
      notifyOnce: notifyAttentionOnce,
    });

    const failed = [
      ...result.readErrors.map((r) => `read ${r.input}: ${r.message}`),
      ...result.deliveries.filter((d) => d.error).map((d) => `deliver ${d.episodeKey}: ${d.error}`),
      ...result.conditionErrors,
    ];
    if (failed.length > 0) passError = new Error(failed.join('; '));
    const fresh = result.deliveries.filter((d) => !d.deduped && !d.error);
    if (fresh.length > 0) {
      console.warn(`[green-main-slo] ${installSlug}: delivered ${fresh.map((d) => `${d.severity} ${d.episodeKey}`).join(', ')}`);
    }
    return result;
  } catch (e) {
    passError = e;
    console.warn(`[green-main-slo] pass failed (non-fatal): ${message(e)}`);
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'green-main-slo', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}
