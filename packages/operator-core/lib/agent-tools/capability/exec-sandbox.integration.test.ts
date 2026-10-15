/**
 * REAL bwrap + srt exec validation for the capability-exec sandbox
 * (agent-capability-confinement-2026-06-13 P-022/D-008, WI-608).
 *
 * Unlike exec-sandbox.test.ts (argv-level, host-independent), this SPAWNS through
 * the decision the builder returns and asserts real OS containment: the command
 * runs, the cwd is writable, /tmp is an ephemeral tmpfs, existing credential paths
 * read empty, MISSING credential paths are skipped (the fail-closed bug WI-608
 * fixed), and the deny-all-egress lever drops the network namespace.
 *
 * SKIPS where bwrap cannot sandbox (`capabilityBwrapWorks() === false`: most CI,
 * any host without the AppArmor userns grant) — so it proves containment on capable
 * hosts without ever failing a fail-open host. On Ubuntu 24.04 a capable host needs
 * an AppArmor profile granting `/usr/bin/bwrap` the `userns` permission.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { srtBinOnPath } from '@papercusp/orchestrator';
import {
  buildCapabilitySandboxCommand,
  capabilityBwrapWorks,
  capabilitySrtSettingsPathForCwd,
  type BuildSandboxOpts,
} from './exec-sandbox';

const BWRAP_OK = capabilityBwrapWorks();
const SRT_BIN = srtBinOnPath();
const d = BWRAP_OK ? describe : describe.skip;

// NOT under /tmp: the bwrap argv does `--tmpfs /tmp`, which would shadow a cwd or
// fake-home placed there. /var/tmp is bound read-only from the host and only the
// specific cwd is re-bound writable, so it survives.
const ROOT = `/var/tmp/wi608-exec-sandbox-it-${process.pid}`;
const WORK = join(ROOT, 'work');
const FAKE_HOME = join(ROOT, 'home');

function run(cmd: string[], cwd: string, opts: BuildSandboxOpts, hostLock?: string) {
  const decision = buildCapabilitySandboxCommand({ cmd, cwd }, opts);
  // Mirror the real handler (bash-jobs.spawnShell): cwd is set via the spawn
  // OPTIONS, not just bwrap's `--chdir`. srt confines fs but does not chdir, so
  // it relies on the spawn cwd exactly like the operator does.
  const r = hostLock
    ? spawnSync('flock', ['-x', hostLock, decision.binary, ...decision.argv], { encoding: 'utf8', timeout: 20_000, cwd })
    : spawnSync(decision.binary, decision.argv, { encoding: 'utf8', timeout: 20_000, cwd });
  return { decision, r, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

d('exec-sandbox — REAL bwrap exec (host is bwrap-capable)', () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    mkdirSync(join(FAKE_HOME, '.ssh'), { recursive: true });
    writeFileSync(join(FAKE_HOME, '.ssh', 'id_rsa'), 'TOP_SECRET_PRIVATE_KEY');
    writeFileSync(join(FAKE_HOME, '.npmrc'), '//registry.npmjs.org/:_authToken=NPM_TOKEN_SECRET');
    // .aws / .gnupg / .config/gcloud / .papercusp intentionally ABSENT → must be skipped.
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('prepares fresh shared scheduler metadata and observes the host flock without reopening network or credentials', () => {
    const runtime = join(ROOT, 'runtime');
    const slots = join(runtime, 'pc-heavy-slots');
    expect(existsSync(slots)).toBe(false);
    const previous = process.env.PC_HEAVY_DIR;
    process.env.PC_HEAVY_DIR = slots;
    try {
      const { r, out, decision } = run(['/bin/sh', '-c',
        `echo 123 > ${slots}/preemptible.test.pid && echo METADATA_WRITABLE; ` +
        `if flock -n ${slots}/shared.lock true; then echo WRONG_PRIVATE_LOCK; else echo HOST_LOCK_HELD; fi; ` +
        `cat ${FAKE_HOME}/.ssh/id_rsa 2>/dev/null; true`], WORK, {
        enabled: true, required: true, srtBin: null, homeDir: FAKE_HOME, denyAllEgress: true,
      }, join(slots, 'shared.lock'));
      expect(r.status, out).toBe(0);
      expect(out).toContain('METADATA_WRITABLE');
      expect(out).toContain('HOST_LOCK_HELD');
      expect(out).not.toContain('WRONG_PRIVATE_LOCK');
      expect(readFileSync(join(slots, 'preemptible.test.pid'), 'utf8')).toBe('123\n');
      expect(out).not.toContain('TOP_SECRET_PRIVATE_KEY');
      expect(decision.argv).toContain('--unshare-net');
    } finally {
      if (previous === undefined) delete process.env.PC_HEAVY_DIR;
      else process.env.PC_HEAVY_DIR = previous;
    }
  });

  it('runs the command, cwd is writable, /tmp ephemeral, masks existing creds, SKIPS missing ones (no fail-close)', () => {
    const script = [
      'echo PWD=$(pwd)',
      'echo written > inside.txt && echo CWD_WRITE_OK',
      'echo TMP_ENTRIES=$(ls -A /tmp | wc -l)',
      `echo SSH_ENTRIES=$(ls -A ${FAKE_HOME}/.ssh | wc -l)`,
      `echo SSH_READ=$(cat ${FAKE_HOME}/.ssh/id_rsa 2>&1)`,
      `echo NPMRC_READ=$(cat ${FAKE_HOME}/.npmrc 2>&1)`,
      `test -e ${FAKE_HOME}/.aws && echo AWS_PRESENT || echo AWS_ABSENT`,
    ].join('; ');
    const { decision, r, out } = run(['/bin/sh', '-c', script], WORK, {
      enabled: true,
      srtBin: null, // pin the bwrap-fallback path
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(decision.mode).toBe('bwrap');
    // The whole point: a missing ~/.config/gcloud etc. must NOT abort the command.
    expect(r.status).toBe(0);
    expect(out).toContain(`PWD=${WORK}`);
    expect(out).toContain('CWD_WRITE_OK');
    expect(existsSync(join(WORK, 'inside.txt'))).toBe(true); // write reached the host cwd
    expect(out).toContain('TMP_ENTRIES=0'); // /tmp is a fresh tmpfs inside the sandbox
    expect(out).toContain('SSH_ENTRIES=0'); // ~/.ssh masked (tmpfs reads empty)
    expect(out).not.toContain('TOP_SECRET_PRIVATE_KEY'); // secret not readable
    expect(out).not.toContain('NPM_TOKEN_SECRET'); // ~/.npmrc masked via /dev/null
    expect(out).toContain('AWS_ABSENT'); // missing mask target skipped, not fatal
  });

  it('the host root is READ-ONLY (a write outside the cwd is refused)', () => {
    const { r, out } = run(['/bin/sh', '-c', 'echo x > /etc/wi608-should-fail 2>&1; echo DONE'], WORK, {
      enabled: true,
      srtBin: null,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(out).toContain('DONE');
    expect(out).toMatch(/Read-only file system|Permission denied/);
    expect(existsSync('/etc/wi608-should-fail')).toBe(false);
  });

  it('deny-all-egress drops the network namespace (only lo, no host interfaces)', () => {
    // Read interfaces from /proc/net/dev — `--proc /proc` remounts a fresh, NETNS-LOCAL
    // procfs, so it reflects the new namespace. (NOT /sys/class/net: /sys is bound
    // read-only from the host root and would show the host's interfaces even here.)
    // A fresh netns has exactly: 2 header lines + loopback = 3 lines.
    const { r, out } = run(['/bin/sh', '-c', 'echo IFACE_LINES=$(wc -l < /proc/net/dev)'], WORK, {
      enabled: true,
      srtBin: null,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
      denyAllEgress: true,
    });
    expect(r.status).toBe(0);
    expect(out).toContain('IFACE_LINES=3');
  });

  (SRT_BIN ? it : it.skip)('srt-preferred path: srt actually wraps + runs the command', () => {
    const settingsPath = capabilitySrtSettingsPathForCwd(WORK);
    const { decision, r, out } = run(['/bin/sh', '-c', 'echo SRT_RAN_IN=$(pwd)'], WORK, {
      enabled: true,
      srtBin: SRT_BIN,
      srtSettingsPath: settingsPath,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(decision.mode).toBe('srt');
    expect(r.status).toBe(0);
    expect(out).toContain(`SRT_RAN_IN=${WORK}`);
  });

  (SRT_BIN ? it : it.skip)('srt-preferred path: hides systemd-run on PATH and blocks absolute execution (WI-39391)', () => {
    const settingsPath = capabilitySrtSettingsPathForCwd(WORK);
    const { decision, r, out } = run(
      ['/bin/sh', '-c',
        'command -v systemd-run >/dev/null 2>&1 && echo PATH_SYSTEMD_RUN_VISIBLE || echo PATH_SYSTEMD_RUN_HIDDEN; ' +
        // srt denyRead does not hide stat metadata (`test -e` remains true), but it must
        // deny loading/executing the binary itself. `--version` is a no-bus probe that
        // exits 0 when the executable is actually allowed to run.
        '/usr/bin/systemd-run --version >/dev/null 2>&1 && echo ABS_SYSTEMD_RUN_EXECUTED || echo ABS_SYSTEMD_RUN_BLOCKED'],
      WORK,
      {
        enabled: true,
        srtBin: SRT_BIN,
        srtSettingsPath: settingsPath,
        homeDir: FAKE_HOME,
        bwrapBinary: '/usr/bin/bwrap',
      },
    );
    expect(decision.mode).toBe('srt');
    expect(r.status).toBe(0);
    expect(out).toContain('PATH_SYSTEMD_RUN_HIDDEN');
    expect(out).toContain('ABS_SYSTEMD_RUN_BLOCKED');
  });

  // EI-12389: srt's own default write paths only cover TMPDIR (defaults to
  // /tmp/claude), NOT the real /tmp — so anything writing to a well-known /tmp
  // path (e.g. Xvfb's /tmp/.X11-unix X11 sockets, which are hardcoded by the
  // X11 protocol and ignore TMPDIR) failed EROFS under the srt path even though
  // the bwrap-only fallback (which does `--tmpfs /tmp`) worked fine.
  // capabilitySrtSettingsPathForCwd now adds the real tmpdir() to srt's
  // allowWrite to close that gap — this asserts a write under the real /tmp
  // actually succeeds when srt-wrapped.
  (SRT_BIN ? it : it.skip)('srt-preferred path: the real /tmp is writable (EI-12389)', () => {
    const settingsPath = capabilitySrtSettingsPathForCwd(WORK);
    const probe = `wi12389-srt-tmp-probe-${process.pid}`;
    const { decision, r, out } = run(
      ['/bin/sh', '-c', `echo x > /tmp/${probe} && cat /tmp/${probe} && echo TMP_WRITE_OK`],
      WORK,
      {
        enabled: true,
        srtBin: SRT_BIN,
        srtSettingsPath: settingsPath,
        homeDir: FAKE_HOME,
        bwrapBinary: '/usr/bin/bwrap',
      },
    );
    try {
      expect(decision.mode).toBe('srt');
      expect(r.status).toBe(0);
      expect(out).toContain('TMP_WRITE_OK');
    } finally {
      rmSync(`/tmp/${probe}`, { force: true });
    }
  });
});
