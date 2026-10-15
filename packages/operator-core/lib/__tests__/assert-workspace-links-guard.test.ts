/**
 * assert-workspace-links-guard.test.ts — the recurrence guard for EI-12894
 * (mac release-leg workspace-link drift).
 *
 * The mac release leg esbuilds @papercusp/operator-core on a build VM, resolving
 * @papercusp/* via the MONOREPO-ROOT node_modules (createRequire walks up). The VM's
 * root node_modules drifts (the rsync excludes it), so ANY workspace package added
 * since the VM's last root `npm install` has no node_modules/<name> link and esbuild
 * dies ~35 min deep with a cryptic "Could not resolve" — the 0.0.11 r8 mac-leg kill
 * (@papercusp/kokoro-tts was the first to bite). scripts/assert-workspace-links.mjs
 * runs on the VM BEFORE the build and turns that late resolve error into an immediate,
 * named failure. This locks the detector against a synthetic mini-monorepo:
 *   1. it stays GREEN when every root workspace has its node_modules/<name> link
 *      (the no-false-positive direction — a healthy VM install must not abort a cut);
 *   2. it FLAGS, by name, exactly the workspace whose link is missing (the drift the
 *      real bug was) — including a scoped @x/* whose whole scope dir is gone;
 *   3. it does not over-report: a nameless workspace and a glob dir with no
 *      package.json are neither workspaces to link nor drift.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findMissingWorkspaceLinks } from '../../../../scripts/assert-workspace-links.mjs';

let root: string | null = null;

/** Scaffold a mini-monorepo: root package.json `workspaces`, each workspace's
 *  package.json, and a node_modules/<name> entry for each `linked` package. */
function scaffold(opts: {
  workspaces: string[];
  packages: { dir: string; name?: string }[];
  linked: string[]; // package NAMES to create a node_modules/<name> dir for
  symlinked?: string[]; // package NAMES to create as a node_modules/<name> SYMLINK
}): string {
  const r = mkdtempSync(join(tmpdir(), 'wslink-'));
  writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'root', workspaces: opts.workspaces }));
  for (const p of opts.packages) {
    mkdirSync(join(r, p.dir), { recursive: true });
    writeFileSync(join(r, p.dir, 'package.json'), JSON.stringify(p.name ? { name: p.name } : {}));
  }
  for (const name of opts.linked) {
    mkdirSync(join(r, 'node_modules', ...name.split('/')), { recursive: true });
  }
  for (const name of opts.symlinked ?? []) {
    const parts = name.split('/');
    if (parts.length > 1) mkdirSync(join(r, 'node_modules', ...parts.slice(0, -1)), { recursive: true });
    symlinkSync(join(r, ...opts.packages.find((p) => p.name === name)!.dir.split('/')), join(r, 'node_modules', ...parts));
  }
  return r;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const ALL = {
  workspaces: ['packages/*', 'libs/solo'],
  packages: [
    { dir: 'packages/a', name: '@x/a' },
    { dir: 'packages/b', name: '@x/b' },
    { dir: 'libs/solo', name: 'solo' },
  ],
};

describe('assert-workspace-links guard detector (EI-12894)', () => {
  it('does not run its CLI or exit an importing host bundle', () => {
    root = scaffold({ ...ALL, linked: ['@x/a', '@x/b', 'solo'] });
    const repo = resolve(import.meta.dirname, '../../../..');
    const script = join(repo, 'scripts/assert-workspace-links.mjs');
    const bundle = buildSync({ stdin: { contents: `import { findMissingWorkspaceLinks } from ${JSON.stringify(script)};
      console.log(JSON.stringify({ imported: true, missing: findMissingWorkspaceLinks(process.argv[3]) }));`,
      resolveDir: repo }, bundle: true, platform: 'node', format: 'esm', write: false,
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' } });
    const path = join(root, 'host.mjs');
    writeFileSync(path, bundle.outputFiles[0].text);
    const child = spawnSync(process.execPath, [path, '--root', root], { encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe(JSON.stringify({ imported: true, missing: [] }));
  });

  it('still executes directly and reports missing workspace links', () => {
    root = scaffold({ ...ALL, linked: ['@x/a', 'solo'] });
    const script = resolve(import.meta.dirname, '../../../../scripts/assert-workspace-links.mjs');
    const child = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('@x/b');
    expect(child.stderr).not.toContain('@x/a  (');
  });

  it('is GREEN when every root workspace has its node_modules link', () => {
    root = scaffold({ ...ALL, linked: ['@x/a', '@x/b', 'solo'] });
    expect(findMissingWorkspaceLinks(root)).toEqual([]);
  });

  it('FLAGS, by name, the one workspace whose link is missing (the drift)', () => {
    // @x/b is a real workspace at HEAD but its root node_modules link is absent —
    // exactly the @papercusp/kokoro-tts shape that killed the mac leg.
    root = scaffold({ ...ALL, linked: ['@x/a', 'solo'] });
    expect(findMissingWorkspaceLinks(root)).toEqual([{ name: '@x/b', dir: 'packages/b' }]);
  });

  it('FLAGS both members when a whole scope dir (node_modules/@x) is gone', () => {
    root = scaffold({ ...ALL, linked: ['solo'] });
    expect(findMissingWorkspaceLinks(root)).toEqual([
      { name: '@x/a', dir: 'packages/a' },
      { name: '@x/b', dir: 'packages/b' },
    ]);
  });

  it('counts a node_modules SYMLINK (the real workspace link shape) as present', () => {
    root = scaffold({ ...ALL, linked: ['@x/b', 'solo'], symlinked: ['@x/a'] });
    expect(findMissingWorkspaceLinks(root)).toEqual([]);
  });

  it('does NOT report a nameless workspace (npm cannot link one) or a glob dir with no package.json', () => {
    root = scaffold({
      workspaces: ['packages/*', 'libs/solo'],
      packages: [
        { dir: 'packages/a', name: '@x/a' },
        { dir: 'packages/nameless' }, // package.json with no `name`
        { dir: 'libs/solo', name: 'solo' },
      ],
      linked: ['@x/a', 'solo'],
    });
    // packages/not-a-pkg matches `packages/*` but has no package.json → not a workspace.
    mkdirSync(join(root, 'packages/not-a-pkg'), { recursive: true });
    expect(findMissingWorkspaceLinks(root)).toEqual([]);
  });
});
