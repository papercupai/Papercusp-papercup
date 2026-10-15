/**
 * P-008b (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010012184, D-018):
 * the organization audit stream of the SIEM export.
 *
 * Source: `papercusp_auth.organization_audit_events`, append-only, which includes the organization
 * data receipts written by organization-data-receipts.ts (P-007c, read here, never edited). One
 * stream per organization, `papercusp.siem-export.org-audit:<organizationId>`, over the D-017 batch
 * format, manifest, hash chain and verifier. It is separate from the per-workspace tool-invocation
 * chain because the cursors differ (uuid + time vs bigint), a receipt has no workspace, and a
 * time-merged chain would make replay identity depend on two tables' commit timing.
 *
 * Correlation key `oae:<id>`; cursor `<recorded_at, UTC, microseconds>|<id>`, ordered by
 * (recorded_at, id), bounded by `settleHorizon` (a receipt's recorded_at is its transaction's START).
 *
 * Redaction is declared per column (`ORG_AUDIT_COLUMNS`). `metadata` is pii: a receipt gets a
 * declared projection (`projectReceiptMetadata`); any other metadata, and any key a receipt carries
 * beyond the declaration, becomes key names plus a keyed digest. The credential scrub runs last.
 *
 * Access: a human principal with governance `approve` over the organization's root layer. Fails closed.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { ChainLink } from '@papercusp/hash-chain';
import { authorize, principalKindOf } from '../governance-policy/authority';
import { listLayers, type StoredPolicyLayer } from '../governance-policy/store';
import { ORGANIZATION_DATA_RECEIPT_VERSION, RECEIPT_ACTIONS } from './organization-data-receipts';
import {
  SIEM_MAX_PAGE,
  SIEM_ORG_AUDIT_STREAM_PREFIX,
  SiemExportAccessError,
  buildSiemBatch,
  scrubCredentialValues,
  settleHorizon,
  siemArgsDigest,
  siemAssertKey,
  siemCodeValue,
  siemPseudonym,
  siemScalar,
  type SiemBatch,
  type SiemColumnClass,
  type SiemEvent,
  type SiemSettleHorizon,
} from './siem-export';

export const ORG_AUDIT_LOG_NAME = 'papercusp.organization_audit_events' as const;
/** The cursor before the first event (same sentinel as the tool-invocation stream). */
export const ORG_AUDIT_CURSOR_START = '0' as const;

const op = (why: string): SiemColumnClass => ({ dataClass: 'operational', treatment: 'emit', why });
const code = (why: string): SiemColumnClass => ({ dataClass: 'operational', treatment: 'emit-code', why });

/** Every column of papercusp_auth.organization_audit_events (migration 907), classified. Pinned to the schema by test. */
export const ORG_AUDIT_COLUMNS = {
  id: op('row id: the correlation key (oae:<id>) and, with recorded_at, the cursor'),
  organization_id: op('tenant'),
  workspace_id: op('workspace scope, when the event has one'),
  actor_kind: op('identity: customer_user | staff_admin | system'),
  actor_id: { dataClass: 'pii', treatment: 'pseudonymize', why: 'identifies the acting person' },
  action: op('the action'),
  purpose: code('declared purpose: code-shaped values only, free text is withheld'),
  target_type: op('resource type'),
  target_id: code('resource id: code-shaped values only'),
  metadata: {
    dataClass: 'pii',
    treatment: 'declared-projection',
    why: 'free-form; a receipt is projected by declaration, anything else becomes key names plus a keyed digest',
  },
  occurred_at: op('event time'),
  recorded_at: op('commit-ordering time and cursor'),
} as const satisfies Record<string, SiemColumnClass>;

export type OrgAuditColumn = keyof typeof ORG_AUDIT_COLUMNS;
export type OrgAuditRow = { readonly [K in OrgAuditColumn]?: unknown };

export function orgAuditStreamId(organizationId: string): string {
  return `${SIEM_ORG_AUDIT_STREAM_PREFIX}${organizationId}`;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OrgAuditCursor {
  readonly recordedAt: string;
  readonly id: string;
}

export function encodeOrgAuditCursor(c: OrgAuditCursor): string {
  if (!MICRO_ISO.test(c.recordedAt) || !UUID.test(c.id)) {
    throw new Error(`siem-export-org-audit: invalid cursor parts ${JSON.stringify(c)}`);
  }
  return `${c.recordedAt}|${c.id}`;
}

/** null = the start sentinel. */
export function decodeOrgAuditCursor(cursor: string): OrgAuditCursor | null {
  if (cursor === ORG_AUDIT_CURSOR_START) return null;
  const [recordedAt, id, ...rest] = cursor.split('|');
  if (rest.length || !recordedAt || !id || !MICRO_ISO.test(recordedAt) || !UUID.test(id)) {
    throw new Error(`siem-export-org-audit: cursor ${JSON.stringify(cursor)} is not '<UTC microsecond time>|<uuid>'`);
  }
  return { recordedAt, id };
}

// ── Metadata projection ─────────────────────────────────────────────────────

const RECEIPT_ACTION_SET = new Set(Object.values(RECEIPT_ACTIONS));

/**
 * emit-code for this stream IS the tool-invocation stream's rule (siem-export.ts SIEM_CODE_SHAPED,
 * WI-6554700010012363): one export format, one redaction shape. Uuids, store names, migration file
 * names and build shas pass; anything with spaces or other free-text characters is withheld.
 */
export const codeValue = siemCodeValue;

function isoTime(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codes(value: unknown): (string | null)[] | null {
  return Array.isArray(value) ? value.map((v) => codeValue(v)) : null;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
}

/** The top-level metadata keys a receipt projection declares; anything else is digested. */
export const RECEIPT_DECLARED_KEYS = [
  'receiptVersion', 'operation', 'workspaceIds', 'populationSize', 'stores', 'limitations',
  'codeVersion', 'schemaVersion', 'holdConflicts', 'revocations',
] as const;

export function isReceiptEvent(action: unknown, metadata: unknown): metadata is Record<string, unknown> {
  return (
    RECEIPT_ACTION_SET.has(String(action ?? '')) &&
    !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).receiptVersion === ORGANIZATION_DATA_RECEIPT_VERSION
  );
}

/** The declared projection of a receipt (receiptMetadata, organization-data-receipts.ts). */
export function projectReceiptMetadata(meta: Record<string, unknown>, key: Uint8Array | string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    receiptVersion: codeValue(meta.receiptVersion),
    operation: codeValue(meta.operation),
    workspaceIds: codes(meta.workspaceIds),
    populationSize: num(meta.populationSize),
    stores: objects(meta.stores).map((s) => ({
      store: codeValue(s.store),
      executor: codeValue(s.executor),
      retention: codeValue(s.retention),
      outcome: codeValue(s.outcome),
      rowCount: num(s.rowCount),
      rowsRemaining: num(s.rowsRemaining),
      exportedColumns: codes(s.exportedColumns),
      excludedColumns: codes(s.excludedColumns),
      // A failed store's reason can carry a database error message: withheld.
      reason: s.outcome === 'failed' ? null : typeof s.reason === 'string' ? s.reason : null,
    })),
    limitations: Array.isArray(meta.limitations) ? meta.limitations.filter((l): l is string => typeof l === 'string') : [],
    codeVersion: codeValue(meta.codeVersion),
    schemaVersion: codeValue(meta.schemaVersion),
  };
  if (meta.holdConflicts !== undefined) {
    out.holdConflicts = objects(meta.holdConflicts).map((h) => ({
      holdId: codeValue(h.holdId),
      workspaceId: codeValue(h.workspaceId),
      dataSourceId: codeValue(h.dataSourceId),
      channelId: codeValue(h.channelId),
      placedAt: isoTime(h.placedAt),
      retained: objects(h.retained).map((r) => ({ store: codeValue(r.store), rows: num(r.rows) })),
    }));
  }
  if (meta.revocations !== undefined) {
    out.revocations = objects(meta.revocations).map((r) => ({
      workspaceId: codeValue(r.workspaceId),
      provider: codeValue(r.provider),
      providerUserId: typeof r.providerUserId === 'string' && r.providerUserId ? siemPseudonym(key, r.providerUserId) : null,
      mappingsRevoked: num(r.mappingsRevoked),
      readableDocuments: num(r.readableDocuments),
      denied: typeof r.denied === 'boolean' ? r.denied : null,
    }));
  }
  const undeclared = Object.fromEntries(
    Object.entries(meta).filter(([k]) => !(RECEIPT_DECLARED_KEYS as readonly string[]).includes(k)),
  );
  if (Object.keys(undeclared).length > 0) out.undeclared = siemArgsDigest(key, undeclared);
  return out;
}

function parseMetadata(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** One organization audit event as a redacted OCSF API Activity event. */
export function projectOrgAuditEvent(row: OrgAuditRow, key: Uint8Array | string): SiemEvent {
  const id = String(siemScalar(row.id) ?? '');
  if (!UUID.test(id)) throw new Error(`siem-export-org-audit: row id ${JSON.stringify(row.id)} is not a uuid`);
  const occurred = Date.parse(String(siemScalar(row.occurred_at)));
  const recorded = Date.parse(String(siemScalar(row.recorded_at)));
  if (!Number.isFinite(occurred) || !Number.isFinite(recorded)) {
    throw new Error(`siem-export-org-audit: event ${id} has an invalid occurred_at/recorded_at`);
  }
  const source: Record<string, unknown> = {};
  for (const column of Object.keys(ORG_AUDIT_COLUMNS) as OrgAuditColumn[]) {
    const raw = row[column];
    switch (ORG_AUDIT_COLUMNS[column].treatment) {
      case 'emit':
        source[column] = siemScalar(raw);
        break;
      case 'emit-code':
        source[column] = codeValue(raw);
        break;
      case 'pseudonymize': {
        const v = siemScalar(raw);
        source[column] = v === null || v === '' ? null : siemPseudonym(key, String(v));
        break;
      }
      default:
        break;
    }
  }
  const meta = parseMetadata(row.metadata);
  const receipt = isReceiptEvent(row.action, meta);
  const projected = receipt ? projectReceiptMetadata(meta, key) : siemArgsDigest(key, meta);
  const failedStore = receipt && objects(meta.stores).some((s) => s.outcome === 'failed');
  const uid = `oae:${id}`;
  const event = {
    class_uid: 6003,
    category_uid: 6,
    activity_id: 99,
    type_uid: 600399,
    time: occurred,
    status_id: failedStore ? 2 : 1,
    severity_id: 1,
    metadata: {
      version: '1.3.0',
      uid,
      correlation_uid: uid,
      log_name: ORG_AUDIT_LOG_NAME,
      logged_time: recorded,
      product: { name: 'Papercusp', vendor_name: 'Papercusp' },
      tenant_uid: source.organization_id,
    },
    actor: { user: { uid: source.actor_id, type: source.actor_kind } },
    api: { operation: source.action, request: { uid } },
    resources: source.target_type ? [{ type: source.target_type, uid: source.target_id }] : [],
    unmapped: {
      papercusp_source: source,
      papercusp_metadata: receipt ? { kind: 'receipt', receipt: projected } : { kind: 'digest', digest: projected },
    },
  };
  return scrubCredentialValues(event);
}

// ── Read ────────────────────────────────────────────────────────────────────

const MICRO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${col}`;

/** Events of one organization after `after`, strictly before `bound`, ordered by (recorded_at, id). */
export async function readOrgAuditPage(
  sql: Sql,
  input: { readonly organizationId: string; readonly after: string; readonly limit: number; readonly bound: Date; readonly upTo?: string },
): Promise<OrgAuditRow[]> {
  if (!UUID.test(input.organizationId)) throw new Error('siem-export-org-audit: organizationId must be a uuid');
  const after = decodeOrgAuditCursor(input.after);
  const upTo = input.upTo !== undefined ? decodeOrgAuditCursor(input.upTo) : null;
  const limit = Math.max(1, Math.min(SIEM_MAX_PAGE, Math.trunc(input.limit)));
  const params: unknown[] = [input.organizationId, input.bound.toISOString(), limit];
  let where = 'organization_id = $1::uuid AND recorded_at < $2::timestamptz';
  if (after) {
    params.push(after.recordedAt, after.id);
    where += ` AND (recorded_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  if (upTo) {
    params.push(upTo.recordedAt, upTo.id);
    where += ` AND (recorded_at, id) <= ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const rows = await sql.unsafe(
    `SELECT id::text AS id, organization_id::text AS organization_id, workspace_id::text AS workspace_id,
            actor_kind, actor_id, action, purpose, target_type, target_id, metadata,
            ${MICRO('occurred_at')}, ${MICRO('recorded_at')}
       FROM papercusp_auth.organization_audit_events
      WHERE ${where}
      ORDER BY recorded_at, id
      LIMIT $3`,
    params as never[],
  );
  return rows as unknown as OrgAuditRow[];
}

// ── Access + export ─────────────────────────────────────────────────────────

/** The organization's root policy layer: level 'organization', scope_ref = the organization id. */
export async function organizationRootLayer(organizationId: string, sql?: Sql): Promise<StoredPolicyLayer | null> {
  const layers = await listLayers(sql);
  return layers.find((l) => l.level === 'organization' && l.scopeRef === organizationId) ?? null;
}

/** Human principals with governance `approve` over the organization's root layer. Fails closed. */
export async function assertOrgAuditExportAuthorized(
  principal: string,
  organizationId: string,
  opts: { readonly sql?: Sql; readonly now?: Date } = {},
): Promise<{ readonly layer: StoredPolicyLayer }> {
  try {
    if (typeof principal !== 'string' || principalKindOf(principal) !== 'human') {
      throw new SiemExportAccessError('only a human principal may export audit evidence');
    }
    const layer = await organizationRootLayer(organizationId, opts.sql);
    if (!layer) throw new SiemExportAccessError(`organization ${organizationId} has no organization policy layer`);
    const allowed = await authorize(principal, layer.layerId, 'approve', { sql: opts.sql, now: opts.now });
    if (!allowed) throw new SiemExportAccessError(`${principal} lacks approve over ${layer.layerId}`);
    return { layer };
  } catch (error) {
    if (error instanceof SiemExportAccessError) throw error;
    throw new SiemExportAccessError(`authorization check failed: ${(error as Error).message}`);
  }
}

export interface ExportOrgAuditPageInput {
  readonly principal: string;
  readonly organizationId: string;
  /** The last exported cursor (ORG_AUDIT_CURSOR_START for the first batch). */
  readonly after: string;
  readonly prevHead: ChainLink | null;
  readonly limit: number;
  readonly key: Uint8Array | string;
  readonly keyId?: string;
  readonly now?: Date;
  readonly settleMs?: number;
  readonly sql?: Sql;
  /** Rebuild a delivered batch up to this cursor (inclusive). */
  readonly upTo?: string;
}

export async function exportOrgAuditPage(input: ExportOrgAuditPageInput): Promise<SiemBatch & { readonly horizon: SiemSettleHorizon }> {
  siemAssertKey(input.key);
  const db = input.sql ?? getOrgPg().sql;
  const now = input.now ?? new Date();
  await assertOrgAuditExportAuthorized(input.principal, input.organizationId, { sql: db, now });
  const horizon = await settleHorizon(db, now, input.settleMs);
  const rows = await readOrgAuditPage(db, {
    organizationId: input.organizationId,
    after: input.after,
    limit: input.limit,
    bound: horizon.bound,
    upTo: input.upTo,
  });
  const entries = rows.map((row) => ({
    id: encodeOrgAuditCursor({ recordedAt: String(row.recorded_at), id: String(row.id) }),
    event: projectOrgAuditEvent(row, input.key),
  }));
  const batch = buildSiemBatch({
    streamId: orgAuditStreamId(input.organizationId),
    prevHead: input.prevHead,
    cursorFrom: input.after,
    entries,
    keyId: input.keyId,
  });
  return { ...batch, horizon };
}
