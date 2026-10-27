#!/usr/bin/env -S tsx
/** Preregistered retained-data replay, never a repository scan or fresh summary
 * population. This experimental edition cannot qualify original cosine A. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildSidecarAwareReranker } from '../packages/operator-core/lib/memory/embed-sidecar-wiring';
import { scoreSemanticRelevance, SEMANTIC_RERANK_EXPERIMENT, SEMANTIC_RERANK_CUTOFF,
  SEMANTIC_RERANK_TOP_K, SEMANTIC_SUMMARY_RERANK_EXPERIMENT } from '../packages/operator-core/lib/code-intelligence/semantic-code-relevance';
import { LOCAL_RERANKER_MODEL, rerankExecutionHealth, shutdownLocalReranker } from '@papercusp/rerank';
import { flushFallbackObservations } from '../packages/operator-core/lib/degradation/fallback-observations';
import { getOrgPg } from '@papercusp/db-org';

const [destination, mode = 'summary-body'] = process.argv.slice(2);
if (mode !== 'summary-body' && mode !== 'summary') throw new Error('Passage mode must be preregistered summary-body or summary');
if (!destination || existsSync(destination)) throw new Error('Usage: semantic-code-rerank.mts <new-report.json>; preserve all prior editions');
const inputPath = 'packages/operator-core/lib/code-intelligence/__fixtures__/semantic-calibration-v2-diagnostics.json';
const manifestPath = 'packages/operator-core/lib/code-intelligence/__fixtures__/semantic-calibration-v1.json';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes.toString());
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString());
if (input.queries.length !== 20 || input.documents.length !== 20 || manifest.retrievalCutoff !== .70
  || manifest.topK !== 10 || JSON.stringify(input.queries.map((q: any) => [q.id, q.query, q.relevant]))
  !== JSON.stringify(manifest.samples.map((q: any) => [q.id, q.query, q.relevant]))
  || input.queries.some((q: any) => q.diagnostics.rawTop10.length !== 10)) throw new Error('Retained population differs from preregistration');
const report: Record<string, any> = { schemaVersion: 1,
  registration: mode === 'summary' ? SEMANTIC_SUMMARY_RERANK_EXPERIMENT : SEMANTIC_RERANK_EXPERIMENT, passage: mode,
  qualification: 'experimental-algorithm-B; original-cosine-A-remains-failed',
  input: { path: inputPath, sha256: digest(inputBytes) }, manifest: { path: manifestPath, sha256: digest(manifestBytes) },
  cutoff: SEMANTIC_RERANK_CUTOFF, topK: SEMANTIC_RERANK_TOP_K,
  scoreUnits: 'sigmoid-cross-encoder-relevance; not cosine or calibrated probability',
  scorer: { alias: 'rerank', libraryDefaultModel: LOCAL_RERANKER_MODEL,
    actualSidecarModelRevision: null, unresolved: ['Shared scorer function returns scores without per-call sidecar model/runtime revision'] },
  startedAt: new Date().toISOString(), queries: [], status: 'unknown' };
try {
  report.sourceCensus = await Promise.all(['scripts/semantic-code-rerank.mts',
    'packages/operator-core/lib/code-intelligence/semantic-code-relevance.ts',
    'packages/operator-core/lib/memory/embed-sidecar-wiring.ts', 'libs/generic/rerank/src/sidecar-reranker.ts',
    'libs/generic/rerank/src/local-engine.ts'].map(async path => ({ path, sha256: digest(await readFile(path)) })));
  const scorer = await buildSidecarAwareReranker('rerank');
  for (const q of input.queries) {
    const candidates = q.diagnostics.rawTop10;
    const result = await scoreSemanticRelevance(q.query, candidates, scorer, Date.now() + 15_000, mode);
    const relevant = result.matches.filter(row => q.relevant.includes(row.path)).length;
    report.queries.push({ id: q.id, query: q.query, relevant: q.relevant,
      inputDigest: digest(JSON.stringify({ query: q.query, candidates })),
      ...result, precision: result.matches.length ? relevant / result.matches.length : 0, hit: relevant > 0 });
    console.error(`P012 rerank ${q.id}: ${result.status} ${relevant}/${result.matches.length}`);
  }
  report.measurement = { macroPrecision: report.queries.reduce((n: number, q: any) => n + q.precision, 0) / 20,
    hitRate: report.queries.filter((q: any) => q.hit).length / 20 };
  report.status = report.queries.some((q: any) => q.status !== 'measured') ? 'unknown'
    : report.measurement.macroPrecision >= manifest.minimumMacroPrecision
      && report.measurement.hitRate >= manifest.minimumHitRate ? 'passed-experiment' : 'failed-experiment';
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  report.executionHealth = rerankExecutionHealth();
  await shutdownLocalReranker();
  report.observationFlush = await flushFallbackObservations();
  await getOrgPg().sql.end({ timeout: 5 });
  report.finishedAt = new Date().toISOString();
  report.receiptDigest = digest(JSON.stringify(report));
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, measurement: report.measurement, destination }));
if (report.status !== 'passed-experiment') process.exitCode = 1;
