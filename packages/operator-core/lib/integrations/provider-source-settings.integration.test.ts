/**
 * Source settings a provider's own declarations offer on its setup page
 * (cupboard-distributable-integrations-2026-10-10 D-026 ruling 4): who can read a source and
 * whether it is searched live, applied to the signed-in owner's sources on a real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER_SEARCH_LIVE_CAPABILITY, type ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { applyProviderSourceSettings, providerSourceSettingsOffer } from './provider-source-settings';

const WS = 'provider-source-settings-test';
const OTHER_WS = 'provider-source-settings-other';
const KIND = 'settings-fixture';

type Descriptor = Pick<ProviderDescriptor, 'id' | 'membership' | 'capabilities'>;

const plain: Descriptor = { id: KIND, capabilities: ['mail.read'] };
const withMembership: Descriptor = {
  id: KIND,
  capabilities: ['mail.read'],
  membership: { identityProvider: 'fixture', containers: true },
};
const withLiveSearch: Descriptor = {
  id: KIND,
  capabilities: ['mail.read', PROVIDER_SEARCH_LIVE_CAPABILITY],
  membership: { identityProvider: 'fixture', containers: true },
};

let org: OrgTestDb;

beforeAll(async () => {
  org = await createOrgTestDb();
});

afterAll(async () => {
  await org?.cleanup();
});

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function user(): Promise<string> {
  const name = unique('settings-user');
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${name}, ${name}) RETURNING id::text`;
  return row.id;
}

/** A source mid-sync: a provider cursor, a finished backfill and a next pass an hour out. */
async function source(owner: string, opts: { scope?: 'personal' | 'pot'; workspaceId?: string } = {}): Promise<string> {
  const scope = opts.scope ?? 'personal';
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, provider_account_id, status, owner_user_id, scope, scope_ref, cursor, backfill_status, sync_next_attempt_at)
    VALUES (${opts.workspaceId ?? WS}, ${KIND}, ${unique('acct')}, 'ready', ${owner}::uuid, ${scope},
            ${scope === 'pot' ? 'settings-pot' : null}, ${org.adminSql.json({ provider: 'c5', other: 'keep' })},
            'complete', now() + interval '1 hour')
    RETURNING id::text`;
  return row.id;
}

interface SourceRow {
  scope: string;
  scope_ref: string | null;
  sync_mode: string;
  permission_mode: string;
  backfill_status: string;
  cursor_provider: string | null;
  cursor_other: string | null;
  due_now: boolean;
}

async function read(id: string): Promise<SourceRow> {
  const [row] = await org.adminSql<SourceRow[]>`
    SELECT scope, scope_ref, sync_mode, permission_mapping->>'mode' AS permission_mode, backfill_status,
           cursor->>'provider' AS cursor_provider, cursor->>'other' AS cursor_other,
           sync_next_attempt_at IS NULL AS due_now
      FROM harness_shared.data_sources
     WHERE id = ${id}::uuid`;
  return row;
}

async function kindDefaultSyncMode(): Promise<string> {
  const [row] = await org.adminSql<{ sync_mode: string }[]>`
    SELECT (harness_shared.data_source_kind_defaults(${KIND})).sync_mode AS sync_mode`;
  return row.sync_mode;
}

const owner = (ownerUserId: string) => ({ workspaceId: WS, ownerUserId });

describe('providerSourceSettingsOffer', () => {
  it('offers organization scope only with membership, and live search only with search.live and membership', () => {
    expect(providerSourceSettingsOffer(plain)).toEqual({ organization: false, liveSearch: false });
    expect(providerSourceSettingsOffer(withMembership)).toEqual({ organization: true, liveSearch: false });
    expect(providerSourceSettingsOffer({ capabilities: [PROVIDER_SEARCH_LIVE_CAPABILITY] })).toEqual({
      organization: false,
      liveSearch: false,
    });
    expect(providerSourceSettingsOffer(withLiveSearch)).toEqual({ organization: true, liveSearch: true });
  });
});

describe('applyProviderSourceSettings', () => {
  it('refuses a setting the descriptor does not offer, or a malformed one, and writes nothing', async () => {
    const me = await user();
    const src = await source(me);
    const before = await read(src);
    const refusals: Array<[Descriptor, { scope?: unknown; liveSearch?: unknown }, string]> = [
      [withLiveSearch, {}, 'invalid-setting'],
      [withLiveSearch, { scope: 'pot' }, 'invalid-setting'],
      [withLiveSearch, { liveSearch: 'yes' }, 'invalid-setting'],
      [plain, { scope: 'organization' }, 'scope-not-offered'],
      [withMembership, { liveSearch: true }, 'live-search-not-offered'],
      [withLiveSearch, { liveSearch: true }, 'live-search-needs-organization'],
      [withLiveSearch, { scope: 'personal', liveSearch: true }, 'live-search-needs-organization'],
    ];
    for (const [descriptor, input, code] of refusals) {
      await expect(applyProviderSourceSettings(org.adminSql, owner(me), descriptor, input), JSON.stringify(input)).rejects.toMatchObject({
        name: 'ProviderSourceSettingsError',
        code,
      });
    }
    expect(await read(src)).toEqual(before);
  });

  it('publishes a personal source to the organization and restarts its backfill; the same scope again changes nothing', async () => {
    const me = await user();
    const src = await source(me);
    const ownMode = (await read(src)).sync_mode;
    expect(await read(src)).toMatchObject({ scope: 'personal', permission_mode: 'owner', cursor_provider: 'c5', due_now: false });

    const applied = await applyProviderSourceSettings(org.adminSql, owner(me), withMembership, { scope: 'organization' });
    expect(applied).toEqual([{ sourceId: src, scope: 'organization', liveSearch: false }]);
    expect(await read(src)).toEqual({
      scope: 'organization',
      scope_ref: null,
      sync_mode: ownMode,
      permission_mode: 'source-acl',
      backfill_status: 'pending',
      cursor_provider: null,
      cursor_other: 'keep',
      due_now: true,
    });

    // Unchanged scope: the backfill the first change started is left alone.
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET backfill_status = 'complete', cursor = ${org.adminSql.json({ provider: 'c6' })}, sync_next_attempt_at = now() + interval '1 hour'
       WHERE id = ${src}::uuid`;
    await applyProviderSourceSettings(org.adminSql, owner(me), withMembership, { scope: 'organization' });
    expect(await read(src)).toMatchObject({ scope: 'organization', backfill_status: 'complete', cursor_provider: 'c6', due_now: false });

    // Back to personal: owner-only readership and another fresh backfill.
    await applyProviderSourceSettings(org.adminSql, owner(me), withMembership, { scope: 'personal' });
    expect(await read(src)).toMatchObject({ scope: 'personal', permission_mode: 'owner', backfill_status: 'pending', cursor_provider: null, due_now: true });
  });

  it('turns live search on for an organization source and off again back to the kind default', async () => {
    const me = await user();
    const src = await source(me);
    const kindDefault = await kindDefaultSyncMode();
    expect(kindDefault).not.toBe('federated');

    const on = await applyProviderSourceSettings(org.adminSql, owner(me), withLiveSearch, { scope: 'organization', liveSearch: true });
    expect(on).toEqual([{ sourceId: src, scope: 'organization', liveSearch: true }]);
    expect(await read(src)).toMatchObject({ scope: 'organization', sync_mode: 'federated', permission_mode: 'source-acl' });

    // A federated source cannot drop to personal while live search stays on.
    await expect(applyProviderSourceSettings(org.adminSql, owner(me), withLiveSearch, { scope: 'personal' })).rejects.toMatchObject({
      code: 'live-search-needs-organization',
    });
    expect(await read(src)).toMatchObject({ scope: 'organization', sync_mode: 'federated' });

    const off = await applyProviderSourceSettings(org.adminSql, owner(me), withLiveSearch, { liveSearch: false });
    expect(off).toEqual([{ sourceId: src, scope: 'organization', liveSearch: false }]);
    expect(await read(src)).toMatchObject({ scope: 'organization', sync_mode: kindDefault });

    // Both at once: live search off and personal scope in one request.
    await applyProviderSourceSettings(org.adminSql, owner(me), withLiveSearch, { scope: 'organization', liveSearch: true });
    await applyProviderSourceSettings(org.adminSql, owner(me), withLiveSearch, { scope: 'personal', liveSearch: false });
    expect(await read(src)).toMatchObject({ scope: 'personal', sync_mode: kindDefault, permission_mode: 'owner' });
  });

  it("refuses an owner with no source, and never touches a pot's source, another owner's or another workspace's", async () => {
    const me = await user();
    const someoneElse = await user();
    await expect(applyProviderSourceSettings(org.adminSql, owner(me), withMembership, { scope: 'organization' })).rejects.toMatchObject({
      code: 'no-source',
    });

    const mine = await source(me);
    const potSource = await source(me, { scope: 'pot' });
    const theirs = await source(someoneElse);
    const elsewhere = await source(me, { workspaceId: OTHER_WS });
    const untouched = await Promise.all([potSource, theirs, elsewhere].map(read));

    const applied = await applyProviderSourceSettings(org.adminSql, owner(me), withMembership, { scope: 'organization' });
    expect(applied.map((s) => s.sourceId)).toEqual([mine]);
    expect(await read(mine)).toMatchObject({ scope: 'organization' });
    expect(await Promise.all([potSource, theirs, elsewhere].map(read))).toEqual(untouched);
  });
});
