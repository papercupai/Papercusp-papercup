/**
 * Admission-gate predicate guard — plan work-queue-admission-and-bulk-dedup-2026-08-24.
 *
 * Falsifiability discipline (repo: "Proving a guard is falsifiable"): this file keeps
 * DELIBERATELY-WRONG implementations permanently in-tree as controls, plus a
 * calibration case the real subject must pass. Without the calibration, the controls
 * would also "pass" if the property under test were itself broken — which is how a
 * guard silently stops guarding.
 */
import { describe, expect, it } from 'vitest';

import { admittedWhereSql, isAdmitted } from './work-items-admission';

/** CONTROL A — the naive `=== 'admitted'` reading. Quarantines every legacy row. */
const wrongStrictEquals = (a: string | null | undefined): boolean => a === 'admitted';

/** CONTROL B — the three-valued-logic trap: treats NULL as pending. */
const wrongNullIsPending = (a: string | null | undefined): boolean =>
  a != null && a !== 'pending';

describe('isAdmitted — the admission-gate predicate', () => {
  it('admits legacy NULL rows (every row predating migration 944)', () => {
    // The load-bearing case: treating NULL as pending would quarantine the entire
    // live backlog the moment the column lands.
    expect(isAdmitted(null)).toBe(true);
    expect(isAdmitted(undefined)).toBe(true);
  });

  it('refuses exactly one state: pending', () => {
    expect(isAdmitted('pending')).toBe(false);
  });

  it('admits every non-pending state, including fail-open unreviewed', () => {
    expect(isAdmitted('admitted')).toBe(true);
    expect(isAdmitted('auto')).toBe(true);
    // Fail-open is claimable BY DESIGN — a dead promoter must not starve the queue.
    expect(isAdmitted('unreviewed')).toBe(true);
  });

  it('admits an unrecognised future state (fail-open direction)', () => {
    // Deliberate: this gate's unknown-case must ADMIT, opposite to the G2 legs.
    expect(isAdmitted('some-state-added-later')).toBe(true);
  });

  it('refuses any row carrying a duplicate verdict, whatever its admission state (migration 1534, D-001)', () => {
    // Owner directive #1990: the duplicate is a FIELD the gate checks. ANY non-null
    // duplicate_of refuses — an admitted, auto, or legacy-NULL row included.
    for (const admission of [null, undefined, 'admitted', 'auto', 'unreviewed', 'pending'] as const) {
      expect(isAdmitted(admission, 'EI-1')).toBe(false);
    }
    // Absent/NULL verdict leaves the admission axis exactly as before.
    expect(isAdmitted('admitted', null)).toBe(true);
    expect(isAdmitted(null, undefined)).toBe(true);
    expect(isAdmitted('pending', null)).toBe(false);
  });

  describe('falsifiability controls — these MUST disagree with the subject', () => {
    it('CALIBRATION: the subject itself passes the cases the controls are judged on', () => {
      // If this fails, the controls below prove nothing.
      expect(isAdmitted(null)).toBe(true);
      expect(isAdmitted('pending')).toBe(false);
    });

    it('control A (=== admitted) wrongly quarantines legacy and fail-open rows', () => {
      expect(wrongStrictEquals(null)).toBe(false); // subject says true
      expect(wrongStrictEquals('unreviewed')).toBe(false); // subject says true
      expect(wrongStrictEquals(null)).not.toBe(isAdmitted(null));
    });

    it('control B (NULL is pending) wrongly quarantines the whole legacy backlog', () => {
      expect(wrongNullIsPending(null)).toBe(false); // subject says true
      expect(wrongNullIsPending(null)).not.toBe(isAdmitted(null));
      // …but agrees everywhere else, which is why only the NULL case catches it.
      expect(wrongNullIsPending('pending')).toBe(isAdmitted('pending'));
      expect(wrongNullIsPending('admitted')).toBe(isAdmitted('admitted'));
    });

    it('control C (admission-only gate) wrongly admits a filed duplicate', () => {
      const wrongAdmissionOnly = (a: string | null | undefined, _dup?: string | null): boolean => a !== 'pending';
      expect(wrongAdmissionOnly('admitted', 'EI-1')).toBe(true); // subject says false
      expect(wrongAdmissionOnly('admitted', 'EI-1')).not.toBe(isAdmitted('admitted', 'EI-1'));
      expect(wrongAdmissionOnly('admitted', null)).toBe(isAdmitted('admitted', null));
    });
  });
});

describe('admittedWhereSql — every relation shape shares NULL-safe semantics', () => {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values })) as never;
  (sql as unknown as { unsafe: (value: string) => string }).unsafe = (value: string) => value;

  it('renders the feature view, base-table alias, and issue-view alias from one builder', () => {
    const render = (value: unknown) => JSON.stringify(value);
    expect(render(admittedWhereSql(sql))).toContain('admission');
    expect(render(admittedWhereSql(sql, 'wi'))).toContain('wi.admission');
    expect(render(admittedWhereSql(sql, 'ei'))).toContain('ei.admission');
    for (const qualifier of [undefined, 'wi', 'ei'] as const) {
      expect(render(admittedWhereSql(sql, qualifier))).toContain("IS DISTINCT FROM 'pending'");
    }
  });

  it('every relation shape also refuses a row carrying a duplicate verdict, on its own alias', () => {
    const render = (value: unknown) => JSON.stringify(value);
    expect(render(admittedWhereSql(sql))).toContain('duplicate_of');
    expect(render(admittedWhereSql(sql))).not.toContain('.duplicate_of');
    expect(render(admittedWhereSql(sql, 'wi'))).toContain('wi.duplicate_of');
    expect(render(admittedWhereSql(sql, 'ei'))).toContain('ei.duplicate_of');
    for (const qualifier of [undefined, 'wi', 'ei'] as const) {
      expect(render(admittedWhereSql(sql, qualifier))).toContain(' IS NULL)');
    }
  });
});
