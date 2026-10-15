/** Independent L1s and PG listeners exercise the same bus/adapter/tag mapper used
 * by each host worker. This is a database-boundary test, not a host-process test.
 * The inbox factory is the production readInbox over the real coordination log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { Cache } from '@papercusp/cache';
import { createInvalidationBus } from '@papercusp/sync/server';
import { createPgListenSource, createPgNotifySink } from '@papercusp/sync/server/pg';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { configureCoordLog, resetCoordLog, coordWorkspaceId } from '../agent-tools/coordination/log';
import { readInbox } from '../agent-tools/coordination/messages';
import { tableNameFromChangedEvent, tagsForTableChange } from '../events/cache-eca-rule';
import { installOperatorCache, resetOperatorCacheForTests } from './instance';
import { getWorkItemDetail, listWorkItems, type WorkItem, type WorkItemDetail } from '../work-items';
import getTool from '../agent-tools/work_items/get';
import listTool from '../agent-tools/work_items/list';

// mutation-probe.sh substitutes a copied module at its original relative path
// inside an isolated repo mirror. Ordinary suite runs use the real module.
const { cachedRead, __setCachedReadEnabledForTests }: typeof import('./cached-read') =
  await import(process.env.PAPERCUSP_CACHE_READ_PROBE ?? './cached-read');

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, workspace: '' }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async original => ({
  ...(await original<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.workspace,
}));

let org: OrgTestDb;
const WS = 'cache-freshness-integration';
const FOREIGN_WS = 'cache-freshness-foreign';
const HARNESS = 'cache-freshness';
let now = 0;
const workers: ReturnType<typeof makeWorker>[] = [];

function makeWorker() {
  const cache = new Cache({ clock: () => now });
  const bus = createInvalidationBus({
    listen: createPgListenSource({
      open: () => postgres(org.adminDsn, { max: 1, idle_timeout: 0 }),
      onListen: () => cache.clearL1(),
    }),
    notify: createPgNotifySink({ getSql: () => org.adminSql }),
    bridge: (name, args) => {
      const table = tableNameFromChangedEvent(name);
      if (table && typeof args?.workspace_id === 'string') {
        cache.invalidateByTags(args.workspace_id, tagsForTableChange(table, args.id));
      }
      return [];
    },
  });
  // Reads are awaited serially: the injected request scope models one worker's
  // active request, while the cache/listener instances remain independent.
  return { cache, bus, async inbox(owner: string, workspace = WS) {
    h.workspace = workspace;
    installOperatorCache(cache);
    return cachedRead({ workspaceId: coordWorkspaceId() }, {
      tool: 'coord:inbox', key: { owner }, tags: ['coord_event_log'], hardTtlMs: 100,
    }, () => readInbox(owner));
  }, async detail(id: string, workspace = WS) {
    h.workspace = workspace;
    installOperatorCache(cache);
    return cachedRead({ workspaceId: workspace }, {
      tool: 'work_items:get', key: { id, harness: HARNESS, detail: true },
      // Same dependencies as the production detail handler; retain broad tags.
      tags: ['work_items', `work_items:${id}`, 'coord_links', 'coord_threads', 'coord_thread_posts'],
      hardTtlMs: 100,
    }, () => getWorkItemDetail(id, HARNESS));
  }, async list(workspace = WS) {
    h.workspace = workspace;
    installOperatorCache(cache);
    return cachedRead({ workspaceId: workspace }, {
      tool: 'work_items:list', key: { harness: HARNESS, kind: 'feature' },
      tags: ['work_items'], hardTtlMs: 100,
    }, () => listWorkItems({ harness: HARNESS, kind: 'feature' }));
  }, async toolDetail(id: string, workspace = WS) {
    h.workspace = workspace;
    installOperatorCache(cache);
    const result = await getTool.handler(
      getTool.args.parse({ id, harness: HARNESS, detail: true }),
      { isSuperuser: true, uiClientId: 'su-freshness-reader', workspaceId: workspace } as never,
    ) as { data: { results: Array<{ ok: boolean; availability?: string; workItem?: WorkItemDetail }> } };
    const row = result.data.results[0];
    if (row.availability === 'absent') return null;
    expect(row.ok).toBe(true);
    expect(row.workItem).toBeDefined();
    return row.workItem!;
  }, async toolList(workspace = WS) {
    h.workspace = workspace;
    installOperatorCache(cache);
    const result = await listTool.handler(
      listTool.args.parse({ harness: HARNESS, kind: 'feature', q: 'handler-' }),
      { isSuperuser: true, uiClientId: 'su-freshness-reader', workspaceId: workspace } as never,
    ) as { data: WorkItem[] };
    return result.data;
  } };
}

async function seed(id: string, to: string[], workspace = WS, connectionWorkspace = workspace) {
  await org.adminSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${connectionWorkspace}, true)`;
    const log = new PgCoordLog({ getSql: () => tx as unknown as Sql, getWorkspaceId: () => workspace, ensureSchema: async () => {} });
    await log.appendLine('messages', 'freshness-writer', {
      msg_id: id, kind: 'message', from: 'freshness-writer', to,
      summary: id, ts: new Date().toISOString(),
    });
  });
}
const ids = (rows: Awaited<ReturnType<typeof readInbox>>) => rows.map(row => row.msg_id);

beforeAll(async () => {
  org = await createOrgTestDb();
  // Exercise the current migrated producer; never replay an older function body
  // here, which would hide a future notification-scope regression.
  h.sql = org.adminSql;
  h.workspace = WS;
  configureCoordLog(new PgCoordLog({ getSql: () => org.adminSql, getWorkspaceId: () => h.workspace, ensureSchema: async () => {} }));
  setFlagOverridesForTest({ 'papercusp-cache-layer': true });
  __setCachedReadEnabledForTests(true);
  workers.push(makeWorker(), makeWorker());
  await Promise.all(workers.map(worker => worker.bus.start()));
});
afterAll(async () => {
  await Promise.all(workers.map(worker => worker.bus.stop()));
  __setCachedReadEnabledForTests(false);
  resetOperatorCacheForTests();
  setFlagOverridesForTest(null);
  resetCoordLog();
  await org?.cleanup();
});

describe('cached inbox freshness over independent PG listeners', () => {
  it('invalidates the row workspace when a coordination writer has an empty or foreign connection context', async () => {
    const owner = 'row-workspace-owner';
    for (const worker of workers) {
      expect(await worker.inbox(owner)).toEqual([]);
      expect(await worker.inbox(owner, FOREIGN_WS)).toEqual([]);
    }
    await seed('empty-connection-scope', [owner], WS, '');
    for (const worker of workers) {
      await expect.poll(async () => ids(await worker.inbox(owner))).toContain('empty-connection-scope');
      expect(await worker.inbox(owner, FOREIGN_WS)).toEqual([]);
    }
    await seed('foreign-connection-scope', [owner], WS, FOREIGN_WS);
    for (const worker of workers) {
      await expect.poll(async () => ids(await worker.inbox(owner))).toContain('foreign-connection-scope');
      expect(await worker.inbox(owner, FOREIGN_WS)).toEqual([]);
    }
  });

  it('delivers a committed directed write and broadcast to both L1s without leaking another recipient', async () => {
    for (const worker of workers) {
      expect(await worker.inbox('alice')).toEqual([]);
      expect(await worker.inbox('bob')).toEqual([]);
    }
    await seed('direct-alice', ['alice']);
    await expect.poll(async () => ids(await workers[0].inbox('alice'))).toContain('direct-alice');
    await expect.poll(async () => ids(await workers[1].inbox('alice'))).toContain('direct-alice');
    for (const worker of workers) expect(ids(await worker.inbox('bob'))).not.toContain('direct-alice');
    await seed('all-readers', ['*']);
    for (const worker of workers) {
      await expect.poll(async () => ids(await worker.inbox('bob'))).toContain('all-readers');
      await expect.poll(async () => ids(await worker.inbox('alice'))).toContain('all-readers');
    }
  });

  it('bounds a missed notification by hard TTL and clears missed writes on listener reconnect', async () => {
    const worker = workers[1];
    await worker.inbox('alice');
    await worker.bus.stop();
    await seed('during-outage', ['alice']);
    expect(ids(await worker.inbox('alice'))).not.toContain('during-outage');
    now = 101;
    expect(ids(await worker.inbox('alice'))).toContain('during-outage');
    await seed('before-reconnect', ['alice']);
    expect(ids(await worker.inbox('alice'))).not.toContain('before-reconnect');
    await worker.bus.start();
    expect(ids(await worker.inbox('alice'))).toContain('before-reconnect');
  });

  it('keeps identical recipient keys and broadcasts isolated by workspace on both workers', async () => {
    for (const worker of workers) expect(await worker.inbox('alice', FOREIGN_WS)).toEqual([]);
    await seed('local-tenant-guard', ['alice']);
    await seed('foreign-direct', ['alice'], FOREIGN_WS);
    await seed('foreign-broadcast', ['*'], FOREIGN_WS);
    for (const worker of workers) {
      await expect.poll(async () => ids(await worker.inbox('alice', FOREIGN_WS)))
        .toEqual(expect.arrayContaining(['foreign-direct', 'foreign-broadcast']));
      const local = ids(await worker.inbox('alice'));
      expect(local).toContain('local-tenant-guard');
      expect(local).not.toContain('foreign-direct');
      expect(local).not.toContain('foreign-broadcast');
      expect(ids(await worker.inbox('alice', FOREIGN_WS))).not.toContain('local-tenant-guard');
    }
  });

  it('refreshes real work-item lists and details after row and thread commits without tenant reuse', async () => {
    for (const workspace of [WS, FOREIGN_WS]) {
      // The migrated table's PK is (harness_slug, feature_id), not workspace.
      // Reusing the local lookup key in the foreign workspace must return null.
      const id = workspace === WS ? 'F-freshness' : 'F-foreign';
      await org.adminSql.begin(async tx => {
        await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
        await tx`INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
          VALUES (${workspace}, ${HARNESS}, ${id}, 'feature', ${workspace}, 'open', 1000, 1000)`;
      });
    }
    for (const worker of workers) {
      expect((await worker.detail('F-freshness'))?.title).toBe(WS);
      expect(await worker.detail('F-freshness', FOREIGN_WS)).toBeNull();
      expect((await worker.detail('F-foreign', FOREIGN_WS))?.title).toBe(FOREIGN_WS);
      expect((await worker.list()).map(row => row.title)).toEqual([WS]);
      expect((await worker.list(FOREIGN_WS)).map(row => row.title)).toEqual([FOREIGN_WS]);
    }
    await org.adminSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      await tx`UPDATE harness_shared.work_items SET title='updated local', updated_ts=2000
        WHERE workspace_id=${WS} AND feature_id='F-freshness' AND harness_slug=${HARNESS}`;
    });
    for (const worker of workers) {
      await expect.poll(async () => (await worker.detail('F-freshness'))?.title).toBe('updated local');
      await expect.poll(async () => (await worker.list()).map(row => row.title)).toEqual(['updated local']);
      expect(await worker.detail('F-freshness', FOREIGN_WS)).toBeNull();
      expect((await worker.detail('F-foreign', FOREIGN_WS))?.title).toBe(FOREIGN_WS);
      expect((await worker.list(FOREIGN_WS)).map(row => row.title)).toEqual([FOREIGN_WS]);
      expect((await worker.detail('F-freshness'))?.posts).toEqual([]);
    }
    await org.adminSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      await tx`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
        VALUES (${WS}, 'freshness-thread', 'feature', ${HARNESS + '#F-freshness'})`;
      await tx`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
        VALUES (${WS}, 'freshness-thread', 'freshness-writer', 'new detail dependency')`;
    });
    for (const worker of workers) {
      await expect.poll(async () => (await worker.detail('F-freshness'))?.posts.map(post => post.body))
        .toEqual(['new detail dependency']);
      expect(await worker.detail('F-freshness', FOREIGN_WS)).toBeNull();
      expect((await worker.detail('F-foreign', FOREIGN_WS))?.posts).toEqual([]);
    }
  });

  it('uses the current get/list handlers cache keys and dependencies across both workers', async () => {
    await org.adminSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      await tx`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
        VALUES (${WS}, ${HARNESS}, 'F-handler', 'feature', 'handler-initial', 'open', 1000, 1000)`;
    });
    for (const worker of workers) {
      expect((await worker.toolDetail('F-handler'))?.title).toBe('handler-initial');
      expect((await worker.toolList()).map(row => row.title)).toEqual(['handler-initial']);
      expect(await worker.toolDetail('F-handler', FOREIGN_WS)).toBeNull();
      expect(await worker.toolList(FOREIGN_WS)).toEqual([]);
    }
    await org.adminSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      await tx`UPDATE harness_shared.work_items SET title='handler-updated', updated_ts=2000
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id='F-handler'`;
      await tx`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
        VALUES (${WS}, 'handler-thread', 'feature', ${HARNESS + '#F-handler'})`;
      await tx`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
        VALUES (${WS}, 'handler-thread', 'freshness-writer', 'handler-thread-first')`;
    });
    for (const worker of workers) {
      await expect.poll(async () => (await worker.toolDetail('F-handler'))?.title).toBe('handler-updated');
      await expect.poll(async () => (await worker.toolList()).map(row => row.title)).toEqual(['handler-updated']);
      await expect.poll(async () => (await worker.toolDetail('F-handler'))?.posts.map(post => post.body))
        .toEqual(['handler-thread-first']);
      expect(await worker.toolDetail('F-handler', FOREIGN_WS)).toBeNull();
      expect(await worker.toolList(FOREIGN_WS)).toEqual([]);
    }
    // A thread-only commit must refresh cached detail even without a work-item
    // row update; table-wide work_items invalidation cannot mask this dependency.
    await org.adminSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      await tx`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
        VALUES (${WS}, 'handler-thread', 'freshness-writer', 'handler-thread-second')`;
    });
    for (const worker of workers) {
      await expect.poll(async () => (await worker.toolDetail('F-handler'))?.posts.map(post => post.body))
        .toEqual(['handler-thread-first', 'handler-thread-second']);
    }
  });
});
