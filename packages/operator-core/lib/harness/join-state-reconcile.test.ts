/**
 * join-state-reconcile.test.ts — boot-time join self-heal (P-013). All IO
 * seam-injected (join-state lister, registry, path-exists) — no filesystem/PG.
 * Asserts the split: registered joins are left to boot-all (cosmetic record);
 * only an unregistered clone-on-disk is re-registered; no-clone is abandoned.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  reconcileJoinStates,
  ensureJoinStatesReconciledOnce,
  __resetJoinStateReconcileForTests,
} from './join-state-reconcile';
import type { HarnessRegistry } from '../harness-registry';
import type { JoinState } from './join-shared-harness';

const js = (slug: string, cloneDir?: string): JoinState =>
  ({
    slug,
    linkTopic: 't',
    steps: {} as JoinState['steps'],
    startedAt: 0,
    ...(cloneDir ? { cloneDir } : {}),
  }) as JoinState;

function fakes(states: JoinState[], registered: string[], onDisk: string[]) {
  const calls = { registry: registered.map((slug) => ({ slug, path: `/r/${slug}` })) as HarnessRegistry['projects'] };
  return {
    calls,
    opts: {
      workspaceId: 'ws',
      listJoinStates: async () => states,
      loadRegistry: async () => ({ projects: calls.registry }),
      mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
        calls.registry = fn({ projects: calls.registry }).projects;
        return undefined as never;
      }) as never,
      pathExists: (p: string) => onDisk.some((d) => p === d),
    },
  };
}

describe('reconcileJoinStates (P-013)', () => {
  it('registered join → healedByBoot, NOT re-registered (boot-all federates it; record is cosmetic)', async () => {
    const { opts, calls } = fakes([js('shop', '/clones/shop')], ['shop'], ['/clones/shop']);
    const r = await reconcileJoinStates(opts);
    expect(r.healedByBoot).toEqual(['shop']);
    expect(r.reregistered).toEqual([]);
    expect(calls.registry.map((p) => p.slug)).toEqual(['shop']); // unchanged
  });

  it('unregistered clone STILL ON DISK → re-registered (the residual boot-all cannot heal)', async () => {
    const { opts, calls } = fakes([js('ghost', '/clones/ghost')], [], ['/clones/ghost']);
    const r = await reconcileJoinStates(opts);
    expect(r.reregistered).toEqual(['ghost']);
    // Re-registered in the full link-joined shape (WI-10003277), not a bare row.
    expect(calls.registry).toContainEqual({
      slug: 'ghost',
      path: '/clones/ghost',
      joined_via_link: true,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    });
  });

  it('WI-10003277: completes a registered link-joined row an older build left short', async () => {
    const { opts, calls } = fakes([], [], []);
    const shortRow = {
      slug: 'papercusp',
      path: '/clones/papercup',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
    };
    const owned = { slug: 'mine', path: '/r/mine' };
    calls.registry = [shortRow, owned];
    const r = await reconcileJoinStates(opts);
    expect(r.enriched).toEqual(['papercusp']);
    expect(calls.registry).toEqual([
      { ...shortRow, harness_kind: 'hive', remote_hive: true, self_repo: true },
      owned, // not link-joined: never stamped
    ]);
  });

  it('WI-10003546: completes a BARE registered row (no joined_via_link) at its join-state clone dir', async () => {
    // The pre-WI-10003277 boot heal wrote `{ slug, path }` with no marker, so
    // healLinkJoinedEntries alone never recognized it (rig VM hello-world-3-pot).
    const bareRow = {
      slug: 'hello-world-3-pot',
      path: '/clones/hello-world-3-pot',
      pot_repo_key: 'hello-world-3-pot',
      pot_repo_key_source: 'local',
    };
    const { opts, calls } = fakes([js('hello-world-3-pot', '/clones/hello-world-3-pot')], [], []);
    calls.registry = [bareRow] as HarnessRegistry['projects'];
    const r = await reconcileJoinStates(opts);
    expect(r.enriched).toEqual(['hello-world-3-pot']);
    expect(r.healedByBoot).toEqual(['hello-world-3-pot']);
    expect(calls.registry).toEqual([
      { ...bareRow, joined_via_link: true, harness_kind: 'hive', remote_hive: true, self_repo: true },
    ]);
    // Idempotent: the completed row needs nothing on the next boot.
    const again = await reconcileJoinStates(opts);
    expect(again.enriched).toEqual([]);
  });

  it('WI-10003546: a bare same-slug row at a DIFFERENT path is another checkout — never stamped', async () => {
    let writes = 0;
    const other = { slug: 'shop', path: '/r/shop' };
    const r = await reconcileJoinStates({
      workspaceId: 'ws',
      listJoinStates: async () => [js('shop', '/clones/shop')],
      loadRegistry: async () => ({ projects: [other] }),
      mutateRegistry: (async () => {
        writes += 1;
        return undefined as never;
      }) as never,
    });
    expect(r.enriched).toEqual([]);
    expect(writes).toBe(0);
  });

  it('WI-10003277: no registry write when every link-joined row is already complete', async () => {
    const full = {
      slug: 'papercusp',
      path: '/clones/papercup',
      joined_via_link: true,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    };
    let writes = 0;
    const r = await reconcileJoinStates({
      workspaceId: 'ws',
      listJoinStates: async () => [],
      loadRegistry: async () => ({ projects: [full] }),
      mutateRegistry: (async () => {
        writes += 1;
        return undefined as never;
      }) as never,
    });
    expect(r.enriched).toEqual([]);
    expect(writes).toBe(0);
  });

  it('unregistered + no clone dir on disk → abandoned, reported (nothing to re-drive)', async () => {
    const { opts, calls } = fakes([js('vanished', '/clones/vanished')], [], []);
    const r = await reconcileJoinStates(opts);
    expect(r.abandoned).toEqual(['vanished']);
    expect(r.reregistered).toEqual([]);
    expect(calls.registry).toEqual([]);
  });

  it('a join-state with no cloneDir at all → abandoned (no tree to federate)', async () => {
    const { opts } = fakes([js('nocdir')], [], []);
    const r = await reconcileJoinStates(opts);
    expect(r.abandoned).toEqual(['nocdir']);
  });

  it('mixed batch is split correctly', async () => {
    const { opts } = fakes(
      [js('reg', '/clones/reg'), js('ghost', '/clones/ghost'), js('gone', '/clones/gone')],
      ['reg'],
      ['/clones/reg', '/clones/ghost'],
    );
    const r = await reconcileJoinStates(opts);
    expect(r.healedByBoot).toEqual(['reg']);
    expect(r.reregistered).toEqual(['ghost']);
    expect(r.abandoned).toEqual(['gone']);
  });

  it('idempotent: a second pass over a now-registered ghost reports healedByBoot', async () => {
    const { opts } = fakes([js('ghost', '/clones/ghost')], [], ['/clones/ghost']);
    const r1 = await reconcileJoinStates(opts);
    expect(r1.reregistered).toEqual(['ghost']);
    const r2 = await reconcileJoinStates(opts); // registry now carries ghost
    expect(r2.reregistered).toEqual([]);
    expect(r2.healedByBoot).toEqual(['ghost']);
  });

  it('a lister failure folds into result.error, never throws', async () => {
    const r = await reconcileJoinStates({
      workspaceId: 'ws',
      listJoinStates: async () => {
        throw new Error('readdir boom');
      },
      loadRegistry: async () => ({ projects: [] }),
    });
    expect(r.error).toMatch(/readdir boom/);
    expect(r.reregistered).toEqual([]);
  });
});

describe('ensureJoinStatesReconciledOnce (boot trigger)', () => {
  it('runs once per process when seams are injected (repeat calls no-op)', async () => {
    __resetJoinStateReconcileForTests();
    const lists: number[] = [];
    const seams = {
      listJoinStates: async () => {
        lists.push(1);
        return [];
      },
      loadRegistry: async () => ({ projects: [] }),
    };
    ensureJoinStatesReconciledOnce('ws', seams);
    ensureJoinStatesReconciledOnce('ws', seams);
    await vi.waitFor(() => expect(lists).toHaveLength(1)); // ran exactly once
  });

  it('WI-10003546: re-seeds git-sync after the sweep heals a row (boot-all ran git-sync reconcile first)', async () => {
    __resetJoinStateReconcileForTests();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const reseeded: string[] = [];
      let projects: HarnessRegistry['projects'] = [{ slug: 'pot', path: '/clones/pot' }];
      ensureJoinStatesReconciledOnce('ws', {
        listJoinStates: async () => [js('pot', '/clones/pot')],
        loadRegistry: async () => ({ projects }),
        mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
          projects = fn({ projects }).projects;
          return undefined as never;
        }) as never,
        reseedGitSync: async (ws) => {
          reseeded.push(ws);
        },
      });
      await vi.waitFor(() => expect(reseeded).toEqual(['ws']));
      expect(projects[0]).toMatchObject({ joined_via_link: true, remote_hive: true, self_repo: true });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('WI-10003546: no git-sync re-seed when the sweep changed nothing', async () => {
    __resetJoinStateReconcileForTests();
    const reseeded: string[] = [];
    const lists: number[] = [];
    ensureJoinStatesReconciledOnce('ws', {
      listJoinStates: async () => {
        lists.push(1);
        return [];
      },
      loadRegistry: async () => ({ projects: [] }),
      reseedGitSync: async (ws) => {
        reseeded.push(ws);
      },
    });
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(reseeded).toEqual([]);
  });

  it('no-ops under vitest WITHOUT seams (the boot-wiring guard — never touches real FS)', async () => {
    __resetJoinStateReconcileForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // No seams → the default lister would read ~/.papercusp/join-state; the
      // guard must skip entirely (no log, no warn, no real-FS read).
      ensureJoinStatesReconciledOnce('ws');
      await new Promise((r) => setTimeout(r, 5));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// WI-6554700010029282: on the dev box a stale dogfood join record
// (~/.papercusp/join-state/papercup.json, shared by every operator under $HOME)
// re-registered the packaged server's dogfood harness on every boot, even with
// PAPERCUSP_DISABLE_DOGFOOD_HIVE=1, and boot-all then opened the dev fleet's Corestore.
describe('reconcileJoinStates dogfood-hive kill switch (WI-6554700010029282)', () => {
  const DOGFOOD_WS = 'papercusp-workspace';

  it('ignores the dogfood join record (both spellings) in the dogfood workspace when the switch is set', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '1');
    try {
      const states = [js('papercup', '/clones/papercup'), js('papercusp', '/clones/papercusp'), js('shop', '/clones/shop')];
      const { opts, calls } = fakes(states, [], ['/clones/papercup', '/clones/papercusp', '/clones/shop']);
      const r = await reconcileJoinStates({ ...opts, workspaceId: DOGFOOD_WS });
      expect(r.dogfoodDisabled).toEqual(['papercup', 'papercusp']);
      expect(r.reregistered).toEqual(['shop']);
      expect(calls.registry.map((p) => p.slug)).toEqual(['shop']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still re-registers the dogfood join record when the switch is unset', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '');
    try {
      const { opts, calls } = fakes([js('papercup', '/clones/papercup')], [], ['/clones/papercup']);
      const r = await reconcileJoinStates({ ...opts, workspaceId: DOGFOOD_WS });
      expect(r.dogfoodDisabled).toEqual([]);
      expect(r.reregistered).toEqual(['papercup']);
      expect(calls.registry.map((p) => p.slug)).toContain('papercup');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves a same-named join record in another workspace alone', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '1');
    try {
      const { opts } = fakes([js('papercup', '/clones/papercup')], [], ['/clones/papercup']);
      const r = await reconcileJoinStates(opts);
      expect(r.dogfoodDisabled).toEqual([]);
      expect(r.reregistered).toEqual(['papercup']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
