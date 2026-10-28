/**
 * Recurrence guards for the pid-keyed sidecar socket mechanics
 * (plan spawner-sidecar-cluster-fanout-2026-08-12, P-005).
 *
 * The defect these exist to keep dead: the spawner sidecar's "already spawned"
 * latch is MODULE-scoped, i.e. per PROCESS. Under `node:cluster` each of N workers
 * is a separate process, so each independently resolved its OWN pid-keyed socket
 * path, found no sidecar there, and spawned a full ~450MB `hono-host.mjs`. Measured
 * 2026-08-12 at PAPERCUSP_CLUSTER=16: 16 sidecars, 9.5GB, 0.004 cores each.
 *
 * FALSIFIABILITY: `legacyPerProcessResolve` below is a deliberately-wrong control
 * kept PERMANENTLY in this file — it reproduces the pre-fix per-process keying. The
 * collapse test asserts the real resolver converges AND that the control does not,
 * so a regression that silently reverts the pin cannot leave these tests green. Per
 * the repo's mutation-probe guidance this is tier 1 (a control in the test file);
 * nothing here mutates the shared tree.
 */
import { describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { existsSync, renameSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listenUnixSocketExclusive,
  ownerPidFromPidKeyedPath,
  pidKeyedSocketPath,
  pinSocketForCluster,
  probeUnixSocketAlive,
  probeUnixSocketState,
  reapOrphanedPidKeyedSockets,
} from './pid-keyed-socket';

const PREFIX = 'spawner';
const ENV_VAR = 'PAPERCUSP_SPAWNER_IPC_SOCKET';
const TMP = '/tmp';

/**
 * THE BUG, preserved as a control: what every process did before the pin — resolve
 * the socket from its OWN pid, ignoring any inherited pin. Kept so the collapse
 * assertion below is provably able to fail.
 */
function legacyPerProcessResolve(pid: number): string {
  return path.join(TMP, `papercusp-${PREFIX}-${pid}.sock`);
}

/** Resolve exactly as the real code does: inherited env pin wins over own pid. */
function resolveWithEnv(env: NodeJS.ProcessEnv, pid: number): string {
  const fromEnv = env[ENV_VAR];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return pidKeyedSocketPath(PREFIX, pid, TMP);
}

describe('cluster pin — the fan-out guard', () => {
  it('collapses N workers onto ONE socket, and the pre-fix control does not', () => {
    const PRIMARY_PID = 3097954; // the real primary observed on this box
    const WORKER_PIDS = [3104405, 3104453, 3104510, 3104607, 3104692, 3104779];

    // The PRIMARY pins before forking; workers inherit that env fragment.
    const primaryEnv: NodeJS.ProcessEnv = {};
    const fragment = pinSocketForCluster({
      prefix: PREFIX,
      envVar: ENV_VAR,
      clusterWorkers: 16,
      env: primaryEnv,
      pid: PRIMARY_PID,
      tmpdir: TMP,
    });

    const workerPaths = WORKER_PIDS.map((pid) => resolveWithEnv({ ...fragment }, pid));
    expect(new Set(workerPaths).size).toBe(1);
    expect(workerPaths[0]).toBe(pidKeyedSocketPath(PREFIX, PRIMARY_PID, TMP));

    // CONTROL: the pre-fix resolver gives every worker its own path — one sidecar
    // each. If this ever collapses too, the test is no longer measuring anything.
    const legacyPaths = WORKER_PIDS.map((pid) => legacyPerProcessResolve(pid));
    expect(new Set(legacyPaths).size).toBe(WORKER_PIDS.length);
  });

  it('is a no-op in single-process mode (no fork ⇒ nothing to inherit)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(pinSocketForCluster({ prefix: PREFIX, envVar: ENV_VAR, clusterWorkers: 1, env, pid: 42, tmpdir: TMP })).toEqual({});
    expect(env[ENV_VAR]).toBeUndefined();
  });

  it('honors an explicit socket override instead of clobbering it', () => {
    const env: NodeJS.ProcessEnv = { [ENV_VAR]: '/run/pinned/custom.sock' };
    const frag = pinSocketForCluster({ prefix: PREFIX, envVar: ENV_VAR, clusterWorkers: 8, env, pid: 5, tmpdir: TMP });
    expect(frag[ENV_VAR]).toBe('/run/pinned/custom.sock');
  });

  it('pins the PRIMARY pid, keeping the owner derivable (D-011 survives the fix)', () => {
    // The whole reason the fix keys by the primary rather than a fixed path: an
    // orphan must stay detectable. A fixed path would break this assertion.
    const env: NodeJS.ProcessEnv = {};
    const frag = pinSocketForCluster({ prefix: PREFIX, envVar: ENV_VAR, clusterWorkers: 4, env, pid: 777, tmpdir: TMP });
    expect(ownerPidFromPidKeyedPath(PREFIX, frag[ENV_VAR])).toBe(777);
  });
});

describe('ownerPidFromPidKeyedPath', () => {
  it('reads the owner pid out of a pid-keyed name', () => {
    expect(ownerPidFromPidKeyedPath(PREFIX, '/tmp/papercusp-spawner-1234.sock')).toBe(1234);
  });

  it('returns null (UNKNOWN, never "orphaned") for a non-pid-keyed path', () => {
    // Load-bearing: treating null as orphaned would delete every explicitly
    // configured socket on the box.
    expect(ownerPidFromPidKeyedPath(PREFIX, '/run/pinned/custom.sock')).toBeNull();
    expect(ownerPidFromPidKeyedPath(PREFIX, '/tmp/papercusp-spawner-.sock')).toBeNull();
  });

  it('does not confuse one sidecar kind for another', () => {
    expect(ownerPidFromPidKeyedPath('spawner', '/tmp/papercusp-substrate-9.sock')).toBeNull();
    expect(ownerPidFromPidKeyedPath('substrate', '/tmp/papercusp-substrate-9.sock')).toBe(9);
  });
});

describe('reapOrphanedPidKeyedSockets', () => {
  const files = [
    'papercusp-spawner-100.sock', // dead   -> remove
    'papercusp-spawner-200.sock', // alive  -> keep
    'papercusp-spawner-300.sock', // OUR own -> keep
    'papercusp-substrate-400.sock', // other kind -> untouched
    'unrelated-file.txt', // not ours -> untouched
  ];

  it('removes only sockets whose owner is derivable AND provably dead', () => {
    const unlinked: string[] = [];
    const res = reapOrphanedPidKeyedSockets({
      prefix: PREFIX,
      tmpdir: TMP,
      listDir: () => files,
      isAlive: (pid) => pid === 200,
      unlink: (p) => unlinked.push(p),
      ownPid: 300,
    });
    expect(unlinked).toEqual(['/tmp/papercusp-spawner-100.sock']);
    expect(res.removed).toHaveLength(1);
    expect(res.kept).toContain('/tmp/papercusp-spawner-200.sock');
    expect(res.kept).toContain('/tmp/papercusp-spawner-300.sock');
    // A different sidecar kind is not ours to reap.
    expect(unlinked.join()).not.toContain('substrate');
  });

  it('KEEPS a socket whose liveness check threw — undetermined is not dead', () => {
    const unlinked: string[] = [];
    const res = reapOrphanedPidKeyedSockets({
      prefix: PREFIX,
      tmpdir: TMP,
      listDir: () => ['papercusp-spawner-100.sock'],
      isAlive: () => {
        throw new Error('EPERM');
      },
      unlink: (p) => unlinked.push(p),
      ownPid: 1,
    });
    expect(unlinked).toEqual([]);
    expect(res.kept).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
  });

  it('never throws when the directory cannot be read', () => {
    const res = reapOrphanedPidKeyedSockets({
      prefix: PREFIX,
      tmpdir: TMP,
      listDir: () => {
        throw new Error('EACCES');
      },
    });
    expect(res.removed).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });

  it('records an unlink failure without aborting the rest of the sweep', () => {
    const res = reapOrphanedPidKeyedSockets({
      prefix: PREFIX,
      tmpdir: TMP,
      listDir: () => ['papercusp-spawner-100.sock', 'papercusp-spawner-101.sock'],
      isAlive: () => false,
      unlink: (p) => {
        if (p.endsWith('100.sock')) throw new Error('ENOENT (raced)');
      },
      ownPid: 1,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.removed).toEqual(['/tmp/papercusp-spawner-101.sock']);
  });
});

describe('probeUnixSocketAlive — the cross-process question', () => {
  function fakeConnect(behaviour: 'connect' | 'error' | 'hang') {
    return ((_p: string, cb?: () => void) => {
      const handlers: Record<string, (e?: unknown) => void> = {};
      const sock = {
        on(ev: string, h: (e?: unknown) => void) {
          handlers[ev] = h;
          return sock;
        },
        destroy: vi.fn(),
      };
      if (behaviour === 'connect') setTimeout(() => cb?.(), 0);
      if (behaviour === 'error') setTimeout(() => handlers.error?.(new Error('ECONNREFUSED')), 0);
      return sock as never;
    }) as never;
  }

  it('is TRUE when someone is listening (⇒ adopt, do not spawn)', async () => {
    await expect(probeUnixSocketAlive('/tmp/x.sock', { connect: fakeConnect('connect') })).resolves.toBe(true);
  });

  it('is FALSE when the socket file is stale with no server behind it', async () => {
    // The exact reason this is a connect probe and not existsSync: 185 of 206 socket
    // files on this box had no listener.
    await expect(probeUnixSocketAlive('/tmp/x.sock', { connect: fakeConnect('error') })).resolves.toBe(false);
  });

  it('is FALSE on timeout rather than hanging the spawn path', async () => {
    await expect(
      probeUnixSocketAlive('/tmp/x.sock', { timeoutMs: 5, connect: fakeConnect('hang') }),
    ).resolves.toBe(false);
  });

  it('resolves FALSE (never throws) when connect itself throws', async () => {
    const throwing = (() => {
      throw new Error('EACCES');
    }) as never;
    await expect(probeUnixSocketAlive('/tmp/x.sock', { connect: throwing })).resolves.toBe(false);
  });
});

describe('probeUnixSocketAlive — a STALLED prober must not read a live listener as dead', () => {
  // host-memory-reduction-2026-09-27 P-005: a busy :3070 worker whose event loop
  // stalled past the timeout right after dialling saw the timer fire before the
  // poll phase delivered its (already completed) connect, concluded "dead", and
  // spawned a second full spawner sidecar. Real sockets here, because the defect
  // lives in event-loop phase ordering that a fake connect cannot reproduce.
  const TIMEOUT_MS = 20;
  const STALL_MS = 80;

  // Deliberately-wrong control, kept PERMANENTLY: the pre-fix probe, which
  // settles "dead" straight from the timer. It must read the live listener as
  // dead under the same stall, or the trial is not exercising the race at all.
  function legacyProbe(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const sock = net.createConnection(socketPath, () => done(true));
      const done = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(alive);
      };
      const timer = setTimeout(() => done(false), TIMEOUT_MS);
      sock.on('error', () => done(false));
    });
  }

  // Start from the check phase, so the stall ends before the next timers phase —
  // the ordering a busy worker hits.
  async function stalledTrial(probe: (p: string) => Promise<boolean>, socketPath: string): Promise<boolean> {
    await new Promise((r) => setImmediate(r));
    const verdict = probe(socketPath);
    const t0 = Date.now();
    while (Date.now() - t0 < STALL_MS) {
      /* synchronous work right after the probe dialled */
    }
    return verdict;
  }

  it('is TRUE under a stall that makes the pre-fix control report the same live listener dead', async () => {
    const socketPath = path.join(os.tmpdir(), `pid-keyed-probe-${process.pid}-${Date.now()}.sock`);
    const server = net.createServer((c) => c.end()).listen(socketPath);
    await once(server, 'listening');
    try {
      expect(await stalledTrial(legacyProbe, socketPath)).toBe(false);
      for (let i = 0; i < 5; i++) {
        expect(await stalledTrial((p) => probeUnixSocketAlive(p, { timeoutMs: TIMEOUT_MS }), socketPath)).toBe(true);
      }
    } finally {
      server.close();
      rmSync(socketPath, { force: true });
    }
  });

  it('is still FALSE under the same stall when nothing is listening', async () => {
    const socketPath = path.join(os.tmpdir(), `pid-keyed-probe-none-${process.pid}-${Date.now()}.sock`);
    expect(await stalledTrial((p) => probeUnixSocketAlive(p, { timeoutMs: TIMEOUT_MS }), socketPath)).toBe(false);
  });
});

describe('listenUnixSocketExclusive — a sidecar must not take a live sidecar\'s path', () => {
  // host-memory-reduction-2026-09-27 P-005: the sidecars unlinked their path and
  // then listened, which on a unix socket always succeeds. A second sidecar thereby
  // detached the first from the path and both kept running (~2 GB each on :3070).
  const tmpSock = (tag: string) => path.join(os.tmpdir(), `pid-keyed-listen-${tag}-${process.pid}-${Date.now()}.sock`);

  /** A server that answers every connection with its own name. A probe hangs up as
   *  soon as it connects, so the reply can hit ECONNRESET; the real sidecar servers
   *  handle socket errors the same way. */
  function named(name: string): net.Server {
    return net.createServer((c) => {
      c.on('error', () => {});
      c.end(name);
    });
  }

  async function whoAnswers(socketPath: string): Promise<string> {
    const c = net.createConnection(socketPath);
    c.setEncoding('utf8');
    let data = '';
    c.on('data', (d) => (data += d));
    await once(c, 'end');
    return data;
  }

  // Deliberately-wrong control, kept PERMANENTLY: the pre-fix bind. It must steal
  // the path from the live server, or the in-use assertion below proves nothing.
  async function legacyListen(server: net.Server, socketPath: string): Promise<void> {
    rmSync(socketPath, { force: true });
    server.listen(socketPath);
    await once(server, 'listening');
  }

  it('the pre-fix bind STEALS a live path (control)', async () => {
    const socketPath = tmpSock('legacy');
    const first = named('first').listen(socketPath);
    await once(first, 'listening');
    const second = named('second');
    try {
      await legacyListen(second, socketPath);
      expect(await whoAnswers(socketPath)).toBe('second');
    } finally {
      first.close();
      second.close();
      rmSync(socketPath, { force: true });
    }
  });

  it('resolves in-use on a live path and leaves the live server reachable there', async () => {
    const socketPath = tmpSock('live');
    const first = named('first').listen(socketPath);
    await once(first, 'listening');
    const second = named('second');
    try {
      await expect(listenUnixSocketExclusive(second, socketPath)).resolves.toBe('in-use');
      expect(second.listening).toBe(false);
      expect(await whoAnswers(socketPath)).toBe('first');
    } finally {
      first.close();
      rmSync(socketPath, { force: true });
    }
  });

  it('reclaims a STALE socket file (no listener) and serves it', async () => {
    const socketPath = tmpSock('stale');
    // A real socket inode with nobody listening: bind elsewhere, move the name onto
    // our path, then close. (close() only unlinks the ORIGINAL name.)
    const bound = `${socketPath}.bound`;
    const gone = net.createServer().listen(bound);
    await once(gone, 'listening');
    renameSync(bound, socketPath);
    gone.close();
    await once(gone, 'close');
    expect(existsSync(socketPath)).toBe(true);
    expect(await probeUnixSocketAlive(socketPath)).toBe(false);

    const server = named('fresh');
    try {
      await expect(listenUnixSocketExclusive(server, socketPath)).resolves.toBe('listening');
      expect(await whoAnswers(socketPath)).toBe('fresh');
    } finally {
      server.close();
      rmSync(socketPath, { force: true });
    }
  });

  it('listens normally on an empty path', async () => {
    const socketPath = tmpSock('empty');
    const server = named('only');
    try {
      await expect(listenUnixSocketExclusive(server, socketPath)).resolves.toBe('listening');
      expect(await whoAnswers(socketPath)).toBe('only');
    } finally {
      server.close();
      rmSync(socketPath, { force: true });
    }
  });

  it('rejects a non-EADDRINUSE listen error instead of probing or unlinking', async () => {
    const socketPath = path.join(os.tmpdir(), `pid-keyed-listen-nodir-${process.pid}-${Date.now()}`, 'x.sock');
    const probe = vi.fn(async () => 'dead' as const);
    const unlink = vi.fn();
    await expect(listenUnixSocketExclusive(net.createServer(), socketPath, { probe, unlink })).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  // WI-6554700010042230: a vitest-spawned sidecar took bg-host's live spawner path.
  // A busy listener answers a probe with EAGAIN or nothing at all; neither proves the
  // path stale, so the bind must refuse instead of unlinking the live server's name.
  it('refuses (never unlinks) a LIVE path when the probe cannot prove it stale', async () => {
    const socketPath = tmpSock('busy');
    const original = named('original');
    original.listen(socketPath);
    await once(original, 'listening');
    const probe = vi.fn(async () => 'indeterminate' as const);
    const unlink = vi.fn();
    const second = named('hijacker');
    try {
      await expect(listenUnixSocketExclusive(second, socketPath, { probe, unlink })).resolves.toBe('in-use');
      expect(probe).toHaveBeenCalledTimes(1);
      expect(unlink).not.toHaveBeenCalled();
      expect(await whoAnswers(socketPath)).toBe('original');
    } finally {
      second.close();
      original.close();
      rmSync(socketPath, { force: true });
    }
  });
});

describe('probeUnixSocketState — only ECONNREFUSED/ENOENT prove a path stale', () => {
  function erroringConnect(code: string | undefined) {
    return ((_p: string) => {
      const handlers: Record<string, (e?: unknown) => void> = {};
      const sock = {
        on(ev: string, h: (e?: unknown) => void) {
          handlers[ev] = h;
          return sock;
        },
        destroy: vi.fn(),
      };
      setTimeout(() => handlers.error?.(Object.assign(new Error(code ?? 'boom'), { code })), 0);
      return sock as never;
    }) as never;
  }

  it.each([
    ['ECONNREFUSED', 'dead'],
    ['ENOENT', 'dead'],
    ['EAGAIN', 'indeterminate'],
    ['EACCES', 'indeterminate'],
    [undefined, 'indeterminate'],
  ])('errno %s ⇒ %s', async (code, expected) => {
    await expect(probeUnixSocketState('/tmp/x.sock', { connect: erroringConnect(code) })).resolves.toBe(expected);
  });

  it('a hung connect is indeterminate, not dead', async () => {
    const hang = ((_p: string) => ({ on: () => undefined, destroy: vi.fn() })) as never;
    await expect(probeUnixSocketState('/tmp/x.sock', { timeoutMs: 5, connect: hang })).resolves.toBe('indeterminate');
  });

  it('a real stale socket file (no listener) is dead', async () => {
    const socketPath = path.join(os.tmpdir(), `pid-keyed-state-${process.pid}-${Date.now()}.sock`);
    const bound = `${socketPath}.bound`;
    const gone = net.createServer().listen(bound);
    await once(gone, 'listening');
    renameSync(bound, socketPath);
    gone.close();
    await once(gone, 'close');
    try {
      await expect(probeUnixSocketState(socketPath)).resolves.toBe('dead');
    } finally {
      rmSync(socketPath, { force: true });
    }
  });
});
