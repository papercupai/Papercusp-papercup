-- BM25 bake-off: load the frozen query set written by queries.sql.
\set ON_ERROR_STOP on
COPY q FROM '/data/q.csv' WITH (FORMAT csv);
