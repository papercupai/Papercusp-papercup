# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T16:53:37.172Z at commit 51205448b0efefb064fa0b0a24d51316e53b4b29.
Both arms ran in one process on the identical sample (fingerprint `f67a389acc6a5ef36896f2efa1f8e0b69d31a8fe9452df05a7a75f7185e06731`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy; the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The cold paired p95 and the steady pass (D-024, D-025: novel queries on a disjoint sample) are reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 56/60 (93.3%) | 0.917 | 3 | 177.6 | 2296.3 | legacy |
| work_item | bm25 | 59/60 (98.3%) | 0.953 | 0 | 79.4 | 634 | bm25 |
| session_turn | legacy | 46/60 (76.7%) | 0.723 | 4 | 1211 | 8124.2 | legacy |
| session_turn | bm25 | 49/60 (81.7%) | 0.789 | 0 | 189.1 | 689.1 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 56 | 3 | 0 | 1 | pass |
| session_turn | 45 | 4 | 1 | 10 | pass |

- work_item: BM25 recall@10 59/60 >= legacy 56/60; latency pass: BM25-arm p95 634 ms <= legacy p95 2296.3 ms; warm-repeat BM25 p95 69.1 ms <= the 200 ms ceiling; cold paired p95 634 ms reported, not judged (D-028)
- session_turn: BM25 recall@10 49/60 >= legacy 46/60; latency pass: BM25-arm p95 689.1 ms <= legacy p95 8124.2 ms; warm-repeat BM25 p95 216.1 ms <= the 400 ms ceiling; cold paired p95 689.1 ms reported, not judged (D-028)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 40.5 | 69.1 | 60 | 200 | 634 | 131 | pass |
| session_turn | 60 | 91.9 | 216.1 | 60 | 400 | 689.1 | 294.3 | pass |

- work_item before warm-up: 2026-10-11T16:52:58.370Z: loadavg 201.66 213.90 202.81 93/85420 2981773; io some avg10=5.94 avg60=15.23 avg300=22.94 total=120762973739; cpu some avg10=11.59 avg60=6.47 avg300=4.43 total=13075636062; active backends 12
- work_item after steady pass: 2026-10-11T16:53:12.807Z: loadavg 194.78 211.82 202.31 92/84854 2993848; io some avg10=8.29 avg60=13.81 avg300=22.25 total=120764252104; cpu some avg10=11.17 avg60=7.56 avg300=4.78 total=13077336761; active backends 26
- session_turn before warm-up: 2026-10-11T16:53:12.812Z: loadavg 194.78 211.82 202.31 117/84852 2993849; io some avg10=8.29 avg60=13.81 avg300=22.25 total=120764252564; cpu some avg10=11.17 avg60=7.56 avg300=4.78 total=13077337050; active backends 28
- session_turn after steady pass: 2026-10-11T16:53:36.611Z: loadavg 165.14 203.93 199.92 99/84430 3014667; io some avg10=7.92 avg60=11.71 avg300=21.07 total=120766019421; cpu some avg10=7.05 avg60=7.67 avg300=5.04 total=13079394367; active backends 22

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 42 | 1290.4 | 8004 | 14% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 91 | 383.7 | 3102 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 194 | 139.1 | 8966 | 36% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 139 | 172.8 | 6516 | 21% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 95 | 136.6 | 4697 | 71% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 95 | 90.6 | 22241 | 56% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 95 | 54.6 | 3056 | 60% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 1 | 145.9 | 22 | 11% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 60 | 24.6 | 1478 | 46% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 11 | 125.1 | 142 | 8% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 4 | 252 | 0 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 62 | 64.2 | 3761 | 72% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 62 | 49.4 | 4547 | 23% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 6 | 311.1 | 1 | 20% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 19 | 54.8 | 47 | 3% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 56 | 12.8 | 1 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 2 | 43.3 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady session_turn | 2 | 9.1 | 6 | 3% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2270 |
| work_item | legacy | semantic:embeddings | 18 |
| work_item | bm25 | lexical:lexical | 625 |
| work_item | bm25 | semantic:embeddings | 17 |
| session_turn | legacy | lexical:lexical | 3356 |
| session_turn | legacy | semantic:embeddings | 19 |
| session_turn | bm25 | lexical:lexical | 664 |
| session_turn | bm25 | semantic:embeddings | 13 |

Host at start: 2026-10-11T16:49:17.869Z: loadavg 273.50 211.51 198.38 119/80403 2758031; io some avg10=35.23 avg60=36.20 avg300=24.01 total=120708346965; cpu some avg10=4.26 avg60=2.96 avg300=4.05 total=13064862433; active backends 30

Host at end: 2026-10-11T16:52:29.202Z: loadavg 226.84 219.84 204.32 92/84244 2944893; io some avg10=7.87 avg60=21.05 avg300=24.74 total=120760922717; cpu some avg10=6.81 avg60=4.47 avg300=3.93 total=13072835079; active backends 23
