/**
 * WI-10006347 — the leaked-webview reaper's /proc scan must not launch a process per
 * host process.
 *
 * Measured 2026-10-06: papercup-webkit-reaper.service (TimeoutStartSec=30) failed
 * every 5-minute fire with Result=timeout after ~27 s of CPU. The WebKitWebProcess
 * scan ran `comm=$(cat "$comm_file")` for EVERY /proc/<pid>/comm, and the host had
 * ~7,800 processes, so the scan alone outgrew the unit's budget. Its cost scales with
 * the host's process count, which a wall-clock assertion on this shared, loaded box
 * cannot pin reliably.
 *
 * So this guard counts external LAUNCHES instead: the real script runs in DRY_RUN
 * with recording PATH shims for the text tools, and the number of launches must not
 * scale with the number of processes. A calibration case proves the scan really ran:
 * a fake WebKitWebProcess (a copied `sleep` binary, whose kernel comm is the
 * 15-char "WebKitWebProces") must be found by pid.
 *
 * Safety: DRY_RUN makes do_kill() log instead of kill; the desktop/orphan age
 * thresholds are set out of reach so no candidate is acted on. Step 3's SIGCHLD
 * nudge to zombie parents is not DRY_RUN-gated; it is the same harmless nudge the
 * live unit sends every 5 minutes.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the suite at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../../bin/reap-leaked-webviews.sh');
const SHIMMED = ['cat', 'sed', 'awk', 'grep', 'head', 'tr', 'cut'];

let roots: string[] = [];
let children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function hostProcessCount(): number {
  return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
}

function runReaper() {
  const root = mkdtempSync(join(tmpdir(), 'webkit-reaper-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'launches.log');
  for (const tool of SHIMMED) {
    const real = existsSync(`/usr/bin/${tool}`) ? `/usr/bin/${tool}` : `/bin/${tool}`;
    const p = join(bin, tool);
    writeFileSync(p, `#!/bin/bash\necho ${tool} >>'${calls}'\nexec ${real} "$@"\n`);
    chmodSync(p, 0o755);
  }
  // A fake WebKitWebProcess: the kernel comm is the binary's basename cut to 15 chars.
  const fake = join(root, 'WebKitWebProcess');
  copyFileSync('/usr/bin/sleep', fake);
  chmodSync(fake, 0o755);
  const child = spawn(fake, ['120'], { stdio: 'ignore' });
  children.push(child);

  const procs = hostProcessCount();
  const run = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      WEBKIT_REAPER_DRY_RUN: '1',
      WEBKIT_REAPER_ORPHAN_THRESHOLD: '999999999',
      WEBKIT_REAPER_DESKTOP_STALE: '999999999',
    },
  });
  const launches = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  return { stdout: run.stdout ?? '', status: run.status, fakePid: child.pid as number, procs, launches };
}

describe('reap-leaked-webviews.sh /proc scan (WI-10006347)', () => {
  it('calibration: the scan finds a WebKitWebProcess by pid and the run completes', () => {
    const r = runReaper();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`WebKitWebProcess pid=${r.fakePid}`);
    expect(r.stdout).toContain('Summary:');
  });

  it('launches a bounded number of helper processes, not one per host process', () => {
    const r = runReaper();
    // Without this the bound below would be vacuous on a near-empty host.
    expect(r.procs).toBeGreaterThan(50);
    const cats = r.launches.filter((l) => l === 'cat').length;
    expect(cats).toBeLessThan(10);
    // Per-CANDIDATE work (ppid/etimes for each WebKitWebProcess) is fine; per-HOST-
    // process work is the regression. A quarter of the process count is far above
    // any per-candidate cost and far below a per-process loop.
    expect(r.launches.length).toBeLessThan(Math.floor(r.procs / 4));
  });
});
