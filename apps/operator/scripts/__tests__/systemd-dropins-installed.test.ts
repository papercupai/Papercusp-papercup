import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(join(__dirname, '..', '..', '..', '..'));

/**
 * ⚠ KEEP THIS PATH AS ONE CONTIGUOUS STRING LITERAL. Do not "tidy" it into
 * join(REPO_ROOT, 'scripts', 'check-...mjs').
 *
 * scripts/check-lint-guard-reachability.mjs credits a guard as reachable by testing
 * `text.includes(implementationPath)` against this file's source. Split across join()
 * arguments the contiguous substring never appears, the guard scores UNREACHABLE, and the
 * gate reds with a false finding that sends someone to wire a guard already wired. That is
 * the exact false-positive direction that checker's own comments warn about — and it cost
 * a round trip here before the cause was found.
 */
const GUARD_REL = 'scripts/check-systemd-dropins-installed.mjs';
// Overridable only so a falsifiability probe can point these cases at a COPY of an older
// guard (outside the swept tree) instead of mutating the real file.
const GUARD = process.env.SYSTEMD_DROPIN_GUARD_UNDER_TEST ?? join(REPO_ROOT, GUARD_REL);
const AMBIENT_CURSOR_DROP_IN = join(
  REPO_ROOT,
  'apps/operator/scripts/systemd/papercup-dev-api.service.d/60-ambient-semantic-push.conf',
);
const CODE_SERVER_CRASH_LOOP_GUARD = join(
  REPO_ROOT,
  'apps/operator/scripts/systemd/code-server.service.d/10-crash-loop-guard.conf',
);
const DEMOS_GALLERY_SOURCE_GUARD = join(
  REPO_ROOT,
  'apps/operator/scripts/systemd/papercup-demos-gallery.service.d/10-require-gallery-source.conf',
);
const DIODON_MANAGED_UNIT = join(
  REPO_ROOT,
  'apps/operator/scripts/systemd/diodon-managed.service',
);

/**
 * Wires scripts/check-systemd-dropins-installed.mjs onto a blocking path.
 *
 * lint:guard-reachability rejects a guard that nothing runs, on the grounds that an
 * unwired guard "rots (false positives + baseline drift accrue invisibly) and its green
 * gets quoted as evidence." That is the same failure the guard itself exists to catch
 * (plan substrate-observability-bug-wave-2026-08-26, D-004), so leaving it unwired would
 * have reproduced the defect one level up.
 *
 * DELIBERATE SPLIT, because the guard asserts a fact that lives in systemd rather than in
 * the repo:
 *   - The FIRST test runs everywhere. It exercises the script and asserts its output is
 *     well-formed, so parsing/reporting regressions cannot rot unnoticed.
 *   - The SECOND test asserts real host state, and SKIPS where no user systemd manager is
 *     reachable (CI). On a host that does run these units — including the box the
 *     green-checkpoint runs on — it has teeth: a tracked drop-in that is not loaded fails
 *     it. That blast radius is intended. If the host running the gate has drifted from the
 *     repo's declared unit configuration, everything built on that assumption is already
 *     wrong, and three components were silently written against exactly that drift.
 */
function runGuard(
  args: string[],
  env?: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [GUARD, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout: `${err?.stdout ?? ''}`,
      stderr: `${err?.stderr ?? ''}`,
    };
  }
}

function userSystemdReachable(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000,
    });
    return true;
  } catch (err: any) {
    // is-system-running exits non-zero for healthy-but-degraded states, so only the
    // ABSENCE of output means there was no manager to talk to.
    return `${err?.stdout ?? ''}`.trim().length > 0;
  }
}

describe('systemd drop-in install guard (scripts/check-systemd-dropins-installed.mjs)', () => {
  it('ships the ambient semantic dead-end rail enabled, with an explicit kill switch', () => {
    const dropIn = readFileSync(AMBIENT_CURSOR_DROP_IN, 'utf8');
    expect(dropIn).toMatch(/^Environment=PAPERCUSP_AMBIENT_CURSOR=1$/m);
    expect(dropIn).toContain('Set the value to 0');
  });

  it('keeps optional user services from crash-looping after their prerequisites disappear', () => {
    const codeServer = readFileSync(CODE_SERVER_CRASH_LOOP_GUARD, 'utf8');
    expect(codeServer).toMatch(/^ConditionFileIsExecutable=%h\/\.local\/bin\/code-server$/m);
    expect(codeServer).toMatch(/^StandardOutput=journal$/m);
    expect(codeServer).toMatch(/^StandardError=journal$/m);
    expect(codeServer).toMatch(/^Restart=on-failure$/m);
    expect(codeServer).not.toContain('ConditionPathIsExecutable');

    const gallery = readFileSync(DEMOS_GALLERY_SOURCE_GUARD, 'utf8');
    expect(gallery).toMatch(
      /^ConditionPathExists=%h\/demos\/papercusp-offsite-planner\/serve-gallery\.py$/m,
    );
    expect(gallery).toMatch(
      /^ConditionPathIsDirectory=%h\/demos\/papercusp-offsite-planner\/public$/m,
    );
  });

  it('keeps the managed Diodon process resident after a clean exit', () => {
    const diodon = readFileSync(DIODON_MANAGED_UNIT, 'utf8');
    expect(diodon).toMatch(/^Restart=always$/m);
  });

  it('--list reports a well-formed population and never fails the build', () => {
    const { status, stdout } = runGuard(['--list']);
    expect(status).toBe(0);
    // The summary line is the contract other readers parse; keep it stable.
    expect(stdout).toMatch(/installed=\d+ missing=\d+ unit-absent=\d+/);
  });

  it('reports every tracked drop-in as loaded on a host that runs these units', () => {
    if (!userSystemdReachable()) {
      // Not silently passing: state plainly that the host fact went unverified here.
      console.log(
        'systemd drop-in host assertion SKIPPED — no user systemd manager reachable (expected in CI).',
      );
      return;
    }

    const { status, stdout, stderr } = runGuard([]);
    if (status === 2) {
      // Exit 2 = systemctl reads kept failing after retries: nothing was concluded, so this is
      // an unverified host fact (like the no-manager skip above), not drift. Drift is exit 1.
      console.log(`systemd drop-in host assertion NOT VERIFIED (exit 2):\n${stdout}${stderr}`);
      return;
    }
    expect(
      status,
      `A tracked systemd drop-in is not loaded by its unit on this host. The unit is ` +
        `running WITHOUT configuration this repo believes it has.\n${stdout}${stderr}`,
    ).toBe(0);

    const list = runGuard(['--list']);
    expect(list.stdout).toMatch(/missing=0/);
  });
});

/**
 * EI-24161579159727790: a failed or anomalous `systemctl show` read must never be reported
 * as a MISSING drop-in. Measured 2026-09-24 12:35 EDT: the guard reported
 * at-spi-dbus-bus.service/10-survive-bus-drop.conf MISSING while a concurrent run of the same
 * guard (no daemon-reload in the window) read it as loaded, because a failed read was mapped
 * to an empty DropInPaths. The supervision reconciler parses --list and files a work-item on
 * MISSING, so the false verdict also minted false work.
 *
 * These cases put a FAKE `systemctl` first on PATH, so each failure mode is deterministic and
 * the cases run in CI too (no real user manager needed). The fake answers every tracked unit
 * with all of its repo drop-ins loaded, then injects exactly one fault per mode.
 */
const FAKE_SYSTEMCTL = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// Scope-aware like the real thing: --user answers from scripts/systemd/<unit>.d, the system
// manager from scripts/systemd/system/<unit>.d (P-008 system drop-ins).
const isUser = process.argv.includes('--user');
const args = process.argv.slice(2).filter((a) => a !== '--user');
if (args[0] === 'is-system-running') { process.stdout.write('running\\n'); process.exit(0); }
// Prefix drop-ins (WI-6554700010012202): the guard lists live units for 'session-*.scope'.
// FAKE_LIVE_UNITS is a space-separated list of running units; '' means none is running.
if (args[0] === 'list-units') {
  if (process.env.FAKE_SYSTEMCTL_MODE === 'list-fail') {
    process.stderr.write('Failed to list units: Connection timed out\\n');
    process.exit(1);
  }
  const pattern = args.slice(1).find((a) => !a.startsWith('-')) ?? '*';
  const re = new RegExp('^' + pattern.replace(/[.]/g, '\\\\.').replace(/[*]/g, '.*') + '$');
  const live = (process.env.FAKE_LIVE_UNITS ?? 'session-7.scope').split(' ').filter(Boolean);
  const rows = live.filter((u) => re.test(u)).map((u) => u + ' loaded active running Fake ' + u);
  process.stdout.write(rows.length ? rows.join('\\n') + '\\n' : '');
  process.exit(0);
}
if (args[0] !== 'show') { process.stderr.write('fake systemctl: unsupported ' + args.join(' ') + '\\n'); process.exit(64); }
const counter = path.join(process.env.FAKE_SYSTEMCTL_STATE, 'show-calls');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
const mode = process.env.FAKE_SYSTEMCTL_MODE;
if (mode === 'always-fail' || (mode === 'fail-first' && n === 1)) {
  process.stderr.write('Failed to get properties: Connection reset by peer\\n');
  process.exit(1);
}
if (mode === 'empty-first' && n === 1) process.exit(0);
const drop = mode === 'drop-always' || (mode === 'drop-first' && n === 1);
const props = args.filter((a) => a.startsWith('--property=')).map((a) => a.slice('--property='.length));
const units = args.slice(1).filter((a) => !a.startsWith('-'));
// The 2026-09-24 incident, independent of how the guard batches its calls: the FIRST read of
// DropInPaths that covers the at-spi unit fails, while every other read succeeds.
const fired = path.join(process.env.FAKE_SYSTEMCTL_STATE, 'dropin-fault-fired');
if (mode === 'fail-dropin-read-once' && props.includes('DropInPaths') && units.includes(process.env.FAKE_DROP_UNIT) && !fs.existsSync(fired)) {
  fs.writeFileSync(fired, '1');
  process.stderr.write('Failed to get properties: Connection reset by peer\\n');
  process.exit(1);
}
const blocks = units.map((u) => {
  // Like systemd: a unit loads its own <unit>.d plus every prefix dir <name-up-to-a-dash>-.<type>.d.
  const [name, type] = [u.slice(0, u.lastIndexOf('.')), u.slice(u.lastIndexOf('.') + 1)];
  const dirNames = [u + '.d'];
  for (let i = name.indexOf('-'); i >= 0; i = name.indexOf('-', i + 1)) dirNames.push(name.slice(0, i + 1) + '.' + type + '.d');
  let confs = [];
  for (const dirName of dirNames) {
    const dir = path.join(process.env.FAKE_SYSTEMD_DIR, isUser ? '' : 'system', dirName);
    if (fs.existsSync(dir)) confs.push(...fs.readdirSync(dir).filter((c) => c.endsWith('.conf')));
  }
  if (drop && u === process.env.FAKE_DROP_UNIT) confs = confs.filter((c) => c !== process.env.FAKE_DROP_CONF);
  const values = { Id: u, LoadState: 'loaded', ActiveState: 'inactive',
    LimitNOFILESoft: mode === 'terminal-low-soft' ? '1024' : '1000000',
    DropInPaths: confs.map((c) => '/fake/' + u + '.d/' + c).join(' ') };
  return props.map((p) => p + '=' + (values[p] ?? '')).join('\\n');
});
process.stdout.write(blocks.join('\\n\\n') + '\\n');
`;

const DROP_UNIT = 'at-spi-dbus-bus.service';
const DROP_CONF = '10-survive-bus-drop.conf';

describe('systemd drop-in guard: a failed read is never a verdict (EI-24161579159727790)', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-systemctl-'));
  writeFileSync(join(binDir, 'systemctl'), FAKE_SYSTEMCTL);
  chmodSync(join(binDir, 'systemctl'), 0o755);
  afterAll(() => rmSync(binDir, { recursive: true, force: true }));

  function runWithFake(
    mode: string,
    args: string[] = [],
    drop: { unit: string; conf: string } = { unit: DROP_UNIT, conf: DROP_CONF },
    env: Record<string, string> = {},
  ) {
    const stateDir = mkdtempSync(join(binDir, 'state-'));
    const result = runGuard(args, {
      ...env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_SYSTEMCTL_MODE: mode,
      FAKE_SYSTEMCTL_STATE: stateDir,
      FAKE_SYSTEMD_DIR: join(REPO_ROOT, 'apps/operator/scripts/systemd'),
      FAKE_DROP_UNIT: drop.unit,
      FAKE_DROP_CONF: drop.conf,
      CHECK_SYSTEMD_DROPINS_RETRY_DELAY_MS: '0',
    });
    const showCalls = Number(readFileSync(join(stateDir, 'show-calls'), 'utf8'));
    return { ...result, showCalls, output: `${result.stdout}${result.stderr}` };
  }

  it('the fixture tracks the drop-in the fault cases remove (guards against a vacuous pass)', () => {
    expect(
      existsSync(join(REPO_ROOT, 'apps/operator/scripts/systemd', `${DROP_UNIT}.d`, DROP_CONF)),
    ).toBe(true);
  });

  it('replays the 2026-09-24 incident: a failed DropInPaths read is retried, not reported MISSING', () => {
    const r = runWithFake('fail-dropin-read-once');
    expect(r.showCalls).toBeGreaterThanOrEqual(2); // the fault actually fired, then was retried
    expect(r.output).not.toMatch(/NOT loaded|MISSING|UNREADABLE/);
    expect(r.status).toBe(0);
  });

  it('retries a failed read instead of reporting every drop-in MISSING', () => {
    const r = runWithFake('fail-first');
    expect(r.showCalls).toBeGreaterThanOrEqual(2); // the fault actually fired, then was retried
    expect(r.output).not.toMatch(/NOT loaded|MISSING|UNREADABLE/);
    expect(r.status).toBe(0);
  });

  it('retries an empty answer from a successful call instead of reading it as no drop-ins', () => {
    const r = runWithFake('empty-first');
    expect(r.showCalls).toBeGreaterThanOrEqual(2);
    expect(r.output).not.toMatch(/NOT loaded|MISSING/);
    expect(r.status).toBe(0);
  });

  it('reports a persistently failing read as NOT VERIFIED (exit 2) with systemctl’s error, never as drift', () => {
    const r = runWithFake('always-fail');
    expect(r.status).toBe(2);
    expect(r.output).toContain('Connection reset by peer');
    expect(r.output).toMatch(/UNREADABLE\s+at-spi-dbus-bus\.service\s+10-survive-bus-drop\.conf/);
    expect(r.output).not.toMatch(/NOT loaded by the unit/);
  });

  it('--list keeps the reconciler contract: an unreadable unit is UNIT-ABSENT (systemctl show failed), not MISSING', () => {
    const r = runWithFake('always-fail', ['--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^\s*MISSING\s/m);
    expect(r.stdout).toMatch(
      /^\s*UNIT-ABSENT\s+at-spi-dbus-bus\.service\s+10-survive-bus-drop\.conf\s+\(systemctl show failed\)\s*$/m,
    );
    expect(r.stdout).toMatch(/^installed=0 missing=0 unit-absent=\d+$/m);
  });

  it('does not report a drop-in MISSING when a confirmation read shows it loaded', () => {
    const r = runWithFake('drop-first');
    expect(r.showCalls).toBeGreaterThanOrEqual(2);
    expect(r.output).not.toMatch(/NOT loaded|MISSING/);
    expect(r.status).toBe(0);
  });

  it('still catches a genuinely missing drop-in (calibration: the fix did not blind the guard)', () => {
    const gate = runWithFake('drop-always');
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain(`${DROP_UNIT}  <-  ${DROP_CONF}`);

    const list = runWithFake('drop-always', ['--list']);
    expect(list.stdout).toMatch(/^\s*MISSING\s+at-spi-dbus-bus\.service\s+10-survive-bus-drop\.conf\s*$/m);
    expect(list.stdout).toMatch(/^installed=\d+ missing=1 unit-absent=0$/m);
  });

  it('catches the GNOME startup soft-limit defect even when every drop-in is loaded', () => {
    if (!existsSync('/usr/libexec/gnome-terminal-server')) return;
    const result = runWithFake('terminal-low-soft');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GNOME terminal startup LimitNOFILESoft=1024');
    expect(result.stderr).toContain('saved child limit');
    expect(result.stderr).not.toContain('NOT loaded by the unit');
  });

  // papercusp-performance-audit-2026-10-12 P-008: the serving-path PostgreSQL weights are
  // SYSTEM drop-ins (scripts/systemd/system/). They must be read from the system manager and,
  // when missing, reported with a root-owned install, never a symlink into a user's home.
  const SYSTEM_DROP = { unit: 'system-postgresql.slice', conf: '60-papercusp-serving-cpu-weight.conf' };

  it('tracks the system-scope PostgreSQL drop-ins (guards against a vacuous system pass)', () => {
    const systemDir = join(REPO_ROOT, 'apps/operator/scripts/systemd/system');
    expect(existsSync(join(systemDir, `${SYSTEM_DROP.unit}.d`, SYSTEM_DROP.conf))).toBe(true);
    const list = runWithFake('none', ['--list']);
    expect(list.stdout).toMatch(
      /^\s*INSTALLED\s+system-postgresql\.slice\s+60-papercusp-serving-cpu-weight\.conf\s*$/m,
    );
    expect(list.stdout).toMatch(/^installed=\d+ missing=0 unit-absent=0$/m);
  });

  it('catches a missing SYSTEM drop-in and prints the root install, not a user symlink', () => {
    const gate = runWithFake('drop-always', [], SYSTEM_DROP);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain(`${SYSTEM_DROP.unit}  <-  ${SYSTEM_DROP.conf}`);
    expect(gate.stderr).toContain(`/etc/systemd/system/${SYSTEM_DROP.unit}.d/${SYSTEM_DROP.conf}`);
    expect(gate.stderr).not.toContain(`~/.config/systemd/user/${SYSTEM_DROP.unit}.d`);
  });

  // WI-6554700010010449 (plan R-3, outside review thread-post:1178953): the serving path only
  // outweighs headless agent / test / bash-job work if papercusp.slice — a USER slice — is
  // weighted below app.slice. Before this, the guard collected only user *.service.d, so a
  // user slice drop-in could be committed and never installed with nothing noticing.
  const USER_SLICE_DROP = { unit: 'papercusp.slice', conf: '60-background-cpu-weight.conf' };

  it('tracks the user-scope papercusp.slice CPU weight drop-in (guards against a vacuous user-slice pass)', () => {
    const conf = join(REPO_ROOT, 'apps/operator/scripts/systemd', `${USER_SLICE_DROP.unit}.d`, USER_SLICE_DROP.conf);
    expect(existsSync(conf)).toBe(true);
    expect(readFileSync(conf, 'utf8')).toMatch(/^\[Slice\]\nCPUWeight=25$/m);
    const list = runWithFake('none', ['--list']);
    expect(list.stdout).toMatch(/^\s*INSTALLED\s+papercusp\.slice\s+60-background-cpu-weight\.conf\s*$/m);
    expect(list.stdout).toMatch(/^installed=\d+ missing=0 unit-absent=0$/m);
  });

  it('catches a missing USER slice drop-in and prints the symlink install, not a root copy', () => {
    const gate = runWithFake('drop-always', [], USER_SLICE_DROP);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain(`${USER_SLICE_DROP.unit}  <-  ${USER_SLICE_DROP.conf}`);
    expect(gate.stderr).toContain(`~/.config/systemd/user/${USER_SLICE_DROP.unit}.d/${USER_SLICE_DROP.conf}`);
    expect(gate.stderr).not.toContain(`/etc/systemd/system/${USER_SLICE_DROP.unit}.d`);
  });

  // WI-6554700010012202: the freeze fix keeps Xorg and the login session out of swap with a
  // PREFIX drop-in, system/session-.scope.d/55-no-swap.conf. The session number changes at
  // each login, so the guard must check it on whichever session-N.scope is live. Before this,
  // *.scope.d was never collected and deleting the drop-in raised nothing.
  const SESSION_PREFIX = { dir: 'session-.scope', conf: '55-no-swap.conf' };
  const LIVE_SESSION = 'session-7.scope';

  it('tracks the session-scope no-swap prefix drop-in and checks it on the live session scope', () => {
    const conf = join(REPO_ROOT, 'apps/operator/scripts/systemd/system', `${SESSION_PREFIX.dir}.d`, SESSION_PREFIX.conf);
    expect(existsSync(conf)).toBe(true);
    expect(readFileSync(conf, 'utf8')).toMatch(/^\[Scope\]\nMemoryAccounting=yes\nMemorySwapMax=0$/m);
    const list = runWithFake('none', ['--list']);
    expect(list.stdout).toMatch(/^\s*INSTALLED\s+session-7\.scope\s+55-no-swap\.conf\s*$/m);
    expect(list.stdout).toMatch(/^installed=\d+ missing=0 unit-absent=0$/m);
  });

  it('catches a live session scope that did not load it, and prints the PREFIX-dir root install', () => {
    const gate = runWithFake('drop-always', [], { unit: LIVE_SESSION, conf: SESSION_PREFIX.conf });
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain(`${LIVE_SESSION}  <-  ${SESSION_PREFIX.conf}`);
    expect(gate.stderr).toContain(`/etc/systemd/system/${SESSION_PREFIX.dir}.d/${SESSION_PREFIX.conf}`);
    expect(gate.stderr).not.toContain(`/etc/systemd/system/${LIVE_SESSION}.d`);
  });

  it('reports no live session scope as UNIT-ABSENT (a headless host), never MISSING', () => {
    const gate = runWithFake('none', [], undefined, { FAKE_LIVE_UNITS: '' });
    expect(gate.status).toBe(0);
    expect(gate.output).not.toMatch(/NOT loaded|MISSING/);
    const list = runWithFake('none', ['--list'], undefined, { FAKE_LIVE_UNITS: '' });
    expect(list.stdout).toMatch(
      /^\s*UNIT-ABSENT\s+session-\.scope\s+55-no-swap\.conf\s+\(no live session-\*\.scope in system scope\)\s*$/m,
    );
    expect(list.stdout).toMatch(/^installed=\d+ missing=0 unit-absent=1$/m);
  });

  it('reports a failed live-unit listing as NOT VERIFIED (exit 2), never as drift', () => {
    const gate = runWithFake('list-fail');
    expect(gate.status).toBe(2);
    expect(gate.output).toContain('Connection timed out');
    expect(gate.output).toMatch(/UNREADABLE\s+session-\.scope\s+55-no-swap\.conf/);
    expect(gate.output).not.toMatch(/NOT loaded by the unit/);
    const list = runWithFake('list-fail', ['--list']);
    expect(list.stdout).toMatch(/^\s*UNIT-ABSENT\s+session-\.scope\s+55-no-swap\.conf\s+\(systemctl show failed\)\s*$/m);
  });
});
