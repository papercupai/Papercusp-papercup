# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T19:59:23.979Z at commit aade315164ab63e90de1a58d1a0038cb467d2fa1.
Both arms ran in one process on the identical sample (fingerprint `bb8e6a1cc947ebc5982897e63aef1d37dccc3f48b36974b01e6b37154cabc899`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-028, D-029) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy and must stay under its cold ceiling (work_item 1000 ms, session_turn 1200 ms); the warm-repeat pass (each paired query's BM25-arm call run untimed, then timed) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). The steady pass (D-024, D-025: novel queries on a disjoint sample) is reported, not judged. Verdict: **pass**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 57/60 (95.0%) | 0.942 | 2 | 270.8 | 1399.8 | legacy |
| work_item | bm25 | 59/60 (98.3%) | 0.925 | 0 | 120.1 | 335.7 | bm25 |
| session_turn | legacy | 47/60 (78.3%) | 0.745 | 4 | 1170.5 | 7734.8 | legacy |
| session_turn | bm25 | 49/60 (81.7%) | 0.746 | 0 | 247 | 761.6 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 57 | 2 | 0 | 1 | pass |
| session_turn | 46 | 3 | 1 | 10 | pass |

- work_item: BM25 recall@10 59/60 >= legacy 57/60; latency pass: BM25-arm p95 335.7 ms <= legacy p95 1399.8 ms; warm-repeat BM25 p95 122.9 ms <= the 200 ms ceiling; cold paired BM25 p95 335.7 ms <= the 1000 ms cold ceiling (D-029)
- session_turn: BM25 recall@10 49/60 >= legacy 47/60; latency pass: BM25-arm p95 761.6 ms <= legacy p95 7734.8 ms; warm-repeat BM25 p95 268 ms <= the 400 ms ceiling; cold paired BM25 p95 761.6 ms <= the 1200 ms cold ceiling (D-029)

## Warm-repeat pass (D-028) and the reported passes

Repeats with block reads is an upper bound from pg_stat_statements deltas (peers running the same statement also count).

| source | warm repeats | warm p50 ms | warm p95 ms | repeats with block reads | ceiling ms | cold paired BM25 p95 ms | cold ceiling ms | steady p95 ms | R-18 |
|---|---|---|---|---|---|---|---|---|
| work_item | 60 | 71.6 | 122.9 | 60 | 200 | 335.7 | 1000 | 111.6 | pass |
| session_turn | 60 | 96.8 | 268 | 60 | 400 | 761.6 | 1200 | 345.8 | pass |

- work_item before warm-up: 2026-10-11T19:58:32.739Z: loadavg 342.44 353.51 343.79 253/85672 2428819; io some avg10=4.62 avg60=10.60 avg300=12.44 total=122687243227; cpu some avg10=32.04 avg60=31.03 avg300=31.01 total=14923671417; active backends 28
- work_item after steady pass: 2026-10-11T19:58:50.129Z: loadavg 322.36 348.52 342.37 184/85408 2452405; io some avg10=2.18 avg60=8.34 avg300=11.80 total=122687638606; cpu some avg10=33.91 avg60=31.82 avg300=31.19 total=14929646027; active backends 22
- session_turn before warm-up: 2026-10-11T19:58:50.133Z: loadavg 322.36 348.52 342.37 150/85394 2452421; io some avg10=2.18 avg60=8.34 avg300=11.80 total=122687638711; cpu some avg10=33.91 avg60=31.82 avg300=31.19 total=14929646960; active backends 23
- session_turn after steady pass: 2026-10-11T19:59:23.453Z: loadavg 312.72 343.90 341.04 197/85611 2495577; io some avg10=3.43 avg60=6.09 avg300=10.86 total=122688737221; cpu some avg10=30.76 avg60=31.61 avg300=31.22 total=14940253098; active backends 19

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 43 | 1513.1 | 9182 | 16% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 62 | 708.5 | 11849 | 31% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| paired | 143 | 278 | 61041 | 125% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 131 | 144.7 | 3571 | 17% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| paired | 93 | 124.5 | 23216 | 64% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| paired | 93 | 103 | 5418 | 88% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| paired | 93 | 59.5 | 3989 | 63% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| paired | 1 | 66.3 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |
| steady work_item | 4 | 569.9 | 591 | 9% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady work_item | 63 | 18.9 | 1071 | 31% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady work_item | 10 | 17.2 | 146 | 21% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 2 | 52.9 | 0 | 0% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady work_item | 2 | 15.2 | 0 | 0% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady work_item | 2 | 6.7 | 0 | 0% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady work_item | 1 | 0.1 | 0 | 0% | `WITH live AS ( SELECT i.workspace_id, count(*)::int AS n FROM harness_shared.blueprint_operation_inv` |
| steady session_turn | 65 | 62.1 | 4861 | 24% | `WITH q AS (SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq) SELECT s.source_ki` |
| steady session_turn | 17 | 196.7 | 1384 | 19% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 65 | 51.1 | 4598 | 61% | `SELECT count(*)::int AS n FROM ( SELECT $1 FROM harness_shared.session_turns WHERE (workspace_id = $` |
| steady session_turn | 9 | 292.1 | 182 | 4% | `WITH q AS ( SELECT replace(plainto_tsquery($1, $2)::text, $3, $4)::tsquery AS orq, string_to_array(r` |
| steady session_turn | 57 | 24.6 | 49 | 2% | `WITH q AS ( SELECT plainto_tsquery($1, $2) AS andq ) SELECT source_kind, session_id, turn_idx, speak` |
| steady session_turn | 5 | 9.2 | 48 | 9% | `WITH q AS (SELECT replace(plainto_tsquery($7, $1)::text, $8, $9)::tsquery AS orq) SELECT s.issue_id,` |
| steady session_turn | 1 | 9.1 | 0 | 0% | `SELECT count(*)::int AS n FROM harness_shared.work_items WHERE taken_by = $1 AND workspace_id = $2 A` |
| steady session_turn | 1 | 8.1 | 0 | 0% | `SELECT * FROM ( SELECT $1 AS one, (left(coalesce(text, $2), $3)) <@> to_bm25query($4::text, $5) AS b` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 1383 |
| work_item | legacy | semantic:embeddings | 30 |
| work_item | bm25 | lexical:lexical | 265 |
| work_item | bm25 | semantic:embeddings | 38 |
| session_turn | legacy | lexical:lexical | 5443 |
| session_turn | legacy | semantic:embeddings | 55 |
| session_turn | bm25 | lexical:lexical | 691 |
| session_turn | bm25 | semantic:embeddings | 58 |

Host at start: 2026-10-11T19:54:31.739Z: loadavg 420.24 347.28 339.20 173/86299 2179624; io some avg10=18.92 avg60=17.53 avg300=11.42 total=122652629444; cpu some avg10=28.35 avg60=29.99 avg300=31.25 total=14848262594; active backends 44

Host at end: 2026-10-11T19:57:51.226Z: loadavg 411.17 365.22 346.95 134/85600 2381701; io some avg10=16.83 avg60=16.15 avg300=13.57 total=122685038267; cpu some avg10=27.98 avg60=30.18 avg300=30.88 total=14910202209; active backends 31
