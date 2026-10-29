import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Map keyed by `<table>:<workspace_id>` → row payload (JSONB-equivalent).
const store = new Map<string, unknown>();

// Failure injection for the SELECT branch: each queued error rejects ONE SELECT
// (FIFO) before the store answers again — how the pool-starvation retry is exercised.
const selectFailures: Error[] = [];
const encryptedQueryFailures: Array<Error | null> = [];
const DB_ENCRYPTION_KEY = 'sentinel-db-encryption-key-do-not-leak';

// WI-6796 — capture the sync invalidations a write fans out. notifyOperatorStateSync
// lazily `await import('./sync-sse')`s inside a try/catch, so without this mock the
// whole notify leg is silently swallowed and untestable.
const notified: { name: string; args: unknown }[] = [];
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: (name: string, args: unknown) => {
    notified.push({ name, args });
    return Promise.resolve();
  },
}));

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('./db-encryption', () => ({
  ENCRYPTED_TABLES: new Set<string>(['operator_credentials']),
  getDbEncryptionKey: () => DB_ENCRYPTION_KEY,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  function tableFromFragment(s: string): string | null {
    const m = /harness_shared\.([a-zA-Z0-9_]+)/.exec(s);
    return m ? m[1] : null;
  }

  // Tagged template handler. Values: [fragment(table), workspaceId, ...rest].
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    if (/pgp_sym_(?:decrypt|encrypt)/.test(sqlText)) {
      const injected = encryptedQueryFailures.shift();
      if (injected) return Promise.reject(injected);
      return Promise.resolve([]);
    }
    // values[0] is the table fragment (from sql(`harness_shared.X`)),
    // values[1] is the bound workspace_id parameter, values[2+] follow.
    const tableName = (values[0] as { _table?: string })?._table ?? null;
    const ws = typeof values[1] === 'string' ? (values[1] as string) : 'test-ws';
    const key = `${tableName}:${ws}`;

    if (/SELECT payload FROM/.test(sqlText)) {
      const injected = selectFailures.shift();
      if (injected) return Promise.reject(injected);
      const row = store.get(key);
      return Promise.resolve(row !== undefined ? [{ payload: row }] : []);
    }
    if (/INSERT INTO/.test(sqlText)) {
      // Insert order: ${sql(table)}, ${ws}, ${JSON.stringify(payload)}, ${now}.
      // The implementation pre-stringifies before the ::jsonb cast, so
      // the bound value is a JSON string. Parse it to reconstruct the
      // object the caller passed in.
      const raw = values[2];
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      store.set(key, payload);
      return Promise.resolve(/RETURNING workspace_id/.test(sqlText) ? [{ workspace_id: ws }] : []);
    }
    return Promise.resolve([]);
  }

  // sql(`harness_shared.X`) returns a fragment object. sql`...` runs the
  // tagged template. Differentiate by the type of the first arg.
  function sqlCallable(strs: TemplateStringsArray | string, ..._rest: unknown[]): unknown {
    if (typeof strs === 'string') {
      return { _table: tableFromFragment(strs) };
    }
    return tagged(strs as TemplateStringsArray, ..._rest);
  }
  const wrapped = sqlCallable as unknown as typeof tagged;
  (wrapped as unknown as { json: <T>(v: T) => T }).json = (v) => v;
  (wrapped as unknown as { begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> }).begin =
    async <T>(cb: (tx: unknown) => Promise<T>) => cb(wrapped);

  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql: wrapped, db: {} }),
  };
});

import {
  isRetriablePgReadError,
  readOperatorState,
  updateOperatorState,
  writeOperatorState,
} from './operator-state-pg';
import { readCredentials } from './credentials';

function encryptedPostgresFailure(): Error {
  return Object.assign(new Error('Wrong key or corrupt data'), {
    code: '39000',
    severity_local: 'ERROR',
    where: 'SQL statement used bound key ' + DB_ENCRYPTION_KEY,
  });
}

beforeEach(() => {
  store.clear();
  notified.length = 0;
  selectFailures.length = 0;
  encryptedQueryFailures.length = 0;
});
afterEach(() => {
  store.clear();
  notified.length = 0;
  selectFailures.length = 0;
  encryptedQueryFailures.length = 0;
});

/**
 * 2026-09-05 22:30Z — the papercusp green-checkpoint run judging 92e07dd5 reached its
 * decision stage and then died in `readOperatorState` on
 * `PostgresError: query_wait_timeout` (FATAL, SQLSTATE 08P01: pgbouncer gave up waiting
 * for a server slot, so the SELECT never executed). One transient pooler wait cost a
 * 60-minute suite its verdict. A read-only SELECT that never reached the server is safe
 * to re-issue, so the read path retries that shape (and CONNECTION_CLOSED) a bounded
 * number of times; anything else still surfaces on the first throw.
 */
describe('readOperatorState retries pgbouncer pool starvation (2026-09-05 gate crash)', () => {
  function poolStarvation(): Error {
    return Object.assign(new Error('query_wait_timeout'), { code: '08P01', severity_local: 'FATAL' });
  }

  it('classifies the pooler shapes as retriable for a read and nothing else', () => {
    expect(isRetriablePgReadError(poolStarvation())).toBe(true);
    expect(isRetriablePgReadError(Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'), { code: 'CONNECTION_CLOSED' }))).toBe(true);
    expect(isRetriablePgReadError(Object.assign(new Error('connect timed out'), { code: 'CONNECT_TIMEOUT' }))).toBe(true);
    expect(isRetriablePgReadError(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBe(false);
    expect(isRetriablePgReadError(new TypeError('boom'))).toBe(false);
    expect(isRetriablePgReadError(null)).toBe(false);
  });

  it('re-issues the SELECT after a query_wait_timeout and returns the row', async () => {
    store.set('operator_first_run:test-ws', { retried: true });
    selectFailures.push(poolStarvation());
    const got = await readOperatorState<{ retried?: boolean }>('operator_first_run');
    expect(got?.retried).toBe(true);
    expect(selectFailures).toHaveLength(0);
  });

  it('does not retry a non-transient error', async () => {
    const boom = Object.assign(new Error('relation "harness_shared.operator_first_run" does not exist'), { code: '42P01' });
    selectFailures.push(boom);
    await expect(readOperatorState('operator_first_run')).rejects.toBe(boom);
  });

  it('gives up after the bounded retries instead of looping forever', async () => {
    selectFailures.push(poolStarvation(), poolStarvation(), poolStarvation());
    await expect(readOperatorState('operator_first_run')).rejects.toThrow(/query_wait_timeout/);
    // retries:2 ⇒ 3 tries total ⇒ all three injected failures were consumed.
    expect(selectFailures).toHaveLength(0);
  }, 10_000);
});

describe('readOperatorState / writeOperatorState (unencrypted path)', () => {
  it('returns null when no row exists', async () => {
    expect(await readOperatorState('operator_first_run')).toBeNull();
  });

  it('round-trips a payload through write→read', async () => {
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-01', shownToUserIds: ['u1'] });
    const got = await readOperatorState<{ shownToUserIds: string[] }>('operator_first_run');
    expect(got?.shownToUserIds).toEqual(['u1']);
  });

  it('overwrites the row on second write', async () => {
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-01', shownToUserIds: ['u1'] });
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-02', shownToUserIds: ['u2'] });
    const got = await readOperatorState<{ shownToUserIds: string[] }>('operator_first_run');
    expect(got?.shownToUserIds).toEqual(['u2']);
  });

  it('isolates rows by table name', async () => {
    await writeOperatorState('operator_first_run', { a: 1 });
    await writeOperatorState('operator_budget', { b: 2 });
    expect(await readOperatorState('operator_first_run')).toEqual({ a: 1 });
    expect(await readOperatorState('operator_budget')).toEqual({ b: 2 });
  });

  it('readOperatorState honors workspace override', async () => {
    // The mock's activeWorkspaceId is fixed to 'test-ws'; passing a different
    // override should query that key instead. Pre-populate manually.
    store.set('operator_first_run:other-ws', { override: true });
    const got = await readOperatorState<{ override?: boolean }>('operator_first_run', 'other-ws');
    expect(got?.override).toBe(true);
  });
});

describe('encrypted operator-state database diagnostics', () => {
  it.each(['read', 'write', 'update'] as const)(
    'redacts pgcrypto parameters and retains managed context on %s',
    async (operation) => {
      const original = encryptedPostgresFailure();
      encryptedQueryFailures.push(original);

      let thrown: unknown;
      try {
        if (operation === 'read') await readCredentials();
        else if (operation === 'write') {
          await writeOperatorState('operator_credentials', { openai_api_key: 'test-only-value' });
        } else {
          await updateOperatorState('operator_credentials', {}, (current) => current);
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const safeError = thrown as Error & {
        code?: string;
        operatorStateContext?: { operation: string; table: string; workspaceId: string };
      };
      const diagnosticSurface = Object.getOwnPropertyNames(safeError)
        .map((name) => String((safeError as unknown as Record<string, unknown>)[name]))
        .join('\n');

      expect(safeError).not.toBe(original);
      expect(diagnosticSurface).not.toContain(DB_ENCRYPTION_KEY);
      expect(diagnosticSurface).not.toContain('Wrong key or corrupt data');
      expect(safeError).not.toHaveProperty('where');
      expect(safeError).not.toHaveProperty('cause');
      expect(safeError.name).toBe('OperatorStateDatabaseError');
      expect(safeError.message).toContain('operator_credentials');
      expect(safeError.message).toContain('test-ws');
      expect(safeError).toMatchObject({
        code: '39000',
        operatorStateContext: { operation, table: 'operator_credentials', workspaceId: 'test-ws' },
      });
    },
  );

  it('redacts pgcrypto encryption failures during updateOperatorState', async () => {
    const original = encryptedPostgresFailure();
    encryptedQueryFailures.push(null, original); // decrypt succeeds; the encrypt query fails

    let thrown: unknown;
    try {
      await updateOperatorState('operator_credentials', {}, (current) => current);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const safeError = thrown as Error & {
      code?: string;
      operatorStateContext?: { operation: string; table: string; workspaceId: string };
    };
    const diagnosticSurface = Object.getOwnPropertyNames(safeError)
      .map((name) => String((safeError as unknown as Record<string, unknown>)[name]))
      .join('\n');
    expect(safeError).not.toBe(original);
    expect(diagnosticSurface).not.toContain(DB_ENCRYPTION_KEY);
    expect(diagnosticSurface).not.toContain('Wrong key or corrupt data');
    expect(safeError).not.toHaveProperty('where');
    expect(safeError).not.toHaveProperty('cause');
    expect(safeError).toMatchObject({
      code: '39000',
      operatorStateContext: { operation: 'update', table: 'operator_credentials', workspaceId: 'test-ws' },
    });
  });

  it('preserves a non-PostgreSQL failure identity', async () => {
    const original = new Error('credential read failed before PostgreSQL');
    encryptedQueryFailures.push(original);

    await expect(readCredentials()).rejects.toBe(original);
  });
});

/**
 * WI-6796 — the owner reported "the accounts tab stopped updating".
 *
 * The Accounts tab subscribes to the `accounts.pool` sync query, which resolves
 * accountStatus() straight off harness_shared.operator_account_pool. That table is
 * rewritten continuously by the inference gateway's window projector as it observes
 * each response's anthropic-ratelimit-unified-* headers — that stream IS the tab's
 * live data. But operator_account_pool was absent from OPERATOR_STATE_SYNC_NAMES, so
 * notifyOperatorStateSync early-returned on EVERY pool write and a left-open tab was
 * never told the numbers moved. It refreshed only on the handful of explicit
 * notifySyncInvalidate('accounts.pool') action callsites, or on remount.
 *
 * These tests pin the fan-out, in BOTH directions: the pool must notify, and a table
 * with no UI consumer must stay silent (the map is an allow-list, not a default-on).
 */
describe('writeOperatorState → sync invalidation fan-out (WI-6796)', () => {
  it('a pool write invalidates accounts.pool — the Accounts tab live-updates on a gateway usage write', async () => {
    await writeOperatorState('operator_account_pool', { accounts: [{ id: 'acct-1' }] });
    expect(notified.map((n) => n.name)).toEqual(['accounts.pool']);
  });

  it('the sibling override write still invalidates BOTH its queries (unchanged by this fix)', async () => {
    await writeOperatorState('operator_account_override', { forcedAccounts: ['acct-1'] });
    expect(notified.map((n) => n.name)).toEqual(['accounts.sessionOverride', 'accounts.pool']);
  });

  it('an UNMAPPED table notifies nothing — the map stays an allow-list, not default-on', async () => {
    await writeOperatorState('operator_first_run', { shownAt: '2026-08-02' });
    expect(notified).toEqual([]);
  });
});
