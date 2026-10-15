/**
 * Organization data receipts: export, deletion and restore over the declared store population
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-007, child P-007c
 * WI-6554700010011593; decisions D-012 and D-014; cloud-portal-public-release-2026-10-13 D-005).
 *
 * There is ONE receipt writer, `writeOrganizationDataReceipt`. Every export, deletion or restore
 * of an organization's data records a row in papercusp_auth.organization_audit_events through
 * governance.ts `appendOrganizationAuditEvent`, so the metadata passes
 * `assertGovernancePayloadSafe`. No new table. cloud-portal#P-010 (WI-6554700010011223) builds the
 * self-service surface and the hosted control-plane executor and must write its receipts through
 * this function. It must not add a second writer.
 *
 * The population is `pilotStorePopulation()`: every pilot-map store plus every hosted customer-data
 * table. `planOrganizationDataOperation` gives each store a treatment:
 *  - attribution: how a row belongs to the organization. Pilot data-plane stores are attributed by
 *    `workspace_id` to the workspaces the caller declares for the organization. Hosted tables follow
 *    their `organizationLink` in auth/hosted/customer-data-map.ts.
 *  - executor: `pilot-data-plane` stores are executed here. `hosted-control-plane` stores need the
 *    hosted service context and row-level security, so this module records them as `deferred` with
 *    that executor's owner. cloud-portal#P-010 runs them and reports outcomes to the same writer.
 *  - export columns: every column except secret-class ones. A hosted table drops its map `secret`
 *    class. A pilot store drops its declared access columns and any column whose name looks like
 *    access material, checked against the live schema at export time.
 *  - deletion: decided by retention class. Account, ephemeral and source-mirrored rows are deleted.
 *    Legal-hold-aware rows are deleted unless an active `data_source_legal_holds` hold covers them.
 *    Audit, billing-record, consent-proof, abuse-prevention and provider-ledger rows are retained, and
 *    the receipt gives the reason.
 *
 * Restore: a restore brings back revocations made after the backup point.
 * `reconcileRestoredAccess` re-applies the revocations the caller names. It then checks that no
 * organization document is still readable through each revoked identity, and records a restore
 * receipt.
 *
 * Restore and legal holds (P-017d): a restore replaces the database files from a snapshot, so the
 * row-level hold triggers do not run during it. It can overwrite a held row with its backup-point
 * version and remove held rows written after that point, and it undoes holds placed or released
 * after it. Rows under a hold that is active in the restored database are protected again the moment
 * the restore finishes, by the same triggers. `reconcileRestoredAccess` re-applies the hold changes
 * the caller names (with their original ids and times), compares each held content the caller
 * exported before the restore (`exportLegalHoldContent` digest) with what the restore left, and
 * records both in the receipt. The documented restore (packages/backup/scripts/restore-pg-dump.sh)
 * loads the dump into a NEW database, so the database it replaces still has the held rows, kept by
 * the hold triggers. Given that database as `preRestoreSource`, reconciliation copies a mismatched
 * hold's rows back from it before comparing. Without it, a mismatch is recorded, not repaired, and
 * the pre-restore export is the copy of record.
 *
 * Metadata keys never name a store or column. Names like `hosted_cli_tokens` would trip the
 * forbidden-key rule in `assertGovernancePayloadSafe`. Stores and columns are always values.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  appendOrganizationAuditEvent,
  type GovernanceJson,
  type OrganizationAuditEventInput,
} from '../auth/hosted/governance';
import { CUSTOMER_DATA_CLASSES, customerDataTable } from '../auth/hosted/customer-data-map';
import type { HostedPermission, HostedPrincipal } from '../auth/hosted-principal';
import { getBuildInfo } from '../build-info';
import { placeLegalHold, releaseLegalHold } from '../data-sources/chat-retrieval-units';
import { revokeProviderIdentityMapping } from '../data-sources/documents-corpus';
import { pilotStorePopulation, type PilotRetention, type PopulationEntry } from './pilot-processing-map';

export const ORGANIZATION_DATA_RECEIPT_VERSION = 'organization-data-receipt-v1';

/**
 * Store operations act on the declared population. Key operations (P-016b, D-020 item 6) act on the
 * organization's envelope keys (data-governance/organization-keys.ts): they touch no store rows,
 * carry `stores: []` and a `keyLifecycle` block instead.
 */
export const KEY_OPERATIONS = ['key-provisioning', 'key-rotation', 'key-revocation', 'key-recovery', 'key-shred'] as const;
export type KeyOperation = (typeof KEY_OPERATIONS)[number];
export type DataOperation = 'export' | 'deletion' | 'restore' | KeyOperation;

export function isKeyOperation(operation: DataOperation): operation is KeyOperation {
  return (KEY_OPERATIONS as readonly string[]).includes(operation);
}

export const RECEIPT_ACTIONS: Readonly<Record<DataOperation, string>> = {
  export: 'organization.data.export',
  deletion: 'organization.data.deletion',
  restore: 'organization.data.restore',
  'key-provisioning': 'organization.keys.provisioning',
  'key-rotation': 'organization.keys.rotation',
  'key-revocation': 'organization.keys.revocation',
  'key-recovery': 'organization.keys.recovery',
  'key-shred': 'organization.keys.shred',
};

/** Permission a customer user needs for each operation (owner/admin hold both; member/billing neither). */
export const OPERATION_PERMISSION: Readonly<Record<DataOperation, HostedPermission>> = {
  export: 'members:manage',
  deletion: 'workspace:destroy',
  restore: 'workspace:destroy',
  'key-provisioning': 'workspace:destroy',
  'key-rotation': 'workspace:destroy',
  'key-revocation': 'workspace:destroy',
  'key-recovery': 'workspace:destroy',
  'key-shred': 'workspace:destroy',
};

/** What a key operation did. Never carries key material: references, versions and states only. */
export interface KeyLifecycleRecord {
  readonly event: 'provisioned' | 'kek-rotated' | 'dek-rotated' | 'revoked' | 'recovered' | 'shredded';
  readonly kekProvider: string;
  readonly kekRef: string;
  readonly kekGeneration: number;
  readonly activeDekVersion: number;
  /** DEK versions the operation re-wrapped, created, or shredded. */
  readonly dekVersions: readonly number[];
  /** Custody state after the operation. */
  readonly custodyState: 'enabled' | 'revoked' | 'shredded';
  /** For a KEK rotation: the KEK it replaced. */
  readonly previousKekRef?: string;
  /** What the KMS reported about the KEK when the operation ran. */
  readonly kmsState?: string;
}

export type Executor = 'pilot-data-plane' | 'hosted-control-plane';

/** Owner of the hosted control-plane executor. Its outcomes go to the same writer. */
export const HOSTED_EXECUTOR_OWNER = 'cloud-portal-public-release-2026-10-13#P-010 (WI-6554700010011223)';

export type Attribution =
  | { readonly kind: 'workspace'; readonly column: 'workspace_id' }
  | { readonly kind: 'organization-column'; readonly column: string }
  | { readonly kind: 'user-membership'; readonly column: string }
  | { readonly kind: 'join'; readonly column: string; readonly target: string }
  | { readonly kind: 'unattributable'; readonly note: string };

export type DeletionAction = 'delete' | 'delete-unless-held' | 'retain' | 'not-attributable';

export interface StoreTreatment {
  readonly store: string;
  readonly source: PopulationEntry['source'];
  readonly retention: PilotRetention;
  readonly executor: Executor;
  readonly attribution: Attribution;
  /** Columns exported, when known from the code map; null for pilot stores (resolved from the live schema). */
  readonly exportColumns: readonly string[] | null;
  /** Secret-class columns that are never exported. */
  readonly excludedColumns: readonly string[];
  readonly deletion: { readonly action: DeletionAction; readonly reason: string };
}

/**
 * Access-material columns of pilot-map stores, which the hosted map does not classify.
 * Never exported. The integration test pins every name to the live schema.
 */
export const PILOT_STORE_ACCESS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'harness_shared.data_sources': ['credential_ref'],
  'harness_shared.trigger_webhook_secrets': ['secret_ct', 'previous_secret_ct'],
  'harness_shared.connector_push_secrets': ['secret_ct'],
};

/**
 * Fail-closed backstop: a live column whose name looks like access material is never exported.
 * Narrow on purpose: `content_hash` and `input_tokens` are content and usage, not access material.
 */
export const ACCESS_SHAPED_COLUMN =
  /(?:password|passcode|secret|credential|authorization|cookie|private[_-]?key|api[_-]?key|(?:^|_)token(?:_hash)?$|(?:access|refresh|bearer|session|id)_token|(?:code|token|key|pin)_hash$)/i;

const DELETION_BY_RETENTION: Readonly<Record<PilotRetention, { action: DeletionAction; reason: string }>> = {
  account: { action: 'delete', reason: 'Lives with the account; removed on organization deletion.' },
  ephemeral: { action: 'delete', reason: 'Short-lived access or handshake state.' },
  'source-mirrored': { action: 'delete', reason: 'Copy of organization source content.' },
  'legal-hold-aware-ttl': {
    action: 'delete-unless-held',
    reason: 'Deleted except rows under an active data_source_legal_holds hold, which are named as hold conflicts.',
  },
  audit: { action: 'retain', reason: 'Audit trail is retained after deletion; receipts are themselves audit rows.' },
  'billing-record': { action: 'retain', reason: 'Financial record; retention may be required by law after account deletion.' },
  'consent-proof': { action: 'retain', reason: 'Proof of terms and privacy acceptance must remain producible.' },
  'abuse-prevention': { action: 'retain', reason: 'Abuse-prevention ledger outlives the account by design.' },
  'provider-ledger': { action: 'retain', reason: 'Provider ledger expires by its own retention policy.' },
  'legacy-empty': { action: 'retain', reason: 'Legacy pre-hosted table, empty in production and not attributable.' },
};

/** Stores whose deletion must skip rows covered by an active legal hold, and the predicate that keeps them. */
const HOLD_GUARDS: Readonly<Record<string, string>> = {
  'harness_shared.chat_messages':
    'NOT harness_shared.chat_message_under_hold(t.workspace_id, t.data_source_id, t.channel_id)',
  'harness_shared.chat_retrieval_units':
    'NOT harness_shared.chat_message_under_hold(t.workspace_id, t.data_source_id, t.channel_id)',
  // Any hold row, released or not: holds are retained audit rows and reference their source ON DELETE RESTRICT.
  'harness_shared.data_sources': `NOT EXISTS (SELECT 1 FROM harness_shared.data_source_legal_holds h
      WHERE h.workspace_id = t.workspace_id AND h.data_source_id = t.id)`,
  // Migration 1502: the documents trigger refuses to delete a held document, so the deletion skips it.
  'harness_shared.documents':
    'NOT harness_shared.document_under_hold(t.workspace_id, t.source_id, t.kind, t.metadata, t.permission_list_id)',
  // A held document keeps its access list: the list (documents reference it ON DELETE RESTRICT) and its members.
  'harness_shared.document_permission_lists': `NOT EXISTS (SELECT 1 FROM harness_shared.documents d
      WHERE d.workspace_id = t.workspace_id AND d.permission_list_id = t.id
        AND harness_shared.document_under_hold(d.workspace_id, d.source_id, d.kind, d.metadata, d.permission_list_id))`,
  'harness_shared.document_permission_members': `NOT EXISTS (SELECT 1 FROM harness_shared.documents d
      WHERE d.workspace_id = t.workspace_id AND d.permission_list_id = t.list_id
        AND harness_shared.document_under_hold(d.workspace_id, d.source_id, d.kind, d.metadata, d.permission_list_id))`,
};

/**
 * FK descendants of data_sources, deleted first and in THIS order (a child before its parent).
 * trigger_runs references trigger_bindings and trigger_deliveries ON DELETE RESTRICT, and those two
 * reference their source ON DELETE RESTRICT; the rest cascade, and deleting them explicitly is what
 * lets the receipt count their rows. The integration test keeps this list equal to the live FK
 * closure below data_sources.
 */
export const DATA_SOURCE_DEPENDENTS: readonly string[] = [
  'harness_shared.trigger_runs',
  'harness_shared.trigger_deliveries',
  'harness_shared.trigger_bindings',
  'harness_shared.trigger_webhook_secrets',
  'harness_shared.connector_push_secrets',
  'harness_shared.admission_rules',
  'harness_shared.chat_bug_suggestions',
  'harness_shared.chat_rollup_queue',
];

/** Deleted last, in this order: parents of other population rows (documents reference lists ON DELETE RESTRICT). */
const DELETE_LAST: readonly string[] = ['harness_shared.document_permission_lists', 'harness_shared.data_sources'];

/**
 * Deletion order: data-source dependents in DATA_SOURCE_DEPENDENTS order, then the rest in plan
 * order, then DELETE_LAST in its own order.
 */
export function deletionOrder(plan: readonly StoreTreatment[]): readonly StoreTreatment[] {
  const last = (store: string) => DELETE_LAST.indexOf(store);
  const rank = (store: string) => DATA_SOURCE_DEPENDENTS.indexOf(store);
  const dependent = (store: string) => rank(store) >= 0;
  return [
    ...plan.filter((p) => dependent(p.store)).sort((a, b) => rank(a.store) - rank(b.store)),
    ...plan.filter((p) => !dependent(p.store) && last(p.store) < 0),
    ...plan.filter((p) => last(p.store) >= 0).sort((a, b) => last(a.store) - last(b.store)),
  ];
}

function schemaOf(store: string): string {
  return store.slice(0, store.indexOf('.'));
}

function treatmentFor(entry: PopulationEntry): StoreTreatment {
  const hosted = customerDataTable(entry.qualified);
  if (entry.source === 'pilot-map' && schemaOf(entry.qualified) === 'harness_shared' && !hosted) {
    const hasHoldGuard = entry.qualified in HOLD_GUARDS;
    const base = DELETION_BY_RETENTION[entry.retention];
    return {
      store: entry.qualified,
      source: entry.source,
      retention: entry.retention,
      executor: 'pilot-data-plane',
      attribution: { kind: 'workspace', column: 'workspace_id' },
      exportColumns: null,
      excludedColumns: PILOT_STORE_ACCESS_COLUMNS[entry.qualified] ?? [],
      deletion: hasHoldGuard && base.action === 'delete'
        ? { action: 'delete-unless-held', reason: `${base.reason} Rows covered by a legal hold are kept.` }
        : base,
    };
  }
  if (!hosted) throw new Error(`organization-data-receipts: ${entry.qualified} is in the population but in neither map`);
  const link = hosted.organizationLink;
  const attribution: Attribution =
    link.via === 'column' ? { kind: 'organization-column', column: link.column }
      : link.via === 'user' ? { kind: 'user-membership', column: link.column }
        : link.via === 'join' ? { kind: 'join', column: link.column, target: link.target }
          : { kind: 'unattributable', note: link.note };
  // The map's `secret` class, plus any column whose name is access-shaped (e.g. a credential reference
  // the map classes as operational): the same fail-closed rule pilot stores get.
  // Every class except `secret`, enumerated from the vocabulary so a new class can never fall
  // out of export silently (P-016a added `customer-content`).
  const mapped = CUSTOMER_DATA_CLASSES.filter((cls) => cls !== 'secret').flatMap((cls) => hosted.columns[cls]);
  const excludedColumns = [...hosted.columns.secret, ...mapped.filter((c) => ACCESS_SHAPED_COLUMN.test(c))];
  return {
    store: entry.qualified,
    source: entry.source,
    retention: entry.retention,
    executor: 'hosted-control-plane',
    attribution,
    exportColumns: mapped.filter((c) => !excludedColumns.includes(c)),
    excludedColumns,
    deletion: attribution.kind === 'unattributable'
      ? { action: 'not-attributable', reason: `Not attributable to one organization: ${link.via === 'none' ? link.note : ''}` }
      : DELETION_BY_RETENTION[entry.retention],
  };
}

/** One treatment per store of the declared population, in population order. */
export function planOrganizationDataOperation(
  population: readonly PopulationEntry[] = pilotStorePopulation(),
): readonly StoreTreatment[] {
  return population.map(treatmentFor);
}

// ── Scope, actor and authorization ────────────────────────────────────────────

export interface OrganizationDataScope {
  readonly organizationId: string;
  /** Export only this person's records within the organization when present. */
  readonly userId?: string;
  /** Pilot data-plane workspaces the organization owns. Declared by the caller and recorded in the receipt. */
  readonly workspaceIds: readonly string[];
}

export type ReceiptActor =
  | { readonly kind: 'customer_user'; readonly principal: HostedPrincipal }
  | { readonly kind: 'staff_admin' | 'system'; readonly id: string };

function nonEmpty(value: string, label: string): string {
  const v = value?.trim();
  if (!v) throw new Error(`organization-data-receipts: ${label} must be non-empty`);
  return v;
}

/** Refuses an actor who may not run `operation` on `organizationId`. Returns the audit actor fields. */
export function authorizeDataOperation(
  operation: DataOperation,
  organizationId: string,
  actor: ReceiptActor,
  userId?: string,
): { actorKind: OrganizationAuditEventInput['actorKind']; actorId: string } {
  if (actor.kind === 'customer_user') {
    const p = actor.principal;
    if (p.activeOrganizationId !== organizationId) {
      throw new Error('organization-data-receipts: actor is not acting in this organization');
    }
    const needed = operation === 'export' && userId === p.userId ? 'workspace:view' : OPERATION_PERMISSION[operation];
    if (!p.permissions.has(needed)) {
      throw new Error(`organization-data-receipts: ${operation} requires ${needed}`);
    }
    return { actorKind: 'customer_user', actorId: p.userId };
  }
  return { actorKind: actor.kind, actorId: nonEmpty(actor.id, 'actor id') };
}

export function validateScope(scope: OrganizationDataScope, allowEmptyWorkspaces = false): OrganizationDataScope {
  const workspaceIds = [...new Set(scope.workspaceIds.map((w) => nonEmpty(w, 'workspaceId')))];
  if (!workspaceIds.length && !allowEmptyWorkspaces) throw new Error('organization-data-receipts: at least one workspaceId is required');
  return { organizationId: nonEmpty(scope.organizationId, 'organizationId'), workspaceIds,
    ...(scope.userId === undefined ? {} : { userId: nonEmpty(scope.userId, 'userId') }) };
}

// ── The receipt and its single writer ─────────────────────────────────────────

export type StoreOutcome = 'exported' | 'deleted' | 'redacted' | 'retained' | 'verified' | 'deferred' | 'not-attributable' | 'failed';

export interface StoreReceipt {
  readonly store: string;
  readonly executor: Executor;
  readonly retention: PilotRetention;
  readonly outcome: StoreOutcome;
  /** Rows exported, deleted or found after restore; null when the store was not executed. */
  readonly rowCount: number | null;
  /** Rows the operation left in place (retained by class, or kept under a hold). */
  readonly rowsRemaining: number | null;
  readonly exportedColumns: readonly string[] | null;
  readonly excludedColumns: readonly string[];
  readonly reason: string | null;
}

export interface HoldConflict {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly dataSourceId: string;
  readonly channelId: string | null;
  readonly placedAt: string;
  /** Rows kept because of this hold, per store. */
  readonly retained: readonly { readonly store: string; readonly rows: number }[];
}

export interface RevocationCheck {
  readonly workspaceId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly mappingsRevoked: number;
  /** Organization documents still readable through this identity after reconciliation. Must be 0. */
  readonly readableDocuments: number;
  readonly denied: boolean;
}

/** A legal-hold change made after the backup point, as restore reconciliation re-applied it. */
export interface HoldChangeCheck {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly change: 'place' | 'release';
  /** 'reapplied' = the restored database lacked the change; 'present' = it already had it. */
  readonly applied: 'reapplied' | 'present';
  /** Whether the hold is active after reconciliation. */
  readonly active: boolean;
}

/** One hold's content after the restore, compared with the digest of an export taken before it. */
export interface HeldContentCheck {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly expectedDigest: string;
  /** Digest of what the hold keeps after the restore; null when the restored database has no such hold. */
  readonly restoredDigest: string | null;
  readonly matchesExport: boolean;
  /**
   * Rows copied back from the pre-restore database (inserted, or reset to their pre-restore values)
   * before `restoredDigest` was taken. null = no repair was attempted: the content matched, no
   * pre-restore source was given, or the hold is not active in the restored database.
   */
  readonly repairedRows: number | null;
}

export interface OrganizationDataReceipt {
  readonly operation: DataOperation;
  /** Durable workflow identity; permits transactional deletion-receipt replay. */
  readonly operationId?: string;
  /** Hosted account exports also cover organizations that have not created a workspace. */
  readonly executor?: Executor;
  readonly scope: OrganizationDataScope;
  readonly purpose: string;
  readonly stores: readonly StoreReceipt[];
  readonly holdConflicts?: readonly HoldConflict[];
  readonly revocations?: readonly RevocationCheck[];
  readonly holdChanges?: readonly HoldChangeCheck[];
  readonly heldContent?: readonly HeldContentCheck[];
  /** Required on, and only on, a key operation. */
  readonly keyLifecycle?: KeyLifecycleRecord;
  readonly limitations: readonly string[];
  /** Latest applied migration seen by the executor, when it could be read. */
  readonly schemaVersion: string | null;
  readonly occurredAt?: Date;
}

const BASE_LIMITATIONS: readonly string[] = [
  `Hosted control-plane stores are deferred to ${HOSTED_EXECUTOR_OWNER}; their outcomes are recorded through this same writer.`,
  'The organization-to-workspace binding is declared by the caller and recorded in scope; it is not derived from a stored field.',
];

/** The receipt as audit metadata. Stores and columns are values, never keys. */
export function receiptMetadata(receipt: OrganizationDataReceipt, codeVersion: string): Record<string, GovernanceJson> {
  const meta: Record<string, GovernanceJson> = {
    receiptVersion: ORGANIZATION_DATA_RECEIPT_VERSION,
    operation: receipt.operation,
    workspaceIds: [...receipt.scope.workspaceIds],
    populationSize: receipt.stores.length,
    stores: receipt.stores.map((s) => ({
      store: s.store,
      executor: s.executor,
      retention: s.retention,
      outcome: s.outcome,
      rowCount: s.rowCount,
      rowsRemaining: s.rowsRemaining,
      exportedColumns: s.exportedColumns ? [...s.exportedColumns] : null,
      excludedColumns: [...s.excludedColumns],
      reason: s.reason,
    })),
    limitations: [...receipt.limitations],
    codeVersion,
    schemaVersion: receipt.schemaVersion,
  };
  if (receipt.executor) meta.executor = receipt.executor;
  if (receipt.operationId) meta.operationId = nonEmpty(receipt.operationId, 'operationId');
  if (receipt.scope.userId) meta.userId = receipt.scope.userId;
  if (receipt.holdConflicts) {
    meta.holdConflicts = receipt.holdConflicts.map((h) => ({
      holdId: h.holdId, workspaceId: h.workspaceId, dataSourceId: h.dataSourceId, channelId: h.channelId,
      placedAt: h.placedAt, retained: h.retained.map((r) => ({ store: r.store, rows: r.rows })),
    }));
  }
  if (receipt.revocations) {
    meta.revocations = receipt.revocations.map((r) => ({
      workspaceId: r.workspaceId, provider: r.provider, providerUserId: r.providerUserId,
      mappingsRevoked: r.mappingsRevoked, readableDocuments: r.readableDocuments, denied: r.denied,
    }));
  }
  if (receipt.holdChanges) {
    meta.holdChanges = receipt.holdChanges.map((h) => ({
      holdId: h.holdId, workspaceId: h.workspaceId, change: h.change, applied: h.applied, active: h.active,
    }));
  }
  if (receipt.heldContent) {
    meta.heldContent = receipt.heldContent.map((h) => ({
      holdId: h.holdId, workspaceId: h.workspaceId, expectedDigest: h.expectedDigest,
      restoredDigest: h.restoredDigest, matchesExport: h.matchesExport, repairedRows: h.repairedRows,
    }));
  }
  if (receipt.keyLifecycle) {
    const k = receipt.keyLifecycle;
    meta.keyLifecycle = {
      event: k.event, kekProvider: k.kekProvider, kekRef: k.kekRef, kekGeneration: k.kekGeneration,
      activeDekVersion: k.activeDekVersion, dekVersions: [...k.dekVersions], custodyState: k.custodyState,
      previousKekRef: k.previousKekRef ?? null, kmsState: k.kmsState ?? null,
    };
  }
  return meta;
}

/**
 * THE receipt writer. Validates the receipt covers the declared population, then appends one
 * organization audit event. Returns its id. Pass `transaction` to commit with the operation.
 */
export async function writeOrganizationDataReceipt(
  receipt: OrganizationDataReceipt,
  actor: ReceiptActor,
  transaction?: Sql,
): Promise<string> {
  const scope = validateScope(receipt.scope, receipt.executor === 'hosted-control-plane');
  const auth = authorizeDataOperation(receipt.operation, scope.organizationId, actor, scope.userId);
  if (isKeyOperation(receipt.operation)) {
    // A key operation touches no store rows. It must say what it did to the keys instead.
    if (!receipt.keyLifecycle) throw new Error(`organization-data-receipts: ${receipt.operation} receipt requires keyLifecycle`);
    if (receipt.stores.length) throw new Error(`organization-data-receipts: ${receipt.operation} receipt must not list stores`);
  } else {
    if (receipt.keyLifecycle) throw new Error(`organization-data-receipts: ${receipt.operation} receipt must not carry keyLifecycle`);
    const declared = new Set(planOrganizationDataOperation().map((t) => t.store));
    const covered = new Set(receipt.stores.map((s) => s.store));
    const missing = [...declared].filter((s) => !covered.has(s));
    const extra = [...covered].filter((s) => !declared.has(s));
    if (missing.length || extra.length) {
      throw new Error(`organization-data-receipts: receipt does not cover the declared population (missing ${missing.join(', ') || 'none'}; undeclared ${extra.join(', ') || 'none'})`);
    }
  }
  if (receipt.operation === 'export') {
    for (const s of receipt.stores) {
      const leaked = (s.exportedColumns ?? []).filter((c) => s.excludedColumns.includes(c) || ACCESS_SHAPED_COLUMN.test(c));
      if (leaked.length) throw new Error(`organization-data-receipts: ${s.store} export lists excluded columns ${leaked.join(', ')}`);
    }
  }
  return appendOrganizationAuditEvent({
    organizationId: scope.organizationId,
    actorKind: auth.actorKind,
    actorId: auth.actorId,
    action: RECEIPT_ACTIONS[receipt.operation],
    purpose: nonEmpty(receipt.purpose, 'purpose'),
    targetType: 'organization',
    targetId: scope.organizationId,
    metadata: receiptMetadata({ ...receipt, scope }, getBuildInfo().sha ?? 'unknown'),
    occurredAt: receipt.occurredAt,
  }, transaction);
}

// ── Pilot data-plane executor ─────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/;

function quoted(store: string): string {
  const [schema, table] = store.split('.');
  if (!schema || !table || !IDENT.test(schema) || !IDENT.test(table)) {
    throw new Error(`organization-data-receipts: unsafe store name ${store}`);
  }
  return `"${schema}"."${table}"`;
}

async function liveColumns(sql: Sql, store: string): Promise<string[]> {
  const [schema, table] = store.split('.');
  const rows = await sql<{ column_name: string }[]>`
    SELECT a.attname AS column_name FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema!} AND c.relname = ${table!}
       AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  return rows.map((r) => r.column_name);
}

export async function readSchemaVersion(sql: Sql): Promise<string | null> {
  // A permission error aborts a Postgres transaction even if JS catches it.
  // Schema provenance is optional; inspect access before issuing the query.
  const [access] = await sql<{ readable: boolean | null }[]>`
    SELECT has_table_privilege(to_regclass('harness_shared.schema_migrations'), 'SELECT') AS readable`;
  if (!access?.readable) return null;
  const rows = await sql<{ v: string | null }[]>`SELECT max(filename) AS v FROM harness_shared.schema_migrations`;
  return rows[0]?.v ?? null;
}

function deferred(t: StoreTreatment, operation: DataOperation): StoreReceipt {
  const notAttributable = t.attribution.kind === 'unattributable';
  return {
    store: t.store, executor: t.executor, retention: t.retention,
    outcome: notAttributable ? 'not-attributable' : 'deferred',
    rowCount: null, rowsRemaining: null,
    exportedColumns: operation === 'export' ? t.exportColumns : null,
    excludedColumns: t.excludedColumns,
    reason: notAttributable ? t.deletion.reason : `Executed by ${HOSTED_EXECUTOR_OWNER}.`,
  };
}

export interface OrganizationDataExport {
  readonly receiptId: string;
  readonly stores: readonly { readonly store: string; readonly columns: readonly string[]; readonly rows: readonly Record<string, unknown>[] }[];
}

/** Fixed bridge population from migration 1509; never arbitrary SQL or a role grant. */
export const HOSTED_EXPORT_BRIDGED_STORES: readonly string[] = [
  'harness_shared.customer_workspaces', 'papercusp_auth.organization_audit_events',
  'papercusp_auth.legal_acceptances', 'papercusp_auth.support_access_grants',
  'papercusp_auth.hosted_user_preferences',
];

/** Follow the code-owned attribution map, including the sealed-session join.
 * Both UUID and text organization/user columns exist in the hosted schema.
 * Only mapped identifiers enter the statement; the organization is a bound value.
 */
function hostedOrganizationPredicate(store: string, alias = 't', seen = new Set<string>()): string {
  const table = customerDataTable(store);
  if (!table || seen.has(store)) throw new Error(`organization-data-receipts: invalid attribution for ${store}`);
  const link = table.organizationLink;
  const column = (name: string) => {
    if (!IDENT.test(name)) throw new Error('organization-data-receipts: unsafe attribution column');
    return `${alias}."${name}"`;
  };
  if (link.via === 'column') return `${column(link.column)}::text = $1::text`;
  if (link.via === 'user') return `EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m
    WHERE m.user_id::text = ${column(link.column)}::text AND m.organization_id::text = $1::text)`;
  if (link.via !== 'join') throw new Error(`organization-data-receipts: unattributable store ${store}`);
  const [schema, targetTable, targetColumn, extra] = link.target.split('.');
  if (!schema || !targetTable || !targetColumn || extra || !IDENT.test(targetColumn)) {
    throw new Error('organization-data-receipts: unsafe attribution target');
  }
  const target = `${schema}.${targetTable}`;
  const nextAlias = `${alias}_parent`;
  return `EXISTS (SELECT 1 FROM ${quoted(target)} ${nextAlias}
    WHERE ${nextAlias}."${targetColumn}"::text = ${column(link.column)}::text
      AND (${hostedOrganizationPredicate(target, nextAlias, new Set([...seen, store]))}))`;
}

/** Incidental creator/approver ids do not make an organization's record personal. */
function hostedUserPredicate(store: string, alias = 't', seen = new Set<string>()): string | null {
  const table = customerDataTable(store);
  if (!table || seen.has(store)) throw new Error(`organization-data-receipts: invalid user attribution for ${store}`);
  const link = table.organizationLink;
  const userColumn = link.via === 'user' ? link.column
    : Object.values(table.columns).flat().includes('user_id') ? 'user_id' : null;
  if (userColumn) {
    if (!IDENT.test(userColumn)) throw new Error('organization-data-receipts: unsafe user column');
    return `${alias}."${userColumn}"::text = $2::text`;
  }
  if (link.via !== 'join') return null;
  const [schema, targetTable, targetColumn] = link.target.split('.');
  const target = `${schema}.${targetTable}`;
  const parent = `${alias}_user_parent`;
  const predicate = hostedUserPredicate(target, parent, new Set([...seen, store]));
  if (!predicate) return null;
  if (!IDENT.test(link.column) || !targetColumn || !IDENT.test(targetColumn)) {
    throw new Error('organization-data-receipts: unsafe user join');
  }
  return `EXISTS (SELECT 1 FROM ${quoted(target)} ${parent} WHERE
    ${parent}."${targetColumn}"::text = ${alias}."${link.column}"::text AND (${predicate}))`;
}

/**
 * Export stores for one executor without secret-class columns and write the shared receipt
 * atomically. The default remains the pilot data plane. P-010's hosted executor derives
 * workspace ownership from the database and follows every mapped account attribution.
 */
export async function exportOrganizationData(
  sql: Sql,
  input: { scope: OrganizationDataScope; actor: ReceiptActor; purpose: string; executor?: Executor; hostedReadBridge?: boolean },
  transaction?: Sql,
): Promise<OrganizationDataExport> {
  const executor = input.executor ?? 'pilot-data-plane';
  const requestedScope = validateScope(input.scope, executor === 'hosted-control-plane');
  authorizeDataOperation('export', requestedScope.organizationId, input.actor, requestedScope.userId);
  if (requestedScope.userId && executor !== 'hosted-control-plane') {
    throw new Error('organization-data-receipts: user export requires the hosted executor');
  }
  const execute = async (t: Sql): Promise<OrganizationDataExport> => {
    const owned = executor === 'hosted-control-plane'
      ? input.hostedReadBridge
        ? await t<{ id: string }[]>`SELECT data->>'id' AS id FROM
            papercusp_auth.read_hosted_customer_export_rows('harness_shared.customer_workspaces', ${requestedScope.organizationId}) ORDER BY id`
        : await t<{ id: string }[]>`SELECT id::text AS id FROM harness_shared.customer_workspaces
            WHERE organization_id::text = ${requestedScope.organizationId} ORDER BY id`
      : null;
    const scope = owned ? { ...requestedScope, workspaceIds: owned.map((w) => w.id) } : requestedScope;
    const stores: OrganizationDataExport['stores'][number][] = [];
    const receipts: StoreReceipt[] = [];
    for (const treatment of planOrganizationDataOperation()) {
      if (treatment.executor !== executor || treatment.attribution.kind === 'unattributable') {
        receipts.push(deferred(treatment, 'export'));
        continue;
      }
      const userPredicate = scope.userId ? hostedUserPredicate(treatment.store) : null;
      if (scope.userId && !userPredicate) {
        receipts.push({ ...deferred(treatment, 'export'), outcome: 'not-attributable',
          reason: 'Organization-level record; not attributable to the requested user.' });
        continue;
      }
      const live = await liveColumns(t, treatment.store);
      if (executor === 'hosted-control-plane') {
        const mapped = new Set([...(treatment.exportColumns ?? []), ...treatment.excludedColumns]);
        if (!live.length || live.some((c) => !mapped.has(c)) || [...mapped].some((c) => !live.includes(c))) {
          throw new Error(`organization-data-receipts: unmapped live schema for ${treatment.store}`);
        }
      }
      const excluded = live.filter((c) => treatment.excludedColumns.includes(c) || ACCESS_SHAPED_COLUMN.test(c));
      const columns = live.filter((c) => !excluded.includes(c));
      if (!columns.length) throw new Error(`organization-data-receipts: ${treatment.store} has no exportable columns`);
      const bridged = input.hostedReadBridge && HOSTED_EXPORT_BRIDGED_STORES.includes(treatment.store);
      const rows = bridged
        ? (await t<{ data: Record<string, unknown> }[]>`SELECT data FROM
            papercusp_auth.read_hosted_customer_export_rows(${treatment.store}, ${scope.organizationId})`)
            .filter(({ data }) => !scope.userId || data.user_id === scope.userId)
            .map(({ data }) => Object.fromEntries(columns.map(c => [c, data[c]])))
        : await t.unsafe<Record<string, unknown>[]>(
            `SELECT ${columns.map((c) => `t."${c}"`).join(', ')} FROM ${quoted(treatment.store)} t WHERE ${
              executor === 'hosted-control-plane'
                ? `${hostedOrganizationPredicate(treatment.store)}${userPredicate ? ` AND (${userPredicate})` : ''}`
                : 't.workspace_id = ANY($1::text[])'}`,
            executor === 'hosted-control-plane'
              ? [scope.organizationId, ...(scope.userId ? [scope.userId] : [])] : [scope.workspaceIds as string[]],
          );
      stores.push({ store: treatment.store, columns, rows: [...rows] });
      receipts.push({
        store: treatment.store, executor: treatment.executor, retention: treatment.retention, outcome: 'exported',
        rowCount: rows.length, rowsRemaining: null, exportedColumns: columns, excludedColumns: excluded, reason: null,
      });
    }
    const receiptId = await writeOrganizationDataReceipt({
      operation: 'export', executor, scope, purpose: input.purpose, stores: receipts,
      limitations: executor === 'hosted-control-plane'
        ? ['Pilot workspace content is deferred to its data-plane executor.',
          'Unattributable provider and legacy stores are explicitly excluded by the data map.',
          'Export rows are materialized in memory; there is no streaming or row cap.']
        : [...BASE_LIMITATIONS, 'Export rows are materialized in memory; there is no streaming or row cap.'],
      schemaVersion: await readSchemaVersion(t),
    }, input.actor, t);
    return { receiptId, stores };
  };
  // Hosted authorization already holds an admission transaction. Reuse it so
  // revocation cannot race the read/receipt, and never nest BEGIN on TransactionSql.
  return transaction ? execute(transaction) : sql.begin((tx) => execute(tx as unknown as Sql));
}

async function countRows(sql: Sql, store: string, workspaceIds: readonly string[]): Promise<number> {
  const rows = await sql.unsafe<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM ${quoted(store)} WHERE workspace_id = ANY($1::text[])`,
    [workspaceIds as string[]],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The content stores a legal hold keeps rows in. The data source row itself is kept separately. */
export const HOLD_CONTENT_STORES = [
  'harness_shared.chat_messages',
  'harness_shared.chat_retrieval_units',
  'harness_shared.documents',
] as const;

export interface HoldTarget {
  readonly workspace_id: string;
  readonly data_source_id: string;
  /** null = the whole data source is held. */
  readonly channel_id: string | null;
}

/**
 * The one rule for which rows of `store` a hold keeps, as a WHERE clause over $1 workspace, $2 data
 * source, $3 container. Chat stores match the source and, for a container hold, the channel (the chat
 * purge rule); documents match the migration 1502 trigger: not chat-derived, container matched by
 * document_hold_container_matches. Counting (holdConflicts) and e-discovery export share it.
 */
function holdCoverageWhere(store: (typeof HOLD_CONTENT_STORES)[number]): string {
  if (store === 'harness_shared.documents') {
    return `workspace_id = $1 AND source_id = $2::uuid AND NOT harness_shared.document_is_chat_derived(kind)
      AND harness_shared.document_hold_container_matches(workspace_id, source_id, $3::text, metadata, permission_list_id)`;
  }
  return `workspace_id = $1 AND data_source_id = $2::uuid AND ($3::text IS NULL OR channel_id = $3)`;
}

function holdCoverageParams(h: HoldTarget): [string, string, string | null] {
  return [h.workspace_id, h.data_source_id, h.channel_id];
}

export interface HoldContentExport {
  readonly store: string;
  readonly columns: readonly string[];
  readonly excludedColumns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * The rows one hold keeps, per content store, shaped like the organization export (secret-class
 * and access-shaped columns are never exported). Rows are sorted by their JSON form, so the same
 * held content always yields the same export. Throws for a store the processing map does not treat
 * as pilot data plane: exporting an unclassified store would bypass its column exclusions.
 */
export async function exportHoldContent(sql: Sql, hold: HoldTarget): Promise<HoldContentExport[]> {
  const treatments = new Map(planOrganizationDataOperation().map((t) => [t.store, t]));
  const out: HoldContentExport[] = [];
  for (const store of HOLD_CONTENT_STORES) {
    const treatment = treatments.get(store);
    if (!treatment || treatment.executor !== 'pilot-data-plane') {
      throw new Error(`organization-data-receipts: ${store} is not a pilot data-plane store in the processing map`);
    }
    const live = await liveColumns(sql, store);
    const excluded = live.filter((c) => treatment.excludedColumns.includes(c) || ACCESS_SHAPED_COLUMN.test(c));
    const columns = live.filter((c) => !excluded.includes(c));
    const rows = await sql.unsafe<Record<string, unknown>[]>(
      `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${quoted(store)} WHERE ${holdCoverageWhere(store)}`,
      holdCoverageParams(hold),
    );
    const sorted = rows.map((r) => ({ key: JSON.stringify(r), row: { ...r } })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    out.push({ store, columns, excludedColumns: excluded, rows: sorted.map((s) => s.row) });
  }
  return out;
}

/** sha256 (hex) of held content as `exportHoldContent` returns it: the e-discovery export digest. */
export function holdContentDigest(stores: readonly HoldContentExport[]): string {
  return createHash('sha256').update(JSON.stringify(stores.map((s) => [s.store, s.columns, s.rows]))).digest('hex');
}

/** Active holds in the scope and, per hold, the rows each keeps (also the legal-hold listing, legal-holds.ts). */
export async function holdConflicts(sql: Sql, workspaceIds: readonly string[]): Promise<HoldConflict[]> {
  const holds = await sql<{ id: string; workspace_id: string; data_source_id: string; channel_id: string | null; placed_at: Date }[]>`
    SELECT id, workspace_id, data_source_id, channel_id, placed_at FROM harness_shared.data_source_legal_holds
     WHERE workspace_id = ANY(${workspaceIds as string[]}::text[]) AND released_at IS NULL
     ORDER BY placed_at, id`;
  const out: HoldConflict[] = [];
  for (const h of holds) {
    const retained: { store: string; rows: number }[] = [];
    for (const store of HOLD_CONTENT_STORES) {
      const rows = await sql.unsafe<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM ${quoted(store)} WHERE ${holdCoverageWhere(store)}`,
        holdCoverageParams(h),
      );
      retained.push({ store, rows: Number(rows[0]?.n ?? 0) });
    }
    const sources = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.data_sources WHERE workspace_id = ${h.workspace_id} AND id = ${h.data_source_id}::uuid`;
    retained.push({ store: 'harness_shared.data_sources', rows: Number(sources[0]?.n ?? 0) });
    out.push({
      holdId: h.id, workspaceId: h.workspace_id, dataSourceId: h.data_source_id, channelId: h.channel_id,
      placedAt: new Date(h.placed_at).toISOString(), retained,
    });
  }
  return out;
}

/**
 * Delete the scope's pilot data-plane rows by retention class, keep rows under an active legal
 * hold, and record a deletion receipt in the same transaction. `confirmOrganizationId` must repeat
 * the scope's organization id: deletion by workspace is destructive and has no undo.
 */
export async function deleteOrganizationData(
  sql: Sql,
  input: { scope: OrganizationDataScope; actor: ReceiptActor; purpose: string; confirmOrganizationId: string },
): Promise<{ receiptId: string; stores: readonly StoreReceipt[]; holdConflicts: readonly HoldConflict[] }> {
  const scope = validateScope(input.scope);
  if (input.confirmOrganizationId !== scope.organizationId) {
    throw new Error('organization-data-receipts: confirmOrganizationId does not match the scope');
  }
  authorizeDataOperation('deletion', scope.organizationId, input.actor);
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const plan = planOrganizationDataOperation();
    const ordered = deletionOrder(plan);
    const byStore = new Map<string, StoreReceipt>();
    for (const treatment of ordered) {
      if (treatment.executor !== 'pilot-data-plane') {
        byStore.set(treatment.store, deferred(treatment, 'deletion'));
        continue;
      }
      const base = { store: treatment.store, executor: treatment.executor, retention: treatment.retention,
        exportedColumns: null, excludedColumns: treatment.excludedColumns, reason: treatment.deletion.reason };
      if (treatment.deletion.action === 'retain') {
        byStore.set(treatment.store, { ...base, outcome: 'retained', rowCount: 0,
          rowsRemaining: await countRows(t, treatment.store, scope.workspaceIds) });
        continue;
      }
      const guard = treatment.deletion.action === 'delete-unless-held' ? HOLD_GUARDS[treatment.store] : undefined;
      if (treatment.deletion.action === 'delete-unless-held' && !guard) {
        throw new Error(`organization-data-receipts: ${treatment.store} is hold-aware but has no hold guard`);
      }
      const deleted = await t.unsafe(
        `DELETE FROM ${quoted(treatment.store)} t WHERE t.workspace_id = ANY($1::text[])${guard ? ` AND ${guard}` : ''}`,
        [scope.workspaceIds as string[]],
      );
      byStore.set(treatment.store, { ...base, outcome: 'deleted', rowCount: deleted.count,
        rowsRemaining: await countRows(t, treatment.store, scope.workspaceIds) });
    }
    const stores = plan.map((p) => byStore.get(p.store)!);
    const conflicts = await holdConflicts(t, scope.workspaceIds);
    const receiptId = await writeOrganizationDataReceipt({
      operation: 'deletion', scope, purpose: input.purpose, stores, holdConflicts: conflicts,
      limitations: [
        ...BASE_LIMITATIONS,
        'Chat-derived documents (chat-message, chat-thread, chat-window) of a held channel are deleted; the held content is kept in chat_messages.',
        'Other documents of a held source or container are kept, with their permission lists and members.',
        'A data source that any legal hold (active or released) names is kept: hold records are retained audit rows that reference it.',
        'A legal hold covers chat content and documents only: trigger deliveries, trigger bindings and other data-source dependents of a held source are deleted with the rest of the scope.',
        'Backups taken before this deletion still hold the deleted rows until they expire.',
      ],
      schemaVersion: await readSchemaVersion(t),
    }, input.actor, t);
    return { receiptId, stores, holdConflicts: conflicts };
  });
}

// ── Restore reconciliation ────────────────────────────────────────────────────

/** A provider identity revoked after the backup point, which a restore would bring back. */
export interface PostBackupRevocation {
  readonly workspaceId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly revokedBy: string;
}

/** Organization documents readable through one provider identity (the search ACL predicate, narrowed to it). */
export async function documentsReadableThroughIdentity(
  sql: Sql,
  input: { workspaceId: string; provider: string; providerUserId: string },
): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.documents d
     WHERE d.workspace_id = ${input.workspaceId} AND d.scope = 'organization' AND d.user_id IS NULL
       AND EXISTS (
         SELECT 1 FROM harness_shared.document_permission_members m
           JOIN harness_shared.provider_identity_mappings p
             ON p.workspace_id = m.workspace_id AND p.provider = m.provider
            AND p.provider_user_id = m.provider_user_id AND p.revoked_at IS NULL
          WHERE m.workspace_id = d.workspace_id AND m.list_id = d.permission_list_id
            AND m.provider = ${input.provider} AND m.provider_user_id = ${input.providerUserId})`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * A legal-hold change made after the backup point, which a restore undoes. The caller names it from
 * the audit or SIEM export (`organization.legal_hold.place` / `.release` events), never from the
 * restored audit table: a restore that shares the database rolls that table back too.
 */
export type PostBackupHoldChange =
  | {
      readonly kind: 'place';
      readonly holdId: string;
      readonly workspaceId: string;
      readonly dataSourceId: string;
      /** null = the whole data source is held. */
      readonly channelId: string | null;
      readonly reason: string;
      readonly placedBy: string;
      readonly placedAt: string;
    }
  | {
      readonly kind: 'release';
      readonly holdId: string;
      readonly workspaceId: string;
      readonly releasedBy: string;
      readonly releasedAt: string;
    };

/** The digest of one hold's content from an export taken just before the restore (exportLegalHoldContent). */
export interface PreRestoreHeldContent {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly digest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function holdChangeTime(c: PostBackupHoldChange): number {
  const at = Date.parse(c.kind === 'place' ? c.placedAt : c.releasedAt);
  if (Number.isNaN(at)) throw new Error(`organization-data-receipts: hold change ${c.holdId} has an invalid time`);
  return at;
}

interface RestoredHold {
  data_source_id: string;
  channel_id: string | null;
  placed_at: Date;
  released_at: Date | null;
}

async function readRestoredHold(sql: Sql, workspaceId: string, holdId: string): Promise<RestoredHold | undefined> {
  const [row] = await sql<RestoredHold[]>`
    SELECT data_source_id::text AS data_source_id, channel_id, placed_at, released_at
      FROM harness_shared.data_source_legal_holds
     WHERE workspace_id = ${workspaceId} AND id::text = ${holdId}
     FOR UPDATE`;
  return row;
}

/**
 * Re-apply one post-backup hold change through the hold writers (data-sources/chat-retrieval-units),
 * with its original id and time. A change the restored database already has is reported as present,
 * so running reconciliation twice changes nothing.
 */
async function reapplyHoldChange(sql: Sql, c: PostBackupHoldChange): Promise<HoldChangeCheck> {
  const existing = await readRestoredHold(sql, c.workspaceId, c.holdId);
  let applied: HoldChangeCheck['applied'] = 'present';
  if (c.kind === 'place') {
    if (existing) {
      if (existing.data_source_id !== c.dataSourceId.toLowerCase() || existing.channel_id !== (c.channelId ?? null)) {
        throw new Error(`organization-data-receipts: hold ${c.holdId} in the restored database covers a different source or container than the named placement`);
      }
    } else {
      const [source] = await sql<{ id: string }[]>`
        SELECT id FROM harness_shared.data_sources WHERE workspace_id = ${c.workspaceId} AND id::text = ${c.dataSourceId.toLowerCase()}`;
      if (!source) {
        throw new Error(`organization-data-receipts: hold ${c.holdId} names data source ${c.dataSourceId}, which the restored database does not have`);
      }
      await placeLegalHold(sql, c.workspaceId, {
        id: c.holdId, dataSourceId: c.dataSourceId, channelId: c.channelId, reason: c.reason, placedBy: c.placedBy, placedAt: c.placedAt,
      });
      applied = 'reapplied';
    }
  } else {
    if (!existing) {
      throw new Error(`organization-data-receipts: released hold ${c.holdId} is not in the restored database; name its placement as well`);
    }
    if (holdChangeTime(c) < new Date(existing.placed_at).getTime()) {
      throw new Error(`organization-data-receipts: hold ${c.holdId} release time is before its placement`);
    }
    if (!existing.released_at) {
      const { released } = await releaseLegalHold(sql, c.workspaceId, { id: c.holdId, releasedBy: c.releasedBy, releasedAt: c.releasedAt });
      if (released !== 1) throw new Error(`organization-data-receipts: hold ${c.holdId} could not be released`);
      applied = 'reapplied';
    }
  }
  const after = await readRestoredHold(sql, c.workspaceId, c.holdId);
  return { holdId: c.holdId, workspaceId: c.workspaceId, change: c.kind, applied, active: !!after && after.released_at === null };
}

/** Non-generated columns of `store` in one database, in table order. */
async function insertableColumns(sql: Sql, store: string): Promise<string[]> {
  const [schema, table] = store.split('.');
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema!} AND table_name = ${table!} AND is_generated = 'NEVER'
     ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

async function primaryKeyColumns(sql: Sql, store: string): Promise<string[]> {
  const rows = await sql<{ attname: string }[]>`
    SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = ${store}::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey::int2[], a.attnum)`;
  return rows.map((r) => r.attname);
}

/**
 * Copy the rows one hold keeps from the pre-restore database into the restored one: rows the restore
 * lost are inserted, rows it rolled back are set back to their pre-restore values. Rows the restored
 * database has and the source lacks are left as restored (keeping more is not a hold breach). Every
 * non-generated column both databases have is copied, including the ones the e-discovery export
 * leaves out: this is a database-to-database copy, not an export. Values travel as JSON text and are
 * parsed by the restored column types. Returns the number of rows inserted or changed.
 */
async function repairHeldContent(target: Sql, source: Sql, hold: HoldTarget): Promise<number> {
  let changed = 0;
  for (const store of HOLD_CONTENT_STORES) {
    const sourceColumns = new Set(await insertableColumns(source, store));
    const cols = (await insertableColumns(target, store)).filter((c) => sourceColumns.has(c));
    const pk = await primaryKeyColumns(target, store);
    if (!pk.length || pk.some((c) => !cols.includes(c))) {
      throw new Error(`organization-data-receipts: ${store} has no primary key both databases share; held content cannot be repaired`);
    }
    const [agg] = await source.unsafe<{ rows: string | null }[]>(
      `SELECT json_agg(s)::text AS rows FROM ${quoted(store)} s WHERE ${holdCoverageWhere(store)}`,
      holdCoverageParams(hold),
    );
    if (!agg?.rows) continue;
    const list = cols.map((c) => `"${c}"`).join(', ');
    const updates = cols.filter((c) => !pk.includes(c));
    const onConflict = updates.length
      ? `DO UPDATE SET ${updates.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}
         WHERE ROW(${cols.map((c) => `t."${c}"`).join(', ')})::text IS DISTINCT FROM ROW(${cols.map((c) => `EXCLUDED."${c}"`).join(', ')})::text`
      : 'DO NOTHING';
    const result = await target.unsafe(
      `INSERT INTO ${quoted(store)} AS t (${list}) OVERRIDING SYSTEM VALUE
       SELECT ${list} FROM json_populate_recordset(NULL::${quoted(store)}, $1::json)
       ON CONFLICT (${pk.map((c) => `"${c}"`).join(', ')}) ${onConflict}`,
      [agg.rows],
    );
    changed += result.count;
  }
  return changed;
}

/**
 * Compare what one hold keeps after the restore with the digest of its pre-restore export. When they
 * differ and the caller named the pre-restore database, copy the hold's rows back from it first.
 */
async function checkHeldContent(sql: Sql, h: PreRestoreHeldContent, source: Sql | undefined): Promise<HeldContentCheck> {
  const hold = await readRestoredHold(sql, h.workspaceId, h.holdId);
  if (!hold) {
    return { holdId: h.holdId, workspaceId: h.workspaceId, expectedDigest: h.digest, restoredDigest: null, matchesExport: false, repairedRows: null };
  }
  const target: HoldTarget = { workspace_id: h.workspaceId, data_source_id: hold.data_source_id, channel_id: hold.channel_id };
  const digest = async () => holdContentDigest(await exportHoldContent(sql, target));
  let restoredDigest = await digest();
  let repairedRows: number | null = null;
  if (restoredDigest !== h.digest && source && !hold.released_at) {
    const [held] = await source<RestoredHold[]>`
      SELECT data_source_id::text AS data_source_id, channel_id, placed_at, released_at
        FROM harness_shared.data_source_legal_holds
       WHERE workspace_id = ${h.workspaceId} AND id::text = ${h.holdId}`;
    if (!held || held.released_at || held.data_source_id !== hold.data_source_id || held.channel_id !== hold.channel_id) {
      throw new Error(`organization-data-receipts: the pre-restore database has no active hold ${h.holdId} covering the same source and container; held content cannot be repaired from it`);
    }
    repairedRows = await repairHeldContent(sql, source, target);
    restoredDigest = await digest();
  }
  return { holdId: h.holdId, workspaceId: h.workspaceId, expectedDigest: h.digest, restoredDigest, matchesExport: restoredDigest === h.digest, repairedRows };
}

/**
 * After restoring a pilot database: re-apply the legal-hold changes and the revocations made after
 * the backup point, verify each revoked identity can read no organization document, compare the
 * held content the caller exported before the restore, and record a restore receipt naming the
 * active holds and what each keeps. Throws (and writes nothing) when a revoked identity can still
 * read a document or a named change cannot be applied. A held-content mismatch does not throw: with a
 * `preRestoreSource` the hold's rows are first copied back from that database, and what remains is
 * recorded in the receipt (see the module comment). A source without the same active hold throws.
 */
export async function reconcileRestoredAccess(
  sql: Sql,
  input: {
    scope: OrganizationDataScope;
    actor: ReceiptActor;
    purpose: string;
    revocations: readonly PostBackupRevocation[];
    holdChanges?: readonly PostBackupHoldChange[];
    heldContent?: readonly PreRestoreHeldContent[];
    /**
     * The database the restore replaces. restore-pg-dump.sh loads into a new database, so this one
     * still has every held row. Used only to repair mismatched held content; never written.
     */
    preRestoreSource?: Sql;
  },
): Promise<{
  receiptId: string;
  stores: readonly StoreReceipt[];
  revocations: readonly RevocationCheck[];
  holdChanges: readonly HoldChangeCheck[];
  heldContent: readonly HeldContentCheck[];
  holdConflicts: readonly HoldConflict[];
}> {
  const scope = validateScope(input.scope);
  authorizeDataOperation('restore', scope.organizationId, input.actor);
  const inScope = (workspaceId: string, what: string) => {
    if (!scope.workspaceIds.includes(workspaceId)) {
      throw new Error(`organization-data-receipts: ${what} workspace ${workspaceId} is outside the scope`);
    }
  };
  for (const r of input.revocations) inScope(r.workspaceId, 'revocation');
  for (const c of input.holdChanges ?? []) {
    inScope(c.workspaceId, 'hold change');
    nonEmpty(c.holdId, 'holdId');
    holdChangeTime(c);
  }
  for (const h of input.heldContent ?? []) {
    inScope(h.workspaceId, 'held content');
    nonEmpty(h.holdId, 'holdId');
    if (!SHA256_HEX.test(h.digest)) throw new Error(`organization-data-receipts: held content digest for hold ${h.holdId} is not a sha256 hex digest`);
  }
  // Re-apply in the order the changes happened, so a hold placed and released after the backup
  // point ends released.
  const holdChanges = [...(input.holdChanges ?? [])].sort((a, b) => holdChangeTime(a) - holdChangeTime(b));
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const holdChecks: HoldChangeCheck[] = [];
    for (const c of holdChanges) holdChecks.push(await reapplyHoldChange(t, c));
    const checks: RevocationCheck[] = [];
    for (const r of input.revocations) {
      const { revoked } = await revokeProviderIdentityMapping(t, r.workspaceId, {
        provider: r.provider, providerUserId: r.providerUserId, revokedBy: r.revokedBy,
      });
      const readable = await documentsReadableThroughIdentity(t, r);
      checks.push({ workspaceId: r.workspaceId, provider: r.provider, providerUserId: r.providerUserId,
        mappingsRevoked: revoked, readableDocuments: readable, denied: readable === 0 });
    }
    const stillReadable = checks.filter((c) => !c.denied);
    if (stillReadable.length) {
      throw new Error(`organization-data-receipts: restored access not denied for ${stillReadable.map((c) => `${c.provider}:${c.providerUserId}`).join(', ')}`);
    }
    const stores: StoreReceipt[] = [];
    for (const treatment of planOrganizationDataOperation()) {
      if (treatment.executor !== 'pilot-data-plane') {
        stores.push(deferred(treatment, 'restore'));
        continue;
      }
      stores.push({ store: treatment.store, executor: treatment.executor, retention: treatment.retention,
        outcome: 'verified', rowCount: await countRows(t, treatment.store, scope.workspaceIds), rowsRemaining: null,
        exportedColumns: null, excludedColumns: treatment.excludedColumns, reason: null });
    }
    const heldContent: HeldContentCheck[] = [];
    for (const h of input.heldContent ?? []) heldContent.push(await checkHeldContent(t, h, input.preRestoreSource));
    const conflicts = await holdConflicts(t, scope.workspaceIds);
    const receiptId = await writeOrganizationDataReceipt({
      operation: 'restore', scope, purpose: input.purpose, stores, revocations: checks,
      holdChanges: holdChecks, heldContent, holdConflicts: conflicts,
      limitations: [
        ...BASE_LIMITATIONS,
        'Only the revocations the caller names are re-applied; deletions made after the backup point are not replayed.',
        'A restore replaces the database files, so the legal-hold triggers do not run during it: held rows written or changed after the backup point can be lost or rolled back. Rows under a hold that is active after reconciliation are protected by the hold triggers again.',
        'Only the hold placements and releases the caller names are re-applied, with their original ids and times; they are not read from the restored audit table, which can predate them.',
        'Held content is compared only for the holds whose pre-restore export digest the caller names. A mismatch means the content differs from that export (a row lost, rolled back or changed since). It is repaired only when the caller names the pre-restore database: rows are copied back from it (repairedRows), and rows that database no longer has are left as restored. Without it, a mismatch is recorded, not repaired, and the export is the copy of record.',
      ],
      schemaVersion: await readSchemaVersion(t),
    }, input.actor, t);
    return { receiptId, stores, revocations: checks, holdChanges: holdChecks, heldContent, holdConflicts: conflicts };
  });
}
