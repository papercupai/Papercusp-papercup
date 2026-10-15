/**
 * Source settings a provider package's own declarations offer on its setup page
 * (cupboard-distributable-integrations-2026-10-10 D-026 ruling 4).
 *
 * Two choices, both read from the descriptor and never from a provider name:
 *
 *   - Who can read what the source syncs. `personal` (the default) keeps it in the owner's own
 *     corpus. `organization` publishes it to the workspace, readable by exactly the people the
 *     provider's membership snapshots name (`permission_mapping {mode:'source-acl'}`). Offered only
 *     when the descriptor declares `membership`, because without membership snapshots an
 *     organization document would have no readers the host could check.
 *   - Live search. The source is searched at read time instead of copied
 *     (`sync_mode = 'federated'`, live-search-adapter.ts): the sync driver gives it no pass and
 *     each search runs as the person asking. Offered only when the descriptor declares the
 *     `search.live` capability; it needs organization scope, because live search serves only
 *     organization sources.
 *
 * The choices ride the existing setup save route (routes/user/provider-credentials.ts), not a new
 * tool, and apply to every source the signed-in owner has for the provider.
 */
import type postgres from 'postgres';
import { PROVIDER_SEARCH_LIVE_CAPABILITY, type ProviderDescriptor } from '@papercusp/plugin-sdk';

export type ProviderSourceScopeChoice = 'personal' | 'organization';

/** What the setup page may offer for a provider, from its descriptor alone. */
export interface ProviderSourceSettingsOffer {
  /** The descriptor declares membership, so a source can be organization-wide. */
  organization: boolean;
  /** The descriptor declares `search.live` (and membership, which organization scope needs). */
  liveSearch: boolean;
}

/** One of the owner's sources after the settings were applied. */
export interface ProviderSourceSettingsState {
  sourceId: string;
  scope: ProviderSourceScopeChoice;
  liveSearch: boolean;
}

export type ProviderSourceSettingsErrorCode =
  | 'invalid-setting'
  | 'scope-not-offered'
  | 'live-search-not-offered'
  | 'live-search-needs-organization'
  | 'no-source';

export class ProviderSourceSettingsError extends Error {
  constructor(
    readonly code: ProviderSourceSettingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSourceSettingsError';
  }
}

const SCOPES: ReadonlySet<string> = new Set<ProviderSourceScopeChoice>(['personal', 'organization']);
const LIVE_SEARCH_SYNC_MODE = 'federated';

/** Organization scope needs membership; live search needs `search.live` and organization scope. */
export function providerSourceSettingsOffer(
  descriptor: Pick<ProviderDescriptor, 'membership' | 'capabilities'>,
): ProviderSourceSettingsOffer {
  const organization = descriptor.membership !== undefined;
  return {
    organization,
    liveSearch: organization && descriptor.capabilities.includes(PROVIDER_SEARCH_LIVE_CAPABILITY),
  };
}

/** Whose sources the settings apply to: the signed-in owner's, in the active workspace. */
export interface ProviderSourceSettingsOwner {
  workspaceId: string;
  ownerUserId: string;
}

interface OwnedSourceRow {
  id: string;
  scope: string;
  sync_mode: string;
}

/**
 * Apply `scope` and/or `liveSearch` to every source the owner has for this provider. Checked
 * before anything is written, so a refused request changes no source. Changing scope restarts the
 * provider's backfill (its cursor is cleared and the source is due now), since what a pass reads
 * depends on the scope (D-026 ruling 1). Turning live search off returns the source to its kind's
 * own sync mode.
 */
export async function applyProviderSourceSettings(
  sql: postgres.Sql,
  owner: ProviderSourceSettingsOwner,
  descriptor: Pick<ProviderDescriptor, 'id' | 'membership' | 'capabilities'>,
  input: { scope?: unknown; liveSearch?: unknown },
): Promise<ProviderSourceSettingsState[]> {
  if (input.scope === undefined && input.liveSearch === undefined) {
    throw new ProviderSourceSettingsError('invalid-setting', 'no source setting was sent');
  }
  if (input.scope !== undefined && (typeof input.scope !== 'string' || !SCOPES.has(input.scope))) {
    throw new ProviderSourceSettingsError('invalid-setting', 'scope must be "personal" or "organization"');
  }
  if (input.liveSearch !== undefined && typeof input.liveSearch !== 'boolean') {
    throw new ProviderSourceSettingsError('invalid-setting', 'liveSearch must be true or false');
  }
  const scope = input.scope as ProviderSourceScopeChoice | undefined;
  const liveSearch = input.liveSearch as boolean | undefined;
  const offer = providerSourceSettingsOffer(descriptor);
  if (scope === 'organization' && !offer.organization) {
    throw new ProviderSourceSettingsError(
      'scope-not-offered',
      `provider "${descriptor.id}" declares no membership, so its sources cannot be organization-wide`,
    );
  }
  if (liveSearch === true && !offer.liveSearch) {
    throw new ProviderSourceSettingsError('live-search-not-offered', `provider "${descriptor.id}" does not offer live search`);
  }

  return sql.begin(async (tx) => {
    // A pot's own source is set by the pot that admits it, never from the setup page.
    const rows = await tx<OwnedSourceRow[]>`
      SELECT id::text, scope, sync_mode
        FROM harness_shared.data_sources
       WHERE workspace_id = ${owner.workspaceId}
         AND kind = ${descriptor.id}
         AND owner_user_id::text = ${owner.ownerUserId}
         AND scope IN ('personal', 'organization')
       ORDER BY id
       FOR UPDATE`;
    if (rows.length === 0) {
      throw new ProviderSourceSettingsError('no-source', `connect ${descriptor.id} before choosing how its source is shared`);
    }
    const planned = rows.map((row) => {
      const nextScope = scope ?? (row.scope as ProviderSourceScopeChoice);
      const nextLive = liveSearch ?? row.sync_mode === LIVE_SEARCH_SYNC_MODE;
      if (nextLive && nextScope !== 'organization') {
        throw new ProviderSourceSettingsError('live-search-needs-organization', 'live search serves organization sources only');
      }
      return { id: row.id, scope: nextScope, liveSearch: nextLive };
    });
    for (const next of planned) {
      const permissionMapping = JSON.stringify(next.scope === 'organization' ? { mode: 'source-acl' } : { mode: 'owner' });
      await tx`
        UPDATE harness_shared.data_sources
           SET sync_mode = CASE
                             WHEN ${next.liveSearch} THEN ${LIVE_SEARCH_SYNC_MODE}
                             WHEN sync_mode = ${LIVE_SEARCH_SYNC_MODE} THEN (harness_shared.data_source_kind_defaults(kind)).sync_mode
                             ELSE sync_mode
                           END,
               cursor = CASE
                          WHEN scope IS DISTINCT FROM ${next.scope}
                            THEN jsonb_set(COALESCE(cursor, '{}'::jsonb), '{provider}', 'null'::jsonb)
                          ELSE cursor
                        END,
               backfill_status = CASE WHEN scope IS DISTINCT FROM ${next.scope} THEN 'pending' ELSE backfill_status END,
               sync_next_attempt_at = CASE WHEN scope IS DISTINCT FROM ${next.scope} THEN NULL ELSE sync_next_attempt_at END,
               scope = ${next.scope},
               scope_ref = NULL,
               permission_mapping = ${permissionMapping}::text::jsonb,
               updated_at = now()
         WHERE workspace_id = ${owner.workspaceId} AND id = ${next.id}::uuid`;
    }
    return planned.map((next) => ({ sourceId: next.id, scope: next.scope, liveSearch: next.liveSearch }));
  });
}
