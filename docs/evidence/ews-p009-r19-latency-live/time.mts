// Timing probe for AUTO-BAR-R-19-P-009@3 (event-wait-settlement-2026-10-20, WI-6554700010018160).
// Times the dependency-graph resolvers on the papercusp harness against the database HARNESS_ADMIN_DATABASE_URL
// names: depEdges alone (what the Work-tab pane loaded before the wait leg), depEdges + depWaits concurrently
// (what it loads now: DepGraphPanel fires both named queries), and depWaits alone. Prints one
// `R19_MEASUREMENT <json>` line and judges nothing: run.mjs hands the measurement to
// scripts/lib/dependency-graph-wait-latency-live-oracle.mjs. Run it through run.mjs, which supplies the
// operator's connection string; without one the db library would silently read another database.
import { getOrgPg } from '@papercusp/db-org';
import {
  resolveDependencyGraphEdges,
  resolveDependencyGraphWaits,
} from '../../../packages/operator-core/lib/sync-resolver/dependency-graph-edges.ts';
import { RESOLVER_READ_TIMEOUT_MS } from '../../../packages/operator-core/lib/sync-resolver/read-deadline.ts';

if (!process.env.HARNESS_ADMIN_DATABASE_URL) {
  process.stderr.write('R19_PROBE_REFUSED HARNESS_ADMIN_DATABASE_URL is unset; run docs/evidence/ews-p009-r19-latency-live/run.mjs\n');
  process.exit(2);
}

const WS = 'papercusp-workspace';
const H = 'papercusp';
const RUNS = 5;
const { sql } = getOrgPg();
const db = String(await sql`SELECT current_database() || '@' || inet_server_port() AS d`.then((r) => r[0]?.d));

const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;
const runs: Record<string, unknown>[] = [];
for (let i = 0; i < RUNS; i++) {
  let t = process.hrtime.bigint();
  const edges = await resolveDependencyGraphEdges(sql, { workspaceId: WS, harnessSlug: H });
  const edgesMs = ms(t);
  t = process.hrtime.bigint();
  const [edges2, waits] = await Promise.all([
    resolveDependencyGraphEdges(sql, { workspaceId: WS, harnessSlug: H }),
    resolveDependencyGraphWaits(sql, { workspaceId: WS, harnessSlug: H }),
  ]);
  const edgesPlusWaitsMs = ms(t);
  t = process.hrtime.bigint();
  await resolveDependencyGraphWaits(sql, { workspaceId: WS, harnessSlug: H });
  const waitsAloneMs = ms(t);
  runs.push({
    run: i + 1,
    edgesMs: +edgesMs.toFixed(1),
    edgesPlusWaitsMs: +edgesPlusWaitsMs.toFixed(1),
    waitsAloneMs: +waitsAloneMs.toFixed(1),
    edges: edges.length,
    edgesConcurrent: edges2.length,
    waits: waits.length,
    legs: {
      bound: waits.filter((w) => w.waitKind === 'session-await' && w.bound).length,
      holder: waits.filter((w) => w.waitKind === 'session-await' && !w.bound).length,
      blocker: waits.filter((w) => w.waitKind === 'item-blocker').length,
      truncated: [...new Set(waits.filter((w) => w.legTruncated).map((w) => w.waitKind + (w.bound ? ':bound' : '')))],
    },
    payloadBytes: JSON.stringify(waits).length,
  });
}
process.stdout.write(
  `R19_MEASUREMENT ${JSON.stringify({ db, workspaceId: WS, harnessSlug: H, at: new Date().toISOString(), deadlineMs: RESOLVER_READ_TIMEOUT_MS, runs })}\n`,
);
await sql.end({ timeout: 5 });
