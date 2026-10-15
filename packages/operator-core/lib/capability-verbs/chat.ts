/**
 * Provider-neutral chat capability seam (D-019 Tier 1, plan item P-031;
 * provider dispatch since cupboard-distributable-integrations-2026-10-10 P-008,
 * D-018).
 *
 * Three verbs, one rail: the caller supplies TEXT; where the message goes is
 * resolved server-side, and it is sent through whichever installed provider
 * package serves the source (`chat.reply` capability, the same dispatch as
 * `ticket.create`). No verb here names a provider, so Slack, Teams or Discord
 * are packages, not code paths.
 *
 *  - {@link replyToCanonicalChat}: reply to a stored `chat-message` document.
 *  - {@link replyToTriggerRun}: reply to the message that started a trigger-bound
 *    plan run, exactly once per succeeded run (the row lock fences retries).
 *  - {@link postToChatChannel}: create-shaped; the caller names the channel, so
 *    the addressee rail (D-020 rail 2) applies.
 */
import type postgres from 'postgres';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressee, type AddresseeProvenance } from './addressing';
import {
  invokeOutboundProvider,
  OUTBOUND_CAPABILITIES,
  resolveCapabilitySource,
  resultString,
  type OutboundDispatchDeps,
  type OutboundTarget,
} from './provider-dispatch';
import { resolveCanonicalDocument, string, type CanonicalDocument } from './resolve';

type Db = postgres.Sql | postgres.TransactionSql;

const CHAT_DATATYPE = 'chat-message' as const;
const CHAT_REPLY = OUTBOUND_CAPABILITIES.chatReply;
const MAX_TEXT = 4_000;

export interface ChatReplyCoordinates {
  channelId: string;
  threadId: string;
}

export interface ChatReplyResult {
  channelId: string;
  threadId: string;
  messageTs: string;
  /** The provider package that posted the message (e.g. `slack`). */
  provider: string;
}

export interface TriggerRunReplyResult extends ChatReplyResult {
  posted: boolean;
  alreadyPosted: boolean;
}

/** Registry / `host.fetch` seams, shared with every provider-dispatched verb. */
export type ChatDeps = OutboundDispatchDeps & { now?: () => Date };

/**
 * D-020 rail 1 for chat. Pure and exported for the same reason as the mail
 * equivalent: the security claim is "these coordinates come from the stored
 * document, never from a caller argument", and that is only checkable if the
 * derivation is a function of the document alone.
 *
 * A thread reply targets `threadId` when the message is already in a thread,
 * and the message's own id when it is a top-level message — replying to a root
 * message means STARTING its thread.
 */
export function resolveChatReplyCoordinates(doc: CanonicalDocument): ChatReplyCoordinates {
  if (doc.datatypeId !== CHAT_DATATYPE) {
    throw new Error(`chat_reply_datatype_unsupported:${doc.datatypeId ?? doc.source}`);
  }
  const payload = doc.payload;
  const channelId = string(payload.channelId);
  const threadId = string(payload.threadId) || string(payload.id) || doc.externalId;
  if (!channelId) throw new Error('chat_reply_coordinates_missing');
  if (!threadId) throw new Error('chat_reply_coordinates_missing');
  return { channelId, threadId };
}

function validText(raw: string, code: string): string {
  const text = raw.trim();
  if (!text || text.length > MAX_TEXT) throw new Error(code);
  return text;
}

/** The disclosure-ledger sink for a channel: `<provider>:<channel>`. */
export function chatDisclosureSink(target: Pick<OutboundTarget, 'provider'>, channelId: string): string {
  return `${target.provider.id}:${channelId}`;
}

async function postReply(
  sql: Db,
  target: OutboundTarget,
  coordinates: ChatReplyCoordinates,
  text: string,
  deps: ChatDeps,
): Promise<ChatReplyResult> {
  const result = await invokeOutboundProvider(
    sql as postgres.Sql,
    target,
    CHAT_REPLY,
    { channelId: coordinates.channelId, threadId: coordinates.threadId, text },
    deps,
  );
  return {
    channelId: resultString(result, 'channelId', target, CHAT_REPLY, false) || coordinates.channelId,
    threadId: resultString(result, 'threadId', target, CHAT_REPLY, false) || coordinates.threadId,
    messageTs: resultString(result, 'messageTs', target, CHAT_REPLY),
    provider: target.provider.id,
  };
}

/** `chat:reply { messageId }` — caller supplies TEXT ONLY; destination is server-resolved. */
export async function replyToCanonicalChat(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    messageId: string;
    text: string;
    /**
     * Reader-set labels: see `sendNewMail` in ./mail. A channel's readers cannot
     * be enumerated as mailboxes, so any active disclosure refuses the post.
     */
    agentOwnerId: string | null;
  },
  deps: ChatDeps = {},
): Promise<ChatReplyResult> {
  const text = validText(params.text, 'chat_reply_text_invalid');
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    datatypeId: CHAT_DATATYPE,
    externalId: params.messageId,
  });
  const coordinates = resolveChatReplyCoordinates(doc);
  // Reply AS the source that received the message — never another connected account.
  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: CHAT_DATATYPE,
      capabilities: [CHAT_REPLY],
      sourceId: doc.sourceId ?? null,
    },
    deps,
  );
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: chatDisclosureSink(target, coordinates.channelId),
  });
  return postReply(sql, target, coordinates, text, deps);
}

interface TriggerRunRow {
  id: string;
  args: Record<string, unknown>;
  outcome: unknown;
  sourceId: string;
  ownerUserId: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * `chat:reply { planRunId }` — reply in the thread of the chat message that
 * started a trigger-bound plan run. The coordinates come from the run's own
 * trigger payload, and the reply posts as the run's source.
 *
 * Exactly once per succeeded run: the run row is locked, a prior reply recorded
 * in its outcome short-circuits, and the new reply is written back in the same
 * transaction.
 */
export async function replyToTriggerRun(
  sql: Db,
  params: { workspaceId: string; planRunId: number; text: string },
  deps: ChatDeps = {},
): Promise<TriggerRunReplyResult> {
  const { workspaceId, planRunId } = params;
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('chat_reply_plan_run_id_invalid');
  const text = validText(params.text, 'chat_reply_text_invalid');
  const inTransaction = async (tx: Db): Promise<TriggerRunReplyResult> => {
    const rows = await tx<TriggerRunRow[]>`
      SELECT tr.id::text,
             tr.args,
             tr.outcome,
             s.id::text AS "sourceId",
             s.owner_user_id::text AS "ownerUserId"
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
        JOIN harness_shared.data_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE tr.workspace_id = ${workspaceId}
         AND tr.plan_run_ref = ${String(planRunId)}
       ORDER BY tr.completed_at DESC NULLS LAST, tr.id
       LIMIT 1
       FOR UPDATE OF tr`;
    const row = rows[0];
    if (!row) throw new Error(`chat_reply_trigger_run_not_found:${planRunId}`);
    const prior = object(object(row.outcome).chatThreadReply);
    const priorMessageTs = string(prior.messageTs);
    if (priorMessageTs) {
      return {
        posted: false,
        alreadyPosted: true,
        channelId: string(prior.channelId),
        threadId: string(prior.threadId),
        messageTs: priorMessageTs,
        provider: string(prior.provider),
      };
    }
    const payload = object(object(object(row.args).trigger).payload);
    const channelId = string(payload.channelId);
    const threadId = string(payload.threadId) || string(payload.id);
    if (!channelId || !threadId) throw new Error('chat_reply_trigger_coordinates_missing');
    const target = await resolveCapabilitySource(
      tx,
      {
        workspaceId,
        userId: row.ownerUserId,
        datatype: CHAT_DATATYPE,
        capabilities: [CHAT_REPLY],
        sourceId: row.sourceId,
      },
      deps,
    );
    const posted = await postReply(tx, target, { channelId, threadId }, text, deps);
    const outcome = {
      ...object(row.outcome),
      chatThreadReply: { ...posted, postedAt: (deps.now ?? (() => new Date()))().toISOString() },
    };
    await tx`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify(outcome)}::text::jsonb, updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    return { posted: true, alreadyPosted: false, ...posted };
  };
  // Direct callers get an atomic row-lock/post/outcome transaction. Agent-tool
  // dispatch already supplies a TransactionSql (which deliberately has no
  // nested `.begin()`), so reuse that outer transaction instead.
  return 'begin' in sql ? (sql as postgres.Sql).begin(inTransaction) as Promise<TriggerRunReplyResult> : inTransaction(sql);
}

/**
 * `chat:post` — create-shaped: the caller names the destination channel, so
 * D-020 rail 2 applies. A channel id quoted inside an inbound message body is
 * refused for the same reason an injected email address is.
 */
export async function postToChatChannel(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    channelId: string;
    threadId?: string | null;
    text: string;
    provenance: AddresseeProvenance;
    /** Post as this connected chat source; required when several are connected. */
    sourceId?: string | null;
    /** See `replyToCanonicalChat`. */
    agentOwnerId: string | null;
  },
  deps: ChatDeps = {},
): Promise<ChatReplyResult> {
  const text = validText(params.text, 'chat_post_text_invalid');
  const channelId = string(params.channelId);
  if (!channelId) throw new Error('chat_post_channel_required');
  const threadId = string(params.threadId ?? '');
  if (!threadId) throw new Error('chat_post_thread_required');

  await assertTrustedAddressee(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: channelId,
    provenance: params.provenance,
  });
  const target = await resolveCapabilitySource(
    sql,
    {
      workspaceId: params.workspaceId,
      userId: params.userId,
      datatype: CHAT_DATATYPE,
      capabilities: [CHAT_REPLY],
      sourceId: params.sourceId ?? null,
    },
    deps,
  );
  await assertDisclosurePermits(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    agentOwnerId: params.agentOwnerId,
    recipients: null,
    sink: chatDisclosureSink(target, channelId),
  });
  return postReply(sql, target, { channelId, threadId }, text, deps);
}
