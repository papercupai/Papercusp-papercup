/**
 * The `app-http` relay plane (plan external-app-access-to-workspaces-2026-09-29
 * P-007, WI-10004018): an outside app calls a workspace's tools through the hosted
 * portal, which carries the call over the workspace's outbound connector to the
 * machine. No port forwarding, and the portal never dials a machine address.
 *
 *   app → portal  POST /api/workspaces/<id>/agent-tools/<group>/<verb>
 *                 POST|GET|DELETE /api/workspaces/<id>/mcp
 *   portal → machine (over the connector)  the same call at /api/agent-tools/… or /api/mcp
 *
 * ## Where each check happens
 *
 * The portal cannot verify an app key: only `sha256(secret)` is stored, and it is
 * stored on the MACHINE (P-002). So the checks split:
 *
 *  - PORTAL ({@link handleHostedAppRelay}): the credential is an app key by SHAPE
 *    (`Bearer pcapp_…`), so an owner or admin ticket, or a cookie session, is refused
 *    before anything else (D-005); the workspace's connector has a fresh heartbeat, or
 *    the call is refused AT ONCE as `workspace_offline` — nothing is queued, held or
 *    stored (D-008); per-workspace request-rate and monthly-bandwidth limits (D-006).
 *  - MACHINE ({@link createAppHttpChannel}): a default-deny route allowlist (only the
 *    app routes), the app's `Authorization` forwarded ONLY when it is app-key shaped,
 *    and the deny-only ingress marker stamped on every forward, so the operator never
 *    grants the call loopback trust (R-7, D-015). The operator's bearer chain then makes
 *    the authoritative key and scope check (P-002, P-003), and refuses an owner ticket
 *    on its own authority as well.
 *
 * The wire is the `operator-http` one (hosted-operator-http.ts); an `app-http`
 * channel carries exactly one request.
 */
import type { Sql } from 'postgres';
import type { RelayUsageReport } from '../connected-apps/alert-sweep';
import { isAppKeyShaped, parseAppKey } from '../connected-apps/key';
import { isRelayableTokenAnswer, relayedBasic, relayedTokenFields } from '../connected-apps/mcp-oauth';
import { publicOriginOf } from '../connected-apps/mcp-oauth-discovery';
// portal-mcp-oauth imports this module for TYPES only, so this runtime import makes no cycle.
import { portalResourceMetadataUrl } from '../connected-apps/portal-mcp-oauth';
import { EXTERNAL_INGRESS_MARKER_HEADER } from '../auth/forwarded-request-trust';
import { PHONE_DEVICE_METHODS, PHONE_DEVICE_PAIR_PATH, PHONE_DEVICE_PATHS, PHONE_DEVICE_PATH_SHAPES } from '../device-ingress-paths';
import { isHostedConnectorLive } from '../endpoint-route/hosted-workspace-connector';
import { WEBHOOK_PATH_RE, WEBHOOK_SOURCE_ID_PATTERN, isWebhookPath } from '../external-triggers/webhook-path';
import {
  HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES,
  OperatorHttpChannel,
  decideRelayRoute,
  localOperatorOrigin,
  type OperatorHttpAudit,
  type OperatorHttpBodyDecision,
  type OperatorHttpFetch,
  type OperatorHttpRoute,
  type OperatorHttpRouteDecision,
  type OperatorHttpSend,
} from './hosted-operator-http';
import { canonicalNoisePublicKey } from './hosted-machine-noise-key';
import { isByocSealedPacket } from './byoc-sealed-channel';
import {
  HOSTED_WORKSPACE_MAX_MESSAGE_BYTES,
  type HostedWorkspaceRelaySocket,
} from '../endpoint-route/hosted-workspace-session';

// ─── Machine side ───────────────────────────────────────────────────────────

/** The ONLY machine routes an app call may reach. Default-deny, like operator-http. */
export const APP_HTTP_ROUTE_ALLOWLIST: ReadonlyArray<OperatorHttpRoute> = [
  { method: 'POST', pattern: /^\/api\/agent-tools\/[^?#]+$/, surface: 'app tool call' },
  { method: 'POST', pattern: /^\/api\/mcp$/, surface: 'app MCP request' },
  { method: 'GET', pattern: /^\/api\/mcp$/, surface: 'app MCP stream' },
  { method: 'DELETE', pattern: /^\/api\/mcp$/, surface: 'app MCP session end' },
  // P-017 (D-032 #4): a signed webhook. The machine route checks the HMAC signature itself.
  { method: 'POST', pattern: WEBHOOK_PATH_RE, surface: 'signed webhook delivery' },
  { method: 'GET', pattern: WEBHOOK_PATH_RE, surface: 'signed webhook verification' },
];

export function decideAppHttpRoute(method: unknown, path: unknown): OperatorHttpRouteDecision {
  return decideRelayRoute(method, path, APP_HTTP_ROUTE_ALLOWLIST);
}

/**
 * Wait for response HEADERS. A tool call can run for a while before it answers, so
 * this is longer than operator-http's 30 s; a streamed MCP response is not cut by it.
 */
export const APP_HTTP_HEADER_TIMEOUT_MS = 120_000;
/** Value of the deny-only ingress marker on every app-relay forward. */
export const APP_RELAY_INGRESS_MARKER = 'app-relay';

const APP_FORWARDED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'last-event-id',
  'mcp-session-id',
  'mcp-protocol-version',
  // P-017: the signed-webhook headers (lib/external-triggers/webhook.ts). The signature covers the
  // raw body, which the channel carries byte-for-byte, so it verifies on the machine unchanged.
  'papercusp-signature',
  'papercusp-event',
  'papercusp-delivery',
]);
// Vendor proof headers carry no operator identity; the machine verifies their descriptor scheme.
// Keep the relay independent of installed provider names and refuse every other custom header.
const VENDOR_PROOF_HEADER = /^x-[a-z0-9-]+-(?:signature(?:-[0-9]+)?|secret)$/;
export const APP_HTTP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'cache-control',
  'x-accel-buffering',
  'retry-after',
  'mcp-session-id',
]);

function headerValue(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value) ? value : null;
}

/** `Bearer pcapp_…` → the key. Anything else — an owner/admin ticket, a JWT, nothing — → null. */
export function readAppKeyBearer(authorization: unknown): string | null {
  const value = headerValue(authorization)?.trim();
  if (!value) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match && isAppKeyShaped(match[1]) ? match[1] : null;
}

/**
 * Header policy for a forward to the machine's loopback operator: the app headers
 * MCP and JSON calls need, the app key (never any other credential), and the
 * ingress marker. Never a cookie, a host, forwarding headers or principal headers.
 */
export function appHttpRequestHeaders(input: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
      const key = name.toLowerCase();
      if (key === 'authorization') {
        const appKey = readAppKeyBearer(raw);
        if (appKey) headers.authorization = `Bearer ${appKey}`;
        continue;
      }
      const value = headerValue(raw);
      if ((APP_FORWARDED_REQUEST_HEADERS.has(key) || (VENDOR_PROOF_HEADER.test(key) && !key.startsWith('x-papercusp-'))) && value !== null) headers[key] = value;
    }
  }
  headers[EXTERNAL_INGRESS_MARKER_HEADER] = APP_RELAY_INGRESS_MARKER;
  return headers;
}

export interface AppHttpChannelOptions {
  send: OperatorHttpSend;
  audit: OperatorHttpAudit;
  origin?: string;
  fetch?: OperatorHttpFetch;
  headerTimeoutMs?: number;
}

/** The machine's end of one `app-http` channel. The host adapter and the tests both build it here. */
export function createAppHttpChannel(options: AppHttpChannelOptions): OperatorHttpChannel {
  return new OperatorHttpChannel({
    send: options.send,
    audit: options.audit,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headerTimeoutMs: options.headerTimeoutMs ?? APP_HTTP_HEADER_TIMEOUT_MS,
    decideRoute: decideAppHttpRoute,
    requestHeaders: appHttpRequestHeaders,
    responseHeaders: APP_HTTP_RESPONSE_HEADERS,
  });
}

// ─── Machine side: the device-http channel (android-public-release D-013 #2) ─

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The ONLY machine routes a phone call relayed by the portal may reach: the phone device API,
 * DERIVED from the list the external-ingress listener serves (device-ingress-paths.ts), never
 * copied. Desktop mint/list/revoke and the QR renderer are not on it.
 */
export const DEVICE_HTTP_ROUTE_ALLOWLIST: ReadonlyArray<OperatorHttpRoute> = PHONE_DEVICE_METHODS.flatMap((method) => [
  ...PHONE_DEVICE_PATHS.map((path) => ({ method, pattern: new RegExp(`^${escapeRegExp(path)}$`), surface: 'phone device call' })),
  ...PHONE_DEVICE_PATH_SHAPES.map((pattern) => ({ method, pattern, surface: 'phone device call' })),
]);

export function decideDeviceHttpRoute(method: unknown, path: unknown): OperatorHttpRouteDecision {
  return decideRelayRoute(method, path, DEVICE_HTTP_ROUTE_ALLOWLIST);
}

/** Value of the deny-only ingress marker on every device-relay forward. */
export const DEVICE_RELAY_INGRESS_MARKER = 'device-relay';

const DEVICE_FORWARDED_REQUEST_HEADERS = new Set(['content-type', 'accept']);
export const DEVICE_HTTP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'cache-control',
  'x-accel-buffering',
  'retry-after',
]);

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** `Bearer <header>.<claims>.<sig>` → the token. An app key, a ticket, a cookie, nothing → null. */
export function readDeviceJwtBearer(authorization: unknown): string | null {
  const value = headerValue(authorization)?.trim();
  if (!value) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match && JWT_SHAPE.test(match[1]) ? match[1] : null;
}

/**
 * Header policy for a phone call forwarded to the machine's loopback operator: JSON headers,
 * the device JWT (never any other credential), and the ingress marker, so the operator never
 * grants the call loopback trust. The machine verifies the JWT; the portal only checks shape.
 */
export function deviceHttpRequestHeaders(input: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
      const key = name.toLowerCase();
      if (key === 'authorization') {
        const token = readDeviceJwtBearer(raw);
        if (token) headers.authorization = `Bearer ${token}`;
        continue;
      }
      const value = headerValue(raw);
      if (DEVICE_FORWARDED_REQUEST_HEADERS.has(key) && value !== null) headers[key] = value;
    }
  }
  headers[EXTERNAL_INGRESS_MARKER_HEADER] = DEVICE_RELAY_INGRESS_MARKER;
  return headers;
}

/**
 * The device a sealed `device-http` channel's Noise handshake identified (D-013 #6). The host
 * fills `deviceId` once the phone's static key resolves to a live paired device; it stays null
 * for an unregistered key (a phone redeeming its pair over the sealed channel).
 */
export interface DeviceChannelBinding {
  deviceId: string | null;
  /**
   * The phone's static key (canonical base64) that the handshake PROVED: the phone holds its
   * secret. A pair redeemed on this channel registers exactly this key. Unset means no handshake
   * has completed, so a pair is refused.
   */
  noisePublicKey?: string | null;
}

/**
 * Body policy for a sealed channel: a `POST /api/device/pair` registers the handshake-proven key.
 * A body naming any other key is refused here, before the one-time pair token reaches the machine,
 * so a phone can never register a key it did not prove it holds. A body with no key gets the proven
 * one filled in. Every other request passes unchanged.
 */
export function bindPairBodyToProvenKey(
  route: { method: string; path: string },
  body: Buffer | undefined,
  binding: DeviceChannelBinding,
): OperatorHttpBodyDecision {
  if (route.method !== 'POST' || route.path.split('?')[0] !== PHONE_DEVICE_PAIR_PATH) return { ok: true, body };
  const proven = binding.noisePublicKey ? canonicalNoisePublicKey(binding.noisePublicKey) : null;
  if (!proven) return { ok: false, code: 'noise_key_unproven', status: 403 };
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body.toString('utf8')) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'invalid_body', status: 400 };
  const fields = parsed as Record<string, unknown>;
  if (fields.noisePublicKey !== undefined && canonicalNoisePublicKey(fields.noisePublicKey) !== proven) {
    return { ok: false, code: 'noise_key_mismatch', status: 403 };
  }
  return { ok: true, body: Buffer.from(JSON.stringify({ ...fields, noisePublicKey: proven })) };
}

export interface DeviceHttpChannelOptions extends AppHttpChannelOptions {
  /**
   * Present only on a sealed channel. A forwarded device JWT is kept only when its `sub` names
   * the bound device, so a key paired as one phone can never present another phone's token.
   * An unbound channel forwards no JWT at all (fail closed: the operator answers 401).
   */
  boundDevice?: DeviceChannelBinding;
}

/**
 * The `sub` claim of a JWT-shaped token, decoded WITHOUT verifying it. Used only to refuse a
 * token naming a different device than the channel's; the operator still verifies the
 * signature on whatever is forwarded.
 */
export function unverifiedDeviceJwtSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    const sub = (claims as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/** {@link deviceHttpRequestHeaders}, minus any JWT that does not name `binding.deviceId`. */
export function boundDeviceHttpRequestHeaders(input: unknown, binding: DeviceChannelBinding): Record<string, string> {
  const headers = deviceHttpRequestHeaders(input);
  const token = headers.authorization?.slice('Bearer '.length);
  if (token && (!binding.deviceId || unverifiedDeviceJwtSubject(token) !== binding.deviceId)) {
    delete headers.authorization;
  }
  return headers;
}

/** The machine's end of one `device-http` channel. */
export function createDeviceHttpChannel(options: DeviceHttpChannelOptions): OperatorHttpChannel {
  const binding = options.boundDevice;
  return new OperatorHttpChannel({
    send: options.send,
    audit: options.audit,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headerTimeoutMs: options.headerTimeoutMs ?? APP_HTTP_HEADER_TIMEOUT_MS,
    decideRoute: decideDeviceHttpRoute,
    // Inline frames remain capped at 512 KiB. Chunked voice JSON can carry the
    // existing 15 MiB audio limit (base64 + JSON overhead) without an oversized frame.
    maxChunkedRequestBodyBytes: 64 * HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES,
    requestHeaders: binding ? (input) => boundDeviceHttpRequestHeaders(input, binding) : deviceHttpRequestHeaders,
    responseHeaders: DEVICE_HTTP_RESPONSE_HEADERS,
    ...(binding ? { requestBody: (route, body) => bindPairBodyToProvenKey(route, body, binding) } : {}),
  });
}

// ─── Machine side: the app-key-mint channel (P-325, D-021) ──────────────────

/**
 * The machine's loopback route that mints a key for a grant the portal's consent page approved
 * (routes/connected-apps/oauth.ts). Only {@link AppKeyMintChannel} calls it: neither relay plane's
 * allowlist can reach `/api/connected-apps/*`, and the route is `auth:'loopback'` besides.
 */
export const PORTAL_MINT_ROUTE_PATH = '/api/connected-apps/portal-mint';
/** Below the portal's own 30 s wait, so the portal hears `mint.error` rather than a timeout. */
export const APP_KEY_MINT_FETCH_TIMEOUT_MS = 20_000;
/** Who approved the grant, as the portal names them. Recorded as the key's creator. */
export const PORTAL_APPROVER_RE = /^portal:[A-Za-z0-9_.@:+-]{1,200}$/;
const MINT_LABEL_MAX = 200;

export interface AppKeyMintChannelOptions {
  send: OperatorHttpSend;
  audit: OperatorHttpAudit;
  /** Called once, after the one answer is sent: the host drops the channel and tells the portal. */
  done: (reason: string) => void;
  origin?: string;
  fetch?: OperatorHttpFetch;
  timeoutMs?: number;
}

/**
 * The machine's loopback half of the PORTAL's client-credentials grant (P-016, D-022). The portal
 * token endpoint relays a `grant_type=client_credentials` request as one `token.request`; this
 * machine authenticates the client and issues the `pcat_` token, so the portal never sees a stored
 * secret. Same channel kind and one-request rule as the mint.
 */
export const PORTAL_TOKEN_ROUTE_PATH = '/api/connected-apps/portal-token';

type MintAnswer =
  | { type: 'mint.issued'; requestId: string; key: string; scopes: unknown }
  | { type: 'mint.error'; requestId: string | null; code: string }
  | { type: 'token.answer'; requestId: string; status: number; body: Record<string, unknown> };

/**
 * The machine's end of one `app-key-mint` channel: exactly one `mint.request`, answered with
 * `mint.issued` or `mint.error`. The request is checked here (shape, approver, label) and again by
 * the loopback route, which also resolves the scopes against this machine's tool catalog — so a
 * scope the portal consented to but this machine refuses comes back as `invalid_scope`.
 *
 * The forward carries NO ingress marker: this is the machine acting on its own connector's
 * instruction, the same trust the operator-http plane's loopback forward relies on (D-418). A
 * closed channel aborts the forward; a key the operator minted just before the abort is never
 * delivered and its secret is gone (only the hash is stored), so it cannot be used.
 */
export class AppKeyMintChannel {
  private used = false;
  private closed = false;
  private readonly controller = new AbortController();
  private readonly origin: string;
  private readonly fetchImpl: OperatorHttpFetch;

  constructor(private readonly options: AppKeyMintChannelOptions) {
    this.origin = options.origin ?? localOperatorOrigin();
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async accept(type: string, payload: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const requestId = typeof payload.requestId === 'string' && payload.requestId.length <= 256 ? payload.requestId : null;
    if (type !== 'mint.request' && type !== 'token.request') {
      return this.answer({ type: 'mint.error', requestId, code: 'channel_kind_mismatch' }, false);
    }
    if (!requestId) return this.answer({ type: 'mint.error', requestId, code: 'invalid_request' });
    if (this.used) return this.answer({ type: 'mint.error', requestId, code: 'mint_already_requested' }, false);
    this.used = true;
    if (type === 'token.request') return this.token(requestId, payload);
    const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, MINT_LABEL_MAX) : '';
    const approvedBy = typeof payload.approvedBy === 'string' ? payload.approvedBy : '';
    const scopes = payload.scopes && typeof payload.scopes === 'object' && !Array.isArray(payload.scopes) ? payload.scopes : null;
    if (!label || !scopes || !PORTAL_APPROVER_RE.test(approvedBy)) {
      return this.answer({ type: 'mint.error', requestId, code: 'invalid_request' });
    }
    const timer = setTimeout(() => this.controller.abort(), this.options.timeoutMs ?? APP_KEY_MINT_FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.origin}${PORTAL_MINT_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, scopes, approvedBy }),
        signal: this.controller.signal,
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      // Strict: a mint yields a long-lived `pcapp_` key, never a `pcat_` token (isAppKeyShaped admits both).
      if (response.ok && body?.ok === true && typeof body.key === 'string' && parseAppKey(body.key) !== null) {
        this.options.audit('app_key_minted', approvedBy);
        return this.answer({ type: 'mint.issued', requestId, key: body.key, scopes: body.scopes ?? scopes });
      }
      const error = body?.error;
      const code =
        typeof error === 'string'
          ? error
          : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : `http_${response.status}`;
      this.options.audit('app_key_mint_refused', code);
      return this.answer({ type: 'mint.error', requestId, code: /^[a-z0-9_]{1,64}$/.test(code) ? code : 'mint_failed' });
    } catch {
      if (this.closed) return;
      const code = this.controller.signal.aborted ? 'mint_timeout' : 'operator_unreachable';
      this.options.audit('app_key_mint_failed', code);
      return this.answer({ type: 'mint.error', requestId, code });
    } finally {
      clearTimeout(timer);
    }
  }

  /** One relayed client-credentials token request → `token.answer` (or `mint.error` on a relay fault). */
  private async token(requestId: string, payload: Record<string, unknown>): Promise<void> {
    const fields = relayedTokenFields(payload.fields);
    const basic = relayedBasic(payload.basic);
    const audience = typeof payload.audience === 'string' && payload.audience.length <= 1024 ? payload.audience : '';
    if (!fields || basic === undefined || !audience) return this.answer({ type: 'mint.error', requestId, code: 'invalid_request' });
    const timer = setTimeout(() => this.controller.abort(), this.options.timeoutMs ?? APP_KEY_MINT_FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.origin}${PORTAL_TOKEN_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields, basic, audience }),
        signal: this.controller.signal,
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && body?.ok === true && isRelayableTokenAnswer(body.status, body.body)) {
        const status = body.status as number;
        const answer = body.body as Record<string, unknown>;
        this.options.audit(status === 200 ? 'app_token_issued' : 'app_token_refused', status === 200 ? 'client_credentials' : String(answer.error));
        return this.answer({ type: 'token.answer', requestId, status, body: answer });
      }
      this.options.audit('app_token_failed', `http_${response.status}`);
      return this.answer({ type: 'mint.error', requestId, code: 'token_failed' });
    } catch {
      if (this.closed) return;
      const code = this.controller.signal.aborted ? 'mint_timeout' : 'operator_unreachable';
      this.options.audit('app_token_failed', code);
      return this.answer({ type: 'mint.error', requestId, code });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The portal (or the host) closed the channel: abort an in-flight forward. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }

  private answer(frame: MintAnswer, finish = true): void {
    if (this.closed) return;
    this.options.send(frame);
    if (!finish) return;
    this.closed = true;
    this.options.done('mint_complete');
  }
}

// ─── Portal side: limits (D-006) ────────────────────────────────────────────

export interface AppRelayLimits {
  /** Calls per workspace per rolling minute window. */
  requestsPerMinute: number;
  /** Request plus response body bytes per workspace per UTC calendar month. */
  monthlyBandwidthBytes: number;
}

/**
 * Free-tier limits at launch (D-006). One connector measured ~1,000 req/s and
 * 30–127 MiB/s on loopback (D-014); these keep one workspace to a small share of
 * that. Recorded as a plan decision with the numbers.
 */
export const DEFAULT_APP_RELAY_LIMITS: AppRelayLimits = {
  requestsPerMinute: 600,
  monthlyBandwidthBytes: 10 * 1024 ** 3,
};

export interface AppRelayWorkspace {
  controlPlaneWorkspaceId: string;
  organizationId: string;
  customerWorkspaceId: string;
}

/** Monthly usage. Counts only: nothing of a call's content is ever written (D-008). */
export interface HostedAppRelayUsageStore {
  monthBytes(workspace: AppRelayWorkspace, month: string): Promise<number>;
  add(workspace: AppRelayWorkspace, month: string, usage: { bytes: number; requests: number }): Promise<void>;
}

/** `YYYY-MM-01` of the UTC month containing `now`. */
export function appRelayMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function secondsUntilNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function usageKey(workspace: AppRelayWorkspace, month: string): string {
  return JSON.stringify([workspace.controlPlaneWorkspaceId, workspace.organizationId, workspace.customerWorkspaceId, month]);
}

export class InMemoryHostedAppRelayUsageStore implements HostedAppRelayUsageStore {
  readonly rows = new Map<string, { bytes: number; requests: number }>();

  async monthBytes(workspace: AppRelayWorkspace, month: string): Promise<number> {
    return this.rows.get(usageKey(workspace, month))?.bytes ?? 0;
  }

  async add(workspace: AppRelayWorkspace, month: string, usage: { bytes: number; requests: number }): Promise<void> {
    const key = usageKey(workspace, month);
    const row = this.rows.get(key) ?? { bytes: 0, requests: 0 };
    this.rows.set(key, { bytes: row.bytes + usage.bytes, requests: row.requests + usage.requests });
  }
}

/** Runs one statement batch as the hosted service role (`withHostedServiceContext`). */
export type AppRelayServiceRunner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

/**
 * `papercusp_auth.hosted_app_relay_usage` (migrations 1254 + 1255). Runs as the
 * hosted service role, the only role 1255 grants on this table, the same way
 * PostgresHostedWorkspaceConnectorStore does.
 */
export class PostgresHostedAppRelayUsageStore implements HostedAppRelayUsageStore {
  constructor(private readonly run: AppRelayServiceRunner) {}

  async monthBytes(workspace: AppRelayWorkspace, month: string): Promise<number> {
    return this.run(async (sql) => {
      const rows = await sql<{ bytes: string | number }[]>`
        SELECT bytes FROM papercusp_auth.hosted_app_relay_usage
         WHERE control_workspace_id = ${workspace.controlPlaneWorkspaceId}
           AND organization_id = ${workspace.organizationId}
           AND customer_workspace_id = ${workspace.customerWorkspaceId}
           AND month = ${month}::date`;
      return rows[0] ? Number(rows[0].bytes) : 0;
    });
  }

  async add(workspace: AppRelayWorkspace, month: string, usage: { bytes: number; requests: number }): Promise<void> {
    await this.run(async (sql) => {
      await sql`
        INSERT INTO papercusp_auth.hosted_app_relay_usage
          (control_workspace_id, organization_id, customer_workspace_id, month, bytes, requests)
        VALUES (${workspace.controlPlaneWorkspaceId}, ${workspace.organizationId}, ${workspace.customerWorkspaceId},
                ${month}::date, ${Math.max(0, Math.floor(usage.bytes))}, ${Math.max(0, Math.floor(usage.requests))})
        ON CONFLICT (control_workspace_id, organization_id, customer_workspace_id, month) DO UPDATE
          SET bytes = hosted_app_relay_usage.bytes + EXCLUDED.bytes,
              requests = hosted_app_relay_usage.requests + EXCLUDED.requests,
              updated_at = now()`;
    });
  }
}

/**
 * Per-workspace request rate over a fixed one-minute window. In memory on purpose:
 * a minute's count needs no durability, and a restart forgiving one window is harmless.
 */
export class AppRelayRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly requestsPerMinute: number) {}

  /** Count one call; `false` when the workspace is over its limit for this window. */
  take(workspaceKey: string, nowMs: number): boolean {
    const window = this.windows.get(workspaceKey);
    if (!window || nowMs - window.start >= 60_000) {
      if (this.windows.size >= 10_000) this.prune(nowMs);
      this.windows.set(workspaceKey, { start: nowMs, count: 1 });
      return true;
    }
    if (window.count >= this.requestsPerMinute) return false;
    window.count += 1;
    return true;
  }

  private prune(nowMs: number): void {
    for (const [key, window] of this.windows) if (nowMs - window.start >= 60_000) this.windows.delete(key);
  }
}

// ─── Portal side: the relay ─────────────────────────────────────────────────

export interface AppRelayConnector {
  binding: AppRelayWorkspace & { hostId: string; generation: number; hosting?: 'byoc' | 'papercusp' };
  /** The last proof of life the broker saw from this connector socket. */
  lastSeenAt: Date;
}

export interface AppRelayChannel {
  send(payload: Record<string, unknown>): boolean;
  close(reason: string): void;
}

/**
 * The in-process channels the portal itself opens: `app-http` carries one relayed app call (P-007);
 * `app-key-mint` carries one key mint for a consented MCP OAuth grant (P-325, D-021).
 */
export type AppRelayChannelKind = 'app-http' | 'app-key-mint' | 'device-http';

/** What the relay needs from the connector broker (`HostedWorkspaceSessionBroker` implements it). */
export interface AppRelayPort {
  appConnector(customerWorkspaceId: string): AppRelayConnector | null;
  openAppChannel(
    connector: AppRelayConnector,
    handlers: { onFrame: (payload: Record<string, unknown>) => void; onClose: (reason: string) => void },
    kind?: AppRelayChannelKind,
    open?: AppRelayOpenOptions,
  ): AppRelayChannel | null;
}

/**
 * Extra fields the portal sends on an `app-http` channel's `relay.open` (P-328, D-030 #4): the
 * workspace's relay usage this month, so the machine can raise the relay-limit alert. Counts only.
 */
export interface AppRelayOpenOptions {
  relayUsage?: RelayUsageReport;
  /** The outside app owns the peer key and exchanges only Noise packets. */
  sealed?: boolean;
}

/**
 * D-019: the portal is only an opaque transport for a phone's Noise channel.
 * No portal ticket authorizes device content: the machine authenticates the
 * static peer key and device JWT after decryption. Plaintext is terminal.
 *
 * The upgrade caller checks reachability before accepting HTTP; repeat it here
 * because the connector can disappear between that check and handleUpgrade.
 */
export function attachSealedDeviceSocket(
  port: AppRelayPort,
  customerWorkspaceId: string,
  socket: HostedWorkspaceRelaySocket,
  now: Date = new Date(),
): boolean {
  const connector = port.appConnector(customerWorkspaceId);
  if (!connector || (connector.binding.hosting !== 'byoc' && connector.binding.hosting !== 'papercusp') ||
      !isHostedConnectorLive({ state: 'active', transport: 'websocket', heartbeatAt: connector.lastSeenAt }, now)) {
    socket.close(1013, 'workspace_offline');
    return false;
  }
  let closed = false;
  let channel: AppRelayChannel | null = null;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    channel?.close(reason);
    socket.close(code, reason);
  };
  channel = port.openAppChannel(connector, {
    onFrame: (payload) => {
      if (closed) return;
      if (!isByocSealedPacket(payload)) return close(4403, 'sealed_packet_required');
      if (socket.readyState !== (socket.OPEN ?? 1)) return close(1001, 'device_disconnected');
      try { socket.send(JSON.stringify(payload)); } catch { close(1011, 'device_transport_failed'); }
    },
    onClose: () => close(1013, 'workspace_offline'),
  }, 'device-http', { sealed: true });
  if (!channel) {
    close(1013, 'workspace_offline');
    return false;
  }
  if (closed) {
    channel.close('device_disconnected');
    return false;
  }
  socket.on('message', (data) => {
    if (closed) return;
    const raw = typeof data === 'string' ? Buffer.from(data) :
      Buffer.isBuffer(data) ? data :
      data instanceof ArrayBuffer ? Buffer.from(data) :
      Array.isArray(data) && data.every(Buffer.isBuffer) ? Buffer.concat(data) : null;
    if (!raw) return close(4403, 'sealed_packet_required');
    if (raw.length > HOSTED_WORKSPACE_MAX_MESSAGE_BYTES) return close(1009, 'frame_too_large');
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return close(4403, 'sealed_packet_required'); }
    if (!isByocSealedPacket(payload)) return close(4403, 'sealed_packet_required');
    if (!channel?.send(payload as unknown as Record<string, unknown>)) close(4403, 'sealed_packet_refused');
  });
  socket.on('close', () => close(1001, 'device_disconnected'));
  socket.on('error', () => close(1011, 'device_transport_failed'));
  return true;
}

export interface HostedAppRelayAuditEvent {
  action: 'app_relay_refused' | 'app_relay_request';
  customerWorkspaceId: string;
  /** A refusal code or `<method> <status>`; never a path, header, key or body. */
  detail: string;
}

export interface HostedAppRelayDependencies {
  port: AppRelayPort;
  /** Server-side hosting lookup for a workspace whose connector is offline. */
  resolveCustomerWorkspaceHosting?: (customerWorkspaceId: string) => Promise<'byoc' | 'papercusp' | null>;
  usage: HostedAppRelayUsageStore;
  rate: AppRelayRateLimiter;
  limits?: AppRelayLimits;
  now?: () => Date;
  randomId?: () => string;
  headerTimeoutMs?: number;
  onAudit?: (event: HostedAppRelayAuditEvent) => void;
}

/** `/api/workspaces/<id>/(agent-tools/… | mcp | hooks/<source id>)`. */
const APP_RELAY_PATH = new RegExp(
  `^/api/workspaces/([A-Za-z0-9][A-Za-z0-9_-]{0,127})/(agent-tools/[^?#]+|mcp|hooks/${WEBHOOK_SOURCE_ID_PATTERN})$`,
);

export function parseAppRelayPath(pathname: string): { customerWorkspaceId: string; machinePath: string } | null {
  const match = APP_RELAY_PATH.exec(pathname);
  return match ? { customerWorkspaceId: match[1], machinePath: `/api/${match[2]}` } : null;
}

/**
 * `/api/workspaces/<id>/api/device/<route>` (D-013 #1/#2). The phone's shared Rust client appends
 * `/api/device/<route>` to an opaque base URL, and a cloud pairing's base URL is
 * `<portal>/api/workspaces/<id>` — so this is the exact path the unmodified client sends.
 */
const DEVICE_RELAY_PATH = /^\/api\/workspaces\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/api\/(device\/[^?#]+)$/;

export function parseDeviceRelayPath(pathname: string): { customerWorkspaceId: string; machinePath: string } | null {
  const match = DEVICE_RELAY_PATH.exec(pathname);
  return match ? { customerWorkspaceId: match[1], machinePath: '/api/' + match[2] } : null;
}

function refuse(status: number, error: string, extra: Record<string, string> = {}, body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...body }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
}

const RELAY_ERROR_STATUS: Record<string, number> = {
  route_not_relayed: 403,
  invalid_path: 400,
  invalid_body: 400,
  request_body_too_large: 413,
  too_many_requests: 429,
  operator_timeout: 504,
  operator_unreachable: 502,
};

let fallbackCounter = 0;
function defaultRandomId(): string {
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `app-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/**
 * Handle one app call on the portal. Refusals answer at once and write nothing;
 * an accepted call streams the machine's response back and adds its byte count to
 * the workspace's month.
 */
export async function handleHostedAppRelay(request: Request, deps: HostedAppRelayDependencies): Promise<Response> {
  const url = new URL(request.url);
  const target = parseAppRelayPath(url.pathname);
  if (!target) return refuse(404, 'not_found');
  const audit = (action: HostedAppRelayAuditEvent['action'], detail: string) =>
    deps.onAudit?.({ action, customerWorkspaceId: target.customerWorkspaceId, detail });

  // Classify from the broker's server-authenticated connector before inspecting
  // an app key or reading a body. The vendor portal cannot terminate BYOC content.
  const connector = deps.port.appConnector(target.customerWorkspaceId);
  const hosting = connector?.binding.hosting ?? await deps.resolveCustomerWorkspaceHosting?.(target.customerWorkspaceId).catch(() => null);
  if (hosting === 'byoc') {
    audit('app_relay_refused', 'byoc_plaintext_relay_refused');
    return refuse(403, 'byoc_plaintext_relay_refused', {}, {
      alternatives: ['customer_controlled_ingress', 'sealed_channel'],
    });
  }

  // P-017 (D-032 #4): a signed webhook carries no app key. The MACHINE checks its HMAC
  // signature, so the portal skips the key check here, and admits only GET/POST. Every other
  // portal rule below (offline refusal, rate and bandwidth limits) still applies.
  const webhook = isWebhookPath(target.machinePath);
  if (webhook && !['GET', 'POST'].includes(request.method.toUpperCase())) {
    audit('app_relay_refused', 'method_not_allowed');
    return refuse(405, 'method_not_allowed', { allow: 'GET, POST' });
  }

  // D-005: app routes take a limited key and nothing else. Read from Authorization
  // alone, so an owner or admin ticket, a JWT or a cookie session is never accepted.
  if (!webhook && !readAppKeyBearer(request.headers.get('authorization'))) {
    audit('app_relay_refused', 'app_key_required');
    // P-325: an MCP client that has no key yet learns from this header where the portal's
    // authorization server for THIS workspace is (RFC 9728 §5.1), and gets one by OAuth.
    const challenge =
      target.machinePath === '/api/mcp'
        ? `Bearer resource_metadata="${portalResourceMetadataUrl(publicOriginOf(request), target.customerWorkspaceId)}"`
        : 'Bearer';
    return refuse(401, 'app_key_required', { 'www-authenticate': challenge });
  }

  return admitAndRelay({
    request, url, machinePath: target.machinePath, connector, deps, audit,
    kind: 'app-http', requestHeaders: appHttpRequestHeaders, responseHeaders: APP_HTTP_RESPONSE_HEADERS,
  });
}

/**
 * Handle one phone call on the portal (D-013 #2): `/api/workspaces/<id>/api/device/<route>` is
 * carried to the machine's `/api/device/<route>`. The portal checks SHAPE only (D-013 #4): the
 * route is on the phone allowlist, and every route but pair carries a device-JWT-shaped bearer.
 * The machine verifies the JWT, so its 401 passes through unchanged. A BYOC workspace's device
 * content must be Noise-sealed end to end (D-013 #6), so a plaintext call to one is refused.
 */
export async function handleHostedDeviceRelay(request: Request, deps: HostedAppRelayDependencies): Promise<Response> {
  const url = new URL(request.url);
  const target = parseDeviceRelayPath(url.pathname);
  if (!target) return refuse(404, 'not_found');
  const audit = (action: HostedAppRelayAuditEvent['action'], detail: string) =>
    deps.onAudit?.({ action, customerWorkspaceId: target.customerWorkspaceId, detail });

  const connector = deps.port.appConnector(target.customerWorkspaceId);
  const hosting = connector?.binding.hosting ?? await deps.resolveCustomerWorkspaceHosting?.(target.customerWorkspaceId).catch(() => null);
  if (hosting === 'byoc') {
    audit('app_relay_refused', 'byoc_plaintext_relay_refused');
    return refuse(403, 'byoc_plaintext_relay_refused', {}, { alternatives: ['sealed_channel'] });
  }

  const decision = decideDeviceHttpRoute(request.method, target.machinePath);
  if (!decision.ok) {
    audit('app_relay_refused', decision.code);
    return refuse(decision.code === 'route_not_relayed' ? 403 : 400, decision.code);
  }
  if (target.machinePath !== PHONE_DEVICE_PAIR_PATH && !readDeviceJwtBearer(request.headers.get('authorization'))) {
    audit('app_relay_refused', 'device_token_required');
    return refuse(401, 'device_token_required', { 'www-authenticate': 'Bearer' });
  }

  return admitAndRelay({
    request, url, machinePath: target.machinePath, connector, deps, audit,
    kind: 'device-http', requestHeaders: deviceHttpRequestHeaders, responseHeaders: DEVICE_HTTP_RESPONSE_HEADERS,
  });
}

/**
 * What every portal relay plane shares once its own credential check passed: the offline
 * refusal (D-008), the per-workspace limits (D-006), the request body cap, and the relay.
 */
async function admitAndRelay(input: {
  request: Request;
  url: URL;
  machinePath: string;
  connector: AppRelayConnector | null;
  deps: HostedAppRelayDependencies;
  audit: (action: HostedAppRelayAuditEvent['action'], detail: string) => void;
  kind: AppRelayChannelKind;
  requestHeaders: (input: unknown) => Record<string, string>;
  responseHeaders: ReadonlySet<string>;
}): Promise<Response> {
  const { request, url, connector, deps, audit } = input;
  // D-008: an offline machine is refused at once. Nothing is queued, held or stored.
  const now = deps.now?.() ?? new Date();
  if (!connector || !isHostedConnectorLive({ state: 'active', transport: 'websocket', heartbeatAt: connector.lastSeenAt }, now)) {
    audit('app_relay_refused', 'workspace_offline');
    return refuse(503, 'workspace_offline', { 'retry-after': '30' });
  }

  // D-006: per-workspace limits.
  const limits = deps.limits ?? DEFAULT_APP_RELAY_LIMITS;
  const workspace = connector.binding;
  if (!deps.rate.take(usageKey(workspace, ''), now.getTime())) {
    audit('app_relay_refused', 'rate_limited requests_per_minute');
    return refuse(429, 'rate_limited', { 'retry-after': '60' }, { limit: 'requests_per_minute' });
  }
  const month = appRelayMonth(now);
  const monthBytes = await deps.usage.monthBytes(workspace, month);
  if (monthBytes >= limits.monthlyBandwidthBytes) {
    audit('app_relay_refused', 'rate_limited monthly_bandwidth');
    return refuse(429, 'rate_limited', { 'retry-after': String(secondsUntilNextMonth(now)) }, { limit: 'monthly_bandwidth' });
  }

  const method = request.method.toUpperCase();
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.byteLength > HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES) {
      audit('app_relay_refused', 'request_body_too_large');
      return refuse(413, 'request_body_too_large');
    }
    if (bytes.byteLength > 0) body = bytes;
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });

  return relay({
    deps,
    connector,
    workspace,
    month,
    method,
    path: `${input.machinePath}${url.search}`,
    headers: input.requestHeaders(headers),
    kind: input.kind,
    responseHeaders: input.responseHeaders,
    body,
    signal: request.signal,
    audit,
    relayUsage: { month, bytes: monthBytes, limitBytes: limits.monthlyBandwidthBytes },
  });
}

function relay(input: {
  deps: HostedAppRelayDependencies;
  kind: AppRelayChannelKind;
  responseHeaders: ReadonlySet<string>;
  connector: AppRelayConnector;
  workspace: AppRelayWorkspace;
  month: string;
  relayUsage: RelayUsageReport;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  signal: AbortSignal | undefined;
  audit: (action: HostedAppRelayAuditEvent['action'], detail: string) => void;
}): Promise<Response> {
  const { deps } = input;
  return new Promise<Response>((resolve) => {
    const requestId = (deps.randomId ?? defaultRandomId)();
    let responded = false;
    let finished = false;
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let bytes = input.body?.byteLength ?? 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: AppRelayChannel | null = null;

    const respond = (response: Response) => {
      if (responded) return;
      responded = true;
      resolve(response);
    };
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel?.close(reason);
      if (bytes > 0 || reason === 'request_complete') {
        void deps.usage.add(input.workspace, input.month, { bytes, requests: 1 }).catch(() => {});
      }
    };

    channel = deps.port.openAppChannel(input.connector, {
      onFrame(frame) {
        switch (frame.type) {
          case 'http.response': {
            const status = typeof frame.status === 'number' ? frame.status : 502;
            const headers = new Headers();
            if (frame.headers && typeof frame.headers === 'object') {
              for (const [name, value] of Object.entries(frame.headers as Record<string, unknown>)) {
                if (input.responseHeaders.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
              }
            }
            clearTimeout(timer);
            input.audit('app_relay_request', `${input.method} ${status}`);
            const nullBody = status === 204 || status === 304 || input.method === 'HEAD';
            respond(new Response(
              nullBody ? null : new ReadableStream<Uint8Array>({
                start(controller) { stream = controller; },
                cancel() {
                  channel?.send({ type: 'http.abort', requestId });
                  finish('client_aborted');
                },
              }),
              { status, headers },
            ));
            return;
          }
          case 'http.body': {
            if (typeof frame.data !== 'string') return;
            const chunk = Buffer.from(frame.data, 'base64');
            bytes += chunk.byteLength;
            stream?.enqueue(new Uint8Array(chunk));
            return;
          }
          case 'http.end':
            try { stream?.close(); } catch { /* already closed by the reader */ }
            finish('request_complete');
            return;
          case 'http.error': {
            const code = typeof frame.code === 'string' ? frame.code : 'relay_failed';
            if (!responded) {
              const status = typeof frame.status === 'number' ? frame.status : RELAY_ERROR_STATUS[code] ?? 502;
              input.audit('app_relay_refused', code);
              respond(refuse(status, code));
            } else {
              try { stream?.error(new Error(code)); } catch { /* reader gone */ }
            }
            finish(code);
            return;
          }
          default:
            return; // http.ready and anything newer
        }
      },
      onClose(reason) {
        if (finished) return;
        if (!responded) {
          input.audit('app_relay_refused', 'workspace_offline');
          respond(refuse(503, 'workspace_offline', { 'retry-after': '30' }));
        } else {
          try { stream?.error(new Error(reason)); } catch { /* reader gone */ }
        }
        finish(reason);
      },
    }, input.kind, { relayUsage: input.relayUsage });

    if (!channel) {
      input.audit('app_relay_refused', 'workspace_offline');
      respond(refuse(503, 'workspace_offline', { 'retry-after': '30' }));
      return;
    }

    channel.send({
      type: 'http.request',
      requestId,
      method: input.method,
      path: input.path,
      headers: input.headers,
      ...(input.body ? { body: input.body.toString('base64') } : {}),
    });

    // The machine bounds its own header wait; this only guarantees the portal never
    // holds a call past it if the answer is lost on the way back.
    timer = setTimeout(() => {
      if (responded) return;
      channel?.send({ type: 'http.abort', requestId });
      input.audit('app_relay_refused', 'workspace_timeout');
      respond(refuse(504, 'workspace_timeout'));
      finish('header_timeout');
    }, (deps.headerTimeoutMs ?? APP_HTTP_HEADER_TIMEOUT_MS) + 5_000);
    timer.unref?.();

    input.signal?.addEventListener('abort', () => {
      if (finished) return;
      channel?.send({ type: 'http.abort', requestId });
      finish('client_aborted');
    }, { once: true });
  });
}
