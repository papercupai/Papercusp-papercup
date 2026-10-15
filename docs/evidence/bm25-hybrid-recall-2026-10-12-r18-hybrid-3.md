# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-12T07:57:00.715Z at commit e4bf686399041940a90e2585869dc493e5484f4c.
Both arms ran in one process on the identical sample (fingerprint `2e59e63ec523c1fcdc0539a9344261e32d10d60f6299ccdca6bcb9f2654d8da1`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **fail**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 54/60 (90.0%) | 0.826 | 0 | 236.7 | 1465.6 | legacy |
| work_item | bm25 | 53/60 (88.3%) | 0.697 | 0 | 108.7 | 481.1 | bm25 |
| session_turn | legacy | 45/60 (75.0%) | 0.703 | 0 | 1136.4 | 4402.2 | legacy |
| session_turn | bm25 | 45/60 (75.0%) | 0.622 | 0 | 277.5 | 1472.9 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 53 | 0 | 1 | 6 | fail |
| session_turn | 44 | 1 | 1 | 14 | pass |

- work_item: BM25 recall@10 53/60 is below legacy 54/60; latency pass: BM25-arm p95 481.1 ms <= legacy p95 1465.6 ms; warm-repeat BM25 p95 80.5 ms <= the 200 ms ceiling; cold paired BM25 p95 481.1 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 45/60 >= legacy 45/60; latency fail: BM25-arm p95 1472.9 ms <= legacy p95 4402.2 ms, but the cold paired BM25 p95 1472.9 ms exceeds the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 36.6 | 80.5 | 4 | 200 | 481.1 | 1000 | 207.1 | pass |
| session_turn | 60 | 74.1 | 177.9 | 10 | 400 | 1472.9 | 1200 | 1376.3 | fail |

- work_item before warm-up: 2026-10-12T07:55:18.373Z: loadavg 138.28 161.53 156.12 88/95721 3376635; io some avg10=11.52 avg60=21.14 avg300=19.40 total=131782382424; cpu some avg10=0.78 avg60=1.01 avg300=2.20 total=17224927362; active backends 20
- work_item after steady pass: 2026-10-12T07:55:39.801Z: loadavg 116.02 154.95 154.07 57/95855 3396218; io some avg10=3.93 avg60=15.48 avg300=18.18 total=131783051806; cpu some avg10=0.11 avg60=0.72 avg300=2.05 total=17225084637; active backends 8
- session_turn before warm-up: 2026-10-12T07:55:39.803Z: loadavg 116.02 154.95 154.07 62/95855 3396218; io some avg10=3.93 avg60=15.48 avg300=18.18 total=131783052021; cpu some avg10=0.11 avg60=0.72 avg300=2.05 total=17225084703; active backends 8
- session_turn after steady pass: 2026-10-12T07:57:00.481Z: loadavg 149.22 153.18 153.30 58/95890 3470022; io some avg10=31.96 avg60=21.52 avg300=18.73 total=131799165755; cpu some avg10=0.11 avg60=0.72 avg300=1.75 total=17226346685; active backends 8

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 41 | 1383.6 | 10987 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 82 | 415.7 | 8351 | 13% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 158 | 149.8 | 32081 | 68% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 60 | 272.6 | 6039 | 12% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 51 | 266.8 | 2737 | 8% | `WITH q AS ( SELECT replace(plainto_tsquery($10, $1)::text, $11, $12)::tsquery AS orq, string_to_arra` |
| paired | 159 | 55.5 | 8016 | 56% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| paired | 84 | 89.2 | 2708 | 21% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| paired | 87 | 65.8 | 22673 | 50% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 11 | 373.9 | 10934 | 52% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 61 | 16 | 1269 | 30% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 3 | 282.5 | 0 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 61 | 9.9 | 1333 | 58% | `WITH q AS ( SELECT plainto_tsquery($9, $1) AS andq ) SELECT ei.issue_id, ei.scope, ei.title, ei.body` |
| steady work_item | 11 | 50.9 | 56 | 6% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady work_item | 1 | 441.6 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 2 | 97.4 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady work_item | 3 | 63.2 | 0 | 0% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 23 | 321.3 | 914 | 10% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 70 | 58 | 3615 | 65% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT s.source_kind, s.session_id, s.turn_idx,` |
| steady session_turn | 70 | 44.6 | 4110 | 33% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 47 | 46 | 730 | 27% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 4 | 449.7 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |
| steady session_turn | 22 | 56.1 | 55 | 6% | `WITH q AS ( SELECT replace(plainto_tsquery($11, $1)::text, $12, $13)::tsquery AS orq, string_to_arra` |
| steady session_turn | 47 | 14.5 | 83 | 11% | `WITH q AS ( SELECT plainto_tsquery($7, $1) AS andq ) SELECT issue_id, scope, title, body, kind, stat` |
| steady session_turn | 3 | 108.5 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.engineer_issues WHERE workspace_id = $1 AND kind = ANY` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 491 |
| work_item | legacy | semantic:embeddings | 564 |
| work_item | bm25 | lexical:lexical | 121 |
| work_item | bm25 | semantic:embeddings | 398 |
| session_turn | legacy | lexical:lexical | 3977 |
| session_turn | legacy | semantic:embeddings | 1121 |
| session_turn | bm25 | lexical:lexical | 363 |
| session_turn | bm25 | semantic:embeddings | 980 |

Host at start: 2026-10-12T07:50:51.568Z: loadavg 325.86 193.05 162.00 61/98149 3181299; io some avg10=56.69 avg60=39.76 avg300=20.59 total=131736263850; cpu some avg10=3.14 avg60=3.35 avg300=3.10 total=17218488863; active backends 21

Host at end: 2026-10-12T07:53:56.925Z: loadavg 173.72 167.17 156.93 47/95891 3316904; io some avg10=58.51 avg60=25.99 avg300=18.64 total=131764315507; cpu some avg10=0.34 avg60=1.67 avg300=2.68 total=17223924156; active backends 14
