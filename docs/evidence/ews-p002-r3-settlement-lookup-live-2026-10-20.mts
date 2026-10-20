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
// RUN.  npx tsx docs/evidence/ews-p002-r3-settlement-lookup-live-2026-10-20.mts
// Prints the evidence JSON; exit 0 = both lookups pass the falsifier, 1 = at least one fails.
import postgres from 'postgres';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = (p: string) => `file://${REPO}/packages/operator-core/lib/${p}`;
const { getHarnessAdminUrl } = await import(lib('embedded-pg-discovery.ts'));
const { reconcileEventExternalBlockers } = await import(lib('work-items.ts'));
const { reconcileEventDurableParks } = await import(lib('work-items-durable-park-audit.ts'));

const KEY = 'work-item:done:WI-r3-live-explain-absent';
const MAX_MS = 10;
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

type Node = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: Node[] };
type Top = { Plan: Node & { 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number }; 'Execution Time': number };
const flat = (n: Node): Node[] => [n, ...(n.Plans ?? []).flatMap(flat)];

const out: Record<string, unknown> = {
  plan: 'event-wait-settlement-2026-10-20',
  clause: 'AUTO-BAR-R-3-P-002@3',
  measuredAt: new Date().toISOString(),
  key: KEY,
  thresholdMs: MAX_MS,
};
const [{ n }] = await sql`SELECT count(*)::bigint AS n FROM harness_shared.work_items`;
out.workItemsRows = Number(n);
let pass = true;
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
  const top = ((res as Record<string, unknown>[])[0]!['QUERY PLAN'] as Top[])[0]!;
  const nodes = flat(top.Plan);
  const seqScanOnWorkItems = nodes.some((x) => x['Node Type'].includes('Seq Scan') && x['Relation Name'] === 'work_items');
  const ok = !seqScanOnWorkItems && top['Execution Time'] <= MAX_MS;
  pass &&= ok;
  out[name] = {
    verdict: ok ? 'pass' : 'fail',
    executionMs: top['Execution Time'],
    sharedHitBlocks: top.Plan['Shared Hit Blocks'],
    sharedReadBlocks: top.Plan['Shared Read Blocks'],
    seqScanOnWorkItems,
    indexes: nodes.flatMap((x) => (x['Index Name'] ? [x['Index Name']] : [])),
    nodes: nodes.map((x) => `${x['Node Type']}${x['Index Name'] ? `(${x['Index Name']})` : ''}${x['Relation Name'] ? `[${x['Relation Name']}]` : ''}`),
    statement: lookup.query.replace(/\s+/g, ' ').trim(),
    params: lookup.params,
  };
}
out.verdict = pass ? 'pass' : 'fail';
console.log(JSON.stringify(out, null, 2));
await sql.end({ timeout: 5 });
process.exit(pass ? 0 : 1);
