/**
 * Regression coverage for sync-staging-checkout.sh's WI-5710 restart gates.
 *
 * THE BUG: the script gated its `systemctl restart papercusp-staging-api` on
 * `target != current` alone — i.e. it used "the `staging` branch moved" as a
 * proxy for "the code the running :3170 process holds changed". Under a fleet
 * where git-sync auto-commits the whole tree every ~3min, that proxy decoupled
 * from the thing it proxied: :3170 restarted every ~6min forever (measured
 * 2026-07-26: restarts at 15:38 / 15:44 / 15:50 / 15:56 / 16:02 / 16:08, 42
 * Started|Stopping journal entries in 90min), each a ~10-13s hard-down window
 * that drops every live SSE/sync session.
 *
 * TWO gates now stand between "the branch moved" and "kill the process":
 *
 *  1. paths_require_restart() — relevance. The SPA needs no restart at all
 *     (host-spa.ts serves dist FROM DISK PER REQUEST), so an SPA/docs/tests-only
 *     advance rebuilds and skips the restart entirely.
 *  2. current_commit_age_sec() + staging_live_client_count() — deferral. A
 *     restart that IS required waits while someone is actually connected to
 *     :3170, bounded by a staleness ceiling so it can never freeze forever.
 *
 * The FAIL-SAFE DIRECTION of gate 1 is the load-bearing property and the thing
 * most likely to be silently inverted by a future edit: a restart is required
 * UNLESS *every* changed path is provably inert. An unknown/new path shape must
 * fall through to a restart. The inverse ("skip unless known-server") would mean
 * a newly-added server directory silently stops being picked up — a far worse
 * failure than one extra restart. Several tests below exist only to pin that
 * direction.
 *
 * Same isolation pattern as the sibling setup-release-checkout-deps.test.ts: we
 * sed-extract ONLY the named function out of the REAL script (so these track the
 * shipped logic, never a copy) and drive it under controlled inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

// apps/operator/lib/release → apps/operator/bin/release/sync-staging-checkout.sh
// Overridable so scripts/mutation-probe.sh can point this suite at a copy or a
// historical snapshot without mutating the shared tree.
const SCRIPT_PATH = process.env.SYNC_STAGING_SCRIPT_UNDER_TEST
  ?? join(__dirname, '../../bin/release/sync-staging-checkout.sh');

function runScriptArgs(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], {
    env: { ...process.env, STAGING_TRASH_DRAIN_MODE: 'inline', ...(opts.env ?? {}) },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Extract one function (plus any it depends on) from the live script and run it. */
function runFn(
  fns: string[],
  call: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const sourced = fns
    .map((f) => `source <(sed -n "/^${f}()/,/^}/p" "$SYNC_SCRIPT")`)
    .join('\n');
  const wrapper = ['set -uo pipefail', sourced, call].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    // Fixtures reclaim retired generations synchronously unless a test opts
    // into the detached drain with its own systemd-run shim; a fixture must
    // never launch a real transient unit (WI-6554700010029246).
    env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH, STAGING_TRASH_DRAIN_MODE: 'inline', ...(opts.env ?? {}) },
    input: opts.input,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** cleanup_staging_candidate plus the O(1) retire/drain helpers it calls (WI-6554700010029246). */
const CLEANUP_FNS = ['retire_staging_generation_home', 'prune_staging_worktree_registrations',
  'launch_staging_trash_drain', 'cleanup_staging_candidate'];

/**
 * Run the real paths_require_restart() over `paths`.
 * Returns true when a process restart IS required (the script's exit-0 contract).
 */
function requiresRestart(paths: string[]): boolean {
  const r = runFn(['path_needs_no_restart', 'paths_require_restart'], 'paths_require_restart', {
    input: paths.join('\n') + (paths.length ? '\n' : ''),
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`paths_require_restart exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function restartControlEndpoint(
  healthyOrigin: string | string[], configuredOrigin = '',
  compatibleOrigin = typeof healthyOrigin === 'string' ? healthyOrigin : healthyOrigin[0],
) {
  const binDir = mkdtempSync(join(tmpdir(), 'staging-control-endpoint-'));
  const probeLog = join(binDir, 'probes');
  const preflightLog = join(binDir, 'preflights');
  writeFileSync(join(binDir, 'curl'), [
    '#!/usr/bin/env bash',
    'probe="${!#}"',
    'printf "%s\\n" "$probe" >> "$TEST_CONTROL_PROBE_LOG"',
    '[[ "$TEST_HEALTHY_CONTROL_ORIGINS" == *"|${probe%/api/health}|"* ]]',
  ].join('\n'), { mode: 0o700 });
  writeFileSync(join(binDir, 'ptool'), [
    '#!/usr/bin/env bash',
    'for arg in "$@"; do case "$arg" in --url=*) origin="${arg#--url=}" ;; esac; done',
    'payload="$(cat)"',
    'printf "%s|%s|%s\\n" "$origin" "$PAPERCUSP_SID" "$payload" >> "$TEST_CONTROL_PREFLIGHT_LOG"',
    "[[ \"$payload\" == '{\"target\":\"staging\",\"confirm\":false}' ]] || exit 3",
    '[[ "$PAPERCUSP_SID" == test-client ]] || exit 4',
    'if [[ "$origin" == "$TEST_COMPATIBLE_CONTROL_ORIGIN" ]]; then',
    "  printf '%s\\n' '{\"ok\":true,\"dry_run\":true,\"target\":\"staging\"}'",
    'else',
    "  printf '%s\\n' '{\"ok\":false,\"error\":\"unsupported-or-unauthorized\"}'",
    'fi',
  ].join('\n'), { mode: 0o700 });
  try {
    const result = runFn(['resolve_staging_restart_control_url'], 'resolve_staging_restart_control_url', {
      env: {
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        STAGING_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: configuredOrigin,
        PTOOL_BIN: join(binDir, 'ptool'),
        PTOOL_CLIENT_SID: 'test-client',
        TEST_HEALTHY_CONTROL_ORIGINS: '|' + [healthyOrigin].flat().join('|') + '|',
        TEST_COMPATIBLE_CONTROL_ORIGIN: compatibleOrigin ?? '',
        TEST_CONTROL_PROBE_LOG: probeLog,
        TEST_CONTROL_PREFLIGHT_LOG: preflightLog,
      },
    });
    const probes = existsSync(probeLog) ? readFileSync(probeLog, 'utf8').trim().split('\n') : [];
    const preflights = existsSync(preflightLog) ? readFileSync(preflightLog, 'utf8').trim().split('\n') : [];
    return { ...result, probes, preflights };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('staging restart control endpoint recovery', () => {
  it('uses healthy staging without probing another operator', () => {
    const result = restartControlEndpoint('http://127.0.0.1:3170', 'http://localhost:3271');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://127.0.0.1:3170');
    expect(result.probes).toEqual(['http://127.0.0.1:3170/api/health']);
    expect(result.preflights).toEqual([
      'http://127.0.0.1:3170|test-client|{"target":"staging","confirm":false}',
    ]);
  });

  it('recovers through the configured local operator when staging has no listener', () => {
    const result = restartControlEndpoint('http://localhost:3271', 'http://localhost:3271/');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://localhost:3271');
    expect(result.probes).toEqual([
      'http://127.0.0.1:3170/api/health', 'http://localhost:3271/api/health',
    ]);
  });

  it('uses the local release operator when staging and the configured operator are unavailable', () => {
    const result = restartControlEndpoint('http://127.0.0.1:3070', 'http://localhost:3271');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://127.0.0.1:3070');
    expect(result.probes).toEqual([
      'http://127.0.0.1:3170/api/health', 'http://localhost:3271/api/health',
      'http://127.0.0.1:3271/api/health',
      'http://127.0.0.1:3070/api/health',
    ]);
  });

  it('refuses before dispatch when neither local control endpoint is healthy', () => {
    const result = restartControlEndpoint('', 'http://127.0.0.1:3170');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no compatible local operator');
    expect(result.probes).toEqual([
      'http://127.0.0.1:3170/api/health', 'http://127.0.0.1:3271/api/health',
      'http://127.0.0.1:3070/api/health',
    ]);
    expect(result.preflights).toEqual([]);
  });

  it('uses the registered background operator when staging is unavailable', () => {
    const result = restartControlEndpoint('http://127.0.0.1:3271');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://127.0.0.1:3271');
  });

  it('skips an HTTP-healthy operator whose same-identity preview is refused', () => {
    const result = restartControlEndpoint(
      ['http://localhost:3281', 'http://127.0.0.1:3271'],
      'http://localhost:3281', 'http://127.0.0.1:3271',
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://127.0.0.1:3271');
    expect(result.preflights).toEqual([
      'http://localhost:3281|test-client|{"target":"staging","confirm":false}',
      'http://127.0.0.1:3271|test-client|{"target":"staging","confirm":false}',
    ]);
  });

  it('refuses when HTTP health has no compatible authenticated control preview', () => {
    const result = restartControlEndpoint('http://127.0.0.1:3070', '', '');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no compatible local operator');
  });

  it.each(['https://example.test:443', 'http://127.0.0.1:3271/not-an-origin'])(
    'does not send recovery to an unadmitted configured endpoint %s', (configuredOrigin) => {
      const result = restartControlEndpoint('http://127.0.0.1:3070', configuredOrigin);
      expect(result.status).toBe(0);
      expect(result.probes).toEqual([
        'http://127.0.0.1:3170/api/health', 'http://127.0.0.1:3271/api/health',
        'http://127.0.0.1:3070/api/health',
      ]);
    },
  );
});

function execForcesLoopback(execStart: string): boolean {
  const r = runFn(
    ['staging_exec_forces_loopback'],
    'staging_exec_forces_loopback "$EXEC_START"',
    { env: { EXEC_START: execStart } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`staging_exec_forces_loopback exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function execPreUsesBundle(execPre: string, expectedWorkdir = '/isolated/apps/operator'): boolean {
  const r = runFn(
    ['staging_exec_pre_uses_bundle'],
    'staging_exec_pre_uses_bundle "$EXEC_PRE" "$EXPECTED_WORKDIR"',
    { env: { EXEC_PRE: execPre, EXPECTED_WORKDIR: expectedWorkdir } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`staging_exec_pre_uses_bundle exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function execPinsIntegrationRoot(execStart: string): boolean {
  const r = runFn(
    ['staging_exec_pins_integration_root'],
    'staging_exec_pins_integration_root "$EXEC_START"',
    { env: { EXEC_START: execStart } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`staging_exec_pins_integration_root exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function stagingUnitGuardResult(
  root: string,
  overrides: {
    workingDirectory?: string;
    environment?: string;
    execPre?: string;
    execStart?: string;
  } = {},
): { status: number | null; stdout: string; stderr: string } {
  const binDir = mkdtempSync(join(tmpdir(), 'staging-unit-guard-'));
  const systemctlPath = join(binDir, 'systemctl');
  const spaDist = root + '/apps/operator-vite/dist';
  const workingDirectory = overrides.workingDirectory ?? root + '/apps/operator';
  const environment = overrides.environment ?? [
    'PAPERCUSP_INTEGRATION_ROOT=' + root,
    'PAPERCUSP_SPA_DIST=' + spaDist,
    'PAPERCUSP_BUNDLE_REUSE_FRESH=1',
  ].join(' ');
  const execPre = overrides.execPre ?? (
    '{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -s /tmp/papercup-staging-sync.lock ' +
    root + '/apps/operator/bin/bundle-host.sh ; ignore_errors=no ; status=0/0 }'
  );
  const execStart = overrides.execStart ?? (
    'set -a; [ -f .env.local ] && . ./.env.local; set +a; ' +
    'export PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)" ' +
    'PAPERCUSP_HONO_PORT=3170 PAPERCUSP_PTY_WS_PORT=3156 ' +
    'MOBILE_VOICE_WS_PORT=3168 PAPERCUSP_BIND_HOST=127.0.0.1; ' +
    'exec node dist-host/hono-host.mjs'
  );
  writeFileSync(systemctlPath, [
    '#!/usr/bin/env bash',
    'case "$4" in',
    '  WorkingDirectory) printf "%s\\n" "$TEST_WORKING_DIRECTORY" ;;',
    '  Environment) printf "%s\\n" "$TEST_ENVIRONMENT" ;;',
    '  ExecStartPre) printf "%s\\n" "$TEST_EXEC_START_PRE" ;;',
    '  ExecStart) printf "%s\\n" "$TEST_EXEC_START" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'), { mode: 0o700 });
  try {
    return runFn(
      ['staging_exec_pre_uses_bundle', 'staging_exec_pins_integration_root', 'assert_staging_unit_checkout'],
      'log() { printf "%s\\n" "$*" >&2; }; assert_staging_unit_checkout',
      {
        env: {
          PATH: binDir + ':' + (process.env.PATH ?? ''),
          UNIT: 'papercup-staging-api.service',
          STAGING_ROOT: root,
          TEST_WORKING_DIRECTORY: workingDirectory,
          TEST_ENVIRONMENT: environment,
          TEST_EXEC_START_PRE: execPre,
          TEST_EXEC_START: execStart,
        },
      },
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('recent restart coalescing verifies the published generation', () => {
  function runRecentGuard(ageSec: number, healthSha: string) {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('RECENT_RESTART_GRACE_SEC=');
    const end = script.indexOf('# EI-22102474093310851:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const wrapper = [
      'set -euo pipefail',
      'source <(sed -n "/^health_sha_matches_target()/,/^}/p" "$SYNC_SCRIPT")',
      'systemctl() { printf "2059726\\n"; }',
      'ps() { printf "%s\\n" "$TEST_AGE_SEC"; }',
      'staging_health_source_sha() { printf "%s\\n" "$TEST_HEALTH_SHA"; }',
      'log() { printf "%s\\n" "$*"; }',
      'UNIT=fixture-staging.service',
      'target="$TEST_TARGET_SHA"',
      script.slice(start, end),
      'printf "RESTART_REQUIRED\\n"',
    ].join('\n');
    return spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH, TEST_AGE_SEC: String(ageSec),
        TEST_HEALTH_SHA: healthSha, TEST_TARGET_SHA: 'a'.repeat(40),
        PAPERCUSP_STAGING_SYNC_RESTART_GRACE_SEC: '45' },
    });
  }

  it('coalesces a young process that reports the exact target', () => {
    const result = runRecentGuard(36, 'a'.repeat(10));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('peer restart verified');
    expect(result.stdout).not.toContain('RESTART_REQUIRED');
  });

  it.each(['b'.repeat(10), ''])('requires restart for a young old or unknown generation: %s', healthSha => {
    const result = runRecentGuard(36, healthSha);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RESTART_REQUIRED');
    expect(result.stdout).not.toContain('peer restart verified');
  });

  it('preserves the grace boundary even for a matching generation', () => {
    const result = runRecentGuard(45, 'a'.repeat(10));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RESTART_REQUIRED');
  });
});

function healthMatchesTarget(healthSha: string, targetSha: string): boolean {
  const r = runFn(
    ['health_sha_matches_target'],
    'health_sha_matches_target "$HEALTH_SHA" "$TARGET_SHA"',
    { env: { HEALTH_SHA: healthSha, TARGET_SHA: targetSha } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`health_sha_matches_target exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function restartIsObserved(beforePid: string, currentPid: string, healthSha: string, targetSha: string): boolean {
  const r = runFn(
    ['health_sha_matches_target', 'staging_restart_is_observed'],
    'staging_restart_is_observed "$BEFORE_PID" "$CURRENT_PID" "$HEALTH_SHA" "$TARGET_SHA"',
    {
      env: {
        BEFORE_PID: beforePid,
        CURRENT_PID: currentPid,
        HEALTH_SHA: healthSha,
        TARGET_SHA: targetSha,
      },
    },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`staging_restart_is_observed exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

function isPreDispatchRestartRefusal(result: string): boolean {
  const r = runFn(
    ['restart_result_is_pre_dispatch_refusal'],
    'restart_result_is_pre_dispatch_refusal "$RESULT"',
    { env: { RESULT: result } },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`restart_result_is_pre_dispatch_refusal exited unexpectedly (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.status === 0;
}

describe('sync-staging-checkout.sh argument parsing', () => {
  it('prints help and exits before touching the live sync workflow', () => {
    const r = runScriptArgs(['--help'], {
      // If argument parsing regresses and falls through, this invalid root makes
      // the live path fail instead of accidentally operating on this checkout.
      env: { PAPERCUSP_INTEGRATION_ROOT: '/definitely/not-a-live-checkout' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: sync-staging-checkout.sh');
    expect(r.stdout).toContain('--help');
    expect(r.stdout).not.toContain('[staging-sync]');
    expect(r.stderr).toBe('');
  });

  it('rejects unknown arguments without entering the live sync workflow', () => {
    const r = runScriptArgs(['--not-an-option'], {
      env: { PAPERCUSP_INTEGRATION_ROOT: '/definitely/not-a-live-checkout' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument: --not-an-option');
    expect(r.stderr).toContain('Usage: sync-staging-checkout.sh');
    expect(r.stdout).toBe('');
  });

  it('rejects extra cleanup-only arguments before touching the live sync workflow', () => {
    const r = runScriptArgs(['--cleanup-only', '--not-an-option'], {
      env: { PAPERCUSP_INTEGRATION_ROOT: '/definitely/not-a-live-checkout' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--cleanup-only does not accept additional arguments');
    expect(r.stdout).toBe('');
  });
});

describe('sync-staging-checkout.sh migration restart preflight (EI-24180437038891110)', () => {
  it.each(['scripts/lint-migrations.mjs', 'scripts/check-migration-forward-compat.mjs'])(
    'kills a stuck %s and refuses publication after the phase deadline', (stuckCheck) => {
      const root = mkdtempSync(join(tmpdir(), 'staging-preflight-deadline-'));
      try {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        const trace = join(root, 'checks');
        const pidFile = join(root, 'stuck.pid');
        writeFileSync(join(bin, 'node'), [
          '#!/bin/sh',
          'printf "%s\\n" "$1" >> "$TRACE_FILE"',
          '[ "$1" = "$STUCK_CHECK" ] || exit 0',
          'printf "%s" "$$" > "$PID_FILE"',
          'trap "" TERM',
          'while :; do sleep 1; done',
          '',
        ].join('\n'), { mode: 0o700 });
        const result = runFn(['preflight_staging_migrations'], [
          'log() { printf "%s\\n" "$*"; }',
          // Shorten only the fixture clock; real GNU timeout owns cancellation.
          'timeout() { printf "BOUND:%s\\n" "$*"; shift 2; command timeout --kill-after=1s 1s "$@"; }',
          'preflight_staging_migrations && printf "PUBLISHED\\n"',
        ].join('\n'), { env: {
          STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: trace,
          PID_FILE: pidFile, STUCK_CHECK: stuckCheck, PATH: `${bin}:${process.env.PATH}`,
        } });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain(`BOUND:--kill-after=10s 900s node ${stuckCheck}`);
        expect(result.stdout).toContain(`${stuckCheck} failed or exceeded its deadline (exit 137)`);
        expect(result.stdout).toContain('keeping the current fixture.service process');
        expect(result.stdout).not.toContain('PUBLISHED');
        expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(
          stuckCheck.endsWith('/lint-migrations.mjs') ? [stuckCheck]
            : ['scripts/lint-migrations.mjs', stuckCheck],
        );
        const childPid = readFileSync(pidFile, 'utf8');
        let childState = 'gone';
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
          childState = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // SIGKILL can leave a dead child awaiting its ancestor's reap. A /proc
        // entry alone does not mean the timed-out check can still execute.
        process.stdout.write(`[staging-preflight] child ${childPid} termination state=${childState}\n`);
        expect(['gone', 'Z', 'X'], `surviving check ${childPid}: ${childState}`).toContain(childState);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, 15_000,
  );

  it.each([false, true])('loads the candidate runtime DB before reservation lint (broken env: %s)', (broken) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-lint-env-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      mkdirSync(join(root, 'apps/operator'), { recursive: true });
      writeFileSync(join(root, 'apps/operator/.env.local'), broken ? 'return 1\n' : 'DATABASE_URL=candidate-db\n');
      const trace = join(root, 'lint-trace');
      writeFileSync(join(bin, 'node'), [
        '#!/bin/sh',
        'printf "%s:%s\\n" "$1" "$DATABASE_URL" >> "$TRACE_FILE"',
        '[ "$DATABASE_URL" = candidate-db ]',
        '',
      ].join('\n'), { mode: 0o700 });
      const r = runFn(['preflight_staging_migrations'],
        'log() { printf "%s\\n" "$*"; }\npreflight_staging_migrations', {
          env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: trace,
            DATABASE_URL: 'inherited-discovery-db', PATH: `${bin}:${process.env.PATH}` },
        });
      expect(r.status).toBe(broken ? 1 : 0);
      if (broken) expect(existsSync(trace)).toBe(false);
      else expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
        'scripts/lint-migrations.mjs:candidate-db',
        'scripts/check-migration-forward-compat.mjs:candidate-db',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['scripts/lint-migrations.mjs', ['scripts/lint-migrations.mjs']],
    ['scripts/check-migration-forward-compat.mjs', [
      'scripts/lint-migrations.mjs', 'scripts/check-migration-forward-compat.mjs',
    ]],
  ])('refuses the restart when %s fails in the target checkout', (failedLint, expectedRuns) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-migration-preflight-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const trace = join(root, 'lint-trace');
      writeFileSync(join(bin, 'node'), [
        '#!/bin/sh',
        'printf "%s\\n" "$1" >> "$TRACE_FILE"',
        '[ "$1" != "$FAILED_LINT" ]',
        '',
      ].join('\n'), { mode: 0o700 });
      const r = runFn(['preflight_staging_migrations'],
        'log() { printf "%s\\n" "$*"; }\npreflight_staging_migrations', {
        env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: trace,
          FAILED_LINT: failedLint, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(r.status).toBe(1);
      expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(expectedRuns);
      expect(r.stdout).toContain('keeping the current fixture.service process');

      const script = readFileSync(SCRIPT_PATH, 'utf8');
      const preflightCall = script.indexOf('preflight_staging_migrations "$SYNC_ROOT"');
      expect(preflightCall).toBeGreaterThan(script.indexOf('if [ "$restart_required" = 1 ]; then'));
      expect(preflightCall).toBeLessThan(script.indexOf('prebuilding proof-bound host bundle'));
      expect(preflightCall).toBeLessThan(script.indexOf('requesting coordinated restart of $UNIT'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync-staging-checkout.sh forward-compat review-date alarm (WI-10003599)', () => {
  it('checks review dates before checkout equality can take the no-op path', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const lockIdx = script.indexOf('staging_sync_lock_start');
    const warningCallIdx = script.indexOf('\nforward_compat_review_warnings\n');
    const targetIdx = script.indexOf('target="$(git -C');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(warningCallIdx).toBeGreaterThan(lockIdx);
    expect(warningCallIdx).toBeLessThan(targetIdx);
    expect(script).toContain('--warn-review-by-days=$warning_days');
    expect(script).toContain('--sidecar-directory=$STAGING_ROOT/libs/papercusp/libs/db/sql');
  });

  /**
   * Run forward_compat_review_warnings twice (two timer ticks) against a fake
   * `node` that prints REVIEW_REPORT for the checker and records every
   * mcp-call as `<tool>\t<json>`. FAIL_TOOL makes that one tool exit 5, the
   * way mcp-call.mjs exits non-zero on a tool-level ok:false.
   */
  function runReviewAlarm(report: string, opts: { failTool?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'staging-review-alarm-'));
    try {
      const bin = join(root, 'bin');
      const integration = join(root, 'integration');
      const staging = join(root, 'staging');
      mkdirSync(bin);
      mkdirSync(join(integration, 'scripts'), { recursive: true });
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(integration, 'scripts/mcp-call.mjs'), 'fixture');
      const alarmTrace = join(root, 'alarm-trace');
      writeFileSync(join(bin, 'node'), [
        '#!/bin/sh',
        'if [ "$1" = "scripts/check-migration-forward-compat.mjs" ]; then',
        '  printf "%s\\n" "$REVIEW_REPORT"',
        '  exit 0',
        'fi',
        'if [ "$1" = "scripts/mcp-call.mjs" ]; then',
        '  printf "%s\\t%s\\n" "$2" "$3" >> "$ALARM_TRACE"',
        '  case " $FAIL_TOOL " in *" $2 "*) exit 5 ;; esac',
        '  exit 0',
        'fi',
        'exec "$REAL_NODE" "$@"',
        '',
      ].join('\n'), { mode: 0o700 });

      const r = runFn(['forward_compat_review_warnings'],
        'log() { printf "%s\\n" "$*"; }\nforward_compat_review_warnings\nforward_compat_review_warnings', {
          env: {
            INTEGRATION_ROOT: integration,
            STAGING_ROOT: staging,
            XDG_STATE_HOME: join(root, 'state'),
            REVIEW_REPORT: report,
            ALARM_TRACE: alarmTrace,
            FAIL_TOOL: opts.failTool ?? '',
            REAL_NODE: process.execPath,
            PATH: `${bin}:${process.env.PATH}`,
          },
        });
      const calls = readFileSync(alarmTrace, 'utf8').trim().split('\n').map((line) => {
        const tab = line.indexOf('\t');
        return { tool: line.slice(0, tab), payload: JSON.parse(line.slice(tab + 1)) };
      });
      return { r, calls };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const withinReport = 'check-migration-forward-compat: WARNING: 941-example.sql.forward-compat.json reviewBy 2026-10-28 is within 14 days; renew or remove the sidecar before expiry.';
  const passedReport = 'check-migration-forward-compat: WARNING: 941-example.sql.forward-compat.json reviewBy 2026-10-28 has passed; renew or remove the sidecar.';

  it('files ONE claimable work-item for a stable warning set instead of an unowned broadcast (WI-10005182)', () => {
    const { r, calls } = runReviewAlarm(withinReport);
    expect(r.status).toBe(0);
    // Two timer ticks, one filing: the state file de-duplicates the second tick.
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('work_items:create');
    expect(calls[0].payload.kind).toBe('task');
    expect(calls[0].payload.title).toContain('941-example reviewBy 2026-10-28');
    expect(calls[0].payload.body).toContain(withinReport);
    expect(calls[0].payload.body).toMatch(/requiresDeployedCommit/);
    expect(r.stdout).toContain('ALARM: migration forward-compat sidecar review dates need attention');
    expect(r.stdout).toContain('ALARM: filed a sidecar-renewal work-item');
  });

  it('names the same work for the "within N days" and "has passed" phrasings of one expiry', () => {
    const before = runReviewAlarm(withinReport).calls[0].payload.title;
    const after = runReviewAlarm(passedReport).calls[0].payload.title;
    expect(after).toBe(before);
  });

  it('falls back to the workspace broadcast when the work-item cannot be filed, and still sends only once', () => {
    const { r, calls } = runReviewAlarm(withinReport, { failTool: 'work_items:create' });
    expect(r.status).toBe(0);
    expect(calls.map((c) => c.tool)).toEqual(['work_items:create', 'coord:send']);
    const broadcast = calls[1].payload;
    expect(broadcast.to).toEqual(['*']);
    expect(broadcast.expects).toBe('none');
    expect(broadcast.summary).toMatch(/migration forward-compat reviews need attention/);
    expect(broadcast.body[0].text).toMatch(/renew or remove each sidecar/i);
    expect(r.stdout).toContain('falling back to a workspace broadcast');
    expect(r.stdout).not.toContain('ALARM DELIVERY FAILED');
  });

  it('never reaches the broadcast when the work-item is filed', () => {
    const { calls } = runReviewAlarm(withinReport, { failTool: 'coord:send' });
    expect(calls.map((c) => c.tool)).toEqual(['work_items:create']);
  });

  it('reports a delivery failure when both routes fail, and does not retry on the same day', () => {
    const { r, calls } = runReviewAlarm(withinReport, { failTool: 'work_items:create coord:send' });
    expect(r.status).toBe(0);
    // Tick 1 tries both routes; tick 2 (same UTC day, same warning set) is suppressed.
    expect(calls.map((c) => c.tool)).toEqual(['work_items:create', 'coord:send']);
    expect(r.stdout).toContain('ALARM DELIVERY FAILED: neither work_items:create nor coord:send');
  });
});

describe('staging runtime environment inheritance', () => {
  let root: string;
  const sourceSha = 'a'.repeat(40);
  const sourcePin = `\nPAPERCUSP_BUILD_SHA=${sourceSha}\n`;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'staging-env-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function copyEnvironment(sources: Array<string | null>): string | null {
    const [current, legacy, canonical] = ['current', 'legacy', 'canonical'].map((name, i) => {
      const dir = join(root, name);
      mkdirSync(join(dir, 'apps/operator'), { recursive: true });
      if (sources[i] !== null) writeFileSync(join(dir, 'apps/operator/.env.local'), sources[i]!, { mode: 0o600 });
      return dir;
    });
    const candidate = join(root, 'candidate');
    mkdirSync(join(candidate, 'apps/operator'), { recursive: true });
    const r = runFn(['copy_staging_runtime_environment'],
      'log() { printf "%s\\n" "$*"; }\ncopy_staging_runtime_environment "$CANDIDATE" "$SOURCE_SHA"', {
        env: { STAGING_ROOT: current, LEGACY_STAGING_ROOT: legacy, INTEGRATION_ROOT: canonical, CANDIDATE: candidate, SOURCE_SHA: sourceSha },
      });
    expect(r.status).toBe(0);
    const copied = join(candidate, 'apps/operator/.env.local');
    if (!existsSync(copied)) return null;
    expect(statSync(copied).mode & 0o777).toBe(0o600);
    return readFileSync(copied, 'utf8');
  }

  it('preserves the current staging environment over legacy and canonical settings', () => {
    expect(copyEnvironment(['DATABASE_URL=current\n', 'DATABASE_URL=legacy\n', 'DATABASE_URL=canonical\n']))
      .toBe(`DATABASE_URL=current\n${sourcePin}`);
  });

  it('retains the legacy environment during the first generation cutover', () => {
    expect(copyEnvironment([null, 'DATABASE_URL=legacy\n', 'DATABASE_URL=canonical\n']))
      .toBe(`DATABASE_URL=legacy\n${sourcePin}`);
  });

  it('recovers the canonical DB pin when published staging has no runtime file', () => {
    expect(copyEnvironment([null, null, 'DATABASE_URL=canonical\n'])).toBe(`DATABASE_URL=canonical\n${sourcePin}`);
  });

  it('leaves explicitly inherited runtime configuration available when no file exists', () => {
    expect(copyEnvironment([null, null, null])).toBe(sourcePin);
  });

  it('replaces an inherited build label with the prepared candidate source', () => {
    copyEnvironment([`DATABASE_URL=current\nPAPERCUSP_BUILD_SHA=${'b'.repeat(40)}\n`, null, null]);
    const r = spawnSync('bash', ['-c', 'set -a; . "$ENV_FILE"; printf "%s" "$PAPERCUSP_BUILD_SHA"'], {
      env: { ...process.env, ENV_FILE: join(root, 'candidate/apps/operator/.env.local') }, encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(sourceSha);
  });

  it('refuses a missing or invalid source ref before copying runtime settings', () => {
    const current = join(root, 'current');
    const candidate = join(root, 'candidate');
    mkdirSync(join(current, 'apps/operator'), { recursive: true });
    mkdirSync(join(candidate, 'apps/operator'), { recursive: true });
    writeFileSync(join(current, 'apps/operator/.env.local'), 'DATABASE_URL=current\n');
    for (const invalid of ['', 'not-a-commit']) {
      const r = runFn(['copy_staging_runtime_environment'],
        'log() { printf "%s\\n" "$*"; }\ncopy_staging_runtime_environment "$CANDIDATE" "$SOURCE_SHA"', {
          env: { STAGING_ROOT: current, LEGACY_STAGING_ROOT: current, INTEGRATION_ROOT: current,
            CANDIDATE: candidate, SOURCE_SHA: invalid },
        });
      expect(r.status).toBe(1);
      expect(existsSync(join(candidate, 'apps/operator/.env.local'))).toBe(false);
    }
  });
});

describe('staging schema preparation before cutover (EI-24180022773715880)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'staging-schema-'));
    mkdirSync(join(root, 'apps/operator'), { recursive: true });
    mkdirSync(join(root, 'packages/operator-core/lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'apps/operator/tsconfig.json'), '{"compilerOptions":{"target":"ES2022"}}');
    symlinkSync(join(__dirname, '../../../../node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'packages/operator-core/lib/db-boot-migrate.ts'), `
      import { appendFileSync, watch, existsSync } from 'node:fs';
      export async function applyPendingMigrationsNow(options) {
        if (process.env.EXPECT_DATABASE_URL) {
          if (process.env.DATABASE_URL !== process.env.EXPECT_DATABASE_URL) throw new Error('wrong preflight database');
          if (process.env.PAPERCUSP_INTEGRATION_ROOT !== process.cwd()) throw new Error('wrong preflight source root');
        }
        appendFileSync(process.env.TRACE_FILE, JSON.stringify(options) + '\\n');
        if (process.env.FIXTURE_RESULT === 'wait') {
          await new Promise(resolve => {
            const watcher = watch(process.cwd(), () => {
              if (existsSync('release-backup')) { watcher.close(); resolve(); }
            });
            console.log('fixture-rendezvous-waiting');
          });
          return { applied: 1, failed: [] };
        }
        if (process.env.FIXTURE_RESULT === 'throw') throw new Error('snapshot admission refused');
        return JSON.parse(process.env.FIXTURE_RESULT);
      }
    `);
    writeFileSync(join(root, 'packages/operator-core/lib/serving-generation.ts'), `
      export async function assertRequiredServingMigrationsApplied() {
        if (process.env.MISSING_REQUIRED_MIGRATION) {
          throw new Error('serving schema is missing code-required migration(s): ' + process.env.MISSING_REQUIRED_MIGRATION);
        }
      }
    `);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preflights the candidate DB pin instead of an inherited discovery target', () => {
    writeFileSync(join(root, 'apps/operator/.env.local'),
      'DATABASE_URL=postgresql://fixture/candidate\nPAPERCUSP_INTEGRATION_ROOT=/stale/source\n');
    const r = runFn(['prepare_staging_schema'],
      'log() { printf "%s\\n" "$*"; }\nprepare_staging_schema && echo restart-requested', {
        env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: join(root, 'trace'),
          DATABASE_URL: 'postgresql://fixture/inherited', EXPECT_DATABASE_URL: 'postgresql://fixture/candidate',
          FIXTURE_RESULT: '{"applied":0,"failed":[]}' },
      });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('restart-requested');
    expect(JSON.parse(readFileSync(join(root, 'trace'), 'utf8')).sqlDir).toBe(join(root, 'libs/papercusp/libs/db/sql'));
  });

  it('blocks cutover for an unapplied code-required migration but ignores unrelated drafts', () => {
    const sqlDir = join(root, 'libs/papercusp/libs/db/sql');
    mkdirSync(sqlDir, { recursive: true });
    writeFileSync(join(sqlDir, '1490-unrelated.sql.DRAFT'), '-- intentionally parked');

    const blocked = runFn(['prepare_staging_schema'],
      'log() { printf "%s\\n" "$*"; }\nprepare_staging_schema && echo restart-requested', {
        env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: join(root, 'blocked-trace'),
          FIXTURE_RESULT: '{"applied":0,"failed":[]}',
          MISSING_REQUIRED_MIGRATION: '1489-fallback-observations-samples.sql' },
      });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('1489-fallback-observations-samples.sql');
    expect(blocked.stdout).not.toContain('restart-requested');
    expect(existsSync(join(root, 'blocked-trace'))).toBe(true);

    const ready = runFn(['prepare_staging_schema'],
      'log() { printf "%s\\n" "$*"; }\nprepare_staging_schema && echo restart-requested', {
        env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: join(root, 'ready-trace'),
          FIXTURE_RESULT: '{"applied":0,"failed":[]}' },
      });
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain('restart-requested');
    expect(existsSync(join(root, 'ready-trace'))).toBe(true);
  });

  it('refuses schema preparation when the candidate environment cannot be loaded', () => {
    writeFileSync(join(root, 'apps/operator/.env.local'), 'return 1\n');
    const trace = join(root, 'trace');
    const r = runFn(['prepare_staging_schema'],
      'log() { printf "%s\\n" "$*"; }\nprepare_staging_schema && echo restart-requested', {
        env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: trace,
          FIXTURE_RESULT: '{"applied":0,"failed":[]}' },
      });
    expect(r.status).toBe(1);
    expect(existsSync(trace)).toBe(false);
    expect(r.stdout).not.toContain('restart-requested');
  });

  it.each(['null', '{"applied":0,"failed":[{"file":"pending.sql","error":"guard refused"}]}', 'throw'])(
    'never requests restart when guarded preparation returns %s', (result) => {
      const r = runFn(['prepare_staging_schema'],
        'log() { printf "%s\\n" "$*"; }\nprepare_staging_schema && echo restart-requested', {
          env: { STAGING_ROOT: root, UNIT: 'fixture.service', TRACE_FILE: join(root, 'trace'), FIXTURE_RESULT: result },
        });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('keeping the current fixture.service process');
      expect(r.stdout).not.toContain('restart-requested');
      expect(JSON.parse(readFileSync(join(root, 'trace'), 'utf8'))).toEqual({
        sqlDir: join(root, 'libs/papercusp/libs/db/sql'), broadcast: false,
      });
    },
  );

  it('keeps the old host until the guarded backup wait settles, then permits cutover', async () => {
    const child = spawn('bash', ['-c', [
      'set -euo pipefail',
      'source <(sed -n "/^prepare_staging_schema()/,/^}/p" "$SYNC_SCRIPT")',
      'log() { printf "%s\\n" "$*"; }',
      'prepare_staging_schema',
      'echo restart-requested',
    ].join('\n')], { env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH, STAGING_ROOT: root,
      UNIT: 'fixture.service', TRACE_FILE: join(root, 'trace'), FIXTURE_RESULT: 'wait' } });
    const output = createTextCollector(child.stdout);
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    const waiting = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', () => {
        if (output.peek().includes('fixture-rendezvous-waiting')) resolve();
      });
      child.on('error', reject);
      child.on('close', () => {
        if (!output.peek().includes('fixture-rendezvous-waiting')) reject(new Error(output.text()));
      });
    });
    try {
      await waiting;
      expect(output.peek()).not.toContain('restart-requested');
      writeFileSync(join(root, 'release-backup'), 'released');
      expect(await closed).toBe(0);
      const finalOutput = output.text();
      expect(finalOutput.indexOf('target schema prepared:')).toBeLessThan(finalOutput.indexOf('restart-requested'));
    } finally {
      child.kill('SIGKILL');
    }
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const prepare = script.indexOf('prepare_staging_schema "$SYNC_ROOT"');
    expect(prepare).toBeGreaterThan(script.indexOf('PAPERCUSP_BUNDLE_REUSE_FRESH=1 bash'));
    expect(prepare).toBeLessThan(script.indexOf('requesting coordinated restart of $UNIT'));
  });
});

describe('sync-staging-checkout.sh staging launch contract (EI-19457080109574347)', () => {
  it('accepts the shipped shape: source .env.local, then explicitly force loopback', () => {
    expect(execForcesLoopback(
      "set -a; [ -f .env.local ] && . ./.env.local; set +a; export PAPERCUSP_HONO_PORT=3170 PAPERCUSP_BIND_HOST=127.0.0.1; exec node dist-host/hono-host.mjs",
    )).toBe(true);
  });

  it('rejects sourcing the shared env without a later bind override', () => {
    expect(execForcesLoopback(
      'export PAPERCUSP_BIND_HOST=127.0.0.1; set -a; . ./.env.local; set +a; exec node dist-host/hono-host.mjs',
    )).toBe(false);
  });

  it('rejects an off-loopback assignment that supersedes an earlier loopback value', () => {
    expect(execForcesLoopback(
      'set -a; . ./.env.local; set +a; export PAPERCUSP_BIND_HOST=127.0.0.1; export PAPERCUSP_BIND_HOST=0.0.0.0; exec node dist-host/hono-host.mjs',
    )).toBe(false);
  });

  it('rejects an implicit/default bind because the effective staging policy is not proven', () => {
    expect(execForcesLoopback('exec node dist-host/hono-host.mjs')).toBe(false);
  });

  it('pins runtime readers to the physical generation after loading .env.local', () => {
    expect(execPinsIntegrationRoot(
      'set -a; [ -f .env.local ] && . ./.env.local; set +a; export PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)"; exec node dist-host/hono-host.mjs',
    )).toBe(true);
    expect(execPinsIntegrationRoot(
      'set -a; [ -f .env.local ] && . ./.env.local; set +a; exec node dist-host/hono-host.mjs',
    )).toBe(false);
  });
});

describe('sync-staging-checkout.sh generation admission (EI-26746441745558411)', () => {
  function keeperSource() {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('# Keep the checkout flock in a dedicated coprocess.');
    return script.slice(start, script.indexOf('staging_alias_bootstrap()', start));
  }

  it('runs cleanup-only under the exclusive lock and exits before preparation or restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-cleanup-only-'));
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('# Single-flight: a second timer tick');
    const end = script.indexOf('# WI-5710 — SPA-only advance:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const driver = script.slice(start, end).replace(
      'STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"',
      'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
    );
    mkdirSync(join(root, '.git'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'trap staging_sync_lock_release EXIT',
        'INTEGRATION_ROOT="$TEST_ROOT"; STAGING_SYNC_CLEANUP_ONLY=1',
        'log() { printf "%s\\n" "$*"; }',
        'staging_lock_log() { :; }; staging_sync_checkpoint() { :; }',
        'staging_lock_attempt_id() { echo fixture; }; staging_lock_now_ms() { echo 0; }',
        'staging_alias_bootstrap() { :; }',
        'prune_staging_generations() { if flock -s -n "$TEST_LOCK" -c true; then echo UNEXPECTED_UNLOCKED_GC; exit 91; fi; echo EXCLUSIVE_GC; }',
        'staging_sync_lock_shared() { echo UNEXPECTED_PREPARATION; exit 92; }',
        'prepare_staging_candidate() { echo UNEXPECTED_CANDIDATE; exit 93; }',
        'systemctl() { echo UNEXPECTED_RESTART; exit 94; }',
        driver,
      ].join('\n')], {
        env: { ...process.env, TEST_ROOT: root, TEST_LOCK: join(root, 'generation.lock') },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('EXCLUSIVE_GC');
      expect(result.stdout).toContain('cleanup-only pass complete');
      expect(result.stdout).not.toContain('UNEXPECTED_');
      const released = spawnSync('flock', ['-n', join(root, 'generation.lock'), 'true']);
      expect(released.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps preparation readable while GC and publication remain exclusive', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-workflow-'));
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('# Single-flight: a second timer tick');
    const end = script.indexOf('# WI-5710 — SPA-only advance:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const driver = script.slice(start, end).replace(
      'STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"',
      'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
    );
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'published'));
    mkdirSync(join(root, 'candidate/checkout/apps/operator/bin'), { recursive: true });
    writeFileSync(join(root, 'candidate/checkout/apps/operator/bin/bundle-host.sh'), 'fixture');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'trap staging_sync_lock_release EXIT',
        'INTEGRATION_ROOT="$TEST_ROOT"; STAGING_ROOT="$TEST_ROOT/published"',
        'STAGING_CANDIDATE_ROOT=""; STAGING_CANDIDATE_HOME=""',
        'STAGING_BUNDLE_SCRIPT=/unused; UNIT=fixture.service; BRANCH=staging; STAGING_PORT=12345',
        'PAPERCUSP_PTOOL_BIN=/unused; MAX_STALE_SEC=1800',
        'log() { printf "%s\\n" "$*"; }',
        'staging_lock_log() { :; }; staging_sync_checkpoint() { :; }',
        'staging_lock_attempt_id() { echo fixture; }; staging_lock_now_ms() { echo 0; }',
        'git() { case "$*" in *"diff --name-only"*) echo server.ts;; *"staging^{commit}"*) echo "$TEST_TARGET";; *HEAD*) echo "$TEST_CURRENT";; *) return 1;; esac; }',
        'require_shared() { flock -s -n "$TEST_LOCK" -c true || { echo "reader refused during $1" >&2; return 91; }; echo "shared:$1"; }',
        'require_exclusive() { if flock -s -n "$TEST_LOCK" -c true; then echo "barrier missing during $1" >&2; return 92; fi; echo "exclusive:$1"; }',
        'staging_alias_bootstrap() { require_exclusive bootstrap; }',
        'prune_staging_generations() { require_exclusive gc; }',
        'forward_compat_review_warnings() { :; }; assert_staging_unit_loopback() { :; }; assert_staging_unit_checkout() { :; }; staging_preparation_has_headroom() { :; }',
        'staging_health_source_sha() { echo "$TEST_CURRENT"; }; paths_require_restart() { return 0; }; staging_live_client_count() { echo 0; }',
        'prepare_staging_candidate() { require_shared candidate; STAGING_CANDIDATE_ROOT="$TEST_ROOT/candidate/checkout"; STAGING_CANDIDATE_HOME="$TEST_ROOT/candidate"; }',
        'preflight_staging_migrations() { require_shared migrations; }; prebuild_staging_host_bundle() { require_shared bundle; }; prepare_staging_schema() { require_shared schema; }',
        'mark_staging_candidate_ready() { require_exclusive ready; }',
        'publish_staging_generation() { require_exclusive publication; printf "%s" "$3" > "$TEST_ROOT/published-sha"; }',
        'launch_staging_generation_measure() { :; }',
        driver,
      ].join('\n')], {
        env: { ...process.env, TEST_ROOT: root, TEST_LOCK: join(root, 'generation.lock'),
          TEST_TARGET: 'b'.repeat(40), TEST_CURRENT: 'a'.repeat(40) },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      for (const phase of ['candidate', 'migrations', 'bundle', 'schema']) {
        expect(result.stdout).toContain(`shared:${phase}`);
      }
      for (const phase of ['bootstrap', 'gc', 'ready', 'publication']) {
        expect(result.stdout).toContain(`exclusive:${phase}`);
      }
      expect(readFileSync(join(root, 'published-sha'), 'utf8')).toBe('b'.repeat(40));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps writer single-flight across a failed upgrade and admits no publication through readers', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-upgrade-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
        'trap staging_sync_lock_release EXIT',
        'staging_sync_lock_start; staging_sync_lock_shared',
        'flock -s -n "$TEST_LOCK" -c true',
        'exec 7>"$TEST_LOCK"; flock -s 7',
        'if staging_sync_lock_exclusive 1; then echo unsafe_upgrade; exit 90; else status=$?; fi',
        '[[ "$status" == 75 ]]',
        // A failed flock conversion can drop fd 9's shared lock. Once the
        // other reader exits, the independent writer lease must still hold.
        'flock -u 7; exec 7>&-',
        '(STAGING_SYNC_LOCK_OWNER_PID="$BASHPID"; STAGING_SYNC_LOCK_PROCESS_PID=""; if staging_sync_lock_start; then status=0; else status=$?; fi; staging_sync_lock_release; [[ "$status" == 75 ]])',
        'staging_sync_lock_exclusive 1',
        'if flock -s -n "$TEST_LOCK" -c true; then echo unsafe_reader; exit 91; fi',
        'staging_sync_lock_release; staging_sync_lock_release',
        'flock -n "$TEST_LOCK" -c true',
        'flock -n "$TEST_LOCK.writer" -c true',
        'echo bounded_upgrade_and_writer_lease_passed',
      ].join('\n')], {
        env: { ...process.env, TEST_LOCK: join(root, 'generation.lock') },
        encoding: 'utf8', timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('bounded_upgrade_and_writer_lease_passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases both leases when the keeper cannot process its cleanup command', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-stopped-keeper-'));
    const pidFile = join(root, 'keeper.pid');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
        'staging_sync_lock_start',
        'printf "%s" "$STAGING_SYNC_LOCK_PROCESS_PID" > "$TEST_PID_FILE"',
        'kill -STOP "$STAGING_SYNC_LOCK_PROCESS_PID"',
        'staging_sync_lock_release; staging_sync_lock_release',
        'flock -n "$TEST_LOCK" -c true',
        'flock -n "$TEST_LOCK.writer" -c true',
        'echo cleanup_finished_and_both_leases_free',
      ].join('\n')], {
        env: { ...process.env, TEST_LOCK: join(root, 'generation.lock'), TEST_PID_FILE: pidFile },
        encoding: 'utf8', timeout: 6_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('cleanup_finished_and_both_leases_free');
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('preserves a command fragmented across the keeper liveness deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-fragmented-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
        'trap staging_sync_lock_release EXIT',
        'staging_sync_lock_start',
        'printf sha >&"$STAGING_SYNC_LOCK_WRITE_FD"',
        'sleep 1.2',
        'printf "red\\n" >&"$STAGING_SYNC_LOCK_WRITE_FD"',
        'IFS= read -r -t 3 acknowledgement <&"$STAGING_SYNC_LOCK_READ_FD"',
        '[[ "$acknowledgement" == shared ]]',
        'flock -s -n "$TEST_LOCK" -c true',
        'if flock -n "$TEST_LOCK.writer" -c true; then exit 90; fi',
        'staging_sync_lock_exclusive 1',
        'if flock -s -n "$TEST_LOCK" -c true; then exit 91; fi',
        'staging_sync_lock_release',
        'flock -n "$TEST_LOCK" -c true',
        'flock -n "$TEST_LOCK.writer" -c true',
        'echo fragmented_command_acknowledged_and_leases_safe',
      ].join('\n')], {
        env: { ...process.env, TEST_LOCK: join(root, 'generation.lock') },
        encoding: 'utf8', timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('fragmented_command_acknowledged_and_leases_safe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['shared', 'exclusive'])('fails closed when a keeper stops acknowledging a %s transition', (transition) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-missing-ack-'));
    const pidFile = join(root, 'keeper.pid');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
        'trap staging_sync_lock_release EXIT',
        'staging_sync_lock_start',
        'printf "%s" "$STAGING_SYNC_LOCK_PROCESS_PID" > "$TEST_PID_FILE"',
        'if [[ "$TEST_TRANSITION" == exclusive ]]; then staging_sync_lock_shared; fi',
        'kill -STOP "$STAGING_SYNC_LOCK_PROCESS_PID"',
        'if [[ "$TEST_TRANSITION" == shared ]]; then',
        '  if staging_sync_lock_shared; then echo UNSAFE_PREPARATION; exit 91; fi',
        'else',
        '  if staging_sync_lock_exclusive 1; then echo UNSAFE_PREPARATION; exit 92; fi',
        'fi',
        'staging_sync_lock_release',
        'flock -n "$TEST_LOCK" -c true',
        'flock -n "$TEST_LOCK.writer" -c true',
        'echo failed_closed_and_both_leases_free',
      ].join('\n')], {
        env: { ...process.env, TEST_LOCK: join(root, 'generation.lock'), TEST_PID_FILE: pidFile, TEST_TRANSITION: transition },
        encoding: 'utf8', timeout: 12_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain('UNSAFE_PREPARATION');
      expect(result.stdout).toContain('failed_closed_and_both_leases_free');
      expect(result.stderr).toContain(`${transition} acknowledgement unavailable`);
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not pass either lock descriptor to a long-lived preparation child', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-admission-child-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail', keeperSource(),
        'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
        'trap staging_sync_lock_release EXIT',
        'staging_sync_lock_start; staging_sync_lock_shared',
        'sleep 2 & child=$!',
        'staging_sync_lock_release',
        'flock -n "$TEST_LOCK" -c true',
        'flock -n "$TEST_LOCK.writer" -c true',
        'echo both_locks_free_before_child_exit',
        'wait "$child"',
      ].join('\n')], {
        env: { ...process.env, TEST_LOCK: join(root, 'generation.lock') },
        encoding: 'utf8', timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('both_locks_free_before_child_exit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync-staging-checkout.sh bundle checkout lock (WI-10003374)', () => {
  const effective = '{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -s /tmp/papercup-staging-sync.lock /isolated/apps/operator/bin/bundle-host.sh ; ignore_errors=no ; start_time=[n/a] ; status=0/0 }';
  const guarded = '{ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c root="/isolated"; helper="$$root/apps/operator/scripts/systemd/staging-lock-attribution.sh"; if [ -f "$$helper" ]; then exec /usr/bin/bash "$$helper" api-pre /tmp/papercup-staging-sync.lock "$$root/apps/operator/bin/bundle-host.sh"; fi; echo "[95-bundled-entry] $$helper is absent from this staging generation; bundling under the shared flock without attribution" >&2; exec /usr/bin/flock -s /tmp/papercup-staging-sync.lock "$$root/apps/operator/bin/bundle-host.sh" ; ignore_errors=no ; start_time=[n/a] ; status=0/0 }';

  it('accepts the loaded shared-flock ExecStartPre from the isolated checkout', () => {
    expect(execPreUsesBundle(effective)).toBe(true);
  });

  it('accepts the guarded attribution helper and its one-generation fallback', () => {
    expect(execPreUsesBundle(guarded)).toBe(true);
  });

  it('rejects the wrong checkout, wrong lock, exclusive lock, and direct bundle execution', () => {
    expect(execPreUsesBundle(effective.replace('/isolated/', '/canonical/'))).toBe(false);
    expect(execPreUsesBundle(effective.replace('papercup-staging-sync.lock', 'other.lock'))).toBe(false);
    expect(execPreUsesBundle(effective.replace('flock -s', 'flock -x'))).toBe(false);
    expect(execPreUsesBundle(effective.replace(
      'path=/usr/bin/flock ; argv[]=/usr/bin/flock -s /tmp/papercup-staging-sync.lock ',
      'path=/isolated/apps/operator/bin/bundle-host.sh ; argv[]=',
    ))).toBe(false);
  });

  it('rejects guarded wrappers that change the checkout or weaken either lock path', () => {
    expect(execPreUsesBundle(guarded.replace('root="/isolated"', 'root="/canonical"'))).toBe(false);
    expect(execPreUsesBundle(guarded.replaceAll('papercup-staging-sync.lock', 'other.lock'))).toBe(false);
    expect(execPreUsesBundle(guarded.replace('flock -s', 'flock -x'))).toBe(false);
    expect(execPreUsesBundle(guarded.replace(
      'exec /usr/bin/flock -s /tmp/papercup-staging-sync.lock',
      'exec /usr/bin/true',
    ))).toBe(false);
  });
});

describe('sync-staging-checkout.sh immutable staging generations (WI-10003262)', () => {
  it('creates a unique candidate home even for repeated preparations of one source SHA', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-generations-'));
    const generationRoot = join(root, 'generations');
    const targetSha = 'abcdef0123456789abcdef0123456789abcdef01';
    const create = () => runFn(
      ['create_staging_candidate'],
      'create_staging_candidate "$TARGET_SHA"; printf "%s|%s\\n" "$STAGING_CANDIDATE_HOME" "$STAGING_CANDIDATE_ROOT"',
      { env: { STAGING_GENERATIONS_ROOT: generationRoot, TARGET_SHA: targetSha } },
    );
    try {
      const first = create();
      const second = create();
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      const [firstHome, firstCheckout] = first.stdout.trim().split('|');
      const [secondHome, secondCheckout] = second.stdout.trim().split('|');
      expect(firstHome).not.toBe(secondHome);
      expect(firstCheckout).toBe(firstHome + '/checkout');
      expect(secondCheckout).toBe(secondHome + '/checkout');
      expect(firstHome).toContain('.candidate-abcdef012345.');
      expect(secondHome).toContain('.candidate-abcdef012345.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the current alias untouched when a candidate is missing its required host bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-publish-failure-'));
    const oldRoot = join(root, 'old-generation');
    const alias = join(root, 'staging.current');
    const candidateHome = join(root, '.candidate-next');
    const candidateRoot = join(candidateHome, 'checkout');
    const targetSha = '0123456789abcdef0123456789abcdef01234567';
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(join(candidateRoot, 'apps/operator-vite/dist'), { recursive: true });
    mkdirSync(candidateHome, { recursive: true });
    writeFileSync(join(candidateRoot, 'apps/operator-vite/dist/index.html'), '<html></html>');
    writeFileSync(join(candidateHome, '.ready'), targetSha + '\n');
    symlinkSync(oldRoot, alias);
    try {
      const result = runFn(
        ['staging_candidate_unready_reason', 'publish_staging_generation'],
        `log() { printf '%s\\n' "$*"; }; publish_staging_generation "$CANDIDATE_ROOT" "$CANDIDATE_HOME" "$TARGET_SHA" 1`,
        {
          env: {
            STAGING_ROOT: alias,
            CANDIDATE_ROOT: candidateRoot,
            CANDIDATE_HOME: candidateHome,
            TARGET_SHA: targetSha,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(realpathSync(alias)).toBe(realpathSync(oldRoot));
      // EI-24867768475421999: the refusal names the unmet condition, because the
      // EXIT trap deletes the candidate and the journal line is the only evidence left.
      expect(result.stdout).toContain(
        'FATAL: refusing to publish an incomplete staging generation: host bundle missing or empty',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically publishes a ready SPA-only candidate without requiring a host bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-publish-spa-'));
    const oldRoot = join(root, 'old-generation');
    const alias = join(root, 'staging.current');
    const candidateHome = join(root, '.candidate-spa');
    const candidateRoot = join(candidateHome, 'checkout');
    const targetSha = 'fedcba9876543210fedcba9876543210fedcba98';
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(join(candidateRoot, 'apps/operator-vite/dist'), { recursive: true });
    mkdirSync(candidateHome, { recursive: true });
    writeFileSync(join(candidateRoot, 'apps/operator-vite/dist/index.html'), '<html></html>');
    writeFileSync(join(candidateHome, '.ready'), targetSha + '\n');
    symlinkSync(oldRoot, alias);
    try {
      const result = runFn(
        ['staging_candidate_unready_reason', 'publish_staging_generation'],
        'log() { :; }; publish_staging_generation "$CANDIDATE_ROOT" "$CANDIDATE_HOME" "$TARGET_SHA" 0',
        {
          env: {
            STAGING_ROOT: alias,
            CANDIDATE_ROOT: candidateRoot,
            CANDIDATE_HOME: candidateHome,
            TARGET_SHA: targetSha,
          },
        },
      );
      expect(result.status).toBe(0);
      expect(realpathSync(alias)).toBe(realpathSync(candidateRoot));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync-staging-checkout.sh superseded generation pruning (WI-10005310)', () => {
  const PRUNE_FNS = ['collect_staging_generation_refs', 'staging_generation_in_use', 'staging_generation_holder_evidence',
    'retire_staging_generation_home', 'prune_staging_worktree_registrations', 'launch_staging_trash_drain', 'prune_staging_generations'];

  it.each([
    ['critical', '1000000', '0.000001', 75],
    ['healthy', '0.000001', '0.000001', 0],
  ] as const)('uses the shared writer reserve before preparing a %s-capacity candidate', (_state, gb, pct, status) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-headroom-'));
    try {
      const script = readFileSync(SCRIPT_PATH, 'utf8');
      const start = script.indexOf('\nSYNC_ROOT="');
      const end = script.indexOf('\nif [ "$restart_required" = 1 ]; then', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const allocation = join(root, 'candidate-allocated');
      const result = runFn(['staging_preparation_has_headroom'], [
        'log() { printf "%s\\n" "$*"; }',
        'staging_sync_checkpoint() { :; }',
        'prepare_staging_candidate() { touch "$TEST_ALLOCATION"; STAGING_CANDIDATE_ROOT="$STAGING_ROOT"; }',
        'checkout_needs_advance=1; target=0123456789abcdef',
        script.slice(start, end),
      ].join('\n'), {
        env: {
          INTEGRATION_ROOT: resolve(dirname(SCRIPT_PATH), '../../../..'),
          STAGING_GENERATIONS_ROOT: root,
          STAGING_ROOT: root,
          TEST_ALLOCATION: allocation,
          PAPERCUSP_DISK_ALARM_CRITICAL_GB: gb,
          PAPERCUSP_DISK_ALARM_CRITICAL_PCT: pct,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(allocation)).toBe(status === 0);
      if (status === 75) {
        expect(result.stderr).toContain('retaining the serving generation while cleanup continues');
        expect(result.stdout).toContain('the next tick retries cleanup');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // WI-6554700010029252: the reserve must still hold after the candidate lands,
  // so the check adds the last measured generation size to it.
  it.each([
    // Larger than any real filesystem, but still a safe integer (an unsafe one is
    // treated as unparseable, like the case below).
    ['a measured generation that would breach the reserve defers', '9000000000000000', 75],
    ['an unparseable measurement falls back to the reserve alone', 'not-a-number', 0],
    ['a missing measurement falls back to the reserve alone', null, 0],
  ] as const)('%s', (_name, stamp, status) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-headroom-measured-'));
    try {
      const bytesFile = join(root, '.generation-bytes');
      if (stamp !== null) writeFileSync(bytesFile, `${stamp}\n`);
      const result = runFn(['staging_preparation_has_headroom'],
        'if staging_preparation_has_headroom; then echo HEADROOM_OK; else echo "HEADROOM_STATUS=$?"; fi', {
          env: {
            INTEGRATION_ROOT: resolve(dirname(SCRIPT_PATH), '../../../..'),
            STAGING_GENERATIONS_ROOT: root,
            STAGING_GENERATION_BYTES_FILE: bytesFile,
            PAPERCUSP_DISK_ALARM_CRITICAL_GB: '0.000001',
            PAPERCUSP_DISK_ALARM_CRITICAL_PCT: '0.000001',
          },
        });
      expect(result.status, result.stderr).toBe(0);
      if (status === 75) {
        expect(result.stdout).toContain('HEADROOM_STATUS=75');
        expect(result.stderr).toContain(`+ ${stamp} measured generation size`);
        expect(result.stderr).toContain('retaining the serving generation while cleanup continues');
      } else {
        expect(result.stdout).toContain('HEADROOM_OK');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records a published generation size atomically and keeps the previous value when the walk fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-generation-measure-'));
    const home = join(root, '.candidate-abc.x');
    const bytesFile = join(root, '.generation-bytes');
    const bin = join(root, 'bin');
    try {
      mkdirSync(join(home, 'checkout'), { recursive: true });
      writeFileSync(join(home, 'checkout', 'payload'), Buffer.alloc(256 * 1024, 1));
      // The walk body is a top-level assignment, not a function, so runFn's
      // function extraction cannot source it: hand the live text in instead.
      const body = /^STAGING_GENERATION_MEASURE_SCRIPT='([^']*)'$/m.exec(readFileSync(SCRIPT_PATH, 'utf8'))?.[1];
      expect(body).toContain('du -sxB1');
      const measure = (env: Record<string, string> = {}) => runFn(['launch_staging_generation_measure'],
        `log() { echo "$*"; }; launch_staging_generation_measure ${JSON.stringify(home)} ${JSON.stringify(bytesFile)}`,
        { env: { STAGING_GENERATION_MEASURE_MODE: 'inline', STAGING_GENERATION_MEASURE_SCRIPT: body, ...env } });

      const first = measure();
      expect(first.status, first.stderr).toBe(0);
      const recorded = readFileSync(bytesFile, 'utf8').trim();
      expect(recorded).toMatch(/^[0-9]+$/);
      expect(Number(recorded)).toBeGreaterThanOrEqual(256 * 1024);
      expect(first.stdout).toContain(`measured staging generation size inline: ${recorded} bytes`);

      // A failing walk must not overwrite or delete the last good measurement.
      mkdirSync(bin);
      writeFileSync(join(bin, 'du'), '#!/usr/bin/env bash\necho "1 $2"\nexit 1\n', { mode: 0o755 });
      const failed = measure({ PATH: `${bin}:${process.env.PATH}` });
      expect(failed.status, failed.stderr).toBe(0);
      expect(failed.stdout).toContain('keeping the previous measurement');
      expect(readFileSync(bytesFile, 'utf8').trim()).toBe(recorded);
      expect(readdirSync(root).filter((n) => n.includes('.tmp.'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('launches the size measurement as a collected transient unit, and skips while one is already running', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-generation-measure-unit-'));
    const home = join(root, '.candidate-abc.x');
    const bytesFile = join(root, '.generation-bytes');
    const bin = join(root, 'bin');
    const runs = join(root, 'systemd-run.log');
    try {
      mkdirSync(home, { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(runs)}\nexit 0\n`, { mode: 0o755 });
      const launch = (active: boolean) => {
        writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\nexit ${active ? 0 : 3}\n`, { mode: 0o755 });
        return runFn(['launch_staging_generation_measure'],
          `log() { echo "$*"; }; launch_staging_generation_measure ${JSON.stringify(home)} ${JSON.stringify(bytesFile)}`,
          { env: { PATH: `${bin}:${process.env.PATH}`, STAGING_GENERATION_MEASURE_MODE: 'detached', STAGING_GENERATION_MEASURE_SCRIPT: 'exit 0' } });
      };
      const busy = launch(true);
      expect(busy.status, busy.stderr).toBe(0);
      expect(busy.stdout).toContain('measurement already running');
      expect(existsSync(runs)).toBe(false);

      const started = launch(false);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain('launched detached staging generation size measurement unit=');
      const args = readFileSync(runs, 'utf8').split('\n');
      expect(args).toContain('--user');
      expect(args).toContain('--collect');
      expect(args.find((a) => a.startsWith('--unit='))).toMatch(/^--unit=papercup-staging-generation-size-[0-9a-f]{12}$/);
      expect(args).not.toContain('IOSchedulingClass=idle');
      expect(args).toContain(home);
      expect(args).toContain(bytesFile);
      expect(existsSync(bytesFile)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('measures the generation it just published, after publication and outside the publication lock', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const publish = script.indexOf('\n  publish_staging_generation "$STAGING_CANDIDATE_ROOT"');
    const measure = script.indexOf('\n  launch_staging_generation_measure "$STAGING_CANDIDATE_HOME"');
    expect(publish).toBeGreaterThan(0);
    expect(measure).toBeGreaterThan(publish);
    expect(script.slice(publish, measure)).toContain('staging_sync_checkpoint "generation published"');
  });

  it('bounds a stalled git worktree prune so runtime preparation continues, with the generation already retired', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-budget-'));
    const generations = join(root, 'generations');
    const candidate = join(generations, '.candidate-old.slow');
    const checkout = join(candidate, 'checkout');
    const bin = join(root, 'bin');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(bin);
    // An unbounded git call would outlive the outer 20s deadline (status 137).
    writeFileSync(join(bin, 'git'), '#!/usr/bin/env bash\nexec sleep 60\n', { mode: 0o755 });
    try {
      const result = spawnSync('timeout', ['--signal=KILL', '20s', 'bash', '-c', [
        'set -uo pipefail',
        ...PRUNE_FNS.map((f) => `source <(sed -n "/^${f}()/,/^}/p" "$SYNC_SCRIPT")`),
        'log() { echo "$*"; }; prune_staging_generations 2; echo RUNTIME_PREPARATION_CONTINUES',
      ].join('\n')], { encoding: 'utf8', env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH,
        PATH: `${bin}:${process.env.PATH}`, STAGING_ROOT: join(root, 'absent-current'),
        STAGING_GENERATIONS_ROOT: generations, STAGING_PROC_ROOT: join(root, 'absent-proc'),
        INTEGRATION_ROOT: root, STAGING_TRASH_DRAIN_MODE: 'inline' } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('cleanup budget exhausted');
      expect(result.stdout).toContain('RUNTIME_PREPARATION_CONTINUES');
      expect(result.stdout).toContain(`pruned unused staging generation ${checkout}`);
      expect(existsSync(candidate)).toBe(false);
      expect(readdirSync(generations)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  // WI-6554700010029246: the 15s in-lock rm reclaimed a sliver of one ~25 GiB
  // tree per tick, so idle generations outran deletion and filled /. Every
  // idle generation must now leave the generation namespace in O(1) under the
  // lock, however slow byte deletion is, and the bytes go to a detached drain.
  it('retires every idle generation under the lock in O(1) and hands the bytes to a detached drain', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-trash-'));
    const generations = join(root, 'generations');
    const bin = join(root, 'bin');
    const runs = join(root, 'systemd-run.log');
    const current = join(generations, '.candidate-cur.serving', 'checkout');
    mkdirSync(current, { recursive: true });
    const idle = ['a', 'b', 'c', 'd', 'e'].map((id) => {
      const home = join(generations, `.candidate-${id}${id}${id}.idle`);
      mkdirSync(join(home, 'checkout', 'node_modules'), { recursive: true });
      writeFileSync(join(home, 'checkout', 'node_modules', 'payload'), id);
      return home;
    });
    // A legacy marker from the budgeted pruner: Git already detached the tree.
    const legacy = join(generations, '.candidate-fff.legacy');
    mkdirSync(join(legacy, 'partially-deleted'), { recursive: true });
    writeFileSync(`${legacy}.prune-pending`, '');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // Any in-lock recursive deletion of a generation would blow the deadline below.
    writeFileSync(join(bin, 'rm'), [
      '#!/usr/bin/env bash',
      'rec=0; gen=0',
      'for a; do [[ "$a" == -*r* ]] && rec=1; [[ "$a" == */generations/* ]] && gen=1; done',
      'if ((rec && gen)); then exec sleep 30; fi',
      'exec /bin/rm "$@"',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 });
    writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(runs)}\nexit 0\n`, { mode: 0o755 });
    try {
      // The slow rm shim sleeps 30s, so any in-lock recursive delete is killed
      // by this outer deadline (status 137) instead of passing.
      const result = spawnSync('timeout', ['--signal=KILL', '20s', 'bash', '-c', [
        'set -uo pipefail',
        ...PRUNE_FNS.map((f) => `source <(sed -n "/^${f}()/,/^}/p" "$SYNC_SCRIPT")`),
        'log() { echo "$*"; }; prune_staging_generations',
      ].join('\n')], { encoding: 'utf8', env: { ...process.env, SYNC_SCRIPT: SCRIPT_PATH,
        PATH: `${bin}:${process.env.PATH}`, STAGING_ROOT: current, STAGING_GENERATIONS_ROOT: generations,
        STAGING_PROC_ROOT: join(root, 'absent-proc'), INTEGRATION_ROOT: root, STAGING_TRASH_DRAIN_MODE: 'detached' } });
      expect(result.status, result.stderr).toBe(0);
      for (const home of [...idle, legacy]) expect(existsSync(home)).toBe(false);
      expect(existsSync(`${legacy}.prune-pending`)).toBe(false);
      expect(existsSync(current)).toBe(true);
      const remaining = readdirSync(generations).sort();
      const trash = remaining.filter((n) => n.startsWith('.trash-'));
      expect(remaining.filter((n) => !n.startsWith('.trash-'))).toEqual(['.candidate-cur.serving']);
      expect(trash).toHaveLength(6);
      const args = readFileSync(runs, 'utf8').split('\n');
      expect(args).toContain('--user');
      expect(args).toContain('--collect');
      const unitArg = args.find((a) => a.startsWith('--unit='));
      expect(unitArg).toMatch(/^--unit=papercup-staging-trash-drain-[0-9a-f]{12}$/);
      expect(args).not.toContain('IOSchedulingClass=idle');
      for (const name of trash) expect(args).toContain(join(generations, name));
      expect(result.stdout).toContain('launched detached retired staging generation drain');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('leaves an already-running drain to finish and falls back to a detached session when systemd-run fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-trash-drain-'));
    const generations = join(root, 'generations');
    const bin = join(root, 'bin');
    const runs = join(root, 'systemd-run.log');
    mkdirSync(join(generations, '.trash-candidate-old.x.1', 'checkout'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash\necho invoked >> ${JSON.stringify(runs)}\nexit 1\n`, { mode: 0o755 });
    const drain = (active: boolean) => {
      writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\nexit ${active ? 0 : 3}\n`, { mode: 0o755 });
      return runFn(['launch_staging_trash_drain'], 'log() { echo "$*"; }; launch_staging_trash_drain', {
        env: { PATH: `${bin}:${process.env.PATH}`, STAGING_GENERATIONS_ROOT: generations, STAGING_TRASH_DRAIN_MODE: 'detached' },
      });
    };
    try {
      const busy = drain(true);
      expect(busy.status, busy.stderr).toBe(0);
      expect(busy.stdout).toContain('drain already running');
      expect(existsSync(runs)).toBe(false);
      expect(readdirSync(generations)).toHaveLength(1);

      const fallback = drain(false);
      expect(fallback.status, fallback.stderr).toBe(0);
      expect(readFileSync(runs, 'utf8')).toContain('invoked');
      expect(fallback.stdout).toContain('falling back to a detached session');
      for (let i = 0; i < 50 && readdirSync(generations).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readdirSync(generations)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('alarms when more than two non-serving generations are retained by holders or pins', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-retained-alarm-'));
    const generations = join(root, 'generations');
    const expiry = `${Math.floor(Date.now() / 1000) + 600}\n`;
    const pinned = (id: string) => {
      const home = join(generations, `.candidate-${id}.pinned`);
      mkdirSync(join(home, 'checkout'), { recursive: true });
      mkdirSync(join(home, '.audit-runtime-pins'));
      writeFileSync(join(home, '.audit-runtime-pins', 'owner'), expiry);
    };
    const env = { STAGING_ROOT: join(root, 'absent-current'), STAGING_GENERATIONS_ROOT: generations,
      STAGING_PROC_ROOT: join(root, 'absent-proc'), INTEGRATION_ROOT: root };
    try {
      pinned('one');
      pinned('two');
      const quiet = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', { env });
      expect(quiet.status, quiet.stderr).toBe(0);
      expect(quiet.stdout).not.toContain('ALARM: ');
      pinned('three');
      const loud = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', { env });
      expect(loud.status, loud.stderr).toBe(0);
      expect(loud.stdout).toContain('ALARM: 3 non-serving staging generations retained');
      expect(readdirSync(generations)).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains crashed audit replay source until its bounded pin expires, then collects it (EI-25971079852455067)', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-audit-pin-'));
    try {
      const generations = join(root, 'generations');
      const candidate = join(generations, '.candidate-old.audit');
      const checkout = join(candidate, 'checkout');
      const pins = join(candidate, '.audit-runtime-pins');
      mkdirSync(checkout, { recursive: true });
      mkdirSync(pins);
      const pin = join(pins, 'owner');
      writeFileSync(pin, `${Math.floor(Date.now() / 1000) + 600}\n{}\n`);
      const env = { STAGING_ROOT: join(root, 'absent-current'), STAGING_GENERATIONS_ROOT: generations,
        STAGING_PROC_ROOT: join(root, 'absent-proc'), INTEGRATION_ROOT: root };
      const retained = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', { env });
      expect(retained.status).toBe(0);
      expect(retained.stdout).toContain('bounded audit runtime pin');
      expect(existsSync(checkout)).toBe(true);
      writeFileSync(pin, '1\n{}\n');
      const collected = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', { env });
      expect(collected.status).toBe(0);
      expect(collected.stdout).toContain(`pruned unused staging generation ${checkout}`);
      expect(existsSync(candidate)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('alarms and retains a newly damaged audit pin without treating its payload as shell code', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-audit-pin-corrupt-'));
    try {
      const generations = join(root, 'generations');
      const candidate = join(generations, '.candidate-old.audit');
      const checkout = join(candidate, 'checkout');
      const pins = join(candidate, '.audit-runtime-pins');
      mkdirSync(checkout, { recursive: true });
      mkdirSync(pins);
      writeFileSync(join(pins, 'owner'), '$(touch SHOULD_NOT_EXIST)\n');
      const result = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', {
        env: { STAGING_ROOT: join(root, 'absent-current'), STAGING_GENERATIONS_ROOT: generations,
          STAGING_PROC_ROOT: join(root, 'absent-proc'), INTEGRATION_ROOT: root },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ALARM: malformed audit source pin');
      expect(existsSync(checkout)).toBe(true);
      expect(existsSync(join(candidate, 'SHOULD_NOT_EXIST'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('removes superseded generations but keeps the current one and any a process still runs from', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-'));
    const generationRoot = join(root, 'papercusp-staging.generations');
    const alias = join(root, 'papercusp-staging.current');
    const makeGeneration = (name: string) => {
      const checkout = join(generationRoot, name, 'checkout');
      mkdirSync(checkout, { recursive: true });
      return realpathSync(checkout);
    };
    const current = makeGeneration('.candidate-aaaaaaaaaaaa.cur');
    const inUse = makeGeneration('.candidate-bbbbbbbbbbbb.use');
    const superseded = makeGeneration('.candidate-cccccccccccc.old');
    symlinkSync(current, alias);
    // A process whose environment pins the generation, the way the staging host does.
    const holder = spawn('sleep', ['60'], { env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: inUse }, stdio: 'ignore' });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      const result = runFn(
        PRUNE_FNS,
        'log() { echo "$*"; }; prune_staging_generations',
        { env: { STAGING_ROOT: alias, STAGING_GENERATIONS_ROOT: generationRoot, INTEGRATION_ROOT: root } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`pruned unused staging generation ${superseded}`);
      expect(result.stdout).toContain(`retaining prior staging generation still referenced by a process: ${inUse}`);
      expect(() => realpathSync(join(generationRoot, '.candidate-cccccccccccc.old'))).toThrow();
      expect(realpathSync(current)).toBe(current);
      expect(realpathSync(inUse)).toBe(inUse);
    } finally {
      holder.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains a generation a process runs inside (cwd), not only one pinned by environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-cwd-'));
    const generationRoot = join(root, 'papercusp-staging.generations');
    const alias = join(root, 'papercusp-staging.current');
    const current = join(generationRoot, '.candidate-aaaaaaaaaaaa.cur', 'checkout');
    const cwdPinned = join(generationRoot, '.candidate-dddddddddddd.cwd', 'checkout');
    mkdirSync(current, { recursive: true });
    mkdirSync(join(cwdPinned, 'apps/operator'), { recursive: true });
    symlinkSync(realpathSync(current), alias);
    // The process sits in a SUBDIRECTORY of the generation, as a host started
    // from apps/operator does; the prefix match must still see it.
    const env = { ...process.env };
    delete env.PAPERCUSP_INTEGRATION_ROOT;
    const holder = spawn('sleep', ['60'], { cwd: join(cwdPinned, 'apps/operator'), env, stdio: 'ignore' });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      const result = runFn(
        PRUNE_FNS,
        'log() { echo "$*"; }; prune_staging_generations',
        { env: { STAGING_ROOT: alias, STAGING_GENERATIONS_ROOT: generationRoot, INTEGRATION_ROOT: root } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `retaining prior staging generation still referenced by a process: ${realpathSync(cwdPinned)}`,
      );
      expect(result.stdout).toContain(`holder_pid=${holder.pid} holder_ppid=${process.pid} `);
      expect(result.stdout).toContain('reference=cwd');
      expect(realpathSync(cwdPinned)).toBeTruthy();
    } finally {
      holder.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains a generation a process names only in argv — a release:cut orchestrator (WI-6554700010029679)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-prune-argv-')));
    const generationRoot = join(root, 'papercusp-staging.generations');
    const alias = join(root, 'papercusp-staging.current');
    const current = join(generationRoot, '.candidate-aaaaaaaaaaaa.cur', 'checkout');
    const argvPinned = join(generationRoot, '.candidate-eeeeeeeeeeee.arg', 'checkout');
    const unreferenced = join(generationRoot, '.candidate-ffffffffffff.old', 'checkout');
    const orchestrator = join(argvPinned, 'papercusp-desktop/bin/release-local.sh');
    mkdirSync(current, { recursive: true });
    mkdirSync(unreferenced, { recursive: true });
    mkdirSync(dirname(orchestrator), { recursive: true });
    writeFileSync(orchestrator, '');
    symlinkSync(current, alias);
    // The cut's shape: cwd in the release root (outside every generation), no
    // PAPERCUSP_INTEGRATION_ROOT, the generation present ONLY as a positional
    // argument. `; true` stops bash exec-ing sleep, which would drop that argv.
    const env = { ...process.env };
    delete env.PAPERCUSP_INTEGRATION_ROOT;
    const holder = spawn('bash', ['-c', 'sleep 60; true', join(root, 'release-root.sh'), orchestrator], {
      cwd: root,
      env,
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      const result = runFn(
        PRUNE_FNS,
        'log() { echo "$*"; }; prune_staging_generations',
        { env: { STAGING_ROOT: alias, STAGING_GENERATIONS_ROOT: generationRoot, INTEGRATION_ROOT: root } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`retaining prior staging generation still referenced by a process: ${argvPinned}`);
      expect(result.stdout).toContain(`holder_pid=${holder.pid} `);
      expect(result.stdout).toContain('reference=argv');
      expect(result.stdout).toContain(`pruned unused staging generation ${unreferenced}`);
      expect(realpathSync(argvPinned)).toBe(argvPinned);
    } finally {
      holder.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['live', 'missing'] as const)('reports a retained sidecar with its exact PID and %s declared parent (WI5508)', async (parentState) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-parent-'));
    const generationRoot = join(root, 'papercusp-staging.generations');
    const alias = join(root, 'papercusp-staging.current');
    const current = join(generationRoot, '.candidate-aaaaaaaaaaaa.cur', 'checkout');
    const pinned = join(generationRoot, '.candidate-bbbbbbbbbbbb.pin', 'checkout');
    mkdirSync(current, { recursive: true });
    mkdirSync(pinned, { recursive: true });
    symlinkSync(current, alias);
    // pid_max + 1 cannot name a real Linux process; the live case names this
    // fixture's actual parent. Neither case signals any non-fixture process.
    const declaredParent = parentState === 'live' ? process.pid
      : Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
    const holder = spawn('sleep', ['60'], {
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: pinned, PAPERCUSP_DESKTOP_PARENT_PID: String(declaredParent) },
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      const result = runFn(PRUNE_FNS, 'log() { echo "$*"; }; prune_staging_generations', {
        env: { STAGING_ROOT: alias, STAGING_GENERATIONS_ROOT: generationRoot, INTEGRATION_ROOT: root },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`generation=${pinned} holder_pid=${holder.pid} `);
      expect(result.stdout).toContain(`declared_parent_pid=${declaredParent} declared_parent_state=${parentState}`);
      expect(result.stdout).toContain(`holder_ppid=${process.pid} `);
      if (parentState === 'missing') {
        expect(result.stdout).toContain('ALARM: staging generation pinned by sidecar without its declared parent');
        expect(result.stdout).toContain('action=inspect-sidecar-parent-watch');
      } else {
        expect(result.stdout).not.toContain('ALARM:');
      }
      expect(existsSync(pinned)).toBe(true);
      expect(holder.exitCode).toBeNull();
    } finally {
      holder.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['recycled', 'unreadable', 'invalid'] as const)('keeps %s parent evidence distinct without exposing environment values (WI5508)', (parentState) => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-proc-'));
    const proc = join(root, 'proc');
    const pinned = join(root, 'checkout');
    const childPid = 100;
    const parentPid = 200;
    const procStat = (pid: number, ppid: number, start: number) =>
      `${pid} (sidecar (worker)) ${['S', String(ppid), ...Array<string>(17).fill('0'), String(start)].join(' ')}\n`;
    mkdirSync(join(proc, String(childPid)), { recursive: true });
    writeFileSync(join(proc, String(childPid), 'stat'), procStat(childPid, 1, 100));
    if (parentState !== 'unreadable') {
      writeFileSync(join(proc, String(childPid), 'environ'),
        `PRIVATE_TOKEN=never-log-this\0PAPERCUSP_DESKTOP_PARENT_PID=${parentState === 'invalid' ? 'not-a-pid' : parentPid}\0`);
    }
    if (parentState === 'recycled') {
      mkdirSync(join(proc, String(parentPid)), { recursive: true });
      writeFileSync(join(proc, String(parentPid), 'stat'), procStat(parentPid, 1, 200));
    }
    try {
      const result = runFn(['staging_generation_holder_evidence'],
        'set -euo pipefail; log() { echo "$*"; }; staging_generation_holder_evidence "$PINNED" "$PROC"', {
          env: { PINNED: pinned, PROC: proc, STAGING_GENERATION_PROCESS_REFS: `${childPid}\tintegration-root\t${pinned}` },
        });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('holder_ppid=1 holder_comm=sidecar__worker_');
      expect(result.stdout).toContain(`declared_parent_state=${parentState === 'recycled' ? 'recycled' : 'unknown'}`);
      expect(result.stdout.includes('ALARM:')).toBe(parentState === 'recycled');
      expect(result.stdout).not.toContain('never-log-this');
      expect(result.stdout).not.toContain('not-a-pid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds holder metadata, deduplicates PID references and excludes sibling path prefixes (WI5508)', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-bounded-'));
    const pinned = join(root, 'checkout');
    const refs = Array.from({ length: 7 }, (_, i) => `${100 + i}\tcwd\t${pinned}/apps/operator`);
    refs.push(`100\tintegration-root\t${pinned}`, `999\tcwd\t${pinned}-other`);
    try {
      const result = runFn(['staging_generation_holder_evidence'],
        'set -euo pipefail; log() { echo "$*"; }; staging_generation_holder_evidence "$PINNED" "$PROC"', {
          env: { PINNED: pinned, PROC: join(root, 'vanished-proc'), STAGING_GENERATION_PROCESS_REFS: refs.join('\n') },
        });
      expect(result.status).toBe(0);
      expect(result.stdout.match(/staging-generation-holder /g)).toHaveLength(5);
      expect(result.stdout).toContain('holders=7 shown=5 omitted=2');
      expect(result.stdout).toContain('declared_parent_state=unknown');
      expect(result.stdout).not.toContain('holder_pid=999');
      expect(result.stdout).not.toContain('ALARM:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans /proc once per prune, however many generations it judges, and not at all in the steady state (WI-10005311)', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-prune-scan-'));
    const generationRoot = join(root, 'papercusp-staging.generations');
    const alias = join(root, 'papercusp-staging.current');
    const current = join(generationRoot, '.candidate-aaaaaaaaaaaa.cur', 'checkout');
    mkdirSync(current, { recursive: true });
    symlinkSync(realpathSync(current), alias);
    // Wrap the real collector so each invocation is counted on stderr.
    const countingPrune = [
      'eval "$(declare -f collect_staging_generation_refs | sed "1s/^collect_staging_generation_refs/real_collect_staging_generation_refs/")"',
      'collect_staging_generation_refs() { echo SCAN >&2; real_collect_staging_generation_refs; }',
      'log() { echo "$*"; }',
      'prune_staging_generations',
    ].join('\n');
    const env = { STAGING_ROOT: alias, STAGING_GENERATIONS_ROOT: generationRoot, INTEGRATION_ROOT: root };
    try {
      const steady = runFn(PRUNE_FNS, countingPrune, { env });
      expect(steady.status).toBe(0);
      expect(steady.stderr.match(/^SCAN$/gm) ?? []).toHaveLength(0);

      const superseded = ['bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'].map((sha) => {
        const checkout = join(generationRoot, `.candidate-${sha}.old`, 'checkout');
        mkdirSync(checkout, { recursive: true });
        return realpathSync(checkout);
      });
      const result = runFn(PRUNE_FNS, countingPrune, { env });
      expect(result.status).toBe(0);
      expect(result.stderr.match(/^SCAN$/gm) ?? []).toHaveLength(1);
      for (const checkout of superseded) {
        expect(result.stdout).toContain(`pruned unused staging generation ${checkout}`);
      }
      expect(realpathSync(current)).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects process references under the script\'s own set -euo pipefail without aborting', () => {
    const result = runFn(
      ['collect_staging_generation_refs'],
      'set -euo pipefail; collect_staging_generation_refs; printf "%s\\n" "$STAGING_GENERATION_REFS"; echo COLLECTED',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('COLLECTED');
    // The calling shell's own cwd is a live process cwd, so a working scan must report it.
    expect(result.stdout.split('\n')).toContain(realpathSync(process.cwd()));
  });

  it('prunes at the start of every tick, before any exit that follows a publish (WI-10005311)', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const bootstrap = script.indexOf('staging_alias_bootstrap || {');
    expect(bootstrap).toBeGreaterThan(-1);
    const firstNoOp = script.indexOf('already at ${target:0:10} — no-op', bootstrap);
    const prepare = script.indexOf('prepare_staging_candidate "$target"', bootstrap);
    expect(firstNoOp).toBeGreaterThan(bootstrap);
    expect(prepare).toBeGreaterThan(bootstrap);
    const startPrune = script.indexOf('\nprune_staging_generations\n', bootstrap);
    expect(startPrune).toBeGreaterThan(bootstrap);
    expect(startPrune).toBeLessThan(Math.min(firstNoOp, prepare));
  });

  it('finishes a verified cutover without letting cleanup turn success into failure', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const healthy = script.indexOf('log "✅ :3170 healthy on exact staging source');
    expect(healthy).toBeGreaterThan(-1);
    const exitAfterHealthy = script.indexOf('exit 0', healthy);
    expect(exitAfterHealthy).toBeGreaterThan(healthy);
    // Execute the shipped success branch with a failing cleanup sentinel. The
    // next timer tick's existing GC handles superseded generations; it must
    // not consume the update's remaining systemd startup budget after health.
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'last_health_sha=0123456789abcdef',
      'log() { printf "%s\\n" "$*"; }',
      'prune_staging_generations() { echo UNEXPECTED_POST_HEALTH_GC >&2; exit 91; }',
      script.slice(healthy, exitAfterHealthy + 'exit 0'.length),
    ].join('\n')], { encoding: 'utf8', timeout: 2_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('healthy on exact staging source 0123456789abcdef');
    expect(result.stderr).not.toContain('UNEXPECTED_POST_HEALTH_GC');
  });
});

describe('sync-staging-checkout.sh names the unmet publication condition (EI-24867768475421999)', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  let root = '';
  let home = '';
  let checkout = '';

  function reason(requireHostBundle: 0 | 1): string {
    const r = runFn(
      ['staging_candidate_unready_reason'],
      'staging_candidate_unready_reason "$CANDIDATE_ROOT" "$CANDIDATE_HOME" "$TARGET_SHA" "$REQUIRE"',
      {
        env: {
          CANDIDATE_ROOT: checkout,
          CANDIDATE_HOME: home,
          TARGET_SHA: sha,
          REQUIRE: String(requireHostBundle),
        },
      },
    );
    expect(r.status).toBe(0);
    return r.stdout.trim();
  }

  function writeComplete(): void {
    mkdirSync(join(checkout, 'apps/operator-vite/dist'), { recursive: true });
    mkdirSync(join(checkout, 'apps/operator/dist-host'), { recursive: true });
    writeFileSync(join(home, '.ready'), sha + '\n');
    writeFileSync(join(checkout, 'apps/operator-vite/dist/index.html'), '<html></html>');
    writeFileSync(join(checkout, 'apps/operator/dist-host/hono-host.mjs'), 'export {};');
    writeFileSync(join(checkout, 'apps/operator/dist-host/.bundle-fresh.json'), '{}');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'staging-unready-reason-'));
    home = join(root, '.candidate-x');
    checkout = join(home, 'checkout');
    mkdirSync(checkout, { recursive: true });
    writeComplete();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prints nothing for a complete candidate (calibration: the real ready case passes)', () => {
    expect(reason(1)).toBe('');
    expect(reason(0)).toBe('');
  });

  it('names a missing freshness proof, the condition behind the 2026-10-02 11:38Z refusal', () => {
    rmSync(join(checkout, 'apps/operator/dist-host/.bundle-fresh.json'));
    expect(reason(1)).toMatch(/^host bundle freshness proof missing: .*\.bundle-fresh\.json/);
    expect(reason(0)).toBe('');
  });

  it('names a .ready mismatch with both values', () => {
    writeFileSync(join(home, '.ready'), 'f'.repeat(40) + '\n');
    expect(reason(1)).toContain(`holds ${'f'.repeat(40)}, expected ${sha}`);
    rmSync(join(home, '.ready'));
    expect(reason(1)).toContain(`holds <missing>, expected ${sha}`);
  });

  it('names a missing SPA dist, a missing host bundle, and a stale marker', () => {
    writeFileSync(join(checkout, 'apps/operator/dist-host/.bundle-stale.json'), '{}');
    expect(reason(1)).toMatch(/^host bundle is marked stale/);
    expect(reason(0)).toBe('');
    rmSync(join(checkout, 'apps/operator/dist-host/hono-host.mjs'));
    expect(reason(1)).toMatch(/^host bundle missing or empty/);
    rmSync(join(checkout, 'apps/operator-vite/dist/index.html'));
    expect(reason(0)).toMatch(/^SPA dist missing or empty/);
  });
});

describe('sync-staging-checkout.sh staging unit generation contract (WI-10003262)', () => {
  it('accepts the stable alias for SPA and bundle paths while runtime readers use the physical root', () => {
    const alias = '/tmp/papercusp-staging.current';
    expect(stagingUnitGuardResult(alias).status).toBe(0);
    expect(stagingUnitGuardResult(alias, {
      environment: 'PAPERCUSP_INTEGRATION_ROOT=/tmp/papercusp-staging PAPERCUSP_SPA_DIST=/tmp/papercusp-staging.current/apps/operator-vite/dist PAPERCUSP_BUNDLE_REUSE_FRESH=1',
    }).status).not.toBe(0);
    expect(stagingUnitGuardResult(alias, {
      execStart: 'set -a; [ -f .env.local ] && . ./.env.local; set +a; exec node dist-host/hono-host.mjs',
    }).status).not.toBe(0);
  });

  it('keeps both versioned drop-ins on the stable alias and pins the runtime root physically', () => {
    const dropinDir = join(__dirname, '../../scripts/systemd/papercup-staging-api.service.d');
    const checkout = readFileSync(join(dropinDir, '50-staging-checkout.conf'), 'utf8');
    const bundle = readFileSync(join(dropinDir, '95-bundled-entry.conf'), 'utf8');
    expect(checkout).toContain('WorkingDirectory=%h/papercupai-workspace/papercusp-staging.current/apps/operator');
    expect(checkout).toContain('Environment=PAPERCUSP_INTEGRATION_ROOT=%h/papercupai-workspace/papercusp-staging.current');
    expect(checkout).toContain('Environment=PAPERCUSP_SPA_DIST=%h/papercupai-workspace/papercusp-staging.current/apps/operator-vite/dist');
    expect(bundle).toContain('root="%h/papercupai-workspace/papercusp-staging.current"');
    expect(bundle).toContain('"$$root/apps/operator/bin/bundle-host.sh"');
    expect(bundle).toContain('PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)"');
  });
});

describe('sync-staging-checkout.sh runtime source identity (EI-22636310973765418)', () => {
  it('accepts the short SHA baked into the exact target commit', () => {
    expect(healthMatchesTarget('6370b7fa98', '6370b7fa98c4f2d54f3a2d968e0137a9fd5d8a3a')).toBe(true);
  });

  it('rejects a healthy process serving any other commit', () => {
    expect(healthMatchesTarget('6370b7fa98', 'a5de12953b978f6e5f7fe58b891e7d4d8fd7d3fc')).toBe(false);
    expect(healthMatchesTarget('', 'a5de12953b978f6e5f7fe58b891e7d4d8fd7d3fc')).toBe(false);
  });
});

describe('sync-staging-checkout.sh paths_require_restart() — restart relevance gate (WI-5710)', () => {
  describe('restart-EXEMPT advances (the whole point: no process kill)', () => {
    it('SPA source under apps/operator-vite/src only', () => {
      expect(requiresRestart(['apps/operator-vite/src/main.tsx'])).toBe(false);
    });

    it('SPA components under apps/operator/app only (compiled in via vite `@` alias)', () => {
      // Verified tree-wide that no server module imports from apps/operator/app.
      expect(
        requiresRestart(['apps/operator/app/adv/hud/HudBoard.tsx', 'apps/operator/app/adv/hud/hud.css']),
      ).toBe(false);
    });

    it('prose only — .md / .mdx / docs trees', () => {
      expect(
        requiresRestart([
          'docs/plans/some-plan.md',
          'apps/operator/public/internal/docs/agent-insights/x.md',
          'apps/operator-docs/src/content/docs/system/y.mdx',
        ]),
      ).toBe(false);
    });

    it('tests only — they never run inside the operator process', () => {
      expect(
        requiresRestart([
          'packages/operator-core/lib/a.test.ts',
          'apps/operator/app/adv/hud/HudBoard.test.tsx',
          'apps/operator/e2e/b.spec.ts',
          'packages/operator-core/lib/__tests__/c.ts',
        ]),
      ).toBe(false);
    });

    it('the papercusp-desktop submodule pointer (the Tauri shell embeds the operator, never the reverse)', () => {
      expect(requiresRestart(['papercusp-desktop'])).toBe(false);
    });

    it('a realistic mixed SPA + docs + tests commit', () => {
      expect(
        requiresRestart([
          'apps/operator/app/adv/hud/HudView.tsx',
          'apps/operator/app/adv/hud/HudBoard.test.tsx',
          'docs/plans/hud.md',
          'papercusp-desktop',
        ]),
      ).toBe(false);
    });
  });

  describe('restart-REQUIRED advances', () => {
    it('drains a streamed diff after finding a server path so pipefail cannot skip the restart', () => {
      const root = mkdtempSync(join(tmpdir(), 'sync-streamed-diff-'));
      const pathList = join(root, 'paths');
      try {
        const inertPaths = Array.from({ length: 20000 }, (_, i) => `docs/generated/page-${i}.md`);
        writeFileSync(pathList, ['packages/operator-core/lib/release/admission-fix-precheck-managed.ts', ...inertPaths].join('\n') + '\n');
        const result = runFn(['path_needs_no_restart', 'paths_require_restart'], 'cat "$DIFF_PATHS" | paths_require_restart', {
          env: { DIFF_PATHS: pathList },
        });
        expect(result.status, result.stderr).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('keeps a large streamed diff of only inert paths restart-exempt', () => {
      const root = mkdtempSync(join(tmpdir(), 'sync-streamed-diff-'));
      const pathList = join(root, 'paths');
      try {
        writeFileSync(pathList, Array.from({ length: 20000 }, (_, i) => `docs/generated/page-${i}.md`).join('\n') + '\n');
        const result = runFn(['path_needs_no_restart', 'paths_require_restart'], 'cat "$DIFF_PATHS" | paths_require_restart', {
          env: { DIFF_PATHS: pathList },
        });
        expect(result.status, result.stderr).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('server code under packages/operator-core', () => {
      expect(requiresRestart(['packages/operator-core/lib/agent-tools/index.ts'])).toBe(true);
    });

    it('server code under apps/operator/lib (NOT apps/operator/app — the one-word difference that flips it)', () => {
      expect(requiresRestart(['apps/operator/lib/release/green-checkpoint.ts'])).toBe(true);
    });

    it('the libs/papercusp submodule pointer (harness/db/blueprints — real server code)', () => {
      expect(requiresRestart(['libs/papercusp'])).toBe(true);
    });

    it('ONE server path poisons an otherwise-exempt set (all-or-nothing, not majority-vote)', () => {
      expect(
        requiresRestart([
          'apps/operator-vite/src/main.tsx',
          'docs/plans/x.md',
          'packages/operator-core/lib/sync-sse.ts', // the only non-exempt entry
        ]),
      ).toBe(true);
    });

    it('flags / lockfiles / CI config are not exempt', () => {
      expect(requiresRestart(['libs/flags/src/types.ts'])).toBe(true);
      expect(requiresRestart(['package.json'])).toBe(true);
    });
  });

  describe('FAIL-SAFE DIRECTION — the property a future edit must never invert', () => {
    it('an UNKNOWN/new path shape falls through to a restart (never silently skipped)', () => {
      expect(requiresRestart(['some/brand/new/server-dir/thing.ts'])).toBe(true);
    });

    it('an EMPTY path list means "could not establish what changed" ⇒ restart, not "nothing changed" ⇒ skip', () => {
      // The caller no-ops on an unmoved HEAD long before this, so reaching here
      // with no paths means the diff failed — the dangerous case to get wrong.
      expect(requiresRestart([])).toBe(true);
    });

    it('a .ts file that merely LIVES beside exempt files is still a restart', () => {
      expect(requiresRestart(['apps/operator-vite/vite.config.ts'])).toBe(true);
    });

    it('a docs-LOOKING path that is actually code is still a restart', () => {
      expect(requiresRestart(['packages/operator-core/lib/docs-tool.ts'])).toBe(true);
    });
  });
});

describe('sync-staging-checkout.sh current_commit_age_sec() — deferral staleness ceiling (WI-5710)', () => {
  let repo: string;
  let sha: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    }).trim();

  /** Commit with a controlled COMMITTER date — the script reads %ct, not %at. */
  const gitCommitAt = (epoch: number, msg: string) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: `@${epoch} +0000`,
          GIT_AUTHOR_DATE: `@${epoch} +0000`,
        },
      },
    );

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'sync-age-')));
    git('init', '-q');
    writeFileSync(join(repo, 'f.txt'), 'v1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    sha = git('rev-parse', 'HEAD');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function age(shaArg: string): number {
    const r = runFn(['current_commit_age_sec'], `current_commit_age_sec "${shaArg}"`, {
      env: { INTEGRATION_ROOT: repo },
    });
    expect(r.status).toBe(0);
    return Number(r.stdout.trim());
  }

  function restartDecision(current: string, health: string, target: string): number {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('if [ "$target" = "$current" ]; then');
    const end = script.indexOf('# WI-5710 gate 2', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const result = runFn(['health_sha_matches_target', 'path_needs_no_restart', 'paths_require_restart'],
      `log() { :; }\n${script.slice(start, end)}\nprintf '%s\\n' "$restart_required"`, {
        env: { INTEGRATION_ROOT: repo, current, health_sha: health, served_sha: health || current, target },
      });
    expect(result.status, result.stderr).toBe(0);
    return Number(result.stdout.trim());
  }

  function serverThenDocs(): { served: string; checkout: string; target: string } {
    const served = sha;
    writeFileSync(join(repo, 'f.txt'), 'server-v2');
    git('add', '-A');
    git('commit', '-q', '-m', 'server');
    const checkout = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'guide.md'), 'docs');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs');
    return { served, checkout, target: git('rev-parse', 'HEAD') };
  }

  it('diffs from the served source so a later docs-only advance cannot hide a pending server restart', () => {
    const { served, checkout, target } = serverThenDocs();
    expect(restartDecision(checkout, served.slice(0, 10), target)).toBe(1);
  });

  it('requires a restart when the served source diff cannot be resolved', () => {
    const { checkout, target } = serverThenDocs();
    expect(restartDecision(checkout, 'f'.repeat(40), target)).toBe(1);
  });

  it('requires a restart when health provides no serving source identity', () => {
    const { checkout, target } = serverThenDocs();
    expect(restartDecision(checkout, '', target)).toBe(1);
  });

  it('keeps a docs-only advance exempt when the process already holds the server source', () => {
    const { checkout, target } = serverThenDocs();
    expect(restartDecision(checkout, checkout.slice(0, 10), target)).toBe(0);
  });

  it('a just-made commit reports a near-zero age (so a live session IS deferred for)', () => {
    const a = age(sha);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(120);
  });

  it('an OLD commit reports a large age (so the ceiling fires and the restart lands)', () => {
    const oldEpoch = Math.floor(Date.now() / 1000) - 7200; // 2h ago
    writeFileSync(join(repo, 'f.txt'), 'v2');
    git('add', '-A');
    gitCommitAt(oldEpoch, 'old');
    const oldSha = git('rev-parse', 'HEAD');
    expect(age(oldSha)).toBeGreaterThan(3600);
  });

  it('the literal "none" (a fresh checkout) reports a huge age — never defers a first sync', () => {
    expect(age('none')).toBeGreaterThan(100000);
  });

  it('an UNRESOLVABLE sha reports a huge age (fail-safe: forces the restart, never an infinite defer)', () => {
    expect(age('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeGreaterThan(100000);
  });
});

describe('sync-staging-checkout.sh staging_live_client_count() — live-session probe (WI-5710)', () => {
  let server: Server | undefined;
  let sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
    server = undefined;
  });

  function count(port: number): number {
    const r = runFn(['staging_live_client_count'], `staging_live_client_count ${port}`, {
      env: { STAGING_PORT: String(port) },
    });
    expect(r.status).toBe(0);
    return Number(r.stdout.trim());
  }

  const haveSs = spawnSync('ss', ['-V'], { encoding: 'utf8' }).status === 0;

  it('reports 0 for a port nobody is connected to', () => {
    if (!haveSs) return; // no iproute2 (CI container) — the function fail-softs to 0 anyway
    // A port with no listener at all: no ESTABLISHED sockets can exist on it.
    expect(count(59_431)).toBe(0);
  });

  it('reports >0 while a client holds an ESTABLISHED connection (the SSE-session signal)', async () => {
    if (!haveSs) return;
    const port = await new Promise<number>((res) => {
      server = createServer((s) => {
        sockets.push(s);
      });
      server.listen(0, '127.0.0.1', () => {
        res((server!.address() as { port: number }).port);
      });
    });
    // Hold two long-lived connections open, like two live operator windows.
    await Promise.all(
      [0, 1].map(
        () =>
          new Promise<void>((res) => {
            const c = connect(port, '127.0.0.1', () => res());
            sockets.push(c);
          }),
      ),
    );
    expect(count(port)).toBeGreaterThan(0);
  });

  it('drops back to 0 once the clients disconnect (so an idle :3170 restarts promptly)', async () => {
    if (!haveSs) return;
    const port = await new Promise<number>((res) => {
      server = createServer((s) => {
        sockets.push(s);
      });
      server.listen(0, '127.0.0.1', () => {
        res((server!.address() as { port: number }).port);
      });
    });
    await new Promise<void>((res) => {
      const c = connect(port, '127.0.0.1', () => res());
      sockets.push(c);
    });
    expect(count(port)).toBeGreaterThan(0);
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise((r) => setTimeout(r, 250));
    expect(count(port)).toBe(0);
  });
});

describe('sync-staging-checkout.sh coordinated restart result', () => {
  const legacyPending = {
    ok: true, target: 'staging', restarted: false, restartScheduled: true, restartObserved: false,
    restartRequestId: 'ec0c414f-34f4-44c0-ac0b-84a8169a092e', requestAuditPersisted: true,
  };
  const pending = (result: unknown) => runFn(
    ['restart_result_is_pending'],
    'restart_result_is_pending',
    { input: JSON.stringify(result) },
  ).status === 0;

  it('waits for a scheduled unobserved staging restart without calling it accepted', () => {
    const result = {
      ok: false, target: 'staging', restarted: false,
      restartScheduled: true, restartObserved: false,
      stagingReadiness: { ready: false, outcome: 'not-observed', activeState: 'deactivating' },
    };
    expect(pending(result)).toBe(true);
    expect(accepted(result)).toBe(false);
    expect(pending({ ...result, restartScheduled: false })).toBe(false);
    expect(pending({ ...result, target: 'gateway' })).toBe(false);
    expect(pending({ ...result, stagingReadiness: { outcome: 'failed', activeState: 'failed' } })).toBe(false);
    expect(pending({ ok: false, reason: 'restart_withheld' })).toBe(false);
  });

  it('reconciles an audited legacy asynchronous receipt without treating it as completion', () => {
    expect(pending(legacyPending)).toBe(true);
    expect(accepted(legacyPending)).toBe(false);
  });

  it.each([
    { ok: false }, { target: 'gateway' }, { restartScheduled: false }, { restartObserved: true },
    { requestAuditPersisted: false }, { restartRequestId: undefined }, { restartRequestId: '' },
    { restartRequestId: ' ' }, { reason: 'restart_withheld' }, { error: 'authorization_denied' },
    { stagingReadiness: null }, { stagingReadiness: { outcome: 'failed', activeState: 'failed' } },
  ])('refuses an incomplete or contradictory legacy receipt: %j', override => {
    expect(pending({ ...legacyPending, ...override })).toBe(false);
  });

  it('keeps launcher stderr out of the JSON receipt on the actual request path', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const start = script.indexOf('(\n  cd "$INTEGRATION_ROOT"', script.indexOf('restart_result_file='));
    const end = script.indexOf('\nrestart_tool_pid=$!', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dir = mkdtempSync(join(tmpdir(), 'staging-restart-receipt-'));
    try {
      const cli = join(dir, 'ptool');
      writeFileSync(cli, '#!/bin/sh\necho "ptool launcher" >&2\necho \'{"ok":true,"restarted":true}\'\n', { mode: 0o700 });
      const r = spawnSync('bash', ['-c', [
        'set -eu',
        'restart_result_file="$INTEGRATION_ROOT/result"',
        'restart_diagnostics_file="$INTEGRATION_ROOT/diagnostics"',
        script.slice(start, end),
        'wait $!',
        'cat "$restart_result_file"',
      ].join('\n')], {
        encoding: 'utf8',
        env: { ...process.env, INTEGRATION_ROOT: dir, PTOOL_CLIENT_SID: 'test-client', PTOOL_BIN: cli,
          STAGING_PORT: '3170', RESTART_CONTROL_URL: 'http://127.0.0.1:3170',
          GIT_SYNC_DRAIN_SEC: '45', current: '12345678', target: 'abcdef12' },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, restarted: true });
      expect(readFileSync(join(dir, 'diagnostics'), 'utf8')).toContain('ptool launcher');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['current', 'legacy'])('settles a %s pending receipt only after a new PID serves the exact target', kind => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const tail = script.slice(script.indexOf('# ptool exits successfully for a business-level refusal'));
    const result = JSON.stringify(kind === 'legacy' ? legacyPending : {
      ok: false, target: 'staging', restartScheduled: true,
      restartObserved: false, stagingReadiness: { outcome: 'not-observed', activeState: 'deactivating' } });
    const verify = (pid: string, sha: string, receipt = result) => runFn(
      ['restart_result_is_accepted', 'restart_result_is_pending', 'restart_result_is_pre_dispatch_refusal',
        'restart_refusal_is_transient_git_sync', 'health_sha_matches_target', 'staging_restart_is_observed'],
      [
        'log() { printf "%s\\n" "$*"; }',
        'staging_health_source_sha() { printf "%s" "$TEST_SHA"; }',
        'systemctl() { printf "%s" "$TEST_PID"; }',
        'sleep() { :; }',
        tail,
      ].join('\n'),
      { env: { restart_verified: '0', restart_tool_status: '0', restart_pending: '0',
        restart_result: receipt, restart_diagnostics: '', main_pid: '100', target: 'abcdef123456',
        UNIT: 'fixture.service', READINESS_TIMEOUT_SEC: '1', TEST_PID: pid, TEST_SHA: sha } },
    );
    expect(verify('101', 'abcdef1234').status).toBe(0);
    expect(verify('100', 'abcdef1234').status).toBe(1);
    expect(verify('101', 'deadbeef').status).toBe(1);
    expect(verify('101', 'abcdef1234', JSON.stringify({ ok: false, reason: 'restart_withheld' })).status).toBe(1);
  });

  it('reports a delivered stderr drain refusal without waiting for target health', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const tail = script.slice(script.indexOf('# ptool exits successfully for a business-level refusal'));
    const connectionTrace = 'operator-connect-trace '.repeat(180);
    const result = runFn(
      ['restart_result_is_accepted', 'restart_result_is_pending', 'restart_result_is_pre_dispatch_refusal',
        'restart_refusal_is_transient_git_sync', 'health_sha_matches_target', 'staging_restart_is_observed'],
      [
        'log() { printf "%s\\n" "$*"; }',
        'staging_health_source_sha() { echo UNEXPECTED_HEALTH_PROBE; }',
        tail,
      ].join('\n'),
      { env: { restart_verified: '0', restart_tool_status: '1', restart_pending: '0', restart_result: '',
        restart_diagnostics: 'ptool launcher\n✗ tool returned an error:\n' + JSON.stringify({
          ok: false, reason: 'resource_drain_timeout', resource: 'staging-server',
          holders: [{ owner: 'fixture-holder', mode: 'shared' }],
        }, null, 2) + '\n' + connectionTrace } },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('resource drain was refused; no restart scheduled');
    expect(result.stdout).toContain('"reason": "resource_drain_timeout"');
    expect(result.stdout).toContain('fixture-holder');
    expect(result.stdout).toContain('operator-connect-trace');
    expect(result.stdout).not.toContain('UNEXPECTED_HEALTH_PROBE');
    expect(result.stdout).not.toContain('no terminal receipt');
  });

  const accepted = (result: unknown) => runFn(
    ['restart_result_is_accepted'],
    'restart_result_is_accepted',
    { input: typeof result === 'string' ? result : JSON.stringify(result) },
  ).status === 0;

  it('accepts only a real restart or a verified coalesce', () => {
    expect(accepted({ ok: true, restarted: true })).toBe(true);
    expect(accepted({ ok: true, restarted: false, coalesced: true, verified: true })).toBe(true);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: true,
        stagingReadiness: { ready: false, outcome: 'starting' },
      }),
    ).toBe(true);
    expect(accepted({ ok: false, reason: 'restart_withheld' })).toBe(false);
    expect(accepted({ ok: true, restarted: false, coalesced: false })).toBe(false);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: false,
        stagingReadiness: { ready: false, outcome: 'starting' },
      }),
    ).toBe(false);
    expect(
      accepted({
        ok: true,
        restarted: false,
        restartScheduled: true,
        restartObserved: true,
        stagingReadiness: { ready: false, outcome: 'failed' },
      }),
    ).toBe(false);
    expect(accepted('not-json')).toBe(false);
  });
});

describe('sync-staging-checkout.sh coordinated restart identity (EI-24077446541707229)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'staging-sync-identity-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const resolve = (home: string, sid = '') => runFn(
    ['resolve_ptool_client_sid'],
    'resolve_ptool_client_sid',
    { env: { HOME: home, PAPERCUSP_SID: sid } },
  );

  it('uses the installed machine identity when a systemd invocation has no session SID', () => {
    mkdirSync(join(home, '.papercusp'));
    const machineSid = '43279960-9a3b-4b55-80d3-44110bf48834';
    writeFileSync(join(home, '.papercusp', 'su-agent-id'), `${machineSid}\n`, { mode: 0o600 });
    expect(resolve(home)).toMatchObject({ status: 0, stdout: `${machineSid}\n`, stderr: '' });
  });

  it('preserves an explicit agent session SID without reading the machine file', () => {
    expect(resolve(home, 'su-real-session')).toMatchObject({ status: 0, stdout: 'su-real-session\n' });
  });

  it('fails closed when the machine identity is missing or malformed', () => {
    expect(resolve(home).status).not.toBe(0);
    mkdirSync(join(home, '.papercusp'));
    writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'not-a-uuid\n');
    expect(resolve(home).status).not.toBe(0);
  });

  it('passes the resolved identity to the audited dev:restart call', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain('PTOOL_CLIENT_SID="$(resolve_ptool_client_sid)"');
    expect(script).toContain('PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url="$RESTART_CONTROL_URL" --json -');
    expect(script).not.toContain('"$PTOOL_BIN" dev:restart --json -');
  });

  it('downgrades its checkout lock before the final dev:restart so the staging collision guard admits cutover', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const downgrade = script.lastIndexOf('staging_sync_lock_shared');
    const restart = script.indexOf('exec env PAPERCUSP_SID="$PTOOL_CLIENT_SID" "$PTOOL_BIN" dev:restart --url=');
    const assignment = script.lastIndexOf('PTOOL_CLIENT_SID="$(resolve_ptool_client_sid)"');
    const downgradeEnd = script.indexOf('\n# The ptool result may be lost', downgrade);
    expect(downgrade).toBeGreaterThan(assignment);
    expect(restart).toBeGreaterThan(downgrade);
    expect(downgradeEnd).toBeGreaterThan(downgrade);
    expect(script.slice(downgrade, downgradeEnd)).toContain('could not downgrade');
  });

  it('preserves a busy checkout lock when its coprocess exits before repeated cleanup', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helperStart = script.indexOf('# Keep the checkout flock in a dedicated coprocess.');
    const helperEnd = script.indexOf('staging_alias_bootstrap()', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = script.slice(helperStart, helperEnd);
    const dir = mkdtempSync(join(tmpdir(), 'staging-lock-busy-'));
    const lock = join(dir, 'checkout.lock');
    try {
      const r = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        helper,
        `STAGING_SYNC_LOCK_PATH=${JSON.stringify(lock)}`,
        'exec 8>"$STAGING_SYNC_LOCK_PATH"',
        'flock -n 8',
        'if staging_sync_lock_start; then echo unexpected_acquisition; exit 90; else status=$?; fi',
        'printf "start_status=%s\\n" "$status"',
        'staging_sync_lock_release',
        'staging_sync_lock_release',
        'if flock -n "$STAGING_SYNC_LOCK_PATH" -c true; then echo owner_lock=lost; exit 91; else echo owner_lock=held; fi',
        'flock -u 8',
        'flock -n "$STAGING_SYNC_LOCK_PATH" -c true',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
      expect(r.error).toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('start_status=75');
      expect(r.stdout).toContain('owner_lock=held');
      expect(r.stderr).not.toContain('unbound variable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up idempotently after Bash has reaped the lock keeper', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helperStart = script.indexOf('# Keep the checkout flock in a dedicated coprocess.');
    const helperEnd = script.indexOf('staging_alias_bootstrap()', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = script.slice(helperStart, helperEnd);
    const dir = mkdtempSync(join(tmpdir(), 'staging-lock-reaped-'));
    const lock = join(dir, 'checkout.lock');
    try {
      const r = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        helper,
        `STAGING_SYNC_LOCK_PATH=${JSON.stringify(lock)}`,
        'staging_sync_lock_start',
        'keeper="$STAGING_SYNC_LOCK_KEEPER_PID"',
        'kill "$keeper"',
        'wait "$keeper" 2>/dev/null || true',
        '[[ ! -v STAGING_SYNC_LOCK_KEEPER_PID ]]',
        'staging_sync_lock_release',
        'staging_sync_lock_release',
        'flock -n "$STAGING_SYNC_LOCK_PATH" -c true',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
      expect(r.error).toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toContain('unbound variable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the staging lock out of child processes', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helperStart = script.indexOf('# Keep the checkout flock in a dedicated coprocess.');
    const helperEnd = script.indexOf('staging_alias_bootstrap()', helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = script.slice(helperStart, helperEnd);
    const lock = join(tmpdir(), `staging-lock-keeper-${process.pid}-${Date.now()}.lock`);
    try {
      const r = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        helper,
        `STAGING_SYNC_LOCK_PATH=${JSON.stringify(lock)}`,
        'STAGING_SYNC_LOCK_OWNER_PID="$$"',
        'staging_sync_lock_start',
        '(sleep 2) & child=$!',
        'staging_sync_lock_release',
        `if flock -n ${JSON.stringify(lock)} -c true; then echo lock_after_keeper_release=free; else echo lock_after_keeper_release=held; fi`,
        'wait "$child"',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('lock_after_keeper_release=free');
    } finally {
      rmSync(lock, { force: true });
      rmSync(`${lock}.writer`, { force: true });
    }
  });

  it('accepts a lost self-restart receipt only after a new MainPID serves the exact target SHA', () => {
    const target = '0123456789abcdef0123456789abcdef01234567';
    expect(restartIsObserved('470360', '471002', '0123456789ab', target)).toBe(true);
    expect(restartIsObserved('470360', '470360', '0123456789ab', target)).toBe(false);
    expect(restartIsObserved('470360', '471002', 'deadbeef00', target)).toBe(false);
    expect(restartIsObserved('0', '471002', '0123456789ab', target)).toBe(true);
  });

  it('fails fast on the original no-launch-record auth refusal but not an unknown timeout', () => {
    expect(isPreDispatchRestartRefusal('authorization_denied: identity no-launch-record')).toBe(true);
    expect(isPreDispatchRestartRefusal('MCP error -32001: Request timed out; outcome=unknown')).toBe(false);
  });

  it('watches the verified restart while ptool runs and bounds the self-restart response wait', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain('restart_tool_timeout_sec=350');
    expect(script).toContain('while staging_sync_process_running "$restart_tool_pid"; do');
    expect(script).toContain('staging_restart_is_observed "$main_pid" "$observed_main_pid" "$observed_health_sha" "$target"');
    expect(script).toContain('terminating only the ptool client');
  });
});

describe('sync-staging-checkout.sh completed-phase startup budget (WI-10006606)', () => {
  function prepareWithOutput(output: string, status = 0) {
    const candidate = mkdtempSync(join(tmpdir(), 'staging-phase-candidate-'));
    mkdirSync(join(candidate, 'apps/operator'), { recursive: true });
    try { return runFn(['staging_sync_checkpoint', 'copy_staging_runtime_environment', 'prepare_staging_candidate'], [
      'INTEGRATION_ROOT=/unused-staging-test',
      'STAGING_ROOT=/absent-staging-test',
      'LEGACY_STAGING_ROOT=/absent-legacy-staging-test',
      'create_staging_candidate() { STAGING_CANDIDATE_ROOT="$TEST_CANDIDATE"; }',
      'log() { printf "%s\\n" "$*"; }',
      'timeout() { printf "BOUND:%s\\n" "$*"; shift 2; "$@"; }',
      'bash() { printf "%s\\n" "$SETUP_OUTPUT"; return "$SETUP_STATUS"; }',
      'systemd-notify() { printf "NOTIFY:%s\\n" "$*"; }',
      'prepare_staging_candidate 0123456789abcdef',
    ].join('\n'), { env: { NOTIFY_SOCKET: '@test-staging-notify', SETUP_OUTPUT: output, SETUP_STATUS: String(status), TEST_CANDIDATE: candidate, PAPERCUSP_HOME: join(candidate, 'private-home') } });
    } finally { rmSync(candidate, { recursive: true, force: true }); }
  }

  it('runs source, dependency and SPA preparation under separate finite command deadlines', () => {
    const sourceReady = '[setup-release] submodule recursion: cloned=2 archive-fallback=0 tracked plain=5 recursive=8 uninitialized=0';
    const spaStart = '[setup-release] building operator-vite SPA dist at the deployed sha (this can take a minute)';
    const result = prepareWithOutput([sourceReady, 'DEPENDENCIES', spaStart, 'SPA_FINISHED'].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(sourceReady);
    expect(result.stdout).toContain(spaStart);
    const bounds = result.stdout.split('\n').filter((line) => line.startsWith('BOUND:'));
    expect(bounds).toHaveLength(3);
    expect(bounds.every((line) => line.startsWith('BOUND:--kill-after=10s 900s bash '))).toBe(true);
    expect(bounds[0]).toContain('--source-only');
    expect(bounds[1]).toContain('--prepare-existing');
    expect(bounds[2]).toContain('--spa-only');
    expect(result.stdout).not.toContain('EXTEND_TIMEOUT_USEC');
  });

  it('does not renew the deadline for arbitrary build output', () => {
    const result = prepareWithOutput('still building\nchunk 1\nchunk 2');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('still building\nchunk 1\nchunk 2');
    expect(result.stdout).not.toContain('EXTEND_TIMEOUT_USEC');
  });

  it('terminates a stalled real setup child before dependencies, SPA or publication', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'staging-phase-deadline-'));
    const scripts = join(fixture, 'apps/operator/scripts/systemd');
    const setup = join(fixture, 'apps/operator/bin/release');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(setup, { recursive: true });
    writeFileSync(join(scripts, 'papercusp-script-snapshot.sh'), 'exec bash "$@"\n');
    writeFileSync(join(setup, 'setup-release-checkout.sh'), 'echo SETUP_ENTERED\nsleep 30\n');
    try {
      const result = runFn(['staging_sync_checkpoint', 'prepare_staging_candidate'], [
        'STAGING_ROOT=/absent-staging-test',
        'create_staging_candidate() { STAGING_CANDIDATE_ROOT=/unused-candidate; }',
        'log() { printf "%s\\n" "$*"; }',
        // Accelerate only the fixture duration; run the real GNU timeout and child group.
        'timeout() { printf "BOUND:%s\\n" "$*"; shift 2; command timeout --kill-after=1s 1s "$@"; }',
        'prepare_staging_candidate 0123456789abcdef',
      ].join('\n'), { env: { INTEGRATION_ROOT: fixture, NOTIFY_SOCKET: '', PAPERCUSP_HOME: join(fixture, 'private-home') } });
      expect(result.status).toBe(124);
      expect(result.stdout).toContain('SETUP_ENTERED');
      expect(result.stdout).toContain('failed in --source-only');
      expect(result.stdout).toContain('exit 124');
      expect(result.stdout.split('\n').filter((line) => line.startsWith('BOUND:'))).toHaveLength(1);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('stops before later phases and publication on a setup failure', () => {
    const result = prepareWithOutput('[setup-release] source failure', 17);
    expect(result.status).toBe(17);
    expect(result.stdout).toContain('candidate checkout preparation failed');
    expect(result.stdout).toContain('exit 17');
    expect(result.stdout.split('\n').filter((line) => line.startsWith('BOUND:'))).toHaveLength(1);
    expect(result.stdout).not.toContain('--ready');
  });

  it('reports a completed phase without making its deadline depend on systemd notifications', () => {
    const result = runFn(['staging_sync_checkpoint'], [
      'systemd-notify() { printf "%s\\n" "$*"; }',
      'staging_sync_checkpoint "candidate checkout and SPA prepared"',
    ].join('\n'), { env: { NOTIFY_SOCKET: '@test-staging-notify' } });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('EXTEND_TIMEOUT_USEC');
    expect(result.stdout).toContain('candidate checkout and SPA prepared');
    expect(result.stdout).not.toContain('--ready');
  });

  it('does not require a systemd notification socket for direct invocations', () => {
    const result = runFn(['staging_sync_checkpoint'], [
      'systemd-notify() { echo UNEXPECTED_NOTIFY; exit 91; }',
      'staging_sync_checkpoint "candidate prepared"',
    ].join('\n'), { env: { NOTIFY_SOCKET: '' } });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('UNEXPECTED_NOTIFY');
  });

  it.each([0, 17])('preserves exit %i and completes an inherited notify contract only on success', (status) => {
    const result = runFn(['finish_staging_sync'], [
      'cleanup_staging_candidate() { echo CLEANED; }',
      'systemd-notify() { printf "%s\\n" "$*"; }',
      'trap finish_staging_sync EXIT',
      `exit ${status}`,
    ].join('\n'), { env: { NOTIFY_SOCKET: '@test-staging-notify' } });
    expect(result.status).toBe(status);
    expect(result.stdout).toContain('CLEANED');
    expect(result.stdout.includes('--ready')).toBe(status === 0);
  });

  it('preserves a diagnostic notification failure', () => {
    const result = runFn(['staging_sync_checkpoint'], [
      'systemd-notify() { return 42; }',
      'staging_sync_checkpoint "candidate prepared"',
    ].join('\n'), { env: { NOTIFY_SOCKET: '@test-staging-notify' } });
    expect(result.status).toBe(42);
  });

  it('starts the snapshot worker at exec with an aggregate runtime backstop', () => {
    const dropIn = readFileSync(join(__dirname, '../../scripts/systemd/papercup-staging-sync.service.d/50-script-snapshot.conf'), 'utf8');
    expect(dropIn).toContain('Type=exec');
    expect(dropIn).not.toContain('Type=notify');
    expect(dropIn).toContain('RuntimeMaxSec=90min');
    expect(dropIn).toContain('TimeoutStartSec=15min');
    expect(readFileSync(SCRIPT_PATH, 'utf8')).toContain('trap finish_staging_sync EXIT');
  });
});

describe('failed candidate cleanup deadline (EI-26814541123294753)', () => {
  it.each(['git', 'rm'])('releases the publication lease when %s cleanup stalls and retries later', (slow) => {
    const fixture = mkdtempSync(join(tmpdir(), 'staging-failed-cleanup-'));
    const candidate = join(fixture, '.candidate-failed');
    const checkout = join(candidate, 'checkout');
    const bin = join(fixture, 'bin');
    const lock = join(fixture, 'publication.lock');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(checkout, 'retained-source'), 'source');
    writeFileSync(join(bin, 'git'), '#!/bin/bash\nif [[ "$TEST_SLOW" == git ]]; then exec sleep 30; fi\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(bin, 'rm'), [
      '#!/bin/bash',
      'rec=0; for arg; do [[ "$arg" == -*r* ]] && rec=1; done',
      'if [[ "$TEST_SLOW" == rm ]] && ((rec)); then exec sleep 30; fi',
      'exec /bin/rm "$@"',
    ].join('\n'), { mode: 0o700 });
    const runs = join(fixture, 'systemd-run.log');
    writeFileSync(join(bin, 'systemctl'), '#!/bin/bash\nexit 3\n', { mode: 0o700 });
    writeFileSync(join(bin, 'systemd-run'), `#!/bin/bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(runs)}\nexit 0\n`, { mode: 0o700 });
    const env = {
      ...process.env, PATH: bin + ':' + (process.env.PATH ?? ''), SYNC_SCRIPT: SCRIPT_PATH,
      STAGING_CANDIDATE_HOME: candidate, STAGING_CANDIDATE_ROOT: checkout,
      STAGING_CANDIDATE_PUBLISHED: '0', INTEGRATION_ROOT: fixture,
      TEST_SLOW: slow, TEST_LOCK: lock, STAGING_TRASH_DRAIN_MODE: 'detached',
    };
    const sourced = CLEANUP_FNS.map((f) => `source <(sed -n "/^${f}()/,/^}/p" "$SYNC_SCRIPT")`).join('\n');
    try {
      // The outer deadline also kills the fixture's descendants on the broken
      // implementation; the real cleanup has a one-second shared budget here.
      const result = spawnSync('timeout', ['--signal=KILL', '6s', 'bash', '-c', [
        'set -uo pipefail', sourced, 'log() { echo "$*"; }',
        'exec 7>"$TEST_LOCK"; flock -x 7',
        'cleanup_staging_candidate 1',
        'flock -u 7; exec 7>&-',
        'echo CLEANUP_RETURNED_AND_LEASE_RELEASED',
      ].join('\n')], { env, encoding: 'utf8', timeout: 8_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('CLEANUP_RETURNED_AND_LEASE_RELEASED');
      // WI-6554700010029246: the failed candidate leaves the generation
      // namespace immediately; its bytes go to the detached drain.
      expect(existsSync(candidate)).toBe(false);
      const trash = readdirSync(fixture).filter((n) => n.startsWith('.trash-candidate-failed.'));
      expect(trash).toHaveLength(1);
      expect(readFileSync(runs, 'utf8').split('\n')).toContain(join(fixture, trash[0]));
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);

      const drained = runFn(['launch_staging_trash_drain'], 'log() { echo "$*"; }; launch_staging_trash_drain "$FIXTURE"',
        { env: { FIXTURE: fixture } });
      expect(drained.status, drained.stderr).toBe(0);
      expect(readdirSync(fixture).filter((n) => n.startsWith('.trash-'))).toEqual([]);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 20_000);

  it('retains a published generation without invoking cleanup', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'staging-published-cleanup-'));
    const checkout = join(fixture, 'checkout');
    mkdirSync(checkout);
    try {
      const result = runFn(['cleanup_staging_candidate'], [
        'git() { echo UNEXPECTED_GIT; exit 91; }',
        'rm() { echo UNEXPECTED_RM; exit 92; }',
        'cleanup_staging_candidate 1',
      ].join('\n'), { env: { STAGING_CANDIDATE_HOME: fixture,
        STAGING_CANDIDATE_ROOT: checkout, STAGING_CANDIDATE_PUBLISHED: '1' } });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(existsSync(checkout)).toBe(true);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('staging setup failure evidence survives cleanup (EI-26150720787099786)', () => {
  it('retains the failed SPA phase status and raw output outside the removed candidate', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'staging-setup-evidence-'));
    const candidateHome = join(fixture, '.candidate-fixture');
    const candidateRoot = join(candidateHome, 'checkout');
    const home = join(fixture, 'private-home');
    const scripts = join(fixture, 'apps/operator/scripts/systemd');
    const setup = join(fixture, 'apps/operator/bin/release');
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    mkdirSync(setup, { recursive: true });
    writeFileSync(join(scripts, 'papercusp-script-snapshot.sh'), 'exec bash "$@"\n');
    writeFileSync(join(setup, 'setup-release-checkout.sh'), [
      'printf "SETUP_PHASE=%s\\n" "${!#}"',
      'if [ "${!#}" = --spa-only ]; then',
      '  printf "PRIVATE_ERROR_MARKER\\0hidden tail\\n" >&2',
      '  exit 23',
      'fi',
    ].join('\n'));
    try {
      const result = runFn(['staging_sync_checkpoint', 'prepare_staging_candidate', ...CLEANUP_FNS], [
        'log() { printf "%s\\n" "$*"; }',
        'create_staging_candidate() { STAGING_CANDIDATE_HOME="$FIXTURE_CANDIDATE"; STAGING_CANDIDATE_ROOT="$FIXTURE_ROOT"; }',
        'STAGING_CANDIDATE_PUBLISHED=0; STAGING_ROOT=/absent-staging-test',
        'status=0',
        'prepare_staging_candidate 0123456789abcdef || status=$?',
        'cleanup_staging_candidate',
        'printf "SETUP_STATUS=%s\\n" "$status"',
      ].join('\n'), { env: { INTEGRATION_ROOT: fixture, PAPERCUSP_HOME: home,
        FIXTURE_ROOT: candidateRoot, FIXTURE_CANDIDATE: candidateHome, INVOCATION_ID: 'fixture-invocation', NOTIFY_SOCKET: '' } });
      expect(result.stdout).toContain('SETUP_STATUS=23');
      expect(result.stdout).toContain('failed in --spa-only');
      expect(existsSync(candidateHome)).toBe(false);
      const logs = join(home, 'checkpoint-logs');
      expect(existsSync(logs)).toBe(true);
      expect(readdirSync(logs)).toEqual(['staging-setup-fixture-invocation-spa-only.log']);
      const evidence = readFileSync(join(logs, 'staging-setup-fixture-invocation-spa-only.log'));
      expect(evidence.includes(Buffer.from('PRIVATE_ERROR_MARKER\0hidden tail\n'))).toBe(true);
      expect(evidence.toString()).toContain('setup exit status: 23');
      expect(evidence.toString()).toContain('source: 0123456789abcdef');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('staging bundle failure evidence survives cleanup (EI-25202900905730650)', () => {
  it('retains the full raw log and failure status before the real cleanup removes the candidate', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'staging-bundle-evidence-'));
    const candidateHome = join(fixture, '.candidate-fixture');
    const candidateRoot = join(candidateHome, 'checkout');
    const home = join(fixture, 'private-home');
    const bundle = join(candidateRoot, 'bundle.sh');
    mkdirSync(join(candidateRoot, 'apps/operator/dist-host'), { recursive: true });
    writeFileSync(bundle, 'mkdir -p "$PAPERCUSP_INTEGRATION_ROOT/apps/operator/dist-host"\nprintf "PRIVATE_ERROR_MARKER\\0hidden tail\\n" > "$PAPERCUSP_INTEGRATION_ROOT/apps/operator/dist-host/hono-host.mjs.build-error.log"\nexit 23\n');
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const begin = script.indexOf('  log "prebuilding proof-bound host bundle');
    const end = script.indexOf('  staging_sync_checkpoint "host bundle prebuilt"', begin);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    try {
      const result = runFn(['prebuild_staging_host_bundle', ...CLEANUP_FNS], [
        'log() { printf "%s\\n" "$*"; }',
        'SYNC_ROOT="$FIXTURE_ROOT"; bundle_script="$FIXTURE_BUNDLE"; UNIT=fixture.service',
        'STAGING_CANDIDATE_HOME="$FIXTURE_CANDIDATE"; STAGING_CANDIDATE_ROOT="$FIXTURE_ROOT"',
        'STAGING_CANDIDATE_PUBLISHED=0; INTEGRATION_ROOT=/absent-fixture-repo',
        'status=0',
        `(set -e; ${script.slice(begin, end)}) || status=$?`,
        'cleanup_staging_candidate',
        'printf "BUNDLE_STATUS=%s\\n" "$status"',
      ].join('\n'), { env: { PAPERCUSP_HOME: home, FIXTURE_ROOT: candidateRoot,
        FIXTURE_BUNDLE: bundle, FIXTURE_CANDIDATE: candidateHome, INVOCATION_ID: 'fixture-invocation' } });
      expect(result.stdout).toContain('BUNDLE_STATUS=23');
      expect(existsSync(candidateHome)).toBe(false);
      const logs = join(home, 'checkpoint-logs');
      expect(existsSync(logs)).toBe(true);
      expect(readdirSync(logs)).toEqual(['staging-bundle-fixture-invocation.log']);
      expect(readFileSync(join(logs, 'staging-bundle-fixture-invocation.log'))
        .includes(Buffer.from('PRIVATE_ERROR_MARKER\0hidden tail\n'))).toBe(true);
      expect(result.stderr).toContain('PRIVATE_ERROR_MARKER');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('sync-staging-checkout.sh post-restart readiness budget (EI-23131564135958331)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  function normalize(value: string): { status: number | null; stdout: string; stderr: string } {
    return runFn(
      ['normalize_staging_readiness_timeout_sec'],
      'normalize_staging_readiness_timeout_sec "$VALUE"',
      { env: { VALUE: value } },
    );
  }

  it('accepts a migration-sized default and explicit positive overrides', () => {
    expect(normalize('300')).toMatchObject({ status: 0, stdout: '300\n' });
    expect(normalize('480')).toMatchObject({ status: 0, stdout: '480\n' });
  });

  it('rejects zero and malformed values so the readiness wait stays bounded and intentional', () => {
    expect(normalize('0').status).toBe(1);
    expect(normalize('30s').status).toBe(1);
    expect(normalize('-1').status).toBe(1);
    expect(normalize('').status).toBe(1);
  });

  it('uses the configured positive timeout rather than the old fixed ~60s attempt count', () => {
    expect(script).toContain('PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC:-300');
    expect(script).toContain('normalize_staging_readiness_timeout_sec');
    expect(script).toContain('while [ "$readiness_elapsed_sec" -lt "$READINESS_TIMEOUT_SEC" ]');
    expect(script).toContain('within ${READINESS_TIMEOUT_SEC}s after restart');
    expect(script).not.toContain('seq 1 30');
  });

  it('validates the readiness budget before requesting dev:restart', () => {
    const validationIdx = script.indexOf('invalid PAPERCUSP_STAGING_SYNC_READINESS_TIMEOUT_SEC');
    const restartIdx = script.indexOf('requesting coordinated restart');
    expect(validationIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(validationIdx);
  });
});

/**
 * Structural guards. The gates above are only worth anything if the shipped
 * script actually consults them on the path to the restart — an edit that
 * extracts the functions but stops calling them would leave every unit test
 * above green while :3170 flapped exactly as before.
 */
describe('sync-staging-checkout.sh — the shipped script actually wires the gates (WI-5710)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('checks the effective staging launch bind before even the unchanged-HEAD no-op', () => {
    const guardIdx = script.indexOf('assert_staging_unit_loopback || exit 1');
    const targetIdx = script.indexOf('target="$(git -C');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(targetIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(targetIdx);
  });

  it('proves the unit serves the same isolated checkout before any sync decision', () => {
    const guardIdx = script.indexOf('assert_staging_unit_checkout || exit 1');
    const targetIdx = script.indexOf('target="$(git -C');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(targetIdx);
    expect(script).toContain('PAPERCUSP_BUNDLE_REUSE_FRESH=1');
  });

  it('treats checkout equality as a no-op only when the running bundle reports that target SHA', () => {
    const equalityIdx = script.indexOf('if [ "$target" = "$current" ]');
    const noOpIdx = script.indexOf('running :3170 bundle already at', equalityIdx);
    const mismatchIdx = script.indexOf('restart still required', equalityIdx);
    expect(equalityIdx).toBeGreaterThan(-1);
    expect(script.slice(equalityIdx, noOpIdx)).toContain('health_sha_matches_target');
    expect(mismatchIdx).toBeGreaterThan(noOpIdx);
  });

  it('consults paths_require_restart() before restarting', () => {
    expect(script).toMatch(/paths_require_restart/);
    expect(script).toMatch(/restart_required=0/);
  });

  it('the SPA-only path skips the restart but still runs the rebuild', () => {
    // The skip must come AFTER candidate preparation (dist refreshed on
    // disk), not instead of it — otherwise :3170 serves a stale SPA forever.
    const buildIdx = script.indexOf('prepare_staging_candidate "$target"');
    const skipIdx = script.indexOf('skipping restart — all');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(buildIdx);
  });

  it('the live-session deferral happens BEFORE the checkout advances (SPA/server lockstep)', () => {
    // Advancing the checkout while keeping the old process would serve a NEW
    // SPA against an OLD server. The defer must therefore precede the build.
    const deferIdx = script.indexOf('deferring sync —');
    const buildIdx = script.indexOf('prepare_staging_candidate "$target"');
    expect(deferIdx).toBeGreaterThan(-1);
    expect(script.indexOf('staging_live_client_count "$STAGING_PORT"')).toBeGreaterThan(-1);
    if (buildIdx > -1) expect(deferIdx).toBeLessThan(buildIdx);
  });

  it('the deferral is bounded by a staleness ceiling (never an indefinite freeze)', () => {
    expect(script).toMatch(/MAX_STALE_SEC/);
    expect(script).toMatch(/staleness ceiling reached/);
  });

  it('keeps the EI-13221 recent-restart grace and strengthens health to exact source identity', () => {
    expect(script).toMatch(/RECENT_RESTART_GRACE_SEC/);
    expect(script).toContain('staging_health_source_sha');
    expect(script).toMatch(/did not report target source/);
  });

  it('routes a required restart through audited dev:restart, never raw systemctl', () => {
    expect(script).toContain('RESTART_CONTROL_URL="$(resolve_staging_restart_control_url)" || exit 1');
    expect(script).toContain('"$PTOOL_BIN" dev:restart --url="$RESTART_CONTROL_URL" --json -');
    expect(script).toContain('"confirm":true,"authorize":true');
    // vacuous-negative-ok: raw systemctl restart was replaced by audited dev:restart; pins the old form out (deploy.sh restarting "$u" is unrelated)
    expect(script).not.toContain('systemctl --user restart "$UNIT"');
  });

  it('prebuilds the proof-bound host bundle before requesting the coordinated restart', () => {
    const prebuildIdx = script.indexOf('prebuilding proof-bound host bundle');
    const restartIdx = script.indexOf('requesting coordinated restart');
    expect(prebuildIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(prebuildIdx);
    expect(script.slice(prebuildIdx, restartIdx)
      .includes('prebuild_staging_host_bundle "$SYNC_ROOT" "$bundle_script"')).toBe(true);
  });

  it('prepares, validates, and builds a candidate before publishing the stable alias', () => {
    const prepareIdx = script.indexOf('prepare_staging_candidate "$target"');
    const preflightIdx = script.indexOf('preflight_staging_migrations "$SYNC_ROOT"');
    const prebuildIdx = script.indexOf('prebuilding proof-bound host bundle before publishing');
    const schemaIdx = script.indexOf('prepare_staging_schema "$SYNC_ROOT"');
    const readyIdx = script.indexOf('mark_staging_candidate_ready "$target"');
    const publishIdx = script.indexOf('publish_staging_generation "$STAGING_CANDIDATE_ROOT"');
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(prepareIdx);
    expect(prebuildIdx).toBeGreaterThan(preflightIdx);
    expect(schemaIdx).toBeGreaterThan(prebuildIdx);
    expect(readyIdx).toBeGreaterThan(schemaIdx);
    expect(publishIdx).toBeGreaterThan(readyIdx);
  });

  it('accepts post-restart health only when /api/health reports the target source SHA', () => {
    const healthLoopIdx = script.indexOf('last_health_sha=');
    expect(healthLoopIdx).toBeGreaterThan(-1);
    expect(script.slice(healthLoopIdx)).toContain('health_sha_matches_target "$last_health_sha" "$target"');
  });

  it('fails before advancing when the coordinated restart mechanism is unavailable', () => {
    const ptoolGateIdx = script.indexOf('coordinated dev:restart seam cannot run');
    const buildIdx = script.indexOf('prepare_staging_candidate "$target"');
    expect(ptoolGateIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(ptoolGateIdx).toBeLessThan(buildIdx);
  });
});

/**
 * EI-22102474093310851 — a transient git-sync refusal must not fail the unit.
 *
 * THE BUG: the dev:restart call was a ONE-SHOT, and any refusal was FATAL exit 1.
 * dev:restart's own guidance says the opposite is needed: "git-sync fires hold the
 * barrier only ~5-10s, so a short drain usually succeeds where a one-shot attempt
 * always fails." Measured over 24h on 2026-09-03: 13 unit failures, 9 on
 * `git_sync_barrier_draining` and 4 on `git_sync_collision_operation_in_flight_unknown`
 * — and ZERO build/tsc errors, despite the filed title naming the tsc step.
 *
 * The fix has two halves and BOTH are load-bearing:
 *   1. pass `git_sync_drain_sec` so the call WAITS for the barrier;
 *   2. if a git-sync refusal outlasts even that, DEFER (exit 0) rather than fail —
 *      but bounded by the same MAX_STALE_SEC ceiling the live-client deferral uses,
 *      so a genuinely stuck barrier still goes loud instead of silently leaving
 *      :3170 on stale code forever.
 */
describe('sync-staging-checkout.sh — transient git-sync refusals defer, they do not fail (EI-22102474093310851)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  /** Run the REAL predicate over a dev:restart result payload. */
  function isTransient(result: unknown): boolean {
    const r = runFn(['restart_refusal_is_transient_git_sync'], 'restart_refusal_is_transient_git_sync', {
      input: JSON.stringify(result),
    });
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`predicate exited ${r.status}: ${r.stderr}`);
    }
    return r.status === 0;
  }

  it('classifies the two REAL refusals measured in the journal as transient', () => {
    // Verbatim shapes from papercup-staging-sync.service, 2026-09-03.
    expect(isTransient({ ok: false, target: 'staging', reason: 'git_sync_barrier_draining', restarted: false })).toBe(true);
    expect(
      isTransient({
        ok: false,
        target: 'staging',
        reason: 'git_sync_collision_operation_in_flight_unknown',
        restarted: false,
        git_sync_collision: { kind: 'operation-in-flight-unknown', unknownResources: ['git-sync:papercusp'] },
      }),
    ).toBe(true);
  });

  it('matches the PREFIX dev:restart owns, so a future collision kind cannot drift past it', () => {
    // restart.ts derives these as `git_sync_collision_${kind.replace(/-/g,'_')}` and
    // `git_sync_barrier_${reason.replace(/-/g,'_')}` over an OPEN enum. A predicate
    // enumerating today's suffixes would silently start failing the unit the day a
    // new kind lands; matching the code-owned prefix is what prevents that.
    expect(isTransient({ ok: false, reason: 'git_sync_collision_some_future_kind_nobody_has_written_yet' })).toBe(true);
    expect(isTransient({ ok: false, reason: 'git_sync_barrier_some_future_reason' })).toBe(true);
  });

  it('does NOT swallow a refusal that is not a git-sync coordination refusal', () => {
    expect(isTransient({ ok: false, reason: 'gate_collision' })).toBe(false);
    expect(isTransient({ ok: false, reason: 'not_authorized' })).toBe(false);
    expect(isTransient({ ok: false })).toBe(false);
    // a reason that merely CONTAINS the token, rather than being prefixed by it
    expect(isTransient({ ok: false, reason: 'unrelated_git_sync_collision_thing' })).toBe(false);
    expect(isTransient('not json at all')).toBe(false);
  });

  it('the shipped script WAITS for the barrier instead of one-shotting the restart', () => {
    expect(script).toContain('"git_sync_drain_sec":${GIT_SYNC_DRAIN_SEC}');
    expect(script).toContain('normalize_git_sync_drain_sec');
    expect(script).toMatch(/PAPERCUSP_STAGING_SYNC_GIT_SYNC_DRAIN_SEC:-45/);
  });

  describe('the wire budget stays compatible with the oldest live staging schema', () => {
    function normalize(value: string): { status: number | null; stdout: string; stderr: string } {
      return runFn(['normalize_git_sync_drain_sec'], 'normalize_git_sync_drain_sec "$VALUE"', {
        env: { VALUE: value },
      });
    }

    it('preserves a valid short override', () => {
      expect(normalize('7')).toMatchObject({ status: 0, stdout: '7\n' });
    });

    it('clamps the stale-runtime-incompatible default/override ceiling to 45s', () => {
      expect(normalize('60')).toMatchObject({ status: 0, stdout: '45\n' });
      expect(normalize('120')).toMatchObject({ status: 0, stdout: '45\n' });
    });

    it('rejects non-numeric values instead of emitting invalid JSON', () => {
      expect(normalize('45s').status).toBe(1);
    });
  });

  it('the deferral is BOUNDED — a stuck barrier still goes FATAL rather than hiding stale code', () => {
    const branchIdx = script.indexOf('restart_refusal_is_transient_git_sync; then');
    const ceilingIdx = script.indexOf('staleness ceiling reached', branchIdx);
    const fatalIdx = script.indexOf('FATAL: coordinated dev:restart was refused', branchIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    // the transient branch consults the SAME age ceiling the live-client deferral uses…
    expect(script.slice(branchIdx, fatalIdx)).toContain('current_commit_age_sec');
    expect(script.slice(branchIdx, fatalIdx)).toContain('MAX_STALE_SEC');
    // …and the FATAL exit is still reachable past it, not replaced by the deferral.
    expect(ceilingIdx).toBeGreaterThan(branchIdx);
    expect(fatalIdx).toBeGreaterThan(ceilingIdx);
  });
});
