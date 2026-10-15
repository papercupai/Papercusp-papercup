import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { selectFrozenRepairAdmissionPaths, type FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';

// Compile only an in-memory copy. No tracked source, git ref, live queue or global
// process state is ever mutated by these negative controls.
const file = fileURLToPath(new URL('./frozen-candidate-repair-queue.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
function load(contents: string): typeof import('./frozen-candidate-repair-queue') {
  const result = buildSync({
    stdin: { contents, sourcefile: file, resolveDir: dirname(file), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  });
  const module = { exports: {} };
  // esbuild leaves Node builtins external in CJS bundles. Give the copied
  // module the same require resolution as its source, including node:crypto.
  runInNewContext(result.outputFiles[0]!.text, {
    module, exports: module.exports, require: createRequire(file),
  }, { timeout: 1000 });
  return module.exports as typeof import('./frozen-candidate-repair-queue');
}
function mutate(before: string, after: string) {
  expect(source.split(before)).toHaveLength(2);
  return load(source.replace(before, after));
}
const C = 'a'.repeat(40), H1 = 'b'.repeat(40), H2 = 'c'.repeat(40), H3 = 'd'.repeat(40);
function queue(): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4, phase: 'ready-to-verify', candidate: C, base: 'f'.repeat(40), repairHead: H3,
    attempts: 1, openedAtMs: 1, updatedAtMs: 2, fixerSpawnId: null,
    signature: [{ id: 'lint:x', kind: 'lint-leg', recipe: 'npm run lint:x', admittedRound: 1, measuredHead: H1 }],
    failingTests: ['lint:x'], selectiveCoverage: { schemaVersion: 1, candidate: C, head: H1 },
    admissions: [[H1, H2, 'lib/a.ts'], [H2, H3, 'lib/b.ts']].map(([from, to, p]) => ({
      fromRepairHead: from!, toRepairHead: to!, paths: [p!], unchanged: [], blobs: { [p!]: 'e'.repeat(40) },
      source: { ref: 'staging', sha: H3 }, actor: 'test', atMs: 2,
    })),
  };
}

describe('coverage negative controls execute current source without changing the shared tree', () => {
  it('calibrates the in-memory module against the real imported implementation', () => {
    expect(load(source).selectFrozenRepairAdmissionPaths(queue())).toEqual(selectFrozenRepairAdmissionPaths(queue()));
    expect(selectFrozenRepairAdmissionPaths(queue()).mode).toBe('delta');
    expect(resolve(file)).toBe(file);
  });
  it('catches removal of admission continuity validation', () => {
    const q = queue();
    q.admissions![1]!.fromRepairHead = C;
    expect(selectFrozenRepairAdmissionPaths(q).mode).toBe('cumulative');
    const mutant = mutate('entry.fromRepairHead !== head', 'false');
    expect(mutant.selectFrozenRepairAdmissionPaths(q).mode).toBe('delta');
  });
  it('catches accepting a receipt from a different candidate', () => {
    const q = queue();
    q.selectiveCoverage!.candidate = H2;
    expect(selectFrozenRepairAdmissionPaths(q).mode).toBe('cumulative');
    const mutant = mutate('v.candidate !== candidate', 'false');
    expect(mutant.selectFrozenRepairAdmissionPaths(q).mode).toBe('delta');
  });
  it('catches removing the loss-of-failure-frontier guard', () => {
    const q = queue();
    q.failingTests = Array.from({ length: 50 }, (_, i) => `lint:${i}`);
    expect(selectFrozenRepairAdmissionPaths(q).mode).toBe('cumulative');
    const mutant = mutate("if (!lossless) return fallback('failure-frontier-possibly-truncated');", '');
    expect(mutant.selectFrozenRepairAdmissionPaths(q).mode).toBe('delta');
  });
  it('leaves the source byte-identical after every mutated module execution', () => {
    expect(readFileSync(file, 'utf8')).toBe(source);
  });
});
