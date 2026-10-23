import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measureRuntime, runCapability } from './lib/runtime-compatibility.mjs';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const candidate = { sourceSha: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64),
  configurationSha256: 'd'.repeat(64), dependencyGeneration: 'isolated-test-fixture' };

async function probe(source: string, { timeoutMs = 10_000, expected = { value: 42 } as unknown, maxOutputBytes = 64 * 1024 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-capability-')); directories.push(root);
  const probePath = join(root, 'probe.mjs'); writeFileSync(probePath, source);
  const runtime = await measureRuntime(process.execPath);
  return runCapability({ capabilityId: 'fixture-roundtrip', probePath, runtime, candidate, expected },
    { timeoutMs, maxOutputBytes, cwd: root });
}

describe('native interpreter semantic completion', () => {
  it('records a real isolated file write/read roundtrip under the measured interpreter', async () => {
    const result = await probe(`import { writeFile, readFile } from 'node:fs/promises';
      export async function perform() {
        await writeFile('roundtrip.json', JSON.stringify({ value: 42 }));
        return JSON.parse(await readFile('roundtrip.json', 'utf8'));
      }`);
    expect(result).toMatchObject({ status: 'passed', actual: { value: 42 }, runtime: { name: 'node' } });
    expect(result.observation.pid).toBeGreaterThan(0);
  });
  it('rejects a zero exit before the semantic operation finishes', async () => {
    const result = await probe('export function perform() { process.exit(0); }');
    expect(result.status).toBe('failed'); expect(result.reasons).toContain('missing-or-duplicate-completion');
  });
  it('rejects an import that succeeds without an exported operation', async () => {
    const result = await probe('export const imported = true;');
    expect(result.status).toBe('failed'); expect(result.reasons).toContain('abnormal-exit');
  });
  it('refuses an absent probe rather than treating an identity-only operation as capability proof', async () => {
    const runtime = await measureRuntime(process.execPath);
    await expect(runCapability({ capabilityId: 'not-an-operation', runtime, candidate, expected: null }))
      .rejects.toThrow(/semantic probe/);
  });
  it('rejects a successful operation attributed to another runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-capability-')); directories.push(root);
    const probePath = join(root, 'probe.mjs'); writeFileSync(probePath, 'export function perform() { return 42; }');
    const runtime = await measureRuntime(process.execPath);
    const result = await runCapability({ capabilityId: 'wrong-runtime', probePath,
      runtime: { ...runtime, name: 'bun' }, candidate, expected: 42 });
    expect(result.reasons).toContain('wrong-interpreter');
  });
  it('rejects a probe that replaces its source during the operation', async () => {
    const result = await probe(`import { writeFileSync } from 'node:fs';
      export function perform() { writeFileSync(new URL(import.meta.url), '// replaced'); return { value: 42 }; }`);
    expect(result.reasons).toContain('probe-changed-during-operation');
  });
  it('rejects a wrong semantic result', async () => {
    const result = await probe('export function perform() { return { value: 41 }; }');
    expect(result.reasons).toContain('incorrect-result');
  });
  it('rejects a thrown operation and a throw after a valid completion', async () => {
    expect((await probe('export function perform() { throw new Error("fixture failure"); }')).status).toBe('failed');
    const late = await probe(`export function perform() {
      setTimeout(() => { throw new Error('late failure'); }, 20); return { value: 42 };
    }`);
    expect(late.actual).toEqual({ value: 42 }); expect(late.reasons).toContain('abnormal-exit');
  });
  it('kills a hung operation within its declared budget', async () => {
    const result = await probe('export async function perform() { setInterval(() => {}, 1000); await new Promise(() => {}); }', { timeoutMs: 500 });
    expect(result.reasons).toContain('timeout'); expect(result.status).toBe('failed');
  });
  it('rejects unbounded probe output', async () => {
    const result = await probe('export function perform() { console.log("x".repeat(10000)); return { value: 42 }; }', { maxOutputBytes: 2048 });
    expect(result.reasons).toContain('output-limit');
  });
  it('ignores inherited interpreter preloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-capability-')); directories.push(root);
    const runtime = await measureRuntime(process.execPath, { env: { NODE_OPTIONS: '--require=/nonexistent-preload.cjs' } });
    expect(runtime.name).toBe('node');
  });
});
