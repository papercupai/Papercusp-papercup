/**
 * revocation-prior-row-semantics.test.ts — substrate-internals BEHAVIOR-PIN (A6).
 *
 * On revoke, `mergeNow` drops the revoked peer's log from the admitted set,
 * resets the merge cursor, and re-folds ONLY the survivors — so the revoked
 * peer's FUTURE ops never apply. But its ALREADY-APPLIED rows are NOT deleted:
 * the projection apply is an idempotent LWW upsert, and revocation does not run a
 * compensating DELETE. A re-fold of the survivors simply never touches the
 * revoked peer's prior row, so it persists in the "PG" table.
 *
 * This test PINS that intended (current) semantics so a future change to it is a
 * deliberate, visible decision — not a silent regression:
 *   - X writes F-X → it applies (lands in the PG-like sink).
 *   - Revoke X → mergeNow re-folds survivors.
 *   - F-X is STILL present (already-applied rows stay).
 *   - A post-revoke X write does NOT appear (revoked log is no longer read).
 *
 * Uses the bootHarness + Corestore-replicate + openOwnLog rig from boot.test.ts,
 * but with a Map-keyed sink that MODELS a PG projection table (upsert on apply),
 * so "F-X stays" is a genuine statement about the projected row surviving the
 * re-fold — not merely an append-only capture artifact.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests } from '../boot-history';
import { openOwnLog } from '../peer-log';
import { buildAnnounce } from '../announce';
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
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

function makeDevice(githubLogin: string, githubUserId: number) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  return {
    devicePubkey,
    githubUserId,
    githubLogin,
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

function replicate(s1: Corestore, s2: Corestore): void {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
}

describe('revocation prior-row semantics (behavior-pin, A6)', () => {
  it('a revoked peer\'s ALREADY-APPLIED row stays (LWW upsert, no compensating delete); its post-revoke write does NOT appear', async () => {
    // A Map-keyed sink modelling a PG projection table: apply = upsert by hbKey.
    // Re-folding the survivors after revocation never re-touches X's row, so it
    // persists — this is the semantics we pin.
    const table = new Map<string, { id: string }>();
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-a6-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'a6-1',
      mergePollMs: 0, // drive merges by hand
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_a6_table' && op.hbKey) {
          // Idempotent LWW upsert keyed by hbKey — the projection's real shape.
          table.set(op.hbKey, op.value as { id: string });
        }
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // ── A real remote peer X. ──
    const peerStore = new Corestore(tmpDir('mb-a6-peer-'));
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const xOwn = await openOwnLog(peerStore);
    const X = makeDevice('peer-x', 4242);

    // X writes F-X, then replicates into the host.
    await xOwn.append({
      type: 'put', table: 'mb_a6_table', hbKey: 'F-X',
      value: { id: 'F-X' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: X.devicePubkey,
    });
    replicate(peerStore, handle.store);

    // Admit X → onAnnounce merges → F-X applies.
    const announce = await buildAnnounce(
      {
        device_pubkey: X.devicePubkey,
        github_user_id: X.githubUserId,
        github_login: X.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: xOwn.keyHex,
      },
      X.sign,
    );
    expect((await handle.onAnnounce(announce)).admit).toBe(true);
    expect(table.has('F-X')).toBe(true); // F-X applied while X was admitted

    // ── REVOKE X. ── Drops X's log + (inside revoke) re-folds the survivors.
    await handle.revoke(X.devicePubkey);
    expect(handle.admitted.has(xOwn.keyHex)).toBe(false);

    // BEHAVIOR-PIN #1: F-X is STILL present. The re-fold of the survivors does
    // not re-apply it, and revocation runs no compensating DELETE — already-
    // applied rows persist as LWW.
    expect(table.get('F-X')).toEqual({ id: 'F-X' });

    // ── X writes a NEW op after revocation. ──
    await xOwn.append({
      type: 'put', table: 'mb_a6_table', hbKey: 'F-X2',
      value: { id: 'F-X2' }, ts: 200, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: X.devicePubkey,
    });
    const appliedAfter = await handle.mergeNow();

    // BEHAVIOR-PIN #2: the post-revoke write does NOT appear — the revoked log is
    // out of the admitted set, so the merge never reads it.
    expect(appliedAfter).toBe(0);
    expect(table.has('F-X2')).toBe(false);
    // F-X is unchanged (still the pre-revoke row).
    expect(table.get('F-X')).toEqual({ id: 'F-X' });
    expect([...table.keys()]).toEqual(['F-X']);
  });
});
