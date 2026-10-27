/**
 * getSessionUserOrLocalDefault — the session resolution for the operator-chat
 * CARD family (state-snapshot SSE, card-response, silence-nudge).
 *
 * WI-5044: these routes 401'd on a bare `getSessionUser` cookie check — a
 * webapp-era assumption. The DESKTOP product never mints a session cookie
 * (auth/me's auto-establish is passwordless-only; the IPC transport
 * synthesizes an operator principal, not a Cookie header), so on the real
 * desktop the state channel was dead: chat:ask_choice cards never rendered
 * live, the blocking askUser timed out to {cancelled}, and the model fell
 * back to a prose option list — the owner-reported "Pick one." dead-end.
 *
 * Trust decision: EXACTLY the one /api/auth/me already makes — a caller the
 * loopback perimeter admits gets the seeded default user when no session
 * cookie is present. Non-loopback callers stay strict-session, so this
 * changes nothing for any off-box exposure (defense-in-depth per
 * loopback-guard.ts; the primary perimeter remains the loopback bind).
 */
import { getSessionUser, getSessionUserOrDefault, resolveSessionToken, type User, type SessionUser } from '../auth';
import { operatorChatSessionAuthority } from '../operator-chat-store';
import { activeWorkspaceId } from '../workspace-registry';
import { isLoopbackHost } from './loopback-guard';
import { currentLoopbackPeerIsForeign } from '../auth/loopback-peer-trust';
import { requestIsExternal } from '../auth/forwarded-request-trust';

/** The request's effective host: the Host header when present, else the URL's
 *  host — under @hono/node-server the URL host IS derived from the client's
 *  Host header, so the two agree in real serving (same source loopback-guard
 *  documents); the fallback matters for synthesized test requests. */
function requestHost(req: Request): string | null {
  const header = req.headers.get('host');
  if (header) return header;
  try {
    const host = new URL(req.url).host;
    return host || null;
  } catch {
    return null;
  }
}

export async function getSessionUserOrLocalDefault(req: Request): Promise<(User & { workspace_id: string }) | null> {
  let user: SessionUser | null = null;
  try {
    user = await getSessionUser(req.headers);
  } catch {
    user = null;
  }
  if (user) return user;
  if (!isLoopbackHost(requestHost(req))) return null;
  // WI-10003621: on a hosted workspace host a loopback Host header is not locality —
  // the customer account shares the interface. A foreign loopback peer gets no
  // default-user fallback, exactly like an off-loopback caller.
  if (currentLoopbackPeerIsForeign()) return null;
  // external-app-access P-004 / R-7: a tunnel or relay request whose Host was
  // rewritten to localhost gets no default-user fallback either.
  if (requestIsExternal(req.headers)) return null;
  try {
    const local = await getSessionUserOrDefault(req.headers);
    // A cookie carries its minted workspace. Only the trusted local fallback
    // uses the host's request workspace; a card body never chooses authority.
    return local ? { ...local, workspace_id: activeWorkspaceId() } : null;
  } catch {
    return null;
  }
}

/** Capture responder provenance using the same perimeter as the card family.
 * A presented cookie always stays session-bound, even if the legacy resolver
 * returns the local default after expiry. The decision transaction rejects it;
 * revocation must never turn a browser session into desktop authority. */
export async function getSessionUserOrLocalDefaultAuthority(req: Request) {
  const token = await resolveSessionToken(req.headers);
  const user = await getSessionUserOrLocalDefault(req);
  if (!user) return null;
  const workspaceId = user.workspace_id;
  const current = operatorChatSessionAuthority({ workspaceId, principalId: user.id,
    credential: token ? { kind: 'user-session', token, userId: user.id }
      : { kind: 'local-desktop', userId: user.id },
    capability: 'chat:write', toolName: 'chat:ask_choice' });
  // The locality decision is host evidence, never request/model-provided data.
  const local = isLoopbackHost(requestHost(req)) && !currentLoopbackPeerIsForeign()
    && !requestIsExternal(req.headers);
  return { user, authorize: async (tx: Parameters<typeof current>[0]) => {
    if (!token && (!local || activeWorkspaceId() !== workspaceId
      || currentLoopbackPeerIsForeign())) return false;
    return current(tx);
  } };
}
