# BM25 hybrid recall A/B (R-13)

Plan bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-13. Generated 2026-10-11T16:05:16.942Z at commit 0bc680d68a382f0e7f58ae1b6f949b40852f96a9.
Both arms ran in one process on the identical sample (fingerprint `86395b8923abe4e8a286a2761a385e78942fb7790598304797911306e2b9d804`).
Recall is fused (RRF) recall@10 before any rerank. Verdict: **pass**.
Latency (R-18; D-019, D-020, D-021, D-024, D-025) is the p95 of the whole hybrid call with every timed query embedded before timing. On the paired cold pass the BM25 arm must not exceed legacy; the steady pass (untimed warm-up on a disjoint sample, then BM25-only over a third disjoint sample of novel queries) must stay under its source ceiling (work_item 200 ms, session_turn 400 ms). Verdict: **fail**.

| source | arm | recall@10 | MRR@10 | zero-hit | p50 ms | p95 ms | engine |
|---|---|---|---|---|---|---|---|
| work_item | legacy | 54/60 (90.0%) | 0.829 | 1 | 203.7 | 2508.2 | legacy |
| work_item | bm25 | 54/60 (90.0%) | 0.863 | 0 | 77.6 | 222.6 | bm25 |
| session_turn | legacy | 45/60 (75.0%) | 0.708 | 4 | 860.9 | 8054.3 | legacy |
| session_turn | bm25 | 48/60 (80.0%) | 0.777 | 0 | 183.1 | 675.7 | bm25 |

| source | both found | BM25 only | legacy only | neither | verdict |
|---|---|---|---|---|---|
| work_item | 52 | 2 | 2 | 4 | pass |
| session_turn | 44 | 4 | 1 | 11 | pass |

- work_item: BM25 recall@10 54/60 >= legacy 54/60; latency pass: paired BM25-arm p95 222.6 ms <= legacy p95 2508.2 ms; steady-pass BM25 p95 68.5 ms (60 novel queries, warm index) <= the 200 ms ceiling
- session_turn: BM25 recall@10 48/60 >= legacy 45/60; latency fail: steady-pass BM25 p95 1820.6 ms exceeds the 400 ms ceiling

## Steady pass (D-024, D-025)

| source | warm-up calls | steady calls | steady p50 ms | steady p95 ms | ceiling ms | cold paired BM25 p95 ms | R-18 |
|---|---|---|---|---|---|---|---|
| work_item | 60 | 60 | 46.4 | 68.5 | 200 | 222.6 | pass |
| session_turn | 60 | 60 | 187.4 | 1820.6 | 400 | 675.7 | fail |

- work_item before warm-up: 2026-10-11T16:04:28.166Z: loadavg 185.82 220.68 202.80 67/81355 4093440; io some avg10=26.88 avg60=24.85 avg300=25.31 total=120070831122; cpu some avg10=1.36 avg60=3.06 avg300=4.29 total=12966038719; active backends 16
- work_item after steady pass: 2026-10-11T16:04:35.838Z: loadavg 182.23 219.35 202.46 84/81978 4102813; io some avg10=21.40 avg60=23.98 avg300=25.11 total=120072251612; cpu some avg10=1.16 avg60=2.80 avg300=4.20 total=12966148090; active backends 17
- session_turn before warm-up: 2026-10-11T16:04:35.840Z: loadavg 182.23 219.35 202.46 84/81979 4102815; io some avg10=21.40 avg60=23.98 avg300=25.11 total=120072251890; cpu some avg10=1.16 avg60=2.80 avg300=4.20 total=12966148129; active backends 16
- session_turn after steady pass: 2026-10-11T16:05:12.015Z: loadavg 226.98 225.61 205.25 25/82591 4129600; io some avg10=47.85 avg60=33.64 avg300=27.35 total=120087986884; cpu some avg10=1.13 avg60=2.10 avg300=3.86 total=12966741345; active backends 17

## Lexical statements (pg_stat_statements deltas, slowest first)

Cluster-wide: a delta also counts concurrent calls of the same normalized statement by other sessions. Read share = time reading blocks not in shared buffers / execution time.

| pass | calls | mean ms | blocks read | read share | statement |
|---|---|---|---|---|---|
| paired | 35 | 1716.2 | 13897 | 15% | `WITH q AS (
        SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query       AS orq,
   ` |
| paired | 147 | 229.4 | 122237 | 148% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| paired | 78 | 349.4 | 9286 | 28% | `WITH q AS (
        SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query       AS orq,
   ` |
| paired | 139 | 125 | 6710 | 23% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| paired | 60 | 109 | 21268 | 59% | `WITH q AS (SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query AS orq)
      SELECT  . ou` |
| paired | 94 | 51.7 | 3897 | 58% | `SELECT count(*)::int AS n FROM (
            SELECT $1 FROM harne _ hared. e ion_turn 
             ` |
| paired | 60 | 63.2 | 4979 | 63% | `WITH q AS (SELECT replace(plainto_t query($7, $1)::text, $8, $9)::t query AS orq)
      SELECT  .i u` |
| paired | 1 | 1962.1 | 0 | 0% | `WITH 
    late t_ pine AS MATERIALIZED (
      SELECT DISTINCT ON ( a.work pace_id,  a.harne _ lug, ` |
| steady work_item | 60 | 18.5 | 1284 | 38% | `WITH q AS (SELECT replace(plainto_t query($7, $1)::text, $8, $9)::t query AS orq)
      SELECT  .i u` |
| steady work_item | 2 | 249.6 | 1667 | 202% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| steady work_item | 2 | 44.2 | 0 | 0% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| steady work_item | 2 | 14.5 | 0 | 0% | `WITH q AS (SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query AS orq)
      SELECT  . ou` |
| steady work_item | 1 | 26.1 | 0 | 0% | `WITH q AS (
        SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query       AS orq,
   ` |
| steady work_item | 2 | 12.8 | 0 | 0% | `WITH q AS (SELECT replace(plainto_t query($7, $1)::text, $8, $9)::t query AS orq)
      SELECT  .i u` |
| steady work_item | 2 | 10.9 | 0 | 0% | `SELECT count(*)::int AS n FROM (
            SELECT $1 FROM harne _ hared. e ion_turn 
             ` |
| steady session_turn | 63 | 72.3 | 3363 | 72% | `SELECT count(*)::int AS n FROM (
            SELECT $1 FROM harne _ hared. e ion_turn 
             ` |
| steady session_turn | 60 | 62.6 | 4156 | 37% | `WITH q AS (SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query AS orq)
      SELECT  . ou` |
| steady session_turn | 1 | 1529.1 | 0 | 0% | `WITH 
    late t_ pine AS MATERIALIZED (
      SELECT DISTINCT ON ( a.work pace_id,  a.harne _ lug, ` |
| steady session_turn | 7 | 169.8 | 150 | 14% | `WITH q AS (
        SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query       AS orq,
   ` |
| steady session_turn | 55 | 17.9 | 67 | 7% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| steady session_turn | 13 | 23.5 | 95 | 43% | `WITH q AS (
        SELECT plainto_t query($1, $2) AS andq
               
      )
      SELECT  our` |
| steady session_turn | 3 | 26.2 | 4 | 5% | `WITH q AS (SELECT replace(plainto_t query($1, $2)::text, $3, $4)::t query AS orq)
      SELECT  . ou` |
| steady session_turn | 3 | 13.7 | 0 | 0% | `WITH q AS (SELECT replace(plainto_t query($7, $1)::text, $8, $9)::t query AS orq)
      SELECT  .i u` |

## Where the time goes (attribution only; R-18 judges the whole call)

p95 of each leg's own duration, from the engine's `legs.*.sourceCalls[].durationMs`. Legs run concurrently, so they do not add up to the call.

| source | arm | leg | p95 ms |
|---|---|---|---|
| work_item | legacy | lexical:lexical | 2488 |
| work_item | legacy | semantic:embeddings | 11 |
| work_item | bm25 | lexical:lexical | 216 |
| work_item | bm25 | semantic:embeddings | 19 |
| session_turn | legacy | lexical:lexical | 5024 |
| session_turn | legacy | semantic:embeddings | 15 |
| session_turn | bm25 | lexical:lexical | 647 |
| session_turn | bm25 | semantic:embeddings | 25 |

Host at start: 2026-10-11T16:01:44.687Z: loadavg 274.42 237.39 202.93 59/81370 3923762; io some avg10=32.61 avg60=33.75 avg300=25.17 total=120027771184; cpu some avg10=1.33 avg60=3.33 avg300=4.96 total=12959524479; active backends 17

Host at end: 2026-10-11T16:04:28.164Z: loadavg 185.82 220.68 202.80 59/81355 4093440; io some avg10=26.88 avg60=24.85 avg300=25.31 total=120070830476; cpu some avg10=1.36 avg60=3.06 avg300=4.29 total=12966038669; active backends 14
