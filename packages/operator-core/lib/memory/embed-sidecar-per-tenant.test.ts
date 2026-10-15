/**
 * P-530 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): the
 * packaged embed sidecar is addressed PER TENANT.
 *
 * Before P-530 every Server with PAPERCUSP_EMBED_SIDECAR=1 bound or adopted
 * the one host-wide port 3384, so on a shared host tenant 2's text was
 * embedded by tenant 1's process (WI-10005481 class). Now, with no explicit
 * port, each Server spawns its sidecar on an ephemeral port and records
 * { pid, port, uid } in its OWN data dir; a sibling adopts that sidecar only
 * when the record is this uid's, the pid is alive, the port is held by this
 * uid, and /healthz reports the recorded pid.
 *
 * The child process is FAKE (no model load). The sidecars a record points at
 * are REAL loopback HTTP listeners, so the /healthz probe and the
 * /proc/net/tcp owner check run for real. Each "Server" is a fresh module
 * instance (vi.resetModules), the way two Server processes each hold their
 * own spawner state.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeChild = import('node:events').EventEmitter & {
  stdout: import('node:events').EventEmitter;
  stderr: import('node:events').EventEmitter;
  killed: boolean;
  pid?: number;
};

const fake = vi.hoisted(() => ({ children: [] as FakeChild[], envs: [] as NodeJS.ProcessEnv[], pid: undefined as number | undefined }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const child = Object.assign(new Emitter(), {
        stdout: new Emitter(),
        stderr: new Emitter(),
        killed: false,
        pid: fake.pid,
        kill(this: { killed: boolean }) {
          this.killed = true;
          return true;
        },
      });
      fake.children.push(child);
      fake.envs.push(opts?.env ?? {});
      return child;
    }),
  };
});

import {
  embedSidecarFixedPort,
  healthzPid,
  judgeRecordedEmbedSidecar,
  parseEmbedSidecarReadyPort,
  parseEmbedSidecarRecord,
  type EmbedSidecarRecord,
} from './embed-sidecar-spawn';

const READY = 'PAPERCUSP_EMBED_SIDECAR_READY';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;

describe('P-530 pure rules', () => {
  it('only an explicit, valid port selects fixed-port mode', () => {
    expect(embedSidecarFixedPort({})).toBeNull();
    expect(embedSidecarFixedPort({ PAPERCUSP_EMBED_SIDECAR_PORT: '' })).toBeNull();
    expect(embedSidecarFixedPort({ PAPERCUSP_EMBED_SIDECAR_PORT: '0' })).toBeNull();
    expect(embedSidecarFixedPort({ PAPERCUSP_EMBED_SIDECAR_PORT: 'abc' })).toBeNull();
    expect(embedSidecarFixedPort({ PAPERCUSP_EMBED_SIDECAR_PORT: '3384' })).toBe(3384);
  });

  it('reads the bound port off the READY line the server prints', () => {
    expect(parseEmbedSidecarReadyPort(`${READY} port=43123`)).toBe(43123);
    expect(parseEmbedSidecarReadyPort(READY)).toBeNull();
    expect(parseEmbedSidecarReadyPort(`${READY} port=0`)).toBeNull();
    expect(parseEmbedSidecarReadyPort(`${READY} port=70000`)).toBeNull();
  });

  it('parses only well-formed records', () => {
    const ok = { pid: 42, port: 40001, uid: 1000, startedAt: 1 };
    expect(parseEmbedSidecarRecord(JSON.stringify(ok))).toEqual(ok);
    expect(parseEmbedSidecarRecord(JSON.stringify({ ...ok, uid: null }))).toEqual({ ...ok, uid: null });
    expect(parseEmbedSidecarRecord('{')).toBeNull();
    expect(parseEmbedSidecarRecord(JSON.stringify({ ...ok, pid: 0 }))).toBeNull();
    expect(parseEmbedSidecarRecord(JSON.stringify({ ...ok, port: 99999 }))).toBeNull();
    expect(parseEmbedSidecarRecord(JSON.stringify({ ...ok, uid: '1000' }))).toBeNull();
  });

  it('healthzPid reads an integer pid only', () => {
    expect(healthzPid({ pid: 7 })).toBe(7);
    expect(healthzPid({ pid: '7' })).toBeNull();
    expect(healthzPid(null)).toBeNull();
  });

  describe('judgeRecordedEmbedSidecar', () => {
    const record: EmbedSidecarRecord = { pid: 4242, port: 40001, uid: 1000, startedAt: 1 };
    const base = { record, uid: 1000, pidAlive: true, listenerUids: [1000] as number[] | null, healthPid: 4242 as number | null | undefined };

    it('adopts a record that passes every check', () => {
      expect(judgeRecordedEmbedSidecar(base)).toEqual({ adopt: true });
    });

    it('never adopts a record written by another uid', () => {
      expect(judgeRecordedEmbedSidecar({ ...base, record: { ...record, uid: 1001 } }).adopt).toBe(false);
    });

    it('never adopts when the recorded pid is gone or not ours', () => {
      expect(judgeRecordedEmbedSidecar({ ...base, pidAlive: false }).adopt).toBe(false);
    });

    it('never adopts a port another uid holds, even partly', () => {
      expect(judgeRecordedEmbedSidecar({ ...base, listenerUids: [1001] }).adopt).toBe(false);
      expect(judgeRecordedEmbedSidecar({ ...base, listenerUids: [1000, 1001] }).adopt).toBe(false);
      expect(judgeRecordedEmbedSidecar({ ...base, listenerUids: [] }).adopt).toBe(false);
    });

    it('refuses when /healthz reports a different pid, and skips that check only when unprobed', () => {
      expect(judgeRecordedEmbedSidecar({ ...base, healthPid: 1 }).adopt).toBe(false);
      expect(judgeRecordedEmbedSidecar({ ...base, healthPid: null }).adopt).toBe(false);
      expect(judgeRecordedEmbedSidecar({ ...base, healthPid: undefined }).adopt).toBe(true);
    });

    it('a host with no socket table relies on the pid checks', () => {
      expect(judgeRecordedEmbedSidecar({ ...base, listenerUids: null }).adopt).toBe(true);
    });
  });
});

/** A real loopback listener standing in for a running sidecar. */
async function fakeSidecar(reportPid: number): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: reportPid, capabilities: ['GET /healthz', 'POST /embed'] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

type SpawnModule = typeof import('./embed-sidecar-spawn');

describe.skipIf(process.platform !== 'linux')('P-530: two tenants on one host get two sidecars', () => {
  const saved = {
    enable: process.env.PAPERCUSP_EMBED_SIDECAR,
    port: process.env.PAPERCUSP_EMBED_SIDECAR_PORT,
    home: process.env.PAPERCUSP_HOME,
  };
  let root: string;
  let sidecarA: Awaited<ReturnType<typeof fakeSidecar>>;
  let sidecarB: Awaited<ReturnType<typeof fakeSidecar>>;
  let lying: Awaited<ReturnType<typeof fakeSidecar>>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'p530-tenants-'));
    sidecarA = await fakeSidecar(process.pid);
    sidecarB = await fakeSidecar(process.pid);
    lying = await fakeSidecar(1); // answers /healthz with a pid that is not the recorded one
  });

  afterAll(async () => {
    for (const s of [sidecarA, sidecarB, lying]) await new Promise((r) => s.server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.children.length = 0;
    fake.envs.length = 0;
    fake.pid = process.pid; // a live pid this uid owns
    process.env.PAPERCUSP_EMBED_SIDECAR = '1';
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [k, v] of [
      ['PAPERCUSP_EMBED_SIDECAR', saved.enable],
      ['PAPERCUSP_EMBED_SIDECAR_PORT', saved.port],
      ['PAPERCUSP_HOME', saved.home],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  /** A fresh Server process for tenant `home`: its own spawner module state. */
  async function server(home: string): Promise<SpawnModule> {
    mkdirSync(home, { recursive: true });
    process.env.PAPERCUSP_HOME = home;
    vi.resetModules();
    const mod = (await import('./embed-sidecar-spawn')) as SpawnModule;
    mod._resetEmbedSidecarSpawnStateForTests();
    return mod;
  }

  /** ensure() on `mod`, answering its spawn (if any) with a READY line on `port`. */
  async function ensureAnswering(mod: SpawnModule, port: number): Promise<{ url: string | null; spawned: boolean }> {
    const before = fake.children.length;
    const pending = mod.ensureEmbedSidecar([]);
    const settledEarly = await Promise.race([pending.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
    if (!settledEarly) {
      await vi.waitFor(() => expect(fake.children.length).toBe(before + 1));
      fake.children[before].stdout.emit('data', Buffer.from(`${READY} port=${port}\n`));
    }
    return { url: await pending, spawned: fake.children.length > before };
  }

  it('each tenant spawns its own sidecar, on an ephemeral port, recorded in its own data dir', async () => {
    const tenantA = await server(path.join(root, 'a'));
    const a = await ensureAnswering(tenantA, sidecarA.port);
    expect(a).toEqual({ url: sidecarA.url, spawned: true });
    // The child was told to bind an ephemeral port, not the shared 3384.
    expect(fake.envs[0].PAPERCUSP_EMBED_SIDECAR_PORT).toBe('0');

    const tenantB = await server(path.join(root, 'b'));
    const b = await ensureAnswering(tenantB, sidecarB.port);
    expect(b).toEqual({ url: sidecarB.url, spawned: true });

    expect(a.url).not.toBe(b.url);
    const recA = JSON.parse(readFileSync(path.join(root, 'a', 'run', 'embed-sidecar.json'), 'utf8'));
    const recB = JSON.parse(readFileSync(path.join(root, 'b', 'run', 'embed-sidecar.json'), 'utf8'));
    expect(recA).toMatchObject({ pid: process.pid, port: sidecarA.port, uid });
    expect(recB).toMatchObject({ pid: process.pid, port: sidecarB.port, uid });
  });

  it("a sibling Server of the SAME tenant adopts the recorded sidecar instead of spawning", async () => {
    const sibling = await server(path.join(root, 'a'));
    expect(sibling.embedSidecarLocalUrl()).toBe(sidecarA.url);
    const r = await ensureAnswering(sibling, 1);
    expect(r).toEqual({ url: sidecarA.url, spawned: false });
  });

  it("a record claiming another uid is never adopted: the tenant gets its own sidecar", async () => {
    const home = path.join(root, 'c');
    mkdirSync(path.join(home, 'run'), { recursive: true });
    writeFileSync(
      path.join(home, 'run', 'embed-sidecar.json'),
      JSON.stringify({ pid: process.pid, port: sidecarA.port, uid: (uid ?? 0) + 1, startedAt: Date.now() }),
    );
    const tenantC = await server(home);
    expect(tenantC.embedSidecarLocalUrl()).toBeNull();
    const r = await ensureAnswering(tenantC, sidecarB.port);
    expect(r).toEqual({ url: sidecarB.url, spawned: true });
  });

  it('a recorded port whose /healthz reports another pid is not adopted', async () => {
    const home = path.join(root, 'd');
    mkdirSync(path.join(home, 'run'), { recursive: true });
    writeFileSync(
      path.join(home, 'run', 'embed-sidecar.json'),
      JSON.stringify({ pid: process.pid, port: lying.port, uid, startedAt: Date.now() }),
    );
    const tenantD = await server(home);
    const r = await ensureAnswering(tenantD, sidecarB.port);
    expect(r).toEqual({ url: sidecarB.url, spawned: true });
  });

  it('the record is removed when the child exits, so nobody adopts a dead address', async () => {
    const home = path.join(root, 'e');
    const tenantE = await server(home);
    await ensureAnswering(tenantE, sidecarB.port);
    const file = path.join(home, 'run', 'embed-sidecar.json');
    expect(existsSync(file)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.children[fake.children.length - 1].emit('exit', 1);
    expect(warn).toHaveBeenCalledWith('[embed-sidecar] died (exit code 1)');
    expect(existsSync(file)).toBe(false);
    expect(tenantE.embedSidecarLocalUrl()).toBeNull();
    // That exit was a crash, so a respawn is now scheduled; cancel it so it
    // cannot fire into a later test.
    tenantE._resetEmbedSidecarSpawnStateForTests();
  });

  it('an explicit PAPERCUSP_EMBED_SIDECAR_PORT keeps the fixed-port behaviour', async () => {
    process.env.PAPERCUSP_EMBED_SIDECAR_PORT = String(sidecarA.port);
    const fixed = await server(path.join(root, 'f'));
    expect(fixed.embedSidecarLocalUrl()).toBe(sidecarA.url);
    // Held by this uid and fit: adopted, nothing spawned, no record written.
    const r = await ensureAnswering(fixed, 1);
    expect(r).toEqual({ url: sidecarA.url, spawned: false });
    expect(existsSync(path.join(root, 'f', 'run', 'embed-sidecar.json'))).toBe(false);
  });

  it('P-532: a per-tenant child is told to exit when idle; an explicit parent value passes through', async () => {
    const IDLE = 'PAPERCUSP_EMBED_SIDECAR_IDLE_EXIT_MS';
    const savedIdle = process.env[IDLE];
    try {
      delete process.env[IDLE];
      const tenantG = await server(path.join(root, 'g'));
      await ensureAnswering(tenantG, sidecarB.port);
      expect(fake.envs).toHaveLength(1);
      expect(fake.envs[0][IDLE]).toBe(String(tenantG.EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS));
      expect(tenantG.EMBED_SIDECAR_DEFAULT_IDLE_EXIT_MS).toBeGreaterThan(0);
      tenantG._resetEmbedSidecarSpawnStateForTests();

      process.env[IDLE] = '0'; // operator chose never-exit
      const tenantH = await server(path.join(root, 'h'));
      await ensureAnswering(tenantH, sidecarA.port);
      expect(fake.envs).toHaveLength(2);
      expect(fake.envs[1][IDLE]).toBe('0');
      tenantH._resetEmbedSidecarSpawnStateForTests();
    } finally {
      if (savedIdle === undefined) delete process.env[IDLE];
      else process.env[IDLE] = savedIdle;
    }
  });
});
