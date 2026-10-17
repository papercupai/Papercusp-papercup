import { describe, expect, it } from 'vitest';
import { withSubmissionReceipt } from './submission-receipt';
describe('Cupboard publication receipts', () => {
  it.each(['pending', 'approved', 'rejected'])('preserves the actual %s review verdict and provides both tracking paths', review_status => {
    const receipt = withSubmissionReceipt({ ok: true, listingId: 'listing', review_status, hint: 'Kind-specific information.' });
    expect(receipt).toMatchObject({ review_status, mySubmissionsPath: '/cupboard?kind=my-submissions', mySubmissionsTool: 'cupboard:my-listings' });
    expect(receipt.hint).toContain(review_status === 'pending' ? 'pending review' : review_status);
    expect(receipt.hint).toContain('Kind-specific information.');
    expect(receipt.hint).toContain('My submissions');
  });
  it('does not invent an approval when the upstream omitted its state', () => {
    expect(withSubmissionReceipt({ ok: true, listingId: 'x' })).toMatchObject({ review_status: 'unknown', hint: expect.stringContaining('unavailable') });
  });
  it.each([{ ok: false, error: 'forbidden' }, { ok: true, exportedOnly: true }, { ok: true }])('leaves failure and export-only results without a publication claim %j', payload => {
    expect(withSubmissionReceipt(payload)).toEqual(payload);
  });
});
