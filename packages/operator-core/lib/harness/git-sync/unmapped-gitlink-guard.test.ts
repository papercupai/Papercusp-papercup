import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardStagedIndexBeforeCommit, unmappedStagedGitlinkPaths, type RunGit } from './run-git-sync';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitlink-guard-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'base\n', encoding: 'utf8' }).trim();
  git('update-index', '--add', '--cacheinfo', `100644,${blob},base.txt`);
  const tree = git('write-tree');
  const commit = execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree],
    { cwd: root, input: 'seed\n', encoding: 'utf8' }).trim();
  git('update-ref', 'HEAD', commit);
  git('read-tree', '--reset', '-u', 'HEAD');
  const runGit: RunGit = async (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const stage = (path: string, content: string) => {
    writeFileSync(join(root, path), content);
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: content, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${sha},${path}`);
  };
  const link = (path = 'nested-app') => git('update-index', '--add', '--cacheinfo', `160000,${commit},${path}`);
  return { root, git, runGit, stage, link };
}
const mapping = '[submodule "app"]\n\tpath = nested-app\n\turl = ../app.git\n';

describe('git-sync indexed gitlink admission', () => {
  it('detects Git\'s otherwise successful unmapped nested-repository staging', async () => {
    const f = fixture(); f.link();
    expect(await unmappedStagedGitlinkPaths(f.runGit, f.root, ['nested-app'])).toEqual({ ok: true, paths: ['nested-app'] });
  });
  it('accepts a mapping in the commit index, including when the working tree later differs', async () => {
    const f = fixture(); f.link(); f.stage('.gitmodules', mapping);
    writeFileSync(join(f.root, '.gitmodules'), '');
    expect(await unmappedStagedGitlinkPaths(f.runGit, f.root, ['nested-app'])).toEqual({ ok: true, paths: [] });
  });
  it('refuses a working-tree-only mapping and a path whose URL belongs to another module', async () => {
    const f = fixture(); f.link();
    writeFileSync(join(f.root, '.gitmodules'), mapping);
    expect((await unmappedStagedGitlinkPaths(f.runGit, f.root, ['nested-app']))).toEqual({ ok: true, paths: ['nested-app'] });
    f.stage('.gitmodules', '[submodule "app"]\n path = nested-app\n[submodule "other"]\n url = ../other.git\n');
    expect(await unmappedStagedGitlinkPaths(f.runGit, f.root, ['nested-app'])).toEqual({ ok: true, paths: ['nested-app'] });
  });
  it('holds a staged manifest removal that would orphan an unchanged gitlink', async () => {
    const f = fixture(); f.link(); f.stage('.gitmodules', mapping);
    f.git('update-ref', 'HEAD', execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit-tree', f.git('write-tree'), '-p', 'HEAD'], { cwd: f.root, input: 'mapped\n', encoding: 'utf8' }).trim());
    f.git('update-index', '--force-remove', '.gitmodules');
    expect(await unmappedStagedGitlinkPaths(f.runGit, f.root, ['.gitmodules'])).toEqual({ ok: true, paths: ['.gitmodules'] });
  });
  it('integrates with the existing post-stage hold while retaining unrelated work', async () => {
    const f = fixture(); f.link(); f.stage('normal.txt', 'ordinary edit\n');
    const result = await guardStagedIndexBeforeCommit({ runGit: f.runGit, repoPath: f.root, scope: 'fixture',
      readText: async () => null, log: () => {} });
    expect(result).toMatchObject({ ok: true, unstaged: ['nested-app'] });
    expect(f.git('diff', '--cached', '--name-only')).toBe('normal.txt');
  });
  it('fails closed on an unreadable index or malformed indexed manifest', async () => {
    const f = fixture(); f.link(); f.stage('.gitmodules', '[broken');
    expect(await unmappedStagedGitlinkPaths(f.runGit, f.root, ['nested-app'])).toMatchObject({ ok: false });
    const failed: RunGit = async () => ({ code: 128, stdout: '', stderr: 'index unavailable' });
    expect(await unmappedStagedGitlinkPaths(failed, f.root, ['nested-app'])).toMatchObject({ ok: false });
  });
});
