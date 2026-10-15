-- BM25 bake-off: build the frozen known-item query set ONCE (first database only) and
-- write it to /data/q.csv; every other database loads that file (load-queries.sql).
--   * 1,000 items sampled with TABLESAMPLE BERNOULLI(2) REPEATABLE(42), ordered by id.
--   * full-title form, and a 4-keyword form: the 4 longest distinct title words of more
--     than 3 characters (ties broken alphabetically).
-- The body is indexed WITHOUT the title, so the title is a fair known-item query.
\set ON_ERROR_STOP on
INSERT INTO q (target, tmd5, q_title, q_short)
SELECT d.id, d.md5, d.title,
       (SELECT string_agg(w, ' ' ORDER BY length(w) DESC, w) FROM (
          SELECT w FROM regexp_split_to_table(lower(d.title), '[^a-z0-9_]+') AS w
           WHERE length(w) > 3 GROUP BY w ORDER BY length(w) DESC, w LIMIT 4) s)
  FROM docs d TABLESAMPLE BERNOULLI (2) REPEATABLE (42)
 ORDER BY d.id
 LIMIT 1000;
COPY q TO '/data/q.csv' WITH (FORMAT csv);
