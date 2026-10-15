import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import { syncGoogleContacts } from '../../personal-vault/live-sink';
import { GOOGLE_CAPABILITY_DEFS, type GoogleCapabilityId } from '../../endpoint-route/routes/user/personal-vault';
import { GOOGLE_WORKSPACE_SOURCE_KINDS } from '../../external-triggers/google-workspace';
import { getSystemAction, type SystemActionCtx } from './system-actions';
import type { ConnectorSyncResult } from '../../providers/connector-runtime';
import {
  runConnectorSyncAction,
  runGoogleContactsPersonalVaultPoll,
  type GoogleContactsPersonalVaultPollDeps,
} from './connector-sync-action';

const ctx: SystemActionCtx = {
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  triggerConfig: {},
  payloadTemplate: null,
};

function source(id: string, config: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: ctx.workspaceId,
    kind: 'contacts',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    providerAccountId: `${id}@example.com`,
    credentialRef: `google-workspace:${id}`,
    status: 'connected',
    config,
    cursor: {},
  };
}

/**
 * D-038 recurrence guard: every surfaced Google Personal Vault capability must
 * have an explicit sync disposition. Gmail and Calendar use connector-sync
 * providers and Contacts uses the custom Vault poller. YouTube was removed from
 * the capability definition (2ead0dbf1b) rather than wired, so it has no row. A
 * capability surfaced later without an ingest path must be added here with
 * route 'missing' and a reason, or the coverage check below fails.
 */
const GOOGLE_VAULT_INGEST_COVERAGE = {
  gmail: { sourceKind: 'gmail', route: 'connector-sync-provider' },
  calendar: { sourceKind: 'gcal', route: 'connector-sync-provider' },
  contacts: { sourceKind: 'contacts', route: 'connector-sync-contacts-poller' },
} as const satisfies Readonly<
  Record<
    GoogleCapabilityId,
    {
      sourceKind: (typeof GOOGLE_CAPABILITY_DEFS)[number]['sourceKind'];
      route: 'connector-sync-provider' | 'connector-sync-contacts-poller' | 'missing';
      reason?: string;
    }
  >
>;

describe('connector-sync Google Contacts Personal Vault path', () => {
  it('accounts for every surfaced Google capability with an explicit Vault ingest disposition', () => {
    const surfacedIds = GOOGLE_CAPABILITY_DEFS.map(({ id }) => id).sort();
    expect(Object.keys(GOOGLE_VAULT_INGEST_COVERAGE).sort()).toEqual(surfacedIds);

    for (const definition of GOOGLE_CAPABILITY_DEFS) {
      expect(GOOGLE_VAULT_INGEST_COVERAGE[definition.id].sourceKind).toBe(definition.sourceKind);
    }

    const connectorProviderKinds = Object.values(GOOGLE_VAULT_INGEST_COVERAGE)
      .filter((entry) => entry.route === 'connector-sync-provider')
      .map((entry) => entry.sourceKind)
      .sort();
    expect(connectorProviderKinds).toEqual(GOOGLE_WORKSPACE_SOURCE_KINDS.filter((kind) => kind !== 'contacts').sort());
  });

  it('polls connected sources with their token-store install and retries a People API 401', async () => {
    const current = source('contacts-one', { installSlug: 'google-install' });
    const sql = {} as Sql;
    const listSources = vi.fn(async () => [current]);
    const syncContacts = vi.fn(async (_sql: Sql, input: Parameters<typeof syncGoogleContacts>[1]) => {
      if (input.accessToken === 'expired-token') throw new Error('google_people_401');
      return { contacts: 2, pages: 2, nextPageToken: null };
    });
    const withAccessTokenRetry: NonNullable<GoogleContactsPersonalVaultPollDeps['withAccessTokenRetry']> =
      async (_source, _installSlug, call) => {
        const first = await call('expired-token');
        if (first.status === 401) return (await call('fresh-token')).result;
        return first.result;
      };
    const updateSource = vi.fn(async () => current);
    // vi.fn's call signature drops the <T> generic, so the spy is kept for assertions and
    // cast only where it enters the deps seam.
    const withAccessTokenRetrySpy = vi.fn(withAccessTokenRetry);
    const deps: GoogleContactsPersonalVaultPollDeps = {
      listSources,
      syncContacts,
      withAccessTokenRetry: withAccessTokenRetrySpy as unknown as typeof withAccessTokenRetry,
      updateSource,
    };

    const result = await runGoogleContactsPersonalVaultPoll(ctx, sql, deps);

    expect(result).toEqual({ sources: 1, succeeded: 1, failed: 0, contacts: 2, pages: 2, failures: [] });
    expect(listSources).toHaveBeenCalledWith(sql, ctx.workspaceId, 'contacts');
    expect(withAccessTokenRetrySpy).toHaveBeenCalledWith(current, 'google-install', expect.any(Function));
    expect(syncContacts).toHaveBeenNthCalledWith(1, sql, {
      workspaceId: ctx.workspaceId,
      userId: current.ownerUserId,
      sourceId: current.id,
      providerAccountId: current.providerAccountId,
      accessToken: 'expired-token',
    });
    expect(syncContacts).toHaveBeenNthCalledWith(2, sql, expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(updateSource).toHaveBeenCalledWith(sql, ctx.workspaceId, current.id, {
      status: 'connected',
      lastError: null,
      connected: true,
    });
  });

  it('keeps transient provider failures degraded and terminal refreshed 401s reconnect-required', async () => {
    const providerFailure = source('contacts-provider');
    const authFailure = source('contacts-auth');
    const sql = {} as Sql;
    const updateSource = vi.fn(async () => providerFailure);
    const deps: GoogleContactsPersonalVaultPollDeps = {
      listSources: vi.fn(async () => [providerFailure, authFailure]),
      withAccessTokenRetry: async (current, _installSlug, call) => {
        if (current.id === authFailure.id) throw new Error('oauth: contacts still 401 after refresh; reconnect required');
        const response = await call('token');
        return response.result;
      },
      syncContacts: vi.fn(async () => {
        throw new Error('google_people_503');
      }),
      updateSource,
    };

    const result = await runGoogleContactsPersonalVaultPoll(ctx, sql, deps);

    expect(result).toMatchObject({ sources: 2, succeeded: 0, failed: 2, contacts: 0, pages: 0 });
    expect(result.failures).toEqual([
      { sourceId: providerFailure.id, status: 'degraded', error: 'google_people_503' },
      {
        sourceId: authFailure.id,
        status: 'error',
        error: 'oauth: contacts still 401 after refresh; reconnect required',
      },
    ]);
    expect(updateSource).toHaveBeenNthCalledWith(1, sql, ctx.workspaceId, providerFailure.id, {
      status: 'degraded',
      lastError: 'google_people_503',
    });
    expect(updateSource).toHaveBeenNthCalledWith(2, sql, ctx.workspaceId, authFailure.id, {
      status: 'error',
      lastError: 'oauth: contacts still 401 after refresh; reconnect required',
    });
  });

  it('runs the Contacts poller from the existing connector-sync action', async () => {
    const sql = {} as Sql;
    const runGoogleContacts = vi.fn(async (): Promise<Awaited<ReturnType<typeof runGoogleContactsPersonalVaultPoll>>> => ({
      sources: 1,
      succeeded: 1,
      failed: 0,
      contacts: 2,
      pages: 1,
      failures: [],
    }));

    const result = await runConnectorSyncAction(ctx, {
      sql,
      reconcilePush: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorWakes: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorSync: vi.fn(async () => ({ providers: [], sources: [] }) as never),
      runParticipantBackfills: vi.fn(async () => []),
      runGoogleContacts,
      runChatRollup: vi.fn(async () => NO_CHAT),
    });

    expect(getSystemAction('connector-sync')).toBeTypeOf('function');
    expect(runGoogleContacts).toHaveBeenCalledWith(ctx, sql);
    expect(result.diagnostics).toMatchObject({ contactsSources: 1, contactsSynced: 2, contactsPages: 1, contactsFailed: 0 });
  });

  it('does not turn a source awaiting required config into a routine soft error', async () => {
    const sql = {} as Sql;
    const runConnectorSync = vi.fn(async (): Promise<ConnectorSyncResult> => ({
      providers: 1,
      sources: [{
        sourceId: 'linear-source-needs-config',
        providerId: 'linear',
        outcome: 'needs-config',
        mode: 'backfill',
        pages: 0,
        admitted: 0,
        deduped: 0,
        rejected: 0,
        cursorReset: false,
        hasMore: false,
        missingConfig: ['teamIds'],
      }],
    }));

    const result = await runConnectorSyncAction(ctx, {
      sql,
      reconcilePush: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorWakes: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorSync,
      runParticipantBackfills: vi.fn(async () => []),
      runGoogleContacts: vi.fn(async () => ({
        sources: 0,
        succeeded: 0,
        failed: 0,
        contacts: 0,
        pages: 0,
        failures: [],
      })),
      runChatRollup: vi.fn(async () => NO_CHAT),
    });

    expect(result.diagnostics).toMatchObject({ sources: 1, failed: 0, admitted: 0 });
    expect(runConnectorSync).toHaveBeenCalledWith(sql, { workspaceId: ctx.workspaceId, harness: ctx.installSlug });
    expect(result).not.toHaveProperty('softError');
  });
});

const NO_CHAT = {
  buckets: 0, unitsWritten: 0, unitsRemoved: 0, expired: 0, documentsExpired: 0, documentsHeldKept: 0, legacyMigrated: 0,
  failed: 0, deadLettered: 0, failures: [],
};

function quietDeps(sql: Sql) {
  return {
    sql,
    reconcilePush: vi.fn(async () => ({ sources: [] }) as never),
    runConnectorWakes: vi.fn(async () => ({ sources: [] }) as never),
    runConnectorSync: vi.fn(async () => ({ providers: 0, sources: [] }) as never),
    runParticipantBackfills: vi.fn(async () => []),
    runGoogleContacts: vi.fn(async () => ({ sources: 0, succeeded: 0, failed: 0, contacts: 0, pages: 0, failures: [] })),
  };
}

// D-016 (papercusp-enterprise-readiness-roadmap-2026-10-09): the chat rollup driver runs each tick.
describe('connector-sync chat rollup step', () => {
  it('runs the chat rollup pass for the workspace and reports its counts', async () => {
    const sql = {} as Sql;
    const runChatRollup = vi.fn(async () => ({
      buckets: 3, unitsWritten: 2, unitsRemoved: 1, expired: 4, documentsExpired: 6, documentsHeldKept: 7, legacyMigrated: 5,
      failed: 0, deadLettered: 0, failures: [],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runConnectorSyncAction(ctx, { ...quietDeps(sql), runChatRollup });

    expect(runChatRollup).toHaveBeenCalledWith(sql, { workspaceId: ctx.workspaceId });
    expect(result.diagnostics).toMatchObject({
      chatBuckets: 3, chatUnitsWritten: 2, chatUnitsRemoved: 1, chatExpired: 4, chatDocumentsExpired: 6,
      chatDocumentsHeldKept: 7, chatLegacyMigrated: 5, chatRollupFailed: 0, chatBucketsFailed: 0, chatBucketsDeadLettered: 0,
    });
    expect(result).not.toHaveProperty('softError');
  });

  // WI-6554700010011913: the pass survives a failing bucket; the bucket is named in the soft error.
  it('a bucket that failed and was re-queued is a soft error naming the bucket', async () => {
    const sql = {} as Sql;
    const runChatRollup = vi.fn(async () => ({
      buckets: 2, unitsWritten: 1, unitsRemoved: 0, expired: 0, documentsExpired: 0, documentsHeldKept: 0, legacyMigrated: 0,
      failed: 1, deadLettered: 0,
      failures: [{
        dataSourceId: 'ds-1', channelId: 'C1', bucketKind: 'thread' as const, bucketKey: '1.1', error: 'boom',
        attempts: 2, deadLettered: false,
      }],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runConnectorSyncAction(ctx, { ...quietDeps(sql), runChatRollup });

    expect(result.diagnostics).toMatchObject({
      chatBuckets: 2, chatUnitsWritten: 1, chatRollupFailed: 0, chatBucketsFailed: 1, chatBucketsDeadLettered: 0,
    });
    expect(result.softError).toContain('chat rollup: 1 bucket(s) failed (1 re-queued, 0 dead-lettered): ds-1/C1/thread:1.1:boom (attempt 2)');
  });

  // WI-6554700010012111: a bucket that reached the attempt cap is reported as dead-lettered, not re-queued.
  it('a dead-lettered bucket is reported as dead-lettered', async () => {
    const sql = {} as Sql;
    const runChatRollup = vi.fn(async () => ({
      buckets: 1, unitsWritten: 0, unitsRemoved: 0, expired: 0, documentsExpired: 0, documentsHeldKept: 0, legacyMigrated: 0,
      failed: 1, deadLettered: 1,
      failures: [{
        dataSourceId: 'ds-1', channelId: 'C1', bucketKind: 'day' as const, bucketKey: '2026-09-30', error: 'boom',
        attempts: 8, deadLettered: true,
      }],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runConnectorSyncAction(ctx, { ...quietDeps(sql), runChatRollup });

    expect(result.diagnostics).toMatchObject({ chatBucketsFailed: 1, chatBucketsDeadLettered: 1 });
    expect(result.softError).toContain(
      'chat rollup: 1 bucket(s) failed (0 re-queued, 1 dead-lettered): ds-1/C1/day:2026-09-30:boom (attempt 8, dead-lettered)');
  });

  it('a failed rollup is a soft error, never a failed pass', async () => {
    const sql = {} as Sql;
    const runChatRollup = vi.fn(async () => { throw new Error('rollup exploded'); });
    const result = await runConnectorSyncAction(ctx, { ...quietDeps(sql), runChatRollup });

    expect(result.diagnostics).toMatchObject({ chatBuckets: 0, chatRollupFailed: 1 });
    expect(result.softError).toContain('chat rollup failed: rollup exploded');
  });
});
