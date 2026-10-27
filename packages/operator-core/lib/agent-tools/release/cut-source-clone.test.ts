import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyCutSourceClone } from './cut-source-clone';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
};

describe('independent release source clone authority', () => {
  let base: string;
  let source: string;
  let clone: string;
  let sha: string;
  let childPin: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'cut-clone-'));
    source = path.join(base, 'registered');
    clone = path.join(base, 'candidate');
    mkdirSync(path.join(source, 'papercusp-desktop'), { recursive: true });
    git(source, 'init', '-q');
    git(path.join(source, 'papercusp-desktop'), 'init', '-q');
    writeFileSync(path.join(source, 'papercusp-desktop', 'payload'), 'pinned source\n');
    childPin = commit(path.join(source, 'papercusp-desktop'));
    writeFileSync(path.join(source, '.gitmodules'), '[submodule "desktop"]\npath = papercusp-desktop\nurl = ./papercusp-desktop\n');
    sha = commit(source);
    git(base, 'clone', '-q', '--no-hardlinks', source, clone);
    git(clone, 'checkout', '-q', '--detach', sha);
    git(base, 'clone', '-q', '--no-hardlinks', path.join(source, 'papercusp-desktop'), path.join(clone, 'papercusp-desktop'));
    git(path.join(clone, 'papercusp-desktop'), 'checkout', '-q', '--detach', childPin);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const verify = () => verifyCutSourceClone(clone, [{ path: source }], sha);

  it('admits the exact clean detached clone with independently materialized gitlink pins', async () => {
    await expect(verify()).resolves.toEqual({ ok: true, path: clone });
  });
  it('requires the exact source SHA even for read-only requests', async () => {
    await expect(verifyCutSourceClone(clone, [{ path: source }], undefined, { readOnly: true })).resolves.toMatchObject({ ok: false });
    await expect(verifyCutSourceClone(clone, [{ path: source }], childPin)).resolves.toMatchObject({ ok: false });
  });
  it('does not trust a forged local origin when registered source lacks the commit', async () => {
    const other = path.join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(path.join(other, 'other'), 'different');
    commit(other);
    git(clone, 'remote', 'set-url', 'origin', other);
    await expect(verifyCutSourceClone(clone, [{ path: other }], sha)).resolves.toMatchObject({ ok: false });
  });
  it('rejects unregistered origins and an attached HEAD', async () => {
    await expect(verifyCutSourceClone(clone, [], sha)).resolves.toMatchObject({ ok: false });
    git(clone, 'checkout', '-qb', 'mutable');
    await expect(verify()).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('detached') });
  });
  it('rejects dirty and untracked child source; read-only inspection retains its explicit exception', async () => {
    writeFileSync(path.join(clone, 'papercusp-desktop', 'untracked'), 'changed');
    await expect(verify()).resolves.toMatchObject({ ok: false });
    await expect(verifyCutSourceClone(clone, [{ path: source }], sha, { readOnly: true })).resolves.toMatchObject({ ok: true });
  });
  it('rejects a child checkout at another commit even when all bytes are clean', async () => {
    const child = path.join(clone, 'papercusp-desktop');
    writeFileSync(path.join(child, 'payload'), 'other source');
    commit(child);
    await expect(verifyCutSourceClone(clone, [{ path: source }], sha, { readOnly: true })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('pin') });
  });
  it('rejects missing children and symlink escapes', async () => {
    const child = path.join(clone, 'papercusp-desktop');
    rmSync(child, { recursive: true, force: true });
    await expect(verify()).resolves.toMatchObject({ ok: false });
    symlinkSync(path.join(source, 'papercusp-desktop'), child);
    await expect(verify()).resolves.toMatchObject({ ok: false });
  });
  it('rejects linked worktrees on the independent-clone path', async () => {
    const linked = path.join(base, 'linked');
    git(source, 'worktree', 'add', '-q', '--detach', linked, sha);
    await expect(verifyCutSourceClone(linked, [{ path: source }], sha)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('independent') });
  });
});
