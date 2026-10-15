import { describe, expect, it } from 'vitest';
import {
  GATE_ABORT_DETAIL_LIVENESS_MARKER,
  GATE_ABORT_VINTAGE_STALE_MS,
  RECORDED_INCONCLUSIVE_STATUSES,
  classifyGateAbort,
  gateAbortLever,
  gateAbortRefireClause,
  gateAbortDetailAtRead,
  gateAbortVintage,
  isRecordedInconclusiveStatus,
  type RecordedInconclusiveStatus,
} from './gate-abort-status';

/**
 * EI-21290961259437085.
 *
 * The defect these guard: `'cancelled'` reached the generic "clear the gate's abort
 * condition ... re-firing aborts the same way" lever, and BOTH clauses are false for it
 * — an external SIGTERM records a kill, it does not latch a condition. It sat live on
 * papercusp's gate telling every reader to wait on nothing.
 *
 * The invariant that was actually violated is NOT "aborts never block a re-fire" (that
 * would be wrong — see the standing-condition tests below, which exist to stop the
 * over-correction). It is: **every status a reader can be advised about has a routing
 * someone explicitly decided.** `'cancelled'` was never classified; it inherited advice
 * written for a different kind of abort. So the guard enumerates the single source and
 * fails on any member that is merely defaulting.
 */

/** The false clauses, verbatim from the pre-fix generic arm. */
const LATCH_CLAIM = 're-firing aborts the same way';
const CLEAR_CLAIM = "clear the gate's abort condition";

describe('gate abort classification — every recorded status is explicitly routed', () => {
  it('classifies every RECORDED_INCONCLUSIVE_STATUS (a new status must be classified, not defaulted)', () => {
    const unclassified = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'unknown');
    expect(
      unclassified,
      `These statuses are recorded as gate_health.inconclusive but have no entry in KIND_BY_STATUS, so a ` +
        `reader gets the standing-condition wording by DEFAULT rather than by decision — the exact shape of ` +
        `EI-21290961259437085. Classify each in gate-abort-status.ts.`,
    ).toEqual([]);
  });

  it('agrees with the recorded-set membership test', () => {
    for (const status of RECORDED_INCONCLUSIVE_STATUSES) {
      expect(isRecordedInconclusiveStatus(status)).toBe(true);
    }
  });

  it('CALIBRATION: that guard actually fails when a status is left unclassified', () => {
    // Falsifiability, proven in-file rather than by mutating the shared tree (a copy-out
    // probe would race git-sync's sweep for as long as the suite runs). This replays the
    // guard's own filter over the recorded set PLUS one deliberately-unclassified status:
    // if the filter cannot catch that, the guard above is decorative and would have sat
    // green through the very defect it is here to prevent.
    const withUnclassified = [...RECORDED_INCONCLUSIVE_STATUSES, 'a-status-nobody-classified'];
    const unclassified = withUnclassified.filter((s) => classifyGateAbort(s) === 'unknown');
    expect(unclassified).toEqual(['a-status-nobody-classified']);
  });
});

describe('not-applicable checkpoint outcomes', () => {
  it('records the missing integration-branch outcome without inheriting abort advice', () => {
    expect(isRecordedInconclusiveStatus('not-applicable')).toBe(true);
    expect(classifyGateAbort('not-applicable')).toBe('not-applicable');
    expect(gateAbortLever('not-applicable')).toContain('not applicable');
    expect(gateAbortLever('not-applicable')).not.toContain(CLEAR_CLAIM);
    expect(gateAbortRefireClause('not-applicable')).not.toContain(LATCH_CLAIM);
  });
});

describe('transient aborts — the reported defect', () => {
  const transient = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'transient');

  it('covers cancelled, and cancelled is transient (the live 2026-08-24 case)', () => {
    // Pinned by name: this is the status the bug was filed for. If a later change
    // reclassifies it, that should be a deliberate edit to this assertion.
    expect(classifyGateAbort('cancelled')).toBe('transient');
    expect(transient).toContain('cancelled');
  });

  it('never tells the reader a re-fire aborts identically', () => {
    for (const status of transient) {
      expect(gateAbortRefireClause(status), `refire clause for ${status}`).not.toContain(LATCH_CLAIM);
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(LATCH_CLAIM);
    }
  });

  it('never tells the reader to clear a condition that does not exist', () => {
    for (const status of transient) {
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(CLEAR_CLAIM);
    }
  });

  it('warns off triaging the previous red, which is what a reader would otherwise chase', () => {
    for (const status of transient) {
      expect(gateAbortLever(status).toLowerCase()).toContain('do not triage');
    }
  });
});

describe('standing conditions — the over-correction guard', () => {
  const standing = RECORDED_INCONCLUSIVE_STATUSES.filter(
    (s) => classifyGateAbort(s) === 'standing-condition',
  );

  it('has at least one member, so the tests below are not vacuous', () => {
    expect(standing.length).toBeGreaterThan(0);
    expect(classifyGateAbort('disk-headroom')).toBe('standing-condition');
    expect(standing).toContain('disk-headroom');
  });

  it('KEEPS the generic wording — a real blocker does re-abort, and saying otherwise burns a ~55min suite', () => {
    for (const status of standing) {
      expect(gateAbortLever(status), `lever for ${status}`).toContain(CLEAR_CLAIM);
      expect(gateAbortRefireClause(status), `refire clause for ${status}`).toContain(
        'abort the same way',
      );
    }
  });
});

describe('peer-owned aborts', () => {
  const peerOwned = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'peer-owned');

  it('routes to waiting on the owner rather than to clearing or re-firing', () => {
    expect(peerOwned.length).toBeGreaterThan(0);
    for (const status of peerOwned) {
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(CLEAR_CLAIM);
      expect(gateAbortLever(status).toLowerCase()).toContain('wait');
    }
  });
});

describe('unknown statuses fall back conservatively', () => {
  // The control that makes the suite falsifiable in the other direction: an
  // unclassified status must inherit the CAUTIOUS wording, never the transient
  // "nothing is blocking a re-fire" — we do not know that, and guessing it wrong
  // costs a full suite.
  const madeUp = 'some-status-invented-by-a-future-change' as unknown as RecordedInconclusiveStatus;

  it('is not a recorded status', () => {
    expect(isRecordedInconclusiveStatus(madeUp)).toBe(false);
    expect(classifyGateAbort(madeUp)).toBe('unknown');
  });

  it('does not claim a re-fire is safe', () => {
    expect(gateAbortLever(madeUp)).toContain(CLEAR_CLAIM);
    expect(gateAbortRefireClause(madeUp)).not.toContain('nothing about it blocks a re-fire');
  });
});

/**
 * WI-1752145 — the abort record's own vintage.
 *
 * The defect: `gate_health.inconclusive` is LATCHED (written by a scoped jsonb_set that does
 * not advance the top-level `observedAt`), so it persists until a later tick overwrites it
 * while every other age on the payload describes the VERDICT instead. Measured live
 * 2026-08-31: +4s skew on one install, +5.7 DAYS on another. The originating incident is the
 * other direction — a `migrations-pending` abort observed at 11:23:52Z still served ~1h after
 * migration 1044 APPLIED at 11:27:20Z, and repeated downstream as current fact.
 *
 * Three directions are guarded, and the last two are what stop this passing vacuously.
 */
describe('gateAbortVintage: a latched abort carries its own age', () => {
  const NOW = Date.parse('2026-08-31T15:00:00.000Z');

  it('reports the age and warns when the record is older than the threshold', () => {
    const v = gateAbortVintage({
      status: 'migrations-pending',
      observedAtMs: NOW - GATE_ABORT_VINTAGE_STALE_MS - 60_000,
      nowMs: NOW,
    });
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBe(GATE_ABORT_VINTAGE_STALE_MS + 60_000);
    expect(v.age).toBe('1h31m');
    expect(v.warning).toBeTruthy();
    // The warning must say the record is LATCHED — that is the fact a reader needs in
    // order to know the condition may already have cleared, and it is the exact thing the
    // originating incident's reader did not have.
    expect(v.warning).toContain('LATCHED');
  });

  /**
   * NEGATIVE DIRECTION #1 — the control that makes the guard above meaningful. A projection
   * that decorates every read is one a reader learns to skip, so a fresh abort gets its age
   * and NO staleness marker.
   */
  it('does NOT decorate a fresh record with a staleness marker', () => {
    const v = gateAbortVintage({
      status: 'migrations-pending',
      observedAtMs: NOW - 4_000,
      nowMs: NOW,
    });
    expect(v.stale).toBe(false);
    expect(v.warning).toBeNull();
    // The vintage is still stated — the age is the stamp; the warning is the escalation.
    expect(v.age).toBe('4s');
    expect(v.ageMs).toBe(4_000);
  });

  /**
   * NEGATIVE DIRECTION #2 — the one that matters most to this lane. A blob predating the
   * stamp has an UNKNOWN vintage, and reporting that as `stale: false` would manufacture
   * exactly the confident-measurement-of-nothing this item exists to remove. `null` must
   * never collapse into `false`.
   */
  it('reports an unstamped record as UNKNOWN vintage, never as fresh', () => {
    for (const missing of [undefined, null, Number.NaN]) {
      const v = gateAbortVintage({ status: 'error', observedAtMs: missing, nowMs: NOW });
      expect(v.stale).toBeNull();
      expect(v.stale).not.toBe(false);
      expect(v.ageMs).toBeNull();
      expect(v.age).toBeNull();
      // Unknown vintage is still disclosed — silence here would read as "no concern".
      expect(v.warning).toContain('NO observation timestamp');
    }
  });

  it('never returns a negative age for a clock that ran backwards', () => {
    const v = gateAbortVintage({ status: 'cancelled', observedAtMs: NOW + 60_000, nowMs: NOW });
    expect(v.ageMs).toBe(0);
    expect(v.stale).toBe(false);
  });
});

describe('gateAbortDetailAtRead: cached details carry their vintage and live-run boundary', () => {
  const now = Date.parse('2026-09-20T00:50:00.000Z');

  it('stamps a 27-minute-old detail even below the stale-warning threshold', () => {
    const detail = gateAbortDetailAtRead({
      status: 'repair-in-progress',
      detail: 'candidate remains serialized and no suite was run',
      observedAtMs: now - 27 * 60_000,
      nowMs: now,
    });

    expect(detail).toContain('no suite was run');
    expect(detail).toContain('Abort observed 27m ago');
    expect(detail).toContain(GATE_ABORT_DETAIL_LIVENESS_MARKER);
  });

  it('retains stale and unknown-vintage warnings beside the live-run boundary', () => {
    for (const observedAtMs of [now - 3 * 60 * 60_000, null]) {
      const detail = gateAbortDetailAtRead({
        status: 'repair-in-progress',
        detail: 'no suite was run',
        observedAtMs,
        nowMs: now,
      });
      expect(detail).toContain(GATE_ABORT_DETAIL_LIVENESS_MARKER);
      expect(detail).toMatch(observedAtMs === null ? /NO observation timestamp/ : /LATCHED/);
    }
  });
});
