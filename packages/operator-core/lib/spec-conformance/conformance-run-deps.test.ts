import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';

const { sqlCalls, sqlMock, upsertMock } = vi.hoisted(() => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  return {
    sqlCalls: calls,
    sqlMock: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: Array.from(parts).join('?'), values });
      return [];
    }),
    upsertMock: vi.fn(async () => ({ id: 'WI-CONFORMANCE-DRIFT', created: true })),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: sqlMock }) };
});
vi.mock('../coord/condition-upsert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coord/condition-upsert')>();
  return { ...actual, upsertConditionWorkItem: upsertMock };
});

const { getWorkItemMock, linkWorkItemMock } = vi.hoisted(() => ({
  getWorkItemMock: vi.fn(),
  linkWorkItemMock: vi.fn(),
}));
vi.mock('../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../work-items')>();
  return {
    ...actual,
    getWorkItem: getWorkItemMock,
    linkWorkItem: linkWorkItemMock,
    workItemObjectRef: (item: { id: string }) => `feature:papercusp#${item.id}`,
  };
});

import { judgeTestsFromLedger, lifecycleOnlyAdmissionRefusal, productionConformanceDeps } from './conformance-run-deps';
import * as testContent from './conformance-test-content';
import { buildRubricCheckLedgerRow, type RubricCheckResult } from '../check-results-ledger';
import type { RequirementRealizationReader } from '../rubrics-criterion-checks';
import { runPlanConformance } from './conformance-run';
import { evaluateConformanceClosure } from './closure-guard';

describe('requirements checks through conformance and discharge closure', () => {
  const planContent = `---
slug: realization-fixture
status: active
---
## Requirements
**R-1 — Realized implementation.**
\`\`\`requirement
${JSON.stringify({
  intent: { request: 'Implement the promised behavior.', sourceRefs: ['P-001'] },
  acceptance: { condition: 'Implementation is verified.', falsifier: 'The implementation lacks evidence.' },
  verification: { method: 'Join activation and completion evidence.', check: { kind: 'requirements' } },
})}
\`\`\`
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
## Build
- **P-001** \`wip\` Implement the behavior
`;

  function realization(options: { verified?: boolean; empty?: boolean; nonCode?: boolean } = {}): RequirementRealizationReader {
    return async () => ({
      planSlug: 'realization-fixture',
      mappings: options.empty ? [] : [{ id: 'M-001', sourceRefs: ['owner directive #1'],
        requirement: 'Implement the promised behavior.', planTargets: ['P-001'], disposition: 'covered' }],
      itemAudits: options.verified === false ? [] : [{ auditSeq: 1, entry: { itemId: 'P-001',
        verdict: options.nonCode ? 'not-code' : 'implemented', note: 'Verified outcome.',
        citations: options.nonCode ? [{ kind: 'doc', ref: 'guide', reason: 'Described outcome.' }]
          : [{ kind: 'code', path: 'packages/operator-core/lib/spec-conformance/conformance-run-deps.ts', line: 1 }] } }],
      planItems: [{ itemId: 'P-001', status: 'wip', itemText: 'Implement the behavior' }],
      nonCodeItemProofs: options.nonCode ? [{ planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] }] : [],
    });
  }

  it.each([
    ['verified code before the item closes', {}, 'pass'],
    ['missing implementation audit', { verified: false }, 'fail'],
    ['empty activation population', { empty: true }, 'error'],
    ['unfinished non-code work with a claimed proof', { nonCode: true }, 'fail'],
  ] as const)('records %s and preserves the discharge gate', async (_label, options, verdict) => {
    const input = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'realization-fixture',
      readRequirementRealization: realization(options) };
    const runtime = productionConformanceDeps(input);
    const recorded: RubricCheckResult[] = [];
    const run = await runPlanConformance({ ...input, planContent }, {
      ...runtime,
      readLatestVerdicts: async () => new Map(), listOpenDriftAlarms: async () => [],
      approvedDeviations: async () => new Set(),
      recordResults: async results => {
        recorded.push(...results);
        results.forEach(result => buildRubricCheckLedgerRow(result, {
          workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        }));
        return results.map((_, index) => index + 1);
      },
    });
    expect(run.unevaluable).toEqual([]);
    expect(recorded).toMatchObject([{ verdict, check: { kind: 'requirements', id: 'R-1:done-when' } }]);
    expect(run.executed).toBe(1);
    expect(run.alarmsOpened).toEqual([]);
    const refusal = await evaluateConformanceClosure({ planContent, planItemIds: ['P-001'],
      completion: { discharges: ['R-1'] } }, {
      listOpenDriftAlarms: async () => [], readDoneWhenVerdict: async () => recorded[0]?.verdict ?? null,
    });
    if (verdict === 'pass') expect(refusal).toBeNull();
    else expect(refusal).toMatchObject({ code: 'conformance_done_when_not_passing', requirements: ['R-1'] });
  });

  it('reports an unreadable subject as an error, never an unevaluable check or pass', async () => {
    const input = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'realization-fixture',
      readRequirementRealization: async () => null };
    expect(await productionConformanceDeps(input).evaluateCheck({ barKey: 'R-1', role: 'done-when',
      checkId: 'R-1:done-when', check: { kind: 'requirements' } }))
      .toMatchObject({ kind: 'requirements', verdict: 'error', value: null });
  });

  it('scopes the production realization reads to the requested workspace and harness', async () => {
    sqlCalls.length = 0;
    sqlMock.mockClear();
    const result = await productionConformanceDeps({ workspaceId: 'realization-workspace',
      harnessSlug: 'realization-harness', planSlug: 'realization-fixture' }).evaluateCheck({
      barKey: 'R-1', role: 'done-when', checkId: 'R-1:done-when', check: { kind: 'requirements' },
    });
    expect(result).toMatchObject({ kind: 'requirements', verdict: 'error', value: null,
      detail: expect.stringContaining('requirements_scope_empty') });
    expect(sqlCalls).toHaveLength(3);
    for (const call of sqlCalls) expect(call.values).toContain('realization-workspace');
    const scoped = sqlCalls.filter(call => call.query.includes('harness_slug ='));
    expect(scoped).toHaveLength(2);
    for (const call of scoped) expect(call.values).toContain('realization-harness');
  });
});

const PLAN = 'cloud-portal-chat-and-guide-recovery-2026-10-09';
const CONDITION = `spec-conformance-drift:papercusp/${PLAN}/R-9`;
const filing = {
  barKey: 'R-9',
  title: 'R-9 drift',
  conditionKey: CONDITION,
  firedFalsifiers: [],
  doneWhenRegressed: true,
  summary: 'Measured R-9 drift.',
};

describe('production conformance drift alarms', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockClear();
    upsertMock.mockReset();
  });

  it('stamps the source plan on a newly filed alarm', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'WI-CONFORMANCE-DRIFT', created: true });

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await deps.openDriftAlarm(filing);

    expect(upsertMock).toHaveBeenCalledWith(CONDITION, expect.objectContaining({ sourcePlanSlug: PLAN }));
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('persists executable check files as the alarm task scope', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'WI-CONFORMANCE-DRIFT', created: true });

    const paths = ['packages/operator-core/lib/spec-conformance/conformance-run.test.ts'];
    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await deps.openDriftAlarm({ ...filing, paths });

    expect(upsertMock).toHaveBeenCalledWith(CONDITION, expect.objectContaining({
      payload: expect.objectContaining({ paths, specConformance: expect.objectContaining({ barKey: 'R-9' }) }),
    }));
  });

  it('repairs the source plan on an adopted alarm', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'WI-CONFORMANCE-DRIFT', created: false });

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await deps.openDriftAlarm(filing);

    expect(upsertMock).toHaveBeenCalledWith(CONDITION, expect.objectContaining({ sourcePlanSlug: PLAN }));
    expect(sqlMock).toHaveBeenCalledOnce();
    expect(sqlCalls[0]?.query).toContain('source_plan_slug = ?');
    expect(sqlCalls[0]?.values).toContain(PLAN);
  });
});

/** The shape `WorkItemDependencyAdmissionError` carries (work-item-deps-store.ts). */
function admissionError(findings: Array<Record<string, unknown>>): Error {
  const message = 'work_item_deps candidate rejected: cannot add unresolved blocker issue:WI-A (status=open) behind active dependant feature:papercusp#WI-B (status=wip, taken_by=su-x)';
  return Object.assign(new Error(message), { code: 'WORK_ITEM_DEPENDENCY_ADMISSION_REJECTED', findings });
}
const NO_GRAPH_DEFECTS = { cycles: [], endpointDefects: [], stranded: [] };
const LIFECYCLE_CONFLICT = { edge: {}, dependant: {}, blocker: {} };

describe('production conformance blocks links', () => {
  beforeEach(() => {
    getWorkItemMock.mockReset();
    linkWorkItemMock.mockReset();
    getWorkItemMock.mockResolvedValue({ id: 'WI-B', kind: 'feature' });
  });

  it('reports a lifecycle-only admission refusal instead of failing the run', async () => {
    const error = admissionError([{ ...NO_GRAPH_DEFECTS, lifecycleConflicts: [LIFECYCLE_CONFLICT] }]);
    linkWorkItemMock.mockRejectedValueOnce(error);

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await expect(deps.linkBlocks('WI-A', 'WI-B')).resolves.toEqual({ linked: false, reason: error.message });
  });

  it('returns linked for an admitted edge', async () => {
    linkWorkItemMock.mockResolvedValueOnce({ ok: true });

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await expect(deps.linkBlocks('WI-A', 'WI-B')).resolves.toEqual({ linked: true });
  });

  it('still throws a graph defect, or any non-admission error, so the run reports it', async () => {
    const cycle = admissionError([{ ...NO_GRAPH_DEFECTS, cycles: [{}], lifecycleConflicts: [LIFECYCLE_CONFLICT] }]);
    linkWorkItemMock.mockRejectedValueOnce(cycle);
    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await expect(deps.linkBlocks('WI-A', 'WI-B')).rejects.toBe(cycle);

    const outage = new Error('connection terminated');
    linkWorkItemMock.mockRejectedValueOnce(outage);
    await expect(deps.linkBlocks('WI-A', 'WI-B')).rejects.toBe(outage);
  });

  it('classifies only all-lifecycle findings as a refusal', () => {
    expect(lifecycleOnlyAdmissionRefusal(admissionError([{ ...NO_GRAPH_DEFECTS, lifecycleConflicts: [LIFECYCLE_CONFLICT] }]))).toMatch(/behind active dependant/);
    expect(lifecycleOnlyAdmissionRefusal(admissionError([]))).toBeNull();
    expect(lifecycleOnlyAdmissionRefusal(admissionError([{ ...NO_GRAPH_DEFECTS }]))).toBeNull();
    expect(lifecycleOnlyAdmissionRefusal(admissionError([{ ...NO_GRAPH_DEFECTS, stranded: [{}], lifecycleConflicts: [LIFECYCLE_CONFLICT] }]))).toBeNull();
    expect(lifecycleOnlyAdmissionRefusal(new Error('plain'))).toBeNull();
    expect(lifecycleOnlyAdmissionRefusal('not an error')).toBeNull();
  });
});

describe('conformance test-run evidence', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockClear();
  });

  const file = 'packages/operator-core/lib/storage/retention-pins.test.ts';
  const finishedAt = new Date('2026-10-22T05:30:51.536Z');
  const testRunRow = (status: 'error' | 'fail' | 'pass') => ({
    id: status === 'error' ? 21720473 : status === 'fail' ? 21720474 : 21720475,
    file_path: file,
    status,
    finished_at: finishedAt,
    commit_sha: status === 'error' ? null : 'a'.repeat(40),
    worktree_dirty: status === 'error',
    execution_details: {
      schemaVersion: 1,
      root: '/repo',
      runGroupId: 'conformance-run',
      workspaceId: 'workspace',
      harnessSlug: 'papercusp',
      mutationPhase: null,
      testLayer: 'unit',
      filePath: file,
      testNamePattern: null,
      worktreeDirty: status === 'error',
      commitSha: status === 'error' ? null : 'a'.repeat(40),
      passed: status === 'error' ? 18 : status === 'fail' ? 17 : 1,
      failed: status === 'error' ? 0 : status === 'fail' ? 1 : 0,
      skipped: 0,
      collectionFailed: false,
    },
  });

  it('keeps a run-level error unevaluable while preserving actual test failures', async () => {
    sqlMock.mockImplementationOnce(async () => [testRunRow('error')] as never[]);
    const error = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      currentBuildSha: 'a'.repeat(40),
      now: () => finishedAt,
    });
    expect(error).toMatchObject({ kind: 'tests', verdict: 'error', value: null, unit: 'files' });
    expect(error.detail).toContain(`${file} (test run status is error, test_runs #21720473)`);

    sqlMock.mockImplementationOnce(async () => [testRunRow('fail')] as never[]);
    const failure = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      currentBuildSha: 'a'.repeat(40),
      now: () => finishedAt,
    });
    expect(failure).toMatchObject({ kind: 'tests', verdict: 'fail', value: 0, unit: 'files' });
  });

  it('rejects a clean pass recorded on an older build as current evidence', async () => {
    sqlMock.mockImplementationOnce(async () => [testRunRow('pass')] as never[]);
    const contentEquivalence = vi.fn(async () => ({ equivalent: false, reason: 'different dependency closure' }));

    const result = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      currentBuildSha: 'b'.repeat(40),
      now: () => finishedAt,
      contentEquivalence,
    });

    expect(result).toMatchObject({ kind: 'tests', verdict: 'error', value: null, unit: 'files' });
    expect(result.detail).toContain(`test-run commit ${'a'.repeat(40)} does not match current build ${'b'.repeat(40)}`);
    expect(result.detail).toContain('test_runs #21720475');
    expect(contentEquivalence).toHaveBeenCalledExactlyOnceWith({ file, recordedSha: 'a'.repeat(40), currentSha: 'b'.repeat(40) });
  });

  it('rejects named-case evidence recorded on a different build before loading case outcomes', async () => {
    sqlMock.mockImplementationOnce(async () => [testRunRow('pass')] as never[]);
    const caseLoader = vi.fn(async () => []);
    const contentEquivalence = vi.fn(async () => ({ equivalent: false, reason: 'different dependency closure' }));

    const result = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      cases: [{ file, testName: 'case one' }],
      currentBuildSha: 'b'.repeat(40),
      now: () => finishedAt,
      caseLoader,
      contentEquivalence,
    });

    expect(result).toMatchObject({ kind: 'tests', verdict: 'error', value: null, unit: 'cases' });
    expect(result.detail).toContain('does not match current build');
    expect(caseLoader).not.toHaveBeenCalled();
    expect(contentEquivalence).toHaveBeenCalledExactlyOnceWith({ file, recordedSha: 'a'.repeat(40), currentSha: 'b'.repeat(40) });
  });

  it('selects a newer dependency-equivalent receipt ahead of an older unpinned error', async () => {
    const pass = testRunRow('pass');
    pass.execution_details = { ...pass.execution_details, testLayer: 'unit' } as typeof pass.execution_details;
    const error = { ...testRunRow('error'), finished_at: new Date(finishedAt.getTime() - 1000) };
    sqlMock.mockImplementationOnce(async () => [error, pass] as never[]);
    const contentEquivalence = vi.fn(async () => ({ equivalent: true, reason: 'same dependency closure' }));
    expect(await judgeTestsFromLedger({ files: [file], workspaceId: 'workspace', currentBuildSha: 'b'.repeat(40),
      now: () => finishedAt, contentEquivalence })).toMatchObject({ verdict: 'pass', value: 1 });
    expect(contentEquivalence).toHaveBeenCalledWith({ file, recordedSha: 'a'.repeat(40), currentSha: 'b'.repeat(40) });
  });

  it('distinguishes pending ledger and dependency-content reads and retains their settlement', async () => {
    const phases = createPhaseTracker();
    let readRows!: (rows: never[]) => void;
    sqlMock.mockImplementationOnce(() => new Promise<never[]>((resolve) => { readRows = resolve; }));
    let finishProof!: (proof: { equivalent: boolean; reason: string }) => void;
    let proofStarted!: () => void;
    const started = new Promise<void>((resolve) => { proofStarted = resolve; });
    const contentEquivalence = vi.fn(() => {
      proofStarted();
      return new Promise<{ equivalent: boolean; reason: string }>((resolve) => { finishProof = resolve; });
    });
    const pending = judgeTestsFromLedger({ files: [file], workspaceId: 'workspace', phases,
      currentBuildSha: 'b'.repeat(40), now: () => finishedAt, contentEquivalence });
    expect(phases.snapshot().activePhase).toBe('conformance:tests:ledger');
    readRows([testRunRow('pass')] as never[]);
    await started;
    const contentPhase = `conformance:tests:contentEquivalence:21720475:${file}`;
    expect(phases.snapshot().activePhase).toBe(contentPhase);
    finishProof({ equivalent: true, reason: 'same dependency closure' });
    expect(await pending).toMatchObject({ verdict: 'pass', value: 1 });
    expect(phases.snapshot().activePhases).toEqual([]);
    expect(phases.toMetadata()?.phases.map((phase) => phase.phase)).toEqual(['conformance:tests:ledger', contentPhase]);
    expect(contentEquivalence).toHaveBeenCalledTimes(1);
  });

  it('does not inspect historical content after selecting a newer current-build failure', async () => {
    const current = { ...testRunRow('fail'), commit_sha: 'b'.repeat(40) };
    const historical = { ...testRunRow('pass'), finished_at: new Date(finishedAt.getTime() - 1000) };
    sqlMock.mockImplementationOnce(async () => [historical, current] as never[]);
    const contentEquivalence = vi.fn(async () => ({ equivalent: true, reason: 'same' }));
    expect(await judgeTestsFromLedger({ files: [file], workspaceId: 'workspace',
      currentBuildSha: 'b'.repeat(40), now: () => finishedAt, contentEquivalence }))
      .toMatchObject({ verdict: 'fail' });
    expect(contentEquivalence).not.toHaveBeenCalled();
  });

  it('stops at the newest equivalent candidate after rejecting a newer changed closure', async () => {
    const rows = [1, 2, 3].map((id) => ({ ...testRunRow('pass'), id,
      commit_sha: String(id).repeat(40), finished_at: new Date(finishedAt.getTime() - id * 1000),
      execution_details: { ...testRunRow('pass').execution_details, commitSha: String(id).repeat(40) } }));
    sqlMock.mockImplementationOnce(async () => [...rows].reverse() as never[]);
    const contentEquivalence = vi.fn(async ({ recordedSha }: { recordedSha: string }) =>
      ({ equivalent: recordedSha === '2'.repeat(40), reason: 'closure result' }));
    expect(await judgeTestsFromLedger({ files: [file], workspaceId: 'workspace',
      currentBuildSha: 'b'.repeat(40), now: () => finishedAt, contentEquivalence }))
      .toMatchObject({ verdict: 'pass' });
    expect(contentEquivalence.mock.calls.map(([input]) => input.recordedSha)).toEqual(['1'.repeat(40), '2'.repeat(40)]);
  });

  it('retains the newest incompatible diagnostic after all 32 historical candidates differ', async () => {
    const rows = Array.from({ length: 32 }, (_, index) => {
      const sha = (index + 1).toString(16).padStart(40, '0');
      return { ...testRunRow('pass'), id: index + 1, commit_sha: sha,
        finished_at: new Date(finishedAt.getTime() - index * 1000),
        execution_details: { ...testRunRow('pass').execution_details, commitSha: sha } };
    });
    sqlMock.mockImplementationOnce(async () => [...rows].reverse() as never[]);
    const contentEquivalence = vi.fn(async () => ({ equivalent: false, reason: 'changed closure' }));
    const result = await judgeTestsFromLedger({ files: [file], workspaceId: 'workspace',
      currentBuildSha: 'b'.repeat(40), now: () => finishedAt, contentEquivalence });
    expect(result).toMatchObject({ verdict: 'error' });
    expect(result.detail).toContain('test_runs #1; changed closure');
    expect(contentEquivalence).toHaveBeenCalledTimes(32);
  });

  it('shares one immutable content provider across checks, with a separate cache for each run', async () => {
    const compare = vi.fn(async () => ({ equivalent: true, reason: 'same' }));
    const factory = vi.spyOn(testContent, 'createTestContentEquivalence').mockReturnValue(compare);
    try {
      const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
      const request = { barKey: 'R-1', role: 'done-when' as const, checkId: 'R-1:done-when',
        check: { kind: 'tests' as const, files: [file] } };
      await deps.evaluateCheck(request);
      await deps.evaluateCheck(request);
      expect(factory).toHaveBeenCalledTimes(1);
      await productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN })
        .evaluateCheck(request);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      factory.mockRestore();
    }
  });

  it('passes the caller tracker from the production adapter to its test-ledger reader', async () => {
    const phases = createPhaseTracker();
    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN, phases });
    let readRows!: (rows: never[]) => void;
    sqlMock.mockImplementationOnce(() => new Promise<never[]>((resolve) => { readRows = resolve; }));
    const pending = deps.evaluateCheck({ barKey: 'R-1', role: 'done-when', checkId: 'R-1:done-when',
      check: { kind: 'tests', files: [file] } });
    expect(deps.phases).toBe(phases);
    expect(phases.snapshot().activePhase).toBe('conformance:tests:ledger');
    readRows([]);
    expect(await pending).toMatchObject({ verdict: 'error' });
    expect(phases.snapshot().activePhases).toEqual([]);
  });

  it.each(['unpinned error', 'current failure', 'filtered pass', 'dirty pass', 'changed dependencies', 'unknown build'])
    ('preserves the %s guard when considering an equivalent receipt', async guard => {
      const pass = { ...testRunRow('pass'), finished_at: new Date(finishedAt.getTime() - 1000),
        execution_details: { ...testRunRow('pass').execution_details, testLayer: 'unit' } };
      let candidates: unknown[] = [pass];
      if (guard === 'unpinned error') candidates.push(testRunRow('error'));
      if (guard === 'current failure') candidates.push({ ...testRunRow('fail'), commit_sha: 'b'.repeat(40) });
      if (guard === 'filtered pass') pass.execution_details.testNamePattern = 'one case' as never;
      if (guard === 'dirty pass') pass.worktree_dirty = true;
      const contentEquivalence = vi.fn(async () => ({ equivalent: guard !== 'changed dependencies', reason: 'dependency changed' }));
      sqlMock.mockImplementationOnce(async () => candidates as never[]);
      const result = await judgeTestsFromLedger({ files: [file], workspaceId: 'workspace',
        currentBuildSha: guard === 'unknown build' ? null : 'b'.repeat(40), now: () => finishedAt, contentEquivalence });
      expect(result.verdict).toBe(guard === 'current failure' ? 'fail' : 'error');
      if (guard === 'dirty pass' || guard === 'unknown build') expect(contentEquivalence).not.toHaveBeenCalled();
    });
});
