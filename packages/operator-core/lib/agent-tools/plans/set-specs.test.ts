import { describe, expect, it } from 'vitest';
import { RECORDED_TEST_LAYERS } from '@papercusp/test-config/execution-details';
import tool from './set-specs';

const clause = {
  specId: 'SPEC-personal-desktop',
  expectedRevision: 0,
  planItemId: 'P-006',
  behavior: 'The personal desktop survives reconnect on a real host.',
  behaviorClass: 'lifecycle',
  lifecycleStatus: 'active',
  requiredEvidence: ['live'],
};

describe('plans:set-specs recorded test layers (EI-25307246967369800)', () => {
  it.each(['live', 'component', 'mutation', 'unknown-layer'])(
    'refuses an unrecordable %s layer in single and bulk writes',
    (layer) => {
      const spec = { ...clause, requiredTestLayers: ['e2e', layer] };
      for (const payload of [{ spec }, { items: [spec] }]) {
        const result = tool.args.safeParse({ slug: 'personal-desktop', ...payload });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((issue) => issue.path.includes('requiredTestLayers'))).toBe(true);
        }
      }
    },
  );

  it('accepts every recorded layer while keeping the live evidence plane', () => {
    const parsed = tool.args.parse({
      slug: 'personal-desktop',
      spec: { ...clause, requiredTestLayers: [...RECORDED_TEST_LAYERS] },
    });
    expect(parsed.spec?.requiredTestLayers).toEqual([...RECORDED_TEST_LAYERS]);
    expect(parsed.spec?.requiredEvidence).toEqual(['live']);
  });

  it('requires an outer plan slug for bulk items so plan-bound clauses cannot fall back to ad-hoc scope', () => {
    const missingSlug = tool.args.safeParse({ items: [clause] });
    expect(missingSlug.success).toBe(false);
    if (!missingSlug.success) {
      expect(missingSlug.error.issues.some((issue) => issue.path.includes('slug'))).toBe(true);
    }

    expect(tool.args.safeParse({ spec: clause }).success).toBe(true);
    expect(tool.args.safeParse({ slug: 'adhoc-work-item-specs', items: [clause] }).success).toBe(true);
  });
});
