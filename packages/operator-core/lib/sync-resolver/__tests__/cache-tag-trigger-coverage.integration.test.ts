/**
 * cache-tag-trigger-coverage.integration.test.ts — the CACHE-TAG-BACKING coverage guard.
 *
 * THE GAP THIS CLOSES (caching-layer-tag-eca-2026-06-22 P-005)
 * -----------------------------------------------------------
 * `TABLE_TO_QUERY_NAMES` (sync-resolver/table-to-query-names.ts) is the authoritative
 * map a `harness_shared.<table>.changed` trigger event uses to invalidate the right
 * sync query names AND bump the right cache tags (P-006 / D-018). For that bridge to
 * FIRE on a write, the backing table MUST carry the generic
 * `harness_shared.emit_change_notify()` trigger — the producer of the
 * `sync_invalidate` LISTEN/NOTIFY stream (000-baseline.sql; payload + row-PK fix
 * mig-368).
 *
 * The producers are attached imperatively, scattered across migrations
 * (107/124/213/215/222/227/275/368/373). Nothing tied "is this table MAPPED in
 * TABLE_TO_QUERY_NAMES?" to "does it actually carry the trigger?" — so a table could
 * be added to the map (a new sync query reads it) with the trigger forgotten, and
 * every app-code `notifySyncInvalidate` would still appear to work while RAW-SQL and
 * FEDERATED writes (which depend on the local trigger — D-005) silently left the
 * cache stale on every node. An audit on 2026-06-22 found 34 of 48 mapped tables in
 * exactly that state; mig-373 closed them, and this guard keeps the door shut.
 *
 * WHY AN INTEGRATION TEST (not a grep of the DDL)
 * ----------------------------------------------
 * The triggers are attached by `CREATE [OR REPLACE] TRIGGER`, `DO $$ FOREACH`
 * loops, and dynamic `EXECUTE format(...)` across many files — grepping the SQL is
 * brittle. Mirroring the sibling stamp-coverage guard, this migrates an empty DB
 * 000-baseline → head through the REAL boot-path runner and introspects
 * active `pg_trigger` producers (the generic notifier or the tested dependency
 * notifier for work_item_deps), so a new mapped table that
 * forgets the trigger trips it automatically — no test edit needed.
 *
 * WHAT IT ASSERTS
 * ---------------
 * The required set is DERIVED from `TABLE_TO_QUERY_NAMES` itself (the keys), so it
 * can't drift from the source of truth:
 *
 *   Every `harness_shared.<table>` key in TABLE_TO_QUERY_NAMES MUST have the
 *   active recognized notification producer — UNLESS the table is in `COVERAGE_EXEMPT` with a
 *   documented reason.
 *
 * The core check is an EXACT set-equality (not a subset), which has teeth in three
 * directions: a newly-mapped table with no trigger → RED; a removed trigger → RED;
 * a STALE exemption (the table since gained the trigger) → RED, forcing the dead
 * allow-list entry out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { TABLE_TO_QUERY_NAMES } from '../table-to-query-names';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/operator-core/lib/sync-resolver/__tests__ → up 5 to the repo root.
const REPO_ROOT = resolve(HERE, '../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
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

const NOTIFY_FUNCTION = 'emit_change_notify';

/**
 * Cache-tag-backing tables that are MAPPED in TABLE_TO_QUERY_NAMES but
 * INTENTIONALLY do not carry the emit_change_notify trigger, EACH with the reason
 * + the condition to re-arm. A mapped table NOT here that lacks the trigger is the
 * bug this guard exists to catch.
 *
 * Two intentional categories today:
 *
 *   1. APPEND-HEAVY ACTIVITY LOGS — a per-row pg_notify on a high-write log is the
 *      performance-doc notify-storm anti-pattern (/internal/docs/performance). Their
 *      live invalidation is a coarse/debounced follow-up, NOT a per-row trigger
 *      (caching-layer-tag-eca-2026-06-22 P-005; restored by mig-376 after a duplicate
 *      373 over-attached them). RE-ARM: remove the entry only once the table gets a
 *      genuinely cheap/debounced producer, not a raw per-row trigger.
 *
 *   2. COMPAT VIEWS over the unified work_items base table — engineer_issues and
 *      harness_features_consolidated are relkind 'v' after mig-374, so they cannot
 *      carry a row trigger. Their writes route (via INSTEAD-OF) to work_items, whose
 *      emit_change_notify trigger fires work_items.changed — and work_items IS mapped
 *      (to the same query names), so the invalidation reaches the bridge. RE-ARM:
 *      remove the entry if the view is ever materialized into a real table.
 */
const COVERAGE_EXEMPT: Record<string, string> = {
  // (1) append-heavy activity logs — notify-storm; debounced invalidation is a follow-up.
  audit_log: 'append-heavy activity log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  agent_runs_consolidated: 'append-heavy run log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  user_actions: 'append-heavy action log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  harness_hook_logs: 'append-heavy hook log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  toast_log: 'append-heavy toast log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  feature_audit_consolidated:
    'append-heavy audit log; per-row notify = notify-storm. Debounced invalidation TODO (P-005).',
  agent_usage_samples:
    'append-heavy usage-telemetry log — one row per governed agent LLM call, fleet-wide; per-row ' +
    'notify = notify-storm. Verified audit_log-scale volume (WI-5374, 2026-07-19: 810 rows/24h, ' +
    '~26k accumulated vs audit_log\'s 2156/24h, ~25.6k). The evals.benchRunLive read wants a ' +
    'debounced follow-up, not a per-row trigger. Debounced invalidation TODO (P-005).',
  // (2) compat views over work_items (mig-374) — cannot carry a row trigger; producer is work_items.
  engineer_issues: 'compat VIEW over work_items (mig-374); invalidation fires from the mapped work_items base-table trigger.',
  harness_features_consolidated:
    'compat VIEW over work_items (mig-374); invalidation fires from the mapped work_items base-table trigger.',
};

/** The required tables = the keys of TABLE_TO_QUERY_NAMES, which are
 *  `harness_shared.<table>` strings. Parse them once; assert the schema is the
 *  one this guard introspects so a future cross-schema mapping fails loudly here
 *  instead of being silently un-checked. */
const requiredTables: string[] = (() => {
  const tables: string[] = [];
  for (const key of Object.keys(TABLE_TO_QUERY_NAMES)) {
    const dot = key.indexOf('.');
    const schema = dot >= 0 ? key.slice(0, dot) : '';
    const table = dot >= 0 ? key.slice(dot + 1) : key;
    if (schema !== 'harness_shared') {
      throw new Error(
        `TABLE_TO_QUERY_NAMES key '${key}' is not in the harness_shared schema; this ` +
          `coverage guard only introspects harness_shared. Extend the guard to cover ` +
          `schema '${schema}' before mapping a table there.`,
      );
    }
    tables.push(table);
  }
  return tables.sort();
})();

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'cachetrg',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
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
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('cache-tag-backing tables — every TABLE_TO_QUERY_NAMES table has the change-notify trigger', () => {
  /** Active generic producers, plus work_item_deps' semantic producer. Its real
   *  notification contract is covered by work-item-deps.integration.test.ts. */
  async function notifyTriggerTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared'
         AND pn.nspname = 'harness_shared'
         AND (p.proname = ${NOTIFY_FUNCTION}
           OR (c.relname = 'work_item_deps' AND p.proname = 'emit_work_item_dep_change_notify'))
         AND NOT t.tgisinternal
         AND t.tgenabled <> 'D'
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  it('sanity: the change-notify trigger introspects (a representative mapped table is present)', async () => {
    const withTrigger = await notifyTriggerTables();
    // harness_plans got its trigger in mig-124 — if THIS is absent the introspection
    // query or the migration apply is broken, not the invariant. Guards against a
    // silently-empty set making the core check vacuous.
    expect(
      withTrigger.has('harness_plans'),
      'change-notify trigger introspection returned nothing — query/migration broken',
    ).toBe(true);
  });

  it('credits one active semantic dependency producer without a redundant generic notifier', async () => {
    const rows = await sql<{ producer: string }[]>`
      SELECT p.proname AS producer FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE t.tgrelid = 'harness_shared.work_item_deps'::regclass
        AND pn.nspname = 'harness_shared' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND p.proname IN ('emit_change_notify', 'emit_work_item_dep_change_notify')`;
    expect(rows).toEqual([{ producer: 'emit_work_item_dep_change_notify' }]);
    expect((await notifyTriggerTables()).has('work_item_deps')).toBe(true);
  });

  it('every TABLE_TO_QUERY_NAMES table has an active producer, except the documented COVERAGE_EXEMPT set', async () => {
    const withTrigger = await notifyTriggerTables();

    const missing = requiredTables.filter((t) => !withTrigger.has(t)).sort();
    const exempt = Object.keys(COVERAGE_EXEMPT).sort();

    expect(
      missing,
      `Cache-tag-backing table(s) are MAPPED in TABLE_TO_QUERY_NAMES but MISSING the ` +
        `'${NOTIFY_FUNCTION}' trigger. The sync-sse bridge can't invalidate their query ` +
        `names / cache tags on a raw-SQL or FEDERATED write, so caches go silently stale ` +
        `on every node (D-005). For each: attach the generic trigger in a migration ` +
        `(mirror mig-222 / mig-373), OR — if the table intentionally has no change-notify ` +
        `producer — add it to COVERAGE_EXEMPT in this test with the reason + the ` +
        `re-arm condition. Undocumented vs documented-exempt diff is the failure.\n` +
        `  mapped-but-no-trigger: [${missing.join(', ')}]\n` +
        `  documented COVERAGE_EXEMPT: [${exempt.join(', ')}]`,
    ).toEqual(exempt);
  });

  it('reapplying the armed notification migrations preserves their single producers', async () => {
    for (const name of [
      '1365-unify-work-item-dep-change-notify',
      '1366-mapped-report-occurrence-change-notify',
      '1406-pr-review-reports-change-notify',
      '1549-plan-audits-change-notify',
    ]) {
      const migration = readFileSync(resolve(SQL_DIR, `${name}.sql`), 'utf8');
      await sql.unsafe(migration);
      await sql.unsafe(migration);
    }
    const rows = await sql<{ table_name: string; producers: number }[]>`
      SELECT c.relname AS table_name, count(*)::int AS producers FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared'
        AND c.relname IN ('work_item_deps', 'report_library', 'work_item_occurrences', 'pr_review_reports', 'plan_audits')
        AND p.proname IN ('emit_change_notify', 'emit_work_item_dep_change_notify')
        AND NOT t.tgisinternal AND t.tgenabled <> 'D'
      GROUP BY c.relname ORDER BY c.relname`;
    expect(rows).toEqual(['plan_audits', 'pr_review_reports', 'report_library', 'work_item_deps', 'work_item_occurrences']
      .map((table_name) => ({ table_name, producers: 1 })));
  });

  it('raw report and occurrence writes emit scoped INSERT, UPDATE and DELETE notifications', async () => {
    const received: Array<{ name: string; args: { op: string; workspace_id: string } }> = [];
    const listener = postgres(db.url, { max: 1, onnotice: () => {} });
    const marker = `cachetrg_barrier_${Date.now()}`;
    let flushed!: () => void;
    const delivered = new Promise<void>((resolve) => { flushed = resolve; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await listener.listen('sync_invalidate', (payload) => received.push(JSON.parse(payload)));
      await listener.listen(marker, () => flushed());
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', 'cachetrg-ws', true)`;
        await tx`INSERT INTO harness_shared.report_library (workspace_id, report_id, title, lineage_id)
          VALUES ('cachetrg-ws', 'notify-report', 'notification proof', 'notify-report')`;
        await tx`UPDATE harness_shared.report_library SET summary = 'updated'
          WHERE workspace_id = 'cachetrg-ws' AND report_id = 'notify-report'`;
        await tx`DELETE FROM harness_shared.report_library
          WHERE workspace_id = 'cachetrg-ws' AND report_id = 'notify-report'`;
        await tx`INSERT INTO harness_shared.work_item_occurrences
          (workspace_id, canonical_harness_slug, canonical_work_item_id, source_tool, report_kind, reported_title)
          VALUES ('cachetrg-ws', 'papercusp', 'WI-NOTIFY', 'test', 'canonical-created', 'notification proof')`;
        await tx`UPDATE harness_shared.work_item_occurrences SET evidence = '{"verified":true}'::jsonb
          WHERE workspace_id = 'cachetrg-ws' AND canonical_work_item_id = 'WI-NOTIFY'`;
        await tx`DELETE FROM harness_shared.work_item_occurrences
          WHERE workspace_id = 'cachetrg-ws' AND canonical_work_item_id = 'WI-NOTIFY'`;
        await tx`SELECT pg_notify(${marker}, 'complete')`;
      });
      await Promise.race([delivered, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('raw-write notification barrier was not delivered')), 5_000);
      })]);
      for (const table of ['report_library', 'work_item_occurrences']) {
        expect(received.filter((event) => event.name === `harness_shared.${table}.changed`)
          .map((event) => ({ op: event.args.op, workspace_id: event.args.workspace_id }))).toEqual(
          ['INSERT', 'UPDATE', 'DELETE'].map((op) => ({ op, workspace_id: 'cachetrg-ws' })),
        );
      }
    } finally {
      clearTimeout(timeout);
      await listener.end({ timeout: 5 });
    }
  });

  it('no COVERAGE_EXEMPT entry is stale (each is a real mapped table that still lacks the trigger)', async () => {
    const withTrigger = await notifyTriggerTables();
    const required = new Set(requiredTables);

    const stale: string[] = [];
    for (const t of Object.keys(COVERAGE_EXEMPT)) {
      // An exemption is stale if the table is no longer mapped, or has SINCE gained
      // the trigger (the coverage cutover landed).
      if (!required.has(t) || withTrigger.has(t)) stale.push(t);
    }
    expect(
      stale,
      `COVERAGE_EXEMPT has stale entr(ies) — the table now has the trigger (or is no ` +
        `longer mapped in TABLE_TO_QUERY_NAMES). Remove the dead exemption: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
