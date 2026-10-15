import { describe, expect, it } from 'vitest';
import { parkBlockerRef, parkReplyFromPost, parkStateFromRows, type ParkConsultRow, type ParkPostRow } from './park-adapters';
import { resolvePark } from './park-resolver';

const routing = (over: Record<string, unknown> = {}, selected = 2) => ({
  selection: { selected: Array.from({ length: selected }, (_, i) => ({ ownerId: `su-rev${i}` })) },
  cascade: {
    flavor: 'decision-review',
    workItemId: 'WI-1',
    setterId: 'su-parker',
    defaultAction: 'Ship the default',
    deadlineAt: '2026-10-13T01:00:00.000Z',
    ownerAuthorityTopic: null,
    ...over,
  },
});

const consult = (over: Partial<ParkConsultRow> = {}): ParkConsultRow => ({
  conversation_id: 'conv-1',
  question: 'Which way?',
  state: 'active',
  closed_at: null,
  cascade_cursor: 0,
  routing: routing(),
  park_state: null,
  ...over,
});

const post = (id: number, author: string, stance: unknown, at = '2026-10-13T00:10:00.000Z'): ParkPostRow => ({
  post_id: id,
  author_id: author,
  created_at: at,
  stance: stance as ParkPostRow['stance'],
});

describe('parkStateFromRows', () => {
  it('returns null for a consult that is not a decision review', () => {
    expect(parkStateFromRows(consult({ routing: { selection: { selected: [] } } }), [])).toBeNull();
  });

  it('reads the park identity from routing.cascade and the progress from park_state', () => {
    const s = parkStateFromRows(
      consult({
        routing: JSON.stringify(routing({ ownerAuthorityTopic: 'spend' })),
        park_state: JSON.stringify({
          outcomes: [{ verdict: 'consider-alternative', at: 't', objectionId: '7' }],
          parkerResponses: [{ kind: 'rebut', at: 't2', text: 'no', objectionId: '7' }],
          ownerQuestionOpened: true,
        }),
      }),
      [],
    )!;
    expect(s).toMatchObject({
      consultId: 'conv-1',
      workItemId: 'WI-1',
      parkerOwnerId: 'su-parker',
      defaultAction: 'Ship the default',
      deadlineAt: '2026-10-13T01:00:00.000Z',
      ownerAuthority: true,
      ownerAuthorityTopic: 'spend',
      blockerRef: parkBlockerRef('conv-1'),
      ownerQuestionOpened: true,
      ownerAnswer: null,
    });
    expect(s.outcomes).toHaveLength(1);
    expect(s.parkerResponses[0]!.kind).toBe('rebut');
  });

  it('maps stances to replies and ignores the parker\'s own posts', () => {
    const s = parkStateFromRows(consult(), [
      post(1, 'su-rev0', { position: 'object', basis: 'alternative', reason: 'risky', alternative: 'Do B' }),
      post(2, 'su-parker', { position: 'support' }),
    ])!;
    expect(s.replies).toEqual([
      { id: '1', responderOwnerId: 'su-rev0', at: '2026-10-13T00:10:00.000Z', stance: 'object', basis: 'alternative', reason: 'risky', alternative: 'Do B' },
    ]);
  });

  it('marks reviewers exhausted once the consult closes or the last selected reviewer has replied', () => {
    expect(parkStateFromRows(consult(), [])!.reviewersExhausted).toBe(false);
    expect(parkStateFromRows(consult({ state: 'expired', closed_at: '2026-10-13T00:30:00Z' }), [])!.reviewersExhausted).toBe(true);
    const lastAnswered = parkStateFromRows(consult({ cascade_cursor: 1 }), [
      post(1, 'su-rev0', { position: 'no-view' }),
      post(2, 'su-rev1', { position: 'support' }),
    ])!;
    expect(lastAnswered.reviewersExhausted).toBe(true);
  });

  it('feeds the resolver: a silent park past its deadline proceeds (R-5 through the adapter)', () => {
    const s = parkStateFromRows(consult(), [])!;
    expect(resolvePark(s, '2026-10-13T01:00:01.000Z').verdict).toBe('proceed');
    expect(resolvePark(s, '2026-10-13T00:59:00.000Z').verdict).toBeNull();
  });
});

describe('parkReplyFromPost', () => {
  it('folds hazard evidence into the reason and keeps owner-authority objections standing', () => {
    expect(parkReplyFromPost(post(3, 'r', { position: 'object', basis: 'hazard', reason: 'breaks prod', evidence: ['WI-9'] }))).toMatchObject({
      stance: 'object',
      basis: 'hazard',
      reason: 'breaks prod (evidence: WI-9)',
      alternative: null,
    });
    expect(parkReplyFromPost(post(4, 'r', { position: 'object', basis: 'owner-authority', topic: 'publish' }))).toMatchObject({
      stance: 'object',
      basis: 'owner-authority',
      reason: 'Owner-authority topic: publish',
    });
  });

  it('drops a malformed stance instead of guessing', () => {
    expect(parkReplyFromPost(post(5, 'r', '{not json'))).toBeNull();
    expect(parkReplyFromPost(post(6, 'r', { position: 'maybe' }))).toBeNull();
  });
});
