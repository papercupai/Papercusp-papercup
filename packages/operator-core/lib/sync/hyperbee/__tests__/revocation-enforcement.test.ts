/**
 * revocation-enforcement.test.ts — published revocation enforcement (D-002).
 *
 * Verifies that bootHarnessSubstrate:
 *   1. Startup-seeds the `revoked` set from `loadRevokedOverride` BEFORE the
 *      first announce, so a revoked-at-startup peer is refused immediately.
 *   2. Still admits a peer whose pubkey is NOT in the revoked set.
 *   3. Merge-refresh: after a successful merge pass, picks up NEW revocations
 *      from the loader and drops the corresponding admitted log — a mid-session
 *      replicated revocation takes effect without a reboot.
 *
 * Uses the existing boot test seams (verifyBindingOverride, mergePollMs:0,
 * pendingRetryMs:0, loadRevokedOverride) so no real PG or network is needed.
 *
 * Plan: substrate-revocation-v1 Task 2 (D-002).
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Corestore from 'corestore';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { openOwnLog } from '../peer-log';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

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
  githubLogin = 'alice',
  githubUserId = 4242,
): Promise<SignedAnnounce> {
  return buildAnnounce(
    { device_pubkey: device.devicePubkey, github_user_id: githubUserId, github_login: githubLogin, attestation_gist_id: 'gist-test', log_core_key: logCoreKey },
    device.sign,
  );
}

/** Pipe two Corestores' replication streams both ways. */
function replicate(s1: Corestore, s2: Corestore): void {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
}

describe('revocation-enforcement (D-002)', () => {
  // ── Test 1: startup enforcement ───────────────────────────────────────────
  it('startup: a peer whose pubkey is in the seeded revoked set is refused on first announce', async () => {
    const device = makeDevice();
    const logCoreKey = 'ba'.repeat(32);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-seed-'),
      workspaceId: 'ws-revoke-1',
      harnessSlug: 'rev-seed-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      verifyBindingOverride: async () => 'verified',
      // Seed PUB_X as already-revoked at startup.
      loadRevokedOverride: async () => new Set([device.devicePubkey]),
    });
    cleanups.push(() => handle.close());

    // The seeded pubkey must be refused with reason 'revoked'.
    const frame = await makeAnnounce(device, logCoreKey);
    const decision = await handle.onAnnounce(frame);

    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    // The log is NOT added to the admitted set.
    expect(handle.admitted.has(logCoreKey)).toBe(false);
    // Only the own log remains.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
  });

  // ── Test 2: non-revoked peer still admitted ───────────────────────────────
  it('startup: a peer NOT in the seeded revoked set is still admitted normally', async () => {
    const revokedDevice = makeDevice();
    const okDevice = makeDevice();
    const logCoreKeyOk = 'cc'.repeat(32);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-ok-'),
      workspaceId: 'ws-revoke-2',
      harnessSlug: 'rev-seed-2',
      mergePollMs: 0,
      pendingRetryMs: 0,
      verifyBindingOverride: async () => 'verified',
      // Only revokedDevice is in the set — okDevice must still be admitted.
      loadRevokedOverride: async () => new Set([revokedDevice.devicePubkey]),
    });
    cleanups.push(() => handle.close());

    const frame = await makeAnnounce(okDevice, logCoreKeyOk, 'bob', 9999);
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(true);
    expect(handle.admitted.has(logCoreKeyOk)).toBe(true);
  });

  // ── Test 3: merge refresh drops a now-revoked admitted peer ───────────────
  it('merge-refresh: a peer admitted before revocation is dropped from admitted after mergeNow', async () => {
    // `loadRevokedOverride` is a mutable closure var: starts returning empty,
    // flips to include PUB_Y after we confirm the peer is admitted.
    let revokedSet = new Set<string>();

    const device = makeDevice();
    const peerDir = tmpDir('mb-revoke-refresh-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);

    // Give the peer one op so mergeNow has something to do.
    await peerOwn.append({
      type: 'put',
      table: 'mb_revoke_refresh_table',
      hbKey: 'Y-1',
      value: { id: 'Y-1' },
      ts: 100,
      schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: device.devicePubkey,
    });

    const writes: unknown[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-refresh-host-'),
      workspaceId: 'ws-revoke-3',
      harnessSlug: 'rev-refresh-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_revoke_refresh_table') writes.push(op.value);
        return true;
      },
      // The loader reads from the mutable closure var.
      loadRevokedOverride: async () => new Set(revokedSet),
    });
    cleanups.push(() => handle.close());

    // Wire up replication so the peer's log is readable from the host's store.
    replicate(peerStore, handle.store);

    // Announce PUB_Y — currently NOT revoked → admitted.
    const frame = await makeAnnounce(device, peerOwn.keyHex, 'peer-y', 8888);
    const admitDecision = await handle.onAnnounce(frame);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(true);

    // The peer's first op was merged during onAnnounce.
    expect(writes).toEqual([{ id: 'Y-1' }]);

    // ── Now flip: PUB_Y is revoked (mid-session, replicated to PG). ──
    revokedSet = new Set([device.devicePubkey]);

    // Drive a merge pass — the refresh runs inside mergeNow after the merge.
    await handle.mergeNow();

    // The peer's log must be gone from the admitted set.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    // Only the own log remains.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // A `peer_revoked` boot-history event must have been recorded.
    const revokedEvents = listBootHistory({
      workspaceId: 'ws-revoke-3',
      harnessSlug: 'rev-refresh-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents.length).toBeGreaterThan(0);

    // A further mergeNow does NOT re-drop (idempotent — already removed).
    await handle.mergeNow();
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    // Still only one peer_revoked event (not double-recorded).
    const revokedEvents2 = listBootHistory({
      workspaceId: 'ws-revoke-3',
      harnessSlug: 'rev-refresh-1',
      kinds: ['peer_revoked'],
      limit: 10,
    });
    expect(revokedEvents2.length).toBe(revokedEvents.length);
  });
});
