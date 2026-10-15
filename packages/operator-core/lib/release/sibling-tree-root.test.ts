import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeSiblingTreeRoot,
  gitEnclosingWorkTree,
  outermostEnclosingWorkTree,
  resolveSiblingTreeRoot,
} from './sibling-tree-root';

// WI-6554700010009501: a hive nested inside another git work tree must not get its
// checkpoint/release tree derived INSIDE that enclosing tree.
const trees = (map: Record<string, string>) => (dir: string) => {
  const hit = Object.keys(map)
    .filter((root) => dir === root || dir.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? map[hit] : null;
};

describe('resolveSiblingTreeRoot (injected probe)', () => {
  it('keeps the plain sibling for a top-level checkout', async () => {
    const r = await describeSiblingTreeRoot({
      integrationRoot: '/w/oddsmith',
      name: 'oddsmith-checkpoint',
      probe: () => null,
    });
    expect(r).toEqual({ root: '/w/oddsmith-checkpoint', enclosingWorkTree: null });
  });

  it('hops above the enclosing work tree for a nested hive', async () => {
    const probe = trees({ '/w/papercusp': '/w/papercusp' });
    const r = await describeSiblingTreeRoot({
      integrationRoot: '/w/papercusp/apps/slack-asana-bug-drill',
      name: 'slack-asana-bug-drill-checkpoint',
      probe,
    });
    expect(r).toEqual({
      root: '/w/papercusp-slack-asana-bug-drill-checkpoint',
      enclosingWorkTree: '/w/papercusp',
    });
    expect(r.root.startsWith('/w/papercusp/')).toBe(false);
  });

  it('climbs to the OUTERMOST work tree when the enclosing tree is itself nested', async () => {
    const probe = trees({ '/w/outer': '/w/outer', '/w/outer/libs/inner': '/w/outer/libs/inner' });
    expect(await outermostEnclosingWorkTree('/w/outer/libs/inner/apps', probe)).toBe('/w/outer');
    expect(
      await resolveSiblingTreeRoot({ integrationRoot: '/w/outer/libs/inner/apps/x', name: 'x-release', probe }),
    ).toBe('/w/outer-x-release');
  });

  it('terminates when the probe keeps answering the same tree', async () => {
    expect(await outermostEnclosingWorkTree('/a/b', () => '/a')).toBe('/a');
  });
});

describe('gitEnclosingWorkTree (real git)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'sibling-tree-root-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

  it('relocates a hive nested in a real repo and ignores a stub .git dir above it', async () => {
    // A stub `.git` holding only `info/` (this box has one at ~/.git). git rejects it, so it
    // must NOT count as an enclosing repo; a `.git`-existence walk would wrongly stop here.
    mkdirSync(path.join(base, '.git', 'info'), { recursive: true });
    const workspace = path.join(base, 'workspace');
    const outer = path.join(workspace, 'outer');
    const hive = path.join(outer, 'apps', 'drill');
    mkdirSync(hive, { recursive: true });
    git(outer, 'init', '-q');
    git(hive, 'init', '-q');

    expect(await gitEnclosingWorkTree(workspace)).toBeNull();
    expect(await resolveSiblingTreeRoot({ integrationRoot: outer, name: 'outer-checkpoint' })).toBe(
      path.join(workspace, 'outer-checkpoint'),
    );
    expect(await resolveSiblingTreeRoot({ integrationRoot: hive, name: 'drill-checkpoint' })).toBe(
      path.join(workspace, 'outer-drill-checkpoint'),
    );
  });
});
