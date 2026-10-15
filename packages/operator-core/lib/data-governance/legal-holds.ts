/**
 * Legal-hold administration (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-017, child
 * P-017b WI-6554700010012480).
 *
 * Holds are ENFORCED in the database: chat_messages since migration 1320, documents since migration
 * 1502 (`document_under_hold` + the `documents_enforce_legal_hold` trigger). This module is the
 * administrative surface over them: an authorized actor places, lists and releases holds on a whole
 * data source or on one container of it (a Slack channel, a GitHub repository).
 *
 * Reuse, not parallel systems:
 *  - writers: `placeLegalHold` / `releaseLegalHold` (data-sources/chat-retrieval-units.ts) stay the
 *    single writers of harness_shared.data_source_legal_holds. This module never writes that table.
 *  - authorization: organization-data-receipts `authorizeDataOperation`. A hold decides whether data
 *    can be deleted, so placing and releasing need the DELETION permission (owner/admin); listing
 *    reveals what is held, so it needs the EXPORT permission.
 *  - audit: every place and release appends one papercusp_auth.organization_audit_events row through
 *    governance.ts `appendOrganizationAuditEvent`, in the same transaction as the write, so SIEM export
 *    (siem-export-org-audit.ts) sees it and a failed audit append rolls the hold change back.
 *  - retained counts: organization-data-receipts `holdConflicts`, the same per-hold, per-store
 *    coverage rule a deletion receipt reports. Not a copy.
 *
 * Releasing records nothing in the hold table beyond `released_at` / `released_by`; the release
 * reason lives in the audit event, together with what the hold was keeping when it was released.
 *
 * E-discovery (P-017d): `exportLegalHoldContent` exports exactly what one active hold keeps, with the
 * organization export's column shaping and a digest. Take that export before restoring a database:
 * restore reconciliation (organization-data-receipts `reconcileRestoredAccess`) compares the held
 * content the restore left with that digest, and re-applies hold placements and releases made after
 * the backup point.
 */
import type { Sql } from 'postgres';
import { appendOrganizationAuditEvent, type GovernanceJson } from '../auth/hosted/governance';
import { placeLegalHold, releaseLegalHold } from '../data-sources/chat-retrieval-units';
import {
  authorizeDataOperation,
  exportHoldContent,
  holdConflicts,
  holdContentDigest,
  validateScope,
  type HoldConflict,
  type HoldContentExport,
  type OrganizationDataScope,
  type ReceiptActor,
} from './organization-data-receipts';

export const LEGAL_HOLD_ACTIONS = {
  place: 'organization.legal_hold.place',
  release: 'organization.legal_hold.release',
  export: 'organization.legal_hold.export',
} as const;

export type LegalHoldErrorCode = 'forbidden' | 'invalid' | 'not_found' | 'already_released';

export class LegalHoldError extends Error {
  constructor(readonly code: LegalHoldErrorCode, message: string) {
    super(`legal-holds: ${message}`);
    this.name = 'LegalHoldError';
  }
}

export interface LegalHoldRecord {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly dataSourceId: string;
  /** null = the whole data source is held. */
  readonly channelId: string | null;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  /** Rows this hold keeps right now, per store. null for a released hold (it keeps nothing). */
  readonly retained: HoldConflict['retained'] | null;
}

type HoldOperation = 'place' | 'release' | 'list' | 'export';

/** Place/release need the deletion permission; list and export need the export permission. */
function authorize(op: HoldOperation, scope: OrganizationDataScope, actor: ReceiptActor) {
  try {
    return authorizeDataOperation(op === 'list' || op === 'export' ? 'export' : 'deletion', scope.organizationId, actor);
  } catch (error) {
    throw new LegalHoldError('forbidden', `${op} refused: ${(error as Error).message}`);
  }
}

function checkedScope(scope: OrganizationDataScope): OrganizationDataScope {
  try {
    return validateScope(scope);
  } catch (error) {
    throw new LegalHoldError('invalid', (error as Error).message);
  }
}

function requireText(value: string | undefined | null, label: string): string {
  const v = value?.trim();
  if (!v) throw new LegalHoldError('invalid', `${label} must be non-empty`);
  return v;
}

function inScope(scope: OrganizationDataScope, workspaceId: string): string {
  const ws = requireText(workspaceId, 'workspaceId');
  if (!scope.workspaceIds.includes(ws)) {
    throw new LegalHoldError('invalid', `workspace ${ws} is not in organization ${scope.organizationId}'s declared scope`);
  }
  return ws;
}

interface HoldRow {
  id: string;
  workspace_id: string;
  data_source_id: string;
  channel_id: string | null;
  reason: string;
  placed_by: string;
  placed_at: Date;
  released_at: Date | null;
  released_by: string | null;
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function toRecord(row: HoldRow, retained: HoldConflict['retained'] | null): LegalHoldRecord {
  return {
    holdId: row.id,
    workspaceId: row.workspace_id,
    dataSourceId: row.data_source_id,
    channelId: row.channel_id,
    reason: row.reason,
    placedBy: row.placed_by,
    placedAt: iso(row.placed_at)!,
    releasedAt: iso(row.released_at),
    releasedBy: row.released_by,
    retained,
  };
}

function retainedJson(retained: HoldConflict['retained']): GovernanceJson {
  return retained.map((r) => ({ store: r.store, rows: r.rows }));
}

async function retainedFor(sql: Sql, workspaceId: string, holdId: string): Promise<HoldConflict['retained']> {
  const conflict = (await holdConflicts(sql, [workspaceId])).find((c) => c.holdId === holdId);
  return conflict ? conflict.retained : [];
}

/**
 * Place a hold on a whole data source (no `channelId`) or one container of it. `channelId` may be the
 * bare container (`C123`, `acme/repo`) or its permission-list form `<dataSourceId>#<container>`;
 * the bare container is stored either way. Returns the hold, what it keeps now, and the
 * audit event id.
 */
export async function placeOrganizationLegalHold(
  sql: Sql,
  input: {
    scope: OrganizationDataScope;
    actor: ReceiptActor;
    workspaceId: string;
    dataSourceId: string;
    channelId?: string | null;
    reason: string;
  },
): Promise<{ hold: LegalHoldRecord; auditEventId: string }> {
  const scope = checkedScope(input.scope);
  const auth = authorize('place', scope, input.actor);
  const workspaceId = inScope(scope, input.workspaceId);
  const dataSourceId = requireText(input.dataSourceId, 'dataSourceId');
  const reason = requireText(input.reason, 'reason');
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [source] = await t<{ id: string }[]>`
      SELECT id FROM harness_shared.data_sources WHERE workspace_id = ${workspaceId} AND id::text = ${dataSourceId}`;
    if (!source) throw new LegalHoldError('not_found', `data source ${dataSourceId} not found in workspace ${workspaceId}`);
    // Chat enforcement compares channel_id to the bare container, so store the permission-list form bare.
    const prefix = `${source.id}#`;
    const raw = input.channelId?.trim() || null;
    const channelId = raw?.startsWith(prefix) ? raw.slice(prefix.length) || null : raw;
    const { id } = await placeLegalHold(t, workspaceId, {
      dataSourceId, channelId, reason, placedBy: auth.actorId,
    });
    const [row] = await t<HoldRow[]>`
      SELECT id, workspace_id, data_source_id, channel_id, reason, placed_by, placed_at, released_at, released_by
        FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${workspaceId} AND id = ${id}::uuid`;
    const retained = await retainedFor(t, workspaceId, id);
    const auditEventId = await appendOrganizationAuditEvent({
      // The event's workspace_id column holds hosted (uuid) workspace ids; data-source workspaces are
      // text slugs, so, as in the deletion receipt, the workspace is recorded in metadata only.
      organizationId: scope.organizationId,
      actorKind: auth.actorKind,
      actorId: auth.actorId,
      action: LEGAL_HOLD_ACTIONS.place,
      purpose: reason,
      targetType: 'legal_hold',
      targetId: id,
      metadata: {
        holdId: id, workspaceId, dataSourceId, channelId: row!.channel_id, reason,
        retained: retainedJson(retained),
      },
    }, t);
    return { hold: toRecord(row!, retained), auditEventId };
  });
}

/** Release an active hold. The release reason and what the hold was keeping go to the audit event. */
export async function releaseOrganizationLegalHold(
  sql: Sql,
  input: { scope: OrganizationDataScope; actor: ReceiptActor; holdId: string; reason: string },
): Promise<{ hold: LegalHoldRecord; auditEventId: string }> {
  const scope = checkedScope(input.scope);
  const auth = authorize('release', scope, input.actor);
  const holdId = requireText(input.holdId, 'holdId');
  const reason = requireText(input.reason, 'reason');
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [held] = await t<HoldRow[]>`
      SELECT id, workspace_id, data_source_id, channel_id, reason, placed_by, placed_at, released_at, released_by
        FROM harness_shared.data_source_legal_holds
       WHERE workspace_id = ANY(${scope.workspaceIds as string[]}::text[]) AND id::text = ${holdId}
       FOR UPDATE`;
    if (!held) throw new LegalHoldError('not_found', `hold ${holdId} not found in organization ${scope.organizationId}'s scope`);
    if (held.released_at) throw new LegalHoldError('already_released', `hold ${holdId} was released at ${iso(held.released_at)}`);
    const retainedAtRelease = await retainedFor(t, held.workspace_id, held.id);
    const { released } = await releaseLegalHold(t, held.workspace_id, { id: held.id, releasedBy: auth.actorId });
    if (released !== 1) throw new LegalHoldError('already_released', `hold ${holdId} was released concurrently`);
    const [row] = await t<HoldRow[]>`
      SELECT id, workspace_id, data_source_id, channel_id, reason, placed_by, placed_at, released_at, released_by
        FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${held.workspace_id} AND id = ${held.id}::uuid`;
    const auditEventId = await appendOrganizationAuditEvent({
      organizationId: scope.organizationId,
      actorKind: auth.actorKind,
      actorId: auth.actorId,
      action: LEGAL_HOLD_ACTIONS.release,
      purpose: reason,
      targetType: 'legal_hold',
      targetId: held.id,
      metadata: {
        holdId: held.id, workspaceId: held.workspace_id, dataSourceId: held.data_source_id, channelId: held.channel_id,
        reason, placedReason: held.reason, placedBy: held.placed_by, placedAt: iso(held.placed_at),
        retainedAtRelease: retainedJson(retainedAtRelease),
      },
    }, t);
    return { hold: toRecord(row!, null), auditEventId };
  });
}

/** The scope's holds (active first by placement time; released ones too when asked), with what each keeps. */
export async function listOrganizationLegalHolds(
  sql: Sql,
  input: { scope: OrganizationDataScope; actor: ReceiptActor; includeReleased?: boolean },
): Promise<LegalHoldRecord[]> {
  const scope = checkedScope(input.scope);
  authorize('list', scope, input.actor);
  const rows = await sql<HoldRow[]>`
    SELECT id, workspace_id, data_source_id, channel_id, reason, placed_by, placed_at, released_at, released_by
      FROM harness_shared.data_source_legal_holds
     WHERE workspace_id = ANY(${scope.workspaceIds as string[]}::text[])
       AND (${input.includeReleased === true} OR released_at IS NULL)
     ORDER BY (released_at IS NOT NULL), placed_at, id`;
  const active = new Map((await holdConflicts(sql, scope.workspaceIds)).map((c) => [c.holdId, c.retained]));
  return rows.map((r) => toRecord(r, r.released_at ? null : active.get(r.id) ?? []));
}

export interface LegalHoldExport {
  readonly hold: LegalHoldRecord;
  readonly stores: readonly HoldContentExport[];
  /** sha256 (hex) of the exported stores' canonical JSON; also recorded in the audit event. */
  readonly digest: string;
  readonly auditEventId: string;
}

/**
 * E-discovery export of exactly the content one ACTIVE hold keeps (chat messages, chat retrieval
 * units, documents), with the organization export's column shaping, plus one audit event naming
 * the per-store row counts and the digest. A released hold protects nothing, so exporting it would
 * present unprotected rows as held content: it is refused.
 */
export async function exportLegalHoldContent(
  sql: Sql,
  input: { scope: OrganizationDataScope; actor: ReceiptActor; holdId: string; purpose: string },
): Promise<LegalHoldExport> {
  const scope = checkedScope(input.scope);
  const auth = authorize('export', scope, input.actor);
  const holdId = requireText(input.holdId, 'holdId');
  const purpose = requireText(input.purpose, 'purpose');
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [held] = await t<HoldRow[]>`
      SELECT id, workspace_id, data_source_id, channel_id, reason, placed_by, placed_at, released_at, released_by
        FROM harness_shared.data_source_legal_holds
       WHERE workspace_id = ANY(${scope.workspaceIds as string[]}::text[]) AND id::text = ${holdId}`;
    if (!held) throw new LegalHoldError('not_found', `hold ${holdId} not found in organization ${scope.organizationId}'s scope`);
    if (held.released_at) throw new LegalHoldError('already_released', `hold ${holdId} was released; it keeps nothing to export`);
    const stores = await exportHoldContent(t, held);
    const digest = holdContentDigest(stores);
    const retained = await retainedFor(t, held.workspace_id, held.id);
    const auditEventId = await appendOrganizationAuditEvent({
      // Workspace in metadata only: the event's workspace_id column holds hosted (uuid) workspace ids.
      organizationId: scope.organizationId,
      actorKind: auth.actorKind,
      actorId: auth.actorId,
      action: LEGAL_HOLD_ACTIONS.export,
      purpose,
      targetType: 'legal_hold',
      targetId: held.id,
      metadata: {
        holdId: held.id, workspaceId: held.workspace_id, dataSourceId: held.data_source_id, channelId: held.channel_id,
        exported: stores.map((s) => ({ store: s.store, rows: s.rows.length })), digest,
      },
    }, t);
    return { hold: toRecord(held, retained), stores, digest, auditEventId };
  });
}
