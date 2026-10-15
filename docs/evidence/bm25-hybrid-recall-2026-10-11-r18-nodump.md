# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T16:35:32.515Z at commit 79e67ad9833002e8096876ff54a8559f67709081.
Both arms ran in one process on the identical sample (fingerprint `209963a7f6f0ff0ae65ea6c7e10c8ec60d00df43c386142716ea0e7d410fab14`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-024, D-025) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy; the steady pass (untimed warm-up on a disjoint sample, then BM25-only over a third disjoint sample of novel queries) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 58/60 (96.7%) | 0.917 | 1 | 214 | 1074.1 | legacy |
| work_item | bm25 | 58/60 (96.7%) | 0.918 | 0 | 75.2 | 555.9 | bm25 |
| session_turn | legacy | 49/60 (81.7%) | 0.800 | 6 | 1053.1 | 8309.7 | legacy |
| session_turn | bm25 | 54/60 (90.0%) | 0.883 | 0 | 180 | 608.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 57 | 1 | 1 | 1 | pass |
| session_turn | 49 | 5 | 0 | 6 | pass |

- work_item: BM25 recall@10 58/60 >= legacy 58/60; latency fail: BM25-arm p95 555.9 ms <= legacy p95 1074.1 ms, but it exceeds the 200 ms ceiling
- session_turn: BM25 recall@10 54/60 >= legacy 49/60; latency fail: BM25-arm p95 608.6 ms <= legacy p95 8309.7 ms, but it exceeds the 400 ms ceiling

## Steady pass (D-024, D-025)

| source | warm-up calls | steady calls | steady p50 ms | steady p95 ms | ceiling ms | cold paired BM25 p95 ms | R-18 |
|---|---|---|---|---|---|---|---|
| work_item | 60 | 60 | 90.2 | 255 | 200 | 555.9 | fail |
| session_turn | 60 | 60 | 169.8 | 424.5 | 400 | 608.6 | fail |

- work_item before warm-up: 2026-10-11T16:34:41.084Z: loadavg 153.32 189.99 192.95 88/80409 1747065; io some avg10=31.39 avg60=27.91 avg300=26.70 total=120508432439; cpu some avg10=1.73 avg60=2.20 avg300=1.94 total=13019152590; active backends 19
- work_item after steady pass: 2026-10-11T16:35:00.833Z: loadavg 176.05 192.65 193.76 97/80448 1760025; io some avg10=55.31 avg60=35.49 avg300=28.52 total=120519220641; cpu some avg10=1.51 avg60=1.95 avg300=1.89 total=13019474185; active backends 15
- session_turn before warm-up: 2026-10-11T16:35:00.837Z: loadavg 176.05 192.65 193.76 79/80451 1760031; io some avg10=55.31 avg60=35.49 avg300=28.52 total=120519223353; cpu some avg10=1.51 avg60=1.95 avg300=1.89 total=13019474235; active backends 16
- session_turn after steady pass: 2026-10-11T16:35:32.292Z: loadavg 176.88 191.27 193.27 60/80442 1795097; io some avg10=35.72 avg60=35.45 avg300=29.22 total=120530580251; cpu some avg10=1.73 avg60=1.97 avg300=1.91 total=13020291323; active backends 23

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 41 | 1579.6 | 23264 | 27% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 210 | 235.3 | 60397 | 87% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 106 | 333.1 | 7700 | 17% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 142 | 99.2 | 5238 | 33% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 105 | 67.8 | 5244 | 57% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 105 | 61.7 | 20967 | 57% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 105 | 55 | 5402 | 65% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 1 | 525 | 101 | 6% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 62 | 37.3 | 2090 | 69% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 9 | 251 | 295 | 23% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 3 | 400 | 236 | 28% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 2 | 104.5 | 80 | 57% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 2 | 31.3 | 132 | 70% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 67 | 65.5 | 3248 | 76% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 67 | 63.7 | 5463 | 48% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 8 | 300.3 | 29 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 18 | 101.5 | 755 | 47% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 62 | 14.4 | 54 | 7% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 7 | 8 | 6 | 17% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 41 | 20 | 41% | `WITH ranked AS ( SELECT w.workspace_id AS ranked_ws, w.feature_id AS ranked_id, (-((coalesce(w.title` |
| steady session_turn | 2 | 3.1 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1061 |
| work_item | legacy | semantic:embeddings | 24 |
| work_item | bm25 | lexical:lexical | 174 |
| work_item | bm25 | semantic:embeddings | 12 |
| session_turn | legacy | lexical:lexical | 6475 |
| session_turn | legacy | semantic:embeddings | 25 |
| session_turn | bm25 | lexical:lexical | 565 |
| session_turn | bm25 | semantic:embeddings | 11 |

Host at start: 2026-10-11T16:31:35.316Z: loadavg 155.44 193.07 192.82 79/80650 1608008; io some avg10=11.53 avg60=17.94 avg300=23.73 total=120450508218; cpu some avg10=2.67 avg60=2.43 avg300=2.07 total=13015268728; active backends 14

Host at end: 2026-10-11T16:34:41.080Z: loadavg 153.32 189.99 192.95 70/80408 1747064; io some avg10=31.39 avg60=27.91 avg300=26.70 total=120508430798; cpu some avg10=1.73 avg60=2.20 avg300=1.94 total=13019152555; active backends 19
