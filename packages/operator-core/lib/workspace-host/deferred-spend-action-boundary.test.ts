import { describe, expect, it, vi } from 'vitest';
import {
  collectDeferredSpendActionBoundary, DEFERRED_SPEND_ACTION_STREAMS,
  type DeferredSpendActionBoundaryRequest, type DeferredSpendActionDependencies,
  type DeferredSpendActionLineage, type DeferredSpendActionRecord, type DeferredSpendActionStream,
} from './deferred-spend-action-boundary';
import { deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, type DeferredSpendEvidence } from './deferred-spend-acceptance-contract';

const START = '2026-09-01T00:00:00Z', END = '2026-10-01T00:00:00Z', AT = '2026-09-15T00:00:00Z';
function fixture() {
  const scope = { workspaceId: 'ws', harness: 'papercusp', planSlug: 'deferred-spend', rubricRef: 'acceptance', rubricRevision: 7, criteriaHash: 'a'.repeat(64) };
  const provenance = { method: 'independent-reviewed-fixture', selector: 'full-production-roots', evidenceRefs: ['review:selectors'] };
  const hash = 'a'.repeat(64), base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const content = { path: 'src', contentHash: hash, provenance };
  const identity = deferredSpendEvidenceIdentitySchema.parse({
    schemaVersion: 'deferred-spend-evidence-v1', scope, subject: { kind: 'source', ref: 'source:unit-fixture' },
    observation: { id: 'observation', observedAt: '2026-10-01T00:00:02Z', window: { startAt: START, endAt: END },
      serving: { hostId: 'fixture', processId: 'test:1', buildId: 'fixture-source', runtimeGeneration: '1' },
      snapshot: { id: 'snapshot', acquiredAt: '2026-10-01T00:00:01Z', scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:fixture'] } },
    sourceManifestHash: hash, configurationHash: hash,
    censusSelectors: { base: { revision: base, treeHash: hash, provenance }, candidate: { revision: candidate, treeHash: hash, provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: hash, provenance },
      projectConfiguration: { contentHash: hash, provenance, tsconfigs: [{ ...content, path: 'tsconfig.json' }], projectReferences: [] },
      migrationRegistry: { revision: candidate, contentHash: hash, provenance, entries: [] }, productionRoots: [content],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate, populationHash: deferredSpendFingerprint([]), provenance, entries: [] } },
  });
  const request: DeferredSpendActionBoundaryRequest = { expectedIdentity: identity,
    implementation: [{ actorId: 'original', startedAt: START, evidenceRefs: ['implementation:origin'] }],
    acceptance: [{ actorId: 'acceptance', startedAt: '2026-09-02T00:00:00Z', evidenceRefs: ['acceptance:continuation'] }],
    boundaries: { r7: { ref: 'p018-canary-20260905-r7', generation: '1' },
      g6: { ref: 'conv-mtrj4304-0000-464a5dc2fb3d4fb395fe6aabdc0a5536', generation: '1' },
      r31: { ref: 'p018-r31-ready', generation: '1' } } };
  const lineage: DeferredSpendActionLineage = { snapshotRef: 'snapshot', complete: true, historyComplete: true,
    evidenceRefs: ['lineage:full-history'], actors: ['original', 'acceptance', 'successor', 'child', 'independent'].map((id) => ({
      id, generation: '1', principalId: `principal:${id}`, sessionId: `session:${id}`, workItemId: `WI:${id}`, evidenceRefs: [`actor:${id}`],
    })), edges: [
      { from: 'original', to: 'successor', relation: 'continuation', evidenceRefs: ['continuation:canonical'] },
      { from: 'successor', to: 'child', relation: 'child', evidenceRefs: ['child:canonical'] },
    ], aliases: [] };
  function row(id: string, actorId = 'original', effect: DeferredSpendActionRecord['action'] = 'observe'): DeferredSpendActionRecord {
    return { id, workspaceId: 'ws', occurredAt: AT, action: effect, target: request.boundaries.r7,
      operationId: null, invocationId: null,
      writeTime: { actorId, actorGeneration: '1', principalId: `principal:${actorId}`, sessionId: `session:${actorId}`,
        workItemId: `WI:${actorId}`, sourceRef: 'source:write-time', processId: 'test:writer', buildId: 'writer-build' },
      authorization: null, audit: { complete: true, evidenceRefs: ['audit:complete'] }, evidenceRefs: [`record:${id}`] };
  }
  const independent = row('02-independent', 'independent', 'destroy');
  independent.authorization = { id: 'auth:unrelated-cleanup', actorId: 'independent', workItemId: 'WI:independent',
    issuedAt: '2026-09-10T00:00:00Z', action: 'destroy', target: request.boundaries.r7, separateCausalRoot: true,
    independentOf: ['original', 'acceptance'], lineageRefs: ['auth:independent-causal-root'], evidenceRefs: ['auth:owner-grant'] };
  const records: Record<DeferredSpendActionStream, DeferredSpendActionRecord[]> = {
    operations: [row('01-read'), independent], events: [], resources: [], requests: [], admissions: [], credentials: [], invocations: [], native: [],
  };
  const source: DeferredSpendEvidence = { identity, slices: [{ id: 'source-census', verdict: 'pass', evidenceRefs: ['source:reviewed'], violations: [],
    coverage: { state: 'complete', population: ['src'], checked: ['src'], notChecked: [], notApplicable: [], residue: [], gaps: [],
      snapshotRef: 'snapshot', pageRefs: ['source:page'], emptyPopulationEvidenceRefs: [] } }] };
  const calls: string[] = [];
  let omitPage = false, retention = true;
  const dependencies: DeferredSpendActionDependencies = { withSnapshot: async (_identity, read) => read({
    identity, readLineage: async () => lineage,
    readCensus: async (stream) => { calls.push(`census:${stream}`); return { snapshotRef: 'snapshot', complete: true, retentionComplete: retention,
      window: identity.observation.window, count: records[stream].length, upperWatermark: records[stream].at(-1)?.id ?? null, evidenceRefs: [`census:${stream}`] }; },
    readPage: async (stream, after, upperWatermark) => {
      calls.push(`page:${stream}:${after}`);
      const candidates = records[stream].filter((entry) => after === null || entry.id > after);
      return { snapshotRef: 'snapshot', after, upperWatermark, records: candidates.slice(0, 1),
        nextAfter: !omitPage && candidates.length > 1 ? candidates[0].id : null, evidenceRef: `page:${stream}:${after}` };
    },
  }) };
  return { request, source, lineage, records, row, calls, dependencies,
    omitPage: () => { omitPage = true; }, prune: () => { retention = false; },
    run: () => collectDeferredSpendActionBoundary(request, source, dependencies) };
}

describe('DS-P008-ACTION-ATTRIBUTION', () => {
  it('baseline: exhausts broader pages, preserves independent same-host cleanup and benign observation controls', async () => {
    const f = fixture(); const r = await f.run();
    expect(r.verdict).toBe('pass');
    expect(f.calls.filter((entry) => entry.startsWith('census:'))).toHaveLength(DEFERRED_SPEND_ACTION_STREAMS.length);
    expect(f.calls).toContain('page:operations:01-read');
    expect(r.slices[1].coverage.checked).toContain('operations:02-independent');
    expect(Object.isFrozen(r)).toBe(true);
  });
  it.each(['original', 'acceptance', 'successor', 'child'])('counterexample: %s prohibited lifecycle is attributable', async (actorId) => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', actorId, 'provision'));
    const r = await f.run(); expect(r.verdict).toBe('fail'); expect(r.slices[1].violations[0].member).toBe('operations:03-prohibited');
  });
  it.each(['lifecycle-replay', 'credential-mint', 'destroy', 'conversation-transition', 'readiness-transition'] as const)(
    'counterexample: %s is classified from typed effects and canonical boundaries', async (effect) => {
      const f = fixture(); const row = f.row('03-prohibited', 'child', effect);
      row.target = effect === 'conversation-transition' ? f.request.boundaries.g6 : effect === 'readiness-transition' ? f.request.boundaries.r31 : f.request.boundaries.r7;
      f.records.operations.push(row); expect((await f.run()).verdict).toBe('fail');
    });
  it('counterexample: canonical successor alias uses generation and historical binding', async () => {
    const f = fixture(); const row = f.row('03-prohibited', 'successor', 'provision'); row.writeTime!.actorId = 'old-shell';
    f.lineage.aliases.push({ alias: 'old-shell', actorId: 'successor', generation: '1', startAt: START, endAt: END, evidenceRefs: ['binding:history'] });
    f.records.operations.push(row); expect((await f.run()).verdict).toBe('fail');
  });
  it('counterexample: child evidence cannot be laundered through an independent authorization label', async () => {
    const f = fixture(); const row = f.row('03-prohibited', 'child', 'destroy'); row.authorization = f.records.operations[1].authorization;
    f.records.operations.push(row); expect((await f.run()).verdict).toBe('fail');
  });
  it('counterexample: measured prohibited action dominates missing other audit slices/source', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision')); f.prune();
    expect((await collectDeferredSpendActionBoundary(f.request, null, f.dependencies)).verdict).toBe('fail');
  });
  it('baseline: no attributable lifecycle action can pass only with nonzero broader controls and complete census', async () => {
    const f = fixture(); expect(f.records.operations.some((row) => row.writeTime?.actorId === 'independent')).toBe(true);
    expect((await f.run()).verdict).toBe('pass');
  });
});

describe('DS-P008-UNCERTAIN-AUDIT', () => {
  it.each(['authorization', 'writeTime'] as const)('counterexample: absent %s is unknown, not a clean same-host exclusion', async (field) => {
    const f = fixture(); f.records.operations[1][field] = null; expect((await f.run()).verdict).toBe('unknown');
  });
  it.each(['principalId', 'sessionId', 'workItemId', 'sourceRef', 'processId', 'buildId'] as const)(
    'counterexample: missing %s cannot supply attribution proof', async (field) => {
      const f = fixture(); f.records.operations[1].writeTime![field] = ''; expect((await f.run()).verdict).toBe('unknown');
    });
  it('counterexample: omitted keyset page cannot be mistaken for exhausted audit population', async () => {
    const f = fixture(); f.omitPage(); expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: pruned history and missing source remain unknown', async () => {
    const f = fixture(); f.prune(); expect((await f.run()).verdict).toBe('unknown');
    expect((await collectDeferredSpendActionBoundary(f.request, null, f.dependencies)).verdict).toBe('unknown');
  });
  it('counterexample: missing canonical lineage edge cannot certify independence', async () => {
    const f = fixture(); f.lineage.historyComplete = false; f.lineage.edges = [];
    f.records.operations.push(f.row('03-uncertain', 'child', 'provision')); expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: incomplete native audit and missing invocation join remain unknown', async () => {
    const f = fixture(); const row = f.row('native-1', 'original', 'credential-mint'); row.audit.complete = false;
    f.records.native.push(row); expect((await f.run()).verdict).toBe('unknown');
    row.audit.complete = true; expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: missing operation join remains unknown', async () => {
    const f = fixture(); const row = f.row('event-1', 'original', 'provision'); row.operationId = 'missing';
    f.records.events.push(row); expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: ambiguous boundary generation is unknown', async () => {
    const f = fixture(); const row = f.row('03-destroy', 'original', 'destroy'); row.target = { ...row.target, generation: 'unresolved' };
    f.records.operations.push(row); expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: current caller or recent convenient window cannot replace original implementation', async () => {
    const f = fixture(); f.request.implementation[0].startedAt = AT; expect((await f.run()).verdict).toBe('unknown');
  });
  it('counterexample: empty audit with no positive controls cannot pass', async () => {
    const f = fixture(); f.records.operations = []; expect((await f.run()).verdict).toBe('unknown');
  });
  it('baseline: injected snapshot identity is frozen and collector calls no provider', async () => {
    const f = fixture(); const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    try {
      const wrapped: DeferredSpendActionDependencies = { withSnapshot: (identity, read) => {
        expect(Object.isFrozen(identity)).toBe(true); expect(Object.isFrozen(identity.censusSelectors)).toBe(true);
        return f.dependencies.withSnapshot(identity, read);
      } };
      expect((await collectDeferredSpendActionBoundary(f.request, f.source, wrapped)).verdict).toBe('pass');
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); }
  });
});
