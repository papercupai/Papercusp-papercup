/**
 * awaitable-review-post-events-2026-10-27 R-1/R-2: the ONE builder for the blind-review
 * post event key.
 *
 * Events latch, so a key shared by every reviewer of a plan would wake a second
 * reviewer's waiter on the first review's post. The key is therefore scoped to the
 * reviewer's session binding (its `plan_blind_review_sessions` row id), not the plan.
 *
 * The post emitter (plans:blind-review op 'post') and every recruiting result that hands
 * a waiter the key (op 'mint', 'replace', 'resume') call this function, so the key a
 * recruiter is given and the key the post fires cannot drift apart.
 */

export const BLIND_REVIEW_POSTED_KEY_PREFIX = 'plan:blind-review-posted';

export function blindReviewPostedEventKey(slug: string, bindingId: number): string {
  if (!slug.trim()) throw new Error('blindReviewPostedEventKey: slug is required');
  if (!Number.isSafeInteger(bindingId) || bindingId <= 0) {
    throw new Error(`blindReviewPostedEventKey: bindingId must be a positive integer, got ${String(bindingId)}`);
  }
  return `${BLIND_REVIEW_POSTED_KEY_PREFIX}:${slug}:${bindingId}`;
}
