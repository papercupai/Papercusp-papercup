/**
 * crash-recovery-drain.integration.test.ts — Brief S (Wave 3): substrate durability
 * & crash/restart recovery, the DRAIN-RESUME core (scenarios #1 + #4).
 *
 * WHY THIS FILE EXISTS. The AT-LEAST-ONCE outbox-drain contract (`outbox-drain.ts`:
 * a row's `drained_at` is stamped ONLY after `handle.append` resolves; if append
 * throws, the error propagates and the row + ALL later rows stay undrained for the
 * next pass) is asserted by NO test under an actual crash. `cold-boot-resume.test.ts`
 * (Brief F) restarts a peer's OWN log but never touches the outbox→drain→drained_at
 * path; `wire-outbox-drain-online` runs the drain to completion (no crash);
 * `feature-content-federation` is the clean happy path. This file kills the drain
 * MID-FLIGHT and asserts it resumes with no loss / no dup — the crash-recovery
 * property a public deployment depends on (the box this session ran on restarted
 * mid-effort).
 *
 * WHAT IS REAL. Real testcontainer Postgres; the REAL migration-102 capture trigger
 * + `substrate_outbox`; the REAL `drainOutboxOnce` (its at-least-once halt-and-retry
 * + `drained_at` stamping); real corestore-backed own log; the REAL features
 * projection on the "B" side (so convergence is asserted on materialized rows, not a
 * model). The only injected fault is the crash itself (a Proxy that makes
 * `handle.append` throw after K rows = an instance dying mid-drain).
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { closeHarnessStore, _resetCacheForTests } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import { drainOutboxOnce } from '../outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  FILL_WORKSPACE_ID_DDL,
  HARNESS_ISSUES_CONSOLIDATED_FED_DDL,
} from '../../../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-crash-recovery';
const HARNESS_SLUG = 'crash-recovery';
// A "B" own-log key distinct from A's, so ops sourced from A's log project origin='remote'.
const B_OWN_KEY = 'b'.repeat(64);

const FRAMEWORK_ROLES_DDL = `
  DO $r$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
  END $r$;
`;

// Before this file's own afterEach, so the stub outlives substrate teardown (WI-6554700010008561).
stubHivePolicyReadsForSuite();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

/** The real send-side schema: mig-102 capture trigger + outbox, the consolidated
 *  features table the trigger reads, the projects row mapping harness→workspace, and
 *  the fed_ts-masked UPDATE capture trigger. Mirrors feature-content-federation. */
async function setupPeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  // P-010 unification: work_items base + hfc/ei compat views (instead of hand-rolled hfc/issues).
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, slug TEXT,
      workspace_id TEXT, created_ts BIGINT NOT NULL, updated_ts BIGINT NOT NULL
    );
  `);
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-cr', 'CrashRecovery', 'active', ${HARNESS_SLUG}, ${WORKSPACE_ID}, 0, 0)
  `;
  // P-010 unification send-side: outbox + fill (on work_items) + legacy issues table + the
  // work_items CDC capture (mig 375).
  await sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await sql.unsafe(FILL_WORKSPACE_ID_DDL);
  await sql.unsafe(HARNESS_ISSUES_CONSOLIDATED_FED_DDL);
  const stripMig = (s: string) =>
    s
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
      })
      .join('\n');
  await sql.unsafe(stripMig(readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')));
}

/** Boot a single peer's own-log substrate (no swarm) at a fixed root, with a
 *  PG-projecting features apply. Re-callable on the same root to model a restart. */
async function bootPeer(sql: postgres.Sql, workspaceRoot: string): Promise<BootedHarnessHandle> {
  const handle = await bootHarnessSubstrate({
    workspaceRoot,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    applyOverride: buildPeerApply(sql, undefined),
    loadRevokedOverride: async () => new Set(),
    rekeyDepsOverride: null, // no re-key build through the live org-admin pool (WI-6554700010008561)
  });
  return handle;
}

/** Real features projection bound to `sql`. `ownLogKeyHex` undefined ⇒ origin
 *  resolves to remote for any op carrying a sourceLogKeyHex (the B side). */
function buildPeerApply(sql: postgres.Sql, ownLogKeyHex: string | undefined): (op: OpEnvelope) => Promise<boolean> {
  const scoped = new Map<string, TableProjection<unknown>>();
  const p = buildHarnessFeaturesProjection({ workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG, sql }) as TableProjection<unknown>;
  scoped.set(p.tableTag, p);
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex: ownLogKeyHex ?? '' });
}

async function insertFeature(sql: postgres.Sql, featureId: string, ts: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, ts, created_ts, updated_ts, origin)
    VALUES (${WORKSPACE_ID}, ${HARNESS_SLUG}, ${featureId}, ${'T-' + featureId}, 'todo', ${ts}, ${ts}, ${ts}, 'local')
  `;
}

async function outboxCounts(sql: postgres.Sql): Promise<{ total: number; drained: number; undrained: number }> {
  const [r] = await sql<Array<{ total: number; drained: number; undrained: number }>>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE drained_at IS NOT NULL)::int AS drained,
           count(*) FILTER (WHERE drained_at IS NULL)::int AS undrained
      FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}`;
  return r;
}

/** Read every op on a handle's own log (decoded), in append order. */
async function readLog(handle: BootedHarnessHandle): Promise<PeerLogOp[]> {
  const out: PeerLogOp[] = [];
  for (let i = 0; i < handle.ownLog.length; i++) {
    const op = await handle.ownLog.get(i);
    if (op) out.push(op);
  }
  return out;
}

/** A crash proxy: delegates everything to `handle` but makes `append` throw once it
 *  has appended `k` rows — an instance dying mid-drain (between rows k and k+1). */
function crashAfter(handle: BootedHarnessHandle, k: number): BootedHarnessHandle {
  let appended = 0;
  return new Proxy(handle, {
    get(target, prop, recv) {
      if (prop === 'append') {
        return async (op: PeerLogOp) => {
          if (appended >= k) throw new Error('CRASH mid-drain (instance died)');
          appended++;
          return target.append(op);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

describe('Brief S — crash/restart recovery: drain resume (#1) + at-least-once dedup (#4)', () => {
  it('#1 instance crash mid-drain → restart → outbox resumes, no loss, no dup, joiner converges', async () => {
    const dbA: FreshPgDb = await createFreshPgDb('crashA');
    cleanups.push(() => dbA.cleanup());
    const dbB: FreshPgDb = await createFreshPgDb('crashB');
    cleanups.push(() => dbB.cleanup());
    await setupPeerSchema(dbA.sql);
    await setupPeerSchema(dbB.sql);

    const root = mkdtempSync(join(tmpdir(), 'crash-recovery-'));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const handle = await bootPeer(dbA.sql, root);
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
    });

    // Seed N features → the capture trigger enqueues N undrained outbox rows.
    const N = 8;
    const K = 3; // crash after this many appended
    for (let i = 0; i < N; i++) await insertFeature(dbA.sql, `F-${i}`, 1000 + i);
    expect((await outboxCounts(dbA.sql)).undrained).toBe(N);

    // CRASH MID-DRAIN: append throws after K → K appended+drained, the (K+1)th throws
    // BEFORE its append (so not appended, not drained), rows K+1..N stay undrained.
    await expect(drainOutboxOnce(crashAfter(handle, K), dbA.sql)).rejects.toThrow('CRASH mid-drain');
    const mid = await outboxCounts(dbA.sql);
    expect(mid.drained, 'exactly K rows drained before the crash').toBe(K);
    expect(mid.undrained, 'the rest stay undrained for resume').toBe(N - K);
    expect(handle.ownLog.length, 'own log holds exactly K ops mid-crash').toBe(K);

    // RESTART: a clean drain resumes — appends the remaining N-K, marks them drained.
    const drained2 = await drainOutboxOnce(handle, dbA.sql);
    expect(drained2).toBe(N - K);
    const after = await outboxCounts(dbA.sql);
    expect(after.drained, 'ALL rows drained after resume — no loss').toBe(N);
    expect(after.undrained).toBe(0);

    // NO DUP on the log: exactly N ops, each feature_id once (the throw prevented a
    // partial append, so resume re-appended only the genuinely-undrained tail).
    const log = await readLog(handle);
    expect(log.length, 'own log has exactly N ops (no duplicate append)').toBe(N);
    const ids = log.map((op) => op.hbKey);
    expect(new Set(ids).size, 'every feature_id appears exactly once').toBe(N);
    for (let i = 0; i < N; i++) expect(new Set(ids).has(`F-${i}`)).toBe(true);

    // JOINER CONVERGES: apply A's full log into B's REAL features projection
    // (origin=remote, since B's own key differs) → B holds all N features, no loss.
    const applyB = buildPeerApply(dbB.sql, B_OWN_KEY);
    for (const op of log) {
      await applyB({
        type: op.type,
        table: op.table,
        hbKey: op.hbKey,
        value: op.value,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        writerPubkey: op.author_pubkey,
        sourceLogKeyHex: handle.ownLog.keyHex,
      });
    }
    const bRows = await dbB.sql<Array<{ feature_id: string; origin: string }>>`
      SELECT feature_id, origin FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS_SLUG}`;
    expect(bRows.length, 'joiner B materialized all N features — no loss across the crash').toBe(N);
    expect(new Set(bRows.map((r) => r.feature_id))).toEqual(new Set(Array.from({ length: N }, (_, i) => `F-${i}`)));
    expect(bRows.every((r) => r.origin === 'remote'), 'all federated rows are origin=remote').toBe(true);
  }, 90_000);

  it('#4 torn write (append OK, drained_at lost) → re-drain re-appends → projection dedups to one row per key', async () => {
    const dbA: FreshPgDb = await createFreshPgDb('tornA');
    cleanups.push(() => dbA.cleanup());
    const dbB: FreshPgDb = await createFreshPgDb('tornB');
    cleanups.push(() => dbB.cleanup());
    await setupPeerSchema(dbA.sql);
    await setupPeerSchema(dbB.sql);

    const root = mkdtempSync(join(tmpdir(), 'torn-write-'));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const handle = await bootPeer(dbA.sql, root);
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
    });

    const N = 4;
    for (let i = 0; i < N; i++) await insertFeature(dbA.sql, `G-${i}`, 2000 + i);
    // Clean drain: all N appended + drained.
    expect(await drainOutboxOnce(handle, dbA.sql)).toBe(N);
    expect(handle.ownLog.length).toBe(N);

    // TORN WRITE: model "append succeeded but the drained_at UPDATE was lost to the
    // crash" by RE-ARMING two already-drained rows (drained_at → NULL). The next
    // drain re-appends them — DUPLICATE ops on the log (the at-least-once cost) —
    // which is exactly the case outbox-drain.ts says "is deduped by the idempotent"
    // projection guard.
    await dbA.sql`
      UPDATE harness_shared.substrate_outbox SET drained_at = NULL
       WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HARNESS_SLUG}
         AND key IN ('G-0', 'G-2')`;
    const reDrained = await drainOutboxOnce(handle, dbA.sql);
    expect(reDrained, 're-drain re-appended the two re-armed rows').toBe(2);
    expect(handle.ownLog.length, 'the log now carries DUPLICATE ops (N + 2)').toBe(N + 2);

    // CONVERGENCE under duplicates: apply A's whole log (with the dups) into B's REAL
    // projection. The fed_ts/HLC LWW guard makes the duplicate apply idempotent — B
    // materializes exactly ONE row per feature_id (no resurrection, no double-row).
    const applyB = buildPeerApply(dbB.sql, B_OWN_KEY);
    for (const op of await readLog(handle)) {
      await applyB({
        type: op.type, table: op.table, hbKey: op.hbKey, value: op.value, ts: op.ts,
        schema_version: op.schema_version, ...(op.hlc ? { hlc: op.hlc } : {}),
        writerPubkey: op.author_pubkey, sourceLogKeyHex: handle.ownLog.keyHex,
      });
    }
    const bRows = await dbB.sql<Array<{ feature_id: string }>>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS_SLUG}`;
    expect(bRows.length, 'duplicates deduped — exactly N rows on B').toBe(N);
    expect(new Set(bRows.map((r) => r.feature_id))).toEqual(new Set(Array.from({ length: N }, (_, i) => `G-${i}`)));
  }, 90_000);

  it('#5 long downtime → a LARGE accumulated outbox backfills FULLY across multi-pass drain on restart (no loss)', async () => {
    const dbA: FreshPgDb = await createFreshPgDb('gapA');
    cleanups.push(() => dbA.cleanup());
    const dbB: FreshPgDb = await createFreshPgDb('gapB');
    cleanups.push(() => dbB.cleanup());
    await setupPeerSchema(dbA.sql);
    await setupPeerSchema(dbB.sql);

    const root = mkdtempSync(join(tmpdir(), 'long-downtime-'));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const handle = await bootPeer(dbA.sql, root);
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
    });

    // LONG DOWNTIME: the drain never ran while a LARGE backlog accumulated in the
    // outbox (M > DEFAULT_DRAIN_BATCH, so a single pass cannot clear it).
    const M = 250;
    for (let i = 0; i < M; i++) await insertFeature(dbA.sql, `H-${i}`, 3000 + i);
    expect((await outboxCounts(dbA.sql)).undrained).toBe(M);

    // RESTART: the drain catches the WHOLE backlog across multiple bounded passes
    // (batch < M forces the deferral path). Quiescence = a pass that drains 0.
    const BATCH = 50;
    let passes = 0;
    let total = 0;
    for (;;) {
      const d = await drainOutboxOnce(handle, dbA.sql, { batch: BATCH });
      if (d === 0) break;
      total += d;
      passes++;
      if (passes > 50) break; // runaway guard
    }
    expect(passes, 'multi-pass deferral ran (not one big pass)').toBeGreaterThanOrEqual(Math.ceil(M / BATCH));
    expect(total).toBe(M);
    const after = await outboxCounts(dbA.sql);
    expect(after.drained, 'the entire backlog drained on restart — no loss across the long downtime').toBe(M);
    expect(after.undrained).toBe(0);
    expect(handle.ownLog.length, 'own log holds exactly M ops (no dup)').toBe(M);

    // Joiner converges to the FULL gap (not a truncated head).
    const applyB = buildPeerApply(dbB.sql, B_OWN_KEY);
    for (const op of await readLog(handle)) {
      await applyB({
        type: op.type, table: op.table, hbKey: op.hbKey, value: op.value, ts: op.ts,
        schema_version: op.schema_version, ...(op.hlc ? { hlc: op.hlc } : {}),
        writerPubkey: op.author_pubkey, sourceLogKeyHex: handle.ownLog.keyHex,
      });
    }
    const [{ c }] = await dbB.sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS_SLUG}`;
    expect(c, 'joiner backfilled the full long-downtime gap — no loss/truncation').toBe(M);
  }, 120_000);

  it('#6 HLC clock survives restart — hlc_now() never regresses, even after a future recv-advance (mig-314, no D-001-class divergence post-restart)', async () => {
    const db: FreshPgDb = await createFreshPgDb('hlcRestart');
    cleanups.push(() => db.cleanup());
    await db.sql.unsafe(FRAMEWORK_ROLES_DDL);
    // Apply ONLY section 1 of the real mig-314 (the hlc_clock singleton + hlc_now /
    // hlc_recv), verbatim from the migration file (no drift) — the fed_hlc column
    // ALTERs (section 2+) need the consolidated tables, which this clock test doesn't.
    const mig314 = readFileSync(join(SQL_DIR, '314-d001-hlc-ordering-key.sql'), 'utf8');
    const hlcSection = mig314.split('-- ── 2. fed_hlc ordering column')[0];
    await db.sql.unsafe(hlcSection);

    const now = async () => (await db.sql<Array<{ h: string }>>`SELECT harness_shared.hlc_now() AS h`)[0].h;

    // Monotonic within a session: successive stamps strictly increase (fixed-width
    // encoding → string `>` equals causal order).
    const h1 = await now();
    const h2 = await now();
    expect(h2 > h1, 'hlc_now is monotonic').toBe(true);

    // A peer observes a remote HLC far in the FUTURE (well above wall-clock) — the
    // recv-advance (observeRemoteHlc, PG-side). This is the exact mechanism that, if
    // the clock reset on restart, would let a later write get a LOWER HLC → D-001.
    const FUTURE_MS = 9_999_999_999_999; // ~year 2286
    const futureHlc = `${String(FUTURE_MS).padStart(15, '0')}:00042`;
    await db.sql`SELECT harness_shared.hlc_recv(${futureHlc})`;

    // The advance is PERSISTED in the singleton clock — THIS is what survives a
    // process restart (it is durable table state, not operator memory).
    const [clock] = await db.sql<Array<{ last_ms: number }>>`
      SELECT last_ms FROM harness_shared.hlc_clock WHERE id = 1`;
    expect(Number(clock.last_ms), 'the future advance is durably stored').toBe(FUTURE_MS);

    // "RESTART": the operator process restarts and reconnects to the SAME PG. The
    // next hlc_now() reads the PERSISTED advanced clock and continues STRICTLY-GREATER
    // than the future — it does NOT regress to wall-clock. (A process-memory clock
    // would reset here → a later write under-stamps → divergence.)
    const h3 = await now();
    expect(h3 > futureHlc, 'hlc_now after restart must exceed the advanced future (no regression)').toBe(true);
    expect(h3.startsWith(String(FUTURE_MS).padStart(15, '0')), 'its ms is the future ms, not wall-clock').toBe(true);
  }, 60_000);
});
