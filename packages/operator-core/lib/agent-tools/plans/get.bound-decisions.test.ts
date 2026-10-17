import { describe, it, expect } from 'vitest';
import {
  boundDecisionBodies,
  DECISION_BODY_CAP,
  DECISIONS_TOTAL_BUDGET,
} from './get';

/**
 * WI-274 — plans:get `sections` mode inlined ALL decision bodies in full, so a
 * decision-heavy plan (the round-4 plan: 17 decisions, several 1-2KB) returned
 * 56KB on one line and overflowed the agent tool-output cap. boundDecisionBodies
 * is the pure bound applied in sections mode (full mode keeps complete bodies).
 */
describe('boundDecisionBodies (WI-274 — plans:get sections-mode decision bound)', () => {
  it('returns a short body unchanged, with no truncation flags', () => {
    const dec = [{ id: 'D-001', title: 't', body: 'short body' }];
    const out = boundDecisionBodies(dec);
    expect(out[0]).toEqual(dec[0]);
    expect('body_truncated' in out[0]).toBe(false);
  });

  it('truncates a long body to the cap and stamps body_truncated + body_full_chars', () => {
    const long = 'x'.repeat(DECISION_BODY_CAP + 500);
    const out = boundDecisionBodies([{ id: 'D-001', title: 't', body: long }]);
    const d = out[0] as { body: string; body_truncated?: true; body_full_chars?: number };
    // n=1 → cap = min(CAP, floor(BUDGET/1)) = CAP
    expect(d.body.length).toBe(DECISION_BODY_CAP);
    expect(d.body_truncated).toBe(true);
    expect(d.body_full_chars).toBe(long.length);
  });

  it('keeps a body-only projection honest when sibling truncation flags are dropped', () => {
    const out = boundDecisionBodies([{ id: 'D-006', title: 't', body: 'x'.repeat(DECISION_BODY_CAP + 500) }]);
    const bodyOnly = out[0]!.body;
    expect(bodyOnly).toContain('TRUNCATED');
    expect(bodyOnly).toMatch(/\+\d+ chars/);
  });

  it('keeps TOTAL decision text bounded by the budget at ANY plan size (high n)', () => {
    const n = 100;
    const decisions = Array.from({ length: n }, (_, i) => ({
      id: `D-${i}`,
      title: 't',
      body: 'y'.repeat(2000),
    }));
    const out = boundDecisionBodies(decisions);
    const total = out.reduce((s, d) => s + d.body.length, 0);
    expect(total).toBeLessThanOrEqual(DECISIONS_TOTAL_BUDGET);
    // per-decision cap shrinks to floor(BUDGET/n) when n is large
    expect(out[0].body.length).toBe(Math.floor(DECISIONS_TOTAL_BUDGET / n));
    expect('body_truncated' in out[0]).toBe(true);
  });

  it('reproduces the WI-274 scenario: 17 long decisions stay well under the budget', () => {
    const decisions = Array.from({ length: 17 }, (_, i) => ({
      id: `D-${String(i + 1).padStart(3, '0')}`,
      title: 't',
      body: 'z'.repeat(2000),
    }));
    const out = boundDecisionBodies(decisions);
    const total = out.reduce((s, d) => s + d.body.length, 0);
    expect(total).toBeLessThanOrEqual(DECISIONS_TOTAL_BUDGET);
    // cap for n=17 = min(1000, floor(15000/17)=882) = 882
    expect(out[0].body.length).toBe(882);
  });

  it('handles an empty decision list', () => {
    expect(boundDecisionBodies([])).toEqual([]);
  });

  it('preserves all non-body fields when truncating', () => {
    const dec = {
      id: 'D-009',
      title: 'a title',
      body: 'w'.repeat(DECISION_BODY_CAP + 1),
      date: '2026-06-20',
      itemRefs: ['P-002'],
      lineNumber: 42,
    };
    const out = boundDecisionBodies([dec]);
    const d = out[0] as typeof dec & { body_truncated?: true };
    expect(d.id).toBe('D-009');
    expect(d.title).toBe('a title');
    expect(d.date).toBe('2026-06-20');
    expect(d.itemRefs).toEqual(['P-002']);
    expect(d.lineNumber).toBe(42);
    expect(d.body_truncated).toBe(true);
  });
});
