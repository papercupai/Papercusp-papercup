#!/usr/bin/env -S tsx
/** Actual P012 runtime/query path in private pgvector with exact retained
 * document summaries. No new LLM summaries, labels, fitting or cutoff search. */
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createFreshPgDb, applyMigrationForTest } from '../packages/operator-core/test/_pg-helpers';
import { openSemanticCodeIndex, semanticConceptQuery } from '../packages/operator-core/lib/code-intelligence/semantic-code-runtime';
import { SEMANTIC_HYBRID_MODEL } from '../packages/operator-core/lib/code-intelligence/semantic-code-calibration';
import { flushFallbackObservations } from '../packages/operator-core/lib/degradation/fallback-observations';
import { getOrgPg } from '@papercusp/db-org';

const [destination] = process.argv.slice(2);
if (!destination || existsSync(destination) || !process.env.PAPERCUSP_TEST_PG_ADMIN_URL) {
  throw new Error('Run through with-test-pg.mjs: semantic-code-query-replay.mts <new-report.json>');
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const prefix = 'packages/operator-core/lib/code-intelligence/__fixtures__/';
const manifestBytes = await readFile(`${prefix}semantic-calibration-v1.json`);
const retainedBytes = await readFile(`${prefix}semantic-calibration-v2-diagnostics.json`);
const manifest = JSON.parse(manifestBytes.toString()), retained = JSON.parse(retainedBytes.toString());
if (manifest.samples.length !== 20 || retained.documents.length !== 20 || manifest.retrievalCutoff !== .70 || manifest.topK !== 10) {
  throw new Error('Frozen replay population invalid');
}
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
if (!workspaceId) throw new Error('Authorized workspace required');
const report: Record<string, any> = { registration: 'P012-actual-query-hybrid-v1', model: SEMANTIC_HYBRID_MODEL,
  manifestSha256: digest(manifestBytes), retainedSha256: digest(retainedBytes), topK: 10, cutoff: .70,
  startedAt: new Date().toISOString(), queries: [], status: 'unknown' };
let db: Awaited<ReturnType<typeof createFreshPgDb>> | undefined;
let root: string | undefined;
try {
  report.sourceCensus = await Promise.all(['scripts/semantic-code-query-replay.mts',
    'packages/operator-core/lib/code-intelligence/semantic-code.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-runtime.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-relevance.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-calibration.ts'].map(async path => ({ path, sha256: digest(await readFile(path)) })));
  db = await createFreshPgDb('semantic-hybrid-query-replay');
  const migration = resolve('libs/papercusp/libs/db/sql/1568-semantic-code-index.sql');
  await applyMigrationForTest(db.sql, existsSync(migration) ? migration : `${migration}.DRAFT`);
  root = await mkdtemp(join(tmpdir(), 'semantic-hybrid-query-')); await mkdir(join(root, 'src'));
  for (const sample of manifest.samples) await writeFile(join(root, sample.relevant[0]), sample.source);
  const store = await openSemanticCodeIndex(root, workspaceId, db.sql, { background: true,
    retainedSummaries: retained.documents.map((row: any) => ({ path: row.path, blobSha: row.blob_sha, summary: row.summary })) });
  report.embedding = store.space;
  for (const sample of manifest.samples) await store.updateFile(root, sample.relevant[0]);
  for (const sample of manifest.samples) {
    const result = await semanticConceptQuery(root, workspaceId, sample.query, { limit: 10, diagnostics: true }, async () => store);
    const relevant = result.matches.filter(row => sample.relevant.includes(row.path)).length;
    report.queries.push({ id: sample.id, query: sample.query, relevant: sample.relevant, result,
      precision: result.matches.length ? relevant / result.matches.length : 0, hit: relevant > 0 });
    console.error(`P012 actual query ${sample.id}: ${result.status}/${result.relevanceStatus} ${relevant}/${result.matches.length}`);
  }
  report.measurement = { macroPrecision: report.queries.reduce((n: number, q: any) => n + q.precision, 0) / 20,
    hitRate: report.queries.filter((q: any) => q.hit).length / 20 };
  report.status = report.queries.some((q: any) => q.result.status !== 'ok' || q.result.relevanceStatus !== 'measured') ? 'unknown'
    : report.measurement.macroPrecision >= .70 && report.measurement.hitRate >= .70 ? 'passed-current-query-path' : 'failed-current-query-path';
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  if (root) await rm(root, { recursive: true, force: true });
  await db?.cleanup();
  report.observationFlush = await flushFallbackObservations();
  await getOrgPg().sql.end({ timeout: 5 });
  report.finishedAt = new Date().toISOString(); report.receiptDigest = digest(JSON.stringify(report));
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, measurement: report.measurement, error: report.error, destination }));
if (report.status !== 'passed-current-query-path') process.exitCode = 1;
