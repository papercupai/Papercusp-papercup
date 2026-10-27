# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-23T04:27:35.897Z at commit 48f2b0515d366f6f4069e30a30082a687621a5b7.
Both arms ran in one process on the identical sample (fingerprint `58c93b4dee70eda1dbcfd0f5eeb5d043cd8f1c3e273acdfba9ae33f7e4a020a4`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **invalid**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **invalid**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 54/60 (90.0%) | 0.792 | 0 | 550.3 | 2646.7 | legacy |
| work_item | bm25 | 55/60 (91.7%) | 0.708 | 0 | 182.5 | 1150.8 | bm25 |
| session_turn | legacy | 46/60 (76.7%) | 0.720 | 0 | 2212 | 8412.3 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.661 | 0 | 637.4 | 3027.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 53 | 2 | 1 | 4 | pass |
| session_turn | 45 | 5 | 1 | 9 | pass |

- work_item: BM25 recall@10 55/60 >= legacy 54/60; latency fail: BM25-arm p95 1150.8 ms <= legacy p95 2646.7 ms, but the cold paired BM25 p95 1150.8 ms exceeds the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 50/60 >= legacy 46/60; latency fail: BM25-arm p95 3027.6 ms <= legacy p95 8412.3 ms, but the cold paired BM25 p95 3027.6 ms exceeds the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 38.7 | 80.7 | 4 | 200 | 1150.8 | 1000 | 743 | fail |
| session_turn | 60 | 105.1 | 297.7 | 12 | 400 | 3027.6 | 1200 | 2395.7 | fail |

- work_item before warm-up: 2026-10-23T04:22:47.998Z: loadavg 541.21 522.02 541.08 104/156914 2826950; io some avg10=16.08 avg60=26.17 avg300=27.20 total=367141030015; cpu some avg10=18.90 avg60=12.20 avg300=11.56 total=56441355181; active backends 73
- work_item after steady pass: 2026-10-23T04:23:57.860Z: loadavg 582.80 550.00 550.00 81/157386 2905836; io some avg10=12.21 avg60=27.45 avg300=28.21 total=367164289804; cpu some avg10=11.02 avg60=10.31 avg300=11.02 total=56447897845; active backends 85
- session_turn before warm-up: 2026-10-23T04:23:57.881Z: loadavg 582.80 550.00 550.00 90/157384 2905852; io some avg10=12.21 avg60=27.45 avg300=28.21 total=367164293204; cpu some avg10=11.02 avg60=10.31 avg300=11.02 total=56447899284; active backends 68
- session_turn after steady pass: 2026-10-23T04:27:35.164Z: loadavg 770.78 660.42 592.32 51/156849 3217870; io some avg10=45.77 avg60=36.94 avg300=32.22 total=367243283372; cpu some avg10=3.94 avg60=9.36 avg300=11.02 total=56473735433; active backends 55

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 38 | 2328.7 | 12686 | 16% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 162 | 486.3 | 19199 | 20% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 230 | 204.5 | 80283 | 134% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 57 | 637.7 | 1712 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 163 | 217.7 | 3380 | 13% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 60 | 401.9 | 8729 | 32% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 144 | 97.8 | 26602 | 64% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 232 | 48.5 | 3508 | 47% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 13 | 1307.6 | 1999 | 15% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 6 | 933.5 | 672 | 10% | `SELECT feature_id AS id, title, summary AS body, (-((coalesce(title, $1) \|\| $2 \|\| coalesce(summary, ` |
| steady work_item | 14 | 286.4 | 178 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 19 | 136.6 | 6624 | 182% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 62 | 28.8 | 1270 | 47% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 62 | 19.9 | 1181 | 60% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 19 | 57.3 | 1478 | 97% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 1 | 201.8 | 143 | 31% | `SELECT id, title, body, (-bm25_d)::float8 AS score, bm25_d FROM ( SELECT * FROM ( SELECT feature_id ` |
| steady session_turn | 27 | 482.1 | 37686 | 269% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 76 | 141.5 | 8082 | 79% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 20 | 382.3 | 3005 | 40% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 76 | 81 | 6428 | 56% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 19 | 318.8 | 1264 | 27% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 28 | 183.8 | 4545 | 73% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 18 | 63.1 | 673 | 89% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady session_turn | 2 | 374.2 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2425 |
| work_item | legacy | semantic:embeddings | 1496 |
| work_item | bm25 | lexical:lexical | 262 |
| work_item | bm25 | semantic:embeddings | 1142 |
| session_turn | legacy | lexical:lexical | 6186 |
| session_turn | legacy | semantic:embeddings | 2985 |
| session_turn | bm25 | lexical:lexical | 704 |
| session_turn | bm25 | semantic:embeddings | 2988 |

Host at start: 2026-10-23T04:14:37.329Z: loadavg 519.56 632.02 582.41 90/155590 2212508; io some avg10=32.47 avg60=29.98 avg300=31.53 total=367010921267; cpu some avg10=12.10 avg60=14.27 avg300=12.85 total=56380270518; active backends 42

Host at end: 2026-10-23T04:20:34.363Z: loadavg 597.96 528.53 547.44 57/155830 2651945; io some avg10=22.38 avg60=31.29 avg300=28.10 total=367106336666; cpu some avg10=9.59 avg60=9.18 avg300=12.18 total=56427157133; active backends 66
