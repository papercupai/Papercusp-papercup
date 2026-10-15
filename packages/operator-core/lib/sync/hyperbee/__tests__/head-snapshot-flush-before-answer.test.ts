/**
 * WI-37553 / EI-20019309044931698 — the on-demand head snapshot must be FLUSHED out of the
 * RocksDB memtable before `produceHeadSnapshotNow()` answers `appended: true`.
 *
 * WHY THIS GUARD EXISTS. The only caller of that path is the seed CUTTER, which appends a
 * head snapshot via the live operator and then opens the SAME store READ-ONLY, from a
 * separate process, seconds later. A read-only RocksDB open sees flushed SSTs, never the
 * writer's memtable — so the freshest blocks (the snapshot chunks just written) are exactly
 * the ones it cannot see. Measured 2026-08-09 against the live papercusp store: a COMPLETE,
 * in-window 44-chunk snapshot set read as ABSENT to that open (0 read timeouts, 24ms
 * slowest get — the blocks were not slow, they were not in the view), so computeSparseFrom
 * fell back to "ship FULL history" and seed-degradation-guard refused a 5.62 GB seed ~52
 * minutes into a release cut.
 *
 * Reporting `appended: true` while the data is invisible to the caller is a SILENT DEGRADE,
 * which is the one failure mode servicePendingHeadSnapshot's contract already forbids.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed and takes a governor-receipt census before a head snapshot
 * (WI-10003060), but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override these defaults through the existing seams.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({
    rekeyDepsOverride: null,
    loadOwnCompactionGovernorReceiptKeys: async () => [],
    // Snapshot flushing does not exercise mem0 federation. Bind the existing
    // flag reader so an unavailable production override store cannot affect it.
    memoryFederationFlagOn: async () => false,
    ...opts,
  });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wi37553-flush-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return dir;
}

async function bootWithOps(slug: string, opCount: number) {
  const handle = await bootHarnessSubstrate({
    workspaceRoot: tmpWorkspaceRoot(),
    workspaceId: 'ws-wi37553',
    harnessSlug: slug,
    mergePollMs: 0,
    loadRevokedOverride: async () => new Set(),
    applyOverride: async () => true,
  });
  cleanups.push(() => handle.close());
  for (let i = 0; i < opCount; i++) {
    await handle.append({
      type: 'put',
      table: 'wi37553_table',
      hbKey: `K-${i}`,
      value: { id: `K-${i}` },
      ts: 1000 + i,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  }
  return handle;
}

/** The corestore's internal storage handle — untyped by corestore, narrowed at the boundary. */
function storageOf(handle: { store: unknown }): { readOnly?: boolean; flush: () => Promise<void> } {
  return (handle.store as { storage: { readOnly?: boolean; flush: () => Promise<void> } }).storage;
}

describe('produceHeadSnapshotNow flushes before answering (WI-37553)', () => {
  it('FLUSHES the store before resolving, so a separate read-only open can see the snapshot', async () => {
    const handle = await bootWithOps('flush-happy', 5);
    const storage = storageOf(handle);

    // Order matters, not just occurrence: a flush AFTER the answer would still leave the
    // caller racing the memtable, which is the bug. Record when each happened.
    const events: string[] = [];
    const realFlush = storage.flush.bind(storage);
    vi.spyOn(storage, 'flush').mockImplementation(async () => {
      events.push('flush');
      await realFlush();
    });

    const snap = await handle.produceHeadSnapshotNow();
    events.push('resolved');

    expect(snap.appended).toBe(true);
    expect(events).toEqual(['flush', 'resolved']);
  });

  it('does NOT flush when nothing was appended — an empty log writes no degenerate snapshot', async () => {
    const handle = await bootWithOps('flush-empty', 0);
    const storage = storageOf(handle);
    const flush = vi.spyOn(storage, 'flush');

    const snap = await handle.produceHeadSnapshotNow();

    expect(snap.appended).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it('REJECTS when the flush fails instead of reporting a snapshot the caller cannot read', async () => {
    // THE CONTROL FOR THE SILENT DEGRADE. If this ever resolves, the cutter is being told
    // `appended: true` for data it may not be able to see — the exact 52-minute failure.
    const handle = await bootWithOps('flush-fails', 5);
    const storage = storageOf(handle);
    vi.spyOn(storage, 'flush').mockImplementation(async () => {
      throw new Error('simulated rocksdb flush failure');
    });

    await expect(handle.produceHeadSnapshotNow()).rejects.toThrow(/simulated rocksdb flush failure/);
  });

  it('fails LOUDLY if corestore stops exposing storage.flush, rather than silently skipping it', async () => {
    // A silent skip on a corestore upgrade would invisibly re-create the original bug.
    const handle = await bootWithOps('flush-missing', 5);
    const store = handle.store as unknown as { storage: unknown };
    const realStorage = store.storage;
    store.storage = { readOnly: false }; // no flush()
    cleanups.push(() => {
      store.storage = realStorage;
    });

    await expect(handle.produceHeadSnapshotNow()).rejects.toThrow(/storage\.flush is not available/);
  });

  // NOTE ON COVERAGE, so the gap is stated rather than implied. The end-to-end property the
  // cutter actually depends on — "after appended:true, a FRESH read-only open in a SEPARATE
  // process resolves the snapshot set" — is NOT asserted here. It needs a second process
  // against a store the live writer is still churning, which this in-process harness cannot
  // reproduce faithfully (a small tmp log is visible even unflushed, so an in-process
  // version would pass with AND without the fix — a guard that cannot fail).
  //
  // That property is verified out-of-band instead, against the real live store, by
  // /tmp/papercusp-release-0014/probe-fresh-snapshot-visibility.ts — which is what produced
  // the ENOENT evidence in EI-20019309044931698. The four cases above pin the MECHANISM
  // (flush happens, happens BEFORE the answer, is skipped when nothing was appended, and
  // can never be silently skipped); the probe pins the OUTCOME.
});
