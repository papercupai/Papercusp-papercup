import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import publishEvent from '../agent-tools/cupboard/publish-event';
import { installEventFromCupboardCore } from '../cupboard/install-event-core';
import { registryInputFromPackage } from '../cupboard/install-event-io';
import { claimEventKey } from '../event-key-registry-store';
import { validateSavedEventPayload } from './saved-event-type';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as Sql | null, ws: 'ws-local-event-types' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async original => ({
  ...await original<typeof import('../workspace-registry')>(),
  activeWorkspaceId: () => h.ws, backgroundWorkspaceIds: () => [h.ws],
}));
vi.mock('../agent-tools/coordination/identity', async (original) => ({
  ...(await original<typeof import('../agent-tools/coordination/identity')>()),
  resolveAgentIdentity: () => ({ workspaceId: h.ws, ownerId: 'su-local-event-author', ownerLabel: 'Author', userId: null, source: 'static-client' }),
}));
vi.mock('../cupboard/resolve-repo-coords', async original => ({ ...await original<object>(),
  fetchGithubRepoMeta: vi.fn(async () => { throw new Error('export must not contact GitHub'); }),
}));
vi.mock('../cupboard/publish-listing', async original => ({ ...await original<object>(),
  publishListingToCupboard: vi.fn(async () => { throw new Error('export must not submit a listing'); }),
}));
import emit from '../agent-tools/events/emit';
import { getEventKey } from '../event-key-registry-store';
import { readSavedEventCatalog, saveEventType } from './saved-event-type';
import { mergeInstalledEventCatalog, keyMatchesCatalog } from './await/catalog';
import { registerAwait } from './await/store';
import { setAutoPumpEnabledForTests } from './await/engine';

describe('locally authored event type (real Postgres)', () => {
  let db: OrgTestDb;
  let previousPump: boolean;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    previousPump = setAutoPumpEnabledForTests(false);
  }, 180_000);
  afterAll(async () => {
    setAutoPumpEnabledForTests(previousPump);
    h.sql = null;
    await db?.cleanup();
  });


  it('exports an agent-saved key through the publish tool and preserves its payload contract on a fresh install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saved-event-share-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    const originalWs = h.ws;
    process.env.PAPERCUSP_HOME = root; _resetPapercuspRootForTests();
    try {
      const ctx = { workspaceId: h.ws, role: 'operator' } as never;
      await emit.handler({ event: 'local:share-ready', announce: true, announceScope: 'global', save: true,
        description: 'Share a typed event', payloadSchema: { type: 'object', required: ['ready'], properties: { ready: { const: true } } } } as never, ctx);
      const published = await publishEvent.handler({ eventKey: 'local:share-ready', githubUrl: 'https://github.com/demo/events', exportOnly: true } as never, ctx);
      const out = 'data' in published ? published.data as { ok: boolean; exportedOnly: boolean; ref: string; exportedTo: string }
        : JSON.parse((published.content[0] as { text: string }).text);
      expect(out, JSON.stringify(out, null, 2)).toMatchObject({ ok: true, exportedOnly: true });
      process.env.PAPERCUSP_HOME = join(root, 'fresh'); _resetPapercuspRootForTests();
      const installed = await installEventFromCupboardCore({ githubUrl: 'https://github.com/demo/events', listingRef: out.ref }, {
        cloneRepo: async (_url, destination) => cp(out.exportedTo, join(destination, out.ref), { recursive: true }),
        fetchAtSha: async () => { throw new Error('unpinned install'); },
        listTreeBlobs: async () => { throw new Error('unpinned install'); }, tmpDir: () => root,
      });
      const targetWs = 'ws-event-share-target';
      const claimed = await claimEventKey(db.adminSql, registryInputFromPackage(installed, targetWs));
      expect(claimed.claimed).toBe(true);
      expect(await getEventKey(db.adminSql, targetWs, installed.eventKey)).toMatchObject({
        payloadSchema: { required: ['ready'] }, contributor: expect.stringContaining('cupboard:'),
      });
      await expect(validateSavedEventPayload(targetWs, installed.eventKey, { ready: false }, db.adminSql)).rejects.toThrow('event_payload_invalid');
      await expect(validateSavedEventPayload(targetWs, installed.eventKey, { ready: true }, db.adminSql)).resolves.toBeUndefined();
    } finally {
      await db.adminSql`DELETE FROM harness_shared.event_key_registry WHERE (workspace_id = ${originalWs} AND event_key = 'local:share-ready') OR workspace_id = 'ws-event-share-target'`;
      h.ws = originalWs;
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = priorHome;
      _resetPapercuspRootForTests(); await rm(root, { recursive: true, force: true });
    }
  });

  it('declares without firing, reloads from durable storage, then validates and queues exactly one wake', async () => {
    const invoke = async (args: Record<string, unknown>) => {
      const result = await emit.handler(args as never, { workspaceId: h.ws, role: 'operator' } as never);
      if (!('content' in result)) throw new Error('expected an MCP tool result');
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const declared = await invoke({ event: 'local:smoke-ready', announce: true, announceScope: 'global', save: true,
      title: 'Smoke ready', payloadSchema: { type: 'object', properties: { ready: { const: true } }, required: ['ready'] } });
    expect(declared).toMatchObject({ announced: true, saved: true, event: 'local:smoke-ready' });
    const firesBefore = await db.adminSql`SELECT * FROM harness_shared.event_key_fires WHERE event_key = 'local:smoke-ready'`;
    expect(firesBefore).toHaveLength(0);
    // A fresh store read is independent of the declaration handler's process memory.
    expect(await getEventKey(db.adminSql, h.ws, 'local:smoke-ready')).toMatchObject({ title: 'Smoke ready', contributor: 'local:su-local-event-author' });
    expect(keyMatchesCatalog('local:smoke-ready', mergeInstalledEventCatalog(await readSavedEventCatalog(h.ws, db.adminSql)).entries)).toBe(true);
    await registerAwait({ subscriberId: 'su-local-event-waiter', eventKey: declared.event, minSleepSec: 0,
      wakeHandle: { kind: 'plan-run', runId: 999 }, timeoutSec: 600, timeoutBehavior: 'wake' });
    await expect(invoke({ event: declared.event, payload: { ready: false } })).rejects.toThrow('event_payload_invalid');
    expect(await db.adminSql`SELECT * FROM harness_shared.event_wake_deliveries WHERE event_key = 'local:smoke-ready'`).toHaveLength(0);
    expect(await invoke({ event: declared.event, payload: { ready: true } })).toMatchObject({ woken: 1, waiters: 1 });
    expect(await db.adminSql`SELECT subscriber_id, payload FROM harness_shared.event_wake_deliveries WHERE event_key = 'local:smoke-ready'`)
      .toEqual([expect.objectContaining({ subscriber_id: 'su-local-event-waiter', payload: { ready: true } })]);
    await expect(saveEventType({ workspaceId: h.ws, ownerId: 'someone-else', event: declared.event }, db.adminSql)).rejects.toThrow('event_type_owned');
    await saveEventType({ workspaceId: h.ws, ownerId: 'su-local-event-author', event: declared.event, eventStatus: 'retired' }, db.adminSql);
    expect(await readSavedEventCatalog(h.ws, db.adminSql)).toEqual([]);
  });
});
