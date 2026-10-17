/**
 * EI-25873055328578612: mounted route -> real postgres.js writer -> PostgreSQL
 * failure -> console. The isolated test-only trigger reflects a bound route
 * marker into a server exception; it is fault injection, not production-schema
 * or deployed vendor/customer placement evidence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { mockReturnTyped } from '../../testing/typed-mock';

// The recorder consumes only the SQL client; keep its real isolated driver.
const { orgPgMock } = vi.hoisted(() => ({
  orgPgMock: vi.fn<() => Pick<ReturnType<typeof import('@papercusp/db-org').getOrgPg>, 'sql'>>(),
}));

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: orgPgMock,
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'telemetry-privacy-test',
}));

import { registerRoute, type RouteDefinition } from '../define-route';
import { createHostedRouteStack } from '../hosted-route-stack';

const NEVER_EMIT_MARKER = 'never-emit-me';

describe('mounted route telemetry PostgreSQL failure confidentiality', () => {
  let db: FreshPgDb;
  const rejected: unknown[] = [];

  beforeAll(async () => {
    db = await createFreshPgDb('route-telemetry-privacy');
    // Minimal projection of the columns the production recorder writes.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.route_invocations (
        workspace_id text, method text, path text, status text,
        duration_ms integer, principal_kind text, principal_auth_method text,
        principal_trust text, error_message text, resolved_path text,
        response_bytes integer, metadata_json jsonb
      );
      CREATE FUNCTION harness_shared.reject_marked_route() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resolved_path LIKE '%pg-failure-route-marker%' THEN
          RAISE EXCEPTION 'telemetry rejected route %', NEW.resolved_path
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_marked_route BEFORE INSERT
        ON harness_shared.route_invocations FOR EACH ROW
        EXECUTE FUNCTION harness_shared.reject_marked_route();
    `);
    // Use the real transaction and driver; capture its rejected Error without
    // changing the Error or replacing the recorder.
    const observedSql = new Proxy(db.sql, {
      get(target, property, receiver) {
        if (property !== 'begin') return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => Promise.resolve(Reflect.apply(target.begin, target, args))
          .catch((error: unknown) => { rejected.push(error); throw error; });
      },
    });
    mockReturnTyped(orgPgMock, { sql: observedSql });
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.cleanup();
  });

  it('persists safe Codex repair correlation through the mounted route and real PostgreSQL writer', async () => {
    const attemptId = '78a48e81-3884-4af5-b864-e1ba22969740';
    const app = new Hono().basePath('/api');
    const paths = ['/adv/sessions/ensure-codex-home', '/adv/sessions/unrelated'];
    for (const path of paths) {
      registerRoute(app, {
        method: 'POST', path, auth: 'public', sampleRate: 1,
        handler: () => Response.json({ content: 'private-correlation-response-marker' }),
      }, createHostedRouteStack(async () => ({ ok: false, reason: 'session_cookie_missing' })));
    }
    const attempts = [
      { path: paths[0], header: attemptId, metadata: { codexHomeRepairAttemptId: attemptId } },
      { path: paths[0], header: 'private-invalid-correlation-marker', metadata: null },
      { path: paths[1], header: attemptId, metadata: null },
    ];
    try {
      for (const [index, attempt] of attempts.entries()) {
        const response = await app.request('/api' + attempt.path + '?private=private-correlation-query-marker', {
          method: 'POST', headers: { 'content-type': 'application/json',
            'x-papercusp-repair-attempt': attempt.header, 'x-private': 'private-correlation-header-marker' },
          body: JSON.stringify({ secret: NEVER_EMIT_MARKER }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ content: 'private-correlation-response-marker' });
        await vi.waitFor(async () => {
          const rows = await db.sql`SELECT metadata_json FROM harness_shared.route_invocations ORDER BY ctid`;
          expect(rows).toHaveLength(index + 1);
          expect(rows[index].metadata_json).toEqual(attempt.metadata);
          const persisted = JSON.stringify(await db.sql`SELECT * FROM harness_shared.route_invocations`);
          for (const marker of ['private-correlation-query-marker', NEVER_EMIT_MARKER,
            'private-correlation-response-marker', 'private-correlation-header-marker', 'private-invalid-correlation-marker']) {
            expect(persisted).not.toContain(marker);
          }
        }, { timeout: 10_000 });
      }
    } finally {
      await db.sql`DELETE FROM harness_shared.route_invocations`;
    }
  });

  it('keeps successful route attribution and suppresses server error content once without changing responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queryMarker = 'private-query-marker';
    const bodyMarker = 'private-request-body-marker';
    const responseMarker = 'private-response-body-marker';
    const app = new Hono().basePath('/api');
    const def: RouteDefinition = {
      method: 'POST', path: '/privacy/:workspaceId', auth: 'public', sampleRate: 1,
      handler: () => Response.json({ content: responseMarker }),
    };
    registerRoute(app, def, createHostedRouteStack(async () => ({
      ok: false, reason: 'session_cookie_missing',
    })));
    const request = async (workspaceId: string) => {
      const response = await app.request('/api/privacy/' + workspaceId + '?query=' + queryMarker, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: bodyMarker }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ content: responseMarker });
    };

    await request('successful-control');
    await vi.waitFor(async () => {
      const rows = await db.sql`SELECT * FROM harness_shared.route_invocations`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspace_id: 'telemetry-privacy-test', method: 'POST',
        path: def.path, resolved_path: '/api/privacy/successful-control', status: 'ok',
      });
      for (const marker of [queryMarker, bodyMarker, responseMarker]) {
        expect(JSON.stringify(rows)).not.toContain(marker);
      }
    }, { timeout: 10_000 });
    expect(warn).not.toHaveBeenCalled();

    await request('pg-failure-route-marker');
    await request('pg-failure-route-marker');
    await vi.waitFor(() => {
      expect(rejected).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    }, { timeout: 10_000 });
    for (const error of rejected) {
      expect(error).toMatchObject({ name: 'PostgresError', code: '23514' });
      expect((error as Error).message).toContain('pg-failure-route-marker');
    }
    const rows = await db.sql`SELECT * FROM harness_shared.route_invocations`;
    expect(rows).toHaveLength(1); // Both telemetry transactions rolled back.
    expect(warn.mock.calls[0]).toEqual([
      '[route-telemetry] write failed (further telemetry write failures suppressed)',
      'route_telemetry_write_failed',
    ]);
    for (const marker of ['pg-failure-route-marker', queryMarker, bodyMarker, responseMarker]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    }
  });
});
