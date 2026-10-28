/**
 * status.test.ts — events:status projection (GAP 15).
 *
 * Deps mocked (listActiveAwaits / listRecentDeliveries / wakeMeter /
 * resolveAgentIdentity). Asserts the projected field names (await_id/event/policy
 * for awaits; delivery_id/channel/last_error for deliveries), that the meter is
 * omitted unless meter:true, and that all three store reads run.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-status', ownerLabel: 's', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../coordination/event-subscriptions', () => ({
  listMyEventKeySubscriptions: vi.fn(),
}));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetLeader: vi.fn(async () => []) },
}));
vi.mock('../coordination/role-slot-live-resolve', () => ({
  resolveLiveRoleHolders: vi.fn(async () => []),
}));
vi.mock('../coordination/liveness-oracle', () => ({
  resolveSessionStates: vi.fn(async () => new Map()),
}));
vi.mock('../../events/await/store', () => ({
  deliveryBacklogSummary: vi.fn(),
  inspectEventKey: vi.fn(),
  listActiveAwaits: vi.fn(),
  listRecentDeliveries: vi.fn(),
  wakeMeter: vi.fn(),
  // declared-gate recovery evidence (events:status exact-key `recovery`).
  findAnnouncementsForKey: vi.fn(async () => []),
  probeKeyFireEvidence: vi.fn(async (key: string) => ({ prefix: key, exact: false, distinctKeys: 0, fires: 0, lastFiredAt: null })),
}));
vi.mock('../../events/await/installed-events', () => ({
  readInstalledUnitEvents: vi.fn(async () => []),
}));
vi.mock('../../events/await/compose-store', () => ({
  listActiveComposedRoots: vi.fn(async () => []),
  loadTreeLeaves: vi.fn(async () => []),
}));

import status, { turnProofFields } from './status';
import {
  deliveryBacklogSummary,
  inspectEventKey,
  listActiveAwaits,
  listRecentDeliveries,
  wakeMeter,
} from '../../events/await/store';
import { listMyEventKeySubscriptions } from '../coordination/event-subscriptions';
import { hostAudienceResolvers } from '../coordination/audience-host';
import { resolveLiveRoleHolders } from '../coordination/role-slot-live-resolve';
import { resolveSessionStates } from '../coordination/liveness-oracle';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../context-doors';
import { applyResultDoorAsync, resetResultDoorAggregatesForTests, RESULT_DOOR_TOKENS, type DoorableResult } from '../../result-door';
import { _resetScratchUsageForTests } from '../../scratch-gc';
import { readVolatileScratchReference } from '../../scratch-reference';
import type { AwaitRow, DeliveryRow } from '../../events/await/types';
import type { SubscriptionRow } from '@papercusp/coordination/capabilities';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof status.handler>[1];
const call = async (
  args: Record<string, unknown>,
  callerCtx = ctx,
) => {
  const res = (await status.handler(args as never, callerCtx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

const AWAIT_ROW: AwaitRow = {
  id: 11,
  workspaceId: 'ws-x',
  subscriberId: 'su-status',
  eventKey: 'lock:grant:t1',
  policy: 'wake',
  note: 'n',
  wakeHandle: null,
  timeoutBehavior: 'wake',
  expiresTs: '2026-10-11T01:00:00.000Z',
  createdAt: '2026-10-11T00:00:00.000Z',
  firedAt: null,
  firedReason: null,
  cancelledAt: null,
  cancelReason: null,
  once: true,
  minSleepSec: null,
  urgency: false,
  payloadFilter: null,
  scopeKind: null,
  scopeRef: null,
};
// Typed as the real DeliveryRow (EI-21878602849246427) rather than a partial literal cast
// `as never` at each use. The cast defeats vi.mocked()'s signature check, so a fixture that
// goes stale when DeliveryRow gains a required field fails at RUNTIME in an unrelated file
// instead of at compile time here — see testing/typed-mock.ts and WI-6673.
const DELIVERY_ROW: DeliveryRow = {
  id: 22,
  workspaceId: 'ws-x',
  awaitId: 11,
  subscriberId: 'su-status',
  eventKey: 'lock:grant:t1',
  payload: null,
  summary: null,
  status: 'parked',
  channel: 'inbox',
  attempts: 2,
  lastError: 'boom',
  nextAttemptAt: 'C2',
  createdAt: 'C2',
  deliveredAt: null,
  urgent: false,
  minSleepSec: null,
  coalescedCount: 1,
  source: null,
  turnProof: null,
  turnStartedAt: null,
  pickupDeadlineAt: null,
};
const EVENT_SUBSCRIPTION_ROW: SubscriptionRow = {
  id: 33,
  subscriber_id: 'su-status',
  target_kind: 'event',
  target_ref: 'work-item:claimable',
  delivery_mode: 'digest',
  created_ts: 'C3',
  expires_ts: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listActiveAwaits).mockResolvedValue([AWAIT_ROW]);
  vi.mocked(listMyEventKeySubscriptions).mockResolvedValue([EVENT_SUBSCRIPTION_ROW]);
  vi.mocked(listRecentDeliveries).mockResolvedValue([DELIVERY_ROW]);
  vi.mocked(deliveryBacklogSummary).mockResolvedValue({
    total: 1,
    pending: 0,
    parked: 1,
    delivering: 0,
    fromCancelledAwaits: 0,
    oldestCreatedAt: 'C2',
  });
  vi.mocked(wakeMeter).mockResolvedValue({ total: 7 } as never);
  vi.mocked(inspectEventKey).mockResolvedValue({ announcements: [], waiters: [], deliveries: [], fireLatch: null } as never);
});

describe('events:status projection', () => {
  it('admits the evidence-only judge role', () => {
    expect(status.agentRoles).toContain('judge');
  });

  it('judge default view stays scoped to the caller identity', async () => {
    const judgeCtx = { ...ctx, role: 'judge' } as typeof ctx;
    const out = await call({}, judgeCtx);

    expect(listActiveAwaits).toHaveBeenCalledWith('su-status');
    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 10);
    expect(listMyEventKeySubscriptions).toHaveBeenCalledWith({
      ownerId: 'su-status',
      ownerLabel: 's',
      source: 'static-client',
      workspaceId: 'ws-x',
      userId: null,
    });
    expect(inspectEventKey).not.toHaveBeenCalled();
    expect(wakeMeter).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('event_inspection');
    expect(out).not.toHaveProperty('meter');
  });

  it.each([{ event: 'work-item:claimable' }, { meter: true }])('judge rejects restricted arguments before any store reads: %j', async (args) => {
    const judgeCtx = { ...ctx, role: 'judge' } as typeof ctx;

    await expect(call(args, judgeCtx)).rejects.toThrow('evidence-only judge');
    expect(inspectEventKey).not.toHaveBeenCalled();
    expect(wakeMeter).not.toHaveBeenCalled();
    expect(listActiveAwaits).not.toHaveBeenCalled();
    expect(listRecentDeliveries).not.toHaveBeenCalled();
  });

  it('judge await_id reads only the caller-owned delivery row', async () => {
    const judgeCtx = { ...ctx, role: 'judge' } as typeof ctx;

    const out = await call({ await_id: 11 }, judgeCtx);

    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 1, 11);
    expect(inspectEventKey).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('event_inspection');
  });

  it('opts out of the ambient workspace transaction for concurrent projected reads', () => {
    expect(status.skipWorkspaceTx).toBe(true);
  });

  it('bounds concurrent status read bundles so each caller cannot fan out into the admin pool', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(listActiveAwaits).mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await hold;
      active -= 1;
      return [AWAIT_ROW];
    });

    const calls = Array.from({ length: 4 }, () => call({}));
    await vi.waitFor(() => expect(active).toBe(2));
    expect(peak).toBe(2);
    release();
    await Promise.all(calls);
    expect(peak).toBe(2);
  });

  it('projects await rows to await_id/event/policy/note/expires_ts/on_timeout/created_at', async () => {
    const out = await call({});
    expect(out.active_awaits[0]).toEqual({
      await_id: 11,
      event: 'lock:grant:t1',
      policy: 'wake',
      note: 'n',
      expires_ts: '2026-10-11T01:00:00.000Z',
      on_timeout: 'wake',
      created_at: '2026-10-11T00:00:00.000Z',
    });
  });

  it('projects standing event-key inject subscriptions separately from wake awaits', async () => {
    const out = await call({});

    expect(out.active_event_subscriptions).toEqual([
      {
        subscription_id: 33,
        event: 'work-item:claimable',
        delivery: 'inject',
        mode: 'digest',
        expires_ts: null,
        created_at: 'C3',
      },
    ]);
    expect(listMyEventKeySubscriptions).toHaveBeenCalledWith({
      ownerId: 'su-status',
      ownerLabel: 's',
      source: 'static-client',
      workspaceId: 'ws-x',
      userId: null,
    });
  });

  it('accepts the await_id returned by events:await and narrows active_awaits to that registration', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValueOnce([
      AWAIT_ROW,
      { ...AWAIT_ROW, id: 12, eventKey: 'other:event' },
    ]);

    const out = await call({ await_id: 12 });

    expect(out.active_awaits).toEqual([
      {
        await_id: 12,
        event: 'other:event',
        policy: 'wake',
        note: 'n',
        expires_ts: '2026-10-11T01:00:00.000Z',
        on_timeout: 'wake',
        created_at: '2026-10-11T00:00:00.000Z',
      },
    ]);
  });

  it('rejects combining await_id with exact event inspection', async () => {
    await expect(call({ await_id: 11, event: 'lock:grant:t1' })).rejects.toThrow(/mutually exclusive/);
  });

  it('never projects emitter-side announcement rows as cancellable active awaits', async () => {
    vi.mocked(listActiveAwaits).mockResolvedValueOnce([
      AWAIT_ROW,
      {
        ...AWAIT_ROW,
        id: 12,
        eventKey: 'gate:declared',
        policy: 'announce',
      },
    ] as never);

    const out = await call({});
    expect(out.active_awaits.map((row: { await_id: number }) => row.await_id)).toEqual([11]);
  });

  it('projects delivery rows with derived turn_invoked state, not status alone', async () => {
    const out = await call({});
    expect(out.recent_wakes[0]).toEqual({
      delivery_id: 22,
      event: 'lock:grant:t1',
      status: 'parked',
      channel: 'inbox',
      turn_invoked: false,
      turn_proof: null,
      turn_started_at: null,
      attempts: 2,
      last_error: 'boom',
      created_at: 'C2',
      delivered_at: null,
    });
  });

  // P-006 / D-005: events:status is the LATER seam that reports pickup. `status:'delivered'`
  // only says the delivery reached its channel; turn_proof says whether a turn started.
  it('reports turn_proof per delivery: the deadline only while awaiting, the start time once proven', async () => {
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([
      {
        ...DELIVERY_ROW,
        id: 40,
        status: 'delivered',
        channel: 'psu-socket-inject',
        deliveredAt: '2026-10-10T20:00:00.000Z',
        turnProof: 'awaiting',
        pickupDeadlineAt: '2026-10-10T20:10:00.000Z',
      },
      {
        ...DELIVERY_ROW,
        id: 41,
        status: 'delivered',
        channel: 'psu-socket-inject',
        deliveredAt: '2026-10-10T19:00:00.000Z',
        turnProof: 'observed',
        turnStartedAt: '2026-10-10T19:01:30.000Z',
        // A resolved row keeps its stale deadline in the ledger; it must not be rendered.
        pickupDeadlineAt: '2026-10-10T19:10:00.000Z',
      },
      {
        ...DELIVERY_ROW,
        id: 42,
        status: 'delivered',
        channel: 'inbox',
        deliveredAt: '2026-10-10T18:00:00.000Z',
        turnProof: 'not-picked-up',
        pickupDeadlineAt: '2026-10-10T18:10:00.000Z',
      },
    ]);

    const out = await call({});

    expect(out.recent_wakes[0]).toMatchObject({
      delivery_id: 40,
      status: 'delivered',
      turn_invoked: true,
      turn_proof: 'awaiting',
      turn_started_at: null,
      pickup_deadline_at: '2026-10-10T20:10:00.000Z',
    });
    expect(out.recent_wakes[1]).toMatchObject({
      delivery_id: 41,
      turn_proof: 'observed',
      turn_started_at: '2026-10-10T19:01:30.000Z',
    });
    expect(out.recent_wakes[1]).not.toHaveProperty('pickup_deadline_at');
    // The silent failure the ledger used to hide: delivered, and no turn ever started.
    expect(out.recent_wakes[2]).toMatchObject({ delivery_id: 42, status: 'delivered', turn_proof: 'not-picked-up' });
    expect(out.recent_wakes[2]).not.toHaveProperty('pickup_deadline_at');
  });

  it('turnProofFields renders a pre-1441 row as unknown (null), never as an outcome', () => {
    expect(turnProofFields({ turnProof: null, turnStartedAt: null, pickupDeadlineAt: null })).toEqual({
      turn_proof: null,
      turn_started_at: null,
    });
  });

  it('exposes a bounded payload only when inspecting one await delivery', async () => {
    const payload = {
      composed: true,
      consumed: true,
      satisfied: true,
      reason: 'event',
      fired: [{ event: 'green-checkpoint:inconclusive:papercusp', payload: { reason: 'skipped-locked' } }],
      pending: [],
    };
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([
      { ...DELIVERY_ROW, id: 23, awaitId: 187914, eventKey: 'composed-root:408', payload },
    ]);

    const out = await call({ await_id: 187914 });

    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 1, 187914);
    expect(out.recent_wakes[0]).toMatchObject({
      delivery_id: 23,
      event: 'composed-root:408',
      payload,
    });
  });

  it('does not expose delivery payloads in the unfiltered recent-wakes summary', async () => {
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([
      { ...DELIVERY_ROW, payload: { composed: true, satisfied: true } },
    ]);

    const out = await call({});

    expect(out.recent_wakes[0]).not.toHaveProperty('payload');
  });

  it('caps an oversized payload in an exact-await inspection', async () => {
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([
      { ...DELIVERY_ROW, payload: { detail: 'x'.repeat(3_000) } },
    ]);

    const out = await call({ await_id: 11 });

    expect(out.recent_wakes[0].payload_truncated).toBe(true);
    expect(out.recent_wakes[0].payload_preview).toHaveLength(2_000);
    expect(out.recent_wakes[0].payload_chars).toBeGreaterThan(2_000);
    expect(out.recent_wakes[0]).not.toHaveProperty('payload');
  });

  it('reports the full outstanding backlog even when recent_wakes hides older live rows', async () => {
    vi.mocked(listRecentDeliveries).mockResolvedValueOnce([{ ...DELIVERY_ROW, id: 30, status: 'delivered' }]);
    vi.mocked(deliveryBacklogSummary).mockResolvedValueOnce({
      total: 134,
      pending: 118,
      parked: 0,
      delivering: 16,
      fromCancelledAwaits: 134,
      oldestCreatedAt: '2026-08-30T04:00:00.000Z',
    });

    const out = await call({});

    expect(out.outstanding_deliveries).toMatchObject({
      total: 134,
      by_status: { pending: 118, parked: 0, delivering: 16 },
      from_cancelled_awaits: 134,
      shown_in_recent_wakes: 0,
      hidden_from_recent_wakes: 134,
    });
    expect(out.outstanding_deliveries.warning).toMatch(/cancelled awaits/);
  });

  it('meter omitted unless meter:true (default call → wakeMeter NOT invoked, no meter key)', async () => {
    const out = await call({});
    expect(wakeMeter).not.toHaveBeenCalled();
    expect('meter' in out).toBe(false);
  });

  it('meter:true → wakeMeter invoked and the meter rides in the envelope', async () => {
    const out = await call({ meter: true });
    // WI-3575: wakeMeter/listActiveAwaits no longer take workspaceId (events:await
    // is single-workspace by design — see store.ts).
    expect(wakeMeter).toHaveBeenCalledWith();
    expect(out.meter).toEqual({ total: 7 });
  });

  it('all ambient store reads run (Promise.all), scoped to identity', async () => {
    await call({ meter: true });
    expect(listActiveAwaits).toHaveBeenCalledWith('su-status');
    expect(listRecentDeliveries).toHaveBeenCalledWith('su-status', 10);
    expect(deliveryBacklogSummary).toHaveBeenCalledWith('su-status');
    expect(listMyEventKeySubscriptions).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-status' }));
    expect(wakeMeter).toHaveBeenCalledTimes(1);
  });

  it('exact-key inspection returns causal generations, evidence, waiters, wakes, and a stale-watermark resync', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [
        {
          id: 2,
          causalGeneration: 2,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:00:00.000Z',
          note: 'ship exact SHA',
          expectedCondition: { kind: 'sha', sha: 'abcdef1' },
          firedPayload: { deployed_sha: 'abcdef1' },
          firedAt: '2026-07-13T12:05:00.000Z',
          firedReason: 'event',
          firedBy: 'release-host',
          cancelledAt: null,
          supersededAt: null,
        },
        {
          id: 1,
          causalGeneration: 1,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T11:00:00.000Z',
          note: 'old gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: null,
          firedReason: null,
          firedBy: null,
          cancelledAt: null,
          supersededAt: '2026-07-13T12:00:00.000Z',
        },
      ],
      waiters: [{
        id: 31,
        subscriberId: 'su-waiter',
        policy: 'wake',
        createdAt: '2026-07-13T12:01:00.000Z',
        firedAt: '2026-07-13T12:05:00.000Z',
        firedReason: 'event',
        cancelledAt: null,
        expiresTs: null,
      }],
      deliveries: [{
        id: 41,
        subscriberId: 'su-waiter',
        status: 'delivered',
        channel: 'pty-inject',
        attempts: 1,
        source: 'release-host',
        lastError: null,
        createdAt: '2026-07-13T12:05:00.000Z',
        deliveredAt: '2026-07-13T12:05:01.000Z',
      }],
    } as never);

    const out = await call({ event: 'deploy:abcdef1', after_generation: 1 });
    expect(inspectEventKey).toHaveBeenCalledWith('deploy:abcdef1');
    expect(out.event_inspection.current_generation).toBe(2);
    expect(out.event_inspection.current_state).toBe('fired');
    expect(out.event_inspection.declarations).toMatchObject([
      { generation: 2, expected_verdict: 'matched', actual_sha: 'abcdef1', fired_by: 'release-host' },
      { generation: 1, state: 'superseded' },
    ]);
    expect(out.event_inspection.waiters[0]).toMatchObject({ await_id: 31, state: 'fired' });
    expect(out.event_inspection.wake_outcomes[0]).toMatchObject({
      delivery_id: 41,
      status: 'delivered',
      turn_invoked: true,
    });
    expect(out.event_inspection.resync).toMatchObject({
      required: true,
      reason: 'consumer_behind',
      consumer_generation: 1,
      authoritative_generation: 2,
    });
    // Exact-key inspection must not be buried behind this caller's unrelated
    // await tree; callers asking for one event receive the focused authority.
    expect(out).not.toHaveProperty('active_awaits');
    expect(out).not.toHaveProperty('recent_wakes');
    expect(listActiveAwaits).not.toHaveBeenCalled();
    expect(listRecentDeliveries).not.toHaveBeenCalled();
    expect(deliveryBacklogSummary).not.toHaveBeenCalled();
    expect(listMyEventKeySubscriptions).not.toHaveBeenCalled();
  });

  it('bounds hot exact-key history, keeps the newest rows, and reports omitted rows within the response budget', async () => {
    const longValue = 'x'.repeat(8_000);
    const announcements = Array.from({ length: 50 }, (_, index) => ({
      id: 50 - index,
      causalGeneration: 50 - index,
      subscriberId: `su-announcer-${index}`,
      createdAt: `2026-07-${String(13 - Math.floor(index / 24)).padStart(2, '0')}T12:00:00.000Z`,
      note: longValue,
      expectedCondition: { kind: 'predicate', predicate: { summary: longValue } },
      firedPayload: null,
      firedAt: null,
      firedReason: null,
      firedBy: null,
      cancelledAt: null,
      supersededAt: '2026-07-13T12:10:00.000Z',
    }));
    const waiters = Array.from({ length: 200 }, (_, index) => ({
      ...AWAIT_ROW,
      id: 300 - index,
      eventKey: 'git-sync:committed',
      subscriberId: `su-waiter-${index}`,
      policy: 'wake',
      createdAt: '2026-07-13T12:01:00.000Z',
      firedAt: null,
      firedReason: null,
      cancelledAt: null,
      expiresTs: null,
      rootId: null,
    }));
    const deliveries = Array.from({ length: 200 }, (_, index) => ({
      ...DELIVERY_ROW,
      id: 500 - index,
      eventKey: 'git-sync:committed',
      subscriberId: `su-delivery-${index}`,
      lastError: longValue,
      createdAt: '2026-07-13T12:05:00.000Z',
      deliveredAt: null,
    }));
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements,
      waiters,
      deliveries,
      fireLatch: null,
    } as never);

    const out = await call({ event: 'git-sync:committed' });

    expect(inspectEventKey).toHaveBeenCalledWith('git-sync:committed');
    expect(out.event_inspection.history_window.limit).toBe(10);
    expect(out.event_inspection.history_window.declarations).toMatchObject({ loaded_rows: 50, more_available: true });
    expect(out.event_inspection.history_window.waiters).toMatchObject({ loaded_rows: 200, more_available: true });
    expect(out.event_inspection.history_window.wake_outcomes).toMatchObject({ loaded_rows: 200, more_available: true });
    expect(out.event_inspection.waiters.map((row: { await_id: number }) => row.await_id))
      .toEqual([...out.event_inspection.waiters.map((row: { await_id: number }) => row.await_id)].sort((a, b) => b - a));
    if (out.event_inspection.waiters.length > 0) expect(out.event_inspection.waiters[0].await_id).toBe(300);
    if (out.event_inspection.wake_outcomes.length > 0) expect(out.event_inspection.wake_outcomes[0].delivery_id).toBe(500);
    expect(out.event_inspection.wake_outcomes.every((row: { last_error?: string; last_error_truncated?: boolean }) =>
      row.last_error_truncated === true && (row.last_error?.length ?? 0) <= 257,
    )).toBe(true);
    expect(out.event_inspection.history_window.waiters.shown).toBe(out.event_inspection.waiters.length);
    expect(out.event_inspection.history_window.wake_outcomes.shown).toBe(out.event_inspection.wake_outcomes.length);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(5_000);
  });

  it('previews a single oversized announcement instead of letting one row exceed the exact-key response budget', async () => {
    const longValue = 'x'.repeat(8_000);
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 1,
        causalGeneration: 1,
        subscriberId: 'su-emitter',
        createdAt: '2026-07-13T12:00:00.000Z',
        note: longValue,
        expectedCondition: { kind: 'predicate', predicate: { summary: longValue } },
        firedPayload: null,
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: '2026-07-13T12:10:00.000Z',
      }],
      waiters: [],
      deliveries: [],
      fireLatch: null,
    } as never);

    const out = await call({ event: 'gate:large-expected-condition' });
    const declaration = out.event_inspection.declarations[0];

    expect(declaration.note_truncated).toBe(true);
    expect(declaration.note_chars).toBe(8_000);
    expect(declaration.note.length).toBeLessThanOrEqual(257);
    expect(declaration.expected_truncated).toBe(true);
    expect(declaration.expected.original_chars).toBeGreaterThan(512);
    expect(declaration.expected.preview.length).toBe(512);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(5_000);
  });

  it('maps an expired current declaration to expired and preserves superseded precedence', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [
        {
          id: 3,
          causalGeneration: 3,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:10:00.000Z',
          note: 'current gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: '2026-07-13T12:11:00.000Z',
          firedReason: 'expired',
          firedBy: null,
          cancelledAt: null,
          supersededAt: null,
        },
        {
          id: 2,
          causalGeneration: 2,
          subscriberId: 'su-emitter',
          createdAt: '2026-07-13T12:00:00.000Z',
          note: 'superseded gate',
          expectedCondition: null,
          firedPayload: null,
          firedAt: '2026-07-13T12:05:00.000Z',
          firedReason: 'expired',
          firedBy: null,
          cancelledAt: null,
          supersededAt: '2026-07-13T12:10:00.000Z',
        },
      ],
      waiters: [],
      deliveries: [],
      fireLatch: null,
    } as never);

    const out = await call({ event: 'gate:expired' });

    expect(out.event_inspection.current_state).toBe('expired');
    expect(out.event_inspection.declarations).toMatchObject([
      { generation: 3, state: 'expired' },
      { generation: 2, state: 'superseded' },
    ]);
  });

  it('EI-13705: a bare-emitted key with no announcement but a fire latch reports fired_undeclared, not undeclared — with fire_latch + advice surfaced', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: {
        workspaceId: 'ws-x',
        eventKey: 'p2p-git:phase3-open',
        firstFiredAt: '2026-07-10T23:17:46.000Z',
        lastFiredAt: '2026-07-10T23:17:46.000Z',
        lastFiredBy: 'su-63834d42',
        lastPayload: null,
        fireCount: 1,
      },
    } as never);

    const out = await call({ event: 'p2p-git:phase3-open' });
    expect(out.event_inspection.current_state).toBe('fired_undeclared');
    expect(out.event_inspection.fire_latch).toEqual({
      first_fired_at: '2026-07-10T23:17:46.000Z',
      last_fired_at: '2026-07-10T23:17:46.000Z',
      last_fired_by: 'su-63834d42',
      fire_count: 1,
    });
    expect(out.event_inspection.advice).toMatch(/genuinely fired/);
    expect(out.event_inspection.advice).toMatch(/never happened/);
  });

  it('a key with no announcement and no fire latch (truly never fired) still reports undeclared', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: null,
    } as never);

    const out = await call({ event: 'never:fired' });
    expect(out.event_inspection.current_state).toBe('undeclared');
    expect('fire_latch' in out.event_inspection).toBe(false);
    expect('advice' in out.event_inspection).toBe(false);
  });

  it('reports a fired composed-root anchor as consumed, not an undeclared registered waiter', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [],
      waiters: [{
        id: 187540,
        eventKey: 'composed-root:406',
        rootId: 406,
        subscriberId: 'su-peer',
        policy: 'wake',
        firedAt: null,
        cancelledAt: null,
      }],
      deliveries: [{
        ...DELIVERY_ROW,
        id: 364289,
        awaitId: 187540,
        eventKey: 'composed-root:406',
        channel: 'psu-socket-inject',
      }],
      fireLatch: null,
      composedRoot: {
        rootId: 406,
        state: 'fired',
        requiredCount: 2,
        firedCount: 0,
        firedAt: '2026-09-19T14:20:37.613Z',
        cancelledAt: null,
        expiresTs: '2026-09-19T14:20:35.167Z',
        timeoutBehavior: 'wake',
      },
    } as never);

    const out = await call({ event: 'composed-root:406' });

    expect(out.event_inspection).toMatchObject({
      current_state: 'composed_fired',
      composed_root: { root_id: 406, state: 'fired', fired_count: 0, on_timeout: 'wake' },
      waiters: [{ await_id: 187540, state: 'fired' }],
      wake_outcomes: [{ delivery_id: 364289, turn_invoked: true }],
    });
  });

  it('an active announcement wins over a stale fire latch (declared/fired states unaffected)', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 2,
        causalGeneration: 2,
        subscriberId: 'su-emitter',
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
      fireLatch: {
        workspaceId: 'ws-x',
        eventKey: 'deploy:abcdef1',
        firstFiredAt: '2026-07-01T00:00:00.000Z',
        lastFiredAt: '2026-07-01T00:00:00.000Z',
        lastFiredBy: 'old-source',
        lastPayload: null,
        fireCount: 3,
      },
    } as never);
    const out = await call({ event: 'deploy:abcdef1' });
    expect(out.event_inspection.current_state).toBe('declared');
    // fire_latch is still surfaced (informational) even when an announcement governs current_state.
    expect(out.event_inspection.fire_latch).toBeTruthy();
    expect('advice' in out.event_inspection).toBe(false);
  });

  it('an exact current generation is in sync', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 2,
        causalGeneration: 2,
        subscriberId: 'su-emitter',
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    const out = await call({ event: 'deploy:abcdef1', after_generation: 2 });
    expect(out.event_inspection.resync).toMatchObject({ required: false, reason: 'in_sync' });
  });

  it('projects durable owner binding, ended declarer, and a live role successor', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 9,
        causalGeneration: 3,
        subscriberId: 'su-ended',
        boundTo: { kind: 'role', ref: 'release-fixer' },
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    vi.mocked(resolveLiveRoleHolders).mockResolvedValueOnce(['su-successor']);
    vi.mocked(resolveSessionStates).mockResolvedValueOnce(new Map([
      ['su-ended', { ownerId: 'su-ended', sessionState: 'ended' }],
      ['su-successor', { ownerId: 'su-successor', sessionState: 'parked' }],
    ]) as never);

    const out = await call({ event: 'gate:role-owner' });
    expect(resolveLiveRoleHolders).toHaveBeenCalledWith('release-fixer', { workspaceId: 'ws-x' });
    expect(resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-ended' }, { ownerId: 'su-successor' }],
      { hydratePerId: true, psuHostPositiveAuthority: true },
    );
    expect(out.event_inspection.declarations[0]).toMatchObject({
      bound_to: { kind: 'role', ref: 'release-fixer' },
      declared_by_liveness: 'ended',
      live_successor_ids: ['su-successor'],
    });
    expect(out.event_inspection.declarations[0]).not.toHaveProperty('stale_owner');
    // declared-gate recovery: a live successor with no producer certificate is
    // never escalated — progress is unprovable, so the waiter re-awaits the pin.
    expect(out.event_inspection.recovery).toMatchObject({
      event: 'gate:role-owner',
      announcement_id: 9,
      generation: 3,
      classification: 'unknown',
      escalation_target: null,
      next_verb: { verb: 'events:await', args: { event: 'gate:role-owner', after_generation: 3, on_timeout: 'wake' } },
    });
  });

  it('marks an active announcement stale only when its ended owner has no live successor', async () => {
    vi.mocked(inspectEventKey).mockResolvedValueOnce({
      announcements: [{
        id: 10,
        causalGeneration: 4,
        subscriberId: 'su-ended',
        boundTo: { kind: 'fleet-leadership', ref: 'fleet-a' },
        createdAt: '2026-07-13T12:00:00.000Z',
        firedAt: null,
        firedReason: null,
        cancelledAt: null,
        supersededAt: null,
        expectedCondition: null,
        firedPayload: null,
      }],
      waiters: [],
      deliveries: [],
    } as never);
    vi.mocked(hostAudienceResolvers.listFleetLeader).mockResolvedValueOnce(['su-ended']);
    vi.mocked(resolveSessionStates).mockResolvedValueOnce(new Map([
      ['su-ended', { ownerId: 'su-ended', sessionState: 'ended' }],
    ]) as never);

    const out = await call({ event: 'gate:fleet-owner' });
    expect(out.event_inspection.declarations[0]).toMatchObject({
      bound_to: { kind: 'fleet-leadership', ref: 'fleet-a' },
      declared_by_liveness: 'ended',
      live_successor_ids: [],
      stale_owner: true,
    });
    // No live owner, no catalog family, no fire history → never-fireable, and the
    // exact next verb retires THIS generation before a corrected re-await.
    expect(out.event_inspection.recovery).toMatchObject({
      announcement_id: 10,
      generation: 4,
      classification: 'never-fireable',
      idempotence_key: 'declared-gate-recovery:10:4:never-fireable',
      next_verb: {
        verb: 'events:cancel',
        args: { announcement_id: 10, expected_generation: 4 },
        target: { kind: 'declarer', ref: 'su-ended' },
      },
      evidence: {
        catalog: { status: 'measured', value: { member: false } },
        fire_history: { status: 'measured', value: { exactFired: false, familyFires: 0, priorGenerationFired: false } },
        owner_liveness: { status: 'measured', value: { declaredByLiveness: 'ended', liveSuccessorIds: [] } },
      },
    });
    // Read-only surface: no action is ever reported from events:status.
    expect(out.event_inspection.recovery).not.toHaveProperty('action');
  });
});

/**
 * EI-22075989127611832 / EI-25888525487132458 — selector conflicts must be
 * visible in the published schema, so callers do not discover the rule only
 * after dispatch returns a handler_error.
 */
describe('events:status — await_id/event exclusivity is declared, not only enforced', () => {
  it('publishes selector-exclusive branches instead of two unconstrained optionals', () => {
    const schema = z.toJSONSchema(status.args as never) as {
      anyOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
      oneOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
    };
    const branches = schema.anyOf ?? schema.oneOf ?? [];

    expect(branches).toHaveLength(3);
    expect(branches.some((branch) => branch.required?.includes('await_id'))).toBe(true);
    expect(branches.some((branch) => branch.required?.includes('event'))).toBe(true);
    expect(branches.some((branch) => !branch.required?.includes('await_id') && !branch.required?.includes('event'))).toBe(true);
    expect(JSON.stringify(schema)).toContain('mutually exclusive');
  });

  it('still refuses the combination at the handler', async () => {
    await expect(call({ await_id: 11, event: 'lock:grant:t1' }))
      .rejects.toThrow(/mutually exclusive/i);
  });
});

describe('events:status — workspace-global scope is explicit', () => {
  it('documents that harness/workspace are resolved by context, not JSON filters', () => {
    const schema = z.toJSONSchema(status.args as never) as Record<string, unknown>;

    expect(JSON.stringify(schema)).not.toMatch(/"harness"/);
    expect(JSON.stringify(schema)).not.toMatch(/"workspace"/);
    expect(status.description).toMatch(/workspace-global/i);
    expect(status.description).toMatch(/do not pass `harness` or `workspace`/i);
  });
});

describe('events:status result-door spill recovery', () => {
  it('keeps real caller-scoped handler output recoverable after ENOTDIR and leaves a small response unspilled', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'papercusp-status-spill-test-'));
    const scratchRoot = join(sandbox, 'scratch');
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousDoorOff = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    const runId = '11111111-2222-4333-8444-555555555555';
    const doorBudgetChars = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
    const doorOptions = {
      toolName: 'tools:invoke',
      nestedTargetToolName: 'events:status',
      workspaceId: 'ws-x',
      ownerId: 'su-status',
      runId,
    } as const;

    resetResultDoorAggregatesForTests();
    _resetScratchUsageForTests();
    process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;

    try {
      const controlHandlerResult = await status.handler({}, ctx) as unknown as DoorableResult;
      const controlText = (controlHandlerResult.content[0] as { type: 'text'; text: string }).text;
      const controlDoorResult = await applyResultDoorAsync(controlHandlerResult, doorOptions);
      expect(controlText.length).toBeLessThan(doorBudgetChars);
      expect(controlDoorResult.content).toEqual(controlHandlerResult.content);
      expect(controlDoorResult._meta?.resultDoor).toBeUndefined();
      expect(existsSync(scratchRoot)).toBe(false);
      expect(listActiveAwaits).toHaveBeenLastCalledWith('su-status');

      const note = 'caller-scoped await fixture '.repeat(80);
      const largeRows: AwaitRow[] = Array.from(
        { length: Math.ceil((doorBudgetChars * 1.5) / note.length) + 1 },
        (_, index) => ({
          ...AWAIT_ROW,
          id: 100 + index,
          eventKey: `lock:grant:spill-fixture-${index}`,
          note: `${index}: ${note}`,
        }),
      );
      vi.mocked(listActiveAwaits).mockResolvedValueOnce(largeRows);

      const handlerResult = await status.handler({}, ctx) as unknown as DoorableResult;
      const originalHandlerText = (handlerResult.content[0] as { type: 'text'; text: string }).text;
      expect(listActiveAwaits).toHaveBeenLastCalledWith('su-status');
      expect(originalHandlerText.length).toBeGreaterThan(doorBudgetChars);

      const blocker = join(sandbox, 'scratch-is-a-file');
      writeFileSync(blocker, 'x');
      process.env.PAPERCUSP_SCRATCH_ROOT = join(blocker, 'scratch');
      _resetScratchUsageForTests();

      // Pass the exact content returned by status.handler through the real nested-tool door.
      const doorResult = await applyResultDoorAsync(handlerResult, doorOptions);
      const resultText = (doorResult.content.find((item) => item.type === 'text') as { text: string }).text;
      const meta = doorResult._meta?.resultDoor as {
        spillFailed?: boolean;
        spillPath?: string | null;
        spillUri?: string | null;
        spillErrorCode?: string;
        recoveryCursor?: Record<string, unknown>;
      } | undefined;

      expect(resultText.length).toBeLessThan(originalHandlerText.length);
      expect(JSON.stringify(doorResult.content)).not.toContain(sandbox);
      expect(meta).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
        spillErrorCode: 'ENOTDIR',
        recoveryCursor: {
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
          reason: 'spill-write-failed',
        },
      });

      const cursor = meta?.recoveryCursor;
      if (!cursor) throw new Error('missing volatile recovery cursor');
      const cursorArgs = cursor.args && typeof cursor.args === 'object'
        ? cursor.args as Record<string, unknown>
        : undefined;
      const uri = typeof cursor.uri === 'string'
        ? cursor.uri
        : typeof cursorArgs?.uri === 'string'
          ? cursorArgs.uri
          : undefined;
      if (!uri) throw new Error('volatile recovery cursor has no URI');

      const reference = readVolatileScratchReference(uri, { workspaceId: 'ws-x', ownerId: 'su-status' });
      const bodyOffset = reference.manifest.bodyOffsetInPayload ?? 0;
      const recoveredPage = reference.payload.subarray(bodyOffset).toString('utf8');
      let recoveredText = recoveredPage;
      try {
        const recoveredEnvelope = JSON.parse(recoveredPage) as {
          content?: Array<{ type?: unknown; text?: unknown }>;
        };
        const text = recoveredEnvelope.content?.find((item) => item.type === 'text')?.text;
        if (typeof text === 'string') recoveredText = text;
      } catch {
        // Plain-text scratch pages already contain the exact original handler text.
      }
      expect(recoveredText).toBe(originalHandlerText);
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      if (previousDoorOff === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousDoorOff;
      resetResultDoorAggregatesForTests();
      _resetScratchUsageForTests();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
