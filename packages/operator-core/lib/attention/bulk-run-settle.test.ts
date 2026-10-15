/**
 * The settle rule (EI-22013650201095388 / plan autonomous-inbox-resolution-2026-08-31 P-001).
 *
 * `deriveSettleOutcome` decides whether a bulk run reads as SUCCESS. It is pure
 * so the rule can be pinned without PG, a resolver, or a live run — the same
 * convention as attention/sources.ts.
 *
 * What this file is really guarding: `complete` is the only outcome an owner (or
 * an unattended schedule) reads as "that worked". Before the fix, TWO different
 * do-nothing runs reached it — an empty state set (`[].some()` is `false`) and a
 * resolver that died before recording anything. Measured on real rows: three
 * runs sat at phase='complete' with 100% of their item rows still `pending` and
 * `heartbeat_at = NULL`. A click-driven run survives that because a human is
 * looking at the pane; a SCHEDULED one becomes a silent no-op that reports
 * healthy, which is the whole reason this rule has to be earned rather than
 * fallen into.
 */

import { describe, expect, it } from 'vitest';
import { deriveSettleOutcome, setRunPhase } from './bulk-run-store';

describe('deriveSettleOutcome', () => {
  it('settles reconciled cleanup skips without treating legacy skips as owner decisions', () => {
    const input = { runKind: 'plan-cleanup' as const, outcomes: ['skipped'], everReportedLife: true };
    expect(deriveSettleOutcome({ ...input, dispositions: ['routed'], reconciled: [true] }).phase).toBe('complete');
    expect(deriveSettleOutcome({ ...input, dispositions: ['routed'] }).phase).toBe('review');
    expect(deriveSettleOutcome({ ...input, dispositions: ['legacy_skipped'] }).phase).toBe('review');
    expect(deriveSettleOutcome(input).phase).toBe('review');
    expect(deriveSettleOutcome({ ...input, runKind: 'inbox-resolve', dispositions: ['routed'], reconciled: [true] }).phase).toBe('review');
  });

  describe('inbox-resolve', () => {
    it('settles complete once every row is terminal', () => {
      expect(
        deriveSettleOutcome({
          runKind: 'inbox-resolve',
          outcomes: ['auto_resolved', 'dismissed', 'auto_resolved'],
          everReportedLife: true,
        }),
      ).toEqual({ phase: 'complete', refusedReason: null });
    });

    it('settles review while any row still needs the owner', () => {
      // `recommended` and `skipped` are both still owner work: a resolver skip is
      // evidence it could not act, never an implicit owner dismissal.
      for (const undecided of ['pending', 'recommended', 'skipped', 'failed']) {
        expect(
          deriveSettleOutcome({
            runKind: 'inbox-resolve',
            outcomes: ['auto_resolved', undecided],
            everReportedLife: true,
          }).phase,
        ).toBe('review');
      }
    });

    it('REFUSES to call an empty membership set complete', () => {
      // The regression. createRun seeds the whole snapshot in the same
      // transaction as the run row and refuses a zero-item run, so zero rows
      // means the manifest was lost — the one thing it cannot mean is that
      // every row settled.
      const out = deriveSettleOutcome({
        runKind: 'inbox-resolve',
        outcomes: [],
        everReportedLife: true,
      });
      expect(out.phase).toBe('failed');
      expect(out.refusedReason).toMatch(/zero item rows/);
    });

    it('refuses an empty set even when the resolver never reported life', () => {
      // Membership-lost is the more specific diagnosis, so it wins over the
      // generic no-evidence-of-life reason rather than reporting the vaguer one.
      const out = deriveSettleOutcome({
        runKind: 'inbox-resolve',
        outcomes: [],
        everReportedLife: false,
      });
      expect(out.phase).toBe('failed');
      expect(out.refusedReason).toMatch(/zero item rows/);
    });
  });

  describe('plan-cleanup', () => {
    it('settles complete on a genuinely clean scan (zero findings, resolver ran)', () => {
      // The case the empty-set guard must NOT break. plan-cleanup findings
      // ACCRUE during the run, so zero findings is the legitimate "scanned it,
      // nothing to clean" result — which is exactly why the empty-set rule is
      // kind-aware instead of one blanket refusal.
      expect(
        deriveSettleOutcome({
          runKind: 'plan-cleanup',
          outcomes: [],
          everReportedLife: true,
        }),
      ).toEqual({ phase: 'complete', refusedReason: null });
    });

    it('REFUSES zero findings from a run that never reported life', () => {
      // Indistinguishable from "never started" without a heartbeat, so it must
      // not be reported as a clean scan.
      const out = deriveSettleOutcome({
        runKind: 'plan-cleanup',
        outcomes: [],
        everReportedLife: false,
      });
      expect(out.phase).toBe('failed');
      expect(out.refusedReason).toMatch(/never reported a heartbeat/);
    });

    it('settles COMPLETE when the settling caller just completed the scan itself (WI-10004729)', () => {
      // The deterministic pass settles a zero-finding run before any resolver
      // exists, so heartbeat_at is NULL. Its completed scan is the evidence of
      // life; refusing it is what made every clean single-plan run `failed`.
      expect(
        deriveSettleOutcome({
          runKind: 'plan-cleanup',
          outcomes: [],
          everReportedLife: false,
          scanCompleted: true,
        }),
      ).toEqual({ phase: 'complete', refusedReason: null });
    });

    it('scan evidence never excuses an inbox run with zero rows', () => {
      // An inbox run's empty set means a lost manifest whoever settles it.
      const out = deriveSettleOutcome({
        runKind: 'inbox-resolve',
        outcomes: [],
        everReportedLife: false,
        scanCompleted: true,
      });
      expect(out.phase).toBe('failed');
      expect(out.refusedReason).toMatch(/zero item rows/);
    });

    it('scan evidence does not hide findings still awaiting the owner', () => {
      expect(
        deriveSettleOutcome({
          runKind: 'plan-cleanup',
          outcomes: ['pending'],
          everReportedLife: false,
          scanCompleted: true,
        }).phase,
      ).toBe('review');
    });

    it('uses the plan-cleanup terminal vocabulary, not the inbox one', () => {
      // `auto_applied`/`accepted` are terminal here; `auto_resolved` is not a
      // plan-cleanup outcome at all and must read as still-awaiting.
      expect(
        deriveSettleOutcome({
          runKind: 'plan-cleanup',
          outcomes: ['auto_applied', 'accepted', 'dismissed'],
          everReportedLife: true,
        }).phase,
      ).toBe('complete');
      expect(
        deriveSettleOutcome({
          runKind: 'plan-cleanup',
          outcomes: ['auto_applied', 'pending'],
          everReportedLife: true,
        }).phase,
      ).toBe('review');
    });
  });

  it('never returns a reason on a non-refused settle', () => {
    // The reason string is what makes an abandoned run distinguishable from a
    // genuine failure, so it must not leak onto a healthy settle and it must
    // always be present on a refusal.
    const cases = [
      { runKind: 'inbox-resolve' as const, outcomes: ['auto_resolved'], everReportedLife: true },
      { runKind: 'inbox-resolve' as const, outcomes: ['pending'], everReportedLife: true },
      { runKind: 'plan-cleanup' as const, outcomes: [], everReportedLife: true },
      { runKind: 'inbox-resolve' as const, outcomes: [], everReportedLife: true },
      { runKind: 'plan-cleanup' as const, outcomes: [], everReportedLife: false },
    ];
    for (const c of cases) {
      const out = deriveSettleOutcome(c);
      expect(out.refusedReason === null).toBe(out.phase !== 'failed');
    }
  });

  describe('falsifiability control', () => {
    /**
     * The PRE-FIX rule, kept deliberately wrong and permanent (CLAUDE.md's
     * "proving a guard is falsifiable" — the module tier: a wrong
     * implementation as a control, never an in-tree mutation, which on this
     * swept shared checkout can be COMMITTED by git-sync mid-probe).
     *
     * This is the whole of the old logic: one `.some()` over the state set,
     * with no notion of an empty set or of evidence that the resolver ran.
     */
    const preFixRule = (runKind: 'inbox-resolve' | 'plan-cleanup', outcomes: readonly string[]) => {
      const terminal =
        runKind === 'plan-cleanup'
          ? ['auto_applied', 'accepted', 'dismissed']
          : ['auto_resolved', 'dismissed'];
      return outcomes.some((o) => !terminal.includes(o)) ? 'review' : 'complete';
    };

    it('the control reproduces the defect, so these assertions can actually fail', () => {
      // If this ever stops saying `complete`, the control has drifted and the
      // divergence check below proves nothing.
      expect(preFixRule('inbox-resolve', [])).toBe('complete');
      expect(preFixRule('plan-cleanup', [])).toBe('complete');
    });

    it('production diverges from the pre-fix rule on exactly the guarded inputs', () => {
      const guarded = [
        { runKind: 'inbox-resolve' as const, outcomes: [], everReportedLife: true },
        { runKind: 'inbox-resolve' as const, outcomes: [], everReportedLife: false },
        { runKind: 'plan-cleanup' as const, outcomes: [], everReportedLife: false },
      ];
      for (const c of guarded) {
        expect(preFixRule(c.runKind, c.outcomes)).toBe('complete');
        expect(deriveSettleOutcome(c).phase).toBe('failed');
      }
    });

    it('production still AGREES with the pre-fix rule everywhere else', () => {
      // The guard must be surgical: reverting it should change these three
      // inputs and nothing else, or it is quietly re-tiering healthy runs.
      const unguarded = [
        { runKind: 'inbox-resolve' as const, outcomes: ['auto_resolved', 'dismissed'] },
        { runKind: 'inbox-resolve' as const, outcomes: ['auto_resolved', 'pending'] },
        { runKind: 'plan-cleanup' as const, outcomes: ['auto_applied', 'accepted'] },
        { runKind: 'plan-cleanup' as const, outcomes: ['auto_applied', 'pending'] },
      ];
      for (const c of unguarded) {
        expect(deriveSettleOutcome({ ...c, everReportedLife: true }).phase).toBe(
          preFixRule(c.runKind, c.outcomes),
        );
      }
    });
  });

  it('reproduces the measured incident shape and refuses it', () => {
    // bulk-dab06de0 / bulk-03ab6013 / bulk-a0407e8f, 2026-08-24: 151-152 item
    // rows all `pending`, heartbeat_at NULL. Whatever wrote `complete` then, the
    // rule must never produce it for this shape now. Note this settles `review`
    // rather than `failed` — the rows DID exist, so the run is recoverable owner
    // work, not an abandoned one; `complete` is the only unacceptable answer.
    const out = deriveSettleOutcome({
      runKind: 'inbox-resolve',
      outcomes: Array.from({ length: 152 }, () => 'pending'),
      everReportedLife: false,
    });
    expect(out.phase).toBe('review');
    expect(out.phase).not.toBe('complete');
  });
});

describe("setRunPhase type contract — 'complete' is earned, never set", () => {
  it("rejects phase:'complete' at compile time, directing callers to settleRunPhase", () => {
    // The lie WI-2104919 repaired (migration 1064) was minted by writing
    // phase='complete' directly. deriveSettleOutcome guards the settle seam;
    // this pins the OTHER seam: setRunPhase's input type excludes 'complete',
    // so a future production caller cannot quietly re-mint the shape. The pin
    // fires under lint:tsc (vitest never typechecks): if someone widens the
    // type back to BulkRunPhase, the @ts-expect-error below becomes unused and
    // the typecheck fails.
    type SetRunPhaseInput = Parameters<typeof setRunPhase>[0];
    // @ts-expect-error 'complete' is excluded — a run completes only via settleRunPhase.
    const rejected: SetRunPhaseInput = { runId: 'x', phase: 'complete' };
    void rejected;
    const allowed: SetRunPhaseInput = { runId: 'x', phase: 'failed' };
    expect(allowed.phase).toBe('failed');
  });
});
