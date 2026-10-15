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
});
