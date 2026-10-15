/** Device actions reuse audit_log as their durable retry receipt (no second ledger). */
import { createHash, randomUUID } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import type { Principal } from '@papercusp/agent-mcp';

export interface DeviceActionReply { status: number; body: Record<string, unknown> }
export interface DeviceActionContext {
  principal: Principal;
  owner: string;
  action: 'send' | 'end';
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function deviceActionKey(context: DeviceActionContext, key: string): string {
  return `device-session-${digest([context.principal.workspaceId, context.principal.slug, key])}`;
}
export function deviceActionRefusal(error: string, status = 403): DeviceActionReply {
  return { status, body: { ok: false, error } };
}

/** JWT authentication precedes this writer; no anonymous network-triggered audit writes. */
export async function auditDeviceAction(context: DeviceActionContext, reply: DeviceActionReply): Promise<DeviceActionReply> {
  await withWorkspace(context.principal.workspaceId, async tx => {
    const details = JSON.stringify({ deviceId: context.principal.slug, owner: context.owner,
      action: context.action, status: reply.status, reason: reply.body.error ?? null });
    await tx`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${randomUUID()}, ${Date.now()}, ${context.principal.slug}, ${`device.session.${context.action}`},
        ${context.owner}, ${details}::text::jsonb, ${context.principal.workspaceId})`;
  });
  return reply;
}

/**
 * Serialize concurrent retries in the existing workspace transaction. Store a hash,
 * never message text or a caller's key. Same key + different target/body conflicts.
 * The downstream coord:send also receives this key and deduplicates durable messages,
 * protecting the send if the audit transaction loses its commit acknowledgement.
 */
export async function runDeviceAction(context: DeviceActionContext, key: string,
  request: unknown, run: (writeKey: string) => Promise<DeviceActionReply>): Promise<DeviceActionReply> {
  const id = deviceActionKey(context, key);
  const requestHash = digest([context.action, context.owner, request]);
  const reply = await withWorkspace(context.principal.workspaceId, async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const rows = await tx<Array<{ details: { requestHash?: string; reply?: DeviceActionReply } }>>`
      SELECT details FROM harness_shared.audit_log WHERE id = ${id} AND workspace_id = ${context.principal.workspaceId}`;
    if (rows[0]) {
      if (rows[0].details.requestHash !== requestHash) return deviceActionRefusal('idempotency_conflict', 409);
      return rows[0].details.reply ?? deviceActionRefusal('action_receipt_unavailable', 503);
    }
    const result = await run(id);
    const details = JSON.stringify({ deviceId: context.principal.slug, owner: context.owner,
      action: context.action, requestHash, status: result.status, reason: result.body.error ?? null, reply: result });
    await tx`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${context.principal.slug}, ${`device.session.${context.action}`},
        ${context.owner}, ${details}::text::jsonb, ${context.principal.workspaceId})`;
    return result;
  });
  // A conflicting request is a new refusal, with its own exactly-one audit row.
  return reply.body.error === 'idempotency_conflict' ? auditDeviceAction(context, reply) : reply;
}
