import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NATIVE_EXPECTATIONS, performNativeCapability } from './lib/runtime-compatibility-probes.mjs';
import { measureRuntime, runCapability } from './lib/runtime-compatibility.mjs';

const manifest = fileURLToPath(new URL('../packages/operator-core/package.json', import.meta.url));
const probePath = fileURLToPath(new URL('./lib/runtime-compatibility-probes.mjs', import.meta.url));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'source-test-fixture' };
// The source install's missing SQLite binding is tracked as EI-26705574543980946.
// Its native operation is measured in the explicit candidate dependency
// generation by P-001, alongside the same probes exercised here.
const sourceCapabilities = ['sodium-secretbox-roundtrip', 'sharp-png-roundtrip',
  'udx-loopback', 'rocksdb-reopen', 'pty-input-exit', 'onnx-worker-inference-restart',
  'onnx-cpu-inference', 'onnx-worker-inference'] as const;
const interpreters = [process.execPath,
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN ? [process.env.PAPERCUSP_RUNTIME_TEST_BUN] : [])];
describe('bounded native operations available in the source dependency closure', () => {
  it.each(interpreters.flatMap(executable => sourceCapabilities.map(id => ({ executable, id }))))
    ('$id completes its actual operation with $executable', async ({ executable, id }) => {
    const runtime = await measureRuntime(executable);
    const result = await runCapability({ capabilityId: id, expected: NATIVE_EXPECTATIONS[id],
      runtime, candidate, probePath }, { timeoutMs: 8_000, env: {
      PAPERCUSP_PROBE_CAPABILITY: id, PAPERCUSP_PROBE_REQUIRE_FROM: manifest,
    } });
    expect({ status: result.status, actual: result.actual, reasons: result.reasons, stderr: result.observation.stderr })
      .toEqual({ status: 'passed', actual: NATIVE_EXPECTATIONS[id], reasons: [], stderr: '' });
  }, 15_000);
  it('refuses an unknown capability rather than substituting an import check', async () => {
    await expect(performNativeCapability('unknown', manifest)).rejects.toThrow('Unknown native capability');
  });
  it('requires an explicit absolute dependency resolution root', async () => {
    await expect(performNativeCapability('udx-loopback', 'package.json')).rejects.toThrow('Absolute candidate');
  });
});
