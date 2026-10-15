/**
 * fed-ts-lww-guard.integration.test.ts — the EI-79 residual STEP 2 correctness
 * contract on REAL Postgres (the partner of the incremental merge cursor).
 *
 * The incremental merge cursor (`mergeAdmittedLogsIncremental`) only decodes the
 * DELTA of each grown log per pass. That is correct ONLY if applying an OLD op
 * to a row that already holds a NEWER value is a no-op AT THE PG LAYER — so a
 * late / out-of-order / backfilled op can never clobber a newer projected row.
 * The in-process `cursor.winners` fold guards this within one process; these
 * tests prove the SECOND, independent floor: every mutating projection writer is
 * PG-level last-write-wins via its `fed_order_key(fed_hlc, fed_ts)` guard plus
 * the equal-key `fed_apply_wins` tie-break, so correctness holds even when the
 * op arrives WITHOUT going through (or after a reset of) the cursor fold — e.g. a
 * fresh process replaying an old op, or two writers to the same shared row.
 *
 * Docker-gated (`*.integration.test.ts`) — needs a real migrated PG; the guard
 * is pure SQL, invisible to the SQL-mocked unit tests.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { buildHarnessProjectionApply } from '../register-all';
import type { OpEnvelope } from '../../op-envelope-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const WS = 'ws-fed-ts';
const HARNESS = 'fed-ts';
const AUTHOR = 'f'.repeat(64);

let db: MigratedTestDb;
let sql: postgres.Sql;
let apply: (op: OpEnvelope) => Promise<boolean>;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fedts',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: {
          client: postgres.Sql;
          sqlDir: string;
        }) => Promise<{ appliedCount: number; totalKnown: number }>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  apply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

/** A `features-by-id` put op at a given wire ts. `extra` merges additional
 *  wire fields (e.g. the dispatch columns) into the value. */
function featurePut(
  featureId: string,
  status: string,
  ts: number,
  extra?: Record<string, unknown>,
): OpEnvelope {
  return {
    type: 'put',
    table: 'features-by-id',
    hbKey: featureId,
    value: {
      ...extra,
      harness_slug: HARNESS,
      feature_id: featureId,
      title: `feat ${featureId}`,
      summary: null,
      status,
      attempts: 0,
      claims: null,
      notes: null,
      metadata: null,
      kind: null,
      project_id: null,
      expected_cost_cents: null,
      tags: null,
      needs_human_review: false,
      ts,
      created_ts: ts,
      updated_ts: ts,
      parent_id: null,
      goal_id: null,
      taken_by: null,
      taken_at: null,
      expires_at: null,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function featureDel(featureId: string, ts: number): OpEnvelope {
  return { type: 'del', table: 'features-by-id', hbKey: featureId, ts, schema_version: 1, writerPubkey: AUTHOR };
}

async function statusOf(featureId: string): Promise<string | null> {
  const rows = await sql<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${HARNESS} AND feature_id = ${featureId}`;
  return rows.length ? rows[0].status : null;
}

describe('EI-79 step 2 — PG-level fed_ts LWW guard (out-of-order safety)', () => {
  it('a NEWER put then an OLDER put → the row keeps the NEWER value', async () => {
    const id = 'F-oo-1';
    expect(await apply(featurePut(id, 'newer', 2000))).toBe(true);
    expect(await statusOf(id)).toBe('newer');

    // The older op arrives late (out-of-order replication / a backfilling peer).
    // The writer's `fed_order_key` / `fed_apply_wins` guard makes the UPDATE a
    // no-op — the row is NOT clobbered back to 'older'.
    await apply(featurePut(id, 'older', 1000));
    expect(await statusOf(id)).toBe('newer');
  });

  it('an OLDER put then a NEWER put → the newer applies (forward progress preserved)', async () => {
    const id = 'F-oo-2';
    expect(await apply(featurePut(id, 'older', 1000))).toBe(true);
    expect(await statusOf(id)).toBe('older');
    await apply(featurePut(id, 'newer', 2000));
    expect(await statusOf(id)).toBe('newer');
  });

  it('an equal-ts same-writer put is resolved by the deterministic content tie-break', async () => {
    const id = 'F-oo-eq';
    // WI-2923/mig 504 replaced unconditional equal-key apply (`>=`) with
    // fed_apply_wins: same-writer equal keys fall to the symmetric content digest
    // so healed replicas converge instead of swapping values. An explicit payload
    // keeps this fixed first-winner fixture stable across NULL-to-{} normalization.
    const payload = { scenario: 'same-writer' };
    for (const order of [['first', 'second'], ['second', 'first']]) {
      await sql`DELETE FROM harness_shared.work_items WHERE harness_slug = ${HARNESS} AND feature_id = ${id}`;
      for (const status of order) await apply(featurePut(id, status, 1500, { payload }));
      expect(await statusOf(id)).toBe('first');
      const [row] = await sql`SELECT payload FROM harness_shared.work_items
        WHERE harness_slug = ${HARNESS} AND feature_id = ${id}`;
      expect(row.payload).toEqual(payload);
    }
  });

  it('an omitted payload is normalized before the same-writer content tie-break in both orders', async () => {
    const id = 'F-oo-eq';
    // Migration 1328 changes an omitted SQL NULL payload to {} before the LWW
    // guard. For these normalized contents the second digest wins; omitting that
    // field from the digest would incorrectly preserve the first-winner oracle.
    for (const order of [['first', 'second'], ['second', 'first']]) {
      await sql`DELETE FROM harness_shared.work_items WHERE harness_slug = ${HARNESS} AND feature_id = ${id}`;
      for (const status of order) await apply(featurePut(id, status, 1500));
      expect(await statusOf(id)).toBe('second');
      const [row] = await sql`SELECT payload FROM harness_shared.work_items
        WHERE harness_slug = ${HARNESS} AND feature_id = ${id}`;
      expect(row.payload).toEqual({});
    }
  });

  it('a STALE del (older than the standing row) must NOT erase it', async () => {
    const id = 'F-oo-del';
    expect(await apply(featurePut(id, 'live', 3000))).toBe(true);
    // An older delete arrives out of order — the ts-guarded DELETE matches nothing.
    await apply(featureDel(id, 1000));
    expect(await statusOf(id)).toBe('live');
    // A newer delete DOES remove it.
    await apply(featureDel(id, 4000));
    expect(await statusOf(id)).toBeNull();
  });

  it('cross-process: a FRESH apply (empty fold) replaying an OLD op cannot clobber PG', async () => {
    const id = 'F-xproc';
    // Process A wrote the newer value.
    expect(await apply(featurePut(id, 'A-newer', 5000))).toBe(true);
    // Process B boots with an EMPTY cursor fold and happens to replay an OLD op
    // first (its in-memory guard sees no prior winner, so it WOULD apply it —
    // the PG order-key guard is the only thing protecting the row here).
    const freshApply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    await freshApply(featurePut(id, 'B-older', 2000));
    expect(await statusOf(id)).toBe('A-newer');
  });
});

describe('post-cursor-reset double-apply safety (audit P-068)', () => {
  it('replaying the WHOLE history over the standing fixpoint converges back, in log order AND the worst order (stale del last)', async () => {
    const id = 'F-reset-replay';
    // Live history reached its fixpoint: put(1000) → put(2000); a stale del(1500) lost.
    await apply(featurePut(id, 'v1', 1000));
    await apply(featurePut(id, 'v2', 2000));
    await apply(featureDel(id, 1500));
    expect(await statusOf(id)).toBe('v2');

    // A cursor reset (log removal / truncation / fresh boot) re-folds the whole
    // history from index 0 against the already-final PG rows. Fresh apply =
    // empty in-memory winners fold, so the SQL guards alone carry correctness.
    const replayA = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    await replayA(featurePut(id, 'v1', 1000));
    await replayA(featureDel(id, 1500));
    await replayA(featurePut(id, 'v2', 2000));
    expect(await statusOf(id)).toBe('v2');

    // The audit's named case: the stale del re-applies LAST, after the newer
    // put already holds the row — the ts-guarded DELETE must match nothing.
    const replayB = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    await replayB(featurePut(id, 'v2', 2000));
    await replayB(featurePut(id, 'v1', 1000));
    await replayB(featureDel(id, 1500));
    expect(await statusOf(id)).toBe('v2');
  });

  it('a del that WON the fixpoint stays won across a replay (the put-first transient re-deletes)', async () => {
    const id = 'F-reset-del-won';
    await apply(featurePut(id, 'v1', 1000));
    await apply(featureDel(id, 3000));
    expect(await statusOf(id)).toBeNull();

    // Reset replay with the put's log folded FIRST: deletes leave no PG
    // tombstone, so the older put re-INSERTs — a BOUNDED transient (documented
    // in read-merge.ts; the del re-applies within the same fold or, if beyond
    // the per-pass budget, within the backlog's passes). The fixpoint holds.
    const replay = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    await replay(featurePut(id, 'v1', 1000));
    expect(await statusOf(id)).toBe('v1'); // the documented transient resurrect
    await replay(featureDel(id, 3000));
    expect(await statusOf(id)).toBeNull(); // …re-deleted at the fixpoint
  });
});

describe('work-item dispatch columns federate (su-ae509 finding, 2026-06-10)', () => {
  const dispatchOf = async (id: string) => {
    const rows = await sql<
      Array<{
        item_kind: string;
        feature_order: number | null;
        swarm_affinity: string | null;
        redundancy: number | null;
        payload: unknown;
        status: string | null;
      }>
    >`
      SELECT item_kind, feature_order, swarm_affinity, redundancy, payload, status
      FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = ${HARNESS} AND feature_id = ${id}`;
    return rows[0] ?? null;
  };

  it('item_kind / feature_order / swarm_affinity / redundancy / payload round-trip through the projection', async () => {
    const id = 'F-dispatch';
    await apply(
      featurePut(id, 'queued', 1000, {
        item_kind: 'chunk',
        feature_order: 7,
        swarm_affinity: 'swarm-b',
        redundancy: 2,
        payload: { question: 'what is the answer?' },
      }),
    );
    expect(await dispatchOf(id)).toMatchObject({
      item_kind: 'chunk',
      feature_order: 7,
      swarm_affinity: 'swarm-b',
      redundancy: 2,
      payload: { question: 'what is the answer?' },
      status: 'queued',
    });

    // A Queen reorder federates: the newer op moves feature_order.
    await apply(
      featurePut(id, 'queued', 2000, {
        item_kind: 'chunk',
        feature_order: 1,
        swarm_affinity: 'swarm-b',
        redundancy: 2,
        payload: { question: 'what is the answer?' },
      }),
    );
    expect((await dispatchOf(id))!.feature_order).toBe(1);
  });

  it('an op WITHOUT dispatch fields (pre-2026-06-10 history) still applies and cannot flip item_kind back to feature', async () => {
    const id = 'F-dispatch-old';
    await apply(featurePut(id, 'queued', 1000, { item_kind: 'chunk', payload: { q: 1 } }));
    expect((await dispatchOf(id))!.item_kind).toBe('chunk');

    // A NEWER old-shape op (no dispatch fields) updates content; the
    // discriminator is immutable and must survive the defaulted 'feature'.
    await apply(featurePut(id, 'running', 2000));
    const after = await dispatchOf(id);
    expect(after!.status).toBe('running');
    expect(after!.item_kind).toBe('chunk');
  });
});
