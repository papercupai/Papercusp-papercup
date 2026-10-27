/**
 * scripts/lib/run-in-isolated-netns.sh — runs a command (the operator e2e Playwright run)
 * in its own network namespace so host interface churn cannot abort Chromium loads with
 * net::ERR_NETWORK_CHANGED (WI-6554700010008480).
 *
 * Mode and fallback cases run everywhere. The isolation cases need bwrap + pasta + an
 * AppArmor userns grant for bwrap; they are skipped (not passed) where the namespace
 * cannot be built, and the skip reason says so.
 */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WRAPPER = join(REPO_ROOT, 'scripts/lib/run-in-isolated-netns.sh');

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(s => new Promise<void>(done => s.close(() => done()))));
});

function wrap(cmd: string[], env: Record<string, string | undefined> = {}) {
  const res = spawnSync(WRAPPER, ['--', ...cmd], {
    env: { ...process.env, PAPERCUSP_E2E_NETNS: undefined, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A PATH holding only the named host tools — everything else (bwrap, pasta) is absent. */
function restrictedPath(tools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'netns-path-'));
  dirs.push(dir);
  for (const tool of tools) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!found) throw new Error(`test needs host tool ${tool}`);
    symlinkSync(found, join(dir, tool));
  }
  return dir;
}

const HOST_NETNS = readlinkSync('/proc/self/ns/net');

const probe = spawnSync(WRAPPER, ['--', 'true'], {
  env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' },
  encoding: 'utf8',
  timeout: 60_000,
});
const ISOLATION_AVAILABLE = probe.status === 0;
const isolationSkipReason = ISOLATION_AVAILABLE
  ? ''
  : `namespace unavailable on this host (exit ${probe.status}): ${probe.stderr.trim().split('\n').pop()}`;

describe('run-in-isolated-netns.sh — modes and fallback', () => {
  it('refuses a call without -- and a command', () => {
    expect(spawnSync(WRAPPER, ['true'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(WRAPPER, ['--'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('refuses an unknown mode', () => {
    const r = wrap(['true'], { PAPERCUSP_E2E_NETNS: 'sometimes' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be auto, required or off');
  });

  it('off runs the command directly, in the host namespace', () => {
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; exit 5'], { PAPERCUSP_E2E_NETNS: 'off' });
    expect(r.status).toBe(5);
    expect(r.stdout.trim()).toBe(HOST_NETNS);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=0 mode=off reason=disabled');
  });

  it('auto runs the command unisolated, and says why, when bwrap is missing', () => {
    const path = restrictedPath(['bash', 'readlink']);
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; exit 6'], { PATH: path });
    expect(r.status).toBe(6);
    expect(r.stdout.trim()).toBe(HOST_NETNS);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=0 mode=auto reason=bwrap-missing');
  });

  it('required refuses with 97 and never starts the command when isolation is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netns-marker-'));
    dirs.push(dir);
    const marker = join(dir, 'ran');
    const path = restrictedPath(['bash', 'touch']);
    const r = wrap(['touch', marker], { PATH: path, PAPERCUSP_E2E_NETNS: 'required' });
    expect(r.status).toBe(97);
    expect(r.stderr).toContain('reason=bwrap-missing');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('run-in-isolated-netns.sh — supervisor cleanup', () => {
  it.each([0, 7, 'fragmented-info'] as const)('closes a blocked helper output pipe for %s', async (exitCode) => {
    const dir = mkdtempSync(join(tmpdir(), 'netns-supervisor-'));
    dirs.push(dir);
    const childPidFile = join(dir, 'child.pid');
    const bwrap = join(dir, 'bwrap');
    // Model the launcher exiting while its announced helper remains blocked.
    // The helper inherits stdout, so leaving it alive prevents pipeline EOF.
    writeFileSync(bwrap, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { readSync, writeFileSync, writeSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
writeFileSync(process.env.NETNS_FIXTURE_PID, String(child.pid));
if (${JSON.stringify(exitCode)} === 'fragmented-info') {
  writeSync(8, '{\\n  "child-pid": ' + child.pid + ',\\n');
  setTimeout(() => {
    // The reader must stay open for the complete record, even between writes.
    writeSync(8, '  "fixture": true\\n}\\n');
    require('node:fs').closeSync(8);
    readSync(9, Buffer.alloc(2), 0, 2, null);
    child.once('exit', () => process.exit(0));
    child.kill('SIGTERM');
  }, 100);
} else {
  writeSync(8, JSON.stringify({ 'child-pid': child.pid }) + '\\n');
  child.unref();
  process.exit(${typeof exitCode === 'number' ? exitCode : 0});
}
`);
    const pasta = join(dir, 'pasta');
    writeFileSync(pasta, '#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -P ]; then : > "$2"; break; fi; shift; done\n');
    const ip = join(dir, 'ip');
    writeFileSync(ip, '#!/usr/bin/env bash\nexit 0\n');
    for (const path of [bwrap, pasta, ip]) chmodSync(path, 0o755);
    const wrapper = spawn(WRAPPER, ['--', 'true'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PAPERCUSP_E2E_NETNS: 'required',
        NETNS_FIXTURE_PID: childPidFile, VERIFY_TAURI_PID: undefined },
    });
    let stderr = '';
    wrapper.stderr.on('data', chunk => { stderr += chunk; });
    // Consume both pipes: close, rather than exit, proves inherited FDs closed.
    wrapper.stdout.resume();
    const closed = new Promise<number | null>((done, reject) => {
      wrapper.once('close', done);
      wrapper.once('error', reject);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        closed.then(code => ({ timedOut: false, code })),
        new Promise<{ timedOut: boolean; code: null }>(done => {
          timer = setTimeout(() => done({ timedOut: true, code: null }), 5_000);
        }),
      ]);
      expect(result.timedOut, stderr).toBe(false);
      expect(result.code, stderr).toBe(exitCode === 'fragmented-info' ? 0 : exitCode === 0 ? 97 : exitCode);
      if (exitCode === 'fragmented-info') {
        expect(stderr).not.toContain('supervisor exited with its sandbox helper still alive');
      } else {
        expect(stderr).toContain('supervisor exited with its sandbox helper still alive');
      }
    } finally {
      if (timer) clearTimeout(timer);
      // Reap only this fixture's known child on the intentionally failing baseline.
      if (existsSync(childPidFile)) {
        try { process.kill(Number(readFileSync(childPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
      }
      wrapper.kill('SIGKILL');
      await closed;
    }
  }, 15_000);
});

describe.skipIf(!ISOLATION_AVAILABLE)(`run-in-isolated-netns.sh — isolation ${isolationSkipReason}`, () => {
  it('captures live native executable custody outside the user namespace and refuses an exited process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'netns-native-witness-'));
    dirs.push(dir);
    const receipt = join(dir, 'receipt.json');
    const commit = 'a'.repeat(40);
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: commit }));
    const native = spawn(process.execPath, ['-e', 'console.log("READY"); setInterval(() => {}, 1000)'], {
      env: { ...process.env, DISPLAY: ':91', OPERATOR_DEV_PORT: '12345',
        PAPERCUSP_SID: 'fixture-owner', PAPERCUSP_TAURI_LAUNCH_PROVENANCE: 'fixture-provenance' },
    });
    await new Promise<void>((done, reject) => {
      native.stdout.once('data', () => done());
      native.once('error', reject);
    });
    const module = pathToFileURL(join(REPO_ROOT, 'packages/operator-core/lib/testing-native-runtime.ts')).href;
    try {
      const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
      const generator = verifier.match(/write_liveness_check_script\(\) \{[\s\S]*?\n\}/)?.[0];
      if (!generator) throw new Error('Maintained native liveness generator was not found');
      const generated = spawnSync('bash', ['-c', `${generator}\nwrite_liveness_check_script`], {
        env: { ...process.env, WORK: dir, BRIDGE_PID: String(native.pid), LOG: join(dir, 'native.log'),
          DISPLAY_NUM: '91', DEV_PORT: '12345', TAURI_OWNER_SID: 'fixture-owner',
          TAURI_LAUNCH_PROVENANCE: 'fixture-provenance', VERIFY_SCOPE_ENABLED: '0', TAURI_SCOPE_UNIT: '' },
        encoding: 'utf8',
      });
      expect(generated.status, generated.stderr).toBe(0);
      const liveness = join(dir, 'check-live.sh');
      const original = readFileSync(liveness, 'utf8');
      writeFileSync(liveness, original.replace('EXPECTED_PROVENANCE="fixture-provenance"',
        'EXPECTED_PROVENANCE="foreign-provenance"'));
      const refused = wrap([process.execPath, '-e', 'console.log("ASSERTION_MUST_NOT_START")'], {
        PAPERCUSP_E2E_NETNS: 'required', VERIFY_TAURI_PID: String(native.pid),
        OPERATOR_SOURCE_ROOT: REPO_ROOT, VERIFY_TAURI_SOURCE_REF: commit,
        VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_LIVENESS_CHECK: liveness,
      });
      expect(refused.status, refused.stderr).toBe(98);
      expect(refused.stderr).toContain('native liveness preparation failed');
      expect(refused.stderr).toContain('launch provenance');
      expect(refused.stdout).not.toContain('ASSERTION_MUST_NOT_START');
      writeFileSync(liveness, original);
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
        const child = spawn(WRAPPER, ['--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import { execFileSync } from 'node:child_process';
          import { readFileSync, statSync, writeFileSync } from 'node:fs';
          import { prepareNativeRuntimeReader } from ${JSON.stringify(module)};
          assert.throws(() => statSync('/proc/' + process.env.VERIFY_TAURI_PID + '/exe'), { code: 'EACCES' });
          assert.throws(() => readFileSync('/proc/' + process.env.VERIFY_TAURI_PID + '/environ'), { code: 'EACCES' });
          const read = prepareNativeRuntimeReader(${JSON.stringify(REPO_ROOT)}, ${JSON.stringify(commit)});
          const before = read();
          assert.match(before.fingerprint, /^[a-f0-9]{64}$/);
          assert.deepEqual(before.units, ['verify-tauri-headless:' + process.env.VERIFY_TAURI_PID]);
          assert.equal(read().fingerprint, before.fingerprint);
          assert.throws(() => prepareNativeRuntimeReader(${JSON.stringify(REPO_ROOT)}, 'b'.repeat(40)), /source receipt mismatch/);
          const check = process.env.VERIFY_TAURI_LIVENESS_CHECK;
          const original = readFileSync(check, 'utf8');
          const checkLive = () => execFileSync('bash', [check], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          assert.match(checkLive(), /verifier bridge alive/);
          const wrongMarker = original.replace('EXPECTED_PROVENANCE="fixture-provenance"', 'EXPECTED_PROVENANCE="foreign-provenance"');
          assert.notEqual(wrongMarker, original);
          writeFileSync(check, wrongMarker);
          assert.throws(checkLive, /launch provenance/);
          writeFileSync(check, original);
          assert.match(checkLive(), /verifier bridge alive/);
          console.log('LIVENESS_VERIFIED');
          console.log('WITNESS_READY');
          const deadline = Date.now() + 10000;
          const poll = setInterval(() => {
            if (read() === null) { clearInterval(poll); assert.throws(checkLive); console.log('EXIT_REFUSED'); }
            else if (Date.now() > deadline) { clearInterval(poll); process.exitCode = 9; }
          }, 100);
        `], { cwd: REPO_ROOT, env: { ...process.env,
          PAPERCUSP_E2E_NETNS: 'required', VERIFY_TAURI_PID: String(native.pid),
          PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', OPERATOR_SOURCE_ROOT: REPO_ROOT,
          VERIFY_TAURI_LIVENESS_CHECK: join(dir, 'check-live.sh'),
          VERIFY_TAURI_SOURCE_REF: commit, VERIFY_TAURI_SOURCE_RECEIPT: receipt } });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`native witness guard timed out\nstdout: ${stdout}\nstderr: ${stderr}`)); }, 45_000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('WITNESS_READY')) native.kill('SIGTERM'); });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('close', code => { clearTimeout(timeout); done({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=1');
      expect(result.stdout).toContain('LIVENESS_VERIFIED');
      expect(result.stdout).toContain('WITNESS_READY');
      expect(result.stdout).toContain('EXIT_REFUSED');
    } finally { native.kill('SIGTERM'); }
  }, 60_000);

  it('runs the command in a different network namespace holding only loopback and one tap interface', () => {
    const host = spawnSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }).stdout.trim().split('\n');
    // Calibration: the comparison means something only if the host has more than that.
    expect(host.length).toBeGreaterThan(2);
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; ip -o link show']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=1 mode=auto reason=namespace');
    const [netns, ...links] = r.stdout.trim().split('\n');
    expect(netns).not.toBe(HOST_NETNS);
    expect(links).toHaveLength(2);
    expect(links.some(l => /^\d+: lo:/.test(l))).toBe(true);
  }, 60_000);

  it('starts the command only after the namespace addresses settle (no tentative address left)', () => {
    const r = wrap(['ip', '-o', 'addr', 'show']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(' inet ');
    expect(r.stdout).not.toContain('tentative');
  }, 60_000);

  it('reaches a service bound on the host loopback via 127.0.0.1', async () => {
    const server = createServer((_req, res) => res.end('host-loopback-ok'));
    servers.push(server);
    const port = await new Promise<number>(done =>
      server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)),
    );
    // Async spawn: the server lives in this process, so the event loop must keep serving.
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn(WRAPPER, ['--', process.execPath, '-e',
        `fetch("http://127.0.0.1:${port}/").then(r => r.text()).then(t => process.stdout.write(t), e => { console.error(e); process.exit(9); })`,
      ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('close', code => done({ code, stdout, stderr }));
    });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe('host-loopback-ok');
  }, 60_000);

  it("passes the caller's stdin and inherited fd 3 through, and leaks none of its own fds", () => {
    // Playwright drives Chromium over inherited fds 3/4 (--remote-debugging-pipe); a
    // non-interactive shell would otherwise hand the background sandbox /dev/null as stdin.
    const res = spawnSync('bash', ['-c',
      `exec 3< <(echo from-fd3); echo from-stdin | "${WRAPPER}" -- bash -c 'cat; cat <&3; ls /proc/self/fd | sort -n | tr "\\n" " "'`,
    ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' }, encoding: 'utf8', timeout: 60_000 });
    expect(res.status, res.stderr).toBe(0);
    const [stdin, fd3, fds] = res.stdout.split('\n');
    expect(stdin).toBe('from-stdin');
    expect(fd3).toBe('from-fd3');
    // 0-2, the inherited 3, and the descriptor `ls` opens on /proc/self/fd itself.
    expect(fds.trim().split(' ').map(Number).filter(fd => fd > 3)).toHaveLength(1);
    // Parent budget must exceed the spawnSync child's 60s, or Vitest kills the test
    // first and the child timeout is unreachable (lint:test-timing-budgets).
  }, 90_000);

  it('forwards SIGTERM to the command and returns its exit code', async () => {
    const out = await new Promise<{ code: number | null; stdout: string }>(done => {
      const child = spawn(WRAPPER, ['--', 'bash', '-c',
        'trap "echo GOT_TERM; exit 42" TERM; echo READY; while :; do sleep 0.1; done',
      ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' } });
      let stdout = '';
      child.stdout.on('data', c => {
        stdout += c;
        if (stdout.includes('READY') && !stdout.includes('GOT_TERM')) child.kill('SIGTERM');
      });
      child.on('close', code => done({ code, stdout }));
    });
    expect(out.stdout).toContain('GOT_TERM');
    expect(out.code).toBe(42);
  }, 60_000);

  // Opt-in: churning a host interface would itself disturb peers' unisolated browsers.
  const churnOptIn = process.env.PAPERCUSP_NETNS_CHURN_PROBE === '1'
    && spawnSync('sudo', ['-n', 'true']).status === 0;
  it.skipIf(!churnOptIn)('hears none of the host interface churn (PAPERCUSP_NETNS_CHURN_PROBE=1, sudo -n)', async () => {
    const iface = `pcns${process.pid % 100000}`;
    const child = spawn(WRAPPER, ['--', 'timeout', '8', 'ip', 'monitor', 'address', 'link'], {
      env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' },
    });
    let nsEvents = '';
    let started = false;
    child.stdout.on('data', c => { nsEvents += c; });
    child.stderr.on('data', c => { if (String(c).includes('isolated=1')) started = true; });
    const closed = new Promise<void>(done => child.on('close', () => done()));
    while (!started) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    try {
      for (let i = 0; i < 3; i++) {
        spawnSync('sudo', ['-n', 'ip', 'link', 'add', iface, 'type', 'dummy']);
        spawnSync('sudo', ['-n', 'ip', 'addr', 'add', '198.18.250.1/32', 'dev', iface]);
        spawnSync('sudo', ['-n', 'ip', 'link', 'del', iface]);
      }
    } finally {
      spawnSync('sudo', ['-n', 'ip', 'link', 'del', iface]);
    }
    await closed;
    expect(nsEvents).not.toContain(iface);
  }, 60_000);
});
