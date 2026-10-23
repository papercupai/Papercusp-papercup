import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushSnapshot, SnapshotSymbol } from '../../code-intelligence/push-snapshot';
import { declarationContentHash, resolvePlanItemAnchors, stripRenderedAnchorLines } from '../../plan-items/anchors';

const roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source = 'export function planned() { return 1; }\nexport const other = 2;\n';
const consumer = "import { planned } from './code';\n\n\nplanned();\n";
const flow = "import './consumer';\n";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-anchors-')); roots.push(root);
  await writeFile(join(root, 'code.ts'), source);
  await writeFile(join(root, 'consumer.ts'), consumer);
  await writeFile(join(root, 'flow.test.ts'), flow);
  const symbol: SnapshotSymbol = { id: 'fixture:planned', name: 'planned', path: 'code.ts', line: 1, column: 17,
    sha256: hash(source), signature: 'planned()', aliases: [],
    callers: [{ path: 'consumer.ts', line: 4, column: 1, sha256: hash(consumer), spelling: 'planned' }] };
  const snapshot: PushSnapshot = { commit: 'fixture-commit', generatedAt: new Date().toISOString(), generatedMs: Date.now(),
    importers: new Map([['code.ts', ['consumer.ts']], ['consumer.ts', ['flow.test.ts']]]),
    hashes: new Map([['consumer.ts', hash(consumer)], ['flow.test.ts', hash(flow)]]),
    symbols: new Map([['planned', [symbol]]]) };
  return { root, symbol, snapshot };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('plan item anchors', () => {
  it('resolves a real declaration, positive callers and transitive reaching tests', async () => {
    const f = await fixture();
    const [anchor] = await resolvePlanItemAnchors([{ symbol: 'planned' }], { ...f, budgetMs: 5000 });
    expect(anchor).toMatchObject({ resolution: 'resolved', symbolId: 'fixture:planned', symbolName: 'planned', path: 'code.ts',
      contentHash: hash('export function planned() { return 1; }'), consumers: [{ path: 'consumer.ts', line: 4 }], tests: ['flow.test.ts'] });
  });
  it('a symbol hash changes with its declaration, independently of neighboring declarations', async () => {
    const { symbol } = await fixture();
    const before = await declarationContentHash(source, symbol);
    expect(await declarationContentHash(source.replace('other = 2', 'other = 3'), symbol)).toBe(before);
    expect(await declarationContentHash(source.replace('return 1', 'return 2'), symbol)).not.toBe(before);
  });
  it.each([
    ["'a  b'", "'a b'"],
    ['`a  b`', '`a b`'],
    ['`a  ${1}  b`', '`a ${1} b`'],
    ['/a  b/', '/a b/'],
  ])('preserves meaningful whitespace in %s while ignoring surrounding formatting', async (before, after) => {
    const { symbol } = await fixture();
    const original = `export function planned() { return ${before}; }\n`;
    const formatted = `export function planned() {\n  return    ${before};\n}\n`;
    const changed = `export function planned() { return ${after}; }\n`;
    const originalHash = await declarationContentHash(original, symbol);
    expect(originalHash).not.toBeNull();
    expect(await declarationContentHash(formatted, symbol)).toBe(originalHash);
    expect(await declarationContentHash(changed, symbol)).not.toBe(originalHash);
  });
  it('stores a file content hash, and keeps missing paths and symbols explicit', async () => {
    const f = await fixture();
    const anchors = await resolvePlanItemAnchors([{ path: 'code.ts' }, { path: 'missing.ts' }, { symbol: 'missing' }], { ...f, budgetMs: 5000 });
    expect(anchors[0]).toMatchObject({ resolution: 'resolved', path: 'code.ts', contentHash: hash(source) });
    expect(anchors.slice(1).map(a => [a.resolution, a.unknownReason])).toEqual([['unknown', 'not-found'], ['unknown', 'not-found']]);
  });
  it('does not invent an identity for ambiguous or stale snapshot entries', async () => {
    const f = await fixture();
    const ambiguous = { ...f.snapshot, symbols: new Map([['planned', [f.symbol, { ...f.symbol, id: 'other:planned' }]]]) };
    expect((await resolvePlanItemAnchors([{ symbol: 'planned' }], { root: f.root, snapshot: ambiguous }))[0]?.unknownReason).toBe('ambiguous');
    await writeFile(join(f.root, 'code.ts'), source + '// changed\n');
    expect((await resolvePlanItemAnchors([{ symbol: 'planned' }], { ...f, budgetMs: 5000 }))[0]?.unknownReason).toBe('no-snapshot');
  });
  it('bounds a never-settling resolver and retains each requested link as timeout', async () => {
    vi.useFakeTimers();
    const pending = resolvePlanItemAnchors([{ symbol: 'planned' }], { root: '/unused', snapshot: () => new Promise(() => {}), budgetMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject([{ requested: 'planned', resolution: 'unknown', unknownReason: 'timeout' }]);
  });
  it('does not report callers or reaching tests after their proof source changes', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'consumer.ts'), 'export const noCall = 1;\n');
    expect((await resolvePlanItemAnchors([{ symbol: 'planned' }], { ...f, budgetMs: 5000 }))[0])
      .toMatchObject({ resolution: 'unknown', unknownReason: 'no-snapshot', consumers: [], tests: [] });
  });
  it('corroborates returned test paths without spending the proof cap on unrelated import branches', async () => {
    const f = await fixture();
    const unrelated = Array.from({ length: 600 }, (_, index) => `unrelated-${index}.ts`);
    const snapshot = { ...f.snapshot, importers: new Map(f.snapshot.importers), hashes: new Map(f.snapshot.hashes) };
    snapshot.importers.set('code.ts', ['consumer.ts', ...unrelated]);
    for (const path of unrelated) snapshot.hashes.set(path, hash('unrelated snapshot branch'));
    // These branches do not reach a returned test and need not even remain on disk.
    const [anchor] = await resolvePlanItemAnchors([{ symbol: 'planned' }], { ...f, snapshot, budgetMs: 5000 });
    expect(anchor).toMatchObject({ resolution: 'resolved', symbolId: 'fixture:planned',
      consumers: [{ path: 'consumer.ts', line: 4 }], tests: ['flow.test.ts'] });
    // The selected transitive test is still positive evidence and must be corroborated.
    await writeFile(join(f.root, 'flow.test.ts'), 'export const noReachability = true;\n');
    expect((await resolvePlanItemAnchors([{ symbol: 'planned' }], { ...f, snapshot, budgetMs: 5000 }))[0])
      .toMatchObject({ resolution: 'unknown', unknownReason: 'no-snapshot', tests: [] });
  });
  it('rejects traversal and symlinks outside the repository', async () => {
    const f = await fixture(); const outside = await fixture();
    await symlink(join(outside.root, 'code.ts'), join(f.root, 'escape.ts'));
    const anchors = await resolvePlanItemAnchors([{ path: '../outside' }, { path: 'escape.ts' }], { ...f, budgetMs: 5000 });
    expect(anchors.every(a => a.resolution === 'unknown')).toBe(true);
  });
  it('removes rendered code-link lines from a pasted plan while preserving fenced examples', () => {
    const text = '- **P-001** `todo` Work\n  ↳ code: stale rendered metadata\n```\n  ↳ code: example\n```\n';
    expect(stripRenderedAnchorLines(text)).toBe('- **P-001** `todo` Work\n```\n  ↳ code: example\n```\n');
  });
});
