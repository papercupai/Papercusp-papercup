import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import { codeIntelPushText, CODE_INTEL_PUSH_TURN_CHARS, PUSH_LEG_FLAGS, firstTouchPaths, normalizePushCall, readPushSourceLinks, shellReadPaths, snapshotFirstTouchLeg, snapshotInterfaceLeg, snapshotIncidentLeg, snapshotGrepLeg, grepLookupSubject, type FirstTouchContext, type PushChannelDeps, type PushFact } from './push-channel';
import { corroboratePushSources, parsePushSnapshot, PUSH_SNAPSHOT_MAX_AGE_MS, type PushProofSource } from './push-snapshot';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { dependencySnapshotPath } from './dependency-snapshot-path';
import { readPushIncidentAttribution, type PushInput } from './push-channel';
import { classifyShellLookup } from './native-adoption';

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
  it('captures research before no-snapshot, disabled-leg and text-budget early returns', async () => {
    const d = deps();
    d.research = vi.fn(async () => {});
    d.snapshot = vi.fn(async () => null);
    expect(await codeIntelPushText(input, CODE_INTEL_PUSH_TURN_CHARS, d)).toBe('');
    expect(d.research).toHaveBeenCalledWith(input);
    d.legs = () => new Map();
    await codeIntelPushText(input, 0, d);
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
    try {
      await writeFile(join(root, 'a.ts'), text);
      expect((await readPushIncidentAttribution(measured(), ['a.ts'], sql)).changedSymbols).toEqual(['changed:a.ts:1']);
      for (const patch of [{ workspace: 'foreign' }, { root: '/foreign' }, { harness: 'foreign' },
        { agentId: 'another' }, { at: Date.now() - 86_400_001 }, { beforeSha256: sha256 }]) {
        expect((await readPushIncidentAttribution(measured(patch), ['a.ts'], sql)).changedSymbols).toEqual([]);
      }
      expect((await readPushIncidentAttribution(measured(), ['unrelated.ts'], sql)).changedSymbols).toEqual([]);
      await writeFile(join(root, 'a.ts'), 'export const changed = 4;');
      expect((await readPushIncidentAttribution(measured(), ['a.ts'], sql)).changedSymbols).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('automatically enriches observed failures, including structured native digests beyond the recall prefix', async () => {
    const d = deps();
    d.legs = () => new Map([['incident', snapshotIncidentLeg]]);
    d.incidentContext = vi.fn(async (_input: PushInput, _paths: string[]) => ({ status: 'measured' as const, changedSymbols: ['target:lib/target.ts:7'],
      workItems: [{ id: 'WI-42', state: 'open', paths: ['lib/target.ts'], relation: 'file-edit-ledger' as const }] }));
    const delivered = await codeIntelPushText({ ...input, calls: [{ tool: 'testing:run', toolResponse: 'truncated recall',
      incidentResult: { byFile: { 'lib/target.test.ts': { failed: 1, runId: 42 } } } }] }, 0, d);
    expect(delivered).toContain('target:lib/target.ts:7');
    expect(delivered).toContain('WI-42 [open] (file-edit-ledger)');
    expect(delivered).toContain('"testRunIds":[42]');
    expect(d.incidentContext).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['lib/target.ts']));
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
    const delivered = await codeIntelPushText(changed, 0, d);
    expect(delivered).toContain('signature target');
    expect(d.commit).toHaveBeenCalledWith(changed, snap, [facts[0]], 1500, expect.any(AbortSignal), []);
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
    const fact = snapshotIncidentLeg({ ...input, calls: [{
      tool: 'testing:run',
      toolInput: { files: ['app/use.test.ts'], harness: 'papercusp' },
      toolResponse: { status: 'failed', byFile: { 'app/use.test.ts': { passed: 0, failed: 1, skipped: 0, runId: 42 } } },
    }] }, snap)[0];
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
    const facts = snapshotIncidentLeg({ ...input, calls: [call] }, snapshot());
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
    // 6 original legs + resume and notes (code-intel-epoch-carry-2026-10-20).
    expect(Object.values(PUSH_LEG_FLAGS).map(flag => FLAG_DEFAULTS[flag])).toEqual(Array(8).fill(true));
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
      expect(await codeIntelPushText(input, 0, d)).toContain('Static consumer');
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
      expect(await codeIntelPushText(input, 0, d)).toBe('');
      expect(d.context).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('an Edit still receives its snapshot-qualified brief after changing the source', async () => {
    const d = deps();
    d.legs = () => new Map([['first-touch', snapshotFirstTouchLeg]]);
    const changed = { ...input, root: '/now-changed', calls: [{ tool: 'Edit', toolInput: { file_path: 'lib/target.ts' } }] };
    const text = await codeIntelPushText(changed, 0, d);
    expect(text).toContain('Snapshot lower bounds only');
    expect(text).toContain('current source hashes');
    expect(d.commit).toHaveBeenCalledOnce();
  });

  it('delivers immediately from an available snapshot and gives memory its budget first', async () => {
    const d = deps();
    expect(await codeIntelPushText(input, 350, d)).toContain('Static consumer');
    expect(d.commit).toHaveBeenCalledWith(input, expect.objectContaining({ commit: 'a'.repeat(40) }), [fact],
      CODE_INTEL_PUSH_TURN_CHARS - 350, expect.any(AbortSignal), []);
    vi.mocked(d.commit).mockClear();
    expect(await codeIntelPushText(input, CODE_INTEL_PUSH_TURN_CHARS, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('a cold/missing snapshot or an OFF leg never starts a compiler or writes telemetry', async () => {
    const d = deps();
    vi.mocked(d.snapshot).mockResolvedValueOnce(null);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    vi.mocked(d.enabled).mockResolvedValue(false);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('does not clip oversized facts or persist unsafe paths', async () => {
    const d = deps();
    const oversized = { ...fact, text: 'x'.repeat(CODE_INTEL_PUSH_TURN_CHARS) };
    d.legs = () => new Map([['first-touch', () => [oversized, { ...fact, citedPaths: ['/private/file'] }]]]);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    // WI-6554700010018440: the oversized fact is delivered nowhere but handed to the commit
    // to record as a budget drop; the unsafe-path fact is rejected, not a budget loss.
    expect(d.commit).toHaveBeenCalledOnce();
    const [, , delivered, , , dropped] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([]);
    expect(dropped).toEqual([oversized]);
  });

  it('hands a fact that does not fit the memory-reduced share to the commit as a drop', async () => {
    const d = deps();
    expect(await codeIntelPushText(input, CODE_INTEL_PUSH_TURN_CHARS - 40, d)).toBe('');
    const [, , delivered, budget, , dropped] = vi.mocked(d.commit).mock.calls[0];
    expect(delivered).toEqual([]);
    expect(budget).toBe(40);
    expect(dropped).toEqual([fact]);
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
      ] }, 0, d);
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
        expect(await codeIntelPushText({ ...input, root }, 0, d)).toBe('');
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
        return codeIntelPushText({ ...input, root }, 0, d); };
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
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
    vi.mocked(d.snapshot).mockResolvedValue(snapshot());
    vi.mocked(d.commit).mockRejectedValue(new Error('store unavailable'));
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code-intel-push exceeded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
    warn.mockRestore();
  });
});
