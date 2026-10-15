# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T22:49:06.964Z at commit c9e7527a29c77ccb057cd41b62b3277dd070f8eb.
Both arms ran in one process on the identical sample (fingerprint `4aa34f5430c4f2016708476399c84c86a931ff1a54ff37cd17fcbbece7f8d35b`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.908 | 2 | 253.7 | 1923.6 | legacy |
| work_item | bm25 | 56/60 (93.3%) | 0.867 | 0 | 47 | 111.1 | bm25 |
| session_turn | legacy | 48/60 (80.0%) | 0.738 | 2 | 799.6 | 3014.5 | legacy |
| session_turn | bm25 | 49/60 (81.7%) | 0.734 | 0 | 104 | 299.4 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 1 | 0 | 4 | pass |
| session_turn | 47 | 2 | 1 | 10 | pass |

- work_item: BM25 recall@10 56/60 >= legacy 55/60; latency pass: BM25-arm p95 111.1 ms <= legacy p95 1923.6 ms; warm-repeat BM25 p95 86.5 ms <= the 200 ms ceiling; cold paired BM25 p95 111.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 49/60 >= legacy 48/60; latency pass: BM25-arm p95 299.4 ms <= legacy p95 3014.5 ms; warm-repeat BM25 p95 143.6 ms <= the 400 ms ceiling; cold paired BM25 p95 299.4 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 39.5 | 86.5 | 5 | 200 | 111.1 | 1000 | 124.2 | pass |
| session_turn | 60 | 61.1 | 143.6 | 3 | 400 | 299.4 | 1200 | 296 | pass |

- work_item before warm-up: 2026-10-11T22:48:34.632Z: loadavg 153.87 149.58 157.51 39/89559 3129263; io some avg10=17.20 avg60=19.47 avg300=18.26 total=124326829126; cpu some avg10=1.68 avg60=1.55 avg300=1.45 total=16629330664; active backends 23
- work_item after steady pass: 2026-10-11T22:48:47.913Z: loadavg 158.73 151.00 157.86 90/89657 3138697; io some avg10=20.76 avg60=20.69 avg300=18.61 total=124330139916; cpu some avg10=6.60 avg60=2.63 avg300=1.69 total=16630284697; active backends 30
- session_turn before warm-up: 2026-10-11T22:48:47.918Z: loadavg 158.73 151.00 157.86 85/89649 3138701; io some avg10=20.76 avg60=20.69 avg300=18.61 total=124330140240; cpu some avg10=6.60 avg60=2.63 avg300=1.69 total=16630284768; active backends 22
- session_turn after steady pass: 2026-10-11T22:49:06.901Z: loadavg 148.20 149.02 157.06 73/89219 3160220; io some avg10=15.17 avg60=18.45 avg300=18.20 total=124332369302; cpu some avg10=1.54 avg60=2.07 avg300=1.61 total=16630477561; active backends 21

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 42 | 1065.2 | 3760 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 56 | 505 | 2939 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 79 | 292.4 | 2900 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 156 | 101.1 | 7558 | 37% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 73 | 185.2 | 2209 | 10% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 80 | 119.1 | 169 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 156 | 57.5 | 549 | 45% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 77 | 50.7 | 3326 | 48% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 5 | 370.8 | 5 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 60 | 28.1 | 937 | 48% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 60 | 22.7 | 852 | 53% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 6 | 196 | 19 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 10 | 57.8 | 24 | 6% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 10 | 31.2 | 10 | 2% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 1 | 174 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 9 | 430.4 | 293 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 60 | 61.3 | 4408 | 73% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 64 | 50.2 | 3392 | 28% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 9 | 104 | 5 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 1 | 418.4 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 2 | 105.4 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 2 | 93 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 11 | 16 | 38 | 15% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1901 |
| work_item | legacy | semantic:embeddings | 14 |
| work_item | bm25 | lexical:lexical | 100 |
| work_item | bm25 | semantic:embeddings | 9 |
| session_turn | legacy | lexical:lexical | 2765 |
| session_turn | legacy | semantic:embeddings | 17 |
| session_turn | bm25 | lexical:lexical | 282 |
| session_turn | bm25 | semantic:embeddings | 12 |

Host at start: 2026-10-11T22:45:51.832Z: loadavg 131.81 137.76 155.74 86/88703 2994679; io some avg10=5.95 avg60=16.78 avg300=16.47 total=124292036551; cpu some avg10=1.56 avg60=1.91 avg300=1.60 total=16626634555; active backends 70

Host at end: 2026-10-11T22:48:13.103Z: loadavg 167.76 151.74 158.37 205/89616 3112809; io some avg10=16.27 avg60=21.46 avg300=18.54 total=124323364965; cpu some avg10=1.34 avg60=1.08 avg300=1.35 total=16628622115; active backends 37
