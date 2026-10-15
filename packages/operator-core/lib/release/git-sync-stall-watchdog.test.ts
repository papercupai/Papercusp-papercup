/**
 * git-sync-stall-watchdog — the PURE stall verdict (evaluateGitSyncStall). The DB wiring +
 * head-movement tracking (checkGitSyncStall / flag-flip / broadcast) is integration-covered.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/git-sync-stall-watchdog.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateGitSyncStall,
  gitSyncStallEscalationBody,
  gitSyncStallDiagnosis,
  isStrandingVerdict,
  isCommitNotAttemptableStatus,
  decideHeadClock,
  shouldAlarmSustained,
  nextStallSweeps,
  evaluateGitSyncEligibilityLoss,
  gitSyncEligibilityLossDiagnosis,
  gitSyncEligibilityLossEscalationBody,
  type GitSyncStallSnapshot,
  type GitSyncEligibilityLossSnapshot,
} from './git-sync-stall-watchdog';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const M = 60_000;

const base: GitSyncStallSnapshot = {
  lastFiredMs: NOW - 2 * M, // fired 2 min ago (healthy cadence)
  headUnchangedMs: 5 * M, // head advanced 5 min ago (committing)
  lastError: null,
  watchdogAlerted: false,
};

describe('evaluateGitSyncStall', () => {
  it('healthy: firing + head advancing + no error ⇒ NOT stalled', () => {
    const v = evaluateGitSyncStall(base, NOW);
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('EI-7531 commit-staleness (PRIMARY): HEAD frozen >30m while firing ⇒ stalled — stranded dirty work detector', () => {
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.commitStale).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.reason).toMatch(/HEAD has not advanced/);
  });

  it('WI-40600: a fresh writer-backed local-sync fire gets one bounded attempt window', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 4 * H,
        lastStatus: 'skipped-locked',
        localSyncStatus: 'synced',
        activeLocalSyncStartedAtMs: NOW - 5 * M,
      },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it('WI-40600: a stale local-sync activity marker does not mask a real frozen-HEAD stall', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 4 * H,
        lastStatus: 'skipped-locked',
        localSyncStatus: 'synced',
        activeLocalSyncStartedAtMs: NOW - 31 * M,
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.commitStale).toBe(true);
  });

  it('WI-40600: fresh local-sync suppresses only frozen-HEAD, never error/reaper signals', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 4 * H,
        lastStatus: 'error',
        lastError: 'git process stopped making progress',
        errorSweeps: 2,
        reapedCount: 3,
        activeLocalSyncStartedAtMs: NOW - 5 * M,
      },
      NOW,
    );
    expect(v.commitStale).toBe(false);
    expect(v.errorStall).toBe(true);
    expect(v.persistentReap).toBe(true);
    expect(v.stalled).toBe(true);
  });

  it('commit-staleness is robust to a NULL last_error (the noisy secondary signal)', () => {
    // The live stall had last_error momentarily null — commitStale must still catch it.
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 4 * H, lastError: null }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.commitStale).toBe(true);
    expect(v.errorStall).toBe(false);
  });

  it('just moved / first observation (headUnchangedMs 0 or null) ⇒ not commit-stale', () => {
    expect(evaluateGitSyncStall({ ...base, headUnchangedMs: 0 }, NOW).commitStale).toBe(false);
    expect(evaluateGitSyncStall({ ...base, headUnchangedMs: null }, NOW).commitStale).toBe(false);
  });

  it('error/reap (secondary): a fault persisting across >=2 consecutive sweeps ⇒ stalled', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        lastError: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire',
        errorSweeps: 2,
      },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.errorStall).toBe(true);
    expect(v.reason).toMatch(/FAULT|reaper/i);
    expect(v.reason).toMatch(/2 consecutive watchdog sweeps/);
  });

  it('fire-staleness: active routine that has not fired in >3h ⇒ stalled', () => {
    const v = evaluateGitSyncStall({ ...base, lastFiredMs: NOW - 4 * H }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toMatch(/not FIRED/);
  });

  it('never-fired (fresh seed) ⇒ never alarms on fire-staleness', () => {
    const v = evaluateGitSyncStall({ ...base, lastFiredMs: null, headUnchangedMs: null, lastError: null }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
  });

  it('blank/whitespace last_error is treated as no error', () => {
    expect(evaluateGitSyncStall({ ...base, lastError: '   ', errorSweeps: 5 }, NOW).errorStall).toBe(false);
    expect(evaluateGitSyncStall({ ...base, lastError: '', errorSweeps: 5 }, NOW).errorStall).toBe(false);
  });

  describe('fault-persistence gate (false-alarm fix, 2026-07-02)', () => {
    const fault = { ...base, lastError: 'libs/generic/sse: push failed: git push origin HEAD:main timed out after 240000ms' };

    it('a fault observed on a SINGLE sweep is transient ⇒ NOT stalled (the 06:54 papercusp false alarm)', () => {
      // The live incident: one 240s submodule push timeout, self-recovered in 6 min —
      // yet it urgently paged the owner + broadcast "code is stranding" fleet-wide.
      const v = evaluateGitSyncStall({ ...fault, errorSweeps: 1 }, NOW);
      expect(v.errorStall).toBe(false);
      expect(v.stalled).toBe(false);
    });

    it('errorSweeps absent with a present fault reads as a first observation ⇒ NOT stalled', () => {
      const v = evaluateGitSyncStall(fault, NOW);
      expect(v.errorStall).toBe(false);
      expect(v.stalled).toBe(false);
    });

    it('the threshold is overridable (errorStallMinSweeps)', () => {
      expect(evaluateGitSyncStall({ ...fault, errorSweeps: 1 }, NOW, { errorStallMinSweeps: 1 }).errorStall).toBe(true);
      expect(evaluateGitSyncStall({ ...fault, errorSweeps: 2 }, NOW, { errorStallMinSweeps: 3 }).errorStall).toBe(false);
    });

    it('a persistent fault does NOT mask the primary signals: frozen HEAD still alarms at sweep 1 (2026-07-02 hiveloop)', () => {
      const v = evaluateGitSyncStall(
        { ...fault, errorSweeps: 1, headUnchangedMs: 3 * H, lastStatus: 'error' },
        NOW,
      );
      expect(v.errorStall).toBe(false);
      expect(v.commitStale).toBe(true);
      expect(v.stalled).toBe(true);
    });
  });

  it('thresholds are overridable (headStaleMs / fireStaleMs)', () => {
    const s = { ...base, headUnchangedMs: 20 * M, lastFiredMs: NOW - 30 * M };
    expect(evaluateGitSyncStall(s, NOW).commitStale).toBe(false); // 20m < default 30m
    expect(evaluateGitSyncStall(s, NOW, { headStaleMs: 10 * M }).commitStale).toBe(true);
    expect(evaluateGitSyncStall(s, NOW, { fireStaleMs: 10 * M }).fireStale).toBe(true);
  });

  it('WI-1416 persistent reap: >=3 consecutive executor-reaper cancels ⇒ stalled (the synthetic reap-loop alarm)', () => {
    // Synthetic persistent-reap: fires keep starting (lastFired fresh, so NOT fire-stale;
    // last_error null — the reaper marker can flip null between reaps) but the reaper has
    // cancelled 3 consecutive fires. reaped_count is the durable signal that survives the
    // noisy last_error, so the watchdog must alarm on it alone.
    const v = evaluateGitSyncStall({ ...base, reapedCount: 3 }, NOW);
    expect(v.stalled).toBe(true);
    expect(v.persistentReap).toBe(true);
    expect(v.commitStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.reason).toMatch(/reaper has cancelled 3 consecutive/i);
  });

  it('WI-1416 persistent reap: below the threshold (or absent) ⇒ not stalled; threshold overridable', () => {
    expect(evaluateGitSyncStall({ ...base, reapedCount: 2 }, NOW).persistentReap).toBe(false);
    expect(evaluateGitSyncStall(base, NOW).persistentReap).toBe(false); // reapedCount absent → 0
    expect(evaluateGitSyncStall({ ...base, reapedCount: 2 }, NOW, { persistentReapMin: 2 }).persistentReap).toBe(true);
  });

  it('WI-1416 persistent reap: a completed fire resets the counter (recordOutcome writes 0) ⇒ recovery clears the verdict', () => {
    const v = evaluateGitSyncStall({ ...base, reapedCount: 0 }, NOW);
    expect(v.persistentReap).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('WI-1416: the escalation body carries the persistentReap flag', () => {
    const v = evaluateGitSyncStall({ ...base, reapedCount: 4 }, NOW);
    const body = JSON.parse(
      gitSyncStallEscalationBody({ installSlug: 'papercusp', verdict: v, lastFiredMs: base.lastFiredMs, headUnchangedMs: null, lastStatus: 'nothing', nowMs: NOW }),
    );
    expect(body.persistentReap).toBe(true);
  });

  it('escalation body captures the commit-stall + is valid JSON', () => {
    const v = evaluateGitSyncStall({ ...base, headUnchangedMs: 6 * H }, NOW);
    const body = JSON.parse(
      gitSyncStallEscalationBody({ installSlug: 'papercusp', verdict: v, lastFiredMs: base.lastFiredMs, headUnchangedMs: 6 * H, lastStatus: 'nothing', nowMs: NOW }),
    );
    expect(body.kind).toBe('git-sync-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.commitStale).toBe(true);
    expect(body.headUnchangedHrs).toBe(6);
    expect(String(body.detail)).toMatch(/deploy ships only committed HEAD|strand/i);
  });
});

describe('clean-idle exemption (false-alarm fix, 2026-07-02)', () => {
  it("lastStatus 'nothing' (clean tree) never head-stalls — idle hives stop crying wolf", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 48 * 3_600_000, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it("a 'synced'-status hive with a frozen HEAD still stalls (real commit failures alarm)", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 48 * 3_600_000, lastError: null, lastStatus: 'synced', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(true);
  });

  it('EI-20315742298217655: a bridge-only error does not turn a clean local tick into a commit strand', () => {
    // runGithubBridgeLeg runs after recordOutcome and can promote an owner-actionable
    // egress failure to top-level error. The local stage is still clean-idle, so a frozen
    // local head is expected and must not page as uncommitted work.
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 48 * H,
        lastStatus: 'error',
        localSyncStatus: 'nothing',
        lastError: 'github bridge rejected the staging push: workflow scope missing',
        errorSweeps: 1,
      },
      NOW,
    );
    expect(v.commitStale).toBe(false);
    expect(v.errorStall).toBe(false); // one bridge observation is not a persistent fault
    expect(v.stalled).toBe(false);
  });

  it('EI-20315742298217655: a bridge-only error still preserves a real local commit stall', () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 48 * H,
        lastStatus: 'error',
        localSyncStatus: 'synced',
        lastError: 'github bridge rejected the staging push: workflow scope missing',
        errorSweeps: 1,
      },
      NOW,
    );
    expect(v.commitStale).toBe(true);
    expect(v.errorStall).toBe(false);
    expect(v.stalled).toBe(true);
  });

  it("lastStatus 'skipped' (eligibility-gated fire) never head-stalls — a vanished checkout is not stranding code (2026-07-03 lane-rig incident)", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 61 * 3_600_000, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it("EI-21197856845340037: 'skipped-locked' is a deferred attempt, not evidence that commits cannot land", () => {
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: 4 * H,
        lastStatus: 'skipped-locked',
        localSyncStatus: 'skipped-locked',
      },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it("fire-stale / reap stalls still alarm on a 'skipped' routine (status-independent signals)", () => {
    const fireStale = evaluateGitSyncStall(
      { lastFiredMs: NOW - 48 * 3_600_000, headUnchangedMs: 0, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(fireStale.stalled).toBe(true);
    const reaped = evaluateGitSyncStall(
      { lastFiredMs: NOW - 60_000, headUnchangedMs: 0, lastError: null, lastStatus: 'skipped', watchdogAlerted: false, reapedCount: 3 },
      NOW,
    );
    expect(reaped.stalled).toBe(true);
  });

  it('fire-stale and error stalls are status-independent (a dead engine reports nothing)', () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 48 * 3_600_000, headUnchangedMs: 0, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(true);
  });

  it('EI-2994: a stale root routine engine suppresses git-sync symptom alarms', () => {
    const v = evaluateGitSyncStall(
      {
        lastFiredMs: NOW - 48 * 3_600_000,
        headUnchangedMs: 48 * 3_600_000,
        lastError: 'push failed',
        errorSweeps: 5,
        lastStatus: 'error',
        watchdogAlerted: false,
        reapedCount: 5,
        routineEngineStale: true,
      },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.errorStall).toBe(false);
    expect(v.persistentReap).toBe(false);
    expect(v.reason).toBeNull();
  });
});

describe('commit-only / bridged hive members (p2p-git-live-activation P-306) — no watchdog change needed, verified', () => {
  // A bridged/p2p-only hive's members go COMMIT-ONLY: git-sync-action.ts sets cfg.push=false at
  // the eligibility gate (never routes through the 'skipped' no-op path — that's reserved for a
  // fire the P-008 eligibility gate itself no-ops, e.g. no_path/hive_home/remote_hive_view).
  // run-git-sync.ts's reconcileAndPushOneRepo still returns status:'synced' whenever
  // committedLocal||mergedNew, regardless of `pushed` (push simply stays false) — so a
  // commit-only member's `last_status` is 'synced'/'nothing' exactly like a legacy member's,
  // never 'skipped'. These pin that contract at the pure-verdict layer: commitStale must key
  // off HEAD movement, and stay silent on a genuinely idle commit-only member, exactly as
  // documented in agent-insights/hive-git-p2p-ops-runbook-2026-07-09.mdx "Watchdog interplay
  // under commit-only mode".
  it("a commit-only member with local commits landing (status:'synced', HEAD moving, push disabled) never false-alarms", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 2 * M, headUnchangedMs: 2 * M, lastError: null, lastStatus: 'synced', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it("a genuinely idle commit-only member (status:'nothing', HEAD frozen for days) never false-alarms — push being disabled is irrelevant to the clean-idle exemption", () => {
    const v = evaluateGitSyncStall(
      { lastFiredMs: NOW - 2 * M, headUnchangedMs: 96 * H, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(v.stalled).toBe(false);
    expect(v.commitStale).toBe(false);
  });

  it("a commit-only member whose HEAD genuinely freezes with real pending work (status:'synced' from a stale snapshot, or an 'error') STILL alarms — commit-only never masks a real stall", () => {
    const stillSynced = evaluateGitSyncStall(
      { lastFiredMs: NOW - 2 * M, headUnchangedMs: 31 * M, lastError: null, lastStatus: 'synced', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(stillSynced.stalled).toBe(true);
    expect(stillSynced.commitStale).toBe(true);

    const erroring = evaluateGitSyncStall(
      { lastFiredMs: NOW - 2 * M, headUnchangedMs: 5 * M, lastError: 'merge failed', errorSweeps: 2, lastStatus: 'error', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(erroring.stalled).toBe(true);
    expect(erroring.errorStall).toBe(true);
  });

  it('fire-stale / persistent-reap still alarm on a commit-only member exactly as on a legacy pushing member (status-independent signals, unaffected by cfg.push)', () => {
    const fireStale = evaluateGitSyncStall(
      { lastFiredMs: NOW - 4 * H, headUnchangedMs: 0, lastError: null, lastStatus: 'synced', watchdogAlerted: false, reapedCount: 0 },
      NOW,
    );
    expect(fireStale.stalled).toBe(true);
    expect(fireStale.fireStale).toBe(true);

    const reaped = evaluateGitSyncStall(
      { lastFiredMs: NOW - 2 * M, headUnchangedMs: 0, lastError: null, lastStatus: 'nothing', watchdogAlerted: false, reapedCount: 3 },
      NOW,
    );
    expect(reaped.stalled).toBe(true);
    expect(reaped.persistentReap).toBe(true);
  });
});

describe('EI-9030b sustain debounce (edge-trigger before broadcast)', () => {
  describe('nextStallSweeps — the consecutive-stalled-sweep streak counter', () => {
    it('increments while stalled', () => {
      expect(nextStallSweeps(true, 0)).toBe(1);
      expect(nextStallSweeps(true, 1)).toBe(2);
      expect(nextStallSweeps(true, 5)).toBe(6);
    });
    it('resets to 0 the moment a sweep is healthy', () => {
      expect(nextStallSweeps(false, 3)).toBe(0);
      expect(nextStallSweeps(false, 0)).toBe(0);
    });
  });

  describe('shouldAlarmSustained — hold back a not-yet-confirmed stall', () => {
    it('a FIRST-observed stall (streak 1) does NOT broadcast — the transient-flap suppressor', () => {
      // The exact 2026-07-10 shape: a hive stalls, then self-heals before the next sweep.
      expect(shouldAlarmSustained(true, 1)).toBe(false);
    });
    it('a stall confirmed on the SECOND consecutive sweep broadcasts', () => {
      expect(shouldAlarmSustained(true, 2)).toBe(true);
      expect(shouldAlarmSustained(true, 9)).toBe(true);
    });
    it('a healthy verdict never broadcasts regardless of a stale streak count', () => {
      expect(shouldAlarmSustained(false, 5)).toBe(false);
    });
    it('the sustain threshold is overridable (minSweeps)', () => {
      expect(shouldAlarmSustained(true, 1, 1)).toBe(true); // aggressive: alarm on first sweep
      expect(shouldAlarmSustained(true, 2, 3)).toBe(false); // patient: need 3 consecutive
      expect(shouldAlarmSustained(true, 3, 3)).toBe(true);
    });
    it('the full transient-then-heal trajectory never crosses the alarm bar with the default threshold', () => {
      // sweep 1: stalled (streak→1, below bar); sweep 2: healed (streak→0). Never alarmed.
      let streak = 0;
      streak = nextStallSweeps(true, streak);
      expect(shouldAlarmSustained(true, streak)).toBe(false);
      streak = nextStallSweeps(false, streak);
      expect(streak).toBe(0);
    });
    it('a genuinely-sustained stall DOES cross the bar by sweep 2', () => {
      let streak = 0;
      streak = nextStallSweeps(true, streak); // sweep 1 → 1
      expect(shouldAlarmSustained(true, streak)).toBe(false);
      streak = nextStallSweeps(true, streak); // sweep 2 → 2
      expect(shouldAlarmSustained(true, streak)).toBe(true);
    });
  });
});

describe('stranding vs failing-leg diagnosis (2026-08-02 papercusp misdiagnosis)', () => {
  // A pure error STREAK with HEAD advancing: one leg fails every tick while the superproject
  // commits + pushes normally. Live case: 39 sweeps (~10h) of
  // "libs/generic/{cache,chat-protocol}: merge failed … refusing to merge unrelated histories"
  // while origin/staging advanced every ~5 min and the GitHub bridge read divergence: clear.
  const errorStreakOnly = evaluateGitSyncStall(
    {
      ...base,
      lastError:
        'libs/generic/cache: merge failed (no conflicted paths): fatal: refusing to merge unrelated histories',
      errorSweeps: 39,
    },
    NOW,
  );

  it('a pure error streak IS stalled but is NOT a stranding verdict (HEAD still advancing)', () => {
    expect(errorStreakOnly.stalled).toBe(true);
    expect(errorStreakOnly.errorStall).toBe(true);
    expect(errorStreakOnly.commitStale).toBe(false);
    expect(errorStreakOnly.fireStale).toBe(false);
    expect(errorStreakOnly.persistentReap).toBe(false);
    expect(isStrandingVerdict(errorStreakOnly)).toBe(false);
  });

  it('each stranding signal on its own IS a stranding verdict', () => {
    expect(isStrandingVerdict(evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW))).toBe(true);
    expect(isStrandingVerdict(evaluateGitSyncStall({ ...base, lastFiredMs: NOW - 4 * H }, NOW))).toBe(true);
    expect(isStrandingVerdict(evaluateGitSyncStall({ ...base, reapedCount: 3 }, NOW))).toBe(true);
  });

  it('the failing-leg diagnosis never claims code is stranding, and never blames the executor reaper', () => {
    const d = gitSyncStallDiagnosis(errorStreakOnly, 'papercusp');
    // The exact false claims the live page made.
    expect(d.why).not.toMatch(/stranded edits|code is stranding|strand uncommitted/i);
    expect(d.why).not.toMatch(/executor reaping|engine wedge/i);
    expect(d.title).not.toMatch(/code stranding/i);
    // …and it must say the true thing instead.
    expect(d.summary).toMatch(/HEAD is still advancing/i);
    expect(d.why).toMatch(/rescue-commit is the WRONG move/i);
    expect(d.why).toMatch(/metadata\.last_error/);
  });

  it('the stranding diagnosis still carries the strand warning + reaper hint (unchanged for real stalls)', () => {
    const d = gitSyncStallDiagnosis(evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW), 'papercusp');
    expect(d.summary).toMatch(/STALLED/);
    expect(d.title).toMatch(/code stranding/i);
    expect(d.why).toMatch(/executor reaping/i);
    expect(d.why).toMatch(/rescue-commit the tree/i);
  });

  it('the two verdicts produce DIFFERENT summary/title/why — the conflation regression', () => {
    const leg = gitSyncStallDiagnosis(errorStreakOnly, 'papercusp');
    const strand = gitSyncStallDiagnosis(evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW), 'papercusp');
    expect(leg.summary).not.toBe(strand.summary);
    expect(leg.title).not.toBe(strand.title);
    expect(leg.why).not.toBe(strand.why);
  });

  it('the escalation row carries a `stranding` flag and the matching detail for each mode', () => {
    const legBody = JSON.parse(
      gitSyncStallEscalationBody({
        installSlug: 'papercusp',
        verdict: errorStreakOnly,
        lastFiredMs: base.lastFiredMs,
        headUnchangedMs: 5 * M,
        lastStatus: 'synced',
        nowMs: NOW,
      }),
    );
    expect(legBody.stranding).toBe(false);
    expect(legBody.errorStall).toBe(true);
    expect(legBody.detail).toMatch(/persistent fault streak/i);
    expect(legBody.detail).not.toMatch(/executor reaping|CANNOT deploy/i);

    const strandVerdict = evaluateGitSyncStall({ ...base, headUnchangedMs: 31 * M }, NOW);
    const strandBody = JSON.parse(
      gitSyncStallEscalationBody({
        installSlug: 'papercusp',
        verdict: strandVerdict,
        lastFiredMs: base.lastFiredMs,
        headUnchangedMs: 31 * M,
        lastStatus: 'synced',
        nowMs: NOW,
      }),
    );
    expect(strandBody.stranding).toBe(true);
    expect(strandBody.detail).toMatch(/silent stall/i);
    expect(strandBody.detail).toMatch(/executor reaping/i);
  });

  it('surfaces the terminal failure in the headline instead of leading Cargo success chatter', () => {
    const noisyPrePushFailure = [
      'superproject: push failed: Finished `dev` profile [optimized + debuginfo] target(s) in 0.36s',
      '    Finished `test` profile [optimized + debuginfo] target(s) in 0.25s',
      '     Running unittests src/lib.rs (/tmp/target/debug/deps/example)',
      'FAIL: non-macOS host should be a no-op',
      'make: *** [Makefile:124: test-ios-host-health] Error 1',
      "✗ pre-push: 'make check' failed — fix or bypass",
      "error: failed to push some refs to 'github.com:Papercusp/papercup-rust-mobile.git'",
    ].join('\n');
    const verdict = evaluateGitSyncStall(
      { ...base, lastError: noisyPrePushFailure, errorSweeps: 2 },
      NOW,
    );
    const diagnosis = gitSyncStallDiagnosis(verdict, 'papercup-rust-mobile');

    expect(verdict.errorHeadline).toBe('FAIL: non-macOS host should be a no-op');
    expect(diagnosis.summary).toContain('Cause: FAIL: non-macOS host should be a no-op');
    expect(diagnosis.summary).not.toContain('Finished `dev` profile');
    expect(verdict.reason).toContain('FAIL: non-macOS host should be a no-op');
    expect(verdict.reason).toContain("failed to push some refs");
  });

  it('EI-25439777241393921: a headroom refusal survives truncation without being asserted as the commit-stall cause', () => {
    // The real 2026-09-30 shape: the actionable clause sits behind a ~110-char generic prefix,
    // and the 240-char headline cut used to drop it ("Cause: libs/token-kit: fetch failed; …").
    const lastError = [
      'libs/generic/cache: fetch failed; submodule remote state could not be verified before superproject ' +
        'publication: git fetch stopped for disk headroom at /repo/.git/modules/libs/generic/cache/objects: ' +
        '25012805632 bytes available; critical reserve 40279831019 bytes',
      'libs/token-kit: fetch failed; HEAD has unpushed commits not on origin/main (cannot reconcile): git fetch ' +
        'stopped for disk headroom at /repo/.git/modules/libs/token-kit/objects: 25012805632 bytes available; ' +
        'critical reserve 40279831019 bytes',
    ].join('\n');
    const verdict = evaluateGitSyncStall({ ...base, headUnchangedMs: 40 * M, lastError, errorSweeps: 3 }, NOW);
    expect(isStrandingVerdict(verdict)).toBe(true);
    expect(verdict.errorHeadline).toMatch(/^libs\/generic\/cache: git fetch stopped for disk headroom/);
    expect(verdict.errorHeadline).toContain('critical reserve');

    const d = gitSyncStallDiagnosis(verdict, 'papercusp');
    expect(d.summary).toContain('DISK SPACE / HEADROOM');
    expect(d.summary).toContain('does not establish a local commit failure');
    expect(d.summary).not.toContain('nothing commits');
    expect(d.summary).not.toContain('LOCAL DISK FULL');
    expect(d.summary).toContain('git fetch stopped for disk headroom');
    expect(d.title).toMatch(/disk/i);
    expect(d.why).toMatch(/DISK SPACE/);
    expect(d.why).not.toMatch(/executor reaping|engine wedge/i);
    expect(d.why).not.toMatch(/rescue-commit the tree/i);
    expect(d.why).toContain('verify the local commit outcome separately');
    expect(d.why).not.toContain('root cause is DISK SPACE');
  });
});

describe('WI-41567 head-clock re-arm — the stranding clock measures time-since-FAULT-ONSET, not time-since-last-commit', () => {
  const SWEEP = 15 * M; // watchdog sweep interval
  const HEAD = 'a'.repeat(40);

  const idleRow = {
    headSha: HEAD,
    wdHeadSha: HEAD,
    wdHeadSinceMs: NOW - 2 * H, // clock last armed 2h ago
    localSyncStatus: 'nothing',
    lastStatus: 'nothing',
  };

  describe('decideHeadClock (pure sweep-side clock decision)', () => {
    it('pure-idle sweep (clean "nothing" tick, HEAD unchanged) RE-ARMS the clock', () => {
      const d = decideHeadClock(idleRow, NOW);
      expect(d.reset).toBe(true);
      expect(d.resetReason).toBe('commit-not-attemptable');
      expect(d.headUnchangedMs).toBe(0);
    });

    it("gated 'skipped' / 'skipped-locked' sweeps also re-arm (frozen HEAD is definitional there too)", () => {
      for (const status of ['skipped', 'skipped-locked']) {
        const d = decideHeadClock({ ...idleRow, localSyncStatus: status, lastStatus: status }, NOW);
        expect(d.reset).toBe(true);
        expect(d.resetReason).toBe('commit-not-attemptable');
      }
    });

    it('HEAD advanced ⇒ reset with head-advanced reason (pre-existing behavior preserved)', () => {
      const d = decideHeadClock({ ...idleRow, wdHeadSha: 'b'.repeat(40), localSyncStatus: 'synced', lastStatus: 'synced' }, NOW);
      expect(d.reset).toBe(true);
      expect(d.resetReason).toBe('head-advanced');
      expect(d.headUnchangedMs).toBe(0);
    });

    it('first observation (no wd_head_since_ms) ⇒ reset, never judged stale this pass', () => {
      const d = decideHeadClock({ ...idleRow, wdHeadSinceMs: null }, NOW);
      expect(d.reset).toBe(true);
      expect(d.resetReason).toBe('head-advanced');
    });

    it('no head recorded yet ⇒ no reset, headUnchangedMs null (cannot judge commit-staleness)', () => {
      const d = decideHeadClock({ ...idleRow, headSha: null }, NOW);
      expect(d.reset).toBe(false);
      expect(d.headUnchangedMs).toBeNull();
    });

    it('EI-7531 true stall preserved: attemptable statuses NEVER re-arm — the clock accumulates', () => {
      for (const status of ['synced', 'error']) {
        const d = decideHeadClock({ ...idleRow, localSyncStatus: status, lastStatus: status }, NOW);
        expect(d.reset).toBe(false);
        expect(d.headUnchangedMs).toBe(2 * H); // full accumulation since the clock was armed
      }
    });

    it('bridge-leg fallback: with no local stage record, the top-level status decides', () => {
      const d = decideHeadClock({ ...idleRow, localSyncStatus: null, lastStatus: 'nothing' }, NOW);
      expect(d.reset).toBe(true);
      expect(d.resetReason).toBe('commit-not-attemptable');
    });
  });

  it('REGRESSION (2026-08-25 papercusp-public-site): idle→local-fetch-error tick must NOT yield the STRANDING verdict', () => {
    // Hours of clean-idle 'nothing' sweeps: each one re-arms the clock.
    let clockArmedAt = NOW - 2 * H;
    for (let t = NOW - 2 * H + SWEEP; t <= NOW - SWEEP; t += SWEEP) {
      const d = decideHeadClock(idleRow, t);
      expect(d.reset).toBe(true); // idle sweep ⇒ re-arm
      clockArmedAt = t;
    }
    // Next tick the LOCAL stage errors on fetch ('error' = attemptable — the prior
    // EI-20625652898058188 fix is blind here). The clock was re-armed one sweep ago.
    const errorSweep = decideHeadClock(
      { ...idleRow, wdHeadSinceMs: clockArmedAt, localSyncStatus: 'error', lastStatus: 'error' },
      NOW,
    );
    expect(errorSweep.reset).toBe(false);
    expect(errorSweep.headUnchangedMs).toBe(NOW - clockArmedAt); // ≈ one sweep interval
    expect(errorSweep.headUnchangedMs!).toBeLessThanOrEqual(SWEEP);

    // The verdict on that sweep: NOT commit-stale (clock is fresh), and once the fault has
    // persisted 2 sweeps it alarms as a FAULTING leg — the non-stranding diagnosis.
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: errorSweep.headUnchangedMs,
        localSyncStatus: 'error',
        lastStatus: 'error',
        lastError: 'superproject: fetch failed; HEAD has unpushed commits not on origin/main',
        errorSweeps: 2,
      },
      NOW,
    );
    expect(v.commitStale).toBe(false);
    expect(v.errorStall).toBe(true);
    expect(v.stalled).toBe(true);
    expect(isStrandingVerdict(v)).toBe(false);
    const diagnosis = gitSyncStallDiagnosis(v, 'papercusp-public-site');
    expect(diagnosis.summary).toContain('FAULTING');
    expect(diagnosis.summary).not.toContain('code is stranding');
  });

  it('REGRESSION control (EI-7531 class): a dirty tree failing continuously still pages STRANDING', () => {
    // Statuses stay attemptable the whole window, so no sweep re-arms and the clock accumulates.
    const d = decideHeadClock({ ...idleRow, localSyncStatus: 'error', lastStatus: 'error' }, NOW);
    expect(d.reset).toBe(false);
    const v = evaluateGitSyncStall(
      {
        ...base,
        headUnchangedMs: d.headUnchangedMs,
        localSyncStatus: 'error',
        lastStatus: 'error',
        lastError: 'commit failed: index.lock held',
        errorSweeps: 2,
      },
      NOW,
    );
    expect(v.commitStale).toBe(true);
    expect(isStrandingVerdict(v)).toBe(true);
  });

  it('isCommitNotAttemptableStatus prefers the local stage record over the bridged top-level status', () => {
    expect(isCommitNotAttemptableStatus('nothing', 'error')).toBe(true); // bridge overwrote top-level
    expect(isCommitNotAttemptableStatus('synced', 'nothing')).toBe(false); // local commit was attemptable
    expect(isCommitNotAttemptableStatus(null, 'skipped')).toBe(true); // pre-stage-record fallback
    expect(isCommitNotAttemptableStatus(null, null)).toBe(false);
  });
});

// EI-1835: the pure eligibility-loss edge detector — the gap the stall detector above
// deliberately never closes (a gated 'skipped' tick is explicitly EXEMPT from commit-staleness).
// DB wiring (checkGitSyncStall's per-row eligibility block, the persisted wd_ineligible_sweeps /
// eligibility_alerted metadata, and the escalation/broadcast plumbing) is integration-covered,
// same split as the stall detector's own header comment.
describe('evaluateGitSyncEligibilityLoss', () => {
  const eligibleBase: GitSyncEligibilityLossSnapshot = {
    currentlyIneligible: false,
    everActive: true,
    ineligibleSweeps: 0,
    eligibilityAlerted: false,
  };

  it('healthy: currently eligible, never alerted ⇒ no alarm, no resolve', () => {
    const v = evaluateGitSyncEligibilityLoss(eligibleBase);
    expect(v.shouldAlarm).toBe(false);
    expect(v.shouldResolve).toBe(false);
  });

  it('first ineligible sweep alone never alarms — not yet sustained (a registry blip self-heals silently)', () => {
    const v = evaluateGitSyncEligibilityLoss({
      currentlyIneligible: true,
      everActive: true,
      ineligibleSweeps: 1,
      eligibilityAlerted: false,
    });
    expect(v.shouldAlarm).toBe(false);
    expect(v.shouldResolve).toBe(false);
  });

  it('EI-1835 core case: sustained ineligible (2nd consecutive sweep) + prior-active evidence ⇒ ALARM', () => {
    const v = evaluateGitSyncEligibilityLoss({
      currentlyIneligible: true,
      everActive: true,
      ineligibleSweeps: 2,
      eligibilityAlerted: false,
    });
    expect(v.shouldAlarm).toBe(true);
    expect(v.shouldResolve).toBe(false);
  });

  it('a routine that NEVER committed going ineligible is not a regression ⇒ never alarms, however long it persists', () => {
    const v = evaluateGitSyncEligibilityLoss({
      currentlyIneligible: true,
      everActive: false,
      ineligibleSweeps: 50,
      eligibilityAlerted: false,
    });
    expect(v.shouldAlarm).toBe(false);
    expect(v.shouldResolve).toBe(false);
  });

  it('no per-tick spam: already alerted ⇒ never re-alarms while still ineligible (one-shot until recovery)', () => {
    const v = evaluateGitSyncEligibilityLoss({
      currentlyIneligible: true,
      everActive: true,
      ineligibleSweeps: 10,
      eligibilityAlerted: true,
    });
    expect(v.shouldAlarm).toBe(false);
    expect(v.shouldResolve).toBe(false); // still ineligible — nothing to resolve YET
  });

  it('recovery: eligible again after a prior alarm ⇒ resolve (and only then)', () => {
    const v = evaluateGitSyncEligibilityLoss({
      ...eligibleBase,
      eligibilityAlerted: true,
    });
    expect(v.shouldAlarm).toBe(false);
    expect(v.shouldResolve).toBe(true);
  });

  it('eligible again with no prior alarm ⇒ nothing to resolve (not every healthy sweep fires a recovery)', () => {
    const v = evaluateGitSyncEligibilityLoss(eligibleBase);
    expect(v.shouldResolve).toBe(false);
  });

  it('respects a custom sustain threshold', () => {
    const snap: GitSyncEligibilityLossSnapshot = {
      currentlyIneligible: true,
      everActive: true,
      ineligibleSweeps: 3,
      eligibilityAlerted: false,
    };
    expect(evaluateGitSyncEligibilityLoss(snap, 4).shouldAlarm).toBe(false);
    expect(evaluateGitSyncEligibilityLoss(snap, 3).shouldAlarm).toBe(true);
    expect(evaluateGitSyncEligibilityLoss(snap, 1).shouldAlarm).toBe(true);
  });

  it('gitSyncEligibilityLossDiagnosis names the install + skip reason and never claims the routine is unrecoverable', () => {
    const d = gitSyncEligibilityLossDiagnosis('papercusp', 'hive_home');
    expect(d.summary).toContain('papercusp');
    expect(d.summary).toContain('hive_home');
    expect(d.title).toMatch(/ELIGIBILITY LOST/);
    expect(d.why).toContain('INTENTIONAL');
    expect(d.why).toContain('REGRESSION');
  });

  it('gitSyncEligibilityLossDiagnosis handles a null skip reason without throwing', () => {
    const d = gitSyncEligibilityLossDiagnosis('papercusp', null);
    expect(d.summary).toContain('unknown reason');
  });

  it('gitSyncEligibilityLossEscalationBody is valid JSON carrying the reason + sweep count', () => {
    const body = gitSyncEligibilityLossEscalationBody({
      installSlug: 'papercusp',
      skipReason: 'no_path',
      ineligibleSweeps: 3,
      nowMs: 1_800_000_000_000,
    });
    const parsed = JSON.parse(body);
    expect(parsed.harness_slug).toBe('papercusp');
    expect(parsed.skipReason).toBe('no_path');
    expect(parsed.ineligibleSweeps).toBe(3);
    expect(parsed.kind).toBe('git-sync-eligibility-watchdog');
  });
});
