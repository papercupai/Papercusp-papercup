import { describe, it, expect, beforeAll } from 'vitest';
import { BG_HOST_HOT_PATHS as SERVICE_HEALTH_BG_HOST_HOT_PATHS } from '../../../../packages/operator-core/lib/service-health';

// Don't let the watchdog's poll loop auto-start on import — exercise the pure decision logic only.
process.env.PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART = '1';

let parseIdleSec: (s: unknown) => number | null;
let parseRoutineLiveness: (
  s: unknown,
) => { idleSec: number | null; overdueCount: number; activeCount: number } | null;
let shouldAlertSelectiveRoutineBacklog: (overdueCount: number, activeCount: number) => boolean;
let selectiveRoutineBacklogAlertMessage: (snapshot: {
  idleSec: number | null;
  overdueCount: number;
  activeCount: number;
}) => string | null;
let routineLivenessSnapshot: (
  dbUrl: string | null,
  deps?: {
    sh?: (
      cmd: string,
      args: string[],
      opts?: { timeout?: number },
    ) => Promise<{ err: Error | null; stdout: string }>;
  },
) => Promise<{ idleSec: number | null; overdueCount: number; activeCount: number } | null>;
let isFrozen: (idleSec: number | null | undefined, freezeSilenceS?: number) => boolean;
let resolveDbUrl: (readFile?: (p: string, enc: string) => string) => string | null;
let shouldRestart: (idleSec: number | null, schedSec: number | null, freezeSilenceS?: number) => boolean;
let withinBootGrace: (activeForSec: number | null | undefined, bootGraceMs?: number) => boolean;
let nextDebounceMs: (baseMs: number, consecutiveRestarts: number, multiplier?: number, capMs?: number) => number;
let shouldAlert: (consecutiveRestarts: number, alertAfter?: number) => boolean;
let shouldClearStrikes: (healthyStreak: number, sustainedPolls?: number) => boolean;
let maxReachableRestartsPerHr: (bootGraceMs?: number, pollMs?: number) => number;
let poolShedExplainsFreeze: (idleSec: number | null, shedIdleSec: number | null, graceSec?: number) => boolean;
let poolShedSuppressionHolds: (
  shedExplains: boolean,
  hostAlive: boolean | null,
  suppressedForSec: number | null,
  maxSuppressSec?: number,
) => boolean;
let probeHostLiveness: (
  url?: string,
  timeoutMs?: number,
  deps?: { fetch?: unknown },
) => Promise<{ alive: boolean | null; why: string }>;
let saturationExtendsGrace: (
  activeForSec: number | null | undefined,
  cpuTicksDelta: number | null | undefined,
  suppressedForSec?: number | null,
  bootGraceMs?: number,
  maxSuppressS?: number,
  minTicks?: number,
) => boolean;
let procTreeCpuTicks: (
  rootPid: number,
  deps?: {
    readFile?: (p: string, enc: string) => string;
    readDir?: (p: string) => string[];
    maxPids?: number;
  },
) => number | null;
let alertFleet: (
  summary: string,
  deps?: {
    dbUrl?: string | null;
    sh?: (cmd: string, args: string[], opts?: { stdin?: string }) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
    log?: (m: string) => void;
  },
) => Promise<boolean>;
let circuitOpenMessage: (
  reason: string,
  restartCount: number,
  cap: number,
  snapshot?: { cores: number; load1: number; loadPerCore: number; availableRatio: number; hasHeadroom: boolean } | null,
) => string;
type CollateralEntry = { pid: number; cmdline: string };
type CollateralSummary = {
  total: number;
  own: number;
  spawner: number;
  desktop: number;
  other: number;
  collateral: number;
  otherSample: string[];
};
let parseCgroupProcs: (text: unknown) => number[];
let classifyCollateral: (entries: CollateralEntry[] | null | undefined) => CollateralSummary | null;
let collateralAlertMessage: (unit: string, summary: CollateralSummary | null, reason: string) => string | null;
let readCollateral: (deps?: {
  sh?: (cmd: string, args: string[]) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
  readFile?: (p: string, enc: string) => string;
  unit?: string;
}) => Promise<CollateralSummary | null>;
let BG_HOST_COMMITTED_HOT_PATHS: readonly string[];
type ActivationInput = {
  activeForSec: number | null;
  latestCommitMs: number | null;
  nowMs: number | null;
  dirtyEntries: string[] | null;
  collateral: { collateral: number } | null;
};
type ActivationVerdict = {
  activate: boolean;
  code: string;
  dirtyCount?: number;
  dirtySample?: string[];
  collateral?: number;
};
let evaluateCommittedHotPathActivation: (input: ActivationInput) => ActivationVerdict;
let shouldCheckCommittedHotPathActivation: (input: {
  inFlight: boolean;
  lastCheckMs: number;
  nowMs: number;
  intervalMs: number;
}) => boolean;
let readCommittedHotPathState: (deps?: {
  root?: string;
  sh?: (
    cmd: string,
    args: string[],
    opts?: { stdin?: string; timeout?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
}) => Promise<{
  root: string | null;
  latestCommitMs: number | null;
  latestCommitHash: string | null;
  dirtyEntries: string[] | null;
  error: string | null;
}>;
let requestCommittedHotPathRestart: (
  hash: string,
  deps?: {
    ptoolScript?: string;
    sh?: (
      cmd: string,
      args: string[],
      opts?: { stdin?: string; timeout?: number },
    ) => Promise<{ err: Error | null; stdout: string; stderr?: string }>;
    verifyGeneration?: (beforePid: number | null) => Promise<{
      verified: boolean;
      beforePid: number | null;
      observedPid: number | null;
      waitedMs: number;
      code: string;
    }>;
  },
) => Promise<{ ok: boolean; restarted: boolean; coalesced: boolean; code: string }>;
let waitForBgHostRestartGeneration: (
  beforePid: number | null,
  deps?: {
    sh?: (
      cmd: string,
      args: string[],
      opts?: { timeout?: number },
    ) => Promise<{ err: Error | null; stdout: string }>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    waitMs?: number;
    pollMs?: number;
  },
) => Promise<{
  verified: boolean;
  beforePid: number | null;
  observedPid: number | null;
  waitedMs: number;
  code: string;
}>;
beforeAll(async () => {
  ({
    parseIdleSec,
    parseRoutineLiveness,
    shouldAlertSelectiveRoutineBacklog,
    selectiveRoutineBacklogAlertMessage,
    routineLivenessSnapshot,
    isFrozen,
    resolveDbUrl,
    shouldRestart,
    withinBootGrace,
    nextDebounceMs,
    shouldAlert,
    shouldClearStrikes,
    maxReachableRestartsPerHr,
    poolShedExplainsFreeze,
    poolShedSuppressionHolds,
    probeHostLiveness,
    saturationExtendsGrace,
    procTreeCpuTicks,
    alertFleet,
    circuitOpenMessage,
    parseCgroupProcs,
    classifyCollateral,
    collateralAlertMessage,
    readCollateral,
    BG_HOST_COMMITTED_HOT_PATHS,
    evaluateCommittedHotPathActivation,
    shouldCheckCommittedHotPathActivation,
    readCommittedHotPathState,
    requestCommittedHotPathRestart,
    waitForBgHostRestartGeneration,
    // PROBE_SCRIPT points the WHOLE suite — pure functions included — at a mutated COPY outside the
    // tree, so scripts/mutation-probe.sh can prove falsifiability without ever mutating the shared
    // working tree (git-sync would commit the mutant mid-probe).
    //
    // ⚠ This used to be a hardcoded '../bghost-watchdog.mjs' while the source-text WIRING blocks below
    // already honored PROBE_SCRIPT. The result was a copy-out probe that ran happily, reported "MUTANT
    // SURVIVED", and was measuring the REAL module the whole time — i.e. it could only ever falsify the
    // grep-shaped tests, and read as evidence that a perfectly good behavioural guard was weak. Caught
    // 2026-08-10 probing the EI-20025430746362695 liveness requirement.
  } = await import(/* @vite-ignore */ process.env.PROBE_SCRIPT || '../bghost-watchdog.mjs'));
});

describe('committed bg-host hot-path activation (EI-18133447445064828)', () => {
  const NOW = 1_000_000;
  const safe: ActivationInput = {
    activeForSec: 100,
    latestCommitMs: 950_000,
    nowMs: NOW,
    dirtyEntries: [],
    collateral: { collateral: 0 },
  };

  it('pins the external watchdog hot-path list to service-health.ts canonical coverage', () => {
    expect([...BG_HOST_COMMITTED_HOT_PATHS]).toEqual([...SERVICE_HEALTH_BG_HOST_HOT_PATHS]);
  });

  it('activates only for a newer committed change, a clean tree, and known-zero collateral', () => {
    expect(evaluateCommittedHotPathActivation(safe)).toMatchObject({ activate: true, code: 'activate' });
  });

  it.each([
    ['generation age unknown', { activeForSec: null }, 'generation_unknown'],
    ['clock unknown', { nowMs: null }, 'clock_unknown'],
    ['commit unknown', { latestCommitMs: null }, 'commit_unknown'],
    ['future-dated commit', { latestCommitMs: NOW + 1 }, 'commit_time_future'],
    ['running generation is current', { latestCommitMs: NOW - 101_000 }, 'generation_current'],
    ['cleanliness unknown', { dirtyEntries: null }, 'cleanliness_unknown'],
    ['collateral unknown', { collateral: null }, 'collateral_unknown'],
    ['collateral present', { collateral: { collateral: 1 } }, 'collateral_present'],
  ])('fails closed when %s', (_label, patch, code) => {
    expect(evaluateCommittedHotPathActivation({ ...safe, ...patch })).toMatchObject({
      activate: false,
      code,
    });
  });

  it('suppresses on ANY dirty hot-path entry, including an untracked test file', () => {
    const verdict = evaluateCommittedHotPathActivation({
      ...safe,
      dirtyEntries: [' M packages/operator-core/lib/events/await/store.ts', '?? packages/operator-core/lib/events/new.test.ts'],
    });
    expect(verdict).toMatchObject({ activate: false, code: 'hot_paths_dirty', dirtyCount: 2 });
  });

  it('throttles repeated checks and refuses an overlapping check', () => {
    expect(shouldCheckCommittedHotPathActivation({ inFlight: false, lastCheckMs: 0, nowMs: 10, intervalMs: 300 })).toBe(true);
    expect(shouldCheckCommittedHotPathActivation({ inFlight: true, lastCheckMs: 0, nowMs: 10, intervalMs: 300 })).toBe(false);
    expect(shouldCheckCommittedHotPathActivation({ inFlight: false, lastCheckMs: 100, nowMs: 399, intervalMs: 300 })).toBe(false);
    expect(shouldCheckCommittedHotPathActivation({ inFlight: false, lastCheckMs: 100, nowMs: 400, intervalMs: 300 })).toBe(true);
  });

  it('reads the latest NON-TEST commit but treats every dirty/untracked hot-path file as unsafe', async () => {
    const calls: Array<{ args: string[]; options?: { env?: NodeJS.ProcessEnv } }> = [];
    const state = await readCommittedHotPathState({
      root: '/repo',
      sh: async (_cmd, args, options) => {
        calls.push({ args, options });
        if (args.includes('log')) return { err: null, stdout: '950\u0000abcdef1234567890\n' };
        return {
          err: null,
          stdout:
            ' M packages/operator-core/lib/events/await/store.ts\u0000' +
            '?? packages/operator-core/lib/events/new.test.ts\u0000',
        };
      },
    });
    expect(state).toMatchObject({
      latestCommitMs: 950_000,
      latestCommitHash: 'abcdef1234567890',
      dirtyEntries: [
        'M packages/operator-core/lib/events/await/store.ts',
        '?? packages/operator-core/lib/events/new.test.ts',
      ],
      error: null,
    });
    const logArgs = calls.find((call) => call.args.includes('log'))!.args;
    const statusCall = calls.find((call) => call.args.includes('status'))!;
    const statusArgs = statusCall.args;
    expect(logArgs).toContain(':(exclude,glob)**/*.test.ts');
    expect(logArgs).toContain(':(exclude,glob)**/__tests__/**');
    expect(logArgs).toContain(
      ':(glob)packages/operator-core/lib/events/**/*.ts',
    );
    expect(logArgs).toContain(':(glob)packages/operator-core/lib/red-queen/**/*.ts');
    expect(logArgs).toContain('packages/operator-core/lib/release/routine-engine-liveness.ts');
    expect(statusArgs).toContain('--untracked-files=all');
    expect(statusArgs).toContain('packages/operator-core/lib/red-queen');
    expect(statusArgs).toContain('packages/operator-core/lib/release/routine-engine-liveness.ts');
    expect(statusArgs).not.toContain(':(exclude,glob)**/*.test.ts');
    expect(statusCall.options?.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0' });
  });

  it('waits out a git-sync fire but still fast-fails an exclusive-resource holder, with no unsafe overrides', async () => {
    const calls: Array<{ cmd: string; args: string[]; opts?: { stdin?: string; timeout?: number } }> = [];
    const outcome = await requestCommittedHotPathRestart('abcdef1234567890', {
      ptoolScript: '/repo/apps/operator/scripts/ptool.mjs',
      sh: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (args.includes('dev:restart')) {
          return {
            err: null,
            stdout: JSON.stringify({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 4242 }),
          };
        }
        return {
          err: null,
          stdout: '5252\n',
        };
      },
    });
    expect(outcome).toMatchObject({ ok: true, restarted: true, code: 'restarted' });
    expect(calls[0]?.cmd).toBe(process.execPath);
    expect(calls[0]?.args).toEqual([
      '/repo/apps/operator/scripts/ptool.mjs',
      'dev:restart',
      '--json',
      '-',
    ]);
    expect(calls[1]?.args).toEqual(['--user', 'show', 'papercusp-bg-host', '-p', 'MainPID', '--value']);
    const payload = JSON.parse(calls[0]?.opts?.stdin ?? '{}');
    expect(payload).toMatchObject({
      target: 'bg-host',
      confirm: true,
      authorize: true,
      // Unchanged: an exclusive-resource holder is doing consequential work, so this automatic
      // lane still refuses immediately rather than waiting it out.
      max_drain_sec: 0,
    });
    expect(payload.reason).toContain('abcdef123456');

    // EI-22089912517133068 — THE REGRESSION GUARD. dev:restart refuses on
    // git_sync_collision_operation_in_flight iff `blocked && drainSec === 0`, so a zero/absent
    // drain makes that refusal unconditional for this lane (measured: 33.6% of 143 activation
    // attempts, longest run 8 consecutive ≈ 40min of committed code not activating). A bounded
    // wait is the supported way through; it must be a real, positive number.
    expect(typeof payload.git_sync_drain_sec).toBe('number');
    expect(payload.git_sync_drain_sec).toBeGreaterThan(0);
    // ...and stay under dev:restart's own GIT_SYNC_RESTART_BARRIER_DRAIN_SEC ceiling, or the tool
    // rejects the call outright — a schema refusal, not a drain.
    expect(payload.git_sync_drain_sec).toBeLessThanOrEqual(120);

    // The drain must NOT have been bought with the dangerous override: that SIGKILLs an in-flight
    // commit and strands a peer's uncommitted work. An unattended lane may never reach for it.
    expect(payload).not.toHaveProperty('override_git_sync_collision');
    expect(payload).not.toHaveProperty('override_gate_collision');
    expect(payload).not.toHaveProperty('override_boot_integrity');

    // The ptool budget must COVER the drain we just asked it to wait out. Without this, a drain
    // that works still lands as `ptool_failed` — trading one refusal code for another.
    expect(calls[0]?.opts?.timeout).toBeGreaterThan(payload.git_sync_drain_sec * 1_000);
    expect(calls[0]?.opts?.timeout).toBe(30_000 + payload.git_sync_drain_sec * 1_000);
  });

  it('requires a changed MainPID before accepting the detached bg-host restart', async () => {
    let now = 0;
    const pids = ['4242', '4242', '5252'];
    const verification = await waitForBgHostRestartGeneration(4242, {
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      waitMs: 10,
      pollMs: 1,
      sh: async () => ({ err: null, stdout: `${pids.shift() ?? '5252'}\n` }),
    });
    expect(verification).toMatchObject({
      verified: true,
      beforePid: 4242,
      observedPid: 5252,
      code: 'generation_changed',
    });
  });

  it('fails closed when the detached restart leaves the old generation in place', async () => {
    let now = 0;
    const verification = await waitForBgHostRestartGeneration(4242, {
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      waitMs: 2,
      pollMs: 1,
      sh: async () => ({ err: null, stdout: '4242\n' }),
    });
    expect(verification).toMatchObject({
      verified: false,
      beforePid: 4242,
      observedPid: 4242,
      code: 'generation_unchanged',
    });

    await expect(
      requestCommittedHotPathRestart('abc', {
        sh: async () => ({
          err: null,
          stdout: JSON.stringify({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 4242 }),
        }),
        verifyGeneration: async () => verification,
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'restart_unverified' });
  });

  it('fails closed when ptool fails or returns a refusal', async () => {
    await expect(
      requestCommittedHotPathRestart('abc', {
        sh: async () => ({ err: new Error('boom'), stdout: '' }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'ptool_failed' });
    await expect(
      requestCommittedHotPathRestart('abc', {
        sh: async () => ({ err: null, stdout: JSON.stringify({ ok: false, reason: 'gate_collision' }) }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'gate_collision' });
    // ptool exits 5 on an ok:false answer (EI-24654733539966460): the refusal arrives
    // WITH an exec error, and its reason must survive instead of collapsing to ptool_failed.
    await expect(
      requestCommittedHotPathRestart('abc', {
        sh: async () => ({ err: new Error('Command failed: exit 5'), stdout: JSON.stringify({ ok: false, reason: 'gate_collision' }) }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'gate_collision' });
  });

  it('wires activation before PG freshness and exits the poll after a real restart request', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const subject =
      process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
    const src = readFileSync(subject, 'utf8');
    const start = src.indexOf('async function poll(');
    const pollBody = src.slice(start, src.indexOf('\n/** Mirrors build-info.ts', start));
    const activationIdx = pollBody.indexOf('await maybeActivateCommittedHotPathCode(');
    const dbIdx = pollBody.indexOf('await resolveDbUrlAsync(');
    expect(activationIdx).toBeGreaterThan(-1);
    expect(activationIdx).toBeLessThan(dbIdx);
    expect(pollBody).toContain('if (activation.restartRequested) return;');
  });
});

/**
 * EI-2434: the bg-host watchdog used to restart on journalctl SILENCE, which a wedged journald faked on a
 * HEALTHY ticker → false restart → EI-2186 reclaimed in-flight bees. It now keys on the PG routine
 * fire-freshness (journald-independent). The critical invariant: a MISSING/UNKNOWN signal must NEVER be
 * read as "frozen" (that asymmetry is the whole bug class).
 */
describe('bghost-watchdog — journald-independent freeze signal (EI-2434)', () => {
  describe('parseIdleSec', () => {
    it('parses a numeric idle-seconds scalar', () => expect(parseIdleSec('32\n')).toBe(32));
    it('parses 0 (just fired)', () => expect(parseIdleSec('0')).toBe(0));
    it('empty (no active routines) ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('')).toBeNull();
      expect(parseIdleSec('   \n')).toBeNull();
    });
    it('NULL (no fires yet) ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('null')).toBeNull();
      expect(parseIdleSec('NULL\n')).toBeNull();
    });
    it('junk / undefined ⇒ UNKNOWN(null)', () => {
      expect(parseIdleSec('xyz')).toBeNull();
      expect(parseIdleSec(undefined)).toBeNull();
    });
  });

  describe('selective routine backlog signal', () => {
    it('alerts on the measured 77/363 backlog even when global routine freshness is healthy', () => {
      const snapshot = parseRoutineLiveness('224|77|363');
      expect(snapshot).toEqual({ idleSec: 224, overdueCount: 77, activeCount: 363 });
      expect(isFrozen(snapshot!.idleSec, 240)).toBe(false);
      expect(shouldAlertSelectiveRoutineBacklog(snapshot!.overdueCount, snapshot!.activeCount)).toBe(true);
      expect(selectiveRoutineBacklogAlertMessage(snapshot!)).toContain('77 of 363');
    });

    it('requires both a minimum backlog and a minimum share of schedulable routines', () => {
      expect(shouldAlertSelectiveRoutineBacklog(9, 90)).toBe(false);
      expect(shouldAlertSelectiveRoutineBacklog(10, 101)).toBe(false);
      expect(shouldAlertSelectiveRoutineBacklog(10, 100)).toBe(true);
      expect(shouldAlertSelectiveRoutineBacklog(1, 363)).toBe(false);
      expect(shouldAlertSelectiveRoutineBacklog(77, 0)).toBe(false);
      expect(shouldAlertSelectiveRoutineBacklog(101, 100)).toBe(false);
      expect(parseRoutineLiveness('not-a-census')).toBeNull();
    });

    it('reads global freshness and the active durable schedule census in one bounded psql call', async () => {
      const calls: Array<{ cmd: string; args: string[]; opts?: { timeout?: number } }> = [];
      const snapshot = await routineLivenessSnapshot('postgresql://test', {
        sh: async (cmd, args, opts) => {
          calls.push({ cmd, args, opts });
          return { err: null, stdout: '224|77|363' };
        },
      });
      expect(snapshot).toEqual({ idleSec: 224, overdueCount: 77, activeCount: 363 });
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('psql');
      expect(calls[0].args.slice(0, 2)).toEqual(['postgresql://test', '-tAqc']);
      expect(calls[0].args[2]).toContain("tier = 'durable'");
      expect(calls[0].args[2]).toContain("next_fire_at < now() - interval '30 minutes'");
      expect(calls[0].args[2]).toContain("NOT jsonb_exists(trigger_config, 'cron')");
      expect(calls[0].opts).toEqual({ timeout: 10_000 });
    });
  });

  describe('isFrozen', () => {
    it('fresh (idle < threshold) ⇒ not frozen', () => {
      expect(isFrozen(3, 100)).toBe(false);
      expect(isFrozen(32, 100)).toBe(false);
    });
    it('exactly at threshold ⇒ not frozen', () => expect(isFrozen(100, 100)).toBe(false));
    it('over threshold ⇒ frozen', () => {
      expect(isFrozen(101, 100)).toBe(true);
      expect(isFrozen(600, 100)).toBe(true);
    });
    it('UNKNOWN(null/undefined) is NEVER frozen — the core EI-2434 fix', () => {
      expect(isFrozen(null, 100)).toBe(false);
      expect(isFrozen(undefined, 100)).toBe(false);
    });
  });

  /**
   * 2026-06-23 routines-queue-saturation false-restart fix: a stale routine `last_fired_at` alone is
   * ambiguous — it means a genuine freeze OR a SATURATED fire-queue (legit long routines holding every
   * `routines` slot). Restarting during saturation killed the long routines mid-run + re-saturated → a
   * 5-min restart LOOP that froze git-sync/deploys for hours. `shouldRestart` corroborates with the
   * SCHEDULER (routinesTick) liveness: restart ONLY when fires are stale AND the scheduler is not
   * confirmed-fresh (a real freeze stalls both; saturation leaves the scheduler ticking).
   */
  describe('shouldRestart — saturation vs freeze (2026-06-23)', () => {
    it('healthy fires ⇒ never restart (regardless of scheduler)', () => {
      expect(shouldRestart(3, 3, 100)).toBe(false);
      expect(shouldRestart(32, 999, 100)).toBe(false);
    });
    it('UNKNOWN fires (null) ⇒ never restart', () => {
      expect(shouldRestart(null, null, 100)).toBe(false);
      expect(shouldRestart(null, 999, 100)).toBe(false);
    });
    it('SATURATION: fires stale BUT scheduler fresh ⇒ NOT a freeze, do not restart (the core fix)', () => {
      expect(shouldRestart(267, 29, 100)).toBe(false);
      expect(shouldRestart(600, 100, 100)).toBe(false); // scheduler exactly at threshold = still fresh
    });
    it('GENUINE FREEZE: fires stale AND scheduler also stale ⇒ restart', () => {
      expect(shouldRestart(267, 267, 100)).toBe(true);
      expect(shouldRestart(150, 101, 100)).toBe(true);
    });
    it('fires stale + scheduler UNKNOWN(null) ⇒ restart (fall back to the documented fire-staleness net)', () => {
      expect(shouldRestart(267, null, 100)).toBe(true);
    });
  });

  /**
   * EI-8901: the staleness signal (routine last_fired_at / routinesTick) is read from PG and SPANS process
   * restarts, so a freshly-restarted unit that hasn't ticked yet still reads as frozen — under load, boot
   * takes longer than the restart debounce, so every new generation gets judged frozen before it can
   * possibly tick → a restart storm. `withinBootGrace` gates the freeze judgment on how long the unit has
   * actually been in its current active generation (systemd's own ActiveEnterTimestampMonotonic), so a
   * unit still booting is never mistaken for "frozen".
   */
  describe('withinBootGrace — restart-storm fix (EI-8901)', () => {
    it('just restarted (well under the grace window) ⇒ within grace', () => {
      expect(withinBootGrace(5, 8 * 60_000)).toBe(true);
      expect(withinBootGrace(0, 8 * 60_000)).toBe(true);
    });
    it('past the grace window ⇒ not within grace (judge normally)', () => {
      expect(withinBootGrace(9 * 60, 8 * 60_000)).toBe(false);
      expect(withinBootGrace(3600, 8 * 60_000)).toBe(false);
    });
    it('exactly at the grace boundary ⇒ not within grace (>= is the cutoff)', () => {
      expect(withinBootGrace(8 * 60, 8 * 60_000)).toBe(false);
    });
    it('UNKNOWN active-for (null/undefined) ⇒ NEVER within grace — never invent suppression from a missing signal', () => {
      expect(withinBootGrace(null, 8 * 60_000)).toBe(false);
      expect(withinBootGrace(undefined, 8 * 60_000)).toBe(false);
    });
    it('a negative active-for (clock skew / bad read) ⇒ not within grace', () => {
      expect(withinBootGrace(-5, 8 * 60_000)).toBe(false);
    });
  });

  /**
   * WI-3630: EI-8901's boot-grace stops the common storm case, but a boot slower than the grace window
   * would still hit the OLD flat debounce and get re-killed right as it might finish. `nextDebounceMs`
   * backs off exponentially per consecutive restart (capped) so an unusually slow boot gets progressively
   * more room; `shouldAlert` fires well before the hard hourly circuit breaker so a developing storm is
   * visible early, not only once fully tripped.
   */
  describe('nextDebounceMs — exponential backoff per consecutive strike (WI-3630)', () => {
    it('first strike (0 consecutive so far) ⇒ the base debounce, unscaled', () => {
      expect(nextDebounceMs(5 * 60_000, 0, 2, 30 * 60_000)).toBe(5 * 60_000);
    });
    it('doubles per consecutive strike', () => {
      expect(nextDebounceMs(5 * 60_000, 1, 2, 30 * 60_000)).toBe(10 * 60_000);
      expect(nextDebounceMs(5 * 60_000, 2, 2, 30 * 60_000)).toBe(20 * 60_000);
    });
    it('caps at capMs — never grows unbounded', () => {
      expect(nextDebounceMs(5 * 60_000, 10, 2, 30 * 60_000)).toBe(30 * 60_000);
    });
    it('a negative/garbage strike count is treated as 0 (never SHRINKS the debounce below base)', () => {
      expect(nextDebounceMs(5 * 60_000, -3, 2, 30 * 60_000)).toBe(5 * 60_000);
    });
  });

  describe('shouldAlert — early storm visibility, ahead of the hard circuit breaker (WI-3630)', () => {
    it('under the alert threshold ⇒ no alert yet', () => {
      expect(shouldAlert(0, 2)).toBe(false);
      expect(shouldAlert(1, 2)).toBe(false);
    });
    it('at or over the alert threshold ⇒ alert', () => {
      expect(shouldAlert(2, 2)).toBe(true);
      expect(shouldAlert(5, 2)).toBe(true);
    });
    it('fires well before the hourly circuit-breaker cap (6) so a developing storm is caught early', () => {
      expect(shouldAlert(2, 2)).toBe(true); // default ALERT_AFTER_RESTARTS=2 << default MAX_RESTARTS_PER_HR=6
    });
  });

  /**
   * WI-37501: a restart-loop escalation bug found live 2026-08-09. A stalled bg-host fired exactly one
   * routine early in boot, clearing the strike counter after a SINGLE healthy poll — so BACKOFF_MULTIPLIER
   * escalation never engaged and every restart looked like a first offence, floored at
   * BOOT_GRACE_MS+POLL_MS = 510s (7.06/hr), just under the OLD MAX_RESTARTS_PER_HR=8 cap.
   */
  describe('shouldClearStrikes — sustained health before clearing the strike counter (WI-37501)', () => {
    it('under the sustained-polls threshold ⇒ do not clear yet (the exact live bug: one healthy poll)', () => {
      expect(shouldClearStrikes(1, 3)).toBe(false);
      expect(shouldClearStrikes(2, 3)).toBe(false);
    });
    it('at or over the sustained-polls threshold ⇒ clear', () => {
      expect(shouldClearStrikes(3, 3)).toBe(true);
      expect(shouldClearStrikes(5, 3)).toBe(true);
    });
    it('zero streak (no healthy poll yet) ⇒ never clear', () => {
      expect(shouldClearStrikes(0, 3)).toBe(false);
    });
  });

  describe('maxReachableRestartsPerHr — the circuit breaker must be arithmetically reachable (WI-37501)', () => {
    it('at the (post-fix) defaults, 6/hr sits below the reachable ceiling', () => {
      const ceiling = maxReachableRestartsPerHr(8 * 60_000, 30_000); // BOOT_GRACE_MS, POLL_MS defaults
      expect(ceiling).toBeCloseTo(3_600_000 / (8 * 60_000 + 30_000), 5);
      expect(6).toBeLessThan(ceiling); // the new default cap
    });
    it('reproduces the live defect: the OLD cap (8) sat AT/ABOVE the reachable ceiling', () => {
      const ceiling = maxReachableRestartsPerHr(8 * 60_000, 30_000);
      expect(ceiling).toBeLessThan(8); // 7.058... < 8 — the breaker could never trip
    });
    it('a tighter boot-grace/poll cadence raises the reachable ceiling', () => {
      const looser = maxReachableRestartsPerHr(60_000, 5_000);
      const tighter = maxReachableRestartsPerHr(8 * 60_000, 30_000);
      expect(looser).toBeGreaterThan(tighter);
    });
  });

  /**
   * WI-37506: `shouldRestart`'s saturation corroboration (`schedulerIdleSec`) assumes a stale
   * `routinesTick` scheduler signal means a dead ticker. Under genuine PG-pool starvation that
   * assumption breaks — `dbos.workflow_status` (read by BOTH `routineIdleSec` and `schedulerIdleSec`)
   * lives on the same starved pool a critical shed reports on, so both signals can go stale together
   * while the ticker is merely SHEDDING, not dead. `poolShedExplainsFreeze` corroborates with the
   * durable pool-shed record (pool-pressure.ts's `recordPoolShedEvent`) — the same signal
   * `engine-death.ts`'s `hasPoolShedInWindow` already uses for the sibling infra-liveness alarm
   * (WI-5456) — before the more consequential DESTRUCTIVE restart decision.
   */
  describe('poolShedExplainsFreeze — pool-starvation corroboration (WI-37506)', () => {
    it('a shed event within the freeze window (+ grace) explains the freeze — do not restart', () => {
      expect(poolShedExplainsFreeze(267, 30, 120)).toBe(true);
      expect(poolShedExplainsFreeze(267, 267, 120)).toBe(true); // shed as old as the freeze itself
    });
    it('a shed event just inside the grace boundary still explains it', () => {
      expect(poolShedExplainsFreeze(100, 220, 120)).toBe(true); // 220 <= 100+120
    });
    it('a shed event older than the freeze window + grace does NOT explain it — restart', () => {
      expect(poolShedExplainsFreeze(100, 221, 120)).toBe(false); // 221 > 100+120
      expect(poolShedExplainsFreeze(60, 6000, 120)).toBe(false); // a stale, long-past shed from a prior incident
    });
    it('UNKNOWN shedIdleSec (null — no shed ever recorded, or the query failed) NEVER explains a freeze', () => {
      // The core asymmetry: absence of a clean shed signal must never suppress a restart that would
      // otherwise be correct, mirroring isFrozen/withinBootGrace's null-is-never-frozen/grace rule.
      expect(poolShedExplainsFreeze(267, null, 120)).toBe(false);
      expect(poolShedExplainsFreeze(null, null, 120)).toBe(false);
    });
    it('a null idleSec with a fresh shed still explains it (treated as 0)', () => {
      expect(poolShedExplainsFreeze(null, 10, 120)).toBe(true);
    });
  });

  describe('alertFleet — best-effort fleet-wide broadcast (WI-3630)', () => {
    it('inserts a topic-routed coord_event_log row with active subscribers resolved in the same SQL statement', async () => {
      const calls: Array<{ cmd: string; args: string[]; opts?: { stdin?: string } }> = [];
      const sh = async (cmd: string, args: string[], opts?: { stdin?: string }) => {
        calls.push({ cmd, args, opts });
        return { err: null, stdout: '', stderr: '' };
      };
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: () => {} });
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('psql');
      expect(calls[0].args[0]).toBe('postgresql://test');
      // bind-variable args, not interpolated straight into the SQL string
      expect(calls[0].args).toContain('-v');
      const jsonBodyArg = calls[0].args.find((a) => a.startsWith('jsonbody='));
      expect(jsonBodyArg).toBeDefined();
      const parsed = JSON.parse(jsonBodyArg!.slice('jsonbody='.length));
      expect(parsed).toMatchObject({
        from: 'system-watchdog',
        to: [],
        audience: ['@topic:severe-events'],
        kind: 'message',
        summary: 'test alert body',
        category: 'severe-event',
      });
      const sql = calls[0].opts?.stdin ?? '';
      expect(sql).toContain('harness_shared.coord_event_log');
      expect(sql).toContain('harness_shared.coord_entity_subscriptions');
      expect(sql).toContain("target_ref = 'severe-events'");
      expect(sql).toContain('cancelled_at IS NULL');
      expect(sql).toContain('expires_ts IS NULL OR expires_ts > now()');
      expect(sql).toContain("jsonb_set(:'jsonbody'::jsonb, '{to}', recipients.ids, true)");
      expect(sql).not.toContain('test alert body'); // never raw-interpolated into the SQL text itself
    });

    it('delivers the SQL via stdin, NEVER -c — psql does not interpolate -v variables in -c strings (EI-9419)', async () => {
      // Regression guard for the 2026-07-10 DBOS outage: alertFleet used `-c "... :'msgid' ..."`,
      // psql sent the :'var' references to the server LITERALLY ("syntax error at or near :"), and
      // every fleet alert since WI-3630 landed failed silently — the 63-min outage went unalerted.
      // -v variables only interpolate in stdin/-f input; pin that delivery shape.
      const calls: Array<{ args: string[]; opts?: { stdin?: string } }> = [];
      const sh = async (_cmd: string, args: string[], opts?: { stdin?: string }) => {
        calls.push({ args, opts });
        return { err: null, stdout: '', stderr: '' };
      };
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: () => {} });
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).not.toContain('-c'); // the bug: -v vars are silently ignored under -c
      expect(calls[0].args).toContain('-f'); // SQL arrives as a stream…
      expect(calls[0].args).toContain('-'); // …specifically stdin
      const sql = calls[0].opts?.stdin ?? '';
      expect(sql).toContain(":'msgid'"); // bind-variable references live in the piped SQL
      expect(sql).toContain(":'jsonbody'");
    });

    it('surfaces psql stderr in the failure log line (delivery failures must be diagnosable)', async () => {
      const logs: string[] = [];
      const sh = async () => ({ err: new Error('Command failed: psql'), stdout: '', stderr: 'ERROR:  syntax error at or near ":"' });
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('syntax error at or near'))).toBe(true);
    });

    it('never throws on a failed insert — fail-soft (a broadcast failure must not break the watchdog)', async () => {
      const logs: string[] = [];
      const sh = async () => ({ err: new Error('psql: connection refused'), stdout: '' });
      const ok = await alertFleet('test alert body', { dbUrl: 'postgresql://test', sh, log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('FAILED'))).toBe(true);
    });

    it('skips (never throws) when no DB url is resolvable', async () => {
      const logs: string[] = [];
      const ok = await alertFleet('test alert body', { dbUrl: null, sh: async () => ({ err: null, stdout: '' }), log: (m: string) => logs.push(m) });
      expect(ok).toBe(false);
      expect(logs.some((l) => l.includes('SKIPPED'))).toBe(true);
    });
  });

  describe('resolveDbUrl', () => {
    const save = () => [process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL, process.env.DATABASE_URL] as const;
    const restore = ([a, b]: readonly [string | undefined, string | undefined]) => {
      a === undefined ? delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL : (process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL = a);
      b === undefined ? delete process.env.DATABASE_URL : (process.env.DATABASE_URL = b);
    };

    it('prefers the explicit DB_URL override', () => {
      const s = save();
      process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL = 'postgresql://override';
      expect(resolveDbUrl(() => 'DATABASE_URL=postgresql://file')).toBe('postgresql://override');
      restore(s);
    });

    it('parses DATABASE_URL out of a .env.local (export prefix + quotes stripped)', () => {
      const s = save();
      delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
      delete process.env.DATABASE_URL;
      const read = () => 'FOO=1\nexport DATABASE_URL="postgresql://harness_admin:pw@localhost:5432/papercusp"\nBAR=2\n';
      expect(resolveDbUrl(read)).toBe('postgresql://harness_admin:pw@localhost:5432/papercusp');
      restore(s);
    });

    it('returns null when nothing is resolvable (no env, unreadable file)', () => {
      const s = save();
      delete process.env.PAPERCUSP_BGHOST_WATCHDOG_DB_URL;
      delete process.env.DATABASE_URL;
      expect(
        resolveDbUrl(() => {
          throw new Error('no .env.local');
        }),
      ).toBeNull();
      restore(s);
    });
  });

  describe('circuitOpenMessage — EI-4027 diagnosis', () => {
    it('does not misdiagnose a headroom host as fleet load/thrashing', () => {
      const message = circuitOpenMessage('ticker genuinely frozen', 8, 8, {
        cores: 128,
        load1: 25,
        loadPerCore: 25 / 128,
        availableRatio: 0.35,
        hasHeadroom: true,
      });

      expect(message).toContain('Host has headroom');
      expect(message).toContain('bg-host ticker/event-loop/DBOS stall');
      expect(message).toContain('ticker genuinely frozen');
      expect(message).not.toMatch(/thrashing|reduce load/i);
    });
  });
});

/**
 * EI-19485006080051257 — the watchdog alerted on restart STORMS but never on COLLATERAL.
 *
 * A restart tears down the unit's whole cgroup (KillMode=control-group), which also holds the agent
 * spawner and the owner's LIVE desktop-app sidecars. The storm alert needs ALERT_AFTER_RESTARTS (2)
 * consecutive strikes and the counter resets on the first healthy poll, so the ORDINARY case — one
 * freeze, one restart, clean recovery — could never alert. The better the watchdog worked, the more
 * certainly the damage went unreported.
 *
 * The invariant these tests pin: "is a storm developing?" (debounced, correctly) and "did we just
 * destroy something that was not ours?" (irreversible, first occurrence) must never share a threshold.
 */
describe('bghost-watchdog — collateral reporting (EI-19485006080051257)', () => {
  // The real cgroup shape, measured 2026-08-04T01:35Z on the live box.
  const MEASURED: CollateralEntry[] = [
    { pid: 35422, cmdline: 'npm exec tsx bin/hono-host.ts' },
    { pid: 35685, cmdline: 'node /w/papercusp/node_modules/.bin/tsx bin/hono-host.ts' },
    { pid: 37652, cmdline: '/w/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.27.3' },
    { pid: 45576, cmdline: 'npm exec tsx /w/papercusp/apps/operator/bin/spawner-sidecar.ts' },
    { pid: 45951, cmdline: 'node /w/papercusp/node_modules/.bin/tsx /w/.../spawner-sidecar.ts' },
    { pid: 271234, cmdline: '/mnt/data/.../Papercusp GUI_0.0.13_amd64/data/usr/lib/Papercusp GUI/serve.mjs' },
    { pid: 274143, cmdline: '/mnt/data/.../Papercusp GUI_0.0.13_amd64/data/usr/lib/Papercusp GUI/serve.mjs' },
    { pid: 2808712, cmdline: 'pg_dump papercusp' },
  ];

  describe('parseCgroupProcs', () => {
    it('parses one pid per line', () => expect(parseCgroupProcs('35422\n45576\n271234\n')).toEqual([35422, 45576, 271234]));
    it('an empty cgroup.procs yields no pids', () => expect(parseCgroupProcs('')).toEqual([]));
    it('drops junk/blank lines rather than throwing — this runs on the restart path', () => {
      expect(parseCgroupProcs('35422\n\nnot-a-pid\n0\n-5\n45576\n')).toEqual([35422, 45576]);
    });
    it('null/undefined input is empty, never a throw', () => {
      expect(parseCgroupProcs(null)).toEqual([]);
      expect(parseCgroupProcs(undefined)).toEqual([]);
    });
  });

  describe('classifyCollateral', () => {
    it('separates the unit OWN processes from what a restart destroys', () => {
      const s = classifyCollateral(MEASURED)!;
      expect(s.own).toBe(3); // 2x hono-host + esbuild
      expect(s.spawner).toBe(2);
      expect(s.desktop).toBe(2);
      expect(s.other).toBe(1); // pg_dump
      expect(s.collateral).toBe(5);
      expect(s.total).toBe(8);
    });

    it('an unrecognised process counts as COLLATERAL, never assumed benign', () => {
      // Assuming-benign is the direction that would re-create the original silence.
      const s = classifyCollateral([{ pid: 1, cmdline: '/usr/bin/something-nobody-anticipated --flag' }])!;
      expect(s.other).toBe(1);
      expect(s.collateral).toBe(1);
      expect(s.own).toBe(0);
    });

    it('a cgroup holding ONLY the unit itself has no collateral (a benign restart)', () => {
      const s = classifyCollateral([
        { pid: 1, cmdline: 'npm exec tsx bin/hono-host.ts' },
        { pid: 2, cmdline: 'esbuild --service=0.27.3' },
      ])!;
      expect(s.collateral).toBe(0);
      expect(s.own).toBe(2);
    });

    it('recognises the bundled dist-host entry as the unit itself, not collateral', () => {
      const s = classifyCollateral([
        { pid: 1, cmdline: 'node dist-host/hono-host.mjs' },
      ])!;
      expect(s.own).toBe(1);
      expect(s.collateral).toBe(0);
      expect(s.other).toBe(0);
    });

    it('empty/null input is UNKNOWN(null) — never a zeroed summary that reads as "nothing died"', () => {
      expect(classifyCollateral([])).toBeNull();
      expect(classifyCollateral(null)).toBeNull();
      expect(classifyCollateral(undefined)).toBeNull();
    });

    it('bounds the other-process sample so the alert cannot grow unbounded', () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ pid: 1000 + i, cmdline: `/usr/bin/job-${i}` }));
      const s = classifyCollateral(many)!;
      expect(s.other).toBe(20);
      expect(s.otherSample).toHaveLength(3);
    });
  });

  describe('collateralAlertMessage', () => {
    it('names the agent spawner and the desktop sidecars explicitly', () => {
      const msg = collateralAlertMessage('papercusp-bg-host', classifyCollateral(MEASURED), 'ticker frozen')!;
      expect(msg).toContain('AGENT SPAWNER');
      expect(msg).toContain('2 LIVE desktop-app sidecars');
      expect(msg).toContain('KILLED 5 process(es)');
      expect(msg).toContain('ticker frozen');
      // Must not read as a misfire — the restart itself was correct; the collateral is the news.
      expect(msg).toContain('NOT a restart-storm alert');
    });

    it('says NOTHING when the restart destroys only the unit itself', () => {
      const benign = classifyCollateral([{ pid: 1, cmdline: 'npm exec tsx bin/hono-host.ts' }]);
      expect(collateralAlertMessage('papercusp-bg-host', benign, 'frozen')).toBeNull();
    });

    it('says NOTHING on an UNKNOWN snapshot — never infer destruction from a missing signal', () => {
      expect(collateralAlertMessage('papercusp-bg-host', null, 'frozen')).toBeNull();
    });
  });

  describe('THE REGRESSION GUARD: collateral must not share the storm threshold', () => {
    it('a FIRST restart reports collateral even though shouldAlert() is still false', () => {
      // This is the exact defect. consecutiveRestarts === 1 after the first restart, and
      // ALERT_AFTER_RESTARTS is 2, so the storm alert stays silent — as designed.
      expect(shouldAlert(1)).toBe(false);
      // ...but the collateral notice must fire regardless, or a lone restart kills the owner's
      // desktop with no signal anywhere. Before this fix, nothing was emitted here at all.
      expect(collateralAlertMessage('papercusp-bg-host', classifyCollateral(MEASURED), 'frozen')).not.toBeNull();
    });

    it('CONTROL: a threshold-gated collateral signal would be silent here — proving the guard bites', () => {
      // Deliberately-wrong implementation kept as a control: if collateral reporting were ever
      // re-coupled to the storm counter, this is what the first restart would produce.
      const wrong = (strikes: number) => (shouldAlert(strikes) ? collateralAlertMessage('u', classifyCollateral(MEASURED), 'r') : null);
      expect(wrong(1)).toBeNull(); // the bug: silent on the case that actually happens
      expect(wrong(2)).not.toBeNull();
      // The shipped implementation is independent of the strike count entirely.
      expect(collateralAlertMessage('u', classifyCollateral(MEASURED), 'r')).not.toBeNull();
    });
  });

  /**
   * The tests above exercise the pure functions. They would ALL still pass if someone deleted the call
   * from `restart()` — so on their own they do not protect the behaviour, only the helpers. `restart()`
   * cannot be imported (it is module-private and really shells out to `systemctl restart`), so this
   * asserts the wiring at the source level, the same chokepoint approach as
   * papercusp-desktop/test/tauri-dev-slot-chokepoint.test.js.
   */
  describe('WIRING: the restart path must actually emit collateral, ungated', () => {
    let src: string;
    let restartBody: string;
    beforeAll(async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      // PROBE_SCRIPT lets scripts/mutation-probe.sh point this at a MUTATED COPY outside the tree, so
      // falsifiability can be proven without ever mutating the shared working tree (git-sync would
      // commit the mutant mid-probe).
      const subject = process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      src = readFileSync(subject, 'utf8');
      // The restart() function body: from its declaration to the next top-level `async function`.
      const start = src.indexOf('function restart(');
      expect(start).toBeGreaterThan(-1);
      restartBody = src.slice(start, src.indexOf('\nasync function poll(', start));
      expect(restartBody.length).toBeGreaterThan(0);
    });

    it('restart() emits a collateral message', () => {
      expect(restartBody).toContain('collateralAlertMessage(');
    });

    it('the collateral emit is NOT nested inside the shouldAlert() storm branch', () => {
      // The whole defect was one signal gating the other. If a future edit moves the collateral emit
      // inside `if (shouldAlert(...)) { ... }`, the ordinary one-restart case goes silent again.
      const stormIdx = restartBody.indexOf('if (shouldAlert(');
      const collateralIdx = restartBody.indexOf('collateralAlertMessage(');
      expect(stormIdx).toBeGreaterThan(-1);
      expect(collateralIdx).toBeGreaterThan(stormIdx); // after the storm block, not within it
      const between = restartBody.slice(stormIdx, collateralIdx);
      // The storm branch must be closed before the collateral emit begins.
      expect(between).toMatch(/\n {2}}\n/);
    });

    it('the freeze path snapshots collateral BEFORE issuing the restart', () => {
      // Reading the cgroup after `systemctl restart` returns nothing — the snapshot must precede it.
      const pollBody = src.slice(src.indexOf('async function poll('));
      const readIdx = pollBody.indexOf('await readCollateral(');
      const restartCallIdx = pollBody.indexOf('restart(\n');
      expect(readIdx).toBeGreaterThan(-1);
      expect(restartCallIdx).toBeGreaterThan(readIdx);
    });
  });

  /**
   * WI-37506: the poolShedExplainsFreeze tests above exercise the pure predicate only — they would ALL
   * still pass if the call were deleted from `poll()`. `poll()` cannot be imported directly (it shells
   * out to `systemctl`/`psql`), so this pins the wiring at the source level, the same chokepoint
   * approach the collateral WIRING block above uses.
   */
  describe('WIRING: pool-shed corroboration runs before the destructive restart (WI-37506)', () => {
    let pollBody: string;
    beforeAll(async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const subject = process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      const src = readFileSync(subject, 'utf8');
      const start = src.indexOf('async function poll(');
      expect(start).toBeGreaterThan(-1);
      pollBody = src.slice(start);
    });

    it('checks poolShedExplainsFreeze AFTER the saturation gate but BEFORE the collateral snapshot + restart', () => {
      const satIdx = pollBody.indexOf('if (!shouldRestart(');
      const shedIdx = pollBody.indexOf('poolShedExplainsFreeze(');
      const collateralIdx = pollBody.indexOf('await readCollateral(');
      expect(satIdx).toBeGreaterThan(-1);
      expect(shedIdx).toBeGreaterThan(satIdx); // only consulted once a genuine-freeze verdict is reached
      expect(collateralIdx).toBeGreaterThan(shedIdx); // and settled before the destructive path proceeds
    });

    it('the pool-shed check is NOT nested inside the saturation branch — it must run on every genuine-freeze verdict', () => {
      const satIdx = pollBody.indexOf('if (!shouldRestart(');
      const shedIdx = pollBody.indexOf('poolShedExplainsFreeze(');
      const between = pollBody.slice(satIdx, shedIdx);
      // The saturation branch's own `return;` and closing `}` must appear before the shed check begins —
      // otherwise a future edit could silently swallow the shed check inside that unrelated branch.
      expect(between).toMatch(/\breturn;\n\s*}\n/);
    });
  });

  describe('readCollateral — fail-soft on every fault (never breaks the restart path)', () => {
    const okShow = async () => ({ err: null, stdout: '/user.slice/app.slice/papercusp-bg-host.service\n' });

    it('returns UNKNOWN(null) when systemctl cannot report the cgroup', async () => {
      expect(await readCollateral({ sh: async () => ({ err: new Error('boom'), stdout: '' }) })).toBeNull();
    });

    it('returns UNKNOWN(null) when the ControlGroup value is empty/nonsense', async () => {
      expect(await readCollateral({ sh: async () => ({ err: null, stdout: '\n' }) })).toBeNull();
    });

    it('returns UNKNOWN(null) when cgroup.procs is unreadable — never throws', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: () => {
          throw new Error('EACCES');
        },
      });
      expect(res).toBeNull();
    });

    it('skips a pid that exits mid-scan instead of failing the whole snapshot', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: (p: string) => {
          if (p.endsWith('cgroup.procs')) return '100\n200\n';
          if (p === '/proc/100/cmdline') return 'npm exec tsx /w/apps/operator/bin/spawner-sidecar.ts';
          throw new Error('ESRCH'); // 200 vanished between the two reads
        },
      });
      expect(res!.spawner).toBe(1);
      expect(res!.total).toBe(1);
    });

    it('converts NUL-separated /proc cmdline into readable text', async () => {
      const res = await readCollateral({
        sh: okShow,
        readFile: (p: string) => (p.endsWith('cgroup.procs') ? '100\n' : 'node\0/usr/lib/Papercusp GUI/serve.mjs\0'),
      });
      expect(res!.desktop).toBe(1);
    });
  });

  /**
   * EI-20029519971967372: the fixed 480s boot grace is SHORTER than a cold boot on the current
   * 1.23M-block own log, so the watchdog killed a healthy, progressing boot every ~8 min forever —
   * bg-host was unrecoverable-by-restart. Both PG signals the watchdog reads go silent for a saturated
   * boot exactly as they do for a dead process, so the fix gives it a signal that separates them:
   * out-of-process forward progress, two-sample, bounded by an absolute cap.
   */
  describe('saturationExtendsGrace — progress-aware suppression (EI-20029519971967372 + EI-20051589102188691)', () => {
    const GRACE = 8 * 60_000; // 480s plain grace
    const MAX_SUPPRESS = 900; // seconds of CONTINUOUS suppression
    const MIN = 50; // ticks/sample
    const FRESH = 0; // a suppression streak that has just begun

    it('extends the grace for the MEASURED failure: past 480s, tree burning ~99% of a core', () => {
      // The live numbers from the filing: unit active 500s (past grace), +493 ticks in the 5s sample.
      expect(saturationExtendsGrace(500, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);
    });

    it('does NOT extend when the tree is idle — a process that has stopped working is a freeze', () => {
      expect(saturationExtendsGrace(500, 0, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, MIN - 1, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    it('treats exactly minTicks as progress (boundary is inclusive)', () => {
      expect(saturationExtendsGrace(500, MIN, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);
    });

    /**
     * THE BOUND — unchanged in PURPOSE, corrected in VARIABLE. It is taken from the sibling failure
     * EI-20025430746362695, where the pool-shed suppression had no upper limit and excused staleness
     * climbing 1372 -> 3173s across four passes, turning a guardrail into a ~53min fleet-wide outage. A
     * suppression that never expires is not a safer suppression — past the bound we restart even while
     * the process is demonstrably working.
     *
     * ⚠ This assertion previously read `STOPS extending at the absolute cap` and passed `activeForSec`
     * (the unit's UPTIME) as the capped quantity — encoding the premise that uptime measured how long
     * boot had been running. It does not, so that form asserted the EI-20051589102188691 defect as
     * correct: it required a working host to be killed purely for being older than 45 minutes. The
     * capped quantity is now continuous suppression time, so the cap still cannot be removed without
     * failing here, and it no longer expires with age.
     */
    it('STOPS extending at the suppression bound, however hard the process is working', () => {
      expect(saturationExtendsGrace(500, 100_000, MAX_SUPPRESS, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, 100_000, MAX_SUPPRESS + 600, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      // ...and the bound binds at ANY age, so a young host gets no free pass either.
      expect(saturationExtendsGrace(10_000, 100_000, MAX_SUPPRESS, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    /**
     * THE REGRESSION GUARD for EI-20051589102188691, stated in the measured numbers of the kill it
     * describes: 2026-08-10T07:34:52Z, unit active 3506s (58min — well past the old 45min cap), tree
     * burning 446 ticks/5s, own log having recorded `boot complete in 40443ms` 57 minutes earlier. The
     * old form returned false here — killing a demonstrably working host — because it read uptime as
     * boot duration. Age must not by itself withdraw the suppression.
     */
    it('THE REGRESSION: suppresses at 3506s uptime (the measured kill), because age is not evidence', () => {
      expect(saturationExtendsGrace(3506, 446, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);
      // A host up for a week is no different: what matters is whether it is working, not how old it is.
      expect(saturationExtendsGrace(7 * 86_400, 446, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);
    });

    /**
     * CONTROL — the OLD rule, transcribed verbatim and kept here permanently, so the regression
     * assertion above is provably FALSIFIABLE without ever mutating the shared tree (CLAUDE.md's
     * tier-1 falsifiability: a deliberately-wrong implementation as a control, never a copy-mutate-
     * restore of production code, which on this tree races git-sync's sweep and has committed a mutant
     * before). A guard that has never been seen to fail is not a guard.
     *
     * It also pins the defect's SHAPE for whoever reads this next: the only difference is which
     * quantity the cap is applied to.
     */
    it('CONTROL: the old uptime-capped rule FAILS the regression case (so the guard discriminates)', () => {
      const oldUptimeCappedRule = (
        activeForSec: number | null,
        ticks: number | null,
        graceMs = GRACE,
        capMs = 45 * 60_000,
        minTicks = MIN,
      ) => {
        if (activeForSec == null || !Number.isFinite(activeForSec) || activeForSec < 0) return false;
        const activeMs = activeForSec * 1000;
        if (activeMs < graceMs) return false;
        if (activeMs >= capMs) return false; // ← THE DEFECT: uptime read as boot duration
        if (ticks == null || !Number.isFinite(ticks) || ticks < 0) return false;
        return ticks >= minTicks;
      };

      // The measured kill: the old rule declines to suppress, so the working host dies. The new rule
      // suppresses. If these two ever agree, the regression guard above has stopped discriminating.
      expect(oldUptimeCappedRule(3506, 446)).toBe(false);
      expect(saturationExtendsGrace(3506, 446, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);

      // CALIBRATION: on the case the two rules SHOULD agree about (the original EI-20029519971967372
      // failure, inside the old window) they do agree — proving the control is a faithful transcription
      // and not simply a function that returns false, which would make the assertion above vacuous.
      expect(oldUptimeCappedRule(500, 493)).toBe(true);
      expect(saturationExtendsGrace(500, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(true);
    });

    /**
     * The replacement bound must be STRICTLY TIGHTER than what it replaced, or this fix would be the
     * unbounded-suppression bug (EI-20025430746362695) with the sign flipped. The old uptime window
     * permitted continuous suppression from 480s to 2700s of uptime = 2220s unbroken; the new bound
     * permits 900s. Asserted as an inequality so it cannot silently loosen later.
     */
    it('is strictly tighter than the uptime window it replaced (no sign-flipped regression)', () => {
      const OLD_MAX_UNBROKEN_SUPPRESSION_S = (45 * 60_000 - GRACE) / 1000; // 2220s
      expect(MAX_SUPPRESS).toBeLessThan(OLD_MAX_UNBROKEN_SUPPRESSION_S);
      // At the old ceiling the new bound has long since fired.
      expect(saturationExtendsGrace(500, 100_000, OLD_MAX_UNBROKEN_SUPPRESSION_S, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    it('defers to the plain boot grace below its window (not this check’s job)', () => {
      expect(saturationExtendsGrace(120, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(GRACE / 1000 - 1, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    /**
     * The never-infer-from-a-missing-signal asymmetry this whole file is built on (isFrozen,
     * withinBootGrace, poolShedExplainsFreeze all share it): UNKNOWN must never manufacture
     * suppression. A negative delta is UNKNOWN too — it means the tree changed identity under us
     * (restart / pid reuse), not that it went idle.
     */
    it('grants nothing on an UNKNOWN progress reading', () => {
      expect(saturationExtendsGrace(500, null, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, undefined, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, Number.NaN, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, -400, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    it('grants nothing on an UNKNOWN active-for reading', () => {
      expect(saturationExtendsGrace(null, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(undefined, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(-5, 493, FRESH, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });

    /** The same asymmetry applied to the NEW argument: an unreadable suppression clock grants nothing. */
    it('grants nothing on an UNKNOWN suppression clock', () => {
      expect(saturationExtendsGrace(500, 493, null, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, 493, Number.NaN, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
      expect(saturationExtendsGrace(500, 493, -1, GRACE, MAX_SUPPRESS, MIN)).toBe(false);
    });
  });

  /**
   * EI-20029519971967372: the progress reading has to come from /proc, because the process it describes
   * is too saturated to report on itself (an in-process beat is silenced by exactly the condition it
   * would report). Two shapes are load-bearing and each has a control below: sum the WHOLE TREE (MainPID
   * is a wrapper at utime=0 — measuring it alone says "idle"), and parse /proc/<pid>/stat after the LAST
   * ')' (comm may contain spaces and parens).
   */
  describe('procTreeCpuTicks — out-of-process progress signal (EI-20029519971967372)', () => {
    /** Build a /proc/<pid>/stat line. Fields 14/15/16/17 are utime/stime/cutime/cstime; everything
     *  before them is padding. */
    const stat = (pid: number, comm: string, utime: number, stime: number, cutime = 0, cstime = 0) =>
      `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} ${cutime} ${cstime} 20 0 12 0 999\n`;

    type ProcRow = {
      comm: string;
      utime: number;
      stime: number;
      /** ticks the kernel migrated here from REAPED descendants (field 16) */
      cutime?: number;
      /** ticks the kernel migrated here from REAPED descendants (field 17) */
      cstime?: number;
      children?: number[];
    };

    /** A fake /proc: pid -> { comm, utime, stime, cutime?, cstime?, children }. */
    const fakeProc = (table: Record<number, ProcRow>) => ({
      readFile: (p: string) => {
        let m = /^\/proc\/(\d+)\/stat$/.exec(p);
        if (m) {
          const e = table[Number(m[1])];
          if (!e) throw new Error('ENOENT');
          return stat(Number(m[1]), e.comm, e.utime, e.stime, e.cutime ?? 0, e.cstime ?? 0);
        }
        m = /^\/proc\/(\d+)\/task\/\d+\/children$/.exec(p);
        if (m) {
          const e = table[Number(m[1])];
          if (!e) throw new Error('ENOENT');
          return (e.children ?? []).join(' ');
        }
        throw new Error('ENOENT');
      },
      readDir: (p: string) => {
        const m = /^\/proc\/(\d+)\/task$/.exec(p);
        if (!m || !table[Number(m[1])]) throw new Error('ENOENT');
        return [m[1]]; // one thread per process is enough to reach `children`
      },
    });

    /**
     * THE WRAPPER TRAP, as measured: MainPID sat at utime=0/RSS 82MB while the real listener child burned
     * a full core. A probe that reads MainPID alone reports "idle" — the exact false exoneration this
     * signal exists to avoid. Summing the tree makes picking the right child unnecessary.
     */
    it('sums the whole tree, so a zero-CPU MainPID wrapper does not read as idle', () => {
      const proc = fakeProc({
        100: { comm: 'node', utime: 0, stime: 0, children: [200] }, // the wrapper
        200: { comm: 'node', utime: 400, stime: 93 }, // the real worker
      });
      expect(procTreeCpuTicks(100, proc)).toBe(493);
      // ...and the control: the wrapper alone is indistinguishable from an idle process.
      expect(procTreeCpuTicks(200, proc)).toBe(493);
      const wrapperOnly = fakeProc({ 100: { comm: 'node', utime: 0, stime: 0 } });
      expect(procTreeCpuTicks(100, wrapperOnly)).toBe(0);
    });

    it('walks descendants transitively', () => {
      const proc = fakeProc({
        1: { comm: 'a', utime: 1, stime: 1, children: [2] },
        2: { comm: 'b', utime: 10, stime: 0, children: [3] },
        3: { comm: 'c', utime: 100, stime: 8 },
      });
      expect(procTreeCpuTicks(1, proc)).toBe(120);
    });

    /** The classic /proc/stat parsing trap: comm is parenthesised and may contain spaces AND parens. */
    it('parses a comm containing spaces and parentheses', () => {
      const proc = fakeProc({ 7: { comm: 'weird (name) here', utime: 30, stime: 12 } });
      expect(procTreeCpuTicks(7, proc)).toBe(42);
    });

    it('returns UNKNOWN (null) when the root itself is unreadable', () => {
      expect(procTreeCpuTicks(999, fakeProc({}))).toBeNull();
      expect(procTreeCpuTicks(0, fakeProc({}))).toBeNull();
      expect(procTreeCpuTicks(Number.NaN, fakeProc({}))).toBeNull();
    });

    /** A descendant exiting mid-walk is ordinary, not a measurement fault — it must not poison the sum. */
    it('skips a descendant that vanishes mid-walk instead of going UNKNOWN', () => {
      const proc = fakeProc({
        1: { comm: 'a', utime: 5, stime: 5, children: [2, 404] }, // 404 is not in the table
        2: { comm: 'b', utime: 20, stime: 0 },
      });
      expect(procTreeCpuTicks(1, proc)).toBe(30);
    });

    it('terminates on a cyclic/self-referential children graph', () => {
      const proc = fakeProc({
        1: { comm: 'a', utime: 1, stime: 0, children: [2] },
        2: { comm: 'b', utime: 2, stime: 0, children: [1, 2] }, // points back at both
      });
      expect(procTreeCpuTicks(1, proc)).toBe(3); // each pid counted exactly once
    });

    it('honours the maxPids bound on a pathological tree', () => {
      const table: Record<number, { comm: string; utime: number; stime: number; children?: number[] }> = {};
      for (let i = 1; i <= 100; i += 1) table[i] = { comm: 'p', utime: 1, stime: 0, children: [i + 1] };
      table[101] = { comm: 'p', utime: 1, stime: 0 };
      const capped = procTreeCpuTicks(1, { ...fakeProc(table), maxPids: 10 })!;
      expect(capped).toBeLessThanOrEqual(10);
      expect(procTreeCpuTicks(1, fakeProc(table))).toBe(101);
    });

    /**
     * WI-37714 — THE ESTIMATOR MUST BE CONSERVED ACROSS REAPING, or the two-sample delta is not a rate.
     *
     * A fixture of LONG-LIVED children passes with the buggy ut/st-only sum, which is exactly how this
     * survived. So this feeds two snapshots of a tree that REAPS: pid 3 burned 500 ticks and is gone
     * from sample B, its ticks migrated into its parent's cutime by the kernel's wait(), while the rest
     * of the tree also did real work. With ut/st alone the delta goes NEGATIVE on a tree that only ever
     * burned CPU; all four fields conserve it.
     *
     * Measured against a real fork-and-reap tree burning ~2.7 cores: ut+st gave 89, -89, 74, -73, 0, 81
     * ticks/3s while ut+st+cut+cst gave 668, 830, 799, 887, 813, 798.
     */
    it('conserves ticks when a child is reaped between two samples (WI-37714)', () => {
      // A: root -> mid -> burner(3), everyone alive.
      const sampleA = fakeProc({
        1: { comm: 'root', utime: 10, stime: 0, children: [2] },
        2: { comm: 'mid', utime: 5, stime: 0, children: [3] },
        3: { comm: 'burner', utime: 500, stime: 0 },
      });
      // B: the burner has been reaped by `mid`, whose cutime absorbed its 500 ticks. Everyone still
      // alive also advanced (root +2, mid +3), and a fresh burner(4) has 40 ticks so far.
      const sampleB = fakeProc({
        1: { comm: 'root', utime: 12, stime: 0, children: [2] },
        2: { comm: 'mid', utime: 8, stime: 0, cutime: 500, children: [4] },
        4: { comm: 'burner2', utime: 40, stime: 0 },
      });

      const before = procTreeCpuTicks(1, sampleA)!;
      const after = procTreeCpuTicks(1, sampleB)!;
      expect(before).toBe(515); // 10 + 5 + 500
      expect(after).toBe(560); // 12 + 8 + 500 (reaped) + 40
      expect(after - before).toBe(45); // the work actually done: 2 + 3 + 40

      // The falsifier: the ut/st-only estimator this replaced goes NEGATIVE on the same two snapshots,
      // and `bootProgressTicks` maps a negative delta to UNKNOWN ⇒ no suppression ⇒ the busy host dies.
      const utStOnly = (t: Record<number, { utime: number; stime: number }>) =>
        Object.values(t).reduce((s, e) => s + e.utime + e.stime, 0);
      const buggyDelta = utStOnly({ 1: { utime: 12, stime: 0 }, 2: { utime: 8, stime: 0 }, 4: { utime: 40, stime: 0 } })
        - utStOnly({ 1: { utime: 10, stime: 0 }, 2: { utime: 5, stime: 0 }, 3: { utime: 500, stime: 0 } });
      expect(buggyDelta).toBeLessThan(0);
    });

    /**
     * WI-37714, the tempting wrong fix: reading the ROOT's cutime instead of summing the tree. Measured
     * against a real tree it reported EXACTLY ZERO for the whole run whenever the root is not the direct
     * reaper — a worse false-idle than the bug, because it is a confident small number rather than a
     * negative one. Here `mid` reaps, so the root's own cutime never moves.
     */
    it('credits reaped ticks even when the ROOT is not the reaper', () => {
      const proc = fakeProc({
        1: { comm: 'root', utime: 3, stime: 0, cutime: 0, cstime: 0, children: [2] }, // never wait()s
        2: { comm: 'mid', utime: 4, stime: 1, cutime: 700, cstime: 60, children: [] }, // the reaper
      });
      expect(procTreeCpuTicks(1, proc)).toBe(768); // 3 + 4 + 1 + 700 + 60
      expect(procTreeCpuTicks(1, fakeProc({ 1: { comm: 'root', utime: 3, stime: 0 } }))).toBe(3);
    });

    it('sums cutime and cstime, not just utime and stime', () => {
      const proc = fakeProc({ 9: { comm: 'reaper', utime: 1, stime: 2, cutime: 30, cstime: 400 } });
      expect(procTreeCpuTicks(9, proc)).toBe(433);
    });

    /** A stat line truncated before cutime/cstime is a parse fault, not a zero — UNKNOWN, never "idle". */
    it('returns UNKNOWN (null) when the tick fields cannot be parsed', () => {
      const truncated = { readFile: () => '7 (p) S 1 7 7 0 -1 0 0 0 0 0 40 5\n', readDir: () => ['7'] };
      expect(procTreeCpuTicks(7, truncated)).toBeNull();
    });
  });

  /**
   * EI-20025430746362695: the pool-shed suppression credited "shedding, not dead" for ~53min while
   * bg-host answered no HTTP at all — git-sync and every routine dead fleet-wide.
   *
   * The mechanism is worth stating because the filing did not name it: `poolShedExplainsFreeze` asks
   * `shedIdleSec <= idleSec + graceSec`, and `idleSec` is the freeze's OWN age — so the window expands
   * with the thing it explains, and a single shed event at the onset of a freeze satisfies it forever.
   * "A fresh shed event lands every poll, else the corroboration goes stale" was never required.
   *
   * The guard the filing asks for, and its control, are the first two tests here: a host that does NOT
   * answer must not be suppressed, and a host that DOES answer while shedding must STILL be suppressed
   * — so this cannot be satisfied by simply always restarting.
   */
  describe('pool-shed suppression requires positive liveness AND a bound (EI-20025430746362695)', () => {
    const ALIVE = true;
    const WEDGED = false;

    it('THE CONTROL: a shedding host that ANSWERS /api/health is still suppressed', () => {
      // WI-37506's legitimate case must keep working — this is what stops the fix from degenerating
      // into "always restart", which would re-open the 45-kills-in-17-hours storm it replaced.
      expect(poolShedSuppressionHolds(true, ALIVE, 60)).toBe(true);
    });

    it('THE DEFECT: a shedding host that does NOT answer is NOT suppressed', () => {
      expect(poolShedSuppressionHolds(true, WEDGED, 60)).toBe(false);
    });

    it('UNKNOWN liveness never suppresses (a missing signal grants nothing)', () => {
      // Same asymmetry as isFrozen/withinBootGrace/saturationExtendsGrace: only POSITIVE evidence of
      // life may hold off a restart. An unnecessary restart is cheap; the other direction is an outage.
      expect(poolShedSuppressionHolds(true, null, 60)).toBe(false);
    });

    it('no shed event means no suppression, however alive the host is', () => {
      expect(poolShedSuppressionHolds(false, ALIVE, 0)).toBe(false);
    });

    it('the suppression is BOUNDED — past the cap it declines even on a live host', () => {
      expect(poolShedSuppressionHolds(true, ALIVE, 899, 900)).toBe(true);
      expect(poolShedSuppressionHolds(true, ALIVE, 900, 900)).toBe(false); // at the cap, not past it
      expect(poolShedSuppressionHolds(true, ALIVE, 5_000, 900)).toBe(false);
    });

    it('an UNMEASURABLE suppression duration declines rather than suppressing forever', () => {
      // A bound you cannot measure is not a bound. null/NaN/negative are all "I don't know how long
      // this has been held", which is precisely the state the outage sat in.
      for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        expect(poolShedSuppressionHolds(true, ALIVE, bad as number | null)).toBe(false);
      }
    });

    it('REPLAY: every pass of the real 53min outage now declines', () => {
      // The four logged passes, verbatim from the filing: staleness 1372 → 3173s, each one suppressed
      // at the time. The host answered no HTTP throughout (curl -m 10 => http=000).
      for (const suppressedForSec of [1372, 1972, 2572, 3173]) {
        expect(poolShedSuppressionHolds(true, WEDGED, suppressedForSec)).toBe(false);
      }
      // ...and it would have declined on the BOUND alone even had the liveness probe been unavailable,
      // so the two mechanisms are independently sufficient rather than one dressed up as two.
      for (const suppressedForSec of [1372, 1972, 2572, 3173]) {
        expect(poolShedSuppressionHolds(true, ALIVE, suppressedForSec, 900)).toBe(false);
      }
    });

    describe('probeHostLiveness', () => {
      it('treats ANY response as alive — a 500 still proves the event loop turned', async () => {
        for (const status of [200, 404, 500, 503]) {
          const r = await probeHostLiveness('http://x/health', 100, { fetch: async () => ({ status }) });
          expect(r.alive).toBe(true);
        }
      });

      it('a timeout / refused connection is DEAD, not unknown', async () => {
        const timeout = await probeHostLiveness('http://x/health', 100, {
          fetch: async () => {
            throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
          },
        });
        expect(timeout.alive).toBe(false);
        expect(timeout.why).toContain('no response');
      });

      it('an unusable probe (TypeError) is UNKNOWN — never blame a host we did not reach', async () => {
        const r = await probeHostLiveness('not-a-url', 100, {
          fetch: async () => {
            throw new TypeError('Failed to parse URL');
          },
        });
        expect(r.alive).toBeNull();
        expect(r.why).toContain('unusable');
      });

      it('no fetch implementation is UNKNOWN, and never throws', async () => {
        const r = await probeHostLiveness('http://x/health', 100, { fetch: undefined as unknown as null });
        // globalThis.fetch exists on this runtime, so force the absent-implementation path explicitly.
        expect(r).toHaveProperty('alive');
        const forced = await probeHostLiveness('http://x/health', 100, { fetch: 'not-a-function' });
        expect(forced.alive).toBeNull();
      });
    });
  });

  /**
   * WIRING: the predicate above is only worth anything if poll() actually consults it. Every pure test
   * in the block above would still pass if the call were deleted from poll() — the same gap the
   * collateral and pool-shed WIRING blocks below/above exist to close.
   */
  describe('WIRING: the shed branch probes liveness and bounds itself (EI-20025430746362695)', () => {
    let shedBranch: string;
    beforeAll(async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const subject =
        process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      const src = readFileSync(subject, 'utf8');
      const start = src.indexOf('const shedIdleSec = await poolShedIdleSec(dbUrl);');
      expect(start).toBeGreaterThan(-1);
      // The shed branch runs until the boot-progress probe that follows it.
      const end = src.indexOf('const progressTicks = await bootProgressTicks();', start);
      expect(end).toBeGreaterThan(start);
      shedBranch = src.slice(start, end);
    });

    it('probes host liveness before crediting the shed explanation', () => {
      expect(shedBranch).toContain('await probeHostLiveness(');
      expect(shedBranch).toContain('poolShedSuppressionHolds(');
    });

    it('the liveness probe precedes the suppression verdict', () => {
      expect(shedBranch.indexOf('await probeHostLiveness(')).toBeLessThan(
        shedBranch.indexOf('poolShedSuppressionHolds('),
      );
    });

    it('the DECLINING path escalates, not just logs', () => {
      // The whole defect was a suppression that could only ever say "not restarting". The path that
      // overrides it must be at least as loud as the path that suppressed.
      expect(shedBranch).toContain('alertFleet(');
    });
  });

  /**
   * ENTRYPOINT GUARD — importing this module must never start a live watchdog.
   *
   * The autostart used to be an OPT-OUT (`start()` unless PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART=1),
   * which put the whole burden on the importer knowing an env var exists. On 2026-08-10 an agent
   * importing `procTreeCpuTicks` for a one-off /proc probe started a SECOND real watchdog against
   * papercusp-bg-host — polling the live unit with its own independent debounce and circuit state, able
   * to issue its own `systemctl restart` of a shared service, and writing to the durable log.
   *
   * These are BEHAVIOURAL (spawn a real node process and observe what it does), not source greps: the
   * property is "an import starts no poll loop", which must hold however the guard is spelled. A grep
   * for `isDirectEntrypoint` would pass against a guard that was rewritten into uselessness.
   *
   * Note the second test is the one that matters for the SYSTEMD side: a guard that wrongly answers
   * "imported" under the unit would leave bg-host with no freeze recovery, silently. So both directions
   * are pinned, not just the one that caused the incident.
   */
  describe('ENTRYPOINT GUARD: import must not start a watchdog; direct run must', () => {
    const runNode = async (
      args: string[],
      env: Record<string, string>,
      // A STARTED watchdog never exits (start() schedules an interval), so for that case the timeout is
      // the expected end of the run and doubles as the suite's cost — keep it just long enough for the
      // synchronous startup banner to be written.
      timeout = 20_000,
    ): Promise<{ stdout: string; stderr: string }> => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        return await promisify(execFile)(process.execPath, args, {
          env: { ...process.env, ...env },
          timeout,
        });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    };

    // A sandboxed unit + log so neither branch can touch the real service or the durable log, and a poll
    // interval long enough that no poll fires inside the window we observe.
    const sandbox = (log: string) => ({
      PAPERCUSP_BGHOST_WATCHDOG_UNIT: 'papercusp-nonexistent-dummy-unit',
      PAPERCUSP_BGHOST_WATCHDOG_LOG: log,
      PAPERCUSP_BGHOST_WATCHDOG_POLL_MS: '600000',
      PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART: '',
    });

    it('importing the module starts NO poll loop, and says why', async () => {
      const { writeFileSync, existsSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');

      const subject =
        process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      const log = join(tmpdir(), `wd-guard-import-${process.pid}.log`);
      const importer = join(tmpdir(), `wd-guard-importer-${process.pid}.mjs`);
      rmSync(log, { force: true });
      writeFileSync(importer, `await import(${JSON.stringify(subject)});\n`);
      try {
        const { stderr } = await runNode([importer], sandbox(log));
        // The process must have exited on its own — a started watchdog holds a setInterval forever and
        // would have been killed by the timeout instead.
        expect(stderr).toContain('NOT auto-starting');
        // The decisive assertion: the startup banner is written by start(), so its absence IS the
        // absence of a poll loop.
        const written = existsSync(log) ? readFileSync(log, 'utf8') : '';
        expect(written).not.toContain('up — unit');
      } finally {
        rmSync(importer, { force: true });
        rmSync(log, { force: true });
      }
    }, 30_000);

    it('running the script directly DOES start the watchdog', async () => {
      const { existsSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');

      const subject =
        process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      const log = join(tmpdir(), `wd-guard-direct-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        // start() schedules a long interval, so this never exits on its own: the timeout is the
        // expected end, and the banner in the log is the evidence it started.
        await runNode([subject], sandbox(log), 4_000);
        const written = existsSync(log) ? readFileSync(log, 'utf8') : '';
        expect(written).toContain('up — unit papercusp-nonexistent-dummy-unit');
      } finally {
        rmSync(log, { force: true });
      }
    }, 30_000);

    it('the explicit NO_AUTOSTART kill-switch still suppresses a direct run', async () => {
      const { existsSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');

      const subject =
        process.env.PROBE_SCRIPT || resolve(dirname(fileURLToPath(import.meta.url)), '../bghost-watchdog.mjs');
      const log = join(tmpdir(), `wd-guard-killswitch-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        await runNode([subject], { ...sandbox(log), PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART: '1' });
        const written = existsSync(log) ? readFileSync(log, 'utf8') : '';
        expect(written).not.toContain('up — unit');
      } finally {
        rmSync(log, { force: true });
      }
    }, 30_000);
  });
});

// EI-22091522428797790. WI-2140796 gave `dev:restart` a declaration/refusal/force contract for a
// deliberate seed-cut quiesce; this watchdog was the third named party and did not honour it.
describe('seed-cut quiesce awareness', () => {
  let seedCutQuiesce: (
    readFile?: (p: string, enc: string) => string,
    env?: Record<string, string | undefined>,
  ) => string | null;
  let markerBasename: string;

  beforeAll(async () => {
    // Same PROBE_SCRIPT indirection as the top-level import: a bare '../bghost-watchdog.mjs'
    // literal here is TS7016 at the green gate (no .d.mts, no directive — the
    // check-unenrolled-mjs-imports ratchet reds on it), and it also pinned this block to the
    // real module during a copy-out mutation probe.
    const mod = await import(/* @vite-ignore */ process.env.PROBE_SCRIPT || '../bghost-watchdog.mjs');
    seedCutQuiesce = (mod as { seedCutQuiesce: typeof seedCutQuiesce }).seedCutQuiesce;
    markerBasename = (mod as { QUIESCE_MARKER_BASENAME: string }).QUIESCE_MARKER_BASENAME;
  });

  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  it('reports no quiesce when the marker is absent — the normal state', () => {
    expect(seedCutQuiesce(missing, { XDG_RUNTIME_DIR: '/run/user/1000' })).toBeNull();
  });

  it('reports the declared reason when a cut has written the marker', () => {
    const reason = seedCutQuiesce(() => 'pid=123 reason=p101-seed-cut since=2026-09-03T18:00:00Z', {
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(reason).toContain('p101-seed-cut');
  });

  it('fails soft toward STAYING ALIVE: an unreadable marker never invents a quiesce', () => {
    // The opposite direction would let a filesystem fault silently disable freeze recovery, which is
    // strictly worse than the window this guard closes.
    expect(
      seedCutQuiesce(() => {
        throw new Error('EACCES');
      }, { XDG_RUNTIME_DIR: '/run/user/1000' }),
    ).toBeNull();
  });

  it('pins the marker name against the TypeScript guard so the two copies cannot drift apart', async () => {
    // This script is plain node (no TS loader), so the basename is necessarily duplicated rather
    // than imported. That duplication is only safe while something fails when one side moves.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const guard = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/operator-core/lib/agent-tools/dev/bg-host-quiesce-guard.ts',
    );
    const guardSrc = readFileSync(guard, 'utf8');
    expect(markerBasename).toBe('papercusp-seed-cut.quiesce'); // control: the pin is reading a real value
    expect(guardSrc).toContain(markerBasename);
  });
});
