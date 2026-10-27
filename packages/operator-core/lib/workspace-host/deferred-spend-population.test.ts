import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWorkspaceHostSpendObservation, evaluateWorkspaceHostSpendFinality } from '@papercusp/deployment-driver';
import {
  collectDeferredSpendPopulation, DEFERRED_SPEND_RETAINED_RUNS, DEFERRED_SPEND_STABILITY_WINDOW_MS,
  type DeferredSpendPopulationDependencies, type DeferredSpendPopulationRequest, type DeferredSpendPopulationSnapshot,
} from './deferred-spend-population';
import { deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint } from './deferred-spend-acceptance-contract';

const [R4, R5] = DEFERRED_SPEND_RETAINED_RUNS;
const descriptor = {
  schemaVersion: 'gcp-billing-export-v1', projectId: 'billing-project', datasetId: 'billing', tableId: 'export',
  labelKey: 'run_id', maximumBytesBilled: '1000000',
};
const deferral = {
  status: 'deferred', actorId: 'historical-actor', reason: 'billing delayed', procedureRef: 'runbook:deferred',
  reconcileAfter: '2026-09-08T01:30:00Z',
};
const START = '2026-09-08T00:00:00Z', END = '2026-09-08T01:00:00Z';
function identity() {
  const scope = { workspaceId: 'ws-a', harness: 'papercusp', planSlug: 'deferred-spend', rubricRef: 'acceptance', rubricRevision: 7, criteriaHash: 'a'.repeat(64) };
  const provenance = { method: 'independent-review', selector: 'reviewed-diff', evidenceRefs: ['review:a'] };
  const revision = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const content = (path: string) => ({ path, contentHash: 'a'.repeat(64), provenance });
  return deferredSpendEvidenceIdentitySchema.parse({
    schemaVersion: 'deferred-spend-evidence-v1', scope, subject: { kind: 'source', ref: 'tree:population-control' },
    observation: { id: 'observation', observedAt: '2026-10-25T20:00:02Z', window: { startAt: START, endAt: '2026-10-25T20:00:00Z' },
      serving: { hostId: 'test', processId: 'test:1', buildId: 'source-build', runtimeGeneration: 'test-generation' },
      snapshot: { id: 'snapshot:a', acquiredAt: '2026-10-25T20:00:01Z', scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:a'] } },
    sourceManifestHash: 'a'.repeat(64), configurationHash: 'b'.repeat(64),
    censusSelectors: { base: { revision, treeHash: 'a'.repeat(64), provenance }, candidate: { revision: candidate, treeHash: 'b'.repeat(64), provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: 'a'.repeat(64), provenance },
      projectConfiguration: { contentHash: 'a'.repeat(64), provenance, tsconfigs: [content('tsconfig.json')], projectReferences: [] },
      migrationRegistry: { revision: candidate, contentHash: 'a'.repeat(64), provenance, entries: [] }, productionRoots: [content('src')],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: revision, candidateRevision: candidate, populationHash: deferredSpendFingerprint([]), provenance, entries: [] } },
  });
}
function signal(runId: string, settled = false) {
  const history = settled ? [
    createWorkspaceHostSpendObservation({ currency: 'USD', grossMicros: '451', creditMicros: '-451', netMicros: '0', observedAt: '2026-09-10T01:32:35.890Z', providerEvidenceRef: 'gcp://bigquery/projects/billing-project/jobs/job-a' }),
    createWorkspaceHostSpendObservation({ currency: 'USD', grossMicros: '451', creditMicros: '-451', netMicros: '0', observedAt: '2026-09-10T07:32:49.159Z', providerEvidenceRef: 'gcp://bigquery/projects/billing-project/jobs/job-b' }),
  ] : [];
  return {
    kind: 'workspace-host-canary-cost-evidence-v1', runId, spendSettlement: structuredClone(deferral),
    preRunZeroBaseline: { cents: 0, observedAt: START, providerEvidenceRef: 'baseline:zero' }, completion: { completedAt: END },
    spendObservations: history,
    spendReconciliation: settled ? { status: 'settled', finality: evaluateWorkspaceHostSpendFinality(history, DEFERRED_SPEND_STABILITY_WINDOW_MS) } : { status: 'retryable', reason: 'no-data' },
  };
}
function fixture() {
  const expectedIdentity = identity();
  const r4 = signal(R4), r5 = signal(R5, true);
  const hosts = [
    { workspaceId: 'ws-a', id: R4, connectionId: 'actual-connection-4', costSignals: [{ kind: 'other', runId: 'unrelated-run' }, r4] },
    { workspaceId: 'ws-a', id: R5, connectionId: 'actual-connection-5', costSignals: [r5] },
    { workspaceId: 'ws-a', id: 'positive-control-host', connectionId: 'other-connection', costSignals: [{ kind: 'other', runId: 'other-run' }] },
  ];
  const jobs = r5.spendObservations.map((observation, i) => ({
    workspaceId: 'ws-a', hostId: R5, runId: R5 as string, usageStartAt: START, usageEndAt: END,
    endpoint: 'https://bigquery.googleapis.com/bigquery/v2', descriptor, configurationHash: deferredSpendFingerprint(descriptor),
    jobReference: { projectId: 'billing-project', jobId: i ? 'job-b' : 'job-a' }, observation, authenticity: 'verified', evidenceRefs: [`retained-job:${i}`],
  }));
  const connection = { workspaceId: 'ws-a', id: '', target: 'gcp', readable: true, providerConfig: { billingExport: descriptor }, evidenceRefs: ['retained-connection'] };
  const request: DeferredSpendPopulationRequest = { expectedIdentity, targets: [R4, R5].map((id) => ({ hostId: id, runId: id, originalDeferral: deferral, evidenceRefs: ['historical-deferral:independent'] })) };
  const readConnection = vi.fn(async (id: string) => ({ ...connection, id }));
  const snapshot: { -readonly [K in keyof DeferredSpendPopulationSnapshot]: DeferredSpendPopulationSnapshot[K] } = {
    identity: expectedIdentity,
    census: async () => ({ snapshotRef: 'snapshot:a', upperWatermark: 'positive-control-host', hostCount: hosts.length, evidenceRefs: ['census:count'] }),
    readHosts: async (after, upperWatermark) => ({ snapshotRef: 'snapshot:a', configurationHash: expectedIdentity.configurationHash, after, upperWatermark,
      hosts: hosts.filter((host) => after === null || host.id > after).slice(0, 1),
      nextAfter: hosts.filter((host) => after === null || host.id > after).length > 1 ? hosts.filter((host) => after === null || host.id > after)[0].id : null,
      evidenceRef: `page:${after ?? 'start'}` }),
    readConnection,
    readJobs: async (target) => ({ snapshotRef: 'snapshot:a', complete: true, records: target.runId === R5 ? jobs : [], evidenceRefs: ['retained-job-census'] }),
  };
  const dependencies: DeferredSpendPopulationDependencies = { withSnapshot: async (_wanted, read) => read(snapshot) };
  return { request, dependencies, snapshot, hosts, r4, r5, jobs, connection, readConnection };
}
afterEach(() => vi.restoreAllMocks());

describe('DS-P007-RETAINED-COVERAGE', () => {
  it('baseline: covers both retained runs, every signal ordinal and an unrelated positive-control host across pages', async () => {
    const f = fixture();
    const r = await collectDeferredSpendPopulation(f.request, f.dependencies);
    expect(r.verdict).toBe('pass');
    expect(r.gaps).toEqual([]);
    expect(r.slices[0].coverage.pageRefs).toHaveLength(3);
    expect(r.slices[0].coverage.population).toEqual(expect.arrayContaining([`run:${R4}`, `run:${R5}`, `signal:${R4}:0`, `signal:${R4}:1`, 'host:positive-control-host']));
    expect(r.slices[0].coverage.notApplicable).toHaveLength(2);
    expect(f.readConnection.mock.calls.map(([id]) => id).sort()).toEqual(['actual-connection-4', 'actual-connection-5']);
    expect(r.targets[1].finality).toMatchObject({ status: 'settled', observation: { grossMicros: '451', creditMicros: '-451', netMicros: '0', budgetCents: 1 } });
    expect(r.targets[0].finality).toMatchObject({ status: 'pending', reason: 'no-observations' });
    expect(Object.isFrozen(r.targets[1].finality)).toBe(true);
  });
  const corruptions: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['absent host', (f) => { f.hosts.splice(1, 1); }],
    ['missing retained run', (f) => { f.hosts[0].costSignals.splice(1, 1); }],
    ['duplicate retained run', (f) => { f.hosts[0].costSignals.push(f.r4); }],
    ['malformed signal', (f) => { f.hosts[2].costSignals.push(null as never); }],
    ['unreadable array', (f) => { f.hosts[0].costSignals = null as never; }],
    ['foreign workspace', (f) => { f.hosts[2].workspaceId = 'ws-b'; }],
    ['connection scope mismatch', (f) => { f.connection.workspaceId = 'ws-b'; }],
    ['connection unreadable', (f) => { f.connection.readable = false; }],
    ['descriptor unreadable', (f) => { f.connection.providerConfig = null as never; }],
    ['partial paging', (f) => { const read = f.snapshot.readHosts; f.snapshot.readHosts = async (...a) => ({ ...await read(...a), nextAfter: null }); }],
    ['duplicate cursor', (f) => { const read = f.snapshot.readHosts; f.snapshot.readHosts = async (...a) => ({ ...await read(...a), nextAfter: 'invalid-cursor' }); }],
    ['page configuration skew', (f) => { const read = f.snapshot.readHosts; f.snapshot.readHosts = async (...a) => ({ ...await read(...a), configurationHash: 'f'.repeat(64) }); }],
    ['page snapshot skew', (f) => { const read = f.snapshot.readHosts; f.snapshot.readHosts = async (...a) => ({ ...await read(...a), snapshotRef: 'other' }); }],
    ['unreadable page', (f) => { f.snapshot.readHosts = async () => { throw new Error('page unavailable'); }; }],
  ];
  it.each(corruptions)('counterexample: keeps %s explicit instead of dropping it', async (_name, corrupt) => {
    const f = fixture(); corrupt(f);
    const r = await collectDeferredSpendPopulation(f.request, f.dependencies);
    expect(r.verdict).toBe('unknown');
    if (r.slices.length) expect(r.slices[0].coverage.population).toContain(`run:${R5}`);
    expect(r.gaps.length).toBeGreaterThan(0);
  });
  it('counterexample: page budget exhaustion cannot become a healthy zero', async () => {
    const f = fixture(); expect((await collectDeferredSpendPopulation({ ...f.request, maxPages: 1 }, f.dependencies)).verdict).toBe('unknown');
  });
});

describe('DS-P007-SETTLEMENT-FINALITY', () => {
  it('baseline: legitimate stable R5 preserves the independently selected original deferral with current descriptor absent', async () => {
    const f = fixture(); f.connection.providerConfig = {} as never;
    const r = await collectDeferredSpendPopulation(f.request, f.dependencies);
    expect(r.verdict).toBe('pass');
    expect(r.targets[1].descriptor.state).toBe('absent');
    expect(r.targets[1].originalDeferralHash).toBe(deferredSpendFingerprint(deferral));
    expect(f.r5.spendSettlement).toEqual(deferral);
  });
  const badHistories: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['false zero/fake settled status', (f) => { f.r5.spendObservations = []; }],
    ['one observation', (f) => { f.r5.spendObservations.pop(); }],
    ['changed trailing amount', (f) => { Object.assign(f.r5.spendObservations[1], { grossMicros: '452', netMicros: '1' }); }],
    ['duplicate job reference', (f) => { Object.assign(f.r5.spendObservations[1], { providerEvidenceRef: f.r5.spendObservations[0].providerEvidenceRef }); }],
    ['mixed currency', (f) => { Object.assign(f.r5.spendObservations[1], { currency: 'EUR' }); }],
    ['wrong exact micros', (f) => { Object.assign(f.r5.spendObservations[1], { netMicros: '99' }); }],
    ['wrong rounded cents', (f) => { Object.assign(f.r5.spendObservations[1], { budgetCents: 0 }); }],
    ['too short stability window', (f) => { Object.assign(f.r5.spendObservations[1], { observedAt: '2026-09-10T01:33:35.890Z' }); }],
    ['stored finality mismatch', (f) => { f.r5.spendReconciliation.finality = { status: 'settled' } as never; }],
  ];
  it.each(badHistories)('counterexample: detects %s', async (_name, corrupt) => {
    const f = fixture(); corrupt(f);
    const r = await collectDeferredSpendPopulation(f.request, f.dependencies);
    expect(r.verdict).toBe('fail');
    expect(r.slices[0].violations[0].member).toBe(`run:${R5}`);
  });
  it.each([
    ['original deferral loss', (f: ReturnType<typeof fixture>) => { f.r5.spendSettlement = undefined as never; }],
    ['missing provenance', (f: ReturnType<typeof fixture>) => { f.jobs.length = 0; }],
    ['unverified job', (f: ReturnType<typeof fixture>) => { f.jobs[0].authenticity = 'unverified'; }],
    ['wrong usage window', (f: ReturnType<typeof fixture>) => { f.jobs[0].usageEndAt = '2026-09-09T01:00:00Z'; }],
    ['wrong job config', (f: ReturnType<typeof fixture>) => { f.jobs[0].configurationHash = 'f'.repeat(64); }],
    ['wrong run attribution', (f: ReturnType<typeof fixture>) => { f.jobs[0].runId = R4; }],
    ['URL without provenance', (f: ReturnType<typeof fixture>) => { f.jobs[0].evidenceRefs = []; }],
  ])('counterexample: %s stays unknown', async (_name, corrupt) => {
    const f = fixture(); corrupt(f); expect((await collectDeferredSpendPopulation(f.request, f.dependencies)).verdict).toBe('unknown');
  });
  it('counterexample: measured unsupported job fails despite a separate coverage gap', async () => {
    const f = fixture(); f.jobs[0].authenticity = 'unsupported'; f.hosts[2].costSignals.push(null as never);
    expect((await collectDeferredSpendPopulation(f.request, f.dependencies)).verdict).toBe('fail');
  });
  it('classifies invalid descriptor without exposing credential fields', async () => {
    const f = fixture(); f.connection.providerConfig.billingExport = { credential: 'secret-test-value' } as never;
    const r = await collectDeferredSpendPopulation(f.request, f.dependencies);
    expect(r.verdict).toBe('pass'); expect(r.targets[0].descriptor.state).toBe('present-invalid');
    expect(JSON.stringify(r)).not.toContain('secret-test-value');
  });
});

describe('DS-P007-READ-ONLY', () => {
  it('baseline: performs only injected reads without mutating caller evidence or using provider/credential handles', async () => {
    const f = fixture(); const before = JSON.stringify({ hosts: f.hosts, jobs: f.jobs, connection: f.connection });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    const mutate = vi.fn(() => { throw new Error('mutation trap'); });
    Object.assign(f.snapshot, { mutate, acquireCredentials: mutate, enqueue: mutate });
    expect((await collectDeferredSpendPopulation(f.request, f.dependencies)).verdict).toBe('pass');
    expect(fetch).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    expect(JSON.stringify({ hosts: f.hosts, jobs: f.jobs, connection: f.connection })).toBe(before);
    expect(Object.isFrozen(f.r5)).toBe(false);
    expectTypeOf<keyof DeferredSpendPopulationDependencies>().toEqualTypeOf<'withSnapshot'>();
  });
  it('counterexample: refuses source/runtime skew before any population read', async () => {
    const f = fixture(); const census = vi.spyOn(f.snapshot, 'census');
    f.snapshot.identity = { ...f.snapshot.identity, observation: { ...f.snapshot.identity.observation, serving: { ...f.snapshot.identity.observation.serving, buildId: 'other' } } };
    expect((await collectDeferredSpendPopulation(f.request, f.dependencies)).verdict).toBe('unknown'); expect(census).not.toHaveBeenCalled();
  });
  it('pins the reviewed production stability constant without importing its mutable store', () => {
    const source = readFileSync(new URL('./hosted-lifecycle-store.ts', import.meta.url), 'utf8');
    expect(source).toContain('HOSTED_LIFECYCLE_SPEND_STABILITY_WINDOW_MS = 30 * 60_000');
    expect(DEFERRED_SPEND_STABILITY_WINDOW_MS).toBe(30 * 60_000);
  });
});
