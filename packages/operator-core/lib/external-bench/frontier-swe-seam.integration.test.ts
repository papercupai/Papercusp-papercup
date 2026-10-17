/**
 * FrontierSWE seam × in-container Codex session homes, against a real container (D-026 / D-029).
 *
 * The unit suite (frontier-swe-seam.test.ts) pins the mount flags and the restore rules with a fake docker.
 * This suite runs the whole lifecycle for real: the seam's clone() mounts the per-task dirs, the docker-exec
 * wrapper (container-exec-target.ts) relocates the session home into them, a stub "codex" writes nested files
 * AS THE CONTAINER USER, and teardown() hands the files back and restores the session dir into its shared root.
 * It settles D-029's open question: files written as root inside the container end up host-owned and removable
 * by the host (what session-dir-gc does later).
 *
 * Requires docker and the local `alpine` image (same convention as container-exec-target.integration.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from './types';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle } from './frontier-swe-seam';
import { materializeDockerExecWrapper } from './container-exec-target';
import { startBenchEgress, type BenchEgress } from './bench-egress';

let base: string;
const handles: FrontierSweEnvHandle[] = [];
let egress: BenchEgress | undefined;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'fswe-seam-int-'));
  for (const image of ['alpine', 'nginx:alpine']) execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
});

afterAll(async () => {
  for (const h of handles) spawnSync('docker', ['rm', '-f', h.containerId], { stdio: 'ignore' });
  await egress?.stop();
  // Anything a failed run left root-owned is removed from inside a throwaway container.
  spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${base}:/w`, 'alpine', 'rm', '-rf', '/w/x'], { stdio: 'ignore' });
  rmSync(base, { recursive: true, force: true });
  // Cleanup is several sequential daemon calls; on this host one `docker rm`/`create` can stall for minutes
  // (EI-25661823593517912), so the default 90s hook budget failed a run whose test had passed.
}, 300_000);

function task(): BenchTask {
  return {
    benchmark: 'frontier-swe',
    instanceId: 'seam-int-task',
    problemStatement: 'x',
    graderMeta: { dockerImage: 'alpine', gpus: 0, networkMode: 'no-network' },
  };
}

describe('FrontierSWE seam with an in-container Codex session home (real docker)', () => {
  it('clone mounts only this task, the container writes as its own user, and teardown returns a host-owned, deletable session dir to the shared root', async () => {
    const homesRoot = join(base, 'x', 'home', 'su-codex-homes');
    const sqliteRoot = join(base, 'x', 'tmp', 'papercusp-codex-sqlite-homes');
    const sessionHome = join(homesRoot, 'session-11');
    // The operator writes the session home (and another session's) on the host before launch.
    mkdirSync(sessionHome, { recursive: true });
    writeFileSync(join(sessionHome, 'config.toml'), 'model = "frozen"\n', { mode: 0o600 });
    expect(readFileSync(join(sessionHome, 'config.toml'), 'utf8')).toBe('model = "frozen"\n');
    mkdirSync(join(homesRoot, 'session-12'), { recursive: true });
    writeFileSync(join(homesRoot, 'session-12', 'auth.json'), '{"token":"other-session"}\n');
    // A stub Codex: proves it runs from the read-only seam mount, and writes NESTED dirs as the container user.
    const stub = join(base, 'x', 'codex-stub');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'set -e',
        'id -u',
        'cat "$CODEX_HOME/config.toml"',
        'ls "$(dirname "$CODEX_HOME")"',
        // Native Codex may atomically replace its config with a private file.
        // That replacement inherits the container's uid, unlike an in-place write.
        'umask 077',
        'printf \'model = "container-updated"\\n\' > "$CODEX_HOME/config.next"',
        'mv "$CODEX_HOME/config.next" "$CODEX_HOME/config.toml"',
        'umask 022',
        'mkdir -p "$CODEX_HOME/sessions/2026/10"',
        'echo rollout > "$CODEX_HOME/sessions/2026/10/r.jsonl"',
        `mkdir -p "${sqliteRoot}/session-11/db"`,
        `echo state > "${sqliteRoot}/session-11/db/state.sqlite"`,
        'if touch /opt/papercusp/codex 2>/dev/null; then echo bin-writable; else echo bin-readonly; fi',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);

    const hostOwner = { uid: process.getuid!(), gid: process.getgid!() };
    // A real run egress (D-030 / D-031). This test exercises only the network attachment, so nothing listens on
    // the relay target; bench-egress.integration.test.ts covers reachability.
    egress = await startBenchEgress({ runId: 'seam-int', endpoints: [{ name: 'gw', listenPort: 8788, targetPort: 9 }] });
    const seam = makeFrontierSweCloneGradeSeam({
      version: 'v',
      inContainerCodex: { homesRoot, sqliteRoot, codexBinary: stub, hostOwner },
      egress,
    });
    const h = await seam.clone(task());
    handles.push(h);
    const m = h.inContainerCodex!;
    // The container is on its own internal task network and nothing else.
    expect(h.taskNetwork).toMatch(/^pc-egress-seam-int-[0-9a-f]{6}-t1-seam-int-task$/);
    const nets = execFileSync('docker', ['inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', h.containerId], {
      encoding: 'utf8',
    });
    expect(nets.trim().split(/\s+/)).toEqual([h.taskNetwork]);
    expect(execFileSync('docker', ['network', 'inspect', '-f', '{{.Internal}}', h.taskNetwork!], { encoding: 'utf8' }).trim()).toBe('true');
    const { wrapperPath } = materializeDockerExecWrapper(
      {
        kind: 'docker-exec',
        containerId: h.containerId,
        workdir: '/',
        binPath: m.binPath,
        sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: m.roots },
      },
      { dir: mkdtempSync(join(base, 'w-')) },
    );
    const r = spawnSync(wrapperPath, [], { env: { PATH: process.env.PATH ?? '', CODEX_HOME: sessionHome }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = r.stdout.trim().split('\n');
    const containerUid = Number(out[0]);
    expect(Number.isInteger(containerUid)).toBe(true);
    expect(out).toContain('model = "frozen"');
    // Only this session is visible inside the container; session-12 and its token never reach it.
    expect(out.filter((l) => l.startsWith('session-'))).toEqual(['session-11']);
    expect(out).toContain('bin-readonly');
    // While the task runs, host readers see the container's writes through the symlink.
    expect(lstatSync(sessionHome).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sessionHome, 'sessions/2026/10/r.jsonl'), 'utf8')).toBe('rollout\n');
    const privateConfig = join(sessionHome, 'config.toml');
    const beforeHandback = statSync(privateConfig);
    expect(beforeHandback.mode & 0o777).toBe(0o600);
    // Rootless Docker may map the container user to this host user. On rootful
    // Docker, the private replacement is unreadable until the maintained handback.
    if (beforeHandback.uid !== hostOwner.uid && hostOwner.uid !== 0) {
      expect(() => readFileSync(privateConfig, 'utf8')).toThrow(/EACCES/);
    } else {
      expect(readFileSync(privateConfig, 'utf8')).toBe('model = "container-updated"\n');
    }
    console.log('SEAM_PRIVATE_CONFIG_HANDBACK', JSON.stringify({ containerUid,
      hostUid: hostOwner.uid, beforeUid: beforeHandback.uid, mode: beforeHandback.mode & 0o777 }));

    await seam.teardown(h);

    expect(spawnSync('docker', ['inspect', h.containerId], { stdio: 'ignore' }).status).not.toBe(0);
    // The task network went with the container; the run's egress stays up for other tasks.
    expect(spawnSync('docker', ['network', 'inspect', h.taskNetwork!], { stdio: 'ignore' }).status).not.toBe(0);
    expect(spawnSync('docker', ['inspect', egress.sidecarId], { stdio: 'ignore' }).status).toBe(0);
    for (const { perTaskDir } of m.roots) expect(existsSync(perTaskDir)).toBe(false);
    // The session dir is a real dir in its shared root again, with everything the container wrote.
    expect(lstatSync(sessionHome).isSymbolicLink()).toBe(false);
    expect(readFileSync(privateConfig, 'utf8')).toBe('model = "container-updated"\n');
    expect(statSync(privateConfig).uid).toBe(hostOwner.uid);
    expect(statSync(join(sessionHome, 'config.toml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(sessionHome, 'sessions/2026/10/r.jsonl'), 'utf8')).toBe('rollout\n');
    const sqliteHome = join(sqliteRoot, 'session-11');
    expect(readFileSync(join(sqliteHome, 'db/state.sqlite'), 'utf8')).toBe('state\n');
    // Host-owned, however the container user mapped (root in rootful docker): the host can delete it.
    for (const p of [join(sessionHome, 'sessions/2026/10'), join(sessionHome, 'sessions/2026/10/r.jsonl'), join(sqliteHome, 'db')]) {
      expect(statSync(p).uid).toBe(hostOwner.uid);
    }
    rmSync(sessionHome, { recursive: true });
    rmSync(sqliteHome, { recursive: true });
    expect(existsSync(sessionHome) || existsSync(sqliteHome)).toBe(false);
    expect(readFileSync(join(homesRoot, 'session-12', 'auth.json'), 'utf8')).toContain('other-session');
  }, 300_000); // docker create/exec stall for minutes on this host under load (EI-25661823593517912); int4 timed out at 90s
});
