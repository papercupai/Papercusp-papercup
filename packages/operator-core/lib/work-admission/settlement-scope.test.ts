import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeSettlementManifestToRepository, type SettlementScopeGit } from './settlement-scope';

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

const env = {
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim();

function receipt(root: string, paths: string[], entryRoot?: string) {
  return {
    repositoryRoot: root,
    normalizedPaths: paths,
    contentIdentity: paths.map((p) => ({
      path: p, workingTreeBlobSha: BLOB, headBlobSha: BLOB, headSha: SHA, ...(entryRoot ? { repositoryRoot: entryRoot } : {}),
    })),
    residualPaths: undefined,
  };
}

describe('scopeSettlementManifestToRepository (WI-6554700010018378)', () => {
  let base: string;
  let superproject: string;
  let submodule: string;
  let plainDir: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'settlement-scope-')));
    const origin = path.join(base, 'pot-origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(origin, 'quote.ts'), 'export const fee = 5;\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'pot');
    superproject = path.join(base, 'canonical');
    mkdirSync(superproject);
    git(superproject, 'init', '-q', '-b', 'staging');
    mkdirSync(path.join(superproject, 'apps', 'plain'), { recursive: true });
    writeFileSync(path.join(superproject, 'apps', 'plain', 'x.ts'), 'x\n');
    git(superproject, 'add', '.');
    git(superproject, 'commit', '-qm', 'root');
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'apps/drill');
    submodule = path.join(superproject, 'apps', 'drill');
    plainDir = path.join(superproject, 'apps', 'plain');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('returns a receipt already rooted at the repository unchanged, without consulting git', async () => {
    const refuse: SettlementScopeGit = async () => { throw new Error('git must not run'); };
    const scoped = await scopeSettlementManifestToRepository(receipt(submodule, ['src/quote.ts']), submodule, refuse);
    expect(scoped).toMatchObject({ repositoryRoot: submodule, normalizedPaths: ['src/quote.ts'] });
    expect(scoped!.contentIdentity[0]).toMatchObject({ path: 'src/quote.ts', workingTreeBlobSha: BLOB });
  });

  it('rebases a superproject-closed receipt into the real submodule checkout that owns every path', async () => {
    const manifest = receipt(superproject, ['apps/drill/src/quote.ts', 'apps/drill/src/quote.test.ts']);
    const scoped = await scopeSettlementManifestToRepository(manifest, submodule);
    expect(scoped).toEqual({
      repositoryRoot: submodule,
      normalizedPaths: ['src/quote.ts', 'src/quote.test.ts'],
      contentIdentity: [
        { path: 'src/quote.ts', workingTreeBlobSha: BLOB, headBlobSha: BLOB, repositoryRoot: submodule },
        { path: 'src/quote.test.ts', workingTreeBlobSha: BLOB, headBlobSha: BLOB, repositoryRoot: submodule },
      ],
      residualPaths: undefined,
    });
    // The superproject's close-time HEAD names no commit of the submodule.
    expect(scoped!.contentIdentity.some((e) => 'headSha' in e)).toBe(false);
  });

  it('rebases per-entry superproject roots the same way', async () => {
    const scoped = await scopeSettlementManifestToRepository(
      receipt('/elsewhere', ['apps/drill/quote.ts'], superproject), submodule);
    expect(scoped?.contentIdentity[0]).toMatchObject({ path: 'quote.ts', repositoryRoot: submodule });
  });

  it('refuses a plain subdirectory: it shares its parent repository, so the paths are not its own', async () => {
    expect(await scopeSettlementManifestToRepository(receipt(superproject, ['apps/plain/x.ts']), plainDir)).toBeNull();
  });

  it('refuses a receipt with any path outside the submodule (cross-repository)', async () => {
    const manifest = receipt(superproject, ['apps/drill/src/quote.ts', 'packages/other/a.ts']);
    expect(await scopeSettlementManifestToRepository(manifest, submodule)).toBeNull();
    expect(await scopeSettlementManifestToRepository(receipt(superproject, ['apps/drill/']), submodule)).toBeNull();
  });

  it('refuses a receipt rooted outside or beside the repository', async () => {
    expect(await scopeSettlementManifestToRepository(receipt(submodule, ['quote.ts']), superproject)).toBeNull();
    expect(await scopeSettlementManifestToRepository(receipt(path.join(base, 'other'), ['quote.ts']), submodule)).toBeNull();
  });

  it('refuses a grand-parent root: only the direct superproject receipt is rebased', async () => {
    const fake: SettlementScopeGit = async (_root, args) => ({ code: 0,
      stdout: args.includes('--show-toplevel') ? '/w/canonical/libs/mid/pkg' : '/w/canonical/libs/mid' });
    expect(await scopeSettlementManifestToRepository(
      receipt('/w/canonical', ['libs/mid/pkg/a.ts']), '/w/canonical/libs/mid/pkg', fake)).toBeNull();
    expect(await scopeSettlementManifestToRepository(
      receipt('/w/canonical/libs/mid', ['pkg/a.ts']), '/w/canonical/libs/mid/pkg', fake))
      .toMatchObject({ normalizedPaths: ['a.ts'] });
  });

  it('refuses when git cannot confirm the repository boundary', async () => {
    const failing: SettlementScopeGit = async () => ({ code: 128, stdout: '' });
    expect(await scopeSettlementManifestToRepository(
      receipt('/w/canonical', ['apps/drill/a.ts']), '/w/canonical/apps/drill', failing)).toBeNull();
  });
});
