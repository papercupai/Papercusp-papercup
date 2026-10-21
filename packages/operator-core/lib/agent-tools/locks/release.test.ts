/**
 * release.test.ts — locks:release handler selected-list bulk support.
 *
 * Pins that selected lock releases use the shared bulk contract, including n=1.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mockRejectedTyped, mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { ActiveLockRow } from './su-lock-store';
import { resolveExternalPathLockIdentity } from './external-path';

/** The release outcome release.ts decodes — see its `ReleaseOutcome`. */
type ReleaseOutcomeShape = { released: string[]; heldBefore: number | null };

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
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
  // EI-20405390083792304 root fix: the cross-domain resolve reads the queue.
  readQueue: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  ensureBootstrap: vi.fn(),
}));
vi.mock('./resource-broadcast', () => ({ broadcastResourceBackUp: vi.fn() }));
vi.mock('../../authority/file-lock-routing', () => ({ routeFileLockOp: vi.fn() }));
vi.mock('../../authority/file-lock-authority-ops', async () => ({
  ...(await vi.importActual<typeof import('../../authority/file-lock-authority-ops')>('../../authority/file-lock-authority-ops')),
  FILE_LOCK_OP_KINDS: { release: 'release' },
  isNativeEditProofForPaths: vi.fn((proof: unknown, released: string[]) => {
    if (!proof || typeof proof !== 'object') return false;
    const value = proof as { success?: unknown; source?: unknown; tool?: unknown; paths?: unknown };
    return value.success === true
      && value.source === 'claude'
      && value.tool === 'Edit'
      && Array.isArray(value.paths)
      && value.paths.length === released.length
      && value.paths.every((path) => released.includes(path as string));
  }),
  // Real (not stubbed) fan-out so WI-1550 coverage below can assert on the
  // resulting recordLockEvent calls, not just that some mock fired.
  emitReleaseLockEvents: vi.fn((emit: (e: unknown) => void, p: { scope: string; owner: string; released: string[]; ts: number; publishedSha?: string | null }) => {
    for (const path of p.released) {
      emit({ kind: 'release', scope: p.scope, path, owner: p.owner, ts: p.ts, ...(p.publishedSha ? { publishedSha: p.publishedSha } : {}) });
    }
  }),
}));
vi.mock('../../authority/lock-event-stream', () => ({ recordLockEvent: vi.fn() }));
vi.mock('../../edit-attribution', () => ({
  recordEditAttribution: vi.fn(async () => {}),
  recordEditAttributionStrict: vi.fn(async () => {}),
}));
// P-014: the pre-release restricted-edit hold. Default: an unrestricted owner (nothing written).
vi.mock('../../personal-vault/git-sync-hold', () => ({ recordRestrictedEditBeforeRelease: vi.fn(async () => false) }));
vi.mock('./file-lock-authority-wiring', () => ({ routeHookOperationFinish: vi.fn(async () => ({ ok: true })) }));

import { routeFileLockOp } from '../../authority/file-lock-routing';
import { recordLockEvent } from '../../authority/lock-event-stream';
import {
  readResourceLockStatus,
  releaseAllGranularForOwner,
  releaseAllResourcesForOwner,
  releaseGranular,
  readQueue,
  tryRelease,
} from './su-lock-store';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { recordEditAttribution, recordEditAttributionStrict } from '../../edit-attribution';
import { recordRestrictedEditBeforeRelease } from '../../personal-vault/git-sync-hold';
import { routeHookOperationFinish } from './file-lock-authority-wiring';
import { resolveAgentIdentity } from '../coordination/identity';

const routeM = vi.mocked(routeFileLockOp);
const releaseGranularM = vi.mocked(releaseGranular);
const readResourceStatusM = vi.mocked(readResourceLockStatus);
const releaseAllGranularM = vi.mocked(releaseAllGranularForOwner);
const releaseResourcesM = vi.mocked(releaseAllResourcesForOwner);
const readQueueM = vi.mocked(readQueue);
const recordEventM = vi.mocked(recordLockEvent);
const resolveDomainM = vi.mocked(resolveExplicitFileLockDomain);
const recordAttributionM = vi.mocked(recordEditAttribution);
const tool = (await import('./release')).default;

type Out = { data?: any; content?: Array<{ text: string }> };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

beforeEach(() => {
  vi.clearAllMocks();
  routeM.mockImplementation(async (_domain, op) => ({
    value: { released: [`released:${(op.remote?.payload as { lockId?: string } | undefined)?.lockId ?? 'all'}`] },
  }) as never);
  releaseGranularM.mockResolvedValue({ released: 0 });
  releaseAllGranularM.mockResolvedValue({ released: 0 });
  releaseResourcesM.mockResolvedValue({ released: 0, exclusiveResources: [], waiters: {} } as never);
  readResourceStatusM.mockResolvedValue({ status: 'missing' });
  mockResolvedTyped(readQueueM, { active_locks: [], waiting: [] });
});

/**
 * EI-20405390083792304 — the ROOT fix. A file lock's coordination domain is the
 * physical repo root of the EDITED file, which the PreToolUse hook sends
 * explicitly; an agent's own bare `locks:release` resolves
 * `<workspace_root>/papercusp` instead. When those differ the release matched
 * zero rows and still answered `ok:true, released:[]` — indistinguishable from
 * "you held nothing" — so the holder believed it was clear while the lock sat
 * until TTL and peers stayed blocked (proven live 2026-08-14).
 */
describe('locks:release cross-domain fallback (EI-20405390083792304)', () => {
  const LOCK = '33333333-3333-3333-3333-333333333333';
  // Opaque domain strings. Deliberately NOT a real home path: a hardcoded
  // /home/<user>/… in shipped source reds the identity-lint gate leg.
  const HIVE = '/hives/sidestage';

  type ReleaseRoute = { value: ReleaseOutcomeShape; via: string; scope?: string };
  /**
   * `routeFileLockOp` is generic in its op's return type, so vi.mocked() cannot
   * infer a concrete impl signature. ONE assertion at this seam keeps every call
   * site below fully typed — rather than an `as never` per fixture, which is what
   * the lint:mock-cast-escape ratchet exists to prevent.
   */
  const routeByDomain = (byDomain: (domain: string) => ReleaseRoute): void => {
    routeM.mockImplementation(
      ((domain: string) => Promise.resolve(byDomain(domain))) as unknown as typeof routeFileLockOp,
    );
  };

  /** A COMPLETE ActiveLockRow, so a new required column fails here at compile time. */
  const activeLock = (
    lockId: string,
    domain: string,
    path = 'f.ts',
    owner = 'me',
  ): ActiveLockRow => ({
    lock_id: lockId,
    path,
    owner,
    owner_label: 'Me',
    goal_ref: null,
    intent: 'test',
    acquired_ts: new Date(0),
    expires_ts: new Date(Date.now() + 60_000),
    coordination_domain: domain,
  });

  const heldIn = (...rows: ActiveLockRow[]): void => {
    mockResolvedTyped(readQueueM, { active_locks: rows, waiting: [] });
  };

  /** Frees nothing in `dom` (the caller's domain), everything in `HIVE`. */
  const onlyHiveHolds = (paths: string[]) => {
    routeByDomain((domain) => domain === HIVE
      ? { value: { released: paths, heldBefore: paths.length }, via: 'local-authority' }
      : { value: { released: [], heldBefore: 0 }, via: 'local-authority' });
  };

  it('releases a lock held in another domain instead of silently no-opping', async () => {
    onlyHiveHolds(['app.module.ts']);
    heldIn(activeLock(LOCK, HIVE));

    const b = body(await call({ lock_id: LOCK }));
    expect(b.results[0].released).toEqual(['app.module.ts']);
    expect(b.results[0].cross_domain_released).toEqual([
      { coordination_domain: HIVE, released: ['app.module.ts'] },
    ]);
    // It must route to the domain that actually holds the lock, not the caller's.
    expect(routeM.mock.calls.map((c) => c[0])).toEqual(['dom', HIVE]);
  });

  it('does NOT pay for the cross-domain read when the caller\'s own domain frees the lock', async () => {
    // The hot path must stay exactly as cheap as before the fix.
    await call({ lock_id: LOCK });
    expect(readQueueM).not.toHaveBeenCalled();
    expect(routeM).toHaveBeenCalledTimes(1);
  });

  it('all_mine sweeps every domain the owner holds locks in', async () => {
    const OTHER = '/hives/other';
    routeByDomain((domain) => domain === 'dom'
      ? { value: { released: ['dom/f.ts'], heldBefore: 1 }, via: 'local-authority' }
      : { value: { released: [`${domain}/f.ts`], heldBefore: 1 }, via: 'local-authority' });
    heldIn(activeLock('a', HIVE), activeLock('b', OTHER), activeLock('c', HIVE));
    releaseAllGranularM.mockImplementation(async (_tx, domain) => ({
      released: domain === 'dom' ? 6 : 0,
    }));

    const b = body(await call({ all_mine: true }));
    expect(b.released).toEqual(['dom/f.ts', `${HIVE}/f.ts`, `${OTHER}/f.ts`]);
    expect(b.granular_released).toBe(6);
    expect(b.held_before).toBe(9);
    // Each domain is visited once even when the primary domain released rows.
    // This pins the session-death case that originally stranded a second domain.
    expect(routeM.mock.calls.map((c) => c[0])).toEqual(['dom', HIVE, OTHER]);
    expect(releaseAllGranularM.mock.calls.map((c) => c[1])).toEqual(['dom', HIVE, OTHER]);
  });

  it('releases a granular UUID through the generic release surface', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    releaseGranularM.mockResolvedValue({ released: 6 });

    const b = body(await call({ lock_id: LOCK }));

    expect(releaseGranularM).toHaveBeenCalledWith({}, 'dom', 'me', LOCK);
    expect(b.results[0]).toMatchObject({
      ok: true,
      lock_id: LOCK,
      released: [],
      granular_released: 6,
      held_before: 6,
    });
  });

  it('does not turn a path-filtered classic release into an all-or-nothing granular release', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    releaseGranularM.mockResolvedValue({ released: 6 });

    await call({ lock_id: LOCK, paths: ['only-this.ts'] });

    expect(releaseGranularM).not.toHaveBeenCalled();
  });

  it('reports an honest empty release when the owner holds nothing anywhere', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    const b = body(await call({ all_mine: true }));
    expect(b.released).toEqual([]);
    expect(b.held_before).toBe(0);
    expect(b.cross_domain_released).toBeUndefined();
  });

  it('never fails the caller\'s release because the cross-domain lookup faulted', async () => {
    routeByDomain(() => ({ value: { released: [], heldBefore: 0 }, via: 'local-authority' }));
    mockRejectedTyped(readQueueM, new Error('pool exhausted'));
    const b = body(await call({ all_mine: true }));
    expect(b.ok).toBe(true);
    expect(b.released).toEqual([]);
  });

  it('keeps an unknown heldBefore unknown rather than laundering it into a number', async () => {
    // A peer authority that does not report the count must not be summed into 0.
    routeByDomain((domain) => domain === HIVE
      ? { value: { released: ['x.ts'], heldBefore: null }, via: 'local-authority' }
      : { value: { released: [], heldBefore: 0 }, via: 'local-authority' });
    heldIn(activeLock(LOCK, HIVE));
    const b = body(await call({ lock_id: LOCK }));
    expect(b.results[0].held_before).toBeNull();
  });

  it('resolves path-only releases across domains, groups paths by lock_id, and keeps owner scope', async () => {
    const OTHER = '/hives/other';
    const OTHER_LOCK = '44444444-4444-4444-4444-444444444444';
    routeByDomain((domain) => {
      if (domain === HIVE) return { value: { released: ['a.ts'], heldBefore: 1 }, via: 'local-authority' };
      if (domain === OTHER) return { value: { released: ['c.ts'], heldBefore: 1 }, via: 'local-authority' };
      return { value: { released: [], heldBefore: 0 }, via: 'local-authority' };
    });
    heldIn(
      activeLock(LOCK, HIVE, 'a.ts'),
      activeLock(LOCK, HIVE, 'not-requested.ts'),
      activeLock(OTHER_LOCK, OTHER, 'c.ts'),
      activeLock('55555555-5555-5555-5555-555555555555', HIVE, 'c.ts', 'peer'),
    );

    const b = body(await call({ paths: ['a.ts', 'c.ts'] }));

    expect(readQueueM.mock.calls[0]?.[1]).toMatchObject({
      coordinationDomain: null,
      owner: 'me',
      paths: ['a.ts', 'c.ts'],
    });
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        {
          ok: true,
          lock_id: LOCK,
          requested_paths: ['a.ts'],
          released: ['a.ts'],
          cross_domain_released: [{ coordination_domain: HIVE, released: ['a.ts'] }],
        },
        {
          ok: true,
          lock_id: OTHER_LOCK,
          requested_paths: ['c.ts'],
          released: ['c.ts'],
          cross_domain_released: [{ coordination_domain: OTHER, released: ['c.ts'] }],
        },
      ],
    });
    expect(routeM.mock.calls.map((call) => call[0])).toEqual(['dom', HIVE, 'dom', OTHER]);
  });

  it('normalizes an absolute home path before selecting the caller-owned external lock', async () => {
    const absolute = join(homedir(), '.papercusp-release-test', 'fixture.json');
    const identity = resolveExternalPathLockIdentity(absolute);
    expect(identity.coordinationDomain).toBeUndefined();
    routeByDomain((domain) => domain === HIVE
      ? { value: { released: [identity.path], heldBefore: 1 }, via: 'local-authority' }
      : { value: { released: [], heldBefore: 0 }, via: 'local-authority' });
    heldIn(activeLock(LOCK, HIVE, identity.path));

    const b = body(await call({ paths: [absolute] }));

    expect(readQueueM.mock.calls[0]?.[1]).toMatchObject({
      coordinationDomain: null,
      owner: 'me',
      paths: [identity.path],
    });
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{
        ok: true,
        lock_id: LOCK,
        requested_paths: [identity.path],
        released: [identity.path],
        cross_domain_released: [{ coordination_domain: HIVE, released: [identity.path] }],
      }],
    });
  });

  it('rejects absolute paths outside home/runtime instead of returning an empty successful selection', async () => {
    const b = body(await call({ paths: ['/etc/hosts'] }));

    expect(b).toMatchObject({
      ok: false,
      error: expect.stringContaining('locks:release could not resolve path selector'),
    });
    expect(readQueueM).not.toHaveBeenCalled();
    expect(routeM).not.toHaveBeenCalled();
  });

  it('returns an empty keyed envelope when no requested path is held by the caller', async () => {
    heldIn(activeLock(LOCK, HIVE, 'other.ts'));

    const b = body(await call({ paths: ['missing.ts'] }));

    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 0 }, results: [] });
    expect(routeM).not.toHaveBeenCalled();
  });
});

describe('locks:release handler', () => {
  it('opts out of the ambient workspace transaction because the handler owns its DB scopes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('wraps a single lock_id release through the keyed bulk envelope (n=1)', async () => {
    const b = body(await call({ lock_id: '11111111-1111-1111-1111-111111111111' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['released:11111111-1111-1111-1111-111111111111'] },
      ],
    });
  });

  it('rejects a named-resource UUID with an explicit wrong-plane diagnostic', async () => {
    const lockId = '66666666-6666-4666-8666-666666666666';
    routeM.mockResolvedValue({
      value: { released: [], heldBefore: 0 },
      via: 'local-authority',
    } as never);
    readResourceStatusM.mockResolvedValue({
      status: 'held',
      mode: 'shared',
      resource: 'db-schema',
    });

    const b = body(await call({ lock_id: lockId }));

    expect(b).toMatchObject({
      // Envelope ok is DERIVED (`counts.failed === 0`) — EI-23737206446729041.
      ok: false,
      counts: { ok: 0, failed: 1 },
      results: [{
        ok: false,
        lock_id: lockId,
        error: 'lock_id_belongs_to_named_resource_plane',
        note: 'Use locks:release_resource { lock_id } to release a named-resource lock.',
        resource: 'db-schema',
        mode: 'shared',
        status: 'held',
      }],
    });
    expect(readResourceStatusM).toHaveBeenCalledWith({}, lockId);
  });

  it('uses the domain carried by the matching edit-hook acquire', async () => {
    await call({ lock_id: '11111111-1111-1111-1111-111111111111', coordination_domain: '/canonical/staging' });
    expect(resolveDomainM).toHaveBeenCalledWith('/canonical/staging', 'dom');
    expect(routeM.mock.calls[0]?.[0]).toBe('/canonical/staging');
  });

  it('releases selected lock_ids as a keyed bulk envelope', async () => {
    const b = body(await call({
      lock_ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: ['released:11111111-1111-1111-1111-111111111111'] },
        { ok: true, lock_id: '22222222-2222-2222-2222-222222222222', released: ['released:22222222-2222-2222-2222-222222222222'] },
      ],
    });
  });

  it('rejects combining all_mine with selected lock ids', async () => {
    const b = body(await call({ all_mine: true, lock_ids: ['11111111-1111-1111-1111-111111111111'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/either all_mine=true or selected/);
  });

  it('rejects an empty path selector before touching the store', async () => {
    const b = body(await call({ paths: [] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/requires lock_id, all_mine=true, or one or more paths/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('rejects combining all_mine with a path selector', async () => {
    const b = body(await call({ all_mine: true, paths: ['src/a.ts'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/either all_mine=true or selected lock_id\(s\)\/paths/);
  });

  it('retries a transient workspace contention before returning the release result', async () => {
    vi.useFakeTimers();
    try {
      const contended = { name: 'WorkspaceContendedError', pgCode: '55P03' };
      routeM.mockRejectedValueOnce(contended);
      mockResolvedOnceTyped(routeM, {
        value: { ok: true, released: ['a.ts'] },
        via: 'local-authority',
        scope: 'harness-x',
      });

      const pending = call({ lock_id: '11111111-1111-1111-1111-111111111111' });
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      expect(routeM).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the local fallback when routing fails and the release transaction is transiently contended', async () => {
    vi.useFakeTimers();
    try {
      const contended = { name: 'WorkspaceContendedError', pgCode: '57014' };
      routeM.mockRejectedValue(new Error('authority route unavailable'));
      const tryReleaseM = vi.mocked((await import('./su-lock-store')).tryRelease);
      tryReleaseM.mockRejectedValueOnce(contended);
      mockResolvedTyped(tryReleaseM, { released: ['a.ts'], heldBefore: 1 });

      const pending = call({ lock_id: '11111111-1111-1111-1111-111111111111' });
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      expect(tryReleaseM).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('locks:release — WI-1550 P-015 lock-event emission on a LOCALLY-decided release', () => {
  it('emits a lock-event when the release was decided local-authority with a resolved scope', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
    expect(recordEventM).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'release', scope: 'harness-x', path: 'a.ts', owner: 'me' }),
    );
  });

  it('emits on a fail-open release too (a remote authority was unreachable)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'fail-open', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit locally when the release was relayed to a remote authority (it already recorded its own)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'remote-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when the domain is unmanaged (no federated scope to record against)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when nothing was actually released', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: [] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111' });
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('carries published_sha onto the release event', async () => {
    routeM.mockResolvedValue({ value: { ok: true, released: ['a.ts'] }, via: 'local-authority', scope: 'harness-x' } as never);
    await call({ lock_id: '11111111-1111-1111-1111-111111111111', published_sha: 'a'.repeat(40) });
    expect(recordEventM).toHaveBeenCalledWith(expect.objectContaining({ publishedSha: 'a'.repeat(40) }));
  });
});

describe('locks:release — native edit attribution requires positive proof', () => {
  const LOCK = '77777777-7777-4777-8777-777777777777';

  it('records attribution only when a successful recognized edit proof exactly matches released paths', async () => {
    mockResolvedTyped(routeM, {
      value: { ok: true, released: ['a.ts'] },
      via: 'local-authority',
    });

    await call({
      lock_id: LOCK,
      native_edit_proof: { success: true, source: 'claude', tool: 'Edit', paths: ['a.ts'] },
    });

    expect(recordAttributionM).toHaveBeenCalledWith(expect.objectContaining({
      repoRoot: 'dom',
      files: ['a.ts'],
      agentId: 'me',
    }));
  });

  describe('P-014: a restricted owner’s edit is recorded BEFORE the lock is released', () => {
    const preRecordM = vi.mocked(recordRestrictedEditBeforeRelease);
    const proof = { success: true, source: 'claude', tool: 'Edit', paths: ['a.ts'] } as const;

    it('writes the ledger row ahead of the release and does not write it again afterwards', async () => {
      let routedBeforeRecord: number | null = null;
      preRecordM.mockImplementationOnce(async () => {
        routedBeforeRecord = routeM.mock.calls.length;
        return true;
      });
      mockResolvedOnceTyped(routeM, { value: { ok: true, released: ['a.ts'] }, via: 'local-authority' });

      await call({ lock_id: LOCK, native_edit_proof: proof });

      expect(routedBeforeRecord).toBe(0);
      expect(routeM).toHaveBeenCalled();
      expect(preRecordM).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: 'dom', files: ['a.ts'], ownerId: 'me' }));
      expect(recordAttributionM).not.toHaveBeenCalled();
    });

    it('keeps the lock (never routes the release) when the restricted record is refused', async () => {
      preRecordM.mockRejectedValueOnce(new Error('disclosure_ledger_unavailable: down'));
      await call({ lock_id: LOCK, native_edit_proof: proof }).catch(() => undefined);
      expect(routeM).not.toHaveBeenCalled();
    });

    it('is not consulted for a release with no native-edit proof', async () => {
      mockResolvedTyped(routeM, { value: { ok: true, released: ['a.ts'] }, via: 'local-authority' });
      await call({ lock_id: LOCK });
      expect(preRecordM).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['lock-only release', undefined],
    ['failed native result', { success: false, source: 'claude', tool: 'Edit', paths: ['a.ts'] }],
    ['unknown native tool', { success: true, source: 'claude', tool: 'Read', paths: ['a.ts'] }],
    ['path mismatch', { success: true, source: 'claude', tool: 'Edit', paths: ['other.ts'] }],
  ])('does not attribute %s', async (_label, nativeEditProof) => {
    mockResolvedTyped(routeM, {
      value: { ok: true, released: ['a.ts'] },
      via: 'local-authority',
    });

    await call({ lock_id: LOCK, native_edit_proof: nativeEditProof });

    expect(recordAttributionM).not.toHaveBeenCalled();
  });
});

/**
 * WI-10006831 — an edit made under the caller's own EXPLICIT lock gets no
 * release token (EI-63), so before `retain` it never reached the ledger.
 * `retain` writes the attribution for paths still held and releases nothing.
 */
describe('locks:release retain (WI-10006831)', () => {
  const strictM = vi.mocked(recordEditAttributionStrict);
  const restrictedM = vi.mocked(recordRestrictedEditBeforeRelease);
  const held = (path: string, owner = 'me', domain = 'dom'): ActiveLockRow => ({
    lock_id: '44444444-4444-4444-4444-444444444444',
    path,
    owner,
    owner_label: 'Me',
    goal_ref: null,
    intent: 'explicit multi-file hold',
    acquired_ts: new Date(0),
    expires_ts: new Date(Date.now() + 60_000),
    coordination_domain: domain,
  });
  const proof = (paths: string[]) => ({ success: true, source: 'claude', tool: 'Edit', paths });

  it('attributes held proof paths and releases nothing', async () => {
    mockResolvedTyped(readQueueM, { active_locks: [held('a.ts'), held('b.ts')], waiting: [] });

    const out = body(await call({ retain: true, native_edit_proof: proof(['a.ts', 'b.ts']) }));

    expect(out).toMatchObject({ ok: true, retained: ['a.ts', 'b.ts'], released: [], attributed: ['a.ts', 'b.ts'] });
    expect(strictM).toHaveBeenCalledTimes(1);
    expect(strictM).toHaveBeenCalledWith(expect.objectContaining({
      repoRoot: 'dom',
      files: ['a.ts', 'b.ts'],
      agentId: 'me',
      intent: 'PostToolUse:claude:Edit:retained',
    }));
    // Nothing is released: neither the routed release nor the local store runs.
    expect(routeM).not.toHaveBeenCalled();
    expect(vi.mocked(tryRelease)).not.toHaveBeenCalled();
    expect(readQueueM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      coordinationDomain: 'dom',
      owner: 'me',
      paths: ['a.ts', 'b.ts'],
    }));
  });

  it('uses the explicit coordination_domain the hook sends', async () => {
    mockResolvedTyped(readQueueM, { active_locks: [held('a.ts', 'me', '/hives/sidestage')], waiting: [] });

    const out = body(await call({
      retain: true,
      coordination_domain: '/hives/sidestage',
      native_edit_proof: proof(['a.ts']),
    }));

    expect(out.ok).toBe(true);
    expect(strictM).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: '/hives/sidestage', files: ['a.ts'] }));
  });

  it.each([
    ['a path the caller does not hold', [held('a.ts')], ['b.ts']],
    ['a path a peer holds', [held('a.ts'), held('b.ts', 'peer')], ['b.ts']],
    ['a hold in another coordination domain', [held('a.ts'), held('b.ts', 'me', '/other')], ['b.ts']],
  ])('refuses and writes nothing for %s', async (_label, rows, notHeld) => {
    mockResolvedTyped(readQueueM, { active_locks: rows, waiting: [] });

    const out = body(await call({ retain: true, native_edit_proof: proof(['a.ts', 'b.ts']) }));

    expect(out).toMatchObject({ ok: false, error: 'retain_paths_not_held', not_held: notHeld, attributed: [] });
    expect(strictM).not.toHaveBeenCalled();
    expect(restrictedM).not.toHaveBeenCalled();
    expect(routeM).not.toHaveBeenCalled();
  });

  it.each([
    ['no proof', undefined],
    ['a failed native result', { success: false, source: 'claude', tool: 'Edit', paths: ['a.ts'] }],
    ['a non-edit tool', { success: true, source: 'claude', tool: 'Read', paths: ['a.ts'] }],
  ])('refuses %s without reading holds', async (_label, nativeEditProof) => {
    const out = body(await call({ retain: true, native_edit_proof: nativeEditProof }));

    expect(out).toMatchObject({ ok: false, error: 'retain_requires_native_edit_proof' });
    expect(readQueueM).not.toHaveBeenCalled();
    expect(strictM).not.toHaveBeenCalled();
  });

  it('refuses a release selector beside retain instead of releasing it', async () => {
    const out = body(await call({ retain: true, paths: ['a.ts'], native_edit_proof: proof(['a.ts']) }));

    expect(out).toMatchObject({ ok: false, error: 'retain_conflicting_selector' });
    expect(routeM).not.toHaveBeenCalled();
    expect(strictM).not.toHaveBeenCalled();
  });

  it('writes the restricted-owner hold instead of the plain row', async () => {
    mockResolvedTyped(readQueueM, { active_locks: [held('a.ts')], waiting: [] });
    restrictedM.mockResolvedValueOnce(true);

    const out = body(await call({ retain: true, native_edit_proof: proof(['a.ts']) }));

    expect(out.ok).toBe(true);
    expect(restrictedM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'me', files: ['a.ts'] }));
    expect(strictM).not.toHaveBeenCalled();
  });

  it('reports a failed ledger write instead of claiming attribution', async () => {
    mockResolvedTyped(readQueueM, { active_locks: [held('a.ts')], waiting: [] });
    strictM.mockRejectedValueOnce(new Error('ledger down'));

    const out = body(await call({ retain: true, native_edit_proof: proof(['a.ts']) }));

    expect(out).toMatchObject({ ok: false, attributed: [] });
    expect(String(out.error)).toContain('retain_attribution_failed');
  });

  it('schema: retain without paths validates; retain with paths or lock_id does not', () => {
    const schema = tool.args;
    expect(schema.safeParse({ retain: true, native_edit_proof: proof(['a.ts']) }).success).toBe(true);
    expect(schema.safeParse({ retain: true, paths: ['a.ts'], native_edit_proof: proof(['a.ts']) }).success).toBe(false);
    expect(schema.safeParse({
      retain: true,
      lock_id: '44444444-4444-4444-4444-444444444444',
      native_edit_proof: proof(['a.ts']),
    }).success).toBe(false);
    // An operator without `retain` strips the key and must REFUSE, never release.
    expect(schema.safeParse({ native_edit_proof: proof(['a.ts']) }).success).toBe(false);
  });
});

/**
 * WI-6554700010019499 — the hook-operation finish (every Codex apply_patch release) wrote its
 * edit-attribution row with workspace_id NULL because this branch never passed the caller's
 * identity. git-sync's roster read is workspace-scoped, so those authors vanished from commit
 * attribution and from the migration-dependency fence.
 */
describe('locks:release hook_operation threads caller identity (WI-6554700010019499)', () => {
  it('passes the resolved workspace + contributor to routeHookOperationFinish', async () => {
    vi.mocked(resolveAgentIdentity).mockReturnValueOnce(
      { ownerId: 'me', workspaceId: 'ws-1', userId: 'user-1' } as ReturnType<typeof resolveAgentIdentity>,
    );
    const finish = vi.mocked(routeHookOperationFinish);
    finish.mockClear();

    await call({
      hook_operation: {
        id: '71d933be-413a-48b0-83af-8856650a917b', deadline: '2026-06-05T00:30:00Z',
        paths: ['a.ts'], intent: 'PreToolUse:apply_patch', ttl_sec: 600, authority: 'auth-1',
      },
      native_edit_proof: { success: true, source: 'codex', tool: 'apply_patch', paths: ['a.ts'] },
    });

    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'me', workspaceId: 'ws-1', contributor: 'user-1' }),
      'auth-1',
    );
  });
});
