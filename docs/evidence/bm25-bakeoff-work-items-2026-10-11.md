# BM25 bake-off (2026-10-11T11:27:55.979Z)

Corpus: 76856 work items · query = title (body = summary) · 1000 known-item queries per form · 18.6 (Debian 18.6-1.pgdg13+2)

| Query form | Arm | n | recall@1 | recall@10 (95% CI) | MRR@10 | p50 / p95 ms | errors |
|---|---|---|---|---|---|---|---|
| 4 keywords | pgts: pg_textsearch 1.5.1 | 1000 | 0.184 | 0.382 (0.352–0.413) | 0.239 | 2.2 / 4.3 | 0 |
| 4 keywords | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 1000 | 0.111 | 0.210 (0.186–0.236) | 0.139 | 0.7 / 6.4 | 0 |
| Full title | pgts: pg_textsearch 1.5.1 | 1000 | 0.410 | 0.689 (0.660–0.717) | 0.497 | 3.8 / 9.6 | 0 |
| Full title | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 1000 | 0.111 | 0.199 (0.175–0.225) | 0.135 | 0.9 / 3.5 | 0 |

**D-001 verdict:** not evaluated
