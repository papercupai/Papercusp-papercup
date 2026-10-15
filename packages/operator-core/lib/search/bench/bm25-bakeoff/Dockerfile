# BM25 engine bake-off image (WI-10008294, plan bm25-lexical-search-evoke-adoption-2026-10-10 P-001).
#
# One throwaway Postgres 18 with every candidate engine installed. Each engine is
# created in its OWN database by bm25-bakeoff-cli.ts, because pg_textsearch and
# ParadeDB pg_search both register an index access method named `bm25`.
#
#   - Evoke 0.2.5 (Apache-2.0): the base image.
#   - pg_textsearch 1.5.1 (Timescale, PostgreSQL licence).
#   - ParadeDB pg_search 0.26.1 (AGPL-3.0): REFERENCE ONLY, never shipped. It
#     requires pgvector. ParadeDB publishes bookworm/noble debs only; the Evoke
#     image is Debian 13 (trixie), so the bookworm build is used.
#
# Never point anything built from this image at the live papercusp database.
FROM ghcr.io/intelligent-internet/evoke:pg18-v0.2.5

ADD https://github.com/timescale/pg_textsearch/releases/download/v1.5.1/pg-textsearch-v1.5.1-pg18-amd64.zip /tmp/pkgs/pgts.zip
ADD https://github.com/paradedb/paradedb/releases/download/v0.26.1/postgresql-18-pg-search_0.26.1-1PARADEDB-bookworm_amd64.deb /tmp/pkgs/pgsearch.deb

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip postgresql-18-pgvector; \
    unzip -q /tmp/pkgs/pgts.zip -d /tmp/pkgs/pgts; \
    apt-get install -y --no-install-recommends /tmp/pkgs/pgts/*.deb /tmp/pkgs/pgsearch.deb; \
    ls /usr/share/postgresql/18/extension | grep -E '^(evoke|pg_textsearch|pg_search|vector)\.control$'; \
    rm -rf /var/lib/apt/lists/* /tmp/pkgs
