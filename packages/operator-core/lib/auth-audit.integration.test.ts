/**
 * auth-audit.integration.test.ts — the auth audit log (auth_audit_log), against a
 * real Postgres. recordAuthEvent is fire-and-forget-by-convention but awaitable.
 *
 * The SECURITY invariant a fake-sql unit test can't prove: a session token is NEVER
 * persisted — only its truncated HMAC-SHA256 (16 hex) lands in session_hmac (enough
 * for cross-row correlation in a review, not enough to hijack). Plus the
 * `${metadata}::text::jsonb` double-encode-avoidance and the nullable mapping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { recordAuthEvent, hmacSessionToken } = await import('./auth-audit');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `aa_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`); // gen_random_uuid()
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: uuid/ts defaults, kind/ok NOT NULL, session_hmac text, metadata jsonb.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.auth_audit_log (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      ts timestamptz DEFAULT now() NOT NULL,
      kind text NOT NULL, username text, ip text, user_agent text,
      ok boolean NOT NULL, error_code text, session_hmac text, metadata jsonb
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.auth_audit_log`;
});

describe('hmacSessionToken (pure)', () => {
  it('is a 16-hex digest, deterministic per token, and never contains the raw token', () => {
    const tok = 'super-secret-session-token-abcdef';
    const a = hmacSessionToken(tok);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hmacSessionToken(tok)).toBe(a); // deterministic (cross-row correlation)
    expect(hmacSessionToken('different-token')).not.toBe(a);
    expect(a).not.toContain(tok); // no token material leaks
  });
});

describe('recordAuthEvent (PG)', () => {
  it('SECURITY: stores only the session-token HMAC, never the raw token', async () => {
    const tok = 'super-secret-session-token-abcdef';
    await recordAuthEvent({ kind: 'login_ok', username: 'alice', ip: '1.2.3.4', userAgent: 'curl', ok: true, sessionToken: tok });
    const row = (await rootSql<{ kind: string; username: string; ok: boolean; session_hmac: string }[]>`
      SELECT kind, username, ok, session_hmac FROM harness_shared.auth_audit_log`)[0]!;
    expect(row).toMatchObject({ kind: 'login_ok', username: 'alice', ok: true });
    expect(row.session_hmac).toBe(hmacSessionToken(tok)); // the HMAC, not the token
    expect(row.session_hmac).not.toBe(tok); // raw token NOT persisted
    expect(row.session_hmac).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores metadata as a proper jsonb OBJECT (::text::jsonb), queryable by key', async () => {
    await recordAuthEvent({ kind: 'login_failed', ok: false, errorCode: 'BAD_PW', metadata: { attempts: 3, locked: false } });
    const row = (await rootSql<{ typ: string; attempts: string; error_code: string }[]>`
      SELECT jsonb_typeof(metadata) AS typ, metadata->>'attempts' AS attempts, error_code
        FROM harness_shared.auth_audit_log`)[0]!;
    expect(row.typ).toBe('object'); // not a double-encoded string scalar
    expect(row.attempts).toBe('3');
    expect(row.error_code).toBe('BAD_PW');
  });

  it('maps absent optionals (and no sessionToken → null hmac) to NULL columns', async () => {
    await recordAuthEvent({ kind: 'logout', ok: true });
    const row = (await rootSql<Record<string, unknown>[]>`
      SELECT username, ip, user_agent, error_code, session_hmac, metadata FROM harness_shared.auth_audit_log`)[0]!;
    expect(Object.values(row).every((v) => v === null)).toBe(true);
  });

  // Ported from the retired lib/auth-audit.test.ts (EI-16087) so deleting that
  // redundant unit file loses no coverage. Strengthened while porting: the unit
  // version admitted it could not actually provoke a failure ("PG will accept it
  // actually — so we just verify the function never throws"), so it only ever
  // exercised the SUCCESS path. Here the backend is made to genuinely fail.
  it('is fail-soft: a backend error is swallowed, never propagated to the auth path', async () => {
    const good = h.sql;
    // recordAuthEvent warns on failure; fail-on-console would red the suite.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.sql = (() => {
      throw new Error('simulated backend failure');
    }) as unknown as postgres.Sql;
    try {
      await expect(recordAuthEvent({ kind: 'login_ok', ok: true })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled(); // it reports via console.warn rather than throwing
    } finally {
      h.sql = good;
      warn.mockRestore();
    }
  });
});
