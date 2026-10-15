# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T15:22:23.169Z at commit 5128b26627ea1b4bb1ac1ba605f971525563834e.
Both arms ran in one process on the identical sample (fingerprint `460999f54757eded21c33a4903a734a7d8feeb709aeae182c4532682eb47732f`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021) is the p95 of the whole hybrid call with every query embedded before timing; the BM25 arm must not exceed legacy nor its source ceiling (work_item 200 ms, session_turn 400 ms). Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 56/60 (93.3%) | 0.933 | 0 | 171.8 | 1229.5 | legacy |
| work_item | bm25 | 57/60 (95.0%) | 0.917 | 0 | 53.1 | 93 | bm25 |
| session_turn | legacy | 47/60 (78.3%) | 0.743 | 3 | 753.2 | 5569.1 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.785 | 0 | 153.1 | 476.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 56 | 1 | 0 | 3 | pass |
| session_turn | 47 | 3 | 0 | 10 | pass |

- work_item: BM25 recall@10 57/60 >= legacy 56/60; latency pass: BM25-arm p95 93 ms <= legacy p95 1229.5 ms and the 200 ms ceiling
- session_turn: BM25 recall@10 50/60 >= legacy 47/60; latency fail: BM25-arm p95 476.6 ms exceeds the 400 ms ceiling

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1212 |
| work_item | legacy | semantic:embeddings | 7 |
| work_item | bm25 | lexical:lexical | 83 |
| work_item | bm25 | semantic:embeddings | 7 |
| session_turn | legacy | lexical:lexical | 2936 |
| session_turn | legacy | semantic:embeddings | 10 |
| session_turn | bm25 | lexical:lexical | 452 |
| session_turn | bm25 | semantic:embeddings | 12 |

Host at start: 2026-10-11T15:20:19.061Z: loadavg 86.39 126.15 145.21 49/76277 1197920; io some avg10=4.88 avg60=5.87 avg300=12.85 total=119526485201; cpu some avg10=0.89 avg60=0.73 avg300=1.74 total=12854195987; active backends 9

Host at end: 2026-10-11T15:22:22.661Z: loadavg 108.46 123.35 141.87 43/74793 1308636; io some avg10=15.46 avg60=14.01 avg300=13.48 total=119545069955; cpu some avg10=0.54 avg60=0.78 avg300=1.41 total=12855930782; active backends 6
