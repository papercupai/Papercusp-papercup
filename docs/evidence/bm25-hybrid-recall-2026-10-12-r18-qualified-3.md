# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T06:39:30.113Z at commit 6f334e08c55ef32cafd6e7977cfc2497e551b417.
Both arms ran in one process on the identical sample (fingerprint `1e94ad3012c3975e87067df2e0d1410cc49c1853462e7f03257dc776b8d0862d`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **fail**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 58/60 (96.7%) | 0.941 | 0 | 156.8 | 674 | legacy |
| work_item | bm25 | 57/60 (95.0%) | 0.897 | 0 | 42.1 | 72.1 | bm25 |
| session_turn | legacy | 45/60 (75.0%) | 0.711 | 3 | 695.5 | 4288.2 | legacy |
| session_turn | bm25 | 49/60 (81.7%) | 0.711 | 0 | 122.1 | 315.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 57 | 0 | 1 | 2 | fail |
| session_turn | 45 | 4 | 0 | 11 | pass |

- work_item: BM25 recall@10 57/60 is below legacy 58/60; latency pass: BM25-arm p95 72.1 ms <= legacy p95 674 ms; warm-repeat BM25 p95 39.4 ms <= the 200 ms ceiling; cold paired BM25 p95 72.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 49/60 >= legacy 45/60; latency pass: BM25-arm p95 315.6 ms <= legacy p95 4288.2 ms; warm-repeat BM25 p95 130.9 ms <= the 400 ms ceiling; cold paired BM25 p95 315.6 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 27.2 | 39.4 | 3 | 200 | 72.1 | 1000 | 70.9 | pass |
| session_turn | 60 | 52.4 | 130.9 | 13 | 400 | 315.6 | 1200 | 213 | pass |

- work_item before warm-up: 2026-10-12T06:39:00.588Z: loadavg 124.81 114.65 125.82 49/91574 3481059; io some avg10=24.66 avg60=24.32 avg300=17.89 total=130881732300; cpu some avg10=0.24 avg60=0.79 avg300=0.67 total=17149930586; active backends 13
- work_item after steady pass: 2026-10-12T06:39:11.011Z: loadavg 120.79 114.08 125.51 130/91868 3492273; io some avg10=22.10 avg60=24.00 avg300=18.08 total=130884191627; cpu some avg10=1.29 avg60=0.96 avg300=0.71 total=17150167905; active backends 16
- session_turn before warm-up: 2026-10-12T06:39:11.017Z: loadavg 120.79 114.08 125.51 113/91868 3492273; io some avg10=22.10 avg60=24.00 avg300=18.08 total=130884191743; cpu some avg10=1.29 avg60=0.96 avg300=0.71 total=17150168375; active backends 25
- session_turn after steady pass: 2026-10-12T06:39:29.892Z: loadavg 110.82 112.33 124.70 47/92039 3508044; io some avg10=8.13 avg60=19.17 avg300=17.32 total=130885291018; cpu some avg10=1.75 avg60=1.26 avg300=0.80 total=17150662142; active backends 12

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 41 | 1226.8 | 6626 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 77 | 455.6 | 2994 | 5% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 60 | 223 | 2311 | 12% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 57 | 228.5 | 1209 | 5% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 138 | 59.9 | 2454 | 24% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 110 | 51.5 | 4354 | 43% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| paired | 77 | 59.2 | 334 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 110 | 39.2 | 11415 | 42% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 7 | 236.4 | 1842 | 37% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 63 | 16 | 1051 | 36% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 4 | 171 | 152 | 5% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 63 | 10.4 | 955 | 55% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 5 | 22 | 4 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 2 | 48.3 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady work_item | 7 | 9.7 | 18 | 11% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 2 | 3.1 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 8 | 586.1 | 433 | 5% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 64 | 47.3 | 4792 | 51% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 64 | 40.2 | 4568 | 26% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 12 | 125.3 | 2286 | 63% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 3 | 443.3 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 9 | 98.1 | 39 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 11 | 24.5 | 38 | 20% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 2 | 97.2 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 663 |
| work_item | legacy | semantic:embeddings | 10 |
| work_item | bm25 | lexical:lexical | 58 |
| work_item | bm25 | semantic:embeddings | 13 |
| session_turn | legacy | lexical:lexical | 3157 |
| session_turn | legacy | semantic:embeddings | 14 |
| session_turn | bm25 | lexical:lexical | 307 |
| session_turn | bm25 | semantic:embeddings | 10 |

Host at start: 2026-10-12T06:36:39.834Z: loadavg 107.05 104.93 124.94 35/90939 3337262; io some avg10=14.21 avg60=16.84 avg300=13.73 total=130847098391; cpu some avg10=0.73 avg60=0.64 avg300=0.51 total=17147754385; active backends 9

Host at end: 2026-10-12T06:38:41.275Z: loadavg 139.20 116.57 126.67 38/91221 3461607; io some avg10=23.94 avg60=24.06 avg300=17.43 total=130876913059; cpu some avg10=0.50 avg60=0.97 avg300=0.69 total=17149736726; active backends 10
