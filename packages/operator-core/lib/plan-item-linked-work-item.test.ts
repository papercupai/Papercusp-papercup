import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linkedWorkItemFields, PLAN_ITEM_IMPLEMENTS_REL } from './plan-item-linked-work-item';

describe('PLAN_ITEM_IMPLEMENTS_REL', () => {
  it('matches the rel convert.ts writes (read from source, so this leaf stays import-free)', () => {
    const src = readFileSync(new URL('./plan-items/convert.ts', import.meta.url), 'utf8');
    const m = /export const IMPLEMENTS_REL = '([^']+)'/.exec(src);
    expect(m, 'convert.ts no longer declares IMPLEMENTS_REL as a string literal').not.toBeNull();
    expect(PLAN_ITEM_IMPLEMENTS_REL).toBe(m![1]);
  });
});

describe('linkedWorkItemFields (scope-unique-identifiers P-003)', () => {
  it('reports nothing for an unlinked item', () => {
    expect(linkedWorkItemFields([])).toEqual({ workItemId: null, workItemIds: [] });
  });

  it('resolves the single linked work-item', () => {
    expect(linkedWorkItemFields([{ id: 'WI-1', terminal: false }])).toEqual({
      workItemId: 'WI-1',
      workItemIds: ['WI-1'],
    });
    expect(linkedWorkItemFields([{ id: 'WI-1', terminal: true }])).toEqual({
      workItemId: 'WI-1',
      workItemIds: ['WI-1'],
    });
  });

  it('prefers the one live link over settled ones and lists live first', () => {
    expect(
      linkedWorkItemFields([
        { id: 'WI-9', terminal: true },
        { id: 'WI-5', terminal: false },
        { id: 'WI-2', terminal: true },
      ]),
    ).toEqual({ workItemId: 'WI-5', workItemIds: ['WI-5', 'WI-2', 'WI-9'] });
  });

  it('refuses to pick between several live links (reported, not guessed)', () => {
    expect(
      linkedWorkItemFields([
        { id: 'WI-7', terminal: false },
        { id: 'WI-3', terminal: false },
      ]),
    ).toEqual({ workItemId: null, workItemIds: ['WI-3', 'WI-7'] });
  });

  it('refuses to pick between several settled links when none is live', () => {
    expect(
      linkedWorkItemFields([
        { id: 'WI-7', terminal: true },
        { id: 'WI-3', terminal: true },
      ]),
    ).toEqual({ workItemId: null, workItemIds: ['WI-3', 'WI-7'] });
  });

  it('dedupes one id seen through two links, counting it live if either link is live', () => {
    expect(
      linkedWorkItemFields([
        { id: 'WI-4', terminal: true },
        { id: 'WI-4', terminal: false },
        { id: 'WI-8', terminal: true },
      ]),
    ).toEqual({ workItemId: 'WI-4', workItemIds: ['WI-4', 'WI-8'] });
  });

  it('is order-independent', () => {
    const set = [
      { id: 'WI-1', terminal: true },
      { id: 'WI-2', terminal: false },
      { id: 'WI-3', terminal: true },
    ];
    expect(linkedWorkItemFields([...set].reverse())).toEqual(linkedWorkItemFields(set));
  });

  it('ignores blank ids', () => {
    expect(linkedWorkItemFields([{ id: '', terminal: false }, { id: 'WI-6', terminal: false }])).toEqual({
      workItemId: 'WI-6',
      workItemIds: ['WI-6'],
    });
  });
});
