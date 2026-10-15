# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T12:27:17.618Z at commit ec2cca21317db465fa47c9fc49b103e729bc97a7.
Both arms ran in one process on the identical sample (fingerprint `ffe5c12af7351fc07543d1498afcb7f47e923df2ab65aeb1d86f338fcc921284`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 59/60 (98.3%) | 0.905 | 0 | 177.9 | 675.2 | legacy |
| work_item | bm25 | 59/60 (98.3%) | 0.860 | 0 | 66.7 | 151.6 | bm25 |
| session_turn | legacy | 50/60 (83.3%) | 0.790 | 0 | 560.6 | 3226.7 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.783 | 0 | 126.7 | 324.1 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 59 | 0 | 0 | 1 | pass |
| session_turn | 50 | 0 | 0 | 10 | pass |

- work_item: BM25 recall@10 59/60 >= legacy 59/60
- session_turn: BM25 recall@10 50/60 >= legacy 50/60
