// @vitest-environment node
/**
 * sync-sse-backfill.integration.test.ts — the SSE reconnect REPLAY half of
 * P-010, against real testcontainer PG LISTEN/NOTIFY.
 *
 * On reconnect a client sends Last-Event-ID; backfillSince(lastId) replays the
 * events it missed from the 60s ring. The ring is only populated by the live
 * PG `sync_invalidate` LISTEN, so this needs a real connection: we subscribe(),
 * fire notifySyncInvalidate (→ pg_notify), and assert the listener fans out +
 * backfillSince replays exactly the newer events. (The source-side dedupe +
 * payload-strip half is unit-tested in sync-sse-notify.test.ts.)
 *
 * P-010 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ url: '', sql: null as unknown as import('postgres').Sql }));

vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => h.url,
  // sync-sse now resolves the URL via the source-annotated variant — keep both exports in step.
  getHarnessAdminUrlWithSource: () => ({ url: h.url, source: 'test-mock' }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql, db: {} }) };
});

import { subscribe, backfillSince, notifySyncInvalidate } from './sync-sse';

let dbName: string;
let adminUri: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `sse_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  h.url = u.toString();
  h.sql = postgres(h.url, { max: 4, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await h.sql?.end({ timeout: 5 }).catch(() => {});
  const a = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* the live LISTEN connection may still hold it briefly */
  } finally {
    await a.end({ timeout: 5 });
  }
});

describe('sync-sse reconnect replay (Last-Event-ID → backfillSince)', () => {
  it('fans out live events and replays only those newer than the last-seen id', async () => {
    const received: Array<{ id: number; name: string }> = [];
    await subscribe((e) => received.push({ id: e.id, name: e.name }));

    await notifySyncInvalidate('voiceState.alpha', { ws: 'w1' });
    await notifySyncInvalidate('voiceState.beta', { ws: 'w1' });
    await notifySyncInvalidate('voiceState.gamma', { ws: 'w1' });

    // LISTEN delivery is async — wait until all three land.
    await vi.waitFor(
      () => expect(received.filter((e) => e.name.startsWith('voiceState.')).length).toBe(3),
      { timeout: 5000 },
    );

    const ours = received.filter((e) => e.name.startsWith('voiceState.'));
    const names = (lastId: number) =>
      backfillSince(lastId).filter((e) => e.name.startsWith('voiceState.')).map((e) => e.name);

    // Full resume from scratch (Last-Event-ID 0) replays all three in order.
    expect(names(0)).toEqual(['voiceState.alpha', 'voiceState.beta', 'voiceState.gamma']);
    // Resume after the first → only the two newer events.
    expect(names(ours[0].id)).toEqual(['voiceState.beta', 'voiceState.gamma']);
    // Caught-up reconnect → nothing to replay.
    expect(names(ours[2].id)).toEqual([]);
  });
});
