/**
 * Request-scoped workspace middleware (per-window-workspace-context-2026-05-31,
 * P-011 / D-002 / D-007).
 *
 * Reads the `x-papercusp-workspace` header a browser window stamps on each
 * request (see the operator-vite fetch wrapper + `getBrowserWorkspaceId`) and
 * runs the downstream handler chain inside `runWithWorkspace`, so
 * `activeWorkspaceId()` resolves to *this window's* workspace instead of the
 * process-global `reg.current`.
 *
 * Workspace source (D-001/D-007): the `x-papercusp-workspace` header (fetch
 * path), falling back to the `?ws=` query param. The query fallback exists
 * because streamed transports (`EventSource`/`IpcEventSource`, WS) **cannot**
 * set a custom header, so SSE/WS connects carry the workspace as `?ws=` on the
 * URL (the standard EventSource workaround, P-015). The header wins when both
 * are present. Whichever is used, the semantics are the same:
 *   - missing  → no ALS; `activeWorkspaceId()` falls back to the global default.
 *     (legacy clients, background/non-window requests — acceptable.)
 *   - present-but-unknown → 400. A present id we don't recognise is exactly the
 *     silent-corruption mode this plan exists to kill, so we reject loudly
 *     rather than fall back.
 *   - present and known → wrap the handler in `runWithWorkspace`.
 */
import type { MiddlewareHandler } from 'hono';
import { runWithWorkspace, runInRequestScope } from './workspace-als';
import { isKnownWorkspace } from './workspace-registry';

export const WORKSPACE_HEADER = 'x-papercusp-workspace';

export interface WorkspaceContextTransport {
  /** Host-owned transport: authorize the selection before consuming either hint.
   * A refusal is a response, never permission to run the request locally. */
  forwardMachineRequest(request: Request, machine: string): Promise<Response>;
}

export function createWorkspaceContextMiddleware(transport?: WorkspaceContextTransport): MiddlewareHandler {
  return async (c, next) => {
  // A transport must resolve a remote machine before entering this local
  // workspace chain. The authenticated operator-http relay consumes that
  // selection and filters it from forwarded headers. An unconsumed hint is
  // never permission to run the operation here under an otherwise valid ws.
  // A bound hosted channel already consumed the header. Its stream query is
  // left intact for compatibility; only a host with an explicit machine
  // transport interprets query hints here.
  const header = c.req.header('x-papercusp-machine')?.trim();
  const query = transport ? c.req.query('desktopHost')?.trim() : undefined;
  if (header && query && header !== query) {
    return c.json({ error: 'machine_selection_mismatch' }, 400);
  }
  const machine = header || query;
  if (machine && machine !== 'local') {
    if (transport) return transport.forwardMachineRequest(c.req.raw, machine);
    return c.json({
      error: 'selected_machine_not_connected',
      machine,
      message: 'Connect the selected machine before using its workspace.',
    }, 409);
  }
  // Header (fetch) first; ?ws= query (streams — EventSource/WS can't set headers) as fallback.
  const raw = c.req.header(WORKSPACE_HEADER) ?? c.req.query('ws');
  const ws = raw?.trim();
  if (!ws) {
    // No workspace signal → still establish a request scope (no concrete
    // workspace) so activeWorkspaceId()'s global fallback can be flagged in dev
    // (P-021). Resolution behavior is unchanged — global fallback applies.
    return runInRequestScope(next);
  }
  if (!isKnownWorkspace(ws)) {
    return c.json({ error: 'unknown_workspace', workspace: ws }, 400);
  }
  return runWithWorkspace(ws, () => next());
  };
}

export const workspaceContextMiddleware = createWorkspaceContextMiddleware();
