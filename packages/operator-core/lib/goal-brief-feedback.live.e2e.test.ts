/** R-10's complete live suite is independent of R-2's unknown eligibility proof.
 * Both controls run with PAPERCUSP_GOAL_BRIEF_LIVE=1; no selection filter needed. */
import { describe, expect, it } from 'vitest';
import { observe } from './goal-brief-live-probe.test-helper';

describe.skipIf(process.env.PAPERCUSP_GOAL_BRIEF_LIVE !== '1')('goal brief live feedback', () => {
  it('R-10 preserves original feedback attribution and revision history', async () => {
    const { status, evidence } = await observe(false, 'R10');
    expect(status, JSON.stringify(evidence)).toBe(0);
    for (const id of ['auto-bar-r-10-p-007', 'auto-bar-r-10-p-009']) {
      expect(evidence.assertions.find((assertion) => assertion.id === id)?.passed, id).toBe(true);
    }
    expect(evidence.assertions.every((assertion) => assertion.passed), JSON.stringify(evidence)).toBe(true);
  }, 70_000);

  it('R-10 rejects feedback attributed to the wrong goal holder', async () => {
    const { status, evidence } = await observe(true, 'R10');
    expect(status).toBe(1);
    const assertion = evidence.assertions.find((entry) => entry.id === 'r10-arm-a-feedback-credited-to-goal-holder');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(false);
  }, 70_000);
});
