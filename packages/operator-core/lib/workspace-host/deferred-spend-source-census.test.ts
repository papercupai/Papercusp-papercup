import { describe, expect, it } from 'vitest';
import {
  DEFERRED_SPEND_EVIDENCE_VERSION, deferredSpendFingerprint, deferredSpendEvidenceSliceSchema,
  evaluateDeferredSpendEvidence, type DeferredSpendEvidenceIdentity,
} from './deferred-spend-acceptance-contract';
import {
  analyzeDeferredSpendSourceCensus, deferredSpendSourceHash, deferredSpendSourceManifest,
  type DeferredSpendSourceRequest, type DeferredSpendSourceSnapshot, type SourceBytes,
} from './deferred-spend-source-census';

const base = 'a'.repeat(40), candidate = 'b'.repeat(40);
const provenance = { method: 'independent-review', selector: 'base/candidate diff plus configured roots and active registry', evidenceRefs: ['review:population'] };
const sources: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@fixture/*': ['src/*'] } }, include: ['src/**/*.ts'] }),
  'src/package.json': JSON.stringify({ name: 'fixture-package', version: '1.0.0' }),
  'src/entry.ts': `import { read } from '@fixture/billing';
export function spend() { return read(); }`,
  'src/billing.ts': `function acquireGcpAdcAuth() { return 'existing-auth'; }
function parseGcpBillingExportDescriptor() { return 'validated'; }
export function read() {
  acquireGcpAdcAuth(); parseGcpBillingExportDescriptor();
  const provider_config = { billingExport: {} }; const credential_ref = 'associated';
  provider_config.billingExport;
  const query = { parameterMode: 'NAMED', maximumBytesBilled: '100', queryParameters: ['run_id', 'usage_start_at', 'usage_end_at'] };
  return fetch('https://bigquery.googleapis.com/bigquery/v2/projects/public/queries', query);
}
export function unrelatedLifecycle() { destroyHost('unrelated'); }`,
  'src/routines.ts': `import { spend } from './entry';
registerSystemAction('hosted-lifecycle-reconcile', spend);`,
  'src/collector.ts': `export function collect() { return 'consistent-read-only'; }`,
  'migrations/001.sql': `-- existing tables, reviewed independently
CREATE TABLE workspace_host_connections(id text);
CREATE TABLE workspace_hosts(id text);
CREATE TABLE workspace_host_operations(id text);`,
};
type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Fixture = { request: Mutable<DeferredSpendSourceRequest>; snapshot: Mutable<DeferredSpendSourceSnapshot> };

/** Re-seal independent selectors after changing fixture bytes; allowances deliberately stay pinned. */
function seal(fixture: Fixture) {
  const { snapshot, request } = fixture;
  const identity = snapshot.identity;
  const selectors = identity.censusSelectors;
  const entry = (path: string) => ({ path, contentHash: snapshot.files.find((file) => file.path === path && file.revision === candidate)!.contentHash, provenance });
  const members = snapshot.files.filter((file) => file.revision === candidate && file.path.startsWith('src/'))
    .map(({ path, contentHash }) => ({ path, contentHash })).sort((a, b) => a.path.localeCompare(b.path));
  snapshot.roots = [{ root: 'src', members }];
  selectors.productionRoots = [{ path: 'src', contentHash: deferredSpendFingerprint(members), provenance }];
  selectors.projectConfiguration.tsconfigs = [entry('tsconfig.json')];
  selectors.projectConfiguration.contentHash = deferredSpendFingerprint({ tsconfigs: selectors.projectConfiguration.tsconfigs, projectReferences: selectors.projectConfiguration.projectReferences });
  selectors.migrationRegistry.entries = snapshot.files.filter((file) => file.path.startsWith('migrations/') && file.revision === candidate).map((file) => entry(file.path));
  selectors.migrationRegistry.contentHash = deferredSpendFingerprint(selectors.migrationRegistry.entries);
  for (const change of selectors.changedPaths.entries) for (const side of ['old', 'new'] as const) if (side in change) {
    const selected = (change as unknown as Record<string, { path: string; contentHash: string }>)[side];
    const file = snapshot.files.find((file) => file.path === selected.path && file.revision === (side === 'old' ? base : candidate));
    if (file) selected.contentHash = file.contentHash;
  }
  selectors.changedPaths.populationHash = deferredSpendFingerprint(selectors.changedPaths.entries);
  identity.configurationHash = deferredSpendFingerprint({ projectConfiguration: selectors.projectConfiguration, migrationRegistry: selectors.migrationRegistry, packages: snapshot.packages });
  identity.sourceManifestHash = deferredSpendFingerprint(deferredSpendSourceManifest(snapshot.files));
  request.expectedIdentity = structuredClone(identity);
}
function fixture(): Fixture {
  const scope = { workspaceId: 'workspace-a', harness: 'papercusp', planSlug: 'deferred-spend', rubricRef: 'acceptance', rubricRevision: 7, criteriaHash: 'c'.repeat(64) };
  const identity: Mutable<DeferredSpendEvidenceIdentity> = {
    schemaVersion: DEFERRED_SPEND_EVIDENCE_VERSION, scope, subject: { kind: 'source', ref: `tree:${candidate}` },
    observation: {
      id: 'source-observation', observedAt: '2026-10-25T20:00:02Z', window: { startAt: '2026-10-25T19:00:00Z', endAt: '2026-10-25T20:00:00Z' },
      serving: { hostId: 'source-runner', processId: 'source-pid', buildId: candidate, runtimeGeneration: 'fixture' },
      snapshot: { id: 'source-snapshot', acquiredAt: '2026-10-25T20:00:01Z', scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:source'] },
    },
    sourceManifestHash: 'd'.repeat(64), configurationHash: 'e'.repeat(64),
    censusSelectors: {
      base: { revision: base, treeHash: 'a'.repeat(64), provenance }, candidate: { revision: candidate, treeHash: 'b'.repeat(64), provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: deferredSpendFingerprint({ repositoryRoot: '/repo', workspaceRoot: '/workspace' }), provenance },
      projectConfiguration: { contentHash: 'a'.repeat(64), provenance, tsconfigs: [], projectReferences: [] },
      migrationRegistry: { revision: candidate, contentHash: 'a'.repeat(64), provenance, entries: [] }, productionRoots: [],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate, populationHash: deferredSpendFingerprint([]), provenance, entries: [] },
    },
  };
  const snapshot: Mutable<DeferredSpendSourceSnapshot> = {
    identity, files: Object.entries(sources).map(([path, text]) => ({ revision: candidate, path, text, contentHash: deferredSpendSourceHash(text) })),
    roots: [], packages: [{ name: 'fixture-package', version: '1.0.0', manifestPath: 'src/package.json' }], evidenceRefs: ['source:fixture'],
  };
  const control = (id: string, path: string, symbol: string, kind: 'call' | 'property' | 'literal' | 'schema' | 'routine', value: string) => ({ id, path, symbol, kind, value });
  const request: Mutable<DeferredSpendSourceRequest> = {
    expectedIdentity: structuredClone(identity),
    entrypoints: [{ path: 'src/entry.ts', symbol: 'spend' }, { path: 'src/routines.ts', symbol: '<module>' }, { path: 'src/collector.ts', symbol: 'collect' }],
    allowances: [
      { path: 'src/billing.ts', symbol: 'read', effect: 'transport', contentHash: snapshot.files.find((file) => file.path === 'src/billing.ts')!.contentHash, reason: 'reviewed public BigQuery/auth/query seam', evidenceRefs: ['review:billing'] },
      { path: 'src/routines.ts', symbol: '<module>', effect: 'routine', contentHash: snapshot.files.find((file) => file.path === 'src/routines.ts')!.contentHash, reason: 'existing durable routine', evidenceRefs: ['review:routine'] },
      { path: 'migrations/001.sql', symbol: '<schema>', effect: 'schema', contentHash: snapshot.files.find((file) => file.path === 'migrations/001.sql')!.contentHash, reason: 'existing host schema', evidenceRefs: ['review:schema'] },
    ],
    controls: [
      control('billing-reader', 'src/entry.ts', 'spend', 'call', 'read'),
      control('public-bigquery', 'src/billing.ts', 'read', 'literal', 'https://bigquery.googleapis.com/bigquery/v2/projects/public/queries'),
      control('named-parameters', 'src/billing.ts', 'read', 'literal', 'NAMED'),
      control('query-byte-ceiling', 'src/billing.ts', 'read', 'property', 'maximumBytesBilled'),
      ...[['run-parameter', 'run_id'], ['window-start', 'usage_start_at'], ['window-end', 'usage_end_at']].map(([id, value]) => control(id, 'src/billing.ts', 'read', 'literal', value)),
      control('connection-descriptor', 'src/billing.ts', 'read', 'property', 'provider_config.billingExport'),
      control('existing-credential-ref', 'src/billing.ts', 'read', 'literal', 'associated'),
      control('descriptor-parser', 'src/billing.ts', 'read', 'call', 'parseGcpBillingExportDescriptor'),
      control('google-auth', 'src/billing.ts', 'read', 'call', 'acquireGcpAdcAuth'),
      control('existing-routine', 'src/routines.ts', '<module>', 'routine', 'hosted-lifecycle-reconcile'),
      control('spend-sweep', 'src/entry.ts', 'spend', 'call', 'read'),
      ...[['connection-schema', 'workspace_host_connections'], ['host-schema', 'workspace_hosts'], ['operation-schema', 'workspace_host_operations']].map(([id, value]) => control(id, 'migrations/001.sql', '<schema>', 'schema', value)),
      control('read-only-collector', 'src/collector.ts', 'collect', 'literal', 'consistent-read-only'),
    ],
  };
  const value = { snapshot, request }; seal(value); return value;
}
function edit(value: Fixture, path: string, transform: (text: string) => string, added = false) {
  let file = value.snapshot.files.find((file) => file.path === path && file.revision === candidate);
  if (!file) { file = { path, revision: candidate, contentHash: '', text: '' }; value.snapshot.files.push(file); }
  const prior = { ...file, revision: base };
  file.text = transform(file.text ?? ''); file.contentHash = deferredSpendSourceHash(file.text);
  if (added) value.snapshot.identity.censusSelectors.changedPaths.entries.push({ status: 'added', new: { path, contentHash: file.contentHash } });
  else {
    value.snapshot.files.push(prior);
    value.snapshot.identity.censusSelectors.changedPaths.entries.push({ status: 'modified', old: { path, contentHash: prior.contentHash }, new: { path, contentHash: file.contentHash } });
  }
  seal(value);
}
const analyze = (value: Fixture) => analyzeDeferredSpendSourceCensus(value.request, value.snapshot);

describe('P009 source census positive controls', () => {
  it('R001 R002 R005: witnesses billing/auth/query/routine/schema controls with concrete typed edges', () => {
    const result = analyze(fixture());
    expect(result.gaps).toEqual([]); expect(result.verdict).toBe('pass');
    expect(result.edges).toContainEqual(expect.objectContaining({ path: 'src/entry.ts', kind: 'import', target: 'src/billing.ts#<module>', resolved: true }));
    expect(result.reachableSymbols).toContain('src/billing.ts#read');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ symbol: 'unrelatedLifecycle', disposition: 'out-of-scope' }));
    expect(result.packages).toEqual([{ name: 'fixture-package', version: '1.0.0', manifestPath: 'src/package.json' }]);
    for (const slice of result.slices) expect(deferredSpendEvidenceSliceSchema.safeParse(slice).success).toBe(true);
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: result.identity, requiredSlices: ['source-r001', 'source-r002', 'source-r005', 'source-r008'] }, result.identity && { identity: result.identity, slices: result.slices }).verdict).toBe('pass');
  });
  it('never freezes caller data and returns detached deeply immutable source evidence', () => {
    const value = fixture(), result = analyze(value);
    expect(Object.isFrozen(result.diagnostics)).toBe(true); expect(Object.isFrozen(result.identity?.censusSelectors)).toBe(true);
    value.snapshot.files[0].text = 'changed'; value.snapshot.packages[0].version = 'rewritten';
    expect(result.packages[0].version).toBe('1.0.0'); expect(Reflect.set(result.edges, '0', null)).toBe(false);
  });
  it('retains deleted and both renamed identities in the independently selected partition', () => {
    const value = fixture();
    const old: SourceBytes = { revision: base, path: 'src/deleted.ts', text: 'export const old = 1;', contentHash: deferredSpendSourceHash('export const old = 1;') };
    value.snapshot.files.push(old);
    value.snapshot.identity.censusSelectors.changedPaths.entries.push({ status: 'deleted', old: { path: old.path, contentHash: old.contentHash } });
    const renamed = { ...old, path: 'src/old-name.ts' }; value.snapshot.files.push(renamed);
    const next = { ...old, revision: candidate, path: 'src/new-name.ts' }; value.snapshot.files.push(next);
    value.snapshot.identity.censusSelectors.changedPaths.entries.push({ status: 'renamed', old: { path: renamed.path, contentHash: renamed.contentHash }, new: { path: next.path, contentHash: next.contentHash } });
    seal(value); const result = analyze(value);
    expect(result.verdict).toBe('pass');
    expect(result.slices[0].coverage.checked).toEqual(expect.arrayContaining([`${base}:src/deleted.ts`, `${base}:src/old-name.ts`, `${candidate}:src/new-name.ts`]));
  });
});

describe('DS-P009-FORBIDDEN-EFFECT maintained in-memory counterexamples', () => {
  it.each([
    ['private transport', "fetch('https://console.cloud.google.com/BillingData/graphql')", 'R001', 'transport'],
    ['credential mint', "mintCredential('gcp')", 'R008', 'lifecycle'],
    ['lifecycle replay', 'replayLifecycle()', 'R008', 'lifecycle'],
    ['R7 destroy', "destroyHost('p018-r7')", 'R008', 'lifecycle'],
    ['gate emission', "emitGate('g6-r31')", 'R008', 'lifecycle'],
    ['file sink', "writeFile('/credentials', 'token')", 'R002', 'credential'],
    ['keychain sink', "keychain.setPassword('gcp', 'secret')", 'R002', 'credential'],
    ['second timer', 'setInterval(() => 1, 1000)', 'R005', 'routine'],
    ['hidden registration', "registerSystemAction('innocent-name', () => 1)", 'R005', 'routine'],
    ['descriptor secret', "const descriptor = { accessToken: 'secret' }", 'R002', 'credential'],
  ])('detects %s with exact path/symbol/line/reason', (_name, source, criterion, effect) => {
    const value = fixture(); edit(value, 'src/collector.ts', (text) => text.replace("return 'consistent-read-only';", `${source}; return 'consistent-read-only';`));
    const result = analyze(value);
    expect(result.verdict).toBe('fail');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: 'src/collector.ts', symbol: 'collect', line: 1, criterion, effect, disposition: 'forbidden', reason: expect.any(String) }));
  });
  it('follows aliased/re-exported indirect calls and never treats type-only imports as runtime effects', () => {
    const value = fixture();
    edit(value, 'src/helper.ts', () => 'export function forbidden() { mintCredential(); }', true);
    edit(value, 'src/barrel.ts', () => "export { forbidden as renamed } from './helper';", true);
    edit(value, 'src/collector.ts', () => "import { renamed } from './barrel'; export function collect() { renamed(); return 'consistent-read-only'; }");
    const result = analyze(value); expect(result.verdict).toBe('fail');
    expect(result.reachableSymbols).toContain('src/helper.ts#forbidden');
    expect(result.edges.some((edge) => edge.kind === 're-export' && edge.resolved)).toBe(true);
  });
  it('detects forbidden effects in unimported changed files and innocently named migrations', () => {
    const value = fixture();
    edit(value, 'src/not-imported.ts', () => 'export function isolated() { saveCredential(); }', true);
    edit(value, 'migrations/999.sql', () => 'CREATE TABLE ordinary_records (payload text);', true);
    const result = analyze(value); expect(result.verdict).toBe('fail');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: 'src/not-imported.ts', symbol: 'isolated', disposition: 'forbidden' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: 'migrations/999.sql', symbol: '<schema>', line: 1, disposition: 'forbidden', reason: 'schema table: ordinary_records' }));
  });
  it('follows a literal dispatch to the registered handler', () => {
    const value = fixture(); edit(value, 'src/collector.ts', (text) => text.replace("return 'consistent-read-only';", "dispatch('hosted-lifecycle-reconcile'); return 'consistent-read-only';"));
    expect(analyze(value).edges).toContainEqual(expect.objectContaining({ path: 'src/collector.ts', kind: 'dispatch', target: 'src/entry.ts#spend', resolved: true }));
  });
  it('follows imported aliases for file sinks and private transport', () => {
    const value = fixture();
    edit(value, 'src/collector.ts', () => "import { writeFile as innocuous } from 'node:fs'; export function collect() { innocuous('/key', 'secret'); const send = fetch; send('https://console.cloud.google.com/BillingData'); return 'consistent-read-only'; }");
    const result = analyze(value);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ criterion: 'R002', effect: 'credential', disposition: 'forbidden' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ criterion: 'R001', effect: 'transport', disposition: 'forbidden' }));
  });
  it('inspects SQL call strings and tagged SQL without treating comment DDL as tables', () => {
    const value = fixture();
    edit(value, 'src/collector.ts', () => "export function collect() { db.query('INSERT INTO ordinary_records VALUES (1)'); sql`CREATE TABLE secondary (payload text)`; return 'consistent-read-only'; }");
    const result = analyze(value); expect(result.verdict).toBe('fail');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ criterion: 'R008', reason: 'SQL mutation reachable from the source/acceptance boundary', disposition: 'forbidden' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ criterion: 'R005', reason: 'schema table: secondary', disposition: 'forbidden' }));
  });
  it.each([
    "SELECT 'CREATE TABLE harmless (id text)' AS note",
    "SELECT 'INSERT INTO t VALUES (1); UPDATE t SET id=2; DELETE FROM t; ALTER TABLE t; DROP TABLE t; EXECUTE x'",
    'SELECT $$CREATE TABLE harmless (id text)$$, $note$DROP TABLE harmless$note$',
    "SELECT E'it\\'s CREATE TABLE harmless (id text)'",
    'SELECT "CREATE TABLE harmless", "DROP TABLE harmless" FROM existing_table',
    'SELECT 1 /* outer /* inner */ CREATE TABLE harmless (id text) */',
  ])('does not fabricate a SQL write from quoted data or comments: %s', (sql) => {
    const value = fixture();
    edit(value, 'src/collector.ts', () => `function query(text: string) { return text; } export function collect() { query(${JSON.stringify(sql)}); return 'consistent-read-only'; }`);
    const result = analyze(value);
    expect(result.verdict).toBe('pass');
    expect(result.diagnostics.filter((entry) => entry.path === 'src/collector.ts' && entry.disposition === 'forbidden')).toEqual([]);
  });
  it.each([
    "SELECT '--'; CREATE TABLE actual_write (id text);",
    "SELECT '/*'; CREATE TABLE actual_write (id text); SELECT '*/';",
    "SELECT $note$/* --$note$; CREATE TABLE actual_write (id text);",
    'CREATE TABLE "CREATE TABLE actual_write" (id text);',
  ])('quoted comment markers cannot hide executable DDL: %s', (sql) => {
    const value = fixture();
    edit(value, 'src/collector.ts', () => `function query(text: string) { return text; } export function collect() { query(${JSON.stringify(sql)}); return 'consistent-read-only'; }`);
    const result = analyze(value);
    expect(result.verdict).toBe('fail');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: 'src/collector.ts', criterion: 'R005', effect: 'schema', disposition: 'forbidden' }));
  });
  it.each(["SELECT 'unterminated", 'SELECT $tag$unterminated', 'SELECT "unterminated', 'SELECT 1 /* unterminated'])('keeps incomplete SQL lexical populations unknown: %s', (sql) => {
    const value = fixture();
    edit(value, 'src/collector.ts', () => `function query(text: string) { return text; } export function collect() { query(${JSON.stringify(sql)}); return 'consistent-read-only'; }`);
    expect(analyze(value).verdict).toBe('unknown');
  });
  it('redacts credential material from transport diagnostics', () => {
    const value = fixture(); edit(value, 'src/collector.ts', () => "export function collect() { fetch('https://account:secret@console.cloud.google.com/BillingData?token=secret'); return 'consistent-read-only'; }");
    const result = analyze(value); expect(result.verdict).toBe('fail');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ reason: 'private billing transport: https://console.cloud.google.com/BillingData' }));
  });
  it('includes transitive runtime module initializers and their function effects', () => {
    const value = fixture();
    edit(value, 'src/side-effect.ts', () => 'function hidden() { mintCredential(); } hidden();', true);
    edit(value, 'src/bridge.ts', () => "import './side-effect';", true);
    edit(value, 'src/collector.ts', (text) => "import './bridge';\n" + text);
    const result = analyze(value); expect(result.verdict).toBe('fail');
    expect(result.reachableSymbols).toContain('src/side-effect.ts#hidden');
  });
  it('does not execute a fixture while inspecting its constructor/import initializers', () => {
    const value = fixture(); edit(value, 'src/collector.ts', () => "class Dangerous { constructor() { mintCredential(); } } export function collect() { new Dangerous(); return 'consistent-read-only'; }");
    expect(analyze(value).verdict).toBe('fail');
  });
  it('ignores comment decoys but rejects comment-only positive controls', () => {
    const value = fixture(); edit(value, 'src/collector.ts', (text) => `// mintCredential(); setInterval(() => 1);\n${text}`);
    expect(analyze(value).verdict).toBe('pass');
    value.request.controls.find((control) => control.id === 'read-only-collector')!.value = 'comment-only';
    expect(analyze(value).verdict).toBe('unknown');
  });
});

describe('DS-P009-INCOMPLETE-SOURCE', () => {
  it.each([
    ['missing root', (v: Fixture) => { v.snapshot.roots = []; }],
    ['missing file', (v: Fixture) => { v.snapshot.files = v.snapshot.files.filter((file) => file.path !== 'src/billing.ts'); }],
    ['unreadable migration', (v: Fixture) => { v.snapshot.files.find((file) => file.path.endsWith('.sql'))!.text = null; }],
    ['wrong bytes', (v: Fixture) => { v.snapshot.files[0].text += ' '; }],
    ['empty manifest', (v: Fixture) => { v.snapshot.files = []; }],
    ['omitted package version', (v: Fixture) => { v.snapshot.packages[0].version = '2.0.0'; }],
    ['missing positive control', (v: Fixture) => { v.request.controls.shift(); }],
    ['different selectors with identical manifest', (v: Fixture) => { v.request.expectedIdentity.censusSelectors.roots.workspaceRoot = '/other'; }],
  ])('returns unknown for %s', (_name, mutate) => { const value = fixture(); mutate(value); expect(analyze(value).verdict).toBe('unknown'); });
  it.each([
    ['broken alias', "import { missing } from '@missing/reader'; export function isolated() { return missing(); }"],
    ['unsupported dynamic import', 'export function isolated(path: string) { return import(path); }'],
    ['unresolved dispatch', "export function isolated() { return dispatch(getName()); }"],
    ['computed endpoint', 'export function isolated(url: string) { return fetch(url); }'],
    ['parse failure', 'export function isolated( {'],
  ])('never passes %s', (_name, source) => { const value = fixture(); edit(value, 'src/gap.ts', () => source, true); expect(analyze(value).verdict).toBe('unknown'); });
  it('does not let one resolved call on a line hide a second unresolved effect', () => {
    const value = fixture(); edit(value, 'src/collector.ts', () => "function benign() { return 1; } export function collect() { benign(); unrecognizedEffect(); return 'consistent-read-only'; }");
    expect(analyze(value).verdict).toBe('unknown');
  });
  it('unknown endpoint resolution cannot be waived by a matching baseline allowance', () => {
    const value = fixture(); edit(value, 'src/billing.ts', (text) => text.replace("'https://bigquery.googleapis.com/bigquery/v2/projects/public/queries'", 'unresolvedEndpoint'));
    value.request.allowances[0].contentHash = value.snapshot.files.find((file) => file.revision === candidate && file.path === 'src/billing.ts')!.contentHash;
    expect(analyze(value).verdict).toBe('unknown');
    expect(analyze(value).diagnostics).toContainEqual(expect.objectContaining({ symbol: 'unrelatedLifecycle', disposition: 'out-of-scope' }));
  });
  it('a new SQL-only routine/obligation writer cannot hide behind an innocuous table name', () => {
    const value = fixture(); edit(value, 'migrations/999.sql', () => 'INSERT INTO ordinary_records VALUES (1);', true);
    expect(analyze(value).verdict).toBe('fail');
  });
  it.each([
    ['unhandled configuration', 'src/hidden.json', '{"schedule":"second-spend-worker"}'],
    ['unsupported source', 'src/hidden.vue', '<script>mintCredential()</script>'],
    ['dynamic migration', 'migrations/999.sql', "EXECUTE 'CREATE TABLE invisible(id text)';"],
    ['unparseable SQL', 'migrations/999.sql', 'not valid PostgreSQL'],
  ])('keeps %s unknown', (_name, path, source) => {
    const value = fixture(); edit(value, path, () => source, true); expect(analyze(value).verdict).not.toBe('pass');
  });
  it('a concrete measured violation dominates an unrelated coverage gap', () => {
    const value = fixture(); edit(value, 'src/collector.ts', (text) => text.replace("return 'consistent-read-only';", "mintCredential(); return 'consistent-read-only';"));
    value.snapshot.roots = [];
    expect(analyze(value).verdict).toBe('fail');
  });
  it('retains type-only and literal dynamic edges without executing unrelated function bodies', () => {
    const value = fixture();
    edit(value, 'src/type-only.ts', () => 'export interface Shape {} export function unused() { destroyHost(); }', true);
    // This file is explicitly baseline/non-attributed for this control.
    value.snapshot.identity.censusSelectors.changedPaths.entries.pop(); seal(value);
    edit(value, 'src/collector.ts', () => "import type { Shape } from './type-only'; export function collect() { import('./entry'); return 'consistent-read-only'; }");
    const result = analyze(value); expect(result.verdict).toBe('pass');
    expect(result.edges).toContainEqual(expect.objectContaining({ kind: 'type-import', target: 'src/type-only.ts#<module>', resolved: true }));
    expect(result.edges).toContainEqual(expect.objectContaining({ kind: 'dynamic-import', target: 'src/entry.ts#<module>', resolved: true }));
    expect(result.reachableSymbols).not.toContain('src/type-only.ts#unused');
  });
});
