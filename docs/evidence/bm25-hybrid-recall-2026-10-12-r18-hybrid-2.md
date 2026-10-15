# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T07:49:35.046Z at commit e4bf686399041940a90e2585869dc493e5484f4c.
Both arms ran in one process on the identical sample (fingerprint `5d4a468e004ac10de65a531aa459856dd5715215b2f28fa0b518ed1603bde681`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.851 | 0 | 309.8 | 999.9 | legacy |
| work_item | bm25 | 55/60 (91.7%) | 0.699 | 0 | 92.7 | 732.1 | bm25 |
| session_turn | legacy | 46/60 (76.7%) | 0.710 | 0 | 1053.5 | 6860.4 | legacy |
| session_turn | bm25 | 47/60 (78.3%) | 0.619 | 0 | 189.1 | 740.9 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 0 | 0 | 5 | pass |
| session_turn | 45 | 2 | 1 | 12 | pass |

- work_item: BM25 recall@10 55/60 >= legacy 55/60; latency pass: BM25-arm p95 732.1 ms <= legacy p95 999.9 ms; warm-repeat BM25 p95 75.5 ms <= the 200 ms ceiling; cold paired BM25 p95 732.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 47/60 >= legacy 46/60; latency pass: BM25-arm p95 740.9 ms <= legacy p95 6860.4 ms; warm-repeat BM25 p95 220 ms <= the 400 ms ceiling; cold paired BM25 p95 740.9 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 46.3 | 75.5 | 2 | 200 | 732.1 | 1000 | 254.3 | pass |
| session_turn | 60 | 73.1 | 220 | 8 | 400 | 740.9 | 1200 | 793.3 | pass |

- work_item before warm-up: 2026-10-12T07:48:11.916Z: loadavg 106.63 141.04 144.87 105/98037 3053353; io some avg10=9.78 avg60=8.43 avg300=14.08 total=131693659601; cpu some avg10=3.98 avg60=2.84 avg300=2.29 total=17210553081; active backends 46
- work_item after steady pass: 2026-10-12T07:48:39.667Z: loadavg 125.92 142.21 145.13 153/97958 3074998; io some avg10=5.78 avg60=7.16 avg300=13.24 total=131695194111; cpu some avg10=8.15 avg60=4.23 avg300=2.66 total=17212464822; active backends 14
- session_turn before warm-up: 2026-10-12T07:48:39.672Z: loadavg 125.92 142.21 145.13 148/97959 3075000; io some avg10=5.78 avg60=7.16 avg300=13.24 total=131695194145; cpu some avg10=8.15 avg60=4.23 avg300=2.66 total=17212465331; active backends 13
- session_turn after steady pass: 2026-10-12T07:49:34.740Z: loadavg 122.98 139.27 143.99 86/98632 3119276; io some avg10=8.58 avg60=7.32 avg300=12.18 total=131699192146; cpu some avg10=4.19 avg60=4.84 avg300=3.15 total=17215793744; active backends 8

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 40 | 1574 | 4525 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 96 | 505.8 | 4374 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 60 | 318.7 | 3187 | 7% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 172 | 104.4 | 3417 | 15% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 97 | 174.4 | 189 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 55 | 210.9 | 392 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 172 | 46.1 | 471 | 5% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 102 | 45.3 | 2157 | 23% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady work_item | 5 | 581.5 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 8 | 254.6 | 78 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 9 | 155 | 1 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 61 | 18.8 | 1088 | 33% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 61 | 14.2 | 775 | 39% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 5 | 160 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 15 | 37.4 | 85 | 30% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 15 | 37.3 | 33 | 2% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 19 | 374.9 | 390 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 20 | 260.5 | 116 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 60 | 57.8 | 4270 | 67% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 60 | 57 | 5214 | 34% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 34 | 96.7 | 689 | 16% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 34 | 32.5 | 75 | 4% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 1 | 588.7 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 4 | 132.7 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 748 |
| work_item | legacy | semantic:embeddings | 462 |
| work_item | bm25 | lexical:lexical | 77 |
| work_item | bm25 | semantic:embeddings | 688 |
| session_turn | legacy | lexical:lexical | 5584 |
| session_turn | legacy | semantic:embeddings | 584 |
| session_turn | bm25 | lexical:lexical | 200 |
| session_turn | bm25 | semantic:embeddings | 578 |

Host at start: 2026-10-12T07:44:35.245Z: loadavg 144.32 138.93 142.84 42/97105 2855461; io some avg10=5.77 avg60=15.99 avg300=17.17 total=131664349704; cpu some avg10=0.88 avg60=1.40 avg300=1.25 total=17202167449; active backends 12

Host at end: 2026-10-12T07:47:44.784Z: loadavg 112.69 145.02 146.22 91/97917 3033976; io some avg10=6.43 avg60=8.26 avg300=14.64 total=131691204011; cpu some avg10=1.29 avg60=2.62 avg300=2.21 total=17209572567; active backends 15
