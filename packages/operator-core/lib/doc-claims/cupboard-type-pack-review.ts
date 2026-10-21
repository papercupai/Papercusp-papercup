/**
 * The Cupboard Worker's publish review predicate is CONTENT-AWARE
 * (plan-item-types-registry-cupboard-2026-10-20 P-006, R-16, D-008): a listing that declares item
 * types or plan types lands pending operator review whatever its kind, and a pack that declares none
 * keeps the per-kind policy. Two source facts carry that claim, and this module judges both:
 *
 *  1. apps/operator-public/src/routes/listings.ts takes the publish review status from
 *     `publishReviewStatus(kind, declaredTypes)`, never from the kind list alone; and
 *  2. apps/operator-public/src/db.ts's `publishReviewStatus` reads both declaration counts.
 *
 * The behaviour itself is checked against the live module in the sibling test.
 */

export interface ReviewPredicateVerdict {
  ok: boolean;
  problems: string[];
}

/** Strip // and block comments so a comment quoting the old rule cannot satisfy or break the judge. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function judgeReviewPredicate(routeSource: string, dbSource: string): ReviewPredicateVerdict {
  const route = stripComments(routeSource);
  const db = stripComments(dbSource);
  const problems: string[] = [];
  if (!/const\s+review_status\s*=\s*publishReviewStatus\(\s*kind\s*,\s*declaredTypes\s*\)/.test(route)) {
    problems.push('listings.ts does not take review_status from publishReviewStatus(kind, declaredTypes)');
  }
  if (/review_status\s*=\s*REVIEW_POLICY_KINDS\.includes\(/.test(route)) {
    problems.push('listings.ts still decides review_status from REVIEW_POLICY_KINDS alone');
  }
  const fn = /export function publishReviewStatus\(([\s\S]*?)\n\}/.exec(db);
  if (!fn) {
    problems.push('db.ts exports no publishReviewStatus');
  } else {
    for (const field of ['itemTypes', 'planTypes']) {
      if (!new RegExp(`declares\\.${field}\\b`).test(fn[1]!)) problems.push(`publishReviewStatus ignores declares.${field}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
