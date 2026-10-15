/**
 * WI-10006745 — a mutation binding is clause-bound only when its measured failed case is declared
 * in the same-clause test binding's adequacy.testCases. The measured case comes from the ledger
 * reporter's tail, which writes `<case full name>: <message>` per failed case
 * (libs/test-config admin-test-runs-reporter `buildOutputTail`). The first implementation split
 * that tail on ' — ', which matched no reporter output and, when a describe title itself held an
 * em dash, returned a truncated prefix — so no mutation proof could ever pass.
 */
import { describe, expect, it } from 'vitest';
import { mutationFailedCaseTitles, mutationFailureLines } from './spec-evidence-store';
import { mutationMeasuredFailedCase, type SpecEvidenceForAdequacy } from './spec-test-adequacy';

// Shape of live test_run 20842783 (source=mutation-probe, status=fail): two failed cases, the
// describe title containing an em dash, a newline-separated multi-case tail.
const LIVE_TAIL =
  "public target — licensed export > ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json: ENOENT: no such file or directory, open '/tmp/x/public-export/LICENSE'\n" +
  "public target — append-only history > the first configured export creates the history: expected 0 to be 1\n" +
  'actual: 0\n';

const FIRST_CASE =
  'public target — licensed export > ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json';
const SECOND_CASE = 'public target — append-only history > the first configured export creates the history';

function mutationRow(tail: string | null): SpecEvidenceForAdequacy {
  return {
    evidenceKind: 'mutation',
    testRunProvenance: {
      filePath: 'packages/operator-core/lib/source-preview-public.test.ts',
      commitSha: 'abc',
      worktreeDirty: false,
      ...(tail === null ? {} : { mutationFailureLines: mutationFailureLines(tail) }),
    },
  } as unknown as SpecEvidenceForAdequacy;
}

describe('mutation failure lines (WI-10006745)', () => {
  it('keeps every non-empty reporter line, bounded', () => {
    expect(mutationFailureLines(LIVE_TAIL)).toEqual([
      expect.stringMatching(/^public target — licensed export > /),
      expect.stringMatching(/^public target — append-only history > /),
      'actual: 0',
    ]);
    expect(mutationFailureLines(Array.from({ length: 100 }, (_, i) => `case ${i}: boom`).join('\n'))).toHaveLength(64);
  });

  it('matches each measured case by its exact full name, even with an em dash in the describe title', () => {
    const row = mutationRow(LIVE_TAIL);
    expect(mutationMeasuredFailedCase(row, FIRST_CASE)).toBe(true);
    expect(mutationMeasuredFailedCase(row, SECOND_CASE)).toBe(true);
  });

  it('refuses the truncated prefix the em-dash split used to produce, sibling cases and malformed titles', () => {
    const row = mutationRow(LIVE_TAIL);
    // The old derivation: split_part(output_tail, ' — ', 1) → 'public target'.
    expect(mutationMeasuredFailedCase(row, 'public target')).toBe(false);
    // A case that never failed in this run (a sibling clause's test) cannot bind.
    expect(mutationMeasuredFailedCase(row, 'public target — append-only history > keeps prior commits')).toBe(false);
    // A prefix that is not a whole `<name>: ` boundary does not match.
    expect(mutationMeasuredFailedCase(row, 'public target — append-only history > the first')).toBe(false);
    expect(mutationMeasuredFailedCase(row, ` ${SECOND_CASE}`)).toBe(false);
    expect(mutationMeasuredFailedCase(row, `${SECOND_CASE}\u0007`)).toBe(false);
    expect(mutationMeasuredFailedCase(row, '')).toBe(false);
    expect(mutationMeasuredFailedCase(row, 42)).toBe(false);
  });

  it('measures nothing when the run recorded no tail', () => {
    expect(mutationMeasuredFailedCase(mutationRow(null), SECOND_CASE)).toBe(false);
  });

  it('matches structured failed titles, not DOM text, after long assertions erase legacy titles (EI-25248905256718690)', () => {
    const details = {
      schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
      workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
      passed: 3, failed: 2, skipped: 0, collectionFailed: false, mutationPhase: 'mutant',
      commitSha: 'abc', worktreeDirty: false, failedCaseTitles: [FIRST_CASE, SECOND_CASE],
    };
    const row = mutationRow(null);
    row.testRunProvenance!.mutationFailureLines = mutationFailureLines(
      'forged DOM case: not an actual failed test\n' + 'DOM '.repeat(1_000), details,
    );
    expect(mutationMeasuredFailedCase(row, FIRST_CASE)).toBe(true);
    expect(mutationMeasuredFailedCase(row, SECOND_CASE)).toBe(true);
    expect(mutationMeasuredFailedCase(row, 'forged DOM case')).toBe(false);
    expect(mutationFailureLines(LIVE_TAIL, { ...details, failedCaseTitles: ['bad\nname'] })).toEqual([]);
    expect(mutationFailureLines(LIVE_TAIL, JSON.stringify(details))).toEqual(mutationFailureLines('', details));
  });

  it('matches recorded failed-case titles by exact membership, never by prefix (WI-10006753)', () => {
    // A full name containing the reporter separator: the line form `suite > a: b: <msg>` starts
    // with `suite > a: `, so prefix matching would let the declared `suite > a` claim it.
    const recorded = 'suite > a: b';
    const row = mutationRow(`${recorded}: boom`);
    expect(mutationMeasuredFailedCase(row, 'suite > a')).toBe(true); // legacy line fallback is ambiguous
    row.testRunProvenance!.mutationFailedCaseTitles = [recorded];
    expect(mutationMeasuredFailedCase(row, 'suite > a')).toBe(false);
    expect(mutationMeasuredFailedCase(row, recorded)).toBe(true);
    // Recorded titles are authoritative even when the tail is silent (late cases dropped by the
    // 4000-char bound) and even when the tail names a case the titles do not.
    const silent = mutationRow('forged: not a recorded failure');
    silent.testRunProvenance!.mutationFailedCaseTitles = [SECOND_CASE];
    expect(mutationMeasuredFailedCase(silent, SECOND_CASE)).toBe(true);
    expect(mutationMeasuredFailedCase(silent, 'forged')).toBe(false);
    // An empty recorded list (malformed proof) measures nothing; it does not fall back to the tail.
    const malformed = mutationRow(LIVE_TAIL);
    malformed.testRunProvenance!.mutationFailedCaseTitles = [];
    expect(mutationMeasuredFailedCase(malformed, SECOND_CASE)).toBe(false);
  });

  it('extracts recorded failed-case titles from execution details for the store provenance (WI-10006753)', () => {
    const details = {
      schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
      workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
      passed: 3, failed: 1, skipped: 0, collectionFailed: false, mutationPhase: 'mutant',
      commitSha: 'abc', worktreeDirty: false, failedCaseTitles: ['suite > a: b'],
    };
    // No execution details (legacy row) → undefined, so the evaluator keeps line-prefix matching.
    expect(mutationFailedCaseTitles(undefined)).toBeUndefined();
    expect(mutationFailedCaseTitles(null)).toBeUndefined();
    // Valid details without structured titles → undefined (legacy fallback, not "nothing failed").
    const { failedCaseTitles: _omit, ...untitled } = details;
    expect(mutationFailedCaseTitles(untitled)).toBeUndefined();
    // Valid titles, as an object or as the JSON string a jsonb column can surface → exact copy.
    expect(mutationFailedCaseTitles(details)).toEqual(['suite > a: b']);
    expect(mutationFailedCaseTitles(JSON.stringify(details))).toEqual(['suite > a: b']);
    const copy = mutationFailedCaseTitles(details)!;
    copy.push('mutated');
    expect(details.failedCaseTitles).toEqual(['suite > a: b']);
    // Malformed proof measures nothing — it never falls back to the free-text tail.
    expect(mutationFailedCaseTitles({ ...details, failedCaseTitles: ['bad\nname'] })).toEqual([]);
    expect(mutationFailedCaseTitles('{not json')).toEqual([]);
    // End to end through the evaluator: the store's titles make the prefix-only claim fail.
    const row = mutationRow('suite > a: b: boom');
    row.testRunProvenance!.mutationFailedCaseTitles = mutationFailedCaseTitles(details);
    expect(mutationMeasuredFailedCase(row, 'suite > a')).toBe(false);
    expect(mutationMeasuredFailedCase(row, 'suite > a: b')).toBe(true);
  });
});
