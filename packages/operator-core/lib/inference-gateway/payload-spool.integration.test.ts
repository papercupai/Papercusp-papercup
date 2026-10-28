/**
 * payload-spool — REAL-PG coverage for `PgGatewayPayloadStore.sweep` (EI-21858853737380027).
 *
 * MEASURED INCIDENT (WI-1091844, 2026-08-30): `payload-spool.test.ts` had exactly one
 * describe block covering sweep/GC behavior, and every case in it built
 * `memoryGatewayPayloadSpool()` — a double whose sweep reclaims unconditionally on
 * `refs === 0`. The production adapter's sweep instead treats `expires_at` as a
 * required condition (a TTL/legacy-grace backstop, not just a safety floor), and at
 * the time of the incident it ANDed `expires_at IS NOT NULL`, which was NULL on every
 * pre-policy row — so it reclaimed nothing for 38 hours while 66 GB / 74,250 rows
 * accumulated with the (double-only) suite green throughout. That specific gap was
 * fixed (the legacy-backfill + NULL-expiry grace-period branch below), but nothing
 * before this file ever ran a single assertion against a REAL Postgres for this
 * adapter — the existing `PgGatewayPayloadStore` unit tests use a `fakeSql()` that
 * only records SQL TEXT SHAPE, which can stay green even if the real query's
 * semantics are wrong (a typo'd interval unit, an operator precedence slip, a
 * misindexed WHERE clause — none of those fail a string-contains assertion).
 *
 * This file is the "shared contract, both implementations" guard the ticket asks
 * for, scoped to what genuinely IS shared between the double and the adapter — the
 * double sweeps a ref_count=0 row IMMEDIATELY with no time dimension; the adapter
 * deliberately delays that reclaim until an explicit or backfilled expiry has
 * passed (a resurrection window for a retry arriving between settle and sweep), so
 * the two are not literally interchangeable under the same clock-free assertions.
 * What follows: (1) the safety properties that genuinely must hold identically for
 * both (never sweep a referenced payload, never go refcount-negative) — proven
 * against the real adapter, and (2) the adapter's actual sweep/GC contract —
 * legacy-row backfill, TTL expiry, the ref_count floor, and bounded batching —
 * exercised against a real `harness_shared.gateway_payload_blobs` table so a
 * regression in the real SQL fails a real assertion instead of a string match.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentDefinedChunks, sha256Hex } from '@papercusp/artifact-registry';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../test/_pg-helpers';
import {
  DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS,
  DEFAULT_PAYLOAD_SPOOL_TTL_MS,
  PgGatewayPayloadStore,
  createGatewayPayloadSpool,
  memoryGatewayPayloadSpool,
  type GatewayPayloadSpool,
  type SpoolResult,
} from './payload-spool';

const WS = 'ws-payload-spool-it';
const body = (text: string) => Buffer.from(text, 'utf8');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pspool');
  await applyMigrationsForTest(db.sql, ['1022-gateway-payload-spool-blobs.sql', '1314-gateway-payload-chunks.sql'], {
    runtimeTables: ['harness_shared.gateway_payload_blobs', 'harness_shared.gateway_payload_chunks'],
  });
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.gateway_payload_blobs`;
  await db.sql`DELETE FROM harness_shared.gateway_payload_chunks`;
});

// ── (1) SHARED SAFETY CONTRACT — genuinely identical for both implementations. ──

function safetyContract(name: string, make: () => GatewayPayloadSpool) {
  describe(`refcounted retention — safety contract (${name})`, () => {
    it('does not sweep a payload a live receipt still names', async () => {
      const spool = make();
      const { payloadRef } = await spool.spool(body('pinned by a receipt'));

      await spool.retain(payloadRef!);
      const removed = await spool.sweep();

      expect(removed).toBe(0);
      expect(await spool.read(payloadRef!)).not.toBeNull();
    });

    it('keeps a shared (deduped) payload alive while any receipt still holds it', async () => {
      const spool = make();
      const bytes = body('shared between two receipts');
      const first = await spool.spool(bytes);
      const second = await spool.spool(Buffer.from(bytes));
      expect(second.payloadRef).toBe(first.payloadRef);

      await spool.retain(first.payloadRef!);
      await spool.retain(second.payloadRef!);
      await spool.release(first.payloadRef!);

      expect(await spool.sweep()).toBe(0);
      expect(await spool.read(first.payloadRef!)).not.toBeNull();
    });

    it('does not drive the refcount negative on a repeated release', async () => {
      const spool = make();
      const { payloadRef } = await spool.spool(body('double released'));

      await spool.retain(payloadRef!);
      await spool.release(payloadRef!);
      await spool.release(payloadRef!); // a retried settle path
      await spool.retain(payloadRef!); // a fresh receipt takes it

      // If the double release had gone to -1, this retain would leave it at 0 and a
      // sweep would collect a payload a live receipt is about to execute.
      expect(await spool.sweep()).toBe(0);
      expect(await spool.read(payloadRef!)).not.toBeNull();
    });
  });
}

safetyContract('memory double', () => memoryGatewayPayloadSpool());
safetyContract('Postgres adapter, real DB', () =>
  // A short but nonzero TTL: these assertions never depend on expiry elapsing (they
  // only ever check that a REFERENCED payload survives), so any positive TTL is fine.
  createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS }),
);

// ── (2) the Postgres adapter's actual sweep/GC contract, against a real table. ──

describe('PgGatewayPayloadStore.sweep — real Postgres', () => {
  const insertRow = async (opts: {
    refCount?: number;
    expiresAt?: Date | null;
    createdAt?: Date;
    lastAccessedAt?: Date;
    byteLength?: number;
  }) => {
    const key = await sha256Hex(Buffer.from(`row-${Math.random()}`));
    const createdAt = opts.createdAt ?? new Date();
    const bytes = Buffer.alloc(opts.byteLength ?? 1, 0x78);
    await db.sql`
      INSERT INTO harness_shared.gateway_payload_blobs
        (workspace_id, blob_key, bytes, byte_length, ref_count, expires_at, created_at, last_accessed_at)
      VALUES
        (${WS}, ${key}, ${bytes}, ${bytes.byteLength}, ${opts.refCount ?? 0},
         ${opts.expiresAt ?? null}, ${createdAt}, ${opts.lastAccessedAt ?? createdAt})`;
    return key;
  };

  // A pure read, deliberately NOT head(): head() is the dedupe path and renews the row's
  // expiry (WI-10003469), so probing through it between two sweeps would re-protect the
  // very rows the second sweep is meant to collect.
  const exists = async (key: string) =>
    (await db.sql`
      SELECT 1 FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS} AND blob_key = ${key}`).length > 0;

  it('THE INCIDENT: reclaims a pre-policy row (expires_at NULL) old enough to backfill into the past', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    // A "legacy" row: written before the finite-TTL policy existed, so it has no
    // explicit expiry. created_at far enough in the past that created_at + ttlMs
    // (the backfilled expiry) already lies in the past.
    const key = await insertRow({ refCount: 0, expiresAt: null, createdAt: new Date(Date.now() - 40 * 3600_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('does not reclaim a recent expires_at-NULL row until its backfilled expiry actually passes', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    // created_at + ttlMs (2 min) is still ~90s in the future.
    const key = await insertRow({ refCount: 0, expiresAt: null, createdAt: new Date(Date.now() - 30_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('legacy-grace path: reclaims an expires_at-NULL row once idle past legacyGraceMs, with the TTL policy off', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: 0, legacyGraceMs: DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: null,
      createdAt: new Date(Date.now() - 40 * 3600_000),
      lastAccessedAt: new Date(Date.now() - (DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS + 60_000)),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('legacy-grace path: does NOT reclaim an expires_at-NULL row still inside the grace window', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: 0, legacyGraceMs: DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: null,
      lastAccessedAt: new Date(Date.now() - 60_000), // well inside the (2h default) grace window
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('reclaims an unreferenced row once its explicit expiry has passed', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() - 1_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('WI-10003469: a dedupe HEAD hit renews an expired unreferenced row, so the sweep spares it for the caller’s retain()', async () => {
    // The race the two-minute TTL makes common: a retry dedupes onto a row that has already
    // expired, and the sweep would delete it before the retry's retain() lands.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() - 1_000) });

    await expect(store.head(key)).resolves.toEqual({ size: 1 });
    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('does NOT reclaim an unreferenced row before its explicit expiry', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() + 3600_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  // ⚠ The floor is REFERENCED-AND-IN-USE, not referenced alone. Before WI-2141342 this
  // case's title read "never reclaims a still-referenced row even once its expiry has
  // passed", which is no longer true in general: a pin abandoned past pinnedGraceMs IS
  // reclaimed (the two cases below). This one still passes unchanged — and still means
  // something — because insertRow defaults last_accessed_at to now(), so its row is
  // expired but ACTIVE. That distinction is the whole safety property, so keep these
  // three cases adjacent: alone, any one of them reads as the complete contract.
  it('THE FLOOR: never reclaims a still-referenced row that is still in use, even once its expiry has passed', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 1, expiresAt: new Date(Date.now() - 1_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('WI-2141342: reclaims a still-referenced row abandoned past the pinned grace', async () => {
    // The leak: release() runs in a request-scoped `finally`, so a SIGKILLed gateway
    // leaves ref_count > 0 forever. Without an age floor this row is immortal.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 1,
      expiresAt: new Date(Date.now() - 3 * 3600_000),
      lastAccessedAt: new Date(Date.now() - 3 * 3600_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('THE BOUNDARY: does NOT reclaim a still-referenced row inside the pinned grace, even when expired', async () => {
    // 1h idle against the 2h default. This is the case the production dry-run could not
    // prove — no live row happened to sit between the two windows — so it is the one that
    // would catch an interval-unit slip or an inverted comparison in the new branch.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 1,
      expiresAt: new Date(Date.now() - 1_000),
      lastAccessedAt: new Date(Date.now() - 3600_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('honours an explicit pinnedGraceMs rather than only the 2h default', async () => {
    // Guards the option wiring: a row 90m idle is INSIDE the default grace but past a
    // 1h override, so this fails if pinnedGraceMs is dropped anywhere between the
    // constructor and the SQL and the default silently applies instead.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, pinnedGraceMs: 3600_000 });
    const key = await insertRow({
      refCount: 2,
      expiresAt: new Date(Date.now() - 1_000),
      lastAccessedAt: new Date(Date.now() - 90 * 60_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('bounds a single pass to `limit`, leaving the remainder for the next sweep', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const expired = new Date(Date.now() - 1_000);
    const keys = await Promise.all([
      insertRow({ refCount: 0, expiresAt: expired }),
      insertRow({ refCount: 0, expiresAt: expired }),
      insertRow({ refCount: 0, expiresAt: expired }),
    ]);

    const firstPass = await store.sweep(2);
    expect(firstPass).toBe(2);
    const remainingAfterFirst = await Promise.all(keys.map(exists));
    expect(remainingAfterFirst.filter(Boolean)).toHaveLength(1);

    const secondPass = await store.sweep(2);
    expect(secondPass).toBe(1);
    const remainingAfterSecond = await Promise.all(keys.map(exists));
    expect(remainingAfterSecond.every((present) => !present)).toBe(true);
  });

  it('bounds a single pass by cumulative payload bytes as well as row count', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const expired = new Date(Date.now() - 1_000);
    const base = Date.now() - 10_000;
    const keys = await Promise.all([
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base), byteLength: 5 }),
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base + 1), byteLength: 4 }),
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base + 2), byteLength: 3 }),
    ]);

    // 5 fits; 5 + 4 crosses the 8-byte budget, so the oldest row is the whole
    // first pass even though the row limit would allow all three.
    const firstPass = await store.sweep(100, 8);
    expect(firstPass).toBe(1);
    expect(await Promise.all(keys.map(exists))).toEqual([false, true, true]);

    // The remaining 4 + 3 bytes fit together on the next pass.
    const secondPass = await store.sweep(100, 8);
    expect(secondPass).toBe(2);
    expect((await Promise.all(keys.map(exists))).every((present) => !present)).toBe(true);
  });

  it('still makes progress when the oldest payload alone exceeds an explicit byte budget', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: new Date(Date.now() - 1_000),
      byteLength: 5,
    });

    expect(await store.sweep(100, 2)).toBe(1);
    expect(await exists(key)).toBe(false);
  });
});

// ── round trip against the real adapter — the basic path had zero real-PG coverage. ──

describe('createGatewayPayloadSpool — real Postgres round trip', () => {
  it('writes, reads back exact bytes, and dedupes a retried body onto one row', async () => {
    const spool = createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xfe]);

    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes));
    const readBack = await spool.read(first.payloadRef!);

    expect(second.payloadRef).toBe(first.payloadRef);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack!, bytes)).toBe(0);

    const rows = await db.sql`SELECT count(*)::int AS n FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS}`;
    expect(rows[0]!.n).toBe(1);
  });

  it('returns null for a ref that does not resolve', async () => {
    const spool = createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS });

    expect(await spool.read('a'.repeat(64))).toBeNull();
  });
});

// ── D-017 (papercusp-log-performance-remediation-2026-09-23): chunked body storage. ──
describe('D-017 content-defined chunk storage — real Postgres', () => {
  /** Deterministic incompressible-ish bytes, so chunk boundaries are reproducible. */
  const prng = (n: number, seed: number): Buffer => {
    const out = Buffer.alloc(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      out[i] = s >>> 24;
    }
    return out;
  };
  const spoolFor = () => createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
  const chunkStats = async () => {
    const rows = await db.sql<{ n: number; raw: number }[]>`
      SELECT count(*)::int AS n, coalesce(sum(raw_length), 0)::int AS raw
        FROM harness_shared.gateway_payload_chunks WHERE workspace_id = ${WS}`;
    return rows[0]!;
  };
  const ageAllChunks = () =>
    db.sql`UPDATE harness_shared.gateway_payload_chunks SET last_ref_at = now() - interval '2 hours' WHERE workspace_id = ${WS}`;
  const dropManifest = (ref: string) =>
    db.sql`DELETE FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS} AND blob_key = ${ref}`;

  it('keeps overlapping concurrent writes safe when their bodies order shared chunks oppositely', async () => {
    const workspaceId = `${WS}-opposite-order`;
    const rawChunks = contentDefinedChunks(prng(300_000, 31)).slice(0, 2).map((chunk) => Buffer.from(chunk));
    expect(rawChunks).toHaveLength(2);
    let [chunkA, chunkB] = rawChunks as [Buffer, Buffer];
    let hashA = await sha256Hex(chunkA);
    let hashB = await sha256Hex(chunkB);
    if (hashA > hashB) {
      [chunkA, chunkB] = [chunkB, chunkA];
      [hashA, hashB] = [hashB, hashA];
    }
    expect(hashA < hashB).toBe(true);

    const bodyAB = Buffer.concat([chunkA, chunkB]);
    const bodyBA = Buffer.concat([chunkB, chunkA]);
    const refAB = await sha256Hex(bodyAB);
    const refBA = await sha256Hex(bodyBA);
    const chunksOf = (bytes: Buffer) => contentDefinedChunks(bytes).map((chunk) => Buffer.from(chunk));
    expect(chunksOf(bodyAB)).toEqual([chunkA, chunkB]);
    expect(chunksOf(bodyBA)).toEqual([chunkB, chunkA]);

    const barrierClass = 24_257;
    let releaseBarrier = () => {};
    let markBarrierHeld = () => {};
    const barrierReleased = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const barrierHeld = new Promise<void>((resolve) => { markBarrierHeld = resolve; });
    const settle = (promise: Promise<SpoolResult>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const pending: Array<ReturnType<typeof settle>> = [];
    let controller: Promise<unknown> | null = null;

    try {
      await db.sql.unsafe(`DROP TRIGGER IF EXISTS test_payload_chunk_order_barrier ON harness_shared.gateway_payload_chunks`);
      await db.sql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.test_payload_chunk_order_barrier()`);
      await db.sql.unsafe(`CREATE FUNCTION harness_shared.test_payload_chunk_order_barrier() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.workspace_id = '${workspaceId}'
             AND NEW.chunk_hash = decode('${hashB}', 'hex')
             AND pg_try_advisory_xact_lock(${barrierClass}, 2) THEN
            PERFORM pg_advisory_xact_lock(${barrierClass}, 1);
          END IF;
          RETURN NEW;
        END $body$`);
      await db.sql.unsafe(`CREATE TRIGGER test_payload_chunk_order_barrier
        BEFORE INSERT ON harness_shared.gateway_payload_chunks
        FOR EACH ROW EXECUTE FUNCTION harness_shared.test_payload_chunk_order_barrier()`);

      controller = db.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${barrierClass}, 1)`;
        markBarrierHeld();
        await barrierReleased;
      });
      await Promise.race([barrierHeld, controller]);

      const createSpool = () => createGatewayPayloadSpool({ sql: db.sql, workspaceId });
      const first = settle(createSpool().spool(bodyAB));
      pending.push(first);
      await vi.waitFor(async () => {
        const waiting = await db.sql`
          SELECT a.pid
            FROM pg_locks AS l
            JOIN pg_stat_activity AS a ON a.pid = l.pid
           WHERE l.locktype = 'advisory'
             AND l.classid = ${barrierClass}::oid
             AND l.objid = 1::oid
             AND l.objsubid = 2
             AND NOT l.granted
             AND a.query ILIKE '%gateway_payload_chunks%'`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 5_000, interval: 10 });

      const second = settle(createSpool().spool(bodyBA));
      pending.push(second);
      await vi.waitFor(async () => {
        const waiting = await db.sql`
          SELECT a.pid, pg_blocking_pids(a.pid) AS blockers
            FROM pg_stat_activity AS a
           WHERE a.datname = current_database()
             AND a.query ILIKE '%gateway_payload_chunks%'
             AND a.wait_event_type = 'Lock'
             AND a.wait_event = 'transactionid'`;
        expect(waiting).toHaveLength(1);
        expect(waiting[0]!.blockers.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 10 });
    } finally {
      releaseBarrier();
      await controller;
      await Promise.all(pending);
      await db.sql.unsafe(`DROP TRIGGER IF EXISTS test_payload_chunk_order_barrier ON harness_shared.gateway_payload_chunks`);
      await db.sql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.test_payload_chunk_order_barrier()`);
    }

    const outcomes = await Promise.all(pending);
    const failures = outcomes.filter((outcome) => !outcome.ok);
    expect(failures.map((failure) => String(failure.error)), 'opposite-order chunk writes must not deadlock').toEqual([]);
    const successful = outcomes.filter((outcome): outcome is { ok: true; value: SpoolResult } => outcome.ok);
    expect(successful).toHaveLength(2);
    expect(successful.map((outcome) => outcome.value.payloadRef).sort()).toEqual([refAB, refBA].sort());
    const reader = createGatewayPayloadSpool({ sql: db.sql, workspaceId });
    expect(Buffer.compare((await reader.read(refAB))!, bodyAB)).toBe(0);
    expect(Buffer.compare((await reader.read(refBA))!, bodyBA)).toBe(0);
  });

  it('stores a multi-chunk body as chunks with no inline bytes, and reads back the exact bytes', async () => {
    const spool = spoolFor();
    const body = prng(300_000, 1);
    const { payloadRef } = await spool.spool(body);

    const [manifest] = await db.sql<{ inline: number; chunks: number }[]>`
      SELECT octet_length(bytes) AS inline, array_length(chunk_hashes, 1) AS chunks
        FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS} AND blob_key = ${payloadRef!}`;
    expect(manifest!.inline).toBe(0);
    expect(manifest!.chunks).toBeGreaterThan(5);
    expect((await chunkStats()).raw).toBe(body.length);
    expect(Buffer.compare((await spool.read(payloadRef!))!, body)).toBe(0);
  });

  it('a following turn that extends the body stores only its new chunks', async () => {
    const spool = spoolFor();
    const turn1 = prng(400_000, 2);
    const turn2 = Buffer.concat([turn1, prng(20_000, 3)]);
    await spool.spool(turn1);
    const before = await chunkStats();

    const { payloadRef } = await spool.spool(turn2);
    const added = (await chunkStats()).raw - before.raw;

    // 20 kB is new; the chunk spanning the old end re-synchronizes, at most one max-size chunk.
    expect(added).toBeGreaterThanOrEqual(20_000);
    expect(added).toBeLessThanOrEqual(20_000 + 8 * 8192);
    expect(Buffer.compare((await spool.read(payloadRef!))!, turn2)).toBe(0);
  });

  it('sweeps an idle unreferenced chunk, but never one a live manifest references or one inside the grace', async () => {
    const spool = spoolFor();
    const kept = prng(200_000, 4);
    const { payloadRef: keptRef } = await spool.spool(kept);
    const { payloadRef: goneRef } = await spool.spool(prng(200_000, 5));
    await dropManifest(goneRef!);
    await ageAllChunks();
    const { payloadRef: freshRef } = await spool.spool(prng(150_000, 6));
    await dropManifest(freshRef!);

    await spool.sweep();

    // Aged chunks of the dropped manifest are gone; the referenced body and the
    // fresh (inside-grace) chunks remain.
    expect((await chunkStats()).raw).toBe(200_000 + 150_000);
    expect(Buffer.compare((await spool.read(keptRef!))!, kept)).toBe(0);
  });

  it('a writer reusing an aged chunk refreshes it, so the sweep cannot reclaim it under the new manifest', async () => {
    const spool = spoolFor();
    const body = prng(250_000, 7);
    const { payloadRef } = await spool.spool(body);
    await dropManifest(payloadRef!);
    await ageAllChunks();

    await spool.spool(body);
    await spool.sweep();

    expect((await chunkStats()).raw).toBe(250_000);
    expect(Buffer.compare((await spool.read(payloadRef!))!, body)).toBe(0);
  });

  it('reads a live manifest with a missing chunk as corruption, never as not-found', async () => {
    const spool = spoolFor();
    const { payloadRef } = await spool.spool(prng(120_000, 8));
    await db.sql`
      DELETE FROM harness_shared.gateway_payload_chunks
       WHERE workspace_id = ${WS}
         AND chunk_hash = (SELECT chunk_hashes[1] FROM harness_shared.gateway_payload_blobs
                            WHERE workspace_id = ${WS} AND blob_key = ${payloadRef!})`;

    await expect(spool.read(payloadRef!)).rejects.toThrow(/no longer stored/);
  });

  it('still reads a row written inline before D-017', async () => {
    const bytes = Buffer.from('pre-chunking body', 'utf8');
    const ref = await sha256Hex(bytes);
    await db.sql`
      INSERT INTO harness_shared.gateway_payload_blobs (workspace_id, blob_key, bytes, byte_length)
      VALUES (${WS}, ${ref}, ${bytes}, ${bytes.length})`;

    expect(Buffer.compare((await spoolFor().read(ref))!, bytes)).toBe(0);
  });
});
