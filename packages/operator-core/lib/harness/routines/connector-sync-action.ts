/**
 * `system:connector-sync` — the routine that runs the ONE host-owned connector
 * sync driver over every registered provider (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05 P-004 / R-3). Seeded by migration
 * 1360. Per-provider poll actions are retired as each provider moves onto the
 * driver (Gmail P-008, Calendar P-009, GitHub issues P-010).
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  formatConnectorSyncLog,
  formatConnectorWakeLog,
  runConnectorSync,
  runConnectorWakes,
} from '../../providers/connector-runtime';
import { formatConnectorPushLog, reconcileConnectorPush, type ConnectorPushResult } from '../../providers/connector-push';
import { runPendingParticipantBackfills } from '../../relationship-graph/participant-backfill';
import { runChatRollupPass, type ChatRollupFailure } from '../../data-sources/chat-retrieval-units';
import type { Sql } from 'postgres';
import {
  isGoogleWorkspaceTerminalAuthError,
  withGoogleWorkspaceAccessTokenRetry,
} from '../../external-triggers/google-workspace';
import {
  listPollableExternalTriggerSources,
  sourceTokenHarness,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import { syncGoogleContacts } from '../../personal-vault/live-sink';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

type GoogleContactsSyncResult = Awaited<ReturnType<typeof syncGoogleContacts>>;

export interface GoogleContactsPersonalVaultPollFailure {
  sourceId: string;
  status: 'degraded' | 'error';
  error: string;
}

export interface GoogleContactsPersonalVaultPollResult {
  sources: number;
  succeeded: number;
  failed: number;
  contacts: number;
  pages: number;
  failures: GoogleContactsPersonalVaultPollFailure[];
}

export interface GoogleContactsPersonalVaultPollDeps {
  listSources?: typeof listPollableExternalTriggerSources;
  withAccessTokenRetry?: typeof withGoogleWorkspaceAccessTokenRetry;
  syncContacts?: typeof syncGoogleContacts;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
}

function googlePeopleErrorStatus(cause: unknown): number | null {
  const match = /^google_people_(\d{3})$/.exec(errorText(cause));
  return match ? Number(match[1]) : null;
}

/** Poll every owned, credentialed Contacts source into its owner's Personal Vault. */
export async function runGoogleContactsPersonalVaultPoll(
  ctx: SystemActionCtx,
  sql: Sql,
  provided: GoogleContactsPersonalVaultPollDeps = {},
): Promise<GoogleContactsPersonalVaultPollResult> {
  const listSources = provided.listSources ?? listPollableExternalTriggerSources;
  const withAccessTokenRetry = provided.withAccessTokenRetry ?? withGoogleWorkspaceAccessTokenRetry;
  const syncContacts = provided.syncContacts ?? syncGoogleContacts;
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const sources = await listSources(sql, ctx.workspaceId, 'contacts');
  const result: GoogleContactsPersonalVaultPollResult = {
    sources: sources.length,
    succeeded: 0,
    failed: 0,
    contacts: 0,
    pages: 0,
    failures: [],
  };

  for (const source of sources) {
    try {
      if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${source.id}`);
      if (!source.providerAccountId) throw new Error(`external_trigger_source_account_required:${source.id}`);
      const synced = await withAccessTokenRetry(
        source,
        sourceTokenHarness(source.config, ctx.installSlug),
        async (accessToken) => {
          try {
            return {
              status: 200,
              result: await syncContacts(sql, {
                workspaceId: ctx.workspaceId,
                userId: source.ownerUserId!,
                sourceId: source.id,
                providerAccountId: source.providerAccountId!,
                accessToken,
              }),
            };
          } catch (cause) {
            const status = googlePeopleErrorStatus(cause);
            // withRetry refreshes only when the callback returns status=401.
            // Other HTTP failures must remain source errors, not auth retries.
            if (status !== 401) throw cause;
            return { status, result: null };
          }
        },
      );
      if (!synced) throw new Error(`google_people_sync_result_missing:${source.id}`);
      await updateSource(sql, ctx.workspaceId, source.id, {
        status: 'connected',
        lastError: null,
        connected: true,
      });
      result.succeeded += 1;
      result.contacts += synced.contacts;
      result.pages += synced.pages;
    } catch (cause) {
      const error = errorText(cause);
      const status = isGoogleWorkspaceTerminalAuthError(cause) ? 'error' : 'degraded';
      await updateSource(sql, ctx.workspaceId, source.id, { status, lastError: error });
      result.failed += 1;
      result.failures.push({ sourceId: source.id, status, error });
    }
  }

  return result;
}

export interface ConnectorSyncActionDeps {
  sql?: Sql;
  reconcilePush?: typeof reconcileConnectorPush;
  runConnectorWakes?: typeof runConnectorWakes;
  runConnectorSync?: typeof runConnectorSync;
  runParticipantBackfills?: typeof runPendingParticipantBackfills;
  runGoogleContacts?: (ctx: SystemActionCtx, sql: Sql) => Promise<GoogleContactsPersonalVaultPollResult>;
  runChatRollup?: (sql: Sql, opts: { workspaceId: string }) => Promise<{
    buckets: number; unitsWritten: number; unitsRemoved: number; expired: number; documentsExpired: number;
    documentsHeldKept: number; legacyMigrated: number; failed: number; deadLettered: number; failures: ChatRollupFailure[];
  }>;
}

/** The registered one-minute connector runner, exported as a deterministic test seam. */
export async function runConnectorSyncAction(ctx: SystemActionCtx, provided: ConnectorSyncActionDeps = {}) {
  const sql = provided.sql ?? getOrgPg().sql;
  const options = { workspaceId: ctx.workspaceId, harness: ctx.installSlug };
  // Provider webhooks (linear-asana-task-sync D-016): keep each push-capable source's remote
  // webhooks matching its config and public hook URL. Diagnostics only, never a failed pass.
  const push = await (provided.reconcilePush ?? reconcileConnectorPush)(sql, options).catch(
    (cause: unknown): ConnectorPushResult => ({
      sources: [{ sourceId: '*', providerId: '*', outcome: 'failed', subscriptions: 0, error: cause instanceof Error ? cause.message : String(cause) }],
    }),
  );
  if (push.sources.length > 0) console.log(formatConnectorPushLog(push));
  const pushFailed = push.sources.filter((source) => source.outcome === 'failed');
  // Push wake first (D-018.2): a provider's doorbell marks its sources due so
  // this same tick syncs them. A wake failure is diagnostics, never a failed pass.
  const wakes = await (provided.runConnectorWakes ?? runConnectorWakes)(sql, options);
  if (wakes.sources.length > 0) console.log(formatConnectorWakeLog(wakes));
  const result = await (provided.runConnectorSync ?? runConnectorSync)(sql, options);
  if (result.sources.length > 0) console.log(formatConnectorSyncLog(result));
  const failed = result.sources.filter((source) => source.outcome === 'failed' || source.outcome === 'reconnect-required');
  // Contacts is a Google Workspace capability source without a generic provider
  // plugin. Run the existing Personal Vault adapter on this durable cadence.
  const contacts = await (provided.runGoogleContacts ?? runGoogleContactsPersonalVaultPoll)(ctx, sql).catch(
    (cause: unknown): GoogleContactsPersonalVaultPollResult => ({
      sources: 0,
      succeeded: 0,
      failed: 1,
      contacts: 0,
      pages: 0,
      failures: [{ sourceId: '*', status: 'degraded', error: errorText(cause) }],
    }),
  );
  if (contacts.sources > 0 || contacts.failed > 0) {
    console.log(
      '[connector-sync] Google Contacts Vault sources=' + contacts.sources +
        ' succeeded=' + contacts.succeeded + ' failed=' + contacts.failed +
        ' contacts=' + contacts.contacts + ' pages=' + contacts.pages,
    );
  }
  // D-018: project participants of interactions stored before a source's person -> record grant.
  // Independent of the sync outcome above (it reads the owner's Vault, not the provider), and a
  // failure here is reported, never a failed pass. Time-boxed per tick (WI-10006999): a large
  // mailbox continues over several ticks from its saved cursor instead of holding this tick.
  const backfills = await (provided.runParticipantBackfills ?? runPendingParticipantBackfills)(sql, { workspaceId: ctx.workspaceId }).catch(
    (cause: unknown) => [{ sourceId: '*', outcome: 'failed' as const, documents: 0, participants: 0, error: cause instanceof Error ? cause.message : String(cause) }],
  );
  if (backfills.length > 0) console.log(`connector-sync participant backfill: ${JSON.stringify(backfills)}`);
  const backfillFailed = backfills.filter((b) => b.outcome === 'failed');
  // D-016: render the chat messages this tick (and earlier ones) stored into their thread/window
  // units, after retention. Independent of the sync outcome; a failure is reported, never a
  // failed pass, and its uncommitted batch stays queued for the next tick. A single bucket that
  // fails is re-queued with a delay by the pass itself and reported here per bucket.
  let chatRollupError: string | null = null;
  const chat = await (provided.runChatRollup ?? runChatRollupPass)(sql, { workspaceId: ctx.workspaceId }).catch((cause: unknown) => {
    chatRollupError = errorText(cause);
    return {
      buckets: 0, unitsWritten: 0, unitsRemoved: 0, expired: 0, documentsExpired: 0, documentsHeldKept: 0,
      legacyMigrated: 0, failed: 0, deadLettered: 0, failures: [],
    };
  });
  if (chat.buckets > 0 || chat.expired > 0 || chat.documentsExpired > 0 || chat.documentsHeldKept > 0 || chat.legacyMigrated > 0) {
    console.log(
      '[connector-sync] chat rollup buckets=' + chat.buckets + ' unitsWritten=' + chat.unitsWritten +
        ' unitsRemoved=' + chat.unitsRemoved + ' expired=' + chat.expired +
        ' documentsExpired=' + chat.documentsExpired + ' documentsHeldKept=' + chat.documentsHeldKept +
        ' legacyMigrated=' + chat.legacyMigrated,
    );
  }
  const softErrors = [
    ...(failed.length > 0
      ? [`connector-sync: ${failed.length} source(s) failed: ${failed.map((s) => `${s.sourceId}:${s.error ?? s.outcome}`).join('; ')}`]
      : []),
    ...(backfillFailed.length > 0
      ? [`participant backfill: ${backfillFailed.length} source(s) failed: ${backfillFailed.map((b) => `${b.sourceId}:${b.error ?? 'failed'}`).join('; ')}`]
      : []),
    ...(contacts.failed > 0
      ? [`Google Contacts Vault sync: ${contacts.failed} source(s) failed: ${contacts.failures.map((s) => `${s.sourceId}:${s.error}`).join('; ')}`]
      : []),
    ...(pushFailed.length > 0
      ? [`push subscribe: ${pushFailed.length} source(s) failed: ${pushFailed.map((s) => `${s.sourceId}:${s.error ?? 'failed'}`).join('; ')}`]
      : []),
    ...(chatRollupError ? [`chat rollup failed: ${chatRollupError}`] : []),
    // WI-6554700010012111: a re-queued bucket backs off; a dead-lettered one is not retried again until
    // a new message or a routing change revives it, so this is its last report.
    ...(chat.failed > 0
      ? [`chat rollup: ${chat.failed} bucket(s) failed (${chat.failed - chat.deadLettered} re-queued, ${chat.deadLettered} dead-lettered): ${chat.failures
        .map((f) => `${f.dataSourceId}/${f.channelId}/${f.bucketKind}:${f.bucketKey}:${f.error} (attempt ${f.attempts}${f.deadLettered ? ', dead-lettered' : ''})`).join('; ')}`]
      : []),
  ];
  return {
    diagnostics: {
      providers: result.providers,
      sources: result.sources.length,
      failed: failed.length,
      admitted: result.sources.reduce((n, source) => n + source.admitted, 0),
      woken: wakes.sources.filter((source) => source.outcome === 'woken').length,
      wakeFailed: wakes.sources.filter((source) => source.outcome === 'failed').length,
      contactsSources: contacts.sources,
      contactsSynced: contacts.contacts,
      contactsPages: contacts.pages,
      contactsFailed: contacts.failed,
      participantBackfilled: backfills.filter((b) => b.outcome === 'backfilled').length,
      participantBackfillPartial: backfills.filter((b) => b.outcome === 'partial').length,
      participantBackfillFailed: backfillFailed.length,
      pushSubscribed: push.sources.filter((source) => source.outcome === 'subscribed').length,
      pushFailed: pushFailed.length,
      chatBuckets: chat.buckets,
      chatUnitsWritten: chat.unitsWritten,
      chatUnitsRemoved: chat.unitsRemoved,
      chatExpired: chat.expired,
      chatDocumentsExpired: chat.documentsExpired,
      chatDocumentsHeldKept: chat.documentsHeldKept,
      chatLegacyMigrated: chat.legacyMigrated,
      chatRollupFailed: chatRollupError ? 1 : 0,
      chatBucketsFailed: chat.failed,
      chatBucketsDeadLettered: chat.deadLettered,
    },
    ...(softErrors.length > 0 ? { softError: softErrors.join(' | ').slice(0, 1000) } : {}),
  };
}

registerSystemAction('connector-sync', async (ctx) => runConnectorSyncAction(ctx));
