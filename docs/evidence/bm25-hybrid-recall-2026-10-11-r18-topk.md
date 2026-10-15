# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T14:24:49.492Z at commit 03595bfda4ea0e905ff44f2e196eb539ac24f047.
Both arms ran in one process on the identical sample (fingerprint `599dfa2cd308d42559e7c02382f2831180f22e70bb68d75b50c362f5ba7a55f7`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021) is the p95 of the whole hybrid call with every query embedded before timing; the BM25 arm must not exceed legacy nor its source ceiling (work_item 200 ms, session_turn 400 ms). Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 56/60 (93.3%) | 0.933 | 0 | 196.4 | 888.7 | legacy |
| work_item | bm25 | 57/60 (95.0%) | 0.908 | 0 | 80.2 | 205.8 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.774 | 1 | 641.3 | 3835.4 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.786 | 0 | 137.5 | 323.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 56 | 1 | 0 | 3 | pass |
| session_turn | 49 | 1 | 0 | 10 | pass |

- work_item: BM25 recall@10 57/60 >= legacy 56/60; latency fail: BM25-arm p95 205.8 ms exceeds the 200 ms ceiling
- session_turn: BM25 recall@10 50/60 >= legacy 49/60; latency pass: BM25-arm p95 323.6 ms <= legacy p95 3835.4 ms and the 400 ms ceiling
