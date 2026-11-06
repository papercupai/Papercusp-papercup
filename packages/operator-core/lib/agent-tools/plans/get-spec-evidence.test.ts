/**
 * plans:get-spec-evidence — compact by default (review-system-rework-reduction-2026-09-23
 * P-007, clause RSR-P-007-A). Falsifier: the default response carries the full body, or
 * omits the ref to it. Probe: call the read with and without detail:'full' and compare
 * shape and size.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';

vi.mock('./spec-clauses-store', async original => ({
  ...(await original<typeof import('./spec-clauses-store')>()), listSpecClauses: vi.fn(async () => []),
}));
vi.mock('../../work-items', async original => ({
  ...(await original<typeof import('../../work-items')>()), getWorkItem: vi.fn(),
}));
vi.mock('./behavior-contract-resolver', async original => ({
  ...(await original<typeof import('./behavior-contract-resolver')>()), resolveWorkItemBehaviorContract: vi.fn(),
}));

vi.mock('../_harness-scope', async (original) => ({
  ...(await original<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (original) => ({
  ...(await original<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-evidence-store', async (original) => ({
  ...(await original<typeof import('./spec-evidence-store')>()),
  listSpecEvidence: vi.fn(),
}));

import tool from './get-spec-evidence';
import { listSpecEvidence } from './spec-evidence-store';
import { createCommittedTreeDiagnostics } from './committed-tree-reader';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { listSpecClauses, type SpecClauseRevision } from './spec-clauses-store';
import { getWorkItem } from '../../work-items';
import { resolveWorkItemBehaviorContract } from './behavior-contract-resolver';

const listEvidence = vi.mocked(listSpecEvidence);
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

const call = async (args: Record<string, unknown>) =>
  ((await tool.handler(tool.args.parse(args) as never, {} as never)) as { data: Record<string, any> }).data;

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'get-spec-evidence-dispatch-test',
  isSuperuser: true,
  uiClientId: 'su-get-spec-evidence-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

const binding = (id: number, specId: string, overall: 'current' | 'stale' | 'unknown'): EvidenceRow => ({
  id,
  workItemId: 'WI-1',
  planSlug: 'plan-a',
  specId,
  sourceValId: null,
  specRevision: 1,
  currentRevision: 1,
  specFingerprint: `sha256:${specId}`,
  evidenceKind: 'test',
  evidenceRef: `testing:run:${id}#packages/x.test.ts`,
  fingerprints: {
    sourceFingerprint: `sha256-file-set-v1:${'a'.repeat(64)}`,
    testFingerprint: `sha256-file-set-v1:${'b'.repeat(64)}`,
    fixtureFingerprint: null,
    rubricFingerprint: null,
    environmentFingerprint: null,
  },
  coverageEvidenceRef: null,
  testRunId: 1000 + id,
  testRunProvenance: null,
  observedAt: '2026-09-23T00:00:00.000Z',
  bindingFingerprint: `sha256:binding-${id}`,
  createdBy: 'su-binder',
  createdAt: '2026-09-23T00:00:01.000Z',
  details: {
    adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', coverageRungs: { l3: true } },
    observations: 'x'.repeat(600),
    currentMeasurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'], testPaths: ['test/a.test.ts'] },
  },
  currentness: {
    comparisonSupplied: true,
    provenance: 'server-measured',
    overall,
    dimensions: {
      spec: 'current', source: overall, test: 'current', fixture: 'not-applicable', rubric: 'not-applicable',
      environment: 'not-applicable', coverageEvidence: 'not-applicable', testRun: 'current',
    },
    staleReasons: overall === 'stale' ? ['source_fingerprint_mismatch'] : [],
    unknownReasons: overall === 'unknown' ? ['current-fingerprints-missing'] : [],
  },
  serverMeasurement: {
    status: 'measured',
    measuredDimensions: ['source', 'test'],
    current: {
      planSlug: 'plan-a',
      specId,
      specRevision: 1,
      specFingerprint: `sha256:${specId}`,
      evidenceKind: 'test',
      evidenceRef: `testing:run:${id}#packages/x.test.ts`,
      sourceFingerprint: `sha256-file-set-v1:${'a'.repeat(64)}`,
      testFingerprint: `sha256-file-set-v1:${'b'.repeat(64)}`,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSpecClauses).mockResolvedValue([]);
  mockResolvedTyped(listEvidence, [
    binding(1, 'SPEC-A', 'current'),
    binding(2, 'SPEC-A', 'stale'),
    binding(3, 'SPEC-B', 'unknown'),
  ]);
});

describe('criterion evidence applicability', () => {
  const clause: SpecClauseRevision = {
    planSlug: 'plan-a', specId: 'SPEC-A', sourceValId: null, currentRevision: 1, revision: 1,
    planItemId: 'P-001', behavior: 'Measured evidence', behaviorClass: 'observability',
    requiredEvidence: ['test'], requiredTestLayers: ['unit'], mutationRequired: false,
    lifecycleStatus: 'active', supersedes: null, exemption: null, falsifier: null,
    contentHash: 'sha256:SPEC-A', createdBy: 'author', createdAt: '2026-09-23T00:00:00Z',
    acceptedBy: 'author', acceptedAt: '2026-09-23T00:00:00Z', acceptanceRef: 'test',
  };
  beforeEach(() => {
    vi.mocked(listSpecClauses).mockResolvedValue([clause]);
    const row = binding(1, 'SPEC-A', 'current');
    row.details = { ...row.details, evidencePlane: 'tree' };
    listEvidence.mockResolvedValue([row]);
  });
  it('criterion-zero-bindings: emits a missing row with an evaluation stamp and next action', async () => {
    listEvidence.mockResolvedValue([]);
    const result = await call({ slug: 'plan-a' });
    expect(result.applicability.criteria).toMatchObject([{ state: 'missing', spec: { specId: 'SPEC-A' },
      receipts: [], reasons: ['no-bindings-in-requested-selection'], responsibleRole: 'evidence-producer' }]);
    expect(Date.parse(result.applicability.criteria[0].evaluatedAt)).toBeGreaterThan(0);
    expect(result.applicability.criteria[0].nextEvidenceAction).toContain('bind');
  });
  it('evidence-current: admits measured matching evidence within its scope', async () => {
    const result = await call({ slug: 'plan-a' });
    expect(result.applicability.criteria[0]).toMatchObject({ state: 'current', target: { planSlug: 'plan-a' } });
    expect(result.applicability.criteria[0].nextEvidenceAction).toContain('ordinary acceptance checks');
  });
  it('evidence-fingerprint-fields: retains every measured dimension and receipt identity', async () => {
    const result = await call({ slug: 'plan-a' });
    expect(result.applicability.criteria[0]).toMatchObject({ state: 'current', target: { planSlug: 'plan-a' },
      receipts: [{ bindingId: 1, evidencePlane: 'tree', fingerprints: binding(1, 'SPEC-A', 'current').fingerprints,
        currentness: { dimensions: { source: 'current', test: 'current', fixture: 'not-applicable',
          rubric: 'not-applicable', environment: 'not-applicable' } }, freshnessBasis: { status: 'measured' } }] });
  });
  it('evidence-missing: an empty selection never becomes a current evidence receipt', async () => {
    listEvidence.mockResolvedValue([]);
    const row = (await call({ slug: 'plan-a' })).applicability.criteria[0];
    expect(row.state).toBe('missing');
    expect(row.receipts).toEqual([]);
    expect(row.reasons).toContain('no-bindings-in-requested-selection');
  });
  it('evidence-next-action: changes the action when an instrument becomes unavailable', async () => {
    const current = (await call({ slug: 'plan-a' })).applicability.criteria[0];
    const row = binding(1, 'SPEC-A', 'unknown');
    row.serverMeasurement = { status: 'unavailable', reason: 'compiler-unavailable' };
    listEvidence.mockResolvedValue([row]);
    const unavailable = (await call({ slug: 'plan-a' })).applicability.criteria[0];
    expect(unavailable.responsibleRole).toBe('evidence-producer');
    expect(unavailable.nextEvidenceAction).toContain('Restore');
    expect(unavailable.nextEvidenceAction).not.toBe(current.nextEvidenceAction);
  });
  it.each(['stale', 'unknown'] as const)('evidence-%s: cannot present an unresolved measurement as current', async state => {
    const row = binding(1, 'SPEC-A', state); row.details = { evidencePlane: 'tree' };
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a' })).applicability.criteria[0].state).toBe(state);
  });
  it('evidence-incompatible: identifies a prior spec fingerprint separately from stale source', async () => {
    const row = binding(1, 'SPEC-A', 'current'); row.specFingerprint = 'old';
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a' })).applicability.criteria[0]).toMatchObject({ state: 'incompatible',
      reasons: expect.arrayContaining(['spec-identity-incompatible']) });
  });
  it('evidence-instrument-unavailable: exposes the failed instrument and recovery action', async () => {
    const row = binding(1, 'SPEC-A', 'unknown');
    row.serverMeasurement = { status: 'unavailable', reason: 'compiler-unavailable' };
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a' })).applicability.criteria[0]).toMatchObject({ state: 'unavailable',
      nextEvidenceAction: expect.stringContaining('Restore') });
  });
  it('evidence-withdrawn: preserves withdrawal without allowing a current pass', async () => {
    const row = { ...binding(1, 'SPEC-A', 'current'), withdrawal: {
      at: '2026-09-23T00:01:00Z', by: 'author', reason: 'incorrect proof' } };
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a', bindingIds: [1], includeRetracted: true })).applicability.criteria[0])
      .toMatchObject({ receipts: [{ state: 'rejected', reasons: expect.arrayContaining(['evidence-withdrawn']) }] });
  });
  it('bounded-coverage: returns one bounded row and cannot certify a truncated evidence selection', async () => {
    listEvidence.mockResolvedValue([binding(1, 'SPEC-A', 'current'), binding(2, 'SPEC-A', 'current')]);
    const result = await call({ slug: 'plan-a', limit: 1 });
    expect(result.applicability.criteria).toHaveLength(1);
    expect(result.applicability.criteria[0]).toMatchObject({ state: 'unknown', coverage: { complete: false } });
    expect(result.applicability.coverage.evidenceTruncated).toBe(true);
  });
  it('live target/window applicability: missing identity remains unknown even when fingerprints match', async () => {
    const row = binding(1, 'SPEC-A', 'current'); row.details = { evidencePlane: 'live' };
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a' })).applicability.criteria[0]).toMatchObject({ state: 'unknown',
      reasons: ['applicable-live-target-or-window-unmeasured'] });
  });
  it('dirty-source: preserves the measured dirty-source gap without fabricating freshness', async () => {
    const row = binding(1, 'SPEC-A', 'unknown');
    row.details = { evidencePlane: 'tree' };
    row.currentness.unknownReasons = ['test-run-worktree-dirty'];
    listEvidence.mockResolvedValue([row]);
    expect((await call({ slug: 'plan-a' })).applicability.criteria[0]).toMatchObject({ state: 'unknown',
      reasons: ['test-run-worktree-dirty'], nextEvidenceAction: expect.stringContaining('unknown dimensions') });
  });
  it('adhoc-plan-association: preserves a null actual association while reading the clause namespace', async () => {
    vi.mocked(getWorkItem).mockResolvedValue({ id: 'WI-1', harness: 'papercusp', sourcePlanSlug: null } as Awaited<ReturnType<typeof getWorkItem>>);
    vi.mocked(resolveWorkItemBehaviorContract).mockResolvedValue({ groups: [{ planSlug: 'plan-a', clauses: [clause] }] } as Awaited<ReturnType<typeof resolveWorkItemBehaviorContract>>);
    const result = await call({ slug: 'plan-a', workItemIds: ['WI-1'] });
    expect(result.applicability.criteria[0]).toMatchObject({ target: { workItemId: 'WI-1', planSlug: null },
      spec: { planSlug: 'plan-a' } });
  });
});

describe('plans:get-spec-evidence detail levels', () => {
  it('resolves exact binding IDs in the caller workspace even when another namespace has the same ID', async () => {
    const selected = binding(7, 'SELECTED', 'unknown');
    const foreign = binding(7, 'FOREIGN', 'unknown');
    listEvidence.mockImplementation(async options => [options.workspaceId === 'selected-workspace' ? selected : foreign]);
    const result = await tool.handler(tool.args.parse({ harness: 'papercusp', slug: 'plan-a', bindingIds: [7] }),
      { workspaceId: 'selected-workspace' } as never) as { data: { evidence: EvidenceRow[] } };
    expect(result.data.evidence).toMatchObject([{ id: 7, specId: 'SELECTED' }]);
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'selected-workspace' }));
  });

  it('leaves operator wildcard workspace unpinned for canonical scope resolution', async () => {
    listEvidence.mockResolvedValue([]);
    await tool.handler(tool.args.parse({ harness: 'papercusp', slug: 'plan-a' }), { workspaceId: '*' } as never);
    expect(listEvidence.mock.calls[0]![0]).not.toHaveProperty('workspaceId');
  });

  it('allows exact-ID audit reads of withdrawn bindings and exposes their withdrawal stamp', async () => {
    const withdrawn = {
      ...binding(38856, 'SPEC-A', 'stale'),
      withdrawal: {
        at: '2026-10-12T08:09:46.000Z',
        by: 'su-binder',
        reason: 'superseded by binding 38907 (plans:bind-spec-evidence supersedeAtRevision)',
      },
    } as EvidenceRow;
    listEvidence.mockResolvedValue([withdrawn]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      bindingIds: [38856],
      includeRetracted: true,
    });

    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      bindingIds: [38856],
      includeRetracted: true,
      planSlugs: ['plan-a'],
    }));
    expect(result.evidence[0]).toMatchObject({
      id: 38856,
      withdrawal: withdrawn.withdrawal,
    });
  });

  it('requires an exact non-empty binding selector before including withdrawn evidence', () => {
    expect(tool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      includeRetracted: true,
    }).success).toBe(false);
    expect(tool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      bindingIds: [],
      includeRetracted: true,
    }).success).toBe(false);
  });

  it('publishes the cross-field audit selector contract in the input schema', () => {
    expect(tool.args.shape.bindingIds.description).toMatch(/required as a non-empty selector when includeRetracted:true/i);
    expect(tool.args.shape.includeRetracted.description).toMatch(/requires bindingIds with at least one exact row id/i);
    expect(tool.description).toMatch(/includeRetracted:true.*non-empty exact bindingIds selector/i);
  });

  it.each([[true, 'full'], [false, 'summary']] as const)('detail %s and %s preserve scope, currentness and tier', async (booleanDetail, stringDetail) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T00:02:00Z'));
    try {
      const base = { harness: 'papercusp', slug: 'plan-a' };
      const aliased = await call({ ...base, detail: booleanDetail });
      const canonical = await call({ ...base, detail: stringDetail });
      expect(aliased).toEqual(canonical);
      expect(aliased).toMatchObject({ ok: true, detail: stringDetail, count: 3 });
      expect(aliased.evidence.map((row: EvidenceRow) => row.currentness.overall)).toEqual(['current', 'stale', 'unknown']);
      expect(Boolean(aliased.evidence[0].fingerprints)).toBe(booleanDetail);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])('boolean current=%s omits caller fingerprints without promoting stale or unavailable evidence', async (current) => {
    const result = await call({ harness: 'papercusp', slug: 'plan-a', current });
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ current: undefined }));
    expect(result.evidence.map((row: EvidenceRow) => row.currentness.overall)).toEqual(['current', 'stale', 'unknown']);
  });

  it('forwards only this request\'s committed-reader observations into metadata', async () => {
    const metadata = vi.fn();
    const cold = { ...createCommittedTreeDiagnostics(), reads: 1, memoMisses: 2,
      batchAttempts: 1, batchSucceeded: 1, blobsRequested: 2, blobsReturned: 2, blobsVerified: 2,
      batchRoutes: { sidecar: 1, local: 0, injected: 0 } };
    listEvidence.mockImplementation(async (options) => {
      options.diagnostics!.committedTree = cold;
      return [];
    });
    await tool.handler(tool.args.parse({ slug: 'plan-a', harness: 'papercusp' }) as never, { metadata } as never);
    expect(metadata).toHaveBeenCalledWith({ plansGetSpecEvidenceStageTimings: expect.objectContaining({
      committedTree: cold,
    }) });
    listEvidence.mockImplementation(async (options) => {
      expect(options.diagnostics!.committedTree).toMatchObject({
        requestTraceId: null,
        toolName: 'plans:get-spec-evidence',
        spawnBoundaryRecords: [],
        spawnBoundaryRecordsDropped: 0,
      });
      options.diagnostics!.committedTree = createCommittedTreeDiagnostics();
      return [];
    });
    await tool.handler(tool.args.parse({ slug: 'plan-a', harness: 'papercusp' }) as never, { metadata } as never);
    expect(metadata.mock.calls[1][0].plansGetSpecEvidenceStageTimings.committedTree)
      .toEqual(createCommittedTreeDiagnostics());
  });

  it('threads the current MCP request trace into bounded committed-reader diagnostics', async () => {
    const requestTraceId = 'trace-current-mcp-request';
    let captured: ReturnType<typeof createCommittedTreeDiagnostics> | undefined;
    listEvidence.mockImplementation(async (options) => {
      captured = options.diagnostics!.committedTree;
      return [];
    });

    await tool.handler(
      tool.args.parse({ slug: 'plan-a', harness: 'papercusp' }) as never,
      { requestOrigin: { mcpRequestTraceId: requestTraceId } } as never,
    );

    expect(captured).toMatchObject({
      requestTraceId,
      toolName: 'plans:get-spec-evidence',
      spawnBoundaryRecords: [],
      spawnBoundaryRecordsDropped: 0,
    });
  });

  it('returns a per-binding currentness table, a byClause rollup and a fullBody ref by default', async () => {
    const summary = await call({ harness: 'papercusp', slug: 'plan-a' });
    const full = await call({ harness: 'papercusp', slug: 'plan-a', detail: 'full' });

    expect(summary).toMatchObject({
      ok: true,
      detail: 'summary',
      count: 3,
      bounded: { limit: 200, truncatedByLimit: false },
      currentness: { current: 1, stale: 1, unknown: 1 },
      fullBody: {
        tool: 'plans:get-spec-evidence',
        args: { harness: 'papercusp', slug: 'plan-a', detail: 'full' },
        omitted: expect.arrayContaining(['evidence[].fingerprints', 'evidence[].details']),
      },
    });
    expect(summary.byClause).toEqual([
      { specId: 'SPEC-A', specRevision: 1, bindings: 2, current: 1, stale: 1, unknown: 0 },
      { specId: 'SPEC-B', specRevision: 1, bindings: 1, current: 0, stale: 0, unknown: 1 },
    ]);
    expect(summary.evidence[1]).toEqual({
      id: 2,
      workItemId: 'WI-1',
      specId: 'SPEC-A',
      specRevision: 1,
      evidenceKind: 'test',
      evidenceRef: 'testing:run:2#packages/x.test.ts',
      testRunId: 1002,
      currentness: { overall: 'stale', staleReasons: ['source_fingerprint_mismatch'], unknownReasons: [] },
    });

    // Full: every binding as stored, and no ref.
    expect(full).toMatchObject({ ok: true, detail: 'full', count: 3 });
    expect(full).not.toHaveProperty('fullBody');
    expect(full.evidence[0]).toHaveProperty('fingerprints');
    expect(full.evidence[0]).toHaveProperty('details');
    expect(full.evidence[0].currentness).toHaveProperty('dimensions');

    // The selector never reaches the store as a filter.
    expect(listEvidence).toHaveBeenCalledWith(expect.not.objectContaining({ detail: expect.anything() }));
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  it('reports when a limited read omits rows from the aggregate population', async () => {
    const population = [
      binding(1, 'SPEC-A', 'current'),
      binding(2, 'SPEC-A', 'stale'),
      binding(3, 'SPEC-A', 'unknown'),
      binding(4, 'SPEC-B', 'current'),
    ];
    listEvidence.mockImplementation(async (options) => population.slice(0, options.limit ?? 200));

    const result = await call({ harness: 'papercusp', slug: 'plan-a', limit: 3 });

    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      limit: 4,
      planSlugs: ['plan-a'],
    }));
    expect(result).toMatchObject({
      count: 3,
      bounded: { limit: 3, truncatedByLimit: true },
      byClause: [{ specId: 'SPEC-A', specRevision: 1, bindings: 3, current: 1, stale: 1, unknown: 1 }],
    });
    expect(result.evidence).toHaveLength(3);
  });

  it('narrows detail:full passedCaseTitles to the declared cases, with the total and a ledger ref (WI-6554700010009931)', async () => {
    const base = binding(7, 'SPEC-A', 'current');
    const adequacy = (base.details as { adequacy: Record<string, unknown> }).adequacy;
    const execution = {
      status: 'pass',
      passed: 400,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      filePath: 'packages/x.test.ts',
      passedCaseTitles: Array.from({ length: 400 }, (_value, index) => `suite > case ${index}`),
    };
    const declared = {
      ...base,
      details: { ...base.details, adequacy: { ...adequacy, testCases: ['case 3', 'suite > case 17'] } },
      testRunExecution: execution,
    } as EvidenceRow;
    const llm = { ...declared, id: 8, testRunExecution: { ...execution, testLayer: 'llm' } } as EvidenceRow;
    const fullyDeclared = {
      ...base,
      id: 9,
      details: { ...base.details, adequacy: { ...adequacy, testCases: ['only'] } },
      testRunExecution: { ...execution, passed: 1, passedCaseTitles: ['suite > only'] },
    } as EvidenceRow;
    listEvidence.mockResolvedValue([declared, llm, fullyDeclared]);

    const full = await call({ harness: 'papercusp', slug: 'plan-a', detail: 'full' });

    // Only titles a declared case matches survive (a whole-segment suffix: 'case 3' keeps
    // 'suite > case 3' and not 'suite > case 30'); the counters say how many were dropped.
    expect(full.evidence[0].testRunExecution).toEqual({
      ...execution,
      passedCaseTitles: ['suite > case 3', 'suite > case 17'],
      passedCaseTitleCount: 400,
      passedCaseTitlesOmitted: 398,
      passedCaseTitlesRef: { tool: 'testing:runs', args: { testRunIds: [1007], cases: true } },
    });
    // LLM-layer cases are corroborated by scenario, not title: untouched.
    expect(full.evidence[1].testRunExecution.passedCaseTitles).toHaveLength(400);
    expect(full.evidence[1].testRunExecution).not.toHaveProperty('passedCaseTitleCount');
    // Nothing to omit: the row is returned as stored.
    expect(full.evidence[2]).toEqual(fullyDeclared);
    // The store rows the adequacy evaluator reads are not mutated.
    expect(declared.testRunExecution?.passedCaseTitles).toHaveLength(400);
    expect(JSON.stringify(full.evidence[0]).length).toBeLessThan(JSON.stringify(declared).length / 2);

    // The summary tier never carried titles and is unchanged.
    const summary = await call({ harness: 'papercusp', slug: 'plan-a' });
    expect(summary.evidence[0]).not.toHaveProperty('testRunExecution');
  });

  it("preserves detail:'full' binding adequacy through a trimmed projected dispatch", async () => {
    const large = binding(42, 'SPEC-A', 'current');
    large.details = {
      ...large.details,
      observations: 'evidence-'.repeat(1_500),
      adequacy: {
        ...(large.details.adequacy as Record<string, unknown>),
        testCases: ['selected evidence case'],
      },
    };
    listEvidence.mockResolvedValue([large]);

    const direct = await call({ harness: 'papercusp', slug: 'plan-a', detail: 'full' });
    const rawChars = JSON.stringify(direct).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('plans:get-spec-evidence');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    expect(projected?.skipResultDoor).toBe('oversize-by-design');

    const dispatched = await dispatchProjectedTool(
      projected!,
      'plans:get-spec-evidence',
      { harness: 'papercusp', slug: 'plan-a', detail: 'full' },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      detail: 'full';
      evidence: Array<{ details: { adequacy: { testCases: string[] } } }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.detail).toBe('full');
    expect(payload?.evidence[0]?.details.adequacy.testCases).toEqual(['selected evidence case']);
  });
});
