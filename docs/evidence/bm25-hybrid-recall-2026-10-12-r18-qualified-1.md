# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T06:29:26.673Z at commit 6f334e08c55ef32cafd6e7977cfc2497e551b417.
Both arms ran in one process on the identical sample (fingerprint `c586f1015f392df2eb5a4948f5a949038c89a055031711ef6e216939314cecda`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.902 | 2 | 225.3 | 1076.8 | legacy |
| work_item | bm25 | 57/60 (95.0%) | 0.887 | 0 | 69.5 | 134.5 | bm25 |
| session_turn | legacy | 39/60 (65.0%) | 0.614 | 5 | 797.7 | 8050 | legacy |
| session_turn | bm25 | 46/60 (76.7%) | 0.689 | 0 | 100.7 | 586.1 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 2 | 0 | 3 | pass |
| session_turn | 39 | 7 | 0 | 14 | pass |

- work_item: BM25 recall@10 57/60 >= legacy 55/60; latency pass: BM25-arm p95 134.5 ms <= legacy p95 1076.8 ms; warm-repeat BM25 p95 34.6 ms <= the 200 ms ceiling; cold paired BM25 p95 134.5 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 46/60 >= legacy 39/60; latency pass: BM25-arm p95 586.1 ms <= legacy p95 8050 ms; warm-repeat BM25 p95 139.7 ms <= the 400 ms ceiling; cold paired BM25 p95 586.1 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 23.5 | 34.6 | 9 | 200 | 134.5 | 1000 | 48.7 | pass |
| session_turn | 60 | 49.5 | 139.7 | 11 | 400 | 586.1 | 1200 | 143.9 | pass |

- work_item before warm-up: 2026-10-12T06:29:03.481Z: loadavg 134.78 157.58 149.47 48/90639 2935023; io some avg10=3.36 avg60=15.30 avg300=19.69 total=130799293951; cpu some avg10=0.05 avg60=0.44 avg300=0.56 total=17142767493; active backends 10
- work_item after steady pass: 2026-10-12T06:29:12.238Z: loadavg 129.83 156.17 149.06 28/90698 2939701; io some avg10=3.00 avg60=13.73 avg300=19.23 total=130799560374; cpu some avg10=0.77 avg60=0.57 avg300=0.59 total=17142907821; active backends 14
- session_turn before warm-up: 2026-10-12T06:29:12.240Z: loadavg 129.83 156.17 149.06 38/90697 2939701; io some avg10=3.00 avg60=13.73 avg300=19.23 total=130799560520; cpu some avg10=0.77 avg60=0.57 avg300=0.59 total=17142907827; active backends 14
- session_turn after steady pass: 2026-10-12T06:29:26.424Z: loadavg 115.52 151.68 147.70 80/90682 2945939; io some avg10=2.67 avg60=11.44 avg300=18.45 total=130800009910; cpu some avg10=0.19 avg60=0.45 avg300=0.56 total=17142993924; active backends 43

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 37 | 921 | 6392 | 11% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 74 | 422.4 | 3500 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 148 | 126.1 | 9348 | 32% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 60 | 271 | 6332 | 17% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 57 | 275.4 | 1938 | 12% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 148 | 72.9 | 5694 | 31% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 75 | 139.5 | 3144 | 13% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 92 | 71.8 | 19347 | 44% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 11 | 103.9 | 192 | 6% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 4 | 251.2 | 7 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 61 | 13.4 | 1316 | 18% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 2 | 99.4 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 61 | 3.1 | 333 | 32% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 4 | 40.8 | 2 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 10 | 2 | 14 | 20% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 65 | 35.3 | 6341 | 15% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 65 | 28.2 | 4656 | 37% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 5 | 353.5 | 452 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 5 | 254.2 | 366 | 5% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 9 | 79 | 95 | 3% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 1 | 506.3 | 0 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 1 | 451.1 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 9 | 48 | 285 | 12% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1019 |
| work_item | legacy | semantic:embeddings | 13 |
| work_item | bm25 | lexical:lexical | 126 |
| work_item | bm25 | semantic:embeddings | 7 |
| session_turn | legacy | lexical:lexical | 2559 |
| session_turn | legacy | semantic:embeddings | 10 |
| session_turn | bm25 | lexical:lexical | 433 |
| session_turn | bm25 | semantic:embeddings | 11 |

Host at start: 2026-10-12T06:26:23.102Z: loadavg 223.10 139.25 141.21 57/90943 2844677; io some avg10=44.58 avg60=34.19 avg300=18.38 total=130761153846; cpu some avg10=0.18 avg60=0.15 avg300=0.60 total=17141009412; active backends 11

Host at end: 2026-10-12T06:28:45.904Z: loadavg 165.35 164.53 151.48 56/90734 2927260; io some avg10=3.94 avg60=19.55 avg300=20.75 total=130798625965; cpu some avg10=0.32 avg60=0.60 avg300=0.60 total=17142658791; active backends 7
