import { join } from 'node:path';
import type { CommandInstrument, InstrumentParseContext } from '../../rubric-instrument-registry';

export const LIVE_FORKSERVER_INSTRUMENT_KEY = 'sidecar:live-fork-offload-check';

function hasTraceCoverage(trace: Record<string, any>): boolean {
  const c = trace.coverage;
  return c?.attachedThroughWindow === true && c.aliveAtWindowEnd === true
    && typeof c.tracerIdentityAtStart === 'string' && /^[1-9]\d*:\d+$/.test(c.tracerIdentityAtStart)
    && c.tracerIdentityAtEnd === c.tracerIdentityAtStart
    && (c.exitCode === 0 || (c.stopRequested === true && c.exitCode === -2));
}

function hasGitSyncProgress(result: Record<string, any>): boolean {
  const before = result.gitSyncWitness?.before;
  const after = result.gitSyncWitness?.after;
  if (!before || !after || before.marker !== 'PAPERCUSP_GIT_SYNC_PUSH=1'
    || after.marker !== before.marker || !Number.isSafeInteger(before.pid) || before.pid <= 0
    || before.pid !== after.pid || before.parentPid !== after.parentPid
    || !Array.isArray(result.runtime?.forkserverPids) || !result.runtime.forkserverPids.includes(before.parentPid)
    || typeof before.startTicks !== 'string' || !/^\d+$/.test(before.startTicks)
    || before.startTicks !== after.startTicks || !Number.isFinite(before.atWindowSeconds)
    || !Number.isFinite(after.atWindowSeconds) || before.atWindowSeconds < 0
    || after.atWindowSeconds <= before.atWindowSeconds || after.atWindowSeconds > result.windowSeconds) return false;
  const counters = ['cpuTicks', 'rchar', 'wchar', 'syscr', 'syscw'];
  return counters.every(key => Number.isSafeInteger(before[key]) && before[key] >= 0
    && Number.isSafeInteger(after[key]) && after[key] >= before[key])
    && counters.some(key => after[key] > before[key]);
}

/** The command performs a fresh trace; missing activity or permission is unknown. */
export function parseLiveForkserverCheck(stdout: string, context: InstrumentParseContext): number | null {
  try {
    const result = JSON.parse(stdout);
    const required = ['stable-live-runtime', 'trace-instrument-available', 'forkserver-positive-control',
      'git-sync-overlap-progress', 'sidecar-no-child-forks', 'sidecar-fork-and-read-budget'];
    if (result.kind !== 'operational-test-evidence' || !Array.isArray(result.assertions)
      || !Array.isArray(result.traces) || !Number.isFinite(result.sidecarBlockedPercent)
      || result.sidecarBlockedPercent < 0 || !Number.isFinite(result.windowSeconds)
      // The contract is three seconds; allow only 100 ms of scheduling overrun.
      || result.windowSeconds < 3 || result.windowSeconds > 3.1
      || result.traces.length === 0 || !result.traces.every(hasTraceCoverage)) return null;
    const finished = Date.parse(result.finishedAt);
    if (!Number.isFinite(finished) || context.now < finished || context.now - finished > 30_000) return null;
    const assertions = new Map<string, boolean>();
    for (const assertion of result.assertions) {
      if (typeof assertion.id !== 'string' || typeof assertion.passed !== 'boolean'
        || assertions.has(assertion.id)) return null;
      assertions.set(assertion.id, assertion.passed);
    }
    if (required.some(key => !assertions.has(key))) return null;
    if (required.slice(0, 4).some(key => assertions.get(key) !== true) || !hasGitSyncProgress(result)) return null;
    const sidecar = result.traces.find((trace: { label?: string }) => trace.label === 'sidecar');
    if (!sidecar || !Number.isFinite(sidecar.forkCallCount) || !Number.isFinite(sidecar.forkSeconds)
      || !Number.isFinite(sidecar.readSeconds) || sidecar.unmeasuredCallCount !== 0) return null;
    const percent = 100 * (sidecar.forkSeconds + sidecar.readSeconds) / result.windowSeconds;
    if (!Number.isFinite(percent) || percent < 0 || Math.abs(percent - result.sidecarBlockedPercent) > 1e-9) return null;
    return sidecar.forkCallCount === 0 && percent < 5
      && required.every(key => assertions.get(key) === true) ? 1 : 0;
  } catch { return null; }
}

export function liveForkserverInstrument(root: string): CommandInstrument {
  return {
    key: LIVE_FORKSERVER_INSTRUMENT_KEY, evaluator: 'command', unit: 'count',
    description: 'Fresh live bg-host trace during verified marked git-sync child progress: stable runtime and active forkserver; sidecar makes zero forks and spends under5% in fork plus all reads (a conservative exec-wait bound).',
    argv: ['python3', join(root, 'docs/evidence/sidecar-forkserver-live-probe.py')],
    timeoutMs: 20_000, acceptNonZeroExit: true, parse: parseLiveForkserverCheck,
  };
}
