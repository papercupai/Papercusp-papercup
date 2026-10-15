/**
 * dispatch.integration.test.ts — the tui:dispatch MCP tool handler, against a real
 * Postgres. It's a request/response over harness_shared.tui_intents: INSERT a
 * pending intent, poll until a pui client flips its status, else time out.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the intent row stores `args` as a proper jsonb OBJECT (::text::jsonb), with
 *    requested_by from the principal;
 *  - the poll RETURNS the response once status flips off 'pending' (result echoed);
 *  - with no responder it times out: the row is UPDATEd to status='timeout' and an
 *    isError timeout is returned.
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

const dispatchTool = (await import('./dispatch')).default;
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = { principal: { slug: 'tester' } }) =>
  dispatchTool.handler(args as never, ctx as never) as Promise<{ isError?: boolean; content: { text: string }[] }>;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `tui_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // workspace_id is NOT NULL (migration 453) — the tool MUST stamp it. A table
  // without this column silently passed while the tool dropped workspace_id from
  // the insert (the ui_intents twin of that is EI-6861: NOT NULL added to the
  // shared DB while old code inserted 4 cols → "null value in column workspace_id").
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.tui_intents (
      id BIGSERIAL PRIMARY KEY,
      client_id text NOT NULL, intent text NOT NULL,
      args jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending', result jsonb, error_message text,
      requested_by text, workspace_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.tui_intents RESTART IDENTITY`;
});

// Concurrent "pui client": flip the first pending intent to a terminal status.
async function respond(status: string, result: unknown) {
  for (let i = 0; i < 300; i++) {
    const r = await rootSql`UPDATE harness_shared.tui_intents SET status=${status}, result=${rootSql.json(result as never)}, completed_at=now() WHERE status='pending' RETURNING id`;
    if (r.length) return;
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe('tui:dispatch handler (PG)', () => {
  it('stores the intent (jsonb args + requested_by) and returns the response when a client answers', async () => {
    const [res] = await Promise.all([
      call({ client_id: 'c1', intent: 'open-pane', args: { pane: 'logs' }, timeout_ms: 3000 }),
      respond('done', { opened: true }),
    ]);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: 'done', result: { opened: true } });
    expect(res.isError).toBeFalsy();
    const row = (await rootSql<{ typ: string; pane: string; requested_by: string; workspace_id: string | null }[]>`
      SELECT jsonb_typeof(args) AS typ, args->>'pane' AS pane, requested_by, workspace_id FROM harness_shared.tui_intents`)[0]!;
    expect(row.typ).toBe('object'); // args is a real jsonb object (::text::jsonb), not a string scalar
    expect(row.pane).toBe('logs');
    expect(row.requested_by).toBe('tester'); // principal.slug
    // Regression (EI-6861 twin): the insert stamps a non-null workspace_id via
    // activeWorkspaceId(). If a refactor drops the column the NOT NULL insert throws.
    expect(row.workspace_id).toBeTruthy();
    expect(typeof row.workspace_id).toBe('string');
  });

  it('times out when no client answers: row → status=timeout, isError returned', async () => {
    const res = await call({ client_id: 'nobody', intent: 'open-pane', args: {}, timeout_ms: 250 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).status).toBe('timeout');
    expect((await rootSql`SELECT status FROM harness_shared.tui_intents`)[0]!.status).toBe('timeout'); // the timeout UPDATE fired
  });
});
