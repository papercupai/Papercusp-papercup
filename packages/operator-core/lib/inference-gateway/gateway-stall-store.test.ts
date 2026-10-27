/**
 * gateway-stall-store — durable write-through for rate-limit stall candidates (EI-2431).
 *
 * Covers InMemoryGatewayStallStore and the Pg store's SQL parameters, without
 * writing synthetic stall events into the shared database.
 *
 * All tests run on a fixed fake clock (a real 2026-ish epoch, not near-zero) so the
 * store's real `Date.now() - STALL_MAX_AGE_MS` age cutoff behaves exactly as it does
 * in production instead of tripping on the Unix-epoch/`now` mismatch a near-zero
 * fake `at` would create.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));

import {
  InMemoryGatewayStallStore,
  configureGatewayStallStore,
  resetGatewayStallStore,
  recordGatewayStall,
  listGatewayStallsSince,
} from './gateway-stall-store';

const BASE = Date.parse('2026-07-18T00:00:00.000Z');

describe('gateway-stall-store — durable stall write-through (EI-2431)', () => {
  beforeEach(() => {
    configureGatewayStallStore(new InMemoryGatewayStallStore());
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    resetGatewayStallStore();
    vi.useRealTimers();
  });

  it('records a stall and lists it back since a watermark before it', async () => {
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 12345, at: BASE }, 'default');
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 12345, at: BASE });
  });

  it('rounds reset deadlines up and recorded times down to integer milliseconds', async () => {
    const event = { ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 12345.5, at: BASE + 0.75 };
    await recordGatewayStall(event, 'default');
    expect(await listGatewayStallsSince(BASE - 0.5)).toEqual([
      { ...event, soonestResetAt: BASE + 12346, at: BASE },
    ]);
    expect(await listGatewayStallsSince(BASE + 0.5)).toEqual([]);
    expect(event.at).toBe(BASE + 0.75);
    expect(event.soonestResetAt).toBe(BASE + 12345.5);
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid epoch milliseconds (%s) before recording a stall',
    async (invalid) => {
      const event = { ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 1000, at: BASE };
      await expect(recordGatewayStall({ ...event, soonestResetAt: invalid }, 'default')).rejects.toThrow('soonestResetAt');
      await expect(recordGatewayStall({ ...event, at: invalid }, 'default')).rejects.toThrow('at');
      await expect(listGatewayStallsSince(invalid)).rejects.toThrow('sinceMs');
      expect(await listGatewayStallsSince(BASE - 1)).toEqual([]);
    },
  );

  it('excludes stalls at/before the watermark (since is exclusive, matching the in-memory ring contract)', async () => {
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    await recordGatewayStall({ ownerId: 'bee-2', accountId: 'acct-a', soonestResetAt: 2, at: BASE + 1000 }, 'default');
    const rows = await listGatewayStallsSince(BASE);
    expect(rows.map((r) => r.ownerId)).toEqual(['bee-2']);
  });

  it('returns rows oldest-first, mirroring the order the waker folds them in', async () => {
    await recordGatewayStall({ ownerId: 'bee-2', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 3000 }, 'default');
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 1000 }, 'default');
    const rows = await listGatewayStallsSince(BASE);
    expect(rows.map((r) => r.at)).toEqual([BASE + 1000, BASE + 3000]);
  });

  it('survives a "gateway restart" — the store is independent of any gateway-process in-memory state', async () => {
    // Simulates the exact EI-2431 race: a stall is recorded, then (from the store's point of
    // view) nothing about the gateway process matters — the row is durable in its own right.
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 999, at: BASE }, 'default');
    // "restart" = a fresh listGatewayStallsSince call with no shared in-process state required.
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe('bee-1');
  });

  it("prunes rows past the max age on write (mirrors the in-memory ring's own age-based prune)", async () => {
    await recordGatewayStall({ ownerId: 'bee-old', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    // Advance past the 4h max-age window, then record a new stall — the old one is pruned on write.
    vi.setSystemTime(BASE + 5 * 60 * 60_000);
    await recordGatewayStall(
      { ownerId: 'bee-new', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 5 * 60 * 60_000 },
      'default',
    );
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows.map((r) => r.ownerId)).toEqual(['bee-new']);
  });

  it('listSince also floors at the max-age cutoff even when since=0 (a fresh waker instance never replays hours-old stalls)', async () => {
    await recordGatewayStall({ ownerId: 'bee-old', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    vi.setSystemTime(BASE + 5 * 60 * 60_000);
    const rows = await listGatewayStallsSince(0);
    expect(rows).toHaveLength(0);
  });
});

describe('gateway-stall-store — PostgreSQL timestamp boundary (EI-26968689642201896)', () => {
  beforeEach(() => {
    resetGatewayStallStore();
    sql.mockReset();
    sql.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    resetGatewayStallStore();
    vi.useRealTimers();
  });

  it('binds fractional reset arithmetic as bigint-compatible integer milliseconds', async () => {
    const event = { ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: 1792945979692.5, at: BASE + 0.75 };
    await recordGatewayStall(event, 'default');
    expect(sql.mock.calls[0][0].join('')).toContain('INSERT INTO harness_shared.gateway_stall_events');
    expect(sql.mock.calls[0].slice(1)).toEqual(['default', 'bee-1', 'acct-a', 1792945979693, BASE]);
    expect(sql.mock.calls[1][0].join('')).toContain('DELETE FROM harness_shared.gateway_stall_events');
    expect(sql.mock.calls[1].slice(1)).toEqual([BASE - 4 * 60 * 60_000]);

    sql.mockResolvedValueOnce([
      { owner_id: 'bee-1', account_id: 'acct-a', soonest_reset_at: '1792945979693', recorded_at_ms: String(BASE) },
    ]);
    expect(await listGatewayStallsSince(BASE - 0.5)).toEqual([
      { ...event, soonestResetAt: 1792945979693, at: BASE },
    ]);
    expect(sql.mock.calls[2].slice(1)).toEqual([BASE - 1]);
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid epoch milliseconds (%s) before issuing SQL',
    async (invalid) => {
      const event = { ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 1000, at: BASE };
      await expect(recordGatewayStall({ ...event, soonestResetAt: invalid }, 'default')).rejects.toThrow('soonestResetAt');
      await expect(recordGatewayStall({ ...event, at: invalid }, 'default')).rejects.toThrow('at');
      await expect(listGatewayStallsSince(invalid)).rejects.toThrow('sinceMs');
      expect(sql).not.toHaveBeenCalled();
    },
  );
});
