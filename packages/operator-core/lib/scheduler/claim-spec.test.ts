/**
 * Tests for the per-bee claim SPEC schema + validator
 * (`hybrid-bee-scheduler-work-stealing-2026-06-22`, Phases 1–2).
 *
 * Covers: a fully-featured valid spec, the default spec, and each invalid case
 * the validator must reject with a clear, field-named error — unknown filter
 * field, unknown filter op, unknown rank term, bad version, op/value mismatch,
 * weighted-mode without weights, floor fields in the filter, and unknown keys.
 */
import { describe, it, expect } from 'vitest';
import {
  validateClaimSpec,
  validateClaimSpecForRead,
  claimSpecSchema,
  DEFAULT_CLAIM_SPEC,
  CURRENT_SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  ITEM_FIELDS,
  FILTERABLE_ITEM_FIELDS,
  RANKABLE_ITEM_FIELDS,
  FILTER_OPS,
  RANK_FUNCTIONS,
  isIdOnlySelector,
  fixedCohortIds,
  positiveIdCohortIds,
  appendIdsToClaimSpec,
  positiveKindCohortKinds,
  formatSpecRef,
  CLAIM_SPEC_FENCE_MACROS,
  CLAIM_SPEC_LANES,
  type ClaimSpec,
  type FilterNode,
} from './claim-spec';

/** A maximal, valid spec exercising the full vocabulary (mirrors the plan's worked example). */
const fullSpec: ClaimSpec = {
  specVersion: '1.0',
  specId: 'sched-7f3a',
  revision: 4,
  basedOn: 'catalog:throughput-router@2',
  boundModel: 'claude-opus-4.8',
  view: {
    filter: {
      all: [
        { field: 'kind', op: 'in', value: ['feature', 'bug'] },
        { field: 'risk_tier', op: '<=', value: 2 },
        {
          any: [
            { field: 'tags', op: 'contains', value: 'sync' },
            { field: 'paths', op: 'glob', value: 'libs/sync/**' },
          ],
        },
        { not: { field: 'tags', op: 'contains', value: 'owner-gated' } },
      ],
    },
  },
  rank: {
    mode: 'lexicographic',
    terms: [
      { expr: 'priority', dir: 'desc' },
      { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
      { expr: 'model_fit(bee.model,item)', dir: 'desc' },
      { expr: 'age', dir: 'asc' },
    ],
  },
  limits: { maxConcurrentClaims: 1, claimTtlSec: 1800 },
};

describe('validateClaimSpec — valid specs', () => {
  it('accepts a fully-featured spec exercising every vocabulary feature', () => {
    const r = validateClaimSpec(fullSpec);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.spec).toMatchObject({ specId: 'sched-7f3a', revision: 4 });
  });

  it('accepts a minimal spec — empty view, single rank term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 's1',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a valid weighted-mode spec with weights on every term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'w1',
      revision: 1,
      view: {},
      rank: {
        mode: 'weighted',
        terms: [
          { expr: 'priority', dir: 'desc', weight: 2 },
          { expr: 'est_cost', dir: 'asc', weight: 0.5 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts each known rank function as a term head', () => {
    for (const fn of RANK_FUNCTIONS) {
      const expr = fn === 'redundancy_need' ? 'redundancy_need' : `${fn}(x,y)`;
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: `rf-${fn}`,
        revision: 0,
        view: {},
        rank: { mode: 'lexicographic', terms: [{ expr, dir: 'desc' }] },
      });
      expect(r.ok, `rank function ${fn} should validate`).toBe(true);
    }
  });

  it('warns (but stays ok) when a weight is set in lexicographic mode', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'lw',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc', weight: 3 }] },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('ignored in mode "lexicographic"'))).toBe(true);
  });
});

describe('validateClaimSpec — the default spec', () => {
  it('the exported DEFAULT_CLAIM_SPEC validates clean', () => {
    const r = validateClaimSpec(DEFAULT_CLAIM_SPEC);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('default spec is the baseline: empty view, revision 0, current version', () => {
    expect(DEFAULT_CLAIM_SPEC.revision).toBe(0);
    expect(DEFAULT_CLAIM_SPEC.specVersion).toBe(CURRENT_SPEC_VERSION);
    expect(DEFAULT_CLAIM_SPEC.view.filter).toBeUndefined();
    expect(DEFAULT_CLAIM_SPEC.rank.terms.length).toBeGreaterThan(0);
  });
});

describe('validateClaimSpec — invalid: filter vocabulary', () => {
  it('rejects an unknown filter field', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'x',
      revision: 0,
      view: { filter: { field: 'nonsense', op: '=', value: 1 } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('field'))).toBe(true);
  });

  it('rejects an unknown filter op', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'x',
      revision: 0,
      view: { filter: { field: 'priority', op: '~=', value: 1 } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('op'))).toBe(true);
  });

  it('rejects a floor field (blocked / cursed) in the filter — floors are not spec-controlled', () => {
    for (const field of ['blocked', 'cursed']) {
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: 'floor',
        revision: 0,
        view: { filter: { field, op: '=', value: false } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      });
      expect(r.ok, `${field} must not be filterable`).toBe(false);
    }
  });

  it('rejects op/value mismatch — `in` without an array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm',
      revision: 0,
      view: { filter: { field: 'kind', op: 'in', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('requires an array'))).toBe(true);
  });

  it('rejects op/value mismatch — numeric comparator with a string', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm2',
      revision: 0,
      view: { filter: { field: 'risk_tier', op: '<=', value: 'two' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('numeric'))).toBe(true);
  });

  it('rejects op/value mismatch — scalar comparator with an array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm3',
      revision: 0,
      view: { filter: { field: 'kind', op: '=', value: ['feature', 'bug'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('single scalar'))).toBe(true);
  });

  it('validates nested combinators and reports the deep path of a bad leaf', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'nested',
      revision: 0,
      view: {
        filter: { all: [{ any: [{ field: 'kind', op: 'in', value: 'feature' }] }] },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('view.filter.all[0].any[0]'))).toBe(true);
  });

  // EI-21906739799895413: the reporter measured `{ op:'any', of:[...] }` rejected with
  // "unknown filter op 'any'" and concluded the DSL has no boolean composition at all.
  // It does — `{ any: [...] }` (a combinator, not a leaf-with-an-any-op) has always
  // validated (see the sibling describe block below) and IS how `buildFleetDependencyEscape`
  // auto-widens a spec. This locks in the corrected error message so the mis-syntax is
  // self-diagnosing instead of reading as a missing feature.
  it('names the combinator syntax when an author mistakes "any"/"all"/"not" for a leaf op', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'combinator-confusion',
      revision: 0,
      view: {
        filter: {
          op: 'any',
          of: [
            { field: 'plan', op: 'in', value: ['plan-a'] },
            { field: 'id', op: 'in', value: ['WI-1'] },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(r.ok).toBe(false);
    const combinatorError = r.errors.find((e) => e.includes('is not a filter operator'));
    expect(combinatorError).toBeDefined();
    expect(combinatorError).toContain('top-level COMBINATOR key');
    expect(combinatorError).toContain('{ any: [...] }');
    expect(combinatorError?.toLowerCase()).toContain('sibling');
  });

  it('accepts the actual combinator syntax the confused-op error points to (OR/AND/NOT already work)', () => {
    const or = validateClaimSpec({
      specVersion: '1.0',
      specId: 'combinator-or',
      revision: 0,
      view: {
        filter: {
          any: [
            { field: 'plan', op: 'in', value: ['plan-a'] },
            { field: 'id', op: 'in', value: ['WI-1'] },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(or.ok).toBe(true);

    const and = validateClaimSpec({
      specVersion: '1.0',
      specId: 'combinator-and',
      revision: 0,
      view: {
        filter: { all: [{ field: 'kind', op: 'in', value: ['bug'] }, { field: 'plan', op: '=', value: 'plan-a' }] },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(and.ok).toBe(true);

    const not = validateClaimSpec({
      specVersion: '1.0',
      specId: 'combinator-not',
      revision: 0,
      view: { filter: { not: { field: 'title', op: 'word', value: 'p2p' } } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(not.ok).toBe(true);
  });
});

describe('validateClaimSpec — invalid: rank vocabulary', () => {
  it('rejects an unknown rank term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'r',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'made_up_metric', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown rank term'))).toBe(true);
  });

  it('rejects an unknown rank FUNCTION head', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'rfn',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'bogus(bee.x,item.y)', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown rank term') && e.includes('bogus'))).toBe(true);
  });

  it('rejects weighted mode missing a weight on a term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'wm',
      revision: 0,
      view: {},
      rank: {
        mode: 'weighted',
        terms: [
          { expr: 'priority', dir: 'desc', weight: 1 },
          { expr: 'age', dir: 'asc' }, // missing weight
        ],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('requires a finite "weight"'))).toBe(true);
  });

  it('rejects an empty rank.terms array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'e',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [] },
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateClaimSpec — lane (P-007 Phase B / D-027)', () => {
  const base = {
    specVersion: '1.0',
    specId: 'verifier-lane',
    revision: 0,
    view: {},
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it('names exactly the implementation and verification pools', () => {
    expect([...CLAIM_SPEC_LANES]).toEqual(['implementation', 'verification']);
  });

  it.each(CLAIM_SPEC_LANES)('accepts lane %s and keeps it on the parsed spec', (lane) => {
    const r = validateClaimSpec({ ...base, lane });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.spec?.lane).toBe(lane);
  });

  it('leaves lane absent when the spec omits it (the ordinary implementation pull)', () => {
    const r = validateClaimSpec(base);
    expect(r.ok).toBe(true);
    expect(r.spec?.lane).toBeUndefined();
    expect(DEFAULT_CLAIM_SPEC.lane).toBeUndefined();
  });

  it('rejects an unknown lane with a lane-named error', () => {
    const r = validateClaimSpec({ ...base, lane: 'review' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('lane'))).toBe(true);
  });
});

describe('validateClaimSpec — revisionAdoption (bug-queue-legitimacy D-011 B)', () => {
  const base = {
    specVersion: '1.0',
    specId: 'drain-lane',
    revision: 0,
    view: {},
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it.each([
    ['no lane', {}],
    ["lane 'implementation'", { lane: 'implementation' }],
  ])("accepts revisionAdoption:'first' with %s and keeps it on the parsed spec", (_label, extra) => {
    const r = validateClaimSpec({ ...base, ...extra, revisionAdoption: 'first' });
    expect(r.errors).toEqual([]);
    expect(r.spec?.revisionAdoption).toBe('first');
  });

  it('is absent (off) by default, including on the default spec', () => {
    expect(validateClaimSpec(base).spec?.revisionAdoption).toBeUndefined();
    expect(DEFAULT_CLAIM_SPEC.revisionAdoption).toBeUndefined();
  });

  it('rejects an unknown mode with a field-named error', () => {
    const r = validateClaimSpec({ ...base, revisionAdoption: 'fallback' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('revisionAdoption'))).toBe(true);
  });

  it('refuses it on a verifier-lane spec, where it would be silently inert', () => {
    const r = validateClaimSpec({ ...base, lane: 'verification', revisionAdoption: 'first' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('revisionAdoption') && e.includes('implementation-lane'))).toBe(true);
  });
});

describe('validateClaimSpec — invalid: version + structure', () => {
  it('rejects an unsupported spec version', () => {
    const r = validateClaimSpec({
      specVersion: '0.9',
      specId: 'v',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unsupported spec version'))).toBe(true);
  });

  it('rejects a missing required field (specId)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('specId'))).toBe(true);
  });

  it('rejects a negative revision', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'neg',
      revision: -1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('revision'))).toBe(true);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'extra',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      bonusMutableQueryFragment: { sneaky: true },
    });
    expect(r.ok).toBe(false);
  });

  it('strips and warns on unknown top-level keys only for stored reads', () => {
    const input = { ...DEFAULT_CLAIM_SPEC, futureLane: 'verification' };
    const read = validateClaimSpecForRead(input);

    expect(read.ok).toBe(true);
    expect(read.spec).not.toHaveProperty('futureLane');
    expect(read.warnings.some((warning) => warning.includes('futureLane'))).toBe(true);
    expect(validateClaimSpec(input).ok).toBe(false);
  });

  it('keeps unknown nested policy keys fail-closed on stored reads', () => {
    const input = {
      ...DEFAULT_CLAIM_SPEC,
      view: { ...DEFAULT_CLAIM_SPEC.view, futureConstraint: true },
    };
    const read = validateClaimSpecForRead(input);

    expect(read.ok).toBe(false);
    expect(read.errors.some((error) => error.includes('futureConstraint'))).toBe(true);
  });

  it('rejects a non-object input without throwing', () => {
    for (const bad of [null, undefined, 42, 'spec', []]) {
      const r = validateClaimSpec(bad);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects an invalid limits value (zero TTL)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'lim',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      limits: { claimTtlSec: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe('claim-spec vocabulary exports', () => {
  it('filterable fields exclude the floor fields blocked + cursed', () => {
    expect(ITEM_FIELDS).toContain('blocked');
    expect(ITEM_FIELDS).toContain('cursed');
    expect(FILTERABLE_ITEM_FIELDS).not.toContain('blocked');
    expect(FILTERABLE_ITEM_FIELDS).not.toContain('cursed');
  });

  it('`id` is FILTERABLE (pin a set) but NOT rankable (ordering by id is meaningless)', () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('id');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('id');
  });

  it('a spec can PIN a fixed set with `id in [...]`, composed with a property filter', () => {
    const pin = validateClaimSpec({
      specVersion: CURRENT_SPEC_VERSION,
      specId: 'redrive-failed',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'id', op: 'in', value: ['F-12', 'EI-7'] },
            { field: 'kind', op: '=', value: 'bug' },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(pin.ok).toBe(true);
    // `id` is filterable but not a valid RANK term — ranking by id is rejected.
    const rankById = validateClaimSpec({
      specVersion: CURRENT_SPEC_VERSION,
      specId: 'bad',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'id', dir: 'desc' }] },
    });
    expect(rankById.ok).toBe(false);
  });
});

describe('claim-spec vocabulary — `title` keyword exclusion (WI-3268)', () => {
  it('`title` is FILTERABLE but NOT rankable (same shape as `id`)', () => {
    expect(ITEM_FIELDS).toContain('title');
    expect(FILTERABLE_ITEM_FIELDS).toContain('title');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('title');
  });

  it('accepts a NOT+glob title exclusion (the p2p-exclusion shape)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'exclude-p2p',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
            {
              not: {
                any: [
                  { field: 'title', op: 'glob', value: '*p2p*' },
                  { field: 'title', op: 'glob', value: '*hyperswarm*' },
                ],
              },
            },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects ranking by `title` (ordering by title text is meaningless)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'bad-rank',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'title', dir: 'asc' }] },
    });
    expect(r.ok).toBe(false);
  });
});

describe('claim-spec `view.fence` macro — server-side expansion (WI-6050)', () => {
  it('publishes the shared fence macro keys instead of accepting arbitrary strings', () => {
    const specForFence = (fence: string) => ({
      specVersion: '1.0',
      specId: 'fence-schema',
      revision: 1,
      view: { fence },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });

    for (const fence of Object.keys(CLAIM_SPEC_FENCE_MACROS)) {
      expect(claimSpecSchema.safeParse(specForFence(fence)).success).toBe(true);
    }

    const unknown = claimSpecSchema.safeParse(specForFence('not-a-real-fence'));
    expect(unknown.success).toBe(false);
    if (unknown.success) return;
    expect(unknown.error.issues.some((issue) => issue.path.join('.') === 'view.fence')).toBe(true);
  });

  it('expands `fence:"p2p-lane"` into a `not:{any:[...]}` title-word filter, stripping `fence`', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'fenced-only',
      revision: 1,
      view: { fence: 'p2p-lane' },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    // `fence` must not survive into the stored/returned spec — otherwise re-validating
    // an already-expanded spec (every getClaimSpec read does exactly this) would AND the
    // fence node on again every time.
    expect(r.spec?.view).not.toHaveProperty('fence');
    const filter = r.spec?.view.filter as { not?: { any?: unknown[] } } | undefined;
    expect(filter?.not?.any).toBeDefined();
    expect((filter?.not?.any ?? []).length).toBeGreaterThanOrEqual(10); // P2P_LANE_EXCLUSION_TERMS' current size
  });

  it('ANDs the fence onto an existing filter rather than replacing it', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'fenced-plus-kind',
      revision: 1,
      view: {
        filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
        fence: 'p2p-lane',
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    const filter = r.spec?.view.filter as { all?: unknown[] } | undefined;
    expect(filter?.all).toHaveLength(2);
    expect(filter?.all?.[0]).toMatchObject({ field: 'kind' });
  });

  it('rejects an unknown fence name with a clear, named error', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'bad-fence',
      revision: 1,
      view: { fence: 'not-a-real-fence' },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('view.fence'))).toBe(true);
  });

  it('re-validating an already-expanded (fence-stripped) spec is idempotent, not double-applied', () => {
    const once = validateClaimSpec({
      specVersion: '1.0',
      specId: 'fenced-roundtrip',
      revision: 1,
      view: { fence: 'p2p-lane' },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(once.ok).toBe(true);
    // Simulates what getClaimSpec does: re-validate the STORED (already-expanded) spec.
    const twice = validateClaimSpec(once.spec);
    expect(twice.ok).toBe(true);
    expect(twice.spec?.view.filter).toEqual(once.spec?.view.filter);
  });

  it('actually excludes a p2p-titled item (matches buildP2pLaneFence\'s own semantics)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'fenced-semantics',
      revision: 1,
      view: { fence: 'p2p-lane' },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    const filter = r.spec?.view.filter as { not: { any: { field: string; op: string; value: string }[] } };
    const words = filter.not.any.map((leaf) => leaf.value);
    expect(words).toContain('p2p');
    expect(words).toContain('replication'); // WI-5639's leaked term — the single highest-value entry
    // EI-20240035377782004: buildP2pLaneFence excludes on EITHER `title` OR
    // `summary` matching (title-only was the live scope leak).
    // WI-5280: `plan` is the structural THIRD leg — a P2P plan can deliberately
    // use neutral item titles and summaries, so content-only matching cannot
    // describe a non-P2P lane. Every term therefore produces THREE leaves, one
    // per field, all `word`-matched.
    const FENCE_FIELDS = ['title', 'summary', 'plan'] as const;
    filter.not.any.forEach((leaf) => {
      expect(FENCE_FIELDS).toContain(leaf.field);
      expect(leaf.op).toBe('word');
    });
    const fields = new Set(filter.not.any.map((leaf) => leaf.field));
    expect(fields).toEqual(new Set(FENCE_FIELDS));
    // WI-2145984: pin the legs per-TERM, not just as a set. The set assertion
    // alone still passes if one field silently stops covering some terms (the
    // exact shape of the title-only scope leak), because other terms keep the
    // field present in the set.
    for (const field of FENCE_FIELDS) {
      const covered = filter.not.any.filter((leaf) => leaf.field === field).map((leaf) => leaf.value);
      expect(new Set(covered)).toEqual(new Set(words));
    }
  });
});

describe('isIdOnlySelector — the id-pin tripwire', () => {
  const spec = (filter: unknown) => ({ view: filter === undefined ? {} : { filter } });
  it('true when the filter selects on `id` ALONE', () => {
    expect(isIdOnlySelector(spec({ field: 'id', op: 'in', value: ['F-1', 'F-2'] }))).toBe(true);
    expect(isIdOnlySelector(spec({ all: [{ field: 'id', op: '=', value: 'F-1' }] }))).toBe(true);
  });
  it('false when any property selector is present (a real lane, even if id is also used)', () => {
    expect(
      isIdOnlySelector(
        spec({
          all: [
            { field: 'id', op: 'in', value: ['F-1'] },
            { field: 'plan', op: '=', value: 'p' },
          ],
        }),
      ),
    ).toBe(false);
    expect(isIdOnlySelector(spec({ field: 'plan', op: '=', value: 'p' }))).toBe(false);
  });
  it('false for no filter at all (the whole ready frontier — the opposite of a pin)', () => {
    expect(isIdOnlySelector(spec(undefined))).toBe(false);
    expect(isIdOnlySelector(null)).toBe(false);
    expect(isIdOnlySelector(DEFAULT_CLAIM_SPEC)).toBe(false);
  });

  it('the schema parses the default spec directly (Zod layer agrees with the validator)', () => {
    expect(() => claimSpecSchema.parse(DEFAULT_CLAIM_SPEC)).not.toThrow();
  });

  /**
   * EI-18653031651840641: the tripwire was only ever DENORMALIZED (bee_claim_specs.id_only)
   * so over-reliance stayed countable — it never reached the author, who is the one person
   * who can still fix the spec. The filed trap: a leader replaced a `plan` leaf with a
   * hand-written id list, it validated silently, and ~10 minutes later starved a member on
   * a freshly promoted plan item the original spec would have admitted.
   *
   * Advisory, never a rejection — an id-only spec is the supported way to pin a fixed wave.
   */
  describe('validateClaimSpec warns on a frozen id-list lane', () => {
    const idOnlySpec = (filter: unknown) => ({
      specVersion: '1.0',
      specId: 'frozen-1',
      revision: 0,
      view: { filter },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });

    it('warns — but still ACCEPTS — a bare id-list filter', () => {
      const r = validateClaimSpec(idOnlySpec({ field: 'id', op: 'in', value: ['WI-1', 'WI-2'] }));
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
      const warning = r.warnings.find((w) => w.includes('FROZEN SNAPSHOT'));
      expect(warning).toBeDefined();
      // It must name the union shape, not merely describe the hazard — the filer reached
      // for the id list precisely because they believed no OR existed.
      expect(warning).toContain('any');
    });

    it('warns for an id-only filter nested under a combinator, not just a bare leaf', () => {
      const r = validateClaimSpec(idOnlySpec({ all: [{ field: 'id', op: '=', value: 'WI-1' }] }));
      expect(r.warnings.some((w) => w.includes('FROZEN SNAPSHOT'))).toBe(true);
    });

    it('stays SILENT for a real standing lane — including the union that fixes the trap', () => {
      const propertyLane = validateClaimSpec(idOnlySpec({ field: 'plan', op: '=', value: 'my-plan' }));
      expect(propertyLane.warnings.some((w) => w.includes('FROZEN SNAPSHOT'))).toBe(false);

      // The shape the warning recommends: a plan leaf UNIONED with the standalone ids.
      // This is the whole point of the item — it must not itself trip the warning.
      const union = validateClaimSpec(
        idOnlySpec({
          any: [
            { field: 'plan', op: '=', value: 'my-plan' },
            { field: 'id', op: 'in', value: ['WI-5672', 'WI-5481'] },
          ],
        }),
      );
      expect(union.ok).toBe(true);
      expect(union.warnings.some((w) => w.includes('FROZEN SNAPSHOT'))).toBe(false);
    });

    it('stays silent when there is no filter at all (the whole frontier, not a pin)', () => {
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: 'nofilter',
        revision: 0,
        view: {},
        rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      });
      expect(r.warnings.some((w) => w.includes('FROZEN SNAPSHOT'))).toBe(false);
    });
  });

  it('exposes a non-empty op + version vocabulary', () => {
    expect(FILTER_OPS.length).toBeGreaterThan(0);
    expect(SUPPORTED_SPEC_VERSIONS).toContain(CURRENT_SPEC_VERSION);
  });
});

describe('validateClaimSpec — broad-kind-disjunct footgun advisory (EI-18699032970141084)', () => {
  const specWith = (filter: unknown): unknown => ({
    specVersion: '1.0',
    specId: 'footgun-test',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
  });

  it('warns when a bare "kind" leaf sits alongside plan/tags/id/paths clauses inside an "any"', () => {
    const r = validateClaimSpec(
      specWith({
        any: [
          { field: 'plan', op: '=', value: 'p1' },
          { field: 'tags', op: 'contains', value: 'gui' },
          { field: 'id', op: '=', value: 'EI-1' },
          { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('EI-18699032970141084'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('view.filter.any'))).toBe(true);
  });

  it('warns when the offending "any" is nested (not just top-level)', () => {
    const r = validateClaimSpec(
      specWith({
        all: [
          { field: 'risk_tier', op: '<=', value: 2 },
          {
            any: [
              { field: 'plan', op: '=', value: 'p1' },
              { field: 'kind', op: '=', value: 'bug' },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('EI-18699032970141084'))).toBe(true);
  });

  it('does NOT warn on the correct nested shape — kind ANDed with a scoping "any"', () => {
    const r = validateClaimSpec(
      specWith({
        all: [
          { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
          {
            any: [
              { field: 'plan', op: '=', value: 'p1' },
              { field: 'tags', op: 'contains', value: 'gui' },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('EI-18699032970141084'))).toBe(false);
  });

  it('does NOT warn when "kind" is the only kind of clause in the "any" (no scoping sibling)', () => {
    const r = validateClaimSpec(
      specWith({
        any: [
          { field: 'kind', op: 'in', value: ['bug', 'change'] },
          { field: 'risk_tier', op: '<=', value: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('EI-18699032970141084'))).toBe(false);
  });

  it('does NOT warn when there is no "kind" leaf at all', () => {
    const r = validateClaimSpec(
      specWith({
        any: [
          { field: 'plan', op: '=', value: 'p1' },
          { field: 'tags', op: 'contains', value: 'gui' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('EI-18699032970141084'))).toBe(false);
  });
});

describe('validateClaimSpec — missing severity_rank on an issue-family spec advisory (WI-36743)', () => {
  const specWith = (filter: unknown, terms: { expr: string; dir: 'asc' | 'desc' }[]): unknown => ({
    specVersion: '1.0',
    specId: 'severity-rank-test',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms },
  });

  it('warns when a bug-scoped spec ranks only on priority/age (the live nonp2p-bug-drain shape)', () => {
    const r = validateClaimSpec(
      specWith({ field: 'kind', op: 'in', value: ['bug'] }, [
        { expr: 'priority', dir: 'asc' },
        { expr: 'age', dir: 'desc' },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('severity_rank'))).toBe(true);
  });

  it('does NOT warn once "severity_rank" is present anywhere in rank.terms', () => {
    const r = validateClaimSpec(
      specWith({ field: 'kind', op: 'in', value: ['bug', 'change', 'task'] }, [
        { expr: 'severity_rank', dir: 'desc' },
        { expr: 'priority', dir: 'asc' },
        { expr: 'age', dir: 'desc' },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });

  it('does NOT warn when the filter has no positive "kind" selector (ambiguous family)', () => {
    const r = validateClaimSpec(specWith({ field: 'priority', op: '>=', value: 1 }, [{ expr: 'age', dir: 'asc' }]));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });

  it('does NOT warn when "kind" only targets the feature family (severity is structurally absent there)', () => {
    const r = validateClaimSpec(
      specWith({ field: 'kind', op: '=', value: 'feature' }, [{ expr: 'priority', dir: 'desc' }]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });

  it('does NOT warn when the filter has no filter at all (mixed pool, too ambiguous to advise)', () => {
    const r = validateClaimSpec(specWith(undefined, [{ expr: 'age', dir: 'asc' }]));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });

  it('does NOT warn when "kind" is only excluded via "not" (a negated selector, not a positive one)', () => {
    const r = validateClaimSpec(
      specWith({ not: { field: 'kind', op: 'in', value: ['bug'] } }, [{ expr: 'age', dir: 'asc' }]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });

  it('finds "kind" nested inside "any"/"all" combinators, not just at the top level', () => {
    const r = validateClaimSpec(
      specWith(
        {
          all: [
            { field: 'risk_tier', op: '<=', value: 2 },
            { any: [{ field: 'kind', op: 'in', value: ['change'] }, { field: 'tags', op: 'contains', value: 'x' }] },
          ],
        },
        [{ expr: 'priority', dir: 'asc' }],
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(true);
  });

  it('DEFAULT_CLAIM_SPEC itself does not trigger the advisory (no kind filter at all)', () => {
    const r = validateClaimSpec(DEFAULT_CLAIM_SPEC);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('WI-36743'))).toBe(false);
  });
});

describe('fixedCohortIds — exact fixed-wave extraction', () => {
  const spec = (filter: unknown) => ({ view: { filter } });

  it('extracts a positive id leaf, deduping in declared order', () => {
    expect(fixedCohortIds(spec({ field: 'id', op: 'in', value: ['WI-1', 'WI-2', 'WI-1'] }))).toEqual(['WI-1', 'WI-2']);
  });

  it('composes all as intersection and any as union', () => {
    expect(
      fixedCohortIds(
        spec({
          all: [
            { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] },
            {
              any: [
                { field: 'id', op: '=', value: 'WI-2' },
                { field: 'id', op: '=', value: 'WI-3' },
              ],
            },
          ],
        }),
      ),
    ).toEqual(['WI-2']);
  });

  it('returns null for property lanes, negative/fuzzy id sets, and complements', () => {
    expect(fixedCohortIds(spec({ field: 'plan', op: '=', value: 'p' }))).toBeNull();
    expect(fixedCohortIds(spec({ field: 'id', op: '!=', value: 'WI-1' }))).toBeNull();
    expect(fixedCohortIds(spec({ not: { field: 'id', op: '=', value: 'WI-1' } }))).toBeNull();
  });
});

describe('positiveKindCohortKinds — sound kind bounds', () => {
  it('intersects positive kind bounds while retaining unrelated narrowing predicates', () => {
    expect(positiveKindCohortKinds({ all: [
      { field: 'kind', op: 'in', value: ['bug', 'task', 'bug'] },
      { field: 'kind', op: '=', value: 'bug' },
      { not: { field: 'title', op: 'word', value: 'p2p' } },
    ] })).toEqual(['bug']);
    expect(positiveKindCohortKinds({ all: [
      { field: 'kind', op: '=', value: 'bug' },
      { field: 'kind', op: '=', value: 'task' },
    ] })).toEqual([]);
  });

  it('keeps generic kinds and refuses to infer a finite bound from alternatives or complements', () => {
    expect(positiveKindCohortKinds({ field: 'kind', op: 'in', value: ['custom-work', 'feature'] }))
      .toEqual(['custom-work', 'feature']);
    for (const filter of [undefined,
      { any: [{ field: 'kind', op: '=', value: 'bug' }, { field: 'title', op: '=', value: 'extra' }] },
      { not: { field: 'kind', op: '=', value: 'feature' } },
      { field: 'kind', op: 'glob', value: '*bug*' },
    ]) expect(positiveKindCohortKinds(filter)).toBeNull();
  });
});

describe('appendIdsToClaimSpec — exact cohort extension', () => {
  it('preserves incumbent ids, fences, rank, states and limits without mutating the input', () => {
    const spec: ClaimSpec = {
      ...DEFAULT_CLAIM_SPEC, revision: 7, states: ['open'], limits: { maxConcurrentClaims: 2 },
      view: { filter: { all: [
        { field: 'id', op: 'in', value: ['WI-old', 'WI-retained'] },
        { field: 'goal', op: '=', value: 'goal-owned' },
        { not: { field: 'title', op: 'word', value: 'p2p' } },
      ] } },
    };
    const snapshot = structuredClone(spec);
    const candidate = appendIdsToClaimSpec(spec, ['WI-new', 'WI-old'])!;
    expect(positiveIdCohortIds(candidate.view.filter)).toEqual(['WI-old', 'WI-retained', 'WI-new']);
    expect((candidate.view.filter as { all: FilterNode[] }).all).toEqual([
      { field: 'id', op: 'in', value: ['WI-old', 'WI-retained', 'WI-new'] },
      ...(spec.view.filter as { all: FilterNode[] }).all.slice(1),
    ]);
    expect({ ...candidate, view: spec.view }).toEqual(spec);
    expect(spec).toEqual(snapshot);
  });

  it('refuses dynamic, mixed disjunction and negative-only ID lanes', () => {
    const filters: FilterNode[] = [
      { field: 'kind', op: '=', value: 'bug' },
      { any: [{ field: 'id', op: '=', value: 'WI-old' }, { field: 'goal', op: '=', value: 'goal-owned' }] },
      { not: { field: 'id', op: 'in', value: ['WI-old'] } },
    ];
    for (const filter of filters) expect(appendIdsToClaimSpec({ ...DEFAULT_CLAIM_SPEC, view: { filter } }, ['WI-new'])).toBeNull();
  });

  it('extends pure ID disjunctions and retains intersection semantics in fenced cohorts', () => {
    const disjunction = appendIdsToClaimSpec({ ...DEFAULT_CLAIM_SPEC, view: { filter: { any: [
      { field: 'id', op: '=', value: 'WI-a' }, { field: 'id', op: '=', value: 'WI-b' },
    ] } } }, ['WI-c'])!;
    expect(positiveIdCohortIds(disjunction.view.filter)).toEqual(['WI-a', 'WI-b', 'WI-c']);
    const intersection = appendIdsToClaimSpec({ ...DEFAULT_CLAIM_SPEC, view: { filter: { all: [
      { field: 'id', op: 'in', value: ['WI-common', 'WI-a'] },
      { field: 'id', op: 'in', value: ['WI-common', 'WI-b'] },
      { field: 'goal', op: '=', value: 'goal-owned' },
    ] } } }, ['WI-c'])!;
    expect(positiveIdCohortIds(intersection.view.filter)).toEqual(['WI-common', 'WI-c']);
  });
});

describe('positiveIdCohortIds — immutable cross-family candidate set', () => {
  it('extracts a bare ID leaf and de-duplicates it', () => {
    expect(positiveIdCohortIds({ field: 'id', op: 'in', value: ['WI-1', 'WI-2', 'WI-1'] })).toEqual(['WI-1', 'WI-2']);
  });

  it('keeps an ID cohort inside top-level all when property predicates narrow it further', () => {
    expect(
      positiveIdCohortIds({
        all: [
          { field: 'id', op: 'in', value: ['WI-1', 'WI-2', 'WI-3'] },
          { not: { field: 'title', op: 'glob', value: '*p2p*' } },
          { field: 'kind', op: 'in', value: ['bug'] },
        ],
      }),
    ).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('intersects direct ID leaves and refuses any/not simplification', () => {
    expect(
      positiveIdCohortIds({
        all: [
          { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] },
          { field: 'id', op: 'in', value: ['WI-2', 'WI-3'] },
        ],
      }),
    ).toEqual(['WI-2']);
    expect(
      positiveIdCohortIds({
        any: [
          { field: 'id', op: '=', value: 'WI-1' },
          { field: 'kind', op: '=', value: 'bug' },
        ],
      }),
    ).toBeNull();
    expect(positiveIdCohortIds({ not: { field: 'id', op: '=', value: 'WI-1' } })).toBeNull();
  });
});

// drain-claim-spec-hardening-2026-07-13 P-002 (fixes EI-11300): `states` rides the spec —
// an optional claimable-status subset a fleet leader sets ONCE so every inheriting member's
// get_next defaults to it instead of the plain ['todo'] floor.
describe('claim-spec `states` field (D-002, EI-11300)', () => {
  it('accepts a spec that carries a valid `states` subset', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'bug-drain',
      revision: 1,
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      states: ['open'],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.spec?.states).toEqual(['open']);
  });

  it('accepts multiple allowed states together', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'multi-state',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      // work-item-status-full-unify P-004/P-005: 'todo' was retired — 'open' is the
      // single unified claimable token across both families now (CLAIM_STATES_ALLOWLIST).
      states: ['open', 'failing'],
    });
    expect(r.ok).toBe(true);
    expect(r.spec?.states).toEqual(['open', 'failing']);
  });

  it('omitting `states` still validates (backward-compatible — undefined, not required)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'no-states',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.spec?.states).toBeUndefined();
  });

  it('rejects a `states` value outside the claimable allowlist', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'bad-state',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      states: ['todo', 'blocked'],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects `states` gated to floor-owned values (blocked/cursed can never be requested)', () => {
    for (const bad of ['blocked', 'cursed', 'done', 'passed']) {
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: 'bad-floor-state',
        revision: 0,
        view: {},
        rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
        states: [bad],
      });
      expect(r.ok).toBe(false);
    }
  });

  it("DEFAULT_CLAIM_SPEC carries no `states` (today's ['todo']-default behavior, unchanged)", () => {
    expect(DEFAULT_CLAIM_SPEC.states).toBeUndefined();
  });
});

describe('formatSpecRef — unambiguous spec+revision label (EI-18676258006299036)', () => {
  it('never renders the bare "<specId>@<revision>" form that reads as a size/replica count', () => {
    const ref = formatSpecRef('nonp2p-bug-drain-0725', 5);
    expect(ref).not.toMatch(/nonp2p-bug-drain-0725@5/);
    expect(ref).toBe('nonp2p-bug-drain-0725 (spec rev 5)');
  });

  it('handles a null/undefined revision without producing a bare "@"', () => {
    expect(formatSpecRef('some-spec', null)).toBe('some-spec (spec rev unknown)');
    expect(formatSpecRef('some-spec', undefined)).toBe('some-spec (spec rev unknown)');
  });

  it('renders revision 0 (falsy but valid) distinctly from unknown', () => {
    expect(formatSpecRef('some-spec', 0)).toBe('some-spec (spec rev 0)');
  });
});
