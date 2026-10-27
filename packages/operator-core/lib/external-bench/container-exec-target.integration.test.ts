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
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createScopedNativeSandboxSpawn, NATIVE_CONTAINER_EXEC_ENV } from '@papercusp/orchestrator/fleet-srt-spawn';
import { codexSessionFrameObserved, resolveLinuxCodexStartupPid } from '../../../../apps/operator/scripts/psu-pty-host.mjs';
import { codexContainerProcessForPty, codexNativeIdForPty, codexThreadWriterHolder, ensureCodexHomeViaOperator } from '../../../../apps/operator/scripts/psu-launcher.mjs';

import { backendBinOverrideEnvKey, resolveBackendLaunch } from '../backend-bin-resolve.mjs';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../inference-gateway/codex-cli-bridge';
import { startBenchEgress } from './bench-egress';
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

async function startContainer(extra: string[] = [], network = 'none'): Promise<string> {
  // A failed docker client can still have allocated the container. Own its name
  // before the call, so afterAll can clean a partial create without a returned id.
  const name = `container-exec-proof-${randomUUID()}`;
  containers.push(name);
  try {
    // Separate allocation from runtime startup so a deadline identifies the
    // engine operation that stalled. A combined run -d hid that distinction.
    const created = await command('docker', ['create', '--name', name, '--network', network, ...extra, 'alpine', 'sleep', '300']);
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
  const daemon = await command('docker', ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}']);
  expect(daemon.status, JSON.stringify(daemon)).toBe(0);
  expect(daemon.stdout.trim()).not.toBe('');
  console.info('CONTAINER_EXEC_DAEMON_PROOF', JSON.stringify({
    explicitHost: !!process.env.DOCKER_HOST, identity: daemon.stdout.trim(),
  }));
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
  it.runIf(process.platform === 'linux').each(['host', 'root'] as const)('binds the exact Docker native writer to its host wrapper PTY (%s)', async user => {
    const base = mkdtempSync(join(root, 'native-writer-'));
    const homes = join(base, 'homes'), home = join(homes, 'session-1'), perHomes = join(base, 'task-homes');
    mkdirSync(home, { recursive: true }); mkdirSync(perHomes);
    writeFileSync(join(home, 'config.toml'), [
      'model = "gpt-6-luna"', 'model_provider = "offline"', 'web_search = "disabled"',
      '[features]', 'apps = false', 'plugins = false', 'remote_plugin = false',
      '[model_providers.offline]', 'name = "No provider fixture"',
      'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"',
      'requires_openai_auth = false', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n'), { mode: 0o600 });
    const cid = await startContainer(['--user', user === 'root' ? '0' : `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${perHomes}:${homes}`, '-v', `${resolveContainerCodexBinary()}:${CONTAINER_CODEX_BIN_PATH}:ro`]);
    let primaryError: unknown, writerWrapper: string | undefined;
    try {
      const name = user === 'root' ? await command('docker', ['inspect', '--format', '{{.Name}}', cid]) : undefined;
      if (name) expect(name.status, JSON.stringify(name)).toBe(0);
      const containerId = name ? name.stdout.trim().replace(/^\//, '') : cid;
      const { wrapperPath, nativeBoundary } = materializeDockerExecWrapper({ kind: 'docker-exec', containerId,
        workdir: '/tmp', binPath: CONTAINER_CODEX_BIN_PATH,
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } },
      { dir: mkdtempSync(join(root, 'writer-wrapper-')) });
      writerWrapper = wrapperPath;
      const env = { PATH: process.env.PATH, CODEX_HOME: home, TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9', PAPERCUSP_BACKEND_BIN_CODEX: wrapperPath,
        PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:9', token: 'a'.repeat(32) }),
        [NATIVE_CONTAINER_EXEC_ENV]: JSON.stringify(nativeBoundary) };
      const child = createRequire(import.meta.url)('@lydell/node-pty').spawn(wrapperPath,
        ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
        { env, cwd: base, cols: 120, rows: 30 });
      const proof = await new Promise<{ sessionId: string | null; nativeId: string | null; startupPid: number | null; holderPid: number | null; output: string }>((resolve, reject) => {
        let output = '', probes = '', submitted = false, finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearInterval(poll); clearTimeout(deadline); clearTimeout(enter);
          try {
          const containerProof = codexContainerProcessForPty(env, child.pid);
          const nativeId = codexNativeIdForPty(home, child.pid, { env });
          // The host-user case also has an independent global-lock oracle;
          // root's private directory is intentionally unreadable to the host.
          const holder = user === 'host' ? codexThreadWriterHolder(home, null)
            : { sessionId: nativeId, pid: containerProof?.pid };
          const result = { sessionId: holder.sessionId, holderPid: holder.pid,
            nativeId, startupPid: resolveLinuxCodexStartupPid(child.pid), output };
          if (!error) {
            expect(codexNativeIdForPty(home, child.pid + 1, { env })).toBeNull();
            const receipt = `${wrapperPath}.native-${child.pid}.json`, saved = readFileSync(receipt, 'utf8');
            try {
              writeFileSync(receipt, JSON.stringify({ ...JSON.parse(saved), start: 'stale' }));
              expect(codexNativeIdForPty(home, child.pid, { env })).toBeNull();
            } finally { writeFileSync(receipt, saved); }
            const source = readFileSync(wrapperPath, 'utf8');
            try {
              writeFileSync(wrapperPath, source + '\n');
              expect(codexNativeIdForPty(home, child.pid, { env })).toBeNull();
            } finally { writeFileSync(wrapperPath, source); }
          }
          if (error) reject(error); else resolve(result);
          } catch (failure) { reject(failure); }
          finally { child.kill('SIGTERM'); data.dispose(); }
        };
        let enter: ReturnType<typeof setTimeout>;
        const poll = setInterval(() => { if (codexNativeIdForPty(home, child.pid, { env })) finish(); }, 250);
        const deadline = setTimeout(() => finish(new Error(`Native writer did not appear: ${output}`)), 20_000);
        const data = child.onData((chunk: string) => {
          output = (output + chunk).slice(-32768); probes += chunk;
          if (probes.includes('\x1b[6n')) child.write('\x1b[1;1R');
          probes = probes.slice(-3);
          if (!submitted && codexSessionFrameObserved(output, { dims: { cols: 120, rows: 30 } })) {
            submitted = true; child.write('offline writer identity');
            enter = setTimeout(() => child.write('\r'), 100);
          }
        });
        child.onExit(() => { if (!finished) finish(new Error(`Native exited before writer proof: ${output}`)); });
      });
      console.info('NATIVE_CONTAINER_WRITER_PROOF', JSON.stringify(proof));
      expect(proof.sessionId, proof.output).toMatch(/^[a-f0-9-]{36}$/);
      expect(proof.holderPid).toBeGreaterThan(0);
      expect(proof.nativeId).toBe(proof.sessionId);
    } catch (error) { primaryError = error; throw error; }
    finally {
      try {
        if (writerWrapper) {
          const handback = await command(writerWrapper, ['--papercusp-return-session-ownership'],
            { PATH: process.env.PATH, CODEX_HOME: home });
          expect(handback.status, JSON.stringify(handback)).toBe(0);
        }
      } finally { await removeContainer(cid, primaryError); }
    }
  }, 90_000);

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
    'restores the carry route after private native config replacement without touching sibling sessions', async () => {
    const base = mkdtempSync(join(root, 'carry-handback-'));
    const homes = join(base, 'homes'), mounted = join(base, 'mounted'), home = join(homes, 'session-7');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(mounted, 'session-8'), { recursive: true });
    const config = 'model = "fixture-model"\n';
    writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 });
    const cid = await startContainer(['-v', `${mounted}:${homes}`]);
    let primaryError: unknown;
    try {
      const { wrapperPath, nativeBoundary } = materializeDockerExecWrapper({ kind: 'docker-exec', containerId: cid,
        workdir: '/', binPath: '/bin/true',
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: mounted }] } },
      { dir: mkdtempSync(join(root, 'carry-wrapper-')) });
      const env = { ...process.env, PAPERCUSP_AGENT: 'codex', CODEX_HOME: home,
        PAPERCUSP_SU_CODEX_HOMES_DIR: homes, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
        PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto', PAPERCUSP_BACKEND_BIN_CODEX: wrapperPath,
        PAPERCUSP_NATIVE_CONTAINER_EXEC: JSON.stringify(nativeBoundary),
        PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:9', token: 'a'.repeat(32) }) };
      const launched = await command(wrapperPath, [], env);
      expect(launched.status, JSON.stringify(launched)).toBe(0);
      const replaced = await command('docker', ['exec', '-u', '0', cid, 'sh', '-c',
        'cp "$1/config.toml" "$1/config.next" && chmod 600 "$1/config.next" && mv "$1/config.next" "$1/config.toml" && touch "$2/private"',
        'sh', home, join(homes, 'session-8')]);
      expect(replaced.status, JSON.stringify(replaced)).toBe(0);
      expect(() => readFileSync(join(home, 'config.toml'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
      const inode = statSync(join(home, 'config.toml')).ino;
      const failures: unknown[] = [];
      let requests = 0;
      const repaired = await ensureCodexHomeViaOperator('su-carry-handback', home, 7, {
        env, operatorUrl: 'http://127.0.0.1:9', routeMode: 'auto', onFailure: failure => { failures.push(failure); },
        fetchImpl: async () => {
          requests++;
          // Return ownership before operator IO, preserving private bytes/mode
          // and the native writer's inode. No sibling session is handed back.
          expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
          expect(statSync(join(home, 'config.toml'))).toMatchObject({ uid: process.getuid!(), ino: inode });
          expect(statSync(join(home, 'config.toml')).mode & 0o777).toBe(0o600);
          expect(statSync(join(mounted, 'session-8', 'private')).uid).toBe(0);
          return { status: 200, ok: true, json: async () => ({ ok: true, repaired: false }) };
        },
      });
      expect({ repaired, failures, requests }).toMatchObject({ repaired: { ok: true }, failures: [], requests: 1 });
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('model_provider = "papercusp-codex-gateway"');
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });
  it.runIf(process.platform === 'linux').each(['directory', 'repository'] as const)(
    'reaches the native Codex composer in the trusted container workdir before kickoff (%s)', async checkoutKind => {
    const base = mkdtempSync(join(root, 'native-trust-'));
    const homes = join(base, 'homes'), perHomes = join(base, 'task-homes');
    const home = join(homes, 'session-1'), checkout = join(base, 'checkout');
    for (const dir of [home, perHomes, checkout]) mkdirSync(dir, { recursive: true });
    if (checkoutKind === 'repository') {
      const initialized = await command('git', ['init', '-q', '--initial-branch=main', checkout]);
      expect(initialized.status, JSON.stringify(initialized)).toBe(0);
      // Match managed carry's repository-backed /app. An empty directory can
      // reach the composer without consulting project trust at all.
      const imported = spawnSync('git', ['-C', checkout, 'fast-import', '--quiet'], { encoding: 'utf8',
        input: 'blob\nmark :1\ndata 7\nbefore\n\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 answer.txt\n\ndone\n' });
      expect(imported.status, imported.stderr).toBe(0);
      const reset = await command('git', ['-C', checkout, 'reset', '--hard', 'HEAD']);
      expect(reset.status, JSON.stringify(reset)).toBe(0);
    }
    writeFileSync(join(home, 'config.toml'), [
      'model = "gpt-6-luna"', 'model_provider = "private-trust"', 'web_search = "disabled"',
      '[features]', 'apps = false', 'plugins = false', 'remote_plugin = false',
      '[projects."/observer-checkout"]', 'trust_level = "trusted"',
      '[model_providers.private-trust]', 'name = "Offline trust fixture"',
      'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"',
      'requires_openai_auth = false', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join('\n'), { mode: 0o600 });
    const cid = await startContainer(['--user', `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${checkout}:/app`, '-v', `${perHomes}:${homes}`,
      '-v', `${resolveContainerCodexBinary()}:${CONTAINER_CODEX_BIN_PATH}:ro`]);
    let primaryError: unknown;
    try {
      const { wrapperPath } = materializeDockerExecWrapper({ kind: 'docker-exec', containerId: cid,
        workdir: '/app', binPath: CONTAINER_CODEX_BIN_PATH,
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } },
      { dir: mkdtempSync(join(root, 'trust-wrapper-')) });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CODEX_HOME: home, TERM: 'xterm-256color' };
      const child = createRequire(import.meta.url)('@lydell/node-pty').spawn(wrapperPath,
        ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
        { env, cwd: base, cols: 120, rows: 30 });
      const result = await new Promise<{ output: string; frame: boolean; exitCode: number }>((resolve, reject) => {
        let output = '', probes = '', frame = false;
        const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
        const cleanupTimer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native trust TUI did not terminate')); }, 22_000);
        const data = child.onData((chunk: string) => {
          output = (output + chunk).slice(-65536);
          probes += chunk;
          if (probes.includes('\x1b[6n')) child.write('\x1b[1;1R');
          probes = probes.slice(-3);
          if (!frame && codexSessionFrameObserved(output, { dims: { cols: 120, rows: 30 } })) {
            frame = true;
            child.kill('SIGTERM');
          }
        });
        child.onExit(({ exitCode }: { exitCode: number }) => {
          clearTimeout(timer); clearTimeout(cleanupTimer); data.dispose();
          resolve({ output, frame, exitCode });
        });
      });
      console.info('NATIVE_CONTAINER_TRUST_PROOF', JSON.stringify({ checkoutKind, ...result }));
      expect(result.frame, result.output).toBe(true);
      expect(result.output.replace(/\s+/g, '')).not.toContain('Trustthisfolder?');
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  }, 90_000);

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

  it('stock Claude admission rejects inherited controls and retains declared overrides in real Docker', async () => {
    const cid = await startContainer(['-e', 'CLAUDE_CODE_EXTRA_BODY=IMAGE_SECRET_SENTINEL',
      '-e', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=0', '-e', 'VIRTUAL_ENV=/task/venv']);
    try {
      const probe = { kind: 'docker-exec' as const, containerId: cid, workdir: '/tmp', binPath: '/bin/sh' };
      const denied = materializeDockerExecWrapper(probe, { dir: mkdtempSync(join(root, 'claude-denied-')),
        guardClaudeEnv: true, forwardEnvPatterns: ['^CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS$'] });
      const env = { PATH: process.env.PATH, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
      const rejected = await command(denied.wrapperPath, ['-c', 'echo CLI_STARTED'], env);
      expect(rejected.status, rejected.stderr).toBe(126);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('CLAUDE_CODE_EXTRA_BODY');
      expect(rejected.stderr).not.toContain('IMAGE_SECRET_SENTINEL');
      const admitted = materializeDockerExecWrapper(probe, { dir: mkdtempSync(join(root, 'claude-admitted-')),
        guardClaudeEnv: true, forwardEnvPatterns: ['^CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS$', '^CLAUDE_CODE_EXTRA_BODY$'] });
      const accepted = await command(admitted.wrapperPath,
        ['-c', 'printf "%s|%s|%s" "$CLAUDE_CODE_EXTRA_BODY" "$CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" "$VIRTUAL_ENV"'],
        { ...env, CLAUDE_CODE_EXTRA_BODY: 'declared-body' });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toBe('declared-body|1|/task/venv');
    } finally { await removeContainer(cid); }
  });

  it.each([
    { label: 'managed settings file', setup: `mkdir -p /etc/claude-code && printf '%s' '{"env":{"CLAUDE_CODE_EXTRA_BODY":"POLICY_SECRET_SENTINEL"}}' > /etc/claude-code/managed-settings.json`, user: '0' },
    { label: 'dangling policy symlink', setup: 'ln -s /missing-managed-policy /etc/claude-code', user: '0' },
    { label: 'inaccessible policy parent', setup: 'chmod 000 /etc', user: '65534:65534' },
  ])('stock Claude admission rejects managed policy before the CLI starts ($label)', async ({ setup, user }) => {
    const cid = await startContainer(['--user', user]);
    try {
      const prepared = await command('docker', ['exec', '-u', '0', cid, '/bin/sh', '-c', setup]);
      expect(prepared.status, prepared.stderr).toBe(0);
      const { wrapperPath } = materializeDockerExecWrapper({ kind: 'docker-exec', containerId: cid,
        workdir: '/tmp', binPath: '/bin/sh' }, { dir: mkdtempSync(join(root, 'claude-policy-')), guardClaudeEnv: true });
      const result = await command(wrapperPath, ['-c', 'printf "%s" "$1"', 'sentinel', 'CLI_STARTED'],
        { PATH: process.env.PATH });
      expect(result.status, result.stderr).toBe(126);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('stock Claude managed policy');
      expect(result.stderr).not.toContain('POLICY_SECRET_SENTINEL');
    } finally { await removeContainer(cid); }
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
    expect(r.stdout.split('\n').filter((l: string) => l.startsWith('session-'))).toEqual(['session-7']);
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

  it('preserves the git submission diff and opaque session carry across wrapper recreation', async () => {
    const base = mkdtempSync(join(root, 'resume-'));
    const checkout = join(base, 'checkout');
    const homes = join(base, 'homes'), perHomes = join(base, 'task-homes');
    const home = join(homes, 'session-7');
    for (const dir of [checkout, home, perHomes]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model = "frozen"\n');
    writeFileSync(join(checkout, 'answer.txt'), 'before\n');
    // Git owns only this disposable fixture. No operation touches the shared checkout.
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git('init', '--quiet');
    git('add', 'answer.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture base');
    const head = git('rev-parse', 'HEAD');
    const carry = '{"type":"compacted","encrypted_content":"opaque-session-context"}\n';
    const cid = await startContainer(['-v', `${checkout}:/app`, '-v', `${perHomes}:${homes}`]);
    let primaryError: unknown;
    try {
      const target = { kind: 'docker-exec' as const, containerId: cid, workdir: '/app', binPath: '/bin/sh',
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } };
      const env = { PATH: process.env.PATH ?? '', CODEX_HOME: home };
      const first = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'before-resume-')) });
      const written = await command(first.wrapperPath, ['-c',
        'test "$PWD" = /app && printf "after\\n" > answer.txt && printf "%s" "$1" > "$CODEX_HOME/rollout.jsonl"',
        'carry-fixture', carry,
      ], env);
      expect(written.status, written.stderr).toBe(0);
      expect(readFileSync(join(home, 'rollout.jsonl'), 'utf8')).toBe(carry);
      const diff = git('diff', '--', 'answer.txt');
      expect(diff).toContain('-before\n+after');
      rmSync(first.dir, { recursive: true, force: true });

      // A fresh wrapper must reuse the relocated home and original task checkout.
      const resumed = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'after-resume-')) });
      const read = await command(resumed.wrapperPath, ['-c',
        'test "$PWD" = /app && test "$(cat answer.txt)" = after && cat "$CODEX_HOME/rollout.jsonl"',
      ], env);
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout).toBe(carry);
      expect(readFileSync(join(home, 'rollout.jsonl'), 'utf8')).toBe(carry);
      expect(readFileSync(join(perHomes, 'session-7', 'rollout.jsonl'), 'utf8')).toBe(carry);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('diff', '--', 'answer.txt')).toBe(diff);
    } catch (error) { primaryError = error; throw error; }
    finally { await removeContainer(cid, primaryError); }
  });

  it('delivers minted managed carry to a fresh native container session and resumes its git checkpoint', async () => {
    const { mintCarryRespawnArgs } = await import('../../../../apps/operator/scripts/psu-launcher.mjs');
    const base = mkdtempSync(join(root, 'native-carry-'));
    const checkout = join(base, 'checkout'), homes = join(base, 'homes'), perHomes = join(base, 'task-homes');
    const home = join(homes, 'session-7');
    const carryRoot = join(base, '.papercusp');
    // Docker creates an absent bind source as root, regardless of --user.
    // Establish host custody before allocation and verify it again before minting.
    for (const dir of [checkout, home, perHomes, carryRoot]) mkdirSync(dir, { recursive: true });
    expect(statSync(carryRoot).uid).toBe(process.getuid!());
    writeFileSync(join(checkout, 'answer.txt'), 'before\n');
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git('init', '--quiet'); git('add', 'answer.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
      'commit', '--quiet', '-m', 'fixture base');
    const head = git('rev-parse', 'HEAD');
    const requests: Array<Record<string, unknown>> = [];
    const provider = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Scripted protocol output only; this listener has no credentials or forwarding path.
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: String(body.model),
        text: 'Private native carry protocol acknowledgement.', inputTokens: 100, outputTokens: 8 })));
    });
    await new Promise<void>((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
    const port = (provider.address() as { port: number }).port;
    let egress: Awaited<ReturnType<typeof startBenchEgress>> | undefined;
    let lease: Awaited<ReturnType<NonNullable<typeof egress>['openTaskNetwork']>> | undefined;
    let cid: string | undefined;
    let primaryError: unknown;
    try {
      egress = await startBenchEgress({ runId: `native-carry-${randomUUID()}`,
        endpoints: [{ name: 'gw', listenPort: 8788, perTask: true }] });
      lease = await egress.openTaskNetwork('carry');
      egress.bindTaskEndpoint(lease.network, 'gw', port);
      writeFileSync(join(home, 'AGENTS.md'), 'Private container carry fixture. Preserve the task checkout.\n');
      writeFileSync(join(home, 'config.toml'), [
        'model = "gpt-6-luna"', 'model_provider = "private-carry"', 'web_search = "disabled"',
        '[features]', 'apps = false', 'plugins = false', 'remote_plugin = false',
        '[model_providers.private-carry]', 'name = "Unpaid local protocol fixture"',
        `base_url = "${egress.originFor('gw')}/v1"`, 'wire_api = "responses"',
        'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', '',
      ].join('\n'));
      cid = await startContainer(['--user', `${process.getuid!()}:${process.getgid!()}`,
        '-v', `${checkout}:/app`, '-v', `${perHomes}:${homes}`,
        '-v', `${carryRoot}:${carryRoot}:ro`,
        '-v', `${resolveContainerCodexBinary()}:${CONTAINER_CODEX_BIN_PATH}:ro`], lease.network);
      const target = { kind: 'docker-exec' as const, containerId: cid, workdir: '/app', binPath: CONTAINER_CODEX_BIN_PATH,
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } };
      const env = { PATH: process.env.PATH ?? '', CODEX_HOME: home };
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
      const predecessorOnly = `predecessor-only-${randomUUID()}`;
      const first = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'native-before-')) });
      const prepared = await command(first.wrapperPath, [...args, predecessorOnly], env, 60_000);
      expect(prepared.status, JSON.stringify(prepared)).toBe(0);
      const sessionId = (output: string) => {
        const started = output.split('\n').find(line => {
          try { return JSON.parse(line).type === 'thread.started'; } catch { return false; }
        });
        expect(started, output).toBeDefined();
        return JSON.parse(started!).thread_id as string;
      };
      const originalId = sessionId(prepared.stdout);
      expect(originalId).toMatch(/^[a-f0-9-]{36}$/);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(predecessorOnly);
      writeFileSync(join(checkout, 'answer.txt'), 'after\n');
      const diff = git('diff', '--', 'answer.txt');
      expect(diff).toContain('-before\n+after');
      const checkpoint = `Continue the private task. Preserve this checkpoint: ${randomUUID()}`;
      expect(statSync(carryRoot).uid).toBe(process.getuid!());
      const carry = mintCarryRespawnArgs([], { agent: 'codex', home: base, codexHome: home,
        ownerId: 'su-private-container-carry', systemPromptAddendum: checkpoint });
      if (!carry.carryText || !carry.launchContextPath) throw new Error('Carry minting must produce text and a launch context');
      expect(carry.carryText).toContain(checkpoint);
      expect(carry.carryText).toContain(`codex-carry-lineage predecessor:${originalId}`);
      expect(readFileSync(carry.launchContextPath, 'utf8').trim()).toBe(carry.carryText);
      rmSync(first.dir, { recursive: true, force: true });
      const successor = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'native-after-')) });
      const resumed = await command(successor.wrapperPath, [...args, carry.carryText], env, 60_000);
      expect(resumed.status, JSON.stringify(resumed)).toBe(0);
      const successorId = sessionId(resumed.stdout);
      expect(successorId).toMatch(/^[a-f0-9-]{36}$/);
      expect(successorId).not.toBe(originalId);
      expect(requests).toHaveLength(2);
      const received = JSON.stringify(requests[1]);
      expect(received).toContain(checkpoint);
      expect(received).toContain(`codex-carry-lineage predecessor:${originalId}`);
      expect(received).toContain('<cwd>/app</cwd>');
      expect(received).not.toContain(predecessorOnly);
      expect(received).not.toContain(checkout);
      // A fresh carry launch and a native resume are different boundaries. Reopen
      // the persisted successor through another wrapper, without re-supplying its
      // carry, and require the native CLI to recover that exact session context.
      rmSync(successor.dir, { recursive: true, force: true });
      const reopened = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(root, 'native-resume-')) });
      const resumeText = `Resume the retained private checkpoint: ${randomUUID()}`;
      const continued = await command(reopened.wrapperPath,
        ['exec', 'resume', '--json', '--skip-git-repo-check', successorId, resumeText], env, 60_000);
      expect(continued.status, JSON.stringify(continued)).toBe(0);
      expect(sessionId(continued.stdout)).toBe(successorId);
      expect(requests).toHaveLength(3);
      const resumeInput = JSON.stringify(requests[2]);
      expect(resumeInput).toContain(checkpoint);
      expect(resumeInput).toContain(`codex-carry-lineage predecessor:${originalId}`);
      expect(resumeInput).toContain('Private native carry protocol acknowledgement.');
      expect(resumeInput).toContain(resumeText);
      expect(resumeInput).toContain('<cwd>/app</cwd>');
      expect(resumeInput).not.toContain(predecessorOnly);
      expect(resumeInput).not.toContain(checkout);
      expect(requests.map(body => body.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna']);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('diff', '--', 'answer.txt')).toBe(diff);
      expect(readFileSync(join(checkout, 'answer.txt'), 'utf8')).toBe('after\n');
      expect(egress.stats().gw.connections).toBeGreaterThan(0);
      console.info('CONTAINER_NATIVE_CARRY_VERIFIED', JSON.stringify({ originalId, successorId,
        modelRequests: requests.length, providerForwarding: false, checkpointPreserved: true,
        freshNativeSession: true, nativeResumeVerified: true }));
    } catch (error) { primaryError = error; throw error; }
    finally {
      const failures: unknown[] = [];
      const clean = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
      if (cid) await clean(() => removeContainer(cid!));
      if (lease) await clean(async () => expect(await lease!.release()).toEqual([]));
      if (egress) await clean(async () => expect((await egress!.stop()).errors).toEqual([]));
      provider.closeAllConnections();
      await clean(() => new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done())));
      if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Native carry cleanup failed');
    }
  }, 180_000);

  it('initializes native MCP through the maintained container egress without model inference', async () => {
    const base = mkdtempSync(join(root, 'native-mcp-'));
    const homes = join(base, 'homes'), perHomes = join(base, 'task-homes'), home = join(homes, 'session-7');
    // This probe exercises the egress/MCP path only. Keep its cwd inside the
    // image: the prior host-checkout bind produced a Docker /app chdir failure
    // before MCP traffic, which obscured the path this case is meant to prove.
    for (const dir of [home, perHomes]) mkdirSync(dir, { recursive: true });
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body: { id?: number; method?: string };
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(405); res.end(); return; }
      methods.push(body.method ?? 'unknown');
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'private-mcp', version: '1' } }
        : body.method === 'tools/list' ? { tools: [] } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    let egress: Awaited<ReturnType<typeof startBenchEgress>> | undefined;
    let lease: Awaited<ReturnType<NonNullable<typeof egress>['openTaskNetwork']>> | undefined;
    let cid: string | undefined, primaryError: unknown;
    try {
      egress = await startBenchEgress({ runId: `native-mcp-${randomUUID()}`, endpoints: [
        { name: 'mcp', listenPort: 9071, targetPort: port, transport: 'http' },
        { name: 'gw', listenPort: 8788, targetPort: port },
      ] });
      lease = await egress.openTaskNetwork('mcp');
      writeFileSync(join(home, 'config.toml'), [
        'model = "gpt-6-luna"', 'model_provider = "private-mcp"',
        '[features]', 'apps = false', 'plugins = false', 'remote_plugin = false',
        '[model_providers.private-mcp]', 'name = "Offline MCP fixture"',
        `base_url = "${egress.originFor('gw')}/v1"`, `model_catalog_url = "${egress.originFor('gw')}/models"`,
        'wire_api = "responses"', 'requires_openai_auth = false',
        '[mcp_servers.papercusp-su]', `url = "${egress.originFor('mcp')}/mcp"`,
        'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }',
      ].join('\n'));
      cid = await startContainer(['--user', `${process.getuid!()}:${process.getgid!()}`,
        '-v', `${perHomes}:${homes}`, '-v', `${resolveContainerCodexBinary()}:${CONTAINER_CODEX_BIN_PATH}:ro`], lease.network);
      const { wrapperPath } = materializeDockerExecWrapper({ kind: 'docker-exec', containerId: cid,
        workdir: '/', binPath: CONTAINER_CODEX_BIN_PATH,
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perHomes }] } },
      { dir: mkdtempSync(join(root, 'mcp-wrapper-')) });
      const child = createRequire(import.meta.url)('@lydell/node-pty').spawn(wrapperPath,
        ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
        { env: { PATH: process.env.PATH, CODEX_HOME: home, TERM: 'xterm-256color' }, cwd: base, cols: 120, rows: 30 });
      const output = await new Promise<string>((resolve, reject) => {
        let output = '', probes = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
        const cleanupTimer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native MCP TUI did not terminate')); }, 10_000);
        const data = child.onData((chunk: string) => {
          output = (output + chunk).slice(-12000); probes = (probes + chunk).slice(-100);
          if (probes.includes('\x1b[6n')) { child.write('\x1b[1;1R'); probes = ''; }
        });
        child.onExit(() => { clearTimeout(timer); clearTimeout(cleanupTimer); data.dispose(); resolve(output); });
      });
      expect(methods, output).toContain('initialize');
      expect(methods, output).toContain('tools/list');
      expect(methods, output).not.toContain('unknown');
    } catch (error) { primaryError = error; throw error; }
    finally {
      const failures: unknown[] = [];
      const clean = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
      if (cid) await clean(() => removeContainer(cid!));
      if (lease) await clean(async () => expect(await lease!.release()).toEqual([]));
      if (egress) await clean(async () => expect((await egress!.stop()).errors).toEqual([]));
      server.closeAllConnections();
      await clean(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
      if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'Native MCP cleanup failed');
    }
  }, 90_000);

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
