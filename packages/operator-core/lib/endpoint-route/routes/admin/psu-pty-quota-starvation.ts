/**
 * POST /api/admin/psu-pty/quota-starvation — a psu pty host reports that its agent
 * is quota-starved (WI-6554700010011967). The host's starvation guard
 * (makeQuotaBlockStarvationGuard in apps/operator/scripts/psu-pty-host.mjs) fires
 * once per blocked episode when the CLI has sat behind a quota/usage-limit block
 * past the threshold and every gated wake injection failed. Before this route the
 * signal stayed a host-local event and a terminal line, so a fleet leader only
 * learned of it when the member's presence decayed to `suspect`, 40+ min later.
 *
 * This route resolves the member's fleet and fires
 * `fleet:member-quota-starved:<slug>` for the leader. A member outside any fleet
 * gets `{ ok:true, emitted:false, fleetSlug:null }`: no fleet means no leader to
 * tell, and that is not an error.
 *
 * Workspace: `?workspace=<id>` query (what the pty host sends, from
 * PAPERCUSP_WORKSPACE) or `{ workspace }` body; defaults to 'default'.
 * Body: `{ ownerId, agent?, accountId?, blockedSinceMs?, ageMs?, thresholdMs?,
 * attemptedGatedInjections?, successfulGatedInjections? }`.
 */
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';
import {
  emitFleetMemberQuotaStarvedEvent,
  fleetSlugOfAgent,
  type FleetMemberQuotaStarvation,
} from '../../../fleet-transition-events';

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Parse the host's body into the event's signal. Exported for tests. */
export function parseQuotaStarvationBody(body: unknown): {
  ownerId: string | null;
  workspace: string | null;
  signal: FleetMemberQuotaStarvation;
} {
  const b = body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    ownerId: stringOrNull(b.ownerId),
    workspace: stringOrNull(b.workspace),
    signal: {
      blockedSinceMs: finiteOrNull(b.blockedSinceMs),
      ageMs: finiteOrNull(b.ageMs),
      thresholdMs: finiteOrNull(b.thresholdMs),
      attemptedGatedInjections: finiteOrNull(b.attemptedGatedInjections),
      successfulGatedInjections: finiteOrNull(b.successfulGatedInjections),
      agent: stringOrNull(b.agent),
      accountId: stringOrNull(b.accountId),
    },
  };
}

export default defineTool({
  method: 'POST',
  path: '/admin/psu-pty/quota-starvation',
  // unverified-loopback: the local pty-host process, same trust posture as the
  // sibling admin/owner-presence-touch POST. It can only fire a fleet health event.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    // Blocks a browser cross-origin POST; the pty host's no-Origin fetch passes.
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const parsed = parseQuotaStarvationBody(body);
    if (!parsed.ownerId) {
      return Response.json({ ok: false, error: 'ownerId is required' }, { status: 400 });
    }

    let workspace = '';
    try {
      workspace = String(new URL(req.url).searchParams.get('workspace') ?? '').trim();
    } catch {
      /* malformed URL: fall through to body/default */
    }
    if (!workspace) workspace = parsed.workspace ?? 'default';

    const fleetSlug = await fleetSlugOfAgent(workspace, parsed.ownerId);
    const emitted = await emitFleetMemberQuotaStarvedEvent(fleetSlug, parsed.ownerId, parsed.signal);
    return Response.json({ ok: true, workspace, fleetSlug, emitted });
  },
});
