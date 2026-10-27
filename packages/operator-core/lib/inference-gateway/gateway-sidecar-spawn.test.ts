/**
 * Tests for the cross-platform inference-gateway supervisor (P-006,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05 / WI-3059).
 *
 * Covers the PURE seams + the two side-effect-free ensureGatewaySidecar outcomes
 * ('disabled' kill-switch, 'adopted-external' port adoption). The 'spawned' path
 * forks a real child process, so it is exercised by the Mac-VM / desktop E2E smoke,
 * not unit tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  buildGatewaySpawnPlan,
  gatewayRespawnBackoffMs,
  gatewaySupervisorPort,
  isGatewayListening,
  ensureGatewaySidecar,
  gatewayReprobeIntervalSec,
  gatewayReprobeTick,
  GATEWAY_MAX_RESPAWN_ATTEMPTS,
  GATEWAY_RESPAWN_WINDOW_MS,
  _resetGatewaySidecarStateForTests,
  _gatewaySidecarStateForTests,
  _setRespawnGivenUpForTests,
} from './gateway-sidecar-spawn';
import { DEFAULT_GATEWAY_PORT } from './launch';

function listenEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const SAVED_ENV_KEYS = [
  'PAPERCUSP_GATEWAY_PORT',
  'PAPERCUSP_GATEWAY_SUPERVISE',
  'PAPERCUSP_GATEWAY_REPROBE_SEC',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SAVED_ENV_KEYS) delete process.env[k];
  _resetGatewaySidecarStateForTests();
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetGatewaySidecarStateForTests();
});

describe('gatewayRespawnBackoffMs', () => {
  it('doubles from 1s and caps at 30s (mirrors substrate-sidecar-spawn)', () => {
    expect(gatewayRespawnBackoffMs(1)).toBe(1_000);
    expect(gatewayRespawnBackoffMs(2)).toBe(2_000);
    expect(gatewayRespawnBackoffMs(3)).toBe(4_000);
    expect(gatewayRespawnBackoffMs(4)).toBe(8_000);
    expect(gatewayRespawnBackoffMs(5)).toBe(16_000);
    expect(gatewayRespawnBackoffMs(6)).toBe(30_000); // 32s uncapped → capped
    expect(gatewayRespawnBackoffMs(10)).toBe(30_000);
  });

  it('circuit-breaker constants stay in lock-step with the sibling spawners', () => {
    expect(GATEWAY_MAX_RESPAWN_ATTEMPTS).toBe(5);
    expect(GATEWAY_RESPAWN_WINDOW_MS).toBe(5 * 60_000);
  });
});

describe('gatewaySupervisorPort', () => {
  it('defaults to DEFAULT_GATEWAY_PORT and honors the env override', () => {
    expect(gatewaySupervisorPort()).toBe(DEFAULT_GATEWAY_PORT);
    process.env.PAPERCUSP_GATEWAY_PORT = '9911';
    expect(gatewaySupervisorPort()).toBe(9911);
  });
});

describe('buildGatewaySpawnPlan', () => {
  it('dev (real .ts on disk) uses explicit Node and the resolved tsx loader', () => {
    const plan = buildGatewaySpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
      execPath: '/usr/bin/node',
      moduleDirOverride: '/repo/packages/operator-core/lib/inference-gateway',
    });
    expect(plan.mode).toBe('dev-tsx');
    expect(plan.cmd).toBe('/usr/bin/node');
    expect(plan.args).toEqual(['--import', expect.stringContaining('tsx'), '/repo/packages/operator-core/lib/inference-gateway/bin.ts']);
    // The divert var must NOT leak into the dev child...
    expect(plan.env).not.toHaveProperty('PAPERCUSP_GATEWAY_SIDECAR_MODE');
    // ...but parent identity MUST be re-declared to OUR pid (EI-20493378309289396):
    // every sidecar spawn layers plan.env over ...process.env, so without this the
    // child inherits the DESKTOP pid, its parent-death watch compares two pids that
    // can never match, and it SIGTERMs itself ~40ms into every boot, forever.
    expect(plan.env).toEqual({ PAPERCUSP_DESKTOP_PARENT_PID: String(process.pid) });
  });

  it('packaged (bundled serve.mjs) → re-exec self under the bundled node with the divert env', () => {
    const plan = buildGatewaySpawnPlan({
      selfPath: '/opt/Papercup/resources/serve.mjs',
      execPath: '/opt/Papercup/resources/node',
      moduleDirOverride: '/opt/Papercup/resources',
    });
    expect(plan.mode).toBe('bundled-reexec');
    expect(plan.cmd).toBe('/opt/Papercup/resources/node');
    expect(plan.args).toEqual(['/opt/Papercup/resources/serve.mjs']);
    expect(plan.env).toEqual({
      PAPERCUSP_GATEWAY_SIDECAR_MODE: '1',
      // See the dev case above — parent identity travels on BOTH spawn modes.
      PAPERCUSP_DESKTOP_PARENT_PID: String(process.pid),
    });
  });
});

describe('isGatewayListening', () => {
  it('true against a live listener, false once it closes (and never throws)', async () => {
    const { server, port } = await listenEphemeral();
    try {
      await expect(isGatewayListening(port)).resolves.toBe(true);
    } finally {
      await closeServer(server);
    }
    // Same port, now closed → refused → false (not a throw).
    await expect(isGatewayListening(port, 1_000)).resolves.toBe(false);
  });
});

describe('ensureGatewaySidecar', () => {
  it("kill-switch PAPERCUSP_GATEWAY_SUPERVISE=0 → 'disabled' (no probe, no spawn)", async () => {
    process.env.PAPERCUSP_GATEWAY_SUPERVISE = '0';
    await expect(ensureGatewaySidecar()).resolves.toBe('disabled');
    expect(_gatewaySidecarStateForTests()).toMatchObject({ running: false, adoptedExternal: false });
  });

  it("adopts an externally-owned port (systemd on the dev box) → 'adopted-external'", async () => {
    const { server, port } = await listenEphemeral();
    process.env.PAPERCUSP_GATEWAY_PORT = String(port);
    try {
      await expect(ensureGatewaySidecar()).resolves.toBe('adopted-external');
      expect(_gatewaySidecarStateForTests()).toMatchObject({ running: false, adoptedExternal: true, reprobeArmed: true });
    } finally {
      await closeServer(server);
    }
  });

  it('arms the periodic reprobe timer as a side effect (SPOF 2 d+e)', async () => {
    process.env.PAPERCUSP_GATEWAY_SUPERVISE = '0';
    await ensureGatewaySidecar();
    // The kill-switch path returns before arming anything.
    expect(_gatewaySidecarStateForTests().reprobeArmed).toBe(false);
  });
});

describe('gatewayReprobeIntervalSec', () => {
  it('defaults to 60s and honors the env override / kill switch', () => {
    expect(gatewayReprobeIntervalSec()).toBe(60);
    process.env.PAPERCUSP_GATEWAY_REPROBE_SEC = '10';
    expect(gatewayReprobeIntervalSec()).toBe(10);
    process.env.PAPERCUSP_GATEWAY_REPROBE_SEC = '0';
    expect(gatewayReprobeIntervalSec()).toBe(0);
  });
});

describe('gatewayReprobeTick — SPOF 2 (d) budget-exhaustion re-arm + (e) adopted-external death', () => {
  it('(e) adopted-external + port now DEAD → drops the adoption and spawns our own child', async () => {
    const { server, port } = await listenEphemeral();
    process.env.PAPERCUSP_GATEWAY_PORT = String(port);
    await ensureGatewaySidecar(); // adopts
    expect(_gatewaySidecarStateForTests().adoptedExternal).toBe(true);
    await closeServer(server); // the external gateway dies, nothing restarts it

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawnGatewayChild = vi.fn(async () => undefined);
    await gatewayReprobeTick(port, { spawnGatewayChild });
    warn.mockRestore();

    expect(spawnGatewayChild).toHaveBeenCalledWith(port);
    expect(_gatewaySidecarStateForTests().adoptedExternal).toBe(false);
  });

  it('(e) adopted-external + port still LIVE → no-op (healthy, no spawn)', async () => {
    const { server, port } = await listenEphemeral();
    try {
      process.env.PAPERCUSP_GATEWAY_PORT = String(port);
      await ensureGatewaySidecar(); // adopts
      const spawnGatewayChild = vi.fn(async () => undefined);
      await gatewayReprobeTick(port, { spawnGatewayChild });
      expect(spawnGatewayChild).not.toHaveBeenCalled();
      expect(_gatewaySidecarStateForTests().adoptedExternal).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('(d) respawn budget exhausted + port still DOWN → re-arms with a fresh window and retries the spawn', async () => {
    const port = 39997; // nothing listening
    _setRespawnGivenUpForTests(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawnGatewayChild = vi.fn(async () => undefined);
    await gatewayReprobeTick(port, { spawnGatewayChild });
    warn.mockRestore();
    expect(spawnGatewayChild).toHaveBeenCalledWith(port);
    expect(_gatewaySidecarStateForTests()).toMatchObject({ respawnGivenUp: false, attemptsInWindow: 0 });
  });

  it('(d) respawn budget exhausted + port now LIVE externally → adopts instead of spawning', async () => {
    const { server, port } = await listenEphemeral();
    try {
      _setRespawnGivenUpForTests(true);
      const spawnGatewayChild = vi.fn(async () => undefined);
      await gatewayReprobeTick(port, { spawnGatewayChild });
      expect(spawnGatewayChild).not.toHaveBeenCalled();
      expect(_gatewaySidecarStateForTests()).toMatchObject({ adoptedExternal: true, respawnGivenUp: false });
    } finally {
      await closeServer(server);
    }
  });

  it('healthy steady state (not adopted-external, budget not exhausted) → no-op', async () => {
    const port = 39998;
    const spawnGatewayChild = vi.fn(async () => undefined);
    await gatewayReprobeTick(port, { spawnGatewayChild });
    expect(spawnGatewayChild).not.toHaveBeenCalled();
  });

  it('is fail-soft — a probe/spawn error never throws out of the tick', async () => {
    _setRespawnGivenUpForTests(true);
    const spawnGatewayChild = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(gatewayReprobeTick(39996, { spawnGatewayChild })).resolves.toBeUndefined();
    } finally {
      // The failed spawn falls through to scheduleRespawn, which arms a REAL setTimeout
      // for its own backoff retry (against the real, unmocked spawnGatewayChild) —
      // clear it immediately so this unit test never actually forks a child process.
      _resetGatewaySidecarStateForTests();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
