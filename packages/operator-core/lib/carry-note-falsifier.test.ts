/**
 * carry-note-falsifier.test.ts — EI-23771449112267271.
 *
 * A carried check row needs a FALSIFIER (the result that would mean the claim is FALSE) and a way
 * to say "probed, but the sample could not discriminate". A probe alone says how to LOOK; without a
 * falsifier any non-contradicting sample reads as confirmation, so a ✓ row can sit on a sample that
 * was incapable of failing. Same contract `facts:assert` already ships (`falsifier`, `recheckMissing`).
 *
 * Kept in its own file (not carry-note.test.ts) so it does not re-stale proofs other plans have bound
 * to that file's bytes. Pure — no DB.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  CARRY_ROW_SOFT_CAPS,
  FALSIFIER_MISSING_NOTE,
  SAMPLE_INCONCLUSIVE_PREFIX,
  checksMissingFalsifier,
  normalizeCheckEntries,
  parseCheckLine,
  renderCheckLine,
  splitCarryNoteChecks,
  withCarryNoteChecks,
  type CheckEntry,
} from './carry-note';

const NOW = Date.parse('2026-10-02T05:00:00.000Z');
const WITH_FALSIFIER: CheckEntry = {
  claim: 'the queue depth stays under the alert threshold',
  recheck: 'dev:pg_query count(*) from queue',
  falsifier: 'a sample with depth >= 500 while the consumer is up',
  verified: 'depth 12 and 9 @2026-10-02T04:00:00.000Z',
  sinceMs: Date.parse('2026-10-02T04:00:00.000Z'),
};

describe('check-row falsifier (EI-23771449112267271)', () => {
  it('renders the falsifier between re-check and evidence, and render -> parse -> render is byte-stable', () => {
    const line = renderCheckLine(WITH_FALSIFIER);
    expect(line).toContain(' — re-check: dev:pg_query count(*) from queue — falsifier: a sample with depth >= 500');
    expect(line.indexOf(' — falsifier:')).toBeLessThan(line.indexOf(' — evidence:'));
    expect(parseCheckLine(line)).toEqual(WITH_FALSIFIER);
    expect(renderCheckLine(parseCheckLine(line)!)).toBe(line);
  });

  it('round-trips with no re-check, and a row without one renders no falsifier marker', () => {
    const noRecheck: CheckEntry = { claim: 'c', falsifier: 'x was observed', observed: 'pending' };
    const line = renderCheckLine(noRecheck);
    expect(line).toContain(' — falsifier: x was observed');
    expect(parseCheckLine(line)).toEqual(noRecheck);
    expect(renderCheckLine({ claim: 'c', recheck: 'r', verified: 'v' })).not.toContain('falsifier');
  });

  it('survives the structured-write path (withCarryNoteChecks -> splitCarryNoteChecks)', () => {
    const note = withCarryNoteChecks('body prose', [WITH_FALSIFIER]);
    expect(splitCarryNoteChecks(note).checks).toEqual([WITH_FALSIFIER]);
  });

  it('a re-sent claim inherits its prior falsifier when omitted; an explicit one wins', () => {
    const inherited = normalizeCheckEntries(
      [{ claim: WITH_FALSIFIER.claim, verified: 'depth 3' }],
      [WITH_FALSIFIER],
      NOW,
    );
    expect(inherited[0]!.falsifier).toBe(WITH_FALSIFIER.falsifier);
    const replaced = normalizeCheckEntries(
      [{ claim: WITH_FALSIFIER.claim, falsifier: 'depth >= 100', verified: 'depth 3' }],
      [WITH_FALSIFIER],
      NOW,
    );
    expect(replaced[0]!.falsifier).toBe('depth >= 100');
  });

  it('CARRY_ROW_SOFT_CAPS.falsifier bounds the field', () => {
    expect(CARRY_ROW_SOFT_CAPS.falsifier).toBe(300);
  });
});

describe('sampleAdequate:false — probed, sample could not discriminate (EI-23771449112267271)', () => {
  it("keeps the evidence as CONTEXT on a '?' row and never renders ✓", () => {
    const [row] = normalizeCheckEntries(
      [
        {
          claim: 'the pool is not starved',
          recheck: 'two samples of pool wait',
          verified: 'both samples 0ms',
          sampleAdequate: false,
        },
      ],
      [],
      NOW,
    );
    expect(row).not.toHaveProperty('verified');
    expect(row!.observed).toContain(`${SAMPLE_INCONCLUSIVE_PREFIX}both samples 0ms`);
    const line = renderCheckLine(row!);
    expect(line).toContain('- ? ');
    expect(line).not.toContain('- ✓ ');
    expect(line).toContain(`evidence: ${SAMPLE_INCONCLUSIVE_PREFIX}both samples 0ms`);
    // The state lives in the TEXT, so it survives the round-trip with no new persisted field.
    expect(parseCheckLine(line)).toEqual(row);
    expect(renderCheckLine(parseCheckLine(line)!)).toBe(line);
  });

  it('true / absent leaves a verified row verified (the downgrade is opt-in)', () => {
    for (const sampleAdequate of [true, undefined]) {
      const [row] = normalizeCheckEntries(
        [{ claim: 'k', recheck: 'r', verified: 'ok 3/3', ...(sampleAdequate === undefined ? {} : { sampleAdequate }) }],
        [],
        NOW,
      );
      expect(row!.verified).toContain('ok 3/3');
      expect(renderCheckLine(row!)).toContain('- ✓ ');
    }
  });

  it('does not stack the prefix when the evidence is already marked inconclusive', () => {
    const [row] = normalizeCheckEntries(
      [{ claim: 'k', verified: `${SAMPLE_INCONCLUSIVE_PREFIX}ctx`, sampleAdequate: false }],
      [],
      NOW,
    );
    const evidence = (row!.observed ?? '') + (row!.verified ?? '');
    expect(evidence.split(SAMPLE_INCONCLUSIVE_PREFIX).length - 1).toBe(1);
  });
});

describe('checksMissingFalsifier — the warn-only advisory population (EI-23771449112267271)', () => {
  it('flags ✓ rows with no falsifier (by #id, else a clipped claim) and nothing else', () => {
    const flagged = checksMissingFalsifier([
      { id: 'a1', claim: 'verified, no falsifier', verified: 'ok' },
      { claim: 'x'.repeat(200), verified: 'ok' },
      { claim: 'verified WITH falsifier', verified: 'ok', falsifier: 'fails if y' },
      { claim: 'predicted only', recheck: 'r' },
      { claim: 'inconclusive sample', verified: 'ok', sampleAdequate: false },
      { claim: 'contested', contested: 'STILL RUNNING' },
    ]);
    expect(flagged).toEqual(['#a1', 'x'.repeat(80)]);
  });

  it('returns [] for an empty list, and still flags a whitespace-only falsifier (that is not one)', () => {
    expect(checksMissingFalsifier([])).toEqual([]);
    expect(checksMissingFalsifier([{ claim: 'blank falsifier', verified: 'ok', falsifier: '   ' }])).toEqual([
      'blank falsifier',
    ]);
  });

  it('the note names both remedies so it is actionable', () => {
    expect(FALSIFIER_MISSING_NOTE).toContain('falsifier');
    expect(FALSIFIER_MISSING_NOTE).toContain('sampleAdequate:false');
  });
});

// Both checkpoint surfaces take the same `checks` rows, so they must carry the same falsifier
// contract. The handler suites mock heavily (and other plans bind proofs to their bytes), so the
// cross-surface PARITY is guarded here against the comment-stripped sources instead.
describe('falsifier wiring parity across loop:checkpoint and work_items:checkpoint (EI-23771449112267271)', () => {
  const REQUIRED_TOKENS = [
    'falsifier:',
    'sampleAdequate:',
    'CARRY_ROW_SOFT_CAPS.falsifier',
    'checksMissingFalsifier',
    'falsifierMissing',
  ] as const;
  const gaps = (src: string): string[] => REQUIRED_TOKENS.filter((token) => !src.includes(token));
  const live = (rel: string): string => {
    const url = new URL(rel, import.meta.url);
    return stripCommentsOnly(readFileSync(url, 'utf8'), url.pathname) as string;
  };

  it.each([
    ['loop:checkpoint', './agent-tools/loop/checkpoint.ts'],
    ['work_items:checkpoint', './agent-tools/work_items/checkpoint.ts'],
  ])('%s accepts, caps, and advises on the falsifier in LIVE code (not just a comment)', (_name, rel) => {
    expect(gaps(live(rel))).toEqual([]);
  });

  it('the detector is not vacuous: a surface missing the wiring, or only mentioning it in a comment, is reported', () => {
    expect(gaps('const checks = z.object({ recheck: z.string() });')).toEqual([...REQUIRED_TOKENS]);
    const commentOnly = stripCommentsOnly(`// falsifier: sampleAdequate: falsifierMissing\nconst x = 1;`, 'x.ts') as string;
    expect(gaps(commentOnly)).toEqual([...REQUIRED_TOKENS]);
  });
});
