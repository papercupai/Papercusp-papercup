/**
 * ideators — unit coverage for the PURE pieces of the ideator fan-out (P-004 /
 * D-004): the weighted-extras allocator, the forced-diversity roster builder, and
 * the defensive LLM-output parser. (runIdeators' execution injects a ScoutLlmCall;
 * the structural pure functions are pinned here, no network.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { allocateExtraIdeators, buildIdeatorRoster, parseIdeasPayload, runIdeators } from './ideators';
import { CREATIVE_LENSES } from './types';
import type { CreativeLens, CorpusDigest, ScoutLlmCall } from './types';
import { lensIdentityId, type LensIdentityId } from './lenses';

/** Weights are keyed by lens identity id (P-011 / R-8); the allocator's output stays keyed by lens. */
const idW = (w: Partial<Record<CreativeLens, number>>): Partial<Record<LensIdentityId, number>> =>
  Object.fromEntries(Object.entries(w).map(([l, n]) => [lensIdentityId(l as CreativeLens), n]));

describe('allocateExtraIdeators (largest-remainder)', () => {
  const lenses = CREATIVE_LENSES;

  it('no extras when total ≤ 0 or every weight is zero', () => {
    expect(Object.values(allocateExtraIdeators(lenses, idW({ analogical: 5 }), 0)).every((n) => n === 0)).toBe(true);
    expect(Object.values(allocateExtraIdeators(lenses, {}, 4)).every((n) => n === 0)).toBe(true); // no signal
  });

  it('distributes exactly `total` extras, proportional to weights', () => {
    const out = allocateExtraIdeators(lenses, idW({ analogical: 3, reframing: 1 }), 4);
    expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(4);
    expect(out.analogical).toBe(3);
    expect(out.reframing).toBe(1);
  });

  it('assigns the leftover by largest fractional remainder (equal weights → exactly one gets +1)', () => {
    const three = lenses.slice(0, 3);
    const w = idW(Object.fromEntries(three.map((l) => [l, 1])) as Partial<Record<CreativeLens, number>>);
    const out = allocateExtraIdeators(three, w, 4); // 1,1,1 floors + 1 leftover
    expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(4);
    expect(Object.values(out).filter((n) => n === 2)).toHaveLength(1);
  });

  it('a zero-weight lens gets no extras', () => {
    const out = allocateExtraIdeators(lenses, idW({ analogical: 1 }), 3);
    expect(out.analogical).toBe(3);
    for (const l of lenses) if (l !== 'analogical') expect(out[l]).toBe(0);
  });
});

describe('buildIdeatorRoster (forced-diversity floor)', () => {
  it('default = one ideator per lens, distinct, sequentially indexed', () => {
    const r = buildIdeatorRoster();
    expect(r.map((s) => s.lens)).toEqual([...CREATIVE_LENSES]);
    expect(r.map((s) => s.globalIndex)).toEqual(r.map((_, i) => i));
  });

  it('only the analogical slot carries a seedDomain', () => {
    for (const s of buildIdeatorRoster()) {
      if (s.lens === 'analogical') expect(s.seedDomain).toBeDefined();
      else expect(s.seedDomain).toBeUndefined();
    }
  });

  it('perLens ≥ N gives N per lens; multiple analogical ideators rotate to DISTINCT distant domains', () => {
    const r = buildIdeatorRoster({ perLens: 2, lenses: ['analogical'] });
    expect(r).toHaveLength(2);
    expect(r[0].seedDomain).not.toEqual(r[1].seedDomain); // intra-lens diversity
  });

  it('perLens is floored at 1 (a lens is never silenced) and lenses are de-duplicated', () => {
    const r = buildIdeatorRoster({ perLens: 0, lenses: ['reframing', 'reframing'] });
    expect(r.map((s) => s.lens)).toEqual(['reframing']);
  });

  it('lensWeights + extraIdeatorBudget ADD extras to winning lenses, preserving the floor', () => {
    const r = buildIdeatorRoster({ lensWeights: idW({ analogical: 1 }), extraIdeatorBudget: 2 });
    const byLens = (l: CreativeLens) => r.filter((s) => s.lens === l).length;
    expect(byLens('analogical')).toBe(3); // base 1 + 2 extras
    for (const l of CREATIVE_LENSES) if (l !== 'analogical') expect(byLens(l)).toBe(1);
  });
});

describe('parseIdeasPayload (defensive)', () => {
  it('returns a structured json array / {ideas:[...]} verbatim', () => {
    expect(parseIdeasPayload([{ title: 'a' }], '')).toEqual([{ title: 'a' }]);
    expect(parseIdeasPayload({ ideas: [{ title: 'b' }] }, '')).toEqual([{ title: 'b' }]);
  });

  it('parses the text when json is absent — plain, fenced, and prose-embedded', () => {
    expect(parseIdeasPayload(null, '{"ideas":[{"title":"c"}]}')).toEqual([{ title: 'c' }]);
    expect(parseIdeasPayload(null, '```json\n{"ideas":[{"title":"d"}]}\n```')).toEqual([{ title: 'd' }]);
    expect(parseIdeasPayload(undefined, 'Here: [{"title":"e"}] done')).toEqual([{ title: 'e' }]);
  });

  it('returns [] when nothing parseable is present (never throws)', () => {
    expect(parseIdeasPayload(null, 'no json here at all')).toEqual([]);
    expect(parseIdeasPayload(null, '')).toEqual([]);
    expect(parseIdeasPayload({ notIdeas: 1 }, 'also no json')).toEqual([]);
  });
});

/**
 * NOV-3 throughput (autonomous-loop-prod-audit-2026-07-02 P-016 / WI-4636 /
 * gym-unwedge-scout-novelty-2026-07-02 NOV-3): "11 routed ideas ALL-TIME is no
 * evolutionary pressure" — the per-ideator idea budget was raised 3→4 (env-
 * tunable). A recurrence guard: nothing pins the DEFAULT anywhere else, so an
 * innocuous-looking revert (e.g. "restore the old default") would silently
 * regress throughput with no test failing.
 */
describe('runIdeators — NOV-3 per-ideator idea budget (default raised 3→4)', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'x', ref: 'wi:1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
  };

  const ORIGINAL_ENV = process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR;
    else process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR = ORIGINAL_ENV;
  });

  async function promptTextFor(maxIdeasPerIdeator?: number): Promise<string> {
    let seenSystem = '';
    const llmCall: ScoutLlmCall = async (opts) => {
      seenSystem = opts.system ?? '';
      return { text: '', json: { ideas: [] }, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    };
    await runIdeators(DIGEST, {
      llmCall,
      lenses: ['reframing'],
      ...(maxIdeasPerIdeator !== undefined ? { maxIdeasPerIdeator } : {}),
    });
    return seenSystem;
  }

  it('defaults to "at most 4 ideas" with no explicit cap and no env override', async () => {
    delete process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR;
    expect(await promptTextFor()).toContain('at most 4 ideas');
  });

  it('an explicit maxIdeasPerIdeator overrides the default', async () => {
    delete process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR;
    expect(await promptTextFor(7)).toContain('at most 7 ideas');
  });

  it('PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR raises the default without a deploy', async () => {
    process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR = '9';
    expect(await promptTextFor()).toContain('at most 9 ideas');
  });

  it('a non-positive/invalid env override falls back to the 4 default (never silences ideation)', async () => {
    process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR = '0';
    expect(await promptTextFor()).toContain('at most 4 ideas');
    process.env.PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR = 'not-a-number';
    expect(await promptTextFor()).toContain('at most 4 ideas');
  });
});
