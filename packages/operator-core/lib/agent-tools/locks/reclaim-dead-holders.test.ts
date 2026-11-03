/**
 * reclaim-dead-holders.test.ts — `reclaimDeadExclusiveHolders` with BOTH
 * instruments (EI-18674647773291145 pid-dead + EI-22078335832051825
 * session-ended), PG-free: the txn wrapper runs the callback and the store's
 * `tryReleaseResource` is mocked. The live-PG behaviour of the pid path is
 * pinned by __tests__/resource-acquire-wait.integration.test.ts; THIS suite
 * pins the composition:
 *
 *  - a holder whose pid is ALIVE (this very process) but whose owner the oracle
 *    returns is reclaimed by its own lock_id, with verdict `session-ended`;
 *  - the oracle is consulted ONCE, with exactly the exclusive holders the pid
 *    test did not condemn (never a shared holder, never a pid-dead one);
 *  - no oracle ⇒ the pre-existing pid-only behaviour, unchanged;
 *  - an oracle that condemns nobody, or throws, reclaims nothing;
 *  - the reported verdict text names the instrument.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/locks/reclaim-dead-holders.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(),
  pokeResource: vi.fn(),
  readResourceLockStatus: vi.fn(),
  readResourceQueue: vi.fn(),
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(),
}));
vi.mock('./workspace-listener', () => ({ subscribeWorkspace: vi.fn() }));

import { tryReleaseResource, type ResourceHolder } from './su-lock-store';
import {
  describeStaleHolderVerdict,
  reclaimDeadExclusiveHolders,
  type StaleHolderReclaimedInfo,
} from './resource-acquire-wait';

const releaseM = vi.mocked(tryReleaseResource);

/** The COMPLETE store release result, so a field the real signature gains fails
 *  HERE (typecheck) instead of at the fleet gate — never an `as never` cast. */
type ReleaseResult = Awaited<ReturnType<typeof tryReleaseResource>>;
const releaseResult = (released: number): ReleaseResult => ({
  released,
  releasedModes: released > 0 ? ['exclusive'] : [],
  releasedExclusiveResources: released > 0 ? ['git-sync:portal'] : [],
  exclusiveResources: released > 0 ? ['git-sync:portal'] : [],
  expired: [],
  waiters: {},
});

const CD = 'papercusp-workspace';
const ME = 'system:git-sync:999:this-fire';

function holder(over: Partial<ResourceHolder> = {}): ResourceHolder {
  return {
    resource: 'git-sync:portal',
    owner: 'su-0542551f-ended-session',
    owner_label: 'su · su-05425',
    mode: 'exclusive',
    status: 'held',
    lock_id: 'lock-ended-session',
    reason: 'mutation probe',
    acquired_ts: new Date('2026-09-01T16:59:00.000Z'),
    expires_ts: new Date('2026-09-01T17:09:25.839Z'),
    fence_seq: 7,
    ...over,
  };
}

/** Spawn + reap a child so the pid-dead leg has a pid guaranteed ESRCH. */
function definitelyDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    if (!pid) return reject(new Error('spawn returned no pid'));
    child.once('exit', () => resolve(pid));
    child.once('error', reject);
  });
}

/** The pid parser for `stale-owner:<pid>` shaped owners; null for everything else. */
const pidFromLabel = (owner: string): number | null => {
  const m = /^stale-owner:(\d+)$/.exec(owner);
  return m ? Number(m[1]) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  releaseM.mockResolvedValue(releaseResult(1));
});

describe('reclaimDeadExclusiveHolders — session-ended instrument', () => {
  it('reclaims a holder whose pid is ALIVE but whose session the oracle calls ended, by lock_id', async () => {
    const h = holder();
    const oracle = vi.fn(async (owners: readonly string[]) => new Set(owners));
    const seen: StaleHolderReclaimedInfo[] = [];
    // `pidFromLabel` returns null for an `su-…` owner: the pid test has NOTHING
    // to say, which is exactly the filed shape.
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [h], pidFromLabel, (i) => void seen.push(i), oracle);
    expect(reclaimed).toBe(true);
    expect(releaseM).toHaveBeenCalledTimes(1);
    expect(releaseM.mock.calls[0][1]).toEqual({ coordinationDomain: CD, owner: h.owner, lockId: h.lock_id });
    expect(seen).toEqual([{ holder: h, pid: null, verdict: 'session-ended' }]);
    expect(describeStaleHolderVerdict(seen[0])).toBe('session ended per the shared liveness oracle');
  });

  it('consults the oracle ONCE with exactly the exclusive holders the pid test did not condemn', async () => {
    const deadPid = await definitelyDeadPid();
    const pidDead = holder({ owner: `stale-owner:${deadPid}`, lock_id: 'lock-pid-dead' });
    const shared = holder({ owner: 'su-shared-reader', mode: 'shared', lock_id: 'lock-shared' });
    const ended = holder({ owner: 'su-ended', lock_id: 'lock-ended' });
    const live = holder({ owner: 'su-live', lock_id: 'lock-live' });
    const oracle = vi.fn(async () => new Set(['su-ended']));
    const seen: StaleHolderReclaimedInfo[] = [];

    const reclaimed = await reclaimDeadExclusiveHolders(
      CD,
      ME,
      [pidDead, shared, ended, live],
      pidFromLabel,
      (i) => void seen.push(i),
      oracle,
    );
    expect(reclaimed).toBe(true);
    expect(oracle).toHaveBeenCalledTimes(1);
    expect(oracle).toHaveBeenCalledWith(['su-ended', 'su-live']); // residue only: no shared, no pid-dead
    expect(releaseM.mock.calls.map((c) => (c[1] as { lockId: string }).lockId)).toEqual(['lock-pid-dead', 'lock-ended']);
    expect(seen.map((i) => [i.holder.lock_id, i.verdict, i.pid])).toEqual([
      ['lock-pid-dead', 'pid-dead', deadPid],
      ['lock-ended', 'session-ended', null],
    ]);
    expect(describeStaleHolderVerdict(seen[0])).toBe(`pid ${deadPid} not running on this host`);
  });

  it('does NOT consult the oracle when every exclusive holder was already pid-dead', async () => {
    const deadPid = await definitelyDeadPid();
    const oracle = vi.fn(async () => new Set<string>());
    const reclaimed = await reclaimDeadExclusiveHolders(
      CD,
      ME,
      [holder({ owner: `stale-owner:${deadPid}` })],
      pidFromLabel,
      undefined,
      oracle,
    );
    expect(reclaimed).toBe(true);
    expect(oracle).not.toHaveBeenCalled();
  });

  it('an oracle that condemns nobody reclaims nothing (a live peer keeps its lock)', async () => {
    const oracle = vi.fn(async () => new Set<string>());
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder()], pidFromLabel, undefined, oracle);
    expect(reclaimed).toBe(false);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('an oracle that throws condemns nobody', async () => {
    const oracle = vi.fn(async () => {
      throw new Error('oracle down');
    });
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder()], pidFromLabel, undefined, oracle);
    expect(reclaimed).toBe(false);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('an oracle naming an owner that is not among the holders reclaims nothing', async () => {
    // A verdict about a stranger is not a verdict about this queue.
    const oracle = vi.fn(async () => new Set(['su-someone-else']));
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder()], pidFromLabel, undefined, oracle);
    expect(reclaimed).toBe(false);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('a release that frees zero rows (the lease was already gone) is not a reclaim', async () => {
    releaseM.mockResolvedValue(releaseResult(0));
    const oracle = vi.fn(async (owners: readonly string[]) => new Set(owners));
    const seen: StaleHolderReclaimedInfo[] = [];
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder()], pidFromLabel, (i) => void seen.push(i), oracle);
    expect(reclaimed).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('reclaimDeadExclusiveHolders — no oracle ⇒ pid-only behaviour unchanged', () => {
  it('leaves an su-… holder alone (the filed shape, pre-fix)', async () => {
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder()], pidFromLabel);
    expect(reclaimed).toBe(false);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('still reclaims a pid-dead holder with verdict pid-dead', async () => {
    const deadPid = await definitelyDeadPid();
    const seen: StaleHolderReclaimedInfo[] = [];
    const reclaimed = await reclaimDeadExclusiveHolders(
      CD,
      ME,
      [holder({ owner: `stale-owner:${deadPid}` })],
      pidFromLabel,
      (i) => void seen.push(i),
    );
    expect(reclaimed).toBe(true);
    expect(seen.map((i) => [i.verdict, i.pid])).toEqual([['pid-dead', deadPid]]);
  });

  it('never reclaims a holder whose pid is this live process', async () => {
    const reclaimed = await reclaimDeadExclusiveHolders(CD, ME, [holder({ owner: `stale-owner:${process.pid}` })], pidFromLabel);
    expect(reclaimed).toBe(false);
    expect(releaseM).not.toHaveBeenCalled();
  });
});
