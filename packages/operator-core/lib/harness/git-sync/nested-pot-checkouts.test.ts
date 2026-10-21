import { describe, expect, it } from 'vitest';
import { isUnderAnyPath, nestedPotCheckoutPaths, resolveNestedPotCheckouts } from './nested-pot-checkouts';

const ROOT = '/w/papercusp';
const PROJECTS = [
  { slug: 'papercusp', path: ROOT },
  { slug: 'slack-asana-bug-drill', path: `${ROOT}/apps/slack-asana-bug-drill` },
  { slug: 'no-own-sync', path: `${ROOT}/libs/nested-lib` },
  { slug: 'sibling', path: '/w/papercusp-other' },
  { slug: 'outside', path: '/w/elsewhere' },
  { slug: 'pathless', path: null },
];

describe('nestedPotCheckoutPaths (WI-6554700010018602)', () => {
  it('returns only OTHER projects strictly inside the tree that run their own git-sync', () => {
    const active = new Set(['papercusp', 'slack-asana-bug-drill', 'sibling', 'outside']);
    expect(nestedPotCheckoutPaths('papercusp', ROOT, PROJECTS, active)).toEqual(['apps/slack-asana-bug-drill']);
  });

  it('keeps a nested project with no git-sync of its own (the enclosing pot stays its publisher)', () => {
    expect(nestedPotCheckoutPaths('papercusp', ROOT, PROJECTS, new Set(['papercusp']))).toEqual([]);
  });

  it('a prefix-sharing sibling directory is not inside the tree', () => {
    expect(nestedPotCheckoutPaths('papercusp', ROOT, PROJECTS, new Set(['sibling']))).toEqual([]);
  });

  it("keeps the pot's OWN qualified submodule installs (`<slug>/<rel>`) — a commit-only sub-sync has no publisher but the enclosing pot (WI-6554700010018697)", () => {
    const projects = [
      ...PROJECTS,
      { slug: 'papercusp/libs/papercusp', path: `${ROOT}/libs/papercusp` },
      { slug: 'papercusp/libs/generic/cache', path: `${ROOT}/libs/generic/cache` },
      // Same path shape, but a different pot's namespace: still an independent publisher.
      { slug: 'other/libs/vendored', path: `${ROOT}/libs/vendored` },
    ];
    const active = new Set([
      'papercusp',
      'slack-asana-bug-drill',
      'papercusp/libs/papercusp',
      'papercusp/libs/generic/cache',
      'other/libs/vendored',
    ]);
    expect(nestedPotCheckoutPaths('papercusp', ROOT, projects, active)).toEqual([
      'apps/slack-asana-bug-drill',
      'libs/vendored',
    ]);
  });

  it('never treats the pot itself as nested in its own tree', () => {
    expect(nestedPotCheckoutPaths('slack-asana-bug-drill', `${ROOT}/apps/slack-asana-bug-drill`, PROJECTS, new Set(['slack-asana-bug-drill']))).toEqual([]);
  });
});

describe('isUnderAnyPath', () => {
  it('matches the root and its descendants, never a prefix-sharing sibling', () => {
    expect(isUnderAnyPath('apps/drill', ['apps/drill'])).toBe(true);
    expect(isUnderAnyPath('apps/drill/vendor/x', ['apps/drill'])).toBe(true);
    expect(isUnderAnyPath('apps/drill-2', ['apps/drill'])).toBe(false);
  });
});

describe('resolveNestedPotCheckouts', () => {
  it('asks the routine table only about projects inside the tree', async () => {
    const asked: string[][] = [];
    const paths = await resolveNestedPotCheckouts('papercusp', ROOT, {
      loadProjects: async () => PROJECTS,
      activeGitSyncSlugs: async (c) => {
        asked.push([...c]);
        return new Set(['slack-asana-bug-drill']);
      },
    });
    expect(paths).toEqual(['apps/slack-asana-bug-drill']);
    expect(asked).toEqual([['slack-asana-bug-drill', 'no-own-sync']]);
  });

  it('fails open to [] and says so when the registry cannot be read', async () => {
    const lines: string[] = [];
    const paths = await resolveNestedPotCheckouts(
      'papercusp',
      ROOT,
      {
        loadProjects: async () => {
          throw new Error('registry down');
        },
        activeGitSyncSlugs: async () => new Set(),
      },
      (l) => lines.push(l),
    );
    expect(paths).toEqual([]);
    expect(lines.join('\n')).toContain('registry down');
  });

  it('returns [] without a repo path', async () => {
    const paths = await resolveNestedPotCheckouts('papercusp', null, {
      loadProjects: async () => PROJECTS,
      activeGitSyncSlugs: async () => new Set(['slack-asana-bug-drill']),
    });
    expect(paths).toEqual([]);
  });
});
