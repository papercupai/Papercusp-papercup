/**
 * The `changed` operator (state-plane-interest-and-hardening-2026-08-21 P-004).
 *
 * `changed` is the only BASELINE-relative op: it compares each observation to the
 * PREVIOUS one rather than to a caller-supplied operand. It exists because the
 * measured alternative was worse than merely awkward — expressing "wake me when
 * this moves" with `ne` requires transcribing the value's current reading into the
 * subscription, which races (a move landing between the read and the subscribe arms
 * the watch against a stale operand, and it then never fires).
 *
 * The tests that matter here are the two REFUSALS, not the match. A predicate watch
 * fires a WAKE, and this module's whole history is spurious-true regressions that
 * shipped green: `ne` firing on a null (WI-6279), every string operand round-tripping
 * to null so `ne` fired on the first poll (WI-6490). Both were false all-clears that
 * resumed an agent on a condition never established, and both survived because the
 * existing tests happened to use operands that dodged the bug. `changed` has exactly
 * one shape of that failure available to it — firing on its own registration eval,
 * when there is no baseline to have changed FROM — so that case is pinned first and
 * hardest, with a paired positive control proving the assertion can fail.
 */
import { describe, expect, it } from 'vitest';
import {
  comparePredicate,
  nextEvaluatorBaselines,
  nextObservationBaselines,
  PREDICATE_OPS,
  type EvaluatorBaseline,
  type PredicateBaseline,
  type PredicateOp,
} from './predicate-watch';

const noBaseline: PredicateBaseline = { established: false, value: undefined };
const from = (value: unknown): PredicateBaseline => ({ established: true, value });

describe('changed — the no-baseline refusal (the spurious-wake guard)', () => {
  it('NEVER fires before any evaluation has been recorded', () => {
    // This is the registration-time inline eval. Firing here would wake the caller
    // instantly and report a change that no observation established.
    expect(comparePredicate('abc123', 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate(0, 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate(false, 'changed', undefined, noBaseline)).toBe(false);
    expect(comparePredicate({ a: 1 }, 'changed', undefined, noBaseline)).toBe(false);
  });

  it('POSITIVE CONTROL — the same observations DO fire once a baseline exists', () => {
    // Without this, the assertions above would pass just as happily against an op
    // that can never fire at all, which is not what is being claimed.
    expect(comparePredicate('abc123', 'changed', undefined, from('def456'))).toBe(true);
    expect(comparePredicate(0, 'changed', undefined, from(1))).toBe(true);
    expect(comparePredicate(false, 'changed', undefined, from(true))).toBe(true);
    expect(comparePredicate({ a: 1 }, 'changed', undefined, from({ a: 2 }))).toBe(true);
  });

  it('treats an OMITTED baseline as no baseline (a caller that forgot to pass one)', () => {
    expect(comparePredicate('abc123', 'changed', undefined)).toBe(false);
    expect(comparePredicate('abc123', 'changed', undefined, undefined)).toBe(false);
  });

  it('distinguishes "never polled" from "polled and observed null" — the reason `established` is a separate flag', () => {
    // last_value is null in BOTH cases; only last_eval separates them. Collapsing
    // them would make a fresh row fire on its first real observation.
    expect(comparePredicate('a-sha', 'changed', undefined, { established: false, value: null })).toBe(false);
    expect(comparePredicate('a-sha', 'changed', undefined, { established: true, value: null })).toBe(true);
  });
});

describe('changed — the absent-observation refusal', () => {
  it('a value that became UNREADABLE is a loss of evidence, not an observed change', () => {
    expect(comparePredicate(undefined, 'changed', undefined, from('was-a-sha'))).toBe(false);
    expect(comparePredicate(null, 'changed', undefined, from('was-a-sha'))).toBe(false);
  });

  it('a MISSPELLED path (undefined forever) can never fire it', () => {
    // The WI-6279 shape: a typo'd path used to be a guaranteed instant false wake.
    expect(comparePredicate(undefined, 'changed', undefined, from(null))).toBe(false);
    expect(comparePredicate(undefined, 'changed', undefined, noBaseline)).toBe(false);
  });

  it('but a value APPEARING is a genuine change — the observation is present', () => {
    expect(comparePredicate('now-a-sha', 'changed', undefined, from(null))).toBe(true);
  });
});

describe('changed — steady state', () => {
  it('does not fire while the value is unchanged, including falsy and structural values', () => {
    expect(comparePredicate('same', 'changed', undefined, from('same'))).toBe(false);
    expect(comparePredicate(0, 'changed', undefined, from(0))).toBe(false);
    expect(comparePredicate(false, 'changed', undefined, from(false))).toBe(false);
    expect(comparePredicate({ a: 1, b: [2] }, 'changed', undefined, from({ a: 1, b: [2] }))).toBe(false);
  });

  it('IGNORES the `value` operand entirely — there is nothing to transcribe', () => {
    // The point of the op. A caller who passes an operand anyway must not be able to
    // change the outcome with it, or the transcription hazard is back through a side door.
    for (const operand of ['whatever', null, 0, { junk: true }]) {
      expect(comparePredicate('b', 'changed', operand, from('a'))).toBe(true);
      expect(comparePredicate('a', 'changed', operand, from('a'))).toBe(false);
    }
  });

  it('does not disturb the operand-relative ops', () => {
    // A baseline is now passed on EVERY comparison; no other op may read it.
    expect(comparePredicate('a', 'eq', 'a', from('zzz'))).toBe(true);
    expect(comparePredicate('a', 'ne', 'b', from('a'))).toBe(true);
    expect(comparePredicate(5, 'gt', 3, from(99))).toBe(true);
    expect(comparePredicate(null, 'ne', 'b', from('a'))).toBe(false);
    expect(comparePredicate('abc', 'contains', 'b', from('abc'))).toBe(true);
  });
});

describe('changed — registration', () => {
  it('is a member of PREDICATE_OPS, so both state:subscribe and watch:create accept it', () => {
    // Both tools build their zod enum from this array; the DB CHECK constraint
    // (migration 869) is widened to match.
    expect(PREDICATE_OPS).toContain('changed');
  });

  it('did not displace any existing op', () => {
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']) {
      expect(PREDICATE_OPS).toContain(op);
    }
  });
});

/**
 * EI-25217293871529814 — the RECORDER half of the absent-observation refusal.
 *
 * `comparePredicate` refuses to fire on an absent read, but evalPredicateWatch used to
 * SAVE that absent read as the evaluator's baseline (`value: null`, established). The
 * next present read then compared against null and fired `changed from null` while the
 * value never moved. Measured live: a git.pipelinePosition watch fired that way from
 * evaluator pid-252674@… while seven other evaluators all still held 'awaiting-gate'.
 *
 * `poll` replays evalPredicateWatch's own sequence (compare against THIS evaluator's
 * entry, then record via nextObservationBaselines), so these cases pin the pair.
 */
describe('changed — an absent read never becomes the baseline (EI-25217293871529814)', () => {
  type Baselines = Record<string, EvaluatorBaseline>;
  type Recorder = (prev: Baselines, key: string, op: PredicateOp, o: { eval: boolean; observed: unknown; at: string }) => Baselines;
  /** The pre-fix recorder, kept as a CONTROL: it saved every read, absent ones included. */
  const legacyRecorder: Recorder = (prev, key, _op, o) =>
    nextEvaluatorBaselines(prev, key, { eval: o.eval, value: o.observed === undefined ? null : o.observed, at: o.at });
  let clock = 0;
  const poll = (
    prev: Baselines,
    evaluator: string,
    observed: unknown,
    op: PredicateOp = 'changed',
    record: Recorder = nextObservationBaselines,
  ) => {
    const own = prev[evaluator];
    const matched = comparePredicate(observed, op, op === 'changed' ? undefined : 'x', {
      established: own !== undefined,
      value: own?.value,
    });
    const at = new Date(Date.UTC(2026, 9, 6, 8, 0, clock++)).toISOString();
    return { matched, next: record(prev, evaluator, op, { eval: matched, observed, at }) };
  };
  const run = (
    steps: Array<[evaluator: string, observed: unknown]>,
    start: Baselines = {},
    record: Recorder = nextObservationBaselines,
  ) => {
    let baselines = start;
    const fired: boolean[] = [];
    for (const [evaluator, observed] of steps) {
      const r = poll(baselines, evaluator, observed, 'changed', record);
      fired.push(r.matched);
      baselines = r.next;
    }
    return { fired, baselines };
  };

  it('CONTROL — the pre-fix recorder DOES false-fire on these exact sequences', () => {
    // Without this, the refusals below could pass against a sequence that never
    // exercised the defect at all.
    expect(run([['e1', 'awaiting-gate'], ['e1', null], ['e1', 'awaiting-gate']], {}, legacyRecorder).fired).toEqual([
      false,
      false,
      true,
    ]);
    expect(run([['e1', 'awaiting-gate'], ['e2', null], ['e2', 'awaiting-gate']], {}, legacyRecorder).fired).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('A → absent → A on one evaluator never fires (the measured false wake)', () => {
    for (const absent of [null, undefined]) {
      const { fired, baselines } = run([
        ['e1', 'awaiting-gate'],
        ['e1', absent],
        ['e1', 'awaiting-gate'],
      ]);
      expect(fired, `absent=${String(absent)}`).toEqual([false, false, false]);
      expect(baselines.e1.value).toBe('awaiting-gate');
    }
  });

  it('POSITIVE CONTROL — A → absent → B DOES fire, reporting A as the value it changed from', () => {
    const { fired, baselines } = run([
      ['e1', 'awaiting-gate'],
      ['e1', null],
    ]);
    const r = poll(baselines, 'e1', 'in-main');
    expect([...fired, r.matched]).toEqual([false, false, true]);
    // evalPredicateWatch reports `changedFrom: own?.value` — it must be the last PRESENT value.
    expect(baselines.e1.value).toBe('awaiting-gate');
  });

  it("a FRESH evaluator's absent first read is evidence loss while another evaluator holds a present value", () => {
    const { fired, baselines } = run([
      ['e1', 'awaiting-gate'],
      ['e2', null],
    ]);
    expect(fired).toEqual([false, false]);
    expect(baselines).not.toHaveProperty('e2');
    // Its first present read then establishes a baseline instead of firing.
    const r = poll(baselines, 'e2', 'awaiting-gate');
    expect(r.matched).toBe(false);
    expect(r.next.e2.value).toBe('awaiting-gate');
  });

  it('a value genuinely APPEARING still fires when nobody has seen a present value yet', () => {
    const { fired } = run([
      ['e1', null],
      ['e2', null],
      ['e1', 'now-a-sha'],
    ]);
    expect(fired).toEqual([false, false, true]);
  });

  it('refreshes eval/at on an absent read so the edge and recency stay honest', () => {
    const start: Baselines = { e1: { eval: true, value: 'a', at: '2026-10-06T07:00:00.000Z' } };
    const next = nextObservationBaselines(start, 'e1', 'changed', {
      eval: false,
      observed: null,
      at: '2026-10-06T08:00:00.000Z',
    });
    expect(next.e1).toEqual({ eval: false, value: 'a', at: '2026-10-06T08:00:00.000Z' });
  });

  it('leaves operand-relative ops recording the observation exactly as before', () => {
    // `eq value:null` is the documented way to ask "is it UNKNOWN": its entry must
    // record the absent read, or the per-evaluator edge would be lost.
    const start: Baselines = { e1: { eval: false, value: 'a', at: '2026-10-06T07:00:00.000Z' } };
    for (const op of ['eq', 'ne', 'exists'] as const) {
      const fresh = nextObservationBaselines(start, 'e2', op, { eval: true, observed: null, at: '2026-10-06T08:00:00.000Z' });
      expect(fresh.e2, op).toEqual({ eval: true, value: null, at: '2026-10-06T08:00:00.000Z' });
      const own = nextObservationBaselines(start, 'e1', op, { eval: true, observed: undefined, at: '2026-10-06T08:00:00.000Z' });
      expect(own.e1, op).toEqual({ eval: true, value: null, at: '2026-10-06T08:00:00.000Z' });
    }
  });
});
