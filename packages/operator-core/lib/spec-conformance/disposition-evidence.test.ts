import { describe, expect, it, vi } from 'vitest';
import { dispositionOwnerDirective } from '../owner-directives';
import { hasOnlyUrlReferences, URL_ONLY_DISPOSITION_ERROR } from './disposition-evidence';

describe('URL-only directive completion evidence (R-20)', () => {
  it.each([
    'https://example.test/report',
    'HTTP://example.test/result',
    'https://example.test/a\nhttps://example.test/b',
    '<https://example.test/report>',
    '[Verification report](https://example.test/report)',
    '- [Report](https://example.test/report)\n- https://example.test/proof',
    '`https://example.test/report`.',
    '(https://example.test/result), <https://example.test/proof>',
    '/reports?sel=rpt-test',
    '[Read the report](/reports?sel=rpt-test)',
    '1. https://example.test/report\n2. /reports?sel=rpt-test',
    'papercusp://scratch/verification',
  ])('recognises references without an outcome: %s', (note) => {
    expect(hasOnlyUrlReferences(note)).toBe(true);
  });

  it.each([
    'Verified the service returned the expected response; proof: https://example.test/report',
    'The regression suite passed. [Report](https://example.test/report)',
    'The requested fix is built and its focused tests pass.',
    'Verification failed; the original task remains open.',
    '',
  ])('preserves outcome prose: %s', (note) => {
    expect(hasOnlyUrlReferences(note)).toBe(false);
  });

  it('refuses a URL-only successful disposition before its datastore write', async () => {
    const sql = vi.fn();
    const result = await dispositionOwnerDirective(
      { id: 1, status: 'done', note: '[Report](https://example.test/report)', dispositionedBy: 'su-test' },
      sql as never,
    );
    expect(result).toEqual({ ok: false, error: URL_ONLY_DISPOSITION_ERROR });
    expect(sql).not.toHaveBeenCalled();
  });

  // Positive controls: without them the refusal above stays green even if the guard
  // refused every note (rubric vetting conv-mv9mm3e2, finding C).
  it('accepts a done disposition whose note carries an outcome beside a URL and writes it', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('datastore write reached'));
    await expect(
      dispositionOwnerDirective(
        {
          id: 1,
          status: 'done',
          note: 'The regression suite passed. [Report](https://example.test/report)',
          dispositionedBy: 'su-test',
        },
        sql as never,
      ),
    ).rejects.toThrow('datastore write reached');
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('applies the URL-only rule to successful dispositions only, not to a decline', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('datastore write reached'));
    await expect(
      dispositionOwnerDirective(
        { id: 1, status: 'declined', note: 'https://example.test/why', dispositionedBy: 'su-test' },
        sql as never,
      ),
    ).rejects.toThrow('datastore write reached');
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
