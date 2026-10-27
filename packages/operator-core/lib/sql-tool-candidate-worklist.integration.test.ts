import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sqlMiningFixture } from '../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from './bash-substitution/sql-tool-candidates';
import { readSqlToolCandidateEvidence, readSqlToolCandidateWorklist } from './sql-tool-candidate-worklist';
import { fetchSubstitutionRows } from './bash-substitution/registry';
import { recipeCandidates } from './code-recipes-candidates';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R15 R23 realPG worklist and evidence enforce revoke, restore, unavailable and delete', async () => {
  const ids = [await f.seed(), await f.seed()];
  await mineSqlCandidateSlice(f.opts());
  const opts = { ...f.opts(), authorizeSource: async (_id: string) => true };
  const allowed = await readSqlToolCandidateWorklist(opts, { history: async () => [] });
  expect(allowed.status).toBe('ok'); expect(allowed.candidates).toHaveLength(1);
  const id = allowed.candidates[0]!.candidate.id;
  expect((await readSqlToolCandidateEvidence(opts, id)).examples).toHaveLength(2);
  for (const authorizeSource of [async (source: string) => source !== ids[1],
    async () => { throw new Error('authority unavailable'); }]) {
    expect(await readSqlToolCandidateWorklist({ ...opts, authorizeSource }, { history: async () => [] }))
      .toMatchObject({ status: 'UNKNOWN', candidates: [], population: { candidates: 0 } });
    expect(await readSqlToolCandidateEvidence({ ...opts, authorizeSource }, id))
      .toEqual({ status: 'UNKNOWN', examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 });
  }
  expect((await readSqlToolCandidateWorklist(opts, { history: async () => [] })).candidates).toHaveLength(1);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  expect((await readSqlToolCandidateWorklist(opts, { history: async () => [] })).candidates).toEqual([]);
  expect((await readSqlToolCandidateEvidence(opts, id)).examples).toEqual([]);
});
it('OUTCOME-P-008 realPG harness scope excludes candidates and evidence from another harness', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const result = await readSqlToolCandidateWorklist({ ...f.opts({ harnessSlug: 'another-harness' }),
    authorizeSource: async () => true }, { history: async () => [] });
  expect(result).toMatchObject({ status: 'UNKNOWN', candidates: [], snapshots: [] });
  const denied = await readSqlToolCandidateWorklist({ ...f.opts(), authorize: async () => false,
    authorizeSource: async () => true }, { history: async () => [] });
  expect(denied).toEqual(result);
});
it('R15 R23 realPG evidence hydration rechecks source and scope authority before releasing content', async () => {
  const sourceId = await f.seed();
  await mineSqlCandidateSlice(f.opts());
  const opts = { ...f.opts(), authorizeSource: async () => true };
  const allowed = await readSqlToolCandidateWorklist(opts, { history: async () => [] });
  const candidateId = allowed.candidates[0]!.candidate.id;
  expect((await readSqlToolCandidateEvidence(opts, candidateId)).examples).toHaveLength(1);
  for (const change of ['revoke', 'unavailable', 'scope', 'delete'] as const) {
    let hydrated = false;
    // Execute the real examples query, then change authority before its promise
    // resolves to the reader. This isolates the hydration boundary without timers.
    const client = new Proxy(f.db.adminSql, { apply: async (target, _this, args) => {
      const rows = await Reflect.apply(target, target, args);
      if ((args[0] as TemplateStringsArray).join('').includes('SELECT example,expires_at')) {
        hydrated = true;
        if (change === 'delete') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${sourceId}::bigint`;
      }
      return rows;
    } });
    const result = await readSqlToolCandidateEvidence({ ...opts, client,
      authorize: async () => !(hydrated && change === 'scope'),
      authorizeSource: async () => {
        if (hydrated && change === 'unavailable') throw new Error('source authority unavailable');
        return !(hydrated && change === 'revoke');
      } }, candidateId);
    expect(hydrated).toBe(true);
    expect(result, change).toEqual({ status: 'UNKNOWN', examples: [], evidenceRefs: [], evidenceRefsOmitted: 0 });
    if (change !== 'delete') expect((await readSqlToolCandidateEvidence(opts, candidateId)).examples).toHaveLength(1);
  }
});
it('R8 realPG shadow replay preserves logical demand, recipe candidates and substitution verdicts', async () => {
  const sql = f.db.adminSql;
  await sql`INSERT INTO harness_shared.bash_tool_substitutions
    (workspace_id,intent_label,bash_pattern,tool_name,equivalence_verdict,tier)
    VALUES ('sql-mining-test','shadow-existing','^shadow-read','shadow:read','equivalent','observe')`;
  await sql`INSERT INTO harness_shared.code_recipes
    (id,title,description,script,tools_used,run_count,success_count)
    VALUES ('p008-shadow-existing','Existing recipe','Existing multi-tool demand',
      'throw new Error("must never execute")',ARRAY['alpha:read','beta:read','gamma:read'],20,20)`;
  for (let i = 0; i < 12; i++) {
    const sourceId = await f.seed(`SELECT id FROM jobs WHERE id='shadow-${i}'`,
      `2026-10-${23 + i % 2}T12:00:00.123456Z`);
    await sql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${`su-shadow-${i % 3}`}
      WHERE id=${sourceId}::bigint`;
  }
  const foreignId = await f.seed('SELECT foreign_field FROM foreign_jobs');
  await sql`UPDATE harness_shared.tool_invocations SET harness_slug='foreign' WHERE id=${foreignId}::bigint`;
  const sourceRows = () => sql`SELECT id::text,harness_slug,args_json,status FROM harness_shared.tool_invocations ORDER BY id`;
  const registryBefore = await fetchSubstitutionRows('sql-mining-test', sql);
  const recipesBefore = await recipeCandidates(sql, {});
  expect(registryBefore).toHaveLength(1);
  expect(registryBefore[0]!.equivalenceVerdict).toBe('equivalent');
  expect(recipesBefore.promoteCandidates).toHaveLength(1);
  const sourcesBefore = await sourceRows();
  const drain = async () => {
    for (let page = 0; page < 10; page++) {
      const result = await mineSqlCandidateSlice(f.opts({ rowBudget: 4 }));
      expect(result.status).toBe('ok');
      if (!result.more) return;
    }
    throw new Error('bounded shadow replay did not finish');
  };
  await drain();
  const opts = { ...f.opts(), authorizeSource: async () => true };
  const first = await readSqlToolCandidateWorklist(opts, { history: async () => [] });
  expect(first.status).toBe('ok');
  expect(first.candidates).toHaveLength(1);
  expect(first.candidates[0]!.candidate).toMatchObject({ eligible: true, counts: { ok: 12 } });
  expect(first.candidates[0]!.evidenceRefs).toHaveLength(12);
  expect(first.candidates[0]!.evidenceRefs.some(ref => ref.id === foreignId)).toBe(false);
  await drain();
  expect(await readSqlToolCandidateWorklist(opts, { history: async () => [] })).toEqual(first);
  expect(await sourceRows()).toEqual(sourcesBefore);
  expect(await fetchSubstitutionRows('sql-mining-test', sql)).toEqual(registryBefore);
  expect(await recipeCandidates(sql, {})).toEqual(recipesBefore);
});
