# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T16:13:20.201Z at commit c9a2ecca438781185a40b89374cc93dae30e4516.
Both arms ran in one process on the identical sample (fingerprint `545931ce36b7b8d4a9a7050eed9874e8886943bb645b2496684b2d516df5b928`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-024, D-025) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy; the steady pass (untimed warm-up on a disjoint sample, then BM25-only over a third disjoint sample of novel queries) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 56/60 (93.3%) | 0.873 | 2 | 197.9 | 884.6 | legacy |
| work_item | bm25 | 58/60 (96.7%) | 0.909 | 0 | 83.5 | 163.1 | bm25 |
| session_turn | legacy | 52/60 (86.7%) | 0.811 | 1 | 958.6 | 3875 | legacy |
| session_turn | bm25 | 52/60 (86.7%) | 0.814 | 0 | 150.1 | 500.4 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 56 | 2 | 0 | 2 | pass |
| session_turn | 52 | 0 | 0 | 8 | pass |

- work_item: BM25 recall@10 58/60 >= legacy 56/60; latency pass: paired BM25-arm p95 163.1 ms <= legacy p95 884.6 ms; steady-pass BM25 p95 109.2 ms (60 novel queries, warm index) <= the 200 ms ceiling
- session_turn: BM25 recall@10 52/60 >= legacy 52/60; latency pass: paired BM25-arm p95 500.4 ms <= legacy p95 3875 ms; steady-pass BM25 p95 335.3 ms (60 novel queries, warm index) <= the 400 ms ceiling

## Steady pass (D-024, D-025)

| source | warm-up calls | steady calls | steady p50 ms | steady p95 ms | ceiling ms | cold paired BM25 p95 ms | R-18 |
|---|---|---|---|---|---|---|---|
| work_item | 60 | 60 | 67.4 | 109.2 | 200 | 163.1 | pass |
| session_turn | 60 | 60 | 114.3 | 335.3 | 400 | 500.4 | pass |

- work_item before warm-up: 2026-10-11T16:12:39.953Z: loadavg 243.89 221.36 208.91 129/81201 402442; io some avg10=34.73 avg60=32.76 avg300=26.86 total=120203655578; cpu some avg10=1.31 avg60=2.03 avg300=3.96 total=12987772925; active backends 29
- work_item after steady pass: 2026-10-11T16:12:56.166Z: loadavg 232.01 219.68 208.55 117/81373 414131; io some avg10=34.07 avg60=31.05 avg300=26.75 total=120207974876; cpu some avg10=2.57 avg60=2.50 avg300=3.97 total=12988355416; active backends 26
- session_turn before warm-up: 2026-10-11T16:12:56.169Z: loadavg 232.01 219.68 208.55 116/81372 414131; io some avg10=34.07 avg60=31.05 avg300=26.75 total=120207975823; cpu some avg10=2.57 avg60=2.50 avg300=3.97 total=12988355504; active backends 26
- session_turn after steady pass: 2026-10-11T16:13:19.562Z: loadavg 227.71 220.13 209.02 127/81219 434105; io some avg10=22.09 avg60=28.36 avg300=26.45 total=120213472056; cpu some avg10=1.67 avg60=2.24 avg300=3.80 total=12988851046; active backends 35

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 41 | 1359.4 | 11513 | 22% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 71 | 399.1 | 8823 | 28% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 129 | 186.6 | 34086 | 108% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 136 | 110.9 | 7900 | 25% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 72 | 117.4 | 21002 | 49% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 90 | 44.2 | 3800 | 64% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 72 | 44.3 | 4697 | 75% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 2 | 777.7 | 349 | 18% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 61 | 25.2 | 1381 | 51% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 7 | 140.7 | 134 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 1 | 115.9 | 52 | 6% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 2 | 45.6 | 52 | 40% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 9 | 8.9 | 62 | 41% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 1 | 37.6 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 1 | 11.1 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 1 | 2.8 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 3 | 2185.3 | 1695 | 15% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 62 | 56.4 | 4123 | 21% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 1 | 2860.7 | 64 | 1% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 62 | 39.7 | 3411 | 71% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 5 | 453.3 | 7803 | 258% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 59 | 12.2 | 76 | 9% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 1 | 70.6 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady session_turn | 2 | 8.8 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 863 |
| work_item | legacy | semantic:embeddings | 19 |
| work_item | bm25 | lexical:lexical | 151 |
| work_item | bm25 | semantic:embeddings | 9 |
| session_turn | legacy | lexical:lexical | 3867 |
| session_turn | legacy | semantic:embeddings | 32 |
| session_turn | bm25 | lexical:lexical | 480 |
| session_turn | bm25 | semantic:embeddings | 10 |

Host at start: 2026-10-11T16:10:24.589Z: loadavg 169.09 198.53 200.39 70/80758 284731; io some avg10=25.97 avg60=14.83 avg300=21.26 total=120153325144; cpu some avg10=2.06 avg60=6.28 avg300=5.28 total=12984677150; active backends 18

Host at end: 2026-10-11T16:12:39.950Z: loadavg 243.89 221.36 208.91 114/81202 402442; io some avg10=34.73 avg60=32.76 avg300=26.86 total=120203655309; cpu some avg10=1.31 avg60=2.03 avg300=3.96 total=12987772646; active backends 32
