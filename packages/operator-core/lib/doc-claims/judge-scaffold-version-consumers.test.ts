/**
 * Plan decision D-013 (llm-agent-evaluation-measurement-integrity-2026-08-25) says:
 * a library that composes an LLM prompt on a caller's behalf exports a derived
 * identity of its own static text, and every consumer that PERSISTS or COMPARES
 * judged output folds that identity into its own version/cache key.
 *
 * WHY this needs a guard rather than prose. The defect class D-013 closes was, five
 * times over, a rule that lived in a comment and was checked by nobody — literally:
 *
 *     /** Frozen judge model — bump RUBRIC_VERSION when changing it. *\/
 *
 * Leaving D-013 as a plan decision would reproduce that exact failure one level up,
 * at governance instead of at code. A sixth consumer would import `judgeRun`, key
 * persisted grades on a version blind to most of the prompt that produced them, and
 * every test would still pass while the bench reported a clean trend line.
 *
 * THE MECHANISM IS THE POPULATION PIN, not the per-file assertion. Finding offenders
 * by searching for them can only ever find the ones you thought to look for — which
 * is how three of this class's instances survived review by well-intentioned readers.
 * So this enumerates every `judgeRun` importer and requires the set to equal a pinned
 * classification. A NEW consumer fails here and forces an explicit decision about it.
 * That is D-012's method (make membership decidable, then check it) applied to the
 * consumers instead of to the prompt's inputs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Where a consumer could live. Everything else in the tree cannot import the lib. */
const SCAN_ROOTS = ['packages', 'libs', 'apps'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next']);

/** The module specifiers that can hand out `judgeRun`. */
const JUDGE_MODULES = ["@papercusp/testing-shell/llm", "./judge"];

/** The identity every persisting/comparing consumer must fold in. */
const SCAFFOLD_EXPORT = 'JUDGE_PROMPT_SCAFFOLD_VERSION';

type Disposition =
  /** Verified to fold the scaffold identity into the key it persists/compares under. */
  | { readonly kind: 'folds'; readonly why: string }
  /**
   * Owes the fold per D-013, tracked by a filed item. Not silently tolerated: the
   * classification names the item, and the test flips to a failure the moment the
   * file starts importing the identity, so a fix cannot leave a stale label behind.
   */
  | { readonly kind: 'owed'; readonly why: string; readonly trackedBy: string }
  /** testing-shell's own re-export or call site — it OWNS the text; folding its own identity in would be circular. */
  | { readonly kind: 'library'; readonly why: string };

/**
 * The pinned population, measured (not remembered) at WI-41677 by scanning for named
 * `judgeRun` imports across every scan root above.
 */
const PINNED: Readonly<Record<string, Disposition>> = Object.freeze({
  'libs/testing-shell/src/llm/index.ts': {
    kind: 'library',
    why: "the llm barrel's re-export, not a call site",
  },
  'libs/testing-shell/src/llm/runner.ts': {
    kind: 'library',
    why: 'the library composing its own prompt; its scaffolding IS the thing being identified',
  },
  'packages/operator-core/lib/search/bench/judge-agreement.ts': {
    kind: 'folds',
    why: 'persists paid grades to search_judge_grades keyed on rubric_version (WI-41675)',
  },
  'packages/operator-core/lib/memory/bench/judged.ts': {
    kind: 'folds',
    why:
      'JUDGED_TIER_RUBRIC_VERSION is now derived by deriveJudgedTierRubricVersion over ' +
      'the rubric content, its own instruction contract and JUDGE_PROMPT_SCAFFOLD_VERSION ' +
      '(via the shared deriveRubricVersion helper), so the version that labels reports and ' +
      'feeds each run identity hash moves when any prompt layer moves. Reclassified from ' +
      '`owed` (EI-21448289024080765) when this guard went red on the repair — which is the ' +
      'bidirectional check doing its job, not a regression.',
  },
  'packages/operator-core/lib/llm-testing/replay.ts': {
    kind: 'folds',
    why:
      'passes JUDGE_PROMPT_SCAFFOLD_VERSION to computeIdentityHash, which since ' +
      'WI-41685 REQUIRES it. This file stores nothing itself, but the identity it ' +
      'computes is what declares two runs comparable, so a scaffold-blind identity ' +
      'here would make a replay claim comparability it cannot support. Closed the ' +
      'last `owed` row of EI-21448289024080765.',
  },
  'packages/operator-core/lib/memory/bench/answer-usefulness.ts': {
    kind: 'folds',
    why:
      'ANSWER_RUBRIC_VERSION is deriveRubricVersion(..., scaffold: JUDGE_PROMPT_SCAFFOLD_VERSION); ' +
      'it keys each judged answer\'s identity hash and labels the persisted report, so a scaffold ' +
      'edit moves the version. Classified when this guard went red on the new importer ' +
      '(EI-25355584370404958).',
  },
});

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
}

/**
 * Named bindings pulled from a judge module by `import { … } from` or
 * `export { … } from`. Both forms matter: the barrel re-exports rather than imports,
 * and a barrel is exactly where a new consumer would first appear.
 */
function judgeModuleBindings(source: string): string[] {
  const bindings: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!JUDGE_MODULES.includes(m[2]!)) continue;
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) bindings.push(name);
    }
  }
  return bindings;
}

const toRepoPath = (absolute: string): string =>
  relative(REPO_ROOT, absolute).split(sep).join('/');

/**
 * THIS FILE MUST EXCLUDE ITSELF, and it is not a formality — the first run failed on
 * it. The falsifiability fixtures below are literal `import { judgeRun } …` strings,
 * so a source-text detector reads its own controls as a real consumer. It is the same
 * self-match this repo documents for `pgrep -f`, where the pattern appears in the
 * searching process's own argv, and the same fix `scripts/proc-guard.mjs` uses:
 * exclude the caller before matching. Derived from `__filename` rather than written
 * out, so renaming the file cannot silently re-admit it.
 */
const SELF = toRepoPath(__filename);

/** Every file that imports `judgeRun` by name, repo-relative and POSIX-separated. */
function findJudgeRunImporters(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(resolve(REPO_ROOT, root), files);

  const found: string[] = [];
  for (const file of files) {
    const repoPath = toRepoPath(file);
    if (repoPath === SELF) continue;
    const source = readFileSync(file, 'utf8');
    // Cheap reject before the regex: most of the tree never mentions it.
    if (!source.includes('judgeRun')) continue;
    if (judgeModuleBindings(source).includes('judgeRun')) found.push(repoPath);
  }
  return found.sort();
}

describe('D-013: judgeRun consumers fold in the prompt-scaffold identity', () => {
  const importers = findJudgeRunImporters();

  it('the consumer population matches the pinned classification', () => {
    // The load-bearing assertion. An unpinned importer is not necessarily a defect —
    // it is an unmade DECISION, and the failure message is what forces it to be made.
    expect(importers).toEqual(Object.keys(PINNED).sort());
  });

  it('every consumer classified `folds` actually imports the identity', () => {
    const offenders: string[] = [];
    for (const [file, disposition] of Object.entries(PINNED)) {
      if (disposition.kind !== 'folds') continue;
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (!judgeModuleBindings(source).includes(SCAFFOLD_EXPORT)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('a consumer classified `owed` that has been fixed must be reclassified', () => {
    // Keeps the pin honest in the other direction: without this, a file could be
    // repaired and keep its `owed` label forever, and the label is what a future
    // reader trusts.
    const repaired: string[] = [];
    for (const [file, disposition] of Object.entries(PINNED)) {
      if (disposition.kind !== 'owed') continue;
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (judgeModuleBindings(source).includes(SCAFFOLD_EXPORT)) repaired.push(file);
    }
    expect(repaired).toEqual([]);
  });

  it('every `owed` consumer names the item tracking it', () => {
    for (const [file, disposition] of Object.entries(PINNED)) {
      if (disposition.kind !== 'owed') continue;
      expect(disposition.trackedBy, `${file} owes the fold but names no tracking item`).toMatch(
        /^(EI|WI)-\d+$/,
      );
    }
  });

  /**
   * The detector's own falsifiability control, permanently resident: a deliberately
   * wrong source that MUST be seen as a consumer, and one that must NOT. Without
   * these, a regex that silently matched nothing would make every assertion above
   * pass while gating nothing at all — the failure mode this whole plan is about.
   */
  it.each([
    ["import { judgeRun } from '@papercusp/testing-shell/llm';", true],
    ["import { judgeRun, type JudgeRubric } from '@papercusp/testing-shell/llm';", true],
    ["export { judgeRun, buildInconclusiveJudge } from './judge';", true],
    ["import {\n  judgeRun,\n  type LlmCallFn,\n} from '@papercusp/testing-shell/llm';", true],
    // A comment mentioning it is not a consumer — judge-agreement.test.ts is exactly this.
    ['// `judgeRun` parses it on the happy path', false],
    // Neither is a different export from the same module.
    ["import { runScenario } from '@papercusp/testing-shell/llm';", false],
    // Nor the same name from an unrelated module.
    ["import { judgeRun } from './some-other-local-module';", false],
  ])('the importer detector classifies %j as consumer=%s', (source, expected) => {
    expect(judgeModuleBindings(source as string).includes('judgeRun')).toBe(expected);
  });

  it('excludes itself, and would otherwise self-match on its own fixtures', () => {
    // Proves the exclusion is load-bearing rather than dead defensive code: this
    // file's own source really does read as a consumer.
    const ownSource = readFileSync(__filename, 'utf8');
    expect(judgeModuleBindings(ownSource)).toContain('judgeRun');
    expect(importers).not.toContain(SELF);
  });

  it('the scan actually reached the tree (a silent zero would pass everything)', () => {
    // The instrument check. An empty population would satisfy `toEqual` against an
    // empty pin, and a broken walk is indistinguishable from a clean codebase.
    expect(importers.length).toBeGreaterThanOrEqual(5);
    expect(importers).toContain('packages/operator-core/lib/search/bench/judge-agreement.ts');
  });
});
