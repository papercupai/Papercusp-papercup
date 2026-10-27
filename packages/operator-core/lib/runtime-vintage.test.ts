/**
 * runtime-vintage — the CURRENT build-identity ledger every runtime self-reports
 * at boot (fleet-reliability-verification-2026-07-10 P-008; mig 542).
 *
 * Exercised on InMemoryRuntimeVintageStore (the same store tests inject via
 * configureRuntimeVintageStore — mirrors read-cursors.test.ts's injection
 * contract). The Pg store's upsert is exercised live by an actual boot report,
 * not here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { readProcessIdentity } from './process-identity';
import {
  InMemoryRuntimeVintageStore,
  configureRuntimeVintageStore,
  resetRuntimeVintageStore,
  reportRuntimeVintage,
  reportRuntimeVintageOnBoot,
  listRuntimeVintage,
  measureRuntimeVintageEnvironment,
  measureLiveNodeEntrySource,
  isLiveNodeEntrySourceCurrent,
  resolvePostgresInstanceReport,
  type RuntimeVintageRow,
} from './runtime-vintage';

describe('runtime-vintage — self-report ledger (P-008)', () => {
  beforeEach(() => configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()));
  afterEach(() => resetRuntimeVintageStore());

  it('reports a new (workspace, unit, host) row and lists it back', async () => {
    await reportRuntimeVintage({
      unit: 'dev-api',
      host: 'tower',
      treeSha: 'abc1234',
      bundleVersion: '1.2.3',
      pid: 4242,
      workspaceId: 'default',
    });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: 'default',
      unit: 'dev-api',
      host: 'tower',
      treeSha: 'abc1234',
      bundleVersion: '1.2.3',
      pid: 4242,
    });
    expect(rows[0].reportedAt).toBeTruthy();
  });

  it('upserts on a repeat report for the SAME (workspace, unit, host) — one row, latest wins', async () => {
    await reportRuntimeVintage({ unit: 'gateway', host: 'tower', treeSha: 'sha-old', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'gateway', host: 'tower', treeSha: 'sha-new', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0].treeSha).toBe('sha-new');
  });

  it('replaces a stale boot pin after the database recovers, retaining the original boot time', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new InMemoryRuntimeVintageStore();
      configureRuntimeVintageStore(store);
      await store.report({ unit: 'boot-retry', treeSha: 'old-boot', pid: 4242 });
      const write = vi.spyOn(store, 'report').mockRejectedValueOnce(new Error('CONNECT_TIMEOUT'));
      const bootTime = new Date().toISOString();
      const pending = reportRuntimeVintageOnBoot('boot-retry');
      await vi.dynamicImportSettled();
      expect(write).toHaveBeenCalledTimes(1);
      expect((await store.list())[0].treeSha).toBe('old-boot');
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      const rows = await store.list();
      expect(write).toHaveBeenCalledTimes(2);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ unit: 'boot-retry', pid: process.pid, buildTime: bootTime });
      expect(rows[0].treeSha).not.toBe('old-boot');
      expect(rows[0].extra.kernelProcessIdentity).toBe(readProcessIdentity(process.pid));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('bounds boot reporting retries and leaves the previous pin unchanged when every write fails', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new InMemoryRuntimeVintageStore();
      configureRuntimeVintageStore(store);
      await store.report({ unit: 'boot-retry-exhausted', treeSha: 'old-boot', pid: 4242 });
      const write = vi.spyOn(store, 'report').mockRejectedValue(new Error('CONNECT_TIMEOUT'));
      const pending = reportRuntimeVintageOnBoot('boot-retry-exhausted');
      await vi.dynamicImportSettled();
      await vi.runAllTimersAsync();
      await pending;
      expect(write).toHaveBeenCalledTimes(5);
      expect((await store.list())[0]).toMatchObject({ treeSha: 'old-boot', pid: 4242 });
      expect(warn).toHaveBeenLastCalledWith(expect.any(String), 'CONNECT_TIMEOUT', 'retry budget exhausted');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps distinct rows per host for the same unit (fleet of Mac/Windows/tower bundles)', async () => {
    await reportRuntimeVintage({ unit: 'desktop-sidecar', host: 'mac-01', treeSha: 'sha-mac', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'desktop-sidecar', host: 'win-01', treeSha: 'sha-win', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.host).sort()).toEqual(['mac-01', 'win-01']);
  });

  it('isolates rows per workspace', async () => {
    await reportRuntimeVintage({ unit: 'dev-api', host: 'tower', treeSha: 'sha-a', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'dev-api', host: 'tower', treeSha: 'sha-b', workspaceId: 'ws-b' });
    expect(await listRuntimeVintage('ws-a')).toHaveLength(1);
    expect(await listRuntimeVintage('ws-b')).toHaveLength(1);
    expect((await listRuntimeVintage('ws-a'))[0].treeSha).toBe('sha-a');
  });
  it('selects only named units and preserves workspace isolation', async () => {
    await reportRuntimeVintage({ unit: 'own-test', host: 'tower', treeSha: 'aaaaaaa', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'other-test', host: 'tower', treeSha: 'bbbbbbb', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'own-test', host: 'tower', treeSha: 'ccccccc', workspaceId: 'ws-b' });
    expect(await listRuntimeVintage('ws-a', undefined, ['own-test']))
      .toEqual([expect.objectContaining({ unit: 'own-test', treeSha: 'aaaaaaa', workspaceId: 'ws-a' })]);
    expect(await listRuntimeVintage('ws-a', undefined, [])).toEqual([]);
    expect(await listRuntimeVintage('ws-a', undefined, ['missing'])).toEqual([]);
  });

  it('defaults host to os.hostname() when omitted', async () => {
    await reportRuntimeVintage({ unit: 'bg-host', treeSha: 'sha-x', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBeTruthy();
  });

  it('sorts listed rows by unit then host', async () => {
    await reportRuntimeVintage({ unit: 'gateway', host: 'b-host', treeSha: 's1', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'bg-host', host: 'a-host', treeSha: 's2', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'bg-host', host: 'z-host', treeSha: 's3', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows.map((r) => `${r.unit}:${r.host}`)).toEqual(['bg-host:a-host', 'bg-host:z-host', 'gateway:b-host']);
  });

  it('pins its own process from the kernel and strips caller-authored pins', async () => {
    await reportRuntimeVintage({ unit: 'self', pid: process.pid, treeSha: 'a'.repeat(40), workspaceId: 'default',
      extra: { kernelProcessIdentity: 'invented' } });
    const rows = await listRuntimeVintage('default');
    const identity = readProcessIdentity(process.pid);
    if (identity) {
      expect(rows[0].extra.kernelProcessIdentity).toBe(identity);
      expect(measureRuntimeVintageEnvironment(rows, ['self'])).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(rows[0].extra).not.toHaveProperty('kernelProcessIdentity');
      expect(measureRuntimeVintageEnvironment(rows, ['self'])).toBeNull();
    }
    await reportRuntimeVintage({ unit: 'remote', host: `${hostname()}-remote`, pid: process.pid,
      workspaceId: 'default', extra: { kernelProcessIdentity: 'invented' } });
    expect((await listRuntimeVintage('default')).find(row => row.unit === 'remote')!.extra)
      .not.toHaveProperty('kernelProcessIdentity');
  });

  const pinnedRow = (unit = 'bg-host'): RuntimeVintageRow => ({
    workspaceId: 'default', unit, host: 'local', treeSha: 'a'.repeat(40), buildTime: '2026-10-07T00:00:00Z',
    bundleVersion: null, pid: 42, extra: { kernelProcessIdentity: 'boot:start' }, reportedAt: 'now',
  });

  it('refuses missing, dead, reused, remote and legacy runtime identities', () => {
    const deps = { host: 'local', identity: () => 'boot:start' };
    const row = pinnedRow();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], deps)).toMatch(/^[a-f0-9]{64}$/);
    for (const rows of [[], [{ ...row, host: 'remote' }], [{ ...row, extra: {} }],
      [{ ...row, treeSha: null }], [{ ...row, treeSha: 'unknown' }], [row, row]]) {
      expect(measureRuntimeVintageEnvironment(rows, ['bg-host'], deps)).toBeNull();
    }
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], { ...deps, identity: () => null })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], { ...deps, identity: () => 'boot:reused' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], [], deps)).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host', 'bg-host'], deps)).toBeNull();
  });

  it('fingerprints all selected runtime identities independently of row order or heartbeat', () => {
    const rows = [pinnedRow(), pinnedRow('desktop')];
    const deps = { host: 'local', identity: () => 'boot:start' };
    const original = measureRuntimeVintageEnvironment(rows, ['desktop', 'bg-host'], deps);
    expect(measureRuntimeVintageEnvironment([...rows].reverse().map(row => ({ ...row, reportedAt: 'later' })),
      ['bg-host', 'desktop'], deps)).toBe(original);
    expect(measureRuntimeVintageEnvironment([{ ...rows[0], treeSha: 'b'.repeat(40) }, rows[1]],
      ['desktop', 'bg-host'], deps)).not.toBe(original);
  });

  it('hashes equivalent PG boot timestamps identically while retaining actual boot changes', () => {
    const deps = { host: 'local', identity: () => 'boot:start' };
    const fingerprint = (buildTime: string | null) => measureRuntimeVintageEnvironment(
      [{ ...pinnedRow(), buildTime }], ['bg-host'], deps);
    const iso = fingerprint('2026-10-07T15:41:11.125Z');
    expect(iso).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint('2026-10-07 11:41:11.125-04')).toBe(iso);
    expect(fingerprint('2026-10-07T11:41:11.125-04:00')).toBe(iso);
    // postgres-js may return Date despite the persisted row's string type.
    expect(fingerprint(new Date('2026-10-07T15:41:11.125Z') as unknown as string)).toBe(iso);
    expect(fingerprint('2026-10-07T15:41:11.126Z')).not.toBe(iso);
    expect(fingerprint('invalid')).toBeNull();
    expect(fingerprint(null)).not.toBe(iso);
  });

  it('independently pins the loaded executable without inventing a Git revision', async () => {
    if (process.platform !== 'linux') return;
    const digest = createHash('sha256').update(readFileSync(`/proc/${process.pid}/exe`)).digest('hex');
    await reportRuntimeVintage({ unit: 'native', pid: process.pid, treeSha: null,
      bundleVersion: `executable-sha256:${digest}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: 'caller-authored', kernelExecutableStat: 'caller-authored' } });
    const rows = await listRuntimeVintage('default');
    expect(rows[0].treeSha).toBeNull();
    expect(rows[0].extra.kernelExecutableDigest).toBe(digest);
    expect(rows[0].extra.kernelExecutableStat).not.toBe('caller-authored');
    expect(measureRuntimeVintageEnvironment(rows, ['native'])).toMatch(/^[a-f0-9]{64}$/);
    await reportRuntimeVintage({ unit: 'wrong', pid: process.pid, treeSha: null,
      bundleVersion: `executable-sha256:${'0'.repeat(64)}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: '0'.repeat(64) } });
    const wrong = (await listRuntimeVintage('default')).filter(row => row.unit === 'wrong');
    expect(wrong[0].extra).not.toHaveProperty('kernelExecutableDigest');
    expect(measureRuntimeVintageEnvironment(wrong, ['wrong'])).toBeNull();
    await reportRuntimeVintage({ unit: 'remote-native', host: `${hostname()}-remote`, pid: process.pid,
      treeSha: null, bundleVersion: `executable-sha256:${digest}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: digest } });
    expect((await listRuntimeVintage('default')).find(row => row.unit === 'remote-native')!.extra)
      .not.toHaveProperty('kernelExecutableDigest');
  });

  it('pins a real direct Node bundle and refuses a post-start rewrite of its entry', async () => {
    if (process.platform !== 'linux') return;
    const dir = await mkdtemp(join(tmpdir(), 'runtime-vintage-entry-'));
    const entry = join(dir, 'serve.cjs');
    const source = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
    await writeFile(entry, source);
    await new Promise(resolve => setTimeout(resolve, 50));
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      const digest = createHash('sha256').update(source).digest('hex');
      const sourcePin = measureLiveNodeEntrySource(child.pid!);
      expect(sourcePin).toMatchObject({ pid: child.pid, sha256: digest, entry });
      expect(isLiveNodeEntrySourceCurrent(sourcePin!)).toBe(true);
      expect(isLiveNodeEntrySourceCurrent({ ...sourcePin!, processIdentity: 'replaced-process' })).toBe(false);
      await reportRuntimeVintage({ unit: 'node-bundle', pid: child.pid!, treeSha: null,
        bundleVersion: `node-entry-sha256:${digest}`, workspaceId: 'default',
        extra: { kernelNodeEntryDigest: 'caller-authored' } });
      const rows = await listRuntimeVintage('default');
      expect(rows[0].treeSha).toBeNull();
      expect(rows[0].extra.kernelNodeEntryDigest).toBe(digest);
      expect(measureRuntimeVintageEnvironment(rows, ['node-bundle'])).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(entry, `${source}\n// changed after startup`);
      expect(isLiveNodeEntrySourceCurrent(sourcePin!)).toBe(false);
      expect(measureLiveNodeEntrySource(child.pid!)).toBeNull();
      expect(measureRuntimeVintageEnvironment(rows, ['node-bundle'])).toBeNull();
      await reportRuntimeVintage({ unit: 'changed-bundle', pid: child.pid!, treeSha: null,
        bundleVersion: `node-entry-sha256:${createHash('sha256').update(readFileSync(entry)).digest('hex')}`,
        workspaceId: 'default', extra: { kernelNodeEntryDigest: digest } });
      expect((await listRuntimeVintage('default')).find(row => row.unit === 'changed-bundle')!.extra)
        .not.toHaveProperty('kernelNodeEntryDigest');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'close');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects changed executable bytes, missing digest pins and process replacement during measurement', () => {
    const digest = 'b'.repeat(64);
    const row = { ...pinnedRow('native'), treeSha: null,
      bundleVersion: `executable-sha256:${digest}`,
      extra: { kernelProcessIdentity: 'boot:start', kernelExecutableDigest: digest,
        kernelExecutableStat: 'loaded:inode:metadata' } };
    const deps = { host: 'local', identity: () => 'boot:start', executableStat: () => 'loaded:inode:metadata' };
    expect(measureRuntimeVintageEnvironment([row], ['native'], deps)).toMatch(/^[a-f0-9]{64}$/);
    expect(measureRuntimeVintageEnvironment([row], ['native'], { ...deps,
      executableStat: () => 'changed:inode:metadata' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([{ ...row, extra: { kernelProcessIdentity: 'boot:start' } }],
      ['native'], deps)).toBeNull();
    let reads = 0;
    expect(measureRuntimeVintageEnvironment([row], ['native'], { ...deps,
      identity: () => ++reads === 1 ? 'boot:start' : 'boot:replacement' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['native'], {
      host: 'local', identity: deps.identity })).toBeNull();
  });
});

describe('runtime-vintage — the postgres instance as a runtime (WI-6554700010008529)', () => {
  beforeEach(() => configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()));
  afterEach(() => resetRuntimeVintageStore());

  const VERSION = 'PostgreSQL 16.4 (Ubuntu 16.4-1.pgdg24.04+1) on x86_64-pc-linux-gnu';
  const STARTED = '2026-10-11T07:28:36.539Z';
  const stat = (pid: number, ppid: number) =>
    `${pid} (postgres) S ${ppid} ${ppid} ${ppid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`;
  /** A process table: backend 900 -> postmaster 800 -> init. */
  const table = (over: Partial<Record<'backendComm' | 'postmasterComm', string>> = {}, startedAt = Date.parse(STARTED) + 400) => ({
    readStat: (pid: number) => (pid === 900 ? stat(900, 800) : pid === 800 ? stat(800, 1) : null),
    readComm: (pid: number) =>
      pid === 900 ? over.backendComm ?? 'postgres' : pid === 800 ? over.postmasterComm ?? 'postgres' : null,
    startedAtMs: () => startedAt,
  });
  const probe = { backendPid: 900, port: '5432', version: VERSION, postmasterStartTime: STARTED };

  it('names the instance by its postmaster, server build and start time', () => {
    expect(resolvePostgresInstanceReport(probe, table())).toEqual({
      unit: 'postgres:5432',
      treeSha: createHash('sha256').update(VERSION).digest('hex').slice(0, 40),
      buildTime: STARTED,
      bundleVersion: null,
      pid: 800,
      extra: { kind: 'postgres', port: '5432', serverVersion: 'PostgreSQL 16.4' },
    });
    // The driver may return a Date; the instant, not its encoding, is the identity.
    expect(resolvePostgresInstanceReport({ ...probe, postmasterStartTime: new Date(STARTED) }, table())?.buildTime)
      .toBe(STARTED);
  });

  it('fails closed unless the server is a verifiable local process', () => {
    expect(resolvePostgresInstanceReport(probe, table({ backendComm: 'bash' }))).toBeNull();
    expect(resolvePostgresInstanceReport(probe, table({ postmasterComm: 'systemd' }))).toBeNull();
    // A container backend whose pid collides with an unrelated local postgres: the
    // local process started at a different time from the server's own record.
    expect(resolvePostgresInstanceReport(probe, table({}, Date.parse(STARTED) - 3_600_000))).toBeNull();
    expect(resolvePostgresInstanceReport({ ...probe, backendPid: 901 }, table())).toBeNull();
    expect(resolvePostgresInstanceReport({ ...probe, port: 'abc' }, table())).toBeNull();
    expect(resolvePostgresInstanceReport({ ...probe, version: ' ' }, table())).toBeNull();
    expect(resolvePostgresInstanceReport({ ...probe, postmasterStartTime: 'never' }, table())).toBeNull();
    expect(resolvePostgresInstanceReport(probe, { ...table(), readStat: (pid) => (pid === 900 ? stat(900, 1) : null) }))
      .toBeNull();
  });

  it('keeps one environment fingerprint across operator reboots and changes it when postgres restarts', async () => {
    if (process.platform !== 'linux' || !readProcessIdentity(process.pid)) return;
    // This test process stands in for the postmaster so the kernel pin is real.
    const self = process.pid;
    const selfStat = readFileSync(`/proc/${self}/stat`, 'utf8');
    const local = (startedAt: number) => ({
      readStat: (pid: number) => (pid === 999_999 ? stat(999_999, self) : pid === self ? selfStat : null),
      readComm: () => 'postgres',
      startedAtMs: () => startedAt,
    });
    const at = Date.parse(STARTED);
    const bootReport = async () => {
      const report = resolvePostgresInstanceReport({ ...probe, backendPid: 999_999 }, local(at));
      expect(report).not.toBeNull();
      await reportRuntimeVintage({ ...report!, workspaceId: 'default' });
      return measureRuntimeVintageEnvironment(await listRuntimeVintage('default'), ['postgres:5432']);
    };
    const first = await bootReport();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    // A second operator (or the same one after a restart) reports the same instance.
    expect(await bootReport()).toBe(first);
    // A postgres restart moves the start time, so evidence pinned to the old instance goes stale.
    const restarted = resolvePostgresInstanceReport(
      { ...probe, backendPid: 999_999, postmasterStartTime: new Date(at + 60_000) }, local(at + 60_000));
    await reportRuntimeVintage({ ...restarted!, workspaceId: 'default' });
    expect(measureRuntimeVintageEnvironment(await listRuntimeVintage('default'), ['postgres:5432']))
      .not.toBe(first);
  });
});
