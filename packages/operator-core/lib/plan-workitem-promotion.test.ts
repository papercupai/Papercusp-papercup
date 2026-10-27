import { describe, expect, it } from 'vitest';
import {
  computePromotions,
  codePayloadForPlanItems,
  titleFromPlanItem,
  type OpenPlanItem,
} from './plan-workitem-promotion';
import { unknownAnchor } from './plan-items/anchors';

const items: OpenPlanItem[] = [
  { id: 'P-001', text: 'First item' },
  { id: 'P-002', text: 'Second item' },
  { id: 'P-003', text: 'Third item' },
];

describe('plan→work-item promotion (unified-work-item-ledger P-003)', () => {
  describe('computePromotions', () => {
    it('unions linked files across plan items while retaining complete link metadata', () => {
      const first = { ...unknownAnchor({ symbol: 'linked' }, 'no-snapshot'), path: 'src/a.ts',
        symbolId: 'symbol-a', consumers: [{ path: 'src/caller.ts', line: 7 }], tests: ['src/a.test.ts'] };
      const second = unknownAnchor({ path: 'src/b.ts' }, 'not-found');
      const payload = codePayloadForPlanItems(['P-001', 'P-002'], {
        'P-001': [first], 'P-002': [first, second],
      }, 'Misleading src/other.ts');
      expect(payload).toEqual({ paths: ['src/a.ts', 'src/b.ts'], anchors: [first, first, second] });
      const [spec] = computePromotions({ planSlug: 'p', harness: 'h', openItems: [items[0]],
        existingPromotedItemIds: [], anchorsByItem: { 'P-001': [first] } });
      expect(spec.payload).toEqual({ paths: ['src/a.ts'], anchors: [first] });
    });

    it('preserves explicit empty paths for unresolved symbols and derives paths only without links', () => {
      const unknown = unknownAnchor({ symbol: 'missing' }, 'no-snapshot');
      expect(codePayloadForPlanItems(['P-001'], { 'P-001': [unknown] }, 'src/other.ts'))
        .toEqual({ anchors: [unknown], paths: [] });
      expect(codePayloadForPlanItems(['P-001'], {}, 'Touch src/fallback.ts and src/fallback.ts'))
        .toEqual({ paths: ['src/fallback.ts'] });
      expect(codePayloadForPlanItems(['P-001'], {}, 'No files')).toBeUndefined();
    });

    it('defers acceptance promotion even when every open build lane already has a work-item', () => {
      const base = { planSlug: 'p', harness: 'h', existingPromotedItemIds: ['P-001'] };
      const grading = { id: 'P-002', text: 'Independent acceptance grading', phase: 'Acceptance' };
      expect(computePromotions({ ...base, openItems: [items[0], grading] })).toEqual([]);
      expect(computePromotions({ ...base, openItems: [grading] }).map(x => x.sourcePlanItemIds[0])).toEqual(['P-002']);
    });

    it('promotes every open item when none exist yet', () => {
      const specs = computePromotions({
        planSlug: 'my-plan',
        harness: 'papercusp',
        openItems: items,
        existingPromotedItemIds: [],
      });
      expect(specs).toHaveLength(3);
      expect(specs.map((s) => s.sourcePlanItemIds[0])).toEqual(['P-001', 'P-002', 'P-003']);
      for (const s of specs) {
        expect(s.kind).toBe('feature');
        expect(s.harness).toBe('papercusp');
        expect(s.sourcePlanSlug).toBe('my-plan');
        expect(s.sourcePlanItemIds).toHaveLength(1);
      }
    });

    it('promotes ONLY the items not already covered (idempotency key)', () => {
      const specs = computePromotions({
        planSlug: 'my-plan',
        harness: 'papercusp',
        openItems: items,
        existingPromotedItemIds: ['P-001', 'P-003'],
      });
      expect(specs.map((s) => s.sourcePlanItemIds[0])).toEqual(['P-002']);
    });

    it('is idempotent — re-running after everything is promoted yields nothing', () => {
      const specs = computePromotions({
        planSlug: 'my-plan',
        harness: 'papercusp',
        openItems: items,
        existingPromotedItemIds: ['P-001', 'P-002', 'P-003'],
      });
      expect(specs).toEqual([]);
    });

    it('promotes nothing when there are no open items', () => {
      expect(
        computePromotions({
          planSlug: 'p',
          harness: 'h',
          openItems: [],
          existingPromotedItemIds: [],
        }),
      ).toEqual([]);
    });

    it('carries the plan slug + harness onto each spec', () => {
      const [spec] = computePromotions({
        planSlug: 'ledger-plan',
        harness: 'papercup',
        openItems: [{ id: 'P-009', text: 'do the thing' }],
        existingPromotedItemIds: [],
      });
      expect(spec).toEqual({
        kind: 'feature',
        harness: 'papercup',
        title: 'do the thing',
        sourcePlanSlug: 'ledger-plan',
        sourcePlanItemIds: ['P-009'],
      });
    });
  });

  describe('titleFromPlanItem', () => {
    it('collapses whitespace and trims', () => {
      expect(titleFromPlanItem({ id: 'P-1', text: '  a   b\n c  ' })).toBe('a b c');
    });
    it('falls back to the item id when text is blank', () => {
      expect(titleFromPlanItem({ id: 'P-7', text: '   ' })).toBe('P-7');
    });
    it('clamps an over-long title to 200 chars with an ellipsis', () => {
      const long = 'x'.repeat(500);
      const title = titleFromPlanItem({ id: 'P-1', text: long });
      expect(title.length).toBe(200);
      expect(title.endsWith('…')).toBe(true);
    });
  });
});
