/**
 * release-checkpoint-launch — the detached green-checkpoint fire-now primitive (WI-1320 follow-up).
 * Asserts the systemd-run argv construction (pure) + the launch/refuse resolution with an injected
 * spawn seam — no real suite fires.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-checkpoint-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// WI-4957: launchDetachedCheckpoint's DEFAULT `cancelStaleAwaits` param is the real
// cancelStaleCheckpointAwaits, which lazily requires events/await/engine → a real PG pool.
// Every test in this file EXCEPT the WI-4957 ones below injects no 5th param, so without
// this mock every replaceStale test would hit a real (here, absent) database and hang.
// Mocked to resolve immediately; the WI-4957 tests inject their own spy and bypass this
// entirely (the module-level function is never reached when a 5th arg is supplied).
vi.mock('./events/await/engine', () => ({
  cancelSupersededCandidateAwaits: vi.fn(async () => ({ cancelled: 0, ids: [] })),
}));
// WI-2141541: launchDetachedCheckpoint calls admitCheckpointMemory BEFORE it spawns, and the
// DEFAULT probe scans the REAL /proc + /sys/fs/cgroup tree for live green-checkpoint scopes and
// sums their memory.max. That is host state, not a unit-test input: with three checkpoint runs
// live on the box (the papercusp gate plus other installs' gates) every launch in this file
// resolved launched:false reason:'memory_budget' and 15 unrelated assertions failed — on the
// gate at 2026-08-31 18:38Z and again at 2026-09-02 11:26Z, unchanged code both times, passing
// alone minutes later. Stub the admission to admit; the admission logic keeps its own
// probe-injected test in release/checkpoint-memory-admission.test.ts. No test here asserts the
// memory-budget path.
vi.mock('./release/checkpoint-memory-admission', async (orig) => ({
  ...(await orig<typeof import('./release/checkpoint-memory-admission')>()),
  admitCheckpointMemory: (opts: { requestG: number }) => ({
    admit: true,
    reason: 'admitted-sole-run' as const,
    requestG: opts.requestG,
    committedG: 0,
    budgetG: 125,
    scopes: 0,
    unbounded: 0,
    detail: `checkpoint-memory: TEST STUB — admitting ${opts.requestG} GiB (host scope census is not a unit-test input)`,
  }),
}));
// WI-10005763: launchDetachedCheckpoint asks the D-012 restricted-hold fence before anything else.
// The real census reads git metadata and the org database for the roots it is given (several tests
// here pass real mkdtemp checkouts), which is host state, not a unit-test input. Default: nothing
// held, returned SYNCHRONOUSLY so the same-tick spawn contract these tests drive (child.emit right
// after the call) still holds. The WI-10005763 tests below swap in a refusal.
const restrictedFence = vi.hoisted(() => ({
  refusal: vi.fn((_roots: readonly string[]): RestrictedHoldRefusal | null => null),
}));
vi.mock('./agent-tools/testing/restricted-hold-fence', async (orig) => ({
  ...(await orig<typeof import('./agent-tools/testing/restricted-hold-fence')>()),
  restrictedTreeHoldRefusal: restrictedFence.refusal,
}));
import type { RestrictedHoldRefusal } from './agent-tools/testing/restricted-hold-fence';
import { cancelSupersededCandidateAwaits } from './events/await/engine';
import {
  buildCheckpointSystemdArgv,
  checkpointRunLogPath,
  checkpointLatestLogPath,
  launchDetachedCheckpoint as launchDetachedCheckpointImpl,
  checkActiveCheckpointRun,
  parseCheckpointCandidates,
  defaultReadLogTail,
  isCheckpointRunLockHeldCheap,
  readCheckpointProcessAuthorityCheap,
  readCheckpointRunPhaseCheap,
  stopActiveCheckpointUnit,
  terminateActiveCheckpointUnit,
  recordCheckpointDisplacement,
  CHECKPOINT_UNIT,
  checkpointUnitForRoot,
  CHECKPOINT_MAX_RUNTIME_SEC,
  CHECKPOINT_SYSTEMCTL_PROBE_TIMEOUT_MS,
  MANUAL_CHECKPOINT_WATCHDOG_ENV,
  MANUAL_CHECKPOINT_WATCHDOG_MS,
  GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER,
  CHECKPOINT_RUN_LOCK_STALE_MS,
  CANDIDATE_RERESOLVE_WINDOW_SEC,
  REPLACE_STALE_MIN_SILENCE_SEC,
  checkpointSilenceSec,
  classifyReplaceRequest,
  checkpointCandidateContainsAncestor,
  checkpointCandidateContainment,
  currentCheckpointCandidate,
  renderContainmentWarning,
  assessPreLaunchExclusion,
  renderPreLaunchRefusal,
  PRELAUNCH_EXCLUSION_MAX_WAIT_SEC,
  cancelStaleCheckpointAwaits,
  resolveCheckpointCapacity,
  CHECKPOINT_CAPACITY_MODE_ENV,
} from './release-checkpoint-launch';
import type { ExecSyncLike } from './release-checkpoint-launch';
// WI-38356: the control + calibration cases below call the underlying reads directly, to prove
// the submodule fixture is exercising the blind spot rather than a broken fake.
import { containingSubmodulePath, excludedCommitsTouchingPath, gitReadFromExecSync } from './candidate-contains';
import { CHECKPOINT_QUALIFICATION_ATTEMPT_ENV } from './release/checkpoint-qualification-transaction';
import { GATE_FIRE_ID_ENV } from './release/gate-fire-ledger';

describe('currentCheckpointCandidate default executor (EI-21367123002341200)', () => {
  it('supports the exported read helper without an explicit execFn', () => {
    const root = mkdtempSync(join(tmpdir(), 'ei-213671-current-candidate-'));
    const result = currentCheckpointCandidate(root);

    expect(result).toEqual({
      current_head: null,
      current_candidate: null,
      quiet_cut_sec: null,
    });
  });
});

// 2026-07-10: every run wrote to /tmp/<unit>.log, so the natural response to a red —
// re-fire — truncated the failure output that red was telling you to read. Each run now
// owns a timestamped file; the well-known path becomes a symlink to the newest.
describe('per-run checkpoint logs (re-fire must not destroy the evidence)', () => {
  it('gives each run its own timestamped path under the unit name', () => {
    const a = checkpointRunLogPath('papercup-gc', new Date('2026-07-10T04:06:59.566Z'));
    expect(a).toBe('/tmp/papercup-gc-2026-07-10T04-06-59-566Z.log');
    // A second run at a different instant never collides with the first.
    expect(checkpointRunLogPath('papercup-gc', new Date('2026-07-10T06:29:46.196Z'))).not.toBe(a);
  });

  it('keeps the well-known path stable for existing readers', () => {
    expect(checkpointLatestLogPath('papercup-gc')).toBe('/tmp/papercup-gc.log');
  });

  it('symlinks the stable path at the run log before redirecting into it', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, '/tmp/cp-RUN.log');
    const inner = argv[argv.length - 1];
    // ln first (so a reader polling the stable path lands on this run's file), then the
    // redirect binds to green-checkpoint only, and -n keeps ln from following the old link.
    expect(inner).toContain("ln -sfn '/tmp/cp-RUN.log' '/tmp/cp.log' &&");
    // WI-5377: the redirect now binds to the ANSI-stripping filter's output, not
    // green-checkpoint.ts directly — see the dedicated describe block below.
    expect(inner).toContain('> /tmp/cp-RUN.log');
    expect(inner.indexOf('ln -sfn')).toBeLessThan(inner.indexOf('green-checkpoint.ts'));
  });

  it('writes straight to the given path when no run log is supplied (back-compat)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin').at(-1)!;
    expect(inner).toContain('> /tmp/cp.log');
    expect(inner).not.toContain('ln -sfn');
  });
});

describe('WI-5377: ANSI escapes are stripped before the persisted log is written', () => {
  it('pipes the detached run through an unbuffered sed ANSI-strip before the redirect', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin').at(-1)!;
    // green-checkpoint.ts's combined stdout+stderr feeds the filter, whose OWN stdout is
    // what lands in the file — never a raw, unfiltered write straight from the CLI.
    expect(inner).toContain("2>&1 | setsid --wait sed -u 's/\\x1b\\[[0-9;]*m//g' > /tmp/cp.log");
    expect(inner).toMatch(/^set -o pipefail;/);
    const csIdx = inner.indexOf('green-checkpoint.ts');
    const sedIdx = inner.indexOf('sed -u');
    const redirectIdx = inner.lastIndexOf('> /tmp/cp.log');
    expect(csIdx).toBeGreaterThan(-1);
    expect(sedIdx).toBeGreaterThan(csIdx); // filter comes after the CLI invocation
    expect(redirectIdx).toBeGreaterThan(sedIdx); // the file redirect binds to the filter's output
  });

  it('the filter is the SGR (colour/style) escape pattern every existing hand-rolled reader already uses', () => {
    // Pinned as a literal sed program, not re-derived: this ticket's own description
    // cites every downstream reader as already re-implementing exactly this regex by
    // hand, so a future edit that drifts from it would silently disagree with them.
    // Cross-checked here against a real SGR sequence so the pin can't rot into a
    // pattern that LOOKS right but no longer actually matches ANSI colour codes.
    const sedProgram = 's/\\x1b\\[[0-9;]*m//g';
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin').at(-1)!;
    expect(inner).toContain(`sed -u '${sedProgram}'`);
    const ansiRe = /\x1b\[[0-9;]*m/g;
    expect('\x1b[31mred\x1b[0m'.replace(ansiRe, '')).toBe('red');
    expect('plain text, no escapes'.replace(ansiRe, '')).toBe('plain text, no escapes');
  });

  it('applies through the per-run-log path too (the run log, not just the stable symlink target)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, '/tmp/cp-RUN.log').at(-1)!;
    expect(inner).toContain("2>&1 | setsid --wait sed -u 's/\\x1b\\[[0-9;]*m//g' > /tmp/cp-RUN.log");
  });
});

describe('buildCheckpointSystemdArgv', () => {
  // WI-6554700010042457 (Avi #2574): a manual main-greening run carries NO wall-clock deadline
  // of its own. The launch time no longer anchors a cutoff; only a deadline the LAUNCHER itself
  // inherited is forwarded (the earliest one, so a child can never outlive its caller's scope).
  it('adds no deadline of its own and forwards only the earliest inherited one', () => {
    const key = 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';
    const deadlineArgs = (argv: string[]) => argv.filter(value => value.startsWith(`--setenv=${key}=`));
    vi.stubEnv(key, undefined);
    try {
      const args: Parameters<typeof buildCheckpointSystemdArgv> = ['/tree', '/tmp/cp.log', '/usr/bin'];
      args[14] = 1000; // launchStartedAtMs: must NOT produce 1000 + any watchdog/suite budget
      expect(deadlineArgs(buildCheckpointSystemdArgv(...args))).toEqual([]);

      vi.stubEnv(key, '9000000');
      expect(deadlineArgs(buildCheckpointSystemdArgv(...args))).toEqual([`--setenv=${key}=9000000`]);

      args[11] = { [key]: '200000' };
      expect(deadlineArgs(buildCheckpointSystemdArgv(...args))).toEqual([`--setenv=${key}=200000`]);

      // A garbage inherited value is ignored rather than becoming a deadline.
      vi.stubEnv(key, 'not-a-number');
      args[11] = {};
      expect(deadlineArgs(buildCheckpointSystemdArgv(...args))).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('targets the manual unit, sets no run-level wall clock, and runs the green-checkpoint CLI in the tree root', () => {
    vi.stubEnv('PAPERCUSP_TASK_DEADLINE_EPOCH_MS', undefined);
    let argv: string[];
    try {
      argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
    } finally { vi.unstubAllEnvs(); }
    expect(argv).toContain(`--unit=${checkpointUnitForRoot('/tree')}`); // per-root (2026-07-01): cross-root manual gates no longer serialize
    expect(argv).toContain('--no-block');
    expect(argv).toContain('--property=CollectMode=inactive-or-failed');
    expect(argv).toContain('--property=MemoryMax=16G');
    expect(argv).toContain('--property=MemorySwapMax=0');
    expect(argv).toContain('--property=ManagedOOMPreference=avoid');
    expect(argv).toContain('--property=RefuseManualStop=yes');
    const stopPost = argv.find((arg) => arg.startsWith('--property=ExecStopPost='));
    expect(stopPost).toContain(GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER);
    expect(stopPost).toContain('service_result=%s exit_code=%s exit_status=%s');
    expect(stopPost).not.toContain('%%s');
    expect(stopPost).toContain('$SERVICE_RESULT');
    expect(stopPost).toContain('$EXIT_CODE');
    expect(stopPost).toContain('$EXIT_STATUS');
    expect(stopPost).not.toContain('$$SERVICE_RESULT');
    expect(stopPost).toContain('>> "/tmp/cp.log"');
    // WI-6554700010042457: systemd must never kill a progressing run on a wall clock.
    expect(argv.filter(arg => /RuntimeMax/.test(arg))).toEqual([]);
    expect(argv.filter(arg => arg.startsWith('--setenv=PAPERCUSP_TASK_DEADLINE_EPOCH_MS='))).toEqual([]);
    expect(argv).toContain('--working-directory=/tree');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
    expect(argv).toContain(`--setenv=${MANUAL_CHECKPOINT_WATCHDOG_ENV}=${MANUAL_CHECKPOINT_WATCHDOG_MS}`);
    const inner = argv[argv.length - 1]!;
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
    // WI-5377: the redirect binds to the ANSI-stripping filter's output — see the
    // dedicated describe block for the filter itself.
    expect(inner).toContain('> /tmp/cp.log');
  });

  // WI-10008187 / WI-10006055: a detached `systemd-run --user` unit does NOT inherit the
  // launcher's env. Without the DSN forwarded, the gate logs `database: <unset> (source=none)`
  // and resolves the discovery file (another install's sidecar DB), where it cannot see its own
  // frozen repair queue. This pins the forward so a refactor of the argv builder cannot drop it.
  it('forwards the launcher DB target (DSN) into the detached unit, and never an empty one', () => {
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://gate@127.0.0.1:5432/papercusp');
    vi.stubEnv('HARNESS_DATABASE_URL', '   ');
    vi.stubEnv('DATABASE_URL', undefined);
    try {
      const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
      expect(argv).toContain('--setenv=HARNESS_ADMIN_DATABASE_URL=postgresql://gate@127.0.0.1:5432/papercusp');
      expect(argv.some((arg) => arg.startsWith('--setenv=HARNESS_DATABASE_URL='))).toBe(false);
      expect(argv.some((arg) => arg.startsWith('--setenv=DATABASE_URL='))).toBe(false);
      // The forward must precede the inner `bash -c` command: systemd-run options after the
      // command are treated as the command's own arguments, not as unit environment.
      const dsnIndex = argv.indexOf('--setenv=HARNESS_ADMIN_DATABASE_URL=postgresql://gate@127.0.0.1:5432/papercusp');
      expect(dsnIndex).toBeLessThan(argv.indexOf('bash'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the tooling root separate from the routed subject root and forwards the env overlay safely', () => {
    const argv = buildCheckpointSystemdArgv(
      '/papercusp-tooling',
      '/tmp/portal.log',
      '/usr/bin:/bin',
      false,
      undefined,
      { workspaceId: 'portal-workspace', installSlug: 'portal' },
      'shared',
      undefined,
      undefined,
      undefined,
      '/portal-subject',
      { PAPERCUSP_RELEASE_SLUG: 'portal', 'bad-key': 'drop-me' },
      ['DATABASE_URL', 'bad-key'],
    );
    const inner = argv.at(-1)!;

    expect(argv).toContain('--working-directory=/papercusp-tooling');
    expect(argv).toContain('--setenv=PAPERCUSP_RELEASE_SLUG=portal');
    expect(argv).not.toContain('--setenv=bad-key=drop-me');
    expect(inner).toContain("unset 'DATABASE_URL' &&");
    expect(inner).not.toContain("unset 'bad-key'");
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/portal-subject'");
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
  });

  it('EI-211596: transports one validated exact candidate into the detached CLI', () => {
    const candidate = 'a'.repeat(40);
    const inner = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin:/bin',
      false,
      undefined,
      null,
      'shared',
      candidate,
    ).at(-1)!;
    expect(inner).toContain(`green-checkpoint.ts --candidate '${candidate}'`);
    expect(inner).toContain("--candidate-source 'tip'");
  });

  it.each(['pinned', 'tip', 'frozen-repair-queue', 'current-quiet-cut'] as const)(
    'EI-224436: transports the exact runnable candidate source %s',
    (candidateSource) => {
      const candidate = 'a'.repeat(40);
      const inner = buildCheckpointSystemdArgv(
        '/tree',
        '/tmp/cp.log',
        '/usr/bin:/bin',
        false,
        undefined,
        null,
        'shared',
        candidate,
        undefined,
        undefined,
        '/tree',
        {},
        [],
        candidateSource,
      ).at(-1)!;

      expect(inner).toContain(`--candidate '${candidate}' --candidate-source '${candidateSource}'`);
    },
  );

  it('EI-224436: keeps unresolved preflight values out of the detached CLI', () => {
    const candidate = 'a'.repeat(40);
    const inner = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin:/bin',
      false,
      undefined,
      null,
      'shared',
      candidate,
      undefined,
      undefined,
      '/tree',
      {},
      [],
      'unresolved' as never,
    ).at(-1)!;

    expect(inner).toContain("--candidate-source 'tip'");
    expect(inner).not.toContain("--candidate-source 'unresolved'");
  });

  it('EI-211596: never forwards an unvalidated candidate into the bash command', () => {
    const inner = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin:/bin',
      false,
      undefined,
      null,
      'shared',
      "bad'; touch /tmp/pwned; '",
    ).at(-1)!;
    expect(inner).not.toContain('--candidate');
    expect(inner).not.toContain('--candidate-source');
    expect(inner).not.toContain('touch /tmp/pwned');
  });

  it('uses the periodic cap policy for reserved manual runs and does not invent TasksMax', () => {
    const argv = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin:/bin',
      false,
      undefined,
      null,
      'reserved',
    );
    expect(argv).toContain('--property=MemoryMax=40G');
    expect(argv).toContain('--property=MemorySwapMax=0');
    expect(argv.some((arg) => arg.startsWith('--property=TasksMax='))).toBe(false);
  });

  it('WI-4310: forwards the dedicated DB pool cap into the detached checkpoint unit', () => {
    const previous = process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
    try {
      delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
      expect(buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin')).toContain(
        '--setenv=PAPERCUSP_DB_POOL_MAX=2',
      );

      process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = '3.9';
      expect(buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin')).toContain(
        '--setenv=PAPERCUSP_DB_POOL_MAX=3',
      );
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX;
      else process.env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX = previous;
    }
  });

  it('WI-10006055: forwards the launcher DB target so the detached gate never falls through to the discovery file', () => {
    const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL'] as const;
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      // No DSN in the launcher: nothing to forward (and no empty --setenv that would pin '').
      const bare = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
      expect(bare.filter((a) => keys.some((k) => a.startsWith(`--setenv=${k}=`)))).toEqual([]);

      // :3070 carries HARNESS_ADMIN_DATABASE_URL; :3170 carries DATABASE_URL. Both must reach the unit.
      process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://admin:x@localhost:5432/papercusp';
      process.env.DATABASE_URL = 'postgresql://admin:y@localhost:5432/papercusp';
      process.env.HARNESS_DATABASE_URL = '   ';
      const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin');
      expect(argv).toContain('--setenv=HARNESS_ADMIN_DATABASE_URL=postgresql://admin:x@localhost:5432/papercusp');
      expect(argv).toContain('--setenv=DATABASE_URL=postgresql://admin:y@localhost:5432/papercusp');
      expect(argv.some((a) => a.startsWith('--setenv=HARNESS_DATABASE_URL='))).toBe(false);
      // The DSN rides as systemd-run properties, before the command, never inside the shell string.
      const bashAt = argv.indexOf('bash');
      expect(argv.indexOf('--setenv=DATABASE_URL=postgresql://admin:y@localhost:5432/papercusp')).toBeLessThan(bashAt);
      expect(argv.at(-1)).not.toContain('postgresql://');
    } finally {
      for (const k of keys) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
    }
  });

  it('does NOT forward the partial-green-gate flag by default (whole-batch, back-compat)', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin').at(-1)!;
    expect(inner).not.toContain('PAPERCUSP_PARTIAL_GREEN_GATE');
  });

  describe('WI-39472: capacity mode reaches the detached run', () => {
    // A detached unit does not inherit the launcher's env, so setting
    // PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE on papercup-dev-api.service changed every
    // SCHEDULED run (the routine spawns with { ...process.env }) and NO manual run. That
    // divergence is silent: `systemctl show` and /proc/<operator>/environ both report the new
    // value while the run logs `mode=shared maxForks=2`. Observed 2026-08-17 with the gate 10
    // reds deep. These pin the forwarding so the two paths cannot drift apart again.
    it.each(['shared', 'reserved'] as const)('forwards capacity mode %s into the inner command', (mode) => {
      const inner = buildCheckpointSystemdArgv(
        '/tree',
        '/tmp/cp.log',
        '/usr/bin:/bin',
        false,
        undefined,
        null,
        mode,
      ).at(-1)!;
      expect(inner).toContain(`PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE='${mode}'`);
    });

    it('omits the var entirely when unset, so the run keeps its own default', () => {
      const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin').at(-1)!;
      expect(inner).not.toContain('PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE');
    });

    // The value lands in a `bash -c` string. release-config.ts accepts exactly two literals, so
    // anything else is DROPPED rather than quoted-and-passed — an unvalidated passthrough here
    // would be a shell-injection seam reachable from an env var.
    it.each([
      ["reserved'; touch /tmp/pwned; '", 'shell metacharacters'],
      ['RESERVED', 'wrong case'],
      ['', 'empty string'],
      ['8', 'a fork count rather than a mode'],
    ])('drops an unrecognised capacity mode (%s: %s)', (bad) => {
      const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin', false, undefined, null, bad).at(
        -1,
      )!;
      expect(inner).not.toContain('PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE');
      expect(inner).not.toContain('touch /tmp/pwned');
    });

    it('still forwards the partial-green flag alongside capacity mode (neither clobbers the other)', () => {
      const inner = buildCheckpointSystemdArgv(
        '/tree',
        '/tmp/cp.log',
        '/usr/bin:/bin',
        true,
        undefined,
        null,
        'reserved',
      ).at(-1)!;
      expect(inner).toContain("PAPERCUSP_PARTIAL_GREEN_GATE='1'");
      expect(inner).toContain("PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE='reserved'");
      expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    });
  });

  describe('WI-10003521: an undeclared capacity contract is reported at launch, not an hour in', () => {
    // Manual runs take the contract from the LAUNCHING process. On 2026-09-27 that was the
    // staging operator, whose unit had no capacity drop-in: runs logged `mode=shared
    // maxForks=2`, lane-stateful got one fork and ran 55 min and then >86 min (killed by the
    // 3h backstop, no verdict) while scheduled runs at reserved took ~20. The launch reply said
    // nothing. These pin that the silent fallback is now named in the reply.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(['shared', 'reserved'] as const)('a declared %s contract is honoured without a warning', (mode) => {
      const r = resolveCheckpointCapacity(undefined, { [CHECKPOINT_CAPACITY_MODE_ENV]: mode });
      expect(r).toEqual({ mode, source: 'process-env', declared: mode, warning: null });
    });

    it('the caller extraEnv wins over the launching process env', () => {
      const r = resolveCheckpointCapacity(
        { [CHECKPOINT_CAPACITY_MODE_ENV]: 'reserved' },
        { [CHECKPOINT_CAPACITY_MODE_ENV]: 'shared' },
      );
      expect(r.mode).toBe('reserved');
      expect(r.source).toBe('extraEnv');
      expect(r.warning).toBeNull();
    });

    it('an undeclared contract falls back to shared AND says so', () => {
      const r = resolveCheckpointCapacity(undefined, {});
      expect(r.mode).toBe('shared');
      expect(r.source).toBe('default');
      expect(r.declared).toBeNull();
      expect(r.warning).toMatch(/CAPACITY/);
      expect(r.warning).toContain(CHECKPOINT_CAPACITY_MODE_ENV);
      expect(r.warning).toMatch(/SHARED/);
    });

    it.each(['RESERVED', '8', ''])('an unrecognised value %j is reported as invalid, not honoured', (bad) => {
      const r = resolveCheckpointCapacity(undefined, { [CHECKPOINT_CAPACITY_MODE_ENV]: bad });
      expect(r.mode).toBe('shared');
      expect(r.source).toBe('invalid');
      expect(r.declared).toBe(bad);
      expect(r.warning).toMatch(/DROPPED/);
    });

    it('a launch with no declared contract carries the warning on its result and forwards nothing', async () => {
      vi.stubEnv(CHECKPOINT_CAPACITY_MODE_ENV, undefined);
      const child = fakeChild();
      const spawnFn = vi.fn(() => child) as never;
      const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
      child.emit('close', 0);
      const r = await p;
      expect(r.launched).toBe(true);
      expect(r.capacity?.source).toBe('default');
      expect(r.capacity?.warning).toMatch(/SHARED/);
      expect(r.argv.at(-1)).not.toContain(CHECKPOINT_CAPACITY_MODE_ENV);
    });

    it('a launch under a reserved launcher reports it and forwards it', async () => {
      vi.stubEnv(CHECKPOINT_CAPACITY_MODE_ENV, 'reserved');
      const child = fakeChild();
      const spawnFn = vi.fn(() => child) as never;
      const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
      child.emit('close', 0);
      const r = await p;
      expect(r.capacity).toEqual({ mode: 'reserved', source: 'process-env', declared: 'reserved', warning: null });
      expect(r.argv.at(-1)).toContain(`${CHECKPOINT_CAPACITY_MODE_ENV}='reserved'`);
    });
  });

  it('forwards PAPERCUSP_PARTIAL_GREEN_GATE when armed — a manual checkpoint then uses the same longest-green-prefix FF as the periodic gate', () => {
    const inner = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin:/bin', true).at(-1)!;
    expect(inner).toContain("PAPERCUSP_PARTIAL_GREEN_GATE='1'");
    expect(inner).toContain('apps/operator/lib/release/green-checkpoint.ts');
    expect(inner).toContain("PAPERCUSP_INTEGRATION_ROOT='/tree'");
  });

  /**
   * WI-4494 — THE REGRESSION THAT CAUSED THE 10h PIPELINE FREEZE.
   *
   * A detached manual run ran the full suite, produced a real green/red, and discarded it, because
   * nothing ever told it WHOSE gate it was judging. Meanwhile it held the run-lock, so the hourly
   * routine — the only thing that DID record — got `skipped-locked` on three consecutive fires and
   * recorded nothing either. gate_health froze on a stale red; the release pin sat unmoved ~10h.
   *
   * A detached unit inherits none of the launcher's env, so the stamp must be explicit --setenv or
   * the run silently declines to record and we are right back where we started.
   */
  it('⭐ stamps the record target so a MANUAL run records its own verdict instead of discarding it', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, undefined, {
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
    });
    expect(argv).toContain('--setenv=PAPERCUSP_GATE_VERDICT_WORKSPACE=papercusp-workspace');
    expect(argv).toContain('--setenv=PAPERCUSP_GATE_VERDICT_HARNESS=papercusp');
  });

  it('stamps nothing without a target — the run then does not record and its caller does (pre-WI-4494 behaviour)', () => {
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin', false, undefined, null);
    expect(argv.some((a) => a.includes('GATE_VERDICT'))).toBe(false);
  });

  it('P-003: transports the logical attempt id so the producer settles the exact transaction', () => {
    const argv = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin',
      false,
      undefined,
      { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' },
      'shared',
      undefined,
      'attempt-123',
    );
    expect(argv).toContain(`--setenv=${CHECKPOINT_QUALIFICATION_ATTEMPT_ENV}=attempt-123`);

    const rejected = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin',
      false,
      undefined,
      null,
      'shared',
      undefined,
      "bad'; touch /tmp/pwned; '",
    );
    expect(rejected.some((arg) => arg.includes(CHECKPOINT_QUALIFICATION_ATTEMPT_ENV))).toBe(false);
    expect(rejected.join(' ')).not.toContain('touch /tmp/pwned');
  });

  it('P-001: transports the stable gate-fire identity into the detached producer', () => {
    const argv = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin',
      false,
      undefined,
      { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' },
      'shared',
      undefined,
      undefined,
      'fire-123',
    );

    expect(argv).toContain(`--setenv=${GATE_FIRE_ID_ENV}=fire-123`);
  });

  it('P-001: drops an invalid gate-fire identity rather than shell-forwarding it', () => {
    const argv = buildCheckpointSystemdArgv(
      '/tree',
      '/tmp/cp.log',
      '/usr/bin',
      false,
      undefined,
      { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' },
      'shared',
      undefined,
      undefined,
      "bad'; touch /tmp/pwned; '",
    );

    expect(argv.some((arg) => arg.includes(GATE_FIRE_ID_ENV))).toBe(false);
    expect(argv.join(' ')).not.toContain('touch /tmp/pwned');
  });
});

describe('checkpointCandidateContainsAncestor (EI-21047439235631660)', () => {
  const REQUIRED = '65b369adb8a9eb3fd7a2e3a93ab4eaedcad7c35e';
  const CANDIDATE = '7490aaa814f1e2f6513bb8467e13acccf1ccace6';

  function gitExec(mergeBaseStatus: number, missing?: 'ancestor' | 'candidate') {
    return vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        const ref = args.at(-1) ?? '';
        if (missing === 'ancestor' && ref.startsWith(REQUIRED)) return { status: 1, stdout: '', stderr: '' };
        if (missing === 'candidate' && ref.startsWith(CANDIDATE)) return { status: 1, stdout: '', stderr: '' };
        return {
          status: 0,
          stdout: `${ref.startsWith(REQUIRED) ? REQUIRED : CANDIDATE}\n`,
          stderr: '',
        };
      }
      if (args.includes('merge-base')) return { status: mergeBaseStatus, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
  }

  it('requires merge-base ancestry exit 0 — byte-similar detached repair lineage is not enough', () => {
    const execFn = gitExec(1);
    expect(checkpointCandidateContainsAncestor('/tree', REQUIRED, CANDIDATE, execFn)).toEqual({
      ok: false,
      reason: 'not-ancestor',
      requiredAncestor: REQUIRED,
      candidate: CANDIDATE,
    });
    expect(execFn).toHaveBeenCalledWith('git', ['-C', '/tree', 'merge-base', '--is-ancestor', REQUIRED, CANDIDATE]);
  });

  it('accepts only a resolved candidate that contains the resolved required ancestor', () => {
    expect(checkpointCandidateContainsAncestor('/tree', REQUIRED, CANDIDATE, gitExec(0))).toEqual({
      ok: true,
      reason: 'contained',
      requiredAncestor: REQUIRED,
      candidate: CANDIDATE,
    });
  });

  it.each(['ancestor', 'candidate'] as const)(
    'fails closed as unverifiable when the %s object is absent',
    (missing) => {
      expect(checkpointCandidateContainsAncestor('/tree', REQUIRED, CANDIDATE, gitExec(1, missing))).toMatchObject({
        ok: false,
        reason: 'unverifiable',
      });
    },
  );
});

/** A fake ChildProcess whose close/error we drive. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  ee.stderr = new EventEmitter();
  return ee;
}

// The production default census is intentionally fail-closed and may spend up to its bounded
// procfs budget on a busy host. Launch tests that are about the systemd/run-lock paths inject a
// deterministic clear census so they do not accidentally become host-load tests. Authority
// regressions below pass their own reader through the final positional seam.
const noPreLockAuthority = () => ({
  active: false,
  probeFailed: false,
  pid: null,
  startedAtMs: null,
  elapsedSec: null,
  cgroupPath: null,
  workspace: null,
  harness: null,
});

/**
 * WI-10005268: the production default exec now runs its probes off the event loop (async), so a
 * test that omits `execFn` would reach `spawnFn` a few ticks late and miss the fake child's events
 * it emits right after the call. Answer exactly what the real host answered for '/tree' (captured
 * 2026-10-02): an unknown systemd unit, and no git repository at the root.
 */
const inertLaunchExec: ExecSyncLike = (cmd) =>
  cmd === 'systemctl'
    ? {
        status: 0,
        stdout: 'MainPID=0\nExecMainStartTimestamp=\nLoadState=not-found\nActiveState=inactive\nInvocationID=\n',
        stderr: '',
      }
    : { status: 128, stdout: '', stderr: "fatal: cannot change to '/tree': No such file or directory\n" };

function launchDetachedCheckpoint(
  ...args: [
    Parameters<typeof launchDetachedCheckpointImpl>[0]?,
    Parameters<typeof launchDetachedCheckpointImpl>[1]?,
    Parameters<typeof launchDetachedCheckpointImpl>[2]?,
    Parameters<typeof launchDetachedCheckpointImpl>[3]?,
    Parameters<typeof launchDetachedCheckpointImpl>[4]?,
    Parameters<typeof launchDetachedCheckpointImpl>[5]?,
    Parameters<typeof launchDetachedCheckpointImpl>[6]?,
    Parameters<typeof launchDetachedCheckpointImpl>[7]?,
  ]
): ReturnType<typeof launchDetachedCheckpointImpl> {
  const [
    opts,
    spawnFn,
    execFn,
    readLogHead,
    cancelStaleAwaits,
    recordDisplacement,
    readProcessAuthority,
    recordGateFire,
  ] = args;
  return launchDetachedCheckpointImpl(
    opts,
    spawnFn,
    execFn ?? inertLaunchExec,
    readLogHead,
    cancelStaleAwaits,
    recordDisplacement,
    readProcessAuthority ?? noPreLockAuthority,
    recordGateFire ?? (async () => {}),
  );
}

describe('launchDetachedCheckpoint', () => {
  it('resolves launched:true when systemd-run exits 0', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('close', 0);
    const r = await p;
    expect(r.launched).toBe(true);
    expect(r.unit).toBe(checkpointUnitForRoot('/tree'));
    expect(spawnFn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([`--unit=${checkpointUnitForRoot('/tree')}`]),
    );
  });

  it('uses the injected gate-fire writer without opening a database connection', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const recordGateFire = vi.fn(async () => {});
    const target = { workspaceId: 'test-workspace', installSlug: 'test-install' };
    const p = launchDetachedCheckpoint(
      { root: '/tree', target },
      spawnFn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordGateFire,
    );

    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    expect(recordGateFire).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ route: 'detached', root: '/tree', unit: checkpointUnitForRoot('/tree') }),
    );
  });

  it('EI-256693: preserves a caller-reserved runner ID through detached CLI and gate-fire recording', async () => {
    const gateFireId = 'manual-runner-fire-1';
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const recordGateFire = vi.fn(async () => {});
    const target = { workspaceId: 'test-workspace', installSlug: 'test-install' };
    const p = launchDetachedCheckpoint(
      { root: '/tree', target, gateFireId },
      spawnFn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordGateFire,
    );

    child.emit('close', 0);
    const result = await p;

    expect(result.launched).toBe(true);
    expect(result.argv).toContain(`--setenv=PAPERCUSP_GATE_FIRE_ID=${gateFireId}`);
    expect(recordGateFire).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ gateFireId }),
    );
  });

  it('resolves launched:false with a reason when the unit already exists (non-zero exit)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.stderr.emit('data', 'Unit papercup-green-checkpoint-manual.service already exists.');
    child.emit('close', 1);
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/already/i);
  });

  it('resolves launched:false on a spawn error', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn);
    child.emit('error', new Error('systemd-run not found'));
    const r = await p;
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it('EI-211596: binds willJudge and argv to the explicit candidate instead of re-resolving it', async () => {
    const candidate = 'a'.repeat(40);
    const movingTip = 'f'.repeat(40);
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = vi.fn(() => ({ status: 0, stdout: movingTip, stderr: '' }));
    const p = launchDetachedCheckpoint({ root: '/tree', force: true, candidate }, spawnFn, execFn);
    child.emit('close', 0);
    const r = await p;
    expect(r).toMatchObject({ launched: true, willJudge: { candidate, tip: movingTip } });
    expect(r.argv.at(-1)).toContain(`green-checkpoint.ts --candidate '${candidate}'`);
    expect(r.argv.at(-1)).toContain("--candidate-source 'tip'");
  });

  it.each(['pinned', 'tip', 'frozen-repair-queue', 'current-quiet-cut'] as const)(
    'EI-224436: reports the exact %s source in willJudge and argv',
    async (candidateSource) => {
      const candidate = 'b'.repeat(40);
      const child = fakeChild();
      const spawnFn = vi.fn(() => child) as never;
      const execFn = vi.fn(() => ({ status: 0, stdout: candidate, stderr: '' }));

      const p = launchDetachedCheckpoint(
        { root: '/tree', force: true, candidate, candidateSource },
        spawnFn,
        execFn,
      );
      child.emit('close', 0);
      const result = await p;

      expect(result).toMatchObject({ launched: true, willJudge: { candidate, candidateSource } });
      expect(result.argv.at(-1)).toContain(`--candidate '${candidate}' --candidate-source '${candidateSource}'`);
    },
  );

  it('EI-211596: rejects an invalid explicit candidate before spawn', async () => {
    const spawnFn = vi.fn();
    const r = await launchDetachedCheckpoint(
      { root: '/tree', force: true, candidate: "bad'; touch /tmp/pwned; '" },
      spawnFn as never,
    );
    expect(r).toMatchObject({ launched: false, reason: 'invalid_candidate', argv: [] });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('uses the routed subject root for probes while launching the tooling command from its own root', async () => {
    const candidate = 'a'.repeat(40);
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = vi.fn((_cmd: string, _args: string[]) => ({
      status: 0,
      stdout: candidate,
      stderr: '',
    }));

    const p = launchDetachedCheckpoint(
      {
        root: '/papercusp-tooling',
        integrationRoot: '/portal-subject',
        extraEnv: { PAPERCUSP_RELEASE_SLUG: 'portal' },
        clearEnv: ['DATABASE_URL'],
        target: { workspaceId: 'portal-workspace', installSlug: 'portal' },
        force: true,
        candidate,
      },
      spawnFn,
      execFn,
    );
    child.emit('close', 0);
    const result = await p;

    expect(result.launched).toBe(true);
    expect(result.unit).toBe(checkpointUnitForRoot('/portal-subject'));
    expect(execFn).toHaveBeenCalledWith('git', expect.arrayContaining(['-C', '/portal-subject']));
    expect(spawnFn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([
        `--unit=${checkpointUnitForRoot('/portal-subject')}`,
        '--working-directory=/papercusp-tooling',
        '--setenv=PAPERCUSP_RELEASE_SLUG=portal',
      ]),
    );
    expect(result.argv.at(-1)).toContain("PAPERCUSP_INTEGRATION_ROOT='/portal-subject'");
    expect(result.argv.at(-1)).toContain("unset 'DATABASE_URL' &&");
  });
});

// WI-1562: a second manual fire while one was already active used to only find out via
// systemd-run's own exit-1 (a bare string) — these assert the PROACTIVE structured check, and
// that launchDetachedCheckpoint refuses WITHOUT even attempting the spawn when it's active.
describe('checkActiveCheckpointRun (WI-1562 refuse-when-active detection)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }

  it('reports active:false when the unit is not active', () => {
    const execFn = fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('records the exact user-manager query and typed LoadState/InvocationID provenance', () => {
    const unit = checkpointUnitForRoot('/tree');
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({
        ActiveState: 'active',
        LoadState: 'loaded',
        InvocationID: 'invocation-123',
        ExecMainStartTimestamp: '',
        MainPID: '0',
      }),
      () => null,
    );

    expect(r.systemd).toEqual({
      scope: 'user',
      argv: [
        '--user',
        'show',
        `${unit}.service`,
        '--property=ActiveState',
        '--property=ExecMainStartTimestamp',
        '--property=MainPID',
        '--property=LoadState',
        '--property=InvocationID',
      ],
      load_state: 'loaded',
      known: true,
      invocation_id: 'invocation-123',
    });
  });

  it('keeps a not-found unit distinct from an unavailable LoadState', () => {
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({ ActiveState: 'inactive', LoadState: 'not-found', InvocationID: '' }),
      () => null,
    );
    expect(r.systemd).toMatchObject({ load_state: 'not-found', known: false, invocation_id: null });
  });

  it('keeps a trusted inactive unit inactive when its stable log has an exact valid result marker', () => {
    const unit = checkpointUnitForRoot('/tree');
    const readLogTail = vi.fn(
      () =>
        '__GREEN_CHECKPOINT_RESULT__ ' +
        JSON.stringify({ advanced: false, candidate: 'abc123', from: null, green: null, reason: 'not-green' }),
    );
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' }),
      () => null,
      undefined,
      undefined,
      undefined,
      readLogTail,
    );

    expect(r).toMatchObject({ active: false, unit, terminal_marker: true });
    expect(readLogTail).toHaveBeenCalledWith(`/tmp/${unit}.log`);
  });

  it('exposes a readable no-verdict log without treating the finished unit as active', () => {
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' }),
      () => null,
      undefined,
      undefined,
      undefined,
      vi.fn(() => '[green-checkpoint] GREEN_CHECKPOINT_CAPACITY mode=shared'),
    );

    expect(r).toMatchObject({ active: false, terminal_marker: false });
  });

  it('EI-210996: exposes systemd-owned OOM terminal evidence as abnormal and candidate-bound', () => {
    const log = [
      '[green-checkpoint] checkpointing candidate 1f64eb2d (base abc12345)',
      `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=oom-kill exit_code=killed exit_status=KILL`,
    ].join('\n');
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' }),
      () => null,
      undefined,
      undefined,
      undefined,
      vi.fn(() => log),
    );

    expect(r).toMatchObject({
      active: false,
      terminal_marker: false,
      terminal_evidence: {
        source: 'systemd-exec-stop-post',
        candidate: '1f64eb2d',
        service_result: 'oom-kill',
        exit_code: 'killed',
        exit_status: 'KILL',
        abnormal: true,
      },
    });
  });

  it('EI-210996: rejects literal printf placeholders instead of inventing abnormal terminal evidence', () => {
    const log = [
      '[green-checkpoint] checkpointing candidate 1f64eb2d (base abc12345)',
      `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=%s exit_code=%s exit_status=%s`,
    ].join('\n');
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' }),
      () => null,
      undefined,
      undefined,
      undefined,
      vi.fn(() => log),
    );

    expect(r).toMatchObject({ active: false, terminal_marker: false });
    expect(r).not.toHaveProperty('terminal_evidence');
  });

  it('binds an idle manual terminal to its own log vintage rather than probe time', () => {
    const oldLogAt = Date.parse('2026-10-06T06:21:06Z');
    const r = checkActiveCheckpointRun(
      '/tree', fakeSystemctlShow({ ActiveState: 'inactive' }), () => null,
      undefined, undefined, undefined,
      () => '[green-checkpoint] checkpointing candidate abc12345\n' +
        `${GREEN_CHECKPOINT_SYSTEMD_TERMINAL_MARKER} service_result=exit-code exit_code=exited exit_status=137`,
      undefined, () => oldLogAt,
    );
    expect(r.terminal_evidence).toMatchObject({ candidate: 'abc12345', observed_at_ms: oldLogAt, exit_status: '137' });
  });

  it('reports active:true with started_at, a null no-ceiling eta_sec, and the parsed candidate when the unit is active', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // started 5 min ago
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt })();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: '98817077fd79af9dfee00076a1c6e90445d268af\n', stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n...');
    const r = checkActiveCheckpointRun('/tree', execFn, readLogHead);

    expect(r.active).toBe(true);
    expect(r.unit).toBe(checkpointUnitForRoot('/tree'));
    expect(r.log_path).toBe(`/tmp/${checkpointUnitForRoot('/tree')}.log`);
    expect(r.candidate).toBe('98817077');
    expect(r.current_head).toBe('98817077fd79af9dfee00076a1c6e90445d268af');
    expect(r.current_candidate).toBe('98817077fd79af9dfee00076a1c6e90445d268af');
    expect(r.candidate_stale).toBe(false);
    expect(r.started_at).toBe(startedAt);
    // WI-6554700010042457 phase 1b: no run-level wall clock exists, so there is no countdown.
    expect(r.eta_sec).toBeNull();
    expect(r.eta_basis).toBe('no-ceiling');
    expect(readLogHead).toHaveBeenCalledWith(`/tmp/${checkpointUnitForRoot('/tree')}.log`);
  });

  it('reports advancing log progress instead of treating started_at as the heartbeat', () => {
    const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const logProgress = new Date(Date.now() - 15_000).toISOString();
    const phase = vi.fn(() => ({ phase: 'suite' as const, at: new Date(Date.now() - 30_000).toISOString() }));
    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => `${logProgress} checkpointing candidate 98817077 (base 94b17b25)\n`,
      undefined,
      undefined,
      phase,
      () => `${logProgress} checkpointing candidate 98817077 (base 94b17b25)\n`,
      undefined,
      () => null,
    );

    expect(r.progress_at).toBe(logProgress);
    expect(r.current_phase).toBe('suite');
    expect(Date.parse(r.progress_at!)).toBeGreaterThan(Date.parse(startedAt));
  });

  it('uses the advancing log mtime when runner output has no timestamp', () => {
    const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const progressAt = Date.now() - 10_000;
    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n',
      undefined,
      undefined,
      () => ({ phase: 'suite' as const, at: new Date(Date.now() - 30_000).toISOString() }),
      () => '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n',
      undefined,
      () => progressAt,
    );

    expect(r.progress_at).toBe(new Date(progressAt).toISOString());
  });

  it('does not report the full-suite remainder as ETA after the run enters delivering', () => {
    const startedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    const phase = vi.fn(() => ({ phase: 'delivering' as const, at: new Date().toISOString() }));
    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n',
      undefined,
      undefined,
      phase,
    );

    expect(r).toMatchObject({
      active: true,
      delivering: true,
      current_phase: 'delivering',
      eta_sec: null,
      eta_basis: 'delivery-phase',
    });
    expect(phase).toHaveBeenCalled();
  });

  /**
   * EI-19327704778173646 — recurrence guard.
   *
   * A single green-checkpoint run can legitimately change the candidate it judges: on a stale
   * red it recurses into `runGreenCheckpoint({ candidate: tip, refireAttempts: +1 })` IN-PROCESS
   * and re-enters `setupTree`, so the run emits a SECOND `checkpointing candidate` line while
   * pid/started_at never move. Parsing the FIRST match therefore reported the ABANDONED sha for
   * the rest of the run, while the tool's own prose told callers to verify their fix against
   * it. That false negative produced several public retractions on 2026-08-02.
   *
   * The fixture below mirrors a REAL log measured on this box that day
   * (`papercup-green-checkpoint-manual-1fxzuva-2026-08-02T08-37-45-565Z.log`): candidate
   * `14fb28da` at byte 177, `auto-refiring (attempt 1/2)`, then `4961cfb8` at byte 2281.
   * Both were inside the 4KB head window — i.e. the defect is the first-match parse, NOT the
   * window size, and it bites at any log size.
   *
   * Asserted against a synthetic log on purpose: the whole point of the bug is that LIVE
   * observation of this field is what misled five agents, so a live gate run cannot verify it.
   */
  const refireSetup = (startedAt: string) =>
    vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt })();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: '98817077fd79af9dfee00076a1c6e90445d268af\n', stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

  it('reports the LAST candidate, not the abandoned first, when a run auto-refired mid-flight', () => {
    const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    // Shas are the ones actually observed in the 2026-08-02 08:37Z run log.
    const head = '[green-checkpoint] checkpointing candidate 14fb28da (base 94b17b25)\n';
    const tail = [
      '[green-checkpoint] red at 14fb28da; re-running 1 non-test gate(s) at tip 4961cfb8: lint:tsc',
      '[green-checkpoint] re-triage: stale — gate passes at tip; auto-refiring (attempt 1/2)',
      '[green-checkpoint] checkpointing candidate 4961cfb8 (base 94b17b25)',
    ].join('\n');

    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => head,
      undefined,
      undefined,
      undefined,
      () => tail,
    );

    // The sha actually being judged now — NOT the one the run started on and discarded.
    expect(r.candidate).toBe('4961cfb8');
    // Provenance, so a caller reading the status twice sees a documented move rather than
    // concluding the field is corrupt and firing a manual run over it.
    expect(r.initial_candidate).toBe('14fb28da');
    expect(r.refire_observed).toBe(true);
  });

  it('omits refire provenance entirely when the run never re-candidated (unchanged reply shape)', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const log = '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\nrunning suite...\n';

    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => log,
      undefined,
      undefined,
      undefined,
      () => log,
    );

    expect(r.candidate).toBe('98817077');
    // The common case must stay byte-for-byte what it was before this fix.
    expect(r.refire_observed).toBeUndefined();
    expect(r.initial_candidate).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r, 'initial_candidate')).toBe(false);
  });

  it('degrades to the head-parsed candidate when the log tail cannot be read', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const head = '[green-checkpoint] checkpointing candidate 98817077 (base 94b17b25)\n';

    // Missing / mid-rotation / unreadable log => null, exactly the pre-EI behaviour.
    const r = checkActiveCheckpointRun(
      '/tree',
      refireSetup(startedAt),
      () => head,
      undefined,
      undefined,
      undefined,
      () => null,
    );

    expect(r.candidate).toBe('98817077');
    expect(r.refire_observed).toBeUndefined();
  });

  it('parseCheckpointCandidates returns every candidate in emission order', () => {
    expect(parseCheckpointCandidates(null)).toEqual([]);
    expect(parseCheckpointCandidates('no candidate lines here')).toEqual([]);
    expect(
      parseCheckpointCandidates('checkpointing candidate aaa1 (base x)\n...\ncheckpointing candidate bbb2 (base x)\n'),
    ).toEqual(['aaa1', 'bbb2']);
  });

  it('marks an active run stale when its log candidate differs from the current quiet-cut candidate', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt })();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('ready')) return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const r = checkActiveCheckpointRun(
      '/tree',
      execFn,
      () => `[green-checkpoint] checkpointing candidate ${oldCandidate.slice(0, 8)} (base def)\n`,
    );

    expect(r).toMatchObject({
      active: true,
      candidate: oldCandidate.slice(0, 8),
      current_head: currentHead,
      current_candidate: quietCandidate,
      candidate_stale: true,
      quiet_cut_sec: 240,
    });
  });

  it('treats activating/reloading as active too, and tolerates an unreadable log (candidate:null)', () => {
    const execFn = fakeSystemctlShow({ ActiveState: 'activating', ExecMainStartTimestamp: '' });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r.active).toBe(true);
    expect(r.candidate).toBeNull();
    expect(r.started_at).toBeNull();
    expect(r.eta_sec).toBeNull();
  });

  // WI-6962: the probe used to fail OPEN — any systemctl failure parsed to `ActiveState=''`,
  // fell through the active test, and returned active:false, so the launcher spawned straight
  // over a live 8-fork suite (systemd REPLACES a same-named transient unit rather than
  // refusing). These pin the distinction the old code could not express: a TRUSTED negative
  // vs. "I could not tell".
  describe('WI-6962 — an untrustworthy probe must not read as "nothing is running"', () => {
    it('anchors the premise: a well-formed negative carries an ActiveState key (measured against real systemctl)', () => {
      // `systemctl --user show <unknown-unit>` exits 0 with ActiveState=inactive/MainPID=0.
      // That is what makes a MISSING key decisive evidence of a failed probe rather than idleness.
      const execFn = fakeSystemctlShow({ ActiveState: 'inactive', MainPID: '0' });
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r.active).toBe(false);
      expect(r.probe_failed).toBeUndefined();
    });

    it('fails CLOSED when systemctl exits non-zero (host too starved to fork)', () => {
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus' }));
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r.active).toBe(true);
      expect(r.probe_failed).toBe(true);
      expect(r.probe_detail).toContain('Failed to connect to bus');
      // Never replaceable: we cannot know the candidate, so nothing may stop the run.
      expect(r.candidate_stale).toBe(false);
    });

    it('fails CLOSED when spawnSync itself failed (status null, empty output)', () => {
      const execFn = vi.fn(() => ({ status: null, stdout: '', stderr: '' }));
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r).toMatchObject({ active: true, probe_failed: true });
    });

    it('bounds a slow systemctl probe and still fails closed through the run-lock fallback', () => {
      const startedAt = new Date(Date.now() - 9 * 60_000).toISOString();
      const execFn = vi.fn((_cmd: string, _args: string[], options?: { timeout?: number }) => {
        expect(options).toEqual({ timeout: CHECKPOINT_SYSTEMCTL_PROBE_TIMEOUT_MS });
        return { status: null, stdout: '', stderr: '' };
      });
      const r = checkActiveCheckpointRun(
        '/tree',
        execFn,
        () => null,
        () => true,
        () => ({ pid: 4242, startedAt }),
        undefined,
        undefined,
        () => null, // readProcessStartMs: synthetic PID has no procfs identity
      );

      expect(r).toMatchObject({
        active: true,
        probe_failed: true,
        held_externally: true,
        started_at: startedAt,
      });
      expect(execFn).toHaveBeenCalledWith('systemctl', expect.any(Array), {
        timeout: CHECKPOINT_SYSTEMCTL_PROBE_TIMEOUT_MS,
      });
    });

    it('fails CLOSED when the output parses but carries no ActiveState key', () => {
      // The exact shape the old `props.ActiveState ?? ''` silently turned into a confident
      // "inactive": a reply that succeeded but did not answer the question asked.
      const execFn = fakeSystemctlShow({ MainPID: '0' });
      const r = checkActiveCheckpointRun('/tree', execFn, () => null);
      expect(r).toMatchObject({ active: true, probe_failed: true });
    });

    it('still reports the run-lock holder when the probe fails but the lock IS held', () => {
      const startedAt = new Date(Date.now() - 9 * 60_000).toISOString();
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
      const r = checkActiveCheckpointRun(
        '/tree',
        execFn,
        () => null,
        () => true, // pidAlive
        () => ({ pid: 4242, startedAt }),
        undefined,
        undefined,
        () => null, // readProcessStartMs: synthetic PID has no procfs identity
      );
      expect(r).toMatchObject({ active: true, probe_failed: true, held_externally: true, started_at: startedAt });
      expect(r.elapsed_sec).toBeGreaterThanOrEqual(9 * 60 - 5);
    });

    it('launchDetachedCheckpoint REFUSES on an indeterminate probe and never spawns', async () => {
      const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'bus error' }));
      const spawnFn = vi.fn();
      const r = await launchDetachedCheckpoint({ root: '/tree' }, spawnFn as never, execFn, () => null);
      expect(r.launched).toBe(false);
      expect(r.reason).toBe('probe_failed');
      expect(r.alreadyRunning?.probe_failed).toBe(true);
      // The whole point: no process was started over a possibly-live suite.
      expect(spawnFn).not.toHaveBeenCalled();
    });
  });
});

// WI-5685: the manual unit only ever sees ITSELF — a cron-invoked run (spawned as a plain
// child by release-actions.ts's runScript, no systemd unit involved at all) is completely
// invisible to checkActiveCheckpointRun's systemd probe. Evidence: two manual
// release:checkpoint-run fires both got launched:true (the probe said "nothing active") and
// then exited skipped-locked from WITHIN the detached process a moment later, because the
// shared file-based run-lock was already held by the hourly cron tick. These assert the
// fallback that closes that blind spot: cross-check the run-lock's own owner.json whenever
// the manual-unit probe comes back inactive.
describe('checkActiveCheckpointRun run-lock fallback (WI-5685: the cron-holds-the-lock blind spot)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }
  const inactiveUnit = fakeSystemctlShow({ ActiveState: 'inactive', ExecMainStartTimestamp: '' });

  it('reports active:true (held_externally) when the manual unit is idle but a live process holds the shared run-lock', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const checkpointHead = 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const integrationHead = '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // Distinguish the two `-C <root>` targets by their actual path — `/tree` (the integration
    // root, via currentCheckpointCandidate) vs `/tree-checkpoint` (the isolated checkpoint
    // checkout, via checkpointRootMirror) — a mock that ignored `-C` would mask exactly the
    // EI-18695275971973546 bug (candidate silently reported as the wrong tree's HEAD).
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return inactiveUnit();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD') {
        const root = args[args.indexOf('-C') + 1];
        if (root === '/tree-checkpoint') return { status: 0, stdout: `${checkpointHead}\n`, stderr: '' };
        return { status: 0, stdout: `${integrationHead}\n`, stderr: '' };
      }
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const pidAlive = vi.fn(() => true);
    const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

    const r = checkActiveCheckpointRun(
      '/tree',
      execFn,
      () => null,
      pidAlive,
      readLockOwner,
      undefined,
      undefined,
      () => null, // readProcessStartMs: synthetic PID has no procfs identity
    );

    expect(r.active).toBe(true);
    expect(r.held_externally).toBe(true);
    // EI-18695275971973546: `candidate` resolves to the CHECKPOINT tree's HEAD — the real
    // in-flight candidate — never the integration root's (which is only "if launched now").
    expect(r.candidate).toBe(checkpointHead);
    expect(r.current_head).toBe(integrationHead);
    expect(r.current_candidate).toBe(integrationHead);
    expect(r.candidate_stale).toBe(false); // never replaceable — EI-11667 safety, regardless of resolution
    expect(r.started_at).toBe(startedAt);
    expect(r.elapsed_sec).toBeGreaterThan(0);
    expect(r.eta_sec).toBeNull();
    expect(r.eta_basis).toBe('no-ceiling');
    expect(pidAlive).toHaveBeenCalledWith(4242);
  });

  it('EI-18695275971973546: candidate stays null (never crashes) when the checkpoint tree is unreadable — e.g. mid-checkout', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return inactiveUnit();
      // Every git call fails — mirrors a checkpoint tree that doesn't exist yet / mid-setup.
      return { status: 1, stdout: '', stderr: 'not a git repository' };
    });
    const pidAlive = vi.fn(() => true);
    const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

    const r = checkActiveCheckpointRun(
      '/tree',
      execFn,
      () => null,
      pidAlive,
      readLockOwner,
      undefined,
      undefined,
      () => null, // readProcessStartMs: synthetic PID has no procfs identity
    );

    expect(r.held_externally).toBe(true);
    expect(r.candidate).toBeNull();
    expect(r.candidate_stale).toBe(false);
  });

  it('keeps a cron-held delivering run from exposing the full-suite remainder as ETA', () => {
    const startedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return inactiveUnit();
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: 'checkpoint-head\n', stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 500), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const r = checkActiveCheckpointRun(
      '/tree',
      execFn,
      () => null,
      () => true,
      () => ({ pid: 4242, startedAt }),
      () => ({ phase: 'delivering', at: new Date().toISOString() }),
      undefined,
      () => null, // readProcessStartMs: synthetic PID has no procfs identity
    );

    expect(r).toMatchObject({
      active: true,
      held_externally: true,
      delivering: true,
      eta_sec: null,
      eta_basis: 'delivery-phase',
    });
  });

  it('reports active:false when the run-lock file is missing/unreadable (the common case — nothing running)', () => {
    const execFn = inactiveUnit;
    const readLockOwner = vi.fn(() => null);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, undefined, readLockOwner);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('reports active:false when the lock owner pid is dead (crashed holder, unreclaimed file)', () => {
    const execFn = inactiveUnit;
    const pidAlive = vi.fn(() => false);
    const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date().toISOString() }));
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive, readLockOwner);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  describe('isCheckpointRunLockHeldCheap (WI-4310: the no-subprocess sibling for hot health-panel reads)', () => {
    it('reports held:true + elapsedSec when a live process holds the run-lock', () => {
      const startedAt = new Date(Date.now() - 90_000).toISOString();
      const pidAlive = vi.fn(() => true);
      const readLockOwner = vi.fn(() => ({ pid: 4242, startedAt }));

      const r = isCheckpointRunLockHeldCheap('/tree', pidAlive, readLockOwner);

      expect(r.held).toBe(true);
      expect(r.pid).toBe(4242);
      expect(r.elapsedSec).toBeGreaterThanOrEqual(89);
      expect(pidAlive).toHaveBeenCalledWith(4242);
    });

    it('reports held:false when the lock file is missing/unreadable (no systemctl fork involved)', () => {
      const readLockOwner = vi.fn(() => null);
      const r = isCheckpointRunLockHeldCheap(
        '/tree',
        vi.fn(() => true),
        readLockOwner,
      );
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('reports held:false when the lock owner pid is dead (crashed holder, unreclaimed file)', () => {
      const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date().toISOString() }));
      const r = isCheckpointRunLockHeldCheap(
        '/tree',
        vi.fn(() => false),
        readLockOwner,
      );
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('reports held:false when a live PID started after the lock (recycled-PID identity guard)', () => {
      const lockStartedAt = Date.now() - 60_000;
      const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date(lockStartedAt).toISOString() }));
      const r = isCheckpointRunLockHeldCheap(
        '/tree',
        vi.fn(() => true),
        readLockOwner,
        () => Date.now(),
      );
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('reports held:false for an over-age live PID when procfs identity is unavailable', () => {
      const lockStartedAt = Date.now() - CHECKPOINT_RUN_LOCK_STALE_MS - 1_000;
      const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date(lockStartedAt).toISOString() }));
      const r = isCheckpointRunLockHeldCheap(
        '/tree',
        vi.fn(() => true),
        readLockOwner,
        () => null,
      );
      expect(r).toEqual({ held: false, elapsedSec: null });
    });

    it('keeps a live PID whose process predates the lock', () => {
      const lockStartedAt = Date.now() - 60_000;
      const readLockOwner = vi.fn(() => ({ pid: 9999, startedAt: new Date(lockStartedAt).toISOString() }));
      const r = isCheckpointRunLockHeldCheap(
        '/tree',
        vi.fn(() => true),
        readLockOwner,
        () => lockStartedAt - 60_000,
      );
      expect(r.held).toBe(true);
      expect(r.elapsedSec).toBeGreaterThanOrEqual(59);
    });

    it('never shells out — no execFn/systemctl seam exists on this probe at all', () => {
      // Type-level assertion as much as a runtime one: the whole point of this sibling is that
      // it takes no execFn, unlike checkActiveCheckpointRun. Calling it with only fs-level fakes
      // and getting a sane result IS the proof it stayed subprocess-free.
      const readLockOwner = vi.fn(() => ({ pid: process.pid, startedAt: new Date().toISOString() }));
      const r = isCheckpointRunLockHeldCheap('/tree', undefined, readLockOwner);
      expect(r.held).toBe(true);
    });
  });

  describe('readCheckpointProcessAuthorityCheap (P-009 pre-lock materialization)', () => {
    const now = Date.parse('2026-08-24T18:00:00.000Z');
    const checkpointCgroupPath = `/user.slice/user-1000.slice/user@1000.service/app.slice/${checkpointUnitForRoot('/tree')}.service`;
    const env = (over: Record<string, string> = {}) =>
      Object.entries({
        PAPERCUSP_GATE_VERDICT_WORKSPACE: 'papercusp-workspace',
        PAPERCUSP_GATE_VERDICT_HARNESS: 'papercusp',
        PAPERCUSP_INTEGRATION_ROOT: '/tree',
        ...over,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join('\0');
    const probe = (over: Parameters<typeof readCheckpointProcessAuthorityCheap>[1] = {}) =>
      readCheckpointProcessAuthorityCheap('/tree', {
        listPids: () => [4242],
        readEnvironment: () => env(),
        readCgroup: () => `0::${checkpointCgroupPath}\n`,
        readProcessStartMs: () => now - 45_000,
        nowMs: () => now,
        ...over,
      });

    it('detects a live pre-lock gate process from authority env + exact root + cgroup, without argv', async () => {
      await expect(probe()).resolves.toEqual({
        active: true,
        probeFailed: false,
        pid: 4242,
        startedAtMs: now - 45_000,
        elapsedSec: 45,
        cgroupPath: checkpointCgroupPath,
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
      });
    });

    it('rejects an unrelated agent scope even when it inherits every authority stamp', async () => {
      await expect(
        probe({
          readCgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/papercusp-agent.slice/pc-agent.scope\n',
        }),
      ).resolves.toMatchObject({ active: false, probeFailed: false, pid: null, cgroupPath: null });
    });

    it.each([
      ['workspace authority', { PAPERCUSP_GATE_VERDICT_WORKSPACE: '' }, '/tree', '0::/run-u42.scope\n'],
      ['harness authority', { PAPERCUSP_GATE_VERDICT_HARNESS: '' }, '/tree', '0::/run-u42.scope\n'],
      ['exact integration root', {}, '/other-tree', '0::/run-u42.scope\n'],
      ['unified cgroup', {}, '/tree', '2:cpu:/legacy-only\n'],
    ])('does not manufacture liveness when %s is absent', async (_label, envOver, integrationRoot, cgroup) => {
      const reading = probe({
        readEnvironment: () => env({ ...envOver, PAPERCUSP_INTEGRATION_ROOT: integrationRoot }),
        readCgroup: () => cgroup,
      });
      await expect(reading).resolves.toMatchObject({ active: false, probeFailed: false });
    });

    it('returns UNKNOWN provenance when procfs enumeration itself fails', async () => {
      const reading = probe({
        listPids: () => {
          throw new Error('proc unavailable');
        },
      });
      await expect(reading).resolves.toMatchObject({ active: false, probeFailed: true });
    });

    it('does not read environments until the cgroup proves the exact checkpoint unit', async () => {
      const readEnvironment = vi.fn((pid: number) =>
        pid === 100 ? env({ PAPERCUSP_GATE_VERDICT_HARNESS: '' }) : env(),
      );
      const readCgroup = vi.fn(() => `0::${checkpointCgroupPath}\n`);
      const reading = await probe({
        listPids: () => [100, 200],
        readEnvironment,
        readCgroup,
      });
      expect(reading.active).toBe(true);
      expect(readEnvironment).toHaveBeenCalledTimes(2);
      expect(readCgroup).toHaveBeenCalledTimes(2);
      expect(readCgroup).toHaveBeenCalledWith(100);
      expect(readCgroup).toHaveBeenCalledWith(200);
    });

    it('ignores an unrelated PID environment timeout after its cgroup excludes it', async () => {
      const unrelatedCgroup = '0::/user.slice/user-1000.slice/user@1000.service/agent.scope\n';
      const readEnvironment = vi.fn((pid: number) => {
        if (pid === 100) return new Promise<string>(() => {});
        return env();
      });
      const reading = probe({
        listPids: () => [100, 200],
        readEnvironment,
        readCgroup: (pid) => (pid === 100 ? unrelatedCgroup : `0::${checkpointCgroupPath}\n`),
        totalTimeoutMs: 100,
        perReadTimeoutMs: 5,
      });
      await expect(reading).resolves.toMatchObject({ active: true, probeFailed: false, pid: 200 });
      expect(readEnvironment).toHaveBeenCalledTimes(1);
      expect(readEnvironment).toHaveBeenCalledWith(200);
    });

    it('keeps the production broad cgroup filter inside the global budget across a host-sized PID census', async () => {
      const readEnvironment = vi.fn(() => env());
      const reading = await probe({
        // Production hosts can expose several thousand PID directories. Non-existent PIDs
        // exercise the real default cgroup reader without depending on another live process.
        listPids: () => Array.from({ length: 8_000 }, (_, index) => 9_000_000 + index),
        readCgroup: undefined,
        readEnvironment,
        totalTimeoutMs: 1_000,
      });

      expect(reading).toMatchObject({ active: false, probeFailed: false });
      expect(readEnvironment).not.toHaveBeenCalled();
    });

    it('returns UNKNOWN when one procfs read exceeds its per-read deadline', async () => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const reading = probe({
          readEnvironment: () => new Promise<string>(() => {}),
          totalTimeoutMs: 100,
          perReadTimeoutMs: 5,
        }).then((result) => { settled = true; return result; });
        await vi.advanceTimersByTimeAsync(4);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(reading).resolves.toMatchObject({ active: false, probeFailed: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns UNKNOWN when the total census budget is exhausted', async () => {
      vi.useFakeTimers();
      try {
        let settled = false;
        const reading = probe({
          readEnvironment: () => new Promise<string>(() => {}),
          totalTimeoutMs: 5,
          perReadTimeoutMs: 100,
        }).then((result) => { settled = true; return result; });
        await vi.advanceTimersByTimeAsync(4);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(reading).resolves.toMatchObject({ active: false, probeFailed: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns UNKNOWN when an async procfs dependency rejects', async () => {
      const reading = probe({
        readEnvironment: async () => {
          throw new Error('proc unavailable');
        },
      });
      await expect(reading).resolves.toMatchObject({ active: false, probeFailed: true });
    });

    it('reports the exact procfs leg when an environment read rejects', async () => {
      const reading = probe({
        readEnvironment: async (pid) => {
          throw new Error(`EACCES /proc/${pid}/environ`);
        },
      });
      await expect(reading).resolves.toMatchObject({
        active: false,
        probeFailed: true,
        probeDetail: 'environment read for pid 4242 failed: EACCES /proc/4242/environ',
      });
    });

    it('scans PID environments with bounded concurrency', async () => {
      const pids = Array.from({ length: 48 }, (_, index) => index + 1);
      let inFlight = 0;
      let maxInFlight = 0;
      const readEnvironment = vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return '';
      });

      const reading = await probe({
        listPids: () => pids,
        readEnvironment,
        maxConcurrentReads: 4,
        totalTimeoutMs: 250,
      });

      expect(reading).toMatchObject({ active: false, probeFailed: false });
      expect(readEnvironment).toHaveBeenCalledTimes(pids.length);
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(4);
    });

    it('ignores an authority-stamped residue beyond the run-lock stale horizon', async () => {
      await expect(
        probe({ readProcessStartMs: () => now - CHECKPOINT_RUN_LOCK_STALE_MS - 1_000 }),
      ).resolves.toMatchObject({ active: false, probeFailed: false });
    });
  });

  describe('readCheckpointRunPhaseCheap (EI-20378004056924553)', () => {
    it('reads phase.json from the routed per-root lock directory', () => {
      const readRunPhase = vi.fn((lockDir: string) => ({ phase: 'delivering', at: 'now' }));

      expect(readCheckpointRunPhaseCheap('/subject-root', '/subject-logs', readRunPhase)).toEqual({
        phase: 'delivering',
        at: 'now',
      });
      expect(readRunPhase).toHaveBeenCalledWith(expect.stringContaining('/subject-logs/.green-checkpoint-run-'));
      expect(readRunPhase.mock.calls[0]?.[0]).toContain('.lock');
    });

    it('returns null when the routed phase marker is unreadable', () => {
      const readRunPhase = vi.fn(() => null);
      expect(readCheckpointRunPhaseCheap('/subject-root', '/subject-logs', readRunPhase)).toBeNull();
    });
  });

  // End-to-end through the REAL fs + REAL default pidAlive (launchDetachedCheckpoint doesn't
  // expose pid/lock-owner injection seams — it always calls checkActiveCheckpointRun with just
  // execFn/readLogHead, so production wiring goes through defaultReadLockOwner + defaultPidAlive).
  // Proves the whole chain: a real owner.json under the real per-root hashed lock dir stops the
  // launch BEFORE spawnFn is ever called, using our own live pid so pidAlive is genuinely true.
  it('[integration] launchDetachedCheckpoint refuses (never calls spawnFn) when a real owner.json under the hashed lock dir names a live pid', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-lock-test-'));
    const prevEnv = process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
    process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = tmpRoot;
    try {
      const testTreeRoot = '/tree-int-test';
      let h = 0;
      for (let i = 0; i < testTreeRoot.length; i++) h = (h * 31 + testTreeRoot.charCodeAt(i)) >>> 0;
      const lockDir = path.join(tmpRoot, `.green-checkpoint-run-${h.toString(36)}.lock`);
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(
        path.join(lockDir, 'owner.json'),
        // Keep the synthetic lock acquisition after this test process's real start time;
        // a backdated timestamp would intentionally look like a recycled PID to the procfs
        // identity guard under test.
        JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 1_000).toISOString() }),
      );

      const execFn = vi.fn((cmd: string) => {
        if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
        return { status: 1, stdout: '', stderr: '' }; // git reads fail harmlessly (candidate resolution best-effort)
      });
      const spawnFn = vi.fn();

      const r = await launchDetachedCheckpoint({ root: testTreeRoot }, spawnFn as never, execFn, () => null);

      expect(spawnFn).not.toHaveBeenCalled();
      expect(r.launched).toBe(false);
      expect(r.reason).toBe('already_running');
      expect(r.alreadyRunning?.held_externally).toBe(true);
      expect(r.alreadyRunning?.candidate_stale).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.PAPERCUSP_CHECKPOINT_LOG_DIR;
      else process.env.PAPERCUSP_CHECKPOINT_LOG_DIR = prevEnv;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// EI-9180: an 18h phantom-wedge — ActiveState kept reading 'active' for a run whose process was
// already gone (host-load-starved systemd --user manager bookkeeping lag / a kill -9 outside
// systemd), so every re-fire got refused with a stable started_at/eta_sec from the dead run and
// nothing self-healed short of a manual force:true. Cross-check the unit's own reported MainPID
// with a real OS-level liveness probe; when systemd's ActiveState disagrees with reality, trust
// reality.
describe('checkActiveCheckpointRun MainPID liveness cross-check (EI-9180 self-heal)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
  }

  it('self-heals: ActiveState says active but the reported MainPID is provably dead → active:false', () => {
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: '2026-07-10T12:20:44Z',
      MainPID: '99999',
    });
    const pidAlive = vi.fn(() => false); // the PID systemd names no longer exists
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).toHaveBeenCalledWith(99999);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });

  it('checks the stable result marker on a dead MainPID and still reports active:false for a finished run', () => {
    const unit = checkpointUnitForRoot('/tree');
    const readLogTail = vi.fn(() => '__GREEN_CHECKPOINT_RESULT__ {"green":true,"reason":"up-to-date"}');
    const r = checkActiveCheckpointRun(
      '/tree',
      fakeSystemctlShow({
        ActiveState: 'active',
        ExecMainStartTimestamp: '2026-07-10T12:20:44Z',
        MainPID: '99999',
      }),
      () => null,
      () => false,
      undefined,
      undefined,
      readLogTail,
    );

    expect(r).toMatchObject({ active: false, unit, terminal_marker: true });
    expect(readLogTail).toHaveBeenCalledWith(`/tmp/${unit}.log`);
  });

  it('trusts ActiveState when the reported MainPID IS alive (the normal case)', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt, MainPID: '12345' });
    const pidAlive = vi.fn(() => true);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).toHaveBeenCalledWith(12345);
    expect(r.active).toBe(true);
  });

  it('MainPID=0 (systemd has no main process to report) skips the probe and trusts ActiveState (back-compat)', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt, MainPID: '0' });
    const pidAlive = vi.fn(() => false);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(r.active).toBe(true);
  });

  it('no MainPID property at all (older systemd / unexpected output) skips the probe and trusts ActiveState', () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
    const pidAlive = vi.fn(() => false);
    const r = checkActiveCheckpointRun('/tree', execFn, () => null, pidAlive);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(r.active).toBe(true);
  });

  it('default pidAlive probe uses kill(pid, 0): the current process (self) reads as alive', () => {
    // No injected pidAlive — exercise the real default against our OWN pid, guaranteed alive.
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: new Date().toISOString(),
      MainPID: String(process.pid),
    });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r.active).toBe(true);
  });

  it('default pidAlive probe: an implausible/reserved PID (1 is always alive as init; use a huge unused one) reads as dead', () => {
    // PID space wraps well below 2**22 on Linux; a value past any real max is guaranteed absent.
    const execFn = fakeSystemctlShow({
      ActiveState: 'active',
      ExecMainStartTimestamp: new Date().toISOString(),
      MainPID: '4194304',
    });
    const r = checkActiveCheckpointRun('/tree', execFn, () => null);
    expect(r).toMatchObject({ active: false, unit: checkpointUnitForRoot('/tree') });
  });
});

describe('launchDetachedCheckpoint refuse-when-active (WI-1562)', () => {
  it('refuses with a structured alreadyRunning detail and never calls spawnFn when a run is active', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn(() => ({
      status: 0,
      stdout: 'ActiveState=active\nExecMainStartTimestamp=2026-07-02T10:44:43Z',
      stderr: '',
    }));
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate abc12345 (base def)\n');

    const r = await launchDetachedCheckpoint({ root: '/tree' }, spawnFn as never, execFn, readLogHead);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.alreadyRunning).toMatchObject({
      active: true,
      unit: checkpointUnitForRoot('/tree'),
      candidate: 'abc12345',
      started_at: '2026-07-02T10:44:43Z',
    });
  });

  it('skips the active check and spawns anyway when force:true', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    // WI-5124: force:true still skips checkActiveCheckpointRun (no systemctl probe), but
    // execFn IS now called for the willJudge resolution (currentCheckpointCandidate) — a
    // real git response, not a bare vi.fn(), so that resolution doesn't blow up on undefined.
    // WI-5217: typed as ExecSyncLike (cmd, args) — the untyped 0-arg version below made
    // `.mock.calls.every((c) => c[0] === 'git')` at line ~355 index into an empty `[]`
    // tuple type (no recorded args), even though real calls always pass (cmd, args).
    const execFn = vi.fn((_cmd: string, _args: string[]) => ({
      status: 0,
      stdout: 'deadbeef00000000000000000000000000000000',
      stderr: '',
    }));

    const p = launchDetachedCheckpoint({ root: '/tree', force: true }, spawnFn, execFn);
    child.emit('close', 0);
    const r = await p;

    // No systemctl/active-check call landed — every execFn call is a `git -C ...` willJudge read.
    expect(execFn.mock.calls.every((c) => c[0] === 'git')).toBe(true);
    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
    expect(r.willJudge?.candidate).toBe('deadbeef00000000000000000000000000000000');
  });

  it('force collision re-probes the active unit and returns structured already_running', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const execFn = vi.fn((cmd: string) => {
      if (cmd === 'systemctl') {
        return {
          status: 0,
          stdout: `ActiveState=active\nExecMainStartTimestamp=${startedAt}\nMainPID=0`,
          stderr: '',
        };
      }
      return { status: 0, stdout: 'deadbeef00000000000000000000000000000000', stderr: '' };
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate deadbeef (base abcdef12)\n');

    const p = launchDetachedCheckpoint({ root: '/tree', force: true }, spawnFn, execFn, readLogHead);
    child.stderr.emit(
      'data',
      'Failed to start transient service unit: Unit papercup-green-checkpoint-manual-1fxzuva.service was already loaded or has a fragment file.',
    );
    child.emit('close', 1);
    const r = await p;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      launched: false,
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: checkpointUnitForRoot('/tree'),
        started_at: startedAt,
      },
    });
  });

  it('proceeds to spawn when the active check reports inactive', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = vi.fn(() => ({ status: 0, stdout: 'ActiveState=inactive', stderr: '' }));

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
  });

  it('EI-21340355513221785: refuses when the pre-lock authority census finds a live materializer', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn(() => ({ status: 0, stdout: 'ActiveState=inactive', stderr: '' }));
    const readProcessAuthority = vi.fn(async () => ({
      active: true,
      probeFailed: false,
      pid: 4242,
      startedAtMs: Date.parse('2026-08-27T10:00:00.000Z'),
      elapsedSec: 42,
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.scope',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    }));

    const r = await launchDetachedCheckpoint(
      { root: '/tree' },
      spawnFn as never,
      execFn,
      () => null,
      undefined,
      undefined,
      readProcessAuthority,
    );

    expect(readProcessAuthority).toHaveBeenCalledWith('/tree');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      launched: false,
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        candidate: null,
        current_phase: 'materializing',
        elapsed_sec: 42,
        pre_lock_authority: {
          workspace: 'papercusp-workspace',
          harness: 'papercusp',
          cgroup_path: '/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.scope',
          pid: 4242,
        },
      },
    });
  });

  it('EI-21340355513221785: treats an unknown pre-lock authority census as probe_failed and never spawns', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn(() => ({ status: 0, stdout: 'ActiveState=inactive', stderr: '' }));
    const readProcessAuthority = vi.fn(async () => ({
      active: false,
      probeFailed: true,
      probeDetail: 'environment read for pid 4242 timed out after 100ms',
      pid: null,
      startedAtMs: null,
      elapsedSec: null,
      cgroupPath: null,
      workspace: null,
      harness: null,
    }));

    const r = await launchDetachedCheckpoint(
      { root: '/tree' },
      spawnFn as never,
      execFn,
      () => null,
      undefined,
      undefined,
      readProcessAuthority,
    );

    expect(readProcessAuthority).toHaveBeenCalledWith('/tree');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      launched: false,
      reason: 'probe_failed',
      alreadyRunning: {
        active: true,
        probe_failed: true,
        probe_detail: 'environment read for pid 4242 timed out after 100ms',
        candidate_stale: false,
      },
    });
  });

  it('EI-21340355513221785: awaits authority before spawn while preserving same-tick child listener attachment', async () => {
    const child = fakeChild();
    let resolveAuthority!: (reading: {
      active: boolean;
      probeFailed: boolean;
      pid: number | null;
      startedAtMs: number | null;
      elapsedSec: number | null;
      cgroupPath: string | null;
      workspace: string | null;
      harness: string | null;
    }) => void;
    const authority = new Promise<Parameters<typeof resolveAuthority>[0]>((resolve) => {
      resolveAuthority = resolve;
    });
    const readProcessAuthority = vi.fn(() => authority);
    const spawnFn = vi.fn(() => {
      // This runs after spawnFn returns, but before the next macrotask. Any await between
      // spawnFn and listener registration would lose this close event and leave the launch
      // promise pending forever.
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const execFn = vi.fn(() => ({ status: 0, stdout: 'ActiveState=inactive', stderr: '' }));

    const launch = launchDetachedCheckpoint(
      { root: '/tree' },
      spawnFn as never,
      execFn,
      () => null,
      undefined,
      undefined,
      readProcessAuthority,
    );
    await Promise.resolve();
    expect(readProcessAuthority).toHaveBeenCalledWith('/tree');
    expect(spawnFn).not.toHaveBeenCalled();

    resolveAuthority({
      active: false,
      probeFailed: false,
      pid: null,
      startedAtMs: null,
      elapsedSec: null,
      cgroupPath: null,
      workspace: null,
      harness: null,
    });

    await expect(launch).resolves.toMatchObject({ launched: true });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('WI-5124: reports willJudge with quietCutApplied + excludedCommits when the quiet-cut steps back from a fresh tip — the exact "my just-landed fix silently excluded" trap', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const freshTip = 'f'.repeat(40);
    const agedCandidate = 'a'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: freshTip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 30), stderr: '' }; // 30s old — well inside the default 240s quiet window
      if (j.includes('rev-list -1 --before=')) return { status: 0, stdout: agedCandidate, stderr: '' };
      if (j.includes('rev-parse --verify ready')) return { status: 1, stdout: '', stderr: '' }; // no ready ref → skip the ancestor guard
      if (j.includes('log --no-decorate --format='))
        return { status: 0, stdout: `${freshTip.slice(0, 7)}\x1f${nowSec - 30}\x1fmy just-landed fix\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    expect(r.willJudge).toMatchObject({
      candidate: agedCandidate,
      tip: freshTip,
      quietCutApplied: true,
      excludedCommits: [`${freshTip.slice(0, 7)} my just-landed fix`],
    });
  });

  // EI-18759622667757826: the exclusion is a pure AGE test, so a commit that is merely SECONDS
  // short of the quiet window ages into eligibility before the detached run re-resolves its own
  // candidate ~1-2s later — and is judged after all. Reporting that commit as flatly "excluded"
  // told the filer its in-flight run was worthless; the run went green and shipped. The launch
  // reply must therefore carry HOW CLOSE each exclusion is, not just that it exists.
  it('EI-18759622667757826: reports per-commit eligibleInSec so a seconds-short exclusion is visibly about to flip', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const freshTip = 'f'.repeat(40);
    const agedCandidate = 'a'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    // The real incident's numbers: the fix was 238s old against the default 240s quiet window.
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: freshTip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 238), stderr: '' };
      if (j.includes('rev-list -1 --before=')) return { status: 0, stdout: agedCandidate, stderr: '' };
      if (j.includes('rev-parse --verify ready')) return { status: 1, stdout: '', stderr: '' };
      if (j.includes('log --no-decorate --format='))
        return {
          status: 0,
          // 238s old (2s short) and 200s old (40s short) — one flips, one does not.
          stdout: `1111111\x1f${nowSec - 238}\x1fthe fix I just landed\n2222222\x1f${nowSec - 200}\x1fsomeone else's commit\n`,
          stderr: '',
        };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    const eligibility = r.willJudge?.excludedEligibility ?? [];
    expect(eligibility).toHaveLength(2);
    // 240 - 238 = 2s away: inside the re-resolution window, so this run very likely DOES judge it.
    expect(eligibility[0]).toMatchObject({ sha: '1111111', subject: 'the fix I just landed' });
    expect(eligibility[0]!.eligibleInSec).toBeLessThanOrEqual(CANDIDATE_RERESOLVE_WINDOW_SEC);
    // 240 - 200 = 40s away: genuinely outside this run.
    expect(eligibility[1]!.eligibleInSec).toBeGreaterThan(CANDIDATE_RERESOLVE_WINDOW_SEC);
    expect(r.willJudge?.soonestEligibleInSec).toBe(eligibility[0]!.eligibleInSec);
    // The subject survives the field split even though it contains an apostrophe/spaces.
    expect(r.willJudge?.excludedCommits).toContain("2222222 someone else's commit");
  });

  it('EI-18759622667757826: soonestEligibleInSec is null when the quiet-cut excluded nothing', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const tip = 'c'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: tip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 9999), stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.willJudge).toMatchObject({ excludedEligibility: [], soonestEligibleInSec: null });
  });

  it('WI-5124: willJudge.quietCutApplied is false and excludedCommits is empty when the tip is old enough to judge directly', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const tip = 'c'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl') return { status: 0, stdout: 'ActiveState=inactive', stderr: '' };
      const j = args.join(' ');
      if (j.includes('rev-parse HEAD')) return { status: 0, stdout: tip, stderr: '' };
      if (j.includes('show -s --format=%ct')) return { status: 0, stdout: String(nowSec - 9999), stderr: '' }; // well past the quiet window
      return { status: 1, stdout: '', stderr: '' };
    });

    const p = launchDetachedCheckpoint({ root: '/tree' }, spawnFn, execFn, () => null);
    child.emit('close', 0);
    const r = await p;

    expect(r.launched).toBe(true);
    expect(r.willJudge).toMatchObject({ candidate: tip, tip, quietCutApplied: false, excludedCommits: [] });
  });
});

describe('terminateActiveCheckpointUnit (EI-213512: protected unit, authorized SIGTERM path)', () => {
  it('reports stopped:true on a clean systemctl kill', () => {
    const execFn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const r = terminateActiveCheckpointUnit('papercup-green-checkpoint-manual-abc', execFn);
    expect(r).toEqual({ stopped: true });
    expect(execFn).toHaveBeenCalledWith('systemctl', [
      '--user',
      'kill',
      '--signal=SIGTERM',
      '--kill-whom=all',
      'papercup-green-checkpoint-manual-abc.service',
    ]);
  });

  it('keeps the legacy helper name pointed at the protected kill path', () => {
    const execFn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(stopActiveCheckpointUnit('some-unit', execFn)).toEqual({ stopped: true });
    expect(execFn).toHaveBeenCalledWith('systemctl', [
      '--user',
      'kill',
      '--signal=SIGTERM',
      '--kill-whom=all',
      'some-unit.service',
    ]);
  });

  it('signals a scheduled run scope by its full name, never as a .service (WI-6554700010042670)', () => {
    const execFn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const scope = 'papercusp-checkpoint-8bf9f42e-e478-425b-80d8-2dd14e915511.scope';
    expect(terminateActiveCheckpointUnit(scope, execFn)).toEqual({ stopped: true });
    expect(execFn).toHaveBeenCalledWith('systemctl', ['--user', 'kill', '--signal=SIGTERM', '--kill-whom=all', scope]);
  });

  it('reports stopped:false with the stderr reason on a failed kill — never throws', () => {
    const execFn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'Unit not loaded.' }));
    const r = terminateActiveCheckpointUnit('some-unit', execFn);
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain('Unit not loaded');
  });
});

describe('cancelStaleCheckpointAwaits (EI-20391462658650094: candidate replacement wake families)', () => {
  it('passes global and pipeline-scoped green, red, and inconclusive keys to the durable wake helper', async () => {
    const candidateWake = vi.mocked(cancelSupersededCandidateAwaits);
    candidateWake.mockClear().mockResolvedValue({ cancelled: 0, ids: [11] });

    await expect(cancelStaleCheckpointAwaits('/tree', 'deadbeef')).resolves.toEqual({ cancelled: 0 });

    expect(candidateWake).toHaveBeenCalledWith({
      keys: [
        'release:green',
        'release:green:tree',
        'green-checkpoint:red',
        'green-checkpoint:red:tree',
        'green-checkpoint:inconclusive',
        'green-checkpoint:inconclusive:tree',
      ],
      staleCandidateSha: 'deadbeef',
    });
  });
});

describe('launchDetachedCheckpoint replaceStale (EI-9672: force alone could not free a genuinely-stale singleton)', () => {
  function fakeSystemctlShow(props: Record<string, string>) {
    const stdout = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return { status: 0, stdout, stderr: '' };
  }

  /** execFn that reports an ACTIVE run judging `oldCandidate`, while the current quiet-cut
   *  candidate is `freshCandidate` (i.e. candidate_stale:true) — mirrors the
   *  "candidate_stale" checkActiveCheckpointRun test above, plus responds to the
   *  `systemctl --user kill` call this describe block exercises. Defaults to a run OLD
   *  enough to pass the EI-11667 min-age guard — the wedged-salvage case.
   *
   *  WI-6554700010042457: the unlock is now SILENCE (REPLACE_STALE_MIN_SILENCE_SEC). These
   *  fakes publish no log timestamp, phase marker or log file, so progress_at = the unit start
   *  and silence = age — `ageMinutes` therefore still drives the decision here.
   *
   *  ⚠ DERIVED from the replace threshold, never a literal. This was hardcoded `45`
   *  (minutes), which silently encoded the old 20-min threshold: when WI-38026 raised the
   *  threshold to the suite budget, 45 min became YOUNG and three tests here failed by
   *  asserting a `systemctl stop` that correctly no longer happens. The intent of these
   *  cases is "comfortably past the replace threshold", so say exactly that — otherwise the
   *  next retune breaks them again and the failure looks like a regression in the guard
   *  rather than a stale number in its test. */
  const WEDGED_AGE_MIN = Math.ceil(REPLACE_STALE_MIN_SILENCE_SEC / 60) + 25;

  function staleActiveExecFn(stopStatus = 0, ageMinutes = WEDGED_AGE_MIN) {
    const startedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    return vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'show')
        return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
      if (cmd === 'systemctl' && args[1] === 'kill')
        return { status: stopStatus, stdout: '', stderr: stopStatus === 0 ? '' : 'nope' };
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('ready')) return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
  }

  it('a STALE active run OLD enough to be wedged is stopped, then a fresh run launches (replaceStale:true)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const execFn = staleActiveExecFn(0, WEDGED_AGE_MIN);
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    // EI-19326961954611487: this test's execFn reaches a SUCCESSFUL stop, which reaches
    // recordDisplacement — inject a fake so it never falls through to the real appendFileSync.
    const recordDisplacement = vi.fn();

    const p = launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn,
      execFn,
      readLogHead,
      undefined,
      recordDisplacement,
    );
    child.emit('close', 0);
    const r = await p;

    expect(execFn).toHaveBeenCalledWith('systemctl', [
      '--user',
      'kill',
      '--signal=SIGTERM',
      '--kill-whom=all',
      `${checkpointUnitForRoot('/tree')}.service`,
    ]);
    expect(spawnFn).toHaveBeenCalled();
    expect(r.launched).toBe(true);
    expect(r.replacedStale).toMatchObject({ active: true, candidate_stale: true, candidate: '11111111' });
    expect(recordDisplacement).toHaveBeenCalledTimes(1);
  });

  it('a PROGRESSING stale run is REFUSED, not stopped — the EI-11667 replace-storm guard (stale is normal for a healthy run on a busy tree)', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(0, 5); // 5 min since start (= last progress) — well under REPLACE_STALE_MIN_SILENCE_SEC
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');

    const r = await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
    );

    // The unit was never stopped and nothing launched: the caller must wait for the verdict.
    expect(execFn).not.toHaveBeenCalledWith('systemctl', [
      '--user',
      'stop',
      `${checkpointUnitForRoot('/tree')}.service`,
    ]);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.alreadyRunning).toMatchObject({ candidate_stale: true, replace_refused_progressing: true });
    expect(typeof r.alreadyRunning?.elapsed_sec).toBe('number');
    expect(r.alreadyRunning?.elapsed_sec).toBeLessThan(REPLACE_STALE_MIN_SILENCE_SEC);
  });

  it('a stale run with UNKNOWN age is refused too (cannot prove it is wedged — never kill a possibly-healthy verdict)', async () => {
    const oldCandidate = '1111111111111111111111111111111111111111';
    const currentHead = '3333333333333333333333333333333333333333';
    const quietCandidate = '2222222222222222222222222222222222222222';
    const spawnFn = vi.fn();
    const stopCall = vi.fn();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'kill') {
        stopCall();
        return { status: 0, stdout: '', stderr: '' };
      }
      // ActiveState reported, but NO ExecMainStartTimestamp → elapsed_sec null.
      if (cmd === 'systemctl' && args[1] === 'show')
        return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: '' });
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: `${currentHead}\n`, stderr: '' };
      if (cmd === 'git' && args.includes('--format=%ct'))
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000) - 30), stderr: '' };
      if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${quietCandidate}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(
      () => `[green-checkpoint] checkpointing candidate ${oldCandidate.slice(0, 8)} (base def)\n`,
    );

    const r = await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
    );

    expect(stopCall).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.alreadyRunning).toMatchObject({ replace_refused_progressing: true });
  });

  it('a NOT-stale active run is never stopped, even with replaceStale:true (the critical-danger guard)', async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const spawnFn = vi.fn();
    const stopCall = vi.fn();
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'kill') {
        stopCall();
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'systemctl') return fakeSystemctlShow({ ActiveState: 'active', ExecMainStartTimestamp: startedAt });
      if (cmd === 'git' && args.slice(-2).join(' ') === 'rev-parse HEAD')
        return { status: 0, stdout: 'abc\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate abc12345 (base def)\n');

    const r = await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
    );

    expect(stopCall).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
  });

  it('a FAILED stop refuses (already_running), same as an unreplaced stale run — no partial state', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(1); // stop fails
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    // EI-19326961954611487: recordDisplacement is written BEFORE the stop attempt (so the
    // marker survives even if the stop itself fails) — this old-enough run reaches it too.
    const recordDisplacement = vi.fn();

    const r = await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      undefined,
      recordDisplacement,
    );

    expect(spawnFn).not.toHaveBeenCalled();
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('already_running');
    expect(r.replacedStale).toBeUndefined();
  });

  // WI-4957: a stopped run will NEVER produce a verdict for its candidate — any
  // checkpoint:await bound to it must be proactively retired, not left to time out
  // indistinguishable from "still judging" (the exact window a stray late verdict could
  // otherwise be mistaken for a live "go" signal).
  it('WI-4957: a successfully-stopped stale run triggers cancellation of awaits bound to ITS candidate, BEFORE the fresh run launches', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const execFn = staleActiveExecFn(0, WEDGED_AGE_MIN);
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async (_root: string, _staleCandidateSha: string) => ({ cancelled: 2 }));
    // EI-19326961954611487: this test's execFn also reaches a SUCCESSFUL stop → recordDisplacement
    // — inject a fake here too so it never falls through to the real appendFileSync.
    const recordDisplacement = vi.fn();

    const p = launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
      recordDisplacement,
    );
    child.emit('close', 0);
    const r = await p;

    expect(cancelStaleAwaits).toHaveBeenCalledTimes(1);
    expect(cancelStaleAwaits).toHaveBeenCalledWith('/tree', '11111111');
    expect(r.launched).toBe(true);
    expect(recordDisplacement).toHaveBeenCalledTimes(1);
  });

  describe('WI-10005763: restricted-hold fence (D-012)', () => {
    const held: RestrictedHoldRefusal = {
      error: 'restricted_write_held',
      hint: '1 held restricted write(s) in /tree (secret.ts). This action executes code from that tree with network access (D-012)',
    };

    it('refuses before any probe or spawn — force included — and asks about both trees the launch executes from', async () => {
      for (const refusal of [held, { error: 'restricted_hold_state_unknown' as const, hint: 'census failed' }]) {
        restrictedFence.refusal.mockImplementationOnce(() => refusal);
        const spawnFn = vi.fn();
        const execFn = vi.fn();
        const r = await launchDetachedCheckpoint(
          { root: '/tooling', integrationRoot: '/subject', force: true },
          spawnFn as never,
          execFn as never,
        );
        expect(restrictedFence.refusal).toHaveBeenLastCalledWith(['/tooling', '/subject']);
        expect(spawnFn).not.toHaveBeenCalled();
        expect(execFn).not.toHaveBeenCalled();
        expect(r).toMatchObject({ launched: false, argv: [], reason: refusal.error, restrictedHold: refusal });
      }
    });

    it('never stops a live stale run under replaceStale; the same fixture DOES stop it when nothing is held', async () => {
      const run = async (refusal: RestrictedHoldRefusal | null) => {
        restrictedFence.refusal.mockImplementationOnce(() => refusal);
        const child = fakeChild();
        const spawnFn = vi.fn(() => child);
        const execFn = staleActiveExecFn(0, WEDGED_AGE_MIN);
        const recordDisplacement = vi.fn();
        const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));
        const p = launchDetachedCheckpoint(
          { root: '/tree', replaceStale: true },
          spawnFn as never,
          execFn,
          vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n'),
          cancelStaleAwaits,
          recordDisplacement,
        );
        child.emit('close', 0);
        const r = await p;
        const killed = execFn.mock.calls.some(([cmd, args]) => cmd === 'systemctl' && args[1] === 'kill');
        return { r, killed, spawned: spawnFn.mock.calls.length, displaced: recordDisplacement.mock.calls.length };
      };

      const refused = await run(held);
      expect(refused).toMatchObject({ killed: false, spawned: 0, displaced: 0 });
      expect(refused.r).toMatchObject({ launched: false, reason: 'restricted_write_held', restrictedHold: held });

      // Control: without a hold this exact fixture reaches the stop, so the refusal above is what
      // prevented it — not a fixture that never gets that far.
      const control = await run(null);
      expect(control).toMatchObject({ killed: true, spawned: 1, displaced: 1 });
      expect(control.r.launched).toBe(true);
    });
  });

  it('WI-4957: a FAILED stop never calls cancelStaleAwaits (the run is not proven dead — nothing to retire)', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(1); // stop fails
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));
    // EI-19326961954611487: this old-enough run also reaches recordDisplacement (written
    // before the stop attempt), even though the stop itself fails.
    const recordDisplacement = vi.fn();

    await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
      recordDisplacement,
    );

    expect(cancelStaleAwaits).not.toHaveBeenCalled();
  });

  it('WI-4957: a YOUNG stale run (refused, never stopped) never calls cancelStaleAwaits', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(0, 5); // young — refused before any stop attempt
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));

    await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
    );

    expect(cancelStaleAwaits).not.toHaveBeenCalled();
  });

  // EI-19323010647367612: a run stopped via replaceStale (or any other out-of-band
  // `systemctl stop`) left no trace of WHY it died — the transient unit has no journal, and the
  // stable log symlink is about to be repointed at the fresh run. recordDisplacement writes a
  // marker into the STALE run's own log BEFORE the SIGTERM so the forensic trail survives.
  it('EI-19323010647367612: a successfully-stopped stale run gets a displacement marker written into its OWN log BEFORE the stop', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const calls: string[] = [];
    const baseExecFn = staleActiveExecFn(0, WEDGED_AGE_MIN);
    const execFn = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args[1] === 'kill') calls.push('kill');
      return baseExecFn(cmd, args);
    });
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));
    const recordDisplacement = vi.fn((logPath: string, info: { candidate?: string | null }) => {
      calls.push('record');
      expect(logPath).toBe(checkpointLatestLogPath(checkpointUnitForRoot('/tree')));
      expect(info.candidate).toBe('11111111');
    });

    const p = launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
      recordDisplacement,
    );
    child.emit('close', 0);
    const r = await p;

    expect(recordDisplacement).toHaveBeenCalledTimes(1);
    // Written before the SIGTERM, not after — the marker must survive even if the stop's own
    // systemd bookkeeping (or a crash right after) loses everything else.
    expect(calls).toEqual(['record', 'kill']);
    expect(r.launched).toBe(true);
  });

  it('EI-19323010647367612: a REFUSED replace (young/not-stale/failed-stop) never calls recordDisplacement — nothing is actually being stopped', async () => {
    const spawnFn = vi.fn();
    const execFn = staleActiveExecFn(0, 5); // young — refused before any stop attempt
    const readLogHead = vi.fn(() => '[green-checkpoint] checkpointing candidate 11111111 (base def)\n');
    const cancelStaleAwaits = vi.fn(async () => ({ cancelled: 0 }));
    const recordDisplacement = vi.fn();

    await launchDetachedCheckpoint(
      { root: '/tree', replaceStale: true },
      spawnFn as never,
      execFn,
      readLogHead,
      cancelStaleAwaits,
      recordDisplacement,
    );

    expect(recordDisplacement).not.toHaveBeenCalled();
  });

  it('EI-19323010647367612: recordCheckpointDisplacement is fail-soft — a write error never throws or blocks the caller', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingAppend = vi.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(() =>
      recordCheckpointDisplacement(
        '/tmp/some-unit.log',
        {
          candidate: 'abc123def456',
          current_candidate: 'fed654cba321',
          elapsed_sec: 300,
          started_at: '2026-08-02T05:15:07Z',
        },
        throwingAppend,
      ),
    ).not.toThrow();
    expect(throwingAppend).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('EI-19323010647367612: recordCheckpointDisplacement writes a human-readable marker naming both the stopped and superseding candidates', () => {
    const appendFn = vi.fn();
    recordCheckpointDisplacement(
      '/tmp/some-unit.log',
      {
        candidate: 'abc123def456',
        current_candidate: 'fed654cba321',
        elapsed_sec: 300,
        started_at: '2026-08-02T05:15:07.000Z',
      },
      appendFn,
    );
    expect(appendFn).toHaveBeenCalledTimes(1);
    const [path, line] = appendFn.mock.calls[0] as [string, string];
    expect(path).toBe('/tmp/some-unit.log');
    expect(line).toContain('displaced');
    expect(line).toContain('abc123def456'.slice(0, 12));
    expect(line).toContain('fed654cba321'.slice(0, 12));
    expect(line).toContain('2026-08-02T05:15:07.000Z');
    expect(line).toContain('300s elapsed');
  });

  // EI-19326961954611487 recurrence guard: the un-injected DEFAULT appendFn must never reach
  // the real filesystem under test — this is the exact leak that wrote synthetic "[displaced
  // ...] STOPPED via replaceStale" lines with placeholder shas into the SHARED, PRODUCTION
  // /tmp/papercup-green-checkpoint-manual-*.log namespace, which CLAUDE.md tells agents to
  // trust as gate ground truth. A future un-injected call site (here or anywhere else that
  // imports recordCheckpointDisplacement without supplying appendFn) is caught by this guard
  // regardless of call path, not just the two sites fixed above.
  it('EI-19326961954611487: the un-injected default appendFn never performs a real fs write under test (fail-soft: logged, not thrown)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = path.join(os.tmpdir(), `papercup-green-checkpoint-manual-recurrence-guard-${Date.now()}.log`);
    expect(fs.existsSync(target)).toBe(false);

    expect(() =>
      recordCheckpointDisplacement(target, {
        candidate: '1111111111111111111111111111111111111111',
        current_candidate: '2222222222222222222222222222222222222222',
        elapsed_sec: 2700,
        started_at: '2026-08-02T07:05:08.579Z',
      }),
    ).not.toThrow();

    expect(fs.existsSync(target)).toBe(false); // the real write never happened
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleErrorSpy.mock.calls[0]?.[0])).toMatch(/refusing a real fs write .* under test/);
    consoleErrorSpy.mockRestore();
  });
});

describe('checkpointUnitForRoot (per-root manual gates, 2026-07-01)', () => {
  it('DIFFERENT roots get DIFFERENT units (no cross-repo serialization); same root is stable (duplicate guard intact)', () => {
    const a = checkpointUnitForRoot('/home/x/papercusp');
    const b = checkpointUnitForRoot('/home/x/papercup');
    expect(a).not.toBe(b);
    expect(a).toBe(checkpointUnitForRoot('/home/x/papercusp'));
    expect(a.startsWith(`${CHECKPOINT_UNIT}-`)).toBe(true);
    // systemd unit-name-safe suffix (base36 of a u32 — no dots/slashes/spaces).
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});

/**
 * EI-18757156963245979 — the replace policy, as a pure rule.
 *
 * REGRESSION UNDER TEST (measured 2026-07-27; four consecutive gate runs died this way and
 * `main` sat 49 commits behind with nothing actually broken): replaceability was decided by
 * AGE alone. `REPLACE_STALE_MIN_AGE_SEC` (1200s) is meant to read "old enough to plausibly be
 * wedged", but the suite itself took 1180s under load — so a perfectly healthy run crossed the
 * age line ~20s AFTER finishing its suite, i.e. exactly as it entered the verdict path. A
 * peer's `replaceStale:true` then SIGTERMed candidate e4a93f8b 85 seconds into the stale-red
 * re-triage, discarding the auto-refire that would have re-fired the gate onto a newer tip.
 *
 * The invariant pinned here: a run that has published `delivering` is NEVER replaceable, at
 * ANY age. If an age-only decision is reintroduced, the `delivering` cases below go red —
 * instead of the gate silently failing to converge again hours later.
 *
 * WI-6554700010042457: the fallback test is SILENCE (now − progress_at), not age. With the
 * run-level wall clock removed, a healthy run routinely passes 120m; it must stay
 * unreplaceable for as long as it keeps publishing progress.
 */
describe('classifyReplaceRequest (EI-18757156963245979: never kill a run that is about to deliver)', () => {
  const NOW = Date.parse('2026-10-28T18:00:00.000Z');
  const SILENT = REPLACE_STALE_MIN_SILENCE_SEC + 60;
  const agoIso = (sec: number) => new Date(NOW - sec * 1000).toISOString();

  it('refuses a run in its VERDICT path even when it is silent long enough to look wedged', () => {
    // The exact e4a93f8b shape: stale candidate, past the line, mid re-triage.
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: SILENT, delivering: true }, NOW)).toEqual({
      replace: false,
      reason: 'delivering',
    });
  });

  it('phase beats silence no matter how long the run is quiet', () => {
    for (const elapsed_sec of [SILENT, SILENT * 2, SILENT * 10]) {
      expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec, delivering: true }, NOW).replace).toBe(false);
    }
  });

  it('still replaces a genuinely wedged run — silent, stale, and NOT delivering (the EI-9672 case)', () => {
    expect(
      classifyReplaceRequest(
        { candidate_stale: true, elapsed_sec: SILENT * 3, progress_at: agoIso(SILENT), delivering: false },
        NOW,
      ),
    ).toEqual({ replace: true });
  });

  it('an OLD run that is still PROGRESSING is refused — age alone never unlocks replacement (WI-6554700010042457)', () => {
    // 6h old, last progress 30s ago: the healthy long main-greening run the age rule would have killed.
    expect(
      classifyReplaceRequest(
        { candidate_stale: true, elapsed_sec: 6 * 60 * 60, progress_at: agoIso(30), delivering: false },
        NOW,
      ),
    ).toEqual({ replace: false, reason: 'progressing' });
  });

  it('progress_at wins over elapsed_sec when both are present', () => {
    // Young by elapsed, but progress_at is the measured signal and it says silent: replace.
    expect(
      classifyReplaceRequest({ candidate_stale: true, elapsed_sec: 60, progress_at: agoIso(SILENT) }, NOW),
    ).toEqual({ replace: true });
  });

  it('degrades to elapsed_sec when the run published no progress_at and no phase', () => {
    // `delivering` undefined must not be read as "delivering" — that would make the flag inert.
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: SILENT }, NOW)).toEqual({ replace: true });
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: 60 }, NOW)).toEqual({
      replace: false,
      reason: 'progressing',
    });
  });

  it('pins the threshold to the run\'s own idle budget, not a literal', () => {
    expect(REPLACE_STALE_MIN_SILENCE_SEC).toBe(Math.ceil(MANUAL_CHECKPOINT_WATCHDOG_MS / 1000));
    expect(checkpointSilenceSec({ elapsed_sec: 5, progress_at: agoIso(42) }, NOW)).toBe(42);
    expect(checkpointSilenceSec({ elapsed_sec: 7, progress_at: 'not-a-date' }, NOW)).toBe(7);
    expect(checkpointSilenceSec({ elapsed_sec: null, progress_at: null }, NOW)).toBeNull();
  });

  it('never touches a run judging the CURRENT candidate, regardless of silence or phase', () => {
    expect(classifyReplaceRequest({ candidate_stale: false, elapsed_sec: SILENT, delivering: false }, NOW)).toEqual({
      replace: false,
      reason: 'not_stale',
    });
  });

  it('treats unmeasurable silence as progressing (no start time, no progress signal)', () => {
    expect(classifyReplaceRequest({ candidate_stale: true, elapsed_sec: null }, NOW)).toEqual({
      replace: false,
      reason: 'progressing',
    });
  });
});

/* ------------------------------------------------------------------------- *
 * P-004 (EI-18752644493166307) — does the judged candidate contain MY edits?
 *
 * The warning TEXT is the deliverable here, so it is asserted directly. The bug it
 * closes is a misREADING, not a missing field: a candidate without your fix reds on
 * the pre-fix failure with the pre-fix count, which reads as "your fix did not work"
 * and sends you to re-debug correct code.
 * ------------------------------------------------------------------------- */
describe('renderContainmentWarning (P-004)', () => {
  const p = (path: string, reason: 'uncommitted' | 'newer-commit' | 'absent') => ({
    path,
    inCandidate: false as const,
    reason,
    unknownReason: null,
  });

  it('pre-empts the misread: a red from this run is not evidence your fix failed', () => {
    const w = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(w).toMatch(/NOT evidence your change failed/);
    expect(w).toMatch(/ORIGINAL failure with the ORIGINAL count/);
  });

  it('routes an uncommitted miss to git-sync:run and a quiet-cut miss to the quiet window', () => {
    const uncommitted = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(uncommitted).toMatch(/git-sync:run/);
    expect(uncommitted).not.toMatch(/quiet window/);

    const newer = renderContainmentWarning(['b.ts'], [p('b.ts', 'newer-commit')], [], 'caller-supplied');
    expect(newer).toMatch(/quiet window/);
    // Sending an already-committed change to git-sync:run would waste another run.
    expect(newer).not.toMatch(/Fix: git-sync:run/);
  });

  /**
   * `absent` used to be folded into the NOT-COMMITTED bucket on the premise that a new
   * file "no commit can carry". False: a new file committed after the candidate is absent
   * there and committed here — the commonest shape on this tree, since the quiet-cut steps
   * the judged commit ~4 min behind the tip. The classifier now resolves that against HEAD,
   * so `absent` reaches this renderer ONLY when there was no HEAD to ask. Asserting
   * "NOT COMMITTED … Fix: git-sync:run" on that residue would state a lever that is a no-op
   * whenever the file was in fact already committed.
   */
  it('an absent-but-unknown miss does NOT claim "not committed", and prescribes no false lever', () => {
    const w = renderContainmentWarning(['new.test.ts'], [p('new.test.ts', 'absent')], [], 'caller-supplied');
    expect(w).toMatch(/committed-ness UNKNOWN/);
    expect(w).toMatch(/new\.test\.ts/);
    expect(w).not.toMatch(/NOT COMMITTED/);
    expect(w).not.toMatch(/Fix: git-sync:run/);
  });

  /**
   * The resolution of "if your fix is among them". The old warning named excluded SHAS,
   * which is the one space the reader has no information about — an agent knows its
   * FILES. Naming which excluded commit carries which file is the whole point.
   */
  it('names WHICH excluded commit carries the file, not just that commits were excluded', () => {
    const w = renderContainmentWarning(
      ['a.ts'],
      [p('a.ts', 'newer-commit')],
      [{ path: 'a.ts', commits: ['fff1234 my just-landed fix'] }],
      'caller-supplied',
    );
    expect(w).toMatch(/'a\.ts' is carried by EXCLUDED commit\(s\): fff1234 my just-landed fix/);
    expect(w).not.toMatch(/if your fix is among them/);
  });

  /**
   * This tree is edited concurrently by the whole fleet, so an INFERRED set routinely
   * contains peers' uncommitted work. Claiming those are "your files" is a false
   * positive, and a detector that cries wolf is one agents learn to scroll past —
   * which would cost more than the gap it closes.
   */
  it('claims ownership ONLY when the caller declared the paths', () => {
    const declared = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'caller-supplied');
    expect(declared).toMatch(/of your file\(s\)/);

    const inferred = renderContainmentWarning(['a.ts'], [p('a.ts', 'uncommitted')], [], 'inferred-uncommitted');
    expect(inferred).not.toMatch(/of your file\(s\)/);
    expect(inferred).toMatch(/may be a peer's/);
    // …and it must point at the route that WOULD give an exact answer.
    expect(inferred).toMatch(/pass `paths: \[\.\.\.\]`/);
  });

  /**
   * EI-18796358994458975: a torn TDD pair (test in, impl newer-commit) is a KNOWN false-red
   * shape, not just another "wait out the quiet window" miss — it must say so explicitly so
   * the reader does not spend the ~3h suite re-debugging code that was already correct.
   */
  it('names the torn-TDD-pair shape explicitly when splitRisk is detected', () => {
    const w = renderContainmentWarning(['a.ts'], [p('a.ts', 'newer-commit')], [], 'caller-supplied', {
      detected: true,
      includedTests: ['a.test.ts'],
      missingImpl: ['a.ts'],
    });
    expect(w).toMatch(/KNOWN FALSE-RED SHAPE/);
    expect(w).toMatch(/torn TDD pair/);
    expect(w).toMatch(/a\.test\.ts/);
    expect(w).toMatch(/Do not debug it/);
  });

  it('says nothing about a torn pair when splitRisk is undetected or omitted', () => {
    const omitted = renderContainmentWarning(['a.ts'], [p('a.ts', 'newer-commit')], [], 'caller-supplied');
    expect(omitted).not.toMatch(/KNOWN FALSE-RED SHAPE/);

    const undetected = renderContainmentWarning(['a.ts'], [p('a.ts', 'newer-commit')], [], 'caller-supplied', {
      detected: false,
      includedTests: [],
      missingImpl: [],
    });
    expect(undetected).not.toMatch(/KNOWN FALSE-RED SHAPE/);
  });
});

describe('checkpointCandidateContainment (P-004)', () => {
  const BLOB_OLD = '0'.repeat(40);
  const BLOB_NEW = 'f'.repeat(40);

  /**
   * A git that answers by arg shape; status non-zero ⇒ the read FAILED (never "").
   * `<sha>^{commit}` resolves by default — the containment check probes that the candidate
   * COMMIT exists before judging any path, so a fixture that did not answer it would make
   * every case fall into the unknown branch.
   */
  const fakeExec = (answers: Record<string, string>) => (_cmd: string, args: string[]) => {
    const key = args.slice(2).join(' ');
    if (key.endsWith('^{commit}') && !(key in answers)) return { status: 0, stdout: 'c'.repeat(40), stderr: '' };
    return key in answers
      ? { status: 0, stdout: answers[key], stderr: '' }
      : { status: 128, stdout: '', stderr: 'fatal' };
  };

  it('reports included/missing for caller-declared paths', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['in.ts', 'out.ts'],
      execFn: fakeExec({
        'rev-parse --verify cand:in.ts': BLOB_OLD,
        'hash-object -- in.ts': BLOB_OLD,
        'rev-parse --verify cand:out.ts': BLOB_OLD,
        'hash-object -- out.ts': BLOB_NEW,
        'rev-parse --verify HEAD:out.ts': BLOB_OLD,
      }),
    });
    expect(r.source).toBe('caller-supplied');
    expect(r.included).toEqual(['in.ts']);
    expect(r.missing).toEqual(['out.ts']);
    expect(r.warning).toMatch(/THIS RUN WILL NOT SEE 1 of your file/);
  });

  it('is SILENT when every declared file is in the candidate — no warning to habituate to', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['in.ts'],
      execFn: fakeExec({ 'rev-parse --verify cand:in.ts': BLOB_OLD, 'hash-object -- in.ts': BLOB_OLD }),
    });
    expect(r.missing).toEqual([]);
    expect(r.warning).toBeNull();
  });

  it('falls back to the working tree, and labels that set as INFERRED', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      execFn: fakeExec({
        'diff --name-only HEAD': 'dirty.ts',
        'ls-files --others --exclude-standard': '',
        'rev-parse --verify cand:dirty.ts': BLOB_OLD,
        'hash-object -- dirty.ts': BLOB_NEW,
        'rev-parse --verify HEAD:dirty.ts': BLOB_OLD,
      }),
    });
    expect(r.source).toBe('inferred-uncommitted');
    expect(r.missing).toEqual(['dirty.ts']);
    expect(r.warning).toMatch(/may be a peer's/);
  });

  it('attributes a missing file to the excluded commit that carries it', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'tip',
      paths: ['a.ts'],
      execFn: fakeExec({
        'rev-parse --verify cand:a.ts': BLOB_OLD,
        'hash-object -- a.ts': BLOB_NEW,
        'rev-parse --verify HEAD:a.ts': BLOB_NEW,
        'log --oneline --no-decorate cand..tip -- a.ts': 'fff1234 my just-landed fix',
      }),
    });
    expect(r.excludedCommitsTouchingYourFiles).toEqual([{ path: 'a.ts', commits: ['fff1234 my just-landed fix'] }]);
    expect(r.warning).toMatch(/fff1234 my just-landed fix/);
  });

  it('a git that fails entirely produces UNKNOWN and NO warning — never a false all-clear', async () => {
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'cand',
      paths: ['a.ts'],
      execFn: () => ({ status: 128, stdout: '', stderr: 'fatal' }),
    });
    expect(r.unknown).toEqual(['a.ts']);
    expect(r.included).toEqual([]);
    expect(r.warning).toBeNull();
  });

  /**
   * WI-38356, reproduced from the live 2026-08-13T01:56:22Z inputs.
   *
   * A declared path INSIDE a submodule, missing for `newer-commit`, whose carrying commit is the
   * superproject GITLINK BUMP sitting in the quiet window. `excludedCommitsTouchingYourFiles`
   * must attribute that bump to the declared path — because that list is the sole input to
   * `assessPreLaunchExclusion`'s `blockedPaths`, and an empty list there silently downgrades a
   * DECIDED miss to `exclusion-undecidable`, which fails OPEN and spends a ~55min suite on a
   * candidate that provably lacks the fix (and makes `waitForEligibility:true` a no-op).
   *
   * The stakes are structural, not incidental: every migration lives under
   * `libs/papercusp/libs/db/sql/` and every borrowable lib under `libs/generic/*`, so before this
   * the guard was blind for the entire surface whose own preflight (`lint:migrations`) is what
   * sends agents to fire a manual gate run.
   */
  it('attributes a submodule GITLINK bump to the declared path inside it (WI-38356)', async () => {
    const SUB = 'libs/papercusp';
    const REL = 'libs/db/sql/816-backfill-migration-reservation-815-wi38348.sql';
    const FULL = `${SUB}/${REL}`;
    const PIN = 'cba68157b0142fd4a90ab0d0c023990a4a26c658'; // the candidate's stale gitlink
    const BUMP = 'e0a0e71b12 Resume AUTO work loop';

    const answers = {
      'config --file .gitmodules --get-regexp path': `submodule.${SUB}.path ${SUB}`,
      // Committed in the submodule (HEAD blob === worktree blob) ⇒ reason `newer-commit`,
      // never `uncommitted`: waiting for the bump is the lever that actually works.
      [`-C ${SUB} hash-object -- ${REL}`]: BLOB_NEW,
      [`-C ${SUB} rev-parse --verify HEAD:${REL}`]: BLOB_NEW,
      // The candidate pins an OLDER submodule commit, which does not carry the file at all.
      [`ls-tree cand -- ${SUB}`]: `160000 commit ${PIN}\t${SUB}`,
      // The gitlink bump is a SUPERPROJECT commit touching only `libs/papercusp`. Note there is
      // deliberately NO answer for `-- ${FULL}`: a superproject log for a submodule-internal
      // path legitimately finds nothing, and that honest nothing is what used to end the story.
      [`log --oneline --no-decorate cand..tip -- ${SUB}`]: BUMP,
    };

    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'tip',
      paths: [FULL],
      execFn: fakeExec(answers),
    });

    expect(r.paths).toEqual([{ path: FULL, inCandidate: false, reason: 'newer-commit', unknownReason: null }]);
    expect(r.missing).toEqual([FULL]);
    // Keyed by the DECLARED path, not the gitlink: assessPreLaunchExclusion joins on what the
    // caller asked about, so attributing this to `libs/papercusp` would not arm the refusal.
    expect(r.excludedCommitsTouchingYourFiles).toEqual([{ path: FULL, commits: [BUMP] }]);

    /* CONTROL, kept permanently: the pre-fix attributor, which consulted ONLY the declared path.
       It runs against the very same fixture and must come back empty — otherwise this test would
       pass with the fix reverted, and would be proving nothing. (Per the repo's falsifiability
       discipline, a module-level subject gets a wrong implementation held in the test file rather
       than a mutation of the shared tree.) */
    const preFix = await (async () => {
      const git = gitReadFromExecSync(fakeExec(answers), '/repo');
      return excludedCommitsTouchingPath(git, 'cand', 'tip', FULL);
    })();
    expect(preFix).toEqual([]);

    /* CALIBRATION: the same fixture, asked about the gitlink itself, DOES yield the bump — so the
       control's emptiness above is the submodule blind spot, not a broken fixture. */
    const atGitlink = await (async () => {
      const git = gitReadFromExecSync(fakeExec(answers), '/repo');
      return excludedCommitsTouchingPath(git, 'cand', 'tip', SUB);
    })();
    expect(atGitlink).toEqual([BUMP]);
  });

  it('containingSubmodulePath: longest match wins, and a gitlink is not inside ITSELF', () => {
    const subs = ['libs/generic/sync', 'libs/papercusp', 'libs/papercusp/nested'];
    expect(containingSubmodulePath(subs, 'libs/papercusp/libs/db/sql/816.sql')).toBe('libs/papercusp');
    // A nested submodule must beat its parent regardless of the order handed in.
    expect(containingSubmodulePath(subs, 'libs/papercusp/nested/a.ts')).toBe('libs/papercusp/nested');
    // Equality is NOT containment: the gitlink path already resolves in the superproject.
    expect(containingSubmodulePath(subs, 'libs/papercusp')).toBeNull();
    expect(containingSubmodulePath(subs, 'packages/operator-core/lib/x.ts')).toBeNull();
    // No `.gitmodules` ⇒ no attribution, which restores plain superproject behaviour exactly.
    expect(containingSubmodulePath([], 'libs/papercusp/libs/db/sql/816.sql')).toBeNull();
  });

  /**
   * EI-18796358994458975, reproduced end-to-end: candidate `2864c150` carried the test
   * (`deliberation-harness-fallback.test.ts`) but excluded the implementation commit
   * (`index.ts`, `newer-commit`) — a guaranteed-red candidate before the suite even runs.
   * `checkpointCandidateContainment` must surface this as `testImplSplitRisk.detected` AND
   * fold the explicit warning text into `warning`, so a caller who passes both files in
   * `paths` (as this incident's filer did) gets told the shape at launch time, for free.
   */
  it('detects + names the torn-TDD-pair shape from the real incident inputs', async () => {
    const TEST_FILE = 'packages/operator-core/lib/sync-resolver/deliberation-harness-fallback.test.ts';
    const IMPL_FILE = 'packages/operator-core/lib/sync-resolver/index.ts';
    const r = await checkpointCandidateContainment({
      root: '/repo',
      candidateSha: 'cand',
      tipSha: 'tip',
      paths: [TEST_FILE, IMPL_FILE],
      execFn: fakeExec({
        [`rev-parse --verify cand:${TEST_FILE}`]: BLOB_OLD,
        [`hash-object -- ${TEST_FILE}`]: BLOB_OLD,
        [`rev-parse --verify cand:${IMPL_FILE}`]: BLOB_OLD,
        [`hash-object -- ${IMPL_FILE}`]: BLOB_NEW,
        [`rev-parse --verify HEAD:${IMPL_FILE}`]: BLOB_NEW,
        [`log --oneline --no-decorate cand..tip -- ${IMPL_FILE}`]: '05422caf my just-landed fix',
      }),
    });
    expect(r.included).toEqual([TEST_FILE]);
    expect(r.missing).toEqual([IMPL_FILE]);
    expect(r.testImplSplitRisk).toEqual({ detected: true, includedTests: [TEST_FILE], missingImpl: [IMPL_FILE] });
    expect(r.warning).toMatch(/KNOWN FALSE-RED SHAPE/);
    expect(r.warning).toMatch(/torn TDD pair/);
  });
});

// WI-7296 (residual of EI-19395755190419540). A seeked tail read lands mid-line, and a
// truncated FIXTURE line is the one shape that survives truncation into something HARMFUL:
// `[green-checkpoint:TEST-FIXTURE] checkpointing candidate <sha>` sliced after the tag reads
// as a genuine candidate. These pin the asymmetry that makes discarding it free rather than
// a trade — dropping the partial line can only ever COST a candidate, never corrupt one.
describe('defaultReadLogTail drops the partial first line on a SEEKED read (WI-7296)', () => {
  const write = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wi7296-'));
    const p = join(dir, 'run.log');
    writeFileSync(p, body);
    return p;
  };

  it('keeps the first line when the read was NOT seeked (whole file fits)', () => {
    // The unseeked branch reads the entire file, so its first line really IS the first line.
    // Dropping it there would lose a genuine candidate for no safety gain.
    const p = write('checkpointing candidate aaa1 (base x)\nmore\n');
    expect(defaultReadLogTail(p, 65536)).toContain('checkpointing candidate aaa1');
    expect(parseCheckpointCandidates(defaultReadLogTail(p, 65536))).toEqual(['aaa1']);
  });

  it('DROPS a truncated fixture line that would otherwise read as a real candidate', () => {
    // The harmful shape: seek lands inside the fixture tag, so the tag is gone but
    // `checkpointing candidate <sha>` survives intact. Pre-WI-7296 this returned ['deadbeef'].
    const fixture = '[green-checkpoint:TEST-FIXTURE] checkpointing candidate deadbeef (base f)\n';
    const real = 'checkpointing candidate 13d9c65d (base 1e0ddc58)\n';
    const p = write('x'.repeat(200) + '\n' + fixture + real);
    // maxBytes chosen to land the seek INSIDE the fixture line's leading tag.
    const tail = defaultReadLogTail(p, fixture.length + real.length - 12)!;
    expect(tail).not.toContain('TEST-FIXTURE'); // the tag was sliced off — that is the trap
    expect(tail).not.toContain('deadbeef'); // ...and the whole partial line is discarded
    expect(parseCheckpointCandidates(tail)).toEqual(['13d9c65d']);
  });

  it('THE case that actually produced a wrong answer: truncated fixture is the ONLY candidate', () => {
    // Why this one matters more than the interleaved case above. The partial line is always
    // the FIRST line of the window, and the caller takes the LAST candidate
    // (`tailCandidates.at(-1)`, EI-19327704778173646). So a truncated fixture sha only WINS
    // when it is the sole candidate in the 64KB window — and then it is reported as the sha
    // the gate is judging. Verified against the old implementation: it returned ['deadbeef'],
    // i.e. a fabricated candidate that looks entirely legitimate.
    const fixture = '[green-checkpoint:TEST-FIXTURE] checkpointing candidate deadbeef (base f)\n';
    const p = write('x'.repeat(400) + '\n' + fixture + 'suite output, no further candidates\n');
    const tail = defaultReadLogTail(p, fixture.length + 24)!;
    expect(parseCheckpointCandidates(tail)).toEqual([]);
    // Empty is the SAFE outcome, not a loss: the caller falls back to the head-read's first
    // candidate (`?? firstCandidate`), which is the documented pre-EI behaviour.
    expect(parseCheckpointCandidates(tail).at(-1) ?? 'head-fallback').toBe('head-fallback');
  });

  it('never yields a corrupted-but-matching sha — a cut reaching the sha kills the prefix', () => {
    // The asymmetry itself. Truncation only removes from the LEFT, so any cut deep enough to
    // touch the sha has already destroyed `checkpointing candidate`. Sweep every cut point
    // across one candidate line: every result is either the exact sha or nothing. If this ever
    // fails, the free-fix argument in defaultReadLogTail's comment no longer holds.
    const line = 'checkpointing candidate 13d9c65d (base 1e0ddc58)';
    for (let cut = 0; cut < line.length; cut++) {
      const got = parseCheckpointCandidates(line.slice(cut));
      expect(got.length === 0 || got[0] === '13d9c65d').toBe(true);
    }
  });

  it('returns empty (not the raw slice) when the window holds no newline at all', () => {
    // One gigantic line ⇒ the whole window is partial ⇒ nothing usable. Must not hand back
    // the partial slice, which is exactly the harmful case above.
    const p = write('[green-checkpoint:TEST-FIXTURE] checkpointing candidate deadbeef nonewline');
    const tail = defaultReadLogTail(p, 20);
    expect(tail).toBe('');
    expect(parseCheckpointCandidates(tail)).toEqual([]);
  });

  it('degrades to null on an unreadable path, preserving the best-effort contract', () => {
    expect(defaultReadLogTail(join(tmpdir(), 'wi7296-does-not-exist', 'nope.log'))).toBeNull();
  });
});

/**
 * EI-20025784115349280 — the PRE-LAUNCH exclusion gate.
 *
 * The defect: every value the post-launch "this run will not see your file" warning is made
 * of is computed ~29 lines BEFORE `spawnFn` runs, so the tool could always have known — and
 * told the caller — while not-starting was still an option. It reported it only once the
 * ~55min suite already held the gate's one serial slot.
 *
 * These cases are written the way this rail has to be judged: the REFUSAL is one test and
 * every FAIL-OPEN path is its own, because a guard that refuses too eagerly wedges the
 * fleet's only manual verdict lever — strictly worse than the wasted suite it prevents. The
 * CONTROL case is what stops this suite from passing against a guard that refuses everything.
 */
describe('assessPreLaunchExclusion (EI-20025784115349280)', () => {
  const NOW = () => Math.floor(Date.now() / 1000);
  const TIP = 'ffffffffffffffffffffffffffffffffffffffff';
  const CAND = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const MINE = 'packages/operator-core/lib/mine.ts';

  let savedQuiet: string | undefined;
  beforeEach(() => {
    savedQuiet = process.env.PAPERCUSP_QUIET_CUT_SEC;
    process.env.PAPERCUSP_QUIET_CUT_SEC = '240';
  });
  afterEach(() => {
    if (savedQuiet === undefined) delete process.env.PAPERCUSP_QUIET_CUT_SEC;
    else process.env.PAPERCUSP_QUIET_CUT_SEC = savedQuiet;
  });

  /** Drives `currentCheckpointCandidate` + `excludedCommitsSync` only — containment is
   *  injected separately, which is what keeps this fake small enough to read. */
  const gitFake = (excluded: { sha: string; agoSec: number; subject: string }[], cut = true) =>
    vi.fn((cmd: string, args: string[]) => {
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
      const fail = () => ({ status: 1, stdout: '', stderr: '' });
      if (cmd !== 'git') return fail();
      const a = args.slice(2).join(' '); // drop the leading `-C <root>`
      if (a === 'rev-parse HEAD') return ok(TIP);
      // Tip 1s old ⇒ inside the quiet window ⇒ the cut steps back to CAND.
      if (a.startsWith('show -s --format=%ct')) return ok(String(NOW() - (cut ? 1 : 10_000)));
      if (a.startsWith('rev-list -1 --before=@')) return ok(CAND);
      if (a === 'rev-parse --verify ready') return fail(); // no `ready` ref in this fixture
      if (a.startsWith('log --no-decorate --format='))
        return ok(excluded.map((e) => `${e.sha}\x1f${NOW() - e.agoSec}\x1f${e.subject}`).join('\n'));
      return fail();
    });

  type Containment = Awaited<ReturnType<typeof checkpointCandidateContainment>>;
  const containment = (over: Partial<Containment>) =>
    (async () => ({
      candidateSha: CAND,
      tipSha: TIP,
      source: 'caller-supplied' as const,
      included: [],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
      ...over,
    })) as unknown as typeof checkpointCandidateContainment;

  /** The exact shape the filing's falsifiable check names: a declared path carried ONLY by a
   *  commit newer than the quiet cut. */
  const EXCLUDED_MINE: Partial<Containment> = {
    missing: [MINE],
    paths: [{ path: MINE, inCandidate: false, reason: 'newer-commit', unknownReason: null }],
    excludedCommitsTouchingYourFiles: [{ path: MINE, commits: ['bbb1111 my just-landed fix'] }],
  };

  const assess = (over: Parameters<typeof assessPreLaunchExclusion>[0] = {}) =>
    assessPreLaunchExclusion({
      paths: [MINE],
      root: '/tree',
      activeRun: () => false,
      execFn: gitFake([{ sha: 'bbb1111', agoSec: 120, subject: 'my just-landed fix' }]),
      containmentFn: containment(EXCLUDED_MINE),
      ...over,
    });

  it('REFUSES when a declared path is carried only by a commit the quiet cut excluded', async () => {
    const v = await assess();
    expect(v.refuse).toBe(true);
    expect(v.proceedReason).toBeNull();
    // 240s window, commit 120s old ⇒ eligible in 120s. The wait IS the deliverable: the
    // refusal's whole claim is "seconds, not a 55-minute suite".
    expect(v.waitSec).toBe(120);
    expect(v.blockedPaths).toEqual([{ path: MINE, commits: ['bbb1111 my just-landed fix'], eligibleInSec: 120 }]);
    // The text must leave a MOVE, not just a fact — both exits, named, with the cost of each.
    const note = renderPreLaunchRefusal(v);
    expect(note).toMatch(/waitForEligibility:true/);
    expect(note).toMatch(/force:true/);
    expect(note).toMatch(/120s/);
  });

  /* ---- fail-open paths. Each gets its own case: a guard is only as trustworthy as the
     conditions under which it declines to fire. ---- */

  it('CONTROL: launches when the candidate DOES carry every declared path', async () => {
    const v = await assess({
      containmentFn: containment({
        included: [MINE],
        paths: [{ path: MINE, inCandidate: true, reason: null, unknownReason: null }],
      }),
    });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('declared-paths-in-candidate');
  });

  it("launches on an UNCOMMITTED miss — waiting cannot fix it, and the dirt may be a peer's", async () => {
    const v = await assess({
      containmentFn: containment({
        missing: [MINE],
        paths: [{ path: MINE, inCandidate: false, reason: 'uncommitted', unknownReason: null }],
        excludedCommitsTouchingYourFiles: [{ path: MINE, commits: ['bbb1111 my just-landed fix'] }],
      }),
    });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('exclusion-undecidable');
  });

  it('launches when NO excluded commit names the path — the literal-exclusion requirement', async () => {
    const v = await assess({
      containmentFn: containment({
        missing: [MINE],
        paths: EXCLUDED_MINE.paths,
        excludedCommitsTouchingYourFiles: [],
      }),
    });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('exclusion-undecidable');
  });

  it('launches when the blocking commit has no computable eligibility', async () => {
    // The excluded-commit window does not contain the sha containment named, so the wait is
    // unknown — and an unknown wait must never harden into a refusal.
    const v = await assess({ execFn: gitFake([{ sha: 'c0ffee0', agoSec: 120, subject: 'someone else' }]) });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('exclusion-undecidable');
  });

  it('launches when the wait would exceed the cap — a refusal may only ever mean "wait briefly"', async () => {
    process.env.PAPERCUSP_QUIET_CUT_SEC = '600';
    const v = await assess({ execFn: gitFake([{ sha: 'bbb1111', agoSec: 100, subject: 'my just-landed fix' }]) });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('wait-exceeds-cap');
    expect(v.waitSec).toBe(500);
    expect(v.waitSec!).toBeGreaterThan(PRELAUNCH_EXCLUSION_MAX_WAIT_SEC);
  });

  it('launches when the commit is ALREADY eligible — the run re-resolves and will pick it up', async () => {
    const v = await assess({ execFn: gitFake([{ sha: 'bbb1111', agoSec: 900, subject: 'my just-landed fix' }]) });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('ages-in-at-launch');
  });

  it('launches when nothing was cut (candidate === tip)', async () => {
    const v = await assess({ execFn: gitFake([], false) });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('no-quiet-cut');
  });

  it('launches when a run is already in flight — already_running is the more actionable answer', async () => {
    const v = await assess({ activeRun: () => true });
    expect(v.refuse).toBe(false);
    expect(v.proceedReason).toBe('run-already-active');
  });

  it('does no git work at all without declared paths, and none under force', async () => {
    const execFn = gitFake([{ sha: 'bbb1111', agoSec: 120, subject: 'x' }]);
    expect((await assess({ paths: [], execFn })).proceedReason).toBe('no-declared-paths');
    expect((await assess({ force: true, execFn })).proceedReason).toBe('forced');
    // The inferred working-tree set is the whole fleet's dirt and attributes to nobody, so an
    // undeclared call must not even resolve a candidate.
    expect(execFn).not.toHaveBeenCalled();
  });
});
