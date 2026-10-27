import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { evaluateCapability, evaluateInstalledArtifactMatrix, runtimeProofFingerprint,
  validRuntimeProofIdentity } from './lib/runtime-compatibility.mjs';
import type { HostRuntimePath, InstalledArtifactBinding, InstalledArtifactReceipt,
  InstallScenario } from './lib/runtime-compatibility.mjs';

const runtime = { name: 'node', version: '25.9.0', executable: '/pinned/node',
  binarySha256: 'a'.repeat(64), platform: 'linux', arch: 'x64' };
const candidate = { sourceSha: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64),
  configurationSha256: 'd'.repeat(64), dependencyGeneration: 'native-node25-1' };
const request = { capabilityId: 'sqlite-roundtrip', expected: { rows: [42] }, runtime, candidate };
const observation = () => ({ nonce: 'challenge', pid: 123, exitCode: 0, signal: null, timedOut: false,
  overflow: false, binarySha256: runtime.binarySha256, receipts: [{ nonce: 'challenge', pid: 123,
    capabilityId: request.capabilityId, completed: true, runtime: { ...runtime }, actual: { rows: [42] } }] });

describe('complete runtime proof fingerprint', () => {
  const identity = { ...runtime, nativeDependencyGeneration: '1'.repeat(64),
    lockfileSha256: '2'.repeat(64), configurationSha256: '3'.repeat(64) };
  it('is independent of object insertion order and unrelated diagnostic fields', () => {
    const reordered = Object.fromEntries(Object.entries(identity).reverse());
    expect(runtimeProofFingerprint({ ...reordered, pid: 42 })).toBe(runtimeProofFingerprint(identity));
    expect(runtimeProofFingerprint(identity)).toMatch(/^runtime-v1 [a-f0-9]{64}$/);
  });
  it.each(Object.keys(identity))('invalidates a proof when %s changes or disappears', (key) => {
    const changed = { ...identity, [key]: key.endsWith('Sha256') || key === 'nativeDependencyGeneration'
      ? '9'.repeat(64) : key === 'executable' ? '/other/runtime' : key === 'name' ? 'bun' : 'different' };
    expect(runtimeProofFingerprint(changed)).not.toBe(runtimeProofFingerprint(identity));
    expect(runtimeProofFingerprint({ ...identity, [key]: undefined })).toBeNull();
  });
  it('rejects a Node-compatible version string without an actual interpreter and generation', () => {
    expect(runtimeProofFingerprint(`${process.version} ${process.platform} ${process.arch}`)).toBeNull();
    expect(validRuntimeProofIdentity({ ...identity, name: 'unknown' })).toBe(false);
  });
});

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

describe('installed artifact matrix admission', () => {
  // Synthetic controls only. A green detector suite is never installed evidence.
  const scope = ['gui:linux-arm64', 'gui:linux-x86_64', 'gui:macos-arm64',
    'gui:macos-x86_64', 'gui:windows-x86_64', 'server:linux-arm64',
    'server:linux-x86_64', 'server:macos-arm64', 'server:macos-x86_64', 'server:windows-x86_64'];
  const scenarios: InstallScenario[] = ['clean-install', 'upgrade', 'restart', 'node-rollback'];
  const pathCases: HostRuntimePath[] = ['absent', 'poisoned'];
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  function fixture() {
    const bindings: InstalledArtifactBinding[] = scope.map((cellId) => {
      const windows = cellId.includes(':windows-');
      const platform = windows ? 'win32' : cellId.includes(':macos-') ? 'darwin' : 'linux';
      const executable = (name: string) => windows ? `C:\\installed\\${cellId.split(':')[0]}\\${name}.exe`
        : `/installed/${cellId}/${name}`;
      const measured = { ...runtime, platform, arch: cellId.endsWith('-arm64') ? 'arm64' : 'x64' };
      return { cellId, installerSha256: hash(`${cellId}:installer`), artifactSha256: hash(`${cellId}:artifact`),
        previousArtifactSha256: hash(`${cellId}:previous`), runtimeRegistrationId: `candidate:${cellId}`,
        runtimeClosureRoot: windows ? `C:\\installed\\${cellId.split(':')[0]}` : `/installed/${cellId}`,
        candidate: { ...candidate, dependencyGeneration: hash(`${cellId}:native`) },
        runtime: { ...measured, name: 'bun', version: '1.3.9', executable: executable('bun') },
        rollbackRuntime: { ...measured, executable: executable('node') },
        expected: Object.fromEntries(scenarios.map((scenario) => [scenario,
          { ready: true, workspaceSentinel: `${cellId}:${scenario}`, configPreserved: true }])) as InstalledArtifactBinding['expected'] };
    });
    const receipts: InstalledArtifactReceipt[] = bindings.flatMap((pin) => scenarios.flatMap((scenario) =>
      pathCases.map((hostRuntimePath) => {
        const selected = scenario === 'node-rollback' ? pin.rollbackRuntime : pin.runtime;
        const nonce = `${pin.cellId}:${scenario}:${hostRuntimePath}`;
        const actual = { cellId: pin.cellId, scenario, hostRuntimePath, offline: true,
          installerSha256: pin.installerSha256, artifactSha256: pin.artifactSha256,
          previousArtifactSha256: scenario === 'upgrade' ? pin.previousArtifactSha256 : null,
          candidate: { ...pin.candidate }, runtimeRegistrationId: pin.runtimeRegistrationId,
          runtimeClosureRoot: pin.runtimeClosureRoot,
          semantic: pin.expected[scenario] };
        return { cellId: pin.cellId, scenario, hostRuntimePath, observation: {
          nonce, pid: 123, exitCode: 0, signal: null, timedOut: false, overflow: false,
          binarySha256: selected.binarySha256, receipts: [{ nonce, pid: 123, completed: true,
            capabilityId: `installed:${pin.cellId}:${scenario}:${hostRuntimePath}`,
            runtime: { ...selected }, actual }] } };
      })));
    return { requiredScope: [...scope], bindings, receipts };
  }
  it('requires complete installed semantics for GUI/server, both architectures and Windows absolute paths', () => {
    const input = fixture();
    expect(input.receipts).toHaveLength(80);
    expect(evaluateInstalledArtifactMatrix(input)).toMatchObject({ status: 'passed', reasons: [],
      coverage: { population: scope, checked: scope, notChecked: [], notApplicable: [], residue: [] } });
  });
  it.each(scope)('retains missing %s in coverage instead of inferring it from another product/target', (cellId) => {
    const input = fixture();
    input.receipts = input.receipts.filter((row) => row.cellId !== cellId);
    expect(evaluateInstalledArtifactMatrix(input)).toMatchObject({ status: 'failed',
      coverage: { population: scope, notChecked: [cellId] } });
  });
  it('rejects missing pins, duplicate receipts and an extraneous cell', () => {
    const missing = fixture(); missing.bindings.pop();
    expect(evaluateInstalledArtifactMatrix(missing).cells.at(-1)?.reasons).toContain('missing-artifact-binding');
    const duplicate = fixture(); duplicate.receipts.push(structuredClone(duplicate.receipts[0]));
    expect(evaluateInstalledArtifactMatrix(duplicate).status).toBe('failed');
    const extra = fixture(); extra.receipts.push({ ...extra.receipts[0], cellId: 'gui:windows-arm64' });
    expect(evaluateInstalledArtifactMatrix(extra)).toMatchObject({ status: 'failed', reasons: ['unexpected-cell'] });
  });
  it('requires every scenario and both host PATH controls independently', () => {
    for (const scenario of scenarios) for (const hostRuntimePath of pathCases) {
      const input = fixture();
      input.receipts = input.receipts.filter((row) => row.cellId !== scope[0]
        || row.scenario !== scenario || row.hostRuntimePath !== hostRuntimePath);
      expect(evaluateInstalledArtifactMatrix(input).status).toBe('failed');
    }
  });
  it('rejects an unknown scenario and unmeasured timeout/output state', () => {
    const unknown = fixture();
    Object.assign(unknown.receipts[0], { scenario: 'desktop-shell-only' });
    expect(evaluateInstalledArtifactMatrix(unknown).status).toBe('failed');
    const partial = fixture();
    Object.assign(partial.receipts[0].observation, { timedOut: undefined });
    expect(evaluateInstalledArtifactMatrix(partial).status).toBe('failed');
  });
  it.each(['installerSha256', 'artifactSha256', 'runtimeRegistrationId', 'offline',
    'candidate', 'semantic', 'cellId', 'hostRuntimePath'])('rejects a substituted installed %s', (field) => {
    const input = fixture();
    const actual = input.receipts[0].observation.receipts[0].actual as Record<string, unknown>;
    actual[field] = field === 'offline' ? false : 'substituted';
    expect(evaluateInstalledArtifactMatrix(input).status).toBe('failed');
  });
  it('binds upgrade to the previous artifact and rollback to the retained Node interpreter', () => {
    const upgrade = fixture();
    const leg = upgrade.receipts.find((row) => row.scenario === 'upgrade')!;
    (leg.observation.receipts[0].actual as Record<string, unknown>).previousArtifactSha256 = hash('wrong-previous');
    expect(evaluateInstalledArtifactMatrix(upgrade).status).toBe('failed');
    const rollback = fixture();
    rollback.receipts.find((row) => row.scenario === 'node-rollback')!.observation.receipts[0].runtime =
      rollback.bindings[0].runtime;
    expect(evaluateInstalledArtifactMatrix(rollback).status).toBe('failed');
  });
  it('refuses a relabelled sibling receipt or an import-only claimed pass', () => {
    const sibling = fixture();
    sibling.receipts[0].observation = structuredClone(sibling.receipts.at(-1)!.observation);
    expect(evaluateInstalledArtifactMatrix(sibling).status).toBe('failed');
    const imported = fixture(); imported.receipts[0].observation.receipts = [];
    expect(evaluateInstalledArtifactMatrix(imported).status).toBe('failed');
  });
  it.each(['pid', 'nonce', 'runtime', 'completed'])('rejects mismatched actual process %s', (field) => {
    const input = fixture();
    Object.assign(input.receipts[0].observation.receipts[0], { [field]: null });
    expect(evaluateInstalledArtifactMatrix(input).status).toBe('failed');
  });
  it('rejects unknown process identity and abnormal completion even with matching semantics', () => {
    for (const change of [{ pid: null }, { nonce: '' }, { exitCode: 1 }, { signal: 'SIGILL' },
      { timedOut: true }, { binarySha256: hash('wrong-binary') }]) {
      const input = fixture(); Object.assign(input.receipts[0].observation, change);
      expect(evaluateInstalledArtifactMatrix(input).status).toBe('failed');
    }
  });
  it('refuses a vacuous/duplicated scope, ambiguous binding or unpinned native generation', () => {
    const empty = fixture(); empty.requiredScope = [];
    expect(() => evaluateInstalledArtifactMatrix(empty)).toThrow(/scope/);
    const duplicate = fixture(); duplicate.requiredScope.push(scope[0]);
    expect(() => evaluateInstalledArtifactMatrix(duplicate)).toThrow(/scope/);
    const pin = fixture(); pin.bindings.push(pin.bindings[0]);
    expect(() => evaluateInstalledArtifactMatrix(pin)).toThrow(/pins/);
    const native = fixture(); native.bindings[0].candidate.dependencyGeneration = 'unmeasured';
    expect(() => evaluateInstalledArtifactMatrix(native)).toThrow(/pins/);
  });
  it('refuses host runtimes and sibling paths outside the pinned installed closure', () => {
    for (const executable of ['/host/bin/bun', `/installed/${scope[0]}-sibling/bun`]) {
      const input = fixture(); input.bindings[0].runtime.executable = executable;
      expect(() => evaluateInstalledArtifactMatrix(input)).toThrow(/pins/);
    }
    const input = fixture();
    input.bindings[4].rollbackRuntime.executable = 'C:\\host\\node.exe';
    expect(() => evaluateInstalledArtifactMatrix(input)).toThrow(/pins/);
  });
});
