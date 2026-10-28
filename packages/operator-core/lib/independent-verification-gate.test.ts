/**
 * WI-6554700010008529: `independent_verification_missing` recruits a grader whose brief
 * carries the re-observation step. These cases pin the two pieces that brief needs: the
 * gate names the implementer rows a verifier can cite, and the renderer turns the gaps
 * into an ordered instruction that comes BEFORE scorecards:emit.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateIndependentVerificationGate,
  renderIndependentVerificationBrief,
  type IndependentVerificationGap,
} from './independent-verification-gate';

/** A tagged-template stand-in that answers the gate's reads in call order. */
function fakeSql(answers: unknown[][]) {
  const calls: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    calls.push(strings.join('?'));
    return Promise.resolve(answers[calls.length - 1] ?? []);
  }) as never;
  return { sql, calls };
}

const SCOPE = [
  { spec_id: 'AUTO-BAR-R-1-P-008', revision: 4, evidence_plane: 'live', source_bar_key: 'R-1' },
  { spec_id: 'AUTO-BAR-R-3-P-011', revision: 4, evidence_plane: 'live', source_bar_key: 'R-3' },
];

const PAIR_CANDIDATE = {
  id: '37146', spec_id: 'AUTO-BAR-R-1-P-008', verified_binding_id: '37145',
  created_by: 'su-verifier', verified_created_by: 'su-impl',
};

describe('independent verification gate — what a recruited verifier cites', () => {
  it('lists the live implementer bindings per open clause', async () => {
    const { sql, calls } = fakeSql([
      SCOPE,
      [], // no independent-verification rows yet
      [
        { id: '37145', spec_id: 'AUTO-BAR-R-1-P-008' },
        { id: '37146', spec_id: 'AUTO-BAR-R-3-P-011' },
        { id: '37150', spec_id: 'AUTO-BAR-R-3-P-011' },
      ],
    ]);
    const verdict = await evaluateIndependentVerificationGate(
      { planSlug: 'p', harnessSlug: 'h', workspaceId: 'ws' },
      { sql, resolveImplementers: async () => ['su-impl'], lineageRelated: async () => false },
    );
    expect(verdict).toMatchObject({ satisfied: false, code: 'independent_verification_missing', inScope: 2 });
    expect(verdict.gaps.map((gap) => [gap.specId, gap.citableBindingIds])).toEqual([
      ['AUTO-BAR-R-1-P-008', [37145]],
      ['AUTO-BAR-R-3-P-011', [37146, 37150]],
    ]);
    // The citable read excludes IV rows and retracted rows, so a verifier never cites another verifier.
    expect(calls[2]).toMatch(/evidence_kind <> 'independent-verification'/);
    expect(calls[2]).toMatch(/retracted_at IS NULL/);
  });

  it('fails closed when the citable read fails', async () => {
    let n = 0;
    const sql = (() => (++n === 3 ? Promise.reject(new Error('boom')) : Promise.resolve(n === 1 ? SCOPE : []))) as never;
    const verdict = await evaluateIndependentVerificationGate(
      { planSlug: 'p', harnessSlug: 'h', workspaceId: 'ws' },
      { sql, resolveImplementers: async () => [], lineageRelated: async () => false },
    );
    expect(verdict).toMatchObject({ satisfied: false, code: 'independent_verification_unavailable' });
  });

  it.each(['source', 'environment'] as const)(
    'rejects an otherwise independent, fingerprint-equal pair when %s currentness is stale',
    async (staleDimension) => {
      const { sql, calls } = fakeSql([
        SCOPE.slice(0, 1),
        [PAIR_CANDIDATE],
        [{ id: '37145', spec_id: 'AUTO-BAR-R-1-P-008' }],
      ]);
      let requestedBindingIds: number[] = [];
      const dimensions = staleDimension === 'source' ? { source: 'stale' } : { environment: 'stale' };
      const verdict = await evaluateIndependentVerificationGate(
        { planSlug: 'p', harnessSlug: 'h', workspaceId: 'ws' },
        {
          sql,
          resolveImplementers: async () => ['su-impl'],
          lineageRelated: async () => false,
          listEvidence: async (options) => {
            requestedBindingIds = options.bindingIds ?? [];
            return [37146, 37145].map((id) => ({
              id,
              currentness: { overall: 'stale' as const, dimensions },
            }));
          },
        },
      );

      // The database still sees equal stored fingerprints; independent measurement now
      // rejects that copied snapshot when its source or runtime has moved.
      expect(calls[1]).toMatch(/src\.source_fingerprint = iv\.source_fingerprint/);
      expect(calls[1]).toMatch(/src\.environment_fingerprint IS NOT DISTINCT FROM iv\.environment_fingerprint/);
      expect(requestedBindingIds.sort()).toEqual([37145, 37146]);
      expect(verdict).toMatchObject({ satisfied: false, code: 'independent_verification_missing' });
      expect(verdict.gaps[0]).toMatchObject({
        specId: 'AUTO-BAR-R-1-P-008',
        reason: 'non-current-evidence',
        nonCurrentBindingIds: [37146, 37145],
      });
    },
  );

  it('accepts an independent pair only when both server-measured bindings are current', async () => {
    const { sql } = fakeSql([
      SCOPE.slice(0, 1),
      [PAIR_CANDIDATE],
      [{ id: '37145', spec_id: 'AUTO-BAR-R-1-P-008' }],
    ]);
    let requestedBindingIds: number[] = [];
    const verdict = await evaluateIndependentVerificationGate(
      { planSlug: 'p', harnessSlug: 'h', workspaceId: 'ws' },
      {
        sql,
        resolveImplementers: async () => ['su-impl'],
        lineageRelated: async () => false,
        listEvidence: async (options) => {
          requestedBindingIds = options.bindingIds ?? [];
          return [37146, 37145].map((id) => ({
            id,
            currentness: { overall: 'current' as const, dimensions: { source: 'current', environment: 'current' } },
          }));
        },
      },
    );

    expect(requestedBindingIds.sort()).toEqual([37145, 37146]);
    expect(verdict).toMatchObject({ satisfied: true, applicable: true, inScope: 1, gaps: [] });
  });

  it('refuses when the currentness read omits a binding in the pair', async () => {
    const { sql } = fakeSql([
      SCOPE.slice(0, 1),
      [PAIR_CANDIDATE],
      [{ id: '37145', spec_id: 'AUTO-BAR-R-1-P-008' }],
    ]);
    const verdict = await evaluateIndependentVerificationGate(
      { planSlug: 'p', harnessSlug: 'h', workspaceId: 'ws' },
      {
        sql,
        resolveImplementers: async () => ['su-impl'],
        lineageRelated: async () => false,
        listEvidence: async () => [{ id: 37146, currentness: { overall: 'current' } }],
      },
    );

    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'independent_verification_unavailable',
      readFailure: 'currentness of the independent-verification evidence pairs: measured 1 of 2 requested bindings',
    });
  });
});

describe('renderIndependentVerificationBrief', () => {
  const gap = (over: Partial<IndependentVerificationGap> = {}): IndependentVerificationGap => ({
    specId: 'AUTO-BAR-R-1-P-008', revision: 4, evidencePlane: 'live', barKey: 'R-1',
    reason: 'no-independent-binding', rejectedBindingIds: [], citableBindingIds: [37145], ...over,
  });

  it('renders nothing when there is no gap', () => {
    expect(renderIndependentVerificationBrief('p', 'h', [])).toBe('');
  });

  it('orders re-observation before the scorecard and names each cited binding', () => {
    const brief = renderIndependentVerificationBrief('scope-plan', 'papercusp', [
      gap(), gap({ specId: 'AUTO-BAR-R-3-P-011', barKey: 'R-3', citableBindingIds: [] }),
    ]);
    expect(brief).toMatch(/^INDEPENDENT VERIFICATION — do this BEFORE scorecards:emit/);
    expect(brief).toContain("evidenceKind:'independent-verification'");
    expect(brief).toContain('verifiesBindingId:<the cited id>');
    expect(brief).toContain('plans:get-spec-evidence { slug:"scope-plan", harness:"papercusp" }');
    expect(brief).toContain('- AUTO-BAR-R-1-P-008@4 (R-1, live): implementer binding(s) 37145');
    expect(brief).toContain('- AUTO-BAR-R-3-P-011@4 (R-3, live): no live implementer binding to cite');
    // A contradicting observation must never become a binding.
    expect(brief).toMatch(/contradicts the receipt, do not bind/);
  });

  it('names stale or unmeasurable evidence pairs in the verifier brief', () => {
    const brief = renderIndependentVerificationBrief('p', 'h', [gap({
      reason: 'non-current-evidence',
      nonCurrentBindingIds: [37145, 37146],
    })]);
    expect(brief).toContain('binding(s) 37145, 37146 are stale or could not be measured current');
  });
});
