# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T07:43:33.400Z at commit e4bf686399041940a90e2585869dc493e5484f4c.
Both arms ran in one process on the identical sample (fingerprint `acef193fad73364013420e4e0a8b41ec9f2bf4511e3bdd10cae90521b6562108`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.812 | 0 | 237.4 | 863.2 | legacy |
| work_item | bm25 | 55/60 (91.7%) | 0.712 | 0 | 78.9 | 352.1 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.770 | 0 | 987.8 | 5921.2 | legacy |
| session_turn | bm25 | 52/60 (86.7%) | 0.685 | 0 | 215.2 | 945 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 0 | 0 | 5 | pass |
| session_turn | 49 | 3 | 0 | 8 | pass |

- work_item: BM25 recall@10 55/60 >= legacy 55/60; latency pass: BM25-arm p95 352.1 ms <= legacy p95 863.2 ms; warm-repeat BM25 p95 66.7 ms <= the 200 ms ceiling; cold paired BM25 p95 352.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 52/60 >= legacy 49/60; latency pass: BM25-arm p95 945 ms <= legacy p95 5921.2 ms; warm-repeat BM25 p95 184.7 ms <= the 400 ms ceiling; cold paired BM25 p95 945 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 37 | 66.7 | 4 | 200 | 352.1 | 1000 | 372.9 | pass |
| session_turn | 60 | 70.6 | 184.7 | 5 | 400 | 945 | 1200 | 507.6 | pass |

- work_item before warm-up: 2026-10-12T07:42:05.103Z: loadavg 107.42 126.36 139.79 79/97021 2689689; io some avg10=14.69 avg60=16.96 avg300=16.32 total=131635221235; cpu some avg10=1.26 avg60=1.04 avg300=0.93 total=17198604486; active backends 36
- work_item after steady pass: 2026-10-12T07:42:41.369Z: loadavg 147.67 133.14 141.49 37/97174 2735113; io some avg10=26.37 avg60=19.31 avg300=16.90 total=131643038599; cpu some avg10=1.54 avg60=1.57 avg300=1.09 total=17199635619; active backends 17
- session_turn before warm-up: 2026-10-12T07:42:41.373Z: loadavg 147.67 133.14 141.49 39/97177 2735117; io some avg10=26.37 avg60=19.31 avg300=16.90 total=131643040054; cpu some avg10=1.54 avg60=1.57 avg300=1.09 total=17199635651; active backends 17
- session_turn after steady pass: 2026-10-12T07:43:33.169Z: loadavg 146.26 137.79 142.76 53/97328 2797390; io some avg10=19.22 avg60=21.70 avg300=17.98 total=131655087689; cpu some avg10=1.95 avg60=1.94 avg300=1.27 total=17201107216; active backends 14

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 96 | 689.1 | 4686 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 41 | 1258.4 | 6645 | 6% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 161 | 93.5 | 3896 | 15% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 56 | 255.3 | 5009 | 6% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 96 | 124.4 | 973 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 60 | 142.2 | 4956 | 26% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 162 | 39.2 | 1945 | 14% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 10 | 458.1 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 8 | 1111.3 | 308 | 6% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 8 | 242.1 | 1 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 63 | 25.9 | 1311 | 48% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 63 | 19.5 | 964 | 56% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 12 | 85.6 | 236 | 32% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 1 | 526.1 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 12 | 24.4 | 15 | 3% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 3 | 62.1 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 25 | 193.1 | 282 | 3% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 13 | 318.1 | 179 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 62 | 48.3 | 4677 | 22% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 62 | 41.4 | 4344 | 50% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 12 | 108.8 | 21 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 24 | 12.6 | 27 | 4% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 1 | 127.8 | 0 | 0% | `SELECT state, count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kin` |
| steady session_turn | 1 | 124.3 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 791 |
| work_item | legacy | semantic:embeddings | 252 |
| work_item | bm25 | lexical:lexical | 68 |
| work_item | bm25 | semantic:embeddings | 286 |
| session_turn | legacy | lexical:lexical | 4904 |
| session_turn | legacy | semantic:embeddings | 1126 |
| session_turn | bm25 | lexical:lexical | 247 |
| session_turn | bm25 | semantic:embeddings | 756 |

Host at start: 2026-10-12T07:39:02.293Z: loadavg 120.97 151.05 149.64 34/95982 2449688; io some avg10=3.30 avg60=12.87 avg300=19.17 total=131613231136; cpu some avg10=0.59 avg60=0.97 avg300=0.87 total=17195807115; active backends 5

Host at end: 2026-10-12T07:41:42.453Z: loadavg 116.04 129.51 141.14 63/96855 2661976; io some avg10=21.93 avg60=16.93 avg300=16.22 total=131631118842; cpu some avg10=1.18 avg60=1.07 avg300=0.92 total=17198254703; active backends 5
