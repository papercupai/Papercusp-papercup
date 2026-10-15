/**
 * WI-6554700010010534: a packaged desktop sidecar has no git, so the installer's downgrade
 * guard could not date its hooks and a 2026-10-07 build overwrote newer installed hooks.
 * The build now writes a provenance manifest beside each packaged hook directory and the
 * installer reads it. These tests cover the writer, the round trip into the guard's
 * verdict, and the build/installer wiring.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyDowngrade,
  readSourceProvenanceManifest,
  resolveSourceGitProvenance,
  SOURCE_PROVENANCE_BASENAME as READER_BASENAME,
} from '@papercusp/operator-core/lib/desktop-install/install-provenance';

import {
  SOURCE_PROVENANCE_BASENAME,
  buildSourceProvenanceManifest,
  writeSourceProvenanceManifest,
} from '../write-hook-source-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

const OLD = '2026-10-01T10:00:00.000Z';
const NEW = '2026-10-05T10:00:00.000Z';

let root: string;
let src: string;
let pkg: string;

function git(args: string[], date?: string) {
  execFileSync('git', ['-C', src, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

function commitFile(name: string, body: string, date: string) {
  writeFileSync(join(src, name), body);
  git(['add', name]);
  git(['commit', '-q', '-m', name], date);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hook-provenance-'));
  src = join(root, 'repo', 'hooks', 'cc');
  pkg = join(root, 'sidecar', 'hooks', 'cc');
  mkdirSync(src, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  // The repository root is ABOVE hooks/cc, as in the real tree, so copying the hook
  // directory into the package does not carry a .git with it.
  execFileSync('git', ['-C', join(root, 'repo'), 'init', '-q'], { stdio: 'ignore' });
  commitFile('old-hook.sh', 'echo old\n', OLD);
  commitFile('new-hook.mjs', 'export {};\n', NEW);
  cpSync(src, pkg, { recursive: true });
  writeFileSync(join(pkg, 'bundle-only.mjs'), '// generated, never committed\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('write-hook-source-provenance (build time)', () => {
  it('shares one manifest name with the install-time reader', () => {
    expect(SOURCE_PROVENANCE_BASENAME).toBe(READER_BASENAME);
  });

  it('records each packaged file and the directory as git dates them', () => {
    const m = buildSourceProvenanceManifest(src, pkg);
    expect(m.schemaVersion).toBe(1);
    expect(m.files['old-hook.sh']?.committedAt).toBe(OLD);
    expect(m.files['new-hook.mjs']?.committedAt).toBe(NEW);
    expect(m.files['old-hook.sh']?.sha).toMatch(/^[0-9a-f]{40}$/);
    // A file git never saw is left out rather than dated by a guess.
    expect(m.files['bundle-only.mjs']).toBeUndefined();
    expect(m.directory?.committedAt).toBe(NEW);
  });

  it('refuses to write an undated manifest for a source git cannot date', () => {
    const loose = join(root, 'not-a-repo');
    mkdirSync(loose);
    writeFileSync(join(loose, 'x.sh'), 'echo\n');
    expect(() => writeSourceProvenanceManifest(loose, loose)).toThrow(/undated/);
  });
});

describe('packaged source dated by its manifest (install time)', () => {
  it('answers what git would have answered, for a path list and for the directory', async () => {
    writeSourceProvenanceManifest(src, pkg);
    expect(await readSourceProvenanceManifest(pkg, ['old-hook.sh'])).toMatchObject({ sourceCommittedAt: OLD });
    expect(await readSourceProvenanceManifest(pkg, ['old-hook.sh', 'new-hook.mjs', 'absent.sh'])).toMatchObject({
      sourceCommittedAt: NEW,
    });
    expect(await readSourceProvenanceManifest(pkg)).toMatchObject({ sourceCommittedAt: NEW });
    expect(await readSourceProvenanceManifest(pkg, ['absent.sh'])).toEqual({});
  });

  it('is the fallback when the source has no repository, so the downgrade guard refuses an older package', async () => {
    expect(existsSync(join(pkg, '.git'))).toBe(false);
    writeSourceProvenanceManifest(src, pkg);
    const incoming = await resolveSourceGitProvenance(pkg, ['old-hook.sh', 'new-hook.mjs']);
    expect(incoming.sourceCommittedAt).toBe(NEW);
    const newerInstall = {
      sourceDir: '/canonical/hooks/cc',
      sourceCommittedAt: '2026-10-12T00:00:00.000Z',
      installedAt: '2026-10-13T00:00:00.000Z',
      pid: 1,
    };
    expect(classifyDowngrade(newerInstall, incoming, 0)).toMatchObject({ downgrade: true });
  });

  it('still fails open for a package built before the manifest existed', async () => {
    expect(await resolveSourceGitProvenance(pkg, ['old-hook.sh'])).toEqual({});
  });

  it('ignores a corrupt manifest instead of throwing', async () => {
    writeFileSync(join(pkg, SOURCE_PROVENANCE_BASENAME), '{not json');
    expect(await readSourceProvenanceManifest(pkg, ['old-hook.sh'])).toEqual({});
    writeFileSync(join(pkg, SOURCE_PROVENANCE_BASENAME), JSON.stringify({ files: { 'old-hook.sh': { sha: 'x' } } }));
    expect(await readSourceProvenanceManifest(pkg, ['old-hook.sh'])).toEqual({});
  });
});

describe('wiring', () => {
  it('the sidecar build dates every packaged hook family it copies', () => {
    const build = readFileSync(join(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh'), 'utf8');
    for (const [srcVar, dstVar] of [
      ['CC_HOOK_SRC_DIR', 'CC_HOOK_DST_DIR'],
      ['INJECT_SRC_DIR', 'INJECT_DST_DIR'],
      ['OMP_HOOK_SRC_DIR', 'OMP_HOOK_DST_DIR'],
    ]) {
      expect(build).toContain(
        `node "$WEB_DIR/scripts/write-hook-source-provenance.mjs" "$${srcVar}" "$${dstVar}"`,
      );
    }
  });

  it('the standalone installer stamps the cc hooks it copies', () => {
    const installer = readFileSync(join(REPO_ROOT, 'apps/operator/scripts/install-standalone-mcp.sh'), 'utf8');
    const copied = installer.indexOf('✓ Installed Claude/Codex lock + coord hooks to $CC_HOOK_DEST_DIR');
    const stamped = installer.indexOf(
      '"${REPO_ROOT}/packages/operator-core/lib/desktop-install/stamp-installed-cc-hooks.ts" "$CC_HOOK_SRC_DIR"',
    );
    expect(copied).toBeGreaterThan(-1);
    expect(stamped).toBeGreaterThan(copied);
  });
});
