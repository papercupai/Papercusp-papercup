/**
 * pty-stack integration test — exercises the entire pty stack end-to-
 * end (HTTP control plane + WS data plane + P4 screen-state replay)
 * against the maintained isolated verifier. RUN_PTY_INTEGRATION selects
 * this runtime journey; a broken selected private runtime fails setup.
 *
 * Covers what the unit tests can't: the actual HTTP routes resolved
 * through Hono, instrumentation.ts boot path, and the cross-process
 * resume semantics.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { freshPtyProtocols, observePtySocket, privateLiveTarget } from './private-live-fixture';

const OPERATOR = process.env.PAPERCUSP_OPERATOR_BASE ?? '';
const WS_BASE = process.env.PAPERCUSP_PTY_WS_BASE ?? '';
const ORIGIN = OPERATOR;
const HEADERS = { Origin: ORIGIN, 'x-papercusp-workspace': process.env.PAPERCUSP_WORKSPACE_ID ?? '' };
// The caller must register its own harness in the selected private workspace.
const SLUG = process.env.PAPERCUSP_TEST_SLUG ?? '';

// Spawn a plain bash pty. The route's default command is the harness's
// configured terminal CLI (an AGENT session — claude/omp — on the dev box):
// the test must not burn one per case, and a TUI's startup repaints make the
// `echo …` round-trip flaky. bash gives deterministic shell echo semantics.
const SPAWN_BODY = JSON.stringify({ command: 'bash', args: [], cols: 80, rows: 24 });

async function operatorAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${OPERATOR}/api/harness/projects`, { headers: HEADERS });
    return r.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!process.env.RUN_PTY_INTEGRATION)('pty stack end-to-end', () => {
  beforeAll(async () => {
    const target = privateLiveTarget(process.env);
    expect(OPERATOR).toBe(target.base);
    expect(SLUG).not.toBe('');
    const ws = new URL(WS_BASE);
    expect(ws.protocol).toBe('ws:');
    expect(ws.hostname).toBe(new URL(OPERATOR).hostname);
    expect(ws.port).toBe(process.env.VERIFY_TAURI_PTY_PORT);
    expect(ws.port).not.toBe('');
    expect(ws.origin).toBe(WS_BASE);
    const response = await fetch(`${OPERATOR}/api/harness/projects`, { headers: HEADERS });
    expect(response.ok).toBe(true);
    const d = await response.json();
    expect(d.projects?.some((project: { slug: string }) => project.slug === SLUG)).toBe(true);
  });

  async function withPty(run: (spawn: { id: string; pid: number }, attach: (protocols?: string[], origin?: string) => Promise<ReturnType<typeof observePtySocket>>) => Promise<void>) {
    const response = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
      method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: SPAWN_BODY,
    });
    expect(response.ok).toBe(true);
    const spawn = await response.json();
    const sockets: WebSocket[] = [];
    try {
      expect(spawn.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(spawn.pid).toBeGreaterThan(0);
      await run(spawn, async (protocols, origin = ORIGIN) => {
        const fresh = protocols ?? await freshPtyProtocols(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/ticket`, HEADERS);
        const ws = new WebSocket(`${WS_BASE}/pty/${spawn.id}`, fresh, { headers: { Origin: origin } });
        sockets.push(ws);
        return observePtySocket(ws);
      });
    } finally {
      await Promise.all(sockets.map((ws) => ws.readyState === WebSocket.CLOSED ? undefined
        : new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.terminate(); })));
      if (typeof spawn.id === 'string') {
        const killed = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/kill`, { method: 'POST', headers: HEADERS });
        expect(killed.status).toBe(204);
      }
    }
  }

  it('operator is reachable', async () => {
    const alive = await operatorAlive();
    expect(alive).toBe(true);
  });

  it('full lifecycle: spawn → WS attach → input round-trip → reconnect → P4 replay → kill', async () => {
    await withPty(async (spawn, attach) => {
      const first = await attach();
      expect(await first.opened).toEqual({ opened: true });
      const ws1 = first.ws;
      // Resize + keystroke.
      ws1.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
      ws1.send(Buffer.from('echo INTEGRATION_MARKER\r'));
      await new Promise((r) => setTimeout(r, 800));
      expect(first.output()).toContain('INTEGRATION_MARKER');
      ws1.close();
      // Tiny gap for WS server to detach subscriber cleanly.
      await new Promise((r) => setTimeout(r, 100));

      // 3. Reconnect — server should replay screen state via P4.
      const second = await attach();
      expect(await second.opened).toEqual({ opened: true });
      const ws2 = second.ws;
      await new Promise((r) => setTimeout(r, 600));
      expect(second.output()).toContain('INTEGRATION_MARKER');
      // Bounded: P4 emits ANSI screen state, NOT full session bytes.
      expect(Buffer.byteLength(second.output())).toBeLessThan(64 * 1024);
      ws2.close();

      // 4. Resume via /spawn { resumePtyId } — same pty, same pid.
      const resume = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/spawn`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24, resumePtyId: spawn.id }),
      }).then((r) => r.json());
      expect(resume.id).toBe(spawn.id);
      expect(resume.resumed).toBe(true);
      expect(resume.pid).toBe(spawn.pid);

      // 5. /resolve returns harness-aware config (E control plane).
      const resolved = await fetch(`${OPERATOR}/api/harness/${SLUG}/pty/resolve`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: SPAWN_BODY,
      }).then((r) => r.json());
      // The command is the HARNESS'S configured terminal CLI (omp, bash,
      // claude, …) — asserting a specific binary couples the contract test to
      // box config. Structural contract only: non-empty command + cwd + args/env.
      expect(typeof resolved.command).toBe('string');
      expect(resolved.command.length).toBeGreaterThan(0);
      expect(resolved.cwd).toMatch(/\//);
      expect(Array.isArray(resolved.args)).toBe(true);
      expect(typeof resolved.env).toBe('object');

    });
  }, 15000);

  it('rejects WS with disallowed Origin header', async () => {
    await withPty(async (_spawn, attach) => {
      const denied = await attach(undefined, 'http://evil.example.com');
      expect(await denied.opened).toEqual({ opened: false, statusCode: 403 });
    });
  });

  it('rejects missing and already redeemed tickets before upgrade', async () => {
    await withPty(async (spawn, attach) => {
      expect(await (await attach([])).opened).toEqual({ opened: false, statusCode: 401 });
      const protocols = await freshPtyProtocols(`${OPERATOR}/api/harness/${SLUG}/pty/${spawn.id}/ticket`, HEADERS);
      const first = await attach(protocols);
      expect(await first.opened).toEqual({ opened: true });
      first.ws.close();
      expect(await (await attach(protocols)).opened).toEqual({ opened: false, statusCode: 401 });
    });
  });

  it('flow-control ack does not error', async () => {
    await withPty(async (_spawn, attach) => {
      const observed = await attach();
      expect(await observed.opened).toEqual({ opened: true });
      const ws = observed.ws;
      // Burst of fake acks shouldn't close the socket.
      for (let i = 0; i < 10; i++) {
        ws.send(JSON.stringify({ type: 'ack', bytes: 50_000 }));
      }
      // Send a keystroke and verify socket still responsive.
      ws.send(Buffer.from('echo AFTER_ACK\r'));
      // Poll instead of one fixed sleep: the spawned CLI's startup (clear-screen,
      // banner) can delay the echo past a 600ms window on a busy box.
      for (let i = 0; i < 30 && !observed.output().includes('AFTER_ACK'); i++) await new Promise((r) => setTimeout(r, 200));
      expect(observed.output()).toContain('AFTER_ACK');
      ws.close();
    });
  });
});
