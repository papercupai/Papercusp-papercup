/**
 * verify-tauri-headless-bind-retry.test.ts — the RECURRENCE GUARD for
 * EI-18734124566158657.
 *
 * The bug: scripts/verify-tauri-headless.sh picks a free port (fed_pick_free_port)
 * and takes an advisory flock on it (fed_acquire_port_lock), but that lock only
 * protects against a CONCURRENT invocation of THIS SAME script racing for the same
 * port — it does nothing against a squatter that never took the lock at all (a
 * leaked/orphaned sidecar from a crashed prior run, or an unrelated process that
 * happens to bind the same port during the ~2-minute Xvfb+cargo+webview boot
 * between our ss-probe and our sidecar's actual bind). That still surfaced as a
 * FATAL EADDRINUSE ~120s into boot, with no retry — the caller had to notice the
 * non-zero exit and re-run the whole expensive boot by hand.
 *
 * The fix: bound, automatic retry. On detecting the sidecar lost the bind race,
 * tear down this attempt, release the stale port lock, re-pick+re-lock a FRESH
 * port pair (reusing the same pick_and_lock_ports walk-forward the initial pick
 * uses), and re-launch — before surfacing anything as fatal. Only a SECOND loss
 * (default MAX_BOOT_ATTEMPTS=2) is fatal.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts): the script boots a real
 * Tauri/Xvfb/sidecar stack, so this wiring can only be asserted at the wiring
 * site, not by running it in CI.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without ever mutating the
// shared checkout (where git-sync would happily commit the mutant mid-probe).
// This seam is load-bearing: mutation-probe.sh's own EXAMPLE names THIS file, so
// without it the documented invocation reads the unmutated tracked script and
// reports a false "mutant SURVIVED" (WI-39608).
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const BUILD_RS = resolve(__dirname, '../../../papercusp-desktop/src-tauri/build.rs');

describe('WI-6554700010008930 — boot bind evidence survives retry and cleanup', () => {
  const capture = src.match(/retain_boot_attempt_evidence\(\) \{[\s\S]*?\n\}/)?.[0];
  const bindProbe = src.match(/verify_reserved_port_pair\(\) \{[\s\S]*?\n\}/)?.[0];

  it('measures actual binds and distinguishes an occupied pair from an invalid probe', async () => {
    expect(bindProbe).toBeTruthy();
    const holder = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(0, '127.0.0.1', resolve);
      });
      const address = holder.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP listener');
      const probe = (port: number, env = process.env) => spawnSync('bash', ['-c', `
        set -eu
        DEV_PORT="$1"; PTY_PORT=0
        ${bindProbe}
        verify_reserved_port_pair
      `, '_', String(port)], { encoding: 'utf8', timeout: 10_000, env });
      const occupied = probe(address.port);
      expect(occupied.status, occupied.stderr).toBe(3);
      expect(occupied.stderr).toContain('EADDRINUSE');
      await new Promise<void>(resolve => holder.close(() => resolve()));
      const free = probe(address.port);
      expect(free.status, free.stderr).toBe(0);
      const invalid = probe(65536);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('ERR_SOCKET_BAD_PORT');
      expect(invalid.stderr).not.toContain('EADDRINUSE');
      const failedChild = probe(address.port, { ...process.env, NODE_OPTIONS: '--require=/papercusp-missing-bind-probe-preload.cjs' });
      expect(failedChild.status).toBe(1);
      expect(failedChild.stderr).not.toContain('VERIFY_TAURI_PORT_BIND_PROBE');
    } finally {
      if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve()));
    }
  });

  it('accepts an allocated pair only after the real bind probe, and fails closed on unknown outcomes', () => {
    const pick = src.match(/pick_and_lock_ports\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(pick).toContain('if verify_reserved_port_pair; then return 0;');
    expect(pick.indexOf('fed_acquire_port_lock "$PTY_PORT"')).toBeLessThan(pick.indexOf('verify_reserved_port_pair'));
    const result = spawnSync('bash', ['-c', `
      set -eu
      PORT_BASE=34567; PORT_LOCK_DIR=/unused
      fed_pick_free_port() { echo "$1"; }
      fed_acquire_port_lock() { return 0; }
      fed_release_port_locks() { echo released; }
      verify_reserved_port_pair() { return 2; }
      ${pick}
      pick_and_lock_ports
      echo incorrectly-accepted
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unmeasured or invalid');
    expect(result.stdout).not.toContain('incorrectly-accepted');
  });

  function captureAttempt(dir: string, port: number, env: NodeJS.ProcessEnv = process.env) {
    expect(capture).toBeTruthy();
    return spawnSync('bash', ['-c', `
      set -eu
      WORK="$1"
      VH_RUN_DIR="$1/retained"
      LOG="$1/tauri.log"
      BOOT_ATTEMPTS=1
      DEV_PORT="$2"
      PTY_PORT="$2"
      ${capture}
      retain_boot_attempt_evidence
    `, '_', dir, String(port)], { encoding: 'utf8', timeout: 10_000, env });
  }

  it('retains a real listener identity and log before the listener exits, without overwriting it later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-bind-evidence-'));
    const holder = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(0, '127.0.0.1', resolve);
      });
      const address = holder.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP listener');
      writeFileSync(join(dir, 'tauri.log'), 'fatal EADDRINUSE on selected port\n');
      const run = captureAttempt(dir, address.port);
      expect(run.status, run.stderr).toBe(0);
      const evidence = join(dir, 'retained/phases/boot/operator-startup/attempt-1');
      const original = readFileSync(join(evidence, 'listeners.json'), 'utf8');
      const report = JSON.parse(original);
      expect(report.observations[0].status, JSON.stringify(report.observations[0])).toBe('listening');
      if (report.observations[0].holderStatus === 'measured') {
        expect(report.observations[0].listeners.flatMap((x: { holders: unknown[] }) => x.holders))
          .toContainEqual(expect.objectContaining({ pid: process.pid, startTimeTicks: expect.any(String) }));
      } else {
        expect(report.observations[0]).toMatchObject({ holderStatus: 'unknown', holderErrorCode: expect.anything() });
      }
      await new Promise<void>(resolve => holder.close(() => resolve()));
      expect(captureAttempt(dir, address.port).status).toBe(0);
      expect(readFileSync(join(evidence, 'listeners.json'), 'utf8')).toBe(original);
      rmSync(join(dir, 'tauri.log'));
      expect(readFileSync(join(evidence, 'tauri.log'), 'utf8')).toBe('fatal EADDRINUSE on selected port\n');
      expect(original).not.toMatch(/cmdline|environ|NODE_OPTIONS/);
    } finally {
      if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([0, 7])('distinguishes an empty socket read from an unmeasured failed read (exit %s)', status => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-bind-query-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ss'), `#!/bin/sh\necho private-diagnostic-must-not-be-retained >&2\nexit ${status}\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'tauri.log'), 'attempt log\n');
      const run = captureAttempt(dir, 34567, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
      expect(run.status, run.stderr).toBe(0);
      const text = readFileSync(join(dir, 'retained/phases/boot/operator-startup/attempt-1/listeners.json'), 'utf8');
      expect(JSON.parse(text).observations[0]).toMatchObject(status === 0
        ? { status: 'free', listeners: [] }
        : { status: 'unknown', exitStatus: status });
      expect(text).not.toContain('private-diagnostic-must-not-be-retained');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves measured socket presence when optional process attribution fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verifier-bind-attribution-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ss'), '#!/bin/sh\nif [ "$1" = "-tlnpH" ]; then exit 7; fi\necho "LISTEN 0 128 127.0.0.1:34567 0.0.0.0:*"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'tauri.log'), 'attempt log\n');
      const run = captureAttempt(dir, 34567, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(dir, 'retained/phases/boot/operator-startup/attempt-1/listeners.json'), 'utf8'));
      expect(report.observations[0]).toMatchObject({ status: 'listening', holderStatus: 'unknown', holderErrorCode: 7,
        listeners: [{ localAddress: '127.0.0.1:34567', holders: [] }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('captures before killing an attempt, changing ports, or cleaning the source on final exit', () => {
    const retry = src.slice(src.indexOf('  retain_boot_attempt_evidence || boot_failure_diag'), src.indexOf('# EI-10387 recurrence guard'));
    expect(retry.indexOf('retain_boot_attempt_evidence')).toBeLessThan(retry.indexOf('kill -TERM -- -$TAURI_PID'));
    expect(retry.indexOf('retain_boot_attempt_evidence')).toBeLessThan(retry.indexOf('pick_and_lock_ports'));
    const teardown = src.match(/teardown\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(teardown).toContain('if ! retain_boot_attempt_evidence; then');
    expect(teardown.indexOf('retain_boot_attempt_evidence')).toBeLessThan(teardown.indexOf('"$WORK/stop.sh"'));
    expect(teardown.indexOf('retain_boot_attempt_evidence')).toBeLessThan(teardown.indexOf('cleanup_operator_source_snapshot'));
  });
});

describe('EI-26073173753563377 — desktop binary readiness polling is quiet and content-aware', () => {
  const readinessProbe = src.match(
    /strip_ansi\(\) \{[\s\S]*?\}\ndesktop_binary_started\(\) \{[\s\S]*?\n\}/,
  )?.[0];

  function probe(log: string | undefined) {
    expect(readinessProbe).toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'verifier-readiness-'));
    const logPath = join(dir, 'tauri.log');
    if (log !== undefined) writeFileSync(logPath, log);
    const run = spawnSync(
      'bash',
      [
        '-c',
        `
set -eu
LOG="$1"
${readinessProbe}
if desktop_binary_started; then
  printf 'ready\\n'
else
  printf 'not-ready\\n'
fi
`,
        '_',
        logPath,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    rmSync(dir, { recursive: true, force: true });
    return run;
  }

  it('treats a not-yet-created log as not ready without leaking an open error', () => {
    const run = probe(undefined);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('not-ready\n');
    expect(run.stderr).toBe('');
  });

  it('strips ANSI SGR escapes before recognizing Cargo\'s Running marker', () => {
    const run = probe('\u001b[1m\u001b[92m     Running\u001b[0m `/tmp/debug/papercusp-desktop`\n');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('ready\n');
    expect(run.stderr).toBe('');
  });

  it('keeps non-ready Cargo output false', () => {
    const run = probe('   Compiling papercusp-desktop v0.1.0\nFinished dev profile\n');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('not-ready\n');
    expect(run.stderr).toBe('');
  });
});

/**
 * The variable name out of bash's `set -u` diagnostic ("foo: unbound variable"), or
 * undefined when the failure was something else. Deliberately narrow: it must stay
 * silent on an ordinary non-zero exit so it never re-labels an unrelated failure as
 * stand-in drift. The control case below pins it to what THIS bash actually prints.
 */
function unboundVarFrom(stderr: string | undefined): string | undefined {
  return stderr?.match(/([A-Za-z_][A-Za-z0-9_]*): unbound variable/)?.[1];
}

describe('EI-18734124566158657 — verify-tauri-headless retries once on a bind-time port race', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
  });

  it('factors the port pick+lock walk-forward into a reusable function', () => {
    const fn = src.match(/pick_and_lock_ports\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/fed_pick_free_port "\$PORT_BASE"/);
    expect(fn).toMatch(/fed_acquire_port_lock "\$DEV_PORT" "\$PORT_LOCK_DIR"/);
    expect(fn).toMatch(/fed_acquire_port_lock "\$PTY_PORT" "\$PORT_LOCK_DIR"/);
    // The initial pick calls the same function — one procedure, not a duplicate copy.
    expect(src).toMatch(/\npick_and_lock_ports\n/);
  });

  it('factors launch.sh generation + exec into a reusable function so a retry can re-run it', () => {
    const fn = src.match(/write_and_launch_tauri\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    // The launcher is routed through start_verify_process so Linux runs escape
    // the operator service cgroup while non-systemd hosts retain the setsid
    // process-group fallback. The returned client pid is the teardown handle.
    expect(fn).toContain('TAURI_SCOPE_UNIT="${VERIFY_SCOPE_BASE}-tauri-${BOOT_ATTEMPTS}"');
    expect(fn).toContain('start_verify_process "$TAURI_SCOPE_UNIT" "$LOG" "$WORK/launch.sh"');
    expect(fn).toContain('TAURI_PID="$VERIFY_STARTED_PROCESS_PID"');
    // Uses the CURRENT DEV_PORT/PTY_PORT at call time (not a value baked in once),
    // so a re-pick before the retry call actually changes what gets launched.
    expect(fn).toMatch(/OPERATOR_DEV_PORT="\$DEV_PORT" OPERATOR_DEV_PTY_PORT="\$PTY_PORT"/);
  });

  it('bounds the boot-attempt loop, configurable, defaulting to one retry', () => {
    expect(src).toMatch(/MAX_BOOT_ATTEMPTS="\$\{VERIFY_TAURI_MAX_BOOT_ATTEMPTS:-2\}"/);
    expect(src).toMatch(/BOOT_ATTEMPTS=0/);
  });

  it('on a bind-time EADDRINUSE with attempts remaining: kills this attempt, releases the lock, re-picks, and CONTINUES (never exits)', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();

    const retryBranch = loop!.match(
      /if \[ "\$BOOT_ATTEMPTS" -lt "\$MAX_BOOT_ATTEMPTS" \]; then([\s\S]*?)\n {2}fi/,
    )?.[1];
    expect(retryBranch).toBeTruthy();
    expect(retryBranch).toMatch(/kill -TERM -- -\$TAURI_PID/);
    expect(retryBranch).toMatch(/fed_release_port_locks/);
    expect(retryBranch).toMatch(/pick_and_lock_ports/);
    expect(retryBranch).toMatch(/continue/);
    // The retry path must never itself exit — only the post-retry-budget fatal below does.
    expect(retryBranch).not.toMatch(/exit 1/);
  });

  it('only surfaces fatal once the retry budget is exhausted, and says so', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    // The FATAL branch (after the retry-budget guard) — must still exist and exit 1.
    expect(loop).toMatch(/FATAL: our operator sidecar could not bind :\$DEV_PORT \(EADDRINUSE\)/);
    expect(loop).toMatch(/attempt\(s\) across freshly-picked ports/);
    const fatalIdx = loop!.indexOf('FATAL: our operator sidecar could not bind');
    const exitIdx = loop!.indexOf('exit 1', fatalIdx);
    expect(fatalIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(fatalIdx);
  });

  it('a clean bind (no EADDRINUSE) breaks the loop and proceeds without retrying', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    expect(loop).toMatch(/if ! grep -qE "EADDRINUSE\.\*:\$DEV_PORT\\b" "\$LOG" 2>\/dev\/null; then\s*\n\s*break/);
  });

  it('non-port-race fatal exits (bridge timeout, tauri exited early) are unchanged — no retry for those', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    expect(loop).toMatch(/tauri dev exited before the bridge came up/);
    expect(loop).toMatch(/bridge did not come up within \$\{TIMEOUT\}s/);
  });
});

/**
 * EI-19446616147360269 — the retry above was REACHABLE only if the bridge came up.
 *
 * Every assertion in the suite above passes on the broken script, because they all
 * check what the re-pick branch DOES and none check that control can ever REACH it.
 * The EADDRINUSE probe sat after the `until grep -q "dev bridge listening"` loop —
 * but losing the bind is precisely what stops that line from ever being written, so
 * the loop could only exit via its two boot_failure_diag calls, both `exit 1`. For a
 * bind-time squatter the retry was dead code.
 *
 * Measured 2026-08-03 on the reporter's own artifact (work=/tmp/verify-tauri-headless.6Pb3fG):
 * `dev bridge listening` appeared 0 times, no tauri.attempt1.log was ever written
 * (the re-pick renames the log, so its absence proves the branch never ran), and
 * 0.0.0.0:33700 was the ONLY port the log ever mentioned across ~4 minutes.
 *
 * So these pin REACHABILITY and ORDER, not content — the properties whose absence
 * the sibling assertions could not detect.
 */
describe('EI-19446616147360269 — the bind-time re-pick is reachable without the bridge', () => {
  const waitLoop = (): string => {
    const body = src.match(/until grep -q "dev bridge listening"[\s\S]*?\n {2}done/)?.[0];
    expect(body, 'the dev-bridge wait loop must still be findable').toBeTruthy();
    return body!;
  };
  /**
   * Comments must be stripped before any ORDER assertion: the loop body's own
   * commentary names both `port_lost_to_squatter` and `boot_failure_diag`, so a raw
   * indexOf measures PROSE POSITION rather than call order — it read the mention
   * inside the explanatory comment and failed against correct code. An order guard
   * that can be satisfied (or broken) by editing a comment is not measuring the fix.
   */
  const codeOnly = (s: string): string =>
    s
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  it('detects the lost port INSIDE the wait loop, not only after it', () => {
    expect(codeOnly(waitLoop())).toMatch(/port_lost_to_squatter/);
  });

  it('checks for the lost port BEFORE the two fatal probes, so a sidecar that died OF it re-picks instead of exiting', () => {
    const body = codeOnly(waitLoop());
    const lostIdx = body.indexOf('port_lost_to_squatter');
    const fatalIdx = body.indexOf('boot_failure_diag');
    expect(lostIdx).toBeGreaterThan(-1);
    expect(fatalIdx).toBeGreaterThan(-1);
    // Order is the whole fix: both boot_failure_diag calls exit 1.
    expect(lostIdx).toBeLessThan(fatalIdx);
  });

  it('breaks the wait loop on a lost port so control reaches the existing re-pick branch', () => {
    expect(waitLoop()).toMatch(/if port_lost_to_squatter; then PORT_LOST=1; break; fi/);
  });

  it('only trips on the TERMINAL give-up, never on hono-host\'s transient [listen-retry] self-recovery', () => {
    const fn = src.match(/port_lost_to_squatter\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    // Requiring the fatal marker is what leaves the 8x1s straggler recovery alone;
    // matching a bare EADDRINUSE here would abort boots that heal themselves.
    expect(fn).toMatch(/fatal uncaughtException/);
    expect(fn).toMatch(/EADDRINUSE/);
    expect(fn).toMatch(/\$DEV_PORT/);

    // Behavioural proof against the two REAL log lines (verbatim from the reporter's
    // tauri.log), so this cannot pass on a regex that merely looks plausible.
    const re = new RegExp(
      fn!.match(/grep -qE "([^"]+)"/)![1].replace('$DEV_PORT', '33700'),
    );
    expect(
      re.test(
        '[listen-retry] EADDRINUSE on 0.0.0.0:33700 (attempt 1/8) — retrying in 1000ms (transient-straggler recovery, EI-18734124566158657)',
      ),
      'transient listen-retry must NOT trip the re-pick',
    ).toBe(false);
    expect(
      re.test(
        '[hono-host] fatal uncaughtException — exiting: Error: listen EADDRINUSE: address already in use 0.0.0.0:33700',
      ),
      'the terminal give-up MUST trip the re-pick',
    ).toBe(true);
    expect(
      re.test('[hono-host] fatal EADDRINUSE during pre-bootstrap port check: 127.0.0.1:33700 is already in use'),
      'the pre-bootstrap terminal conflict MUST trip the same re-pick',
    ).toBe(true);
    expect(
      re.test('[hono-host] fatal EADDRINUSE during pre-bootstrap port check: 127.0.0.1:33701 is already in use'),
      'another port must not trigger this verifier re-pick',
    ).toBe(false);
  });

  it('surfaces the lost port on the script\'s OWN stdout — a dead boot must not read as a slow one', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toMatch(/log "sidecar GAVE UP binding :\$DEV_PORT/);
  });

  it('still reports "bridge is up" only when the bridge actually came up', () => {
    const loop = src.match(/\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    // Guards the obvious regression: an unconditional "bridge is up" log after a
    // loop that can now exit without one.
    expect(loop).toMatch(/else\n\s*log "bridge is up after \$\{ELAPSED\}s"/);
  });
});

describe('EI-21467292301306028 — a bind retry re-embeds the re-picked devUrl', () => {
  it('forces attempt-one EADDRINUSE and gives attempt two a distinct Cargo rerun key', () => {
    const launchFn = src.match(/^write_and_launch_tauri\(\) \{[\s\S]*?^\}/m)?.[0];
    const portLostFn = src.match(/^port_lost_to_squatter\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(launchFn, 'write_and_launch_tauri() must remain directly exercisable').toBeTruthy();
    expect(portLostFn, 'port_lost_to_squatter() must remain directly exercisable').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'ei21467292-'));
    try {
      const probe = `
set -euo pipefail
${launchFn}
${portLostFn}
start_verify_process() { VERIFY_STARTED_PROCESS_PID="$$"; }
verify_tauri_dev_url() { printf 'http://127.0.0.1:%s' "$1"; }
WORK="$1"
DESKTOP_DIR="$1"
ISOLATED_DB=0
NATIVE_TERMINAL=0
VERIFY_TAURI_TRACE_SESSION_CHAT_CSS=0
DISPLAY_NUM=90
TAURI_OWNER_SID=probe-owner
TAURI_LAUNCH_PROVENANCE=agent:probe-owner
MEMORY_LIMIT_MB=1024
NATIVE_CARGO_DISK_RESERVATION_FILE=
SPA_ENV_LINE=
ISOLATED_ENV_LINE=
ISOLATED_UNSET_LINE=
OPERATOR_SOURCE_ENV_LINE=
WINDOW_GEOMETRY=
LAUNCH_PREFIX=()
VERIFY_SCOPE_BASE=probe
BOOT_ATTEMPTS=1
DEV_PORT=33700
PTY_PORT=33704
LOG="$WORK/tauri.log"
write_and_launch_tauri
cp "$WORK/launch.sh" "$WORK/attempt1.sh"
printf '%s\\n' '[hono-host] fatal uncaughtException — exiting: Error: listen EADDRINUSE: address already in use 0.0.0.0:33700' > "$LOG"
if port_lost_to_squatter; then
  BOOT_ATTEMPTS=2
  DEV_PORT=33701
  PTY_PORT=33705
  write_and_launch_tauri
  cp "$WORK/launch.sh" "$WORK/attempt2.sh"
fi
`;
      const run = spawnSync('bash', ['-c', probe, '_', dir], { encoding: 'utf8' });

      // The assignments above are a hand-maintained mirror of the variables
      // write_and_launch_tauri() reads from its SURROUNDING scope — the probe runs it
      // in isolation under `set -u`, so a variable the script grows but this block
      // lacks kills the probe with an opaque "line N: FOO: unbound variable" that says
      // nothing about the mirror or about which change introduced it. That is exactly
      // how NATIVE_TERMINAL landed on 2026-08-26: the script started passing
      // PAPERCUSP_NATIVE_TERMINAL="$NATIVE_TERMINAL", this block did not follow, and the
      // red surfaced hours later inside an unrelated agent's affected-tests run.
      // The detector was never missing; its diagnostic was. Name the repair instead.
      const unbound = unboundVarFrom(run.stderr);
      expect(
        unbound,
        `write_and_launch_tauri() now reads $${unbound} from its surrounding scope, but the probe's stand-in assignments do not define it. Add "${unbound}=<the script's own default>" to that block — do NOT give the variable a :- default inside the script, which would mask a genuine unset in a real run.`,
      ).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);

      const attempt1 = readFileSync(join(dir, 'attempt1.sh'), 'utf8');
      const attempt2 = readFileSync(join(dir, 'attempt2.sh'), 'utf8');
      expect(attempt1).toContain('PAPERCUSP_VERIFY_TAURI_DEV_URL="http://127.0.0.1:33700"');
      expect(attempt2).toContain('PAPERCUSP_VERIFY_TAURI_DEV_URL="http://127.0.0.1:33701"');
      expect(attempt2).toContain('PAPERCUSP_DEV_API_TARGET="33701"');
      expect(attempt2).toContain('"devUrl":"http://127.0.0.1:33701"');

      const buildRs = readFileSync(BUILD_RS, 'utf8');
      expect(buildRs).toContain(
        'cargo:rerun-if-env-changed=PAPERCUSP_VERIFY_TAURI_DEV_URL',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL (falsifiability): the stand-in drift diagnostic reads a REAL bash `set -u` failure', () => {
    // Pinned against live bash rather than a remembered message format, so this cannot
    // rot into a detector that silently stops matching what bash prints. Without this
    // control the assertion above would pass just as happily with a regex that never
    // fires — which is the same silent gap the NATIVE_TERMINAL drift exploited.
    const real = spawnSync('bash', ['-c', 'set -u; echo "$PROBE_DEFINITELY_NOT_SET"'], {
      encoding: 'utf8',
    });
    expect(real.status, 'bash must actually fail on an unset variable under set -u').not.toBe(0);
    expect(unboundVarFrom(real.stderr)).toBe('PROBE_DEFINITELY_NOT_SET');

    // ...and stays silent on an ordinary failure, so a broken script is never
    // misreported as stand-in drift.
    expect(unboundVarFrom('probe.sh: line 4: cargo: command not found')).toBeUndefined();
    expect(unboundVarFrom(undefined)).toBeUndefined();
  });
});
