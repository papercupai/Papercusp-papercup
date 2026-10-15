/**
 * One host-owned connector sync driver over every registered provider
 * (generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * P-004 / D-006 / requirement R-3).
 *
 * A provider plugin only answers `syncPage({ source, cursor, mode })`. Everything
 * stateful is the host's, and lives on the source row (migration 1360):
 *
 *  - LEASE: a source is synced by at most one driver at a time. The lease
 *    expires, so a driver that dies mid-sync releases the source implicitly and
 *    the next fire resumes from the last COMMITTED cursor.
 *  - ADMISSION BEFORE COMMIT: every record of a page is admitted through
 *    `ingestExternalTriggerEvent` (the durable per-source/per-sink delivery
 *    ledger) BEFORE the page's cursor is committed. A crash between the two
 *    re-fetches the page on resume; the version-scoped dedupe key makes that
 *    replay a no-op, so each remote object version is delivered exactly once.
 *    A provider that dies mid-page admits nothing and commits nothing.
 *  - VERSION-SCOPED DEDUPE: the key carries the source, datatype, native id and
 *    a hash of the record's content, so a replayed page dedupes while an edit or
 *    a delete of the same object is a new delivery.
 *  - BACKOFF: a rate limit honours `retryAfterSeconds`; a transient failure
 *    backs off exponentially per source. Neither advances the cursor.
 *  - CURSOR RESET: a provider-declared `cursor-expired` restarts the source as a
 *    backfill from a null cursor, once per pass.
 *  - HEALTH: `connected` after a clean pass, `degraded` after repeated
 *    transient failures, `error` when the account must be reconnected.
 *  - PUSH-WAKE: a webhook / Pub/Sub doorbell only calls
 *    {@link wakeConnectorSource}; it is never an alternate data path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import type {
  HostFetch,
  ProviderCoverage,
  ProviderRecord,
  ProviderMembershipSnapshot,
  ProviderSyncError,
  ProviderSyncPage,
  ProviderCatchUp,
  ProviderLossRisk,
} from '@papercusp/plugin-sdk';
import {
  ingestExternalTriggerEvent,
  type ExternalTriggerSink,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from '../external-triggers/ingestion';
import {
  providerRegistry,
  readyProviderRegistry,
  type ProviderRegistry,
  type RegisteredProvider,
} from '../integrations/provider-registry';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { resolveProviderServices } from '../integrations/service-credentials';
import {
  PROVIDER_ACL_REF_PATTERN,
  providerCoverageIssues,
  providerSyncProgressIssues,
  PROVIDER_SYNC_ADOPT_CAPABILITY,
  PROVIDER_SYNC_WAKE_CAPABILITY,
  providerSyncErrorOf,
  type ProviderAdoptResult,
  type ProviderServices,
  type ProviderSourceScope,
  type ProviderWakeResult,
} from '@papercusp/plugin-sdk';
import { createPersonalVaultExternalSinkForSource, VAULT_DATATYPES } from '../personal-vault/live-sink';
import {
  applyDataSourceMembership,
  createDatatypeDestinationSinks,
  type DataSourceMembershipOutcome,
} from '../data-sources/datatype-destination-sink';
import { DEFAULT_CHAT_MESSAGE_DATATYPE, reconcileChatMessageCoverage } from '../data-sources/chat-retrieval-units';
import { createRelationshipGraphSink } from '../relationship-graph/graph-sink';
import { createInteractionParticipantSink, isInteractionDatatype } from '../relationship-graph/participants';
import { graphDefaultHarness, isGraphEntityDatatype } from '../relationship-graph/resolver';
import { createAppDeliverySinkIfConfigured, reportAppSinkGateError } from '../app-data-producer/live-sink';
import { DATATYPE_FOR_APP } from '../app-data-producer/app-rows';
import { missingRequiredJsonSchemaKeys } from '../json-schema-validation';

/** Source statuses the driver advances. `error` waits for a reconnect. */
export const CONNECTOR_SYNC_STATUSES = ['ready', 'connecting', 'connected', 'degraded'] as const;
export const DEFAULT_CONNECTOR_LEASE_SECONDS = 300;
export const DEFAULT_CONNECTOR_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_CONNECTOR_MAX_PAGES = 20;
/** Consecutive transient failures before a source reports `degraded`. */
export const CONNECTOR_DEGRADED_AFTER_FAILURES = 3;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3_600;

export interface ConnectorSourceRow {
  id: string;
  workspaceId: string;
  kind: string;
  ownerUserId: string | null;
  credentialRef: string | null;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  backfillStatus: string | null;
  failureCount: number;
  wakeRequestedAt: string | null;
  /** personal | organization | pot; passed on every sync request (D-026). */
  scope?: string | null;
}

type MembershipInput = {
  identityProvider: string;
  members: ReadonlyArray<{ providerUserId: string }>;
  containers?: ReadonlyArray<{ ref: string; title?: string; members: ReadonlyArray<{ providerUserId: string }> }>;
};

const SOURCE_SCOPES = new Set<ProviderSourceScope>(['personal', 'organization', 'pot']);

function sourceScopeOf(source: Pick<ConnectorSourceRow, 'scope'>): ProviderSourceScope | null {
  return source.scope && SOURCE_SCOPES.has(source.scope as ProviderSourceScope) ? (source.scope as ProviderSourceScope) : null;
}

export type ConnectorSourceOutcomeKind =
  | 'synced'
  | 'leased-elsewhere'
  | 'rate-limited'
  | 'failed'
  | 'reconnect-required'
  | 'needs-config';

export interface ConnectorSourceOutcome {
  sourceId: string;
  providerId: string;
  outcome: ConnectorSourceOutcomeKind;
  mode: 'backfill' | 'incremental';
  pages: number;
  admitted: number;
  deduped: number;
  rejected: number;
  cursorReset: boolean;
  /**
   * The provider's cursor-expired message that triggered the reset, so a full resync is
   * attributable to an operation and status instead of inferred from a counter (WI-10001662).
   */
  cursorResetReason?: string;
  catchUp?: ProviderCatchUp;
  lossRisk?: ProviderLossRisk;
  /** True when this pass adopted the source's pre-provider cursor state (D-020). */
  adopted?: boolean;
  /** Provider-required config keys absent before this source can be synced. */
  missingConfig?: string[];
  /** What the last membership snapshot this pass carried did to the source's permission list (D-015.4). */
  membership?: DataSourceMembershipOutcome;
  /** Stored objects this pass's coverage windows found deleted at the provider and tombstoned. */
  coverageTombstoned?: number;
  hasMore: boolean;
  error?: string;
  /** The afterSourceSynced hook failed (the pass itself succeeded). */
  afterSyncError?: string;
}

export interface ConnectorSyncResult {
  providers: number;
  sources: ConnectorSourceOutcome[];
}

export interface ConnectorSyncOptions {
  workspaceId: string;
  /** Install slug whose token store holds the source credentials. */
  harness: string;
  /** Restrict the pass to these sources (push-wake path). Due-ness still applies. */
  sourceIds?: readonly string[];
  maxPagesPerSource?: number;
  leaseSeconds?: number;
  pollIntervalSeconds?: number;
}

export interface ConnectorSyncDeps {
  registry?: ProviderRegistry;
  /** Builds the provider's `host.fetch`; production binds the source account's token. */
  hostFetchFor?: (provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorSyncOptions) => HostFetch;
  ingest?: (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;
  /** Extra sinks for one record of `datatype` from `source`. */
  sinksFor?: (sql: postgres.Sql, source: ConnectorSourceRow, datatype: string) => Promise<ExternalTriggerSink[]>;
  /** Applies a page's membership snapshot (D-015.4). Defaults to the organization permission-list writer. */
  applyMembership?: (
    sql: postgres.Sql,
    source: ConnectorSourceRow,
    input: MembershipInput,
  ) => Promise<DataSourceMembershipOutcome>;
  /**
   * Applies one coverage window of a page: tombstones what is stored in the window and absent from
   * its live set. Returns null for a datatype with nothing stored to reconcile. Defaults to the chat
   * raw-message reconciler (WI-6554700010012278).
   */
  reconcileCoverage?: (
    sql: postgres.Sql,
    source: ConnectorSourceRow,
    coverage: ProviderCoverage,
  ) => Promise<{ tombstoned: number } | null>;
  /** Parameters of the provider's configured service credentials (D-018.1). */
  servicesFor?: (provider: RegisteredProvider) => Promise<ProviderServices | undefined>;
  leaseOwner?: string;
  /**
   * Runs after a source's pass ends `synced`. Defaults to the admission lifecycle write-back pass
   * (work-admission/lifecycle.ts, linear-asana-task-sync P-003): what the source's admitted work
   * items have done since the last pass is written back once the source's own state is current.
   * A failure here is logged on the outcome and never fails the sync.
   */
  afterSourceSynced?: (sql: postgres.Sql, source: ConnectorSourceRow) => Promise<unknown>;
}

async function defaultAfterSourceSynced(sql: postgres.Sql, source: ConnectorSourceRow): Promise<unknown> {
  // Imported on use: the lifecycle module reaches back into data sources through work admission.
  const { reconcileAdmissionLifecycle } = await import('../work-admission/lifecycle');
  return reconcileAdmissionLifecycle(sql, { workspaceId: source.workspaceId, dataSourceId: source.id });
}

function defaultServicesFor(provider: RegisteredProvider): Promise<ProviderServices | undefined> {
  return resolveProviderServices(provider.descriptor.serviceCredentials);
}

/**
 * Chat messages are the one stored datatype with deletes to reconcile: a message deleted while the
 * daemon was offline never sends a live delete, so a fully read window is the only way to learn of
 * it. Any other datatype has nothing stored here to tombstone.
 */
async function defaultReconcileCoverage(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  coverage: ProviderCoverage,
): Promise<{ tombstoned: number } | null> {
  if (coverage.datatype !== DEFAULT_CHAT_MESSAGE_DATATYPE) return null;
  return reconcileChatMessageCoverage(sql, source.workspaceId, source.id, {
    channelId: coverage.containerRef,
    threadKey: coverage.threadRef ?? null,
    from: coverage.from ?? null,
    to: coverage.to ?? null,
    liveProviderMessageIds: coverage.nativeIds,
  });
}

/** A provider-declared sync failure, thrown by host-side code that maps one. */
export class ProviderSyncFailure extends Error {
  constructor(readonly failure: ProviderSyncError) {
    super(failure.message);
    this.name = 'ProviderSyncFailure';
  }
}

/**
 * Map anything a provider threw (a `ProviderSyncError` object, an Error with a
 * `kind`, or a daemon JSON-RPC error carrying one in `data`) to the four
 * signals the host interprets. Anything unrecognised is transient.
 */
export function classifyProviderSyncError(cause: unknown): ProviderSyncError {
  if (cause instanceof ProviderSyncFailure) return cause.failure;
  // One reader shared with the SDK conformance kit (P-026), so a package that passes the kit is
  // classified identically here.
  return providerSyncErrorOf(cause) ?? { kind: 'transient', message: cause instanceof Error ? cause.message : String(cause) };
}

/** Exponential per-source backoff for the Nth consecutive failure (1-based). */
export function connectorBackoffSeconds(failureCount: number): number {
  const n = Math.max(1, Math.floor(failureCount));
  return Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (n - 1));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Version-scoped delivery dedupe key: the same object version replayed dedupes;
 * an edit (new content) or a delete is a new delivery. Datatype-scoped, so one
 * source emitting two datatypes with the same native id never collides.
 *
 * A record that carries a provider-declared `version` is keyed on that version
 * instead of its content, so a provider whose payload legitimately changes
 * between fetches of the same object (Gmail labels on an immutable message)
 * does not re-deliver it. A delete is still a distinct delivery.
 */
export function connectorRecordDedupeKey(sourceId: string, record: ProviderRecord): string {
  const identity =
    typeof record.version === 'string'
      ? { version: record.version, deleted: record.deleted === true }
      : { payload: record.payload, deleted: record.deleted === true, occurredAt: record.occurredAt ?? null };
  const version = createHash('sha256').update(stableJson(identity)).digest('hex').slice(0, 32);
  return `connector:${sourceId}:${record.datatype}:${record.nativeId}:${version}`;
}

function defaultLeaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/**
 * A scalar for `jsonb_set`, as JSON TEXT cast `::text::jsonb`. `sql.json(<bare string>)` sends
 * the string unquoted, so `::jsonb` rejects it ("invalid input syntax for type json") and every
 * cursor commit failed after its page was admitted.
 */
export function jsonText(value: string | null): string {
  return JSON.stringify(value);
}

function providerCursorOf(source: ConnectorSourceRow): string | null {
  const value = source.cursor?.provider;
  return typeof value === 'string' && value ? value : null;
}

/**
 * The source's pre-provider cursor state, for `sync.adopt` (D-020): its cursor object without
 * the host-owned `provider` and `wake` keys. Null when there is nothing to adopt, and null once
 * the `provider` key EXISTS at all. A cursor-expired reset writes `provider: null`, and
 * re-adopting the stale legacy position after that would loop on the same expired cursor.
 */
export function priorCursorStateOf(source: Pick<ConnectorSourceRow, 'cursor'>): Record<string, unknown> | null {
  const raw: unknown = source.cursor;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.prototype.hasOwnProperty.call(raw, 'provider')) return null;
  const prior: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete prior.wake;
  return Object.keys(prior).length > 0 ? prior : null;
}

function asAdoptResult(value: unknown, provider: RegisteredProvider): ProviderAdoptResult {
  const candidate = (value ?? {}) as { cursor?: unknown; backfillComplete?: unknown };
  if (
    !(candidate.cursor === null || (typeof candidate.cursor === 'string' && candidate.cursor))
    || typeof candidate.backfillComplete !== 'boolean'
  ) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned a malformed sync.adopt result` });
  }
  return { cursor: candidate.cursor, backfillComplete: candidate.backfillComplete };
}

function defaultApplyMembership(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  input: MembershipInput,
): Promise<DataSourceMembershipOutcome> {
  return applyDataSourceMembership(sql, { workspaceId: source.workspaceId, sourceId: source.id, ...input });
}

/**
 * Records a provider handed back (a sync page's, or an `ingress.normalize` result's, D-009) must
 * each carry a declared datatype and a native id; anything else is a transient provider fault.
 */
export function assertProviderRecords(
  records: unknown,
  provider: Pick<RegisteredProvider, 'descriptor'>,
): asserts records is ProviderRecord[] {
  if (!Array.isArray(records)) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned no record list` });
  }
  const declared = new Set(provider.descriptor.datatypes);
  const containers = provider.descriptor.membership?.containers === true;
  for (const record of records as Array<Partial<ProviderRecord> | null>) {
    if (!record || typeof record.nativeId !== 'string' || !record.nativeId || !declared.has(record.datatype as string)) {
      throw new ProviderSyncFailure({
        kind: 'transient',
        message: `provider ${provider.descriptor.id} returned a record with an undeclared datatype or empty native id`,
      });
    }
    // A record may name its container only when the descriptor declares containers (D-026).
    if (record.aclRef !== undefined && (!containers || typeof record.aclRef !== 'string' || !PROVIDER_ACL_REF_PATTERN.test(record.aclRef))) {
      throw new ProviderSyncFailure({
        kind: 'transient',
        message: `provider ${provider.descriptor.id} returned a record with an aclRef its descriptor does not allow`,
      });
    }
  }
}

/** What admitting one record did: stored/delivered, already delivered, or refused by datatype validation. */
export type ConnectorRecordAdmission = 'admitted' | 'deduped' | 'rejected';

export interface ConnectorRecordAdmissionDeps {
  ingest?: (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;
  sinksFor?: (sql: postgres.Sql, source: ConnectorSourceRow, datatype: string) => Promise<ExternalTriggerSink[]>;
  /** Per-pass sink cache keyed by datatype, so a page of N records resolves its sinks once. */
  sinkCache?: Map<string, ExternalTriggerSink[]>;
}

/**
 * Admit one provider record for a source. This is the ONE admission path for descriptor providers
 * (D-009): a synced page's records and a socket-delivered envelope's records both come through
 * here, so the dedupe key, the datatype sinks and trigger bindings behave identically whichever
 * way a record arrived.
 */
export async function admitConnectorRecord(
  sql: postgres.Sql,
  input: { source: ConnectorSourceRow; providerId: string; record: ProviderRecord },
  deps: ConnectorRecordAdmissionDeps = {},
): Promise<ConnectorRecordAdmission> {
  const { source, providerId, record } = input;
  const ingest = deps.ingest ?? ((db, args) => ingestExternalTriggerEvent(db, args));
  const sinksFor = deps.sinksFor ?? defaultSinksFor;
  let sinks = deps.sinkCache?.get(record.datatype);
  if (!sinks) {
    sinks = await sinksFor(sql, source, record.datatype);
    deps.sinkCache?.set(record.datatype, sinks);
  }
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: providerId,
    event: record.event,
    externalId: record.nativeId,
    datatypeId: record.datatype,
    // The container rides on the payload so the document sink can bind its readership (D-026).
    adapterPayload: record.aclRef ? { ...record.payload, aclRef: record.aclRef } : record.payload,
    normalize: (payload) => payload as Record<string, unknown>,
    occurredAt: record.occurredAt ?? null,
    dedupeKey: connectorRecordDedupeKey(source.id, record),
    // The sinks need it too: a chat-message sink tombstones a deleted message instead of storing it.
    ...(record.deleted === true ? { deleted: true } : {}),
    additionalSinks: sinks,
  });
  if (result.validationErrors?.length) return 'rejected';
  if (result.deliveries.length > 0 && result.deliveries.every((d) => d.deduped)) return 'deduped';
  return 'admitted';
}

function assertPage(page: unknown, provider: RegisteredProvider): asserts page is ProviderSyncPage {
  const p = page as Partial<ProviderSyncPage> | null;
  if (
    !p
    || !Array.isArray(p.records)
    || typeof p.hasMore !== 'boolean'
    || !(p.nextCursor === null || typeof p.nextCursor === 'string')
  ) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned a malformed sync page` });
  }
  assertProviderRecords(p.records, provider);
  if (p.membership !== undefined) {
    if (!provider.descriptor.membership) {
      throw new ProviderSyncFailure({
        kind: 'transient',
        message: `provider ${provider.descriptor.id} returned a membership snapshot its descriptor does not declare`,
      });
    }
    const snapshot = p.membership as Partial<ProviderMembershipSnapshot> | null;
    const wellFormedMembers = (members: unknown) => Array.isArray(members) && members.every((member) =>
      !!member && typeof member.providerUserId === 'string' && member.providerUserId.trim() !== '');
    const containers = snapshot?.containers;
    const wellFormedContainers = containers === undefined || (
      provider.descriptor.membership.containers === true
      && Array.isArray(containers)
      && containers.every((container) => !!container
        && typeof container.ref === 'string' && PROVIDER_ACL_REF_PATTERN.test(container.ref)
        && (container.title === undefined || typeof container.title === 'string')
        && wellFormedMembers(container.members))
      && new Set(containers.map((container) => container.ref)).size === containers.length
    );
    if (!wellFormedMembers(snapshot?.members) || !wellFormedContainers) {
      throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned a malformed membership snapshot` });
    }
  }
  // Coverage erases what it does not name, so a malformed window is refused outright.
  const coverageIssues = providerCoverageIssues(p.coverage, provider.descriptor.datatypes);
  if (coverageIssues.length > 0) {
    throw new ProviderSyncFailure({
      kind: 'transient',
      message: `provider ${provider.descriptor.id} returned malformed coverage: ${coverageIssues.join('; ')}`,
    });
  }
  const progressIssues = providerSyncProgressIssues(p);
  if (progressIssues.length > 0) {
    throw new ProviderSyncFailure({ kind: 'transient', message: `provider ${provider.descriptor.id} returned malformed sync progress: ${progressIssues.join('; ')}` });
  }
}

const SOURCE_COLUMNS = (sql: postgres.Sql) => sql`
  id::text,
  workspace_id AS "workspaceId",
  kind,
  owner_user_id::text AS "ownerUserId",
  credential_ref AS "credentialRef",
  status,
  config,
  cursor,
  backfill_status AS "backfillStatus",
  sync_failure_count AS "failureCount",
  sync_wake_requested_at AS "wakeRequestedAt",
  scope`;

/**
 * Sources of the given provider kinds that are due for a sync pass now. A federated source is
 * searched live instead of copied (live-search-adapter.ts, cupboard-distributable-integrations-
 * 2026-10-10 D-026), so it never gets a pass: no backfill, no membership walk.
 */
export async function listDueConnectorSources(
  sql: postgres.Sql,
  workspaceId: string,
  kinds: readonly string[],
  sourceIds?: readonly string[],
): Promise<ConnectorSourceRow[]> {
  if (kinds.length === 0) return [];
  return sql<ConnectorSourceRow[]>`
    SELECT ${SOURCE_COLUMNS(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId}
       AND kind = ANY(${sql.array([...kinds])}::text[])
       AND status = ANY(${sql.array([...CONNECTOR_SYNC_STATUSES])}::text[])
       AND sync_mode <> 'federated'
       AND (sync_next_attempt_at IS NULL OR sync_next_attempt_at <= now())
       ${sourceIds ? sql`AND id::text = ANY(${sql.array([...sourceIds])}::text[])` : sql``}
     ORDER BY sync_wake_requested_at NULLS LAST, sync_next_attempt_at NULLS FIRST, id`;
}

/**
 * Sources of the given provider kinds the driver still advances, whether or not a sync pass is
 * due: host-held socket ingress (D-009) keeps a connection open for each of them.
 */
export async function listActiveConnectorSources(
  sql: postgres.Sql,
  workspaceId: string,
  kinds: readonly string[],
): Promise<ConnectorSourceRow[]> {
  if (kinds.length === 0) return [];
  return sql<ConnectorSourceRow[]>`
    SELECT ${SOURCE_COLUMNS(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId}
       AND kind = ANY(${sql.array([...kinds])}::text[])
       AND status = ANY(${sql.array([...CONNECTOR_SYNC_STATUSES])}::text[])
     ORDER BY id`;
}

async function acquireLease(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET sync_lease_owner = ${owner},
           sync_lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND (sync_lease_owner IS NULL
            OR sync_lease_owner = ${owner}
            OR sync_lease_expires_at IS NULL
            OR sync_lease_expires_at < now())
    RETURNING id::text`;
  return rows.length === 1;
}

/**
 * Commit one admitted page's cursor, renewing the lease. Returns false when the
 * lease was lost (another driver took the source over); the caller stops, and
 * its already-admitted records stay replay-safe.
 */
async function commitCursor(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  leaseSeconds: number,
  cursor: string | null,
  backfillStatus: string,
  progress?: { catchUp?: ProviderCatchUp; lossRisk?: ProviderLossRisk; catchUpFrom?: string | null },
): Promise<boolean> {
  const prior = source.cursor.providerSync;
  const storedProgress = progress === undefined ? null : JSON.stringify({
    ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
    ...progress,
    ...(backfillStatus !== 'pending' ? { lastSyncedAt: new Date().toISOString() } : {}),
  });
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{provider}', ${jsonText(cursor)}::text::jsonb)
             || CASE WHEN ${storedProgress}::text IS NOT NULL THEN jsonb_build_object('providerSync',
                  ${storedProgress}::text::jsonb) ELSE '{}'::jsonb END,
           backfill_status = ${backfillStatus},
           sync_lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND sync_lease_owner = ${owner}
    RETURNING id::text`;
  return rows.length === 1;
}

async function finishPass(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  owner: string,
  input: {
    status: string;
    lastError: string | null;
    failureCount: number;
    nextAttemptSeconds: number | null;
    success: boolean;
    passStartedAt: Date;
  },
): Promise<void> {
  await sql`
    UPDATE harness_shared.data_sources
       SET status = ${input.status},
           last_error = ${input.lastError?.slice(0, 4000) ?? null},
           sync_failure_count = ${input.failureCount},
           sync_last_success_at = CASE WHEN ${input.success} THEN now() ELSE sync_last_success_at END,
           last_connected_at = CASE WHEN ${input.success} THEN now() ELSE last_connected_at END,
           -- A wake that arrived DURING the pass stays set and makes the source due again.
           sync_wake_requested_at = CASE
             WHEN sync_wake_requested_at IS NOT NULL AND sync_wake_requested_at <= ${input.passStartedAt}
               THEN NULL
             ELSE sync_wake_requested_at
           END,
           sync_next_attempt_at = CASE
             WHEN ${input.success} AND sync_wake_requested_at > ${input.passStartedAt} THEN NULL
             WHEN ${input.nextAttemptSeconds}::integer IS NULL THEN NULL
             ELSE now() + make_interval(secs => ${input.nextAttemptSeconds ?? 0})
           END,
           sync_lease_owner = NULL,
           sync_lease_expires_at = NULL,
           updated_at = now()
     WHERE workspace_id = ${source.workspaceId}
       AND id = ${source.id}::uuid
       AND sync_lease_owner = ${owner}`;
}

/**
 * Ask the driver to reconcile one source soon. Push channels call this and
 * nothing else. It never overrides a backoff: a source cooling down after a
 * rate limit or failure keeps its next attempt time.
 */
export async function wakeConnectorSource(
  sql: postgres.Sql,
  input: { workspaceId: string; sourceId: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.data_sources
       SET sync_wake_requested_at = now(),
           sync_next_attempt_at = CASE WHEN sync_failure_count = 0 THEN NULL ELSE sync_next_attempt_at END,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND id = ${input.sourceId}::uuid
    RETURNING id::text`;
  return rows.length === 1;
}

/** Construction seams for {@link connectorSinksFor}; production passes none. */
export interface ConnectorSinkSeams {
  createPersonalSink?: (sql: postgres.Sql, workspaceId: string, sourceId: string) => Promise<ExternalTriggerSink>;
  createDatatypeSinks?: typeof createDatatypeDestinationSinks;
  /** The relationship-graph resolve sink appended after a stored person/organization record. */
  createGraphSink?: typeof createRelationshipGraphSink;
  /** The relationship-graph sink that projects a stored interaction's participants as persons. */
  createParticipantSink?: typeof createInteractionParticipantSink;
  createAppSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
    app: keyof typeof DATATYPE_FOR_APP,
  ) => Promise<ExternalTriggerSink | null>;
}

/**
 * The production app-sink gate. It never throws (live-sink.ts), and it REPORTS a
 * swallowed gate fault through the shared `reportAppSinkGateError` (P-007), so a
 * database fault is distinguishable from "no app mapping configured".
 */
function defaultAppSink(
  sql: postgres.Sql,
  workspaceId: string,
  sourceId: string,
  app: keyof typeof DATATYPE_FOR_APP,
): Promise<ExternalTriggerSink | null> {
  return createAppDeliverySinkIfConfigured(sql, workspaceId, sourceId, app, { onGateError: reportAppSinkGateError });
}

/**
 * Where one record goes, by DATATYPE only (D-010, D-015): a datatype the personal Vault routes
 * goes to the owner's Vault; every other datatype goes where the datatype registry's nature and
 * the source's destination policy put it (record / event / document). Apps subscribe by datatype:
 * an owned source also registers the app-delivery sink for each app consuming this datatype
 * (P-011). Registration never throws, so an app fault cannot cost the Vault write.
 */
export async function connectorSinksFor(
  sql: postgres.Sql,
  source: ConnectorSourceRow,
  datatype: string,
  seams: ConnectorSinkSeams = {},
): Promise<ExternalTriggerSink[]> {
  const createPersonalSink = seams.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const createDatatypeSinks = seams.createDatatypeSinks ?? createDatatypeDestinationSinks;
  const createAppSink = seams.createAppSink ?? defaultAppSink;
  const createGraphSink = seams.createGraphSink ?? createRelationshipGraphSink;
  const createParticipantSink = seams.createParticipantSink ?? createInteractionParticipantSink;
  const sinks: ExternalTriggerSink[] = [];
  if (VAULT_DATATYPES.includes(datatype)) {
    if (source.ownerUserId) sinks.push(await createPersonalSink(sql, source.workspaceId, source.id));
  } else {
    // A graph record from a personal source (no harness of its own) lands in the graph's home
    // harness (D-019); every other datatype still fails closed without a source harness.
    const datatypeSinks = await createDatatypeSinks(sql, {
      workspaceId: source.workspaceId,
      sourceId: source.id,
      datatype,
      ...(isGraphEntityDatatype(datatype) ? { defaultHarness: graphDefaultHarness() } : {}),
    });
    sinks.push(...datatypeSinks);
    // A stored person/organization record re-resolves its identity cluster in the platform
    // relationship graph (crm-agent-sales-onboarding-apps-2026-10-06 P-002). Only when the
    // record sink actually stores it: a source not routing the datatype to `record` adds nothing.
    if (isGraphEntityDatatype(datatype) && datatypeSinks.some((s) => s.kind === 'data-source-record')) {
      sinks.push(createGraphSink(sql, { workspaceId: source.workspaceId, sourceId: source.id, datatype }));
    }
  }
  // A stored interaction (Vault mail/calendar, corpus call) projects its participants into the graph
  // as persons (P-002, D-013): identity only, and only from a source that routes person to record.
  if (isInteractionDatatype(datatype) && sinks.length > 0) {
    const participantSink = await createParticipantSink(sql, { workspaceId: source.workspaceId, sourceId: source.id, datatype });
    if (participantSink) sinks.push(participantSink);
  }
  if (!source.ownerUserId) return sinks;
  for (const [app, appDatatype] of Object.entries(DATATYPE_FOR_APP) as [keyof typeof DATATYPE_FOR_APP, string][]) {
    if (appDatatype !== datatype) continue;
    const appSink = await createAppSink(sql, source.workspaceId, source.id, app);
    if (appSink) sinks.push(appSink);
  }
  return sinks;
}

function defaultSinksFor(sql: postgres.Sql, source: ConnectorSourceRow, datatype: string): Promise<ExternalTriggerSink[]> {
  return connectorSinksFor(sql, source, datatype);
}

/**
 * Production `host.fetch`: the source must belong to this provider; the token is
 * that source's account's. Shared with outbound dispatch (D-014.4) so there is
 * one token path; a reconnect is a provider-declared `auth` failure here.
 */
function defaultHostFetchFor(provider: RegisteredProvider, sql: postgres.Sql, opts: ConnectorSyncOptions): HostFetch {
  return createSourceHostFetch(sql, {
    providerId: provider.descriptor.id,
    workspaceId: opts.workspaceId,
    harness: opts.harness,
    registry: providerRegistry(),
    reconnectRequired: (reason) => new ProviderSyncFailure({ kind: 'auth', message: reason }),
  });
}

async function syncSource(
  sql: postgres.Sql,
  provider: RegisteredProvider,
  source: ConnectorSourceRow,
  opts: Required<Pick<ConnectorSyncOptions, 'maxPagesPerSource' | 'leaseSeconds' | 'pollIntervalSeconds'>> & ConnectorSyncOptions,
  deps: {
    hostFetch: HostFetch;
    ingest: NonNullable<ConnectorSyncDeps['ingest']>;
    sinksFor: NonNullable<ConnectorSyncDeps['sinksFor']>;
    applyMembership: NonNullable<ConnectorSyncDeps['applyMembership']>;
    reconcileCoverage: NonNullable<ConnectorSyncDeps['reconcileCoverage']>;
    owner: string;
    services?: ProviderServices;
  },
): Promise<ConnectorSourceOutcome> {
  let mode: 'backfill' | 'incremental' = source.backfillStatus === 'complete' ? 'incremental' : 'backfill';
  const outcome: ConnectorSourceOutcome = {
    sourceId: source.id,
    providerId: provider.descriptor.id,
    outcome: 'synced',
    mode,
    pages: 0,
    admitted: 0,
    deduped: 0,
    rejected: 0,
    cursorReset: false,
    hasMore: false,
  };
  const passStartedAt = new Date();
  if (!(await acquireLease(sql, source, deps.owner, opts.leaseSeconds))) {
    return { ...outcome, outcome: 'leased-elsewhere' };
  }
  let cursor = providerCursorOf(source);
  const priorProgress = source.cursor.providerSync as { lossRisk?: ProviderLossRisk; catchUpFrom?: string } | undefined;
  let catchUpFrom = typeof priorProgress?.catchUpFrom === 'string' ? priorProgress.catchUpFrom : undefined;
  if (priorProgress && providerSyncProgressIssues(priorProgress).length === 0 && priorProgress.lossRisk) {
    outcome.lossRisk = priorProgress.lossRisk;
  }
  let working = source;
  const sinkCache = new Map<string, ExternalTriggerSink[]>();
  try {
    // D-020: a source a retired host path used to drive starts from that path's freshest
    // position, not from null (which would re-walk the whole history). A failure here fails
    // the pass and is retried; it never falls back to a null start.
    const prior = cursor === null && provider.descriptor.capabilities.includes(PROVIDER_SYNC_ADOPT_CAPABILITY)
      ? priorCursorStateOf(source)
      : null;
    if (prior) {
      const adopted = asAdoptResult(
        await provider.adapter.invoke(
          {
            source: source.id,
            capability: PROVIDER_SYNC_ADOPT_CAPABILITY,
            args: { prior },
            ...(deps.services ? { services: deps.services } : {}),
          },
          { fetch: deps.hostFetch },
        ),
        provider,
      );
      if (adopted.cursor !== null) {
        const backfillStatus = adopted.backfillComplete ? 'complete' : 'pending';
        if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, adopted.cursor, backfillStatus))) {
          return { ...outcome, outcome: 'leased-elsewhere' };
        }
        cursor = adopted.cursor;
        working = { ...working, cursor: { ...working.cursor, provider: cursor }, backfillStatus };
        mode = adopted.backfillComplete ? 'incremental' : 'backfill';
        outcome.mode = mode;
        outcome.adopted = true;
      }
    }
    while (outcome.pages < opts.maxPagesPerSource) {
      let page: ProviderSyncPage;
      try {
        page = await provider.adapter.syncPage(
          {
            source: source.id,
            cursor,
            mode,
            ...(catchUpFrom ? { catchUpFrom } : {}),
            ...(source.config ? { config: source.config } : {}),
            ...(deps.services ? { services: deps.services } : {}),
            ...(sourceScopeOf(source) ? { scope: sourceScopeOf(source)! } : {}),
          },
          { fetch: deps.hostFetch },
        );
        assertPage(page, provider);
      } catch (cause) {
        const failure = classifyProviderSyncError(cause);
        if (failure.kind === 'cursor-expired' && !outcome.cursorReset) {
          outcome.cursorReset = true;
          outcome.cursorResetReason = failure.message;
          catchUpFrom = cursor ?? undefined;
          cursor = null;
          mode = 'backfill';
          outcome.mode = mode;
          if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, null, 'pending', { catchUpFrom: catchUpFrom ?? null }))) {
            return { ...outcome, outcome: 'leased-elsewhere' };
          }
          working = { ...working, cursor: { ...working.cursor, provider: null }, backfillStatus: 'pending' };
          continue;
        }
        throw new ProviderSyncFailure(failure.kind === 'cursor-expired' ? { kind: 'transient', message: failure.message } : failure);
      }
      outcome.pages += 1;
      // Admit every record durably BEFORE the cursor that covers it is committed.
      for (const record of page.records) {
        const admission = await admitConnectorRecord(
          sql,
          { source: working, providerId: provider.descriptor.id, record },
          { ingest: deps.ingest, sinksFor: deps.sinksFor, sinkCache },
        );
        outcome[admission] += 1;
      }
      // A membership snapshot lands before the cursor that covers it commits; a full replace
      // is idempotent, so a replayed page converges (D-015.4).
      const declaredMembership = provider.descriptor.membership;
      if (page.membership && declaredMembership) {
        outcome.membership = await deps.applyMembership(sql, working, {
          identityProvider: declaredMembership.identityProvider,
          members: page.membership.members,
          ...(page.membership.containers ? { containers: page.membership.containers } : {}),
        });
      }
      // A coverage window names the complete live set the provider read; what is stored there and
      // absent was deleted while no live delete reached us. It applies after the page's records are
      // admitted and before the cursor covering it commits, so a replayed page converges.
      for (const window of page.coverage ?? []) {
        const reconciled = await deps.reconcileCoverage(sql, working, window);
        if (reconciled) outcome.coverageTombstoned = (outcome.coverageTombstoned ?? 0) + reconciled.tombstoned;
      }
      const backfillStatus = mode === 'backfill' ? (page.hasMore ? 'running' : 'complete') : 'complete';
      const progress = {
        ...(page.catchUp ? { catchUp: page.catchUp } : {}),
        ...(page.lossRisk ?? outcome.lossRisk ? { lossRisk: page.lossRisk ?? outcome.lossRisk } : {}),
        catchUpFrom: page.hasMore ? catchUpFrom ?? null : null,
      };
      if (!(await commitCursor(sql, working, deps.owner, opts.leaseSeconds, page.nextCursor, backfillStatus, progress))) {
        return { ...outcome, outcome: 'leased-elsewhere' };
      }
      if (page.catchUp) outcome.catchUp = page.catchUp;
      if (page.lossRisk) outcome.lossRisk = page.lossRisk;
      cursor = page.nextCursor;
      working = { ...working, cursor: { ...working.cursor, provider: cursor, providerSync: {
        ...(working.cursor.providerSync as object ?? {}), ...progress,
      } }, backfillStatus };
      outcome.hasMore = page.hasMore;
      if (!page.hasMore) break;
    }
    await finishPass(sql, working, deps.owner, {
      status: outcome.lossRisk ? 'degraded' : 'connected',
      // A later successful read cannot recover events the remote already discarded. Preserve the warning.
      lastError: outcome.lossRisk
        ? `connector_loss_risk:${outcome.lossRisk.kind}; oldest_reachable_at=${outcome.lossRisk.oldestReachableAt}; ${outcome.lossRisk.detail}`
        : outcome.rejected > 0 ? `connector_records_rejected:${outcome.rejected}` : null,
      failureCount: 0,
      // More pages pending → due again immediately; otherwise the poll cadence.
      nextAttemptSeconds: outcome.hasMore ? null : opts.pollIntervalSeconds,
      success: true,
      passStartedAt,
    });
    return outcome;
  } catch (cause) {
    const failure = classifyProviderSyncError(cause);
    const failureCount = working.failureCount + 1;
    if (failure.kind === 'auth') {
      await finishPass(sql, working, deps.owner, {
        status: 'error',
        lastError: `reconnect_required: ${failure.message}`,
        failureCount,
        nextAttemptSeconds: null,
        success: false,
        passStartedAt,
      });
      return { ...outcome, outcome: 'reconnect-required', error: failure.message };
    }
    if (failure.kind === 'rate-limited') {
      await finishPass(sql, working, deps.owner, {
        // A rate limit is the provider pacing us, not an unhealthy source.
        status: working.status === 'degraded' ? 'degraded' : 'connected',
        lastError: `rate_limited: ${failure.message}`,
        failureCount,
        nextAttemptSeconds: Math.ceil(failure.retryAfterSeconds ?? connectorBackoffSeconds(failureCount)),
        success: false,
        passStartedAt,
      });
      return { ...outcome, outcome: 'rate-limited', error: failure.message };
    }
    await finishPass(sql, working, deps.owner, {
      status: failureCount >= CONNECTOR_DEGRADED_AFTER_FAILURES ? 'degraded' : working.status,
      lastError: failure.message,
      failureCount,
      nextAttemptSeconds: connectorBackoffSeconds(failureCount),
      success: false,
      passStartedAt,
    });
    return { ...outcome, outcome: 'failed', error: failure.message };
  }
}

/**
 * One driver pass: every due source of every registered provider, each under
 * its own lease, bounded to `maxPagesPerSource` pages. Sources are independent;
 * one failing source never stops the others.
 */
export async function runConnectorSync(
  sql: postgres.Sql,
  opts: ConnectorSyncOptions,
  deps: ConnectorSyncDeps = {},
): Promise<ConnectorSyncResult> {
  // A pass that starts before this process's plugin discovery finishes would otherwise see no
  // plugin providers and skip (or fail) every Linear/Asana source (WI-10006703).
  const registry = deps.registry ?? (await readyProviderRegistry());
  const providers = registry.list();
  const byKind = new Map(providers.map((provider) => [provider.descriptor.id, provider]));
  const resolved = {
    ...opts,
    maxPagesPerSource: opts.maxPagesPerSource ?? DEFAULT_CONNECTOR_MAX_PAGES,
    leaseSeconds: opts.leaseSeconds ?? DEFAULT_CONNECTOR_LEASE_SECONDS,
    pollIntervalSeconds: opts.pollIntervalSeconds ?? DEFAULT_CONNECTOR_POLL_INTERVAL_SECONDS,
  };
  const owner = deps.leaseOwner ?? defaultLeaseOwner();
  const ingest = deps.ingest ?? ((db, input) => ingestExternalTriggerEvent(db, input));
  const sinksFor = deps.sinksFor ?? defaultSinksFor;
  const applyMembership = deps.applyMembership ?? defaultApplyMembership;
  const reconcileCoverage = deps.reconcileCoverage ?? defaultReconcileCoverage;
  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor;
  const sources = await listDueConnectorSources(sql, opts.workspaceId, [...byKind.keys()], opts.sourceIds);
  const servicesFor = deps.servicesFor ?? defaultServicesFor;
  const afterSourceSynced = deps.afterSourceSynced ?? defaultAfterSourceSynced;
  const fetchers = new Map<string, HostFetch>();
  const servicesByProvider = new Map<string, ProviderServices | undefined>();
  const outcomes: ConnectorSourceOutcome[] = [];
  for (const source of sources) {
    const provider = byKind.get(source.kind);
    if (!provider) continue;
    const missingConfig = missingRequiredJsonSchemaKeys(provider.descriptor.configSchema, source.config);
    if (missingConfig.length > 0) {
      outcomes.push({
        sourceId: source.id,
        providerId: provider.descriptor.id,
        outcome: 'needs-config',
        mode: source.backfillStatus === 'complete' ? 'incremental' : 'backfill',
        pages: 0,
        admitted: 0,
        deduped: 0,
        rejected: 0,
        cursorReset: false,
        hasMore: false,
        missingConfig,
      });
      continue;
    }
    let hostFetch = fetchers.get(provider.descriptor.id);
    if (!hostFetch) {
      hostFetch = hostFetchFor(provider, sql, opts);
      fetchers.set(provider.descriptor.id, hostFetch);
    }
    if (!servicesByProvider.has(provider.descriptor.id)) {
      servicesByProvider.set(provider.descriptor.id, await servicesFor(provider));
    }
    const services = servicesByProvider.get(provider.descriptor.id);
    const outcome = await syncSource(sql, provider, source, resolved, { hostFetch, ingest, sinksFor, applyMembership, reconcileCoverage, owner, services });
    if (outcome.outcome === 'synced') {
      try {
        await afterSourceSynced(sql, source);
      } catch (cause) {
        outcome.afterSyncError = cause instanceof Error ? cause.message : String(cause);
      }
    }
    outcomes.push(outcome);
  }
  return { providers: providers.length, sources: outcomes };
}

/* ─── Push wake (D-018.2) ─── */

export interface ConnectorWakeOutcome {
  sourceId: string;
  providerId: string;
  outcome: 'woken' | 'quiet' | 'failed';
  error?: string;
}

export interface ConnectorWakeResult {
  sources: ConnectorWakeOutcome[];
}

export interface ConnectorWakeDeps {
  registry?: ProviderRegistry;
  hostFetchFor?: ConnectorSyncDeps['hostFetchFor'];
  servicesFor?: ConnectorSyncDeps['servicesFor'];
}

function wakeStateOf(source: ConnectorSourceRow): string | null {
  const value = source.cursor?.wake;
  return typeof value === 'string' && value ? value : null;
}

function asWakeResult(value: unknown): ProviderWakeResult {
  const candidate = (value ?? {}) as { wake?: unknown; state?: unknown };
  if (typeof candidate.wake !== 'boolean') throw new Error('sync.wake returned no boolean `wake`');
  if (candidate.state !== undefined && candidate.state !== null && typeof candidate.state !== 'string') {
    throw new Error('sync.wake returned a non-string `state`');
  }
  return { wake: candidate.wake, state: candidate.state as string | null | undefined };
}

/**
 * Ask every provider that declares `sync.wake` whether each of its syncable
 * sources has remote changes, before the sync pass. Wake is only a doorbell:
 * a `wake: true` answer calls {@link wakeConnectorSource} and nothing else, and
 * the provider's opaque wake state is stored at `cursor.wake`. A failure is
 * reported per source and never fails the sync pass.
 */
export async function runConnectorWakes(
  sql: postgres.Sql,
  opts: Pick<ConnectorSyncOptions, 'workspaceId' | 'harness' | 'sourceIds'>,
  deps: ConnectorWakeDeps = {},
): Promise<ConnectorWakeResult> {
  const registry = deps.registry ?? providerRegistry();
  const wakers = registry
    .list()
    .filter((provider) => provider.descriptor.capabilities.includes(PROVIDER_SYNC_WAKE_CAPABILITY) && provider.adapter.invoke);
  if (wakers.length === 0) return { sources: [] };
  const byKind = new Map(wakers.map((provider) => [provider.descriptor.id, provider]));
  const hostFetchFor = deps.hostFetchFor ?? defaultHostFetchFor;
  const servicesFor = deps.servicesFor ?? defaultServicesFor;
  const sources = await sql<ConnectorSourceRow[]>`
    SELECT ${SOURCE_COLUMNS(sql)}
      FROM harness_shared.data_sources
     WHERE workspace_id = ${opts.workspaceId}
       AND kind = ANY(${sql.array([...byKind.keys()])}::text[])
       AND status = ANY(${sql.array([...CONNECTOR_SYNC_STATUSES])}::text[])
       ${opts.sourceIds ? sql`AND id::text = ANY(${sql.array([...opts.sourceIds])}::text[])` : sql``}
     ORDER BY id`;
  const outcomes: ConnectorWakeOutcome[] = [];
  const perProvider = new Map<string, { fetch: HostFetch; services: ProviderServices | undefined }>();
  for (const source of sources) {
    const provider = byKind.get(source.kind);
    if (!provider?.adapter.invoke) continue;
    let bound = perProvider.get(provider.descriptor.id);
    if (!bound) {
      bound = { fetch: hostFetchFor(provider, sql, opts as ConnectorSyncOptions), services: await servicesFor(provider) };
      perProvider.set(provider.descriptor.id, bound);
    }
    try {
      const result = asWakeResult(
        await provider.adapter.invoke(
          {
            source: source.id,
            capability: PROVIDER_SYNC_WAKE_CAPABILITY,
            args: { state: wakeStateOf(source) },
            ...(bound.services ? { services: bound.services } : {}),
          },
          { fetch: bound.fetch },
        ),
      );
      if (result.state !== undefined && result.state !== wakeStateOf(source)) {
        await sql`
          UPDATE harness_shared.data_sources
             SET cursor = jsonb_set(COALESCE(cursor, '{}'::jsonb), '{wake}', ${jsonText(result.state ?? null)}::text::jsonb),
                 updated_at = now()
           WHERE workspace_id = ${source.workspaceId}
             AND id = ${source.id}::uuid`;
      }
      if (result.wake) await wakeConnectorSource(sql, { workspaceId: source.workspaceId, sourceId: source.id });
      outcomes.push({ sourceId: source.id, providerId: provider.descriptor.id, outcome: result.wake ? 'woken' : 'quiet' });
    } catch (cause) {
      outcomes.push({
        sourceId: source.id,
        providerId: provider.descriptor.id,
        outcome: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { sources: outcomes };
}

export function formatConnectorWakeLog(result: ConnectorWakeResult): string {
  const count = (kind: ConnectorWakeOutcome['outcome']) => result.sources.filter((s) => s.outcome === kind).length;
  const failures = result.sources
    .filter((s) => s.outcome === 'failed')
    .map((s) => `${s.sourceId}: ${s.error}`)
    .join('; ');
  return `[connector-wake] sources=${result.sources.length} woken=${count('woken')} quiet=${count('quiet')} failed=${count('failed')}${failures ? ` errors=${failures}` : ''}`;
}

export function formatConnectorSyncLog(result: ConnectorSyncResult): string {
  const count = (kind: ConnectorSourceOutcomeKind) => result.sources.filter((s) => s.outcome === kind).length;
  const admitted = result.sources.reduce((n, s) => n + s.admitted, 0);
  const resets = result.sources.filter((s) => s.cursorReset);
  const resetReasons = resets.map((s) => `${s.sourceId}: ${s.cursorResetReason ?? 'unknown'}`).join('; ');
  return (
    `[connector-sync] providers=${result.providers} sources=${result.sources.length} synced=${count('synced')} `
    + `rate_limited=${count('rate-limited')} failed=${count('failed')} reconnect=${count('reconnect-required')} `
    + `needs_config=${count('needs-config')} `
    + `leased_elsewhere=${count('leased-elsewhere')} admitted=${admitted} cursor_resets=${resets.length}`
    + (resetReasons ? ` reset_reasons=${resetReasons}` : '')
  );
}
