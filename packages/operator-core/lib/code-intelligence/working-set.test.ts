import { describe, expect, it } from 'vitest';
import {
  WORKING_SET_MAX_FILES,
  WORKING_SET_MAX_SYMBOLS,
  WORKING_SET_PREVIOUS_EPOCH_LOOKBACK_MS,
  deriveCodeWorkingSet,
  parseStampedWorkingSet,
  rankCodeWorkingSet,
  stampableWorkingSet,
  workingSetWindow,
  type DeriveWorkingSetDeps,
  type EpochRow,
  type WorkingSetQuery,
  type WorkingSetSignals,
} from './working-set';

const NOW = new Date('2026-10-20T14:00:00.000Z');
const BUMPED = new Date('2026-10-20T12:00:00.000Z');

function depsWith(signals: WorkingSetSignals, epoch: EpochRow = { epoch: 3, bumpedAt: BUMPED }) {
  const queries: WorkingSetQuery[] = [];
  const deps: DeriveWorkingSetDeps = {
    epoch: async () => epoch,
    signals: async query => { queries.push(query); return signals; },
  };
  return { deps, queries };
}

describe('deriveCodeWorkingSet (R-1: edits rank first)', () => {
  it('ranks the edited file above a queried symbol definition and a read-only file', async () => {
    const t = BUMPED.getTime();
    // The read-only file is touched MOST often and MOST recently, so only the
    // reason ordering can put the edited file first.
    const { deps, queries } = depsWith({
      pushes: [
        { leg: 'first-touch', subject: 'packages/a/read-only.ts', citedPaths: ['packages/a/read-only.ts'], at: t + 9_000 },
        { leg: 'first-touch', subject: 'packages/a/read-only.ts', citedPaths: ['packages/a/read-only.ts'], at: t + 9_500 },
      ],
      edits: [{ file: 'packages/a/edited.ts', at: t + 1_000 }],
      tools: [{ tool: 'lsp:query', args: { op: 'workspace_symbols', name: 'resolveThing', file: 'packages/a/defs.ts' }, at: t + 2_000 }],
    });
    const set = await deriveCodeWorkingSet({ workspace: 'ws', harness: 'papercusp', owner: 'su-1', now: NOW }, deps);
    expect(set).not.toBeNull();
    expect(set!.files.map(f => [f.path, f.reason])).toEqual([
      ['packages/a/edited.ts', 'edited'],
      ['packages/a/defs.ts', 'queried'],
      ['packages/a/read-only.ts', 'read'],
    ]);
    expect(set!.symbols).toEqual([{ name: 'resolveThing', path: 'packages/a/defs.ts', hits: 1 }]);
    expect(set!.truncated).toEqual({ files: 0, symbols: 0 });
    // Current epoch: window is [bumped_at, now) and pushes are read for that epoch.
    expect(queries[0]).toMatchObject({ owner: 'su-1', epoch: 3, windowStart: BUMPED, windowEnd: NOW });
  });

  it('promotes a read file to edited when it is later edited, and counts grep subjects as symbols', () => {
    const ranked = rankCodeWorkingSet({
      pushes: [
        { leg: 'first-touch', subject: 'lib/x.ts', citedPaths: ['lib/x.ts'], at: 1 },
        { leg: 'interface', subject: 'lib/x.ts:added field', citedPaths: ['lib/x.ts', 'lib/y.ts'], at: 2 },
        { leg: 'grep', subject: 'buildCarryDoc', citedPaths: ['lib/carry-doc.ts', 'lib/caller.ts'], at: 3 },
      ],
      edits: [],
      tools: [],
    });
    expect(ranked.files).toEqual([
      { path: 'lib/x.ts', reason: 'edited', hits: 2 },
      { path: 'lib/carry-doc.ts', reason: 'queried', hits: 1 },
    ]);
    expect(ranked.symbols).toEqual([{ name: 'buildCarryDoc', path: 'lib/carry-doc.ts', hits: 1 }]);
  });

  it('ignores directories, unsafe paths, unrelated legs and absolute paths outside a known root', () => {
    const ranked = rankCodeWorkingSet({
      pushes: [
        { leg: 'resume', subject: 'resume:lib/carried.ts', citedPaths: ['lib/carried.ts'], at: 1 },
        { leg: 'incident', subject: 'failed-tests:lib/a.test.ts', citedPaths: ['lib/a.test.ts'], at: 1 },
      ],
      edits: [{ file: '../escape.ts', at: 1 }],
      tools: [
        { tool: 'lsp:query', args: { op: 'workspace_symbols', name: 'notASymbol()', file: 'packages/operator-core/lib' }, at: 1 },
        { tool: 'capability:read', args: { file_path: '/abs/elsewhere/file.ts' }, at: 1 },
        { tool: 'capability:edit', args: JSON.stringify({ file_path: '/repo/root/lib/abs.ts' }), at: 1 },
      ],
    }, { root: '/repo/root' });
    expect(ranked.files).toEqual([{ path: 'lib/abs.ts', reason: 'edited', hits: 1 }]);
    expect(ranked.symbols).toEqual([]);
  });
});

describe('deriveCodeWorkingSet (R-2: bounded)', () => {
  it('returns at most 8 files and 6 symbols and reports what it dropped', async () => {
    const edits = Array.from({ length: 13 }, (_, i) => ({ file: `lib/f${String(i).padStart(2, '0')}.ts`, at: i }));
    const tools = Array.from({ length: 10 }, (_, i) => ({ tool: 'graph:query', args: { op: 'callers', name: `sym${i}` }, at: i }));
    const { deps } = depsWith({ pushes: [], edits, tools });
    const set = await deriveCodeWorkingSet({ workspace: 'ws', harness: 'papercusp', owner: 'su-1', now: NOW }, deps);
    expect(set!.files).toHaveLength(WORKING_SET_MAX_FILES);
    expect(set!.symbols).toHaveLength(WORKING_SET_MAX_SYMBOLS);
    expect(set!.truncated).toEqual({ files: 13 - WORKING_SET_MAX_FILES, symbols: 10 - WORKING_SET_MAX_SYMBOLS });
    // Most recent first among equals.
    expect(set!.files[0].path).toBe('lib/f12.ts');
  });
});

describe('workingSetWindow', () => {
  it('previous epoch is epoch-1 bounded by the bump and a fixed lookback; none before the first bump', () => {
    expect(workingSetWindow('previous', { epoch: 3, bumpedAt: BUMPED }, NOW)).toEqual({
      epoch: 2, start: new Date(BUMPED.getTime() - WORKING_SET_PREVIOUS_EPOCH_LOOKBACK_MS), end: BUMPED,
    });
    expect(workingSetWindow('previous', { epoch: 0, bumpedAt: null }, NOW)).toBeNull();
    expect(workingSetWindow('current', { epoch: 0, bumpedAt: null }, NOW)).toEqual({
      epoch: 0, start: new Date(NOW.getTime() - WORKING_SET_PREVIOUS_EPOCH_LOOKBACK_MS), end: NOW,
    });
  });

  it('derives nothing for a previous epoch that does not exist', async () => {
    const { deps, queries } = depsWith({ pushes: [], edits: [], tools: [] }, { epoch: 0, bumpedAt: null });
    await expect(deriveCodeWorkingSet({ workspace: 'ws', harness: 'h', owner: 'o', which: 'previous', now: NOW }, deps)).resolves.toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe('stamp round trip', () => {
  it('stamps handles only and validates what it reads back', async () => {
    const { deps } = depsWith({ pushes: [], edits: [{ file: 'lib/a.ts', at: 1 }],
      tools: [{ tool: 'lsp:query', args: { name: 'Alpha' }, at: 1 }] });
    const set = await deriveCodeWorkingSet({ workspace: 'ws', harness: 'h', owner: 'su-1', now: NOW }, deps);
    const stamp = stampableWorkingSet(set!);
    expect(stamp).toEqual({ owner: 'su-1', epoch: 3, derivedAt: NOW.toISOString(), paths: ['lib/a.ts'], symbols: ['Alpha'] });
    expect(parseStampedWorkingSet(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
    expect(parseStampedWorkingSet({ owner: 'x', paths: ['../bad.ts', 'ok.ts'], symbols: ['ok', 'bad name'] }))
      .toMatchObject({ paths: ['ok.ts'], symbols: ['ok'] });
    expect(parseStampedWorkingSet({ paths: ['a.ts'] })).toBeNull();
  });
});
