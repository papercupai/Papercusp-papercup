import { describe, expect, it } from 'vitest';
import { planAnchorAdvisory } from './plan-anchor-advisory';

describe('planAnchorAdvisory', () => {
  it('names unplanned changed files and untouched linked files independently', () => {
    expect(planAnchorAdvisory({ anchors: [{ path: 'planned.ts' }, { path: 'kept.ts' }] }, ['kept.ts', 'extra.ts']))
      .toMatchObject({ unplannedFiles: ['extra.ts'], untouchedFiles: ['planned.ts'] });
  });
  it('reports untouched links when no changed files are provided', () => {
    expect(planAnchorAdvisory({ anchors: [{ path: 'planned.ts' }] }))
      .toMatchObject({ unplannedFiles: [], untouchedFiles: ['planned.ts'] });
  });
  it('deduplicates symbol links to the same file and normalizes a relative prefix', () => {
    expect(planAnchorAdvisory({ anchors: [{ path: 'a.ts', symbol: 'one' }, { path: 'a.ts', symbol: 'two' }] }, ['./a.ts']))
      .toBeUndefined();
  });
  it.each([undefined, null, {}, { paths: ['text-only.ts'] }, { anchors: [] },
    { anchors: [{ requested: 'missingSymbol', path: null }] }])('stays silent without resolved code links: %j', payload => {
    expect(planAnchorAdvisory(payload, ['extra.ts'])).toBeUndefined();
  });
});
