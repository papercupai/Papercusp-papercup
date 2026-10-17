import { describe, expect, it } from 'vitest';
import { buildOrderingItems, isAcceptanceWork, openBuildItems } from './acceptance-after-build';

describe('acceptance after build', () => {
  it.each(['todo', 'wip', 'blocked', 'needs-human'])('keeps %s build work ahead of acceptance', status => {
    expect(openBuildItems([
      { id: 'P-001', text: 'Implement the guard', status },
      { id: 'P-002', text: 'Grade acceptance', status: 'todo' },
    ]).map(item => item.id)).toEqual(['P-001']);
  });

  it('does not mistake acceptance implementation for grading work', () => {
    expect(isAcceptanceWork({ id: 'P-001', text: 'Implement acceptance grading guard' })).toBe(false);
    expect(isAcceptanceWork({ id: 'P-002', text: 'No acceptance grading while build is open' })).toBe(false);
    expect(isAcceptanceWork({ id: 'P-003', text: 'Independent acceptance grading' })).toBe(true);
  });

  it('uses an explicit acceptance phase and ignores terminal build items', () => {
    expect(openBuildItems([
      { id: 'P-001', text: 'Build', status: 'done' },
      { id: 'P-002', text: 'Abandoned build', status: 'dropped' },
      { id: 'P-003', text: 'Gather final evidence', phase: 'Acceptance', status: 'blocked' },
    ])).toEqual([]);
  });

  it('prefers the stored index and falls back to parsed items', () => {
    const items = [{ id: 'P-001', text: 'Build', storedStatus: 'blocked' }];
    expect(buildOrderingItems({ row: { items }, parsed: { items: [] } })).toBe(items);
    expect(openBuildItems(buildOrderingItems({ row: { items: [] }, parsed: { items } }))).toEqual(items);
  });
});
