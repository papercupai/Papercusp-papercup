import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from './bash-substitution/sql-tool-candidates';
import { bindSqlCandidateAuthorityResolver } from './sql-tool-candidate-pull';
import type { SqlCandidateWorklist } from './sql-tool-candidate-worklist';
import { readSqlToolOpportunityLane } from './scout/sql-tool-opportunity-lane';
import tool from './agent-tools/dev/sql_tool_candidates';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
// Keep the expected fail-closed response independent of the production helper.
const unknown: SqlCandidateWorklist = { status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } };
const ctx = { workspaceId: 'sql-mining-test', harnessSlug: 'mining-test', tx: null, log: () => {},
  principal: { kind: 'system' as const, slug: 'fixture', workspaceId: 'sql-mining-test',
    authMethod: 'process-internal' as const, trust: 'trusted' as const, capabilities: new Set(['intel:read']) } };
beforeAll(async () => {
  f = await sqlMiningFixture();
}, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
afterEach(() => { bindSqlCandidateAuthorityResolver(null); });

it('realPG endpoint and Scout return real scoped candidates and exclude a foreign harness OUTCOME-P-008', async () => {
  const sourceId = await f.seed();
  expect((await mineSqlCandidateSlice(f.opts())).status).toBe('ok');
  bindSqlCandidateAuthorityResolver(async request => ({ ...f.opts({ harnessSlug: request.harnessSlug }),
    authorizeSource: async () => true }));
  const allowed = await readSqlToolOpportunityLane(ctx);
  expect(allowed.status).toBe('ok');
  expect(allowed.candidates).toHaveLength(1);
  expect(allowed.candidates[0]!.evidenceRefs).toEqual([{ kind: 'tool-invocation', id: sourceId }]);
  expect(allowed.snapshots).toHaveLength(1);
  expect(await tool.handler({ limit: 25 }, ctx)).toEqual({ data: allowed });
  const operator = { ...ctx, harnessSlug: '*' };
  expect(await tool.handler({ harness: 'foreign' }, operator)).toEqual({ data: unknown });
  expect(await readSqlToolOpportunityLane(operator, { harness: 'foreign' })).toEqual(unknown);
});
it('realPG endpoint and Scout hide counts, membership, history and refs on revoke, unavailable and delete R23-DERIVED-ACL', async () => {
  const ids = [await f.seed(), await f.seed()];
  await mineSqlCandidateSlice(f.opts());
  let state: 'allowed' | 'denied' | 'unavailable' = 'allowed';
  bindSqlCandidateAuthorityResolver(async () => ({ ...f.opts(), authorizeSource: async id => {
    if (state === 'unavailable') throw new Error('source authority unavailable');
    return state === 'allowed' || id !== ids[1];
  } }));
  const allowed = await readSqlToolOpportunityLane(ctx);
  expect(allowed.candidates).toHaveLength(1);
  const id = allowed.candidates[0]!.candidate.id;
  expect(await tool.handler({}, ctx)).toEqual({ data: allowed });
  for (const next of ['denied', 'unavailable'] as const) {
    state = next;
    expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
    expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
  }
  state = 'allowed';
  expect((await readSqlToolOpportunityLane(ctx)).candidates[0]!.candidate.id).toBe(id);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
});
