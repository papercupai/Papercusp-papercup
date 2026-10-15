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
        response_bytes integer
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
