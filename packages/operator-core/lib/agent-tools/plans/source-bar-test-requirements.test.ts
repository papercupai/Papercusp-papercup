import { beforeEach, describe, expect, it, vi } from 'vitest';

const rubricReads = vi.hoisted(() => ({ getRubric: vi.fn() }));

vi.mock('../../rubrics', () => ({ getRubric: rubricReads.getRubric }));

import { readLiveAcceptanceCriteria } from '../../acceptance-live-requirements';
import type { SpecClauseBarPin } from './spec-clauses-store';
import { resolveSourceBarTestRequirements, type SourceBarLiveRead } from './source-bar-test-requirements';

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

/**
 * agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001 (R-1): a path-only requirement edit
 * no longer amends the rubric, so adequacy must grade against the LIVE block's check.files when the
 * pin is the rubric's current revision — otherwise a moved test file reads as missing evidence.
 */
describe('source BAR test requirements read live requirement check.files', () => {
  const MOVED = 'packages/new-home/moved.test.ts';
  const planRubric = () => sourceRubric({ subjectPlan: 'live-plan-fixture', subjectHarnessSlug: 'papercusp' });

  function liveRead(opts: {
    currentRevision?: number | null;
    liveFiles?: string[];
    liveKind?: string;
    planReadable?: boolean;
    throws?: boolean;
  } = {}): SourceBarLiveRead & { liveCalls: () => number } {
    let calls = 0;
    return {
      currentRevision: async () => opts.currentRevision === undefined ? pin.rubricRevision : opts.currentRevision,
      liveCriteria: async (rubric) => {
        calls += 1;
        if (opts.throws) throw new Error('plan store down');
        const check = (opts.liveKind ?? 'tests') === 'tests'
          ? { kind: 'tests', files: opts.liveFiles ?? [MOVED] }
          : { kind: opts.liveKind!, instrumentKey: 'x' };
        // Exercise the REAL overlay policy, not a hand-rolled copy of it.
        return readLiveAcceptanceCriteria(rubric, {
          readSubjectPlanContent: async () => (opts.planReadable === false ? null : { content: 'plan', version: 3 }),
          parseRequirementBars: () => ({ ok: true, bars: [{ barKey: pin.barKey, criterion: { check } }] }),
        });
      },
      liveCalls: () => calls,
    };
  }

  beforeEach(() => vi.resetAllMocks());

  it('grades against the live block files when the pin is the current revision, naming the pinned copy', async () => {
    rubricReads.getRubric.mockResolvedValue(planRubric());
    const live = liveRead();

    const result = await resolveSourceBarTestRequirements(pin, new Map(), live);

    expect(result).toEqual({
      status: 'required',
      files: [MOVED],
      liveRequirement: { subjectPlan: 'live-plan-fixture', pinnedFiles: ['a.test.ts', 'z.test.ts'] },
    });
  });

  it('keeps an older pinned revision an immutable snapshot and never reads the plan', async () => {
    rubricReads.getRubric.mockResolvedValue(planRubric());
    const live = liveRead({ currentRevision: pin.rubricRevision + 1 });

    await expect(resolveSourceBarTestRequirements(pin, new Map(), live)).resolves.toEqual({
      status: 'required',
      files: ['a.test.ts', 'z.test.ts'],
    });
    expect(live.liveCalls()).toBe(0);
  });

  it.each([
    ['the subject plan is unreadable', { planReadable: false }],
    ['the live read throws', { throws: true }],
    ['the live block changed the check kind', { liveKind: 'instrument' }],
    ['the live block names no files', { liveFiles: ['  '] }],
  ])('falls back to the pinned files when %s', async (_case, opts) => {
    rubricReads.getRubric.mockResolvedValue(planRubric());

    await expect(resolveSourceBarTestRequirements(pin, new Map(), liveRead(opts))).resolves.toEqual({
      status: 'required',
      files: ['a.test.ts', 'z.test.ts'],
    });
  });

  it('does not consult the live view for a rubric with no subject plan', async () => {
    rubricReads.getRubric.mockResolvedValue(sourceRubric());
    const live = liveRead();

    await expect(resolveSourceBarTestRequirements(pin, new Map(), live)).resolves.toEqual({
      status: 'required',
      files: ['a.test.ts', 'z.test.ts'],
    });
    expect(live.liveCalls()).toBe(0);
  });

  it('reads the live plan once per rubric revision across clauses sharing a cache', async () => {
    rubricReads.getRubric.mockResolvedValue(planRubric());
    const live = liveRead();
    const cache = new Map();

    const [first, second] = await Promise.all([
      resolveSourceBarTestRequirements(pin, cache, live),
      resolveSourceBarTestRequirements(pin, cache, live),
    ]);

    expect(first).toMatchObject({ files: [MOVED] });
    expect(second).toMatchObject({ files: [MOVED] });
    expect(live.liveCalls()).toBe(1);
  });
});
