/**
 * admit-merge-gate.test.ts — audit P-022 (EI-115/EI-116 contributor).
 *
 * Three contracts around peer admission:
 *
 *  1. SERIALIZED ADMISSION: an announce arriving while a merge pass is in
 *     flight is queued and drained under the merge gate — the admitted-set is
 *     never mutated mid-pass, and the awaited onAnnounce resolves only after
 *     the admission was actually processed (the coalescing mergeNow re-runs
 *     the pass instead of dropping the request on the floor).
 *  2. 'admitted' EVENT: handle.onAdmitted fires once per newly-admitted remote
 *     log (no 100ms polling), and not again on a duplicate announce.
 *  3. PENDING-RETRY RE-ENTRANCY: the retry loop is a sequential setTimeout
 *     chain — a slow tick can never overlap the next one (the old bare
 *     setInterval(async …) double-processed pending peers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';
import * as hivePolicyStore from '../../../hive-policy-store';
import * as federatedPotScope from '../../../federated-pot-scope';

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  // WI-10007530: these fixtures have no PG policy store, and since the merge pass stopped
  // swallowing a failed policy read (so a failure leaves the pass unapplied and retryable),
  // the unit real-PG guard failed EVERY pass here. Model a successful absent-policy read —
  // the same stub boot.test.ts uses — rather than reintroducing the swallow.
  const policyRead = vi.spyOn(hivePolicyStore, 'getHivePolicyCached').mockResolvedValue(null);
  const rosterRead = vi.spyOn(federatedPotScope, 'listHiveMembersForLocalPot').mockResolvedValue([]);
  cleanups.push(() => { policyRead.mockRestore(); rosterRead.mockRestore(); });
});

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

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair. */
async function validAnnounce(logCoreKey: string): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: logCoreKey,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

describe('admission is serialized with the merge gate (audit P-022)', () => {
  it('an announce mid-merge is queued, drained under the gate, and admitted before the awaited onAnnounce resolves', async () => {
    // applyOverride gate: the first apply BLOCKS until released, pinning the
    // merge pass open while the announce arrives.
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((r) => (releaseApply = r));
    let applies = 0;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-gate-'),
      workspaceId: 'ws-gate-1',
      harnessSlug: 'gate-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => {
        applies++;
        if (applies === 1) await applyGate;
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // Give the merge pass real work so it blocks on the apply gate.
    await handle.append({
      type: 'put',
      table: 'perf-rep',
      hbKey: 'k-block',
      value: { v: 1 },
      ts: Date.now(),
      schema_version: 1,
    });
    const mergeInFlight = handle.mergeNow(); // blocks on apply #1

    // While the pass is pinned open: announce a peer. The admission must NOT
    // land mid-pass…
    const logCoreKey = 'ab'.repeat(32);
    const frame = await validAnnounce(logCoreKey);
    const announced = handle.onAnnounce(frame);
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.admitted.has(logCoreKey)).toBe(false); // queued, not raced in

    // …but once the pass releases, the coalesced re-run drains the queue, so
    // the awaited onAnnounce observes its admission complete.
    releaseApply();
    const decision = await announced;
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    await mergeInFlight;
  });

  it("onAdmitted fires exactly once per newly-admitted peer (and not on a duplicate announce)", async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-evt-'),
      workspaceId: 'ws-evt-1',
      harnessSlug: 'evt-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());

    const events: Array<{ logKeyHex: string; admittedSize: number }> = [];
    const off = handle.onAdmitted((info) => events.push(info));

    const logCoreKey = 'cd'.repeat(32);
    const frame = await validAnnounce(logCoreKey);
    await handle.onAnnounce(frame);
    expect(events).toEqual([{ logKeyHex: logCoreKey, admittedSize: 2 }]); // own log + peer

    // A duplicate announce re-records identity but admits nothing new → no event.
    await handle.onAnnounce(frame);
    expect(events).toHaveLength(1);

    // Unsubscribed listeners stop firing.
    off();
    const frame2 = await validAnnounce('ef'.repeat(32));
    await handle.onAnnounce(frame2);
    expect(events).toHaveLength(1);
  });
});

describe('merge-pass watchdog (WI-10003427)', () => {
  it('a wedged pass records merge_stalled naming its stage, and a queued announce records announce_admission_stalled', async () => {
    // Every admission drains INSIDE a merge pass, so a pass that never settles used to
    // starve admission with ZERO signal (no admitted/rejected/pending line; verdict
    // "healthy"). Pin a pass open at its incremental merge and prove both detectors fire.
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    cleanups.push(() => errSpy.mockRestore());
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((r) => (releaseApply = r));
    let applies = 0;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-watchdog-'),
      workspaceId: 'ws-watchdog-1',
      harnessSlug: 'watchdog-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      mergePassStallMs: 40,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: async () => {
        applies++;
        if (applies === 1) await applyGate;
        return true;
      },
    });
    cleanups.push(() => handle.close());
    await handle.append({
      type: 'put',
      table: 'perf-rep',
      hbKey: 'k-wedge',
      value: { v: 1 },
      ts: Date.now(),
      schema_version: 1,
    });
    const mergeInFlight = handle.mergeNow(); // pinned open on apply #1
    const logCoreKey = 'cd'.repeat(32);
    const announced = handle.onAnnounce(await validAnnounce(logCoreKey));
    // 40ms first fire, re-armed at 80ms: by ~200ms both detectors have fired.
    await new Promise((r) => setTimeout(r, 200));
    expect(handle.admitted.has(logCoreKey)).toBe(false);

    const scope = { workspaceId: 'ws-watchdog-1', harnessSlug: 'watchdog-1' };
    const stalled = listBootHistory({ ...scope, kinds: ['merge_stalled'] });
    expect(stalled.length).toBeGreaterThanOrEqual(2); // first fire + at least one re-arm
    expect(stalled[stalled.length - 1]!.message).toMatch(/stage 'incremental-merge'/);
    const admissionStalled = listBootHistory({ ...scope, kinds: ['announce_admission_stalled'] });
    expect(admissionStalled).toHaveLength(1);
    expect(admissionStalled[0]!.message).toMatch(/cdcdcdcd/);
    expect(admissionStalled[0]!.message).toMatch(/blocked behind merge pass in flight \d+s at stage 'incremental-merge'/);
    expect(errors.some((l) => l.includes('MERGE PASS STALL'))).toBe(true);
    expect(errors.some((l) => l.includes('ADMISSION STALL'))).toBe(true);

    // Release: the pass settles (merge_stall_cleared), the coalesced follower drains the
    // queue, and the announce is admitted — the watchdog never cancels anything.
    releaseApply();
    expect(await announced).toEqual({ admit: true });
    await mergeInFlight;
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    expect(listBootHistory({ ...scope, kinds: ['merge_stall_cleared'] })).toHaveLength(1);
    const firesAtRelease = listBootHistory({ ...scope, kinds: ['merge_stalled'] }).length;
    await new Promise((r) => setTimeout(r, 120));
    // Timers cleared on settle: no further stall events, and a healthy pass stays silent.
    expect(listBootHistory({ ...scope, kinds: ['merge_stalled'] })).toHaveLength(firesAtRelease);
  });

  it('a healthy pass records nothing', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-watchdog-ok-'),
      workspaceId: 'ws-watchdog-2',
      harnessSlug: 'watchdog-2',
      mergePollMs: 0,
      pendingRetryMs: 0,
      mergePassStallMs: 150,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());
    const logCoreKey = 'ef'.repeat(32);
    const announce = await validAnnounce(logCoreKey);
    // WI-10007519: fake ONLY the watchdogs' clock. The pass's real I/O still runs at real speed,
    // so a healthy pass that is merely SLOW on a loaded box can no longer cross the threshold by
    // wall-clock alone (CI, 1 of 32 runs: merge_stalled + announce_admission_stalled +
    // merge_stall_cleared at "0s", stage 'drain-admissions'). Time past the threshold is advanced
    // explicitly, AFTER the pass settles — which is the property under test: timers armed for a
    // settled pass/admission are cleared, so nothing fires once time does pass.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      expect(await handle.onAnnounce(announce)).toEqual({ admit: true });
      // Well past the 150ms threshold AND its doubled re-arm.
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }
    const scope = { workspaceId: 'ws-watchdog-2', harnessSlug: 'watchdog-2' };
    expect(
      listBootHistory({ ...scope, kinds: ['merge_stalled', 'merge_stall_cleared', 'announce_admission_stalled'] }),
    ).toHaveLength(0);
  });
});

describe('pending-retry re-entrancy (audit P-022)', () => {
  it('a slow retry tick never overlaps the next one (sequential rescheduling)', async () => {
    // verifyBinding: 'pending' forever, but SLOW (60ms) from the second call —
    // far slower than the 15ms retry cadence. The old setInterval stacked
    // ticks; the setTimeout chain must keep concurrency at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-reent-'),
      workspaceId: 'ws-reent-1',
      harnessSlug: 'reent-1',
      mergePollMs: 0,
      pendingRetryMs: 15,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls > 1) await new Promise((r) => setTimeout(r, 60));
        inFlight--;
        return 'pending';
      },
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());

    // Seed one pending peer (first verify call is fast).
    const frame = await validAnnounce('a1'.repeat(32));
    const decision = await handle.onAnnounce(frame);
    expect(decision).toEqual({ admit: false, reason: 'pending' });

    // Poll until the sequential retry chain has ticked several times, rather
    // than sleeping a fixed 250ms and asserting a count. A fixed wall-clock
    // sleep is flaky: on a loaded/oversubscribed gate host the retry timers are
    // starved, so fewer ticks complete in the window and the count undercounts
    // (observed: only 2 ticks in 250ms → gate red). Waiting for the CONDITION
    // keeps the real timers + real re-entrancy behavior under test while
    // decoupling from host load. The invariant that actually matters — a slow
    // tick never overlaps the next (maxInFlight === 1) — holds however long the
    // individual ticks take under load.
    const deadline = Date.now() + 4000;
    while (calls < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls).toBeGreaterThanOrEqual(3); // the chain IS still retrying
    expect(maxInFlight).toBe(1); // …but never concurrently
  }, 20_000);
});
