/**
 * Pins the hosted customer-data map (customer-data-map.ts) to the real migrated schema
 * and to what the hosted signup journey actually writes.
 *
 * Plan cloud-portal-public-release-2026-10-13, P-001 / SPEC-P-001: "The customer data map
 * names every table that a signup journey writes on the hosted control plane." Falsifier:
 * a write delta captured across one signup journey shows a written table the map does not
 * name. Each journey transaction runs the production admission adapter on `harness_app`
 * switched into `hosted_service` (the `withHostedServiceContext` privilege path) and, just
 * before commit, reads `pg_stat_xact_user_tables` — the per-transaction twin of
 * `pg_stat_user_tables` — so the write set is exact and immune to other suites' traffic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';
import {
  HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
  HOSTED_SELF_SIGNUP_TERMS_VERSION,
  PostgresHostedSelfSignupAdmission,
} from './self-signup';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';
import {
  CUSTOMER_DATA_CLASSES,
  HOSTED_CUSTOMER_DATA_TABLES,
  HOSTED_CUSTOMER_SCHEMAS,
  HOSTED_PATH_DEPENDENCY_TABLES,
  dataMapNamesTable,
  qualifiedName,
} from './customer-data-map';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

let db: OrgTestDb;
const journeyWrites = new Set<string>();

/** Production's hosted-service transaction shape, plus a pre-commit write-set capture. */
const runServiceCapturingWrites: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    const result = await fn(tx as unknown as Sql);
    await tx.unsafe('RESET ROLE');
    const written = await tx<Array<{ qualified: string }>>`
      SELECT schemaname || '.' || relname AS qualified
        FROM pg_stat_xact_user_tables
       WHERE n_tup_ins + n_tup_upd + n_tup_del > 0
    `;
    for (const row of written) journeyWrites.add(row.qualified);
    return result;
  }) as Promise<T>;

function unique(label: string): string {
  return `${label}-${randomBytes(5).toString('hex')}`;
}

describe('hosted customer-data map (real migrated schema)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('names every base table in the customer schemas', async () => {
    const rows = await db.adminSql<Array<{ qualified: string }>>`
      SELECT table_schema || '.' || table_name AS qualified
        FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema = ANY(${HOSTED_CUSTOMER_SCHEMAS as string[]})
    `;
    const actual = rows.map((r) => r.qualified).sort();
    const mapped = HOSTED_CUSTOMER_DATA_TABLES
      .filter((t) => HOSTED_CUSTOMER_SCHEMAS.includes(t.schema))
      .map(qualifiedName)
      .sort();
    expect(actual.length).toBeGreaterThan(0);
    expect(mapped).toEqual(actual);
  });

  it('classifies every column of every mapped table exactly once', async () => {
    const problems: string[] = [];
    for (const t of HOSTED_CUSTOMER_DATA_TABLES) {
      const rows = await db.adminSql<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = ${t.schema} AND table_name = ${t.table}
      `;
      const actual = new Set(rows.map((r) => r.column_name));
      if (actual.size === 0) problems.push(`${qualifiedName(t)}: table missing from the migrated schema`);
      const seen = new Map<string, string>();
      for (const cls of CUSTOMER_DATA_CLASSES) {
        for (const column of t.columns[cls]) {
          const prior = seen.get(column);
          if (prior) problems.push(`${qualifiedName(t)}.${column}: classified as both ${prior} and ${cls}`);
          seen.set(column, cls);
          if (!actual.has(column)) problems.push(`${qualifiedName(t)}.${column}: mapped but not in the schema`);
        }
      }
      for (const column of actual) {
        if (!seen.has(column)) problems.push(`${qualifiedName(t)}.${column}: in the schema but unclassified`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names only hosted-path dependency relations that exist', async () => {
    // to_regclass, not pg_stat_user_tables: a dependency may be a view
    // (harness_features_consolidated), which has no table statistics row.
    const names = HOSTED_PATH_DEPENDENCY_TABLES.map((d) => d.qualified);
    const rows = await db.adminSql<Array<{ qualified: string }>>`
      SELECT q AS qualified FROM unnest(${names}::text[]) AS q WHERE to_regclass(q) IS NULL
    `;
    expect(rows.map((r) => r.qualified)).toEqual([]);
  });

  it('SPEC-P-001: every table the signup journey writes is named by the data map', async () => {
    journeyWrites.clear();
    const result = await new PostgresHostedSelfSignupAdmission(runServiceCapturingWrites).complete({
      attemptId: unique('state'),
      providerId: 'workos',
      identity: {
        externalUserId: unique('user_'),
        primaryEmail: `${unique('datamap')}@example.test`,
        emailVerified: true,
        displayName: 'Data Map Member',
      },
      upstreamSessionId: unique('session_'),
      sessionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      termsVersion: HOSTED_SELF_SIGNUP_TERMS_VERSION,
      privacyVersion: HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
      acceptedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    // Positive control: the capture saw the admission's known writes.
    for (const known of ['papercusp_auth.hosted_users', 'papercusp_auth.organizations', 'papercusp_auth.hosted_sessions']) {
      expect(journeyWrites).toContain(known);
    }
    const unnamed = [...journeyWrites].filter((q) => !dataMapNamesTable(q)).sort();
    expect(unnamed).toEqual([]);
  });
});
