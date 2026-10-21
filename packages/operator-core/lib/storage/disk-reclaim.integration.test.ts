import { mkdtemp, mkdir, writeFile, utimes, symlink, stat, rm, chmod, copyFile, open, link } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { readDiskAlarmContext, runDiskSpaceAlarmOnce } from './disk-space-alarm';
import { writeCensusRun } from './disk-consumer-census';
import type { AttentionNotifyInput } from '../attention-notify';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { drainScheduledDiskReclaim, nativeRetentionCommand, readReclaimReceipt, removePrivilegedRetentionEntry, runDiskReclaimOnce, writeReclaimAudit, type DiskReclaimReceipt, type NativeRetentionTiming, type ReclaimSql, type RetentionEntry } from './disk-reclaim';
import { CACHEDIR_TAG_SIGNATURE, type RetentionClass } from './retention-policy';
import { inspectRetentionTrees } from './disk-consumer-census';
import { readDiskHeadroomSoakEvidence } from './retention-interval-evidence';
import { scanProcHolders } from '../release-cut-reclaim';
import { readOpenWorkItemEvidenceReferences, readRetentionPins, renewWorkItemEvidencePins } from './retention-pins';
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

const managedProbe = vi.hoisted(() => ({ active: false }));
vi.mock('../task-manager/managed-spawn', async (original) => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: (...args: Parameters<typeof actual.managedSpawn>) => {
    if (!managedProbe.active) return actual.managedSpawn(...args);
    const [command, argv, spec, opts] = args;
    return actual.managedSpawn(command, argv, spec, { ...opts, onSpawn: (child, taskId) => {
      opts?.onSpawn?.(child, taskId);
      console.info('NATIVE_RETENTION_SPAWN', JSON.stringify({ command, taskId, pid: child.pid }));
      const timer = setTimeout(async () => {
        const processes: unknown[] = [];
        const inspect = async (pid: number, depth: number): Promise<void> => {
          try {
            const base = `/proc/${pid}`;
            const [name, wait, children, status, input, cgroup] = await Promise.all([
              readFile(`${base}/comm`, 'utf8'), readFile(`${base}/wchan`, 'utf8'),
              readFile(`${base}/task/${pid}/children`, 'utf8'),
              readFile(`${base}/status`, 'utf8'),
              readlink(`${base}/fd/0`).catch(error => `unavailable:${error.code}`),
              readFile(`${base}/cgroup`, 'utf8'),
            ]);
            // wchan can be zero for an elevated child we cannot ptrace. State
            // and signal masks distinguish a stopped child from that unknown.
            processes.push({ pid, name: name.trim(), wait: wait.trim(), input,
              cgroup: cgroup.trim(), status: status.split('\n').filter(line =>
                /^(State|PPid|TracerPid|Uid|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/.test(line)) });
            if (depth < 3) for (const next of children.trim().split(/\s+/).filter(Boolean).slice(0, 4)) await inspect(Number(next), depth + 1);
          } catch (error) { processes.push({ pid, unavailable: String(error) }); }
        };
        if (child.pid) await inspect(child.pid, 0);
        console.info('NATIVE_RETENTION_CHILD_STATE', JSON.stringify({ taskId, processes,
          stdinFinished: child.stdin?.writableFinished, stdinDestroyed: child.stdin?.destroyed }));
        if (command === '/usr/bin/sudo' && child.pid) {
          // Elevated children hide their wait channel from this UID. Read only
          // the freshly observed task's scope; never inspect a recycled PID.
          const probe = `
import json, pathlib, sys
pending = [(sys.argv[1], 0)]
observations = []
while pending and len(observations) < 8:
    pid, depth = pending.pop(0)
    p = pathlib.Path('/proc') / pid
    try:
        scope = (p / 'cgroup').read_text().strip().rsplit('/', 1)[-1]
        if scope != 'pc-' + sys.argv[2] + '.scope':
            observations.append({'pid': pid, 'scopeMismatch': True})
            continue
        stack = (p / 'stack').read_text().splitlines()
        observations.append({'pid': pid, 'name': (p / 'comm').read_text().strip(),
            'wait': (p / 'wchan').read_text().strip(),
            'stackFunctions': [s.split('] ', 1)[-1].split('+', 1)[0] for s in stack][:12],
            'syscallNumber': (p / 'syscall').read_text().split()[0]})
        if depth < 3:
            children = (p / 'task' / pid / 'children').read_text().split()[:4]
            pending.extend((child, depth + 1) for child in children)
    except (OSError, IndexError) as error:
        observations.append({'pid': pid, 'unavailable': type(error).__name__})
print(json.dumps(observations))
`;
          execFile('/usr/bin/sudo', ['-n', '/usr/bin/timeout', '--signal=KILL', '5s',
            '/usr/bin/python3', '-I', '-c', probe, String(child.pid), taskId],
          { encoding: 'utf8', timeout: 7_000, maxBuffer: 8192 }, (error, stdout) => {
            console.info('NATIVE_RETENTION_KERNEL_WAIT', JSON.stringify({ taskId,
              error: error?.message, observation: stdout.trim() }));
          });
        }
      }, 1_000);
      child.once('close', () => clearTimeout(timer));
    } });
  } };
});

const fixtureMutex = vi.hoisted(() => ({
  name: `disk-retention-fixture-${crypto.randomUUID()}`,
  requested: [] as string[],
  onRequest: undefined as (() => void) | undefined,
  observe: undefined as ((phase: string, details?: unknown) => void) | undefined,
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
      const name = args[0] === 'papercusp-disk-retention' ? fixtureMutex.name : args[0];
      const observe = args[0] === 'papercusp-disk-retention' ? fixtureMutex.observe : undefined;
      if (!observe) return actual.withFsMutex(name, args[1], args[2]);
      observe('mutex-request', { timeoutMs: args[2]?.timeoutMs });
      return actual.withFsMutex(name, async held => {
        observe('mutex-callback');
        return args[1](held);
      }, { ...args[2],
        waitingNoticeIntervalMs: args[2]?.waitingNoticeIntervalMs ?? 1,
        onWaiting: info => { observe('mutex-waiting', info); args[2]?.onWaiting?.(info); },
        onAcquired: info => { observe('mutex-acquired', info); args[2]?.onAcquired?.(info); },
      });
    },
  };
});

let fixture: string | undefined;
afterEach(async () => { fixtureMutex.onRequest = undefined; fixtureMutex.observe = undefined; inspectionProbe.before = undefined; if (fixture) await rm(fixture, { recursive: true, force: true }); fixture = undefined; });

async function setup() {
  fixture = await mkdtemp(join(tmpdir(), 'disk-retention-'));
  const root = join(fixture, 'scratch'); await mkdir(root);
  const policy: RetentionClass[] = [{ id: 'fixture', title: 'fixture', origin: 'agent', roots: [root], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] }];
  // Synthetic now also ages ctime; real stale trees must have both mtime AND ctime old.
  const nowMs = Date.now() + 48 * 3_600_000;
  const options = { policy, roots: [{ path: root, classId: 'fixture' }], nowMs, registeredWorkspaces: () => [], expectedDevices: [], sample: async () => [], scanHolders: async () => ({ complete: true, byPath: new Map<string, string[]>() }) };
  return { root, options };
}

const fixtureBuildRemover = (entry: RetentionEntry, ms: number, _observe?: (timing: NativeRetentionTiming) => void, dryRun?: boolean) =>
  removePrivilegedRetentionEntry(entry, ms, async (_repo, command, args, opts) => ({ ok: true,
    // The fixture is owned by this process. Execute the identical fd worker
    // without elevation; the dedicated root-owned fixture covers sudo.
    detail: { output: execFileSync(args[1]!, args.slice(2), { input: opts?.stdin, timeout: 10_000, encoding: 'utf8' }) },
  }), undefined, dryRun);

describe('retention on a real fixture tree', () => {
  it('retains old evidence bound to an open acceptance item and reclaims it after terminal lease expiry', async () => {
    const { root, options } = await setup();
    const db = await createFreshPgDb('open-evidence-retention');
    const home = join(root, 'home'), repository = join(fixture!, 'repo'), dir = join(fixture!, 'leases');
    const evidenceRoot = join(home, '.papercusp/evidence');
    const retained = join(evidenceRoot, 'WI-open-native'), unrelated = join(evidenceRoot, 'unrelated');
    await mkdir(retained, { recursive: true }); await mkdir(unrelated);
    await writeFile(join(retained, 'result.json'), '{"passed":true}'); await writeFile(join(unrelated, 'data'), 'expired');
    await mkdir(join(repository, 'docs/evidence'), { recursive: true });
    const evidenceRef = 'docs/evidence/native.json';
    await writeFile(join(repository, evidenceRef), JSON.stringify({ retainedEvidence: {
      root: '.papercusp/evidence/WI-open-native', pathBase: 'Operating account home directory',
    } }));
    const nowMs = options.nowMs + 48 * 3_600_000;
    const repositories = new Map([['fixture', repository]]);
    try {
      await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared;
        CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text, status text);
        CREATE TABLE harness_shared.spec_evidence_bindings (workspace_id text, harness_slug text, work_item_id text, evidence_ref text, retracted_at timestamptz)`);
      await db.sql`INSERT INTO harness_shared.work_items VALUES ('fixture', 'fixture', 'WI-open', 'blocked'),
        ('fixture', 'fixture', 'WI-done', 'done'), ('foreign', 'fixture', 'WI-foreign', 'open'),
        ('fixture', 'fixture', 'WI-retracted', 'open')`;
      await db.sql`INSERT INTO harness_shared.spec_evidence_bindings VALUES
        ('fixture', 'fixture', 'WI-open', ${evidenceRef}, NULL), ('fixture', 'fixture', 'WI-done', ${evidenceRef}, NULL),
        ('fixture', 'fixture', 'WI-foreign', ${evidenceRef}, NULL), ('fixture', 'fixture', 'WI-retracted', ${evidenceRef}, now())`;
      expect(await readOpenWorkItemEvidenceReferences(db.sql, 'fixture')).toEqual([
        { harness_slug: 'fixture', work_item_id: 'WI-open', evidence_ref: evidenceRef },
      ]);
      const readProtection = async () => {
        const refs = await readOpenWorkItemEvidenceReferences(db.sql, 'fixture');
        const renewal = await renewWorkItemEvidencePins(refs, { repositories, home, dir, nowMs });
        expect(renewal.missing).toEqual([]);
        return { paths: [], pins: readRetentionPins({ dir, nowMs }).pins };
      };
      const policy = options.policy.map(cls => ({ ...cls, roots: [evidenceRoot] }));
      const receipt = await runDiskReclaimOnce({ ...options, nowMs, policy, roots: [{ path: evidenceRoot, classId: 'fixture' }], readProtection });
      expect(receipt.errors).toEqual([]);
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: retained, status: 'protected' }));
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: unrelated, status: 'removed' }));
      expect(JSON.parse(await readFile(join(retained, 'result.json'), 'utf8'))).toEqual({ passed: true });
      await expect(stat(unrelated)).rejects.toMatchObject({ code: 'ENOENT' });
      await db.sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = 'WI-open'`;
      expect(await readOpenWorkItemEvidenceReferences(db.sql, 'fixture')).toEqual([]);
      const later = nowMs + 73 * 3_600_000;
      const final = await runDiskReclaimOnce({ ...options, nowMs: later, policy, roots: [{ path: evidenceRoot, classId: 'fixture' }],
        readProtection: async () => ({ paths: [], pins: readRetentionPins({ dir, nowMs: later }).pins }) });
      expect(final.errors).toEqual([]);
      expect(final.entries).toContainEqual(expect.objectContaining({ path: retained, status: 'removed' }));
      await expect(stat(retained)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await db.cleanup(); }
  }, 120_000);

  it.each(['local', 'native'])('keeps a hardlinked population already within its cap (%s)', async route => {
    const { root, options } = await setup();
    const tree = join(root, 'tree'); await mkdir(tree);
    const file = join(tree, 'first'); await writeFile(file, Buffer.alloc(65536));
    await link(file, join(tree, 'second')); await link(file, join(root, 'sibling'));
    const uniqueBytes = (await stat(file)).blocks * 512 + (await stat(tree)).blocks * 512;
    const receipt = await runDiskReclaimOnce({ ...options, nowMs: Date.now(),
      ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
      policy: options.policy.map(cls => ({ ...cls, maxBytes: uniqueBytes })) });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: uniqueBytes, afterBytes: uniqueBytes });
    expect(receipt.entries.filter(entry => ['removed', 'would-remove'].includes(entry.status))).toEqual([]);
    expect((await stat(file)).nlink).toBe(3);
  });

  it.each(['local', 'native'].flatMap(route => ['pinned', 'held', 'leased', 'workspace', 'boundary'].map(protection => [route, protection])))
    ('keeps shared bytes after removing a link beside a %s/%s sibling', async (route, protection) => {
      const { root, options } = await setup();
      const discard = join(root, 'discard'), retained = join(root, 'retained'), extra = join(root, 'extra');
      const retainedFile = protection === 'boundary' ? join(retained, 'keep') : retained;
      if (protection === 'boundary') { await mkdir(retained); execFileSync('mkfifo', [join(retained, 'fifo')]); }
      await writeFile(discard, Buffer.alloc(65536)); await link(discard, retainedFile); await writeFile(extra, Buffer.alloc(16384));
      const sharedBytes = (await stat(retainedFile)).blocks * 512 + (protection === 'boundary' ? (await stat(retained)).blocks * 512 : 0),
        extraBytes = (await stat(extra)).blocks * 512;
      const receipt = await runDiskReclaimOnce({ ...options,
        ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
        roots: [{ path: root, classId: 'papercusp-scratch' }],
        policy: options.policy.map(cls => ({ ...cls, id: 'papercusp-scratch', maxBytes: 0 })),
        registeredWorkspaces: () => protection === 'workspace' ? ['retained'] : [],
        readProtection: async () => ({ paths: protection === 'leased' ? [retained] : [],
          pins: protection === 'pinned' ? [{ paths: [retained], expiresAt: new Date(options.nowMs + 60000).toISOString() }] : [] }),
        scanHolders: async () => ({ complete: true, byPath: new Map(protection === 'held' ? [[retained, ['123']]] : []) }),
      });
      expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: sharedBytes + extraBytes, afterBytes: sharedBytes,
        pinnedBytes: protection === 'pinned' ? sharedBytes : 0, overByBytes: sharedBytes });
      await expect(stat(discard)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(extra)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(retainedFile)).nlink).toBe(1);
      expect(receipt.complete).toBe(protection === 'pinned');
    });

  it.each(['local', 'native'])('subtracts a shared allocation only at its last planned link (%s)', async route => {
    const { root, options } = await setup();
    const first = join(root, 'a'), second = join(root, 'b');
    await writeFile(first, Buffer.alloc(65536)); await link(first, second);
    const bytes = (await stat(first)).blocks * 512;
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true, nowMs: Date.now(),
      ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
      policy: options.policy.map(cls => ({ ...cls, maxBytes: 0 })) });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: bytes, afterBytes: 0 });
    expect(receipt.entries.filter(entry => entry.status === 'would-remove')).toHaveLength(2);
    expect((await stat(first)).nlink).toBe(2);
  });

  it('refuses effects on a hardlink cap when a sibling census fails', async () => {
    const { root, options } = await setup();
    const first = join(root, 'a'), unknown = join(root, 'unknown');
    await writeFile(first, Buffer.alloc(65536)); await link(first, join(root, 'b')); await writeFile(unknown, 'unreadable');
    inspectionProbe.before = path => { if (path === unknown) throw Object.assign(new Error('EACCES fixture'), { code: 'EACCES' }); return undefined; };
    const receipt = await runDiskReclaimOnce({ ...options, policy: options.policy.map(cls => ({ ...cls, maxBytes: 0 })) });
    expect(receipt.complete).toBe(false);
    expect(receipt.scan?.incompleteRoots).toEqual([root]);
    expect(receipt.entries.filter(entry => ['removed', 'would-remove'].includes(entry.status))).toEqual([]);
    expect((await stat(first)).nlink).toBe(2);
  });

  it.each(['local', 'native'])('releases shared bytes after removing both build directories (%s)', async route => {
    const { root, options } = await setup(); const source = join(root, 'source'); await mkdir(source);
    const first = join(source, 'node_modules'), second = join(source, 'target'); await mkdir(first); await mkdir(second);
    await writeFile(join(second, 'CACHEDIR.TAG'), CACHEDIR_TAG_SIGNATURE + '\n');
    const file = join(first, 'a'); await writeFile(file, Buffer.alloc(65536)); await link(file, join(first, 'b')); await link(file, join(second, 'c'));
    const sourceBytes = (await stat(source)).blocks * 512;
    const receipt = await runDiskReclaimOnce({ ...options, removeEntry: fixtureBuildRemover,
      ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
      policy: options.policy.map(cls => ({ ...cls, maxBytes: 1024 ** 3,
        keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })) });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.caps?.[0]?.afterBytes).toBe(sourceBytes);
    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(second)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['local', 'native'].flatMap(route => [true, false].map(dryRun => [route, dryRun] as const)))
    ('accounts shared build-only removals with source and sibling links (%s dry=%s)', async (route, dryRun) => {
      const { root, options } = await setup(); const source = join(root, 'source'); await mkdir(source);
      const build = join(source, 'node_modules'); await mkdir(build);
      const file = join(source, 'keep'); await writeFile(file, Buffer.alloc(65536));
      await link(file, join(build, 'first')); await link(file, join(build, 'second')); await link(file, join(root, 'sibling'));
      const sharedBytes = (await stat(file)).blocks * 512, sourceBytes = (await stat(source)).blocks * 512,
        buildBytes = (await stat(build)).blocks * 512;
      const receipt = await runDiskReclaimOnce({ ...options, dryRun, removeEntry: fixtureBuildRemover,
        ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
        policy: options.policy.map(cls => ({ ...cls, maxBytes: 1024 ** 3,
          keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })) });
      expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
      expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: sourceBytes + buildBytes + sharedBytes,
        afterBytes: sourceBytes + sharedBytes });
      expect(receipt.entries.some(entry => entry.path === build && entry.status === (dryRun ? 'would-remove' : 'removed'))).toBe(true);
      expect((await stat(file)).nlink).toBe(dryRun ? 4 : 2);
    });
  it('reports worker phases before effects while preserving the build JSON receipt and identity refusal', async () => {
    const { root } = await setup();
    const source = join(root, 'source');
    await mkdir(source); await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules', 'payload'), 'rebuildable');
    const census = await inspectRetentionTrees(root, { retainAfterMs: Number.POSITIVE_INFINITY,
      includeRecent: true, collectBuildDirs: true });
    expect(census.error).toBeUndefined();
    const entry = { ...census.entries.find(candidate => candidate.path === source)!, root, classId: 'fixture', buildOnly: true };
    expect(entry.buildDirs).toEqual([expect.objectContaining({ path: join(source, 'node_modules') })]);
    const phases: string[] = [];
    const execute: typeof nativeRetentionCommand = async (_repo, _command, args, opts) => {
      const result = spawnSync(args[1]!, args.slice(2), { input: opts?.stdin, timeout: 10_000, encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      phases.push(...result.stderr.trim().split('\n').filter(line => line.startsWith('RETENTION_WORKER '))
        .map(line => JSON.parse(line.slice('RETENTION_WORKER '.length)).phase));
      return { ok: result.status === 0, detail: { output: result.stdout, stderr: result.stderr } };
    };
    const result = await removePrivilegedRetentionEntry(entry, 10_000, execute, undefined, true);
    expect(result).toMatchObject({ removed: [{ path: join(source, 'node_modules'), bytes: expect.any(Number) }] });
    expect(phases).toEqual(['started', 'input-read', 'root-verified', 'candidate-verified',
      'source-scan-started', 'source-scan-verified', 'effect-started', 'effect-completed']);
    expect(await readFile(join(source, 'node_modules', 'payload'), 'utf8')).toBe('rebuildable');
    phases.length = 0;
    await expect(removePrivilegedRetentionEntry({ ...entry, ino: entry.ino + 1 }, 10_000, execute))
      .rejects.toThrow('retention candidate identity changed');
    expect(phases).toEqual(['started', 'input-read', 'root-verified']);
    expect(await readFile(join(source, 'node_modules', 'payload'), 'utf8')).toBe('rebuildable');
  });

  it('waits for first mutex admission within the whole run deadline', async () => {
    const { root, options } = await setup();
    const path = join(root, 'old');
    await writeFile(path, 'expired');
    const began = performance.now(), wall = Date.now();
    const phases: unknown[] = [];
    let queued!: () => void;
    const queuedGate = new Promise<void>(resolve => { queued = resolve; });
    let retried!: () => void;
    const retriedGate = new Promise<void>(resolve => { retried = resolve; });
    const observe = (phase: string, details?: unknown) => {
      if (phases.length < 32) phases.push({ phase, elapsedMs: performance.now() - began, clockElapsedMs: Date.now() - wall, details });
      if (phase === 'mutex-waiting') {
        queued();
        if ((details as { elapsedMs: number }).elapsedMs >= 1_200) retried();
      }
    };
    fixtureMutex.observe = observe;
    let release!: () => void;
    let ready!: () => void;
    const readyGate = new Promise<void>((resolve) => { ready = resolve; });
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withFsMutex('papercusp-disk-retention', async () => {
      ready();
      await releaseGate;
    });
    await readyGate;
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let reclaim: Promise<DiskReclaimReceipt> | undefined;
    try {
      observe('reclaim-start');
      reclaim = runDiskReclaimOnce({ ...options, runBudgetMs: 5_000,
        record: async (phase, details) => observe('record:' + phase, (details as { phase?: string }).phase),
      });
      await Promise.race([queuedGate, reclaim.then(receipt => {
        throw new Error('reclaim finished before real mutex contention: ' + JSON.stringify(receipt));
      })]);
      // Exercise a wait beyond the former one-second admission allowance.
      // Advance only the deadline clock: filesystem/scheduler latency must not
      // silently turn this success scenario into the separate expiry scenario.
      clock += 1_200;
      await Promise.race([retriedGate, reclaim.then(receipt => {
        throw new Error('reclaim ended before retrying beyond one second: ' + JSON.stringify(receipt));
      })]);
      observe('holder-release');
      release();
      await holder;
      const receipt = await reclaim;
      observe('reclaim-end');
      const evidence = JSON.stringify({ phases, errors: receipt.errors, scan: receipt.scan });
      expect(receipt.errors, evidence).toEqual([]);
      expect(receipt.complete, evidence).toBe(true);
      expect(receipt.entries).toContainEqual(expect.objectContaining({ path, status: 'removed' }));
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      try { release(); await holder; await reclaim; }
      finally { now.mockRestore(); }
    }
  });

  it('refuses effects when first mutex admission exhausts the whole run deadline', async () => {
    const { root, options } = await setup();
    const path = join(root, 'retain');
    await writeFile(path, 'keep');
    let clock = Date.now(), admissions = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanHolders = vi.fn(options.scanHolders);
    fixtureMutex.observe = phase => {
      if (phase === 'mutex-callback') { admissions++; clock += 5_001; }
    };
    try {
      const receipt = await runDiskReclaimOnce({ ...options, runBudgetMs: 5_000, scanHolders });
      expect(admissions).toBe(1);
      expect(receipt.complete).toBe(false);
      expect(receipt.errors).toEqual(['retention run budget exhausted']);
      expect(receipt.entries).toEqual([]);
      expect(scanHolders).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe('keep');
    } finally { now.mockRestore(); }
  });

  it('stops waiting for first mutex admission when the run deadline expires', async () => {
    const { root, options } = await setup();
    const path = join(root, 'retain');
    await writeFile(path, 'keep');
    let release!: () => void;
    let ready!: () => void;
    const readyGate = new Promise<void>((resolve) => { ready = resolve; });
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withFsMutex('papercusp-disk-retention', async () => {
      ready();
      await releaseGate;
    });
    await readyGate;
    try {
      const receipt = await runDiskReclaimOnce({ ...options, runBudgetMs: 100 });
      expect(receipt.complete).toBe(false);
      expect(receipt.errors.join('; ')).toMatch(/Timed out after .*waiting for fs-mutex|retention run budget exhausted/);
      expect(receipt.entries).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe('keep');
    } finally { release(); await holder; }
  });

  it('uses a held regular-file lease for file effects while directories keep host holder scans', async () => {
    const { root, options } = await setup();
    const directory = join(root, 'a-directory'); await mkdir(directory); await writeFile(join(directory, 'payload'), 'old');
    const file = join(root, 'b-file'); await writeFile(file, 'old');
    const scanPaths: string[][] = [], leased: string[] = [], released: string[] = [];
    const receipt = await runDiskReclaimOnce({ ...options,
      scanHolders: async (paths) => { scanPaths.push([...paths]); return { complete: true, byPath: new Map<string, string[]>() }; },
      acquireRegularFileLease: async (entry) => {
        leased.push(entry.path);
        return { release: async () => { released.push(entry.path); } };
      },
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(leased).toEqual([file]); expect(released).toEqual([file]);
    expect(scanPaths.length).toBeGreaterThanOrEqual(1);
    expect(scanPaths.every((paths) => paths.length === 1 && paths[0] === directory)).toBe(true);
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: directory, status: 'removed' }));
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: file, status: 'removed' }));
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['local', 'native'])('expires build directories after one idle day while retaining their source entry (%s)', async route => {
    const { root, options } = await setup();
    const entry = join(root, 'agent-copy'); await mkdir(entry);
    const source = join(entry, 'source.ts'); await writeFile(source, 'owned source');
    const modules = join(entry, 'node_modules'); await mkdir(modules);
    await writeFile(join(modules, 'dependency.js'), 'regenerable');
    const cargo = join(entry, 'custom-cargo-cache'); await mkdir(cargo);
    await writeFile(join(cargo, 'CACHEDIR.TAG'), CACHEDIR_TAG_SIGNATURE + '\n');
    await writeFile(join(cargo, 'artifact'), 'regenerable');
    const ordinary = join(entry, 'ordinary-cache'); await mkdir(ordinary);
    await writeFile(join(ordinary, 'CACHEDIR.TAG'), 'not the cache signature');
    // Nested build roots count once and retain their containing source.
    await mkdir(join(modules, 'nested')); await mkdir(join(modules, 'nested', 'node_modules'));
    const receipt = await runDiskReclaimOnce({ ...options, removeEntry: fixtureBuildRemover,
      ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
      policy: options.policy.map(cls => ({ ...cls, keep: { kind: 'max-age' as const,
        maxAgeHours: 72, buildDirMaxAgeHours: 24 } })),
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: modules, status: 'removed' }));
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: cargo, status: 'removed' }));
    await expect(stat(modules)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(cargo)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('owned source');
    expect((await stat(ordinary)).isDirectory()).toBe(true);
    expect(receipt.entries.filter(value => value.status === 'removed')).toHaveLength(2);
  });

  it.each(['local', 'native'])('retains active and protected build sources and reports a precise dry run (%s)', async route => {
    const { root, options } = await setup();
    const names = ['recent', 'pinned', 'leased', 'held', 'boundary', 'ready'];
    for (const name of names) {
      await mkdir(join(root, name)); await mkdir(join(root, name, 'node_modules'));
      await writeFile(join(root, name, 'source.ts'), 'keep source');
    }
    await utimes(join(root, 'recent', 'source.ts'), new Date(options.nowMs), new Date(options.nowMs));
    await symlink(join(root, 'ready'), join(root, 'boundary', 'linked'));
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true, removeEntry: fixtureBuildRemover,
      ...(route === 'native' ? { inspectTrees: inspectRetentionTrees } : {}),
      policy: options.policy.map(cls => ({ ...cls, keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })),
      readProtection: async () => ({ paths: [join(root, 'leased')],
        pins: [{ paths: [join(root, 'pinned')], expiresAt: new Date(options.nowMs + 60_000).toISOString() }] }),
      scanHolders: async () => ({ complete: true, byPath: new Map([[join(root, 'held'), ['123']]]) }),
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.entries.filter(value => value.status === 'would-remove').map(value => value.path)).toEqual([join(root, 'ready', 'node_modules')]);
    for (const name of names) expect((await stat(join(root, name, 'node_modules'))).isDirectory()).toBe(true);
  });

  it('retains a build source written after its removal intent', async () => {
    const { root, options } = await setup();
    const source = join(root, 'copy'); await mkdir(source); await mkdir(join(source, 'node_modules'));
    const file = join(source, 'source.ts'); await writeFile(file, 'original');
    const receipt = await runDiskReclaimOnce({ ...options, removeEntry: fixtureBuildRemover, inspectTrees: inspectRetentionTrees,
      policy: options.policy.map(cls => ({ ...cls, keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })),
      record: async phase => { if (phase === 'remove-intent') await utimes(file, new Date(options.nowMs), new Date(options.nowMs)); },
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.entries.some(value => value.status === 'removed')).toBe(false);
    expect((await stat(join(source, 'node_modules'))).isDirectory()).toBe(true);
  });

  it('refuses a source write between the final JS check and native build removal', async () => {
    const { root, options } = await setup();
    const source = join(root, 'copy'); await mkdir(source); await mkdir(join(source, 'node_modules'));
    const file = join(source, 'source.ts'); await writeFile(file, 'original');
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees,
      policy: options.policy.map(cls => ({ ...cls, keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })),
      removeEntry: async (entry, ms) => {
        await utimes(file, new Date(options.nowMs), new Date(options.nowMs));
        return fixtureBuildRemover(entry, ms);
      },
    });
    expect(receipt.complete).toBe(false);
    expect(receipt.errors.join('; ')).toContain('retention source changed before build removal');
    expect((await stat(join(source, 'node_modules'))).isDirectory()).toBe(true);
  });

  it('subtracts only removed build bytes from a capped source entry', async () => {
    const { root, options } = await setup();
    const source = join(root, 'copy'); await mkdir(source); await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'source.ts'), Buffer.alloc(8192));
    await writeFile(join(source, 'node_modules', 'dependency.js'), Buffer.alloc(4096));
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees: inspectRetentionTrees, removeEntry: fixtureBuildRemover,
      policy: options.policy.map(cls => ({ ...cls, maxBytes: 1024 * 1024,
        keep: { kind: 'max-age' as const, maxAgeHours: 72, buildDirMaxAgeHours: 24 } })),
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    const removed = receipt.entries.filter(value => value.status === 'removed');
    expect(removed).toHaveLength(1); expect(removed[0]!.path).toBe(join(source, 'node_modules'));
    expect(receipt.caps![0]!.afterBytes).toBe(receipt.caps![0]!.beforeBytes - removed[0]!.bytes);
    expect((await stat(join(source, 'source.ts'))).size).toBe(8192);
  });

  it('starts the next pass after a root whose census spent the preceding deadline', async () => {
    const { root, options } = await setup();
    const blocked = join(root, 'data-device'); await mkdir(blocked);
    const ready = join(root, 'root-device'); await mkdir(ready);
    const expired = join(ready, 'expired'); await writeFile(expired, 'old root-disk data');
    const roots = [blocked, ready].map(path => ({ path, classId: 'fixture' }));
    const scoped = { ...options, roots, policy: options.policy.map(cls => ({ ...cls, roots: [blocked, ready] })) };
    const first = await runDiskReclaimOnce({ ...scoped, inspectTrees: async () => ({
      entries: [], retained: [], inspectedNodes: 1, retainedRecentTrees: 0, error: 'retention native census timed out',
    }) });
    expect(first.scan?.stoppedAtRoot).toBe(blocked);
    const visited: string[] = [];
    const second = await runDiskReclaimOnce({ ...scoped, previousReceipt: first,
      inspectTrees: async (path, input) => {
        visited.push(path);
        return path === blocked
          ? { entries: [], retained: [], inspectedNodes: 1, retainedRecentTrees: 0, error: 'retention native census timed out' }
          : inspectRetentionTrees(path, input);
      },
    });
    expect(visited[0]).toBe(ready);
    expect(second.entries).toContainEqual(expect.objectContaining({ path: expired, status: 'removed' }));
    expect(second.errors).toContain(`inspect:${blocked}: retention native census timed out`);
    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(second.roots?.map(value => value.path)).toEqual([ready, blocked]);
    for (const previousReceipt of [{ ...first, host: 'another-host' }, { ...first, dryRun: true },
      { ...first, complete: true }, { ...first, scan: { ...first.scan!, stoppedAtRoot: '/gone' } }]) {
      const ignored = await runDiskReclaimOnce({ ...scoped, previousReceipt, dryRun: true });
      expect(ignored.roots?.map(value => value.path)).toEqual([blocked, ready]);
    }
  });

  it.each(['advancing-census', 'expired-inspection', 'expired-admission', 'expired-run'] as const)
    ('finishes an advancing root beyond its inspection allowance before applying the cap (%s)', async mode => {
    const { root, options } = await setup();
    const old = join(root, 'old'); await writeFile(old, 'old data');
    let clock = Date.now(), admissions = 0, censuses = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanHolders = vi.fn(options.scanHolders);
    fixtureMutex.observe = phase => {
      if (phase === 'mutex-callback') {
        admissions++;
        if (mode === 'expired-admission') clock += 10_001;
      }
    };
    try {
      const receipt = await runDiskReclaimOnce({ ...options, budgetMs: 20, runBudgetMs: 10_000, scanHolders,
        policy: options.policy.map((cls) => ({ ...cls, maxBytes: 1 })),
        record: async (phase, details) => {
          // This write follows the paused native span and spends JS inspection
          // time. Scheduler latency must not choose which budget this case tests.
          if (mode === 'expired-inspection' && phase === 'progress' &&
              (details as { phase?: string }).phase === 'census-finish') clock += 21;
        },
        inspectTrees: async (path, input) => {
          expect(input.paths).toBeUndefined();
          censuses++;
          expect(input.timeoutMs).toBeGreaterThan(30);
          expect(input.progressTimeoutMs).toBe(20);
          // Keep native inspection and deletion real. Its real inactivity and
          // absolute timers are covered in disk-consumer-census.test.ts; only
          // the JS deadline clock advances at the selected stage in this test.
          const census = await inspectRetentionTrees(path, { ...input, progressTimeoutMs: undefined });
          if (mode === 'advancing-census') clock += 30;
          if (mode === 'expired-run') clock += 10_001;
          return census;
        } });
      const evidence = JSON.stringify({ mode, admissions, censusCalls: censuses, errors: receipt.errors,
        scan: receipt.scan, censuses: receipt.censuses, effects: receipt.effects });
      expect(admissions, evidence).toBe(1);
      expect(censuses, evidence).toBe(mode === 'expired-admission' ? 0 : 1);
      if (mode === 'advancing-census') {
        expect(receipt.complete, evidence).toBe(true);
        expect(receipt.errors, evidence).toEqual([]);
        expect(scanHolders, evidence).toHaveBeenCalledTimes(2);
        expect(receipt.caps?.[0], evidence).toMatchObject({ afterBytes: 0, overByBytes: 0 });
        await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(receipt.complete, evidence).toBe(false);
        expect(receipt.entries.filter(entry => entry.status === 'removed'), evidence).toEqual([]);
        expect(await readFile(old, 'utf8'), evidence).toBe('old data');
        if (mode === 'expired-admission') {
          expect(receipt.errors, evidence).toEqual(['retention run budget exhausted']);
          expect(scanHolders, evidence).not.toHaveBeenCalled();
        } else if (mode === 'expired-inspection') {
          expect(receipt.errors, evidence).toContain('incomplete tree scan: retention scan budget exhausted');
          expect(receipt.scan?.stoppedAtRoot, evidence).toBe(root);
          expect(scanHolders, evidence).toHaveBeenCalledTimes(1);
        } else {
          expect(receipt.errors, evidence).toContain(`incomplete retention effects:${root}: effect budget exhausted; resume with a fresh policy census`);
          expect(receipt.effects, evidence).toEqual([expect.objectContaining({ processed: 0, stopped: true })]);
          expect(scanHolders, evidence).not.toHaveBeenCalled();
        }
      }
    } finally { now.mockRestore(); }
  });

  it('persists root census timeout attribution without copying allocation inventories', async () => {
    const { root, options } = await setup();
    const events: Array<{ phase: string; [key: string]: unknown }> = [];
    const timing = { elapsedMs: 200, lastProgressAfterMs: 150, lastChildPath: join(root, 'large'),
      timeoutMs: 200, progressTimeoutMs: 50, timeoutKind: 'absolute' as const };
    const receipt = await runDiskReclaimOnce({ ...options,
      record: async (phase, details) => { if (phase === 'progress') events.push(details as typeof events[number]); },
      inspectTrees: async () => ({ entries: [], retained: [], inspectedNodes: 123, retainedRecentTrees: 0,
        timing, error: 'retention native census timed out',
        inventoryMustNotBePersisted: ['private allocation graph'],
      }),
    });
    expect(receipt.complete).toBe(false);
    expect(receipt.censuses).toEqual([{ root, classId: 'fixture', elapsedMs: expect.any(Number),
      inspectedNodes: 123, timing, error: 'retention native census timed out' }]);
    expect(events).toContainEqual({ phase: 'census-start', root, classId: 'fixture' });
    expect(events).toContainEqual({ phase: 'census-finish', ...receipt.censuses![0] });
    expect(JSON.stringify({ censuses: receipt.censuses, events })).not.toContain('private allocation graph');
    expect(receipt.entries.some(entry => entry.status === 'removed')).toBe(false);
  });

  it('reaps an elevated census worker at its native deadline when ordinary-user signalling would fail', async () => {
    const { root } = await setup(); const pidFile = join(root, 'worker-pid');
    let signalAttempts = 0;
    const census = await inspectRetentionTrees(root, { retainAfterMs: Date.now(), requirePrivilege: true, sudo: '/usr/bin/sudo', timeoutMs: 1000,
      spawn: (command, args) => {
        const find = args.indexOf('find'); expect(find).toBeGreaterThan(0);
        // Exercise the real sudo/timeout process chain with a deterministic
        // stalled native worker, instead of depending on a slow filesystem.
        const child = spawn(command, [...args.slice(0, find), '/bin/sh', '-c', 'echo $$ > "$1"; exec /bin/sleep 60', 'retention-stall', pidFile],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        child.kill = () => { signalAttempts++; child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })); return false; };
        return child;
      } });
    expect(census.error).toBe('retention native census timed out');
    expect(census.entries).toEqual([]); expect(signalAttempts).toBe(0);
    const pid = Number((await readFile(pidFile, 'utf8')).trim()); expect(pid).toBeGreaterThan(1);
    await expect(stat(`/proc/${pid}`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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

  it.each([undefined, inspectRetentionTrees])('counts registered workspace scratch in the cap while preserving its owner (%s)', async (inspectTrees) => {
    const { root, options } = await setup(); const workspace = join(root, 'ws'), disposable = join(root, 'disposable');
    await mkdir(workspace); await writeFile(join(workspace, 'payload'), Buffer.alloc(8192));
    await writeFile(disposable, Buffer.alloc(4096));
    const census = await inspectRetentionTrees(root, { retainAfterMs: 0, includeRecent: true });
    expect(census.error).toBeUndefined();
    const workspaceBytes = census.entries.find((entry) => entry.path === workspace)!.bytes;
    const beforeBytes = census.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees, nowMs: Date.now(), registeredWorkspaces: () => ['ws'],
      roots: [{ path: root, classId: 'papercusp-scratch' }],
      policy: options.policy.map((cls) => ({ ...cls, id: 'papercusp-scratch', maxBytes: 4096 })) });
    expect(receipt.caps?.[0]).toMatchObject({ beforeBytes, afterBytes: workspaceBytes, pinnedBytes: 0,
      overByBytes: workspaceBytes - 4096, pinnedOverageBytes: 0 });
    expect(receipt.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: workspace, status: 'protected', reason: 'registered workspace scratch owner' }),
      expect.objectContaining({ path: disposable, status: 'removed' }),
    ]));
    expect(receipt.complete).toBe(false);
    expect(receipt.errors).toContain(`size cap remains exceeded:${root}:${workspaceBytes - 4096}`);
    expect((await stat(join(workspace, 'payload'))).size).toBe(8192);
    await expect(stat(disposable)).rejects.toMatchObject({ code: 'ENOENT' });
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
        inspectTrees: (root, opts) => inspectRetentionTrees(root, { ...opts, requirePrivilege: true }),
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
    expect(receipt.entries).toContainEqual(expect.objectContaining({ path: held, status: 'protected',
      reason: expect.stringMatching(/live process|process evidence unavailable or held/) }));
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

  it('finds cwd executable and deleted fd holders through the real isolated privileged release scanner', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'release-holder-native-'));
    const cwd = join(fixture, 'cwd'), executable = join(fixture, 'executable');
    const descriptors = join(fixture, 'descriptors'), idle = join(fixture, 'idle');
    for (const path of [cwd, executable, descriptors, idle]) await mkdir(path);
    const binary = join(executable, 'sleep');
    await copyFile('/bin/sleep', binary); await chmod(binary, 0o755);
    const heldFile = join(descriptors, 'deleted');
    await writeFile(heldFile, 'held descriptor');
    const db = await createFreshPgDb('release-holder-native');
    const fd = await open(heldFile, 'r');
    await rm(heldFile);
    const child = spawn(binary, ['120'], { cwd, stdio: 'ignore' });
    const spawned = once(child, 'spawn');
    const closed = once(child, 'close');
    nativeDb.sql = db.sql;
    managedProbe.active = true;
    try {
      await spawned;
      await applyEventSubstrateMigrationsForTest(db.sql, {
        label: 'disk-reclaim.integration.test.ts privileged release holder', ...COORD_SUBSCRIPTION_SUBSTRATE,
        extra: [...COORD_SUBSCRIPTION_SUBSTRATE.extra,
          '696-task-ledger.sql', '700-task-ledger-bash-job-id-idx.sql', '774-task-ledger-ended-unobserved-state.sql'],
      });
      const scan = await scanProcHolders([cwd, executable, descriptors, idle].map(key => ({ key, prefixes: [key] })));
      console.info('NATIVE_RELEASE_HOLDER_RESULT', JSON.stringify({ verified: scan.verified,
        diagnostics: scan.diagnostics, holders: [...scan.holders], childPid: child.pid, callerPid: process.pid }));
      expect(scan.holders.get(cwd)).toContain(`pid ${child.pid} reference`);
      expect(scan.holders.get(executable)).toContain(`pid ${child.pid} reference`);
      expect(scan.holders.get(descriptors)).toContain(`pid ${process.pid} reference`);
      expect(scan.holders.has(idle)).toBe(false);
      expect(scan.verified, JSON.stringify(scan)).toBe(true);
      expect(scan.diagnostics).toMatchObject({ readFailures: 0, deadlineExceeded: false });
      expect(scan.diagnostics?.processesScanned).toBeGreaterThan(0);
    } finally {
      child.kill('SIGTERM'); await closed; await fd.close();
      managedProbe.active = false; nativeDb.sql = undefined;
      await db.cleanup();
    }
  }, 180_000);

  it('runs the native cargo delegate repeatedly with captured receipts and no missed completion', async () => {
    const phase = (name: string) => console.info('NATIVE_RETENTION_PHASE', name);
    phase('fixture');
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
      `PAPERCUSP_FS_MUTEX_LOCK_DIR=${join(fixture, 'mutex')}`,
      '/bin/bash', join(repoRoot, 'papercusp-desktop/bin/reap-private-target-slots.sh'),
    ];
    const db = await createFreshPgDb('disk-retention-native');
    nativeDb.sql = db.sql;
    managedProbe.active = true;
    try {
      phase('migrations');
      await applyEventSubstrateMigrationsForTest(db.sql, {
        label: 'disk-reclaim.integration.test.ts native delegate', ...COORD_SUBSCRIPTION_SUBSTRATE,
        extra: [...COORD_SUBSCRIPTION_SUBSTRATE.extra,
          '696-task-ledger.sql', '700-task-ledger-bash-job-id-idx.sql', '774-task-ledger-ended-unobserved-state.sql'],
      });
      // Check the same task control route before admitting privileged work.
      const { getTask: getNativeTask } = await import('../task-manager/store');
      phase('timeout-control');
      const stalled = await nativeRetentionCommand(repoRoot, '/bin/sh', ['-c', 'echo $$; exec /bin/sleep 30'],
        { timeoutMs: 2_000, stdoutOnly: true });
      expect(stalled, JSON.stringify(stalled)).toMatchObject({ ok: false, detail: { error: 'delegate timeout' } });
      const stalledDetail = stalled.detail as { taskId: string; output: string; cleanup?: unknown };
      expect(stalledDetail.cleanup, JSON.stringify(stalled)).toBeUndefined();
      const stalledPid = Number(stalledDetail.output.trim()); expect(stalledPid).toBeGreaterThan(1);
      await expect(stat(`/proc/${stalledPid}`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await getNativeTask(stalledDetail.taskId)).toMatchObject({ state: 'killed' });
      // Measure the actual fd-safe privileged remover, including enrollment and
      // terminal persistence. A no-op child cannot establish unlink cost.
      // Repeated launches exercise privilege startup and terminal persistence
      // without rebuilding a database or replaying the whole fixture suite.
      for (let attempt = 0; attempt < 6; attempt++) {
        const nativePath = join(fixture, `native-expired-${attempt}`);
        await writeFile(nativePath, 'expired native fixture');
        const nativeStat = await stat(nativePath);
        const nativeTimings: NativeRetentionTiming[] = [];
        phase(`native-removal-${attempt}`);
        try {
          await removePrivilegedRetentionEntry({ path: nativePath, root: fixture, classId: 'fixture',
            newestWriteMs: nativeStat.mtimeMs, bytes: nativeStat.size, dev: nativeStat.dev, ino: nativeStat.ino },
          20_000, nativeRetentionCommand, (timing) => nativeTimings.push(timing));
        } finally { console.info('NATIVE_RETENTION_REMOVER_TIMING', JSON.stringify({ attempt, timings: nativeTimings })); }
        await expect(stat(nativePath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(nativeTimings).toHaveLength(1);
        const timing = nativeTimings[0];
        expect(timing.taskId).toEqual(expect.any(String));
        for (const offset of [timing.spawnedAfterMs, timing.childClosedAfterMs,
          timing.launchReturnedAfterMs, timing.completedAfterMs]) {
          expect(offset).toEqual(expect.any(Number));
          expect(offset).toBeGreaterThanOrEqual(0);
          expect(offset).toBeLessThanOrEqual(timing.totalMs);
        }
        expect(timing.childClosedAfterMs!).toBeGreaterThanOrEqual(timing.spawnedAfterMs!);
        expect(timing.completedAfterMs!).toBeGreaterThanOrEqual(timing.childClosedAfterMs!);
        expect(timing.completedAfterMs!).toBeGreaterThanOrEqual(timing.launchReturnedAfterMs!);
        expect(timing.stages.length).toBeGreaterThan(0);
        expect(await getNativeTask(timing.taskId!)).toMatchObject({ state: 'exited', exitCode: 0 });
      }
      // Exercise build batch stdin, JSON output and terminal persistence through
      // the production enrolled remover as well as the owner-only fixture path.
      const buildRoot = join(fixture, 'native-build-root'); await mkdir(buildRoot);
      const buildSource = join(buildRoot, 'copy'); await mkdir(buildSource);
      const buildPath = join(buildSource, 'node_modules'); await mkdir(buildPath);
      await writeFile(join(buildPath, 'dependency.js'), 'rebuildable');
      await writeFile(join(buildSource, 'source.ts'), 'retained source');
      const buildPolicy: RetentionClass[] = [{ id: 'fixture-build', title: 'fixture', origin: 'agent', roots: [buildRoot],
        keep: { kind: 'max-age', maxAgeHours: 72, buildDirMaxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] }];
      phase('native-build-removal');
      const buildReceipt = await runDiskReclaimOnce({ nowMs: Date.now() + 48 * 3_600_000,
        // A tiny fixture must report its own blocked phase before Vitest's
        // outer deadline, rather than inherit the production 15-minute wait.
        runBudgetMs: 20_000, budgetMs: 10_000, effectBudgetMs: 10_000,
        policy: buildPolicy, roots: [{ path: buildRoot, classId: 'fixture-build' }],
        registeredWorkspaces: () => [], expectedDevices: [], sample: async () => [],
        scanHolders: async () => ({ complete: true, byPath: new Map() }),
        inspectTrees: (root, opts) => inspectRetentionTrees(root, { ...opts, requirePrivilege: true }),
        removeEntry: (entry, ms, observe, dryRun) => removePrivilegedRetentionEntry(entry, ms, nativeRetentionCommand, observe, dryRun),
      });
      expect(buildReceipt.complete, buildReceipt.errors.join('; ')).toBe(true);
      expect(buildReceipt.entries).toContainEqual(expect.objectContaining({ path: buildPath, status: 'removed' }));
      expect(await readFile(join(buildSource, 'source.ts'), 'utf8')).toBe('retained source');
      const buildTiming = buildReceipt.entries.find(value => value.path === buildSource)?.nativeCommand;
      expect(buildTiming?.taskId).toEqual(expect.any(String));
      expect(await getNativeTask(buildTiming!.taskId!)).toMatchObject({ state: 'exited', exitCode: 0 });
      // Exercise the input transport against this real enrolled-task database.
      // A single argv argument of this size fails with E2BIG on Linux.
      const input = JSON.stringify(Array.from({ length: 14_000 }, (_, i) => `/scratch/expired-${i}`));
      expect(Buffer.byteLength(input)).toBeGreaterThan(128 * 1024);
      phase('streamed-input');
      const streamed = await nativeRetentionCommand(repoRoot, process.execPath, ['--input-type=module', '-e',
      "const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk); const input=Buffer.concat(chunks).toString('utf8'); console.log(JSON.stringify({bytes:Buffer.byteLength(input),paths:JSON.parse(input).length,mutexHeld:process.env.PAPERCUSP_DISK_RETENTION_MUTEX_HELD}));"],
      { stdin: input, stdoutOnly: true, timeoutMs: 10_000, env: { ...process.env, PAPERCUSP_DISK_RETENTION_MUTEX_HELD: '1' } });
      expect(streamed, JSON.stringify(streamed)).toMatchObject({ ok: true });
      expect(JSON.parse((streamed.detail as { output: string }).output)).toEqual({ bytes: Buffer.byteLength(input), paths: 14_000, mutexHeld: '1' });
      // Simulate another host actor holding the inherited lock domain without
      // touching the account's real mutex. The fixture delegate must use its
      // own domain even when the private runtime preserves that host setting.
      const inheritedMutexRoot = join(fixture, 'inherited-mutex');
      const holder = spawn(process.execPath, ['--input-type=module', '-e',
        `import { withFsMutex } from ${JSON.stringify(new URL('../../../../scripts/lib/fs-mutex.mjs', import.meta.url).href)};
        const released = new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });
        await withFsMutex('papercusp-disk-retention', async () => { process.stdout.write('LOCKED\\n'); await released; });`],
      { env: { ...process.env, PAPERCUSP_FS_MUTEX_LOCK_DIR: inheritedMutexRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
      const holderClosed = once(holder, 'close');
      let listed: Awaited<ReturnType<typeof nativeRetentionCommand>>;
      try {
        phase('inherited-lock-ready');
        const [ready] = await once(holder.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
        expect(String(ready)).toBe('LOCKED\n');
        phase('cargo-preview');
        listed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', [...args, '--dry-run'], {
          timeoutMs: 10_000, env: { ...process.env, PAPERCUSP_FS_MUTEX_LOCK_DIR: inheritedMutexRoot },
        });
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
        expect(listed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`would reap: ${dead}`) });
      } finally {
        holder.stdin.end();
        await holderClosed;
      }
      await expect(stat(dead)).resolves.toBeDefined();
      phase('cargo-removal');
      const removed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args, { timeoutMs: 10_000 });
      expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
      expect(removed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`reaped dead private target slot ${dead}`) });
      await expect(stat(dead)).rejects.toMatchObject({ code: 'ENOENT' });
      const repeated = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args, { timeoutMs: 10_000 });
      expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true });
      const { getTask } = await import('../task-manager/store');
      for (const result of [streamed, listed, removed, repeated]) {
        const id = (result.detail as { taskId: string }).taskId;
        // The helper must await persistence itself. Polling here hid the window
        // where a short-lived caller could exit and lose the terminal write.
        expect(await getTask(id)).toMatchObject({ state: 'exited', exitCode: 0 });
      }
      phase('complete');
    } finally {
      phase('database-cleanup');
      managedProbe.active = false;
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

  it.each([false, true])('checks each regular file directly after intent with enrolled remover=%s without restarting the tree inspector', async (enrolledRemover) => {
    const { root, options } = await setup();
    const old = join(root, 'a-old'), changed = join(root, 'b-changed');
    await writeFile(old, 'expired'); await writeFile(changed, 'keep after new write');
    const inspectTrees = vi.fn(inspectRetentionTrees);
    const phases: string[] = [];
    const receipt = await runDiskReclaimOnce({ ...options, inspectTrees,
      ...(enrolledRemover ? { removeEntry: async (entry: { path: string }) => rm(entry.path) } : {}),
      record: async (phase, detail) => {
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
  it('starts effects without an all-candidate holder census and still protects a later held path', async () => {
    const { root, options } = await setup();
    const paths = ['a-old', 'b-held', 'c-old'].map((name) => join(root, name));
    for (const path of paths) await writeFile(path, 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const checks: string[][] = [];
    try {
      const receipt = await runDiskReclaimOnce({ ...options, effectBudgetMs: 100,
        scanHolders: async (wanted) => {
          checks.push([...wanted]);
          // The standing large-root failure: a complete bulk scan alone can
          // outlast the effect allowance before any candidate is processed.
          clock += wanted.length > 1 ? 200 : 1;
          return { complete: true, byPath: new Map(wanted.includes(paths[1]!) ? [[paths[1]!, ['123']]] : []) };
        },
      });
      expect(receipt.complete, JSON.stringify(receipt.errors)).toBe(true);
      expect(receipt.entries.filter((entry) => entry.status === 'removed').map((entry) => entry.path)).toEqual([paths[0], paths[2]]);
      expect(await readFile(paths[1]!, 'utf8')).toBe('expired');
      // Every effect still needs its own current holder evidence, including
      // candidates absent from the initial optimization's result.
      for (const path of paths) expect(checks).toContainEqual([path]);
      for (const path of [paths[0]!, paths[2]!]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
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
      expect([...new Set(checks.map((check) => check.batch))]).toEqual([0, 1, 2]);
      expect(checks.every((check) => check.paths.length === 1)).toBe(true);
      for (const path of [paths[0]!, paths[2]!, paths[3]!]) {
        expect(checks.some((check) => check.paths.length === 1 && check.paths[0] === path)).toBe(true);
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(paths[1]!, 'utf8')).toBe('expired');
    } finally { vi.useRealTimers(); }
  });
  it('checkpoints the first productive effect batch before a slow independent census and refreshes protection on continuation', async () => {
    const { root, options } = await setup();
    const slowRoot = join(fixture!, 'slow-root'); await mkdir(slowRoot);
    const paths = [join(root, 'a-old'), join(root, 'b-new-pin'), join(slowRoot, 'old')];
    for (const path of paths) await writeFile(path, 'expired');
    let clock = options.nowMs, activeBatch = 0;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock);
    const receipts: DiskReclaimReceipt[] = [];
    const inspected: Array<{ batch: number; root: string }> = [];
    const protectionReads: number[] = [];
    try {
      const result = await drainScheduledDiskReclaim(async (batch, notAfterMs) => {
        activeBatch = batch;
        if (notAfterMs !== undefined && clock >= notAfterMs) return null;
        const receipt = await runDiskReclaimOnce({ ...options, nowMs: clock, effectBudgetMs: 50,
          yieldAfterProductiveEffects: true,
          runBudgetMs: notAfterMs === undefined ? 1000 : notAfterMs - clock,
          previousReceipt: receipts.at(-1),
          policy: [...options.policy, { ...options.policy[0]!, id: 'slow', roots: [slowRoot] }],
          roots: [...options.roots, { path: slowRoot, classId: 'slow' }],
          readProtection: async () => {
            protectionReads.push(activeBatch);
            return { paths: activeBatch > 0 ? [paths[1]!] : [] };
          },
          inspectTrees: async (path, input) => {
            if (!input.paths) {
              inspected.push({ batch: activeBatch, root: path });
              if (path === slowRoot) { clock += 200; vi.setSystemTime(clock); }
            }
            return inspectRetentionTrees(path, input);
          },
          record: async phase => { if (phase === 'removed') { clock += 75; vi.setSystemTime(clock); } },
        });
        receipts.push(receipt); return receipt;
      }, { maxElapsedMs: 1000 });
      expect(result).toMatchObject({ batches: 2, stop: 'complete' });
      expect(inspected.filter(value => value.batch === 0)).toEqual([{ batch: 0, root }]);
      expect(inspected.filter(value => value.batch === 1).map(value => value.root)).toEqual([slowRoot, root]);
      expect(receipts[0]).toMatchObject({ complete: false, policyExhausted: null, scan: { incompleteRoots: [slowRoot] } });
      expect(protectionReads).toContain(1);
      expect(receipts[1]!.entries).toContainEqual(expect.objectContaining({ path: paths[1], status: 'protected' }));
      expect(clock - options.nowMs).toBeLessThan(1000);
      for (const path of [paths[0]!, paths[2]!]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
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
          else clock += 1000;
        },
        scanHolders: async () => {
          clock += intent ? 30 : 20;
          return { complete: !intent || complete, byPath: new Map<string, string[]>() };
        },
      });
      expect(receipt.complete).toBe(complete);
      expect(reinspectionMs).toBeGreaterThan(0);
      expect(receipt.effects?.[0]?.timings).toEqual({ initialHolderScanMs: 20, freshHolderScanMs: 30,
        reinspectionMs, removalMs: 0, removalAuditMs: complete ? 14 : 7,
        progressRecordMs: 2000, yieldWaitMs: 0, leaseReleaseMs: 0 });
      expect(receipt.entries[0]?.status).toBe(complete ? 'removed' : 'protected');
      if (complete) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(path, 'utf8')).toBe('expired');
    } finally { now.mockRestore(); }
  });
  it.each([false, true])('attributes progress and regular-file lease release time, including a failed release (%s)', async (releaseFails) => {
    const { root, options } = await setup(); const path = join(root, 'timed-lease'); await writeFile(path, 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const receipt = await runDiskReclaimOnce({ ...options,
        record: async phase => { if (phase === 'progress') clock += 11; },
        acquireRegularFileLease: async () => ({ release: async () => {
          clock += 37;
          if (releaseFails) throw new Error('fixture release failure');
        } }),
      });
      expect(receipt.complete).toBe(!releaseFails);
      expect(receipt.effects?.[0]).toMatchObject({ elapsedMs: 59, timings: {
        progressRecordMs: 22, yieldWaitMs: 0, leaseReleaseMs: 37,
      } });
      expect(receipt.entries[0]?.status).toBe(releaseFails ? 'failed' : 'removed');
      if (releaseFails) expect(receipt.errors).toContain(`lease-release:${path}: fixture release failure`);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { now.mockRestore(); }
  });
  it('keeps regular-file lease release time charged to the effect budget', async () => {
    const { root, options } = await setup();
    for (const name of ['old-a', 'old-b']) await writeFile(join(root, name), 'expired');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const receipt = await runDiskReclaimOnce({ ...options, effectBudgetMs: 30,
        acquireRegularFileLease: async () => ({ release: async () => { clock += 40; } }),
      });
      expect(receipt.complete).toBe(false);
      expect(receipt.effects?.[0]).toMatchObject({ processed: 1, remaining: 1, stopped: true,
        timings: { leaseReleaseMs: 40 } });
      expect(receipt.entries.filter(entry => entry.status === 'removed')).toHaveLength(1);
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
  it('finishes an admitted removal, yields the real mutex, then resumes the same pass', async () => {
    const { root, options } = await setup();
    const paths = [join(root, 'old-a'), join(root, 'old-b')];
    for (const path of paths) await writeFile(path, Buffer.alloc(4096));
    const policy = options.policy.map((cls) => ({ ...cls, maxBytes: 4096 }));
    let entered!: () => void, finish!: () => void, queued!: () => void;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    const finishRemoval = new Promise<void>((resolve) => { finish = resolve; });
    const waiting = new Promise<void>((resolve) => { queued = resolve; });
    const delegate = vi.fn(async () => ({ ok: true, detail: 'fixture owner' }));
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const reclaim = runDiskReclaimOnce({ ...options, policy, effectBudgetMs: 100, delegates: [{ classId: 'fixture-owner', run: delegate }],
      removeEntry: async (entry) => { entered(); await finishRemoval; await rm(entry.path); } });
    await removing;
    let peerEntered = false;
    const peer = withFsMutex('papercusp-disk-retention', async () => { peerEntered = true; clock += 250; },
      { timeoutMs: 5_000, retryMs: 5, onWaiting: queued });
    try {
      try {
        await waiting;
        expect(peerEntered).toBe(false);
      } finally { finish(); }
      const receipt = await reclaim;
      await peer;
      expect(peerEntered).toBe(true);
      expect(receipt.complete).toBe(true); expect(receipt.policyExhausted).toBe(true);
      expect(receipt.errors).toEqual([]);
      expect(receipt.entries.filter((entry) => entry.status === 'removed')).toHaveLength(2);
      expect(receipt.caps?.[0]).toMatchObject({ beforeBytes: 8192, afterBytes: 0, overByBytes: 0 });
      expect(receipt.effects?.[0]).toMatchObject({ processed: 2, remaining: 0, stopped: false,
        timings: { yieldWaitMs: 250 } });
      expect(delegate).toHaveBeenCalledOnce();
      for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { finish(); now.mockRestore(); }
  });
  it('attributes a failed FIFO reacquisition wait and preserves the unprocessed continuation', async () => {
    const { root, options } = await setup();
    const paths = [join(root, 'old-a'), join(root, 'old-b')];
    for (const path of paths) await writeFile(path, 'expired');
    let entered!: () => void, finish!: () => void, queued!: () => void, releasePeer!: () => void;
    const removing = new Promise<void>(resolve => { entered = resolve; });
    const finishRemoval = new Promise<void>(resolve => { finish = resolve; });
    const waiting = new Promise<void>(resolve => { queued = resolve; });
    const peerRelease = new Promise<void>(resolve => { releasePeer = resolve; });
    let reacquisitionQueued!: () => void;
    const reacquiring = new Promise<void>(resolve => { reacquisitionQueued = resolve; });
    let clock = Date.now(), peerEntered = false, failedWait = false, requests = 0;
    const phases: string[] = [];
    const waitFor = async <T>(pending: Promise<T>, phase: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([pending, new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`FIFO fixture stalled at ${phase}: ${phases.join(',')}`)), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    };
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    fixtureMutex.observe = phase => {
      if (phases.length < 32) phases.push(phase);
      if (phase === 'mutex-request') requests++;
      // Advance only after admission has captured its start time. A second
      // waiting notice cannot drive a frozen clock: it is itself time-throttled.
      if (phase === 'mutex-waiting' && requests === 3) reacquisitionQueued();
    };
    const reclaim = runDiskReclaimOnce({ ...options, runBudgetMs: 1_000,
      removeEntry: async entry => { entered(); await finishRemoval; await rm(entry.path); } });
    let peer: Promise<unknown> | undefined;
    try {
      await waitFor(removing, 'first removal');
      peer = withFsMutex('papercusp-disk-retention', async () => {
        peerEntered = true;
        await reacquiring;
        clock += 2_000;
        failedWait = true;
        await peerRelease;
      },
        { timeoutMs: 5_000, retryMs: 5, onWaiting: queued });
      try {
        await waitFor(waiting, 'peer queued');
        // FIFO tickets use an epoch-ms prefix plus a random tie-breaker. Give
        // reacquisition a strictly younger timestamp than the queued peer.
        clock++;
      } finally { finish(); }
      const receipt = await waitFor(reclaim, 'failed reacquisition receipt');
      expect(failedWait).toBe(true);
      expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
      expect(receipt.errors.join('; ')).toContain('waiting for fs-mutex');
      expect(receipt.effects?.[0]).toMatchObject({ processed: 1, remaining: 1, nextPath: paths[1],
        elapsedMs: 2_001, timings: { yieldWaitMs: 2_000 } });
      expect(receipt.entries.filter(entry => entry.status === 'removed')).toHaveLength(1);
      await expect(stat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(paths[1]!, 'utf8')).toBe('expired');
    } finally { finish(); reacquisitionQueued(); releasePeer(); now.mockRestore(); await Promise.allSettled([reclaim, peer]); }
  });
  it.each(['pin', 'lease'] as const)('refreshes a new %s after a FIFO handoff without repeating the census', async (kind) => {
    const { root, options } = await setup();
    const paths = [join(root, 'old-a'), join(root, 'old-b')];
    for (const path of paths) await writeFile(path, 'expired');
    let entered!: () => void, finish!: () => void, queued!: () => void;
    const inspecting = new Promise<void>((resolve) => { entered = resolve; });
    const finishCensus = new Promise<void>((resolve) => { finish = resolve; });
    const waiting = new Promise<void>((resolve) => { queued = resolve; });
    let protectedByPeer = false;
    let censusCompleted = false;
    const inspectTrees = vi.fn(async (path: string, input: Parameters<typeof inspectRetentionTrees>[1]) => {
      const result = await inspectRetentionTrees(path, input);
      // Queue the writer after native IO has completed. This fixture exercises
      // FIFO handoff and fresh protection, not a race between find's deadline
      // and the writer's shorter acquisition deadline.
      if (!input.paths) { censusCompleted = true; entered(); await finishCensus; }
      return result;
    });
    const reclaim = runDiskReclaimOnce({ ...options, inspectTrees,
      readProtection: async () => ({ paths: protectedByPeer && kind === 'lease' ? [paths[1]!] : [],
        pins: protectedByPeer && kind === 'pin' ? [{ paths: [paths[1]!], expiresAt: new Date(options.nowMs + 60_000).toISOString() }] : [] }),
      removeEntry: async (entry) => { expect(protectedByPeer).toBe(true); await rm(entry.path); },
    });
    await inspecting;
    expect(censusCompleted).toBe(true);
    const peer = withFsMutex('papercusp-disk-retention', async () => { protectedByPeer = true; },
      { timeoutMs: 5_000, retryMs: 5, onWaiting: queued });
    try { await waiting; } finally { finish(); }
    const receipt = await reclaim; await peer;
    expect(receipt.complete).toBe(true);
    expect(inspectTrees.mock.calls.filter(([, input]) => !input.paths)).toHaveLength(1);
    expect(receipt.entries.find((entry) => entry.path === paths[1])).toMatchObject({ status: 'protected', reason: 'live retention lease or pin' });
    await expect(stat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(paths[1]!, 'utf8')).toBe('expired');
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
  it.each([false, true])('persists protected census summaries without private allocation metadata (partial=%s)', async (partial) => {
    const { root, options } = await setup();
    const path = join(root, 'protected-tree'); await mkdir(path);
    const identity = await stat(path);
    const allocation = { path, dev: identity.dev, ino: identity.ino, bytes: 4096, newestWriteMs: options.nowMs,
      hardlinks: [{ dev: identity.dev, ino: identity.ino, bytes: 4096, paths: [join(path, 'shared')] }] };
    // A large real allocation graph can exceed the serializer's string limit.
    // Model that boundary without allocating hundreds of megabytes in CI.
    const serializeAllocation = vi.fn(() => { throw new RangeError('Invalid string length'); });
    Object.defineProperty(allocation, 'toJSON', { value: serializeAllocation });
    const stored: DiskReclaimReceipt[] = [];
    const sql = { unsafe: vi.fn(async (_query: string, values: unknown[]) => {
      if (values[3] === 'disk-retention:receipt') stored.push(JSON.parse(values[5] as string));
      return [];
    }) } as unknown as ReclaimSql;
    const receipt = await runDiskReclaimOnce({ ...options,
      inspectTrees: async () => ({ entries: [], retained: [{ path, reason: 'symlink boundary', entry: allocation }],
        inspectedNodes: 2, retainedRecentTrees: 0, ...(partial ? { error: 'retention native census timed out' } : {}) }),
      record: (phase, detail) => writeReclaimAudit(sql, 'fixture-workspace', 'summary-fixture', phase, detail),
    });
    expect(serializeAllocation).not.toHaveBeenCalled();
    expect(receipt.complete).toBe(!partial);
    expect(receipt.policyExhausted).toBe(partial ? null : true);
    expect(receipt.errors).toEqual(partial ? [`inspect:${root}: retention native census timed out`] : []);
    expect(receipt.entries).toEqual([{ path, reason: 'symlink boundary', classId: 'fixture', status: 'protected', bytes: 0 }]);
    expect(stored).toEqual([receipt]);
    expect(await stat(path)).toBeTruthy();
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
  it.each([undefined, inspectRetentionTrees])('preserves old live Unix sockets and FIFOs when path holder evidence is empty (%s)', async (inspectTrees) => {
    const { root, options } = await setup(); const path = join(root, 'live.sock'); const fifo = join(root, 'live.fifo');
    execFileSync('mkfifo', [fifo], { timeout: 10_000 });
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    try {
      const receipt = await runDiskReclaimOnce({ ...options, inspectTrees });
      expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
      expect(receipt.entries).toHaveLength(2);
      expect(receipt.entries).toEqual(expect.arrayContaining([path, fifo].map((entryPath) =>
        expect.objectContaining({ path: entryPath, status: 'protected', reason: 'special filesystem entry' }))));
      expect((await stat(path)).isSocket()).toBe(true);
      expect((await stat(fifo)).isFIFO()).toBe(true);
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
    expect(receipt.delegates).toMatchObject([{ classId: 'independent-owner', ok: true, detail: 'independent owner completed' }]);
    for (const path of paths) expect(await stat(path)).toBeTruthy();
  });
  it('reserves the shared run budget for later independent owners and policy census', async () => {
    const { options } = await setup();
    const started = Date.now();
    let clock = started;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const deadlines: number[] = [];
    const owners = ['first-owner', 'second-owner'].map(classId => ({
      classId, run: vi.fn(async (_dryRun: boolean, _onPhase: unknown, notAfterMs?: number) => {
        expect(notAfterMs).toBeDefined();
        deadlines.push(notAfterMs!);
        // A productive scan may consume its whole allowance. Its bounded
        // refusal must still leave the other owner and policy census runnable.
        clock = notAfterMs!;
        return { ok: false, detail: `${classId} measurement remains incomplete` };
      }),
    }));
    const inspectTrees = vi.fn(async () => {
      expect(clock).toBeLessThan(started + 90);
      return { entries: [], retained: [], inspectedNodes: 1, retainedRecentTrees: 0 };
    });
    try {
      const receipt = await runDiskReclaimOnce({ ...options, runBudgetMs: 90, delegates: owners, inspectTrees });
      expect(deadlines).toEqual([started + 30, started + 60]);
      for (const owner of owners) expect(owner.run).toHaveBeenCalledOnce();
      expect(inspectTrees).toHaveBeenCalledOnce();
      expect(receipt.delegates).toMatchObject(owners.map(({ classId }) => ({ classId, ok: false })));
      expect(receipt.complete).toBe(false);
      expect(receipt.policyExhausted).toBeNull();
      expect(receipt.errors.join(' ')).not.toContain('run budget exhausted');
    } finally { now.mockRestore(); }
  });

  it('runs independent owners when a whole-root census exhausts the run deadline', async () => {
    const { root, options } = await setup();
    const path = join(root, 'old'); await writeFile(path, 'keep on incomplete census');
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const owners = ['first-owner', 'second-owner'].map((classId) => ({
      classId, run: vi.fn(async () => ({ ok: true, detail: classId })),
    }));
    try {
      const receipt = await runDiskReclaimOnce({ ...options, runBudgetMs: 50, delegates: owners,
        inspectTrees: async () => {
          clock += 100;
          return { entries: [], retained: [], inspectedNodes: 1, retainedRecentTrees: 0,
            error: 'retention native census timed out' };
        },
      });
      expect(receipt.delegates).toMatchObject(owners.map(({ classId }) => ({ classId, ok: true, detail: classId })));
      for (const owner of owners) expect(owner.run).toHaveBeenCalledOnce();
      expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
      expect(receipt.errors).toEqual([`inspect:${root}: retention native census timed out`]);
      expect(await stat(path)).toBeTruthy();
    } finally { now.mockRestore(); }
  });
  it('persists delegate phases before the delegate ends and retains diagnostics on failure', async () => {
    const { options } = await setup();
    let observedPhase!: () => void;
    const phaseWritten = new Promise<void>(done => { observedPhase = done; });
    const progress: unknown[] = [];
    const receipt = await runDiskReclaimOnce({ ...options,
      record: async (phase, detail) => {
        if (phase !== 'progress') return;
        progress.push(detail);
        if ((detail as { delegatePhase?: string }).delegatePhase === 'holder-scan') observedPhase();
      },
      delegates: [{ classId: 'failing-owner', run: async (_dryRun, onPhase) => {
        onPhase!({ phase: 'holder-scan', stage: 'start' });
        await phaseWritten;
        throw new Error('fixture holder read failed');
      } }],
    });
    expect(receipt.complete).toBe(false);
    expect(receipt.delegates).toMatchObject([{ classId: 'failing-owner', ok: false,
      detail: 'fixture holder read failed', elapsedMs: expect.any(Number),
      phases: [{ phase: 'holder-scan', stage: 'start', observedAfterMs: expect.any(Number) }] }]);
    expect(progress.slice(0, 3)).toEqual([
      { phase: 'delegate-start', classId: 'failing-owner' },
      expect.objectContaining({ phase: 'delegate-phase', delegatePhase: 'holder-scan', stage: 'start' }),
      expect.objectContaining({ phase: 'delegate-finish', classId: 'failing-owner', ok: false }),
    ]);
  });
  it('bounds delegate phase receipts and persisted writes', async () => {
    const { options } = await setup();
    const record = vi.fn();
    const receipt = await runDiskReclaimOnce({ ...options, record,
      delegates: [{ classId: 'verbose-owner', run: async (_dryRun, onPhase) => {
        for (let i = 0; i < 100; i++) onPhase!({ phase: `phase-${i}`, stage: 'start' });
        return { ok: true, detail: 'done' };
      } }],
    });
    expect(receipt.complete, receipt.errors.join('; ')).toBe(true);
    expect(receipt.delegates[0]!.phases).toHaveLength(32);
    expect(receipt.delegates[0]!.omittedPhases).toBe(68);
    expect(record.mock.calls.filter(([phase, detail]) => phase === 'progress' && detail.phase === 'delegate-phase')).toHaveLength(32);
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
      const interrupted = { ...receipt, id: 'interrupted-scan', complete: false,
        scan: { ...receipt.scan!, stoppedAtRoot: root }, errors: ['retention native census timed out'] };
      await writeReclaimAudit(sql, 'fixture-workspace', interrupted.id, 'receipt', interrupted);
      const noScan = { ...receipt, id: 'admission-failed', complete: false, scan: undefined,
        roots: undefined, entries: [], errors: ['mutex admission failed'] };
      await writeReclaimAudit(sql, 'fixture-workspace', noScan.id, 'receipt', noScan);
      // The ledger can emit several rows in one millisecond. Make chronology
      // explicit so UUID ordering never decides this continuation regression.
      const orderedAt = Date.now();
      await sql`UPDATE harness_shared.audit_log SET ts = ${orderedAt + 1} WHERE subject = ${interrupted.id}`;
      await sql`UPDATE harness_shared.audit_log SET ts = ${orderedAt + 2} WHERE subject = ${noScan.id}`;
      expect(await readReclaimReceipt(sql, 'fixture-workspace')).toEqual(noScan);
      expect(await readReclaimReceipt(sql, 'fixture-workspace', undefined, undefined, { requireScan: true })).toEqual(interrupted);
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
