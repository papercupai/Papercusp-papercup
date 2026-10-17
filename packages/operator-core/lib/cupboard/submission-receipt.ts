/** One publication receipt across every Cupboard listing-kind tool. */
export function withSubmissionReceipt(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.ok !== true || payload.exportedOnly === true || !payload.listingId) return payload;
  const state = typeof payload.review_status === 'string' ? payload.review_status : 'unknown';
  const stateMessage = state === 'pending' ? 'Submitted — pending review.' : state === 'approved'
    ? 'Published — approved.' : state === 'rejected' ? 'Submission rejected.' : 'Submitted — review state unavailable.';
  return {
    ...payload,
    review_status: state,
    mySubmissionsPath: '/cupboard?kind=my-submissions',
    mySubmissionsTool: 'cupboard:my-listings',
    hint: `${stateMessage} ${typeof payload.hint === 'string' ? payload.hint + ' ' : ''}Track it in My submissions (/cupboard?kind=my-submissions) or cupboard:my-listings.`,
  };
}
