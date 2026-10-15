# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T17:48:42.172Z at commit 6a57a0bea72d2e2a97cc5285c578bf098d0d3ea6.
Both arms ran in one process on the identical sample (fingerprint `97ff79b863d2d0b9d821f9a68a06f49498bbc5c624fcc6baaeb09a575066a504`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **fail**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 60/60 (100.0%) | 0.951 | 0 | 207.9 | 2083.6 | legacy |
| work_item | bm25 | 59/60 (98.3%) | 0.913 | 0 | 68.2 | 160.6 | bm25 |
| session_turn | legacy | 48/60 (80.0%) | 0.738 | 7 | 1331.6 | 8055.9 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.772 | 1 | 174.4 | 886.5 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 59 | 0 | 1 | 0 | fail |
| session_turn | 46 | 4 | 2 | 8 | pass |

- work_item: BM25 recall@10 59/60 is below legacy 60/60; latency pass: BM25-arm p95 160.6 ms <= legacy p95 2083.6 ms; warm-repeat BM25 p95 71.8 ms <= the 200 ms ceiling; cold paired BM25 p95 160.6 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 50/60 >= legacy 48/60; latency pass: BM25-arm p95 886.5 ms <= legacy p95 8055.9 ms; warm-repeat BM25 p95 171.7 ms <= the 400 ms ceiling; cold paired BM25 p95 886.5 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 42.6 | 71.8 | 60 | 200 | 160.6 | 1000 | 144 | pass |
| session_turn | 60 | 77 | 171.7 | 60 | 400 | 886.5 | 1200 | 385.9 | pass |

- work_item before warm-up: 2026-10-11T17:47:54.865Z: loadavg 221.59 223.08 207.96 111/83074 2254876; io some avg10=7.97 avg60=13.93 avg300=14.45 total=121400787348; cpu some avg10=9.22 avg60=10.13 avg300=9.26 total=13301389862; active backends 28
- work_item after steady pass: 2026-10-11T17:48:09.739Z: loadavg 215.56 221.75 207.77 88/82876 2266949; io some avg10=7.27 avg60=12.19 avg300=14.02 total=121401795145; cpu some avg10=8.78 avg60=9.88 avg300=9.25 total=13303013303; active backends 12
- session_turn before warm-up: 2026-10-11T17:48:09.742Z: loadavg 215.56 221.75 207.77 85/82876 2266950; io some avg10=7.27 avg60=12.19 avg300=14.02 total=121401795267; cpu some avg10=8.78 avg60=9.88 avg300=9.25 total=13303013340; active backends 12
- session_turn after steady pass: 2026-10-11T17:48:41.193Z: loadavg 193.12 215.83 206.25 99/82939 2294059; io some avg10=5.63 avg60=9.87 avg300=13.27 total=121404087611; cpu some avg10=10.78 avg60=10.34 avg300=9.42 total=13306489217; active backends 30

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 44 | 1522.1 | 45784 | 26% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 92 | 272.7 | 93735 | 128% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 144 | 108.9 | 21216 | 70% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 45 | 328.9 | 11167 | 35% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 115 | 95.2 | 21742 | 46% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 114 | 63.5 | 7335 | 44% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 117 | 22.2 | 4918 | 50% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 1 | 1921.4 | 1094 | 21% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 7 | 323.4 | 410 | 12% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 66 | 16.8 | 1237 | 29% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 8 | 33.5 | 602 | 64% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 6 | 15.4 | 16 | 8% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 6 | 10.5 | 67 | 18% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 3 | 19.3 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 2 | 2.8 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady work_item | 2 | 0.2 | 0 | 0% | `SELECT * FROM ( SELECT $6 AS one, (coalesce(w.title, $7) \|\| $8 \|\| coalesce(w.summary, $9) \|\| $10 \|\| ` |
| steady session_turn | 66 | 63.2 | 6272 | 63% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 66 | 61.1 | 5376 | 27% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 14 | 197.8 | 18257 | 216% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 59 | 35.1 | 1898 | 36% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 9 | 153.9 | 206 | 13% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 6 | 9.4 | 34 | 17% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 39.1 | 0 | 0% | `WITH ranked AS ( SELECT w.workspace_id AS ranked_ws, w.feature_id AS ranked_id, (-((coalesce(w.title` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2066 |
| work_item | legacy | semantic:embeddings | 15 |
| work_item | bm25 | lexical:lexical | 123 |
| work_item | bm25 | semantic:embeddings | 20 |
| session_turn | legacy | lexical:lexical | 3583 |
| session_turn | legacy | semantic:embeddings | 33 |
| session_turn | bm25 | lexical:lexical | 855 |
| session_turn | bm25 | semantic:embeddings | 43 |

Host at start: 2026-10-11T17:43:45.518Z: loadavg 192.09 186.28 194.09 131/84935 2026118; io some avg10=9.02 avg60=13.13 avg300=14.18 total=121363392342; cpu some avg10=8.94 avg60=10.28 avg300=8.17 total=13276201621; active backends 21

Host at end: 2026-10-11T17:47:22.363Z: loadavg 289.80 233.93 210.73 107/83251 2225437; io some avg10=16.41 avg60=17.37 avg300=15.05 total=121397637899; cpu some avg10=14.65 avg60=11.48 avg300=9.40 total=13298772196; active backends 29
