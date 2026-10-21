/**
 * Pins the Cupboard Worker's publish review predicate as content-aware
 * (plan-item-types-registry-cupboard-2026-10-20 P-006, R-16, D-008). See ./cupboard-type-pack-review.ts.
 *
 * The fixture controls are load-bearing: once the live assertion is green it stops being evidence
 * that the judge can fail, so each fixture reproduces a regression that MUST be caught.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judgeReviewPredicate } from './cupboard-type-pack-review';

// lib/doc-claims -> lib -> operator-core -> packages -> <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROUTE = join(ROOT, 'apps/operator-public/src/routes/listings.ts');
const DB = join(ROOT, 'apps/operator-public/src/db.ts');

const GOOD_ROUTE = 'const review_status = publishReviewStatus(kind, declaredTypes);';
const GOOD_DB = [
  'export function publishReviewStatus(',
  '  kind: ListingKind,',
  '  declares: { itemTypes: number; planTypes: number },',
  "): 'pending' | 'approved' {",
  "  if (REVIEW_POLICY_KINDS.includes(kind)) return 'pending';",
  "  return declares.itemTypes + declares.planTypes > 0 ? 'pending' : 'approved';",
  '}',
].join('\n');

describe('the Cupboard review predicate is content-aware (R-16)', () => {
  describe('fixture controls (the judge must be able to FAIL)', () => {
    it('passes the content-aware shape', () => {
      expect(judgeReviewPredicate(GOOD_ROUTE, GOOD_DB)).toEqual({ ok: true, problems: [] });
    });
    it('catches a route that decides from the kind list alone (the pre-P-006 rule)', () => {
      const route = "const review_status = REVIEW_POLICY_KINDS.includes(kind) ? ('pending' as const) : ('approved' as const);";
      expect(judgeReviewPredicate(route, GOOD_DB).problems).toEqual([
        'listings.ts does not take review_status from publishReviewStatus(kind, declaredTypes)',
        'listings.ts still decides review_status from REVIEW_POLICY_KINDS alone',
      ]);
    });
    it('catches a predicate that ignores the plan-type declarations', () => {
      const db = GOOD_DB.replace('declares.itemTypes + declares.planTypes > 0', 'declares.itemTypes > 0');
      expect(judgeReviewPredicate(GOOD_ROUTE, db).problems).toEqual(['publishReviewStatus ignores declares.planTypes']);
    });
    it('is not satisfied by a comment quoting the rule', () => {
      expect(judgeReviewPredicate(`// ${GOOD_ROUTE}`, GOOD_DB).ok).toBe(false);
    });
  });

  it('the live Worker sources hold the claim', () => {
    const verdict = judgeReviewPredicate(readFileSync(ROUTE, 'utf8'), readFileSync(DB, 'utf8'));
    expect(verdict.problems).toEqual([]);
  });

  it('the live predicate sends every type-declaring listing to review and keeps tool-only packs approved', async () => {
    // Worker sources compile only under @cloudflare/workers-types: load through a non-literal
    // specifier. It must be an absolute file URL: Vite resolves a non-literal RELATIVE specifier
    // against the project root, not this file, and the import fails to find the module.
    const specifier = pathToFileURL(DB).href;
    const { publishReviewStatus } = (await import(specifier)) as {
      publishReviewStatus: (kind: string, declares: { itemTypes: number; planTypes: number }) => string;
    };
    expect(publishReviewStatus('pack', { itemTypes: 1, planTypes: 0 })).toBe('pending');
    expect(publishReviewStatus('pack', { itemTypes: 0, planTypes: 1 })).toBe('pending');
    expect(publishReviewStatus('plugin', { itemTypes: 2, planTypes: 1 })).toBe('pending');
    expect(publishReviewStatus('pack', { itemTypes: 0, planTypes: 0 })).toBe('approved');
    expect(publishReviewStatus('plugin', { itemTypes: 0, planTypes: 0 })).toBe('approved');
    expect(publishReviewStatus('rule', { itemTypes: 0, planTypes: 0 })).toBe('pending');
  });
});
