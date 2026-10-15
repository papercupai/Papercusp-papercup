-- BM25 bake-off engine: pg_textsearch 1.5.1 (Timescale, PostgreSQL licence), database
-- bake_pgts. Requires pg_textsearch in shared_preload_libraries. Default inline
-- compaction (its pg_durable dependency applies only to background compaction).
-- Analyzer: Postgres text search configuration 'english' (same stemming and stopwords as
-- today's tsvector leg). k1 = 1.2, b = 0.75 (defaults).
\set ON_ERROR_STOP on
CREATE EXTENSION pg_textsearch;

SELECT timed('index_build:pgts',
  $q$CREATE INDEX docs_body_bm25 ON docs USING bm25 (body) WITH (text_config = 'english')$q$);

INSERT INTO sizes VALUES ('index:pgts', pg_total_relation_size('docs_body_bm25'));

-- <@> returns NEGATIVE BM25 scores so an ascending index scan is best-first.
CREATE FUNCTION search_pgts(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE ids text[]; BEGIN
  SELECT array_agg(id ORDER BY s, id) INTO ids FROM (
    SELECT id, body <@> to_bm25query(qtext, 'docs_body_bm25') AS s
      FROM docs
     ORDER BY body <@> to_bm25query(qtext, 'docs_body_bm25')
     LIMIT 10) x;
  RETURN ids;
END $$;
