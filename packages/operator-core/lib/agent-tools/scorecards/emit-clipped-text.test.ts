/**
 * WI-10005715 (EI-24791159197848671): scorecards:emit refuses narrative that ENDS with the
 * MCP result door's clip marker, reusing docs:author's detector so there is one definition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasResultDoorTruncation } from '@papercusp/docs-engine';
import { truncatedBodyVerdict } from '../docs/author';

const readRubric = vi.fn();
vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return { ...real, readRubric: (...a: unknown[]) => readRubric(...a) };
});

import { emitScorecard } from './emit';
import {
  CLIPPED_SCORECARD_TEXT_CODE,
  clippedScorecardTextMessage,
  findClippedScorecardText,
} from './emit-clipped-text';

/**
 * The exact string the live result door emitted on a real tool response (observed
 * 2026-10-03 on a `dev:pipeline_position` result). It is a literal rather than an import
 * because the door has no exported producer; the calibration block below is what ties it
 * to the shared detector so a format change on either side fails here.
 */
const DOOR_MARKER = '…[TRUNCATED +6339 chars — see _projection.cursor]';
const clip = (prefix: string): string => `${prefix} ${DOOR_MARKER}`;

describe('findClippedScorecardText', () => {
  it('flags a rating whose evidence ENDS with the clip marker, naming the exact field', () => {
    const path = findClippedScorecardText({
      ratings: { 'tests-pass': { evidence: clip('ran the suite; 41 files, all') } },
    });
    expect(path).toBe('ratings.tests-pass.evidence');
  });

  it.each([
    ['title', { title: clip('Graded draft') }],
    ['body', { body: clip('Narrative body') }],
    ['acceptance.reasoning', { acceptance: { reasoning: clip('accepted because') } }],
    ['ratings.c1.suggestion', { ratings: { c1: { suggestion: clip('next, do') } } }],
    ['ratings.c1.nextEvidenceAction', { ratings: { c1: { nextEvidenceAction: clip('re-run') } } }],
    ['ratings.c1.remediation', { ratings: { c1: { remediation: clip('tracked by') } } }],
    ['ratings.c1.disregard', { ratings: { c1: { disregard: clip('not acting because') } } }],
  ])('flags every caller-authored narrative field — %s', (expected, args) => {
    expect(findClippedScorecardText(args)).toBe(expected);
  });

  it('tolerates trailing whitespace after the marker (the detector is end-anchored, not char-anchored)', () => {
    expect(findClippedScorecardText({ body: `${clip('x')}\n  ` })).toBe('body');
  });

  it('NEGATIVE: a marker quoted MID-PROSE passes — a rating may explain this very failure mode', () => {
    const quoted = `The door leaves ${DOOR_MARKER} where the tail was, and the grader re-read the full result afterwards.`;
    expect(findClippedScorecardText({ ratings: { c1: { evidence: quoted } }, body: quoted })).toBeNull();
  });

  it('NEGATIVE: whole, unclipped text passes, and absent optional fields are skipped', () => {
    expect(
      findClippedScorecardText({
        title: 'ok',
        ratings: { c1: { evidence: 'complete evidence', suggestion: undefined }, c2: undefined },
      }),
    ).toBeNull();
    expect(findClippedScorecardText({})).toBeNull();
  });

  it('reports the FIRST clipped field deterministically (title before body before ratings)', () => {
    expect(
      findClippedScorecardText({ body: clip('b'), ratings: { c1: { evidence: clip('e') } } }),
    ).toBe('body');
  });
});

describe('clippedScorecardTextMessage', () => {
  it('names the field, the remedy, and that nothing was filed; offers no override', () => {
    const error = clippedScorecardTextMessage('ratings.c1.evidence');
    expect(error).toContain('ratings.c1.evidence');
    expect(error).toContain("payloadTier:'full'");
    expect(error).toContain('_projection.cursor');
    expect(error).toContain('Nothing was filed');
    expect(error).toContain('no override');
  });
});

describe('calibration: ONE definition of the result door marker, shared with docs:author', () => {
  const samples: Array<[label: string, text: string, clipped: boolean]> = [
    ['door marker at the end', clip('partial'), true],
    ['door marker + trailing whitespace', `${clip('partial')}\n`, true],
    ['marker quoted mid-prose', `before ${DOOR_MARKER} after`, false],
    ['plain text', 'complete and whole', false],
    // Near-miss formats: a marker-format drift on one side must not be silently accepted.
    ['wrong verb', '…[CLIPPED +12 chars — see _projection.cursor]', false],
    ['missing em dash tail', '…[TRUNCATED +12 chars]', false],
  ];

  it.each(samples)('the shared detector and this guard agree — %s', (_label, text, clipped) => {
    expect(hasResultDoorTruncation(text)).toBe(clipped);
    expect(findClippedScorecardText({ body: text }) !== null).toBe(clipped);
  });

  it('docs:author refuses the same clipped samples this guard refuses (a format change fails BOTH suites)', () => {
    for (const [, text, clipped] of samples) {
      const docsRefused = truncatedBodyVerdict(text)?.code === 'truncated_body';
      expect(docsRefused).toBe(clipped);
      expect(findClippedScorecardText({ body: text }) !== null).toBe(docsRefused);
    }
  });
});

describe('emitScorecard — the guard sits at the write facade, before any store read', () => {
  beforeEach(() => {
    readRubric.mockReset();
  });

  const call = (evidence: string) =>
    emitScorecard(
      { rubricRef: 'wi-10005715-rubric', ratings: { c1: { rating: 'pass', evidence } } } as unknown as Parameters<
        typeof emitScorecard
      >[0],
      { createdBy: 'su-test' },
    );

  it('refuses a clipped rating with the typed code and never reads the rubric (nothing persisted)', async () => {
    const res = await call(clip('graded draft evidence'));
    expect(res).toMatchObject({ ok: false, code: CLIPPED_SCORECARD_TEXT_CODE });
    expect((res as { error: string }).error).toContain('ratings.c1.evidence');
    expect(readRubric).not.toHaveBeenCalled();
  });

  it('CONTROL: the identical call with whole evidence DOES reach the rubric read (the guard is not a blanket refusal)', async () => {
    readRubric.mockResolvedValue({ kind: 'missing' });
    const res = await call('complete, authored evidence');
    expect(res).toMatchObject({ ok: false, error: "rubric 'wi-10005715-rubric' not found" });
    expect(readRubric).toHaveBeenCalledTimes(1);
  });
});
