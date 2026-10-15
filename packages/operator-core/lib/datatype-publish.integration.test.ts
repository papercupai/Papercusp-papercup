/**
 * datatype-publish.integration.test — the D-010 shared-tier publish + moderation lifecycle
 * against real Postgres (migration 425 `review_status`). Proves: publish marks PENDING
 * without touching LOCAL usability; the moderation queue spans workspaces (admin handle);
 * approve/reject transition only a pending row; a published datatype stays locally usable.
 *
 * Mirrors the datatype-registry fixture: createOrgTestDb + apply 421 + 425.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertDatatype,
  getDatatype,
  getGenericKindDatatype,
  publishDatatype,
  listPendingPublishedDatatypes,
  moderatePublishedDatatype,
  findSimilarPublishedDatatypes,
  listApprovedPublishedDatatypes,
  installPublishedDatatype,
} from './datatype-registry-store';

const { createOrgTestDb } = await import('../test/_org-test-db');

async function declare(db: OrgTestDb, ws: string, id: string) {
  return upsertDatatype(db.adminSql, {
    id,
    workspaceId: ws,
    title: id,
    description: `the ${id} datatype`,
    tier: 'generic-kind', nature: 'work', audience: 'agent',
    workItemKind: id,
  });
}

describe('datatype publish + moderation lifecycle (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // createOrgTestDb applies the FULL migration set (incl. 421/425/426 and the D-007
    // pot-rename 506/523), so datatype_registry already exists in its post-rename
    // (pot_slug) shape. (Replaying 421 verbatim here is now redundant AND re-runs its
    // old hive_slug index against the post-523 schema, 42703-ing "column hive_slug
    // does not exist".)
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declare ⇒ review_status none; publish ⇒ pending; local usability unchanged', async () => {
    const ws = 'ws-pub';
    const declared = await declare(db, ws, 'bet');
    expect(declared.reviewStatus).toBe('none');
    expect(declared.published).toBe(false);

    const published = await publishDatatype(db.adminSql, ws, 'bet');
    expect(published).not.toBeNull();
    expect(published!.reviewStatus).toBe('pending');
    expect(published!.published).toBe(true);

    // LOCAL usability is untouched — the kind is still an active generic-kind locally.
    const local = await getGenericKindDatatype(db.adminSql, ws, 'bet');
    expect(local).not.toBeNull();
    expect(local!.status).toBe('active');
    expect(local!.reviewStatus).toBe('pending');

    // Re-publish is a no-op (already in a lifecycle).
    expect(await publishDatatype(db.adminSql, ws, 'bet')).toBeNull();
  });

  it('the moderation queue spans workspaces (admin handle)', async () => {
    const a = 'ws-q-a';
    const b = 'ws-q-b';
    await declare(db, a, 'wager');
    await declare(db, b, 'forecast');
    await publishDatatype(db.adminSql, a, 'wager');
    await publishDatatype(db.adminSql, b, 'forecast');

    const pending = await listPendingPublishedDatatypes(db.adminSql);
    const ids = pending.map((d) => `${d.workspaceId}/${d.id}`);
    expect(ids).toContain('ws-q-a/wager');
    expect(ids).toContain('ws-q-b/forecast');
  });

  it('approve ⇒ approved; reject ⇒ rejected; only a pending row transitions', async () => {
    const ws = 'ws-mod';
    await declare(db, ws, 'edge');
    await declare(db, ws, 'spread');
    await publishDatatype(db.adminSql, ws, 'edge');
    await publishDatatype(db.adminSql, ws, 'spread');

    const approved = await moderatePublishedDatatype(db.adminSql, ws, 'edge', 'approve');
    expect(approved!.reviewStatus).toBe('approved');
    const rejected = await moderatePublishedDatatype(db.adminSql, ws, 'spread', 'reject');
    expect(rejected!.reviewStatus).toBe('rejected');

    // Re-moderating a non-pending row is a no-op.
    expect(await moderatePublishedDatatype(db.adminSql, ws, 'edge', 'reject')).toBeNull();

    // Neither is in the pending queue any more.
    const stillPending = (await listPendingPublishedDatatypes(db.adminSql)).map((d) => `${d.workspaceId}/${d.id}`);
    expect(stillPending).not.toContain('ws-mod/edge');
    expect(stillPending).not.toContain('ws-mod/spread');

    // A re-declare of an approved datatype PRESERVES its review_status (doesn't reset it).
    await declare(db, ws, 'edge');
    expect((await getDatatype(db.adminSql, ws, 'edge'))!.reviewStatus).toBe('approved');
  });

  it('global dedup: finds a PUBLISHED datatype across workspaces, ignores local-only ones', async () => {
    // ws-A publishes a "kelly-stake" datatype (→ pending, globally visible to dedup).
    await upsertDatatype(db.adminSql, {
      id: 'kelly-stake',
      workspaceId: 'ws-g-a',
      title: 'Kelly stake',
      description: 'optimal stake sizing from edge and bankroll',
      tier: 'generic-kind', nature: 'work', audience: 'agent',
      workItemKind: 'kelly-stake',
    });
    await publishDatatype(db.adminSql, 'ws-g-a', 'kelly-stake');
    // ws-B declares a near-identical one but does NOT publish it (review_status none).
    await upsertDatatype(db.adminSql, {
      id: 'kelly-stake-local',
      workspaceId: 'ws-g-b',
      title: 'Kelly stake local',
      description: 'optimal stake sizing from edge and bankroll',
      tier: 'generic-kind', nature: 'work', audience: 'agent',
      workItemKind: 'kelly-stake-local',
    });

    const hits = await findSimilarPublishedDatatypes(db.adminSql, {
      title: 'Kelly stake',
      description: 'optimal stake sizing from edge and bankroll',
    });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('kelly-stake'); // the PUBLISHED one (cross-workspace)
    expect(ids).not.toContain('kelly-stake-local'); // unpublished ⇒ not in the global namespace
  });

  it('distribution: publish → approve → catalog lists it → install into another workspace', async () => {
    const src = 'ws-dist-src';
    const target = 'ws-dist-target';
    await upsertDatatype(db.adminSql, {
      id: 'parlay',
      workspaceId: src,
      title: 'Parlay',
      description: 'a multi-leg combined bet',
      tier: 'generic-kind', nature: 'work', audience: 'agent',
      workItemKind: 'parlay',
      payloadSchema: { type: 'object', properties: { legs: { type: 'array' } }, required: ['legs'] },
    });
    await publishDatatype(db.adminSql, src, 'parlay');

    // Not in the approved catalog until moderated.
    expect((await listApprovedPublishedDatatypes(db.adminSql)).map((d) => d.id)).not.toContain('parlay');
    // Can't install a not-yet-approved datatype.
    expect((await installPublishedDatatype(db.adminSql, 'parlay', target)).ok).toBe(false);

    await moderatePublishedDatatype(db.adminSql, src, 'parlay', 'approve');
    expect((await listApprovedPublishedDatatypes(db.adminSql)).map((d) => d.id)).toContain('parlay');

    // Install into a DIFFERENT workspace — it lands as a usable LOCAL datatype there.
    const installed = await installPublishedDatatype(db.adminSql, 'parlay', target);
    expect(installed.ok).toBe(true);
    if (!installed.ok) throw new Error('unreachable');
    expect(installed.datatype.workspaceId).toBe(target);
    expect(installed.datatype.reviewStatus).toBe('none'); // a fresh LOCAL copy, not re-published
    expect(installed.datatype.published).toBe(false);
    expect(installed.datatype.payloadSchema).toMatchObject({ type: 'object' });

    // It's usable locally in the target (the create gate's fetch-by-kind sees it).
    const local = await getGenericKindDatatype(db.adminSql, target, 'parlay');
    expect(local).not.toBeNull();
    expect(local!.status).toBe('active');

    // Re-installing is idempotent (already present).
    expect((await installPublishedDatatype(db.adminSql, 'parlay', target)).ok).toBe(false);
  });

  it('RLS (migration 426): approved rows are GLOBALLY readable; non-approved stay workspace-isolated', async () => {
    // Seed via admin (RLS bypass): an APPROVED datatype + a LOCAL one, both in ws-rls-owner.
    await upsertDatatype(db.adminSql, {
      id: 'rls-approved', workspaceId: 'ws-rls-owner', title: 'Approved', description: 'globally shared',
      tier: 'generic-kind', nature: 'work', audience: 'agent', workItemKind: 'rls-approved',
    });
    await publishDatatype(db.adminSql, 'ws-rls-owner', 'rls-approved');
    await moderatePublishedDatatype(db.adminSql, 'ws-rls-owner', 'rls-approved', 'approve');
    await upsertDatatype(db.adminSql, {
      id: 'rls-private', workspaceId: 'ws-rls-owner', title: 'Private', description: 'workspace local',
      tier: 'generic-kind', nature: 'work', audience: 'agent', workItemKind: 'rls-private',
    });

    // A DIFFERENT workspace (ws-rls-other), through the RLS-ENFORCED app role:
    await db.appSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', 'ws-rls-other', true)`);
      const visible = (
        await tx<{ id: string }[]>`SELECT id FROM harness_shared.datatype_registry WHERE id IN ('rls-approved','rls-private')`
      ).map((r) => r.id);
      expect(visible).toContain('rls-approved'); // approved ⇒ globally readable (426)
      expect(visible).not.toContain('rls-private'); // non-approved ⇒ NOT visible across workspaces
    });
  });

  it('RLS: writes stay workspace-scoped — a cross-workspace insert is rejected (WITH CHECK)', async () => {
    // ws-rls-other cannot insert a row OWNED by another workspace — the base policy's WITH CHECK
    // (migration 421) is unchanged by 426 (which is SELECT-only). The whole tx is rejected.
    await expect(
      db.appSql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', 'ws-rls-other', true)`);
        await tx`INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier)
                 VALUES ('sneaky', 'ws-rls-owner', 't', 'd', 'generic-kind')`;
      }),
    ).rejects.toThrow();
  });
});
