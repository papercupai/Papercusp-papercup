/** Real-PG parity and frozen workload for the P-004 launch-parent projection. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
// scripts/mutation-probe.sh points this test at a frozen copy, preserving the
// shared source and still exercising the same production function at runtime.
const { areAcceptanceLineageRelated, lineagePartyKeys } = await import(
  process.env.PAPERCUSP_LINEAGE_TEST_SOURCE ?? './acceptance-author-identity'
) as typeof import('./acceptance-author-identity');

const workspaceId = 'p004-frozen-lineage';
const migration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1217-adv-session-launch-parent-projection.sql', import.meta.url));
let db: OrgTestDb;

// Keep the real production edge set and recursive query in both arms. Change
// only where the launch parent comes from, so parity cannot pass by comparing
// two independently handwritten implementations of lineage.
function withProjection(
  projected: boolean,
  explain?: (plan: Record<string, unknown>) => void,
  analyze = true,
  sql: Sql = db.adminSql,
): Sql {
  return new Proxy(sql, {
    apply(target, receiver, args: unknown[]) {
      const [first, ...values] = args;
      if (!Array.isArray(first) || !Object.hasOwn(first, 'raw')) return Reflect.apply(target, receiver, args);
      const strings = first.map((part: string) => projected ? part
        : part.replaceAll('launch_parent_owner IS NOT NULL', "NULLIF(launch_spec->>'launchedBy', '') IS NOT NULL")
          .replaceAll('launch_parent_owner', "(launch_spec->>'launchedBy')"));
      const outer = /^\s*WITH RECURSIVE/.test(strings[0]);
      if (explain && outer) {
        strings[0] = (analyze ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ') + strings[0];
      }
      const query = Reflect.apply(target, receiver, [Object.assign(strings, { raw: strings }), ...values]);
      return explain && outer ? query.then((rows: Record<string, unknown>[]) => {
        explain((rows[0]['QUERY PLAN'] as Record<string, unknown>[])[0]);
        return [];
      }) : query;
    },
  }) as Sql;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  // This is a throwaway migrated test DB. Reconstruct its pre-migration shape
  // so the real migration must backfill existing wide rows as well as new ones.
  await db.adminSql`ALTER TABLE harness_shared.adv_sessions DROP COLUMN IF EXISTS launch_parent_owner`;
  // A fixed wide launch document models the prompt-bearing payload that made
  // the live session-edge scan expensive. No production data or credentials.
  await db.adminSql`
    INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,launch_spec)
    SELECT ${workspaceId}, 'console', 'noise-' || n,
           jsonb_build_object('prompt', wide.body) ||
             CASE WHEN n % 4 = 0 THEN jsonb_build_object('launchedBy','noise-parent-' || n) ELSE '{}'::jsonb END
    FROM generate_series(1,4000) n
    CROSS JOIN (SELECT string_agg(md5(i::text), '') body FROM generate_series(1,512) i) wide
  `;
  await db.adminSql`
    INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,launch_spec)
    SELECT ${workspaceId}, 'console', 'chain-' || n, jsonb_build_object('launchedBy','chain-' || (n-1))
    FROM generate_series(1,66) n
  `;
  await db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id,mode,coord_owner_id,launch_spec) VALUES
    (${workspaceId},'console','cycle-a','{"launchedBy":"cycle-b"}'),
    (${workspaceId},'console','cycle-b','{"launchedBy":"cycle-a"}'),
    (${workspaceId},'console','sibling-a','{"launchedBy":"parent"}'),
    (${workspaceId},'console','sibling-b','{"launchedBy":"parent"}'),
    ('p004-other','console','foreign-child','{"launchedBy":"chain-0"}')`;
  await db.adminSql`INSERT INTO harness_shared.consult_state
    (workspace_id,conversation_id,requester_id,responder_id,state,question,latency_contract,routing)
    VALUES (${workspaceId},'p004-consult','requester','chain-2','awaiting_responder','q','proceed',
      '{"selection":{"selected":[{"ownerId":"chain-2","answeringOwnerId":"consult-fork"}]}}')`;
  // A large consult population matters independently of launch payload width.
  // The old per-session exclusion re-expanded every routing document for each
  // session. Include real routed mappings and unrelated wide documents so both
  // the durable fallback and the mapping extraction stay in the production plan.
  await db.adminSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id,conversation_id,requester_id,responder_id,state,question,latency_contract,routing)
    SELECT ${workspaceId}, 'p004-noise-consult-' || n, 'requester', 'noise-source-' || n,
           'awaiting_responder', 'q', 'proceed',
           jsonb_build_object('selection', jsonb_build_object('selected', jsonb_build_array(
             jsonb_build_object('ownerId', 'noise-source-' || n, 'answeringOwnerId', 'noise-answer-' || n)
           )), 'context', repeat(md5(n::text), 128))
      FROM generate_series(1,2500) n
  `;
  // Model a ledger much larger than the consult-answer population. The partial
  // covering index must let the production edge query skip ordinary task rows.
  await db.adminSql`
    INSERT INTO harness_shared.task_ledger
      (task_id,workspace_id,root_task_id,class,title,launched_by,detail)
    SELECT 'p004-ledger-' || n, ${workspaceId}, 'p004-ledger-' || n,
           'agent-session', 'P004 lineage index fixture', 'performance-test',
           CASE WHEN n <= 1500 THEN jsonb_build_object('consultAnswer', jsonb_build_object(
             'operation','fork',
             'conversationId','p004-ledger-consult-' || n,
             'sourceOwnerId',CASE WHEN n = 1 THEN 'chain-2' ELSE 'ledger-source-' || n END,
             'answeringOwnerId',CASE WHEN n = 1 THEN 'consult-fork' ELSE 'ledger-answer-' || n END
           )) ELSE '{}'::jsonb END
      FROM generate_series(1,15000) n
  `;
  await db.adminSql`ANALYZE harness_shared.task_ledger`;
  const ddl = readFileSync(migration, 'utf8');
  await db.adminSql.begin(async (tx) => { await tx.unsafe(ddl); });
  await db.adminSql.begin(async (tx) => { await tx.unsafe(ddl); });
  await db.adminSql`ANALYZE harness_shared.adv_sessions`;
  await db.adminSql`ANALYZE harness_shared.consult_state`;
}, 180_000);

afterAll(async () => { await db?.cleanup(); });

it('scans the routed-consult population once instead of once per launched session', async () => {
  await db.adminSql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`;
      let measured: Record<string, unknown> | undefined;
      await areAcceptanceLineageRelated('chain-0', 'consult-fork', {
        workspaceId,
        sql: withProjection(true, (plan) => { measured = plan; }, true, tx as unknown as Sql),
      });
      expect(measured).toBeDefined();
      const scans: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'consult_state') scans.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit(measured!.Plan as Record<string, unknown>);
      expect(scans).toHaveLength(1);
      expect(scans[0]['Actual Loops']).toBe(1);
  });
});

it('tracks parent edits, absent/blank/null payloads, and pre-existing rows without an application writer', async () => {
  const [row] = await db.adminSql`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,launch_spec)
    VALUES (${workspaceId},'console','update-child','{"launchedBy":"old-parent"}') RETURNING id`;
  for (const [payload, expected] of [
    [{ launchedBy: 'new-parent' }, 'new-parent'], [{ launchedBy: '' }, null],
    [{ launchedBy: null }, null], [{ prompt: 'no parent' }, null], [null, null],
  ] as const) {
    await db.adminSql`UPDATE harness_shared.adv_sessions SET launch_spec=${db.adminSql.json(payload)} WHERE id=${row.id}`;
    const [actual] = await db.adminSql`SELECT launch_parent_owner FROM harness_shared.adv_sessions WHERE id=${row.id}`;
    expect(actual.launch_parent_owner).toBe(expected);
  }
  const [count] = await db.adminSql`SELECT count(*)::int n FROM harness_shared.adv_sessions
    WHERE workspace_id=${workspaceId} AND launch_parent_owner IS DISTINCT FROM NULLIF(launch_spec->>'launchedBy','')`;
  expect(count.n).toBe(0);
});

it('preserves cycles, bounded ancestry, consult ancestry, siblings and tenant exclusion', async () => {
  const cases = [
    ['chain-0','chain-64',true], ['chain-0','chain-65',false],
    ['cycle-a','cycle-b',true], ['chain-0','consult-fork',true],
    ['sibling-a','sibling-b',false], ['chain-0','foreign-child',false],
  ] as const;
  for (const [a,b,expected] of cases) {
    for (const projected of [false,true]) {
      expect(await areAcceptanceLineageRelated(a,b,{sql:withProjection(projected),workspaceId})).toBe(expected);
    }
  }
  const candidates = ['chain-0','chain-2','consult-fork','sibling-a','sibling-b','cycle-a','cycle-b','foreign-child'];
  const legacy = await lineagePartyKeys(candidates,{sql:withProjection(false),workspaceId});
  expect(await lineagePartyKeys(candidates,{sql:withProjection(true),workspaceId})).toEqual(legacy);
}, 60_000);

it('uses the partial task-ledger index and scans consultAnswer edges once', async () => {
  const candidates = ['chain-0','chain-2','consult-fork','sibling-a','sibling-b','cycle-a','cycle-b','foreign-child'];
  const indexes: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  let executionTimeMs: number | null = null;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const entry = node as Record<string, unknown>;
    if (typeof entry['Index Name'] === 'string') indexes.push(entry['Index Name']);
    nodes.push(Object.fromEntries([
      ['nodeType', entry['Node Type']],
      ['relation', entry['Relation Name']],
      ['index', entry['Index Name']],
      ['rows', entry['Plan Rows']],
      ['actualRows', entry['Actual Rows']],
      ['actualLoops', entry['Actual Loops']],
      ['actualTimeMs', entry['Actual Total Time']],
      ['sharedHitBlocks', entry['Shared Hit Blocks']],
      ['indexCond', entry['Index Cond']],
      ['filter', entry.Filter],
    ].filter(([, value]) => value !== undefined)));
    if (Array.isArray(entry.Plans)) entry.Plans.forEach(visit);
  };
  await lineagePartyKeys(candidates, {
    workspaceId,
    sql: withProjection(true, (plan) => {
      executionTimeMs = Number(plan['Execution Time']);
      visit(plan.Plan);
    }),
  });
  console.info('P004_CONSULT_ANSWER_INDEX_PLAN', JSON.stringify({ executionTimeMs, nodes }));
  expect(indexes).toContain('task_ledger_consult_answer_lineage_idx');
  const populationScan = nodes.find((node) =>
    node.relation === 'task_ledger' && Number(node.actualRows) >= 1000,
  );
  expect(populationScan, 'EXPLAIN ANALYZE should expose the full consultAnswer edge scan').toBeDefined();
  expect(populationScan?.actualLoops).toBe(1);
}, 30_000);

it('completes 100 frozen candidate lookups below 500ms p95 with parity and a cheaper measured edge scan', async () => {
  const candidates = ['chain-0','chain-2','consult-fork','sibling-a','sibling-b','cycle-a','cycle-b','foreign-child'];
  const expected = await lineagePartyKeys(candidates,{sql:withProjection(false),workspaceId});
  const timings: {legacy:number[];projected:number[]} = {legacy:[],projected:[]};
  // Counterbalanced blocks limit warm-cache/order confounding.
  for (const projected of [false,true,true,false]) {
    for (let i=0;i<5;i++) {
      const start=performance.now();
      expect(await lineagePartyKeys(candidates,{sql:withProjection(projected),workspaceId})).toEqual(expected);
      timings[projected?'projected':'legacy'].push(performance.now()-start);
    }
  }
  const acceptance:number[]=[];
  for(let i=0;i<100;i++) {
    const start=performance.now();
    expect(await lineagePartyKeys(candidates,{sql:withProjection(true),workspaceId})).toEqual(expected);
    acceptance.push(performance.now()-start);
  }
  const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
  const plans: Record<string,{executionMs:unknown;hits:number;indexes:string[]}> = {};
  for (const projected of [false,true]) {
    await lineagePartyKeys(candidates,{workspaceId,sql:withProjection(projected,(plan)=>{
      const root=plan.Plan as Record<string,unknown>;
      const indexes:string[]=[];
      const visit=(node:unknown):void=>{
        if(!node||typeof node!=='object')return;
        const entry=node as Record<string,unknown>;
        if(typeof entry['Index Name']==='string')indexes.push(entry['Index Name']);
        if(Array.isArray(entry.Plans))entry.Plans.forEach(visit);
      };
      visit(root);
      plans[projected?'projected':'legacy']={executionMs:plan['Execution Time'],hits:Number(root['Shared Hit Blocks']),indexes};
    })});
  }
  console.info('P004_FROZEN_LINEAGE',JSON.stringify({rows:4000,payloadBytes:16384,candidates,
    legacyMedian:percentile(timings.legacy,.5),projectedMedian:percentile(timings.projected,.5),
    completed:acceptance.length,p95:percentile(acceptance,.95),plans}));
  expect(percentile(acceptance,.95)).toBeLessThanOrEqual(500);
  expect(percentile(timings.projected,.5)).toBeLessThan(percentile(timings.legacy,.5));
  expect(plans.projected.indexes).toContain('task_ledger_consult_answer_lineage_idx');
  // Mechanism guard: an index change or a warm cache cannot erase the extra
  // heap/TOAST accesses caused by reading the JSON document for every edge.
  expect(plans.projected.hits).toBeLessThan(plans.legacy.hits);
}, 120_000);
