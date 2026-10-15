import { beforeEach, describe, expect, it, vi } from 'vitest';

const rubricReads = vi.hoisted(() => ({ getRubric: vi.fn() }));

vi.mock('../../rubrics', () => ({ getRubric: rubricReads.getRubric }));

import type { SpecClauseBarPin } from './spec-clauses-store';
import { resolveSourceBarTestRequirements } from './source-bar-test-requirements';

const pin: SpecClauseBarPin = {
  barKey: 'BAR-TESTS',
  barHash: 'bar-hash',
  barSetHash: 'bar-set-hash',
  rubricSlug: 'acceptance-service',
  rubricRevision: 4,
  evidencePlane: 'tree',
};

function sourceRubric(overrides: Record<string, unknown> = {}) {
  return {
    rubricId: pin.rubricSlug,
    revision: pin.rubricRevision,
    kind: 'acceptance',
    barSetHash: pin.barSetHash,
    criteria: [{
      key: 'criterion-1',
      barKey: pin.barKey,
      barHash: pin.barHash,
      evidencePlane: pin.evidencePlane,
      check: { kind: 'tests', files: ['z.test.ts', 'a.test.ts', 'a.test.ts'] },
    }],
    ...overrides,
  };
}

describe('source BAR test requirement resolution', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads and normalizes check.files from the exact pinned rubric revision and BAR identity', async () => {
    rubricReads.getRubric.mockResolvedValue(sourceRubric());

    const result = await resolveSourceBarTestRequirements(pin);

    expect(rubricReads.getRubric).toHaveBeenCalledExactlyOnceWith(pin.rubricSlug, pin.rubricRevision);
    expect(result).toEqual({ status: 'required', files: ['a.test.ts', 'z.test.ts'] });
  });

  it.each([
    ['rubric id', { rubricId: 'other-rubric' }],
    ['rubric revision', { revision: 5 }],
    ['rubric kind', { kind: 'standard' }],
    ['BAR-set hash', { barSetHash: 'other-set' }],
  ])('keeps a mismatched pinned %s unavailable', async (_field, override) => {
    rubricReads.getRubric.mockResolvedValue(sourceRubric(override));

    await expect(resolveSourceBarTestRequirements(pin)).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it.each([
    ['BAR hash', { barHash: 'other-bar' }],
    ['evidence plane', { evidencePlane: 'live' }],
  ])('keeps a mismatched pinned %s unavailable', async (_field, criterionOverride) => {
    rubricReads.getRubric.mockResolvedValue(sourceRubric({
      criteria: [{
        ...sourceRubric().criteria[0],
        ...criterionOverride,
      }],
    }));

    await expect(resolveSourceBarTestRequirements(pin)).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('keeps absent, duplicated, or empty test checks explicit instead of inventing files', async () => {
    rubricReads.getRubric.mockResolvedValue(null);
    await expect(resolveSourceBarTestRequirements(pin)).resolves.toMatchObject({ status: 'unavailable' });

    rubricReads.getRubric.mockResolvedValue(sourceRubric({
      criteria: [sourceRubric().criteria[0], sourceRubric().criteria[0]],
    }));
    await expect(resolveSourceBarTestRequirements(pin)).resolves.toMatchObject({ status: 'unavailable' });

    rubricReads.getRubric.mockResolvedValue(sourceRubric({
      criteria: [{ ...sourceRubric().criteria[0], check: { kind: 'tests', files: [] } }],
    }));
    await expect(resolveSourceBarTestRequirements(pin)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('does not require registered files when the exact source BAR has another check kind', async () => {
    rubricReads.getRubric.mockResolvedValue(sourceRubric({
      criteria: [{ ...sourceRubric().criteria[0], check: { kind: 'instrument', instrumentKey: 'none' } }],
    }));

    await expect(resolveSourceBarTestRequirements(pin)).resolves.toEqual({ status: 'not-required' });
  });
});
