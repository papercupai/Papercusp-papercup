/**
 * engine.test.ts — emit split (wake vs notify) + pump pacing (D-002/D-007),
 * store/executor/messages mocked (await-event-primitive-2026-06-05 P-006).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwaitRow, DeliveryWork, WakeOutcome } from './types';
import type { ProducerHealthCertificate, VerifiedWaitTimeoutResult } from './verified-wait';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

type SettleVerifiedAwaitTimeoutInput = {
  id: number;
  result: VerifiedWaitTimeoutResult;
  nextCertificate?: ProducerHealthCertificate;
};

const h = vi.hoisted(() => ({
  store: {
    fireAwaitsForKey: vi.fn(async (): Promise<unknown[]> => []),
    insertDeliveries: vi.fn(async () => 0),
    compactSupersededLoopDeliveries: vi.fn(async () => 0),
    claimDueDeliveries: vi.fn(async (): Promise<unknown[]> => []),
    settleCancelledAwaitDeliveries: vi.fn(async (): Promise<number[]> => []),
    markDeliveryDelivered: vi.fn(async () => {}),
    markDeliveriesCoalesced: vi.fn(async () => {}),
    lastWokenAtForSubscribers: vi.fn(async () => new Map<string, number>()),
    markDeliveryParked: vi.fn(async () => {}),
    markDeliveryDropped: vi.fn(async () => {}),
    markDeliveryFailed: vi.fn(async () => 'retrying' as const),
    // Production returns the full 'retrying' | 'dead' | 'ignored' union; `as const` pinned the
    // mock to the first literal, so a legitimate 'dead' outcome could not be staged.
    reopenDeliveredAfterResumeDeath: vi.fn(
      async (): Promise<'retrying' | 'dead' | 'ignored'> => 'retrying',
    ),
    markDeliveryDeferred: vi.fn(async () => {}),
    recoverStuckDeliveries: vi.fn(async () => 0),
    claimDueVerifiedAwaits: vi.fn(async (): Promise<AwaitRow[]> => []),
    settleVerifiedAwaitTimeout: vi.fn(async (_input: SettleVerifiedAwaitTimeoutInput): Promise<AwaitRow | null> => null),
    fireTimedOutAwaits: vi.fn(async (): Promise<unknown[]> => []),
    expireLapsedAwaits: vi.fn(async () => 0),
    stampAnnouncementsFired: vi.fn(async (): Promise<number> => 0),
    // event-wait-settlement-2026-10-20 P-004: the unannounced proving-fire settlement.
    settleProvingFire: vi.fn(async (): Promise<number> => 0),
    recordKeyFire: vi.fn(async (): Promise<Awaited<ReturnType<typeof import('./store').recordKeyFire>> | undefined> => undefined),
    reconcileFiredWakeDeliveries: vi.fn(async () => 0),
    cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
    listActiveAwaitsForKey: vi.fn(async (_key: string): Promise<AwaitRow[]> => []),
    refreshStandingClaimableAwaitPayloadFilters: vi.fn(async (): Promise<AwaitRow[]> => []),
    claimSpecificOnceAwaits: vi.fn(async (ids: number[]): Promise<AwaitRow[]> =>
      ids.map((id) => awaitRow({ id })),
    ),
    cancelAwaitsByIds: vi.fn(async () => 0),
  },
  executeWake: vi.fn(
    async (
      _delivery: DeliveryWork,
      _deps: { onResumeTurnExit?: (delivery: DeliveryWork, exit: unknown, context?: unknown) => void },
    ): Promise<unknown> => ({ kind: 'delivered', channel: 'resume' }),
  ),
  // EI-16559: the REAL degradeToInboxOrDrop calls sendMessage under the hood; the
  // hoisted mock mirrors that shape (delivered/inbox on success, drop on failure) so
  // engine.ts's exhausted-retries fallback exercises against a faithful double
  // without engine.test.ts depending on wake-executor's internals.
  degradeToInboxOrDrop: vi.fn(
    async (_d: DeliveryWork, _reason: string): Promise<WakeOutcome> => ({
      kind: 'delivered' as const,
      channel: 'inbox' as const,
    }),
  ),
  sendMessage: vi.fn(async () => ({ msg_id: 'm-1' })),
  fetchPresenceFleet: vi.fn(async () => new Map<string, { fleetSlug: string; fleetRole: string }>()),
  admitSpawn: vi.fn(async (): Promise<{ admitted: boolean }> => ({ admitted: true })),
  admitWakeFanout: vi.fn(async (): Promise<number> => 0),
  // WI-4014 Part 2: standing event-key inject subscribers folded into the notify path.
  listEventKeySubscribers: vi.fn(async (): Promise<Array<{ subscriber_id: string; delivery_mode: string }>> => []),
  // Legacy read cursor used only for message-less inbox notifications. Empty by
  // default, so existing tests that don't care about it never suppress anything.
  lastInboxReadAtBatch: vi.fn(async (_ownerIds: string[]): Promise<Map<string, string>> => new Map()),
  // EI-18676763837940562: the reply-linkage leg's batched lookup — no replies on
  // record by default, matching the fail-open default (never suppresses anything
  // existing tests don't explicitly set up).
  repliedMsgIdsBatch: vi.fn(async (_subscriberId: string, _msgIds: readonly string[]): Promise<Set<string>> => new Set()),
  getSettledInboxMessageIds: vi.fn(async (_msgIds: readonly string[], _workspaceId?: string): Promise<Set<string>> => new Set()),
  readWatermark: vi.fn(async (_ownerId: string) => ({ messages_shown_ts: '' })),
  // P-024 clauses B/C: the actionability gate's envelope read. Unresolved (null) by
  // default, which the gate reads as "keep the turn" — existing tests never suppress.
  getLineEnvelopeById: vi.fn(async (_surface: string, _msgId: string): Promise<Record<string, unknown> | null> => null),
  observeCheckpointProducer: vi.fn(),
  compose: {
    bumpNode: vi.fn(),
    claimDueComposedRoots: vi.fn(async () => []),
    reconcileComposedRoot: vi.fn(async () => ({ delivered: false, settled: false })),
    reconcileComposedRoots: vi.fn(async () => ({ roots: 0, deliveries: 0 })),
    findRootAnchor: vi.fn(),
    insertComposedRootDelivery: vi.fn(),
    loadTreeLeaves: vi.fn(),
    stampLeafMemberFired: vi.fn(),
    voidTreeDescendants: vi.fn(),
  },
}));

vi.mock('./store', () => h.store);
// event-wait-settlement-2026-10-20 P-007: the completion-fire clear the emit loads lazily.
const autoClear = vi.hoisted(() => ({
  settleWorkItemDoneFire: vi.fn(async (_key: string, _workspaces: readonly string[] | undefined): Promise<unknown[]> => []),
}));
vi.mock('../../work-item-ref-blocker-auto-clear', async (orig) => ({
  ...(await orig<typeof import('../../work-item-ref-blocker-auto-clear')>()),
  settleWorkItemDoneFire: autoClear.settleWorkItemDoneFire,
}));
vi.mock('../../agent-tools/coordination/wake-fanout-pacing', async (orig) => ({
  ...(await orig<typeof import('../../agent-tools/coordination/wake-fanout-pacing')>()),
  admitWakeFanout: h.admitWakeFanout,
}));
vi.mock('./wake-executor', () => ({ executeWake: h.executeWake, degradeToInboxOrDrop: h.degradeToInboxOrDrop }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: h.sendMessage, repliedMsgIdsBatch: h.repliedMsgIdsBatch }));
vi.mock('../../attention/bulk-run-store', () => ({
  getSettledInboxMessageIds: h.getSettledInboxMessageIds,
}));
vi.mock('../../agent-tools/coordination/presence-fleet', () => ({ fetchPresenceFleet: h.fetchPresenceFleet }));
vi.mock('../../agent-tools/coordination/event-subscriptions', () => ({
  listEventKeySubscribers: h.listEventKeySubscribers,
  eventKeySubscriberScope: () => ({ workspaceId: 'default', targetKind: 'event' }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test', backgroundWorkspaceIds: () => ['ws-test'] }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));
vi.mock('../../agent-tools/coordination/inbox-read-freshness', () => ({
  lastInboxReadAtBatch: h.lastInboxReadAtBatch,
}));
vi.mock('../../agent-tools/coordination/watermarks', () => ({
  readWatermark: h.readWatermark,
}));
vi.mock('../../agent-tools/coordination/line-event-by-id', () => ({
  getLineEnvelopeById: h.getLineEnvelopeById,
}));
vi.mock('./checkpoint-verified-wait', () => ({
  observeCheckpointProducer: h.observeCheckpointProducer,
}));
vi.mock('./compose-store', () => h.compose);
const recoveryHook = vi.hoisted(() => ({
  annotateTimedOutAnnouncedAwaits: vi.fn(async (): Promise<Map<number, Record<string, unknown>>> => new Map()),
}));
const predicateTimeoutHook = vi.hoisted(() => ({
  getPredicateTimeoutContext: vi.fn(async (_input: unknown): Promise<unknown> => null),
}));
vi.mock('./declared-gate-recovery-runtime', () => recoveryHook);
vi.mock('./predicate-watch', () => predicateTimeoutHook);

const {
  emitAwaitedEvent,
  pumpWakeDeliveries,
  coalesceDeliveries,
  cancelSupersededCandidateAwaits,
  isInboxWakeGroupRedundant,
  setAutoPumpEnabledForTests,
  sweepAllWorkspaces,
  sweepOnce,
  wakeClaimableAwaitersForSubscribers,
} = await import('./engine');
const { setPumpHealthTrackerForTests } = await import('./pump-health');

function awaitRow(over: Partial<AwaitRow> = {}): AwaitRow {
  return {
    id: 1,
    workspaceId: 'ws-test',
    subscriberId: 'su-w',
    eventKey: 'k',
    policy: 'wake',
    note: null,
    wakeHandle: null,
    timeoutBehavior: 'wake',
    expiresTs: null,
    createdAt: new Date().toISOString(),
    firedAt: new Date().toISOString(),
    firedReason: 'event',
    cancelledAt: null,
    cancelReason: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: null,
    scopeRef: null,
    ...over,
  };
}

function workRow(over: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 10,
    workspaceId: 'ws-test',
    awaitId: 1,
    subscriberId: 'su-w',
    eventKey: 'k',
    payload: null,
    summary: null,
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    wakeHandle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 },
    note: null,
    turnProof: null,
    turnStartedAt: null,
    pickupDeadlineAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.claimDueVerifiedAwaits.mockResolvedValue([]);
  h.store.compactSupersededLoopDeliveries.mockResolvedValue(0);
  h.store.settleVerifiedAwaitTimeout.mockResolvedValue(null);
  h.store.fireTimedOutAwaits.mockResolvedValue([]);
  h.store.claimDueDeliveries.mockResolvedValue([]);
  h.admitWakeFanout.mockResolvedValue(0);
  h.store.settleCancelledAwaitDeliveries.mockResolvedValue([]);
  h.compose.claimDueComposedRoots.mockResolvedValue([]);
  predicateTimeoutHook.getPredicateTimeoutContext.mockResolvedValue(null);
  // The engine logs wake outcomes deliberately (visible drops, D-004);
  // the suite-wide fail-on-console guard must not count those.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK;
});

describe('sweepOnce — declared-gate recovery on timed-out announced waits', () => {
  it('keeps the generic timeout wake for plain keys and hands announced-key waiters their exact next verb', async () => {
    const plain = awaitRow({ id: 1, eventKey: 'plain:key', firedAt: null, firedReason: null });
    const gated = awaitRow({ id: 2, eventKey: 'gate:announced', firedAt: null, firedReason: null });
    h.store.fireTimedOutAwaits.mockResolvedValueOnce([plain, gated]);
    const recovery = { classification: 'never-fireable', next_verb: { verb: 'events:cancel' } };
    recoveryHook.annotateTimedOutAnnouncedAwaits.mockResolvedValueOnce(new Map([[2, recovery]]));

    await sweepOnce('ws-test');

    expect(recoveryHook.annotateTimedOutAnnouncedAwaits).toHaveBeenCalledWith([plain, gated]);
    expect(h.store.insertDeliveries).toHaveBeenCalledTimes(2);
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ awaits: [plain], payload: expect.not.objectContaining({ declaredGateRecovery: expect.anything() }) }),
    );
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        awaits: [gated],
        payload: expect.objectContaining({ timeout: true, declaredGateRecovery: recovery }),
        summary: expect.stringMatching(/never-fireable/),
      }),
    );
  });

  it('fail-open: a throwing recovery hook leaves every timed-out wake on the generic path', async () => {
    const a = awaitRow({ id: 3, eventKey: 'gate:x', firedAt: null, firedReason: null });
    h.store.fireTimedOutAwaits.mockResolvedValueOnce([a]);
    recoveryHook.annotateTimedOutAnnouncedAwaits.mockRejectedValueOnce(new Error('import failed'));

    await sweepOnce('ws-test');

    expect(h.store.insertDeliveries).toHaveBeenCalledTimes(1);
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ awaits: [a], payload: expect.objectContaining({ timeout: true }) }),
    );
  });

  it('gives predicate timeouts the stored spec and directs the caller to a fresh key', async () => {
    const timedOut = awaitRow({
      id: 4,
      eventKey: 'predicate:expired-id',
      subscriberId: 'su-w',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresTs: '2026-01-01T01:00:00.000Z',
      firedAt: null,
      firedReason: null,
    });
    predicateTimeoutHook.getPredicateTimeoutContext.mockResolvedValueOnce({
      tool: 'state:read',
      args: { cell: 'gate.greenCheckpoint.verdict' },
      path: 'value.sha',
      op: 'changed',
      value: null,
      intervalSec: 30,
      once: true,
    });
    h.store.fireTimedOutAwaits.mockResolvedValueOnce([timedOut]);

    await sweepOnce('ws-test');

    expect(predicateTimeoutHook.getPredicateTimeoutContext).toHaveBeenCalledWith({
      eventKey: 'predicate:expired-id',
      subscriberId: 'su-w',
    });
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        awaits: [timedOut],
        summary: expect.stringContaining('do not re-arm the expired key'),
        payload: expect.objectContaining({
          timeout: true,
          guidance: expect.stringContaining('Do NOT call events:await on this expired key'),
          predicateRecovery: {
            tool: 'watch:create',
            args: {
              pattern: 'predicate-timeout-recovery',
              wake: true,
              once: true,
              interval_sec: 30,
              on_timeout: 'wake',
              timeout_sec: 3600,
              predicate: {
                tool: 'state:read',
                args: { cell: 'gate.greenCheckpoint.verdict' },
                path: 'value.sha',
                op: 'changed',
              },
            },
          },
        }),
      }),
    );
  });
});

describe('sweepOnce — verified-wait producer controls', () => {
  const verifiedAwait = (over: Partial<AwaitRow> = {}): AwaitRow =>
    awaitRow({
      id: 91,
      subscriberId: 'su-waiter',
      eventKey: 'release:green:papercusp',
      firedAt: null,
      firedReason: null,
      expiresTs: new Date(2_000).toISOString(),
      producerHealthCertificate: {
        version: 1,
        producer: { kind: 'green-checkpoint', id: 'run-42' },
        owner: { ownerId: 'su-owner', workItemId: 'WI-42' },
        issuedAtMs: 1_000,
        lastProgressAtMs: 900,
        lastFireAtMs: null,
        expectedCadenceMs: 500,
        verificationDeadlineMs: 2_000,
        details: { pipeline: 'papercusp', runId: 'run-42' },
      },
      ...over,
    });

  it('keeps a progressing producer parked by renewing the same await without a wake delivery', async () => {
    const awaited = verifiedAwait();
    h.store.claimDueVerifiedAwaits.mockResolvedValueOnce([awaited]);
    h.observeCheckpointProducer.mockResolvedValueOnce({
      checkedAtMs: 2_000,
      producerPresent: true,
      lastProgressAtMs: 1_900,
      lastFireAtMs: null,
      completedAtMs: null,
      evidence: { phase: 'suite' },
    });

    await sweepOnce('ws-test');

    expect(h.store.settleVerifiedAwaitTimeout).toHaveBeenCalledWith({
      id: 91,
      result: expect.objectContaining({ classification: 'progressing', nextAction: 're-await' }),
      nextCertificate: expect.objectContaining({
        issuedAtMs: 2_000,
        lastProgressAtMs: 1_900,
        verificationDeadlineMs: 2_500,
      }),
    });
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
  });

  it('wakes a stalled producer with its diagnosis and ownership remedy', async () => {
    const awaited = verifiedAwait();
    h.store.claimDueVerifiedAwaits.mockResolvedValueOnce([awaited]);
    h.observeCheckpointProducer.mockResolvedValueOnce({
      checkedAtMs: 2_000,
      producerPresent: true,
      lastProgressAtMs: 900,
      lastFireAtMs: null,
      completedAtMs: null,
      evidence: { phase: 'suite', active: true },
    });
    h.store.settleVerifiedAwaitTimeout.mockImplementationOnce(async ({ result }) =>
      verifiedAwait({ timeoutVerification: result, firedAt: new Date(2_000).toISOString(), firedReason: 'verified-timeout' }),
    );

    await sweepOnce('ws-test');

    expect(h.store.insertDeliveries).toHaveBeenCalledWith({
      awaits: [expect.objectContaining({ id: 91 })],
      payload: expect.objectContaining({
        timeout: true,
        verified: true,
        results: [expect.objectContaining({
          classification: 'stalled',
          nextAction: 'wake-owner-or-takeover',
          owner: { ownerId: 'su-owner', workItemId: 'WI-42' },
        })],
      }),
      summary: expect.stringContaining('Verified wait fallback classified the producer'),
    });
  });

  it('does not emit takeover when an inactive run/routine snapshot is only unknown', async () => {
    const awaited = verifiedAwait({
      producerHealthCertificate: {
        ...verifiedAwait().producerHealthCertificate!,
        owner: { ownerId: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083', workItemId: 'WI-40086' },
      },
    });
    h.store.claimDueVerifiedAwaits.mockResolvedValueOnce([awaited]);
    h.observeCheckpointProducer.mockResolvedValueOnce({
      checkedAtMs: 2_000,
      producerPresent: false,
      state: 'unknown',
      lastProgressAtMs: null,
      lastFireAtMs: null,
      completedAtMs: null,
      evidence: { active: false, candidate: null, routineActive: false, routinePauseReason: null },
    });

    await sweepOnce('ws-test');

    expect(h.store.settleVerifiedAwaitTimeout).toHaveBeenCalledWith({
      id: 91,
      result: expect.objectContaining({ classification: 'unknown', nextAction: 're-await' }),
      nextCertificate: undefined,
    });
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
  });

  it('resumes immediately when the authoritative completion latch already fired', async () => {
    const awaited = verifiedAwait();
    h.store.claimDueVerifiedAwaits.mockResolvedValueOnce([awaited]);
    h.observeCheckpointProducer.mockResolvedValueOnce({
      checkedAtMs: 2_000,
      producerPresent: false,
      lastProgressAtMs: null,
      lastFireAtMs: 1_950,
      completedAtMs: 1_950,
      evidence: { verdictStatus: 'advanced' },
    });
    h.store.settleVerifiedAwaitTimeout.mockImplementationOnce(async ({ result }) =>
      verifiedAwait({ timeoutVerification: result, firedAt: new Date(2_000).toISOString(), firedReason: 'verified-timeout' }),
    );

    await sweepOnce('ws-test');

    expect(h.store.settleVerifiedAwaitTimeout).toHaveBeenCalledWith({
      id: 91,
      result: expect.objectContaining({ classification: 'already-complete', nextAction: 'resume' }),
      nextCertificate: undefined,
    });
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        results: [expect.objectContaining({ classification: 'already-complete', nextAction: 'resume' })],
      }),
    }));
  });
});
afterEach(() => {
  delete process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK;
});

describe('emitAwaitedEvent', () => {
  it('forwards the emitter source into durable await matching', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);

    await emitAwaitedEvent({
      key: 'coord:inbox-wake:su-rescue-source',
      source: 'unguarded-halt-rescue',
    });

    expect(h.store.fireAwaitsForKey).toHaveBeenCalledWith({
      eventKey: 'coord:inbox-wake:su-rescue-source',
      reason: 'event',
      payload: undefined,
      source: 'unguarded-halt-rescue',
    });
  });

  it('wake awaits → deliveries; notify awaits + to[] → ONE coord message; woken excluded from notify', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-w', policy: 'wake' }),
      awaitRow({ id: 2, subscriberId: 'su-n', policy: 'notify' }),
    ]);
    const r = await emitAwaitedEvent({
      key: 'k',
      summary: 'done',
      to: ['su-w', 'su-extra', '@topic:locks'],
      source: 'su-emitter',
    });
    expect(r.woken).toBe(1);
    expect(h.store.insertDeliveries).toHaveBeenCalledTimes(1);
    const insertArg = (h.store.insertDeliveries.mock.calls[0] as unknown as [{ awaits: AwaitRow[] }])[0];
    expect(insertArg.awaits.map((a) => a.id)).toEqual([1]);
    // notify = notify-await subscriber + extra recipients, MINUS the woken one.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; extra: Record<string, unknown> }];
    expect(sendArgs[1].to.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
    expect(sendArgs[1].summary).toContain('k');
    expect(sendArgs[1].extra.event_key).toBe('k');
    expect(r.notified.sort()).toEqual(['@topic:locks', 'su-extra', 'su-n'].sort());
    // EI-9000: waiters = total ACTIVE await registrations matched (wake + notify
    // policy), independent of the extra to[] audience — 1 wake + 1 notify = 2,
    // regardless of the 2 extra to[] names folded into the notify send above.
    expect(r.waiters).toBe(2);
  });

  it('nothing fired + no to[] → no message, no deliveries, waiters:0 (emit reached no one)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.woken).toBe(0);
    expect(r.waiters).toBe(0);
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('a notify-send failure never breaks the emit (politeness layer)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.sendMessage.mockRejectedValueOnce(new Error('coord down'));
    const r = await emitAwaitedEvent({ key: 'k', to: ['su-x'] });
    expect(r.ok).toBe(true);
    expect(r.msgId).toBeNull();
  });
});

describe('wakeClaimableAwaitersForSubscribers — EI-20079462322478221', () => {
  it('claims only targeted one-shot wake awaits and delivers the spec-change hint', async () => {
    const previousAutoPump = setAutoPumpEnabledForTests(false);
    try {
      h.store.listActiveAwaitsForKey.mockResolvedValueOnce([
        awaitRow({
          id: 11,
          eventKey: 'work-item:claimable',
          subscriberId: 'su-target',
          once: true,
          policy: 'wake',
          payloadFilter: { kind: { equals: 'bug' } },
        }),
        awaitRow({
          id: 12,
          eventKey: 'work-item:claimable',
          subscriberId: 'su-peer',
          once: true,
          policy: 'wake',
        }),
        awaitRow({
          id: 13,
          eventKey: 'work-item:claimable',
          subscriberId: 'su-target',
          once: false,
          policy: 'wake',
        }),
        awaitRow({
          id: 14,
          eventKey: 'work-item:claimable',
          subscriberId: 'su-target',
          once: true,
          policy: 'notify',
        }),
      ]);
      h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([
        awaitRow({
          id: 11,
          eventKey: 'work-item:claimable',
          subscriberId: 'su-target',
          once: true,
          policy: 'wake',
        }),
      ]);

      const woken = await wakeClaimableAwaitersForSubscribers({
        subscriberIds: ['su-target', 'su-target'],
        specId: 'bugs-lane',
        revision: 7,
      });

      expect(woken).toBe(1);
      expect(h.store.listActiveAwaitsForKey).toHaveBeenCalledWith('work-item:claimable');
      expect(h.store.claimSpecificOnceAwaits).toHaveBeenCalledWith([11], 'claim-spec-revision');
      expect(h.store.insertDeliveries).toHaveBeenCalledWith({
        awaits: [expect.objectContaining({ id: 11, subscriberId: 'su-target' })],
        payload: { reason: 'claim-spec-revision', specId: 'bugs-lane', revision: 7 },
        summary: 'Claim spec bugs-lane@7 changed; re-run scheduler:get_next to re-evaluate the live lane.',
        source: 'scheduler:set_claim_spec',
      });
    } finally {
      setAutoPumpEnabledForTests(previousAutoPump);
    }
  });

  it('does not enqueue a delivery when the atomic await claim loses a race', async () => {
    const previousAutoPump = setAutoPumpEnabledForTests(false);
    try {
      h.store.listActiveAwaitsForKey.mockResolvedValueOnce([
        awaitRow({ id: 21, eventKey: 'work-item:claimable', subscriberId: 'su-target', once: true, policy: 'wake' }),
      ]);
      h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([]);

      await expect(
        wakeClaimableAwaitersForSubscribers({ subscriberIds: ['su-target'], specId: 'lane', revision: 2 }),
      ).resolves.toBe(0);
      expect(h.store.insertDeliveries).not.toHaveBeenCalled();
    } finally {
      setAutoPumpEnabledForTests(previousAutoPump);
    }
  });

  it('refreshes and wakes a standing filtered watch when the claim spec changes', async () => {
    const previousAutoPump = setAutoPumpEnabledForTests(false);
    try {
      const payloadFilter = {
        all: [{ harness: { equals: 'papercusp' } }, { id: { in: ['EI-new'] } }],
      };
      const standing = awaitRow({
        id: 31,
        eventKey: 'work-item:claimable',
        subscriberId: 'su-target',
        once: false,
        firedAt: null,
        firedReason: null,
        payloadFilter: { id: { in: ['EI-old'] } },
      });
      h.store.listActiveAwaitsForKey.mockResolvedValueOnce([standing]);
      h.store.refreshStandingClaimableAwaitPayloadFilters.mockResolvedValueOnce([standing]);

      await expect(
        wakeClaimableAwaitersForSubscribers({
          subscriberIds: ['su-target'],
          specId: 'bugs-lane',
          revision: 8,
          payloadFilter,
        }),
      ).resolves.toBe(1);
      expect(h.store.refreshStandingClaimableAwaitPayloadFilters).toHaveBeenCalledWith({
        subscriberIds: ['su-target'],
        payloadFilter,
      });
      expect(h.store.claimSpecificOnceAwaits).not.toHaveBeenCalled();
      expect(h.store.insertDeliveries).toHaveBeenCalledWith({
        awaits: [expect.objectContaining({ id: 31, once: false })],
        payload: { reason: 'claim-spec-revision', specId: 'bugs-lane', revision: 8 },
        summary: 'Claim spec bugs-lane@8 changed; re-run scheduler:get_next to re-evaluate the live lane.',
        source: 'scheduler:set_claim_spec',
      });
    } finally {
      setAutoPumpEnabledForTests(previousAutoPump);
    }
  });

  it('is a no-op for an empty target set', async () => {
    await expect(wakeClaimableAwaitersForSubscribers({ subscriberIds: [] })).resolves.toBe(0);
    expect(h.store.listActiveAwaitsForKey).not.toHaveBeenCalled();
  });
});

describe('emitAwaitedEvent — EI-13705: unconditional per-key fire latch', () => {
  it('records the fire latch before claiming await rows so late registration can observe it', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);

    await emitAwaitedEvent({ key: 'git-sync:egressed:abc123', source: 'git-sync' });

    const latchOrder = h.store.recordKeyFire.mock.invocationCallOrder[0];
    const claimOrder = h.store.fireAwaitsForKey.mock.invocationCallOrder[0];
    expect(latchOrder).toBeLessThan(claimOrder);
  });

  it('records the fire latch even when NOTHING was fired and no to[] (waiters:0, the case that previously left zero trace)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'p2p-git:phase3-open', source: 'su-63834d42', payload: { sha: 'abc' } });
    expect(r.waiters).toBe(0);
    expect(h.store.recordKeyFire).toHaveBeenCalledTimes(1);
    expect(h.store.recordKeyFire).toHaveBeenCalledWith({
      eventKey: 'p2p-git:phase3-open',
      firedBy: 'su-63834d42',
      payload: { sha: 'abc' },
      // WI-10003631: the standing-subscriber read rides the latch statement.
      subscribersFrom: { workspaceId: 'default', targetKind: 'event' },
    });
  });

  it('uses the latch-folded subscriber list instead of a separate read (WI-10003631)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.store.recordKeyFire.mockResolvedValueOnce({
      announcementPending: false,
      provingWaiterPending: false,
      eventSubscribers: [
        { subscriber_id: 'su-sub', delivery_mode: 'full' },
        { subscriber_id: 'su-muted', delivery_mode: 'muted' },
      ],
    });
    h.listEventKeySubscribers.mockClear();
    const r = await emitAwaitedEvent({ key: 'k-folded' });
    expect(h.listEventKeySubscribers).not.toHaveBeenCalled();
    expect(r.eventSubscribers).toBe(1);
    expect(r.notified).toEqual(['su-sub']);
  });

  it('records the fire latch on an ordinary emit that DOES wake waiters (not just the zero-waiter case)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    await emitAwaitedEvent({ key: 'k' });
    expect(h.store.recordKeyFire).toHaveBeenCalledTimes(1);
  });

  it('a fire-latch write failure never breaks the emit (fail-soft, like the announce latch)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.store.recordKeyFire.mockRejectedValueOnce(new Error('db down'));
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.ok).toBe(true);
  });
});

describe('emitAwaitedEvent — event-wait-settlement-2026-10-20 P-004: settle on every proving fire', () => {
  /** Every store function this emit called. The store mock is the engine's whole
   *  database surface, so this list IS the emit's database round trips. */
  function storeCallsOf(): string[] {
    return Object.entries(h.store)
      .filter(([, fn]) => ((fn as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0) > 0)
      .map(([name]) => name)
      .sort();
  }

  it('AUTO-BAR-R-6-P-004: an unannounced proving fire the latch found a waiter for is settled', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: false, provingWaiterPending: true });
    await emitAwaitedEvent({ key: 'release:deployed:abc123', source: 'release-gate' });
    expect(h.store.stampAnnouncementsFired).not.toHaveBeenCalled();
    expect(h.store.settleProvingFire).toHaveBeenCalledTimes(1);
    expect(h.store.settleProvingFire).toHaveBeenCalledWith('release:deployed:abc123', { firedBy: 'release-gate' });
  });

  it('AUTO-BAR-R-21-P-004: an emit nobody waits on makes no database call beyond the fire latch and the await claim', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: false, provingWaiterPending: false });
    await emitAwaitedEvent({ key: 'work-item:done:WI-nobody-waits' });
    expect(storeCallsOf()).toEqual(['fireAwaitsForKey', 'recordKeyFire']);
    expect(h.store.recordKeyFire).toHaveBeenCalledTimes(1);
  });

  it('does not settle twice when the announcement latch already settled this fire', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: true, provingWaiterPending: true });
    h.store.stampAnnouncementsFired.mockResolvedValueOnce(1);
    await emitAwaitedEvent({ key: 'work-item:done:WI-announced' });
    expect(h.store.stampAnnouncementsFired).toHaveBeenCalledTimes(1);
    expect(h.store.settleProvingFire).not.toHaveBeenCalled();
  });

  it.each([
    ['latched nothing (a concurrent emit fired the gate first)', () => h.store.stampAnnouncementsFired.mockResolvedValueOnce(0)],
    ['threw', () => h.store.stampAnnouncementsFired.mockRejectedValueOnce(new Error('lock timeout'))],
  ])('still settles the proving waiters when the announcement stamp %s', async (_label, arrange) => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: true, provingWaiterPending: true });
    arrange();
    const r = await emitAwaitedEvent({ key: 'work-item:done:WI-raced' });
    expect(r.ok).toBe(true);
    expect(h.store.settleProvingFire).toHaveBeenCalledWith('work-item:done:WI-raced', { firedBy: null });
  });

  it('an unknown latch result still settles, leaving the proving check to settleProvingFire', async () => {
    h.store.recordKeyFire.mockRejectedValueOnce(new Error('db down'));
    await emitAwaitedEvent({ key: 'work-item:done:WI-latch-down' });
    expect(h.store.settleProvingFire).toHaveBeenCalledTimes(1);
  });

  it('AUTO-BAR-R-8-P-004: a settlement error never fails the emit, and the fire is still recorded and delivered', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: false, provingWaiterPending: true });
    h.store.settleProvingFire.mockRejectedValueOnce(new Error('settlement exploded'));
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 9, subscriberId: 'su-w', policy: 'wake' })]);
    const r = await emitAwaitedEvent({ key: 'release:deployed:abc123', source: 'release-gate' });
    expect(r.ok).toBe(true);
    expect(h.store.recordKeyFire).toHaveBeenCalledTimes(1);
    expect(h.store.settleProvingFire).toHaveBeenCalledTimes(1);
    // The emit carried on past the throw: the woken waiter's delivery is still queued.
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      awaits: [expect.objectContaining({ id: 9 })],
    }));
  });
});

describe('emitAwaitedEvent — event-wait-settlement-2026-10-20 P-007: the completion fire clears work-item-ref blockers', () => {
  beforeEach(() => {
    autoClear.settleWorkItemDoneFire.mockReset().mockResolvedValue([]);
  });

  it('AUTO-BAR-R-6-P-007: a work-item:done fire the latch found a dependency waiter for runs the clear in the probed workspaces', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({
      announcementPending: false, provingWaiterPending: false, workItemRefWaiterWorkspaces: ['ws-a'],
    });
    await emitAwaitedEvent({ key: 'work-item:done:WI-9007001', source: 'work-items' });
    expect(autoClear.settleWorkItemDoneFire).toHaveBeenCalledTimes(1);
    expect(autoClear.settleWorkItemDoneFire).toHaveBeenCalledWith('work-item:done:WI-9007001', ['ws-a']);
  });

  it('a completion nobody waits on makes no clear call and no database call beyond the fire latch and the await claim', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({
      announcementPending: false, provingWaiterPending: false, workItemRefWaiterWorkspaces: [],
    });
    await emitAwaitedEvent({ key: 'work-item:done:WI-9007002' });
    expect(autoClear.settleWorkItemDoneFire).not.toHaveBeenCalled();
    const storeCalls = Object.entries(h.store)
      .filter(([, fn]) => ((fn as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0) > 0)
      .map(([name]) => name)
      .sort();
    expect(storeCalls).toEqual(['fireAwaitsForKey', 'recordKeyFire']);
  });

  it('an unknown latch result still runs the clear, leaving the waiter read to it', async () => {
    h.store.recordKeyFire.mockRejectedValueOnce(new Error('db down'));
    await emitAwaitedEvent({ key: 'work-item:done:WI-9007003' });
    expect(autoClear.settleWorkItemDoneFire).toHaveBeenCalledWith('work-item:done:WI-9007003', undefined);
  });

  it('a clear that throws never fails the emit', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({
      announcementPending: false, provingWaiterPending: false, workItemRefWaiterWorkspaces: ['ws-a'],
    });
    autoClear.settleWorkItemDoneFire.mockRejectedValueOnce(new Error('lock timeout'));
    const r = await emitAwaitedEvent({ key: 'work-item:done:WI-9007004' });
    expect(r.ok).toBe(true);
    expect(autoClear.settleWorkItemDoneFire).toHaveBeenCalledTimes(1);
  });

  it('never runs the clear for a key that is not a completion fire', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: false, provingWaiterPending: true });
    await emitAwaitedEvent({ key: 'release:deployed:abc123' });
    h.store.recordKeyFire.mockRejectedValueOnce(new Error('db down'));
    await emitAwaitedEvent({ key: 'work-item:claimable' });
    expect(autoClear.settleWorkItemDoneFire).not.toHaveBeenCalled();
  });

  it('never runs the clear when the latch answered without a probe (the key names no single work-item id)', async () => {
    h.store.recordKeyFire.mockResolvedValueOnce({ announcementPending: false, provingWaiterPending: false });
    await emitAwaitedEvent({ key: 'work-item:done:WI-nobody-waits' });
    expect(autoClear.settleWorkItemDoneFire).not.toHaveBeenCalled();
  });
});

describe('emitAwaitedEvent — EI-12457: sibling-await cancellation on fire', () => {
  beforeEach(() => {
    h.store.listActiveAwaitsForKey.mockReset().mockResolvedValue([]);
    h.store.cancelAwaitsByIds.mockReset().mockResolvedValue(0);
  });

  it('cancels a woken subscriber\'s sibling await that is BOUND to the candidate that just resolved', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) =>
      key === 'green-checkpoint:red:papercusp'
        ? [awaitRow({ id: 77, subscriberId: 'su-a', payloadFilter: { sha: { startsWith: 'deadbe' } } })]
        : [],
    );
    await emitAwaitedEvent({
      key: 'release:green:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['green-checkpoint:red', 'green-checkpoint:red:papercusp'],
    });
    expect(h.store.cancelAwaitsByIds).toHaveBeenCalledWith([77]);
  });

  it('cancels an unbound sibling from the SAME registration group (subscriber + note)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake', note: 'checkpoint:await [papercusp]' }),
    ]);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 44252, subscriberId: 'su-a', payloadFilter: null, note: 'checkpoint:await [papercusp]' }),
    ]);
    await emitAwaitedEvent({
      key: 'green-checkpoint:red:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['release:green', 'release:green:papercusp'],
    });
    expect(h.store.cancelAwaitsByIds).toHaveBeenCalledWith([44252]);
  });

  // EI-19463163337467894 remains protected: an independently armed unbound wait means
  // "wake me on the next verdict, any candidate" and must not be consumed by this group.
  it('leaves an unrelated unbound sibling armed when its registration note differs', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake', note: 'checkpoint:await [papercusp]' }),
    ]);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 44253, subscriberId: 'su-a', payloadFilter: null, note: 'separate gate monitor' }),
    ]);
    await emitAwaitedEvent({
      key: 'green-checkpoint:red:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['release:green', 'release:green:papercusp'],
    });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('leaves a sibling await bound to a DIFFERENT candidate armed', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 9, subscriberId: 'su-a', payloadFilter: { sha: { startsWith: 'cafe00' } } }),
    ]);
    await emitAwaitedEvent({
      key: 'green-checkpoint:red:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['release:green:papercusp'],
    });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('never touches a PEER\'s sibling await (only subscribers this emit actually woke)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 8, subscriberId: 'su-PEER', payloadFilter: { sha: { startsWith: 'deadbe' } } }),
    ]);
    await emitAwaitedEvent({
      key: 'green-checkpoint:red:papercusp',
      payload: { sha: 'deadbeef', pipeline: 'papercusp' },
      cancelSiblingKeysFor: ['release:green:papercusp'],
    });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('no cancelSiblingKeysFor passed → sibling cancellation is never invoked', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    await emitAwaitedEvent({ key: 'k' });
    expect(h.store.listActiveAwaitsForKey).not.toHaveBeenCalled();
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('cancelSiblingKeysFor passed but nobody was woken → nothing to retire', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    await emitAwaitedEvent({ key: 'green-checkpoint:red:papercusp', cancelSiblingKeysFor: ['release:green'] });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('a sibling-cancellation failure never breaks the emit (fail-soft)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([awaitRow({ id: 1, subscriberId: 'su-a', policy: 'wake' })]);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 3, subscriberId: 'su-a', payloadFilter: { sha: { startsWith: 'dead' } } }),
    ]);
    h.store.cancelAwaitsByIds.mockRejectedValueOnce(new Error('db down'));
    const r = await emitAwaitedEvent({ key: 'k', payload: { sha: 'deadbeef' }, cancelSiblingKeysFor: ['k-red'] });
    expect(r.ok).toBe(true);
    expect(r.woken).toBe(1);
  });
});

describe('cancelSupersededCandidateAwaits (WI-4957 / EI-20391462658650094: a replaced candidate wakes its bound waiter)', () => {
  let previousAutoPump = true;

  beforeEach(() => {
    h.store.listActiveAwaitsForKey.mockReset();
    h.store.cancelAwaitsByIds.mockReset().mockResolvedValue(0);
    previousAutoPump = setAutoPumpEnabledForTests(false);
  });

  afterEach(() => {
    setAutoPumpEnabledForTests(previousAutoPump);
  });

  it('claims and durably wakes only matching once wake rows — unbound, different-candidate, notify, and standing rows stay untouched', async () => {
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) => {
      if (key !== 'release:green:papercusp') return [];
      return [
        // Bound to the stale candidate — must be claimed and woken.
        awaitRow({ id: 11, subscriberId: 'su-bound-stale', once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'deadbeef' } } }),
        // Bound to the stale candidate but notify-only — must be left alone.
        awaitRow({ id: 12, subscriberId: 'su-notify', once: true, policy: 'notify', payloadFilter: { sha: { startsWith: 'deadbeef' } } }),
        // Bound to the stale candidate but standing — must be left alone.
        awaitRow({ id: 13, subscriberId: 'su-standing', once: false, policy: 'wake', payloadFilter: { sha: { startsWith: 'deadbeef' } } }),
        // Bound to a DIFFERENT candidate — must be left alone.
        awaitRow({ id: 14, subscriberId: 'su-bound-other', once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'cafef00d' } } }),
        // Unbound (global "next verdict, any candidate") — must be left alone; the fresh
        // run's verdict is exactly what it's still waiting for.
        awaitRow({ id: 15, subscriberId: 'su-global', once: true, policy: 'wake', payloadFilter: null }),
      ];
    });
    h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([
      awaitRow({ id: 11, subscriberId: 'su-bound-stale', once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'deadbeef' } } }),
    ]);

    const result = await cancelSupersededCandidateAwaits({
      keys: ['release:green', 'release:green:papercusp', 'green-checkpoint:red', 'green-checkpoint:red:papercusp'],
      staleCandidateSha: 'deadbeef1234',
    });

    expect(result).toEqual({ cancelled: 0, ids: [11] });
    expect(h.store.claimSpecificOnceAwaits).toHaveBeenCalledWith([11]);
    expect(h.store.insertDeliveries).toHaveBeenCalledWith({
      awaits: [expect.objectContaining({ id: 11, subscriberId: 'su-bound-stale' })],
      payload: { reason: 'candidate-replaced', sha: 'deadbeef1234' },
      summary: expect.stringContaining('candidate replacement'),
      source: 'release:checkpoint-run:candidate-replaced',
    });
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('durably wakes a candidate-bound inconclusive checkpoint await', async () => {
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) =>
      key === 'green-checkpoint:inconclusive:papercusp'
        ? [awaitRow({ id: 22, once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'deadbeef' } } })]
        : [],
    );
    h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([awaitRow({ id: 22, once: true, policy: 'wake' })]);

    const result = await cancelSupersededCandidateAwaits({
      keys: ['green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:papercusp'],
      staleCandidateSha: 'deadbeef1234',
    });

    expect(result).toEqual({ cancelled: 0, ids: [22] });
    expect(h.store.claimSpecificOnceAwaits).toHaveBeenCalledWith([22]);
    expect(h.store.insertDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      awaits: [expect.objectContaining({ id: 22 })],
      payload: { reason: 'candidate-replaced', sha: 'deadbeef1234' },
    }));
  });

  it('nothing eligible bound to the stale candidate → no claim or delivery', async () => {
    h.store.listActiveAwaitsForKey.mockResolvedValue([awaitRow({ id: 1, payloadFilter: null })]);
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green'], staleCandidateSha: 'deadbeef' });
    expect(result).toEqual({ cancelled: 0, ids: [] });
    expect(h.store.claimSpecificOnceAwaits).not.toHaveBeenCalled();
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
    expect(h.store.cancelAwaitsByIds).not.toHaveBeenCalled();
  });

  it('a lookup failure on one key degrades to skipping that key, never throws', async () => {
    h.store.listActiveAwaitsForKey.mockImplementation(async (key: string) => {
      if (key === 'release:green') throw new Error('db blip');
      return [awaitRow({ id: 5, once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'abc123' } } })];
    });
    h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([awaitRow({ id: 5, once: true, policy: 'wake' })]);
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green', 'release:green:papercusp'], staleCandidateSha: 'abc123456' });
    expect(result).toEqual({ cancelled: 0, ids: [5] });
    expect(h.store.insertDeliveries).toHaveBeenCalledTimes(1);
  });

  it('an atomic claim failure degrades to {cancelled:0}, never throws', async () => {
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 5, once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'abc123' } } }),
    ]);
    h.store.claimSpecificOnceAwaits.mockRejectedValueOnce(new Error('db down'));
    const result = await cancelSupersededCandidateAwaits({ keys: ['release:green'], staleCandidateSha: 'abc123456' });
    expect(result).toEqual({ cancelled: 0, ids: [] });
    expect(h.store.insertDeliveries).not.toHaveBeenCalled();
  });

  it('kicks the durable delivery pump after enqueueing a candidate-replaced wake', async () => {
    setAutoPumpEnabledForTests(true);
    h.store.listActiveAwaitsForKey.mockResolvedValue([
      awaitRow({ id: 7, once: true, policy: 'wake', payloadFilter: { sha: { startsWith: 'abc123' } } }),
    ]);
    h.store.claimSpecificOnceAwaits.mockResolvedValueOnce([awaitRow({ id: 7, once: true, policy: 'wake' })]);

    await cancelSupersededCandidateAwaits({ keys: ['release:green'], staleCandidateSha: 'abc123456' });
    await vi.waitFor(() => expect(h.store.claimDueDeliveries).toHaveBeenCalled());
  });
});

describe('emitAwaitedEvent — WI-4014 Part 2: standing event-key inject subscribers', () => {
  it('folds standing event-key subscribers into the notify audience and reports eventSubscribers', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-ev-1', delivery_mode: 'full' },
      { subscriber_id: 'su-ev-2', delivery_mode: 'digest' },
    ]);
    const r = await emitAwaitedEvent({ key: 'lock:grant:t1' });
    expect(h.listEventKeySubscribers).toHaveBeenCalledWith('lock:grant:t1');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to.sort()).toEqual(['su-ev-1', 'su-ev-2']);
    expect(r.notified.sort()).toEqual(['su-ev-1', 'su-ev-2']);
    expect(r.eventSubscribers).toBe(2);
  });

  it('excludes delivery_mode:"muted" event-key subscribers from the notify send', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-live', delivery_mode: 'full' },
      { subscriber_id: 'su-muted', delivery_mode: 'muted' },
    ]);
    const r = await emitAwaitedEvent({ key: 'k' });
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to).toEqual(['su-live']);
    expect(r.notified).toEqual(['su-live']);
    // eventSubscribers counts only the ones actually folded in (muted excluded).
    expect(r.eventSubscribers).toBe(1);
  });

  it('an event-key subscriber already WOKEN (a wake-policy await on the same key) is not double-notified', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-both', policy: 'wake' }),
    ]);
    h.listEventKeySubscribers.mockResolvedValueOnce([
      { subscriber_id: 'su-both', delivery_mode: 'full' }, // also has a standing inject sub
      { subscriber_id: 'su-inject-only', delivery_mode: 'full' },
    ]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.woken).toBe(1);
    expect(r.notified).toEqual(['su-inject-only']); // su-both excluded — already woken
    const sendArgs = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }];
    expect(sendArgs[1].to).toEqual(['su-inject-only']);
  });

  it('a subscriber lookup error is fail-soft — the emit still succeeds (wake path unaffected)', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([
      awaitRow({ id: 1, subscriberId: 'su-w', policy: 'wake' }),
    ]);
    h.listEventKeySubscribers.mockRejectedValueOnce(new Error('store down'));
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.ok).toBe(true);
    expect(r.woken).toBe(1); // the wake half is untouched by a notify-side lookup failure
    expect(r.eventSubscribers).toBe(0);
  });

  it('no event-key subscribers and nothing else → eventSubscribers:0, no message', async () => {
    h.store.fireAwaitsForKey.mockResolvedValueOnce([]);
    h.listEventKeySubscribers.mockResolvedValueOnce([]);
    const r = await emitAwaitedEvent({ key: 'k' });
    expect(r.eventSubscribers).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('pumpWakeDeliveries — pacing (D-007)', () => {
  it('an overdue bulk queue after restart cannot bypass execution admission; a directed wake stays immediate', async () => {
    process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK = '250';
    const bulk = Array.from({ length: 200 }, (_, i) => workRow({ id: 10_000 + i, subscriberId: `bulk-${i}`, source: 'resume-fleet',
      payload: { __papercuspWakeFanout: { workspaceId: 'ws-test', notBeforeMs: 1 } } }));
    const directed = workRow({ id: 12_000, subscriberId: 'owner-directed', urgent: true });
    h.store.claimDueDeliveries.mockResolvedValueOnce([...bulk, directed]);
    let tokens = 5;
    h.admitWakeFanout.mockImplementation(async () => tokens-- > 0 ? 0 : 6_000);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(6);
    expect(h.executeWake).toHaveBeenCalledWith(expect.objectContaining({ subscriberId: 'owner-directed' }), expect.anything());
    expect(stats.deferred).toBe(195);
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledTimes(195);
  });

  it('a loop or unpaced directed wake coalesced with a deferred bulk wake bypasses its execution bucket', async () => {
    const paced = workRow({ id: 13_000, subscriberId: 'loop-owner', payload: { __papercuspWakeFanout: { workspaceId: 'ws-test', notBeforeMs: 1 } } });
    const loop = workRow({ id: 13_001, subscriberId: 'loop-owner', source: 'loop:rt-test' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([paced, loop]);
    await pumpWakeDeliveries('ws-test');
    expect(h.admitWakeFanout).not.toHaveBeenCalled();
    expect(h.executeWake).toHaveBeenCalledTimes(1);
  });

  it('settles claimed deliveries for any cancelled await before grouping or execution', async () => {
    const cancelled = workRow({
      id: 120,
      subscriberId: 'su-cancelled',
      eventKey: 'coord:inbox-wake:su-cancelled',
    });
    const live = workRow({ id: 121, subscriberId: 'su-live', eventKey: 'release:green:papercusp' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([cancelled, live]);
    h.store.settleCancelledAwaitDeliveries.mockResolvedValueOnce([cancelled.id]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.store.settleCancelledAwaitDeliveries).toHaveBeenCalledWith([cancelled, live]);
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.executeWake).toHaveBeenCalledWith(expect.objectContaining({ id: live.id }), expect.anything());
    expect(h.executeWake).not.toHaveBeenCalledWith(expect.objectContaining({ id: cancelled.id }), expect.anything());
    expect(stats).toMatchObject({ claimed: 2, cancelled: 1, delivered: 1 });
  });

  it('reopens ordinary event deliveries but not terminal timeout deliveries after detached death', async () => {
    const first = workRow({
      id: 90,
      subscriberId: 'su-a',
      eventKey: 'release:green:papercusp',
      source: 'green-checkpoint',
      attempts: 2,
      createdAt: new Date(1000).toISOString(),
    });
    const timeoutSibling = workRow({
      id: 91,
      subscriberId: 'su-a',
      eventKey: 'green-checkpoint:red:papercusp',
      payload: { timeout: true },
      source: null,
      attempts: 2,
      createdAt: new Date(2000).toISOString(),
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([first, timeoutSibling]);
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        // Reproduce the fast-exit race: the child dies before the pump finishes
        // writing delivered/coalesced state.
        deps.onResumeTurnExit?.(d, {
          exitCode: 0,
          signal: null,
          stdoutTail: '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}',
          stderrTail: '',
          outputProtocol: 'codex-jsonl',
        });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    const stats = await pumpWakeDeliveries('ws-test');

    expect(stats.delivered).toBe(1);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(91, 'resume-headless', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([90], 91);
    await vi.waitFor(() => {
      expect(h.store.reopenDeliveredAfterResumeDeath).toHaveBeenCalledTimes(1);
    });
    expect(h.store.reopenDeliveredAfterResumeDeath).toHaveBeenCalledWith(
      expect.objectContaining({ id: 90, error: 'resume-turn-death:malformed_output', maxAttempts: 8 }),
    );
    expect(h.store.reopenDeliveredAfterResumeDeath).not.toHaveBeenCalledWith(expect.objectContaining({ id: 91 }));
    expect(h.store.markDeliveryDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.reopenDeliveredAfterResumeDeath.mock.invocationCallOrder[0],
    );
  });

  it('notifies the await owner when detached resume deaths exhaust the delivery budget', async () => {
    const dead = workRow({
      id: 94,
      subscriberId: 'su-owner',
      eventKey: 'detector:done',
      summary: 'The detector condition is true.',
      attempts: 8,
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([dead]);
    h.store.reopenDeliveredAfterResumeDeath.mockResolvedValueOnce('dead');
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        deps.onResumeTurnExit?.(d, {
          exitCode: 1,
          signal: null,
          stdoutTail: '',
          stderrTail: 'agent crash',
        });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    await pumpWakeDeliveries('ws-test');

    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
    const [, message] = h.sendMessage.mock.calls[0] as unknown as [
      unknown,
      { to: string[]; summary: string; body: string; extra: Record<string, unknown> },
    ];
    expect(message.to).toEqual(['su-owner']);
    expect(message.summary).toContain('delivery #94');
    expect(message.body).toContain("event 'detector:done'");
    expect(message.body).toContain('terminal status \'dead\'');
    expect(message.extra).toMatchObject({
      event_key: 'detector:done',
      wake_delivery_id: 94,
      terminal_status: 'dead',
      attempts: 8,
      last_error: 'resume-turn-death:agent_crash',
    });
  });

  it('drops the terminal delivery and notifies the fleet when resume detects a poisoned session', async () => {
    const poisoned = workRow({ id: 95, subscriberId: 'su-owner', eventKey: 'inbox:wake', attempts: 1 });
    h.store.claimDueDeliveries.mockResolvedValueOnce([poisoned]);
    h.fetchPresenceFleet.mockResolvedValueOnce(new Map([['su-owner', { fleetSlug: 'drain-fleet', fleetRole: 'member' }]]));
    h.executeWake.mockImplementationOnce(async (d, deps) => {
      deps.onResumeTurnExit?.(
        d,
        {
          exitCode: 1,
          signal: null,
          stdoutTail: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
          stderrTail: '',
        },
        {
          advSessionId: 77,
          ownerId: 'su-owner',
          sessionId: 'native-77',
          startedAt: '2026-09-24T10:00:00.123Z',
          workspaceId: 'ws-test',
          agent: 'claude',
          transcriptPath: '/tmp/native-77.jsonl',
          poisoned: true,
          poisonReason: 'three consecutive unavailable tool references',
        },
      );
      return { kind: 'delivered', channel: 'resume-headless' };
    });

    await pumpWakeDeliveries('ws-test');

    await vi.waitFor(() => expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(
      95,
      'three consecutive unavailable tool references',
    ));
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
    expect(h.store.reopenDeliveredAfterResumeDeath).not.toHaveBeenCalled();
    const sendCall = h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; body: string; extra: Record<string, unknown> }];
    const message = sendCall?.[1];
    expect(message.to).toEqual(['@fleet:drain-fleet', 'su-owner']);
    expect(message.summary).toContain('quarantined');
    expect(message.body).toContain('work-item claims');
    expect(message.extra).toMatchObject({ adv_session_id: 77, terminal_status: 'poisoned' });
  });

  it('does not reopen a timeout-only delivery after detached death', async () => {
    const timeout = workRow({ id: 93, payload: { timeout: true }, attempts: 2 });
    h.store.claimDueDeliveries.mockResolvedValueOnce([timeout]);
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        deps.onResumeTurnExit?.(d, { exitCode: 1, signal: null, stdoutTail: '', stderrTail: 'crashed' });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    await pumpWakeDeliveries('ws-test');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(93, 'resume-headless', 1);
    expect(h.store.reopenDeliveredAfterResumeDeath).not.toHaveBeenCalled();
  });

  it('does not reopen loop deliveries because their circuit handler owns retry semantics', async () => {
    const loop = workRow({ id: 92, subscriberId: 'su-loop', source: 'loop:r-1', attempts: 1 });
    h.store.claimDueDeliveries.mockResolvedValueOnce([loop]);
    h.executeWake.mockImplementationOnce(
      async (d: DeliveryWork, deps: { onResumeTurnExit?: (d: DeliveryWork, exit: unknown) => void }) => {
        deps.onResumeTurnExit?.(d, { exitCode: 1, signal: null, stdoutTail: '', stderrTail: 'crashed' });
        return { kind: 'delivered', channel: 'resume-headless' };
      },
    );

    await pumpWakeDeliveries('ws-test');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.store.reopenDeliveredAfterResumeDeath).not.toHaveBeenCalled();
  });

  it('per-subscriber coalesce: multiple due wakes for one agent fold into ONE wake', async () => {
    // Two events fire for su-a → ONE coalesced wake (the newest is the headline; the older
    // settles as coalesced, no second turn) — the unify-watch-primitive gap closing.
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a', eventKey: 'k1', createdAt: new Date(1000).toISOString() }),
      workRow({ id: 11, subscriberId: 'su-a', eventKey: 'k2', createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    // ONE turn for both events (not two).
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    // The headline (newest, id 11) carries the union summary listing both keys.
    const work = (h.executeWake.mock.calls[0] as unknown as [{ summary: string; coalescedCount: number }])[0];
    expect(work.summary).toContain('k1');
    expect(work.summary).toContain('k2');
    // Headline delivered with coalescedCount=2; the sibling settles as coalesced (no turn).
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(11, 'resume', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([10], 11);
    expect(h.store.markDeliveryDeferred).not.toHaveBeenCalled();
    expect(stats.delivered).toBe(1);
    expect(stats.coalesced).toBe(1);
    expect(stats.deferred).toBe(0);
  });

  it('coalesced timeout-only wakes say awaits expired, not that every event fired', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 101,
        eventKey: 'release:green:papercusp',
        payload: { timeout: true },
        createdAt: new Date(1000).toISOString(),
      }),
      workRow({
        id: 102,
        eventKey: 'green-checkpoint:red:papercusp',
        payload: { timeout: true },
        createdAt: new Date(1001).toISOString(),
      }),
      workRow({
        id: 103,
        eventKey: 'green-checkpoint:inconclusive:papercusp',
        payload: { timeout: true },
        createdAt: new Date(1002).toISOString(),
      }),
    ]);

    await pumpWakeDeliveries('ws-test');

    expect(h.executeWake).toHaveBeenCalledTimes(1);
    const coalesced = (h.executeWake.mock.calls[0] as unknown as [{ summary: string; payload: unknown }])[0];
    expect(coalesced.summary).toContain('3 await deadlines expired while you slept');
    expect(coalesced.summary).not.toContain('events fired while you slept');
    expect(coalesced.summary).toContain('release:green:papercusp');
    expect(coalesced.summary).toContain('green-checkpoint:red:papercusp');
    expect(coalesced.summary).toContain('green-checkpoint:inconclusive:papercusp');
    expect(coalesced.payload).toMatchObject({ coalesced: true, count: 3, eventCount: 0, timeoutCount: 3 });
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(103, 'resume', 3);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([101, 102], 103);
  });

  it('mixed event and timeout wakes label each outcome separately', () => {
    const coalesced = coalesceDeliveries([
      workRow({ id: 104, eventKey: 'release:green:papercusp', payload: { ok: true }, createdAt: new Date(1000).toISOString() }),
      workRow({ id: 105, eventKey: 'green-checkpoint:red:papercusp', payload: { timeout: true }, createdAt: new Date(1001).toISOString() }),
    ]);

    expect(coalesced.summary).toContain('1 event fired while you slept: release:green:papercusp');
    expect(coalesced.summary).toContain('1 await deadline expired while you slept: green-checkpoint:red:papercusp');
    expect(coalesced.summary).not.toContain('2 events fired while you slept');
    expect(coalesced.payload).toMatchObject({ coalesced: true, count: 2, eventCount: 1, timeoutCount: 1 });
  });

  it('preserves each folded delivery timestamp for delivery-time lifecycle checks', () => {
    const older = workRow({
      id: 106,
      eventKey: 'loop:rt-old',
      payload: { harness: 'papercusp', wakeCount: 3, routineId: 'rt-old' },
      createdAt: new Date(1000).toISOString(),
    });
    const headline = workRow({
      id: 107,
      eventKey: 'lock:grant:t-2',
      payload: { ok: true },
      createdAt: new Date(2000).toISOString(),
    });

    const coalesced = coalesceDeliveries([older, headline]);
    expect(coalesced.payload).toMatchObject({
      events: [
        { delivery_id: 106, createdAt: older.createdAt, payload: older.payload },
        { delivery_id: 107, createdAt: headline.createdAt, payload: headline.payload },
      ],
      latest: {
        delivery_id: 107,
        createdAt: headline.createdAt,
      },
    });
  });

  it('per-subscriber min_sleep floor: a wake inside the window defers until the floor allows it', async () => {
    // su-a was woken 10s ago; a min_sleep=60 watch fires now → defer (within floor), no turn.
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 10_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 20, subscriberId: 'su-a', minSleepSec: 60 }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(20, expect.any(Number));
    expect(stats.deferred).toBe(1);
    expect(stats.delivered).toBe(0);
  });

  it('GAP 2: a co-incident floor-less one-shot does NOT nullify a standing min_sleep floor', async () => {
    // su-a woke 10s ago. Two deliveries land THIS tick for it: a standing watch
    // with min_sleep=60 AND a floor-less one-shot grant (min_sleep=0). The group
    // floor must be the standing 60s — NOT 0 — so the whole group DEFERS (still
    // inside the 60s window). The bug: `Math.min(60, 0)` → 0 disabled the floor,
    // so the coincident one-shot's tick woke the standing watch early (cost
    // discipline defeated). Neither is urgent.
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 10_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 70, subscriberId: 'su-a', minSleepSec: 60, createdAt: new Date(1000).toISOString() }),
      workRow({ id: 71, subscriberId: 'su-a', minSleepSec: 0, createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    // The standing floor holds: no turn, the whole group defers.
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(70, expect.any(Number));
    expect(h.store.markDeliveryDeferred).toHaveBeenCalledWith(71, expect.any(Number));
    expect(stats.deferred).toBe(2);
    expect(stats.delivered).toBe(0);
  });

  it('GAP 2: past the floor window, the standing + one-shot group wakes (coalesced, one turn)', async () => {
    // Same shape but su-a last woke 120s ago — beyond the 60s floor → it wakes,
    // and the two due deliveries coalesce into ONE turn (the fix preserves the
    // positive floor without breaking the normal wake-when-allowed path).
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 120_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 72, subscriberId: 'su-a', minSleepSec: 60, createdAt: new Date(1000).toISOString() }),
      workRow({ id: 73, subscriberId: 'su-a', minSleepSec: 0, createdAt: new Date(2000).toISOString() }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
    expect(stats.deferred).toBe(0);
  });

  it('urgent bypasses the floor: an urgent wake fires even inside the min_sleep window', async () => {
    h.store.lastWokenAtForSubscribers.mockResolvedValueOnce(new Map([['su-a', Date.now() - 1_000]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 21, subscriberId: 'su-a', minSleepSec: 60, urgent: true }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
  });

  it('resume cap: past the per-tick cap, further wakes defer to the next tick', async () => {
    process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK = '1';
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a' }),
      workRow({ id: 11, subscriberId: 'su-b' }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
    expect(stats.deferred).toBe(1);
  });

  it('fleet-governor denial defers the wake (paced re-admission, fail-open on error)', async () => {
    h.admitSpawn.mockResolvedValueOnce({ admitted: false });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10 })]);
    const denied = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(denied.deferred).toBe(1);

    // A governor-store error must never strand the wake (fail-open).
    h.admitSpawn.mockRejectedValueOnce(new Error('governor store down'));
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 11 })]);
    const open = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(open.delivered).toBe(1);
  });

  it('park → parked + ONE inbox nudge on the first attempt only', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10, attempts: 1 })]);
    await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryParked).toHaveBeenCalledWith(10, 'alive, no pty', expect.any(Number));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);

    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 10, attempts: 2 })]);
    await pumpWakeDeliveries('ws-test');
    expect(h.sendMessage).toHaveBeenCalledTimes(1); // no second nudge
  });

  it('timeout wake receiving an early psu-host accepted ACK stays durable and parks for retry', async () => {
    const timedOut = awaitRow({
      id: 401,
      subscriberId: 'su-timeout-host',
      eventKey: 'completion:await:timeout',
      firedReason: 'timeout',
      firedAt: new Date(10_000).toISOString(),
      expiresTs: new Date(9_000).toISOString(),
    });
    const delivery = workRow({
      id: 402,
      awaitId: timedOut.id,
      subscriberId: timedOut.subscriberId,
      eventKey: timedOut.eventKey,
      payload: { timeout: true, guidance: 'reconcile' },
      attempts: 1,
    });
    h.store.fireTimedOutAwaits.mockResolvedValueOnce([timedOut]);
    h.store.claimDueDeliveries.mockResolvedValueOnce([delivery]);
    h.executeWake.mockResolvedValueOnce({
      kind: 'park',
      reason: 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
    });

    await sweepOnce('ws-test');

    expect(h.store.insertDeliveries).toHaveBeenCalledWith({
      awaits: [timedOut],
      payload: { timeout: true, guidance: expect.any(String) },
      summary: expect.any(String),
    });
    expect(h.executeWake).toHaveBeenCalledWith(expect.objectContaining({
      id: delivery.id,
      awaitId: timedOut.id,
      payload: { timeout: true, guidance: 'reconcile' },
    }), expect.anything());
    expect(h.store.markDeliveryParked).toHaveBeenCalledWith(
      delivery.id,
      'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
      45_000,
    );
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(delivery.id, expect.anything(), expect.anything());
  });

  it('caps repeated park retries and degrades the wake to inbox delivery', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 15, subscriberId: 'su-park-cap', attempts: 8 }),
    ]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.degradeToInboxOrDrop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 15 }),
      expect.stringContaining('remained parked and exhausted 8 attempts'),
      expect.any(Function),
    );
    expect(h.store.markDeliveryParked).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(15, 'inbox', 1);
    expect(stats.delivered).toBe(0);
    expect(stats.inbox).toBe(1);
    expect(stats.parked).toBe(0);
  });

  it.each([
    ['cold', 'park'], ['cold', 'error'], ['warm', 'park'], ['warm', 'error'],
  ] as const)('EI-25947345466684593: exhausted %s loop %s is a visible drop, never an inbox success', async (carry, kind) => {
    h.executeWake.mockResolvedValueOnce(kind === 'park'
      ? { kind, reason: 'alive, no injectable turn' }
      : { kind, error: 'turn dispatch failed' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({
      id: 81,
      attempts: 8,
      source: 'loop:rt-loop-cap',
      payload: { carry, wakeCount: 165, harness: 'papercusp', routineId: 'rt-loop-cap' },
    })]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.executeWake).toHaveBeenCalledOnce();
    expect(h.degradeToInboxOrDrop).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalled();
    expect(h.store.markDeliveryFailed).not.toHaveBeenCalled();
    expect(h.store.markDeliveryParked).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(81, expect.stringContaining('loop turn'));
    expect(stats).toMatchObject({ claimed: 1, dropped: 1, delivered: 0, inbox: 0, parked: 0 });
  });

  it.each(['park', 'error'] as const)(
    'EI-25947345466684593: an older coalesced loop marker prevents exhausted %s inbox fallback',
    async (kind) => {
      h.executeWake.mockResolvedValueOnce(kind === 'park'
        ? { kind, reason: 'no injectable turn' }
        : { kind, error: 'turn dispatch failed' });
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({ id: 82, createdAt: new Date(1000).toISOString(),
          payload: { wakeCount: 165, harness: 'papercusp', routineId: 'rt-loop-cap' } }),
        workRow({ id: 83, attempts: 9, createdAt: new Date(2000).toISOString(), payload: { msg_id: 'm-newer' } }),
      ]);

      const stats = await pumpWakeDeliveries('ws-test');

      expect(h.executeWake).toHaveBeenCalledOnce();
      expect(h.degradeToInboxOrDrop).not.toHaveBeenCalled();
      expect(h.store.markDeliveryDelivered).not.toHaveBeenCalled();
      expect(h.store.markDeliveriesCoalesced).not.toHaveBeenCalled();
      expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(82, expect.stringContaining('loop turn'));
      expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(83, expect.stringContaining('loop turn'));
      expect(stats).toMatchObject({ claimed: 2, dropped: 2, delivered: 0, inbox: 0, parked: 0 });
    },
  );

  it.each(['ordinary', 'cold', 'warm'] as const)(
    'keeps an accepted pending %s psu-host delivery parked at the retry cap until late host settlement',
    async (carry) => {
    const pendingReason =
      'psu-host pending-delivery-id: delivery accepted before turn-start proof; retry remains durable';
    const pendingDelivery: Partial<DeliveryWork> = {
      id: 17,
      subscriberId: 'su-pending-host-cap',
      lastError: pendingReason,
      ...(carry === 'ordinary' ? {} : {
        source: 'loop:rt-loop-pending-host',
        payload: { carry, wakeCount: 165, harness: 'papercusp', routineId: 'rt-loop-pending-host' },
      }),
    };
    h.executeWake
      .mockResolvedValueOnce({ kind: 'park', reason: pendingReason, hostCommitPending: true })
      .mockResolvedValueOnce({ kind: 'park', reason: pendingReason, hostCommitPending: true })
      .mockResolvedValueOnce({ kind: 'delivered', channel: 'psu-socket-inject' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ ...pendingDelivery, attempts: 1 }),
    ]);

    const first = await pumpWakeDeliveries('ws-test');

    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ ...pendingDelivery, attempts: 8 }),
    ]);
    const pending = await pumpWakeDeliveries('ws-test');

    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ ...pendingDelivery, attempts: 9 }),
    ]);
    const settled = await pumpWakeDeliveries('ws-test');

    // The host pipeline settles after the attempt-cap boundary. The next retry
    // observes its duplicate-delivery-id terminal receipt and books the original
    // delivery as a host injection, with no preceding inbox fallback.
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.degradeToInboxOrDrop).not.toHaveBeenCalled();
    expect(h.store.markDeliveryParked).toHaveBeenCalledWith(17, pendingReason, 45_000);
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(17, 'inbox', 1);
    expect(first.parked).toBe(1);
    expect(first.inbox).toBe(0);
    expect(pending.parked).toBe(1);
    expect(pending.inbox).toBe(0);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(17, 'psu-socket-inject', 1);
    expect(h.degradeToInboxOrDrop).not.toHaveBeenCalled();
    expect(settled.delivered).toBe(1);
    expect(settled.inbox).toBe(0);
    },
  );

  it('settles a park-exhausted wake as dropped when the inbox fallback fails', async () => {
    h.degradeToInboxOrDrop.mockResolvedValueOnce({
      kind: 'drop',
      reason: 'park exhausted — inbox unavailable',
    });
    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: 'alive, no pty' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 16, subscriberId: 'su-park-drop', attempts: 8 }),
    ]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.store.markDeliveryParked).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(16, 'park exhausted — inbox unavailable');
    expect(stats.dropped).toBe(1);
    expect(stats.parked).toBe(0);
  });

  it('P-001: a degraded delivered/inbox outcome records channel=\'inbox\' on the delivery row, not a drop', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'inbox' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 30, subscriberId: 'su-a' })]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(30, 'inbox', 1);
    expect(h.store.markDeliveryDropped).not.toHaveBeenCalled();
    expect(stats.delivered).toBe(0);
    expect(stats.inbox).toBe(1);
    expect(stats.dropped).toBe(0);
  });

  it('drop and error settle visibly (dropped / failed-with-backoff)', async () => {
    h.executeWake
      .mockResolvedValueOnce({ kind: 'drop', reason: 'dead waiter' })
      .mockResolvedValueOnce({ kind: 'error', error: 'spawn failed' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 10, subscriberId: 'su-a' }),
      workRow({ id: 11, subscriberId: 'su-b' }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryDropped).toHaveBeenCalledWith(10, 'dead waiter');
    expect(h.store.markDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, error: 'spawn failed' }),
    );
    expect(stats.dropped).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('EI-16559: an error that is about to exhaust MAX_ATTEMPTS degrades to inbox instead of dying silently', async () => {
    // attempts=8 === MAX_ATTEMPTS: markDeliveryFailed would otherwise finalize this
    // as 'dead' with no trace ever reaching the subscriber (the exact stranding the
    // bug report hit) — the fallback must intercept BEFORE that happens.
    h.executeWake.mockResolvedValueOnce({ kind: 'error', error: 'spawn failed again' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 12, subscriberId: 'su-c', attempts: 8 })]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.degradeToInboxOrDrop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12 }),
      expect.stringContaining('exhausted 8 attempts'),
      expect.any(Function),
    );
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(12, 'inbox', 1);
    expect(h.store.markDeliveryFailed).not.toHaveBeenCalled();
    expect(stats.delivered).toBe(0);
    expect(stats.inbox).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('EI-16559: still under MAX_ATTEMPTS, an error keeps the normal retry-with-backoff path (no inbox fallback)', async () => {
    h.executeWake.mockResolvedValueOnce({ kind: 'error', error: 'transient' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 13, subscriberId: 'su-d', attempts: 3 })]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.degradeToInboxOrDrop).not.toHaveBeenCalled();
    expect(h.store.markDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 13, error: 'transient' }),
    );
    expect(stats.failed).toBe(1);
  });

  it('EI-16559: exhausted-attempts fallback itself failing (no resolvable owner) still finalizes dead, visibly', async () => {
    h.degradeToInboxOrDrop.mockResolvedValueOnce({
      kind: 'drop',
      reason: 'exhausted attempts — inbox delivery also failed (no resolvable owner): boom',
    });
    h.executeWake.mockResolvedValueOnce({ kind: 'error', error: 'spawn failed again' });
    h.store.claimDueDeliveries.mockResolvedValueOnce([workRow({ id: 14, subscriberId: 'su-e', attempts: 8 })]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.store.markDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 14, error: 'spawn failed again' }),
    );
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });
});

describe('isInboxWakeGroupRedundant (EI-18673058981655804: redundant-inbox-wake suppression, pure core)', () => {
  it.each(['cold', 'warm'] as const)(
    'EI-25300396323844627: an inbox read never discharges a %s loop marker',
    (carry) => {
      expect(
        isInboxWakeGroupRedundant(
          [{
            eventKey: 'coord:inbox-wake:su-a',
            createdAt: new Date(1000).toISOString(),
            urgent: false,
            payload: {
              ...(carry === 'cold' ? { carry } : {}),
              wakeCount: 3,
              harness: 'papercusp',
              routineId: 'rt-loop-a',
            },
          }],
          new Date(5000).toISOString(),
        ),
      ).toBe(false);
    },
  );

  const inboxKey = 'coord:inbox-wake:su-a';

  it('true: a non-urgent inbox-wake delivery created at/before the last read', () => {
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: false }],
        new Date(2000).toISOString(),
      ),
    ).toBe(true);
    // Equal timestamps also count as covered (<=).
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: inboxKey, createdAt: new Date(2000).toISOString(), urgent: false }],
        new Date(2000).toISOString(),
      ),
    ).toBe(true);
  });

  it('false: no read on record at all (fail-open)', () => {
    expect(
      isInboxWakeGroupRedundant([{ eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: false }], null),
    ).toBe(false);
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: false }],
        undefined,
      ),
    ).toBe(false);
  });

  it('false: the message is NEWER than the last read (genuinely new mail)', () => {
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false }],
        new Date(2000).toISOString(),
      ),
    ).toBe(false);
  });

  it('false: an urgent delivery is never suppressed even if covered', () => {
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: true }],
        new Date(2000).toISOString(),
      ),
    ).toBe(false);
  });

  it('false: a non-inbox-wake key in the group (a genuine events:await) is never suppressed', () => {
    expect(
      isInboxWakeGroupRedundant(
        [{ eventKey: 'release:green:papercusp', createdAt: new Date(1000).toISOString(), urgent: false }],
        new Date(2000).toISOString(),
      ),
    ).toBe(false);
  });

  it('false: a MIXED group — one covered inbox-wake + one genuine event — is never suppressed', () => {
    expect(
      isInboxWakeGroupRedundant(
        [
          { eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: false },
          { eventKey: 'release:green:papercusp', createdAt: new Date(1000).toISOString(), urgent: false },
        ],
        new Date(2000).toISOString(),
      ),
    ).toBe(false);
  });

  it('false: an empty group', () => {
    expect(isInboxWakeGroupRedundant([], new Date(2000).toISOString())).toBe(false);
  });

  describe('EI-18676763837940562: reply-linkage leg (the read-cursor blind spot)', () => {
    it('true: no read-cursor coverage at all, but the delivery\'s msg_id was already replied to', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false, payload: { msg_id: 'm-1' } }],
          null, // no read on record — the read-cursor leg alone would say "not redundant"
          new Set(['m-1']),
        ),
      ).toBe(true);
    });
    it('true: the message POSTDATES the last read (genuinely-new-mail per the read-cursor leg) but was already replied to', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false, payload: { msg_id: 'm-1' } }],
          new Date(1000).toISOString(),
          new Set(['m-1']),
        ),
      ).toBe(true);
    });
    it('false: repliedMsgIds has a DIFFERENT msg_id — never suppressed on an unrelated reply', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false, payload: { msg_id: 'm-1' } }],
          null,
          new Set(['m-other']),
        ),
      ).toBe(false);
    });
    it('false: no payload.msg_id at all (a coalesced/foreign delivery) — the leg is a no-op, not a crash', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false }],
          null,
          new Set(['m-1']),
        ),
      ).toBe(false);
    });
    it('false: an urgent delivery is never suppressed even with a matching reply', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: true, payload: { msg_id: 'm-1' } }],
          null,
          new Set(['m-1']),
        ),
      ).toBe(false);
    });
    it('false: empty repliedMsgIds set behaves exactly like omitting it', () => {
      expect(
        isInboxWakeGroupRedundant(
          [{ eventKey: inboxKey, createdAt: new Date(5000).toISOString(), urgent: false, payload: { msg_id: 'm-1' } }],
          null,
          new Set(),
        ),
      ).toBe(false);
    });
    it('true: a MIXED group where each delivery is covered by a DIFFERENT leg (one by read-cursor, one by reply)', () => {
      expect(
        isInboxWakeGroupRedundant(
          [
            { eventKey: inboxKey, createdAt: new Date(1000).toISOString(), urgent: false }, // covered by read-cursor
            { eventKey: inboxKey, createdAt: new Date(9000).toISOString(), urgent: false, payload: { msg_id: 'm-1' } }, // covered by reply only
          ],
          new Date(2000).toISOString(),
          new Set(['m-1']),
        ),
      ).toBe(true);
    });
  });
});

describe('pumpWakeDeliveries — EI-18673058981655804: redundant-inbox-wake suppression', () => {
  it.each(['cold', 'warm'] as const)(
    'EI-25300396323844627: delivers a %s loop wake after a newer inbox read',
    async (carry) => {
      const previousReadAt = h.lastInboxReadAtBatch.getMockImplementation();
      h.lastInboxReadAtBatch.mockImplementation(async () => new Map([['su-a', new Date(5000).toISOString()]]));
      try {
        h.store.claimDueDeliveries.mockResolvedValueOnce([
          workRow({
            id: 474103,
            subscriberId: 'su-a',
            eventKey: 'coord:inbox-wake:su-a',
            createdAt: new Date(1000).toISOString(),
            source: 'loop:rt-loop-a',
            payload: {
              ...(carry === 'cold' ? { carry } : {}),
              wakeCount: 3,
              harness: 'papercusp',
              routineId: 'rt-loop-a',
            },
          }),
        ]);

        const stats = await pumpWakeDeliveries('ws-test');

        expect(h.executeWake).toHaveBeenCalledTimes(1);
        expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(474103, 'resume', 1);
        expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(474103, 'suppressed-redundant', 1);
        expect(stats.suppressed).toBe(0);
        expect(stats.delivered).toBe(1);
      } finally {
        if (previousReadAt) h.lastInboxReadAtBatch.mockImplementation(previousReadAt);
        else h.lastInboxReadAtBatch.mockReset();
      }
    },
  );

  it('suppresses a message-less inbox notification already covered by the subscriber\'s last read — no turn spent', async () => {
    h.lastInboxReadAtBatch.mockResolvedValueOnce(new Map([['su-a', new Date(5000).toISOString()]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 30,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(1000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(30, 'suppressed-redundant', 1);
    expect(stats.delivered).toBe(0);
    expect(stats.suppressed).toBe(1);
    expect(stats.deferred).toBe(0);
    // WI-6554700010009285: only an inbox-FOLDING read may retire a wake. A lifecycle
    // activity:report (a relaunched CLI's "▶ session started") reads no mail.
    expect(h.lastInboxReadAtBatch).toHaveBeenCalledWith(['su-a'], { foldedOnly: true });
  });

  it('WI-6554700010009881: delivers a work-item dispatch wake even when a newer inbox read covers it', async () => {
    // Incident shape: plan run 1345 dispatched WI-6554700010009869 to a parked executor;
    // the relaunched CLI's hook read at 05:59:58Z retired the wake as "already covered by
    // its own coord:inbox read", and the item sat open. An inbox read never shows a
    // work-item assignment, so the read cursor must not retire this wake.
    const previousReadAt = h.lastInboxReadAtBatch.getMockImplementation();
    h.lastInboxReadAtBatch.mockImplementation(async () => new Map([['su-a', new Date(5000).toISOString()]]));
    try {
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 734675,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(1000).toISOString(),
          source: 'system:plan-run-direct-dispatch',
          payload: { kind: 'actionable-work-item-dispatch', workItemIds: ['WI-6554700010009869'] },
        }),
      ]);

      const stats = await pumpWakeDeliveries('ws-test');

      expect(h.executeWake).toHaveBeenCalledTimes(1);
      expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(734675, 'suppressed-redundant', 1);
      expect(stats.suppressed).toBe(0);
      expect(stats.delivered).toBe(1);
    } finally {
      if (previousReadAt) h.lastInboxReadAtBatch.mockImplementation(previousReadAt);
      else h.lastInboxReadAtBatch.mockReset();
    }
  });

  it('retries a psu-host-accepted wake after the inbox read advances, so the pending host text can refresh', async () => {
    const createdAt = new Date(5000).toISOString();
    const acceptedReason = 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable';
    const pendingEnvelope = {
      msg_id: 'm-pending',
      ts: createdAt,
      from: 'su-b',
      kind: 'message',
      expects: 'answer',
    };
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(1000).toISOString() });
    h.getLineEnvelopeById.mockResolvedValueOnce(pendingEnvelope);
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 44,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: { msg_id: 'm-pending' },
        createdAt,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({ kind: 'park', reason: acceptedReason });
    await pumpWakeDeliveries('ws-test');

    // The first host ACK only says its gated delivery pipeline was queued. A later
    // inbox read must not make the await engine settle this unanswered ask.
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(6000).toISOString() });
    h.getLineEnvelopeById.mockResolvedValueOnce(pendingEnvelope);
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 44,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: { msg_id: 'm-pending' },
        createdAt,
        attempts: 2,
        lastError: acceptedReason,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'psu-socket-inject' });

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.executeWake).toHaveBeenCalledTimes(2);
    expect(h.readWatermark).toHaveBeenCalledTimes(2);
    expect(h.lastInboxReadAtBatch).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(44, 'psu-socket-inject', 1);
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(44, 'suppressed-redundant', 1);
    expect(stats.suppressed).toBe(0);
  });

  it('requests cancellation only for an exact shown non-actionable msg_id group and settles on the host receipt', async () => {
    const acceptedReason = 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable';
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(6000).toISOString() });
    h.getLineEnvelopeById.mockResolvedValueOnce({
      msg_id: 'm-fyi',
      ts: new Date(5000).toISOString(),
      from: 'su-b',
      kind: 'message',
      expects: 'none',
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 51,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: { msg_id: 'm-fyi' },
        lastError: acceptedReason,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'suppressed-redundant' });

    const stats = await pumpWakeDeliveries('ws-test');
    const wake = h.executeWake.mock.calls[0][0] as DeliveryWork;

    expect(h.readWatermark).toHaveBeenCalledWith('su-a');
    expect(wake.hostCancellation).toEqual({ deliveryIds: ['51'], handledMsgIds: ['m-fyi'] });
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(51, 'suppressed-redundant', 1);
    expect(stats.suppressed).toBe(1);
  });

  it('keeps an accepted wake pending until the host confirms cancellation before the first byte', async () => {
    const acceptedReason = 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable';
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(6000).toISOString() });
    h.getLineEnvelopeById.mockResolvedValueOnce({
      msg_id: 'm-fyi',
      ts: new Date(5000).toISOString(),
      from: 'su-b',
      kind: 'message',
      expects: 'none',
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 52,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: { msg_id: 'm-fyi' },
        lastError: acceptedReason,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({
      kind: 'park',
      reason: 'psu-host accepted the cancellation request; waiting for its exact pre-write receipt',
      hostCommitPending: true,
    });

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.executeWake.mock.calls[0][0]).toMatchObject({
      hostCancellation: { deliveryIds: ['52'], handledMsgIds: ['m-fyi'] },
    });
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalled();
    expect(h.store.markDeliveryParked).toHaveBeenCalledWith(52, expect.any(String), expect.any(Number));
    expect(stats.parked).toBe(1);
  });

  describe('WI5883 persisted host cancellation retries', () => {
  afterEach(() => {
    // A red before the final retry must not leak queued responses into other cases.
    h.executeWake.mockReset().mockResolvedValue({ kind: 'delivered', channel: 'resume' });
    h.readWatermark.mockReset().mockResolvedValue({ messages_shown_ts: '' });
    h.getLineEnvelopeById.mockReset().mockResolvedValue(null);
  });

  it.each([
    'psu-host accepted the cancellation request; waiting for its exact pre-write receipt',
    'psu-host still owns the accepted delivery; cancellation is unsupported and the retry remains durable',
    'psu-host accepted the fail-open wake retry; waiting for its delivery outcome',
    'psu-host coalesced-into-pending-turn: delivery accepted before turn-start proof; retry remains durable',
    'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
    'psu-host pending-delivery-id: delivery accepted before turn-start proof; retry remains durable',
  ])('retries host cancellation through persisted park reason %s until its exact receipt', async (cancellationParkReason) => {
    const acceptedReason = 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable';
    const envelope = {
      msg_id: 'm-fyi',
      ts: new Date(5000).toISOString(),
      from: 'su-b',
      kind: 'message',
      expects: 'none',
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(6000).toISOString() });
      h.getLineEnvelopeById.mockResolvedValueOnce(envelope);
    }
    h.store.claimDueDeliveries
      .mockResolvedValueOnce([
        workRow({
          id: 54,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          payload: { msg_id: 'm-fyi' },
          lastError: acceptedReason,
        }),
      ])
      .mockResolvedValueOnce([
        workRow({
          id: 54,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          payload: { msg_id: 'm-fyi' },
          attempts: 2,
          lastError: cancellationParkReason,
        }),
      ]);
    h.executeWake
      .mockResolvedValueOnce({ kind: 'park', reason: cancellationParkReason, hostCommitPending: true })
      .mockResolvedValueOnce({ kind: 'park', reason: cancellationParkReason, hostCommitPending: true });

    await pumpWakeDeliveries('ws-test');
    await pumpWakeDeliveries('ws-test');

    expect(h.executeWake).toHaveBeenCalledTimes(2);
    expect(h.executeWake.mock.calls[1][0]).toMatchObject({
      hostCancellation: { deliveryIds: ['54'], handledMsgIds: ['m-fyi'] },
    });
    expect(h.store.markDeliveryDelivered).not.toHaveBeenCalledWith(54, 'suppressed-redundant', 1);
    expect(h.store.markDeliveryParked).toHaveBeenCalledTimes(2);

    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 54,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: { msg_id: 'm-fyi' },
        attempts: 3,
        lastError: cancellationParkReason,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'suppressed-redundant' });
    await pumpWakeDeliveries('ws-test');
    expect(h.executeWake.mock.calls[2][0]).toMatchObject({
      hostCancellation: { deliveryIds: ['54'], handledMsgIds: ['m-fyi'] },
    });
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledExactlyOnceWith(54, 'suppressed-redundant', 1);
  });
  });

  it('carries every nested coalesced msg_id into the host cancellation request', async () => {
    const acceptedReason = 'psu-host pending-delivery-id: prior accepted delivery is still gated';
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(9000).toISOString() });
    const envelopes = new Map([
      ['m-a', { msg_id: 'm-a', ts: new Date(5000).toISOString(), kind: 'message', expects: 'none' }],
      ['m-b', { msg_id: 'm-b', ts: new Date(7000).toISOString(), kind: 'message', expects: 'none' }],
    ]);
    h.getLineEnvelopeById.mockImplementation(async (_surface: string, msgId: string) => envelopes.get(msgId) ?? null);
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 53,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        payload: {
          coalesced: true,
          events: [
            { event: 'coord:inbox-wake:su-a', urgent: false, payload: { msg_id: 'm-a' } },
            { event: 'coord:inbox-wake:su-a', urgent: false, payload: { msg_id: 'm-b' } },
          ],
        },
        lastError: acceptedReason,
      }),
    ]);
    h.executeWake.mockResolvedValueOnce({ kind: 'delivered', channel: 'suppressed-redundant' });

    await pumpWakeDeliveries('ws-test');

    expect(h.executeWake.mock.calls[0][0]).toMatchObject({
      hostCancellation: { deliveryIds: ['53'], handledMsgIds: ['m-a', 'm-b'] },
    });
  });

  it('does NOT suppress when the inbox-wake message postdates the last read (genuinely new mail)', async () => {
    h.lastInboxReadAtBatch.mockResolvedValueOnce(new Map([['su-a', new Date(1000).toISOString()]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 31,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(5000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(31, 'resume', 1);
    expect(stats.suppressed).toBe(0);
    expect(stats.delivered).toBe(1);
  });

  it('does NOT suppress when there is no read on record (fail-open, unchanged status quo)', async () => {
    h.lastInboxReadAtBatch.mockResolvedValueOnce(new Map()); // no watermark for su-a
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 32,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(1000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
  });

  it('does NOT suppress a non-inbox-wake key even when it would otherwise look covered', async () => {
    // No plausible "last read" concept applies to an ordinary events:await key — the
    // cheap pre-check must gate this before any watermark lookup even happens.
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 33,
        subscriberId: 'su-a',
        eventKey: 'release:green:papercusp',
        createdAt: new Date(1000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.lastInboxReadAtBatch).not.toHaveBeenCalled();
    expect(stats.suppressed).toBe(0);
  });

  it('does NOT suppress an urgent inbox-wake delivery even when covered', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 34,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(1000).toISOString(),
        urgent: true,
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
  });

  it('a MIXED coalesced group (one covered inbox-wake + one genuine event) still fires — never suppressed', async () => {
    // Pre-existing test-hygiene bug (found while adding the reply-linkage leg tests below):
    // `allInboxWakeNoUrgent` is false for a mixed group, so the pre-check short-circuits
    // BEFORE ever calling lastInboxReadAtBatch — a queued mockResolvedValueOnce for it here
    // is dead code that is NEVER consumed by this test, silently drifting the mock's once-queue
    // forward (since beforeEach only clearAllMocks, which does not drop queued once-values) and
    // corrupting whichever LATER test's turn it lands on instead. Deliberately not set here.
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 35,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(1000).toISOString(),
      }),
      workRow({
        id: 36,
        subscriberId: 'su-a',
        eventKey: 'release:green:papercusp',
        createdAt: new Date(2000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.lastInboxReadAtBatch).not.toHaveBeenCalled();
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
    expect(stats.delivered).toBe(1);
    expect(stats.coalesced).toBe(1);
  });

  it('suppresses a coalesced GROUP of multiple inbox-wake deliveries all covered — siblings settle without a turn', async () => {
    h.lastInboxReadAtBatch.mockResolvedValueOnce(new Map([['su-a', new Date(9000).toISOString()]]));
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({
        id: 37,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(1000).toISOString(),
      }),
      workRow({
        id: 38,
        subscriberId: 'su-a',
        eventKey: 'coord:inbox-wake:su-a',
        createdAt: new Date(2000).toISOString(),
      }),
    ]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    // Newest (id 38) is the headline settled channel='suppressed-redundant'; id 37 coalesces into it.
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(38, 'suppressed-redundant', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([37], 38);
    expect(stats.suppressed).toBe(1);
    expect(stats.delivered).toBe(0);
    expect(stats.coalesced).toBe(1);
  });

  describe('EI-18676763837940562: reply-linkage leg wired end-to-end through the pump', () => {
    it('suppresses a delivery whose msg_id was already replied to, even with NO read on record', async () => {
      h.repliedMsgIdsBatch.mockResolvedValueOnce(new Set(['m-orig']));
      h.getLineEnvelopeById.mockResolvedValueOnce({
        msg_id: 'm-orig',
        ts: new Date(5000).toISOString(),
        kind: 'message',
        expects: 'answer',
      });
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 40,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
          payload: { msg_id: 'm-orig' },
        }),
      ]);
      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.repliedMsgIdsBatch).toHaveBeenCalledWith('su-a', ['m-orig']);
      expect(h.executeWake).not.toHaveBeenCalled();
      expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(40, 'suppressed-redundant', 1);
      expect(stats.suppressed).toBe(1);
    });

    it('does NOT query repliedMsgIdsBatch at all when no delivery in the group carries a payload.msg_id', async () => {
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 41,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
        }),
      ]);
      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.repliedMsgIdsBatch).not.toHaveBeenCalled();
      expect(h.executeWake).toHaveBeenCalledTimes(1);
      expect(stats.suppressed).toBe(0);
    });

    it('a msg_id present but NOT yet replied to still fires normally (no false suppression)', async () => {
      h.repliedMsgIdsBatch.mockResolvedValueOnce(new Set()); // nothing replied
      h.getLineEnvelopeById.mockResolvedValueOnce({
        msg_id: 'm-orig',
        ts: new Date(5000).toISOString(),
        kind: 'message',
        expects: 'answer',
      });
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 42,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
          payload: { msg_id: 'm-orig' },
        }),
      ]);
      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.executeWake).toHaveBeenCalledTimes(1);
      expect(h.getSettledInboxMessageIds).not.toHaveBeenCalled();
      expect(stats.suppressed).toBe(0);
    });

    it('suppresses an exact thread reply already accounted for by a settled Inbox resolver run', async () => {
      h.getLineEnvelopeById.mockResolvedValueOnce({
        msg_id: 'm-reviewed-reply',
        ts: new Date(5000).toISOString(),
        kind: 'message',
        expects: 'none',
        related_msg_id: 'm-resolver-ask',
      });
      h.getSettledInboxMessageIds.mockResolvedValueOnce(new Set(['m-reviewed-reply']));
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 44,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
          payload: { msg_id: 'm-reviewed-reply' },
        }),
      ]);

      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.getSettledInboxMessageIds).toHaveBeenCalledWith(['m-reviewed-reply'], 'ws-test');
      expect(h.executeWake).not.toHaveBeenCalled();
      expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(44, 'suppressed-redundant', 1);
      expect(stats.suppressed).toBe(1);
    });

    it('fails open when the settled Inbox-run receipt lookup errors', async () => {
      h.getLineEnvelopeById.mockResolvedValueOnce({
        msg_id: 'm-reviewed-reply',
        ts: new Date(5000).toISOString(),
        kind: 'message',
        expects: 'none',
        related_msg_id: 'm-resolver-ask',
      });
      h.getSettledInboxMessageIds.mockRejectedValueOnce(new Error('pg down'));
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 45,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
          payload: { msg_id: 'm-reviewed-reply' },
        }),
      ]);

      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.executeWake).toHaveBeenCalledTimes(1);
      expect(stats.suppressed).toBe(0);
    });

    it('a repliedMsgIdsBatch failure fails OPEN — the delivery still fires, never crashes the pump', async () => {
      h.repliedMsgIdsBatch.mockRejectedValueOnce(new Error('pg down'));
      h.store.claimDueDeliveries.mockResolvedValueOnce([
        workRow({
          id: 43,
          subscriberId: 'su-a',
          eventKey: 'coord:inbox-wake:su-a',
          createdAt: new Date(5000).toISOString(),
          payload: { msg_id: 'm-orig' },
        }),
      ]);
      const stats = await pumpWakeDeliveries('ws-test');
      expect(h.executeWake).toHaveBeenCalledTimes(1);
      expect(stats.suppressed).toBe(0);
    });
  });
});

describe('pump guard is keyed per workspace (audit P-033)', () => {
  it("workspace B pumps while A's pump is in flight; same-workspace reentry latches one trailing rerun", async () => {
    // WI-3575: claimDueDeliveries no longer takes a workspaceId (events:await is
    // single-workspace by design — see store.ts) — so this can no longer observe
    // the `pumpsInFlight` per-workspace guard by inspecting the store call's
    // workspaceId arg. The guard itself is unchanged (pumpWakeDeliveries's OWN `ws`
    // param still keys the in-memory reentrancy Set); observe it instead via CALL
    // COUNT — a guarded reentry never reaches claimDueDeliveries at all, so only a
    // genuinely-proceeding pump increments it.
    let releaseA!: (rows: unknown[]) => void;
    let claimCalls = 0;
    let parkedOnce = false;
    (h.store.claimDueDeliveries as unknown as { mockImplementation: (fn: () => Promise<unknown[]>) => void }).mockImplementation(
      async () => {
        claimCalls++;
        if (!parkedOnce) {
          parkedOnce = true; // only the FIRST (A's) claim parks; later pumps complete normally
          return new Promise<unknown[]>((res) => {
            releaseA = res;
          });
        }
        return [];
      },
    );

    const pumpA = pumpWakeDeliveries('ws-a'); // parks inside claimDueDeliveries; guard entry held
    await Promise.resolve(); // let A reach its claim call
    expect(claimCalls).toBe(1);

    // Same-workspace reentry: still guarded synchronously — returns empty without
    // claiming in parallel, but latches one trailing rerun for after A releases.
    const reentry = await pumpWakeDeliveries('ws-a');
    expect(reentry.claimed).toBe(0);
    expect(claimCalls).toBe(1);

    // Cross-workspace: B must proceed (the old module-global boolean silently
    // swallowed this kick — cross-workspace wake starvation).
    await pumpWakeDeliveries('ws-b');
    expect(claimCalls).toBe(2);

    releaseA([]);
    await pumpA;

    await vi.waitFor(() => expect(claimCalls).toBe(3)); // the latched A rerun

    // A's guard entry cleared after the rerun — a later explicit pump proceeds.
    await pumpWakeDeliveries('ws-a');
    expect(claimCalls).toBe(4);
  });
});

// review-system-rework-reduction-2026-09-23 P-024 clauses B/C, through the real pump.
describe('pumpWakeDeliveries — P-024: a wake with nothing to act on costs no turn', () => {
  const envelopesById: Record<string, Record<string, unknown>> = {
    'm-fyi': { msg_id: 'm-fyi', from: 'su-b', to: ['su-a'], kind: 'message', expects: 'none' },
    'm-ack': { msg_id: 'm-ack', from: 'su-b', to: ['su-a'], kind: 'ack', related_msg_id: 'm-0' },
    'm-ask': { msg_id: 'm-ask', from: 'su-b', to: ['su-a'], kind: 'message', expects: 'action' },
    'm-owner': { msg_id: 'm-owner', from: 'pc-admin-coord-ui', to: ['su-a'], kind: 'message', expects: 'none' },
    'm-shown-fyi': {
      msg_id: 'm-shown-fyi', from: 'su-b', to: ['su-a'], kind: 'message', expects: 'none', ts: new Date(8000).toISOString(),
    },
    'm-shown-ask': {
      msg_id: 'm-shown-ask', from: 'su-b', to: ['su-a'], kind: 'message', expects: 'answer', ts: new Date(8000).toISOString(),
    },
    'm-shown-reply': {
      msg_id: 'm-shown-reply', from: 'su-b', to: ['su-a'], kind: 'message', related_msg_id: 'm-parent', ts: new Date(8000).toISOString(),
    },
  };
  const inboxDelivery = (id: number, msgId: string): DeliveryWork =>
    workRow({
      id,
      subscriberId: 'su-a',
      eventKey: 'coord:inbox-wake:su-a',
      createdAt: new Date(9000).toISOString(),
      payload: { msg_id: msgId },
    });

  beforeEach(() => {
    h.getLineEnvelopeById.mockImplementation(async (surface: string, msgId: string) =>
      surface === 'messages' ? (envelopesById[msgId] ?? null) : null,
    );
  });
  afterEach(() => {
    h.getLineEnvelopeById.mockReset();
    h.getLineEnvelopeById.mockImplementation(async () => null);
  });

  it('RSR-P-024-B: settles an FYI + ack group without executing a wake — no turn', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(40, 'm-fyi'), inboxDelivery(41, 'm-ack')]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(41, 'suppressed-redundant', 2);
    expect(h.store.markDeliveriesCoalesced).toHaveBeenCalledWith([40], 41);
    expect(stats.suppressed).toBe(1);
    expect(stats.delivered).toBe(0);
  });

  it('RSR-P-024-C: a directed ask in the group starts a turn', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(42, 'm-fyi'), inboxDelivery(43, 'm-ask')]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
    expect(stats.delivered).toBe(1);
  });

  it('a read watermark does not discharge an unanswered expects:answer message', async () => {
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(10000).toISOString() });
    h.repliedMsgIdsBatch.mockResolvedValueOnce(new Set());
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(47, 'm-shown-ask')]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.lastInboxReadAtBatch).not.toHaveBeenCalled();
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(47, 'resume', 1);
    expect(stats.suppressed).toBe(0);
  });

  it('a read watermark does not discharge an unanswered thread reply', async () => {
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(10000).toISOString() });
    h.repliedMsgIdsBatch.mockResolvedValueOnce(new Set());
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(48, 'm-shown-reply')]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.lastInboxReadAtBatch).not.toHaveBeenCalled();
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(48, 'resume', 1);
    expect(stats.suppressed).toBe(0);
  });

  it('a shown non-actionable FYI still settles after its exact message timestamp is covered', async () => {
    h.readWatermark.mockResolvedValueOnce({ messages_shown_ts: new Date(10000).toISOString() });
    h.repliedMsgIdsBatch.mockResolvedValueOnce(new Set());
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(49, 'm-shown-fyi')]);

    const stats = await pumpWakeDeliveries('ws-test');

    expect(h.executeWake).not.toHaveBeenCalled();
    expect(h.store.markDeliveryDelivered).toHaveBeenCalledWith(49, 'suppressed-redundant', 1);
    expect(stats.suppressed).toBe(1);
  });

  it('RSR-P-024-C: an owner directive that looks like an FYI starts a turn', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(44, 'm-owner')]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
  });

  it('fails open: an envelope that cannot be read keeps the turn', async () => {
    h.getLineEnvelopeById.mockImplementation(async () => {
      throw new Error('coord log unavailable');
    });
    h.store.claimDueDeliveries.mockResolvedValueOnce([inboxDelivery(45, 'm-fyi')]);
    const stats = await pumpWakeDeliveries('ws-test');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
    expect(stats.suppressed).toBe(0);
  });

  it('never reads envelopes for a msg_id-less inbox wake (loop fires, system alarms)', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ id: 46, subscriberId: 'su-a', eventKey: 'coord:inbox-wake:su-a', createdAt: new Date(9000).toISOString() }),
    ]);
    await pumpWakeDeliveries('ws-test');
    expect(h.getLineEnvelopeById).not.toHaveBeenCalled();
    expect(h.executeWake).toHaveBeenCalledTimes(1);
  });
});

describe('WI-10008194 — every pump / sweep run reports its outcome to pump health', () => {
  const tracker = { recordFailure: vi.fn(), recordSuccess: vi.fn(), streaks: () => [] };
  let previous: ReturnType<typeof setPumpHealthTrackerForTests>;
  const OUTAGE = new Error('column "turn_proof" of relation "event_wake_deliveries" does not exist');

  beforeEach(() => {
    tracker.recordFailure.mockReset();
    tracker.recordSuccess.mockReset();
    previous = setPumpHealthTrackerForTests(tracker);
  });
  afterEach(() => {
    setPumpHealthTrackerForTests(previous);
  });

  it('a throwing pump records a pump FAILURE and still rethrows to the kick site', async () => {
    h.store.claimDueDeliveries.mockRejectedValueOnce(OUTAGE);
    await expect(pumpWakeDeliveries('ws-test')).rejects.toThrow(OUTAGE.message);
    expect(tracker.recordFailure).toHaveBeenCalledWith('ws-test', 'pump', OUTAGE);
    expect(tracker.recordSuccess).not.toHaveBeenCalledWith('ws-test', 'pump');
  });

  it('a completed pump (even an empty one) records a pump SUCCESS', async () => {
    await pumpWakeDeliveries('ws-test');
    expect(tracker.recordSuccess).toHaveBeenCalledWith('ws-test', 'pump');
    expect(tracker.recordFailure).not.toHaveBeenCalled();
  });

  it('pumps parked coordination retries under the shared workspace context', async () => {
    h.store.claimDueDeliveries.mockResolvedValueOnce([
      workRow({ workspaceId: DEFAULT_COORD_WORKSPACE, attempts: 1 }),
    ]);
    await sweepAllWorkspaces();
    expect(h.admitSpawn).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: DEFAULT_COORD_WORKSPACE,
      role: 'await-wake',
    });
    expect(tracker.recordSuccess).toHaveBeenCalledWith(DEFAULT_COORD_WORKSPACE, 'pump');
    expect(h.executeWake).toHaveBeenCalledTimes(1);
  });

  it('the production sweeper records a sweep FAILURE without throwing, and a sweep SUCCESS when it completes', async () => {
    h.store.compactSupersededLoopDeliveries.mockRejectedValueOnce(OUTAGE);
    await expect(sweepAllWorkspaces()).resolves.toBeUndefined();
    expect(tracker.recordFailure).toHaveBeenCalledWith(DEFAULT_COORD_WORKSPACE, 'sweep', OUTAGE);
    expect(tracker.recordSuccess).toHaveBeenCalledWith('ws-test', 'sweep');

    tracker.recordFailure.mockReset();
    await sweepAllWorkspaces();
    expect(tracker.recordSuccess).toHaveBeenCalledWith(DEFAULT_COORD_WORKSPACE, 'sweep');
    expect(tracker.recordSuccess).toHaveBeenCalledWith(DEFAULT_COORD_WORKSPACE, 'pump');
    expect(tracker.recordSuccess).toHaveBeenCalledWith('ws-test', 'sweep');
    expect(tracker.recordSuccess).toHaveBeenCalledWith('ws-test', 'pump');
    expect(tracker.recordFailure).not.toHaveBeenCalledWith('ws-test', 'sweep', expect.anything());
  });
});
