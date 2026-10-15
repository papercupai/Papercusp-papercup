/**
 * scripts/lib/tracked-files.mjs — the shared tree enumerator every check-*.mjs
 * guard uses (WI-6730).
 *
 * WHY THIS FILE EXISTS: the helper's whole purpose is to stop a guard reporting a
 * confident ✓ over a subtree it never opened. Every failure mode of the helper is
 * therefore SILENT by construction — it returns fewer files, every caller finds
 * nothing, and every caller prints success. There is no crash to notice. So the
 * properties below are pinned rather than left to inspection.
 *
 * Both bugs asserted here were real and were caught by measurement, not review:
 *   1. a bare `git ls-files` skipping all 39 submodules (the original defect), and
 *   2. this module's own ROOT resolving to `scripts/` instead of the repo root,
 *      which silently reduced the default enumeration to ~33 files.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Typed via scripts/lib/tracked-files.d.mts — the former `@ts-expect-error` here became
// UNUSED (TS2578) the moment those declarations landed, so it is deliberately gone. The
// prettier disable below stays: it governs this import's line WIDTH, independent of the
// removed directive.
// eslint-disable-next-line prettier/prettier
import { coverageOf, declaredSubmodules, describeUnscanned, listFilesIncludingUntracked, listTrackedFiles, presentOnDisk } from '../../../scripts/lib/tracked-files.mjs';
import { firstLiveMatch, isLiveCodeAt, stripCommentsAndStrings, stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

describe('tracked-files helper (WI-6730)', () => {
  const scan = listTrackedFiles() as {
    files: string[];
    declared: string[];
    scanned: string[];
    unscanned: string[];
  };

  it('enumerates the REPO ROOT by default, not the scripts/ directory it lives in', () => {
    // The regression: this module sits at scripts/lib/, one level deeper than the
    // scripts/check-*.mjs guards that use `new URL('..', import.meta.url)`. Copying
    // that idiom verbatim resolved ROOT to scripts/ and returned ~33 files — enough
    // for a caller to run, find nothing, and report clean.
    expect(scan.files.length).toBeGreaterThan(5_000);
    // Files that exist only OUTSIDE scripts/ — a scripts/-rooted scan finds neither.
    expect(scan.files).toContain('package.json');
    expect(scan.files.some((f) => f.startsWith('packages/operator-core/'))).toBe(true);
  });

  it('recurses into submodules WHERE GIT CAN — and the scanned/unscanned split says which', () => {
    // ⚠ Do NOT assert "libs/generic/sync/src files are present" unconditionally.
    // `git ls-files --recurse-submodules` DOES NOT WORK IN A LINKED WORKTREE whose
    // submodules are not registered: it silently returns FEWER paths than a plain
    // `git ls-files` (measured in the green-checkpoint worktree: 20,060 vs 20,098,
    // and zero under libs/generic/sync/src) even though the files are on disk. An
    // unconditional assertion here therefore passes in the shared tree and reds the
    // fleet gate — which is exactly what it did on candidate 3a18e44b.
    //
    // The real contract is a BICONDITIONAL, and it is what makes the helper safe to
    // trust in either environment: a submodule's files appear iff that submodule is
    // reported as scanned. Both directions are checked, so this cannot pass by the
    // enumerator simply returning nothing.
    for (const path of scan.scanned) {
      expect(
        scan.files.some((f) => f.startsWith(`${path}/`)),
        `${path} is reported SCANNED but contributed no files — the split is lying`,
      ).toBe(true);
    }
    for (const path of scan.unscanned) {
      expect(
        scan.files.some((f) => f.startsWith(`${path}/`)),
        `${path} is reported UNSCANNED but contributed files — the split is lying`,
      ).toBe(false);
    }
  });

  it('accounts for every declared submodule — none may be silently dropped', () => {
    // Coverage is part of the return value, so a caller cannot mistake "not
    // scanned" for "clean". Which submodules are initialized varies by checkout
    // (see above), so this asserts the PARTITION rather than a specific outcome.
    expect(scan.declared.length).toBeGreaterThan(30);
    expect(new Set([...scan.scanned, ...scan.unscanned])).toEqual(new Set(scan.declared));
    // Disjoint: a submodule cannot be both.
    expect(scan.scanned.filter((p) => scan.unscanned.includes(p))).toEqual([]);
  });

  it('declaredSubmodules reads .gitmodules and is sorted + deduped', () => {
    const declared = declaredSubmodules() as string[];
    expect(declared).toEqual([...declared].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toContain('libs/generic/sync');
  });

  it('describeUnscanned is empty for full coverage and names the gaps otherwise', () => {
    // Non-vacuity: an always-empty formatter would satisfy the "full coverage"
    // half of this contract while making every gap invisible — the exact class of
    // silent pass this helper exists to prevent.
    expect(describeUnscanned([])).toBe('');
    const note = describeUnscanned(['libs/zero-harness']) as string;
    expect(note).toContain('libs/zero-harness');
    // The RATIO is the load-bearing part: "0/39" cannot be misread as clean, where
    // a bare ✓ over an empty scan reads exactly like a pass (WI-6776).
    expect(note).toMatch(/coverage \d+\/\d+ declared submodule\(s\) enumerated/);
    expect(note).toContain('says nothing about them');
  });

  it('describeUnscanned diagnoses the CAUSE by tree shape, not "not initialized" for everything', () => {
    // WI-6776. The first version reported every gap as "not initialized". Measured
    // 2026-08-02 in papercusp-release: 0/39 submodules enumerated while 38 are checked
    // out WITH CONTENT ON DISK — submodule source is `git archive`-extracted by
    // setup-release-checkout.sh, so there is no `.git` for --recurse-submodules to
    // descend into. "Not initialized" sends a reader to `git submodule update --init`
    // chasing a fault that does not exist, which is the wasted-diagnostic-time cost
    // EI-19301033966613245 was filed about.
    //
    // Both branches are driven with ordinary repo paths rather than real submodules, so
    // this is deterministic in any checkout: `scripts` always has content, and the
    // nonexistent path never does.
    const present = describeUnscanned(['scripts']) as string;
    expect(present).toContain('present on disk but NOT git-enumerable');
    expect(present).toContain('BY DESIGN');
    expect(present).not.toContain('not initialized');

    const absent = describeUnscanned(['libs/definitely-not-checked-out-here']) as string;
    expect(absent).toContain('not initialized');
    expect(absent).not.toContain('present on disk');
  });

  it('coverageOf partitions an already-computed file list, so a guard can keep its own enumerator', () => {
    // The seam that made WI-6776 fixable without forcing every guard onto one `git`
    // invocation: check-no-nul-in-source and check-no-control-bytes need `-z` output
    // (a guard about byte-level corruption must not assume filenames are newline-free)
    // and check-env-feature-gates uses `git grep`. What they share is the coverage
    // CONTRACT, not the command.
    const { declared, scanned, unscanned } = coverageOf(['libs/generic/sync/src/x.ts', 'package.json']) as {
      declared: string[];
      scanned: string[];
      unscanned: string[];
    };
    expect(scanned).toEqual(['libs/generic/sync']);
    expect(new Set([...scanned, ...unscanned])).toEqual(new Set(declared));
    // An empty list must report ZERO coverage, never full — the false-clean direction.
    const empty = coverageOf([]) as { scanned: string[]; unscanned: string[] };
    expect(empty.scanned).toEqual([]);
    expect(empty.unscanned.length).toBeGreaterThan(30);
  });

  it('listFilesIncludingUntracked keeps BOTH untracked coverage and submodule recursion', () => {
    // WI-6730. git refuses to combine the two properties the identity guards need:
    //     $ git ls-files --recurse-submodules --others
    //     fatal: ls-files --recurse-submodules unsupported mode
    // so a guard adopting plain `--recurse-submodules` would silently trade its
    // untracked coverage (load-bearing — a brand-NEW file is exactly where a fresh
    // identity leak sits) for submodule coverage. This seam buys both by running the
    // untracked-inclusive flags inside each submodule. Both halves are asserted
    // because losing either one is silent: the scan just gets smaller.
    const scan = listFilesIncludingUntracked() as {
      files: string[];
      declared: string[];
      scanned: string[];
      unscanned: string[];
    };

    // Half 1 — recursion actually happened, keyed off the coverage split rather than
    // a hard-coded submodule, so this holds in a release-shaped checkout too.
    for (const path of scan.scanned) {
      expect(
        scan.files.some((f) => f.startsWith(`${path}/`)),
        `${path} reported scanned but contributed no files`,
      ).toBe(true);
    }

    // Half 2 — it is a SUPERSET of the tracked-only enumeration. If someone
    // "simplifies" this back to --recurse-submodules, untracked files vanish and
    // this fails instead of quietly narrowing every identity guard.
    const trackedOnly = listTrackedFiles() as { files: string[] };
    expect(scan.files.length).toBeGreaterThanOrEqual(trackedOnly.files.length);

    // Paths are superproject-relative and correctly prefixed — a double-prefix or a
    // bare submodule-relative path would make every readFileSync miss, which reads
    // as "no violations found" rather than as an error.
    expect(scan.files.some((f) => f.includes('//'))).toBe(false);
    for (const path of scan.scanned) {
      expect(scan.files.some((f) => f.startsWith(`${path}/${path}/`))).toBe(false);
    }
  });

  it('falls back to a bounded filesystem walk for a non-git root', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracked-files-non-git-'));
    try {
      mkdirSync(join(root, 'src', 'nested'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'dependency'), { recursive: true });
      writeFileSync(join(root, 'src', 'importer.ts'), 'export const importer = true;\n');
      writeFileSync(join(root, 'src', 'nested', 'helper.mjs'), 'export const helper = true;\n');
      writeFileSync(join(root, 'node_modules', 'dependency', 'ignored.ts'), 'export const ignored = true;\n');

      const scan = listFilesIncludingUntracked(root) as {
        files: string[];
        declared: string[];
        scanned: string[];
        unscanned: string[];
      };
      expect(scan.files).toContain('src/importer.ts');
      expect(scan.files).toContain('src/nested/helper.mjs');
      expect(scan.files).not.toContain('node_modules/dependency/ignored.ts');
      expect(scan.declared).toEqual([]);
      expect(scan.scanned).toEqual([]);
      expect(scan.unscanned).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits unscanned into present-on-disk vs absent, so an alarm can key on the serious one', () => {
    // WI-6776. The two gaps are not equally serious and a caller that ACTS on coverage
    // must tell them apart. `unscannedPresent` means git failed to read files that are
    // really there (release-shaped checkout / linked worktree) — the scan is missing real
    // content. `unscannedAbsent` means nothing is checked out, which contributes no files
    // anywhere and so does not shrink the scan relative to reality.
    //
    // This matters because this repo PERMANENTLY carries one absent submodule
    // (libs/zero-harness, retired and deliberately uninitialized). An alarm keyed on
    // `unscanned` therefore fires on every run in a totally healthy tree, gets trained
    // away, and is worth nothing on the day the tree really is broken. check-vacuous-
    // negative-assertions keys its "corpus was INCOMPLETE" warning on unscannedPresent
    // for exactly this reason.
    const cov = coverageOf([]) as {
      unscanned: string[];
      unscannedPresent: string[];
      unscannedAbsent: string[];
    };
    // Exhaustive + disjoint: nothing may fall through the split.
    expect(new Set([...cov.unscannedPresent, ...cov.unscannedAbsent])).toEqual(new Set(cov.unscanned));
    expect(cov.unscannedPresent.filter((p) => cov.unscannedAbsent.includes(p))).toEqual([]);
    // Non-vacuity: with NO files supplied, every checked-out submodule must land in
    // `present` — an always-empty `present` would silence the alarm this exists to raise.
    expect(cov.unscannedPresent.length).toBeGreaterThan(30);
  });

  it('returns REAL paths for filenames git would C-quote — not the quoted literal (WI-2145427)', () => {
    // THE REGRESSION, measured: `git ls-files` C-QUOTES any path containing a quote,
    // backslash, control char, or non-ASCII byte. A newline-splitting caller receives
    // `"\"$LOG\""` — an 11-character literal — where the real filename is `"$LOG"`.
    // lstat cannot resolve it, so a real, readable, TRACKED file is indistinguishable
    // from a missing one.
    //
    // Why that is severe rather than cosmetic: the passing-task verdict cache binds a
    // repo-wide guard task to EVERY tracked file, and a single unreadable entry fails
    // the whole closure with `provenance-incomplete` — which short-circuits BEFORE any
    // identity component is compared. On 2026-09-05, one such junk file (accidental
    // captured stderr from an unexpanded `> "$LOG"` redirect, swept in by git-sync)
    // drove 82% of all cache decisions to that reason and the hit rate to ZERO across
    // 2,229 run logs, while the cache itself was entirely healthy. Deleting the file
    // fixed the instance; `-z` is what makes the CLASS impossible.
    //
    // This test is deliberately not "does the repo contain a quoted path" — that would
    // pass vacuously the moment the tree is clean, which is exactly the state the repo
    // is in now. It CONSTRUCTS the adversarial filename, so it keeps failing on a revert.
    const root = mkdtempSync(join(tmpdir(), 'tracked-files-quoted-'));
    try {
      // WI-41180: bound the sync spawn — the pure lane shares one worker fork, so a hang here
      // wedges every file in it until the batch watchdog kills the task.
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      // Every character class git quotes: an embedded double quote, a backslash, and a
      // non-ASCII byte. Any ONE of them reproduces the bug on its own.
      const hostile = ['"$LOG"', 'back\\slash.txt', 'café.txt'];
      for (const name of hostile) writeFileSync(join(root, name), 'x\n');
      git('add', '-A');
      git('commit', '-qm', 'hostile filenames');

      // Non-vacuity: prove git really would quote these, or the assertion below is empty.
      const quoted = git('ls-files').split('\n').filter(Boolean);
      expect(quoted.some((p) => p.startsWith('"'))).toBe(true);

      const scan = listTrackedFiles(root) as { files: string[] };
      for (const name of hostile) {
        expect(scan.files).toContain(name);
        // The property that actually matters downstream: every enumerated path resolves.
        expect(() => lstatSync(join(root, name))).not.toThrow();
      }
      // NOTE: there is deliberately no "path must not start/end with a quote" check.
      // That shape test looks like it detects git's quoting and does not: the REAL
      // filename `"$LOG"` also starts and ends with a quote character, so the assertion
      // rejects a correctly-decoded path. (It did, on first run.) No purely lexical test
      // separates a quoted wrapper from a filename containing those bytes — a backslash
      // is likewise legitimate, as `back\slash.txt` above shows. RESOLVABILITY is the
      // only sound discriminator, and it is also the exact property callers depend on.
      const unreadable = scan.files.filter((p) => {
        try {
          lstatSync(join(root, p));
          return false;
        } catch {
          return true;
        }
      });
      expect(unreadable).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits a tracked path rm-ed from disk but not yet swept, and keeps a dangling tracked symlink (WI-10004173)', () => {
    // THE REGRESSION, measured 2026-09-30: an agent deleted 11 tracked files with plain
    // `rm` on the shared tree. Until git-sync committed the deletion the index still
    // listed them, and three whole-tree guards that read every enumerated path went red
    // with ENOENT for every agent that ran them in that window.
    const root = mkdtempSync(join(tmpdir(), 'tracked-files-deleted-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      writeFileSync(join(root, 'kept.ts'), 'x\n');
      writeFileSync(join(root, 'deleted.ts'), 'x\n');
      writeFileSync(join(root, 'target.ts'), 'x\n');
      symlinkSync('target.ts', join(root, 'link.ts'));
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      rmSync(join(root, 'deleted.ts'));
      // The symlink's TARGET goes too: the link itself is a real directory entry.
      rmSync(join(root, 'target.ts'));

      // Non-vacuity: the index really does still list the rm-ed path.
      expect(git('ls-files').split('\n')).toContain('deleted.ts');

      for (const scan of [listTrackedFiles(root), listFilesIncludingUntracked(root)] as Array<{ files: string[] }>) {
        expect(scan.files).not.toContain('deleted.ts');
        expect(scan.files).not.toContain('target.ts');
        expect(scan.files).toContain('kept.ts');
        expect(scan.files).toContain('link.ts');
        // The downstream property: a guard can open every enumerated entry.
        for (const file of scan.files) expect(() => lstatSync(join(root, file))).not.toThrow();
      }
      expect(presentOnDisk(['kept.ts', 'deleted.ts', 'link.ts'], root)).toEqual(['kept.ts', 'link.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * WI-6776 — the ratchet. Migrating today's guards fixes today's guards; it does not
 * stop the next one from enumerating the tree and printing a bare ✓ over subtrees it
 * never opened. This asserts the CONTRACT rather than a file list, so a new recursing
 * script has to opt in (or state a reason) instead of silently reintroducing the class.
 *
 * Note the glob is `scripts/*.mjs`, NOT `scripts/check-*.mjs`: the parent item listed
 * three offenders because it globbed `check-*`, and that missed `scan-retirement-surface.mjs`
 * (recurses, different prefix) as well as `check-env-feature-gates.mjs`.
 */
describe('recursing guards must report coverage (WI-6776 ratchet)', () => {
  const scriptsDir = fileURLToPath(new URL('../../../scripts', import.meta.url));

  /**
   * Scripts that recurse but legitimately need no coverage line. Each entry states WHY —
   * an unexplained entry is how a ratchet quietly becomes a rubber stamp.
   */
  const ALLOW = new Map<string, string>([
    [
      'lib/tracked-files.mjs',
      'IS the shared helper — it defines the coverage contract rather than consuming it.',
    ],
  ]);

  /** Every .mjs under scripts/, including subdirectories, as a scripts/-relative path. */
  const listMjs = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? listMjs(join(dir, e.name), `${prefix}${e.name}/`)
        : e.name.endsWith('.mjs')
          ? [`${prefix}${e.name}`]
          : [],
    );

  /**
   * Strip comment lines before asking "does this script recurse?".
   *
   * WI-6730: the detector used to test the raw file text, so a guard that
   * DELIBERATELY does not recurse — and says so in a comment naming
   * `--recurse-submodules` to explain why — was classified as recursing and then
   * failed for not reporting coverage it has no business reporting. That is the
   * same prose-vs-code confusion this repo already hit in
   * check-no-retired-imports.mjs, whose `from` pattern matched an English sentence
   * about `_retired/`.
   *
   * Routing such a guard to ALLOW would be worse than the false positive: ALLOW
   * means "recurses but legitimately needs no coverage line", and for these scripts
   * that is simply untrue. Classify on CODE, and the question stops arising.
   */
  const recursesInCode = (text: string): boolean =>
    text
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n')
      .includes('recurse-submodules');

  const recursing = listMjs(scriptsDir).filter((f) =>
    recursesInCode(readFileSync(join(scriptsDir, f), 'utf8')),
  );

  it('finds the recursing scripts at all (a zero here would make this suite vacuous)', () => {
    expect(recursing.length).toBeGreaterThanOrEqual(4);
    expect(recursing).toContain('check-no-control-bytes.mjs');
  });

  it.each(recursing)('%s reports what its scan did NOT cover', (file) => {
    if (ALLOW.has(file)) return;
    const text = readFileSync(join(scriptsDir, file), 'utf8');
    expect(
      text.includes('describeUnscanned') || text.includes('coverageOf'),
      `${file} enumerates the tree with --recurse-submodules but never reports coverage.\n` +
        `In a release-shaped checkout (papercusp-checkpoint / papercusp-release: submodule source is\n` +
        `git archive-extracted, so there is no .git to descend into) that scan reaches ZERO submodule\n` +
        `files and still prints success — a confident ✓ over ~22% of the tree it never opened.\n` +
        `FIX: import { coverageOf, describeUnscanned } from './lib/tracked-files.mjs' and append the\n` +
        `suffix to the success message. If this script genuinely needs no coverage line, add it to\n` +
        `ALLOW in this test WITH A REASON.`,
    ).toBe(true);
  });
});

/**
 * WI-10004176 — the index-lag ratchet (follow-up to WI-10004173).
 *
 * On the shared tree an agent's plain `rm` leaves the path in the INDEX until the next
 * git-sync sweep commits the deletion. A guard that enumerates `git ls-files` and then
 * reads every entry throws ENOENT for every agent that runs it in that window — three
 * guards went red at once on 2026-09-30 after one agent deleted 11 files. The gate's
 * clean checkout never sees the window, so nothing in CI catches it; this does.
 *
 * The contract: a file that EXECUTES an index enumeration and reads files must drop
 * index entries with no directory entry — via presentOnDisk / listTrackedFiles /
 * listFilesIncludingUntracked, a `.filter(… existsSync(…))` over the list, or a
 * subtracted `ls-files --deleted` — or appear in ALLOW with the reason it is safe.
 * Like the WI-6776 ratchet above, this classifies on CODE shape, so it is a pattern
 * ratchet and can miss an exotic invocation; it exists so a NEW ordinary one cannot
 * silently reintroduce the class.
 */
describe('enumerate-then-read guards tolerate index-lagged deletions (WI-10004176 ratchet)', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  /** Raw index readers that are safe WITHOUT the filter. Each entry states WHY. */
  const ALLOW = new Map<string, string>([
    [
      'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.edge.test.ts',
      'lists the index of a temp repo it just built and reads two files it wrote — never the shared tree.',
    ],
    [
      'apps/operator/lib/release/runtime-workspace-build-coverage.ts',
      'release code (must not import scripts/); every manifest read is try/catch → continue.',
    ],
    [
      'packages/operator-core/lib/__tests__/affected-tests-passing-verdict-cache.test.ts',
      'asserts on the index population itself (no tracked .vitest-tmp artifact); never reads an entry.',
    ],
    [
      'packages/operator-core/lib/doc-claims/dot-prefixed-test-scratch.test.ts',
      'asserts on the index population itself (no tracked dot-prefixed test); never reads an entry.',
    ],
    [
      'apps/operator/lib/no-pnpm-hijack.test.ts',
      'asserts on the index population itself (no tracked foreign lockfile); never reads an entry.',
    ],
    [
      'packages/operator-core/lib/nonasserting-test-guard.test.ts',
      'every entry read is try/catch → return ("deleted between ls-files and read").',
    ],
    ['scripts/check-no-agent-intent-comments.mjs', 'every entry read is try/catch → continue ("vanished mid-scan").'],
    ['scripts/check-no-control-bytes.mjs', 'every entry read is try/catch → continue ("vanished between git ls-files and read").'],
    ['scripts/check-no-identity-literals.mjs', 'every entry read is try/catch → continue ("vanished mid-run").'],
    ['scripts/check-no-owner-name-tags.mjs', 'every entry read is try/catch → continue ("vanished mid-run").'],
    ['scripts/scan-retirement-surface.mjs', 'every entry read is try/catch → continue ("gone since ls-files ran").'],
    [
      'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
      'production git-sync: every ls-files call tests index MEMBERSHIP of named paths; it never enumerates-then-reads.',
    ],
    [
      'scripts/test-files.mjs',
      'asks index MEMBERSHIP of the caller-named paths (provenance banner); its reads are ENOENT-tolerant.',
    ],
  ]);

  const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
  const SKIP = /(?:^|\/)(?:node_modules|dist|\.vitest-tmp|env-sidecars|sidecar)\/|\.min\.js$|\.d\.[cm]?ts$/;
  /** An index-enumeration INVOCATION: argv starting with 'ls-files', git('ls-files', …), or a `git ls-files` shell string. */
  const INVOKE = /\[\s*(['"`])ls-files\1|\bgit\s*\(\s*(['"`])ls-files\2|\b(?:execSync|exec|execFileSync|execFile|spawnSync|spawn)\s*\(\s*(['"`])git(?:\s+-C\s+\S+)?\s+ls-files\b/g;
  const READS = /\breadFileSync\s*\(|\breadFile\s*\(|\bcreateReadStream\s*\(/;
  const FILTERED =
    /\b(?:presentOnDisk|listTrackedFiles|listFilesIncludingUntracked)\b|\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*(?:fs\.)?existsSync\(|(['"`])ls-files\1\s*,\s*(['"`])--deleted\2/;
  /** Listings that cannot contain an index-lagged deletion: untracked-only, stage/mode dumps, deletions. */
  const indexFree = (invocation: string): boolean =>
    (/--others/.test(invocation) && !/--cached/.test(invocation)) ||
    /(?:^|[\s'"`,])(?:-s|--stage|--deleted|--error-unmatch)(?=[\s'"`,]|$)/.test(invocation);

  /** 'unfiltered' | 'filtered' | null (not an enumerate-then-read file). */
  const classify = (text: string): 'unfiltered' | 'filtered' | null => {
    if (!text.includes('ls-files')) return null;
    // Preserve quoted argv values, but require the invocation anchor to be live code.
    // Shell-looking prose in a justification is not an index enumeration (WI-10005805).
    const code = stripCommentsOnly(text);
    const masked = stripCommentsAndStrings(text);
    const invocations = [...code.matchAll(INVOKE)].filter((m) => isLiveCodeAt(text, masked, m.index)).map((m) => {
      const rest = code.slice(m.index, m.index + 240);
      const end = rest.search(/[\])]/);
      return end === -1 ? rest : rest.slice(0, end);
    });
    if (invocations.length === 0 || invocations.every(indexFree) || !READS.test(masked)) return null;
    return firstLiveMatch(text, masked, FILTERED) ? 'filtered' : 'unfiltered';
  };

  it('calibration: the detector separates the shapes it exists to judge', () => {
    const bare = `const f = execFileSync('git', ['ls-files', '*.ts']).split('\\n');\nfor (const p of f) readFileSync(p);`;
    expect(classify(bare)).toBe('unfiltered');
    expect(classify(`${bare}\nconst kept = presentOnDisk(f, ROOT);`)).toBe('filtered');
    expect(classify(`${bare}\nconst kept = f.filter((p) => existsSync(join(ROOT, p)));`)).toBe('filtered');
    expect(classify(`const out = execSync('git ls-files -z'); readFileSync(x);`)).toBe('unfiltered');
    expect(classify(`const u = git(['ls-files', '--others', '--exclude-standard']); readFileSync(u[0]);`)).toBeNull();
    expect(classify(`const s = git(['ls-files', '-s']); readFileSync(s[0]);`)).toBeNull();
    expect(classify(`if (args[0] === 'ls-files') return stub; readFileSync(x);`)).toBeNull();
    expect(classify(`// execFileSync('git', ['ls-files'])\nreadFileSync(x);`)).toBeNull();
    expect(classify(`const f = execFileSync('git', ['ls-files']);`)).toBeNull();
  });

  it('WI-10005805: command-shaped prose never supplies an executable enumeration', () => {
    const read = `readFileSync(path, 'utf8');`;
    expect(classify(`const reason = 'git ls-files plus file reads; executes nothing'; ${read}`)).toBeNull();
    expect(classify('const reason = `git ls-files plus file reads`; ' + read)).toBeNull();
    expect(classify('const docs = `execSync("git ls-files -z"); readFileSync(x);`; ' + read)).toBeNull();
    expect(classify('const docs = `execFileSync("git", ["ls-files"]);`; ' + read)).toBeNull();
    expect(classify(`/* execSync('git ls-files -z') */ ${read}`)).toBeNull();
    expect(classify(`execSync('git ls-files -z'); const docs = 'readFileSync(x)';`)).toBeNull();
    expect(classify(`execSync('git ls-files -z'); readFileSync(x); const docs = 'presentOnDisk';`)).toBe('unfiltered');
  });

  it('WI-10005805: ignores an earlier prose match while retaining a later live shell invocation', () => {
    const docs = 'const docs = `execSync("git ls-files -z")`; ';
    expect(classify(docs + `execSync('git ls-files -z'); readFileSync(x);`)).toBe('unfiltered');
    expect(classify(docs + `execSync('git ls-files -z'); const kept = presentOnDisk(files, ROOT); readFileSync(x);`)).toBe('filtered');
    expect(classify(`execSync(\`git -C /repo ls-files -z\`); readFileSync(x);`)).toBe('unfiltered');
  });

  const scanned = (listTrackedFiles(repoRoot) as { files: string[] }).files.filter(
    (f) => SOURCE.test(f) && !SKIP.test(f),
  );
  const verdicts = new Map<string, 'unfiltered' | 'filtered'>();
  for (const rel of scanned) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue; // vanished after enumeration — the class this suite guards
    }
    const verdict = classify(text);
    if (verdict) verdicts.set(rel, verdict);
  }

  it('finds the enumerate-then-read population at all (a zero here would make this suite vacuous)', () => {
    expect(scanned.length).toBeGreaterThan(5000);
    expect(verdicts.get('packages/operator-core/lib/design-to-code-coverage-seam.acceptance.test.ts')).toBe('filtered');
    expect(verdicts.get('scripts/check-no-control-bytes.mjs')).toBe('unfiltered');
  });

  it('every raw index reader drops index-lagged deletions (or states why it need not)', () => {
    const offenders = [...verdicts].filter(([rel, v]) => v === 'unfiltered' && !ALLOW.has(rel)).map(([rel]) => rel);
    expect(
      offenders,
      `These files enumerate \`git ls-files\` and read files without dropping index entries that are\n` +
        `gone from disk. On the shared tree a plain \`rm\` stays in the index until git-sync commits it,\n` +
        `so each read of such an entry throws ENOENT for every agent that runs the guard meanwhile.\n` +
        `FIX: wrap the enumerated list — presentOnDisk(list, root) from scripts/lib/tracked-files.mjs —\n` +
        `or filter it with existsSync. If a file is safe without it, add it to ALLOW WITH A REASON.`,
    ).toEqual([]);
  });

  it('ALLOW carries no stale entries (each must still be an unfiltered raw reader)', () => {
    const stale = [...ALLOW.keys()].filter((rel) => verdicts.get(rel) !== 'unfiltered');
    expect(stale, 'remove these from ALLOW — they no longer need the exemption').toEqual([]);
  });
});
