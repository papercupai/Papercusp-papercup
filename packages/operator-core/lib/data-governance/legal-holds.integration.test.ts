/**
 * Legal-hold administration against real Postgres (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-017, child P-017b WI-6554700010012480).
 *
 * Acceptance under test:
 *  - an authorized actor places, lists and releases holds on a whole source or one container;
 *  - each place and release appends one papercusp_auth.organization_audit_events row naming the hold,
 *    source, container, reason and actor, in the same transaction as the hold write;
 *  - an actor without the deletion permission, or acting in another organization, is refused and
 *    nothing is written;
 *  - the listing reports, per hold, the rows it keeps (the deletion receipt's holdConflicts rule);
 *  - a container given in its permission-list form `<sourceId>#<container>` is stored bare, so chat
 *    and document enforcement both match it.
 *
 * P-017d (WI-6554700010012584): e-discovery export of exactly what one hold keeps, and restore under a
 * hold. A restore replaces the database files, which these tests simulate by writing rows with
 * session_replication_role = replica (no row triggers run, as in a file-level restore) or by removing
 * the hold row the snapshot predates.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { containerPermissionRef, upsertChatMessages } from '../data-sources/chat-retrieval-units';
import { upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';
import { placeLegalHold, releaseLegalHold } from '../data-sources/chat-retrieval-units';
import { withHostBackupRetentionLease } from './organization-backup-sealing';
import {
  exportLegalHoldContent,
  LEGAL_HOLD_ACTIONS,
  LegalHoldError,
  listOrganizationLegalHolds,
  placeOrganizationLegalHold,
  releaseOrganizationLegalHold,
} from './legal-holds';
import {
  reconcileRestoredAccess,
  type OrganizationDataScope,
  type PostBackupHoldChange,
  type PreRestoreHeldContent,
  type ReceiptActor,
} from './organization-data-receipts';

let org: OrgTestDb;
const WS = 'legal-holds-test';
const OTHER_WS = 'legal-holds-test-other';
const CH = 'T1:CHELD';
const admin: ReceiptActor = { kind: 'staff_admin', id: 'admin:tester' };
let scope: OrganizationDataScope;
let slackId: string;
let ghId: string;

const member = (permissions: string[], organizationId: string): ReceiptActor => ({
  kind: 'customer_user',
  principal: createHostedPrincipal({
    workspaceId: 'control', userId: '22222222-2222-4222-8222-222222222222', activeOrganizationId: organizationId,
    sessionId: 'session', sessionVersion: 1, permissions: permissions as never,
  }),
});

const msg = (channelId: string, id: string) => ({
  channelId, providerMessageId: id, threadKey: null, authorRef: 'T1:UALICE', authorLabel: 'alice', body: `message ${id}`,
  postedAt: '2026-09-30T10:00:00Z',
});

async function auditRows() {
  return org.adminSql<Array<{ action: string; actor_kind: string; actor_id: string; workspace_id: string | null;
    purpose: string; target_type: string; target_id: string; metadata: Record<string, any> }>>`
    SELECT action, actor_kind, actor_id, workspace_id, purpose, target_type, target_id, metadata
      FROM papercusp_auth.organization_audit_events
     WHERE organization_id = ${scope.organizationId}::uuid ORDER BY recorded_at, id`;
}

async function holdRows() {
  return org.adminSql<Array<{ id: string; channel_id: string | null; placed_by: string; released_by: string | null }>>`
    SELECT id, channel_id, placed_by, released_by FROM harness_shared.data_source_legal_holds
     WHERE workspace_id IN (${WS}, ${OTHER_WS}) ORDER BY placed_at, id`;
}

async function source(workspaceId: string, kind: string): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
    VALUES (${workspaceId}, ${kind}, ${org.adminSql.json({ mode: 'source-acl' })}, ${`vault://legal-holds/${kind}`})
    RETURNING id`;
  return row!.id;
}

beforeAll(async () => {
  org = await createOrgTestDb();
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  scope = { organizationId: randomUUID(), workspaceIds: [WS] };
  for (const ws of [WS, OTHER_WS]) {
    await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${ws}`;
    await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${ws}`;
  }
  slackId = await source(WS, 'slack');
  await upsertChatMessages(org.adminSql, WS, slackId, [msg(CH, '1.1'), msg(CH, '1.2'), msg('T1:COPEN', '2.1')]);
  ghId = await source(WS, 'github');
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'github', sourceRef: containerPermissionRef(ghId, 'acme/held'), title: 'acme/held' });
  await upsertOrganizationDocuments(org.adminSql, WS, list.id, [
    { source: 'github', kind: 'issue', dedupeKey: 'acme/held#1', sourceId: ghId, title: 'held issue', text: 'Held issue body.' },
  ]);
});

describe('legal-hold administration (P-017b)', () => {
  it('serializes host backup expiry against the low-level hold writer and reads the entire dump scope', async () => {
    await withHostBackupRetentionLease(org.adminSql, async (ids) => {
      expect(ids).toEqual([]);
      // A separate pooled session proves the lock, without a timing guess or
      // a mocked callback. Even the lowest-level writer must wait for expiry.
      await expect(org.adminSql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        return placeLegalHold(tx as unknown as postgres.Sql, WS, {
          dataSourceId: slackId, channelId: CH, reason: 'race', placedBy: 'test',
        });
      })).rejects.toThrow(/lock timeout/);
    });
    const { id } = await placeLegalHold(org.adminSql, WS, {
      dataSourceId: slackId, channelId: CH, reason: 'after expiry', placedBy: 'test',
    });
    await withHostBackupRetentionLease(org.adminSql, async (ids) => {
      expect(ids).toEqual([id]);
    });
    // Failure must release the transaction lease too.
    await expect(withHostBackupRetentionLease(org.adminSql, async () => { throw new Error('expiry failed'); }))
      .rejects.toThrow(/expiry failed/);
    await releaseLegalHold(org.adminSql, WS, { id, releasedBy: 'test' });
    await withHostBackupRetentionLease(org.adminSql, async (ids) => { expect(ids).toEqual([]); });
  });
  it('places a container hold, reports what it keeps, and audits the placement', async () => {
    const { hold, auditEventId } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 11',
    });
    expect(hold).toMatchObject({ workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 11',
      placedBy: 'admin:tester', releasedAt: null });
    expect(hold.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: LEGAL_HOLD_ACTIONS.place, actor_kind: 'staff_admin', actor_id: 'admin:tester', workspace_id: null,
      purpose: 'litigation 11', target_type: 'legal_hold', target_id: hold.holdId,
    });
    expect(rows[0]!.metadata).toMatchObject({ holdId: hold.holdId, workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'litigation 11' });
    expect(rows[0]!.metadata.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));
    // The audit event id is the row just read.
    const [{ id }] = await org.adminSql<{ id: string }[]>`
      SELECT id::text AS id FROM papercusp_auth.organization_audit_events WHERE organization_id = ${scope.organizationId}::uuid`;
    expect(auditEventId).toBe(id);
  });

  it('stores a permission-list container (<sourceId>#<container>) bare, so its documents are counted as held', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: containerPermissionRef(ghId, 'acme/held'),
      reason: 'litigation 12',
    });
    expect(hold.channelId).toBe('acme/held');
    expect(hold.retained).toEqual(expect.arrayContaining([{ store: 'harness_shared.documents', rows: 1 }]));
    await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`)
      .rejects.toThrow(/document_under_legal_hold/);
  });

  it('refuses an actor without the deletion permission, or from another organization, and writes nothing', async () => {
    const attempts: ReceiptActor[] = [
      member(['members:manage'], scope.organizationId),
      member(['workspace:destroy'], randomUUID()),
    ];
    for (const actor of attempts) {
      const err = await placeOrganizationLegalHold(org.adminSql, {
        scope, actor, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 13',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LegalHoldError);
      expect((err as LegalHoldError).code).toBe('forbidden');
    }
    // Listing needs the export permission: a viewer is refused, an owner-equivalent is not.
    await expect(listOrganizationLegalHolds(org.adminSql, { scope, actor: member(['workspace:view'], scope.organizationId) }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(await holdRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    // Positive control: the same customer user with the deletion permission succeeds.
    await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: member(['workspace:destroy'], scope.organizationId), workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'litigation 13',
    });
    expect((await auditRows()).map((r) => r.actor_kind)).toEqual(['customer_user']);
  });

  it('refuses a workspace outside the scope and an unknown source', async () => {
    const otherSource = await source(OTHER_WS, 'slack');
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: OTHER_WS, dataSourceId: otherSource, reason: 'litigation 14',
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: otherSource, reason: 'litigation 14',
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(await holdRows()).toEqual([]);
  });

  it('rolls the hold back when the audit append refuses the event', async () => {
    // Credential-shaped text fails assertGovernancePayloadSafe inside the same transaction.
    await expect(placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH,
      reason: 'see Bearer abcdefghijklmnop0123456789',
    })).rejects.toThrow(/credential-like material/);
    expect(await holdRows()).toEqual([]);
  });

  it('lists active holds with what each keeps, and released holds only when asked', async () => {
    const whole = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, reason: 'litigation 15',
    });
    const container = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 16',
    });
    await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: container.hold.holdId, reason: 'matter closed' });

    const active = await listOrganizationLegalHolds(org.adminSql, { scope, actor: admin });
    expect(active.map((h) => h.holdId)).toEqual([whole.hold.holdId]);
    expect(active[0]!.channelId).toBeNull();
    expect(active[0]!.retained).toEqual(expect.arrayContaining([
      { store: 'harness_shared.documents', rows: 1 },
      { store: 'harness_shared.data_sources', rows: 1 },
    ]));

    const all = await listOrganizationLegalHolds(org.adminSql, { scope, actor: admin, includeReleased: true });
    expect(all.map((h) => [h.holdId, h.releasedBy, h.retained === null])).toEqual([
      [whole.hold.holdId, null, false],
      [container.hold.holdId, 'admin:tester', true],
    ]);
  });

  it('releases a hold with an audit event naming what it kept, and refuses a second release or a foreign hold', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'litigation 17',
    });
    const out = await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'matter closed' });
    expect(out.hold).toMatchObject({ holdId: hold.holdId, releasedBy: 'admin:tester', retained: null });
    expect(out.hold.releasedAt).not.toBeNull();

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([LEGAL_HOLD_ACTIONS.place, LEGAL_HOLD_ACTIONS.release]);
    expect(rows[1]).toMatchObject({ purpose: 'matter closed', target_type: 'legal_hold', target_id: hold.holdId });
    expect(rows[1]!.metadata).toMatchObject({ holdId: hold.holdId, channelId: CH, reason: 'matter closed',
      placedReason: 'litigation 17', placedBy: 'admin:tester' });
    expect(rows[1]!.metadata.retainedAtRelease).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));

    // Released: the chat rows are no longer protected.
    await org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH}`;

    await expect(releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'again' }))
      .rejects.toMatchObject({ code: 'already_released' });
    const otherSource = await source(OTHER_WS, 'slack');
    const foreign = await placeOrganizationLegalHold(org.adminSql, {
      scope: { organizationId: scope.organizationId, workspaceIds: [OTHER_WS] }, actor: admin, workspaceId: OTHER_WS,
      dataSourceId: otherSource, reason: 'other workspace',
    });
    await expect(releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: foreign.hold.holdId, reason: 'x' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(releaseOrganizationLegalHold(org.adminSql, {
      scope, actor: member(['members:manage'], scope.organizationId), holdId: hold.holdId, reason: 'x',
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('exports exactly the content an active hold keeps, with a stable digest and an audit event (P-017d)', async () => {
    const { hold: chatHold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 21',
    });
    const first = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: chatHold.holdId, purpose: 'e-discovery 21' });
    const byStore = Object.fromEntries(first.stores.map((s) => [s.store, s]));
    expect(byStore['harness_shared.chat_messages']!.rows.map((r) => r.provider_message_id).sort()).toEqual(['1.1', '1.2']);
    expect(byStore['harness_shared.documents']!.rows).toHaveLength(0);
    for (const s of first.stores) expect(s.columns.some((c) => s.excludedColumns.includes(c))).toBe(false);
    const again = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: chatHold.holdId, purpose: 'e-discovery 21b' });
    expect(again.digest).toBe(first.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);

    const { hold: docHold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held', reason: 'matter 22',
    });
    const docs = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: docHold.holdId, purpose: 'e-discovery 22' });
    const docRows = docs.stores.find((s) => s.store === 'harness_shared.documents')!.rows;
    expect(docRows.map((r) => r.title)).toEqual(['held issue']);
    expect(docs.digest).not.toBe(first.digest);

    const exports = (await auditRows()).filter((r) => r.action === LEGAL_HOLD_ACTIONS.export);
    expect(exports).toHaveLength(3);
    expect(exports[0]).toMatchObject({ actor_id: 'admin:tester', workspace_id: null, purpose: 'e-discovery 21',
      target_type: 'legal_hold', target_id: chatHold.holdId });
    expect(exports[0]!.metadata).toMatchObject({ holdId: chatHold.holdId, workspaceId: WS, digest: first.digest });
    expect(exports[0]!.metadata.exported).toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));
  });

  it('refuses an export by an actor without the export permission, of a foreign or released hold, and writes nothing', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 23',
    });
    const before = (await auditRows()).length;
    await expect(exportLegalHoldContent(org.adminSql, {
      scope, actor: member(['workspace:destroy'], scope.organizationId), holdId: hold.holdId, purpose: 'x',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(exportLegalHoldContent(org.adminSql, {
      scope: { organizationId: scope.organizationId, workspaceIds: [OTHER_WS] }, actor: admin, holdId: hold.holdId, purpose: 'x',
    })).rejects.toMatchObject({ code: 'not_found' });
    expect((await auditRows()).length).toBe(before);
    await releaseOrganizationLegalHold(org.adminSql, { scope, actor: admin, holdId: hold.holdId, reason: 'matter closed' });
    await expect(exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: hold.holdId, purpose: 'x' }))
      .rejects.toMatchObject({ code: 'already_released' });
    expect((await auditRows()).filter((r) => r.action === LEGAL_HOLD_ACTIONS.export)).toHaveLength(0);
  });
});

describe('restore under a legal hold (P-017d)', () => {
  const restore = (extra: { holdChanges?: PostBackupHoldChange[]; heldContent?: PreRestoreHeldContent[]; actor?: ReceiptActor }) =>
    reconcileRestoredAccess(org.adminSql, {
      scope, actor: extra.actor ?? admin, purpose: 'restore drill', revocations: [],
      holdChanges: extra.holdChanges, heldContent: extra.heldContent,
    });
  const restoreReceipts = async () => (await auditRows()).filter((r) => r.action === 'organization.data.restore');
  const holdRow = async (id: string) => (await org.adminSql<Array<{ placed_at: Date; reason: string; placed_by: string;
    released_at: Date | null; released_by: string | null }>>`
    SELECT placed_at, reason, placed_by, released_at, released_by FROM harness_shared.data_source_legal_holds
     WHERE workspace_id = ${WS} AND id = ${id}::uuid`)[0];
  const dropHoldRow = (id: string) =>
    org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${WS} AND id = ${id}::uuid`;
  const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

  it('a hold active in the restored database protects its rows at once, and the receipt shows its content matches the pre-restore export', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 31',
    });
    const before = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: hold.holdId, purpose: 'pre-restore 31' });

    const out = await restore({ heldContent: [{ holdId: hold.holdId, workspaceId: WS, digest: before.digest }] });
    expect(out.heldContent).toEqual([{ holdId: hold.holdId, workspaceId: WS, expectedDigest: before.digest,
      restoredDigest: before.digest, matchesExport: true, repairedRows: null }]);
    expect(out.holdChanges).toEqual([]);
    expect(out.holdConflicts.find((c) => c.holdId === hold.holdId)!.retained)
      .toEqual(expect.arrayContaining([{ store: 'harness_shared.chat_messages', rows: 2 }]));
    await expect(org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH}`)
      .rejects.toThrow(/chat_message_under_legal_hold/);

    const receipts = await restoreReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.metadata.heldContent).toEqual([{ holdId: hold.holdId, workspaceId: WS, expectedDigest: before.digest,
      restoredDigest: before.digest, matchesExport: true, repairedRows: null }]);
    expect(receipts[0]!.metadata.holdConflicts.map((h: { holdId: string }) => h.holdId)).toContain(hold.holdId);
    expect(receipts[0]!.metadata.limitations.join(' ')).toMatch(/legal-hold triggers do not run during it/);
  });

  it('a hold placed after the backup point is re-applied with its original id and time, and protects its rows again', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held', reason: 'matter 32',
    });
    // The snapshot predates the placement: the restored database has no hold row.
    await dropHoldRow(hold.holdId);
    expect(await holdRow(hold.holdId)).toBeUndefined();
    const change: PostBackupHoldChange = {
      kind: 'place', holdId: hold.holdId, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held',
      reason: 'matter 32', placedBy: hold.placedBy, placedAt: hold.placedAt,
    };

    const out = await restore({ holdChanges: [change] });
    expect(out.holdChanges).toEqual([{ holdId: hold.holdId, workspaceId: WS, change: 'place', applied: 'reapplied', active: true }]);
    const row = await holdRow(hold.holdId);
    expect(iso(row!.placed_at)).toBe(hold.placedAt);
    expect(row).toMatchObject({ reason: 'matter 32', placed_by: 'admin:tester', released_at: null });
    await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`)
      .rejects.toThrow(/document_under_legal_hold/);
    expect((await restoreReceipts())[0]!.metadata.holdChanges)
      .toEqual([{ holdId: hold.holdId, workspaceId: WS, change: 'place', applied: 'reapplied', active: true }]);

    // Reconciling again finds the hold present and changes nothing.
    const again = await restore({ holdChanges: [change] });
    expect(again.holdChanges).toEqual([{ holdId: hold.holdId, workspaceId: WS, change: 'place', applied: 'present', active: true }]);
    expect((await holdRows()).filter((h) => h.id === hold.holdId)).toHaveLength(1);
  });

  it('a release made after the backup point is re-applied, and changes apply in the order they happened', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 33',
    });
    const releasedAt = new Date(Date.parse(hold.placedAt) + 60_000).toISOString();
    // The restored database still has the hold active; the caller names its release from the SIEM export.
    const out = await restore({ holdChanges: [{ kind: 'release', holdId: hold.holdId, workspaceId: WS, releasedBy: 'admin:releaser', releasedAt }] });
    expect(out.holdChanges).toEqual([{ holdId: hold.holdId, workspaceId: WS, change: 'release', applied: 'reapplied', active: false }]);
    const row = await holdRow(hold.holdId);
    expect(iso(row!.released_at)).toBe(releasedAt);
    expect(row!.released_by).toBe('admin:releaser');
    // Released: the channel's messages are no longer protected.
    await org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH}`;

    // Placed and released after the backup point, named release-first: it still ends released.
    const { hold: whole } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, reason: 'matter 34',
    });
    await dropHoldRow(whole.holdId);
    const both = await restore({ holdChanges: [
      { kind: 'release', holdId: whole.holdId, workspaceId: WS, releasedBy: 'admin:tester',
        releasedAt: new Date(Date.parse(whole.placedAt) + 60_000).toISOString() },
      { kind: 'place', holdId: whole.holdId, workspaceId: WS, dataSourceId: ghId, channelId: null, reason: 'matter 34',
        placedBy: whole.placedBy, placedAt: whole.placedAt },
    ] });
    expect(both.holdChanges.map((c) => [c.change, c.applied, c.active])).toEqual([['place', 'reapplied', true], ['release', 'reapplied', false]]);
    expect((await holdRow(whole.holdId))!.released_by).toBe('admin:tester');
  });

  it('refuses an unauthorized actor, a change outside the scope, a source or hold the restored database lacks, and writes nothing', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 36',
    });
    const holdsBefore = await holdRows();
    const auditBefore = (await auditRows()).length;
    const now = new Date().toISOString();
    const freshPlace = (over: Partial<Extract<PostBackupHoldChange, { kind: 'place' }>>): PostBackupHoldChange => ({
      kind: 'place', holdId: randomUUID(), workspaceId: WS, dataSourceId: slackId, channelId: 'T1:COPEN', reason: 'matter 37',
      placedBy: 'admin:tester', placedAt: now, ...over,
    });

    await expect(restore({ actor: member(['members:manage'], scope.organizationId), holdChanges: [freshPlace({})] }))
      .rejects.toThrow(/restore requires workspace:destroy/);
    await expect(restore({ holdChanges: [freshPlace({ workspaceId: OTHER_WS })] })).rejects.toThrow(/outside the scope/);
    await expect(restore({ holdChanges: [freshPlace({ dataSourceId: randomUUID() })] })).rejects.toThrow(/restored database does not have/);
    await expect(restore({ holdChanges: [freshPlace({ holdId: hold.holdId, channelId: 'T1:COTHER' })] }))
      .rejects.toThrow(/different source or container/);
    await expect(restore({ holdChanges: [{ kind: 'release', holdId: randomUUID(), workspaceId: WS, releasedBy: 'admin:tester', releasedAt: now }] }))
      .rejects.toThrow(/not in the restored database/);
    await expect(restore({ heldContent: [{ holdId: hold.holdId, workspaceId: WS, digest: 'not-a-digest' }] })).rejects.toThrow(/sha256/);
    // One good change and one bad one in the same call: the good one is rolled back with it.
    await expect(restore({ holdChanges: [
      freshPlace({}),
      { kind: 'release', holdId: randomUUID(), workspaceId: WS, releasedBy: 'admin:tester', releasedAt: now },
    ] })).rejects.toThrow(/not in the restored database/);

    expect(await holdRows()).toEqual(holdsBefore);
    expect((await auditRows()).length).toBe(auditBefore);
  });

  it('records, without repairing, held content the restore rolled back, and a hold the restored database lacks', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 38',
    });
    const before = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: hold.holdId, purpose: 'pre-restore 38' });
    const { hold: docHold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held', reason: 'matter 39',
    });
    const docBefore = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: docHold.holdId, purpose: 'pre-restore 39' });

    // The snapshot holds an earlier version of message 1.2. A file-level restore runs no row
    // triggers, so the held row is overwritten; replica mode reproduces that.
    await org.adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE harness_shared.chat_messages SET body = 'backup-point version'
                WHERE workspace_id = ${WS} AND channel_id = ${CH} AND provider_message_id = '1.2'`;
    });
    // And the snapshot predates the document hold.
    await dropHoldRow(docHold.holdId);

    const out = await restore({ heldContent: [
      { holdId: hold.holdId, workspaceId: WS, digest: before.digest },
      { holdId: docHold.holdId, workspaceId: WS, digest: docBefore.digest },
    ] });
    const chat = out.heldContent.find((h) => h.holdId === hold.holdId)!;
    expect(chat.matchesExport).toBe(false);
    expect(chat.restoredDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(chat.restoredDigest).not.toBe(before.digest);
    expect(out.heldContent.find((h) => h.holdId === docHold.holdId)).toEqual({ holdId: docHold.holdId, workspaceId: WS,
      expectedDigest: docBefore.digest, restoredDigest: null, matchesExport: false, repairedRows: null });
    // Recorded, not repaired: the receipt is written and the rolled-back body stays as restored.
    expect((await restoreReceipts())[0]!.metadata.heldContent.map((h: { matchesExport: boolean }) => h.matchesExport)).toEqual([false, false]);
    const [{ body }] = await org.adminSql<{ body: string }[]>`
      SELECT body FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '1.2'`;
    expect(body).toBe('backup-point version');
    // The hold still protects what the restore left.
    await expect(org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '1.1'`)
      .rejects.toThrow(/chat_message_under_legal_hold/);
  });

  it('repairs held content from the pre-restore database: a lost row is re-inserted and a rolled-back row reset (EI-25980833213582300)', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: slackId, channelId: CH, reason: 'matter 40',
    });
    // The backup point: 1.1 as the backup holds it. Text forms keep microseconds and JSON exact.
    const [atBackup] = await org.adminSql<{ body: string; edited_at: string | null; held_revisions: string }[]>`
      SELECT body, edited_at::text AS edited_at, held_revisions::text AS held_revisions
        FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH} AND provider_message_id = '1.1'`;
    // After the backup point, while held: message 1.1 is edited (allowed under a hold) and 1.3 arrives.
    await upsertChatMessages(org.adminSql, WS, slackId, [{ ...msg(CH, '1.1'), body: 'edited after backup' }, msg(CH, '1.3')]);
    const before = await exportLegalHoldContent(org.adminSql, { scope, actor: admin, holdId: hold.holdId, purpose: 'pre-restore 40' });

    // The database the restore replaces: restore-pg-dump.sh loads into a NEW database, so this copy
    // keeps the held rows. A template copy is a file-level image of it.
    const server = postgres(Object.assign(new URL(org.adminDsn), { pathname: '/postgres' }).toString(), { max: 1, onnotice: () => {} });
    const preDb = `${org.dbName}_pre`;
    let pre: postgres.Sql | undefined;
    try {
      await server`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${org.dbName} AND pid <> pg_backend_pid()`;
      await server.unsafe(`CREATE DATABASE "${preDb}" TEMPLATE "${org.dbName}"`);
      pre = postgres(Object.assign(new URL(org.adminDsn), { pathname: `/${preDb}` }).toString(), { max: 1, onnotice: () => {} });

      // The restored database is at the backup point. The restore runs no row triggers (replica mode
      // reproduces that): 1.1 is back to its backup-point row and 1.3 is gone.
      await org.adminSql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`UPDATE harness_shared.chat_messages SET body = ${atBackup!.body}, edited_at = ${atBackup!.edited_at}::timestamptz,
                         held_revisions = ${atBackup!.held_revisions}::jsonb
                  WHERE workspace_id = ${WS} AND channel_id = ${CH} AND provider_message_id = '1.1'`;
        await tx`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH} AND provider_message_id = '1.3'`;
      });
      const heldContent = [{ holdId: hold.holdId, workspaceId: WS, digest: before.digest }];
      const reconcile = () => reconcileRestoredAccess(org.adminSql, {
        scope, actor: admin, purpose: 'restore drill 40', revocations: [], heldContent, preRestoreSource: pre,
      });
      const bodies = async () => Object.fromEntries((await org.adminSql<{ id: string; body: string }[]>`
        SELECT provider_message_id AS id, body FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND channel_id = ${CH}`)
        .map((r) => [r.id, r.body]));

      // A source that no longer holds that content as an active hold is refused, and nothing is written.
      await pre`UPDATE harness_shared.data_source_legal_holds SET released_at = now(), released_by = 'tester' WHERE id = ${hold.holdId}::uuid`;
      await expect(reconcile()).rejects.toThrow(/no active hold/);
      expect(await restoreReceipts()).toHaveLength(0);
      expect(await bodies()).toEqual({ '1.1': 'message 1.1', '1.2': 'message 1.2' });
      await pre`UPDATE harness_shared.data_source_legal_holds SET released_at = NULL, released_by = NULL WHERE id = ${hold.holdId}::uuid`;

      const repaired = await reconcile();
      expect(repaired.heldContent).toEqual([{ holdId: hold.holdId, workspaceId: WS, expectedDigest: before.digest,
        restoredDigest: before.digest, matchesExport: true, repairedRows: 2 }]);
      expect(await bodies()).toEqual({ '1.1': 'edited after backup', '1.2': 'message 1.2', '1.3': 'message 1.3' });
      expect((await restoreReceipts())[0]!.metadata.heldContent).toEqual([{ holdId: hold.holdId, workspaceId: WS,
        expectedDigest: before.digest, restoredDigest: before.digest, matchesExport: true, repairedRows: 2 }]);
      // The re-inserted row is held again at once.
      await expect(org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '1.3'`)
        .rejects.toThrow(/chat_message_under_legal_hold/);
      // Content that already matches is not copied again.
      const again = await reconcile();
      expect(again.heldContent[0]).toMatchObject({ matchesExport: true, repairedRows: null });
    } finally {
      await pre?.end({ timeout: 5 });
      await server.unsafe(`DROP DATABASE IF EXISTS "${preDb}" WITH (FORCE)`);
      await server.end({ timeout: 5 });
    }
  });

  it('repairs held documents idempotently while retaining foreign-key enforcement (EI-25984508545548441)', async () => {
    const { hold } = await placeOrganizationLegalHold(org.adminSql, {
      scope, actor: admin, workspaceId: WS, dataSourceId: ghId, channelId: 'acme/held', reason: 'matter 41',
    });
    const before = await exportLegalHoldContent(org.adminSql, {
      scope, actor: admin, holdId: hold.holdId, purpose: 'pre-restore 41',
    });
    const [{ permission_list_id: listId }] = await org.adminSql<{ permission_list_id: string }[]>`
      SELECT permission_list_id FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`;
    const [{ row: listRow }] = await org.adminSql<{ row: string }[]>`
      SELECT row_to_json(p)::text AS row FROM harness_shared.document_permission_lists p WHERE id = ${listId}::uuid`;
    const server = postgres(Object.assign(new URL(org.adminDsn), { pathname: '/postgres' }).toString(), { max: 1, onnotice: () => {} });
    const preDb = `${org.dbName}_pre`;
    let pre: postgres.Sql | undefined;
    try {
      await server`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${org.dbName} AND pid <> pg_backend_pid()`;
      await server.unsafe(`CREATE DATABASE "${preDb}" TEMPLATE "${org.dbName}"`);
      pre = postgres(Object.assign(new URL(org.adminDsn), { pathname: `/${preDb}` }).toString(), { max: 1, onnotice: () => {} });
      // Simulate a snapshot that predates both the document and its access list.
      // Replica mode belongs only to the file-restore simulation, never the repair.
      await org.adminSql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`;
        await tx`DELETE FROM harness_shared.document_permission_lists WHERE id = ${listId}::uuid`;
      });
      const reconcile = () => reconcileRestoredAccess(org.adminSql, {
        scope, actor: admin, purpose: 'restore drill 41', revocations: [],
        heldContent: [{ holdId: hold.holdId, workspaceId: WS, digest: before.digest }], preRestoreSource: pre,
      });
      await expect(reconcile()).rejects.toMatchObject({ code: '23503' });
      expect(await restoreReceipts()).toHaveLength(0);
      expect(await org.adminSql`SELECT id FROM harness_shared.documents WHERE workspace_id = ${WS}`).toHaveLength(0);

      // The prerequisite is restored through ordinary SQL; repair must not bypass it.
      await org.adminSql`
        INSERT INTO harness_shared.document_permission_lists
        SELECT * FROM json_populate_record(NULL::harness_shared.document_permission_lists, ${listRow}::json)`;
      const repaired = await reconcile();
      expect(repaired.heldContent[0]).toMatchObject({ matchesExport: true, restoredDigest: before.digest, repairedRows: 1 });
      await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`)
        .rejects.toThrow(/document_under_legal_hold/);

      // Exercise ON CONFLICT UPDATE as well as INSERT with the held-document trigger enabled.
      await org.adminSql`UPDATE harness_shared.documents SET text = 'backup-point text'
                        WHERE workspace_id = ${WS} AND dedupe_key = 'acme/held#1'`;
      expect((await reconcile()).heldContent[0]).toMatchObject({ matchesExport: true, repairedRows: 1 });
      expect((await reconcile()).heldContent[0]).toMatchObject({ matchesExport: true, repairedRows: null });
      expect((await restoreReceipts()).map((r) => r.metadata.heldContent[0].matchesExport)).toEqual([true, true, true]);
    } finally {
      await pre?.end({ timeout: 5 });
      await server.unsafe(`DROP DATABASE IF EXISTS "${preDb}" WITH (FORCE)`);
      await server.end({ timeout: 5 });
    }
  });
});
