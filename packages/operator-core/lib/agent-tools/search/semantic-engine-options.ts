/**
 * Engine options `search:semantic` passes to `runHybridSearch` that other callers must
 * reproduce exactly. Its own module (not sources.ts or semantic.ts) so the R-18 bench can
 * import it without the tool registration, and so suites that mock `./sources` stay valid.
 */

/**
 * `search:semantic` runs the engine with highlight deferral (WI-4734): the sources skip
 * ts_headline in their legs and the engine hydrates the final fused page only. The R-18
 * bench (search/bench/bm25-hybrid-recall-cli.ts) must time the engine exactly as
 * search:semantic calls it, so both read this constant. R-18 / D-019 (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10): measured on the R-18 tail, inline
 * headlines over each leg's 30-row over-fetch cost up to ~120 ms of a session_turn BM25
 * lexical leg.
 */
export const SEARCH_SEMANTIC_DEFER_HIGHLIGHT = true;
