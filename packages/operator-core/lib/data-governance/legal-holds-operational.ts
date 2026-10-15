/**
 * Isolated acceptance journey over the production governance APIs. The caller owns
 * a migrated throwaway database and supplies a physical database snapshot. This is
 * deliberately separate from the runner so the CLI and canonical suite exercise
 * the same maintained entry path. Never pass an organization production database.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { upsertChatMessages } from '../data-sources/chat-retrieval-units';
import { containerPermissionRef } from '../data-sources/chat-retrieval-units';
import { upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';
import { exportLegalHoldContent, placeOrganizationLegalHold, releaseOrganizationLegalHold } from './legal-holds';
import { deleteOrganizationData, reconcileRestoredAccess, type ReceiptActor } from './organization-data-receipts';

export interface HoldDrillAssertion { id: string; passed: boolean; evidence: string }
export interface HoldDrillResult { exitCode: number; summary: string; assertions: HoldDrillAssertion[] }

export async function runLegalHoldDrill(input: {
  sql: Sql;
  /** Physical copy at the backup point, with its own connection and cleanup. */
  snapshot: () => Promise<{ sql: Sql; cleanup: () => Promise<void> }>;
}): Promise<HoldDrillResult> {
  const assertions: HoldDrillAssertion[] = [];
  const check = (id: string, passed: boolean, evidence: string) => {
    assertions.push({ id, passed, evidence });
    if (!passed) throw new Error(`assertion failed: ${id}`);
  };
  const sql = input.sql;
  const workspaceId = `legal-hold-drill-${randomUUID()}`;
  const scope = { organizationId: randomUUID(), workspaceIds: [workspaceId] };
  const actor: ReceiptActor = { kind: 'staff_admin', id: 'isolated-legal-hold-drill' };
  const channel = 'drill:held';
  const message = (id: string, body: string) => ({ channelId: channel, providerMessageId: id,
    threadKey: null, authorRef: 'drill:author', authorLabel: 'Drill author', body,
    postedAt: '2026-10-01T00:00:00Z' });
  let snapshot: Awaited<ReturnType<typeof input.snapshot>> | undefined;
  try {
    const source = async (kind: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
        VALUES (${workspaceId}, ${kind}, ${sql.json({ mode: 'source-acl' })}, 'vault://isolated-drill') RETURNING id`;
      return row!.id;
    };
    const chatSource = await source('slack');
    const docSource = await source('github');
    await upsertChatMessages(sql, workspaceId, chatSource, [message('1.1', 'backup chat body')]);
    const list = await upsertPermissionList(sql, workspaceId, { source: 'github',
      sourceRef: containerPermissionRef(docSource, 'drill/held'), title: 'Drill repository' });
    const document = (key: string, text: string) => ({ source: 'github', kind: 'issue',
      dedupeKey: key, sourceId: docSource, title: key, text });
    await upsertOrganizationDocuments(sql, workspaceId, list.id, [document('drill/held#1', 'backup document body')]);
    const holds = [];
    for (const [dataSourceId, channelId] of [[chatSource, channel], [docSource, 'drill/held']]) {
      const placed = await placeOrganizationLegalHold(sql, { scope, actor, workspaceId,
        dataSourceId: dataSourceId!, channelId: channelId!, reason: 'isolated acceptance matter' });
      holds.push(placed.hold);
    }
    snapshot = await input.snapshot();
    // These changes are newer than the physical backup, and must survive reconciliation.
    await upsertChatMessages(sql, workspaceId, chatSource,
      [message('1.1', 'post-backup chat body'), message('1.2', 'post-backup new chat')]);
    await upsertOrganizationDocuments(sql, workspaceId, list.id,
      [document('drill/held#2', 'post-backup new document')]);
    const exported = await Promise.all(holds.map(hold => exportLegalHoldContent(sql,
      { scope, actor, holdId: hold.holdId, purpose: 'pre-restore copy of record' })));
    check('export-captures-held-chat-and-documents', exported.every(e => e.stores.some(s => s.rows.length > 0)),
      'Both authorized exports contain held rows and content digests.');
    const target = snapshot.sql;
    const deletion = await deleteOrganizationData(target, { scope, actor, purpose: 'held deletion request',
      confirmOrganizationId: scope.organizationId });
    check('deletion-preserves-active-holds', deletion.holdConflicts.length === 2,
      `Deletion receipt reports ${deletion.holdConflicts.length} active hold conflicts.`);
    const heldContent = exported.map(e => ({ holdId: e.hold.holdId, workspaceId, digest: e.digest }));
    const reconcile = () => reconcileRestoredAccess(target, { scope, actor,
      purpose: 'physical snapshot restore acceptance', revocations: [], heldContent, preRestoreSource: sql });
    const repaired = await reconcile();
    check('restore-recovers-post-backup-held-content', repaired.heldContent.length === 2
      && repaired.heldContent.every(h => h.matchesExport && (h.repairedRows ?? 0) > 0),
    `Held content matches both pre-restore digests; repaired row counts: ${repaired.heldContent.map(h => h.repairedRows).join(',')}.`);
    const repeated = await reconcile();
    check('restore-is-idempotent', repeated.heldContent.every(h => h.matchesExport && h.repairedRows === null),
      'The second reconciliation matches both digests without copying rows again.');
    for (const [store, error] of [['chat_messages', 'chat_message_under_legal_hold'], ['documents', 'document_under_legal_hold']]) {
      let refused = false;
      try { await target.unsafe(`DELETE FROM harness_shared.${store} WHERE workspace_id = $1`, [workspaceId]); }
      catch (e) { refused = e instanceof Error && e.message.includes(error!); }
      check(`restored-${store}-delete-refused`, refused, `Database trigger must refuse deletion with ${error}.`);
    }
    for (const hold of holds) await releaseOrganizationLegalHold(target,
      { scope, actor, holdId: hold.holdId, reason: 'authorized acceptance release' });
    const released = await deleteOrganizationData(target, { scope, actor, purpose: 'deletion after authorized release',
      confirmOrganizationId: scope.organizationId });
    const [remaining] = await target<{ chat: number; documents: number }[]>`
      SELECT (SELECT count(*)::int FROM harness_shared.chat_messages WHERE workspace_id = ${workspaceId}) AS chat,
             (SELECT count(*)::int FROM harness_shared.documents WHERE workspace_id = ${workspaceId}) AS documents`;
    check('authorized-release-permits-deletion', released.holdConflicts.length === 0
      && remaining!.chat === 0 && remaining!.documents === 0, 'Released chat and document records are deleted.');
    const events = await target<{ action: string }[]>`
      SELECT action FROM papercusp_auth.organization_audit_events WHERE organization_id = ${scope.organizationId}::uuid`;
    const actions = new Set(events.map(e => e.action));
    check('journey-has-audit-receipts', ['organization.legal_hold.place', 'organization.legal_hold.release',
      'organization.data.deletion', 'organization.data.restore'].every(action => actions.has(action)),
    `Recorded actions: ${[...actions].sort().join(', ')}.`);
    return { exitCode: 0, summary: 'Physical snapshot restore preserves held chat and documents until authorized release.', assertions };
  } catch (error) {
    assertions.push({ id: 'journey-completed', passed: false,
      evidence: error instanceof Error ? error.message.slice(0, 1800) : String(error).slice(0, 1800) });
    return { exitCode: 1, summary: 'Isolated legal-hold journey failed; see failed assertions.', assertions };
  } finally {
    await snapshot?.cleanup();
  }
}
