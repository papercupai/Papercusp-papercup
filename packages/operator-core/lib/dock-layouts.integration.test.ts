/**
 * dock-layouts.integration.test.ts — the per-(workspace, user, layout_name) dock
 * layout store against REAL Postgres (testcontainer). Plan: dockview-migration-
 * plan-v4 §4.
 *
 * The store owns its OWN postgres pool built from getHarnessAdminUrl() (admin /
 * RLS-bypass; the table IS RLS-enabled but the store scopes by the explicit PK
 * columns in every WHERE). The maintained baseline fixture routes discovery and db-org's
 * notification pool to that SAME database; mocking discovery alone leaves
 * getOrgPg on the ambient store. We exercise the durable SQL directly via the
 * (workspaceId, userId) principal — NOT getUserIdForLayouts, which needs a live
 * session/cookie.
 *
 * Pinned against the full migrated baseline schema:
 *   - getLayout read-miss seeds + INSERTs the default, then reads the row back;
 *   - saveLayout ON CONFLICT (workspace_id, user_id, layout_name) upsert + the
 *     jsonb body round-trip (sql.json — must NOT double-encode to a jsonb string);
 *   - optimistic concurrency: a conditional UPDATE with the right expectedUpdatedTs
 *     wins; a stale one throws LayoutConflictError and writes nothing;
 *   - per-(workspace,user,name) scoping / isolation;
 *   - listLayouts ordering (updated_ts DESC), deleteLayout, resetLayout reseed;
 *   - getLastUsedPhase / setLastUsedPhase upsert.
 *
 * The pure validators (validateLayoutDoc / isWellFormedLayout / the default-seed
 * builders) are no-PG and belong to the unit tier; this file exercises only the
 * durable paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';
import { getOrgPg, parseStoreIdentity, STORE_IDENTITY_SQL } from '@papercusp/db-org';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { getLongLivedAdminPool, _resetLongLivedAdminPoolsForTests } from './long-lived-admin-pool';

const mod = await import('./dock-layouts');
const {
  getLayout,
  saveLayout,
  deleteLayout,
  listLayouts,
  resetLayout,
  getLastUsedPhase,
  setLastUsedPhase,
  defaultDashboardLayout,
  LayoutConflictError,
} = mod;
const { createOrgTestDb } = await import('../test/_org-test-db');

let n = 0;
const principal = () => ({ workspaceId: `wb_${++n}_${randomBytes(2).toString('hex')}`, userId: `u_${++n}` });

function simpleLayout(): import('./dock-layouts').LayoutDoc {
  return {
    schemaVersion: 1,
    root: { kind: 'tabs', id: 't', activePanelId: 'p1', panels: [{ id: 'p1', type: 'data:git' }] },
    floating: [],
  };
}

describe('dock-layouts store (real PG)', () => {
  let db: OrgTestDb;
  let route: BaselineCoordFixture;

  beforeAll(async () => {
    db = await createOrgTestDb();
    route = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  }, 120_000);

  afterAll(async () => {
    try {
      if (route) {
        await getLongLivedAdminPool('dock-layouts').end({ timeout: 5 });
        _resetLongLivedAdminPoolsForTests();
      }
    } finally {
      try { await route?.dispose(); }
      finally { await db?.cleanup(); }
    }
  }, 30_000);

  it('getLayout seeds + persists the default on a read miss, then reads the same row back', async () => {
    const p = principal();
    const seeded = await getLayout(p, 'dashboard');
    expect(seeded.workspaceId).toBe(p.workspaceId);
    expect(seeded.userId).toBe(p.userId);
    expect(seeded.layoutName).toBe('dashboard');
    expect(seeded.layoutJson).toEqual(defaultDashboardLayout(''));
    // Second call hits the persisted row with the same created_ts (not reseeded).
    const again = await getLayout(p, 'dashboard');
    expect(again.createdTs).toBe(seeded.createdTs);
    expect(again.layoutJson).toEqual(seeded.layoutJson);
  });

  it('saveLayout round-trips a jsonb body as a real object (not a double-encoded string)', async () => {
    const p = principal();
    const doc = simpleLayout();
    const saved = await saveLayout(p, 'default', doc);
    expect(saved.layoutJson).toEqual(doc);
    // Assert the column is jsonb-typed object, not a stringified scalar.
    const [{ kind }] = await db.adminSql<{ kind: string }[]>`
      SELECT jsonb_typeof(layout_json) AS kind
        FROM harness_shared.harness_dock_layouts
       WHERE workspace_id = ${p.workspaceId} AND user_id = ${p.userId} AND layout_name = 'default'
    `;
    expect(kind).toBe('object');
  });

  it('uses the isolated layout store for the real notification pool and delivery', async () => {
    const expected = parseStoreIdentity(await db.adminSql.unsafe(STORE_IDENTITY_SQL));
    expect(expected?.database).toBe(db.dbName);
    const layoutStore = parseStoreIdentity(await getLongLivedAdminPool('dock-layouts').unsafe(STORE_IDENTITY_SQL));
    const notificationStore = parseStoreIdentity(await getOrgPg().sql.unsafe(STORE_IDENTITY_SQL));
    expect(layoutStore).toEqual(expected);
    expect(notificationStore).toEqual(expected);

    const p = principal();
    const notifications: Array<{ name: string; args?: { workspaceId?: string; name?: string } }> = [];
    const listener = await db.adminSql.listen('sync_invalidate', (payload) => {
      notifications.push(JSON.parse(payload));
    });
    try {
      await saveLayout(p, 'notification-control', simpleLayout());
      await expect.poll(() => notifications.some((event) =>
        event.name === 'dockLayouts.byName'
        && event.args?.workspaceId === p.workspaceId
        && event.args?.name === 'notification-control',
      )).toBe(true);
      expect((await getLayout(p, 'notification-control')).layoutJson).toEqual(simpleLayout());
    } finally {
      await listener.unlisten();
    }
  });

  it('saveLayout ON CONFLICT upserts (same PK overwrites, created_ts preserved)', async () => {
    const p = principal();
    const first = await saveLayout(p, 'default', simpleLayout());
    const changed = simpleLayout();
    changed.root = { kind: 'tabs', id: 't2', activePanelId: 'p2', panels: [{ id: 'p2', type: 'data:issues' }] };
    const second = await saveLayout(p, 'default', changed);
    expect(second.layoutJson).toEqual(changed);
    expect(second.createdTs).toBe(first.createdTs); // ON CONFLICT keeps created_ts (EXCLUDED only touches the rest)
    // Still exactly one row.
    const rows = await db.adminSql`
      SELECT 1 FROM harness_shared.harness_dock_layouts
       WHERE workspace_id = ${p.workspaceId} AND user_id = ${p.userId} AND layout_name = 'default'
    `;
    expect(rows).toHaveLength(1);
  });

  it('optimistic concurrency: a correct expectedUpdatedTs updates; a stale one throws and writes nothing', async () => {
    const p = principal();
    const base = await saveLayout(p, 'default', simpleLayout());
    // Correct expected ts → succeeds.
    const next = simpleLayout();
    next.root = { kind: 'tabs', id: 'tn', activePanelId: 'pn', panels: [{ id: 'pn', type: 'data:agents' }] };
    const updated = await saveLayout(p, 'default', next, base.updatedTs);
    expect(updated.layoutJson).toEqual(next);
    expect(updated.updatedTs).not.toBe(base.updatedTs);

    // Stale expected ts (the original) → LayoutConflictError, no write.
    const racing = simpleLayout();
    racing.root = { kind: 'tabs', id: 'tx', activePanelId: 'px', panels: [{ id: 'px', type: 'data:logs' }] };
    await expect(saveLayout(p, 'default', racing, base.updatedTs)).rejects.toBeInstanceOf(LayoutConflictError);
    // The body is still the successful one, not the racing one.
    const current = await getLayout(p, 'default');
    expect(current.layoutJson).toEqual(next);
  });

  it('is scoped per (workspace, user, layout_name) — neighbors are independent', async () => {
    const a = principal();
    const b = { workspaceId: a.workspaceId, userId: `${a.userId}-other` };
    const docA = simpleLayout();
    const docB = simpleLayout();
    docB.root = { kind: 'tabs', id: 'b', activePanelId: 'pb', panels: [{ id: 'pb', type: 'data:features' }] };
    await saveLayout(a, 'default', docA);
    await saveLayout(b, 'default', docB);
    expect((await getLayout(a, 'default')).layoutJson).toEqual(docA);
    expect((await getLayout(b, 'default')).layoutJson).toEqual(docB);
    // A different layout_name for the same principal is a distinct row.
    const named = simpleLayout();
    named.root = { kind: 'tabs', id: 'n', activePanelId: 'pn', panels: [{ id: 'pn', type: 'data:git' }] };
    await saveLayout(a, 'secondary', named);
    expect((await getLayout(a, 'default')).layoutJson).toEqual(docA);
    expect((await getLayout(a, 'secondary')).layoutJson).toEqual(named);
  });

  it('listLayouts returns the principal\'s names newest-first; deleteLayout removes one', async () => {
    const p = principal();
    await saveLayout(p, 'first', simpleLayout());
    await new Promise((r) => setTimeout(r, 5));
    await saveLayout(p, 'second', simpleLayout());
    const names = (await listLayouts(p)).map((l) => l.name);
    expect(names).toEqual(['second', 'first']); // updated_ts DESC

    await deleteLayout(p, 'first');
    expect((await listLayouts(p)).map((l) => l.name)).toEqual(['second']);
  });

  it('resetLayout reseeds the dock default for the name', async () => {
    const p = principal();
    const custom = simpleLayout();
    custom.root = { kind: 'tabs', id: 'custom', activePanelId: 'pc', panels: [{ id: 'pc', type: 'data:git' }] };
    await saveLayout(p, 'dashboard', custom);
    const reset = await resetLayout(p, 'dashboard');
    expect(reset.layoutJson).toEqual(defaultDashboardLayout(''));
    // Persisted: a subsequent read returns the reseeded body.
    expect((await getLayout(p, 'dashboard')).layoutJson).toEqual(defaultDashboardLayout(''));
  });

  it('setLastUsedPhase upserts and getLastUsedPhase reads it; unset returns null', async () => {
    const p = principal();
    expect(await getLastUsedPhase(p, 'some-harness')).toBeNull();
    await setLastUsedPhase(p, 'some-harness', 'staging');
    expect(await getLastUsedPhase(p, 'some-harness')).toBe('staging');
    // Upsert overwrites.
    await setLastUsedPhase(p, 'some-harness', 'production');
    expect(await getLastUsedPhase(p, 'some-harness')).toBe('production');
    // Scoped by harness slug.
    expect(await getLastUsedPhase(p, 'other-harness')).toBeNull();
  });
});
