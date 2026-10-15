# BM25 bake-off (2026-10-11T03:08:17.308Z)

Corpus: 9289 session turns · query = first 12 words (body = the remaining words) · 191 known-item queries per form · 18.6 (Debian 18.6-1.pgdg13+2)

| Query form | Arm | n | recall@1 | recall@10 (95% CI) | MRR@10 | p50 / p95 ms | errors |
|---|---|---|---|---|---|---|---|
| 4 keywords | pgts: pg_textsearch 1.5.1 | 191 | 0.010 | 0.037 (0.018–0.074) | 0.018 | 5.7 / 14.7 | 0 |
| 4 keywords | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 191 | 0.005 | 0.010 (0.003–0.037) | 0.008 | 0.9 / 3.8 | 0 |
| Full title | pgts: pg_textsearch 1.5.1 | 191 | 0.021 | 0.099 (0.065–0.150) | 0.043 | 6.3 / 17.6 | 0 |
| Full title | tsv_and: today's lexical leg: tsvector + plainto_tsquery (AND) + ts_rank_cd | 191 | 0.005 | 0.005 (0.001–0.029) | 0.005 | 0.4 / 0.7 | 0 |

**D-001 verdict:** not evaluated
