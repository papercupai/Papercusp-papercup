/**
 * Unit-tier tests for the local-account auth lib. Exercises the full bcrypt
 * round-trip + session lookup + change-password contract against a REAL but
 * ISOLATED Postgres — a throwaway, fully-migrated database cloned per run
 * from a cached testcontainers template (see `createOrgTestDb`,
 * `../test/_org-test-db.ts`), dropped in `afterAll`.
 *
 * Why integration vs pure-unit: lib/auth.ts is end-to-end SQL — there
 * are no separable pure paths to unit-test. The bugs that actually
 * happen here (pg client field shape, bcrypt verify wiring, session
 * TTL stored as Date vs ISO) only surface against real PG.
 *
 * EI-19318128948371877 (decision B): this file used to run its queries
 * directly against the shared LIVE dev embedded-pg (a raw `pg.Client` probe +
 * `delete process.env.PAPERCUSP_FORBID_REAL_PG` opt-out) — every `signup()`
 * call leaked a permanent row into the box every concurrent fleet agent
 * shares (~29k rows self-healed per EI-12970). It now stands up its OWN
 * throwaway database per run and drops it afterward, so nothing outlives this
 * file's own process — the leak class is gone by construction, not by a
 * cleanup sweep.
 *
 * @papercusp/db-org is mocked wholesale (mirrors
 * `user-preferences.integration.test.ts`), so `lib/auth.ts`'s `getOrgPg()`
 * never reaches the real `buildClient()` — the PAPERCUSP_FORBID_REAL_PG unit
 * rail (EI-19311807188719573) never engages here; there is nothing to opt out
 * of, unlike the old per-file escape hatch.
 *
 * Why this file stays `*.test.ts` (unit tier) rather than
 * `*.integration.test.ts`: the green-checkpoint gate runs `test:affected` —
 * the UNIT layer only, no `--integration` — so renaming this file would
 * silently DELETE it from every gate run (see EI-19318128948371877's
 * analysis). Keeping it here, DB-backed but isolated, is the deliberate fix.
 *
 * See PLAN-operator-arc-2026-05-12.md and migration 058.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as any }));

// Mirrors user-preferences.integration.test.ts's mock shape exactly — auth.ts
// only ever destructures `{ sql }` from getOrgPg() (grep confirms 9/9 call
// sites), so this is a faithful stand-in, not a partial mock.
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

let db: OrgTestDb | null = null;
let dbReady = false;
let authMod: typeof import('./auth') | null = null;

beforeAll(async () => {
  const { createOrgTestDb } = await import('../test/_org-test-db');
  try {
    db = await createOrgTestDb();
  } catch {
    // Keep the DB-backed cases optional on machines without Docker or an
    // explicit test PG. itPg marks each case skipped, so none reports a pass
    // without having executed its assertions.
    dbReady = false;
    return;
  }
  h.sql = db.adminSql;
  dbReady = true;
  authMod = await import('./auth');
  // Drizzle schema-import path errors on first call when called mid-test
  // under vitest's worker. Warm-up via a known-no-op so the first real
  // signup doesn't race the init.
  try { await authMod.getSessionUserOrDefault(); } catch { /* ok */ }
  // 180s: a cold template build (first run on this box/container, ~500
  // migrations replayed once) comfortably exceeds the unit layer's default
  // 60s hookTimeout — override it explicitly rather than touch the shared
  // config. Every LATER file/run clones the cached template (near-instant),
  // so this budget is a one-time cost, not a per-file tax.
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

const PG_SETUP_SKIP_REASON = 'isolated Postgres test database is unavailable';

const runPgTest = (
  ready: boolean,
  skip: (reason: string) => void,
  fn: () => Promise<void> | void,
) => {
  if (!ready) {
    skip(PG_SETUP_SKIP_REASON);
    return;
  }
  return fn();
};

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, (context) => runPgTest(dbReady && authMod !== null, context.skip.bind(context), fn));
};

describe('auth PostgreSQL test gate', () => {
  it('reports unavailable database setup as skipped without invoking assertions', () => {
    const skip = vi.fn((reason: string) => {
      throw new Error(reason);
    });
    const testBody = vi.fn();

    expect(() => runPgTest(false, skip, testBody)).toThrow(PG_SETUP_SKIP_REASON);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(skip).toHaveBeenCalledWith(PG_SETUP_SKIP_REASON);
    expect(testBody).not.toHaveBeenCalled();
  });
});

describe('auth.ts integration', () => {
  const uname = () => `vitest_${randomBytes(4).toString('hex')}`;

  itPg('signup creates user and login returns a session token', async () => {
    const name = uname();
    const user = await authMod!.signup(name, 'Test User', 'sup3rsecret');
    expect(user.username).toBe(name);
    expect(user.has_password).toBe(true);
    const session = await authMod!.login(name, 'sup3rsecret');
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.user.id).toBe(user.id);
    expect(session.expires_at).toBeInstanceOf(Date);
    await authMod!.logout(session.token);
  });

  itPg('persists and resolves workspace-bound capability claims', async () => {
    const name = uname();
    await authMod!.signup(name, 'Remote User', 'sup3rsecret');
    const session = await authMod!.login(name, 'sup3rsecret', {
      workspace_id: 'ws-remote',
      capabilities: ['*', 'operator:remote', 'operator:remote'],
      remote: true,
    });
    expect(session.user.workspace_id).toBe('ws-remote');
    expect(session.user.capabilities).toEqual(['*', 'operator:remote']);

    const rows = await db!.adminSql<{ workspace_id: string; capabilities: string[] }[]>`
      SELECT workspace_id, capabilities
        FROM harness_shared.user_sessions
       WHERE token = ${session.token}`;
    expect(rows).toEqual([{
      workspace_id: 'ws-remote',
      capabilities: ['*', 'operator:remote'],
    }]);

    const resolved = await authMod!.getSessionUser(new Headers({
      cookie: `${authMod!.SESSION_COOKIE}=${session.token}`,
    }));
    expect(resolved).toMatchObject({
      id: session.user.id,
      workspace_id: 'ws-remote',
      capabilities: ['*', 'operator:remote'],
    });
    await authMod!.logout(session.token);
  });

  itPg('rejects legacy sessions with no workspace claim', async () => {
    const name = uname();
    const user = await authMod!.signup(name, 'Legacy User', 'sup3rsecret');
    const token = randomBytes(32).toString('hex');
    await db!.adminSql`
      INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, workspace_id)
      VALUES (${token}, ${user.id}, now() + interval '1 day', NULL)`;
    expect(await authMod!.getSessionUser(new Headers({
      cookie: `${authMod!.SESSION_COOKIE}=${token}`,
    }))).toBeNull();
  });

  itPg('login rejects wrong password with code bad_password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'right');
    try {
      await authMod!.login(name, 'wrong');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
  });

  itPg('login rejects unknown user with code unknown_user', async () => {
    try {
      await authMod!.login('does_not_exist_' + randomBytes(4).toString('hex'), 'x');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('unknown_user');
    }
  });

  itPg('passwordless user logs in with null password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', null);
    const session = await authMod!.login(name, null);
    expect(session.user.has_password).toBe(false);
    await authMod!.logout(session.token);
  });

  itPg('remote login rejects a nonempty password for a passwordless user', async () => {
    const name = uname();
    const user = await authMod!.signup(name, 'T', null);

    await expect(authMod!.login(name, 'attacker-password', {
      workspace_id: 'ws-remote',
      capabilities: ['*', 'operator:remote'],
    })).rejects.toMatchObject({ code: 'bad_password' });

    const sessions = await db!.adminSql<{ token: string }[]>`
      SELECT token
        FROM harness_shared.user_sessions
       WHERE user_id = ${user.id}
    `;
    expect(sessions).toEqual([]);

    const localSession = await authMod!.login(name, null);
    expect(localSession.user.has_password).toBe(false);
    await authMod!.logout(localSession.token);
  });

  itPg('password-required user rejects null password', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    try {
      await authMod!.login(name, null);
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
  });

  itPg('logout deletes the session row', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    const session = await authMod!.login(name, 'x');
    const before = await db!.adminSql`
      SELECT 1 FROM harness_shared.user_sessions WHERE token=${session.token}`;
    expect(before.length).toBe(1);
    await authMod!.logout(session.token);
    const after = await db!.adminSql`
      SELECT 1 FROM harness_shared.user_sessions WHERE token=${session.token}`;
    expect(after.length).toBe(0);
  });

  itPg('login sweeps expired + stale never-reused sessions, keeps active ones (EI-338)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'pw');
    const s1 = await authMod!.login(name, 'pw');
    const sql = db!.adminSql;
    const tok = () => randomBytes(32).toString('hex');
    const expired = tok();
    const orphan = tok();
    const oldActive = tok();
    // expired outright
    await sql`
      INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at)
      VALUES (${expired}, ${s1.user.id}, now() - interval '1 hour', now() - interval '31 days')`;
    // in-TTL but never re-presented since mint and past the 48h grace — the
    // EI-338 orphan signature (cookie-less webview mints leave last_seen_at
    // == created_at; the column is NOT NULL)
    await sql`
      INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at, last_seen_at)
      VALUES (${orphan}, ${s1.user.id}, now() + interval '29 days', now() - interval '3 days', now() - interval '3 days')`;
    // old but actively used — last_seen_at refresh must protect it
    await sql`
      INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, created_at, last_seen_at)
      VALUES (${oldActive}, ${s1.user.id}, now() + interval '29 days', now() - interval '3 days', now() - interval '5 minutes')`;
    const s2 = await authMod!.login(name, 'pw'); // triggers the opportunistic sweep
    const left = await sql<{ token: string }[]>`
      SELECT token FROM harness_shared.user_sessions WHERE token = ANY(${[expired, orphan, oldActive, s1.token]})`;
    const survivors = left.map((r) => r.token).sort();
    expect(survivors).toEqual([oldActive, s1.token].sort());
    await authMod!.logout(s2.token);
  });

  itPg('changePassword invalidates ALL existing sessions (the route re-issues)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'old');
    const s1 = await authMod!.login(name, 'old');
    const s2 = await authMod!.login(name, 'old');
    const sql = db!.adminSql;
    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int n FROM harness_shared.user_sessions WHERE token IN (${s1.token},${s2.token})`;
    expect(before[0].n).toBe(2);
    await authMod!.changePassword(s1.user.id, 'old', 'new');
    const after = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int n FROM harness_shared.user_sessions WHERE token IN (${s1.token},${s2.token})`;
    expect(after[0].n).toBe(0);
  });

  itPg('changePassword requires the current password', async () => {
    const name = uname();
    const created = await authMod!.signup(name, 'T', 'old');
    try {
      await authMod!.changePassword(created.id, 'wrong', 'new');
      expect.fail('changePassword should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
    // After successful change, old password no longer works
    await authMod!.changePassword(created.id, 'old', 'new');
    try {
      await authMod!.login(name, 'old');
      expect.fail('login should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('bad_password');
    }
    const ok = await authMod!.login(name, 'new');
    expect(ok.token).toBeTruthy();
    await authMod!.logout(ok.token);
  });

  itPg('session TTL is stored as a real timestamptz (regression for the Date/ISO bug)', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    const session = await authMod!.login(name, 'x');
    const r = await db!.adminSql<{ expires_at: Date }[]>`
      SELECT expires_at FROM harness_shared.user_sessions WHERE token=${session.token}`;
    expect(r[0].expires_at).toBeInstanceOf(Date);
    // Within 1 minute of expected 30d-from-now
    const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(r[0].expires_at.getTime() - expected)).toBeLessThan(60_000);
    await authMod!.logout(session.token);
  });

  itPg('preserves a normal explicit remember-device TTL', async () => {
    const name = uname();
    await authMod!.signup(name, 'T', 'x');
    const ttl = 7 * 24 * 60 * 60 * 1000;
    const session = await authMod!.login(name, 'x', { ttl_ms: ttl });
    const rows = await db!.adminSql<{ expires_at: Date }[]>`
      SELECT expires_at FROM harness_shared.user_sessions WHERE token=${session.token}`;
    expect(Math.abs(rows[0].expires_at.getTime() - (Date.now() + ttl))).toBeLessThan(60_000);
    await authMod!.logout(session.token);
  });

  itPg('rejects malformed or excessive session TTLs before minting a session', async () => {
    const name = uname();
    const user = await authMod!.signup(name, 'T', 'x');
    const invalidTtls = [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const ttl_ms of [...invalidTtls, authMod!.MAX_SESSION_TTL_MS + 1]) {
      await expect(authMod!.login(name, 'x', { ttl_ms })).rejects.toMatchObject({
        code: 'invalid_session_ttl',
      });
    }

    const sessions = await db!.adminSql<{ token: string }[]>`
      SELECT token FROM harness_shared.user_sessions WHERE user_id=${user.id}`;
    expect(sessions).toEqual([]);
  });
});
