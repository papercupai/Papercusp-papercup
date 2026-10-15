# BM25 bake-off (2026-10-11T04:27:00.596Z)

Corpus: 81352 memory/corpus documents · query = title (body = text) · 1000 known-item queries per form · 18.6 (Debian 18.6-1.pgdg13+2)

| Query form | Arm | n | recall@1 | recall@10 (95% CI) | MRR@10 | p50 / p95 ms | errors |
|---|---|---|---|---|---|---|---|
| 4 keywords | pgts: pg_textsearch 1.5.1 | 1000 | 0.219 | 0.397 (0.367–0.428) | 0.279 | 9.2 / 25.0 | 0 |
| 4 keywords | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 1000 | 0.185 | 0.297 (0.269–0.326) | 0.223 | 1.5 / 39.7 | 0 |
| Full title | pgts: pg_textsearch 1.5.1 | 1000 | 0.311 | 0.486 (0.455–0.517) | 0.367 | 10.3 / 29.9 | 0 |
| Full title | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 1000 | 0.197 | 0.282 (0.255–0.311) | 0.228 | 1.4 / 26.8 | 0 |

**D-001 verdict:** not evaluated
