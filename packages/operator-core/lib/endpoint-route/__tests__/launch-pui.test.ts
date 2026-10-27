/**
 * Unit tests for POST /api/adv/sessions/launch-pui — opens the `pui`
 * ratatui workbench (apps/tui) in an OS terminal via a server-side spawn.
 * spawn / fs / os are mocked so no terminal is actually opened. Covers:
 *   - happy path → resolves the cargo `pui` binary, spawns `pui workbench`,
 *     returns ok + terminal + pid;
 *   - `pui` not installed → 200 status:error code:pui_not_installed, no spawn;
 *   - no terminal emulator on PATH → 500 status:error, no spawn;
 *   - non-linux host → 501;
 *   - silent launch failure (EI-18696184925888288) → ok:true + a `warning`
 *     when the spawned process exits almost immediately.
 *
 * spawnInTerminal (terminal-spawn.ts) does a post-spawn EARLY-EXIT probe
 * (WI-37743) that SUBSCRIBES to the child's 'exit'/'error' rather than sleeping
 * and polling `process.kill(pid, 0)`. So the `spawn` stand-in must be a real
 * EventEmitter (makeChild below), and a simulated death must EMIT an exit inside
 * the probe window — making `process.kill` throw simulates nothing now. Fake
 * timers drive it deterministically (advanced past EARLY_EXIT_PROBE_MS in
 * `callPost`) so the pre-existing assertions see the same shape as before.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';
import { EventEmitter } from 'node:events';
// Imported rather than hardcoded so the fake-clock advance below cannot drift
// from the probe it has to outlast — a literal under-advances silently the
// moment either constant is retuned, which reads as a hang, not a stale test.
import { EARLY_EXIT_PROBE_MS } from '../../console-spawn';
import { STDERR_FLUSH_GRACE_MS } from '../../terminal-spawn';

/**
 * A real EventEmitter, because spawnInTerminal's early-exit probe SUBSCRIBES to
 * the child's 'exit'/'error' (watchEarlyExit) instead of sleeping and polling
 * `process.kill(pid, 0)`. A plain object literal has no `.on()` and fails the
 * probe at subscribe time, which surfaces as the route 500ing on every spawn
 * path. Same reason death is simulated by emitting an exit rather than by making
 * `process.kill` throw — the probe never consults it.
 */
type FakeChild = EventEmitter & { pid?: number; unref: () => void };

/** Flipped by the "silent launch failure" test; reset in beforeEach. */
let spawnDiesImmediately = false;

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.unref = () => {};
  if (spawnDiesImmediately) {
    // Well inside EARLY_EXIT_PROBE_MS, driven by the fake clock `callPost`
    // advances, so the probe observes a death rather than timing out.
    setTimeout(() => child.emit('exit', 1, null), 10);
  }
  return child;
}

const spawnMock = vi.fn((_bin?: string, _args?: string[], _opts?: unknown): FakeChild => makeChild());
const existsSyncMock = vi.hoisted(() => vi.fn((_p: string): boolean => true));
const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...a: Parameters<typeof spawnMock>) => spawnMock(...a) };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/x' };
});
// EI-19411366390626914: console-spawn.ts (imported transitively via
// terminal-spawn.ts) warms the task-manager's systemd-scope probe at module
// load (task-manager-no-escape-2026-07-27 P-009) — since WI-6844 (2026-08-02)
// the flag defaults ON, so that probe now genuinely fires a `spawn('systemd-run',
// …)` through this SAME mocked `spawn`, landing as an extra untracked call ahead
// of the real terminal spawn and breaking `spawnMock`'s call-count assertions.
// Neuter it exactly like orchestrator-runner-scope.test.ts does: the subject of
// this file is the terminal spawn, not the probe's own plumbing (that belongs to
// managed-spawn's own tests).
vi.mock('../../task-manager/managed-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/managed-spawn')>()),
  warmScopeProbe: () => {},
}));
// Same as launch-su.test.ts: keep GNOME profile preparation (gsettings/dconf
// via the real execFile) out of this fake-process fixture, so a terminal-path
// test never touches the host desktop or waits on native callbacks.
vi.mock('../../gnome-terminal-profile.mjs', () => ({
  prepareGnomeTerminal: vi.fn(async (terminal: { bin: string; args: string[] }) => terminal),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

async function callPost(): Promise<Response> {
  const mod = await import('../routes/adv/launch-pui');
  const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-pui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const resPromise = route.handler(req, CTX);
  // Flush spawnInTerminal's post-spawn early-exit probe if this call took the
  // live-spawn path. Must outlast the probe PLUS the stderr flush that runs only
  // on the not-opened branch, or the route's promise never settles.
  await vi.advanceTimersByTimeAsync(EARLY_EXIT_PROBE_MS + STDERR_FLUSH_GRACE_MS + 100);
  return resPromise;
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  delete process.env.TERMINAL;
  delete process.env.PAPERCUSP_SIDECAR_BIN;
  delete process.env.PUI_COMPANION_WASM;
  delete process.env.PUI_INSTALL_MANIFEST;
  // Default: the spawned child survives the early-exit probe.
  spawnDiesImmediately = false;
  killSpy.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launch-pui', () => {
  it('pins the child to the launching operator instead of inherited/shared discovery', async () => {
    const mod = await import('../routes/adv/launch-pui');
    const env = mod.puiLaunchEnv({
      PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PUI_OPERATOR: 'release',
    });
    expect(env.PUI_OPERATOR).toBe('http://localhost:3170');
    expect(env.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3170');
  });

  it('happy path: resolves the cargo pui binary, spawns `pui workbench`, returns ok + terminal + pid', async () => {
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.terminal).toBe('gnome-terminal');
    expect(json.pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const oneliner = lastOneliner();
    expect(oneliner).toContain('/home/x/.cargo/bin/pui');
    expect(oneliner).toContain('workbench');
  });

  it('vm-release prefers the matched bundled pui generation and pins its companion + manifest', async () => {
    process.env.PAPERCUSP_SIDECAR_BIN = '/opt/papercusp/runtime/current/bin';
    existsSyncMock.mockImplementation((path: string) =>
      [
        '/opt/papercusp/runtime/current/bin/pui',
        '/opt/papercusp/runtime/current/pui-companion.wasm',
        '/opt/papercusp/runtime/current/pui-install.json',
        '/usr/bin/gnome-terminal',
      ].includes(String(path)),
    );

    const mod = await import('../routes/adv/launch-pui');
    const env = mod.puiLaunchEnv({
      PAPERCUSP_SIDECAR_BIN: process.env.PAPERCUSP_SIDECAR_BIN,
      PAPERCUSP_HONO_PORT: '3070',
      PUI_COMPANION_WASM: '/home/x/.papercusp/stale.wasm',
      PUI_INSTALL_MANIFEST: '/home/x/.papercusp/stale.json',
    });
    expect(env.PUI_COMPANION_WASM).toBe(
      '/opt/papercusp/runtime/current/pui-companion.wasm',
    );
    expect(env.PUI_INSTALL_MANIFEST).toBe(
      '/opt/papercusp/runtime/current/pui-install.json',
    );

    const res = await callPost();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
    expect(lastOneliner()).toContain('/opt/papercusp/runtime/current/bin/pui');
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(spawnOptions.env?.PUI_COMPANION_WASM).toBe(
      '/opt/papercusp/runtime/current/pui-companion.wasm',
    );
    expect(spawnOptions.env?.PUI_INSTALL_MANIFEST).toBe(
      '/opt/papercusp/runtime/current/pui-install.json',
    );
  });

  it('pui not installed → 200 status:error code:pui_not_installed, no spawn', async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.code).toBe('pui_not_installed');
    expect(json.error).toContain('./apps/tui/scripts/install-update.sh');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no terminal emulator on PATH → 500 status:error, no spawn', async () => {
    // pui binary present (path ends in /pui) but no terminal emulator found.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/pui'));
    const res = await callPost();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/no terminal emulator/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('non-linux host → 501, no spawn', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const res = await callPost();
      expect(res.status).toBe(501);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  // EI-18696184925888288: the spawn syscall not throwing is not proof a
  // window actually opened — see terminal-spawn.ts's liveness re-check.
  it('silent launch failure: still ok:true, but adds a warning when the process exits almost immediately', async () => {
    spawnDiesImmediately = true;
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.terminal).toBe('gnome-terminal');
    expect(json.pid).toBe(4242);
    expect(typeof json.warning).toBe('string');
    expect(json.warning).toMatch(/exited almost immediately/);
  });

  it('the happy path (pid stays alive) carries no warning field', async () => {
    const res = await callPost();
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.warning).toBeUndefined();
  });
});
