# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T22:53:29.490Z at commit c9e7527a29c77ccb057cd41b62b3277dd070f8eb.
Both arms ran in one process on the identical sample (fingerprint `9ac19445736b2527fa828093dabc39045824a9a46f6d84c0c6e7c1e0e6b17556`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 55/60 (91.7%) | 0.897 | 1 | 201.7 | 531 | legacy |
| work_item | bm25 | 57/60 (95.0%) | 0.917 | 0 | 44.4 | 99.5 | bm25 |
| session_turn | legacy | 51/60 (85.0%) | 0.762 | 1 | 661.8 | 5988.8 | legacy |
| session_turn | bm25 | 51/60 (85.0%) | 0.764 | 0 | 93.5 | 207.1 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 55 | 2 | 0 | 3 | pass |
| session_turn | 50 | 1 | 1 | 8 | pass |

- work_item: BM25 recall@10 57/60 >= legacy 55/60; latency pass: BM25-arm p95 99.5 ms <= legacy p95 531 ms; warm-repeat BM25 p95 51.6 ms <= the 200 ms ceiling; cold paired BM25 p95 99.5 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 51/60 >= legacy 51/60; latency pass: BM25-arm p95 207.1 ms <= legacy p95 5988.8 ms; warm-repeat BM25 p95 183.3 ms <= the 400 ms ceiling; cold paired BM25 p95 207.1 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 30.7 | 51.6 | 3 | 200 | 99.5 | 1000 | 61.8 | pass |
| session_turn | 60 | 60.2 | 183.3 | 11 | 400 | 207.1 | 1200 | 278.7 | pass |

- work_item before warm-up: 2026-10-11T22:52:57.901Z: loadavg 185.23 160.70 159.22 85/91611 3389706; io some avg10=13.76 avg60=14.21 avg300=15.47 total=124364031445; cpu some avg10=1.86 avg60=2.00 avg300=1.92 total=16636919479; active backends 23
- work_item after steady pass: 2026-10-11T22:53:08.583Z: loadavg 170.11 158.27 158.45 84/92489 3397027; io some avg10=14.16 avg60=14.11 avg300=15.40 total=124365533238; cpu some avg10=1.82 avg60=2.02 avg300=1.93 total=16637215054; active backends 26
- session_turn before warm-up: 2026-10-11T22:53:08.591Z: loadavg 170.11 158.27 158.45 75/92487 3397032; io some avg10=14.16 avg60=14.11 avg300=15.40 total=124365533901; cpu some avg10=1.82 avg60=2.02 avg300=1.93 total=16637215226; active backends 43
- session_turn after steady pass: 2026-10-11T22:53:29.411Z: loadavg 154.14 155.40 157.50 87/92615 3415416; io some avg10=8.54 avg60=12.09 avg300=14.82 total=124367120609; cpu some avg10=2.06 avg60=2.04 avg300=1.94 total=16637779128; active backends 26

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 43 | 1548.9 | 3797 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 58 | 719.2 | 1764 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 56 | 298 | 162 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 82 | 159.1 | 2674 | 11% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 108 | 101.5 | 1152 | 5% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 59 | 149.5 | 15 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 7 | 621.2 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| paired | 85 | 41.3 | 3680 | 26% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 5 | 211.8 | 69 | 6% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 60 | 17.6 | 605 | 47% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 60 | 8.4 | 404 | 67% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 5 | 77.2 | 1 | 0% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 1 | 168.8 | 22 | 11% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 1 | 117.5 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 1 | 37.5 | 1 | 2% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady work_item | 1 | 4.1 | 0 | 0% | `SELECT * FROM ( SELECT $6 AS one, (coalesce(w.title, $7) \|\| $8 \|\| coalesce(w.summary, $9) \|\| $10 \|\| ` |
| steady session_turn | 61 | 47.2 | 2021 | 19% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 60 | 47.1 | 2717 | 51% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 15 | 156 | 324 | 8% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 4 | 366.1 | 249 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 15 | 18.1 | 16 | 17% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 4 | 66.5 | 17 | 3% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 1 | 58.1 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady session_turn | 1 | 11.1 | 5 | 84% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 523 |
| work_item | legacy | semantic:embeddings | 14 |
| work_item | bm25 | lexical:lexical | 82 |
| work_item | bm25 | semantic:embeddings | 21 |
| session_turn | legacy | lexical:lexical | 5978 |
| session_turn | legacy | semantic:embeddings | 24 |
| session_turn | bm25 | lexical:lexical | 185 |
| session_turn | bm25 | semantic:embeddings | 10 |

Host at start: 2026-10-11T22:50:20.757Z: loadavg 135.77 146.97 155.87 69/90532 3226982; io some avg10=11.09 avg60=16.13 avg300=17.77 total=124345027980; cpu some avg10=2.72 avg60=1.63 avg300=1.53 total=16631859896; active backends 22

Host at end: 2026-10-11T22:52:35.983Z: loadavg 204.54 162.08 159.63 100/90919 3373091; io some avg10=6.23 avg60=15.11 avg300=15.77 total=124361342730; cpu some avg10=2.58 avg60=2.00 avg300=1.91 total=16636388068; active backends 29
