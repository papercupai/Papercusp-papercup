import { describe, expect, it, vi } from 'vitest';

const { workItemRuntimeImport } = vi.hoisted(() => ({
  workItemRuntimeImport: vi.fn(),
}));

vi.mock('../work-items', () => {
  workItemRuntimeImport();
  return { WORK_ITEM_ID_PATTERN: '^(?:(?:WI|F|EI)-\\d+|F-FIX-\\d+|PR-\\d+-P-\\d+)$' };
});

const { PRE_PROMPT_REGISTRY } = await import('./pre-prompt-registry-config');
const runtimeLoadsDuringRegistration = workItemRuntimeImport.mock.calls.length;
const claimIdPattern = new RegExp(
  PRE_PROMPT_REGISTRY.find((entry) => entry.name === 'work_items:claim')!.columnOverrides!.id!.pattern!,
);

describe('prompt schema cold registration', () => {
  it('registers claim ID validation without loading the work-item runtime', () => {
    expect(runtimeLoadsDuringRegistration).toBe(0);
  });

  it.each(['WI-10008092', 'F-12', 'EI-25500068013952985', 'F-FIX-051', 'PR-971-P-001'])(
    'accepts the existing work-item ID %s',
    (id) => expect(claimIdPattern.test(id)).toBe(true),
  );

  it.each(['done', 'P-001', 'WI-', 'WI-1-extra', 'F-FIX-', 'PR-971', 'PR-971-P-', ' WI-1', 'WI-1\n'])(
    'rejects a misplaced or malformed work-item ID %j',
    (id) => expect(claimIdPattern.test(id)).toBe(false),
  );
});
