import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { boundChangeHistoryProviders, buildCoChangeIndex, changeHistoryProviders, coChangeFromCommits, coChangeFromIndex,
  coChangeOverlap,
  FULL_WINDOW_HISTORY_BOUNDS, IN_PROCESS_HISTORY_BOUNDS, parseHistoryLog, readHistoryCommits,
  fileSymbolNames, formatPriorWorkLine, ledgerSymbolProvenance, priorWorkReport, rankPriorWork, readCoChange, readPriorWork,
  registerChangeHistoryProviders, symbolProvenance,
  type HistoryCommit, type PriorWorkLedgerRow, type ProvenanceEdit, type LedgerProvenanceEdit } from './change-history';
import { composeReuseBrief, registeredReuseBriefProviders, type ReuseContribution } from './reuse-brief-providers';
import graphQuery from '../agent-tools/gitnexus/query';

const END = '2026-10-23T00:00:00.000Z';
const commit = (n: number, paths = ['a.ts', 'b.ts']): HistoryCommit => ({ sha: String(n).padStart(40, '0'),
  parents: ['f'.repeat(40)], at: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`,
  files: paths.map(path => ({ status: 'M', path })) });
const history = (commits: HistoryCommit[], paths = ['a.ts']) => coChangeFromCommits({ commits, paths, end: END,
  complete: true, commit: 'a'.repeat(40) });
const source = 'export function work() { return 2; }\n';
const edit: ProvenanceEdit = { invocation: 'invocation-7', at: '2026-10-10T12:00:00Z', owner: 'su-editor', session: 'session-exact',
  sessionOwners: ['su-editor'], status: 'ok', tool: 'Edit', input: { file_path: 'a.ts', old_string: 'return 1;', new_string: 'return 2;' } };
const assignment = { owner: 'su-editor', workItem: 'WI-responsible', start: '2026-10-09T00:00:00Z', end: '2026-10-11T00:00:00Z', complete: true };
const provenance = (patch: Partial<Parameters<typeof symbolProvenance>[0]> = {}) => symbolProvenance({ root: '/fixture', path: 'a.ts',
  source, edits: [edit], assignments: [assignment], complete: true, ...patch });
const ledgerEdit = (patch: Partial<LedgerProvenanceEdit> = {}): LedgerProvenanceEdit => ({
  id: '1', at: END, owner: 'former-owner', session: 'ended-session', workItem: 'WI-done', symbols: ['work'], ...patch });
const NOW = Date.parse('2026-10-27T00:00:00Z');
const DAY_MS = 86_400_000;
const prior = (n: number, patch: Partial<PriorWorkLedgerRow> = {}): PriorWorkLedgerRow => ({
  workItem: `WI-${n}`, title: `Item ${n}`, state: 'done', kind: 'task', visible: true, measured: true,
  lastEditAt: new Date(NOW - n * DAY_MS).toISOString(), closedAt: null, symbols: ['work'], ...patch });
const priorReport = (rows: PriorWorkLedgerRow[], names: string[] | null = ['work'], truncated = false) =>
  priorWorkReport({ path: 'a.ts', names, rows, truncated });
const note = (rows: PriorWorkLedgerRow[], names: string[] | null = ['work'], truncated = false) =>
  formatPriorWorkLine(priorReport(rows, names, truncated), { harness: 'papercusp', now: NOW });
const ids = (text: string | null) => [...(text ?? '').matchAll(/(WI-\d+) \(/g)].map(match => match[1]);

describe('P-008 prior work on the touched function', () => {
  it('SPEC-P-008: renders no note for zero prior rows, and one line; a complete list carries no total or pointer', () => {
    expect(note([])).toBeNull();
    expect(note([prior(1)])).toBe('Prior work on `work`: WI-1 (Item 1, done, 1d).');
    expect(note([prior(1)], [])).toBeNull(); // the touch named no function
  });
  it('SPEC-P-008-D: lists exactly 3 of 3 and of more than 3 prior items; an omission shows the total and a pointer', () => {
    const three = note([1, 2, 3].map(n => prior(n)));
    expect(ids(three)).toEqual(['WI-1', 'WI-2', 'WI-3']); expect(three).not.toContain('total');
    const five = note([1, 2, 3, 4, 5].map(n => prior(n)));
    expect(ids(five)).toEqual(['WI-1', 'WI-2', 'WI-3']);
    expect(five).toBe('Prior work on `work`: WI-1 (Item 1, done, 1d); WI-2 (Item 2, done, 2d); WI-3 (Item 3, done, 3d). '
      + '5 total; more: graph:query {"op":"provenance","file_path":"a.ts","name":"work","harnesses":["papercusp"]}');
    // A capped read is a floor, so its tail stays even when every read row is listed.
    expect(note([1, 2].map(n => prior(n)), ['work'], true)).toContain('. 2+ total; more: graph:query');
  });
  it('SPEC-P-008-C: lists an older bug or decision before a newer task, then recency, ties by most recent close', () => {
    expect(ids(note([prior(1), prior(9, { kind: 'bug' }), prior(2, { kind: 'decision' })]))).toEqual(['WI-2', 'WI-9', 'WI-1']);
    const at = new Date(NOW - DAY_MS).toISOString();
    expect(rankPriorWork([prior(1, { lastEditAt: at, closedAt: '2026-10-20T00:00:00Z' }),
      prior(2, { lastEditAt: at, closedAt: '2026-10-25T00:00:00Z' }), prior(3, { lastEditAt: at })])
      .items.map(item => item.workItem)).toEqual(['WI-2', 'WI-1', 'WI-3']);
  });
  it('SPEC-P-008-E: lists a work item recorded in several rows, or on several symbols, once', () => {
    const text = note([prior(1), prior(1, { symbols: ['other'], lastEditAt: new Date(NOW - 7 * DAY_MS).toISOString() }), prior(2)],
      ['other', 'work']);
    expect(ids(text)).toEqual(['WI-1', 'WI-2']); expect(text).toContain('Prior work on `other`, `work`:');
    expect(text?.match(/WI-1 \(/g)).toHaveLength(1);
    expect(rankPriorWork([prior(1), prior(1, { symbols: ['other'] })]).items[0]?.symbols).toEqual(['other', 'work']);
  });
  it('omits items the reader may not see from both the list and the count', () => {
    const text = note([prior(1, { visible: false }), prior(2)]);
    // The invisible item is not counted: the line is complete, so no "2 total" tail appears.
    expect(ids(text)).toEqual(['WI-2']); expect(text).not.toContain('total');
    expect(note([1, 2, 3, 4].map(n => prior(n)).concat(prior(5, { visible: false })))).toContain('. 4 total;');
    expect(note([prior(1, { visible: false })])).toBeNull();
  });
  it('gives an explicit unknown note for an unresolved symbol or uncaptured edits, never a measured absence', () => {
    expect(note([prior(1, { measured: false })], null))
      .toMatch(/^Prior work on `a\.ts`: unknown \(touched symbol not resolved\); file-level: WI-1 \(/);
    expect(note([prior(1, { measured: false })])).toMatch(/^Prior work on `work`: unknown \(earlier edits have no symbol capture\)/);
    expect(note([prior(1), prior(2, { measured: false })])).toContain('1 total; +1 file-level without symbol capture;');
    expect(note([], null)).toBeNull();
    expect(formatPriorWorkLine({ ...priorReport([prior(1)]), error: 'statement timeout' }, { harness: 'papercusp' })).toBeNull();
  });
  it('reads one bounded, workspace-scoped grouped query and excludes the reader\'s own item', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return strings.join('').includes('edit_attribution_ledger') ? [
        { work_item: 'WI-1', visible: true, title: 'Fix', state: 'done', kind: 'bug', closed_at: new Date(NOW),
          last_edit_at: new Date(NOW - DAY_MS), measured: true, symbols: ['work'] },
        { work_item: 'WI-2', visible: false, title: null, state: null, kind: null, closed_at: null,
          last_edit_at: new Date(NOW), measured: true, symbols: ['work'] }] : [];
    };
    const sql = { begin: async (run: (t: typeof tx) => unknown) => run(tx) } as unknown as Parameters<typeof readPriorWork>[1];
    const root = realpathSync(tmpdir());
    const report = await readPriorWork({ workspaceId: 'ws', root, path: 'a.ts', names: ['work'], excludeWorkItem: 'WI-mine' }, sql);
    expect(report).toMatchObject({ status: 'measured', total: 1, error: null, items: [{ workItem: 'WI-1', kind: 'bug' }] });
    const query = calls.find(call => call.text.includes('edit_attribution_ledger'))!;
    expect(calls[0]?.text).toContain('statement_timeout');
    expect(query.values).toEqual(expect.arrayContaining(['ws', root, 'a.ts', 'WI-mine', ['work']]));
    expect(query.text).toMatch(/LEFT JOIN harness_shared\.work_items w ON w\.workspace_id = e\.workspace_id/);
    calls.length = 0;
    expect((await readPriorWork({ workspaceId: 'ws', root, path: 'a.ts', names: [] }, sql)).total).toBe(0);
    expect(calls).toEqual([]);
    expect((await readPriorWork({ workspaceId: 'ws', root, path: '../escape.ts', names: ['work'] }, sql)).error).toBeTruthy();
  });
  it('derives claim-brief symbols from the file source itself', () => {
    expect(fileSymbolNames('a.ts', 'export function alpha() {}\nexport const beta = () => 1;\nclass Gamma {}'))
      .toEqual(expect.arrayContaining(['Gamma', 'alpha', 'beta']));
    expect(fileSymbolNames('a.md', '# not code')).toBeNull();
  });
});

describe('P001 edit-time ledger history', () => {
  const read = (rows: LedgerProvenanceEdit[], patch: Partial<Parameters<typeof ledgerSymbolProvenance>[0]> = {}) =>
    ledgerSymbolProvenance({ path: 'a.ts', source, rows, complete: true, ...patch });
  it('deduplicates completed/released work items without asserting current function identity', () => {
    const result = read([ledgerEdit(), ledgerEdit({ id: '2' }), ledgerEdit({ id: '3', workItem: 'WI-released' })]);
    expect(result.history[0]).toMatchObject({ status: 'measured', workItems: ['WI-done', 'WI-released'], currentIdentity: 'unknown' });
    expect(result.symbols[0]).toMatchObject({ status: 'unknown', workItem: null, recordedHistory: result.history[0] });
  });
  it('retains pre-capture and unattributed rows at file level, with unknown symbol attribution', () => {
    const result = read([ledgerEdit({ symbols: null }), ledgerEdit({ id: '2', symbols: [], workItem: null })]);
    expect(result.fileEdits).toHaveLength(2); expect(result.history).toEqual([]);
    expect(result.symbolStatus).toBe('unknown'); expect(result.symbols[0]?.workItem).toBeNull();
    expect(read([ledgerEdit({ workItem: null })]).history[0]).toMatchObject({ status: 'unknown', workItems: [] });
    expect(read([ledgerEdit({ symbols: [] })]).symbolStatus).toBe('measured');
  });
  it('surfaces the 50-row cap and parser failure instead of measured absence', () => {
    const capped = read(Array.from({ length: 51 }, (_, n) => ledgerEdit({ id: String(n) })));
    expect(capped).toMatchObject({ status: 'unknown', truncated: true });
    expect(capped.fileEdits).toHaveLength(50); expect(capped.history[0]?.status).toBe('unknown');
    const broken = read([ledgerEdit()], { source: 'export function work( {' });
    expect(broken).toMatchObject({ status: 'unknown', symbolStatus: 'unknown', symbols: [] });
    expect(broken.fileEdits).toHaveLength(1); expect(broken.limitations.join(' ')).toContain('parse');
  });
  it('does not infer rename, move, overload or nested identity from present-day names', () => {
    const renamed = read([ledgerEdit({ symbols: ['oldName'] })], { source: 'export function newName() {}' });
    expect(renamed.history[0]?.symbol).toBe('oldName'); expect(renamed.symbols[0]?.recordedHistory).toBeUndefined();
    const overloaded = read([ledgerEdit({ symbols: ['work', 'outer.inner'] })], {
      source: 'function work(x: string): string; function work(x: string) { return x; } function outer() { function inner() {} }' });
    expect(overloaded.history.every(row => row.currentIdentity === 'unknown')).toBe(true);
    expect(overloaded.symbols.every(row => row.status === 'unknown')).toBe(true);
    expect(read([], { name: 'work' }).history).toEqual([]); // A move has no evidence in this file.
  });
  it('preserves both recorded labels for a range split across functions without fabricating continuity', () => {
    const result = read([ledgerEdit({ symbols: ['left', 'right'] })], { source: 'function left() {} function right() {}' });
    expect(result.history.map(row => row.symbol)).toEqual(['left', 'right']);
    expect(result.symbols.every(row => row.status === 'unknown')).toBe(true);
  });
});

describe('P013 declared history and source provenance contracts', () => {
  it('counts distinct eligible first-parent commits with Jaccard and a three-shared floor', () => {
    const commits = [commit(1), commit(2), commit(3), commit(4, ['a.ts', 'c.ts']), commit(5, ['b.ts']), commit(1),
      { ...commit(6), parents: ['x', 'y'] }, { ...commit(7), at: '2025-01-01T00:00:00Z' }];
    const report = history(commits);
    expect(report.pairs).toEqual([{ path: 'a.ts', partner: 'b.ts', shared: 3, union: 5, score: 3 / 5 }]);
    expect(report.eligibleCommits).toBe(5);
    expect(report.window.lineage).toBe('first-parent');
  });
  it('follows recorded rename pairs and excludes mass/generated/vendor/retired changes', () => {
    const renamed = { ...commit(4, []), files: [{ status: 'R080', from: 'a.ts', path: 'renamed.ts' }] };
    const report = history([commit(1), commit(2), commit(3), renamed,
      commit(5, ['renamed.ts', 'vendor/x.ts', 'retired/y.ts', 'x.generated.ts']),
      commit(6, Array.from({ length: 101 }, (_, n) => n ? `other${n}.ts` : 'renamed.ts'))], ['renamed.ts']);
    expect(report.pairs[0]).toMatchObject({ path: 'renamed.ts', partner: 'b.ts', shared: 3, union: 5 });
    expect(report.eligibleCommits).toBe(5);
    expect(report.pairs.some(p => /vendor|retired|generated/.test(p.partner))).toBe(false);
  });
  it('leaves ambiguous/copy/reused identities unknown and never upgrades a truncated history', () => {
    const report = history([commit(1), commit(2), commit(3), { ...commit(4, []), files: [
      { status: 'R080', from: 'a.ts', path: 'moved.ts' }, { status: 'R090', from: 'b.ts', path: 'moved.ts' }] }]);
    expect(report.unknownPaths).toContain('moved.ts'); expect(report.pairs).toEqual([]);
    expect(coChangeFromCommits({ commits: [commit(1), commit(2), commit(3)], paths: ['a.ts'], end: END,
      commit: null, complete: false }).status).toBe('unknown');
  });
  it('joins exact invocation/session/assignment and current symbol bytes without authorship', () => {
    expect(provenance()[0]).toMatchObject({ status: 'measured', workItem: 'WI-responsible', symbol: 'work',
      edits: [{ invocation: 'invocation-7', session: 'session-exact', owner: 'su-editor', workItem: 'WI-responsible' }] });
    expect(provenance()[0]?.contentHash).toBe(createHash('sha256').update(source).digest('hex'));
  });
  it('keeps multiple/absent assignments, wrong sessions, stale bytes and partial ledgers unknown', () => {
    for (const patch of [{ assignments: [] }, { assignments: [assignment, { ...assignment, workItem: 'WI-other' }] },
      { edits: [{ ...edit, sessionOwners: ['su-other'] }] }, { edits: [{ ...edit, sessionOwners: ['su-editor', 'su-other'] }] },
      { source: source.replace('2', '3') }, { complete: false }, { edits: [{ ...edit, status: 'error' }] },
      { assignments: [{ ...assignment, end: edit.at }] }]) {
      expect(provenance(patch)[0]).toMatchObject({ status: 'unknown', workItem: null });
    }
  });
  it.each(['Write', 'MultiEdit', 'capability:edit'])('reads %s through the canonical hunk extractor', tool => {
    const input = tool === 'Write' ? { file_path: 'a.ts', content: source }
      : tool === 'MultiEdit' ? { file_path: 'a.ts', edits: [{ old_string: '1', new_string: 'return 2;' }] } : edit.input;
    expect(provenance({ edits: [{ ...edit, tool, input }] })[0]?.status).toBe('measured');
  });
  it('reports co-changing plan lanes and unanchored partners without claiming a dependency', () => {
    const report = history([commit(1), commit(2), commit(3)]);
    expect(coChangeOverlap(report, [{ itemId: 'P-001', paths: ['a.ts'] }, { itemId: 'P-002', paths: ['b.ts'] }]).pairs)
      .toContainEqual({ items: ['P-001', 'P-002'], paths: ['a.ts', 'b.ts'], shared: 3, union: 3 });
    expect(coChangeOverlap(report, [{ itemId: 'P-001', paths: ['a.ts'] }]).unanchored).toEqual(['b.ts']);
  });
  it.each(['claim', 'authoring', 'completion'] as const)('uses the P009 composition budget on %s', async surface => {
    const report = history([commit(1), commit(2), commit(3)]);
    const providers = changeHistoryProviders({ harness: 'papercusp', cochange: async () => report,
      provenance: async () => [priorReport([prior(1)])] });
    const result = await composeReuseBrief({ base: { mandatory: 'unchanged', sections: [] as ReuseContribution[] }, providers,
      context: { surface, paths: ['a.ts'], sourceVersion: 'source-v1', commit: report.commit,
        workspaceId: 'workspace', owner: 'su-editor', invocation: 'claim-real' }, deadline: Date.now() + 6000,
      append: (base, contribution) => ({ ...base, sections: [...base.sections, contribution] }) });
    expect(result.brief.mandatory).toBe('unchanged');
    expect(result.brief.sections.map(p => p.provider)).toEqual(['cochange', 'provenance']);
    expect(result.brief.sections[0]?.text).toContain(surface === 'completion' ? 'Untouched' : 'Unanchored');
    expect(result.brief.sections[1]?.text).toContain('Prior work on `work`: WI-1');
    expect(result.observations.map(row => row.status)).toEqual(['issued', 'issued']);
  });
  it('does not publish partial/stale provider results as measured absence', async () => {
    const providers = changeHistoryProviders({ cochange: async () => ({ ...history([]), status: 'unknown' }),
      provenance: async () => [{ ...priorReport([prior(1)]), error: 'statement timeout' }] });
    const context = { surface: 'claim' as const, paths: ['a.ts'], sourceVersion: 'source-v1', commit: 'other',
      workspaceId: 'workspace', owner: 'su-editor', invocation: 'claim-real' };
    for (const provider of providers) expect((await provider.read(context, new AbortController().signal)).status).toBe('unknown');
  });
  it('registers both producers once at P009 and rolls back duplicate installation', () => {
    const deps = { cochange: async () => history([]), provenance: async () => [priorReport([prior(1)])] };
    const dispose = registerChangeHistoryProviders(deps);
    try {
      expect(registeredReuseBriefProviders().filter(row => ['cochange', 'provenance'].includes(row.id)).map(row => row.id))
        .toEqual(['cochange', 'provenance']);
      expect(() => registerChangeHistoryProviders(deps)).toThrow('already registered');
    } finally { dispose(); }
    expect(registeredReuseBriefProviders().some(row => row.id === 'cochange')).toBe(false);
  });
});

describe('P013 actual commit reader', () => {
  it('reads full first-parent commit file sets from a real repository, never author names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cochange-'));
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', root, ...args])).stdout.trim();
    try {
      await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'not-provenance');
      for (let n = 0; n < 3; n++) {
        await writeFile(join(root, 'a.ts'), `export const a=${n};`); await writeFile(join(root, 'b.ts'), `export const b=${n};`);
        await git('add', 'a.ts', 'b.ts'); await git('commit', '-qm', `fixture-${n}`);
      }
      const result = await readCoChange(root, ['a.ts'], new Date(Date.now() + 2000).toISOString());
      expect(result.status).toBe('measured'); expect(result.pairs[0]).toMatchObject({ partner: 'b.ts', shared: 3, union: 3 });
      const graph = await graphQuery.handler({ op: 'cochange', paths: ['a.ts'] } as never,
        { projectDir: root, workspaceId: 'history-test' } as never) as { data: { pairs: { partner: string }[] } };
      expect(graph.data.pairs[0]?.partner).toBe('b.ts');
      const unscoped = await graphQuery.handler({ op: 'provenance', file_path: 'a.ts' } as never,
        { projectDir: root, workspaceId: 'history-test' } as never) as { data: { status: string } };
      expect(unscoped.data.status).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('not-provenance');
      const bad = boundChangeHistoryProviders({ root: async () => root, harness: 'fixture' });
      await expect(bad[0]!.read({ surface: 'claim', workspaceId: 'w', owner: 'o', invocation: 'i', paths: ['a.ts'],
        sourceVersion: 'stale', commit: result.commit }, new AbortController().signal)).rejects.toThrow('fingerprint');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports a window past the cap as incomplete, and a managed child can read the full window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'history-bounds-'));
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', root, ...args])).stdout.trim();
    try {
      await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'fixture');
      for (let n = 0; n < 3; n++) {
        await writeFile(join(root, 'a.ts'), `export const a=${n};`); await git('add', 'a.ts'); await git('commit', '-qm', `bounds-${n}`);
      }
      const end = new Date(Date.now() + 2000).toISOString();
      const capped = await readHistoryCommits(root, end, undefined, { ...IN_PROCESS_HISTORY_BOUNDS, cap: 2 });
      expect(capped).toMatchObject({ complete: false }); expect(capped.commits).toHaveLength(2);
      const exact = await readHistoryCommits(root, end, undefined, { ...IN_PROCESS_HISTORY_BOUNDS, cap: 3 });
      expect(exact).toMatchObject({ complete: true }); expect(exact.commits).toHaveLength(3);
      expect(await readHistoryCommits(root, end)).toMatchObject({ complete: true });
      expect((await readHistoryCommits(root, end, undefined, FULL_WINDOW_HISTORY_BOUNDS)).commits).toHaveLength(3);
      expect(IN_PROCESS_HISTORY_BOUNDS.cap).toBe(1000);
      expect(FULL_WINDOW_HISTORY_BOUNDS.cap).toBeGreaterThan(36_851);
      for (const cap of [0, 1.5, Number.NaN]) {
        await expect(readHistoryCommits(root, end, undefined, { ...IN_PROCESS_HISTORY_BOUNDS, cap })).rejects.toThrow('bounds');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reads names git would C-quote raw, and one unusual name never voids the window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'history-quoted-'));
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', root, ...args])).stdout.trim();
    // The Papercusp tree holds a junk file literally named "$LOG"; quoted, it voided 36,620 commits.
    const odd = ['"$LOG"', 'back\\slash.ts', 'sp ace.ts', 'tab\tin.ts', 'new\nline.ts'];
    try {
      await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'fixture');
      for (let n = 0; n < 3; n++) {
        await writeFile(join(root, 'a.ts'), `export const a=${n};`); await writeFile(join(root, 'b.ts'), `export const b=${n};`);
        await git('add', 'a.ts', 'b.ts'); await git('commit', '-qm', `pair-${n}`);
      }
      for (const name of odd) await writeFile(join(root, name), name);
      await git('add', '-A'); await git('commit', '-qm', 'odd names');
      await git('mv', 'sp ace.ts', 'moved "name".ts'); await git('commit', '-qm', 'rename odd');
      await git('commit', '-q', '--allow-empty', '-m', 'empty');
      const end = new Date(Date.now() + 2000).toISOString();
      const read = await readHistoryCommits(root, end);
      expect(read.complete).toBe(true);
      expect(read.commits).toHaveLength(6);
      expect(read.commits[0]!.files).toEqual([]);
      expect(read.commits[1]!.files).toEqual([{ status: 'R100', from: 'sp ace.ts', path: 'moved "name".ts' }]);
      expect(read.commits[2]!.files.map(f => f.path).sort()).toEqual([...odd].sort());
      const report = await readCoChange(root, ['a.ts'], end);
      expect(report).toMatchObject({ status: 'measured', complete: true });
      expect(report.pairs[0]).toMatchObject({ partner: 'b.ts', shared: 3, union: 3 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('parseHistoryLog (git log -z --name-status)', () => {
  const sha = (c: string) => c.repeat(40);
  const header = (s: string, parents: string, at = '2026-10-20T00:00:00Z') => `\x1e${s}\t${parents}\t${at}\0`;
  it('reads statuses and paths by position, so a path may hold any byte but NUL', () => {
    const log = header(sha('a'), sha('b')) + '\nM\0x.ts\0R087\0old\\name.ts\0\x1estarts-with-separator.ts\0A\0line\nbreak.ts\0'
      + header(sha('b'), '');
    const { commits, malformed } = parseHistoryLog(log);
    expect(malformed).toBe(false);
    expect(commits).toEqual([
      { sha: sha('a'), parents: [sha('b')], at: '2026-10-20T00:00:00Z', files: [
        { status: 'M', path: 'x.ts' },
        { status: 'R087', from: 'old\\name.ts', path: '\x1estarts-with-separator.ts' },
        { status: 'A', path: 'line\nbreak.ts' }] },
      { sha: sha('b'), parents: [], at: '2026-10-20T00:00:00Z', files: [] }]);
  });
  it('reports a broken record structure as malformed, never a partial measurement', () => {
    expect(parseHistoryLog('').malformed).toBe(false);
    expect(parseHistoryLog(`${header(sha('a'), '')}\nQ\0x.ts\0`).malformed).toBe(true);
    expect(parseHistoryLog(`${header(sha('a'), '')}\nR100\0only-one.ts\0`).malformed).toBe(true);
    expect(parseHistoryLog(`${header(sha('a'), '')}\nM\0\0`).malformed).toBe(true);
    expect(parseHistoryLog(`\x1e${sha('a')}\t${sha('b')}\0`).malformed).toBe(true);
    expect(parseHistoryLog('\nM\0orphan.ts\0').malformed).toBe(true);
  });
  it('keeps an unsafe rename endpoint out of co-change identity', () => {
    const renamed: HistoryCommit = { ...commit(4, []), files: [{ status: 'R090', from: 'a.ts', path: 'back\\slash.ts' }] };
    const report = history([commit(1), commit(2), commit(3), renamed]);
    expect(report.unknownPaths).toEqual(expect.arrayContaining(['a.ts', 'back\\slash.ts']));
    expect(report.pairs).toEqual([]);
  });
});

describe('buildCoChangeIndex + coChangeFromIndex (P-009)', () => {
  const at = (n: number, files: HistoryCommit['files']): HistoryCommit => ({ ...commit(n, []), files });
  const commits = [
    ...[1, 2, 3, 4].map(n => commit(n, ['a.ts', 'b.ts', 'c.ts'])),
    at(5, [{ status: 'R090', from: 'c.ts', path: 'd.ts' }]),
    ...[6, 7, 8].map(n => commit(n, ['a.ts', 'd.ts', 'e.ts'])),
    at(9, [{ status: 'A', path: 'c.ts' }]),
  ];
  const input = { commits, end: END, commit: 'a'.repeat(40), complete: true };

  it('answers exactly what coChangeFromCommits answers, for every scope, from one prepared window', () => {
    const index = buildCoChangeIndex(input);
    for (const paths of [['a.ts'], ['b.ts'], ['a.ts', 'd.ts'], ['c.ts'], ['e.ts']]) {
      expect(coChangeFromIndex(index, paths)).toEqual(coChangeFromCommits({ ...input, paths }));
    }
    // Re-adding the retired c.ts breaks the c.ts -> d.ts identity: both are unknown.
    expect([...index.unknown].sort()).toEqual(['c.ts', 'd.ts']);
  });

  it('restricts partners to the requested scope and applies the limit after sorting', () => {
    const index = buildCoChangeIndex(input);
    const all = coChangeFromIndex(index, ['a.ts']);
    expect(all.pairs.map(p => [p.partner, p.shared])).toEqual([['b.ts', 4], ['e.ts', 3]]);
    const scoped = coChangeFromIndex(index, ['a.ts'], { partners: ['e.ts'] });
    expect(scoped.pairs.map(p => p.partner)).toEqual(['e.ts']);
    expect(scoped.limitations).toContain('Partners restricted to the requested scope.');
    expect(coChangeFromIndex(index, ['a.ts'], { limit: 1 }).pairs).toEqual(all.pairs.slice(0, 1));
  });

  it('refuses an unsafe scope, a negative limit and an invalid window end', () => {
    const index = buildCoChangeIndex(input);
    expect(() => coChangeFromIndex(index, ['back\\slash.ts'])).toThrow(/Invalid history scope/);
    expect(() => coChangeFromIndex(index, ['a.ts'], { limit: -1 })).toThrow(/non-negative/);
    expect(() => buildCoChangeIndex({ ...input, end: 'not a date' })).toThrow(/Invalid history scope/);
  });
});

