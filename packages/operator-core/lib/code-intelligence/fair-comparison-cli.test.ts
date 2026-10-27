import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildArm, createFairWorkerChannel, fairProcessCensus, fairWorkerCompletion, FAIR_ARM_IDS, frozenGraphRequest, indexFileCensus, loadFairInputs, materializeFrozenControls,
  FAIR_WORKER_RUNTIME_MAX_SEC, materializeFrozenRepositoryTask, measureFairToolPayload, prepareFrozenControl, validateFrozenInputs, verifyFrozenSource,
  fairScopeKernelTasks, stopFairWorker, verifyFairWorkerSource, workspaceDirs, type FrozenFairInputs } from './fair-comparison-cli';

// Transitive users can mock only their own subprocess seam. Importing the CLI's
// helpers must not read/promisify the absent execFile before an actual CLI run.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
// The engines have their own conformance suites. Isolate their subprocess graph
// so a different engine's eager wrapper cannot hide this CLI import regression.
vi.mock('./fair-comparison-arms', () => ({
  createRgFairArm: vi.fn(() => ({ capabilities: { armId: 'rg' } })),
}));
vi.mock('./fair-comparison-engines', () => ({}));
vi.mock('./fair-comparison-first-party', () => ({}));

// P-017 (D-011..D-016): each arm's tree gets node_modules/<name> links built from the
// root `workspaces`. workspaceDirs is the expansion; a pattern it cannot expand would
// silently drop links and make cross-package answers look like engine misses.

const root = mkdtempSync(join(tmpdir(), 'p017-ws-'));
const pkg = (dir: string, name = dir.replace(/\//g, '-')) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }));
};
pkg('apps/operator');
pkg('apps/operator-checkpoint');
pkg('packages/a');
pkg('packages/b');
mkdirSync(join(root, 'packages/no-manifest'), { recursive: true });
writeFileSync(join(root, 'packages/README.md'), 'not a package');
pkg('libs/exact');
mkdirSync(join(root, 'libs/exact-missing-manifest'), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('workspaceDirs', () => {
  it('expands a trailing /* to the child dirs that hold a package.json', async () => {
    expect((await workspaceDirs(root, ['packages/*'])).sort()).toEqual(['packages/a', 'packages/b']);
  });

  it('keeps an exact dir only when it holds a package.json', async () => {
    expect(await workspaceDirs(root, ['libs/exact', 'libs/exact-missing-manifest', 'apps/operator'])).toEqual(['libs/exact', 'apps/operator']);
  });

  it('treats a missing /* parent as empty rather than throwing', async () => {
    expect(await workspaceDirs(root, ['nowhere/*', 'packages/a'])).toEqual(['packages/a']);
  });

  it('applies exclusions regardless of order and deduplicates overlapping inclusions', async () => {
    expect(await workspaceDirs(root, ['apps/*', '!apps/*-checkpoint', 'apps/operator'])).toEqual(['apps/operator']);
    expect(await workspaceDirs(root, ['!apps/*-checkpoint', 'apps/*'])).toEqual(['apps/operator']);
    expect(await workspaceDirs(root, ['!apps/*-checkpoint'])).toEqual([]);
  });

  it('resolves the real root workspace inclusions while honoring its exclusions', async () => {
    const repo = resolve(__dirname, '../../../..');
    const { workspaces = [] } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { workspaces?: string[] };
    expect(workspaces.length).toBeGreaterThan(0);
    const dirs = await workspaceDirs(repo, workspaces);
    expect(dirs).toContain('apps/operator');
    expect(dirs.some(dir => /^apps\/.*-checkpoint$/.test(dir))).toBe(false);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const p of workspaces.filter(pattern => !pattern.startsWith('!'))) {
      expect(await workspaceDirs(repo, [p]), p).not.toEqual([]);
    }
  });
});

describe('FAIR_ARM_IDS', () => {
  it('names the eight arms the preregistration froze', () => {
    expect([...FAIR_ARM_IDS].sort()).toEqual(['codebase-memory', 'codegraph', 'codegraphcontext', 'gitnexus', 'lsp-query', 'no-third-party', 'rg', 'trace-mcp']);
  });

  it('allows slow frozen-corpus graph indexes to outlive the former four-hour cap', () => {
    expect(FAIR_WORKER_RUNTIME_MAX_SEC).toBe(8 * 3600);
  });
});

describe('kernel task scope reads', () => {
  const scope = '/user.slice/pc-worker.scope';
  const error = (code: string) => Object.assign(new Error(code), { code });

  it.each(['0', '3\n'])('reads the hierarchical kernel task counter %j', text => {
    const fs = { readFile: vi.fn(() => text), isDirectory: vi.fn(() => true) };
    expect(fairScopeKernelTasks(scope, fs)).toBe(Number(text));
    expect(fs.readFile).toHaveBeenCalledWith(`/sys/fs/cgroup${scope}/pids.current`);
    expect(fs.isDirectory).not.toHaveBeenCalled();
  });

  it.each(['', '-1', '1.5', 'invalid', '9007199254740992'])('keeps an invalid counter %j unknown', text => {
    expect(fairScopeKernelTasks(scope, { readFile: () => text, isDirectory: () => true })).toBeNull();
  });

  it('accepts collection only from positive directory ENOENT', () => {
    const fs = { readFile: () => { throw error('ENOENT'); },
      isDirectory: vi.fn(() => { throw error('ENOENT'); }) };
    expect(fairScopeKernelTasks(scope, fs)).toBe(0);
    expect(fs.isDirectory).toHaveBeenCalledWith(`/sys/fs/cgroup${scope}`);
  });

  it.each(['present', 'EACCES', 'EIO'])('keeps a missing counter in a %s directory unknown', state => {
    expect(fairScopeKernelTasks(scope, { readFile: () => { throw error('ENOENT'); },
      isDirectory: () => { if (state !== 'present') throw error(state); return true; } })).toBeNull();
  });

  it.each(['/', '/../foreign', '/user.slice/./foreign'])('refuses unsafe or root scope %j without reading', path => {
    const fs = { readFile: vi.fn(), isDirectory: vi.fn() };
    expect(fairScopeKernelTasks(path, fs)).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});

describe('fresh worker cleanup', () => {
  it.each([
    { task: { ok: false as const, taskId: 'worker-task', action: 'kill' as const,
      error: 'incomplete' as const, detail: 'Descendant cleanup failed for child-task: 1 process remained' },
    scope: null },
    { task: { ok: false as const, taskId: 'worker-task', action: 'kill' as const,
      error: 'not_live' as const, detail: 'terminal row with a confined scope' },
    scope: { ok: false as const, scopeUnit: 'pc-worker.scope', action: 'kill' as const,
      error: 'command_failed' as const, detail: 'scope resolution failed' } },
  ])('preserves both controller outcomes when cleanup refuses ($task.error)', async ({ task, scope }) => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-controller-refusal-'));
    const killScopeUnit = vi.fn().mockResolvedValue(scope);
    const readKernelTasks = vi.fn(() => 0);
    try {
      const error = await stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        exited: Promise.resolve(), owned, cgroupPaths: ['/user.slice/pc-worker.scope'] },
      async () => ({ killTask: vi.fn().mockResolvedValue(task), killScopeUnit }), readKernelTasks)
        .then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('isolated files retained');
      expect((error as Error).message).toContain(task.detail);
      if (scope) expect((error as Error).message).toContain(scope.detail);
      expect((error as Error).cause).toEqual({ task, scope });
      expect(killScopeUnit).toHaveBeenCalledTimes(scope ? 1 : 0);
      expect(readKernelTasks).not.toHaveBeenCalled();
      expect(existsSync(owned)).toBe(true);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it.each([1, null])('retains evidence after successful close receipts when observed kernel tasks are %s', async kernelTasks => {
    vi.useFakeTimers();
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-kernel-drain-'));
    const workerScope = '/user.slice/pc-worker.scope', serverScope = '/user.slice/pc-server.scope';
    const readKernelTasks = vi.fn((path: string) => path === workerScope ? 0 : kernelTasks);
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        exited: Promise.resolve(), completion: async () => ({ status: 'recorded' }), owned,
        cgroupPaths: [workerScope, serverScope] }, async () => ({
        killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn(),
      }), readKernelTasks);
      const refused = expect(stopped).rejects.toThrow('kernel task drain deadline; isolated files retained');
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(readKernelTasks).toHaveBeenCalledWith(serverScope);
      expect(existsSync(owned)).toBe(true);
    } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
  });

  it('keeps files until every observed scope drains without signalling an independent scope', async () => {
    vi.useFakeTimers();
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-kernel-drain-'));
    const workerScope = '/user.slice/pc-worker.scope', serverScope = '/user.slice/pc-server.scope';
    const killScopeUnit = vi.fn();
    let kernelTasks = 3;
    const readKernelTasks = vi.fn((path: string) => path === workerScope ? 0 : kernelTasks);
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        exited: Promise.resolve(), completion: async () => ({ status: 'recorded' }), owned,
        cgroupPaths: [workerScope, serverScope, serverScope] }, async () => ({
        killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit,
      }), readKernelTasks);
      await vi.advanceTimersByTimeAsync(500);
      expect(readKernelTasks).toHaveBeenCalledWith(serverScope);
      expect(existsSync(owned)).toBe(true);
      kernelTasks = 0;
      await vi.advanceTimersByTimeAsync(25);
      await stopped;
      expect(existsSync(owned)).toBe(false);
      expect(killScopeUnit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
  });

  it('shares the ten second deadline across pipe close, terminal write, and kernel drain', async () => {
    vi.useFakeTimers();
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-kernel-drain-'));
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope', owned,
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: new Promise<void>(done => setTimeout(done, 6_000)),
        completion: () => new Promise(done => setTimeout(() => done({ status: 'recorded' }), 3_000)),
      }, async () => ({ killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn() }), () => 1);
      const refused = expect(stopped).rejects.toThrow('kernel task drain deadline; isolated files retained');
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(existsSync(owned)).toBe(true);
    } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
  });

  it('retains files when a registered worker has no measured scope paths', async () => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-kernel-drain-'));
    try {
      await expect(stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        exited: Promise.resolve(), owned }, async () => ({
        killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn(),
      }))).rejects.toThrow('kernel task scopes unavailable; isolated files retained');
      expect(existsSync(owned)).toBe(true);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it('accepts the exact durable terminal row when another writer wins the close', async () => {
    const completion = async () => ({ status: 'unavailable' as const, reason: 'terminal write did not update the row' });
    await expect(fairWorkerCompletion({ taskId: 'worker-task', workspaceId: 'test-workspace',
      scopeUnit: 'pc-worker.scope', completion }, async () => ({ taskId: 'worker-task',
      workspaceId: 'test-workspace', scopeUnit: 'pc-worker.scope', state: 'killed', endedAt: '2026-10-23T03:00:00Z' })))
      .resolves.toEqual({ status: 'recorded' });
  });

  it('does not reinterpret a missing, live or foreign terminal row as recorded', async () => {
    const outcome = { status: 'unavailable' as const, reason: 'controlled missing receipt' };
    const task = { taskId: 'worker-task', workspaceId: 'test-workspace', scopeUnit: 'pc-worker.scope',
      state: 'killed' as const, endedAt: '2026-10-23T03:00:00Z' };
    for (const row of [null, { ...task, taskId: 'foreign' }, { ...task, workspaceId: 'foreign' },
      { ...task, scopeUnit: 'pc-foreign.scope' }, { ...task, state: 'running' as const }, { ...task, endedAt: null }]) {
      await expect(fairWorkerCompletion({ taskId: task.taskId, workspaceId: task.workspaceId,
        scopeUnit: task.scopeUnit, completion: async () => outcome }, async () => row)).resolves.toBe(outcome);
    }
  });

  it.each([{ ok: true }, { ok: false, error: 'already_gone' }])(
    'removes private files only after scope proof when the client never closes (%j)', async outcome => {
      vi.useFakeTimers();
      const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
      const killTask = vi.fn().mockResolvedValue({ ok: true });
      const killScopeUnit = vi.fn().mockResolvedValue(outcome);
      try {
        const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
          cgroupPaths: ['/user.slice/pc-worker.scope'],
          exited: new Promise<void>(() => {}), owned }, async () => ({ killTask, killScopeUnit }));
        const completed = expect(stopped).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(10_000);
        await completed;
        expect(killTask).toHaveBeenCalledWith('worker-task',
          { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
        expect(killScopeUnit).toHaveBeenCalledWith('pc-worker.scope', { escalateAfterMs: 500 });
        expect(existsSync(owned)).toBe(false);
      } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
    });

  it('retains private files when a missing close event has no successful scope proof', async () => {
    vi.useFakeTimers();
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
    const killTask = vi.fn().mockResolvedValue({ ok: true });
    const killScopeUnit = vi.fn().mockResolvedValue({ ok: false, error: 'permission_denied' });
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: new Promise<void>(() => {}), owned }, async () => ({ killTask, killScopeUnit }));
      const refused = expect(stopped).rejects.toThrow('failed to drain; isolated files retained');
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(killScopeUnit).toHaveBeenCalledOnce();
      expect(existsSync(owned)).toBe(true);
    } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
  });

  it('cleans a normally closed worker without the missing-close fallback', async () => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
    const killTask = vi.fn().mockResolvedValue({ ok: true });
    const killScopeUnit = vi.fn();
    try {
      await stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: Promise.resolve(), owned }, async () => ({ killTask, killScopeUnit }));
      expect(killScopeUnit).not.toHaveBeenCalled();
      expect(existsSync(owned)).toBe(false);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it('retains private evidence after pipe close until the managed terminal write finishes', async () => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
    let recorded!: (value: { status: 'recorded' }) => void;
    const terminal = new Promise<{ status: 'recorded' }>(done => { recorded = done; });
    const completion = vi.fn(() => terminal);
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: Promise.resolve(), completion, owned }, async () => ({
        killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn(),
      }));
      await vi.waitFor(() => expect(completion).toHaveBeenCalledOnce());
      expect(existsSync(owned)).toBe(true);
      recorded({ status: 'recorded' });
      await stopped;
      expect(existsSync(owned)).toBe(false);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it.each(['delegated', 'unavailable'] as const)('retains private evidence for a %s terminal write', async status => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
    try {
      await expect(stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: Promise.resolve(), completion: async () => ({ status, reason: 'controlled terminal failure' }), owned },
      async () => ({ killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn() })))
        .rejects.toThrow(`terminal persistence ${status}`);
      expect(existsSync(owned)).toBe(true);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });

  it('bounds a missing terminal receipt and retains private evidence', async () => {
    vi.useFakeTimers();
    const owned = mkdtempSync(join(tmpdir(), 'fair-worker-cleanup-'));
    try {
      const stopped = stopFairWorker({ taskId: 'worker-task', scopeUnit: 'pc-worker.scope',
        cgroupPaths: ['/user.slice/pc-worker.scope'],
        exited: Promise.resolve(), completion: () => new Promise(() => {}), owned },
      async () => ({ killTask: vi.fn().mockResolvedValue({ ok: true }), killScopeUnit: vi.fn() }));
      const refused = expect(stopped).rejects.toThrow('terminal persistence deadline; isolated files retained');
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(existsSync(owned)).toBe(true);
    } finally { vi.useRealTimers(); rmSync(owned, { recursive: true, force: true }); }
  });
});

describe('CLI import without execFile', () => {
  it('constructs an arm without starting a subprocess under a narrow mock', async () => {
    expect((await buildArm('rg')).capabilities.armId).toBe('rg');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses mixed worker contracts before launch and propagates unreadable provenance', async () => {
    const read = vi.fn(async (path: string, version: 'working' | 'committed') =>
      version === 'working' && path.endsWith('fair-comparison-run.ts') ? 'new-contract' : 'committed-contract');
    await expect(verifyFairWorkerSource(read)).rejects.toThrow(
      /differs from committed child.*git-sync:await.*end the editing turn.*containing commit.*lint:as-committed/);
    expect(spawn).not.toHaveBeenCalled();
    await expect(verifyFairWorkerSource(async () => 'same-contract')).resolves.toBeUndefined();
    await expect(verifyFairWorkerSource(async () => { throw new Error('git source unavailable'); }))
      .rejects.toThrow('git source unavailable');
  });
});

describe('logical index file census', () => {
  it('keeps source and dependency baseline files apart from newly created index/cache files', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'fair-index-census-'));
    try {
      const source = join(isolated, 'source.ts');
      writeFileSync(source, 'export const source = 1;');
      expect(await indexFileCensus([isolated], new Set([source]))).toEqual([]);
      mkdirSync(join(isolated, 'cache'));
      const index = join(isolated, 'cache', 'index');
      writeFileSync(index, '1234567');
      expect(await indexFileCensus([isolated], new Set([source]))).toEqual([{ path: index, bytes: 7 }]);
    } finally { rmSync(isolated, { recursive: true, force: true }); }
  });
  it('returns unknown for incomplete paths, rather than an apparently measured empty index', async () => {
    expect(await indexFileCensus([join(root, 'missing-index-root')], new Set())).toBeNull();
  });
});

describe('fresh task point process census', () => {
  const taskId = 'aaa123', cgroupPath = '/user.slice/pc-aaa123.scope';
  const absolute = `/sys/fs/cgroup${cgroupPath}`;
  const expected = { taskId, cgroupPath, rootPid: 10, rootIdentity: 'linux:boot:10' };
  const fixture = () => ({
    fs: {
      readFile: (path: string) => path === `${absolute}/cgroup.procs` ? '10\n11\n' :
        path === `${absolute}/child/cgroup.procs` ? '12\n' : '999\n',
      readDir: (path: string) => path === absolute ? ['child', 'cgroup.procs', 'pids.current'] : [],
      isDir: (path: string) => path === absolute || path === `${absolute}/child`,
    },
    identity: (pid: number) => `linux:boot:${pid}`,
    cgroup: (pid: number) => pid === 12 ? `${cgroupPath}/child` : cgroupPath,
  });

  it('counts process leaders across child scopes, excludes the worker and ignores thread counters', () => {
    const deps = fixture();
    const read = vi.spyOn(deps.fs, 'readFile');
    const census = fairProcessCensus(expected, deps);
    expect(census.childProcesses).toBe(2);
    expect(census.processes.map(row => row.pid)).toEqual([10, 11, 12]);
    expect(census.unknown).toEqual([]);
    expect(read.mock.calls.some(([path]) => path.endsWith('/pids.current'))).toBe(false);
    expect(census).not.toHaveProperty('peakChildProcesses');
  });

  it('refuses foreign scopes and changed worker identity before reading their population', () => {
    for (const changed of [{ ...expected, taskId: 'bbb123' }, { ...expected, rootIdentity: 'linux:boot:old' }]) {
      const deps = fixture(), read = vi.spyOn(deps.fs, 'readFile');
      expect(fairProcessCensus(changed, deps).childProcesses).toBeNull();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('keeps unreadable and malformed child branches unknown instead of counting an empty branch', () => {
    for (const missing of [null, '12\ninvalid\n']) {
      const deps = fixture(), read = deps.fs.readFile;
      const census = fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
        readFile: path => path === `${absolute}/child/cgroup.procs` ? missing : read(path) } });
      expect(census.childProcesses).toBeNull();
      expect(census.unknown).toContain(`unreadable-process-census:${absolute}/child/cgroup.procs`);
    }
    const deps = fixture();
    expect(fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
      readDir: () => { throw new Error('denied'); } } }).childProcesses).toBeNull();
  });

  it('rejects population changes, PID replacement and processes that escape their task scope', () => {
    const deps = fixture(), read = deps.fs.readFile;
    let reads = 0;
    const changing = fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
      readFile: path => path === `${absolute}/cgroup.procs` && ++reads > 1 ? '10\n' : read(path) } });
    expect(changing.childProcesses).toBeNull();
    expect(changing.unknown).toContain('cgroup-population-changed-during-census');
    let identities = 0;
    const replaced = fairProcessCensus(expected, { ...deps,
      identity: pid => pid === 11 && ++identities > 1 ? 'linux:boot:new' : deps.identity(pid) });
    expect(replaced.childProcesses).toBeNull();
    expect(replaced.unknown).toContain('process-replaced-during-census:11');
    const escaped = fairProcessCensus(expected, { ...deps,
      cgroup: pid => pid === 12 ? `${cgroupPath}-foreign` : cgroupPath });
    expect(escaped.childProcesses).toBeNull();
    expect(escaped.unknown).toContain('process-outside-worker-cgroup:12');
  });
});

describe('saved native protocol inputs and worker controls', () => {
  const frozenPath = new URL('../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json', import.meta.url);
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as FrozenFairInputs;
  const control = (state: string, configuration = 'configured') => frozen.cases.find(kase =>
    kase.language === 'typescript' && kase.intent === 'callers' && kase.source === 'authored' &&
    kase.subject === 'target' && kase.sourceState === state && kase.configuration === configuration)!;

  it('refuses changed native questions and text-search topology substitution before dispatch', () => {
    const kase = frozen.cases.find(candidate => candidate.id === 'native-real-javascript-definition-main')!;
    expect(frozenGraphRequest(kase, frozen)).toMatchObject({ op: 'symbol', paths: [kase.anchorFile] });
    expect(() => frozenGraphRequest({ ...kase, subject: 'unregistered' }, frozen)).toThrow(/differs from frozen/);
    expect(() => frozenGraphRequest(frozen.cases.find(candidate =>
      candidate.id === 'native-real-javascript-text-search-main')!, frozen)).toThrow(/does not cover text-search/);
  });

  it('loads all saved cases and keys without generating or rewriting preregistration', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fair-frozen-input-'));
    try {
      const original = readFileSync(frozenPath, 'utf8');
      const loaded = await loadFairInputs(out, frozenPath.pathname);
      expect(loaded.cases).toHaveLength(143);
      expect(loaded.keys).toHaveLength(143);
      expect(loaded.preregistration.hash).toBe(frozen.preregistration.hash);
      expect(readFileSync(frozenPath, 'utf8')).toBe(original);
      expect(existsSync(join(out, 'prereg.json'))).toBe(false);
      writeFileSync(join(out, 'prereg.json'), JSON.stringify(frozen.preregistration));
      await expect(loadFairInputs(out)).rejects.toThrow(/requires --frozen/);
      await expect(loadFairInputs(out, frozenPath.pathname)).resolves.toEqual(frozen);
      writeFileSync(join(out, 'prereg.json'), JSON.stringify({ ...frozen.preregistration, seed: 1 }));
      await expect(loadFairInputs(out, frozenPath.pathname)).rejects.toThrow(/differs from frozen/);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('refuses changed questions, keys, fixture bytes and unsafe file paths before materialization', async () => {
    expect(() => validateFrozenInputs({ ...frozen, cases: frozen.cases.slice(1) })).toThrow(/cases or keys/);
    expect(() => validateFrozenInputs({ ...frozen, keys: frozen.keys.slice(1) })).toThrow(/cases or keys/);
    const path = control('current').anchorFile!;
    expect(() => validateFrozenInputs({ ...frozen, controlFiles: { ...frozen.controlFiles, [path]: 'changed' } }))
      .toThrow(/fixture hash/);
    for (const unsafe of ['../escape.ts', '/escape.ts', 'folder/../escape.ts', 'folder\\escape.ts']) {
      expect(() => validateFrozenInputs({ ...frozen, controlFiles: { ...frozen.controlFiles, [unsafe]: 'bad' } }))
        .toThrow(/path or bytes/);
    }
    expect(() => validateFrozenInputs({ ...frozen, sourcePins: [] })).toThrow(/source custody/);
    expect(() => validateFrozenInputs({ ...frozen, sourcePins: frozen.sourcePins.map(pin =>
      ({ ...pin, commit: '0'.repeat(40) })) })).toThrow(/source custody/);
  });

  it('refuses a donor with mismatched pinned source bytes before starting a worker', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-source-custody-'));
    try {
      const pin = frozen.sourcePins[0]!;
      mkdirSync(join(tree, pin.path, '..'), { recursive: true });
      writeFileSync(join(tree, pin.path), 'a changed source at a plausible snapshot path');
      await expect(verifyFrozenSource(tree, frozen)).rejects.toThrow(`source mismatch: ${pin.path}`);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it('refuses changed real-task questions and source bytes before writing a replay file', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-repository-task-'));
    const kase = frozen.cases.find(candidate => candidate.source === 'repository-task')!;
    try {
      await expect(materializeFrozenRepositoryTask(tree, { ...kase, subject: 'changed' }, frozen, 'wrong'))
        .rejects.toThrow(/differs from frozen question/);
      await expect(materializeFrozenRepositoryTask(tree, kase, frozen, 'wrong source at the right path'))
        .rejects.toThrow(/source differs from frozen pin/);
      await expect(materializeFrozenRepositoryTask(tree, control('current'), frozen, 'authored'))
        .rejects.toThrow(/differs from frozen question/);
      expect(existsSync(join(tree, kase.anchorFile!))).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it('indexes original bytes, removes configuration, mutates or deletes source, then restores the next control', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-control-worker-'));
    try {
      const kase = control('current'), path = kase.anchorFile!, source = frozen.controlFiles[path]!;
      const config = join(tree, 'native-controls/typescript/tsconfig.json');
      await materializeFrozenControls(tree, frozen);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
      const current = await prepareFrozenControl(tree, kase, frozen);
      const unconfigured = await prepareFrozenControl(tree, control('current', 'unconfigured'), frozen);
      expect(existsSync(config)).toBe(false);
      expect(unconfigured?.configurationFiles.map(file => file.hash)).toEqual([null]);
      const stale = await prepareFrozenControl(tree, control('stale'), frozen);
      expect(existsSync(config)).toBe(true);
      expect(stale?.originalSourceHash).toBe(current?.currentSourceHash);
      expect(stale?.currentSourceHash).not.toBe(stale?.originalSourceHash);
      expect(readFileSync(join(tree, path), 'utf8')).not.toContain('return target()');
      expect((await prepareFrozenControl(tree, control('deleted'), frozen))?.currentSourceHash).toBeNull();
      expect(existsSync(join(tree, path))).toBe(false);
      expect((await prepareFrozenControl(tree, kase, frozen))?.currentSourceHash).toBe(current?.currentSourceHash);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
      await expect(prepareFrozenControl(tree, { ...kase, subject: 'changed' }, frozen)).rejects.toThrow(/differs from frozen/);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });
});

describe('raw native tool token witnesses', () => {
  it('binds exact tokenizer counts to preserved Unicode requests and refusal responses', async () => {
    const request = { name: '日本語 🦀', limit: 20 };
    const response = { error: 'unsupported language', sites: [] };
    const witness = await measureFairToolPayload(request, response);
    const { getEncoding } = await import('js-tiktoken');
    const encoder = getEncoding('o200k_base');
    expect(witness).toMatchObject({ encoding: 'o200k_base', scope: 'raw-tool-payload-only',
      requestTokens: encoder.encode(JSON.stringify(request)).length,
      responseTokens: encoder.encode(JSON.stringify(response)).length,
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
      responseBytes: Buffer.byteLength(JSON.stringify(response)) });
    expect(witness.requestTokens).not.toBe(witness.requestBytes / 4);
    expect(witness.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(witness.responseHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = await measureFairToolPayload(request, { error: null, sites: [] });
    expect(changed.requestHash).toBe(witness.requestHash);
    expect(changed.responseHash).not.toBe(witness.responseHash);
    expect(changed.responseTokens).not.toBe(witness.responseTokens);
  });

  it('refuses absent JSON bytes instead of manufacturing a zero-token measurement', async () => {
    await expect(measureFairToolPayload(undefined, {})).rejects.toThrow(/JSON representation/);
    await expect(measureFairToolPayload({}, undefined)).rejects.toThrow(/JSON representation/);
  });
});

describe('fresh worker channel', () => {
  // P-026 R-7: one overrun query used to throw out of the arm and discard the
  // lsp-query and no-third-party runs. It is a scored outcome, and the worker
  // is still busy with it, so the next request must wait for the late reply.
  const kase = (id: string) => ({ id }) as unknown as Parameters<ReturnType<typeof createFairWorkerChannel>['query']>[0];
  const flush = (ms = 0) => new Promise(done => setTimeout(done, ms));
  function channelUnderTest(deadlineMs: number, drainCapMs: number,
    observe?: Parameters<typeof createFairWorkerChannel>[0]['observe']) {
    const sent: Array<{ id: number; method: string }> = [];
    let clock = 0;
    const channel = createFairWorkerChannel({
      send: (line, done) => { sent.push(JSON.parse(line)); done(null); },
      isLive: () => true, deadlineMs: () => deadlineMs, drainCapMs, now: () => (clock += 5), observe,
    });
    const reply = (id: number, body: { result?: unknown; error?: string }) =>
      channel.receive(`FAIR_WORKER_REPLY=${JSON.stringify({ id, ...body })}`);
    return { channel, sent, reply };
  }

  it('scores an overrun query timed-out and sends nothing more until the late reply frees the worker', async () => {
    const { channel, sent, reply } = channelUnderTest(20, 5_000);
    await expect(channel.query(kase('slow'))).resolves.toEqual({
      caseId: 'slow', status: 'timed-out', sites: [], latencyMs: 5, detail: 'fresh worker query deadline' });
    const next = channel.query(kase('next'));
    await flush(40);
    expect(sent.map(request => request.id)).toEqual([1]);
    reply(1, { result: { caseId: 'slow', status: 'answered', sites: [], latencyMs: 90_000 } });
    await flush();
    expect(sent.map(request => [request.id, request.method])).toEqual([[1, 'query'], [2, 'query']]);
    reply(2, { result: { caseId: 'next', status: 'answered', sites: [], latencyMs: 3 } });
    await expect(next).resolves.toEqual({ caseId: 'next', status: 'answered', sites: [], latencyMs: 3 });
  });

  it('fails the repetition loudly when an overrun worker never frees up', async () => {
    const observe = vi.fn();
    const { channel, sent } = channelUnderTest(10, 30, observe);
    await channel.query(kase('stuck'));
    await expect(channel.query(kase('after'))).rejects.toThrow(
      'fresh worker still busy 30ms after a request deadline (request=1 method=query case=stuck)');
    expect(sent).toHaveLength(1);
    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      { event: 'send', requestId: 1, method: 'query', caseId: 'stuck' },
      { event: 'deadline', requestId: 1, method: 'query', caseId: 'stuck' },
      { event: 'drain-failed', requestId: 1, method: 'query', caseId: 'stuck' },
    ]);
  });

  it('attributes a late reply to its original case before reporting the next request', async () => {
    const observe = vi.fn();
    const { channel, reply } = channelUnderTest(10, 1_000, observe);
    await channel.query(kase('slow'));
    const next = channel.rpc('identity');
    reply(1, { result: {} });
    await flush();
    reply(2, { result: { pid: 42 } });
    await expect(next).resolves.toEqual({ pid: 42 });
    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      { event: 'send', requestId: 1, method: 'query', caseId: 'slow' },
      { event: 'deadline', requestId: 1, method: 'query', caseId: 'slow' },
      { event: 'reply', requestId: 1, method: 'query', caseId: 'slow' },
      { event: 'send', requestId: 2, method: 'identity', caseId: null },
      { event: 'reply', requestId: 2, method: 'identity', caseId: null },
    ]);
  });

  it('keeps worker-reported and transport failures as errors, never a scored timeout', async () => {
    const { channel, reply } = channelUnderTest(1_000, 1_000);
    const reported = channel.query(kase('crash'));
    await flush();
    reply(1, { error: 'worker query before frozen source indexing' });
    await expect(reported).rejects.toThrow('worker query before frozen source indexing');
    const exited = channel.query(kase('exit'));
    await flush();
    channel.failAll(new Error('fresh worker exited'));
    await expect(exited).rejects.toThrow('fresh worker exited');
  });
});
