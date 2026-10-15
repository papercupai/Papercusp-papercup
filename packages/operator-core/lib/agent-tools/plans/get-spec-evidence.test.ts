/**
 * plans:get-spec-evidence — compact by default (review-system-rework-reduction-2026-09-23
 * P-007, clause RSR-P-007-A). Falsifier: the default response carries the full body, or
 * omits the ref to it. Probe: call the read with and without detail:'full' and compare
 * shape and size.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const listEvidence = vi.mocked(listSpecEvidence);
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

const call = async (args: Record<string, unknown>) =>
  ((await tool.handler(tool.args.parse(args) as never, {} as never)) as { data: Record<string, any> }).data;

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
  mockResolvedTyped(listEvidence, [
    binding(1, 'SPEC-A', 'current'),
    binding(2, 'SPEC-A', 'stale'),
    binding(3, 'SPEC-B', 'unknown'),
  ]);
});

describe('plans:get-spec-evidence detail levels', () => {
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

  it.each([[true, 'full'], [false, 'summary']] as const)('detail %s and %s preserve scope, currentness and tier', async (booleanDetail, stringDetail) => {
    const base = { harness: 'papercusp', slug: 'plan-a' };
    const aliased = await call({ ...base, detail: booleanDetail });
    const canonical = await call({ ...base, detail: stringDetail });
    expect(aliased).toEqual(canonical);
    expect(aliased).toMatchObject({ ok: true, detail: stringDetail, count: 3 });
    expect(aliased.evidence.map((row: EvidenceRow) => row.currentness.overall)).toEqual(['current', 'stale', 'unknown']);
    expect(Boolean(aliased.evidence[0].fingerprints)).toBe(booleanDetail);
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
});
