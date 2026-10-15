/**
 * report-attachments.ts — the consented-attachment store for problem reports
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-013, D-048 pt 4).
 *
 * A reporter attaches a log excerpt, a text snippet, a screenshot or a file
 * only when they tick it in the preview (D-013). The report TEXT lives on the
 * work item; an attachment lives here so it can be deleted 90 days after the
 * item closes while the text stays.
 *
 * One store for every door: the desktop "Report a problem" dialog writes door
 * 'desktop', the Slack door (slack-messages-to-bug-reports P-005) writes 'chat'.
 *
 * Rules enforced here (the migration repeats the hard ones as CHECKs):
 *   - at most REPORT_ATTACHMENT_MAX_BYTES per attachment and
 *     REPORT_ATTACHMENTS_PER_ITEM per work item;
 *   - text kinds (log, text) are re-redacted with redactSensitiveText before
 *     they are stored, whatever the door already did, and marked 'redacted';
 *   - images and opaque files are stored as received and marked
 *     'not-redactable', so no reader mistakes them for scrubbed content;
 *   - a write carrying an externalId is idempotent per (workspace, door).
 */
import { getOrgPg } from '@papercusp/db-org';
import { redactSensitiveText } from '../../sensitive-text';

export const REPORT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const REPORT_ATTACHMENTS_PER_ITEM = 5;
export const REPORT_ATTACHMENT_RETENTION_DAYS = 90;
export const REPORT_ATTACHMENT_SWEEP_BATCH = 500;

export const REPORT_ATTACHMENT_KINDS = ['log', 'text', 'screenshot', 'file'] as const;
export type ReportAttachmentKind = (typeof REPORT_ATTACHMENT_KINDS)[number];
export type ReportAttachmentRedaction = 'redacted' | 'not-redactable';

/** Work-item statuses that count as closed for the retention clock. */
export const REPORT_ATTACHMENT_CLOSED_STATUSES = ['done', 'dropped', 'resolved', 'closed'] as const;

const DOOR_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface PutReportAttachmentInput {
  workspaceId: string;
  workItemId: string;
  /** Which report door wrote it: 'desktop', 'chat', ... */
  door: string;
  kind: ReportAttachmentKind;
  mime: string;
  /** Text kinds take a string; screenshot and file take bytes. */
  content: string | Uint8Array;
  /** The door's own id for this attachment; makes a retried write idempotent. */
  externalId?: string | null;
}

export type PutReportAttachmentResult =
  | { ok: true; id: string; deduplicated: boolean; redaction: ReportAttachmentRedaction; byteSize: number }
  | { ok: false; reason: 'invalid' | 'too-large' | 'too-many'; detail: string };

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface ReportAttachmentDeps {
  sql?: Sql;
}

export function isTextAttachmentKind(kind: ReportAttachmentKind): boolean {
  return kind === 'log' || kind === 'text';
}

/**
 * Turn the input into the exact bytes that will be stored, plus their
 * redaction marker. Pure, so the caps and the redaction rule are unit-testable.
 */
export function prepareReportAttachment(
  input: Pick<PutReportAttachmentInput, 'kind' | 'content' | 'mime' | 'door' | 'externalId'>,
): { ok: true; bytes: Uint8Array; redaction: ReportAttachmentRedaction } | { ok: false; reason: 'invalid' | 'too-large'; detail: string } {
  if (!REPORT_ATTACHMENT_KINDS.includes(input.kind)) return { ok: false, reason: 'invalid', detail: `unknown kind ${String(input.kind)}` };
  if (!DOOR_RE.test(input.door)) return { ok: false, reason: 'invalid', detail: `invalid door ${JSON.stringify(input.door)}` };
  const mime = input.mime?.trim();
  if (!mime || mime.length > 128) return { ok: false, reason: 'invalid', detail: 'mime must be 1-128 characters' };
  if (input.externalId != null && (input.externalId.length < 1 || input.externalId.length > 256)) {
    return { ok: false, reason: 'invalid', detail: 'externalId must be 1-256 characters' };
  }
  let bytes: Uint8Array;
  let redaction: ReportAttachmentRedaction;
  if (isTextAttachmentKind(input.kind)) {
    const text = typeof input.content === 'string' ? input.content : new TextDecoder('utf-8').decode(input.content);
    bytes = new TextEncoder().encode(redactSensitiveText(text));
    redaction = 'redacted';
  } else {
    if (typeof input.content === 'string') {
      return { ok: false, reason: 'invalid', detail: `${input.kind} attachments take bytes, not text` };
    }
    bytes = input.content;
    redaction = 'not-redactable';
  }
  if (bytes.byteLength > REPORT_ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: 'too-large', detail: `${bytes.byteLength} bytes exceeds the ${REPORT_ATTACHMENT_MAX_BYTES}-byte cap` };
  }
  return { ok: true, bytes, redaction };
}

/** Store one consented attachment against a work item. */
export async function putReportAttachment(
  input: PutReportAttachmentInput,
  deps: ReportAttachmentDeps = {},
): Promise<PutReportAttachmentResult> {
  if (!input.workspaceId || !input.workItemId) return { ok: false, reason: 'invalid', detail: 'workspaceId and workItemId are required' };
  const prepared = prepareReportAttachment(input);
  if (!prepared.ok) return prepared;
  const sql = deps.sql ?? getOrgPg().sql;
  const externalId = input.externalId ?? null;
  const content = Buffer.from(prepared.bytes.buffer, prepared.bytes.byteOffset, prepared.bytes.byteLength);

  return await sql.begin(async (tx) => {
    // One writer per item at a time, so two concurrent writes cannot both pass the count cap.
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [`report-attachments:${input.workspaceId}:${input.workItemId}`]);
    if (externalId) {
      const [existing] = await tx.unsafe<Array<{ id: string; redaction: ReportAttachmentRedaction; byte_size: number; work_item_id: string; kind: string; mime: string; content: Buffer }>>(
        `SELECT id, redaction, byte_size, work_item_id, kind, mime, content FROM harness_shared.report_attachments
          WHERE workspace_id = $1 AND door = $2 AND external_id = $3`,
        [input.workspaceId, input.door, externalId],
      );
      if (existing) {
        if (existing.work_item_id !== input.workItemId || existing.kind !== input.kind
          || existing.mime !== input.mime.trim() || !Buffer.from(existing.content).equals(content)) {
          return { ok: false, reason: 'invalid', detail: 'externalId already binds a different attachment' };
        }
        return { ok: true, id: existing.id, deduplicated: true, redaction: existing.redaction, byteSize: existing.byte_size };
      }
    }
    const [{ n }] = await tx.unsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM harness_shared.report_attachments WHERE workspace_id = $1 AND work_item_id = $2`,
      [input.workspaceId, input.workItemId],
    );
    if (n >= REPORT_ATTACHMENTS_PER_ITEM) {
      return { ok: false, reason: 'too-many', detail: `${input.workItemId} already has ${n} attachments (cap ${REPORT_ATTACHMENTS_PER_ITEM})` };
    }
    const [row] = await tx.unsafe<Array<{ id: string }>>(
      `INSERT INTO harness_shared.report_attachments
         (workspace_id, work_item_id, door, kind, external_id, mime, byte_size, content, redaction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [input.workspaceId, input.workItemId, input.door, input.kind, externalId, input.mime.trim(), prepared.bytes.byteLength, content, prepared.redaction],
    );
    return { ok: true, id: row.id, deduplicated: false, redaction: prepared.redaction, byteSize: prepared.bytes.byteLength };
  });
}

export interface ReportAttachmentSummary {
  id: string;
  door: string;
  kind: ReportAttachmentKind;
  mime: string;
  byteSize: number;
  redaction: ReportAttachmentRedaction;
  createdAt: string;
}

/** List an item's attachments without their content. */
export async function listReportAttachments(
  workspaceId: string,
  workItemId: string,
  deps: ReportAttachmentDeps = {},
): Promise<ReportAttachmentSummary[]> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await sql.unsafe<Array<{ id: string; door: string; kind: ReportAttachmentKind; mime: string; byte_size: number; redaction: ReportAttachmentRedaction; created_at: Date | string }>>(
    `SELECT id, door, kind, mime, byte_size, redaction, created_at
       FROM harness_shared.report_attachments
      WHERE workspace_id = $1 AND work_item_id = $2
      ORDER BY created_at, id`,
    [workspaceId, workItemId],
  );
  return rows.map((r) => ({
    id: r.id,
    door: r.door,
    kind: r.kind,
    mime: r.mime,
    byteSize: r.byte_size,
    redaction: r.redaction,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export interface ReportAttachmentSweepResult {
  deleted: number;
  /** True when the batch filled, so more may be due on the next tick. */
  more: boolean;
}

/** Bounded evidence read for the existing work-item door. Bytes stay in the
 * mutable store; canonical fixes resolve their original report in this workspace.
 * Expired evidence is refused even before the background deletion sweep runs. */
export async function readReportAttachmentEvidence(
  workspaceId: string, workItemId: string,
  page: { id?: string; offset?: number; limit?: number } = {},
  deps: ReportAttachmentDeps & { harness?: string | null } = {},
) {
  const sql = deps.sql ?? getOrgPg().sql;
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 1024;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2048) {
    throw new Error('attachment page requires offset >= 0 and limit 1-2048');
  }
  const sources = await sql.unsafe<Array<{ id: string }>>(`
    SELECT COALESCE(s.feature_id, w.feature_id) AS id
      FROM harness_shared.work_items w
      LEFT JOIN harness_shared.work_items s
        ON s.workspace_id = w.workspace_id AND s.harness_slug = w.harness_slug
       AND w.payload -> 'intakeSource' ->> 'mode' = 'distinct'
       AND s.feature_id = w.payload -> 'intakeSource' ->> 'id'
     WHERE w.workspace_id = $1 AND w.feature_id = $2
       AND ($3::text IS NULL OR w.harness_slug = $3)
     LIMIT 2`, [workspaceId, workItemId, deps.harness ?? null]);
  if (sources.length !== 1) return { sourceWorkItemId: null, attachments: [], page: null };
  const source = sources[0];
  const rows = await sql.unsafe<Array<{
    id: string; kind: ReportAttachmentKind; mime: string; byte_size: number;
    redaction: ReportAttachmentRedaction; content: Buffer | null;
  }>>(`
    SELECT a.id, a.kind, a.mime, a.byte_size, a.redaction,
           CASE WHEN a.id::text = $3 THEN substring(a.content FROM $4 FOR $5) ELSE NULL END AS content
      FROM harness_shared.report_attachments a
      JOIN harness_shared.work_items s ON s.workspace_id = a.workspace_id AND s.feature_id = a.work_item_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS targets, bool_and(c.status = ANY($6::text[])) AS closed,
               max(c.state_changed_at) AS closed_at
          FROM harness_shared.work_items c
         WHERE c.workspace_id = s.workspace_id AND c.harness_slug = s.harness_slug
           AND c.payload -> 'intakeSource' ->> 'mode' = 'distinct'
           AND c.payload -> 'intakeSource' ->> 'id' = s.feature_id
      ) canonical ON true
     WHERE a.workspace_id = $1 AND a.work_item_id = $2
       AND NOT (canonical.targets = 1 AND canonical.closed
                AND canonical.closed_at < now() - interval '90 days')
       AND NOT (canonical.targets = 0 AND s.status = ANY($6::text[])
                AND s.state_changed_at < now() - interval '90 days')
     ORDER BY a.created_at, a.id LIMIT $7`,
    [workspaceId, source.id, page.id ?? '', offset + 1, limit,
      [...REPORT_ATTACHMENT_CLOSED_STATUSES], REPORT_ATTACHMENTS_PER_ITEM]);
  const selected = rows.find(r => r.id === page.id);
  return {
    sourceWorkItemId: source.id,
    attachments: rows.map(r => ({ id: r.id, kind: r.kind, mime: r.mime,
      byteSize: r.byte_size, redaction: r.redaction })),
    page: selected && selected.content !== null ? {
      id: selected.id, encoding: 'base64' as const, offset,
      data: Buffer.from(selected.content).toString('base64'),
      byteLength: selected.content.length, totalBytes: selected.byte_size,
      nextOffset: offset + selected.content.length < selected.byte_size ? offset + selected.content.length : null,
    } : null,
  };
}

const SWEEP_SQL = `
  DELETE FROM harness_shared.report_attachments
   WHERE id IN (
     SELECT a.id
       FROM harness_shared.report_attachments a
       LEFT JOIN harness_shared.work_items w
         ON w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS targets,
                bool_and(c.status = ANY($3::text[])) AS closed,
                max(c.state_changed_at) AS closed_at
           FROM harness_shared.work_items c
          WHERE c.workspace_id = a.workspace_id
            AND c.payload -> 'intakeSource' ->> 'mode' = 'distinct'
            AND c.payload -> 'intakeSource' ->> 'id' = a.work_item_id
       ) canonical ON true
      WHERE a.workspace_id = $1
        AND (
          (canonical.targets = 0 AND w.feature_id IS NULL
              AND a.created_at < now() - make_interval(days => $2::int))
          OR (canonical.targets = 1 AND canonical.closed
              AND canonical.closed_at < now() - make_interval(days => $2::int))
          OR (canonical.targets = 0 AND w.status = ANY($3::text[])
              AND w.state_changed_at < now() - make_interval(days => $2::int))
        )
      LIMIT $4
   )
  RETURNING id`;

/**
 * D-013: delete attachments whose work item closed more than
 * REPORT_ATTACHMENT_RETENTION_DAYS ago, and attachments whose item no longer
 * exists once they are that old. Bounded per call; the report text is untouched.
 */
export async function sweepExpiredReportAttachments(
  workspaceId: string,
  deps: ReportAttachmentDeps & { retentionDays?: number; batch?: number } = {},
): Promise<ReportAttachmentSweepResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const batch = deps.batch ?? REPORT_ATTACHMENT_SWEEP_BATCH;
  const rows = await sql.unsafe<Array<{ id: string }>>(SWEEP_SQL, [
    workspaceId,
    deps.retentionDays ?? REPORT_ATTACHMENT_RETENTION_DAYS,
    [...REPORT_ATTACHMENT_CLOSED_STATUSES],
    batch,
  ]);
  return { deleted: rows.length, more: rows.length >= batch };
}

export function renderReportAttachmentSweepNote(result: ReportAttachmentSweepResult | { error: string }): string {
  if ('error' in result) return `report-attachments error=${result.error}`;
  return `report-attachments deleted=${result.deleted}${result.more ? ' more=true' : ''}`;
}
