/**
 * _create_from_repo.test.ts — the create-Pot-from-GitHub-URL composition
 * (pot-from-github-url P-006). Every seam faked — no git, PG, swarm, GitHub.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createPotFromRepo,
  deriveSlugs,
  type CreatePotFromRepoDeps,
} from './_create_from_repo';
import type { RepoHiveLookup } from '../../harness/lookup-hive-for-repo';

const URL = 'https://github.com/acme/shop';

const NONE_LOOKUP: RepoHiveLookup = {
  kind: 'none',
  coords: { owner: 'acme', repo: 'shop', githubRepositoryId: 100, private: false, identityResolved: true },
  bindingUnverified: false,
};

function fakes(over: Partial<CreatePotFromRepoDeps> = {}) {
  const calls = {
    cloned: [] as Array<{ url: string; opts: Record<string, unknown> }>,
    potCreated: [] as string[],
    memberCreated: [] as { slug: string; pot: string; path: string; workspaceId: string }[],
    removedDirs: [] as string[],
    removedHomes: [] as string[],
    publishes: [] as Record<string, unknown>[],
    beaconWrites: [] as { pot: string; consent: boolean }[],
    gitSyncSeeds: [] as Record<string, unknown>[],
    hiveGitModeApplies: [] as { ws: string; pot: string; order: number }[],
    registry: [{ slug: 'existing', path: '/x' }] as Record<string, unknown>[],
  };
  const deps: CreatePotFromRepoDeps = {
    lookup: async () => NONE_LOOKUP,
    // P-018: no GitHub in unit tests — unknown facts, no workspace default.
    fetchIntegrationFacts: async () => null,
    integrationModePolicyDefault: () => null,
    clone: async (url: string, opts?: Record<string, unknown>) => {
      calls.cloned.push({ url, opts: opts ?? {} });
      return {
        path: `/clones/${String(opts?.destName ?? 'shop')}`,
        parsed: { owner: 'acme', repo: 'shop', cloneUrl: 'https://github.com/acme/shop.git' },
        defaultBranch: 'develop',
      };
    },
    buildBlueprint: async (slug) => ({ ok: true, blueprint: { id: slug, extends: 'coding' }, detection: { toolchains: ['node'] } }),
    createPot: async (o) => {
      calls.potCreated.push(o.slug);
      return { ok: true, slug: o.slug, path: `/hives/${o.slug}` };
    },
    createMember: async (a) => {
      calls.memberCreated.push({ slug: a.slug, pot: a.pot, path: a.path, workspaceId: a.workspaceId });
      return { ok: true };
    },
    publish: async (o) => {
      calls.publishes.push(o as unknown as Record<string, unknown>);
      return { announced: true, reachablePeers: 1, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 }, localBindings: { created: 1, existed: 0, failed: 0 } };
    },
    loadRegistry: async () => ({ projects: calls.registry as never }),
    mutateRegistry: (async (fn: (r: { projects: never[] }) => unknown) => {
      // apply over a snapshot so the coord-stamp step is observable
      const next = fn({ projects: calls.registry as never });
      calls.registry = (next as { projects: Record<string, unknown>[] }).projects;
      return undefined as never;
    }) as never,
    removePotHome: async (slug) => {
      calls.removedHomes.push(slug);
    },
    rmDir: async (p) => {
      calls.removedDirs.push(p);
    },
    setBeaconConsent: async (_ws, pot, consent) => {
      calls.beaconWrites.push({ pot, consent });
    },
    seedGitSync: async (o) => {
      calls.gitSyncSeeds.push(o as unknown as Record<string, unknown>);
      return {
        seeded: true,
        active: true,
        push: true,
        pushReason: 'github_permissions_push_true — faked',
        cron: '0 3,13,23,33,43,53 * * * *',
        branch: 'develop',
      };
    },
    applyNewHiveGitMode: async (ws, pot) => {
      calls.hiveGitModeApplies.push({ ws, pot, order: calls.gitSyncSeeds.length });
      return { applied: false, reason: 'default-legacy', mode: 'legacy' };
    },
    ...over,
  };
  return { deps, calls };
}

describe('deriveSlugs', () => {
  it('uses the base when free; suffixes on collision', () => {
    expect(deriveSlugs('shop', new Set())).toEqual({ memberSlug: 'shop', potSlug: 'shop-pot' });
    expect(deriveSlugs('shop', new Set(['shop']))).toEqual({ memberSlug: 'shop-2', potSlug: 'shop-2-pot' });
    expect(deriveSlugs('shop', new Set(['shop-pot']))).toEqual({ memberSlug: 'shop-2', potSlug: 'shop-2-pot' });
  });
  it('gives up after -9', () => {
    const taken = new Set<string>(['shop']);
    for (let i = 2; i <= 9; i++) taken.add(`shop-${i}`);
    expect(deriveSlugs('shop', taken)).toBeNull();
  });
});

describe('createPotFromRepo (P-006)', () => {
  it('returns a join offer with ZERO side effects when the repo already has a pot', async () => {
    const { deps, calls } = fakes({
      lookup: async () =>
        ({
          kind: 'hive',
          coords: { owner: 'acme', repo: 'shop', identityResolved: true },
          hive: { potId: 'h', title: 'H' },
          source: 'directory',
          bindingUnverified: false,
        }) as RepoHiveLookup,
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('existing' in r)) throw new Error('expected existing');
    expect(r.existing.kind).toBe('hive');
    expect(calls.cloned).toEqual([]);
    expect(calls.potCreated).toEqual([]);
  });

  it('happy path: clone → blueprint → home → member(pot) → coords stamped → publish', async () => {
    const { deps, calls } = fakes();
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created).toMatchObject({
      potSlug: 'shop-pot',
      memberSlug: 'shop',
      memberPath: '/clones/shop',
      defaultBranch: 'develop',
      githubRepositoryId: 100,
    });
    expect(calls.potCreated).toEqual(['shop-pot']);
    expect(calls.memberCreated).toEqual([{ slug: 'shop', pot: 'shop-pot', path: '/clones/shop', workspaceId: 'ws' }]);
    // coord stamp landed on the member entry
    const member = calls.registry.find((p) => p.slug === 'shop');
    expect(member).toBeUndefined(); // member row is created by harness:create (faked) — stamp applies only when present
    // publish got the public default + the repo title
    expect(calls.publishes[0]).toMatchObject({ potSlug: 'shop-pot', visibility: 'public', title: 'acme/shop' });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('stamps github coords onto the member registry entry when present', async () => {
    const { deps, calls } = fakes();
    // harness:create registers the member row — simulate that in the fake so
    // the post-create coord stamp (step 7) has a row to land on.
    deps.createMember = async (a) => {
      calls.registry.push({ slug: a.slug, path: a.path });
      calls.memberCreated.push({ slug: a.slug, pot: a.pot, path: a.path, workspaceId: a.workspaceId });
      return { ok: true };
    };
    await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    const member = calls.registry.find((p) => p.slug === 'shop')!;
    expect(member).toMatchObject({
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
      github_default_branch: 'develop',
    });
  });

  it('threads workspaceId into member creation so non-default pot homes resolve (EI-3018)', async () => {
    const { deps, calls } = fakes();
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws-non-default' }, deps);
    expect(r.ok).toBe(true);
    expect(calls.memberCreated).toEqual([
      { slug: 'shop', pot: 'shop-pot', path: '/clones/shop', workspaceId: 'ws-non-default' },
    ]);
  });

  it('test-verify is OPT-IN: default runTests=false reaches detection (hardening D-001)', async () => {
    const seen: boolean[] = [];
    const { deps } = fakes({
      buildBlueprint: async (_slug, _path, o) => {
        seen.push(o.runTests);
        return { ok: true, blueprint: { id: 'x', extends: 'coding' } };
      },
    });
    await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    await createPotFromRepo({ githubUrl: URL, slug: 'shop-x', runTests: true, workspaceId: 'ws' }, deps);
    expect(seen).toEqual([false, true]);
  });

  it('public repo (coords.private=false) → publishes with visibility:public (discoverable listing)', async () => {
    const { deps, calls } = fakes();
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.publishes[0]).toMatchObject({ potSlug: 'shop-pot', visibility: 'public' });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('private repo (coords.private=true) → publishes with visibility:invite (hidden listing, NOT skipped)', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({
        ...NONE_LOOKUP,
        coords: { ...NONE_LOOKUP.coords, private: true },
      }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    // a private repo still publishes — as a hidden, secret-gated invite listing
    expect(calls.publishes[0]).toMatchObject({ potSlug: 'shop-pot', visibility: 'invite', repoIsPrivate: true });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('blueprint failure removes the clone and reports', async () => {
    const { deps, calls } = fakes({ buildBlueprint: async () => ({ ok: false, error: 'no test cmd' }) });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'blueprint_failed' });
    expect(calls.removedDirs).toContain('/clones/shop');
    expect(calls.potCreated).toEqual([]);
  });

  it('member-create failure rolls back the home + clone', async () => {
    const { deps, calls } = fakes({ createMember: async () => ({ ok: false, error: 'boom' }) });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'member_create_failed' });
    expect(calls.removedHomes).toEqual(['shop-pot']);
    expect(calls.removedDirs).toEqual(expect.arrayContaining(['/hives/shop-pot', '/clones/shop']));
  });

  it('clone errors map to clone_<code>', async () => {
    const { deps } = fakes({
      clone: async () => ({ code: 'auth_required' as const, message: 'auth pls' }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'clone_auth_required' });
  });

  it('slug collisions auto-suffix (OQ-1) and propagate bindingUnverified', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({ ...NONE_LOOKUP, bindingUnverified: true }),
      loadRegistry: async () => ({ projects: [{ slug: 'shop', path: '/x' }] as never }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created.memberSlug).toBe('shop-2');
    expect(r.created.potSlug).toBe('shop-2-pot');
    expect(r.bindingUnverified).toBe(true);
    expect(calls.potCreated).toEqual(['shop-2-pot']);
  });

  it('clone destination follows the derived member slug, so force/collision retries do not reuse the raw repo dir', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () => ({ projects: [{ slug: 'shop', path: '/old' }] as never }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, force: true, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created.memberSlug).toBe('shop-2');
    expect(r.created.memberPath).toBe('/clones/shop-2');
    expect(calls.cloned[0]).toMatchObject({ url: URL, opts: { destName: 'shop-2' } });
  });

  it('force creates past an existing pot, flagged duplicateOf (P-008)', async () => {
    const { deps, calls } = fakes({
      lookup: async () =>
        ({
          kind: 'hive',
          coords: { owner: 'acme', repo: 'shop', githubRepositoryId: 100, identityResolved: true },
          hive: { potId: 'h', title: 'H', hivePubkey: 'HPK' },
          source: 'directory',
          bindingUnverified: false,
        }) as RepoHiveLookup,
    });
    const r = await createPotFromRepo({ githubUrl: URL, force: true, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created.duplicateOf).toEqual({ kind: 'hive', potPubkey: 'HPK', source: 'directory' });
    expect(calls.potCreated).toEqual(['shop-pot']);
  });

  it('WI-3577: synthesizes a self memberLink when publish returns a potPubkey but no memberLinks (the duplicateOf/cupboard-hit registry-race shape)', async () => {
    const { deps } = fakes({
      lookup: async () =>
        ({
          kind: 'hive',
          coords: { owner: 'acme', repo: 'shop', githubRepositoryId: 100, identityResolved: true },
          hive: { potId: 'h', title: 'H', hivePubkey: 'HPK' },
          source: 'cupboard',
          bindingUnverified: false,
        }) as RepoHiveLookup,
      // Mirrors the real publishListingForMeta output on the bug's repro shape:
      // hivePubkey resolved, but the registry re-read found no members → memberLinks absent.
      publish: async () => ({
        announced: true,
        reachablePeers: 1,
        hivePubkey: 'aGl2ZXB1YmtleWJhc2U2NHBhZGRlZHRvMzJieXRlcyEh',
        cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 },
      }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, force: true, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('publish' in r)) throw new Error('expected publish outcome');
    const publish = r.publish as { memberLinks?: string[] };
    expect(publish.memberLinks).toBeDefined();
    expect(publish.memberLinks?.length).toBe(1);
    expect(publish.memberLinks?.[0]).toContain('acme%2Fshop');
  });

  it('records REAL step transitions against the progressId (P-008 hardening)', async () => {
    const recorded: string[] = [];
    const { deps } = fakes({
      recordStep: (id, step, status) => {
        recorded.push(`${id}:${step}:${status}`);
      },
    });
    await createPotFromRepo({ githubUrl: URL, progressId: 'pid-1', workspaceId: 'ws' }, deps);
    expect(recorded).toEqual([
      'pid-1:lookup:running',
      'pid-1:lookup:done',
      'pid-1:clone:running',
      'pid-1:clone:done',
      'pid-1:detect:running',
      'pid-1:detect:done',
      'pid-1:create:running',
      'pid-1:create:done',
      'pid-1:seed:skipped', // knowledge-packs P-005: no learnings detected in the fake repo
      'pid-1:publish:running',
      'pid-1:publish:done',
    ]);
  });

  it('progress: a clone failure settles clone:error; no progressId = zero recording', async () => {
    const recorded: string[] = [];
    const { deps } = fakes({
      clone: async () => ({ code: 'not_found' as const, message: 'nope' }),
      recordStep: (_id, step, status) => {
        recorded.push(`${step}:${status}`);
      },
    });
    await createPotFromRepo({ githubUrl: URL, progressId: 'pid-2', workspaceId: 'ws' }, deps);
    expect(recorded).toEqual(['lookup:running', 'lookup:done', 'clone:running', 'clone:error']);

    recorded.length = 0;
    const { deps: deps2 } = fakes({
      recordStep: (_id, step, status) => {
        recorded.push(`${step}:${status}`);
      },
    });
    await createPotFromRepo({ githubUrl: URL, slug: 'shop-noprog', workspaceId: 'ws' }, deps2);
    expect(recorded).toEqual([]);
  });

  it('publish failure NEVER fails the create', async () => {
    const { deps } = fakes({
      publish: async () => {
        throw new Error('cupboard exploded');
      },
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.publish).toMatchObject({ announced: false, error: 'cupboard exploded' });
  });

  it('into-pot mode: no new home; member joins the existing pot; republish scoped to the new repo (P-009)', async () => {
    const republishes: Record<string, unknown>[] = [];
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async (o: Record<string, unknown>) => {
        republishes.push(o);
        return { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } };
      }) as never,
    });
    const r = await createPotFromRepo({ githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created).toMatchObject({ potSlug: 'mypot', memberSlug: 'shop' });
    expect(calls.potCreated).toEqual([]); // no new home
    expect(calls.memberCreated).toEqual([{ slug: 'shop', pot: 'mypot', path: '/clones/shop', workspaceId: 'ws' }]);
    expect(calls.publishes).toEqual([]); // the NEW-pot publish path is not used
    expect(republishes[0]).toMatchObject({ potSlug: 'mypot', onlyRepoIds: [100] });
  });

  it('into-pot mode fails fast on a non-pot scope (no clone)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () => ({ projects: [{ slug: 'plain', path: '/p' }] }) as never,
    });
    const r = await createPotFromRepo({ githubUrl: URL, intoPot: 'plain', workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'hive_not_found' });
    expect(calls.cloned).toEqual([]);
  });

  // ── B-07 / C-2: beacon-publish consent recorded in the publish flow ──────────

  it('auto-ENABLES the beacon for a NEW PUBLIC pot (no opt-in — derived from visibility)', async () => {
    const { deps, calls } = fakes();
    // Default repo is public → visibility 'public' → beacon auto-ON, no client input.
    await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(calls.beaconWrites).toEqual([{ pot: 'shop-pot', consent: true }]);
  });

  it('auto-DISABLES the beacon for a NEW PRIVATE (invite) pot (a hidden pot never broadcasts)', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({
        ...NONE_LOOKUP,
        coords: { ...NONE_LOOKUP.coords, private: true },
      }),
    });
    await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    // The pot publishes (as a hidden invite listing) but the beacon is written OFF.
    expect(calls.publishes[0]).toMatchObject({ visibility: 'invite' });
    expect(calls.beaconWrites).toEqual([{ pot: 'shop-pot', consent: false }]);
  });

  it('into-pot mode records NO beacon write (the existing home keeps its standing setting)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async () => ({ announced: true, cupboard: { attempted: false } })) as never,
    });
    await createPotFromRepo({ githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws' }, deps);
    expect(calls.beaconWrites).toEqual([]);
  });

  it('a beacon-consent write failure NEVER fails the create', async () => {
    const { deps } = fakes({
      setBeaconConsent: async () => {
        throw new Error('settings store down');
      },
    });
    // Public repo → the auto-beacon write fires (and throws) — the create still succeeds.
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
  });

  // ── git-sync-any-pot B-01: member routine seeding (P-001/P-008 seed side) ────

  it('seeds the member git-sync routine on the new-pot path (creator side, coords + branch threaded)', async () => {
    const { deps, calls } = fakes();
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.gitSyncSeeds).toEqual([
      {
        workspaceId: 'ws',
        installSlug: 'shop',
        joinerSide: false,
        entry: {
          slug: 'shop',
          path: '/clones/shop',
          hive_slug: 'shop-pot',
          github_remote: 'https://github.com/acme/shop.git',
          github_repository_id: 100,
          github_default_branch: 'develop',
        },
      },
    ]);
    // the outcome is REPORTED on the result, next to publish
    expect(r.gitSync).toMatchObject({ seeded: true, push: true, branch: 'develop' });
  });

  describe("P-017 (D-007): the 'where should the agents' work go' answer", () => {
    function withChooser(result?: Record<string, unknown>, suite: string | null = 'npm test') {
      const chooses: Record<string, unknown>[] = [];
      const suiteLookups: Array<{ slug: string; ws: string }> = [];
      const { deps, calls } = fakes({
        resolveSuiteCommand: async (slug, ws) => {
          suiteLookups.push({ slug, ws });
          return suite;
        },
        chooseIntegrationMode: (async (i: Record<string, unknown>) => {
          chooses.push(i);
          return result ?? { ok: true, mode: 'review', fork: { url: 'https://github.com/bot/shop.git', created: true } };
        }) as never,
      });
      return { deps, calls, chooses, suiteLookups };
    }

    it("'review' on a new pot: forks via the chooser with pot home, member slug, main repo and the pot's test suite", async () => {
      const { deps, chooses, suiteLookups } = withChooser();
      const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'review' }, deps);
      expect(r.ok).toBe(true);
      if (!r.ok || !('created' in r)) throw new Error('expected created');
      expect(suiteLookups).toEqual([{ slug: 'shop', ws: 'ws' }]);
      expect(chooses).toEqual([
        {
          workspaceId: 'ws',
          potHomeSlug: 'shop-pot',
          harnessSlug: 'shop',
          mode: 'review',
          greenCmd: 'npm test',
          forkRemote: null,
          upstreamRemote: 'https://github.com/acme/shop.git',
          // the fake clone path has no .gitmodules (WI-10006107)
          hasSubmodules: false,
        },
      ]);
      expect(r.integrationMode).toMatchObject({ ok: true, mode: 'review' });
    });

    it("'direct' (and no answer) never forks", async () => {
      for (const integrationMode of ['direct', undefined] as const) {
        const { deps, chooses } = withChooser();
        const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode }, deps);
        expect(r.ok).toBe(true);
        if (!r.ok || !('created' in r)) throw new Error('expected created');
        expect(chooses).toEqual([]);
        expect(r.integrationMode).toBeUndefined();
      }
    });

    it("'review' when adding a repo INTO an existing pot does not re-decide that pot's mode", async () => {
      const { deps, chooses } = withChooser();
      deps.loadRegistry = async () => ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never;
      deps.republish = (async () => ({ announced: true, cupboard: { attempted: false } })) as never;
      const r = await createPotFromRepo(
        { githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws', integrationMode: 'review' },
        deps,
      );
      expect(r.ok).toBe(true);
      expect(chooses).toEqual([]);
    });

    it('a refusal (no test suite) is REPORTED and never fails the create', async () => {
      const { deps } = withChooser(
        { ok: false, error: 'green_cmd_required', message: 'a working copy needs a test suite' },
        null,
      );
      const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'review' }, deps);
      expect(r.ok).toBe(true);
      if (!r.ok || !('created' in r)) throw new Error('expected created');
      expect(r.integrationMode).toMatchObject({ ok: false, error: 'green_cmd_required' });
    });

    it('a chooser that THROWS is reported as fork_create_failed, create still ok', async () => {
      const { deps } = fakes({
        resolveSuiteCommand: async () => 'npm test',
        chooseIntegrationMode: async () => {
          throw new Error('github 502');
        },
      });
      const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'review' }, deps);
      expect(r.ok).toBe(true);
      if (!r.ok || !('created' in r)) throw new Error('expected created');
      expect(r.integrationMode).toEqual({ ok: false, error: 'fork_create_failed', message: 'github 502' });
    });
  });

  it('seeds on the P-009 into-pot path too (member of the EXISTING home)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async () => ({ announced: true, cupboard: { attempted: false } })) as never,
    });
    const r = await createPotFromRepo({ githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.gitSyncSeeds).toEqual([
      expect.objectContaining({
        installSlug: 'shop',
        joinerSide: false,
        entry: expect.objectContaining({ slug: 'shop', hive_slug: 'mypot' }),
      }),
    ]);
    expect(r.gitSync).toMatchObject({ seeded: true });
  });

  it('a git-sync seeding failure NEVER fails the create — reported as { reason: error }', async () => {
    const { deps } = fakes({
      seedGitSync: async () => {
        throw new Error('routines pg down');
      },
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.gitSync).toEqual({ seeded: false, reason: 'error', message: 'routines pg down' });
    expect(r.publish).toMatchObject({ announced: true }); // the rest of the create proceeded
  });

  it('P-503: applies the new-hive default hiveGit.mode to a NEW pot, BEFORE the git-sync seed', async () => {
    const { deps, calls } = fakes({
      applyNewHiveGitMode: async (ws, pot) => {
        calls.hiveGitModeApplies.push({ ws, pot, order: calls.gitSyncSeeds.length });
        return { applied: true, mode: 'bridged' };
      },
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.hiveGitModeApplies).toEqual([{ ws: 'ws', pot: r.created.potSlug, order: 0 }]);
    expect(calls.gitSyncSeeds).toHaveLength(1);
    expect(r.hiveGitMode).toEqual({ applied: true, mode: 'bridged' });
  });

  it('P-503: a throwing mode-default NEVER fails the create', async () => {
    const { deps } = fakes({
      applyNewHiveGitMode: async () => {
        throw new Error('policy read down');
      },
    });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.hiveGitMode).toEqual({ applied: false, reason: 'error', message: 'policy read down' });
    expect(r.gitSync).toMatchObject({ seeded: true });
  });

  it('P-503: an into-pot add never touches the existing home mode', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async () => ({ announced: true, cupboard: { attempted: false } })) as never,
    });
    const r = await createPotFromRepo({ githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.hiveGitModeApplies).toEqual([]);
    expect(r.hiveGitMode).toBeUndefined();
  });

  it('a FAILED create never reaches the seeder (member-create failure)', async () => {
    const { deps, calls } = fakes({ createMember: async () => ({ ok: false, error: 'boom' }) });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(false);
    expect(calls.gitSyncSeeds).toEqual([]);
  });

  it('into-pot member-create failure removes only the clone (the existing home is untouched)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'mypot', path: '/h', harness_kind: 'hive' }] }) as never,
      createMember: async () => ({ ok: false, error: 'nope' }),
    });
    const r = await createPotFromRepo({ githubUrl: URL, intoPot: 'mypot', workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'member_create_failed' });
    expect(calls.removedHomes).toEqual([]);
    expect(calls.removedDirs).toEqual(['/clones/shop']);
  });
});

/**
 * WI-1861 regression pin: defaultCreateMember must carry harness:create's
 * failure DETAIL (parseError / errors[] / missing) through into its error
 * string — the narrow `{ error }` pick swallowed the validation errors, so a
 * live 'blueprint invalid' red reached the gate artifact with the failing
 * field unnamed (undiagnosable from the smoke output alone).
 */
describe('defaultCreateMember failure-detail passthrough (WI-1861)', () => {
  const call = async (payload: unknown) => {
    vi.resetModules();
    vi.doMock('../harness/create', () => ({
      default: { handler: async () => ({ content: [{ text: JSON.stringify(payload) }] }) },
    }));
    const { defaultCreateMember } = await import('./_create_from_repo');
    return defaultCreateMember({ slug: 's', path: '/p', blueprint: { id: 's' }, pot: 'h', workspaceId: 'ws-test' });
  };

  it('ok:true passes through clean', async () => {
    expect(await call({ ok: true })).toEqual({ ok: true });
  });

  it("'blueprint invalid' carries errors[] and parseError into the error string", async () => {
    const r = await call({
      ok: false,
      error: 'blueprint invalid',
      parseError: undefined,
      errors: [{ code: 'unknown-op', path: 'spine.0', message: 'op nope:x not registered' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('blueprint invalid');
    expect(r.error).toContain('unknown-op');
    expect(r.error).toContain('nope:x');
  });

  it('dependency-gate failures carry missing{} through', async () => {
    const r = await call({
      ok: false,
      error: 'blueprint tool dependencies unmet',
      missing: { tools: ['cup:spawn'] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cup:spawn');
  });

  it('unparseable response still fails closed', async () => {
    vi.resetModules();
    vi.doMock('../harness/create', () => ({
      default: { handler: async () => ({ content: [{ text: 'not-json' }] }) },
    }));
    const { defaultCreateMember } = await import('./_create_from_repo');
    const r = await defaultCreateMember({ slug: 's', path: '/p', blueprint: { id: 's' }, pot: 'h', workspaceId: 'ws-test' });
    expect(r).toEqual({ ok: false, error: 'harness:create returned an unparseable response' });
  });
});

/**
 * WI-3646 FOLLOW-UP regression pin: `harness:create`'s real Zod field for
 * create-time Pot membership is `pot` (harness/create.ts's schema + its
 * `args.pot` D-010 handling), NOT `hive`. `defaultCreateMember` must translate
 * its own `{ pot }` argument into the tool's `{ pot }` field — every OTHER
 * test in this file mocks `harness/create`'s handler wholesale (or fakes
 * `createMember` entirely), so none of them ever asserted on the actual arg
 * name reaching the real tool, which is exactly how this shipped broken: a
 * fresh (non-linkExisting) `createPotFromRepo` call silently never stamped
 * `hive_slug` on the new member harness, reproduced live on a fresh-deb rig
 * (content_bidir/planpart_bidir still probe=0 post the linkExisting-branch
 * fix in `_create.ts`, which is a distinct branch this bug bypasses entirely).
 */
describe('defaultCreateMember translates `hive` to harness:create’s real `pot` field (WI-3646 follow-up)', () => {
  it('passes pot (not hive) through to harness:create, so hive_slug actually gets stamped', async () => {
    vi.resetModules();
    let capturedArgs: Record<string, unknown> | undefined;
    vi.doMock('../harness/create', () => ({
      default: {
        handler: async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return { content: [{ text: JSON.stringify({ ok: true }) }] };
        },
      },
    }));
    const { defaultCreateMember } = await import('./_create_from_repo');
    const r = await defaultCreateMember({
      slug: 'hello-world',
      path: '/clones/hello-world',
      blueprint: { id: 'hello-world' },
      pot: 'hello-world-pot',
      workspaceId: 'ws-test',
    });
    expect(r).toEqual({ ok: true });
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs?.pot).toBe('hello-world-pot');
    expect(capturedArgs?.hive).toBeUndefined();
    expect(capturedArgs?.slug).toBe('hello-world');
  });
});

describe('P-018: recommend and lock the integration answer from checkable repo facts', () => {
  const NO_WRITE = { canWrite: false, isPrivate: false, defaultBranch: 'main', mainRequiresPr: null, otherCommitters: null, hasCi: null };

  function withFacts(facts: Record<string, unknown> | null, policyDefault: 'direct' | 'review' | null = null) {
    const chooses: Record<string, unknown>[] = [];
    const probed: Array<{ owner: string; repo: string }> = [];
    const { deps, calls } = fakes({
      fetchIntegrationFacts: async (owner, repo) => {
        probed.push({ owner, repo });
        return facts as never;
      },
      integrationModePolicyDefault: () => policyDefault,
      resolveSuiteCommand: async () => 'npm test',
      chooseIntegrationMode: (async (i: Record<string, unknown>) => {
        chooses.push(i);
        return { ok: true, mode: 'review', fork: { url: 'https://github.com/bot/shop.git', created: true } };
      }) as never,
    });
    return { deps, calls, chooses, probed };
  }

  it('no write access + answer "direct" → refused before any side effect, with the one-line reason', async () => {
    const { deps, calls, chooses, probed } = withFacts(NO_WRITE);
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'direct' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'integration_mode_locked' });
    expect(!r.ok && r.message).toContain("You can't push to acme/shop");
    expect(probed).toEqual([{ owner: 'acme', repo: 'shop' }]);
    expect(calls.cloned).toEqual([]);
    expect(calls.potCreated).toEqual([]);
    expect(chooses).toEqual([]);
  });

  it('no write access + no answer → the working copy is applied (locked), and the recommendation is reported', async () => {
    const { deps, chooses } = withFacts(NO_WRITE);
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(chooses).toHaveLength(1);
    expect(chooses[0]).toMatchObject({ mode: 'review' });
    expect(r.integrationRecommendation).toMatchObject({ recommended: 'review', locked: true, rule: 'no-write-access' });
  });

  it('an unlocked recommendation never overrides the answer: other committers recommend review, "direct" stays direct', async () => {
    const { deps, chooses } = withFacts({ ...NO_WRITE, canWrite: true, otherCommitters: true });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'direct' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(chooses).toEqual([]);
    expect(r.integrationRecommendation).toMatchObject({ recommended: 'review', locked: false, rule: 'other-committers' });
  });

  it("the workspace default (PotControlPolicy.newPotIntegrationMode) applies only when the creator didn't answer", async () => {
    const unanswered = withFacts(null, 'review');
    const r1 = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws' }, unanswered.deps);
    expect(r1.ok).toBe(true);
    expect(unanswered.chooses).toHaveLength(1);

    const answered = withFacts(null, 'review');
    const r2 = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', integrationMode: 'direct' }, answered.deps);
    expect(r2.ok).toBe(true);
    expect(answered.chooses).toEqual([]);
  });

  it('into-pot adds never probe (the existing pot keeps its answer)', async () => {
    const { deps, probed, calls } = withFacts(NO_WRITE);
    calls.registry.push({ slug: 'home-pot', path: '/hives/home-pot', harness_kind: 'hive' });
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: 'ws', intoPot: 'home-pot', integrationMode: 'direct' }, deps);
    expect(r.ok).toBe(true);
    expect(probed).toEqual([]);
  });
});
