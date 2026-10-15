import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compilePolicy, type RetentionClass } from './retention-policy';
import { createRetentionHolderScanner, drainScheduledDiskReclaim, nativeRetentionCommand, physicalRetentionRoots, readReclaimReceipt, scanRetentionRootHolders, scanRetentionHolders, selectRetentionEntries, type DiskReclaimReceipt, type ReclaimSql, type RetentionEntry, type RetentionCapReceipt } from './disk-reclaim';

const delegateSpawn = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: delegateSpawn }));

const HOUR = 3_600_000;
const now = 1000 * HOUR;
const policy: RetentionClass[] = [
  { id: 'scratch', title: 'scratch', origin: 'agent', roots: ['/scratch'], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'dumps', title: 'dumps', origin: 'agent', roots: ['/dumps'], keep: { kind: 'newest', keep: 1 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'protected', title: 'protected', origin: 'owner', roots: ['/scratch/owner'], keep: { kind: 'keep', reason: 'owner data' }, enforcers: [{ kind: 'none' }] },
  { id: 'leased', title: 'leased', origin: 'agent', roots: ['/leased'], keep: { kind: 'lease', record: 'live session', graceHours: 1 }, enforcers: [{ kind: 'standing-reclaim', via: 'owning-program' }] },
];
const compiled = compilePolicy(policy, '/home/test');
const entry = (path: string, classId: string, ageHours: number): RetentionEntry => ({ path, root: path.slice(0, path.lastIndexOf('/')), classId, newestWriteMs: now - ageHours * HOUR, bytes: 100, dev: 1, ino: 1 });

describe('per-root allocated-byte caps', () => {
  const capped = () => compilePolicy(policy.map((cls) => cls.id === 'scratch' ? { ...cls, maxBytes: 100 } : cls), '/home/test');
  const sized = (name: string, age: number, bytes: number) => ({ ...entry(`/scratch/${name}`, 'scratch', age), bytes });
  it('counts recent entries and selects the oldest until within the cap', () => {
    const caps: RetentionCapReceipt[] = [];
    const selected = selectRetentionEntries([sized('new', 1, 60), sized('middle', 2, 60), sized('old', 3, 20)], capped(), now, caps);
    expect(selected.map((entry) => entry.path)).toEqual(['/scratch/old', '/scratch/middle']);
    expect(caps).toEqual([expect.objectContaining({ beforeBytes: 140, maxBytes: 100, pinnedBytes: 0 })]);
  });
  it('retains pins, counts their bytes, and reports a pinned-only overage', () => {
    const compiled = capped(); compiled.pins = [{ paths: ['/scratch/pin/child'], expiresAt: new Date(now + HOUR).toISOString() }];
    const caps: RetentionCapReceipt[] = [];
    expect(selectRetentionEntries([sized('pin', 100, 110), sized('new', 1, 30)], compiled, now, caps).map((entry) => entry.path)).toEqual(['/scratch/new']);
    expect(caps[0]).toMatchObject({ beforeBytes: 140, pinnedBytes: 110, pinnedPaths: ['/scratch/pin'], pinnedOverageBytes: 10 });
    compiled.pins[0]!.expiresAt = new Date(now - 1).toISOString();
    expect(selectRetentionEntries([sized('pin', 100, 110), sized('new', 1, 30)], compiled, now).map((entry) => entry.path)).toEqual(['/scratch/pin']);
  });
  it('keeps recent entries at the ceiling and still expires old entries below it', () => {
    expect(selectRetentionEntries([sized('recent', 1, 100)], capped(), now)).toEqual([]);
    expect(selectRetentionEntries([sized('expired', 25, 1)], capped(), now).map((entry) => entry.path)).toEqual(['/scratch/expired']);
  });
  it('counts safety-protected trees without evicting them or protected owner data', () => {
    const caps: RetentionCapReceipt[] = [];
    expect(selectRetentionEntries([{ ...sized('socket-tree', 4, 120), protectedReason: 'special filesystem entry' },
      sized('new', 1, 30), { ...sized('owner/data', 100, 1000), root: '/scratch' }], capped(), now, caps).map((entry) => entry.path)).toEqual(['/scratch/new']);
    expect(caps[0]).toMatchObject({ beforeBytes: 150, pinnedBytes: 0 });
  });
  it('applies caps separately to physical roots of the same class', () => {
    const compiled = compilePolicy([{ ...policy[0]!, roots: ['/a', '/b'], maxBytes: 100 }], '/home/test');
    expect(selectRetentionEntries([ { ...entry('/a/one', 'scratch', 1), bytes: 80 },
      { ...entry('/b/two', 'scratch', 1), bytes: 80 } ], compiled, now)).toEqual([]);
  });
});

describe('exact retention receipt readback', () => {
  const expected: DiskReclaimReceipt = {
    schemaVersion: 1, id: 'readback-receipt', startedAt: new Date(0).toISOString(), finishedAt: new Date(1000).toISOString(),
    dryRun: false, complete: true, policyExhausted: true, devices: [], delegates: [], errors: [],
    entries: ['first', 'second'].map((name) => ({ path: `/scratch/${name}`, classId: 'scratch', status: 'removed' as const, bytes: 1 })),
  };
  const sqlFor = (details: unknown): ReclaimSql => ({ unsafe: vi.fn().mockResolvedValue(details === null ? [] : [{ details }]) } as unknown as ReclaimSql);
  it('accepts reordered object keys without relaxing the receipt values', async () => {
    const reordered = { ...Object.fromEntries(Object.entries(expected).reverse()),
      entries: expected.entries.map((value) => Object.fromEntries(Object.entries(value).reverse())) };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(expected));
    expect(await readReclaimReceipt(sqlFor(reordered), 'workspace', expected.id, expected)).toEqual(expected);
  });
  it.each([
    null,
    { ...expected, complete: false },
    { ...expected, entries: [...expected.entries].reverse() },
    { ...expected, entries: expected.entries.map((value, index) => ({ ...value, bytes: index ? 1 : 2 })) },
  ])('rejects missing or changed readback: %j', async (saved) => {
    await expect(readReclaimReceipt(sqlFor(saved), 'workspace', expected.id, expected)).rejects.toThrow('exact receipt readback mismatch readback-receipt');
  });
});

describe('bounded scheduled retention drain', () => {
  const partial = (overrides: Partial<DiskReclaimReceipt> = {}): DiskReclaimReceipt => ({
    schemaVersion: 1, id: 'batch-receipt', startedAt: new Date(0).toISOString(), finishedAt: new Date(1000).toISOString(),
    dryRun: false, complete: false, policyExhausted: null, devices: [], delegates: [],
    entries: [{ path: '/scratch/old', classId: 'scratch', status: 'removed', bytes: 1 }],
    effects: [{ root: '/scratch', selected: 2, processed: 1, remaining: 1, nextPath: '/scratch/next', elapsedMs: 1000, stopped: true }],
    errors: ['incomplete retention effects:/scratch: effect budget exhausted; resume with a fresh policy census'], ...overrides,
  });
  it('checkpoints productive batches until a fresh pass is complete', async () => {
    const run = vi.fn().mockResolvedValueOnce(partial()).mockResolvedValueOnce(partial({ id: 'done', complete: true, errors: [] }));
    expect(await drainScheduledDiskReclaim(run)).toEqual({ batches: 2, lastReceiptId: 'done', stop: 'complete' });
    expect(run.mock.calls).toEqual([[0, undefined], [1, 900_000]]);
  });
  it.each([
    { errors: ['incomplete process-holder scan:/scratch'] },
    { errors: ['incomplete tree scan: retention scan budget exhausted'] },
    { delegates: [{ classId: 'owner', ok: false, detail: 'failed' }] },
    { entries: [{ path: '/scratch/old', classId: 'scratch', status: 'failed' as const, bytes: 1 }] },
    { effects: [] },
    { finishedAt: 'unknown' },
  ])('stops on a failure instead of repeatedly retrying it: %j', async (overrides) => {
    const run = vi.fn().mockResolvedValue(partial(overrides));
    expect((await drainScheduledDiskReclaim(run)).stop).toBe('error');
    expect(run).toHaveBeenCalledOnce();
  });
  it('stops without a removal, including a dry run', async () => {
    const run = vi.fn().mockResolvedValue(partial({ entries: [] }));
    expect((await drainScheduledDiskReclaim(run)).stop).toBe('no-progress');
    expect(run).toHaveBeenCalledOnce();
    run.mockClear().mockResolvedValue(partial({ dryRun: true }));
    expect((await drainScheduledDiskReclaim(run)).stop).toBe('dry-run');
    expect(run).toHaveBeenCalledOnce();
  });
  it('bounds both batch count and elapsed work and preserves the deadline across replay', async () => {
    const run = vi.fn().mockResolvedValue(partial());
    expect(await drainScheduledDiskReclaim(run, { maxBatches: 2 })).toMatchObject({ batches: 2, stop: 'batch-limit' });
    run.mockClear();
    expect((await drainScheduledDiskReclaim(run, { maxElapsedMs: 1000 })).stop).toBe('time-limit');
    expect(run).toHaveBeenCalledOnce();
    // A replayed receipt still supplies the original deadline to the next step.
    run.mockClear().mockResolvedValueOnce(partial()).mockResolvedValueOnce(null);
    expect(await drainScheduledDiskReclaim(run)).toMatchObject({ batches: 1, stop: 'time-limit' });
    expect(run.mock.calls[1]).toEqual([1, 900_000]);
  });
});

describe('physical retention ownership', () => {
  const inspect = async () => ({ dev: 1, ino: 10, isDirectory: () => true, isSymbolicLink: () => false });
  it('runs one enforcer for bind aliases, and refuses conflicting policies on the same bytes', async () => {
    const roots = [{ path: '/mnt/data/tmp', classId: 'tmp' }, { path: '/tmp', classId: 'tmp' }];
    const errors: string[] = [];
    expect(await physicalRetentionRoots(roots, errors, inspect)).toEqual([
      { path: '/mnt/data/tmp', classId: 'tmp', aliases: ['/mnt/data/tmp', '/tmp'] },
    ]);
    expect(errors).toEqual([]);
    expect(await physicalRetentionRoots([roots[0]!, { path: '/tmp', classId: 'other-policy' }], errors, inspect)).toEqual([]);
    expect(errors).toEqual([expect.stringContaining('conflicting physical retention classes')]);
  });
  it('protects a descriptor or cwd opened through either alias, with incomplete evidence preserved', async () => {
    const scan = vi.fn(async () => ({ complete: false, byPath: new Map([['/tmp/arbitrary/task', ['42']]]) }));
    const result = await scanRetentionRootHolders({ path: '/mnt/data/tmp', aliases: ['/mnt/data/tmp', '/tmp'] }, ['/mnt/data/tmp/arbitrary/task'], scan);
    expect(scan).toHaveBeenCalledWith(['/mnt/data/tmp/arbitrary/task', '/tmp/arbitrary/task']);
    expect(result.complete).toBe(false);
    expect(result.byPath.get('/mnt/data/tmp/arbitrary/task')).toEqual(['42']);
  });
});

describe('scheduled retention selection', () => {
  it('expires only stale entries, oldest first, without a disk-pressure input', () => {
    const selected = selectRetentionEntries([entry('/scratch/new', 'scratch', 1), entry('/scratch/old', 'scratch', 25), entry('/scratch/older', 'scratch', 48)], compiled, now);
    expect(selected.map((e) => e.path)).toEqual(['/scratch/older', '/scratch/old']);
  });
  it('keeps the newest backup per root even when the entire group is old', () => {
    expect(selectRetentionEntries([entry('/dumps/newest', 'dumps', 90), entry('/dumps/old', 'dumps', 100)], compiled, now).map((e) => e.path)).toEqual(['/dumps/old']);
  });
  it('never selects an owner subtree, root, unmatched path or lease from age alone', () => {
    expect(selectRetentionEntries([entry('/scratch/owner/data', 'scratch', 90), entry('/scratch', 'scratch', 90), entry('/other/file', 'scratch', 90), entry('/leased/run', 'leased', 90)], compiled, now)).toEqual([]);
  });
  it('fails closed when the declared class differs from the authoritative selector', () => {
    expect(selectRetentionEntries([entry('/dumps/old', 'scratch', 90)], compiled, now)).toEqual([]);
  });
});

describe('retention holder evidence', () => {
  afterEach(() => { delegateSpawn.mockReset(); });

  it('passes a duration to the existing privileged scanner and requires the caller control', async () => {
    const scan = vi.fn().mockResolvedValue({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['123']]]) });
    const result = await scanRetentionHolders(['/scratch/held'], {
      uid: () => 0, readStatus: async () => `NSpid:\t${process.pid}\n`, scan,
    });
    expect(scan).toHaveBeenCalledWith(['/scratch/held', process.cwd()], {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: 30_000,
    });
    expect(result.complete).toBe(true);
    expect(result.byPath.get('/scratch/held')).toEqual(['123']);
    scan.mockResolvedValueOnce({ complete: true, byPath: new Map() });
    expect((await scanRetentionHolders([], { uid: () => 0, readStatus: async () => 'NSpid:\t1\n', scan })).complete).toBe(false);
  });

  it('uses host-readable evidence for an ordinary operator while preserving live holders', async () => {
    const privileged = vi.fn().mockResolvedValue({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['999']]]) });
    const scan = vi.fn();
    const result = await scanRetentionHolders(['/scratch/held'], {
      uid: () => 1000, readStatus: async () => 'NSpid:\t1\n', scan, privileged,
    });
    expect(scan).not.toHaveBeenCalled();
    expect(privileged).toHaveBeenCalledWith(['/scratch/held', process.cwd()], process.cwd());
    expect(result).toEqual({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['999']]]) });
  });

  it('preserves full JSON stdout separately from scope diagnostics and refuses truncated evidence', async () => {
    const holderPids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    const byPath = [[process.cwd(), [String(process.pid)]], ['/scratch', holderPids]];
    const deps = { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' };
    const launch = (output: string) => delegateSpawn.mockImplementationOnce(async (_command, _args, spec, options) => {
      expect(spec.runtimeMaxSec).toBe(31);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      options.onSpawn(child as unknown as ChildProcess, 'holder-read-task');
      child.stderr.write('Running as unit: holder-read-task.scope\n');
      child.stdout.write(output); child.emit('close', 0, null);
      return { child, taskId: 'holder-read-task' };
    });
    launch(JSON.stringify({ complete: true, byPath }));
    const result = await scanRetentionHolders(['/scratch'], deps);
    expect(result.complete).toBe(true);
    expect(result.byPath.get('/scratch')).toEqual(holderPids);
    launch(' '.repeat(1024 * 1024) + JSON.stringify({ complete: true, byPath }));
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
  });

  it('refuses missing privilege, partial evidence and nested PID namespaces', async () => {
    const privileged = vi.fn().mockRejectedValue(new Error('sudo denied'));
    const deps = { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n', privileged };
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
    privileged.mockResolvedValueOnce({ complete: false, byPath: new Map([[process.cwd(), [String(process.pid)]]]) });
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
    privileged.mockClear();
    expect((await scanRetentionHolders(['/scratch'], { ...deps, readStatus: async () => 'NSpid:\t1\t2\n' })).complete).toBe(false);
    expect(privileged).not.toHaveBeenCalled();
  });

  it('retains scanner failure metrics across the privileged transport', async () => {
    const diagnostics = { elapsedMs: 12, processesTotal: 10, processesScanned: 9, descriptorsScanned: 40,
      deadlineExceeded: false, readFailures: 1, failureSamples: [{ operation: 'fd-directory', path: '/proc/5/fd', code: 'EACCES' }] };
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'incomplete-holder-task');
      child.stdout.write(JSON.stringify({ complete: false, byPath: [[process.cwd(), [String(process.pid)]]], diagnostics }));
      child.emit('close', 0, null); return { child, taskId: 'incomplete-holder-task' };
    });
    const result = await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual(diagnostics);
  });

  it('retains bounded stderr, task identity and signal when privilege transport fails', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'denied-holder-task');
      child.stderr.write('x'.repeat(5000) + 'sudo: permission denied');
      child.emit('close', null, 'SIGTERM'); return { child, taskId: 'denied-holder-task' };
    });
    const result = await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toMatchObject({ taskId: 'denied-holder-task', exitCode: null, signal: 'SIGTERM', outputTruncated: false });
    expect(result.diagnostics?.stderr).toHaveLength(4000);
    expect(result.diagnostics?.stderr).toContain('sudo: permission denied');
  });

  it.each(['not-json', JSON.stringify({ complete: true, byPath: [] }), JSON.stringify({ complete: true, byPath: [['/foreign', ['1']]] })])(
    'rejects privileged output without valid, caller-controlled evidence: %s', async (output) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
        expect(command).toBe('/usr/bin/sudo');
        expect(args.slice(0, 2)).toEqual(['-n', process.execPath]);
        options.onSpawn(child as unknown as ChildProcess, 'holder-read-task');
        child.stdout.write(output); child.emit('close', 0, null);
        return { child, taskId: 'holder-read-task' };
      });
      expect((await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' })).complete).toBe(false);
    },
  );

  it('streams oversized candidate sets without placing the payload in argv', async () => {
    const paths = Array.from({ length: 14_000 }, (_, i) => `/scratch/expired-${i}`);
    const chunks: Buffer[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
      expect(command).toBe('/usr/bin/sudo');
      expect(args.every((arg: string) => Buffer.byteLength(arg) < 128 * 1024)).toBe(true);
      expect(options.spawnOptions.stdio[0]).toBe('pipe');
      options.onSpawn(child as unknown as ChildProcess, 'large-holder-task');
      child.stdout.write(JSON.stringify({ complete: true, byPath: [[process.cwd(), [String(process.pid)]]] }));
      child.emit('close', 0, null);
      return { child, taskId: 'large-holder-task' };
    });
    const result = await scanRetentionHolders(paths, { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(true);
    const input = Buffer.concat(chunks).toString('utf8');
    expect(Buffer.byteLength(input)).toBeGreaterThan(128 * 1024);
    expect(JSON.parse(input)).toEqual([...paths, process.cwd()]);
  });
});

describe('per-pass kernel holder transport', () => {
  const target = fileURLToPath(import.meta.url);
  const evidence = (path: string, pids: string[] = [], patch = {}) => ({ complete: true,
    byPath: pids.length ? [[path, pids]] : [], diagnostics: { fdEnd: 1, cwdEnd: 1, readFailures: 0,
      identityStable: true, callerSeen: 1, descriptorsScanned: 50, processesScanned: 10, elapsedMs: 2, ...patch } });
  const fixture = (respond: (request: { path: string; caller: number; control: string }, child: ChildProcess) => void) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.exitCode = 1; child.emit('close', 1, 'SIGKILL'); return true; });
    child.stdin.on('data', (data: Buffer) => respond(JSON.parse(data.toString()), child as unknown as ChildProcess));
    child.stdin.once('finish', () => { child.exitCode = 0; child.emit('close', 0, null); });
    delegateSpawn.mockImplementationOnce(async (_command, _args, spec, options) => {
      expect(spec.detail.operation).toBe('retention-holder-scan');
      expect(options.requireRegistration).toBe(true);
      options.onSpawn(child as unknown as ChildProcess, 'persistent-holder-task');
      return { child, taskId: 'persistent-holder-task' };
    });
    return child;
  };
  afterEach(() => { vi.useRealTimers(); delegateSpawn.mockReset(); });

  it('serializes requests through one child and never reuses absence across open/close changes', async () => {
    const requests: unknown[] = [];
    const child = fixture((request, spawned) => {
      requests.push(request);
      spawned.stdout!.emit('data', JSON.stringify(evidence(request.path, requests.length === 2 ? ['123'] : [])) + '\n');
    });
    const fallback = vi.fn(); const scanner = createRetentionHolderScanner({ fallback });
    try {
      const results = await Promise.all([scanner.scan([target]), scanner.scan([target]), scanner.scan([target])]);
      expect(results.every((result) => result.complete)).toBe(true);
      expect(results.map((result) => result.byPath.get(target))).toEqual([undefined, ['123'], undefined]);
      expect(requests).toEqual(Array(3).fill({ path: target, caller: process.pid, control: process.cwd() }));
      expect(delegateSpawn).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    } finally { await scanner.close(); }
    expect(child.stdin.writableEnded).toBe(true);
    expect((await scanner.scan([target])).complete).toBe(false);
  });

  it.each([{ fdEnd: 0 }, { cwdEnd: 0 }, { callerSeen: 0 }, { readFailures: 1 }, { identityStable: false }])(
    'falls back to a new full proc scan when kernel evidence is incomplete (%j)', async (patch) => {
      fixture((request, child) => child.stdout!.emit('data', JSON.stringify(evidence(request.path, [], patch)) + '\n'));
      const fallback = vi.fn(async () => ({ complete: false, byPath: new Map<string, string[]>(), diagnostics: { reason: 'proc denied' } }));
      const scanner = createRetentionHolderScanner({ fallback });
      try {
        const result = await scanner.scan([target]); expect(result.complete).toBe(false);
        expect(result.diagnostics?.reason).toContain('proc denied'); expect(fallback).toHaveBeenCalledWith([target]);
      } finally { await scanner.close(); }
    },
  );

  it('fails closed on a lost child and accepts only the fallback caller-controlled result', async () => {
    fixture((_request, child) => child.emit('close', 1, null));
    const fallback = vi.fn(async () => ({ complete: true, byPath: new Map([[target, ['456']], [process.cwd(), [String(process.pid)]]]) }));
    const scanner = createRetentionHolderScanner({ fallback });
    try {
      expect((await scanner.scan([target])).byPath.get(target)).toEqual(['456']);
      await scanner.scan([target]); expect(delegateSpawn).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(2);
    } finally { await scanner.close(); }
  });

  it('bounds a silent worker request, then uses the full fresh fallback', async () => {
    let wrote!: () => void; const written = new Promise<void>((resolve) => { wrote = resolve; });
    const child = fixture(() => wrote());
    const fallback = vi.fn(async () => ({ complete: false, byPath: new Map<string, string[]>() }));
    vi.useFakeTimers();
    const scanner = createRetentionHolderScanner({ fallback });
    try {
      const response = scanner.scan([target]); await written;
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await response).complete).toBe(false); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally { await scanner.close(); }
  });
});

describe('native retention completion', () => {
  afterEach(() => { vi.useRealTimers(); delegateSpawn.mockReset(); });

  it.each([0, 2])('preserves output and exit %s before the launch promise resolves', async (code) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'fast-retention-task');
      child.stdout.write('retention receipt');
      child.emit('close', code, null);
      await Promise.resolve();
      return { child, taskId: 'fast-retention-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    await expect(nativeRetentionCommand('/repo', 'true', [])).resolves.toEqual({
      ok: code === 0, detail: { code, signal: null, taskId: 'fast-retention-task', output: 'retention receipt' },
    });
  });

  it('reports a spawn error emitted before launch bookkeeping returns', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'failed-retention-task');
      child.emit('error', new Error('fixture exec denied'));
      return { child, taskId: 'failed-retention-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    await expect(nativeRetentionCommand('/repo', 'false', [])).resolves.toEqual({
      ok: false, detail: { error: 'fixture exec denied', taskId: 'failed-retention-task', output: '' },
    });
  });

  it('times out a running child once and keeps the timeout verdict when kill emits close', async () => {
    vi.useFakeTimers();
    let observed!: () => void;
    const ready = new Promise<void>((resolve) => { observed = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.emit('close', null, 'SIGKILL'); });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'slow-retention-task');
      observed();
      return { child, taskId: 'slow-retention-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    const result = nativeRetentionCommand('/repo', 'sleep', ['300']);
    await ready;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toEqual({
      ok: false, detail: { error: 'delegate timeout', taskId: 'slow-retention-task', output: '' },
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('keeps a successful delegate pending until its terminal evidence is persisted', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'persisting-retention-task');
      child.emit('close', 0, null);
      return { child, taskId: 'persisting-retention-task', waitForCompletion: async () => {
        entered(); await persistence; return { status: 'recorded' };
      } };
    });
    let finished = false;
    const result = nativeRetentionCommand('/repo', 'true', []).then((outcome) => { finished = true; return outcome; });
    await waiting;
    expect(finished).toBe(false);
    release();
    await expect(result).resolves.toMatchObject({ ok: true, detail: { code: 0, taskId: 'persisting-retention-task' } });
  });
});
