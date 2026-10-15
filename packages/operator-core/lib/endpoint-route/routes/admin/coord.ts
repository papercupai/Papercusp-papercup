/**
 * /api/admin/coord/:verb — admin surface for coord writes and the narrow wake-mode read.
 *
 * The Planning-tab attention feed lets the human Resolve an escalation or
 * Ack a coord message — actions that until now only agents could do (via
 * the coord:resolve / coord:ack MCP tools; coord has only GET HTTP routes).
 * The admin shell carries no bearer token, so — exactly like
 * /api/admin/plans/:verb (plans-admin-ui D-009) — these routes re-dispatch
 * into the same defineTool handlers in-process via handleHttpToolRequest
 * with a synthesized superuser ctx. Authorization = the admin mount is
 * loopback-bound; `validateSuperuser` accepts the synthesized URL because
 * this route is its only caller.
 *
 * POST /api/admin/coord/resolve  { msg_id, choice, note? }  → coord:resolve
 * POST /api/admin/coord/ack      { msg_id }                 → coord:ack
 * POST /api/admin/coord/message-agent { to?, body, harness?, plan_slug?,
 *        item_ref?, title?, topics? }                        → coord:message-agent
 *   The inbox "Message owner" action — opens a work-item-scoped conversation
 *   with the owning agent (inbox-tiering-and-message-agent-2026-06-05, D-004).
 *   The inline thread is then read/posted via /api/admin/coordination/
 *   conversations/{get,post} (admin/coordination.ts allowlist).
 * POST /api/admin/coord/send { to[], summary, body?, wake?, plan_slug? }  → coord:send
 *   The cross-user HANDOFF/assign action (shared-hive-collaboration P-008):
 *   "assign this plan/item to @user" — deliver-and-wake the assignee
 *   (wake:true fires their inbox-wake). Sender is the admin UI owner.
 */

import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { activeWorkspaceId } from '../../../workspace-registry';
// The in-process re-dispatch as the admin UI owner (ADMIN_COORD_UI_OWNER — the
// identity the Planning inbox's ack-dismiss filter reads acks BY) and the owner
// send path live in owner-sessions/actions.ts, shared with the device routes.
import { dispatchOwnerCoordSend, dispatchToolAsAdminUi } from '../../../owner-sessions/actions';

const WRITE_VERBS = new Set(['resolve', 'ack', 'message-agent', 'send']);
const READ_ONLY_VERBS = new Set(['wake-mode']);

function unwrap(toolResult: { status: number; body: unknown }): Response {
  if (toolResult.status === 200) {
    const body = toolResult.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return Response.json(JSON.parse(text));
      } catch {
        return new Response(text, { headers: { 'content-type': 'text/plain' } });
      }
    }
    return Response.json({});
  }
  return Response.json(toolResult.body, { status: toolResult.status });
}

function collectHeaders(req: Request): Record<string, string | undefined> {
  const m: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    m[k.toLowerCase()] = v;
  });
  return m;
}

async function dispatchWrite(req: Request, ctx: RouteContext): Promise<Response> {
  // The unverified-loopback admission below relies on this CSRF backstop
  // (auth-posture.test.ts): a browser cross-origin POST is refused; the desktop
  // webview's allowed origins and no-Origin native/IPC-bridge fetches pass.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb) && !READ_ONLY_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `coord write verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'request body must be JSON' } }, { status: 400 });
  }
  if (READ_ONLY_VERBS.has(verb) && ('mode' in body || 'reason' in body)) {
    return Response.json(
      { error: { code: 'read_only_verb', message: 'coord:wake-mode is read-only through this admin route' } },
      { status: 405 },
    );
  }
  const url = new URL(req.url);
  // The in-process admin projection does not resolve cookie principals again.
  // Bind both its typed context and ambient readers to the admitted workspace;
  // forwarding the caller's header would validate one roster and send in another.
  const workspaceId = ctx.principal?.workspaceId ?? activeWorkspaceId();
  if (verb === 'send') {
    // The owner send path — recipient checks against this workspace, the P-033
    // protocol defaults a GUI sender cannot author, then coord:send as the admin
    // UI owner — is shared with the device session send route
    // (owner-sessions/actions.ts, mobile-agent-sessions-2026-10-12 P-001).
    const outcome = await dispatchOwnerCoordSend({
      workspaceId,
      body,
      headers: collectHeaders(req),
      searchParams: url.searchParams,
    });
    if ('refused' in outcome) return Response.json(outcome.refused.body, { status: outcome.refused.status });
    return unwrap(outcome.result);
  }
  const result = await dispatchToolAsAdminUi({
    group: 'coord',
    verb,
    body,
    headers: collectHeaders(req),
    searchParams: url.searchParams,
    workspaceId,
  });
  return unwrap(result);
}

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/coord/:verb',
  // Mutating coord ops — gate to the admin tier (the admin coord UI runs as a
  // verified session). Was 'public', which the D3 auth-posture guard flags.
  //
  // 'unverified-loopback' (owner-hit 2026-07-11: roster bulk "send message" +
  // "wake" 403'd): a packaged/nohmr Tauri desktop's webview fetches the operator
  // /api DIRECTLY (loopback, no cookie/bearer) so it only ever resolves to
  // 'unverified-loopback' trust — never 'verified'. Every other desktop-callable
  // admin route (deploy-accounts-reset, inference-gateway-stats,
  // dogfood-substrate-health) already admits it for exactly this reason; the
  // operator binds loopback-only, so this is still an owner-local caller. Without
  // it the roster's coord actions were unreachable from the desktop app.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
