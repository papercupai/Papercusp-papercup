/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-004 (R-5) — graders name the runtime and
 * sha behind an unknown/mismatch rating on a live or deployed BAR.
 *
 * The rubric-vetting half (R-6: live BARs with no evidenceRuntime) lives in
 * acceptance-runtime-vetting-findings.test.ts so the two BARs fail independently.
 */
import { describe, expect, it } from 'vitest';
import {
  ratingNeedsRuntimeCitation,
  runtimeCitationRefusal,
  validateRuntimeCitation,
} from './acceptance-runtime-citation';

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';

describe('which ratings need a runtime citation', () => {
  it('unknown / mismatch / not-deployed ratings do; passing ratings do not', () => {
    for (const r of ['unknown', 'generation-mismatch', 'not-deployed', 'not yet live', 'pending-deploy', 'Mismatch']) {
      expect(ratingNeedsRuntimeCitation(r)).toBe(true);
    }
    for (const r of ['healthy', 'pass', 'broken', 'degraded', '', null]) {
      expect(ratingNeedsRuntimeCitation(r)).toBe(false);
    }
  });
});

describe('validateRuntimeCitation', () => {
  it('recognizes exact registry citations without aliasing embedded built-in labels', () => {
    const runtime = 'runtime-vintage:papercusp-workspace/bg-host@builder';
    expect(validateRuntimeCitation({ rating: 'unknown', evidence: runtime, evidencePlane: 'live' }))
      .toEqual({ missing: ['sha'], runtimesCited: [runtime] });
    expect(validateRuntimeCitation({ rating: 'unknown', evidence: `${runtime} build 9536482f31.`, evidencePlane: 'live' }))
      .toBeNull();
    expect(validateRuntimeCitation({ rating: 'unknown', evidence: 'runtime-vintage:workspace/bg-host@ build 9536482f31', evidencePlane: 'live' }))
      .toEqual({ missing: ['runtime'], runtimesCited: [] });
  });
  it('the 2026-09-23 rating — mismatch, "wait for deployed:true", no runtime, no sha — is refused on both counts', () => {
    expect(
      validateRuntimeCitation({
        rating: 'generation-mismatch',
        evidence: 'pipeline_position says deployed:false; wait for deployed:true before grading',
        evidencePlane: 'live',
      }),
    ).toEqual({ missing: ['runtime', 'sha'], runtimesCited: [] });
  });

  it('a cited runtime + build sha passes', () => {
    expect(
      validateRuntimeCitation({
        rating: 'generation-mismatch',
        evidence: 'bg-host /api/health on :3271 reports 9536482f31, which lacks the ingest fix blob',
        evidencePlane: 'live',
      }),
    ).toBeNull();
  });

  it('a runtime without a sha, or a sha without a runtime, is still refused', () => {
    expect(
      validateRuntimeCitation({ rating: 'unknown', evidence: 'measured on :3070, not reachable', evidencePlane: 'deployed' })
        ?.missing,
    ).toEqual(['sha']);
    expect(
      validateRuntimeCitation({ rating: 'unknown', evidence: 'build be8396c6dd lacks it', evidencePlane: 'live' })?.missing,
    ).toEqual(['runtime']);
  });

  it('tree-plane BARs and passing ratings are out of scope', () => {
    expect(validateRuntimeCitation({ rating: 'unknown', evidence: '', evidencePlane: 'tree' })).toBeNull();
    expect(validateRuntimeCitation({ rating: 'healthy', evidence: '', evidencePlane: 'live' })).toBeNull();
  });
});

describe('runtimeCitationRefusal — the scorecards:emit wiring', () => {
  const criteria = [
    { key: 'r-1', barKey: 'R-1', evidencePlane: 'live' as const, method: `census from ${BG_PATH}` },
    { key: 'r-2', barKey: 'R-2', evidencePlane: 'tree' as const },
  ];

  it('refuses a card with an uncited mismatch on a live BAR and names the runtime the BAR is about', () => {
    const refusal = runtimeCitationRefusal(criteria, {
      'r-1': { rating: 'generation-mismatch', evidence: 'wait for deployed:true' },
      'r-2': { rating: 'unknown', evidence: 'n/a' },
    });
    expect(refusal?.code).toBe('acceptance_runtime_citation_missing');
    expect(refusal?.error).toMatch(/'R-1' rated 'generation-mismatch' without runtime and sha \(this BAR is measured on bg-host\)/);
    expect(refusal?.error).not.toMatch(/R-2/);
    expect(refusal?.error).toMatch(/servingRuntimes/);
  });

  it('accepts a card whose ratings are all passing or properly cited', () => {
    expect(
      runtimeCitationRefusal(criteria, {
        'r-1': { rating: 'healthy', evidence: 'ok' },
        'r-2': { rating: 'unknown', evidence: 'n/a' },
      }),
    ).toBeNull();
    expect(
      runtimeCitationRefusal(criteria, {
        'r-1': { rating: 'unknown', evidence: 'bg-host build 635c4bd49f: routine has not fired since restart' },
      }),
    ).toBeNull();
    expect(runtimeCitationRefusal(criteria, undefined)).toBeNull();
  });
});
