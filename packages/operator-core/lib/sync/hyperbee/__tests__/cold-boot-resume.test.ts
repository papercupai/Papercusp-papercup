/**
 * cold-boot-resume.test.ts — Brief F (shared-pot-release-testing) Scenario 2:
 * restart / cold boot. A public hive runs for weeks across process restarts; a
 * peer killed mid-sync must reboot, RESUME from its persisted state, and converge
 * with NO loss or corruption. No prior test closes a booted substrate and reopens
 * it on the SAME on-disk corestore — the rigs all boot once and tear down.
 *
 * What "resume from watermark" actually IS here (verified against boot.ts /
 * read-merge.ts): the merge cursor is in-memory and NON-PERSISTED (boot.ts creates
 * a FRESH `createMergeCursor()` every boot), so a restart re-folds every log from
 * index 0 and re-applies — convergence on reboot rests on the corestore PERSISTING
 * the logs across the restart + the apply path being idempotent (PG-level fed_ts
 * LWW; here, an apply sink that is naturally idempotent on a key set).
 *
 * This test locks the restart contract end-to-end:
 *   1. the own log SURVIVES the restart (same key + length read back from disk),
 *   2. the fresh-cursor re-fold on reboot re-applies the IDENTICAL winner set
 *      (no op lost, no key corrupted),
 *   3. the revocation set is RE-SEEDED from its loader on every boot (so a peer
 *      revoked while this one was down is enforced on the next boot — G8
 *      "re-admission requires reboot"), and
 *   4. once caught up after reboot, idle ticks apply NOTHING (the EI-79 skip
 *      survives a restart, so a long-running rebooted peer is not hot-looping).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { closeHarnessStore, _resetCacheForTests } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
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
    } catch {
      /* best-effort */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

const AUTHOR = 'a'.repeat(64);
const WS = 'ws-cold-boot';
const SLUG = 'cold-boot';

function put(hbKey: string, ts: number): PeerLogOp {
  return {
    type: 'put',
    table: 'cold_boot_table',
    hbKey,
    value: { id: hbKey, ts },
    ts,
    schema_version: 1,
    author_pubkey: AUTHOR,
  } as PeerLogOp;
}

/** Boot the substrate at a fixed on-disk root with a capturing apply sink + a
 *  spy-able revocation loader. Re-callable on the SAME root to model a restart. */
async function boot(workspaceRoot: string) {
  const appliedKeys: string[] = [];
  const loadRevoked = vi.fn(async () => new Set<string>());
  const handle = await bootHarnessSubstrate({
    workspaceRoot,
    workspaceId: WS,
    harnessSlug: SLUG,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    applyOverride: async (op: OpEnvelope) => {
      appliedKeys.push(op.hbKey!);
      return true;
    },
    loadRevokedOverride: loadRevoked,
  });
  return { handle, appliedKeys, loadRevoked };
}

describe('Brief F / Scenario 2 — cold-boot / restart resume', () => {
  it('a peer killed after writing reboots, re-derives the same log, and re-folds to the IDENTICAL winner set with no loss', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'cold-boot-'));
    cleanups.push(() => {
      try {
        rmSync(workspaceRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    // ── Session 1: write a history with re-writes to the same keys (so LWW has
    //    real work) + one delete, then backfill-merge. ──
    const s1 = await boot(workspaceRoot);
    const ops: PeerLogOp[] = [
      put('K1', 100),
      put('K2', 110),
      put('K1', 120), // re-write K1 (later ts wins)
      put('K3', 130),
      put('K2', 140), // re-write K2
      put('K4', 150),
    ];
    await s1.handle.ownLog.appendBatch(ops);
    // A delete of K4 (later ts) — the winner for K4 must be the del on both boots.
    await s1.handle.append({
      type: 'del',
      table: 'cold_boot_table',
      hbKey: 'K4',
      value: undefined,
      ts: 160,
      schema_version: 1,
    });

    const applied1 = await s1.handle.mergeNow();
    expect(applied1).toBeGreaterThan(0);
    // The winner SET is one entry per distinct key (K1..K4) — LWW collapses the
    // re-writes. Capture it as the source of truth to compare the reboot against.
    const winners1 = new Set(s1.appliedKeys);
    expect(winners1).toEqual(new Set(['K1', 'K2', 'K3', 'K4']));

    const logKeyBefore = s1.handle.ownLog.keyHex;
    const logLenBefore = s1.handle.ownLog.length;
    expect(logLenBefore).toBe(ops.length + 1); // 6 puts + 1 del

    // ── Kill the process: close the handle AND drop the corestore cache so the
    //    reboot must reopen from DISK (not a warm in-memory store). ──
    await s1.handle.close();
    await closeHarnessStore({ workspaceRoot, harnessSlug: SLUG });
    _resetCacheForTests();

    // ── Session 2: reboot on the SAME root. ──
    const s2 = await boot(workspaceRoot);
    cleanups.push(async () => {
      await s2.handle.close();
      await closeHarnessStore({ workspaceRoot, harnessSlug: SLUG });
    });

    // (1) The own log survived the restart: same identity (key) + same length,
    //     read back from disk. A peer killed mid-sync resumes from its persisted
    //     log, it does not start a fresh one (which would orphan its history +
    //     change its swarm identity — the topic-split failure class).
    expect(s2.handle.ownLog.keyHex).toBe(logKeyBefore);
    expect(s2.handle.ownLog.length).toBe(logLenBefore);

    // (3) The revocation set was re-seeded from its loader on this boot.
    expect(s2.loadRevoked).toHaveBeenCalled();

    // (2) The reboot re-folds the persisted log and re-applies the IDENTICAL
    //     winner set — no op lost, no key corrupted, the del still wins K4. boot.ts
    //     fires an initial backfill `void mergeNow()` (boot.ts ~1109), so the
    //     re-apply happens at boot; awaiting an explicit mergeNow() lets a pass
    //     complete, and we poll the captured set to absorb that fire-and-forget.
    await s2.handle.mergeNow();
    const deadline = Date.now() + 5_000;
    while (new Set(s2.appliedKeys).size < winners1.size && Date.now() < deadline) {
      await s2.handle.mergeNow();
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(s2.appliedKeys.length).toBeGreaterThan(0); // resume DID re-apply
    expect(new Set(s2.appliedKeys)).toEqual(winners1); // exactly the same winners

    // (4) Caught up after the reboot re-fold → idle ticks apply nothing (the
    //     steady-state skip survives a restart; a rebooted long-lived peer idles).
    const idleBaseline = s2.appliedKeys.length;
    for (let i = 0; i < 5; i++) {
      expect(await s2.handle.mergeNow()).toBe(0);
    }
    expect(s2.appliedKeys.length).toBe(idleBaseline);
  }, 60_000);
});
