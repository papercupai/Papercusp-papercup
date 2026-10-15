/**
 * hosted-relay-confidentiality-registry.ts — the P-001 census of what the hosted
 * relays carry (plan hosted-byoc-confidentiality-correction-2026-10-02).
 *
 * One typed registry that classifies, BY SENSITIVITY (not by table or file), every
 * frame type on the four hosted content planes — workspace-session (PTY + files),
 * operator-http, app-http and desktop-viewer — plus the relay envelope itself, and
 * the registered audit, telemetry, workspace-host storage and configuration fields.
 * The source guard is bounded to its named writers; unexercised sinks stay unknown.
 *
 *  - `content`: customer content. For a `byoc` workspace the control plane must
 *    never see it in plaintext (D-001/D-003). The sealed channel (P-004) carries it
 *    opaquely; the allowlist enforcement (P-005) refuses to persist or log it.
 *  - `control`: allowlisted control metadata the control plane may route on and
 *    record. A control frame can still carry a content-bearing FIELD; those are
 *    listed in `contentFields` and must be stripped or sealed by P-005.
 *
 * `hosted-relay-confidentiality-registry.test.ts` pins this against source: a new
 * frame type literal or a new audit-event field that is not classified here fails
 * the build. Census method and findings: see `PLAINTEXT_CONSUMERS` below.
 */

export type HostedRelayPlane = 'envelope' | 'workspace-session' | 'operator-http' | 'app-http' | 'device-http' | 'desktop-viewer';
export type HostedRelaySensitivity = 'content' | 'control';

export interface HostedRelayFrameClass {
  planes: readonly HostedRelayPlane[];
  sensitivity: HostedRelaySensitivity;
  /** Fields of a `control` frame that nonetheless carry customer content. */
  contentFields?: readonly string[];
  note: string;
}

export const HOSTED_RELAY_FRAME_REGISTRY: Readonly<Record<string, HostedRelayFrameClass>> = {
  // ── Envelope (broker ⇄ connector ⇄ browser routing) ──
  relay: { planes: ['envelope'], sensitivity: 'content', note: 'wrapper; `payload` is an inner frame and inherits its class — opaque under the sealed channel' },
  'relay.open': { planes: ['envelope'], sensitivity: 'control', note: 'channel id, kind, role, session/desktop ids' },
  'relay.close': { planes: ['envelope'], sensitivity: 'control', note: 'channel id + reason code' },
  'relay.role': { planes: ['envelope'], sensitivity: 'control', note: 'controller/observer flip' },
  bound: { planes: ['envelope'], sensitivity: 'control', note: 'connector binding (org/workspace/host/generation)' },
  'session.bound': { planes: ['envelope'], sensitivity: 'control', note: 'browser channel binding' },
  'session.authorize': { planes: ['envelope'], sensitivity: 'control', note: 'host-only channel/session authority query; nonce, no customer content' },
  'session.authorized': { planes: ['envelope'], sensitivity: 'control', note: 'current channel-bound identity/version/permissions or denial; no cookie, key or prompt' },
  'session.denied': { planes: ['envelope'], sensitivity: 'control', note: 'refusal reason + requestType' },
  'session.role': { planes: ['envelope'], sensitivity: 'control', note: 'role notification' },
  'session.claim-control': { planes: ['envelope'], sensitivity: 'control', note: 'takeover request' },
  'session.detach': { planes: ['envelope'], sensitivity: 'control', note: 'browser detach' },
  'membership.report': { planes: ['envelope'], sensitivity: 'control', note: 'host membership/liveness report' },
  'operation.error': { planes: ['workspace-session', 'desktop-viewer'], sensitivity: 'control', contentFields: ['message'], note: 'error code is control; free-text message can echo paths/output' },
  // ── workspace-session: PTY ──
  'pty.input': { planes: ['workspace-session'], sensitivity: 'content', note: 'keystrokes' },
  'pty.output': { planes: ['workspace-session'], sensitivity: 'content', note: 'terminal output' },
  'pty.snapshot': { planes: ['workspace-session'], sensitivity: 'content', note: 'scrollback replay' },
  'pty.ready': { planes: ['workspace-session'], sensitivity: 'control', note: 'session key + role; no output' },
  'pty.exit': { planes: ['workspace-session'], sensitivity: 'control', note: 'exit code/signal' },
  'pty.resize': { planes: ['workspace-session'], sensitivity: 'control', note: 'cols/rows' },
  'pty.signal': { planes: ['workspace-session'], sensitivity: 'control', note: 'signal name' },
  'pty.kill': { planes: ['workspace-session'], sensitivity: 'control', note: 'kill request' },
  // ── workspace-session: files ──
  'file.list': { planes: ['workspace-session'], sensitivity: 'content', note: 'directory path requested' },
  'file.read': { planes: ['workspace-session'], sensitivity: 'content', note: 'path' },
  'file.write': { planes: ['workspace-session'], sensitivity: 'content', note: 'path + bytes' },
  'file.upload': { planes: ['workspace-session'], sensitivity: 'content', note: 'path + bytes' },
  'file.download': { planes: ['workspace-session'], sensitivity: 'content', note: 'path' },
  'file.result': { planes: ['workspace-session'], sensitivity: 'content', note: 'listings / file bytes' },
  'file.progress': { planes: ['workspace-session'], sensitivity: 'content', note: 'carries path alongside byte counts' },
  // ── operator-http + app-http (shared wire, hosted-operator-http.ts) ──
  'http.request': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'content', note: 'method, path, headers, body' },
  'http.response': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'content', note: 'status + headers' },
  'http.body': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'content', note: 'body chunks' },
  'http.end': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'control', note: 'stream end' },
  'http.abort': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'control', note: 'client abort' },
  'http.ready': { planes: ['operator-http'], sensitivity: 'control', note: 'channel ready' },
  'http.error': { planes: ['operator-http', 'app-http', 'device-http'], sensitivity: 'control', contentFields: ['message'], note: 'code is control; message may echo a path' },
  // ── app-http: key mint + OAuth token relay ──
  'mint.request': { planes: ['app-http'], sensitivity: 'content', note: 'scopes + approver; yields a secret' },
  'mint.issued': { planes: ['app-http'], sensitivity: 'content', note: 'carries a pcapp_ secret' },
  'mint.error': { planes: ['app-http'], sensitivity: 'control', note: 'error code' },
  'token.request': { planes: ['app-http'], sensitivity: 'content', note: 'client credentials' },
  'token.answer': { planes: ['app-http'], sensitivity: 'content', note: 'carries a pcat_ token' },
  // ── desktop-viewer ──
  open: { planes: ['desktop-viewer'], sensitivity: 'control', note: 'viewer socket open' },
  'desktop.start': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'desktop id + mode' },
  'desktop.start.result': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'start outcome' },
  'desktop.ready': { planes: ['desktop-viewer'], sensitivity: 'control', note: '`action` read by the broker audit' },
  'desktop.data': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'VNC framebuffer + input bytes' },
  'desktop.roster': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'roster request' },
  'desktop.roster.result': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'session titles/labels' },
  'desktop.thumbnail': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'thumbnail request' },
  'desktop.thumbnail.result': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'screen image' },
};

/** Control-plane fields recorded about workspace traffic, by sink. */
export interface HostedControlPlaneFieldClass {
  sensitivity: HostedRelaySensitivity;
  note: string;
}

export const HOSTED_CONTROL_PLANE_FIELD_REGISTRY: Readonly<Record<string, Readonly<Record<string, HostedControlPlaneFieldClass>>>> = {
  /** Broker audit (`HostedWorkspaceSessionAuditEvent`, hosted-workspace-session.ts). */
  'broker-audit': {
    action: { sensitivity: 'control', note: 'lifecycle action OR the relayed frame type (one row per client frame — timing side channel, not content)' },
    controlPlaneWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    organizationId: { sensitivity: 'control', note: 'tenant id' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    hostId: { sensitivity: 'control', note: 'host id' },
    generation: { sensitivity: 'control', note: 'binding generation' },
    userId: { sensitivity: 'control', note: 'principal' },
    hostedSessionId: { sensitivity: 'control', note: 'session id' },
    channelId: { sensitivity: 'control', note: 'channel id' },
    detail: { sensitivity: 'control', note: 'reason code / desktop id / reported mode — never payload' },
  },
  /** Host-side audit (`HostedHostAuditEvent`) — lands in the host DB, not the control plane. */
  'host-audit': {
    action: { sensitivity: 'control', note: 'action' },
    organizationId: { sensitivity: 'control', note: 'tenant id' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    hostId: { sensitivity: 'control', note: 'host id' },
    generation: { sensitivity: 'control', note: 'generation' },
    userId: { sensitivity: 'control', note: 'principal' },
    hostedSessionId: { sensitivity: 'control', note: 'session id' },
    channelId: { sensitivity: 'control', note: 'channel id' },
    detail: { sensitivity: 'control', note: 'code' },
  },
  /** Portal app-relay audit (`HostedAppRelayAuditEvent`). */
  'app-relay-audit': {
    action: { sensitivity: 'control', note: 'refused | request' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    detail: { sensitivity: 'control', note: 'refusal code or `<method> <status>`; never path/header/key/body' },
  },
  /**
   * Both INSERT writers in endpoint-route/telemetry.ts. Classification is not
   * permission to persist content vendor-side: customer-only fields still need
   * an applicable hosting boundary and an assembled sink check (carrier R-7).
   */
  'route-invocations': {
    workspace_id: { sensitivity: 'control', note: 'workspace identity' },
    method: { sensitivity: 'control', note: 'registered HTTP method or INTERNAL' },
    path: { sensitivity: 'control', note: 'registered route template or fixed internal routing label' },
    status: { sensitivity: 'control', note: 'execution outcome' },
    duration_ms: { sensitivity: 'control', note: 'elapsed time' },
    invoked_at: { sensitivity: 'control', note: 'invocation timestamp' },
    principal_kind: { sensitivity: 'control', note: 'principal class, not principal credentials' },
    principal_auth_method: { sensitivity: 'control', note: 'authentication method, not its credential' },
    principal_trust: { sensitivity: 'control', note: 'principal trust class' },
    response_bytes: { sensitivity: 'control', note: 'response size, never response bytes' },
    resolved_path: { sensitivity: 'content', note: 'customer-selected path parameters; customer-side unless an exact metadata allowlist is enforced' },
    error_message: { sensitivity: 'content', note: 'route writer emits status labels, but internal routing writer supplies receipt.errorCode; requires field-level allowlisting before vendor persistence' },
    metadata_json: { sensitivity: 'content', note: 'complete expertise routing receipt; transitive customer fields are not approved by the table name' },
  },
  'app-relay-usage': {
    control_workspace_id: { sensitivity: 'control', note: 'Control-plane workspace identity.' },
    organization_id: { sensitivity: 'control', note: 'Organization identity.' },
    customer_workspace_id: { sensitivity: 'control', note: 'Customer workspace identity.' },
    month: { sensitivity: 'control', note: 'UTC billing month.' },
    bytes: { sensitivity: 'control', note: 'Byte count, never request or response bytes.' },
    requests: { sensitivity: 'control', note: 'Request count.' },
    updated_at: { sensitivity: 'control', note: 'Counter update timestamp.' },
  },
  'workspace-connectors': {
    control_workspace_id: { sensitivity: 'control', note: 'Bound control workspace identity.' },
    organization_id: { sensitivity: 'control', note: 'Bound organization identity.' },
    customer_workspace_id: { sensitivity: 'control', note: 'Bound customer workspace identity.' },
    host_id: { sensitivity: 'control', note: 'Bound host identity.' },
    generation: { sensitivity: 'control', note: 'Revocable connector generation.' },
    credential_hash: { sensitivity: 'control', note: 'Gateway-generated SHA-256 verifier; never the connector bearer.' },
    state: { sensitivity: 'control', note: 'Connector lifecycle enum.' },
    transport: { sensitivity: 'control', note: 'Connector transport enum.' },
    registered_at: { sensitivity: 'control', note: 'Registration timestamp.' },
    heartbeat_at: { sensitivity: 'control', note: 'Liveness timestamp.' },
    revoked_at: { sensitivity: 'control', note: 'Revocation timestamp.' },
    updated_at: { sensitivity: 'control', note: 'Mutation timestamp.' },
    route_label: { sensitivity: 'content', note: 'Customer-selected routing label; routing use alone does not approve vendor retention.' },
  },
  'connector-tickets': {
    ticket_hash: { sensitivity: 'control', note: 'Gateway-generated SHA-256 verifier; never the enrollment/session ticket.' },
    kind: { sensitivity: 'control', note: 'Enrollment/session enum.' },
    control_workspace_id: { sensitivity: 'control', note: 'Bound control workspace identity.' },
    organization_id: { sensitivity: 'control', note: 'Bound organization identity.' },
    customer_workspace_id: { sensitivity: 'control', note: 'Bound customer workspace identity.' },
    host_id: { sensitivity: 'control', note: 'Bound host identity.' },
    generation: { sensitivity: 'control', note: 'Revocable connector generation.' },
    user_id: { sensitivity: 'control', note: 'Bound principal identity.' },
    hosted_session_id: { sensitivity: 'control', note: 'Bound hosted session identity.' },
    transport: { sensitivity: 'control', note: 'Connector transport enum.' },
    issued_at: { sensitivity: 'control', note: 'Ticket issue timestamp.' },
    expires_at: { sensitivity: 'control', note: 'Ticket expiry timestamp.' },
    consumed_at: { sensitivity: 'control', note: 'Atomic ticket consumption timestamp.' },
    route_label: { sensitivity: 'content', note: 'Customer-selected routing label.' },
    audience: { sensitivity: 'content', note: 'String supplied to the ticket writer; vendor eligibility requires an exact audience allowlist.' },
  },
  'desktop-audit-row': {
    id: { sensitivity: 'control', note: 'Generated audit identity.' },
    ts: { sensitivity: 'control', note: 'Audit timestamp.' },
    workspaceId: { sensitivity: 'control', note: 'Database tenant identity.' },
    actor: { sensitivity: 'content', note: 'Shared writer accepts arbitrary actor text; resolve the calling adapter.' },
    action: { sensitivity: 'content', note: 'Shared writer accepts arbitrary action text; hosted adapter maps two registered actions.' },
    subject: { sensitivity: 'content', note: 'Shared writer accepts arbitrary subject text, including customer-selected scope/reference.' },
    details: { sensitivity: 'content', note: 'Shared JSON object writer; nested fields need their own classification.' },
  },
  'hosted-desktop-audit-details': {
    target: { sensitivity: 'control', note: 'Fixed hosted target.' },
    organizationId: { sensitivity: 'control', note: 'Bound organization identity.' },
    customerWorkspaceId: { sensitivity: 'control', note: 'Bound customer workspace identity.' },
    hostId: { sensitivity: 'control', note: 'Bound host identity.' },
    generation: { sensitivity: 'control', note: 'Connector generation.' },
    userId: { sensitivity: 'control', note: 'Bound principal identity.' },
    hostedSessionId: { sensitivity: 'control', note: 'Bound session identity.' },
    channelId: { sensitivity: 'control', note: 'Bound channel identity.' },
    detail: { sensitivity: 'content', note: 'Free-text detail reaches JSON persistence; adapter classification is not an allowlist.' },
  },
  'desktop-audit-warnings': {
    'warn.0.argument.0': { sensitivity: 'control', note: 'Fixed warning prefix.' },
    'warn.0.argument.1': { sensitivity: 'control', note: 'Fixed desktop_audit_write_failed code; never database bindings or error text.' },
  },
  'hosted-handler-warnings': {
    'warn.0.argument.0': { sensitivity: 'control', note: 'Fixed desktop audit warning prefix.' },
    'warn.0.argument.1': { sensitivity: 'control', note: 'Fixed desktop_audit_write_failed code.' },
    'warn.1.argument.0': { sensitivity: 'control', note: 'Fixed connector liveness warning prefix.' },
    'warn.1.argument.1': { sensitivity: 'control', note: 'Enumerated alive/gone write failure code; no customer or database text.' },
  },
  'route-invocation-warnings': {
    'warn.0.argument.0': { sensitivity: 'control', note: 'Fixed once-only telemetry warning prefix; no route or database error text.' },
    'warn.0.argument.1': { sensitivity: 'control', note: 'Fixed route_telemetry_write_failed code; never database bindings or error text.' },
  },
  'customer-host-warnings': {
    'warn.0.argument.0': { sensitivity: 'control', note: 'Fixed audit warning prefix.' },
    'warn.0.argument.1': { sensitivity: 'control', note: 'Fixed desktop_audit_write_failed code.' },
    'warn.1.argument.0': { sensitivity: 'control', note: 'Fixed relay usage warning prefix.' },
    'warn.1.argument.1': { sensitivity: 'control', note: 'Fixed relay_usage_report_failed code.' },
    'warn.2.argument.0': { sensitivity: 'control', note: 'Fixed membership warning prefix.' },
    'warn.2.argument.1': { sensitivity: 'control', note: 'Fixed membership_report_failed code.' },
    'warn.3.argument.0': { sensitivity: 'content', note: 'Runtime onWarning configuration diagnostics; customer-local input, not approved vendor metadata.' },
  },
  'workspace-host-connections': {
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    target: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    last_validated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    disk_price_per_gib_month: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    authenticated_identity: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    credential_ref: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    images: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    label: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    networks: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    provider_config: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    regions: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    scopes: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    sizes: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    status_detail: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-hosts': {
    bootstrap_version: { sensitivity: 'content', note: 'Host-reported release/version text; vendor eligibility requires an exact artifact metadata allowlist.' },
    connection_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    controller_fence: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    controller_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    desired_revision: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    desired_state: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    disk_gib: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    estimated_monthly_usd: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    health_attested_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    health_status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    host_generation: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    observed_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    observed_revision: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    observed_state: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    recoverability_kind: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    recoverability_updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    target: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    tunnel_status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    cost_signals: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    desired_spec: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    endpoint: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    health_checks: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    image: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    name: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    network: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    quota_signals: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    recoverability_label: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    region: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    runtime_release: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    scope_label: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    size: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-host-operations': {
    action: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    approval_status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    approved_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    approved_by_principal_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    billing_owner_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    billing_owner_kind: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    controller_fence: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    controller_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    cost_currency: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    cost_estimate_source: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    cost_estimated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    customer_workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    desired_revision: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    emergency_teardown: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    estimated_cost_cents: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    finished_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    heartbeat_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    host_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    organization_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    orphaned_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    percent: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    provider_target: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    recovery_attempts: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    recovery_state: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    risk_tier: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    started_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    cost_estimate_ref: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    error: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    message: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    request: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    teardown_reason: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-host-resources': {
    attempts: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    host_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    operation_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    retry_after_ms: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    retry_class: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    state: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    target: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    deletion_confirmation: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    error: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    kind: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    logical_key: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    parent_provider_id: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    provider_id: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    provider_request_id: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    region: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    zone: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-host-events': {
    host_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    level: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    occurred_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    operation_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    phase: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    source: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    details: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    message: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-host-logs': {
    host_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    level: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    observed_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    operation_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    stream: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    message: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    metadata: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    unit: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'workspace-host-initialization-steps': {
    created_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    host_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    idempotency_key: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    lease_expires_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    lease_owner: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    observed_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    status: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    step_fingerprint: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    step_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    updated_at: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    workspace_id: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    public_evidence: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },
  'vendor-runtime-config': {
    PAPERCUSP_HOSTED_FIRST_WORKSPACE_ORGANIZATIONS: { sensitivity: 'content', note: 'Structured customer/organization configuration; this is a vendor runtime input, not a persistence claim.' },
    PAPERCUSP_HOSTED_PUBLIC_ORIGIN: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    WORKOS_CLIENT_ID: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    WORKOS_API_KEY_REF: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    WORKOS_COOKIE_PASSWORD_REF: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    WORKOS_WEBHOOK_SECRET_REF: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    WORKOS_WEBHOOK_SECRET_KEY_REF: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
  },
  'customer-host-config': {
    PAPERCUSP_HOSTED_CONTROL_PLANE_URL: { sensitivity: 'control', note: 'Bounded control identity, enum, timestamp or numeric observation; classification does not prove placement.' },
    PAPERCUSP_HOSTED_CONNECTOR_BEARER: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
    PAPERCUSP_HOSTED_WORKSPACE_ROOT: { sensitivity: 'content', note: 'Customer-selected text or structured observation; secret redaction does not make it approved vendor metadata.' },
  },

};


/**
 * Source-bound population for the existing field census. These are writer/input
 * locations, not runtime enforcement or a claim that any content reached a vendor.
 * Controller rows may be on a customer host or a hosted controller: resolve that
 * placement before approving content fields. Configuration entries are inputs.
 */
export const HOSTED_CONTROL_PLANE_WRITER_REGISTRY = {
  'app-relay-usage': {
    table: 'papercusp_auth.hosted_app_relay_usage',
    sources: ['packages/operator-core/lib/workspace-host/hosted-app-relay.ts'],
    placement: 'vendor-hosted-service-database',
  },
  'workspace-connectors': {
    table: 'papercusp_auth.hosted_workspace_connectors',
    sources: ['packages/operator-core/lib/endpoint-route/hosted-workspace-connector.ts'],
    placement: 'vendor-hosted-service-database',
  },
  'connector-tickets': {
    table: 'papercusp_auth.hosted_workspace_connector_tickets',
    sources: ['packages/operator-core/lib/endpoint-route/hosted-workspace-connector.ts'],
    placement: 'vendor-hosted-service-database',
  },
  'desktop-audit-row': {
    drizzleTable: 'generated.auditLogInHarnessShared',
    sources: ['packages/operator-core/lib/desktop/desktop-audit.ts'],
    placement: 'calling-operator-database',
  },
  'hosted-desktop-audit-details': {
    objectFunction: 'hostedDesktopAuditRow',
    objectVariable: 'details',
    sources: ['packages/operator-core/lib/desktop/desktop-audit.ts'],
    placement: 'vendor-and-customer-host-audit-databases',
  },
  'desktop-audit-warnings': {
    console: true,
    sources: ['packages/operator-core/lib/desktop/desktop-audit.ts'],
    placement: 'calling-operator-console',
  },
  'hosted-handler-warnings': {
    console: true,
    sources: ['apps/operator/bin/hosted-handler.ts'],
    placement: 'vendor-hosted-handler-console',
  },
  'customer-host-warnings': {
    console: true,
    sources: ['packages/operator-core/lib/workspace-host/hosted-workspace-host-runtime.ts'],
    placement: 'customer-host-console',
  },
  'route-invocation-warnings': {
    console: true,
    sources: ['packages/operator-core/lib/endpoint-route/telemetry.ts'],
    placement: 'serving-operator-console',
  },
  'route-invocations': {
    table: 'harness_shared.route_invocations',
    sources: ['packages/operator-core/lib/endpoint-route/telemetry.ts'],
    placement: 'serving-operator-database',
  },
  'workspace-host-connections': {
    table: 'harness_shared.workspace_host_connections',
    sources: ['packages/operator-core/lib/workspace-host/observability-store.ts'],
    placement: 'controller-database',
  },
  'workspace-hosts': {
    table: 'harness_shared.workspace_hosts',
    sources: [
      'packages/operator-core/lib/workspace-host/observability-store.ts',
      'packages/operator-core/lib/workspace-host/hosted-lifecycle-store.ts',
    ],
    placement: 'controller-database',
  },
  'workspace-host-operations': {
    table: 'harness_shared.workspace_host_operations',
    sources: [
      'packages/operator-core/lib/workspace-host/observability-store.ts',
      'packages/operator-core/lib/workspace-host/hosted-lifecycle-store.ts',
    ],
    placement: 'controller-database',
  },
  'workspace-host-resources': {
    table: 'harness_shared.workspace_host_resources',
    sources: ['packages/operator-core/lib/workspace-host/observability-store.ts'],
    placement: 'controller-database',
  },
  'workspace-host-events': {
    table: 'harness_shared.workspace_host_events',
    sources: ['packages/operator-core/lib/workspace-host/observability-store.ts'],
    placement: 'controller-database',
  },
  'workspace-host-logs': {
    table: 'harness_shared.workspace_host_logs',
    sources: ['packages/operator-core/lib/workspace-host/observability-store.ts'],
    placement: 'controller-database',
  },
  'workspace-host-initialization-steps': {
    table: 'harness_shared.workspace_host_initialization_steps',
    sources: ['packages/operator-core/lib/workspace-host/initialization-replay-store.ts'],
    placement: 'controller-database',
  },
  'vendor-runtime-config': {
    sources: ['packages/operator-core/lib/endpoint-route/hosted-runtime.ts'],
    placement: 'vendor-runtime-environment',
  },
  'customer-host-config': {
    sources: ['packages/operator-core/lib/workspace-host/hosted-workspace-host-runtime.ts'],
    placement: 'customer-host-environment',
  },
} as const;

/**
 * Census finding: every place the CONTROL PLANE reads a relayed payload today.
 * D-003 says the relay refuses plaintext byoc content; any entry with
 * `readsContent: true` is a consumer that P-004/P-005 must relocate or remove.
 */
export const PLAINTEXT_CONSUMERS: ReadonlyArray<{ site: string; reads: string; readsContent: boolean; disposition: string }> = [
  { site: 'hosted-workspace-session.ts payloadType()', reads: 'inner frame `type`', readsContent: false, disposition: 'needs the frame type in clear: keep `type` outside the sealed box (control metadata)' },
  { site: 'hosted-workspace-session.ts auditDesktopReady()', reads: '`desktop.ready.action`', readsContent: false, disposition: 'control metadata; keep in clear or derive from broker role alone' },
  { site: 'hosted-app-relay.ts handleHostedAppRelay() (portal)', reads: 'Authorization (app-key shape), URL path, body size, webhook path/signature headers', readsContent: true, disposition: 'app-http is a third-party-app ingress the portal terminates by design — see plan Decision on app-http scope' },
  { site: 'hosted-app-relay.ts portal token relay', reads: 'client-credentials request + pcat_ token answer body', readsContent: true, disposition: 'same app-http Decision' },
];
