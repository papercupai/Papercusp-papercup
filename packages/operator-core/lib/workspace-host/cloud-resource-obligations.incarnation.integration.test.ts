/**
 * Real-Postgres regression for same-name resource recreation and stale destroy ordering.
 *
 * The fake-SQL writer tests cannot prove the unique-key conflict/update behavior or the close
 * predicate against PostgreSQL. This suite exercises the applied migration and ledger queries
 * against the real isolated test database; it never contacts a cloud provider.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import {
  closeCloudResourceObligation,
  createCloudResourceObligationCloseObserver,
  listDischargedOpenCloudResourceObligationEscalations,
  listOpenCloudResourceObligations,
  markCloudResourceObligationEscalated,
  recordCloudResourceObligation,
} from './cloud-resource-obligations';

const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('cloud resource obligation VM incarnation lifecycle (real Postgres)', () => {
  let db: OrgTestDb;
  const workspaceId = 'cloud-resource-obligation-incarnation-ws';
  const resourceId = 'pc-host-incarnation-regression-vm';
  const base = {
    workspaceId,
    provider: 'gcp' as const,
    resourceKind: 'vm',
    resourceId,
    projectId: 'papercusp-hosted-workspaces',
    zone: 'us-central1-a',
    hostId: 'host-incarnation-regression',
    graceMs: 60_000,
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('reopens a same-name VM for a new incarnation and ignores a late destroy for the old one', async () => {
    const oldIncarnation = 'gce-instance-1001';
    const newIncarnation = 'gce-instance-1002';

    const old = await recordCloudResourceObligation(db.adminSql, {
      ...base,
      incarnationId: oldIncarnation,
      purpose: 'old host generation',
    });
    expect(old).toMatchObject({ created: true });

    expect(
      await closeCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: oldIncarnation,
        reason: 'provider confirmed old instance destroy',
      }),
    ).toEqual({ closed: true });

    const recreated = await recordCloudResourceObligation(db.adminSql, {
      ...base,
      incarnationId: newIncarnation,
      purpose: 'replacement host generation',
    });
    expect(recreated).toEqual({ id: old.id, created: true });

    const onUnmatched = vi.fn();
    const closeObserver = createCloudResourceObligationCloseObserver({
      sql: db.adminSql,
      onUnmatched,
    });
    const staleDestroy = await closeObserver({
      workspaceId,
      resource: {
        deleteOp: 'delete-instance',
        providerId: resourceId,
        incarnationId: oldIncarnation,
      },
      reason: 'delayed confirmation from old destroy',
    });
    expect(staleDestroy).toEqual({ closed: false, staleIncarnation: true });
    expect(onUnmatched).not.toHaveBeenCalled();

    const open = await listOpenCloudResourceObligations(db.adminSql, { workspaceId });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: old.id,
      resourceId,
      incarnationId: newIncarnation,
      teardownOwed: true,
      closedAtMs: null,
    });

    expect(
      await closeCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: newIncarnation,
        reason: 'provider confirmed replacement destroy',
      }),
    ).toEqual({ closed: true });

    // A replay of the same create event after its confirmed destroy is idempotent and must not
    // reopen the already-closed incarnation.
    expect(
      await recordCloudResourceObligation(db.adminSql, {
        ...base,
        incarnationId: newIncarnation,
        purpose: 'replacement host generation',
      }),
    ).toEqual({ id: old.id, created: false });
    expect(await listOpenCloudResourceObligations(db.adminSql, { workspaceId })).toEqual([]);
  });

  // WI-10003510: the r55 canary VM's delete timed out and was confirmed on the reconciling
  // NOT-FOUND read, which carries no incarnation id. The row was incarnation-stamped, so the
  // close matched nothing and the obligation escalated a phantom. An absence read at T closes the
  // row iff it was (re)recorded at or before T — never a replacement recorded after T.
  it('closes an incarnation-stamped VM on a not-found confirmation, but not a replacement recorded after the read', async () => {
    const absentWorkspace = 'cloud-resource-obligation-absent-read-ws';
    const vm = { ...base, workspaceId: absentWorkspace, resourceId: 'pc-host-absent-read-regression-vm' };
    const onUnmatched = vi.fn();
    const closeObserver = createCloudResourceObligationCloseObserver({ sql: db.adminSql, onUnmatched });

    await recordCloudResourceObligation(db.adminSql, { ...vm, incarnationId: 'gce-instance-2001', purpose: 'first' });
    const readBeforeReplacement = new Date(Date.now() + 1_000).toISOString();

    expect(
      await closeObserver({
        workspaceId: absentWorkspace,
        resource: { deleteOp: 'delete-instance', providerId: vm.resourceId, confirmedAbsentAt: readBeforeReplacement },
      }),
    ).toEqual({ closed: true });
    expect(onUnmatched).not.toHaveBeenCalled();
    expect(await listOpenCloudResourceObligations(db.adminSql, { workspaceId: absentWorkspace })).toEqual([]);

    // A replacement recorded AFTER an absence read: a late-delivered copy of that read must not
    // close it (the read proved only the earlier incarnation gone).
    const staleRead = new Date(Date.now() - 60_000).toISOString();
    await recordCloudResourceObligation(db.adminSql, { ...vm, incarnationId: 'gce-instance-2002', purpose: 'replacement' });
    expect(
      await closeObserver({
        workspaceId: absentWorkspace,
        resource: { deleteOp: 'delete-instance', providerId: vm.resourceId, confirmedAbsentAt: staleRead },
      }),
    ).toEqual({ closed: false });
    expect(onUnmatched).toHaveBeenCalledTimes(1);
    const open = await listOpenCloudResourceObligations(db.adminSql, { workspaceId: absentWorkspace });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ incarnationId: 'gce-instance-2002', teardownOwed: true, closedAtMs: null });
  });

  it('keeps a newer unincarnated disk obligation open when a stale absence read misses', async () => {
    const diskWorkspace = 'cloud-resource-obligation-unincarnated-disk-ws';
    const disk = {
      ...base,
      workspaceId: diskWorkspace,
      resourceKind: 'disk',
      resourceId: 'vol-unincarnated-disk-regression',
    };
    const staleRead = new Date(Date.now() - 60_000).toISOString();

    expect(await recordCloudResourceObligation(db.adminSql, { ...disk, purpose: 'new disk after read' }))
      .toMatchObject({ created: true });
    expect(
      await closeCloudResourceObligation(db.adminSql, {
        ...disk,
        confirmedAbsentAt: staleRead,
        reason: 'stale provider not-found read',
      }),
    ).toEqual({ closed: false });

    const open = await listOpenCloudResourceObligations(db.adminSql, { workspaceId: diskWorkspace });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      resourceId: disk.resourceId,
      incarnationId: '',
      teardownOwed: true,
      closedAtMs: null,
    });
  });

  // WI-10003512: the discharged-escalation read decides which "Undischarged …" work-items the
  // sweep retires. Its HAVING/EXISTS predicate is exactly what a fake SQL cannot check.
  it('lists an escalation only when every referencing obligation is closed and the work-item is still open', async () => {
    const ws = 'cloud-resource-obligation-discharge-ws';
    const common = { workspaceId: ws, provider: 'gcp' as const, projectId: 'p', graceMs: 60_000 };
    const insertWorkItem = async (featureId: string, status: string) => {
      await db.adminSql`
        INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, status)
        VALUES (${ws}, 'papercusp', ${featureId}, ${status})`;
    };
    const escalateAndMaybeClose = async (resourceKind: string, resourceId: string, workItemId: string, close: boolean) => {
      await recordCloudResourceObligation(db.adminSql, { ...common, resourceKind, resourceId, purpose: 'discharge test' });
      const [row] = (await listOpenCloudResourceObligations(db.adminSql, { workspaceId: ws })).filter(
        (r) => r.resourceId === resourceId,
      );
      await markCloudResourceObligationEscalated(db.adminSql, row!.id, workItemId);
      if (close) {
        expect(
          await closeCloudResourceObligation(db.adminSql, {
            ...common,
            resourceKind,
            resourceId,
            reason: `provider confirmed ${resourceId} destroy`,
          }),
        ).toEqual({ closed: true });
      }
    };

    // (a) discharged + open work-item → listed.
    await insertWorkItem('EI-discharged', 'open');
    await escalateAndMaybeClose('nat', 'nat-discharged', 'EI-discharged', true);
    // (b) two rows share one escalation; one is still open → NOT listed.
    await insertWorkItem('EI-half', 'blocked');
    await escalateAndMaybeClose('router', 'router-half-closed', 'EI-half', true);
    await escalateAndMaybeClose('firewall', 'fw-half-open', 'EI-half', false);
    // (c) discharged but the work-item is already terminal → NOT listed (nothing to retire).
    await insertWorkItem('EI-already-resolved', 'resolved');
    await escalateAndMaybeClose('disk', 'disk-already', 'EI-already-resolved', true);
    // (d) still undischarged → NOT listed.
    await insertWorkItem('EI-live-leak', 'open');
    await escalateAndMaybeClose('subnetwork', 'subnet-live', 'EI-live-leak', false);

    const listed = (await listDischargedOpenCloudResourceObligationEscalations(db.adminSql)).filter(
      (d) => d.workspaceId === ws,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      workspaceId: ws,
      workItemId: 'EI-discharged',
      resources: ['nat nat-discharged'],
      closedReasons: ['provider confirmed nat-discharged destroy'],
    });
    expect(Number.isFinite(listed[0]!.lastClosedAtMs)).toBe(true);

    // Closing the last open row of the shared escalation makes it eligible too.
    await closeCloudResourceObligation(db.adminSql, {
      ...common,
      resourceKind: 'firewall',
      resourceId: 'fw-half-open',
      reason: 'provider confirmed fw destroy',
    });
    const after = (await listDischargedOpenCloudResourceObligationEscalations(db.adminSql))
      .filter((d) => d.workspaceId === ws)
      .map((d) => d.workItemId)
      .sort();
    expect(after).toEqual(['EI-discharged', 'EI-half']);
  });
});
