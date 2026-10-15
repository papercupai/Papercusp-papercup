import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { DetectedHardware } from '../provisioner/hardware-detect';
import { probeScopeSupport, resetScopeProbe } from '../task-manager/managed-spawn';
import { _registeredSidecarShutdownLabelsForTests } from '../process-supervision/sidecar-spawn-shared';
import {
  ensureLocalWhisper,
  fetchWhisperWithRecovery,
  stopLocalWhisper,
  whisperSttBaseUrl,
  __resetLocalWhisperStateForTests,
} from './local-whisper-service';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill(_sig?: string): boolean {
    this.killed = true;
    this.exitCode = 143;
    this.emit('exit', 143);
    return true;
  }
}

const linuxHw: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: null, notes: [] };

/** Provision a fake-but-integrity-valid whisper cache + model into `home`. */
async function provisionFakeWhisper(home: string): Promise<string> {
  const binDir = join(home, '.papercusp/backends/whisper-server/v1.9.1/linux-x64-cpu');
  await mkdir(binDir, { recursive: true });
  const binContent = 'fake-whisper-server-binary';
  const binPath = join(binDir, 'whisper-server');
  await writeFile(binPath, binContent);
  const sha256 = createHash('sha256').update(binContent).digest('hex');
  await writeFile(
    join(binDir, 'manifest.json'),
    JSON.stringify({ version: 'v1.9.1', platformKey: 'linux-x64-cpu', source: 'prebuilt', sha256, builtAt: 'x' }),
  );
  const modelDir = join(home, '.papercusp/models/whisper');
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'ggml-base.bin'), 'fake-weights');
  return binPath;
}

describe('local-whisper-service', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'local-whisper-test-'));
    __resetLocalWhisperStateForTests();
    // WI-39563: the whisper-server is now launched through `managedSpawn`, which asks
    // ONCE PER PROCESS whether this host can create transient user scopes — and it asks
    // using the caller's `spawnFn`. Ours is a whisper-payload fake, so without this the
    // probe calls it with `systemd-run`, clobbers the recorded `spawned` argv, and then
    // SIGKILLs the shared FakeChild the fake hands back — which the health gate reads as
    // "the server exited during startup". Two other suites hit the same seam and solve it
    // the same way (spawner-sidecar-spawn.test.ts, spawner-sidecar-cgroup-confinement.test.ts).
    //
    // Pinning the probe UNSUPPORTED keeps these cases on the direct-launch branch, so they
    // still assert the whisper spawn plan itself (argv, health-gate, respawn) rather than a
    // systemd-run wrapper. The CONFINED branch is covered by the sidecar confinement suite;
    // the point here is that enrolment did not change the whisper launch plan.
    resetScopeProbe();
    await probeScopeSupport((() => {
      throw new Error('no systemd in test');
    }) as never);
    // Pinning it unsupported makes managedSpawn report itself UNCONFINED once per process,
    // on console.log/warn. vitest-fail-on-console polices warn/error, so an ambient host
    // condition must not red this file (same rationale as the sidecar suites).
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    __resetLocalWhisperStateForTests();
    await rm(home, { recursive: true, force: true });
  });

  it('an external server always wins — no hardware probe, no spawn', async () => {
    const r = await ensureLocalWhisper({
      home,
      externalUrl: 'http://external:2022',
      probe: async (u) => u === 'http://external:2022',
      detectHw: async () => {
        throw new Error('must not probe hardware when external answers');
      },
      spawnFn: (() => {
        throw new Error('must not spawn');
      }) as never,
    });
    expect(r).toEqual({ ok: true, url: 'http://external:2022', source: 'external' });
  });

  it('un-provisioned box: clean not-provisioned reason, never a spawn or download', async () => {
    const r = await ensureLocalWhisper({
      home,
      probe: async () => false,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      spawnFn: (() => {
        throw new Error('must not spawn');
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-provisioned');
  });

  it('provisioned box: spawns the cached binary, health-gates, and serves the managed url', async () => {
    const binPath = await provisionFakeWhisper(home);
    let spawned: { cmd: string; args: string[]; cwd?: string } | null = null;
    const child = new FakeChild();
    let managedUp = false;
    const r = await ensureLocalWhisper({
      home,
      port: 12345,
      probe: async (u) => u.includes('12345') && managedUp,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: ((cmd: string, args: string[], options: { cwd?: string }) => {
        spawned = { cmd, args, cwd: options.cwd };
        managedUp = true; // "server boots instantly"
        return child as unknown as ChildProcess;
      }) as never,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('managed');
    expect(r.url).toBe('http://127.0.0.1:12345');
    expect(spawned!.cmd).toBe(binPath);
    expect(spawned!.args).toContain('--inference-path');
    expect(spawned!.args).toContain('/v1/audio/transcriptions');
    const workingDirectory = join(home, '.papercusp', 'runtime', 'whisper');
    expect(spawned!.cwd).toBe(workingDirectory);
    expect((await stat(workingDirectory)).isDirectory()).toBe(true);
    // Conversion output remains writable independently of the caller's checkout.
    await writeFile(join(workingDirectory, 'conversion-control.wav'), 'fixture');
    expect(_registeredSidecarShutdownLabelsForTests()).toContain('local-whisper-service');

    // Second call: managed child reused, no new spawn.
    let respawned = false;
    const again = await ensureLocalWhisper({
      home,
      port: 12345,
      probe: async (u) => u.includes('12345') && managedUp,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      spawnFn: (() => {
        respawned = true;
        return new FakeChild() as unknown as ChildProcess;
      }) as never,
    });
    expect(again.ok).toBe(true);
    expect(respawned).toBe(false);

    await stopLocalWhisper();
    expect(child.killed).toBe(true);
  });

  it('a child that dies during startup reads spawn-failed (not a hang)', async () => {
    await provisionFakeWhisper(home);
    const r = await ensureLocalWhisper({
      home,
      probe: async () => false,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 500,
      spawnFn: (() => {
        const c = new FakeChild();
        c.exitCode = 127; // dead before the first health poll
        return c as unknown as ChildProcess;
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('spawn-failed');
    expect(r.detail).toMatch(/exited 127/);
  });

  it('spawn-storm guard: refuses a 4th spawn inside the window', async () => {
    await provisionFakeWhisper(home);
    const mkDeps = () => ({
      home,
      probe: async () => false,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 20,
      spawnFn: (() => new FakeChild() as unknown as ChildProcess) as never,
    });
    for (let i = 0; i < 3; i++) {
      const r = await ensureLocalWhisper(mkDeps());
      expect(r.reason).toBe('unhealthy'); // spawned, never answered, timed out
    }
    const fourth = await ensureLocalWhisper(mkDeps());
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('spawn-storm');
  });

  it('concurrent ensure calls coalesce onto ONE spawn', async () => {
    await provisionFakeWhisper(home);
    let spawns = 0;
    let managedUp = false;
    const deps = {
      home,
      port: 23456,
      probe: async (u: string) => u.includes('23456') && managedUp,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: (() => {
        spawns++;
        setTimeout(() => {
          managedUp = true;
        }, 20);
        return new FakeChild() as unknown as ChildProcess;
      }) as never,
    };
    const [a, b, c] = await Promise.all([ensureLocalWhisper(deps), ensureLocalWhisper(deps), ensureLocalWhisper(deps)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(spawns).toBe(1);
  });

  // ── WI-4501: never stack a duplicate listener on an occupied port ─────────────────────────
  // whisper-server binds SO_REUSEPORT, so a duplicate spawn SUCCEEDS silently and the kernel
  // round-robins /health across the pile — 17 servers stacked on :2022 before this guard.

  it('a TCP-bound port is never spawned onto — a still-loading occupant that turns healthy is adopted as external', async () => {
    await provisionFakeWhisper(home);
    let occupantUp = false;
    setTimeout(() => {
      occupantUp = true;
    }, 20);
    const r = await ensureLocalWhisper({
      home,
      port: 34567,
      probe: async (u) => u.includes('34567') && occupantUp,
      tcpProbe: async () => true, // something already holds the port
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: (() => {
        throw new Error('must NEVER spawn onto a bound port');
      }) as never,
    });
    expect(r).toEqual({ ok: true, url: 'http://127.0.0.1:34567', source: 'external' });
  });

  it('a TCP-bound port that never answers /health → port-occupied, and still no spawn', async () => {
    await provisionFakeWhisper(home);
    const r = await ensureLocalWhisper({
      home,
      port: 34568,
      probe: async () => false,
      tcpProbe: async () => true,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 60,
      spawnFn: (() => {
        throw new Error('must NEVER spawn onto a bound port');
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('port-occupied');
  });

  // ── WI-4501: cross-PROCESS spawn lock — state.starting only coalesces ONE process; a deploy
  // restarts several hono-hosts at once and each spawned "its own singleton".

  it('a fresh foreign spawn lock suppresses the spawn — the sibling’s server is polled and adopted', async () => {
    await provisionFakeWhisper(home);
    await mkdir(join(home, '.papercusp'), { recursive: true });
    await writeFile(join(home, '.papercusp/whisper-spawn.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
    let siblingUp = false;
    setTimeout(() => {
      siblingUp = true;
    }, 20);
    const r = await ensureLocalWhisper({
      home,
      port: 34569,
      probe: async (u) => u.includes('34569') && siblingUp,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: (() => {
        throw new Error('must not spawn while a sibling process holds the lock');
      }) as never,
    });
    expect(r).toEqual({ ok: true, url: 'http://127.0.0.1:34569', source: 'external' });
  });

  it('a STALE foreign lock (holder died mid-spawn) is taken over, and the lock is released after the spawn settles', async () => {
    await provisionFakeWhisper(home);
    const lockPath = join(home, '.papercusp/whisper-spawn.lock');
    await mkdir(join(home, '.papercusp'), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 120_000 }));
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    let managedUp = false;
    let spawns = 0;
    const r = await ensureLocalWhisper({
      home,
      port: 34570,
      probe: async (u) => u.includes('34570') && managedUp,
      tcpProbe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: (() => {
        spawns++;
        managedUp = true;
        return new FakeChild() as unknown as ChildProcess;
      }) as never,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('managed');
    expect(spawns).toBe(1);
    // The lock must not outlive the spawn attempt — a leftover lock would make every OTHER
    // process read "sibling mid-spawn" for the next 60s.
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('whisperSttBaseUrl falls back to the external URL when nothing is provisioned (same error surface as before)', () => {
    const url = whisperSttBaseUrl({ externalUrl: 'http://localhost:29999' });
    expect(url).toBe('http://localhost:29999');
  });

  it('whisperSttBaseUrl does NO I/O — it never probes on the utterance hot path', () => {
    __resetLocalWhisperStateForTests(); // no managed child → the pure external-URL read
    // The regression this guards: the first cut called ensureLocalWhisper() here, adding a
    // health-probe round-trip to EVERY transcription (agent-peer.test.ts caught it as a
    // second fetch). The base URL must be a pure read of lifecycle state.
    const probe = vi.fn(async () => true);
    const url = whisperSttBaseUrl({ externalUrl: 'http://localhost:29999', probe });
    expect(url).toBe('http://localhost:29999');
    expect(probe).not.toHaveBeenCalled();
  });

  describe('failure-only warm + retry recovery', () => {
    it('does not warm or retry a successful request', async () => {
      const warm = vi.fn(async () => ({ ok: true }));
      const request = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));

      const response = await fetchWhisperWithRecovery(request, { externalUrl: 'http://whisper.test' }, { warm });

      expect(response.status).toBe(200);
      expect(request).toHaveBeenCalledTimes(1);
      expect(warm).not.toHaveBeenCalled();
    });

    it('warms once and retries a transport failure', async () => {
      const warm = vi.fn(async () => ({ ok: true }));
      let attempts = 0;
      const request = vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error('ECONNREFUSED');
        return new Response(JSON.stringify({ text: 'recovered' }), { status: 200 });
      });

      const response = await fetchWhisperWithRecovery(request, { externalUrl: 'http://whisper.test' }, { warm });

      expect(response.status).toBe(200);
      expect(request).toHaveBeenCalledTimes(2);
      expect(warm).toHaveBeenCalledTimes(1);
    });

    it('warms + retries 5xx, but leaves client errors and rate limits single-shot', async () => {
      const warm = vi.fn(async () => ({ ok: true }));
      const serverError = vi.fn(async () => new Response('down', { status: 503 }));
      const serverResponse = await fetchWhisperWithRecovery(
        serverError,
        { externalUrl: 'http://whisper.test' },
        { warm },
      );
      expect(serverResponse.status).toBe(503);
      expect(serverError).toHaveBeenCalledTimes(2);
      expect(warm).toHaveBeenCalledTimes(1);

      warm.mockClear();
      const clientError = vi.fn(async () => new Response('bad audio', { status: 400 }));
      await fetchWhisperWithRecovery(clientError, { externalUrl: 'http://whisper.test' }, { warm });
      expect(clientError).toHaveBeenCalledTimes(1);
      expect(warm).not.toHaveBeenCalled();

      const rateLimited = vi.fn(async () => new Response('slow down', { status: 429 }));
      await fetchWhisperWithRecovery(rateLimited, { externalUrl: 'http://whisper.test' }, { warm });
      expect(rateLimited).toHaveBeenCalledTimes(1);
      expect(warm).not.toHaveBeenCalled();
    });
  });
});
