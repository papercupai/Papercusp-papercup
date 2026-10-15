/**
 * Settings → Integrations: pasted provider credentials (plan cupboard-distributable-integrations-
 * 2026-10-10 P-001; SPEC-R-2-P-001, SPEC-R-7-P-001).
 *
 * Thin HTTP over packages/operator-core/lib/integrations/provider-credentials.ts, which checks and
 * stores each value host-side. These routes never return a stored value: every response is the
 * per-field status (configured or not, and when it was saved).
 *
 *   GET    /user/integrations/providers/:providerId/credentials        each declared field's status
 *   PUT    /user/integrations/providers/:providerId/credentials        { values?: { key: value }, source?: { scope?, liveSearch? } }
 *   DELETE /user/integrations/providers/:providerId/credentials/:key   forget one value
 *
 * `values` is all or nothing. `source` is the source settings the provider's descriptor offers
 * (integrations/provider-source-settings.ts, D-026 ruling 4), applied after any values are saved so
 * one save can connect a source and share it.
 *
 * Values are stored under the harness the provider's sources read their tokens from
 * (DEFAULT_SOURCE_TOKEN_HARNESS), the same one the OAuth connect link writes. Every write
 * invalidates `integrations.tickets`, whose provider summaries carry the same status.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../../../external-triggers/source-store';
import { ProviderRegistryNotReadyError, readyProviderRegistry, type RegisteredProvider } from '../../../integrations/provider-registry';
import {
  clearProviderCredential,
  providerCredentialStatus,
  saveProviderCredentials,
  syncProviderCredentialSource,
  ProviderCredentialError,
  type ProviderCredentialErrorCode,
} from '../../../integrations/provider-credentials';
import {
  applyProviderSourceSettings,
  ProviderSourceSettingsError,
  type ProviderSourceSettingsErrorCode,
  type ProviderSourceSettingsState,
} from '../../../integrations/provider-source-settings';
import { TICKET_INTEGRATIONS_QUERY } from './ticket-integrations';

const STATUS_BY_CODE: Record<ProviderCredentialErrorCode, number> = {
  'no-credential-fields': 409,
  'unknown-field': 404,
  'invalid-value': 422,
  'empty-request': 400,
  'invalid-principal': 400,
  'principal-required': 400,
};

const SETTINGS_STATUS_BY_CODE: Record<ProviderSourceSettingsErrorCode, number> = {
  'invalid-setting': 400,
  'scope-not-offered': 409,
  'live-search-not-offered': 409,
  'live-search-needs-organization': 409,
  'no-source': 409,
};

/** Keys of the provider's per-person fields, which each signed-in user stores as their own (D-026). */
function perPersonKeys(entry: RegisteredProvider): Set<string> {
  return new Set((entry.descriptor.setup?.credentials ?? []).filter((field) => field.perPrincipal).map((field) => field.key));
}

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
  if (error instanceof ProviderCredentialError) {
    return Response.json(
      { ok: false, error: error.code, detail: error.message, ...(error.field ? { field: error.field } : {}) },
      { status: STATUS_BY_CODE[error.code] },
    );
  }
  if (error instanceof ProviderSourceSettingsError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: SETTINGS_STATUS_BY_CODE[error.code] });
  }
  if (error instanceof RouteRefusal) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.status });
  }
  if (error instanceof ProviderRegistryNotReadyError) {
    return Response.json({ ok: false, error: error.code, detail: error.message }, { status: 503 });
  }
  return Response.json({ ok: false, error: 'provider_credentials_failed', detail: 'the credential store could not be read or written' }, { status: 500 });
}

async function provider(providerId: string | undefined): Promise<RegisteredProvider> {
  const entry = providerId ? (await readyProviderRegistry()).get(providerId) : undefined;
  if (!entry) throw new RouteRefusal('unknown_provider', `no provider "${providerId ?? ''}" is installed`, 404);
  return entry;
}

/** Connect or disable the signed-in owner's source for this provider to match what is now stored. */
async function syncSource(userId: string, entry: RegisteredProvider, credentials: Parameters<typeof syncProviderCredentialSource>[3]): Promise<void> {
  await syncProviderCredentialSource(getOrgPg().sql, { workspaceId: activeWorkspaceId(), ownerUserId: userId }, entry.descriptor, credentials);
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
  path: '/user/integrations/providers/:providerId/credentials',
  auth: 'loopback',
  async handler(req, ctx) {
    try {
      const entry = await provider(ctx.params.providerId);
      const user = await getSessionUserOrDefault(req.headers);
      const credentials = await providerCredentialStatus(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, undefined, user.id);
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials });
    } catch (error) {
      return failure(error);
    }
  },
});

const save = defineTool({
  method: 'PUT',
  path: '/user/integrations/providers/:providerId/credentials',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await req.json().catch(() => null);
    const values = isPlainObject(body) ? body.values : undefined;
    const sourceSettings = isPlainObject(body) ? body.source : undefined;
    if (
      !isPlainObject(body)
      || (values === undefined && sourceSettings === undefined)
      || (values !== undefined && !isPlainObject(values))
      || (sourceSettings !== undefined && !isPlainObject(sourceSettings))
    ) {
      return Response.json(
        { ok: false, error: 'bad_request', detail: 'body must be { values?: { <field>: <value> }, source?: { scope?, liveSearch? } }' },
        { status: 400 },
      );
    }
    // True once saveProviderCredentials has stored the values. A value it refuses stores nothing,
    // so that refusal must not refresh the page; a later refusal (a source setting) must.
    let saved = false;
    try {
      const entry = await provider(ctx.params.providerId);
      const user = await getSessionUserOrDefault(req.headers);
      let credentials = values === undefined
        ? await providerCredentialStatus(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, undefined, user.id)
        : await saveProviderCredentials(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, values, { principalUserId: user.id });
      saved = values !== undefined;
      // Storing only your own per-person value changes nothing about the source (D-026).
      const ownOnly = perPersonKeys(entry);
      if (values !== undefined && Object.keys(values).some((key) => !ownOnly.has(key))) await syncSource(user.id, entry, credentials);
      let source: ProviderSourceSettingsState[] | undefined;
      if (sourceSettings !== undefined) {
        source = await applyProviderSourceSettings(
          getOrgPg().sql,
          { workspaceId: activeWorkspaceId(), ownerUserId: user.id },
          entry.descriptor,
          sourceSettings,
        );
        credentials = await providerCredentialStatus(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, undefined, user.id);
      }
      invalidate();
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials, ...(source ? { source } : {}) });
    } catch (error) {
      // A refused source setting after saved values still changed the page's status.
      if (saved) invalidate();
      return failure(error);
    }
  },
});

const clear = defineTool({
  method: 'DELETE',
  path: '/user/integrations/providers/:providerId/credentials/:key',
  auth: 'loopback',
  async handler(req, ctx) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    try {
      const entry = await provider(ctx.params.providerId);
      const user = await getSessionUserOrDefault(req.headers);
      const key = ctx.params.key ?? '';
      const credentials = await clearProviderCredential(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, key, undefined, user.id);
      if (!perPersonKeys(entry).has(key)) await syncSource(user.id, entry, credentials);
      invalidate();
      return Response.json({ ok: true, providerId: entry.descriptor.id, credentials });
    } catch (error) {
      return failure(error);
    }
  },
});

export default [status, save, clear];
