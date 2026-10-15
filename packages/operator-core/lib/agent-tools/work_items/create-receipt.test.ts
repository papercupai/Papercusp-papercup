import { describe, expect, it } from 'vitest';
import { toCreateReceiptWorkItem } from './create';

// oversized-tool-results-reduction-2026-10-12 P-002: work_items:create returns a receipt by
// default; payloadTier:'full' (not exercised here) returns the whole row.
describe('toCreateReceiptWorkItem', () => {
  const row = {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    title: 'T',
    summary: 'the caller’s own body, echoed back',
    state: 'open',
    assignee: 'su-x',
    severity: 'major',
    takenAt: '2026-10-12T00:00:00.000Z',
    goalId: null,
    parent: null,
    sourcePlanSlug: null,
    payload: { _ei: { scope: 'harness:papercusp' }, freshnessEnvelope: { observedAt: 'x' } },
    interestWatch: { event_keys: [], await_ids: [], cancel: null },
    rank: null,
    createdAt: '2026-10-12T00:00:00.000Z',
  };

  it('keeps identity, state and assignment, and drops the echoed body, payload internals and nulls', () => {
    expect(toCreateReceiptWorkItem(row)).toEqual({
      id: 'WI-1',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      title: 'T',
      state: 'open',
      assignee: 'su-x',
      severity: 'major',
      takenAt: '2026-10-12T00:00:00.000Z',
      createdAt: '2026-10-12T00:00:00.000Z',
    });
  });

  it('keeps assignee and state even when null, so "is it owned?" stays answerable', () => {
    expect(toCreateReceiptWorkItem({ id: 'WI-2', state: 'open', assignee: null })).toEqual({
      id: 'WI-2',
      state: 'open',
      assignee: null,
    });
  });

  it('is materially smaller than the row it summarizes', () => {
    expect(JSON.stringify(toCreateReceiptWorkItem(row)).length).toBeLessThan(JSON.stringify(row).length / 2);
  });
});
