/**
 * routed-ledger-model-provenance.test.ts — migration 947 /
 * learning-loop-backlog-triage-2026-08-22 P-010.
 *
 * WHAT THIS PINS, and why each pin exists rather than being obvious:
 *
 *  1. A recorded model is PERSISTED. The plain forward case.
 *  2. An UNKNOWN model is persisted as NULL, never as the configured default.
 *     This is the load-bearing one. The audit that commissioned P-010 could not
 *     answer "which model wrote this idea?" because nothing recorded it; the
 *     failure mode when closing such a gap is to helpfully fill the blank from
 *     whatever is configured at write time, which converts "unknown" into
 *     "confidently wrong" and is strictly worse than the gap. A test that only
 *     covered case 1 would pass against that bug.
 *  3. A re-record that omits the model does NOT erase a previously-stamped one.
 *     `blender:route-idea` re-records rows on a rail hop; a bare EXCLUDED in the
 *     ON CONFLICT would null the provenance the producing cycle wrote. This is
 *     the same defect class already fixed for `addresses_pattern_refs` (EI-10607)
 *     — the fix was reapplied here deliberately, so it is pinned here too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every statement the seam issued, rendered with its values inlined. */
  rendered: [] as string[],
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => {
      // Render the tagged template back into one inspectable string so an
      // assertion can see BOTH the column list and the bound value that lands in
      // it. Asserting on `strings` alone cannot distinguish "wrote the model" from
      // "wrote null into the model column".
      h.rendered.push(
        strings.reduce(
          (acc, s, i) => acc + s + (i < vals.length ? JSON.stringify(vals[i] ?? null) : ''),
          '',
        ),
      );
      return Promise.resolve([]);
    }, { begin: vi.fn(async function (this: unknown, write: (sql: unknown) => Promise<unknown>) {
      return write(this);
    }) }),
  }),
}));

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// Lifecycle receipt persistence has its own transactional integration coverage.
// Keep this unit seam focused on the provenance SQL while executing the real
// transaction callback above (an empty begin mock silently skipped the write).
vi.mock('../experiment/producer-lifecycle-store', async (original) => ({
  ...(await original<typeof import('../experiment/producer-lifecycle-store')>()),
  recordProducerObservation: vi.fn(async () => {}),
}));
vi.mock('../hive-federation', () => ({ potHomeSlugForHarness: async () => 'papercusp' }));

const { recordRoutedIdea } = await import('./routed-ledger');

/** The fields every call needs; individual tests vary only what they are pinning. */
const base = {
  ideaId: 'cycle-1:scout-idea-analogical-0-0',
  lens: 'analogical' as const,
  rail: 'improvement' as const,
  routedRef: 'wi:EI-1',
  harnessSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
};

const insert = () => h.rendered.find((q) => q.includes('INSERT INTO harness_shared.scout_routed_ideas')) ?? '';

afterEach(() => {
  h.rendered = [];
});

describe('recordRoutedIdea — model provenance (migration 947 / P-010)', () => {
  it('persists the model spec and config it was given', async () => {
    await recordRoutedIdea({
      ...base,
      modelSpec: 'gpt-5.6-sol:xhigh',
      modelConfig: { models: { ideator: 'gpt-5.6-sol:xhigh' }, lensRoster: ['analogical'] },
    });
    const q = insert();
    expect(q).toContain('model_spec');
    expect(q).toContain('model_config');
    expect(q).toContain('gpt-5.6-sol:xhigh');
    expect(q).toContain('lensRoster');
    // POSITIVE CONTROL for the absence assertion in the next test. That test proves
    // a model id is ABSENT when none was supplied — which passes just as happily if
    // the regex is wrong, if `insert()` returns '', or if the seam stopped rendering
    // values at all. Running the SAME regex here, where a model id genuinely IS
    // present, is what separates "measured absent" from "instrument broken".
    expect(q).toMatch(/gpt-|claude-|opus|sonnet|haiku/i);
  });

  it('writes NULL — never a configured default — when the producer did not record a model', async () => {
    await recordRoutedIdea(base);
    const q = insert();
    // The columns are still written (so the shape is stable)…
    expect(q).toContain('model_spec');
    // …but nothing that looks like a model id may appear. This is the assertion
    // that fails if someone "helpfully" defaults the column from
    // DEFAULT_SCOUT_MODELS / LEARNING_MODEL_SPEC at write time.
    expect(q).not.toMatch(/gpt-|claude-|opus|sonnet|haiku/i);
  });

  it('a re-record that omits the model does not erase an already-stamped one', async () => {
    await recordRoutedIdea(base);
    const q = insert();
    // COALESCE(EXCLUDED.x, existing.x) — the rail-hop-safe form. A bare
    // `model_spec = EXCLUDED.model_spec` would silently null real provenance.
    expect(q).toMatch(/model_spec\s*=\s*COALESCE\(EXCLUDED\.model_spec/);
    expect(q).toMatch(/model_config\s*=\s*COALESCE\(EXCLUDED\.model_config/);
  });
});
