/**
 * Direct work-item lexical callers must keep the shared D-016 exact-list fusion wired in.
 * Ranking/interleave behavior itself is covered by rank.test.ts; these guards prevent one
 * family from quietly reverting to BM25-only as the source code evolves.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../../work-items.ts', import.meta.url), 'utf8');
const issueStart = SOURCE.indexOf('function issueSearchSource(');
const featureStart = SOURCE.indexOf('function featureSearchSource(');
const featureHydrationStart = SOURCE.indexOf('/** Batch-hydrate feature-family rows by id', featureStart);
const fusionStart = SOURCE.indexOf('async function mergeExactWorkItemBm25(');

describe('direct work-item D-016 exact-list fusion guard', () => {
  it.each([
    ['issue', SOURCE.slice(issueStart, featureStart), 'harness_shared.work_items'],
    ['feature', SOURCE.slice(featureStart, featureHydrationStart), 'harness_shared.harness_features_consolidated'],
  ])('%s lexical family fuses bounded exact rows only on plain BM25 queries', (_family, familySource, table) => {
    expect(familySource).toContain("querySyntax: 'websearch'");
    expect(familySource).toContain("leg.engine === 'bm25' && !usesWebsearchOperators(query)");
    expect(familySource).toContain('mergeExactWorkItemBm25');
    expect(familySource).toContain(`table: '${table}'`);
  });

  it('uses the D-016 exact-list cap and the shared interleaving merger', () => {
    const fusionSource = SOURCE.slice(fusionStart, issueStart);
    expect(fusionStart).toBeGreaterThanOrEqual(0);
    expect(fusionSource).toContain('boundedExactTopK');
    expect(fusionSource).toContain('EXACT_LIST_MAX_AND_ROWS');
    expect(fusionSource).toContain('mergeExactAndBm25');
    expect(fusionSource).toContain('if (exactRows.length === 0) return opts.bm25Rows');
  });
});
