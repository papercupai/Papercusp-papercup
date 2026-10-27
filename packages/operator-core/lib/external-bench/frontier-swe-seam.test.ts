import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import {
  checkFrontierSweIntegrity,
  frontierSweAgentNetworkArgs,
  makeFrontierSweCloneGradeSeam,
  restoreRelocatedSessions,
  type FrontierSweEnvHandle,
} from './frontier-swe-seam';

function task(over: Record<string, unknown> = {}): BenchTask {
  return {
    benchmark: 'frontier-swe',
    instanceId: 'cranelift-codegen-opt',
    problemStatement: 'x',
    graderMeta: {
      dockerImage: 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6',
      gpus: 0,
      verifierCmd: 'bash /tests/test.sh',
      rewardPath: '/logs/verifier/reward.txt',
      rewardJsonPath: '/logs/verifier/reward.json',
      ...over,
    },
  };
}

/**
 * Fake docker. `run` → emits a container id; `exec … cat <path>` → the file at that path; `exec … bash` (the
 * verifier) → code 0; `rm` → per `rmFails`. Records every invocation for assertions.
 */
function fakeDocker(files: Record<string, string>, opts: { runCode?: number; rmFails?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: ProcExec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'run') return { stdout: opts.runCode ? '' : 'deadbeefcafe\n', stderr: opts.runCode ? 'boom' : '', code: opts.runCode ?? 0 };
    if (args[0] === 'rm') {
      if (opts.rmFails) throw new Error('docker rm failed');
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'exec') {
      if (args.includes('test')) {
        // `test -e|-d <path>` → exit 0 present / 1 absent (the reader distinguishes absent from empty).
        const path = args[args.length - 1];
        const flag = args[args.length - 2];
        const isDir = Object.keys(files).some((f) => f.startsWith(`${path.replace(/\/+$/, '')}/`));
        const present = flag === '-d' ? isDir : path in files || isDir;
        return { stdout: '', stderr: '', code: present ? 0 : 1 };
      }
      const isCat = args.includes('cat');
      if (isCat) {
        const path = args[args.length - 1];
        return path in files ? { stdout: files[path], stderr: '', code: 0 } : { stdout: '', stderr: 'no file', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 }; // the verifier run
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('makeFrontierSweCloneGradeSeam', () => {
  it('is an in-container seam', () => {
    const { exec } = fakeDocker({});
    expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec }).modality).toBe('in-container');
  });

  it('clone runs the image detached and returns the container handle', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const h = await seam.clone(task());
    expect(h.containerId).toBe('deadbeefcafe');
    expect(h.image).toContain('cranelift-codegen-opt');
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('sleep');
    expect(run).not.toContain('--gpus'); // CPU task
  });

  it('clone adds --gpus all for GPU tasks', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await seam.clone(task({ gpus: 1, gpuTypes: ['H100'] }));
    expect(calls.find((c) => c[0] === 'run')).toContain('--gpus');
  });

  it('an oracle clone puts HARBOR_ORACLE_FLAG in the container env at `docker run` so the image entrypoint runs its oracle stage', async () => {
    const { exec, calls } = fakeDocker({});
    await makeFrontierSweCloneGradeSeam({ version: 'v', exec, oracle: true, oracleFlag: 'f00dfeed' }).clone(task());
    const run = calls.find((c) => c[0] === 'run')!;
    const i = run.indexOf('HARBOR_ORACLE_FLAG=f00dfeed');
    expect(i).toBeGreaterThan(0);
    expect(run[i - 1]).toBe('-e');
    expect(i).toBeLessThan(run.indexOf('sleep')); // a `docker run` option, not an argument to the command
  });

  it('a non-oracle clone (agent rollout / empty control) never carries the oracle flag, even if one is configured', async () => {
    for (const cfg of [{}, { oracle: false, oracleFlag: 'f00dfeed' }, { oracle: true }]) {
      const { exec, calls } = fakeDocker({});
      await makeFrontierSweCloneGradeSeam({ version: 'v', exec, ...cfg }).clone(task());
      expect(calls.find((c) => c[0] === 'run')!.join(' ')).not.toContain('HARBOR_ORACLE');
    }
  });

  describe('agent-container network policy (WI-6554700010008591)', () => {
    const runOf = async (over: Record<string, unknown>) => {
      const { exec, calls } = fakeDocker({});
      await makeFrontierSweCloneGradeSeam({ version: 'v', exec }).clone(task(over));
      return calls.find((c) => c[0] === 'run')!;
    };
    /** The value of a `docker run` option, asserting it precedes the image (an option, not a command argument). */
    const optionValue = (run: string[], flag: string, image = 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6') => {
      const i = run.indexOf(flag);
      if (i < 0) return undefined;
      expect(i).toBeLessThan(run.indexOf(image));
      return run[i + 1];
    };

    it("a v2 'no-network' task's agent container has no network", async () => {
      const run = await runOf({ networkMode: 'no-network' });
      expect(optionValue(run, '--network')).toBe('none');
      expect(run).toContain('PX_TASK_NETWORK_MODE=no-network');
    });

    it("a v2 'allowlist' task gets NO egress by default — the host-side model loop needs no model host in the container", async () => {
      const run = await runOf({ networkMode: 'allowlist' });
      expect(optionValue(run, '--network')).toBe('none');
      expect(run).toContain('PX_TASK_NETWORK_MODE=allowlist');
    });

    it('an in-container model client gets the per-task egress network for EVERY mode, as upstream Harbor does (D-030)', () => {
      for (const networkMode of ['no-network', 'none', 'allowlist']) {
        const args = frontierSweAgentNetworkArgs(task({ networkMode }), { egressNetwork: 'egress-net-1' });
        expect(args).toEqual(['--network', 'egress-net-1', '-e', `PX_TASK_NETWORK_MODE=${networkMode}`]);
      }
      // No declared mode: the client still reaches its model only through the egress network.
      expect(frontierSweAgentNetworkArgs(task({}), { egressNetwork: 'egress-net-1' })).toEqual(['--network', 'egress-net-1']);
      // An unknown mode still refuses, egress or not.
      expect(() => frontierSweAgentNetworkArgs(task({ networkMode: 'public' }), { egressNetwork: 'egress-net-1' })).toThrow(/cannot enforce/);
    });

    it('a task with no declared mode (v1 history) keeps its historical run: no network flag, no PX_TASK env', async () => {
      for (const over of [{}, { networkMode: null }]) {
        const run = await runOf(over);
        expect(run).not.toContain('--network');
        expect(run.join(' ')).not.toContain('PX_TASK_NETWORK_MODE');
      }
    });

    it('fails CLOSED: an unknown or malformed declared mode throws and never starts an unrestricted container', async () => {
      for (const networkMode of ['public', 'host', '', 7]) {
        const { exec, calls } = fakeDocker({});
        await expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec }).clone(task({ networkMode }))).rejects.toThrow(/network/);
        expect(calls.some((c) => c[0] === 'run')).toBe(false);
      }
    });

    it('refuses extraRunArgs that would override the network policy', () => {
      const { exec } = fakeDocker({});
      for (const flag of [['--network', 'host'], ['--network=bridge'], ['--net', 'host'], ['--net=host']]) {
        expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, extraRunArgs: ['--cpus', '8', ...flag] })).toThrow(/network/);
      }
      // A non-network flag that merely contains the substring is fine.
      expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, extraRunArgs: ['--network-alias', 'x'] })).not.toThrow();
    });
  });

  it('clone throws on a missing image or a failed docker run', async () => {
    const { exec } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await expect(seam.clone(task({ dockerImage: undefined }))).rejects.toThrow(/no dockerImage/);
    const failing = fakeDocker({}, { runCode: 1 });
    await expect(makeFrontierSweCloneGradeSeam({ version: 'v', exec: failing.exec }).clone(task())).rejects.toThrow(/docker run failed/);
  });

  it('grade runs the task verifier and reads the [0,1] reward → continuous score', async () => {
    const { exec } = fakeDocker({ '/logs/verifier/reward.txt': '0.62\n' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const h: FrontierSweEnvHandle = { containerId: 'cid', image: 'img', instanceId: 'cranelift-codegen-opt' };
    const g = await seam.grade(task(), h);
    expect(g.score).toBe(0.62);
    expect(g.resolved).toBe(false);
    expect(g.graderStatus).toBe('failed');
  });

  it('grade maps a full score to resolved/passed', async () => {
    const { exec } = fakeDocker({ '/logs/verifier/reward.txt': '1.0' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const g = await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(g.resolved).toBe(true);
    expect(g.graderStatus).toBe('passed');
  });

  it('grade surfaces an absent reward as an infra error (graderStatus=error, score null) — never a silent 0', async () => {
    const { exec } = fakeDocker({}); // no reward files
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const g = await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(g.score).toBeNull();
    expect(g.resolved).toBeNull();
    expect(g.graderStatus).toBe('error');
  });

  it('grade stages tests/ into the container at GRADE time (anti-cheat: the agent never saw /tests)', async () => {
    const { exec, calls } = fakeDocker({ '/logs/verifier/reward.txt': '0.4' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe' });
    await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(calls.find((c) => c[0] === 'cp')).toEqual(['cp', '/vendor/frontier-swe/tasks/cranelift-codegen-opt/tests', 'cid:/tests']);
  });

  it('oracle mode also stages solution/ (the gold positive control)', async () => {
    const { exec, calls } = fakeDocker({ '/logs/verifier/reward.txt': '1.0' });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe', oracle: true });
    await seam.grade(task(), { containerId: 'cid', image: 'i', instanceId: 'cranelift-codegen-opt' });
    expect(calls.some((c) => c[0] === 'cp' && c[2] === 'cid:/solution')).toBe(true);
  });

  it('clone does NOT stage tests/ (they must be hidden from the agent until grade time)', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/frontier-swe' });
    await seam.clone(task());
    expect(calls.find((c) => c[0] === 'cp')).toBeUndefined();
  });

  it('teardown removes the container and never throws', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    await seam.teardown({ containerId: 'cid', image: 'i', instanceId: 't' });
    expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', '-f', 'cid']);
    // a failing rm is swallowed
    const failing = fakeDocker({}, { rmFails: true });
    await expect(
      makeFrontierSweCloneGradeSeam({ version: 'v', exec: failing.exec }).teardown({ containerId: 'cid', image: 'i', instanceId: 't' }),
    ).resolves.toBeUndefined();
  });
});

describe('in-container Claude frozen binary and isolated session mount', () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function fixture(probe: 'ok' | 'loader-failure' | 'wrong-version' | 'timeout' | 'drift' = 'ok') {
    const base = mkdtempSync(join(tmpdir(), 'fswe-seam-claude-')); made.push(base);
    const homesRoot = join(base, 'session-claude'), claudeBinary = join(base, '2.1.293');
    mkdirSync(join(homesRoot, 'foreign-session'), { recursive: true });
    writeFileSync(join(homesRoot, 'foreign-session', 'credentials.json'), 'must stay host-only');
    const header = Buffer.alloc(20); header.write('7f454c460201', 0, 'hex');
    header.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18);
    writeFileSync(claudeBinary, header, { mode: 0o755 });
    const config = { homesRoot, claudeBinary, version: '2.1.293', sha256: createHash('sha256').update(header).digest('hex'),
      hostOwner: { uid: 4242, gid: 4343 }, versionProbeTimeoutMs: probe === 'timeout' ? 5 : 30_000 };
    const docker = fakeDocker({}), calls = docker.calls;
    const exec: ProcExec = async (cmd, args) => {
      if (args[0] === 'exec' && args.includes('--version')) {
        calls.push(args);
        if (probe === 'timeout') return new Promise(() => {});
        if (probe === 'drift') writeFileSync(claudeBinary, 'replacement');
        return { code: probe === 'loader-failure' ? 127 : 0, stderr: '',
          stdout: probe === 'wrong-version' ? '2.1.292 (Claude Code)\n' : '2.1.293 (Claude Code)\n' };
      }
      return docker.exec(cmd, args);
    };
    const egress = { async openTaskNetwork() {
      calls.push(['egress-open']);
      return { network: 'claude-task-network', async release() { calls.push(['egress-release']); return []; } };
    } };
    return { base, config, calls, exec, egress };
  }
  it('mounts only this task home and frozen binary, probes without host environment and restores private transcripts', async () => {
    const f = fixture();
    const seam = makeFrontierSweCloneGradeSeam({ exec: f.exec, inContainerClaude: f.config, egress: f.egress });
    const h = await seam.clone(task());
    expect(h.inContainerCodex).toBeUndefined();
    expect(h.inContainerClaude).toMatchObject({ binPath: '/opt/papercusp/claude', version: f.config.version, sha256: f.config.sha256 });
    const m = h.inContainerClaude!, root = m.roots[0];
    const run = f.calls.find(c => c[0] === 'run')!;
    expect(run.flatMap((a, i) => a === '--mount' ? [run[i + 1]] : [])).toEqual([
      `type=bind,source=${root.perTaskDir},target=${f.config.homesRoot}`,
      `type=bind,source=${f.config.claudeBinary},target=/opt/papercusp/claude,readonly`,
    ]);
    expect(readdirSync(root.perTaskDir)).toEqual([]);
    expect(f.calls.find(c => c.includes('--version'))).toEqual(['exec', '-w', '/app', h.containerId, 'env', '-i',
      'HOME=/tmp', 'CLAUDE_CONFIG_DIR=/tmp/papercusp-claude-version', '/opt/papercusp/claude', '--version']);
    const relocated = join(root.perTaskDir, 'own-session'); mkdirSync(relocated);
    writeFileSync(join(relocated, 'transcript.jsonl'), 'retained', { mode: 0o600 });
    symlinkSync(relocated, join(root.hostRoot, 'own-session'));
    await seam.teardown(h);
    expect(readFileSync(join(root.hostRoot, 'own-session', 'transcript.jsonl'), 'utf8')).toBe('retained');
    expect(existsSync(root.perTaskDir)).toBe(false);
    expect(f.calls.find(c => c[0] === 'exec' && c.includes('chown'))).toEqual(['exec', '-u', '0', h.containerId, 'chown', '-R', '4242:4343', root.hostRoot]);
    expect(f.calls.findIndex(c => c[0] === 'rm')).toBeLessThan(f.calls.findIndex(c => c[0] === 'egress-release'));
  });
  it.each(['loader-failure', 'wrong-version', 'timeout', 'drift'] as const)('refuses %s before returning an assignment and cleans the task', async probe => {
    const f = fixture(probe);
    const seam = makeFrontierSweCloneGradeSeam({ exec: f.exec, inContainerClaude: f.config, egress: f.egress });
    await expect(seam.clone(task())).rejects.toThrow(/Claude/);
    expect(f.calls.filter(c => c[0] === 'rm')).toEqual([['rm', '-f', 'deadbeefcafe']]);
    expect(f.calls.filter(c => c[0] === 'egress-release')).toHaveLength(1);
    expect(readdirSync(f.base)).toEqual(['2.1.293', 'session-claude']);
  });
  it('rejects a changed binary before allocating a network and snapshots caller configuration', async () => {
    const f = fixture(), original = f.config.sha256;
    const seam = makeFrontierSweCloneGradeSeam({ exec: f.exec, inContainerClaude: f.config, egress: f.egress });
    f.config.version = '9.9.9'; f.config.sha256 = '0'.repeat(64);
    const handle = await seam.clone(task());
    expect(handle.inContainerClaude).toMatchObject({ version: '2.1.293', sha256: original });
    await seam.teardown(handle); f.calls.splice(0);
    writeFileSync(f.config.claudeBinary, 'changed');
    await expect(seam.clone(task())).rejects.toThrow(/SHA256/);
    expect(f.calls).toEqual([]);
  });
  it('requires egress, a frozen binary hash and a single native backend', () => {
    const f = fixture();
    expect(() => makeFrontierSweCloneGradeSeam({ inContainerClaude: f.config })).toThrow(/egress/);
    expect(() => makeFrontierSweCloneGradeSeam({ inContainerClaude: { ...f.config, sha256: '0'.repeat(64) }, egress: f.egress })).toThrow(/SHA256/);
    expect(() => makeFrontierSweCloneGradeSeam({ inContainerClaude: f.config, inContainerCodex: true, egress: f.egress })).toThrow(/one native/);
  });
});

describe('in-container Codex session mounts (D-026 / D-029)', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** Real temp roots shaped like production: the homes and SQLite roots live in different parents. */
  function roots() {
    const base = mkdtempSync(join(tmpdir(), 'fswe-seam-codex-'));
    made.push(base);
    const homesRoot = join(base, 'home', '.papercusp', 'su-codex-homes');
    const sqliteRoot = join(base, 'tmp', 'papercusp-codex-sqlite-homes');
    return { base, homesRoot, sqliteRoot, codexBinary: join(base, 'codex-musl'), busybox: join(base, 'busybox'), hookShim: join(base, 'hook-shim') };
  }
  const owner = { uid: 4242, gid: 4343 };
  /**
   * A fake run egress. It logs into the fake docker's call list, so the order of lease events relative to docker
   * calls is assertable.
   */
  function fakeEgress(log: string[][], opts: { failOpen?: boolean } = {}) {
    let n = 0;
    return {
      async openTaskNetwork(tag: string) {
        if (opts.failOpen) throw new Error('egress open failed');
        const network = `egress-net-${++n}`;
        log.push(['egress-open', network, tag]);
        return {
          network,
          async release() {
            log.push(['egress-release', network]);
            return [];
          },
        };
      },
    };
  }
  /** Stand in for the docker-exec wrapper: relocate a session dir into the per-task dir and leave the symlink. */
  function relocate(hostRoot: string, perTaskDir: string, name: string, file?: string) {
    const target = join(perTaskDir, name);
    mkdirSync(target, { recursive: true });
    if (file) writeFileSync(join(target, file), file);
    symlinkSync(target, join(hostRoot, name));
  }

  it('clone mints a per-task dir beside each shared root, mounts it over the root at the same path, mounts the musl Codex read-only, and exposes the mounts on the handle', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
    const h = await seam.clone(task());
    const m = h.inContainerCodex!;
    expect(m.binPath).toBe('/opt/papercusp/codex');
    expect(m.hostOwner).toEqual(owner);
    expect(m.roots.map((x) => x.hostRoot)).toEqual([r.homesRoot, r.sqliteRoot]);
    for (const { hostRoot, perTaskDir } of m.roots) {
      // A sibling of the root (same filesystem, so the wrapper's rename works) that exists and is empty.
      expect(dirname(perTaskDir)).toBe(dirname(hostRoot));
      expect(perTaskDir).not.toBe(hostRoot);
      expect(existsSync(perTaskDir)).toBe(true);
      expect(existsSync(hostRoot)).toBe(true);
    }
    const run = calls.find((c) => c[0] === 'run')!;
    const mounts = run.flatMap((a, i) => (a === '--mount' ? [run[i + 1]] : []));
    expect(mounts).toEqual([
      `type=bind,source=${m.roots[0].perTaskDir},target=${r.homesRoot}`,
      `type=bind,source=${m.roots[1].perTaskDir},target=${r.sqliteRoot}`,
      `type=bind,source=${r.codexBinary},target=/opt/papercusp/codex,readonly`,
      `type=bind,source=${r.busybox},target=/opt/papercusp/busybox,readonly`,
      `type=bind,source=${r.hookShim},target=/opt/papercusp/hook-shim,readonly`,
    ]);
    // The shared roots themselves are never a mount source: no other session's home reaches the container.
    expect(run.some((a) => a.includes(`source=${r.homesRoot},`) || a.includes(`source=${r.sqliteRoot},`))).toBe(false);
    // Mounts precede the image (docker run flag order).
    expect(run.indexOf('--mount')).toBeLessThan(run.indexOf(task().graderMeta!['dockerImage'] as string));
  });

  it('a seam without inContainerCodex adds no mounts, no handle field, and no teardown exec', async () => {
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec });
    const h = await seam.clone(task());
    expect(h.inContainerCodex).toBeUndefined();
    expect(calls.find((c) => c[0] === 'run')!.includes('--mount')).toBe(false);
    await seam.teardown(h);
    expect(calls.filter((c) => c[0] === 'exec')).toEqual([]);
  });

  it('a failed docker run releases the per-task dirs and the egress network instead of leaking them', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({}, { runCode: 125 });
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
    await expect(seam.clone(task())).rejects.toThrow(/docker run failed/);
    for (const root of [r.homesRoot, r.sqliteRoot]) {
      const siblings = readdirSync(dirname(root)).filter((n) => n.includes('.bench-'));
      expect(siblings).toEqual([]);
    }
    expect(calls.map((c) => c[0])).toEqual(['egress-open', 'run', 'egress-release']);
  });

  it('clone puts the container on its own egress network for every mode and records it on the handle', async () => {
    const r = roots();
    for (const networkMode of ['no-network', 'allowlist']) {
      const { exec, calls } = fakeDocker({});
      const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
      const h = await seam.clone(task({ networkMode }));
      expect(calls[0]).toEqual(['egress-open', 'egress-net-1', h.instanceId]);
      const run = calls.find((c) => c[0] === 'run')!;
      expect(run[run.indexOf('--network') + 1]).toBe('egress-net-1');
      expect(run).toContain(`PX_TASK_NETWORK_MODE=${networkMode}`);
      expect(h.taskNetwork).toBe('egress-net-1');
      await seam.teardown(h);
    }
  });

  it('teardown releases the egress network only after the container is removed, and only once', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
    const h = await seam.clone(task({ networkMode: 'allowlist' }));
    await seam.teardown(h);
    await seam.teardown(h);
    const rmAt = calls.findIndex((c) => c[0] === 'rm');
    const releases = calls.flatMap((c, i) => (c[0] === 'egress-release' ? [i] : []));
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeGreaterThan(rmAt);
  });

  it('an unknown declared mode refuses before any egress network is opened', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
    await expect(seam.clone(task({ networkMode: 'public' }))).rejects.toThrow(/cannot enforce/);
    expect(calls).toEqual([]);
  });

  it('an egress that cannot open a network fails the clone before any container or per-task dir exists', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls, { failOpen: true }) });
    await expect(seam.clone(task())).rejects.toThrow(/egress open failed/);
    expect(calls).toEqual([]);
    for (const root of [r.homesRoot, r.sqliteRoot]) {
      expect(existsSync(dirname(root)) ? readdirSync(dirname(root)).filter((n) => n.includes('.bench-')) : []).toEqual([]);
    }
  });

  it('inContainerCodex and egress must be configured together', () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner } })).toThrow(/requires egress/);
    expect(() => makeFrontierSweCloneGradeSeam({ version: 'v', exec, egress: fakeEgress(calls) })).toThrow(/only for an in-container Codex/);
  });

  it('teardown hands the mounts back to the host user inside the container BEFORE removing it, then moves each relocated session back into its shared root', async () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const seam = makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner }, egress: fakeEgress(calls) });
    const h = await seam.clone(task());
    const [homes, sqlite] = h.inContainerCodex!.roots;
    // Another session that never ran in this container.
    mkdirSync(join(r.homesRoot, 'session-3'));
    writeFileSync(join(r.homesRoot, 'session-3', 'config.toml'), 'other');
    relocate(homes.hostRoot, homes.perTaskDir, 'session-7', 'rollout.jsonl');
    relocate(sqlite.hostRoot, sqlite.perTaskDir, 'session-7', 'state.sqlite');
    // Something the container wrote at the mount root, with no host reference.
    writeFileSync(join(homes.perTaskDir, 'stray.txt'), 'x');

    await seam.teardown(h);

    const chownAt = calls.findIndex((c) => c[0] === 'exec' && c.includes('chown'));
    const rmAt = calls.findIndex((c) => c[0] === 'rm');
    expect(chownAt).toBeGreaterThanOrEqual(0);
    expect(chownAt).toBeLessThan(rmAt);
    expect(calls[chownAt]).toEqual(['exec', '-u', '0', h.containerId, 'chown', '-R', '4242:4343', r.homesRoot, r.sqliteRoot]);
    // The relocated session is a real dir in its shared root again, with its contents.
    for (const [root, file] of [[r.homesRoot, 'rollout.jsonl'], [r.sqliteRoot, 'state.sqlite']] as const) {
      const p = join(root, 'session-7');
      expect(lstatSync(p).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(p, file), 'utf8')).toBe(file);
    }
    expect(readFileSync(join(r.homesRoot, 'session-3', 'config.toml'), 'utf8')).toBe('other');
    expect(existsSync(homes.perTaskDir)).toBe(false);
    expect(existsSync(sqlite.perTaskDir)).toBe(false);
    expect(existsSync(join(r.homesRoot, 'stray.txt'))).toBe(false);
  });

  it('restore only follows a host symlink that points into the per-task dir; a foreign symlink is left alone', () => {
    const r = roots();
    mkdirSync(r.homesRoot, { recursive: true });
    const perTaskDir = mkdtempSync(join(dirname(r.homesRoot), 'su-codex-homes.bench-t-'));
    mkdirSync(join(perTaskDir, 'session-9'));
    const elsewhere = join(r.base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(r.homesRoot, 'session-9'));
    const report = restoreRelocatedSessions([{ hostRoot: r.homesRoot, perTaskDir }]);
    expect(report.restored).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(readlinkSync(join(r.homesRoot, 'session-9'))).toBe(elsewhere);
    expect(existsSync(perTaskDir)).toBe(false);
    // Idempotent: a second pass over a removed per-task dir is a no-op, not an error.
    expect(restoreRelocatedSessions([{ hostRoot: r.homesRoot, perTaskDir }]).errors).toEqual([]);
  });

  it('refuses a bad config at construction, before any container starts', () => {
    const r = roots();
    const { exec, calls } = fakeDocker({});
    const mk = (over: Record<string, unknown>) => () =>
      makeFrontierSweCloneGradeSeam({ version: 'v', exec, inContainerCodex: { ...r, hostOwner: owner, ...over }, egress: fakeEgress(calls) });
    expect(mk({ homesRoot: 'relative/homes' })).toThrow(/must be absolute/);
    expect(mk({ codexBinary: join(r.base, 'co,dex') })).toThrow(/contains ','/);
    expect(mk({ sqliteRoot: join(r.homesRoot, 'sqlite') })).toThrow(/must not nest/);
    expect(calls).toEqual([]);
  });
});

describe('checkFrontierSweIntegrity — oracle mode (the gold control, P-007)', () => {
  /** A docker stub whose `diff` reports exactly what Harbor's oracle stage writes: /solution plus the /app marker. */
  function diffExec(lines: string[]): ProcExec {
    return async (_cmd, args) =>
      args[0] === 'diff' ? { stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };
  }
  const oracleWrites = ['A /solution', 'A /solution/solve.sh', 'C /app', 'A /app/.harbor_oracle_marker'];

  it('oracle mode tolerates the staged /solution (Harbor uploads it before running solve.sh)', async () => {
    const r = await checkFrontierSweIntegrity(diffExec(oracleWrites), task(), 'cid', { oracle: true });
    expect(r.verdict).toBe('clean');
    expect(r.protectedPaths).not.toContain('/solution');
  });

  it('a non-oracle run that writes /solution is still tampered', async () => {
    const r = await checkFrontierSweIntegrity(diffExec(oracleWrites), task(), 'cid');
    expect(r.verdict).toBe('tampered');
    expect(r.protectedPaths).toContain('/solution');
  });

  it('oracle mode keeps every OTHER protected path protected', async () => {
    const r = await checkFrontierSweIntegrity(diffExec([...oracleWrites, 'A /logs/verifier/reward.txt']), task(), 'cid', { oracle: true });
    expect(r.verdict).toBe('tampered');
  });
});
