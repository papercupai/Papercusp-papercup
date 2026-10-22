/**
 * set-status.execution-record-disclosure.test.ts — EI-22427741014249929.
 *
 * The wip flip's auto-convert result was DISCARDED (`await convertPlanItem(...)
 * .catch(warn)`), so when it transferred the linked work-item off another agent
 * the response mentioned no work-item at all: `claim:{ claimId, autoClaimed:true }`
 * reads as "I claimed the PLAN ITEM", and the execution-record handover was
 * invisible to the caller. These pin the disclosure now carried on the result.
 *
 * Sibling of set-status.residual-warning.test.ts — same lock-mocking harness, but
 * this one supplies a real agent identity so the wip claim/auto-convert leg
 * actually runs (that path is skipped entirely when no identity resolves).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.execution-record-disclosure.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import { mockRejectedTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { convertPlanItem as ConvertPlanItemFn } from '../../plan-items/convert';
import type { claimForWork as ClaimForWorkFn } from '../../plan-items/claim-discipline';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

const convertMocks = vi.hoisted(() => ({
  convertPlanItem: vi.fn(),
  findCoverageWorkItems: vi.fn(async () => [] as Array<{ id: string; state: string }>),
}));
const claimMocks = vi.hoisted(() => ({
  claimForWork: vi.fn(async () => ({ ok: true, claimId: 'claim-1', alreadyHeld: false })),
  releaseOwnClaim: vi.fn(async () => null),
}));
const reconcileMocks = vi.hoisted(() => ({
  resyncDependentPlanItemLanesNow: vi.fn(async () => []),
  resyncPlanItemLaneNow: vi.fn(async () => null),
}));
const planDrainMocks = vi.hoisted(() => ({
  planDrainTransitionMutationGated: vi.fn(async () => ({ newBody: null, value: { applied: false, to: null } })),
}));

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
// WI-10008137: the draft-plan item-start gate has its own suite (draft-item-start-gate.test.ts).
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('./plan-drain-transition', () => ({
  planDrainTransitionMutationGated: planDrainMocks.planDrainTransitionMutationGated,
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// A REAL identity — unlike the residual-warning sibling, this suite needs the wip
// claim + auto-convert leg to execute.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-caller', ownerLabel: 'su · caller', workspaceId: 'default' }),
  isEphemeralMcpCallIdentity: () => false,
}));
vi.mock('./with-plan-lock', () => ({ withPlanLock: vi.fn(), bumpUpdatedDate: (s: string) => s }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  resolveAdoptedName: vi.fn(async () => null),
  bestEffortOwnerUser: () => 'tester',
  listSessionsForAgentName: vi.fn(async () => []),
}));
// The auto-convert leg is flag-gated; force it ON so the disclosure path runs.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));
vi.mock('../../plan-items/claim-discipline', () => ({
  claimForWork: claimMocks.claimForWork,
  releaseOwnClaim: claimMocks.releaseOwnClaim,
}));
vi.mock('../../plan-items/claims', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/claims')>()),
  getClaim: vi.fn(async () => null),
}));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: vi.fn(async () => ({
    planSlug: 'plan-a',
    itemId: 'P-003',
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  })),
  resyncDependentPlanItemLanesNow: reconcileMocks.resyncDependentPlanItemLanesNow,
  resyncPlanItemLaneNow: reconcileMocks.resyncPlanItemLaneNow,
}));
// Keep the conversion IO boundary closed without importing server startup.
vi.mock('../../plan-items/convert', () => ({
  convertPlanItem: convertMocks.convertPlanItem,
  findConvertedWorkItemByStamp: vi.fn(async () => null),
  findCoverageWorkItems: convertMocks.findCoverageWorkItems,
  looksLikeResidualClosure: vi.fn(() => false),
  TERMINAL_WORK_ITEM_STATES: new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']),
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

// Bind the hoisted bare `vi.fn()`s to the REAL signatures they stand in for, so
// every fixture below is typechecked against the actual return types instead of
// being waved through by an `as never` (lint:mock-cast-escape).
const convertM = convertMocks.convertPlanItem as Mock<typeof ConvertPlanItemFn>;
const claimM = claimMocks.claimForWork as Mock<typeof ClaimForWorkFn>;

type ConvertResult = Awaited<ReturnType<typeof ConvertPlanItemFn>>;
type ConvertSuccess = Extract<ConvertResult, { status: 'converted' | 'resumed' }>;

/**
 * A COMPLETE success result with a `Partial` override seam. The point is that a
 * required field added to ConvertPlanItemResult (or to WorkItem) breaks THIS ONE
 * factory at compile time, instead of rotting each fixture invisibly behind a cast.
 */
function convertSuccess(over: Partial<ConvertSuccess> = {}): ConvertSuccess {
  const base = {
    status: 'resumed',
    workItem: {
      id: 'WI-fixture',
      kind: 'change',
      family: 'issue',
      harness: 'papercup',
      title: 't',
      summary: '',
      state: 'open',
      assignee: 'su-caller',
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      createdBy: null,
      severity: null,
    },
    claim: { claimId: 'claim-1' },
    mode: 'activity',
    viaAssignment: false,
    planItem: { plan: 'plan-a', item: 'P-000', status: 'wip', text: 'x' },
  } as unknown as ConvertSuccess;
  return { ...base, ...over };
}

type Out = { data: any };
const body = async (args: Record<string, unknown>) => ((await tool.handler(args as never, {} as never)) as Out).data;

function lockReturnsMutatorValue(knownItems: Set<string>, currentStatus = 'todo') {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const fakeBody = knownItems.has(itemId) ? `- **${itemId}** \`${currentStatus}\` x` : '';
    const { value } = await (mutate as (
      b: string | null,
      metadata: unknown,
      scope: { workspaceId: string; harnessSlug: string },
    ) => Promise<{ value: unknown }>)(fakeBody, undefined, { workspaceId: 'default', harnessSlug: 'papercup' });
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvedTyped(claimM, { ok: true, claimId: 'claim-1', alreadyHeld: false });
  convertMocks.findCoverageWorkItems.mockResolvedValue([]);
});

describe('plans:set-status wip — execution-record disclosure (EI-22427741014249929)', () => {
  it('reports that a LIVE peer kept the linked work-item, naming the holder', async () => {
    mockResolvedTyped(convertM, {
      status: 'refused',
      reason: 'work item WI-2145857 implements this plan item and is held by su-peer, who is still live',
      assignee: 'su-peer',
    });
    lockReturnsMutatorValue(new Set(['P-003']));
    const b = await body({ slug: 'plan-a', item: 'P-003', status: 'wip' });
    expect(b.results[0].ok).toBe(true); // the STATUS flip still succeeds — this is disclosure, not a block
    expect(b.results[0].executionRecord).toMatchObject({
      outcome: 'held-by-live-peer',
      heldBy: 'su-peer',
    });
    expect(b.results[0].executionRecord.note).toMatch(/WI-2145857/);
  });

  it('NAMES the work-item and the displaced holder when a takeover did happen', async () => {
    mockResolvedTyped(
      convertM,
      convertSuccess({
        status: 'resumed',
        executionRecordTakeover: {
          workItemId: 'WI-2145858',
          priorHolder: 'su-lapsed',
          basis: 'holder-not-live',
        },
      }),
    );
    lockReturnsMutatorValue(new Set(['P-004']));
    const b = await body({ slug: 'plan-a', item: 'P-004', status: 'wip' });
    expect(b.results[0].executionRecord).toEqual({
      outcome: 'taken-over',
      workItemId: 'WI-2145858',
      priorHolder: 'su-lapsed',
      basis: 'holder-not-live',
    });
  });

  it('stays SILENT on an ordinary convert that moved no one else’s record', async () => {
    mockResolvedTyped(convertM, convertSuccess({ status: 'converted' }));
    lockReturnsMutatorValue(new Set(['P-005']));
    const b = await body({ slug: 'plan-a', item: 'P-005', status: 'wip' });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].executionRecord).toBeUndefined();
  });

  /**
   * Falsifiability control. The three cases above each assert on a DIFFERENT
   * convert outcome, so a stub that always emitted one shape would fail them —
   * but none of them proves the field is absent when the convert itself FAILS,
   * which is the branch the pre-fix code took on every path (result discarded).
   * A regression that reinstated "discard the result" makes case 1 and 2 fail
   * while this one still passes, so this is the case that must NOT be read as
   * coverage of the disclosure — it pins only the no-false-positive edge.
   */
  it('reports nothing when the auto-convert threw (best-effort leg must stay non-fatal)', async () => {
    mockRejectedTyped(convertM, new Error('convert exploded'));
    lockReturnsMutatorValue(new Set(['P-006']));
    // The best-effort leg logs the failure rather than throwing; assert that it
    // did (fail-on-console would otherwise fail this test) instead of silencing it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await body({ slug: 'plan-a', item: 'P-006', status: 'wip' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-convert plan-a#P-006 failed'), 'convert exploded');
    warn.mockRestore();
    expect(b.results[0].ok).toBe(true); // a convert failure never breaks the status flip
    expect(b.results[0].executionRecord).toBeUndefined();
  });

  it('passes the resolved caller identity to the plan lane/dependency resync', async () => {
    mockResolvedTyped(convertM, {
      status: 'refused',
      reason: 'work item WI-fixture is held by su-peer, who is still live',
      assignee: 'su-peer',
    });
    lockReturnsMutatorValue(new Set(['P-003']));

    const b = await body({ slug: 'plan-a', item: 'P-003', status: 'wip' });

    expect(b.results[0].ok).toBe(true);
    expect(reconcileMocks.resyncPlanItemLaneNow).toHaveBeenCalledWith(
      'plan-a',
      'P-003',
      null,
      'su-caller',
    );
  });

});

describe('plans:set-status terminal dependent-lane cascade', () => {
  it('passes the authenticated caller through the cascade', async () => {
    lockReturnsMutatorValue(new Set(['P-001']), 'wip');

    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'done' });

    expect(b.results[0], JSON.stringify(b.results[0])).toMatchObject({ ok: true });
    expect(reconcileMocks.resyncDependentPlanItemLanesNow).toHaveBeenCalledWith(
      'plan-a',
      'P-001',
      null,
      'su-caller',
    );
  });
});
