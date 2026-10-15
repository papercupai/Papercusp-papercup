import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = process.env.KOPIA_HOME_SNAPSHOT_SCRIPT ?? join(homedir(), '.config/kopia/home-snapshot.sh');
const SERVICE = resolve(__dirname, '..', 'systemd', 'kopia-home-snapshot.service');
const testIfInstalled = existsSync(SCRIPT) ? it : it.skip;

describe('kopia-home-snapshot bounded execution contract', () => {
  it('keeps the unit bounded, retries lock deferrals, and installs exact-PID cleanup', () => {
    const unit = readFileSync(SERVICE, 'utf8');
    const unitSection = unit.split('[Service]')[0] ?? '';
    const serviceSection = unit.split('[Service]')[1] ?? '';

    expect(unit).toContain('MemoryAccounting=yes');
    expect(unit).toContain('MemoryHigh=8G');
    expect(unit).toContain('MemoryMax=12G');
    expect(unit).toContain('MemorySwapMax=0');
    // WI-6554700010011924: 3 privileged calls x 45 s bound + 15 s grace must fit.
    expect(unit).toContain('TimeoutStopSec=180s');
    expect(unit).toContain('ExecStopPost=%h/.config/kopia/home-snapshot.sh --cleanup');
    // WI-6554700010011790: a restart must reap leftovers before starting a new walk.
    expect(serviceSection).toContain('ExecStartPre=%h/.config/kopia/home-snapshot.sh --cleanup');
    expect(unitSection).toContain('StartLimitIntervalSec=8h');
    expect(unitSection).toContain('StartLimitBurst=8');
    expect(serviceSection).toContain('Restart=on-failure');
    expect(serviceSection).toContain('RestartSec=30min');
    expect(serviceSection).not.toContain('SuccessExitStatus=75');
    expect(serviceSection).not.toContain('RestartForceExitStatus=75');
  });

  testIfInstalled('passes bash syntax validation without starting a snapshot', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });

  it('binds no-change freshness to an atomic, source-specific verification marker', () => {
    const snapshot = readFileSync(SCRIPT, 'utf8');
    const healthcheck = readFileSync(resolve(__dirname, '..', 'systemd', 'kopia-healthcheck.sh'), 'utf8');

    expect(snapshot).toContain('VM_VERIFY_MARKER="${KOPIA_VM_VERIFY_MARKER:-$LOG_DIR/macos-vm-verified}"');
    expect(snapshot).toContain("printf 'verified_at=%s\\n' \"$(date +%s)\"");
    expect(snapshot).toContain("printf 'source=%s\\n' \"$source\"");
    expect(snapshot).toContain('write_vm_verification_marker "${VM_SRCS[0]}"');
    expect(healthcheck).toContain('vm_verification_epoch');
    expect(healthcheck).toContain('no new snapshot row was required');
    expect(healthcheck).toContain('no recent successful no-change verification was recorded');
  });

  testIfInstalled('cleanup kills a matching Kopia PID and refuses a reused/non-Kopia PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-cleanup-'));
    const stateDir = join(root, 'state');
    const procRoot = join(root, 'proc');
    const exactPid = '4242';
    const reusedPid = '4343';
    const fakeKopia = join(root, 'kopia');
    const fakeOther = join(root, 'other');
    const sudoStub = join(root, 'sudo-stub.sh');
    const killLog = join(root, 'kill.log');
    const pidFile = join(stateDir, 'home-snapshot.kopia.pid');

    try {
      mkdirSync(stateDir);
      mkdirSync(join(procRoot, exactPid), { recursive: true });
      mkdirSync(join(procRoot, reusedPid), { recursive: true });
      writeFileSync(fakeKopia, 'fixture');
      writeFileSync(fakeOther, 'fixture');
      symlinkSync(fakeKopia, join(procRoot, exactPid, 'exe'));
      symlinkSync(fakeOther, join(procRoot, reusedPid, 'exe'));
      writeFileSync(
        join(procRoot, exactPid, 'cmdline'),
        Buffer.from(`${fakeKopia}\0snapshot\0create\0--parallel=1\0`),
      );
      writeFileSync(join(procRoot, reusedPid, 'cmdline'), Buffer.from(`${fakeOther}\0sleep\0`));
      writeFileSync(
        sudoStub,
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"\n',
      );
      chmodSync(sudoStub, 0o755);

      const env = {
        ...process.env,
        KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
        KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
        KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
        KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
        KOPIA_TEST_KILL_LOG: killLog,
        // The fake process never exits, so skip the SIGTERM flush grace.
        KOPIA_HOME_SNAPSHOT_FLUSH_GRACE_SEC: '0',
      };

      writeFileSync(pidFile, `${exactPid}\n`);
      const killed = spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env });
      expect(killed.status).toBe(0);
      const killLogAfter = readFileSync(killLog, 'utf8');
      expect(killLogAfter).toContain(`-KILL ${exactPid}`);
      // SIGTERM first, so Kopia can flush (EI-25211496463956189); SIGKILL only after the grace.
      expect(killLogAfter.indexOf(`-TERM ${exactPid}`)).toBeGreaterThanOrEqual(0);
      expect(killLogAfter.indexOf(`-TERM ${exactPid}`)).toBeLessThan(killLogAfter.indexOf(`-KILL ${exactPid}`));
      expect(existsSync(pidFile)).toBe(false);

      writeFileSync(pidFile, `${reusedPid}\n`);
      const refused = spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env });
      expect(refused.status).toBe(0);
      expect(readFileSync(killLog, 'utf8')).not.toContain(`-KILL ${reusedPid}`);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds a stalled privileged SIGKILL and removes the PID marker after timeout', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-timeout-'));
    const stateDir = join(root, 'state');
    const procRoot = join(root, 'proc');
    const exactPid = '4444';
    const fakeKopia = join(root, 'kopia');
    const sudoStub = join(root, 'sudo-stub.sh');
    const killLog = join(root, 'kill.log');
    const pidFile = join(stateDir, 'home-snapshot.kopia.pid');

    try {
      mkdirSync(stateDir);
      mkdirSync(join(procRoot, exactPid), { recursive: true });
      writeFileSync(fakeKopia, 'fixture');
      symlinkSync(fakeKopia, join(procRoot, exactPid, 'exe'));
      writeFileSync(
        join(procRoot, exactPid, 'cmdline'),
        Buffer.from(fakeKopia + '\0snapshot\0create\0--parallel=1\0'),
      );
      writeFileSync(
        sudoStub,
        [
          '#!/usr/bin/env bash',
          '[ "$1" = -n ] && shift',
          '[ "$1" = -- ] && shift',
          "printf '%s\\n' \"$*\" >>\"$KOPIA_TEST_KILL_LOG\"",
          'case " $* " in',
          '  *" -KILL "*) [ "$KOPIA_TEST_HANG_ON_KILL" != 1 ] || exec sleep 5 ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(sudoStub, 0o755);
      writeFileSync(pidFile, exactPid + '\n');

      const stopped = spawnSync('bash', [resolve(__dirname, '..', 'systemd', 'kopia-home-snapshot.sh'), '--cleanup'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
          KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
          KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
          KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
          KOPIA_TEST_HANG_ON_KILL: '1',
          KOPIA_TEST_KILL_LOG: killLog,
          KOPIA_HOME_SNAPSHOT_FLUSH_GRACE_SEC: '0',
          // The bound is configurable (default 45 s, WI-6554700010011924); this case
          // pins it low to prove a hung sudo is still cut off at the bound.
          KOPIA_SUDO_SIGNAL_TIMEOUT_SEC: '1',
        },
      });

      expect(stopped.error).toBeUndefined();
      expect(stopped.status).toBe(0);
      expect(readFileSync(killLog, 'utf8')).toContain('-KILL ' + exactPid);
      expect(readFileSync(join(stateDir, 'home-snapshot.log'), 'utf8')).toContain('WARN: failed to kill exact Kopia PID ' + exactPid);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  testIfInstalled('cleanup kills a ROOT-owned Kopia child whose /proc exe link the user unit cannot read', () => {
    // WI-10002636: the Kopia child runs as root, and /proc/<pid>/exe of a root process is
    // unreadable to the user unit, so the unprivileged readlink returns nothing and the match
    // never succeeded for the child this cleanup exists to kill. The user-visible proc dir
    // below has a readable cmdline but NO exe; only the sudo path (a root-view mirror)
    // resolves the link, exactly like the real /proc.
    const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-rootview-'));
    const stateDir = join(root, 'state');
    const procRoot = join(root, 'proc');
    const rootViewProcRoot = join(root, 'proc-as-root');
    const rootPid = '5252';
    const reusedRootPid = '5353';
    const fakeKopia = join(root, 'kopia');
    const fakeOther = join(root, 'other');
    const sudoStub = join(root, 'sudo-stub.sh');
    const killLog = join(root, 'kill.log');
    const pidFile = join(stateDir, 'home-snapshot.kopia.pid');
    const killLogText = () => (existsSync(killLog) ? readFileSync(killLog, 'utf8') : '');

    try {
      mkdirSync(stateDir);
      writeFileSync(fakeKopia, 'fixture');
      writeFileSync(fakeOther, 'fixture');
      for (const [pid, target, argv] of [
        [rootPid, fakeKopia, `${fakeKopia}\0snapshot\0create\0--parallel=1\0`],
        [reusedRootPid, fakeOther, `${fakeOther}\0sleep\0`],
      ] as const) {
        mkdirSync(join(procRoot, pid), { recursive: true });
        mkdirSync(join(rootViewProcRoot, pid), { recursive: true });
        writeFileSync(join(procRoot, pid, 'cmdline'), Buffer.from(argv));
        symlinkSync(target, join(rootViewProcRoot, pid, 'exe'));
      }
      // Models `sudo -n`: strips its flags, resolves readlink against the root view of /proc,
      // and logs every other command (the kill) instead of running it.
      writeFileSync(
        sudoStub,
        [
          '#!/usr/bin/env bash',
          '[ "$1" = -n ] && shift',
          '[ "$1" = -- ] && shift',
          'if [ "$1" = readlink ]; then',
          '  shift',
          '  args=()',
          '  for a in "$@"; do args+=("${a/#"$KOPIA_TEST_PROC_ROOT"/"$KOPIA_TEST_ROOT_VIEW"}"); done',
          '  exec readlink "${args[@]}"',
          'fi',
          'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"',
          '',
        ].join('\n'),
      );
      chmodSync(sudoStub, 0o755);

      const env = {
        ...process.env,
        KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
        KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
        KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
        KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
        KOPIA_TEST_KILL_LOG: killLog,
        KOPIA_TEST_PROC_ROOT: procRoot,
        KOPIA_TEST_ROOT_VIEW: rootViewProcRoot,
        KOPIA_HOME_SNAPSHOT_FLUSH_GRACE_SEC: '0',
      };

      writeFileSync(pidFile, `${rootPid}\n`);
      expect(spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env }).status).toBe(0);
      expect(killLogText()).toContain(`-KILL ${rootPid}`);
      expect(existsSync(pidFile)).toBe(false);

      writeFileSync(pidFile, `${reusedRootPid}\n`);
      expect(spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env }).status).toBe(0);
      expect(killLogText()).not.toContain(`-KILL ${reusedRootPid}`);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-6554700010011790: the PID file names only the LAST run's Kopia, so the root
  // Kopia children of earlier failed attempts sat in the unit's cgroup un-reaped
  // (three concurrent home walks, 19h/17h/52m old). Fixtures model the real /proc and
  // a cgroup-v2 tree; the sudo stub logs signals instead of sending them.
  describe('cgroup leftover reap (WI-6554700010011790)', () => {
    // KOPIA_HOME_SNAPSHOT_SCRIPT lets a copy-out falsifiability run point these at a
    // pre-fix snapshot of the script (with its sibling kopia-cache-bootstrap.sh).
    const REPO_SCRIPT = process.env.KOPIA_HOME_SNAPSHOT_SCRIPT ?? resolve(__dirname, '..', 'systemd', 'kopia-home-snapshot.sh');
    const UNIT_CG = '/user.slice/user-1000.slice/user@1000.service/app.slice/kopia-home-snapshot.service';

    function fixture(opts: { leaf: string; graceSec: string; pathPrefix?: string }) {
      const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-cgroup-'));
      const stateDir = join(root, 'state');
      const procRoot = join(root, 'proc');
      const cgRoot = join(root, 'cgroup');
      const fakeKopia = join(root, 'kopia');
      const fakeOther = join(root, 'other');
      const sudoStub = join(root, 'sudo-stub.sh');
      const killLog = join(root, 'kill.log');
      const selfCgroup = join(root, 'self-cgroup');
      const pidFile = join(stateDir, 'home-snapshot.kopia.pid');
      mkdirSync(stateDir);
      writeFileSync(fakeKopia, 'fixture');
      writeFileSync(fakeOther, 'fixture');
      const procs: Array<[string, string, string]> = [
        ['6161', fakeKopia, `${fakeKopia}\0snapshot\0create\0--parallel=1\0/home/x\0`],
        ['6262', fakeKopia, `${fakeKopia}\0snapshot\0create\0--parallel=1\0/home/x\0`],
        ['6363', fakeKopia, `${fakeKopia}\0snapshot\0create\0--parallel=1\0/home/x\0`],
        ['6464', fakeOther, `${fakeOther}\0sleep\0`],
      ];
      for (const [pid, target, argv] of procs) {
        mkdirSync(join(procRoot, pid), { recursive: true });
        symlinkSync(target, join(procRoot, pid, 'exe'));
        writeFileSync(join(procRoot, pid, 'cmdline'), Buffer.from(argv));
      }
      const cgDir = join(cgRoot, ...UNIT_CG.split('/').filter(Boolean).slice(0, -1), opts.leaf);
      mkdirSync(cgDir, { recursive: true });
      writeFileSync(join(cgDir, 'cgroup.procs'), '6161\n6262\n6363\n6464\n');
      writeFileSync(selfCgroup, `0::${UNIT_CG.split('/').slice(0, -1).join('/')}/${opts.leaf}\n`);
      writeFileSync(
        sudoStub,
        ['#!/usr/bin/env bash', '[ "$1" = -n ] && shift', '[ "$1" = -- ] && shift', 'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"', ''].join('\n'),
      );
      chmodSync(sudoStub, 0o755);
      writeFileSync(pidFile, '6161\n');
      const env = {
        ...process.env,
        ...(opts.pathPrefix ? { PATH: `${opts.pathPrefix}:${process.env.PATH ?? ''}` } : {}),
        KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
        KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
        KOPIA_HOME_SNAPSHOT_CGROUP_ROOT: cgRoot,
        KOPIA_HOME_SNAPSHOT_SELF_CGROUP: selfCgroup,
        KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
        KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
        KOPIA_TEST_KILL_LOG: killLog,
        KOPIA_HOME_SNAPSHOT_FLUSH_GRACE_SEC: opts.graceSec,
      };
      const killLogText = () => (existsSync(killLog) ? readFileSync(killLog, 'utf8') : '');
      return { root, env, killLogText, pidFile, stateDir };
    }

    it('reaps every validated Kopia in its own unit cgroup, not only the PID-file one', () => {
      const f = fixture({ leaf: 'kopia-home-snapshot.service', graceSec: '0' });
      try {
        const run = spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 15_000 });
        expect(run.status).toBe(0);
        const log = f.killLogText();
        for (const pid of ['6161', '6262', '6363']) {
          expect(log).toContain(`-TERM ${pid}`);
          expect(log).toContain(`-KILL ${pid}`);
        }
        // A cgroup member that is not a Kopia snapshot is never signalled (the stub
        // also logs its sudo readlink validation, so match the signal lines only).
        expect(log).not.toMatch(/-(TERM|KILL) 6464\b/);
        // The PID-file pid is not signalled twice by the cgroup scan.
        expect(log.split('\n').filter((l) => l.endsWith('-TERM 6161'))).toHaveLength(1);
        const snapLog = readFileSync(join(f.stateDir, 'home-snapshot.log'), 'utf8');
        expect(snapLog).toContain("leftover Kopia PID 6262 found in this unit's cgroup");
        expect(existsSync(f.pidFile)).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('never reaps cgroup members when --cleanup runs outside the unit (e.g. a terminal scope)', () => {
      const f = fixture({ leaf: 'vte-spawn-0000.scope', graceSec: '0' });
      try {
        expect(spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 15_000 }).status).toBe(0);
        const log = f.killLogText();
        expect(log).toContain('-KILL 6161');
        expect(log).not.toMatch(/-(TERM|KILL) 6262\b/);
        expect(log).not.toMatch(/-(TERM|KILL) 6363\b/);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    // WI-6554700010011924: under memory+IO pressure one sudo was measured stalling
    // >=37 s, so every sudo the cleanup forks is a liability. These pin the three
    // ways the old cleanup spent them.
    it('validates cgroup members without sudo when their exe link is readable', () => {
      // 6464 is a user-readable non-Kopia member (the cleanup's own helpers look like
      // this). The old validator escalated every exe mismatch to `sudo readlink`.
      const f = fixture({ leaf: 'kopia-home-snapshot.service', graceSec: '0' });
      try {
        expect(spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 15_000 }).status).toBe(0);
        const log = f.killLogText();
        expect(log).toContain('-KILL 6161');
        expect(log.split('\n').filter((l) => l.includes('readlink'))).toEqual([]);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('delivers SIGTERM and SIGKILL through a sudo that stalls for seconds (default bound)', () => {
      // The stub sleeps BEFORE acting, like the measured sudo that spent >=37 s before
      // it logged. With the old 1 s bound neither signal was ever delivered.
      const f = fixture({ leaf: 'kopia-home-snapshot.service', graceSec: '0' });
      try {
        writeFileSync(
          f.env.KOPIA_HOME_SNAPSHOT_SUDO,
          [
            '#!/usr/bin/env bash',
            '[ "$1" = -n ] && shift',
            '[ "$1" = -- ] && shift',
            '/bin/sleep 2',
            'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"',
            '',
          ].join('\n'),
        );
        const run = spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 30_000 });
        expect(run.status).toBe(0);
        const log = f.killLogText();
        for (const pid of ['6161', '6262', '6363']) {
          expect(log).toContain(`-TERM ${pid}`);
          expect(log).toContain(`-KILL ${pid}`);
        }
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('re-checks identity after the grace from /proc/<pid>/stat: no SIGKILL for a recycled PID or a zombie', () => {
      // On SIGTERM the stub rewrites 6262's starttime (the PID was reused) and marks
      // 6363 a zombie; 6161 is untouched and still running. Only 6161 may be killed.
      const f = fixture({ leaf: 'kopia-home-snapshot.service', graceSec: '0' });
      const procRoot = f.env.KOPIA_HOME_SNAPSHOT_PROC_ROOT;
      const stat = (pid: string, state: string, start: string) =>
        `${pid} (kopia) ${state} 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 100\n`;
      try {
        for (const pid of ['6161', '6262', '6363', '6464']) writeFileSync(join(procRoot, pid, 'stat'), stat(pid, 'S', '777'));
        writeFileSync(
          f.env.KOPIA_HOME_SNAPSHOT_SUDO,
          [
            '#!/usr/bin/env bash',
            '[ "$1" = -n ] && shift',
            '[ "$1" = -- ] && shift',
            'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"',
            'case " $* " in',
            `  *" -TERM 6262 "*) printf '%s\\n' ${JSON.stringify(stat('6262', 'S', '999').trim())} >${JSON.stringify(join(procRoot, '6262', 'stat'))} ;;`,
            `  *" -TERM 6363 "*) printf '%s\\n' ${JSON.stringify(stat('6363', 'Z', '777').trim())} >${JSON.stringify(join(procRoot, '6363', 'stat'))} ;;`,
            'esac',
            '',
          ].join('\n'),
        );
        expect(spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 15_000 }).status).toBe(0);
        const log = f.killLogText();
        expect(log).toContain('-TERM 6262');
        expect(log).toContain('-TERM 6363');
        expect(log).toContain('-KILL 6161');
        expect(log).not.toMatch(/-KILL 6262\b/);
        expect(log).not.toMatch(/-KILL 6363\b/);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });

    it('stops leftovers in parallel under one wall-clock grace, even when each forked sleep overruns', () => {
      // A `sleep` that takes 1 s per 0.2 s tick models fork latency at host load ~280
      // (2026-10-13 23:42 EDT: 'stop-post' timed out after 30 s). Three never-exiting
      // fakes with a 2 s grace: counted ticks in sequence take ~3 x 10 s; one shared
      // wall-clock grace takes ~2-3 s.
      const binDir = mkdtempSync(join(tmpdir(), 'kopia-slow-sleep-'));
      const slowSleep = join(binDir, 'sleep');
      writeFileSync(slowSleep, '#!/usr/bin/env bash\nexec /usr/bin/env -i /bin/sleep 1\n');
      chmodSync(slowSleep, 0o755);
      const f = fixture({ leaf: 'kopia-home-snapshot.service', graceSec: '2', pathPrefix: binDir });
      try {
        const started = Date.now();
        const run = spawnSync('bash', [REPO_SCRIPT, '--cleanup'], { encoding: 'utf8', env: f.env, timeout: 40_000 });
        const elapsedMs = Date.now() - started;
        expect(run.status).toBe(0);
        expect(f.killLogText()).toContain('-KILL 6363');
        expect(elapsedMs).toBeLessThan(9_000);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      }
    });
  });
});
