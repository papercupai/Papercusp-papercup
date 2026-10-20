/**
 * code-intel-epoch-carry-2026-10-20 R-4 (P-003) and R-6 (P-004): a new epoch, or
 * a new holder of a work item, receives FRESH first-touch facts for the carried
 * working set on its next tool batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import {
  codeIntelPushText, parkedResumeContextCount, PUSH_LEG_FLAGS, readPushResumeContext, resetParkedResumeContexts, snapshotResumeLeg,
  type PushChannelDeps, type PushFact, type PushInput, type ReadResumeContextDeps,
} from './push-channel';
import { parsePushSnapshot } from './push-snapshot';
import { readForeignWorkingSets, stampCodeWorkingSet, type CodeWorkingSet, type WorkingSetQuery } from './working-set';

const now = Date.now();
const BUMPED = new Date(now - 60_000);
const snapshot = () => parsePushSnapshot(JSON.stringify({
  schema: 'graph-dependency-snapshot-v1', index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
  generatedAt: new Date(now).toISOString(), edges: [
    { importer: 'app/use.ts', imported: 'lib/target.ts', importerSha256: 'b'.repeat(64) },
    { importer: 'lib/target.test.ts', imported: 'lib/target.ts', importerSha256: 'c'.repeat(64) },
  ] }), now)!;
const OWNER = 'su-new-epoch';
const input = (calls: PushInput['calls'] = [{ tool: 'Read', toolInput: { file_path: 'other/unrelated.ts' } }]): PushInput =>
  ({ owner: OWNER, workspace: 'ws-A', harness: 'papercusp', calls });

function resumeDeps(over: Partial<ReadResumeContextDeps> = {}) {
  const queries: WorkingSetQuery[] = [];
  const deps: ReadResumeContextDeps = {
    epoch: async () => ({ epoch: 2, bumpedAt: BUMPED }),
    signals: async query => {
      queries.push(query);
      // The previous epoch's LEDGER holds subjects and paths only — no fact text.
      return { pushes: [{ leg: 'first-touch', subject: 'lib/target.ts', citedPaths: ['lib/target.ts'], at: now - 120_000 }], edits: [], tools: [] };
    },
    foreign: async () => [],
    pushed: async () => [],
    ...over,
  };
  return { deps, queries };
}

function channel(resume: ReadResumeContextDeps, enabled = async () => true) {
  const committed: PushFact[] = [];
  const resumeContext = vi.fn((i: PushInput) => readPushResumeContext(i, resume));
  const deps: PushChannelDeps = {
    snapshot: async () => snapshot(),
    enabled: vi.fn(enabled),
    legs: () => new Map([['resume', snapshotResumeLeg]]),
    resumeContext,
    commit: async (_i, _s, facts) => { committed.push(...facts); return facts.map(f => f.text).join('\n\n'); },
  };
  return { deps, committed, resumeContext };
}

describe('R-4: a new epoch receives fresh facts for its predecessor\'s files', () => {
  it('pushes a resume fact for a previous-epoch file on the first tool batch, recomputed from the current snapshot', async () => {
    const { deps: resume, queries } = resumeDeps();
    const { deps, committed } = channel(resume);
    const text = await codeIntelPushText(input(), 0, deps);
    expect(committed).toHaveLength(1);
    const [fact] = committed;
    expect(fact).toMatchObject({ leg: 'resume', subject: 'resume:lib/target.ts' });
    expect(fact.text).toContain("Carried from your previous epoch's working set (epoch 1) (read); recomputed from the current snapshot");
    // The numbers come from THIS snapshot (2 static importers, the current test reach).
    expect(fact.text).toContain('lib/target.ts: 2 static file importers in this snapshot');
    expect(fact.citedPaths).toEqual(expect.arrayContaining(['lib/target.ts', 'app/use.ts', 'lib/target.test.ts']));
    expect(text).toBe(fact.text);
    // Previous epoch = epoch-1, ledger window bounded by the bump.
    expect(queries).toEqual([expect.objectContaining({ owner: OWNER, epoch: 1, windowEnd: BUMPED })]);
  });

  it('is pushed once per epoch, and a file touched in the same batch gets its ordinary first-touch brief instead', async () => {
    const already = channel(resumeDeps({ pushed: async () => ['resume:lib/target.ts'] }).deps);
    await codeIntelPushText(input(), 0, already.deps);
    expect(already.committed).toEqual([]);
    const touched = channel(resumeDeps().deps);
    await codeIntelPushText(input([{ tool: 'Read', toolInput: { file_path: 'lib/target.ts' } }]), 0, touched.deps);
    expect(touched.committed).toEqual([]);
  });

  it('a fresh owner (no previous epoch) resumes nothing, and the OFF flag skips the read entirely', async () => {
    const fresh = channel(resumeDeps({ epoch: async () => ({ epoch: 0, bumpedAt: null }) }).deps);
    await codeIntelPushText(input(), 0, fresh.deps);
    expect(fresh.committed).toEqual([]);
    const off = channel(resumeDeps().deps, async () => false);
    await codeIntelPushText(input(), 0, off.deps);
    expect(off.resumeContext).not.toHaveBeenCalled();
    expect(FLAG_DEFAULTS[PUSH_LEG_FLAGS.resume]).toBe(true);
  });
});

describe('P-006: a resume read that misses its bound is parked for the next batch, not discarded', () => {
  beforeEach(() => resetParkedResumeContexts());
  afterEach(() => { resetParkedResumeContexts(); vi.restoreAllMocks(); });

  /** A resume read that does not settle until the test releases it. */
  function slowChannel() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = channel(resumeDeps().deps);
    const read = vi.fn(async (i: PushInput) => { await gate; return readPushResumeContext(i, resumeDeps().deps); });
    return { ...base, deps: { ...base.deps, resumeContext: read }, read, release: () => release() };
  }

  it('serves a late result to the next batch instead of re-reading (live run 1: >100ms under load, never fired)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slow = slowChannel();
    await codeIntelPushText(input(), 0, slow.deps);
    expect(slow.committed).toEqual([]);
    expect(parkedResumeContextCount()).toBe(1);
    slow.release();
    await vi.waitFor(async () => {
      await codeIntelPushText(input(), 0, slow.deps);
      expect(slow.committed).toHaveLength(1);
    });
    expect(slow.committed[0]).toMatchObject({ leg: 'resume', subject: 'resume:lib/target.ts' });
    // One read served both batches; the consumed result is gone, so the next read is fresh.
    expect(slow.read).toHaveBeenCalledTimes(1);
    expect(parkedResumeContextCount()).toBe(0);
  });

  it('joins an in-flight read rather than starting another, and keys it per (workspace, owner)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slow = slowChannel();
    await codeIntelPushText(input(), 0, slow.deps);
    await codeIntelPushText(input(), 0, slow.deps);
    expect(slow.read).toHaveBeenCalledTimes(1);
    await codeIntelPushText({ ...input(), owner: 'su-other' }, 0, slow.deps);
    expect(slow.read).toHaveBeenCalledTimes(2);
    expect(parkedResumeContextCount()).toBe(2);
    slow.release();
  });

  it('reads the resume entries\' source links inside the background read, not on the push wall', async () => {
    const order: string[] = [];
    const base = channel(resumeDeps().deps);
    const context = vi.fn(async (_i: PushInput, paths: string[]) => {
      order.push(`links:${paths.join(',')}`);
      return { docs: null, specs: null, locks: null, byPath: { 'lib/target.ts': { docs: ['doc-carried'], specs: [] } } };
    });
    const resumeContext = vi.fn(async (i: PushInput) => { order.push('resume'); return base.resumeContext(i); });
    await codeIntelPushText(input(), 0, { ...base.deps, context, resumeContext });
    expect(order).toEqual(['resume', 'links:lib/target.ts']);
    expect(base.committed).toHaveLength(1);
    expect(base.committed[0].text).toContain('Anchored docs: doc-carried.');
  });

  it('an in-time read is consumed, not parked; a failed read is dropped', async () => {
    const fast = channel(resumeDeps().deps);
    await codeIntelPushText(input(), 0, fast.deps);
    expect(fast.committed).toHaveLength(1);
    expect(parkedResumeContextCount()).toBe(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = channel(resumeDeps({ epoch: async () => { throw new Error('ledger down'); } }).deps);
    await codeIntelPushText(input(), 0, failing.deps);
    expect(failing.committed).toEqual([]);
    expect(parkedResumeContextCount()).toBe(0);
  });
});

describe('R-6: a new holder receives fresh facts for the previous holder\'s files', () => {
  it('pushes a resume fact for a file from a work item stamped by a different owner', async () => {
    const { deps: resume } = resumeDeps({
      epoch: async () => ({ epoch: 0, bumpedAt: null }),
      foreign: async () => [{ itemId: 'WI-9', stamp: { owner: 'su-previous', epoch: 3, derivedAt: '', paths: ['lib/target.ts'], symbols: [] } }],
    });
    const { deps, committed } = channel(resume);
    await codeIntelPushText(input(), 0, deps);
    expect(committed).toHaveLength(1);
    expect(committed[0].subject).toBe('resume:lib/target.ts');
    expect(committed[0].text).toContain("Carried from WI-9's working set (stamped by su-previous); recomputed from the current snapshot");
  });

  it('reads only sets stamped by a DIFFERENT owner on items this owner holds', async () => {
    const statements: string[] = [];
    const rows = [
      { feature_id: 'WI-1', stamp: { owner: OWNER, paths: ['lib/own.ts'] } },
      { feature_id: 'WI-2', stamp: { owner: 'su-other', paths: ['lib/target.ts'], symbols: ['x'] } },
    ];
    const tx = (strings: TemplateStringsArray) => { statements.push(strings.join('?')); return Promise.resolve(strings.join('').includes('codeWorkingSet') ? rows : []); };
    const sql = { begin: async (fn: (t: unknown) => unknown) => fn(tx) };
    const sets = await readForeignWorkingSets(OWNER, 'ws-A', 'papercusp', sql as never);
    expect(sets.map(s => s.itemId)).toEqual(['WI-2']);
    const read = statements.find(s => s.includes('codeWorkingSet'))!;
    expect(read).toContain('taken_by = ?');
    expect(read).toContain("payload -> 'codeWorkingSet' ->> 'owner' IS DISTINCT FROM ?");
  });

  it('G-3 (blind review 35): inherits only stamps on items of THIS harness, and the resume read passes its harness', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    };
    const sql = { begin: async (fn: (t: unknown) => unknown) => fn(tx) };
    await readForeignWorkingSets(OWNER, 'ws-A', 'calendar', sql as never);
    const read = calls.find(c => c.text.includes('codeWorkingSet'))!;
    expect(read.text).toContain('harness_slug = ?');
    expect(read.values).toEqual(expect.arrayContaining(['ws-A', 'calendar', OWNER]));
    // No harness, no read: an unscoped stamp read is exactly the leak.
    calls.length = 0;
    await expect(readForeignWorkingSets(OWNER, 'ws-A', '', sql as never)).resolves.toEqual([]);
    expect(calls).toEqual([]);

    const foreign = vi.fn(async () => []);
    await readPushResumeContext(input(), resumeDeps({ foreign }).deps);
    expect(foreign).toHaveBeenCalledWith(OWNER, 'ws-A', 'papercusp');
  });

  it('G-4 (blind review 35): carried symbol handles ride the resume leg and are re-resolved in the CURRENT snapshot', async () => {
    const symbol = (name: string, path: string, line: number, callers: number) => ({ id: `${path}#${name}`, name, path, line, column: 1,
      sha256: 'b'.repeat(64), signature: `function ${name}()`, aliases: [name], sources: [{ path, sha256: 'b'.repeat(64) }],
      callers: Array.from({ length: callers }, (_, i) => ({ path: 'app/use.ts', line: i + 1, column: 1, sha256: 'c'.repeat(64), spelling: name })) });
    const symbolSnapshot = () => {
      const snap = snapshot();
      snap.symbols = new Map([
        ['targetFn', [symbol('targetFn', 'lib/target.ts', 12, 2)]],
        ['elsewhereFn', [symbol('elsewhereFn', 'lib/defs.ts', 40, 1)]],
      ]);
      return snap;
    };
    const run = async (resume: ReadResumeContextDeps) => {
      const base = channel(resume);
      await codeIntelPushText(input(), 0, { ...base.deps, snapshot: async () => symbolSnapshot() });
      return base.committed;
    };
    // Previous epoch: eight edited files fill the file cap, so the queried definition
    // file lib/target.ts is dropped from `files` — its symbol still brings it forward
    // (the eight were already resumed this epoch); a path-less handle rides along.
    const edited = Array.from({ length: 8 }, (_, i) => ({ file: `lib/e${i}.ts`, at: now - 100_000 + i }));
    const previous = resumeDeps({
      signals: async () => ({ pushes: [], edits: edited,
        tools: [{ tool: 'lsp:query', args: { op: 'workspace_symbols', name: 'targetFn', file: 'lib/target.ts' }, at: now - 120_000 },
          { tool: 'graph:query', args: { op: 'callers', name: 'elsewhereFn' }, at: now - 110_000 }] }),
      pushed: async () => edited.map(row => `resume:${row.file}`),
    }).deps;
    const context = await readPushResumeContext(input(), previous);
    expect(context.entries).toEqual([expect.objectContaining({ path: 'lib/target.ts', reason: 'queried', from: 'previous-epoch',
      symbols: ['targetFn', 'elsewhereFn'] })]);
    const [fact] = await run(previous);
    expect(fact.subject).toBe('resume:lib/target.ts');
    // Line and caller counts come from THIS snapshot, not from anything carried.
    expect(fact.text).toContain('Carried symbol handles, re-resolved in this snapshot: targetFn:12 >=2 static calls; elsewhereFn @lib/defs.ts:40 >=1 static calls.');

    // A work-item stamp carries names only; each is resolved, or named as unresolved.
    const held = resumeDeps({ epoch: async () => ({ epoch: 0, bumpedAt: null }),
      foreign: async () => [{ itemId: 'WI-9', stamp: { owner: 'su-previous', epoch: 3, derivedAt: '', paths: ['lib/target.ts'],
        symbols: ['targetFn', 'goneFn'] } }] }).deps;
    const [heldFact] = await run(held);
    expect(heldFact.text).toContain("Carried from WI-9's working set (stamped by su-previous)");
    expect(heldFact.text).toContain('targetFn:12 >=2 static calls; goneFn (not indexed in this snapshot).');

    // No carried symbols: no symbol line (the file-only resume text is unchanged).
    const [plain] = await run(resumeDeps().deps);
    expect(plain.text).not.toContain('Carried symbol handles');
  });

  it('stamps only non-terminal items still held by the stamping owner', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve(strings.join('').includes('UPDATE') ? [{ feature_id: 'WI-1' }] : []);
    };
    const sql = { begin: async (fn: (t: unknown) => unknown) => fn(tx) };
    const set: CodeWorkingSet = { owner: OWNER, epoch: 2, window: { start: '', end: '' }, derivedAt: 'd',
      files: [{ path: 'lib/a.ts', reason: 'edited', hits: 1 }], symbols: [], truncated: { files: 0, symbols: 0 } };
    await expect(stampCodeWorkingSet(OWNER, 'ws-A', set, ['WI-1', 'WI-1'], sql as never)).resolves.toEqual(['WI-1']);
    const update = calls.find(c => c.text.includes('UPDATE'))!;
    expect(update.text).toContain('taken_by = ?');
    expect(update.text).toContain('NOT (status = ANY(');
    expect(update.values).toEqual(expect.arrayContaining([OWNER, ['WI-1']]));
    expect(JSON.parse(String(update.values[0]))).toEqual({ owner: OWNER, epoch: 2, derivedAt: 'd', paths: ['lib/a.ts'], symbols: [] });
    await expect(stampCodeWorkingSet(OWNER, 'ws-A', { ...set, files: [] }, ['WI-1'], sql as never)).resolves.toEqual([]);
  });
});
