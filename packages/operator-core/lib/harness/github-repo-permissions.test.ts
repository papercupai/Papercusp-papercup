import { describe, it, expect, vi } from 'vitest';
import {
  fetchRepoPushPermission,
  fetchRepoIntegrationFacts,
  type RepoPermissionsOctokit,
  type RepoIntegrationFactsOctokit,
} from './github-repo-permissions';

/** Build an injectable narrow client from a repos.get implementation. */
function client(
  get: RepoPermissionsOctokit['repos']['get'],
): RepoPermissionsOctokit {
  return { repos: { get } };
}

describe('fetchRepoPushPermission (injected client — no live GitHub calls)', () => {
  it('returns true when GitHub reports permissions.push === true', async () => {
    const get = vi.fn(async () => ({ data: { permissions: { push: true } } }));
    const out = await fetchRepoPushPermission('acme', 'widgets', { getOctokit: async () => client(get) });
    expect(out).toBe(true);
    expect(get).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
  });

  it('returns false when GitHub reports permissions.push === false', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: { permissions: { push: false } } })),
    });
    expect(out).toBe(false);
  });

  it('returns null when the response has no permissions block', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: {} })),
    });
    expect(out).toBeNull();
  });

  it('returns null when permissions is present but push is absent', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => client(async () => ({ data: { permissions: {} } })),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the request fails — 404', async () => {
    const out = await fetchRepoPushPermission('acme', 'gone', {
      getOctokit: async () =>
        client(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the request fails — rate limit (403)', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) on a network-level failure', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw new Error('connect ETIMEDOUT 140.82.0.1:443');
        }),
    });
    expect(out).toBeNull();
  });

  it('returns null when unauthenticated (getOctokit → null, the gh-not-logged-in case)', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', { getOctokit: async () => null });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when the client getter itself throws', async () => {
    const out = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () => {
        throw new Error('gh CLI exploded');
      },
    });
    expect(out).toBeNull();
  });
});

describe('fetchRepoPushPermission feeds decideGitSyncPush (the B-01 seed-time pairing)', () => {
  it('probe failure → null → the decider goes optimistic true', async () => {
    const { decideGitSyncPush } = await import('./git-sync/decide-git-sync-push');
    const permissionsPush = await fetchRepoPushPermission('acme', 'widgets', {
      getOctokit: async () =>
        client(async () => {
          throw new Error('offline');
        }),
    });
    expect(permissionsPush).toBeNull();
    const d = decideGitSyncPush({ joinerSide: false, hasUpstreamRemote: true, permissionsPush });
    expect(d.push).toBe(true);
    expect(d.reason).toMatch(/^permissions_unknown_optimistic/);
  });
});

describe('fetchRepoIntegrationFacts (P-018 — injected client, no live GitHub calls)', () => {
  function factsClient(over: {
    repo?: Record<string, unknown> | Error;
    branchProtected?: boolean | Error;
    rules?: Array<{ type?: string }> | Error;
    contributors?: Array<{ login?: string; type?: string }> | Error;
    me?: string | Error;
    workflows?: number | Error;
  }): RepoIntegrationFactsOctokit & { branchCalls: string[] } {
    const val = async <T>(v: T | Error): Promise<T> => {
      if (v instanceof Error) throw v;
      return v;
    };
    const branchCalls: string[] = [];
    return {
      branchCalls,
      repos: {
        get: async () => ({ data: await val(over.repo ?? { permissions: { push: true }, private: false, default_branch: 'main' }) }),
        getBranch: async ({ branch }) => {
          branchCalls.push(branch);
          return { data: { protected: await val(over.branchProtected ?? false) } };
        },
        getBranchRules: async () => ({ data: await val(over.rules ?? []) }),
        listContributors: async () => ({ data: await val(over.contributors ?? [{ login: 'me' }]) }),
      },
      users: { getAuthenticated: async () => ({ data: { login: await val(over.me ?? 'me') } }) },
      actions: { listRepoWorkflows: async () => ({ data: { total_count: await val(over.workflows ?? 0) } }) },
    } as RepoIntegrationFactsOctokit & { branchCalls: string[] };
  }
  const run = (oc: RepoIntegrationFactsOctokit | null) => fetchRepoIntegrationFacts('acme', 'widgets', { getOctokit: async () => oc });

  it('reads every fact from GitHub; protection is checked on the DEFAULT branch', async () => {
    const oc = factsClient({
      repo: { permissions: { push: false }, private: true, default_branch: 'trunk' },
      branchProtected: true,
      contributors: [{ login: 'me' }, { login: 'Alice' }],
      workflows: 3,
    });
    expect(await run(oc)).toEqual({
      canWrite: false,
      isPrivate: true,
      defaultBranch: 'trunk',
      mainRequiresPr: true,
      otherCommitters: true,
      hasCi: true,
    });
    expect(oc.branchCalls).toEqual(['trunk']);
  });

  it('a pull_request ruleset counts as main requiring PRs even when classic protection is off', async () => {
    expect((await run(factsClient({ rules: [{ type: 'deletion' }, { type: 'pull_request' }] }))).mainRequiresPr).toBe(true);
    expect((await run(factsClient({ rules: [{ type: 'deletion' }] }))).mainRequiresPr).toBe(false);
  });

  it('bots and the acting user (case-insensitive) are not "other committers"', async () => {
    const oc = factsClient({ me: 'Me', contributors: [{ login: 'me' }, { login: 'dependabot[bot]' }, { login: 'renovate', type: 'Bot' }] });
    expect((await run(oc)).otherCommitters).toBe(false);
  });

  it('each sub-probe fails alone: a failed probe makes only ITS fact unknown', async () => {
    const boom = new Error('rate limited');
    const facts = await run(factsClient({ contributors: boom, workflows: boom }));
    expect(facts).toMatchObject({ canWrite: true, isPrivate: false, defaultBranch: 'main', mainRequiresPr: false });
    expect(facts.otherCommitters).toBeNull();
    expect(facts.hasCi).toBeNull();
  });

  it('no auth / repo unreadable → every fact unknown, never throws', async () => {
    const unknown = { canWrite: null, isPrivate: null, defaultBranch: null, mainRequiresPr: null, otherCommitters: null, hasCi: null };
    expect(await run(null)).toEqual(unknown);
    expect(await fetchRepoIntegrationFacts('a', 'b', { getOctokit: async () => { throw new Error('gh missing'); } })).toEqual(unknown);
    const noRepo = await run(factsClient({ repo: new Error('404'), contributors: new Error('404'), workflows: new Error('404'), me: new Error('401') }));
    expect(noRepo).toEqual(unknown);
  });
});
