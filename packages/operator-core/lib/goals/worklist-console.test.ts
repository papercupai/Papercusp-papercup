import { describe, expect, it } from 'vitest';
import { changedWorklistPlans, projectWorklistHistory } from './worklist-console';

describe('worklist history on the shared plan rail', () => {
  it('records reordered and removed plans using qualified refs, not titles', () => {
    const changes = changedWorklistPlans({ order: ['plan:a/same', 'plan:b/same'], excluded: [] },
      { order: ['plan:b/same', 'plan:a/same'], excluded: ['plan:a/same'] });
    expect(changes).toContainEqual({ ref: 'plan:a/same', before: { included: true, rank: 1 },
      after: { included: false, rank: null }, label: 'Removed from this goal' });
    expect(changes.find((c) => c.ref === 'plan:b/same')?.label).toBe('Priority 2 → 1');
  });
  it('ignores unrelated property events and preserves owner reasons in readable history', () => {
    const history = projectWorklistHistory([
      { ts: '2026-10-08T00:00:00Z', from: 'human', msg_id: 'm1', before: 'old', after: 'new' },
      { ts: '2026-10-08T01:00:00Z', from: 'human', msg_id: 'm2',
        before: { order: ['plan:h/a'], excluded: [] }, after: { order: ['plan:h/a'], excluded: ['plan:h/a'] },
        detail: 'Owner edit — Friday demo' },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ref: 'plan:h/a', detail: 'Owner edit — Friday demo', actor: 'human' });
  });
});
