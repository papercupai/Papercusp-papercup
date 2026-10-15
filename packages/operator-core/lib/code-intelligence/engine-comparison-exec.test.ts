import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execTimed } from './engine-comparison-arms';

// Recurrence guard for the P-005 bench defect (2026-10-01): `execFile`'s own `timeout` kills only its
// direct child (`/usr/bin/time`), so a wrapped analyzer grandchild survived its 30-min deadline as an
// orphan, kept writing into the arm tree, and contaminated the next phase's measurement.

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** `sh` forks a long-lived grandchild, records its pid, and waits — the shape of `gitnexus analyze`. */
const grandchildScript = (pidFile: string): string => `sleep 300 & echo $! > ${pidFile}; wait`;

async function waitDead(pid: number, withinMs: number): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

describe('execTimed deadline enforcement', () => {
  it('a timeout kills the WHOLE process group — no orphaned grandchild survives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-cmp-exec-test-'));
    const pidFile = join(dir, 'grandchild.pid');
    let pid = 0;
    try {
      const r = await execTimed('sh', ['-c', grandchildScript(pidFile)], { cwd: dir, timeoutMs: 1500 });
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      expect(r.code).toBe(124); // GNU timeout's deadline exit code
      expect(await waitDead(pid, 5000)).toBe(true);
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('CONTROL: the pre-fix mechanism (execFile timeout around /usr/bin/time) DOES leave the grandchild alive', async () => {
    // Keeps the instrument honest: if this ever reads "dead", the test above can no longer see an orphan.
    const dir = mkdtempSync(join(tmpdir(), 'engine-cmp-exec-control-'));
    const pidFile = join(dir, 'grandchild.pid');
    let pid = 0;
    try {
      await new Promise<void>((resolve) => {
        execFile(
          '/usr/bin/time', ['-v', '-o', join(dir, 'time.txt'), 'sh', '-c', grandchildScript(pidFile)],
          { cwd: dir, timeout: 1500 },
          () => resolve(),
        );
      });
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      await sleep(500);
      expect(alive(pid)).toBe(true);
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a command that finishes inside the deadline is unaffected (exit code and peak RSS still measured)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-cmp-exec-ok-'));
    try {
      // GNU time can legitimately report zero RSS for a shell that only runs
      // a builtin before exiting. Touch real memory so a positive measurement
      // checks the instrument rather than depending on that scheduling race.
      const r = await execTimed(process.execPath, ['-e',
        'const bytes = Buffer.alloc(16 * 1024 * 1024, 1); console.log(bytes[bytes.length - 1] === 1 ? "hi" : "bad");',
      ], { cwd: dir, timeoutMs: 20_000 });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('hi');
      expect(r.peakRssKb).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
