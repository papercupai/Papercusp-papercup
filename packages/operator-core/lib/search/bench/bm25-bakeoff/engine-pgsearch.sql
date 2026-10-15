-- BM25 bake-off engine: ParadeDB pg_search 0.26.1, database bake_pgsearch.
-- REFERENCE ONLY: AGPL-3.0 rules it out for the desktop distribution (plan D-001).
-- Tokenizer: pdb.simple with English stemming. Query: ||| (match ANY query token,
-- tokenized with the field's tokenizer), ranked by pdb.score (Tantivy BM25).
\set ON_ERROR_STOP on
CREATE EXTENSION vector;
CREATE EXTENSION pg_search;

SELECT timed('index_build:pgsearch',
  $q$CREATE INDEX docs_body_pgsearch ON docs USING bm25 (id, (body::pdb.simple('stemmer=english'))) WITH (key_field = 'id')$q$);

INSERT INTO sizes VALUES ('index:pgsearch', pg_total_relation_size('docs_body_pgsearch'));

CREATE FUNCTION search_pgsearch(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE ids text[]; BEGIN
  SELECT array_agg(id ORDER BY sc DESC, id) INTO ids FROM (
    SELECT id, pdb.score(id) AS sc
      FROM docs
     WHERE body ||| qtext
     ORDER BY pdb.score(id) DESC
     LIMIT 10) x;
  RETURN ids;
END $$;
