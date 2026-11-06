/**
 * P-015 second assertion — D-025 holder⇒booted.
 *
 * Falsifiability: as with the sibling degradation guard, the controls are permanent in-file
 * NARROWER rules (CLAUDE.md § "Proving a guard is falsifiable", tier 1 — the subject is a module
 * we import, so nothing in the shared tree is ever mutated). The load-bearing assertions are the
 * ones where a control MISSES a case the real judge catches, plus a calibration block so the
 * controls cannot be passing vacuously.
 */

import { describe, expect, it } from 'vitest';
import { judgeHolderBootInvariant, type HolderBootInvariantInput } from './seed-holder-boot-invariant.js';

/** The state measured on this box 2026-08-08: bg-host holds the fd, everyone says booted:false. */
const D025_STATE: HolderBootInvariantInput = {
  storeLocked: true,
  holderFound: false,
  answered: [3070, 3170, 3270, 3271, 3373],
  probed: [3070, 3170, 3270, 3271, 3373],
};

/** Lock held, nothing answered — the holder is simply outside the probed set. */
const UNREACHABLE: HolderBootInvariantInput = {
  storeLocked: true,
  holderFound: false,
  answered: [],
  probed: [3070, 3170],
};

/** The healthy no-outage cut: locked, and a process owns up to it. */
const HEALTHY: HolderBootInvariantInput = {
  storeLocked: true,
  holderFound: true,
  answered: [3271],
  probed: [3070, 3271],
};

/** A quiesced box — the cut opens the store writable itself. */
const FREE: HolderBootInvariantInput = {
  storeLocked: false,
  holderFound: false,
  answered: [],
  probed: [],
};

// ── deliberately-wrong controls, kept permanently ──────────────────────────────────────

/**
 * CONTROL 1 — the pre-D-025 reading, which is what cut-seed-cli's message implied: "no holder
 * answered ⇒ nobody holds this hive". It cannot distinguish the inconsistency from an empty box,
 * so it treats the violation as an ordinary absence.
 */
function noHolderMeansAbsent(inp: HolderBootInvariantInput): boolean {
  return inp.holderFound; // ok only when someone claims it; no notion of the lock at all
}

/**
 * CONTROL 2 — collapses "answered and denied" into "did not answer", the exact conflation that
 * kept the inconsistency invisible. It flags BOTH shapes identically, so it can never tell a
 * genuine D-025 violation from an unreachable holder.
 */
function lockedAndNoHolderIsAlwaysViolation(inp: HolderBootInvariantInput): boolean {
  return !(inp.storeLocked && !inp.holderFound);
}

describe('P-015 / D-025 — holder implies booted', () => {
  it('names the measured 2026-08-08 state as a VIOLATION, not an absence', () => {
    const v = judgeHolderBootInvariant(D025_STATE);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('holder-without-boot');
    expect(v.message).toMatch(/D-025 INVARIANT VIOLATED/);
  });

  it('steers away from the outage remedy, which is the error the naming exists to prevent', () => {
    const v = judgeHolderBootInvariant(D025_STATE);
    expect(v.message).toMatch(/do NOT quiesce the operator/i);
    expect(v.message).toMatch(/nobody holds the hive/); // quoted as the misreading to avoid
  });

  it('holds when a process owns up to the boot', () => {
    expect(judgeHolderBootInvariant(HEALTHY)).toMatchObject({ ok: true, code: 'consistent' });
  });

  it('is NOT engaged when the lock is free', () => {
    expect(judgeHolderBootInvariant(FREE)).toMatchObject({ ok: true, code: 'not-engaged' });
  });

  it('reports an unreachable holder as UNDETERMINED, not as a violation', () => {
    const v = judgeHolderBootInvariant(UNREACHABLE);
    expect(v.code).toBe('holder-unreachable');
    expect(v.ok).toBe(true); // over-claiming here would be the same defect with the sign flipped
    expect(v.message).toMatch(/NOT a D-025 violation/);
  });

  it('flags a stale-build sibling as the competing explanation for the violation', () => {
    const v = judgeHolderBootInvariant({ ...D025_STATE, staleBuild: [3271] });
    expect(v).toMatchObject({ ok: true, code: 'holder-unreachable' });
    expect(v.message).toMatch(/predate the probe route/);
  });

  it('keeps a partial negative probe undetermined when the actual holder did not answer', () => {
    const v = judgeHolderBootInvariant({
      storeLocked: true,
      holderFound: false,
      answered: [3070, 3170, 16964],
      probed: [3070, 3170, 3271, 16964],
    });
    expect(v).toMatchObject({ ok: true, code: 'holder-unreachable' });
    expect(v.message).toContain('unanswered 3271');
    expect(v.message).toContain('undetermined, NOT a D-025 violation');
    expect(v.message).not.toContain('Some process on this box holds the store while denying');
  });

  describe('falsifiability — each control MISSES a distinction the real judge makes', () => {
    it('CONTROL 1 cannot tell the violation from a free lock — it calls BOTH the same', () => {
      expect(noHolderMeansAbsent(D025_STATE)).toBe(false);
      expect(noHolderMeansAbsent(FREE)).toBe(false); // control: identical verdict…
      // …but the real judge separates them, and only one of the two is a defect.
      expect(judgeHolderBootInvariant(D025_STATE).code).toBe('holder-without-boot');
      expect(judgeHolderBootInvariant(FREE).code).toBe('not-engaged');
    });

    it('CONTROL 2 calls an unreachable holder a violation; the real judge does not', () => {
      expect(lockedAndNoHolderIsAlwaysViolation(UNREACHABLE)).toBe(false); // control: violation
      expect(judgeHolderBootInvariant(UNREACHABLE).ok).toBe(true); // real: undetermined
      // And it still catches the case that IS one:
      expect(judgeHolderBootInvariant(D025_STATE).ok).toBe(false);
    });

    it('CALIBRATION: the controls agree with the real judge on the healthy case', () => {
      expect(noHolderMeansAbsent(HEALTHY)).toBe(true);
      expect(lockedAndNoHolderIsAlwaysViolation(HEALTHY)).toBe(true);
      expect(judgeHolderBootInvariant(HEALTHY).ok).toBe(true);
    });
  });
});
