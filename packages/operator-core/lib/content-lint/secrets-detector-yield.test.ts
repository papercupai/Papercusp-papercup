/**
 * WI-6554700010008327 recurrence guard: the git-sync commit content guard's
 * `secrets` detector must hand the host's main thread back DURING a large file's
 * scan, not only between files.
 *
 * Measured cause: generated JSON in the tree reaches ~10 MB (bundle meta.json,
 * evidence matrices); one synchronous scanTextForSecrets took ~107 ms in isolation,
 * and on the saturated bg-host a sweep's scans were 51.6% of a 3.72 s event-loop
 * stall (stall-1791678116934-pid3358484.cpuprofile).
 *
 * The time slice is forced to 0 ms here so every check point yields. That makes the
 * assertion independent of machine speed: with the old synchronous scan, a macrotask
 * queued before detect() can only run AFTER detect() resolves, so the ordering
 * assertion below fails regardless of how fast the host is.
 *
 * Fixtures are assembled at runtime (see secrets.test.ts's header for why).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../event-loop-lag-monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../event-loop-lag-monitor')>();
  return {
    ...actual,
    createTimeSlice: (_sliceMs?: number, opts?: Parameters<typeof actual.createTimeSlice>[1]) =>
      actual.createTimeSlice(0, opts),
  };
});

import { secretsDetector, setContentLintExemptionLoader } from './registry';
import { findCommitBlockingSecrets } from './secrets';

const awsShape = (): string => 'AK' + 'IA' + 'QRSTUVWXYZ234567';
const bigText = (): string => `${'const clean = 1;\n'.repeat(4000)}const id = '${awsShape()}';\n`;

describe('secretsDetector yields inside one large file (WI-6554700010008327)', () => {
  afterEach(() => setContentLintExemptionLoader());

  it('control: the synchronous scan, awaited the same way, does NOT let the macrotask run first', async () => {
    // Calibrates the instrument: proves the ordering check below can fail, i.e. it
    // observes a non-yielding scan rather than passing for any implementation.
    const order: string[] = [];
    setImmediate(() => order.push('macrotask'));
    const findings = await (async () => findCommitBlockingSecrets('apps/operator/lib/big.ts', bigText(), new Set()))();
    order.push('detect-resolved');
    expect(order).toEqual(['detect-resolved']);
    expect(findings).toHaveLength(1);
  });

  it('lets a queued macrotask run before detect() resolves, and still reports the hit', async () => {
    setContentLintExemptionLoader(async () => new Set());
    const text = bigText();
    const order: string[] = [];
    setImmediate(() => order.push('macrotask'));
    const error = await secretsDetector.detect('apps/operator/lib/big.ts', text);
    order.push('detect-resolved');
    expect(order).toEqual(['macrotask', 'detect-resolved']);
    expect(error).toMatch(/aws-access-key-id/);
    expect(error).toMatch(/line 4001/);
  });
});
