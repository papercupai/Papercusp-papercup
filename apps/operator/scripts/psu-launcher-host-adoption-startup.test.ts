import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, usePtyHost } from './psu-launcher.mjs';
import {
  normalizeGcpIapProfile,
  PSU_CONNECTION_STORE_VERSION,
  runPsuConnectionFrontController,
  savePsuConnectionStore,
} from './psu-connection-front-controller.mjs';

vi.mock('./psu-pty-host.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./psu-pty-host.mjs')>()),
  appendHostEvent: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function bareLauncher(reexecCount: string | undefined) {
  process.argv = ['node', '/test/psu-launcher.mjs'];
  vi.stubEnv('PAPERCUSP_PSU_REEXEC', '87');
  vi.stubEnv('PAPERCUSP_PSU_REEXEC_PPID', String(process.ppid));
  vi.stubEnv('PAPERCUSP_PSU_HOST_ADOPT', undefined);
  vi.stubEnv('PAPERCUSP_PSU_REEXEC_COUNT', reexecCount);
  vi.stubEnv('PAPERCUSP_SID', undefined);
  vi.stubEnv('PAPERCUSP_PSU_HOSTED_CUSTOMER', undefined);
}

describe('guarded host adoption before the connection picker', () => {
  it.each([undefined, '1'])('resumes a bare interactive shim with count %s without opening a picker', async (count) => {
    bareLauncher(count);
    const handoff = { ownerId: 'su-existing', mode: 'carry-respawn' };
    const readHandoff = vi.fn().mockReturnValue(handoff);
    const launchHandoff = vi.fn().mockResolvedValue(undefined);
    const connectionFrontController = vi.fn().mockRejectedValue(new Error('unexpected connection picker'));

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).toHaveBeenCalledExactlyOnceWith(process.ppid,
      expect.objectContaining({ ownerId: null, onReject: expect.any(Function) }));
    expect(launchHandoff).toHaveBeenCalledExactlyOnceWith(handoff);
    expect(connectionFrontController).not.toHaveBeenCalled();
  });

  it('restores --headless before launching a legacy handoff without its posture env', async () => {
    bareLauncher('1');
    process.argv.push('--headless');
    vi.stubEnv('PAPERCUSP_PSU_HEADLESS', undefined);
    vi.stubEnv('PAPERCUSP_PSU_NO_PTY', undefined);
    vi.stubEnv('PAPERCUSP_PSU_PTY', undefined);
    const handoff = { ownerId: 'su-existing', mode: 'carry-respawn', childEnv: {} };
    const launchHandoff = vi.fn(async () => {
      expect(process.env.PAPERCUSP_PSU_HEADLESS).toBe('1');
      expect(usePtyHost({ env: process.env, stdin: { isTTY: false }, stdout: { isTTY: false } })).toBe(true);
    });

    await main({ readHandoff: () => handoff, launchHandoff });

    expect(launchHandoff).toHaveBeenCalledExactlyOnceWith(handoff);
  });

  it('keeps an ordinary first launch on the connection route without scanning handoffs', async () => {
    bareLauncher('0');
    const readHandoff = vi.fn();
    const launchHandoff = vi.fn();
    const connectionFrontController = vi.fn().mockResolvedValue({ handled: true, argv: [] });

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).not.toHaveBeenCalled();
    expect(launchHandoff).not.toHaveBeenCalled();
    expect(connectionFrontController).toHaveBeenCalledExactlyOnceWith([]);
  });

  it.each(['0', '1'])('does not warn that connection flags are ignored before their controller (count %s)', async (count) => {
    bareLauncher(count);
    const argv = ['--connect-program=pui', '--connect'];
    process.argv.push(...argv);
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connectionFrontController = vi.fn().mockResolvedValue({ handled: true, argv: [] });

    await main({ readHandoff: () => null, connectionFrontController });

    expect(connectionFrontController).toHaveBeenCalledExactlyOnceWith(argv);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('chooses the machine before local context and leaves context selection to remote psu once', async () => {
    bareLauncher('0');
    const home = mkdtempSync(join(tmpdir(), 'psu-machine-first-'));
    const events: string[] = [];
    const localContext = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('local context must not be queried'));
    const remoteLaunch = vi.fn(async (_command: string, argv: string[]) => {
      events.push('remote launch');
      expect(argv.at(-1)).toContain("'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'psu'");
      const forwarded = await runPsuConnectionFrontController([], {
        home,
        transportForwarded: true,
        pickConnection: () => { throw new Error('duplicate machine picker'); },
      });
      expect(forwarded).toEqual({ handled: false, argv: [] });
      return { code: 0, signal: null };
    });
    try {
      savePsuConnectionStore({
        version: PSU_CONNECTION_STORE_VERSION,
        profiles: [normalizeGcpIapProfile({
          name: 'cloud', projectId: 'test-project', zone: 'us-central1-a',
          instanceName: 'machine-1', sshUser: 'customer',
        })],
      }, join(home, 'connections.json'));
      await main({
        connectionFrontController: (argv: string[]) => runPsuConnectionFrontController(argv, {
          home, storePath: join(home, 'connections.json'), interactive: true, transportForwarded: false,
          pickConnection: async () => { events.push('machine picker'); return 'cloud'; },
          commandAvailable: () => true,
          runCommand: async () => ({ code: 0, signal: null }),
          reservePort: async () => ({ port: 45123, release: async () => {} }),
          probeOperator: async () => { events.push('remote context probe'); },
          runInteractive: remoteLaunch,
          notice: () => {},
        }),
      });
      expect(events).toEqual(['machine picker', 'remote context probe', 'remote launch']);
      expect(localContext).not.toHaveBeenCalled();
      expect(remoteLaunch).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the connection route when the existing validator rejects or cannot find a handoff', async () => {
    bareLauncher('1');
    const readHandoff = vi.fn().mockReturnValue(null);
    const launchHandoff = vi.fn();
    const connectionFrontController = vi.fn().mockResolvedValue({ handled: true, argv: [] });

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).toHaveBeenCalledOnce();
    expect(launchHandoff).not.toHaveBeenCalled();
    expect(connectionFrontController).toHaveBeenCalledExactlyOnceWith([]);
  });
});
