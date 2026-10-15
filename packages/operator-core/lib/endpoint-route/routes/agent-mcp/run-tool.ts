/**
 * POST /api/agent-mcp/run-tool — palette server-capability invoke (P-004).
 *
 * Loopback-only. Runs a tooldef tool for the desktop palette user through the
 * full gated/audited dispatch (no gate-bypass) with a server-side §3 re-check
 * (excluded tools refused; destructive/high require `confirmed:true`). See
 * `lib/capabilities/invoke.ts`.
 *
 * Body: { name: string, args?: object, confirmed?: boolean, harness?: string }.
 * `auth: 'loopback'` (auth-tier Wave 1) follows the sibling agent-mcp routes; the loopback gate +
 * the dispatch stack are the actual boundary.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';
import { invokeServerCapability } from '../../../capabilities/invoke';
import { principalFromCookie } from '../../../auth/principal/from-cookie';
// Register through the same module graph as the host's other routes. A
// request-time import makes tsx traverse the already loaded CommonJS catalog
// through Node's synchronous ESM hooks, blocking unrelated HTTP probes.
import '../../../agent-tools';

interface Body {
  name?: unknown;
  args?: unknown;
  confirmed?: unknown;
  /** Optional selected harness; validated inside the active workspace by the dispatcher. */
  harness?: unknown;
  /** EI-1751: an optional CALLER-supplied, process-stable id (e.g. the pui's
   *  `pui-<pid>`) — folded into the dispatch ctx as `uiClientId` purely for
   *  per-caller telemetry attribution. Never trusted for anything beyond
   *  labeling. The authenticated actor is resolved from the server-side cookie
   *  session, never from callerSid or another JSON field. */
  callerSid?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/run-tool',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden', detail: 'loopback only' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return Response.json({ ok: false, error: 'missing_name' }, { status: 400 });
    }
    if (body.harness !== undefined && typeof body.harness !== 'string') {
      return Response.json({ ok: false, error: 'invalid_harness' }, { status: 400 });
    }

    const callerSid = typeof body.callerSid === 'string' ? body.callerSid.trim().slice(0, 128) : '';
    const authenticatedPrincipal = await principalFromCookie(req.headers);
    const r = await invokeServerCapability({
      name,
      args: body.args,
      confirmed: body.confirmed === true,
      ...(callerSid ? { callerSid } : {}),
      ...(authenticatedPrincipal ? { authenticatedPrincipal } : {}),
      ...(body.harness === undefined ? {} : { harness: body.harness }),
    });
    if (!r.ok) {
      return Response.json({ ok: false, error: r.code, message: r.message }, { status: r.status });
    }
    return Response.json({ ok: true, result: r.body }, { status: 200 });
  },
});
