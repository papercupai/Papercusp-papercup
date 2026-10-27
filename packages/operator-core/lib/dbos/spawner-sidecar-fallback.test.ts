/**
 * spawner-sidecar-fallback.test.ts — WI-344 ③ (plan spawner-sidecar-offload-2026-06-30).
 *
 * Covers spawnInvokeOnceWithFallback, the SPAWNER_SIDECAR-gated front door:
 *   - flag OFF  → calls the in-process spawnInvokeOnce VERBATIM (pass-through
 *                 projectDir/role/extras/extraEnv + the result), never touching the
 *                 sidecar.
 *   - flag ON but the IPC `client.call` throws → catches, warns, and FALLS BACK to
 *                 the in-process spawnInvokeOnce.
 *
 * The flag + the (dynamically-imported) sidecar spawn/client are mocked, and
 * `node:child_process` `spawn` is replaced with a fake child — so the in-process
 * spawnInvokeOnce runs end-to-end WITHOUT ever spawning a real agent child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const H = vi.hoisted(() => ({
  spawnerOn: false,
  // captured buildInvokeOnce inputs (pass-through assertion)
  inputs: [] as Array<{ projectDir: string; role: string; extras: string[]; extraEnv: Record<string, string> }>,
  // the fake-child stdout + exit code the mocked spawn emits
  stdout: 'DONE\n',
  exitCode: 0,
}));

// The flag seam — preserve every real export (the orchestrator-runner load graph
// imports several from this module), override only getFlag.
vi.mock('@papercusp/flags/server', async (orig) => {
  const actual = await orig<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (key: string) => (key.includes('spawner-sidecar') ? H.spawnerOn : false),
  };
});

// buildInvokeOnce is the seam: capture inputs, return a sentinel command (the real
// spawn is faked below, so the command itself is irrelevant). Must mirror the
// module's FULL named-export surface or Vitest's evaluator throws on link.
vi.mock('../harness-invoke-once', () => ({
  buildInvokeOnce: (input: { projectDir: string; role: string; extras: string[]; extraEnv: Record<string, string> }) => {
    H.inputs.push({ projectDir: input.projectDir, role: input.role, extras: input.extras, extraEnv: input.extraEnv });
    return { command: 'fake', args: [], env: {} };
  },
  resolveSpawnBackendModel: () => ({ backend: 'omp', model: '' }),
}));

// Fake child — emit stdout then a clean `close`, so runChild resolves without a
// real process. NEVER spawns a real child (the task's hard constraint).
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child: any = new EventEmitter();
      child.pid = 9999;
      // runChild calls child.stdout?.setEncoding('utf8'); a bare EventEmitter
      // lacks it, and spawnInvokeOnce's never-rejects catch turns that TypeError
      // into exitCode 1. Mirror the real stream: setEncoding, then string chunks.
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
      child.kill = () => true;
      child.killed = false;
      setImmediate(() => {
        if (H.stdout) child.stdout.emit('data', H.stdout);
        child.emit('close', H.exitCode);
      });
      return child;
    },
  };
});

// The dynamically-imported sidecar spawn + IPC client (loaded only on the ON path).
const spawnSidecar = vi.fn(async () => {});
vi.mock('../fleet/spawner-sidecar-spawn', () => ({
  spawnSpawnerSidecar: () => spawnSidecar(),
}));
const ipcCall = vi.fn();
vi.mock('../fleet/spawner-ipc-client', () => ({
  getSpawnerIpcClient: () => ({ call: ipcCall }),
}));

import { spawnInvokeOnceWithFallback } from './orchestrator-runner';

beforeEach(() => {
  delete process.env.PAPERCUSP_SPAWNER_SIDECAR; // v1 gate is the per-host env, default unset
  H.spawnerOn = false;
  H.inputs = [];
  H.stdout = 'DONE\n';
  H.exitCode = 0;
  spawnSidecar.mockClear();
  ipcCall.mockReset();
  // runChild console.error's only on a non-zero/empty-stderr exit; our fake child
  // exits clean, so none fires. Silence defensively (vitest-fail-on-console).
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete process.env.PAPERCUSP_SPAWNER_SIDECAR; vi.restoreAllMocks(); });

describe('spawnInvokeOnceWithFallback — env gate OFF (PAPERCUSP_SPAWNER_SIDECAR unset)', () => {
  it('calls the in-process spawnInvokeOnce verbatim (pass-through args + result), never the sidecar', async () => {
    const r = await spawnInvokeOnceWithFallback('/proj', 'cup', ['F=1'], { FOO: 'bar' });

    // The in-process path ran (fake child) and returned its result.
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('DONE');

    // Pass-through: buildInvokeOnce saw exactly the wrapper's inputs.
    expect(H.inputs).toHaveLength(1);
    expect(H.inputs[0].projectDir).toBe('/proj');
    expect(H.inputs[0].role).toBe('cup');
    expect(H.inputs[0].extras).toEqual(['F=1']);
    expect(H.inputs[0].extraEnv).toEqual(expect.objectContaining({ FOO: 'bar' }));

    // The sidecar was never touched.
    expect(spawnSidecar).not.toHaveBeenCalled();
    expect(ipcCall).not.toHaveBeenCalled();
  });
});

describe('spawnInvokeOnceWithFallback — flag ON but the IPC call throws', () => {
  it('falls back to the in-process spawnInvokeOnce and warns', async () => {
    process.env.PAPERCUSP_SPAWNER_SIDECAR = '1';
    ipcCall.mockRejectedValueOnce(new Error('ipc boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await spawnInvokeOnceWithFallback('/proj', 'mug', [], {});

    // It DID try the sidecar...
    expect(spawnSidecar).toHaveBeenCalledOnce();
    expect(ipcCall).toHaveBeenCalledOnce();
    expect(ipcCall.mock.calls[0][0]).toBe('spawn:invokeOnce');
    // ...then fell back in-process and returned the fake child's result.
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('DONE');
    expect(H.inputs).toHaveLength(1); // the in-process spawn ran exactly once
    expect(warnSpy).toHaveBeenCalledWith('[spawner-sidecar] fell back to in-process:', expect.any(Error));
  });
});
