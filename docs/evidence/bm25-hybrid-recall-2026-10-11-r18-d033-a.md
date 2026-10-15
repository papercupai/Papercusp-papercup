# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T22:44:40.083Z at commit c9e7527a29c77ccb057cd41b62b3277dd070f8eb.
Both arms ran in one process on the identical sample (fingerprint `2194f64758bc30754d0a07e1bcfad7e2bd3faeb34d3e3e62e2e4013a1a88a70f`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.870 | 0 | 168.9 | 374.2 | legacy |
| work_item | bm25 | 56/60 (93.3%) | 0.838 | 0 | 68.3 | 173.1 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.795 | 1 | 937.6 | 3292.9 | legacy |
| session_turn | bm25 | 51/60 (85.0%) | 0.806 | 0 | 134.3 | 369.2 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 1 | 0 | 4 | pass |
| session_turn | 49 | 2 | 0 | 9 | pass |

- work_item: BM25 recall@10 56/60 >= legacy 55/60; latency pass: BM25-arm p95 173.1 ms <= legacy p95 374.2 ms; warm-repeat BM25 p95 55.3 ms <= the 200 ms ceiling; cold paired BM25 p95 173.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 51/60 >= legacy 49/60; latency pass: BM25-arm p95 369.2 ms <= legacy p95 3292.9 ms; warm-repeat BM25 p95 185.9 ms <= the 400 ms ceiling; cold paired BM25 p95 369.2 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 29.9 | 55.3 | 9 | 200 | 173.1 | 1000 | 76.9 | pass |
| session_turn | 60 | 61.8 | 185.9 | 8 | 400 | 369.2 | 1200 | 218.5 | pass |

- work_item before warm-up: 2026-10-11T22:44:01.869Z: loadavg 122.30 133.64 156.53 57/89055 2878214; io some avg10=20.45 avg60=15.62 avg300=14.22 total=124266741277; cpu some avg10=1.98 avg60=1.32 avg300=1.46 total=16624054397; active backends 55
- work_item after steady pass: 2026-10-11T22:44:15.201Z: loadavg 124.11 133.72 156.31 59/88749 2886757; io some avg10=35.24 avg60=20.36 avg300=15.34 total=124271909020; cpu some avg10=1.18 avg60=1.20 avg300=1.43 total=16624233592; active backends 17
- session_turn before warm-up: 2026-10-11T22:44:15.204Z: loadavg 124.11 133.72 156.31 74/88719 2886757; io some avg10=35.24 avg60=20.36 avg300=15.34 total=124271910996; cpu some avg10=1.18 avg60=1.20 avg300=1.43 total=16624233664; active backends 17
- session_turn after steady pass: 2026-10-11T22:44:40.021Z: loadavg 167.91 143.66 159.02 58/89395 2907605; io some avg10=27.19 avg60=26.19 avg300=17.30 total=124281882099; cpu some avg10=2.32 avg60=1.47 avg300=1.47 total=16624820444; active backends 20

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 45 | 1300.9 | 12427 | 16% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 61 | 567 | 7633 | 26% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 122 | 129.4 | 13738 | 89% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 83 | 159.3 | 5279 | 24% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 53 | 200.3 | 2027 | 15% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 63 | 128.4 | 1892 | 22% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 88 | 70.3 | 21869 | 63% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 122 | 45 | 3550 | 44% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 6 | 257.6 | 223 | 6% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 64 | 18.6 | 1198 | 41% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 60 | 14.7 | 957 | 62% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 2 | 382.8 | 206 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 6 | 34.6 | 48 | 8% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 4 | 31.5 | 0 | 0% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 4 | 26.7 | 14 | 7% | `WITH q AS ( SELECT plainto_tsquery($6, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 2 | 38.9 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 60 | 47.4 | 4379 | 23% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 60 | 42.5 | 3892 | 51% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 4 | 570.9 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 10 | 175.4 | 173 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 10 | 96.1 | 12 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 2 | 118.7 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 15 | 14.1 | 114 | 21% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 15 | 12.4 | 36 | 8% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 363 |
| work_item | legacy | semantic:embeddings | 11 |
| work_item | bm25 | lexical:lexical | 156 |
| work_item | bm25 | semantic:embeddings | 12 |
| session_turn | legacy | lexical:lexical | 3282 |
| session_turn | legacy | semantic:embeddings | 11 |
| session_turn | bm25 | lexical:lexical | 346 |
| session_turn | bm25 | semantic:embeddings | 11 |

Host at start: 2026-10-11T22:41:35.705Z: loadavg 160.83 149.56 165.06 73/88212 2732544; io some avg10=28.05 avg60=17.66 avg300=14.06 total=124245173266; cpu some avg10=0.95 avg60=1.84 avg300=1.68 total=16621699795; active backends 20

Host at end: 2026-10-11T22:43:38.032Z: loadavg 110.69 133.04 156.98 67/88021 2847859; io some avg10=15.34 avg60=15.37 avg300=14.12 total=124262829172; cpu some avg10=0.91 avg60=1.15 avg300=1.45 total=16623550869; active backends 25
