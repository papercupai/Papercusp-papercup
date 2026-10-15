/**
 * source-scope.test.ts — unit coverage for source.ts:resolvePlanScope and
 * fill_workspace_id_from_projects, the (PlanSourceOpts) → concrete
 * (workspaceId, harnessSlug) PG-key resolver every plans read/write funnels
 * through (WI-148 / P-013 workspace-identity reconciliation, SAFE forward half).
 *
 * The slug→workspace lookup against harness_shared.projects is injected via the
 * `lookup` seam so every branch is exercised with no PG, no filesystem:
 *   - the papercup-primary short-circuit (empty / '*' / 'all' / papercup),
 *   - the explicit-workspaceId bypass,
 *   - the projects-table resolution for a concrete slug,
 *   - the fail-loud paths: unknown slug → THROW (no silent default), and a
 *     same-name collision across workspaces → THROW.
 *
 * The most load-bearing assertion: papercup / wildcard / empty resolve to
 * PAPERCUSP_WORKSPACE_ID (WI-148 part-B flip, owner GO 2026-06-16, in LOCKSTEP
 * with migration 295's 'default'→'papercusp-workspace' data move — either alone
 * 404s every papercup plan).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '@papercusp/tooldef';

const hiveMocks = vi.hoisted(() => ({
  potHomeSlugForHarness: vi.fn<(_workspaceId: string, harnessSlug: string) => Promise<string | null>>(
    async (_workspaceId, harnessSlug) => harnessSlug,
  ),
}));

vi.mock('../../../hive-federation', () => ({
  potHomeSlugForHarness: hiveMocks.potHomeSlugForHarness,
}));

import {
  resolvePlanScope,
  isUnknownPlanScopeError,
  fill_workspace_id_from_projects,
  type ProjectsWorkspaceLookup,
  type RegistryWorkspaceResolver,
} from '../source';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';

/** The operator-home slug (operatorHomeHarnessSlug() — 'papercusp' default post-migration);
 *  the scope that empty / '*' / 'all' / <home> short-circuits to (WI-148 part-B). */
const HOME = operatorHomeHarnessSlug();

beforeEach(() => {
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockImplementation(
    async (_workspaceId: string, harnessSlug: string) => harnessSlug,
  );
});

/** A lookup seam that returns a fixed match list and records the slug it saw. */
function lookupReturning(...workspaceIds: string[]): {
  lookup: ProjectsWorkspaceLookup;
  calls: string[];
} {
  const calls: string[] = [];
  const lookup: ProjectsWorkspaceLookup = async (slug) => {
    calls.push(slug);
    return workspaceIds;
  };
  return { lookup, calls };
}

/** A registry-fallback seam returning a fixed result + recording the slug it saw.
 *  Stands in for resolveWorkspaceForHarnessSlug so the projects-miss → registry
 *  fallback branch is exercised with no PG. */
function registryReturning(workspaceId: string | null): {
  registryFallback: RegistryWorkspaceResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const registryFallback: RegistryWorkspaceResolver = async (slug) => {
    calls.push(slug);
    return workspaceId;
  };
  return { registryFallback, calls };
}

describe('resolvePlanScope — operator-home-primary short-circuit (WI-148 part-B)', () => {
  it('no harness → home primary in PAPERCUSP_WORKSPACE_ID', async () => {
    const { lookup, calls } = lookupReturning('ws-should-not-be-used');
    const r = await resolvePlanScope({ lookup });
    expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: HOME});
    // The short-circuit never consults the projects table.
    expect(calls).toEqual([]);
  });

  it.each(['*', 'all', HOME])(
    'the %s sentinel → home primary in PAPERCUSP_WORKSPACE_ID (no projects lookup)',
    async (slug) => {
      const { lookup, calls } = lookupReturning('ws-should-not-be-used');
      const r = await resolvePlanScope({ harnessSlug: slug, lookup });
      expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: HOME});
      expect(calls).toEqual([]);
    },
  );

  it('a blank/whitespace harness is treated as "no harness"', async () => {
    const r = await resolvePlanScope({ harnessSlug: '   ' });
    expect(r).toEqual({ workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: HOME});
  });

  it('an explicit workspaceId rides through the papercup short-circuit', async () => {
    const r = await resolvePlanScope({ harnessSlug: 'all', workspaceId: 'ws-xyz' });
    // For the all/papercup branch the supplied workspaceId is honored verbatim.
    expect(r).toEqual({ workspaceId: 'ws-xyz', harnessSlug: HOME});
  });
});

describe('resolvePlanScope — explicit workspaceId short-circuit (concrete slug)', () => {
  it('a concrete hive slug + explicit workspaceId never hits the projects table', async () => {
    const { lookup, calls } = lookupReturning('ws-from-projects');
    const r = await resolvePlanScope({ harnessSlug: 'my-harness', workspaceId: 'ws-7', lookup });
    expect(r).toEqual({ workspaceId: 'ws-7', harnessSlug: 'my-harness' });
    // The explicit workspace pins the scope — no projects lookup.
    expect(calls).toEqual([]);
    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-7', 'my-harness');
  });
});

describe('resolvePlanScope — concrete slug, workspace from the projects table', () => {
  it('resolves the slug to its single projects-table workspace', async () => {
    const { lookup, calls } = lookupReturning('ws-from-projects');
    const r = await resolvePlanScope({ harnessSlug: 'my-harness', lookup });
    expect(r).toEqual({ workspaceId: 'ws-from-projects', harnessSlug: 'my-harness' });
    expect(calls).toEqual(['my-harness']);
    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-from-projects', 'my-harness');
  });

  it('canonicalizes a member harness to its hive-home slug before using the plan key', async () => {
    hiveMocks.potHomeSlugForHarness.mockImplementation(async (_workspaceId, harnessSlug) =>
      harnessSlug === 'oddsmith' ? 'oddsmith-hive' : harnessSlug,
    );
    const { lookup } = lookupReturning('papercusp-workspace');
    const r = await resolvePlanScope({ harnessSlug: 'oddsmith', lookup });
    expect(r).toEqual({ workspaceId: 'papercusp-workspace', harnessSlug: 'oddsmith-hive' });
  });
});

describe('resolvePlanScope — fail-loud (NO silent default)', () => {
  it('an unregistered slug is a typed caller error — never silently defaults', async () => {
    const { lookup } = lookupReturning(); // no projects matches
    const { registryFallback } = registryReturning(null); // not in the registry either
    const error = await resolvePlanScope({ harnessSlug: 'zzz-never-registered', lookup, registryFallback })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(error).toMatchObject({
      message: expect.stringContaining('not registered in the harness registry'),
    });
    expect(isUnknownPlanScopeError(error)).toBe(true);
  });

  it('a same-name collision across workspaces (2+ matches) THROWS', async () => {
    const { lookup } = lookupReturning('ws-a', 'ws-b');
    await expect(resolvePlanScope({ harnessSlug: 'dupe', lookup })).rejects.toThrow(
      /resolves to 2 workspaces/,
    );
  });

  it('a registered slug with no hive home THROWS — plans cannot be scoped to a standalone harness', async () => {
    hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
    const { lookup } = lookupReturning('ws-standalone');
    const error = await resolvePlanScope({ harnessSlug: 'standalone', lookup })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(error).toMatchObject({ message: expect.stringContaining('plans are Hive-scoped') });
    expect(isUnknownPlanScopeError(error)).toBe(true);
  });
});

describe('resolvePlanScope — registry fallback (projects miss → authoritative harness_registry)', () => {
  it('0 projects matches → resolves via the registry fallback (the hive/generic case)', async () => {
    const { lookup, calls } = lookupReturning(); // projects projection has no row
    const { registryFallback, calls: regCalls } = registryReturning('hive-workspace');
    const r = await resolvePlanScope({
      harnessSlug: 'offsite-planner-demo',
      lookup,
      registryFallback,
    });
    expect(r).toEqual({ workspaceId: 'hive-workspace', harnessSlug: 'offsite-planner-demo' });
    expect(calls).toEqual(['offsite-planner-demo']); // projects consulted first
    expect(regCalls).toEqual(['offsite-planner-demo']); // then the registry fallback
  });

  it('a projects hit short-circuits — the registry fallback is NOT consulted', async () => {
    const { lookup } = lookupReturning('ws-from-projects');
    const { registryFallback, calls: regCalls } = registryReturning('should-not-be-used');
    const r = await resolvePlanScope({ harnessSlug: 'dept-project', lookup, registryFallback });
    expect(r).toEqual({ workspaceId: 'ws-from-projects', harnessSlug: 'dept-project' });
    expect(regCalls).toEqual([]); // projects resolved → fallback skipped
  });
});

describe('fill_workspace_id_from_projects', () => {
  it.each(['', '   ', '*', 'all', HOME, undefined])(
    'returns PAPERCUSP_WORKSPACE_ID for the home/wildcard scope %s (WI-148 part-B)',
    async (slug) => {
      const { lookup, calls } = lookupReturning('ws-should-not-be-used');
      const ws = await fill_workspace_id_from_projects(slug, { lookup });
      expect(ws).toBe(PAPERCUSP_WORKSPACE_ID);
      // The papercup scope never consults the projects table — it short-circuits
      // to PAPERCUSP_WORKSPACE_ID (WI-148 part-B flip, lockstep with mig 295).
      expect(calls).toEqual([]);
    },
  );

  it('returns the single matching workspace_id', async () => {
    const { lookup } = lookupReturning('ws-only');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-only');
  });

  it('dedups identical matches down to one workspace', async () => {
    const { lookup } = lookupReturning('ws-dup', 'ws-dup');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-dup');
  });

  it('0 projects matches + registry miss → null (caller fails loud)', async () => {
    const { lookup } = lookupReturning();
    const { registryFallback } = registryReturning(null);
    expect(await fill_workspace_id_from_projects('unknown', { lookup, registryFallback })).toBeNull();
  });

  it('0 projects matches → falls back to the authoritative registry resolver', async () => {
    const { lookup } = lookupReturning();
    const { registryFallback, calls } = registryReturning('hive-ws');
    expect(await fill_workspace_id_from_projects('hive-x', { lookup, registryFallback })).toBe('hive-ws');
    expect(calls).toEqual(['hive-x']);
  });

  it('THROWS on a same-name collision across distinct workspaces', async () => {
    const { lookup } = lookupReturning('ws-a', 'ws-b');
    await expect(fill_workspace_id_from_projects('dupe', { lookup })).rejects.toThrow(
      /Ambiguous same-name collision/,
    );
  });

  it('ignores empty/blank workspace_ids in the match set', async () => {
    const { lookup } = lookupReturning('', '   ', 'ws-real');
    expect(await fill_workspace_id_from_projects('some-harness', { lookup })).toBe('ws-real');
  });
});
