# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T17:21:29.653Z at commit 484a585cc8a6fe30ddefbe570b1dd6594093bfce.
Both arms ran in one process on the identical sample (fingerprint `3266fd03530c6974730a42f14ff46a946a034c8b360c66fac629b40cc448beac`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 57/60 (95.0%) | 0.894 | 1 | 218.7 | 2104.4 | legacy |
| work_item | bm25 | 58/60 (96.7%) | 0.901 | 0 | 76.3 | 1130.7 | bm25 |
| session_turn | legacy | 42/60 (70.0%) | 0.669 | 4 | 981.6 | 8051.2 | legacy |
| session_turn | bm25 | 46/60 (76.7%) | 0.710 | 0 | 166 | 625.3 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 57 | 1 | 0 | 2 | pass |
| session_turn | 42 | 4 | 0 | 14 | pass |

- work_item: BM25 recall@10 58/60 >= legacy 57/60; latency fail: BM25-arm p95 1130.7 ms <= legacy p95 2104.4 ms, but the cold paired BM25 p95 1130.7 ms exceeds the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 46/60 >= legacy 42/60; latency pass: BM25-arm p95 625.3 ms <= legacy p95 8051.2 ms; warm-repeat BM25 p95 393.1 ms <= the 400 ms ceiling; cold paired BM25 p95 625.3 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 36 | 53.2 | 60 | 200 | 1130.7 | 1000 | 86.1 | fail |
| session_turn | 60 | 102.7 | 393.1 | 60 | 400 | 625.3 | 1200 | 465.3 | pass |

- work_item before warm-up: 2026-10-11T17:20:40.208Z: loadavg 219.46 220.78 209.16 298/84861 595635; io some avg10=15.35 avg60=20.15 avg300=19.23 total=121081151794; cpu some avg10=7.44 avg60=5.60 avg300=7.06 total=13189986855; active backends 28
- work_item after steady pass: 2026-10-11T17:20:54.875Z: loadavg 204.76 217.59 208.31 79/85136 613342; io some avg10=9.91 avg60=17.66 avg300=18.71 total=121082754372; cpu some avg10=11.55 avg60=7.67 avg300=7.47 total=13192155992; active backends 49
- session_turn before warm-up: 2026-10-11T17:20:54.881Z: loadavg 204.76 217.59 208.31 82/85145 613358; io some avg10=9.91 avg60=17.66 avg300=18.71 total=121082754987; cpu some avg10=11.55 avg60=7.67 avg300=7.47 total=13192156275; active backends 49
- session_turn after steady pass: 2026-10-11T17:21:29.401Z: loadavg 183.18 210.69 206.34 100/84670 637494; io some avg10=14.28 avg60=17.96 avg300=18.72 total=121089570845; cpu some avg10=6.30 avg60=6.86 avg300=7.28 total=13194265373; active backends 54

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 34 | 1776.7 | 7552 | 12% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 102 | 536.3 | 4317 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 141 | 167.7 | 5493 | 18% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 188 | 82.4 | 4166 | 25% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 101 | 123.7 | 2185 | 29% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 101 | 77 | 20079 | 57% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 101 | 48.1 | 3332 | 54% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 1 | 9.5 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.work_items WHERE taken_by = $1 AND workspace_id = $2 A` |
| steady work_item | 7 | 618.3 | 377 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 10 | 111.1 | 350 | 11% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 61 | 16.4 | 1184 | 25% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 1 | 49 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 1 | 11.3 | 0 | 0% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 1 | 4.6 | 0 | 0% | `SELECT * FROM ( SELECT $6 AS one, (coalesce(w.title, $7) \|\| $8 \|\| coalesce(w.summary, $9) \|\| $10 \|\| ` |
| steady work_item | 1 | 4.3 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 1 | 0.1 | 0 | 0% | `WITH live AS ( SELECT i.workspace_id, count(*)::int AS n FROM harness_shared.blueprint_operation_inv` |
| steady session_turn | 64 | 58 | 4538 | 34% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 64 | 46.8 | 3423 | 71% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 7 | 292 | 156 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 61 | 24 | 433 | 27% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 11 | 12.7 | 74 | 32% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 4 | 7 | 3 | 3% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 16.3 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2014 |
| work_item | legacy | semantic:embeddings | 39 |
| work_item | bm25 | lexical:lexical | 1119 |
| work_item | bm25 | semantic:embeddings | 22 |
| session_turn | legacy | lexical:lexical | 5054 |
| session_turn | legacy | semantic:embeddings | 38 |
| session_turn | bm25 | lexical:lexical | 599 |
| session_turn | bm25 | semantic:embeddings | 24 |

Host at start: 2026-10-11T17:16:33.257Z: loadavg 251.12 223.81 206.02 112/84500 366274; io some avg10=22.48 avg60=20.83 avg300=20.12 total=121035129128; cpu some avg10=9.50 avg60=10.84 avg300=7.24 total=13170466907; active backends 20

Host at end: 2026-10-11T17:19:49.381Z: loadavg 207.81 218.22 207.69 49/84270 548105; io some avg10=24.87 avg60=18.56 avg300=18.76 total=121070183912; cpu some avg10=2.76 avg60=6.87 avg300=7.57 total=13187245669; active backends 5
