/**
 * WI-10005118 routing guard: the code-drift probes fork every `git` / `find` through the
 * spawner sidecar seam, never a local execFile. A local fork from the multi-GB bg-host blocks
 * its main thread for time proportional to its RSS; a 30 s profile put probeCodeDrift at 47%
 * of the main thread's spawn self time.
 *
 * The probe is fail-soft (any error ⇒ present:false), so a regression to a raw execFile would
 * not throw — the seam would simply stop being called. This drives the WHOLE probe and asserts
 * that each of its four spawns reached the seam AND that the answer was built from the seam's
 * output (the newest file / identity leg), not from a fail-soft fallback.
 */
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BOOT_MS = 1_790_000_000_000;
const LOADED_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const PROXY_LISTENER_PID = 4343;

const { execFileViaSidecar, boundedPgReadTxn } = vi.hoisted(() => ({
  execFileViaSidecar: vi.fn(),
  boundedPgReadTxn: vi.fn(),
}));
vi.mock('./fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet/git-via-sidecar')>()),
  execFileViaSidecar,
}));
vi.mock('./pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pg-read-query')>()),
  boundedPgReadTxn,
}));
vi.mock('./agent-tools/dev/systemd-service-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/dev/systemd-service-probe')>()),
  probeServiceStart: vi.fn(async () => ({ ok: true, mainPid: 4242, startedAtMs: 1_790_000_000_000 })),
}));

function seamResponse(cmd: string, args: string[]): { stdout: string; stderr: string } {
  if (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
  if (cmd === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${HEAD_SHA}\n`, stderr: '' };
  if (cmd === 'git' && args[0] === 'diff') return { stdout: 'packages/operator-core/lib/dbos/x.ts\n', stderr: '' };
  if (cmd === 'ss' && args.join(' ') === '-tlnpH') {
    return {
      stdout: `LISTEN 0 511 127.0.0.1:9071 0.0.0.0:* users:(("node-MainThread",pid=${PROXY_LISTENER_PID},fd=34))\n`,
      stderr: '',
    };
  }
  if (cmd === 'find') return { stdout: `${(BOOT_MS + 120_000) / 1000} packages/operator-core/lib/dbos/x.ts\n`, stderr: '' };
  throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
}

const prevRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;

beforeEach(() => {
  delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  execFileViaSidecar.mockReset();
  execFileViaSidecar.mockImplementation(async (cmd: string, args: string[]) => seamResponse(cmd, args));
  boundedPgReadTxn.mockReset();
  boundedPgReadTxn.mockResolvedValue([
    {
      host: hostname(),
      pid: 4242,
      reportedAt: new Date(BOOT_MS + 1_000).toISOString(),
      treeSha: LOADED_SHA,
      bundleVersion: null,
    },
  ]);
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = prevRoot;
});

describe('code-drift probes route git/find through the spawner sidecar (WI-10005118)', () => {
  it('defaultCodeDriftExec: one fallback label and kill-switch for the whole probe family', async () => {
    const { defaultCodeDriftExec, CODE_DRIFT_SIDECAR_VAR } = await import('./service-health');
    await expect(
      defaultCodeDriftExec('git', ['rev-parse', 'HEAD'], { cwd: '/repo', timeout: 3000, maxBuffer: 1024 }),
    ).resolves.toEqual({ stdout: `${HEAD_SHA}\n` });
    expect(execFileViaSidecar).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
      cwd: '/repo',
      timeoutMs: 3000,
      maxBuffer: 1024,
      subsystem: 'code-drift-probe',
      sidecarVar: CODE_DRIFT_SIDECAR_VAR,
    });
  });

  it('defaultCodeDriftExec keeps execFile reject semantics (a failed child is not a success)', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 128, stdout: '', stderr: 'fatal' });
    execFileViaSidecar.mockRejectedValueOnce(err);
    const { defaultCodeDriftExec } = await import('./service-health');
    await expect(defaultCodeDriftExec('git', ['rev-parse', 'HEAD'], { timeout: 3000 })).rejects.toBe(err);
  });

  it.runIf(process.platform === 'linux')(
    'probeBgHostCodeDrift: all four spawns reach the seam and the reading is built from their output',
    async () => {
      const { probeBgHostCodeDrift, CODE_DRIFT_SIDECAR_VAR } = await import('./service-health');
      const result = await probeBgHostCodeDrift(BOOT_MS + 600_000);

      const calls = execFileViaSidecar.mock.calls.map(([cmd, args, opts]) => ({
        line: `${cmd} ${(args as string[])[0]} ${(args as string[])[1]}`,
        opts: opts as { subsystem: string; sidecarVar: string },
      }));
      expect(calls.map((c) => c.line)).toEqual([
        'git rev-parse --show-toplevel',
        'git rev-parse HEAD',
        'git diff --name-only',
        expect.stringMatching(/^find packages\/operator-core\/lib\/dbos /),
      ]);
      for (const { opts } of calls) {
        expect(opts).toMatchObject({ subsystem: 'code-drift-probe', sidecarVar: CODE_DRIFT_SIDECAR_VAR });
      }

      // A fail-soft fallback would say "probe failed" with present:false; this reading
      // used the identity leg (runtime-vintage sha vs HEAD, diffed via the seam).
      expect(result.present).not.toBe(false);
      expect(result.note).not.toContain('probe failed');
      expect(JSON.stringify(result)).toContain(LOADED_SHA.slice(0, 7));
    },
  );

  it.runIf(process.platform === 'linux')(
    'probeMcpProxyCodeDrift matches runtime-vintage to the listener PID when systemd MainPID is an npx wrapper',
    async () => {
      const { probeMcpProxyCodeDrift } = await import('./service-health');
      const { probeServiceStart } = await import('./agent-tools/dev/systemd-service-probe');
      vi.mocked(probeServiceStart).mockResolvedValue({
        ok: true,
        mainPid: 4242,
        startedAtMs: BOOT_MS,
      });
      boundedPgReadTxn.mockResolvedValue([
        {
          host: hostname(),
          pid: PROXY_LISTENER_PID,
          reportedAt: new Date(BOOT_MS + 1_000).toISOString(),
          treeSha: LOADED_SHA,
          bundleVersion: null,
        },
      ]);
      execFileViaSidecar.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'find') {
          return {
            stdout: `${(BOOT_MS - 120_000) / 1000} apps/operator/lib/mcp-proxy/proxy.ts\n`,
            stderr: '',
          };
        }
        return seamResponse(cmd, args);
      });

      const result = await probeMcpProxyCodeDrift(BOOT_MS + 600_000);

      expect(execFileViaSidecar).toHaveBeenCalledWith(
        'ss',
        ['-tlnpH'],
        expect.objectContaining({ subsystem: 'listening-sockets' }),
      );
      expect(result.provenance).toMatchObject({
        source: 'runtime-vintage',
        loadedSha: LOADED_SHA,
        expectedSha: HEAD_SHA,
        loadedPid: PROXY_LISTENER_PID,
      });
    },
  );
});
