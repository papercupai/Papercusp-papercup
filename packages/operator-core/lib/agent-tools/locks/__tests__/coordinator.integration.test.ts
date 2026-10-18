/**
 * Conformance tests for SuLocksCoordinator (file-locking #11).
 * Delegates contract assertions to @papercusp/file-claim/conformance;
 * the SAME 11 generic cases run against both the in-process
 * FileLockQueueCoordinator (orchestrator pkg) and the PG-backed
 * SuLocksCoordinator (here). The interface alignment is real iff
 * both adapters pass the same suite.
 *
 * Setup mirrors su-lock-store.integration.test.ts: real embedded PG, unique
 * workspace per test, ensureBootstrap once.
 *
 * EI-1551: renamed from `.test.ts` — `ensureBootstrap()` opens a real
 * postgres connection, so this suite hard-requires PG and was never
 * hermetic; as a plain `*.test.ts` it ran under the unit layer and failed
 * with ECONNREFUSED whenever that PG wasn't up. `.integration.test.ts`
 * routes it to `vitest.integration.config.ts` (testcontainers-provisioned
 * PG) instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeConformance } from '@papercusp/file-claim/conformance';
import { SuLocksCoordinator } from '../coordinator';
import { ensureBootstrap, getTxPool, _resetForTests } from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

const SUITE_PREFIX = `vitest-coord-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
let nextN = 0;
function nextWs(): string {
  return `${SUITE_PREFIX}-${nextN++}`;
}

beforeAll(async () => {
  await ensureBootstrap();
});

afterAll(async () => {
  await _resetForTests();
});

describeConformance('SuLocksCoordinator', async () => {
  const coordinationDomain = nextWs();
  const coordinator = new SuLocksCoordinator({ coordinationDomain });
  return {
    coordinator,
    cleanup: async () => {
      // Fresh workspace per test means no cross-test bleed; nothing
      // to clean.
    },
  };
});

// ────────────────────────────────────────────────────────────────────
// file-locking #11 — heartbeat regression coverage.
// The shared conformance suite does NOT exercise heartbeat; that gap
// let SuLocksCoordinator.heartbeat ship calling tryHeartbeat with the
// wrong (object) argument shape and reading a nonexistent `.ok` field
// — a method that always returned {ok:false,expired:true} at runtime.
// These cases lock the corrected behaviour in.
// ────────────────────────────────────────────────────────────────────
describe('SuLocksCoordinator.heartbeat (file-locking #11 regression)', () => {
  it('renews a minimal tool claim while an unrelated path transaction remains open', async () => {
    const domain = nextWs();
    const coordinator = new SuLocksCoordinator({ coordinationDomain: domain });
    const acquired = await coordinator.acquire('owner', ['ours.ts']);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    let unblock!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const peer = inWorkspaceTxn(domain, 'peer', async () => {
      ready();
      await blocked;
    }, { paths: ['unrelated.ts'] });
    await Promise.race([entered, peer]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        coordinator.heartbeat({ ...acquired.claim, paths: [] }, 120_000),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('renewal blocked on unrelated path')), 1500);
        }),
      ]);
      expect(result.ok).toBe(true);
    } finally {
      clearTimeout(timer);
      unblock();
      await peer;
      await coordinator.release(acquired.claim);
    }
  });

  it('renews while an unrelated expired row is locked, without sweeping that row', async () => {
    const domain = nextWs();
    const coordinator = new SuLocksCoordinator({ coordinationDomain: domain });
    const own = await coordinator.acquire('owner', ['ours.ts']);
    const expired = await coordinator.acquire('peer', ['expired.ts']);
    expect(own.ok && expired.ok).toBe(true);
    if (!own.ok || !expired.ok) return;
    const sql = getTxPool();
    await sql`UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'
      WHERE coordination_domain = ${domain} AND lock_id = ${expired.claim.claimId}::uuid`;
    let unblock!: () => void;
    let ready!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const peer = sql.begin(async (tx) => {
      await tx`SELECT path FROM agent_file_locks WHERE coordination_domain = ${domain}
        AND lock_id = ${expired.claim.claimId}::uuid FOR UPDATE`;
      ready();
      await blocked;
    });
    await Promise.race([entered, peer]);
    try {
      expect((await coordinator.heartbeat({ ...own.claim, paths: [] }, 120_000)).ok).toBe(true);
    } finally {
      unblock();
      await peer;
      await coordinator.reap('owner');
      await coordinator.reap('peer');
    }
  });

  it('never resurrects an expired lease or extends a different owner', async () => {
    const domain = nextWs();
    const coordinator = new SuLocksCoordinator({ coordinationDomain: domain });
    const acquired = await coordinator.acquire('owner', ['expired.ts']);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect((await coordinator.heartbeat({ ...acquired.claim, owner: 'other', paths: [] })).ok).toBe(false);
    const sql = getTxPool();
    await sql`UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'
      WHERE coordination_domain = ${domain} AND lock_id = ${acquired.claim.claimId}::uuid`;
    expect((await coordinator.heartbeat({ ...acquired.claim, paths: [] })).ok).toBe(false);
    await coordinator.reap('owner');
  });

  it('extends a held claim and returns ok with a later expiry', async () => {
    const coordinator = new SuLocksCoordinator({ coordinationDomain: nextWs() });
    const acq = await coordinator.acquire('hb-owner', ['hb/file.ts'], {
      ttlMs: 60_000,
    });
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const hb = await coordinator.heartbeat(acq.claim, 120_000);
    expect(hb.ok).toBe(true);
    if (!hb.ok) return;
    expect(hb.claim.expiresAt).toBeInstanceOf(Date);
    // 120s TTL from now must land later than the original 60s TTL.
    expect(hb.claim.expiresAt!.getTime()).toBeGreaterThan(
      acq.claim.expiresAt!.getTime(),
    );
  });

  it('returns {ok:false, expired:true} for an unknown claim', async () => {
    const coordinator = new SuLocksCoordinator({ coordinationDomain: nextWs() });
    const hb = await coordinator.heartbeat(
      {
        claimId: '00000000-0000-0000-0000-000000000000',
        owner: 'nobody',
        paths: [],
        expiresAt: null,
      },
      60_000,
    );
    expect(hb.ok).toBe(false);
  });
});
