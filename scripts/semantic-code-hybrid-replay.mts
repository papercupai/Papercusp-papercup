#!/usr/bin/env -S tsx
/** Evaluate already frozen weights on retained B scores. No fitting/inference;
 * this is a diagnostic experiment, not actual production-path qualification. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hybridFeatures, hybridRelevance, type HybridWeights } from '../packages/operator-core/lib/code-intelligence/semantic-code-calibration';

const [destination] = process.argv.slice(2);
if (!destination || existsSync(destination)) throw new Error('Usage: semantic-code-hybrid-replay.mts <new-report.json>');
const prefix = 'packages/operator-core/lib/code-intelligence/__fixtures__/';
const paths = { model: `${prefix}semantic-hybrid-trained-v1.json`, input: `${prefix}semantic-rerank-experiment-v1.json`,
  manifest: `${prefix}semantic-calibration-v1.json` };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytes = await Promise.all(Object.values(paths).map(path => readFile(path)));
const [model, input, manifest] = bytes.map(data => JSON.parse(data.toString()));
if (model.status !== 'trained-not-evaluated' || model.weights.length !== 4 || input.queries.length !== 20
  || input.queries.some((q: any) => q.status !== 'measured' || q.scored.length !== 10)
  || JSON.stringify(input.queries.map((q: any) => [q.id, q.query, q.relevant]))
    !== JSON.stringify(manifest.samples.map((q: any) => [q.id, q.query, q.relevant]))) throw new Error('Frozen hybrid inputs invalid');
const queries = input.queries.map((q: any) => {
  const features = hybridFeatures(q.scored.map((row: any) => row.cosineSimilarity), q.scored.map((row: any) => row.relevanceScore));
  const scored = q.scored.map((row: any, i: number) => ({ ...row, features: features[i],
    hybridRelevance: hybridRelevance(model.weights as HybridWeights, features[i]!) }));
  const matches = scored.filter((row: any) => row.hybridRelevance >= .70)
    .sort((a: any, b: any) => b.hybridRelevance - a.hybridRelevance || a.path.localeCompare(b.path)).slice(0, 10);
  const relevant = matches.filter((row: any) => q.relevant.includes(row.path)).length;
  return { id: q.id, query: q.query, relevant: q.relevant, scored, matches,
    precision: matches.length ? relevant / matches.length : 0, hit: relevant > 0 };
});
const measurement = { macroPrecision: queries.reduce((n: number, q: any) => n + q.precision, 0) / 20,
  hitRate: queries.filter((q: any) => q.hit).length / 20 };
const report = { registration: 'P012-frozen-disjoint-training-hybrid-retained-v1',
  qualification: 'retained experiment only; actual production-path replay required; no cross-dtype claim',
  inputs: Object.entries(paths).map(([key, path], i) => ({ key, path, sha256: digest(bytes[i]!) })),
  weights: model.weights, scorer: model.scorer, profile: model.profile, cutoff: .70, topK: 10, queries, measurement,
  status: measurement.macroPrecision >= .70 && measurement.hitRate >= .70 ? 'passed-retained-hybrid-experiment' : 'failed-retained-hybrid-experiment' };
await writeFile(destination, JSON.stringify({ ...report, receiptDigest: digest(JSON.stringify(report)) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: report.status, measurement, destination }));
if (report.status !== 'passed-retained-hybrid-experiment') process.exitCode = 1;
