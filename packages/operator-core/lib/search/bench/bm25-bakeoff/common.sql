-- BM25 bake-off, shared per-database harness (WI-10008294). Runs INSIDE the throwaway
-- container only, once per engine database, before that engine's setup file.
--
-- Loads the corpus copy, loads the frozen query set, and defines the chunked evaluator.
-- Every engine file must define  search_<method>(qtext text) RETURNS text[]  returning
-- at most 10 ids, best first.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

CREATE TABLE timings (step text PRIMARY KEY, ms numeric NOT NULL);
CREATE TABLE sizes (object text PRIMARY KEY, bytes bigint NOT NULL);

-- md5 is a generated column so the table's physical layout is exactly the COPY order.
CREATE TABLE docs (
  id    text PRIMARY KEY,
  title text NOT NULL,
  body  text NOT NULL,
  md5   text GENERATED ALWAYS AS (md5(body)) STORED
);

DO $$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
  COPY docs (id, title, body) FROM '/data/wi.csv' WITH (FORMAT csv);
  INSERT INTO timings VALUES ('load_csv', extract(epoch FROM clock_timestamp() - t0) * 1000);
END $$;
CREATE INDEX docs_md5 ON docs (md5);
VACUUM ANALYZE docs;

-- The query set is built ONCE (bm25-bakeoff-cli.ts, in the first database) and frozen to
-- /data/q.csv, so every engine answers byte-identical queries.
CREATE TABLE q (target text PRIMARY KEY, tmd5 text NOT NULL, q_title text, q_short text);

CREATE TABLE res (
  method  text NOT NULL,
  variant text NOT NULL,
  target  text NOT NULL,
  rank    int,            -- 1-based rank of the target (or a byte-identical duplicate) in the top 10; NULL = miss
  ms      numeric NOT NULL,
  err     boolean NOT NULL,
  errmsg  text,
  PRIMARY KEY (method, variant, target)
);

-- Evaluate one chunk of queries. Commit happens per CALL (the CLI issues one psql call
-- per chunk), so progress is visible and a failure loses one chunk, not the run.
-- p_record = false is the discarded warm-up pass.
-- Queries run in a stable HASH order, never id order: a capped arm evaluates a prefix,
-- and an id-ordered prefix is the oldest items (run 2: pg_textsearch MRR@10 on the first
-- 200 by id was 0.650 vs 0.496 over all 1,000), which is not a fair sample.
CREATE FUNCTION run_eval_chunk(p_method text, p_variant text, p_limit int, p_offset int, p_record boolean)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  r record; qtext text; ids text[]; t0 timestamptz; elapsed numeric; rk int; failed boolean; msg text; n int := 0;
BEGIN
  FOR r IN SELECT * FROM q ORDER BY md5(target), target LIMIT p_limit OFFSET p_offset LOOP
    qtext := CASE p_variant WHEN 'title' THEN r.q_title WHEN 'short' THEN r.q_short END;
    CONTINUE WHEN qtext IS NULL OR btrim(qtext) = '';
    ids := NULL; failed := false; msg := NULL;
    t0 := clock_timestamp();
    BEGIN
      EXECUTE format('SELECT %I($1)', 'search_' || p_method) INTO ids USING qtext;
    EXCEPTION WHEN OTHERS THEN
      failed := true; msg := left(SQLSTATE || ' ' || SQLERRM, 300);
    END;
    elapsed := extract(epoch FROM clock_timestamp() - t0) * 1000;
    -- A hit is the target itself or any document with a byte-identical body.
    SELECT min(u.o) INTO rk
      FROM unnest(ids[1:10]) WITH ORDINALITY AS u(x, o)
      JOIN docs d ON d.id = u.x
     WHERE d.id = r.target OR d.md5 = r.tmd5;
    IF p_record THEN
      INSERT INTO res VALUES (p_method, p_variant, r.target, rk, elapsed, failed, msg)
      ON CONFLICT (method, variant, target) DO UPDATE
        SET rank = EXCLUDED.rank, ms = EXCLUDED.ms, err = EXCLUDED.err, errmsg = EXCLUDED.errmsg;
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Helper for engine files: time one DDL statement into `timings`.
CREATE FUNCTION timed(p_step text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz := clock_timestamp(); BEGIN
  EXECUTE p_sql;
  INSERT INTO timings VALUES (p_step, extract(epoch FROM clock_timestamp() - t0) * 1000)
  ON CONFLICT (step) DO UPDATE SET ms = EXCLUDED.ms;
END $$;
