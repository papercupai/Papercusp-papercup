import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import { codeIntelPushText, CODE_INTEL_PUSH_COMMIT_RESERVE_MS, CODE_INTEL_PUSH_MAX_CHARS, CODE_INTEL_PUSH_TURN_CHARS, CODE_INTEL_PUSH_WALL_MS, PUSH_LEG_FLAGS, firstTouchPaths, normalizePushCall, readPushSourceLinks, shellReadPaths, snapshotFirstTouchLeg, snapshotInterfaceLeg, snapshotIncidentLeg, snapshotGrepLeg, grepLookupSubject, type FirstTouchContext, type PushChannelDeps, type PushFact } from './push-channel';
import { corroboratePushSources, parsePushSnapshot, PUSH_SNAPSHOT_MAX_AGE_MS, type PushProofSource } from './push-snapshot';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { dependencySnapshotPath } from './dependency-snapshot-path';
import { readPushIncidentAttribution, readPushPriorWork, priorWorkSubject, pushLegRank, type PushInput, type PushLegId, type ReadPriorWorkContextDeps } from './push-channel';
import { priorWorkReport, type PriorWorkLedgerRow } from './change-history';
import { classifyShellLookup } from './native-adoption';
import { cachedLegFollowThrough, formatPushFact, LEG_FOLLOW_THROUGH_REFRESH_MS, rankPushFacts, reachedTestsText, resetLegFollowThroughCache, withCallableSuggestion, type LegFollowThrough } from './push-channel';
import { toolsetFromNames, UNKNOWN_TOOLSET } from './push-toolset';
import { EMPTY_PUSH_NOTE_MS, noteEmptyPush, resetEmptyPushNotes } from './push-channel';
import { pushSnapshotMissReason } from './push-snapshot';

const now = Date.now();
const raw = () => ({ schema: 'graph-dependency-snapshot-v1', index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
  generatedAt: new Date(now).toISOString(), edges: [
    { importer: 'app/use.ts', imported: 'lib/target.ts', importerSha256: 'b'.repeat(64) },
    { importer: 'lib/target.test.ts', imported: 'lib/target.ts', importerSha256: 'c'.repeat(64) },
  ] });
const snapshot = () => parsePushSnapshot(JSON.stringify(raw()), now)!;
const input = { owner: 'agent-A', workspace: 'ws-A', harness: 'papercusp', calls: [{ tool: 'Read', toolInput: { file_path: 'lib/target.ts' } }] };
const fact: PushFact = { leg: 'first-touch', subject: 'lib/target.ts', text: 'Static consumer: app/use.ts; runtime execution unknown.', citedPaths: ['app/use.ts'] };
function deps(): PushChannelDeps {
  return { snapshot: vi.fn(async () => snapshot()), enabled: vi.fn(async () => true),
    legs: () => new Map([['first-touch', () => [fact]]]),
    commit: vi.fn(async (_input, _snapshot, facts: readonly PushFact[]) => facts.map(f => f.text).join('\n')) };
}

describe('P-008 prior work on first touch', () => {
  const source = 'export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n';
  const row = (n: number, symbol: string, patch: Partial<PriorWorkLedgerRow> = {}): PriorWorkLedgerRow => ({
    workItem: `WI-${n}`, title: `Item ${n}`, state: 'done', kind: 'task', visible: true, measured: true,
    lastEditAt: new Date(now - n * 3_600_000).toISOString(), closedAt: null, symbols: [symbol], ...patch });
  // Fixture ledger: five items on alpha (an older bug among them, one item in two rows), one on beta.
  const ledger = [row(1, 'alpha'), row(2, 'alpha'), row(2, 'alpha'), row(3, 'alpha'), row(4, 'alpha'),
    row(9, 'alpha', { kind: 'bug' }), row(5, 'beta')];
  async function push(calls: PushInput['calls'], patch: Partial<ReadPriorWorkContextDeps> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'prior-work-'));
    await mkdir(join(root, 'lib'), { recursive: true }); await writeFile(join(root, 'lib/target.ts'), source);
    const read = vi.fn<ReadPriorWorkContextDeps['read']>(async query => priorWorkReport({ path: query.path, names: query.names,
      truncated: false, rows: ledger.filter(r => query.names === null || r.symbols.some(s => query.names!.includes(s))) }));
    const priorDeps: ReadPriorWorkContextDeps = { claim: async () => 'WI-mine', noted: async () => [],
      source: async (base, path) => (await import('node:fs/promises')).readFile(join(base, path), 'utf8'), read, ...patch };
    const d: PushChannelDeps = { ...deps(), legs: () => new Map([['first-touch', snapshotFirstTouchLeg]]),
      context: async (pushInput, paths) => ({ docs: null, specs: null, locks: null,
        priorWork: await readPushPriorWork(pushInput, paths, priorDeps) }) };
    try {
      const text = await codeIntelPushText({ ...input, root, calls }, d);
      const facts = vi.mocked(d.commit).mock.calls[0]?.[2] ?? [];
      return { text, read, prior: facts.filter(fact => fact.subject.startsWith('prior-work:')) };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  it('a Read of a function with several prior items yields one capped, ranked, bare line', async () => {
    const { text, prior, read } = await push([{ tool: 'Read', toolInput: { file_path: 'lib/target.ts', offset: 1, limit: 3 } }]);
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ leg: 'first-touch', bare: true, citedPaths: ['lib/target.ts'],
      subject: priorWorkSubject('WI-mine', 'lib/target.ts', ['alpha']) });
    const line = text.split('\n').find(l => l.startsWith('Prior work on `alpha`:'))!;
    expect([...line.matchAll(/(WI-\d+) \(/g)].map(m => m[1])).toEqual(['WI-9', 'WI-1', 'WI-2']); // bug first, then recency
    expect(line).toContain('. 5 total; more: graph:query');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ names: ['alpha'], excludeWorkItem: 'WI-mine' }));
  });
  it('an Edit triggers the note for the function it changed, and an unlocatable edit gives an unknown note', async () => {
    const edit = await push([{ tool: 'Edit', toolInput: { file_path: 'lib/target.ts', old_string: 'return 0;', new_string: 'return 2;' } }]);
    // One item, nothing omitted: the bare line, no total or pointer tail.
    expect(edit.prior.map(fact => fact.text)).toEqual(['Prior work on `beta`: WI-5 (Item 5, done, 5h).']);
    const lost = await push([{ tool: 'Edit', toolInput: { file_path: 'lib/target.ts', old_string: 'x', new_string: '' } }]);
    expect(lost.prior[0]?.text).toMatch(/^Prior work on `lib\/target\.ts`: unknown \(touched symbol not resolved\)/);
  });
  it('a second touch of the same symbol in the same session and work item yields no second note', async () => {
    const read = { tool: 'Read', toolInput: { file_path: 'lib/target.ts', offset: 2, limit: 1 } };
    const shown = async () => [priorWorkSubject('WI-mine', 'lib/target.ts', ['alpha'])];
    expect((await push([read], { noted: shown })).prior).toEqual([]);
    expect((await push([read], { noted: shown, claim: async () => 'WI-other' })).prior).toHaveLength(1);
    expect((await push([{ tool: 'Read', toolInput: { file_path: 'lib/target.ts', offset: 4, limit: 3 } }], { noted: shown })).prior)
      .toHaveLength(1); // beta was not shown yet
  });
});

describe('first-touch source-link diagnostics', () => {
  it.each([
    ['harness_docs', 'context.sourceLinks.docs'],
    ['spec_evidence_bindings', 'context.sourceLinks.specs'],
  ])('attributes SQLSTATE 57014 to the %s statement', async (table, phase) => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes(`harness_shared.${table}`)) throw failure;
      return [];
    });
    const sql = { begin: async (run: (tx: unknown) => unknown) => run(tx) } as unknown as Parameters<typeof readPushSourceLinks>[2];
    const diagnostics: NonNullable<Parameters<typeof readPushSourceLinks>[3]> = {
      readId: 'source-links-test', startedAtMs: Date.now(), phaseMs: {}, phaseOutcomes: {},
    };

    await expect(readPushSourceLinks(input, ['lib/target.ts'], sql, diagnostics)).rejects.toBe(failure);
    expect(diagnostics.phaseOutcomes[phase]).toBe('error');
    expect(diagnostics.phaseErrors?.[phase]).toBe('Error: [57014]: canceling statement due to statement timeout');
  });
});

describe('shared snapshot-backed push channel', () => {
  it('captures research before no-snapshot and disabled-leg early returns', async () => {
    const d = deps();
    d.research = vi.fn(async () => {});
    d.snapshot = vi.fn(async () => null);
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(d.research).toHaveBeenCalledWith(input);
    d.legs = () => new Map();
    await codeIntelPushText(input, d);
    expect(d.research).toHaveBeenCalledTimes(2);
  });
  it('corroborates scoped recent symbol observations and rejects stale or changed source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'push-incident-source-'));
    const text = 'export const changed = 3;';
    const sha256 = createHash('sha256').update(text).digest('hex');
    const tx = vi.fn(async () => []);
    const sql = { begin: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as Parameters<typeof readPushIncidentAttribution>[2];
    const row = { root, path: 'a.ts', workspace: input.workspace, harness: input.harness,
      agentId: input.owner, at: Date.now(), base: 'a'.repeat(40), beforeSha256: 'b'.repeat(64), sha256,
      symbols: [{ name: 'changed', line: 1 }] };
    const measured = (patch = {}) => ({ ...input, root,
      incidentAttribution: { status: 'measured', recentEdits: [{ ...row, ...patch }] } }) as PushInput;
    // Keep the positive fixture independent of wall-clock scheduling; test the
    // production deadline value and its fail-closed path explicitly below.
    const liveSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(liveSignal);
    try {
      await writeFile(join(root, 'a.ts'), text);
      expect((await readPushIncidentAttribution(measured(), ['a.ts'], sql)).changedSymbols).toEqual(['changed:a.ts:1']);
      expect(timeout).toHaveBeenCalledWith(75);
      for (const patch of [{ workspace: 'foreign' }, { root: '/foreign' }, { harness: 'foreign' },
        { agentId: 'another' }, { at: Date.now() - 86_400_001 }, { beforeSha256: sha256 }]) {
        expect((await readPushIncidentAttribution(measured(patch), ['a.ts'], sql)).changedSymbols).toEqual([]);
      }
      expect((await readPushIncidentAttribution(measured(), ['unrelated.ts'], sql)).changedSymbols).toEqual([]);
      const expired = new AbortController();
      expired.abort();
      timeout.mockReturnValue(expired.signal);
      expect((await readPushIncidentAttribution(measured(), ['a.ts'], sql)).changedSymbols).toEqual([]);
      timeout.mockReturnValue(liveSignal);
      await writeFile(join(root, 'a.ts'), 'export const changed = 4;');
      expect((await readPushIncidentAttribution(measured(), ['a.ts'], sql)).changedSymbols).toEqual([]);
    } finally {
      timeout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('automatically enriches observed failures, including structured native digests beyond the recall prefix', async () => {
    const d = deps();
    d.legs = () => new Map([['incident', snapshotIncidentLeg]]);
    d.incidentContext = vi.fn(async (_input: PushInput, _paths: string[]) => ({ status: 'measured' as const, changedSymbols: ['target:lib/target.ts:7'],
      workItems: [{ id: 'WI-42', state: 'open', paths: ['lib/target.ts'], relation: 'file-edit-ledger' as const }] }));
    d.toolset = async () => toolsetFromNames(['testing:run', 'testing:runs']);
    const calls = [{ tool: 'testing:run', toolResponse: 'truncated recall',
      incidentResult: { byFile: { 'lib/target.test.ts': { failed: 1, runId: 42 } } } }];
    const delivered = await codeIntelPushText({ ...input, calls }, d);
    expect(delivered).toContain('target:lib/target.ts:7');
    expect(delivered).toContain('WI-42 [open] (file-edit-ledger)');
    expect(delivered).toContain('"testRunIds":[42]');
    expect(d.incidentContext).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['lib/target.ts']));
    // P-006: a session never listed the testing tools still gets the run ids, but no call.
    const unlisted = deps();
    unlisted.legs = d.legs; unlisted.incidentContext = d.incidentContext;
    unlisted.toolset = async () => toolsetFromNames(['graph:query']);
    const bare = await codeIntelPushText({ ...input, owner: 'agent-unlisted', calls }, unlisted);
    expect(bare).toContain('Recorded failure rows: test run ids 42.');
    expect(bare).not.toMatch(/testing:runs?\b/);
  });
  const editCall = () => ({ tool: 'Edit', toolInput: { file_path: 'lib/target.ts' }, interfaceEdit: {
    path: 'lib/target.ts', base: 'a'.repeat(40), changes: ['signature target', 'required Result.name', 'behavioural strand risk'],
    checks: ['node scripts/check-required-field-strands.mjs --typecheck', 'node scripts/check-behavioural-strands.mjs'],
  } });

  it('merges interface and strand triggers with consumers and executable transitive tests', async () => {
    const snap = snapshot();
    snap.importers = new Map([['lib/target.ts', ['app/use.ts']], ['app/use.ts', ['app/use.test.ts']]]);
    const changed = { ...input, calls: [editCall()] };
    const facts = snapshotInterfaceLeg(changed, snap);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('app/use.ts');
    expect(facts[0].suggestedCall).toBe('testing:run {"files":["app/use.test.ts"],"harness":"papercusp"}');
    expect(facts[0].text).toContain(`--base ${'a'.repeat(40)} --files=lib/target.ts`);
    expect(facts[0].text).toContain('behavioural strand risk');
    expect(facts[0].text).toContain('predates this edit');
    const d = deps();
    d.snapshot = async () => snap;
    d.legs = () => new Map([['first-touch', snapshotFirstTouchLeg], ['interface', snapshotInterfaceLeg]]);
    const delivered = await codeIntelPushText(changed, d);
    expect(delivered).toContain('signature target');
    // P-006: the covering tests are inline; with no listed toolset the call is not kept.
    expect(facts[0].text).toMatch(/\nTests with static import reach(?: \(bounded\))?: app\/use\.test\.ts\.\n/);
    const { suggestedCall: _call, ...unsuggested } = facts[0];
    expect(d.commit).toHaveBeenCalledWith(changed, snap, [unsuggested], 1500, expect.any(AbortSignal), [], []);
  });

  it('P-006: keeps a follow-up call only for a tool the recipient was listed, and renders Next: only then', async () => {
    const snap = snapshot();
    snap.importers = new Map([['lib/target.ts', ['app/use.ts']], ['app/use.ts', ['app/use.test.ts']]]);
    const changed = { ...input, calls: [editCall()] };
    const [raw] = snapshotInterfaceLeg(changed, snap);
    const call = 'testing:run {"files":["app/use.test.ts"],"harness":"papercusp"}';
    expect(raw.text).not.toContain('testing:run');
    expect(withCallableSuggestion(raw, toolsetFromNames(['mcp__papercusp-su__testing_run'])).suggestedCall).toBe(call);
    for (const toolset of [UNKNOWN_TOOLSET, toolsetFromNames([]), toolsetFromNames(['testing:runs', 'graph:query'])]) {
      const kept = withCallableSuggestion(raw, toolset);
      expect(kept.suggestedCall).toBeUndefined();
      expect(formatPushFact(kept, snap)).not.toContain('Next:');
      expect(formatPushFact(kept, snap)).toContain('app/use.test.ts');
    }
    expect(formatPushFact(withCallableSuggestion(raw, toolsetFromNames(['testing:run'])), snap)).toContain(`Next: ${call}`);

    const listed = deps();
    listed.snapshot = async () => snap;
    listed.legs = () => new Map([['interface', snapshotInterfaceLeg]]);
    listed.toolset = vi.fn(async () => toolsetFromNames(['testing:run']));
    await codeIntelPushText(changed, listed);
    expect(listed.toolset).toHaveBeenCalledWith(expect.objectContaining({ owner: 'agent-A', workspace: 'ws-A' }));
    expect(vi.mocked(listed.commit).mock.calls[0][2][0].suggestedCall).toBe(call);

    // A failed or slow toolset read is unknown: the push still goes out, naming no tool.
    for (const toolset of [async () => { throw new Error('pool exhausted'); },
      () => new Promise<never>(() => {})] as PushChannelDeps['toolset'][]) {
      const failing = deps();
      failing.snapshot = async () => snap;
      failing.legs = listed.legs;
      failing.toolset = toolset;
      const text = await codeIntelPushText(changed, failing);
      expect(text).toContain('signature target');
      expect(vi.mocked(failing.commit).mock.calls[0][2][0].suggestedCall).toBeUndefined();
    }
  });

  it('P-006: names covering tests inline, capped at two with a count of the rest', () => {
    expect(reachedTestsText([])).toBe('unknown');
    expect(reachedTestsText(['a.test.ts'])).toBe('a.test.ts');
    expect(reachedTestsText(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'])).toBe('a.test.ts, b.test.ts (+2 more)');
  });

  it('pushes an observed failing-test incident with static hypotheses and explicit unknowns', () => {
    const snap = snapshot();
    snap.importers = new Map([
      ['lib/target.ts', ['app/use.ts']],
      ['app/use.ts', ['app/use.test.ts']],
    ]);
    snap.symbols = new Map([['target', [{
      id: 'target', name: 'target', path: 'lib/target.ts', line: 7, column: 1,
      sha256: 'b'.repeat(64), signature: 'function target()', aliases: ['target'], sources: undefined,
      callers: [],
    }]]]);
    const failedCall = {
      tool: 'testing:run',
      toolInput: { files: ['app/use.test.ts'], harness: 'papercusp' },
      toolResponse: { status: 'failed', byFile: { 'app/use.test.ts': { passed: 0, failed: 1, skipped: 0, runId: 42 } } },
    };
    const fact = snapshotIncidentLeg({ ...input, recipientToolset: toolsetFromNames(['testing:runs']), calls: [failedCall] }, snap)[0];
    // P-006: no listed testing:runs, no recovery call; the run id itself stays.
    const unlistedText = snapshotIncidentLeg({ ...input, calls: [failedCall] }, snap)[0]?.text;
    expect(unlistedText).toContain('Recorded failure rows: test run ids 42.');
    expect(unlistedText).not.toContain('testing:runs');
    expect(fact).toMatchObject({ leg: 'incident', subject: 'failed-tests:app/use.test.ts',
      suggestedCall: 'testing:run {"files":["app/use.test.ts"],"harness":"papercusp"}' });
    expect(fact?.citedPaths).toEqual(expect.arrayContaining(['app/use.test.ts', 'app/use.ts', 'lib/target.ts']));
    expect(fact?.text).toContain('Observed failing test files: app/use.test.ts');
    expect(fact?.text).toContain('Symbols on static reach (change status unknown): target:lib/target.ts:7');
    expect(fact?.text).toContain('testing:runs {"testRunIds":[42],"harness":"papercusp"}');
    expect(fact?.text).toContain('Work items changed/open on these paths: unknown');
    expect(snapshotIncidentLeg({ ...input, calls: [{
      tool: 'testing:run',
      toolResponse: { status: 'passed', byFile: { 'app/use.test.ts': { passed: 1, failed: 0, skipped: 0 } } },
    }] }, snap)).toEqual([]);
  });

  it('handles native MCP envelopes without calling refused selections failing files or crossing harnesses', () => {
    const response = { status: 'failed', byFile: {
      'app/use.test.ts': { failed: 1, runId: 42 }, 'app/pass.test.ts': { failed: 0, passed: 1, runId: 43 },
    }, testRunIds: [43, 42] };
    const call = { tool: 'mcp__papercusp_su__testing_run', toolInput: JSON.stringify({ harness: 'papercusp' }),
      toolResponse: { content: [{ type: 'text', text: JSON.stringify(response) }] } };
    const facts = snapshotIncidentLeg({ ...input, recipientToolset: toolsetFromNames(['testing:runs']), calls: [call] }, snapshot());
    expect(facts).toHaveLength(1);
    expect(facts[0].citedPaths).not.toContain('app/pass.test.ts');
    expect(facts[0].text).toContain('"testRunIds":[42]');
    expect(facts[0].text).not.toContain('43');
    expect(snapshotIncidentLeg({ ...input, calls: [{ ...call, toolInput: { harness: 'foreign' } }] }, snapshot())).toEqual([]);
    for (const toolResponse of [{ ok: false, error: 'invalid_root' }, { status: 'failed' }, { status: 'timeout' }]) {
      expect(snapshotIncidentLeg({ ...input, calls: [{ ...call, toolInput: { files: ['app/use.test.ts'] }, toolResponse }] }, snapshot())).toEqual([]);
    }
    const unknown = snapshotIncidentLeg({ ...input, calls: [{ ...call, toolResponse: {
      structuredContent: { byFile: { 'app/use.test.ts': { failed: 1 } } },
    } }] }, snapshot());
    expect(unknown[0].text).toContain('Original test-row identity unknown');
    expect(unknown[0].text).not.toContain('"testRunIds":[]');
  });

  it('renders only explicitly measured recent-change and work-item attribution', () => {
    const snap = snapshot();
    snap.importers = new Map([['lib/target.ts', ['app/use.test.ts']]]);
    const fact = snapshotIncidentLeg({ ...input, incidentAttribution: {
      status: 'measured', changedSymbols: ['target:lib/target.ts:7'],
      workItems: [{ id: 'WI-42', state: 'open', title: 'repair target', paths: ['lib/target.ts'] }],
    }, calls: [{ tool: 'testing:run', toolResponse: {
      status: 'failed', byFile: { 'app/use.test.ts': { failed: 1, runId: 9 } },
    } }] }, snap)[0];
    expect(fact?.text).toContain('Recently changed symbols (measured ledger attribution): target:lib/target.ts:7.');
    expect(fact?.text).toContain('Work items changed/open on these paths: WI-42 [open] repair target.');
    expect(fact?.text).toContain('Graph paths are hypotheses only');
  });

  it('keeps the measured answers when the cap and a Next pointer push lower lines out (WI-6554700010042393)', () => {
    const snap = snapshot();
    snap.importers = new Map([['lib/target.ts', ['app/use.test.ts']]]);
    const toolset = toolsetFromNames(['testing:run', 'testing:runs']);
    const raw = snapshotIncidentLeg({ ...input, recipientToolset: toolset, incidentAttribution: {
      status: 'measured', changedSymbols: ['target:lib/target.ts:7'],
      workItems: [{ id: 'WI-42', state: 'open', title: 'repair target '.repeat(8), paths: ['lib/target.ts'] }],
    }, calls: [{ tool: 'testing:run', toolResponse: {
      status: 'failed', byFile: { 'app/use.test.ts': { failed: 1, runId: 9 } },
    } }] }, snap)[0]!;
    const rendered = formatPushFact(withCallableSuggestion(raw, toolset), snap);
    expect(rendered).toContain('Next: testing:run');
    // P-006: the run ids are the answer and stay inline; measured attribution follows them.
    expect(rendered).toContain('Recorded failure rows: test run ids 9');
    expect(rendered).toContain('Recently changed symbols (measured ledger attribution): target:lib/target.ts:7.');
    // Static-graph hypotheses are what the cap drops; the marker keeps the runtime caveat.
    expect(rendered).not.toContain('Static reach candidates');
    expect(rendered).toMatch(/\(\+\d+ lines? omitted; static snapshot lower bounds; runtime unknown\)$/);
  });

  it('keeps absent reach unknown, bounds cycles and rejects untrusted path/base/commands', () => {
    const changed = { ...input, calls: [editCall()] };
    const snap = snapshot(); snap.importers = new Map();
    expect(snapshotInterfaceLeg(changed, snap)[0].text).toContain('Tests with static import reach: unknown');
    snap.importers = new Map(Array.from({ length: 250 }, (_, i) => [i === 0 ? 'lib/target.ts' : `chain${i}.ts`, [`chain${i + 1}.ts`]]));
    expect(snapshotInterfaceLeg(changed, snap)[0].text).toContain('(bounded)');
    for (const patch of [{ path: '../secret.ts' }, { base: 'HEAD' }, { path: 'a$(bad).ts' }, { changes: [] }]) {
      expect(snapshotInterfaceLeg({ ...input, calls: [{ ...editCall(), interfaceEdit: { ...editCall().interfaceEdit, ...patch } }] }, snap)).toEqual([]);
    }
    expect(snapshotInterfaceLeg({ ...input, calls: [{ ...editCall(), tool: 'Read' }] }, snap)).toEqual([]);
    const injected = editCall(); injected.interfaceEdit.checks = ['node scripts/check-required-field-strands.mjs ; arbitrary payload'];
    expect(snapshotInterfaceLeg({ ...input, calls: [injected] }, snap)[0].text).not.toContain('arbitrary payload');
  });
  it('does not spend the edit bound on preceding reads and accepts native multi-file patches', () => {
    const edit = editCall().interfaceEdit;
    const calls = [0, 1, 2].map(() => ({ tool: 'Read', interfaceEdit: edit }));
    calls.push({ tool: 'functions.apply_patch', interfaceEdits: [edit, { ...edit, path: 'lib/other.ts' }] } as any);
    expect(snapshotInterfaceLeg({ ...input, calls }, snapshot()).map(f => f.citedPaths[0]))
      .toEqual(['lib/target.ts', 'lib/other.ts']);
  });

  it('indexes static dependencies only and refuses foreign, stale and future snapshots', () => {
    expect(snapshot().importers.get('lib/target.ts')).toEqual(['app/use.ts', 'lib/target.test.ts']);
    for (const over of [
      { index: { ...raw().index, backend: 'gitnexus' } },
      { index: { ...raw().index, lastCommit: '' } },
      { generatedAt: new Date(now - PUSH_SNAPSHOT_MAX_AGE_MS - 1).toISOString() },
      { generatedAt: new Date(now + 300_001).toISOString() },
      { edges: [{ ...raw().edges[0], importer: '../secret.ts' }] },
    ]) expect(parsePushSnapshot(JSON.stringify({ ...raw(), ...over }), now)).toBeNull();
    expect(() => dependencySnapshotPath('../another-repo')).toThrow('Invalid snapshot');
  });

  it('keeps every registered leg ON by default', () => {
    // 6 original legs + resume, notes, R8 anti-pattern and P006 clone advisories.
    expect(Object.values(PUSH_LEG_FLAGS).map(flag => FLAG_DEFAULTS[flag])).toEqual(Array(10).fill(true));
  });

  it('uses the default nonblocking snapshot reader on the cold hook path', async () => {
    const [registry, home, workspace, snapshots, research] = await Promise.all([
      import('../harness-registry'), import('../harness/operator-home-harness'),
      import('../workspace-registry'), import('./push-snapshot'), import('./research-trail'),
    ]);
    const peek = vi.spyOn(snapshots, 'peekPushSnapshot').mockReturnValue(null);
    const spies = [peek,
      vi.spyOn(registry, 'loadHarnessRegistry').mockResolvedValue({
        projects: [{ slug: 'papercusp', path: '/repo' }],
      } as Awaited<ReturnType<typeof registry.loadHarnessRegistry>>),
      vi.spyOn(home, 'operatorHomeHarnessSlug').mockReturnValue('papercusp'),
      vi.spyOn(workspace, 'activeWorkspaceId').mockReturnValue(input.workspace),
      vi.spyOn(research, 'recordResearchBatch').mockResolvedValue(undefined),
    ];
    try {
      // Exercise production defaults, rather than injecting PushChannelDeps.
      expect(await codeIntelPushText(input)).toBe('');
      expect(peek).toHaveBeenCalledExactlyOnceWith('papercusp');
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('renders a first-touch snapshot witness while naming unmeasured symbol and runtime evidence', () => {
    const facts = snapshotFirstTouchLeg(input, snapshot());
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain('2 static file importers');
    expect(facts[0]?.text).toContain('runtime execution are unknown');
    expect(facts[0]?.suggestedCall).toBe('testing:run {"files":["lib/target.test.ts"],"harness":"papercusp"}');
    expect(snapshotFirstTouchLeg({ ...input, calls: [{ tool: 'Read', toolInput: { file_path: '/outside.ts' } }] }, snapshot())).toEqual([]);
    expect(snapshotFirstTouchLeg({ ...input, root: '/repo', calls: [{ tool: 'Read', toolInput: { file_path: '/repo/lib/target.ts' } }] }, snapshot())).toHaveLength(1);
    expect(snapshotFirstTouchLeg({ ...input, calls: [{ tool: 'mcp__papercusp_su__capability_read', toolInput: { file_path: 'lib/target.ts' } }] }, snapshot())).toHaveLength(1);
  });

  it('combines aliased export consumers, transitive test reach and scoped links without conflating lock domains', () => {
    const snap = snapshot();
    snap.importers = new Map([...snap.importers, ['app/use.ts', ['app/use.test.ts', 'lib/target.ts']]]);
    const symbol = { id: 'exported', name: 'target', path: 'lib/target.ts', line: 7, column: 1,
      sha256: 'b'.repeat(64), signature: 'function target()', aliases: ['target', 'alias'],
      sources: [{ path: 'lib/target.ts', sha256: 'b'.repeat(64) }],
      callers: [{ path: 'app/use.ts', line: 3, column: 1, sha256: 'c'.repeat(64), spelling: 'alias', workspace: '@other/app (app)' }] };
    snap.symbols = new Map([['target', [symbol]], ['alias', [symbol]]]);
    const facts = snapshotFirstTouchLeg({ ...input, root: '/repo', firstTouchContext: {
      docs: ['guides/api'], specs: ['plan#R-1@2'], locks: [
        { path: 'app/use.ts', owner: 'peer', intent: 'change API', goalRef: 'WI-1', coordinationDomain: '/repo' },
        { path: 'app/use.ts', owner: 'foreign', intent: 'another tree', coordinationDomain: '/elsewhere' },
        { path: 'app/use.ts', owner: input.owner, intent: 'self', coordinationDomain: '/repo' },
      ],
    } }, snap);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain('target:7 >=1 static calls [@other/app (app)]');
    expect(facts[0]?.text.match(/target:7/g)).toHaveLength(1);
    expect(facts[0]?.text).toContain('app/use.test.ts');
    expect(facts[0]?.text).toContain('guides/api');
    expect(facts[0]?.text).toContain('plan#R-1@2 (currentness unknown)');
    expect(facts[0]?.text).toContain('app/use.ts: peer WI-1');
    expect(facts[0]?.text).not.toContain('foreign');
    expect(facts[0]?.text).not.toContain('agent-A');
    expect(facts[0]?.text.length).toBeLessThan(1400);
  });

  it('bounds cyclic import traversal and names graph blindness instead of inventing exports', () => {
    const snap = snapshot();
    snap.importers = new Map(Array.from({ length: 600 }, (_, i) => [i === 0 ? 'lib/target.ts' : `chain${i}.ts`, [`chain${i + 1}.ts`]]));
    const facts = snapshotFirstTouchLeg(input, snap);
    expect(facts[0]?.text).toContain('(bounded search)');
    expect(facts[0]?.text).toContain('Exports (up to 3): unknown');
    expect(facts[0]?.text).toContain('Anchored docs: unknown');
    expect(facts[0]?.text).toContain('Live consumer locks/claims: unknown');
  });

  it('keeps batch source links attached to their own file', () => {
    const snap = snapshot();
    snap.importers = new Map([...snap.importers, ['other.ts', ['other.test.ts']]]);
    const facts = snapshotFirstTouchLeg({ ...input, calls: [...input.calls, { tool: 'Edit', toolInput: { file_path: 'other.ts' } }],
      firstTouchContext: { docs: null, specs: null, locks: null, byPath: {
        'lib/target.ts': { docs: ['guides/target.md'], specs: ['target-plan#R-1@1'] },
        'other.ts': { docs: ['guides/other.md'], specs: [] },
      } } }, snap);
    expect(facts[0]?.text).toContain('guides/target.md');
    expect(facts[0]?.text).not.toContain('guides/other.md');
    expect(facts[1]?.text).toContain('guides/other.md');
    expect(facts[1]?.text).not.toContain('target-plan');
  });

  it('a slow first-touch context read falls back to the snapshot within the shared wall', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps();
      const context = vi.fn((_input: PushInput, _paths: string[],
        diagnostics: Parameters<NonNullable<PushChannelDeps['context']>>[2]) => {
        if (diagnostics) {
          diagnostics.phaseOutcomes['context.sourceLinks'] = 'running';
          diagnostics.phaseOutcomes['context.liveLockHoldings'] = 'running';
        }
        return new Promise<FirstTouchContext>(() => {});
      });
      d.context = context;
      expect(await codeIntelPushText(input, d)).toContain('Static consumer');
      expect(d.commit).toHaveBeenCalledOnce();
      const warningLine = warning.mock.calls.map(([line]) => String(line))
        .find(line => line.startsWith('[code-intel-first-touch-context]'));
      expect(warningLine).toBeDefined();
      const diagnostic = JSON.parse(warningLine!.slice(warningLine!.indexOf(']') + 2));
      expect(diagnostic).toMatchObject({
        event: 'wait-timeout',
        timeoutMs: 100,
        phaseOutcomes: {
          outerContext: 'timeout',
          underlyingCancellation: 'not-supported',
          'context.sourceLinks': 'running',
          'context.liveLockHoldings': 'running',
        },
      });
      expect(diagnostic.readId).toBe(context.mock.calls[0]?.[2]?.readId);
      vi.mocked(d.enabled).mockResolvedValue(false);
      context.mockClear();
      expect(await codeIntelPushText(input, d)).toBe('');
      expect(d.context).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('an Edit still receives its snapshot-qualified brief after changing the source', async () => {
    const d = deps();
    d.legs = () => new Map([['first-touch', snapshotFirstTouchLeg]]);
    const changed = { ...input, root: '/now-changed', calls: [{ tool: 'Edit', toolInput: { file_path: 'lib/target.ts' } }] };
    const text = await codeIntelPushText(changed, d);
    expect(text).toContain('Snapshot lower bounds only');
    expect(text).toContain('current source hashes');
    expect(d.commit).toHaveBeenCalledOnce();
  });

  it('P-005: delivers immediately from its own turn budget, never what memory left over', async () => {
    const d = deps();
    expect(await codeIntelPushText(input, d)).toContain('Static consumer');
    expect(d.commit).toHaveBeenCalledWith(input, expect.objectContaining({ commit: 'a'.repeat(40) }), [fact],
      CODE_INTEL_PUSH_TURN_CHARS, expect.any(AbortSignal), [], []);
  });

  it('a cold/missing snapshot or an OFF leg never starts a compiler or writes telemetry', async () => {
    const d = deps();
    vi.mocked(d.snapshot).mockResolvedValueOnce(null);
    expect(await codeIntelPushText(input, d)).toBe('');
    vi.mocked(d.enabled).mockResolvedValue(false);
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('does not clip oversized facts or persist unsafe paths', async () => {
    const d = deps();
    const oversized = { ...fact, text: 'x'.repeat(CODE_INTEL_PUSH_TURN_CHARS) };
    d.legs = () => new Map([['first-touch', () => [oversized, { ...fact, citedPaths: ['/private/file'] }]]]);
    expect(await codeIntelPushText(input, d)).toBe('');
    // WI-6554700010018440: the oversized fact is delivered nowhere but handed to the commit
    // to record as a budget drop; the unsafe-path fact is rejected, not a budget loss.
    expect(d.commit).toHaveBeenCalledOnce();
    const [, , delivered, , , dropped] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([]);
    expect(dropped).toEqual([oversized]);
  });

  it('P-005: a fact whose push cannot fit the per-push cap even as whole lines is a drop', async () => {
    const d = deps();
    const wide = { ...fact, text: 'y'.repeat(CODE_INTEL_PUSH_MAX_CHARS) };
    d.legs = () => new Map([['first-touch', () => [wide, fact]]]);
    expect(await codeIntelPushText(input, d)).toContain('Static consumer');
    const [, , delivered, budget, , dropped] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([fact]);
    expect(budget).toBe(CODE_INTEL_PUSH_TURN_CHARS);
    expect(dropped).toEqual([wide]);
  });

  it('accepts serialized native Read/Edit inputs without guessing malformed or oversized digests', () => {
    for (const tool of ['Read', 'Edit', 'mcp__papercusp_su__capability_read', 'capability:edit']) {
      expect(firstTouchPaths({ ...input, calls: [{ tool, toolInput: JSON.stringify({ file_path: 'lib/target.ts' }) }] }))
        .toEqual(['lib/target.ts']);
    }
    for (const toolInput of ['{"file_path":"lib/target.ts"', 'null', '[]', '"lib/target.ts"',
      JSON.stringify({ file_path: 'lib/target.ts', extra: 'x'.repeat(4000) })]) {
      expect(firstTouchPaths({ ...input, calls: [{ tool: 'Read', toolInput }] })).toEqual([]);
      expect(grepLookupSubject({ tool: 'exec_command', toolInput })).toBeNull();
    }
  });

  it('G-5 (blind review 35): a write is a first touch in every tool vocabulary the working-set ledger counts', () => {
    for (const tool of ['Write', 'capability:write', 'mcp__papercusp-su__capability_write',
      'capability:read', 'mcp__papercusp-su__capability_edit']) {
      expect(firstTouchPaths({ ...input, calls: [{ tool, toolInput: { file_path: 'lib/target.ts' } }] })).toEqual(['lib/target.ts']);
    }
    // A tool merely ENDING in those letters is not a file touch.
    for (const tool of ['overwrite', 'Rewrite', 'docs:rewrite', 'unread']) {
      expect(firstTouchPaths({ ...input, calls: [{ tool, toolInput: { file_path: 'lib/target.ts' } }] })).toEqual([]);
    }
  });

  describe('WI-6554700010018441: wrapped and shell reads are first touches', () => {
    const rooted = { ...input, root: '/repo' };
    const touch = (tool: string, toolInput: unknown, base: PushInput = rooted) => firstTouchPaths({ ...base, calls: [{ tool, toolInput }] });

    it('unwraps tools:invoke to the capability call it dispatched, in object and serialized form', () => {
      for (const tool of ['mcp__papercusp-su__tools_invoke', 'tools:invoke']) {
        for (const name of ['capability:read', 'capability:edit', 'capability:write']) {
          expect(touch(tool, { name, args: { file_path: '/repo/lib/target.ts' } })).toEqual(['lib/target.ts']);
          expect(touch(tool, JSON.stringify({ name, args: { file_path: 'lib/target.ts' } }))).toEqual(['lib/target.ts']);
        }
      }
      expect(normalizePushCall({ tool: 'tools:invoke', toolInput: { name: 'capability:read', args: { file_path: 'x' } }, toolResponse: 'r' }))
        .toEqual({ tool: 'capability:read', toolInput: { file_path: 'x' }, toolResponse: 'r' });
    });

    it('a wrapper that dispatched no file tool, or carries no name, is not a touch', () => {
      expect(touch('tools:invoke', { name: 'coord:send', args: { file_path: 'lib/target.ts' } })).toEqual([]);
      expect(touch('tools:invoke', { args: { file_path: 'lib/target.ts' } })).toEqual([]);
      expect(touch('tools:invoke', '{"name":"capability:read"')).toEqual([]);
      // The wrapper's own name is not reclassified as anything else.
      expect(normalizePushCall({ tool: 'tools:invoke', toolInput: null })).toEqual({ tool: 'tools:invoke', toolInput: null });
    });

    it.each([
      ["sed -n '1,40p' lib/target.ts"],
      ['cat lib/target.ts'],
      ['head -n 20 lib/target.ts'],
      ['head -20 lib/target.ts | grep foo'],
      ['tail -n 5 /repo/lib/target.ts'],
      ['sed -n -e 1,5p ./lib/target.ts'],
      ['cd /repo || exit 1; cat "lib/target.ts"'],
      ['cd /repo/lib && cat target.ts'],
    ])('reads lib/target.ts from a shell read: %s', command => {
      for (const tool of ['Bash', 'mcp__papercusp-su__capability_bash', 'capability:bash', 'exec_command']) {
        expect(touch(tool, { command })).toEqual(['lib/target.ts']);
      }
      expect(touch('mcp__papercusp-su__tools_invoke', { name: 'capability:bash', args: { cmd: command } })).toEqual(['lib/target.ts']);
    });

    it('resolves relative operands against a capability:bash cwd, absolute or root-relative', () => {
      expect(touch('capability:bash', { cmd: 'cat target.ts', cwd: '/repo/lib' })).toEqual(['lib/target.ts']);
      expect(touch('capability:bash', { cmd: 'cat target.ts', cwd: 'lib' })).toEqual(['lib/target.ts']);
    });

    it.each([
      ['cat "$F"'],
      ['cat lib/*.ts'],
      ['cat ~/lib/target.ts'],
      ['grep -rn foo lib/target.ts | head -5'],
      ['cat > lib/target.ts <<EOF'],
      ['cat <<EOF'],
      ['cd "$ROOT" && cat lib/target.ts'],
      ['cd lib && cat ../../outside.ts'],
      ['cat /etc/passwd'],
      ['ls lib/target.ts'],
    ])('does not guess a path from: %s', command => {
      expect(touch('Bash', { command })).toEqual([]);
    });

    it('never treats a sed script or a head/tail option value as a file', () => {
      expect(shellReadPaths("sed -n '1,5p' a.ts", '/r')).toEqual(['/r/a.ts']);
      expect(shellReadPaths("sed -e 's/x/y/' -n a.ts b.ts", '/r')).toEqual(['/r/a.ts', '/r/b.ts']);
      expect(shellReadPaths('head -n 20 a.ts', '/r')).toEqual(['/r/a.ts']);
      expect(shellReadPaths('tail --lines 20 a.ts', '/r')).toEqual(['/r/a.ts']);
      expect(shellReadPaths('cat a.ts', undefined)).toEqual([]);
      expect(shellReadPaths('cat ' + 'a'.repeat(4001), '/r')).toEqual([]);
    });

    it('without a registered root, an absolute shell operand is not a snapshot path', () => {
      expect(touch('Bash', { command: 'cat /repo/lib/target.ts' }, input)).toEqual([]);
    });

    it('every registered leg receives the call a tools:invoke wrapper dispatched, not the wrapper', async () => {
      const seen: Array<string | undefined> = [];
      const d = deps();
      d.legs = () => new Map([['incident', (legInput: PushInput) => { seen.push(...legInput.calls.map(call => call.tool)); return []; }]]);
      await codeIntelPushText({ ...input, calls: [
        { tool: 'mcp__papercusp-su__tools_invoke', toolInput: { name: 'testing:run', args: { files: ['lib/target.test.ts'] } }, toolResponse: 'r' },
        { tool: 'Read', toolInput: { file_path: 'lib/target.ts' } },
      ] }, d);
      expect(seen).toEqual(['testing:run', 'Read']);
    });

    it('the grep leg sees a search dispatched through tools:invoke', () => {
      expect(grepLookupSubject({ tool: 'mcp__papercusp-su__tools_invoke',
        toolInput: { name: 'capability:bash', args: { cmd: 'grep -rn "export function firstTouchPaths" packages' } } }))
        .toBe('firstTouchPaths');
      expect(grepLookupSubject({ tool: 'tools:invoke', toolInput: { name: 'Grep', args: { pattern: 'firstTouchPaths' } } }))
        .toBe('firstTouchPaths');
    });
  });

  it.each([false, true])('answers a literal grep with a unique snapshot symbol and aliases (serialized native input: %s)', serialized => {
    const snap = snapshot();
    snap.symbols = new Map([['target', [{ id: 'target', name: 'target', path: 'lib/target.ts', line: 2, column: 1,
      sha256: 'b'.repeat(64), signature: 'function target()', aliases: ['target'], sources: [{ path: 'lib/target.ts', sha256: 'b'.repeat(64) }],
      callers: [{ path: 'app/use.ts', line: 3, column: 1, sha256: 'c'.repeat(64), spelling: 'alias', workspace: '@example/app (app)' }] }]]]);
    const toolInput = { cmd: "rg -n 'target\\(' packages" };
    const call = { tool: 'exec_command', toolInput: serialized ? JSON.stringify(toolInput) : toolInput };
    expect(grepLookupSubject(call)).toBe('target');
    const facts = snapshotGrepLeg({ ...input, calls: [call] }, snap);
    expect(facts[0]?.text).toContain('definition lib/target.ts:2');
    expect(facts[0]?.text).toContain('Aliases a literal grep can miss: alias');
    expect(facts[0]?.text).toContain('At least 1');
    expect(facts[0]?.text).toContain('@example/app (app): 1');
    expect(grepLookupSubject({ tool: 'Bash', toolInput: { command: "rg 'target|another'" } })).toBeNull();
    expect(snapshotGrepLeg({ ...input, calls: [{ tool: 'Grep', toolInput: { pattern: 'missing' } }] }, snap)).toEqual([]);
    snap.symbols.get('target')![0]!.sources = undefined;
    expect(snapshotGrepLeg({ ...input, calls: [call] }, snap)).toEqual([]);
  });

  describe('WI-6554700010019006: the grep trigger sees every search segment the P-033 instrument counts', () => {
    // Shapes measured from 837 live raw-text lookups (2026-10-21): 461 began with `cd <dir> || exit 1;`
    // and 121 had the search after an assignment or pipe; the first-segment trigger refused all of them.
    const bash = (command: string) => ({ tool: 'Bash', toolInput: { command } });
    it.each([
      ["cd /repo || exit 1; grep -rn 'export function summarizePlanVerification' --include=*.ts packages", 'summarizePlanVerification'],
      ["cd /repo && rg -n 'applyResultDoorAsync\\(' packages/operator-core/lib", 'applyResultDoorAsync'],
      ['f=packages/a.ts; grep -n "routeFreshKickoff(" $f', 'routeFreshKickoff'],
      ["git show HEAD:apps/x.mjs | rg -n -C 8 \"function routeFreshKickoff\"", 'routeFreshKickoff'],
      ["git -C /repo grep -n 'export const PUSH_LEG_FLAGS'", 'PUSH_LEG_FLAGS'],
      ["grep -rn --include='*.ts' 'canonicalJson' libs packages", 'canonicalJson'],
    ])('accepts %s', (command, subject) => {
      expect(grepLookupSubject(bash(command))).toBe(subject);
      expect(grepLookupSubject({ tool: 'mcp__papercusp-su__capability_bash', toolInput: { cmd: command } })).toBe(subject);
    });

    it.each([
      "cd /repo || exit 1; rg 'target|another' packages",
      "grep -rn -E 'evaluateGate\\(|readSnapshot\\(' packages",
      'cd /repo && sed -n 1,40p a.ts',
      "echo 'grep -rn fooBar' > note.txt",
    ])('still refuses %s', command => {
      expect(grepLookupSubject(bash(command))).toBeNull();
    });

    it('accepts every single-symbol lookup the instrument classifies (parity)', () => {
      const commands = [
        "cd /repo || exit 1; grep -rn 'export async function measure' packages",
        'S=x.ts; grep -n "fooBar(" $S | head -5',
        "( cd /repo && grep -rn 'class Widget' apps )",
        "sudo grep -rn 'interface PlanIndexItem' packages",
      ];
      for (const command of commands) {
        expect(classifyShellLookup(command), command).not.toBeNull();
        expect(grepLookupSubject(bash(command)), command).not.toBeNull();
      }
    });
  });

  it('suppresses drifted definitions, forwarding modules and callers before delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-intel-push-'));
    const text = 'export { target } from "./definition";';
    const sources = ['definition.ts', 'barrel.ts', 'caller.ts'].map(path => ({ path,
      sha256: createHash('sha256').update(text).digest('hex') }));
    const signal = new AbortController().signal;
    try {
      for (const source of sources) await writeFile(join(root, source.path), text);
      expect(await corroboratePushSources(root, sources, signal)).toBe(true);
      for (const source of sources) {
        await writeFile(join(root, source.path), '// changed');
        const d = deps();
        d.legs = () => new Map([['first-touch', () => [{ ...fact, sourceHashes: sources }]]]);
        expect(await codeIntelPushText({ ...input, root }, d)).toBe('');
        expect(d.commit).not.toHaveBeenCalled();
        await writeFile(join(root, source.path), text);
      }
      expect(await corroboratePushSources(root, Array(65).fill(sources[0]), signal)).toBe(false);
      expect(await corroboratePushSources(undefined, sources, signal)).toBe(false);
      expect(await corroboratePushSources(root, [{ ...sources[0]!, path: '../outside' }], signal)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // plan-item-code-anchors-2026-10-20#P-001 root cause: every symbol in a workspace carried that
  // workspace's package.json as a full-content proof source, so ANY manifest edit (a script, a
  // version, a dependency) suppressed every push for the package. Resolution reads only `name`.
  it('pins a workspace manifest by its name only, so unrelated package.json edits keep the push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-intel-manifest-'));
    const manifest = JSON.stringify({ name: '@fx/pkg', scripts: { test: 'vitest' } });
    const files: Record<string, string> = { 'pkg/package.json': manifest,
      'pkg/lib/target.ts': 'export function target() {}',
      'pkg/app/use.ts': 'import { target } from "../lib/target"; target();' };
    const paths = Object.keys(files);
    const signal = new AbortController().signal;
    const write = (path: string, text: string) => writeFile(join(root, path), text);
    try {
      for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await write(path, files[path]!); }
      const built = buildSymbolSnapshot({ files: paths, readSource: (file: string) => files[file] ?? null,
        resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(paths)),
        workspacePackages: [['@fx/pkg', ['pkg']]] });
      const sources = built.symbols.find((symbol: { name: string }) => symbol.name === 'target')!.sources as PushProofSource[];
      expect(sources.map(source => source.path)).toContain('pkg/package.json');
      const push = () => { const d = deps();
        d.legs = () => new Map([['first-touch', () => [{ ...fact, sourceHashes: sources }]]]);
        return codeIntelPushText({ ...input, root }, d); };
      expect(await push()).toContain('Static consumer');
      await write('pkg/package.json', JSON.stringify({ name: '@fx/pkg', version: '2.0.0', scripts: { test: 'vitest run' } }, null, 2));
      expect(await corroboratePushSources(root, sources, signal)).toBe(true);
      expect(await push()).toContain('Static consumer');
      for (const text of [JSON.stringify({ name: '@fx/renamed' }), '{ not json', '[]']) {
        await write('pkg/package.json', text);
        expect(await corroboratePushSources(root, sources, signal)).toBe(false);
        expect(await push()).toBe('');
      }
      await write('pkg/package.json', manifest);
      expect(await corroboratePushSources(root, sources, signal)).toBe(true);
      const unknown = sources.map(source => source.path.endsWith('package.json') ? { ...source, digest: 'unknown-v9' } : source);
      expect(await corroboratePushSources(root, unknown as PushProofSource[], signal)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails open for other context but never runs an abandoned commit after its wall', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    vi.mocked(d.snapshot).mockImplementation(() => new Promise(() => {}));
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
    vi.mocked(d.snapshot).mockResolvedValue(snapshot());
    vi.mocked(d.commit).mockRejectedValue(new Error('store unavailable'));
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code-intel-push exceeded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
    warn.mockRestore();
  });
});

// code-intel-delivery-and-outcomes-2026-10-26#P-002: the incident leg never committed a
// push. Its attribution read seq-scanned every open work-item (~300 ms against a 75 ms
// statement timeout) and it ran after the legs that wait, so the 250 ms wall fired first.
describe('P-002 incident leg reaches commit', () => {
  it('runs interface, then incident, then snapshot-only legs, then the legs that wait on a read', async () => {
    const ran: PushLegId[] = [];
    const d = deps();
    d.legs = () => new Map((['first-touch', 'grep', 'incident', 'interface', 'clone'] as PushLegId[])
      .map(id => [id, () => { ran.push(id); return []; }]));
    await codeIntelPushText(input, d);
    // WI-6554700010030085: registered last, grep used to run after the waiting legs and
    // the gather deadline cut it on every turn.
    expect(ran).toEqual(['interface', 'incident', 'grep', 'clone', 'first-touch']);
    expect([pushLegRank('interface'), pushLegRank('incident'), pushLegRank('grep'), pushLegRank('resume'),
      pushLegRank('notes'), pushLegRank('first-touch')]).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('reads open-on-path items through the partial GIN index predicates (migration 1595)', async () => {
    const queries: string[] = [];
    const tx = vi.fn(async (strings: TemplateStringsArray) => { queries.push(strings.join('$')); return []; });
    const sql = { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as Parameters<typeof readPushIncidentAttribution>[2];
    const result = await readPushIncidentAttribution(input as PushInput, ['lib/target.ts'], sql);
    expect(result).toEqual({ status: 'measured', changedSymbols: [], workItems: [] });
    const attribution = queries.find(text => text.includes('open-on-path'));
    // Both predicates are required: the first is the index's WHERE clause (so the
    // planner may use the partial index), the second is the indexable operator.
    expect(attribution).toContain("jsonb_typeof(w.payload->'paths') = 'array'");
    expect(attribution).toMatch(/\(w\.payload->'paths'\) \?\| \$::text\[\]/);
  });
});

// WI-6554700010030085: the legs and the commit shared the 250 ms wall, so a slow gather made
// the wall fire before the commit and every fact already gathered was lost, with no row in
// either ledger. Gathering now ends at a deadline that leaves the commit its reserve.
describe('WI-6554700010030085 push wall keeps a commit reserve', () => {
  const gatherMs = CODE_INTEL_PUSH_WALL_MS - CODE_INTEL_PUSH_COMMIT_RESERVE_MS;
  // Elapsed time comes from a synchronous spin, never a timer: under load a timer fires
  // late (it once landed past the deadline and cut the leg under test), and the wall's
  // own timer cannot preempt a spin.
  const spin = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };
  const slowSnapshot = (ms: number) => async () => { spin(ms); return snapshot(); };
  const grepFact: PushFact = { leg: 'grep', subject: 'grep:target', text: 'Grep answer.', citedPaths: ['app/use.ts'] };

  it('commits the facts gathered before the deadline and names the enabled legs it stopped', async () => {
    const d = deps();
    d.legs = () => new Map([
      ['first-touch', () => [fact]],
      ['grep', () => { spin(gatherMs + 10); return [grepFact]; }],
    ]);
    expect(await codeIntelPushText(input, d)).toContain('Grep answer.');
    expect(d.commit).toHaveBeenCalledOnce();
    const [, , delivered, , , dropped, notRun] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([grepFact]);
    expect(dropped).toEqual([]);
    expect(notRun).toEqual(['first-touch']);
  });

  it('a gather the snapshot alone exhausts records every enabled leg that had work, and only those', async () => {
    const d = deps();
    d.snapshot = slowSnapshot(gatherMs + 20);
    vi.mocked(d.enabled).mockImplementation(async flag => flag !== PUSH_LEG_FLAGS.grep);
    d.legs = () => new Map([['first-touch', () => [fact]], ['grep', () => [grepFact]], ['clone', () => []]]);
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(d.commit).toHaveBeenCalledOnce();
    const [, , delivered, , , dropped, notRun] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([]);
    expect(dropped).toEqual([]);
    // clone had no candidate for this batch, so the wall cost it nothing.
    expect(notRun).toEqual(['first-touch']);
  });

  it('never records a leg with no work as stopped: no read to wait on, no candidate', async () => {
    const d = deps();
    d.snapshot = slowSnapshot(gatherMs + 20);
    // No resume/notes read was started (no deps), and the snapshot leg has no candidate.
    d.legs = () => new Map([['resume', () => [fact]], ['notes', () => [fact]], ['grep', () => []]]);
    expect(await codeIntelPushText(input, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('caps a context read that starts late at the time the gather has left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps();
      d.snapshot = slowSnapshot(gatherMs - 30);
      d.context = () => new Promise<FirstTouchContext>(() => {});
      expect(await codeIntelPushText(input, d)).toContain('Static consumer');
      const line = warn.mock.calls.map(([l]) => String(l)).find(l => l.startsWith('[code-intel-first-touch-context]'));
      expect(line).toBeDefined();
      const diagnostic = JSON.parse(line!.slice(line!.indexOf(']') + 2));
      expect(diagnostic.event).toBe('wait-timeout');
      expect(diagnostic.timeoutMs).toBeGreaterThan(0);
      expect(diagnostic.timeoutMs).toBeLessThanOrEqual(30);
    } finally { warn.mockRestore(); }
  });

  it('names the phase when a commit overruns its reserve, and the wall still ends the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps();
      vi.mocked(d.commit).mockImplementation(() => new Promise(() => {}));
      expect(await codeIntelPushText(input, d)).toBe('');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(
        /^\[code-intel-push\] wall fired during commit after \d+ms with 1 fact\(s\) gathered$/));
    } finally { warn.mockRestore(); }
  });
});

// P-005 (WI-6554700010029479): 94% of 7-day skips were pushes of ~1,100-1,200 chars against
// a 1,500-char turn, so each push is now capped at 500 whole-line chars and the turn's
// budget goes to the legs agents act on most.
describe('P-005 compact pushes ranked by follow-through', () => {
  const pointer = 'Run code:pack lib/target.ts for the full brief.';
  const detail = Array.from({ length: 30 }, (_, i) => `detail ${i} ${'z'.repeat(30)}`);
  const long: PushFact = { ...fact, suggestedCall: 'code:pack lib/target.ts', text: ['Head line.', ...detail, pointer].join('\n') };

  it('renders at most the per-push cap from whole lines, keeps head and pointer, and counts what it left out', () => {
    const lines = formatPushFact(long, snapshot()).split('\n');
    expect(lines.join('\n').length).toBeLessThanOrEqual(CODE_INTEL_PUSH_MAX_CHARS);
    expect(lines.slice(0, 2)).toEqual(['## Code intelligence (first-touch) @aaaaaaaaaaaa', 'Head line.']);
    expect(lines.at(-2)).toBe(pointer);
    const omitted = Number(/^\(\+(\d+) lines omitted; /.exec(lines.at(-1)!)?.[1]);
    const kept = lines.slice(2, -2);
    // Never a cut line: every kept detail is a whole source line, in source order.
    expect(kept).toEqual(detail.slice(0, kept.length));
    expect(kept.length + omitted).toBe(detail.length);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('a fact that fits is rendered whole under its header, with no omitted marker', () => {
    expect(formatPushFact(fact, snapshot())).toBe(`## Code intelligence (first-touch) @aaaaaaaaaaaa\n${fact.text}`);
  });

  it('keeps long importer examples off the protected first line so a useful first-touch push fits', async () => {
    const target = 'lib/target.ts';
    const firstConsumer = `lib/${'nested-consumer/'.repeat(24)}first.ts`;
    const secondConsumer = `lib/${'another-consumer/'.repeat(24)}second.ts`;
    const current = parsePushSnapshot(JSON.stringify({ ...raw(), edges: [
      { importer: firstConsumer, imported: target, importerSha256: 'd'.repeat(64) },
      { importer: secondConsumer, imported: target, importerSha256: 'e'.repeat(64) },
      { importer: 'lib/target.test.ts', imported: target, importerSha256: 'f'.repeat(64) },
    ] }), now)!;
    const d = deps();
    d.snapshot = vi.fn(async () => current);
    d.legs = () => new Map([['first-touch', snapshotFirstTouchLeg]]);

    await codeIntelPushText({ ...input, calls: [{ tool: 'Read', toolInput: { file_path: target } }] }, d);

    const [, , delivered, , , dropped] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text.split('\n')[0]).toBe(`${target}: 3 static file importers in this snapshot.`);
    expect(formatPushFact(delivered[0], current).length).toBeLessThanOrEqual(CODE_INTEL_PUSH_MAX_CHARS);
    expect(dropped).toEqual([]);
  });

  it('ranks by trusted follow-through, gives thinly measured legs the trusted mean, and keeps ties stable', () => {
    const f = (leg: PushLegId, subject: string): PushFact => ({ ...fact, leg, subject });
    const facts = [f('first-touch', 'a'), f('resume', 'b'), f('grep', 'c'), f('interface', 'd')];
    expect(rankPushFacts(facts, null)).toEqual(facts);
    const rates = new Map<string, LegFollowThrough>([['first-touch', { rate: 0.1, measured: 50 }],
      ['resume', { rate: 0.4, measured: 50 }], ['grep', { rate: 0.9, measured: 3 }]]);
    // Prior = mean(0.1, 0.4) = 0.25 for grep (3 measurements) and interface (none).
    expect(rankPushFacts(facts, rates).map(x => x.subject)).toEqual(['b', 'c', 'd', 'a']);
    expect(rankPushFacts(facts, new Map([['grep', { rate: 1, measured: 1 }]]))).toEqual(facts);
  });

  it('commits facts in follow-through order, not gather order', async () => {
    const d = deps();
    const grepFact: PushFact = { leg: 'grep', subject: 'grep:target', text: 'Grep answer.', citedPaths: ['app/use.ts'] };
    d.legs = () => new Map([['first-touch', () => [fact]], ['grep', () => [grepFact]]]);
    d.legFollowThrough = () => new Map([['first-touch', { rate: 0.5, measured: 40 }], ['grep', { rate: 0.1, measured: 40 }]]);
    await codeIntelPushText(input, d);
    // grep is gathered first (snapshot-only leg) but agents act on first-touch more.
    expect(vi.mocked(d.commit).mock.calls[0][2].map(x => x.leg)).toEqual(['first-touch', 'grep']);
  });

  it('reads follow-through in the background at most hourly and never makes a push wait for it', async () => {
    resetLegFollowThroughCache();
    let resolve!: (rates: ReadonlyMap<string, LegFollowThrough>) => void;
    const measure = vi.fn(() => new Promise<ReadonlyMap<string, LegFollowThrough>>(r => { resolve = r; }));
    try {
      expect(cachedLegFollowThrough('ws-ft', measure, 1_000)).toBeNull();
      expect(cachedLegFollowThrough('ws-ft', measure, 2_000)).toBeNull();
      await vi.waitFor(() => expect(measure).toHaveBeenCalledOnce());
      resolve(new Map([['grep', { rate: 0.5, measured: 30 }]]));
      await vi.waitFor(() => expect(cachedLegFollowThrough('ws-ft', measure, 3_000)?.get('grep')?.rate).toBe(0.5));
      expect(measure).toHaveBeenCalledOnce();
      cachedLegFollowThrough('ws-ft', measure, 1_000 + LEG_FOLLOW_THROUGH_REFRESH_MS);
      await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(2));
    } finally { resetLegFollowThroughCache(); }
  });
});

// WI-6554700010042393: an installed hook got '' from every whole-push early return with no
// log line or ledger row. Each such return must now name its reason in the host log.
describe('empty-push diagnostics', () => {
  const noted = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(call => String(call[0]));
  async function emptyReason(build: (d: PushChannelDeps) => PushChannelDeps, pushInput: PushInput = input) {
    resetEmptyPushNotes();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      expect(await codeIntelPushText(pushInput, build(deps()))).toBe('');
      return [...noted(warn), ...noted(info)].filter(line => line.startsWith('[code-intel-push] empty: '));
    } finally { warn.mockRestore(); info.mockRestore(); resetEmptyPushNotes(); }
  }

  it('names each whole-push empty return', async () => {
    expect(await emptyReason(d => d, { ...input, calls: [] })).toEqual(['[code-intel-push] empty: missing-input']);
    expect(await emptyReason(d => ({ ...d, legs: () => new Map() }))).toEqual(['[code-intel-push] empty: no-legs']);
    expect(await emptyReason(d => ({ ...d, snapshot: vi.fn(async () => null) }))).toEqual(['[code-intel-push] empty: no-snapshot']);
    expect(await emptyReason(d => ({ ...d, legs: () => new Map([['first-touch', () => []]]) })))
      .toEqual(['[code-intel-push] empty: no-candidates (legs on: first-touch)']);
    expect(await emptyReason(d => ({ ...d, commit: vi.fn(async () => '') })))
      .toEqual(['[code-intel-push] empty: commit-empty (1 ranked fact(s))']);
  });

  it('notes at info, never warn, so callers under vitest-fail-on-console stay green', () => {
    resetEmptyPushNotes();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      noteEmptyPush('snapshot-loading', '/x/dependency-snapshot.json');
      noteEmptyPush('harness-not-home', 'other != papercusp');
      expect(warn).not.toHaveBeenCalled();
      expect(noted(info)).toEqual(['[code-intel-push] empty: snapshot-loading (/x/dependency-snapshot.json)',
        '[code-intel-push] empty: harness-not-home (other != papercusp)']);
    } finally { warn.mockRestore(); info.mockRestore(); resetEmptyPushNotes(); }
  });

  it('notes each reason at most once per EMPTY_PUSH_NOTE_MS', () => {
    resetEmptyPushNotes();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      noteEmptyPush('no-snapshot', '', 1_000);
      noteEmptyPush('no-snapshot', '', 1_000 + EMPTY_PUSH_NOTE_MS - 1);
      noteEmptyPush('push-error', 'gather: boom', 1_001);
      expect(info).toHaveBeenCalledTimes(2);
      noteEmptyPush('no-snapshot', '', 1_000 + EMPTY_PUSH_NOTE_MS);
      expect(info).toHaveBeenCalledTimes(3);
    } finally { info.mockRestore(); resetEmptyPushNotes(); }
  });

  it('reports why the snapshot cache answered null', () => {
    expect(pushSnapshotMissReason('never-peeked-repo-wi-6554700010042393')).toBe('loading');
  });
});
