import { join } from 'node:path';
import type { CommandInstrument, InstrumentParseContext } from '../../rubric-instrument-registry';

export const LIVE_FORKSERVER_INSTRUMENT_KEY = 'sidecar:live-fork-offload-check';

/** The command performs a fresh trace; missing activity or permission is unknown. */
export function parseLiveForkserverCheck(stdout: string, context: InstrumentParseContext): number | null {
  try {
    const result = JSON.parse(stdout);
    const required = ['stable-live-runtime', 'trace-instrument-available', 'forkserver-positive-control',
      'sidecar-no-child-forks', 'sidecar-fork-and-read-budget'];
    if (result.kind !== 'operational-test-evidence' || !Array.isArray(result.assertions)
      || !Array.isArray(result.traces) || !Number.isFinite(result.sidecarBlockedPercent)
      || result.sidecarBlockedPercent < 0 || !Number.isFinite(result.windowSeconds)
      || result.windowSeconds < 3 || result.windowSeconds > 10) return null;
    const finished = Date.parse(result.finishedAt);
    if (!Number.isFinite(finished) || context.now < finished || context.now - finished > 30_000) return null;
    const assertions = new Map<string, boolean>();
    for (const assertion of result.assertions) {
      if (typeof assertion.id !== 'string' || typeof assertion.passed !== 'boolean'
        || assertions.has(assertion.id)) return null;
      assertions.set(assertion.id, assertion.passed);
    }
    if (required.some(key => !assertions.has(key))) return null;
    if (required.slice(0, 3).some(key => assertions.get(key) !== true)) return null;
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
    description: 'Fresh live bg-host trace: stable runtime and active forkserver; sidecar makes zero forks and spends under5% in fork plus all reads (a conservative exec-wait bound).',
    argv: ['python3', join(root, 'docs/evidence/sidecar-forkserver-live-probe.py')],
    timeoutMs: 20_000, acceptNonZeroExit: true, parse: parseLiveForkserverCheck,
  };
}
