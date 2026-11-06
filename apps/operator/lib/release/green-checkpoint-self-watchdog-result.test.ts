import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckpointResult } from './green-checkpoint';
import {
  armSelfWatchdog,
  buildCrashCheckpointResult,
  buildPostVerdictSelfWatchdogResult,
  buildSelfWatchdogCheckpointResult,
  buildTerminalFailureCheckpointResult,
  buildTerminationCheckpointResult,
  writeSelfWatchdogArmMarker,
} from './green-checkpoint';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The CONSUMER halves of the seams this builder sits on, imported for real rather than restated
// as literals — exactly as green-checkpoint-crash-result.test.ts does, and for the same reason:
// the defect being fixed here existed precisely because the producer's vocabulary and the
// consumer's class lists could drift apart while both suites stayed green.
import { buildCheckpointDetail, classifyGateStallStatus } from '@papercusp/operator-core/lib/harness/routines/release-actions';
import {
  classifyGateAbort,
  gateAbortLever,
  isRecordedInconclusiveStatus,
} from '@papercusp/operator-core/lib/release/gate-abort-status';
import {
  classifyQualificationVerdict,
  isTerminalQualificationOutcome,
} from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';

const WATCHDOG_SUMMARY =
  'self-watchdog fired after 3h with no normal exit — checkpoint run likely lost its ' +
  'supervising parent; run-lock released and process group is being terminated.';

const build = (failingTests: string[] = []) =>
  buildSelfWatchdogCheckpointResult({
    candidate: 'b3e519a1bfce',
    runId: 'scheduled-231966bc',
    summary: WATCHDOG_SUMMARY,
    failingTests,
    candidateSource: 'tip',
  });

describe('P-033: watchdog expiry diagnostics', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('identifies idle expiry before the hard ceiling when the idle budget exceeds half the ceiling', () => {
    const onFire = vi.fn();
    const kill = vi.fn();
    armSelfWatchdog({ release: vi.fn() }, {
      ms: 60,
      hardCeilingMs: 100,
      pid: 999,
      kill,
      log: () => {},
      snapshotProcessGroup: () => null,
      onFire,
    });

    vi.advanceTimersByTime(59);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire.mock.calls[0]?.[0]).toBe('idle-timeout');
    expect(kill).toHaveBeenCalledWith(-999, 'SIGKILL');
  });

  it('quiet-progress: unlimited work retains custody across both activity and prolonged silence', () => {
    const onFire = vi.fn();
    const kill = vi.fn();
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 1000,
      hardCeilingMs: null,
      pid: 999,
      kill,
      log: () => {},
      snapshotProcessGroup: () => null,
      onFire,
    });

    // 50 progress beats spanning 45s: far past any absolute ceiling the old contract carried.
    for (let i = 0; i < 50; i += 1) {
      vi.advanceTimersByTime(900);
      watchdog.progress();
    }
    expect(onFire).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(watchdog.remainingMs()).toBe(Number.POSITIVE_INFINITY);

    // Silence is opaque, not independent evidence that an operation failed.
    vi.advanceTimersByTime(100_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(watchdog.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    watchdog.cancel();
  });

  it('unlimited work cannot acquire an aggregate cap through finalization tightening', () => {
    const onFire = vi.fn();
    const kill = vi.fn();
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 1000,
      hardCeilingMs: null,
      pid: 999,
      kill,
      log: () => {},
      snapshotProcessGroup: () => null,
      onFire,
    });

    vi.advanceTimersByTime(900); // under the 1000ms idle budget
    watchdog.progress();
    expect(watchdog.tighten({ hardCeilingMs: 2000, reason: 'post-verdict return funnel' })).toBe(false);
    expect(watchdog.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(900);
    watchdog.progress();
    vi.advanceTimersByTime(900);
    watchdog.progress();
    vi.advanceTimersByTime(199);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    watchdog.cancel();
  });

  it('persists the actual idle interval and trigger through the terminal event writer', () => {
    vi.setSystemTime(0);
    let result: CheckpointResult | undefined;
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 60,
      hardCeilingMs: 100,
      trigger: 'scheduled-parent-backstop',
      pid: 999,
      kill: vi.fn(),
      log: () => {},
      snapshotProcessGroup: () => null,
      onFire: (reason, context) => {
        result = buildSelfWatchdogCheckpointResult({
          candidate: 'b3e519a1bfce', runId: 'watchdog-idle', summary: 'Rescued suite evidence.',
          failingTests: ['failing.test.ts'], watchdog: { reason, context },
        });
      },
    });
    vi.advanceTimersByTime(20);
    watchdog.progress();
    vi.advanceTimersByTime(60);

    expect(result).toBeDefined();
    // The producer crosses the JSON result-marker seam before the routine records it.
    const detail = buildCheckpointDetail(JSON.parse(JSON.stringify(result)));
    expect(detail.summary).toContain('self-watchdog fired: idle-timeout');
    expect(detail.summary).toContain('trigger=scheduled-parent-backstop');
    expect(detail.summary).toContain('elapsedMs=80; idleForMs=60');
    expect(detail.summary).toContain('idleBudgetMs=60; hardCeilingMs=100');
    expect(detail.summary).toContain('Rescued suite evidence.');
    expect(detail.summary).not.toMatch(/lost.*parent|presumed-dead parent/);
    expect(detail.failingTests).toEqual(['failing.test.ts']);
    expect(detail.green).toBeNull();
    expect(detail.crashed).toBeUndefined();
  });

  it('records a tightened hard ceiling and its phase without misreporting the original budget', () => {
    vi.setSystemTime(0);
    let result: CheckpointResult | undefined;
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 100, hardCeilingMs: 100, trigger: 'manual-run-deadline',
      pid: 999, kill: vi.fn(), log: () => {}, snapshotProcessGroup: () => null,
      onFire: (reason, context) => {
        result = buildSelfWatchdogCheckpointResult({
          candidate: 'b3e519a1bfce', runId: 'watchdog-finalizing', summary: '',
          failingTests: [], watchdog: { reason, context },
        });
      },
    });
    vi.advanceTimersByTime(20);
    watchdog.progress();
    expect(watchdog.tighten({ hardCeilingMs: 30, reason: 'post-verdict finalizing' })).toBe(true);
    vi.advanceTimersByTime(30);

    expect(result?.summary).toContain('self-watchdog fired: absolute-hard-ceiling');
    expect(result?.summary).toContain('trigger=manual-run-deadline');
    expect(result?.summary).toContain('elapsedMs=50; idleForMs=30');
    expect(result?.summary).toContain('idleBudgetMs=100; hardCeilingMs=50');
    expect(result?.summary).toContain('tightenedBecause=post-verdict finalizing');
    expect(result?.green).toBeNull();
  });
});

/**
 * WI-41740 — the SELF-WATCHDOG kill path.
 *
 * When `armSelfWatchdog`'s deadline fires, the run is SIGKILLed having rendered no verdict. The
 * result it publishes carried `reason: 'not-green'`, which release-actions reads as a RED —
 * usually a red naming nothing at all, since a killed run has no failing-test list unless the
 * suite happened to finish before the kill landed.
 *
 * That is the same defect already fixed on the two sibling no-verdict paths (WI-39841
 * deadline-exceeded, EI-21462211894072863 unreported crash, EI-21465187777146773 caught crash).
 * This path was left behind DELIBERATELY, with an in-code comment arguing it was different
 * because it can sometimes rescue a real failing-file list — so its red is "sometimes
 * contentful". These tests pin the decision that closed that question, and pin the RATIONALE for
 * it, not merely the value.
 */
describe('WI-41740: the self-watchdog kill publishes a no-verdict result, never a fabricated red', () => {
  it('produces an INCONCLUSIVE, non-advancing verdict that is NOT flagged as crashed', () => {
    const r = build();
    expect(r.green).toBeNull();
    expect(r.advanced).toBe(false);
    expect(r.from).toBeNull();
    expect(r.reason).toBe('error');
    // The DISCRIMINATOR. release-actions tells a watchdog kill from a crash by `crashed` + the
    // summary, so this leg must stay ABSENT rather than be written falsey — an explicit
    // `crashed: false` would read as "we checked, and it did not crash".
    expect(r.crashed).toBeUndefined();
    expect('crashed' in r).toBe(false);
    expect(r.candidate).toBe('b3e519a1bfce');
    expect(r.runId).toBe('scheduled-231966bc');
    expect(r.summary).toBe(WATCHDOG_SUMMARY);
  });

  it('is strictly null — not false — so the inconclusive-verdict dispatch fires', () => {
    // The literal condition at the emitResult dispatch site (emitInconclusiveVerdict). `=== null`
    // does not admit `false`, which is why this class of bug is invisible: both are falsy.
    const r = build();
    expect(r.green === null).toBe(true);
    expect(r.green).not.toBe(false);
  });

  it('carries the rescued failing-file list verbatim, and an explicit empty array otherwise', () => {
    // WI-4957: the empty array is load-bearing — it lets a consumer tell "the run never got far
    // enough to know" from "nothing was failing". It must not degrade to an absent field.
    expect(build().failingTests).toEqual([]);
    expect(build(['a.test.ts', 'b.test.ts']).failingTests).toEqual([
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  /**
   * ⭐ THE RATIONALE, and the reason this test file exists rather than a one-line value change.
   *
   * The obvious reading of this bug — the one its own title and the pre-fix in-code comment both
   * took — is that the red is only wrong when the rescued list is EMPTY, so `reason` should be
   * 'error' only in that case. That is wrong, and this is the assertion that pins why.
   *
   * `reason` classifies the EVENT: no verdict was rendered. Whether `failingTests` came back
   * populated depends purely on whether the suite happened to finish before the SIGKILL landed —
   * a RACE. Conditioning the reason on it would bank two different durable statuses for two
   * identical watchdog kills, and make the ledger's classification unreproducible. The rescued
   * evidence already travels structurally, in `failingTests`, which is the correct axis for it.
   */
  it('⭐ the reason is UNCONDITIONAL — a rescued failing-file list does not change the class', () => {
    const withNothing = build();
    const withFiles = build(['apps/operator/lib/release/some.test.ts']);

    expect(withNothing.reason).toBe('error');
    expect(withFiles.reason).toBe('error');
    expect(withFiles.reason).toBe(withNothing.reason);

    // …and it survives the consumer, which is what actually matters: the same kill must bank the
    // same status either way.
    expect(classifyGateStallStatus(withFiles.reason, false)).toBe(
      classifyGateStallStatus(withNothing.reason, false),
    );
    // Only the evidence differs between them — never the classification.
    expect(withFiles.failingTests).not.toEqual(withNothing.failingTests);
  });

  /**
   * ⭐ The property the old 'not-green' was protecting, verified rather than assumed.
   *
   * The pre-fix comment kept 'not-green' "so the red streak / held-gate alarm still count it",
   * and that concern was legitimate: a watchdog-LOOPING gate going silent is how `main` freezes
   * with nobody told. It was also already answered — 'error' is EI-21462211894072863's
   * no-verdict class, which counts in `gate_health.consecutiveNoVerdict` and escalates at the
   * same `stallReds` threshold, saying WEDGED instead of RED.
   */
  it('⭐ still COUNTS — the reason routes to no-verdict, never red, never a silent noop', () => {
    const r = build();
    expect(classifyGateStallStatus(r.reason, false)).toBe('no-verdict');
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('red'); // the fabricated verdict
    expect(classifyGateStallStatus(r.reason, false)).not.toBe('noop'); // the silence WI-39841 feared
    // …and a moved pin still wins, exactly as for every other status.
    expect(classifyGateStallStatus(r.reason, true)).toBe('reset');
  });

  it('⭐ and stays VISIBLE — a recorded abort a reader can actually be advised about', () => {
    const r = build();
    // Counting it is only half of "loud": a reason outside RECORDED_INCONCLUSIVE_STATUSES
    // records a tick nobody can be told about.
    expect(isRecordedInconclusiveStatus(r.reason)).toBe(true);
    // A deadline kill really is transient — unlike a missing dependency prewarm, nothing about
    // it guarantees the next run dies the same way.
    expect(classifyGateAbort(r.reason)).toBe('transient');
    // The advice must not send a reader at a failing-test list this tick may never have produced.
    expect(gateAbortLever(r.reason)).toMatch(/do NOT triage/i);
  });

  /**
   * ⭐ THE BEHAVIORAL DELTA this change actually makes, stated explicitly so a future reader can
   * see it was decided rather than stumbled into.
   *
   * classifyQualificationVerdict routed `green: null` + 'not-green' to kind:'red' (its explicit
   * `normalized === 'not-green'` branch). With 'error' it falls through to 'code-inconclusive'.
   * That is semantically correct — the run is past the pre-suite phase but rendered no verdict —
   * and it weakens nothing, because 'code-inconclusive' is TERMINAL exactly like 'red'.
   */
  it('⭐ qualifies as code-inconclusive — still terminal, so no guard is weakened', () => {
    const r = build();
    const outcome = classifyQualificationVerdict({ reason: r.reason, green: r.green });

    expect(outcome.kind).toBe('code-inconclusive');
    // Not the pre-suite class either: 'error' is deliberately absent from
    // PRE_SUITE_NO_VERDICT_REASONS, so this never becomes a WAIT that leaves the attempt open.
    expect(outcome.kind).not.toBe('pre-suite-no-verdict');
    // The load-bearing half: terminality is what every settle/wait guard branches on, and
    // 'code-inconclusive' satisfies it exactly as 'red' did.
    expect(isTerminalQualificationOutcome(outcome)).toBe(true);
    expect(
      isTerminalQualificationOutcome(
        classifyQualificationVerdict({ reason: 'not-green', green: null }),
      ),
    ).toBe(true);
  });

  /**
   * The two no-verdict siblings must remain TELLABLE APART, or this fix would trade a fabricated
   * red for an ambiguous ledger. They share `reason` by design — both rendered no verdict — and
   * diverge on `crashed`, which is exactly the machine-readable discriminator release-actions
   * documents for them.
   */
  it('shares the no-verdict CLASS with a crash while staying distinguishable from it', () => {
    const watchdog = build();
    const crash = buildCrashCheckpointResult({
      candidate: 'b3e519a1bfce',
      error: new Error('boom'),
      runId: 'scheduled-231966bc',
    });

    expect(watchdog.reason).toBe(crash.reason);
    expect(classifyGateStallStatus(watchdog.reason, false)).toBe(
      classifyGateStallStatus(crash.reason, false),
    );
    // …and the discriminator holds in both directions.
    expect(crash.crashed).toBe(true);
    expect(watchdog.crashed).toBeUndefined();
    expect(watchdog.summary).not.toBe(crash.summary);
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL (repo convention: for a module you import, keep the
   * deliberately-wrong implementation in the test file rather than mutating the shared tree — a
   * mutation probe would hold a real source file modified for the life of the run, which
   * git-sync's whole-tree sweep can commit even when nothing goes wrong).
   *
   * `preFix` is the real builder's output with ONLY `reason` put back to what it was before this
   * change — constructed by spread rather than re-implemented, so the divergence is provably a
   * single field. The calibration block pins that everything else agrees, so the failure it
   * produces is attributable to THIS fix and not to some unrelated difference.
   *
   * Falsifiable in the right direction: if the builder ever went back to 'not-green', `real` and
   * `preFix` would carry the same value and the divergence assertions would demand two different
   * classes of it, failing here rather than silently passing.
   */
  it('CONTROL: the pre-fix watchdog result FAILS the property the fixed one satisfies', () => {
    const real = build();
    const preFix = { ...real, reason: 'not-green' as const };

    // CALIBRATION — everything the fix did not touch must still agree, or the divergence below
    // says nothing about this change. `green: null` in particular: the pre-fix path ALREADY
    // returned it, which is exactly why the tri-state alone never stopped the fabricated red.
    expect(preFix.green).toBe(real.green);
    expect(preFix.green).toBeNull();
    expect(preFix.crashed).toBe(real.crashed);
    expect(preFix.summary).toBe(real.summary);
    expect(preFix.advanced).toBe(real.advanced);
    expect(preFix.failingTests).toEqual(real.failingTests);

    // …and diverges at EXACTLY the defect: the old reason banked a RED for a run that judged
    // nothing — with an empty failing-test list — and was not even a status a reader could be
    // advised about.
    expect(classifyGateStallStatus(preFix.reason, false)).toBe('red');
    expect(classifyGateStallStatus(real.reason, false)).toBe('no-verdict');
    expect(isRecordedInconclusiveStatus(preFix.reason)).toBe(false);
    expect(classifyQualificationVerdict({ reason: preFix.reason, green: preFix.green }).kind).toBe(
      'red',
    );
  });

  it('is JSON-serializable (the CLI emits it verbatim on the result-marker line)', () => {
    const r = build(['apps/operator/lib/release/some.test.ts']);
    expect(() => JSON.stringify(r)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(r));
    // Survives the round-trip as null (the risk is it becoming absent, which downstream
    // `?? null` coercions would then read as an ordinary missing field).
    expect(parsed.green).toBeNull();
    expect('green' in parsed).toBe(true);
    expect(parsed.failingTests).toEqual(['apps/operator/lib/release/some.test.ts']);
    // The absent leg must not reappear through serialization either.
    expect('crashed' in parsed).toBe(false);
  });
});

/**
 * ⭐ CLASS-LEVEL RECURRENCE GUARD.
 *
 * WI-41740 is the FOURTH instance of one defect, not a new bug: a green-checkpoint terminal path
 * that rendered NO verdict published `reason: 'not-green'`, which release-actions reads as a RED
 * — usually a red naming no failing tests at all, which then drives the held-gate alarm and the
 * release-fixer dispatch. The prior three were WI-39841 (deadline-exceeded),
 * EI-21462211894072863 (unreported crash) and EI-21465187777146773 (caught crash). Each was
 * fixed as an INSTANCE, which is precisely why a fourth existed to find.
 *
 * So this block guards the CLASS instead of the site. The invariant is the one sentence all four
 * bugs violated:
 *
 *     a result asserting `green === null` ("no verdict was rendered") must never be
 *     classified as a red by the consumer that decides the streak.
 *
 * It runs every exported terminal-result builder through the REAL classifier, so a fifth
 * builder — or a revert of any existing one to 'not-green' — fails here rather than being
 * discovered months later from a fabricated red on a frozen `main`. Note it deliberately does
 * NOT demand one particular reason: 'error' (no-verdict, counted) and 'cancelled' /
 * 'infra-inconclusive' (noop, uncounted) are both legitimate answers with different meanings.
 * The only forbidden answer is 'red'.
 *
 * ⚠ A new terminal builder MUST be added to this census. The census cannot enumerate itself —
 * that is its one weakness, and it is why the list below names each builder explicitly rather
 * than looping over something clever that would silently cover nothing.
 */
describe('CLASS GUARD: no terminal builder that rendered no verdict may be classified red', () => {
  const NO_VERDICT_BUILDERS: ReadonlyArray<readonly [string, () => CheckpointResult]> = [
    [
      'self-watchdog kill (WI-41740)',
      () => build(),
    ],
    [
      'self-watchdog kill WITH a rescued failing-file list (WI-41740, the race half)',
      () => build(['apps/operator/lib/release/some.test.ts']),
    ],
    [
      'caught crash (EI-21465187777146773)',
      () =>
        buildCrashCheckpointResult({
          candidate: 'abc123',
          error: new Error('boom'),
          runId: 'run-class-guard',
        }),
    ],
    [
      'managed SIGTERM/SIGINT cancellation',
      () =>
        buildTerminationCheckpointResult({
          candidate: 'abc123',
          signal: 'SIGTERM',
          runId: 'run-class-guard',
        }),
    ],
    [
      'generic terminal failure (falls through to the crash path)',
      () =>
        buildTerminalFailureCheckpointResult({
          candidate: 'abc123',
          error: new Error('unrecognized failure'),
          runId: 'run-class-guard',
        }),
    ],
    [
      'measured pre-suite infra refusal (WI-40916)',
      () =>
        buildTerminalFailureCheckpointResult({
          candidate: 'abc123',
          error: new Error(
            'bash /repo/scripts/pc-heavy.sh --exclusive-all-slots -- bash setup-release-checkout.sh ' +
              'exited 75: [pc-heavy] REFUSED materialization after 900s: only 13/16 heavy slots drained',
          ),
          runId: 'run-class-guard',
        }),
    ],
    [
      'missing prewarmed dependency generation (P-007)',
      () =>
        buildTerminalFailureCheckpointResult({
          candidate: 'abc123',
          error: new Error(
            'bash /repo/apps/operator/bin/release/dependency-generation.sh --integration /repo ' +
              '--select-inputs-from /repo-checkpoint exited 74: [dependency-generation] FATAL: ' +
              'no prewarmed dependency generation for input fingerprint b0ea5991',
          ),
          runId: 'run-class-guard',
        }),
    ],
  ];

  it.each(NO_VERDICT_BUILDERS)(
    'never fabricates a red verdict: %s',
    (_label, make) => {
      const r = make();
      // Precondition: these builders exist precisely because no verdict was rendered. If one
      // ever starts claiming a verdict, this assertion — not the next — is the one to read.
      expect(r.green).toBeNull();
      // THE INVARIANT.
      expect(classifyGateStallStatus(r.reason, false)).not.toBe('red');
      // …and it must not be reached by the classifier's `return 'red'` DEFAULT either, which is
      // how an unmapped new reason would silently rejoin the class this guard exists to close.
      expect(['no-verdict', 'noop']).toContain(
        classifyGateStallStatus(r.reason, false),
      );
      // A moved pin still wins, for every one of them.
      expect(classifyGateStallStatus(r.reason, true)).toBe('reset');
    },
  );

  /**
   * CONTROL for the guard itself: a guard that has never failed is a guard nobody has tested.
   * This is the exact shape of all four historical bugs — a no-verdict result carrying
   * 'not-green' — and it must be caught, or every assertion above is decorative.
   */
  it('CONTROL: the historical defect shape IS caught by the invariant above', () => {
    const defective = { ...build(), reason: 'not-green' as const };
    expect(defective.green).toBeNull();
    expect(classifyGateStallStatus(defective.reason, false)).toBe('red');
  });
});

// WI-6554700010019444 — run 113fe179 (2026-10-21) retested frozen repairHead 875d0d4b still red,
// then the self-watchdog killed it during the post-verdict P-009 legs. The kill published
// reason:'error' with the TIP candidate, release-actions counted a no-verdict run, and WEDGED fired.
describe('WI-6554700010019444: a kill after the verdict publishes that verdict', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Fired = Parameters<typeof buildPostVerdictSelfWatchdogResult>[0]['watchdog'];
  const FROZEN = '4224bf7c'.padEnd(40, '0');
  const REPAIR_HEAD = '875d0d4b'.padEnd(40, '0');

  /** A real fire context from a real watchdog, not a hand-built literal. */
  function fireOnce(): Fired {
    vi.setSystemTime(0);
    let fired: Fired | undefined;
    armSelfWatchdog({ release: vi.fn() }, {
      ms: 1_000,
      hardCeilingMs: 100,
      trigger: 'scheduled-parent-backstop',
      pid: 999,
      kill: vi.fn(),
      log: () => {},
      snapshotProcessGroup: () => null,
      onFire: (reason, context) => {
        fired = { reason, context };
      },
    });
    vi.advanceTimersByTime(100);
    if (!fired) throw new Error('watchdog did not fire');
    return fired;
  }

  const hold = (): CheckpointResult => ({
    ...build(['apps/operator-vite/src/x.test.ts']),
    candidate: FROZEN,
    green: null,
    reason: 'repair-in-progress',
    summary: 'frozen repair head 875d0d4b is still red at its own sha',
    frozenCandidate: FROZEN,
    repairHead: REPAIR_HEAD,
  });

  it('publishes the recorded hold unchanged, with only the kill noted in the summary', () => {
    const verdict = hold();
    const out = buildPostVerdictSelfWatchdogResult({
      verdict,
      runId: 'scheduled-113fe179',
      watchdog: fireOnce(),
    });
    const { summary, ...rest } = out;
    const { summary: original, ...verdictRest } = verdict;
    expect(rest).toEqual(verdictRest);
    expect(out.candidate).toBe(FROZEN);
    expect(summary).toContain(original as string);
    expect(summary).toContain('post-verdict self-watchdog kill (absolute-hard-ceiling');
    // The `self-watchdog fired:` prefix marks a run that rendered NO verdict; never reuse it.
    expect(summary?.startsWith('self-watchdog fired:')).toBe(false);
  });

  it('is not classified as the no-verdict class release-actions counts toward WEDGED', () => {
    const fired = fireOnce();
    const carried = buildPostVerdictSelfWatchdogResult({
      verdict: hold(),
      runId: 'scheduled-113fe179',
      watchdog: fired,
    });
    const noVerdict = buildSelfWatchdogCheckpointResult({
      candidate: 'tip'.padEnd(40, '0'),
      runId: 'scheduled-113fe179',
      summary: '',
      failingTests: [],
      candidateSource: 'tip',
      watchdog: fired,
    });
    expect(carried.reason).toBe('repair-in-progress');
    expect(classifyGateStallStatus(carried.reason, false)).not.toBe(
      classifyGateStallStatus(noVerdict.reason, false),
    );
  });

  it('remainingMs tracks the live ceiling: elapses, ignores a no-op tighten, follows a real one', () => {
    vi.setSystemTime(0);
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 5_000,
      hardCeilingMs: 10_000,
      pid: 999,
      kill: vi.fn(),
      log: () => {},
      snapshotProcessGroup: () => null,
    });
    expect(watchdog.remainingMs()).toBe(10_000);
    vi.advanceTimersByTime(4_000);
    watchdog.progress();
    expect(watchdog.remainingMs()).toBe(6_000);
    // The 113fe179 trap: a cap past the current deadline is a no-op, and remainingMs says so.
    expect(watchdog.tighten({ hardCeilingMs: 60_000, reason: 'late verdict' })).toBe(false);
    expect(watchdog.remainingMs()).toBe(6_000);
    expect(watchdog.tighten({ hardCeilingMs: 2_000, reason: 'post-verdict' })).toBe(true);
    expect(watchdog.remainingMs()).toBe(2_000);
    watchdog.cancel();
    expect(watchdog.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it('remainingMs is 0 once the watchdog has fired', () => {
    vi.setSystemTime(0);
    const watchdog = armSelfWatchdog({ release: vi.fn() }, {
      ms: 1_000,
      hardCeilingMs: 100,
      pid: 999,
      kill: vi.fn(),
      log: () => {},
      snapshotProcessGroup: () => null,
    });
    vi.advanceTimersByTime(100);
    expect(watchdog.remainingMs()).toBe(0);
  });
});

// WI-6554700010042457: the arm marker is the forensic record of what the watchdog was told. With
// no absolute ceiling it must say so (null), not invent one: `new Date(armedAt + null)` used to
// record a hardDeadlineAt equal to armedAt, which reads as "the ceiling fired at arm time".
describe('writeSelfWatchdogArmMarker with no absolute ceiling', () => {
  it('records hardDeadlineAt:null for hardCeilingMs:null and a real deadline otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wi-42457-arm-marker-'));
    const read = () => JSON.parse(readFileSync(join(dir, 'watchdog.json'), 'utf8')) as Record<string, unknown>;

    writeSelfWatchdogArmMarker(dir, { armedAtMs: 1_000_000, ms: 60_000, hardCeilingMs: null, pid: 42 });
    let marker = read();
    expect(marker.hardDeadlineAt).toBeNull();
    expect(marker.hardCeilingMs).toBeNull();
    expect(marker.idleDeadlineAt).toBe(new Date(1_060_000).toISOString());

    writeSelfWatchdogArmMarker(dir, { armedAtMs: 1_000_000, ms: 60_000, hardCeilingMs: 120_000, pid: 42 });
    marker = read();
    expect(marker.hardDeadlineAt).toBe(new Date(1_120_000).toISOString());
  });
});
