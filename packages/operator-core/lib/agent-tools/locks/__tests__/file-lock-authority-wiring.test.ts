/**
 * file-lock-authority-wiring — the requesting-side resolver snapshot (fed-reanchor P-060
 * cutover 2). Proves the domain→slug / slug→hive mapping AND the load-bearing N=1 safety
 * contract: an UNMANAGED / unknown coordination domain resolves to `null`, so
 * routeFileLockOp runs the op locally (the single-box passthrough the cutover must
 * preserve). The authority-side adapter is exercised by file-lock-authority-ops.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws1' }));
vi.mock('../in-workspace-txn', () => ({ inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})) }));
vi.mock('../su-lock-store', () => ({ tryAcquire: vi.fn(), tryRelease: vi.fn(), tryFinishHookOperation: vi.fn(), readQueue: vi.fn(), getTxPool: vi.fn() }));
vi.mock('../../../edit-attribution', () => ({ recordEditAttributionStrict: vi.fn() }));

import { loadHarnessRegistry } from '../../../harness-registry';
import { getDomainToHarnessSlug, getHarnessToPotSlug } from '../../../authority/file-lock-routing';
import { _testing, adaptSuLockStore, finishHookOperationAtAuthority } from '../file-lock-authority-wiring';
import { tryAcquire, tryFinishHookOperation } from '../su-lock-store';
import { recordEditAttributionStrict } from '../../../edit-attribution';
import type { FileLockReleaseParams } from '../../../authority/file-lock-authority-ops';

beforeEach(() => {
  _testing.reset();
  (loadHarnessRegistry as Mock).mockReset();
});
afterEach(() => vi.clearAllMocks());

// Non-existent paths: realpathOrSelf falls back to the raw string on BOTH the cache build
// and the lookup, so the mapping stays consistent without a real filesystem.
const REGISTRY = {
  projects: [
    { slug: 'papercup', path: '/fake/papercup' }, // not a Hive member
    { slug: 'sheets', path: '/fake/sheets', hive_slug: 'org-hive' }, // member → org-hive
    { slug: 'org-hive', path: '/fake/org', harness_kind: 'hive' }, // its own Hive home
  ],
};

describe('hook operation authority store adapter', () => {
  const operation = { id: '71d933be-413a-48b0-83af-8856650a917b', deadline: '2026-06-05T00:30:00Z',
    paths: ['a.ts'], intent: 'PreToolUse:Edit', ttlSec: 600, outcome: 'completed' as const };
  const params: FileLockReleaseParams = { owner: 'A', coordinationDomain: '/repo', operation,
    nativeEditProof: { success: true, source: 'claude', tool: 'Edit', paths: ['a.ts'] } };
  const finished = { ok: true as const, released: [] as string[], requestedPaths: ['a.ts'],
    goalRef: null, heldBefore: 0, state: 'completed' as const };

  beforeEach(() => {
    vi.mocked(tryFinishHookOperation).mockReset();
    vi.mocked(recordEditAttributionStrict).mockReset();
    vi.mocked(tryFinishHookOperation).mockResolvedValue(finished);
    vi.mocked(recordEditAttributionStrict).mockResolvedValue(undefined);
  });

  it('attributes a recognized edit after a lost acquire reply even when no paths were released', async () => {
    const r = await finishHookOperationAtAuthority(params);
    expect(r).toMatchObject({ ok: true, operationId: operation.id, attributed: ['a.ts'], released: [] });
    expect(recordEditAttributionStrict).toHaveBeenCalledWith(expect.objectContaining({
      repoRoot: '/repo', files: ['a.ts'], agentId: 'A', dispatchCallId: operation.id,
    }));
  });

  it('reuses the stable ledger key on duplicate completion', async () => {
    await finishHookOperationAtAuthority(params);
    await finishHookOperationAtAuthority(params);
    expect(recordEditAttributionStrict).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordEditAttributionStrict).mock.calls.map(([p]) => p.dispatchCallId)).toEqual([operation.id, operation.id]);
  });

  it('does not attribute a scope refused by the operation store', async () => {
    vi.mocked(tryFinishHookOperation).mockResolvedValue({ ok: false, reason: 'operation_conflict' });
    expect(await finishHookOperationAtAuthority(params)).toMatchObject({ ok: false, reason: 'operation_conflict' });
    expect(recordEditAttributionStrict).not.toHaveBeenCalled();
  });

  it('rejects mismatched paths and unrecognized tools before touching the store', async () => {
    for (const proof of [{ ...params.nativeEditProof!, paths: ['b.ts'] }, { ...params.nativeEditProof!, tool: 'Bash' }]) {
      expect(await finishHookOperationAtAuthority({ ...params, nativeEditProof: proof })).toMatchObject({ ok: false, reason: 'operation_proof_conflict' });
    }
    expect(tryFinishHookOperation).not.toHaveBeenCalled();
    expect(recordEditAttributionStrict).not.toHaveBeenCalled();
  });

  it('rejects noncanonical finish-before-acquire scope without a tombstone or attribution', async () => {
    for (const paths of [['../escape.ts'], ['/absolute.ts'], ['./a.ts'], ['a//b.ts'], ['a.ts', 'a.ts'], ['a\\b.ts']]) {
      const r = await finishHookOperationAtAuthority({ ...params,
        operation: { ...operation, paths }, nativeEditProof: { ...params.nativeEditProof!, paths } });
      expect(r).toMatchObject({ ok: false, reason: 'operation_conflict' });
    }
    expect(tryFinishHookOperation).not.toHaveBeenCalled();
    expect(recordEditAttributionStrict).not.toHaveBeenCalled();
  });

  it('cancellation persists terminal state without inventing edit proof', async () => {
    await finishHookOperationAtAuthority({ ...params, nativeEditProof: undefined,
      operation: { ...operation, outcome: 'cancelled' } });
    expect(tryFinishHookOperation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'cancelled' }));
    expect(recordEditAttributionStrict).not.toHaveBeenCalled();
  });

  it('strict ledger failure rejects completion so the enclosing transaction cannot commit release', async () => {
    vi.mocked(recordEditAttributionStrict).mockRejectedValue(new Error('ledger unavailable'));
    await expect(finishHookOperationAtAuthority(params)).rejects.toThrow('ledger unavailable');
  });

  it('passes fixed operation admission metadata through acquire and reports its refusal faithfully', async () => {
    vi.mocked(tryAcquire).mockResolvedValue({ ok: false, busy: [], reason: 'operation_finished' });
    const r = await adaptSuLockStore().acquire({ owner: 'A', coordinationDomain: '/repo', paths: ['a.ts'],
      intent: 'PreToolUse:Edit', ttlSec: 600, automatic: true, operation });
    expect(r).toMatchObject({ ok: false, reason: 'operation_finished', operationId: operation.id });
    expect(tryAcquire).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation }));
  });
});

describe('file-lock-authority-wiring resolver snapshot', () => {
  it('maps domain→slug from the registry; an unknown/unmanaged domain → null (N=1 passthrough)', async () => {
    (loadHarnessRegistry as Mock).mockResolvedValue(REGISTRY);
    await _testing.refreshResolverSnapshot();

    const domainResolver = getDomainToHarnessSlug();
    expect(domainResolver('/fake/sheets')).toBe('sheets');
    expect(domainResolver('/fake/papercup')).toBe('papercup');
    // The safety contract: a checkout that is NOT a registered managed harness resolves to
    // null → routeFileLockOp runs locally. This is what keeps the live SU fleet's edits on
    // the unchanged local path.
    expect(domainResolver('/some/unmanaged/checkout')).toBeNull();
  });

  it('maps slug→home-Hive: a member points to its Hive, a Hive home points to itself, a non-member is null', async () => {
    (loadHarnessRegistry as Mock).mockResolvedValue(REGISTRY);
    await _testing.refreshResolverSnapshot();

    const hiveResolver = getHarnessToPotSlug();
    expect(hiveResolver('sheets')).toBe('org-hive'); // member → home Hive
    expect(hiveResolver('org-hive')).toBe('org-hive'); // kind:'hive' → itself
    expect(hiveResolver('papercup')).toBeNull(); // non-member → harness-scoped (no Hive)
    expect(hiveResolver('unknown')).toBeNull();
  });

  it('a registry-load failure leaves the maps empty → everything resolves local (fail-safe)', async () => {
    (loadHarnessRegistry as Mock).mockRejectedValue(new Error('PG down'));
    // refreshResolverSnapshot rejects; the boot caller swallows it. The maps stay empty.
    await expect(_testing.refreshResolverSnapshot()).rejects.toThrow('PG down');
    expect(getDomainToHarnessSlug()('/fake/sheets')).toBeNull();
    expect(getHarnessToPotSlug()('sheets')).toBeNull();
  });
});
