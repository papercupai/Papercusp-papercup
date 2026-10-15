/**
 * wire-outbox-drain-online.integration.test.ts — the EI-521 send-side seam.
 *
 * ## The blind spot this closes
 * Three things were each proven in isolation, but the SEAM between them was not:
 *   - `outbox-drain.integration.test.ts` drives `startOutboxDrain` DIRECTLY.
 *   - `feature-content-federation.integration.test.ts` proves the full round-trip
 *     but calls `drainOutboxOnce` MANUALLY (never the live loop) and boots via
 *     `bootHarnessSubstrate` directly.
 *   - `join-default-boot-wiring.test.ts` proves the join orchestrator CALLS
 *     `bootSingleHarness` — but MOCKS it, so the drain wiring inside never runs.
 *
 * So NOTHING proved that `wireOutboxForHarness` (the seam `bootSingleHarness`
 * uses after a substrate boots) actually brings the drain loop ONLINE and
 * auto-drains a captured write. EI-521 is exactly that gap: a joined hive member
 * boots, `peer_connected` fires, but its outbox sits UNDRAINED forever ("0 drain
 * loops") → writes never federate. Every existing test stays green because they
 * drain by hand.
 *
 * ## What this proves
 * After `wireOutboxForHarness(handle, pg)` — and with NO manual `drainOutboxOnce`
 * — a feature inserted afterward is AUTO-drained by the live loop: the REAL
 * migration-102 capture trigger enqueues an outbox row, the LISTEN/poll loop the
 * seam started picks it up, `handle.append` carries it to the own log, and the
 * row's `drained_at` is stamped. LISTEN and managed-poll delivery are exercised
 * independently; foreign workspace/harness rows and disabled wakes are controls.
 * Every write follows completion of the initial empty catch-up SELECT, so that
 * startup work cannot masquerade as a live wake.
 *
 * Real: testcontainer Postgres, the verbatim capture+fill migrations, the real
 * `wireOutboxForHarness` → `startOutboxDrain` loop. Stood in: the corestore/swarm
 * (a `makeFakeBootedHandle` captures `append`s) — irrelevant to the drain seam,
 * and proven elsewhere.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import {
  configureScheduledRegistry,
  listManaged,
  resetScheduledRegistry,
  type TimerHandle,
} from '@papercusp/scheduled-registry';
import { wireOutboxForHarness } from '../wire-outbox';
import { DEFAULT_POLL_MS, startOutboxDrain, type StartDrainOptions } from '../outbox-drain';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { makeFakeBootedHandle } from './fake-booted-handle';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .../packages/operator-core/lib/sync/hyperbee/__tests__ → repo root is six up.
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const WORKSPACE_ID = 'ws-ei521-drain';
const HARNESS_SLUG = 'amem-ei521'; // a joined-hive-member-shaped slug

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a drain loop / db
    }
  }
});

/** Cluster-global framework roles the migration GRANTs reference (idempotent). */
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

/**
 * Build the minimal-but-faithful federation schema and apply the REAL
 * migration-102 (capture trigger + outbox) and 103 (workspace_id fill trigger)
 * verbatim — so the send-side this test drives is the production trigger. A
 * `projects` row maps `harness_slug → WORKSPACE_ID` so the fill trigger stamps
 * the SAME workspace_id the drain filters on. Mirrors the proven setup in
 * `feature-content-federation.integration.test.ts`.
 */
async function setupSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id        TEXT NOT NULL DEFAULT '',
      harness_slug        TEXT NOT NULL,
      feature_id          TEXT NOT NULL,
      title               TEXT,
      summary             TEXT,
      status              TEXT,
      attempts            INT,
      claims              TEXT,
      notes               TEXT,
      metadata            JSONB,
      kind                TEXT,
      project_id          TEXT,
      expected_cost_cents INT,
      tags                JSONB,
      needs_human_review  BOOLEAN,
      ts                  BIGINT,
      created_ts          BIGINT,
      updated_ts          BIGINT,
      parent_id           TEXT,
      goal_id             TEXT,
      taken_by            TEXT,
      taken_at            TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      item_kind           TEXT NOT NULL DEFAULT 'feature',
      feature_order       INTEGER,
      swarm_affinity      TEXT,
      redundancy          INTEGER,
      payload             JSONB,
      author_pubkey       TEXT,
      origin              TEXT NOT NULL DEFAULT 'local',
      fed_ts              BIGINT,
      fed_hlc             TEXT,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      harness_slug      TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT NOT NULL,
      severity          TEXT NOT NULL,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      found_at          TIMESTAMPTZ NOT NULL,
      found_during      TEXT,
      repro             TEXT,
      evidence          TEXT,
      suggested_fix     TEXT,
      code_pointer      TEXT,
      linked_feature_id TEXT,
      attempts          INT NOT NULL DEFAULT 0,
      notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_ts        BIGINT NOT NULL,
      updated_ts        BIGINT NOT NULL,
      author_pubkey     TEXT,
      origin            TEXT NOT NULL DEFAULT 'local',
      fed_ts            BIGINT,
      fed_hlc           TEXT,
      PRIMARY KEY (harness_slug, issue_id)
    );
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
  `);

  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-ei521', 'EI521', 'active', ${HARNESS_SLUG}, ${WORKSPACE_ID}, 0, 0)
  `;

  for (const file of [
    'archive/102-substrate-outbox.sql',
    'archive/103-issues-workspace-id-fill-trigger.sql',
    'archive/104-substrate-meta.sql', // the one-time-backfill marker table
  ]) {
    await sql.unsafe(readFileSync(join(SQL_DIR, file), 'utf8'));
  }

  // WI-3192 cluster (2): migration 495 added drained_log_key so outbox-drain
  // can stamp which own-log key drained each row and detect prior-era orphan
  // tails — the live drain writer (outbox-drain.ts) always writes it. This
  // fixture replays only the creating migration (102), so keep the schema
  // aligned with the current writer (mirrors composition-rig.ts's ALTER).
  await sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS drained_log_key TEXT`);

  // Stamp the one-time-backfill `backfill_done` marker so wireOutboxForHarness's
  // backfill SHORT-CIRCUITS (the seam under test is the live DRAIN, not the
  // backfill, which is proven elsewhere and reads tables this minimal schema
  // omits). Backfill failure is best-effort anyway — but skipping keeps the
  // test deterministic + console-clean.
  await sql`
    INSERT INTO harness_shared.substrate_meta (workspace_id, harness_slug, key, value)
    VALUES (${WORKSPACE_ID}, ${HARNESS_SLUG}, 'backfill_done', '0')
    ON CONFLICT (workspace_id, harness_slug, key) DO NOTHING
  `;

  // EI-79 step 2 (mig 181): mask the fed_ts LWW-guard column from the broad
  // capture compare (mirrors the proven setup), so an own-log merge-back doesn't
  // re-enqueue forever.
  await sql.unsafe(`
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
  `);
}

async function outboxRow(sql: postgres.Sql, key: string) {
  const rows = await sql<Array<{ workspace_id: string; harness_slug: string; drained_at: number | null }>>`
    SELECT workspace_id, harness_slug, drained_at
      FROM harness_shared.substrate_outbox
     WHERE table_name = 'harness_features_consolidated' AND key = ${key}
  `;
  return rows[0];
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const POLL_TIMER = 'hyperbee-outbox-drain-poll';
const OWN_PAYLOAD = `${WORKSPACE_ID}::${HARNESS_SLUG}`;
const OTHER_HARNESS = 'other-harness';
const OTHER_WORKSPACE = 'ws-other';
type WakeMode = 'listen' | 'poll' | 'disabled';
type DiagnosticEvent = Parameters<NonNullable<StartDrainOptions['onDiagnosticEvent']>>[0];

/** Keep the real boot/drain seam, replacing only its external wake resources. */
async function wireFixture(db: FreshPgDb, mode: WakeMode) {
  const fake = makeFakeBootedHandle({ workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG });
  const selections: number[] = [];
  const notifications: string[] = [];
  const stages: DiagnosticEvent[] = [];
  let listenReady = false;
  const drain = await wireOutboxForHarness(fake.handle, db.sql, {
    startOutboxDrain: (handle, pg, options) => {
      const observedPg = new Proxy(pg, {
        apply(target, thisArg, args) {
          const query = Reflect.apply(target, thisArg, args);
          if (Array.isArray(args[0]) && args[0].join('').includes('WITH priority AS')) {
            return query.then((rows: unknown[]) => {
              selections.push(rows.length);
              return rows;
            });
          }
          return query;
        },
      });
      return startOutboxDrain(handle, observedPg, {
        ...options,
        // The server's shared hub connects to the admin database, not this
        // freshly-created fixture database. Subscribe to the actual writer DB.
        listen: async (channel, onNotify) => {
          if (mode !== 'listen') return () => undefined;
          const subscription = await pg.listen(channel, (payload) => {
            notifications.push(payload);
            onNotify(payload);
          });
          listenReady = true;
          return () => { void subscription.unlisten(); };
        },
        // Poll tests retain the production cadence; other modes cannot be
        // rescued by a poll when their LISTEN assertion is broken.
        ...(mode === 'poll' ? {} : { pollMs: 0 }),
        diagnosticsEnabled: true,
        onDiagnosticEvent: (event) => { stages.push(event); },
      });
    },
  });
  cleanups.push(() => drain.stop());

  expect(await pollUntil(() => selections.length > 0, { timeoutMs: 5000, intervalMs: 25 })).toBe(true);
  expect(selections).toEqual([0]);
  // Let the empty pass settle before inserting; the SELECT must have completed,
  // not merely been submitted while the test races ahead to its INSERT.
  await new Promise<void>((done) => setImmediate(done));
  if (mode === 'listen') {
    expect(await pollUntil(() => listenReady, { timeoutMs: 5000, intervalMs: 25 })).toBe(true);
  }
  return { ...fake, selections, notifications, stages };
}

async function freshFixture(prefix: string) {
  const db = await createFreshPgDb(prefix);
  cleanups.push(() => db.cleanup());
  await setupSchema(db.sql);
  return db;
}

async function insertFeature(sql: postgres.Sql, key: string, harnessSlug = HARNESS_SLUG) {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, status, attempts, origin, ts, created_ts, updated_ts)
    VALUES (${harnessSlug}, ${key}, 'EI-521 send-side', 'todo', 0, 'local', 1001, 1001, 1001)
  `;
}

/** Each foreign row differs in exactly ONE scope dimension. */
async function insertForeignRows(sql: postgres.Sql) {
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-other', 'Other', 'active', ${OTHER_HARNESS}, ${WORKSPACE_ID}, 0, 0)
  `;
  await insertFeature(sql, 'F-other-harness', OTHER_HARNESS);
  await sql`UPDATE harness_shared.projects SET workspace_id = ${OTHER_WORKSPACE} WHERE slug = ${HARNESS_SLUG}`;
  await insertFeature(sql, 'F-other-workspace');
  await sql`UPDATE harness_shared.projects SET workspace_id = ${WORKSPACE_ID} WHERE slug = ${HARNESS_SLUG}`;
}

async function expectForeignRowsUndrained(sql: postgres.Sql) {
  expect(await outboxRow(sql, 'F-other-harness')).toMatchObject({
    workspace_id: WORKSPACE_ID, harness_slug: OTHER_HARNESS, drained_at: null,
  });
  expect(await outboxRow(sql, 'F-other-workspace')).toMatchObject({
    workspace_id: OTHER_WORKSPACE, harness_slug: HARNESS_SLUG, drained_at: null,
  });
}

async function expectDelivered(db: FreshPgDb, fixture: Awaited<ReturnType<typeof wireFixture>>, key: string) {
  const drained = await pollUntil(async () => {
    const row = await outboxRow(db.sql, key);
    return row?.drained_at != null ? row : undefined;
  }, { timeoutMs: 10_000, intervalMs: 25 });
  expect(drained, JSON.stringify({
    selections: fixture.selections, notifications: fixture.notifications, stages: fixture.stages,
    timers: listManaged().filter((timer) => timer.name === POLL_TIMER),
  })).toMatchObject({ workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG });
  expect(fixture.appended).toHaveLength(1);
  expect(fixture.handle.ownLog.length).toBe(1);
  expect(fixture.selections).toContain(1);
  expect(fixture.stages).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'hypercore-append' }),
    expect.objectContaining({ stage: 'mark-drained' }),
  ]));
}

describe('EI-521 — wireOutboxForHarness brings the drain loop ONLINE and auto-drains a captured write', () => {
  it('LISTEN-only: a post-startup captured write reaches append and drained_at without polling', async () => {
    const db = await freshFixture('ei521listen');
    const fixture = await wireFixture(db, 'listen');
    expect(listManaged().find((timer) => timer.name === POLL_TIMER)).toBeUndefined();
    await insertFeature(db.sql, 'F-listen');
    await expectDelivered(db, fixture, 'F-listen');
    expect(fixture.notifications).toEqual([OWN_PAYLOAD]);
  }, 30_000);

  it('POLL-only: the registered production-cadence tick drains a captured write with NOTIFY dropped', async () => {
    const callbacks = new Map<TimerHandle, { fire: () => void; intervalMs: number }>();
    // Vitest intentionally suppresses default real background intervals. Use
    // the maintained registry backend, exercising its registered callback (not
    // drainOutboxOnce) without moving PG's socket/timeout clocks.
    cleanups.push(() => resetScheduledRegistry());
    configureScheduledRegistry({
      setIntervalImpl: (fire, intervalMs) => {
        const timer: TimerHandle = { unref: () => undefined };
        callbacks.set(timer, { fire, intervalMs });
        return timer;
      },
      clearIntervalImpl: (timer) => { callbacks.delete(timer); },
    });
    const db = await freshFixture('ei521poll');
    const fixture = await wireFixture(db, 'poll');
    const timer = listManaged().find((entry) => entry.name === POLL_TIMER);
    expect(timer).toMatchObject({ intervalMs: DEFAULT_POLL_MS, fires: 0, lastFireAt: null });
    expect(callbacks.size).toBe(1);
    const [tick] = callbacks.values();
    expect(tick.intervalMs).toBe(DEFAULT_POLL_MS);
    await insertForeignRows(db.sql);
    await insertFeature(db.sql, 'F-poll');
    expect(await outboxRow(db.sql, 'F-poll')).toMatchObject({ drained_at: null });
    expect(fixture.selections).toEqual([0]);
    expect(fixture.appended).toHaveLength(0);

    tick.fire();
    await expectDelivered(db, fixture, 'F-poll');
    expect(fixture.notifications).toEqual([]);
    expect(listManaged().find((entry) => entry.name === POLL_TIMER)).toMatchObject({
      fires: 1, lastFireAt: expect.any(Number), lastError: null,
    });
    await expectForeignRowsUndrained(db.sql);
  }, 30_000);

  it('SCOPE CONTROL: foreign harness and workspace NOTIFYs do not wake the live listener', async () => {
    const db = await freshFixture('ei521scope');
    const fixture = await wireFixture(db, 'listen');
    await insertForeignRows(db.sql);
    expect(await pollUntil(() => fixture.notifications.length === 2, {
      timeoutMs: 5000, intervalMs: 25,
    })).toBe(true);
    expect(fixture.notifications).toEqual(expect.arrayContaining([
      `${WORKSPACE_ID}::${OTHER_HARNESS}`, `${OTHER_WORKSPACE}::${HARNESS_SLUG}`,
    ]));
    await new Promise<void>((done) => setImmediate(done));
    expect(fixture.selections).toEqual([0]);
    expect(fixture.appended).toHaveLength(0);
    await expectForeignRowsUndrained(db.sql);

    // Prove the negative control used a functioning listener, then check that
    // a matching wake still cannot select either foreign row.
    await insertFeature(db.sql, 'F-own-after-foreign');
    await expectDelivered(db, fixture, 'F-own-after-foreign');
    await expectForeignRowsUndrained(db.sql);
  }, 30_000);

  it('DISABLED-WAKE CONTROL: startup catch-up cannot drain a later write without LISTEN or poll', async () => {
    const db = await freshFixture('ei521disabled');
    const fixture = await wireFixture(db, 'disabled');
    await insertFeature(db.sql, 'F-disabled');
    await new Promise((done) => setTimeout(done, 150));
    expect(await outboxRow(db.sql, 'F-disabled')).toMatchObject({
      workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG, drained_at: null,
    });
    expect(fixture.selections).toEqual([0]);
    expect(fixture.appended).toHaveLength(0);
    expect(fixture.notifications).toEqual([]);
    expect(listManaged().find((timer) => timer.name === POLL_TIMER)).toBeUndefined();
  }, 30_000);
});
