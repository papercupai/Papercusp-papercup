#!/usr/bin/env -S tsx
/** Fit once on a preregistered, separate population. This module deliberately
 * never imports or reads evaluation data. Every training input/score is kept. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractSemanticFunctions } from '../packages/operator-core/lib/code-intelligence/semantic-code';
import { buildSidecarAwareReranker, resolveProcessSidecarUrl } from '../packages/operator-core/lib/memory/embed-sidecar-wiring';
import { probeSidecarHealth } from '../packages/operator-core/lib/memory/embed-sidecar-spawn';
import { scoreSemanticRelevance } from '../packages/operator-core/lib/code-intelligence/semantic-code-relevance';
import { fitHybridRelevance, hybridFeatures, HYBRID_CALIBRATION_VERSION } from '../packages/operator-core/lib/code-intelligence/semantic-code-calibration';
import { resolveBackfillEmbedder } from '../packages/operator-core/lib/search/embed-backfill';
import { buildQueryEmbedderResolved } from '../packages/operator-core/lib/agent-tools/search/embedder';
import { rerankExecutionHealth, shutdownLocalReranker } from '@papercusp/rerank';
import { flushFallbackObservations } from '../packages/operator-core/lib/degradation/fallback-observations';
import { getOrgPg } from '@papercusp/db-org';

const [destination] = process.argv.slice(2);
if (!destination || existsSync(destination)) throw new Error('Usage: semantic-code-train.mts <new-training-report.json>');
const trainingPath = 'packages/operator-core/lib/code-intelligence/__fixtures__/semantic-hybrid-training-v1.json';
const bytes = await readFile(trainingPath), training = JSON.parse(bytes.toString());
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const report: Record<string, any> = { registration: training.registration, algorithm: HYBRID_CALIBRATION_VERSION,
  manifestSha256: digest(bytes), procedure: training.preregisteredAlgorithm, startedAt: new Date().toISOString(),
  documents: [], queries: [], status: 'unknown' };
const cosine = (a: number[], b: number[]) => {
  if (!a.length || a.length !== b.length || ![...a, ...b].every(Number.isFinite)) throw new Error('Invalid training vector');
  const norm = Math.hypot(...a) * Math.hypot(...b);
  if (!norm) throw new Error('Zero training vector');
  return a.reduce((n, v, i) => n + v * b[i]!, 0) / norm;
};
try {
  report.sourceCensus = await Promise.all(['scripts/semantic-code-train.mts',
    'packages/operator-core/lib/code-intelligence/semantic-code-calibration.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code-relevance.ts'].map(async path => ({ path, sha256: digest(await readFile(path)) })));
  const [document, query, scorer] = await Promise.all([resolveBackfillEmbedder(), buildQueryEmbedderResolved(), buildSidecarAwareReranker('rerank')]);
  if (document.mode === 'disabled' || !query || document.profile.profileId !== query.profile.profileId || document.dims !== query.dims) {
    throw new Error('Training document/query embedding profile unavailable or incompatible');
  }
  report.profile = document.profile.profileId; report.dimensions = document.dims;
  const sidecarUrl = await resolveProcessSidecarUrl();
  const health = sidecarUrl ? await probeSidecarHealth(sidecarUrl) as Record<string, unknown> | null : null;
  report.scorer = { alias: 'rerank', runtime: health?.runtime ?? null, modelRevisions: health?.modelRevisions ?? null,
    rerankExecution: health?.rerankExecution ?? (sidecarUrl ? null : rerankExecutionHealth().active),
    modelRevisionUnresolved: 'Shared score function does not return per-call sidecar revision; health is a separate snapshot' };
  const documents = [];
  for (const sample of training.samples) {
    const functions = extractSemanticFunctions({ path: `src/${sample.id}.ts`, source: sample.source });
    if (functions.length !== 1) throw new Error(`Training extraction failed: ${sample.id}`);
    const source = functions[0]!, fn = { ...source, summary: `${source.summary} — ${sample.summary}` };
    documents.push({ ...fn, embedding: await document.embed(`${fn.summary}\n${fn.normalizedBody}`) });
  }
  report.documents = documents.map(({ embedding, ...fn }) => ({ ...fn, embeddingDigest: digest(JSON.stringify(embedding)) }));
  const rows = [];
  for (const sample of training.samples) {
    const embedded = await query.embed(sample.query);
    const candidates = documents.map(({ embedding, ...fn }) => ({ ...fn, cosineSimilarity: cosine(embedding, embedded) }))
      .sort((a, b) => b.cosineSimilarity - a.cosineSimilarity || a.path.localeCompare(b.path)).slice(0, 10);
    const result = await scoreSemanticRelevance(sample.query, candidates, scorer);
    if (result.status !== 'measured') throw new Error(`Training scorer unavailable: ${sample.id}: ${result.error}`);
    const features = hybridFeatures(result.scored.map(row => row.cosineSimilarity), result.scored.map(row => row.relevanceScore));
    const labelled = features.map((features, i) => ({ features, relevant: result.scored[i]!.path === `src/${sample.id}.ts` }));
    rows.push(...labelled);
    report.queries.push({ id: sample.id, query: sample.query, queryEmbeddingDigest: digest(JSON.stringify(embedded)), scored: result.scored, labelled });
    console.error(`P012 training ${sample.id}: ${labelled.filter(row => row.relevant).length} positives in bounded top10`);
  }
  report.weights = fitHybridRelevance(rows);
  report.status = 'trained-not-evaluated';
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  await shutdownLocalReranker();
  report.observationFlush = await flushFallbackObservations();
  await getOrgPg().sql.end({ timeout: 5 });
  report.finishedAt = new Date().toISOString(); report.receiptDigest = digest(JSON.stringify(report));
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, weights: report.weights, error: report.error, destination }));
if (report.status !== 'trained-not-evaluated') process.exitCode = 1;
