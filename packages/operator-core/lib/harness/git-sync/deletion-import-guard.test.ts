/**
 * The git-sync DELETION-IMPORT guard (EI-17).
 *
 * Seam-injected cases plus real-Git regression coverage. Pins the
 * load-bearing behavior: a dirty deletion whose module a surviving file still
 * (relatively) imports is flagged (so `commitOneRepo` excludes it from the
 * commit, exactly like an oversized blob or a broken .mdx); an unrelated
 * same-named file elsewhere, a test-file deletion, a consistent two-sided
 * deletion, and any `git`/read failure are all NOT flagged (fail open).
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectUnsafeDeletions,
  parseDeletedPaths,
  isCheckedModuleDeletion,
  normalizeModulePath,
  extractRelativeImportSpecifiers,
  resolveRelativeSpecifier,
  candidateSearchTokens,
} from './deletion-import-guard';
import type { RunGit } from './run-git-sync';

/** A runGit stub: `status` answers the given NUL-joined porcelain entries; `grep -l`
 *  answers with the file list registered for that fixed-string token (simulating
 *  Git's explicit -e pattern or positional -F pattern); anything else is a benign no-op. */
const makeRunGit = (opts: {
  statusEntries: string[];
  grepHits?: Record<string, string[]>;
  grepCode?: (token: string) => number;
  statusCode?: number;
}): RunGit => {
  const { statusEntries, grepHits = {}, grepCode, statusCode = 0 } = opts;
  return async (args) => {
    if (args[0] === 'status') {
      return statusCode === 0
        ? { code: 0, stdout: statusEntries.join('\0') + (statusEntries.length ? '\0' : ''), stderr: '' }
        : { code: statusCode, stdout: '', stderr: 'fatal' };
    }
    if (args[0] === 'grep') {
      const patternIdx = args.includes('-e') ? args.indexOf('-e') : args.indexOf('-F');
      const token = args[patternIdx + 1];
      const code = grepCode ? grepCode(token) : token in grepHits ? 0 : 1;
      const hits = grepHits[token] ?? [];
      const stdout = hits.length ? hits.join('\0') + '\0' : '';
      return { code, stdout, stderr: code > 1 ? 'fatal grep error' : '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
};

describe('parseDeletedPaths', () => {
  it('extracts ONLY deletions (the mirror image of content-guard.parseDirtyPaths)', () => {
    const z = [' M src/a.ts', '?? docs/x.mdx', ' D gone.ts', 'D  staged-gone.ts', 'R  new.ts\0old.ts'].join('\0') + '\0';
    expect(parseDeletedPaths(z)).toEqual(['gone.ts', 'staged-gone.ts']);
  });

  it('returns [] for an empty porcelain output', () => {
    expect(parseDeletedPaths('')).toEqual([]);
  });
});

describe('isCheckedModuleDeletion', () => {
  it('accepts resolvable source extensions, rejects tests/.d.ts/excluded trees', () => {
    expect(isCheckedModuleDeletion('lib/foo.ts')).toBe(true);
    expect(isCheckedModuleDeletion('lib/foo.tsx')).toBe(true);
    expect(isCheckedModuleDeletion('lib/foo.d.ts')).toBe(false);
    expect(isCheckedModuleDeletion('lib/foo.test.ts')).toBe(false);
    expect(isCheckedModuleDeletion('lib/foo.spec.tsx')).toBe(false);
    expect(isCheckedModuleDeletion('lib/foo.md')).toBe(false);
    expect(isCheckedModuleDeletion('apps/foo/node_modules/pkg/foo.ts')).toBe(false);
    expect(isCheckedModuleDeletion('_retired/foo.ts')).toBe(false);
    expect(isCheckedModuleDeletion('apps/operator/dist/foo.js')).toBe(false);
  });
});

describe('normalizeModulePath', () => {
  it('strips a resolvable extension and collapses a trailing /index', () => {
    expect(normalizeModulePath('lib/foo.ts')).toBe('lib/foo');
    expect(normalizeModulePath('lib/foo/index.ts')).toBe('lib/foo');
    expect(normalizeModulePath('lib/foo/index.tsx')).toBe('lib/foo');
    expect(normalizeModulePath('lib/foo')).toBe('lib/foo');
  });
});

describe('extractRelativeImportSpecifiers', () => {
  it('extracts from/import/require specifiers, relative only, deduped', () => {
    const text = [
      `import x from './operator-last-scan';`,
      `import { y } from "../lib/other";`,
      `const z = require('./operator-last-scan');`,
      `import pkg from '@papercusp/foo';`, // bare — excluded
      `export * from './operator-last-scan';`, // dup, deduped
    ].join('\n');
    expect(extractRelativeImportSpecifiers(text).sort()).toEqual(['../lib/other', './operator-last-scan']);
  });

  it('returns [] when there are no relative specifiers', () => {
    expect(extractRelativeImportSpecifiers(`import x from '@papercusp/foo';`)).toEqual([]);
  });
});

describe('resolveRelativeSpecifier', () => {
  it('resolves against the importing file’s own directory, extension + /index aware', () => {
    expect(resolveRelativeSpecifier('apps/operator/lib/scan-caller.ts', './operator-last-scan')).toBe(
      'apps/operator/lib/operator-last-scan',
    );
    expect(resolveRelativeSpecifier('apps/operator/lib/a/b.ts', '../foo')).toBe('apps/operator/lib/foo');
    // directory-style import resolving to an index file
    expect(resolveRelativeSpecifier('apps/operator/lib/a/b.ts', '../foo/index')).toBe('apps/operator/lib/foo');
  });
});

describe('candidateSearchTokens', () => {
  it('uses the bare basename for a specific name', () => {
    expect(candidateSearchTokens('apps/operator/lib/operator-last-scan.ts')).toEqual(['operator-last-scan']);
  });

  it('narrows a generic basename to parentDir/basename', () => {
    expect(candidateSearchTokens('apps/operator/lib/utils.ts')).toEqual(['lib/utils']);
  });

  it('searches the parent dir name (not "index") for a deleted index file', () => {
    expect(candidateSearchTokens('apps/operator/lib/foo/index.ts')).toEqual(['foo']);
  });
});

describe('detectUnsafeDeletions', () => {
  it.each(['target', '-target'])('finds tracked and untracked live importers using real Git (%s)', async (name) => {
    const repoPath = mkdtempSync(join(tmpdir(), 'deletion-import-guard-'));
    const git = (args: string[]) => spawnSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid', ...args,
    ], { cwd: repoPath, encoding: 'utf8' });
    try {
      expect(git(['init', '--quiet']).status).toBe(0);
      writeFileSync(join(repoPath, `${name}.ts`), 'export const value = 1;\n');
      const importer = `import { value } from './${name}';\n`;
      writeFileSync(join(repoPath, 'tracked.ts'), importer);
      expect(git(['add', '--', `${name}.ts`, 'tracked.ts']).status).toBe(0);
      expect(git(['commit', '--quiet', '-m', 'fixture']).status).toBe(0);
      unlinkSync(join(repoPath, `${name}.ts`));
      writeFileSync(join(repoPath, 'untracked.ts'), importer);
      const log = vi.fn();
      const offenders = await detectUnsafeDeletions({
        repoPath,
        runGit: async (args) => {
          const result = git(args);
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
        readText: async (path) => readFileSync(join(repoPath, path), 'utf8'),
        log,
      });
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toMatchObject({ file: `${name}.ts`, detectorKey: 'unsafe-deletion' });
      expect(offenders[0].error).toContain('tracked.ts');
      expect(offenders[0].error).toContain('untracked.ts');
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('git grep errored'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('flags a deletion whose module a surviving file still imports (relative)', async () => {
    const runGit = makeRunGit({
      statusEntries: [' D apps/operator/lib/operator-last-scan.ts'],
      grepHits: { 'operator-last-scan': ['apps/operator/lib/scan-caller.ts'] },
    });
    const offenders = await detectUnsafeDeletions({
      runGit,
      repoPath: '/repo',
      readText: async (rel) =>
        rel === 'apps/operator/lib/scan-caller.ts' ? `import x from './operator-last-scan';` : null,
    });
    expect(offenders).toEqual([
      {
        file: 'apps/operator/lib/operator-last-scan.ts',
        detectorKey: 'unsafe-deletion',
        error: expect.stringContaining('apps/operator/lib/scan-caller.ts'),
        fixerRole: 'content-fixer',
      },
    ]);
  });

  it('does NOT flag when a same-named file elsewhere does not actually resolve to the deleted one (no false positive)', async () => {
    const runGit = makeRunGit({
      statusEntries: [' D apps/operator/lib/operator-last-scan.ts'],
      // git grep found a candidate purely by substring, but it imports a DIFFERENT dir's copy.
      grepHits: { 'operator-last-scan': ['apps/other/lib/caller.ts'] },
    });
    const offenders = await detectUnsafeDeletions({
      runGit,
      repoPath: '/repo',
      readText: async (rel) =>
        rel === 'apps/other/lib/caller.ts' ? `import x from '../other-dir/operator-last-scan';` : null,
    });
    expect(offenders).toEqual([]);
  });

  it('does NOT flag when no dirty deletions exist', async () => {
    const runGit = makeRunGit({ statusEntries: [' M apps/operator/lib/foo.ts'] });
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text' });
    expect(offenders).toEqual([]);
  });

  it('does NOT flag a deletion with no importing candidates at all', async () => {
    const runGit = makeRunGit({ statusEntries: [' D apps/operator/lib/orphan.ts'], grepHits: {} });
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text' });
    expect(offenders).toEqual([]);
  });

  it('skips a test-file deletion entirely (never even greps)', async () => {
    const runGit = vi.fn(async (args: string[]) =>
      args[0] === 'status'
        ? { code: 0, stdout: ' D apps/operator/lib/foo.test.ts\0', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text' });
    expect(offenders).toEqual([]);
    expect(runGit).not.toHaveBeenCalledWith(expect.arrayContaining(['grep']), expect.anything());
  });

  it('does NOT flag a CONSISTENT two-sided deletion (the importer is also deleted this commit)', async () => {
    const runGit = makeRunGit({
      statusEntries: [' D apps/operator/lib/operator-last-scan.ts', ' D apps/operator/lib/scan-caller.ts'],
      grepHits: { 'operator-last-scan': ['apps/operator/lib/scan-caller.ts'] },
    });
    const offenders = await detectUnsafeDeletions({
      runGit,
      repoPath: '/repo',
      readText: async () => `import x from './operator-last-scan';`,
    });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN when `git status` errors', async () => {
    const runGit = makeRunGit({ statusEntries: [], statusCode: 1 });
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text' });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN when `git grep` errors (code > 1), logging and skipping — never blocking', async () => {
    const log = vi.fn();
    const runGit = makeRunGit({
      statusEntries: [' D apps/operator/lib/operator-last-scan.ts'],
      grepCode: () => 128,
    });
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text', log });
    expect(offenders).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('git grep errored'));
  });

  it('treats `git grep` exit code 1 (no matches) as a normal empty result, not an error', async () => {
    const log = vi.fn();
    const runGit = makeRunGit({ statusEntries: [' D apps/operator/lib/operator-last-scan.ts'], grepHits: {} });
    const offenders = await detectUnsafeDeletions({ runGit, repoPath: '/repo', readText: async () => 'text', log });
    expect(offenders).toEqual([]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('errored'));
  });

  it('a read failure on a candidate is skipped, not an offender (fail open)', async () => {
    const runGit = makeRunGit({
      statusEntries: [' D apps/operator/lib/operator-last-scan.ts'],
      grepHits: { 'operator-last-scan': ['apps/operator/lib/scan-caller.ts'] },
    });
    const offenders = await detectUnsafeDeletions({
      runGit,
      repoPath: '/repo',
      readText: async () => {
        throw new Error('boom');
      },
    });
    expect(offenders).toEqual([]);
  });
});
