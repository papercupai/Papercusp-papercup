/**
 * gate-live-invariants.ts — plan green-main-cycle-time-2026-10-08 P-018 (WI-10007479).
 *
 * Standing LIVE invariants for the gate mechanisms earlier plans shipped and marked done, checked
 * on every green-stall-watchdog tick. The 2026-10-08 audit found several of those mechanisms
 * contradicted live (a fixer never dispatched for ~20h, admissions with no surviving pre-check
 * record, a gate tick refused at begin for hours) while every unit test stayed green. A test
 * proves the code once; an invariant proves the RUNNING system every tick.
 *
 * Seven invariants, each a pure evaluator over one {@link GateInvariantSnapshot}:
 *   fixer-spawn-latency  a red queue gets a live fixer within one gate tick
 *   targeted-radius      repair rounds run only their targeted radius (no ledger yet ⇒ unknown)
 *   admission-precheck   the newest admission on the lineage ran its pre-check and it passed
 *   no-verdict-rate      gate outcomes that end with no verdict stay a minority
 *   round-idle-time      an admitted head starts its verification run within one tick
 *   executor-freshness   the process running the gate runs the gate code that is committed
 *   fixer-outcome-mix    dispatched release-fixers mostly FINISH; deaths stay a minority (WI-10007488)
 *
 * `unknown` is a first-class status, never folded into pass: an invariant whose evidence cannot be
 * read is not passing, and the plan's 7-day acceptance counts passes only.
 *
 * Persistence: the current state lives in `routines.metadata.gate_invariants` on the
 * green-checkpoint row (overwritten per evaluation); history lives in `pipeline_events` under its
 * own kind `gate_invariants` (migration 1425), appended on any status transition and at least
 * hourly. Each breach episode files (or refreshes) one work-item per invariant through
 * `upsertConditionWorkItem`, keyed `gate-invariant:<install>:<name>`. Failed filings retry on
 * the next lease-eligible evaluation until a work-item id has been stored.
 */
import type { Sql } from 'postgres';
import { frozenRepairLatency, type FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';

export const GATE_INVARIANT_NAMES = [
  'fixer-spawn-latency',
  'targeted-radius',
  'admission-precheck',
  'no-verdict-rate',
  'round-idle-time',
  'executor-freshness',
  'fixer-outcome-mix',
] as const;
export type GateInvariantName = (typeof GATE_INVARIANT_NAMES)[number];
export type GateInvariantStatus = 'pass' | 'breach' | 'unknown';

export interface GateInvariantResult {
  name: GateInvariantName;
  status: GateInvariantStatus;
  /** One sentence a reader can act on: the measured value and the limit it was judged against. */
  observed: string;
}

export const GATE_INVARIANTS_METADATA_KEY = 'gate_invariants';

export interface GateInvariantThresholds {
  /** Slack added to one tick before a wait counts as a breach. */
  graceMs: number;
  /** Tick length when the fire ledger has too few rows to measure one. */
  defaultTickMs: number;
  noVerdictWindowMs: number;
  /** Breach when more than this fraction of outcomes in the window carried no verdict… */
  noVerdictMaxRate: number;
  /** …and at least this many of them did (so two bad ticks in a quiet day do not page). */
  noVerdictMinFailures: number;
  /** How long committed gate code may wait for the executor to load it (a restart window). */
  executorGraceMs: number;
  /** Window of ended release-fixer spawns the outcome mix is judged over. */
  fixerOutcomeWindowMs: number;
  /** Breach when more than this fraction of ended fixers DIED (status failed)… */
  fixerDeathMaxRate: number;
  /** …and at least this many did (one unlucky fixer in a quiet week does not page). */
  fixerDeathMinDeaths: number;
}

export const DEFAULT_GATE_INVARIANT_THRESHOLDS: GateInvariantThresholds = {
  graceMs: 5 * 60_000,
  defaultTickMs: 60 * 60_000,
  noVerdictWindowMs: 24 * 60 * 60_000,
  noVerdictMaxRate: 0.5,
  noVerdictMinFailures: 3,
  executorGraceMs: 30 * 60_000,
  fixerOutcomeWindowMs: 7 * 24 * 60 * 60_000,
  fixerDeathMaxRate: 0.5,
  fixerDeathMinDeaths: 3,
};

/** green_checkpoint statuses that ARE a verdict on a candidate. */
export const VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'advanced',
  'not-green',
  'decision-pending',
  'desktop-perf-held',
  'not-fast-forward',
]);

/**
 * Statuses that legitimately carry no verdict: nothing new to judge, or a live attempt / repair
 * already owns the judgement. Any status in neither set — including one added later — counts as a
 * no-verdict FAILURE, so a new failure mode cannot pass silently by being unrecognised.
 */
export const BENIGN_NO_VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'unchanged-since-verdict',
  'up-to-date',
  'skipped-joined-attempt',
  'repair-in-progress',
]);

/** Paths whose code the gate executor runs; a change here is invisible until it restarts. */
export const GATE_CODE_PREFIXES = [
  'packages/operator-core/lib/release/',
  'packages/operator-core/lib/harness/routines/',
] as const;

export interface GateExecutorEvidence {
  /** `detail.vintage.treeSha` of the newest gate fire — the tree the executing process booted on. */
  treeSha: string | null;
  /** Non-test gate-code paths changed between that tree and the current head; null = unresolvable. */
  driftPaths: string[] | null;
  /** Commit time of the oldest commit after the boot tree that touched a gate-code prefix. */
  oldestDriftCommitMs: number | null;
}

export interface GateInvariantSnapshot {
  nowMs: number;
  /** False when the repair-queue row exists but could not be parsed. */
  queueReadable: boolean;
  /** The open frozen repair queue, or null when none is open. */
  queue: FrozenCandidateRepairQueue | null;
  /** Liveness of `queue.fixerSpawnId`; null when there is none or it could not be read. */
  fixerAlive: boolean | null;
  /** Spacing between consecutive recent gate fires, newest first. */
  fireIntervalsMs: number[];
  /** green_checkpoint outcome statuses inside the no-verdict window; null when unreadable. */
  checkpointStatuses: string[] | null;
  /** Null when no gate fire has been recorded. */
  executor: GateExecutorEvidence | null;
  /** Release-fixer spawns for this install that ENDED inside the outcome window; null when unreadable. */
  fixerOutcomes: FixerOutcome[] | null;
}

/** One ended release-fixer spawn: its terminal status and the reason the row carries, if any. */
export interface FixerOutcome {
  status: string;
  reason: string | null;
}

/**
 * Why a release-fixer DIED, from the reason its row carries. The reclaim sweeps that write most of
 * these reasons RECORD a death the /proc check already observed; they do not cause it, so the
 * class names the observation (whose launcher restarted, whose child was found dead), never a
 * presumed killer. Unrecognised text is `other`, so a new failure mode still counts as a death.
 */
export function classifyFixerDeath(reason: string | null | undefined): string {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('boot-id mismatch')) return 'launcher-restarted';
  if (r.startsWith('reclaimed at operator boot')) return 'launcher-restarted';
  if (r.includes('confirmed dead')) return 'child-dead';
  if (r.includes('heartbeat stale')) return 'heartbeat-stale';
  if (r.includes('spawn-ceiling-jam')) return 'silent-no-stream';
  if (r.startsWith('infra_loss')) return 'infra-loss';
  if (r.length === 0) return 'no-reason';
  return 'other';
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;

/** One gate tick, measured from the fire ledger (median spacing), never assumed. */
export function measuredTickMs(snapshot: Pick<GateInvariantSnapshot, 'fireIntervalsMs'>, t: GateInvariantThresholds): number {
  const xs = snapshot.fireIntervalsMs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < 2) return t.defaultTickMs;
  return xs[Math.floor(xs.length / 2)] as number;
}

type Evaluator = (s: GateInvariantSnapshot, t: GateInvariantThresholds) => Omit<GateInvariantResult, 'name'>;

const unreadableQueue = { status: 'unknown' as const, observed: 'the repair-queue row exists but could not be parsed' };
const noQueue = { status: 'pass' as const, observed: 'no frozen repair queue is open' };

export const evaluateFixerSpawnLatency: Evaluator = (s, t) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  if (q.phase !== 'awaiting-fixer') return { status: 'pass', observed: `queue phase is ${q.phase}, not awaiting a fixer` };
  const limit = measuredTickMs(s, t) + t.graceMs;
  const lat = frozenRepairLatency(q, s.nowMs);
  if (lat.redAwaitingFixerMs !== null) {
    return {
      status: lat.redAwaitingFixerMs > limit ? 'breach' : 'pass',
      observed: `the newest red has waited ${minutes(lat.redAwaitingFixerMs)} with no fixer dispatched (limit ${minutes(limit)})`,
    };
  }
  if (s.fixerAlive === false) {
    return { status: 'breach', observed: `assigned fixer ${q.fixerSpawnId ?? '(none)'} is dead while the queue still awaits a fixer` };
  }
  if (s.fixerAlive === null && q.fixerSpawnId) {
    return { status: 'unknown', observed: `liveness of assigned fixer ${q.fixerSpawnId} could not be read` };
  }
  const spawnLatency = lat.redToFixerSpawnMs;
  if (spawnLatency !== null && spawnLatency > limit) {
    return { status: 'breach', observed: `the live fixer was dispatched ${minutes(spawnLatency)} after the red it answers (limit ${minutes(limit)})` };
  }
  return { status: 'pass', observed: `a live fixer was dispatched${spawnLatency === null ? '' : ` ${minutes(spawnLatency)} after the red`}` };
};

/**
 * WI-10007489: each red round records the radius it EXECUTED (`convergenceRounds[].executed`).
 * A targeted round passes, and so does a full-gate round with a legitimate trigger: the opening
 * candidate red, the promotion proof after a targeted green (P-007), or a signature only the full
 * gate re-measures. A full round with NO trigger is the fallthrough the zero-wait-convergence
 * promise forbids. Rounds written before the record existed are counted, never judged.
 */
export const evaluateTargetedRadius: Evaluator = (s) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return { status: 'pass', observed: 'no frozen repair queue is open, so no repair rounds run' };
  const rounds = q.convergenceRounds ?? [];
  const recorded = rounds.filter((round) => round.executed !== undefined);
  if (recorded.length === 0) {
    return {
      status: 'unknown',
      observed:
        rounds.length === 0
          ? 'the open repair queue has no red round recorded yet'
          : `none of the open queue's ${rounds.length} round(s) records its executed radius (written before WI-10007489), so a full-gate fallthrough cannot be told from a targeted round`,
    };
  }
  let targeted = 0;
  let opening = 0;
  let promotionProof = 0;
  let fullRequired = 0;
  const unexplained: number[] = [];
  for (const round of recorded) {
    const executed = round.executed!;
    if (executed.mode === 'targeted') targeted += 1;
    else if (executed.trigger === 'candidate') opening += 1;
    else if (executed.trigger === 'promotion-proof') promotionProof += 1;
    else if (executed.trigger === 'full-run-required') fullRequired += 1;
    else unexplained.push(round.round);
  }
  const unrecorded = rounds.length - recorded.length;
  const counts =
    `${targeted} targeted, ${promotionProof} full as promotion proof, ${fullRequired} full-run-required, ${opening} opening` +
    (unrecorded > 0 ? `; ${unrecorded} older round(s) carry no record` : '');
  if (unexplained.length > 0) {
    return {
      status: 'breach',
      observed: `${unexplained.length} round(s) ran the full gate with no recorded reason (round ${unexplained.slice(0, 5).join(', ')}${unexplained.length > 5 ? ', …' : ''}): ${counts}`,
    };
  }
  return { status: 'pass', observed: `every recorded round ran its targeted radius or a justified full gate: ${counts}` };
};

export const evaluateAdmissionPrecheck: Evaluator = (s) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  const lineage = (q.admissions ?? []).filter((a) => a.atMs >= q.openedAtMs);
  if (lineage.length === 0) return { status: 'pass', observed: 'no admission on the current lineage yet' };
  const latest = lineage.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  const at = new Date(latest.atMs).toISOString();
  const p = latest.precheck;
  if (!p) return { status: 'breach', observed: `the newest admission (${at}, ${latest.paths.length} path(s)) carries no pre-check record` };
  if (!p.ran) {
    if (p.reason === 'nothing-to-run') return { status: 'pass', observed: `the newest admission (${at}) had no tests to pre-check` };
    const why = [p.reason, p.precheckReason].filter(Boolean).join(': ') || 'no reason recorded';
    return { status: 'breach', observed: `the newest admission (${at}) did not run its pre-check (${why})` };
  }
  const failing = p.failing ?? [];
  if (failing.length > 0) {
    return { status: 'breach', observed: `the newest admission (${at}) was admitted with ${failing.length} failing pre-check test(s): ${failing.slice(0, 3).join(', ')}` };
  }
  return { status: 'pass', observed: `the newest admission (${at}) ran its pre-check: ${(p.passing ?? []).length} passing, 0 failing` };
};

export const evaluateNoVerdictRate: Evaluator = (s, t) => {
  const statuses = s.checkpointStatuses;
  if (statuses === null) return { status: 'unknown', observed: 'gate outcome ledger could not be read' };
  if (statuses.length === 0) return { status: 'unknown', observed: `no gate outcome recorded in the last ${minutes(t.noVerdictWindowMs)}` };
  const failures = new Map<string, number>();
  let verdicts = 0;
  for (const st of statuses) {
    if (VERDICT_STATUSES.has(st)) verdicts += 1;
    else if (!BENIGN_NO_VERDICT_STATUSES.has(st)) failures.set(st, (failures.get(st) ?? 0) + 1);
  }
  const failed = [...failures.values()].reduce((a, b) => a + b, 0);
  const rate = failed / statuses.length;
  const top = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ');
  const breach = failed >= t.noVerdictMinFailures && rate > t.noVerdictMaxRate;
  return {
    status: breach ? 'breach' : 'pass',
    observed: `${failed}/${statuses.length} gate outcomes in ${minutes(t.noVerdictWindowMs)} ended with no verdict (${verdicts} verdicts)${top ? `; ${top}` : ''} (limit: >${Math.round(t.noVerdictMaxRate * 100)}% and ≥${t.noVerdictMinFailures})`,
  };
};

export const evaluateRoundIdleTime: Evaluator = (s, t) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  const limit = measuredTickMs(s, t) + t.graceMs;
  const lat = frozenRepairLatency(q, s.nowMs);
  if (lat.admitAwaitingResumeRunStartMs !== null) {
    return {
      status: lat.admitAwaitingResumeRunStartMs > limit ? 'breach' : 'pass',
      observed: `the newest admission has waited ${minutes(lat.admitAwaitingResumeRunStartMs)} for its verification run to start (limit ${minutes(limit)})`,
    };
  }
  if (q.phase === 'ready-to-test') {
    const idle = Math.max(0, s.nowMs - q.updatedAtMs);
    return {
      status: idle > limit ? 'breach' : 'pass',
      observed: `the queue has sat ready-to-test for ${minutes(idle)} (limit ${minutes(limit)})`,
    };
  }
  return { status: 'pass', observed: `no admitted head is waiting for a run (phase ${q.phase})` };
};

export const evaluateExecutorFreshness: Evaluator = (s, t) => {
  const e = s.executor;
  if (!e) return { status: 'unknown', observed: 'no gate fire is recorded, so the executing build is unknown' };
  if (!e.treeSha) return { status: 'unknown', observed: 'the newest gate fire carries no vintage tree sha' };
  if (e.driftPaths === null) return { status: 'unknown', observed: `gate-code drift from executor tree ${e.treeSha} could not be resolved` };
  if (e.driftPaths.length === 0) return { status: 'pass', observed: `the executor (tree ${e.treeSha}) runs the committed gate code` };
  const age = e.oldestDriftCommitMs === null ? null : Math.max(0, s.nowMs - e.oldestDriftCommitMs);
  const sample = e.driftPaths.slice(0, 3).join(', ');
  if (age === null) return { status: 'unknown', observed: `executor tree ${e.treeSha} lacks ${e.driftPaths.length} gate-code change(s) of unknown age: ${sample}` };
  return {
    status: age > t.executorGraceMs ? 'breach' : 'pass',
    observed: `the executor (tree ${e.treeSha}) lacks ${e.driftPaths.length} gate-code change(s), oldest committed ${minutes(age)} ago (limit ${minutes(t.executorGraceMs)}): ${sample}`,
  };
};

/**
 * WI-10007488: a fixer that dies cannot repair anything, and a death after real work burns an
 * attempt (the P-005 refund covers only zero-work deaths). Of the 225 papercusp release-fixers
 * spawned 2026-08-15..10-08, 215 ended `failed` and 8 finished (measured 2026-10-08) while every
 * survivability unit test stayed green — nothing watched the live outcome mix. Deaths are counted by the row's terminal status; the
 * reason only names the class. `cancelled` (a deliberate stop) is in the denominator, never a death.
 */
export const evaluateFixerOutcomeMix: Evaluator = (s, t) => {
  const outcomes = s.fixerOutcomes;
  const window = minutes(t.fixerOutcomeWindowMs);
  if (outcomes === null) return { status: 'unknown', observed: 'release-fixer outcome ledger could not be read' };
  if (outcomes.length === 0) return { status: 'pass', observed: `no release-fixer ended in the last ${window} — no deaths to judge` };
  const deaths = new Map<string, number>();
  let done = 0;
  for (const o of outcomes) {
    if (o.status === 'done') done += 1;
    else if (o.status === 'failed') {
      const cls = classifyFixerDeath(o.reason);
      deaths.set(cls, (deaths.get(cls) ?? 0) + 1);
    }
  }
  const died = [...deaths.values()].reduce((a, b) => a + b, 0);
  const rate = died / outcomes.length;
  const top = [...deaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ');
  const breach = died >= t.fixerDeathMinDeaths && rate > t.fixerDeathMaxRate;
  return {
    status: breach ? 'breach' : 'pass',
    observed:
      `${died}/${outcomes.length} release-fixers that ended in ${window} died (${done} finished)` +
      `${top ? `; ${top}` : ''} (limit: >${Math.round(t.fixerDeathMaxRate * 100)}% with ≥${t.fixerDeathMinDeaths} deaths)`,
  };
};

const EVALUATORS: Record<GateInvariantName, Evaluator> = {
  'fixer-spawn-latency': evaluateFixerSpawnLatency,
  'targeted-radius': evaluateTargetedRadius,
  'admission-precheck': evaluateAdmissionPrecheck,
  'no-verdict-rate': evaluateNoVerdictRate,
  'round-idle-time': evaluateRoundIdleTime,
  'executor-freshness': evaluateExecutorFreshness,
  'fixer-outcome-mix': evaluateFixerOutcomeMix,
};

/** PURE: every invariant against one snapshot. An evaluator that throws reports `unknown`. */
export function evaluateGateLiveInvariants(
  snapshot: GateInvariantSnapshot,
  thresholds: GateInvariantThresholds = DEFAULT_GATE_INVARIANT_THRESHOLDS,
): GateInvariantResult[] {
  return GATE_INVARIANT_NAMES.map((name) => {
    try {
      return { name, ...EVALUATORS[name](snapshot, thresholds) };
    } catch (err) {
      return { name, status: 'unknown' as const, observed: `evaluator threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

// ─── persisted state ────────────────────────────────────────────────────────────────────────────

export interface GateInvariantEntryState {
  status: GateInvariantStatus;
  observed: string;
  /** When the invariant entered its current status. */
  sinceMs: number;
  lastPassAtMs: number | null;
  evaluations: number;
  passes: number;
  /** Work-item filed for the current breach episode, when one was. */
  filedItemId?: string;
  /** Completion clock of the condition upsert, never the earlier evaluation clock. */
  filedAtMs?: number;
  /** Original measured gate tick at episode start; later ticks cannot widen its budget. */
  alarmTickMs?: number;
}

export interface GateInvariantsState {
  evaluatedAtMs: number;
  lastEmittedAtMs: number;
  invariants: Partial<Record<GateInvariantName, GateInvariantEntryState>>;
}

export interface GateInvariantTransition {
  name: GateInvariantName;
  from: GateInvariantStatus | null;
  to: GateInvariantStatus;
}

/** Minimum spacing between two hosts' evaluations: every DBOS host ticks the watchdog. */
export const GATE_INVARIANT_LEASE_MS = 5 * 60_000;
/** A pipeline_events row at least this often even when nothing changed — the acceptance ledger. */
export const GATE_INVARIANT_HEARTBEAT_MS = 60 * 60_000;

export const GATE_INVARIANT_ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The hourly writer runs behind the existing five-minute evaluation lease. */
export const GATE_INVARIANT_ACCEPTANCE_GAP_MS = GATE_INVARIANT_HEARTBEAT_MS + GATE_INVARIANT_LEASE_MS;

/** Historical evidence only; this never reads or operates the current gate. */
export async function readGateInvariantWindow(sql: Sql, scope: { workspaceId: string; installSlug: string },
  window: { windowStartMs: number; windowEndMs: number; maxRows?: number }): Promise<PipelineEventWindowRead> {
  const { windowStartMs, windowEndMs } = window;
  const maxRows = window.maxRows ?? 10_000;
  const base = { windowStartMs, windowEndMs, total: null, rows: [] };
  if (!scope.workspaceId.trim() || !scope.installSlug.trim() ||
      !Number.isSafeInteger(windowStartMs) || windowStartMs < 0 ||
      !Number.isSafeInteger(windowEndMs) || windowStartMs >= windowEndMs ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
    return { ...base, status: 'invalid', reason: 'Exact scope, finite window and bounded population are required.' };
  }
  try {
    // The predecessor establishes the state at the left boundary. A count and
    // its rows share one statement snapshot, so truncation cannot look healthy.
    const rows = await sql<{ id: string; status: string; detail: Record<string, unknown>;
      created_at: Date | string; population_count: string | number }[]>`
      WITH predecessor AS (
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'gate_invariants' AND created_at <= ${new Date(windowStartMs)}
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), population AS (
        SELECT * FROM predecessor
        UNION ALL
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'gate_invariants' AND created_at > ${new Date(windowStartMs)}
          AND created_at <= ${new Date(windowEndMs)}
      )
      SELECT id::text, status, detail, created_at, count(*) OVER () AS population_count
      FROM population ORDER BY created_at, id LIMIT ${maxRows + 1}`;
    const total = rows.length ? Number(rows[0]!.population_count) : 0;
    if (!Number.isSafeInteger(total) || total < rows.length ||
        (total <= maxRows && total !== rows.length) || rows.some(row => Number(row.population_count) !== total)) {
      return { ...base, status: 'unavailable', reason: 'Historical population count is inconsistent.' };
    }
    return { windowStartMs, windowEndMs, total,
      status: total > maxRows ? 'capped' : 'complete',
      reason: total > maxRows ? 'Historical population exceeds the row budget.' : null,
      rows: rows.slice(0, maxRows).map(row => ({ id: row.id, kind: 'gate_invariants', status: row.status,
        detail: row.detail, createdAtMs: new Date(row.created_at).getTime() })) };
  } catch (error) {
    return { ...base, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Fresh evaluation of the original history; it does not restamp old tests. */
export function evaluateGateInvariantWindow(history: PipelineEventWindowRead, observedAtMs = Date.now()) {
  const rows = [...history.rows].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const validClocks = Number.isSafeInteger(history.windowStartMs) && history.windowStartMs >= 0 &&
    Number.isSafeInteger(history.windowEndMs) && rows.every(row => Number.isSafeInteger(row.createdAtMs) &&
      row.createdAtMs >= 0 && row.createdAtMs <= history.windowEndMs);
  const complete = history.status === 'complete' && history.total === rows.length && rows.length > 0 &&
    rows.every(row => row.kind === 'gate_invariants' && typeof row.id === 'string' && row.id.length > 0) &&
    new Set(rows.map(row => row.id)).size === rows.length;
  const exactResults = rows.every(row => {
    const results: unknown = row.detail?.results;
    if (!Array.isArray(results) || results.length !== GATE_INVARIANT_NAMES.length) return false;
    return GATE_INVARIANT_NAMES.every(name => results.filter(result => result?.name === name).length === 1);
  });
  const passOnly = rows.every(row => row.status === 'pass' && Array.isArray(row.detail?.results) &&
    row.detail.results.every(result => result?.status === 'pass'));
  const gaps = rows.slice(1).map((row, i) => row.createdAtMs - rows[i]!.createdAtMs);
  const leftGap = rows[0] ? history.windowStartMs - rows[0].createdAtMs : Infinity;
  const rightGap = rows.at(-1) ? history.windowEndMs - rows.at(-1)!.createdAtMs : Infinity;
  const coverage = validClocks && rows.length > 0 && leftGap >= 0 &&
    Math.max(leftGap, rightGap, ...gaps) <= GATE_INVARIANT_ACCEPTANCE_GAP_MS;
  const assertions = [
    { id: 'seven-day-invariant-window', passed: validClocks &&
      history.windowEndMs - history.windowStartMs === GATE_INVARIANT_ACCEPTANCE_WINDOW_MS &&
      Number.isSafeInteger(observedAtMs) && history.windowEndMs <= observedAtMs,
      evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}; observed=${observedAtMs}; required=${GATE_INVARIANT_ACCEPTANCE_WINDOW_MS}ms` },
    { id: 'complete-invariant-population', passed: complete,
      evidence: `read=${history.status}; population=${history.total}; rows=${rows.length}; ${history.reason ?? 'no read error'}` },
    { id: 'exact-seven-invariant-identities', passed: complete && exactResults,
      evidence: GATE_INVARIANT_NAMES.join(', ') },
    { id: 'pass-only-invariant-history', passed: complete && exactResults && passOnly,
      evidence: 'Every original overall status and every named result must pass; breach and unknown remain failures.' },
    { id: 'hourly-invariant-history-coverage', passed: complete && coverage,
      evidence: `left=${leftGap}ms; right=${rightGap}ms; largest internal gap=${Math.max(0, ...gaps)}ms; bound=${GATE_INVARIANT_ACCEPTANCE_GAP_MS}ms` },
  ];
  return { assertions, eventIds: rows.map(row => row.id) };
}

/** Only the invariant portion of R17; no cycle-time, P006 or shipment claim. */
export async function executeGateInvariantWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({
    filePath: 'packages/operator-core/lib/release/gate-live-invariants.ts',
    name: 'Seven-day live gate invariant history', framework: 'operational',
    command: ['executeGateInvariantWindow', args.workspaceId, args.installSlug,
      String(args.windowStartMs), String(args.windowEndMs)], runtimeUnits: args.runtimeUnits,
    run: async () => {
      const history = await readGateInvariantWindow(sql, args, args);
      const evaluation = evaluateGateInvariantWindow(history);
      const populationHash = createHash('sha256').update(JSON.stringify(history)).digest('hex');
      return { exitCode: evaluation.assertions.every(assertion => assertion.passed) ? 0 : 1,
        assertions: evaluation.assertions,
        summary: `Invariant history only: workspace=${args.workspaceId}; install=${args.installSlug}; ` +
          `window=${args.windowStartMs}..${args.windowEndMs}; rows=${history.rows.length}; ` +
          `original_population_sha256=${populationHash}; first=${evaluation.eventIds[0] ?? 'none'}; ` +
          `last=${evaluation.eventIds.at(-1) ?? 'none'}. Runtime goal and final shipment require separate evidence.` };
    },
  }, args);
}

/** Original filing receipts only. This does not prove human delivery or pickup. */
export function evaluateGateInvariantAlarmWindow(history: PipelineEventWindowRead, observedAtMs = Date.now()) {
  const validWindow = Number.isSafeInteger(history.windowStartMs) && history.windowStartMs >= 0 &&
    Number.isSafeInteger(history.windowEndMs) && history.windowEndMs > history.windowStartMs &&
    Number.isSafeInteger(observedAtMs) && observedAtMs >= history.windowEndMs;
  const rows = [...history.rows].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const complete = history.status === 'complete' && history.total === rows.length && rows.length > 0 &&
    new Set(rows.map(row => row.id)).size === rows.length;
  type Episode = { name: GateInvariantName; sinceMs: number; tickMs: number;
    filedItemId: string | null; filedAtMs: number | null };
  const episodes = new Map<string, Episode>();
  let qualified = complete;
  for (const row of rows) {
    const results = row.detail?.results as GateInvariantResult[] | undefined;
    const original = row.detail?.alarmEpisodes as { version?: unknown; entries?: Episode[] } | undefined;
    const evaluatedAtMs = row.detail?.evaluatedAtMs;
    if (!row.id?.trim() || row.kind !== 'gate_invariants' ||
        !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs < 0 || row.createdAtMs > history.windowEndMs ||
        !Number.isSafeInteger(evaluatedAtMs) || (evaluatedAtMs as number) < 0 ||
        (evaluatedAtMs as number) > row.createdAtMs || !Array.isArray(results) ||
        results.length !== GATE_INVARIANT_NAMES.length ||
        !GATE_INVARIANT_NAMES.every(name => results.filter(result => result?.name === name).length === 1) ||
        results.some(result => !result || !['pass', 'breach', 'unknown'].includes(result.status)) ||
        row.status !== overallGateInvariantStatus(results) || original?.version !== 1 ||
        !Array.isArray(original.entries)) { qualified = false; continue; }
    const breached = results.filter(result => result.status === 'breach').map(result => result.name);
    if (original.entries.length !== breached.length ||
        !breached.every(name => original.entries!.filter(entry => entry?.name === name).length === 1)) qualified = false;
    for (const entry of original.entries) {
      if (!entry || !breached.includes(entry.name) || !Number.isSafeInteger(entry.sinceMs) || entry.sinceMs < 0 ||
          entry.sinceMs > (evaluatedAtMs as number) || !Number.isSafeInteger(entry.tickMs) || entry.tickMs <= 0 ||
          (entry.filedItemId !== null && (typeof entry.filedItemId !== 'string' || !entry.filedItemId.trim())) ||
          ((entry.filedItemId === null) !== (entry.filedAtMs === null)) ||
          (entry.filedAtMs !== null && (!Number.isSafeInteger(entry.filedAtMs) ||
            entry.filedAtMs < entry.sinceMs || entry.filedAtMs > row.createdAtMs))) { qualified = false; continue; }
      const key = JSON.stringify([entry.name, entry.sinceMs]);
      const previous = episodes.get(key);
      if (previous && (previous.tickMs !== entry.tickMs || (previous.filedItemId !== null &&
          (previous.filedItemId !== entry.filedItemId || previous.filedAtMs !== entry.filedAtMs)))) qualified = false;
      episodes.set(key, { ...entry });
    }
  }
  const leftGap = rows[0] ? history.windowStartMs - rows[0].createdAtMs : Infinity;
  const rightGap = rows.at(-1) ? history.windowEndMs - rows.at(-1)!.createdAtMs : Infinity;
  const gaps = rows.slice(1).map((row, i) => row.createdAtMs - rows[i]!.createdAtMs);
  const coverage = leftGap >= 0 && Math.max(leftGap, rightGap, ...gaps) <= GATE_INVARIANT_ACCEPTANCE_GAP_MS;
  const population = [...episodes.values()];
  const admissible = validWindow && complete && qualified && coverage && population.length > 0;
  return { episodes: population, eventIds: rows.map(row => row.id), assertions: [
    { id: 'bounded-invariant-alarm-window', passed: validWindow,
      evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}; observed=${observedAtMs}` },
    { id: 'complete-invariant-alarm-population', passed: complete && coverage,
      evidence: `read=${history.status}; population=${history.total}; rows=${rows.length}; left=${leftGap}; right=${rightGap}` },
    { id: 'original-invariant-breach-filing-receipts', passed: complete && qualified,
      evidence: 'Original episode start, frozen tick budget and condition-upsert completion clock; legacy or conflicting receipts fail.' },
    { id: 'nonempty-invariant-breach-episodes', passed: admissible, evidence: `episodes=${population.length}` },
    { id: 'invariant-breach-filings-within-one-tick', passed: admissible && population.every(episode =>
      episode.filedItemId !== null && episode.filedAtMs !== null && episode.filedAtMs - episode.sinceMs <= episode.tickMs),
      evidence: 'Every observed breach has a completed filing by its original tick deadline; pending and late receipts fail.' },
  ] };
}

export async function executeGateInvariantAlarmWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/gate-live-invariants.ts',
    name: 'Original invariant breach filing history', framework: 'operational',
    command: ['executeGateInvariantAlarmWindow', args.workspaceId, args.installSlug,
      String(args.windowStartMs), String(args.windowEndMs)], runtimeUnits: args.runtimeUnits,
    run: async () => {
      const history = await readGateInvariantWindow(sql, args, args);
      const evaluation = evaluateGateInvariantAlarmWindow(history);
      return { exitCode: evaluation.assertions.every(assertion => assertion.passed) ? 0 : 1,
        assertions: evaluation.assertions,
        summary: `Breach filing history only: workspace=${args.workspaceId}; install=${args.installSlug}; ` +
          `window=${args.windowStartMs}..${args.windowEndMs}; episodes=${evaluation.episodes.length}; ` +
          `original_population_sha256=${createHash('sha256').update(JSON.stringify(history)).digest('hex')}. ` +
          'Human delivery, pickup, runtime Goal and shipment require separate evidence.' };
    },
  }, args);
}

function originalAlarmEpisodes(state: GateInvariantsState) {
  return { version: 1, entries: GATE_INVARIANT_NAMES.flatMap(name => {
    const entry = state.invariants[name];
    return entry?.status === 'breach' ? [{ name, sinceMs: entry.sinceMs, tickMs: entry.alarmTickMs ?? null,
      filedItemId: entry.filedItemId ?? null, filedAtMs: entry.filedAtMs ?? null }] : [];
  }) };
}

export function parseGateInvariantsState(raw: unknown): GateInvariantsState | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.evaluatedAtMs !== 'number') return null;
  const invariants: GateInvariantsState['invariants'] = {};
  const src = r.invariants && typeof r.invariants === 'object' ? (r.invariants as Record<string, unknown>) : {};
  for (const name of GATE_INVARIANT_NAMES) {
    const e = src[name] as Record<string, unknown> | undefined;
    if (!e || (e.status !== 'pass' && e.status !== 'breach' && e.status !== 'unknown')) continue;
    invariants[name] = {
      status: e.status,
      observed: typeof e.observed === 'string' ? e.observed : '',
      sinceMs: typeof e.sinceMs === 'number' ? e.sinceMs : r.evaluatedAtMs,
      lastPassAtMs: typeof e.lastPassAtMs === 'number' ? e.lastPassAtMs : null,
      evaluations: typeof e.evaluations === 'number' ? e.evaluations : 0,
      passes: typeof e.passes === 'number' ? e.passes : 0,
      ...(typeof e.filedItemId === 'string' ? { filedItemId: e.filedItemId } : {}),
      ...(typeof e.filedAtMs === 'number' ? { filedAtMs: e.filedAtMs } : {}),
      ...(typeof e.alarmTickMs === 'number' ? { alarmTickMs: e.alarmTickMs } : {}),
    };
  }
  return {
    evaluatedAtMs: r.evaluatedAtMs,
    lastEmittedAtMs: typeof r.lastEmittedAtMs === 'number' ? r.lastEmittedAtMs : 0,
    invariants,
  };
}

/** PURE: fold one evaluation into the stored state; report transitions and whether to emit. */
export function foldGateInvariants(
  prev: GateInvariantsState | null,
  results: readonly GateInvariantResult[],
  nowMs: number,
  alarmTickMs?: number,
): { next: GateInvariantsState; transitions: GateInvariantTransition[]; emit: boolean } {
  const invariants: GateInvariantsState['invariants'] = {};
  const transitions: GateInvariantTransition[] = [];
  for (const r of results) {
    const before = prev?.invariants[r.name];
    const changed = !before || before.status !== r.status;
    if (changed) transitions.push({ name: r.name, from: before?.status ?? null, to: r.status });
    invariants[r.name] = {
      status: r.status,
      observed: r.observed,
      sinceMs: changed ? nowMs : (before as GateInvariantEntryState).sinceMs,
      lastPassAtMs: r.status === 'pass' ? nowMs : (before?.lastPassAtMs ?? null),
      evaluations: (before?.evaluations ?? 0) + 1,
      passes: (before?.passes ?? 0) + (r.status === 'pass' ? 1 : 0),
      ...(!changed && before?.filedItemId ? { filedItemId: before.filedItemId } : {}),
      ...(!changed && before?.filedAtMs !== undefined ? { filedAtMs: before.filedAtMs } : {}),
      ...(r.status === 'breach' && (changed ? alarmTickMs !== undefined : before?.alarmTickMs !== undefined)
        ? { alarmTickMs: changed ? alarmTickMs : before!.alarmTickMs } : {}),
    };
  }
  const emit = transitions.length > 0 || !prev || nowMs - prev.lastEmittedAtMs >= GATE_INVARIANT_HEARTBEAT_MS;
  return {
    next: { evaluatedAtMs: nowMs, lastEmittedAtMs: emit ? nowMs : (prev?.lastEmittedAtMs ?? 0), invariants },
    transitions,
    emit,
  };
}

export function overallGateInvariantStatus(results: readonly GateInvariantResult[]): GateInvariantStatus {
  if (results.some((r) => r.status === 'breach')) return 'breach';
  if (results.some((r) => r.status === 'unknown')) return 'unknown';
  return 'pass';
}

export function gateInvariantConditionKey(installSlug: string, name: GateInvariantName): string {
  return `gate-invariant:${installSlug}:${name}`;
}

// ─── live wiring ────────────────────────────────────────────────────────────────────────────────

export type GitRead = (args: string[]) => Promise<string>;

/** Resolve the executor's gate-code drift. Every failure degrades to null, never to "no drift". */
export async function resolveGateExecutorDrift(
  treeSha: string | null,
  git: GitRead,
): Promise<Pick<GateExecutorEvidence, 'driftPaths' | 'oldestDriftCommitMs'>> {
  const unresolved = { driftPaths: null, oldestDriftCommitMs: null };
  if (!treeSha || !/^[0-9a-f]{7,64}$/i.test(treeSha)) return unresolved;
  try {
    const boot = String(await git(['rev-parse', '--verify', `${treeSha}^{commit}`])).trim();
    const head = String(await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!/^[0-9a-f]{40}$/.test(boot) || !/^[0-9a-f]{40}$/.test(head)) return unresolved;
    if (boot === head) return { driftPaths: [], oldestDriftCommitMs: null };
    const diff = String(await git(['diff', '--name-only', '--no-renames', `${boot}..${head}`, '--', ...GATE_CODE_PREFIXES]));
    const driftPaths = diff
      .split('\n')
      .map((l) => l.trim())
      .filter((p) => p.length > 0 && !p.endsWith('.test.ts'));
    if (driftPaths.length === 0) return { driftPaths, oldestDriftCommitMs: null };
    const times = String(await git(['log', '--format=%ct', `${boot}..${head}`, '--', ...driftPaths]))
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { driftPaths, oldestDriftCommitMs: times.length > 0 ? Math.min(...times) * 1000 : null };
  } catch {
    return unresolved;
  }
}

export interface GateInvariantReadDeps {
  sql: Sql;
  workspaceId: string;
  installSlug: string;
  nowMs: number;
  thresholds: GateInvariantThresholds;
  readQueue: () => Promise<{ status: 'value'; queue: FrozenCandidateRepairQueue } | { status: 'absent' } | { status: 'unreadable' }>;
  fixerAlive: (spawnId: string) => Promise<boolean | null>;
  git: GitRead;
}

export async function readGateInvariantSnapshot(deps: GateInvariantReadDeps): Promise<GateInvariantSnapshot> {
  const { sql, workspaceId, installSlug, nowMs } = deps;
  const read = await deps.readQueue().catch(() => ({ status: 'unreadable' as const }));
  const queue = read.status === 'value' ? read.queue : null;
  const fixerAlive = queue?.fixerSpawnId ? await deps.fixerAlive(queue.fixerSpawnId).catch(() => null) : null;

  const fires = await sql<{ at: Date | string; tree: string | null }[]>`
    SELECT created_at AS at, detail->'vintage'->>'treeSha' AS tree
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND kind = 'green_checkpoint_fire'
     ORDER BY created_at DESC
     LIMIT 13`.catch(() => null);
  const fireMs = (fires ?? []).map((f) => new Date(f.at).getTime());
  const fireIntervalsMs = fireMs.slice(1).map((t, i) => (fireMs[i] as number) - t);

  const since = new Date(nowMs - deps.thresholds.noVerdictWindowMs);
  const outcomes = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.pipeline_events
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND kind = 'green_checkpoint'
       AND created_at > ${since}`.catch(() => null);

  // Ended fixers only: a running row has no outcome yet. Scoped to this install's harness, so a
  // sibling pot's fixer deaths never page this gate.
  const fixerSince = new Date(nowMs - deps.thresholds.fixerOutcomeWindowMs);
  const fixerRows = await sql<{ status: string; reason: string | null }[]>`
    SELECT status, COALESCE(error_message, cancel_reason) AS reason
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug} AND child_role = 'release-fixer'
       AND status NOT IN ('running', 'restarting')
       AND COALESCE(finished_at, started_at) > ${fixerSince}`.catch(() => null);

  let executor: GateExecutorEvidence | null = null;
  if (fires && fires.length > 0) {
    const treeSha = fires[0]?.tree ?? null;
    executor = { treeSha, ...(await resolveGateExecutorDrift(treeSha, deps.git)) };
  } else if (fires === null) {
    executor = { treeSha: null, driftPaths: null, oldestDriftCommitMs: null };
  }

  return {
    nowMs,
    queueReadable: read.status !== 'unreadable',
    queue,
    fixerAlive,
    fireIntervalsMs,
    checkpointStatuses: outcomes ? outcomes.map((o) => o.status) : null,
    executor,
    fixerOutcomes: fixerRows ? fixerRows.map((r) => ({ status: r.status, reason: r.reason })) : null,
  };
}

export interface RecordGateInvariantsResult {
  recorded: boolean;
  transitions: GateInvariantTransition[];
  emitted: boolean;
  filed: { name: GateInvariantName; id: string }[];
}

export interface RecordGateInvariantsDeps {
  sql: Sql;
  workspaceId: string;
  installSlug: string;
  nowMs: number;
  results: readonly GateInvariantResult[];
  /** Freeze this evaluation's measured tick only for a newly observed breach. */
  alarmTickMs?: number;
  /** Read after each awaited filing; the earlier nowMs is not a delivery receipt. */
  clockMs?: () => number;
  /** Required append on the supplied transaction: failure must roll back its evaluation lease. */
  appendEvent: (status: GateInvariantStatus, detail: Record<string, unknown>, transactionSql: Sql) => Promise<void>;
  fileBreach: (result: GateInvariantResult) => Promise<string | null>;
}

/**
 * Persist one evaluation. The state read, lease check and write share one transaction with the
 * routine row locked, so two hosts ticking together produce one evaluation, not two.
 */
export async function recordGateLiveInvariants(deps: RecordGateInvariantsDeps): Promise<RecordGateInvariantsResult> {
  const { sql, workspaceId, installSlug, nowMs, results } = deps;
  const folded = await sql.begin(async (tx) => {
    const rows = await tx<{ state: unknown }[]>`
      SELECT metadata->${GATE_INVARIANTS_METADATA_KEY} AS state
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'
       FOR UPDATE`;
    if (rows.length === 0) return null;
    const prev = parseGateInvariantsState(rows[0]?.state);
    if (prev && nowMs - prev.evaluatedAtMs < GATE_INVARIANT_LEASE_MS) return null;
    const out = foldGateInvariants(prev, results, nowMs, deps.alarmTickMs);
    if (out.emit) {
      await deps.appendEvent(overallGateInvariantStatus(results), {
        evaluatedAtMs: nowMs,
        results: results.map((r) => ({ name: r.name, status: r.status, observed: r.observed })),
        transitions: out.transitions,
        alarmEpisodes: originalAlarmEpisodes(out.next),
      }, tx as unknown as Sql);
    }
    await tx`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${[GATE_INVARIANTS_METADATA_KEY]}, ${tx.json(out.next as never)})
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'`;
    return out;
  });
  if (!folded) return { recorded: false, transitions: [], emitted: false, filed: [] };

  const filed: { name: GateInvariantName; id: string }[] = [];
  const filedClocks = new Map<GateInvariantName, number>();
  for (const result of results) {
    // The state transition is committed before filing. A failed condition
    // upsert must remain eligible when the next tick sees the same breach.
    if (result.status !== 'breach' || folded.next.invariants[result.name]?.filedItemId) continue;
    const id = await deps.fileBreach(result).catch(() => null);
    if (id) {
      filed.push({ name: result.name, id });
      filedClocks.set(result.name, (deps.clockMs ?? Date.now)());
    }
  }
  let emitted = folded.emit;
  if (filed.length > 0) {
    // The condition upsert is outside the lease transaction. Store its receipt
    // with history atomically, only while this evaluation is still current.
    // If it fails, the next eligible tick retries through the same condition key.
    folded.next.lastEmittedAtMs = nowMs;
    for (const f of filed) {
      const entry = folded.next.invariants[f.name];
      if (entry) {
        entry.filedItemId = f.id;
        entry.filedAtMs = filedClocks.get(f.name);
      }
    }
    const receiptEmitted = await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${[GATE_INVARIANTS_METADATA_KEY]}, ${tx.json(folded.next as never)})
         WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'
           AND (metadata->${GATE_INVARIANTS_METADATA_KEY}->>'evaluatedAtMs')::bigint = ${nowMs}
         RETURNING name`;
      if (!rows.length) return false;
      await deps.appendEvent(overallGateInvariantStatus(results), {
        evaluatedAtMs: nowMs,
        results: results.map((r) => ({ name: r.name, status: r.status, observed: r.observed })),
        transitions: folded.transitions,
        filed,
        alarmEpisodes: originalAlarmEpisodes(folded.next),
      }, tx as unknown as Sql);
      return true;
    });
    emitted ||= receiptEmitted;
  }
  return { recorded: true, transitions: folded.transitions, emitted, filed };
}

const WATCHDOG_ACTOR = 'system-watchdog';

/** The production pass, wired into `startGreenStallWatchdog` beside `checkIdleRepairQueue`. */
export async function checkGateLiveInvariants(
  sql: Sql,
  opts: { installSlug?: string; nowMs?: () => number; thresholds?: GateInvariantThresholds } = {},
): Promise<RecordGateInvariantsResult | null> {
  const installSlug = opts.installSlug ?? 'papercusp';
  const thresholds = opts.thresholds ?? DEFAULT_GATE_INVARIANT_THRESHOLDS;
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = rows[0]?.workspace_id as string;
    const nowMs = (opts.nowMs ?? Date.now)();

    const { readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const { releaseFixerSpawnAlive } = await import('./fixer-liveness');
    const { gitReadViaSidecar } = await import('../dbos/process-boot-identity');
    const { appendPipelineEvent } = await import('../harness/git-sync/pipeline-events');
    const { upsertConditionWorkItem } = await import('../coord/condition-upsert');

    const snapshot = await readGateInvariantSnapshot({
      sql,
      workspaceId,
      installSlug,
      nowMs,
      thresholds,
      readQueue: () => readFrozenCandidateRepairQueueState({ workspaceId, installSlug }),
      fixerAlive: (spawnId) => releaseFixerSpawnAlive(sql as never, spawnId),
      git: gitReadViaSidecar,
    });
    const results = evaluateGateLiveInvariants(snapshot, thresholds);
    return await recordGateLiveInvariants({
      sql,
      workspaceId,
      installSlug,
      nowMs,
      results,
      // The live evaluator can use its documented default, but historical
      // acceptance cannot present that fallback as an observed cadence.
      alarmTickMs: snapshot.fireIntervalsMs.filter(interval => Number.isFinite(interval) && interval > 0).length >= 2
        ? measuredTickMs(snapshot, thresholds) : undefined,
      clockMs: opts.nowMs ?? Date.now,
      appendEvent: (status, detail, transactionSql) =>
        appendPipelineEvent({ workspaceId, installSlug, kind: 'gate_invariants', status, detail }, transactionSql, { required: true }),
      fileBreach: async (r) => {
        const res = await upsertConditionWorkItem(gateInvariantConditionKey(installSlug, r.name), {
          kind: 'bug',
          title: `Gate live invariant breached on ${installSlug}: ${r.name}`,
          summary:
            `${r.observed}\n\nFiled by the standing gate invariant check (plan green-main-cycle-time-2026-10-08 P-018, ` +
            `packages/operator-core/lib/release/gate-live-invariants.ts). Current state of every invariant: ` +
            `routines(name='green-checkpoint').metadata.${GATE_INVARIANTS_METADATA_KEY}; history: pipeline_events kind='gate_invariants'.`,
          severity: 'major',
          harness: installSlug,
          workspaceId,
          createdBy: WATCHDOG_ACTOR,
          payload: { source: 'gate-live-invariants', invariant: r.name, observed: r.observed },
        });
        return res.id ?? null;
      },
    });
  } catch (err) {
    passError = err;
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'gate-live-invariants', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}
