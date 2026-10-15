/**
 * The point of these tests is DISCRIMINATION, not coverage.
 *
 * The bug this classifier exists to kill is "several distinct causes produce one
 * identical message", so a suite that only checks each verdict in isolation
 * would pass just as happily against a classifier that returns a constant. Two
 * disciplines guard against that:
 *
 *   - a CALIBRATION case: the happy path must be judged `measured`. Without it,
 *     every negative assertion below can pass vacuously (a classifier that
 *     always says `begin-never-fired` satisfies its own negative case).
 *   - explicit DISCRIMINATION pairs: two observations differing in ONE field
 *     must produce DIFFERENT verdicts. That is the property the production bug
 *     violated, so it is asserted directly rather than implied.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAttemptTimeout,
  classifyInteractionMeasure,
  describeInteractionMeasureFailure,
  type AttemptTimeoutObservation,
  type InteractionMeasureObservation,
} from './interaction-measure.js';

/** A run where everything worked — the baseline every case below perturbs. */
const HEALTHY: InteractionMeasureObservation = {
  measureCount: 1,
  startMarkPresent: false, // consumed by the successful end
  startMarkAgeMs: null,
  staleStartMs: 30_000,
  triggerFound: true,
  settleSurfacePresent: true,
  settleContentPresent: true,
  elapsedMs: 505,
};

/** A run that began timing and is stuck — the baseline for the failure stages. */
const TIMING_STARTED: InteractionMeasureObservation = {
  ...HEALTHY,
  measureCount: 0,
  startMarkPresent: true,
  startMarkAgeMs: 8_000,
  elapsedMs: 8_000,
};

const obs = (over: Partial<InteractionMeasureObservation>): InteractionMeasureObservation => ({
  ...TIMING_STARTED,
  ...over,
});

describe('classifyInteractionMeasure', () => {
  // ── CALIBRATION ────────────────────────────────────────────────────────────
  it('calibration: judges a genuinely healthy run `measured` (without this, every negative case below can pass vacuously)', () => {
    const d = classifyInteractionMeasure(HEALTHY);
    expect(d.verdict).toBe('measured');
    expect(d.ok).toBe(true);
  });

  it('a measure present overrides every other missing signal — the timing is the evidence', () => {
    const d = classifyInteractionMeasure({
      ...HEALTHY,
      // Everything else looks broken; the modal has already closed again.
      settleSurfacePresent: false,
      settleContentPresent: false,
    });
    expect(d.verdict).toBe('measured');
  });

  // ── EACH STAGE ─────────────────────────────────────────────────────────────
  it('names `trigger-missing` when the gesture had no target', () => {
    const d = classifyInteractionMeasure(obs({ triggerFound: false }));
    expect(d.verdict).toBe('trigger-missing');
    expect(d.ok).toBe(false);
  });

  it('names `begin-never-fired` when the trigger was actioned but no start mark followed', () => {
    const d = classifyInteractionMeasure(
      obs({ startMarkPresent: false, startMarkAgeMs: null }),
    );
    expect(d.verdict).toBe('begin-never-fired');
  });

  it('names `start-stale` when the only start mark predates this gesture', () => {
    const d = classifyInteractionMeasure(obs({ startMarkAgeMs: 45_000 }));
    expect(d.verdict).toBe('start-stale');
  });

  it('names `settle-surface-never-appeared` when timing began but the surface never mounted', () => {
    const d = classifyInteractionMeasure(
      obs({ settleSurfacePresent: false, settleContentPresent: false }),
    );
    expect(d.verdict).toBe('settle-surface-never-appeared');
  });

  it('names `settle-content-never-rendered` when the surface mounted empty — the real load defect', () => {
    const d = classifyInteractionMeasure(obs({ settleContentPresent: false }));
    expect(d.verdict).toBe('settle-content-never-rendered');
  });

  it('names `settle-hook-never-fired` when content rendered but no measure was emitted', () => {
    const d = classifyInteractionMeasure(obs({}));
    expect(d.verdict).toBe('settle-hook-never-fired');
  });

  // ── DISCRIMINATION PAIRS ───────────────────────────────────────────────────
  // Each pair differs in exactly ONE field. These are the assertions the real
  // defect violated: one signature, several causes.
  it.each([
    [
      'trigger found vs not',
      obs({ triggerFound: false }),
      obs({ triggerFound: true }),
    ],
    [
      'begin fired vs not',
      obs({ startMarkPresent: false, startMarkAgeMs: null }),
      obs({ startMarkPresent: true, startMarkAgeMs: 8_000 }),
    ],
    [
      'fresh start vs stale start',
      obs({ startMarkAgeMs: 45_000 }),
      obs({ startMarkAgeMs: 8_000 }),
    ],
    [
      'surface absent vs present',
      obs({ settleSurfacePresent: false }),
      obs({ settleSurfacePresent: true }),
    ],
    [
      'content absent vs present',
      obs({ settleContentPresent: false }),
      obs({ settleContentPresent: true }),
    ],
  ])('discriminates %s', (_label, a, b) => {
    expect(classifyInteractionMeasure(a).verdict).not.toBe(
      classifyInteractionMeasure(b).verdict,
    );
  });

  it('every failing verdict carries a DISTINCT suspect — the message must point at one place', () => {
    const failing = [
      obs({ triggerFound: false }),
      obs({ startMarkPresent: false, startMarkAgeMs: null }),
      obs({ startMarkAgeMs: 45_000 }),
      obs({ settleSurfacePresent: false }),
      obs({ settleContentPresent: false }),
      obs({}),
    ].map((o) => classifyInteractionMeasure(o));

    expect(failing.every((d) => d.ok === false)).toBe(true);
    expect(new Set(failing.map((d) => d.verdict)).size).toBe(failing.length);
    expect(new Set(failing.map((d) => d.suspect)).size).toBe(failing.length);
  });

  // ── ORDERING ───────────────────────────────────────────────────────────────
  it('does not judge a downstream stage on a run where an upstream one never happened', () => {
    // Trigger missing AND content missing: the honest verdict is the upstream
    // one, because "content never rendered" is unjudged on a gesture that never
    // landed — reporting it would name the wrong defect with full confidence.
    const d = classifyInteractionMeasure(
      obs({ triggerFound: false, settleSurfacePresent: false, settleContentPresent: false }),
    );
    expect(d.verdict).toBe('trigger-missing');
    expect(d.detail).toContain('unjudged');
  });

  it('a start mark exactly AT the stale threshold is still attributable (boundary is strict)', () => {
    const d = classifyInteractionMeasure(obs({ startMarkAgeMs: 30_000, staleStartMs: 30_000 }));
    expect(d.verdict).not.toBe('start-stale');
  });

  it('tolerates a null start-mark age alongside a present mark without misreporting staleness', () => {
    const d = classifyInteractionMeasure(obs({ startMarkPresent: true, startMarkAgeMs: null }));
    expect(d.verdict).not.toBe('start-stale');
    expect(d.verdict).toBe('settle-hook-never-fired');
  });
});

describe('describeInteractionMeasureFailure', () => {
  it('states the symptom, the named cause, and where to look', () => {
    const msg = describeInteractionMeasureFailure(
      'plan-popup-open',
      8_000,
      classifyInteractionMeasure(obs({ settleContentPresent: false })),
    );
    expect(msg).toContain('no "plan-popup-open" measure emitted within 8000ms');
    expect(msg).toContain('cause: settle-content-never-rendered');
    expect(msg).toContain('look at:');
  });

  it('is not the bare symptom — the old message is a strict prefix, never the whole thing', () => {
    const a = describeInteractionMeasureFailure(
      'x',
      8_000,
      classifyInteractionMeasure(obs({ triggerFound: false })),
    );
    const b = describeInteractionMeasureFailure(
      'x',
      8_000,
      classifyInteractionMeasure(obs({ settleContentPresent: false })),
    );
    expect(a).not.toBe(b);
  });
});

describe('classifyAttemptTimeout — slow sample vs void attempt', () => {
  /** An attempt that began timing, dispatched its request, and is still loading. */
  const DISPATCHED_AND_STUCK: AttemptTimeoutObservation = {
    startMarkPresent: true,
    startMarkAgeMs: 8_200,
    staleStartMs: 30_000,
    phasesSeen: ['request-started'],
    dispatchPhase: 'request-started',
    terminalPlaceholder: null,
  };
  const attempt = (patch: Partial<AttemptTimeoutObservation>) =>
    classifyAttemptTimeout({ ...DISPATCHED_AND_STUCK, ...patch });

  it('CALIBRATION: a dispatched attempt that did not settle is a slow sample', () => {
    const d = attempt({});
    expect(d.verdict).toBe('slow');
    expect(d.reason).toContain('8200ms');
  });

  it('a later phase alongside the dispatch phase is still slow (the stall can be downstream)', () => {
    expect(
      attempt({ phasesSeen: ['request-started', 'response-ready', 'detail-mounted'] }).verdict,
    ).toBe('slow');
  });

  // Each pair differs from the calibration in ONE field and must flip the verdict.
  it('DISCRIMINATES: a terminal placeholder voids the attempt', () => {
    const d = attempt({ terminalPlaceholder: 'Plan not found.' });
    expect(d.verdict).toBe('void');
    expect(d.reason).toContain('Plan not found.');
  });

  it('DISCRIMINATES: a whitespace-only placeholder is not terminal', () => {
    expect(attempt({ terminalPlaceholder: '   ' }).verdict).toBe('slow');
  });

  it('DISCRIMINATES: no begin or current phase evidence is a void attempt', () => {
    expect(attempt({ startMarkPresent: false, startMarkAgeMs: null, phasesSeen: [] }).verdict).toBe('void');
  });

  it('retains a completed measure arriving between wait expiry and the diagnostic read', () => {
    const d = classifyAttemptTimeout({
      ...DISPATCHED_AND_STUCK,
      startMarkPresent: false,
      startMarkAgeMs: null,
      measureCount: 1,
    });
    expect(d.verdict).toBe('measured');
    expect(d.reason).toContain('1 measure');
  });

  it('does not retry away a consumed or cleared start with current dispatch evidence', () => {
    const d = attempt({ startMarkPresent: false, startMarkAgeMs: null });
    expect(d.verdict).toBe('inconclusive');
    expect(d.reason).not.toContain('never began');
  });

  it('keeps an observed begin without a remaining start or phase inconclusive', () => {
    expect(classifyAttemptTimeout({
      ...DISPATCHED_AND_STUCK,
      startMarkPresent: false,
      startMarkAgeMs: null,
      phasesSeen: [],
      beginObserved: true,
    }).verdict).toBe('inconclusive');
  });

  it('DISCRIMINATES: a stale start mark cannot belong to this attempt', () => {
    expect(attempt({ startMarkAgeMs: 30_001 }).verdict).toBe('void');
    expect(attempt({ startMarkAgeMs: 30_000 }).verdict).toBe('slow');
  });

  it('DISCRIMINATES: timing began but the dispatch phase never marked', () => {
    const d = attempt({ phasesSeen: ['detail-mounted'] });
    expect(d.verdict).toBe('void');
    expect(d.reason).toContain('"request-started"');
  });
});
