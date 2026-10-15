# Postgres 18 + pgvector + pg_textsearch 1.5.1, preloaded: the dedicated container the BM25
# integration tests run against (plan bm25-lexical-search-evoke-adoption-2026-10-10, D-003 §6).
# The shared integration container stays without pg_textsearch, so every other suite keeps
# exercising the legacy ts_rank fallback.
FROM pgvector/pgvector:pg18

ADD https://github.com/timescale/pg_textsearch/releases/download/v1.5.1/pg-textsearch-v1.5.1-pg18-amd64.zip /tmp/pgts.zip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip; \
    unzip -q /tmp/pgts.zip -d /tmp/pgts; \
    apt-get install -y --no-install-recommends /tmp/pgts/*.deb; \
    test -f /usr/share/postgresql/18/extension/pg_textsearch.control; \
    rm -rf /var/lib/apt/lists/* /tmp/pgts /tmp/pgts.zip

CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
