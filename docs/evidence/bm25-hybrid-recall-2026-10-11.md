# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T12:05:59.534Z at commit 55a4d65d55a1b2bb0e8401ee6d5b32231a3d8b0e.
Both arms ran in one process on the identical sample (fingerprint `ffe5c12af7351fc07543d1498afcb7f47e923df2ab65aeb1d86f338fcc921284`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 59/60 (98.3%) | 0.905 | 0 | 156.4 | 1255 | legacy |
| work_item | bm25 | 54/60 (90.0%) | 0.820 | 0 | 42.9 | 71.3 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.782 | 2 | 567.4 | 3210.7 | legacy |
| session_turn | bm25 | 48/60 (80.0%) | 0.724 | 0 | 88.7 | 247.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 54 | 0 | 5 | 1 | fail |
| session_turn | 47 | 1 | 2 | 10 | fail |

- work_item: BM25 recall@10 54/60 is below legacy 59/60
- session_turn: BM25 recall@10 48/60 is below legacy 49/60
