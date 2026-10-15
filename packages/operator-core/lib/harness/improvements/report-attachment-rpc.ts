/** P015/D054: consented bytes travel over the existing ephemeral peer RPC,
 * never the immutable issue log. The caller's workspace is never accepted. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { verifyAuthorityRpc } from '../../authority/authority-rpc-envelope';
import { registerAuthorityOp, registeredAuthorityOpKinds, type AuthorityOpHandler } from '../../authority/authority-op-registry';
import { PLATFORM_POT_SLUG } from '../../platform-pot-slug';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveGithubUserIdForDevicePubkey } from '../../sync/hyperbee/hive-member-identity-set';
import { loadRevokedHivePubkeysForLocalPot } from '../../federated-pot-scope';
import { getPeerRpcTransport, type PeerRpcTransport } from '../../authority/peer-rpc-transport';
import type { PeerRef } from '../../authority/lock-authority';
import { bakedCanonicalHiveInvite } from '../papercusp-hive-join';
import { getHiveByPubkey } from '../../hive-store';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import {
  REPORT_ATTACHMENT_KINDS, REPORT_ATTACHMENT_MAX_BYTES, putReportAttachment, prepareReportAttachment,
  type PutReportAttachmentResult,
} from './report-attachments';

export const REPORT_ATTACHMENT_RPC_KIND = 'report.attachment.put';
const inputSchema = z.object({
  workItemId: z.string().min(1).max(120),
  attachmentId: z.string().uuid(),
  kind: z.enum(REPORT_ATTACHMENT_KINDS),
  mime: z.string().trim().min(1).max(128),
  contentBase64: z.string().max(4 * Math.ceil(REPORT_ATTACHMENT_MAX_BYTES / 3)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface ReportAttachmentRpcDeps {
  /** Must check current uncached membership AND revocation, failing closed. */
  isCurrentMember: (devicePubkey: string) => Promise<boolean>;
  /** Reads the locally projected source, proves its author, and refuses expired
   * source/canonical-target retention. No row yet means retry, not success. */
  ownsRetainedReport: (devicePubkey: string, workItemId: string) => Promise<boolean>;
  workspaceId: string;
  putAttachment?: typeof putReportAttachment;
  nowMs?: () => number;
}

export type ReportAttachmentRpcResult =
  | { ok: true; id: string; sha256: string; deduplicated: boolean }
  | { ok: false; reason: 'unauthenticated' | 'invalid' | 'not-member' | 'report-unavailable' | 'store-refused' };

/** Signature enforcement is independent of the legacy RPC signed flag. */
export function buildReportAttachmentRpcHandler(deps: ReportAttachmentRpcDeps): AuthorityOpHandler {
  return async (payload, harness, context): Promise<ReportAttachmentRpcResult> => {
    const env = context?.envelope;
    if (!env || env.kind !== REPORT_ATTACHMENT_RPC_KIND || env.harnessSlug !== harness
      || env.payload !== payload || !verifyAuthorityRpc(env, env.auth, { nowMs: deps.nowMs?.() })) {
      return { ok: false, reason: 'unauthenticated' };
    }
    if (harness !== PLATFORM_POT_SLUG) return { ok: false, reason: 'invalid' };
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    const input = parsed.data;
    // Buffer's decoder is permissive. Require the canonical encoding and hash
    // before accepting bytes; this also rejects a lie about their length.
    const content = Buffer.from(input.contentBase64, 'base64');
    if (content.length > REPORT_ATTACHMENT_MAX_BYTES || content.toString('base64') !== input.contentBase64
      || createHash('sha256').update(content).digest('hex') !== input.sha256) {
      return { ok: false, reason: 'invalid' };
    }
    const caller = env.auth!.device_pubkey;
    // A failed membership/report read is not permission to accept the blob.
    if (!await deps.isCurrentMember(caller).catch(() => false)) return { ok: false, reason: 'not-member' };
    if (!await deps.ownsRetainedReport(caller, input.workItemId).catch(() => false)) {
      return { ok: false, reason: 'report-unavailable' };
    }
    const prepared = prepareReportAttachment({ ...input, door: 'federation', content });
    if (!prepared.ok) return { ok: false, reason: 'invalid' };
    const stored: PutReportAttachmentResult = await (deps.putAttachment ?? putReportAttachment)({
      workspaceId: deps.workspaceId, workItemId: input.workItemId, door: 'federation',
      kind: input.kind, mime: input.mime, content,
      externalId: `${caller}:${input.attachmentId}`,
    });
    if (!stored.ok) return { ok: false, reason: 'store-refused' };
    return { ok: true, id: stored.id,
      sha256: createHash('sha256').update(prepared.bytes).digest('hex'), deduplicated: stored.deduplicated };
  };
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

/** Receiver scope comes from the local runtime, never an untrusted request. */
export function defaultReportAttachmentRpcDeps(workspaceId: string, sql: Sql = getOrgPg().sql): ReportAttachmentRpcDeps {
  return {
    workspaceId,
    isCurrentMember: async caller => {
      const [member, revoked] = await Promise.all([
        resolveGithubUserIdForDevicePubkey(workspaceId, PLATFORM_POT_SLUG, caller, sql),
        loadRevokedHivePubkeysForLocalPot(workspaceId, PLATFORM_POT_SLUG, sql),
      ]);
      return member !== null && !revoked.has(caller);
    },
    ownsRetainedReport: async (caller, id) => {
      // A late retry must not resurrect bytes deleted under D053. Ambiguous
      // canonical mappings are preserved by retention but not writable here.
      // Terminal = the canonical cross-family set (D-068): no item_kind filter here.
      const [row] = await sql.unsafe<Array<{ allowed: boolean }>>(`
        SELECT (canonical.targets <= 1 AND NOT (
          (canonical.targets = 1 AND canonical.closed AND canonical.closed_at < now() - interval '90 days')
          OR (canonical.targets = 0 AND w.status = ANY($5::text[])
            AND w.state_changed_at < now() - interval '90 days')
        )) AS allowed
        FROM harness_shared.work_items w
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS targets,
            bool_and(c.status = ANY($5::text[])) AS closed,
            max(c.state_changed_at) AS closed_at
          FROM harness_shared.work_items c
          WHERE c.workspace_id = w.workspace_id
            AND c.payload -> 'intakeSource' ->> 'mode' = 'distinct'
            AND c.payload -> 'intakeSource' ->> 'id' = w.feature_id
        ) canonical ON true
        WHERE w.workspace_id = $1 AND w.harness_slug = $2 AND w.feature_id = $3
          AND w.author_pubkey = $4 AND w.origin = 'remote'`,
      [workspaceId, PLATFORM_POT_SLUG, id, caller, [...ANY_FAMILY_TERMINAL_STATES]]);
      return row?.allowed === true;
    },
    putAttachment: input => putReportAttachment(input, { sql }),
  };
}

/** Installed by the existing peer-RPC boot seam. No new endpoint or transport. */
export function registerReportAttachmentRpc(): void {
  if (registeredAuthorityOpKinds().includes(REPORT_ATTACHMENT_RPC_KIND)) return;
  registerAuthorityOp(REPORT_ATTACHMENT_RPC_KIND, async (payload, harness, context) =>
    buildReportAttachmentRpcHandler(defaultReportAttachmentRpcDeps(activeWorkspaceId()))(payload, harness, context),
  { authorityExempt: true });
}

export interface ForwardReportAttachmentDeps {
  sql?: Sql;
  transport?: PeerRpcTransport;
  canonicalPeer?: (workspaceId: string) => Promise<PeerRef | null>;
}

/** Existing sender RPC signs with the local device; receiver acknowledgement is
 * accepted only for the exact byte hash. No fallback to an immutable payload. */
export async function forwardReportAttachment(workspaceId: string, attachmentId: string,
  deps: ForwardReportAttachmentDeps = {}): Promise<{ delivered: boolean; reason?: string }> {
  const sql = deps.sql ?? getOrgPg().sql;
  const peer = await (deps.canonicalPeer ?? (async ws => {
    const invite = bakedCanonicalHiveInvite();
    if (!invite?.ownerDevicePubkey || !await getHiveByPubkey(ws, invite.pubkeyBase64)) return null;
    return { devicePubkey: invite.ownerDevicePubkey, githubUserId: 0, machineLabel: 'canonical-report-owner' };
  }))(workspaceId);
  if (!peer) return { delivered: false, reason: 'canonical-membership-unavailable' };
  const [row] = await sql.unsafe<Array<{ work_item_id: string; id: string; kind: string; mime: string; content: Buffer }>>(`
    SELECT a.id, a.work_item_id, a.kind, a.mime, a.content
    FROM harness_shared.report_attachments a
    JOIN harness_shared.work_items w ON w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
    WHERE a.workspace_id = $1 AND a.id = $2 AND a.door = 'desktop'
      AND w.harness_slug = $3 AND w.origin = 'local'`, [workspaceId, attachmentId, PLATFORM_POT_SLUG]);
  if (!row) return { delivered: false, reason: 'local-attachment-unavailable' };
  const content = Buffer.from(row.content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  try {
    const result = await (deps.transport ?? getPeerRpcTransport()).rpc(peer, {
      harnessSlug: PLATFORM_POT_SLUG, kind: REPORT_ATTACHMENT_RPC_KIND,
      payload: { workItemId: row.work_item_id, attachmentId: row.id, kind: row.kind, mime: row.mime,
        contentBase64: content.toString('base64'), sha256 },
    }) as Partial<ReportAttachmentRpcResult>;
    if (!result || result.ok !== true || !('sha256' in result) || result.sha256 !== sha256 || !('id' in result) || !result.id) {
      return { delivered: false, reason: 'upstream-receipt-unconfirmed' };
    }
    // Only receipt metadata federates; the content remains in the deletable
    // attachment table on each peer. Concurrent attachments keep sibling receipts.
    await sql.unsafe(`UPDATE harness_shared.work_items
      SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{_reportAttachmentReceipts}',
        COALESCE(payload -> '_reportAttachmentReceipts', '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb))
      WHERE workspace_id = $3 AND harness_slug = $4 AND feature_id = $5 AND origin = 'local'`,
    [row.id, JSON.stringify({ id: result.id, sha256, receivedAt: new Date().toISOString() }), workspaceId, PLATFORM_POT_SLUG, row.work_item_id]);
    return { delivered: true };
  } catch {
    return { delivered: false, reason: 'upstream-unavailable' };
  }
}

/** Retry consented local bytes using the existing watchdog; no new schedule. */
export async function retryReportAttachmentDelivery(workspaceId: string, deps: ForwardReportAttachmentDeps = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await sql.unsafe<Array<{ id: string }>>(`
    SELECT a.id FROM harness_shared.report_attachments a
    JOIN harness_shared.work_items w ON w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
    WHERE a.workspace_id = $1 AND a.door = 'desktop' AND w.harness_slug = $2 AND w.origin = 'local'
      AND NOT (COALESCE(w.payload -> '_reportAttachmentReceipts', '{}'::jsonb) ? a.id::text)
    ORDER BY a.created_at, a.id LIMIT 5`, [workspaceId, PLATFORM_POT_SLUG]);
  // One existing RPC timeout, not five serial timeouts on the watchdog path.
  const outcomes = await Promise.all(rows.map(row =>
    forwardReportAttachment(workspaceId, row.id, { ...deps, sql }).catch(() => ({ delivered: false }))));
  const delivered = outcomes.filter(outcome => outcome.delivered).length;
  return { attempted: rows.length, delivered };
}
