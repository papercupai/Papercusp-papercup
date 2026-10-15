/**
 * Production role bootstrap SQL (plan cloud-portal-public-release-2026-10-13, P-004 owners and
 * P-005 hosted roles, design D-010). Pure-string checks; role-sql.integration.test.ts runs the
 * same SQL as a non-superuser against real Postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATE_ONLY_ATTRIBUTES,
  HOSTED_DB_EXTENSIONS,
  hostedPasswordSecret,
  hostedUrlSecret,
  HOSTED_OPS_ROLE,
  HOSTED_OPS_URL_REF_ENV,
  productionOpsRoleSql,
  productionRoleSql,
  upsertRoleSql,
} from './role-sql';
import { scramSha256Verifier } from './scram';

/** Split one upsertRoleSql statement into its CREATE and ALTER branches. */
function branches(sql: string): { create: string; update: string } {
  const m = /THEN (CREATE ROLE [^;]*);\s*ELSE (ALTER ROLE [^;]*);/.exec(sql);
  if (!m) throw new Error(`not an upsert: ${sql}`);
  return { create: m[1]!, update: m[2]! };
}

describe('upsertRoleSql', () => {
  const v = scramSha256Verifier('pw-not-in-sql');

  // Measured on PG18 (2026-10-14): a non-superuser CREATEROLE role gets "Only roles with the
  // SUPERUSER attribute may change the SUPERUSER attribute" for ALTER ROLE … NOSUPERUSER, and
  // the same for REPLICATION and BYPASSRLS. A re-run `up` died there before this split.
  it('states the create-only attributes on CREATE and never on the update branch', () => {
    const { create, update } = branches(upsertRoleSql({ name: 'r', login: true, verifier: v }));
    for (const attr of CREATE_ONLY_ATTRIBUTES) {
      expect(create).toContain(attr);
      expect(update).not.toContain(attr);
    }
    expect(create).toMatch(/^CREATE ROLE r LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256\$/);
    expect(update).toMatch(/^ALTER ROLE r LOGIN NOCREATEDB NOCREATEROLE PASSWORD 'SCRAM-SHA-256\$/);
  });

  it('restates the password and connection limit on update, so a re-run converges', () => {
    const { update } = branches(upsertRoleSql({ name: 'r', login: true, connectionLimit: 100, verifier: v }));
    expect(update).toContain('CONNECTION LIMIT 100');
    expect(update).toContain(`PASSWORD '${v}'`);
  });

  it('refuses a plaintext password, an unsafe name, and a login/verifier mismatch', () => {
    expect(() => upsertRoleSql({ name: 'r', login: true, verifier: 'hunter2' })).toThrow(/not a SCRAM-SHA-256 verifier/);
    expect(() => upsertRoleSql({ name: 'r; DROP ROLE x', login: false })).toThrow(/unsafe role name/);
    expect(() => upsertRoleSql({ name: 'r', login: true })).toThrow(/LOGIN role needs a verifier/);
    expect(() => upsertRoleSql({ name: 'r', login: false, verifier: v })).toThrow(/NOLOGIN role must not have one/);
  });
});

describe('productionOpsRoleSql (P-013)', () => {
  const sql = productionOpsRoleSql(scramSha256Verifier('ops-pw-not-in-sql'));

  it('creates a bounded nonprivileged login with only CONNECT and read-only defaults', () => {
    expect(sql).toContain('CREATE ROLE harness_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2');
    expect(sql).toContain('REVOKE ALL ON DATABASE papercusp_hosted FROM harness_ops;');
    expect(sql).toContain('GRANT CONNECT ON DATABASE papercusp_hosted TO harness_ops;');
    expect(sql).toContain('SET default_transaction_read_only = on;');
    expect(sql).toContain("SET transaction_timeout = '15min';");
    expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|CREATE|TEMPORARY|USAGE|EXECUTE)/);
    expect(sql).not.toContain('ops-pw-not-in-sql');
  });

  it('refuses privileged or member-role drift before the password upsert', () => {
    expect(sql.split('\n')[0]).toContain('rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls');
    expect(sql.split('\n')[0]).toContain('pg_auth_members WHERE member = r.oid');
    expect(() => productionOpsRoleSql('plaintext')).toThrow(/not a SCRAM/);
    expect(() => productionOpsRoleSql(scramSha256Verifier('p'), 'x; DROP DATABASE y')).toThrow(/unsafe database/);
  });

  it('extends the existing hosted bootstrap and dedicated secret naming', () => {
    expect(productionRoleSql({ adminVerifier: scramSha256Verifier('a'), appVerifier: scramSha256Verifier('b'), opsVerifier: scramSha256Verifier('o') }).inPostgres).toContain('GRANT CONNECT ON DATABASE papercusp_hosted TO harness_ops;');
    expect(hostedPasswordSecret(HOSTED_OPS_ROLE)).toBe('cloudsql-harness-ops-password');
    expect(hostedUrlSecret(HOSTED_OPS_ROLE)).toBe('cloudsql-harness-ops-url');
    expect(HOSTED_OPS_URL_REF_ENV).toBe('PAPERCUSP_HOSTED_OPS_DATABASE_URL_REF');
  });
});

describe('productionRoleSql (D-010)', () => {
  const sql = productionRoleSql({
    adminVerifier: scramSha256Verifier('admin-pw-not-in-sql'),
    appVerifier: scramSha256Verifier('app-pw-not-in-sql'),
  });

  it('makes harness_admin a CREATEROLE non-superuser that keeps SET and INHERIT on roles it creates', () => {
    const { create } = branches(sql.inPostgres.split('\n')[0]!);
    expect(create).toMatch(/^CREATE ROLE harness_admin LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS /);
    expect(sql.inPostgres).toContain("ALTER ROLE harness_admin SET createrole_self_grant = 'set, inherit';");
  });

  it('makes harness_app a plain login role and harness_zero a NOLOGIN role', () => {
    expect(sql.inPostgres).toMatch(/CREATE ROLE harness_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD/);
    expect(sql.inPostgres).toMatch(/CREATE ROLE harness_zero NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;/);
    expect(sql.inPostgres).not.toMatch(/harness_zero[^;]*PASSWORD/);
  });

  it('closes the database to PUBLIC and grants each role only what it uses', () => {
    expect(sql.inPostgres).toContain('REVOKE ALL ON DATABASE papercusp_hosted FROM PUBLIC;');
    expect(sql.inPostgres).toContain('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE papercusp_hosted TO harness_admin;');
    // TEMPORARY: the scheduler creates temp tables at runtime (scheduler/get-next.ts).
    expect(sql.inPostgres).toContain('GRANT CONNECT, TEMPORARY ON DATABASE papercusp_hosted TO harness_app;');
    expect(sql.inDatabase).toBe('GRANT USAGE, CREATE ON SCHEMA public TO harness_admin;');
  });

  it('never grants cloudsqlsuperuser, which owns every database on the instance', () => {
    expect(`${sql.inPostgres}\n${sql.inDatabase}\n${sql.extensions}`).not.toMatch(/cloudsqlsuperuser/);
  });

  it('pre-creates every extension, quoted, and leaves pg_textsearch to migration 1447', () => {
    for (const ext of HOSTED_DB_EXTENSIONS) expect(sql.extensions).toContain(`CREATE EXTENSION IF NOT EXISTS "${ext}";`);
    expect(sql.extensions).not.toContain('pg_textsearch');
  });

  it('carries verifiers, never the passwords', () => {
    const all = `${sql.inPostgres}\n${sql.inDatabase}`;
    expect(all).not.toContain('admin-pw-not-in-sql');
    expect(all).not.toContain('app-pw-not-in-sql');
  });

  it('refuses an unsafe database or role name', () => {
    const v = scramSha256Verifier('p');
    expect(() => productionRoleSql({ adminVerifier: v, appVerifier: v, database: 'x; DROP DATABASE y' })).toThrow(/unsafe database name/);
    expect(() =>
      productionRoleSql({ adminVerifier: v, appVerifier: v, roles: { admin: 'a', app: 'b"c', zero: 'z' } }),
    ).toThrow(/unsafe role name/);
  });

  it('names the Secret Manager secrets after the role', () => {
    expect(hostedPasswordSecret('harness_admin')).toBe('cloudsql-harness-admin-password');
    expect(hostedUrlSecret('harness_app')).toBe('cloudsql-harness-app-url');
  });
});
