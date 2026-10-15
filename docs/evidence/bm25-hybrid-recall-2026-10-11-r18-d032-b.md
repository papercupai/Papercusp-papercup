# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T20:11:29.510Z at commit bf2bee737780e9a817eee0e2a612286bce9b718b.
Both arms ran in one process on the identical sample (fingerprint `a3ec428ffc7026520850b32ddae8ea756b774a9e936c7d45472502fb6a9485d3`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.873 | 2 | 381.9 | 2286.3 | legacy |
| work_item | bm25 | 56/60 (93.3%) | 0.879 | 0 | 138.2 | 379.8 | bm25 |
| session_turn | legacy | 48/60 (80.0%) | 0.768 | 8 | 1204 | 8112.6 | legacy |
| session_turn | bm25 | 54/60 (90.0%) | 0.858 | 0 | 259 | 813.1 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 54 | 2 | 1 | 3 | pass |
| session_turn | 48 | 6 | 0 | 6 | pass |

- work_item: BM25 recall@10 56/60 >= legacy 55/60; latency fail: BM25-arm p95 379.8 ms <= legacy p95 2286.3 ms, but the warm-repeat BM25 p95 233.9 ms exceeds the 200 ms ceiling; cold paired BM25 p95 379.8 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 54/60 >= legacy 48/60; latency pass: BM25-arm p95 813.1 ms <= legacy p95 8112.6 ms; warm-repeat BM25 p95 249.6 ms <= the 400 ms ceiling; cold paired BM25 p95 813.1 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 98.2 | 233.9 | 60 | 200 | 379.8 | 1000 | 144.1 | fail |
| session_turn | 60 | 110 | 249.6 | 60 | 400 | 813.1 | 1200 | 1554.6 | pass |

- work_item before warm-up: 2026-10-11T20:10:15.931Z: loadavg 358.52 374.20 370.16 176/86504 3114496; io some avg10=20.59 avg60=14.98 avg300=17.21 total=122830412479; cpu some avg10=30.57 avg60=31.70 avg300=30.68 total=15137350121; active backends 20
- work_item after steady pass: 2026-10-11T20:10:36.972Z: loadavg 414.93 386.10 374.16 178/86286 3134526; io some avg10=20.29 avg60=17.03 avg300=17.55 total=122835212519; cpu some avg10=29.19 avg60=30.99 avg300=30.59 total=15143636500; active backends 16
- session_turn before warm-up: 2026-10-11T20:10:36.975Z: loadavg 414.93 386.10 374.16 126/86288 3134529; io some avg10=20.29 avg60=17.03 avg300=17.55 total=122835213061; cpu some avg10=29.19 avg60=30.99 avg300=30.59 total=15143637293; active backends 16
- session_turn after steady pass: 2026-10-11T20:11:29.241Z: loadavg 424.58 390.67 376.20 258/87136 3178195; io some avg10=20.92 avg60=18.77 avg300=17.90 total=122845577253; cpu some avg10=29.53 avg60=30.40 avg300=30.52 total=15159744355; active backends 49

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 42 | 1496.5 | 13477 | 23% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 173 | 290.3 | 85372 | 127% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 83 | 423.1 | 5553 | 20% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 119 | 115.6 | 3938 | 28% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 78 | 146.3 | 22276 | 59% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 78 | 72.4 | 5121 | 66% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 79 | 57.1 | 2665 | 73% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 9 | 26.1 | 352 | 69% | `SELECT (-((coalesce(title, $4) \|\| $5 \|\| coalesce(summary, $6) \|\| $7 \|\| coalesce(notes, $8)) <@> to_b` |
| steady work_item | 60 | 27.3 | 1210 | 61% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 63 | 188.1 | 4012 | 39% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 16 | 377.3 | 10333 | 206% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 63 | 90.8 | 4322 | 43% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 59 | 63 | 1591 | 46% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 7 | 210 | 220 | 14% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 3 | 7.6 | 1 | 2% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 12.8 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.work_items WHERE taken_by = $1 AND workspace_id = $2 A` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2262 |
| work_item | legacy | semantic:embeddings | 93 |
| work_item | bm25 | lexical:lexical | 355 |
| work_item | bm25 | semantic:embeddings | 45 |
| session_turn | legacy | lexical:lexical | 4114 |
| session_turn | legacy | semantic:embeddings | 34 |
| session_turn | bm25 | lexical:lexical | 766 |
| session_turn | bm25 | semantic:embeddings | 42 |

Host at start: 2026-10-11T20:05:08.657Z: loadavg 488.47 427.20 377.72 238/86519 2844487; io some avg10=31.94 avg60=24.88 avg300=21.06 total=122779156428; cpu some avg10=27.78 avg60=28.63 avg300=29.42 total=15040782276; active backends 59

Host at end: 2026-10-11T20:09:23.668Z: loadavg 297.07 371.16 369.10 187/85939 3057746; io some avg10=13.21 avg60=11.19 avg300=17.18 total=122821090315; cpu some avg10=31.38 avg60=31.74 avg300=30.45 total=15120428297; active backends 28
