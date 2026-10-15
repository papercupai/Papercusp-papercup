/**
 * Chat retrieval units (plan enterprise-data-sources-2026-10-01 P-015; schema:
 * migration 1320).
 *
 * Raw chat messages are stored one row per provider message (`chat_messages`). The
 * unit that is INDEXED is a rollup of them (`chat_retrieval_units`):
 *   - thread — every live message sharing a thread_key;
 *   - window — non-thread channel messages split wherever two consecutive messages
 *              are more than `gapMinutes` apart. A window never crosses a UTC day,
 *              so a change only ever re-renders the windows of its own day.
 *
 * Writes never render directly. They enqueue the affected bucket (the thread, or the
 * channel-day) in `chat_rollup_queue`, and `rollupChatUnits` re-renders each queued
 * bucket from the LIVE messages. So an edit re-renders its unit, and a delete
 * (`tombstoneChatMessage`) removes the text from the unit on the next rollup.
 * A change to a source's routing (scope, scope_ref, owner, provider account,
 * datatype mapping, destination or permission policy) re-queues every bucket of that
 * source in the database itself (trigger `data_sources_requeue_chat_buckets`,
 * migration 1326), so the next rollup moves existing units without a new message.
 *
 * Rendered units go to the documents corpus (D-005) only when destination_policy routes
 * the source's chat-message datatype to `document`. Where they land follows the
 * source's scope (see corpusRouteFor):
 *   - organization (permission_mapping.mode = source-acl): the unit's permission list
 *     is the channel's container list (source = connector kind, source_ref =
 *     containerPermissionRef(source id, channel id)), the list the connector's membership
 *     snapshot fills. A list that does not exist yet is created EMPTY, so nobody can read
 *     the unit until the connector reports the channel's members (fail closed).
 *
 * Writer and driver (plan papercusp-enterprise-readiness-roadmap-2026-10-09 D-016): the
 * connector document sink stores every `chat-message` record through upsertChatMessages
 * (chatMessageInputFromRecord), and the connector-sync routine runs runChatRollupPass each
 * tick: retention, the cut-over of legacy per-message corpus rows, then the rollup.
 *   - personal (mode = owner): the owner's Personal Vault, through the vault writer, so
 *     vault semantics apply (deny-by-default grants, disclosure ledger, the disabled
 *     switch). The key is account-prefixed like every vault row.
 *   - pot: a scope='pot' row for the source's scope_ref; read only by that pot's agents.
 * Any other configuration still computes units but writes no corpus row, and counts
 * the reason in ChatRollupResult.corpusSkipped.
 *
 * Retention (`retention_policy.maxAgeDays`) and legal holds: `purgeExpiredChatMessages`
 * deletes expired messages and erases tombstoned bodies, skipping anything under an
 * active hold. The database enforces holds independently (trigger
 * chat_messages_enforce_legal_hold), so no path — including deleting the data source —
 * can destroy held content. `purgeExpiredDocuments` applies the same policy to the source's
 * other documents (P-017c), skipping documents under a hold (migration 1502's
 * document_under_hold, also enforced by trigger documents_enforce_legal_hold).
 *
 * Run each call inside the caller's transaction when its writes must commit together.
 *
 * A bucket that fails to render is rolled back on its own (a savepoint inside the caller's
 * transaction, else a transaction of its own) and re-queued after a retry delay, so one
 * always-failing bucket cannot stop the rest of the queue (WI-6554700010011913). Failures are
 * returned in ChatRollupResult.failures for the caller to report.
 *
 * The retry delay doubles with each consecutive failure up to a cap, and a bucket that fails
 * DEFAULT_ROLLUP_DEAD_LETTER_ATTEMPTS times in a row is dead-lettered: it stays in the queue with
 * its last error but is no longer dequeued, so a permanent failure stops retrying instead of being
 * reported every few minutes forever (WI-6554700010012111). A new message in the bucket, or a
 * routing change to its data source (trigger data_sources_requeue_chat_buckets), revives it. A new
 * message does not reset a bucket that is still backing off, so a busy channel still reaches the cap.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  dedupeKeyFor,
  isPersonalVaultEnabled,
  normalizePersonalSource,
  upsertPersonalDocuments,
} from '../personal-vault/store';
import type { PersonalDocumentInput } from '../personal-vault/types';
import { storedDocumentContent, upsertOrganizationDocuments, type OrganizationDocumentInput } from './documents-corpus';

export const DEFAULT_WINDOW_GAP_MINUTES = 30;
export const DEFAULT_CHAT_MESSAGE_DATATYPE = 'chat-message';
export const CHAT_THREAD_DOCUMENT_KIND = 'chat-thread';
export const CHAT_WINDOW_DOCUMENT_KIND = 'chat-window';
/**
 * Document kinds rendered from chat_messages. Their content is held in chat_messages, so migration
 * 1502 `document_is_chat_derived` exempts exactly these kinds from document legal holds (pinned by
 * organization-data-receipts.integration.test.ts).
 */
export const CHAT_DERIVED_DOCUMENT_KINDS = [
  DEFAULT_CHAT_MESSAGE_DATATYPE,
  CHAT_THREAD_DOCUMENT_KIND,
  CHAT_WINDOW_DOCUMENT_KIND,
] as const;
const DEFAULT_ROLLUP_BATCH = 200;
/** How long a bucket waits after its first failed render; the delay doubles with each further failure. */
export const DEFAULT_ROLLUP_RETRY_DELAY_SECONDS = 300;
/** The longest a failed bucket waits between renders. */
export const DEFAULT_ROLLUP_MAX_RETRY_DELAY_SECONDS = 6 * 3600;
/** Consecutive failed renders after which a bucket is dead-lettered (kept, but no longer dequeued). */
export const DEFAULT_ROLLUP_DEAD_LETTER_ATTEMPTS = 8;

/**
 * Seconds a bucket waits after its `attempts`-th consecutive failure: `baseSeconds` doubled per
 * earlier failure, capped at `maxSeconds` (never below `baseSeconds`).
 */
export function rollupRetryDelaySeconds(attempts: number, baseSeconds: number, maxSeconds: number): number {
  const base = Math.max(0, baseSeconds);
  const exponent = Math.min(Math.max(0, Math.floor(attempts) - 1), 30);
  return Math.min(Math.max(base, maxSeconds), base * 2 ** exponent);
}
/** Failures listed in a result; `failed` still counts every one. */
const MAX_REPORTED_ROLLUP_FAILURES = 20;

export type ChatUnitKind = 'thread' | 'window';
type BucketKind = 'thread' | 'day';

export interface ChatMessageInput {
  channelId: string;
  providerMessageId: string;
  /** Thread the message belongs to (the root included once it has replies); null = channel message. */
  threadKey?: string | null;
  authorRef?: string | null;
  authorLabel?: string | null;
  body: string;
  postedAt: string | Date;
  editedAt?: string | Date | null;
  raw?: Record<string, unknown> | null;
}

export interface WindowableMessage {
  postedAt: Date;
}

function nonEmpty(value: string, code: string): string {
  const out = value.trim();
  if (!out) throw new Error(code);
  return out;
}

function toDate(value: string | Date, code: string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(code);
  return d;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bucketFor(threadKey: string | null, postedAt: Date): { kind: BucketKind; key: string } {
  return threadKey ? { kind: 'thread', key: threadKey } : { kind: 'day', key: utcDay(postedAt) };
}

/**
 * Split time-ordered messages into windows: a new window starts when the gap to the
 * previous message exceeds `gapMs` or the UTC day changes.
 */
export function splitIntoWindows<T extends WindowableMessage>(messages: readonly T[], gapMs: number): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  for (const message of messages) {
    const prev = current[current.length - 1];
    if (prev && (message.postedAt.getTime() - prev.postedAt.getTime() > gapMs
      || utcDay(message.postedAt) !== utcDay(prev.postedAt))) {
      windows.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) windows.push(current);
  return windows;
}

async function enqueue(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  channelId: string,
  bucket: { kind: BucketKind; key: string },
): Promise<void> {
  // New input revives a dead-lettered bucket (failure state cleared, due now). A bucket still backing
  // off keeps its schedule, so a channel that keeps receiving messages still reaches the cap.
  await sql`
    INSERT INTO harness_shared.chat_rollup_queue AS q (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key)
    VALUES (${workspaceId}, ${dataSourceId}::uuid, ${channelId}, ${bucket.kind}, ${bucket.key})
    ON CONFLICT (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key) DO UPDATE
       SET attempts = 0, last_error = NULL, first_failed_at = NULL, dead_lettered_at = NULL, queued_at = now()
     WHERE q.dead_lettered_at IS NOT NULL`;
}

/**
 * Insert or edit raw messages. A changed message re-queues its bucket (and its old
 * bucket, when an edit moved it into or out of a thread). A tombstoned message is
 * never revived by a late upsert.
 */
export async function upsertChatMessages(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  messages: readonly ChatMessageInput[],
): Promise<{ written: number; unchanged: number }> {
  let written = 0;
  for (const msg of messages) {
    const channelId = nonEmpty(msg.channelId, 'invalid_chat_channel_id');
    const providerMessageId = nonEmpty(msg.providerMessageId, 'invalid_chat_provider_message_id');
    const threadKey = msg.threadKey?.trim() || null;
    const postedAt = toDate(msg.postedAt, 'invalid_chat_posted_at');
    const editedAt = msg.editedAt ? toDate(msg.editedAt, 'invalid_chat_edited_at') : null;
    const rows = await sql<Array<{ prev_thread_key: string | null; prev_posted_at: Date | null; existed: boolean }>>`
      WITH prev AS (
        SELECT thread_key, posted_at
          FROM harness_shared.chat_messages
         WHERE workspace_id = ${workspaceId} AND data_source_id = ${dataSourceId}::uuid
           AND channel_id = ${channelId} AND provider_message_id = ${providerMessageId}
      ), up AS (
        INSERT INTO harness_shared.chat_messages AS m
          (workspace_id, data_source_id, channel_id, provider_message_id, thread_key,
           author_ref, author_label, body, posted_at, edited_at, raw)
        VALUES (${workspaceId}, ${dataSourceId}::uuid, ${channelId}, ${providerMessageId}, ${threadKey},
                ${msg.authorRef ?? null}, ${msg.authorLabel ?? null}, ${msg.body}, ${postedAt}, ${editedAt},
                ${msg.raw ? sql.json(msg.raw as never) : null})
        ON CONFLICT (workspace_id, data_source_id, channel_id, provider_message_id)
        DO UPDATE SET thread_key = EXCLUDED.thread_key,
                      author_ref = EXCLUDED.author_ref,
                      author_label = EXCLUDED.author_label,
                      body = EXCLUDED.body,
                      posted_at = EXCLUDED.posted_at,
                      edited_at = EXCLUDED.edited_at,
                      raw = coalesce(EXCLUDED.raw, m.raw),
                      updated_at = now()
         WHERE m.deleted_at IS NULL
           AND (m.body IS DISTINCT FROM EXCLUDED.body
             OR m.thread_key IS DISTINCT FROM EXCLUDED.thread_key
             OR m.posted_at IS DISTINCT FROM EXCLUDED.posted_at
             OR m.author_ref IS DISTINCT FROM EXCLUDED.author_ref
             OR m.author_label IS DISTINCT FROM EXCLUDED.author_label)
        RETURNING 1
      )
      SELECT (SELECT thread_key FROM prev) AS prev_thread_key,
             (SELECT posted_at FROM prev) AS prev_posted_at,
             EXISTS (SELECT 1 FROM prev) AS existed
        FROM up`;
    const row = rows[0];
    if (!row) continue;
    written += 1;
    const next = bucketFor(threadKey, postedAt);
    await enqueue(sql, workspaceId, dataSourceId, channelId, next);
    if (row.existed && row.prev_posted_at) {
      const prev = bucketFor(row.prev_thread_key, new Date(row.prev_posted_at));
      if (prev.kind !== next.kind || prev.key !== next.key) {
        await enqueue(sql, workspaceId, dataSourceId, channelId, prev);
      }
    }
  }
  return { written, unchanged: messages.length - written };
}

/**
 * Record a provider delete. The body and raw payload are erased at once unless a
 * legal hold covers the message, in which case they are kept but never rendered.
 *
 * A delete for a message not stored yet (a live delete that beat the backfill which
 * would have stored it) leaves a body-less tombstone row, so the later copy cannot
 * insert the deleted text: `upsertChatMessages` never revives a tombstone. Such a row
 * takes `postedAt` (default: the delete time) and `threadKey` only to satisfy the
 * table; it is never live, so it joins no unit and queues no rollup. One statement
 * does both, so a concurrent first insert of the message cannot slip between them.
 */
export async function tombstoneChatMessage(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  input: {
    channelId: string;
    providerMessageId: string;
    deletedAt?: string | Date;
    postedAt?: string | Date;
    threadKey?: string | null;
  },
): Promise<{ tombstoned: boolean; held: boolean }> {
  const channelId = nonEmpty(input.channelId, 'invalid_chat_channel_id');
  const providerMessageId = nonEmpty(input.providerMessageId, 'invalid_chat_provider_message_id');
  const deletedAt = input.deletedAt ? toDate(input.deletedAt, 'invalid_chat_deleted_at') : new Date();
  const postedAt = input.postedAt ? toDate(input.postedAt, 'invalid_chat_posted_at') : deletedAt;
  const threadKey = input.threadKey?.trim() || null;
  const rows = await sql<Array<{ thread_key: string | null; posted_at: Date; held: boolean; inserted: boolean }>>`
    INSERT INTO harness_shared.chat_messages AS m
      (workspace_id, data_source_id, channel_id, provider_message_id, thread_key, body, posted_at, deleted_at)
    VALUES (${workspaceId}, ${dataSourceId}::uuid, ${channelId}, ${providerMessageId}, ${threadKey}, NULL, ${postedAt}, ${deletedAt})
    ON CONFLICT (workspace_id, data_source_id, channel_id, provider_message_id)
    DO UPDATE SET deleted_at = EXCLUDED.deleted_at,
                  body = CASE WHEN harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
                              THEN m.body ELSE NULL END,
                  raw = CASE WHEN harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
                             THEN m.raw ELSE NULL END,
                  held_revisions = CASE WHEN harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
                                        THEN m.held_revisions ELSE '[]'::jsonb END,
                  updated_at = now()
     WHERE m.deleted_at IS NULL
    RETURNING m.thread_key, m.posted_at, (m.xmax = 0) AS inserted,
              harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id) AS held`;
  const row = rows[0];
  if (!row) return { tombstoned: false, held: false };
  // A tombstone recorded ahead of its message holds no text, so nothing is kept and no unit changes.
  if (row.inserted) return { tombstoned: true, held: false };
  await enqueue(sql, workspaceId, dataSourceId, channelId, bucketFor(row.thread_key, new Date(row.posted_at)));
  return { tombstoned: true, held: row.held };
}

/**
 * Tombstone every live stored message in a window the provider read in full and did not find
 * (WI-6554700010012278). A provider that reads a channel's complete live set for a window names
 * it as coverage; a message stored in that window but absent from the live set was deleted while
 * no live delete reached us (the daemon was offline). Each one goes through
 * `tombstoneChatMessage`, so a legal hold still keeps its text and its unit is re-queued.
 *
 * Without `threadKey` the window is the channel's messages outside any thread; with it, the whole
 * thread including its root. `from` and `to` bound `posted_at` inclusively; an absent bound is open.
 * Replaying the same window is a no-op: a tombstone is never live again.
 */
export async function reconcileChatMessageCoverage(
  sql: Sql,
  workspaceId: string,
  dataSourceId: string,
  input: {
    channelId: string;
    threadKey?: string | null;
    from?: string | Date | null;
    to?: string | Date | null;
    liveProviderMessageIds: readonly string[];
  },
): Promise<{ tombstoned: number }> {
  const channelId = nonEmpty(input.channelId, 'invalid_chat_channel_id');
  const threadKey = input.threadKey?.trim() || null;
  const from = input.from ? toDate(input.from, 'invalid_chat_coverage_from') : null;
  const to = input.to ? toDate(input.to, 'invalid_chat_coverage_to') : null;
  const live = [...new Set(input.liveProviderMessageIds)];
  const missing = await sql<Array<{ provider_message_id: string; thread_key: string | null; posted_at: Date }>>`
    SELECT provider_message_id, thread_key, posted_at
      FROM harness_shared.chat_messages
     WHERE workspace_id = ${workspaceId}
       AND data_source_id = ${dataSourceId}::uuid
       AND channel_id = ${channelId}
       AND deleted_at IS NULL
       AND ${threadKey === null ? sql`thread_key IS NULL` : sql`thread_key = ${threadKey}`}
       AND (${from}::timestamptz IS NULL OR posted_at >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR posted_at <= ${to}::timestamptz)
       AND NOT (provider_message_id = ANY(${sql.array(live)}::text[]))`;
  let tombstoned = 0;
  for (const row of missing) {
    const result = await tombstoneChatMessage(sql, workspaceId, dataSourceId, {
      channelId,
      providerMessageId: row.provider_message_id,
      postedAt: row.posted_at,
      threadKey: row.thread_key,
    });
    if (result.tombstoned) tombstoned += 1;
  }
  return { tombstoned };
}

interface SourceRow {
  id: string;
  kind: string;
  scope: string;
  scope_ref?: string | null;
  owner_user_id?: string | null;
  provider_account_id?: string | null;
  datatype_mappings: Record<string, unknown>;
  destination_policy: Record<string, unknown>;
  permission_mapping: Record<string, unknown>;
}

export type CorpusSkipReason =
  | 'destination_not_document'
  | 'permission_mapping_mismatch'
  | 'personal_owner_missing'
  | 'personal_account_missing'
  | 'personal_vault_disabled'
  | 'pot_ref_missing'
  | 'scope_unknown';

/**
 * Where a data source's units land in the documents corpus (D-005):
 *   - organization: needs permission_mapping.mode = source-acl; read through the channel's permission list.
 *   - personal: needs mode = owner; written into the owner's Personal Vault with the vault's own
 *     semantics (deny-by-default grants, disclosure ledger). Needs the source's provider account,
 *     the same rule the live vault sink applies.
 *   - pot: pot_slug = the source's scope_ref. A source-acl source is refused because a pot row
 *     carries no permission list, so it would widen access past the provider ACL.
 */
export type CorpusRoute =
  | { write: true; scope: 'organization'; source: string }
  | { write: true; scope: 'personal'; source: string; userId: string; providerAccountId: string }
  | { write: true; scope: 'pot'; source: string; potSlug: string }
  | { write: false; reason: CorpusSkipReason };

type RouteInput = Pick<SourceRow, 'kind' | 'scope' | 'datatype_mappings' | 'destination_policy' | 'permission_mapping'>
  & Partial<Pick<SourceRow, 'scope_ref' | 'owner_user_id' | 'provider_account_id'>>;

/** Which of a source's provider objects is being routed. The key is the datatype id, the same
 *  key the connector's document sink routes by (datatype-destination-sink.ts), so a chat source
 *  routes `chat-message`; other connectors name their own datatype, e.g. `ticket-comment`. */
export interface CorpusRouteObject {
  mappingKey: string;
  defaultDatatype: string;
}

const CHAT_MESSAGE_OBJECT: CorpusRouteObject = {
  mappingKey: DEFAULT_CHAT_MESSAGE_DATATYPE,
  defaultDatatype: DEFAULT_CHAT_MESSAGE_DATATYPE,
};

/**
 * The permission-list source_ref of one ACL container of a source (D-026): a Slack channel, a
 * GitHub repository. The membership snapshot fills exactly these lists
 * (applyDataSourceMembership), so every organization row that names a container binds here.
 */
export function containerPermissionRef(sourceId: string, ref: string): string {
  return `${sourceId}#${ref}`;
}

/** Whether, and where, this data source's units go to the documents corpus. */
export function corpusRouteFor(source: RouteInput, object: CorpusRouteObject = CHAT_MESSAGE_OBJECT): CorpusRoute {
  const mapped = source.datatype_mappings?.[object.mappingKey];
  const datatype = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : object.defaultDatatype;
  const natures = source.destination_policy?.[datatype];
  if (!Array.isArray(natures) || !natures.includes('document')) return { write: false, reason: 'destination_not_document' };
  const corpusSource = normalizePersonalSource(source.kind);
  const mode = source.permission_mapping?.mode;
  switch (source.scope) {
    case 'organization':
      if (mode !== 'source-acl') return { write: false, reason: 'permission_mapping_mismatch' };
      return { write: true, scope: 'organization', source: corpusSource };
    case 'personal': {
      if (mode !== 'owner') return { write: false, reason: 'permission_mapping_mismatch' };
      const userId = source.owner_user_id?.trim();
      if (!userId) return { write: false, reason: 'personal_owner_missing' };
      const providerAccountId = source.provider_account_id?.trim();
      if (!providerAccountId) return { write: false, reason: 'personal_account_missing' };
      return { write: true, scope: 'personal', source: corpusSource, userId, providerAccountId };
    }
    case 'pot': {
      if (mode === 'source-acl') return { write: false, reason: 'permission_mapping_mismatch' };
      const potSlug = source.scope_ref?.trim();
      if (!potSlug) return { write: false, reason: 'pot_ref_missing' };
      return { write: true, scope: 'pot', source: corpusSource, potSlug };
    }
    default:
      return { write: false, reason: 'scope_unknown' };
  }
}

/** The dedupe key the corpus row is stored under (the vault prefixes personal keys by account). */
export function storedDedupeKey(route: Extract<CorpusRoute, { write: true }>, unitKey: string, kind: string): string {
  if (route.scope !== 'personal') return unitKey;
  return dedupeKeyFor({ source: route.source, kind, dedupeKey: unitKey, providerAccountId: route.providerAccountId });
}

/** A pot row is sealed under the organization key exactly like an organization row (migration 1503). */
async function upsertPotDocument(sql: Sql, workspaceId: string, potSlug: string, doc: OrganizationDocumentInput): Promise<void> {
  const [c] = await storedDocumentContent(sql, workspaceId, [doc]);
  await sql`
    INSERT INTO harness_shared.documents
      (workspace_id, user_id, scope, pot_slug, source, kind, external_id,
       occurred_at, participants, title, text, metadata, dedupe_key, sealed_content, blind_terms)
    VALUES (${workspaceId}, NULL, 'pot', ${potSlug}, ${doc.source}, ${doc.kind},
            ${doc.externalId ?? null}, ${doc.occurredAt ?? null}, ${doc.participants ?? []}::text[],
            ${c!.title}, ${c!.text}, ${sql.json((doc.metadata ?? {}) as never)}, ${doc.dedupeKey},
            ${c!.sealedContent}, ${c!.blindTerms}::text[])
    ON CONFLICT (workspace_id, pot_slug, source, dedupe_key) WHERE scope = 'pot'
    DO UPDATE SET kind = EXCLUDED.kind,
                  external_id = EXCLUDED.external_id,
                  occurred_at = EXCLUDED.occurred_at,
                  participants = EXCLUDED.participants,
                  title = EXCLUDED.title,
                  text = EXCLUDED.text,
                  sealed_content = EXCLUDED.sealed_content,
                  blind_terms = EXCLUDED.blind_terms,
                  metadata = EXCLUDED.metadata,
                  updated_at = now()`;
}

/** Write one unit's corpus row to the destination its route names. An organization route
 *  needs the permission list the row is read through (see ensurePermissionList). */
export async function writeCorpusDocument(
  sql: Sql,
  workspaceId: string,
  route: Extract<CorpusRoute, { write: true }>,
  dataSourceId: string,
  permissionListId: string | null,
  doc: OrganizationDocumentInput,
): Promise<void> {
  if (route.scope === 'organization') {
    await upsertOrganizationDocuments(sql, workspaceId, permissionListId!, [doc]);
  } else if (route.scope === 'pot') {
    await upsertPotDocument(sql, workspaceId, route.potSlug, doc);
  } else {
    const personal: PersonalDocumentInput = {
      source: doc.source,
      sourceId: dataSourceId,
      providerAccountId: route.providerAccountId,
      kind: doc.kind,
      externalId: doc.externalId ?? null,
      occurredAt: doc.occurredAt ?? null,
      participants: doc.participants,
      title: doc.title,
      text: doc.text,
      metadata: doc.metadata,
      dedupeKey: doc.dedupeKey,
    };
    await upsertPersonalDocuments(sql, workspaceId, route.userId, [personal]);
  }
}

export function chatUnitDedupeKey(dataSourceId: string, channelId: string, unitKind: ChatUnitKind, unitKey: string): string {
  return `chat:${dataSourceId}:${channelId}:${unitKind}:${unitKey}`;
}

interface LiveMessage {
  providerMessageId: string;
  authorRef: string | null;
  authorLabel: string | null;
  body: string;
  postedAt: Date;
}

/** The text a unit is indexed by: one `author: body` line per live message. */
export function renderChatUnit(messages: readonly LiveMessage[]): string {
  return messages
    .map((m) => `${m.authorLabel?.trim() || m.authorRef?.trim() || 'unknown'}: ${m.body}`)
    .join('\n');
}

/** The channel's permission list, created empty (nobody can read) when missing. */
/** The permission list for one provider ACL container (a Slack channel, a GitHub repository). */
export async function ensurePermissionList(sql: Sql, workspaceId: string, source: string, sourceRef: string): Promise<{ id: string; title: string }> {
  await sql`
    INSERT INTO harness_shared.document_permission_lists (workspace_id, source, source_ref, title)
    VALUES (${workspaceId}, ${source}, ${sourceRef}, '')
    ON CONFLICT (workspace_id, source, source_ref) DO NOTHING`;
  const rows = await sql<Array<{ id: string; title: string }>>`
    SELECT id, title FROM harness_shared.document_permission_lists
     WHERE workspace_id = ${workspaceId} AND source = ${source} AND source_ref = ${sourceRef}`;
  return rows[0]!;
}

async function deleteUnit(
  sql: Sql,
  workspaceId: string,
  unit: { id: string; document_dedupe_key: string | null },
  corpusSource: string,
): Promise<void> {
  // Any scope: the key embeds the data-source id, so only this unit ever wrote it.
  if (unit.document_dedupe_key) {
    await sql`
      DELETE FROM harness_shared.documents
       WHERE workspace_id = ${workspaceId}
         AND source = ${corpusSource} AND dedupe_key = ${unit.document_dedupe_key}`;
  }
  await sql`DELETE FROM harness_shared.chat_retrieval_units WHERE workspace_id = ${workspaceId} AND id = ${unit.id}::uuid`;
}

export interface ChatRollupResult {
  buckets: number;
  unitsWritten: number;
  unitsUnchanged: number;
  unitsRemoved: number;
  documentsWritten: number;
  /** Buckets whose source routes no corpus row, by reason. */
  corpusSkipped: Partial<Record<CorpusSkipReason, number>>;
  /** Buckets whose render threw. Each was rolled back on its own and re-queued after its retry delay. */
  failed: number;
  /** Of `failed`, the buckets that reached the attempt cap and were dead-lettered instead of retried. */
  deadLettered: number;
  /** The first failures (at most MAX_REPORTED_ROLLUP_FAILURES), for the caller to report. */
  failures: ChatRollupFailure[];
}

export interface ChatRollupFailure {
  dataSourceId: string;
  channelId: string;
  bucketKind: 'thread' | 'day';
  bucketKey: string;
  error: string;
  /** Consecutive failed renders of this bucket, this one included. */
  attempts: number;
  /** True when this failure reached the cap: the bucket is no longer retried until it is revived. */
  deadLettered: boolean;
}

interface QueuedBucket {
  data_source_id: string;
  channel_id: string;
  bucket_kind: BucketKind;
  bucket_key: string;
  /** Consecutive failed renders before this one. */
  attempts: number;
  first_failed_at: Date | null;
}

type ResolvedSource = { source: SourceRow; route: CorpusRoute };
type BucketCounts = Pick<ChatRollupResult, 'unitsWritten' | 'unitsUnchanged' | 'unitsRemoved' | 'documentsWritten'> & {
  skipReason: CorpusSkipReason | null;
};
type ScopeFn = (fn: (inner: unknown) => Promise<unknown>) => Promise<unknown>;

/**
 * Run `fn` so that its failure undoes only its own writes: a savepoint inside the caller's
 * transaction, else a transaction of its own. A handle with neither runs `fn` directly.
 */
function isolated<T>(sql: Sql, fn: (inner: Sql) => Promise<T>): Promise<T> {
  const handle = sql as unknown as { savepoint?: ScopeFn; begin?: ScopeFn };
  const scope = typeof handle.savepoint === 'function' ? handle.savepoint : handle.begin;
  if (typeof scope !== 'function') return fn(sql);
  return scope.call(handle, (inner) => fn(inner as Sql)) as Promise<T>;
}

function rollupErrorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Re-render up to `limit` due buckets. Each bucket renders in its own savepoint (or
 * transaction): a bucket that throws is rolled back alone and re-queued after its retry delay
 * (`retryDelaySeconds` doubled per earlier consecutive failure, capped at `maxRetryDelaySeconds`),
 * and the rest of the batch still commits. The `deadLetterAttempts`-th consecutive failure
 * dead-letters the bucket instead of re-queueing it. Run inside a transaction so a failure of the
 * dequeue itself, or a lost connection, re-queues the whole batch.
 */
export async function rollupChatUnits(
  sql: Sql,
  workspaceId: string,
  opts: {
    dataSourceId?: string; limit?: number; gapMinutes?: number;
    retryDelaySeconds?: number; maxRetryDelaySeconds?: number; deadLetterAttempts?: number;
  } = {},
): Promise<ChatRollupResult> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? DEFAULT_ROLLUP_BATCH));
  const gapMs = Math.max(1, opts.gapMinutes ?? DEFAULT_WINDOW_GAP_MINUTES) * 60_000;
  const retryDelaySeconds = Math.max(0, opts.retryDelaySeconds ?? DEFAULT_ROLLUP_RETRY_DELAY_SECONDS);
  const maxRetryDelaySeconds = Math.max(0, opts.maxRetryDelaySeconds ?? DEFAULT_ROLLUP_MAX_RETRY_DELAY_SECONDS);
  const deadLetterAttempts = Math.max(1, Math.floor(opts.deadLetterAttempts ?? DEFAULT_ROLLUP_DEAD_LETTER_ATTEMPTS));
  const sourceFilter = opts.dataSourceId ? sql`AND data_source_id = ${opts.dataSourceId}::uuid` : sql``;
  // Only due, live buckets: a failed bucket waits out its retry delay (queued_at in the future), and
  // a dead-lettered one waits to be revived.
  const buckets = await sql<QueuedBucket[]>`
    DELETE FROM harness_shared.chat_rollup_queue q
     WHERE (q.workspace_id, q.data_source_id, q.channel_id, q.bucket_kind, q.bucket_key) IN (
       SELECT workspace_id, data_source_id, channel_id, bucket_kind, bucket_key
         FROM harness_shared.chat_rollup_queue
        WHERE workspace_id = ${workspaceId} ${sourceFilter}
          AND queued_at <= now()
          AND dead_lettered_at IS NULL
        ORDER BY queued_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING q.data_source_id, q.channel_id, q.bucket_kind, q.bucket_key, q.attempts, q.first_failed_at`;

  const result: ChatRollupResult = {
    buckets: buckets.length, unitsWritten: 0, unitsUnchanged: 0, unitsRemoved: 0, documentsWritten: 0, corpusSkipped: {},
    failed: 0, deadLettered: 0, failures: [],
  };
  const sources = new Map<string, ResolvedSource>();
  for (const bucket of buckets) {
    let counts: BucketCounts;
    try {
      counts = await isolated(sql, (inner) => rollupBucket(inner, workspaceId, bucket, sources, gapMs));
    } catch (cause) {
      const error = rollupErrorText(cause);
      const attempts = (bucket.attempts ?? 0) + 1;
      const deadLettered = attempts >= deadLetterAttempts;
      const delaySeconds = rollupRetryDelaySeconds(attempts, retryDelaySeconds, maxRetryDelaySeconds);
      result.failed += 1;
      if (deadLettered) result.deadLettered += 1;
      if (result.failures.length < MAX_REPORTED_ROLLUP_FAILURES) {
        result.failures.push({
          dataSourceId: bucket.data_source_id,
          channelId: bucket.channel_id,
          bucketKind: bucket.bucket_kind,
          bucketKey: bucket.bucket_key,
          error,
          attempts,
          deadLettered,
        });
      }
      // A source deleted meanwhile has nothing left to render, so only a live source re-queues. A row
      // queued meanwhile (possible only outside a transaction: new input or a routing change) is newer
      // than this failure and keeps its own state.
      await sql`
        INSERT INTO harness_shared.chat_rollup_queue
          (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key, queued_at,
           attempts, last_error, first_failed_at, dead_lettered_at)
        SELECT ${workspaceId}, ${bucket.data_source_id}::uuid, ${bucket.channel_id}, ${bucket.bucket_kind},
               ${bucket.bucket_key}, now() + make_interval(secs => ${delaySeconds}::double precision),
               ${attempts}::int, ${error}::text, COALESCE(${bucket.first_failed_at}::timestamptz, now()),
               CASE WHEN ${deadLettered}::boolean THEN now() END
         WHERE EXISTS (SELECT 1 FROM harness_shared.data_sources
                        WHERE workspace_id = ${workspaceId} AND id = ${bucket.data_source_id}::uuid)
        ON CONFLICT DO NOTHING`;
      continue;
    }
    result.unitsWritten += counts.unitsWritten;
    result.unitsUnchanged += counts.unitsUnchanged;
    result.unitsRemoved += counts.unitsRemoved;
    result.documentsWritten += counts.documentsWritten;
    if (counts.skipReason) result.corpusSkipped[counts.skipReason] = (result.corpusSkipped[counts.skipReason] ?? 0) + 1;
  }
  return result;
}

/** Re-render one dequeued bucket from its live messages. Throws on any write failure. */
async function rollupBucket(
  sql: Sql,
  workspaceId: string,
  bucket: QueuedBucket,
  sources: Map<string, ResolvedSource>,
  gapMs: number,
): Promise<BucketCounts> {
  const result: BucketCounts = { unitsWritten: 0, unitsUnchanged: 0, unitsRemoved: 0, documentsWritten: 0, skipReason: null };
  {
    let resolved = sources.get(bucket.data_source_id);
    if (!resolved) {
      const rows = await sql<SourceRow[]>`
        SELECT id, kind, scope, scope_ref, owner_user_id::text AS owner_user_id, provider_account_id,
               datatype_mappings, destination_policy, permission_mapping
          FROM harness_shared.data_sources
         WHERE workspace_id = ${workspaceId} AND id = ${bucket.data_source_id}::uuid`;
      if (!rows[0]) return result;
      let route = corpusRouteFor(rows[0]);
      // A disabled vault takes no writes (upsertPersonalDocuments would throw and re-queue forever).
      if (route.write && route.scope === 'personal' && !(await isPersonalVaultEnabled(sql, workspaceId, route.userId))) {
        route = { write: false, reason: 'personal_vault_disabled' };
      }
      resolved = { source: rows[0], route };
      sources.set(bucket.data_source_id, resolved);
    }
    const { source, route } = resolved;
    const corpusSource = normalizePersonalSource(source.kind);
    if (!route.write) result.skipReason = route.reason;

    const unitKind: ChatUnitKind = bucket.bucket_kind === 'thread' ? 'thread' : 'window';
    const messageFilter = bucket.bucket_kind === 'thread'
      ? sql`AND thread_key = ${bucket.bucket_key}`
      : sql`AND thread_key IS NULL
            AND posted_at >= ${bucket.bucket_key}::date::timestamp AT TIME ZONE 'UTC'
            AND posted_at < (${bucket.bucket_key}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
    const live = (await sql<Array<{
      provider_message_id: string; author_ref: string | null; author_label: string | null; body: string; posted_at: Date;
    }>>`
      SELECT provider_message_id, author_ref, author_label, body, posted_at
        FROM harness_shared.chat_messages
       WHERE workspace_id = ${workspaceId} AND data_source_id = ${bucket.data_source_id}::uuid
         AND channel_id = ${bucket.channel_id} AND deleted_at IS NULL
         ${messageFilter}
       ORDER BY posted_at, provider_message_id`).map((r): LiveMessage => ({
      providerMessageId: r.provider_message_id,
      authorRef: r.author_ref,
      authorLabel: r.author_label,
      body: r.body,
      postedAt: new Date(r.posted_at),
    }));

    const groups = live.length === 0 ? [] : unitKind === 'thread' ? [live] : splitIntoWindows(live, gapMs);
    const computed = groups.map((messages) => ({
      unitKey: unitKind === 'thread' ? bucket.bucket_key : messages[0]!.providerMessageId,
      messages,
      text: renderChatUnit(messages),
    }));

    const existing = await sql<Array<{ id: string; unit_key: string; content_hash: string; document_dedupe_key: string | null }>>`
      SELECT id, unit_key, content_hash, document_dedupe_key
        FROM harness_shared.chat_retrieval_units
       WHERE workspace_id = ${workspaceId} AND data_source_id = ${bucket.data_source_id}::uuid
         AND channel_id = ${bucket.channel_id} AND unit_kind = ${unitKind} AND bucket_key = ${bucket.bucket_key}`;
    const keep = new Set(computed.map((u) => u.unitKey));
    for (const stale of existing.filter((u) => !keep.has(u.unit_key))) {
      await deleteUnit(sql, workspaceId, stale, corpusSource);
      result.unitsRemoved += 1;
    }

    // The channel's container list (D-026), the one the membership snapshot fills.
    const list = route.write && route.scope === 'organization'
      ? await ensurePermissionList(sql, workspaceId, route.source, containerPermissionRef(bucket.data_source_id, bucket.channel_id))
      : null;
    const docKind = unitKind === 'thread' ? CHAT_THREAD_DOCUMENT_KIND : CHAT_WINDOW_DOCUMENT_KIND;
    const target = route.write
      ? {
          scope: route.scope,
          userId: route.scope === 'personal' ? route.userId : null,
          potSlug: route.scope === 'pot' ? route.potSlug : null,
        }
      : null;
    for (const unit of computed) {
      const first = unit.messages[0]!;
      const last = unit.messages[unit.messages.length - 1]!;
      const unitDedupeKey = chatUnitDedupeKey(bucket.data_source_id, bucket.channel_id, unitKind, unit.unitKey);
      const dedupeKey = route.write ? storedDedupeKey(route, unitDedupeKey, docKind) : null;
      // The destination is part of the hash, so a scope or owner change forces a rewrite.
      const destination = target ? `${target.scope}:${target.userId ?? ''}:${target.potSlug ?? ''}` : '';
      const contentHash = createHash('sha256')
        .update(`${unit.text}\u0000${dedupeKey ?? ''}\u0000${list?.title ?? ''}\u0000${destination}`)
        .digest('hex');
      const prior = existing.find((u) => u.unit_key === unit.unitKey);
      if (prior && prior.content_hash === contentHash && prior.document_dedupe_key === dedupeKey) {
        result.unitsUnchanged += 1;
        continue;
      }
      // Drop the prior row unless it IS the row about to be upserted (same key, scope, owner, pot).
      if (prior?.document_dedupe_key) {
        await sql`
          DELETE FROM harness_shared.documents
           WHERE workspace_id = ${workspaceId}
             AND source = ${corpusSource} AND dedupe_key = ${prior.document_dedupe_key}
             AND (${dedupeKey}::text IS NULL OR NOT (
                   dedupe_key = ${dedupeKey}::text
               AND scope = ${target?.scope ?? ''}
               AND user_id IS NOT DISTINCT FROM ${target?.userId ?? null}::uuid
               AND pot_slug IS NOT DISTINCT FROM ${target?.potSlug ?? null}::text))`;
      }
      await sql`
        INSERT INTO harness_shared.chat_retrieval_units
          (workspace_id, data_source_id, channel_id, unit_kind, unit_key, bucket_key,
           first_posted_at, last_posted_at, message_count, content_hash, document_dedupe_key)
        VALUES (${workspaceId}, ${bucket.data_source_id}::uuid, ${bucket.channel_id}, ${unitKind}, ${unit.unitKey},
                ${bucket.bucket_key}, ${first.postedAt}, ${last.postedAt}, ${unit.messages.length}, ${contentHash}, ${dedupeKey})
        ON CONFLICT (workspace_id, data_source_id, channel_id, unit_kind, unit_key)
        DO UPDATE SET bucket_key = EXCLUDED.bucket_key,
                      first_posted_at = EXCLUDED.first_posted_at,
                      last_posted_at = EXCLUDED.last_posted_at,
                      message_count = EXCLUDED.message_count,
                      content_hash = EXCLUDED.content_hash,
                      document_dedupe_key = EXCLUDED.document_dedupe_key,
                      rolled_at = now()`;
      result.unitsWritten += 1;
      if (route.write) {
        await writeCorpusDocument(sql, workspaceId, route, bucket.data_source_id, list?.id ?? null, {
          source: route.source,
          kind: docKind,
          // The personal writer re-applies its account prefix, so pass the unprefixed key.
          dedupeKey: unitDedupeKey,
          externalId: unit.unitKey,
          occurredAt: last.postedAt.toISOString(),
          participants: [...new Set(unit.messages.map((m) => m.authorRef).filter((a): a is string => !!a))],
          title: list?.title || bucket.channel_id,
          text: unit.text,
          metadata: {
            dataSourceId: bucket.data_source_id,
            channelId: bucket.channel_id,
            unitKind,
            unitKey: unit.unitKey,
            messageCount: unit.messages.length,
            firstPostedAt: first.postedAt.toISOString(),
            lastPostedAt: last.postedAt.toISOString(),
            providerMessageIds: unit.messages.map((m) => m.providerMessageId),
          },
        });
        result.documentsWritten += 1;
      }
    }
  }
  return result;
}

/**
 * Apply retention and release erased content. Never touches a message under an
 * active legal hold:
 *   1. delete messages older than the source's retention_policy.maxAgeDays;
 *   2. erase the kept body/raw of tombstones whose hold has been released;
 *   3. drop superseded bodies kept for a released hold.
 * Deleted messages re-queue their buckets; run rollupChatUnits afterwards.
 */
export async function purgeExpiredChatMessages(
  sql: Sql,
  workspaceId: string,
  opts: { dataSourceId?: string; now?: Date } = {},
): Promise<{ expired: number; tombstonesErased: number; revisionsDropped: number }> {
  const now = opts.now ?? new Date();
  const sourceFilter = opts.dataSourceId ? sql`AND m.data_source_id = ${opts.dataSourceId}::uuid` : sql``;
  const expired = await sql<Array<{ data_source_id: string; channel_id: string; thread_key: string | null; posted_at: Date }>>`
    DELETE FROM harness_shared.chat_messages m
     USING harness_shared.data_sources s
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND s.workspace_id = m.workspace_id AND s.id = m.data_source_id
       AND jsonb_typeof(s.retention_policy -> 'maxAgeDays') = 'number'
       AND m.posted_at < ${now}::timestamptz - make_interval(days => (s.retention_policy ->> 'maxAgeDays')::int)
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING m.data_source_id, m.channel_id, m.thread_key, m.posted_at`;
  const queued = new Set<string>();
  for (const row of expired) {
    const bucket = bucketFor(row.thread_key, new Date(row.posted_at));
    const key = `${row.data_source_id}\u0000${row.channel_id}\u0000${bucket.kind}\u0000${bucket.key}`;
    if (queued.has(key)) continue;
    queued.add(key);
    await enqueue(sql, workspaceId, row.data_source_id, row.channel_id, bucket);
  }

  const erased = await sql`
    UPDATE harness_shared.chat_messages m
       SET body = NULL, raw = NULL, held_revisions = '[]'::jsonb, updated_at = now()
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND m.deleted_at IS NOT NULL
       AND (m.body IS NOT NULL OR m.raw IS NOT NULL OR m.held_revisions <> '[]'::jsonb)
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING 1`;
  const dropped = await sql`
    UPDATE harness_shared.chat_messages m
       SET held_revisions = '[]'::jsonb, updated_at = now()
     WHERE m.workspace_id = ${workspaceId} ${sourceFilter}
       AND m.deleted_at IS NULL AND m.held_revisions <> '[]'::jsonb
       AND NOT harness_shared.chat_message_under_hold(m.workspace_id, m.data_source_id, m.channel_id)
    RETURNING 1`;
  return { expired: expired.length, tombstonesErased: erased.length, revisionsDropped: dropped.length };
}

/**
 * Document retention (P-017c): the single writer that expires connector documents. Deletes the
 * documents of every source whose retention_policy.maxAgeDays is a number and that are older
 * than that window. A document's age is its source time (occurred_at) when the source gave one,
 * else the time it was imported (imported_at).
 *
 * Two kinds of document are never deleted here:
 *   - a document under an active legal hold. The hold test is migration 1502's
 *     harness_shared.document_under_hold (whole source, or the document's channelId /
 *     permission-list container), the same predicate the documents_enforce_legal_hold trigger
 *     enforces, so this purge never trips the trigger. Held documents are counted instead.
 *   - a chat-derived kind (harness_shared.document_is_chat_derived). Those rows are rendered
 *     from chat_messages: purgeExpiredChatMessages expires the messages and the rollup removes
 *     the rendered row.
 */
export async function purgeExpiredDocuments(
  sql: Sql,
  workspaceId: string,
  opts: { dataSourceId?: string; now?: Date } = {},
): Promise<{ documentsExpired: number; documentsHeldKept: number }> {
  const now = opts.now ?? new Date();
  const sourceFilter = opts.dataSourceId ? sql`AND d.source_id = ${opts.dataSourceId}::uuid` : sql``;
  const [row] = await sql<Array<{ purged: number; held_kept: number }>>`
    WITH expired AS (
      SELECT d.id,
             harness_shared.document_under_hold(
               d.workspace_id, d.source_id, d.kind, d.metadata, d.permission_list_id) AS held
        FROM harness_shared.documents d
        JOIN harness_shared.data_sources s ON s.workspace_id = d.workspace_id AND s.id = d.source_id
       WHERE d.workspace_id = ${workspaceId} ${sourceFilter}
         AND jsonb_typeof(s.retention_policy -> 'maxAgeDays') = 'number'
         AND NOT harness_shared.document_is_chat_derived(d.kind)
         AND COALESCE(d.occurred_at, d.imported_at)
             < ${now}::timestamptz - make_interval(days => (s.retention_policy ->> 'maxAgeDays')::int)
    ), purged AS (
      DELETE FROM harness_shared.documents d
       USING expired e
       WHERE d.id = e.id AND NOT e.held
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM purged)::int AS purged,
           (SELECT count(*) FROM expired WHERE held)::int AS held_kept`;
  return { documentsExpired: row?.purged ?? 0, documentsHeldKept: row?.held_kept ?? 0 };
}

/** The connector record fields a chat message is read from (CanonicalExternalEvent's shape). */
export interface ChatMessageRecord {
  externalId: string;
  occurredAt?: string | Date | null;
  payload: Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Map a provider-neutral `chat-message` connector record to a raw chat message. The provider
 * names the thread in `payload.threadKey` (null = a channel message); the host never reads a
 * provider's own extensions. The record's native id is the provider message id.
 */
export function chatMessageInputFromRecord(record: ChatMessageRecord): ChatMessageInput {
  const payload = record.payload ?? {};
  const occurred = record.occurredAt || textOf(payload.occurredAt);
  return {
    channelId: textOf(payload.channelId) || textOf(payload.aclRef),
    providerMessageId: record.externalId,
    threadKey: textOf(payload.threadKey) || null,
    authorRef: textOf(payload.sender) || null,
    authorLabel: textOf(payload.senderLabel) || null,
    body: typeof payload.text === 'string' ? payload.text : typeof payload.body === 'string' ? payload.body : '',
    postedAt: occurred || new Date(),
    // An edit keeps the message's original post time (its bucket) and says when it was edited.
    editedAt: textOf(payload.editedAt) || null,
    raw: payload,
  };
}

/** The corpus key the connector document sink stored a per-message chat row under before D-016. */
export function legacyChatMessageDocumentKeys(input: {
  sourceId: string;
  corpusSource: string;
  externalId: string;
  providerAccountId?: string | null;
}): string[] {
  // datatype-destination-sink.ts dataSourceDocumentDedupeKey: `<datatype>:<sourceId>:<nativeId>`.
  const plain = `${DEFAULT_CHAT_MESSAGE_DATATYPE}:${input.sourceId}:${input.externalId}`;
  const providerAccountId = input.providerAccountId?.trim();
  if (!providerAccountId) return [plain];
  // A personal source's row went through the vault writer, which prefixes the key by account.
  return [plain, dedupeKeyFor({ source: input.corpusSource, kind: DEFAULT_CHAT_MESSAGE_DATATYPE, dedupeKey: plain, providerAccountId })];
}

/** Remove the legacy per-message corpus row of one message, so its text is indexed only through its unit. */
export async function removeLegacyChatMessageDocument(
  sql: Sql,
  workspaceId: string,
  input: Parameters<typeof legacyChatMessageDocumentKeys>[0],
): Promise<number> {
  const rows = await sql`
    DELETE FROM harness_shared.documents
     WHERE workspace_id = ${workspaceId} AND source = ${input.corpusSource}
       AND kind = ${DEFAULT_CHAT_MESSAGE_DATATYPE}
       AND dedupe_key = ANY(${sql.array(legacyChatMessageDocumentKeys(input))}::text[])
    RETURNING 1`;
  return rows.length;
}

/**
 * The cut-over of per-message corpus rows written before D-016 (one `chat-message` document per
 * message): each becomes a raw chat message of its data source and is then deleted, so the
 * message is indexed once, through its unit, with the unit's permission list.
 */
export async function migrateLegacyChatMessageDocuments(
  sql: Sql,
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<{ migrated: number }> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? DEFAULT_ROLLUP_BATCH));
  const rows = await sql<Array<{ id: string; data_source_id: string; external_id: string | null; occurred_at: Date | null; metadata: Record<string, unknown> | null }>>`
    SELECT d.id::text AS id, s.id::text AS data_source_id, d.external_id, d.occurred_at, d.metadata
      FROM harness_shared.documents d
      JOIN harness_shared.data_sources s
        ON s.workspace_id = d.workspace_id AND s.id::text = d.metadata ->> 'dataSourceId'
     WHERE d.workspace_id = ${workspaceId} AND d.kind = ${DEFAULT_CHAT_MESSAGE_DATATYPE}
     ORDER BY d.id
     LIMIT ${limit}`;
  let migrated = 0;
  for (const row of rows) {
    const input = row.external_id
      ? chatMessageInputFromRecord({ externalId: row.external_id, occurredAt: row.occurred_at, payload: row.metadata ?? {} })
      : null;
    // A row that names no message cannot become one; it is still a duplicate of nothing, so it goes.
    if (input && input.channelId) await upsertChatMessages(sql, workspaceId, row.data_source_id, [input]);
    await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${workspaceId} AND id::text = ${row.id}`;
    migrated += 1;
  }
  return { migrated };
}

export interface ChatRollupPassResult extends ChatRollupResult {
  expired: number;
  tombstonesErased: number;
  revisionsDropped: number;
  /** Documents deleted by purgeExpiredDocuments (P-017c). */
  documentsExpired: number;
  /** Expired documents kept because a legal hold covers them. */
  documentsHeldKept: number;
  legacyMigrated: number;
  batches: number;
}

/**
 * One driver pass (D-016): retention first (chat messages, whose deletes re-queue buckets,
 * then the source's other documents, P-017c), then the legacy
 * cut-over, then up to `maxBatches` rollup batches. Each step commits in its own transaction.
 * A bucket that fails to render is re-queued after the retry delay and reported in `failures`
 * while the rest of its batch commits; any other failure rolls back its step and propagates.
 */
export async function runChatRollupPass(
  sql: Sql,
  opts: {
    workspaceId: string; maxBatches?: number; batchSize?: number; gapMinutes?: number; retryDelaySeconds?: number;
    maxRetryDelaySeconds?: number; deadLetterAttempts?: number; now?: Date;
  },
): Promise<ChatRollupPassResult> {
  const { workspaceId } = opts;
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? DEFAULT_ROLLUP_BATCH));
  const maxBatches = Math.max(1, opts.maxBatches ?? 5);
  const tx = <T>(fn: (inner: Sql) => Promise<T>): Promise<T> =>
    sql.begin((inner) => fn(inner as unknown as Sql)) as Promise<T>;
  const purged = await tx((inner) => purgeExpiredChatMessages(inner, workspaceId, { now: opts.now }));
  const documentRetention = await tx((inner) => purgeExpiredDocuments(inner, workspaceId, { now: opts.now }));
  const legacy = await tx((inner) => migrateLegacyChatMessageDocuments(inner, workspaceId, { limit: batchSize }));
  const result: ChatRollupPassResult = {
    ...purged,
    ...documentRetention,
    legacyMigrated: legacy.migrated,
    batches: 0,
    buckets: 0,
    unitsWritten: 0,
    unitsUnchanged: 0,
    unitsRemoved: 0,
    documentsWritten: 0,
    corpusSkipped: {},
    failed: 0,
    deadLettered: 0,
    failures: [],
  };
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await tx((inner) => rollupChatUnits(inner, workspaceId, {
      limit: batchSize, gapMinutes: opts.gapMinutes, retryDelaySeconds: opts.retryDelaySeconds,
      maxRetryDelaySeconds: opts.maxRetryDelaySeconds, deadLetterAttempts: opts.deadLetterAttempts,
    }));
    result.batches += 1;
    result.buckets += batch.buckets;
    result.unitsWritten += batch.unitsWritten;
    result.unitsUnchanged += batch.unitsUnchanged;
    result.unitsRemoved += batch.unitsRemoved;
    result.documentsWritten += batch.documentsWritten;
    result.failed += batch.failed;
    result.deadLettered += batch.deadLettered;
    result.failures.push(...batch.failures.slice(0, MAX_REPORTED_ROLLUP_FAILURES - result.failures.length));
    for (const [reason, count] of Object.entries(batch.corpusSkipped) as Array<[CorpusSkipReason, number]>) {
      result.corpusSkipped[reason] = (result.corpusSkipped[reason] ?? 0) + count;
    }
    if (batch.buckets < batchSize) break;
  }
  return result;
}

/**
 * The one writer that places a hold. `id` and `placedAt` are for restore reconciliation only
 * (organization-data-receipts `reconcileRestoredAccess`): a hold placed after the backup point is put
 * back with its original id and placement time, so audit events that name it still resolve.
 */
export async function placeLegalHold(
  sql: Sql,
  workspaceId: string,
  input: { dataSourceId: string; channelId?: string | null; reason: string; placedBy: string; id?: string; placedAt?: string },
): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_source_legal_holds (workspace_id, id, data_source_id, channel_id, reason, placed_by, placed_at)
    VALUES (${workspaceId}, COALESCE(${input.id ?? null}::uuid, gen_random_uuid()), ${input.dataSourceId}::uuid,
            ${input.channelId?.trim() || null},
            ${nonEmpty(input.reason, 'invalid_legal_hold_reason')}, ${nonEmpty(input.placedBy, 'invalid_legal_hold_placed_by')},
            COALESCE(${input.placedAt ?? null}::timestamptz, now()))
    RETURNING id`;
  return { id: rows[0]!.id };
}

/** The one writer that releases a hold. `releasedAt` is for restore reconciliation only (see placeLegalHold). */
export async function releaseLegalHold(
  sql: Sql,
  workspaceId: string,
  input: { id: string; releasedBy: string; releasedAt?: string },
): Promise<{ released: number }> {
  const rows = await sql`
    UPDATE harness_shared.data_source_legal_holds
       SET released_at = COALESCE(${input.releasedAt ?? null}::timestamptz, now()),
           released_by = ${nonEmpty(input.releasedBy, 'invalid_legal_hold_released_by')}
     WHERE workspace_id = ${workspaceId} AND id = ${input.id}::uuid AND released_at IS NULL
    RETURNING id`;
  return { released: rows.length };
}
