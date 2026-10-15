/**
 * cancel.test.ts — events:cancel dual-path result (GAP 5).
 *
 * Deps mocked (cancelAwaitDetailed / ackDelivery / resolveAgentIdentity). Asserts the
 * await_id-only / delivery_id-only / both result rules, and the asymmetric
 * ok-flip rule: an ack-miss only flips ok=false when await_id == null (so an
 * ack-miss riding alongside a successful cancel never poisons the result).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invalidInputCorrections, strictArgs, unknownArgHint } from '@papercusp/tooldef/define-tool';

const identityState = vi.hoisted(() => ({ workspaceId: 'ws-x' as string | null }));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-canceller', ownerLabel: 'c', source: 'static-client', workspaceId: identityState.workspaceId, userId: null }),
}));
vi.mock('../../events/await/store', () => ({
  cancelAwaitDetailed: vi.fn(),
  ackDelivery: vi.fn(),
  retireAnnouncement: vi.fn(),
}));
vi.mock('../../harness/routines/loop-fire', () => ({
  rebaseLoopAfterAwaitCancellation: vi.fn(),
}));

import cancel from './cancel';
import { cancelAwaitDetailed, ackDelivery, retireAnnouncement } from '../../events/await/store';
import { rebaseLoopAfterAwaitCancellation } from '../../harness/routines/loop-fire';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof cancel.handler>[1];
const call = async (args: Record<string, unknown>, context = ctx) => {
  const res = (await cancel.handler(args as never, context)) as { data?: any; content?: Array<{ text: string }> };
  return res.data ?? JSON.parse(res.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  identityState.workspaceId = 'ws-x';
  vi.mocked(rebaseLoopAfterAwaitCancellation).mockResolvedValue(0);
});

const cancelledAwait = (overrides: Record<string, unknown> = {}) => ({
  awaitId: 7,
  cancelled: true,
  eventKey: 'work-item:claimable',
  once: true,
  expiresTs: '2026-09-06T05:00:00.000Z',
  droppedDeliveries: 0,
  inFlightDeliveries: 0,
  ...overrides,
});

describe('events:cancel dual-path result', () => {
  it('lets evidence-only judges ACK their own wake deliveries and refuses broader cancellation', async () => {
    const judgeCtx = { ...ctx, role: 'judge' } as unknown as Parameters<typeof cancel.handler>[1];
    expect(cancel.agentRoles).toContain('judge');
    vi.mocked(ackDelivery).mockResolvedValue({ acked: true, alreadySettled: false });

    const out = await call({ delivery_id: 3 }, judgeCtx);

    expect(ackDelivery).toHaveBeenCalledWith({ deliveryId: 3, subscriberId: 'su-canceller' });
    expect(out).toMatchObject({ ok: true, results: [{ delivery_id: 3, acked: true }] });
    await expect(call({ await_id: 7 }, judgeCtx)).rejects.toThrow(/evidence-only judges may only acknowledge/);
    await expect(call({ items: [{ delivery_id: 3, announcement_id: 41 }] }, judgeCtx)).rejects.toThrow(
      /evidence-only judges may only acknowledge/,
    );
    expect(cancelAwaitDetailed).not.toHaveBeenCalled();
    expect(retireAnnouncement).not.toHaveBeenCalled();
  });

  it.each([
    ['await', { await_id: 7 }],
    ['delivery', { delivery_id: 3 }],
    ['batch', { await_ids: [7], delivery_ids: [3] }],
  ])('explains the internal reason boundary for a rejected %s call without changing its IDs', (_kind, selectedIds) => {
    const schema = strictArgs(cancel.args);
    const input = { ...selectedIds, reason: 'cleanup' };
    const rejected = schema.safeParse(input);
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('reason must remain an internal cancellation field');

    const corrections = invalidInputCorrections(rejected.error.issues, cancel.args, cancel.guidance?.argRedirects, input);
    expect(corrections).toMatchObject([{ rejectedArg: 'reason', kind: 'authored-drop' }]);
    const hint = unknownArgHint(rejected.error.issues, cancel.args, cancel.guidance?.argRedirects, input, 'events:cancel');
    expect(hint).toContain('drop the key');
    expect(hint).toContain('cancel_reason database requirement');
    expect(hint).toContain('records operator internally');
    expect(hint).toContain('delivery_id only ACKs');
    expect(schema.parse(selectedIds)).toEqual(selectedIds);
  });

  it('cancel-only success → ok:true, cancelled:true, no reason', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    const out = await call({ await_id: 7 });
    // WI-3575: cancelAwait no longer takes workspaceId (events:await is
    // single-workspace by design — see store.ts).
    expect(cancelAwaitDetailed).toHaveBeenCalledWith({
      awaitId: 7,
      subscriberId: 'su-canceller',
      source: 'operator',
      confirmStanding: undefined,
    });
    expect(ackDelivery).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{
        ok: true,
        await_id: 7,
        cancelled: true,
        event: 'work-item:claimable',
        once: true,
        expires_ts: '2026-09-06T05:00:00.000Z',
        dropped_deliveries: 0,
        in_flight_deliveries: 0,
      }],
    });
    expect(out.results[0].error).toBeUndefined();
  });

  it('rechecks the owner loop cadence after a successful await cancellation', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(rebaseLoopAfterAwaitCancellation).mockResolvedValue(1);

    const out = await call({ await_id: 7 });

    expect(rebaseLoopAfterAwaitCancellation).toHaveBeenCalledWith({
      workspaceId: 'ws-x',
      targetOwnerId: 'su-canceller',
      eventKey: 'work-item:claimable',
    });
    expect(out.results[0]).toMatchObject({ ok: true, cancelled: true, loop_recheck_scheduled: 1 });
  });

  it('uses the concrete handler workspace when the resolved identity has none', async () => {
    identityState.workspaceId = null;
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(rebaseLoopAfterAwaitCancellation).mockResolvedValue(1);

    const out = await call({ await_id: 7 }, { workspaceId: 'ws-context' } as unknown as Parameters<typeof cancel.handler>[1]);

    expect(rebaseLoopAfterAwaitCancellation).toHaveBeenCalledWith({
      workspaceId: 'ws-context',
      targetOwnerId: 'su-canceller',
      eventKey: 'work-item:claimable',
    });
    expect(out.results[0]).toMatchObject({ ok: true, cancelled: true, loop_recheck_scheduled: 1 });
  });

  it('warns and skips the recheck when no concrete workspace is available', async () => {
    identityState.workspaceId = null;
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());

    const out = await call({ await_id: 7 }, {} as Parameters<typeof cancel.handler>[1]);

    expect(rebaseLoopAfterAwaitCancellation).not.toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ ok: true, cancelled: true });
    expect(out.results[0].warning).toMatch(/no concrete workspace ID is available/);
  });

  it('cancel-only miss → ok:false + the not_found reason', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue({
      awaitId: 7,
      cancelled: false,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
    });
    const out = await call({ await_id: 7 });
    expect(out).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 }, results: [{ ok: false, await_id: 7, cancelled: false, error: 'not_found_or_not_yours_or_already_settled' }] });
    expect(rebaseLoopAfterAwaitCancellation).not.toHaveBeenCalled();
  });

  it('ack-only success → ok:true, acked:true', async () => {
    vi.mocked(ackDelivery).mockResolvedValue({ acked: true, alreadySettled: false });
    const out = await call({ delivery_id: 3 });
    expect(ackDelivery).toHaveBeenCalledWith({ deliveryId: 3, subscriberId: 'su-canceller' });
    expect(cancelAwaitDetailed).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, delivery_id: 3, acked: true }] });
    expect(out.results[0].error).toBeUndefined();
  });

  it('ack-only miss (await_id==null) → ok:false + reason', async () => {
    vi.mocked(ackDelivery).mockResolvedValue({ acked: false, alreadySettled: false });
    const out = await call({ delivery_id: 3 });
    expect(out).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 }, results: [{ ok: false, delivery_id: 3, acked: false, error: 'not_found_or_not_yours_or_already_settled' }] });
  });

  it('ack-only in-flight delivery reports its status and reason', async () => {
    vi.mocked(ackDelivery).mockResolvedValue({ acked: false, alreadySettled: false, status: 'delivering' });

    const out = await call({ delivery_id: 3 });

    expect(out).toMatchObject({
      ok: false,
      counts: { ok: 0, failed: 1 },
      results: [{ ok: false, delivery_id: 3, acked: false, status: 'delivering', error: 'delivery_in_flight' }],
    });
    expect(out.results[0].warning).toMatch(/already in flight and cannot be recalled/);
  });

  it('reports a host-accepted cancellation as pending until the pre-write barrier is confirmed', async () => {
    vi.mocked(ackDelivery).mockResolvedValue({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
      cancellationRequested: true,
    });

    const out = await call({ delivery_id: 3 });

    expect(out).toMatchObject({
      ok: false,
      results: [{
        delivery_id: 3,
        acked: false,
        status: 'delivering',
        cancellation_requested: true,
      }],
    });
    expect(out.results[0].warning).toMatch(/has not confirmed its pre-write barrier/);
  });

  it('ack-only already-delivered result says the host handoff is not recallable', async () => {
    vi.mocked(ackDelivery).mockResolvedValue({ acked: false, alreadySettled: true, status: 'delivered' });
    const out = await call({ delivery_id: 3 });
    expect(out).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{ ok: true, delivery_id: 3, acked: false, already_settled: true, status: 'delivered', recallable: false }],
    });
    expect(out.results[0].warning).toMatch(/cannot be recalled/);
    expect(out.results[0].error).toBeUndefined();
  });

  it('both success → ok:true with both halves reported', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(ackDelivery).mockResolvedValue({ acked: true, alreadySettled: false });
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out.results[0]).toMatchObject({ ok: true, await_id: 7, cancelled: true, delivery_id: 3, acked: true });
    expect(out.results[0].error).toBeUndefined();
  });

  it('asymmetric: ack-miss + cancel-success → ok STAYS true (the miss does not flip when await_id != null)', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(ackDelivery).mockResolvedValue({ acked: false, alreadySettled: false });
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out.results[0]).toMatchObject({ ok: true, cancelled: true, acked: false });
    expect(out.results[0].error).toBeUndefined();
  });

  it('combined cancellation surfaces an in-flight ACK without failing the cancelled await', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(ackDelivery).mockResolvedValue({ acked: false, alreadySettled: false, status: 'delivering' });

    const out = await call({ await_id: 7, delivery_id: 3 });

    expect(out.results[0]).toMatchObject({ ok: true, cancelled: true, acked: false, status: 'delivering' });
    expect(out.results[0].warning).toMatch(/already in flight and cannot be recalled/);
    expect(out.results[0].error).toBeUndefined();
  });

  it('symmetric counter-case: cancel-miss + ack-success → ok flips false (cancel always flips)', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue({
      awaitId: 7,
      cancelled: false,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
    });
    vi.mocked(ackDelivery).mockResolvedValue({ acked: true, alreadySettled: false });
    const out = await call({ await_id: 7, delivery_id: 3 });
    expect(out.results[0]).toMatchObject({ ok: false, cancelled: false, acked: true, error: 'not_found_or_not_yours_or_already_settled' });
  });

  it('refuses a standing watch without explicit confirmation', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue({
      awaitId: 7,
      cancelled: false,
      eventKey: 'work-item:claimable',
      once: false,
      expiresTs: null,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
      error: 'standing_watch_requires_confirmation',
    });
    const out = await call({ await_id: 7 });
    expect(out).toMatchObject({
      counts: { ok: 0, failed: 1 },
      results: [{
        ok: false,
        await_id: 7,
        cancelled: false,
        event: 'work-item:claimable',
        once: false,
        expires_ts: null,
        error: 'standing_watch_requires_confirmation',
      }],
    });
  });

  it('surfaces the active-loop inbox-wake refusal and keeps the loop recheck untouched', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue({
      awaitId: 7,
      cancelled: false,
      eventKey: 'coord:inbox-wake:su-canceller',
      once: false,
      expiresTs: null,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
      error: 'active_loop_inbox_wake_requires_loop_end',
    });

    const out = await call({ await_id: 7, confirm_standing: true });

    expect(out).toMatchObject({
      counts: { ok: 0, failed: 1 },
      results: [{
        ok: false,
        await_id: 7,
        cancelled: false,
        event: 'coord:inbox-wake:su-canceller',
        once: false,
        error: 'active_loop_inbox_wake_requires_loop_end',
      }],
    });
    expect(rebaseLoopAfterAwaitCancellation).not.toHaveBeenCalled();
    expect(cancel.guidance?.returns).toContain('active_loop_inbox_wake_requires_loop_end');
    expect(cancel.guidance?.returns).toContain('loop:end');
    expect(cancel.guidance?.returns).toContain('may explicitly opt out');
  });

  it('reports queued drops and in-flight deliveries for an explicitly confirmed standing watch', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue({
      awaitId: 7,
      cancelled: true,
      eventKey: 'work-item:claimable',
      once: false,
      expiresTs: null,
      droppedDeliveries: 16,
      inFlightDeliveries: 1,
    });
    const out = await call({ await_id: 7, confirm_standing: true });
    expect(cancelAwaitDetailed).toHaveBeenCalledWith({
      awaitId: 7,
      subscriberId: 'su-canceller',
      source: 'operator',
      confirmStanding: true,
    });
    expect(out).toMatchObject({
      counts: { ok: 1, failed: 0 },
      results: [{
        ok: true,
        await_id: 7,
        cancelled: true,
        dropped_deliveries: 16,
        in_flight_deliveries: 1,
      }],
    });
    expect(out.results[0].warning).toMatch(/already in flight/);
  });

  it('await_ids + delivery_ids are handled as one keyed batch', async () => {
    vi.mocked(cancelAwaitDetailed).mockResolvedValue(cancelledAwait());
    vi.mocked(ackDelivery).mockResolvedValue({ acked: true, alreadySettled: false });
    const out = await call({ await_ids: [7, 8], delivery_ids: [3] });
    expect(out.counts).toEqual({ ok: 3, failed: 0 });
    expect(out.results.map((r: any) => r.await_id ?? r.delivery_id)).toEqual([7, 8, 3]);
    expect(cancelAwaitDetailed).toHaveBeenCalledTimes(2);
    expect(ackDelivery).toHaveBeenCalledTimes(1);
  });

  it('retires an announced declaration with an optional generation guard', async () => {
    vi.mocked(retireAnnouncement).mockResolvedValue({
      retired: true,
      announcementId: 41,
      eventKey: 'fleet:f1:gate-open',
      generation: 3,
      supersededAt: '2026-08-25T08:00:00.000Z',
    });
    const out = await call({ announcement_id: 41, expected_generation: 3 });
    expect(retireAnnouncement).toHaveBeenCalledWith({
      announcementId: 41,
      subscriberId: 'su-canceller',
      expectedGeneration: 3,
    });
    expect(out).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{
        ok: true,
        announcement_id: 41,
        retired: true,
        event: 'fleet:f1:gate-open',
        generation: 3,
      }],
    });
  });

  it('reports a generation mismatch without touching ordinary await cancellation', async () => {
    vi.mocked(retireAnnouncement).mockResolvedValue({
      retired: false,
      announcementId: 41,
      reason: 'generation_mismatch',
    });
    const out = await call({ announcement_id: 41, expected_generation: 2 });
    expect(cancelAwaitDetailed).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      counts: { ok: 0, failed: 1 },
      results: [{ ok: false, announcement_id: 41, retired: false, error: 'generation_mismatch' }],
    });
  });

  it('accepts announcement_ids in the bulk surface', async () => {
    vi.mocked(retireAnnouncement).mockResolvedValue({ retired: true, announcementId: 41, generation: 1 });
    const out = await call({ announcement_ids: [41, 42] });
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
    expect(retireAnnouncement).toHaveBeenCalledTimes(2);
  });
});
