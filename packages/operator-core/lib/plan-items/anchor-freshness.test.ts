import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushSnapshot, SnapshotSymbol } from '../code-intelligence/push-snapshot';
import { declarationContentHash, unknownAnchor, type PlanItemAnchor } from './anchors';
import { checkPlanItemAnchorFreshness } from './anchor-freshness';
import { getSystemAction } from '../harness/routines/system-actions';
import { PLAN_ANCHOR_FRESHNESS_CRON } from '../harness/routines/seed-plan-anchor-freshness-routine';
import { computeNextFireAt } from '../harness/routines/cron';
import '../harness/routines/plan-anchor-freshness-action';

const readGate = vi.hoisted(() => ({ hang: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) =>
    readGate.hang ? new Promise<never>(() => {}) : actual.readFile(...args) };
});
const roots: string[] = [];
afterEach(async () => { readGate.hang = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const original = 'export function linked() {\n  return "a b";\n}\n';
function symbol(source: string, path = 'code.ts'): SnapshotSymbol {
  return { id: 'linked-id', name: 'linked', path, line: 1, column: 17, sha256: sha(source),
    signature: 'linked()', aliases: [], callers: [] };
}
function snapshot(row: SnapshotSymbol): PushSnapshot {
  return { commit: 'fixture', generatedAt: new Date().toISOString(), generatedMs: Date.now(),
    symbols: new Map([['linked', [row]]]), hashes: new Map(), importers: new Map() };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-anchor-freshness-'));
  roots.push(root);
  await writeFile(join(root, 'code.ts'), original);
  const anchor: PlanItemAnchor = { ...unknownAnchor({ symbol: 'linked' }, 'no-snapshot'),
    symbolId: 'linked-id', symbolName: 'linked', path: 'code.ts', line: 1,
    contentHash: await declarationContentHash(original, symbol(original)),
    resolution: 'resolved', unknownReason: null, freshness: 'fresh' };
  return { root, anchor, options: { root, budgetMs: 5000 } };
}

describe('plan-item symbol freshness against actual source', () => {
  it('declares a fifteen-minute schedule for the registered routine action', () => {
    expect(getSystemAction('plan-anchor-freshness')).toBeTypeOf('function');
    expect(PLAN_ANCHOR_FRESHNESS_CRON).toBe('15 */15 * * * *');
    expect(computeNextFireAt(PLAN_ANCHOR_FRESHNESS_CRON, new Date('2026-10-23T12:00:16Z')))
      .toEqual(new Date('2026-10-23T12:15:15Z'));
  });
  it('keeps unchanged declarations fresh with no snapshot, despite edits elsewhere in the file', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'code.ts'), original + 'export const unrelated = 2;\n');
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'checked', freshness: 'fresh' });
  });
  it('marks a semantic edit stale and preserves the author baseline', async () => {
    const f = await fixture();
    const before = structuredClone(f.anchor);
    await writeFile(join(f.root, 'code.ts'), original.replace('a b', 'different'));
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'checked', freshness: 'stale' });
    expect(f.anchor).toEqual(before);
  });
  it('preserves literal whitespace as a semantic value', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'code.ts'), original.replace('a b', 'a  b'));
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'checked', freshness: 'stale' });
  });
  it('keeps reindentation and line movement fresh', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'code.ts'), '\n\n' + original.replace('  return', '      return'));
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'checked', freshness: 'fresh' });
  });
  it.each(['rename', 'remove', 'delete-file'])('marks a %s missing from direct source evidence', async change => {
    const f = await fixture();
    if (change === 'delete-file') await rm(join(f.root, 'code.ts'));
    else await writeFile(join(f.root, 'code.ts'), change === 'rename' ? original.replace('linked', 'renamed') : 'export const other = 1;');
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'checked', freshness: 'missing' });
  });
  it('marks a corroborated move stale instead of missing', async () => {
    const f = await fixture();
    await rm(join(f.root, 'code.ts'));
    await writeFile(join(f.root, 'moved.ts'), original);
    expect(await checkPlanItemAnchorFreshness(f.anchor, { ...f.options, snapshot: snapshot(symbol(original, 'moved.ts')) }))
      .toEqual({ status: 'checked', freshness: 'stale' });
  });
  it('defers a stale destination snapshot instead of claiming a deletion', async () => {
    const f = await fixture();
    await rm(join(f.root, 'code.ts'));
    await writeFile(join(f.root, 'moved.ts'), original + '// changed after snapshot');
    expect(await checkPlanItemAnchorFreshness(f.anchor, { ...f.options, snapshot: snapshot(symbol(original, 'moved.ts')) }))
      .toEqual({ status: 'deferred', reason: 'unavailable' });
  });
  it('defers ambiguous declarations instead of selecting an unrelated scope', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'code.ts'), original + 'class Other { linked() { return 2; } }');
    expect(await checkPlanItemAnchorFreshness(f.anchor, f.options)).toEqual({ status: 'deferred', reason: 'ambiguous' });
  });
  it('excludes path links and defers an unresolved symbol with a cold snapshot', async () => {
    const f = await fixture();
    expect(await checkPlanItemAnchorFreshness(unknownAnchor({ path: 'missing.ts' }, 'not-found'), f.options)).toEqual({ status: 'skipped' });
    expect(await checkPlanItemAnchorFreshness(unknownAnchor({ symbol: 'linked' }, 'no-snapshot'), f.options))
      .toEqual({ status: 'deferred', reason: 'unavailable' });
  });
  it('defers traversal and escaping symlinks', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'plan-anchor-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'code.ts'), original);
    await symlink(join(outside, 'code.ts'), join(f.root, 'escape.ts'));
    for (const path of ['../code.ts', 'escape.ts']) {
      expect(await checkPlanItemAnchorFreshness({ ...f.anchor, path }, f.options))
        .toEqual({ status: 'deferred', reason: 'unsafe-path' });
    }
  });
  it('bounds a cold parse/read without changing freshness on timeout', async () => {
    const f = await fixture();
    readGate.hang = true;
    expect(await checkPlanItemAnchorFreshness(f.anchor, { root: f.root, budgetMs: 10 }))
      .toEqual({ status: 'deferred', reason: 'timeout' });
  });
  it('defers an unavailable repository instead of calling its symbols missing', async () => {
    const f = await fixture();
    expect(await checkPlanItemAnchorFreshness(f.anchor, { root: join(f.root, 'unavailable'), budgetMs: 5000 }))
      .toEqual({ status: 'deferred', reason: 'unavailable' });
  });
});
