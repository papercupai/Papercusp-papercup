import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createOwnedExternalTriggerSource,
  disconnectOwnedExternalTriggerSources,
  getDataSourceRecord,
  getExternalTriggerSource,
  listDataSourceRecords,
  listOwnedExternalTriggerSources,
  listPollableExternalTriggerSources,
  renameOwnedExternalTriggerSourceAccount,
  requireExternalTriggerSourceOwner,
  setOwnedExternalTriggerSourceCapability,
  updateExternalTriggerSourceSyncState,
} from './source-store';

const WS = 'external-source-owner-test';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'trigger-owner-' + Date.now()}, 'Trigger Owner')
    RETURNING id`;
  userId = users[0].id;
});

afterAll(async () => {
  if (sql) await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`.catch(() => {});
  if (sql && userId) await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

describe('external trigger source ownership', () => {
  it('persists and resolves only the authenticated local principal', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:test-owner',
      status: 'ready',
      createdBy: 'audit-agent-not-the-user',
      config: { providerSubject: 'untrusted-provider-subject' },
    });

    expect(source).toMatchObject({
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:test-owner',
    });
    await expect(requireExternalTriggerSourceOwner(sql, WS, source.id)).resolves.toBe(userId);
    await expect(getExternalTriggerSource(sql, WS, source.id)).resolves.toMatchObject({ ownerUserId: userId });
  });

  it('fails closed for a legacy row even when audit and provider fields look like users', async () => {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources
        (workspace_id, kind, status, created_by, config)
      VALUES (
        ${WS}, 'gmail', 'ready', ${userId},
        ${JSON.stringify({ userId, owner: userId })}::text::jsonb
      )
      RETURNING id`;

    await expect(requireExternalTriggerSourceOwner(sql, WS, rows[0].id)).rejects.toThrow(
      `external_trigger_source_owner_required:${rows[0].id}`,
    );
  });

  it('enforces the local-user foreign key at the database boundary', async () => {
    await expect(
      createOwnedExternalTriggerSource(sql, {
        workspaceId: WS,
        kind: 'gmail',
        ownerUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/data_sources_owner_user_id_fkey/);
  });

  it('lists only pollable owned sources and persists cursor/status transitions', async () => {
    const extraOwners = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES
        (${'trigger-disabled-' + Date.now()}, 'Disabled Trigger Owner'),
        (${'trigger-recovering-' + Date.now()}, 'Recovering Trigger Owner')
      RETURNING id`;
    const pollable = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: extraOwners[0].id,
      credentialRef: 'google-workspace:owner',
      status: 'ready',
    });
    await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: extraOwners[1].id,
      credentialRef: 'google-workspace:disabled-owner',
      status: 'disabled',
    });
    await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner',
      status: 'connected',
    });
    const recovering = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      credentialRef: 'google-workspace:recovering-owner',
      status: 'connecting',
    });

    await expect(listPollableExternalTriggerSources(sql, WS, 'gcal')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pollable.id, kind: 'gcal', status: 'ready' }),
        expect.objectContaining({ id: recovering.id, kind: 'gcal', status: 'connecting' }),
      ]),
    );

    const connected = await updateExternalTriggerSourceSyncState(sql, WS, pollable.id, {
      status: 'connected',
      cursor: { syncToken: 'sync-2', lastSyncAt: '2026-08-22T12:00:00.000Z' },
      lastError: null,
      connected: true,
    });
    expect(connected).toMatchObject({
      status: 'connected',
      cursor: { syncToken: 'sync-2', lastSyncAt: '2026-08-22T12:00:00.000Z' },
    });

    const degraded = await updateExternalTriggerSourceSyncState(sql, WS, pollable.id, {
      status: 'degraded',
      lastError: 'provider timeout',
    });
    expect(degraded.cursor).toEqual(connected.cursor);
    const stored = await sql<Array<{ last_error: string; last_connected_at: Date | null }>>`
      SELECT last_error, last_connected_at
        FROM harness_shared.data_sources
       WHERE workspace_id = ${WS} AND id = ${pollable.id}::uuid`;
    expect(stored[0].last_error).toBe('provider timeout');
    expect(stored[0].last_connected_at).toBeInstanceOf(Date);
  });

  it('retries a token-not-connected source after a later same-owner sibling connection', async () => {
    const recoveredCredential = 'google-workspace:recovered';
    const foreignCredential = 'google-workspace:foreign-owner';
    const tokenNotConnected = 'oauth: owner-credential not connected';
    const retry = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'gmail-retry',
      credentialRef: recoveredCredential,
      status: 'error',
    });
    const calendar = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      providerAccountId: 'calendar-retry',
      credentialRef: recoveredCredential,
      status: 'connected',
    });
    const providerRejected = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'gmail-provider-rejected',
      credentialRef: recoveredCredential,
      status: 'error',
    });
    const staleProof = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'gmail-stale-proof',
      credentialRef: recoveredCredential,
      status: 'error',
    });
    const noSibling = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'gmail-no-sibling',
      credentialRef: 'google-workspace:no-sibling',
      status: 'error',
    });
    const [otherOwner] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES (${'source-recovery-other-' + Date.now()}, 'Other Source Owner')
      RETURNING id`;
    const foreignOwnerGmail = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'gmail-foreign-owner',
      credentialRef: foreignCredential,
      status: 'error',
    });
    const foreignOwnerCalendar = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: otherOwner.id,
      providerAccountId: 'calendar-foreign-owner',
      credentialRef: foreignCredential,
      status: 'connected',
    });

    await updateExternalTriggerSourceSyncState(sql, WS, calendar.id, {
      status: 'connected',
      lastError: null,
      connected: true,
    });
    await updateExternalTriggerSourceSyncState(sql, WS, foreignOwnerCalendar.id, {
      status: 'connected',
      lastError: null,
      connected: true,
    });
    await sql`
      UPDATE harness_shared.data_sources
         SET last_error = ${tokenNotConnected},
             updated_at = now() - interval '5 minutes'
       WHERE id IN (${retry.id}::uuid, ${noSibling.id}::uuid, ${foreignOwnerGmail.id}::uuid)`;
    await sql`
      UPDATE harness_shared.data_sources
         SET last_error = 'google_gmail_watch_401:Invalid Credentials',
             updated_at = now() - interval '5 minutes'
       WHERE id = ${providerRejected.id}::uuid`;
    await sql`
      UPDATE harness_shared.data_sources
         SET last_error = ${tokenNotConnected},
             updated_at = now() + interval '1 minute'
       WHERE id = ${staleProof.id}::uuid`;

    const pollable = await listPollableExternalTriggerSources(sql, WS, 'gmail');
    expect(pollable.map((source) => source.id)).toEqual([retry.id]);
  });

  it('lists one owner safely and disconnects selected kinds without deleting rows', async () => {
    const otherUsers = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES (${'trigger-other-' + Date.now()}, 'Other Trigger Owner')
      RETURNING id`;
    const gmail = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner-user',
      status: 'connected',
      cursor: { historyId: 'private-provider-cursor', lastSyncAt: '2026-08-23T00:00:00.000Z' },
    });
    const calendar = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gcal',
      ownerUserId: userId,
      credentialRef: 'google-workspace:owner-user',
      status: 'degraded',
    });
    const other = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: otherUsers[0].id,
      credentialRef: 'google-workspace:other-user',
      status: 'connected',
    });

    await expect(listOwnedExternalTriggerSources(sql, WS, userId)).resolves.toEqual([
      expect.objectContaining({ id: calendar.id, kind: 'gcal', ownerUserId: userId }),
      expect.objectContaining({ id: gmail.id, kind: 'gmail', ownerUserId: userId }),
    ]);
    await expect(disconnectOwnedExternalTriggerSources(sql, WS, userId, ['gmail', 'gcal'])).resolves.toEqual({
      sources: 2,
      credentialRefs: ['google-workspace:owner-user'],
    });

    const disconnected = await listOwnedExternalTriggerSources(sql, WS, userId);
    expect(disconnected).toEqual([
      expect.objectContaining({
        id: calendar.id,
        status: 'disabled',
        credentialRef: 'google-workspace:owner-user',
      }),
      expect.objectContaining({
        id: gmail.id,
        status: 'disabled',
        credentialRef: 'google-workspace:owner-user',
      }),
    ]);
    await expect(listPollableExternalTriggerSources(sql, WS, 'gmail')).resolves.toEqual([
      expect.objectContaining({ id: other.id, ownerUserId: otherUsers[0].id }),
    ]);
  });

  it('persists a per-surface toggle without clearing the shared credential or deleting the row', async () => {
    const disabled = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      enabled: false,
      createdBy: `owner:${userId}`,
    });
    expect(disabled).toMatchObject({
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      status: 'disabled',
      config: { capabilityEnabled: false },
    });
    await expect(listPollableExternalTriggerSources(sql, WS, 'contacts')).resolves.toEqual([]);

    const enabled = await setOwnedExternalTriggerSourceCapability(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      kind: 'contacts',
      credentialRef: 'google-workspace:owner-user',
      enabled: true,
      createdBy: `owner:${userId}`,
    });
    expect(enabled).toMatchObject({
      id: disabled.id,
      status: 'connected',
      config: { capabilityEnabled: true },
    });
    await expect(listPollableExternalTriggerSources(sql, WS, 'contacts')).resolves.toEqual([
      expect.objectContaining({ id: disabled.id, credentialRef: 'google-workspace:owner-user' }),
    ]);
  });

  it('keeps provider accounts independent and adopts a canonical identity without replacing rows', async () => {
    const legacy = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'google-workspace:legacy-field',
      credentialRef: 'google-workspace:legacy-field',
      status: 'connected',
      cursor: { historyId: 'keep-legacy-cursor' },
    });
    const second = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: 'second@example.com',
      credentialRef: 'google-workspace:second-field',
      status: 'connected',
      cursor: { historyId: 'keep-second-cursor' },
    });

    const adopted = await renameOwnedExternalTriggerSourceAccount(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      previousProviderAccountId: 'google-workspace:legacy-field',
      providerAccountId: 'first@example.com',
    });
    expect(adopted).toEqual([
      expect.objectContaining({
        id: legacy.id,
        providerAccountId: 'first@example.com',
        cursor: { historyId: 'keep-legacy-cursor' },
      }),
    ]);

    await expect(
      disconnectOwnedExternalTriggerSources(sql, WS, userId, ['gmail'], 'second@example.com'),
    ).resolves.toEqual({ sources: 1, credentialRefs: ['google-workspace:second-field'] });
    await expect(getExternalTriggerSource(sql, WS, legacy.id)).resolves.toMatchObject({
      providerAccountId: 'first@example.com',
      credentialRef: 'google-workspace:legacy-field',
      status: 'connected',
    });
    await expect(getExternalTriggerSource(sql, WS, second.id)).resolves.toMatchObject({
      providerAccountId: 'second@example.com',
      credentialRef: 'google-workspace:second-field',
      status: 'disabled',
    });
  });
});

// enterprise-data-sources P-013 / D-010: the same row read as a data-source record.
describe('data-source record (migration 1317)', () => {
  it('gives an owned source its connector defaults and personal scope without the writer naming them', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      credentialRef: 'google-workspace:data-source-owner',
      status: 'ready',
    });

    await expect(getDataSourceRecord(sql, WS, source.id)).resolves.toMatchObject({
      id: source.id,
      kind: 'gmail',
      ownerUserId: userId,
      syncMode: 'poll',
      backfillStatus: 'not-requested',
      scope: 'personal',
      scopeRef: null,
      datatypeMappings: { message: 'email-message' },
      destinationPolicy: { 'email-message': ['document', 'event'] },
      permissionMapping: { mode: 'owner' },
    });
  });

  it('derives organization scope for an unowned row and filters the list by scope', async () => {
    const [org] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
      VALUES (${WS}, 'slack', 'ready')
      RETURNING id::text AS id`;
    const [pot] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, status, scope, scope_ref)
      VALUES (${WS}, 'webhook', 'ready', 'pot', 'research-pot')
      RETURNING id::text AS id`;

    await expect(getDataSourceRecord(sql, WS, org.id)).resolves.toMatchObject({
      scope: 'organization',
      syncMode: 'socket',
      ownerUserId: null,
    });
    const pots = await listDataSourceRecords(sql, WS, { scope: 'pot' });
    expect(pots.map((r) => [r.id, r.scopeRef, r.syncMode])).toEqual([[pot.id, 'research-pot', 'webhook']]);
    expect((await listDataSourceRecords(sql, WS)).map((r) => r.id).sort()).toEqual([org.id, pot.id].sort());
  });

  it('refuses a personal source with no owner', async () => {
    await expect(
      sql`INSERT INTO harness_shared.data_sources (workspace_id, kind, status, scope)
          VALUES (${WS}, 'gmail', 'ready', 'personal')`,
    ).rejects.toThrow(/data_sources_personal_owner_chk/);
  });
});
