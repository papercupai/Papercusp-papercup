import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compilePolicy, type RetentionClass } from './retention-policy';
import { createRetentionHolderScanner, drainScheduledDiskReclaim, nativeRetentionCommand, physicalRetentionRoots, readReclaimReceipt, reclaimRunBudgetForDrain, runScheduledDiskReclaimWithFailureReceipt, scanRetentionRootHolders, scanRetentionHolders, selectRetentionEntries, type DiskReclaimReceipt, type ReclaimSql, type RetentionEntry, type RetentionCapReceipt } from './disk-reclaim';

const delegateSpawn = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: delegateSpawn }));
const delegateKill = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/control', () => ({ killTask: delegateKill }));
const managedTask = (
  child: ChildProcess,
  taskId: string,
  waitForCompletion: () => Promise<{ status: 'recorded' }> = async () => ({ status: 'recorded' }),
) => ({ child, taskId, waitForCompletion });

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
  it('counts the union of hardlinked pins without manufacturing a pinned-only overage', () => {
    const compiled = capped(); compiled.pins = [{ paths: ['/scratch/pin-a', '/scratch/pin-b'], expiresAt: new Date(now + HOUR).toISOString() }];
    const shared = (name: string) => ({ ...sized(name, 2, 64), hardlinks: [{ dev: 1, ino: 200, bytes: 64, paths: [`/scratch/${name}`] }] });
    const caps: RetentionCapReceipt[] = [];
    expect(selectRetentionEntries([shared('pin-a'), shared('pin-b'), sized('new', 1, 60)], compiled, now, caps)
      .map(entry => entry.path)).toEqual(['/scratch/new']);
    expect(caps[0]).toMatchObject({ beforeBytes: 124, pinnedBytes: 64, pinnedOverageBytes: 0 });
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
  it('bounds each scheduled pass to the remaining drain window', () => {
    expect(reclaimRunBudgetForDrain(undefined, 1000)).toBeUndefined();
    expect(reclaimRunBudgetForDrain(901_000, 1000)).toBe(900_000);
    expect(reclaimRunBudgetForDrain(2_000_000, 1000)).toBe(900_000);
    expect(reclaimRunBudgetForDrain(1000, 1001)).toBe(1);
  });

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
  const cappedPartial = (): DiskReclaimReceipt => partial({
    caps: [{ root: '/scratch', classId: 'scratch', maxBytes: 10, beforeBytes: 12,
      pinnedBytes: 0, pinnedPaths: [], afterBytes: 11, overByBytes: 1, pinnedOverageBytes: 0 }],
    errors: [...partial().errors, 'size cap remains exceeded:/scratch:1'],
  });
  it('resumes a productive capped root whose exact overage accompanies its effect-budget stop', async () => {
    const run = vi.fn().mockResolvedValueOnce(cappedPartial())
      .mockResolvedValueOnce(partial({ id: 'done', complete: true, errors: [] }));
    expect(await drainScheduledDiskReclaim(run)).toEqual({ batches: 2, lastReceiptId: 'done', stop: 'complete' });
    expect(run.mock.calls).toEqual([[0, undefined], [1, 900_000]]);
  });
  it.each(['missing-cap', 'different-root', 'different-overage', 'no-budget-stop', 'pinned-only'])(
    'refuses a cap error without matching resumable evidence: %s', async (mismatch) => {
      const receipt = cappedPartial();
      if (mismatch === 'missing-cap') receipt.caps = [];
      if (mismatch === 'different-root') receipt.caps![0]!.root = '/other';
      if (mismatch === 'different-overage') receipt.caps![0]!.overByBytes = 2;
      if (mismatch === 'no-budget-stop') receipt.effects![0]!.stopped = false;
      if (mismatch === 'pinned-only') receipt.caps![0]!.pinnedOverageBytes = 1;
      const run = vi.fn().mockResolvedValue(receipt);
      expect((await drainScheduledDiskReclaim(run)).stop).toBe('error');
      expect(run).toHaveBeenCalledOnce();
    },
  );
  it('keeps capped continuation bounded and refuses a batch that made no removal', async () => {
    const run = vi.fn().mockResolvedValue(cappedPartial());
    expect((await drainScheduledDiskReclaim(run, { maxElapsedMs: 1000 })).stop).toBe('time-limit');
    expect(run).toHaveBeenCalledOnce();
    run.mockClear().mockResolvedValue({ ...cappedPartial(), entries: [] });
    expect((await drainScheduledDiskReclaim(run)).stop).toBe('no-progress');
    expect(run).toHaveBeenCalledOnce();
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

  it('isolates release holder scans even for a root host and requests every process link', async () => {
    const scan = vi.fn();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
      expect(command).toBe('/usr/bin/sudo');
      expect(args.join(' ')).toContain('includeProcessLinks: true');
      expect(args.join(' ')).toContain('readdirSync');
      options.onSpawn(child as unknown as ChildProcess, 'release-holder-task');
      child.stdout.write(JSON.stringify({ complete: true, byPath: [[process.cwd(), [String(process.pid)]], ['/cut', ['999']]] }));
      child.emit('close', 0, null); return { child, taskId: 'release-holder-task' };
    });
    const result = await scanRetentionHolders(['/cut'], {
      uid: () => 0, readStatus: async () => 'NSpid:\t1\n', scan, isolate: true, includeProcessLinks: true,
    });
    expect(scan).not.toHaveBeenCalled();
    expect(result.complete).toBe(true);
    expect(result.byPath.get('/cut')).toEqual(['999']);
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

  it('resolves privileged scanner source independently of the caller working directory', async () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
    const control = '/unrelated-holder-caller';
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(control);
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', undefined);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
      expect(command).toBe('/usr/bin/sudo');
      expect(options.spawnOptions.cwd).toBe(repoRoot);
      expect(args.at(-1)).toBe(`${repoRoot}/packages/operator-core/lib/native-bg-task-ledger.ts`);
      options.onSpawn(child as unknown as ChildProcess, 'source-root-holder-task');
      child.stdout.write(JSON.stringify({ complete: true, byPath: [[control, [String(process.pid)]]] }));
      child.emit('close', 0, null);
      return { child, taskId: 'source-root-holder-task' };
    });
    try {
      expect((await scanRetentionHolders(['/scratch'], {
        uid: () => 1000, readStatus: async () => 'NSpid:\t1\n',
      })).complete).toBe(true);
      expect(delegateSpawn).toHaveBeenCalledTimes(1);
    } finally { cwd.mockRestore(); vi.unstubAllEnvs(); }
  });
});

describe('per-pass kernel holder transport', () => {
  const target = fileURLToPath(import.meta.url);
  const evidence = (path: string, pids: string[] = [], patch = {}) => ({ complete: true,
    byPath: pids.length ? [[path, pids]] : [], diagnostics: { fdEnd: 1, cwdEnd: 1, readFailures: 0,
      identityStable: true, callerSeen: 1, descriptorsScanned: 50, processesScanned: 10, elapsedMs: 2, ...patch } });
  const fixture = (
    respond: (request: { path: string; caller: number; control: string; operation?: string; [key: string]: unknown }, child: ChildProcess) => void,
    fixtureOptions: { closeOnEof?: boolean; onStarted?: () => void; waitForCompletion?: () => Promise<{ status: 'recorded' }> } = {},
  ) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.exitCode = 1; child.emit('close', 1, 'SIGKILL'); return true; });
    child.stdin.on('data', (data: Buffer) => respond(JSON.parse(data.toString()), child as unknown as ChildProcess));
    if (fixtureOptions.closeOnEof !== false) child.stdin.once('finish', () => { child.exitCode = 0; child.emit('close', 0, null); });
    delegateSpawn.mockImplementationOnce(async (_command, _args, spec, options) => {
      expect(spec.detail.operation).toBe('retention-holder-scan');
      expect(options.requireRegistration).toBe(true);
      options.onSpawn(child as unknown as ChildProcess, 'persistent-holder-task');
      fixtureOptions.onStarted?.();
      return managedTask(child as unknown as ChildProcess, 'persistent-holder-task', fixtureOptions.waitForCompletion);
    });
    return child;
  };
  afterEach(() => { vi.useRealTimers(); delegateSpawn.mockReset(); delegateKill.mockReset(); });

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

  it('holds a regular-file lease through the persistent worker and releases its token', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fixture((request, spawned) => {
      requests.push(request);
      if (request.operation === 'lease-acquire') {
        spawned.stdout!.emit('data', JSON.stringify({ complete: true,
          lease: { token: '0123456789abcdef0123456789abcdef', type: 'write' },
          diagnostics: { backend: 'fcntl-file-lease', identityStable: true } }) + '\n');
      } else if (request.operation === 'lease-release') {
        spawned.stdout!.emit('data', JSON.stringify({ complete: true, released: true,
          diagnostics: { backend: 'fcntl-file-lease', breakRequested: false } }) + '\n');
      } else {
        spawned.stdout!.emit('data', JSON.stringify(evidence(request.path)) + '\n');
      }
    });
    const scanner = createRetentionHolderScanner();
    const candidate: RetentionEntry = { path: target, root: '/tmp', classId: 'scratch', newestWriteMs: 1,
      bytes: 1, dev: 1, ino: 2, uid: 1000, gid: 1000 };
    try {
      const lease = await scanner.acquireRegularFileLease(candidate, 1_000);
      expect(requests[0]).toMatchObject({ operation: 'lease-acquire', path: target, dev: 1, ino: 2, uid: 1000, gid: 1000 });
      expect((await scanner.scan([target])).complete).toBe(false);
      await lease.release();
      expect(requests[1]).toEqual({ operation: 'lease-release', token: '0123456789abcdef0123456789abcdef' });
    } finally { await scanner.close(); }
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
    delegateKill.mockImplementationOnce(async (id) => {
      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
      return { ok: true, taskId: id, action: 'kill' };
    });
    vi.useFakeTimers();
    const scanner = createRetentionHolderScanner({ fallback });
    try {
      const response = scanner.scan([target]); await written;
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await response).complete).toBe(false);
      expect(delegateKill).toHaveBeenCalledExactlyOnceWith('persistent-holder-task', {
        signal: 'SIGKILL', reapTerminalResidue: true,
      });
      expect(child.kill).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
    } finally { await scanner.close(); }
  });

  it('closes the worker on EOF and waits for its terminal ledger completion', async () => {
    let markCompletionEntered!: () => void, release!: () => void;
    const completionEntered = new Promise<void>((resolve) => { markCompletionEntered = resolve; });
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    const waitForCompletion = vi.fn(async () => {
      markCompletionEntered();
      await persistence;
      return { status: 'recorded' as const };
    });
    const child = fixture((request, spawned) => {
      spawned.stdout!.emit('data', JSON.stringify(evidence(request.path)) + '\n');
    }, { waitForCompletion });
    const scanner = createRetentionHolderScanner();
    try {
      expect((await scanner.scan([target])).complete).toBe(true);
      let finished = false;
      const closing = scanner.close().then(() => { finished = true; });
      await completionEntered;
      expect(finished).toBe(false);
      expect(child.stdin.writableEnded).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      expect(delegateKill).not.toHaveBeenCalled();
      release();
      await closing;
      expect(waitForCompletion).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await scanner.close().catch(() => {});
    }
  });

  it('uses task-level cleanup for an unresponsive worker and bounds ledger completion', async () => {
    vi.useFakeTimers();
    let markStarted!: () => void, markCompletionEntered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const completionEntered = new Promise<void>((resolve) => { markCompletionEntered = resolve; });
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const waitForCompletion = vi.fn(async () => {
      markCompletionEntered();
      await completion;
      return { status: 'recorded' as const };
    });
    const child = fixture(() => {}, { closeOnEof: false, onStarted: markStarted, waitForCompletion });
    delegateKill.mockImplementationOnce(async (id) => {
      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
      return { ok: true, taskId: id, action: 'kill' };
    });
    const fallback = vi.fn(async () => ({
      complete: false, byPath: new Map<string, string[]>(), diagnostics: { reason: 'scanner closed' },
    }));
    const scanner = createRetentionHolderScanner({ fallback });
    const scan = scanner.scan([target]);
    try {
      await started;
      const closing = scanner.close();
      const closeOutcome = closing.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await completionEntered;
      expect(delegateKill).toHaveBeenCalledExactlyOnceWith('persistent-holder-task', {
        signal: 'SIGKILL', reapTerminalResidue: true,
      });
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      const outcome = await closeOutcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
        .toBe('retention holder ledger completion deadline');
      await expect(scan).resolves.toMatchObject({ complete: false });
      expect(waitForCompletion).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await scanner.close().catch(() => {});
    }
  });
});

describe('native retention completion', () => {
  afterEach(() => { vi.useRealTimers(); delegateSpawn.mockReset(); delegateKill.mockReset(); });

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

  it('awaits scoped timeout cleanup and keeps the timeout verdict when termination emits close', async () => {
    vi.useFakeTimers();
    let observed!: () => void;
    const ready = new Promise<void>((resolve) => { observed = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    delegateKill.mockImplementationOnce(async () => {
      child.emit('close', null, 'SIGKILL');
      await cleanup;
      return { ok: true, taskId: 'slow-retention-task', action: 'kill' };
    });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'slow-retention-task');
      observed();
      return { child, taskId: 'slow-retention-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    let finished = false;
    const result = nativeRetentionCommand('/repo', 'sleep', ['300']).then((value) => { finished = true; return value; });
    await ready;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delegateKill).toHaveBeenCalledExactlyOnceWith('slow-retention-task', { signal: 'SIGKILL', reapTerminalResidue: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    release();
    await expect(result).resolves.toEqual({
      ok: false, detail: { error: 'delegate timeout', taskId: 'slow-retention-task', output: '' },
    });
  });

  it('reports failed scope cleanup rather than claiming the timed out payload was reaped', async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    const completion = vi.fn(async () => ({ status: 'delegated' }));
    const observeTiming = vi.fn();
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'residual-task'); ready();
      return { child, taskId: 'residual-task', waitForCompletion: completion };
    });
    delegateKill.mockResolvedValueOnce({ ok: false, taskId: 'residual-task', action: 'kill', error: 'incomplete', detail: 'scope still populated' });
    const result = nativeRetentionCommand('/repo', 'sleep', ['300'], { timeoutMs: 50, observeTiming });
    await started; await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toMatchObject({ ok: false, detail: {
      error: 'delegate timeout', cleanup: { ok: false, error: 'incomplete', detail: 'scope still populated' },
    } });
    expect(completion).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(observeTiming).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      timeoutMs: 50, settledBy: 'timeout', settledAfterMs: 50,
      cleanupStartedAfterMs: 50, cleanupFinishedAfterMs: 50,
      cleanupResult: { ok: false, error: 'incomplete' }, completedAfterMs: null,
    }));
  });

  it('records timeout settlement separately from a later zero exit and delayed cleanup', async () => {
    vi.useFakeTimers();
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    const observeTiming = vi.fn();
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'late-zero-exit-task'); ready();
      return { child, taskId: 'late-zero-exit-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    delegateKill.mockImplementationOnce(async () => {
      await cleanup;
      return { ok: true, taskId: 'late-zero-exit-task', action: 'kill' };
    });
    const result = nativeRetentionCommand('/repo', 'fixture-worker', [], { timeoutMs: 50, observeTiming });
    await started; await vi.advanceTimersByTimeAsync(50);
    expect(observeTiming).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25); child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(10); release();
    await expect(result).resolves.toMatchObject({ ok: false, detail: { error: 'delegate timeout' } });
    expect(observeTiming).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId: 'late-zero-exit-task', timeoutMs: 50,
      settledBy: 'timeout', settledAfterMs: 50, childClosedAfterMs: 75,
      cleanupStartedAfterMs: 50, cleanupFinishedAfterMs: 85, cleanupResult: { ok: true },
      completedAfterMs: 85, totalMs: 85,
    }));
  });

  it('retains bounded worker phase stderr on a timeout without contaminating JSON stdout', async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'worker-progress-task');
      child.stdout.write('{"removed":');
      child.stderr.write('x'.repeat(5000));
      child.stderr.write('\nRETENTION_WORKER {"phase":"source-scan","nodes":1024}\n');
      ready();
      return { child, taskId: 'worker-progress-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    delegateKill.mockResolvedValueOnce({ ok: true, taskId: 'worker-progress-task', action: 'kill' });
    const result = nativeRetentionCommand('/repo', 'fixture-worker', [], { stdoutOnly: true, timeoutMs: 50 });
    await started; await vi.advanceTimersByTimeAsync(50);
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, detail: { error: 'delegate timeout',
      output: '{"removed":', stderr: expect.stringContaining('RETENTION_WORKER {"phase":"source-scan","nodes":1024}') } });
    expect((outcome.detail as { stderr: string }).stderr).toHaveLength(4000);
    expect(delegateKill).toHaveBeenCalledExactlyOnceWith('worker-progress-task', { signal: 'SIGKILL', reapTerminalResidue: true });
  });

  it('uses scoped cleanup when the enrolled input pipe is unavailable', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'missing-input-task');
      return { child, taskId: 'missing-input-task', waitForCompletion: async () => ({ status: 'recorded' }) };
    });
    delegateKill.mockResolvedValueOnce({ ok: true, taskId: 'missing-input-task', action: 'kill' });
    await expect(nativeRetentionCommand('/repo', 'cat', [], { stdin: 'payload' })).resolves.toMatchObject({
      ok: false, detail: { error: 'delegate input pipe unavailable' },
    });
    expect(delegateKill).toHaveBeenCalledExactlyOnceWith('missing-input-task', { signal: 'SIGKILL', reapTerminalResidue: true });
    expect(child.kill).not.toHaveBeenCalled();
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

  it('distinguishes child exit before launch bookkeeping from terminal settlement in receipt timing', async () => {
    let clock = 1000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    const observeTiming = vi.fn();
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      clock += 5; options.stage('spawn-register-task');
      clock += 10; options.onSpawn(child as unknown as ChildProcess, 'timed-retention-task');
      clock += 7; child.emit('close', 0, null);
      clock += 20; options.stage('spawn-mark-running');
      return { child, taskId: 'timed-retention-task', waitForCompletion: async () => {
        entered(); await persistence; clock += 300; return { status: 'recorded' };
      } };
    });
    try {
      const result = nativeRetentionCommand('/repo', 'true', [], { observeTiming });
      await waiting;
      expect(observeTiming).not.toHaveBeenCalled();
      release(); await expect(result).resolves.toMatchObject({ ok: true });
      expect(observeTiming).toHaveBeenCalledExactlyOnceWith({
        taskId: 'timed-retention-task', totalMs: 342, timeoutMs: 120_000, spawnedAfterMs: 15,
        childClosedAfterMs: 22, launchReturnedAfterMs: 42, completedAfterMs: 342,
        settledBy: 'close', settledAfterMs: 22,
        cleanupStartedAfterMs: null, cleanupFinishedAfterMs: null, cleanupResult: null,
        stages: [{ name: 'spawn-register-task', elapsedMs: 5 }, { name: 'spawn-mark-running', elapsedMs: 42 }],
      });
    } finally { release(); now.mockRestore(); }
  });
});

describe('scheduled reclaim failure receipts', () => {
  const startedAt = '2026-10-22T22:00:00.000Z';

  it('persists an incomplete fallback receipt before returning it', async () => {
    const run = vi.fn().mockRejectedValue(new Error('finalizePendingYield is not defined'));
    const persisted: DiskReclaimReceipt[] = [];
    const persistFailureReceipt = vi.fn(async (receipt: DiskReclaimReceipt) => { persisted.push(receipt); });
    const finishedAt = new Date('2026-10-22T22:01:00.000Z');

    const receipt = await runScheduledDiskReclaimWithFailureReceipt(run, startedAt, {
      persistFailureReceipt,
      now: () => finishedAt,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      startedAt,
      finishedAt: finishedAt.toISOString(),
      dryRun: false,
      complete: false,
      policyExhausted: null,
      devices: [],
      entries: [],
      delegates: [],
      errors: ['finalizePendingYield is not defined'],
    });
    expect(persistFailureReceipt).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(persisted).toEqual([receipt]);
  });

  it('does not return a successful fallback when audit persistence fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('scheduled reclaim failed'));
    const persistFailureReceipt = vi.fn().mockRejectedValue(new Error('audit unavailable'));

    await expect(runScheduledDiskReclaimWithFailureReceipt(run, startedAt, {
      persistFailureReceipt,
    })).rejects.toThrow('audit unavailable');

    expect(run).toHaveBeenCalledOnce();
    expect(persistFailureReceipt).toHaveBeenCalledOnce();
  });

  it('leaves successful pass receipts to the scheduled runner', async () => {
    const receipt: DiskReclaimReceipt = {
      schemaVersion: 1, id: 'scheduled-success', startedAt, finishedAt: startedAt, dryRun: false,
      complete: true, policyExhausted: true, devices: [], entries: [], delegates: [], errors: [],
    };
    const run = vi.fn().mockResolvedValue(receipt);
    const persistFailureReceipt = vi.fn();

    await expect(runScheduledDiskReclaimWithFailureReceipt(run, startedAt, {
      persistFailureReceipt,
    })).resolves.toBe(receipt);

    expect(persistFailureReceipt).not.toHaveBeenCalled();
  });
});
