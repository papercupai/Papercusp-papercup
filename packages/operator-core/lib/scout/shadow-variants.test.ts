/**
 * shadow-variants.test.ts — feature pins for the counterfactual critique lab's
 * write/read seam (plan
 * counterfactual-critique-lab-turn-blender-grader-feedback-int-2026-08-13, P-002).
 *
 * These test the three properties D-001 makes load-bearing, each of which is
 * silently violable — a broken one produces a trial that still RUNS and still
 * REPORTS a number, just a meaningless one:
 *
 *   1. the source row is never written to (immutability),
 *   2. every variant gets a `revises` edge back to its source (source-linked),
 *   3. shadow variants never reach an ordinary routed-idea reader (quota exclusion).
 *
 * (3) is asserted against the REAL query text of the three chokepoints rather
 * than against a mock's return value: a stubbed reader returning [] proves
 * nothing about whether the shipped SQL filters. Over a stubbed PG seam, like
 * routed-ledger.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every query text this test's seam saw, in order. */
  queries: [] as string[],
  /** Every parameter list, positionally aligned with `queries`. */
  params: [] as unknown[][],
  /** The source row the SELECT yields (null ⇒ not found). */
  sourceRow: null as Record<string, unknown> | null,
  /** Rows the pair-read yields. */
  pairRows: [] as Record<string, unknown>[],
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const text = strings.join(' ');
        h.queries.push(text);
        h.params.push(vals);
        if (text.includes('FROM harness_shared.scout_routed_ideas') && text.includes('SELECT idea_id, lens')) {
          return Promise.resolve(h.sourceRow ? [h.sourceRow] : []);
        }
        if (text.includes('FROM harness_shared.coord_links l')) return Promise.resolve(h.pairRows);
        return Promise.resolve([]);
      },
      // postgres-js exposes the tag itself as the fragment builder; nested
      // sql`` fragments in the pair query call it with no args in the else-branch.
      { begin: vi.fn(async function (this: unknown, write: (sql: unknown) => Promise<unknown>) {
        return write(this);
      }) },
    ),
  }),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../experiment/producer-lifecycle-store', async (original) => ({
  ...(await original<typeof import('../experiment/producer-lifecycle-store')>()),
  recordProducerObservation: vi.fn(async () => {}),
}));

const {
  recordShadowVariant,
  readShadowVariantPairs,
  shadowVariantIdeaId,
  ShadowVariantSourceError,
} = await import('./shadow-variants');
const { SHADOW_VARIANT_ORIGIN, SHADOW_VARIANT_REL, isShadowVariantOrigin, shadowVariantExclusionSql } =
  await import('./shadow-variant-origin');

/** A graded, feedback-carrying source — the D-002 eligibility shape. */
const eligibleSource = () => ({
  idea_id: 'EI-10869',
  lens: 'cost-leverage',
  rail: 'wi',
  harness_slug: 'papercusp',
  title: 'original idea',
  human_grade: 3,
  human_feedback: 'The mechanism is under-specified; name the failure it prevents.',
  graded_by: 'owner',
});

/**
 * Index of the first captured query matching `re`. The seam joins a tagged
 * template's static parts with ' ', so the recorded text keeps the source's own
 * newlines and indentation — match on a pattern, never an exact literal.
 */
const queryIndex = (re: RegExp): number => h.queries.findIndex((q) => re.test(q));
const LEDGER_INSERT = /INSERT INTO\s+harness_shared\.scout_routed_ideas/i;
const LINK_INSERT = /INSERT INTO\s+harness_shared\.coord_links/i;
/**
 * The shipped exclusion conjunct, as it appears in a tagged-template query.
 * Matches the INTERPOLATED constant, not a bare string literal: a call site that
 * hard-codes `origin <> 'shadow-variant'` is exactly the per-site drift
 * `shadow-variant-origin.ts` exists to prevent, so it should NOT satisfy this.
 */
const EXCLUSION_CONJUNCT = /origin\s*<>\s*\$\{SHADOW_VARIANT_ORIGIN\}/;
// WI-42483: the sibling conjunct in countStalePendingIdeas. Deliberately a
// SEPARATE pattern rather than an alternation on the one above — an alternation
// would let either conjunct satisfy both assertions, which is precisely the
// coverage gap that let the agent-review case ship missing.
const AGENT_REVIEW_EXCLUSION_CONJUNCT = /origin\s*<>\s*\$\{AGENT_REVIEW_LEDGER_ORIGIN\}/;

afterEach(() => {
  h.queries = [];
  h.params = [];
  h.sourceRow = null;
  h.pairRows = [];
});

describe('recordShadowVariant — source immutability (D-001)', () => {
  it('writes a NEW ledger row and never UPDATEs the source', async () => {
    h.sourceRow = eligibleSource();
    await recordShadowVariant({
      sourceIdeaId: 'EI-10869',
      variantIdeaId: 'shadow-variant:trial:EI-10869',
      title: 'revised idea',
      createdBy: 'su-test',
    });
    const all = h.queries.join('\n');
    // The precise invariant: no UPDATE against the ledger at all. A regression
    // that "helpfully" stamped the source (a revised_at, a variant pointer)
    // would still pass every functional test while destroying the baseline the
    // trial measures against.
    expect(all).not.toMatch(/UPDATE\s+harness_shared\.scout_routed_ideas/i);
    expect(all).toMatch(/INSERT INTO\s+harness_shared\.scout_routed_ideas/i);
  });

  it('returns the source as it stood, so the caller records the pre-variant baseline', async () => {
    h.sourceRow = eligibleSource();
    const res = await recordShadowVariant({
      sourceIdeaId: 'EI-10869',
      variantIdeaId: 'v1',
      title: 'revised idea',
    });
    expect(res.source.humanGrade).toBe(3);
    expect(res.source.gradedBy).toBe('owner');
    expect(res.source.humanFeedback).toContain('under-specified');
  });
});

describe('recordShadowVariant — source linkage (D-001)', () => {
  it('writes a revises edge from the variant to its source', async () => {
    h.sourceRow = eligibleSource();
    await recordShadowVariant({
      sourceIdeaId: 'EI-10869',
      variantIdeaId: 'v1',
      title: 'revised idea',
      createdBy: 'su-test',
    });
    const idx = queryIndex(LINK_INSERT);
    expect(idx).toBeGreaterThanOrEqual(0);
    const vals = h.params[idx];
    // Direction matters: variant is the SRC, source is the DST. Reversed, the
    // pair-reader still returns rows — with the two sides swapped, which turns
    // a measured uplift into a measured regression.
    expect(vals).toContain('v1');
    expect(vals).toContain('EI-10869');
    expect(vals).toContain(SHADOW_VARIANT_REL);
    expect(vals.indexOf('v1')).toBeLessThan(vals.indexOf('EI-10869'));
  });

  it('reuses the existing revises rel rather than a lab-private vocabulary', () => {
    expect(SHADOW_VARIANT_REL).toBe('revises');
  });

  it('inherits the source lens and rail so the pair stays comparable', async () => {
    h.sourceRow = { ...eligibleSource(), lens: 'risk-first', rail: 'plan' };
    await recordShadowVariant({ sourceIdeaId: 'EI-10869', variantIdeaId: 'v1', title: 'revised' });
    const idx = queryIndex(LEDGER_INSERT);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(h.params[idx]).toContain('risk-first');
    expect(h.params[idx]).toContain('plan');
  });

  it('stamps the shadow-variant origin on the ledger row', async () => {
    h.sourceRow = eligibleSource();
    await recordShadowVariant({ sourceIdeaId: 'EI-10869', variantIdeaId: 'v1', title: 'revised' });
    const idx = queryIndex(LEDGER_INSERT);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(h.params[idx]).toContain(SHADOW_VARIANT_ORIGIN);
  });
});

describe('recordShadowVariant — refuses an ineligible source, loudly', () => {
  it('refuses a source that does not exist', async () => {
    h.sourceRow = null;
    await expect(
      recordShadowVariant({ sourceIdeaId: 'nope', variantIdeaId: 'v1', title: 't' }),
    ).rejects.toThrow(ShadowVariantSourceError);
    expect(h.queries.join('\n')).not.toMatch(/INSERT INTO/i);
  });

  it('refuses an ungraded source', async () => {
    h.sourceRow = { ...eligibleSource(), human_grade: null };
    await expect(
      recordShadowVariant({ sourceIdeaId: 'EI-1', variantIdeaId: 'v1', title: 't' }),
    ).rejects.toMatchObject({ reason: 'source-ungraded' });
    expect(h.queries.join('\n')).not.toMatch(/INSERT INTO/i);
  });

  it('refuses a source with blank feedback — a variant of it is not feedback-conditioned', async () => {
    h.sourceRow = { ...eligibleSource(), human_feedback: '   ' };
    await expect(
      recordShadowVariant({ sourceIdeaId: 'EI-1', variantIdeaId: 'v1', title: 't' }),
    ).rejects.toMatchObject({ reason: 'source-has-no-feedback' });
    expect(h.queries.join('\n')).not.toMatch(/INSERT INTO/i);
  });
});

describe('shadowVariantIdeaId — a re-run must not inflate the cohort', () => {
  it('is deterministic per (source, trial)', () => {
    expect(shadowVariantIdeaId('EI-1', 'trial-a')).toBe(shadowVariantIdeaId('EI-1', 'trial-a'));
    expect(shadowVariantIdeaId('EI-1', 'trial-a')).not.toBe(shadowVariantIdeaId('EI-2', 'trial-a'));
    expect(shadowVariantIdeaId('EI-1', 'trial-a')).not.toBe(shadowVariantIdeaId('EI-1', 'trial-b'));
  });
});

describe('readShadowVariantPairs', () => {
  it('reports an ungraded variant as a null grade rather than dropping the pair', async () => {
    h.pairRows = [
      {
        source_idea_id: 'EI-1',
        variant_idea_id: 'v1',
        lens: 'cost-leverage',
        source_title: 'a',
        variant_title: 'b',
        source_grade: 3,
        variant_grade: null,
        source_feedback: 'crit',
        variant_feedback: null,
        source_graded_by: 'owner',
        variant_graded_by: null,
      },
    ];
    const pairs = await readShadowVariantPairs();
    expect(pairs).toHaveLength(1);
    // "graded, no uplift" and "never graded" must stay distinguishable — P-004
    // reports uncertainty explicitly, which it cannot do if the reader collapses
    // an incomplete trial into a complete-looking one.
    expect(pairs[0].sourceGrade).toBe(3);
    expect(pairs[0].variantGrade).toBeNull();
  });

  it('only walks revises edges between routed-idea endpoints, and only to shadow variants', async () => {
    await readShadowVariantPairs();
    const q = h.queries.find((t) => t.includes('FROM harness_shared.coord_links l'));
    expect(q).toBeDefined();
    expect(q).toMatch(/l\.rel\s*=/);
    expect(q).toMatch(/var\.origin\s*=/);
  });
});

describe('ordinary-quota exclusion is enforced in the shipped SQL (D-001)', () => {
  it('exposes the vocabulary as one shared constant', () => {
    expect(SHADOW_VARIANT_ORIGIN).toBe('shadow-variant');
    expect(isShadowVariantOrigin('shadow-variant')).toBe(true);
    expect(isShadowVariantOrigin('scout')).toBe(false);
    expect(isShadowVariantOrigin(null)).toBe(false);
    expect(shadowVariantExclusionSql()).toContain("origin <> 'shadow-variant'");
    expect(shadowVariantExclusionSql('r')).toContain("r.origin <> 'shadow-variant'");
  });

  // Read the shipped source rather than calling the readers: these three are the
  // chokepoints where a shadow variant would otherwise enter a PRODUCTION signal
  // (the Mug's meta-pattern digest, Scout's novelty corpus, the ungraded-filings
  // census). A future edit that drops one of these conjuncts is the regression
  // this file exists to catch, and it would not fail any behavioral test.
  it.each([
    ['./routed-ledger.ts', 'readRoutedIdeas origin:all → the Mug meta-pattern digest'],
    ['./cycle-deps.ts', 'readNoveltyCorpus → Scout idea generation'],
    ['./ungraded-scope.ts', 'readUngradedBreakdown → the ungraded-filings census'],
    ['../system-health/compute.ts', '24h graded count → the grading-loop health verdict'],
  ])('%s excludes the shadow-variant origin (%s)', async (file) => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    expect(src).toMatch(EXCLUSION_CONJUNCT);
  });

  /**
   * routed-ledger.ts carries TWO independent exclusions and the file-level grep
   * above is satisfied by either one, so the second is pinned by name. This is
   * the one an audit caught after the first three shipped
   * (counterfactual-critique-lab, 2026-08-13): countStalePendingIdeas takes no
   * origin option, and a shadow variant matches its stale-pending predicate
   * FOREVER — no rail artifact to reach a terminal state, and the
   * outcome-refresh sweeps that would classify it are origin-scoped. Uncovered,
   * the trial's own rows become permanent stuck-idea alerts escalating to a
   * human. Asserted on the function body, not the file, so deleting THIS
   * conjunct fails even while the others stand.
   */
  it('countStalePendingIdeas excludes shadow variants (they are stale-pending forever)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./routed-ledger.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export async function countStalePendingIdeas');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    expect(body).toMatch(EXCLUSION_CONJUNCT);
  });

  /**
   * WI-42483 — the SAME defect as the test above, at the SAME call site, for the
   * other non-learning origin. agent-review enrollment rows share every property
   * that motivated the shadow-variant conjunct: originClause's docstring excludes
   * both from the 'all' origin because neither feeds production learning, and
   * neither has a rail artifact that can reach a terminal state, so their
   * outcome/outcome_checked_at stay NULL forever and they match the stale-pending
   * predicate permanently.
   *
   * The shadow-variant conjunct shipped 2026-08-13 and this one did not, which is
   * why it is worth pinning rather than trusting the pair to stay in step: the
   * asymmetry survived because the alert is LATENT (the sweep's verification phase
   * is preempted while the ungraded frontier is undrained), so nothing fired to
   * reveal it. Measured 2026-08-27 on papercusp-workspace: 745 agent-review rows,
   * every one never outcome-checked, against shadow-variant's 20 — the uncovered
   * case was 37x the covered one.
   *
   * Asserted on the function body, not the file, for the same reason as above:
   * deleting THIS conjunct must fail even while the shadow-variant one stands.
   */
  it('countStalePendingIdeas excludes agent-review rows (stale-pending forever, same as shadow variants)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./routed-ledger.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export async function countStalePendingIdeas');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport ', start + 1));
    expect(body).toMatch(AGENT_REVIEW_EXCLUSION_CONJUNCT);
  });

  /**
   * CALIBRATION CONTROL for the assertion directly above, mirroring the one that
   * guards the shadow-variant greps. Without it, a loosened pattern (or a path
   * that silently reads the wrong file) would keep "passing" forever. The
   * shadow-variant conjunct is the ideal negative case: it is a real, adjacent,
   * nearly-identical line in the SAME function, so a pattern sloppy enough to
   * match it is exactly the pattern that would stop discriminating.
   */
  it('the agent-review exclusion pattern is falsifiable — it does NOT match the shadow-variant conjunct', () => {
    expect('AND origin <> ${SHADOW_VARIANT_ORIGIN}').not.toMatch(AGENT_REVIEW_EXCLUSION_CONJUNCT);
    expect('AND origin <> ${AGENT_REVIEW_LEDGER_ORIGIN}').toMatch(AGENT_REVIEW_EXCLUSION_CONJUNCT);
  });

  // CALIBRATION CONTROL. The three assertions above are source greps, and a
  // source grep that cannot fail certifies nothing — the standing risk is a
  // pattern loosened until it matches anything (or a path that silently reads
  // the wrong file, which also "passes"). Pin the negative case against a
  // sibling that legitimately carries no exclusion, so the day the pattern stops
  // discriminating, THIS test fails rather than the three above quietly passing
  // forever. Done as a control instead of a mutation probe deliberately: the
  // tree is shared and swept by git-sync every few minutes, so mutating a real
  // source file to prove falsifiability can commit the mutant.
  it('the exclusion pattern is falsifiable — it does NOT match a file without the conjunct', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./routed-ledger.test.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(EXCLUSION_CONJUNCT);
  });
});
