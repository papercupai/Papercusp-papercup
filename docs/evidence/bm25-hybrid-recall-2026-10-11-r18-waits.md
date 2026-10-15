# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T17:40:33.822Z at commit 73a809c098de314e7ca2866c88815605f55cd238.
Both arms ran in one process on the identical sample (fingerprint `e0b1e94fd10fadae146919968bfabb7f68ce175040ee36f60ddee9d8d8bff141`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 52/60 (86.7%) | 0.822 | 2 | 309.3 | 1642.8 | legacy |
| work_item | bm25 | 54/60 (90.0%) | 0.823 | 0 | 76 | 158.6 | bm25 |
| session_turn | legacy | 44/60 (73.3%) | 0.718 | 6 | 1056.4 | 8044.9 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.825 | 0 | 153.2 | 371.7 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 52 | 2 | 0 | 6 | pass |
| session_turn | 44 | 6 | 0 | 10 | pass |

- work_item: BM25 recall@10 54/60 >= legacy 52/60; latency pass: BM25-arm p95 158.6 ms <= legacy p95 1642.8 ms; warm-repeat BM25 p95 78.7 ms <= the 200 ms ceiling; cold paired BM25 p95 158.6 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 50/60 >= legacy 44/60; latency pass: BM25-arm p95 371.7 ms <= legacy p95 8044.9 ms; warm-repeat BM25 p95 224.5 ms <= the 400 ms ceiling; cold paired BM25 p95 371.7 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 39.8 | 78.7 | 60 | 200 | 158.6 | 1000 | 187.4 | pass |
| session_turn | 60 | 79.3 | 224.5 | 60 | 400 | 371.7 | 1200 | 234.7 | pass |

- work_item before warm-up: 2026-10-11T17:39:39.301Z: loadavg 134.81 185.23 195.94 84/85361 1752428; io some avg10=7.34 avg60=6.23 avg300=15.72 total=121328816682; cpu some avg10=3.60 avg60=6.91 avg300=5.49 total=13250969760; active backends 26
- work_item after steady pass: 2026-10-11T17:40:08.268Z: loadavg 221.96 201.16 200.88 169/86335 1777979; io some avg10=37.49 avg60=18.55 avg300=17.84 total=121339991097; cpu some avg10=7.99 avg60=6.60 avg300=5.52 total=13252957533; active backends 40
- session_turn before warm-up: 2026-10-11T17:40:08.276Z: loadavg 221.96 201.16 200.88 241/86370 1778039; io some avg10=37.49 avg60=18.55 avg300=17.84 total=121339993957; cpu some avg10=7.99 avg60=6.60 avg300=5.52 total=13252959582; active backends 46
- session_turn after steady pass: 2026-10-11T17:40:33.547Z: loadavg 198.53 197.14 199.54 78/85179 1815361; io some avg10=13.26 avg60=15.63 avg300=17.19 total=121342786343; cpu some avg10=6.11 avg60=7.00 avg300=5.75 total=13254982305; active backends 38

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 41 | 1283.4 | 8424 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 56 | 685.2 | 8102 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 144 | 202.6 | 19533 | 26% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 153 | 153.2 | 16248 | 15% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 119 | 47.9 | 20742 | 45% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 119 | 33 | 4536 | 38% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 119 | 20.2 | 4190 | 54% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 9 | 8.8 | 89 | 39% | `SELECT (-((coalesce(title, $4) \|\| $5 \|\| coalesce(summary, $6) \|\| $7 \|\| coalesce(notes, $8)) <@> to_b` |
| steady work_item | 63 | 158.7 | 1396 | 13% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 15 | 274.5 | 215 | 8% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 5 | 248.5 | 122 | 47% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 3 | 45.5 | 2 | 1% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 1 | 115.8 | 7 | 3% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 3 | 13.7 | 1 | 1% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 2 | 9.3 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady work_item | 1 | 0 | 0 | - | `WITH live AS ( SELECT i.workspace_id, count(*)::int AS n FROM harness_shared.blueprint_operation_inv` |
| steady session_turn | 18 | 359.2 | 8352 | 38% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 6 | 1032.6 | 2857 | 35% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 67 | 54.2 | 5618 | 19% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 67 | 39 | 4966 | 54% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 58 | 20.3 | 605 | 13% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 7 | 7.5 | 22 | 25% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 0.1 | 0 | 0% | `WITH live AS ( SELECT i.workspace_id, count(*)::int AS n FROM harness_shared.blueprint_operation_inv` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1623 |
| work_item | legacy | semantic:embeddings | 22 |
| work_item | bm25 | lexical:lexical | 139 |
| work_item | bm25 | semantic:embeddings | 14 |
| session_turn | legacy | lexical:lexical | 3990 |
| session_turn | legacy | semantic:embeddings | 23 |
| session_turn | bm25 | lexical:lexical | 348 |
| session_turn | bm25 | semantic:embeddings | 16 |

Host at start: 2026-10-11T17:36:10.968Z: loadavg 324.04 228.15 208.46 70/83038 1508353; io some avg10=27.78 avg60=30.85 avg300=26.00 total=121314726138; cpu some avg10=0.65 avg60=1.52 avg300=3.24 total=13233990024; active backends 91

Host at end: 2026-10-11T17:39:08.576Z: loadavg 142.79 191.73 198.30 120/84894 1712260; io some avg10=7.26 avg60=6.63 avg300=16.91 total=121326958150; cpu some avg10=8.18 avg60=8.53 avg300=5.57 total=13249315067; active backends 53
