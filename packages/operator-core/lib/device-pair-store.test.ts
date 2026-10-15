/**
 * Tests for device-pair-store. Mocks @papercusp/db-org so the mint/consume
 * contract is exercised without a live database.
 *
 * The SUT migrated from raw `sql\`\`` to Drizzle's `getOrgPg().db` query builder,
 * so the mock provides a chainable fake `db`: `select`/`update…returning`
 * resolve queued rows, `insert` captures its `.values()` payload, and ops are
 * recorded for behavioral assertions. Real `generated` is kept (importActual)
 * so drizzle's `eq`/`and`/`count` resolve real columns. The old raw-SQL-string
 * assertions tested an implementation that no longer exists and were dropped.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Rows returned by `db.select(...).from(...)` (the GC count), in order.
const selectRows: unknown[][] = [];
// Rows returned by `db.update(...).set(...).where(...).returning(...)`.
const updateRows: unknown[][] = [];
const ops: string[] = [];
let lastInsert: Record<string, unknown> | null = null;

function thenable(result: unknown): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return () => thenable(result);
    },
  });
}

const fakeDb = {
  insert: () => {
    ops.push('insert');
    return {
      values: (v: Record<string, unknown>) => {
        lastInsert = v;
        return thenable([]);
      },
    };
  },
  delete: () => {
    ops.push('delete');
    return thenable([]);
  },
  select: () => thenable(selectRows.shift() ?? []),
  update: () => {
    ops.push('update');
    return new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => void) => res(updateRows.shift() ?? []);
        return () => (fakeDb.update as any)._chain();
      },
    });
  },
};
// returning()/set()/where() all continue the same thenable chain
(fakeDb.update as any)._chain = () =>
  new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(updateRows.shift() ?? []);
      return () => (fakeDb.update as any)._chain();
    },
  });

vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as object), // real `generated` so eq()/and()/count() resolve real columns
  getOrgPg: () => ({ db: fakeDb }),
}));

import { mintPairToken, consumePairToken, newDeviceId } from './device-pair-store';

beforeEach(() => {
  selectRows.length = 0;
  updateRows.length = 0;
  ops.length = 0;
  lastInsert = null;
});

describe('mintPairToken', () => {
  it('inserts a fresh row and returns token + expiresAt', async () => {
    selectRows.push([{ n: 0 }]); // GC count
    const before = Date.now();
    const { pairToken, expiresAt } = await mintPairToken({
      workspaceId: 'ws-1',
      desktopHost: 'localhost:3055',
      userEmail: 'a@b.com',
    });

    expect(pairToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pairToken.length).toBeGreaterThan(20);
    const ttlMs = Number(process.env.MOBILE_PAIR_TOKEN_TTL_SECONDS ?? 60 * 60) * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ttlMs);

    expect(ops).toContain('insert');
    expect(lastInsert).toMatchObject({
      pairToken,
      workspaceId: 'ws-1',
      userEmail: 'a@b.com',
      desktopHost: 'localhost:3055',
      expiresAtMs: expiresAt,
      consumed: false,
    });
  });

  it('passes null when userEmail is omitted', async () => {
    selectRows.push([{ n: 0 }]);
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(lastInsert!.userEmail).toBeNull();
  });

  it('triggers opportunistic GC sweep when row count > 1000', async () => {
    selectRows.push([{ n: 1500 }]);
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(ops).toContain('delete');
  });

  it('skips GC when row count <= 1000', async () => {
    selectRows.push([{ n: 999 }]);
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(ops).not.toContain('delete');
  });

  it('mints unique tokens', async () => {
    selectRows.push([{ n: 0 }], [{ n: 0 }]);
    const a = (await mintPairToken({ workspaceId: 'w', desktopHost: 'h' })).pairToken;
    const b = (await mintPairToken({ workspaceId: 'w', desktopHost: 'h' })).pairToken;
    expect(a).not.toBe(b);
  });
});

describe('consumePairToken', () => {
  it('returns parsed PendingPair on a successful UPDATE … RETURNING', async () => {
    updateRows.push([
      {
        pairToken: 'abc',
        workspaceId: 'ws-1',
        userEmail: 'a@b.com',
        desktopHost: 'h',
        expiresAtMs: 9999999999999,
      },
    ]);
    const out = await consumePairToken('abc');
    expect(out).not.toBeNull();
    expect(out!.workspaceId).toBe('ws-1');
    expect(out!.userEmail).toBe('a@b.com');
    expect(out!.desktopHost).toBe('h');
    expect(ops).toContain('update');
  });

  it('returns null when no row matched (unknown / expired / already consumed)', async () => {
    updateRows.push([]);
    expect(await consumePairToken('missing')).toBeNull();
  });

  it('handles null user_email by returning undefined', async () => {
    updateRows.push([
      { pairToken: 'x', workspaceId: 'w', userEmail: null, desktopHost: 'h', expiresAtMs: 9999999999999 },
    ]);
    const out = await consumePairToken('x');
    expect(out!.userEmail).toBeUndefined();
  });
});

describe('newDeviceId', () => {
  it('returns unique UUIDs', () => {
    const a = newDeviceId();
    const b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
