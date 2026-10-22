/** Independent D285 physical-writer checks; WI-6554700010020476.
 * Real migrated disposable PG and production projections, with both real folds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { HIVE_SLUG, WORKSPACE_ID, seedHive } from './_hive-substrate-rig';
import { buildHiveMembersProjection } from '../projections/hive-members';
import { buildUsageProjection } from '../projections/usage';
import { buildFeatureClaimsProjection } from '../projections/feature-claims';
import { applyOpVia, type TableProjection } from '../projection';
import { createMergeCursor, mergeAdmittedLogs, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

const databases: OrgTestDb[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.cleanup())); });

describe('P532 prospective real table-family writers', () => {
  it('single admitted writer persists a typed usage row once across replay', async () => {
    const db = await createOrgTestDb(); databases.push(db);
    await seedHive(db.adminSql);
    const projection = buildUsageProjection({ workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: db.adminSql });
    const author = 'a'.repeat(64);
    const op: PeerLogOp = { table: 'usage', hbKey: `101/${author}:control`, type: 'put', ts: 1000,
      hlc: encodeHlc({ ms: 1000, count: 0 }), schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: author,
      value: { harness_slug: HIVE_SLUG, event_id: `${author}:control`, github_user_id: 101,
        device_pubkey: author, kind: 'test', ref_id: null, payload: { units: 1 }, ts: 1000,
        schema_version: CURRENT_SCHEMA_VERSION } };
    const log: AdmittedLog = { keyHex: author, length: 1, get: async index => index === 0 ? op : null };
    const lookup = (table: string) => table === projection.tableTag ? projection as TableProjection<unknown> : null;
    const options = { getTimeoutMs: 0, projectionLookup: lookup,
      applyImpl: (row: Parameters<typeof applyOpVia>[1]) => applyOpVia(lookup, row, { ownLogKeyHex: 'c'.repeat(64) }) };
    await mergeAdmittedLogs([log], options);
    await mergeAdmittedLogs([log], options);
    const rows = await db.adminSql`SELECT event_id,payload FROM harness_shared.contributor_usage_events
      WHERE harness_slug=${HIVE_SLUG} AND event_id=${`${author}:control`}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ units: 1 });
  });

  it.each(['full', 'incremental'] as const)('%s fold preserves set fields, event identities and additive usage under reverse arrivals and replay', async fold => {
    const db = await createOrgTestDb(); databases.push(db);
    await seedHive(db.adminSql);
    const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: db.adminSql };
    const projections = [buildHiveMembersProjection(opts), buildFeatureClaimsProjection(opts), buildUsageProjection(opts)] as TableProjection<unknown>[];
    const lookup = (table: string) => projections.find(p => p.tableTag === table) ?? null;
    const attestation = (device: string) => ({ device_pubkey: device, gist_id: 'fixture', gist_url: 'https://example.invalid/fixture',
      device_label: device, created_at: 1, signature_by_device: 'fixture' });
    const makeRows = (author: string, ms: number): PeerLogOp[] => {
      const values = [
        { table: 'hive-members', hbKey: '101', value: { pot_home_slug: HIVE_SLUG, github_user_id: 101,
          github_username: ms === 2000 ? 'latest-owner' : 'old-owner', device_attestations: [attestation(author)],
          revoked_pubkeys: [`revoked-${author}`], binding_status: 'verified' } },
        { table: 'claims', hbKey: 'F-P532/1', value: { harness_slug: HIVE_SLUG, feature_id: 'F-P532', seq: 1,
          claimer_pubkey: author, claimer_github_user_id: ms, claimed_at: ms, outcome: null, schema_version: CURRENT_SCHEMA_VERSION } },
        { table: 'usage', hbKey: `${ms}/${author}:1`, value: { harness_slug: HIVE_SLUG, event_id: `${author}:1`, github_user_id: ms,
          device_pubkey: author, kind: 'test', ref_id: null, payload: { units: 1 }, ts: ms, schema_version: CURRENT_SCHEMA_VERSION } },
      ];
      return values.map(row => ({ ...row, type: 'put' as const, ts: ms === 1000 ? 99_000 : 1,
        hlc: encodeHlc({ ms, count: 0 }), schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: author }));
    };
    const log = (author: string, ms: number): AdmittedLog => {
      const rows = makeRows(author, ms);
      return { keyHex: author, length: rows.length, get: async index => rows[index] ?? null };
    };
    const a = log('a'.repeat(64), 1000), b = log('b'.repeat(64), 2000);
    for (const logs of [[a, b], [b, a]]) {
      await db.adminSql`DELETE FROM harness_shared.pot_members WHERE workspace_id=${WORKSPACE_ID} AND pot_home_slug=${HIVE_SLUG}`;
      await db.adminSql`DELETE FROM harness_shared.feature_claims WHERE harness_slug=${HIVE_SLUG}`;
      await db.adminSql`DELETE FROM harness_shared.contributor_usage_events WHERE harness_slug=${HIVE_SLUG}`;
      const options = { getTimeoutMs: 0, projectionLookup: lookup,
        applyImpl: (op: Parameters<typeof applyOpVia>[1]) => applyOpVia(lookup, op, { ownLogKeyHex: 'c'.repeat(64) }) };
      const cursor = createMergeCursor();
      for (let replay = 0; replay < 2; replay++) {
        if (fold === 'full') await mergeAdmittedLogs(logs, options);
        else for (let pass = 0; pass < 12; pass++) {
          const result = await mergeAdmittedLogsIncremental(logs, cursor, { ...options, maxOpsPerPass: 1 });
          if (result.caughtUp) break;
        }
      }
      const members = await db.adminSql`SELECT device_attestations,revoked_pubkeys,github_username FROM harness_shared.pot_members
        WHERE workspace_id=${WORKSPACE_ID} AND pot_home_slug=${HIVE_SLUG} AND github_user_id=101`;
      expect.soft(members).toHaveLength(1);
      expect.soft((members[0]?.device_attestations ?? []).map((entry: { device_pubkey: string }) => entry.device_pubkey).sort()).toEqual([a.keyHex, b.keyHex]);
      expect.soft([...(members[0]?.revoked_pubkeys ?? [])].sort()).toEqual([`revoked-${a.keyHex}`, `revoked-${b.keyHex}`]);
      expect.soft(members[0]?.github_username).toBe('latest-owner');
      const claims = await db.adminSql`SELECT claimer_pubkey FROM harness_shared.feature_claims WHERE harness_slug=${HIVE_SLUG} AND feature_id='F-P532'`;
      expect.soft(claims.map(row => row.claimer_pubkey).sort()).toEqual([a.keyHex, b.keyHex]);
      const usage = await db.adminSql`SELECT event_id FROM harness_shared.contributor_usage_events WHERE harness_slug=${HIVE_SLUG}`;
      expect.soft(usage.map(row => row.event_id).sort()).toEqual([`${a.keyHex}:1`, `${b.keyHex}:1`]);
    }
  });
});
