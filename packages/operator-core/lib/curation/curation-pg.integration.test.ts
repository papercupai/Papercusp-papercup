/**
 * curation-pg.integration.test.ts
 *
 * Proves, against a real Postgres (testcontainer) with migration 151 applied,
 * that the curator-operator's PG modules round-trip:
 *   - operator_curation_log: recordSurfaced → loadRecentSurfaced (+ the time
 *     window predicate + the idempotent PK upsert).
 *   - operator_curation_state: default read, write, and partial-update COALESCE.
 *
 * Mirrors the testcontainer setup of harness-issues.integration.test.ts — mocks
 * `@papercusp/db-org` withWorkspace + `workspace-registry` activeWorkspaceId to
 * point at the per-test connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

const WS = 'ws-curtest';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual,
    withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown,
      opts?: { lockTimeoutMs?: number; statementTimeoutMs?: number }) => h.sql.begin(async tx => {
      if (opts?.lockTimeoutMs !== undefined) {
        await tx`SELECT set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}, true)`;
      }
      if (opts?.statementTimeoutMs !== undefined) {
        await tx`SELECT set_config('statement_timeout', ${`${opts.statementTimeoutMs}ms`}, true)`;
      }
      return fn(tx as unknown as postgres.Sql);
    }),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { recordSurfaced, loadRecentSurfaced, listRecentCuration, loadOpenRecoverable } = await import('./curation-log');
const { readCurationState, writeCurationState } = await import('./curation-state');
const { BASE_INTERVAL_SECONDS } = await import('./curation-loop');

let rootSql: postgres.Sql;
let dbName: string;
let databaseUrl: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `cur_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  databaseUrl = u.toString();
  rootSql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The migration GRANTs to harness_app/harness_zero (141 idiom); create them so
  // the bare testcontainer applies 151 cleanly (the dev box / embedded-pg has them).
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await rootSql.unsafe(readMigration('151-operator-curation.sql')).simple();
  await rootSql.unsafe(readMigration('618-curation-log-title.sql')).simple();
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('operator_curation_log', () => {
  it('records + loads surfaced ids', async () => {
    await recordSurfaced([{ id: 'escalation:e1', kind: 'escalation' }, { id: 'progress:p1', kind: 'progress' }], 'curator-v1');
    const recent = await loadRecentSurfaced();
    expect(recent.has('escalation:e1')).toBe(true);
    expect(recent.has('progress:p1')).toBe(true);
    expect(recent.has('nope')).toBe(false);
  });

  it('the time-window predicate excludes rows older than the window', async () => {
    // Insert a 2-day-old row directly; a fresh one via the API.
    await rootSql`
      INSERT INTO harness_shared.operator_curation_log (workspace_id, signal_id, kind, policy_version, surfaced_at)
      VALUES (${WS}, 'old:1', 'progress', 'curator-v1', now() - interval '2 days')
    `;
    await recordSurfaced([{ id: 'fresh:1', kind: 'completion' }], 'curator-v1');
    const within24h = await loadRecentSurfaced(24 * 60 * 60 * 1000);
    expect(within24h.has('fresh:1')).toBe(true);
    expect(within24h.has('old:1')).toBe(false);
  });

  it('upsert is idempotent on (workspace, signal_id)', async () => {
    await recordSurfaced([{ id: 'dup:1', kind: 'escalation' }], 'curator-v1');
    await recordSurfaced([{ id: 'dup:1', kind: 'escalation' }], 'curator-v2');
    const rows = await rootSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${WS} AND signal_id = 'dup:1'
    `;
    expect(rows[0].n).toBe('1');
    const audit = await listRecentCuration(100);
    expect(audit.find((r) => r.id === 'dup:1')?.policyVersion).toBe('curator-v2');
  });

  it('recordSurfaced with no entries is a no-op', async () => {
    await expect(recordSurfaced([], 'curator-v1')).resolves.toBeUndefined();
  });

  it('curation-writer: retains the last occurrence of a signal within one tick', async () => {
    await recordSurfaced([
      { id: 'repeat:tick', kind: 'progress', title: 'earlier' },
      { id: 'repeat:tick', kind: 'blocker', title: 'latest' },
    ], 'curator-v2');
    const [row] = await rootSql`
      SELECT kind, title, policy_version FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${WS} AND signal_id = 'repeat:tick'
    `;
    expect(row).toMatchObject({ kind: 'blocker', title: 'latest', policy_version: 'curator-v2' });
  });

  it('curation-writer: bounds a real row-lock wait and preserves the earlier surfaced record', async () => {
    await recordSurfaced([{ id: 'locked:tick', kind: 'blocker', title: 'earlier' }], 'curator-v1');
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let write: Promise<{ code: string }> | undefined;
    let outcome: { code: string } | undefined;
    try {
      await holder.begin(async tx => {
        await tx`SELECT signal_id FROM harness_shared.operator_curation_log
          WHERE workspace_id = ${WS} AND signal_id = 'locked:tick' FOR UPDATE`;
        write = recordSurfaced([{ id: 'locked:tick', kind: 'completion' }], 'curator-v2')
          .then(() => ({ code: 'completed' }), error => ({ code: String(error.code) }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          outcome = await Promise.race([
            write,
            new Promise<{ code: string }>(resolve => {
              timer = setTimeout(() => resolve({ code: 'test-deadline' }), 6_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      // Release the holder before draining even an implementation that fails to
      // bound its wait, so the negative control cannot strand a test connection.
      await write;
    } finally {
      await holder.end({ timeout: 5 });
    }
    expect(outcome?.code).toBe('55P03');
    const [row] = await rootSql`
      SELECT kind, title, policy_version FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${WS} AND signal_id = 'locked:tick'
    `;
    expect(row).toMatchObject({ kind: 'blocker', title: 'earlier', policy_version: 'curator-v1' });
  }, 18_000);

  it('records + round-trips a title (P-003)', async () => {
    await recordSurfaced([{ id: 'blocked:wi:h#title', kind: 'blocker', title: 'W1 wedged on vendor key' }], 'curator-v1');
    const rows = await rootSql<{ title: string | null }[]>`
      SELECT title FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${WS} AND signal_id = 'blocked:wi:h#title'
    `;
    expect(rows[0].title).toBe('W1 wedged on vendor key');
  });
});

describe('loadOpenRecoverable (P-003 recovery close-the-loop)', () => {
  it('returns a surfaced blocker/escalation not yet cleared', async () => {
    await recordSurfaced([{ id: 'blocked:wi:h#open1', kind: 'blocker', title: 'still stuck' }], 'curator-v1');
    const open = await loadOpenRecoverable();
    const row = open.find((o) => o.id === 'blocked:wi:h#open1');
    expect(row).toMatchObject({ id: 'blocked:wi:h#open1', kind: 'blocker', title: 'still stuck' });
  });

  it('excludes a kind outside RECOVERABLE_KINDS (e.g. progress/decision)', async () => {
    await recordSurfaced([{ id: 'progress:notrecoverable', kind: 'progress', title: 'routine' }], 'curator-v1');
    const open = await loadOpenRecoverable();
    expect(open.find((o) => o.id === 'progress:notrecoverable')).toBeUndefined();
  });

  it('excludes an id once its cleared:<id> counterpart is recorded (fires once)', async () => {
    await recordSurfaced([{ id: 'blocked:wi:h#open2', kind: 'blocker', title: 'flaky' }], 'curator-v1');
    let open = await loadOpenRecoverable();
    expect(open.some((o) => o.id === 'blocked:wi:h#open2')).toBe(true);

    await recordSurfaced([{ id: 'cleared:blocked:wi:h#open2', kind: 'cleared', title: 'flaky' }], 'curator-v1');
    open = await loadOpenRecoverable();
    expect(open.some((o) => o.id === 'blocked:wi:h#open2')).toBe(false);
  });

  it('flap guard: re-surfacing AFTER a clear makes it open again (genuine reopen, not noise)', async () => {
    // open2 was cleared in the previous test; re-surfacing it now (a fresh,
    // later surfaced_at) must un-exclude it — the NOT EXISTS check compares
    // timestamps, not just row existence.
    await recordSurfaced([{ id: 'blocked:wi:h#open2', kind: 'blocker', title: 'flaky, reopened' }], 'curator-v1');
    const open = await loadOpenRecoverable();
    const row = open.find((o) => o.id === 'blocked:wi:h#open2');
    expect(row).toMatchObject({ title: 'flaky, reopened' });
  });
});

describe('operator_curation_state', () => {
  it('reads defaults when no row exists', async () => {
    const state = await readCurationState();
    expect(state.currentIntervalSeconds).toBe(BASE_INTERVAL_SECONDS);
    expect(state.lastRunAtMs).toBeNull();
    expect(state.lastDigestAtMs).toBeNull();
    expect(state.consecutiveQuiet).toBe(0);
  });

  it('writes + reads back state', async () => {
    const t = 1_780_000_000_000;
    await writeCurationState({ lastRunAtMs: t, currentIntervalSeconds: 300, consecutiveQuiet: 2, lastSurfacedCount: 4 });
    const state = await readCurationState();
    expect(state.lastRunAtMs).toBe(t);
    expect(state.currentIntervalSeconds).toBe(300);
    expect(state.consecutiveQuiet).toBe(2);
    expect(state.lastSurfacedCount).toBe(4);
  });

  it('partial update preserves untouched fields (COALESCE)', async () => {
    const digestT = 1_780_000_500_000;
    await writeCurationState({ lastDigestAtMs: digestT });
    const state = await readCurationState();
    expect(state.lastDigestAtMs).toBe(digestT);
    // interval/quiet/surfaced from the previous test are preserved.
    expect(state.currentIntervalSeconds).toBe(300);
    expect(state.consecutiveQuiet).toBe(2);
    expect(state.lastSurfacedCount).toBe(4);
  });
});
