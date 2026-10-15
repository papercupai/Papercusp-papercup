/**
 * revocation-propagation.test.ts — coverage for the REVOCATION / ADMISSION gaps
 * G7–G10 in the shared-hive substrate.
 *
 * These exercise the revoke ENFORCEMENT + propagation seams in `boot.ts` against
 * a REAL two-store rig (two Corestores, real replication, real signed announces,
 * real `onAnnounce` admission decider, real merge loop), with a CAPTURING apply
 * sink in place of PG (the boot.test.ts revocation pattern). The revoked-set seam
 * is `loadRevokedOverride: async () => Set<string>` — in production that closure
 * reads `harness_shared.contributors.revoked_pubkeys`; here a MUTABLE closure
 * models the published list, so flipping it + driving a merge reproduces the
 * PG-mediated cross-peer propagation path WITHOUT a testcontainer.
 *
 * Mapping to the surveyed gaps:
 *   G7 — A revoking pubkey X propagates to B (B drops X's log + refuses X's
 *        re-announce) via the merge-time `applyRevocationRefresh`. FINDING: the
 *        revoked list is LOCAL-PER-PEER (each peer loads its OWN PG row); true
 *        cross-peer propagation is mediated by federating the published
 *        `revoked_pubkeys` row → B's PG → B's loader. This test proves the
 *        ENFORCEMENT half on the peer whose loader returns X.
 *   G8 — re-admission after revocation. WI-193 fix: a pubkey whose revocation is
 *        REFRESH-SOURCED (came from the published list via the startup seed or
 *        applyRevocationRefresh — never from a live `revoke()` call) IS re-admitted
 *        once it is dropped from the published list and a refresh runs — no reboot
 *        required. A pubkey revoked via a LIVE `revoke()` call is never reconciled
 *        away by a refresh, even if the published list never named it (or later
 *        stops naming it) — only an explicit action can undo a live revoke.
 *   G9 — on revoke, the admitted log is dropped from the merge set but the
 *        underlying Hypercore SESSION opened by `openRemoteLog` is NOT closed —
 *        a (bounded, capped-at-peer-count) resource leak. Documented + asserted.
 *   G10 — admission-queue ↔ revocation race: an announce enqueued, then revoke(X)
 *        lands before the drain, must be SKIPPED by drainAdmissionQueue's
 *        re-check (boot.ts ~835).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests } from '../boot-history';
import { openOwnLog, type OwnLog } from '../peer-log';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
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
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** A real device identity + a stable injectable Ed25519 signer (so a re-announce
 *  uses the SAME device_pubkey that was revoked). */
function makeDevice(githubLogin: string, githubUserId: number) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  return {
    devicePubkey,
    githubUserId,
    githubLogin,
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

/** Pipe two Corestores' replication streams both ways (Stage-0 verified). */
function replicate(s1: Corestore, s2: Corestore): void {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
}

async function announceFor(device: ReturnType<typeof makeDevice>, logCoreKey: string): Promise<SignedAnnounce> {
  return buildAnnounce(
    {
      device_pubkey: device.devicePubkey,
      github_user_id: device.githubUserId,
      github_login: device.githubLogin,
      attestation_gist_id: 'gist-test',
      log_core_key: logCoreKey,
    },
    device.sign,
  );
}

/**
 * Stand up a real remote peer P: its own Corestore + writable log, replicated
 * into the host store so P's ops actually cross + merge. Returns the device,
 * its own log, and a writer that appends a put op.
 */
async function makeRemotePeer(
  hostStore: Corestore,
  login: string,
  userId: number,
  prefix: string,
): Promise<{
  device: ReturnType<typeof makeDevice>;
  ownLog: OwnLog;
  write: (id: string, ts: number) => Promise<void>;
}> {
  const peerDir = tmpDir(prefix);
  const peerStore = new Corestore(peerDir);
  cleanups.push(() => {
    void peerStore.close();
  });
  await peerStore.ready();
  const ownLog = await openOwnLog(peerStore);
  const device = makeDevice(login, userId);
  replicate(peerStore, hostStore);
  const write = async (id: string, ts: number) => {
    await ownLog.append({
      type: 'put',
      table: 'rev_prop_table',
      hbKey: id,
      value: { id },
      ts,
      schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: device.devicePubkey,
    });
  };
  return { device, ownLog, write };
}

interface HostOpts {
  slug: string;
  loadRevokedOverride: () => Promise<Set<string>>;
  writes: Array<{ id: string }>;
}

async function bootHost(o: HostOpts): Promise<BootedHarnessHandle> {
  const handle = await bootHarnessSubstrate({
    rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
    workspaceRoot: tmpDir(`mb-${o.slug}-`),
    workspaceId: 'ws-rev-prop',
    harnessSlug: o.slug,
    mergePollMs: 0, // drive mergeNow by hand
    pendingRetryMs: 0, // disable the retry timer
    reverifyIntervalMs: 0, // disable channel-2 reverify (drive nothing implicitly)
    loadRevokedOverride: o.loadRevokedOverride,
    verifyBindingOverride: async () => 'verified',
    applyOverride: async (op) => {
      if (op.table === 'rev_prop_table') o.writes.push(op.value as { id: string });
      return true;
    },
  });
  cleanups.push(() => handle.close());
  return handle;
}

/**
 * Drive merge cycles until `id` has merged, or the budget runs out. Returns
 * whether it arrived — the CALLER asserts, so the failure message stays local
 * to the invariant being proven.
 *
 * "Did this op federate?" is an EVENTUAL property against this real-swarm rig,
 * never a single-cycle one: `mergeNow()` replays what has ARRIVED, and an op
 * written a moment earlier on the peer store may still be in flight, so a lone
 * `await write(); await mergeNow(); expect(...).toContain(id)` is a race under
 * parallel load (WI-7089 — observed twice against 176 passes, both times as
 * `['X-1','X-1']` missing 'X-2': the log HAD re-merged, just without its newest
 * op yet).
 *
 * Only the POSITIVE question needs this. The negative one ("X must NOT
 * federate") needs no polling at all — extra cycles only give a forbidden op
 * more chances to appear, so its continued absence is a strictly stronger check.
 */
async function mergeUntilSeen(
  handle: BootedHarnessHandle,
  seen: () => Set<string>,
  id: string,
  { cycles = 50, gapMs = 100 }: { cycles?: number; gapMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < cycles; i++) {
    await handle.mergeNow();
    if (seen().has(id)) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return seen().has(id);
}

// ───────────────────────────────────────────────────────────────────────────
// G7 — revocation propagates (the enforcement half, on the peer whose published
// list now names X). Mirrors the production path where A's revoked_pubkeys row
// federates to B's PG and B's `loadRevoked` then returns X.
// ───────────────────────────────────────────────────────────────────────────
describe('G7 — published-revocation propagation enforces a drop at merge time', () => {
  it('X admitted + merging → published list grows to include X → next merge drops X and refuses its re-announce', async () => {
    const writes: Array<{ id: string }> = [];
    // The MUTABLE published-revocation list (models B loading its PG row each
    // refresh). Starts empty: X is a member in good standing.
    const published = new Set<string>();
    const handle = await bootHost({
      slug: 'g7-prop',
      loadRevokedOverride: async () => new Set(published),
      writes,
    });

    // X joins, writes, is admitted + merged.
    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g7-X-');
    await X.write('X-1', 100);
    const admit = await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(admit.admit).toBe(true);
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(true);
    expect(writes).toEqual([{ id: 'X-1' }]);

    // ── THE REVOCATION lands in the PUBLISHED list (federated from the
    // revoking owner). No direct handle.revoke() — this is the propagation
    // path: the loader now returns X. The next merge's applyRevocationRefresh
    // must discover it and drop X's log. ──
    published.add(X.device.devicePubkey);

    // X writes a NEW op; without propagation it would still merge.
    await X.write('X-2', 200);

    // Drive a merge: the cursor-unchanged refresh fires applyRevocationRefresh,
    // unioning the published set → discovers X → drops X's admitted log.
    await handle.mergeNow();
    expect(
      handle.admitted.has(X.ownLog.keyHex),
      'a propagated published revocation must drop X from the admitted set',
    ).toBe(false);
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // X's post-revocation op must NEVER reach the apply sink.
    const appliedAfter = await handle.mergeNow();
    expect(appliedAfter).toBe(0);
    expect(writes, "X's revoked-era op X-2 must not be applied").toEqual([{ id: 'X-1' }]);

    // And X's re-announce is now refused with reason 'revoked' (the decider
    // closes over the same in-memory `revoked` set the refresh unioned into).
    const re = await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(re).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);
  }, 30_000);

  it('a NON-revoked peer keeps merging across the same refresh that drops X (revocation is targeted)', async () => {
    const writes: Array<{ id: string }> = [];
    const published = new Set<string>();
    const handle = await bootHost({
      slug: 'g7-targeted',
      loadRevokedOverride: async () => new Set(published),
      writes,
    });

    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g7t-X-');
    const Y = await makeRemotePeer(handle.store, 'y-bob', 7, 'mb-g7t-Y-');
    await X.write('X-1', 100);
    await Y.write('Y-1', 110);
    await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    await handle.onAnnounce(await announceFor(Y.device, Y.ownLog.keyHex));
    // Use SET semantics throughout: dropping a revoked log mid-pass resets the
    // merge cursor (boot.ts log-removal invariant), so survivor ops re-fold
    // from index 0 → an idempotent re-UPSERT (a duplicate in this raw capture
    // sink, a no-op LWW write in production). We assert WHICH ids ever
    // appear, never how many times.
    const seen = () => new Set(writes.map((w) => w.id));
    expect([...seen()].sort()).toEqual(['X-1', 'Y-1']);

    // Revoke only X.
    published.add(X.device.devicePubkey);
    await handle.mergeNow();
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);
    expect(handle.admitted.has(Y.ownLog.keyHex)).toBe(true);

    // Y keeps federating; X does not — X-2 must NEVER appear; Y-2 must.
    await X.write('X-2', 200);
    await Y.write('Y-2', 210);
    // The INVARIANT is that Y-2 EVENTUALLY federates and X-2 NEVER does —
    // assert that, not single-cycle timing (see mergeUntilSeen).
    await mergeUntilSeen(handle, seen, 'Y-2');
    expect(seen().has('Y-2'), "Y's post-revocation op must federate").toBe(true);
    expect(seen().has('X-2'), "X's post-revocation op must NOT federate").toBe(false);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G8 — re-admission after revocation. WI-193 fix: applyRevocationRefresh now
// reconciles REFRESH-SOURCED revocations (never a live revoke() call) that have
// been dropped from the published list — no reboot required. A live revoke()
// is never undone by this reconciliation.
// ───────────────────────────────────────────────────────────────────────────
describe('G8 — un-revoke / re-admission (WI-193)', () => {
  it('dropping X from the published list + a refresh DOES re-admit X (refresh-sourced revocation, live handle, no reboot)', async () => {
    const writes: Array<{ id: string }> = [];
    const published = new Set<string>();
    const handle = await bootHost({
      slug: 'g8-unrevoke',
      loadRevokedOverride: async () => new Set(published),
      writes,
    });

    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g8u-X-');
    await X.write('X-1', 100);
    await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(true);

    // Revoke X via the published list + merge → dropped (refresh-sourced).
    published.add(X.device.devicePubkey);
    await handle.mergeNow();
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);
    const reWhileRevoked = await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(reWhileRevoked).toMatchObject({ admit: false, reason: 'revoked' });

    // ── UN-REVOKE: remove X from the published list (the owner reverses it). ──
    published.delete(X.device.devicePubkey);

    // A merge refresh re-loads the (now empty) published list. WI-193:
    // applyRevocationRefresh reconciles — X's revocation was refresh-sourced
    // (never a live revoke() call), so it is removed from `revoked`.
    await handle.mergeNow();

    // X re-announces: ADMITTED — no reboot required.
    const re = await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(
      re,
      'WI-193: a refresh-sourced revocation dropped from the published list must ' +
        're-admit the peer on a live handle, without a reboot.',
    ).toMatchObject({ admit: true });
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(true);

    // And X's ops merge again — an EVENTUAL property against the real swarm,
    // so drive cycles until X-2 arrives rather than assuming one merge is
    // enough (WI-7089; see mergeUntilSeen).
    await X.write('X-2', 200);
    const seen = () => new Set(writes.map((w) => w.id));

    // CONTROL (permanent): the poll must be able to return FALSE, or the
    // assertion below would pass no matter what the merge did. 'X-never' is
    // never written by anyone, so a bounded poll for it must give up.
    expect(
      await mergeUntilSeen(handle, seen, 'X-never', { cycles: 3, gapMs: 10 }),
      'mergeUntilSeen must give up on an op that was never written',
    ).toBe(false);

    await mergeUntilSeen(handle, seen, 'X-2');
    expect(seen().has('X-2'), "a re-admitted peer's NEW ops must federate again, not just its replayed backlog").toBe(
      true,
    );
  }, 30_000);

  it('a LIVE revoke() is NEVER reconciled away by a later refresh, even though the published list never named X', async () => {
    const writes: Array<{ id: string }> = [];
    // The published list never includes X — the revoke is purely a live,
    // in-process call (the owner-ban path, independent of the PG-mediated
    // published-list propagation).
    const handle = await bootHost({
      slug: 'g8-live-authoritative',
      loadRevokedOverride: async () => new Set(),
      writes,
    });

    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g8l-X-');
    await X.write('X-1', 100);
    await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(true);

    await handle.revoke(X.device.devicePubkey);
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);

    // Multiple refreshes over an (always-empty, X-never-named) published list
    // must NEVER un-revoke a live-revoked pubkey — reconciliation only ever
    // touches refresh-sourced entries, and X was never one.
    for (let i = 0; i < 3; i++) await handle.mergeNow();

    const re = await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(
      re,
      'a live revoke() must stay authoritative across any number of refreshes — ' +
        'never silently reconciled away just because the published list never named it.',
    ).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);
  }, 30_000);

  it('re-admission also still WORKS via a reboot (unchanged supported recovery path)', async () => {
    // Prove the ONLY re-admission path: rebooting with the published list no
    // longer naming X (the startup seed is the only place `revoked` is built
    // from scratch). This documents the supported recovery for G8.
    const writes: Array<{ id: string }> = [];
    // Boot 1: X is revoked from the start (seed includes X).
    const X = makeDevice('x-alice', 4242);
    const handle1 = await bootHost({
      slug: 'g8-reboot',
      loadRevokedOverride: async () => new Set([X.devicePubkey]),
      writes,
    });
    // (no remote replication needed: assert the decider refuses the announce.)
    const re1 = await handle1.onAnnounce(await announceFor(X, 'aa'.repeat(32)));
    expect(re1).toMatchObject({ admit: false, reason: 'revoked' });
    await handle1.close();
    // pop the close cleanup we just ran so afterEach doesn't double-close.
    cleanups.pop();

    // Boot 2 (the "reboot"): SAME workspace/slug, but the published list is now
    // clean. The startup seed builds an EMPTY revoked set → X is admissible.
    const handle2 = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('mb-g8-reboot2-'),
      workspaceId: 'ws-rev-prop',
      harnessSlug: 'g8-reboot',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(), // cleaned list
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => true,
    });
    cleanups.push(() => handle2.close());
    const re2 = await handle2.onAnnounce(await announceFor(X, 'bb'.repeat(32)));
    expect(re2.admit, 'after a reboot with X removed from the published list, X is re-admitted').toBe(true);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G9 — core eviction on revoke. revoke() drops the log from `admitted` but does
// NOT close the underlying Hypercore session openRemoteLog opened on the
// Corestore. We assert the observable enforcement (no more reads) AND surface
// the leak: a re-admit of the same key re-opens via the store cache (the core
// session was never closed).
// ───────────────────────────────────────────────────────────────────────────
describe('G9 — underlying core session on revoke (resource-leak finding)', () => {
  it('revoke() stops reads but the Corestore still tracks the core session (not closed) — leak documented', async () => {
    const writes: Array<{ id: string }> = [];
    const handle = await bootHost({
      slug: 'g9-core',
      loadRevokedOverride: async () => new Set(),
      writes,
    });

    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g9-X-');
    await X.write('X-1', 100);
    await handle.onAnnounce(await announceFor(X.device, X.ownLog.keyHex));
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(true);

    // Snapshot how many cores the Corestore tracks while X is admitted.
    const coresWhileAdmitted = trackedCoreCount(handle.store);

    await handle.revoke(X.device.devicePubkey);
    expect(handle.admitted.has(X.ownLog.keyHex)).toBe(false);

    // FINDING: revoke() does `admitted.delete(logKey)` only — it never closes
    // the Hypercore session that openRemoteLog opened. The Corestore still
    // tracks the same number of cores after revoke (the session lingers until
    // the whole store closes). This is a bounded leak (≤ peer count), not a
    // correctness bug — the merge loop no longer READS the dropped log, which
    // is the security-relevant property and IS enforced above.
    const coresAfterRevoke = trackedCoreCount(handle.store);
    // Verified shape: the probe returns a real count (own log + 1 remote = 2
    // while admitted, still 2 after revoke), so the assertion below is not
    // vacuously skipped on the Corestore version this repo pins.
    if (coresWhileAdmitted >= 0 && coresAfterRevoke >= 0) {
      expect(
        coresAfterRevoke,
        'FINDING: the revoked peer core session is not evicted from the Corestore (bounded leak)',
      ).toBe(coresWhileAdmitted);
    }

    // The security-relevant guarantee still holds: no new ops from X merge.
    await X.write('X-2', 200);
    const applied = await handle.mergeNow();
    expect(applied).toBe(0);
    expect(writes).toEqual([{ id: 'X-1' }]);
  }, 30_000);
});

/** Best-effort count of cores the Corestore is tracking. Corestore keeps an
 *  internal cache keyed by discovery-key; the exact field is version-dependent,
 *  so probe the known shapes and fall back to -1 (the test then skips the count
 *  assertion but still proves the enforcement half). */
function trackedCoreCount(store: unknown): number {
  const s = store as {
    cores?: Map<unknown, unknown> | { size?: number };
    _cores?: Map<unknown, unknown>;
  };
  const c = s.cores ?? s._cores;
  if (c && typeof (c as { size?: number }).size === 'number') {
    return (c as { size: number }).size;
  }
  return -1;
}

// ───────────────────────────────────────────────────────────────────────────
// G10 — admission-queue ↔ revocation race. An announce is enqueued (admitPeer
// pushes onto admissionQueue), revoke(X) lands before the drain, and
// drainAdmissionQueue's re-check (boot.ts ~835) must SKIP X so the revoked peer
// is never resurrected.
// ───────────────────────────────────────────────────────────────────────────
describe('G10 — admission-queue ↔ revoke race (drain re-checks revoked)', () => {
  it('revoke(X) between enqueue and drain → X is NOT admitted (drainAdmissionQueue skips it)', async () => {
    const writes: Array<{ id: string }> = [];
    // Drive the race by firing onAnnounce (which enqueues X via admitPeer then
    // awaits mergeNow) and revoke(X) CONCURRENTLY — no await between them. The
    // two passes interleave on the merge gate; whichever drains the queue,
    // drainAdmissionQueue's `revoked.has(frame.device_pubkey)` re-check
    // (boot.ts ~835) must skip X. The invariant under test: a revoke landing
    // while an admission is queued is honored at drain time — X is NEVER
    // resurrected, under any interleaving.
    const handle = await bootHost({
      slug: 'g10-race',
      loadRevokedOverride: async () => new Set(),
      writes,
    });

    const X = await makeRemotePeer(handle.store, 'x-alice', 4242, 'mb-g10-X-');
    await X.write('X-1', 100);
    const announce = await announceFor(X.device, X.ownLog.keyHex);

    // Fire the admission and the revoke CONCURRENTLY (no await between them).
    // onAnnounce → admitPeer pushes X onto admissionQueue then awaits mergeNow;
    // revoke adds X to `revoked` + awaits its own mergeNow. Whichever pass
    // drains the queue, drainAdmissionQueue re-checks `revoked` (boot.ts ~835)
    // and skips X. The race must NEVER end with X admitted.
    const [decision] = await Promise.all([handle.onAnnounce(announce), handle.revoke(X.device.devicePubkey)]);

    // X must not be in the admitted set regardless of interleaving.
    expect(
      handle.admitted.has(X.ownLog.keyHex),
      'a revoke racing an admission must never resurrect the revoked peer',
    ).toBe(false);
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // Defensive merge: still nothing from X.
    await X.write('X-2', 200);
    await handle.mergeNow();
    expect(
      writes.some((w) => w.id.startsWith('X')),
      'no X op may merge',
    ).toBe(false);

    // The onAnnounce decision itself is either a refusal ('revoked') or an
    // admit that the drain then dropped — either way X ends NOT admitted.
    if (decision.admit === false) {
      expect(decision.reason).toBe('revoked');
    }
  }, 30_000);

  it('pre-revoked peer: onAnnounce is refused at the decider (queue never reached)', async () => {
    // The simpler ordering: X is already revoked when the announce arrives.
    // The decider refuses BEFORE admitPeer enqueues — proves the first gate.
    const writes: Array<{ id: string }> = [];
    const X = makeDevice('x-alice', 4242);
    const handle = await bootHost({
      slug: 'g10-pre',
      loadRevokedOverride: async () => new Set([X.devicePubkey]),
      writes,
    });
    const decision = await handle.onAnnounce(await announceFor(X, 'cc'.repeat(32)));
    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has('cc'.repeat(32))).toBe(false);
  }, 30_000);
});
