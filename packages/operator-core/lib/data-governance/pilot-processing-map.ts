/**
 * Pilot data-plane processing map (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-007, child P-007a WI-6554700010011592; decisions D-012 and D-014).
 *
 * P-007 acceptance requires that the pilot's selected data paths and unknowns are explicit.
 * This module is that declaration, as code. Each row of the pilot contract's
 * "Threat, authority and processing contract" table
 * (docs/evidence/enterprise-pilot-contract-draft-2026-10-11.md) has at least one path here.
 * Each path names:
 *  - the code seats that enforce it, as `{ file, exportedSymbol }`. The test checks that every
 *    cited file exists and exports that symbol, so a rename or deletion fails the build.
 *  - the Postgres stores it writes. The test checks that each store's qualified name appears in
 *    one of the path's cited files.
 *  - how it treats ACL checks, revocation, deletion and retention, in prose.
 *  - its unknowns. A path with nothing unknown says so explicitly with `['none']`, so an empty
 *    list cannot pass for "nothing unknown".
 *
 * Downstream users:
 *  - P-007b (WI-6554700010011594) supplies the tests listed in `canaryJourney` that exercise
 *    each permitted and denied journey (filled under WI-6554700010011737).
 *  - P-007c (WI-6554700010011593) writes export, deletion and restore receipts over
 *    `pilotStorePopulation()`. That function adds every hosted customer-data table
 *    (auth/hosted/customer-data-map.ts) to the pilot stores, so one receipt writer covers one
 *    declared population. The same writer serves cloud-portal-public-release-2026-10-13#P-010
 *    (its D-005).
 *
 * Source ACL enforcement for the pilot is the provider-neutral documents-corpus plus
 * permission-list seam. The Slack organization connector that the census cited
 * (data-sources/slack-org-connector.ts) was deleted. Cupboard plan D-025/D-026 moved it into
 * the Slack package, so this map does not cite it (enterprise D-014).
 */
import {
  HOSTED_CUSTOMER_DATA_TABLES,
  qualifiedName,
  type CustomerDataClass,
  type RetentionClass,
} from '../auth/hosted/customer-data-map';
import type { GovernedCategory } from '../governance-policy/inherited-policy';

/** Where organization content reaches a model provider: the one path whose seats judge the route. */
const VIA_MODEL_INFERENCE =
  'Its content reaches a model provider only through the model-inference path (turn-start injection or a tool result the session reads), whose launch, injection and dispatch seats judge provider and region.';

/** Rows of the pilot contract's processing table, verbatim. The test checks them against the doc. */
export const PILOT_CONTRACT_ROWS = [
  'Source read and stored copy',
  'Search and embeddings',
  'Model inference',
  'Workflow output and audit',
  'Logs and telemetry',
  'Backups and restores',
] as const;
export type PilotContractRow = (typeof PILOT_CONTRACT_ROWS)[number];

/**
 * - selected: in the pilot profile, with enforcement in code today.
 * - pending: in the profile, but the enforcing code belongs to a named open work-item (`ownerRef`).
 * - unknown: in the profile, but its treatment is not yet established. Its unknowns say what is missing.
 * - outside-profile: deliberately excluded. `unknowns` says what would bring it into the profile.
 */
export type PathStatus = 'selected' | 'pending' | 'unknown' | 'outside-profile';

export interface EnforcementPoint {
  /** Repository-relative path (papercusp checkout). */
  readonly file: string;
  /** A symbol that file exports. Pinned by the test. */
  readonly exportedSymbol: string;
  /** What this seat does for the path. */
  readonly role: string;
}

/**
 * P-016a (WI-6554700010011918): the processing-location restrictions (model, provider, region) a
 * path enforces. REQUIRED on every path, so a new path cannot omit the question.
 *  - `enforced`: the named seats (exported symbols of this path's enforcement points) judge the
 *    categories, and a canary journey carries `processing-restriction-canary:<path id>`.
 *  - `no-model-processing`: no model provider processes this path's content on this path; the
 *    reason names where it does reach a model (if anywhere).
 *  - `not-assessed`: only on a path that is not selected for the pilot.
 */
export type ProcessingRestrictions =
  | {
      readonly kind: 'enforced';
      readonly categories: readonly GovernedCategory[];
      readonly seats: readonly string[];
    }
  | { readonly kind: 'no-model-processing'; readonly reason: string }
  | { readonly kind: 'not-assessed'; readonly reason: string };

/** Retention of a pilot-only store, in the same vocabulary as the hosted customer-data map where it applies. */
export type PilotRetention = RetentionClass | 'source-mirrored' | 'legal-hold-aware-ttl';

export interface PilotStore {
  /** `schema.table`. */
  readonly qualified: string;
  readonly retention: PilotRetention;
}

export interface PilotDataPath {
  readonly id: string;
  readonly label: string;
  readonly contractRows: readonly PilotContractRow[];
  readonly status: PathStatus;
  /** Work-item that owns the missing half, required when status is `pending`. */
  readonly ownerRef?: string;
  readonly stores: readonly PilotStore[];
  /** External processors this path reaches. Prose; these are not pinned to code. */
  readonly processors: readonly string[];
  readonly enforcement: readonly EnforcementPoint[];
  readonly aclCheck: string;
  readonly revocation: string;
  readonly deletion: string;
  readonly retention: string;
  /**
   * Tests that exercise the permitted and denied (revocation, restricted-content) journeys.
   * Filled by P-007b (WI-6554700010011594) for every selected path; null on a path that is
   * not selected for the pilot.
   */
  readonly canaryJourney: readonly string[] | null;
  /** Processing-location restrictions this path enforces (P-016a). */
  readonly restrictions: ProcessingRestrictions;
  /**
   * P-016a DLP: the data classes (hosted customer-data vocabulary) this path moves. REQUIRED and
   * never empty. The injection seat derives each leg's `class:<class>` dataUse labels from the
   * path that carries it (`pilotPathDataClasses`), so the map, not a second list, decides what
   * a `dataUse.deny: ['class:pii']` rule withholds.
   */
  readonly dataClasses: readonly CustomerDataClass[];
  /** Never empty. `['none']` is the explicit "nothing unknown". */
  readonly unknowns: readonly string[];
}

const DS = 'packages/operator-core/lib/data-sources';

export const PILOT_PROCESSING_MAP: readonly PilotDataPath[] = [
  {
    id: 'source-read-and-copy',
    // Stored document and chat copies (content), permission lists and identity bindings that name people (pii).
    dataClasses: ['customer-content', 'pii', 'operational'],
    restrictions: { kind: 'no-model-processing', reason: `Connector reads and stored copies stay in the operator database. ${VIA_MODEL_INFERENCE}` },
    label: 'Connector read and stored copy of organization source content',
    contractRows: ['Source read and stored copy'],
    status: 'selected',
    stores: [
      { qualified: 'harness_shared.data_sources', retention: 'account' },
      { qualified: 'harness_shared.documents', retention: 'legal-hold-aware-ttl' },
      { qualified: 'harness_shared.document_permission_lists', retention: 'source-mirrored' },
      { qualified: 'harness_shared.document_permission_members', retention: 'source-mirrored' },
      { qualified: 'harness_shared.provider_identity_mappings', retention: 'account' },
      { qualified: 'harness_shared.chat_messages', retention: 'legal-hold-aware-ttl' },
      { qualified: 'harness_shared.chat_retrieval_units', retention: 'legal-hold-aware-ttl' },
      { qualified: 'harness_shared.data_source_legal_holds', retention: 'audit' },
    ],
    processors: ['Source provider (the Slack package over connector-runtime, cupboard D-025/D-026)'],
    enforcement: [
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'upsertOrganizationDocuments', role: 'Stores the copy with its permission list' },
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'upsertPermissionList', role: 'Source ACL as a permission list' },
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'replacePermissionListMembers', role: 'Applies a source permission change' },
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'mapProviderIdentity', role: 'Binds a provider identity to a local user' },
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'revokeProviderIdentityMapping', role: 'Revokes a provider identity binding' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'upsertChatMessages', role: 'Stores chat messages and their windows' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'tombstoneChatMessage', role: 'Source deletion removes the copy' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'purgeExpiredChatMessages', role: 'Retention purge that skips held rows' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'purgeExpiredDocuments', role: 'Document retention purge that skips held documents' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'placeLegalHold', role: 'Legal hold blocks purge' },
      { file: `${DS}/chat-retrieval-units.ts`, exportedSymbol: 'releaseLegalHold', role: 'Releases a legal hold' },
      { file: 'packages/operator-core/lib/data-governance/legal-holds.ts', exportedSymbol: 'placeOrganizationLegalHold', role: 'Authorized organization hold placement with an audit event' },
      { file: 'packages/operator-core/lib/data-governance/legal-holds.ts', exportedSymbol: 'releaseOrganizationLegalHold', role: 'Authorized organization hold release with an audit event' },
      { file: 'packages/operator-core/lib/data-governance/legal-holds.ts', exportedSymbol: 'listOrganizationLegalHolds', role: 'Organization-scoped listing of active and released holds' },
    ],
    aclCheck: 'Permission list, its membership and an unrevoked provider identity mapping are checked on every read (see search-and-retrieval).',
    revocation: 'replacePermissionListMembers and revokeProviderIdentityMapping write Postgres directly; the next read re-checks them, so no cache has to expire.',
    deletion: 'tombstoneChatMessage erases the message body and raw payload at once (kept, never rendered, under a legal hold) and re-queues the window rollup that renders the derived documents row. Non-chat documents are protected from deletion or content erasure by documents_enforce_legal_hold (migration 1502); organization deletion reports held rows as retained-under-hold rather than claiming full deletion.',
    retention: 'Both purges run on every connector-sync pass (runChatRollupPass) against the source retention_policy.maxAgeDays. purgeExpiredChatMessages removes expired messages except those under a data_source_legal_holds hold. purgeExpiredDocuments removes the source\'s other expired documents (age = source time, else import time), keeps and counts those under a hold (document_under_hold, migration 1502), and leaves chat-derived documents to the chat purge and rollup.',
    canaryJourney: [
      `${DS}/org-corpus-permissions.integration.test.ts`,
      `${DS}/chat-retrieval-units.integration.test.ts`,
      'packages/operator-core/lib/data-governance/legal-holds.integration.test.ts',
    ],
    unknowns: [
      'Document retention ages a document by its source time (occurred_at) only when the source supplies one; otherwise it ages from the import (imported_at), so a document first imported long after it was created in the source is kept longer than the policy window.',
      'Stale and replayed source events: ordering by source version for the Slack package transport is not pinned here. P-007b journeys must cover it.',
      'Source owner of record per data source is not a recorded field.',
    ],
  },
  {
    id: 'search-and-retrieval',
    // Search hits are source text; senders, authors and mentions name people.
    dataClasses: ['customer-content', 'pii'],
    restrictions: { kind: 'no-model-processing', reason: `Search returns ACL-filtered rows to the calling session; federated providers receive the query, not model processing. ${VIA_MODEL_INFERENCE}` },
    label: 'Organization search, federated live search and the granted-sources turn block',
    contractRows: ['Search and embeddings'],
    status: 'selected',
    stores: [
      { qualified: 'harness_shared.documents', retention: 'legal-hold-aware-ttl' },
      { qualified: 'harness_shared.provider_identity_mappings', retention: 'account' },
      { qualified: 'harness_shared.data_source_subscriptions', retention: 'account' },
    ],
    processors: ['Federated source providers queried live (sync_mode federated)'],
    enforcement: [
      { file: `${DS}/documents-corpus.ts`, exportedSymbol: 'searchOrganizationDocuments', role: 'Lexical search filtered by live access, permission membership and unrevoked mapping' },
      { file: `${DS}/live-search-adapter.ts`, exportedSymbol: 'searchLiveSources', role: 'Federated search; revalidates authority after the provider read (WI-6554700010010935)' },
      { file: `${DS}/granted-sources-injection.ts`, exportedSymbol: 'collectOrganizationEntries', role: 'Turn-start block draws organization documents through the same filtered search' },
    ],
    aclCheck: 'searchOrganizationDocuments filters every hit by the caller\'s permission membership and an unrevoked provider mapping.',
    revocation: 'Checked at query time, so a revocation takes effect on the next search.',
    deletion: 'Search reads harness_shared.documents only; a deleted row cannot be returned.',
    retention: 'No copy of its own. The shared documents store follows the source-read-and-copy retention policy, including active legal holds. Search indexes (text_tsv, documents_bm25) are derived from documents rows and go with them.',
    canaryJourney: [
      `${DS}/org-corpus-permissions.integration.test.ts`,
      `${DS}/live-search-adapter.integration.test.ts`,
      `${DS}/granted-sources-injection.integration.test.ts`,
    ],
    unknowns: [
      'Embeddings: organization search is lexical (ts_rank_cd or BM25), and documents-corpus.ts writes no vector. Whether any other embedding index ingests organization documents has not been proven absent repo-wide.',
      'Federated providers may log or retain the query text. That is provider-side retention, not recorded here.',
    ],
  },
  {
    id: 'model-inference',
    // Prompts carry injected source text and the people it names.
    dataClasses: ['customer-content', 'pii'],
    restrictions: {
      kind: 'enforced',
      categories: ['models', 'providers', 'regions', 'egress'],
      seats: ['judgeLaunchGovernance', 'judgeInjectionLegs', 'enforceInheritedPolicy'],
    },
    label: 'Organization content reaching the model provider, and tool-dispatch model and egress governance',
    contractRows: ['Model inference'],
    status: 'selected',
    stores: [],
    processors: ['The agent session\'s model provider', 'Model ids named in tool-dispatch arguments'],
    enforcement: [
      { file: 'packages/operator-core/lib/governance-policy/enforce.ts', exportedSymbol: 'enforceInheritedPolicy', role: 'Dispatch seat that judges models, egress and dataUse on every tool call' },
      { file: 'packages/operator-core/lib/governance-policy/inherited-policy.ts', exportedSymbol: 'evaluateInheritedPolicy', role: 'Organization, department and workspace policy chain' },
      { file: `${DS}/granted-sources-injection.ts`, exportedSymbol: 'fenceUntrustedSourceText', role: 'Fences source text as untrusted before it enters model context' },
      { file: 'packages/operator-core/lib/governance-policy/session-governance.ts', exportedSymbol: 'judgeLaunchGovernance', role: 'Judges the launched session\'s resolved model (models) and provider API host (egress) before any terminal opens, in capability:launch-agent and fleet:launch-on-plan' },
      { file: 'packages/operator-core/lib/governance-policy/session-governance.ts', exportedSymbol: 'judgeInjectionLegs', role: 'Judges each granted-sources leg (dataUse model-context plus the leg label and its class:<cls> data-class labels, and the session provider when known) before the leg reads; a refused leg is never read' },
    ],
    aclCheck: 'Only content that passed the search-and-retrieval ACL filter is injected, and only from legs the inherited policy permits.',
    revocation: 'The policy chain is re-read per dispatch, per launch and per turn-start injection (5s cache), with a fail-closed refusal when a chain read fails and there is no last-known chain.',
    deletion: 'Nothing is stored on this path, so nothing is deleted here.',
    retention: 'Provider-side retention is not governed here.',
    canaryJourney: [
      'packages/operator-core/lib/governance-policy/session-governance.test.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/turn-start-memory.test.ts',
      'packages/operator-core/lib/governance-policy/processing-route.test.ts',
      'packages/operator-core/lib/governance-policy/data-classes.test.ts',
    ],
    unknowns: [
      'Provider-side retention is not recorded. A global endpoint (api.anthropic.com, api.openai.com) does not prove where it processes, so its region is judged as unresolved-region: residency needs a regions allow list, and no launch backend reaches a region-pinned route yet (P-016 private-route decision).',
      'A session started outside the launch tools (a human running psu from a terminal) is not judged at launch. Turn-start injection judges each leg against the session backend/model read from its newest launch record (adv_sessions); a session with no launch record is judged by dataUse only.',
    ],
  },
  {
    id: 'personal-vault-disclosure',
    // Personal mail and files and their reader sets.
    dataClasses: ['customer-content', 'pii'],
    restrictions: { kind: 'not-assessed', reason: 'Outside the assumed pilot profile.' },
    label: 'Reader-set disclosure of personal-vault documents',
    contractRows: ['Model inference'],
    status: 'outside-profile',
    stores: [],
    processors: [],
    enforcement: [
      { file: 'packages/operator-core/lib/personal-vault/disclosure-ledger.ts', exportedSymbol: 'assertDisclosurePermits', role: 'Refuses a disclosure that privacy rules do not permit' },
      { file: 'packages/operator-core/lib/personal-vault/disclosure-ledger.ts', exportedSymbol: 'discloseDocuments', role: 'Records a disclosure to a reader set' },
    ],
    aclCheck: 'Owner privacy rules decide which reader sets may see a document.',
    revocation: 'Disclosures are recorded per reader set; release is explicit (releaseDisclosures).',
    deletion: 'Not assessed for the pilot.',
    retention: 'Not assessed for the pilot.',
    canaryJourney: null,
    unknowns: [
      'Outside the profile because the pilot workflow uses organization sources, not members\' personal vaults. If pilot members connect personal vaults, this path enters the profile and needs full treatment.',
    ],
  },
  {
    id: 'workflow-output-and-audit',
    // Workflow outputs are content; audit rows carry actors (pii) and states.
    dataClasses: ['customer-content', 'pii', 'operational'],
    restrictions: { kind: 'no-model-processing', reason: `Outputs and audit rows are written to the operator database; the model calls that produced them were judged on the model-inference path. ${VIA_MODEL_INFERENCE}` },
    label: 'Workflow output, organization audit events, operator audit and model-call ledger',
    contractRows: ['Workflow output and audit'],
    status: 'selected',
    stores: [
      { qualified: 'papercusp_auth.organization_audit_events', retention: 'audit' },
      { qualified: 'harness_shared.audit_log', retention: 'audit' },
      { qualified: 'harness_shared.decision_model_calls', retention: 'provider-ledger' },
    ],
    processors: [],
    enforcement: [
      { file: 'packages/operator-core/lib/auth/hosted/governance.ts', exportedSymbol: 'appendOrganizationAuditEvent', role: 'Organization audit row; metadata passes assertGovernancePayloadSafe' },
      { file: 'packages/operator-core/lib/auth/hosted/governance.ts', exportedSymbol: 'assertGovernancePayloadSafe', role: 'Refuses secret-shaped audit metadata' },
      { file: 'packages/operator-core/lib/operator-audit.ts', exportedSymbol: 'writeOperatorAudit', role: 'Operator action audit' },
      { file: 'packages/operator-core/lib/decision-model-ledger.ts', exportedSymbol: 'recordDecisionModelCall', role: 'Model-call ledger' },
    ],
    aclCheck: 'Organization audit rows are scoped to their organization.',
    revocation: 'Not applicable: audit rows are append-only.',
    deletion: 'Organization deletion is covered by the hosted customer-data map retention class audit.',
    retention: 'audit class for organization and operator audit; provider-ledger for the model-call ledger.',
    canaryJourney: ['packages/operator-core/lib/auth/hosted/governance.test.ts'],
    unknowns: [
      'Accepted/denied action correlation and SIEM delivery are qualified separately by P-008 (WI-10007903). Resolve its current saved evidence and acceptance ledger; this processing declaration does not establish that runtime outcome.',
      'Audience and redaction of the workflow output itself are owned by the pilot workflow (P-012), not mapped here.',
    ],
  },
  {
    id: 'logs-and-telemetry',
    // Log lines can quote content and people until redaction proves otherwise (status unknown).
    dataClasses: ['operational', 'pii', 'customer-content'],
    restrictions: { kind: 'not-assessed', reason: 'Path status is unknown; where telemetry is processed is part of the customer-key and private-route decision (P-016).' },
    label: 'Service logs and telemetry that may carry pilot content',
    contractRows: ['Logs and telemetry'],
    status: 'unknown',
    stores: [],
    processors: ['Host journald for operator services'],
    enforcement: [
      { file: 'packages/operator-core/lib/sensitive-text.ts', exportedSymbol: 'redactSensitiveText', role: 'Secret redaction helper for text sinks' },
      { file: 'packages/operator-core/lib/workspace-host/observability-store.ts', exportedSymbol: 'redactWorkspaceHostText', role: 'Redaction for workspace-host observability text' },
    ],
    aclCheck: 'No per-organization access control on host logs.',
    revocation: 'Not applicable.',
    deletion: 'Not established.',
    retention: 'Host journald retention is host configuration, not recorded here.',
    canaryJourney: null,
    unknowns: [
      'Hosted control-plane log-capture qualification belongs to cloud-portal-public-release-2026-10-13#P-012 (WI-6554700010011225). Resolve its current evidence; a hosted guard does not establish redaction of every pilot host log sink.',
      'No declared secret-canary population for logs, and no proof that every log sink passes through a redaction helper.',
      'Telemetry export targets and their retention are not enumerated.',
    ],
  },
  {
    id: 'backups-and-restores',
    // A database dump carries every class, secrets included.
    dataClasses: ['customer-content', 'pii', 'secret', 'billing', 'operational'],
    restrictions: { kind: 'not-assessed', reason: 'Path status is unknown; backup location and keys are part of the customer-key lifecycle decision (P-016).' },
    label: 'Database backups and restore of pilot stores',
    contractRows: ['Backups and restores'],
    status: 'unknown',
    stores: [],
    processors: [],
    enforcement: [
      { file: 'packages/operator-core/lib/backup/durable-ops.ts', exportedSymbol: 'durableRestoreInPlace', role: 'Restore operation' },
      { file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts', exportedSymbol: 'reconcileRestoredAccess', role: 'Post-restore reconciliation: re-applies revocations and legal-hold changes made after the backup point, and compares held content with its pre-restore export, repairing it from the pre-restore database when given' },
    ],
    aclCheck: 'Restored rows carry their permission lists. reconcileRestoredAccess checks organization documents against each revoked identity supplied to the restore drill before recording its receipt; an automatic deployment-wide restore reconciliation is not qualified here.',
    revocation: 'reconcileRestoredAccess re-applies the provider-identity revocations supplied after the backup point and refuses to record success if a revoked identity still reads organization content. The caller must supply the post-backup revocations; an omitted revocation is not recovered automatically.',
    deletion: 'Not established: deletions after the backup point reappear on restore.',
    retention: 'Legal holds: a restore replaces the database files, so the hold triggers do not run during it. A restore may overwrite a held row with its backup-point version and removes held rows written after that point. Rows under a hold that is active once the restore finishes are protected immediately by the hold triggers (chat_messages since migration 1320, documents since 1502). reconcileRestoredAccess re-applies the hold placements and releases made after the backup point, with their original ids and times, and records whether each held content still matches the exportLegalHoldContent digest taken before the restore. Given the pre-restore database (restore-pg-dump.sh loads into a new database, so the replaced one survives), it first copies the rows of a mismatched hold back from it: lost rows are re-inserted and rolled-back rows reset, and the receipt counts them (repairedRows). Backup retention itself is not established.',
    canaryJourney: null,
    unknowns: [
      'Backup location, access and key custody for the pilot profile.',
      'Whether backup retention (snapshot expiry) honours legal holds, and how a deletion is carried into backups taken before it.',
      'A qualified restore exercise with receipts belongs to P-007c (WI-6554700010011593) and cloud-portal P-010.',
    ],
  },
  {
    id: 'organization-export-and-deletion',
    // Export never emits the secret class (exportOrganizationData).
    dataClasses: ['customer-content', 'pii', 'billing', 'operational'],
    restrictions: { kind: 'no-model-processing', reason: 'Export and deletion read and write the operator database and receipts; no model processes the exported content on this path.' },
    label: 'Organization-scoped export and deletion over the declared store population',
    contractRows: ['Source read and stored copy', 'Backups and restores'],
    status: 'selected',
    stores: [
      { qualified: 'papercusp_auth.organization_audit_events', retention: 'audit' },
      // FK children of data_sources. They belong to the population because they hang off an
      // organization's data source; a guard test keeps the population closed under FK children.
      { qualified: 'harness_shared.admission_rules', retention: 'account' },
      { qualified: 'harness_shared.trigger_bindings', retention: 'account' },
      { qualified: 'harness_shared.trigger_webhook_secrets', retention: 'account' },
      { qualified: 'harness_shared.connector_push_secrets', retention: 'account' },
      { qualified: 'harness_shared.trigger_deliveries', retention: 'source-mirrored' },
      // FK child of trigger_bindings and trigger_deliveries (both ON DELETE RESTRICT).
      { qualified: 'harness_shared.trigger_runs', retention: 'source-mirrored' },
      { qualified: 'harness_shared.chat_bug_suggestions', retention: 'source-mirrored' },
      { qualified: 'harness_shared.chat_rollup_queue', retention: 'ephemeral' },
    ],
    processors: [],
    enforcement: [
      { file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts', exportedSymbol: 'writeOrganizationDataReceipt', role: 'The one receipt writer for export, deletion and restore' },
      { file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts', exportedSymbol: 'exportOrganizationData', role: 'Pilot data-plane export; never emits a secret-class or access-shaped column' },
      { file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts', exportedSymbol: 'deleteOrganizationData', role: 'Pilot data-plane deletion by retention class; legal-held rows survive as hold conflicts' },
      { file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts', exportedSymbol: 'reconcileRestoredAccess', role: 'Restore drill: re-applies revocations and legal-hold changes, proves a revoked identity is denied, and checks held content against its pre-restore export' },
      { file: 'packages/operator-core/lib/data-governance/legal-holds.ts', exportedSymbol: 'exportLegalHoldContent', role: 'E-discovery export of exactly the content one active legal hold keeps, with a digest and an audit event' },
      { file: 'packages/operator-core/lib/auth/hosted/governance.ts', exportedSymbol: 'appendOrganizationAuditEvent', role: 'Where export, deletion and restore receipts land' },
      { file: 'packages/operator-core/lib/auth/hosted/customer-data-map.ts', exportedSymbol: 'HOSTED_CUSTOMER_DATA_TABLES', role: 'Hosted half of the declared store population' },
    ],
    aclCheck: 'authorizeDataOperation: a customer user must be acting in the organization and hold members:manage (export) or workspace:destroy (deletion, restore).',
    revocation: 'Restore re-applies the revocations and legal-hold changes the caller names and records a receipt only after no organization document is readable through each revoked identity.',
    deletion: 'deleteOrganizationData deletes account, ephemeral and source-mirrored rows; legal-hold-aware rows unless an active hold covers them; audit and billing classes are retained with a reason. Every run writes one receipt.',
    retention: 'Receipts are audit-class rows.',
    canaryJourney: [
      'packages/operator-core/lib/data-governance/organization-data-receipts.integration.test.ts',
      'packages/operator-core/lib/data-governance/organization-data-receipts.test.ts',
      'packages/operator-core/lib/data-governance/legal-holds.integration.test.ts',
    ],
    unknowns: [
      'Hosted control-plane stores are recorded as deferred; their executor is cloud-portal P-010 (WI-6554700010011223).',
      'The organization-to-workspace binding is declared by the caller, not derived.',
      'No scheduled pilot backup exists; the restore drill runs against a scratch database.',
      'Admission rules, chat bug suggestions, the chat rollup queue, trigger bindings, trigger deliveries, trigger runs and push or webhook secrets are in the population only as data-source dependents. Their own processing (admission, triggers, push intake) is not mapped as a pilot path.',
      'A legal hold covers chat content and documents only (place, list, release and e-discovery export: placeOrganizationLegalHold, listOrganizationLegalHolds, releaseOrganizationLegalHold, exportLegalHoldContent). Trigger deliveries, trigger runs and chat bug suggestions of a held source are deleted with the rest of the scope.',
    ],
  },
];

/** The data classes one pilot path moves (P-016a DLP). Throws on an unknown id: a caller names a real path. */
export function pilotPathDataClasses(pathId: string): readonly CustomerDataClass[] {
  const path = PILOT_PROCESSING_MAP.find((p) => p.id === pathId);
  if (!path) throw new Error(`pilot-processing-map: no path '${pathId}'`);
  return path.dataClasses;
}

export interface PopulationEntry {
  readonly qualified: string;
  readonly source: 'pilot-map' | 'hosted-map';
  readonly retention: PilotRetention;
}

/**
 * The store population that export, deletion and restore receipts must cover: every pilot-map
 * store plus every hosted customer-data table, one entry per qualified name, with pilot-map
 * entries taking precedence.
 */
export function pilotStorePopulation(): readonly PopulationEntry[] {
  const out = new Map<string, PopulationEntry>();
  for (const path of PILOT_PROCESSING_MAP) {
    if (path.status === 'outside-profile') continue;
    for (const store of path.stores) {
      if (!out.has(store.qualified)) {
        out.set(store.qualified, { qualified: store.qualified, source: 'pilot-map', retention: store.retention });
      }
    }
  }
  for (const table of HOSTED_CUSTOMER_DATA_TABLES) {
    const qualified = qualifiedName(table);
    if (!out.has(qualified)) out.set(qualified, { qualified, source: 'hosted-map', retention: table.retention });
  }
  return [...out.values()];
}
