/**
 * WI-6814 — the required-field trap detector.
 *
 * The case that motivated it (EI-19304433184633406, the 5th occurrence): `remoteOrigin`
 * became required on `IssueClaimExclusionBreakdown.excluded`, which is NESTED one level
 * inside the interface. That nesting is the whole difficulty — a top-level-only scan
 * reports nothing and reads exactly like "no trap here", which is the false-clean failure
 * this guard exists to prevent. Several tests below pin the nested case specifically.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { attributedTypeErrors, collectExportedRequiredProps, collectExportedSignatures, collectExportedTypeNames, collectExportedUnionMembers, collectExportedValueNames, diffRequiredAdditions, diffSignatureBreaks, diffUnionWidenings, exitForNoFindings, formatNoFindings, formatScopedTypecheckWarning, formatUnattributedFindings, strandHeadline, submoduleFor, submoduleRevisionAt } from '../../../../scripts/check-required-field-strands.mjs';

const ROOT = resolve(__dirname, '../../../..');

describe('measured exported symbol changes for incident pushes', () => {
  it('distinguishes a body edit from unchanged exports, comments and formatting', async () => {
    // @ts-expect-error — shared executable guard has no type declarations
    const { diffExportedSymbolText } = await import('../../../../scripts/check-required-field-strands.mjs');
    const before = 'export function changed() { return 1; }\nexport const same = 2;';
    expect(diffExportedSymbolText(before, before.replace('return 1', 'return 3'), 'a.ts'))
      .toEqual([{ name: 'changed', line: 1 }]);
    expect(diffExportedSymbolText(before, '// comment\nexport function changed(){return 1;}\nexport const same=2;', 'a.ts'))
      .toEqual([]);
    expect(diffExportedSymbolText(before, 'export const same = 2;', 'a.ts'))
      .toEqual([{ name: 'changed', line: 1 }]);
    expect(diffExportedSymbolText(before, 'export function changed( {', 'a.ts')).toEqual([]);
  });
});

const BEFORE = `
export interface IssueClaimExclusionBreakdown {
  matchedByFilter: number;
  claimable: number;
  excluded: {
    taken: number;
    cooldown: number;
  };
}
`;

const AFTER = `
export interface IssueClaimExclusionBreakdown {
  matchedByFilter: number;
  claimable: number;
  excluded: {
    taken: number;
    cooldown: number;
    remoteOrigin: number;
  };
}
`;

describe('collectExportedRequiredProps', () => {
  it('records NESTED object-literal members under a dotted path, not just top-level ones', () => {
    const props = collectExportedRequiredProps(AFTER);
    expect(props.has('IssueClaimExclusionBreakdown.excluded.remoteOrigin')).toBe(true);
    expect(props.has('IssueClaimExclusionBreakdown.matchedByFilter')).toBe(true);
  });

  it('marks optional members optional so they are never reported as stranding anything', () => {
    const props = collectExportedRequiredProps(`
      export interface A { req: number; opt?: string; }
    `);
    expect(props.get('A.req')).toEqual({ optional: false });
    expect(props.get('A.opt')).toEqual({ optional: true });
  });

  it('ignores NON-exported types — they have no cross-file construction sites to strand', () => {
    const props = collectExportedRequiredProps(`
      interface Private { a: number; }
      export interface Public { b: number; }
    `);
    expect([...props.keys()]).toEqual(['Public.b']);
  });

  it('covers exported object-type ALIASES, not only interfaces', () => {
    const props = collectExportedRequiredProps(`export type Stamp = { harness: string; };`);
    expect(props.has('Stamp.harness')).toBe(true);
  });
});

describe('diffRequiredAdditions', () => {
  it('flags the real EI-19304433184633406 case: a required field added to a NESTED literal', () => {
    const added = diffRequiredAdditions(BEFORE, AFTER);
    expect(added).toEqual([
      { path: 'IssueClaimExclusionBreakdown.excluded.remoteOrigin', reason: 'added-required' },
    ]);
  });

  it('flags a field TIGHTENED from optional to required — it strands sites just as hard', () => {
    const added = diffRequiredAdditions(
      `export interface A { x?: number; }`,
      `export interface A { x: number; }`,
    );
    expect(added).toEqual([{ path: 'A.x', reason: 'optional-to-required' }]);
  });

  it('stays SILENT on an added OPTIONAL field — the safe way to extend a shared type', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; }`,
      `export interface A { x: number; y?: string; }`,
    );
    expect(added).toEqual([]);
  });

  it('stays silent when nothing about the type changed (no false positive on unrelated edits)', () => {
    expect(diffRequiredAdditions(AFTER, AFTER)).toEqual([]);
  });

  it('stays silent on a REMOVED field — that breaks nothing that constructs the type', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; y: string; }`,
      `export interface A { x: number; }`,
    );
    expect(added).toEqual([]);
  });

  it('does not flag a required field added to a NON-exported type', () => {
    const added = diffRequiredAdditions(
      `interface A { x: number; }`,
      `interface A { x: number; y: string; }`,
    );
    expect(added).toEqual([]);
  });

  it('reports every addition across several types in one file, not just the first', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; }\nexport interface B { y: number; }`,
      `export interface A { x: number; a2: string; }\nexport interface B { y: number; b2: string; }`,
    );
    expect(added.map((a: { path: string }) => a.path).sort()).toEqual(['A.a2', 'B.b2']);
  });

  it('recurses through an OPTIONAL wrapper: a required field inside it still strands every site that supplies the wrapper', () => {
    const added = diffRequiredAdditions(
      `export interface A { w?: { p: number; }; }`,
      `export interface A { w?: { p: number; q: number; }; }`,
    );
    expect(added).toEqual([{ path: 'A.w.q', reason: 'added-required' }]);
  });
});

/**
 * EI-19422135158287319 — a type INTRODUCED in the same diff cannot strand anything.
 *
 * main() already skipped a brand-new FILE for exactly this reason ("a brand-new exported
 * interface has no pre-existing construction sites, so it cannot strand anything"), but
 * applied that reasoning only at FILE granularity. A new type added to an EXISTING file
 * therefore reported every one of its fields as newly-required — and re-fired on every
 * later edit to that file, so one new type produced a run of identical warnings in a
 * single session (measured: 3 fires across 3 edits).
 *
 * The cost is not noise, it is CREDIBILITY: this guard's value depends on agents still
 * reading it, and a warning that is provably impossible is how a good advisory gets tuned
 * out — paid later by whoever hits a real strand.
 */
describe('diffRequiredAdditions — a type NEW in this diff strands nothing by construction', () => {
  it('stays SILENT on a brand-new exported interface added to an existing file', () => {
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; }\nexport interface RegistryBehaviour { readonly name: string; readonly seeAlso?: unknown; }`,
    );
    expect(added).toEqual([]);
  });

  it('stays SILENT on a brand-new exported TYPE ALIAS, including its nested literals', () => {
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; }\nexport type NewShape = { top: string; nested: { deep: number; }; };`,
    );
    expect(added).toEqual([]);
  });

  it('STILL FIRES for a pre-existing type in the same diff — the guard is narrowed, not blunted', () => {
    // The discriminating case: one new type (silent) + one real addition (flagged), together.
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; b: string; }\nexport interface BrandNew { c: number; }`,
    );
    expect(added).toEqual([{ path: 'Existing.b', reason: 'added-required' }]);
  });

  it('FIRES on the first required field added to a pre-existing EMPTY interface', () => {
    // The edge case that decides the implementation: an `export interface Foo {}` contributes
    // ZERO property paths, so a type-name set inferred from those paths would not contain Foo
    // and this genuine stranding would be suppressed as "new type". Names are collected from
    // declarations directly precisely so this cannot happen.
    const added = diffRequiredAdditions(
      `export interface Foo {}`,
      `export interface Foo { x: number; }`,
    );
    expect(added).toEqual([{ path: 'Foo.x', reason: 'added-required' }]);
  });

  it('still flags optional → required on a pre-existing type (the tightening path is unaffected)', () => {
    const added = diffRequiredAdditions(
      `export interface A { x?: number; }`,
      `export interface A { x: number; }\nexport interface AlsoNew { y: string; }`,
    );
    expect(added).toEqual([{ path: 'A.x', reason: 'optional-to-required' }]);
  });
});

describe('collectExportedTypeNames', () => {
  it('collects exported interfaces and type aliases, and ignores non-exported ones', () => {
    const names = collectExportedTypeNames(
      `export interface A { x: number; }
       export type B = { y: number; };
       interface Hidden { z: number; }
       type AlsoHidden = { w: number; };`,
    );
    expect([...names].sort()).toEqual(['A', 'B']);
  });

  it('includes a MEMBERLESS exported interface — the case a property-derived set would miss', () => {
    expect([...collectExportedTypeNames(`export interface Empty {}`)]).toEqual(['Empty']);
  });

  it('includes a non-object type alias (never under-reports what already existed)', () => {
    // `export type U = 'a' | 'b'` has no properties to scan, but it DID exist — and being
    // conservative here only ever means reporting, never wrongly suppressing.
    expect([...collectExportedTypeNames(`export type U = 'a' | 'b';`)]).toEqual(['U']);
  });
});

/**
 * The check is only as good as its NEGATIVE verdict, and on this tree that verdict
 * used to be unfalsifiable. git-sync commits the whole shared tree on a schedule, so
 * minutes after you edit, working-tree == HEAD and the default `--base HEAD` diff is
 * EMPTY — the scan then examines zero files and printed the same green as a real pass.
 *
 * Measured 2026-08-02: `npm run lint:required-field-strands` reported "no required
 * fields added" for a change that HAD added required field `ServeProgress.bytesIn`
 * (serve-wiring.ts). Re-running with `--base <introducing-commit>^` flagged it
 * correctly. Same "checked nothing, rendered as clean" class as the `tsc -p .`
 * zero-file trap.
 */
/**
 * EI-20020054576584970 — the blindness that let the 2026-08-12 incident through.
 *
 * To the superproject a submodule is a GITLINK, so `git show HEAD:<submodule path>` fails
 * and `git diff` names only the gitlink. Both of this guard's entry points therefore saw
 * NOTHING for any file inside libs/*, and the run degraded to NOT CHECKED while blaming the
 * git-sync race. That is how `ActiveLockRow.lock_id` (libs/papercusp/packages/locks/src/
 * su-lock-store.ts) stranded a mock fixture and froze `main` for ~14h.
 *
 * Verified end-to-end after the fix: the same command that used to print
 * "fatal ... → ZERO files examined" now reports `ActiveLockRow.lock_id (new required field)`.
 * These cases pin the path-ownership rule that makes that possible.
 */
describe('submoduleFor — ask the repository that actually tracks the file', () => {
  // Real prefixes from this repo's .gitmodules, longest-first as submodulePrefixes() sorts them.
  const prefixes = ['libs/generic/papergrid', 'libs/papercusp-db', 'libs/papercusp', 'libs/agent-chat'];

  it('resolves a file inside a submodule to that submodule', () => {
    expect(submoduleFor('libs/papercusp/packages/locks/src/su-lock-store.ts', prefixes)).toBe('libs/papercusp');
  });

  it('returns null for a superproject file, so the normal path is untouched', () => {
    expect(submoduleFor('packages/operator-core/lib/git-pipeline-position.ts', prefixes)).toBeNull();
  });

  it('does NOT let a submodule swallow a SIBLING whose name it prefixes', () => {
    // libs/papercusp and libs/papercusp-db both exist here. A bare startsWith(prefix) would
    // route every libs/papercusp-db file into the wrong repository, where its path does not
    // exist — reproducing the exact "cannot see your file" failure this fix removes.
    expect(submoduleFor('libs/papercusp-db/src/index.ts', prefixes)).toBe('libs/papercusp-db');
  });

  it('prefers the NESTED submodule over its parent (prefixes are longest-first)', () => {
    expect(submoduleFor('libs/generic/papergrid/src/grid.ts', ['libs/generic/papergrid', 'libs/generic'])).toBe(
      'libs/generic/papergrid',
    );
  });

  it('matches the submodule root path itself, not only paths beneath it', () => {
    expect(submoduleFor('libs/papercusp', prefixes)).toBe('libs/papercusp');
  });
});

describe('submoduleRevisionAt — follow the superproject gitlink before querying a submodule', () => {
  const submodulePrefix = 'libs/generic/memory';
  const submoduleFile = `${submodulePrefix}/src/backend.ts`;

  it('preserves an owning submodule commit pin from the local edit collector', () => {
    const ownerBase = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(ROOT, submodulePrefix), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    }).trim();
    expect(submoduleRevisionAt(ownerBase, submodulePrefix)).toBe(ownerBase);
    expect(submoduleRevisionAt('f'.repeat(40), submodulePrefix)).toBeNull();
  });

  it('resolves a superproject base to the submodule commit recorded at that base', () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    const expected = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${base}:${submodulePrefix}`],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
    ).trim();

    expect(submoduleRevisionAt(base, submodulePrefix)).toBe(expected);
  });

  it('examines a declared submodule file instead of treating the superproject SHA as its base', () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    const result = spawnSync(
      'node',
      ['scripts/check-required-field-strands.mjs', '--base', base, `--files=${submoduleFile}`, '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    const report = JSON.parse(result.stdout);

    expect(result.stderr).not.toMatch(/fatal: (?:bad revision|path .* exists on disk)/);
    expect(report.examined).toContain(submoduleFile);
  }, 120_000);

  it('accepts an E2BIG-class declared set through the shared --files-from response-file surface', () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    const dir = mkdtempSync(join(tmpdir(), 'required-field-strands-files-from-'));
    const responseFile = join(dir, 'files.json');
    // Repetition makes the transport payload larger than Linux's ~128 KiB single-argument
    // ceiling without making the detector do thousands of git reads: the reused parser
    // deduplicates into the same one-file declared set before scanning.
    writeFileSync(responseFile, JSON.stringify(Array.from({ length: 5_000 }, () => submoduleFile)));
    expect(statSync(responseFile).size).toBeGreaterThan(128 * 1024);
    try {
      const result = spawnSync(
        'node',
        [
          'scripts/check-required-field-strands.mjs',
          '--base',
          base,
          `--files-from=${responseFile}`,
          '--json',
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      const report = JSON.parse(result.stdout);

      expect(result.error, `guard failed to spawn: ${result.error?.message}`).toBeUndefined();
      expect(result.stderr).not.toContain('E2BIG');
      expect(report.examined).toEqual([submoduleFile]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('declared additions absent at the comparison base', () => {
  it('examines a present file that did not exist at base instead of returning NOT_CHECKED', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-added-file-'));
    const file = 'packages/operator-core/lib/newly-added.ts';
    try {
      cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });

      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      writeFileSync(join(tmp, 'README.md'), 'base\n');
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', 'scripts', 'README.md');
      git('commit', '-qm', 'base');

      // The declared file is present now but has no before-image at HEAD. A real empty
      // before-image is still an examined comparison; skipping it would manufacture
      // NOT_CHECKED for every newly added file.
      writeFileSync(join(tmp, file), 'export interface Fresh { required: number; }\n');
      const result = spawnSync(
        'node',
        ['scripts/check-required-field-strands.mjs', '--base', 'HEAD', `--files=${file}`, '--json'],
        { cwd: tmp, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      const report = JSON.parse(result.stdout);

      expect(result.error, `guard failed to spawn: ${result.error?.message}`).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('fatal: path');
      expect(report.examined).toEqual([file]);
      expect(report.findings).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * EI-18717671811306780. The guard's detection was already sound; what was missing sat one
 * step later, at the moment the author decides HOW to confirm. The prescribed command is
 * project-wide and under fleet load it queues behind pc-heavy for minutes, so the tempting
 * move is the fastest green thing available — a SCOPED typecheck. That substitution reports
 * GREEN on exactly this class, because the stranded sites are DEPENDENTS of the changed file
 * and a scoped run only compiles the file plus what it imports. These cases pin the warning
 * to the remediation text so it cannot be quietly dropped from the one place it is read.
 */
describe('formatScopedTypecheckWarning — the fast substitute is blind to this class', () => {
  it('names the scoped typecheck explicitly, so the reader recognises the shortcut they were about to take', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('scopeToFiles');
    expect(msg).toMatch(/scoped tsc/i);
  });

  it('gives the MECHANISM (dependents are not in the import graph), not just a prohibition', () => {
    const msg = formatScopedTypecheckWarning();
    // Without the reason, a hurried reader treats it as ceremony and overrides it.
    expect(msg).toContain('DEPENDENTS');
    expect(msg).toMatch(/import/i);
  });

  it('warns that a scoped run goes GREEN — an absent error, not a visible failure', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('GREEN');
  });

  it('names the pc-heavy queue as expected behaviour, so a wait is not misread as a hang', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('pc-heavy');
    expect(msg).toMatch(/not a hang/i);
  });
});

describe('formatNoFindings — "examined nothing" must never read as "clean"', () => {
  it('does NOT claim a clean bill when zero files were examined', () => {
    const msg = formatNoFindings([], 'HEAD');
    expect(msg).toContain('NOT CHECKED');
    expect(msg).toContain('ZERO files');
    // The specific misreading this exists to prevent.
    expect(msg).not.toMatch(/^✓/m);
  });

  it('names git-sync as the likely cause and gives a runnable recovery', () => {
    const msg = formatNoFindings([], 'HEAD');
    expect(msg).toContain('git-sync');
    expect(msg).toContain('--base');
  });

  it('passes cleanly when files WERE examined, and says how many', () => {
    const msg = formatNoFindings(['a.ts', 'b.ts', 'c.ts'], 'HEAD~1');
    expect(msg).toMatch(/^✓/);
    expect(msg).toContain('3 file(s) examined');
    expect(msg).toContain('HEAD~1');
    expect(msg).not.toContain('NOT CHECKED');
  });

  it('reports the base it actually used, so a wrong --base is visible in the verdict', () => {
    expect(formatNoFindings(['a.ts', 'b.ts'], 'abc123^')).toContain('abc123^');
  });

  /**
   * EI-19377892307939503. The zero-file branch above is real but UNREACHABLE on this
   * tree: `git diff` returns every agent's uncommitted edits, so peers keep the count
   * non-zero indefinitely while git-sync quietly drops YOUR file out of the diff within
   * minutes. Measured live — the check reported "3 changed file(s) examined" for a run
   * whose three files (checkpoint-run.ts, checkpoint-run.test.ts, fleet-scope-admission.
   * test.ts) belonged to a peer, while the file carrying the required-field addition had
   * already been committed. A count alone cannot expose that; the file list can.
   */
  it('NAMES the files examined, so an author sees their own file is absent', () => {
    const msg = formatNoFindings(['peer/one.ts', 'peer/two.ts'], 'HEAD');
    expect(msg).toContain('peer/one.ts');
    expect(msg).toContain('peer/two.ts');
  });

  it('warns that an INFERRED set is the whole fleet’s edits, not yours', () => {
    const msg = formatNoFindings(['peer/one.ts'], 'HEAD');
    expect(msg).toContain('INFERRED');
    // The actionable escape: declare the set instead of inferring it.
    expect(msg).toContain('--files=');
  });

  it('drops that warning for a DECLARED set, whose attribution IS trustworthy', () => {
    // A declared set is exactly what the caveat tells you to switch to, so repeating it
    // there would train readers to ignore it.
    const msg = formatNoFindings(['mine.ts'], 'HEAD', { declared: true });
    expect(msg).toMatch(/^✓/);
    expect(msg).toContain('mine.ts');
    expect(msg).not.toContain('INFERRED');
  });

  /**
   * EI-19396116936287206. `--files=` fixes attribution (WHICH files) but not vacuity
   * (WHETHER the diff was real): "examined" only ever meant "a before/after pair was
   * diffed", not "the two texts actually differed". On this tree git-sync commits within
   * minutes, so a NAMED file is frequently byte-identical to `base` by the time you check
   * it — measured live: `--files=` named the exact file carrying a real required-field
   * addition, examined it, found before===after (git-sync had already swept the edit into
   * HEAD), and printed a plain green with no hint the comparison was vacuous.
   */
  it('warns when a DECLARED file is byte-identical to base — the comparison proved nothing', () => {
    const msg = formatNoFindings(['mine.ts'], 'HEAD', {
      declared: true,
      identicalFiles: ['mine.ts'],
    });
    // EI-20097325488507587: this assertion used to require `/^✓/` here, on the rationale
    // that "other declared files may be genuinely examined" — true of the MIXED case
    // below, but not of this one, where EVERY named file was identical and the run
    // therefore compared nothing at all. exitForNoFindings already returned
    // EXIT_NOT_CHECKED for this exact input, so the ✓ headline contradicted the tool's
    // own exit status, and the invalidation sat four lines below it reading as a caveat
    // on a pass. The headline is what a reader acts on, so it has to carry the verdict.
    expect(msg).toMatch(/^⚠ NOT CHECKED/);
    expect(msg).not.toMatch(/^✓/);
    expect(msg).toContain('NOT CHECKED');
    expect(msg).toContain('BYTE-IDENTICAL');
    expect(msg).toContain('mine.ts');
    expect(msg).toContain('git-sync');
    expect(msg).toContain('--base');
  });

  it('says nothing extra when a DECLARED set has no identical files', () => {
    const msg = formatNoFindings(['mine.ts'], 'HEAD', { declared: true, identicalFiles: [] });
    expect(msg).not.toContain('BYTE-IDENTICAL');
    expect(msg).not.toContain('NOT CHECKED');
  });

  it('names only the identical files, not every declared file, when the set is mixed', () => {
    const msg = formatNoFindings(['mine.ts', 'also-mine.ts'], 'HEAD', {
      declared: true,
      identicalFiles: ['also-mine.ts'],
    });
    expect(msg).toContain('1 of 2 named file(s)');
    expect(msg).toContain('also-mine.ts');
    // A PARTIAL run did verify something, so it keeps the ✓ headline — the distinction
    // the invariant below polices, and the reason this is not simply "warn whenever any
    // file is identical".
    expect(msg).toMatch(/^✓/);
  });

  /**
   * THE INVARIANT, not another example: the headline a human acts on and the exit status
   * a script acts on must never disagree.
   *
   * They are separate code paths that happened to agree until they didn't — the text said
   * ✓ while the status said EXIT_NOT_CHECKED for an all-identical declared run. Pinning
   * the pair across the whole input matrix is what makes that unrepresentable; asserting
   * the two known cases individually is what let the third one drift.
   */
  it.each([
    { name: 'zero files examined', files: [] as string[], identical: [] as string[], declared: false },
    { name: 'inferred set, files examined', files: ['peer.ts'], identical: [], declared: false },
    { name: 'declared, none identical', files: ['mine.ts'], identical: [], declared: true },
    { name: 'declared, all identical', files: ['mine.ts'], identical: ['mine.ts'], declared: true },
    {
      name: 'declared, partially identical',
      files: ['mine.ts', 'also.ts'],
      identical: ['also.ts'],
      declared: true,
    },
  ])('headline and exit status agree: $name', ({ files, identical, declared }) => {
    const msg = formatNoFindings(files, 'HEAD', { declared, identicalFiles: identical });
    const code = exitForNoFindings({ examinedFiles: files, identicalFiles: identical, declared });
    expect(msg.startsWith('⚠ NOT CHECKED')).toBe(code !== 0);
    expect(msg.startsWith('✓')).toBe(code === 0);
  });
});

describe('inferred shared-tree findings — never claim a peer result for the caller', () => {
  it('marks peer findings untrusted and skips typecheck after the caller change is swept into HEAD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-attribution-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      const mine = 'packages/operator-core/lib/mine.ts';
      const peer = 'packages/operator-core/lib/peer.ts';
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
      cpSync(resolve(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(resolve(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      writeFileSync(join(tmp, mine), 'export interface Mine { id: string }\n');
      writeFileSync(join(tmp, peer), 'export interface Peer { id: string }\n');
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', '-A');
      git('commit', '-qm', 'base');

      // Simulate the caller's required-field edit being committed by git-sync before the
      // caller runs the guard, then leave a different agent's required-field edit dirty.
      writeFileSync(join(tmp, mine), 'export interface Mine { id: string; callerField: number }\n');
      git('add', mine);
      git('commit', '-qm', 'git-sync caller sweep');
      writeFileSync(join(tmp, peer), 'export interface Peer { id: string; peerField: number }\n');

      // If the guard accidentally forwards the inferred peer finding into lint-tsc, this
      // sentinel makes the regression fail loudly instead of doing real work in the temp repo.
      writeFileSync(join(tmp, 'scripts/lint-tsc.mjs'), 'process.exit(99);\n');
      // Child processes retain the committed-source boundary. The compiler
      // stand-in is a fixture input; commit it while leaving the subject dirty.
      git('add', 'scripts/lint-tsc.mjs');
      git('commit', '-qm', 'pin compiler fixture');
      const result = spawnSync('node', ['scripts/check-required-field-strands.mjs', '--typecheck'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).toBe(2);
      expect(out).toContain('NOT CHECKED');
      expect(out).toContain('no required-field addition is attributable to this caller');
      expect(out).toContain('Peer.peerField');
      expect(out).toContain('--typecheck: NOT RUN');
      expect(out).not.toContain('typecheck reported errors ATTRIBUTED');
      expect(out).not.toContain('callerField');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('exposes the attribution split to JSON consumers', () => {
    const peer = 'packages/operator-core/lib/peer.ts';
    const msg = formatUnattributedFindings(
      [{ file: peer, added: [{ path: 'Peer.peerField', reason: 'added-required' }] }],
      'HEAD',
      [peer],
    );
    expect(msg).toContain('no required-field addition is attributable to this caller');
    expect(msg).toContain('Peer.peerField');
    expect(msg).not.toMatch(/^✓/m);
  });
});

describe('check-required-field-strands --typecheck — diagnostic-only type attribution (EI-21833727883305743)', () => {
  it('fails when the dependent source omits the type name but the compiler diagnostic names it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-diagnostic-attribution-'));
    const changed = 'packages/operator-core/lib/daily-digest.ts';
    const dependent = 'packages/operator-core/lib/daily-digest-fixture.test.ts';
    const dependentSource = 'export const fixture = {};\n';
    try {
      cpSync(resolve(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(resolve(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
      writeFileSync(join(tmp, changed), 'export interface DailyDigestRunResult { digestId: string; }\n');
      writeFileSync(join(tmp, dependent), dependentSource);

      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: tmp,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', '-A');
      git('commit', '-qm', 'base');

      writeFileSync(
        join(tmp, changed),
        'export interface DailyDigestRunResult { digestId: string; runId: string; }\n',
      );
      // The real lint:tsc subprocess emits this diagnostic when the dependent's inferred
      // object literal omits the expected type. The fixture source intentionally contains no
      // DailyDigestRunResult reference; only the compiler message carries the type name.
      const diagnostic =
        `${dependent}(3,7): error TS2741: Property 'runId' is missing in type '{}' but required in type 'DailyDigestRunResult'.`;
      writeFileSync(
        join(tmp, 'scripts/lint-tsc.mjs'),
        `console.error(${JSON.stringify(diagnostic)}); process.exit(1);\n`,
      );
      git('add', 'scripts/lint-tsc.mjs');
      git('commit', '-qm', 'pin diagnostic compiler fixture');

      const result = spawnSync(
        'node',
        [
          'scripts/check-required-field-strands.mjs',
          '--typecheck',
          '--base',
          'HEAD',
          `--files=${changed}`,
        ],
        { cwd: tmp, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(dependentSource).not.toContain('DailyDigestRunResult');
      expect(result.error, `guard failed to spawn: ${result.error?.message}`).toBeUndefined();
      expect(result.status, out).toBe(1);
      expect(out).toContain('REQUIRED-FIELD ADDITION detected');
      expect(out).toContain('DailyDigestRunResult');
      expect(out).toContain(dependent);
      expect(out).toContain('typecheck reported errors ATTRIBUTED TO YOUR CHANGE');
      expect(out).toContain('source or compiler diagnostic references their exported type names');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('check-required-field-strands --typecheck — a declared DELETION is never forwarded to lint:tsc (WI-10003758)', () => {
  // The gate declares its changed-path set, which carries deletions. lint:tsc refuses a whole
  // selection naming a missing file (status=preflight-failed), so one deleted file used to blind
  // the guard to every real strand in the rest of the change and red the gate with exit 2.
  it('typechecks the surviving files and drops the deleted one from --files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-deleted-file-'));
    const changed = 'packages/operator-core/lib/digest-shape.ts';
    const deleted = 'packages/operator-core/lib/retired-epoch.ts';
    try {
      cpSync(resolve(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(resolve(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
      writeFileSync(join(tmp, changed), 'export interface DigestShape { id: string; }\n');
      writeFileSync(join(tmp, deleted), 'export const epoch = 1;\n');

      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', '-A');
      git('commit', '-qm', 'base');

      writeFileSync(join(tmp, changed), 'export interface DigestShape { id: string; runId: string; }\n');
      rmSync(join(tmp, deleted));
      // Records the selection it was handed; a real lint:tsc would refuse the missing path.
      writeFileSync(
        join(tmp, 'scripts/lint-tsc.mjs'),
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('lint-tsc-argv.json', JSON.stringify(process.argv.slice(2)));\n",
      );
      git('add', 'scripts/lint-tsc.mjs');
      git('commit', '-qm', 'pin argv compiler fixture');

      const result = spawnSync(
        'node',
        ['scripts/check-required-field-strands.mjs', '--typecheck', '--base', 'HEAD', `--files=${changed},${deleted}`],
        { cwd: tmp, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      expect(result.error, `guard failed to spawn: ${result.error?.message}`).toBeUndefined();
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
      const argv = JSON.parse(readFileSync(join(tmp, 'lint-tsc-argv.json'), 'utf8')) as string[];
      const filesArg = argv.find((a) => a.startsWith('--files=')) ?? '';
      expect(filesArg.slice('--files='.length).split(',')).toEqual([changed]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * EI-20095543794921181 — the warning above was already correct and already
 * printed; the run still EXITED 0. Prose does not reach `&& echo PASS`,
 * `grep -c "error TS"`, or a CI step's exit status, which are the readers that
 * actually decide. Measured: the default invocation reported exit 0 having
 * examined ZERO files (git-sync had already committed the edit, so nothing
 * differed from HEAD), while the same tree checked against the carrying commit
 * had 30 real errors — 5 in a file `test:affected` does not select.
 */
describe('exitForNoFindings — "no findings" is not a clean bill unless something was diffed', () => {
  it('is NOT 0 when zero files were examined — the false clean this exists to kill', () => {
    expect(exitForNoFindings({ examinedFiles: [], identicalFiles: [], declared: false })).not.toBe(0);
  });

  it('is NOT 0 when every DECLARED file was byte-identical to the base', () => {
    expect(
      exitForNoFindings({
        examinedFiles: ['mine.ts', 'also-mine.ts'],
        identicalFiles: ['mine.ts', 'also-mine.ts'],
        declared: true,
      }),
    ).not.toBe(0);
  });

  it('distinguishes "not checked" from "checked, strands found" (1) so a caller can tell them apart', () => {
    // The whole point of a third code: 0 and 1 are both claims about a run that
    // LOOKED, and neither is honest about a run that did not.
    const notChecked = exitForNoFindings({ examinedFiles: [], declared: false });
    expect(notChecked).not.toBe(0);
    expect(notChecked, 'must not collide with the strands-found status').not.toBe(1);
  });

  it('IS 0 when files were genuinely diffed and nothing was stranded', () => {
    expect(exitForNoFindings({ examinedFiles: ['mine.ts'], identicalFiles: [], declared: true })).toBe(0);
    expect(exitForNoFindings({ examinedFiles: ['a.ts', 'b.ts'], identicalFiles: [], declared: false })).toBe(0);
  });

  it('IS 0 for a PARTIAL declared run — it verified what it could, and the message names the rest', () => {
    // Deliberate: failing this case would fail runs that did real work. Tightening
    // it is a defensible future choice, but an intentional one, not a side effect.
    expect(
      exitForNoFindings({ examinedFiles: ['mine.ts', 'also-mine.ts'], identicalFiles: ['also-mine.ts'], declared: true }),
    ).toBe(0);
  });

  it('ignores identicalFiles when the set was INFERRED, not declared (identical tracking is a declared-mode signal)', () => {
    expect(exitForNoFindings({ examinedFiles: ['a.ts'], identicalFiles: ['a.ts'], declared: false })).toBe(0);
  });
});

describe('invalid base revisions — never reinterpret a bad revision as a clean diff', () => {
  it('fails closed with EXIT_NOT_CHECKED instead of printing a false-green headline', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-invalid-base-'));
    try {
      cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
      const file = join(tmp, 'packages/operator-core/lib/a.ts');
      writeFileSync(file, 'export interface A { id: string; }\n');

      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', '-A');
      git('commit', '-qm', 'base');
      writeFileSync(file, 'export interface A { id: string; required: number; }\n');

      const result = spawnSync('node', ['scripts/check-required-field-strands.mjs', '--base', 'not-a-real-revision'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).toBe(2);
      expect(output).toContain('cannot resolve base revision');
      expect(output).not.toContain('✓');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('attributedTypeErrors — a typechecker that fell over is not a finding', () => {
  // EI-21823157797410616. The catch around lint-tsc used to render ANY non-zero exit as
  // "✗ typecheck reported errors ATTRIBUTED TO YOUR CHANGE". lint-tsc's exit 1 means "a
  // regression, a TS1xxx hard-fail, OR a script/toolchain error" (scripts/lint-tsc.mjs:49),
  // so the exit status cannot tell those apart and this predicate reads the OUTPUT instead.

  it('is FALSE for the measured run-4 shape: stale-base git fatals and not one diagnostic', () => {
    // Verbatim shape from canonical run 4 (2026-08-29): origin/main sat 5,664 commits
    // stale, so lint-tsc's file set fell outside the typecheck project, it took the
    // `covered.length === 0` exit, and produced 1,289 of these and ZERO `error TS` lines.
    const out = [
      "fatal: path 'vitest.config.ts' exists on disk, but not in 'origin/main'",
      "fatal: path 'scripts/lib/explicit-files.d.mts' exists on disk, but not in 'origin/main'",
    ].join('\n');

    expect(attributedTypeErrors(out)).toBe(false);
  });

  it('is FALSE for empty output — the gate exited before emitting LINT_TSC_RESULT at all', () => {
    expect(attributedTypeErrors('')).toBe(false);
    expect(attributedTypeErrors()).toBe(false);
  });

  it('is TRUE for a real tsc diagnostic, so genuine stranded sites still gate', () => {
    const out =
      "packages/operator-core/lib/thing.ts(42,7): error TS2741: Property 'headless' is missing.";

    expect(attributedTypeErrors(out)).toBe(true);
  });

  it('stays TRUE when real diagnostics are buried among stale-base fatals', () => {
    // The mixed case is the one that matters: a stale base can co-occur with a genuine
    // regression, and suppressing the finding would be the dangerous direction of this fix.
    const out = [
      "fatal: path 'vitest.config.ts' exists on disk, but not in 'origin/main'",
      "apps/operator/app/x.ts(9,3): error TS2739: Type '{}' is missing the following properties.",
      "fatal: path 'scripts/content-lint-runner.d.mts' exists on disk, but not in 'origin/main'",
    ].join('\n');

    expect(attributedTypeErrors(out)).toBe(true);
  });

  it('does not mistake prose about type errors for a diagnostic', () => {
    // The guard's own advice text says "error" and "silence these" in several places; the
    // predicate must key on the TS#### code, not on the English.
    const out = 'Do NOT make the new field optional just to silence these type errors.';

    expect(attributedTypeErrors(out)).toBe(false);
  });
});

/**
 * EI-18832053511250483 — widening the trigger to EXPORTED SIGNATURE changes.
 *
 * The measured reason this shape, and not an unconditional tsc on test:affected: `--files=`
 * is a post-tsc REPORTING filter, so scoping buys nothing (one file 42s vs whole tree 36s),
 * and ~98.5% of operator-core files carry a zero tsc baseline, so a "only when a baseline-0
 * file is touched" trigger fires on nearly every edit. The affordable pattern is the one
 * already proven here: a cheap AST predicate that gates the expensive precise detector.
 *
 * The motivating first-hand case: an OPTIONAL-parameter change (`source = null`, narrowing
 * the inferred type) stranded call sites, and the required-field predicate cannot see it.
 */
const SIG_BEFORE = `
export function claimNext(owner: string, harness?: string): Promise<Claim> {}
export const formatClaim = (c: Claim, verbose?: boolean): string => '';
export interface ClaimStore {
  read(id: string): Claim;
}
`;

describe('collectExportedSignatures', () => {
  it('collects function declarations, exported arrow consts, and interface methods', () => {
    const sigs = collectExportedSignatures(SIG_BEFORE);

    expect([...sigs.keys()].sort()).toEqual(['ClaimStore.read', 'claimNext', 'formatClaim']);
    expect(sigs.get('claimNext').params).toEqual([
      { name: 'owner', optional: false, rest: false, type: 'string' },
      { name: 'harness', optional: true, rest: false, type: 'string' },
    ]);
    expect(sigs.get('claimNext').ret).toBe('Promise<Claim>');
  });

  it('ignores non-exported callables — they have no cross-file call sites to strand', () => {
    const sigs = collectExportedSignatures('function helper(a: string) {}\nconst f = (b: number) => b;');

    expect(sigs.size).toBe(0);
  });
});

describe('diffSignatureBreaks', () => {
  const reasons = (after: string, before = SIG_BEFORE) =>
    diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason);

  it('flags a new REQUIRED parameter — every existing call site just went stale', () => {
    const after = SIG_BEFORE.replace(
      'claimNext(owner: string, harness?: string)',
      'claimNext(owner: string, harness: string | undefined, force: boolean)',
    );

    expect(reasons(after)).toContain('param-added-required');
  });

  it('flags an optional parameter that became required', () => {
    const after = SIG_BEFORE.replace('harness?: string', 'harness: string');

    expect(reasons(after)).toContain('param-optional-to-required');
  });

  it('flags a removed parameter — TS rejects the extra argument callers still pass', () => {
    const after = SIG_BEFORE.replace('claimNext(owner: string, harness?: string)', 'claimNext(owner: string)');

    expect(reasons(after)).toContain('param-removed');
  });

  it('flags a changed parameter type and a changed return type', () => {
    const after = SIG_BEFORE
      .replace('read(id: string): Claim', 'read(id: ClaimId): Claim')
      .replace('formatClaim = (c: Claim, verbose?: boolean): string', 'formatClaim = (c: Claim, verbose?: boolean): Promise<string>');

    expect(reasons(after)).toContain('param-type-changed');
    expect(reasons(after)).toContain('return-type-changed');
  });

  it('catches the optional-param narrowing that motivated this widening', () => {
    // `source = null` gives the parameter an inferred null-only type; the required-field
    // predicate is blind to it because no interface field changed.
    const before = 'export function record(id: string, source: string | null): void {}';
    const after = 'export function record(id: string, source: null): void {}';

    expect(diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason)).toEqual(['param-type-changed']);
  });

  // ——— The controls. A detector that only ever fires is not a detector. ———

  it('stays SILENT on an added OPTIONAL or REST parameter — both are additive', () => {
    const optional = SIG_BEFORE.replace('claimNext(owner: string, harness?: string)', 'claimNext(owner: string, harness?: string, force?: boolean)');
    const rest = SIG_BEFORE.replace('claimNext(owner: string, harness?: string)', 'claimNext(owner: string, harness?: string, ...rest: string[])');

    expect(reasons(optional)).toEqual([]);
    expect(reasons(rest)).toEqual([]);
  });

  it('stays SILENT on a callable that is NEW in this diff — it has no pre-existing callers', () => {
    const after = `${SIG_BEFORE}\nexport function freshlyAdded(a: string, b: number): void {}\n`;

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT on pure REFORMATTING — whitespace is not a type change', () => {
    const after = SIG_BEFORE.replace(
      'export const formatClaim = (c: Claim, verbose?: boolean): string => \'\';',
      'export const formatClaim = (\n  c: Claim,\n  verbose?: boolean,\n): string => \'\';',
    );

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT on an unrelated body-only edit', () => {
    const after = SIG_BEFORE.replace("=> ''", "=> String(c)");

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT when a non-exported callable changes shape', () => {
    const before = 'function internal(a: string): void {}';
    const after = 'function internal(a: string, b: number): void {}';

    expect(diffSignatureBreaks(before, after)).toEqual([]);
  });
});

/**
 * WI-1324625 item 4 — exported CLASS methods and constructors.
 *
 * The interface walk needed no accessibility filter, because an interface has no
 * inaccessible members. A class typically has several, and they have no cross-file call
 * sites at all: recording them would report a "break" every time someone refactored a
 * class's own internals. That noise, on edits that CANNOT strand a caller, is why the
 * accessibility control below matters more than any of the positive cases.
 */
const CLASS_BEFORE = `
export class ClaimStore {
  constructor(db: Db) {}
  read(id: string): Claim {}
  static open(path: string): ClaimStore {}
  private cache(k: string): void {}
  protected hook(k: string): void {}
  #secret(k: string): void {}
}
class NotExported {
  reachable(a: string): void {}
}
`;

describe('collectExportedSignatures — exported classes', () => {
  it('records public methods, statics and the constructor; skips private, protected and #private', () => {
    const sigs = collectExportedSignatures(CLASS_BEFORE);

    expect([...sigs.keys()].sort()).toEqual(['ClaimStore.constructor', 'ClaimStore.open', 'ClaimStore.read']);
  });
});

describe('diffSignatureBreaks — exported class surface', () => {
  const reasons = (after: string, before = CLASS_BEFORE) =>
    diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason);

  it('flags a constructor that gained a required parameter — every `new` site just broke', () => {
    const after = CLASS_BEFORE.replace('constructor(db: Db) {}', 'constructor(db: Db, log: Log) {}');

    expect(reasons(after)).toEqual(['param-added-required']);
  });

  it('flags a public method removed from an exported class', () => {
    const after = CLASS_BEFORE.replace('  read(id: string): Claim {}\n', '');

    expect(reasons(after)).toEqual(['callable-removed']);
  });

  it('flags a changed static-method parameter type', () => {
    const after = CLASS_BEFORE.replace('static open(path: string)', 'static open(path: URL)');

    expect(reasons(after)).toEqual(['param-type-changed']);
  });

  // ——— The controls. No caller outside this file can reach any of these members. ———

  it('stays SILENT on private, protected and #private member changes', () => {
    for (const after of [
      CLASS_BEFORE.replace('private cache(k: string)', 'private cache(k: string, n: number)'),
      CLASS_BEFORE.replace('protected hook(k: string)', 'protected hook(k: number)'),
      CLASS_BEFORE.replace('#secret(k: string)', '#secret(k: string, extra: boolean)'),
      CLASS_BEFORE.replace('  private cache(k: string): void {}\n', ''),
    ]) {
      expect(reasons(after)).toEqual([]);
    }
  });

  it('stays SILENT when a NON-exported class changes or loses a method', () => {
    const changed = CLASS_BEFORE.replace('reachable(a: string)', 'reachable(a: string, b: number)');
    const removed = CLASS_BEFORE.replace('  reachable(a: string): void {}\n', '');

    expect(reasons(changed)).toEqual([]);
    expect(reasons(removed)).toEqual([]);
  });
});

describe('collectExportedValueNames — the export SURFACE, not the callable map', () => {
  it('collects functions, classes, consts, and named re-export aliases', () => {
    const names = collectExportedValueNames(`
export function a(): void {}
export class B {}
export const c = 1, d = 2;
function e(): void {}
export { e, e as f };
`);

    expect([...names].sort()).toEqual(['B', 'a', 'c', 'd', 'e', 'f']);
  });

  it('ignores non-exported bindings and a bare star re-export', () => {
    // `export * from` carries no local name to strand, and resolving what it forwards needs
    // the module graph — that is WI-1324625 item 5, deliberately not attempted here.
    const names = collectExportedValueNames('const hidden = 1;\nfunction alsoHidden() {}\nexport * from "./other";');

    expect(names.size).toBe(0);
  });
});

/**
 * WI-1324625 item 1 — the break diffSignatureBreaks structurally could not see.
 *
 * The original loop walks the AFTER map, so a symbol present at `before` and absent at
 * `after` was never visited once. That left the LOUDEST member of this class silent:
 * deleting an exported callable strands every caller at once, not merely the ones passing
 * some particular argument.
 *
 * The controls below carry the real design risk. A removal check that reads the signature
 * map alone fires on refactors that strand nobody — a callable re-bound to a non-arrow
 * initializer, or de-inlined behind `export { … }` — and a guard with false blocks gets
 * switched off. Gating on the export SURFACE is what makes those three silent.
 */
describe('diffSignatureBreaks — an exported callable removed entirely', () => {
  const reasons = (after: string, before = SIG_BEFORE) =>
    diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason);

  it('flags a deleted exported function — every call site in every other file just broke', () => {
    const after = SIG_BEFORE.replace('export function claimNext(owner: string, harness?: string): Promise<Claim> {}', '');

    expect(reasons(after)).toEqual(['callable-removed']);
  });

  it('flags a RENAMED export — callers import the old name, which no longer exists', () => {
    const after = SIG_BEFORE.replace('claimNext(owner', 'claimNextV2(owner');

    expect(reasons(after)).toEqual(['callable-removed']);
  });

  it('flags a method dropped from an exported interface', () => {
    const after = SIG_BEFORE.replace('  read(id: string): Claim;\n', '');

    expect(reasons(after)).toEqual(['callable-removed']);
  });

  // ——— The controls. Each of these is a refactor that strands NOBODY. ———

  it('stays SILENT when the callable survives as a non-arrow initializer', () => {
    // `memoize(fn)` is a CallExpression, so collectExportedSignatures cannot read a
    // parameter list off it and drops the name — but callers import exactly what they did.
    const after = SIG_BEFORE.replace(
      "export const formatClaim = (c: Claim, verbose?: boolean): string => '';",
      'export const formatClaim = memoize(rawFormatClaim);',
    );

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT when a declaration is de-inlined to `function f(){}` + `export { f }`', () => {
    const after = SIG_BEFORE.replace(
      'export function claimNext(owner: string, harness?: string): Promise<Claim> {}',
      'function claimNext(owner: string, harness?: string): Promise<Claim> {}\nexport { claimNext };',
    );

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT when the export is re-aliased back to the name callers already use', () => {
    const after = SIG_BEFORE.replace(
      'export function claimNext(owner: string, harness?: string): Promise<Claim> {}',
      'function claimNextImpl(owner: string, harness?: string): Promise<Claim> {}\nexport { claimNextImpl as claimNext };',
    );

    expect(reasons(after)).toEqual([]);
  });

  it('stays SILENT when a NON-exported callable is deleted — it had no cross-file callers', () => {
    const before = 'function internal(a: string): void {}\nexport function kept(b: number): void {}';
    const after = 'export function kept(b: number): void {}';

    expect(diffSignatureBreaks(before, after)).toEqual([]);
  });

  /**
   * FALSIFIABILITY, kept permanently instead of proved once by a mutation probe.
   *
   * The pre-WI-1324625 predicate was a single `for (const [name, now] of after)` walk, so
   * the ONLY symbols it could ever name were symbols present in the after-map. The two
   * assertions below turn that into a standing structural check against the real code —
   * no replica of the old function to drift, and no in-tree mutation.
   *
   * The second test is the one that gives the first its meaning. "The reported symbol is
   * absent from the after-map" would be worthless if it were true of every finding this
   * guard emits; the calibration shows an ordinary param-removed finding naming a symbol
   * that IS in the after-map, so the property genuinely discriminates. Without it these
   * controls would pass even if the property itself were broken.
   */
  it('reports symbols ABSENT from the after-map — structurally unreachable by the old walk', () => {
    for (const after of [
      SIG_BEFORE.replace('export function claimNext(owner: string, harness?: string): Promise<Claim> {}', ''),
      SIG_BEFORE.replace('claimNext(owner', 'claimNextV2(owner'),
      SIG_BEFORE.replace('  read(id: string): Claim;\n', ''),
    ]) {
      const found = diffSignatureBreaks(SIG_BEFORE, after) as { path: string; reason: string }[];
      const afterMap = collectExportedSignatures(after);

      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe('callable-removed');
      // `path` is rendered as `name()`; the symbol is everything before the parens.
      expect(afterMap.has(found[0].path.replace(/\(\)$/, ''))).toBe(false);
    }
  });

  it('CALIBRATION: an ordinary signature finding DOES name a symbol in the after-map', () => {
    const after = SIG_BEFORE.replace('claimNext(owner: string, harness?: string)', 'claimNext(owner: string)');
    const found = diffSignatureBreaks(SIG_BEFORE, after) as { path: string; reason: string }[];
    const afterMap = collectExportedSignatures(after);

    expect(found.map((f) => f.reason)).toEqual(['param-removed']);
    expect(afterMap.has(found[0].path.replace(/\(\)$/, ''))).toBe(true);
  });
});

/**
 * WI-1332206 item 3 — OVERLOAD SETS.
 *
 * An overload set publishes its body-less declarations and HIDES the implementation:
 * TypeScript does not let a caller call the implementation signature at all. Keying every
 * declaration by bare name left the implementation as the last writer, so the collector
 * recorded a signature no caller can see — and that failed BOTH ways. Deleting or narrowing an
 * overload reported nothing; widening the implementation reported a break that stranded nobody.
 *
 * The silence control on the implementation-only edit is the one that matters most here. The
 * measured false-positive direction is what gets a guard switched off, and it is the half a
 * positive-case-only suite would never notice.
 */
const OVERLOAD_BEFORE = `
export function parse(raw: string): Claim;
export function parse(raw: string, strict: boolean): Claim;
export function parse(raw: string, strict?: boolean): Claim {}
`;

describe('collectExportedSignatures — overload sets', () => {
  it('records the body-less overloads by name+ARITY and ignores the implementation', () => {
    const sigs = collectExportedSignatures(OVERLOAD_BEFORE);

    expect([...sigs.keys()].sort()).toEqual(['parse/1', 'parse/2']);
    // The implementation's `strict?: boolean` never reaches the map: parse/2's second
    // parameter is the OVERLOAD's required one, which is what callers actually face.
    expect(sigs.get('parse/2').params[1]).toEqual({ name: 'strict', optional: false, rest: false, type: 'boolean' });
  });

  it('leaves a lone ambient declaration on its bare-name key — one declaration is not a set', () => {
    const sigs = collectExportedSignatures('export declare function solo(a: string): void;');

    expect([...sigs.keys()]).toEqual(['solo']);
  });

  it('KNOWN LIMIT: same-arity overloads still collide on one key, last declaration winning', () => {
    // Strictly narrower than the collision it replaces — which lost the whole set to the
    // implementation — but it does bound what a clean run proves, so it is pinned, not hidden.
    const sigs = collectExportedSignatures(`
export function f(a: string): string;
export function f(a: number): number;
export function f(a: any): any {}
`);

    expect([...sigs.keys()]).toEqual(['f/1']);
    expect(sigs.get('f/1').params[0].type).toBe('number');
  });
});

describe('diffSignatureBreaks — overload sets', () => {
  const reasons = (after: string, before = OVERLOAD_BEFORE) =>
    diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason);

  it('flags an overload DELETED from the set — those callers have no matching signature left', () => {
    const after = OVERLOAD_BEFORE.replace('export function parse(raw: string, strict: boolean): Claim;\n', '');

    // Named `overload-removed`, NOT `callable-removed`: `parse` is still exported, and calling
    // the loss of one arity a removed callable would send the reader hunting for a deleted
    // function that is still right there.
    expect(diffSignatureBreaks(OVERLOAD_BEFORE, after)).toEqual([{ path: 'parse/2()', reason: 'overload-removed' }]);
  });

  it("the filed MEASURED case: deleting a same-arity overload now reports, where the implementation-keyed map returned []", () => {
    const before = `
export function f(a: string): string;
export function f(a: number): number;
export function f(a: any): any {}
`;
    const after = `
export function f(a: string): string;
export function f(a: any): any {}
`;

    expect(diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason)).toEqual([
      'param-type-changed',
      'return-type-changed',
    ]);
  });

  it('flags a NARROWED overload — invisible while the implementation was the recorded signature', () => {
    const after = OVERLOAD_BEFORE.replace(
      'parse(raw: string, strict: boolean): Claim;',
      'parse(raw: ClaimId, strict: boolean): Claim;',
    );

    expect(reasons(after)).toEqual(['param-type-changed']);
  });

  it('reports callable-removed when the whole set leaves the export surface', () => {
    expect(reasons('export function other(a: string): void {}')).toEqual(['callable-removed', 'callable-removed']);
  });

  // ——— The controls. The first is the false-positive direction that motivated the fix. ———

  it('stays SILENT when only the IMPLEMENTATION signature widens — no caller can call it', () => {
    const after = OVERLOAD_BEFORE.replace(
      'export function parse(raw: string, strict?: boolean): Claim {}',
      'export function parse(raw: unknown, strict?: unknown): unknown {}',
    );

    expect(diffSignatureBreaks(OVERLOAD_BEFORE, after)).toEqual([]);
  });

  it('stays SILENT on REORDERED overloads — arity keys, so ordering is a no-op refactor', () => {
    const reordered = `
export function parse(raw: string, strict: boolean): Claim;
export function parse(raw: string): Claim;
export function parse(raw: string, strict?: boolean): Claim {}
`;

    expect(diffSignatureBreaks(OVERLOAD_BEFORE, reordered)).toEqual([]);
  });

  it('KNOWN LIMIT: a plain callable GAINING an overload set is silent, though it can narrow', () => {
    // The name survives on the export surface, so the removal walk suppresses it exactly as it
    // suppresses every other refactor that keeps the name. Pinned so the silence is a recorded
    // decision rather than something a later reader has to rediscover.
    expect(diffSignatureBreaks('export function parse(raw: string): Claim {}', OVERLOAD_BEFORE)).toEqual([]);
  });

  /**
   * FALSIFIABILITY, kept permanently rather than proved once by a mutation probe — the same
   * choice made for WI-1324625 above, and the tier the repo prescribes for a module this suite
   * IMPORTS: no in-tree mutation, no sweep race, and nothing that can be skipped later.
   *
   * The pre-fix collector keyed every declaration by bare NAME, so the implementation — the last
   * declaration — was the one that survived. Both halves of that are asserted gone, and the
   * calibration is what gives them meaning: without it, a collector that recorded NOTHING at all
   * would satisfy the property just as well.
   */
  it('never records the IMPLEMENTATION signature of an overload set', () => {
    const sigs = collectExportedSignatures(OVERLOAD_BEFORE);

    expect(sigs.has('parse')).toBe(false);
    // The implementation is the only declaration whose `strict` is optional; the overload's is
    // required. Its absence is what proves the implementation never reached the map.
    expect(
      [...sigs.values()].some((s: { params: { name: string; optional: boolean }[] }) =>
        s.params.some((p) => p.name === 'strict' && p.optional),
      ),
    ).toBe(false);
  });

  it('CALIBRATION: a NON-overloaded function IS recorded under its bare name, from its implementation', () => {
    const sigs = collectExportedSignatures('export function parse(raw: string, strict?: boolean): Claim {}');

    expect(sigs.has('parse')).toBe(true);
    expect(
      sigs.get('parse').params.some((p: { name: string; optional: boolean }) => p.name === 'strict' && p.optional),
    ).toBe(true);
  });
});

/**
 * WI-1332206 item 2 — GENERIC TYPE PARAMETERS.
 *
 * Arity strands explicit `pick<A>()` type-argument sites; a tightened constraint strands the
 * inference sites. Neither touches a value parameter or the return type, so both were invisible
 * to a collector that read only `parameters` and the return annotation.
 *
 * Compared POSITIONALLY, because that is how TypeScript resolves type arguments — which makes a
 * rename a no-op. See the KNOWN LIMIT at the end: this block is rename-blind, but the older
 * value-parameter comparison is not (EI-21909944792089774).
 */
const GENERIC_BEFORE = 'export function pick<T>(items: T[], n: number): T {}';

describe('diffSignatureBreaks — generic type parameters', () => {
  const reasons = (after: string, before = GENERIC_BEFORE) =>
    diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason);

  it('flags a type parameter added WITHOUT a default — every explicit `pick<A>()` site broke', () => {
    expect(reasons('export function pick<T, K>(items: T[], n: number): T {}')).toEqual(['type-param-added-required']);
  });

  it('flags a REMOVED type parameter — TS rejects the extra type argument callers still pass', () => {
    const before = 'export function pick<T, K>(items: T[], n: number): T {}';

    expect(reasons('export function pick<T>(items: T[], n: number): T {}', before)).toEqual(['type-param-removed']);
  });

  it('flags a TIGHTENED constraint — the inference sites that no longer satisfy it', () => {
    expect(reasons('export function pick<T extends object>(items: T[], n: number): T {}')).toEqual([
      'type-param-constraint-changed',
    ]);
  });

  it('flags a type parameter that LOST its default — the sites that omitted the argument', () => {
    const before = 'export function pick<T = string>(items: T[], n: number): T {}';

    expect(reasons('export function pick<T>(items: T[], n: number): T {}', before)).toEqual([
      'type-param-default-removed',
    ]);
  });

  // ——— The controls. ———

  it('stays SILENT on a type parameter added WITH a default — `pick<A>()` still resolves', () => {
    expect(reasons('export function pick<T, K = string>(items: T[], n: number): T {}')).toEqual([]);
  });

  it('stays SILENT on constraint REFORMATTING — whitespace is not a constraint change', () => {
    const before = 'export function pick<T extends { id: string }>(items: T[], n: number): T {}';
    const after = 'export function pick<T extends {\n  id: string\n}>(items: T[], n: number): T {}';

    expect(reasons(after, before)).toEqual([]);
  });

  it('stays SILENT when a type parameter is renamed — references are alpha-normalised positionally', () => {
    expect(reasons('export function pick<U>(items: U[], n: number): U {}')).toEqual([]);
  });

  it('stays SILENT when an enclosing interface generic is renamed in a method signature', () => {
    const before = 'export interface Box<T> { get(value: T): T; }';
    const after = 'export interface Box<U> { get(value: U): U; }';

    expect(diffSignatureBreaks(before, after)).toEqual([]);
  });

  it('stays SILENT when an enclosing class generic is renamed in a method and constructor', () => {
    const before = `
      export class Box<T> {
        constructor(value: T) {}
        get(value: T): T { return value; }
      }
    `;
    const after = `
      export class Box<U> {
        constructor(value: U) {}
        get(value: U): U { return value; }
      }
    `;

    expect(diffSignatureBreaks(before, after)).toEqual([]);
  });

  /**
   * FALSIFIABILITY for the generic half, on the same permanent-control tier.
   *
   * `n: number` and the `void` return mention T NOWHERE, so no comparison of value-parameter or
   * return-type TEXT can reach this change — the finding is only possible if typeParams are
   * genuinely recorded and compared. The calibration then shows the same shape still producing
   * an ordinary param finding, which is what rules out a diff that simply fires on everything.
   */
  it('detects a constraint change on a type parameter NO value parameter mentions', () => {
    const before = 'export function tag<T>(n: number): void {}';
    const after = 'export function tag<T extends object>(n: number): void {}';

    expect(diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason)).toEqual([
      'type-param-constraint-changed',
    ]);
  });

  it('CALIBRATION: that same shape reports a PARAM reason, and no type-param reason, when only a value parameter moves', () => {
    const before = 'export function tag<T>(n: number): void {}';
    const after = 'export function tag<T>(n: string): void {}';

    expect(diffSignatureBreaks(before, after).map((b: { reason: string }) => b.reason)).toEqual(['param-type-changed']);
  });
});

/**
 * EI-20417688643232882 — the union-widening trap. `GitSyncFailingLeg` gained a `'config-lock'`
 * member; a consumer (`DeployHealth.gitSyncFailingLeg`) had RE-LISTED the literals instead of
 * referencing the type, so the strand surfaced as a TS2322 in a THIRD file and red-pinned the
 * fleet-wide gate. Nothing failed at the edit site, which is exactly why a trigger is needed.
 */
describe('collectExportedUnionMembers', () => {
  it('collects an exported type-alias union, and a union on an exported property, under one dotted vocabulary', () => {
    const src = `
export type Leg = 'commit' | 'push';
export interface DeployHealth {
  leg: 'commit' | 'push' | null;
  nested: { inner: 'a' | 'b' };
}
`;
    const unions = collectExportedUnionMembers(src) as Map<string, Set<string>>;
    expect([...(unions.get('Leg') ?? [])]).toEqual(["'commit'", "'push'"]);
    expect([...(unions.get('DeployHealth.leg') ?? [])]).toEqual(["'commit'", "'push'", 'null']);
    expect([...(unions.get('DeployHealth.nested.inner') ?? [])]).toEqual(["'a'", "'b'"]);
  });

  it('ignores a NON-exported union — a private type has no cross-file consumers to strand', () => {
    const unions = collectExportedUnionMembers("type Leg = 'commit' | 'push';") as Map<string, Set<string>>;
    expect(unions.has('Leg')).toBe(false);
  });
});

describe('diffUnionWidenings', () => {
  const LEG_BEFORE = "export type GitSyncFailingLeg = 'commit' | 'push' | 'conflict' | 'unknown';";
  const LEG_AFTER = "export type GitSyncFailingLeg = 'commit' | 'push' | 'conflict' | 'config-lock' | 'unknown';";

  it('THE MOTIVATING CASE: a member added to an exported union reports union-member-added, naming the new member', () => {
    const found = diffUnionWidenings(LEG_BEFORE, LEG_AFTER) as { path: string; reason: string }[];
    expect(found).toEqual([{ path: "GitSyncFailingLeg + 'config-lock'", reason: 'union-member-added' }]);
  });

  it('reports the reverse direction too — narrowing strands every PRODUCER still passing the dropped member', () => {
    const found = diffUnionWidenings(LEG_AFTER, LEG_BEFORE) as { path: string; reason: string }[];
    expect(found).toEqual([{ path: "GitSyncFailingLeg - 'config-lock'", reason: 'union-member-removed' }]);
  });

  it('catches the classic nullable widening, where neither side is written as a multi-member union', () => {
    const before = 'export interface DeployHealth { leg: string; }';
    const after = 'export interface DeployHealth { leg: string | null; }';
    expect((diffUnionWidenings(before, after) as { path: string; reason: string }[])).toEqual([
      { path: 'DeployHealth.leg + null', reason: 'union-member-added' },
    ]);
  });

  it('catches a union NESTED one level down — the depth the required-field trap also lived at', () => {
    const before = "export interface Health { git: { leg: 'commit' | 'push' } }";
    const after = "export interface Health { git: { leg: 'commit' | 'push' | 'conflict' } }";
    expect((diffUnionWidenings(before, after) as { reason: string }[]).map((f) => f.reason)).toEqual([
      'union-member-added',
    ]);
  });

  it('CALIBRATION: a REFORMAT or a REORDER is not a change — an advisory that fires on prettier gets tuned out', () => {
    const reformatted = "export type GitSyncFailingLeg =\n  | 'commit'\n  | 'push'\n  | 'conflict'\n  | 'unknown';";
    const reordered = "export type GitSyncFailingLeg = 'unknown' | 'conflict' | 'push' | 'commit';";
    expect(diffUnionWidenings(LEG_BEFORE, reformatted)).toEqual([]);
    expect(diffUnionWidenings(LEG_BEFORE, reordered)).toEqual([]);
  });

  it('CALIBRATION: a MIXED add-and-remove (a rename) is out of scope — only a strict superset/subset is unambiguous', () => {
    const renamed = "export type GitSyncFailingLeg = 'commit' | 'push' | 'conflict' | 'other';";
    expect(diffUnionWidenings(LEG_BEFORE, renamed)).toEqual([]);
  });

  it('CALIBRATION: a union on a type NEW in this diff strands nothing by construction and must stay silent', () => {
    const before = 'export type Existing = string;';
    const after = `${before}\nexport type Fresh = 'a' | 'b';`;
    expect(diffUnionWidenings(before, after)).toEqual([]);
  });
});

describe('strandHeadline — the class is derived by COMPLEMENT, so an unlisted reason misclassifies SILENTLY', () => {
  it('names each class on its own', () => {
    expect((strandHeadline(['added-required']) as { headline: string }).headline).toBe(
      'REQUIRED-FIELD ADDITION detected on an exported type.',
    );
    expect((strandHeadline(['param-removed']) as { headline: string }).headline).toBe(
      'EXPORTED-SIGNATURE CHANGE detected on a public callable.',
    );
    expect((strandHeadline(['union-member-added']) as { headline: string }).headline).toBe(
      'EXPORTED-UNION CHANGE detected on an exported type.',
    );
  });

  it('a union reason is classified as UNION, never as the field default — the wrong-headline failure', () => {
    for (const reason of ['union-member-added', 'union-member-removed']) {
      const c = strandHeadline([reason]) as { hasField: boolean; hasUnion: boolean };
      expect(c.hasUnion).toBe(true);
      expect(c.hasField).toBe(false);
    }
  });

  it('joins every class actually present, so a mixed run never hides one behind another', () => {
    expect((strandHeadline(['added-required', 'param-removed', 'union-member-added']) as { headline: string }).headline)
      .toBe('REQUIRED-FIELD ADDITION and EXPORTED-SIGNATURE CHANGE and EXPORTED-UNION CHANGE detected.');
  });

  it('CALIBRATION: an UNKNOWN reason still falls back to the field class, so a future omission is loud in this test, not silent in a run', () => {
    const c = strandHeadline(['some-reason-nobody-classified']) as { hasField: boolean; hasUnion: boolean; hasSig: boolean };
    expect([c.hasField, c.hasSig, c.hasUnion]).toEqual([true, false, false]);
  });
});
