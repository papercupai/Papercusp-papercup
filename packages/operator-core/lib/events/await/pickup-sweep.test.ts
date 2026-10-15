/**
 * pickup-sweep.test.ts — the P-006 slice 2 orchestrator (WI-10008157, D-004) with its store and
 * host reads injected. The SQL half is pinned in await-store.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./store', () => ({
  observeAwaitingTurnProofs: vi.fn(async () => {
    throw new Error('default store must not be reached when deps are injected');
  }),
  listExpiredPickups: vi.fn(async () => {
    throw new Error('default store must not be reached when deps are injected');
  }),
  settleExpiredPickup: vi.fn(async () => {
    throw new Error('default store must not be reached when deps are injected');
  }),
}));
vi.mock('./psu-pty-discovery', () => ({
  findLiveHostAsync: vi.fn(async () => null),
  readHostEventTailAsync: vi.fn(async () => []),
}));

const { runPickupSweep, readPickupHostView, PICKUP_SWEEP_SOURCE } = await import('./pickup-sweep');
const discovery = await import('./psu-pty-discovery');
import type { ExpiredPickupRow } from './store';
import type { PickupHostView } from './turn-proof';

const T0 = Date.parse('2026-10-10T19:00:00Z');

function row(id: number, subscriberId: string, channel: string | null, extra: Partial<ExpiredPickupRow> = {}): ExpiredPickupRow {
  return {
    id,
    awaitId: 1000 + id,
    subscriberId,
    eventKey: `loop:fire:${subscriberId}`,
    channel,
    source: null,
    deliveredAtMs: T0,
    pickupDeadlineAtMs: T0 + 600_000,
    ...extra,
  };
}

function harness(rows: ExpiredPickupRow[], hosts: Record<string, PickupHostView | null>, opts: { lose?: number[] } = {}) {
  const settled: Array<{ id: number; proof: string; escalate?: boolean; turnStartedAtMs?: number | null }> = [];
  const emits: Array<{ key: string; payload: unknown; summary: string; source: string }> = [];
  const hostReads: string[] = [];
  let nextRequeue = 9000;
  const deps = {
    observe: vi.fn(async () => 3),
    listExpired: vi.fn(async () => rows),
    settle: vi.fn(async (input: { id: number; proof: 'observed' | 'not-picked-up'; escalate?: boolean; turnStartedAtMs?: number | null }) => {
      if (opts.lose?.includes(input.id)) return { settled: false, requeuedDeliveryId: null };
      settled.push(input);
      return { settled: true, requeuedDeliveryId: input.escalate ? nextRequeue++ : null };
    }),
    readHost: vi.fn(async (sub: string) => {
      hostReads.push(sub);
      return hosts[sub] ?? null;
    }),
    emit: vi.fn(async (o: { key: string; payload: unknown; summary: string; source: string }) => {
      emits.push(o);
    }),
  };
  return { deps, settled, emits, hostReads };
}

describe('runPickupSweep', () => {
  it('runs the tool-evidence pass first and stops when nothing has expired', async () => {
    const h = harness([], {});
    const stats = await runPickupSweep(h.deps);
    expect(h.deps.observe).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ observed: 3, observedByHost: 0, notPickedUp: 0, escalated: 0, emitted: 0 });
    expect(h.deps.readHost).not.toHaveBeenCalled();
    expect(h.emits).toEqual([]);
  });

  it('settles a host-observed turn as observed with the host turn-start time, and emits nothing for it', async () => {
    const h = harness([row(1, 'su-a', 'psu-socket-inject')], {
      'su-a': { execution: { phase: 'running', turnStartedAt: T0 + 42_000 } },
    });
    const stats = await runPickupSweep(h.deps);
    expect(h.settled).toEqual([{ id: 1, proof: 'observed', turnStartedAtMs: T0 + 42_000 }]);
    expect(stats.observedByHost).toBe(1);
    expect(stats.notPickedUp).toBe(0);
    expect(h.emits).toEqual([]);
  });

  it('marks unpicked deliveries, re-queues only the recoverable turn channel, and emits ONE report per subscriber', async () => {
    const h = harness(
      [
        row(1, 'su-a', 'psu-socket-inject'),
        row(2, 'su-a', 'inbox'),
        row(3, 'su-b', 'inbox'),
      ],
      { 'su-a': { authBlocked: true }, 'su-b': null },
    );
    const stats = await runPickupSweep(h.deps);

    expect(h.settled).toEqual([
      { id: 1, proof: 'not-picked-up', escalate: true },
      { id: 2, proof: 'not-picked-up', escalate: false },
      { id: 3, proof: 'not-picked-up', escalate: false },
    ]);
    expect(stats).toMatchObject({ notPickedUp: 3, escalated: 1, emitted: 2 });
    // The host is read once per subscriber per tick, not once per delivery.
    expect(h.hostReads).toEqual(['su-a', 'su-b']);

    expect(h.emits.map((e) => e.key)).toEqual(['wake:not-picked-up:su-a', 'wake:not-picked-up:su-b']);
    expect(h.emits.every((e) => e.source === PICKUP_SWEEP_SOURCE)).toBe(true);
    expect(h.emits[0].payload).toMatchObject({
      subscriberId: 'su-a',
      deliveryIds: [1, 2],
      channels: ['psu-socket-inject', 'inbox'],
      escalated: [{ deliveryId: 1, requeuedDeliveryId: 9000, recoverable: 'auth-blocked' }],
    });
    expect(h.emits[0].summary).toContain('1 re-queued for host recovery');
    expect(h.emits[1].payload).toMatchObject({ subscriberId: 'su-b', deliveryIds: [3], escalated: [] });
  });

  it('does not count or report a row a concurrent observe/ack already resolved', async () => {
    const h = harness([row(1, 'su-a', 'inbox'), row(2, 'su-a', 'inbox')], { 'su-a': null }, { lose: [1] });
    const stats = await runPickupSweep(h.deps);
    expect(stats.notPickedUp).toBe(1);
    expect(h.emits[0].payload).toMatchObject({ deliveryIds: [2] });
  });

  it('is fail-soft: a host read or emit failure neither throws nor skips the remaining rows', async () => {
    const h = harness([row(1, 'su-a', 'psu-socket-inject'), row(2, 'su-b', 'inbox')], {});
    h.deps.readHost.mockImplementationOnce(async () => {
      throw new Error('EIO');
    });
    h.deps.emit.mockImplementationOnce(async () => {
      throw new Error('pg down');
    });
    const lines: string[] = [];
    const stats = await runPickupSweep({ ...h.deps, log: (l) => lines.push(l) });
    // An unreadable host is "no host": reported, never escalated.
    expect(h.settled).toEqual([
      { id: 1, proof: 'not-picked-up', escalate: false },
      { id: 2, proof: 'not-picked-up', escalate: false },
    ]);
    expect(stats).toMatchObject({ notPickedUp: 2, escalated: 0, emitted: 1 });
    expect(lines.some((l) => l.includes('host read failed') && l.includes('EIO'))).toBe(true);
    expect(lines.some((l) => l.includes('emit failed') && l.includes('pg down'))).toBe(true);
  });
});

describe('readPickupHostView', () => {
  it('returns null when the subscriber has no live psu host', async () => {
    vi.mocked(discovery.findLiveHostAsync).mockResolvedValueOnce(null);
    expect(await readPickupHostView('su-gone')).toBeNull();
  });

  it('carries the host block flags and execution, and judges the tail with the shared D-007 judge', async () => {
    vi.mocked(discovery.findLiveHostAsync).mockResolvedValueOnce({
      ownerId: 'su-a',
      advSessionId: null,
      pid: 1,
      ptyPid: 2,
      sock: '/tmp/x.sock',
      command: 'codex',
      startedAt: T0,
      authBlocked: true,
      quotaBlocked: false,
      execution: { phase: 'failed', turnStartedAt: T0 + 1, lastProgressAt: null, pendingTools: 0, observedAt: T0 + 2 },
    });
    vi.mocked(discovery.readHostEventTailAsync).mockResolvedValueOnce([
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: '2026-10-10T19:00:01Z' },
      { kind: 'respawn-binding-confirmed', ts: '2026-10-10T19:00:02Z' },
      { kind: 'wake-inject', ts: '2026-10-10T19:00:03Z' },
    ]);
    const view = await readPickupHostView('su-a');
    expect(view).toEqual({
      execution: { phase: 'failed', turnStartedAt: T0 + 1, lastProgressAt: null, pendingTools: 0, observedAt: T0 + 2 },
      authBlocked: true,
      quotaBlocked: false,
      unboundSuccessor: false,
      stuckPending: null,
    });
  });

  it('reads an unbindable child of the CURRENT host as unbound, but not a predecessor one', async () => {
    const host = {
      ownerId: 'su-a',
      advSessionId: null,
      pid: 1,
      ptyPid: 2,
      sock: '/tmp/x.sock',
      command: 'codex',
      startedAt: T0,
    };
    vi.mocked(discovery.findLiveHostAsync).mockResolvedValueOnce(host);
    vi.mocked(discovery.readHostEventTailAsync).mockResolvedValueOnce([
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: '2026-10-10T19:00:01Z' },
    ]);
    expect(await readPickupHostView('su-a')).toMatchObject({ unboundSuccessor: true });

    vi.mocked(discovery.findLiveHostAsync).mockResolvedValueOnce(host);
    vi.mocked(discovery.readHostEventTailAsync).mockResolvedValueOnce([
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: '2026-10-10T18:59:00Z' },
    ]);
    expect(await readPickupHostView('su-a')).toMatchObject({ unboundSuccessor: false });
  });

  it('treats an unreadable event tail as no binding reading, never as unbound', async () => {
    vi.mocked(discovery.findLiveHostAsync).mockResolvedValueOnce({
      ownerId: 'su-a',
      advSessionId: null,
      pid: 1,
      ptyPid: 2,
      sock: '/tmp/x.sock',
      command: 'claude',
      startedAt: T0,
    });
    vi.mocked(discovery.readHostEventTailAsync).mockRejectedValueOnce(new Error('EACCES'));
    expect(await readPickupHostView('su-a')).toMatchObject({ unboundSuccessor: false, stuckPending: null });
  });
});
