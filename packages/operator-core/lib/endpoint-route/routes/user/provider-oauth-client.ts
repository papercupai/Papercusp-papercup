/**
 * Settings → Integrations: the owner's OAuth app registration for an OAuth provider (plan
 * cupboard-distributable-integrations-2026-10-10 P-009; SPEC-R-2-P-009, SPEC-R-7-P-009).
 *
 * Thin HTTP over packages/operator-core/lib/integrations/oauth-client-registration.ts, which writes
 * the host's oauth-apps.json under the key the provider's connect flow reads. No response carries
 * the client secret: every response is the registration status (configured, client ID, whether a
 * secret is held, the redirect URL to give the vendor).
 *
 *   GET /user/integrations/providers/:providerId/oauth-client   the registration status
 *   PUT /user/integrations/providers/:providerId/oauth-client   { clientId, clientSecret? }
 *
 * A PUT without a clientSecret keeps the saved one. Every write invalidates `integrations.tickets`,
 * whose provider summaries carry the same status.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { ProviderRegistryNotReadyError, readyProviderRegistry, type RegisteredProvider } from '../../../integrations/provider-registry';
import {
  clientRegistrationRefOf,
  oauthClientRegistrationStatus,
  saveOAuthClientRegistration,
  OAuthClientRegistrationError,
  type OAuthClientRegistrationErrorCode,
} from '../../../integrations/oauth-client-registration';
import { TICKET_INTEGRATIONS_QUERY } from './ticket-integrations';

const STATUS_BY_CODE: Record<OAuthClientRegistrationErrorCode, number> = {
  'invalid-client-id': 422,
  'invalid-client-secret': 422,
  'invalid-user-agent': 422,
  'user-agent-required': 422,
  'client-secret-required': 422,
  'invalid-instance-origin': 422,
  'registrations-unreadable': 409,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

class RouteRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A named refusal maps to its status. The error text never carries a submitted value. */
function failure(error: unknown): Response {
  if (error instanceof OAuthClientRegistrationError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: STATUS_BY_CODE[error.code] });
  }
  if (error instanceof RouteRefusal) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.status });
  }
  if (error instanceof ProviderRegistryNotReadyError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: 503 });
  }
  return Response.json(
    { ok: false, error: 'provider_oauth_client_failed', detail: 'the OAuth app registration could not be read or written' },
    { status: 500 },
  );
}

/** The provider and the oauth-apps.json key its connect flow reads. */
async function oauthProvider(providerId: string | undefined): Promise<{ entry: RegisteredProvider; ref: string }> {
  const registry = await readyProviderRegistry();
  const entry = providerId ? registry.get(providerId) : undefined;
  if (!entry) throw new RouteRefusal('unknown_provider', `no provider "${providerId ?? ''}" is installed`, 404);
  const ref = clientRegistrationRefOf(
    entry.descriptor,
    registry.list().map((candidate) => candidate.descriptor),
  );
  if (!ref) throw new RouteRefusal('no_oauth', `${entry.descriptor.displayName ?? entry.descriptor.id} does not sign in through OAuth`, 409);
  return { entry, ref };
}

// The page's query key is { userId } (workspace is server-derived), so a notify
// scoped { workspaceId, userId } never matched it. The unscoped notify is the one
// that refreshes the page; the bus publishes a repeat on a trailing edge rather
// than dropping it (WI-6554700010008519).
function invalidate(): void {
  void notifySyncInvalidate(TICKET_INTEGRATIONS_QUERY).catch(() => {});
}

const status = defineTool({
  method: 'GET',
  path: '/user/integrations/providers/:providerId/oauth-client',
  auth: 'loopback',
  async handler(_req, ctx) {
    try {
      const { entry, ref } = await oauthProvider(ctx.params.providerId);
      return Response.json({ ok: true, providerId: entry.descriptor.id, oauthClient: await oauthClientRegistrationStatus(ref) });
    } catch (error) {
      return failure(error);
    }
  },
});

const save = defineTool({
  method: 'PUT',
  path: '/user/integrations/providers/:providerId/oauth-client',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await req.json().catch(() => null);
    if (!isPlainObject(body)) {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be { clientId, clientSecret? }' }, { status: 400 });
    }
    try {
      const { entry, ref } = await oauthProvider(ctx.params.providerId);
      const oauthClient = await saveOAuthClientRegistration(
        ref,
        { clientId: body.clientId, clientSecret: body.clientSecret, ...(body.origin !== undefined ? { origin: body.origin } : {}), ...(body.userAgent !== undefined ? { userAgent: body.userAgent } : {}) },
        { requireSecret: !entry.descriptor.oauth?.pkce, requireOrigin: entry.descriptor.oauth?.instance === true, requireUserAgent: entry.descriptor.oauth?.userAgentRequired === true },
      );
      invalidate();
      return Response.json({ ok: true, providerId: entry.descriptor.id, oauthClient });
    } catch (error) {
      return failure(error);
    }
  },
});

export default [status, save];
