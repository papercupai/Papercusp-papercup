/**
 * audit-log.integration.test.ts
 *
 * Proves the PG-backed provision audit log (migration 026;
 * harness_shared.provision_audit_log) against a real Postgres
 * testcontainer: append/read ordering, the sinceTs filter, `limit`
 * clamping to the MOST RECENT entries, the no-truncation contract (the
 * file-era capMb arg is accepted and ignored — PG absorbs the volume),
 * and the in-process audit-bus fan-out appendAudit performs after the
 * row commits.
 *
 * Mirrors operator-conversation-compaction.integration.test.ts's setup
 * (getOrgPg → drizzle over a per-test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-provision-audit-test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { appendAudit, readAudit, AuditStream } = await import('./audit-log');
const { subscribe } = await import('../provision-audit-bus');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pa_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Baseline shape (000-baseline.sql ~:2317) — bigserial = the dump's
  // sequence + DEFAULT nextval pair.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.provision_audit_log (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      ts timestamp with time zone DEFAULT now() NOT NULL,
      kind text NOT NULL,
      run_id text,
      data jsonb
    );
    CREATE INDEX provision_audit_log_target_idx
      ON harness_shared.provision_audit_log (workspace_id, harness_slug, plugin_slug, ts);
  `);
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`DELETE FROM harness_shared.provision_audit_log`;
});

describe('provision audit log (PG)', () => {
  it('appends and reads entries in ts order', async () => {
    await appendAudit('h', 'p', { kind: 'consent-granted', data: { userId: 'u1' } });
    await appendAudit('h', 'p', { kind: 'setup-started', runId: 'r1' });
    const entries = await readAudit('h', 'p');
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('consent-granted');
    expect(entries[0].data?.userId).toBe('u1');
    expect(entries[1].runId).toBe('r1');
  });

  it('respects the sinceTs filter', async () => {
    await appendAudit('h', 'p', { kind: 'setup-started', ts: '2026-01-01T00:00:00Z' });
    await appendAudit('h', 'p', { kind: 'setup-succeeded', ts: '2026-01-02T00:00:00Z' });
    const entries = await readAudit('h', 'p', { sinceTs: '2026-01-01T12:00:00Z' });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('setup-succeeded');
  });

  it('returns an empty array when no rows exist for the pair', async () => {
    expect(await readAudit('h', 'never', {})).toEqual([]);
  });

  it('limit clamps to the MOST RECENT entries, still ascending', async () => {
    for (let i = 0; i < 10; i++) {
      await appendAudit('h', 'p', {
        kind: 'script-output',
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        data: { n: i },
      });
    }
    const recent = await readAudit('h', 'p', { limit: 3 });
    expect(recent.map((e) => e.data?.n)).toEqual([7, 8, 9]);
  });

  it('does NOT truncate: the file-era capMb arg is ignored and every row survives', async () => {
    const tinyCapMb = 0.001; // would have forced truncation in the file era
    for (let i = 0; i < 50; i++) {
      await appendAudit('h', 'p', { kind: 'script-output', data: { line: 'x'.repeat(20), n: i } }, tinyCapMb);
    }
    const entries = await readAudit('h', 'p');
    expect(entries).toHaveLength(50);
    expect(entries.find((e) => e.kind === 'log-truncated')).toBeUndefined();
  });

  it('entries are scoped per (harness, plugin)', async () => {
    await appendAudit('h1', 'p', { kind: 'setup-started' });
    await appendAudit('h2', 'p', { kind: 'teardown-started' });
    expect((await readAudit('h1', 'p')).map((e) => e.kind)).toEqual(['setup-started']);
    expect((await readAudit('h2', 'p')).map((e) => e.kind)).toEqual(['teardown-started']);
  });

  it('fans out to the in-process audit bus after the row commits', async () => {
    const seen: unknown[] = [];
    const sub = subscribe('h:p', (env) => seen.push(env.entry));
    try {
      await appendAudit('h', 'p', { kind: 'verify-started', runId: 'r9' });
    } finally {
      sub.unsubscribe();
    }
    expect(seen).toHaveLength(1);
    expect((seen[0] as { kind: string; runId: string }).kind).toBe('verify-started');
    expect((seen[0] as { kind: string; runId: string }).runId).toBe('r9');
  });

  it('AuditStream.write lands one script-output row per line, newline-trimmed', async () => {
    const stream = new AuditStream('h', 'p', 'run-1');
    await stream.open();
    await stream.write('hello world\n');
    await stream.write('second line');
    await stream.close();
    const entries = await readAudit('h', 'p');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === 'script-output' && e.runId === 'run-1')).toBe(true);
    expect(entries.map((e) => e.data?.line)).toEqual(['hello world', 'second line']);
  });
});
