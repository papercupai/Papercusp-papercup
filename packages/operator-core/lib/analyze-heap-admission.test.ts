import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeGovernedByteProcess } from '../../../scripts/lib/governed-test-process.mjs';
import { checkNativeHeapDecode, summarizeHeapRetainers } from '../../../scripts/analyze-heap-snapshots.mjs';

vi.mock('../../../scripts/lib/governed-test-process.mjs', () => ({ executeGovernedByteProcess: vi.fn() }));

const bytes = Buffer.from('private fixture bytes');
const executable = process.execPath;
const success = { status: 0, signal: null, error: undefined, stdout: '', stderr: '', actualDemand: {} };
beforeEach(() => { vi.mocked(executeGovernedByteProcess).mockReset(); });

describe('heap analyzer admission routes', () => {
  it('routes retainer analysis through the bounded admitted byte process', async () => {
    const report = { upstreamRevision: '05edd8131a77790ab0e7bce2eedf5770d6bb83ae', groups: [] };
    vi.mocked(executeGovernedByteProcess).mockResolvedValue({ ...success, stdout: JSON.stringify(report) });
    const result = await summarizeHeapRetainers(bytes, { nativeExecutable: executable, objectIds: [3, 7] });
    expect(executeGovernedByteProcess).toHaveBeenCalledWith(executable, ['10', '3', '1', '32', '3,7'], bytes,
      { namespace: 'heap-retainer-analysis', timeoutMs: 120000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.native?.inputBytes).toBe(bytes.byteLength);
    expect(result.native?.executableSha256).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain('private fixture bytes');
    expect(readFileSync(executable).byteLength).toBeGreaterThan(0);
  });

  it('awaits the decoder control and persists only scalar diagnostics', async () => {
    vi.mocked(executeGovernedByteProcess).mockResolvedValue({ ...success, stdout: '[]\n', stderr: 'private fixture bytes' });
    const result = await checkNativeHeapDecode(bytes, executable);
    expect(executeGovernedByteProcess).toHaveBeenCalledWith(executable,
      ['-', '--no-retained', '--top', '0', '--format', 'json'], bytes,
      { namespace: 'heap-decode-control', timeoutMs: 60000, maxBuffer: 16 * 1024 });
    expect(result.decoded).toBe(true);
    expect(result.stderrBytes).toBe(21);
    expect(JSON.stringify(result)).not.toContain('private fixture bytes');
  });

  it('propagates refused admission rather than falling back to an unadmitted child', async () => {
    vi.mocked(executeGovernedByteProcess).mockRejectedValue(Error('admission refused'));
    await expect(summarizeHeapRetainers(bytes, { nativeExecutable: executable })).rejects.toThrow('admission refused');
    await expect(checkNativeHeapDecode(bytes, executable)).rejects.toThrow('admission refused');
    expect(executeGovernedByteProcess).toHaveBeenCalledTimes(2);
  });
});
