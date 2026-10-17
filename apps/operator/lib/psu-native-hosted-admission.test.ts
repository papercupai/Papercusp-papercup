import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWrapper } from '../scripts/psu-launcher.mjs';

const dirs: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = originalExitCode;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostedEnv() {
  return {
    // No coordination session or provider backend is started by this local child.
    PAPERCUSP_SID: '', PAPERCUSP_AGENT: '', PAPERCUSP_PSU_NO_PTY: '1',
    PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'fixture-only-connector',
    PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://control.example',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'fixture-only',
  };
}

describe('native launcher hosted quota boundary (local child, no provider)', () => {
  it('reserves and starts before real spawn, retaining its receipt until the child exits', async () => {
    const actions: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const { action } = JSON.parse(init.body);
      actions.push(action);
      return Response.json({ ok: true, receiptId: 'RG-fixture',
        state: action === 'finish' ? 'cancelled' : action === 'start' ? 'running' : 'queued' });
    }));
    const dir = mkdtempSync(join(tmpdir(), 'p537-native-'));
    dirs.push(dir);
    const gate = join(dir, 'exit');
    const onSpawn = vi.fn();
    const ended = vi.fn(async () => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
    runWrapper({ wrapperBin: process.execPath, cwd: dir, preserveCwd: true,
      args: ['-e', 'setInterval(() => { if (require("node:fs").existsSync(process.argv[1])) process.exit(0); }, 10)', gate],
      envelopeEnv: hostedEnv(), onSpawn, reportSessionEndedImpl: ended });
    try {
      await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledOnce());
      expect(actions).toEqual(['reserve', 'start']);
      expect(ended).not.toHaveBeenCalled();
    } finally {
      writeFileSync(gate, 'exit');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    }
    expect(actions).toEqual(['reserve', 'start', 'finish']);
    expect(ended).toHaveBeenCalledOnce();
  });

  it('refuses quota before spawning any real native child', async () => {
    const request = vi.fn(async () => new Response('quota', { status: 403 }));
    vi.stubGlobal('fetch', request);
    const spawned = vi.fn();
    const failed = vi.fn();
    runWrapper({ wrapperBin: process.execPath, cwd: process.cwd(), preserveCwd: true,
      args: ['-e', 'process.exit(0)'], envelopeEnv: hostedEnv(),
      onSpawn: spawned, onSpawnFailure: failed });
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(failed).toHaveBeenCalledOnce();
    expect(spawned).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
