import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { miningScopeId } from '../agent-opportunities/privacy';
import { readSqlIntentRetention } from './sql-intent-corpus';
import { runSqlIntentCensus } from '../harness/routines/sql-read-census-action';
import { submitSqlCandidateReview } from '../sql-tool-candidate-review';
import { captureImprovement } from '../harness/improvements/capture-core';
import { createIssue } from '../issues-engineer';
import { getWorkItem } from '../work-items';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async orig => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => {
  f = await sqlMiningFixture(); h.sql = f.db.adminSql;
  for (const name of ['1581-sql-intent-source-retention-boundary', '1582-sql-intent-retention-settlement-preserves-coverage']) {
    const migration = new URL(`../../../../libs/papercusp/libs/db/sql/${name}.sql`, import.meta.url);
    if (!existsSync(migration)) await f.db.adminSql.unsafe(readFileSync(new URL(migration.href + '.DRAFT'), 'utf8'));
  }
}, 180_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => {
  await f.clear();
  await f.db.adminSql`DELETE FROM harness_shared.sql_candidate_reviews`;
  await f.db.adminSql`DELETE FROM harness_shared.scout_routed_ideas WHERE workspace_id='sql-mining-test'`;
  await f.db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id='sql-mining-test'`;
});
const opts = () => f.opts({ retainedFrom: undefined, rowBudget: 100, timeBudgetMs: 30_000 });
const window = (over: Partial<Parameters<typeof readSqlIntentRetention>[0]> = {}) => ({
  ...opts(), since: '2026-10-18T12:00:00Z', until: '2026-10-25T12:00:00Z', ...over,
});
// Isolated DB fixture models a detector installed before this window. Production
// never sets or accepts a historical baseline via routine configuration.
async function installedBeforeWindow() {
  const o = opts();
  await f.db.adminSql`INSERT INTO harness_shared.sql_intent_progress
    (workspace_id,scope_id,harness_slug,retained_from)
    VALUES (${o.workspaceId},${miningScopeId(o.scope, o.harnessSlug)},${o.harnessSlug},'2026-10-17T00:00:00Z')`;
}
async function demand() {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed('SELECT id FROM jobs', i % 2 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-fixture-' + i % 3}
      WHERE id=${id}::bigint`;
  }
}

it('new production instrumentation cannot attest pre-install retention or enroll demand', async () => {
  await demand();
  expect(await readSqlIntentRetention(window())).toBe('unknown');
  const review = vi.fn();
  expect(await runSqlIntentCensus(opts(), { review })).toMatchObject({ status: 'ok', reviewIntake: { selected: 0 } });
  expect(review).not.toHaveBeenCalled();
  expect(await readSqlIntentRetention(window())).toBe('gap');
  const [row] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
  expect(row!.summary.coverage).toMatchObject({ retention: 'gap', status: 'unknown' });
});

it('native retention proof reaches canonical candidate intake through the production census', async () => {
  await demand(); await installedBeforeWindow();
  expect(await readSqlIntentRetention(window())).toBe('complete');
  let reviewId: string | null = null;
  const result = await runSqlIntentCensus(opts(), { review: async input => {
    const receipt = await submitSqlCandidateReview(input, { client: f.db.adminSql,
      capture: value => captureImprovement(value, { searchIssues: async () => [], createIssue }) });
    expect(receipt).toMatchObject({ status: 'pending', queue: 'agent-review', owner: null });
    reviewId = receipt.workItemId;
    return receipt;
  } });
  expect(result).toMatchObject({ status: 'ok', logicalCalls: 12, reviewIntake: { selected: 1 } });
  const item = await getWorkItem(reviewId!, opts().harnessSlug);
  expect(item).toMatchObject({ state: 'open', assignee: null,
    payload: { agentReview: { status: 'pending', submittedBy: 'system:sql-read-census' } } });
  const [history] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
  expect(history!.summary.coverage).toMatchObject({ retention: 'complete', status: 'complete' });
});

it('source deletion invalidates its exact microsecond boundary without poisoning another scope', async () => {
  const id = await f.seed('SELECT id FROM jobs', '2026-10-18T12:00:00.000000Z');
  await installedBeforeWindow();
  await f.db.adminSql`INSERT INTO harness_shared.sql_intent_progress
    (workspace_id,scope_id,harness_slug,retained_from)
    VALUES ('other-workspace','other-scope','mining-test','2026-10-17T00:00:00Z')`;
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${id}::bigint`;
  expect(await readSqlIntentRetention(window())).toBe('gap');
  expect(await readSqlIntentRetention(window({ since: '2026-10-18T12:00:00.000001Z' }))).toBe('complete');
  expect(await readSqlIntentRetention(window({ workspaceId: 'other-workspace' }))).toBe('complete');
});

it('old-row pruning preserves the window and rolled-back removal preserves the receipt', async () => {
  const old = await f.seed('SELECT id FROM jobs', '2026-10-01T00:00:00Z');
  const recent = await f.seed(); await installedBeforeWindow();
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${old}::bigint`;
  expect(await readSqlIntentRetention(window())).toBe('complete');
  await expect(f.db.adminSql.begin(async tx => {
    await tx`DELETE FROM harness_shared.tool_invocations WHERE id=${recent}::bigint`;
    throw new Error('rollback fixture');
  })).rejects.toThrow('rollback fixture');
  expect(await readSqlIntentRetention(window())).toBe('complete');
});

it('rewriting source identity and truncating source data invalidate retained completeness', async () => {
  const id = await f.seed(); await installedBeforeWindow();
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET harness_slug='other-harness' WHERE id=${id}::bigint`;
  expect(await readSqlIntentRetention(window())).toBe('gap');
  await f.db.adminSql`TRUNCATE harness_shared.tool_invocations`;
  const [row] = await f.db.adminSql`SELECT retained_from >= now() - interval '1 minute' AS reset
    FROM harness_shared.sql_intent_progress`;
  expect(row!.reset).toBe(true);
});

it('normal result-door settlement preserves coverage while source-input rewrites invalidate it', async () => {
  const id = await f.seed(); await installedBeforeWindow();
  // Same columns updated by projected-tool-deps.backfillResultDoorOutputRef.
  await f.db.adminSql`UPDATE harness_shared.tool_invocations
    SET output_ref='papercusp://scratch/settled-source',output_size=42,
      metadata_json='{"mcpRequestSettlement":{"complete":true}}'::jsonb WHERE id=${id}::bigint`;
  expect(await readSqlIntentRetention(window())).toBe('complete');
  await f.db.adminSql`UPDATE harness_shared.tool_invocations
    SET args_json='{"sql":"SELECT id FROM changed_source"}'::jsonb WHERE id=${id}::bigint`;
  expect(await readSqlIntentRetention(window())).toBe('gap');
});

it('wrong scope, future window and a disabled native detector remain UNKNOWN', async () => {
  await installedBeforeWindow();
  expect(await readSqlIntentRetention(window({ harnessSlug: 'unknown-harness' }))).toBe('unknown');
  expect(await readSqlIntentRetention(window({ until: '2999-01-01T00:00:00Z' }))).toBe('unknown');
  await f.db.adminSql`ALTER TABLE harness_shared.tool_invocations DISABLE TRIGGER sql_intent_retention_delete`;
  try { expect(await readSqlIntentRetention(window())).toBe('unknown'); }
  finally { await f.db.adminSql`ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_delete`; }
});
