import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import { codeIntelPushText, CODE_INTEL_PUSH_TURN_CHARS, PUSH_LEG_FLAGS, firstTouchPaths, snapshotFirstTouchLeg, snapshotInterfaceLeg, snapshotIncidentLeg, snapshotGrepLeg, grepLookupSubject, type FirstTouchContext, type PushChannelDeps, type PushFact } from './push-channel';
import { corroboratePushSources, parsePushSnapshot, PUSH_SNAPSHOT_MAX_AGE_MS } from './push-snapshot';
import { dependencySnapshotPath } from './dependency-snapshot-path';
import { readPushIncidentAttribution, type PushInput } from './push-channel';

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

describe('shared snapshot-backed push channel', () => {
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
    expect(d.commit).toHaveBeenCalledWith(changed, snap, [facts[0]], 1500, expect.any(AbortSignal));
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
      const context = vi.fn(() => new Promise<FirstTouchContext>(() => {}));
      d.context = context;
      expect(await codeIntelPushText(input, 0, d)).toContain('Static consumer');
      expect(d.commit).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('code-intel-first-touch-context exceeded'));
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
      CODE_INTEL_PUSH_TURN_CHARS - 350, expect.any(AbortSignal));
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
    d.legs = () => new Map([['first-touch', () => [
      { ...fact, text: 'x'.repeat(CODE_INTEL_PUSH_TURN_CHARS) },
      { ...fact, citedPaths: ['/private/file'] },
    ]]]);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
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
