// @vitest-environment node
/**
 * P-010 (voice-production-test-coverage) — SSE reconnect / network-drop
 * resilience, deterministic slice.
 *
 * The desktop voice path is SSE-primary: voice state-snapshots ride the
 * sync_invalidate SSE bus (sync-sse.ts). The resilience that's unit-testable
 * here is the SOURCE side — notifySyncInvalidate's dedupe (prevents the
 * notify-storm/flicker when a reconnect cascade or the 60s reconcile sweep
 * fires identical invalidations) and the transport byte-cap fallback (a big voice
 * state-snapshot degrades to invalidate-then-refetch instead of blowing the
 * frame).
 *
 * The Last-Event-ID *replay* (backfillSince) needs a live PG LISTEN/NOTIFY to
 * populate the ring, so it's an integration test (real-PG cluster). The
 * WebRTC-drop reconnect lives in the EL/OpenAI SDKs (E2E, P-007); the mobile
 * WS keepalive that enables phone reconnect is covered in P-001.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql, db: {} }) };
});

import { notifySyncInvalidate } from './sync-sse';

/** The JSON payload handed to pg_notify on the Nth sql call.
 *  SQL is `SELECT pg_notify(${channel}, ${payload})` — channel is bound
 *  param [1], payload is [2] (the @papercusp/sync/server/pg adapter
 *  parameterizes the channel). */
function payloadOf(call = 0): { name: string; args?: unknown; data?: unknown } {
  return JSON.parse(String(sql.mock.calls[call][2]));
}

beforeEach(() => {
  sql.mockClear();
  sql.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('notifySyncInvalidate — payload shaping', () => {
  it('fires pg_notify with name only when no args/data', async () => {
    await notifySyncInvalidate('voiceState.p010a');
    expect(sql).toHaveBeenCalledTimes(1);
    expect(payloadOf()).toEqual({ name: 'voiceState.p010a' });
  });

  it('includes args and data when provided', async () => {
    await notifySyncInvalidate('voiceState.p010b', { workspaceId: 'w1' }, [{ row: 1 }]);
    expect(payloadOf()).toEqual({ name: 'voiceState.p010b', args: { workspaceId: 'w1' }, data: [{ row: 1 }] });
  });

  it('strips an oversized data payload — client falls back to refetch', async () => {
    const big = [{ blob: 'x'.repeat(40_000) }];
    await notifySyncInvalidate('voiceState.p010c', { workspaceId: 'w1' }, big);
    const p = payloadOf();
    expect(p).toEqual({ name: 'voiceState.p010c', args: { workspaceId: 'w1' } });
    expect(p.data).toBeUndefined();
  });

  it('keeps oversized UTF-8 args under PostgreSQL’s limit and preserves a name-only invalidation', async () => {
    await notifySyncInvalidate('voiceState.p010h', { identity: 'é'.repeat(5_000) });

    expect(sql).toHaveBeenCalledTimes(1);
    const payloadJson = String(sql.mock.calls[0][2]);
    expect(new TextEncoder().encode(payloadJson).byteLength).toBeLessThan(8_000);
    expect(JSON.parse(payloadJson)).toEqual({ name: 'voiceState.p010h' });
  });
});

describe('notifySyncInvalidate — dedupe (notify-storm suppression)', () => {
  it('suppresses an identical (name,args) notify within the window', async () => {
    await notifySyncInvalidate('voiceState.p010d', { workspaceId: 'w1' });
    await notifySyncInvalidate('voiceState.p010d', { workspaceId: 'w1' });
    expect(sql).toHaveBeenCalledTimes(1); // second is deduped
  });

  it('does NOT dedupe data-bearing notifies that carry different rows', async () => {
    await notifySyncInvalidate('voiceState.p010e', { workspaceId: 'w1' }, [{ v: 1 }]);
    await notifySyncInvalidate('voiceState.p010e', { workspaceId: 'w1' }, [{ v: 2 }]);
    expect(sql).toHaveBeenCalledTimes(2); // distinct data → distinct dedupe key
  });

  it('treats different args as distinct events', async () => {
    await notifySyncInvalidate('voiceState.p010f', { workspaceId: 'a' });
    await notifySyncInvalidate('voiceState.p010f', { workspaceId: 'b' });
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

describe('notifySyncInvalidate — failure handling', () => {
  it('swallows a pg_notify failure (sync degrades, app keeps working)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sql.mockRejectedValueOnce(new Error('pg down'));
    await expect(notifySyncInvalidate('voiceState.p010g')).resolves.toBeUndefined();
  });

  it.each([
    [
      'CONNECTION_ENDED by code',
      Object.assign(new Error('write CONNECTION_ENDED localhost:32768'), { code: 'CONNECTION_ENDED' }),
    ],
    ['CONNECTION_ENDED by message', new Error('write CONNECTION_ENDED localhost:32768')],
    ['CONNECTION_DESTROYED by code', Object.assign(new Error('connection closed'), { code: 'CONNECTION_DESTROYED' })],
    ['partial schema', new Error('relation "harness_shared.learning_improvements" does not exist')],
  ])('does not log expected detached-teardown failures: %s', async (_label, thrown) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sql.mockRejectedValueOnce(thrown);

    await expect(notifySyncInvalidate(`voiceState.teardown.${String(_label)}`)).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('still logs unexpected notify failures loudly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('pg connection pool is wedged');
    sql.mockRejectedValueOnce(thrown);

    await expect(notifySyncInvalidate('voiceState.unexpected-failure')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[sync-sse] notify failed:', thrown);
  });
});
