/**
 * Owner actions on an agent session — send a message, end the session — as ONE
 * server-side implementation shared by the desktop admin routes
 * (`/api/admin/coord/send`, `/api/admin/coordination/fleet/kill`) and the
 * device session routes (mobile-agent-sessions-2026-10-12 P-001; the device
 * routes are P-004 and P-017).
 *
 * Both actions re-dispatch into the same defineTool handlers the agents use
 * (coord:send, fleet:kill), in-process, as the admin UI owner — the path the
 * desktop has always taken. A device route that dispatched coord:send or
 * fleet:kill on its own would be a second send path or a second kill path,
 * each free to drift from the recipient checks, protocol defaults and audit the
 * desktop path carries (plan D-008 for end).
 */
import { handleHttpToolRequest, PAPERCUSP_CONTEXT_HEADERS } from '@papercusp/agent-mcp';
import { createHash } from 'node:crypto';
// Side-effect: register the operator-side first-party tools (coord:*, fleet:*).
import '../agent-tools/index';
import { ADMIN_COORD_UI_OWNER } from '../agent-tools/coordination/identity';
import { applyOwnerMessageDefaults } from '../agent-tools/coordination/owner-message';
import { knownOwnerIdSet } from '../agent-tools/coordination/recipient-resolve';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS } from '../endpoint-route/routes/admin/proxy-host-extras';
import { runWithWorkspace } from '../workspace-als';
import { deliveryFromSendResponse, ownerMessageSendArgs, type SendDelivery } from './delivery';

/** The raw result of an in-process tool re-dispatch. */
export interface AdminToolResult {
  status: number;
  body: unknown;
}

/** Search params for a re-dispatch as the admin UI owner (superuser ctx). */
export function adminUiSearchParams(inbound?: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(inbound);
  sp.set('superuser', '1');
  if (!sp.has('client')) sp.set('client', ADMIN_COORD_UI_OWNER);
  return sp;
}

export interface AdminToolDispatch {
  idempotencyKey?: string;
  /** Tool group and verb, e.g. `fleet` / `kill`. */
  group: string;
  verb: string;
  /** The tool's arguments. */
  body: Record<string, unknown>;
  /** The inbound request's headers, lower-cased. */
  headers?: Record<string, string | undefined>;
  /** The inbound request's search params (a `client` override is honoured). */
  searchParams?: URLSearchParams;
  /**
   * Bind both the tool's typed context and ambient readers to this workspace.
   * Omit to keep the inbound request's own workspace header.
   */
  workspaceId?: string;
}

/** Re-dispatch one tool in-process as the admin UI owner. */
export async function dispatchToolAsAdminUi(input: AdminToolDispatch): Promise<AdminToolResult> {
  const headers = { ...(input.headers ?? {}) };
  const request = {
    method: 'POST' as const,
    pathname: `/api/agent-tools/${input.group}/${input.verb}`,
    searchParams: adminUiSearchParams(input.searchParams),
    headers,
    body: input.body,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
  if (input.workspaceId === undefined) {
    return handleHttpToolRequest(request, ADMIN_PROXY_HOST_EXTRAS);
  }
  const workspaceId = input.workspaceId;
  headers[PAPERCUSP_CONTEXT_HEADERS.workspace] = workspaceId;
  return runWithWorkspace(workspaceId, () => handleHttpToolRequest(request, ADMIN_PROXY_HOST_EXTRAS));
}

/** The JSON a successful tool result carries, or undefined when it has none. */
export function adminToolResultJson(result: AdminToolResult): unknown {
  if (result.status !== 200) return undefined;
  const body = result.body as { content?: Array<{ type: string; text?: string }> };
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A send refused before dispatch, with the HTTP status the routes answer. */
export interface OwnerSendRefusal {
  status: 400 | 403 | 503;
  body: { ok: false; error: string };
}

export type OwnerCoordSendOutcome =
  | { refused: OwnerSendRefusal }
  | { result: AdminToolResult };

/**
 * Dispatch a GUI/owner coord:send: validate the recipients against the
 * workspace, fill the protocol fields a non-agent sender cannot author, and
 * send as the admin UI owner bound to that workspace.
 */
export async function dispatchOwnerCoordSend(input: {
  idempotencyKey?: string;
  workspaceId: string;
  body: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  searchParams?: URLSearchParams;
}): Promise<OwnerCoordSendOutcome> {
  const { workspaceId, body } = input;
  const targets = typeof body.to === 'string' ? [body.to] : body.to;
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => typeof target !== 'string')) {
    return { refused: { status: 400, body: { ok: false, error: 'recipient identities are required' } } };
  }
  // GUI concrete targets are exact identities from this workspace. The agent
  // tool's best-effort alias/federation fallback is unsuitable here: a missing
  // roster must not turn a stale/foreign selection into a write.
  const concrete = (targets as string[]).filter((target) => target !== '*' && target !== 'human' && !target.startsWith('@'));
  if (concrete.length) {
    const known = await knownOwnerIdSet(workspaceId);
    if (!known) {
      return { refused: { status: 503, body: { ok: false, error: 'recipient inventory unavailable' } } };
    }
    if (concrete.some((target) => !known.has(target))) {
      return { refused: { status: 403, body: { ok: false, error: 'recipient is no longer available in this workspace' } } };
    }
  }
  // P-033: a GUI sender is not an agent and cannot author the protocol fields
  // coord:send requires (D-048 made `expects` REQUIRED with no default). Fill the
  // gaps HONESTLY and STAMP what was filled, so the D-070 measurement never
  // counts a GUI-derived value as sender intent.
  const result = await dispatchToolAsAdminUi({
    group: 'coord',
    verb: 'send',
    body: applyOwnerMessageDefaults(body),
    workspaceId,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.searchParams ? { searchParams: input.searchParams } : {}),
  });
  return { result };
}

export type OwnerSessionMessageResult =
  | { ok: true; delivery: SendDelivery; response: unknown }
  | { ok: false; status: number; error: string };

/**
 * Send an owner message to one agent session with a REQUIRED wake, and report
 * what coord:send did with it (woken, staged, queued or absent).
 */
export async function sendOwnerSessionMessage(input: {
  idempotencyKey?: string;
  /** Verified by the device route, never accepted from its request body. */
  pairedDevice?: { id: string; label: string };
  workspaceId: string;
  ownerId: string;
  text: string;
  headers?: Record<string, string | undefined>;
  searchParams?: URLSearchParams;
}): Promise<OwnerSessionMessageResult> {
  const searchParams = new URLSearchParams(input.searchParams);
  if (input.pairedDevice) {
    // A paired phone is labelled for the owner but remains agent-origin (D-010).
    const digest = createHash('sha256').update(JSON.stringify([input.workspaceId, input.pairedDevice.id])).digest('hex');
    searchParams.set('client', `paired-device-${digest}`);
  }
  const text = input.pairedDevice
    ? `[${input.pairedDevice.label} — sent from a paired device]\n${input.text}`
    : input.text;
  const outcome = await dispatchOwnerCoordSend({
    workspaceId: input.workspaceId,
    body: { ...ownerMessageSendArgs(input.ownerId, text) },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    searchParams,
  });
  if ('refused' in outcome) {
    return { ok: false, status: outcome.refused.status, error: outcome.refused.body.error };
  }
  if (outcome.result.status !== 200) {
    return { ok: false, status: outcome.result.status, error: 'coord:send failed' };
  }
  const response = adminToolResultJson(outcome.result);
  const verdict = response as { ok?: boolean; results?: Array<{ ok?: boolean }> } | null | undefined;
  if ((outcome.result.body as { isError?: boolean })?.isError || verdict?.ok === false
    || verdict?.results?.some(row => row.ok === false)) {
    return { ok: false, status: 502, error: 'coord:send refused' };
  }
  // An unparseable 200 is an accepted send whose delivery cannot be
  // characterised: report the weakest honest outcome, as the desktop does.
  return { ok: true, delivery: deliveryFromSendResponse(response ?? null), response: response ?? null };
}

/** The fleet:kill arguments the desktop "Stop agent" action sends (plan D-008). */
export function endOwnerSessionArgs(ownerId: string, reason: string): Record<string, unknown> {
  return { owner: ownerId, close_terminal: true, reason };
}

/**
 * End an agent session through fleet:kill — the same call the desktop's
 * "Stop agent" action makes (plan D-008). fleet:kill keeps its own rules:
 * self-kill refused, a reason required, every kill audited.
 */
export async function endOwnerSession(input: {
  ownerId: string;
  reason: string;
  workspaceId?: string;
  headers?: Record<string, string | undefined>;
  searchParams?: URLSearchParams;
}): Promise<AdminToolResult> {
  return dispatchToolAsAdminUi({
    group: 'fleet',
    verb: 'kill',
    body: endOwnerSessionArgs(input.ownerId, input.reason),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.searchParams ? { searchParams: input.searchParams } : {}),
  });
}
