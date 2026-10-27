#!/usr/bin/env -S tsx
/** Maintained R7 measurement. Uses real sidecar + pgvector + configured gateway
 * judge against a frozen labelled sample. Never files work or changes cutoffs. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { openSemanticCodeIndex } from '../packages/operator-core/lib/code-intelligence/semantic-code-runtime';
import { extractSemanticFunctions } from '../packages/operator-core/lib/code-intelligence/semantic-code';
import { judgeSemanticPair, semanticDigest } from '../packages/operator-core/lib/code-intelligence/semantic-code-judge';
import { createFreshPgDb, applyMigrationForTest } from '../packages/operator-core/test/_pg-helpers';
import { existsSync } from 'node:fs';
import { flushFallbackObservations } from '../packages/operator-core/lib/degradation/fallback-observations';

const [destination, model] = process.argv.slice(2);
if (!destination || !model) throw new Error('Usage: semantic-code-calibrate.mts <new-report.json> <exact-configured-model>');
if (existsSync(destination)) throw new Error('Calibration report already exists; preserve prior evidence');
const manifestPath = resolve('packages/operator-core/lib/code-intelligence/__fixtures__/semantic-calibration-v1.json');
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString());
if (manifest.samples.length < 20 || manifest.retrievalCutoff !== .70 || manifest.judgeConfidenceCutoff !== .90
  || manifest.topK !== 10) throw new Error('Frozen calibration contract invalid');
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
if (!workspaceId) throw new Error('Authorized workspace required');
if (!process.env.PAPERCUSP_TEST_PG_ADMIN_URL) throw new Error('Run through scripts/with-test-pg.mjs; a private test DB is required');
const report: Record<string, unknown> = { schemaVersion: 1, registration: manifest.registration,
  manifestSha256, model, retrievalCutoff: .70, judgeConfidenceCutoff: .90, topK: 10,
  startedAt: new Date().toISOString(), queries: [], judgments: [], status: 'unknown' };
let store: Awaited<ReturnType<typeof openSemanticCodeIndex>> | undefined;
let db: Awaited<ReturnType<typeof createFreshPgDb>> | undefined;
let root: string | undefined;
try {
  const sourcePaths = ['packages/operator-core/lib/code-intelligence/semantic-code.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-runtime.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-judge.ts', 'scripts/semantic-code-calibrate.mts'];
  report.sourceCensus = await Promise.all(sourcePaths.map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  // Audit/preflight the provider before paying for a document population. This
  // is one of the preregistered judge cases, reused below, not a discarded trial.
  const judgeCase = async (sample: { id: string; left: string; rightSource: string; expected: string }) => {
    const left = manifest.samples.find((row: { id: string }) => row.id === sample.left);
    const pair = [extractSemanticFunctions({ path: left.relevant[0], source: left.source })[0],
      extractSemanticFunctions({ path: `src/${sample.id}.ts`, source: sample.rightSource })[0]] as const;
    const judgment = await judgeSemanticPair(pair, { model, harness: process.env.PAPERCUSP_HARNESS_SLUG ?? workspaceId });
    return { id: sample.id, expected: sample.expected, pair, judgment };
  };
  const firstJudge = await judgeCase(manifest.judgePairs[0]);
  report.judgments = [firstJudge];
  if (firstJudge.judgment.status === 'unknown') throw new Error(`Provider preflight failed: ${firstJudge.judgment.reason}`);
  db = await createFreshPgDb('semantic-calibration');
  const migration = resolve('libs/papercusp/libs/db/sql/1568-semantic-code-index.sql');
  await applyMigrationForTest(db.sql, existsSync(migration) ? migration : `${migration}.DRAFT`);
  root = await mkdtemp(join(tmpdir(), 'semantic-calibration-'));
  await mkdir(join(root, 'src'));
  for (const sample of manifest.samples) await writeFile(join(root, sample.relevant[0]), sample.source);
  store = await openSemanticCodeIndex(root, workspaceId, db.sql, { background: true, summaryModel: model });
  report.embedding = store.space;
  const queries: unknown[] = [], judgments: Awaited<ReturnType<typeof judgeCase>>[] = [firstJudge];
  report.queries = queries; report.judgments = judgments;
  for (const sample of manifest.samples) await store.updateFile(root, sample.relevant[0]);
  report.documents = await db.sql`SELECT function_id,path,blob_sha,name,line,column_number,summary,normalized_body
    FROM harness_shared.semantic_code_functions WHERE workspace_id=${store.space.workspaceId}
    AND repository_id=${store.space.repositoryId} AND embedding_profile=${store.space.profile} ORDER BY path,line`;
  let precisionSum = 0, hits = 0;
  for (const sample of manifest.samples) {
    const result = await store.search(root, sample.query, { limit: 10, diagnostics: true });
    const relevant = result.matches.filter(row => sample.relevant.includes(row.path)).length;
    const precision = result.matches.length ? relevant / result.matches.length : 0;
    precisionSum += precision; if (relevant) hits++;
    queries.push({ id: sample.id, query: sample.query, relevant: sample.relevant, precision,
      matches: result.matches, vectorStatus: result.vectorStatus, vectorError: result.vectorError,
      indexVersion: result.indexVersion, cutoff: result.relevanceCutoff, diagnostics: result.diagnostics });
    console.error(`P012 calibration query ${sample.id}: ${relevant}/${result.matches.length}`);
  }
  for (const sample of manifest.judgePairs.slice(1)) judgments.push(await judgeCase(sample));
  const macroPrecision = precisionSum / manifest.samples.length, hitRate = hits / manifest.samples.length;
  report.measurement = { macroPrecision, hitRate };
  report.status = macroPrecision >= manifest.minimumMacroPrecision && hitRate >= manifest.minimumHitRate
    && judgments.every(row => row.judgment.parsed?.verdict === row.expected
      && (row.expected !== 'duplicate' || row.judgment.status === 'verified')) ? 'passed' : 'failed';
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  if (store) {
    for (const sample of manifest.samples) await store.removeFile(sample.relevant[0]);
  }
  if (root) await rm(root, { recursive: true, force: true });
  await db?.cleanup();
  report.observationFlush = await flushFallbackObservations();
  await getOrgPg().sql.end({ timeout: 5 });
  report.finishedAt = new Date().toISOString();
  report.receiptDigest = semanticDigest(report);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, manifestSha256, measurement: report.measurement, destination }));
if (report.status !== 'passed') process.exitCode = 1;
