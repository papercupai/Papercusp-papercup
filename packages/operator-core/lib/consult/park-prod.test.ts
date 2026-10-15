import { describe, expect, it } from 'vitest';
import { ownerQuestionBody, rebuttalDigestText } from './park-prod';
import type { ParkState } from './park-resolver';

const state: ParkState = {
  consultId: 'conv-1',
  workItemId: 'WI-1',
  blockerRef: 'consult:conv-1',
  parkerOwnerId: 'su-parker',
  question: 'Use table A or B?',
  defaultAction: 'use table A',
  deadlineAt: '2026-10-13T01:00:00.000Z',
  ownerAuthority: false,
  ownerAuthorityTopic: null,
  replies: [],
  parkerResponses: [],
  ownerAnswer: null,
  reviewersExhausted: false,
  outcomes: [],
  ownerQuestionOpened: false,
};

describe('park-prod pure helpers (consult-backed-parking P-006)', () => {
  it('R-16: the rebuttal digest entry carries the default, objection, alternative and rebuttal', () => {
    const text = rebuttalDigestText({
      default: 'use table A',
      objection: 'A is retired',
      alternative: 'use table B',
      rebuttal: 'A is retired only in 2027',
    });
    expect(text).toContain('Default: use table A');
    expect(text).toContain('Objection: A is retired');
    expect(text).toContain('Alternative proposed: use table B');
    expect(text).toContain('Rebuttal: A is retired only in 2027');
  });

  it('omits the alternative clause when the objection proposed none', () => {
    const text = rebuttalDigestText({ default: 'd', objection: 'o', alternative: null, rebuttal: 'r' });
    expect(text).not.toContain('Alternative proposed');
  });

  it('R-17: the owner question names the work item and exactly both options', () => {
    const body = ownerQuestionBody(state, state.question, ['use table A', 'use table B']);
    expect(body).toContain('Use table A or B?');
    expect(body).toContain('WI-1');
    expect(body).toContain('Option 1 — the default: use table A');
    expect(body).toContain('Option 2 — the objection: use table B');
    expect(body.match(/Option \d/g)).toHaveLength(2);
  });
});
