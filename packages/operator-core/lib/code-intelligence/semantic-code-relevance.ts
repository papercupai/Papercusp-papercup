/** P012 preregistered cross-encoder experiment. Scores are sigmoid relevance,
 * never cosine, calibrated probability, or a semantic duplicate verdict. */
import type { RerankScoreFn } from '@papercusp/rerank';
import type { SemanticCodeFunction } from './semantic-code';

export const SEMANTIC_RERANK_EXPERIMENT = 'P012-retained-top10-cross-encoder-v1';
export const SEMANTIC_SUMMARY_RERANK_EXPERIMENT = 'P012-retained-top10-summary-cross-encoder-v1';
export const SEMANTIC_RERANK_CUTOFF = .70;
export const SEMANTIC_RERANK_TOP_K = 10;
export type RelevanceCandidate = SemanticCodeFunction & { cosineSimilarity: number };

/** No library passthrough: an outage must stay unknown rather than look like
 * a scored result. Keep each raw score aligned with its exact retained input. */
export async function scoreSemanticRelevance(query: string, candidates: readonly RelevanceCandidate[],
  scorer: RerankScoreFn, deadline = Date.now() + 15_000, passage: 'summary-body' | 'summary' = 'summary-body') {
  try {
    if (!query.trim() || query.length > 12_500 || candidates.length > SEMANTIC_RERANK_TOP_K
      || new Set(candidates.map(row => row.id)).size !== candidates.length
      || candidates.some(row => !row.summary.trim() || !row.normalizedBody.trim()
        || row.summary.length > 2_000 || row.normalizedBody.length > 12_000
        || !Number.isFinite(row.cosineSimilarity))) throw new Error('Invalid bounded semantic relevance input');
    if (deadline <= Date.now()) throw new Error('Semantic relevance deadline expired');
    const scores = candidates.length ? await scorer(query,
      candidates.map(row => passage === 'summary' ? row.summary : `${row.summary}\n${row.normalizedBody}`), { deadline }) : [];
    if (deadline <= Date.now()) throw new Error('Semantic relevance deadline expired');
    if (scores.length !== candidates.length || scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)) {
      throw new Error('Semantic relevance scores missing, misaligned, or outside sigmoid units');
    }
    const scored = candidates.map((row, i) => ({ ...row, relevanceScore: scores[i]!,
      relevanceEligible: scores[i]! >= SEMANTIC_RERANK_CUTOFF }));
    const matches = scored.filter(row => row.relevanceEligible).sort((a, b) => b.relevanceScore - a.relevanceScore
      || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column || a.id.localeCompare(b.id))
      .slice(0, SEMANTIC_RERANK_TOP_K);
    return { status: 'measured' as const, scored, matches, error: null };
  } catch (error) {
    return { status: 'unknown' as const, scored: [], matches: [],
      error: error instanceof Error ? error.message : String(error) };
  }
}
