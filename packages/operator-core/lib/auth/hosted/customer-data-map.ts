/**
 * Hosted customer-data map — the single, code-owned inventory of every table the hosted
 * control plane (app.papercusp.com) stores customer data in, with a per-column
 * classification and each table's system of record.
 *
 * Plan cloud-portal-public-release-2026-10-13, P-001 (bars R-2 and R-15). Downstream
 * consumers: P-010 export/deletion (which rows belong to an organization), P-012
 * PII-free logs (which columns must never be logged), P-005/P-024 (what moves to the
 * dedicated production database and what the dev-box purge census counts).
 *
 * WHY CODE, NOT PROSE. A data map is code-describing metadata, and a hand-maintained
 * table drifts the first time a migration adds a column. This module is PINNED by
 * `customer-data-map.integration.test.ts`. That test fails when (a) a scoped table
 * gains or loses a column that is not classified here, (b) a migration adds a table to
 * the customer schema without an entry here, or (c) the hosted signup journey writes a
 * table this map does not name (the SPEC-P-001 falsifier). The agent-insights doc
 * `agent-insights/hosted-customer-data-map` explains the map; this module is the
 * authority.
 *
 * CLASSIFICATION RULES (every column gets exactly one class):
 *   pii         — identifies or describes a natural person: email, names, IP, user
 *                 agent, free-form profile/metadata/evidence, provider-side subject ids
 *                 linkable to a person, user-chosen labels and names.
 *   secret      — grants or helps grant access: session ids, sealed sessions, bearer
 *                 token / code / credential hashes, PKCE/OAuth state, magic-link tokens.
 *                 Never exported, never logged. (Declared with the `access` key below.)
 *   billing     — money and entitlement facts: Stripe ids, prices, plans, statuses,
 *                 amounts, usage quantities and costs, budget limits.
 *   operational — everything else: surrogate keys (uuid ids, user_id, organization_id),
 *                 enums/states, timestamps, revision counters, digests of non-secret
 *                 bodies.
 *   customer-content — content the customer brings in: documents, messages, search hits,
 *                 prompts and model outputs. Its composition is unknown, so it may carry any
 *                 other class. No hosted control-plane column holds it (declared with the
 *                 `content` key below); pilot data paths carry it
 *                 (data-governance/pilot-processing-map.ts).
 *
 * DLP (P-016a, WI-6554700010011918). This is also the ONE classification vocabulary that
 * governance policy administers. A class is governed as the `dataUse` label `class:<class>`
 * (`dataClassUseLabel`). Injection legs and dispatched calls carry the labels of the classes
 * they move, so an organization rule `dataUse.deny: ['class:pii']` withholds them. The policy
 * write path refuses a `class:` label that names no class here (governance-policy/store.ts),
 * so a typo cannot silently protect nothing.
 */

export type CustomerDataClass = 'pii' | 'secret' | 'billing' | 'operational' | 'customer-content';

export const CUSTOMER_DATA_CLASSES: readonly CustomerDataClass[] = ['pii', 'secret', 'billing', 'operational', 'customer-content'];

export function isCustomerDataClass(value: unknown): value is CustomerDataClass {
  return typeof value === 'string' && (CUSTOMER_DATA_CLASSES as readonly string[]).includes(value);
}

/** Prefix of a data class's governance `dataUse` label. */
export const DATA_CLASS_USE_PREFIX = 'class:';

/** The governance `dataUse` label of one data class (`pii` → `class:pii`). */
export function dataClassUseLabel(cls: CustomerDataClass): string {
  return `${DATA_CLASS_USE_PREFIX}${cls}`;
}

/** One line per class, for the governance administration surface. */
export const CUSTOMER_DATA_CLASS_DESCRIPTIONS: Readonly<Record<CustomerDataClass, string>> = {
  pii: 'Identifies or describes a natural person.',
  secret: 'Grants or helps grant access; never exported or logged.',
  billing: 'Money and entitlement facts.',
  operational: 'Keys, states, timestamps and other non-personal facts.',
  'customer-content': 'Customer documents, messages, prompts and outputs; may carry any other class.',
};

/** Where the authoritative copy of the facts in a table lives. */
export type SystemOfRecord =
  /** Papercusp's own database is the only authority. */
  | 'papercusp'
  /** A projection of WorkOS state; WorkOS is authoritative. */
  | 'workos-mirror'
  /** A webhook-synced projection of Stripe state; Stripe is authoritative. */
  | 'stripe-mirror';

/** How long rows live and what governs their deletion. */
export type RetentionClass =
  /** Lives with the account; removed or anonymized on organization deletion (R-7). */
  | 'account'
  /** Proof of consent (terms/privacy acceptance) that we must be able to produce. */
  | 'consent-proof'
  /** Financial record; retention may be required by law after account deletion. */
  | 'billing-record'
  /** Organization/operator audit trail. */
  | 'audit'
  /** Abuse-prevention ledger (one trial / signup rate limits). */
  | 'abuse-prevention'
  /** Short-lived credential or handshake state; expires on its own. */
  | 'ephemeral'
  /** Inbound provider webhook ledger with its own retention_until. */
  | 'provider-ledger'
  /** Legacy pre-hosted table, empty in production; slated for removal. */
  | 'legacy-empty';

/** How a row is attributed to an organization (what P-010 export/deletion follows). */
export type OrganizationLink =
  /** The table carries the organization id in this column. */
  | { readonly via: 'column'; readonly column: string }
  /** The column holds a hosted user id; the user belongs to organizations via memberships. */
  | { readonly via: 'user'; readonly column: string }
  /** The column references another table's column that is itself organization-linked. */
  | { readonly via: 'join'; readonly column: string; readonly target: string }
  /** Not attributable to one organization; the note says how it is keyed instead. */
  | { readonly via: 'none'; readonly note: string };

export interface CustomerDataTable {
  readonly schema: 'papercusp_auth' | 'harness_shared';
  readonly table: string;
  readonly purpose: string;
  readonly systemOfRecord: SystemOfRecord;
  readonly retention: RetentionClass;
  readonly organizationLink: OrganizationLink;
  /** Every column of the table, by class. Pinned to the live schema by the integration test. */
  readonly columns: Readonly<Record<CustomerDataClass, readonly string[]>>;
}

/** Whitespace-separated column list → array (keeps the map dense and diff-friendly). */
function cols(list: string): readonly string[] {
  const trimmed = list.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function table(
  schema: CustomerDataTable['schema'],
  name: string,
  spec: Omit<CustomerDataTable, 'schema' | 'table' | 'columns'> & {
    readonly pii?: string;
    /** Columns of class `secret`. */
    readonly access?: string;
    readonly billing?: string;
    readonly operational?: string;
    /** Columns of class `customer-content`. */
    readonly content?: string;
  },
): CustomerDataTable {
  const { pii = '', access = '', billing = '', operational = '', content = '', ...rest } = spec;
  return {
    schema,
    table: name,
    ...rest,
    columns: {
      pii: cols(pii),
      secret: cols(access),
      billing: cols(billing),
      operational: cols(operational),
      'customer-content': cols(content),
    },
  };
}

const ORG = { via: 'column', column: 'organization_id' } as const;

/**
 * Every table holding hosted customer data. Scope: ALL of `papercusp_auth` plus the two
 * `harness_shared` tables that carry customer workspace ownership and cloud obligations.
 */
export const HOSTED_CUSTOMER_DATA_TABLES: readonly CustomerDataTable[] = [
  table('papercusp_auth', 'hosted_users', {
    purpose: 'Hosted user accounts (one per person).',
    systemOfRecord: 'papercusp', retention: 'account',
    organizationLink: { via: 'user', column: 'id' },
    pii: 'primary_email display_name',
    operational: 'id status created_at updated_at last_authenticated_at deactivated_at deleted_at',
  }),
  table('papercusp_auth', 'external_identities', {
    purpose: 'Link from a hosted user to an identity-provider (WorkOS) user.',
    systemOfRecord: 'workos-mirror', retention: 'account',
    organizationLink: { via: 'user', column: 'hosted_user_id' },
    pii: 'subject provider_email profile',
    operational: 'id hosted_user_id provider status linked_at updated_at last_seen_at deactivated_at deleted_at',
  }),
  table('papercusp_auth', 'organizations', {
    purpose: 'Customer organizations (tenants).',
    systemOfRecord: 'papercusp', retention: 'account',
    organizationLink: { via: 'column', column: 'id' },
    pii: 'display_name',
    operational: 'id identity_provider external_organization_id status created_at updated_at activated_at suspended_at offboarding_at deleted_at',
  }),
  table('papercusp_auth', 'organization_memberships', {
    purpose: 'Which users belong to which organization, with role and authority.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    operational: 'id organization_id user_id role status authority created_via invitation_ref_id created_by_user_id activated_at suspended_at revoked_at created_at updated_at',
  }),
  table('papercusp_auth', 'organization_invitation_refs', {
    purpose: 'Pending and historical invitations (mirrors WorkOS invitations).',
    systemOfRecord: 'workos-mirror', retention: 'account', organizationLink: ORG,
    pii: 'invitee_email',
    operational: 'id organization_id identity_provider external_invitation_id intended_role status invited_by_user_id accepted_by_user_id provider_created_at expires_at accepted_at revoked_at created_at updated_at',
  }),
  table('papercusp_auth', 'organization_audit_events', {
    purpose: 'Organization audit trail (who did what, when).',
    systemOfRecord: 'papercusp', retention: 'audit', organizationLink: ORG,
    pii: 'metadata',
    operational: 'id organization_id workspace_id actor_kind actor_id action purpose target_type target_id occurred_at recorded_at',
  }),
  table('papercusp_auth', 'legal_acceptances', {
    purpose: 'Terms and privacy acceptances (document, version, time).',
    systemOfRecord: 'papercusp', retention: 'consent-proof', organizationLink: ORG,
    pii: 'evidence',
    operational: 'id organization_id user_id document_kind document_version acceptance_source accepted_at recorded_at',
  }),
  table('papercusp_auth', 'hosted_signup_attempts', {
    purpose: 'Self-signup attempt ledger: idempotency and per-email rate limits.',
    systemOfRecord: 'papercusp', retention: 'abuse-prevention', organizationLink: ORG,
    pii: 'subject email',
    access: 'session_id',
    operational: 'attempt_id provider fingerprint status user_id organization_id created_at updated_at',
  }),
  table('papercusp_auth', 'hosted_entitlements', {
    purpose: 'What an organization (or user in it) is entitled to.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    billing: 'kind source authority',
    operational: 'organization_id user_id authority_revision created_at',
  }),
  table('papercusp_auth', 'hosted_user_preferences', {
    purpose: 'Per-user, per-organization locale, time zone, profile and notification settings.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    pii: 'locale time_zone profile notification_preferences',
    operational: 'organization_id user_id created_at updated_at',
  }),
  table('papercusp_auth', 'hosted_sessions', {
    purpose: 'Hosted browser sessions; the cookie carries an HMAC-signed copy of id.',
    systemOfRecord: 'papercusp', retention: 'ephemeral', organizationLink: ORG,
    access: 'id upstream_session_id',
    operational: 'user_id organization_id workspace_id permission_version upstream_provider created_at rotated_at expires_at last_seen_at revoked_at revocation_reason updated_at',
  }),
  table('papercusp_auth', 'workos_sealed_sessions', {
    purpose: 'Vault of WorkOS sealed sessions backing hosted sessions.',
    systemOfRecord: 'workos-mirror', retention: 'ephemeral',
    organizationLink: { via: 'join', column: 'external_session_id', target: 'papercusp_auth.hosted_sessions.upstream_session_id' },
    access: 'external_session_id sealed_session',
    operational: 'expires_at created_at updated_at',
  }),
  table('papercusp_auth', 'workos_lifecycle_entity_cursors', {
    purpose: 'Per-entity ordering cursor for WorkOS lifecycle webhook projection.',
    systemOfRecord: 'workos-mirror', retention: 'provider-ledger',
    organizationLink: { via: 'none', note: 'keyed by provider entity (WorkOS user/organization id)' },
    pii: 'entity_key',
    operational: 'provider occurred_at event_version event_id updated_at',
  }),
  table('papercusp_auth', 'directory_group_role_mappings', {
    purpose: 'Customer-administrator approvals that members of a directory group may be provisioned with a role (P-004).',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    operational: 'id organization_id directory_id group_id role status approved_by_user_id approved_at removed_by_user_id removed_at created_at updated_at',
  }),
  table('papercusp_auth', 'directory_user_observations', {
    purpose: 'Ingested WorkOS Directory Sync user state and group membership; facts only, never authority (P-004).',
    systemOfRecord: 'workos-mirror', retention: 'account',
    organizationLink: { via: 'join', column: 'external_organization_id', target: 'papercusp_auth.organizations.external_organization_id' },
    pii: 'directory_user_id groups',
    operational: 'external_organization_id directory_id state first_observed_at updated_at',
  }),
  table('papercusp_auth', 'webhook_event_receipts', {
    purpose: 'Verified inbound identity-provider webhook ledger and processing state.',
    systemOfRecord: 'workos-mirror', retention: 'provider-ledger',
    organizationLink: { via: 'none', note: 'keyed by provider event id; subject_ref names the affected entity' },
    pii: 'subject_ref payload provider_account_id lifecycle_entity_key',
    operational: 'provider event_id event_type event_version event_created_at payload_sha256 signature_key_ref received_at verified_at enqueued_at processing_started_at processed_at status attempt_count last_attempt_at last_error_code retention_until lifecycle_cursor lifecycle_mutation closure_targets closure_acknowledged_at',
  }),
  table('papercusp_auth', 'hosted_cli_device_grants', {
    purpose: 'OAuth device-authorization grants for the papercusp CLI.',
    systemOfRecord: 'papercusp', retention: 'ephemeral', organizationLink: ORG,
    pii: 'client_label',
    access: 'device_code_hash user_code',
    operational: 'control_workspace_id state user_id organization_id created_at expires_at decided_at last_polled_at purpose install_id',
  }),
  table('papercusp_auth', 'hosted_cli_tokens', {
    purpose: 'Long-lived CLI bearer tokens (stored hashed).',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    pii: 'client_label',
    access: 'token_hash',
    operational: 'id control_workspace_id user_id organization_id created_at expires_at last_used_at revoked_at revocation_reason',
  }),
  table('papercusp_auth', 'hosted_mcp_oauth_clients', {
    purpose: 'Registered MCP OAuth clients for customer workspaces.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    access: 'client_secret_hash',
    operational: 'client_id control_workspace_id organization_id customer_workspace_id client_name redirect_uris token_endpoint_auth_method created_at last_used_at',
  }),
  table('papercusp_auth', 'hosted_mcp_oauth_requests', {
    purpose: 'In-flight MCP OAuth authorization requests.',
    systemOfRecord: 'papercusp', retention: 'ephemeral', organizationLink: ORG,
    access: 'handle_hash code_challenge oauth_state code_hash',
    operational: 'client_id control_workspace_id organization_id customer_workspace_id redirect_uri resource requested_scopes granted_scopes state approved_by code_expires_at created_at expires_at',
  }),
  table('papercusp_auth', 'hosted_workspace_connectors', {
    purpose: 'Registered workspace-host connectors (relay routes) per customer workspace.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    access: 'credential_hash',
    operational: 'control_workspace_id organization_id customer_workspace_id host_id route_label generation state transport registered_at heartbeat_at revoked_at created_at updated_at',
  }),
  table('papercusp_auth', 'hosted_workspace_connector_tickets', {
    purpose: 'Single-use tickets admitting a hosted session to a workspace connector.',
    systemOfRecord: 'papercusp', retention: 'ephemeral', organizationLink: ORG,
    access: 'ticket_hash hosted_session_id',
    operational: 'kind control_workspace_id organization_id customer_workspace_id host_id route_label generation user_id audience transport issued_at expires_at consumed_at',
  }),
  table('papercusp_auth', 'support_access_grants', {
    purpose: 'Customer-granted, time-boxed staff support access.',
    systemOfRecord: 'papercusp', retention: 'audit', organizationLink: ORG,
    operational: 'id organization_id workspace_id staff_principal_id granted_by_user_id purpose scopes banner_message starts_at expires_at revoked_at revoked_by_user_id revocation_reason created_at updated_at',
  }),
  table('papercusp_auth', 'tutorial_voice_reservations', {
    purpose: 'Per-day voice-minute reservations for the product tutorial.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    pii: 'provider_conversation_id',
    billing: 'maximum_seconds provider_limit_ref provider_final_ref',
    operational: 'id control_workspace_id organization_id user_id customer_workspace_id day created_at issuance_attempt_id',
  }),
  table('papercusp_auth', 'hosted_billing_customers', {
    purpose: 'Organization to Stripe customer mapping.',
    systemOfRecord: 'stripe-mirror', retention: 'billing-record', organizationLink: ORG,
    pii: 'reconciliation_checkpoint',
    billing: 'stripe_customer_id livemode',
    operational: 'organization_id created_at updated_at',
  }),
  table('papercusp_auth', 'hosted_subscriptions', {
    purpose: 'Webhook-synced mirror of Stripe subscriptions for fast entitlement checks.',
    systemOfRecord: 'stripe-mirror', retention: 'billing-record', organizationLink: ORG,
    billing: 'stripe_subscription_id stripe_customer_id livemode status price_id plan_key current_period_end cancel_at_period_end canceled_at sub_terminal sub_status_rank latest_invoice_id latest_invoice_status',
    operational: 'organization_id sub_event_created sub_event_id invoice_event_created invoice_event_id created_at updated_at',
  }),
  table('papercusp_auth', 'hosted_billing_webhook_events', {
    purpose: 'Stripe webhook receipt ledger (idempotency and outcome).',
    systemOfRecord: 'stripe-mirror', retention: 'billing-record', organizationLink: ORG,
    pii: 'api_observation',
    billing: 'provider_event_id event_type livemode outcome rejection_code',
    operational: 'body_digest fact_digest organization_id received_at',
  }),
  table('papercusp_auth', 'hosted_prepaid_allocations', {
    purpose: 'Prepaid (Stripe-funded) budget allocations to customer workspaces.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    billing: 'stripe_account_id allocation_id payment_transaction_id budget_key micros',
    operational: 'control_workspace_id organization_id binding_customer_workspace_id customer_workspace_id allocation_hash observed_at_ms evidence_ref received_at',
  }),
  table('papercusp_auth', 'hosted_usage_receipts', {
    purpose: 'Append-only usage and cost receipts per customer workspace.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    // A credential REFERENCE is access-shaped: it names where the OpenRouter key lives.
    access: 'openrouter_key_sha256 openrouter_credential_ref',
    billing: 'provider category payer quantity unit cost_source cost_micros openrouter_is_byok openrouter_budget_grant',
    operational: 'control_workspace_id organization_id customer_workspace_id record_id usage_id revision occurred_at_ms observed_at_ms source_ref received_at',
  }),
  table('papercusp_auth', 'hosted_budget_receipts', {
    purpose: 'Budget reservation and settlement receipts per customer workspace.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    billing: 'budget_key maximum_cost_micros provider_limit_ref cost_source cost_micros provider_final',
    operational: 'control_workspace_id organization_id customer_workspace_id reservation_id event_id revision month request_hash policy_id policy_revision observed_at_ms evidence_ref received_at',
  }),
  // Migration 1495 (enterprise readiness P-009, WI-10007904). recorded_by and the free-text
  // *_unknown_reason columns are classed pii because they are free-form actor/explanation text.
  table('papercusp_auth', 'hosted_budget_allocations', {
    purpose: 'Organization, department and project budget allocation revisions per month and cost class.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    pii: 'recorded_by',
    billing: 'level cost_class cap_micros max_unreconciled_micros',
    operational: 'control_workspace_id organization_id allocation_id revision parent_allocation_id month request_hash evidence_ref received_at',
  }),
  table('papercusp_auth', 'hosted_budget_allocation_holds', {
    purpose: 'Budget holds charged against an allocation, one immutable revision per observation.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    billing: 'cost_class maximum_cost_micros cost_source cost_micros provider_final',
    operational: 'control_workspace_id organization_id reservation_id revision allocation_id month request_hash observed_at_ms evidence_ref received_at',
  }),
  table('papercusp_auth', 'hosted_outcome_cost_records', {
    purpose: 'Pilot outcome cost records: result cost, review effort and rework per workflow outcome.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    pii: 'recorded_by result_unknown_reason result_cost_unknown_reason review_effort_unknown_reason rework_unknown_reason',
    billing: 'result_cost_micros',
    operational: 'control_workspace_id organization_id outcome_id revision allocation_id workflow_ref evidence_class result_state reservation_ids review_effort_seconds rework_count observed_at_ms evidence_ref received_at',
  }),
  table('papercusp_auth', 'hosted_app_relay_usage', {
    purpose: 'Monthly app-relay traffic counters per customer workspace.',
    systemOfRecord: 'papercusp', retention: 'billing-record', organizationLink: ORG,
    billing: 'bytes requests',
    operational: 'control_workspace_id organization_id customer_workspace_id month updated_at',
  }),
  table('papercusp_auth', 'users', {
    purpose: 'Legacy pre-hosted user table (empty in production).',
    systemOfRecord: 'papercusp', retention: 'legacy-empty',
    organizationLink: { via: 'none', note: 'legacy; no organization model' },
    pii: 'email display_name github_login',
    operational: 'id created_ts last_login_ts',
  }),
  table('papercusp_auth', 'sessions', {
    purpose: 'Legacy pre-hosted session table (empty in production).',
    systemOfRecord: 'papercusp', retention: 'legacy-empty',
    organizationLink: { via: 'none', note: 'legacy; keyed by legacy users.id' },
    pii: 'user_agent ip',
    access: 'id',
    operational: 'user_id created_ts expires_ts',
  }),
  table('papercusp_auth', 'magic_link_requests', {
    purpose: 'Legacy magic-link sign-in requests (empty in production).',
    systemOfRecord: 'papercusp', retention: 'legacy-empty',
    organizationLink: { via: 'none', note: 'legacy; keyed by email' },
    pii: 'email ip',
    access: 'token',
    operational: 'created_ts expires_ts consumed_ts',
  }),
  table('harness_shared', 'customer_workspaces', {
    purpose: 'Customer workspace ownership, lifecycle policy and billing owner.',
    systemOfRecord: 'papercusp', retention: 'account', organizationLink: ORG,
    pii: 'display_name',
    billing: 'monthly_lifecycle_budget_cents billing_owner_kind billing_owner_id',
    operational: 'workspace_id id organization_id workspace_host_id state created_by_principal_kind created_by_principal_id created_at updated_at deleted_at tenant_concurrency_limit provider_concurrency_limit lifecycle_budget_period_started_at idle_stop_after_minutes last_activity_at lifecycle_policy_updated_at kind linked_install_id hosted_host_id',
  }),
  table('harness_shared', 'cloud_resource_obligations', {
    purpose: 'Cloud resources Papercusp owes teardown for (customer workspace VMs and disks).',
    systemOfRecord: 'papercusp', retention: 'audit',
    organizationLink: { via: 'none', note: 'keyed by cloud resource; tied to a workspace host via host_id' },
    operational: 'id workspace_id provider resource_kind resource_id project_id purpose created_by_owner_id source_work_item_id created_at grace_ms teardown_owed closed_at closed_reason last_escalated_at escalation_work_item_id updated_at zone region parent_resource_id host_id incarnation_id',
  }),
];

/**
 * Non-customer tables the hosted control plane reads or writes, so a production cut
 * (P-004/P-005) must either carry them into the hosted database or replace the
 * dependency. Source: code trace of every non-test file referencing `papercusp_auth.`
 * plus a live sample of the hosted control plane's queries (2026-10-13). Not pinned to
 * columns: they are listed so the signup-journey write-set check treats them as named.
 */
export const HOSTED_PATH_DEPENDENCY_TABLES: readonly { readonly qualified: string; readonly role: string }[] = [
  { qualified: 'harness_shared.workspace_hosts', role: 'workspace host registry for customer workspaces' },
  { qualified: 'harness_shared.workspace_host_resources', role: 'cloud resources per workspace host' },
  { qualified: 'harness_shared.workspace_host_operations', role: 'host lifecycle operations' },
  { qualified: 'harness_shared.workspace_host_events', role: 'host lifecycle events' },
  { qualified: 'harness_shared.workspace_host_logs', role: 'host provisioning logs (may echo customer workspace names)' },
  { qualified: 'harness_shared.workspace_host_initialization_steps', role: 'host bootstrap progress' },
  { qualified: 'harness_shared.workspace_host_connections', role: 'host connection state' },
  { qualified: 'harness_shared.money_journal_entries', role: 'billing ledger (customer spend)' },
  { qualified: 'harness_shared.money_journal_lines', role: 'billing ledger lines' },
  { qualified: 'harness_shared.money_journal_rollups', role: 'billing ledger rollups' },
  { qualified: 'harness_shared.money_journal_micro_accruals', role: 'billing ledger sub-cent accruals' },
  { qualified: 'harness_shared.payment_receipts', role: 'payment receipts' },
  { qualified: 'harness_shared.connected_apps', role: 'connected-app registry' },
  { qualified: 'harness_shared.connected_app_auth_failures', role: 'connected-app auth failure ledger' },
  { qualified: 'harness_shared.connected_app_removed_creators', role: 'connected-app creator removals' },
  { qualified: 'harness_shared.operator_flag_overrides', role: 'feature flags' },
  { qualified: 'harness_shared.harness_status', role: 'harness status read' },
  { qualified: 'harness_shared.harness_lanes', role: 'harness lanes read' },
  { qualified: 'harness_shared.harness_features_consolidated', role: 'feature catalogue read (a view)' },
  { qualified: 'harness_shared.adv_sessions', role: 'agent session read' },
  { qualified: 'harness_shared.tool_invocations', role: 'tool invocation ledger (writes from hosted MCP paths)' },
  { qualified: 'harness_shared.route_invocations', role: 'route invocation ledger' },
  { qualified: 'harness_shared.cache_l2', role: 'shared L2 cache (live sample)' },
];

/** Schemas whose every table must appear in {@link HOSTED_CUSTOMER_DATA_TABLES}. */
export const HOSTED_CUSTOMER_SCHEMAS: readonly string[] = ['papercusp_auth'];

export function qualifiedName(t: Pick<CustomerDataTable, 'schema' | 'table'>): string {
  return `${t.schema}.${t.table}`;
}

const BY_QUALIFIED = new Map(HOSTED_CUSTOMER_DATA_TABLES.map((t) => [qualifiedName(t), t] as const));
const DEPENDENCIES = new Set(HOSTED_PATH_DEPENDENCY_TABLES.map((d) => d.qualified));

export function customerDataTable(qualified: string): CustomerDataTable | undefined {
  return BY_QUALIFIED.get(qualified);
}

/** True when the map names the table, as customer data or as a hosted-path dependency. */
export function dataMapNamesTable(qualified: string): boolean {
  return BY_QUALIFIED.has(qualified) || DEPENDENCIES.has(qualified);
}

/** The class of one column, or undefined when the column is not in the map. */
export function classifyCustomerColumn(qualified: string, column: string): CustomerDataClass | undefined {
  const t = BY_QUALIFIED.get(qualified);
  if (!t) return undefined;
  for (const cls of CUSTOMER_DATA_CLASSES) {
    if (t.columns[cls].includes(column)) return cls;
  }
  return undefined;
}
