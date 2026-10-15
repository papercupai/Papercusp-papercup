/**
 * Shared child-process runner for the cc-hook suites.
 *
 * Two invariants live here — both learned the hard way, both previously re-derived (and one of
 * them silently dropped) in every hook suite that spawns a hook. Keep them in ONE place so a new
 * hook test inherits them instead of rediscovering them:
 *
 * 1. ASYNC spawn — never `spawnSync`. These suites stand up in-process HTTP stubs for the
 *    operator. `spawnSync` blocks the whole Node event loop, so the stub can never answer and
 *    every server-hitting case looks like a hook-side timeout instead of the case under test.
 *
 * 2. EPIPE on the stdin write is EXPECTED — not a fault. Every cc hook guards FIRST and reads
 *    stdin SECOND (`exit 0` before `INPUT=$(cat)`) so that it can never block a prompt. On those
 *    guard paths the child is therefore already gone when this write lands, and the write hits a
 *    closed pipe. Left unhandled it does not fail one assertion — it surfaces as a vitest
 *    UNHANDLED ERROR and reds the whole FILE with every assertion green, which is exactly how it
 *    hid: it reddened the release gate intermittently through 2026-07-12 (~25% of runs on an idle
 *    box, worse under checkpoint load) while the tests themselves looked fine.
 *
 * Any stdin error OTHER than EPIPE is real and still rejects.
 *
 * Probing a RELOCATED or HISTORICAL copy of a hook (A/B a pre-fix version)? Do not `cp` one file to
 * /tmp: the hook's sibling imports die, fail-open turns the crash into empty stdout, and every case
 * reads ALLOW. Use `./hook-probe` (whole-directory copy + positive control + CRASHED verdict).
 */
import { spawn } from 'node:child_process';

export interface HookRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runHookProcess(
  command: string,
  args: string[],
  // A plain string map, not NodeJS.ProcessEnv: this repo augments ProcessEnv to REQUIRE NODE_ENV,
  // and a hook is deliberately handed a hermetic, hand-built env (no NODE_ENV) in several suites.
  // `spawn` only ever needs a string map. `process.env` still satisfies this.
  opts: { input?: string; env: Record<string, string | undefined> },
): Promise<HookRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', reject);
    // Invariant 2 — see the file header. The hook exiting before it reads stdin is the
    // fail-open contract working, not a failure to report.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') reject(err);
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}
