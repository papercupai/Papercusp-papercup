/** isolatedWorkerFailureDetail must never let a harness-deadline kill masquerade
 * as the worker's own failure (WI-6554700010042656: a 180s execute deadline killed
 * the process group mid-import, tsx's esbuild service died with it, and the phase
 * detail reported only "TransformError: The service is no longer running"). */
import { describe, expect, it } from 'vitest';
import { isolatedWorkerFailureDetail, isolatedWorkerOptions } from './isolated-integration-proof';

const killedMidImport = [
  'NATIVE_INCIDENT_API_STAGE=handler-loaded',
  'NATIVE_INCIDENT_API_STAGE=import-start:fixture-stores',
  'Error [TransformError]: The service is no longer running',
  '    at sendRequest (node_modules/esbuild/lib/main.js:599:36)',
].join('\n');

describe('isolatedWorkerFailureDetail', () => {
  it('leads with the deadline, its phase and the last fixture stage when the harness ended the worker', () => {
    const detail = isolatedWorkerFailureDetail(killedMidImport,
      { timedOut: true, timeoutPhase: 'bootstrap', signal: 'SIGTERM' });
    const [first] = detail.split('\n');
    expect(first).toContain('ISOLATED_WORKER_DEADLINE phase=bootstrap signal=SIGTERM');
    expect(first).toContain('lastStage=NATIVE_INCIDENT_API_STAGE=import-start:fixture-stores');
    // The consequent error is kept, but only after the deadline that caused it.
    expect(detail.indexOf('TransformError')).toBeGreaterThan(detail.indexOf('ISOLATED_WORKER_DEADLINE'));
  });

  it('keeps structured *_FAILURE lines after the deadline header', () => {
    const detail = isolatedWorkerFailureDetail('NATIVE_REUSE_FAILURE {"reason":"x"}\nnoise',
      { timedOut: true, timeoutPhase: 'execute', signal: 'SIGTERM' });
    expect(detail.split('\n')).toEqual([
      expect.stringContaining('ISOLATED_WORKER_DEADLINE phase=execute signal=SIGTERM lastStage=none'),
      'NATIVE_REUSE_FAILURE {"reason":"x"}',
    ]);
  });

  it('is unchanged for a worker that failed on its own', () => {
    for (const capture of [undefined, { timedOut: false, timeoutPhase: null, signal: null }]) {
      const detail = isolatedWorkerFailureDetail(killedMidImport, capture);
      expect(detail).not.toContain('ISOLATED_WORKER_DEADLINE');
      expect(detail.startsWith('Error [TransformError]')).toBe(true);
    }
  });
});

describe('isolatedWorkerOptions', () => {
  it('gives bootstrap its own budget so PG boot never consumes the execute allowance', () => {
    const options = isolatedWorkerOptions(180_000, {});
    expect(options.phaseTimeouts.executeMs).toBe(180_000);
    expect(options.phaseTimeouts.bootstrapMs).toBeGreaterThan(0);
    expect(options.testTimeoutMs).toBeGreaterThan(options.phaseTimeouts.bootstrapMaxMs! + 180_000);
  });
});
