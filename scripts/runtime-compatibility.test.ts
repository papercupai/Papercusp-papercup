import { describe, expect, it } from 'vitest';
import { evaluateCapability } from './lib/runtime-compatibility.mjs';

const runtime = { name: 'node', version: '25.9.0', executable: '/pinned/node',
  binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64' };
const candidate = { sourceSha: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64),
  configurationSha256: 'd'.repeat(64), dependencyGeneration: 'native-node25-1' };
const request = { capabilityId: 'sqlite-roundtrip', expected: { rows: [42] }, runtime, candidate };
const observation = () => ({ nonce: 'challenge', pid: 123, exitCode: 0, signal: null, timedOut: false,
  overflow: false, binarySha256: runtime.binarySha256, receipts: [{ nonce: 'challenge', pid: 123,
    capabilityId: request.capabilityId, completed: true, runtime: { ...runtime }, actual: { rows: [42] } }] });

describe('semantic compatibility report admission', () => {
  it('admits the completed operation with its complete candidate and runtime identity', () => {
    expect(evaluateCapability(request, observation())).toMatchObject({ status: 'passed', reasons: [], candidate, runtime });
  });
  it('rejects an import-only or premature-zero exit', () => {
    expect(evaluateCapability(request, { ...observation(), receipts: [] })).toMatchObject({
      status: 'failed', reasons: ['missing-or-duplicate-completion'],
    });
  });
  it('rejects a wrong result and duplicate completion', () => {
    const wrong = observation(); wrong.receipts[0].actual.rows = [41];
    expect(evaluateCapability(request, wrong).reasons).toContain('incorrect-result');
    const duplicate = observation(); duplicate.receipts.push(duplicate.receipts[0]);
    expect(evaluateCapability(request, duplicate).reasons).toContain('missing-or-duplicate-completion');
  });
  it.each(['name', 'version', 'executable', 'binarySha256', 'platform', 'arch'])('rejects changed interpreter %s', (field) => {
    const wrong = observation(); Object.assign(wrong.receipts[0].runtime, { [field]: 'different' });
    expect(evaluateCapability(request, wrong).reasons).toContain('wrong-interpreter');
  });
  it.each(['nonce', 'pid', 'capabilityId', 'completed'])('rejects mismatched completion %s', (field) => {
    const wrong = observation(); Object.assign(wrong.receipts[0], { [field]: null });
    expect(evaluateCapability(request, wrong).reasons).toContain('completion-identity');
  });
  it('rejects late throws, timeouts, output overflow and binary replacement even with a valid result', () => {
    for (const change of [{ exitCode: 1 }, { signal: 'SIGTERM' }, { timedOut: true },
      { overflow: true }, { binarySha256: 'e'.repeat(64) }, { error: 'spawn:ENOENT' }]) {
      expect(evaluateCapability(request, { ...observation(), ...change }).status).toBe('failed');
    }
  });
  it.each(['sourceSha', 'lockfileSha256', 'configurationSha256', 'dependencyGeneration'])('refuses missing candidate %s', (field) => {
    expect(() => evaluateCapability({ ...request, candidate: { ...candidate, [field]: '' } }, observation())).toThrow(/pinned/);
  });
  it('refuses an unknown interpreter', () => {
    expect(() => evaluateCapability({ ...request, runtime: { ...runtime, name: 'unknown' } }, observation())).toThrow(/runtime identity/);
  });
});
