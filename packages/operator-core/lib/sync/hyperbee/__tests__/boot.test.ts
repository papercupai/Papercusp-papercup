/**
 * bootHarnessSubstrate — composer tests (Model B, Stage 4a).
 *
 * Covers:
 *   - Argument validation (workspaceRoot / workspaceId / harnessSlug).
 *   - Schema-version alert event subscription / unsubscription.
 *   - The Model B handle shape: `ownLog.keyHex` + `mergeNow` + `admitted`
 *     (NOT the retired Autobase `base`).
 *   - The single-peer path: own writes → mergeNow → PG projection.
 *
 * The single-peer test uses a real Corestore over a tmp dir (mirrors
 * peer-log.test.ts) + a capturing projection sink (no real PG), with the
 * merge poll-timer disabled so the test drives `mergeNow()` by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  onSchemaVersionAlert,
  type BootHarnessOpts,
} from '../boot';
import { schemaVersionEvents, type SchemaVersionAlert, CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { openOwnLog, type RemoteLog } from '../peer-log';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import type { HyperswarmLike } from '../swarm';
import { _clearRegistryForTests } from '../projection';
import { listBootHistory, _resetBootHistoryForTests, type BootHistoryKind } from '../boot-history';
import type { AdmittedLog, MergeCursorStore } from '../read-merge';
import { produceLogSnapshot } from '../log-snapshot';
import {
  setReplicationStallEpisodeReporterForTests,
  setReplicationStallRecoveryReporterForTests,
  sampleReplicationLiveness,
  dropReplicationLogState,
} from '../replication-liveness';
import * as hivePolicyStore from '../../../hive-policy-store';
import * as hiveMemberIdentity from '../hive-member-identity-set';
import * as federatedPotScope from '../../../federated-pot-scope';
import type { HivePolicy } from '../../../hive-policy-schema';

/**
 * Keep this composer suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair —
 *  `verifyAnnounce(frame)` (real crypto, runs inside boot's onAnnounce) returns
 *  true for this frame. log_core_key is a real 64-hex key boot can openRemoteLog. */
async function validAnnounce(over: Partial<SignedAnnounce> = {}): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: 'cc'.repeat(32),
    ...over,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
}

function makeFakeSwarm(): HyperswarmLike {
  return {
    join: () => ({ flushed: async () => {}, refresh: () => {} }),
    leave: () => {},
    on: () => {},
    off: () => {},
    connections: [],
  };
}

const joinUnitIsolation = {
  potHomeSlugForHarnessOverride: async () => null,
  scopedStoreOverride: async () => {
    throw new Error('scoped-log layer not exercised');
  },
};

function makeAnnounceIdentityOverride(githubLogin: string, githubUserId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId: githubUserId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: githubUserId, login: githubLogin }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${githubLogin}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  // These composer fixtures have no PG policy store. Model a successful
  // absent-policy read explicitly; a failed read must now block the merge.
  const policyRead = vi.spyOn(hivePolicyStore, 'getHivePolicyCached').mockResolvedValue(null);
  const rosterRead = vi.spyOn(federatedPotScope, 'listHiveMembersForLocalPot').mockResolvedValue([]);
  cleanups.push(() => { policyRead.mockRestore(); rosterRead.mockRestore(); });
});

afterEach(async () => {
  schemaVersionEvents.removeAllListeners();
  _clearRegistryForTests();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
  // WI-183 flaky-test fix: boot-history is a module-level append-only buffer
  // (cap 200, no per-test scoping beyond the workspaceId/harnessSlug filter
  // callers apply on read) — every other piece of cross-test module state in
  // this file gets an explicit reset above, but boot-history did not, so any
  // event recorded during a test (including from a prior FAILED/aborted run
  // sharing this worker process, e.g. under `vitest --retry` or watch-mode
  // re-execution) could persist into a later test's `listBootHistory()` read.
  // Resetting it here closes that isolation gap for every describe block in
  // this file, not just the WI-183 one that surfaced it.
  _resetBootHistoryForTests();
});

describe('bootHarnessSubstrate — validation', () => {
  it('rejects missing workspaceRoot', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '', workspaceId: 'w', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceRoot/);
  });

  it('rejects missing workspaceId', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: '', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceId/);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: 'w', harnessSlug: '' }),
    ).rejects.toThrow(/harnessSlug/);
  });
});

describe('bootHarnessSubstrate — Model B handle shape + single-peer merge', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('exposes ownLog.keyHex + mergeNow + admitted, NOT base', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      mergePollMs: 0, // disable the poll timer; drive mergeNow by hand
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
    });
    cleanups.push(() => handle.close());

    expect(handle.ownLog.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof handle.mergeNow).toBe('function');
    expect(handle.admitted.get(handle.ownLog.keyHex)).toBe(handle.ownLog);
    // The retired Autobase `base` is gone.
    expect((handle as unknown as { base?: unknown }).base).toBeUndefined();
    expect(handle.swarm).toBeNull();
  });

  it('single-peer: own writes flow through mergeNow into the projection sink', async () => {
    // Capture applied ops via the applyOverride seam. The scoped per-harness
    // apply (buildHarnessProjectionApply) deliberately does NOT consult the
    // global registry (D-021 collision fix), so tests inject their own sink.
    const writes: unknown[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's2',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      applyOverride: async (op) => {
        if (op.table === 'mb_test_table') writes.push(op.value);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await handle.append({
      type: 'put',
      table: 'mb_test_table',
      hbKey: 'F-1',
      value: { id: 'F-1' },
      ts: 1000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    expect(handle.ownLog.length).toBe(1);

    const applied = await handle.mergeNow();
    expect(applied).toBe(1);
    expect(writes).toEqual([{ id: 'F-1' }]);
  });

  it('policy lookup failure blocks apply without advancing the cursor, then retries after recovery', async () => {
    const policyRead = vi.spyOn(hivePolicyStore, 'getHivePolicyCached').mockResolvedValue(null);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => { policyRead.mockRestore(); errors.mockRestore(); });
    const writes: unknown[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-policy-read',
      harnessSlug: 'policy-read-retry',
      ...joinUnitIsolation,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      applyOverride: async (op) => { writes.push(op.value); return true; },
    });
    cleanups.push(() => handle.close());
    await handle.mergeNow();
    await handle.append({
      type: 'put', table: 'mb_test_table', hbKey: 'policy-read-row',
      value: { id: 'policy-read-row' }, ts: 1000, schema_version: CURRENT_SCHEMA_VERSION,
    });

    policyRead.mockRejectedValue(new Error('owner policy unavailable'));
    expect(await handle.mergeNow()).toBe(0);
    expect(writes).toEqual([]);
    expect(listBootHistory({ workspaceId: 'ws-policy-read', harnessSlug: 'policy-read-retry' }).some(
      (event) => event.kind === 'merge_error' && event.message?.includes('owner policy unavailable'),
    )).toBe(true);

    // A successful absent-policy lookup is permissive; an error is not.
    policyRead.mockResolvedValue(null);
    expect(await handle.mergeNow()).toBe(1);
    expect(writes).toEqual([{ id: 'policy-read-row' }]);
    expect(await handle.mergeNow()).toBe(0);
    expect(writes).toHaveLength(1);
  });

  // ── registerCloseHook (Stage 5 outbox-drain teardown seam) ──────────────────
  it('registerCloseHook: close() runs the hook once, before store teardown; unregister cancels it', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's-hook',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
    });

    let ran = 0;
    handle.registerCloseHook(() => {
      ran += 1;
    });
    // A second, unregistered hook must NOT run.
    let cancelled = 0;
    const off = handle.registerCloseHook(() => {
      cancelled += 1;
    });
    off();

    await handle.close();
    expect(ran).toBe(1); // registered hook ran exactly once
    expect(cancelled).toBe(0); // unregistered hook never ran

    // close() is idempotent — a second close does not re-run the hook.
    await handle.close();
    expect(ran).toBe(1);
  });

  it('registerCloseHook: a throwing hook is swallowed (teardown still completes)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpWorkspaceRoot(),
        workspaceId: 'ws-1',
        harnessSlug: 's-hook-throw',
        mergePollMs: 0,
        loadRevokedOverride: async () => new Set(),
      });
      handle.registerCloseHook(() => {
        throw new Error('hook boom');
      });
      // close() must resolve despite the throwing hook.
      await expect(handle.close()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('close-hook failed'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('bootHarnessSubstrate — WI-3985 memory gate cursor recovery', () => {
  const MEMORY_TABLE = 'p2p-memories-by-id';
  const OTHER_TABLE = 'wi3985-unrelated-table';

  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-wi3985-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  function bindingStore(): {
    store: MergeCursorStore;
    loads: Array<string | null>;
    rows: Map<string, { position: number; binding: string | null }>;
  } {
    const rows = new Map<string, { position: number; binding: string | null }>();
    const loads: Array<string | null> = [];
    return {
      rows,
      loads,
      store: {
        async load(binding) {
          loads.push(binding);
          const out = new Map<string, number>();
          for (const [keyHex, row] of rows) {
            if (row.binding === binding) out.set(keyHex, row.position);
          }
          return out;
        },
        async save(positions, binding) {
          for (const [keyHex, position] of positions) {
            rows.set(keyHex, { position, binding });
          }
        },
      },
    };
  }

  async function appendWitnessOps(handle: Awaited<ReturnType<typeof bootHarnessSubstrate>>) {
    await handle.append({
      type: 'put',
      table: MEMORY_TABLE,
      hbKey: 'memory-1',
      value: { id: 'memory-1', shareable: true },
      ts: 1_000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    await handle.append({
      type: 'put',
      table: OTHER_TABLE,
      hbKey: 'other-1',
      value: { id: 'other-1' },
      ts: 1_001,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
  }

  it('OFF advances normally, live ON replays only memory once, then returns idle', async () => {
    const persisted = bindingStore();
    let enabled = false;
    const applied: string[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi3985-live',
      harnessSlug: 'wi3985-live',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => enabled,
      applyOverride: async (op) => {
        if (op.table === MEMORY_TABLE && !enabled) return false;
        applied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await appendWitnessOps(handle);
    expect(await handle.mergeNow()).toBe(1);
    expect(applied).toEqual([OTHER_TABLE]);

    enabled = true;
    expect(await handle.mergeNow()).toBe(1);
    expect(applied).toEqual([OTHER_TABLE, MEMORY_TABLE]);
    expect([...persisted.rows.values()]).toEqual([
      expect.objectContaining({ binding: '<none>::mem0-federation-egress=on' }),
    ]);

    expect(await handle.mergeNow()).toBe(0);
    expect(applied).toEqual([OTHER_TABLE, MEMORY_TABLE]);
  });

  it('live ON snapshot-seeds the memory replay cursor instead of scanning summarized history', async () => {
    let enabled = false;
    const applied: string[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi3985-snapshot',
      harnessSlug: 'wi3985-snapshot',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      memoryFederationFlagOn: async () => enabled,
      applyOverride: async (op) => {
        if (op.table === MEMORY_TABLE && !enabled) return false;
        applied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await handle.append({
      type: 'put',
      table: MEMORY_TABLE,
      hbKey: 'memory-before-snapshot',
      value: { id: 'memory-before-snapshot', shareable: true },
      ts: 2_000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    for (let i = 0; i < 32; i++) {
      await handle.append({
        type: 'put',
        table: OTHER_TABLE,
        hbKey: `prefix-${i}`,
        value: { i },
        ts: 2_001 + i,
        schema_version: CURRENT_SCHEMA_VERSION,
      });
    }
    await handle.mergeNow();

    const snapshot = await produceLogSnapshot(handle.ownLog, {
      now: 3_000,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(snapshot.appended).toBe(true);
    await handle.append({
      type: 'put',
      table: OTHER_TABLE,
      hbKey: 'tail-after-snapshot',
      value: { tail: true },
      ts: 3_001,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    await handle.mergeNow();

    const originalGet = handle.ownLog.get.bind(handle.ownLog);
    const readIndexes: number[] = [];
    vi.spyOn(handle.ownLog, 'get').mockImplementation(async (index) => {
      readIndexes.push(index);
      return originalGet(index);
    });

    const appliedBeforeEnable = applied.length;
    enabled = true;
    expect(await handle.mergeNow()).toBe(1);
    expect(applied.slice(appliedBeforeEnable)).toEqual([MEMORY_TABLE]);
    expect(readIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...readIndexes)).toBeGreaterThanOrEqual(snapshot.coversUpTo);
  });

  it('cold boot ON resumes from OFF-stamped progress and replays only the missed memory (WI-10005575)', async () => {
    // WI-10005575: before, a stamp mismatch re-folded EVERY log from 0 (on the tower, an
    // 8M-op own log re-walked for hours, re-applying 1.4M-row snapshot sets). Now the
    // main fold resumes from the OFF-stamped position and only memory is replayed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const workspaceRoot = tmpWorkspaceRoot();
    const persisted = bindingStore();
    let enabled = false;
    const firstApplied: string[] = [];
    const first = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi3985-cold',
      harnessSlug: 'wi3985-cold',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => enabled,
      applyOverride: async (op) => {
        if (op.table === MEMORY_TABLE && !enabled) return false;
        firstApplied.push(op.table!);
        return true;
      },
    });
    try {
      await appendWitnessOps(first);
      await first.mergeNow();
      expect(firstApplied).toEqual([OTHER_TABLE]);
      expect([...persisted.rows.values()]).toEqual([
        expect.objectContaining({ binding: null, position: 2 }),
      ]);
    } finally {
      await first.close();
    }

    enabled = true;
    const secondApplied: string[] = [];
    const second = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi3985-cold',
      harnessSlug: 'wi3985-cold',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => enabled,
      applyOverride: async (op) => {
        secondApplied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => second.close());
    await second.mergeNow();

    expect(secondApplied).toContain(MEMORY_TABLE);
    expect(secondApplied).not.toContain(OTHER_TABLE);
    expect(persisted.loads).toContain('<none>::mem0-federation-egress=on');
    expect(persisted.loads).toContain(null);
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes('WI-10005575: seeded 1 log(s)')),
    ).toBe(true);
  });

  it('cold boot whose flag read degrades to OFF resumes from ON-stamped progress (WI-10005575)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const persisted = bindingStore();
    const workspaceRoot = tmpWorkspaceRoot();
    const first = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi10005575-degraded',
      harnessSlug: 'wi10005575-degraded',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => true,
      applyOverride: async () => true,
    });
    try {
      await appendWitnessOps(first);
      await first.mergeNow();
      expect([...persisted.rows.values()]).toEqual([
        expect.objectContaining({ binding: '<none>::mem0-federation-egress=on', position: 2 }),
      ]);
    } finally {
      await first.close();
    }

    // The production read (getFlag) serves the dark default OFF when a fresh boot's
    // override-store read times out; model that as a flag read that throws.
    const secondApplied: string[] = [];
    const second = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi10005575-degraded',
      harnessSlug: 'wi10005575-degraded',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => {
        throw new Error('flag backend timed out after 2000ms');
      },
      applyOverride: async (op) => {
        secondApplied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => second.close());
    await second.mergeNow();

    expect(secondApplied).toEqual([]);
    expect(persisted.loads).toEqual(expect.arrayContaining([null, '<none>::mem0-federation-egress=on']));
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes("stamped '<none>::mem0-federation-egress=on'")),
    ).toBe(true);
  });

  it('a mid-run flag read that degrades holds the last authoritative value — no binding flip, no memory replay (WI-10005919)', async () => {
    // WI-10005919: a degraded read used to become an ordinary OFF. One bad read mid-run
    // cancelled the memory replay and flipped the apply binding; the next good read then
    // looked like a live OFF→ON edge and replayed every memory op from 0.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const persisted = bindingStore();
    let readFails = false;
    const applied: string[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi10005919-hold',
      harnessSlug: 'wi10005919-hold',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => {
        if (readFails) throw new Error('flag backend timed out after 2000ms');
        return true;
      },
      applyOverride: async (op) => {
        applied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await appendWitnessOps(handle);
    expect(await handle.mergeNow()).toBe(2);

    readFails = true;
    expect(await handle.mergeNow()).toBe(0);
    readFails = false;
    // The behavioural discriminator: a spurious OFF→ON edge would replay memory-1 here.
    expect(await handle.mergeNow()).toBe(0);
    expect(applied).toEqual([MEMORY_TABLE, OTHER_TABLE]);
    expect([...persisted.rows.values()]).toEqual([
      expect.objectContaining({ binding: '<none>::mem0-federation-egress=on', position: 2 }),
    ]);
    expect(
      warn.mock.calls.some(
        (args) => String(args[0]).includes('WI-10005919') && String(args[0]).includes('holding ON'),
      ),
    ).toBe(true);
  });

  it('a degraded boot read that no pass consumed is not an OFF state — the first good read starts no replay (WI-10005919)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    const persisted = bindingStore();
    const workspaceRoot = tmpWorkspaceRoot();
    const first = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi10005919-boot',
      harnessSlug: 'wi10005919-boot',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => true,
      applyOverride: async () => true,
    });
    try {
      await appendWitnessOps(first);
      await first.mergeNow();
    } finally {
      await first.close();
    }

    // Only the BOOT read degrades; every pass read is good and ON, as is the progress
    // persisted by the first boot. Nothing was skipped under OFF, so nothing is owed.
    let reads = 0;
    const secondApplied: string[] = [];
    const second = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId: 'ws-wi10005919-boot',
      harnessSlug: 'wi10005919-boot',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      mergeCursorStore: persisted.store,
      memoryFederationFlagOn: async () => {
        reads += 1;
        if (reads === 1) throw new Error('flag backend timed out after 2000ms');
        return true;
      },
      applyOverride: async (op) => {
        secondApplied.push(op.table!);
        return true;
      },
    });
    cleanups.push(() => second.close());
    await second.mergeNow();

    expect(secondApplied).toEqual([]);
    expect(
      warn.mock.calls.some(
        (args) => String(args[0]).includes('WI-10005919') && String(args[0]).includes('boot read degraded'),
      ),
    ).toBe(true);
  });
});

describe('bootHarnessSubstrate — onAnnounce admit/reject (Stage 4b/4c, Fix 6)', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-ann-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('a VALID + admitted announce → remote log lands in admitted + mergeNow runs', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-1',
      mergePollMs: 0, // disable the poll so the only merge is onAnnounce's
      pendingRetryMs: 0, // disable the retry timer too
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      // binding check returns 'verified' → a valid-sig announce is admitted.
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const beforeKeys = [...handle.admitted.keys()];
    expect(beforeKeys).toEqual([handle.ownLog.keyHex]); // only the own log

    const frame = await validAnnounce({ log_core_key: 'cc'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(true);
    // The peer's remote log is now in the admitted set, keyed by its log_core_key.
    expect(handle.admitted.has('cc'.repeat(32))).toBe(true);
    const remote = handle.admitted.get('cc'.repeat(32))!;
    expect(remote.keyHex).toBe('cc'.repeat(32));
    expect(remote).not.toBe(handle.ownLog);
  });

  it('a REJECTED announce (binding fails) → not added, admit:false', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      // binding check returns 'fail' → not admitted (reason binding_invalid).
      verifyBindingOverride: async () => 'fail',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'dd'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(false);
    expect(handle.admitted.has('dd'.repeat(32))).toBe(false);
    // Only the own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
  });

  it('a FORGED announce (bad sig) → reason bad_sig, binding never consulted', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-3',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: verifyBinding,
    });
    cleanups.push(() => handle.close());

    // Tamper the sig so verifyAnnounce (real crypto) fails.
    const frame = await validAnnounce({ log_core_key: 'ee'.repeat(32) });
    const forged: SignedAnnounce = { ...frame, sig: Buffer.from('tampered').toString('base64') };
    const decision = await handle.onAnnounce(forged);

    expect(decision).toMatchObject({ admit: false, reason: 'bad_sig' });
    // The sig check short-circuits before the binding check.
    expect(verifyBinding).not.toHaveBeenCalled();
    expect(handle.admitted.has('ee'.repeat(32))).toBe(false);
  });

  it('admitting the same announce twice is idempotent (one remote log)', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-4',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'ab'.repeat(32) });
    await handle.onAnnounce(frame);
    const first = handle.admitted.get('ab'.repeat(32));
    await handle.onAnnounce(frame);
    const second = handle.admitted.get('ab'.repeat(32));
    expect(second).toBe(first); // same handle, not re-opened
    expect(handle.admitted.size).toBe(2); // own + the one peer
  });

  it('WI-38376: a verified advertised writer high-water exposes a frozen replica without reading beyond local length', async () => {
    const workspaceId = 'ws-announce-high-water';
    const harnessSlug = 'ann-high-water';
    const keyHex = 'a7'.repeat(32);
    const episodes: Array<{ kind: string; stalledStage?: string; detail: string }> = [];
    setReplicationStallEpisodeReporterForTests((episode) => {
      episodes.push(episode);
    });
    setReplicationStallRecoveryReporterForTests(() => {});
    cleanups.push(() => {
      setReplicationStallEpisodeReporterForTests(null);
      setReplicationStallRecoveryReporterForTests(null);
    });

    const reads = vi.fn(async () => null);
    const sessions: Array<RemoteLog & { close: ReturnType<typeof vi.fn> }> = [];
    const openRemoteLogOverride = vi.fn(async (_store: unknown, k: string) => {
      const remote: RemoteLog & { close: ReturnType<typeof vi.fn> } = {
        keyHex: k,
        // The receiver has delivered NOTHING. The advertised high-water must
        // inform liveness without ever being copied into this local length.
        length: 0,
        contiguousLength: 0,
        get: reads,
        update: async () => {},
        prefetch: () => {},
        has: async () => false,
        close: vi.fn(async () => {}),
        peersCount: () => 1,
      };
      sessions.push(remote);
      return remote;
    });

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      openRemoteLogOverride,
      // Detection is immediate, while confirmation keeps its normal separate
      // window so this regression owns only the initial repair decision.
      replicationStallGraceMs: 60_000,
      frozenGraceMs: 0,
    });
    cleanups.push(() => handle.close());

    const decision = await handle.onAnnounce(
      await validAnnounce({ log_core_key: keyHex, log_length: 12 }),
    );
    expect(decision).toEqual({ admit: true });
    expect(episodes).toEqual([
      expect.objectContaining({
        kind: 'frozen',
        stalledStage: 'transport',
        detail: expect.stringContaining('writer at 12, merged to 0'),
      }),
    ]);
    expect(reads).not.toHaveBeenCalled();

    // A diagnostic episode cannot bypass the progress owner's fixed deadline.
    await handle.mergeNow();
    expect(openRemoteLogOverride).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.close).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(
      listBootHistory({
        workspaceId,
        harnessSlug,
        kinds: ['replication_repair' as BootHistoryKind],
      }),
    ).toHaveLength(0);
  });
});

describe('bootHarnessSubstrate — WI-789 owner bootstrap admission', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-wi789-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  const WORKSPACE_ID = 'ws-wi789';
  const JOINER_MEMBER_SLUG = 'joined-owner-repo';
  const OWNER_MEMBER_SLUG = 'owner-repo';
  const POT_HOME_SLUG = 'owner-repo-home';
  const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');

  it('repro: gh-attested out-of-scope owner/member announce buffers when the joiner roster is empty', async () => {
    const ownerUserId = 9401;
    const joiner = makeAnnounceIdentityOverride('joiner', 9402, 'kc-wi789-joiner');
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const loadHiveMembers = vi.fn(async () => [] as string[]);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: verifyBinding,
      loadHiveMembersOverride: loadHiveMembers,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner',
      attestation_gist_id: 'gist-owner',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f1'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    expect(verifyBinding).toHaveBeenCalledWith(
      frame.device_pubkey,
      'owner',
      ownerUserId,
      'gist-owner',
    );
    expect(loadHiveMembers).toHaveBeenCalledWith(POT_HOME_SLUG);
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  it('control: the same production path admits once the owner/member device is in hive_members', async () => {
    const ownerUserId = 9501;
    const joiner = makeAnnounceIdentityOverride('joiner-control', 9502, 'kc-wi789-joiner-control');
    let ownerDevicePubkey = '';
    const loadHiveMembers = vi.fn(async (_hiveHome: string) =>
      ownerDevicePubkey ? [ownerDevicePubkey] : [],
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: loadHiveMembers,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-control',
      attestation_gist_id: 'gist-owner-control',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f2'.repeat(32),
    });
    ownerDevicePubkey = frame.device_pubkey;

    const decision = await handle.onAnnounce(frame);

    expect(loadHiveMembers).toHaveBeenCalledWith(POT_HOME_SLUG);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // WI-787 — the FIX. The owner-log bootstrap admit (boot.ts resolveSameHiveMember) trusts
  // the ONE device the signed, gh-verified hive-announce binds to the joined hive_pubkey
  // (`ownerDeviceForHiveOverride`; prod reads the verified hive_directory_cache binding), so
  // the owner's own log is admitted BEFORE the empty roster can deadlock — breaking WI-780.
  it('FIX: a gh-attested owner bootstrap announce admits on an empty roster via the signed owner-device binding (WI-787/WI-780)', async () => {
    const ownerUserId = 9601;
    const joiner = makeAnnounceIdentityOverride('joiner-desired', 9602, 'kc-wi789-joiner-desired');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async (_hivePubkey: string) => ownerDevice || null);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // roster still empty — the WI-780 condition
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-desired',
      attestation_gist_id: 'gist-owner-desired',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f3'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the signed owner_device_pubkey for this hive

    const decision = await handle.onAnnounce(frame);

    // Admitted via the owner-device binding, gated on THIS joined hive's pubkey.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // WI-797 — the SECOND half of the keystone (the FIX above only worked when the gist gate
  // PASSED). The owner-bootstrap used to run only AFTER the identity decider's gist gate, so
  // when the owner's OWN announce fails that gate (verifyBinding → 'fail' / binding_invalid —
  // the routine fresh-join window where the owner's live attestation gist is not yet resolvable)
  // the frame was CONCLUSIVELY rejected before the bootstrap could rescue it, and content never
  // crossed (witnessed live on the fed-a/fed-b rig: every owner HOME announce → binding_invalid).
  // The fix hoists the owner-device bootstrap into the IDENTITY stage (admitsAsKnownHiveMember),
  // so it admits BEFORE — and independently of — the gist gate.
  it('FIX (WI-797): owner bootstrap admits even when the gist gate REJECTS (binding_invalid), via the signed owner-device binding', async () => {
    const ownerUserId = 9611;
    const joiner = makeAnnounceIdentityOverride('joiner-797', 9612, 'kc-wi797-joiner');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async (_hivePubkey: string) => ownerDevice || null);
    // The gist gate CONCLUSIVELY fails (gist unresolvable in the fresh-join window) — pre-fix
    // this rejected the owner's own log before the bootstrap could run.
    const verifyBinding = vi.fn(async () => 'fail' as const);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: verifyBinding,
      loadHiveMembersOverride: async () => [], // empty roster — the WI-780/797 condition
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-797',
      attestation_gist_id: 'gist-owner-797',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'a7'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the signed owner_device_pubkey bound to this hive

    const decision = await handle.onAnnounce(frame);

    // Admitted at the IDENTITY stage via the owner-device binding — the failing gist gate is
    // bypassed for the bound owner device. Pre-fix this returned { admit:false, binding_invalid }.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);

    // WI-40604: this bootstrap admission bypasses the channel-2 gist check, so
    // the reverify sweep must not evict it when that check conclusively fails.
    verifyBinding.mockClear();
    await handle.reverifyAdmitted();
    await handle.mergeNow();
    expect(verifyBinding).not.toHaveBeenCalled();
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // ADVERSARIAL (WI-797) — the gist-gate bypass is strictly scoped to the bound owner device.
  // A NON-owner device whose gist gate ALSO fails must still be conclusively rejected
  // (binding_invalid), never admitted — the hoist must not widen the gate to any failing frame.
  it('ADVERSARIAL (WI-797): a non-owner device whose gist gate fails stays rejected binding_invalid', async () => {
    const ownerUserId = 9711;
    const joiner = makeAnnounceIdentityOverride('joiner-797-adv', 9712, 'kc-wi797-joiner-adv');
    const boundOwnerDevice = Buffer.alloc(32, 0x4b).toString('base64');
    const ownerDeviceForHive = vi.fn(async () => boundOwnerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId, // claims the owner's gh id …
      github_login: 'spoof-797',
      attestation_gist_id: 'gist-spoof-797',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'b7'.repeat(32),
    });
    // … but is NOT the bound owner device, so the bypass refuses it and the failing gist
    // gate's conclusive verdict stands.
    expect(frame.device_pubkey).not.toBe(boundOwnerDevice);

    const decision = await handle.onAnnounce(frame);

    expect(decision).toEqual({ admit: false, reason: 'binding_invalid' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // D-053 — the owner-device bootstrap is NOT gated on a kind:'hive' swarmBinding. A real
  // invite/link joiner boots on a kind:'topic' binding (a /api/harness/join-link carries the
  // Hive's TOPIC HASH, not its pubkey, so it cannot rebuild a `hive:` binding) and MUST still
  // bootstrap-admit the owner — recovering the owner device from the VERIFIED hive-directory
  // cache by deriving each cached hive's topic and matching `topic_hex` (ownerDeviceForTopic).
  // This was the live cross-machine RECEIVE-side blocker (D-052): a topic-bound empty-roster
  // joiner admitted NOTHING (0 roster/epoch/content) because the bypass only read
  // `swarmBinding.hive_pubkey`. STILL fail-closed: no verified directory binding ⇒ no bypass.
  it('FIX (D-053): a topic-kind binding bootstrap-admits the owner via the verified directory owner-device-for-topic binding (fail-closed without one)', async () => {
    const ownerUserId = 9721;
    const joiner = makeAnnounceIdentityOverride('joiner-053-topic', 9722, 'kc-053-joiner-topic');
    let ownerDevice = '';
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice || null);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'a'.repeat(64) }, // invite/link joiner — no hive_pubkey
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate REJECTS — only the bootstrap can admit
      loadHiveMembersOverride: async () => [], // EMPTY roster (fresh join)
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-053-topic',
      attestation_gist_id: 'gist-053-topic',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'c7'.repeat(32),
    });

    // FAIL-CLOSED: no verified directory owner-device-for-topic binding ⇒ no bypass ⇒ rejected.
    ownerDevice = '';
    const rejected = await handle.onAnnounce(frame);
    expect(rejected.admit).toBe(false);
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    // FIX: once the verified directory binding resolves the owner device for THIS topic, the
    // topic-bound joiner bootstrap-admits the owner — gist gate failing + empty roster and all.
    ownerDevice = frame.device_pubkey;
    const admitted = await handle.onAnnounce(frame);
    expect(admitted.admit).toBe(true);
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
    expect(ownerDeviceForTopic).toHaveBeenCalled();
  });

  // WI-1544 (round-1 live REJECT) — an identity-stage `binding_invalid` inside the join-
  // bootstrap window (a hive/topic-bound JOINER whose hive-home has not resolved yet) must
  // BUFFER, not conclusively reject. Live-pinned on the WI-1544 Docker-frames rig: the owner's
  // log announces raced the hive-directory descriptor by milliseconds → ownerDeviceForTopic
  // resolved <null> → gist gate 'fail' → binding_invalid → PERMANENT drop (announces are never
  // re-delivered); the rekey resolved the home two log-lines later with nothing left to replay.
  // Reverting the onAnnounce reclassify branch flips this RED (reason binding_invalid, no
  // binding_unverified_window buffer event).
  it('FIX (WI-1544): binding_invalid during the join-bootstrap window BUFFERS (pending), never conclusive', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-buf', 9742, 'kc-1544-joiner-buf');

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'b'.repeat(64) }, // invite/link joiner mid-bootstrap
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0, // assert the BUFFER decision in isolation
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate conclusively rejects (rig: unattested device)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => null, // directory descriptor NOT yet arrived (the race)
      joinerPotHomeSlugOverride: async () => null, // hive-home UNRESOLVED — the pre-rekey window
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9741,
      github_login: 'owner-1544',
      attestation_gist_id: 'gist-1544',
      harness_slug: OWNER_MEMBER_SLUG, // the owner's hive-home-candidate log
      log_core_key: 'e4'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    // THE FIX: retryable, buffered — pre-fix this was { admit:false, reason:'binding_invalid' }.
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    const pending = listBootHistory({
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_pending'],
    });
    expect(pending.some((e) => (e.message ?? '').includes('binding_unverified_window'))).toBe(true);
    const rejected = listBootHistory({
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_rejected'],
    });
    expect(rejected.filter((e) => (e.message ?? '').includes('binding_invalid'))).toEqual([]);
  });

  // WI-38344 — the join-pot path can resolve the hive-home before the substrate boot
  // receives its first announce. The retry safety net must remain armed for this joiner:
  // a transient binding_invalid is still retryable even though the home slug is already
  // known. Before the fix, the home-null predicate below closed the window and this test
  // returned a conclusive binding_invalid instead of pending.
  it('REGRESSION (WI-38344): binding_invalid BUFFERS when a joiner home is already resolved', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-38344-resolved', 9832, 'kc-38344-resolved');

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi38344-resolved',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'e'.repeat(64) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0, // assert the initial BUFFER decision in isolation
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate conclusively rejects
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => null,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG, // resolved at boot, not rekey
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9831,
      github_login: 'owner-38344',
      attestation_gist_id: 'gist-38344',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'e8'.repeat(32),
    });

    expect(await handle.onAnnounce(frame)).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    const pending = listBootHistory({
      workspaceId: 'ws-wi38344-resolved',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_pending'],
    });
    expect(pending.some((e) => (e.message ?? '').includes('binding_unverified_window'))).toBe(true);
    expect(
      listBootHistory({
        workspaceId: 'ws-wi38344-resolved',
        harnessSlug: JOINER_MEMBER_SLUG,
        kinds: ['announce_rejected'],
      }).filter((e) => (e.message ?? '').includes('binding_invalid')),
    ).toEqual([]);
  });

  // WI-1544 recovery half — the buffered frame is ADMITTED by the retry tick once the verified
  // directory owner-device binding resolves (the descriptor that lost the race arrives moments
  // later), while the window is still open. Uses a same-slug frame (the owner's log for the
  // SHARED harness — the content log that was probe=0 on the rig) so scope resolves without the
  // rekey; the buffer→rekey-replay leg for a hive-home-slug frame is exercised live by the
  // WI-1544 matrix (same scoping rationale as a003-scope-buffer-replay.test.ts).
  it('FIX (WI-1544): a window-buffered frame is admitted by the retry tick once the owner-device binding resolves', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-retry', 9752, 'kc-1544-joiner-retry');
    let ownerDevice: string | null = null;
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-retry',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'c'.repeat(64) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20, // fast retry — the recovery path under test
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate keeps failing (rig: device never attested)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerPotHomeSlugOverride: async () => null,
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9751,
      github_login: 'owner-1544-r',
      attestation_gist_id: 'gist-1544-r',
      harness_slug: JOINER_MEMBER_SLUG, // the owner's log for the SHARED harness (in-scope once identity passes)
      log_core_key: 'f5'.repeat(32),
    });

    // Directory not yet populated → buffered, not rejected.
    expect(await handle.onAnnounce(frame)).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    // The descriptor arrives (the verified directory binding now resolves the owner device) —
    // the next retry tick owner-bootstraps the buffered frame despite the failing gist gate.
    ownerDevice = frame.device_pubkey;
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(ownerDeviceForTopic).toHaveBeenCalled();
  });

  // WI-1544 ROOT CAUSE #2 (round-1 live, the SECOND stall) — the pending buffer was keyed by
  // device_pubkey, but ONE device announces MULTIPLE logs on the same topic (A-003: the owner's
  // member log + the hive-home log share a device). Every buffer site guarded
  // `if (!pendingPeers.has(device_pubkey))`, so the SECOND log of the pair was silently never
  // stored (its reclassify still returned 'pending' — misleadingly), the retry tick could only
  // ever admit ONE log per device, and the content log stayed probe=0 on the rig. The buffer is
  // now keyed by log_core_key. Reverting flips this RED: the second waitFor times out because
  // its frame was never buffered.
  it('FIX (WI-1544 #2): TWO logs announced by ONE device both buffer in the window and both admit on retry', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-two', 9762, 'kc-1544-joiner-two');
    let ownerDevice: string | null = null;
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-two',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'd'.repeat(64) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate keeps failing (rig: device never attested)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerPotHomeSlugOverride: async () => null,
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // ONE device keypair, TWO signed announces with distinct log_core_keys (the rig pair: the
    // owner's member log + the hive-home log, broadcast on the one shared topic).
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const devicePubkey = rawPubkeyBase64(publicKey);
    const signer = async (bytes: Buffer) => nodeSign(null, bytes, privateKey);
    const shared = {
      device_pubkey: devicePubkey,
      github_user_id: 9761,
      github_login: 'owner-1544-two',
      attestation_gist_id: 'gist-1544-two',
      harness_slug: JOINER_MEMBER_SLUG, // both in-scope once identity resolves (same rationale as the retry test above)
    };
    const frameA = await buildAnnounce({ ...shared, log_core_key: 'a6'.repeat(32) }, signer);
    const frameB = await buildAnnounce({ ...shared, log_core_key: 'b7'.repeat(32) }, signer);

    // Window open, directory unresolved → BOTH frames report pending (pre-fix the second ALSO
    // said 'pending' but was never actually stored — the misleading half of the bug).
    expect(await handle.onAnnounce(frameA)).toEqual({ admit: false, reason: 'pending' });
    expect(await handle.onAnnounce(frameB)).toEqual({ admit: false, reason: 'pending' });

    // The descriptor arrives → the retry tick must admit BOTH logs, not just the first.
    ownerDevice = devicePubkey;
    await vi.waitFor(
      () => {
        expect(handle.admitted.has(frameA.log_core_key)).toBe(true);
        expect(handle.admitted.has(frameB.log_core_key)).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
  });

  /** Minimal in-range-empty RemoteLog replica — the drain only needs the handle to exist
   *  (admitted.set); a length-0 replica makes every subsequent merge pass a no-op. */
  function fakeRemoteLog(keyHex: string): RemoteLog {
    return {
      keyHex,
      length: 0,
      contiguousLength: 0,
      get: async () => null,
      update: async () => {},
      prefetch: () => {},
      has: async () => false,
    };
  }

  // WI-1544 ROOT CAUSE #3 (the nondeterministic one-shot silent loss) — a throw inside the
  // merge-gated admission drain (e.g. openRemoteLog racing a rekey) happened AFTER the frame
  // was shift()'d off the admission queue, and the catch was ring-only: announces are never
  // re-delivered (sender-side sentKeys dedup), so a single throw permanently stalled every
  // A→B surface until a restart. The drain catch now RE-BUFFERS the frame into the D-006
  // pending set so the retry tick re-runs the full admission. Reverting the re-buffer flips
  // this RED: the waitFor times out because the frame is gone from every buffer.
  it('FIX (WI-1544 #3): a drain-time openRemoteLog throw re-buffers the frame; the retry tick admits it', async () => {
    // The fix is deliberately LOUD on stderr (the boot-history ring is in-memory only) —
    // capture + assert the line instead of letting fail-on-console treat it as a defect.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => consoleError.mockRestore());
    const joiner = makeAnnounceIdentityOverride('joiner-1544-drain', 9772, 'kc-1544-joiner-drain');
    let ownerDevice: string | null = null;
    const openRemoteLogOverride = vi.fn(async (_store: unknown, logKeyHex: string) => {
      if (openRemoteLogOverride.mock.calls.length === 1) {
        throw new Error('boom-drain-1544'); // the rekey race, deterministically
      }
      return fakeRemoteLog(logKeyHex);
    });

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-drain',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'e6'.repeat(32) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20, // the recovery path under test
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // owner bootstrap is the admitting gate
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => ownerDevice,
      joinerPotHomeSlugOverride: async () => null,
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
      openRemoteLogOverride,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9771,
      github_login: 'owner-1544-drain',
      attestation_gist_id: 'gist-1544-drain',
      harness_slug: JOINER_MEMBER_SLUG, // in-scope (same rationale as the retry test above)
      log_core_key: 'c8'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // owner bootstrap admits on FIRST announce

    // The admission decision is 'admit' (the decider passed) but the merge-gated drain threw —
    // the log must NOT be in `admitted`, and the frame must NOT be lost.
    await handle.onAnnounce(frame);
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
    const errors = listBootHistory({
      workspaceId: 'ws-wi1544-drain',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_error'],
    });
    expect(errors.some((e) => (e.message ?? '').includes('boom-drain-1544'))).toBe(true);

    // THE FIX: the re-buffered frame is re-admitted by the retry tick (pre-fix: lost forever).
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(openRemoteLogOverride.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The loss is loud on stderr, not ring-only (the other half of the #3 fix).
    expect(
      consoleError.mock.calls.some((args) =>
        String(args[0]).includes('re-buffered for retry: boom-drain-1544'),
      ),
    ).toBe(true);
  });

  // WI-1544 ROOT CAUSE #3, retry-tick half — the retry tick used to delete the pending entry
  // BEFORE the awaited admit, so a throw inside the drain during a RETRY lost the frame from
  // every buffer (the drain re-buffer guard sees the entry still present during a retry and
  // preserves it — so the tick's delete must be admit-FIRST and GATED on `admitted.has`).
  // Reverting either half (delete-before-admit, or an unconditional delete after) flips this
  // RED: the entry is erased on the first failed tick and the waitFor times out.
  it('FIX (WI-1544 #3): a pending entry survives drain failures across retry ticks until the admit lands', async () => {
    // Same rationale as above: the drain failure line on stderr is the fix's intended
    // behavior — capture it so fail-on-console doesn't misread it as a test defect.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => consoleError.mockRestore());
    const joiner = makeAnnounceIdentityOverride('joiner-1544-gate', 9782, 'kc-1544-joiner-gate');
    let ownerDevice: string | null = null;
    const openRemoteLogOverride = vi.fn(async (_store: unknown, logKeyHex: string) => {
      if (openRemoteLogOverride.mock.calls.length <= 2) {
        throw new Error('boom-retry-1544'); // fail the drain on the first TWO retry ticks
      }
      return fakeRemoteLog(logKeyHex);
    });

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-gate',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'f7'.repeat(32) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => ownerDevice,
      joinerPotHomeSlugOverride: async () => null,
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
      openRemoteLogOverride,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9781,
      github_login: 'owner-1544-gate',
      attestation_gist_id: 'gist-1544-gate',
      harness_slug: JOINER_MEMBER_SLUG,
      log_core_key: 'd9'.repeat(32),
    });

    // Directory unresolved → buffered pending (the WI-1544 window buffer).
    expect(await handle.onAnnounce(frame)).toEqual({ admit: false, reason: 'pending' });

    // The directory resolves → each retry tick re-runs the admission; the first two drains
    // throw. The entry must SURVIVE both failed ticks and admit on the third.
    ownerDevice = frame.device_pubkey;
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(openRemoteLogOverride.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // WI-1544 DEFECT D — the owner-device resolve read the BOOT-TIME `opts.swarmBinding`
  // snapshot, not the current binding: after a rekey() onto a new topic (every real joiner
  // rekeys — join-hive 2c), the bootstrap-admit consulted the directory for the OLD topic,
  // so the owner of the NEW hive never bootstrap-admitted. The resolve now reads the live
  // `currentBinding` that rekey() publishes FIRST. Reverting flips this RED: the directory
  // is consulted with the boot topic and the announce is never admitted.
  it('FIX (WI-1544 defect D): after rekey() the owner bootstrap consults the NEW topic, not the boot-time binding', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-rekey', 9792, 'kc-1544-joiner-rekey');
    const BOOT_TOPIC = 'a1'.repeat(32);
    const REKEY_TOPIC = 'b2'.repeat(32);
    let ownerDevice: string | null = null;
    // The verified directory binding exists ONLY for the rekey target topic.
    const ownerDeviceForTopic = vi.fn(async (topicHex: string) =>
      topicHex === REKEY_TOPIC ? ownerDevice : null,
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-rekey',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: BOOT_TOPIC },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0, // assert the onAnnounce decision in isolation
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // only the bootstrap can admit
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerPotHomeSlugOverride: async () => null,
      ...joinUnitIsolation,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // The join-hive 2c rekey onto the hive's real topic.
    await handle.rekey({ kind: 'topic', topic_hex: REKEY_TOPIC });

    const frame = await validAnnounce({
      github_user_id: 9791,
      github_login: 'owner-1544-rekey',
      attestation_gist_id: 'gist-1544-rekey',
      harness_slug: JOINER_MEMBER_SLUG,
      log_core_key: 'e0'.repeat(32),
    });
    ownerDevice = frame.device_pubkey;

    const decision = await handle.onAnnounce(frame);

    // THE FIX: the resolve keys off the CURRENT (rekeyed) topic → owner bootstrap admits.
    // Pre-fix it consulted BOOT_TOPIC → null → the announce buffered/rejected instead.
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
    expect(ownerDeviceForTopic).toHaveBeenCalledWith(REKEY_TOPIC);
    expect(ownerDeviceForTopic).not.toHaveBeenCalledWith(BOOT_TOPIC);
  });

  // ADVERSARIAL (WI-797) — a FORGED owner announce (bad sig) is refused at the sig check that
  // PRECEDES the bypass (admitsAsKnownHiveMember line 1: `if (!sigValid …) return false`). A
  // forger cannot produce a valid signature for the owner's pubkey without its private key, so
  // even a frame claiming the exact owner device never bootstraps; ownerDeviceForHive is never
  // consulted.
  it('ADVERSARIAL (WI-797): a forged (bad-sig) owner announce is refused bad_sig, bypass never reached', async () => {
    const ownerUserId = 9731;
    const joiner = makeAnnounceIdentityOverride('joiner-797-forge', 9732, 'kc-wi797-joiner-forge');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async () => ownerDevice || null);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-797-forge',
      attestation_gist_id: 'gist-797-forge',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd7'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the real owner device …
    const forged: SignedAnnounce = { ...frame, sig: Buffer.from('tampered').toString('base64') };

    const decision = await handle.onAnnounce(forged);

    // … but the signature is forged ⇒ refused before the bypass; ownerDeviceForHive untouched.
    expect(decision).toMatchObject({ admit: false, reason: 'bad_sig' });
    expect(ownerDeviceForHive).not.toHaveBeenCalled();
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 1 — the bootstrap admit is scoped to the EXACT bound device. A DIFFERENT
  // device (even one carrying the owner's github_user_id) must NOT ride the owner binding in;
  // with an empty roster it buffers (pending). Guards the WI-259 membership boundary against
  // admitting on github_user_id alone.
  it('ADVERSARIAL: a non-owner device with the owner github_user_id does NOT bootstrap-admit (still pending)', async () => {
    const ownerUserId = 9701;
    const joiner = makeAnnounceIdentityOverride('joiner-adv1', 9702, 'kc-wi789-joiner-adv1');
    // The binding resolves the REAL owner device — a fixed value unrelated to the spoofer's frame.
    const boundOwnerDevice = Buffer.alloc(32, 0x5a).toString('base64');
    const ownerDeviceForHive = vi.fn(async () => boundOwnerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // empty roster
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId, // claims the owner's gh id …
      github_login: 'owner-spoof',
      attestation_gist_id: 'gist-owner-spoof',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f4'.repeat(32),
    });
    // … but frame.device_pubkey !== boundOwnerDevice (different keypair), so the exact-device
    // gate refuses the bootstrap and the empty roster leaves it pending.
    expect(frame.device_pubkey).not.toBe(boundOwnerDevice);

    const decision = await handle.onAnnounce(frame);

    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 2 — fail-closed when there is NO verified owner-device binding for the hive
  // (e.g. no verified directory descriptor cached). Even the real owner device must buffer,
  // never admit on an unverified/absent binding.
  it('ADVERSARIAL: no verified owner-device binding ⇒ even the owner device buffers (fail-closed)', async () => {
    const ownerUserId = 9801;
    const joiner = makeAnnounceIdentityOverride('joiner-adv2', 9802, 'kc-wi789-joiner-adv2');
    const ownerDeviceForHive = vi.fn(async () => null); // no verified descriptor for this hive

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-noband',
      attestation_gist_id: 'gist-owner-noband',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f5'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    expect(ownerDeviceForHive).toHaveBeenCalled();
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 3 (WI-788 A2) — cross-hive binding attack: a frame arriving on hive Y's
  // substrate must NOT be admitted using hive X's owner-device binding. The lookup key is
  // opts.swarmBinding.hive_pubkey (server-local config, NOT attacker-controlled — a
  // SignedAnnounce carries no hive_pubkey), so a frame from hive X's owner resolves
  // ownerDeviceForHive(Y) → null → no bootstrap → pending (empty roster). Locks the scoping
  // invariant against a future refactor that might thread a frame-supplied hive_pubkey in.
  it('ADVERSARIAL: owner device of hive X cannot bootstrap-admit onto a substrate joined to hive Y', async () => {
    const ownerUserId = 9901;
    const joiner = makeAnnounceIdentityOverride('joiner-adv3', 9902, 'kc-wi789-joiner-adv3');

    const HIVE_PUBKEY_X = Buffer.alloc(32, 0x0a).toString('base64'); // the attacker's hive
    const HIVE_PUBKEY_Y = Buffer.alloc(32, 0x0b).toString('base64'); // THIS substrate's hive

    let ownerDeviceOfHiveX = '';
    // The cache has a binding ONLY for hive X; hive Y has none.
    const ownerDeviceForHive = vi.fn(async (hivePubkey: string) =>
      hivePubkey === HIVE_PUBKEY_X ? ownerDeviceOfHiveX || null : null,
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY_Y }, // joined to hive Y
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // empty roster on hive Y
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-hivex',
      attestation_gist_id: 'gist-owner-hivex',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f6'.repeat(32),
    });
    ownerDeviceOfHiveX = frame.device_pubkey; // this device legitimately owns hive X

    const decision = await handle.onAnnounce(frame);

    // The lookup is keyed on the SERVER-LOCAL joined hive (Y), never the frame.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY_Y);
    // No binding for Y ⇒ no bootstrap; empty roster ⇒ pending, never admitted.
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 4 (WI-788 A2) — revoked owner device: even when the owner-device binding
  // MATCHES, a revoked device is refused before resolveSameHiveMember (and thus the
  // bootstrap pre-check) is ever reached. The admission decider checks `revoked` first
  // (precedence: revoked → bad_sig → binding), so onAnnounce short-circuits with
  // reason:'revoked' and ownerDeviceForHive is never consulted.
  it('ADVERSARIAL: a revoked owner device is refused before the bootstrap pre-check fires', async () => {
    const ownerUserId = 9910;
    const joiner = makeAnnounceIdentityOverride('joiner-adv4', 9911, 'kc-wi789-joiner-adv4');

    // Generate the owner keypair up front so it can be in the revoked set at boot.
    const { publicKey: ownerPub, privateKey: ownerPriv } = generateKeyPairSync('ed25519');
    const ownerDevicePubkey = rawPubkeyBase64(ownerPub);

    // The binding WOULD match — but the device is revoked, so admission must still fail.
    const ownerDeviceForHive = vi.fn(async () => ownerDevicePubkey);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set([ownerDevicePubkey]), // revoked at boot
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await buildAnnounce(
      {
        device_pubkey: ownerDevicePubkey,
        github_user_id: ownerUserId,
        github_login: 'owner-revoked',
        attestation_gist_id: 'gist-owner-revoked',
        log_core_key: 'f7'.repeat(32),
        harness_slug: OWNER_MEMBER_SLUG,
      },
      async (bytes) => nodeSign(null, bytes, ownerPriv),
    );

    const decision = await handle.onAnnounce(frame);

    // Revocation wins, before the bootstrap pre-check can ever run.
    expect(decision).toEqual({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
    expect(ownerDeviceForHive).not.toHaveBeenCalled();
  });
});

describe('bootHarnessSubstrate — revocation drops the admitted log end-to-end (D-004, Fix 1)', () => {
  function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** A real device identity + an injectable Ed25519 signer (stable across calls,
   *  so a re-announce uses the SAME device_pubkey that was revoked). */
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

  /** Pipe two Corestores' replication streams both ways (Stage-0 verified). */
  function replicate(s1: Corestore, s2: Corestore): void {
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);
  }

  it('admit a remote peer (its op merges) → revoke → its NEW ops stop merging + a re-announce is refused', async () => {
    // Capture applied ops via the applyOverride seam (the scoped per-harness
    // apply doesn't consult the global registry — D-021), so we see exactly
    // which of the peer's ops merge before vs. after revocation.
    const writes: Array<{ id: string }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-1',
      mergePollMs: 0,                       // drive mergeNow by hand
      pendingRetryMs: 0,                    // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_revoke_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // ── A real remote peer P: its own store + writable log, replicated into the
    // host's store so P's ops actually cross to the host and merge. ──
    const peerDir = tmpDir('mb-revoke-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-alice', 4242);

    // P writes its FIRST op, then we replicate P's store into the host's store.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-1',
      value: { id: 'P-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

    // P announces (valid sig + binding-true) → admitted; merge applies P's op #0.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const admitDecision = await handle.onAnnounce(announce);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(true);

    // onAnnounce already merged; P's first op is in PG.
    expect(writes).toEqual([{ id: 'P-1' }]);

    // ── REVOKE P. ── Drops its log from the admitted set + re-merges.
    await handle.revoke(P.devicePubkey);
    // The peer's log is no longer in the admitted set.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    // Only the host's own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // ── P writes a NEW op after revocation. ── It must NOT merge: the log is
    // out of the admitted set, so mergeNow never reads it.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-2',
      value: { id: 'P-2' }, ts: 200, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    const appliedAfter = await handle.mergeNow();
    expect(appliedAfter).toBe(0);                       // nothing in the admitted set newly applied
    expect(writes).toEqual([{ id: 'P-1' }]);            // P-2 never reached PG

    // ── A re-announce from the revoked pubkey is refused with reason 'revoked'. ──
    const reAnnounce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const reDecision = await handle.onAnnounce(reAnnounce);
    expect(reDecision).toMatchObject({ admit: false, reason: 'revoked' });
    // Still not re-admitted.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
  });

  // WI-1856 (G9): revoke() must not just drop the map entry — it must CLOSE
  // the underlying Hypercore session `openRemoteLog` opened for the peer, or
  // that session (replicator state + file handles) leaks for the rest of the
  // process's life on a long-lived owner node (revokes are rare but the leak
  // is unbounded/cumulative). Uses the REAL openRemoteLog (no override) so
  // this exercises the actual production close-wiring, not a fake's spy.
  it('revoke() closes the revoked peer\'s Hypercore session (WI-1856)', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-close-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-close-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const peerDir = tmpDir('mb-revoke-close-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-close', 4243);
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_close_table', hbKey: 'C-1',
      value: { id: 'C-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const admitDecision = await handle.onAnnounce(announce);
    expect(admitDecision.admit).toBe(true);

    // Capture the admitted RemoteLog + the underlying core's session count
    // BEFORE revoke — asserting the count drops by exactly one is what proves
    // close() released THIS session (not a no-op, not the whole core).
    const admittedLog = handle.admitted.get(peerOwn.keyHex)!;
    expect(admittedLog).toBeDefined();
    expect(typeof admittedLog.close).toBe('function');
    type CoreWithSessions = { sessions?: { length: number } };
    const core = (handle.store as unknown as {
      get(o: Record<string, unknown>): CoreWithSessions;
    }).get({ key: Buffer.from(peerOwn.keyHex, 'hex') });
    const sessionsBefore = core.sessions?.length ?? -1;
    expect(sessionsBefore).toBeGreaterThan(0);

    await handle.revoke(P.devicePubkey);

    // revoke() returns as soon as the peer is fully refused (revoked/admitted/
    // pubkeyToLogKey updated); the session close itself is fire-and-forget (a
    // live-replicator teardown can take a few seconds — see the comment at the
    // revoke() call site), so poll for it rather than asserting synchronously.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    await vi.waitFor(
      () => { expect(core.sessions?.length).toBe(sessionsBefore - 1); },
      { timeout: 10_000, interval: 50 },
    );
  });

  it('revoking an unknown pubkey is a no-op (idempotent) but still blocks a future announce', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-unknown-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const P = makeDevice('never-admitted', 7);
    // Revoke a pubkey we never admitted → no throw, admitted set unchanged.
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    // Revoking again is still a no-op (idempotent).
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();

    // A subsequent (valid-sig) announce from that revoked pubkey is refused.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: 'fe'.repeat(32),
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has('fe'.repeat(32))).toBe(false);
  });

  it('admission is THE boundary (P-003/D-004): a rejected peer\'s replicated ops never reach PG; an admitted peer\'s do', async () => {
    // The end-to-end statement of the trust boundary the D-004 re-grounding
    // rests on: BOTH peers announce AND replicate real ops into the host store
    // (so a rejected peer's ops are physically present locally) — yet ONLY the
    // admitted peer's ops project. Admission — not per-op signing — is what
    // keeps forged advisory rows out of local state. If this regresses (e.g. the
    // merge ever reads a non-admitted log), the rejected peer's op appears in PG.
    const writes: Array<{ id: string }> = [];
    const A = makeDevice('peer-admitted', 100);
    const B = makeDevice('peer-rejected', 200);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-admit-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'admit-boundary-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      // A's channel-2 binding verifies; B's conclusively fails → B is never admitted.
      verifyBindingOverride: async (devicePubkey: string) =>
        devicePubkey === A.devicePubkey ? 'verified' : 'fail',
      applyOverride: async (op) => {
        if (op.table === 'mb_admit_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // Two real peers, each with an own log carrying one op, BOTH replicated into
    // the host store — so both peers' ops are physically present locally.
    async function makePeer(prefix: string, dev: ReturnType<typeof makeDevice>, opId: string) {
      const store = new Corestore(tmpDir(prefix));
      cleanups.push(() => { void store.close(); });
      await store.ready();
      const own = await openOwnLog(store);
      await own.append({
        type: 'put', table: 'mb_admit_table', hbKey: opId,
        value: { id: opId }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
        author_pubkey: dev.devicePubkey,
      });
      replicate(store, handle.store);
      return own;
    }
    const aOwn = await makePeer('mb-admit-A-', A, 'A-1');
    const bOwn = await makePeer('mb-admit-B-', B, 'B-1');

    const mkAnnounce = (dev: ReturnType<typeof makeDevice>, logKey: string) =>
      buildAnnounce(
        {
          device_pubkey: dev.devicePubkey,
          github_user_id: dev.githubUserId,
          github_login: dev.githubLogin,
          attestation_gist_id: 'gist-test',
          log_core_key: logKey,
        },
        dev.sign,
      );

    const aDecision = await handle.onAnnounce(await mkAnnounce(A, aOwn.keyHex));
    const bDecision = await handle.onAnnounce(await mkAnnounce(B, bOwn.keyHex));
    expect(aDecision).toMatchObject({ admit: true });
    expect(bDecision).toMatchObject({ admit: false, reason: 'binding_invalid' });

    // Only A's log is admitted; B's is not.
    expect(handle.admitted.has(aOwn.keyHex)).toBe(true);
    expect(handle.admitted.has(bOwn.keyHex)).toBe(false);

    // Observability (P-003): the rejection is surfaced on the existing
    // boot-history channel — the purpose-built, queryable, local observability
    // surface — carrying the reason so a fleet operator can see admission
    // rejections. (A server-side PostHog path would be redundant with this and
    // doesn't exist; boot-history is the right home.)
    const rejected = listBootHistory({ workspaceId: 'ws-1', harnessSlug: 'admit-boundary-1' })
      .filter((e) => e.kind === 'announce_rejected');
    expect(rejected.some((e) => e.message?.includes('binding_invalid'))).toBe(true);

    // A merge pass reads ONLY the admitted set → A's op projected; B's op never
    // did, despite being replicated + physically available in the store.
    await handle.mergeNow();
    expect(writes.some((w) => w.id === 'A-1')).toBe(true);
    expect(writes.some((w) => w.id === 'B-1')).toBe(false);
  });

  it('a conclusive admission rejection emits substrate_admission_rejected telemetry (P-004)', async () => {
    // The rejection is forwarded to the diagnostic-telemetry pipeline (which
    // flushTelemetry sends to PostHog when opted in) via an injectable sink —
    // captured here so the assertion needs no PG/PostHog.
    const telemetry: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-tel-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'tel-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // every peer conclusively rejected
      recordTelemetryOverride: (kind, payload) => { telemetry.push({ kind, payload }); },
    });
    cleanups.push(() => handle.close());

    const P = makeDevice('rejected-peer', 9);
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: 'ab'.repeat(32),
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision).toMatchObject({ admit: false, reason: 'binding_invalid' });

    const ev = telemetry.find((t) => t.kind === 'substrate_admission_rejected');
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ harness_slug: 'tel-1', reason: 'binding_invalid' });
  });
});

describe('onSchemaVersionAlert', () => {
  it('subscribes to alerts emitted by the substrate', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(1);
    expect(received[0].observed_version).toBe(99);
    unsub();
  });

  it('unsub stops further deliveries', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    unsub();
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers receive the alert independently', () => {
    const a: SchemaVersionAlert[] = [];
    const b: SchemaVersionAlert[] = [];
    const unsub1 = onSchemaVersionAlert((x) => a.push(x));
    const unsub2 = onSchemaVersionAlert((x) => b.push(x));
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 5, known_version: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsub1();
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 6, known_version: 1 });
    expect(a).toHaveLength(1);    // unsubbed
    expect(b).toHaveLength(2);    // still active
    unsub2();
  });
});

// ── WI-183 — replication-stall detector ─────────────────────────────────────
// Repro: a hive peer restarts, the swarm re-peers (peer_connected fires), but
// this specific admitted log's replication never resumes — SILENTLY, with no
// error. `checkReplicationStall` (boot.ts) samples `RemoteLog.peersCount()`
// each merge pass and records a `replication_stalled` boot-history event once
// a log that WAS replicating has held zero live replicator peers for
// `replicationStallGraceMs`. These tests inject a minimal fake `AdmittedLog`
// directly into `handle.admitted` (bypassing swarm/announce entirely — the
// detector only cares about the shape's `peersCount()`), and drive the merge
// pass by hand via `mergeNow()` with the poll timer disabled.
describe('bootHarnessSubstrate — WI-183 replication-stall detector', () => {
  // These tests deliberately construct stall episodes; the default episode
  // reporter's Leg-0 `console.error` line (the rig's grep-able serve.log token,
  // added 2026-07-03) would trip vitest-fail-on-console. Install a silent
  // reporter for THIS describe only — the bootHistory entries these tests
  // assert come from the LEGACY checkReplicationStall path (no_replicator
  // kind), not from the reporter, so silencing it changes nothing they read.
  //
  // EI-7788 also added a drop-time RECOVERY report: `handle.close()` (fired
  // by each test's `cleanups.push(() => handle.close())`) also runs inside
  // the outer, file-scoped `afterEach` (which drains `cleanups` LIFO). A
  // describe-scoped `afterEach` here would run BEFORE that outer afterEach
  // (inner-before-outer hook ordering), so resetting the reporters there
  // un-silences them *before* `handle.close()` fires — the exact regression
  // this comment used to describe as already-handled. Instead, push the
  // reset onto the SAME `cleanups` LIFO stack each test's `handle.close()`
  // is pushed onto: push it here, in `beforeEach`, so it lands BELOW the
  // test's own `cleanups.push(() => handle.close())` and therefore pops
  // (runs) AFTER close() drains — reporters stay silenced through the whole
  // teardown, never just through the test body.
  beforeEach(() => {
    setReplicationStallEpisodeReporterForTests(() => {});
    setReplicationStallRecoveryReporterForTests(() => {});
    cleanups.push(() => {
      setReplicationStallEpisodeReporterForTests(null);
      setReplicationStallRecoveryReporterForTests(null);
    });
  });

  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-stall-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** A minimal AdmittedLog with a controllable `peersCount()` — no real
   *  hypercore, no ops (length 0), never actually read by the merge pass. */
  function fakeAdmittedRemoteLog(
    keyHex: string,
    peersCount: () => number | undefined,
  ): AdmittedLog & { peersCount(): number | undefined } {
    return {
      keyHex,
      length: 0,
      async get(): Promise<null> {
        return null;
      },
      peersCount,
    };
  }

  // WI-183 flaky-test fix (su-47533f4b found these wall-clock-timing flaky
  // under fleet CPU load: a real setTimeout(60ms) sleep raced against a
  // tight replicationStallGraceMs:30 window — under heavy scheduling
  // pressure the interval BETWEEN two synchronous `await handle.mergeNow()`
  // calls with no sleep at all could itself drift past the 30ms grace
  // window, tripping (or narrowly missing) the alarm non-deterministically.
  // `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` makes the elapsed
  // time between passes EXACT and deterministic (Date.now(), which
  // `checkReplicationStall` reads directly, is one of the mocks fake timers
  // install by default) instead of "however long the real clock/scheduler
  // happened to take". Installed only AFTER the handle is booted (so the
  // real async corestore/fs boot work is unaffected) and always torn down
  // in a `finally` so a failing assertion can't leak fake timers into a
  // later test.
  const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('fires replication_stalled once a previously-replicating log holds zero peers past the grace window, then stays silent while still stalled', async () => {
    const workspaceId = 'ws-stall-1';
    const harnessSlug = 's-stall-1';
    let peers = 1; // starts "replicating"
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    try {
      const keyHex = 'aa'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => peers));

      // First pass observes peers=1 → seeds lastNonZeroPeersAtMs; no alarm.
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);

      // Drops to zero — still inside the (shrunk) grace window → no alarm yet.
      peers = 0;
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);

      // Past the grace window → alarms exactly once.
      await sleep(60);
      await handle.mergeNow();
      const events = listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] });
      expect(events).toHaveLength(1);
      expect(events[0]!.message).toContain(keyHex.slice(0, 12));

      // Still stalled on a later pass — edge-triggered, so no re-fire.
      await sleep(60);
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires for a log that has NEVER shown a live replicator peer (ordinarily offline is not a bug)', async () => {
    const workspaceId = 'ws-stall-2';
    const harnessSlug = 's-stall-2';
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    try {
      const keyHex = 'bb'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => 0)); // never replicated

      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow();

      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms after peers recover, so a later stall episode fires again', async () => {
    const workspaceId = 'ws-stall-3';
    const harnessSlug = 's-stall-3';
    let peers = 1;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    // EI-7110's defaultRecoveryReporter deliberately logs a LOUD, grep-able
    // `console.error('[replication-liveness] recovered ...')` line on a genuine
    // alarm→recovered transition (same rationale as defaultEpisodeReporter's own
    // stall line) — this test exercises the real default reporter path (no
    // onRecovery override, unlike the pure-unit replication-liveness.test.ts
    // suite), so the expected recovery log must be mocked rather than left to
    // trip vitest-fail-on-console.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const keyHex = 'cc'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => peers));

      await handle.mergeNow(); // seed lastNonZeroPeersAtMs
      peers = 0;
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow(); // first alarm
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(1);

      // Recovers, then stalls again.
      peers = 1;
      await handle.mergeNow();
      peers = 0;
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow(); // second alarm

      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });
});

describe('bootHarnessSubstrate — P-531 replication progress ownership', () => {
  beforeEach(() => {
    setReplicationStallEpisodeReporterForTests(() => {});
    setReplicationStallRecoveryReporterForTests(() => {});
    cleanups.push(() => {
      setReplicationStallEpisodeReporterForTests(null);
      setReplicationStallRecoveryReporterForTests(null);
    });
  });

  async function fixture(initialLength = 100) {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'mb-progress-'));
    cleanups.push(() => { rmSync(workspaceRoot, { recursive: true, force: true }); });
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    cleanups.push(() => clock.mockRestore());
    const sessions: Array<RemoteLog & { close: ReturnType<typeof vi.fn> }> = [];
    const open = vi.fn(async (_store: unknown, keyHex: string): Promise<RemoteLog> => {
      const fresh = {
        keyHex, length: 0, contiguousLength: 0,
        get: vi.fn(async () => null), update: async () => {},
        prefetch: () => undefined, has: async () => false,
        peersCount: () => 0, close: vi.fn(async () => {}),
      };
      sessions.push(fresh);
      return fresh;
    });
    const handle = await bootHarnessSubstrate({
      workspaceRoot, workspaceId: 'ws-progress', harnessSlug: 's-progress',
      mergePollMs: 0, pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified', openRemoteLogOverride: open,
    });
    cleanups.push(() => handle.close());
    await handle.mergeNow();
    const author = makeAnnounceIdentityOverride('progress-author', 4242, 'progress-key');
    const announce = (length: number) => buildAnnounce({
      device_pubkey: author.devicePubkey, github_user_id: author.userId,
      github_login: 'progress-author', attestation_gist_id: 'gist-progress-author',
      log_core_key: 'e1'.repeat(32), log_length: length,
    }, bytes => author.override.sign('progress-key', bytes));
    const frame = await announce(initialLength);
    expect(await handle.onAnnounce(frame)).toEqual({ admit: true });
    const events = (kind: BootHistoryKind) => listBootHistory({
      workspaceId: 'ws-progress', harnessSlug: 's-progress', kinds: [kind],
    });
    return { handle, frame, sessions, open, events, announce, advance: (ms: number) => { now += ms; } };
  }

  it('reopens a stalled signed inventory leg by 30 seconds, without a diagnostic episode', async () => {
    const f = await fixture();
    f.advance(29_999);
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
    // Repeated signed announces do not postpone a progress deadline.
    await f.handle.onAnnounce(f.frame);
    f.advance(1);
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.handle.admitted.get(f.frame.log_core_key)).toBe(f.sessions[1]);
    expect(f.events('replication_repair')).toHaveLength(1);
    expect(f.events('replication_repair')[0]!.message).toContain('30000ms without progress');
    expect(f.sessions.every(s => !vi.mocked(s.get).mock.calls.length)).toBe(true);
  });

  it('learns signed writer growth through the same-identity reannounce shortcut', async () => {
    const f = await fixture(0);
    f.advance(90_000);
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
    await f.handle.onAnnounce(await f.announce(100));
    f.advance(30_000);
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.events('replication_repair')[0]!.message).toContain('writer=100');
  });

  it('retries past three unsuccessful sessions with zero peers and a zero-length fresh view', async () => {
    const f = await fixture();
    for (let attempt = 1; attempt <= 5; attempt++) {
      f.advance(30_000);
      await f.handle.mergeNow();
      await f.handle.mergeNow();
      expect(f.open).toHaveBeenCalledTimes(attempt + 1);
    }
    expect(f.events('replication_repair')).toHaveLength(5);
    // The verified writer target survives every fresh session's empty view.
    expect(f.events('replication_repair')[0]!.message).toContain('writer=100');
  });

  it('renews the deadline on received progress and stops repairs once caught up', async () => {
    const f = await fixture();
    f.advance(29_000);
    Object.defineProperty(f.sessions[0], 'contiguousLength', { value: 10, configurable: true });
    await f.handle.mergeNow();
    f.advance(29_000);
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
    Object.defineProperty(f.sessions[0], 'contiguousLength', { value: 100, configurable: true });
    await f.handle.mergeNow();
    f.advance(90_000);
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it('retries an unsuccessful reopen on the same fixed bound', async () => {
    const f = await fixture();
    f.open.mockRejectedValueOnce(new Error('reopen unavailable'));
    f.advance(30_000);
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.events('replication_repair_failed')).toHaveLength(1);
    f.advance(29_999);
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(f.handle.admitted.get(f.frame.log_core_key)).toBe(f.sessions[1]);
  });

  it('drops a revoked queued repair instead of reopening the device', async () => {
    const f = await fixture();
    f.advance(30_000);
    await f.handle.mergeNow(); // queues the lease
    await f.handle.revoke(f.frame.device_pubkey);
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.handle.admitted.has(f.frame.log_core_key)).toBe(false);
  });

  it('liveness reporters cannot create a second lifecycle repair clock', async () => {
    const f = await fixture();
    sampleReplicationLiveness('ws-progress', 's-progress', {
      keyHex: f.frame.log_core_key, knownLength: 100, mergedPosition: 0, peersCount: 1,
    }, { graceMs: 0 });
    await f.handle.mergeNow();
    await f.handle.mergeNow();
    expect(f.open).toHaveBeenCalledTimes(1);
  });
});

describe('bootHarnessSubstrate — P-006 scoped-log wiring (P-108)', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-p006-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  const WORKSPACE_ID = 'ws-p006';
  const JOINER_MEMBER_SLUG = 'p006-joiner-repo';
  const OWNER_MEMBER_SLUG = 'p006-owner-repo';
  const POT_HOME_SLUG = 'p006-owner-repo-home';
  const HIVE_PUBKEY = Buffer.alloc(32, 9).toString('base64');

  async function bootP006(root: string, opts: {
    userId: number; keychainId: string;
    loadHiveMembers: (hiveHome: string) => Promise<string[]>;
    verifyBinding?: () => Promise<'verified' | 'pending' | 'fail'>;
    applyOverride?: BootHarnessOpts['applyOverride'];
    openRemoteLogOverride?: BootHarnessOpts['openRemoteLogOverride'];
  }) {
    const joiner = makeAnnounceIdentityOverride('p006-joiner', opts.userId, opts.keychainId);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: root,
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: opts.verifyBinding ?? (async () => 'fail' as const),
      loadHiveMembersOverride: opts.loadHiveMembers,
      joinerPotHomeSlugOverride: async () => POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
      applyOverride: opts.applyOverride,
      openRemoteLogOverride: opts.openRemoteLogOverride,
    });
    cleanups.push(() => handle.close());
    return handle;
  }

  it('creates the coordinator on join, routes an ADMITTED announce (with ctx) into it, and never routes a non-admitted one', async () => {
    const receiverIdentity = vi.spyOn(hiveMemberIdentity, 'resolveGithubUserIdForDevicePubkey')
      .mockResolvedValue(9702);
    cleanups.push(() => receiverIdentity.mockRestore());
    let ownerDevicePubkey = '';
    const handle = await bootP006(tmpWorkspaceRoot(), {
      userId: 9602,
      keychainId: 'kc-p006-a',
      loadHiveMembers: async () => (ownerDevicePubkey ? [ownerDevicePubkey] : []),
    });

    // The scoped-log coordinator exists after a (fake-)swarm join.
    const fed = handle.scopeFederation;
    expect(fed).not.toBeNull();
    const spy = vi.spyOn(fed!, 'onPeerAnnounce').mockResolvedValue(undefined);

    // A NON-admitted frame (unknown device, binding fail ⇒ pending) must never
    // reach the scoped layer — frame.github_user_id is untrustworthy pre-admit.
    const strangerFrame = await validAnnounce({
      github_user_id: 9701,
      github_login: 'p006-stranger',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd1'.repeat(32),
    });
    const ctx = { muxer: { stream: { destroyed: false } }, send: vi.fn() };
    const rejected = await handle.onAnnounce(strangerFrame, ctx);
    expect(rejected.admit).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    // The SAME production path with the device in hive_members admits — and the
    // admitted frame + per-connection ctx flow into the coordinator.
    const ownerFrame = await validAnnounce({
      github_user_id: 9702,
      github_login: 'p006-owner',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd2'.repeat(32),
    });
    ownerDevicePubkey = ownerFrame.device_pubkey;
    const admitted = await handle.onAnnounce(ownerFrame, ctx);
    expect(admitted).toEqual({ admit: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ownerFrame, ctx);

    // Without ctx (direct handle.onAnnounce callers, retry paths) the scoped
    // layer is skipped — no crash, no phantom connection record.
    await handle.onAnnounce(ownerFrame);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a known device cannot claim another GitHub user for private scope serving', async () => {
    const member = makeAnnounceIdentityOverride('registered-member', 9703, 'kc-registered-member');
    const receiverIdentity = vi.spyOn(hiveMemberIdentity, 'resolveGithubUserIdForDevicePubkey')
      .mockResolvedValue(9703);
    cleanups.push(() => receiverIdentity.mockRestore());
    const handle = await bootP006(tmpWorkspaceRoot(), {
      userId: 9602, keychainId: 'kc-p006-uid-guard',
      loadHiveMembers: async () => [member.devicePubkey],
      verifyBinding: async () => 'fail', // only the registered device grants base admission
    });
    const scoped = vi.spyOn(handle.scopeFederation!, 'onPeerAnnounce').mockResolvedValue(undefined);
    const body = {
      device_pubkey: member.devicePubkey, github_user_id: 9702,
      github_login: 'scope-owner', attestation_gist_id: 'unavailable',
      harness_slug: OWNER_MEMBER_SLUG, log_core_key: 'e3'.repeat(32),
    };
    const signer = (bytes: Buffer) => member.override.sign('kc-registered-member', bytes);
    const forgedIdentity = await buildAnnounce(body, signer);
    const ctx = { muxer: { stream: { destroyed: false } }, send: vi.fn() };
    expect(await handle.onAnnounce(forgedIdentity, ctx)).toEqual({ admit: true });
    expect(scoped).not.toHaveBeenCalled();

    const boundIdentity = await buildAnnounce({ ...body, github_user_id: 9703 }, signer);
    expect(await handle.onAnnounce(boundIdentity, ctx)).toEqual({ admit: true });
    await vi.waitFor(() => expect(scoped).toHaveBeenCalledExactlyOnceWith(boundIdentity, ctx));
  });

  it.each([
    { name: 'owner exemption', policy: { moderation: { bannedGithubIds: ['9703'] } }, userIds: [9602], login: 'scope-owner', expected: [] },
    { name: 'numeric ban', policy: { moderation: { bannedGithubIds: ['9703'] } }, userIds: [9704], login: 'registered-member', expected: [] },
    { name: 'login allowlist', policy: { membership: 'allowlist', allowlist: ['scope-owner'] }, userIds: [9703], login: 'scope-owner', expected: [] },
    { name: 'per-user rate budget', policy: { rate: { opsPerMin: 1 } }, userIds: [9704, 9705], login: 'registered-member', expected: ['policy-op-0'] },
    { name: 'authorized offline member', policy: { membership: 'allowlist', allowlist: ['registered-member'] }, userIds: [9703], login: 'registered-member', expected: ['policy-op-0'] },
    { name: 'receiver identity stays pinned across repeated claims', policy: { moderation: { bannedGithubIds: ['9703'] } }, userIds: [9704, 9705], login: 'registered-member', expected: [] },
  ])('receiver-bound policy authority: $name', async ({ policy, userIds, login, expected }) => {
    const member = makeAnnounceIdentityOverride('registered-member', 9703, 'kc-policy-member');
    const members = vi.spyOn(federatedPotScope, 'listHiveMembersForLocalPot').mockResolvedValue([{
      workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG,
      githubUserId: 9703, githubUsername: 'registered-member', displayName: null, avatarUrl: null,
      deviceAttestations: [{ device_pubkey: member.devicePubkey, gist_id: 'unavailable', gist_url: '',
        device_label: 'test', created_at: 1, signature_by_device: '' }],
      revokedPubkeys: [], bindingStatus: 'verified',
    }]);
    const policyRead = vi.spyOn(hivePolicyStore, 'getHivePolicyCached').mockResolvedValue({
      policy: policy as HivePolicy,
    } as NonNullable<Awaited<ReturnType<typeof hivePolicyStore.getHivePolicyCached>>>);
    cleanups.push(() => { members.mockRestore(); policyRead.mockRestore(); });
    const writes: string[] = [];
    const handle = await bootP006(tmpWorkspaceRoot(), {
      userId: 9602, keychainId: 'kc-policy-receiver', loadHiveMembers: async () => [member.devicePubkey],
      applyOverride: async (op) => { writes.push(op.hbKey!); return true; },
      openRemoteLogOverride: async (_store, keyHex) => {
        const index = Number.parseInt(keyHex.slice(0, 2), 16) - 0xa0;
        return {
          keyHex, length: 1, contiguousLength: 1,
          get: async () => ({ type: 'put' as const, table: 'features-by-id', hbKey: `policy-op-${index}`,
            value: { id: `policy-op-${index}` }, ts: 1000 + index, schema_version: CURRENT_SCHEMA_VERSION,
            author_pubkey: member.devicePubkey }),
          update: async () => {}, prefetch: () => {}, has: async () => true,
        };
      },
    });
    for (const [index, uid] of userIds.entries()) {
      const frame = await buildAnnounce({
        device_pubkey: member.devicePubkey, github_user_id: uid, github_login: login,
        attestation_gist_id: 'unavailable', harness_slug: OWNER_MEMBER_SLUG,
        log_core_key: (0xa0 + index).toString(16).repeat(32),
      }, (bytes) => member.override.sign('kc-policy-member', bytes));
      expect(await handle.onAnnounce(frame)).toEqual({ admit: true });
      await handle.mergeNow();
    }
    expect(writes).toEqual(expected);
  });

  it('ensureScopeParticipation mints an own core in the SEPARATE scoped store; rediscloseScopes resolves', async () => {
    const root = tmpWorkspaceRoot();
    const handle = await bootP006(root, {
      userId: 9603,
      keychainId: 'kc-p006-b',
      loadHiveMembers: async () => [],
    });
    expect(handle.scopeFederation).not.toBeNull();

    // No scopes declared (tier-1 default): redisclose is a safe no-op.
    await expect(handle.rediscloseScopes()).resolves.toBeUndefined();

    await handle.ensureScopeParticipation([
      { kind: 'fleet', ownerGithubUserId: 9603, slug: 'p006-rig-fleet' },
    ]);
    // The scoped store is a sibling `hyperbee-scoped/` corestore — minting the
    // own scope core materializes it on disk, OUTSIDE the main `hyperbee/`
    // store (the never-replicated §5.3 premise).
    const scopedDir = join(root, '.papercusp', JOINER_MEMBER_SLUG, 'hyperbee-scoped');
    expect(existsSync(scopedDir)).toBe(true);
    expect(readdirSync(scopedDir).length).toBeGreaterThan(0);
  });
});

// ── WI-2105 REV (no-hiveHome) regression ─────────────────────────────────────
// An OWNED-hive member harness — home ≠ own slug, hive owned-not-remote (the live
// tower's `hive-canary` folding the `papercusp` hive it LOCALLY OWNS) — must resolve
// the member-content-guard home so cross-member REV content APPLIES instead of
// dropping with 'no-hiveHome'. Pre-fix the guard home was `hiveHomeProjectionSlug ??
// ownPotHomeSlug`, and for an owned-hive member BOTH are null/undefined (the joiner
// rebind is null because the hive is owned-not-remote; ownPotHomeSlug is undefined
// because home ≠ own slug) → the boot-time `hiveHome-resolve NONE→drop-all-cross-member`
// diagnostic fires and EVERY cross-member op drops (this is the WI-559/FED-1 gap — its
// ownPotHomeSlug fix only covered home===own-slug). The DECOUPLED fix threads
// `contentGuardHiveHome` (= potHomeSlugForHarness, independent of the home===own-slug
// rebind gate) as the guard home, so the diagnostic no longer fires — while the
// projection REBIND (hiveScoped) still keys off ownPotHomeSlug, so an owned-hive member
// does NOT double-apply the owner's own rows as origin='remote'. Observed through the
// durable boot-history diagnostic (`kind:'merge_error'`), the same seam a live restart
// surfaces via getBootHistory. `potHomeSlugForHarnessOverride` is the new test seam
// (closes the pre-existing WI-559 untestable owner-home path — a dynamic import, no seam).
describe('bootHarnessSubstrate — WI-2105 owned-hive member content-guard home', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-wi2105-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  // Mirrors the live tower: a member harness whose hive-home is a DIFFERENT, LOCALLY-OWNED hive.
  const MEMBER_HARNESS_SLUG = 'hive-canary';
  const OWNED_POT_HOME_SLUG = 'papercusp';
  const HIVE_PUBKEY = Buffer.alloc(32, 11).toString('base64');

  function dropAllDiag(workspaceId: string) {
    return listBootHistory({
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      kinds: ['merge_error'],
    }).filter((e) => (e.message ?? '').includes('hiveHome-resolve'));
  }

  it('FIX: an owned-hive member harness resolves the content-guard home (no drop-all-cross-member)', async () => {
    const workspaceId = 'ws-wi2105-fix';
    const joiner = makeAnnounceIdentityOverride('wi2105-owner', 9801, 'kc-wi2105-owner');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      // The hive is OWNED, not remote-joined → the joiner rebind resolves NULL (as in prod).
      joinerPotHomeSlugOverride: async () => null,
      // The owned hive's home slug ≠ this member harness's own slug → ownPotHomeSlug is
      // undefined, but the DECOUPLED content-guard home resolves it (the WI-2105 fix).
      potHomeSlugForHarnessOverride: async () => OWNED_POT_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // contentGuardHiveHome resolved ('papercusp') → the guard home is set → no drop-all diagnostic.
    expect(dropAllDiag(workspaceId)).toEqual([]);
  });

  it('NEGATIVE CONTROL: a genuinely-unresolvable hive-home still trips the drop-all diagnostic', async () => {
    const workspaceId = 'ws-wi2105-neg';
    const joiner = makeAnnounceIdentityOverride('wi2105-neg', 9802, 'kc-wi2105-neg');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      joinerPotHomeSlugOverride: async () => null,
      // BOTH homes unresolvable → contentGuardHiveHome undefined → the diagnostic MUST fire,
      // proving the resolution (not a dead diagnostic) is what silences the positive case.
      potHomeSlugForHarnessOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const fired = dropAllDiag(workspaceId);
    expect(fired).toHaveLength(1);
    const msg = fired[0]?.message ?? '';
    expect(msg).toContain('hiveHome-resolve NONE→drop-all-cross-member');
    expect(msg).toContain('guardHome=<none>');
  });
});

// EI-18804225902691617: a gh-bound harness caught between join-hive.ts stamping
// hive_slug in the registry and its swarm binding actually re-keying onto the hive
// topic previously had `hiveGitServe`/`hiveGitDial` silently omitted for the entire
// process lifetime — no boot event, no log line, nothing — because
// `bindingResolvesHiveHomeProjection` gates 'gh' bindings OUT of both the retry loop
// AND its terminal-failure report. The fix splits "should we retry resolving" from
// "should we report staying silent": retries stay gated exactly as before (a real
// extra cost, only worth paying once resolution can plausibly matter), but a single
// cheap non-retried check now distinguishes a genuinely stuck-mid-join gh harness
// (loud boot event) from the ordinary non-hive-forever gh harness (silence,
// unchanged — the overwhelming common case, which must stay zero-noise).
describe('bootHarnessSubstrate — EI-18804225902691617 gh-binding stuck-mid-join visibility', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-ei18804225-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  const HARNESS_SLUG = 'ei18804225-harness';
  const REPO_ID = 918042259;

  function ghStuckDiag(workspaceId: string) {
    return listBootHistory({
      workspaceId,
      harnessSlug: HARNESS_SLUG,
      kinds: ['merge_error'],
    }).filter((e) => (e.message ?? '').includes('still on its gh binding'));
  }

  it('a gh-bound harness whose registry ALREADY has a hive home gets a loud boot event (was: totally silent)', async () => {
    const workspaceId = 'ws-ei18804225-stuck';
    const joiner = makeAnnounceIdentityOverride('ei18804225-stuck', 9901, 'kc-ei18804225-stuck');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: HARNESS_SLUG,
      swarmBinding: { kind: 'gh', github_repository_id: REPO_ID },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      joinerPotHomeSlugOverride: async () => null,
      // The registry ALREADY has a hive home for this harness (join-hive.ts
      // stamped hive_slug) even though the swarm binding is still 'gh' — the
      // re-key hasn't landed yet. This is the reachable stuck-mid-join state.
      potHomeSlugForHarnessOverride: async () => 'some-hive-home',
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const fired = ghStuckDiag(workspaceId);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.message ?? '').toContain('pot-git serve stays off');
  });

  it('NEGATIVE CONTROL: an ordinary gh-bound harness with no hive home stays silent (byte-identical to today)', async () => {
    const workspaceId = 'ws-ei18804225-ordinary';
    const joiner = makeAnnounceIdentityOverride('ei18804225-ordinary', 9902, 'kc-ei18804225-ordinary');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: HARNESS_SLUG,
      swarmBinding: { kind: 'gh', github_repository_id: REPO_ID },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      joinerPotHomeSlugOverride: async () => null,
      // No hive home in the registry at all — an ordinary gh-bound harness
      // that will never be a hive member. Must stay silent: this is the
      // overwhelming common case and must remain zero-noise.
      potHomeSlugForHarnessOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    expect(ghStuckDiag(workspaceId)).toEqual([]);
  });
});

// WI-3288 (offline pot): the admitted-set otherwise grows only via swarm announces, so a
// swarm-less packaged install (offline / gh-unauthenticated) merged NOTHING from the
// WI-3232-restored seed corestore — pot visible, content empty (the owner's Windows VM).
// These tests pin the new third admission source: the installer seed manifest's coreKeys,
// admitted at boot iff the manifest's potId matches this boot's resolved hive home.
describe('bootHarnessSubstrate — WI-3288 seed-log admission (offline pot)', () => {
  const SEED_LOG_KEY = 'ee'.repeat(32);
  const HIVE_HOME = 'papercusp';

  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-seed-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** Minimal manifest-bearing seed dir; potId is the admission gate under test. */
  function writeSeedDir(potId: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-seed-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        seedFormatVersion: 1,
        potId,
        cutAtEpoch: 1,
        cutHlc: '001:00000:aa',
        cutTs: 1,
        stores: [
          {
            kind: 'corestore',
            hash: 'h',
            sizeBytes: 1,
            source: { type: 'resource', path: 'corestore' },
            meta: {
              coreKeys: [SEED_LOG_KEY],
              coreLengths: { [SEED_LOG_KEY]: 3 },
            },
          },
        ],
      }),
    );
    return dir;
  }

  function fakeRemoteLog(
    keyHex: string,
    opts: {
      length?: number;
      has?: (index: number) => Promise<boolean>;
      onClose?: () => void;
    } = {},
  ): RemoteLog {
    return {
      keyHex,
      length: opts.length ?? 3,
      contiguousLength: opts.length ?? 3,
      get: async () => null,
      update: async () => {},
      prefetch: () => {},
      has: opts.has ?? (async () => true),
      close: async () => opts.onClose?.(),
    };
  }

  function withSeedEnv(seedDir: string | undefined): void {
    const prevSeedDir = process.env.PAPERCUSP_SEED_DIR;
    const prevNoSeed = process.env.PAPERCUSP_NO_SEED;
    if (seedDir === undefined) delete process.env.PAPERCUSP_SEED_DIR;
    else process.env.PAPERCUSP_SEED_DIR = seedDir;
    delete process.env.PAPERCUSP_NO_SEED;
    cleanups.push(() => {
      if (prevSeedDir === undefined) delete process.env.PAPERCUSP_SEED_DIR;
      else process.env.PAPERCUSP_SEED_DIR = prevSeedDir;
      if (prevNoSeed === undefined) delete process.env.PAPERCUSP_NO_SEED;
      else process.env.PAPERCUSP_NO_SEED = prevNoSeed;
    });
  }

  function bootOpts(
    workspaceId: string,
    openRemoteLogOverride: (
      store: unknown,
      logKeyHex: string,
    ) => Promise<RemoteLog> = async (_store, logKeyHex) => fakeRemoteLog(logKeyHex),
  ) {
    return {
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: HIVE_HOME,
      swarmBinding: { kind: 'hive', hive_pubkey: Buffer.alloc(32, 7).toString('base64') } as const,
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set<string>(),
      joinerPotHomeSlugOverride: async () => null,
      potHomeSlugForHarnessOverride: async () => HIVE_HOME,
      announceIdentityOverride: makeAnnounceIdentityOverride(
        'wi3288-offline',
        3_288,
        `wi3288-${workspaceId}`,
      ).override,
      openRemoteLogOverride,
    };
  }

  it('admits the manifest coreKeys at boot with NO announce (the offline path)', async () => {
    const workspaceId = 'ws-wi3288-admit';
    withSeedEnv(writeSeedDir(HIVE_HOME));
    const handle = await bootHarnessSubstrate(bootOpts(workspaceId));
    cleanups.push(() => handle.close());

    expect(handle.admitted.has(SEED_LOG_KEY)).toBe(true);
    // Observable in boot-history (the dogfood substrate table / getBootHistory).
    const events = listBootHistory({ workspaceId, harnessSlug: HIVE_HOME }).filter(
      (e) => e.kind === ('seed_log_admitted' as never),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain(SEED_LOG_KEY.slice(0, 8));
  });

  it('does NOT admit a hive-mismatched seed (a seed never leaks into another hive)', async () => {
    const workspaceId = 'ws-wi3288-mismatch';
    withSeedEnv(writeSeedDir('some-other-hive'));
    const handle = await bootHarnessSubstrate(bootOpts(workspaceId));
    cleanups.push(() => handle.close());

    expect(handle.admitted.has(SEED_LOG_KEY)).toBe(false);
    expect(handle.admitted.size).toBe(1); // own log only
  });

  it('does NOT admit a manifest key whose restored target core is still length zero', async () => {
    const workspaceId = 'ws-wi3288-unrestored';
    let closed = 0;
    withSeedEnv(writeSeedDir(HIVE_HOME));
    const handle = await bootHarnessSubstrate(
      bootOpts(workspaceId, async (_store, logKeyHex) =>
        fakeRemoteLog(logKeyHex, {
          length: 0,
          has: async () => false,
          onClose: () => { closed += 1; },
        }),
      ),
    );
    cleanups.push(() => handle.close());

    expect(handle.admitted.has(SEED_LOG_KEY)).toBe(false);
    expect(handle.admitted.size).toBe(1); // own log only
    expect(closed).toBe(1); // the rejected Corestore session is not leaked
    expect(
      listBootHistory({ workspaceId, harnessSlug: HIVE_HOME })
        .filter((e) => e.kind === 'merge_error')
        .map((e) => e.message),
    ).toContainEqual(expect.stringContaining('local length 0 is below manifest length 3'));
  });

  it('does NOT admit a header-only replica whose manifest range has no local blocks', async () => {
    const workspaceId = 'ws-wi3288-header-only';
    withSeedEnv(writeSeedDir(HIVE_HOME));
    const handle = await bootHarnessSubstrate(
      bootOpts(workspaceId, async (_store, logKeyHex) =>
        fakeRemoteLog(logKeyHex, { length: 3, has: async () => false }),
      ),
    );
    cleanups.push(() => handle.close());

    expect(handle.admitted.has(SEED_LOG_KEY)).toBe(false);
    expect(
      listBootHistory({ workspaceId, harnessSlug: HIVE_HOME })
        .filter((e) => e.kind === 'merge_error')
        .map((e) => e.message),
    ).toContainEqual(expect.stringContaining('shipped start block 0 is not present locally'));
  });

  it('no seed dir ⇒ byte-for-byte today: own log only, no seed events, boot succeeds', async () => {
    const workspaceId = 'ws-wi3288-noseed';
    withSeedEnv(undefined);
    const handle = await bootHarnessSubstrate(bootOpts(workspaceId));
    cleanups.push(() => handle.close());

    expect(handle.admitted.size).toBe(1);
    expect(
      listBootHistory({ workspaceId, harnessSlug: HIVE_HOME }).filter(
        (e) => e.kind === ('seed_log_admitted' as never),
      ),
    ).toEqual([]);
  });
});
