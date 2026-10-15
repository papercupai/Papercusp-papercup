/**
 * child-driver.test.ts — `spawnProcMesh` must signal a mesh-formation failure
 * with the TYPED `MeshFormationError` (carrying the failed peer index), not a
 * plain `Error` (EI-115 regression).
 *
 * EI-115 was a weekly Tier-2 netem run crashing fatal with
 *   `Error: proc mesh: reader 1 never admitted the writer`
 * — a PLAIN Error from `spawnProcMesh` that propagated to netem-inner's fatal
 * handler. The EI-116 + audit-P-022 fix makes the failure typed so
 * `resolveNetemFailure` can fold it into a recorded did-not-form cell instead of
 * crashing the sweep. If a future edit regressed the throw back to a plain
 * `Error`, that did-not-form machinery would silently break and the fatal would
 * return — these tests lock the contract.
 *
 * The `spawnChild` test seam drives the formation OUTCOME without spawning real
 * OS processes (no testnet: an explicit non-empty `bootstrap`; no tmp dirs: an
 * explicit `roots`).
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { PeerChildHandle, spawnPeerChild, spawnProcMesh } from './child-driver';
import { MeshFormationError } from './mesh-outcome';
import type { PeerChildConfig } from './peer-child';

/** A fake peer child whose `waitFor(evt)` resolves an event (success) or null
 *  (that event never fires → a formation failure). `writerReady` gates the
 *  writer's `ready`; `admits(peerIndex)` gates each reader's `admitted`. */
function fakeChild(opts: { writerReady?: boolean; admits: (peerIndex: number) => boolean }) {
  return (cfg: PeerChildConfig): PeerChildHandle =>
    ({
      cfg,
      waitFor: (pred: string | ((e: unknown) => boolean)) => {
        const evt = typeof pred === 'string' ? pred : '';
        if (evt === 'ready') {
          const ready = cfg.role === 'writer' ? opts.writerReady !== false : true;
          return Promise.resolve(ready ? { evt } : null);
        }
        if (evt === 'admitted') return Promise.resolve(opts.admits(cfg.peerIndex) ? { evt } : null);
        return Promise.resolve(null);
      },
      kill: () => {},
    }) as unknown as PeerChildHandle;
}

const FIXED = {
  log: () => {},
  // Non-empty bootstrap → no real testnet is created; explicit roots → no mkdtemp.
  bootstrap: [{ host: '127.0.0.1', port: 49737 }],
  roots: { writer: '/tmp/ei115-fake-w', readers: ['/tmp/ei115-fake-r0'] },
  meshTimeoutMs: 10,
};

describe('spawnProcMesh formation failure is typed (EI-115)', () => {
  it('a reader that never admits throws MeshFormationError carrying its peerIndex', async () => {
    const err = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ admits: () => false }),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshFormationError);
    expect(err.name).toBe('MeshFormationError');
    // reader peerIndex is i+1 = 1 — the exact value EI-115 reported.
    expect(err.peerIndex).toBe(1);
    expect(err.message).toContain('reader 1 never admitted');
  });

  it('a writer that never becomes ready throws MeshFormationError (no peerIndex)', async () => {
    const err = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ writerReady: false, admits: () => true }),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshFormationError);
    expect(err.peerIndex).toBeUndefined();
    expect(err.message).toContain('writer never became ready');
  });

  it('a mesh that forms resolves to the writer + readers (no throw)', async () => {
    const mesh = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ admits: () => true }),
    });
    expect(mesh.writer.cfg.role).toBe('writer');
    expect(mesh.readers).toHaveLength(1);
    expect(mesh.readers[0].cfg.peerIndex).toBe(1);
    await mesh.teardown();
  });

  it('an over-budget mesh resolves with an advisory instead of throwing (WI-41206)', async () => {
    const logs: string[] = [];
    const mesh = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      log: (message: string) => logs.push(message),
      availableBytes: 1,
      spawnChild: fakeChild({ admits: () => true }),
    });

    expect(mesh.readers).toHaveLength(1);
    expect(logs.join('\n')).toContain('[mesh]');
    await mesh.teardown();
  });
});

describe('local perf peer boot', () => {
  it('auto-compacts a local corpus without reaching the PostgreSQL receipt census (WI-10007125)', async () => {
    const flagEnv = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
    const previousFlag = process.env[flagEnv];
    process.env[flagEnv] = '1';
    const testnet = await createTestnet(3);
    const root = mkdtempSync(join(tmpdir(), 'p2p-perf-child-compaction-'));
    const logs: string[] = [];
    const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
      host: b.host,
      port: b.port,
    }));
    const child = spawnPeerChild(
      {
        role: 'writer',
        workspaceId: 'ws-p2p-perf-child-compaction',
        harnessSlug: 'perf-proc',
        root,
        bootstrap,
        peerIndex: 0,
        count: 1200,
        rate: 0,
        snapshotWaitMs: 15_000,
      },
      (line) => logs.push(line),
    );
    try {
      expect(await child.waitFor('ready', 30_000), child.diagnostics()).toMatchObject({ evt: 'ready' });
      child.send('go');
      expect(await child.waitFor('writer-done', 30_000), child.diagnostics()).toBeTruthy();
      child.send('wait-snapshot');
      const snapshot = await child.waitFor('snapshot-ready', 30_000);
      expect(snapshot, child.diagnostics()).toBeTruthy();
      expect(snapshot!.error, logs.join('\n')).toBeUndefined();
      // Include the producer's boot-history cause: a bare null-index assertion hid
      // the strict no-PG stub's getOrgPg failure in the original D006 sweep.
      expect(snapshot!.index, logs.join('\n')).toBeGreaterThan(0);
      expect(logs.filter((line) => line.includes('log compaction failed'))).toEqual([]);
      await expect(child.stopAndCollect(30_000)).resolves.toMatchObject({ evt: 'result' });
    } finally {
      if (!child.exited) child.kill();
      await testnet.destroy();
      rmSync(root, { recursive: true, force: true });
      if (previousFlag === undefined) delete process.env[flagEnv];
      else process.env[flagEnv] = previousFlag;
    }
  }, 90_000);

  it('does not record PG-backed re-key invalidation on a usable local child', async () => {
    const testnet = await createTestnet(3);
    const root = mkdtempSync(join(tmpdir(), 'p2p-perf-peer-child-'));
    const logs: string[] = [];
    const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
      host: b.host,
      port: b.port,
    }));
    const child = spawnPeerChild(
      {
        role: 'writer',
        workspaceId: 'ws-p2p-perf-child-test',
        harnessSlug: 'perf-proc',
        root,
        bootstrap,
        peerIndex: 0,
        count: 0,
      },
      (line) => logs.push(line),
    );

    try {
      // A null here is almost always the child dying at module-LINK time — a name bound from
      // '@papercusp/db-org' that no-pg-stub.mjs does not export (guarded by
      // no-pg-stub-covers-db-org-imports.test.ts). Put the child's own cause in the assertion
      // message: a bare `resolves.toMatchObject` reports "expected null to match { evt: 'ready' }"
      // and leaves the one-line SyntaxError unread in `logs` (WI-761481, WI-2141194 #9).
      const ready = await child.waitFor('ready', 30_000);
      expect(ready, child.diagnostics()).toMatchObject({ evt: 'ready' });
      await expect(child.stopAndCollect(30_000)).resolves.toMatchObject({
        evt: 'result',
        role: 'writer',
        peerIndex: 0,
      });
      expect(logs.filter((line) => line.includes('epoch_gate_skipped'))).toEqual([]);
    } finally {
      if (!child.exited) child.kill();
      await testnet.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PeerChildHandle settles a pending waitFor when the child dies (WI-2141194 #9)', () => {
  it('resolves null as soon as the child closes, and diagnostics() names the exit + stderr', async () => {
    // A real OS child that fails the way a link-time SyntaxError does: one line on stderr, a
    // non-zero exit, nothing on stdout. The 30s budget must NOT be spent — the child is gone
    // within ~100ms and the event it was asked for can never arrive.
    const proc = spawn(process.execPath, [
      '-e',
      "process.stderr.write('SyntaxError: fake link failure for the settle test\\n'); process.exit(7);",
    ]);
    const logs: string[] = [];
    const handle = new PeerChildHandle(
      { role: 'writer', workspaceId: 'ws', harnessSlug: 'h', root: '/tmp/unused', peerIndex: 0, count: 0 },
      proc,
      (line) => logs.push(line),
    );
    const t0 = Date.now();
    const ready = await handle.waitFor('ready', 30_000);
    const elapsedMs = Date.now() - t0;
    expect(ready).toBeNull();
    // Far below the requested budget: the settle came from the child's close, not the timer.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(handle.exited).toBe(true);
    expect(handle.closed).toBe(true);
    expect(handle.exitCode).toBe(7);
    const diagnostics = handle.diagnostics();
    expect(diagnostics).toContain('exit code 7');
    expect(diagnostics).toContain('fake link failure for the settle test');
    // A waitFor issued AFTER close must not wait either.
    await expect(handle.waitFor('result', 30_000)).resolves.toBeNull();
    // The stderr line still reached the ordinary log sink as before.
    expect(logs.some((line) => line.includes('fake link failure'))).toBe(true);
  });
});
