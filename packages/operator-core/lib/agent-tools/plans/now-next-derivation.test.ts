import { describe, it, expect } from 'vitest';
import { reconcileNowNext, reconcileNowState, DERIVED_NEXT_MARK } from './now-next-derivation';
import type { ItemStatus, PlanItem } from '@papercusp/plan-parser';

/**
 * now-next-derivation.test.ts — P-002 of
 * deterministic-plan-state-derivation-2026-08-31.
 *
 * The contract under test is a JURISDICTION rule, so the tests are organised
 * around it: the derivation supersedes the author's stored pointer when, and
 * only when, every plan item that pointer names is already terminal. Every
 * supersede assertion is therefore PAIRED with a pass-through control that
 * differs in exactly one field — because the expensive failure here is not
 * "we missed a stale pointer", it is "we destroyed a good one".
 */

const item = (id: string, storedStatus: ItemStatus, extra: Partial<PlanItem> = {}): PlanItem => ({
  id,
  text: `${id} body`,
  storedStatus,
  importance: 'normal',
  riskTier: null,
  authority: 'system',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id} body`,
  ...extra,
});

describe('reconcileNowState — EI-25279424848174951 lifecycle narration', () => {
  const stored = 'P-001 done; P-002 remains open; P-003/full eleven-consumer reconciliation remains open.';

  it('rechecks the same authored State after an item becomes terminal', () => {
    const open = [item('P-001', 'done'), item('P-002', 'todo'), item('P-003', 'todo')];
    expect(reconcileNowState(stored, open).state).toBe(stored);
    const completed = [item('P-001', 'done'), item('P-002', 'done'), item('P-003', 'todo')];
    const result = reconcileNowState(stored, completed);
    expect(result.contradictions).toEqual([expect.objectContaining({ id: 'P-002', status: 'done' })]);
    expect(result.state.startsWith('⟳ current item status — P-002 [done].')).toBe(true);
    expect(result.state.endsWith(stored)).toBe(true);
    expect(result.storedState).toBe(stored);
    expect(completed[2].storedStatus).toBe('todo');
  });

  it('leaves the corrected scoped adoption and outstanding consumer work unchanged', () => {
    const corrected = 'P-002 scoped adoption is DONE/COMMITTED (WI-10006495); P-003/full eleven-consumer reconciliation remains open.';
    const result = reconcileNowState(corrected, [item('P-002', 'done'), item('P-003', 'todo')]);
    expect(result.state).toBe(corrected);
    expect(result.warning).toBeNull();
    expect(result.contradictions).toEqual([]);
  });

  it('discloses a dropped item without turning it into completion proof', () => {
    const result = reconcileNowState('P-002 remains open.', [item('P-002', 'dropped')]);
    expect(result.warning).toContain('P-002 [dropped]');
    expect(result.warning).not.toContain('[done]');
  });

  it('does not infer terminal status from an effective block or unmeasured item', () => {
    expect(reconcileNowState('P-002 remains open.', [item('P-002', 'blocked')]).warning).toBeNull();
    expect(reconcileNowState('P-002 remains open.', []).warning).toBeNull();
    expect(reconcileNowState('Source admission is uncertified.', [item('P-002', 'done')]).warning).toBeNull();
  });

  it('preserves a foreign plan citation, historical quote and surrounding whitespace', () => {
    const citation = '  other-plan-2026-01-01 P-002 remains open.  ';
    expect(reconcileNowState(citation, [item('P-002', 'done')], 'this-plan-2026-01-01').state).toBe(citation);
    const historical = 'The old State said "P-002 remains open"; P-002 is done.';
    expect(reconcileNowState(historical, [item('P-002', 'done')]).state).toBe(historical);
  });
});

describe('reconcileNowNext — supersede exactly the measured failure class', () => {
  it('SUPERSEDES a pointer whose every named item is terminal', () => {
    // The 89-live-plans class: `next:` still says "do P-001" long after P-001
    // shipped. This is the whole reason the module exists.
    const r = reconcileNowNext('P-001 — implement the guard.', [
      item('P-001', 'done'),
      item('P-002', 'todo'),
    ]);
    expect(r.disposition).toBe('superseded');
    expect(r.staleStoredRefs).toEqual([{ id: 'P-001', status: 'done' }]);
    expect(r.next).toContain(DERIVED_NEXT_MARK);
    expect(r.next).toContain('P-002'); // the derived pointer names live work
  });

  it('CONTROL: the same pointer is RATIFIED while P-001 is still todo', () => {
    // One field differs — P-001's storedStatus — and the disposition flips.
    const r = reconcileNowNext('P-001 — implement the guard.', [
      item('P-001', 'todo'),
      item('P-002', 'todo'),
    ]);
    expect(r.disposition).toBe('ratified');
    expect(r.next).toBe('P-001 — implement the guard.');
    expect(r.staleStoredRefs).toEqual([]);
  });

  it('supersedes only when EVERY named item is terminal, not when any is', () => {
    // A Now block routinely records one item's completion while directing the
    // next: "P-001 landed; pick up P-002." Superseding that would be a
    // regression, so the rule is universal, not existential.
    const r = reconcileNowNext('P-001 landed; pick up P-002.', [
      item('P-001', 'done'),
      item('P-002', 'todo'),
    ]);
    expect(r.disposition).toBe('ratified');
    expect(r.next).toBe('P-001 landed; pick up P-002.');
    // The stale ref is still REPORTED — the reader is told, without the prose
    // being rewritten out from under them.
    expect(r.staleStoredRefs).toEqual([{ id: 'P-001', status: 'done' }]);
  });

  it('CONTROL: once P-002 is also done, that same prose IS superseded', () => {
    const r = reconcileNowNext('P-001 landed; pick up P-002.', [
      item('P-001', 'done'),
      item('P-002', 'done'),
    ]);
    expect(r.disposition).toBe('superseded');
    expect(r.staleStoredRefs).toHaveLength(2);
  });

  it('preserves the author’s words verbatim when it supersedes', () => {
    // Prepend-only: the derived verdict leads, the
    // typed line survives beneath it. Nothing is destroyed on a read.
    const prose = 'P-001 — smallest change, highest value (45 items advertise pickable work).';
    const r = reconcileNowNext(prose, [item('P-001', 'done'), item('P-002', 'todo')]);
    expect(r.next).toContain(prose);
    expect(r.storedNext).toBe(prose);
  });
});

describe('reconcileNowNext — the residual: a stale DIRECTIVE beside a live mention', () => {
  // Found by running the module over the live corpus, not by reasoning:
  // `silent-wrong-answers-2026-08-01` reads "Start P-015 …" where P-015 had
  // shipped, and survives the universal supersede rule because it also
  // mentions live items. Append a caution; never replace.
  it('cautions when the pointer still DIRECTS work at a terminal item', () => {
    const r = reconcileNowNext('Start P-015, then look at P-020.', [
      item('P-015', 'done'),
      item('P-020', 'todo'),
    ]);
    expect(r.disposition).toBe('ratified');
    expect(r.contradictions.map((c) => c.id)).toEqual(['P-015']);
    expect(r.next).toContain('Start P-015, then look at P-020.'); // append-only
    expect(r.next).toContain('caution');
    expect(r.next).toContain('P-015 [done]');
  });

  it('CONTROL: a completion NOTE about the same terminal item draws no caution', () => {
    // "P-015 landed; pick up P-020" is the overwhelmingly common shape. If the
    // caution fired here it would be noise on hundreds of correct pointers —
    // this control is what keeps the classifier honest rather than trigger-happy.
    const r = reconcileNowNext('P-015 landed; pick up P-020.', [
      item('P-015', 'done'),
      item('P-020', 'todo'),
    ]);
    expect(r.disposition).toBe('ratified');
    expect(r.contradictions).toEqual([]);
    expect(r.next).toBe('P-015 landed; pick up P-020.');
  });

  it('reports no contradictions on the dispositions where they cannot apply', () => {
    for (const [stored, items] of [
      ['Start P-015.', [item('P-015', 'done')]], // superseded — replaced, not cautioned
      ['Ship it.', [item('P-015', 'todo')]], // unverifiable
      ['', [item('P-015', 'todo')]], // filled
      ['Start P-015.', []], // abstained
    ] as Array<[string, PlanItem[]]>) {
      expect(reconcileNowNext(stored, items).contradictions).toEqual([]);
    }
  });

  it('scopes the caution to THIS plan — a foreign plan-slug citation is not a contradiction', () => {
    const r = reconcileNowNext('Start P-015; see other-plan-2026-01-01 P-020 for context.', [
      item('P-015', 'todo'),
      item('P-020', 'done'),
    ]);
    expect(r.contradictions).toEqual([]);
    expect(r.next).toBe('Start P-015; see other-plan-2026-01-01 P-020 for context.');
  });
});

describe('reconcileNowNext — where the graph has no jurisdiction', () => {
  it('passes through prose that names no plan item, as unverifiable', () => {
    // "Run the acceptance grading" is about something that is not a plan item.
    // A drained graph must not overwrite it.
    const r = reconcileNowNext('Run the acceptance grading, then ship.', [
      item('P-001', 'done'),
    ]);
    expect(r.disposition).toBe('unverifiable');
    expect(r.next).toBe('Run the acceptance grading, then ship.');
  });

  it('CONTROL: the same drained graph DOES supersede prose that names its item', () => {
    const r = reconcileNowNext('Finish P-001, then ship.', [item('P-001', 'done')]);
    expect(r.disposition).toBe('superseded');
  });

  it('ignores a P-NNN that belongs to ANOTHER plan', () => {
    // A citation of some other plan's P-003 is not a claim about this graph;
    // treating it as one would manufacture a contradiction out of a reference.
    const r = reconcileNowNext('Blocked behind other-plan-2026-01-01 P-003.', [
      item('P-001', 'done'),
    ]);
    expect(r.disposition).toBe('unverifiable');
    expect(r.staleStoredRefs).toEqual([]);
  });

  it('CONTROL: a P-003 this plan DOES define is checked', () => {
    const r = reconcileNowNext('Blocked behind other-plan-2026-01-01 P-003.', [
      item('P-001', 'done'),
      item('P-003', 'dropped'),
    ]);
    expect(r.disposition).toBe('superseded');
    expect(r.staleStoredRefs).toEqual([{ id: 'P-003', status: 'dropped' }]);
  });

  it('abstains on a plan with no items rather than declaring it drained', () => {
    const r = reconcileNowNext('Author the items.', []);
    expect(r.disposition).toBe('abstained');
    expect(r.next).toBe('Author the items.');
    expect(r.derived.reason).toBe('no-items');
  });

  it('CONTROL: one item is enough for the graph to speak', () => {
    const r = reconcileNowNext('Author the items.', [item('P-001', 'todo')]);
    expect(r.disposition).toBe('unverifiable');
    expect(r.derived.reason).toBe('actionable');
  });
});

describe('reconcileNowNext — filling a blank pointer', () => {
  it('fills an empty stored pointer from the graph', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const r = reconcileNowNext(blank, [item('P-001', 'done'), item('P-002', 'todo')]);
      expect(r.disposition).toBe('filled');
      expect(r.next).toContain('P-002');
    }
  });

  it('fills a blank pointer on a DRAINED plan with the honest "nothing left"', () => {
    const r = reconcileNowNext('', [item('P-001', 'done')]);
    expect(r.disposition).toBe('filled');
    expect(r.next).toContain('every item is terminal');
    expect(r.next).not.toMatch(/P-\d{3,}/);
  });

  it('does not invent a pointer for a plan with no items at all', () => {
    const r = reconcileNowNext('', []);
    expect(r.disposition).toBe('abstained');
    expect(r.next).toBe('');
  });
});

describe('reconcileNowNext — the derivation always travels', () => {
  it('attaches the graph verdict on EVERY disposition, including pass-throughs', () => {
    // A pass-through that was never checked and one that was checked and
    // ratified are indistinguishable unless the verdict is shown. This is what
    // makes the whole overlay auditable rather than trust-me.
    const cases: Array<[string, PlanItem[]]> = [
      ['P-001 — go.', [item('P-001', 'todo')]], // ratified
      ['Ship it.', [item('P-001', 'todo')]], // unverifiable
      ['P-001 — go.', [item('P-001', 'done'), item('P-002', 'todo')]], // superseded
      ['', [item('P-001', 'todo')]], // filled
      ['anything', []], // abstained
    ];
    for (const [stored, items] of cases) {
      const r = reconcileNowNext(stored, items);
      expect(r.derived).toBeDefined();
      expect(r.derived.reason).toBeTruthy();
      expect(r.derived.counts.total).toBe(items.length);
      expect(r.storedNext).toBe(stored.trim());
    }
  });

  it('is a pure function — repeated calls agree and the items are unmutated', () => {
    const items = [item('P-001', 'done'), item('P-002', 'todo')];
    const snapshot = JSON.stringify(items);
    const a = reconcileNowNext('P-001 — go.', items);
    const b = reconcileNowNext('P-001 — go.', items);
    expect(a).toEqual(b);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanent, in-suite (tier 1 of the repo's
 * mutation-probe guidance: a deliberately-wrong implementation kept in the
 * test file, never an in-tree mutation of the real module).
 *
 * The two mutants are the two ways this module can plausibly be got wrong,
 * and they fail in OPPOSITE directions — one destroys good pointers, the
 * other never fixes a stale one. Each is paired with a calibration assertion
 * that the real implementation gets that same case right.
 */
describe('reconcileNowNext — falsifiability controls', () => {
  /** Mutant A: always take the derived pointer (destroys curated rationale). */
  const alwaysDerived = (stored: string, items: PlanItem[]) =>
    reconcileNowNext(stored, items).derived.text;
  /** Mutant B: always keep the stored pointer (the pre-P-002 behaviour). */
  const alwaysStored = (stored: string) => stored;

  it('a keep-stored mutant is CAUGHT by the stale case (and the real one fixes it)', () => {
    const stored = 'P-001 — implement the guard.';
    const items = [item('P-001', 'done'), item('P-002', 'todo')];
    // Calibration: the real implementation supersedes here.
    expect(reconcileNowNext(stored, items).next).not.toBe(stored);
    // Control: the pre-P-002 behaviour hands back the stale line unchanged.
    expect(alwaysStored(stored)).toBe(stored);
  });

  it('an always-derived mutant is CAUGHT by the ratified case (and the real one preserves it)', () => {
    const stored = 'P-001 — smallest change, highest value.';
    const items = [item('P-001', 'todo'), item('P-002', 'todo')];
    // Calibration: the real implementation preserves the author's rationale.
    expect(reconcileNowNext(stored, items).next).toBe(stored);
    // Control: the blunt fix would have thrown that rationale away.
    expect(alwaysDerived(stored, items)).not.toBe(stored);
  });

  it('an always-derived mutant is CAUGHT by the unverifiable case', () => {
    const stored = 'Run the acceptance grading, then ship.';
    const items = [item('P-001', 'done')];
    expect(reconcileNowNext(stored, items).next).toBe(stored);
    expect(alwaysDerived(stored, items)).not.toBe(stored);
  });
});
