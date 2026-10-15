/**
 * Turn-start orientation under ACK-ON-PROOF
 * (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 *
 * read-cursors.test.ts pins the cursor contract in isolation. This pins what an
 * agent actually sees: a delta-tracked line (the post-claim history update) that
 * the hook never proved it printed must come back next turn, and one it did prove
 * must not. Before P-005 the turn's ARRIVAL was the ack, so a hook killed after
 * the server staged lost the line for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const progressWiring = vi.hoisted(() => ({
  read: vi.fn(), record: vi.fn(async () => 0),
}));
const identityBindMock = vi.hoisted(() => vi.fn(async (input: {
  identityId: string; outputs: Array<{ contributionId: string; value?: unknown; omission?: unknown }>;
}) => ({ identityId: input.identityId, contributions: input.outputs })));
vi.mock('./agent-obligation-reader', async (original) => ({
  ...(await original<typeof import('./agent-obligation-reader')>()),
  readAgentObligationAgenda: progressWiring.read,
}));
vi.mock('./goal-placement-progress-store', () => ({ reconcileGoalPlacementProgress: progressWiring.record }));
// R-4 / D-032: the reminder projection and the arm reader are observable so the
// experiment-arm tests below can prove what each arm does and does not deliver.
const armWiring = vi.hoisted(() => ({
  reminders: vi.fn(async () => {}), withholds: vi.fn(async (_goalId: string) => false),
}));
vi.mock('./agent-obligation-reminders', () => ({ reconcileAgentObligationReminders: armWiring.reminders }));
vi.mock('./goal-launch-settings', async (original) => ({
  ...(await original<typeof import('./goal-launch-settings')>()),
  goalWithholdsTurnStartReminders: armWiring.withholds,
}));

// The per-turn telemetry write is fire-and-forget and reaches PG; stub it so a
// unit test never opens a pool.
vi.mock('./orientation-telemetry', () => ({
  recordOrientationTurn: vi.fn(async () => {}),
  selectObligationTelemetry: () => ({ rows: [], evaluatedClasses: [] }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn() }),
}));

import {
  type AckConfirmation,
  type AckResult,
  configureReadCursorStore,
  InMemoryReadCursorStore,
  resetReadCursorStore,
} from './agent-tools/coordination/read-cursors';
import {
  bindTurnStartIdentityOutputs, buildTurnStartOrientationBlock, composeOrientationBlockWithRows, defaultOrientationDeps,
  resolveOrientationState, TURN_START_IDENTITY_DELIVERY_KEY, type OrientationDeps,
} from './turn-start-orientation';
import { AGENT_OBLIGATION_SCHEMA_VERSION, defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import { PLAN_CONTEXT_MAX, projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import { GOAL_PLACEMENT_DELIVERY_KEY, type GoalPlacementTurnReceiptDeps } from './goal-placement-turn-receipts';
import type { TranscriptTailTurn } from './turn-journal';
import { drainDetached } from './detached-imports';

const HISTORY_LINE = 'post-claim history update(s)';

/** Records what each turn's ack returned, so the tests can read the diff base. */
class RecordingStore extends InMemoryReadCursorStore {
  acks: Array<{ confirmation: AckConfirmation | undefined; result: AckResult }> = [];
  override async ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation) {
    const result = await super.ackAndRead(ownerId, surface, confirmation);
    this.acks.push({ confirmation, result });
    return result;
  }
}

const deps: OrientationDeps = {
  held: async () => [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: false }],
  ownerDirectives: async () => [],
  historyUpdates: async () => [{ workItemId: 'WI-9', count: 1, newestPostId: 12 }],
  effortUpdates: async () => [],
  openChecks: async () => [],
  planDecisions: async () => undefined,
  lockTransitions: async () => undefined,
  coupledPeers: async () => null,
  inbox: async () => ({ count: 0, newest: [] }),
  announcedGates: async () => [],
  openAsks: async () => null,
  modes: async () => [],
  authorityVerdict: async () => null,
  loopArmed: async () => true,
  loopFireWithheld: async () => false,
  improvementTriage: async () => null,
  executableFrontier: async () => null,
  obligations: async () => null,
  neverDropFacts: async () => [],
  toolSurface: async () => null,
  carryBlindWindow: async () => null,
  contextEpoch: async () => 1,
  contextTokens: async () => null,
};

const turn = (confirmedDeliveryToken?: string | null) =>
  buildTurnStartOrientationBlock({
    ownerId: 'su-proof',
    workspaceId: 'ws-proof',
    deps,
    identityBinder: identityBindMock as never,
    identityAssignmentReader: async () => null,
    ...(confirmedDeliveryToken === undefined ? {} : { confirmedDeliveryToken }),
  });

let store: RecordingStore;
beforeEach(() => {
  progressWiring.read.mockReset();
  progressWiring.record.mockClear();
  identityBindMock.mockClear();
  store = new RecordingStore();
  configureReadCursorStore(store);
});

describe('default orientation effect producer', () => {
  it('records the canonical snapshot even when a working portfolio has no primary action', async () => {
    const portfolio = { worklist: Array.from({ length: PLAN_CONTEXT_MAX + 2 }, (_, id) => ({ id })),
      assembledAt: '2026-09-23T15:00:00.000Z' };
    progressWiring.read.mockResolvedValue({ agenda: { primary: [] }, portfolio, goalId: 'goal', observedAt: portfolio.assembledAt });
    expect(await defaultOrientationDeps().obligations('su-proof', 'ws-proof')).toBeNull();
    await drainDetached();
    expect(progressWiring.record).toHaveBeenCalledExactlyOnceWith({ ownerId: 'su-proof', workspaceId: 'ws-proof', goalId: 'goal',
      portfolio: { ...portfolio, worklist: portfolio.worklist.slice(0, PLAN_CONTEXT_MAX) } });
  });
  it('does not create an effect clock without a canonical goal portfolio', async () => {
    progressWiring.read.mockResolvedValue({ agenda: { primary: [] }, portfolio: null, goalId: null,
      observedAt: '2026-09-23T15:00:00.000Z' });
    await defaultOrientationDeps().obligations('su-proof', 'ws-proof'); await drainDetached();
    expect(progressWiring.record).not.toHaveBeenCalled();
  });
  it('R-4 full arm: reads the arm for the goal and still projects reminders', async () => {
    armWiring.reminders.mockClear();
    armWiring.withholds.mockReset().mockResolvedValue(false);
    const portfolio = { worklist: [{ id: 1 }], assembledAt: '2026-09-29T01:00:00.000Z' };
    progressWiring.read.mockResolvedValue({ agenda: { primary: [] }, portfolio, goalId: 'goal-full', observedAt: portfolio.assembledAt });
    await defaultOrientationDeps().obligations('su-proof', 'ws-proof'); await drainDetached();
    expect(armWiring.withholds).toHaveBeenCalledExactlyOnceWith('goal-full');
    expect(armWiring.reminders).toHaveBeenCalledTimes(1);
  });
  it('R-4 brief-only/baseline arm: withholds agenda and reminders, keeps the effect clock', async () => {
    armWiring.reminders.mockClear();
    armWiring.withholds.mockReset().mockResolvedValue(true);
    const portfolio = { worklist: [{ id: 1 }], assembledAt: '2026-09-29T01:00:00.000Z' };
    // A non-empty primary agenda: without the arm this would render a brief.
    progressWiring.read.mockResolvedValue({ agenda: { primary: [{ kind: 'duty' }] }, portfolio, goalId: 'goal-arm',
      observedAt: portfolio.assembledAt });
    // The marker, not a bare null: a null is indistinguishable from an empty
    // agenda, and D-032 requires the receipt to say the ARM withheld it.
    expect(await defaultOrientationDeps().obligations('su-proof', 'ws-proof')).toEqual({ withheldBy: 'experiment-arm' });
    await drainDetached();
    expect(armWiring.reminders).not.toHaveBeenCalled();
    expect(progressWiring.record).toHaveBeenCalledTimes(1);
  });
  it('R-4 no goal: never reads an arm', async () => {
    armWiring.withholds.mockReset().mockResolvedValue(true);
    progressWiring.read.mockResolvedValue({ agenda: { primary: [] }, portfolio: null, goalId: null,
      observedAt: '2026-09-29T01:00:00.000Z' });
    await defaultOrientationDeps().obligations('su-proof', 'ws-proof'); await drainDetached();
    expect(armWiring.withholds).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await drainDetached();
  resetReadCursorStore();
  vi.restoreAllMocks();
});

describe('turn-start orientation — ack-on-proof', () => {
  it('binds root SU mode and presence assignment under the existing confirmed delivery token', async () => {
    const modes = [{ axisKey: 'autonomy', mode: 'auto', reason: 'owner',
      setBy: 'su-proof', setBySelf: true, ownerDirected: true, impliedBy: null }];
    const assignmentReader = vi.fn(async () => ({ ownerId: 'su-proof', workspaceId: 'ws-proof',
      intent: 'WI-9 current task', currentPlanSlug: 'current-plan', stale: false }));
    const boundTurn = (confirmedDeliveryToken: string | null) => buildTurnStartOrientationBlock({
      ownerId: 'su-proof', workspaceId: 'ws-proof',
      deps: { ...deps, modes: async () => modes }, confirmedDeliveryToken,
      identityBinder: identityBindMock as never, identityAssignmentReader: assignmentReader,
    });
    const first = await boundTurn(null);
    await drainDetached();
    expect(assignmentReader).toHaveBeenCalledExactlyOnceWith('su-proof');
    expect(identityBindMock).toHaveBeenCalledWith(expect.objectContaining({
      identityId: 'su', sourceTier: 'builtin', outputs: [
        { contributionId: 'turn-start-orientation', value: first.block },
        { contributionId: 'current-mode-state', value: modes },
        { contributionId: 'current-assignment', value: {
          ownerId: 'su-proof', intent: 'WI-9 current task', currentPlanSlug: 'current-plan',
        } },
      ],
    }));
    await boundTurn(first.deliveryToken!);
    expect(store.acks[1]?.result.committed?.[TURN_START_IDENTITY_DELIVERY_KEY]).toMatchObject({
      token: first.deliveryToken, status: 'bound', root: {
        identityId: 'su', contributions: expect.arrayContaining([
          { contributionId: 'turn-start-orientation', value: first.block },
          { contributionId: 'current-mode-state', value: modes },
          { contributionId: 'current-assignment', value: {
            ownerId: 'su-proof', intent: 'WI-9 current task', currentPlanSlug: 'current-plan',
          } },
        ]),
      },
    });
  });

  it('reports a missing presence assignment without substituting the held-item list', async () => {
    const bound = await bindTurnStartIdentityOutputs({
      ownerId: 'su-proof', workspaceId: 'ws-proof',
      state: { held: [{ id: 'WI-9' }], modes: [] } as never,
      committed: null, epoch: 1, contextTokens: null, block: 'current block', deliveryToken: 'token',
    }, identityBindMock as never, async () => null);
    expect(bound.root).toMatchObject({
      identityId: 'su', status: 'unavailable', errorRef: 'turn-start:root-binding-failed',
    });
    expect(identityBindMock).not.toHaveBeenCalledWith(expect.objectContaining({ identityId: 'su' }));
  });

  it('compiles the root SU receipt with the actual built-in identity source', async () => {
    const bound = await bindTurnStartIdentityOutputs({
      ownerId: 'su-proof', workspaceId: 'ws-proof',
      state: { modes: [{ axisKey: 'autonomy', mode: 'auto', reason: 'owner',
        setBy: 'su-proof', setBySelf: true, ownerDirected: true, impliedBy: null }] } as never,
      committed: null, epoch: 1, contextTokens: null, block: 'current block', deliveryToken: 'token',
    }, undefined, async () => ({ ownerId: 'su-proof', workspaceId: 'ws-proof',
      intent: 'WI-9 current task', currentPlanSlug: 'current-plan', stale: false }));
    expect(bound.root).toMatchObject({ identityId: 'su', sourceRevision: expect.any(String) });
    if (!('contributions' in bound.root)) throw new Error('root SU output was not bound');
    expect(bound.root.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound',
        producerRef: 'papercusp.mode-state@1' }),
      expect.objectContaining({ contributionId: 'current-assignment', status: 'bound',
        producerRef: 'papercusp.current-assignment@1' }),
    ]));
  });

  it('re-sends a line whose delivery was never proven, and stops once it is', async () => {
    const first = await turn(null);
    expect(first.block).toContain(HISTORY_LINE);
    expect(first.deliveryToken).toEqual(expect.any(String));

    // The hook died before printing, so it still confirms nothing it can prove.
    const retry = await turn('token-from-an-older-turn');
    expect(store.acks[1]?.result.committed).toBeNull();
    expect(retry.block).toContain(HISTORY_LINE);
    expect(retry.deliveryToken).not.toBe(first.deliveryToken);

    // This time the hook printed and recorded the token it was handed.
    const proven = await turn(retry.deliveryToken);
    expect(store.acks[2]?.result.committed).not.toBeNull();
    expect(proven.block).not.toContain(HISTORY_LINE);
  });

  it('pins the exact rendered block only under the existing confirmed delivery token', async () => {
    const first = await turn(null);
    await drainDetached();
    expect(identityBindMock).toHaveBeenCalledTimes(1);
    expect(identityBindMock.mock.calls[0]![0].outputs).toEqual([
      { contributionId: 'turn-start-orientation', value: first.block },
    ]);
    const retry = await turn('wrong-token');
    await drainDetached();
    expect(store.acks[1]?.result.committed).toBeNull();
    await turn(retry.deliveryToken);
    expect(store.acks[2]?.result.committed?.[TURN_START_IDENTITY_DELIVERY_KEY]).toMatchObject({
      token: retry.deliveryToken,
      proofMode: 'token',
      practice: { identityId: 'su.practice' },
    });
  });

  it('keeps the block and ACK live when identity binding exceeds its short budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await Promise.race([
      buildTurnStartOrientationBlock({
        ownerId: 'su-proof', workspaceId: 'ws-proof', deps, confirmedDeliveryToken: null,
        identityBinder: (() => new Promise<never>(() => {})) as never,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hook waited for optional identity binding')), 1_000)),
    ]);
    expect(first.block).toContain(HISTORY_LINE);
    expect(first.deliveryToken).toEqual(expect.any(String));
    await turn(first.deliveryToken);
    expect(store.acks[1]?.result.committed?.[TURN_START_IDENTITY_DELIVERY_KEY]).toMatchObject({
      token: first.deliveryToken,
      status: 'pending',
    });
    await drainDetached();
    await turn(null);
    expect(store.acks[2]?.result.committed?.[TURN_START_IDENTITY_DELIVERY_KEY]).toMatchObject({
      token: first.deliveryToken, status: 'unavailable', reason: 'timeout',
    });
  });

  it('a caller that sends no confirmation keeps ack-on-arrival and is handed no token', async () => {
    const first = await turn();
    expect(first.block).toContain(HISTORY_LINE);
    expect(first.deliveryToken).toBeNull();
    expect(store.acks[0]?.confirmation).toBeUndefined();

    // Arrival alone acks: the line is suppressed although nothing was proven.
    const second = await turn();
    expect(second.block).not.toContain(HISTORY_LINE);
  });
});

describe('goal placement receipts through the real orientation ACK path', () => {
  function fixture() {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 0, minute));
    const row = defineAgentObligation({
      family: 'plan-placement', ruleId: 'placement', ruleRevision: 'v1',
      scope: { ownerId: 'su-proof', workspaceId: 'ws-proof', goalId: 'goal', planSlug: 'plan' },
      responsibleOwnerId: 'su-proof', title: 'Place plan', status: 'due', reason: 'No member claim.',
      authority: { kind: 'policy', sourceRef: 'fixture:policy', revision: 'v1' },
      priority: 'high', causalRank: 1, evidence: [], applicableDemand: 1,
      sourceGeneration: 'generation-1', episode: 'fixture-episode',
      clearsWhen: { id: 'claimed', summary: 'Member claim exists.', evidenceKind: 'state', sourceRef: 'fixture:claims' },
      action: { kind: 'delegate', summary: 'Staff plan.', targetRef: 'plan:harness/plan', tool: 'fleet:launch-on-plan' },
    });
    const brief = projectAgentTurnStartObligationBrief({ schemaVersion: AGENT_OBLIGATION_SCHEMA_VERSION,
      evaluatedAt: at(2).toISOString(), sourceGeneration: 'generation-1', evaluations: [row], primary: [row], conflicts: [] });
    const native = { sourceKind: 'codex' as const, sessionId: 'native-proof', filePath: '/fixture/native' };
    const nativeTurn = (id: string, minute: number, responseDisposition: TranscriptTailTurn['responseDisposition'] = 'delivered'): TranscriptTailTurn => ({
      speaker: 'assistant', text: 'Response, not execution evidence.', ts: at(minute), requestId: id, responseDisposition,
    });
    let turns = [nativeTurn('prior', 1)];
    let now = at(2).getTime();
    const receiptDeps: GoalPlacementTurnReceiptDeps = {
      current: vi.fn(async () => native), lookup: vi.fn(async () => native), tail: vi.fn(async () => turns),
      append: vi.fn(async () => {}), now: () => now,
    };
    const goalDeps: OrientationDeps = { ...deps, held: async () => [], historyUpdates: async () => [],
      loopArmed: async () => false, obligations: async () => brief };
    return { row, brief, receiptDeps, goalDeps,
      finish: (disposition: TranscriptTailTurn['responseDisposition'] = 'delivered') => {
        turns = [nativeTurn('prior', 1), nativeTurn('current', 3, disposition)]; now = at(4).getTime();
      },
      turn: (token: string | null | undefined, overrides: Partial<OrientationDeps> = {}, budgetChars?: number) =>
        buildTurnStartOrientationBlock({ ownerId: 'su-proof', workspaceId: 'ws-proof',
          deps: { ...goalDeps, ...overrides }, progressReceiptDeps: receiptDeps,
          identityBinder: identityBindMock as never, placementBackgroundTimeoutMs: 1_000,
          ...(token === undefined ? {} : { confirmedDeliveryToken: token }),
          ...(budgetChars === undefined ? {} : { budgetChars }),
        }),
    };
  }

  it('records the exact delivered row after ACK and native completion even when the next state is empty', async () => {
    const f = fixture();
    const first = await f.turn(null);
    expect(first.block).toContain(formatAgentObligationLine(f.row, 'action'));
    expect(first.deliveryToken).toEqual(expect.any(String));
    expect(f.receiptDeps.append).not.toHaveBeenCalled();
    f.finish();
    const next = await f.turn(first.deliveryToken, { obligations: async () => null });
    await drainDetached();
    expect(next.block).toBe('');
    expect(store.acks[1]?.result.committed?.[GOAL_PLACEMENT_DELIVERY_KEY]).toMatchObject({ token: first.deliveryToken });
    expect(f.receiptDeps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
      goalPlacementTurn: expect.objectContaining({ obligationId: f.row.id, deliveryToken: first.deliveryToken,
        completedTurnRef: 'codex:native-proof:current', atConfirmation: null }),
    } }));
  });

  it('pins the already projected GOAL obligation only when the final block includes it', async () => {
    const f = fixture();
    const goalMode = { axisKey: 'goal', mode: 'goal', reason: 'owns goal', setBy: 'owner',
      setBySelf: false, ownerDirected: true, impliedBy: null };
    const first = await f.turn(null, { modes: async () => [goalMode] });
    await drainDetached();
    expect(first.block).toContain(f.brief.projection.text);
    const goalCall = identityBindMock.mock.calls.find(([input]) => input.identityId === 'su.mode-goal');
    expect(goalCall?.[0].outputs).toContainEqual({
      contributionId: 'goal-obligations', value: f.brief.projection.text,
    });
  });

  it('R-4 / D-032: an arm-withheld agenda renders nothing and is stamped experiment-arm, distinct from an empty one', async () => {
    const f = fixture();
    const goalMode = { axisKey: 'goal', mode: 'goal', reason: 'owns goal', setBy: 'owner',
      setBySelf: false, ownerDirected: true, impliedBy: null };
    const goalObligations = () => identityBindMock.mock.calls
      .filter(([input]) => input.identityId === 'su.mode-goal')
      .at(-1)?.[0].outputs.find((output: { contributionId: string }) => output.contributionId === 'goal-obligations');

    const withheld = await f.turn(null, {
      modes: async () => [goalMode],
      obligations: async () => ({ withheldBy: 'experiment-arm' as const }),
    });
    await drainDetached();
    expect(withheld.block).not.toContain(f.brief.projection.text);
    expect(goalObligations()).toEqual({ contributionId: 'goal-obligations', omission: { reason: 'experiment-arm' } });

    // Control: a genuinely empty agenda keeps its old receipt, so the two cases
    // stay distinguishable from the receipt alone.
    identityBindMock.mockClear();
    await f.turn(null, { modes: async () => [goalMode], obligations: async () => null });
    await drainDetached();
    expect(goalObligations()).toEqual({ contributionId: 'goal-obligations', omission: { reason: 'ineligible' } });
  });

  it('a wrong token attributes the discarded exposure and redelivers from the proven floor', async () => {
    const f = fixture();
    const first = await f.turn(null); f.finish();
    const retry = await f.turn('not-the-token');
    await drainDetached();
    expect(retry.block).toContain(formatAgentObligationLine(f.row, 'action'));
    expect(retry.deliveryToken).not.toBe(first.deliveryToken);
    expect(f.receiptDeps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
      goalPlacementDeliveryOutcome: expect.objectContaining({
        stage: 'confirm', recorded: false, reason: 'confirmation-token-mismatch',
        token: first.deliveryToken, planSlugs: ['plan'],
      }),
    } }));
  });

  it.each(['progress', 'interrupted'] as const)('does not record a %s native response despite valid delivery proof', async (disposition) => {
    const f = fixture(); const first = await f.turn(null); f.finish(disposition);
    await f.turn(first.deliveryToken); await drainDetached();
    // WI-10005636: no receipt, but the drop is attributed instead of discarded.
    expect(f.receiptDeps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
      goalPlacementDeliveryOutcome: expect.objectContaining({
        stage: 'confirm', recorded: false, reason: 'no-completed-native-decision',
        token: first.deliveryToken, planSlugs: ['plan'],
      }),
    } }));
  });

  it('legacy arrival ACK never becomes a goal exposure receipt', async () => {
    const f = fixture();
    const first = await f.turn(undefined); f.finish();
    await f.turn(undefined); await drainDetached();
    expect(first.deliveryToken).toBeNull();
    expect(f.receiptDeps.current).not.toHaveBeenCalled();
    expect(f.receiptDeps.append).not.toHaveBeenCalled();
  });

  it('does not measure an action omitted by the outer orientation budget', async () => {
    const f = fixture();
    const first = await f.turn(null, {}, 10);
    expect(first.block).not.toContain(formatAgentObligationLine(f.row, 'action'));
    expect(f.receiptDeps.current).not.toHaveBeenCalled();
  });

  it('keeps the action deliverable when native baseline IO times out, without fabricating a receipt', async () => {
    const f = fixture();
    f.receiptDeps.current = vi.fn(() => new Promise<never>(() => {}));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await f.turn(null);
    expect(first.block).toContain(formatAgentObligationLine(f.row, 'action'));
    expect(first.deliveryToken).toEqual(expect.any(String));
    await drainDetached();
    await f.turn(first.deliveryToken, { obligations: async () => null }); await drainDetached();
    expect(store.acks[1]?.result.committed?.[GOAL_PLACEMENT_DELIVERY_KEY]).toMatchObject({
      unavailable: true, reason: 'timeout', token: first.deliveryToken,
    });
    expect(f.receiptDeps.lookup).not.toHaveBeenCalled();
    // WI-10005636: both drop sites attribute themselves; neither is a receipt.
    const details = vi.mocked(f.receiptDeps.append).mock.calls.map(([record]) => record.detail);
    expect(details).toEqual([
      { goalPlacementDeliveryOutcome: expect.objectContaining({
        stage: 'late-upgrade', reason: 'late-prepare-timeout', unavailable: true, candidateReason: 'timeout',
        token: first.deliveryToken,
      }) },
      { goalPlacementDeliveryOutcome: expect.objectContaining({
        stage: 'confirm', reason: 'no-exact-proof-candidate', unavailable: true, token: first.deliveryToken,
      }) },
    ]);
  });

  it('upgrades a baseline that outlives the hook budget by token, so the next ACK still records the receipt', async () => {
    const f = fixture();
    const native = await f.receiptDeps.lookup('su-proof', 'native-proof');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    f.receiptDeps.current = vi.fn(async () => { await released; return native; });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await f.turn(null);
    expect(first.block).toContain(formatAgentObligationLine(f.row, 'action'));
    expect(first.deliveryToken).toEqual(expect.any(String));
    release(); await drainDetached();
    f.finish();
    await f.turn(first.deliveryToken); await drainDetached();
    expect(store.acks[1]?.result.committed?.[GOAL_PLACEMENT_DELIVERY_KEY]).toMatchObject({
      token: first.deliveryToken, nativeSessionId: 'native-proof',
    });
    expect(f.receiptDeps.append).toHaveBeenCalledTimes(1);
  });

  describe('outer budget reserves the due placement row', () => {
    // Measured live 2026-09-30 (goal 60d3a8, holder su-2e6fb313): the sink admitted
    // the placement row, then the composed block spent its budget on three open-check
    // rows and the same plan's author-repair row. The placement line was the next row,
    // missed the budget, and no goalPlacementTurn receipt could ever form.
    const SLUG = 'session-transcript-exact-fuzzy-search-2026-09-14';
    const common = {
      ruleRevision: 'v1', responsibleOwnerId: 'su-proof', priority: 'high' as const, evidence: [],
      authority: { kind: 'policy' as const, sourceRef: 'fixture:policy', revision: 'v1' },
      sourceGeneration: 'generation-1', episode: 'fixture-episode',
      clearsWhen: { id: 'resolved', summary: 'Resolved.', evidenceKind: 'state' as const, sourceRef: 'fixture:state' },
    };
    const openChecks = async () => [1, 2, 3].map((n) => ({ id: `check-${n}`, kind: 'check' as const,
      claim: `carried claim ${n} `.padEnd(120, '.'), recheck: `probe ${n} `.padEnd(120, '.'), pointer: `WI-${n}` }));
    function crowded(placementDemand: number) {
      const repair = defineAgentObligation({ ...common, family: 'independent-verification', ruleId: 'verify',
        scope: { ownerId: 'su-proof', workspaceId: 'ws-proof', planSlug: SLUG },
        title: `Plan ${SLUG} needs author repair before independent certification`, status: 'due',
        reason: 'Gate refused.', causalRank: 1, applicableDemand: 1,
        action: { kind: 'repair', summary: 'repair acceptance_bar_contract_not_ready before requesting a grader',
          targetRef: `plan:harness/${SLUG}` } });
      const placement = defineAgentObligation({ ...common, family: 'plan-placement', ruleId: 'placement',
        scope: { ownerId: 'su-proof', workspaceId: 'ws-proof', goalId: 'goal', planSlug: SLUG },
        title: `Place goal plan ${SLUG}`, status: 'due', reason: 'No member claim.', causalRank: 2,
        applicableDemand: placementDemand,
        action: { kind: 'delegate', summary: 'launch its independently led fleet', targetRef: `plan:harness/${SLUG}`,
          tool: 'fleet:launch-on-plan' } });
      const brief = projectAgentTurnStartObligationBrief({ schemaVersion: AGENT_OBLIGATION_SCHEMA_VERSION,
        evaluatedAt: '2026-09-30T19:37:00.000Z', sourceGeneration: 'generation-1',
        evaluations: [repair, placement], primary: [repair, placement], conflicts: [] });
      return { line: formatAgentObligationLine(placement, 'action'), brief,
        overrides: { openChecks, obligations: async () => brief } satisfies Partial<OrientationDeps> };
    }
    /** A budget that fits every row ahead of the placement line but not the line itself. */
    async function cuttingBudget(overrides: Partial<OrientationDeps>, line: string) {
      const state = await resolveOrientationState('su-proof', 'ws-proof', { ...fixture().goalDeps, ...overrides });
      const full = composeOrientationBlockWithRows({ state, committed: null, epoch: 1, budgetChars: 20_000 }).block;
      expect(full).toContain(line);
      return full.indexOf(line) + Math.floor(line.length / 2);
    }

    it('delivers the line the budget would cut, and the receipt forms from it', async () => {
      const f = fixture();
      const due = crowded(1);
      expect(due.brief.projection.receipt).toMatchObject({ entriesDelivered: 2, entriesOmitted: 0 });
      const budget = await cuttingBudget(due.overrides, due.line);
      const first = await f.turn(null, due.overrides, budget);
      expect(first.block.length).toBeLessThanOrEqual(budget);
      expect(first.block).toContain(due.line);
      expect(first.block).toMatch(/orientation rows omitted/);
      f.finish();
      await f.turn(first.deliveryToken, { obligations: async () => null }); await drainDetached();
      expect(f.receiptDeps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
        goalPlacementTurn: expect.objectContaining({ planSlug: SLUG, deliveryToken: first.deliveryToken }),
      } }));
    });

    it('CONTROL: the same line with no applicable demand is not reserved, and the budget cuts it', async () => {
      const f = fixture();
      const due = crowded(1);
      const idle = crowded(0);
      expect(idle.line).toBe(due.line);
      const first = await f.turn(null, idle.overrides, await cuttingBudget(idle.overrides, idle.line));
      expect(first.block).not.toContain(idle.line);
      expect(first.block).toMatch(/orientation rows omitted/);
    });
  });
});
