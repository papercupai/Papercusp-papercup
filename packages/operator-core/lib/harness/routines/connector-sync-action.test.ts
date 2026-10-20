import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { GOOGLE_CAPABILITY_DEFS, type GoogleCapabilityId } from '../../endpoint-route/routes/user/personal-vault';
import type { SystemActionCtx } from './system-actions';
import type { ConnectorSyncResult } from '../../providers/connector-runtime';
import type { LegacyCredentialAdoption } from '../../integrations/connection-lifecycle';
import { runConnectorSyncAction } from './connector-sync-action';

const ctx: SystemActionCtx = {
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  triggerConfig: {},
  payloadTemplate: null,
};

const NO_CHAT = {
  buckets: 0, unitsWritten: 0, unitsRemoved: 0, expired: 0, documentsExpired: 0, documentsHeldKept: 0, legacyMigrated: 0,
  failed: 0, deadLettered: 0, failures: [],
};

/** Every step stubbed quiet, so a fake `sql` never reaches a real step. */
function quietDeps(sql: Sql) {
  return {
    sql,
    adoptLegacyCredentials: vi.fn(async (): Promise<LegacyCredentialAdoption[]> => []),
    reconcilePush: vi.fn(async () => ({ sources: [] }) as never),
    runConnectorWakes: vi.fn(async () => ({ sources: [] }) as never),
    runConnectorSync: vi.fn(async () => ({ providers: 0, sources: [] }) as never),
    runParticipantBackfills: vi.fn(async () => []),
    runChatRollup: vi.fn(async () => NO_CHAT),
  };
}

const PLUGINS_DIR = fileURLToPath(new URL('../../../../../libs/papercusp/plugins/', import.meta.url));

/** Provider ids of the in-tree packages that share the one Google grant (credentialGroup `google`). */
function googleCredentialGroupProviderIds(): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PLUGINS_DIR, entry.name, 'papercusp.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      provider?: { id?: string; oauth?: { credentialGroup?: string } };
    };
    if (manifest.provider?.oauth?.credentialGroup === 'google' && manifest.provider.id) ids.push(manifest.provider.id);
  }
  return ids.sort();
}

/**
 * D-038 recurrence guard: every surfaced Google Personal Vault capability must
 * have an explicit sync disposition. Since provider-adapters-to-packages-2026-10-11
 * D-036 all three sync through connector-sync providers in the `google` credential
 * group (the gmail, google-calendar and google-contacts packages); the custom
 * Contacts poller is gone. YouTube was removed from the capability definition
 * (2ead0dbf1b) rather than wired, so it has no row. A capability surfaced later
 * without an ingest path must be added here with route 'missing' and a reason, or
 * the coverage check below fails.
 */
const GOOGLE_VAULT_INGEST_COVERAGE = {
  gmail: { sourceKind: 'gmail', route: 'connector-sync-provider' },
  calendar: { sourceKind: 'gcal', route: 'connector-sync-provider' },
  contacts: { sourceKind: 'contacts', route: 'connector-sync-provider' },
} as const satisfies Readonly<
  Record<
    GoogleCapabilityId,
    {
      sourceKind: (typeof GOOGLE_CAPABILITY_DEFS)[number]['sourceKind'];
      route: 'connector-sync-provider' | 'missing';
      reason?: string;
    }
  >
>;

/**
 * Packages in the `google` credential group that the Personal Vault deliberately does not
 * surface, each with its reason. A new group member must land here or in the coverage map.
 */
const GOOGLE_GROUP_NOT_IN_VAULT: Readonly<Record<string, string>> = {
  youtube: 'shares the Google grant but has no Personal Vault capability (removed from the capability list in 2ead0dbf1b)',
};

describe('connector-sync Google Personal Vault ingest coverage', () => {
  it('accounts for every surfaced Google capability with an explicit Vault ingest disposition', () => {
    const surfacedIds = GOOGLE_CAPABILITY_DEFS.map(({ id }) => id).sort();
    expect(Object.keys(GOOGLE_VAULT_INGEST_COVERAGE).sort()).toEqual(surfacedIds);

    for (const definition of GOOGLE_CAPABILITY_DEFS) {
      expect(GOOGLE_VAULT_INGEST_COVERAGE[definition.id].sourceKind).toBe(definition.sourceKind);
    }

    // Each connector-sync source kind is a provider package in the one Google grant, and every
    // other package in that grant is an explicit, reasoned exclusion.
    const connectorProviderKinds = Object.values(GOOGLE_VAULT_INGEST_COVERAGE)
      .filter((entry) => entry.route === 'connector-sync-provider')
      .map((entry) => entry.sourceKind);
    expect([...connectorProviderKinds, ...Object.keys(GOOGLE_GROUP_NOT_IN_VAULT)].sort()).toEqual(
      googleCredentialGroupProviderIds(),
    );
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

    const result = await runConnectorSyncAction(ctx, { ...quietDeps(sql), runConnectorSync });

    expect(result.diagnostics).toMatchObject({ sources: 1, failed: 0, admitted: 0 });
    expect(runConnectorSync).toHaveBeenCalledWith(sql, { workspaceId: ctx.workspaceId, harness: ctx.installSlug });
    expect(result).not.toHaveProperty('softError');
  });
});

// provider-adapters-to-packages-2026-10-11 D-037: a connection stored before its provider moved
// into a package is adopted by the connector sync itself, before any step reads a credential ref.
describe('connector-sync legacy credential adoption', () => {
  it('adopts legacy credentials before any connector step reads a credential ref', async () => {
    const sql = {} as Sql;
    const order: string[] = [];
    const adopted: LegacyCredentialAdoption[] = [
      { legacyPlugin: 'google-workspace', plugin: 'provider:google', fieldsCopied: 4, sourcesRewritten: 9 },
      { legacyPlugin: 'older-plugin', plugin: 'provider:other', fieldsCopied: 1, sourcesRewritten: 2 },
    ];
    const adoptLegacyCredentials = vi.fn(async () => {
      order.push('adopt');
      return adopted;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runConnectorSyncAction(ctx, {
      ...quietDeps(sql),
      adoptLegacyCredentials,
      reconcilePush: vi.fn(async () => {
        order.push('push');
        return { sources: [] } as never;
      }),
      runConnectorWakes: vi.fn(async () => {
        order.push('wakes');
        return { sources: [] } as never;
      }),
      runConnectorSync: vi.fn(async () => {
        order.push('sync');
        return { providers: 0, sources: [] } as never;
      }),
    });

    expect(adoptLegacyCredentials).toHaveBeenCalledWith(sql, { workspaceId: ctx.workspaceId, harness: ctx.installSlug });
    expect(order).toEqual(['adopt', 'push', 'wakes', 'sync']);
    expect(result.diagnostics).toMatchObject({ legacySourcesRewritten: 11 });
    expect(result).not.toHaveProperty('softError');
  });

  it('an adoption failure is a soft error and the rest of the tick still runs', async () => {
    const sql = {} as Sql;
    const deps = quietDeps(sql);

    const result = await runConnectorSyncAction(ctx, {
      ...deps,
      adoptLegacyCredentials: vi.fn(async () => {
        throw new Error('token store unreadable');
      }),
    });

    expect(deps.runConnectorSync).toHaveBeenCalledWith(sql, { workspaceId: ctx.workspaceId, harness: ctx.installSlug });
    expect(result.diagnostics).toMatchObject({ legacySourcesRewritten: 0 });
    expect(result.softError).toContain('legacy credential adoption failed: token store unreadable');
  });
});

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
