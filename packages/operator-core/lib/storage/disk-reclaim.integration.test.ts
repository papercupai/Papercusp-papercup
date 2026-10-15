import { mkdtemp, mkdir, writeFile, utimes, symlink, stat, rm, chmod } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readDiskAlarmContext, runDiskSpaceAlarmOnce } from './disk-space-alarm';
import { writeCensusRun } from './disk-consumer-census';
import type { AttentionNotifyInput } from '../attention-notify';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { drainScheduledDiskReclaim, nativeRetentionCommand, readReclaimReceipt, removePrivilegedRetentionEntry, runDiskReclaimOnce, writeReclaimAudit, type DiskReclaimReceipt, type ReclaimSql } from './disk-reclaim';
import { type RetentionClass } from './retention-policy';
import { inspectRetentionTrees } from './disk-consumer-census';
import { readDiskHeadroomSoakEvidence } from './retention-interval-evidence';
import { createFreshPgDb, applyEventSubstrateMigrationsForTest, COORD_SUBSCRIPTION_SUBSTRATE } from '../../test/_pg-helpers';

const inspectionProbe = vi.hoisted(() => ({ before: undefined as ((path: string) => (() => void) | undefined) | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const done = inspectionProbe.before?.(String(args[0]));
    try { return await actual.lstat(...args); }
    finally { done?.(); }
  } };
});

const nativeDb = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!nativeDb.sql) throw new Error('native retention fixture database is not prepared');
    return { sql: nativeDb.sql };
  },
}));
vi.mock('../workspace-registry', async (original) => ({
  ...await original<typeof import('../workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('../task-manager/enabled', async (original) => ({
  ...await original<typeof import('../task-manager/enabled')>(), isTaskManagerEnabled: async () => true,
}));

const fixtureMutex = vi.hoisted(() => ({
  name: `disk-retention-fixture-${crypto.randomUUID()}`,
  requested: [] as string[],
  onRequest: undefined as (() => void) | undefined,
}));
// Exercise the real mutex on fixture resources. Other infrastructure mutexes
// retain their original identity; the scheduled actor owns the production name.
vi.mock('../../../../scripts/lib/fs-mutex.mjs', async (original) => {
  const actual = await original<typeof import('../../../../scripts/lib/fs-mutex.mjs')>();
  return {
    ...actual,
    withFsMutex: (...args: Parameters<typeof actual.withFsMutex>) => {
      fixtureMutex.requested.push(args[0]);
      fixtureMutex.onRequest?.();
      return actual.withFsMutex(args[0] === 'papercusp-disk-retention' ? fixtureMutex.name : args[0], args[1], args[2]);
    },
  };
});

let fixture: string | undefined;
afterEach(async () => { fixtureMutex.onRequest = undefined; inspectionProbe.before = undefined; if (fixture) await rm(fixture, { recursive: true, force: true }); fixture = undefined; });

async function setup() {
  fixture = await mkdtemp(join(tmpdir(), 'disk-retention-'));
  const root = join(fixture, 'scratch'); await mkdir(root);
  const policy: RetentionClass[] = [{ id: 'fixture', title: 'fixture', origin: 'agent', roots: [root], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] }];
  // Synthetic now also ages ctime; real stale trees must have both mtime AND ctime old.
  const nowMs = Date.now() + 48 * 3_600_000;
  const options = { policy, roots: [{ path: root, classId: 'fixture' }], nowMs, registeredWorkspaces: () => [], expectedDevices: [], sample: async () => [], scanHolders: async () => ({ complete: true, byPath: new Map<string, string[]>() }) };
  return { root, options };
}

describe('retention on a real fixture tree', () => {
  it('continues past a held oldest entry until actual retained usage meets the cap', async () => {
    const { root, options } = await setup();
    const paths = ['old-held', 'middle', 'new'].map((name) => join(root, name));
    for (const [index, path] of paths.entries()) { await writeFile(path, Buffer.alloc(4096)); await utimes(path, 1, index + 1); }
    // ctime is also part of newest-write: measure exact census ordering rather
    // than assuming write scheduling produces distinct clock ticks.
    const census = await inspectRetentionTrees(root, { retainAfterMs: 0, includeRecent: true });
    const ordered = [...census.entries].sort((a, b) => a.newestWriteMs - b.newestWriteMs || a.path.localeCompare(b.path));
    const held = ordered[0]!.path;
    const policy = options.policy.map((cls) => ({ ...cls, maxBytes: 4096, keep: { kind: 'max-age' as const, maxAgeHours: 24 } }));
    const receipt = await runDiskReclaimOnce({ ...options, policy, nowMs: Date.now(), inspectTrees: inspectRetentionTrees,
      scanHolders: async () => ({ complete: true, byPath: new Map([[held, ['123']]]) }) });
    expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
    expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: 12288, afterBytes: 4096, overByBytes: 0 });
    expect(receipt.entries.filter((entry) => entry.status === 'removed').map((entry) => entry.path)).toEqual(ordered.slice(1).map((entry) => entry.path));
    expect(await stat(held)).toBeTruthy();
  });

  it('counts a live pin in the cap receipt and reports its exempt overage', async () => {
    const { root, options } = await setup(); const pin = join(root, 'pinned'), disposable = join(root, 'disposable');
    await writeFile(pin, Buffer.alloc(8192)); await writeFile(disposable, Buffer.alloc(4096));
    const receipt = await runDiskReclaimOnce({ ...options, policy: options.policy.map((cls) => ({ ...cls, maxBytes: 4096 })),
      inspectTrees: inspectRetentionTrees, nowMs: Date.now(), readProtection: async () => ({ paths: [],
        pins: [{ paths: [pin], expiresAt: new Date(Date.now() + 60_000).toISOString() }] }) });
    expect(receipt.complete).toBe(true); expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: 12288, afterBytes: 8192, pinnedBytes: 8192, pinnedPaths: [pin], overByBytes: 4096, pinnedOverageBytes: 4096 });
    expect(await stat(pin)).toBeTruthy(); await expect(stat(disposable)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes an incomplete receipt when its whole-pass deadline is already exhausted', async () => {
    const { root, options } = await setup(); const path = join(root, 'retain'); await writeFile(path, 'keep');
    const record = vi.fn(); const receipt = await runDiskReclaimOnce({ ...options, runBudgetMs: 0, record });
    expect(receipt.complete).toBe(false); expect(receipt.errors).toContain('retention run budget exhausted');
    expect(record).toHaveBeenLastCalledWith('receipt', receipt); expect(await stat(path)).toBeTruthy();
  });

  it('uses bounded privileged census and fd-safe removal for a root-owned unreadable agent tree', async () => {
    const { root, options } = await setup(); const path = join(root, 'foreign'); await mkdir(path);
    await writeFile(join(path, 'payload'), 'expired');
    const run = (command: string, args: string[], input?: string) => execFileSync(command, args, { input, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    run('/usr/bin/sudo', ['-n', '/bin/chown', '-R', 'root:root', path]);
    run('/usr/bin/sudo', ['-n', '/bin/chmod', '700', path]);
    try {
      const execute: typeof nativeRetentionCommand = async (_repo, command, args, opts) => {
        expect(opts?.timeoutMs).toBeGreaterThan(0); expect(opts?.timeoutMs).toBeLessThanOrEqual(60_000);
        run(command, args, opts?.stdin); return { ok: true, detail: 'completed' };
      };
      const receipt = await runDiskReclaimOnce({ ...options,
        inspectTrees: (root, opts) => inspectRetentionTrees(root, { ...opts, sudo: '/usr/bin/sudo' }),
        removeEntry: (entry, ms) => removePrivilegedRetentionEntry(entry, ms, execute) });
      expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path, status: 'removed' }));
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { run('/usr/bin/sudo', ['-n', '/bin/rm', '-rf', '--', path]); }
  });
  it('loads new pin protection only after acquiring the mutex shared with pin writers', async () => {
    const { root, options } = await setup();
    const path = join(root, 'pinned-during-wait'); await writeFile(path, 'retain');
    let release!: () => void, ready!: () => void, requested!: () => void;
    const releaseGate = new Promise<void>((r) => { release = r; });
    const readyGate = new Promise<void>((r) => { ready = r; });
    const requestGate = new Promise<void>((r) => { requested = r; });
    const writer = withFsMutex('papercusp-disk-retention', async () => { ready(); await releaseGate; });
    await readyGate;
    let read = false;
    fixtureMutex.onRequest = requested;
    const reclaim = runDiskReclaimOnce({ ...options, readProtection: async () => {
      read = true; return { paths: [path] };
    } });
    try { await requestGate; expect(read).toBe(false); }
    finally { fixtureMutex.onRequest = undefined; release(); await writer; }
    const receipt = await reclaim;
    expect(read).toBe(true); expect(receipt.complete).toBe(true);
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path, status: 'protected' }));
    expect(await readFile(path, 'utf8')).toBe('retain');
  });

  it('fails closed when the pin store cannot be read', async () => {
    const { root, options } = await setup(); const path = join(root, 'stale'); await writeFile(path, 'retain');
    const receipt = await runDiskReclaimOnce({ ...options, readProtection: async () => { throw new Error('corrupt pin'); } });
    expect(receipt.complete).toBe(false); expect(receipt.errors).toContain('corrupt pin');
    expect(await readFile(path, 'utf8')).toBe('retain');
  });

  it('reclaims an arbitrarily named expired tree while retaining held, leased, fresh and unknown trees', async () => {
    const { root, options } = await setup();
    const old = join(root, 'random-build-copy');
    const held = join(root, 'another-arbitrary-name');
    const leased = join(root, 'leased-build');
    const fresh = join(root, 'recent-build');
    for (const path of [old, held, leased, fresh]) { await mkdir(path); await writeFile(join(path, 'payload'), 'fixture'); }
    const nowMs = options.nowMs;
    await utimes(join(fresh, 'payload'), new Date(nowMs), new Date(nowMs));
    const scanHolders = vi.fn(async () => ({ complete: true, byPath: new Map([[held, ['123']]]) }));
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees,
      scanHolders, protectedPaths: [leased] });
    expect(receipt.complete).toBe(true);
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: old, status: 'removed' }));
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: held, status: 'protected', reason: 'live process' }));
    for (const path of [held, leased, fresh]) expect((await stat(path)).isDirectory()).toBe(true);
    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    const unknown = join(root, 'unknown-holder'); await writeFile(unknown, 'keep');
    const partial = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees,
      scanHolders: async () => ({ complete: false, byPath: new Map() }) });
    expect(partial.complete).toBe(false); expect(partial.policyExhausted).toBeNull();
    expect(await readFile(unknown, 'utf8')).toBe('keep');
  });
  it('retains a holder that appears after the initial census and durable removal intent', async () => {
    const { root, options } = await setup(); const path = join(root, 'later-held'); await writeFile(path, 'expired');
    let intent = false;
    const scanHolders = vi.fn(async () => ({ complete: true,
      byPath: intent ? new Map([[path, ['123']]]) : new Map<string, string[]>() }));
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees, scanHolders,
      record: async (phase) => { if (phase === 'remove-intent') intent = true; },
    });
    expect(receipt.complete).toBe(true);
    expect(scanHolders).toHaveBeenCalledTimes(2);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'protected', reason: 'process evidence unavailable or held' })]);
    expect(await readFile(path, 'utf8')).toBe('expired');
  });

  it('records an incomplete final holder check as a partial receipt and preserves the artifact', async () => {
    const { root, options } = await setup(); const path = join(root, 'uncertain'); await writeFile(path, 'expired');
    let intent = false;
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees,
      record: async (phase) => { if (phase === 'remove-intent') intent = true; },
      scanHolders: async () => ({ complete: !intent, byPath: new Map<string, string[]>(),
        ...(intent ? { diagnostics: { deadlineExceeded: true, processesTotal: 10, processesScanned: 4 } } : {}) }),
    });
    expect(receipt.complete).toBe(false);
    expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors.join(' ')).toContain('incomplete process-holder scan before removal:');
    expect(receipt.errors.join(' ')).toContain('"processesScanned":4');
    expect(await readFile(path, 'utf8')).toBe('expired');
  });

  it('runs the native cargo delegate repeatedly with captured receipts and no missed completion', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'disk-retention-cargo-'));
    const shared = join(fixture, 'target');
    const dead = join(fixture, 'target-pid99999999');
    await mkdir(join(dead, 'debug'), { recursive: true });
    await writeFile(join(dead, 'debug', 'marker'), 'expired fixture');
    const old = new Date(Date.now() - 7200_000);
    await utimes(join(dead, 'debug'), old, old); await utimes(dead, old, old);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    // Reuse the desktop slot suite's Cargo configuration fixture: the shared
    // root resolver intentionally ignores CARGO_TARGET_DIR (an already-claimed slot).
    await mkdir(join(fixture, '.cargo'));
    await mkdir(join(fixture, 'src-tauri', 'src'), { recursive: true });
    await writeFile(join(fixture, '.cargo', 'config.toml'), `[build]\ntarget-dir = ${JSON.stringify(shared)}\n`);
    await writeFile(join(fixture, 'src-tauri', 'Cargo.toml'), '[package]\nname = "retention-native-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(fixture, 'src-tauri', 'src', 'lib.rs'), '');
    // Resolve the selected installed binary before removing HOME/settings.toml.
    // Cargo metadata must work even with an empty rustup home; the runner also
    // supplies this binary directory before the shim directory under isolation.
    const cargo = process.env.PAPERCUSP_TEST_CARGO ?? execFileSync('rustup', ['which', 'cargo'], { encoding: 'utf8', timeout: 5000 }).trim();
    expect(cargo).toMatch(/\/bin\/cargo$/);
    const args = [
      '-u', 'CARGO_BUILD_TARGET_DIR', `HOME=${fixture}`, 'CARGO_TARGET_DIR=',
      `CARGO_HOME=${join(fixture, '.cargo')}`, `RUSTUP_HOME=${join(fixture, 'empty-rustup')}`,
      `PATH=${dirname(cargo)}:${process.env.PATH ?? ''}`,
      `PAPERCUSP_DESKTOP_TARGET_ROOT=${fixture}`,
      `PAPERCUSP_RELEASE_RETENTION_ROOT=${join(fixture, 'retention')}`,
      '/bin/bash', join(repoRoot, 'papercusp-desktop/bin/reap-private-target-slots.sh'),
    ];
    const db = await createFreshPgDb('disk-retention-native');
    nativeDb.sql = db.sql;
    try {
      await applyEventSubstrateMigrationsForTest(db.sql, {
        label: 'disk-reclaim.integration.test.ts native delegate', ...COORD_SUBSCRIPTION_SUBSTRATE,
        extra: [...COORD_SUBSCRIPTION_SUBSTRATE.extra,
          '696-task-ledger.sql', '700-task-ledger-bash-job-id-idx.sql', '774-task-ledger-ended-unobserved-state.sql'],
      });
      // Exercise the input transport against this real enrolled-task database.
      // A single argv argument of this size fails with E2BIG on Linux.
      const input = JSON.stringify(Array.from({ length: 14_000 }, (_, i) => `/scratch/expired-${i}`));
      expect(Buffer.byteLength(input)).toBeGreaterThan(128 * 1024);
      const streamed = await nativeRetentionCommand(repoRoot, process.execPath, ['--input-type=module', '-e',
        "const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk); const input=Buffer.concat(chunks).toString('utf8'); console.log(JSON.stringify({bytes:Buffer.byteLength(input),paths:JSON.parse(input).length}));"],
      { stdin: input, stdoutOnly: true });
      expect(streamed, JSON.stringify(streamed)).toMatchObject({ ok: true });
      expect(JSON.parse((streamed.detail as { output: string }).output)).toEqual({ bytes: Buffer.byteLength(input), paths: 14_000 });
      const listed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', [...args, '--dry-run']);
      expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
      expect(listed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`would reap: ${dead}`) });
      await expect(stat(dead)).resolves.toBeDefined();
      const removed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args);
      expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
      expect(removed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`reaped dead private target slot ${dead}`) });
      await expect(stat(dead)).rejects.toMatchObject({ code: 'ENOENT' });
      const repeated = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args);
      expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true });
      const { getTask } = await import('../task-manager/store');
      for (const result of [streamed, listed, removed, repeated]) {
        const id = (result.detail as { taskId: string }).taskId;
        // The helper must await persistence itself. Polling here hid the window
        // where a short-lived caller could exit and lose the terminal write.
        expect(await getTask(id)).toMatchObject({ state: 'exited', exitCode: 0 });
      }
    } finally {
      await db.cleanup(); nativeDb.sql = undefined;
    }
  }, 120_000);

  it('removes expired files even without low-space samples and returns the exact path receipt', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.errors).toEqual([]);
    expect(fixtureMutex.requested.at(-1)).toBe('papercusp-disk-retention');
    expect(receipt.complete).toBe(true);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed', classId: 'fixture' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks each regular file directly after intent without restarting the tree inspector', async () => {
    const { root, options } = await setup();
    const old = join(root, 'a-old'), changed = join(root, 'b-changed');
    await writeFile(old, 'expired'); await writeFile(changed, 'keep after new write');
    const inspectTrees = vi.fn(inspectRetentionTrees);
    const phases: string[] = [];
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees, record: async (phase, detail) => {
      if (phase === 'remove-intent') {
        phases.push((detail as { path: string }).path);
        if ((detail as { path: string }).path === changed) await utimes(changed, new Date(options.nowMs), new Date(options.nowMs));
      }
    } });
    expect(receipt.complete, JSON.stringify(receipt.errors)).toBe(true);
    expect(phases).toEqual([old, changed]);
    expect(inspectTrees).toHaveBeenCalledTimes(1);
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: old, status: 'removed' }));
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: changed, status: 'changed' }));
    expect(await readFile(changed, 'utf8')).toBe('keep after new write');
  });

  it('drains complete classes and reaches the next root when safety checks outlast the inspection budget', async () => {
    const { root, options } = await setup();
    const secondRoot = join(fixture!, 'second-root'); await mkdir(secondRoot);
    const paths = [join(root, 'old-a'), join(root, 'old-b'), join(secondRoot, 'old-c')];
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanHolders = vi.fn(async () => {
      clock += 500;
      return { complete: true, byPath: new Map<string, string[]>() };
    });
    try {
      const receipt = await runDiskReclaimOnce({ ...options, budgetMs: 100,
        policy: [...options.policy, { ...options.policy[0]!, id: 'second', roots: [secondRoot] }],
        roots: [...options.roots, { path: secondRoot, classId: 'second' }],
        scanHolders, record: async () => { clock += 500; },
      });
      expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
      expect(receipt.policyExhausted).toBe(true);
      expect(receipt.scan?.stoppedAtRoot).toBeNull();
      expect(receipt.entries.map((entry) => entry.path).sort()).toEqual([...paths].sort());
      expect(receipt.entries.every((entry) => entry.status === 'removed')).toBe(true);
      // One class-level scan and a fresh immediate scan for every effect.
      expect(scanHolders).toHaveBeenCalledTimes(5);
      for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { now.mockRestore(); }
  });
  it('bounds effect work per root, records the remainder and resumes from a fresh policy census', async () => {
    const { root, options } = await setup();
    const secondRoot = join(fixture!, 'second-root'); await mkdir(secondRoot);
    const paths = [join(root, 'old-a'), join(root, 'old-b'), join(secondRoot, 'old-c')];
    for (const path of paths) await writeFile(path, 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const progress: unknown[] = [];
    const scanHolders = vi.fn(async () => {
      clock += 100;
      return { complete: true, byPath: new Map<string, string[]>() };
    });
    const delegate = vi.fn(async () => ({ ok: true, detail: 'independent owner completed' }));
    try {
      const receipt = await runDiskReclaimOnce({ ...options, effectBudgetMs: 250,
        policy: [...options.policy, { ...options.policy[0]!, id: 'second', roots: [secondRoot] }],
        roots: [...options.roots, { path: secondRoot, classId: 'second' }], scanHolders,
        record: async (phase, detail) => { if (phase === 'progress') progress.push(detail); },
        delegates: [{ classId: 'independent-owner', run: delegate }],
      });
      expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
      expect(receipt.errors).toEqual([expect.stringContaining(`incomplete retention effects:${root}:`)]);
      expect(receipt.effects).toEqual([
        expect.objectContaining({ root, selected: 2, processed: 1, remaining: 1, nextPath: paths[1], elapsedMs: 300, stopped: true,
          timings: { initialHolderScanMs: 100, freshHolderScanMs: 200, reinspectionMs: 0, removalMs: 0, removalAuditMs: 0 } }),
        expect.objectContaining({ root: secondRoot, selected: 1, processed: 1, remaining: 0, nextPath: null, elapsedMs: 200, stopped: false,
          timings: { initialHolderScanMs: 100, freshHolderScanMs: 100, reinspectionMs: 0, removalMs: 0, removalAuditMs: 0 } }),
      ]);
      expect(progress).toContainEqual(receipt.effects![0]);
      expect(delegate).toHaveBeenCalledOnce();
      expect(scanHolders.mock.calls).toHaveLength(5);
      await expect(stat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(paths[1]!)).resolves.toBeDefined();
      await expect(stat(paths[2]!)).rejects.toMatchObject({ code: 'ENOENT' });
      const resumed = await runDiskReclaimOnce(options);
      expect(resumed.complete).toBe(true); expect(resumed.policyExhausted).toBe(true);
      expect(resumed.entries).toEqual([expect.objectContaining({ path: paths[1], status: 'removed' })]);
    } finally { now.mockRestore(); }
  });
  it('automatically drains bounded batches with a fresh census and protects a newly held remainder', async () => {
    const { root, options } = await setup();
    const paths = ['a', 'b', 'c', 'd'].map((name) => join(root, name));
    for (const path of paths) await writeFile(path, 'expired');
    let clock = options.nowMs, activeBatch = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const receipts: DiskReclaimReceipt[] = [];
    const checks: Array<{ batch: number; paths: readonly string[] }> = [];
    try {
      const summary = await drainScheduledDiskReclaim(async (batch, notAfterMs) => {
        if (notAfterMs !== undefined && clock >= notAfterMs) return null;
        activeBatch = batch;
        const receipt = await runDiskReclaimOnce({ ...options, nowMs: clock, effectBudgetMs: 250,
          scanHolders: async (wanted) => {
            checks.push({ batch: activeBatch, paths: [...wanted] }); clock += 100; vi.setSystemTime(clock);
            return { complete: true, byPath: activeBatch > 0 ? new Map([[paths[1]!, ['123']]]) : new Map<string, string[]>() };
          },
        });
        receipts.push(receipt); return receipt;
      });
      expect(summary).toMatchObject({ batches: 3, stop: 'complete' });
      expect(receipts.map((receipt) => receipt.complete)).toEqual([false, false, true]);
      expect(receipts.flatMap((receipt) => receipt.entries.filter((entry) => entry.status === 'removed').map((entry) => entry.path)))
        .toEqual([paths[0], paths[2], paths[3]]);
      expect(checks.filter((check) => check.paths.length > 1).map((check) => check.paths)).toEqual([paths, paths.slice(1), paths.slice(1).filter((path) => path !== paths[2])]);
      for (const path of [paths[0]!, paths[2]!, paths[3]!]) {
        expect(checks.some((check) => check.paths.length === 1 && check.paths[0] === path)).toBe(true);
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(paths[1]!, 'utf8')).toBe('expired');
    } finally { vi.useRealTimers(); }
  });
  it.each([true, false])('attributes fresh-check and audit time even when final holder evidence is incomplete (%s)', async (complete) => {
    const { root, options } = await setup(); const path = join(root, 'timed'); await writeFile(path, 'expired');
    let clock = Date.now(), intent = false, reinspectionMs = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    inspectionProbe.before = () => { if (intent) { clock += 5; reinspectionMs += 5; } return undefined; };
    try {
      const receipt = await runDiskReclaimOnce({ ...options,
        record: async (phase) => {
          if (phase === 'remove-intent' || phase === 'removed') { clock += 7; intent = true; }
          else clock += 1000; // Progress/receipt persistence is outside the named counters.
        },
        scanHolders: async () => {
          clock += intent ? 30 : 20;
          return { complete: !intent || complete, byPath: new Map<string, string[]>() };
        },
      });
      expect(receipt.complete).toBe(complete);
      expect(reinspectionMs).toBeGreaterThan(0);
      expect(receipt.effects?.[0]?.timings).toEqual({ initialHolderScanMs: 20, freshHolderScanMs: 30,
        reinspectionMs, removalMs: 0, removalAuditMs: complete ? 14 : 7 });
      expect(receipt.entries[0]?.status).toBe(complete ? 'removed' : 'protected');
      if (complete) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(path, 'utf8')).toBe('expired');
    } finally { now.mockRestore(); }
  });
  it('charges durable intent waits to the effect budget before launching another safety check', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanHolders = vi.fn(options.scanHolders);
    try {
      const receipt = await runDiskReclaimOnce({ ...options, effectBudgetMs: 100, scanHolders,
        record: async (phase) => { if (phase === 'remove-intent') clock += 100; },
      });
      expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
      expect(receipt.effects?.[0]).toMatchObject({ processed: 0, remaining: 1, nextPath: path, stopped: true });
      expect(scanHolders).toHaveBeenCalledOnce();
      await expect(stat(path)).resolves.toBeDefined();
    } finally { now.mockRestore(); }
  });
  it('finishes an in-flight removal audit without falsely leaving a fully processed root partial', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const receipt = await runDiskReclaimOnce({ ...options, effectBudgetMs: 100,
        record: async (phase) => { if (phase === 'removed') clock += 10_000; },
      });
      expect(receipt.complete).toBe(true); expect(receipt.policyExhausted).toBe(true);
      expect(receipt.effects?.[0]).toMatchObject({ processed: 1, remaining: 0, nextPath: null, stopped: false, elapsedMs: 10_000 });
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { now.mockRestore(); }
  });
  it('finishes an admitted removal then yields the real mutex to a queued writer', async () => {
    const { root, options } = await setup();
    const paths = [join(root, 'old-a'), join(root, 'old-b')];
    for (const path of paths) await writeFile(path, 'expired');
    let entered!: () => void, finish!: () => void, queued!: () => void;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    const finishRemoval = new Promise<void>((resolve) => { finish = resolve; });
    const waiting = new Promise<void>((resolve) => { queued = resolve; });
    const delegate = vi.fn(async () => ({ ok: true, detail: 'fixture owner' }));
    const reclaim = runDiskReclaimOnce({ ...options, delegates: [{ classId: 'fixture-owner', run: delegate }],
      removeEntry: async (entry) => { entered(); await finishRemoval; await rm(entry.path); } });
    await removing;
    let peerEntered = false;
    const peer = withFsMutex('papercusp-disk-retention', async () => { peerEntered = true; },
      { timeoutMs: 5_000, retryMs: 5, onWaiting: queued });
    try {
      await waiting;
      expect(peerEntered).toBe(false);
    } finally { finish(); }
    const receipt = await reclaim;
    await peer;
    expect(peerEntered).toBe(true);
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toContain('retention yielded to queued writer');
    expect(receipt.entries.filter((entry) => entry.status === 'removed')).toHaveLength(1);
    expect(receipt.effects?.[0]).toMatchObject({ processed: 1, remaining: 1, stopped: true });
    expect(delegate).not.toHaveBeenCalled();
    const resumed = await runDiskReclaimOnce(options);
    expect(resumed.complete).toBe(true);
    expect(resumed.entries.filter((entry) => entry.status === 'removed')).toHaveLength(1);
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes overlapping fixture passes with the real mutex and preserves the losing pass', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    let signalEntered = () => {}; let releaseFirst = () => {};
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = runDiskReclaimOnce({ ...options, scanHolders: async () => {
      signalEntered(); await release; return { complete: true, byPath: new Map<string, string[]>() };
    } });
    try {
      await entered;
      const second = await runDiskReclaimOnce(options);
      expect(second.complete).toBe(false);
      expect(second.errors.join(' ')).toContain('Timed out after 1000ms waiting for fs-mutex');
      expect(second.entries).toEqual([]);
      expect(await stat(path)).toBeTruthy();
    } finally { releaseFirst(); }
    const receipt = await first;
    expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('bounds concurrent entry inspection while retaining the exact oldest-first effects', async () => {
    const { root, options } = await setup();
    const paths = Array.from({ length: 32 }, (_, i) => join(root, `old-${i}`));
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    let active = 0, peak = 0;
    inspectionProbe.before = (path) => {
      if (!path.startsWith(root + '/')) return;
      peak = Math.max(peak, ++active);
      return () => { active--; };
    };
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(16); expect(active).toBe(0);
    expect(receipt.entries.map((entry) => entry.path).sort()).toEqual([...paths].sort());
    expect(receipt.entries.every((entry) => entry.status === 'would-remove')).toBe(true);
    for (const path of paths) expect(await stat(path)).toBeTruthy();
  });
  it('keeps an incomplete root intact and still reclaims an independent complete root', async () => {
    const { root, options } = await setup();
    const firstPaths = Array.from({ length: 32 }, (_, i) => join(root, `old-${i}`));
    await Promise.all(firstPaths.map((path) => writeFile(path, 'expired')));
    const secondRoot = join(fixture!, 'second-root'); await mkdir(secondRoot);
    const secondPath = join(secondRoot, 'old'); await writeFile(secondPath, 'expired');
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3,
      policy: [...options.policy, { ...options.policy[0]!, id: 'second', roots: [secondRoot] }],
      roots: [...options.roots, { path: secondRoot, classId: 'second' }],
    });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.scan?.incompleteRoots).toEqual([root]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path: secondPath, status: 'removed' })]);
    await expect(stat(secondPath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of firstPaths) expect(await stat(path)).toBeTruthy();
  });
  it('enforces expiry when both disks already exceed the 100 GiB target (D-005)', async () => {
    const { root, options } = await setup(); const path = join(root, 'expired'); await writeFile(path, 'expired');
    const gib = 1024 ** 3;
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'],
      sample: async () => ['/', '/mnt/data'].map((device) => ({ path: device, totalBytes: 500 * gib,
        freeBytes: 120 * gib, freePct: 0.24, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 })),
    });
    expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
    expect(receipt.devices.map((d) => d.atTarget)).toEqual([true, true]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('protects a stale parent with a recently written descendant', async () => {
    const { root, options } = await setup(); const parent = join(root, 'parent'); await mkdir(parent);
    const child = join(parent, 'recent'); await writeFile(child, 'new');
    const future = new Date(options.nowMs); await utimes(child, future, future);
    await utimes(parent, new Date(0), new Date(0));
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.entries).toEqual([]); expect(await stat(child)).toBeTruthy();
  });
  it('retains a fresh large tree without spending the candidate budget on its descendants', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'fresh'); await mkdir(parent);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(parent, `child-${i}`), 'keep')));
    await utimes(parent, new Date(options.nowMs), new Date(options.nowMs));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 2 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]); expect(await stat(join(parent, 'child-0'))).toBeTruthy();
  });
  it('completes the retain census when recent direct entries outnumber the deep-scan budget', async () => {
    const { root, options } = await setup();
    await Promise.all(Array.from({ length: 32 }, (_, i) => writeFile(join(root, `recent-${i}`), 'keep')));
    const receipt = await runDiskReclaimOnce({ ...options, nowMs: Date.now(), maxEntries: 2 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]);
    expect(receipt.scan).toEqual({ inspectedNodes: 0, retainedRecentTrees: 32, stoppedAtRoot: null, incompleteRoots: [] });
    expect(await stat(join(root, 'recent-31'))).toBeTruthy();
  });
  it('keeps the complete newest-write inspection bound for count retention', async () => {
    const { root, options } = await setup();
    await Promise.all(Array.from({ length: 32 }, (_, i) => writeFile(join(root, `recent-${i}`), 'keep')));
    const policy: RetentionClass[] = [{ ...options.policy[0]!, keep: { kind: 'newest', keep: 1 } }];
    const receipt = await runDiskReclaimOnce({ ...options, policy, nowMs: Date.now(), maxEntries: 2 });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.entries).toEqual([]);
    expect(receipt.scan).toEqual({ inspectedNodes: 2, retainedRecentTrees: 0, stoppedAtRoot: root, incompleteRoots: [root] });
    expect(await stat(join(root, 'recent-31'))).toBeTruthy();
  });
  it('stops at a recent descendant while preserving an otherwise stale large tree', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'parent'); await mkdir(parent);
    // Reverse traversal visits this recent file before the large older subtree.
    const older = join(parent, 'a-older'); await mkdir(older);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(older, `child-${i}`), 'keep')));
    const recent = join(parent, 'z-recent'); await writeFile(recent, 'keep');
    await utimes(recent, new Date(options.nowMs), new Date(options.nowMs));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]); expect(await stat(join(older, 'child-0'))).toBeTruthy();
  });
  it('still refuses an expired large tree when its complete scan exceeds the same budget', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'expired'); await mkdir(parent);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(parent, `child-${i}`), 'keep')));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3 });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.entries).toEqual([]); expect(await stat(join(parent, 'child-0'))).toBeTruthy();
  });
  it('completes a large expiry tree through native census and remeasures it before removal', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'expired'); await mkdir(parent);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(parent, `child-${i}`), 'expired')));
    const inspectTrees = vi.fn(inspectRetentionTrees);
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3, inspectTrees });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path: parent, status: 'removed' })]);
    expect(receipt.scan?.inspectedNodes).toBe(65);
    expect(inspectTrees).toHaveBeenCalledTimes(2);
    expect(inspectTrees.mock.calls[1]?.[1]).toMatchObject({ paths: [parent] });
    await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('native census handles delimiter-looking names, protected roots and symlinks without traversing them', async () => {
    const { root, options } = await setup();
    const expired = join(root, 'expired\nwith\ttabs[*]'); await writeFile(expired, 'expired');
    const protectedPath = join(root, 'native[?*]'); await mkdir(protectedPath); await chmod(protectedPath, 0);
    const owner = join(fixture!, 'owner'); await mkdir(owner); await writeFile(join(owner, 'data'), 'keep');
    const tree = join(root, 'linked'); await mkdir(tree); await symlink(owner, join(tree, 'link'));
    try {
      // Explicit live lease protects the literal path; a glob in a name cannot
      // turn the native find exclusion into a wildcard over another candidate.
      const receipt = await runDiskReclaimOnce({ ...options, protectedPaths: [protectedPath], inspectTrees: inspectRetentionTrees });
      expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
      expect(receipt.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: protectedPath, status: 'protected', reason: 'protected policy root' }),
        expect.objectContaining({ path: tree, status: 'protected', reason: 'symlink boundary' }),
        expect.objectContaining({ path: expired, status: 'removed' }),
      ]));
      expect(await stat(join(owner, 'data'))).toBeTruthy();
    } finally { await chmod(protectedPath, 0o700); }
  });
  it('native census retains a new write between planning and the effect and fails closed on unreadable trees', async () => {
    const { root, options } = await setup(); const parent = join(root, 'tree'); await mkdir(parent);
    const child = join(parent, 'data'); await writeFile(child, 'expired');
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees, record: async (phase) => {
      if (phase === 'remove-intent') await utimes(child, new Date(options.nowMs), new Date(options.nowMs));
    } });
    expect(receipt.complete).toBe(true); expect(receipt.entries[0]).toMatchObject({ path: parent, status: 'protected', reason: 'recent write' });
    expect(await stat(child)).toBeTruthy();
    await chmod(parent, 0);
    try {
      const denied = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees });
      expect(denied.complete).toBe(false); expect(denied.policyExhausted).toBeNull();
      expect(denied.entries).toEqual([]); expect(denied.errors[0]).toContain('find exited 1');
    } finally { await chmod(parent, 0o700); }
  });
  it('native census records a foreign-owned candidate as protected before trying to read it', async () => {
    const { root, options } = await setup();
    const path = join(root, 'private'); await mkdir(path); await writeFile(join(path, 'data'), 'keep'); await chmod(path, 0);
    const uid = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 1000) + 1);
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: options.nowMs - 24 * 3_600_000 });
      expect(census.error).toBeUndefined(); expect(census.entries).toEqual([]);
      expect(census.retained).toEqual([{ path, reason: 'foreign ownership boundary' }]);
    } finally { uid.mockRestore(); await chmod(path, 0o700); }
  });
  it.each([undefined, inspectRetentionTrees])('preserves an old live Unix socket when path holder evidence is empty (%s)', async (inspectTrees) => {
    const { root, options } = await setup(); const path = join(root, 'live.sock');
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    try {
      const receipt = await runDiskReclaimOnce({ ...options, inspectTrees });
      expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
      expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'protected', reason: 'special filesystem entry' })]);
      expect((await stat(path)).isSocket()).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it('never follows a symlink into owner data', async () => {
    const { root, options } = await setup(); const owner = join(fixture!, 'owner'); await mkdir(owner); await writeFile(join(owner, 'data'), 'keep');
    await symlink(owner, join(root, 'link'));
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path: join(root, 'link'), status: 'protected', reason: 'symlink boundary' })]);
    expect(await stat(join(owner, 'data'))).toBeTruthy();
  });
  it('retains an entire tree containing a symlink while draining an independent expired entry', async () => {
    const { root, options } = await setup();
    const tree = join(root, 'tree'); await mkdir(tree);
    const owner = join(fixture!, 'owner'); await mkdir(owner); await writeFile(join(owner, 'data'), 'keep');
    await symlink(owner, join(tree, 'link'));
    const expired = join(root, 'expired'); await writeFile(expired, 'remove');
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: tree, status: 'protected', reason: 'symlink boundary' }),
      expect.objectContaining({ path: expired, status: 'removed' }),
    ]));
    expect(await stat(join(owner, 'data'))).toBeTruthy();
    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('records nested protected policy trees without reading them and refuses unknown permissions', async () => {
    const { root, options } = await setup();
    const protectedPath = join(root, 'private'); await mkdir(protectedPath);
    const unknown = join(root, 'unknown'); await mkdir(unknown);
    await writeFile(join(protectedPath, 'data'), 'keep'); await writeFile(join(unknown, 'data'), 'keep');
    await chmod(protectedPath, 0); await chmod(unknown, 0);
    try {
      const policy: RetentionClass[] = [...options.policy, { id: 'protected', title: 'native private', origin: 'system', roots: [protectedPath], keep: { kind: 'keep', reason: 'native owner' }, enforcers: [{ kind: 'none' }] }];
      const receipt = await runDiskReclaimOnce({ ...options, policy });
      expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: protectedPath, status: 'protected', reason: 'protected policy root' }));
      expect(receipt.errors).toEqual([expect.stringContaining(`inspect:${unknown}: EACCES`)]);
    } finally { await chmod(protectedPath, 0o700); await chmod(unknown, 0o700); }
  });
  it('records a candidate that disappears during inspection without a false partial failure', async () => {
    const { root, options } = await setup(); const path = join(root, 'gone'); await writeFile(path, 'remove');
    inspectionProbe.before = (current) => {
      if (current === path) throw Object.assign(new Error('concurrently removed'), { code: 'ENOENT' });
      return undefined;
    };
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'changed', reason: 'disappeared during inspection' })]);
  });
  it('refuses deletion when process evidence is incomplete or a process holds the file', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const unavailable = await runDiskReclaimOnce({ ...options, scanHolders: async () => ({ complete: false, byPath: new Map() }) });
    expect(unavailable.complete).toBe(false); expect(await stat(path)).toBeTruthy();
    const held = await runDiskReclaimOnce({ ...options, scanHolders: async () => ({ complete: true, byPath: new Map([[path, ['123']]]) }) });
    expect(held.entries[0]?.status).toBe('protected'); expect(await stat(path)).toBeTruthy();
  });
  it('reports bounded scans as incomplete instead of claiming there are no eligible artifacts', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 0 });
    expect(receipt.complete).toBe(false); expect(receipt.errors.join(' ')).toContain('incomplete tree scan'); expect(await stat(path)).toBeTruthy();
  });
  it.each([{ maxEntries: 1 }, { budgetMs: 0 }])('stops an exhausted scan with bounded evidence and keeps the partial class (%j)', async (bound) => {
    const { root, options } = await setup();
    const paths = Array.from({ length: 32 }, (_, i) => join(root, `expired-${i}`));
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    const delegate = vi.fn(async () => ({ ok: true, detail: 'independent owner completed' }));
    const receipt = await runDiskReclaimOnce({ ...options, ...bound,
      delegates: [{ classId: 'independent-owner', run: delegate }],
    });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.entries).toEqual([]);
    expect(delegate).toHaveBeenCalledOnce();
    expect(receipt.delegates).toEqual([{ classId: 'independent-owner', ok: true, detail: 'independent owner completed' }]);
    for (const path of paths) expect(await stat(path)).toBeTruthy();
  });
  it('dry-run gives a deletion plan while preserving the selected file', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true });
    expect(receipt.entries[0]?.status).toBe('would-remove'); expect(await stat(path)).toBeTruthy();
  });
  it('reports missing required device evidence, never a completed empty receipt', async () => {
    const { options } = await setup();
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'] });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.devices.map((d) => d.atTarget)).toEqual([null, null]);
  });
  it('attributes bind-mount aliases to the same free-space measurement', async () => {
    const { options } = await setup();
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'], sample: async () => [{ path: '/', aliases: ['/mnt/data'], totalBytes: 300 * 1024 ** 3, freeBytes: 120 * 1024 ** 3, freePct: 0.4, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 }] });
    expect(receipt.complete).toBe(true); expect(receipt.devices.map((d) => d.atTarget)).toEqual([true, true]);
    expect(receipt.policyExhausted).toBe(true);
  });
  it('refuses effects when the durable audit cannot record the intent', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, record: async (phase) => { if (phase === 'remove-intent') throw new Error('audit offline'); } });
    expect(receipt.complete).toBe(false); expect(await stat(path)).toBeTruthy();
    expect(receipt.entries[0]?.reason).toContain('audit offline');
  });
  it('assesses the complete soak ledger in real Postgres without borrowing another workspace or host alarm', async () => {
    const db = await createFreshPgDb('disk-soak-ledger');
    const gib = 1024 ** 3, host = 'soak-fixture-host', workspace = 'soak-fixture-workspace';
    const at = (hour: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + hour * 3_600_000).toISOString();
    const requirements = { host, artifactRef: 'fixture-shipped-artifact', shippedAt: at(-1), startAt: at(0), measuredAt: at(72),
      maxSampleGapMs: 3_600_000, maxAlarmGapMs: 3_600_000 };
    try {
      await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
      for (const migration of ['1472-disk-consumer-census.sql', '761-attention-notifications-audit.sql']) {
        await db.sql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/' + migration, import.meta.url), 'utf8'));
      }
      await db.sql`
        INSERT INTO harness_shared.disk_census_runs
          (run_id, host, device, started_at, finished_at, size_bytes, used_bytes, avail_bytes, attributed_bytes, complete)
        SELECT gen_random_uuid(), ${host}, device, ${at(0)}::timestamptz + hour * interval '1 hour',
               ${at(0)}::timestamptz + hour * interval '1 hour', ${500 * gib}, ${400 * gib}, ${100 * gib}, ${400 * gib}, true
          FROM generate_series(0, 72) AS hour CROSS JOIN unnest(ARRAY['/', '/mnt/data']) AS device`;
      expect((await readDiskHeadroomSoakEvidence(db.sql, workspace, requirements)).assessment.soakStatus).toBe('pass');
      await db.sql`UPDATE harness_shared.disk_census_runs SET avail_bytes = ${99 * gib}
                    WHERE device = '/' AND finished_at = ${at(36)}::timestamptz`;
      expect((await readDiskHeadroomSoakEvidence(db.sql, workspace, requirements)).assessment.soakStatus).toBe('fail');
      const data = { conditionKey: 'alarm:disk-space', host, consumers: { '/': ['postgres'], '/mnt/data': ['scratch'] } };
      await db.sql`INSERT INTO harness_shared.attention_notifications (workspace_id, kind, title, body, data, created_at)
        VALUES ('other-workspace', 'intervention', 'fixture', 'fixture', ${db.sql.json(data)}, ${at(36)}::timestamptz),
               (${workspace}, 'intervention', 'fixture', 'fixture', ${db.sql.json({ ...data, host: 'other-host' })}, ${at(36)}::timestamptz)`;
      expect((await readDiskHeadroomSoakEvidence(db.sql, workspace, requirements)).assessment.soakStatus).toBe('fail');
      await db.sql`INSERT INTO harness_shared.attention_notifications (workspace_id, kind, title, body, data, created_at)
        VALUES (${workspace}, 'intervention', 'fixture', 'fixture', ${db.sql.json(data)}, ${at(36)}::timestamptz)`;
      expect((await readDiskHeadroomSoakEvidence(db.sql, workspace, requirements)).assessment.soakStatus).toBe('pass');
      await db.sql`INSERT INTO harness_shared.attention_notifications (workspace_id, kind, title, body, data, created_at)
        VALUES (${workspace}, 'intervention', 'fixture', 'fixture', ${db.sql.json({ conditionKey: 'alarm:disk-space' })}, ${at(48)}::timestamptz)`;
      expect((await readDiskHeadroomSoakEvidence(db.sql, workspace, requirements)).assessment.soakStatus).toBe('unknown');
    } finally { await db.cleanup(); }
  }, 120_000);
  it('persists start, exact removal intent, removed path and final receipt in real Postgres', async () => {
    const adminUri = await getTestPg();
    const name = 'reclaim_' + randomBytes(5).toString('hex');
    const admin = postgres(adminUri, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${name}"`); await markManagedTestDatabase(admin, name);
    const url = new URL(adminUri); url.pathname = '/' + name;
    const sql = postgres(url.toString(), { max: 1 });
    try {
      await sql.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, ts bigint, actor text, action text, subject text, details jsonb, workspace_id text)');
      const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
      let runId = '';
      const receipt = await runDiskReclaimOnce({ ...options, record: async (phase, detail) => {
        if (phase === 'started') runId = (detail as { id: string }).id;
        await writeReclaimAudit(sql as unknown as ReclaimSql, 'fixture-workspace', runId, phase, detail);
      } });
      const rows = await sql`SELECT action, details, jsonb_typeof(details) AS detail_type FROM harness_shared.audit_log WHERE subject = ${receipt.id} ORDER BY ts`;
      expect(rows.map((r) => r.action)).toEqual(['disk-retention:started', 'disk-retention:progress', 'disk-retention:remove-intent', 'disk-retention:removed', 'disk-retention:progress', 'disk-retention:receipt']);
      expect(rows.every((r) => r.detail_type === 'object')).toBe(true);
      expect(rows[2]!.details.path).toBe(path); expect(rows.at(-1)!.details).toEqual(receipt);
      expect(rows[1]!.details).toMatchObject({ root, selected: 1, processed: 0, remaining: 1, nextPath: path });
      expect(rows[4]!.details).toMatchObject({ root, selected: 1, processed: 1, remaining: 0, nextPath: null });
      expect(await readReclaimReceipt(sql, 'fixture-workspace')).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'fixture-workspace', receipt.id)).toEqual(receipt);
      // JSONB changes insertion order. Verify the actual receipt values, not
      // their string serialization, before allowing a continuation to remove.
      expect(JSON.stringify(rows.at(-1)!.details)).not.toBe(JSON.stringify(receipt));
      expect(await readReclaimReceipt(sql, 'fixture-workspace', receipt.id, receipt)).toEqual(receipt);
      await expect(readReclaimReceipt(sql, 'fixture-workspace', receipt.id, { ...receipt, complete: !receipt.complete })).rejects.toThrow('exact receipt readback mismatch');
      await expect(readReclaimReceipt(sql, 'other-workspace', receipt.id, receipt)).rejects.toThrow('exact receipt readback mismatch');
      expect(await readReclaimReceipt(sql, 'other-workspace', receipt.id)).toBeNull();
      expect(await readReclaimReceipt(sql, 'fixture-workspace', 'missing')).toBeNull();
      const dry = { ...receipt, id: 'dry-receipt', dryRun: true };
      await writeReclaimAudit(sql, 'fixture-workspace', dry.id, 'receipt', dry);
      expect(await readReclaimReceipt(sql, 'fixture-workspace')).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'fixture-workspace', dry.id)).toEqual(dry);
      // The production alarm context reads both device censuses and the same
      // receipt the owner follows; no fixture object replaces this PG join.
      await sql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1472-disk-consumer-census.sql', import.meta.url), 'utf8'));
      const at = new Date(); const gib = 1024 ** 3;
      for (const [device, consumer] of [['/', '/home/builduser'], ['/mnt/data', '/mnt/data/offload']]) {
        await writeCensusRun(sql as never, { runId: crypto.randomUUID(), host: hostname(),
          device: { device: device!, majorMinor: '0:0', sizeBytes: 500 * gib, usedBytes: 401 * gib, availBytes: 99 * gib },
          startedAt: at, finishedAt: at, attributedBytes: 401 * gib, complete: true, note: null,
          consumers: [{ consumer: consumer!, kind: 'dir', depth: 2, bytes: 401 * gib }],
        });
      }
      const context = await readDiskAlarmContext(sql, 'fixture-workspace');
      expect(context.receipt).toEqual(receipt);
      const notifications: AttentionNotifyInput[] = [];
      const alarm = await runDiskSpaceAlarmOnce({
        readContext: () => readDiskAlarmContext(sql, 'fixture-workspace'),
        sample: async () => [{ path: '/', totalBytes: 500 * gib, freeBytes: 99 * gib, freePct: 0.198, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 }],
        emitToast: async () => {}, attributeUsage: async () => ({ entries: [], truncated: false }),
        escalate: async (input) => { notifications.push(input); }, recentlyEscalated: async () => false,
        broadcast: async () => true,
      });
      expect(alarm.escalated).toBe(true);
      expect(notifications).toHaveLength(1);
      for (const expected of ['/home/builduser', '/mnt/data/offload', `/settings/storage?reclaim=${receipt.id}`]) expect(notifications[0]!.body).toContain(expected);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
