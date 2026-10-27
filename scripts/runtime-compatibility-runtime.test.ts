import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_EXPECTATIONS, performRuntimeCapability } from './lib/runtime-compatibility-probes.mjs';
import { captureCurrentRuntimeProofIdentity, captureRuntimeProofIdentity, measureRuntime,
  runCapability, runtimeProofFingerprint } from './lib/runtime-compatibility.mjs';

const probePath = fileURLToPath(new URL('./lib/runtime-compatibility-probes.mjs', import.meta.url));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'runtime-source-test-fixture' };

// These exercise the actual builtin implementations in bounded child processes.
// An explicit candidate path adds Bun without replacing the Node controls.
const interpreters = [process.execPath,
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN ? [process.env.PAPERCUSP_RUNTIME_TEST_BUN] : [])];
const capabilities = Object.keys(RUNTIME_EXPECTATIONS) as Array<keyof typeof RUNTIME_EXPECTATIONS>;
describe('isolated runtime protocol semantics', () => {
  it('accepts the maintained materialized checkout pin and rejects inconsistent or malformed pins', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-materialized-pin-'));
    try {
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      const source = readFileSync(new URL('../apps/operator/bin/release/setup-release-checkout.sh', import.meta.url), 'utf8');
      const writer = source.match(/record_node_modules_copy_metadata\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(writer).toBeDefined();
      execFileSync('bash', ['-c', `${writer}\nlog() { :; }\nrecord_node_modules_copy_metadata`], {
        env: { ...process.env, RELEASE_ROOT: root, INTEGRATION_ROOT: root,
          PINNED_DEPENDENCY_GENERATION_ID: `v1-${'a'.repeat(64)}`,
          DEPENDENCY_GENERATION_SOURCE_FINGERPRINT: 'a'.repeat(64) },
      });
      const marker = join(root, 'node_modules/.papercusp-dependency-generation');
      expect(readFileSync(marker, 'utf8')).toBe(`identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
      expect(captureCurrentRuntimeProofIdentity({ root })).not.toBeNull();
      for (const invalid of [
        `identity=v1-${'a'.repeat(64)}\nsource=${'b'.repeat(64)}\n`,
        `identity=v1-${'a'.repeat(64)}\n`,
        `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`,
      ]) {
        writeFileSync(marker, invalid);
        expect(captureCurrentRuntimeProofIdentity({ root })).toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(interpreters)('binds a published generation to the actual interpreter %s', async (executable) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-proof-generation-'));
    try {
      const environment = { ...process.env };
      expect(captureRuntimeProofIdentity({ root, environment, executable })).toBeNull();
      mkdirSync(join(root, 'node_modules'));
      writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
        `identity=v1-${'a'.repeat(64)}\nsource=${'a'.repeat(64)}\n`);
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      const selected = captureRuntimeProofIdentity({ root, environment, executable });
      expect(selected).toMatchObject(await measureRuntime(executable));
      if (executable === process.execPath) {
        expect(selected).toEqual(captureCurrentRuntimeProofIdentity({ root, environment }));
      }
      const initial = runtimeProofFingerprint(selected);
      expect(initial).toMatch(/^runtime-v1 [a-f0-9]{64}$/);
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
      expect(runtimeProofFingerprint(captureRuntimeProofIdentity({ root, environment, executable })))
        .not.toBe(initial);
      writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'), 'schema=1\nidentity=unpublished\n');
      expect(captureRuntimeProofIdentity({ root, environment, executable })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
  it.each(interpreters.flatMap(executable => capabilities.map(id => ({ executable, id }))))
    ('$id completes with $executable', async ({ executable, id }) => {
    const runtime = await measureRuntime(executable);
    const result = await runCapability({ capabilityId: id, expected: RUNTIME_EXPECTATIONS[id],
      runtime, candidate, probePath }, { timeoutMs: 8_000, env: { PAPERCUSP_PROBE_CAPABILITY: id } });
    expect({ status: result.status, actual: result.actual, reasons: result.reasons })
      .toEqual({ status: 'passed', actual: RUNTIME_EXPECTATIONS[id], reasons: [] });
  }, 15_000);
  it('refuses an unknown protocol instead of completing a substitute operation', async () => {
    await expect(performRuntimeCapability('unknown')).rejects.toThrow('Unknown runtime capability');
  });
  it('does not await redundant termination after observing a clean worker exit', async () => {
    const termination = vi.spyOn(Worker.prototype, 'terminate')
      .mockRejectedValue(new Error('already-exited termination must not be used'));
    try {
      await expect(performRuntimeCapability('worker-transfer-exit'))
        .resolves.toEqual(RUNTIME_EXPECTATIONS['worker-transfer-exit']);
      expect(termination).not.toHaveBeenCalled();
    } finally { termination.mockRestore(); }
  });
});
