/**
 * EI-26988974367709614 — claim eligibility and resume actionability must read ONE contract.
 *
 * The defect: `admittedWhereSql` served every non-pending row, including fail-open
 * `unreviewed` rows the live promoter had HELD, while resume told the claimant not to act.
 * Members claimed, released and re-claimed 380 such rows (WI-6554700010029608). These tests
 * pin the shared contract and its SQL twin value-for-value, so the two cannot drift again.
 */
import { describe, expect, it } from 'vitest';
import {
  admissionActionability,
  admissionHoldExclusionSql,
  isAdmissionHoldActive,
} from './work-items-admission';

/** Minimal tagged-template stand-in: renders the fragment's SQL text for inspection. */
function fakeSql() {
  const render = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '');
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => render(strings, ...values)) as unknown as Parameters<typeof admissionHoldExclusionSql>[0];
  (sql as unknown as { unsafe: (s: string) => string }).unsafe = (s: string) => s;
  return sql;
}

describe('admission actionability contract (EI-26988974367709614)', () => {
  it('treats any hold value except null/false/absent as active — the same reading as resume', () => {
    expect(isAdmissionHoldActive({ admissionHold: { reason: 'deferred: twin EI-1 is claimed' } })).toBe(true);
    expect(isAdmissionHoldActive({ admissionHold: 'false' })).toBe(true);
    expect(isAdmissionHoldActive({ admissionHold: null })).toBe(false);
    expect(isAdmissionHoldActive({ admissionHold: false })).toBe(false);
    expect(isAdmissionHoldActive({})).toBe(false);
    expect(isAdmissionHoldActive(null)).toBe(false);
    expect(isAdmissionHoldActive([{ admissionHold: true }])).toBe(false);
  });

  it('held-unreviewed: not actionable, whether or not a review is pending', () => {
    const held = admissionActionability({ admissionHold: { reason: 'claimed re-review' } });
    const heldPending = admissionActionability({
      admissionHold: { reason: 'deferred: twin EI-2 is claimed' },
      admissionReview: { state: 'pending' },
    });
    expect(held).toMatchObject({ actionable: false, reason: expect.stringContaining('hold') });
    expect(heldPending).toMatchObject({ actionable: false, reason: expect.stringContaining('pending') });
  });

  it('unheld fail-open: a pending post-hoc review stays actionable with a caution', () => {
    expect(admissionActionability({ admissionReview: { state: 'pending' } })).toEqual({
      actionable: true,
      caution: expect.stringContaining('post-hoc duplicate review'),
    });
  });

  it('eligible control: a reviewed or plain row is actionable with no caution', () => {
    expect(admissionActionability({ admissionReview: { state: 'reviewed' }, admissionHold: null }))
      .toEqual({ actionable: true, caution: null });
    expect(admissionActionability(undefined)).toEqual({ actionable: true, caution: null });
  });

  it('the SQL floor reads the same field and the same inactive values as the JS twin', () => {
    const fragment = String(admissionHoldExclusionSql(fakeSql()));
    expect(fragment).toContain("wi.payload");
    expect(fragment).toContain("-> 'admissionHold'");
    expect(fragment).toMatch(/IN \('null'::jsonb, 'false'::jsonb\)/);
    expect(String(admissionHoldExclusionSql(fakeSql(), 'payload'))).toContain("COALESCE(payload, '{}'::jsonb)");
  });
});
