/**
 * EI-15185 regression: a fleet member's `events:await { event:
 * 'work-item:claimable' }` fired on system-wide releases outside its claim-spec
 * scope because there was no way to derive a `payload_filter` from the spec.
 *
 * `claimSpecFilterToClaimablePayloadFilter` closes that gap. This suite pins:
 *   1. the translated DataCondition shapes for the payload-mapped fields;
 *   2. the reproduction — the exact wasted wakes (a p2p bug title, an unrelated
 *      tracking issue) no longer match, while genuine in-scope work still does;
 *   3. SOUNDNESS — for a spec that filters only on payload-visible fields, the
 *      derived filter matches a claimable payload IFF the claim spec would admit
 *      the item (no over-suppression: it must never miss a real wake);
 *   4. the permissive drops (non-payload fields, relational ops, OR arms, NOT of
 *      an inexact subtree) collapse to `undefined` — an unscoped await, which the
 *      miss advice then declines to recommend.
 */
import { describe, expect, it } from 'vitest';
import { claimSpecFilterToClaimablePayloadFilter } from './claim-spec-payload-filter';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from './claim-spec-match';
import { payloadMatchesFilter } from '../events/await/pattern';
import type { FilterNode } from './claim-spec';

/** A `work-item:claimable` event payload (see emitWorkItemClaimableEvent). */
function payloadOf(p: {
  id?: string;
  kind?: string;
  title?: string;
  summary?: string | null;
  assignee?: string | null;
  plan?: string | null;
  tags?: string[];
  goal?: string | null;
}): Record<string, unknown> {
  return {
    id: p.id ?? 'X-1',
    kind: p.kind ?? 'task',
    severity: null,
    harness: null,
    title: p.title ?? '',
    summary: p.summary ?? null,
    assignee: p.assignee ?? null,
    state: 'todo',
    reason: 'created',
    plan: p.plan ?? null,
    tags: p.tags ?? [],
    goal: p.goal ?? null,
  };
}

/** A ClaimSpecSubject agreeing with `payloadOf` on the payload-visible fields. */
function subjectOf(p: {
  id?: string;
  kind?: string;
  title?: string;
  summary?: string | null;
  plan?: string | null;
  tags?: string[];
  goal?: string | null;
}): ClaimSpecSubject {
  return {
    id: p.id ?? 'X-1',
    title: p.title ?? '',
    summary: p.summary ?? null,
    kind: p.kind ?? 'task',
    priority: null,
    tags: p.tags ?? [],
    paths: [],
    plan: p.plan ?? null,
    planItem: [],
    fleet: null,
    triageGate: null,
    itemClass: 'work',
    age: null,
    riskTier: null,
    redundancy: null,
    estCost: null,
    assignee: null,
    severity: null,
    goal: p.goal ?? null,
  };
}

describe('summary-scoped member wakes (EI-27692065520622700)', () => {
  const plan = 'green-main-ratchet-convergence-2026-10-17';
  const filter: FilterNode = {
    all: [
      { any: [
        { field: 'plan', op: '=', value: plan },
        { field: 'id', op: '=', value: 'WI-PREP' },
        { field: 'summary', op: 'glob', value: `*${plan}*` },
      ] },
      { not: { field: 'id', op: 'in', value: ['WI-HELD', 'WI-GATE'] } },
    ],
  };

  it.each([
    ['body-only lane', { summary: `Plan ${plan}: independent source preparation` }, true],
    ['case-insensitive body', { summary: plan.toUpperCase() }, true],
    ['plan linkage', { plan }, true],
    ['known id', { id: 'WI-PREP' }, true],
    ['unrelated area', { plan: 'another-plan', summary: 'another area' }, false],
    ['missing summary', {}, false],
    ['null summary', { summary: null }, false],
    ['empty summary', { summary: '' }, false],
    ['excluded body match', { id: 'WI-HELD', summary: plan }, false],
    ['excluded plan match', { id: 'WI-GATE', plan }, false],
  ] as const)('%s', (_label, item, expected) => {
    expect(matchesClaimSpecFilter(subjectOf(item), filter)).toBe(expected);
    expect(payloadMatchesFilter(claimSpecFilterToClaimablePayloadFilter(filter), payloadOf(item))).toBe(expected);
  });

  it('preserves summary leaf and NOT semantics across empty, absent and literal text', () => {
    const filters: FilterNode[] = [
      { field: 'summary', op: '=', value: 'lane' },
      { field: 'summary', op: '!=', value: 'lane' },
      { field: 'summary', op: 'in', value: ['lane', ''] },
      { field: 'summary', op: 'glob', value: '*LANE*' },
      { field: 'summary', op: 'contains', value: 'lane.[x]' },
      { field: 'summary', op: 'word', value: 'lane' },
      { not: { field: 'summary', op: 'contains', value: 'LANE' } },
      { not: filter },
    ];
    for (const current of filters) {
      const translated = claimSpecFilterToClaimablePayloadFilter(current);
      expect(translated).toBeDefined();
      for (const item of [{}, { summary: null }, { summary: '' }, { summary: 'lane' },
        { summary: 'LANE.[x]' }, { summary: 'lane_prep' }, { summary: 'airplane' }]) {
        expect(payloadMatchesFilter(translated, payloadOf(item)), JSON.stringify({ current, item }))
          .toBe(matchesClaimSpecFilter(subjectOf(item), current));
      }
    }
  });
});

describe('claimSpecFilterToClaimablePayloadFilter — translated shapes', () => {
  it('empty / undefined filter → undefined (no narrowing)', () => {
    expect(claimSpecFilterToClaimablePayloadFilter(undefined)).toBeUndefined();
  });

  it('kind `in` → { kind: { in: [...] } }', () => {
    const f: FilterNode = { field: 'kind', op: 'in', value: ['feature', 'chunk'] };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ kind: { in: ['feature', 'chunk'] } });
  });

  it('plan `=` → { plan: { equals } }', () => {
    const f: FilterNode = { field: 'plan', op: '=', value: 'drain-plan' };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ plan: { equals: 'drain-plan' } });
  });

  it('goal `=` → { goal: { equals } }', () => {
    const f: FilterNode = { field: 'goal', op: '=', value: 'goal-drain' };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ goal: { equals: 'goal-drain' } });
  });

  it('assignee `=` remains payload-filterable via the claimable null snapshot', () => {
    const f: FilterNode = { field: 'assignee', op: '=', value: 'agent-self' };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ assignee: { equals: 'agent-self' } });
  });

  it('preserves assignee inside a nested ALL instead of dropping it before an outer ANY', () => {
    const f: FilterNode = {
      any: [
        {
          all: [
            { field: 'assignee', op: '=', value: 'agent-self' },
            { field: 'kind', op: 'in', value: ['bug', 'change'] },
          ],
        },
        { field: 'id', op: 'in', value: ['WI-10000606'] },
      ],
    };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({
      any: [
        {
          all: [
            { assignee: { equals: 'agent-self' } },
            { kind: { in: ['bug', 'change'] } },
          ],
        },
        { id: { in: ['WI-10000606'] } },
      ],
    });
  });

  it('ANY(goal, id) keeps both payload-visible arms instead of collapsing to undefined', () => {
    const f: FilterNode = {
      any: [
        { field: 'goal', op: '=', value: 'goal-drain' },
        { field: 'id', op: 'in', value: ['WI-2183', 'EI-2183'] },
      ],
    };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({
      any: [{ goal: { equals: 'goal-drain' } }, { id: { in: ['WI-2183', 'EI-2183'] } }],
    });
  });

  it('NOT title glob → { not: { title: { matches } } } mirroring the spec globRegex', () => {
    const f: FilterNode = { not: { field: 'title', op: 'glob', value: '*p2p*' } };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({
      not: { title: { matches: { source: '^.*p2p.*$', flags: 'i' } } },
    });
  });

  it('contains → case-insensitive literal-substring matches', () => {
    const f: FilterNode = { field: 'title', op: 'contains', value: 'p2p' };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ title: { matches: { source: 'p2p', flags: 'i' } } });
  });

  it('NOT title word → { not: { title: { matches } } } mirroring the spec wordBoundaryRegex (EI-18690730909662985)', () => {
    const f: FilterNode = { not: { field: 'title', op: 'word', value: 'p2p' } };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({
      not: { title: { matches: { source: '(?<![A-Za-z0-9])p2p(?![A-Za-z0-9])', flags: 'i' } } },
    });
  });

  // Pin the BEHAVIOUR, not just the literal source above: a pinned string alone
  // let the `\b` boundary look correct while silently failing on snake_case.
  // `\b` counts `_` as a word char, so `\breplication\b` missed "replication_soak"
  // — the blind spot that leaked WI-5639 into a non-P2P fleet.
  it('the translated word regex treats `_` as a boundary and still rejects intra-word hits', () => {
    const f: FilterNode = { field: 'title', op: 'word', value: 'replication' };
    const out = claimSpecFilterToClaimablePayloadFilter(f) as {
      title: { matches: { source: string; flags: string } };
    };
    const re = new RegExp(out.title.matches.source, out.title.matches.flags);

    expect(re.test('replication_soak: recovery misses 90s SLA')).toBe(true);
    expect(re.test('[replication-liveness] no_replicator')).toBe(true);
    expect(re.test('replication')).toBe(true);
    // Still a WHOLE-word match: no bare-substring false positives.
    expect(re.test('bioreplicationary drift')).toBe(false);
    expect(re.test('Fix dashboard pagination off-by-one')).toBe(false);
  });

  it('relational op on a payload field is dropped permissively → undefined', () => {
    // (< <= > >= only target numeric non-payload fields; dropping is sound.)
    const f: FilterNode = { field: 'id', op: '>', value: 5 };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toBeUndefined();
  });

  it('a leaf on a non-payload field (plan_item / paths / priority) is dropped → undefined', () => {
    expect(claimSpecFilterToClaimablePayloadFilter({ field: 'plan_item', op: 'in', value: ['P-001'] })).toBeUndefined();
    expect(claimSpecFilterToClaimablePayloadFilter({ field: 'paths', op: 'contains', value: 'x' })).toBeUndefined();
    expect(claimSpecFilterToClaimablePayloadFilter({ field: 'priority', op: '<', value: 10 })).toBeUndefined();
  });

  it('EI-14161: tags is now payload-filterable — `contains` maps to EXACT membership (equals), not a substring regex', () => {
    const f: FilterNode = { field: 'tags', op: 'contains', value: 'p2p' };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ tags: { equals: 'p2p' } });
  });

  it('EI-14161: `not(tags contains p2p)` narrows exactly (contains-on-tags is an exact leaf, so NOT is safe)', () => {
    const f: FilterNode = { not: { field: 'tags', op: 'contains', value: 'p2p' } };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ not: { tags: { equals: 'p2p' } } });
  });

  it('EI-14161: tags `in` / `!=` translate like any other field (mingo already does implicit array matching)', () => {
    expect(claimSpecFilterToClaimablePayloadFilter({ field: 'tags', op: 'in', value: ['p2p', 'rig'] })).toEqual({
      tags: { in: ['p2p', 'rig'] },
    });
    expect(claimSpecFilterToClaimablePayloadFilter({ field: 'tags', op: '!=', value: 'p2p' })).toEqual({
      tags: { notEquals: 'p2p' },
    });
  });

  it('ALL keeps the payload-visible child, drops the non-payload one', () => {
    const f: FilterNode = {
      all: [
        { field: 'kind', op: '=', value: 'feature' },
        { field: 'plan_item', op: 'in', value: ['P-001'] },
      ],
    };
    // Only the kind leaf survives (a sound superset — get_next still enforces plan_item).
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toEqual({ kind: { equals: 'feature' } });
  });

  it('ANY with a non-narrowable arm collapses to undefined (cannot narrow an OR)', () => {
    const f: FilterNode = {
      any: [
        { field: 'plan', op: '=', value: 'A' },
        { field: 'paths', op: 'contains', value: 'x' },
      ],
    };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toBeUndefined();
  });

  it('NOT of an inexact subtree drops to undefined (would under-cover the admit-set)', () => {
    const f: FilterNode = { not: { field: 'plan_item', op: 'in', value: ['P-001'] } };
    expect(claimSpecFilterToClaimablePayloadFilter(f)).toBeUndefined();
  });
});

describe('EI-15185 reproduction — the wasted wakes stop, real work still wakes', () => {
  // The plan-drain fleet's spec: coding work only, excluding the *p2p* title class
  // that fired EI-128 (a p2p-perf bug) every few minutes.
  const spec: FilterNode = {
    all: [
      { field: 'kind', op: 'in', value: ['feature', 'chunk'] },
      { not: { field: 'title', op: 'glob', value: '*p2p*' } },
    ],
  };
  const derived = claimSpecFilterToClaimablePayloadFilter(spec);

  it('derives a non-empty, scoped payload_filter (not the unscoped await)', () => {
    expect(derived).toBeDefined();
  });

  it('an in-scope claimable item WOULD still wake the member', () => {
    const p = payloadOf({ id: 'F-9', kind: 'feature', title: 'sheets clone toolbar' });
    expect(payloadMatchesFilter(derived, p)).toBe(true);
  });

  it('EI-128 (a p2p-perf bug) NO LONGER wakes the member', () => {
    const p = payloadOf({ id: 'EI-128', kind: 'bug', title: 'p2p-perf regression on sync fanout' });
    expect(payloadMatchesFilter(derived, p)).toBe(false);
  });

  it('EI-22638252352161446: an unassigned kind match does not wake an assignee-scoped OR arm', () => {
    const filter: FilterNode = {
      any: [
        {
          all: [
            { field: 'assignee', op: '=', value: 'agent-self' },
            { field: 'kind', op: 'in', value: ['bug', 'change'] },
          ],
        },
        { field: 'id', op: 'in', value: ['WI-10000606'] },
      ],
    };
    const derived = claimSpecFilterToClaimablePayloadFilter(filter);

    expect(payloadMatchesFilter(derived, payloadOf({ id: 'WI-10000605', kind: 'change', assignee: null }))).toBe(false);
    expect(payloadMatchesFilter(derived, payloadOf({ id: 'WI-10000606', kind: 'task', assignee: null }))).toBe(true);
  });

  it('WI-5013 (an unrelated tracking issue) NO LONGER wakes the member', () => {
    const p = payloadOf({ id: 'WI-5013', kind: 'change', title: 'track the desktop update rollout' });
    expect(payloadMatchesFilter(derived, p)).toBe(false);
  });

  it('a plan-drain spec narrows on the plan slug carried by the widened payload', () => {
    const planSpec: FilterNode = { field: 'plan', op: '=', value: 'drain-plan' };
    const d = claimSpecFilterToClaimablePayloadFilter(planSpec);
    expect(payloadMatchesFilter(d, payloadOf({ plan: 'drain-plan' }))).toBe(true);
    expect(payloadMatchesFilter(d, payloadOf({ plan: 'other-plan' }))).toBe(false);
    expect(payloadMatchesFilter(d, payloadOf({ plan: null }))).toBe(false);
  });
});

describe('EI-14161 reproduction — a tag-fenced exclusion (title-glob had no signal for) now narrows', () => {
  // The bug-drain fleet's spec: exclude the whole p2p/rig-fenced class via `tags`
  // (the mechanism a spec author reaches for once items ARE tagged — the *p2p* title
  // glob was only ever a workaround for when tags went unpopulated). Before this fix
  // the claimable payload carried no `tags` at all, so this leaf translated to
  // `undefined` (unscoped await) and the member re-woke, cold, on every one of these
  // releases only for scheduler:get_next to immediately re-reject the SAME item.
  const spec: FilterNode = {
    all: [
      { field: 'kind', op: 'in', value: ['feature', 'chunk', 'bug'] },
      { not: { field: 'tags', op: 'contains', value: 'p2p' } },
      { not: { field: 'tags', op: 'contains', value: 'rig' } },
    ],
  };
  const derived = claimSpecFilterToClaimablePayloadFilter(spec);

  it('derives a non-empty, scoped payload_filter (not the unscoped await)', () => {
    expect(derived).toBeDefined();
  });

  it('an in-scope, untagged claimable item WOULD still wake the member', () => {
    const p = payloadOf({ id: 'F-9', kind: 'feature', title: 'sheets clone toolbar' });
    expect(payloadMatchesFilter(derived, p)).toBe(true);
  });

  it('EI-128 (tags: [p2p]) NO LONGER wakes the member — the exact gap EI-14161 reported', () => {
    const p = payloadOf({ id: 'EI-128', kind: 'bug', title: 'p2p-perf regression on sync fanout', tags: ['p2p'] });
    expect(payloadMatchesFilter(derived, p)).toBe(false);
  });

  it('a rig-fenced item (tags: [rig]) also no longer wakes the member', () => {
    const p = payloadOf({ id: 'EI-421', kind: 'feature', title: 'federation rig soak', tags: ['rig'] });
    expect(payloadMatchesFilter(derived, p)).toBe(false);
  });

  it('a tag that merely SUBSTRING-contains "p2p" (e.g. "p2p-adjacent") is NOT excluded — exact membership only', () => {
    // Pins the ARRAY_VALUED_FIELDS `contains`→`equals` mapping: a substring mapping would
    // have wrongly excluded this once wrapped in `not` (the unsoundness the fix avoids).
    const p = payloadOf({ id: 'F-10', kind: 'feature', title: 'unrelated work', tags: ['p2p-adjacent'] });
    expect(payloadMatchesFilter(derived, p)).toBe(true);
  });
});

describe('SOUNDNESS — payload-only spec: derived match IFF spec would admit', () => {
  // A filter that references ONLY payload-visible fields, so the claim-spec verdict
  // is fully determined by the payload projection — the derived filter must agree
  // exactly (never suppress an item the spec would admit; the whole EI-15185 risk).
  const payloadOnlyFilters: FilterNode[] = [
    { field: 'kind', op: 'in', value: ['feature', 'chunk'] },
    { field: 'kind', op: '!=', value: 'bug' },
    { not: { field: 'title', op: 'glob', value: '*p2p*' } },
    { field: 'title', op: 'contains', value: 'p2p' },
    { field: 'plan', op: '=', value: 'A' },
    { field: 'goal', op: '=', value: 'goal-a' },
    { field: 'assignee', op: '=', value: 'agent-1' },
    { field: 'assignee', op: '!=', value: 'agent-1' },
    // EI-14161: tags leaves — exact membership (`contains`/`=`), `in`, `!=`, and both
    // sides of a `not` must agree exactly with matchesClaimSpecFilter's array branch.
    { field: 'tags', op: 'contains', value: 'p2p' },
    { not: { field: 'tags', op: 'contains', value: 'p2p' } },
    { field: 'tags', op: 'in', value: ['p2p', 'rig'] },
    { field: 'tags', op: '!=', value: 'p2p' },
    {
      all: [
        { field: 'kind', op: 'in', value: ['feature', 'chunk'] },
        { not: { field: 'title', op: 'glob', value: '*p2p*' } },
      ],
    },
    {
      all: [
        { field: 'kind', op: 'in', value: ['feature', 'chunk', 'bug'] },
        { not: { field: 'tags', op: 'contains', value: 'p2p' } },
        { not: { field: 'tags', op: 'contains', value: 'rig' } },
      ],
    },
    {
      any: [
        { field: 'kind', op: '=', value: 'feature' },
        { field: 'plan', op: '=', value: 'A' },
      ],
    },
    {
      any: [
        { field: 'goal', op: '=', value: 'goal-a' },
        { field: 'id', op: '=', value: 'EI-128' },
      ],
    },
  ];

  const items: Array<{ id?: string; kind?: string; title?: string; assignee?: string | null; plan?: string | null; tags?: string[]; goal?: string | null }> = [
    { id: 'F-1', kind: 'feature', title: 'sheets clone', plan: 'A', goal: 'goal-a' },
    { id: 'F-2', kind: 'feature', title: 'p2p sync fix', plan: 'B', goal: 'goal-b' },
    { id: 'C-1', kind: 'chunk', title: 'grid render', plan: 'A', goal: null },
    { id: 'EI-128', kind: 'bug', title: 'p2p-perf regression', plan: null, tags: ['p2p'], goal: null },
    { id: 'EI-421', kind: 'feature', title: 'federation rig soak', plan: null, tags: ['rig'], goal: 'goal-rig' },
    { id: 'WI-5013', kind: 'change', title: 'rollout tracking', plan: 'B', goal: null },
    { id: 'T-1', kind: 'task', title: 'no plan here', plan: null, goal: null },
    { id: 'F-10', kind: 'feature', title: 'unrelated work', plan: null, tags: ['p2p-adjacent'], goal: null },
  ];

  for (const filter of payloadOnlyFilters) {
    it(`derived agrees with the spec for every item — ${JSON.stringify(filter)}`, () => {
      const derived = claimSpecFilterToClaimablePayloadFilter(filter);
      for (const item of items) {
        const specAdmits = matchesClaimSpecFilter(subjectOf(item), filter);
        const eventMatches = payloadMatchesFilter(derived, payloadOf(item));
        expect(eventMatches, `item ${item.id}: spec=${specAdmits} event=${eventMatches}`).toBe(specAdmits);
      }
    });
  }
});

describe('SOUNDNESS — mixed spec never suppresses a spec-admissible item', () => {
  // A spec mixing a payload field (kind) with a non-payload one (plan_item): the
  // derived filter drops plan_item, so it OVER-approximates — it may fire on an item
  // get_next later rejects (a cheap re-miss), but it must NEVER drop an item the spec
  // would admit.
  const filter: FilterNode = {
    all: [
      { field: 'kind', op: '=', value: 'feature' },
      { field: 'plan_item', op: 'in', value: ['P-001'] },
    ],
  };
  const derived = claimSpecFilterToClaimablePayloadFilter(filter);

  it('fires on a kind=feature item regardless of plan_item (over-approximation is intentional)', () => {
    // Both of these are kind=feature; the spec admits only the P-001 one, but the
    // event filter (kind only) admits BOTH — get_next stays authoritative on the wake.
    expect(payloadMatchesFilter(derived, payloadOf({ kind: 'feature', id: 'F-a' }))).toBe(true);
    expect(payloadMatchesFilter(derived, payloadOf({ kind: 'feature', id: 'F-b' }))).toBe(true);
  });

  it('still suppresses a non-feature item (the payload leaf that DID translate)', () => {
    expect(payloadMatchesFilter(derived, payloadOf({ kind: 'bug' }))).toBe(false);
  });
});
