/**
 * P-005 / D-034: outbound notifications through an installed provider package (Discord first).
 * Uses the same owner-scoped source resolution, trusted-addressee and disclosure rails as blog.ts.
 */
import type postgres from 'postgres';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressee, type AddresseeProvenance } from './addressing';
import { invokeOutboundProvider, resolveCapabilitySource, OUTBOUND_CAPABILITIES, type OutboundDispatchDeps } from './provider-dispatch';

/** Longest text a notification carries; a package may refuse a lower vendor limit. */
export const NOTIFY_TEXT_MAX = 2000;

export interface NotifySendInput {
  providerId: string;
  sourceId: string;
  text: string;
  /** Repeating a key asks the vendor to return the first message instead of posting twice. */
  idempotencyKey: string;
}

export async function sendNotification(sql: postgres.Sql, params: NotifySendInput & {
  workspaceId: string; userId: string; provenance: AddresseeProvenance; agentOwnerId: string | null;
}, deps: OutboundDispatchDeps = {}) {
  if (!params.sourceId.trim() || !params.providerId.trim()) throw new Error('notify_source_required');
  if (!params.text.trim() || [...params.text].length > NOTIFY_TEXT_MAX) throw new Error('notify_text_invalid');
  if (!params.idempotencyKey.trim() || params.idempotencyKey.length > 200) throw new Error('notify_idempotency_key_invalid');
  // An explicit source is still resolved through the owner's own sources: a caller cannot pick
  // another user's account or fall back to a different provider or channel.
  const target = await resolveCapabilitySource(sql, { workspaceId: params.workspaceId, userId: params.userId,
    datatype: 'notification', capabilities: [OUTBOUND_CAPABILITIES.notifySend], providerId: params.providerId, sourceId: params.sourceId }, deps);
  const channel = typeof target.source.config.channelId === 'string' ? target.source.config.channelId : target.source.id;
  const destination = `${target.provider.id}:${channel}`;
  await assertTrustedAddressee(sql, { workspaceId: params.workspaceId, userId: params.userId, address: destination, provenance: params.provenance });
  await assertDisclosurePermits(sql, { workspaceId: params.workspaceId, userId: params.userId,
    agentOwnerId: params.agentOwnerId, recipients: null, sink: `notify:${destination}` });
  const result = await invokeOutboundProvider(sql, target, OUTBOUND_CAPABILITIES.notifySend,
    { text: params.text, idempotencyKey: params.idempotencyKey }, deps);
  if (typeof result.externalId !== 'string' || !result.externalId.trim()) {
    throw Object.assign(new Error('notify_send_ambiguous_result_do_not_retry'), { retrySafe: false });
  }
  return { status: 'sent' as const, echo: { providerId: target.provider.id, sourceId: target.source.id, destination }, result };
}
