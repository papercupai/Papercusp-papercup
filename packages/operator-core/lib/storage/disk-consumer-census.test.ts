/**
 * resolveCensusSudo — when the disk consumer census walks as root
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * A stub `sudo` on a private PATH stands in for the real binary, so the default
 * probe (`sudo -n true`) runs for real without needing real privilege.
 */
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextCollector } from '../child-output.js';
import { inspectRetentionTrees, measureDocker, resolveCensusSudo, type CensusSpawn } from './disk-consumer-census';

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: vi.fn(),
}));

const isRoot = process.getuid?.() === 0;

describe('streaming retention census evidence', () => {
  it('refuses exact pin allocation from an expiry-compacted census', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-pin-compaction-'));
    try {
      const spawn = vi.fn();
      const result = await inspectRetentionTrees(root, { retainAfterMs: Infinity,
        coversPinnedPath: () => true, spawn });
      expect(result.error).toMatch(/pin allocation.*uncompacted/);
      expect(result.pinnedBytes).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['capped', 'uncapped'])('compacts %s native file metadata without changing allocation, boundaries or build evidence', async (mode) => {
    const includeRecent = mode === 'capped';
    const root = mkdtempSync(join(tmpdir(), 'retention-compact-capped-'));
    try {
      const tree = join(root, 'tree'); await fsp.mkdir(tree);
      await Promise.all(Array.from({ length: 512 }, (_, index) => fsp.writeFile(join(tree, `file-${index}`), 'allocated')));
      const modules = join(tree, 'node_modules'); await fsp.mkdir(modules);
      await fsp.writeFile(join(modules, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55');
      await fsp.link(join(tree, 'file-0'), join(tree, 'shared'));
      await fsp.link(join(tree, 'file-0'), join(root, 'shared-sibling'));
      const protectedTree = join(root, 'protected'); await fsp.mkdir(protectedTree);
      await fsp.symlink('/never-follow-retention-link', join(protectedTree, 'link'));
      const options = { retainAfterMs: Infinity, includeRecent, collectBuildDirs: true };
      const producerWire = createTextCollector();
      const expected = await inspectRetentionTrees(root, { ...options, spawn: ((command: string, args: string[]) => {
        const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        producerWire.attach(child.stdout);
        return child;
      }) as CensusSpawn });
      const wire = createTextCollector();
      const native = ((_: string, args: string[]) => {
        // Exercise the real privileged supervisor/timeout as our fixture uid.
        const child = spawnProcess(args[2]!, args.slice(3), { stdio: ['ignore', 'pipe', 'pipe'] });
        wire.attach(child.stdout);
        return child;
      }) as CensusSpawn;
      const compact = await inspectRetentionTrees(root, { ...options, sudo: '/usr/bin/sudo', spawn: native,
        timeoutMs: 10_000, progressTimeoutMs: 5000 });
      const ordered = (value: typeof expected) => ({ ...value, timing: undefined,
        entries: [...value.entries].sort((a, b) => a.path.localeCompare(b.path)),
        retained: [...value.retained].sort((a, b) => a.path.localeCompare(b.path)) });
      expect(compact.error).toBeUndefined();
      expect(ordered(compact)).toEqual(ordered(expected));
      expect(compact.inspectedNodes).toBeGreaterThan(512);
      expect(wire.text().split('\0').length / 9).toBeLessThan(compact.inspectedNodes / 4);
      expect(compact.entries.find(entry => entry.path === tree)?.hardlinks?.[0]?.paths).toHaveLength(2);
      expect(compact.entries.find(entry => entry.path === tree)?.buildDirs).toContainEqual(expect.objectContaining({ path: modules }));
      expect(compact.entries).toContainEqual(expect.objectContaining({ path: protectedTree, buildDirs: [] }));
      expect(compact.retained).not.toContainEqual(expect.objectContaining({ path: protectedTree, reason: 'symlink boundary' }));
      if (!includeRecent) expect(producerWire.text().split('\0').length / 9).toBeLessThan(expected.inspectedNodes / 4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['special', 'policy'])('stops an uncapped candidate at its first conclusive %s boundary in one native walk', async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-early-protection-'));
    try {
      const tree = join(root, 'tree'); await fsp.mkdir(tree);
      const paths = Array.from({ length: 64 }, (_, index) => join(tree, `boundary-${index}`));
      for (const path of paths) {
        if (boundary === 'policy') await fsp.writeFile(path, 'protected');
      }
      if (boundary === 'special') execFileSync('mkfifo', ['--', ...paths]);
      const sibling = join(root, 'eligible'); await fsp.writeFile(sibling, 'old');
      const spawn = vi.fn((command: string, args: string[]) => spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, spawn,
        ...(boundary === 'policy' ? { excludedPaths: paths } : {}) });
      expect(census.error).toBeUndefined();
      expect(census.entries).toEqual([expect.objectContaining({ path: sibling })]);
      expect(census.retained).toEqual([{ path: tree, reason: boundary === 'special' ? 'special filesystem entry' : 'protected policy root' }]);
      expect(census.inspectedNodes).toBe(3);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await fsp.readdir(tree)).toHaveLength(64);
      // Capped roots still inspect every protected allocation for accounting.
      const full = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, includeRecent: true,
        ...(boundary === 'policy' ? { excludedPaths: paths } : {}) });
      expect(full.error).toBeUndefined(); expect(full.inspectedNodes).toBe(66);
      expect(full.retained[0]?.entry?.bytes).toBeGreaterThanOrEqual((await fsp.stat(tree)).blocks * 512);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('counts symlink children as removable metadata without following their targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-symlink-child-'));
    const target = mkdtempSync(join(tmpdir(), 'retention-symlink-target-'));
    try {
      const tree = join(root, 'tree'); await fsp.mkdir(tree);
      await fsp.mkdir(join(tree, 'node_modules'));
      const targetFile = join(target, 'owner-data'); await fsp.writeFile(targetFile, 'preserve');
      await fsp.symlink(target, join(tree, 'directory-link'));
      await fsp.symlink(join(target, 'missing'), join(tree, 'broken-link'));
      const sibling = join(root, 'eligible'); await fsp.writeFile(sibling, 'expired');
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000 });
      expect(census.error).toBeUndefined();
      expect(census.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: tree }), expect.objectContaining({ path: sibling }),
      ]));
      expect(census.retained).toEqual([]);
      // tree + node_modules + two links + sibling; link targets are outside the scan.
      expect(census.inspectedNodes).toBe(5);
      const buildCensus = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, collectBuildDirs: true });
      expect(buildCensus.error).toBeUndefined();
      expect(buildCensus.entries).toContainEqual(expect.objectContaining({ path: tree, buildDirs: [] }));
      expect(buildCensus.retained).toEqual([]);
      expect(buildCensus.inspectedNodes).toBe(5);
      expect(await fsp.readFile(targetFile, 'utf8')).toBe('preserve');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
  });

  it('stops an uncapped recent tree before reading its children', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-early-recent-'));
    try {
      const tree = join(root, 'tree'); await fsp.mkdir(tree);
      for (let index = 0; index < 64; index++) await fsp.writeFile(join(tree, String(index)), 'recent');
      const census = await inspectRetentionTrees(root, { retainAfterMs: 1 });
      expect(census.error).toBeUndefined(); expect(census.entries).toEqual([]);
      expect(census.retainedRecentTrees).toBe(1); expect(census.inspectedNodes).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('counts hardlinks once within a subtree and preserves shared sibling identities (capped=%s)', async (includeRecent) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-hardlinks-'));
    try {
      const tree = join(root, 'tree'); await fsp.mkdir(tree);
      const file = join(tree, 'first'); await fsp.writeFile(file, Buffer.alloc(65536));
      await fsp.link(file, join(tree, 'second')); await fsp.link(file, join(root, 'sibling'));
      const census = await inspectRetentionTrees(root, { retainAfterMs: Infinity, includeRecent });
      const allocation = (await fsp.stat(file)).blocks * 512;
      expect(census.error).toBeUndefined();
      expect(census.entries.find(entry => entry.path === tree)?.bytes).toBe((await fsp.stat(tree)).blocks * 512 + allocation);
      expect(census.entries.find(entry => entry.path === tree)?.hardlinks).toEqual([
        expect.objectContaining({ bytes: allocation, paths: [file, join(tree, 'second')] }),
      ]);
      expect(census.entries.find(entry => entry.path === join(root, 'sibling'))?.hardlinks).toEqual([
        expect.objectContaining({ bytes: allocation, paths: [join(root, 'sibling')] }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['root', 'child'])('refuses an uncapped %s replaced before opening its directory descriptor', async (replacement) => {
    const fixture = mkdtempSync(join(tmpdir(), 'retention-descriptor-race-'));
    const root = join(fixture, 'root'); const outside = join(fixture, 'outside');
    await fsp.mkdir(root); await fsp.mkdir(outside);
    await fsp.writeFile(join(outside, 'must-not-read'), 'outside');
    const victim = replacement === 'root' ? root : join(root, 'victim');
    if (replacement === 'child') await fsp.mkdir(victim);
    const spawn = ((command: string, args: string[]) => {
      const index = args.findIndex(value => value.includes('retention root changed before census'));
      expect(index).toBeGreaterThan(0);
      // Replace the selected directory at the actual open boundary. The native
      // worker's real O_NOFOLLOW and descriptor identity checks must refuse it.
      const hook = `
real_open = os.open
replaced = False
def race_open(path, flags, *args, **kwargs):
    global replaced
    if not replaced and path == ${JSON.stringify(replacement === 'root' ? root : 'victim')}:
        replaced = True
        os.rename(${JSON.stringify(victim)}, ${JSON.stringify(victim + '-old')})
        os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(victim)})
    return real_open(path, flags, *args, **kwargs)
os.open = race_open
`;
      const argv = [...args]; argv[index] = argv[index]!.replace("config = json.loads(sys.argv[1])", hook + '\nconfig = json.loads(sys.argv[1])');
      return spawnProcess(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    }) as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Infinity, spawn });
      expect(census.error).toContain('find exited 1');
      expect(census.entries).toEqual([]); expect(census.inspectedNodes).toBe(replacement === 'root' ? 0 : 1);
      expect(await fsp.readFile(join(outside, 'must-not-read'), 'utf8')).toBe('outside');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('inspects multiple selected uncapped children in one native process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-targeted-expiry-'));
    try {
      const selected = [join(root, 'first'), join(root, 'second')];
      for (const path of [...selected, join(root, 'not-selected')]) await fsp.writeFile(path, 'old');
      const spawn = vi.fn((command: string, args: string[]) => spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
      const census = await inspectRetentionTrees(root, { retainAfterMs: Infinity, paths: selected, spawn });
      expect(census.error).toBeUndefined(); expect(census.entries.map(value => value.path)).toEqual(selected);
      expect(census.inspectedNodes).toBe(2); expect(spawn).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('measures recent foreign-owned bytes under explicit sudo and retains special trees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-full-'));
    const info = await fsp.lstat(root);
    const spawn = ((command: string, args: string[]) => {
      expect(command).toBe('/usr/bin/sudo'); expect(args.slice(0, 2)).toEqual(['-n', '--']);
      expect(args).not.toContain('-uid'); expect(args).not.toContain('-newermt');
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        const row = (type: string, name: string, blocks: string) => [type, String(info.dev), '1', '2000000000.0', '2000000000.0', blocks, '99999', '1', join(root, name), ''].join('\0');
        child.stdout.write(row('f', 'recent', '4') + row('d', 'special', '1') + row('p', 'special/fifo', '0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const result = await inspectRetentionTrees(root, { retainAfterMs: 1, includeRecent: true, sudo: '/usr/bin/sudo', spawn });
      expect(result.error).toBeUndefined();
      expect(result.entries).toEqual([expect.objectContaining({ path: join(root, 'recent'), bytes: 2048 })]);
      expect(result.retained).toEqual([expect.objectContaining({ reason: 'special filesystem entry', entry: expect.objectContaining({ bytes: 512 }) })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ['1792019778.0253824420', 1792019778025.3823],
    ['1792019778.0263825090', 1792019778026.3826],
    ['-0.5000000000', -500],
  ])('keeps the lstat millisecond identity of native timestamp %s', async (timestamp, expectedMs) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timestamp-'));
    const info = await fsp.lstat(root);
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.write(['f', String(info.dev), '1', timestamp, timestamp, '1', String(process.getuid?.() ?? 0), '1', join(root, 'unchanged'), ''].join('\0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, spawn });
      expect(census.error).toBeUndefined();
      expect(census.entries).toEqual([expect.objectContaining({ path: join(root, 'unchanged'), newestWriteMs: expectedMs })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['1e3', '1.1234567891', 'NaN'])('refuses an invalid native timestamp %s', async (timestamp) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timestamp-invalid-'));
    const info = await fsp.lstat(root);
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.write(['f', String(info.dev), '1', timestamp, '1.0', '1', String(process.getuid?.() ?? 0), '1', join(root, 'unknown'), ''].join('\0'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: 2_000_000_000_000, spawn });
      expect(census.error).toBe('incomplete retention metadata records');
      expect(census.entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lets a large advancing native census finish and tolerates concurrent readdir disappearance only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-progress-'));
    const info = await fsp.lstat(root);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    let started!: () => void; const launched = new Promise<void>((resolve) => { started = resolve; });
    const spawn = ((_command: string, args: string[]) => {
      expect(args).toContain('-ignore_readdir_race'); started(); return child;
    }) as unknown as CensusSpawn;
    vi.useFakeTimers();
    try {
      const census = inspectRetentionTrees(root, { retainAfterMs: Date.now(), includeRecent: true, progressTimeoutMs: 25, spawn });
      await launched;
      const record = (name: string) => ['f', String(info.dev), '1', '1.0', '1.0', '1', String(process.getuid?.() ?? 0), '1', join(root, name), ''].join('\0');
      child.stdout.write(record('first')); await vi.advanceTimersByTimeAsync(20);
      child.stdout.write(record('second')); await vi.advanceTimersByTimeAsync(20);
      child.stdout.write(record('third')); await vi.advanceTimersByTimeAsync(20);
      child.emit('close', 0);
      const result = await census;
      expect(result.error).toBeUndefined(); expect(result.entries).toHaveLength(3);
      expect(child.kill).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses truncated and malformed metadata instead of selecting a partial tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-metadata-'));
    const spawn = ((_command: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.write('f\0not-a-device\0'); child.emit('close', 0); });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), spawn });
      expect(census.error).toBe('incomplete retention metadata records');
      expect(census.entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts the real native directory-descent disappearance that ignore_readdir_race does not cover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-descent-race-'));
    const vanished = join(root, 'vanished');
    await fsp.mkdir(vanished); await fsp.writeFile(join(root, 'survivor'), 'keep');
    let nativeExit: number | null | undefined;
    const spawn = ((command: string, args: string[]) => {
      // Remove the empty directory after the actual find emits its metadata,
      // immediately before find tries to descend. No timing-dependent churn.
      const child = spawnProcess(command, [...args, '-a', '(', '!', '-path', vanished,
        '-o', '-exec', 'rmdir', '--', '{}', ';', ')'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('close', (code) => { nativeExit = code; });
      return child;
    }) as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now() + 60_000, includeRecent: true, spawn });
      expect(nativeExit).toBe(1);
      expect(await fsp.lstat(vanished).catch((error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
      expect(census.error).toBeUndefined();
      expect(census.entries).toContainEqual(expect.objectContaining({ path: join(root, 'survivor') }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['present', 'permission', 'mixed', 'overflow', 'malformed'])('refuses unproven or incomplete disappearance evidence (%s)', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-descent-refusal-'));
    const path = join(root, 'candidate');
    const info = await fsp.lstat(root);
    if (mode === 'present') await fsp.mkdir(path);
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.write(['f', String(info.dev), '1', '1.0', '1.0', '1', String(process.getuid?.() ?? 0), '1', join(root, 'survivor'), ''].join('\0'));
        const missing = `find: ‘${path}’: No such file or directory\n`;
        child.stderr.write(mode === 'permission' ? `find: ‘${path}’: Permission denied\n` :
          mode === 'mixed' ? `find: ‘${path}’: Permission denied\n${missing}` :
          mode === 'overflow' ? 'x'.repeat(4096) + missing : missing);
        if (mode === 'malformed') child.stdout.write('f\0truncated');
        child.emit('close', 1);
      });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), spawn });
      expect(census.error).toBeDefined(); expect(census.entries).toEqual([]);
      if (mode === 'malformed') expect(census.error).toBe('incomplete retention metadata records');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('kills a timed-out native walk and refuses the incomplete candidate set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-timeout-'));
    const kill = vi.fn();
    const spawn = ((_command: string, _args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
      kill.mockImplementation(() => { child.emit('close', null); return true; });
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), timeoutMs: 1, spawn });
      expect(census.error).toBe('retention native census timed out');
      expect(census.timing).toMatchObject({ timeoutKind: 'absolute', timeoutMs: 1,
        lastProgressAfterMs: null, lastChildPath: null });
      expect(census.entries).toEqual([]); expect(kill).toHaveBeenCalledWith('SIGKILL');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('bounds an elevated walk inside sudo without relying on caller signals (progress-only=%s)', async (progressOnly) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-root-timeout-'));
    const kill = vi.fn();
    const spawn = ((command: string, args: string[]) => {
      expect(command).toBe('/usr/bin/sudo');
      expect(args.slice(0, 2)).toEqual(['-n', '--']);
      expect(args[2]).toMatch(/\/timeout$/);
      if (progressOnly) {
        expect(args.slice(3, 6)).toEqual(['--signal=KILL', '--verbose', '900s']);
        expect(args).toContain('-I');
      } else expect(args.slice(3, 7)).toEqual(['--foreground', '--signal=KILL', '--verbose', '0.025s']);
      expect(args.indexOf('find')).toBeGreaterThan(5);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
      kill.mockImplementation(() => { child.emit('error', new Error('kill EPERM')); return false; });
      // The elevated timeout reaps its own child; the ordinary caller cannot.
      setTimeout(() => child.emit('close', 137), 35);
      return child;
    }) as unknown as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), sudo: '/usr/bin/sudo', spawn,
        includeRecent: true, ...(progressOnly ? { progressTimeoutMs: 25 } : { timeoutMs: 25 }) });
      expect(census.error).toBe('retention native census timed out');
      expect(census.timing?.timeoutKind).toBe('native-signal');
      expect(census.entries).toEqual([]); expect(kill).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('renews the elevated progress deadline across advancing records with controlled native time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-privileged-advancing-'));
    const info = await fsp.lstat(root);
    const diagnostics = createTextCollector();
    let signalAttempts = 0;
    const spawn = ((_command: string, args: string[]) => {
      const worker = args[args.indexOf('-c') + 1]!;
      const python = args[args.indexOf('-I') - 1]!;
      // Execute the production Python supervisor, controlling only its input
      // and clock. Five valid records span more than one inactivity window;
      // missing deadline renewal fails without depending on host scheduling.
      const fixture = `import atexit, os, selectors, subprocess, sys, time
clock = [0.0]
root, dev = sys.argv[2], ${JSON.stringify(String(info.dev))}
chunks = [b'\\0'.join([b'f', dev.encode(), str(i + 1).encode(), b'1.0', b'1.0', b'1', str(os.getuid()).encode(), b'1', os.fsencode(root + '/entry-' + str(i))]) + b'\\0' for i in range(5)] + [b'']
class Pipe:
    def fileno(self): return 42
class Child:
    stdout = Pipe()
    def poll(self): return 0
    def wait(self): return 0
    def kill(self): pass
class Selector:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def register(self, *args): pass
    def select(self, timeout):
        clock[0] += min(timeout, 0.75)
        return [(None, None)] if timeout >= 0.75 else []
time.monotonic = lambda: clock[0]
selectors.DefaultSelector = Selector
subprocess.Popen = lambda *args, **kwargs: Child()
os.read = lambda *args: chunks.pop(0)
atexit.register(lambda: print('fixture-clock=' + str(clock[0]), file=sys.stderr))
`;
      const child = spawnProcess(python, ['-I', '-c', fixture + worker, '1000', root, 'compact', 'fixture-find'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      diagnostics.attach(child.stderr);
      child.kill = () => { signalAttempts++; return false; };
      return child;
    }) as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), sudo: '/usr/bin/sudo', spawn,
        includeRecent: true, progressTimeoutMs: 1000 });
      expect(census.error).toBeUndefined();
      expect(census.entries).toHaveLength(5);
      expect(census.timing?.timeoutKind).toBeNull();
      expect(diagnostics.text()).toContain('fixture-clock=4.5');
      expect(signalAttempts).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['stalled', 'noise', 'ceiling'])('supervises elevated metadata progress inside the privilege boundary (%s)', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'retention-privileged-progress-'));
    const info = await fsp.lstat(root);
    let signalAttempts = 0;
    const spawn = ((_command: string, args: string[]) => {
      // Run the exact elevated supervisor as this test's uid. Replace only
      // find's output producer; the native timeout and supervisor run for real.
      expect(args).toContain('-I');
      const find = args.indexOf('find'); expect(find).toBeGreaterThan(0);
      const producer = `import os, sys, time
root, dev, mode = sys.argv[1:]
for i in range(30):
    row = [b'f', dev.encode(), str(i + 1).encode(), b'1.0', b'1.0', b'1', str(os.getuid()).encode(), b'1', os.fsencode(root + '/entry-' + str(i))]
    sys.stdout.buffer.write(b'x' if mode == 'noise' else b'\\0'.join(row) + b'\\0')
    sys.stdout.buffer.flush()
    time.sleep(5 if mode == 'stalled' else 0.05)
`;
      const child = spawnProcess(args[2]!, [...args.slice(3, find), '/usr/bin/python3', '-I', '-c', producer, root, String(info.dev), mode],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      child.kill = () => { signalAttempts++; return false; };
      return child;
    }) as CensusSpawn;
    try {
      const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), sudo: '/usr/bin/sudo', spawn,
        includeRecent: true, progressTimeoutMs: mode === 'ceiling' ? 1000 : 200, timeoutMs: mode === 'ceiling' ? 750 : 3000 });
      expect(signalAttempts).toBe(0);
      expect(census.error).toBe('retention native census timed out'); expect(census.entries).toEqual([]);
      expect(census.timing?.timeoutKind).toBe(mode === 'ceiling' ? 'absolute' : 'progress');
      expect(census.timing?.elapsedMs).toBeGreaterThan(0);
      expect(census.timing?.lastProgressAfterMs === null).toBe(mode === 'noise');
      expect(census.timing?.lastChildPath === null).toBe(mode === 'noise');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('resolveCensusSudo', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'census-sudo-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSudo(exitCode: number): string {
    const bin = join(dir, 'sudo');
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = "-n" ] || exit 9\nexit ${exitCode}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it.skipIf(isRoot)('returns the sudo binary when `sudo -n true` succeeds', async () => {
    const bin = stubSudo(0);
    expect(await resolveCensusSudo()).toBe(bin);
  });

  it.skipIf(isRoot)('falls back to an unprivileged walk when sudo needs a password or is refused', async () => {
    // `sudo -n` exits 1 instead of prompting when no NOPASSWD rule applies (or under NoNewPrivileges).
    stubSudo(1);
    expect(await resolveCensusSudo()).toBeNull();
  });

  it.skipIf(isRoot)('does not probe when sudo is not installed', async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveCensusSudo(probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(isRoot)('requires privilege on the actual census even when an unrelated sudo preflight fails', async () => {
    const root = join(dir, 'agent'); await fsp.mkdir(root);
    await fsp.writeFile(join(root, 'payload'), 'measured');
    const bin = join(dir, 'sudo');
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = "-n" ] || exit 9\nshift\n[ "$1" != "true" ] || exit 1\n[ "$1" != "--" ] || shift\nprintf executed > "$0.calls"\nexec "$@"\n');
    chmodSync(bin, 0o755);
    process.env.PATH = [dir, '/usr/bin', '/bin'].join(delimiter);
    expect(await resolveCensusSudo()).toBeNull();
    const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now() + 60_000,
      includeRecent: true, requirePrivilege: true, timeoutMs: 5_000 });
    expect(census.error).toBeUndefined();
    expect(census.entries).toContainEqual(expect.objectContaining({ path: join(root, 'payload') }));
    expect(await fsp.readFile(bin + '.calls', 'utf8')).toBe('executed');
  });

  it.skipIf(isRoot)('preserves actual elevation errors and refuses an unprivileged census', async () => {
    const root = join(dir, 'agent'); await fsp.mkdir(root);
    await fsp.writeFile(join(root, 'payload'), 'retain');
    const bin = join(dir, 'sudo');
    writeFileSync(bin, '#!/bin/sh\nprintf "fixture privilege denied" >&2\nexit 1\n');
    chmodSync(bin, 0o755);
    process.env.PATH = [dir, '/usr/bin', '/bin'].join(delimiter);
    const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now() + 60_000,
      includeRecent: true, requirePrivilege: true, timeoutMs: 5_000 });
    expect(census.error).toContain('fixture privilege denied');
    expect(census.entries).toEqual([]);
    expect(census.inspectedNodes).toBe(0);
  });

  it.skipIf(isRoot)('refuses a required privileged census when sudo is missing', async () => {
    const root = join(dir, 'agent'); await fsp.mkdir(root);
    await fsp.writeFile(join(root, 'payload'), 'retain');
    const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now() + 60_000,
      includeRecent: true, requirePrivilege: true, timeoutMs: 5_000 });
    expect(census.error).toContain('sudo executable unavailable');
    expect(census.entries).toEqual([]);
    expect(census.inspectedNodes).toBe(0);
  });

  it.skipIf(isRoot)('refuses elevation without a native timeout instead of launching an unbounded walk', async () => {
    const root = join(dir, 'agent'); await fsp.mkdir(root);
    stubSudo(0);
    const spawn = vi.fn() as unknown as CensusSpawn;
    const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), requirePrivilege: true, spawn });
    expect(census.error).toBe('timeout executable unavailable for privileged retention census');
    expect(census.entries).toEqual([]); expect(spawn).not.toHaveBeenCalled();
  });

  it('never elevates a process that is already root', async () => {
    stubSudo(0);
    const probe = vi.fn(async () => true);
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      expect(await resolveCensusSudo(probe)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    } finally {
      getuid.mockRestore();
    }
  });
});

describe('measureDocker response deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(fsp, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(request).mockReset();
  });

  // The engine's disk-usage walk can legitimately exceed 20 seconds. Model the
  // HTTP client's timeout and a delayed response independently of the reader.
  function engineWithDiskUsageDelay(delayMs: number): void {
    vi.mocked(request).mockImplementation((options, onResponse) => {
      const opts = options as RequestOptions;
      const req = new EventEmitter();
      let responseTimer: ReturnType<typeof setTimeout>;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      Object.assign(req, {
        end() {
          deadlineTimer = setTimeout(() => req.emit('timeout'), Number(opts.timeout));
          responseTimer = setTimeout(() => {
            clearTimeout(deadlineTimer);
            const res = new EventEmitter();
            Object.assign(res, { statusCode: 200, setEncoding() {} });
            (onResponse as unknown as ((res: IncomingMessage) => void) | undefined)?.(res as IncomingMessage);
            res.emit('data', JSON.stringify(opts.path === '/info'
              ? { DockerRootDir: '/fixture/docker' }
              : {
                  LayersSize: 64,
                  Containers: [{ SizeRw: 2 }, { SizeRw: 3 }],
                  Volumes: [{ UsageData: { Size: 80 } }],
                  BuildCache: [{ Size: 7 }],
                }));
            res.emit('end');
          }, opts.path === '/info' ? 0 : delayMs);
        },
        destroy(error: Error) {
          clearTimeout(responseTimer);
          clearTimeout(deadlineTimer);
          req.emit('error', error);
        },
      });
      return req as ClientRequest;
    });
  }

  it('accepts a valid Docker disk-usage response after the old 20-second diagnostic cutoff', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = measureDocker();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({
      kind: 'docker',
      rootDir: '/fixture/docker',
      parts: [
        { consumer: 'docker:images', bytes: 64 },
        { consumer: 'docker:containers', bytes: 5 },
        { consumer: 'docker:volumes', bytes: 80 },
        { consumer: 'docker:build-cache', bytes: 7 },
      ],
    });
  });

  it('reports an explicit short deadline as a timeout rather than an empty inventory', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = expect(measureDocker(20_000)).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  });

  it('still bounds an unresponsive engine with the maintained default deadline', async () => {
    engineWithDiskUsageDelay(200_000);
    const result = expect(measureDocker()).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(180_000);
    await result;
  });
});
