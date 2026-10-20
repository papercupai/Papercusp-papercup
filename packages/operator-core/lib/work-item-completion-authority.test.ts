import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_AUTHORITY_TRANSITIONS,
  WORK_ITEM_COMPLETION_AUTHORITIES,
  authorityForCompletion,
  canTransition,
  countsTowardBurnDown,
  insufficientEvidenceReason,
  isCompletionSettled,
  isLegacyClose,
  isSufficientEvidence,
  isWorkItemCompletionAuthority,
  transitionsFrom,
  type WorkItemCompletionAuthority,
} from './work-item-completion-authority';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
// 677 introduced the column and its CHECK (the value set lives there). 678 attempted a
// rename, was abandoned as impossible, and survives as comment-only documentation
// (D-009). Both are read so that editing either out of step with this module fails here.
const MIGRATION_VALUES = join(REPO_ROOT, 'libs/papercusp/libs/db/sql/677-work-item-authority-state.sql');
const MIGRATION_RENAME = join(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/678-rename-authority-to-completion-authority.sql',
);

describe('the authority state table', () => {
  it('only references declared authority values', () => {
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS) {
      expect(isWorkItemCompletionAuthority(t.to), `bad \`to\`: ${t.to}`).toBe(true);
      if (t.from !== null) expect(isWorkItemCompletionAuthority(t.from), `bad \`from\`: ${t.from}`).toBe(true);
      expect(t.by.length, `edge ${t.from}→${t.to} permits no actor`).toBeGreaterThan(0);
      expect(t.when.trim().length, `edge ${t.from}→${t.to} has no condition`).toBeGreaterThan(0);
    }
  });

  it('declares each (from,to) edge exactly once', () => {
    const seen = COMPLETION_AUTHORITY_TRANSITIONS.map((t) => `${t.from}→${t.to}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never transitions back to null — the legacy-close exemption must be unreachable', () => {
    // D-005 exempts terminal rows with a null authority from nagging and reclassification.
    // If any live code path could clear an authority back to null, that exemption would be
    // reachable by an agent wanting its under-evidenced close to stop nagging.
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS) {
      expect(t.to as WorkItemCompletionAuthority | null).not.toBeNull();
    }
  });

  it('reaches every declared authority from a fresh close', () => {
    const reached = new Set<WorkItemCompletionAuthority>();
    let frontier: (WorkItemCompletionAuthority | null)[] = [null];
    while (frontier.length) {
      const next: WorkItemCompletionAuthority[] = [];
      for (const from of frontier) {
        for (const to of transitionsFrom(from)) {
          if (!reached.has(to)) {
            reached.add(to);
            next.push(to);
          }
        }
      }
      frontier = next;
    }
    expect([...reached].sort()).toEqual([...WORK_ITEM_COMPLETION_AUTHORITIES].sort());
  });

  it('keeps the deliberate non-edges absent', () => {
    // Each of these is a design choice documented on COMPLETION_AUTHORITY_TRANSITIONS, not an
    // oversight — so assert them, or a later edit will "helpfully" add them back.
    expect(canTransition('committed', 'pending_human')).toBe(false);
    expect(canTransition('pending_human', 'proposed')).toBe(false);
  });

  it('lets only the gate mint an authority from nothing', () => {
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS.filter((e) => e.from === null)) {
      expect(t.by.some((a) => a === 'gate' || a === 'system')).toBe(true);
      expect(t.by).not.toContain('corroboration');
    }
  });

  it('never lets a system close land in `proposed`', () => {
    // `proposed` means "an agent owes evidence". A reaper owes nothing, and nagging one
    // is noise that teaches agents to skim the nag channel.
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS.filter((e) => e.to === 'proposed')) {
      expect(t.by).not.toContain('system');
    }
  });

  it('reaches `validated` only by corroboration or the contract-checked system settlement', () => {
    // WI-6554700010017006: exactly two edges enter `validated`. The gate never mints it —
    // an agent's own evidence is `committed` at best. If someone wires a gate or owner edge
    // into it, this fails and forces the decision to be made explicitly, not by drift.
    const into = COMPLETION_AUTHORITY_TRANSITIONS.filter((t) => t.to === 'validated');
    expect(into.map((t) => [t.from, [...t.by]])).toEqual([
      [null, ['system']],
      ['committed', ['corroboration']],
    ]);
    expect(canTransition(null, 'validated', 'gate')).toBe(false);
    expect(canTransition(null, 'validated', 'system')).toBe(true);
  });

  it('lets any settled claim be contradicted', () => {
    for (const settled of ['proposed', 'committed', 'validated'] as const) {
      expect(canTransition(settled, 'invalid')).toBe(true);
    }
  });

  it('gates transitions by actor', () => {
    expect(canTransition('pending_human', 'committed', 'owner')).toBe(true);
    expect(canTransition('pending_human', 'committed', 'gate')).toBe(false);
    expect(canTransition('committed', 'validated', 'gate')).toBe(false);
    expect(canTransition('committed', 'validated', 'corroboration')).toBe(true);
  });
});

describe('burn-down semantics', () => {
  it('counts the two authoritative values', () => {
    expect(countsTowardBurnDown('committed', true)).toBe(true);
    expect(countsTowardBurnDown('validated', true)).toBe(true);
  });

  it('excludes unsettled and contradicted claims', () => {
    expect(countsTowardBurnDown('proposed', true)).toBe(false);
    expect(countsTowardBurnDown('pending_human', true)).toBe(false);
    expect(countsTowardBurnDown('invalid', true)).toBe(false);
  });

  it('counts a legacy terminal close (D-005) — never retroactively invalidate history', () => {
    // ~9,600 rows were closed under the old contract. Flipping this line to `false`
    // deletes two thirds of completion history from every burn-down and leader brief.
    expect(countsTowardBurnDown(null, true)).toBe(true);
    expect(isLegacyClose(null, true)).toBe(true);
  });

  it('never counts a non-terminal row, whatever its authority', () => {
    for (const a of [null, ...WORK_ITEM_COMPLETION_AUTHORITIES]) {
      expect(countsTowardBurnDown(a, false)).toBe(false);
    }
    expect(isLegacyClose(null, false)).toBe(false);
  });

  it('preserves abandonment closes regardless of incidental authority', () => {
    for (const a of [null, ...WORK_ITEM_COMPLETION_AUTHORITIES]) {
      expect(countsTowardBurnDown(a, true, true)).toBe(true);
      expect(isCompletionSettled(a, true, true)).toBe(true);
    }
  });
});

describe('shared delivery-settlement semantics', () => {
  it('matches burn-down authority while naming the downstream dependency contract', () => {
    expect(isCompletionSettled('committed', true)).toBe(true);
    expect(isCompletionSettled('validated', true)).toBe(true);
    expect(isCompletionSettled(null, true)).toBe(true);
    expect(isCompletionSettled('proposed', true)).toBe(false);
    expect(isCompletionSettled('pending_human', true)).toBe(false);
    expect(isCompletionSettled('invalid', true)).toBe(false);
    expect(isCompletionSettled('committed', false)).toBe(false);
  });
});

describe('the evidence minimum for `committed`', () => {
  it('requires verifiedHow AND a run/result', () => {
    expect(isSufficientEvidence({ verifiedHow: 'unit', testsRun: 'npm run test:affected' })).toBe(true);
    expect(isSufficientEvidence({ verifiedHow: 'integration', testResult: '9/9 green' })).toBe(true);
  });

  it('rejects a partial evidence object with no verifiedHow', () => {
    // P-002 measured 4.2% of evidence-bearing rows in exactly this shape. A presence
    // check ("is _completionEvidence set?") passes every one of them.
    expect(isSufficientEvidence({ testsRun: 'ran the suite', testResult: 'green' })).toBe(false);
  });

  it('rejects a bare label with nothing behind it', () => {
    expect(isSufficientEvidence({ verifiedHow: 'unit' })).toBe(false);
  });

  it('rejects change-descriptions that assert no check', () => {
    // filesChanged/addedTests say what changed; neither says anything was verified.
    expect(isSufficientEvidence({ verifiedHow: 'manual', filesChanged: ['a.ts'], addedTests: true })).toBe(false);
  });

  it('rejects absent, empty, and whitespace-only evidence', () => {
    expect(isSufficientEvidence(undefined)).toBe(false);
    expect(isSufficientEvidence(null)).toBe(false);
    expect(isSufficientEvidence({})).toBe(false);
    expect(isSufficientEvidence({ verifiedHow: 'unit', testsRun: '   ' })).toBe(false);
  });

  it('maps evidence to the authority a close lands in', () => {
    expect(authorityForCompletion({ verifiedHow: 'unit', testResult: '9/9 green' })).toBe('committed');
    expect(authorityForCompletion({ testResult: '9/9 green' })).toBe('proposed');
    expect(authorityForCompletion(undefined)).toBe('proposed');
  });
});

describe('a ledgered red run refuses `committed` (P-002 / D-017)', () => {
  const GREEN_ON_ITS_FACE = { verifiedHow: 'unit', testsRun: 'testing:run', testResult: 'passed' } as const;

  it('accepts any non-empty test string when NOTHING was judged — today’s grade, unchanged', () => {
    // The fail-open property, asserted from this side too: the whole binding is opt-in on
    // the caller running the probe, so an absent finding must never move the grade. This is
    // also the exact hole P-002 closes — "3 failed" is a non-empty string.
    expect(authorityForCompletion({ verifiedHow: 'unit', testResult: '3 failed' })).toBe('committed');
    expect(authorityForCompletion(GREEN_ON_ITS_FACE, {})).toBe('committed');
    expect(authorityForCompletion(GREEN_ON_ITS_FACE, undefined)).toBe('committed');
  });

  it('downgrades to `proposed` when the ledger contradicts the declared result', () => {
    expect(
      authorityForCompletion(GREEN_ON_ITS_FACE, {
        testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: ['a.test.ts'], filesInRun: 3 },
      }),
    ).toBe('proposed');
  });

  it('names its own reason rather than borrowing another gate’s remedy', () => {
    // The enum is per-reason precisely because a caller told the wrong remedy re-submits
    // the fields it already sent. "Your last run was red" and "you named no test" have
    // nothing in common as repairs.
    expect(
      insufficientEvidenceReason(GREEN_ON_ITS_FACE, {
        testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: ['a.test.ts'], filesInRun: 1 },
      }),
    ).toBe('test-result-contradicted-by-run');
  });

  it('an EMPTY failing list is not a finding — a green run must stay silent', () => {
    expect(
      authorityForCompletion(GREEN_ON_ITS_FACE, {
        testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: [], filesInRun: 3 },
      }),
    ).toBe('committed');
  });

  it('reports the RED RUN before a fabricated path when both fire', () => {
    // Ordering is load-bearing, not cosmetic: a red run means the WORK is unfinished, a bad
    // path means the RECORD is wrong about finished work. Told the path first, the agent
    // repairs the smaller problem and re-closes on a suite that is still failing.
    expect(
      insufficientEvidenceReason(GREEN_ON_ITS_FACE, {
        filesChangedNeverExisted: ['imaginary/file.ts'],
        testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: ['a.test.ts'], filesInRun: 1 },
      }),
    ).toBe('test-result-contradicted-by-run');
  });

  it('still reports a MISSING field ahead of either present-and-wrong check', () => {
    // Supplying an absent field is the cheaper, more basic repair, so the four
    // missing-field reasons keep precedence over both findings.
    expect(
      insufficientEvidenceReason(
        { testsRun: 'testing:run', testResult: 'passed' },
        { testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: ['a.test.ts'], filesInRun: 1 } },
      ),
    ).toBe('no-verified-how');
  });
});

describe('an unfaithful requirement disposition refuses `committed` (P-021 / D-014)', () => {
  const GREEN = { verifiedHow: 'unit', testsRun: 'testing:run', testResult: 'passed' } as const;
  const shortfall = (kind: 'absent' | 'unfaithful', over: Record<string, string[]> = {}) => ({
    requirementDispositionShortfall: {
      kind,
      notQuotedFromSource: [],
      implementedWithoutResolvingCitation: [],
      deferredWithoutFollowUp: [],
      ...over,
    },
  });

  it('leaves today’s grade untouched when nothing was judged', () => {
    // The same fail-open property the other two findings assert from this side: the whole
    // check is opt-in on the caller running the probe, so an absent finding cannot move
    // the grade. This is what keeps a probe that could not run from reading as a verdict.
    expect(authorityForCompletion(GREEN, {})).toBe('committed');
    expect(authorityForCompletion(GREEN, undefined)).toBe('committed');
  });

  it('downgrades a close that declares deferred work without saying what was deferred', () => {
    expect(authorityForCompletion(GREEN, shortfall('absent'))).toBe('proposed');
    expect(insufficientEvidenceReason(GREEN, shortfall('absent'))).toBe('no-requirement-disposition');
  });

  it('downgrades a disposition whose quote is not a span of the ask', () => {
    expect(
      insufficientEvidenceReason(GREEN, shortfall('unfaithful', { notQuotedFromSource: ['a paraphrase'] })),
    ).toBe('requirement-disposition-unfaithful');
  });

  it('reports the RED RUN ahead of an unfaithful disposition when both fire', () => {
    // Ordering is load-bearing: a red run means the WORK is unfinished, while a bad
    // disposition means the RECORD is wrong about finished work. Told the record first,
    // the agent repairs the smaller problem and re-closes on a suite that still fails.
    expect(
      insufficientEvidenceReason(GREEN, {
        ...shortfall('unfaithful', { notQuotedFromSource: ['x'] }),
        testRunContradictedByLedger: { runGroupId: 'g1', failingFiles: ['a.test.ts'], filesInRun: 1 },
      }),
    ).toBe('test-result-contradicted-by-run');
  });

  it('reports an unfaithful disposition ahead of a fabricated path when both fire', () => {
    // Being wrong about the ASK is more serious than being wrong about the file list, so
    // the agent hears about the ask first.
    expect(
      insufficientEvidenceReason(GREEN, {
        ...shortfall('unfaithful', { deferredWithoutFollowUp: ['x'] }),
        filesChangedNeverExisted: ['imaginary/file.ts'],
      }),
    ).toBe('requirement-disposition-unfaithful');
  });

  it('still reports a MISSING field ahead of the disposition checks', () => {
    // Supplying an omitted field is the cheaper repair than re-reading the originating
    // body and enumerating it, so the missing-field family keeps precedence.
    expect(
      insufficientEvidenceReason({ testsRun: 'testing:run', testResult: 'passed' }, shortfall('absent')),
    ).toBe('no-verified-how');
  });

  it('reports the absent disposition AFTER the other missing-field reasons but BEFORE the findings', () => {
    // Its remedy — re-read the ask and enumerate it — is the most expensive of the
    // missing-field family, and cheaper than nothing for the present-and-wrong ones.
    expect(
      insufficientEvidenceReason(GREEN, {
        ...shortfall('absent'),
        filesChangedNeverExisted: ['imaginary/file.ts'],
      }),
    ).toBe('no-requirement-disposition');
  });
});

describe('`addedTests: true` makes a path necessary (EI-18685043434033870)', () => {
  // The owner's complaint was a close that was "entirely true, but unverifiable until I
  // asked for a path". A path is not required unconditionally — see the calibration note
  // on isSufficientEvidence — but "I added tests" plus "no file" is refutable on the face
  // of the record, so THAT pair is refused.

  it('refuses a close claiming added tests while naming no file', () => {
    expect(
      isSufficientEvidence({ verifiedHow: 'unit', testResult: '9/9 green', addedTests: true }),
    ).toBe(false);
    expect(
      authorityForCompletion({ verifiedHow: 'unit', testResult: '9/9 green', addedTests: true }),
    ).toBe('proposed');
  });

  it('accepts the same close once it names one', () => {
    expect(
      isSufficientEvidence({
        verifiedHow: 'unit',
        testResult: '9/9 green',
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/x.test.ts'],
      }),
    ).toBe(true);
  });

  it('treats an empty or whitespace-only path list as naming no file', () => {
    // The refusal must key off a USABLE path, not the presence of an array — otherwise
    // `filesChanged: []` satisfies it while carrying exactly as much information as
    // omitting the field.
    for (const filesChanged of [[], ['   '], ['', '  ']]) {
      expect(
        isSufficientEvidence({ verifiedHow: 'unit', testResult: '9/9 green', addedTests: true, filesChanged }),
      ).toBe(false);
    }
  });

  // CALIBRATION — these must stay TRUE, or the rule above is passing by over-refusing
  // rather than by discriminating. Measured 2026-08-13 over 24h of papercusp closes:
  // 1,437 of 2,236 `committed` closes carried no path, and 555 of those were
  // `already-passing` — legitimately pathless. A rule that fails these would reclassify
  // honest closes and drive fabricated paths (EI-20093150500083378: 8 of 12 declared
  // paths did not exist).
  it('leaves pathless closes alone when they do NOT claim to have added tests', () => {
    expect(isSufficientEvidence({ verifiedHow: 'already-passing', testResult: '30/30 passed' })).toBe(true);
    expect(isSufficientEvidence({ verifiedHow: 'integration', testsRun: 'npm run test:all' })).toBe(true);
    // addedTests explicitly false, and addedTests absent, are both untouched by the rule.
    expect(
      isSufficientEvidence({ verifiedHow: 'unit', testResult: '9/9 green', addedTests: false }),
    ).toBe(true);
  });

  it('names WHY it refused, so the caller can be given the right remedy', () => {
    // The reason exists because the remedy differs. Telling an added-tests-without-path
    // close to "supply verifiedHow plus testsRun" sends it to re-send what it already
    // sent — a refusal loop its own instructions cannot clear.
    expect(insufficientEvidenceReason(undefined)).toBe('no-evidence');
    expect(insufficientEvidenceReason({ testsRun: 'ran it' })).toBe('no-verified-how');
    expect(insufficientEvidenceReason({ verifiedHow: 'unit' })).toBe('no-test-run-or-result');
    expect(
      insufficientEvidenceReason({ verifiedHow: 'unit', testResult: '9/9 green', addedTests: true }),
    ).toBe('added-tests-without-path');
    expect(
      insufficientEvidenceReason({ verifiedHow: 'unit', testResult: '9/9 green' }),
    ).toBeUndefined();
  });

  it('reports the reason and the verdict from ONE computation, so they cannot disagree', () => {
    // A "why" function that re-derived the conditions could drift from the gate it
    // explains. This asserts the equivalence directly over a spread of shapes.
    const shapes: Parameters<typeof isSufficientEvidence>[0][] = [
      undefined,
      null,
      {},
      { verifiedHow: 'unit' },
      { testsRun: 'ran it' },
      { verifiedHow: 'unit', testsRun: '   ' },
      { verifiedHow: 'unit', testResult: '9/9 green' },
      { verifiedHow: 'unit', testResult: '9/9 green', addedTests: true },
      { verifiedHow: 'unit', testResult: '9/9 green', addedTests: true, filesChanged: [] },
      { verifiedHow: 'unit', testResult: '9/9 green', addedTests: true, filesChanged: ['a.test.ts'] },
      { verifiedHow: 'already-passing', testResult: '30/30 passed' },
    ];
    for (const s of shapes) {
      expect(isSufficientEvidence(s)).toBe(insufficientEvidenceReason(s) === undefined);
    }
  });

  // CONTROL — a deliberately-wrong implementation kept permanently in the test file, so
  // the falsifiability of the rule is proven WITHOUT ever mutating the shared tree (a
  // copy-out/in-tree mutation probe is racy here: git-sync sweeps the whole tree on a
  // schedule and can commit the mutant).
  it('a predicate ignoring addedTests would pass the accept cases and MISS the refusal', () => {
    const withoutTheRule = (e: {
      verifiedHow?: string;
      testsRun?: string;
      testResult?: string;
      addedTests?: boolean;
      filesChanged?: string[];
    }): boolean => Boolean(e.verifiedHow && (e.testsRun?.trim() || e.testResult?.trim()));

    const selfContradictory = { verifiedHow: 'unit', testResult: '9/9 green', addedTests: true };
    expect(withoutTheRule(selfContradictory)).toBe(true); // the bug this rule removes
    expect(isSufficientEvidence(selfContradictory)).toBe(false); // the real subject refuses it
  });
});

describe('schema/type drift guard', () => {
  it('keeps the TS union and the migration CHECK constraint in agreement', () => {
    // The whole point of D-004 is that a rule kept in one place and restated in another
    // drifts. This module and the CHECK constraint are two statements of one value set,
    // so assert they agree rather than trusting that a future edit updates both.
    const sql = readFileSync(MIGRATION_VALUES, 'utf8');
    const check = /CHECK \(authority IS NULL OR authority IN\s*\(([^)]*)\)/m.exec(sql);
    expect(check, 'migration 677 no longer declares the CHECK constraint').toBeTruthy();
    const inSql = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(inSql.sort()).toEqual([...WORK_ITEM_COMPLETION_AUTHORITIES].sort());
  });

  it('does not reintroduce the abandoned rename — the column is rename-proof (D-009)', () => {
    // 678 originally tried to rename this column to `completion_authority` and had to be
    // abandoned: harness_features_consolidated has ~2,485 dependent views, and renaming a
    // column a view exposes requires DROP + CREATE of that view (CREATE OR REPLACE can
    // only APPEND). The abandoned file is kept as comment-only documentation.
    //
    // This guards the specific way that lesson gets lost: someone reads D-009, agrees the
    // homograph is bad, and re-adds the DROP. A DROP VIEW on either consolidated view is
    // the thing that crash-loops the operator on boot, so fail here instead.
    const sql = readFileSync(MIGRATION_RENAME, 'utf8');
    expect(sql).not.toMatch(/RENAME COLUMN authority TO completion_authority/);
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
      /DROP\s+VIEW[\s\S]*?(harness_features_consolidated|engineer_issues)/i,
    );
  });
});
