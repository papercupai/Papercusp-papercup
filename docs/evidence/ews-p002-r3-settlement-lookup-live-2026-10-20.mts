// Live evidence for plan event-wait-settlement-2026-10-20, clause AUTO-BAR-R-3-P-002 (rev 3):
// "The settlement lookup for a fired key reads the new wait-ref index on live-size data."
// Falsifier: EXPLAIN (ANALYZE, BUFFERS) of the settlement lookup on the live papercusp database
// shows a sequential scan of work_items or more than 10 ms (baseline 2026-10-20: ~98 ms).
//
// HOW. Calls the REAL settlement lookups (reconcileEventExternalBlockers in work-items.ts and
// reconcileEventDurableParks in work-items-durable-park-audit.ts) through a client that records
// every statement it sends, then runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the exact
// captured statement with its bound parameters. So it measures the code path, not a hand-copied
// query (the same capture method as event-wait-ref-index.integration.test.ts).
//
// SAFETY. Every statement runs in a transaction that is rolled back, and the key names no
// work item, so the lookups' FOR UPDATE locks no row and nothing is written.
//
// JUDGE. Every pass/fail decision on an EXPLAIN plan is taken by the committed oracle
// scripts/lib/settlement-lookup-explain-live-oracle.mjs (unit-tested, with negative controls, in
// settlement-lookup-explain-live-oracle.test.ts); this script only captures and measures.
//
// RUN.  npx tsx docs/evidence/ews-p002-r3-settlement-lookup-live-2026-10-20.mts
// Prints the evidence JSON; exit 0 = both lookups pass the falsifier, 1 = at least one fails.
import postgres from 'postgres';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { R3_LOOKUPS, R3_MAX_MS, explainTop, judgeR3 } from '../../scripts/lib/settlement-lookup-explain-live-oracle.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = (p: string) => `file://${REPO}/packages/operator-core/lib/${p}`;
const { getHarnessAdminUrl } = await import(lib('embedded-pg-discovery.ts'));
const { reconcileEventExternalBlockers } = await import(lib('work-items.ts'));
const { reconcileEventDurableParks } = await import(lib('work-items-durable-park-audit.ts'));

const KEY = 'work-item:done:WI-r3-live-explain-absent';
const MAX_MS = R3_MAX_MS;
const captured: { query: string; params: unknown[] }[] = [];
const sql = postgres(getHarnessAdminUrl() as string, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  debug: (_c, query, params) => {
    captured.push({ query, params: params as unknown[] });
  },
});
class Rollback extends Error {}
const rolledBack = (e: unknown) => {
  if (!(e instanceof Rollback)) throw e;
};

async function capture(run: (tx: postgres.TransactionSql) => Promise<unknown>, marker: RegExp) {
  captured.length = 0;
  await sql.begin(async (tx) => {
    await run(tx);
    throw new Rollback();
  }).catch(rolledBack);
  const hits = captured.filter((c) => /FROM harness_shared\.work_items/.test(c.query) && marker.test(c.query));
  if (hits.length !== 1) throw new Error(`expected exactly one work_items lookup matching ${marker}, got ${hits.length}`);
  return hits[0]!;
}

const out: Record<string, unknown> = {
  plan: 'event-wait-settlement-2026-10-20',
  clause: 'AUTO-BAR-R-3-P-002@3',
  measuredAt: new Date().toISOString(),
  key: KEY,
  thresholdMs: MAX_MS,
};
const [{ n }] = await sql`SELECT count(*)::bigint AS n FROM harness_shared.work_items`;
out.workItemsRows = Number(n);
const plans: Record<string, ReturnType<typeof explainTop>> = {};
const captures: Record<string, { query: string; params: unknown[] }> = {};
const lookups = [
  ['externalBlockers', (tx: postgres.TransactionSql) => reconcileEventExternalBlockers(tx, KEY, 'probe:r3-live'), /externalBlockers/],
  ['durableParks', (tx: postgres.TransactionSql) => reconcileEventDurableParks(tx, KEY, 'probe:r3-live'), /claim_hold_release/],
] as const;
for (const [name, run, marker] of lookups) {
  const lookup = await capture(run as never, marker);
  let res: unknown;
  await sql.begin(async (tx) => {
    res = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lookup.query}`, lookup.params as never[]);
    throw new Rollback();
  }).catch(rolledBack);
  plans[name] = explainTop(res);
  captures[name] = lookup;
}
if (lookups.map(([name]) => name).join() !== R3_LOOKUPS.map((l) => l.name).join()) {
  throw new Error('probe lookups drifted from the oracle R3_LOOKUPS');
}
const judged = judgeR3(plans, { maxMs: MAX_MS });
for (const [name, v] of Object.entries(judged.results)) {
  const { passed, ...rest } = v;
  out[name] = {
    verdict: passed ? 'pass' : 'fail',
    ...rest,
    statement: captures[name]!.query.replace(/\s+/g, ' ').trim(),
    params: captures[name]!.params,
  };
}
const pass = judged.passed;
out.verdict = pass ? 'pass' : 'fail';
console.log(JSON.stringify(out, null, 2));
await sql.end({ timeout: 5 });
process.exit(pass ? 0 : 1);
