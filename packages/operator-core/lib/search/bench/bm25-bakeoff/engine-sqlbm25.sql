-- Pure-SQL BM25 bake-off arms, database bake_sql, run after engine-sql.sql (which adds
-- the stored tsvector `tsv` these read):
--   sqlbm25_tsv    Pure-SQL BM25 scored straight off the tsvector: OR-match candidates
--                  through the GIN index, term frequency = positions per lexeme.
--   sqlbm25_post   The same BM25 over a postings side-table (lexeme, id, tf, dl) with a
--                  covering btree index, i.e. how pure-SQL BM25 would actually ship.
-- Both variants use identical statistics and formula (Lucene IDF, k1 = 1.2, b = 0.75)
-- and break ties by id, so their rankings should agree; the CLI reports the agreement
-- rate as a self-check. Document length = positioned tokens after the english
-- configuration drops stopwords. tsvector keeps at most 256 positions per lexeme, which
-- caps tf at 256 (BM25 saturates long before that).
\set ON_ERROR_STOP on

CREATE FUNCTION bm25_doclen(t tsvector) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT coalesce(sum(coalesce(array_length(positions, 1), 1)), 0)::int FROM unnest(t) $$;

ALTER TABLE docs ADD COLUMN dl int;
SELECT timed('bm25_doclen', 'UPDATE docs SET dl = bm25_doclen(tsv)');
VACUUM ANALYZE docs;

CREATE TABLE bm25_stats AS SELECT count(*)::float8 AS n, avg(dl)::float8 AS avgdl FROM docs;
SELECT timed('bm25_df',
  $q$CREATE TABLE bm25_df AS
       SELECT word AS lexeme, ndoc,
              ln(1 + ((SELECT n FROM bm25_stats) - ndoc + 0.5) / (ndoc + 0.5)) AS idf
         FROM ts_stat('SELECT tsv FROM docs')$q$);
ALTER TABLE bm25_df ADD PRIMARY KEY (lexeme);

SELECT timed('bm25_postings',
  $q$CREATE TABLE bm25_postings AS
       SELECT u.lexeme, d.id, coalesce(array_length(u.positions, 1), 1) AS tf, d.dl
         FROM docs d, unnest(d.tsv) AS u$q$);
SELECT timed('index_build:bm25_postings',
  'CREATE INDEX bm25_postings_lexeme ON bm25_postings (lexeme) INCLUDE (id, tf, dl)');
VACUUM ANALYZE bm25_postings;
ANALYZE bm25_df;

INSERT INTO sizes VALUES
  ('table:bm25_df', pg_total_relation_size('bm25_df')),
  ('table:bm25_postings', pg_relation_size('bm25_postings')),
  ('index:bm25_postings', pg_relation_size('bm25_postings_lexeme'));

-- Distinct query lexemes under the same analyzer as the documents.
CREATE FUNCTION bm25_terms(qtext text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT coalesce(array_agg(DISTINCT lexeme), '{}') FROM unnest(to_tsvector('english', qtext)) $$;

-- OR tsquery built from already-normalized lexemes, escaped for tsquery input (quote,
-- double embedded quotes, escape backslashes) so the cast does not re-parse them.
CREATE FUNCTION bm25_or_query(terms text[]) RETURNS tsquery LANGUAGE sql IMMUTABLE AS
$$ SELECT string_agg('''' || replace(replace(t, E'\\', E'\\\\'), '''', '''''') || '''', ' | ')::tsquery
     FROM unnest(terms) AS t $$;

CREATE FUNCTION search_sqlbm25_tsv(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE terms text[] := bm25_terms(qtext); tq tsquery; ids text[]; BEGIN
  IF cardinality(terms) = 0 THEN RETURN NULL; END IF;
  tq := bm25_or_query(terms);
  SELECT array_agg(id ORDER BY score DESC, id) INTO ids FROM (
    SELECT d.id,
           sum(f.idf * (u.tf * 2.2) / (u.tf + 1.2 * (0.25 + 0.75 * d.dl / s.avgdl))) AS score
      FROM docs d
      CROSS JOIN bm25_stats s
      CROSS JOIN LATERAL (
        SELECT x.lexeme, coalesce(array_length(x.positions, 1), 1)::float8 AS tf
          FROM unnest(d.tsv) AS x WHERE x.lexeme = ANY (terms)) u
      JOIN bm25_df f ON f.lexeme = u.lexeme
     WHERE d.tsv @@ tq
     GROUP BY d.id
     ORDER BY score DESC, d.id
     LIMIT 10) r;
  RETURN ids;
END $$;

CREATE FUNCTION search_sqlbm25_post(qtext text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE terms text[] := bm25_terms(qtext); ids text[]; BEGIN
  IF cardinality(terms) = 0 THEN RETURN NULL; END IF;
  SELECT array_agg(id ORDER BY score DESC, id) INTO ids FROM (
    SELECT p.id,
           sum(f.idf * (p.tf::float8 * 2.2) / (p.tf + 1.2 * (0.25 + 0.75 * p.dl / s.avgdl))) AS score
      FROM bm25_postings p
      JOIN bm25_df f ON f.lexeme = p.lexeme
      CROSS JOIN bm25_stats s
     WHERE p.lexeme = ANY (terms)
     GROUP BY p.id
     ORDER BY score DESC, p.id
     LIMIT 10) r;
  RETURN ids;
END $$;
