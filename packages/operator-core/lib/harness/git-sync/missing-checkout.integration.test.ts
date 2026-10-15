/**
 * WI-10006867 — the vanished-checkout lifecycle against real Postgres.
 *
 * What a fake-sql unit test cannot prove: that the first-seen `since` survives repeated
 * skips (the CASE inside the jsonb merge), that a malformed stored value is replaced rather
 * than crashing the cast, that retirement flips `active` and writes the same `pause` record
 * routines:set writes, and that a marker nulled by the outcome write restarts the clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  GIT_SYNC_MISSING_CHECKOUT_PAUSED_BY,
  GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS,
  readMissingCheckout,
  recordMissingCheckoutSkip,
} from './missing-checkout';

let sql: postgres.Sql;
const WS = 'ws-missing-checkout';
const SLUG = 'thornbury-iphone-20260821';
const T0 = Date.parse('2026-10-05T12:00:00Z');

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `missing_checkout_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  // Only the columns these writers read or write.
  await sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      install_slug text NOT NULL, workspace_id text NOT NULL, target_role text NOT NULL,
      active boolean DEFAULT true NOT NULL, metadata jsonb,
      updated_at timestamptz DEFAULT now() NOT NULL
    )`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.routines`);
  await sql.unsafe(
    `INSERT INTO harness_shared.routines (install_slug, workspace_id, target_role, metadata)
     VALUES ($1, $2, 'system:git-sync', '{"last_synced_at": 1}'::jsonb),
            ('papercusp', $2, 'system:git-sync', '{"last_status": "synced"}'::jsonb)`,
    [SLUG, WS],
  );
});

async function row(slug = SLUG): Promise<{ active: boolean; metadata: Record<string, unknown> }> {
  const [r] = await sql.unsafe(
    `SELECT active, metadata FROM harness_shared.routines WHERE install_slug = $1 AND workspace_id = $2`,
    [slug, WS],
  );
  return r as unknown as { active: boolean; metadata: Record<string, unknown> };
}

describe('recordMissingCheckoutSkip', () => {
  it('stamps the skip fields and a first-seen since, and keeps that since on later skips', async () => {
    const first = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: T0 });
    expect(first).toEqual({ since: T0, retired: false });
    const later = T0 + 60 * 60_000;
    const second = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/b', nowMs: later });
    expect(second).toEqual({ since: T0, retired: false });
    const { active, metadata } = await row();
    expect(active).toBe(true);
    expect(metadata).toMatchObject({
      last_status: 'skipped',
      local_sync_status: 'skipped',
      last_skip_reason: 'no_path',
      last_skipped_at: later,
      last_synced_at: 1,
    });
    expect(readMissingCheckout(metadata)).toEqual({ since: T0, path: '/gone/b' });
  });

  it('replaces a malformed stored since instead of failing the cast', async () => {
    await sql.unsafe(
      `UPDATE harness_shared.routines SET metadata = metadata || '{"missing_checkout": {"since": "bogus"}}'::jsonb
        WHERE install_slug = $1`,
      [SLUG],
    );
    const res = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: null, nowMs: T0 });
    expect(res).toEqual({ since: T0, retired: false });
    expect(readMissingCheckout((await row()).metadata)).toEqual({ since: T0, path: null });
  });

  it('retires the routine once the grace has elapsed, with the pause record routines:set writes', async () => {
    await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: T0 });
    const justBefore = T0 + GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS - 1;
    expect((await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: justBefore }))?.retired).toBe(false);
    expect((await row()).active).toBe(true);

    const due = T0 + GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS;
    const res = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: due });
    expect(res).toEqual({ since: T0, retired: true });
    const { active, metadata } = await row();
    expect(active).toBe(false);
    const pause = metadata.pause as Record<string, unknown>;
    expect(pause.pausedBy).toBe(GIT_SYNC_MISSING_CHECKOUT_PAUSED_BY);
    expect(pause.pausedAtMs).toBe(due);
    expect(String(pause.reason)).toContain('checkout /gone/a has been missing since 2026-10-05T12:00:00.000Z');
    expect(String(pause.reason)).toContain('routines:set { active:true }');
    // The first-seen clock survives retirement, so a bulk re-activation retires it again on the next fire.
    expect(readMissingCheckout(metadata)?.since).toBe(T0);
    // The sibling install is untouched.
    expect((await row('papercusp')).active).toBe(true);
  });

  it('does not re-retire (or re-stamp the pause on) a routine that is already inactive', async () => {
    await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: T0 });
    await sql.unsafe(`UPDATE harness_shared.routines SET active = false WHERE install_slug = $1`, [SLUG]);
    const res = await recordMissingCheckoutSkip(sql, {
      slug: SLUG,
      workspaceId: WS,
      path: '/gone/a',
      nowMs: T0 + 2 * GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS,
    });
    expect(res).toEqual({ since: T0, retired: false });
    expect((await row()).metadata.pause).toBeUndefined();
  });

  it('never retires when metadata is not a JSON object (a NULL since is not 1970)', async () => {
    await sql.unsafe(`UPDATE harness_shared.routines SET metadata = '[]'::jsonb WHERE install_slug = $1`, [SLUG]);
    const res = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: T0 });
    expect(res).toBeNull();
    expect((await row()).active).toBe(true);
  });

  it('returns null for an install with no routine row', async () => {
    expect(await recordMissingCheckoutSkip(sql, { slug: 'no-such', workspaceId: WS, path: null, nowMs: T0 })).toBeNull();
  });
});

describe('clearing via the outcome write (missing_checkout: null)', () => {
  it('a checkout that came back and vanished again starts a fresh clock, not the stale one', async () => {
    await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: T0 });
    // git-sync-action's recordOutcome: the same top-level jsonb merge, nulling the marker.
    // ::text::jsonb — plain postgres.js would JSON-encode a string bound straight to ::jsonb.
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::text::jsonb
        WHERE install_slug = $1 AND workspace_id = $2`,
      [SLUG, WS, JSON.stringify({ last_status: 'synced', missing_checkout: null })],
    );
    const cleared = (await row()).metadata;
    expect(cleared).toMatchObject({ last_status: 'synced', missing_checkout: null });
    expect(readMissingCheckout(cleared)).toBeNull();

    // Vanishes again long after the old first-seen time: retirement must not be immediate.
    const again = T0 + 3 * GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS;
    const res = await recordMissingCheckoutSkip(sql, { slug: SLUG, workspaceId: WS, path: '/gone/a', nowMs: again });
    expect(res).toEqual({ since: again, retired: false });
    expect((await row()).active).toBe(true);
  });
});

describe('readMissingCheckout', () => {
  it('reads absent or malformed state as null', () => {
    expect(readMissingCheckout(null)).toBeNull();
    expect(readMissingCheckout({ missing_checkout: [] })).toBeNull();
    expect(readMissingCheckout({ missing_checkout: { since: 'x' } })).toBeNull();
    expect(readMissingCheckout({ missing_checkout: { since: 5, path: '' } })).toEqual({ since: 5, path: null });
  });
});
