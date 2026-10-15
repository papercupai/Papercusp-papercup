/**
 * datatype-nature.integration.test.ts — the work/data boundary on the datatype registry,
 * against real Postgres (enterprise-data-sources-2026-10-01 P-008; spec AUTO-BAR-R-2-P-008).
 *
 * The spec's falsifier names three ways the boundary can be wrong, and each block below
 * fails on exactly one of them:
 *   1. meta:define-datatype accepts a NEW declaration that carries no nature.
 *   2. A datatype_registry row has a null (or out-of-vocabulary) nature after migration 1318.
 *   3. Human-decision work such as email-draft-proposal is classified as agent work.
 *
 * The unit test (agent-tools/datatypes/declare.test.ts) mocks the registry reads; this one
 * runs the real tool handler over the real migrated schema, so a refusal that only holds
 * against a mock — or a migration that leaves rows unclassified — fails here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { BUILTIN_WORK_ITEM_KIND_NATURES, getDatatype } from '../datatype-registry-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../agent-tools/coordination/identity', async (orig) => ({
  ...(await orig<typeof import('../agent-tools/coordination/identity')>()),
  resolveAgentIdentity: () => ({ ownerId: 'su-nature-it', kind: 'superuser' }),
}));
// No embedder in the test box: the handler already treats a null embedder as "lexical leg
// only", so pin that path instead of letting it probe for a model.
vi.mock('../agent-tools/search/embedder', async (orig) => ({
  ...(await orig<typeof import('../agent-tools/search/embedder')>()),
  buildQueryEmbedderResolved: async () => null,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const declare = (await import('../agent-tools/datatypes/declare')).default;

const MIGRATION_1318 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1318-datatype-nature.sql', import.meta.url),
);
const MIGRATION_1407 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1407-email-draft-proposal-agent-audience.sql', import.meta.url),
);
const WS = 'ws-nature-it';

type Reply = { ok: boolean; reason?: string; message?: string; datatype?: { id: string } };

async function define(args: Record<string, unknown>): Promise<Reply> {
  const out = (await declare.handler(
    { description: 'a datatype declared by the nature integration test', ...args } as never,
    { workspaceId: WS, harnessSlug: 'papercusp', role: 'operator', log() {} } as never,
  )) as { data: Reply };
  return out.data;
}

describe('datatype nature — the work/data boundary (real PG, P-008)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('meta:define-datatype refuses a new declaration with no nature and writes no row', async () => {
    const r = await define({ name: 'nature-it-ledger', tier: 'projection' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nature_required');
    expect(await getDatatype(db.adminSql, WS, 'nature-it-ledger')).toBeNull();
  });

  it('calibration: the same declaration WITH a nature passes the gate and stores that nature', async () => {
    // Without this, test 1 would also pass against a handler that refuses everything.
    const r = await define({ name: 'nature-it-ledger', tier: 'projection', nature: 'record' });
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
    const row = await getDatatype(db.adminSql, WS, 'nature-it-ledger');
    expect(row?.nature).toBe('record');
    expect(row?.audience ?? null).toBeNull();
  });

  it('work must name its audience; the refusal happens before any write', async () => {
    const r = await define({ name: 'nature-it-triage', tier: 'projection', nature: 'work' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('audience_required');
    expect(await getDatatype(db.adminSql, WS, 'nature-it-triage')).toBeNull();
  });

  it('the schema makes nature mandatory and closed-vocabulary, and no row is left without one', async () => {
    const [col] = await db.adminSql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'datatype_registry' AND column_name = 'nature'`;
    expect(col?.is_nullable).toBe('NO');

    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.datatype_registry
       WHERE nature IS NULL OR nature NOT IN ('work', 'record', 'document', 'event')`;
    expect(n).toBe(0);

    await expect(
      db.adminSql`INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier, nature)
                  VALUES ('nature-it-bad', ${WS}, 'Bad', 'bad nature', 'projection', 'banana')`,
    ).rejects.toThrow(/datatype_registry_nature_check/);
    await expect(
      db.adminSql`INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier, nature)
                  VALUES ('nature-it-noaud', ${WS}, 'No audience', 'work with no audience', 'projection', 'work')`,
    ).rejects.toThrow(/datatype_registry_audience_check/);
  });

  it('migration 1318 classifies email-draft-proposal as HUMAN work and the built-in kinds as agent work', async () => {
    // A legacy row as the deployed release writes it (no nature): the expand-phase trigger
    // fills the tier default, generic-kind → work for AGENTS — the misclassification the
    // migration's named classification must correct.
    await db.adminSql`
      INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier, work_item_kind)
      VALUES ('email-draft-proposal', ${WS}, 'Email draft proposal', 'a drafted reply awaiting a human decision',
              'generic-kind', 'email-draft-proposal')`;
    const [before] = await db.adminSql<{ nature: string; audience: string | null }[]>`
      SELECT nature, audience FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id = 'email-draft-proposal'`;
    expect(before).toEqual({ nature: 'work', audience: 'agent' });

    // Re-apply the real migration file (it is idempotent by construction).
    await db.adminSql.unsafe(readFileSync(MIGRATION_1318, 'utf8')).simple();

    const [after] = await db.adminSql<{ nature: string; audience: string | null }[]>`
      SELECT nature, audience FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id = 'email-draft-proposal'`;
    expect(after).toEqual({ nature: 'work', audience: 'human' });

    const builtins = await db.adminSql<{ id: string; nature: string; audience: string | null }[]>`
      SELECT id, nature, audience FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace' AND id = ANY(${Object.keys(BUILTIN_WORK_ITEM_KIND_NATURES)})
       ORDER BY id`;
    expect(builtins.map((b) => b.id).sort()).toEqual(Object.keys(BUILTIN_WORK_ITEM_KIND_NATURES).sort());
    for (const b of builtins) expect({ id: b.id, nature: b.nature, audience: b.audience }).toEqual({
      id: b.id,
      nature: 'work',
      audience: 'agent',
    });
  });

  // app-agent-tasks-durable-execution-2026-10-06 D-016: Email's durable draft operations
  // execute email-draft-proposal items with the agent role email-draft-worker, and a
  // human-audience row is never agent-claimable, so 1407 reclassifies the kind as agent work.
  // A registry change restamps every item already minted with that kind (migration 1322's
  // restamp_work_items_on_registry_change on datatype_registry), so open legacy drafts become
  // agent work too. The plan's D-018 records that correction to D-016.
  it('migration 1407 reclassifies email-draft-proposal as AGENT work, restamping minted items', async () => {
    const ws = 'ws-nature-it-1407';
    await db.adminSql`
      INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier, work_item_kind)
      VALUES ('email-draft-proposal', ${ws}, 'Email draft proposal', 'a drafted reply',
              'generic-kind', 'email-draft-proposal')`;
    await db.adminSql.unsafe(readFileSync(MIGRATION_1318, 'utf8')).simple();

    const mint = (id: string) => db.adminSql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts)
      VALUES ('email', ${id}, 'email-draft-proposal', ${`draft ${id}`}, 'open', ${ws}, 1, 1)`;
    const audiences = async () => db.adminSql<{ feature_id: string; audience: string | null }[]>`
      SELECT feature_id, audience FROM harness_shared.work_items
       WHERE workspace_id = ${ws} ORDER BY feature_id`;

    await mint('WI-nature-1407-a-before');
    expect(await audiences()).toEqual([{ feature_id: 'WI-nature-1407-a-before', audience: 'human' }]);

    await db.adminSql.unsafe(readFileSync(MIGRATION_1407, 'utf8')).simple();

    const [registry] = await db.adminSql<{ nature: string; audience: string | null }[]>`
      SELECT nature, audience FROM harness_shared.datatype_registry
       WHERE workspace_id = ${ws} AND id = 'email-draft-proposal'`;
    expect(registry).toEqual({ nature: 'work', audience: 'agent' });

    // The registry-side restamp trigger re-derives the already-minted item.
    expect(await audiences()).toEqual([{ feature_id: 'WI-nature-1407-a-before', audience: 'agent' }]);

    await mint('WI-nature-1407-b-after');
    expect(await audiences()).toEqual([
      { feature_id: 'WI-nature-1407-a-before', audience: 'agent' },
      { feature_id: 'WI-nature-1407-b-after', audience: 'agent' },
    ]);

    // Idempotent: re-applying 1407 matches no registry row, so nothing changes.
    await db.adminSql.unsafe(readFileSync(MIGRATION_1407, 'utf8')).simple();
    const [reapplied] = await db.adminSql<{ nature: string; audience: string | null }[]>`
      SELECT nature, audience FROM harness_shared.datatype_registry
       WHERE workspace_id = ${ws} AND id = 'email-draft-proposal'`;
    expect(reapplied).toEqual({ nature: 'work', audience: 'agent' });
    expect(await audiences()).toEqual([
      { feature_id: 'WI-nature-1407-a-before', audience: 'agent' },
      { feature_id: 'WI-nature-1407-b-after', audience: 'agent' },
    ]);
  });
});
