/**
 * acquire_granular.test.ts — the locks:acquire_granular HANDLER (tryAcquireGranular/
 * validatePath mocked; txn wrapper runs the callback). Pins: a non-root path is validated
 * (a bad path → { ok:false, error }, no store call); the harness root "" SKIPS validation
 * (it's a legal node); a conflict returns the conflict list; a success returns the full
 * lock-set + ISO expiry. A regression that validates "" away, or reports a conflict as
 * success, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire_granular.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryAcquireGranular: vi.fn(), validatePath: vi.fn() }));

import { tryAcquireGranular, validatePath } from './su-lock-store';
import { inWorkspaceTxn } from './in-workspace-txn';
const acqM = vi.mocked(tryAcquireGranular);
const validateM = vi.mocked(validatePath);
const txnM = vi.mocked(inWorkspaceTxn);
const tool = (await import('./acquire_granular')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler({ mode: 'X', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  validateM.mockReset(); // clearAllMocks keeps implementations — reset the throw from the invalid-path test
  txnM.mockReset();
  txnM.mockImplementation(async (_domain, _owner, fn) => fn({} as never));
  acqM.mockResolvedValue({ ok: true, lock_id: 'L1', locks: ['', 'src'], expires_ts: new Date('2026-02-01T00:00:00Z') } as never);
});

afterEach(() => vi.useRealTimers());

describe('locks:acquire_granular handler', () => {
  it('rejects an invalid non-root path before touching the store', async () => {
    validateM.mockImplementation(() => { throw new Error('path traversal not allowed'); });
    const b = body(await call({ path: '../etc/passwd' }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/traversal/);
    expect(acqM).not.toHaveBeenCalled();
  });

  it('allows the harness root "" (skips path validation) and returns the lock-set', async () => {
    const b = body(await call({ path: '' }));
    expect(validateM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, lock_id: 'L1', mode: 'X', locks: ['', 'src'], expires_ts: '2026-02-01T00:00:00.000Z' });
  });

  it('returns the conflict list when the lock-set cannot be granted', async () => {
    acqM.mockResolvedValue({ ok: false, reason: 'conflict', conflicts: [{ node: 'src', owner: 'other' }] } as never);
    const b = body(await call({ path: 'src', mode: 'X' }));
    expect(b).toMatchObject({ ok: false, reason: 'conflict', conflicts: [{ node: 'src', owner: 'other' }] });
  });

  it('retries a transient workspace transaction timeout with a fresh transaction', async () => {
    vi.useFakeTimers();
    const contended = Object.assign(new Error('workspace contended (pg 57014: lock/statement timeout)'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    let attempts = 0;
    txnM.mockImplementation(async (_domain, _owner, fn) => {
      attempts += 1;
      if (attempts === 1) throw contended;
      return fn({} as never) as never;
    });

    const pending = call({ path: 'src', mode: 'X' });
    await vi.runAllTimersAsync();
    const b = body(await pending);

    expect(attempts).toBe(2);
    expect(acqM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, lock_id: 'L1' });
  });

  it('returns structured unknown contention after bounded retries are exhausted', async () => {
    vi.useFakeTimers();
    const contended = Object.assign(new Error('workspace contended (pg 57014: lock/statement timeout)'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    txnM.mockRejectedValue(contended);

    const pending = call({ path: 'src', mode: 'X' });
    await vi.runAllTimersAsync();
    const b = body(await pending);

    expect(txnM).toHaveBeenCalledTimes(4);
    expect(acqM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      reason: 'workspace_contended',
      transient: true,
      holder: 'unknown',
      pgCode: '57014',
    });
    expect(b).not.toHaveProperty('conflicts');
  });
});
