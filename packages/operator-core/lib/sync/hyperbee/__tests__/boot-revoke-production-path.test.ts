/**
 * boot-revoke-production-path.test.ts — production-path startup revocation
 * coverage (D-002 gap fix).
 *
 * The security review found that the startup revocation seed was guarded by
 * `if (opts.loadRevokedOverride)`, meaning a peer whose pubkey is in the
 * published `revoked_pubkeys` list was only refused after the first
 * poll-timer tick (~1 s after boot), not on first announce.
 *
 * This test exercises the NO-override (production) startup seed path: it mocks
 * `loadRevokedPubkeys` at the module boundary so the default loader (called
 * when `loadRevokedOverride` is absent) returns a seeded set, then asserts
 * that a peer whose pubkey is in that set is refused on their very first
 * announce — before any merge or poll-timer tick.
 *
 * Plan: substrate-revocation-v1 (D-002 gap fix).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests } from '../boot-history';
import { buildAnnounce, type SignedAnnounce } from '../announce';

// ── Module-level mock of loadRevokedPubkeys ────────────────────────────────
// The mock is hoisted to the top of the module by Vitest so that when
// boot.ts imports '../load-revoked-pubkeys' it receives our spy.  We start
// with an empty set (safe default) and set the return value per-test.
vi.mock('../load-revoked-pubkeys', () => {
  const loadRevokedPubkeys = vi.fn(async (_opts: unknown) => new Set<string>());
  return {
    loadRevokedPubkeys,
    // WI-10005183: boot.ts reads through the cached variant. A unit test never
    // attaches the cache to a LISTEN, so the real cached variant always falls
    // through to the uncached read; forward to the same spy to keep that shape.
    loadRevokedPubkeysCached: (opts: unknown) => loadRevokedPubkeys(opts),
  };
});

// Import AFTER the mock declaration so the mock is in place.
import { loadRevokedPubkeys } from '../load-revoked-pubkeys';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
  // Reset the spy back to empty-set default between tests.
  vi.mocked(loadRevokedPubkeys).mockReset();
  vi.mocked(loadRevokedPubkeys).mockResolvedValue(new Set());
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** Generate a real Ed25519 keypair, return the base64 pubkey + a signer. */
function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const sign = async (bytes: Buffer) => nodeSign(null, bytes, privateKey);
  return { devicePubkey, sign };
}

/** Build a VALID signed announce from a device. */
async function makeAnnounce(
  device: ReturnType<typeof makeDevice>,
  logCoreKey: string,
): Promise<SignedAnnounce> {
  return buildAnnounce(
    { device_pubkey: device.devicePubkey, github_user_id: 4242, github_login: 'alice', attestation_gist_id: 'gist-test', log_core_key: logCoreKey },
    device.sign,
  );
}

describe('production-path startup seed (no loadRevokedOverride)', () => {
  it('startup: real PG loader seeded — peer with revoked pubkey is refused on FIRST announce (before any poll tick)', async () => {
    // ── Arrange: the mocked loadRevokedPubkeys (the default production loader)
    // returns a set containing PUB_X's device pubkey. ──
    const device = makeDevice();
    vi.mocked(loadRevokedPubkeys).mockResolvedValue(new Set([device.devicePubkey]));

    // ── Boot WITHOUT loadRevokedOverride — exercises the production seed path. ──
    // mergePollMs:0 disables the poll timer so no merge runs between boot and
    // the announce; this proves the seed happened at startup, not via a poll tick.
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-prod-seed-'),
      workspaceId: 'ws-prod-revoke',
      harnessSlug: 'prod-rev-1',
      mergePollMs: 0,        // no poll timer — no merge ticks between boot + announce
      pendingRetryMs: 0,     // no retry timer
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    // ── Assert: the loader was called at startup (before swarm join). ──
    expect(vi.mocked(loadRevokedPubkeys)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-prod-revoke', harnessSlug: 'prod-rev-1' }),
    );

    // ── Assert: the revoked peer is refused with reason 'revoked' on first
    // announce, with NO merge or poll tick having occurred. ──
    const logCoreKey = 'fa'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey);
    const decision = await handle.onAnnounce(frame);

    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    // The log must NOT have been admitted.
    expect(handle.admitted.has(logCoreKey)).toBe(false);
    // Only the own log remains.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
  });

  it('startup: real PG loader seeded — peer NOT in revoked set is admitted normally', async () => {
    // Seeded with a different pubkey; the device under test must still be admitted.
    const revokedDevice = makeDevice();
    const okDevice = makeDevice();
    vi.mocked(loadRevokedPubkeys).mockResolvedValue(new Set([revokedDevice.devicePubkey]));

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-prod-seed-ok-'),
      workspaceId: 'ws-prod-revoke-ok',
      harnessSlug: 'prod-rev-ok',
      mergePollMs: 0,
      pendingRetryMs: 0,
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const logCoreKey = 'fb'.repeat(32);
    const frame = await makeAnnounce(okDevice, logCoreKey);
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(true);
    expect(handle.admitted.has(logCoreKey)).toBe(true);
  });

  it('startup: loader fail-open — a PG error during seed does NOT fail boot', async () => {
    // Simulate a PG loader failure — boot must succeed (fail-open).
    vi.mocked(loadRevokedPubkeys).mockRejectedValue(new Error('simulated PG connection failure'));

    // Boot must not throw even though the loader rejects.
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-prod-seed-err-'),
      workspaceId: 'ws-prod-revoke-err',
      harnessSlug: 'prod-rev-err',
      mergePollMs: 0,
      pendingRetryMs: 0,
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    // Boot succeeded despite the load error; the handle is usable.
    expect(handle.ownLog.keyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
