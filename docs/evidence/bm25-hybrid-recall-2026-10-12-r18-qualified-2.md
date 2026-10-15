# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T06:33:41.093Z at commit 6f334e08c55ef32cafd6e7977cfc2497e551b417.
Both arms ran in one process on the identical sample (fingerprint `3fb95f9ae4e2f60db7c60ad5101696485763058926e297264b13815740a2986c`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 56/60 (93.3%) | 0.925 | 2 | 140.6 | 945.9 | legacy |
| work_item | bm25 | 58/60 (96.7%) | 0.889 | 0 | 34.1 | 56.7 | bm25 |
| session_turn | legacy | 46/60 (76.7%) | 0.750 | 1 | 644.2 | 3133.5 | legacy |
| session_turn | bm25 | 47/60 (78.3%) | 0.696 | 0 | 69.7 | 141.7 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 56 | 2 | 0 | 2 | pass |
| session_turn | 46 | 1 | 0 | 13 | pass |

- work_item: BM25 recall@10 58/60 >= legacy 56/60; latency pass: BM25-arm p95 56.7 ms <= legacy p95 945.9 ms; warm-repeat BM25 p95 52.7 ms <= the 200 ms ceiling; cold paired BM25 p95 56.7 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 47/60 >= legacy 46/60; latency pass: BM25-arm p95 141.7 ms <= legacy p95 3133.5 ms; warm-repeat BM25 p95 149.4 ms <= the 400 ms ceiling; cold paired BM25 p95 141.7 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 29.4 | 52.7 | 8 | 200 | 56.7 | 1000 | 59.4 | pass |
| session_turn | 60 | 56.6 | 149.4 | 12 | 400 | 141.7 | 1200 | 148 | pass |

- work_item before warm-up: 2026-10-12T06:33:16.027Z: loadavg 68.50 110.10 131.83 44/90354 3126634; io some avg10=2.92 avg60=5.42 avg300=12.04 total=130817132835; cpu some avg10=0.33 avg60=0.34 avg300=0.47 total=17145346181; active backends 8
- work_item after steady pass: 2026-10-12T06:33:24.662Z: loadavg 68.89 108.81 131.17 81/90431 3135972; io some avg10=2.74 avg60=5.06 avg300=11.78 total=130817376311; cpu some avg10=0.15 avg60=0.30 avg300=0.46 total=17145411955; active backends 12
- session_turn before warm-up: 2026-10-12T06:33:24.666Z: loadavg 68.89 108.81 131.17 63/90430 3135973; io some avg10=2.74 avg60=5.06 avg300=11.78 total=130817376334; cpu some avg10=0.15 avg60=0.30 avg300=0.46 total=17145411981; active backends 12
- session_turn after steady pass: 2026-10-12T06:33:40.891Z: loadavg 65.97 106.25 129.98 33/90687 3151307; io some avg10=2.79 avg60=4.47 avg300=11.24 total=130817940497; cpu some avg10=2.38 avg60=0.72 avg300=0.54 total=17145804086; active backends 10

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 44 | 1107.4 | 10095 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 64 | 625.7 | 7138 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 60 | 250.6 | 4575 | 9% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 59 | 216.8 | 3598 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 125 | 80 | 2417 | 10% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 65 | 119.5 | 3045 | 15% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 126 | 20.4 | 743 | 10% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 78 | 30.9 | 5319 | 26% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 5 | 571.4 | 231 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 6 | 176.3 | 33 | 1% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 62 | 13.7 | 1398 | 26% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 5 | 97.6 | 30 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 62 | 7.5 | 1125 | 40% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 6 | 10.1 | 10 | 4% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 1 | 51.2 | 150 | 51% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady work_item | 1 | 13.1 | 73 | 56% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 63 | 38.9 | 4031 | 19% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 63 | 26.9 | 3237 | 38% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 5 | 295.2 | 53 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 8 | 36.4 | 251 | 22% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 5 | 38.9 | 9 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 8 | 17.5 | 74 | 18% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 3 | 4.6 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 3 | 2 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 932 |
| work_item | legacy | semantic:embeddings | 13 |
| work_item | bm25 | lexical:lexical | 48 |
| work_item | bm25 | semantic:embeddings | 8 |
| session_turn | legacy | lexical:lexical | 3126 |
| session_turn | legacy | semantic:embeddings | 8 |
| session_turn | bm25 | lexical:lexical | 130 |
| session_turn | bm25 | semantic:embeddings | 7 |

Host at start: 2026-10-12T06:31:09.509Z: loadavg 101.36 133.96 141.57 22/90909 3023209; io some avg10=20.39 avg60=12.01 avg300=15.78 total=130810024355; cpu some avg10=0.19 avg60=0.47 avg300=0.54 total=17144122464; active backends 5

Host at end: 2026-10-12T06:32:56.163Z: loadavg 70.35 113.31 133.31 56/90505 3104288; io some avg10=3.99 avg60=6.36 avg300=12.68 total=130816392395; cpu some avg10=0.15 avg60=0.29 avg300=0.47 total=17145162448; active backends 29
