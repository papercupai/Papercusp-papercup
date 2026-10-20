/**
 * WI-10006734 — a git-sync commit must not record an importer whose relative import target is
 * an UNTRACKED module that the commit does not contain.
 *
 * MEASURED 2026-10-06: commit 84959c3039 (13:46:29Z) recorded
 * `packages/operator-core/lib/sync-resolver/index.ts`, whose new dynamic
 * `import('../integrations/ticket-integrations')` named a module that stayed untracked until
 * b3a92f4111 (14:25:27Z). Every isolated staging bundle in between failed (WI-10006704). The
 * post-stage guard only held importers of EXCLUDED paths, and an untracked module that nobody
 * excluded was outside that set, so its importer passed.
 *
 * These tests drive real git repositories: the defect is the gap between the working tree
 * (the module is there) and the index the commit records (it is not), which a scripted
 * `runGit` cannot reproduce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileAttribution } from './git-sync-attribution';
import { commitAttributedGroups, guardStagedIndexBeforeCommit, type RunGit } from './run-git-sync';

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

/** A real git runner that forwards `options.env` (the private index), as production runners do. */
const runGit: RunGit = (args, cwd, options) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...options?.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

async function stagedPaths(repo: string): Promise<string[]> {
  return (await git(repo, 'diff', '--cached', '--name-only', '--no-renames')).split('\n').filter(Boolean).sort();
}

const MSG = 'chore(git-sync): auto-commit papercup [skip ci]';
let repo: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const readText = async (rel: string): Promise<string | null> => {
  try {
    return readFileSync(join(repo, rel), 'utf8');
  } catch {
    return null;
  }
};

function guard(indexRunGit: RunGit = runGit) {
  return guardStagedIndexBeforeCommit({ runGit: indexRunGit, repoPath: repo, scope: 'test', readText, log });
}

beforeEach(async () => {
  logs.length = 0;
  repo = mkdtempSync(join(tmpdir(), 'wi10006734-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, '.gitignore', 'lib/generated/\n');
  write(repo, 'lib/base.ts', 'export const base = 0;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'seed');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** The measured shape: a staged importer gains a dynamic import of a still-untracked module. */
function seedUntrackedProvider(): void {
  write(
    repo,
    'lib/sync-resolver/index.ts',
    "export async function load() {\n  return import('../integrations/ticket-integrations');\n}\n",
  );
  write(repo, 'lib/integrations/ticket-integrations.ts', 'export const tickets = 1;\n');
}

describe('WI-10006734: importers of untracked modules absent from the commit', () => {
  it('holds a staged importer whose dynamic-import target is untracked (the 84959c3039 shape)', async () => {
    seedUntrackedProvider();
    await git(repo, 'add', '--', 'lib/sync-resolver/index.ts');
    expect(await stagedPaths(repo)).toEqual(['lib/sync-resolver/index.ts']);

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: ['lib/sync-resolver/index.ts'] });
    expect(await stagedPaths(repo)).toEqual([]);
    // The working tree is untouched: both files stay dirty for a later commit that carries both.
    expect(await git(repo, 'status', '--porcelain', '-uall')).toBe(
      '?? lib/integrations/ticket-integrations.ts\n?? lib/sync-resolver/index.ts',
    );
    expect(logs.join('\n')).toContain('lib/integrations/ticket-integrations.ts');
  });

  it('lets the importer commit when the module is staged with it', async () => {
    seedUntrackedProvider();
    await git(repo, 'add', '-A');

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] });
    expect(await stagedPaths(repo)).toEqual(['lib/integrations/ticket-integrations.ts', 'lib/sync-resolver/index.ts']);
  });

  it('does not hold an importer of a gitignored module (generated at build time, never committed)', async () => {
    write(repo, 'lib/consumer.ts', "import { schema } from './generated/schema';\nexport const c = schema;\n");
    write(repo, 'lib/generated/schema.ts', 'export const schema = 1;\n');
    await git(repo, 'add', '--', 'lib/consumer.ts');

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] });
    expect(await stagedPaths(repo)).toEqual(['lib/consumer.ts']);
  });

  it('does not hold an importer when another indexed file still provides the module path (x.js tracked, x.ts untracked)', async () => {
    write(repo, 'lib/thing-module.js', 'export const thing = 1;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'thing.js');
    write(repo, 'lib/thing-module.ts', 'export const thing = 2;\n');
    write(repo, 'lib/consumer.ts', "import { thing } from './thing-module';\nexport const c = thing;\n");
    await git(repo, 'add', '--', 'lib/consumer.ts');

    const result = await guard();

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] });
    expect(await stagedPaths(repo)).toEqual(['lib/consumer.ts']);
  });

  it('runs to a fixed point: a staged file importing a held importer is held too', async () => {
    write(repo, 'lib/entry.ts', "import './mid-module';\n");
    write(repo, 'lib/mid-module.ts', "import './leaf-module';\nexport const mid = 1;\n");
    write(repo, 'lib/leaf-module.ts', 'export const leaf = 1;\n');
    await git(repo, 'add', '--', 'lib/entry.ts', 'lib/mid-module.ts');

    const result = await guard();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.unstaged].sort()).toEqual(['lib/entry.ts', 'lib/mid-module.ts']);
    expect(await stagedPaths(repo)).toEqual([]);
  });

  it('checks the PRIVATE index an attributed group commits: the importer stays out of that commit (real git)', async () => {
    seedUntrackedProvider();
    write(repo, 'lib/a.ts', 'export const a = 1;\n');
    // ag1 owns the importer; nobody has attributed the provider, so it stays untracked
    // while ag1's group commits — exactly the window 84959c3039 committed into.
    const attribution = new Map<string, FileAttribution>([
      ['lib/a.ts', { agent: 'ag1', intent: 'work' }],
      ['lib/sync-resolver/index.ts', { agent: 'ag1', intent: 'work' }],
    ]);

    // The unattributed provider would otherwise commit first as the anonymous residual
    // (0eacc351a9). Held out of this tick, it stays untracked while ag1's group commits.
    const res = await commitAttributedGroups(runGit, repo, attribution, ['lib/integrations/ticket-integrations.ts'], MSG, {
      beforeCommit: (privateRunGit) => guard(privateRunGit),
      log,
    });

    expect(res).toEqual({ committedAny: true, committedCount: 1, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('lib/a.ts');
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'lib/sync-resolver')).toBe('');
    expect(await git(repo, 'status', '--porcelain', '-uall', '--', 'lib/sync-resolver', 'lib/integrations')).toBe(
      '?? lib/integrations/ticket-integrations.ts\n?? lib/sync-resolver/index.ts',
    );
  });

  it('holds an attributed importer when its tracked provider changed outside that private index', async () => {
    const providerPath = 'lib/provider.ts';
    const importerPath = 'lib/importer.ts';
    const controlPath = 'lib/control.ts';
    write(repo, providerPath, 'export const oldValue = 1;\n');
    await git(repo, 'add', '--', providerPath);
    await git(repo, 'commit', '-q', '-m', 'seed tracked provider');

    // The provider's new symbol exists in the working tree but not in the private
    // index this attributed group will commit.
    write(repo, providerPath, 'export const oldValue = 1;\nexport const newValue = 2;\n');
    write(repo, importerPath, "import { newValue } from './provider';\nexport const value = newValue;\n");
    write(repo, controlPath, 'export const control = 1;\n');
    const attribution = new Map<string, FileAttribution>([
      [controlPath, { agent: 'ag1', intent: 'work' }],
      [importerPath, { agent: 'ag1', intent: 'work' }],
    ]);

    // Held out of this tick, so the anonymous residual (0eacc351a9) cannot commit it first.
    const result = await commitAttributedGroups(runGit, repo, attribution, [providerPath], MSG, {
      beforeCommit: (privateRunGit) => guard(privateRunGit),
      log,
    });

    expect(result).toEqual({ committedAny: true, committedCount: 1, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe(controlPath);
    expect(await git(repo, 'show', `HEAD:${providerPath}`)).toContain('oldValue');
    expect(await git(repo, 'show', `HEAD:${providerPath}`)).not.toContain('newValue');
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD', '--', importerPath)).toBe('');
    expect(readFileSync(join(repo, providerPath), 'utf8')).toContain('newValue');
    expect(readFileSync(join(repo, importerPath), 'utf8')).toContain('newValue');
    const status = await git(repo, 'status', '--porcelain', '-uall', '--', providerPath, importerPath);
    expect(status).toContain('lib/provider.ts');
    expect(status).toContain('lib/importer.ts');
  });
});

describe('EI-25671755634126843: an ignored untracked dependency never holds its importer', () => {
  // The measured shape: a peer edited gitignored node_modules/postgres files, which made them
  // protected holdings, and every staged importer of 'postgres' was held back. An ignored,
  // untracked path is in no commit and never in HEAD, so holding its importer protects nothing.
  const IGNORED_HOLDINGS = ['node_modules/pg-lite/src/index.js', 'node_modules/pg-lite/cjs/src/index.js'];

  function guardWith(dependencies: string[]) {
    // Production passes a protected holding both as an exclusion and as always-infectious.
    return guardStagedIndexBeforeCommit({
      runGit,
      repoPath: repo,
      scope: 'test',
      readText,
      log,
      excludedDependencies: dependencies,
      alwaysInfectiousDependencies: dependencies,
    });
  }

  it('commits a staged importer of a package whose gitignored node_modules file is a protected holding', async () => {
    write(repo, '.gitignore', 'lib/generated/\nnode_modules/\n');
    write(
      repo,
      'node_modules/pg-lite/package.json',
      JSON.stringify({ name: 'pg-lite', exports: { '.': { import: './src/index.js', require: './cjs/src/index.js' } } }),
    );
    write(repo, 'node_modules/pg-lite/src/index.js', 'export default function sql() {}\n');
    write(repo, 'node_modules/pg-lite/cjs/src/index.js', 'module.exports = function sql() {};\n');
    write(repo, 'lib/with-lock.ts', "import sql from 'pg-lite';\nexport const s = sql;\n");
    await git(repo, 'add', '--', 'lib/with-lock.ts');

    const result = await guardWith(IGNORED_HOLDINGS);

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] });
    expect(await stagedPaths(repo)).toEqual(['lib/with-lock.ts']);
    expect(logs.join('\n')).not.toContain('EXCLUDED from this commit');
  });

  it('still holds an importer of a TRACKED protected module (control)', async () => {
    write(repo, 'lib/base.ts', 'export const base = 1;\nexport const extra = 2;\n');
    write(repo, 'lib/user.ts', "import { extra } from './base';\nexport const u = extra;\n");
    await git(repo, 'add', '--', 'lib/user.ts');

    const result = await guardWith(['lib/base.ts']);

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: ['lib/user.ts'] });
    expect(await stagedPaths(repo)).toEqual([]);
  });

  it('still holds an importer of a tracked module that an ignore rule also covers', async () => {
    // check-ignore without --no-index does not report tracked paths, so this stays infectious.
    write(repo, 'vendor/lib.ts', 'export const v = 0;\n');
    await git(repo, 'add', '--', 'vendor/lib.ts');
    await git(repo, 'commit', '-q', '-m', 'vendor');
    write(repo, '.gitignore', 'lib/generated/\nvendor/\n');
    write(repo, 'vendor/lib.ts', 'export const v = 1;\nexport const w = 2;\n');
    write(repo, 'lib/v.ts', "import { w } from '../vendor/lib';\nexport const x = w;\n");
    await git(repo, 'add', '--', 'lib/v.ts');

    const result = await guardWith(['vendor/lib.ts']);

    expect(result).toEqual({ ok: true, lateLockedHoldings: [], drifted: [], unstaged: ['lib/v.ts'] });
    expect(await stagedPaths(repo)).toEqual([]);
  });
});
