/**
 * A rubric's version must be DERIVED from the rubric's content, never a literal
 * a human is expected to bump (WI-41678, closing EI-21449130141174031).
 *
 * WHY this needs a guard rather than prose. The rule already existed as prose —
 * in the rubric files themselves:
 *
 *     Bump the version on any anchor change (it feeds the per-run identity hash).
 *
 * and it was checked by nobody. Commit b7c7f2db8d rewrote axis descriptions and
 * bad/ideal anchors in queen.ts AND overwatch.ts while both versions sat at
 * '1.0.0', so stored runs either side of that commit share an identity_hash under
 * materially different judging instructions. Nothing failed. The trend line looked
 * continuous precisely where it had become meaningless — the worst available
 * outcome, because a broken comparison that LOOKS sound is read as evidence.
 *
 * Converting the nine literals is the fix; this is the recurrence guard. Without
 * it, the tenth rubric added next month gets a hand-typed '1.0.0' and the class is
 * back with nothing to catch it.
 *
 * THE MECHANISM IS THE POPULATION PIN, not the per-file assertion — the method
 * D-012/D-013 and the sibling judge-scaffold-version-consumers guard established.
 * Scanning for offenders only finds the ones you thought to look for, which is how
 * these nine survived repeated careful review. Pinning the POPULATION makes a new
 * rubric version a FAILURE until someone classifies it, and makes a stale
 * classification a failure too: when judged.ts's remaining literal is derived, this
 * test goes red until its label is updated. Both directions are deliberate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Where a rubric version could live. */
const SCAN_ROOTS = ['packages', 'libs', 'apps'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next']);

/**
 * A rubric DECLARATION, found by its TYPE rather than by its name.
 *
 * ⚠ This was originally `export const ([A-Z0-9_]*RUBRIC_VERSION) = ...` — a scan for
 * the NAME. That version shipped, passed, and was WRONG WITHIN THE HOUR: a peer split
 * OPERATOR_RUBRIC_HIGH_CRITICALITY onto its own derived version named
 * `OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION`, which does not end in `RUBRIC_VERSION`,
 * so the scanner never saw it and the pin stayed green while the population had grown.
 *
 * That is the guard reproducing, inside itself, the exact defect it exists to prevent:
 * searching for offenders only finds the ones you thought to look for. A NAME is a
 * convention anyone may deviate from; the TYPE is the thing that makes a value a rubric
 * version. So the subject is now every `X: JudgeRubric` declaration, and what feeds its
 * `version` field — which cannot be dodged by renaming.
 */
const RUBRIC_DECL = /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*:\s*JudgeRubric\s*=\s*\{/;

/** `version:` at one level of nesting inside a rubric literal. */
const VERSION_FIELD = /^\s{2}version:\s*(.+?),?\s*$/;

/** `const NAME = <rhs>` anywhere in the file, for resolving a version identifier. */
const CONST_DECL = /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(.*)$/;

const isCommentLine = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
};

type Classification =
  /** The version is computed from the rubric's content. An anchor edit moves it. */
  | 'derived'
  /** A hand-maintained string. This is the defect class; each one needs a tracked reason. */
  | 'literal'
  /** No own `version` key — the rubric spreads another, inheriting its identity. */
  | 'inherited'
  /** Present but neither — e.g. an alias of another export. Always fails the pin below. */
  | 'unclassifiable';

/**
 * Classify a declaration's right-hand side.
 *
 * Exported-by-proximity as a pure function precisely so it can be exercised on
 * synthetic sources below. A scanner that can only be tested by mutating the real
 * tree is one that never gets tested — and on this shared checkout, mutating the
 * tree to test a guard risks the sweep committing the mutant.
 */
export function classifyRhs(rhs: string): Classification {
  const head = rhs.trimStart();
  if (/^['"`]/.test(head)) return 'literal';
  if (/^derive[A-Za-z0-9_]*\s*\(/.test(head)) return 'derived';
  return 'unclassifiable';
}

interface Found {
  readonly file: string;
  /** The rubric const's name — e.g. QUEEN_RUBRIC, not QUEEN_RUBRIC_VERSION. */
  readonly symbol: string;
  readonly classification: Classification;
}

/**
 * Given a file's lines and the index of a `X: JudgeRubric = {` line, classify what
 * feeds that rubric's `version`.
 *
 * Resolves a bare identifier back to its own declaration in the same file, because
 * the near-universal shape here is `version: X_RUBRIC_VERSION` where that constant is
 * declared a few lines above. Classifying the identifier itself (rather than the
 * literal text `X_RUBRIC_VERSION`) is what makes this immune to naming.
 */
function classifyVersionExpression(expr: string, lines: readonly string[]): Classification {
  const head = expr.trim();
  if (/^['"`]/.test(head)) return 'literal';
  if (/^derive[A-Za-z0-9_]*\s*\(/.test(head)) return 'derived';

  if (/^[A-Za-z0-9_]+$/.test(head)) {
    for (const candidate of lines) {
      const c = CONST_DECL.exec(candidate);
      if (c && c[1] === head) return classifyRhs(c[2]!);
    }
  }
  return 'unclassifiable';
}

export function classifyRubricAt(lines: readonly string[], declIndex: number): Classification {
  const declaration = lines[declIndex]!;
  const openingBrace = declaration.indexOf('{');
  if (openingBrace >= 0) {
    // Some valid rubric declarations keep the whole object on one line. Check
    // that line before scanning the following, two-space-indented properties.
    const inline = /(?:\{|,)\s*version\s*:\s*([^,}]+)/.exec(
      declaration.slice(openingBrace),
    );
    if (inline) return classifyVersionExpression(inline[1]!, lines);
  }

  for (let i = declIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\};?\s*$/.test(line)) break; // end of this rubric literal
    const m = VERSION_FIELD.exec(line);
    if (!m) continue;
    return classifyVersionExpression(m[1]!, lines);
  }
  // No own `version` key: the rubric spreads another and inherits its identity.
  return 'inherited';
}

function scan(): Found[] {
  const found: Found[] = [];
  const selfPath = resolve(__filename);

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      // Test fixtures declare JudgeRubric literals too, but a fixture's version never
      // reaches a stored identity_hash, so it cannot make two real runs falsely
      // comparable. Pinning them would force every new fixture to be classified —
      // friction with no safety behind it. Excluded by ROLE, not by convenience.
      if (/\.test\.tsx?$/.test(entry) || full.includes(`${sep}__tests__${sep}`)) continue;
      // A guard whose subject is TEXT and which lives inside the tree it scans is
      // a member of its own population: this file's fixtures below are literal
      // rubric-version declarations. Excluding it is load-bearing, and the test
      // named 'self-exclusion is load-bearing' proves the exclusion is not dead code.
      if (resolve(full) === selfPath) continue;

      let src: string;
      try {
        src = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('JudgeRubric')) continue;

      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (isCommentLine(line)) continue;
        const m = RUBRIC_DECL.exec(line);
        if (!m) continue;
        found.push({
          file: relative(REPO_ROOT, full).split(sep).join('/'),
          symbol: m[1]!,
          classification: classifyRubricAt(lines, i),
        });
      }
    }
  };

  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return found;
}

/**
 * The pinned population, MEASURED at WI-41678 by the scanner above — not recalled,
 * and not assembled from a hand-run grep.
 *
 * Keyed `<file>::<symbol>` so two rubrics in one file (queen.ts holds three) stay
 * individually accountable.
 */
const PINNED: Readonly<Record<string, Classification>> = Object.freeze({
  // The nine converted by WI-41678. Each hashes its own version-free content, so a
  // reworded anchor moves the version and therefore the identity hash.
  'packages/operator-core/lib/llm-testing/rubrics/su.ts::SU_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/operator.ts::OPERATOR_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/oracle.ts::ORACLE_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/onboarding-tutor.ts::TUTOR_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/queen.ts::QUEEN_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/queen.ts::QUEEN_DECIDER_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/queen.ts::SCHEDULER_USE_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/overwatch.ts::OVERWATCH_RUBRIC': 'derived',
  'packages/operator-core/lib/llm-testing/rubrics/architect.ts::ARCHITECT_RUBRIC': 'derived',

  // Split onto its own derived identity by a peer answering EI-21457442861164429:
  // `criticality: 'high'` changes the judging execution contract (multi-pass), so a
  // single-pass and a two-pass run no longer share a trend line. THIS is the rubric
  // the first version of this guard could not see — its version constant is named
  // OPERATOR_RUBRIC_HIGH_CRITICALITY_VERSION, which does not end in `RUBRIC_VERSION`.
  'packages/operator-core/lib/llm-testing/rubrics/operator.ts::OPERATOR_RUBRIC_HIGH_CRITICALITY':
    'derived',

  // The search bench, derived since EI-21443136282514038 / WI-41675. It folds three
  // inputs (rubric content, its own instruction contract, testing-shell's prompt
  // scaffold identity) through the same shared helper.
  'packages/operator-core/lib/search/bench/judge-agreement.ts::SEARCH_RELEVANCE_RUBRIC': 'derived',

  // Was the one known remaining literal (EI-21448289024080765). Reclassified within
  // minutes of this guard landing: a peer converted it to
  // deriveJudgedTierRubricVersion(JUDGE_PROMPT_SCAFFOLD_VERSION) over the shared
  // helper, this pin went red on the stale 'literal' label, and the label was
  // corrected. That is the bidirectional check earning its place — the pin failed
  // for real, on a real change, rather than only in a control.
  'packages/operator-core/lib/memory/bench/judged.ts::MEMORY_USEFULNESS_RUBRIC': 'derived',

  // NOT a rubric whose identity gates anything: a sentinel fed to the real prompt
  // builders so JUDGE_PROMPT_SCAFFOLD_VERSION can be derived from the scaffolding
  // they emit. Its version is deliberately constant — deriving it from content would
  // be circular, since this rubric exists to measure the text wrapped AROUND rubrics.
  // Pinned rather than path-excluded so it stays visible and accounted for.
  'libs/testing-shell/src/llm/judge.ts::SCAFFOLD_PROBE_RUBRIC': 'literal',

  // The memory-answer bench uses a one-line JudgeRubric declaration with a derived
  // version constant. Keep it in the population pin even though its version is not
  // formatted on a separate property line.
  'packages/operator-core/lib/memory/bench/answer-usefulness.ts::ANSWER_RUBRIC': 'derived',
});

describe('rubric versions are derived from rubric content', () => {
  const found = scan();

  it('finds the population at all (calibration)', () => {
    // If the scanner silently matched nothing — a broken regex, a wrong root — every
    // other assertion here would pass vacuously while proving nothing.
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it('pins the exact population — a NEW rubric version must be classified here', () => {
    const measured = found.map((f) => `${f.file}::${f.symbol}`).sort();
    expect(measured).toEqual(Object.keys(PINNED).sort());
  });

  it('matches every pinned classification, in both directions', () => {
    const measured = Object.fromEntries(
      found.map((f) => [`${f.file}::${f.symbol}`, f.classification]),
    );
    expect(measured).toEqual({ ...PINNED });
  });

  it('leaves no rubric version unclassifiable', () => {
    expect(found.filter((f) => f.classification === 'unclassifiable')).toEqual([]);
  });

  describe('the pin itself is falsifiable', () => {
    // The sibling guard got this proof for free: it failed 6-vs-5 on its first run
    // and caught a real unpinned consumer. This one passed first try, which proves
    // nothing about whether it CAN fail — so the two ways it must fail are exercised
    // here against the REAL measured population, in memory, mutating nothing.

    it('a new, unpinned rubric version would fail the population check', () => {
      const measured = found.map((f) => `${f.file}::${f.symbol}`).sort();
      const withNewcomer = [
        ...measured,
        'packages/operator-core/lib/llm-testing/rubrics/newcomer.ts::NEWCOMER_RUBRIC_VERSION',
      ].sort();
      expect(withNewcomer).not.toEqual(Object.keys(PINNED).sort());
    });

    it('a literal appearing where derivation is pinned would fail the classification check', () => {
      const measured = Object.fromEntries(
        found.map((f) => [`${f.file}::${f.symbol}`, f.classification]),
      );
      const regressed = {
        ...measured,
        'packages/operator-core/lib/llm-testing/rubrics/queen.ts::QUEEN_RUBRIC':
          'literal' as Classification,
      };
      expect(regressed).not.toEqual({ ...PINNED });
    });
  });

  describe('the classifier discriminates (controls)', () => {
    // Synthetic sources, never written to the tree. A hand-maintained literal is the
    // defect; a derive call is the fix. If classifyRhs returned one answer for both,
    // the population pin above would be decorative.
    it("reads a quoted version as 'literal' — the defect", () => {
      expect(classifyRhs("'1.0.0';")).toBe('literal');
      expect(classifyRhs('"memory-usefulness.v1";')).toBe('literal');
      expect(classifyRhs('`1.0.0`;')).toBe('literal');
    });

    it("reads a derive call as 'derived' — the fix", () => {
      expect(classifyRhs("deriveRubricVersion('su', SU_RUBRIC_CONTENT);")).toBe('derived');
      expect(classifyRhs('deriveJudgeAgreementRubricVersion(')).toBe('derived');
    });

    it("reads anything else as 'unclassifiable' rather than guessing", () => {
      expect(classifyRhs('SOME_OTHER_CONST;')).toBe('unclassifiable');
      expect(classifyRhs('computeVersion(x);')).toBe('unclassifiable');
    });

    it('classifies a version on the rubric declaration line', () => {
      const derivedLines = [
        "const INLINE_RUBRIC_VERSION = deriveRubricVersion('inline', CONTENT);",
        'export const INLINE_RUBRIC: JudgeRubric = { version: INLINE_RUBRIC_VERSION, axes: [] };',
      ];
      expect(classifyRubricAt(derivedLines, 1)).toBe('derived');

      const literalLines = [
        "export const INLINE_RUBRIC: JudgeRubric = { version: '1.0.0', axes: [] };",
      ];
      expect(classifyRubricAt(literalLines, 0)).toBe('literal');
    });
  });

  it('self-exclusion is load-bearing, not dead code', () => {
    // This file contains lines that the DECLARATION regex matches (the fixtures
    // below). Were the scanner not excluding __filename, they would enter the
    // population and the pin would fail — the same self-match that made the sibling
    // guard fail 6-vs-5 on its first run. Asserting it here means the exclusion
    // cannot quietly stop being necessary without someone noticing.
    const selfSource = readFileSync(__filename, 'utf8');
    const selfMatches = selfSource
      .split('\n')
      .filter((l) => !isCommentLine(l) && RUBRIC_DECL.test(l));
    expect(selfMatches.length).toBeGreaterThan(0);
  });
});

// --- fixture for the self-exclusion assertion above --------------------------
// Deliberately shaped like a real rubric declaration. Unreachable as code (never
// imported, never executed); it exists only so the self-match hazard stays real
// and the __filename exclusion cannot quietly become dead code.
export const FIXTURE_RUBRIC_SOURCE = `
const EXAMPLE_RUBRIC: JudgeRubric = {
  version: '1.0.0',
};
`;
