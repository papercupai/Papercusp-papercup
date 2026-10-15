-- BM25 bake-off baseline with NO extension, database bake_sql:
--   tsv_and        TODAY's lexical leg: stored to_tsvector('english', body) + GIN,
--                  plainto_tsquery (AND) + ts_rank_cd (no IDF).
-- The pure-SQL BM25 arms (sqlbm25_tsv, sqlbm25_post) build on this tsvector in
-- engine-sqlbm25.sql, which runs only when one of them is selected: their postings
-- side-table is the slowest setup step of the whole bench on a large corpus, and the
-- baseline does not need it (EI-25652941379953131).
\set ON_ERROR_STOP on

SELECT timed('tsv_column',
  $q$ALTER TABLE docs ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED$q$);
SELECT timed('index_build:tsv_gin', 'CREATE INDEX docs_tsv_gin ON docs USING gin (tsv)');
VACUUM ANALYZE docs;

INSERT INTO sizes VALUES
  ('index:tsv_gin', pg_relation_size('docs_tsv_gin')),
  ('column:tsv', (SELECT sum(pg_column_size(tsv)) FROM docs));

CREATE FUNCTION search_tsv_and(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE tq tsquery := plainto_tsquery('english', qtext); ids text[]; BEGIN
  SELECT array_agg(id ORDER BY rnk DESC, id) INTO ids FROM (
    SELECT id, ts_rank_cd(tsv, tq) AS rnk FROM docs WHERE tsv @@ tq ORDER BY rnk DESC LIMIT 10) s;
  RETURN ids;
END $$;
