/**
 * mergeKindIntoClaimSpec must be IDEMPOTENT — reported by the `nonp2p-bug-drain` fleet leader
 * (su-b8422496) against the live spec on 2026-08-09.
 *
 * The merge runs again on every relaunch/top-up of a fleet whose leader authored a claim spec. It
 * appended the kind leaf unconditionally, so two launch-on-plan calls carrying claimKinds:['bug']
 * left rev7 holding the identical {field:'kind',op:'in',value:['bug']} clause THREE times. An AND of
 * identical predicates is semantically idempotent — nothing misbehaved, which is precisely why it
 * would have accreted silently until the spec was a wall of duplicates that no one auditing the lane
 * for scope drift could read.
 */
import { describe, it, expect } from 'vitest';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from '../../scheduler/claim-spec-match';
import { mergeKindIntoClaimSpec } from './launch-on-plan';

const KIND_BUG = { field: 'kind', op: 'in', value: ['bug'] };
const FENCE = { not: { any: [{ field: 'title', op: 'word', value: 'p2p' }] } };

const spec = (filter: unknown, over: Record<string, unknown> = {}) =>
  ({ specVersion: '1.0', specId: 'nonp2p-bug-drain', revision: 5, view: { filter }, rank: { mode: 'lexicographic', terms: [] }, ...over }) as never;

const clausesOf = (merged: Record<string, unknown>) =>
  ((merged.view as { filter: { all?: unknown[] } }).filter.all ?? []) as Record<string, unknown>[];

const countKindLeaves = (merged: Record<string, unknown>) =>
  clausesOf(merged).filter((c) => c.field === 'kind').length;

const subject = (over: Partial<ClaimSpecSubject>): ClaimSpecSubject => ({
  id: 'fleet-friction-remediation-2026-08-21#P-006',
  title: 'Repair claim-spec family collapse',
  summary: '',
  kind: 'feature',
  priority: null,
  tags: [],
  paths: [],
  plan: 'fleet-friction-remediation-2026-08-21',
  planItem: ['P-006'],
  fleet: null,
  triageGate: null,
  itemClass: 'work',
  age: 0,
  riskTier: null,
  redundancy: 1,
  estCost: null,
  assignee: null,
  severity: null,
  goal: null,
  ...over,
});

describe('mergeKindIntoClaimSpec — idempotence', () => {
  it('does not duplicate the kind leaf when merged twice (the reported rev5→rev7 defect)', () => {
    const rev6 = mergeKindIntoClaimSpec(spec({ all: [KIND_BUG, FENCE] }), ['bug']);
    const rev7 = mergeKindIntoClaimSpec(rev6 as never, ['bug']);
    expect(countKindLeaves(rev6)).toBe(1);
    expect(countKindLeaves(rev7)).toBe(1);
  });

  it('stays flat across MANY merges — the unbounded-growth shape the leader warned about', () => {
    let s = spec({ all: [KIND_BUG, FENCE] });
    for (let i = 0; i < 6; i += 1) s = mergeKindIntoClaimSpec(s as never, ['bug']) as never;
    expect(clausesOf(s as never)).toHaveLength(2); // the kind leaf + the fence, no matter how many merges
  });

  it('PRESERVES the leader-authored fence — dedupe must not become a clobber', () => {
    const merged = mergeKindIntoClaimSpec(spec({ all: [KIND_BUG, FENCE] }), ['bug']);
    expect(clausesOf(merged)).toContainEqual(FENCE);
  });

  it('still ADDS the kind leaf when the existing filter lacks it', () => {
    const merged = mergeKindIntoClaimSpec(spec({ all: [FENCE] }), ['bug']);
    expect(countKindLeaves(merged)).toBe(1);
    expect(clausesOf(merged)).toContainEqual(FENCE);
  });

  it('keeps the { all: [...] } shape even when dedupe leaves a single clause', () => {
    // A bare leaf would hide a positive-ID cohort from the positiveIdCohortIds extractor, which only
    // recognizes them as direct members of a top-level `all` (false windDown).
    const merged = mergeKindIntoClaimSpec(spec({ all: [KIND_BUG] }), ['bug']);
    expect((merged.view as { filter: Record<string, unknown> }).filter).toHaveProperty('all');
    expect(clausesOf(merged)).toHaveLength(1);
  });

  it('treats a DIFFERENT kind set as a distinct clause — dedupe must not silently narrow a lane', () => {
    const merged = mergeKindIntoClaimSpec(spec({ all: [KIND_BUG, FENCE] }), ['change']);
    expect(countKindLeaves(merged)).toBe(2);
  });

  it('bumps the revision on every merge', () => {
    expect(mergeKindIntoClaimSpec(spec({ all: [KIND_BUG] }), ['bug']).revision).toBe(6);
  });

  it('is unaffected for an empty existing filter (kind leaf becomes the whole filter)', () => {
    const merged = mergeKindIntoClaimSpec(spec({}), ['bug']);
    expect((merged.view as { filter: unknown }).filter).toEqual(KIND_BUG);
  });

  it('canonicalizes plan-scoped kind leaves without collapsing the feature family (EI-220428)', () => {
    const planAllowlist = {
      any: [
        { field: 'plan', op: '=', value: 'fleet-friction-remediation-2026-08-21' },
        { field: 'goal', op: '=', value: 'work-on-everything-070565' },
      ],
    };
    const broadKinds = { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'chunk', 'feature'] };
    const merged = mergeKindIntoClaimSpec(
      spec({
        all: [
          planAllowlist,
          broadKinds,
          { field: 'kind', op: 'in', value: ['change', 'task', 'bug'] },
          { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
          FENCE,
        ],
      }),
      ['bug', 'change', 'task'],
    );

    expect(countKindLeaves(merged)).toBe(1);
    expect(clausesOf(merged)).toContainEqual(broadKinds);
    expect(clausesOf(merged)).toContainEqual(FENCE);

    const filter = (merged.view as { filter: never }).filter;
    expect(matchesClaimSpecFilter(subject({}), filter)).toBe(true);
    expect(matchesClaimSpecFilter(subject({ title: 'P2P relay parity repair' }), filter)).toBe(false);
    expect(matchesClaimSpecFilter(subject({ plan: 'unrelated-plan' }), filter)).toBe(false);
  });
});

/**
 * FALSIFIABILITY CONTROL — kept permanently. `appendAlways` is the shipped behaviour that produced
 * the triple clause. Asserting it still grows proves these tests discriminate rather than passing
 * against any implementation.
 */
describe('falsifiability control', () => {
  it('the append-always rule DOES grow without bound on the same input', () => {
    let clauses = [KIND_BUG, FENCE] as unknown[];
    for (let i = 0; i < 6; i += 1) clauses = [...clauses, KIND_BUG];
    expect(clauses.filter((c) => (c as Record<string, unknown>).field === 'kind')).toHaveLength(7);

    let s = spec({ all: [KIND_BUG, FENCE] });
    for (let i = 0; i < 6; i += 1) s = mergeKindIntoClaimSpec(s as never, ['bug']) as never;
    expect(countKindLeaves(s as never)).toBe(1); // ...and the real one does not
  });
});
