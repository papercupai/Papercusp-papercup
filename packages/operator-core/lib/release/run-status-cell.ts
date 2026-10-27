/* ══════════════════════════════════════════════════════════════════════════════
 * gate.greenCheckpoint.run — IS THE GATE RUN ALIVE, AND WHAT IS IT DOING RIGHT NOW?
 * WI-6554700010029556 (owner directive #2439: "can we make our system clearer so that
 * agents can easily know the status of the gate runs?").
 *
 * ## The measured gap this closes
 *
 * Every fact this cell reports was already computed — `gate.checkpointRunInFlight`
 * carries liveness, its source, timings, the heartbeat, the published phase, and (since
 * step 1 of this item) the activity and leg in flight; `certifyCheckpointProgress` turns
 * the heartbeat into a progressing / stalled / unknown verdict. What did NOT exist was
 * ONE read that put them together. On 2026-10-26 a gate-lane holder could not tell whether
 * a 2h-old run was alive, and the answer ("alive, past its tests, on its lint legs") had
 * to be assembled by hand from `proc-guard`, `pipeline_events` SQL and a raw leg read.
 *
 * ## What this module is, and is not
 *
 * PURE projection. It re-reads nothing, and it does NOT introduce a second stall rule: the
 * verdict is `certifyCheckpointProgress`'s, verbatim, so this cell and every other
 * consumer of that certificate cannot disagree about whether a run is wedged. In
 * particular the D-003 trap (`progressAtMs === startedAtMs` is "never measured" as often
 * as it is "just started") stays `progress-unknown` here, never `stalled`.
 *
 * ## PID liveness
 *
 * `pid` is emitted only when a LIVE authority answered (`activeSource` present): the run
 * lock is `kill(pid,0)`-verified at read time and the process-authority reading is
 * identified from the process's own environment and cgroup. `pidVerified` says which
 * case you are in. A cache-only reading carries no pid on purpose — a pid from a snapshot
 * of unbounded age can name a recycled process (PID wrap happens ~daily on this host).
 * ══════════════════════════════════════════════════════════════════════════════ */

import { certifyCheckpointProgress, type ProgressBasis, type ProgressVerdict } from '../release-trace-progress';

/**
 * The subset of `gate.checkpointRunInFlight` this projection reads, declared STRUCTURALLY
 * (same reason as `RetriageRunReading`: `git-pipeline-position` imports this module, so
 * importing its type back would close a cycle). `mapCheckpointRunInFlight`'s return type
 * is assignable to it.
 */
export interface RunStatusReading {
  active: boolean;
  activeSource?: 'run-lock' | 'process-authority';
  /** Verified pid — present only when a live authority answered. */
  pid?: number;
  candidate?: string | null;
  candidateSource?: 'retriage-marker' | 'in-flight-candidate' | 'run-probe';
  startedAtMs?: number | null;
  elapsedSec?: number | null;
  progressAtMs?: number | null;
  verdictWrittenAtMs?: number | null;
  currentPhase?: string | null;
  currentActivity?: string;
  currentLeg?: { label: string; index: number; total: number };
  inRetriageWindow?: true;
  asOfAgeMs?: number | null;
  /** systemd-owned terminal evidence for the most recent FINISHED MANUAL run (idle only). */
  terminalEvidence?: {
    observedAtMs?: number | null;
    serviceResult: string;
    exitStatus: string;
    abnormal: boolean;
  };
}

/** Assessment codes for `gate.greenCheckpoint.run`. */
export type RunStatusCellCode =
  /** Neither the run lock nor the cached reading answered. NOT "no run". */
  | 'no-run-reading'
  /** A measured negative: no checkpoint run is in flight. */
  | 'no-run'
  /** In flight, still deciding, heartbeat advancing within the stall threshold. */
  | 'running'
  /** In flight, verdict ALREADY published; the process continues into re-triage/salvage. */
  | 'decided-salvaging'
  /** A live authority sees the run, and its heartbeat has not advanced past the threshold. */
  | 'stalled'
  /** In flight, but whether it is advancing cannot be established from this reading. */
  | 'progress-unknown';

/** The shape `gate.greenCheckpoint.run` publishes. */
export interface RunStatusCellProjection {
  code: RunStatusCellCode;
  /** True when no run reading existed at all. Hoisted as the cell's unknown. */
  unmeasured: boolean;
  /** THE headline: is a gate run in flight right now? `null` = NOT MEASURED, never false. */
  active: boolean | null;
  /** Which live authority answered, or `null` when only the cache did. */
  activeSource: 'run-lock' | 'process-authority' | null;
  /** The run's pid — set only when `pidVerified` is true. */
  pid: number | null;
  /** True when `pid` came from a live, liveness-verified authority on THIS read. */
  pidVerified: boolean;
  /** The phase the run published (`currentPhase`). */
  phase: string | null;
  /** What it is doing inside that phase (`currentActivity`). */
  activity: string | null;
  /** The leg in flight, 1-based `index` of `total`. */
  leg: { label: string; index: number; total: number } | null;
  candidate: string | null;
  candidateSource: 'retriage-marker' | 'in-flight-candidate' | 'run-probe' | null;
  startedAtMs: number | null;
  elapsedSec: number | null;
  /** Last advancing heartbeat, and its age in seconds at read time. */
  progressAtMs: number | null;
  progressAgeSec: number | null;
  /** `certifyCheckpointProgress`'s certificate, verbatim in meaning. */
  progress: {
    verdict: ProgressVerdict;
    basis: ProgressBasis;
    detail: string;
    evidenceAgeMs: number | null;
  };
  /** When the active run published its verdict; `null` = still deciding OR unknown. */
  verdictWrittenAtMs: number | null;
  /** An auto-refire is in flight — read `gate.greenCheckpoint.retriage` before acting. */
  inRetriageWindow: boolean;
  /** Age of the cached reading behind this answer, in ms. */
  asOfAgeMs: number | null;
  /**
   * When NO run is in flight: how the most recent MANUAL run ended (systemd ExecStopPost
   * evidence). `null` when a run is in flight, or when no evidence was recorded. A cron
   * run writes no such evidence, so `null` here is not "the last run was healthy".
   */
  lastManualRun: { abnormal: boolean; serviceResult: string; exitStatus: string; observedAtMs: number | null } | null;
  /** One line, ready to quote to a human. */
  summary: string;
}

/** `7m`, `2h10m`, `45s` — the form a human quotes. */
export function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

/**
 * PURE: the assessment code. Split out so the truth table in
 * `cell-assessment-reality.test.ts` exercises the same function the projection does.
 */
export function assessRunStatus(run: RunStatusReading | null | undefined, nowMs: number): RunStatusCellCode {
  if (run == null) return 'no-run-reading';
  if (run.active !== true) return 'no-run';
  const cert = certifyCheckpointProgress(run, nowMs);
  if (cert.basis === 'verdict-published') return 'decided-salvaging';
  if (cert.verdict === 'progressing') return 'running';
  if (cert.verdict === 'stalled') return 'stalled';
  return 'progress-unknown';
}

function describeWhere(p: Pick<RunStatusCellProjection, 'phase' | 'activity' | 'leg'>): string {
  const parts: string[] = [];
  if (p.phase) parts.push(`phase ${p.phase}`);
  if (p.activity) parts.push(p.activity);
  if (p.leg) parts.push(`leg ${p.leg.index}/${p.leg.total} ${p.leg.label}`);
  return parts.length > 0 ? parts.join(', ') : 'no phase published';
}

/**
 * PURE: project the run reading into the shape `gate.greenCheckpoint.run` publishes.
 *
 * Emitted UNCONDITIONALLY — an unmeasured reading yields `code: 'no-run-reading'` with null
 * fields, never a bare `null` in place of the object (the cell contract requires the
 * declared assessment path to exist in every live payload).
 */
export function projectRunStatusCell(
  run: RunStatusReading | null | undefined,
  nowMs: number = Date.now(),
): RunStatusCellProjection {
  const code = assessRunStatus(run, nowMs);
  const cert = certifyCheckpointProgress(run ?? null, nowMs);
  const progress = {
    verdict: cert.verdict,
    basis: cert.basis,
    detail: cert.detail,
    evidenceAgeMs: cert.evidenceAgeMs,
  };
  if (code === 'no-run-reading' || run == null) {
    return {
      code: 'no-run-reading',
      unmeasured: true,
      active: null,
      activeSource: null,
      pid: null,
      pidVerified: false,
      phase: null,
      activity: null,
      leg: null,
      candidate: null,
      candidateSource: null,
      startedAtMs: null,
      elapsedSec: null,
      progressAtMs: null,
      progressAgeSec: null,
      progress,
      verdictWrittenAtMs: null,
      inRetriageWindow: false,
      asOfAgeMs: null,
      lastManualRun: null,
      summary:
        'Gate run status NOT MEASURED: neither the run lock nor the cached run reading answered. ' +
        'This is NOT "no run in flight". Do not fire release:checkpoint-run on this reading.',
    };
  }
  const activeSource = run.activeSource ?? null;
  const pidVerified = activeSource !== null && typeof run.pid === 'number';
  const pid = pidVerified ? (run.pid as number) : null;
  const asOfAgeMs = typeof run.asOfAgeMs === 'number' ? run.asOfAgeMs : null;
  if (code === 'no-run') {
    const te = run.terminalEvidence;
    const lastManualRun = te
      ? {
          abnormal: te.abnormal === true,
          serviceResult: te.serviceResult,
          exitStatus: te.exitStatus,
          observedAtMs: typeof te.observedAtMs === 'number' ? te.observedAtMs : null,
        }
      : null;
    const lastNote = lastManualRun
      ? ` The most recent manual run ended ${lastManualRun.abnormal ? 'ABNORMALLY' : 'normally'} (${lastManualRun.serviceResult}, exit status ${lastManualRun.exitStatus}` +
        (lastManualRun.observedAtMs === null ? ').' : `, ${formatDurationSec((nowMs - lastManualRun.observedAtMs) / 1000)} ago).`)
      : '';
    return {
      code,
      unmeasured: false,
      active: false,
      activeSource,
      pid: null,
      pidVerified: false,
      phase: null,
      activity: null,
      leg: null,
      candidate: null,
      candidateSource: null,
      startedAtMs: null,
      elapsedSec: null,
      progressAtMs: null,
      progressAgeSec: null,
      progress,
      verdictWrittenAtMs: null,
      inRetriageWindow: false,
      asOfAgeMs,
      lastManualRun,
      summary:
        (activeSource !== null
          ? 'No gate run is in flight (the live run lock says so on this read).'
          : `No gate run is in flight, per a cached reading ${asOfAgeMs === null ? 'of unknown age' : `${formatDurationSec(asOfAgeMs / 1000)} old`}.`) +
        lastNote,
    };
  }
  const phase = run.currentPhase ?? null;
  const activity = run.currentActivity ?? null;
  const leg = run.currentLeg ? { ...run.currentLeg } : null;
  const startedAtMs = typeof run.startedAtMs === 'number' ? run.startedAtMs : null;
  const elapsedSec = typeof run.elapsedSec === 'number' ? run.elapsedSec : null;
  const progressAtMs = typeof run.progressAtMs === 'number' ? run.progressAtMs : null;
  const progressAgeSec = progressAtMs === null ? null : Math.max(0, Math.round((nowMs - progressAtMs) / 1000));
  const verdictWrittenAtMs = typeof run.verdictWrittenAtMs === 'number' ? run.verdictWrittenAtMs : null;
  const inRetriageWindow = run.inRetriageWindow === true;
  const candidate = run.candidate ?? null;
  const where = describeWhere({ phase, activity, leg });
  const alive = pidVerified
    ? `ALIVE (pid ${pid}, verified by ${activeSource})`
    : activeSource !== null
      ? `ALIVE (verified by ${activeSource}; pid not reported)`
      : `active per a cached reading ${asOfAgeMs === null ? 'of unknown age' : `${formatDurationSec(asOfAgeMs / 1000)} old`} (liveness not verified on this read)`;
  const elapsed = elapsedSec === null ? '' : `, ${formatDurationSec(elapsedSec)} in`;
  const judging = candidate ? `, judging ${candidate.slice(0, 12)}` : '';
  const heartbeat = progressAgeSec === null ? 'no heartbeat recorded' : `last progress ${formatDurationSec(progressAgeSec)} ago`;
  const retriageNote = inRetriageWindow ? ' An auto-refire is in flight: read gate.greenCheckpoint.retriage before any manual run.' : '';
  const head = `Gate run ${alive}${elapsed}${judging}: ${where}; ${heartbeat}.`;
  const tail =
    code === 'running'
      ? ' Advancing — let it reach a verdict.'
      : code === 'decided-salvaging'
        ? ` Verdict already published ${formatDurationSec((nowMs - (verdictWrittenAtMs ?? nowMs)) / 1000)} ago; it is continuing into re-triage/salvage, which is expected, not a wedge.`
        : code === 'stalled'
          ? ' STALLED: no progress past the stall threshold although the process is alive. Diagnose the run (its leg, its log) before anything else; never fire a second run beside it.'
          : ` Progress could not be established (${cert.basis}); this is not evidence of a stall.`;
  return {
    code,
    unmeasured: false,
    active: true,
    activeSource,
    pid,
    pidVerified,
    phase,
    activity,
    leg,
    candidate,
    candidateSource: run.candidateSource ?? null,
    startedAtMs,
    elapsedSec,
    progressAtMs,
    progressAgeSec,
    progress,
    verdictWrittenAtMs,
    inRetriageWindow,
    asOfAgeMs,
    lastManualRun: null,
    summary: head + tail + retriageNote,
  };
}
