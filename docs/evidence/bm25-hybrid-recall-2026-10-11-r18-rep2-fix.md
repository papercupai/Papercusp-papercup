# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T19:36:31.138Z at commit 96fc775661bf80e16597cc2954ad4db508bbf9fa.
Both arms ran in one process on the identical sample (fingerprint `97ff79b863d2d0b9d821f9a68a06f49498bbc5c624fcc6baaeb09a575066a504`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 60/60 (100.0%) | 0.951 | 0 | 249.4 | 2289.8 | legacy |
| work_item | bm25 | 60/60 (100.0%) | 0.867 | 0 | 129.3 | 453.8 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.755 | 3 | 1059.1 | 8072.9 | legacy |
| session_turn | bm25 | 50/60 (83.3%) | 0.738 | 0 | 227.2 | 617.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 60 | 0 | 0 | 0 | pass |
| session_turn | 47 | 3 | 2 | 8 | pass |

- work_item: BM25 recall@10 60/60 >= legacy 60/60; latency pass: BM25-arm p95 453.8 ms <= legacy p95 2289.8 ms; warm-repeat BM25 p95 111.4 ms <= the 200 ms ceiling; cold paired BM25 p95 453.8 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 50/60 >= legacy 49/60; latency pass: BM25-arm p95 617.6 ms <= legacy p95 8072.9 ms; warm-repeat BM25 p95 196.4 ms <= the 400 ms ceiling; cold paired BM25 p95 617.6 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 64.3 | 111.4 | 60 | 200 | 453.8 | 1000 | 122.9 | pass |
| session_turn | 60 | 96.5 | 196.4 | 60 | 400 | 617.6 | 1200 | 392.2 | pass |

- work_item before warm-up: 2026-10-11T19:35:40.632Z: loadavg 420.48 390.85 364.85 183/86214 771113; io some avg10=14.88 avg60=19.78 avg300=17.99 total=122539496412; cpu some avg10=29.98 avg60=29.35 avg300=30.29 total=14483501598; active backends 49
- work_item after steady pass: 2026-10-11T19:35:58.125Z: loadavg 383.58 384.07 363.05 181/86388 799190; io some avg10=10.22 avg60=17.69 avg300=17.64 total=122541514100; cpu some avg10=31.80 avg60=29.95 avg300=30.37 total=14489191438; active backends 11
- session_turn before warm-up: 2026-10-11T19:35:58.132Z: loadavg 383.58 384.07 363.05 227/86382 799191; io some avg10=10.22 avg60=17.69 avg300=17.64 total=122541516549; cpu some avg10=31.80 avg60=29.95 avg300=30.37 total=14489193422; active backends 12
- session_turn after steady pass: 2026-10-11T19:36:30.906Z: loadavg 345.76 374.86 360.76 246/86122 837864; io some avg10=6.53 avg60=13.62 avg300=16.65 total=122544567857; cpu some avg10=31.38 avg60=30.47 avg300=30.45 total=14499576310; active backends 23

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 43 | 1353 | 8573 | 18% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 63 | 474.3 | 8871 | 32% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 123 | 196.8 | 8484 | 36% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 131 | 130 | 4851 | 26% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 159 | 94.3 | 5590 | 36% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 129 | 103.7 | 20774 | 54% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 1 | 10490.9 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.harness_features_consolidated WHERE item_kind = ANY(AR` |
| paired | 1 | 10314.2 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.harness_features_consolidated WHERE item_kind = ANY(AR` |
| steady work_item | 60 | 20.6 | 1126 | 41% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 3 | 280.9 | 72 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 6 | 60.8 | 351 | 111% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 1 | 59.2 | 18 | 14% | `WITH ranked AS ( SELECT w.workspace_id AS ranked_ws, w.feature_id AS ranked_id, (-((coalesce(w.title` |
| steady work_item | 1 | 0 | 0 | - | `WITH live AS ( SELECT i.workspace_id, count(*)::int AS n FROM harness_shared.blueprint_operation_inv` |
| steady session_turn | 3 | 1933.6 | 246 | 7% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 66 | 72.3 | 4033 | 65% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 66 | 59.5 | 4265 | 34% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 14 | 246.5 | 1650 | 65% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 54 | 23.6 | 63 | 4% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 9 | 7.8 | 10 | 22% | `SELECT (-((coalesce(title, $4) \|\| $5 \|\| coalesce(summary, $6) \|\| $7 \|\| coalesce(notes, $8)) <@> to_b` |
| steady session_turn | 6 | 7.9 | 4 | 11% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 40.3 | 0 | 0% | `WITH ranked AS ( SELECT w.workspace_id AS ranked_ws, w.feature_id AS ranked_id, (-((coalesce(w.title` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2280 |
| work_item | legacy | semantic:embeddings | 23 |
| work_item | bm25 | lexical:lexical | 433 |
| work_item | bm25 | semantic:embeddings | 23 |
| session_turn | legacy | lexical:lexical | 4473 |
| session_turn | legacy | semantic:embeddings | 79 |
| session_turn | bm25 | lexical:lexical | 538 |
| session_turn | bm25 | semantic:embeddings | 49 |

Host at start: 2026-10-11T19:31:24.709Z: loadavg 423.56 351.48 347.56 152/86330 507603; io some avg10=26.62 avg60=19.76 avg300=13.56 total=122482940121; cpu some avg10=29.17 avg60=30.35 avg300=31.61 total=14407188439; active backends 30

Host at end: 2026-10-11T19:35:01.962Z: loadavg 479.26 394.30 364.70 151/85770 717878; io some avg10=29.39 avg60=23.59 avg300=18.21 total=122532863830; cpu some avg10=24.83 avg60=28.53 avg300=30.30 total=14471683720; active backends 20
