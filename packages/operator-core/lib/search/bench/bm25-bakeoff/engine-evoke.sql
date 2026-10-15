-- BM25 bake-off engine: Evoke 0.2.5 (Apache-2.0), database bake_evoke.
-- Requires the server to run with shared_preload_libraries containing evoke and
-- evoke.shared_runtime_size set (the CLI starts the container that way). Without the
-- shared preload Evoke runs ~25x slower (WI-10008233).
--
-- Two indexes on the same column, both preloaded (auto_preload > 0):
--   evoke       Evoke's defaults: lowercase, NO stemming, no stopwords. This is the
--               configuration WI-10008233 measured.
--   evoke_stem  text_stem_english = true (Porter), the like-for-like comparison with the
--               stemming engines (tsvector english, pg_textsearch english, pg_search).
\set ON_ERROR_STOP on
CREATE EXTENSION evoke;

SELECT timed('index_build:evoke',
  $q$CREATE INDEX docs_body_evoke ON docs USING evoke (body) WITH (auto_preload = 10)$q$);
SELECT timed('index_build:evoke_stem',
  $q$CREATE INDEX docs_body_evoke_stem ON docs USING evoke (body) WITH (auto_preload = 10, text_stem_english = true)$q$);

INSERT INTO sizes VALUES
  ('index:evoke', pg_total_relation_size('docs_body_evoke')),
  ('index:evoke_stem', pg_total_relation_size('docs_body_evoke_stem'));

CREATE FUNCTION search_evoke(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE ids text[]; BEGIN
  SELECT array_agg(id ORDER BY score DESC, id) INTO ids FROM (
    SELECT d.id, hit.score
      FROM evoke_query('docs_body_evoke'::regclass, qtext, 10) AS hit
      JOIN docs d ON d.ctid = hit.ctid) s;
  RETURN ids;
END $$;

CREATE FUNCTION search_evoke_stem(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE ids text[]; BEGIN
  SELECT array_agg(id ORDER BY score DESC, id) INTO ids FROM (
    SELECT d.id, hit.score
      FROM evoke_query('docs_body_evoke_stem'::regclass, qtext, 10) AS hit
      JOIN docs d ON d.ctid = hit.ctid) s;
  RETURN ids;
END $$;
