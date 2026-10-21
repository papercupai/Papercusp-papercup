import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TaskRow } from '../task-manager/types';
import { readGradingAuditSourcePin } from './grading-audit-source-pin';
import { ensureGradingAuditRuntime, gradingAuditRuntimeChildEnv, retireUnusedGradingAuditRuntimes, recoverGradingAuditRuntimeSource,
  type GradingAuditRuntimeDeps, type GradingAuditRuntimeLocator } from './grading-audit-runtime';

const spawnManaged = vi.hoisted(() => vi.fn());
const killManaged = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: spawnManaged }));
vi.mock('../task-manager/control', () => ({ killTask: killManaged }));

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-runtime-'));
  roots.push(root);
  const sourceRoot = join(root, '.candidate-exact.first', 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, 'exact compiled evaluator bytes');
  const evaluatorBuild = { sha: 'exact123456', version: '1.2.3' };
  const ownerRef = 'grading-audit-runtime:' + createHash('sha256').update(JSON.stringify(['ws', evaluatorBuild.sha, evaluatorBuild.version])).digest('hex');
  const source = { schemaVersion: 1 as const, sourceRoot, bundlePath, evaluatorBuild, ownerRef,
    bundleSha256: createHash('sha256').update('exact compiled evaluator bytes').digest('hex') };
  const rows: TaskRow[] = [];
  let tail = Promise.resolve();
  const stop = vi.fn(async (id: string) => { rows.find(row => row.taskId === id)!.state = 'killed'; });
  const deps: GradingAuditRuntimeDeps = {
    now: () => 1000000, currentSource: () => source, freePort: async () => 45187,
    recoverSource: (workspaceId, build, now) => recoverGradingAuditRuntimeSource(root, workspaceId, build, now),
    list: async (_ws, label) => rows.filter(row => String(row.detail.label).startsWith(label)),
    mutex: async (_ws, _key, fn) => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try { return await fn(); } finally { unlock(); }
    },
    spawn: vi.fn(async (_ws, locator) => {
      const taskId = `runtime-${rows.length}`;
      rows.unshift({ taskId, workspaceId: 'ws', rootTaskId: taskId, class: 'sidecar',
        title: ownerRef, argv: [process.execPath, bundlePath], launchedBy: 'system:grading-audit-dispatch',
        confined: true, startedAt: new Date(1000000).toISOString(), lastSeenAt: new Date(1000000).toISOString(),
        state: 'running', detail: { label: ownerRef, gradingAuditRuntime: structuredClone(locator) } });
      return taskId;
    }),
    attach: vi.fn(async (id, _ws, ids) => {
      (rows.find(row => row.taskId === id)!.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds = ids;
    }),
    probe: vi.fn(async () => evaluatorBuild), stop, sleep: async () => {},
  };
  return { root, rows, source, deps, stop, input: { workspaceId: 'ws', issueId: 'EI-a', evaluatorBuild } };
}

describe('exact grading audit runtime lifecycle (EI-25971079852455067)', () => {
  it('shares one ledger-owned endpoint across concurrent audits of the same build', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([ensureGradingAuditRuntime(f.input, f.deps),
      ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', evaluatorBuild: {
        version: f.input.evaluatorBuild.version, sha: f.input.evaluatorBuild.sha,
      } }, f.deps)]);
    expect(a.taskId).toBe(b.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)?.bundleSha256).toBe(f.source.bundleSha256);
  });

  it('rehydrates after process loss from the saved physical generation after staging advances', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows[0].state = 'ended_unobserved';
    f.deps.currentSource = () => { throw new Error('staging alias now serves a different build'); };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b', allowSeed: false }, f.deps);
    expect(recovered.taskId).not.toBe(old.taskId);
    expect(f.deps.spawn).toHaveBeenLastCalledWith('ws', expect.objectContaining({
      sourceRoot: f.source.sourceRoot, evaluatorBuild: f.input.evaluatorBuild, issueIds: ['EI-a', 'EI-b'],
    }));
  });

  it('stops an unreachable owned endpoint before replacing it, and requires exact readiness', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.probe = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(f.input.evaluatorBuild);
    const recovered = await ensureGradingAuditRuntime(f.input, f.deps);
    expect(recovered.taskId).not.toBe(old.taskId);
    expect(f.stop).toHaveBeenCalledWith(old.taskId);
  });

  it('recovers a crash between atomic pin publication and task registration', async () => {
    const f = fixture();
    f.deps.spawn = vi.fn(async () => { throw new Error('registration interrupted'); });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('registration interrupted');
    expect(f.rows).toEqual([]);
    const source = recoverGradingAuditRuntimeSource(f.root, 'ws', f.input.evaluatorBuild, 1000);
    expect(source?.issueIds).toEqual(['EI-a']);
    f.deps.currentSource = () => { throw new Error('staging advanced'); };
    f.deps.spawn = async (_ws, locator) => {
      expect(locator.sourceRoot).toBe(f.source.sourceRoot);
      return 'recovered-after-pin';
    };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps);
    expect(recovered.taskId).toBe('recovered-after-pin');
    expect(recoverGradingAuditRuntimeSource(f.root, 'foreign-ws', f.input.evaluatorBuild, 1000)).toBeNull();
  });

  it('prefers the surviving owned task over a newer terminal row and refuses unknown ownership', async () => {
    const f = fixture();
    const live = await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows.unshift({ ...structuredClone(f.rows[0]), taskId: 'newer-terminal', state: 'ended_unobserved' });
    expect((await ensureGradingAuditRuntime(f.input, f.deps)).taskId).toBe(live.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    f.rows[1].state = 'unaccounted';
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('unaccounted');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('enrolls the production child with its recovery locator, hard deadline and request-only environment', async () => {
    const f = fixture();
    f.deps.now = () => Date.now();
    delete f.deps.spawn;
    const unref = vi.fn();
    spawnManaged.mockResolvedValue({ taskId: 'managed-runtime', confined: true, child: { unref } });
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    expect(runtime.taskId).toBe('managed-runtime');
    expect(spawnManaged).toHaveBeenLastCalledWith(process.execPath, [f.source.bundlePath],
      expect.objectContaining({ class: 'sidecar', runtimeMaxSec: expect.any(Number),
        detail: { label: f.source.ownerRef, gradingAuditRuntime: expect.objectContaining({
          sourceRoot: f.source.sourceRoot, issueIds: ['EI-a'], bundleSha256: f.source.bundleSha256,
        }) } }), expect.objectContaining({ workspaceId: 'ws', requireRegistration: true,
        spawnOptions: expect.objectContaining({ detached: true, env: expect.objectContaining({ PAPERCUSP_BACKGROUND_WORKERS: '0' }) }) }));
    expect(spawnManaged.mock.calls.at(-1)?.[2].runtimeMaxSec).toBeLessThanOrEqual(21600);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('refuses an unconfined production child and terminates it before dispatch can use it', async () => {
    const f = fixture();
    f.deps.now = () => Date.now();
    delete f.deps.spawn;
    spawnManaged.mockResolvedValue({ taskId: 'unconfined', confined: false, child: { unref: vi.fn() } });
    killManaged.mockResolvedValue({ ok: true });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('confined');
    expect(killManaged).toHaveBeenCalledWith('unconfined', expect.objectContaining({ includeSubtree: true }));
    expect(f.deps.probe).not.toHaveBeenCalled();
  });

  it.each(['sha', 'version', 'unknown'] as const)('refuses %s readiness and retires the failed child', async mode => {
    const f = fixture();
    f.deps.probe = async () => mode === 'unknown' ? null : { ...f.input.evaluatorBuild, [mode]: 'wrong' };
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow(mode === 'unknown' ? 'unknown' : 'mismatch');
    expect(f.stop).toHaveBeenCalledWith('runtime-0');
  });

  it('fails closed when retained bundle bytes or recovery pins are damaged', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    f.rows[0].state = 'ended_unobserved';
    writeFileSync(f.source.bundlePath, 'different evaluator');
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).rejects.toThrow('digest');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('cannot seed an old evaluator from a newer staging host or from unknown identity', async () => {
    const f = fixture();
    await expect(ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).rejects.toThrow('No retained');
    await expect(ensureGradingAuditRuntime({ ...f.input, evaluatorBuild: { sha: null, version: '1' } }, f.deps)).rejects.toThrow('unknown');
    expect(f.deps.spawn).not.toHaveBeenCalled();
  });

  it('keeps a shared runtime until its final pending audit settles, then stops it and releases the pin', async () => {
    const f = fixture();
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps);
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids.filter(id => id === 'EI-b'), f.deps);
    expect(f.stop).not.toHaveBeenCalled();
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-b']);
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).toHaveBeenCalledWith(runtime.taskId);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('enforces bounded expiry even if a card stays pending', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.now = () => 22600000;
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids, f.deps);
    expect(f.stop).toHaveBeenCalledWith('runtime-0');
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('reuses the request-only identity and single-writer fences for the child', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
    expect(env).toMatchObject({ PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_USE_EMBEDDED_PG: '0',
      PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0', PAPERCUSP_DBOS_ORCHESTRATOR: '0',
      PAPERCUSP_PROVISION_ENV_OPERATORS: '0', PAPERCUSP_IDENTITY_MODE: 'load-only',
      PAPERCUSP_BIND_HOST: '127.0.0.1', PAPERCUSP_BUILD_SHA: f.input.evaluatorBuild.sha,
      PAPERCUSP_INTEGRATION_ROOT: f.source.sourceRoot, PAPERCUSP_HONO_PORT: '45187' });
  });
});
