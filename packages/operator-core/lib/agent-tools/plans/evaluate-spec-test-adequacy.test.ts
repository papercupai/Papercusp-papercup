import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mockResolvedTyped } from '../../testing/typed-mock';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';

const harnessRoot = vi.hoisted(() => ({ path: '' }));
const acceptanceRubricMocks = vi.hoisted(() => ({
  active: vi.fn(),
  retired: vi.fn(),
}));
const adhocContractMocks = vi.hoisted(() => ({ workItem: vi.fn(), contract: vi.fn() }));
const scorecardMocks = vi.hoisted(() => ({ readEvidence: vi.fn() }));

vi.mock('../../work-items', () => ({ getWorkItem: adhocContractMocks.workItem }));
vi.mock('./behavior-contract-resolver', () => ({ resolveWorkItemBehaviorContract: adhocContractMocks.contract }));

vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({
    projects: [{ slug: 'papercusp', path: harnessRoot.path }],
  }),
  resolveHarnessContentPath: (registry: { projects: Array<{ slug: string; path: string }> }, slug: string) =>
    registry.projects.find((project) => project.slug === slug)?.path,
}));
vi.mock('../_harness-scope', async (original) => ({
  ...(await original<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (original) => ({
  ...(await original<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-clauses-store', async (original) => ({
  ...(await original<typeof import('./spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
vi.mock('./spec-evidence-store', async (original) => ({
  ...(await original<typeof import('./spec-evidence-store')>()),
  listSpecEvidence: vi.fn(),
}));
vi.mock('../../rubrics', async (original) => ({
  ...(await original<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: acceptanceRubricMocks.active,
  getRetiredAcceptanceRubricsForPlan: acceptanceRubricMocks.retired,
}));
vi.mock('../../build-info', () => ({
  getBuildInfo: vi.fn(() => ({ sha: 'live-evaluator-sha', version: '1.2.3' })),
}));
vi.mock('../../scorecards', async (original) => ({
  ...(await original<typeof import('../../scorecards')>()),
  readScorecardEvidence: scorecardMocks.readEvidence,
}));

import tool from './evaluate-spec-test-adequacy';
import { replaySpecTestAdequacyForHistoricalAudit } from './evaluate-spec-test-adequacy';
import { evaluateSpecTestAdequacy } from './spec-test-adequacy';
import { readScorecardEvidence } from '../../scorecards';
import type { SpecTestAdequacyRerunRecipe } from '../../harness/improvements/observation-types';
import { listSpecClauses } from './spec-clauses-store';
import { listSpecEvidence } from './spec-evidence-store';
import { getAcceptanceRubricsForPlan, getRetiredAcceptanceRubricsForPlan } from '../../rubrics';

const listClauses = vi.mocked(listSpecClauses);
const listEvidence = vi.mocked(listSpecEvidence);
/** One fully typed `listSpecEvidence` row shared by the selection-cohort tests. */
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];
const listAcceptanceRubrics = vi.mocked(getAcceptanceRubricsForPlan);
const listRetiredAcceptanceRubrics = vi.mocked(getRetiredAcceptanceRubricsForPlan);
const readScorecard = vi.mocked(readScorecardEvidence);

type ToolOutput = { data: Record<string, any> };

const call = async (args: Record<string, unknown>, context: Record<string, unknown> = {}) =>
  ((await tool.handler(args as never, { workspaceId: 'workspace-test', ...context } as never)) as ToolOutput).data;

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'spec-test-adequacy-dispatch-test',
  isSuperuser: true,
  uiClientId: 'su-spec-test-adequacy-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

const clause = (lifecycleStatus: 'draft' | 'active' | 'accepted' = 'draft') =>
  ({
    planSlug: 'plan-a',
    specId: 'SPEC-001',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'The selected behavior is observable.',
    behaviorClass: 'happy-path',
    requiredEvidence: ['integration'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus,
    supersedes: null,
    exemption: null,
    falsifier: { observation: 'The selected behavior is absent.' },
    contentHash: 'sha256:spec-001',
    createdBy: 'su-test',
    createdAt: '2026-09-07T00:00:00.000Z',
    acceptedBy: lifecycleStatus === 'draft' ? null : 'reviewer',
    acceptedAt: lifecycleStatus === 'draft' ? null : '2026-09-07T00:01:00.000Z',
    acceptanceRef: lifecycleStatus === 'draft' ? null : 'D-001',
    sourceBar: null,
  }) as unknown as Awaited<ReturnType<typeof listSpecClauses>>[number];

beforeEach(() => {
  vi.clearAllMocks();
  listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);
  listClauses.mockResolvedValue([clause()]);
  listAcceptanceRubrics.mockResolvedValue([
    { rubricId: 'plan-a-acceptance', classRef: 'plan-class-feature-ship' } as never,
  ]);
  listRetiredAcceptanceRubrics.mockResolvedValue([]);
  adhocContractMocks.workItem.mockResolvedValue({ id: 'EI-12345', harness: 'papercusp', kind: 'bug' });
  adhocContractMocks.contract.mockResolvedValue({
    groups: [{ planSlug: 'adhoc-work-item-specs', clauses: [{ specId: 'adhoc.EI-12345.deadline' }] }],
  });
});

describe('plans:evaluate-spec-test-adequacy handler', () => {
  it('declares a nested replay budget above the flat MCP transport deadline', () => {
    expect((tool as { timeoutSec?: number }).timeoutSec).toBeGreaterThan(55);
  });

  it('records timings for class, evidence, clause, disclosure, and evaluation stages', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const metadata = vi.fn();
    const result = await call(
      tool.args.parse({ harness: 'papercusp', slug: 'plan-a', specIds: ['SPEC-001'], detail: 'summary' }),
      { metadata },
    );

    expect(result.ok).toBe(true);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      plansEvaluateSpecTestAdequacyStageTimings: expect.objectContaining({
        schemaVersion: 'plans-evaluate-spec-test-adequacy-stage-timings-v1',
        detail: 'summary',
        phaseMs: expect.objectContaining({
          classResolution: expect.any(Number),
          selectedEvidenceRead: expect.any(Number),
          clausesRead: expect.any(Number),
          artifactDisclosureRead: expect.any(Number),
          evaluation: expect.any(Number),
          totalBeforeResponse: expect.any(Number),
        }),
        counts: expect.objectContaining({
          selectedEvidence: expect.any(Number),
          disclosedGapEvidence: expect.any(Number),
          clauses: 1,
          eligibleClauses: 1,
          artifactDisclosures: expect.any(Number),
        }),
      }),
    }));
  });

  it('keeps selected and disclosed evidence diagnostics attributed to their own reads', async () => {
    const metadata = vi.fn();
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockImplementation(async (options) => {
      const diagnostics = options.diagnostics;
      if (!diagnostics) throw new Error('evidence diagnostics should be wired');
      const selected = options.bindingIds !== undefined;
      diagnostics.phaseMs.query = selected ? 11 : 22;
      diagnostics.bindings.selectedRows = selected ? 1 : 2;
      diagnostics.bindings.rowsWithRecipe = selected ? 1 : 2;
      return [{ id: 1, specId: 'SPEC-001' } as never];
    });

    const result = await call(
      tool.args.parse({
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        bindingIds: [1],
      }),
      { metadata },
    );

    expect(result.ok).toBe(true);
    const timings = metadata.mock.calls.at(-1)?.[0]?.plansEvaluateSpecTestAdequacyStageTimings;
    expect(timings).toMatchObject({
      listSpecEvidenceDiagnostics: {
        schemaVersion: 'list-spec-evidence-diagnostics-v1',
        selectedEvidenceRead: {
          phaseMs: { query: 11 },
          bindings: { selectedRows: 1, rowsWithRecipe: 1 },
        },
        disclosedGapEvidenceRead: {
          phaseMs: { query: 22 },
          bindings: { selectedRows: 2, rowsWithRecipe: 2 },
        },
      },
    });
  });

  it.each([[true, 'full'], [false, 'summary']] as const)('detail %s and %s preserve the exact clause verdict and tier', async (booleanDetail, stringDetail) => {
    listClauses.mockResolvedValue([clause('active')]);
    const base = { harness: 'papercusp', slug: 'plan-a', specIds: ['SPEC-001'] };
    const aliased = await call(tool.args.parse({ ...base, detail: booleanDetail }));
    const canonical = await call(tool.args.parse({ ...base, detail: stringDetail }));
    expect(aliased).toEqual(canonical);
    expect(aliased).toMatchObject({ ok: true, detail: stringDetail, count: 1, rows: [expect.objectContaining({ specId: 'SPEC-001' })] });
    expect(Boolean(aliased.rows[0].scorecardDraft)).toBe(booleanDetail);
  });

  it.each([true, false])('boolean current=%s requests server measurement and cannot attest missing proof', async (current) => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([]);
    const parsed = tool.args.parse({ harness: 'papercusp', slug: 'plan-a', current });
    expect(parsed.current).toBe(current);
    const result = await call(parsed);
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ current: undefined }));
    expect(result.rows[0].ratings.freshness.rating).not.toBe('pass');
    expect(result.rows[0].wouldBlock).toContain('freshness');
  });

  it('marks a replay with unavailable server measurements as degraded in summary and full results', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([{
      id: 91,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      specRevision: 1,
      currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: 42,
      testRunProvenance: null,
      details: { adequacy: { testLayer: 'integration', outcome: 'pass', executed: true } },
      observedAt: '2026-09-07T00:00:00.000Z',
      bindingFingerprint: 'sha256:binding-91',
      createdBy: 'su-test',
      createdAt: '2026-09-07T00:00:00.000Z',
      currentness: {
        overall: 'unknown',
        provenance: 'replayed-snapshot',
        comparisonSupplied: true,
        dimensions: { spec: 'current', source: 'unknown', test: 'unknown' },
        staleReasons: [],
        unknownReasons: ['server-measurement-unavailable:repo_measurement_timeout'],
      },
      serverMeasurement: { status: 'unavailable', reason: 'repo_measurement_timeout' },
    } as never]);

    const base = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      replaySnapshot: true,
      current: [],
    };
    const summary = await call({ ...base, detail: 'summary' });
    const full = await call({ ...base, detail: 'full' });

    const expectedMeasurementEvidence = {
      status: 'degraded',
      selectedBindings: 1,
      measuredBindings: 0,
      bindings: [{
        bindingId: 91,
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        status: 'unavailable',
      }],
      unavailableBindings: [{
        id: 91,
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        reason: 'repo_measurement_timeout',
      }],
      withoutMeasurementBasis: [],
    };
    expect(summary.rows[0].measurementEvidence).toEqual(expectedMeasurementEvidence);
    expect(full.rows[0].measurementEvidence).toEqual(expectedMeasurementEvidence);
    expect(summary.rows[0].ratings.freshness.rating).toBe('unknown');
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      replaySnapshot: true,
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
    }));
  });

  it('derives omitted classRef from the persisted subject class without waiving proof', async () => {
    listAcceptanceRubrics.mockResolvedValue([{ rubricId: 'plan-a-acceptance', classRef: 'plan-class-bugfix' } as never]);
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([]);
    const args = { harness: 'papercusp', slug: 'plan-a', detail: 'full' };
    expect(tool.args.safeParse(args).success).toBe(true);
    const result = await call(args);
    expect(result).toMatchObject({ ok: true, classRef: 'plan-class-bugfix', classRefSource: 'active-acceptance-rubric' });
    expect(result.rows[0].requiredProofFloor).toBe('l4');
    expect(result.rows[0].wouldBlock.length).toBeGreaterThan(0);
  });
  it('evaluates an exact ad-hoc work-item clause without a plan acceptance rubric', async () => {
    listAcceptanceRubrics.mockResolvedValue([]);
    listRetiredAcceptanceRubrics.mockResolvedValue([]);
    listClauses.mockResolvedValue([{
      ...clause('active'),
      planSlug: 'adhoc-work-item-specs',
      specId: 'adhoc.EI-12345.deadline',
      planItemId: 'P-12345',
    }]);

    const result = await call({
      harness: 'papercusp',
      slug: 'adhoc-work-item-specs',
      classRef: 'plan-class-bugfix',
      workItemIds: ['EI-12345'],
      specIds: ['adhoc.EI-12345.deadline'],
      detail: 'full',
    });

    expect(result).toMatchObject({ ok: true, count: 1, classRef: 'plan-class-bugfix', classRefSource: 'work-item-completion-attestation' });
    expect(adhocContractMocks.workItem).toHaveBeenCalledWith('EI-12345', 'papercusp');
    expect(adhocContractMocks.contract).toHaveBeenCalledWith({ id: 'EI-12345', harness: 'papercusp', kind: 'bug' });
    expect(listAcceptanceRubrics).not.toHaveBeenCalled();
    expect(listRetiredAcceptanceRubrics).not.toHaveBeenCalled();
    // Resolving a class allows honest grading; absent proof must still block certification.
    expect(result.rows[0].wouldBlock.length).toBeGreaterThan(0);
    expect(result.rows[0].requiredProofFloor).toBe('l4');
    expect(result.rows[0].scorecardDraft.rerunRecipe.args).toMatchObject({
      slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix',
      workItemIds: ['EI-12345'], specIds: ['adhoc.EI-12345.deadline'],
    });
  });

  it.each([undefined, ['EI-12345', 'EI-67890']])('refuses a namespace-wide or mixed-work-item ad-hoc attestation (%j)', async (workItemIds) => {
    const result = await call({ slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix', workItemIds });
    expect(result).toMatchObject({ ok: false, error: 'adhoc_work_item_required', count: 0 });
    expect(adhocContractMocks.workItem).not.toHaveBeenCalled();
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'EI-12345', harness: 'elsewhere' }])('refuses an absent or cross-harness work item (%j)', async (workItem) => {
    adhocContractMocks.workItem.mockResolvedValue(workItem);
    const result = await call({ slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix', workItemIds: ['EI-12345'] });
    expect(result).toMatchObject({ ok: false, error: 'adhoc_work_item_unresolved', count: 0 });
    expect(adhocContractMocks.contract).not.toHaveBeenCalled();
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('refuses a clause outside the exact work-item contract', async () => {
    const result = await call({ slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix', workItemIds: ['EI-12345'], specIds: ['adhoc.EI-67890.deadline'] });
    expect(result).toMatchObject({ ok: false, error: 'adhoc_spec_outside_work_item', count: 0 });
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('fails closed on unresolved or unreadable ad-hoc contracts', async () => {
    const args = { slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix', workItemIds: ['EI-12345'] };
    adhocContractMocks.contract.mockResolvedValue({ groups: [] });
    expect(await call(args)).toMatchObject({ ok: false, error: 'adhoc_contract_unresolved', count: 0 });
    adhocContractMocks.contract.mockRejectedValue(new Error('contract unavailable'));
    expect(await call(args)).toMatchObject({ ok: false, error: 'adhoc_contract_read_unavailable', count: 0 });
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('keeps a binding-only ad-hoc selection inside the resolved contract', async () => {
    listEvidence.mockResolvedValue([{ specId: 'SPEC-OTHER' } as never]);
    listClauses.mockResolvedValue([clause('active')]);
    const result = await call({ slug: 'adhoc-work-item-specs', classRef: 'plan-class-bugfix', workItemIds: ['EI-12345'], bindingIds: [42] });
    expect(result).toMatchObject({ ok: false, error: 'selection_empty', count: 0 });
    expect(result.rows).toBeUndefined();
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ workItemIds: ['EI-12345'], bindingIds: [42] }));
  });

  it('refuses a caller class that disagrees with the active acceptance rubric before grading', async () => {
    listAcceptanceRubrics.mockResolvedValue([
      { rubricId: 'plan-a-acceptance', classRef: 'plan-class-bugfix' } as never,
    ]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-investigation',
      specIds: ['SPEC-001'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'plan_class_mismatch',
      classRef: 'plan-class-bugfix',
      declaredClassRef: 'plan-class-bugfix',
      callerClassRef: 'plan-class-investigation',
      classRefSource: 'active-acceptance-rubric',
      count: 0,
      wouldBlock: [{ code: 'plan_class_mismatch' }],
    });
    expect(listEvidence).not.toHaveBeenCalled();
    expect(listClauses).not.toHaveBeenCalled();
  });

  it('uses the latest retired acceptance class for a shipped plan', async () => {
    listAcceptanceRubrics.mockResolvedValue([]);
    listRetiredAcceptanceRubrics.mockResolvedValue([
      { rubricId: 'latest-acceptance', classRef: 'plan-class-bugfix' } as never,
      { rubricId: 'older-acceptance', classRef: 'plan-class-feature-ship' } as never,
    ]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-bugfix',
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      classRef: 'plan-class-bugfix',
      declaredClassRef: 'plan-class-bugfix',
      classRefSource: 'retired-acceptance-rubric',
    });
    expect(listRetiredAcceptanceRubrics).toHaveBeenCalledWith('plan-a', { harnessSlug: 'papercusp' });
  });

  it('fails closed when no active or retired acceptance class can be resolved', async () => {
    listAcceptanceRubrics.mockResolvedValue([]);
    listRetiredAcceptanceRubrics.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'plan_class_unresolved',
      callerClassRef: 'plan-class-feature-ship',
      count: 0,
      wouldBlock: [{ code: 'plan-class-unresolved' }],
    });
    expect(listEvidence).not.toHaveBeenCalled();
    expect(listClauses).not.toHaveBeenCalled();
  });

  it('fails closed when the active acceptance class read is unavailable', async () => {
    listAcceptanceRubrics.mockRejectedValue(new Error('rubric store unavailable'));

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'plan_class_read_unavailable',
      callerClassRef: 'plan-class-feature-ship',
      count: 0,
      wouldBlock: [{ code: 'plan-class-read-unavailable' }],
    });
    expect(listRetiredAcceptanceRubrics).not.toHaveBeenCalled();
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('replays only the legacy supersession cohort as of card creation and leaves unavailable freshness unknown', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const historicalBinding: Awaited<ReturnType<typeof listSpecEvidence>>[number] = {
      id: 19999,
      workItemId: 'WI-10005377',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      coverageEvidenceRef: null,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      bindingFingerprint: 'sha256:binding-19999',
      createdBy: 'su-test',
      specRevision: 1,
      currentRevision: 2,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'test-run 20455199',
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      details: {},
      testRunId: 20455199,
      observedAt: '2026-10-01T23:00:00.000Z',
      createdAt: '2026-10-01T23:00:00.000Z',
      withdrawal: {
        at: '2026-10-02T01:00:00.000Z',
        by: 'su-reviewer',
        reason: 'superseded by binding 21019',
      },
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        comparisonSupplied: true,
        dimensions: {
          spec: 'current',
          source: 'current',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: [],
        unknownReasons: [],
      },
    };
    const laterReplacement = {
      ...historicalBinding,
      id: 21019,
      evidenceRef: 'test-run 20455231 replacement',
      createdAt: '2026-10-02T01:02:00.000Z',
      withdrawal: null,
    };
    mockResolvedTyped(listEvidence, [historicalBinding]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await replaySpecTestAdequacyForHistoricalAudit({
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        evidenceRefs: ['test-run 20455199'],
        includeDraft: true,
        limit: 25,
      },
      selection: {
        planSlug: 'plan-a',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test-run 20455199' }],
      },
      workspaceId: 'workspace-test',
      auditAsOf,
    });

    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-test',
        planSlugs: ['plan-a'],
        specIds: ['SPEC-001'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        evidenceRefs: ['test-run 20455199'],
        includeRetracted: true,
        auditAsOf,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      historicalAuditOnly: {
        provenance: 'historical-audit-only',
        asOf: auditAsOf.toISOString(),
        freshness: 'unknown-at-emission',
        bindings: [
          {
            id: 19999,
            withdrawal: { reason: 'superseded by binding 21019' },
          },
        ],
      },
    });
    expect((result as { rows: Array<{ ratings: Record<string, { rating: string }> }> }).rows[0].ratings.freshness.rating).toBe('unknown');
    expect(laterReplacement.createdAt > auditAsOf.toISOString()).toBe(true);
  });

  it('replays exact emission-time bindings and freshness after the live source drifts', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const current = [{
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test' as const,
      evidenceRef: 'test-run 20455199',
      sourceFingerprint: 'sha256:source-at-grade',
      testFingerprint: 'sha256:test-at-grade',
    }];
    const historicalBinding: Awaited<ReturnType<typeof listSpecEvidence>>[number] = {
      id: 19999,
      workItemId: 'WI-10005377',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      coverageEvidenceRef: null,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      bindingFingerprint: 'sha256:binding-19999',
      createdBy: 'su-test',
      specRevision: 1,
      currentRevision: 2,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'test-run 20455199',
      fingerprints: {
        sourceFingerprint: 'sha256:source-at-grade',
        testFingerprint: 'sha256:test-at-grade',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      details: {},
      testRunId: null,
      observedAt: '2026-10-01T23:00:00.000Z',
      createdAt: '2026-10-01T23:00:00.000Z',
      withdrawal: {
        at: '2026-10-02T01:00:00.000Z',
        by: 'su-reviewer',
        reason: 'superseded by binding 21019',
      },
      currentness: {
        overall: 'current',
        provenance: 'historical-snapshot',
        comparisonSupplied: true,
        dimensions: {
          spec: 'current',
          source: 'current',
          test: 'current',
          fixture: 'not-applicable',
          rubric: 'not-applicable',
          environment: 'not-applicable',
          coverageEvidence: 'not-applicable',
          testRun: 'not-applicable',
        },
        staleReasons: [],
        unknownReasons: [],
      },
    };
    mockResolvedTyped(listEvidence, [historicalBinding]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await replaySpecTestAdequacyForHistoricalAudit({
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        evidenceRefs: ['test-run 20455199'],
        bindingIds: [19999],
        current,
        includeDraft: true,
        limit: 25,
      },
      selection: {
        planSlug: 'plan-a',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test-run 20455199' }],
        bindingIds: [19999],
      },
      workspaceId: 'workspace-test',
      auditAsOf,
    });

    expect('sha256:source-after-drift').not.toBe(current[0]!.sourceFingerprint);
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      bindingIds: [19999],
      currentProvenance: 'historical-snapshot',
      current,
      includeRetracted: true,
      auditAsOf,
    }));
    expect(result).toMatchObject({
      ok: true,
      historicalAuditOnly: {
        provenance: 'historical-audit-only',
        asOf: auditAsOf.toISOString(),
        freshness: 'historical-snapshot',
        bindings: [{ id: 19999, withdrawal: { reason: 'superseded by binding 21019' } }],
      },
    });
    expect((result as { rows: Array<{ ratings: Record<string, { rating: string }> }> }).rows[0]!.ratings.freshness!.rating)
      .toBe('pass');
  });

  it('routes a scorecardId through its stored recipe and replays retracted bindings as of card creation', async () => {
    const createdAt = '2026-10-12T07:19:17.178Z';
    const recipe: SpecTestAdequacyRerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        evidenceRefs: ['test-run 20455199'],
        bindingIds: [19999],
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        includeDraft: true,
      },
      selection: {
        planSlug: 'plan-a',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        bindingIds: [19999],
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test-run 20455199' }],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    readScorecard.mockResolvedValue({
      kind: 'found',
      scorecard: {
        issueId: 'EI-12345',
        createdAt,
        rubricRef: 'spec-test-adequacy',
        sourceHive: 'papercusp',
        rerunRecipe: recipe,
      } as never,
    });
    listEvidence.mockResolvedValue([]);

    const result = await call({ harness: 'papercusp', slug: 'plan-a', scorecardId: 'EI-12345' });

    expect(readScorecard).toHaveBeenCalledWith('EI-12345');
    expect(result).toMatchObject({
      ok: false,
      error: 'historical_selection_empty',
      count: 0,
      scorecardId: 'EI-12345',
    });
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-test',
      bindingIds: [19999],
      includeRetracted: true,
      auditAsOf: new Date(createdAt),
    }));
    expect(listAcceptanceRubrics).not.toHaveBeenCalled();
  });

  it('requires one criterion for full historical scorecard detail before reading the scorecard', async () => {
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      scorecardId: 'EI-12345',
      detail: 'full',
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'historical_detail_requires_single_criterion',
      count: 0,
      scorecardId: 'EI-12345',
    });
    expect(readScorecard).not.toHaveBeenCalled();
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('projects byte-exact evidence for one criterion from a 24-binding historical scorecard replay', async () => {
    const createdAt = '2026-10-12T07:19:17.178Z';
    const bindingIds = Array.from({ length: 24 }, (_, index) => 19999 + index);
    const evidenceRefs = Array.from({ length: 24 }, (_, index) => 'test-run ' + (20455199 + index));
    const historicalBindings: EvidenceRow[] = bindingIds.map((id, index) => ({
      id,
      workItemId: 'WI-' + (10005377 + index),
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      coverageEvidenceRef: null,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      bindingFingerprint: 'sha256:binding-' + id,
      createdBy: 'su-test',
      specRevision: 1,
      currentRevision: 2,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: evidenceRefs[index]!,
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: 'sha256:test-' + id,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      details: {},
      testRunId: 20455199 + index,
      observedAt: '2026-10-01T23:00:00.000Z',
      createdAt: '2026-10-01T23:00:00.000Z',
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        comparisonSupplied: true,
        dimensions: {
          spec: 'current',
          source: 'current',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: [],
        unknownReasons: [],
      },
    }));
    const selectionEvidence: SpecTestAdequacyRerunRecipe['selection']['evidence'] =
      historicalBindings.map(({ evidenceKind, evidenceRef }) => ({ evidenceKind, evidenceRef }));
    const recipe: SpecTestAdequacyRerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        evidenceRefs,
        bindingIds,
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        includeDraft: true,
      },
      selection: {
        planSlug: 'plan-a',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        bindingIds,
        evidence: selectionEvidence,
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    readScorecard.mockResolvedValue({
      kind: 'found',
      scorecard: {
        issueId: 'EI-12345',
        createdAt,
        rubricRef: 'spec-test-adequacy',
        sourceHive: 'papercusp',
        rerunRecipe: recipe,
      } as never,
    });
    listEvidence.mockResolvedValue(historicalBindings);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      scorecardId: 'EI-12345',
      detail: 'full',
      criteria: ['traceability'],
    });
    const replayedEvidence = historicalBindings.map((row) => ({
      ...row,
      currentness: {
        ...row.currentness,
        overall: 'unknown' as const,
        provenance: 'replayed-snapshot' as const,
        staleReasons: [],
        unknownReasons: [...new Set([...row.currentness.unknownReasons, 'historical-audit-only'])],
      },
    }));
    const expected = evaluateSpecTestAdequacy({
      clause: clause('active'),
      evidence: replayedEvidence,
      classRef: 'plan-class-feature-ship',
      harness: 'papercusp',
      rerunSelection: { evidenceRefs, bindingIds },
      now: new Date(createdAt),
    });

    expect(result).toMatchObject({ ok: true, scorecardId: 'EI-12345' });
    expect(result.historicalAuditOnly.bindings).toHaveLength(24);
    expect(result.historicalAuditOnly.bindings[23].evidenceRef).toBe(evidenceRefs[23]);
    expect(Object.keys(result.rows[0].ratings)).toEqual(['traceability']);
    expect(result.rows[0].ratings.traceability.evidence).toBe(expected.ratings.traceability.evidence);
    expect(result.rows[0].ratings.traceability.evidence).toContain(evidenceRefs[0]);
    expect(result.rows[0].scorecardDraftOmitted).toContain('criteria filter');
    expect(result.rows[0]).not.toHaveProperty('scorecardDraft');
  });

  it('rejects a scorecard replay when the caller supplies a different plan slug', async () => {
    const recipe: SpecTestAdequacyRerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'plan-class-feature-ship',
      args: {
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        evidenceRefs: ['test-run 20455199'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        includeDraft: true,
      },
      selection: {
        planSlug: 'plan-a',
        specId: 'SPEC-001',
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test-run 20455199' }],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    readScorecard.mockResolvedValue({
      kind: 'found',
      scorecard: {
        issueId: 'EI-12345',
        createdAt: '2026-10-12T07:19:17.178Z',
        rubricRef: 'spec-test-adequacy',
        sourceHive: 'papercusp',
        rerunRecipe: recipe,
      } as never,
    });

    const result = await call({ harness: 'papercusp', slug: 'plan-b', scorecardId: 'EI-12345' });

    expect(result).toMatchObject({ ok: false, error: 'scorecard_selector_mismatch', count: 0 });
    expect(listEvidence).not.toHaveBeenCalled();
  });

  it('preserves every criterion rating through a trimmed MCP dispatch', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const args = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    };
    const direct = await call(args);
    const expectedKeys = Object.keys(direct.rows[0].ratings);
    expect(expectedKeys).toHaveLength(9);

    const projected = lookupByMcpName('plans:evaluate-spec-test-adequacy');
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'plans:evaluate-spec-test-adequacy',
      args,
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ rows: Array<{ ratings: Record<string, unknown> }> }>(dispatched.result!);
    if (!payload) throw new Error('evaluator dispatch should return JSON');
    expect(Object.keys(payload.rows[0].ratings)).toEqual(expectedKeys);
    expect(payload.rows[0].ratings).not.toHaveProperty('_partial');
  });

  it('refuses an explicit selection that matches only draft clauses', async () => {
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      count: 0,
      selectedEvidenceCount: 1,
      matchedClauseCount: 1,
      eligibleClauseCount: 0,
      excludedClauses: [{ specId: 'SPEC-001', revision: 1, lifecycleStatus: 'draft' }],
    });
  });

  it('evaluates draft clauses only when the caller explicitly opts in', async () => {
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows).toHaveLength(1);
  });

  it('marks draft clauses excluded from successful reads, including an empty exclusion', async () => {
    listClauses.mockResolvedValue([
      clause('active'),
      { ...clause('draft'), specId: 'SPEC-DRAFT', planItemId: 'P-002' } as never,
    ]);

    const base = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    };
    const mixed = await call(base);

    expect(mixed).toMatchObject({
      ok: true,
      count: 1,
      includeDraft: false,
      excludedDraftCount: 1,
      excludedDraftSpecIds: ['SPEC-DRAFT'],
      excludedClauses: [{ specId: 'SPEC-DRAFT', revision: 1, lifecycleStatus: 'draft' }],
    });

    listClauses.mockResolvedValue([clause('active')]);
    const none = await call(base);

    expect(none).toMatchObject({
      ok: true,
      includeDraft: false,
      excludedDraftCount: 0,
      excludedDraftSpecIds: [],
      excludedClauses: [],
    });

    listClauses.mockResolvedValue([
      clause('active'),
      { ...clause('draft'), specId: 'SPEC-DRAFT', planItemId: 'P-002' } as never,
    ]);
    const included = await call({ ...base, includeDraft: true });

    expect(included).toMatchObject({
      ok: true,
      count: 2,
      includeDraft: true,
      excludedDraftCount: 0,
      excludedDraftSpecIds: [],
      excludedClauses: [],
    });
  });

  it('echoes the live evaluator build and reports drift for a pinned older replay', async () => {
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      evaluatorBuild: { sha: 'repaired-evaluator-sha', version: '1.2.2' },
    });

    expect(result).toMatchObject({
      ok: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
      evaluatorBuildDrift: {
        recorded: { sha: 'repaired-evaluator-sha', version: '1.2.2' },
        live: { sha: 'live-evaluator-sha', version: '1.2.3' },
      },
    });
  });

  it('does not report evaluator drift when the replay pin matches the live build', async () => {
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
    });

    expect(result).toMatchObject({
      ok: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
    });
    expect(result).not.toHaveProperty('evaluatorBuildDrift');
  });

  it('fails disclosed-gap when a current measured operational artifact has structured disclosures', async () => {
    harnessRoot.path = await mkdtemp(path.join(tmpdir(), 'spec-adequacy-artifact-'));
    const evidenceRef = 'docs/evidence/current-operational.json';
    const evidencePath = path.join(harnessRoot.path, evidenceRef);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({
      kind: 'operational-test-evidence',
      disclosures: ['The live push was not executed in-process.'],
      couldNotDetermine: ['A live in-place restore was not executed.'],
    }));
    const currentness = {
      overall: 'current',
      provenance: 'server-measured',
      comparisonSupplied: true,
      dimensions: { spec: 'current', source: 'current', test: 'not-applicable' },
      staleReasons: [],
      unknownReasons: [],
    };
    listEvidence.mockResolvedValue([{
      id: 27065,
      workItemId: 'WI-10006070',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'operational',
      evidenceRef,
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: null,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: 20846684,
      testRunProvenance: null,
      details: {
        currentMeasurement: {
          schemaVersion: 1,
          kind: 'repo-files',
          sourcePaths: [evidenceRef],
        },
        adequacy: {
          outcome: 'passed',
          skipped: false,
          executed: true,
          targeted: 'spec-001',
          collected: true,
          testLayer: 'operational',
          pathReachable: true,
          oracleIndependent: true,
        },
      },
      serverMeasurement: { status: 'measured', current: {} },
      currentness,
    } as never]);
    try {
      const result = await call({
        harness: 'papercusp',
        slug: 'plan-a',
        classRef: 'plan-class-feature-ship',
        specIds: ['SPEC-001'],
        includeDraft: true,
        detail: 'full',
      });

      expect(result.rows[0].ratings['disclosed-gap']).toMatchObject({
        rating: 'fail',
        evidence: expect.stringContaining('The live push was not executed in-process.'),
      });
      expect(result.rows[0].ratings['disclosed-gap'].evidence).toContain('A live in-place restore was not executed.');
      expect(result.rows[0].wouldBlock).toContain('disclosed-gap');
      expect(result.rows[0].verdict).toBe('fail');
    } finally {
      await rm(harnessRoot.path, { recursive: true, force: true });
      harnessRoot.path = '';
    }
  });

  // review-system-rework-reduction-2026-09-23 P-007, clause RSR-P-007-A: a verdict table
  // plus a ref by default; the full body only on request. Falsifier: the default response
  // carries the full body, or omits the ref to it.
  it('returns a per-clause verdict table plus a fullBody ref by default, and the full body only with detail:"full"', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const base = { harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship', specIds: ['SPEC-001'] };

    const summary = await call(base);
    const full = await call({ ...base, detail: 'full' });

    // Default: the table, and the exact re-call that returns the rest.
    expect(summary).toMatchObject({ ok: true, detail: 'summary' });
    expect(summary.fullBody).toMatchObject({
      tool: 'plans:evaluate-spec-test-adequacy',
      args: { ...base, detail: 'full' },
      omitted: expect.arrayContaining(['rows[].scorecardDraft', 'rows[].ratings[].evidence']),
    });
    const [compact] = summary.rows;
    expect(compact).not.toHaveProperty('scorecardDraft');
    expect(compact).not.toHaveProperty('evidenceRefs');
    for (const [criterion, entry] of Object.entries(compact.ratings) as Array<[string, Record<string, unknown>]>) {
      if (entry.rating === 'pass' || entry.rating === 'not-applicable') {
        expect(entry).not.toHaveProperty('evidence');
      } else {
        const compactEvidence = entry.evidence as string;
        const fullEvidence = full.rows[0].ratings[criterion].evidence as string;
        expect(fullEvidence).toEqual(expect.any(String));
        if (entry.evidenceTruncated === true) {
          expect(compactEvidence.length).toBeLessThanOrEqual(1200);
          const bindingMarker = ' Bound evidence: ';
          const bindingAt = compactEvidence.indexOf(bindingMarker);
          const statement = bindingAt < 0 ? compactEvidence : compactEvidence.slice(0, bindingAt);
          const omissionMarker = ' …[middle omitted]… ';
          const omittedAt = statement.indexOf(omissionMarker);
          if (omittedAt >= 0) {
            expect(fullEvidence.startsWith(statement.slice(0, omittedAt))).toBe(true);
            expect(fullEvidence).toContain(statement.slice(omittedAt + omissionMarker.length));
          } else {
            expect(fullEvidence.startsWith(statement)).toBe(true);
          }
          if (bindingAt >= 0) {
            const bindingExcerpt = compactEvidence.slice(bindingAt + bindingMarker.length).replace(/…$/, '');
            expect(fullEvidence).toContain(bindingMarker + bindingExcerpt);
          }
        } else {
          expect(fullEvidence.startsWith(compactEvidence)).toBe(true);
        }
      }
    }

    // Full: the draft and any exact evidence pointers; transformed diagnostic text stays inline.
    expect(full).toMatchObject({ ok: true, detail: 'full' });
    expect(full).not.toHaveProperty('fullBody');
    expect(full.rows[0].scorecardDraft).toBeTruthy();
    // P-006 (WI-6554700010009314): point at the emit-ready draft only when it contains the
    // exact row text. The draft compacts shared binding descriptions and the replay probe, so
    // full evaluator evidence stays inline whenever replacing it would lose diagnostic detail.
    for (const [criterion, entry] of Object.entries(full.rows[0].ratings) as Array<[string, Record<string, unknown>]>) {
      const draftEvidence = full.rows[0].scorecardDraft.ratings[criterion].evidence as string;
      expect(draftEvidence).toEqual(expect.any(String));
      expect(draftEvidence.length).toBeGreaterThan(0);
      if (typeof entry.evidence === 'string') {
        expect(entry).not.toHaveProperty('evidenceAt');
        expect(entry.evidence).toContain('Replay the shared scorecard rerunRecipe');
        expect(draftEvidence).toContain('Replay result:');
      } else {
        expect(entry).not.toHaveProperty('evidence');
        expect(entry.evidenceAt).toBe(`scorecardDraft.ratings['${criterion}'].evidence`);
      }
    }

    // Same verdicts either way — the summary drops prose, never a rating the replay gates read.
    expect(compact).toMatchObject({
      specId: full.rows[0].specId,
      specRevision: full.rows[0].specRevision,
      specFingerprint: full.rows[0].specFingerprint,
      verdict: full.rows[0].verdict,
      wouldBlock: full.rows[0].wouldBlock,
    });
    for (const [criterion, entry] of Object.entries(full.rows[0].ratings) as Array<[string, { rating: string }]>) {
      expect(compact.ratings[criterion].rating).toBe(entry.rating);
    }

    // And it is smaller. P-006 (WI-6554700010009314): the full body carries each criterion's
    // evidence text exactly once, in the draft. Before the dedupe every string appeared twice
    // (rows[].ratings and scorecardDraft.ratings) and summary < full/2 held only because of
    // that copy. Falsifier: any evidence string occurs more often than the draft carries it.
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length);
    const fullJson = JSON.stringify(full);
    const drafted = (Object.values(full.rows[0].scorecardDraft.ratings) as Array<{ evidence: string }>).map((r) => r.evidence);
    for (const evidence of new Set(drafted)) {
      const needle = JSON.stringify(evidence);
      expect(fullJson.split(needle).length - 1).toBe(drafted.filter((e) => e === evidence).length);
    }
  });

  // oversized-tool-results-reduction-2026-10-12 P-006: following the summary to learn WHY a
  // clause fails must not re-fetch every passing criterion and the draft. Falsifier: the
  // summary offers no narrowed re-call, the narrowed read still carries passing criteria or
  // the draft, or narrowing changes a verdict, wouldBlock or the counts.
  it('offers nonPassingDetail from the summary; criteria narrows returned ratings without changing any verdict', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const base = { harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship', specIds: ['SPEC-001'] };

    const summary = await call(base);
    const full = await call({ ...base, detail: 'full' });
    const nonPassing = (Object.entries(full.rows[0].ratings) as Array<[string, { rating: string }]>)
      .filter(([, entry]) => entry.rating !== 'pass' && entry.rating !== 'not-applicable')
      .map(([criterion]) => criterion);
    expect(nonPassing.length).toBeGreaterThan(0);

    expect(summary.nonPassingDetail).toMatchObject({
      tool: 'plans:evaluate-spec-test-adequacy',
      args: { ...base, criteria: nonPassing, detail: 'full' },
    });
    expect(full).not.toHaveProperty('nonPassingDetail');

    const narrowed = await call(tool.args.parse(summary.nonPassingDetail.args));
    expect(Object.keys(narrowed.rows[0].ratings).sort()).toEqual([...nonPassing].sort());
    for (const criterion of nonPassing) {
      const fullEntry = full.rows[0].ratings[criterion];
      expect(fullEntry.evidence).toEqual(expect.any(String));
      expect(narrowed.rows[0].ratings[criterion]).toEqual(fullEntry);
    }
    expect(narrowed.rows[0]).not.toHaveProperty('scorecardDraft');
    expect(narrowed.rows[0].scorecardDraftOmitted).toEqual(expect.any(String));
    // Narrowing is output-only: every verdict is still computed over all criteria.
    expect(narrowed.rows[0]).toMatchObject({ verdict: full.rows[0].verdict, wouldBlock: full.rows[0].wouldBlock });
    expect(narrowed.verdicts).toEqual(full.verdicts);
    expect(narrowed.wouldBlock).toEqual(full.wouldBlock);
    expect(JSON.stringify(narrowed).length).toBeLessThan(JSON.stringify(full).length);

    // A summary narrowed to one criterion keeps only that rating, same verdict.
    const one = await call({ ...base, criteria: [nonPassing[0]] });
    expect(Object.keys(one.rows[0].ratings)).toEqual([nonPassing[0]]);
    expect(one.rows[0].verdict).toBe(full.rows[0].verdict);

    expect(tool.args.safeParse({ ...base, criteria: ['not-a-criterion'] }).success).toBe(false);
    expect(tool.args.safeParse({ ...base, criteria: [] }).success).toBe(false);
  });


  it('bounds blocked-criterion explanations and marks incomplete evidence in compact replay', async () => {
    const staleLiveBinding = {
      id: 37231,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      specRevision: 1,
      currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'manual' as const,
      evidenceRef: 'manual:live-observation',
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: null,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: 'sha256:old-environment',
      },
      coverageEvidenceRef: null,
      testRunId: null,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      details: { evidencePlane: 'live' },
      observedAt: '2026-10-01T12:00:00Z',
      bindingFingerprint: 'sha256:binding',
      createdBy: 'su-test',
      createdAt: '2026-10-01T12:00:00Z',
      currentness: {
        comparisonSupplied: true,
        provenance: 'server-measured' as const,
        overall: 'stale' as const,
        dimensions: {
          spec: 'current' as const,
          source: 'current' as const,
          test: 'not-applicable' as const,
          fixture: 'not-applicable' as const,
          rubric: 'not-applicable' as const,
          environment: 'stale' as const,
          coverageEvidence: 'not-applicable' as const,
          testRun: 'not-applicable' as const,
        },
        staleReasons: ['environment-stale'],
        unknownReasons: [],
      },
    };
    listClauses.mockResolvedValue([{
      ...clause('active'),
      requiredEvidence: ['live'],
      requiredTestLayers: ['unmeasured-layer-'.repeat(200)],
    }]);
    listEvidence.mockResolvedValue([staleLiveBinding]);
    const base = { harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship', specIds: ['SPEC-001'] };
    const summary = await call(base);
    const full = await call({ ...base, detail: 'full' });
    const explanation = summary.rows[0].ratings['correct-layer'];

    expect(explanation.rating).toBe('fail');
    expect(explanation.evidence).toContain('Required layer');
    expect(explanation.evidence.length).toBeLessThanOrEqual(1200);
    expect(explanation.evidenceTruncated).toBe(true);
    expect(explanation.evidence).toContain('Required evidence plane(s) are absent from current bindings');
    expect(explanation.evidence).toContain('evidencePlane="live"');
    expect(explanation.evidence).toContain('id=37231');
    expect(summary.rows[0].draggingBindingIds['correct-layer']).toContain(37231);
    expect(full.rows[0].ratings['correct-layer'].evidence.length).toBeGreaterThan(1200);
    expect(summary.rows[0].wouldBlock).toEqual(full.rows[0].wouldBlock);
  });

  it('preserves exact work-item, evidence-ref, and plan-item selectors in the emitted rerun recipe', async () => {
    const evidenceRefs = ['testing:run:current#packages/operator-core/lib/reconnect.test.ts'];
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'],
      evidenceRefs,
      planItemIds: ['P-001'],
      includeDraft: true,
      detail: 'full',
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows[0].scorecardDraft.rerunRecipe.args).toMatchObject({
      workItemIds: ['WI-123'],
      evidenceRefs,
      planItemIds: ['P-001'],
    });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ workItemIds: ['WI-123'], evidenceRefs }),
    );
    expect(listClauses).toHaveBeenCalledWith(expect.objectContaining({ planItemIds: ['P-001'] }));
  });

  it('grades selected plan-item clauses despite more unrelated evidence than the read limit', async () => {
    const selected = [clause('active'), { ...clause('active'), specId: 'SPEC-UNCOVERED' }];
    const unrelated = { ...clause('active'), specId: 'SPEC-OTHER', planItemId: 'P-002' };
    listClauses.mockImplementation(async (options) => [...selected, unrelated].filter((row) =>
      (!options.planItemIds || options.planItemIds.includes(row.planItemId)) &&
      (!options.specIds || options.specIds.includes(row.specId)),
    ));
    const pool = [
      ...Array.from({ length: 25 }, (_, index) => ({ id: index + 1, specId: unrelated.specId })),
      { id: 26, specId: selected[0].specId },
    ];
    listEvidence.mockImplementation(async (options) => pool
      .filter((row) => !options.specIds || options.specIds.includes(row.specId))
      .slice(0, options.limit) as EvidenceRow[]);

    const result = await call({
      slug: 'plan-a', classRef: 'plan-class-feature-ship', planItemIds: ['P-001'], limit: 20,
    });

    expect(result).toMatchObject({ ok: true, governing: true, count: 2 });
    expect(result.rows.map((row: { specId: string }) => row.specId)).toEqual(['SPEC-001', 'SPEC-UNCOVERED']);
    // A clause with no bound proof must still be graded and fail, rather than disappear.
    expect(result.rows[1].wouldBlock.length).toBeGreaterThan(0);
  });

  it.each([
    { workItemIds: ['WI-selected'] },
    { evidenceRefs: ['test:selected'] },
    { bindingIds: [26] },
  ])('intersects plan items with an exact binding cohort %j', async (selector) => {
    const selected = clause('active');
    const unrelated = { ...selected, specId: 'SPEC-OTHER', planItemId: 'P-002' };
    listClauses.mockImplementation(async (options) => [selected, unrelated].filter((row) =>
      (!options.planItemIds || options.planItemIds.includes(row.planItemId)) &&
      (!options.specIds || options.specIds.includes(row.specId)),
    ));
    const pool = [
      ...Array.from({ length: 25 }, (_, index) => ({
        id: index + 1, specId: unrelated.specId, workItemId: 'WI-selected', evidenceRef: 'test:selected',
      })),
      { id: 26, specId: selected.specId, workItemId: 'WI-selected', evidenceRef: 'test:selected' },
      { id: 27, specId: selected.specId, workItemId: 'WI-other', evidenceRef: 'test:other' },
    ];
    listEvidence.mockImplementation(async (options) => pool.filter((row) =>
      (!options.specIds || options.specIds.includes(row.specId)) &&
      (!options.workItemIds || options.workItemIds.includes(row.workItemId)) &&
      (!options.evidenceRefs || options.evidenceRefs.includes(row.evidenceRef)) &&
      (!options.bindingIds || options.bindingIds.includes(row.id)),
    ).slice(0, options.limit) as EvidenceRow[]);

    const result = await call({
      slug: 'plan-a', classRef: 'plan-class-feature-ship', planItemIds: ['P-001'], limit: 20, ...selector,
    });

    expect(result).toMatchObject({ ok: true, governing: false, count: 1 });
    expect(result.rows[0].specId).toBe(selected.specId);
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ specIds: [selected.specId], ...selector }));
  });

  it('fails closed when requested bindingIds resolve to only a current subset', async () => {
    // A retracted or superseded row is filtered from the current evidence read. The
    // surviving row must not be mistaken for the complete pinned cohort.
    listEvidence.mockResolvedValue([{ id: 38382, specId: 'SPEC-001' } as never]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      bindingIds: [38382, 38344],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'binding_selection_incomplete',
      count: 1,
      selectedEvidenceCount: 1,
      requestedBindingIds: [38344, 38382],
      matchedBindingIds: [38382],
      missingBindingIds: [38344],
      selection: { bindingIds: [38382, 38344] },
    });
    expect(result.rows).toBeUndefined();
    expect(listClauses).not.toHaveBeenCalled();
  });

  it.each([1, 29])('replays a %s-binding diagnostic cohort with a larger clause-wide disclosure population', async (selectedCount) => {
    const pool = Array.from({ length: 31 }, (_, index): EvidenceRow => ({
      id: 39000 + index,
      workItemId: index < selectedCount ? 'WI-selected' : 'WI-other',
      planSlug: 'plan-a', specId: 'SPEC-001', sourceValId: null, specRevision: 1, currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test', evidenceRef: `test-run:${39000 + index}`,
      fingerprints: {
        sourceFingerprint: 'sha256:source', testFingerprint: 'sha256:test',
        fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
      },
      coverageEvidenceRef: null, testRunId: 39000 + index, testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      observedAt: '2026-09-07T00:00:00.000Z',
      bindingFingerprint: `sha256:binding-${39000 + index}`,
      createdBy: 'su-test', createdAt: '2026-09-07T00:00:00.000Z',
      testRunExecution: {
        status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        filePath: 'packages/operator-core/lib/reconnect.test.ts',
        testLayer: 'integration', passedCaseTitles: ['SPEC-001 selected test'],
      },
      details: { adequacy: {
        testLayer: 'integration', outcome: 'passed', executed: true, collected: true,
        fixtureCalibrated: true, falsifiable: true, pathReachable: true, oracleIndependent: true,
      } },
      currentness: {
        overall: 'current', provenance: 'server-measured', comparisonSupplied: true,
        dimensions: { spec: 'current', source: 'current', test: 'current',
          fixture: 'current', rubric: 'current', environment: 'current', coverageEvidence: 'current', testRun: 'current' },
        staleReasons: [], unknownReasons: [],
      },
    }));
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockImplementation(async (options) => pool.filter((row) =>
      (!options.workItemIds || options.workItemIds.includes(row.workItemId!)) &&
      (!options.evidenceRefs || options.evidenceRefs.includes(row.evidenceRef)) &&
      (!options.bindingIds || options.bindingIds.includes(row.id!)),
    ).slice(0, options.limit));

    const initial = await call({
      harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'], workItemIds: ['WI-selected'], detail: 'full',
    });
    expect(initial.ok).toBe(true);
    const recipe = initial.rows[0].scorecardDraft.rerunRecipe.args;
    expect(recipe.bindingIds).toEqual(pool.slice(0, selectedCount).map((row) => row.id));

    // Both bounded store reads must fit the persisted recipe. Raising the ceiling
    // must preserve the selected cohort and the universal disclosure check.
    const replay = await call(tool.args.parse(recipe));
    expect(replay.ok).toBe(true);
    expect(listEvidence.mock.calls.at(-2)?.[0]).toMatchObject({
      workItemIds: ['WI-selected'], bindingIds: recipe.bindingIds,
    });
    expect(replay.rows[0].verdict).toBe(initial.rows[0].verdict);
    expect(replay.rows[0].ratings['disclosed-gap'].rating).toBe(initial.rows[0].ratings['disclosed-gap'].rating);
    expect(listEvidence.mock.calls.at(-1)?.[0]).not.toHaveProperty('bindingIds');
  });

  it('checks every active clause binding for disclosed gaps during a pinned diagnostic read', async () => {
    const binding = (id: number, disclosedGap?: string): EvidenceRow => ({
      id,
      workItemId: `WI-${id}`,
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      specRevision: 1,
      currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: `test-run:${id}`,
      fingerprints: {
        sourceFingerprint: 'sha256:source',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: id,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      observedAt: '2026-09-07T00:00:00.000Z',
      bindingFingerprint: `sha256:binding-${id}`,
      createdBy: 'su-test',
      createdAt: '2026-09-07T00:00:00.000Z',
      testRunExecution: {
        status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        filePath: 'packages/operator-core/lib/reconnect.test.ts',
        testLayer: 'integration', passedCaseTitles: ['SPEC-001 selected test'],
      },
      details: {
        adequacy: {
          testLayer: 'integration', outcome: 'passed', executed: true, collected: true,
          fixtureCalibrated: true, falsifiable: true, pathReachable: true, oracleIndependent: true,
          ...(disclosedGap ? { disclosedGap: [disclosedGap] } : {}),
        },
      },
      currentness: {
        overall: 'current', provenance: 'server-measured', comparisonSupplied: true,
        dimensions: {
          spec: 'current', source: 'current', test: 'current', fixture: 'current',
          rubric: 'current', environment: 'current', coverageEvidence: 'current', testRun: 'current',
        },
        staleReasons: [], unknownReasons: [],
      },
    });
    const selected = binding(38382);
    const excluded = binding(38344, 'The unit-only row leaves cancellation coverage unproven.');
    const otherActive = binding(38345);
    const active = [selected, excluded, otherActive];
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockImplementation(async (options) =>
      (options.bindingIds ? [selected] : active).slice(0, options.limit),
    );

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      bindingIds: [38382],
      // Exercise an older persisted replay whose limit equals its selected cohort;
      // the universal disclosure read must still see the whole active population.
      limit: 2,
      detail: 'full',
    });

    expect(result).toMatchObject({ ok: true, governing: false });
    expect(listEvidence).toHaveBeenCalledTimes(2);
    expect(listEvidence.mock.calls[1]?.[0]).toMatchObject({ specIds: ['SPEC-001'] });
    expect(listEvidence.mock.calls[1]?.[0]).not.toHaveProperty('bindingIds');
    expect(listEvidence.mock.calls[1]?.[0].limit).toBeGreaterThan(2);
    expect(result.rows[0].ratings['disclosed-gap']).toMatchObject({ rating: 'fail' });
    expect(result.rows[0].ratings['disclosed-gap'].evidence).toContain('id=38344');
    expect(result.rows[0].ratings['disclosed-gap'].evidence).toContain(
      'The unit-only row leaves cancellation coverage unproven.',
    );
    expect(result.rows[0].draggingBindingIds['disclosed-gap']).toEqual([38344]);
    expect(result.rows[0].scorecardDraft.ratings['disclosed-gap'].evidence).toContain('id=38344');
  });

  it('refuses disjoint plan-item and spec selectors without widening an empty evidence filter', async () => {
    listClauses.mockResolvedValue([]);

    const result = await call({
      slug: 'plan-a', classRef: 'plan-class-feature-ship', planItemIds: ['P-001'], specIds: ['SPEC-OTHER'],
    });

    expect(result).toMatchObject({ ok: false, error: 'selection_empty', count: 0, selectedEvidenceCount: 0 });
    expect(listEvidence).not.toHaveBeenCalled();
    expect(listClauses).toHaveBeenCalledWith(expect.objectContaining({
      planItemIds: ['P-001'], specIds: ['SPEC-OTHER'],
    }));
  });

  it.each([
    { workItemIds: ['WI-selected'] },
    { evidenceRefs: ['test:selected'] },
    { bindingIds: [1] },
  ])('refuses a binding cohort outside the selected plan items with an honest remedy %j', async (selector) => {
    const selected = clause('active');
    const unrelated = { ...selected, specId: 'SPEC-OTHER', planItemId: 'P-002' };
    listClauses.mockImplementation(async (options) => [selected, unrelated].filter((row) =>
      (!options.planItemIds || options.planItemIds.includes(row.planItemId)) &&
      (!options.specIds || options.specIds.includes(row.specId)),
    ));
    // The requested cohort has a real binding, but only on P-002. P-001 also has
    // evidence, from a different cohort. Neither side alone is the requested proof.
    const pool = [
      { id: 1, specId: unrelated.specId, workItemId: 'WI-selected', evidenceRef: 'test:selected' },
      { id: 2, specId: selected.specId, workItemId: 'WI-other', evidenceRef: 'test:other' },
    ];
    listEvidence.mockImplementation(async (options) => pool.filter((row) =>
      (!options.specIds || options.specIds.includes(row.specId)) &&
      (!options.workItemIds || options.workItemIds.includes(row.workItemId)) &&
      (!options.evidenceRefs || options.evidenceRefs.includes(row.evidenceRef)) &&
      (!options.bindingIds || options.bindingIds.includes(row.id)),
    ) as EvidenceRow[]);

    const result = await call({
      slug: 'plan-a', classRef: 'plan-class-feature-ship', planItemIds: ['P-001'], ...selector,
    });

    expect(result).toMatchObject({
      ok: false, error: 'selection_empty', count: 0, selectedEvidenceCount: 0,
      selection: { planItemIds: ['P-001'], ...selector },
    });
    expect(result.rows).toBeUndefined();
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({ specIds: [selected.specId], ...selector }));
    expect(result.remedy).toContain('outside the selected planItemIds');
    expect(result.remedy).toContain('Nothing was graded');
  });

  it('retains the hit-limit refusal when the selected plan item itself has too much evidence', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockImplementation(async (options) => Array.from({ length: options.limit ?? 1000 },
      (_, index) => ({ id: index + 1, specId: 'SPEC-001' })) as EvidenceRow[]);

    const result = await call({
      slug: 'plan-a', classRef: 'plan-class-feature-ship', planItemIds: ['P-001'], limit: 20,
    });

    expect(result).toMatchObject({ ok: false, error: 'evidence_selection_hit_limit', count: 20, limit: 20 });
    expect(result.rows).toBeUndefined();
  });

  it('records exact binding ids in the replay recipe, including repeated evidence refs', async () => {
    const evidenceRef = 'packages/operator-core/lib/reconnect.test.ts#reconnect';
    // A repeated reference can name separate active bindings when their evidence kinds differ.
    const evidence: Awaited<ReturnType<typeof listSpecEvidence>> = [
      { id: 18924, evidenceKind: 'test' as const, evidenceRef },
      { id: 18874, evidenceKind: 'fixture' as const, evidenceRef },
      { id: 18875, evidenceKind: 'coverage-census' as const, evidenceRef },
    ].map((row): Awaited<ReturnType<typeof listSpecEvidence>>[number] => ({
      ...row,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      specRevision: 1,
      currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      fingerprints: {
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: null,
      testRunProvenance: null,
      fixtureAbsenceVerification: undefined,
      details: {},
      observedAt: '2026-10-01T12:00:00Z',
      bindingFingerprint: 'sha256:binding',
      createdBy: 'su-test',
      createdAt: '2026-10-01T12:00:00Z',
      currentness: {
        comparisonSupplied: true,
        provenance: 'server-measured',
        overall: 'current',
        dimensions: {
          spec: 'current',
          source: 'current',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: [],
        unknownReasons: [],
      },
    }));
    listClauses.mockResolvedValue([clause('active')]);
    mockResolvedTyped(listEvidence, evidence);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      detail: 'full',
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows[0].scorecardDraft.rerunRecipe).toMatchObject({
      args: { bindingIds: [18874, 18875, 18924] },
      selection: { bindingIds: [18874, 18875, 18924] },
    });
  });

  // acceptance-machinery-seam-fixes-2026-09-16 P-001 (R-1): the number that misled a careful
  // reader on 2026-09-16 was a pinned-cohort "pass 7/0/0" quoted as if it were the ship
  // verdict, while the unscoped gate said 1/7. The label must ride on the result itself.
  it('labels a pinned evidence cohort (evidenceRefs/workItemIds) as NON-governing and an unscoped read as governing', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);

    const pinnedByRef = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test-run:1:spec-001'],
    });
    expect(pinnedByRef).toMatchObject({ ok: true, governing: false });
    expect(String(pinnedByRef.governingNote)).toMatch(/DIAGNOSTIC READ/);
    expect(String(pinnedByRef.governingNote)).toMatch(/shipReadiness/);

    const pinnedByWorkItem = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'],
    });
    expect(pinnedByWorkItem).toMatchObject({ ok: true, governing: false });

    // specIds / planItemIds narrow WHICH clauses are read, not the evidence cohort of a
    // clause, so they stay governing — the gate grades the same bindings per clause.
    const unscoped = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });
    expect(unscoped).toMatchObject({ ok: true, governing: true });
    expect(unscoped.governingNote).toBeUndefined();
  });

  it('persists non-governing scope and evaluator-build drift on every scorecardDraft criterion', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test-run:1:spec-001'],
      evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      detail: 'full',
    });

    expect(result).toMatchObject({
      ok: true,
      governing: false,
      evaluatorBuildDrift: {
        recorded: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
        live: { sha: 'live-evaluator-sha', version: '1.2.3' },
      },
    });
    const criteria = Object.values(result.rows[0].scorecardDraft.ratings) as Array<{ evidence: string }>;
    expect(criteria).toHaveLength(9);
    for (const criterion of criteria) {
      expect(criterion.evidence).toContain('DIAGNOSTIC READ');
      expect(criterion.evidence).toContain('EVALUATOR BUILD DRIFT');
      expect(criterion.evidence).toContain('recorded-evaluator-sha');
      expect(criterion.evidence).toContain('live-evaluator-sha');
    }
  });

  it('explains that evidenceRefs must be persisted binding refs, not test-run table IDs', async () => {
    listEvidence.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test_runs:20455199'],
      includeDraft: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      selectedEvidenceCount: 0,
      selection: { evidenceRefs: ['test_runs:20455199'] },
      remedy: expect.stringContaining('No current evidence binding matches'),
    });
    expect(result.remedy).toContain('exactly match persisted evidence_ref values returned by plans:get-spec-evidence');
    expect(result.remedy).toContain('test-run table IDs such as test_runs:<id> are not necessarily binding refs');
    expect(result.remedy).toContain('use workItemIds + specIds');
    expect(result.remedy).toContain('absent, retracted, or superseded');
    expect(result.remedy).toContain('pass specIds without a binding selector');
    expect(listClauses).not.toHaveBeenCalled();
  });

  it('accepts the persisted rerunRecipe.current wrapper and normalizes it to current[]', async () => {
    const current = [
      {
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
    ];
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      current: { supplied: true, fingerprints: current },
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ current }),
    );
  });

  it('marks a pinned replay snapshot as replayed-snapshot, never server-measured, when forwarding its current tuple', async () => {
    const current = [
      {
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
    ];

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      replaySnapshot: true,
      includeDraft: true,
      current: { supplied: true, fingerprints: current },
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        current,
        // The replay path performs NO server measurement, so the forwarded tuple is
        // caller-supplied. It must be labelled as a replay, never as server proof.
        currentProvenance: 'replayed-snapshot',
      }),
    );
  });

  it('documents and enforces the immutable clause pins required for replay snapshots', () => {
    const baseArgs = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    };
    const result = tool.args.safeParse({ ...baseArgs, replaySnapshot: true });

    if (result.success) throw new Error('Expected replaySnapshot without immutable pins to be rejected');
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'replaySnapshot requires specRevision and specFingerprint',
    );
    expect(tool.args.shape.replaySnapshot.description).toMatch(
      /requires both specRevision and specFingerprint from the same immutable clause revision/i,
    );
    expect(tool.args.shape.specRevision.description).toMatch(/required when replaySnapshot is true/i);
    expect(tool.args.shape.specFingerprint.description).toMatch(/required when replaySnapshot is true/i);
    expect(tool.description).toContain(
      'When replaySnapshot is true, include both specRevision and specFingerprint',
    );

    expect(tool.args.safeParse(baseArgs).success).toBe(true);
  });

  it.each(['newest-first', 'oldest-first'])('pins the latest logical binding measurement in a replay (%s)', async (order) => {
    listClauses.mockResolvedValue([clause('active')]);
    const binding = (id: number, sourceFingerprint: string) => ({
      id,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
      fingerprints: {
        sourceFingerprint,
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: 42,
      details: { adequacy: { falsifiable: true, testLayer: 'integration', outcome: 'pass', executed: true } },
      createdAt: `2026-09-07T00:0${id}:00.000Z`,
      currentness: { overall: 'current', provenance: 'server-measured', staleReasons: [], unknownReasons: [] },
      serverMeasurement: {
        status: 'measured',
        current: {
          evidenceKind: 'test',
          evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
          sourceFingerprint,
          testFingerprint: 'sha256:test',
        },
      },
    });
    const rows = [
      binding(2, 'sha256:latest-recipe'),
      binding(1, 'sha256:obsolete-recipe'),
      { ...binding(3, 'sha256:other-clause'), specId: 'SPEC-OTHER' },
    ];
    listEvidence.mockResolvedValue(
      (order === 'newest-first' ? rows : [...rows].reverse()) as unknown as Awaited<ReturnType<typeof listSpecEvidence>>,
    );

    const result = await call({
      harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'], specIds: ['SPEC-001'], detail: 'full',
    });
    expect(result.rows[0].ratings.freshness.rating).toBe('pass');
    const recipe = result.rows[0].scorecardDraft.rerunRecipe;
    expect(recipe.current.fingerprints).toHaveLength(1);
    expect(recipe.args.current).toEqual(recipe.current.fingerprints);
    expect(recipe.current.fingerprints[0].sourceFingerprint).toBe('sha256:latest-recipe');
  });

  // Renamed from 'no eligible clauses' (EI-23420771213407749): this mocks ZERO clauses, which
  // is a true statement about an empty set. The clauses-exist-but-none-eligible case it was
  // read as covering is the very false green the next test pins, so keep the pair adjacent.
  it('keeps an unfiltered plan with NO CLAUSES AT ALL as a valid empty read', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    });

    expect(result).toMatchObject({ ok: true, rows: [], count: 0 });
  });

  it('refuses an UNSELECTED read whose clauses all exist but are filtered out (EI-23420771213407749)', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('draft')]);

    // No specIds/workItemIds/evidenceRefs/planItemIds and no includeDraft — the exact call the
    // ship gate's remedy text tells an agent to make first. Before the fix this returned
    // { ok:true, rows:[], count:0, wouldBlock:[] }: a zero-work false green whose empty output
    // is indistinguishable from a clean verdict, landing where it is most trusted.
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      matchedClauseCount: 1,
      eligibleClauseCount: 0,
      excludedClauses: [{ specId: 'SPEC-001', revision: 1, lifecycleStatus: 'draft' }],
    });
    expect(result.remedy).toContain('includeDraft:true');
    expect(result.remedy).toContain('NOT a clean adequacy result');
  });

  it('refuses a work-item selection with no exact evidence edge', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-missing'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      selectedEvidenceCount: 0,
      remedy: expect.stringContaining('No current evidence edge'),
    });
    expect(result.remedy).toContain('proof may have been retracted or superseded');
    expect(listClauses).not.toHaveBeenCalled();
  });
});
