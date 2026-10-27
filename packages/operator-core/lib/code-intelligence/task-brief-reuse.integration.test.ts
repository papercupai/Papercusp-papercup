import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskBrief, enrichTaskBriefWithReuse, getClaimTimeTaskBrief,
  registerTaskBriefReuseAdapter, type TaskBrief, type TaskBriefDeps } from './task-brief';
import { briefCodePoints, composeReuseBrief, createReuseBriefIdentity, decodeClaimReuseContribution,
  encodeClaimReuseContribution, REUSE_PROVIDER_POLICY, registerReuseBriefProvider,
  type ReuseBriefProvider, type ReuseContribution, type ReuseProviderId } from './reuse-brief-providers';
import { reuseIssuedSubjects, type ReuseIssuedRecord } from './reuse-brief-ledger';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { REUSE_PROVIDER_FLAGS, type ReuseProviderResult } from './reuse-brief-providers';

const dirs: string[] = [];
describe('D032 claim relationship protocol', () => {
  const base = { sourceFingerprint: 'a'.repeat(64) };
  const contribution: ReuseContribution = { provider: 'sql', section: 'impact',
    sourceVersion: base.sourceFingerprint, indexVersion: 'b'.repeat(64),
    text: 'reader "a.ts" \\ path 😀\nSQL static lower bound; execution unknown.\n' };
  it('round-trips exact multiline Unicode text and full index identity in the enclosing source', () => {
    const wire = encodeClaimReuseContribution(base, contribution);
    expect(wire).toBe('r1:' + JSON.stringify(['sql', 'impact', contribution.indexVersion, contribution.text]));
    expect(decodeClaimReuseContribution(base, wire)).toEqual(contribution);
    expect(decodeClaimReuseContribution(base, JSON.stringify(contribution))).toEqual(contribution);
    expect(base.sourceFingerprint).toBe('a'.repeat(64));
  });
  it.each([
    { ...contribution, sourceVersion: 'c'.repeat(64) },
    { ...contribution, sourceVersion: 'a'.repeat(12) },
    { ...contribution, provider: 'toString' },
    { ...contribution, provider: '__proto__' },
    { ...contribution, section: 'tests' },
    { ...contribution, indexVersion: '' },
    { ...contribution, indexVersion: '  ' },
    { ...contribution, text: '' },
  ])('rejects invalid or mismatched complete identities before encoding: %j', value => {
    expect(() => encodeClaimReuseContribution(base, value as ReuseContribution)).toThrow();
    expect(decodeClaimReuseContribution(base, JSON.stringify(value))).toBeNull();
  });
  it.each([null, '', 'a'.repeat(12), 'g'.repeat(64)])('rejects missing, shortened or non-hex enclosing source %s', sourceFingerprint => {
    const source = { sourceFingerprint };
    expect(() => encodeClaimReuseContribution(source, contribution)).toThrow();
    expect(decodeClaimReuseContribution(source, encodeClaimReuseContribution(base, contribution))).toBeNull();
    expect(decodeClaimReuseContribution(source, JSON.stringify(contribution))).toBeNull();
  });
  it.each([
    'r2:["sql","impact","exact-index","text"]', 'r1:', 'r1:null', 'r1:{}',
    'r1:["sql","tests","exact-index","text"]', 'r1:["toString","impact","exact-index","text"]',
    'r1:["__proto__","impact","exact-index","text"]', 'r1:["sql","impact","","text"]',
    'r1:["sql","impact",null,"text"]', 'r1:["sql","impact",42,"text"]',
    'r1:["sql","impact","exact-index",null]', 'r1:["sql","impact","exact-index",""]',
    'r1:["sql","impact","exact-index","text","extra"]', 'r1:["sql","impact","exact-index"]',
    'null', '[]', 'observed:callers:a.ts->b.ts',
  ])('keeps malformed and unknown relationship encodings out of evidence: %s', wire => {
    expect(decodeClaimReuseContribution(base, wire)).toBeNull();
  });
  it('preserves the exact full source on legacy contributions rather than rebinding them', () => {
    const other = { sourceFingerprint: 'c'.repeat(64) };
    expect(decodeClaimReuseContribution(other, JSON.stringify(contribution))).toBeNull();
  });
  it('retains the actual native base capacity falsifier even with optimistic missing-provider payloads', async () => {
    // Original failed run 20261025T090852Z-164710, invocation17. These are
    // retained data, not a fresh producer run or acceptance proof.
    const baseline: TaskBrief = {"status":"current","scope":{"harness":"test-runtime-ce3400cf-6e9","paths":["src/target.ts"]},"sourceFingerprint":"f432022558fd73a0226f57c00300310c32910aa117f7d9e17b020bdd025ea294","commit":"a8d355ea43fcaf0952f2d942c64185c7bc75f67d","files":[{"path":"src/target.ts","sha256":"00df9016c976083b4cd1bff8246720921d7591e571fb29cfee8cc555c247d181","kind":"implementation"}],"excerpts":[{"path":"src/target.ts","text":"// touched clone sibling in this private task\nimport { sql } from './partner';\nexport function aggregatePositive(values: number[]) {\n  let total = 0;\n  for (const value of values) { if (value > 0) total += value;\n  else total -= value;\n  } total += values.length;\n  total += values.length;\n  total += values.length;\n  total += values.length;\n  total "}],"graph":{"status":"unknown","consumers":[],"relationships":[],"reason":"Compiler evidence is unavailable or outside the measured task files."},"exclusions":["Governing decision bodies or unread authority remain at the canonical plan reader.","Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution."],"recover":{"tool":"code:pack","args":{"op":"pack","include":["src/target.ts"],"rootPath":"/tmp/pcv/papercusp-test-runtime-USSqzJ/workspaces/test-runtime-ce3400cf-6e9/operator-home"}},"repository":{"workspaceId":"test-runtime-ce3400cf-6e9","rootPath":"/tmp/pcv/papercusp-test-runtime-USSqzJ/workspaces/test-runtime-ce3400cf-6e9/operator-home"},"decisions":{"status":"unknown","refs":[],"recover":{"tool":"plans:get","args":{"slug":"p010-2026-10-25","harness":"test-runtime-ce3400cf-6e9","heading":"Decisions"}}},"incident":{"status":"measured","cause":"unknown","failures":[],"candidates":[],"recentChanges":[],"recentChangesStatus":"unknown","workRecord":"WI-1","runtimeExecution":"unmeasured","recover":{"tool":"work_items:get","args":{"id":"WI-1","harness":"test-runtime-ce3400cf-6e9"}},"limitations":["Selected task files and their latest normal test runs only; graph paths and recent edits are candidate causes.","Failure-log hashes identify recorded errors; no distinguishing causal test or runtime execution was measured."]},"engineering":{"intent":[],"rationale":[],"validation":[],"execution":[],"gaps":["no-visible-spec","intent-not-linked","rationale-not-linked","validation-not-linked","Only named child boundaries are observed; static anchors, test outcomes and parent spans do not observe their callees."],"recover":{"tool":"graph:query","args":{"op":"evidence","harnesses":["test-runtime-ce3400cf-6e9"],"plan":"p010-2026-10-25","item":"P-001"}}}};
    const observedWires: string[] = ["r1:[\"clones\",\"impact\",\"b82af50ca819\",\"Copy family src/sibling.ts:1 aggregateSibling; static match, review before reuse.\"]","r1:[\"cochange\",\"coChange\",\"9626a34a1834\",\"Unanchored src/partner.ts (4/4;90d)\"]","r1:[\"coverage\",\"tests\",\"41699cb445df8c917cb95eb06f2b847aee37b494597c50ac02a10e1f59d8266e\",\"src/target.ts: executed by src/target.test.ts.\"]"];
    const missing = [{"provider":"provenance","indexVersion":"866e195a3ae6"},{"provider":"sql","indexVersion":"b61837a42c522d6cca2a1d397aee130eff2bccdcbddc7059b1a13a006d9635c4"}] as { provider: ReuseProviderId; indexVersion: string }[];
    const observed = observedWires.map(wire => decodeClaimReuseContribution(baseline, wire)!);
    expect(observed.map(row => row.provider)).toEqual(['clones', 'cochange', 'coverage']);
    // A one-character missing payload is a deliberately optimistic lower bound.
    // Keep the exact observed indexes, policy destinations and enclosing source.
    const sourceVersion = baseline.sourceFingerprint;
    if (!sourceVersion) throw new Error('Retained native base must have its full source fingerprint');
    const optimistic = missing.map(row => ({ ...row, section: REUSE_PROVIDER_POLICY[row.provider].section,
      sourceVersion, text: 'x' }));
    const candidates = [...observed, ...optimistic].sort((a, b) =>
      REUSE_PROVIDER_POLICY[a.provider].priority - REUSE_PROVIDER_POLICY[b.provider].priority);
    const hypothetical = { ...baseline, graph: { ...baseline.graph,
      relationships: candidates.map(row => encodeClaimReuseContribution(baseline, row)) } };
    expect(briefCodePoints(JSON.stringify(baseline))).toBe(2628);
    expect(briefCodePoints(JSON.stringify(hypothetical))).toBe(3174);
    const before = JSON.stringify(baseline);
    const composed = await composeReuseBrief({ base: baseline, deadline: Date.now() + 6000,
      context: { surface: 'claim', workspaceId: 'retained', owner: 'su-retained', invocation: 'retained-capacity',
        paths: baseline.scope.paths, sourceVersion: baseline.sourceFingerprint },
      enabled: async () => true, providers: candidates.map(row => ({ id: row.provider, read: async () => ({
        status: 'measured' as const, sourceVersion: row.sourceVersion, indexVersion: row.indexVersion, lines: [row.text],
      }) })), append: (brief, row) => ({ ...brief, graph: { ...brief.graph,
        relationships: [...brief.graph.relationships, encodeClaimReuseContribution(brief, row)] } }) });
    expect(composed.observations.map(row => [row.provider, row.status])).toEqual([
      ['clones', 'issued'], ['cochange', 'issued'], ['provenance', 'issued'], ['sql', 'budget'], ['coverage', 'budget'],
    ]);
    expect(briefCodePoints(JSON.stringify(composed.brief))).toBeLessThanOrEqual(3000);
    expect(JSON.stringify(baseline)).toBe(before);
    expect({ ...composed.brief, graph: { ...composed.brief.graph, relationships: baseline.graph.relationships } }).toEqual(baseline);
  });
  it('fits all retained producer lines through the default adapter without changing base, charges or issued identity', async () => {
    // Original focused receipt21976156; retained log SHA256
    // 5565099db1494b02b385ea95bd177ffd2a82b3a04a98ab1bf6206e3ec7e1b731.
    // Data replay only: no sparse producer fixture or native acceptance rerun.
    const baseline: TaskBrief = {"status":"current","scope":{"harness":"r","paths":["a.ts"]},"sourceFingerprint":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","commit":"b05822520ebb9133e0235752fc72f07321b04456","files":[{"path":"a.ts","sha256":"5fd81ba1b31b98d97e4c8169d7b93f874be34271196395025999d8464d43262d","kind":"implementation"}],"excerpts":[{"path":"a.ts","text":"export function f(v:number[]){let t=0;for(const x of v){if(x>0)t+=x;else t-=x;}t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;t+=v.length;db.query(`UPDATE t SET x=1`);re"}],"graph":{"status":"unknown","consumers":[],"relationships":[],"reason":"Compiler evidence is unavailable or outside the measured task files."},"exclusions":["Governing decision bodies or unread authority remain at the canonical plan reader.","Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution."],"recover":{"tool":"code:pack","args":{"op":"pack","include":["a.ts"],"rootPath":"/tmp/pcv/r-HN5SDM"}},"repository":{"workspaceId":"default","rootPath":"/tmp/pcv/r-HN5SDM"},"decisions":{"status":"unknown","refs":[],"recover":{"tool":"plans:get","args":{"slug":"r-2026-10-25","harness":"r","heading":"Decisions"}}},"incident":{"status":"measured","cause":"unknown","failures":[],"candidates":[],"recentChanges":[],"recentChangesStatus":"unknown","workRecord":"WI-1","runtimeExecution":"unmeasured","recover":{"tool":"work_items:get","args":{"id":"WI-1","harness":"r"}},"limitations":["Selected task files and their latest normal test runs only; graph paths and recent edits are candidate causes.","Failure-log hashes identify recorded errors; no distinguishing causal test or runtime execution was measured."]},"engineering":{"intent":[],"rationale":[],"validation":[],"execution":[],"gaps":["no-visible-spec","intent-not-linked","rationale-not-linked","validation-not-linked","Only named child boundaries are observed; static anchors, test outcomes and parent spans do not observe their callees."],"recover":{"tool":"graph:query","args":{"op":"evidence","harnesses":["r"],"plan":"r-2026-10-25","item":"P-001"}}}};
    const captured: { provider: ReuseProviderId; result: ReuseProviderResult }[] = [{"provider":"clones","result":{"status":"measured","lines":["Copy family b.ts:1 g; static match, review before reuse."],"sourceVersion":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","indexVersion":"e8d3a969b06b","citedPaths":["b.ts"]}},{"provider":"cochange","result":{"status":"measured","sourceVersion":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","indexVersion":"5235fe51637a","citedPaths":["a.ts","b.ts"],"lines":["Unanchored b.ts (4/4;90d)"]}},{"provider":"provenance","result":{"status":"measured","sourceVersion":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","indexVersion":"acd983ae6739","citedPaths":["a.ts"],"lines":["a.ts#f: WI-1 (edit 1; current bytes)"]}},{"provider":"sql","result":{"status":"measured","lines":["SQL readers/writers (static lower bound): t write f a.ts:1","SQL readers/writers (static lower bound): t.x write f a.ts:1"],"sourceVersion":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","indexVersion":"7a9fb73bcb19e213c3c6084a3eff7c7f4d7854e1d186b313b7b9053bf743776a","citedPaths":["a.ts"]}},{"provider":"coverage","result":{"status":"measured","lines":["a.ts: static reach fallback; execution unknown."],"sourceVersion":"a0be886e1b8cff602abc5a48d18ee07ed6dd6f45a38c2d357ced998f85d0d676","indexVersion":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","citedPaths":["a.ts"]}}];
    const before = JSON.stringify(baseline), deps = await fixture();
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true);
    const providers = captured.map(({ provider: id, result }) => ({ id, read: async () => structuredClone(result) }));
    setFlagOverridesForTest(Object.fromEntries(captured.map(row => [REUSE_PROVIDER_FLAGS[row.provider], true])));
    try {
      const result = await enrichTaskBriefWithReuse(baseline, {
        workspaceId: 'default', workItem: { id: 'WI-1', harness: 'r', payload: { paths: ['a.ts'] } },
        reuse: { owner: 'su-retained', invocation: 'retained-wire-regression' },
      }, { ...deps, reuse: { providers, recordIssued: record } }, Date.now() + 6000);
      const contributions = result.graph.relationships.map(wire => decodeClaimReuseContribution(result, wire));
      expect(contributions).toEqual(captured.map(({ provider, result }) => ({
        provider, section: REUSE_PROVIDER_POLICY[provider].section, text: result.lines.join('\n'),
        sourceVersion: result.sourceVersion, indexVersion: result.indexVersion,
      })));
      expect(briefCodePoints(before)).toBe(2318);
      expect(briefCodePoints(JSON.stringify(result))).toBe(2985);
      expect(JSON.stringify(baseline)).toBe(before);
      expect({ ...result, graph: { ...result.graph,
        relationships: result.graph.relationships.slice(0, baseline.graph.relationships.length) } }).toEqual(baseline);
      expect(record).toHaveBeenCalledOnce();
      const issued = record.mock.calls[0]![0];
      expect(issued.observations.map(row => [row.provider, row.status, row.chars])).toEqual([
        ['clones', 'issued', 219], ['cochange', 'issued', 192], ['provenance', 'issued', 221],
        ['sql', 'issued', 332], ['coverage', 'issued', 263],
      ]);
      for (const row of issued.observations) expect(row.chars).toBeLessThanOrEqual(REUSE_PROVIDER_POLICY[row.provider].cap);
      expect(reuseIssuedSubjects(issued).map(({ subject }) => {
        const row = JSON.parse(subject);
        return [row.provider, row.invocation, row.sourceVersion, row.indexVersion];
      })).toEqual(captured.map(({ provider, result }) => [
        provider, 'retained-wire-regression', baseline.sourceFingerprint, result.indexVersion,
      ]));
    } finally { setFlagOverridesForTest(null); }
  });
});
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = (id: ReuseProviderId): ReuseBriefProvider => ({ id, read: async context => ({
  status: 'measured', lines: [`${id} target.ts:1; bounded static evidence only`],
  sourceVersion: context.sourceVersion, indexVersion: `index-${id}`, citedPaths: ['target.ts'],
}) });
const append = (base: TaskBrief, value: ReuseContribution): TaskBrief => ({ ...base,
  graph: { ...base.graph, relationships: [...base.graph.relationships, encodeClaimReuseContribution(base, value)] } });
const ref = { workspaceId: 'fixture-workspace', workItem: { id: 'WI-target', harness: 'fixture-harness',
  sourcePlanSlug: 'fixture-plan', sourcePlanItemIds: ['P-009'], payload: { paths: ['target.ts'] } } };
async function fixture(): Promise<TaskBriefDeps> {
  const root = await mkdtemp(join(tmpdir(), 'task-brief-reuse-')); dirs.push(root);
  await writeFile(join(root, 'target.ts'), 'export const target = 1;');
  return { root: async () => root, effects: { exec: async () => ({ stdout: '' }), now: () => new Date(), writeArtifact: async () => '' },
    graph: async () => { throw new Error('No named declaration in this source'); },
    pack: async (_op, args) => {
      const path = join(root, 'pack.xml');
      await writeFile(path, `<file path="target.ts">${await readFile(join(root, 'target.ts'), 'utf8')}</file>`);
      return { answer: { error: null, sites: args.include.map((path: string) => ({ path })) },
        artifact: { path, provenance: { commit: 'fixture-commit' } } } as never;
    } };
}

describe('P009 real taskBrief production adapter boundary', () => {
  it('retains the R20 native baseline capacity falsifier before another expensive replay', async () => {
    // Original failed native 21965707, source 853b255b; worker.log retained at
    // isolated-integration/20261025T040502Z-2431061/phases/execute/worker.log.
    // Only the observed optional clone contribution is excluded from the base.
    const base: TaskBrief = {
      status: 'current', scope: { harness: 'test-runtime-26aacbd5-00e', paths: ['src/target.ts'] },
      sourceFingerprint: 'f432022558fd73a0226f57c00300310c32910aa117f7d9e17b020bdd025ea294',
      commit: '2c79bc76d931cbf30d0f321aa9d9003afe69b0bf',
      files: [{ path: 'src/target.ts', sha256: '00df9016c976083b4cd1bff8246720921d7591e571fb29cfee8cc555c247d181', kind: 'implementation' }],
      excerpts: [{ path: 'src/target.ts', text: "// touched clone sibling in this private task\nimport { sql } from './partner';\nexport function aggregatePositive(values: number[]) {\n  let total = 0;\n  for (const value of values) { if (value > 0) total += value;\n  else total -= value;\n  } total += values.length;\n  total += values.length;\n  total += values.length;\n  total += values.length;\n  total " }],
      graph: { status: 'unknown', consumers: [], relationships: [], reason: 'Compiler evidence is unavailable or outside the measured task files.' },
      exclusions: ['Governing decision bodies or unread authority remain at the canonical plan reader.',
        'Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution.'],
      recover: { tool: 'code:pack', args: { op: 'pack', include: ['src/target.ts'], rootPath: '/tmp/pcv/papercusp-test-runtime-ANxILq/workspaces/test-runtime-26aacbd5-00e/operator-home' } },
      repository: { workspaceId: 'test-runtime-26aacbd5-00e', rootPath: '/tmp/pcv/papercusp-test-runtime-ANxILq/workspaces/test-runtime-26aacbd5-00e/operator-home' },
      decisions: { status: 'unknown', refs: [], recover: { tool: 'plans:get', args: { slug: 'p010-controlled-claim-2026-10-25', harness: 'test-runtime-26aacbd5-00e', heading: 'Decisions' } } },
      incident: { status: 'measured', cause: 'unknown', failures: [], candidates: [], recentChanges: [], recentChangesStatus: 'unknown',
        workRecord: 'WI-1', runtimeExecution: 'unmeasured', recover: { tool: 'work_items:get', args: { id: 'WI-1', harness: 'test-runtime-26aacbd5-00e' } },
        limitations: ['Selected task files and their latest normal test runs only; graph paths and recent edits are candidate causes.',
          'Failure-log hashes identify recorded errors; no distinguishing causal test or runtime execution was measured.'] },
      engineering: { intent: [], rationale: [], validation: [], execution: [],
        gaps: ['no-visible-spec', 'intent-not-linked', 'rationale-not-linked', 'validation-not-linked',
          'Only named child boundaries are observed; static anchors, test outcomes and parent spans do not observe their callees.'],
        recover: { tool: 'graph:query', args: { op: 'evidence', harnesses: ['test-runtime-26aacbd5-00e'], plan: 'p010-controlled-claim-2026-10-25', item: 'P-001' } } },
    };
    const expected = ['clones', 'cochange', 'provenance', 'sql', 'coverage'] as const;
    const before = JSON.stringify(base);
    expect(briefCodePoints(before)).toBe(2662);
    // Deliberately optimistic lower bound, NOT producer evidence or R20 credit:
    // one nonempty code point and a one-code-point index in every envelope.
    const providers = expected.map(id => ({ id, read: async () => ({ status: 'measured' as const,
      lines: ['x'], sourceVersion: base.sourceFingerprint, indexVersion: 'x' }) }));
    const minimum = expected.map(provider => ({ provider, section: REUSE_PROVIDER_POLICY[provider].section,
      text: 'x', sourceVersion: base.sourceFingerprint!, indexVersion: 'x' }));
    // Preserve the historical falsifier's old representation; r1 below has its
    // own retained-payload regression and does not rewrite historical proof.
    const legacyAppend = (brief: TaskBrief, value: ReuseContribution): TaskBrief => ({ ...brief,
      graph: { ...brief.graph, relationships: [...brief.graph.relationships, JSON.stringify(value)] } });
    const all = minimum.reduce(legacyAppend, structuredClone(base));
    // Even removing ALL excerpt text and BOTH complete authored plan names is
    // insufficient. This is arithmetic only: neither altered response is emitted.
    const optionalAuthoredChars = briefCodePoints(JSON.stringify(base.excerpts[0]!.text)) - 2
      + 2 * briefCodePoints('p010-controlled-claim-2026-10-25');
    expect(briefCodePoints(JSON.stringify(all)) - optionalAuthoredChars).toBeGreaterThan(3000);
    const result = await composeReuseBrief({ base, providers,
      context: { surface: 'claim', workspaceId: base.repository!.workspaceId, owner: 'controlled-lower-bound',
        invocation: 'capacity-only', workItem: 'WI-1', paths: base.scope.paths, sourceVersion: base.sourceFingerprint },
      append: legacyAppend, enabled: async () => true, deadline: Date.now() + 6000 });
    expect(JSON.stringify(base)).toBe(before);
    expect(briefCodePoints(JSON.stringify(result.brief))).toBeLessThanOrEqual(3000);
    expect(result.observations).toHaveLength(5);
    expect(result.observations.some(row => row.status === 'budget')).toBe(true);
    console.info('R20_COMPOSER_LOWER_BOUND', JSON.stringify({ baseChars: briefCodePoints(before),
      allMinimumChars: briefCodePoints(JSON.stringify(all)), optionalAuthoredChars,
      observations: result.observations, scope: 'historical actual base; optimistic envelopes only; no native acceptance credit' }));
  });

  it('uses the registered provider/adapter at claim time, preserves mandatory evidence and records dispatch identity', async () => {
    const deps = await fixture();
    // This fixture intentionally holds coverage out while exercising the
    // registered clone provider. Treatment/holdout coverage has its own case.
    const claimRef = { ...ref, workItem: { ...ref.workItem, id: 'WI-fixture' } };
    const base = await buildTaskBrief(claimRef, deps);
    const emit = vi.fn();
    const identity = createReuseBriefIdentity('su-fixture', 'real-dispatch-fixture', emit)!;
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true);
    const unregisterProvider = registerReuseBriefProvider(source('clones'));
    const unregisterAdapter = registerTaskBriefReuseAdapter('impact', append);
    try {
      const result = await getClaimTimeTaskBrief({ ...claimRef, reuse: identity }, { ...deps, reuse: { recordIssued: record } });
      expect(result?.taskBrief.status).toBe('current');
      expect(result?.taskBrief).toEqual({ ...base, graph: { ...base.graph,
        relationships: [expect.stringContaining('clones')] } });
      expect(record).toHaveBeenCalledOnce();
      const issued = reuseIssuedSubjects(record.mock.calls[0]![0]);
      expect(JSON.parse(issued[0]!.subject)).toMatchObject({ invocation: 'real-dispatch-fixture', provider: 'clones',
        surface: 'claim', workItem: 'WI-fixture', plan: 'fixture-plan', planItems: ['P-009'],
        sourceVersion: base.sourceFingerprint, indexVersion: 'index-clones', outcome: 'complete' });
      expect(emit.mock.calls[0]![0][0]).toMatchObject({ ledger: 'recorded', recover: base.recover });
      expect(Array.from(JSON.stringify(result?.taskBrief)).length).toBeLessThanOrEqual(3000);
    } finally { unregisterAdapter(); unregisterProvider(); }
  });

  it('does not read unavailable destinations or issue fictitious rows; keeps recovery in invocation outcomes', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps);
    const read = vi.fn(source('coverage').read), observe = vi.fn(), record = vi.fn(async () => true);
    const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
      { ...deps, reuse: { providers: [{ id: 'coverage', read }], adapters: {}, recordIssued: record } }, Date.now() + 6000);
    expect(result).toBe(base); expect(read).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(observe.mock.calls[0]![0]).toMatchObject({ ledger: 'not-needed', recover: base.recover,
      observations: [{ provider: 'coverage', status: 'unknown', reason: 'destination-unavailable', chars: 0 }] });
  });

  it('persists an all-holdout claim through the actual adapter without changing mandatory content', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true);
    const result = await enrichTaskBriefWithReuse(base, { ...ref, workItem: { ...ref.workItem, id: 'WI-12' },
      reuse: { owner: 'su-fixture', invocation: 'all-holdout', observe } },
    { ...deps, reuse: { providers: [source('coverage')], adapters: { tests: append }, recordIssued: record } }, Date.now() + 6000);
    expect(result).toBe(base);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0].observations[0]).toMatchObject({ provider: 'coverage', status: 'held-out',
      cohort: 'holdout', chars: 0, citedPaths: ['target.ts'] });
    expect(observe.mock.calls[0]![0].ledger).toBe('recorded');
  });

  it('isolates adapter replacement and provider failure while retaining independent destination content', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
      { ...deps, reuse: { providers: [source('clones'), source('coverage'), { id: 'cochange', read: async () => { throw new Error(); } }],
        adapters: { impact: b => ({ ...b, files: [], sourceFingerprint: 'replacement' }), tests: append, coChange: append },
        recordIssued: async () => true } }, Date.now() + 6000);
    expect(result.files).toEqual(base.files); expect(result.sourceFingerprint).toBe(base.sourceFingerprint);
    expect(result.graph.relationships).toEqual([expect.stringContaining('coverage')]);
    expect(observe.mock.calls[0]![0].observations.map((row: { status: string }) => row.status)).toEqual(['unknown', 'unknown', 'issued']);
  });

  it('charges adapter labels to the provider cap and never invents a top-level section', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    for (const adapter of [((b: TaskBrief) => ({ ...b, tests: [] })),
      ((b: TaskBrief) => ({ ...b, graph: { ...b.graph, relationships: ['label'.repeat(150)] } }))]) {
      const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
        { ...deps, reuse: { providers: [source('clones')], adapters: { impact: adapter }, recordIssued: async () => true } }, Date.now() + 6000);
      expect(result).toBe(base);
    }
  });

  it('does not reset the hard deadline after base assembly and cancels slow ledger I/O without dropping base', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps);
    vi.useFakeTimers();
    const observe = vi.fn(), read = vi.fn(source('clones').read), record = vi.fn(async (_input: ReuseIssuedRecord, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); return false;
    });
    const options = { ...deps, reuse: { providers: [{ id: 'clones' as const, read }], adapters: { impact: append }, recordIssued: record } };
    const expired = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'expired', observe } }, options, Date.now());
    expect(expired).toBe(base); expect(read).not.toHaveBeenCalled();
    const pending = enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } }, options, Date.now() + 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result.files).toEqual(base.files); expect(result.graph.relationships).toHaveLength(1);
    expect(record.mock.calls[0]![1].aborted).toBe(true);
    expect(observe.mock.calls.at(-1)![0].ledger).toBe('unknown');
  });

  it('preserves the base without identity and retains each item in bulk invocation telemetry', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), emit = vi.fn();
    const missing = createReuseBriefIdentity('su', undefined, emit);
    expect(missing).toBeUndefined();
    expect(await enrichTaskBriefWithReuse(base, ref, deps, Date.now() + 6000)).toBe(base);
    const identity = createReuseBriefIdentity('su', 'dispatch', emit)!;
    identity.observe({ workItem: 'first' }); identity.observe({ workItem: 'second' });
    expect(emit.mock.calls.at(-1)![0]).toEqual([{ workItem: 'first' }, { workItem: 'second' }]);
  });
});
