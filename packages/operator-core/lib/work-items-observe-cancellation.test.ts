import { describe, expect, it } from 'vitest';
import { observeWorkItem } from './work-items';

describe('observeWorkItem cancellation', () => {
  it('does not start a storage read when its caller is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('bounded core leg timed out');
    controller.abort(reason);

    await expect(
      observeWorkItem('WI-CANCELLED', { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});
