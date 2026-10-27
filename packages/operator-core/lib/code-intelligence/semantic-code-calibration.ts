/** Fixed, pointwise hybrid calibration. Training receives only a separately
 * authored population; neither query identities nor paths are features. */
export type HybridFeatures = readonly [number, number, number];
export type HybridWeights = readonly [number, number, number, number];
export const HYBRID_CALIBRATION_VERSION = 'semantic-hybrid-logistic-v1';
/** Frozen before original20 evaluation. Full training inputs/receipts live in
 * __fixtures__/semantic-hybrid-trained-v1.json; no fitting runs on a query. */
export const SEMANTIC_HYBRID_MODEL = Object.freeze({
  id: 'semantic-hybrid-logistic-v1:disjoint-training-20261023',
  trainingSha256: '2fc31d37e5b2b9e9483933ca2a218cf1dc3303c15d839938e70090c2f23d5eef',
  profile: 'gemma-embeddinggemma-300m-768@v1', dimensions: 768,
  device: 'cuda', dtype: 'fp16', runtime: 'node-onnx-worker',
  weights: [-2.8474562099718463, -1.1835621836616959, 2.7979377090981954, -1.4264721404054665] as HybridWeights,
});
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function hybridFeatures(cosines: readonly number[], relevance: readonly number[]): HybridFeatures[] {
  if (!cosines.length || cosines.length !== relevance.length || cosines.some(n => !Number.isFinite(n) || n < -1.00001 || n > 1.00001)
    || relevance.some(n => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error('Invalid hybrid calibration score population');
  const mean = cosines.reduce((a, b) => a + b, 0) / cosines.length;
  const sd = Math.sqrt(cosines.reduce((n, c) => n + (c - mean) ** 2, 0) / cosines.length);
  return cosines.map((cosine, i) => [cosine, sd > 1e-12 ? (cosine - mean) / sd : 0, relevance[i]!]);
}
export function hybridRelevance(weights: HybridWeights, features: HybridFeatures): number {
  if (![...weights, ...features].every(Number.isFinite)) throw new Error('Non-finite hybrid calibration');
  return sigmoid(weights[0] + features.reduce((n, x, i) => n + x * weights[i + 1]!, 0));
}
export function fitHybridRelevance(rows: readonly { features: HybridFeatures; relevant: boolean }[]): HybridWeights {
  if (!rows.length || !rows.some(row => row.relevant) || rows.every(row => row.relevant)
    || rows.some(row => !row.features.every(Number.isFinite))) throw new Error('Training needs finite positive and negative examples');
  const weights: [number, number, number, number] = [0, 0, 0, 0];
  // Preregistered deterministic full-batch gradient descent; no early stop,
  // class rebalance, per-query fitting, threshold search or evaluation input.
  for (let step = 0; step < 2000; step++) {
    const gradient = [0, 0, 0, 0];
    for (const row of rows) {
      const delta = hybridRelevance(weights, row.features) - Number(row.relevant);
      gradient[0]! += delta;
      row.features.forEach((x, i) => { gradient[i + 1]! += delta * x; });
    }
    for (let i = 0; i < 4; i++) weights[i]! -= .05 * (gradient[i]! / rows.length + (i ? .001 * weights[i]! : 0));
  }
  return weights;
}
