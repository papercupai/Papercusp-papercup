import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWrapper } from '../scripts/psu-launcher.mjs';

// consult-backed-parking-2026-10-12#P-010 (R-10): 5 measured cross-backend ports
// (last 2026-10-02) failed with "managed pty unavailable before session-port seed
// delivery". A session-port seed can only be delivered and verified through the
// managed pty. Without one, the launch must refuse loudly, must not spawn a plain
// child that would idle forever waiting for a first turn, and must report the port
// failed (with that cause) so the source side can prepare again.

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'psu-port-no-pty-'));
  home = join(root, 'codex-home');
  mkdirSync(home);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('session-port launch without a managed pty', () => {
  it('refuses before spawning and reports the port failed with the no-pty cause', async () => {
    const seed = join(root, 'seed.md');
    writeFileSync(seed, 'ported history\n', { mode: 0o600 });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, status: 'failed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onSpawn = vi.fn();
    const onSpawnFailure = vi.fn();
    const priorExitCode = process.exitCode;
    try {
      runWrapper({
        wrapperBin: process.execPath,
        cwd: root,
        preserveCwd: true,
        // No PAPERCUSP_SID and PSU_NO_PTY=1: the managed pty host is unavailable.
        envelopeEnv: { PAPERCUSP_AGENT: 'codex', CODEX_HOME: home, PAPERCUSP_PSU_NO_PTY: '1' },
        kickoffFile: seed,
        sessionPort: {
          portId: '22222222-2222-4222-8222-222222222222',
          targetAdvSessionId: 42,
          renderedHash: 'a'.repeat(64),
          protocolVersion: 2,
          transformVersion: 2,
          workspace: 'default',
        },
        onSpawn,
        onSpawnFailure,
      });
      expect(process.exitCode).toBe(1);
      expect(onSpawn).not.toHaveBeenCalled();
      expect(onSpawnFailure).toHaveBeenCalledOnce();
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
        'session-port launch refused: a managed pty is required to deliver and verify the seed',
      );
      // Other launcher reports may also POST; select the session-port delivery call by URL.
      const deliveryCall = () =>
        fetchMock.mock.calls.find(([url]) => /\/api\/adv\/sessions\/port\/delivery$/.test(String(url)));
      await vi.waitFor(() => expect(deliveryCall()).toBeDefined());
      const [, init] = deliveryCall()!;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        portId: '22222222-2222-4222-8222-222222222222',
        targetAdvSessionId: 42,
        status: 'failed',
        error: 'managed pty unavailable before session-port seed delivery',
      });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
