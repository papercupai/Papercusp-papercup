import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { replacementFixture } from './__tests__/_blind-review-replacement-fixture';
import { BLIND_REVIEWER_BACKENDS } from './blind-reviewer-mint';

it('replacement-history: retains the original receipt identity through failed and successful replacement history', async () => {
  const f = replacementFixture(resolve(__dirname, '../../..'),
    'packages/operator-core/lib/blind-review-replacement-history.test.ts');
  const original = structuredClone(f.state.material);
  // A definite failure is every backend rung refusing before spawn (EI-27127088253419654).
  for (const _rung of BLIND_REVIEWER_BACKENDS) {
    f.launch.mockResolvedValueOnce({ isError: true,
      data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } });
  }
  expect(await f.run()).toMatchObject({ ok: true,
    attempt: { sourceBindingId: 10, status: 'failed' } });
  expect(await f.run({ requestKey: 'history-retry' })).toMatchObject({ ok: true,
    attempt: { sourceBindingId: 10, status: 'ready' },
    attempts: [
      { sourceBindingId: 10, attemptSeq: 1, requestKey: 'request-1' },
      { sourceBindingId: 10, attemptSeq: 2, requestKey: 'history-retry' },
    ] });
  expect(f.state.material).toEqual(original);
  expect(f.state.material.created_by).toBe('su-original');
});
