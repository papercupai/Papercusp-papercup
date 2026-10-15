/**
 * WI-10006596: a sibling checkout reached through a SYMLINK (papercupai-workspace/email ->
 * .papercusp-workspaces/.../apps/email) gets Vitest's REALPATHS back, so testing:run keys
 * `byFile` as `../../<realpath>/tests/x.test.ts` relative to the symlinked root while the
 * evidence binding names `tests/x.test.ts`. The exact-key lookup missed and settled a passing
 * proof as outcome:'unknown', executed:false (live: bindings 26106-26108, run group c10750a7).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { byFileCountsFor, testEvidenceOutcome } from './evidence';
import type { TestFilesCoreResult } from './run';

const base = mkdtempSync(join(tmpdir(), 'evidence-symlink-'));
const realRoot = join(base, 'real', 'apps', 'email');
const linkRoot = join(base, 'workspace', 'email');
mkdirSync(join(realRoot, 'tests'), { recursive: true });
mkdirSync(join(base, 'workspace'), { recursive: true });
writeFileSync(join(realRoot, 'tests', 'x.test.ts'), '');
writeFileSync(join(realRoot, 'tests', 'other.test.ts'), '');
symlinkSync(realRoot, linkRoot, 'dir');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const counts = { passed: 3, failed: 0, skipped: 0, collectionFailed: false };
// Exactly the spelling the live run produced: the realpath, relative to the SYMLINKED root.
const realpathKey = relative(linkRoot, join(realRoot, 'tests', 'x.test.ts'));
const binding = {
  specId: 'S', specRevision: 1, testPath: 'tests/x.test.ts', sourcePaths: ['src/a.ts'], testLayer: 'unit',
} as unknown as Parameters<typeof testEvidenceOutcome>[0];

function result(root: string | undefined, byFile: Record<string, typeof counts>): TestFilesCoreResult {
  return { ok: true, runId: 'r', ...(root ? { root } : {}), files: 1, passed: 3, failed: 0, skipped: 0,
    failures: [], byFile } as unknown as TestFilesCoreResult;
}

describe('test evidence outcome in a symlinked sibling checkout (WI-10006596)', () => {
  it('positive control: the live key spelling is NOT the binding testPath', () => {
    expect(realpathKey.startsWith('..')).toBe(true);
    expect(realpathKey).not.toBe(binding.testPath);
  });

  it('settles a passing proof as pass when byFile is keyed by the realpath', () => {
    expect(testEvidenceOutcome(binding, result(linkRoot, { [realpathKey]: counts })))
      .toMatchObject({ outcome: 'pass', executed: true, collected: true });
  });

  it('still matches the exact key first, and absolute keys by identity', () => {
    expect(byFileCountsFor(result(linkRoot, { 'tests/x.test.ts': counts }), 'tests/x.test.ts')).toBe(counts);
    expect(byFileCountsFor(result(linkRoot, { [join(realRoot, 'tests', 'x.test.ts')]: counts }), 'tests/x.test.ts'))
      .toBe(counts);
  });

  it('never borrows another file\'s counts, and without a root stays unknown', () => {
    const otherKey = relative(linkRoot, join(realRoot, 'tests', 'other.test.ts'));
    expect(byFileCountsFor(result(linkRoot, { [otherKey]: counts }), 'tests/x.test.ts')).toBeUndefined();
    expect(testEvidenceOutcome(binding, result(undefined, { [realpathKey]: counts })))
      .toMatchObject({ outcome: 'unknown', executed: false });
  });
});
