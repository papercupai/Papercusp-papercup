/**
 * jev-memory-timeouts-to-zero-2026-10-01 D-001: `probeServiceStart` derives
 * `ps -o etimes=` from /proc instead of forking `ps` from a multi-GB operator.
 *
 * Covers the parse (including a `comm` that contains spaces and ')'), the
 * fork-free path, the `ps` fallback, and a live comparison against real `ps`
 * so the derivation cannot silently drift from procps' definition.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { probeServiceStart, readProcElapsedSeconds } from './systemd-service-probe';

/** A /proc/<pid>/stat line whose field 22 (starttime) is `startTicks`. */
function statLine(pid: number, comm: string, startTicks: number): string {
  // Fields 3..21 after "(comm) ", then starttime (22), then a few trailing fields.
  const before = ['S', '1', String(pid), String(pid), '0', '-1', '4194560', '100', '0', '0', '0', '5', '3', '0', '0', '20', '0', '1', '0'];
  return `${pid} (${comm}) ${[...before, String(startTicks), '12345', '678'].join(' ')}\n`;
}

function fakeProc(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const body = files[path];
    if (body === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    return body;
  };
}

describe('readProcElapsedSeconds', () => {
  it('computes floor(uptime - starttime / USER_HZ), counting fields after the LAST ")"', async () => {
    const read = fakeProc({
      '/proc/uptime': '12345.67 99999.00\n',
      '/proc/42/stat': statLine(42, 'we ird) name', 1_000_050), // 10000.5 s after boot
    });
    // floor(12345.67 - 10000.5) = floor(2345.17).
    await expect(readProcElapsedSeconds(42, read)).resolves.toBe(2345);
  });

  it('returns null when the pid is gone, so the caller can fall back to ps', async () => {
    const read = fakeProc({ '/proc/uptime': '100.0 1.0\n' });
    await expect(readProcElapsedSeconds(7, read)).resolves.toBeNull();
  });

  it('returns null for an unparseable stat line', async () => {
    const read = fakeProc({ '/proc/uptime': '100.0 1.0\n', '/proc/7/stat': 'garbage without parens' });
    await expect(readProcElapsedSeconds(7, read)).resolves.toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('matches real `ps -o etimes=` for a live process', async () => {
    const before = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    const derived = await readProcElapsedSeconds(process.pid);
    const after = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    expect(derived).not.toBeNull();
    // ps may round in a different order: allow its 1 s granularity on each side.
    expect(derived as number).toBeGreaterThanOrEqual(before - 1);
    expect(derived as number).toBeLessThanOrEqual(after + 1);
  });
});

describe('probeServiceStart etimes source', () => {
  const showOutput = 'MainPID=4242\nActiveState=active\nLoadState=loaded\nNRestarts=3\n';

  it('does not fork ps when /proc answers', async () => {
    const commands: string[] = [];
    const info = await probeServiceStart(
      'papercusp-staging-api.service',
      async (command) => {
        commands.push(command);
        return { stdout: command === 'systemctl' ? showOutput : '999\n' };
      },
      async () => 7,
    );
    expect(commands).toEqual(['systemctl']);
    expect(info).toMatchObject({ ok: true, mainPid: 4242, secondsSinceStart: 7, nRestarts: 3 });
  });

  it('falls back to ps when /proc cannot answer', async () => {
    const commands: string[] = [];
    const info = await probeServiceStart(
      'papercusp-staging-api.service',
      async (command, args) => {
        commands.push(command);
        if (command === 'ps') {
          expect(args).toEqual(['-o', 'etimes=', '-p', '4242']);
          return { stdout: '  33\n' };
        }
        return { stdout: showOutput };
      },
      async () => null,
    );
    expect(commands).toEqual(['systemctl', 'ps']);
    expect(info).toMatchObject({ ok: true, mainPid: 4242, secondsSinceStart: 33 });
  });
});
