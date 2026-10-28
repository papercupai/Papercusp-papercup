/**
 * P-006 / R-5 (change-provenance-and-admission-throughput-2026-10-27): the native edit
 * hook's own session id rides native_edit_proof.sessionId and lands on every edit-ledger
 * row locks:release writes — after a release, before a restricted owner's release, and
 * on a retained (attest-only) hold. The arg schema must keep the field, not strip it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./coordination-domain', () => ({
  resolveExplicitFileLockDomain: vi.fn((requested: string | undefined, fallback: string) => requested ?? fallback),
  candidateResourceLockDomains: vi.fn(() => ['dom']),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({
  tryRelease: vi.fn(),
  readResourceLockStatus: vi.fn(),
  releaseGranular: vi.fn(),
  releaseAllGranularForOwner: vi.fn(),
  releaseAllResourcesForOwner: vi.fn(),
  readQueue: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  ensureBootstrap: vi.fn(),
}));
vi.mock('./resource-broadcast', () => ({ broadcastResourceBackUp: vi.fn() }));
vi.mock('../../authority/file-lock-routing', () => ({ routeFileLockOp: vi.fn() }));
vi.mock('../../authority/lock-event-stream', () => ({ recordLockEvent: vi.fn() }));
vi.mock('../../edit-attribution', () => ({
  recordEditAttribution: vi.fn(async () => {}),
  recordEditAttributionStrict: vi.fn(async () => {}),
}));
vi.mock('../../personal-vault/git-sync-hold', () => ({ recordRestrictedEditBeforeRelease: vi.fn(async () => false) }));
vi.mock('./file-lock-authority-wiring', () => ({ routeHookOperationFinish: vi.fn(async () => ({ ok: true })) }));

import { routeFileLockOp } from '../../authority/file-lock-routing';
import { readQueue } from './su-lock-store';
import { recordEditAttribution, recordEditAttributionStrict } from '../../edit-attribution';
import { recordRestrictedEditBeforeRelease } from '../../personal-vault/git-sync-hold';

const routeM = vi.mocked(routeFileLockOp);
const tool = (await import('./release')).default;
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never);

const LOCK = '66666666-6666-4666-8666-666666666666';
const proof = { success: true, source: 'claude', tool: 'Edit', paths: ['a.ts'], sessionId: 'native-sess-1' } as const;

beforeEach(() => {
  vi.mocked(recordEditAttribution).mockClear();
  vi.mocked(recordEditAttributionStrict).mockClear();
  vi.mocked(recordRestrictedEditBeforeRelease).mockReset().mockResolvedValue(false);
});

describe('native_edit_proof.sessionId reaches the edit ledger (R-5)', () => {
  it('survives the locks:release arg schema', () => {
    const parsed = tool.args.parse({ lock_id: LOCK, native_edit_proof: proof });
    expect(parsed.native_edit_proof?.sessionId).toBe('native-sess-1');
  });

  it('stamps the session on the attribution written after a release', async () => {
    mockResolvedTyped(routeM, { value: { ok: true, released: ['a.ts'] }, via: 'local-authority' });
    await call({ lock_id: LOCK, native_edit_proof: proof });
    expect(recordEditAttribution).toHaveBeenCalledWith(expect.objectContaining({ files: ['a.ts'], sessionId: 'native-sess-1' }));
  });

  it('stamps the session on a restricted owner’s pre-release row', async () => {
    vi.mocked(recordRestrictedEditBeforeRelease).mockResolvedValueOnce(true);
    mockResolvedTyped(routeM, { value: { ok: true, released: ['a.ts'] }, via: 'local-authority' });
    await call({ lock_id: LOCK, paths: ['a.ts'], native_edit_proof: proof });
    expect(recordRestrictedEditBeforeRelease).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-sess-1' }));
  });

  it('stamps the session on a retained (attest-only) hold', async () => {
    vi.mocked(readQueue).mockResolvedValueOnce({
      active_locks: [{ owner: 'me', coordination_domain: 'dom', path: 'a.ts' }],
    } as never);
    await call({ retain: true, native_edit_proof: proof });
    expect(recordEditAttributionStrict).toHaveBeenCalledWith(expect.objectContaining({ files: ['a.ts'], sessionId: 'native-sess-1' }));
  });

  it('still attributes a proof from a hook that sends no session id', async () => {
    mockResolvedTyped(routeM, { value: { ok: true, released: ['a.ts'] }, via: 'local-authority' });
    const { sessionId: _omit, ...legacy } = proof;
    await call({ lock_id: LOCK, native_edit_proof: legacy });
    expect(recordEditAttribution).toHaveBeenCalledWith(expect.objectContaining({ files: ['a.ts'], sessionId: undefined }));
  });
});
