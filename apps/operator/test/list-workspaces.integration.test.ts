/**
 * list-workspaces.integration.test.ts
 *
 * Regression guard for `papercusp:list_workspaces` → `column "harness_slug"
 * does not exist` (found in harness_shared.tool_invocations, 2026-05-31).
 *
 * ROOT CAUSE: the handler queried `SELECT workspace_id, harness_slug, ...
 * FROM harness_shared.harness_registry`, but that table is a one-JSONB-blob-
 * per-workspace shape (workspace_id PK, payload JSONB, updated_at BIGINT — see
 * migration 025); the harnesses live in payload.projects[].slug and there is
 * no harness_slug column. The corrected query unpacks payload.projects[].
 *
 * Drives the REAL tool handler against a seeded registry table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real tool handler
import listWorkspaces from '../../../packages/agent-mcp/src/tools/papercusp/list_workspaces';
// list_workspaces is a crossWorkspace defineTool: it reads getOrgPg() directly
// (NOT ctx.tx), so we point getOrgPg at this test's DB rather than passing a tx.
import { _resetForTests } from '@papercusp/db-org';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `lw_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  // harness_registry shape from migration 025.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  // getOrgPg() opens with search_path [harness_shared, papercusp_shared, public];
  // create papercusp_shared so the SET search_path on its client is clean.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS papercusp_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_registry (
      workspace_id TEXT PRIMARY KEY,
      payload      JSONB NOT NULL,
      updated_at   BIGINT NOT NULL DEFAULT 0
    )`);

  const ins = async (ws: string, projects: Array<{ slug: string; path: string }>, ts: number) => {
    // Use sql.json() — postgres-js double-encodes a `${JSON.stringify(x)}::jsonb`
    // (stores it as a quoted JSON string scalar, so payload->'projects' is null).
    await sql`INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at)
              VALUES (${ws}, ${sql.json({ projects })}, ${ts})`;
  };
  await ins('default', [{ slug: 'papercup', path: '/x' }, { slug: 'sheets', path: '/y' }], 1716000000000);
  await ins('acme', [{ slug: 'docs', path: '/z' }], 1716000100000);
  await ins('empty-ws', [], 1716000200000); // a workspace with zero registered harnesses

  // Point getOrgPg() (what the handler reads) at this seeded DB, then clear any
  // cached admin connection so the next getOrgPg() picks up the new URL.
  process.env.HARNESS_ADMIN_DATABASE_URL = u.toString();
  await _resetForTests();
}, 60_000);

afterAll(async () => {
  delete process.env.HARNESS_ADMIN_DATABASE_URL;
  await _resetForTests();
  await sql?.end({ timeout: 5 });
});

describe('papercusp:list_workspaces', () => {
  it('lists workspaces + their harnesses from the JSONB registry (no "column harness_slug" error)', async () => {
    // The old query threw `column "harness_slug" does not exist`; the handler
    // does not catch, so a regression would reject this await and fail the test.
    // The new defineTool handler ignores ctx.tx (reads getOrgPg) and returns a
    // ToolResponse { data } envelope — not the old { ok, response: { data } }.
    const res = (await (listWorkspaces as { handler: (a: unknown, c: unknown) => Promise<unknown> })
      .handler({}, {})) as {
      data: { workspaces: Array<{ slug: string; harnesses: string[]; lastActiveTs: number }>; defaultWorkspace: string | null };
    };

    const bySlug = Object.fromEntries(res.data.workspaces.map((w) => [w.slug, w]));

    expect([...bySlug.default.harnesses].sort()).toEqual(['papercup', 'sheets']);
    expect(bySlug.acme.harnesses).toEqual(['docs']);
    expect(bySlug['empty-ws'].harnesses).toEqual([]); // LEFT JOIN keeps harness-less workspaces
    expect(bySlug.default.lastActiveTs).toBe(1716000000000); // updated_at is epoch-ms, emitted directly
    expect(res.data.defaultWorkspace).toBe('default');
  });
});
