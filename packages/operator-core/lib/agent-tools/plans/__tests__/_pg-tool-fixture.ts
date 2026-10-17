/**
 * _pg-tool-fixture.ts — shared wiring for the plans *.integration.test.ts files.
 *
 * NOT a test file (no `.integration.test.ts` suffix → the glob never collects
 * it). It points the plan tools' OWN connection (`getOrgPgApp()` /
 * `getOrgPg()`, resolved from env) at the integration-tier baseline schema DB
 * that `test/setup/baseline-schema.globalSetup.ts` stood up — the same DB the
 * other tool-suite integration tests `inject('baselineSchemaDsn')` against, but
 * here we drive it THROUGH the tools rather than with a raw client.
 *
 * The injected DSN connects as the container superuser (`it_admin`). The
 * globalSetup also created the `harness_app` (RLS-subject) + `harness_admin`
 * (superuser) roles with the fixed convention passwords, so we re-point:
 *   - HARNESS_DATABASE_URL        → harness_app:harness_app_pwd     (withWorkspace path)
 *   - HARNESS_ADMIN_DATABASE_URL  → harness_admin:harness_admin_pwd (admin path)
 * exactly as embedded-pg + the dev box wire them. `_resetForTests()` drops any
 * pool the tools cached from a prior URL so the next getOrgPg*() rebuilds.
 *
 * Plans live in `harness_shared.harness_plans` keyed by (workspace_id,
 * harness_slug, plan_slug); RLS isolates by `app.workspace_id`, which
 * `withWorkspace()` sets inside its transaction.
 */
import { inject } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { _resetForTests } from '@papercusp/db-org';
import { createOrgTestDb } from '../../../../test/_org-test-db';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
// eslint-disable-next-line import/no-relative-packages -- mirror the canonical client's jsonb serializer (see restoreRawJsonbSerializer's doc)
import { restoreRawJsonbSerializer } from '../../../../../../libs/papercusp/libs/db/src/raw-serializers';

export interface PlanPgFixture {
  /** Admin (superuser, RLS-bypassing) client for seed/cleanup of the test DB. */
  admin: postgres.Sql;
  /** The workspace the tools read/write under (matches DEFAULT_WORKSPACE_ID). */
  workspaceId: string;
  /** Tear down: close the admin client + reset the tools' cached pools/env. */
  dispose: () => Promise<void>;
}

function withUser(dsn: string, user: string, password: string): string {
  const u = new URL(dsn);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Wire the plan tools at the injected baseline DB and hand back an admin client
 * for direct seed/cleanup. Writable composition suites can request a private,
 * migrated database; the reusable baseline is not a disposable data fixture.
 * Call once in `beforeAll` and dispose before opening another fixture.
 */
export async function setupPlanPgFixture(options: { isolated?: boolean } = {}): Promise<PlanPgFixture> {
  const privateDb = options.isolated ? await createOrgTestDb() : undefined;
  const dsn = privateDb?.adminDsn ?? inject('baselineSchemaDsn');

  // EI-2627: globalSetup's own health check (EI-2433) ran once, potentially
  // minutes before this beforeAll — long enough on a heavily-loaded fleet box
  // for a transient startup blip, or (rarer) real reaping/recycling of the
  // shared baseline container. Confirm reachability with a bounded retry
  // before repointing env vars, so a genuine failure surfaces as an actionable
  // "this is known local-environment churn" error instead of a cryptic raw
  // "no such database: papercusp_it" deep inside a later query.
  try {
    await assertPgReachable(dsn, 'setupPlanPgFixture');
  } catch (error) {
    await privateDb?.cleanup();
    throw error;
  }

  // Re-point the tools' app + admin connections (resolved from env) at the
  // baseline DB, then drop any cached pool + memoized URL so the next
  // getOrgPg*() call rebuilds against these URLs.
  //
  // The DSN points at a throwaway testcontainer with NO PgBouncer. On a SERVER-class host
  // (the dev box / a dedicated CI server) pgbouncerEnabled() derives ON from hostClass, so
  // getOrgPg()'s maybePgbouncer() would reroute these reads to 127.0.0.1:6432 — the WRONG
  // Postgres — tripping a FATAL 08P01 under transaction pooling. Force the kill-switch OFF +
  // skip PG discovery so getOrgPg honours the env DSN verbatim (mirrors _baseline-coord-fixture).
  const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  const prevAppUrl = process.env.HARNESS_DATABASE_URL;
  const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.HARNESS_DATABASE_URL = withUser(dsn, 'harness_app', 'harness_app_pwd');
  process.env.HARNESS_ADMIN_DATABASE_URL = withUser(dsn, 'harness_admin', 'harness_admin_pwd');
  _resetUrlCacheForTests();
  await _resetForTests();

  const admin = postgres(withUser(dsn, 'harness_admin', 'harness_admin_pwd'), {
    max: 2,
    onnotice: () => {},
    connection: { search_path: 'harness_shared, papercusp_shared, public' },
  });
  // Production clients (buildClient) pass a pre-stringified `${JSON.stringify(v)}::jsonb`
  // value through unchanged; a raw postgres() client JSON-encodes it AGAIN and stores a
  // jsonb STRING, so a test here would see a different shape than the live code path.
  restoreRawJsonbSerializer(admin);

  const dispose = async () => {
    await admin.end({ timeout: 5 }).catch(() => {});
    if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
    else process.env.HARNESS_DATABASE_URL = prevAppUrl;
    if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await _resetForTests();
    await privateDb?.cleanup();
  };

  return { admin, workspaceId: 'default', dispose };
}

/**
 * Delete every test plan row (+ its revisions) for a harness so a run leaves no
 * trace. Scoped to the throwaway harness slug the test owns — never touches the
 * real papercup plan rows (different harness_slug / their own DB anyway).
 */
export async function cleanupPlans(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  await admin`
    DELETE FROM harness_shared.plan_revisions
     WHERE harness_slug = ${harnessSlug}
       AND plan_slug IN (
         SELECT plan_slug FROM harness_shared.harness_plans
          WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       )
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
  `;
  // Drop the synthetic Hive-home identity registerHarnessProject seeded, so a
  // run leaves no trace in harness_shared.hives either.
  await admin`
    DELETE FROM harness_shared.pots
     WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${harnessSlug}
  `.catch(() => {});
}

/**
 * Register a throwaway harness in `harness_shared.projects` so the plan tools'
 * `resolvePlanScope` can resolve its workspace. Post-WI-148, a concrete (non-
 * papercup) slug that is NOT registered THROWS instead of silently defaulting to
 * 'default' (source.ts) — so a test that drives a plan tool against a `zzz-…`
 * harness must first register it, exactly as production does before any plan is
 * written for a harness. Idempotent; uses the slug as the id (unique per test).
 *
 * ALSO registers the harness as its OWN Hive home (an identity row in
 * `harness_shared.hives`): `resolvePlanScope` is Hive-scoped (WI-1992 — plans are
 * keyed at Hive-home grain), so a concrete slug must resolve through
 * `potHomeSlugForHarness()` or the tool THROWS. The registry read answers
 * nothing for a throwaway slug, so the resolver falls to its `getHiveBySlug`
 * fallback — this row — exactly the shape `pot:create` writes in production.
 * Synthetic identity: a random 32-byte pubkey (UNIQUE constraint; pgcrypto is a
 * baseline prereq) + a test keychain id nothing dereferences.
 */
export async function registerHarnessProject(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.projects
      (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES
      (${harnessSlug}, ${harnessSlug}, 'active', ${harnessSlug}, ${workspaceId}, 0, 0)
    ON CONFLICT DO NOTHING
  `;
  await admin`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at, updated_at)
    VALUES
      (${workspaceId}, ${harnessSlug}, gen_random_bytes(32), ${'zzz-test-hive-' + harnessSlug}, 0, 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
}

/** Seed a plan row directly (admin/bypass) so a read/lock test has content. */
export async function seedPlan(
  admin: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  slug: string,
  content: string,
): Promise<void> {
  // A plan for a concrete harness is only resolvable if the harness is registered
  // in projects (WI-148 fail-loud) — seed that precondition alongside the row.
  await registerHarnessProject(admin, workspaceId, harnessSlug);
  await admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, origin)
    VALUES
      (${workspaceId}, ${harnessSlug}, ${slug}, ${content},
       md5(${content}), 1, 'local')
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE
      SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash
  `;
}
