/**
 * session-presence-store integration (real PG) — mig 434 + the full-set-replace
 * writer + TTL reader (cross-machine-coord-parity-and-trust-2026-07-01 P-005).
 *
 * Pins the store semantics the gossip reader depends on:
 *   1. a device's frame REPLACES its whole session set (upsert + drop absentees);
 *   2. a STALE (out-of-order) frame never regresses or deletes newer rows;
 *   3. an EMPTY set clears the device's (older) rows — "all my agents ended";
 *   4. devices never interfere with each other's rows;
 *   5. listLiveSessionPresence TTL-filters and hive-scopes.
 *
 * Owns its schema (applies mig 434 verbatim); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import {
  applySessionPresenceSet,
  listLiveSessionPresence,
  listFederatedFleetMembers,
  SESSION_ROW_REFRESH_FLOOR_MS,
} from '../session-presence-store';
import type { SessionPresenceEntry } from '../presence-gossip';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG_434 = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql/434-shared-session-presence.sql');
// P-301: the fleet-membership columns (fleet_slug/fleet_role + partial index) the
// session-presence gossip now carries cross-machine.
const MIG_479 = resolve(
  HERE,
  '../../../../../../libs/papercusp/libs/db/sql/479-shared-session-presence-fleet-slug.sql',
);

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_sess';
const T0 = 1_700_000_000_000;

const entry = (ownerId: string, over?: Partial<SessionPresenceEntry>): SessionPresenceEntry => ({
  owner_id: ownerId,
  kind: 'su',
  intent: 'working',
  plan_slug: null,
  harness_slug: 'hive-home',
  last_active_ms: T0,
  ...over,
});

describe('shared_session_presence (real PG, mig 434)', () => {
  let db: FreshPgDb;
  let dedicatedPg: DedicatedNativePg | undefined;
  const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;

  beforeAll(async () => {
    dedicatedPg = await startDedicatedNativePg({ baseDir: '/dev/shm/pcv' });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
    db = await createFreshPgDb('session_presence');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    await db.sql.unsafe(stripMeta(readFileSync(MIG_434, 'utf8')));
    await db.sql.unsafe(stripMeta(readFileSync(MIG_479, 'utf8')));
    // D-007 pot-rename: mig 434 creates shared_session_presence.hive_slug; mig 523 renamed
    // it → pot_slug. Replaying only 434/479 predates the rename, so apply it in-place.
    await db.sql.unsafe(`ALTER TABLE harness_shared.shared_session_presence RENAME COLUMN hive_slug TO pot_slug`);
  }, 60_000);

  afterAll(async () => {
    try {
      await db?.cleanup();
    } finally {
      try {
        await dedicatedPg?.stop();
      } finally {
        if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
        else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
      }
    }
  });

  async function rowsFor(devicePubkey: string) {
    return db.sql<{ owner_id: string; intent: string | null; pot_slug: string | null }[]>`
      SELECT owner_id, intent, pot_slug FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${WS} AND device_pubkey = ${devicePubkey} ORDER BY owner_id`;
  }

  it('a frame upserts the device\'s whole set (hive scope stamped)', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        potSlug: 'hive-home',
        sessions: [entry('su-a1'), entry('s-bee-1', { kind: 'cup', plan_slug: 'p1' })],
        frameTs: T0,
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    expect(rows.map((r) => r.owner_id)).toEqual(['s-bee-1', 'su-a1']);
    expect(rows[0].pot_slug).toBe('hive-home');
  });

  it('the next frame REPLACES the set: absentees dropped, arrivals upserted, survivors updated', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        potSlug: 'hive-home',
        sessions: [entry('su-a1', { intent: 'now reviewing' }), entry('su-a2')],
        frameTs: T0 + 10_000,
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    expect(rows.map((r) => r.owner_id)).toEqual(['su-a1', 'su-a2']); // s-bee-1 dropped
    expect(rows[0].intent).toBe('now reviewing');
  });

  it('a STALE out-of-order frame neither regresses nor deletes newer rows', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        potSlug: 'hive-home',
        sessions: [entry('su-a1', { intent: 'ancient state' }), entry('su-ghost')],
        frameTs: T0 - 60_000, // older than everything applied above
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    // su-a2 (newer than the stale frame) survives the not-in-set delete;
    // su-a1 keeps the newer intent; su-ghost still INSERTS (it's new — no
    // newer row to protect) which is harmless: the next fresh frame drops it.
    const a1 = rows.find((r) => r.owner_id === 'su-a1');
    expect(a1?.intent).toBe('now reviewing');
    expect(rows.some((r) => r.owner_id === 'su-a2')).toBe(true);
  });

  it('devices never interfere: dev-B\'s replace leaves dev-A rows intact', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-B',
        githubUserId: 77,
        machineLabel: 'desktop',
        potSlug: 'hive-home',
        sessions: [entry('su-b1')],
        frameTs: T0 + 20_000,
      },
      db.sql,
    );
    expect((await rowsFor('dev-A')).length).toBeGreaterThan(0);
    expect((await rowsFor('dev-B')).map((r) => r.owner_id)).toEqual(['su-b1']);
  });

  it('an EMPTY set clears the device\'s older rows ("all my agents ended")', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-B',
        githubUserId: 77,
        machineLabel: 'desktop',
        potSlug: 'hive-home',
        sessions: [],
        frameTs: T0 + 30_000,
      },
      db.sql,
    );
    expect(await rowsFor('dev-B')).toEqual([]);
  });

  it('full-set deletes stay within the frame pot when a device announces multiple pots', async () => {
    const devicePubkey = 'dev-multi-pot';
    const apply = (potSlug: string | null, sessions: SessionPresenceEntry[], frameTs: number) =>
      applySessionPresenceSet(
        {
          workspaceId: WS,
          devicePubkey,
          githubUserId: 77,
          machineLabel: 'multi-pot',
          potSlug,
          sessions,
          frameTs,
        },
        db.sql,
      );

    await apply('pot-a', [entry('su-pot-a1'), entry('su-pot-a2')], T0 + 40_000);
    await apply('pot-b', [entry('su-pot-b1')], T0 + 50_000);
    await apply(null, [entry('su-pot-null')], T0 + 55_000);
    // The non-empty replace deletes only pot-a's absent row; pot-b remains.
    await apply('pot-a', [entry('su-pot-a2')], T0 + 60_000);
    expect((await rowsFor(devicePubkey)).map(({ owner_id, pot_slug }) => [owner_id, pot_slug])).toEqual([
      ['su-pot-a2', 'pot-a'],
      ['su-pot-b1', 'pot-b'],
      ['su-pot-null', null],
    ]);

    // An empty pot-a frame clears that pot's final row without evicting pot-b
    // or the NULL-scoped row.
    await apply('pot-a', [], T0 + 70_000);
    expect((await rowsFor(devicePubkey)).map(({ owner_id, pot_slug }) => [owner_id, pot_slug])).toEqual([
      ['su-pot-b1', 'pot-b'],
      ['su-pot-null', null],
    ]);
  });

  it('listLiveSessionPresence TTL-filters and hive-scopes', async () => {
    // dev-C in a DIFFERENT hive, fresh beat; dev-A rows are old by now.
    const nowMs = T0 + 100_000;
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-C',
        githubUserId: 9,
        machineLabel: 'vm',
        potSlug: 'other-hive',
        sessions: [entry('su-c1', { harness_slug: 'other-hive' })],
        frameTs: nowMs,
      },
      db.sql,
    );
    // TTL: only dev-C's beat is within 30s of `nowMs`.
    const live = await listLiveSessionPresence(
      { workspaceId: WS, staleMs: 30_000, nowMs },
      db.sql,
    );
    expect(live.map((r) => r.owner_id)).toEqual(['su-c1']);
    expect(live[0].last_seen_ms).toBe(nowMs);
    // Hive scope: hive-home has no LIVE rows at this point.
    const hiveScoped = await listLiveSessionPresence(
      { workspaceId: WS, potSlug: 'hive-home', staleMs: 30_000, nowMs },
      db.sql,
    );
    expect(hiveScoped).toEqual([]);
    // …but a wide-enough window sees the older hive-home rows, hive-scoped.
    const wide = await listLiveSessionPresence(
      { workspaceId: WS, potSlug: 'hive-home', staleMs: 24 * 60 * 60 * 1000, nowMs },
      db.sql,
    );
    expect(wide.every((r) => r.pot_slug === 'hive-home')).toBe(true);
    expect(wide.length).toBeGreaterThan(0);

    const targeted = await listLiveSessionPresence(
      { workspaceId: WS, staleMs: 24 * 60 * 60 * 1000, nowMs, ownerIds: ['su-a1'] },
      db.sql,
    );
    expect(targeted.map((r) => r.owner_id)).toEqual(['su-a1']);
  });

  it('round-trips fleet membership + listFederatedFleetMembers scopes to one fleet_slug (P-301)', async () => {
    const nowMs = T0 + 100_000;
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-fleet',
        githubUserId: 11,
        machineLabel: 'tower',
        potSlug: 'hive-home',
        sessions: [
          entry('su-lead', { fleet_slug: 'git-plan', fleet_role: 'leader' }),
          entry('su-mem', { fleet_slug: 'git-plan', fleet_role: 'member' }),
          entry('su-other', { fleet_slug: 'other-fleet', fleet_role: 'member' }),
          entry('su-nofleet'), // no named fleet → null columns (back-compat)
        ],
        frameTs: nowMs,
      },
      db.sql,
    );
    // The membership columns survive the round trip on the unified roster read.
    const live = await listLiveSessionPresence({ workspaceId: WS, staleMs: 30_000, nowMs }, db.sql);
    const byId = new Map(live.map((r) => [r.owner_id, r]));
    expect(byId.get('su-lead')).toMatchObject({ fleet_slug: 'git-plan', fleet_role: 'leader' });
    expect(byId.get('su-nofleet')).toMatchObject({ fleet_slug: null, fleet_role: null });
    // The federated fleet-member read scopes to ONE fleet_slug + carries roles —
    // the cross-machine leg the audience resolver unions in.
    const members = await listFederatedFleetMembers(
      { workspaceId: WS, fleetSlug: 'git-plan', staleMs: 30_000, nowMs },
      db.sql,
    );
    expect(members.map((m) => m.ownerId).sort()).toEqual(['su-lead', 'su-mem']);
    expect(members.find((m) => m.ownerId === 'su-lead')?.fleetRole).toBe('leader');
    // TTL applies to the federated read too — stale rows drop out.
    const staleRead = await listFederatedFleetMembers(
      { workspaceId: WS, fleetSlug: 'git-plan', staleMs: 1, nowMs: nowMs + 60_000 },
      db.sql,
    );
    expect(staleRead).toEqual([]);
  });

  // WI-10002534: duplicate frames (one tower sent ~39 identical full sets per 10s
  // tick) must not rewrite every row per frame, and a frame is one statement.
  async function beatsFor(devicePubkey: string) {
    const rows = await db.sql<
      { owner_id: string; intent: string | null; harness_slug: string; ms: string }[]
    >`
      SELECT owner_id, intent, harness_slug,
             (extract(epoch FROM last_seen_at) * 1000)::bigint::text AS ms
      FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${WS} AND device_pubkey = ${devicePubkey} ORDER BY owner_id`;
    return new Map(rows.map((r) => [r.owner_id, { ...r, ms: Number(r.ms) }]));
  }

  it('a same-content duplicate inside the refresh floor is skipped; a changed field or an aged row is written (WI-10002534)', async () => {
    const T1 = T0 + 200_000;
    const frame = (frameTs: number, sessions: SessionPresenceEntry[]) =>
      applySessionPresenceSet(
        {
          workspaceId: WS,
          devicePubkey: 'dev-dup',
          githubUserId: 5,
          machineLabel: 'dup-box',
          potSlug: 'hive-home',
          sessions,
          frameTs,
        },
        db.sql,
      );
    await frame(T1, [entry('su-d1', { intent: 'x' }), entry('su-d2', { intent: 'y' })]);
    expect((await beatsFor('dev-dup')).get('su-d1')?.ms).toBe(T1);

    // Duplicate frame 2s later, differing only in the sender-declared harness label:
    // no row is rewritten.
    await frame(T1 + 2_000, [
      entry('su-d1', { intent: 'x', harness_slug: 'other-label' }),
      entry('su-d2', { intent: 'y', harness_slug: 'other-label' }),
    ]);
    let beats = await beatsFor('dev-dup');
    expect(beats.get('su-d1')).toMatchObject({ ms: T1, harness_slug: 'hive-home' });
    expect(beats.get('su-d2')?.ms).toBe(T1);

    // A real content change is written at once, and only for the changed row.
    await frame(T1 + 3_000, [entry('su-d1', { intent: 'x' }), entry('su-d2', { intent: 'y2' })]);
    beats = await beatsFor('dev-dup');
    expect(beats.get('su-d2')).toMatchObject({ ms: T1 + 3_000, intent: 'y2' });
    expect(beats.get('su-d1')?.ms).toBe(T1);

    // Once a row reaches the floor, the same content refreshes it (keep-alive).
    const refreshAt = T1 + SESSION_ROW_REFRESH_FLOOR_MS;
    await frame(refreshAt, [entry('su-d1', { intent: 'x' }), entry('su-d2', { intent: 'y2' })]);
    beats = await beatsFor('dev-dup');
    expect(beats.get('su-d1')?.ms).toBe(refreshAt);
    // su-d2 was written 3s later, so it is still inside its floor.
    expect(beats.get('su-d2')?.ms).toBe(T1 + 3_000);
  });

  it('a whole frame is ONE upsert statement, and a repeated owner in one frame does not abort it (WI-10002534)', async () => {
    let statements = 0;
    // Count tagged-template statements only; helper calls like sql(keep) pass a
    // plain array with no `raw`.
    const counted = new Proxy(db.sql, {
      apply(target, thisArg, args: unknown[]) {
        const first = args[0];
        if (Array.isArray(first) && 'raw' in (first as object)) statements++;
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
    const sessions = Array.from({ length: 50 }, (_, i) => entry(`su-batch-${i}`));
    sessions.push(entry('su-batch-7', { intent: 'last entry wins' }));
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-batch',
        githubUserId: 6,
        machineLabel: 'batch-box',
        potSlug: 'hive-home',
        sessions,
        frameTs: T0 + 300_000,
      },
      counted,
    );
    expect(statements).toBe(2); // the upsert + the absentee delete, not 51 + 1
    const beats = await beatsFor('dev-batch');
    expect(beats.size).toBe(50);
    expect(beats.get('su-batch-7')?.intent).toBe('last entry wins');
  });
});
