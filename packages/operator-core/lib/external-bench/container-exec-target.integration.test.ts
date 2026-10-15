/**
 * container-exec-target.integration.test.ts — benchmark-coverage-frontierswe-v2-2026-10-10 D-026 / P-006.
 *
 * Real docker, real alpine container, no network. Pins the chain psu will run:
 * resolveBackendLaunch('codex') honours the per-launch override → the generated
 * wrapper → `docker exec` → a process INSIDE the container, in the task workdir, with
 * only allowlisted env. The last case runs the static musl Codex resolved from the
 * host install, mounted where the FrontierSWE seam mounts it.
 *
 * Requires docker and the local `alpine` image (repo convention: integration suites
 * need Docker). Run: npm run test:file -- <this file>
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedNativeSandboxSpawn, NATIVE_CONTAINER_EXEC_ENV } from '@papercusp/orchestrator/fleet-srt-spawn';

import { backendBinOverrideEnvKey, resolveBackendLaunch } from '../backend-bin-resolve.mjs';
import {
  CONTAINER_CODEX_BIN_PATH,
  materializeDockerExecWrapper,
  resolveContainerCodexBinary,
} from './container-exec-target';

const containers: string[] = [];
const cleanupFailures: Array<{ containerId: string; error: string }> = [];
let root: string;

// Match the stock-native fixture's asynchronous phase diagnostics. Ending stdin
// explicitly is required for the wrapper's docker exec -i on noninteractive probes.
async function command(bin: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 30_000) {
  const phase = bin === 'docker' ? args.slice(0, 2).join(' ') : 'wrapper';
  const started = Date.now();
  console.info('CONTAINER_EXEC_PHASE', JSON.stringify({ phase, state: 'started', containerIds: containers }));
  const result = await new Promise<{ stdout: string; stderr: string; status: number | null; signal: string | null; timedOut: boolean; error: string | null }>(resolve => {
    const child = execFile(bin, args, { env, encoding: 'utf8', timeout }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, status: typeof error?.code === 'number' ? error.code : error ? null : 0,
        signal: error?.signal ?? null, timedOut: error?.killed === true || error?.code === 'ETIMEDOUT',
        error: error ? String(error) : null });
    });
    child.stdin?.end();
  });
  console.info('CONTAINER_EXEC_PHASE', JSON.stringify({ phase, state: result.error ? 'failed' : 'completed', elapsedMs: Date.now() - started,
    status: result.status, signal: result.signal, timedOut: result.timedOut, error: result.error }));
  return result;
}

async function startContainer(extra: string[] = []): Promise<string> {
  // A failed docker client can still have allocated the container. Own its name
  // before the call, so afterAll can clean a partial create without a returned id.
  const name = `container-exec-proof-${randomUUID()}`;
  containers.push(name);
  try {
    // Separate allocation from runtime startup so a deadline identifies the
    // engine operation that stalled. A combined run -d hid that distinction.
    const created = await command('docker', ['create', '--name', name, '--network', 'none', ...extra, 'alpine', 'sleep', '300']);
    expect(created.status, JSON.stringify(created)).toBe(0);
    const id = created.stdout.trim();
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    containers[containers.indexOf(name)] = id;
    const started = await command('docker', ['start', id]);
    expect(started.status, JSON.stringify(started)).toBe(0);
    return id;
  } catch (error) {
    // Preserve the exact resource state before afterAll removes a partial
    // allocation. No credentials/config are included in this diagnostic.
    const inspected = await command('docker', ['inspect', '--format', '{{json .State}}', name]);
    console.info('CONTAINER_EXEC_ALLOCATION_FAILURE', JSON.stringify({ name, inspected }));
    throw error;
  }
}

async function removeContainer(id: string, primaryError?: unknown): Promise<void> {
  const index = containers.indexOf(id);
  if (index >= 0) containers.splice(index, 1);
  try {
    const removed = await command('docker', ['rm', '-f', id]);
    expect(removed.status, JSON.stringify({ id, removed })).toBe(0);
  } catch (error) {
    cleanupFailures.push({ containerId: id, error: String(error) });
    throw primaryError === undefined ? error : new AggregateError([primaryError, error],
      'Container assertion and cleanup both failed');
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'cexec-int-'));
  const result = await command('docker', ['image', 'inspect', 'alpine']);
  expect(result.status, result.stderr).toBe(0);
});

afterAll(async () => {
  // Only partial creates remain. Each gets one bounded cleanup attempt; retain
  // earlier cleanup failures rather than retrying and overwriting their verdict.
  await Promise.allSettled([...containers].map(id => removeContainer(id)));
  // Keep fixture files on cleanup failure for inspection; Vitest retains the
  // primary assertion independently of this hook's complete cleanup verdict.
  if (cleanupFailures.length) throw new Error(JSON.stringify({ root, cleanupFailures }));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('container exec target against a live container', () => {
  it('records timeout kills as failures even when the child exits with a numeric code', async () => {
    const result = await command(process.execPath, ['-e',
      "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)"], undefined, 1_000);
    expect(result.timedOut).toBe(true);
    expect(result.error).not.toBeNull();
    expect(result.status).not.toBe(0);
  });

  it('closes stdin for noninteractive probes instead of leaving a reader alive', async () => {
    const result = await command(process.execPath, ['-e',
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('stdin-closed'))"]);
    expect(result).toMatchObject({ status: 0, signal: null, timedOut: false, stdout: 'stdin-closed' });
  });

  it.runIf(process.platform === 'linux')('executes the default wrapper across the native device namespace when TMPDIR is /dev/shm', () => {
    const previous = process.env.TMPDIR;
    let dir: string | undefined;
    try {
      process.env.TMPDIR = '/dev/shm';
      const wrapper = materializeDockerExecWrapper(
        { kind: 'docker-exec', containerId: 'private-boundary', workdir: '/app', binPath: '/bin/sh' },
        { dockerBin: '/bin/echo' },
      );
      dir = wrapper.dir;
      const result = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--',
        wrapper.wrapperPath, '--boundary-proof'], { encoding: 'utf8', timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('private-boundary /bin/sh --boundary-proof');
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveBackendLaunch picks the wrapper, which runs inside the container in the workdir', async () => {
    const cid = await startContainer();
    let primaryError: unknown;
    try {
      const { wrapperPath } = materializeDockerExecWrapper(
        { kind: 'docker-exec', containerId: cid, workdir: '/tmp', binPath: '/bin/sh' },
        { dir: mkdtempSync(join(root, 'w-')) },
      );
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        CODEX_HOME: '/codex-home-from-host',
        UNRELATED_SECRET: 'must-not-cross',
        [backendBinOverrideEnvKey('codex')]: wrapperPath,
      };
      const launch = resolveBackendLaunch('codex', { env });
      expect(launch?.bin).toBe(wrapperPath);
      const r = await command(
        launch!.bin,
        ['-c', 'pwd; hostname; printf "%s|%s\\n" "$CODEX_HOME" "${UNRELATED_SECRET:-unset}"'],
        env,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['/tmp', cid.slice(0, 12), '/codex-home-from-host|unset']);
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });

  it.runIf(process.platform === 'linux')('distinguishes a session mountpoint from a writable parent during relocation', () => {
    for (const mode of ['session-mount', 'parent-mount', 'typed-boundary']) {
      const base = mkdtempSync(join(root, 'mountpoint-'));
      const homes = join(base, 'homes'), perHomes = join(base, 'task-homes');
      const home = join(homes, 'session-7');
      mkdirSync(home, { recursive: true });
      mkdirSync(perHomes);
      writeFileSync(join(home, 'config.toml'), 'model = "fixture"\n');
      const { wrapperPath, nativeBoundary } = materializeDockerExecWrapper({ kind: 'docker-exec',
        containerId: 'namespace-proof', workdir: '/app', binPath: '/bin/echo',
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } },
      { dir: mkdtempSync(join(root, 'mount-wrapper-')), dockerBin: '/bin/echo' });
      // The scoped native boundary grants CODEX_HOME itself. Both controls have
      // writable parents; only the first makes the rename source a mountpoint.
      const env = { PATH: process.env.PATH, CODEX_HOME: home, PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
        PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }),
        PAPERCUSP_BACKEND_BIN_CODEX: wrapperPath, [NATIVE_CONTAINER_EXEC_ENV]: JSON.stringify(nativeBoundary) };
      const mounted = mode === 'session-mount' ? home : base;
      const result = mode === 'typed-boundary'
        ? createScopedNativeSandboxSpawn({ cwd: base, env, srtBin: null })!(wrapperPath, [], { cwd: base, env },
          (bin, args, options) => spawnSync(bin, args, { ...options, encoding: 'utf8', timeout: 10_000 }))
        : spawnSync('bwrap', ['--bind', '/', '/', '--bind', mounted, mounted, '--', wrapperPath],
          { encoding: 'utf8', timeout: 10_000, env });
      expect(result.error).toBeUndefined();
      if (mode === 'session-mount') {
        expect(result.status, result.stderr).toBe(126);
        expect(result.stderr).toMatch(/EBUSY.*rename/);
        expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "fixture"\n');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(perHomes, 'session-7', 'config.toml'), 'utf8')).toBe('model = "fixture"\n');
      }
    }
  });

  it('relocated session home: the container reads and writes it through a same-path per-task mount and sees no other session', async () => {
    const base = mkdtempSync(join(root, 'reloc-'));
    const homes = join(base, 'su-codex-homes'), perHomes = join(base, 'task-homes');
    const sqlite = join(base, 'codex-sqlite-homes'), perSqlite = join(base, 'task-sqlite');
    for (const d of [join(homes, 'session-7'), join(homes, 'session-8'), perHomes, perSqlite]) mkdirSync(d, { recursive: true });
    writeFileSync(join(homes, 'session-7', 'config.toml'), 'model = "frozen"\n');
    writeFileSync(join(homes, 'session-8', 'auth.json'), '{"token":"other-session"}\n');
    // The seam mounts each per-task dir over its shared root, at the same absolute path.
    const cid = await startContainer(['-v', `${perHomes}:${homes}`, '-v', `${perSqlite}:${sqlite}`]);
    let primaryError: unknown;
    try {
    const { wrapperPath, nativeBoundary } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/', binPath: '/bin/sh',
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }, { hostRoot: sqlite, perTaskDir: perSqlite }] } },
      { dir: mkdtempSync(join(root, 'r-')) },
    );
    const script = 'cat "$CODEX_HOME/config.toml"; ls "$(dirname "$CODEX_HOME")"; echo from-container > "$CODEX_HOME/rollout.jsonl"';
    const env = { PATH: process.env.PATH ?? '', CODEX_HOME: join(homes, 'session-7'), PAPERCUSP_AGENT: 'codex',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }),
      PAPERCUSP_BACKEND_BIN_CODEX: wrapperPath, [NATIVE_CONTAINER_EXEC_ENV]: JSON.stringify(nativeBoundary) };
    const boundary = createScopedNativeSandboxSpawn({ cwd: base, env })!;
    const r = await boundary(wrapperPath, ['-c', script], { cwd: base, env },
      (bin, args, options) => command(bin, args, options.env));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('model = "frozen"');
    // Only this session is visible inside the container; session-8 and its token stay on the host.
    expect(r.stdout.split('\n').filter(l => l.startsWith('session-'))).toEqual(['session-7']);
    // Host readers (rollout/usage ingest) see the container's write through the symlink.
    expect(readFileSync(join(homes, 'session-7', 'rollout.jsonl'), 'utf8')).toBe('from-container\n');
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });

  it("returns the in-container process's exit code", async () => {
    const cid = await startContainer();
    let primaryError: unknown;
    try {
    const { wrapperPath } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/', binPath: '/bin/sh' },
      { dir: mkdtempSync(join(root, 'x-')) },
    );
    const r = await command(wrapperPath, ['-c', 'exit 5'], { PATH: process.env.PATH ?? '' });
    expect(r.status).toBe(5);
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });

  it('runs the musl Codex from the host install, mounted read-only at the seam path, with no network', async () => {
    const musl = resolveContainerCodexBinary();
    const cid = await startContainer(['-v', `${musl}:${CONTAINER_CODEX_BIN_PATH}:ro`]);
    let primaryError: unknown;
    try {
    const { wrapperPath } = materializeDockerExecWrapper(
      { kind: 'docker-exec', containerId: cid, workdir: '/', binPath: CONTAINER_CODEX_BIN_PATH },
      { dir: mkdtempSync(join(root, 'c-')) },
    );
    const r = await command(wrapperPath, ['--version'], { PATH: process.env.PATH ?? '' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/codex-cli \d+\.\d+\.\d+/);
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });
});
