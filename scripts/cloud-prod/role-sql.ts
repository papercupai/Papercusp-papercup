/**
 * Bootstrap SQL for the production Cloud SQL roles (plan cloud-portal-public-release-2026-10-13:
 * per-database owners = P-004, hosted control plane roles = P-005 / D-010).
 *
 * Everything here runs as Cloud SQL's built-in `postgres`, which is NOT a superuser: it has
 * CREATEROLE and CREATEDB, is a member of cloudsqlsuperuser, and has no BYPASSRLS or REPLICATION
 * (live catalog probe of pc-cloud-prod-pg, 2026-10-14). Two consequences shape this module:
 *
 * - Every role is upserted with `upsertRoleSql`. CREATE may state every attribute. The update
 *   branch may not: PG16+ refuses NOSUPERUSER / NOREPLICATION / NOBYPASSRLS from a role that
 *   lacks those attributes ("Only roles with the SUPERUSER attribute may change the SUPERUSER
 *   attribute", measured on PG18 2026-10-14). A role `postgres` created can only have gained them
 *   from a superuser, so the update branch restates only what `postgres` may change and `verify`
 *   checks the rest.
 * - SQL text carries a SCRAM-SHA-256 verifier (scram.ts), never a password: the plaintext lives
 *   only in Secret Manager.
 */

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const SCRAM_VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

export function assertIdent(kind: string, name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe ${kind} name: ${name}`);
  return name;
}

export function assertScramVerifier(caller: string, verifier: string): string {
  if (!SCRAM_VERIFIER.test(verifier)) throw new Error(`${caller}: refusing a value that is not a SCRAM-SHA-256 verifier`);
  return verifier;
}

/** Attributes `postgres` cannot change on an existing role, so only CREATE states them. */
export const CREATE_ONLY_ATTRIBUTES = ['NOSUPERUSER', 'NOREPLICATION', 'NOBYPASSRLS'] as const;

export interface RoleSpec {
  name: string;
  login: boolean;
  createRole?: boolean;
  connectionLimit?: number;
  /** SCRAM-SHA-256 verifier; omitted for a NOLOGIN role. */
  verifier?: string;
}

/** Create the role, or bring an existing one back to `spec` as far as a non-superuser may. */
export function upsertRoleSql(spec: RoleSpec): string {
  const role = assertIdent('role', spec.name);
  if (spec.login !== (spec.verifier !== undefined)) {
    throw new Error(`upsertRoleSql(${role}): a LOGIN role needs a verifier and a NOLOGIN role must not have one`);
  }
  const login = spec.login ? 'LOGIN' : 'NOLOGIN';
  const createRole = spec.createRole ? 'CREATEROLE' : 'NOCREATEROLE';
  const tail = [
    ...(spec.connectionLimit !== undefined ? [`CONNECTION LIMIT ${Math.trunc(spec.connectionLimit)}`] : []),
    ...(spec.verifier !== undefined ? [`PASSWORD '${assertScramVerifier('upsertRoleSql', spec.verifier)}'`] : []),
  ];
  const [noSuper, noReplication, noBypassRls] = CREATE_ONLY_ATTRIBUTES;
  const create = [login, noSuper, 'NOCREATEDB', createRole, noReplication, noBypassRls, ...tail].join(' ');
  const update = [login, 'NOCREATEDB', createRole, ...tail].join(' ');
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} ${create}; ELSE ALTER ROLE ${role} ${update}; END IF; END $$;`;
}

// ── hosted control plane roles (P-005, D-010) ────────────────────────────────

export const HOSTED_DATABASE = 'papercusp_hosted';
/** P-013: login only for the audited, consent-bound customer reader. */
export const HOSTED_OPS_ROLE = 'harness_ops';
export const HOSTED_OPS_URL_REF_ENV = 'PAPERCUSP_HOSTED_OPS_DATABASE_URL_REF';

export interface HostedRoleNames {
  /** Migration user and the D-009 admin URL (HARNESS_ADMIN_DATABASE_URL). */
  admin: string;
  /** Runtime user and the D-009 app URL (HARNESS_DATABASE_URL). */
  app: string;
  /** NOLOGIN; exists only because migrations name it in REVOKE statements. */
  zero: string;
}

/** The names the migration set hard-codes (e.g. 733, 756, 997). */
export const HOSTED_ROLES: HostedRoleNames = { admin: 'harness_admin', app: 'harness_app', zero: 'harness_zero' };

/** D-009: the env var each hosted URL secret is delivered as. */
export const HOSTED_URL_ENV = { admin: 'HARNESS_ADMIN_DATABASE_URL', app: 'HARNESS_DATABASE_URL' } as const;

export const hostedPasswordSecret = (role: string) => `cloudsql-${assertIdent('role', role).replace(/_/g, '-')}-password`;
export const hostedUrlSecret = (role: string) => `cloudsql-${assertIdent('role', role).replace(/_/g, '-')}-url`;

/**
 * Extensions `postgres` creates before the first migration. Cloud SQL lets cloudsqlsuperuser
 * members create allowlisted extensions; harness_admin is deliberately not one. This is the set
 * the Cloud-SQL-shaped rehearsal measured at 1283/1284 (D-010). pg_textsearch stays absent:
 * migration 1447 gates on its availability.
 */
export const HOSTED_DB_EXTENSIONS = [
  'vector',
  'pg_trgm',
  'pg_stat_statements',
  'pgcrypto',
  'citext',
  'btree_gist',
  'uuid-ossp',
] as const;

export interface HostedRoleSql {
  /** Run in the `postgres` database: roles, the self-grant setting, database privileges. */
  inPostgres: string;
  /** Run in the hosted database: schema privileges. */
  inDatabase: string;
  /** Run in the hosted database: extensions (needs cloudsqlsuperuser on Cloud SQL). */
  extensions: string;
}

/** No ambient table privileges or memberships: migration 1511 owns the reader grant. */
export function productionOpsRoleSql(verifier: string, database = HOSTED_DATABASE): string {
  const db = assertIdent('database', database);
  const role = HOSTED_OPS_ROLE;
  return [
    // A non-superuser cannot remove privileged attributes. Refuse drift before
    // changing a password or making an existing role usable.
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles r WHERE rolname = '${role}' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid))) THEN RAISE EXCEPTION 'harness_ops must be unprivileged and hold no role memberships'; END IF; END $$;`,
    upsertRoleSql({ name: role, login: true, connectionLimit: 2, verifier }),
    `REVOKE ALL ON DATABASE ${db} FROM ${role};`,
    `GRANT CONNECT ON DATABASE ${db} TO ${role};`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${role} SET transaction_timeout = '15min';`,
    `ALTER ROLE ${role} SET statement_timeout = '15min';`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15min';`,
  ].join('\n');
}

/**
 * D-010 bootstrap, run once as `postgres` before the first migration and safe to re-run.
 *
 * harness_admin is created by SQL, not `gcloud sql users create`: an Admin-API user joins
 * cloudsqlsuperuser, which owns every database on the instance (portal and dbos_system too), so
 * it would void P-004's one-owner-per-database isolation. `createrole_self_grant = 'set,
 * inherit'` gives it SET and INHERIT on the hosted_* roles it creates in migration 978, which
 * PG16+ otherwise withholds from a non-superuser creator. harness_app gets TEMPORARY as well as
 * CONNECT because the scheduler creates temp tables at runtime (scheduler/get-next.ts), and
 * P-004 revoked PUBLIC's default TEMPORARY on every database.
 */
export function productionRoleSql(opts: {
  adminVerifier: string;
  appVerifier: string;
  /** Omit only for the existing D-010 bootstrap; production provisioning supplies it. */
  opsVerifier?: string;
  database?: string;
  roles?: HostedRoleNames;
}): HostedRoleSql {
  const db = assertIdent('database', opts.database ?? HOSTED_DATABASE);
  const r = opts.roles ?? HOSTED_ROLES;
  const [admin, app, zero] = [r.admin, r.app, r.zero].map((n) => assertIdent('role', n)) as [string, string, string];
  const inPostgres = [
    upsertRoleSql({ name: admin, login: true, createRole: true, verifier: opts.adminVerifier }),
    `ALTER ROLE ${admin} SET createrole_self_grant = 'set, inherit';`,
    upsertRoleSql({ name: app, login: true, verifier: opts.appVerifier }),
    upsertRoleSql({ name: zero, login: false }),
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${admin};`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${app};`,
    ...(opts.opsVerifier === undefined ? [] : [productionOpsRoleSql(opts.opsVerifier, db)]),
  ].join('\n');
  const inDatabase = `GRANT USAGE, CREATE ON SCHEMA public TO ${admin};`;
  const extensions = HOSTED_DB_EXTENSIONS.map((e) => `CREATE EXTENSION IF NOT EXISTS "${e}";`).join('\n');
  return { inPostgres, inDatabase, extensions };
}
