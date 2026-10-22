import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    const result = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      currentBuildSha: 'b'.repeat(40),
      now: () => finishedAt,
    });

    expect(result).toMatchObject({ kind: 'tests', verdict: 'error', value: null, unit: 'files' });
    expect(result.detail).toContain(`test-run commit ${'a'.repeat(40)} does not match current build ${'b'.repeat(40)}`);
    expect(result.detail).toContain('test_runs #21720475');
  });

  it('rejects named-case evidence recorded on a different build before loading case outcomes', async () => {
    sqlMock.mockImplementationOnce(async () => [testRunRow('pass')] as never[]);
    const caseLoader = vi.fn(async () => []);

    const result = await judgeTestsFromLedger({
      files: [file],
      workspaceId: 'workspace',
      cases: [{ file, testName: 'case one' }],
      currentBuildSha: 'b'.repeat(40),
      now: () => finishedAt,
      caseLoader,
    });

    expect(result).toMatchObject({ kind: 'tests', verdict: 'error', value: null, unit: 'cases' });
    expect(result.detail).toContain('does not match current build');
    expect(caseLoader).not.toHaveBeenCalled();
  });
});
