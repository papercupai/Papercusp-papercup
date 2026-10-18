/**
 * lenses — unit coverage for the forced-diversity engine (P-004 / D-004). Pure +
 * deterministic, so the anti-mode-collapse invariant (distinct lenses ⇒
 * pairwise-distinct system prompts; distinct distant domains ⇒ distinct prompts)
 * is pinned directly, alongside the digest flatten/render and pool rotation.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';
import {
  isLensIdentityId,
  LENS_IDENTITY_ID_LIST,
  lensForIdentityId,
  lensIdentityDocumentPath,
  lensIdentityId,
  renderLensIdentity,
  buildIdeatorPrompt,
  buildRubricFocus,
  flattenDigest,
  digestRefSet,
  renderDigest,
  assignDistantDomain,
  defaultLensRoster,
  LENS_REGISTRY,
  DISTANT_DOMAINS,
  DEFAULT_IDEATOR_MISSION,
  type DistantDomain,
} from './lenses';
import { CREATIVE_LENSES } from './types';
import type { CorpusDigest, MetaPattern } from './types';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  computeLensOutcomesFromCached,
  type RoutedIdeaProvenance,
} from './outcome-feedback';
import type { ChangeFeedEntry } from '../curation/change-feed';
import { pickNewestLensWeightScope } from './routed-ledger';

const pat = (ref: string, summary = `pattern ${ref}`): MetaPattern => ({ ref, summary }) as MetaPattern;
const digest = (over: Partial<CorpusDigest> = {}): CorpusDigest =>
  ({ recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [], ...over }) as CorpusDigest;

describe('buildIdeatorPrompt — anti-mode-collapse + lens stance', () => {
  const d = digest({ recurringFriction: [pat('wi:1', 'spawn latency spikes')] });

  it('distinct lenses yield pairwise-distinct system prompts (no mode collapse)', () => {
    const systems = CREATIVE_LENSES.map((lens) => buildIdeatorPrompt({ lens, digest: d }).system);
    expect(new Set(systems).size).toBe(CREATIVE_LENSES.length); // all distinct
    for (const lens of CREATIVE_LENSES) {
      const s = buildIdeatorPrompt({ lens, digest: d }).system;
      expect(s).toContain(renderLensIdentity(lens));
      expect(LENS_REGISTRY[lens].identityId).toBe(`scout.lens-${lens}`);
    }
  });

  it('R-8: each lens prompt is rendered from its identity document, and an installed override wins', () => {
    for (const lens of CREATIVE_LENSES) {
      const text = renderLensIdentity(lens);
      expect(text).toMatch(/^## Your lens: .+\n\S/);
      const doc = readFileSync(join(harnessRoot(), lensIdentityDocumentPath(lens)), 'utf8').trim();
      expect(text).toBe(doc);
    }
    const local = mkdtempSync(join(tmpdir(), 'scout-lens-override-'));
    try {
      mkdirSync(join(local, 'blueprints', 'scout.lens-reframing', 'prompts'), { recursive: true });
      writeFileSync(join(local, lensIdentityDocumentPath('reframing')), '## Your lens: Local reframing\nA hive-local stance.\n');
      const roots = [local, harnessRoot()];
      expect(renderLensIdentity('reframing', { identityRoots: roots })).toBe('## Your lens: Local reframing\nA hive-local stance.');
      expect(buildIdeatorPrompt({ lens: 'reframing', digest: d, identityRoots: roots }).system).toContain('A hive-local stance.');
      // A root list that carries no lens document refuses: a lens never renders silently missing.
      expect(() => renderLensIdentity('analogical', { identityRoots: [local] })).toThrow(/identity document blueprints\/scout\.lens-analogical\/prompts\/lens\.md not found/);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('R-8: lens identity ids round-trip and nothing else is a lens identity', () => {
    expect(LENS_IDENTITY_ID_LIST).toEqual(CREATIVE_LENSES.map((l) => `scout.lens-${l}`));
    for (const lens of CREATIVE_LENSES) expect(lensForIdentityId(lensIdentityId(lens))).toBe(lens);
    expect(lensForIdentityId('analogical')).toBeNull();
    expect(isLensIdentityId('scout.lens-analogical')).toBe(true);
    expect(isLensIdentityId('reframing')).toBe(false);
  });

  it('R-8: the lens module carries no inline lens prompt text (stances live in identity documents)', () => {
    const src = readFileSync(join(__dirname, 'lenses.ts'), 'utf8');
    expect(src).not.toMatch(/stance:\s*\[/);
    expect(src).not.toMatch(/## Your lens: \$\{/);
    for (const lens of CREATIVE_LENSES) {
      const firstSentence = renderLensIdentity(lens).split('\n')[1].split('. ')[0];
      expect(src).not.toContain(firstSentence);
    }
  });

  it('the analogical lens primes a distant domain; distinct domains yield distinct prompts', () => {
    const a = buildIdeatorPrompt({
      lens: 'analogical',
      digest: d,
      seedDomain: { key: 'immune-systems', prime: 'self vs non-self tagging' } as DistantDomain,
    }).system;
    const b = buildIdeatorPrompt({
      lens: 'analogical',
      digest: d,
      seedDomain: { key: 'jazz-ensembles', prime: 'turn-taking improvisation' } as DistantDomain,
    }).system;
    expect(a).toContain('immune-systems: self vs non-self tagging');
    expect(a).toContain('## Your primed distant domain');
    expect(a).toContain('"seedDomain"'); // the analogical-only JSON output field
    expect(a).not.toBe(b);
  });

  it('a non-distant-domain lens omits the distant-domain section + the seedDomain JSON field', () => {
    const s = buildIdeatorPrompt({ lens: 'first-principles', digest: d }).system;
    expect(s).not.toContain('primed distant domain');
    expect(s).not.toContain('seedDomain');
  });

  it('the analogical lens with no seedDomain falls back to the "no domain assigned" instruction', () => {
    expect(buildIdeatorPrompt({ lens: 'analogical', digest: d }).system).toContain('no domain assigned');
  });

  it('honors the mission override + maxIdeas + appends non-blank priming to the user prompt', () => {
    const r = buildIdeatorPrompt({
      lens: 'reframing',
      digest: d,
      mission: 'CUSTOM MISSION',
      maxIdeas: 7,
      priming: '  prior elites here  ',
    });
    expect(r.system).toContain('CUSTOM MISSION');
    expect(r.system).not.toContain(DEFAULT_IDEATOR_MISSION);
    expect(r.system).toContain('at most 7 ideas');
    expect(r.user).toContain('prior elites here');
    expect(buildIdeatorPrompt({ lens: 'reframing', digest: d, priming: '   ' }).user).not.toContain('prior elites');
  });

  // EI-18801316749542776 — Scout analogical ideas proposed capabilities that already
  // existed in the tree, and cited incidents whose own description contradicted the
  // claimed mechanism (a local rate-governor pause treated as an upstream HTTP 429).
  // Every ideator prompt must carry both self-checks, regardless of lens.
  it('every lens carries the EXISTENCE CHECK + EVIDENCE-CLASS CHECK rules (EI-18801316749542776)', () => {
    for (const lens of CREATIVE_LENSES) {
      const s = buildIdeatorPrompt({ lens, digest: d }).system;
      expect(s).toContain('EXISTENCE CHECK');
      expect(s).toContain('EVIDENCE-CLASS CHECK');
    }
  });
});

describe('flattenDigest / digestRefSet / renderDigest', () => {
  const d = digest({
    headline: 'busy week',
    recurringFriction: [pat('wi:1', 'A')],
    capabilityGaps: [pat('gap:2', 'B')],
    rubricRatings: [pat('rub:3', 'C')],
    spendAnomalies: [pat('spend:4', 'D')],
    ownerCorrections: [pat('owner-correction:5', 'E')],
    knowledgeReuseGaps: [pat('knowledge:6', 'F')],
    planHealth: [pat('plan-health:7', 'G')],
    recentCommits: [pat('commit-churn:8', 'H')],
  } as Partial<CorpusDigest>);

  it('flattenDigest collapses all lanes, stamping each pattern with its category lane', () => {
    const flat = flattenDigest(d);
    expect(flat.map((p) => p.ref).sort()).toEqual([
      'commit-churn:8',
      'gap:2',
      'knowledge:6',
      'owner-correction:5',
      'plan-health:7',
      'rub:3',
      'spend:4',
      'wi:1',
    ]);
    expect(flat.find((p) => p.ref === 'wi:1')!.category).toBe('recurring-friction');
    expect(flat.find((p) => p.ref === 'rub:3')!.category).toBe('rubric-rating');
    expect(flat.find((p) => p.ref === 'spend:4')!.category).toBe('spend-anomaly');
    expect(flat.find((p) => p.ref === 'owner-correction:5')!.category).toBe('owner-correction');
    expect(flat.find((p) => p.ref === 'knowledge:6')!.category).toBe('knowledge-reuse-gap');
    expect(flat.find((p) => p.ref === 'plan-health:7')!.category).toBe('plan-health');
    expect(flat.find((p) => p.ref === 'commit-churn:8')!.category).toBe('recent-commit');
  });

  it('flattenDigest tolerates missing lanes (?? [])', () => {
    expect(flattenDigest({ recurringFriction: [pat('wi:1')] } as CorpusDigest).map((p) => p.ref)).toEqual(['wi:1']);
  });

  it('digestRefSet is the set of every ref across the lanes', () => {
    expect([...digestRefSet(d)].sort()).toEqual([
      'commit-churn:8',
      'gap:2',
      'knowledge:6',
      'owner-correction:5',
      'plan-health:7',
      'rub:3',
      'spend:4',
      'wi:1',
    ]);
  });

  it('renderDigest shows the headline + a category-tagged line per pattern with its ref', () => {
    const out = renderDigest(d);
    expect(out).toContain('State of the Hive: busy week');
    expect(out).toContain('(ref: wi:1)');
    expect(out).toContain('[Recurring friction]');
    expect(out).toContain('[Rubric rating]');
    expect(out).toContain('[Spend anomaly');
    expect(out).toContain('[Owner correction');
    expect(out).toContain('[Knowledge reuse gap');
    expect(out).toContain('[Plan health');
  });

  it('renderDigest on an empty digest reports no patterns surfaced', () => {
    expect(renderDigest(digest())).toContain('(no meta-patterns surfaced this cycle)');
  });
});

describe('renderDigest DELTA-FIRST split (blender-self-learning-2026-07-12 P-003 / WI-4319)', () => {
  const d = digest({
    headline: 'busy week',
    recurringFriction: [pat('wi:1', 'A')],
    capabilityGaps: [pat('gap:2', 'B')],
    rubricRatings: [pat('rub:3', 'C')],
  } as Partial<CorpusDigest>);

  it('splits NEW-first / standing-after when previousCycleRefs is stamped', () => {
    const out = renderDigest({ ...d, previousCycleRefs: ['wi:1', 'rub:3'] });
    const newIdx = out.indexOf('## NEW since your last cycle');
    const standingIdx = out.indexOf('## Standing patterns');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(standingIdx).toBeGreaterThan(newIdx);
    // gap:2 is the only fresh pattern — it renders in the NEW section (before
    // the standing header); wi:1 + rub:3 render after it.
    expect(out.indexOf('(ref: gap:2)')).toBeLessThan(standingIdx);
    expect(out.indexOf('(ref: wi:1)')).toBeGreaterThan(standingIdx);
    expect(out.indexOf('(ref: rub:3)')).toBeGreaterThan(standingIdx);
  });

  it('every ref still renders exactly once (grounding contract unchanged by the split)', () => {
    const out = renderDigest({ ...d, previousCycleRefs: ['wi:1'] });
    for (const ref of ['wi:1', 'gap:2', 'rub:3']) {
      expect(out.split(`(ref: ${ref})`).length - 1).toBe(1);
    }
  });

  it('all-standing (nothing new) says so explicitly instead of an empty section', () => {
    const out = renderDigest({ ...d, previousCycleRefs: ['wi:1', 'gap:2', 'rub:3'] });
    expect(out).toContain('(no new patterns since your last cycle');
    expect(out).toContain('## Standing patterns');
  });

  it('all-new (no overlap) renders the NEW section with no standing section', () => {
    const out = renderDigest({ ...d, previousCycleRefs: ['stale:gone'] });
    expect(out).toContain('## NEW since your last cycle');
    expect(out).not.toContain('## Standing patterns');
  });

  it('LEGACY UNCHANGED: absent/empty previousCycleRefs renders the flat whole digest byte-identically', () => {
    const legacy = renderDigest(d);
    expect(legacy).not.toContain('## NEW since your last cycle');
    expect(legacy).not.toContain('## Standing patterns');
    expect(renderDigest({ ...d, previousCycleRefs: [] })).toBe(legacy);
  });
});

describe('assignDistantDomain + defaultLensRoster', () => {
  it('rotates the distant-domain pool by index % length (intra-lens diversity)', () => {
    const order = [
      { key: 'a', prime: '1' },
      { key: 'b', prime: '2' },
      { key: 'c', prime: '3' },
    ] as DistantDomain[];
    expect(assignDistantDomain(0, order).key).toBe('a');
    expect(assignDistantDomain(1, order).key).toBe('b');
    expect(assignDistantDomain(3, order).key).toBe('a'); // wraps
    expect(assignDistantDomain(0).key).toBe(DISTANT_DOMAINS[0].key); // real non-empty pool → never throws
  });

  it('defaultLensRoster is one ideator per lens (distinct four-way divergence)', () => {
    expect([...defaultLensRoster()].sort()).toEqual([...CREATIVE_LENSES].sort());
    expect(new Set(defaultLensRoster()).size).toBe(defaultLensRoster().length);
  });
});

describe('deterministic rubric seeding (blender-self-learning-2026-07-12 P-004)', () => {
  const withRubrics = digest({
    rubricRatings: [
      pat('rubric:r1#a@h', 'worst'),
      pat('rubric:r1#b@h', 'second'),
      pat('rubric:r2#c@h', 'third'),
      pat('rubric:r2#d@h', 'fourth'),
    ],
  } as Partial<CorpusDigest>);

  it('buildRubricFocus renders the worst-first top-K with citable refs', () => {
    const focus = buildRubricFocus(withRubrics)!;
    expect(focus).toContain('(ref: rubric:r1#a@h) worst');
    expect(focus).toContain('(ref: rubric:r2#c@h) third');
    expect(focus).not.toContain('fourth'); // default limit 3
  });

  it('buildRubricFocus is undefined when the lane is empty (no forced focus)', () => {
    expect(buildRubricFocus(digest())).toBeUndefined();
  });

  it('the prompt gains a MANDATORY rubric-focus section when supplied — and not otherwise', () => {
    const seeded = buildIdeatorPrompt({
      lens: 'reframing',
      digest: withRubrics,
      rubricFocus: buildRubricFocus(withRubrics)!,
    });
    expect(seeded.system).toContain('## Rubric focus');
    expect(seeded.system).toContain('MUST address one of them');
    expect(seeded.system).toContain('rubric:r1#a@h');
    const unseeded = buildIdeatorPrompt({ lens: 'reframing', digest: withRubrics });
    expect(unseeded.system).not.toContain('## Rubric focus');
  });
});

/**
 * scout-su-ideate-pipeline-gaps-2026-10-08 P-008 / R-19: the lens weights the scout cycle
 * samples from are computed from the CORRECTED routed-idea outcomes, and the reader serves
 * the scope those outcomes last produced — never a retired scope's stale weights.
 */
describe('lens weights use corrected outcomes (P-008 / R-19)', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const feedEntry = (ref: string, detail: string): ChangeFeedEntry =>
    ({ id: ref, kind: 'completion', title: `Closed: ${ref}`, detail, ref, ts: at }) as ChangeFeedEntry;
  const row = (p: Partial<RoutedIdeaProvenance> & Pick<RoutedIdeaProvenance, 'ideaId' | 'lens' | 'routedRef'>): RoutedIdeaProvenance =>
    ({ rail: 'improvement', ...p }) as RoutedIdeaProvenance;

  const provenance: RoutedIdeaProvenance[] = [
    row({ ideaId: 'a-won', lens: 'analogical', routedRef: 'wi:EI-1' }),
    row({ ideaId: 'a-lost', lens: 'analogical', routedRef: 'wi:EI-2' }),
    row({ ideaId: 'r-won', lens: 'reframing', routedRef: 'wi:EI-3' }),
    row({ ideaId: 'r-open', lens: 'reframing', routedRef: 'wi:EI-4' }),
    row({ ideaId: 'f-graded', lens: 'first-principles', routedRef: 'wi:EI-5', humanGrade: 5 }),
    row({ ideaId: 'c-gym', lens: 'constraint-removal', routedRef: 'gym:SP-77-001', rail: 'gym' }),
    row({ ideaId: 'c-legacy', lens: 'constraint-removal', routedRef: 'gym:SP-012', rail: 'gym' }),
  ];
  const completions = [
    feedEntry('wi:EI-1', 'Status: done'),
    feedEntry('wi:EI-2', 'Status: dropped'),
    feedEntry('wi:EI-3', 'Status: resolved'),
  ];
  const pausedRails = new Set(['gym'] as const);
  /** What refreshScoutOutcomes persists: one classification per row, written to `outcome`. */
  const cached = (): RoutedIdeaProvenance[] => {
    const byRef = new Map(completions.map((e) => [e.ref, e]));
    return provenance.map((p) => ({ ...p, outcome: classifyIdeaOutcome(p, byRef, { pausedRails }) }));
  };

  it('a recompute from the cached corrected outcomes reproduces the refresh-time lens weights exactly', () => {
    const live = computeLensOutcomes(provenance, completions, { pausedRails });
    const recomputed = computeLensOutcomesFromCached(cached(), { pausedRails });
    for (const lens of CREATIVE_LENSES) {
      expect(recomputed.byLens[lens]).toEqual(live.byLens[lens]);
    }
    // Paused-rail and legacy-gym rows stay out of every denominator in both.
    expect(recomputed.byLens['constraint-removal']).toMatchObject({ routed: 0, unresolvable: 2 });
    // A grade still dominates (C-5 / D-002).
    expect(recomputed.byLens['first-principles']).toMatchObject({ won: 1, lost: 0 });
  });

  it('FALSIFIER: a weight derived from an outcome the corrected resolver reads differently is visible', () => {
    const live = computeLensOutcomes(provenance, completions, { pausedRails });
    // The corrected resolver read a-lost as 'lost'; a weight built from a stale 'won' differs.
    const drifted = cached().map((p) => (p.ideaId === 'a-lost' ? { ...p, outcome: 'won' as const } : p));
    const recomputed = computeLensOutcomesFromCached(drifted, { pausedRails });
    expect(recomputed.byLens.analogical.weight).not.toBe(live.byLens.analogical.weight);
  });

  it('the weight reader serves the newest scope, never a retired scope listed after it (live 2026-10-08 shape)', () => {
    const fresh = '2026-10-08T15:36:29.848Z';
    const stale = '2026-08-02T02:05:36.501Z';
    const picked = pickNewestLensWeightScope([
      { lens: 'scout.lens-analogical', weight: '0.1926', potSlug: 'papercusp-workspace', updatedAt: fresh },
      { lens: 'scout.lens-reframing', weight: '0.2737', potSlug: 'papercusp-workspace', updatedAt: fresh },
      // Retired scopes, last in heap order: an old last-row-wins fold returned these.
      { lens: 'scout.lens-analogical', weight: '0.2592', potSlug: 'papercusp', updatedAt: stale },
      { lens: 'scout.lens-reframing', weight: '0.2669', potSlug: '@singleton', updatedAt: stale },
    ]);
    expect(picked.potSlug).toBe('papercusp-workspace');
    expect(picked.weights).toEqual({ 'scout.lens-analogical': 0.1926, 'scout.lens-reframing': 0.2737 });
    expect(picked.updatedAtMs).toBe(Date.parse(fresh));
  });

  it('ties pick deterministically; legacy rows without scope metadata keep every valid weight', () => {
    const t = '2026-09-01T00:00:00.000Z';
    const tie = pickNewestLensWeightScope([
      { lens: 'scout.lens-analogical', weight: 0.4, potSlug: 'b', updatedAt: t },
      { lens: 'scout.lens-analogical', weight: 0.6, potSlug: 'a', updatedAt: t },
    ]);
    expect(tie.potSlug).toBe('a');
    expect(tie.weights).toEqual({ 'scout.lens-analogical': 0.6 });
    const legacy = pickNewestLensWeightScope([
      { lens: 'scout.lens-analogical', weight: 0.3, potSlug: null, updatedAt: null },
      { lens: 'scout.lens-reframing', weight: '0.7', potSlug: null, updatedAt: null },
      { lens: 'not-a-lens', weight: 0.9, potSlug: null, updatedAt: null },
    ]);
    expect(legacy.weights).toEqual({ 'scout.lens-analogical': 0.3, 'scout.lens-reframing': 0.7 });
    expect(pickNewestLensWeightScope([]).weights).toEqual({});
  });

  it('R-8: weights are keyed by lens identity id — a bare lens-name row (pre-R-8 key) is ignored', () => {
    const t = '2026-10-18T00:00:00.000Z';
    const mixed = pickNewestLensWeightScope([
      { lens: 'analogical', weight: 0.9, potSlug: 'p', updatedAt: t },
      { lens: 'scout.lens-analogical', weight: 0.2, potSlug: 'p', updatedAt: t },
      { lens: 'reframing', weight: 0.8, potSlug: 'p', updatedAt: t },
    ]);
    expect(mixed.weights).toEqual({ 'scout.lens-analogical': 0.2 });
    for (const key of Object.keys(mixed.weights)) expect(isLensIdentityId(key)).toBe(true);
  });
});
