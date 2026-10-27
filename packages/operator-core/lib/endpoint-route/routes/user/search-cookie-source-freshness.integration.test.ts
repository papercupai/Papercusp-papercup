/** P001 contributing HTTP identity capture. Real route stack and cookie auth;
 * private persisted sessions and a controlled PG-backed memory adapter.
 * Not production RLS, prose recall, browser UI or cross-process cache proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

const seams = vi.hoisted(() => ({ sql: null as Sql | null, scopes: [] as string[][],
  prose: [] as Array<{ workspaceId: string; query: string }> }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: seams.sql }),
}));
vi.mock('../../../workspace-registry', async original => ({
  ...await original<typeof import('../../../workspace-registry')>(), activeWorkspaceId: () => 'p001-http-cookie',
})); // Fixed host workspace; no runtime workspace-router qualification.
vi.mock('../../../memory/backend', async original => ({
  ...await original<typeof import('../../../memory/backend')>(),
  getMemoryBackend: () => ({ name: 'p001-private-pg', available: async () => ({ ok: true }),
    search: async (_query: string, options: { scope: readonly string[]; limit: number }) => {
      seams.scopes.push([...options.scope]);
      return seams.sql!`SELECT id,text,scope,0.9::float8 AS score FROM harness_shared.p001_http_memories
        WHERE scope = ANY(${[...options.scope]}) ORDER BY id LIMIT ${options.limit}`;
    } }),
}));
vi.mock('@papercusp/search', async original => ({
  ...await original<typeof import('@papercusp/search')>(),
  runFullTextSearch: async (_sources: unknown, ctx: { workspaceId: string; query: string }) => {
    seams.prose.push({ workspaceId: ctx.workspaceId, query: ctx.query });
    return { results: [] };
  },
})); // Prose retrieval is outside this cookie/recall identity witness.
vi.mock('../../../agent-tools/search/rerank', async original => ({
  ...await original<typeof import('../../../agent-tools/search/rerank')>(),
  rerankCandidateCount: (n: number) => n, rerankProseHits: async (_q: string, hits: unknown[]) => hits,
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));
vi.mock('../../telemetry', async original => ({
  ...await original<typeof import('../../telemetry')>(), recordRouteInvocation: () => {},
})); // No production telemetry claim.

import route from './search';
import { registerRoute } from '../../define-route';
import { SESSION_COOKIE, _resetLastSeenDebounceForTests } from '../../../auth';

const WS = 'p001-http-cookie';
const sources = [
  'packages/operator-core/lib/endpoint-route/routes/user/search-cookie-source-freshness.integration.test.ts',
  'packages/operator-core/lib/endpoint-route/routes/user/search.ts',
  'packages/operator-core/lib/endpoint-route/define-route.ts',
  'packages/operator-core/lib/endpoint-route/route-stack.ts',
  'packages/operator-core/lib/auth.ts',
];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const pin = () => sources.map(path => ({ path,
  sha256: hash(readFileSync(new URL('../../../../../../' + path, import.meta.url))) }));
const receipts: unknown[] = [];
const completed: string[] = [];
let pins: ReturnType<typeof pin>;
let db: FreshPgDb;
let server: ReturnType<typeof serve>;
let origin: string;

async function recall(cookie?: string, suffix = '') {
  const response = await fetch(origin + '/user/search?q=cookie-sentinel' + suffix,
    { headers: cookie ? { cookie: SESSION_COOKIE + '=' + cookie } : {} });
  const body = await response.json() as { memories: Array<{ id: string; text: string }> };
  receipts.push({ status: response.status, body, scopes: seams.scopes.map(s => [...s]) });
  expect(response.status).toBe(200);
  return body.memories;
}
function ids(rows: Array<{ id: string }>) { return rows.map(row => row.id).sort(); }

beforeAll(async () => {
  pins = pin();
  db = await createFreshPgDb('p001-http-cookie');
  seams.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.users (id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      username text UNIQUE,display_name text,password_hash text,is_active boolean DEFAULT true);
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY,user_id text,expires_at timestamptz,
      workspace_id text,capabilities text[],last_seen_at timestamptz);
    CREATE TABLE harness_shared.p001_http_memories (id text PRIMARY KEY,text text,scope text);`);
  const app = new Hono();
  registerRoute(app, route);
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}, 60_000);

beforeEach(async () => {
  _resetLastSeenDebounceForTests();
  seams.scopes.length = 0; seams.prose.length = 0;
  await db.sql.unsafe(`TRUNCATE harness_shared.users,harness_shared.user_sessions,harness_shared.p001_http_memories;
    INSERT INTO harness_shared.users (id,username,display_name) VALUES
      ('default-id','default','Default'),('alice-id','alice','Alice'),('bob-id','bob','Bob');
    INSERT INTO harness_shared.user_sessions (token,user_id,expires_at,workspace_id,capabilities) VALUES
      ('alice-cookie','alice-id',now()+interval '1 hour','p001-http-cookie','{}'),
      ('bob-cookie','bob-id',now()+interval '1 hour','p001-http-cookie','{}');
    INSERT INTO harness_shared.p001_http_memories VALUES ('alice','Alice original','alice-id'),
      ('bob','Bob private','bob-id'),('default','Default private','default-id'),
      ('shared','Workspace shared','workspace:p001-http-cookie'),('foreign','Foreign workspace','workspace:foreign');`);
});

describe('P001 browser-facing search HTTP cookie authority', () => {
  it('binds each real cookie to its own persisted user and fixed host workspace pools', async () => {
    expect(ids(await recall('alice-cookie'))).toEqual(['alice', 'shared']);
    expect(ids(await recall('bob-cookie'))).toEqual(['bob', 'shared']);
    expect(seams.scopes).toEqual([['alice-id', 'workspace:' + WS], ['bob-id', 'workspace:' + WS]]);
    expect(seams.prose).toEqual([{ workspaceId: WS, query: 'cookie-sentinel' },
      { workspaceId: WS, query: 'cookie-sentinel' }]);
    completed.push('cookie-isolation');
  });

  it('ignores caller-controlled user/workspace/scope query overrides', async () => {
    expect(ids(await recall('alice-cookie', '&userId=bob-id&workspace=foreign&scope=bob-id')))
      .toEqual(['alice', 'shared']);
    expect(seams.scopes).toEqual([['alice-id', 'workspace:' + WS]]);
    completed.push('query-overrides');
  });

  it('falls back to the default pool after persisted expiry without an auth-cache reset', async () => {
    expect(ids(await recall('alice-cookie'))).toEqual(['alice', 'shared']);
    await db.sql`UPDATE harness_shared.user_sessions SET expires_at=now()-interval '1 second'
      WHERE token='alice-cookie'`;
    expect(ids(await recall('alice-cookie'))).toEqual(['default', 'shared']);
    expect(seams.scopes.at(-1)).toEqual(['default-id', 'workspace:' + WS]);
    completed.push('expiry');
  });

  it('falls back after session deletion or user deactivation without reusing private authority', async () => {
    expect(ids(await recall('alice-cookie'))).toEqual(['alice', 'shared']);
    await db.sql`DELETE FROM harness_shared.user_sessions WHERE token='alice-cookie'`;
    expect(ids(await recall('alice-cookie'))).toEqual(['default', 'shared']);
    expect(ids(await recall('bob-cookie'))).toEqual(['bob', 'shared']);
    await db.sql`UPDATE harness_shared.users SET is_active=false WHERE id='bob-id'`;
    expect(ids(await recall('bob-cookie'))).toEqual(['default', 'shared']);
    completed.push('revocation');
  });

  it('uses the documented default fallback for missing/unknown cookies and returns current stored text', async () => {
    expect(ids(await recall())).toEqual(['default', 'shared']);
    expect(ids(await recall('unknown-cookie'))).toEqual(['default', 'shared']);
    await db.sql`UPDATE harness_shared.p001_http_memories SET text='Alice current' WHERE id='alice'`;
    expect(await recall('alice-cookie')).toContainEqual(expect.objectContaining({ id: 'alice', text: 'Alice current' }));
    completed.push('fallback-and-update');
  });

  it('re-reads an authority change committed by an independent process while the HTTP reader stays warm', async () => {
    expect(ids(await recall('alice-cookie'))).toEqual(['alice', 'shared']);
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      "import postgres from 'postgres'; const sql=postgres(process.env.P001_TEST_DB_URL,{max:1,prepare:false}); " +
      "try { await sql`UPDATE harness_shared.user_sessions SET user_id='bob-id' WHERE token='alice-cookie'`; " +
      "console.log('authority-change-committed'); } finally { await sql.end(); }"],
    { env: { ...process.env, P001_TEST_DB_URL: db.url }, timeout: 30_000 });
    expect(result.stdout.trim()).toBe('authority-change-committed');
    expect(result.stderr).toBe('');
    expect(ids(await recall('alice-cookie'))).toEqual(['bob', 'shared']);
    expect(seams.scopes).toEqual([['alice-id', 'workspace:' + WS], ['bob-id', 'workspace:' + WS]]);
    completed.push('independent-process-authority');
  }, 40_000);
});

afterAll(async () => {
  let cleanup = 'not-attempted';
  const after = pin();
  try {
    expect(after).toEqual(pins);
    expect([...completed].sort()).toEqual(['cookie-isolation', 'query-overrides', 'expiry',
      'revocation', 'fallback-and-update', 'independent-process-authority'].sort());
  } finally {
    if (server) { if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())); }
    try { await db?.cleanup(); cleanup = 'dropped'; }
    finally {
      if (process.env.PAPERCUSP_P001_HTTP_COOKIE_CAPTURE_OUT) writeFileSync(process.env.PAPERCUSP_P001_HTTP_COOKIE_CAPTURE_OUT,
        JSON.stringify({ sourcePins: pins, sourceStable: JSON.stringify(after) === JSON.stringify(pins),
          cleanup, completed, receipts, limitations: ['Private admin PG/projected schema; no production RLS.',
            'Real local Hono/node HTTP, route stack and cookie auth; no browser UI or full operator mount.',
            'Controlled persisted memory adapter; prose, embedder, ranking and telemetry unqualified.',
            'Fixed host workspace; no remote/hosted authorization or workspace-router proof.',
            'Independent writer/warm HTTP reader tested; no TTL/NOTIFY, signing-key cache, spec binding or provenance upgrade.'] }, null, 2));
    }
  }
}, 30_000);
