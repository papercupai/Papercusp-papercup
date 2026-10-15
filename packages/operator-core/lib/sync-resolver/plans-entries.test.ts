/**
 * plans.* named-query resolvers — verify each entry dispatches the right
 * plans:* read verb and unwraps the tool envelope to a flat row array.
 * The canonical tool dispatch (read-dispatch.ts) is mocked, so this is a
 * pure unwrap-contract test (no tool host / filesystem needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const callPlansRead = vi.fn();
vi.mock('../agent-tools/plans/read-dispatch', () => ({
  callPlansRead: (...a: unknown[]) => callPlansRead(...a),
  callPlansReadRaw: vi.fn(),
}));

// This is the verb-dispatch + envelope-unwrap contract test. The B1 plan
// ownership/attribution enrichment (ownerIdentity/lastEditor/per-item author)
// is a SEPARATE concern behind the papercusp-plan-attribution-badges flag and
// has its own test (plan-attribution.test.ts) — keep it OFF here so plans.list /
// plans.get assert the pure unwrapped shape.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

import { resolveNamedQueryV2 } from '.';

beforeEach(() => callPlansRead.mockReset());

describe('plans.* resolvers — verb dispatch + envelope unwrap', () => {
  it('plans.list → list verb, unwraps .plans, passes args through', async () => {
    callPlansRead.mockResolvedValue({ plans: [{ slug: 'a' }, { slug: 'b' }] });
    const rows = await resolveNamedQueryV2('plans.list', { includeArchived: true });
    expect(callPlansRead).toHaveBeenCalledWith('list', { includeArchived: true });
    expect(rows).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });

  it('plans.items → items verb, unwraps .items', async () => {
    callPlansRead.mockResolvedValue({ items: [{ plan: 'a' }] });
    expect(await resolveNamedQueryV2('plans.items', { needsHuman: true })).toEqual([{ plan: 'a' }]);
    expect(callPlansRead).toHaveBeenCalledWith('items', { needsHuman: true });
  });

  it('plans.attention → attention verb, unwraps .groups', async () => {
    callPlansRead.mockResolvedValue({ groups: [{ key: 'g1' }] });
    expect(await resolveNamedQueryV2('plans.attention', { harnessSlug: 'x' })).toEqual([{ key: 'g1' }]);
  });

  it('forwards the Inbox first-page request and preserves the exact report reference', async () => {
    const report = { plans: [], goalReport: { schemaVersion: 1, goalId: 'goal-fixture',
      reportId: 'rpt_fixture', bodySha256: 'a'.repeat(64) } };
    const groups = [{ key: 'messages', items: [{ id: 'coord-message:fixture', report }] }];
    callPlansRead.mockResolvedValue({ groups });
    expect(await resolveNamedQueryV2('plans.attention', { limit: 100, offset: 0 })).toEqual(groups);
    expect(callPlansRead).toHaveBeenCalledWith('attention', { limit: 100, offset: 0 });
  });

  it('attention counts request the compact source projection and preserve degraded results', async () => {
    const counts = { decisionItems: 2, decisionPlans: 1, alerts: 0, total: 2 };
    callPlansRead.mockResolvedValue({ counts, degraded: true });
    expect(await resolveNamedQueryV2('plans.attentionCounts', {})).toEqual([{ ...counts, degraded: true }]);
    expect(callPlansRead).toHaveBeenCalledWith('attention', { output: 'counts' });
  });

  it('attention refs request the compact source projection and reject a false empty fallback', async () => {
    const refs = [{ id: 'd1', itemRef: 'plan:a#P-001', planSlug: 'a' }];
    callPlansRead.mockResolvedValueOnce({ refs, degraded: false });
    expect(await resolveNamedQueryV2('plans.attentionRefs', {})).toEqual(refs);
    expect(callPlansRead).toHaveBeenCalledWith('attention', { output: 'refs' });
    callPlansRead.mockResolvedValueOnce({ refs: [], degraded: true });
    await expect(resolveNamedQueryV2('plans.attentionRefs', {})).rejects.toThrow('Attention refs unavailable');
  });

  it('plans.search → search verb, unwraps .hits', async () => {
    callPlansRead.mockResolvedValue({ hits: [{ plan: 'a', score: 1 }] });
    expect(await resolveNamedQueryV2('plans.search', { query: 'q' })).toEqual([{ plan: 'a', score: 1 }]);
  });

  it('plans.get → get verb, wraps the single object in a 1-element array', async () => {
    callPlansRead.mockResolvedValue({ slug: 'a', raw: '# plan' });
    expect(await resolveNamedQueryV2('plans.get', { slug: 'a' })).toEqual([{ slug: 'a', raw: '# plan' }]);
  });

  it('plans.get returns [] when the read yields null/undefined', async () => {
    callPlansRead.mockResolvedValue(null);
    expect(await resolveNamedQueryV2('plans.get', { slug: 'x' })).toEqual([]);
  });

  // plans:get is a BULK tool — even a single-slug read returns the runBulk envelope
  // { ok, results:[plan], counts }. The resolver MUST unwrap results[0] to the single plan
  // (its documented [PlanGetResult] contract); without it the live consumer gets the envelope
  // and enrichPlanDetail no-ops on the missing frontmatter (WI-374 audit finding).
  it('plans.get unwraps the runBulk envelope { results:[plan] } → [plan]', async () => {
    callPlansRead.mockResolvedValue({
      ok: true,
      results: [{ slug: 'a', harness: 'member-x', raw: '# plan' }],
      counts: { ok: 1, failed: 0 },
    });
    expect(await resolveNamedQueryV2('plans.get', { slug: 'a' })).toEqual([
      { slug: 'a', harness: 'member-x', raw: '# plan' },
    ]);
  });

  it('plans.get returns [] when the bulk envelope has no result row', async () => {
    callPlansRead.mockResolvedValue({ ok: true, results: [], counts: { ok: 0, failed: 0 } });
    expect(await resolveNamedQueryV2('plans.get', { slug: 'x' })).toEqual([]);
  });

  it('plans.revisions / plans.runs / plans.lint unwrap their fields', async () => {
    callPlansRead.mockResolvedValueOnce({ revisions: [{ seq: 1 }] });
    expect(await resolveNamedQueryV2('plans.revisions', { slug: 'a' })).toEqual([{ seq: 1 }]);
    callPlansRead.mockResolvedValueOnce({ runs: [{ id: 1 }] });
    expect(await resolveNamedQueryV2('plans.runs', { slug: 'a' })).toEqual([{ id: 1 }]);
    callPlansRead.mockResolvedValueOnce({ reports: [{ slug: 'a', errors: [] }] });
    expect(await resolveNamedQueryV2('plans.lint', { slug: 'a' })).toEqual([{ slug: 'a', errors: [] }]);
  });

  // WI-7221. The assertion above mocks a `{ reports }` shape that `plans:lint`
  // NEVER returns for a slug — which is exactly why this stayed hidden. A
  // single-slug lint is a BULK call: runBulk → `{ results:[{ ok, slug, report }] }`.
  // Against the real envelope the old `r?.reports ?? []` unwrap returned [] for
  // every args-bearing call, so the DETAIL half of the list/detail split was dead.
  it('plans.lint unwraps the real single-slug BULK envelope, not just { reports }', async () => {
    const report = {
      slug: 'a',
      errors: [{ code: 'missing_now_section', level: 'error', message: 'No `## Now` section ...' }],
      warnings: [{ code: 'unphased_item', level: 'warning', message: 'full prose kept on the DETAIL read' }],
    };
    callPlansRead.mockResolvedValueOnce({
      results: [{ ok: true, slug: 'a', report, totalErrors: 1, totalWarnings: 1, exempt: 0 }],
      counts: { ok: 1, failed: 0 },
    });
    // The full report, warning prose included — this is what makes the summary
    // projection on the nullary read a SPLIT rather than a loss.
    expect(await resolveNamedQueryV2('plans.lint', { slug: 'a' })).toEqual([report]);
  });

  it('plans.lint drops a not_found row from the bulk envelope instead of emitting it', async () => {
    callPlansRead.mockResolvedValueOnce({
      results: [{ ok: false, slug: 'nope', error: 'not_found' }],
      counts: { ok: 0, failed: 1 },
    });
    expect(await resolveNamedQueryV2('plans.lint', { slug: 'nope' })).toEqual([]);
  });

  it('returns [] when the expected envelope field is missing', async () => {
    callPlansRead.mockResolvedValue({});
    expect(await resolveNamedQueryV2('plans.list', {})).toEqual([]);
    expect(await resolveNamedQueryV2('plans.items', {})).toEqual([]);
  });
});
