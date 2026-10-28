// WI-6554700010030747: the PR pane's git facts are computed off the sync read path.
//
// The read side (pr-git-facts.ts) is a snapshot SELECT; the subprocess side
// (pr-git-facts-compute.ts) runs only inside the harnessPrs.gitFacts producer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { readDerivedSnapshot } = vi.hoisted(() => ({ readDerivedSnapshot: vi.fn() }));
vi.mock('../derived-reads/registry', () => ({ readDerivedSnapshot }));
vi.mock('../derived-reads/producers', () => ({}));

const { HARNESS_PR_GIT_FACTS_KEY, readHarnessPrGitFacts } = await import('./pr-git-facts');
const { parseGithubOriginRemote, gitOriginRemote, readPromotedSha } = await import('./pr-git-facts-compute');

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pr-git-facts-'));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  readDerivedSnapshot.mockReset();
});

describe('parseGithubOriginRemote', () => {
  it.each([
    ['https://github.com/acme/widget.git', 'github.com/acme/widget'],
    ['https://github.com/acme/widget', 'github.com/acme/widget'],
    ['git@github.com:acme/widget.git', 'github.com/acme/widget'],
    ['https://github.com/acme/widget/\n', 'github.com/acme/widget'],
  ])('%s -> %s', (url, expected) => {
    expect(parseGithubOriginRemote(url)).toBe(expected);
  });

  it('is null for a non-GitHub origin', () => {
    expect(parseGithubOriginRemote('https://gitlab.com/acme/widget.git')).toBeNull();
  });
});

describe('git fact computation (producer side)', () => {
  it('reads the GitHub origin and the refs/heads/main commit of a real checkout', async () => {
    const repo = tempDir();
    git(repo, '-c', 'init.defaultBranch=main', 'init', '-q');
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
    const head = git(repo, 'rev-parse', 'HEAD');

    expect(await gitOriginRemote(repo)).toBe('github.com/acme/widget');
    expect(await readPromotedSha(repo)).toBe(head);
  });

  it('is null for a directory that is not a git checkout', async () => {
    const plain = tempDir();
    expect(await gitOriginRemote(plain)).toBeNull();
    expect(await readPromotedSha(plain)).toBeNull();
  });
});

describe('readHarnessPrGitFacts (read side)', () => {
  it('serves the harness-scoped snapshot without computing', async () => {
    const facts = { originRemote: 'github.com/acme/widget', promotedSha: 'a'.repeat(40) };
    readDerivedSnapshot.mockResolvedValue({ payload: facts, meta: {} });

    expect(await readHarnessPrGitFacts('widget')).toEqual(facts);
    expect(readDerivedSnapshot).toHaveBeenCalledWith(HARNESS_PR_GIT_FACTS_KEY, { harnessSlug: 'widget' });
  });

  it('returns null on a snapshot miss', async () => {
    readDerivedSnapshot.mockResolvedValue({ payload: null, meta: { missing: true } });
    expect(await readHarnessPrGitFacts('widget')).toBeNull();
  });
});

describe('read-side modules stay subprocess-free', () => {
  // no-heavy-io-on-read-path.test.ts walks ONE import hop from sync-resolver/index.ts,
  // so it sees prs.ts and pr-viewer.ts but not the module they now read through.
  // Pin that one too, so the git calls cannot drift back onto the read path.
  it.each([
    'pr-git-facts.ts',
    'pr-viewer.ts',
    '../endpoint-route/routes/harness/prs.ts',
  ])('%s does not import node:child_process', (rel) => {
    const src = readFileSync(resolve(__dirname, rel), 'utf8');
    expect(src).not.toMatch(/(?:from\s*|import\(\s*)['"](?:node:)?child_process['"]/);
  });
});
