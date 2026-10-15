/**
 * scripts/source-preview.mjs --target public — plan open-source-release-2026-09-29
 * P-002 / P-003 (and the LICENSE half of P-007).
 *
 * The public target publishes the same gated public-safe cut as the private preview,
 * but (a) under the Elastic License 2.0, with LICENSE + a license NOTICE at the root,
 * (b) APPEND-ONLY: each push is one new commit whose parent is the current public
 * main, pushed without --force, so forks and pull requests keep a shared history,
 * and (c) never to the preview repository (and the preview never to the public one).
 *
 * The remote is a local bare repository under tmpdir and the gate is injected, so
 * these cases pin the contract without network or scanners.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PUBLIC_COMMUNITY_FILES,
  PUBLIC_LICENSE_PATH,
  readCommunityFiles,
  assertRemoteMatchesTarget,
  checkDrift,
  exportSnapshot,
  pushSnapshot,
  readLicense,
  resolveTarget,
} from '../../../scripts/source-preview.mjs';
import {
  DESKTOP_OWNER_NAMING_FILE,
  DROPPED,
  FIXTURE_ENV,
  INTERNAL_DOC_CONTENTS,
  PUBLIC_DESKTOP_DROPPED,
  PUBLIC_DESKTOP_SHIPPED,
  childEnv,
  git,
  makeSuperproject,
  write,
  type Superproject,
} from './source-preview.fixture';

let tmp: string;
let fx: Superproject;
let bare: string;
let remote: string;

const passing = async () => ({ ok: true, exitCode: 0, results: [] });

function remoteGit(args: string[]): string {
  const r = spawnSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// The real notices collector resolves every Cargo workspace; the fixture has none, so the
// export tests inject a stub and the collector itself is covered in license-gate.test.ts.
const NOTICES_STUB = '# Third-party notices\n\nstub\n';
const thirdPartyNotices = () => ({ text: NOTICES_STUB, undetermined: [] as string[] });
const opts = (extra = {}) => ({ repoRoot: fx.repo, ref: 'main', remote, target: 'public', env: childEnv(), thirdPartyNotices, ...extra });

function commitChange(rel: string, body: string, msg: string): string {
  write(fx.repo, rel, body);
  git(fx.repo, ['add', '-A', '-f']);
  git(fx.repo, ['commit', '-q', '-m', msg]);
  return git(fx.repo, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-public-test-'));
  fx = makeSuperproject(tmp);
  bare = join(tmp, 'public.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  remote = `file://${bare}`;
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('public target — the two repositories never cross', () => {
  it('refuses to publish the public target to the preview repository, and vice versa', () => {
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'https://github.com/Papercusp/papercusp-preview.git')).toThrow(/preview repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'git@github.com:papercusp/papercusp-preview')).toThrow(/preview repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('preview'), 'https://github.com/Papercusp/papercusp-app.git')).toThrow(/public repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'https://github.com/Papercusp/papercusp-app.git')).not.toThrow();
    // D-016: the private library repo owns 'Papercusp/papercusp' and the superproject is
    // private — no target may publish to either.
    for (const t of ['public', 'preview']) {
      expect(() => assertRemoteMatchesTarget(resolveTarget(t), 'git@github.com:Papercusp/papercusp.git')).toThrow(/private repository/);
      expect(() => assertRemoteMatchesTarget(resolveTarget(t), 'https://github.com/Papercusp/papercup')).toThrow(/private repository/);
    }
    expect(() => resolveTarget('papercup')).toThrow(/unknown target/);
  });

  it('pushSnapshot refuses a crossed remote before exporting anything', async () => {
    await expect(pushSnapshot(opts({ remote: 'https://github.com/Papercusp/papercusp-preview.git', confirm: true, gate: passing })))
      .rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('public target — licensed export', () => {
  it('ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json', async () => {
    const out = join(tmp, 'public-export');
    const { manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, target: 'public', env: childEnv(), thirdPartyNotices });
    expect(manifest).toMatchObject({ target: 'public', source: { commit: fx.commit } });
    expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe(readFileSync(PUBLIC_LICENSE_PATH, 'utf8'));
    expect(readFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toBe(NOTICES_STUB);
    for (const [path, body] of Object.entries(INTERNAL_DOC_CONTENTS)) {
      expect(readFileSync(join(out, path), 'utf8'), path).toBe(body);
    }
    expect(readFileSync(join(out, 'libs/papercusp/plugins/markdown-preview/papercusp.json'), 'utf8'))
      .toBe(readFileSync(join(fx.repo, 'libs/papercusp/plugins/markdown-preview/papercusp.json'), 'utf8'));
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toContain('Elastic License 2.0');
    expect(notice).not.toMatch(/EVALUATION ONLY/);
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('Elastic License 2.0');
    expect(readme).toContain('Papercusp is source-available');
    expect(readme).not.toMatch(/\b(?:OSI[ -]approved|open[ -]source)\b/i);
    expect(readme).not.toMatch(/replaced wholesale/);
    expect(readme).toContain('## Contributing, security and telemetry');
    // P-008: a stranger's clean-machine build path, each step measured on a clean copy.
    expect(readme).toContain('## Build and run from source');
    for (const step of ['postgresql-18-pgvector', 'npm --workspace @papercusp/operator-vite run build', 'cd papercusp-desktop && npm ci && npm run dev', 'scripts/install-embedded-pgvector.mjs']) {
      expect(readme, step).toContain(step);
    }
    // P-004: the public cut carries the desktop shell, minus generated/internal paths.
    for (const p of PUBLIC_DESKTOP_SHIPPED) expect(existsSync(join(out, p)), p).toBe(true);
    for (const p of PUBLIC_DESKTOP_DROPPED) expect(existsSync(join(out, p)), p).toBe(false);
    // The shell is copied after the shared selection and gets the same identity scrub.
    // p2p-public-release-endgame-2026-09-01#D-112 (owner 2026-10-01) made that scrub
    // machine-only: the owner's name and email may be published, so an owner-naming file
    // ships byte-identical to the source. Build-box identity (home path, user, host) is
    // still scrubbed; that half is pinned in audit-release-bundle-fails-closed.test.ts.
    const rigNotes = readFileSync(join(out, DESKTOP_OWNER_NAMING_FILE), 'utf8');
    expect(rigNotes).toContain('echo ok');
    expect(rigNotes).toBe(readFileSync(join(fx.repo, DESKTOP_OWNER_NAMING_FILE), 'utf8'));
    expect(rigNotes).toContain(FIXTURE_ENV.PAPERCUSP_RELEASE_OWNER_NAME);
    expect(manifest.submodules.map((s: { path: string }) => s.path)).not.toContain('papercusp-desktop'); // a plain dir in the fixture
    for (const p of DROPPED.filter((d) => !d.startsWith('papercusp-desktop/'))) expect(existsSync(join(out, p)), p).toBe(false);
    expect(readme).toContain('PAPERCUSP_POSTHOG_KEY');
    for (const name of PUBLIC_COMMUNITY_FILES) {
      expect(readFileSync(join(out, name), 'utf8')).toBe(readFileSync(join(dirname(PUBLIC_LICENSE_PATH), name), 'utf8'));
    }
    expect(readFileSync(join(out, 'CONTRIBUTING.md'), 'utf8')).toMatch(/Contributor License Agreement/);
    expect(readFileSync(join(out, 'SECURITY.md'), 'utf8')).toMatch(/Report a vulnerability/);
    // P-009/P-011: the public repo's own CI and CLA bot ship; the README's tree listing
    // describes the development tree, so it never lists the added .github directory.
    expect(readFileSync(join(out, 'CLA.md'), 'utf8')).toMatch(/Contributor License Agreement/);
    expect(existsSync(join(out, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(join(out, '.github/workflows/cla.yml'))).toBe(true);
    expect(readme).not.toContain('.github/');
  }, 120_000);

  it('public workflows never run pull request code with a write token', () => {
    const wf = join(dirname(PUBLIC_LICENSE_PATH), '.github', 'workflows');
    // Judge the configuration, not the explanatory comments (which name the trigger to avoid).
    const config = (name: string) =>
      readFileSync(join(wf, name), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const ci = config('ci.yml');
    expect(readFileSync(join(wf, 'ci.yml'), 'utf8')).toMatch(/pull_request_target/); // control: the stripped text is what differs
    // CI executes the pull request's code, so it must use the read-only trigger.
    expect(ci).not.toMatch(/pull_request_target/);
    expect(ci).toMatch(/permissions:\s*\n\s*contents: read/);
    const cla = config('cla.yml');
    // The CLA bot needs pull_request_target's write token, so it must never check out code.
    expect(cla).toMatch(/pull_request_target/);
    expect(cla).not.toMatch(/actions\/checkout/);
  });

  it('the preview export stays evaluation-only and carries no LICENSE', async () => {
    const out = join(tmp, 'preview-export');
    const { manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() });
    expect(manifest.target).toBe('preview');
    expect(readFileSync(join(out, 'NOTICE'), 'utf8')).toMatch(/EVALUATION ONLY/);
    expect(() => readFileSync(join(out, 'LICENSE'))).toThrow();
    for (const name of PUBLIC_COMMUNITY_FILES) expect(() => readFileSync(join(out, name))).toThrow();
    expect(existsSync(join(out, 'THIRD-PARTY-NOTICES.md'))).toBe(false);
  }, 120_000);

  it('refuses a public export whose third-party notices were only partly measured, and leaves no output', async () => {
    const out = join(tmp, 'public-export-partial-notices');
    await expect(exportSnapshot({
      repoRoot: fx.repo, ref: 'main', out, target: 'public', env: childEnv(),
      thirdPartyNotices: () => ({ text: NOTICES_STUB, undetermined: ['cargo: Cargo.lock: cargo metadata failed'] }),
    })).rejects.toThrow(/THIRD-PARTY-NOTICES\.md: part of the dependency graph was not measured/);
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it('refuses a public export whose community files are missing or empty', () => {
    const dir = mkdtempSync(join(tmp, 'community-'));
    expect(() => readCommunityFiles(dir)).toThrow(/needs CONTRIBUTING\.md/);
    for (const name of PUBLIC_COMMUNITY_FILES) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), `# ${name}\n`);
    }
    writeFileSync(join(dir, 'SECURITY.md'), '  \n');
    expect(() => readCommunityFiles(dir)).toThrow(/SECURITY\.md is empty/);
    expect(readCommunityFiles(dirname(PUBLIC_LICENSE_PATH)).map((f) => f.name)).toEqual(PUBLIC_COMMUNITY_FILES);
  });

  it('refuses a missing or wrong LICENSE for the public target', () => {
    expect(() => readLicense(join(tmp, 'nope'))).toThrow(/needs its LICENSE/);
    const mit = join(tmp, 'MIT');
    writeFileSync(mit, 'MIT License\n\nPermission is hereby granted…\n');
    expect(() => readLicense(mit)).toThrow(/not the Elastic License 2.0/);
    expect(readLicense(PUBLIC_LICENSE_PATH)).toMatch(/^Elastic License 2\.0/);
  });
});

describe('public target — append-only history', () => {
  it('the first confirmed push creates the initial commit', async () => {
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: null, commit: fx.commit });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('1');
    expect(remoteGit(['log', '-1', '--format=%an <%ae>', 'main'])).toBe('Papercusp <public-export@papercusp.invalid>');
    expect(remoteGit(['show', 'main:LICENSE'])).toMatch(/^Elastic License 2\.0/);
    expect(await checkDrift(opts())).toMatchObject({ inSync: true });
  }, 120_000);

  it('does not push when already in sync', async () => {
    const before = remoteGit(['rev-parse', 'main']);
    expect(await pushSnapshot(opts({ confirm: true, gate: passing }))).toMatchObject({ pushed: false, reason: 'in-sync' });
    expect(remoteGit(['rev-parse', 'main'])).toBe(before);
  }, 120_000);

  it('a shipped change is published as a NEW commit on top of the previous one', async () => {
    const first = remoteGit(['rev-parse', 'main']);
    const head = commitChange('apps/operator/src/index.ts', 'export const x = 3;\n', 'ship a change');
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: first, commit: head });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('2');
    expect(remoteGit(['rev-parse', 'main^'])).toBe(first);
    expect(remoteGit(['show', 'main:apps/operator/src/index.ts'])).toBe('export const x = 3;');
  }, 180_000);

  it('builds on a commit someone else pushed instead of erasing it', async () => {
    const clone = join(tmp, 'contributor');
    spawnSync('git', ['clone', '-q', remote, clone]);
    write(clone, 'CONTRIBUTED.md', 'from a pull request\n');
    git(clone, ['add', 'CONTRIBUTED.md']);
    git(clone, ['-c', 'user.name=c', '-c', 'user.email=c@example.invalid', 'commit', '-q', '-m', 'merged PR']);
    git(clone, ['push', '-q', 'origin', 'HEAD:main']);
    const contributed = remoteGit(['rev-parse', 'main']);

    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: contributed });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('4');
    // The history keeps the contributed commit; the tree is the export again (the PR's
    // change reaches the public tree only once it is ported into the source repo).
    expect(remoteGit(['merge-base', '--is-ancestor', contributed, 'main']) ).toBe('');
    expect(spawnSync('git', ['--git-dir', bare, 'cat-file', '-e', 'main:CONTRIBUTED.md']).status).not.toBe(0);
  }, 180_000);

  it('refuses to append onto a repository whose main is not export lineage, even as a dry run (D-016)', async () => {
    // e.g. the private library repo that happened to own the public name.
    const foreignBare = join(tmp, 'foreign.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', foreignBare]);
    const seed = join(tmp, 'foreign-seed');
    spawnSync('git', ['clone', '-q', `file://${foreignBare}`, seed]);
    write(seed, 'lib.ts', 'export const privateLib = 1;\n');
    git(seed, ['add', 'lib.ts']);
    git(seed, ['-c', 'user.name=l', '-c', 'user.email=l@example.invalid', 'commit', '-q', '-m', 'library history']);
    git(seed, ['push', '-q', 'origin', 'HEAD:main']);
    const foreign = `file://${foreignBare}`;
    const head = spawnSync('git', ['--git-dir', foreignBare, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim();

    for (const confirm of [false, true]) {
      await expect(pushSnapshot(opts({ remote: foreign, confirm, gate: passing }))).rejects.toThrow(/not an export commit/);
    }
    expect(spawnSync('git', ['--git-dir', foreignBare, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim()).toBe(head);
  }, 180_000);
});
