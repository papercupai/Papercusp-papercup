/** Independent D285 physical-writer checks; WI-6554700010020476.
 * Real migrated disposable PG and production projections, with both real folds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { encodeHlc } from '@papercusp/locks-core';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { HIVE_SLUG, WORKSPACE_ID, seedHive } from './_hive-substrate-rig';
import { buildHiveMembersProjection } from '../projections/hive-members';
import { buildUsageProjection } from '../projections/usage';
import { buildFeatureClaimsProjection, type FeatureClaimRow } from '../projections/feature-claims';
import { buildHarnessProjections } from '../projections/register-all';
import { applyOpVia, type TableProjection } from '../projection';
import { createMergeCursor, mergeAdmittedLogs, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import { SNAPSHOT_TABLE_TAG, type SnapshotRow } from '../log-snapshot';
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

  it.each(['full', 'incremental'] as const)('%s fold scopes claim replay authority to the exact receiver-stamped snapshot event', async fold => {
    const db = await createOrgTestDb(); databases.push(db);
    await seedHive(db.adminSql);
    const original = 'a'.repeat(64), carrier = 'b'.repeat(64), own = 'c'.repeat(64);
    const row: FeatureClaimRow = { harness_slug: HIVE_SLUG, feature_id: 'F-P532-REPLAY', seq: 7,
      claimer_pubkey: original, claimer_github_user_id: 101, claimed_at: 1000, outcome: null,
      schema_version: CURRENT_SCHEMA_VERSION };
    const qualified = `${row.feature_id}/${original}/${row.seq}`;
    const legacy = `${row.feature_id}/${row.seq}`;
    const hlc = encodeHlc({ ms: 1000, count: 0 });
    // D289 is a prospective public contract; use a structural option so this
    // fixture runs before the production interface has been implemented.
    type ReplayEvent = Readonly<{ sourceLogKeyHex: string; row: Readonly<FeatureClaimRow>;
      hbKey: string; hlc: string; ts: number; snapshot: Readonly<{ logIndex: number; rowIndex: number }> }>;
    type Verifier = (event: ReplayEvent) => boolean | Promise<boolean>;
    const live = (value = row, hbKey = qualified): PeerLogOp => ({ type: 'put', table: 'claims', hbKey,
      value, ts: 1000, hlc, schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: original });
    const noise = live({ ...row, feature_id: 'F-P532-NOISE', claimer_pubkey: carrier }, `F-P532-NOISE/${carrier}/7`);
    const snapshot = (value = row, hbKey = qualified, clock = hlc, ts = 1000): PeerLogOp => {
      const rows: SnapshotRow[] = [
        { table: 'claims', hbKey: noise.hbKey, value: noise.value, ts: noise.ts, hlc: noise.hlc,
          schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: carrier },
        { table: 'claims', hbKey, value, ts, hlc: clock, schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: original },
      ];
      // A current filtered seed summarizes another log, so the incremental
      // cursor owes these rows even after reading the carrier's noise prefix.
      const producedAt = Date.parse('2026-10-22T00:00:00Z');
      return { type: 'put', table: SNAPSHOT_TABLE_TAG, hbKey: 'snapshot:1', value: { coversUpTo: 1, rows, excludeTables: ['usage'] },
        ts: producedAt, hlc: encodeHlc({ ms: producedAt, count: 0 }), schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: carrier };
    };
    const makeLog = (keyHex: string, rows: PeerLogOp[]): AdmittedLog => ({ keyHex, length: rows.length,
      get: async index => rows[index] ?? null });
    const expected = (hbKey = qualified): ReplayEvent => ({ sourceLogKeyHex: carrier, row, hbKey, hlc, ts: 1000,
      snapshot: { logIndex: 1, rowIndex: 1 } });
    const seen: ReplayEvent[] = [];
    // The receiver owns the verified range and payload, independently of wire flags.
    const verify: Verifier = async event => {
      seen.push(event);
      return event.sourceLogKeyHex === carrier && event.snapshot?.logIndex === 1 && event.snapshot?.rowIndex === 1
        && (event.hbKey === qualified || event.hbKey === legacy) && event.hlc === hlc && event.ts === 1000
        && isDeepStrictEqual(event.row, row);
    };
    const run = async (logs: AdmittedLog[], verifier: Verifier | undefined, registry = false) => {
      await db.adminSql`DELETE FROM harness_shared.feature_claims WHERE harness_slug=${HIVE_SLUG}`;
      seen.splice(0);
      const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: db.adminSql,
        ...(verifier ? { verifyClaimReplay: verifier } : {}) };
      const projection = registry
        ? buildHarnessProjections(opts).find(p => p.tableTag === 'claims')!
        : buildFeatureClaimsProjection(opts) as TableProjection<unknown>;
      const lookup = (table: string) => table === 'claims' ? projection : null;
      const options = { getTimeoutMs: 0, projectionLookup: lookup,
        applyImpl: (op: Parameters<typeof applyOpVia>[1]) => applyOpVia(lookup, op, { ownLogKeyHex: own }) };
      if (fold === 'full') await mergeAdmittedLogs(logs, options);
      else {
        const cursor = createMergeCursor();
        for (let pass = 0; pass < 24; pass++) {
          const result = await mergeAdmittedLogsIncremental(logs, cursor, { ...options, maxOpsPerPass: 1 });
          if (result.caughtUp) break;
        }
      }
      return db.adminSql`SELECT claimer_pubkey,seq,outcome FROM harness_shared.feature_claims
        WHERE harness_slug=${HIVE_SLUG} AND feature_id=${row.feature_id} ORDER BY seq`;
    };

    expect.soft(await run([makeLog(original, [live()])], undefined), 'direct authenticated claim').toEqual([
      { claimer_pubkey: original, seq: 7, outcome: null },
    ]);
    for (const registry of [false, true]) {
      const replay = makeLog(carrier, [noise, snapshot()]);
      expect.soft(await run([replay], verify, registry), `verified replay; registry=${registry}`).toEqual([
        { claimer_pubkey: original, seq: 7, outcome: null },
      ]);
      expect.soft(seen, `full immutable callback event; registry=${registry}`).toContainEqual(expected());
    }
    expect.soft(await run([makeLog(carrier, [noise, snapshot(row, legacy)])], verify), 'verified legacy alias preserves the original event').toEqual([
      { claimer_pubkey: original, seq: 7, outcome: null },
    ]);
    expect.soft(seen, 'legacy wire key reaches the verifier unchanged').toContainEqual(expected(legacy));
    const duplicate = makeLog(carrier, [noise, snapshot(row, legacy), snapshot()]);
    expect.soft(await run([makeLog(original, [live()]), duplicate], verify), 'legacy/qualified/direct replay is one event').toEqual([
      { claimer_pubkey: original, seq: 7, outcome: null },
    ]);

    const deny: Array<{ name: string; log: AdmittedLog; verifier?: Verifier }> = [
      { name: 'absent verifier', log: makeLog(carrier, [noise, snapshot()]) },
      { name: 'untrusted carrier', log: makeLog('d'.repeat(64), [noise, snapshot()]), verifier: verify },
      { name: 'modified immutable payload', log: makeLog(carrier, [noise, snapshot({ ...row, outcome: 'forged' })]), verifier: verify },
      { name: 'different original event', log: makeLog(carrier, [noise, snapshot({ ...row, seq: 8 }, `${row.feature_id}/${original}/8`)]), verifier: verify },
      { name: 'modified original HLC', log: makeLog(carrier, [noise, snapshot(row, qualified, encodeHlc({ ms: 2000, count: 0 }))]), verifier: verify },
      { name: 'modified original timestamp', log: makeLog(carrier, [noise, snapshot(row, qualified, hlc, 2000)]), verifier: verify },
      { name: 'different wire key', log: makeLog(carrier, [noise, snapshot(row, `${row.feature_id}/${original}/9`)]), verifier: verify },
      { name: 'outside verified snapshot range', log: makeLog(carrier, [noise, noise, snapshot()]), verifier: verify },
      { name: 'explicit verifier refusal', log: makeLog(carrier, [noise, snapshot()]), verifier: () => false },
      { name: 'verifier exception', log: makeLog(carrier, [noise, snapshot()]), verifier: () => { throw new Error('unverifiable replay'); } },
      { name: 'wire flag and raw snapshot spoof', log: makeLog(carrier, [Object.assign(live(), {
        verifiedReplay: true, trusted: true, snapshotReplay: { logIndex: 1, rowIndex: 1 },
      })]), verifier: verify },
    ];
    for (const control of deny) {
      expect.soft(await run([control.log], control.verifier), control.name).toEqual([]);
    }
    const later = live({ ...row, seq: 8 }, `${row.feature_id}/${original}/8`);
    expect.soft(await run([makeLog(carrier, [noise, snapshot(), later])], verify), 'snapshot grant does not authorize later live claims').toEqual([
      { claimer_pubkey: original, seq: 7, outcome: null },
    ]);
  });
});
