import { getOrgPg } from '@papercusp/db-org';

/**
 * Backend census for the staging-first HTTP fixture's teardown
 * (staging-first-http-fixture.ts records it beside the libuv socket report so a
 * leaked socket can be matched to the Postgres backend it still holds).
 *
 * It lives in its own module on purpose. pg_stat_activity must be read through
 * the admin client: harness_admin holds pg_read_all_stats (migration 733), while
 * harness_app does not, so Postgres masks other roles' rows instead of erroring
 * and the census silently comes back short. The fixture itself ALSO opens the
 * app-role pool, to exercise pool cleanup, and
 * pg-stat-activity-role-visibility-guard.test.ts judges each file that reads the
 * view by whether that file calls the app-role client at all. Keeping the read
 * here keeps the reading module admin-only, which is what the guard checks.
 */
export interface PgBackendRow {
  client_port: number | null;
  application_name: string | null;
  state: string | null;
}

export async function readPgBackendCensus(): Promise<PgBackendRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<PgBackendRow[]>`SELECT client_port, application_name, state
    FROM pg_stat_activity WHERE datname = current_database() AND client_port IS NOT NULL`;
  return [...rows];
}
