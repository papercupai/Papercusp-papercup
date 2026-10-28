import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import * as databaseTargets from '@papercusp/db-org/connection';
import type { TaskRow } from '../task-manager/types';
import { readGradingAuditSourcePin } from './grading-audit-source-pin';
import { requestOnlyIdentityGuardMarker } from '../harness/env-operator-launcher';
import { writeOperatorArtifactManifest } from './operator-artifact';
import { ensureGradingAuditRuntime, gradingAuditRuntimeChildEnv, retireUnusedGradingAuditRuntimes, recoverGradingAuditRuntimeSource,
  qualifyRematerializedGradingAuditSource, gradingAuditRuntimeSupervisorArgs,
  type GradingAuditRuntimeDeps, type GradingAuditRuntimeLocator } from './grading-audit-runtime';

const spawnManaged = vi.hoisted(() => vi.fn());
const killManaged = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: spawnManaged }));
vi.mock('../task-manager/control', () => ({ killTask: killManaged }));

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());

function fixture(evaluatorBuild = { sha: 'exact123456', version: '1.2.3' }) {
  const root = mkdtempSync(join(tmpdir(), 'audit-runtime-'));
  roots.push(root);
  const sourceRoot = join(root, '.candidate-exact.first', 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(bundlePath), { recursive: true });
  writeFileSync(bundlePath, 'exact compiled evaluator bytes');
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
    attach: vi.fn(async (id, _ws, ids, acceptanceRefs = []) => {
      (rows.find(row => row.taskId === id)!.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds = ids;
      (rows.find(row => row.taskId === id)!.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).acceptanceRefs = acceptanceRefs;
    }),
    probe: vi.fn(async () => evaluatorBuild), stop, sleep: async () => {},
  };
  return { root, rows, source, deps, stop, input: { workspaceId: 'ws', issueId: 'EI-a', evaluatorBuild } };
}

function rebuiltFixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-rebuilt-'));
  roots.push(root);
  const sourceRoot = join(root, '.candidate-rebuilt', 'checkout');
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  mkdirSync(dirname(bundlePath), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(sourceRoot, 'entry.ts'), 'export const evaluator = true;\n');
  git('add', 'entry.ts');
  git('-c', 'user.name=Runtime test', '-c', 'user.email=runtime@test.invalid', 'commit', '--quiet', '-m', 'exact source');
  const sourceSha = git('rev-parse', 'HEAD');
  writeFileSync(bundlePath, 'rebuilt evaluator ' + requestOnlyIdentityGuardMarker());
  writeFileSync(bundlePath + '.meta.json', JSON.stringify({ inputs: { 'entry.ts': {} } }));
  writeOperatorArtifactManifest({ root: sourceRoot, entry: bundlePath, sourceSha });
  return { sourceRoot, bundlePath, sourceSha, git, evaluatorBuild: { sha: sourceSha.slice(0, 10), version: '1.2.3' } };
}

describe('retained evaluator self-recycle supervision (EI-26950964476692806)', () => {
  async function launch(body: string, lifetimeSec = 60) {
    const f = fixture();
    writeFileSync(f.source.bundlePath, body);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        server.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const locator: GradingAuditRuntimeLocator = { ...f.source,
      bundleSha256: createHash('sha256').update(body).digest('hex'),
      baseUrl: `http://127.0.0.1:${port}`, issueIds: ['EI-a'],
      expiresAtSec: Math.floor(Date.now() / 1000) + lifetimeSec };
    const child = spawn(process.execPath, gradingAuditRuntimeSupervisorArgs(locator), {
      cwd: f.source.sourceRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), PAPERCUSP_BUILD_SHA: f.input.evaluatorBuild.sha,
        PAPERCUSP_ENV_OPERATOR_ID: f.source.ownerRef },
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      try { return await closed; } finally { clearTimeout(timer); }
    };
    return { ...f, locator, child, closed, stop, output: () => output };
  }

  it('recovers a real self-SIGKILL on the same exact endpoint and stops without respawning on retirement', async () => {
    const run = await launch(`import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
let attempt = 1;
try { attempt += Number(readFileSync('attempt', 'utf8')); } catch {}
writeFileSync('attempt', String(attempt));
createServer((_req, res) => res.end(JSON.stringify({ sha: process.env.PAPERCUSP_BUILD_SHA,
  identity: process.env.PAPERCUSP_ENV_OPERATOR_ID, pid: process.pid, attempt })))
  .listen(Number(process.env.PORT), '127.0.0.1', () => {
    console.log('READY ' + attempt);
    if (attempt === 1) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20);
  });`);
    let servingPid = 0;
    try {
      await vi.waitFor(() => expect(run.output()).toContain('READY 2'), { timeout: 6000 });
      const response = await fetch(run.locator.baseUrl, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      expect(health).toMatchObject({ sha: run.input.evaluatorBuild.sha, identity: run.source.ownerRef, attempt: 2 });
      servingPid = health.pid;
      expect(await run.stop()).toEqual({ code: 0, signal: null });
      expect(readFileSync(join(run.source.sourceRoot, 'attempt'), 'utf8')).toBe('2');
      expect(() => process.kill(servingPid, 0)).toThrow();
    } finally { await run.stop(); }
  }, 12000);

  it('enforces its absolute deadline and never starts an already expired evaluator', async () => {
    const expired = await launch("console.log('CHILD_STARTED'); setInterval(() => {}, 1000);", -1);
    try {
      expect(await expired.closed).toEqual({ code: 0, signal: null });
      expect(expired.output()).not.toContain('CHILD_STARTED');
    } finally { await expired.stop(); }
    const run = await launch("console.log('CHILD_STARTED'); setInterval(() => {}, 1000);", 5);
    try {
      expect(await run.closed).toEqual({ code: 0, signal: null });
      expect(run.output()).toContain('CHILD_STARTED');
      expect(run.output()).toContain('deadline');
    } finally { await run.stop(); }
  }, 15000);

  it('halts repeated short crashes instead of spinning until its lifetime expires', async () => {
    const run = await launch("console.log('CRASH'); process.exit(42);");
    try {
      expect(await run.closed).toEqual({ code: 1, signal: null });
      expect(run.output().split('CRASH').length - 1).toBe(5);
      expect(run.output()).toContain('restart budget exhausted');
    } finally { await run.stop(); }
  }, 10000);

  it('refuses changed bundle bytes before restarting a recycled child', async () => {
    const run = await launch(`import { writeFileSync } from 'node:fs';
console.log('ORIGINAL');
writeFileSync(process.argv[1], "console.log('CHANGED_EXECUTED')");
process.kill(process.pid, 'SIGKILL');`);
    try {
      expect(await run.closed).toEqual({ code: 1, signal: null });
      expect(run.output()).toContain('bundle digest changed');
      expect(run.output()).not.toContain('CHANGED_EXECUTED');
    } finally { await run.stop(); }
  }, 10000);
});

describe('exact grading audit runtime lifecycle (EI-25971079852455067)', () => {
  it('retains a settled audit evaluator for claimed source acceptance and releases it when acceptance settles', async () => {
    const f = fixture();
    const runtime = await ensureGradingAuditRuntime({ ...f.input, acceptanceRef: 'WI-source' }, f.deps);
    f.deps.pendingAcceptanceRefs = async (_ws, ids) => ids.filter(id => id === 'WI-source');
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).not.toHaveBeenCalled();
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator)).toMatchObject({
      issueIds: [], acceptanceRefs: ['WI-source'] });
    f.deps.pendingAcceptanceRefs = async () => [];
    await retireUnusedGradingAuditRuntimes('ws', async () => [], f.deps);
    expect(f.stop).toHaveBeenCalledWith(runtime.taskId);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).toBeNull();
  });

  it('recovers an expired, physically deleted source from an attested exact-ref rebuild with new artifact provenance', async () => {
    const rebuilt = rebuiltFixture();
    const f = fixture(rebuilt.evaluatorBuild);
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.now = () => 22600000;
    await retireUnusedGradingAuditRuntimes('ws', async ids => ids, f.deps);
    rmSync(dirname(f.source.sourceRoot), { recursive: true, force: true });
    f.deps.currentSource = () => { throw new Error('mutable host cannot seed the old build'); };
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'P001-acceptance',
      allowSeed: false, recoverySourceRoot: rebuilt.sourceRoot }, f.deps);
    expect(recovered.taskId).not.toBe(old.taskId);
    expect(recovered.bundleSha256).not.toBe(old.bundleSha256);
    expect(recovered.sourceRecovery).toMatchObject({ sourceSha: rebuilt.sourceSha, previousTaskId: old.taskId,
      previousSourceRoot: f.source.sourceRoot, previousBundleSha256: old.bundleSha256 });
    expect(recovered.expiresAtSec).toBe(22600 + 21600);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'P001-acceptance']);
    expect(readGradingAuditSourcePin(rebuilt.sourceRoot, f.source.ownerRef, 22600)?.bundleSha256).toBe(recovered.bundleSha256);
    // Repeated acquisition returns the same receipt under the same build mutex.
    expect((await ensureGradingAuditRuntime({ ...f.input, allowSeed: false }, f.deps)).sourceRecovery).toEqual(recovered.sourceRecovery);
  });

  it('refuses a rebuild without ledger provenance and never replaces a live task with a missing pin', async () => {
    const rebuilt = rebuiltFixture();
    const f = fixture(rebuilt.evaluatorBuild);
    await expect(ensureGradingAuditRuntime({ ...f.input, recoverySourceRoot: rebuilt.sourceRoot }, f.deps))
      .rejects.toThrow('registered prior');
    await ensureGradingAuditRuntime(f.input, f.deps);
    rmSync(dirname(f.source.sourceRoot), { recursive: true, force: true });
    await expect(ensureGradingAuditRuntime({ ...f.input, recoverySourceRoot: rebuilt.sourceRoot }, f.deps))
      .rejects.toThrow('no valid recovery locator');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses wrong commits, dirty source, missing artifact proof and replaced bundle bytes', () => {
    const rebuilt = rebuiltFixture();
    expect(qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild).sourceSha).toBe(rebuilt.sourceSha);
    expect(() => qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, { ...rebuilt.evaluatorBuild, sha: 'f'.repeat(10) }))
      .toThrow('differs');
    writeFileSync(join(rebuilt.sourceRoot, 'entry.ts'), 'dirty source');
    expect(() => qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild)).toThrow('source-unqualified');
    writeFileSync(join(rebuilt.sourceRoot, 'entry.ts'), 'export const evaluator = true;\n');
    writeFileSync(rebuilt.bundlePath, 'replacement ' + requestOnlyIdentityGuardMarker());
    expect(() => qualifyRematerializedGradingAuditSource(rebuilt.sourceRoot, rebuilt.evaluatorBuild)).toThrow('artifact proof');
  });

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

  it('preserves the enrolled runtime and references when live endpoint readiness is unknown', async () => {
    const f = fixture();
    const old = await ensureGradingAuditRuntime(f.input, f.deps);
    f.deps.probe = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(f.input.evaluatorBuild);
    await expect(ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps)).rejects.toThrow('readiness is unknown');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
    const recovered = await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-c' }, f.deps);
    expect(recovered.taskId).toBe(old.taskId);
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b', 'EI-c']);
  });

  it('retains a newly enrolled warming runtime after the readiness window and reuses it once ready', async () => {
    const f = fixture();
    f.deps.probe = vi.fn().mockResolvedValue(null);
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('readiness is unknown');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.rows[0].state).toBe('running');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).not.toBeNull();
    f.deps.probe = vi.fn().mockResolvedValue(f.input.evaluatorBuild);
    expect((await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps)).taskId).toBe('runtime-0');
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    expect((f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-a', 'EI-b']);
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
    const logDir = join(f.root, 'persistent-task-logs');
    f.deps.logDir = logDir;
    const unref = vi.fn();
    spawnManaged.mockResolvedValue({ taskId: 'managed-runtime', confined: true, child: { unref } });
    const runtime = await ensureGradingAuditRuntime(f.input, f.deps);
    expect(runtime.taskId).toBe('managed-runtime');
    expect(spawnManaged).toHaveBeenLastCalledWith(process.execPath,
      gradingAuditRuntimeSupervisorArgs(spawnManaged.mock.calls.at(-1)![2].detail.gradingAuditRuntime),
      expect.objectContaining({ class: 'sidecar', runtimeMaxSec: expect.any(Number),
        detail: { label: f.source.ownerRef, gradingAuditRuntime: expect.objectContaining({
          sourceRoot: f.source.sourceRoot, issueIds: ['EI-a'], bundleSha256: f.source.bundleSha256,
        }) } }), expect.objectContaining({ workspaceId: 'ws', requireRegistration: true,
        spawnOptions: expect.objectContaining({ detached: true, env: expect.objectContaining({ PAPERCUSP_BACKGROUND_WORKERS: '0' }) }) }));
    expect(spawnManaged.mock.calls.at(-1)?.[2].runtimeMaxSec).toBeLessThanOrEqual(21600);
    expect(unref).toHaveBeenCalledOnce();
    const logPath = spawnManaged.mock.calls.at(-1)?.[2].logPath as string | undefined;
    expect(logPath).toContain(logDir);
    expect(logPath).not.toContain(f.source.sourceRoot);
    writeFileSync(logPath!, 'runtime output survives candidate pruning\n');
    rmSync(join(f.root, '.candidate-exact.first'), { recursive: true, force: true });
    expect(readFileSync(logPath!, 'utf8')).toBe('runtime output survives candidate pruning\n');
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

  it.each(['sha', 'version'] as const)('refuses %s readiness and retires the mismatched child', async mode => {
    const f = fixture();
    f.deps.probe = async () => ({ ...f.input.evaluatorBuild, [mode]: 'wrong' });
    await expect(ensureGradingAuditRuntime(f.input, f.deps)).rejects.toThrow('mismatch');
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

  it('targeted cleanup bypasses an unrelated runtime mutex and preserves pending siblings', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    await ensureGradingAuditRuntime({ ...f.input, issueId: 'EI-b' }, f.deps);
    const live = f.rows[0];
    const locator = live.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
    f.rows.push({ ...live, taskId: 'prior-runtime', state: 'ended_unobserved',
      detail: { ...live.detail, gradingAuditRuntime: { ...locator, issueIds: ['EI-a'] } } });
    const unrelatedLabel = 'grading-audit-runtime:unrelated';
    f.rows.push({ ...live, taskId: 'unrelated-runtime',
      detail: { label: unrelatedLabel,
        gradingAuditRuntime: { ...locator, ownerRef: unrelatedLabel, issueIds: ['EI-other'] } } });
    f.deps.mutex = async (_workspace, key, fn) => {
      if (key === unrelatedLabel) throw new Error('unrelated runtime mutex is held');
      return fn();
    };

    await retireUnusedGradingAuditRuntimes('ws', async ids => ids.filter(id => id === 'EI-b'), f.deps, ['EI-a']);

    expect(f.stop).not.toHaveBeenCalled();
    expect((live.detail.gradingAuditRuntime as GradingAuditRuntimeLocator).issueIds).toEqual(['EI-b']);
    expect(readGradingAuditSourcePin(f.source.sourceRoot, f.source.ownerRef, 1000)).not.toBeNull();
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

  it('pins resolved parent database targets when the immutable child has no operator env file', async () => {
    const f = fixture();
    await ensureGradingAuditRuntime(f.input, f.deps);
    const admin = 'postgresql://parent_admin:private@127.0.0.1:15432/parent';
    const app = 'postgresql://parent_app:private@127.0.0.1:15432/parent';
    vi.spyOn(databaseTargets, 'adminUrl').mockReturnValue(admin);
    vi.spyOn(databaseTargets, 'appUrl').mockReturnValue(app);
    const env = gradingAuditRuntimeChildEnv(f.rows[0].detail.gradingAuditRuntime as GradingAuditRuntimeLocator);
    expect(env).toMatchObject({ DATABASE_URL: admin, HARNESS_ADMIN_DATABASE_URL: admin,
      HARNESS_DATABASE_URL: app, PAPERCUSP_DATABASE_URL: admin,
      PAPERCUSP_INTEGRATION_ROOT: f.source.sourceRoot });
  });
});
