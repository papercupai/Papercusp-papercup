/**
 * Rubric/scorecard read handlers must bind their resolved caller workspace.
 *
 * The stores underneath these handlers intentionally resolve their tenant from
 * activeWorkspaceId(). Transport dispatch normally installs request ALS, but
 * projected-tool handlers also run through in-process/nested dispatch paths.
 * A handler that merely resolves identity and then discards identity.workspaceId
 * can therefore read the process-global workspace and return a confident
 * not-found/empty result for data in the caller's real workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeWorkspaceId } from '../workspace-registry';
import type { Rubric } from '../rubrics';

const h = vi.hoisted(() => ({
  getRubric: vi.fn(),
  getRubricWithoutSeeding: vi.fn(),
  listRubrics: vi.fn(),
  readRubricPlanRevision: vi.fn(),
  listScorecards: vi.fn(),
  listScorecardPage: vi.fn(),
}));

vi.mock('../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rubrics')>();
  return {
    ...actual,
    getRubric: h.getRubric,
    getRubricWithoutSeeding: h.getRubricWithoutSeeding,
    listRubrics: h.listRubrics,
    readRubricPlanRevision: h.readRubricPlanRevision,
  };
});

vi.mock('../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scorecards')>();
  return {
    ...actual,
    listScorecards: h.listScorecards,
    listScorecardPage: h.listScorecardPage,
  };
});

const getRubricTool = (await import('./rubrics/get')).default;
const listRubricsTool = (await import('./rubrics/list')).default;
const evaluateScorecardTool = (await import('./scorecards/evaluate')).default;
const listScorecardsTool = (await import('./scorecards/list')).default;

const CALLER_WORKSPACE = 'caller-workspace';
const GLOBAL_WORKSPACE = 'wrong-global-workspace';
const priorWorkspacePin = process.env.PAPERCUSP_WORKSPACE_ID;

const rubric: Rubric = {
  rubricId: 'scope-test-rubric',
  workspaceId: CALLER_WORKSPACE,
  kind: 'standard',
  gradingAuthority: 'independent',
  characteristic: 'workspace-scope',
  title: 'Scope test',
  description: '',
  criteria: [
    {
      key: 'scope',
      title: 'Scope',
      model: 'Reads the caller workspace.',
      method: 'Inspect the resolved workspace.',
      driftMarkers: 'Reads the process-global workspace.',
    },
  ],
  ratingScale: ['pass', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-test',
  proposedBy: 'su-test',
  ratifiedBy: 'reviewer-test',
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
};

const ctx = {
  isSuperuser: true,
  uiClientId: 'su-caller-workspace-test',
  workspaceId: CALLER_WORKSPACE,
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAPERCUSP_WORKSPACE_ID = GLOBAL_WORKSPACE;
  h.readRubricPlanRevision.mockResolvedValue({ ok: true, revision: null });
  h.listScorecardPage.mockResolvedValue({ rows: [], hasMore: false });
});

afterEach(() => {
  if (priorWorkspacePin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspacePin;
});

describe('rubric/scorecard caller workspace binding (EI-22577140653575153)', () => {
  it('pins identity.workspaceId around every ambient store read', async () => {
    const observed: Array<{ store: string; workspaceId: string }> = [];
    h.getRubric.mockImplementation(async () => {
      observed.push({ store: 'getRubric', workspaceId: activeWorkspaceId() });
      return rubric;
    });
    h.listRubrics.mockImplementation(async () => {
      observed.push({ store: 'listRubrics', workspaceId: activeWorkspaceId() });
      return [rubric];
    });
    h.getRubricWithoutSeeding.mockImplementation(async () => {
      observed.push({ store: 'getRubricWithoutSeeding', workspaceId: activeWorkspaceId() });
      return rubric;
    });
    h.listScorecards.mockImplementation(async () => {
      observed.push({ store: 'listScorecards', workspaceId: activeWorkspaceId() });
      return [];
    });
    h.listScorecardPage.mockImplementation(async () => {
      observed.push({ store: 'listScorecardPage', workspaceId: activeWorkspaceId() });
      return { rows: [], hasMore: false };
    });

    await getRubricTool.handler({ rubricRef: rubric.rubricId } as never, ctx as never);
    await listRubricsTool.handler({} as never, ctx as never);
    const evaluated = await evaluateScorecardTool.handler({ rubricRef: rubric.rubricId } as never, ctx as never);
    expect(evaluated).toMatchObject({ data: { ok: true } });
    await listScorecardsTool.handler({} as never, ctx as never);

    expect(observed).toEqual([
      { store: 'getRubric', workspaceId: CALLER_WORKSPACE },
      { store: 'listRubrics', workspaceId: CALLER_WORKSPACE },
      { store: 'getRubricWithoutSeeding', workspaceId: CALLER_WORKSPACE },
      { store: 'listScorecards', workspaceId: CALLER_WORKSPACE },
      { store: 'listScorecardPage', workspaceId: CALLER_WORKSPACE },
    ]);
  });
});
