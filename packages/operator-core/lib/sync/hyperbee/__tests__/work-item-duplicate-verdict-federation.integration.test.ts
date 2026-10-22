/** EI-26637608913287256: duplicate-only CDC and receiver claim-gate parity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { buildHarnessFeaturesProjection } from '../projections/harness-features';
import { buildEngineerIssuesProjection } from '../projections/engineer-issues';
import { admittedWhereSql } from '../../../work-items-admission';

const WS = 'ws-duplicate-wire';
const HARNESS = 'duplicate-wire';
const AUTHOR = 'a'.repeat(64);
const migration = resolve(import.meta.dirname,
  '../../../../../../libs/papercusp/libs/db/sql/1555-work-item-duplicate-verdict-federation.sql');
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  // Exercise the same additive migration before it is armed for live auto-apply.
  await db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8'));
}, 240_000);
afterAll(async () => { await db?.cleanup(); }, 30_000);

async function state(id: string) {
  const [row] = await db.adminSql`
    SELECT duplicate_of, duplicate_source, duplicate_confidence, duplicate_evidence,
           fed_hlc, origin, title
      FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
  return row;
}

async function captured(id: string) {
  return db.adminSql<OutboxRow[]>`
    SELECT table_name, op, key, row, ts::float8 AS ts
      FROM harness_shared.substrate_outbox WHERE workspace_id=${WS}
       AND key=ANY(${[id, `${HARNESS}/${id}`]}::text[]) ORDER BY id`;
}

async function apply(kind: 'feature' | 'bug', value: unknown, ts: number) {
  const options = { workspaceId: WS, harnessSlug: HARNESS, sql: db.adminSql };
  const provenance = { origin: 'remote' as const, authorPubkey: AUTHOR, ts };
  if (kind === 'feature') {
    const projection = buildHarnessFeaturesProjection(options);
    const row = projection.decodeValue(value);
    expect(row).not.toBeNull();
    if (!row) throw new Error('feature verdict did not decode');
    await projection.writeToPg(row, provenance);
  } else {
    const projection = buildEngineerIssuesProjection(options);
    const row = projection.decodeValue(value);
    expect(row).not.toBeNull();
    if (!row) throw new Error('issue verdict did not decode');
    await projection.writeToPg(row, provenance);
  }
}

describe('duplicate verdict survives existing CDC, mapper and receiver', () => {
  for (const kind of ['feature', 'bug'] as const) {
    it(`${kind}: captures duplicate-only updates and clear; legacy updates preserve the gate`, async () => {
      const id = `WI-DUP-WIRE-${kind}`;
      const sql = db.adminSql;
      await sql`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,title,summary,status,item_kind,origin,payload,admission)
        VALUES (${WS},${HARNESS},${id},'duplicate wire','body',${kind === 'bug' ? 'open' : 'todo'},
                ${kind},'local','{}'::jsonb,'admitted')`;
      const before = await state(id);
      expect(await captured(id)).toHaveLength(1);
      await sql`UPDATE harness_shared.work_items
        SET duplicate_of='WI-CANONICAL',duplicate_source='agent'
        WHERE workspace_id=${WS} AND feature_id=${id}`;
      expect((await state(id)).fed_hlc).not.toBe(before.fed_hlc);
      const duplicateOps = await captured(id);
      expect(duplicateOps).toHaveLength(2);
      const duplicateOp = outboxRowToLocalWriteOp(duplicateOps[1]);
      if (duplicateOp.type !== 'put') throw new Error('expected duplicate put');
      expect(duplicateOp.value).toMatchObject({ duplicate_of: 'WI-CANONICAL', duplicate_source: 'agent' });

      // Reject malformed verdicts before PostgreSQL sees them. In particular,
      // String(['agent']) is a valid enum spelling, but an array is not a source.
      const options = { workspaceId: WS, harnessSlug: HARNESS, sql };
      const projection = kind === 'feature'
        ? buildHarnessFeaturesProjection(options) : buildEngineerIssuesProjection(options);
      for (const duplicate_source of [['agent'], { source: 'agent' }, 1, 'unknown']) {
        expect(projection.decodeValue({ ...duplicateOp.value, duplicate_source })).toBeNull();
      }

      await sql`UPDATE harness_shared.work_items SET duplicate_of=NULL,duplicate_source=NULL
        WHERE workspace_id=${WS} AND feature_id=${id}`;
      const clearedOps = await captured(id);
      expect(clearedOps).toHaveLength(3);
      const clearOp = outboxRowToLocalWriteOp(clearedOps[2]);
      if (clearOp.type !== 'put') throw new Error('expected clear put');
      expect(clearOp.value).toMatchObject({ duplicate_of: null, duplicate_source: null });

      // Remove the author row so receiver INSERT and UPDATE both run against
      // the real current schema, including the duplicate-evidence constraints.
      await sql`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
      await apply(kind, duplicateOp.value, 1000);
      expect(await state(id)).toMatchObject({ duplicate_of: 'WI-CANONICAL', duplicate_source: 'agent', origin: 'remote' });
      // Test the duplicate gate shared by both claim paths. The bulk issue-only
      // view additionally excludes remote-origin rows, even without a duplicate.
      expect(await sql`SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id=${WS} AND feature_id=${id} AND ${admittedWhereSql(sql)}`).toHaveLength(0);
      await sql`UPDATE harness_shared.work_items SET duplicate_confidence=1,duplicate_evidence='{"matchedOn":"local"}'::jsonb
        WHERE workspace_id=${WS} AND feature_id=${id}`;

      const legacy: Record<string, unknown> = { ...(duplicateOp.value as Record<string, unknown>), title: 'legacy title update' };
      delete legacy.duplicate_of;
      delete legacy.duplicate_source;
      await apply(kind, legacy, 2000);
      expect(await state(id)).toMatchObject({ title: 'legacy title update', duplicate_of: 'WI-CANONICAL',
        duplicate_source: 'agent', duplicate_confidence: 1, duplicate_evidence: { matchedOn: 'local' } });

      await apply(kind, clearOp.value, 3000);
      expect(await state(id)).toMatchObject({ duplicate_of: null, duplicate_source: null,
        duplicate_confidence: null, duplicate_evidence: null });
      expect(await sql`SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id=${WS} AND feature_id=${id} AND ${admittedWhereSql(sql)}`).toHaveLength(1);
      // An older verdict cannot re-hide the explicitly cleared item.
      await apply(kind, duplicateOp.value, 1500);
      expect((await state(id)).duplicate_of).toBeNull();
    });
  }
});
