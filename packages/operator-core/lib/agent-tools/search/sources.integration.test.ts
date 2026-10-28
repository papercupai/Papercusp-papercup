/**
 * GAP 10 — per-source SQL coverage + CROSS-WORKSPACE LEAK guard (testcontainer PG).
 *
 * `sources.ts` is the ONE place the real table/tsvector/cosine SQL, the scope
 * filter, and the source_id/scope/excerpt/rankers row-mapping live for all four
 * prose surfaces (escalations / brainstorm / turns / decisions). The engine
 * unit-tests run against fakes, so until now this SQL had ZERO coverage. This
 * suite runs the REAL `SEARCH_SOURCES` SQL against a real Postgres (pgvector),
 * seeding each surface in workspace **A** plus a query-matching **DECOY in
 * workspace B**, and asserts:
 *
 *   (a) SCOPE ISOLATION — a search scoped to workspace A returns ONLY A's rows.
 *       Critical for `turns`, which has NO workspace_id column and is scoped via
 *       a JOIN to operator_conversations.workspace_id. If B's prose leaks into an
 *       A-scoped search, that is a CROSS-WORKSPACE security bug.
 *   (b) harness_slug `scopeFilter` further narrows the ws-scoped sources.
 *   (c) source_id / scope / excerpt / rankers row-mapping (escalations &
 *       decisions use composite keys; turns carries no scope).
 *   (d) embedding ranker: cosine sim = 1 - (emb <=> qVec), nearest-first order.
 *
 * Schema note: rather than apply the full 000-baseline (heavy), we create just
 * the five tables this SQL touches with the exact columns + tsvector triggers
 * the production migrations define (059/061/063 + baseline column sets). The
 * tsvector columns are filled by the same trigger expressions production uses,
 * so `body_tsv @@ plainto_tsquery(...)` behaves identically.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { applyDisclosureLedgerForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES as DEFAULT_SEARCH_SOURCES, compactLiteralToken } from './sources';
import type { SearchSource, SearchSourceParams } from '@papercusp/search';
import { PROSE_SOURCE_BASELINES, PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';
import { assertSearchFieldFreshness } from '@papercusp/search-core';

describe('baseline inventory reconciles the actual registered prose adapters', () => {
  it('covers each runtime source exactly once, including non-vector sources', () => {
    const registered = DEFAULT_SEARCH_SOURCES.map(s => s.name).sort();
    const inventoried = PROSE_SOURCE_BASELINES.map(s => s.source).sort();
    expect(inventoried).toEqual(registered);
    expect(new Set(inventoried).size).toBe(inventoried.length);
    for (const source of DEFAULT_SEARCH_SOURCES) {
      const baseline = PROSE_SOURCE_BASELINES.find(b => b.source === source.name)!;
      expect(baseline.lexical, source.name).toBe(typeof source.lexical === 'function');
      expect(baseline.vector, source.name).toBe(typeof source.embedding === 'function');
    }
  });

  it('refuses currentness from a fresh envelope when canonical field or scope-epoch proof is absent', () => {
    for (const source of DEFAULT_SEARCH_SOURCES) {
      const boundaries = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(b => b.source === source.name);
      expect(boundaries.some(b => b.policy.fieldPath === 'excerpt'), source.name).toBe(true);
      for (const boundary of boundaries) {
        expect(boundary.evidenceStatus).toBe('unmeasured');
        expect(boundary.scopeEpochSource).toContain('trusted server');
        const result = assertSearchFieldFreshness(boundary.policy, {
          returned: { entityRef: `${source.name}:fixture`, fieldPath: boundary.policy.fieldPath, valueFingerprint: 'fresh-envelope-stale-value' },
          requestStartedAtMs: 1000, responseAtMs: 1000, canonical: null, indexed: null });
        expect(result.status, `${source.name}/${boundary.policy.fieldPath}`).not.toBe('current');
      }
    }
  });

});

// Reuse the semantic-parity suite's copy-out mutation seam for lexical guards.
// Unset, every assertion exercises the registered production sources.
let SEARCH_SOURCES = DEFAULT_SEARCH_SOURCES;

const WS_A = 'ws-A';
const WS_B = 'ws-B'; // the decoy workspace — its rows must NEVER appear in an A-scoped search
/** P-034 chunk-union fixture session (see seedChunks + its describe block). */
const CH_SESSION = 'sess-chunk';

const byName = (n: string): SearchSource => {
  const s = SEARCH_SOURCES.find((x) => x.name === n);
  if (!s) throw new Error(`source ${n} not registered`);
  return s;
};

/** All four sources define `embedding`; narrow the optional method for the test. */
type EmbeddingFn = NonNullable<SearchSource['embedding']>;
const embeddingOf = (n: string): EmbeddingFn => {
  const fn = byName(n).embedding;
  if (!fn) throw new Error(`source ${n} has no embedding ranker`);
  return fn;
};

/**
 * 384-d unit vectors built from a single "direction" angle so cosine order is
 * exactly predictable: v(θ) = [cos θ, sin θ, 0, 0, …]. Cosine sim between v(a)
 * and v(b) = cos(a−b), so a smaller |angle gap| ⇒ nearer ⇒ higher sim. The
 * query vector is v(0); a row at angle θ has sim = cos θ.
 */
function dirVec(theta: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
const Q_THETA = 0;
const QVEC = `[${dirVec(Q_THETA).join(',')}]`;
const vecLit = (theta: number): string => `[${dirVec(theta).join(',')}]`;

let db: FreshPgDb;
let sql: postgres.Sql;

/** Build exactly the columns + tsvector/embedding triggers the four sources read. */
async function setupSchema(s: postgres.Sql): Promise<void> {
  await s.unsafe('CREATE EXTENSION IF NOT EXISTS vector');

  // ── harness_escalations (059 tsv trigger, 061 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_escalations (
      harness_slug TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'staging',
      escalation TEXT,
      supervisor_notes TEXT,
      workspace_id TEXT NOT NULL DEFAULT '',
      body_tsv tsvector,
      body_embedding vector(384),
      body_embedding_mode TEXT DEFAULT 'gemma',
      body_embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      PRIMARY KEY (harness_slug, phase, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.he_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.body_tsv :=
        setweight(to_tsvector('english', coalesce(NEW.escalation, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.supervisor_notes, '')), 'B');
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER he_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_escalations
      FOR EACH ROW EXECUTE FUNCTION harness_shared.he_tsv();
  `);

  // ── harness_brainstorm (059 tsv trigger, 061 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_brainstorm (
      harness_slug TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'staging',
      content TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      content_tsv tsvector,
      content_embedding vector(384),
      content_embedding_mode TEXT DEFAULT 'gemma',
      content_embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      PRIMARY KEY (harness_slug, phase, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.hb_tsv() RETURNS trigger AS $$
    BEGIN NEW.content_tsv := to_tsvector('english', coalesce(NEW.content, '')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER hb_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_brainstorm
      FOR EACH ROW EXECUTE FUNCTION harness_shared.hb_tsv();
  `);

  // ── harness_decisions (063 tsv trigger, 063 embedding) ──
  await s.unsafe(`
    CREATE TABLE harness_shared.harness_decisions (
      harness_slug TEXT NOT NULL,
      line_hash TEXT NOT NULL,
      iso TEXT NOT NULL DEFAULT '',
      verb TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      body_tsv tsvector,
      body_embedding vector(384),
      body_embedding_mode TEXT DEFAULT 'gemma',
      body_embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      PRIMARY KEY (harness_slug, line_hash, workspace_id)
    );
    CREATE OR REPLACE FUNCTION harness_shared.hd_tsv() RETURNS trigger AS $$
    BEGIN NEW.body_tsv := to_tsvector('english', coalesce(NEW.verb,'') || ' ' || coalesce(NEW.args,'')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER hd_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.harness_decisions
      FOR EACH ROW EXECUTE FUNCTION harness_shared.hd_tsv();
  `);

  // ── operator_conversations + operator_turns. turns has NO workspace_id —
  //    it is scoped through the conversation JOIN. This is the leak surface. ──
  await s.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id TEXT NOT NULL DEFAULT '',
      started_at BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE harness_shared.operator_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT 0,
      text_tsv tsvector,
      text_embedding vector(384),
      text_embedding_mode TEXT DEFAULT 'gemma',
      text_embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1'
    );
    CREATE OR REPLACE FUNCTION harness_shared.ot_tsv() RETURNS trigger AS $$
    BEGIN NEW.text_tsv := to_tsvector('english', coalesce(NEW.text,'')); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER ot_tsv_trg BEFORE INSERT OR UPDATE ON harness_shared.operator_turns
      FOR EACH ROW EXECUTE FUNCTION harness_shared.ot_tsv();
  `);

  // ── engineer_issues (131 baseline: GENERATED _search) ──────────────────────
  // EI-6984: the `work_item` search source. Mirrors production's generated
  // tsvector expression exactly (title weight A / body weight B) so this test
  // exercises the real ranking behavior, not an approximation.
  //
  // P-005 / migration 776: `embedding` is on this relation now. In production
  // `engineer_issues` is a VIEW over `harness_shared.work_items` and the column
  // was always on the base table — 776 only made the view SELECT it. This fixture
  // is a flat table, so it carries the column directly; what it has to reproduce
  // faithfully is the SHAPE the source reads, which is the view's.
  //
  // P-009: `updated_at` likewise. Both work_item legs now project it as the hit's
  // `ts` so the corpus leg's recency re-rank can see a work-item at all — omit it
  // here and those legs fail on an undefined column, which is the standing
  // inline-CREATE-TABLE drift trap, not a bug in the source.
  //
  // observation-and-recall-surface-honesty P-003/P-004: `lane` likewise, and it is
  // the same trap for the same reason. Both legs project it into the hit's `meta`
  // bag so corpus recall can tell a curated work-item from an observation-lane row
  // (56.7% of this relation in production). NULLABLE with no default on purpose:
  // null IS the ordinary work/triage lane in production, so the fixture's default
  // row must be a work-item, and an observation must say so explicitly.
  await s.unsafe(`
    CREATE TABLE harness_shared.engineer_issues (
      workspace_id TEXT NOT NULL DEFAULT 'default',
      issue_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'operator',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'bug',
      severity TEXT NOT NULL DEFAULT 'minor',
      state TEXT NOT NULL DEFAULT 'open',
      -- Both nullable in production, and the legs read
      -- coalesce(updated_at, created_at) — so the fixture carries both, nullable,
      -- rather than a NOT NULL shape the real relation does not have.
      updated_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now(),
      lane TEXT,
      embedding public.vector(384),
      embedding_mode TEXT,
      embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      _search tsvector GENERATED ALWAYS AS (
        (setweight(to_tsvector('english', coalesce(title, '')), 'A')
         || setweight(to_tsvector('english', coalesce(body, '')), 'B'))
      ) STORED,
      -- generic-rag-chunking P-011: the view's name for the base table's
      -- harness_slug, the first half of the work_items chunk key. Production
      -- derives scope FROM it; the fixture derives it back from scope.
      base_harness_slug TEXT GENERATED ALWAYS AS (
        CASE WHEN scope LIKE 'harness:%' THEN substr(scope, 9) ELSE '' END
      ) STORED,
      PRIMARY KEY (workspace_id, issue_id)
    );
  `);

  // ── session_turns (501-session-turns.sql) ──
  // P-017: the `session_turn` source is one of the two the corpus injection leg
  // reads, and one of the two `lexicalSql` was applied to. `text_tsv` mirrors
  // production's GENERATED expression exactly, so the coverage/anchor SQL below
  // is exercised against real tsvector semantics, not an approximation.
  await s.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id  TEXT        NOT NULL DEFAULT 'default',
      source_kind   TEXT        NOT NULL,
      session_id    TEXT        NOT NULL,
      turn_idx      INTEGER     NOT NULL,
      ts            TIMESTAMPTZ,
      owner         TEXT,
      harness_slug  TEXT,
      cwd           TEXT,
      speaker       TEXT        NOT NULL,
      text          TEXT        NOT NULL,
      text_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      -- EI-23737056070911495: the simple-token tsvector column is deliberately
      -- ABSENT here. It is added only by migration 1163, which stays parked with
      -- a .DRAFT suffix and is therefore never applied, so the live schema lacks
      -- it and this fixture tracks the REAL schema. Re-add it (and its GIN index)
      -- only after migration 1163 is armed and applied.
      -- TWO TRAPS if you revisit this, both of which cost a gate red:
      --   1. Do NOT write that column name literally anywhere in this file, not
      --      even in a SQL comment. lint:migration-forward-compat strips JS
      --      line comments but NOT SQL comments inside a template literal, so a
      --      bare mention here is enough on its own to re-red the fleet gate.
      --   2. Do NOT use backticks in these SQL comments. They sit inside a JS
      --      template literal, so a backtick terminates it and the file fails to
      --      parse (TS1005) well away from the line you actually edited.
      ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      text_embedding public.vector(384),
      text_embedding_mode TEXT,
      text_embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      -- Migration 794 (plan owner-visibility-provenance P-004): provenance
      -- stamped at ingest. Present here because this fixture tracks the real
      -- schema — session-ingest's INSERT names these columns, so a fixture
      -- without them reds on an unrelated agent hours later
      -- (EI-19359711978838614).
      turn_origin TEXT,
      turn_origin_verdict TEXT,
      turn_origin_classifier_version INTEGER,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    );
  `);

  // ── session_turn_chunks (749-session-turn-chunks.sql) ──
  // P-034 / D-016: per-chunk vectors for turns longer than the parent's
  // `left(text, 2000)` embed cut. The `session_turn` embedding leg unions these
  // back to their parent turn by MAX score, which is what the suite below pins.
  await s.unsafe(`
    CREATE TABLE harness_shared.session_turn_chunks (
      workspace_id TEXT    NOT NULL DEFAULT 'default',
      source_kind  TEXT    NOT NULL,
      session_id   TEXT    NOT NULL,
      turn_idx     INTEGER NOT NULL,
      chunk_idx    INTEGER NOT NULL,
      content      TEXT    NOT NULL,
      turn_sha     TEXT    NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      embedding      public.vector(384),
      embedding_mode TEXT,
      embedding_profile TEXT DEFAULT 'gemma-embeddinggemma-300m-768@v1',
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx, chunk_idx),
      FOREIGN KEY (workspace_id, source_kind, session_id, turn_idx)
        REFERENCES harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx)
        ON DELETE CASCADE
    );
  `);

  // ── text_chunks (1242-text-chunks.sql): the shared chunk store the registry
  //    collections write (generic-rag-chunking P-010 reads it for turns). ──
  await s.unsafe(`
    CREATE TABLE harness_shared.text_chunks (
      surface           TEXT    NOT NULL,
      parent_key        TEXT[]  NOT NULL,
      chunk_idx         INTEGER NOT NULL,
      anchor            TEXT,
      header            TEXT,
      content           TEXT    NOT NULL,
      parent_sha        TEXT    NOT NULL,
      chunk_sha         TEXT    NOT NULL,
      splitter_version  TEXT    NOT NULL,
      embedding         public.vector(384),
      embedding_mode    TEXT,
      embedding_profile TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (surface, parent_key, chunk_idx)
    );
  `);

  // ── coord_event_log (501 coord_message search leg) ───────────────────────
  // The coord-message source has no transcript session key. Keep a real
  // matching row in this fixture so its explicit-session fail-closed guard is
  // non-vacuous: an unfiltered query can find the row, while a session-scoped
  // query must not broaden into this corpus.
  await s.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      surface TEXT NOT NULL,
      writer_key TEXT,
      msg_id TEXT NOT NULL,
      body JSONB NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      harness_slug TEXT
    );
    CREATE INDEX coord_event_log_msg_tsv_idx
      ON harness_shared.coord_event_log
      USING gin (to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000)))
      WHERE surface = 'messages';
  `);
}

/**
 * Seed every surface in workspace A AND a query-matching DECOY in workspace B.
 * All rows share the matchable token "kubernetes" so a bm25/embedding query
 * would surface BOTH workspaces' rows if the scope filter were missing — the
 * decoy is the leak tripwire.
 */
async function seed(s: postgres.Sql): Promise<{ convA: string; convB: string }> {
  // escalations: A (two harnesses) + B decoy
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('sheets', 'staging', 'kubernetes scaling escalation', 'reviewed by lead', ${WS_A}, ${vecLit(0.1)}::vector)`;
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('docs', 'staging', 'kubernetes networking escalation', 'pending', ${WS_A}, ${vecLit(0.9)}::vector)`;
  await s`INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, supervisor_notes, workspace_id, body_embedding)
          VALUES ('decoy', 'staging', 'kubernetes secret from another workspace', 'leak', ${WS_B}, ${vecLit(0.01)}::vector)`;

  // brainstorm
  await s`INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, workspace_id, content_embedding)
          VALUES ('sheets', 'staging', 'brainstorm about kubernetes autoscaling', ${WS_A}, ${vecLit(0.2)}::vector)`;
  await s`INSERT INTO harness_shared.harness_brainstorm (harness_slug, phase, content, workspace_id, content_embedding)
          VALUES ('decoy', 'staging', 'kubernetes brainstorm in another workspace', ${WS_B}, ${vecLit(0.02)}::vector)`;

  // decisions
  await s`INSERT INTO harness_shared.harness_decisions (harness_slug, line_hash, iso, verb, args, workspace_id, body_embedding)
          VALUES ('sheets', 'h1', '2026-01-01', 'ADOPT', 'kubernetes for orchestration', ${WS_A}, ${vecLit(0.15)}::vector)`;
  await s`INSERT INTO harness_shared.harness_decisions (harness_slug, line_hash, iso, verb, args, workspace_id, body_embedding)
          VALUES ('decoy', 'h9', '2026-01-02', 'LEAK', 'kubernetes decision in another workspace', ${WS_B}, ${vecLit(0.03)}::vector)`;

  // turns — via conversations in A and B (the no-workspace_id-column surface)
  const [{ id: convA }] = await s<Array<{ id: string }>>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_A}, 1) RETURNING id`;
  const [{ id: convB }] = await s<Array<{ id: string }>>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_B}, 2) RETURNING id`;
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convA}, 0, 'user', 'we should run kubernetes for this', ${vecLit(0.25)}::vector)`;
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convA}, 1, 'assistant', 'kubernetes is a good fit here', ${vecLit(0.5)}::vector)`;
  // THE DECOY: a B-workspace turn with the SAME matchable token. Must never leak.
  await s`INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
          VALUES (${convB}, 0, 'user', 'kubernetes secret discussion in another workspace', ${vecLit(0.04)}::vector)`;

  // coord_message — matching A row plus a B decoy for the source-level scope
  // and explicit-session tests below.
  await s`INSERT INTO harness_shared.coord_event_log
            (workspace_id, surface, msg_id, body, ts, harness_slug)
          VALUES (${WS_A}, 'messages', 'coord-A',
                  json_build_object('from', 'agent-a', 'kind', 'message', 'summary', 'kubernetes coordination note', 'body', 'shared coordination context'),
                  '2026-01-01T00:04:00Z', 'sheets')`;
  await s`INSERT INTO harness_shared.coord_event_log
            (workspace_id, surface, msg_id, body, ts, harness_slug)
          VALUES (${WS_B}, 'messages', 'coord-B',
                  json_build_object('from', 'agent-b', 'kind', 'message', 'summary', 'kubernetes coordination decoy', 'body', 'another workspace'),
                  '2026-01-01T00:04:00Z', 'decoy')`;

  // engineer_issues (EI-6984's work_item source): A (two harness scopes) + B decoy.
  //
  // P-005 vector layout. Query is v(0), so sim = cos θ and a SMALLER θ is nearer:
  //   EI-3  θ=0.05  nearest — and its text contains NO query term, so the LEXICAL
  //                 leg cannot return it at all. That is the falsifiable control:
  //                 an "embedding" leg that quietly ranked by text could never put
  //                 EI-3 first, and could never return it.
  //   EI-2  θ=0.10
  //   EI-1  θ=0.90  farthest of the workspace-A rows
  //   EI-4  NULL    embedded-less row; must be absent from the embedding leg while
  //                 still reachable lexically.
  //   EI-9  θ=0.02  workspace B — nearer than EVERY A row, so a workspace leak
  //                 surfaces as the FIRST hit rather than a subtle one.
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity, embedding, embedding_mode)
          VALUES (${WS_A}, 'EI-1', 'harness:sheets', 'kubernetes scaling bug', 'pods do not autoscale', 'bug', 'open', 'major', ${vecLit(0.9)}::vector, 'gemma')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity, embedding, embedding_mode)
          VALUES (${WS_A}, 'EI-2', 'harness:docs', 'kubernetes networking change', 'wants a service mesh', 'change', 'resolved', 'minor', ${vecLit(0.1)}::vector, 'gemma')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity, embedding, embedding_mode)
          VALUES (${WS_A}, 'EI-3', 'harness:sheets', 'container orchestration retry storm', 'no query term appears here', 'bug', 'open', 'minor', ${vecLit(0.05)}::vector, 'gemma')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity)
          VALUES (${WS_A}, 'EI-4', 'harness:sheets', 'cluster upgrade never embedded', 'lexically reachable, no vector', 'task', 'open', 'minor')`;
  await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity, embedding, embedding_mode)
          VALUES (${WS_B}, 'EI-9', 'harness:decoy', 'kubernetes secret issue from another workspace', 'leak', 'bug', 'open', 'critical', ${vecLit(0.02)}::vector, 'gemma')`;

  return { convA, convB };
}

/**
 * P-017 / D-062 fixture — the corpus injection leg's two sources under both
 * lexical modes.
 *
 * The query is five distinct lexemes (`corpus recall pointer section clamp`),
 * and the corpus is built so every property under test is DECIDABLE rather than
 * incidental:
 *
 *   * `clamp` is the strict argmin of document frequency (5 vs 7/7/7/8 across
 *     the whole table), so the rarest-lexeme ANCHOR is deterministic. Note the
 *     DF probe is deliberately UNFILTERED — it counts the workspace-B decoy too
 *     — which is why that decoy is also a scope tripwire below.
 *   * `T_FOUR` matches four of five and CONTAINS the anchor: it is the document
 *     the AND query discards outright and coverage-graded retrieval recovers.
 *   * `T_TRAP` is the `ts_rank_cd` trap in miniature — one anchor occurrence
 *     plus a common term repeated 80×, so it outranks a short all-terms
 *     document on frequency alone. Coverage-first ordering must bury it. The
 *     test asserts BOTH halves (higher rank, lower position), so it cannot pass
 *     by accident on a fixture where the trap never fired.
 *   * `N1..N4` match up to four terms but LACK the anchor. Their absence from
 *     the graded result is the anchor's cost, asserted deliberately: it is what
 *     bounds the candidate set (23,011 → 1,669 on the real table), and it can
 *     never drop an AND hit, since every AND hit necessarily matches the anchor.
 */
const P17_QUERY = 'corpus recall pointer section clamp';
const P17_SESSION = 'sess-p017';
const stId = (turnIdx: number): string => `claude:${P17_SESSION}:${turnIdx}`;

const T_ALL_A = stId(1);
const T_ALL_B = stId(2);
const T_FOUR = stId(3);
const T_TRAP = stId(4);
const T_DECOY_B = stId(20);
const COMPACT_QUERY = 'furnishedfinder';
const COMPACT_SESSION = 'sess-compact-token';
const COMPACT_DECOY_SESSION = 'sess-compact-token-decoy';
const COMPACT_ID = `codex:${COMPACT_SESSION}:1`;
const COMPACT_DECOY_ID = `codex:${COMPACT_DECOY_SESSION}:1`;

async function seedP17(s: postgres.Sql): Promise<void> {
  const turn = async (
    ws: string,
    idx: number,
    text: string,
  ): Promise<void> => {
    await s`INSERT INTO harness_shared.session_turns
              (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
            VALUES (${ws}, 'claude', ${P17_SESSION}, ${idx}, 'assistant', ${text},
                    ${`2026-08-03T00:00:${String(idx).padStart(2, '0')}Z`})`;
  };

  // 5 of 5 — the only documents the AND query can return.
  await turn(WS_A, 1, 'corpus recall pointer section clamp');
  await turn(WS_A, 2, 'the clamp applies once the corpus recall pointer section is built');
  // 4 of 5, WITH the anchor, WITHOUT `section` — recovered only by grading.
  await turn(WS_A, 3, 'corpus recall pointer clamp, discussed without the fifth term');
  // 2 of 5, anchor present, one common term repeated — the ts_rank_cd trap.
  await turn(WS_A, 4, `clamp ${'section '.repeat(80)}`);
  // Noise: up to 4 of 5 but NO anchor. Raises the common lexemes' DF above
  // `clamp`'s, and is excluded from the graded result by the anchor filter.
  await turn(WS_A, 10, 'corpus recall pointer section noise one');
  await turn(WS_A, 11, 'corpus recall section noise two');
  await turn(WS_A, 12, 'corpus pointer section noise three');
  await turn(WS_A, 13, 'recall pointer section noise four');
  // THE DECOY: all five terms, workspace B. Counted by the unfiltered DF probe,
  // but must never surface in an A-scoped result under EITHER mode.
  await turn(WS_B, 20, 'corpus recall pointer section clamp in another workspace');

  // engineer_issues — the OTHER source `lexicalSql` was applied to. Same shape:
  // `clamp` rarest (3) vs corpus/recall/pointer 4 and section 5.
  const issue = async (ws: string, id: string, title: string, body: string): Promise<void> => {
    await s`INSERT INTO harness_shared.engineer_issues
              (workspace_id, issue_id, scope, title, body, kind, state, severity)
            VALUES (${ws}, ${id}, 'harness:sheets', ${title}, ${body}, 'task', 'open', 'minor')`;
  };
  await issue(WS_A, 'EI-C1', 'corpus recall pointer', 'section clamp all five terms');
  await issue(WS_A, 'EI-C2', 'corpus recall pointer', 'clamp but not the fifth term');
  await issue(WS_A, 'EI-C3', 'clamp only', 'section only');
  await issue(WS_A, 'EI-N1', 'corpus recall', 'section noise, no anchor');
  await issue(WS_A, 'EI-N2', 'corpus pointer', 'section noise, no anchor');
  await issue(WS_A, 'EI-N3', 'recall pointer', 'section noise, no anchor');
  await issue(WS_B, 'EI-D9', 'corpus recall pointer', 'section clamp in another workspace');
}

/** EI-23237047797741772 fixture: the compact domain is present literally
 * inside a hostname token, so neither dictionary can match it as a word. */
async function seedCompactToken(s: postgres.Sql): Promise<void> {
  await s`INSERT INTO harness_shared.session_turns
            (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
          VALUES (${WS_A}, 'codex', ${COMPACT_SESSION}, 1, 'assistant',
                  '[Furnished Finder](https://www.furnishedfinder.com/rooms/123) — compact domain link.',
                  '2026-08-04T00:00:01Z')`;
  await s`INSERT INTO harness_shared.session_turns
            (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
          VALUES (${WS_B}, 'codex', ${COMPACT_DECOY_SESSION}, 1, 'assistant',
                  '[Furnished Finder](https://www.furnishedfinder.com/rooms/decoy) — compact domain decoy.',
                  '2026-08-04T00:00:02Z')`;
}

/**
 * P-034 fixture: one turn whose relevant content is PAST the parent embed cut
 * (far parent vector, near chunk), one ordinary short turn, and a workspace-B
 * decoy whose chunk sits exactly on the query. See the describe block for why
 * these specific angles make the suite self-falsifying.
 */
async function seedChunks(s: postgres.Sql): Promise<void> {
  const turn = async (ws: string, idx: number, speaker: string, theta: number): Promise<void> => {
    await s`INSERT INTO harness_shared.session_turns
              (workspace_id, source_kind, session_id, turn_idx, speaker, text, text_embedding)
            VALUES (${ws}, 'claude', ${CH_SESSION}, ${idx}, ${speaker},
                    ${'buried kubernetes detail '.repeat(20)}, ${vecLit(theta)}::vector)`;
  };
  const chunk = async (ws: string, idx: number, cIdx: number, theta: number): Promise<void> => {
    await s`INSERT INTO harness_shared.session_turn_chunks
              (workspace_id, source_kind, session_id, turn_idx, chunk_idx, content, turn_sha, embedding)
            VALUES (${ws}, 'claude', ${CH_SESSION}, ${idx}, ${cIdx}, 'buried chunk body',
                    'sha-fixture', ${vecLit(theta)}::vector)`;
  };

  // turn 1 — the CHUNKED case: parent far (θ=1.2), best chunk dead-on (θ=0.05).
  await turn(WS_A, 1, 'assistant', 1.2);
  await chunk(WS_A, 1, 0, 1.1);
  await chunk(WS_A, 1, 1, 0.9);
  await chunk(WS_A, 1, 2, 0.05);
  // turn 2 — the SHORT case: ordinary, no chunks, moderately near (θ=0.2).
  await turn(WS_A, 2, 'assistant', 0.2);
  // turn 3 — workspace B decoy with a chunk exactly ON the query.
  await turn(WS_B, 3, 'assistant', 1.4);
  await chunk(WS_B, 3, 0, 0);
  await s`UPDATE harness_shared.session_turns SET owner = 'decoy'
           WHERE workspace_id = ${WS_B} AND session_id = ${CH_SESSION}`;
}

/**
 * generic-rag-chunking P-010 (D-017): the `turns` embedding leg reads each
 * operator turn's window chunks from harness_shared.text_chunks (surface
 * 'operator_turns', parent key [id]), less the 0.06 chunk margin. Its own
 * workspace (WS_P010) so the WS_A/WS_B turn assertions above keep their counts.
 *   LONG  — own vector far (θ=1.2), one chunk near (θ=0.05)
 *   SHORT — own vector at θ=0.5, no chunks
 *   EDGE  — own vector far (θ=1.3); its chunk (θ=0.45) beats SHORT's vector by
 *           less than the margin, so it must rank BELOW SHORT
 *   DECOY — another workspace's turn, own vector far, chunk exactly on the query
 */
const WS_P010 = 'ws-p010';
const P010 = { long: '', short: '', edge: '', decoy: '' };

async function seedTurnChunks(s: postgres.Sql): Promise<void> {
  const [conv] = await s<{ id: string }[]>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_P010}, 3) RETURNING id`;
  const [convDecoy] = await s<{ id: string }[]>`
    INSERT INTO harness_shared.operator_conversations (workspace_id, started_at) VALUES (${WS_B}, 4) RETURNING id`;
  const turn = async (convId: string, seq: number, text: string, theta: number): Promise<string> => {
    const [row] = await s<{ id: string }[]>`
      INSERT INTO harness_shared.operator_turns (conversation_id, seq, role, text, text_embedding)
      VALUES (${convId}, ${seq}, 'assistant', ${text}, ${vecLit(theta)}::vector) RETURNING id`;
    return row!.id;
  };
  const chunk = async (turnId: string, idx: number, theta: number): Promise<void> => {
    await s`INSERT INTO harness_shared.text_chunks
              (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version,
               embedding, embedding_mode, embedding_profile)
            VALUES ('operator_turns', ${[turnId]}::text[], ${idx}, 'window text', 'sha', ${`${turnId}-${idx}`}, 'test',
                    ${vecLit(theta)}::vector, 'gemma', 'gemma-embeddinggemma-300m-768@v1')`;
  };
  P010.long = await turn(conv!.id, 0, `${'preamble '.repeat(250)} buried kubernetes answer`, 1.2);
  await chunk(P010.long, 0, 1.1);
  await chunk(P010.long, 1, 0.05);
  P010.short = await turn(conv!.id, 1, 'short kubernetes reply', 0.5);
  P010.edge = await turn(conv!.id, 2, `${'filler '.repeat(300)} edge`, 1.3);
  await chunk(P010.edge, 0, 0.45);
  // No query term in its text, so the WS_B lexical assertions above keep their count.
  P010.decoy = await turn(convDecoy!.id, 0, 'decoy chunked turn', 1.4);
  await chunk(P010.decoy, 0, 0);
}

/**
 * P-011 / D-015 fixture — work_item.embedding reads work-item chunks (margin 0).
 * The query is v(0), so sim = cos θ.
 *   LONG   own vector far (θ=1.2), window 1 on the query (θ=0.05): its only
 *          match lies past the 2,000-character cut
 *   SHORT  own vector θ=0.3, no chunks; under another harness scope
 *   DECOY  another workspace, SAME harness: own vector far, chunk exactly on
 *          the query — the chunk leg must filter it before its LIMIT
 */
const WS_P011 = 'ws-p011';
const WS_P011_DECOY = 'ws-p011-decoy';

async function seedWorkItemChunks(s: postgres.Sql): Promise<void> {
  const issue = async (ws: string, id: string, scope: string, theta: number): Promise<void> => {
    await s`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, kind, state, severity, embedding, embedding_mode)
            VALUES (${ws}, ${id}, ${scope}, ${`${id} title`}, 'body', 'bug', 'open', 'minor', ${vecLit(theta)}::vector, 'gemma')`;
  };
  const chunk = async (harness: string, id: string, idx: number, theta: number): Promise<void> => {
    await s`INSERT INTO harness_shared.text_chunks
              (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version,
               embedding, embedding_mode, embedding_profile)
            VALUES ('work_items', ${[harness, id]}::text[], ${idx}, 'window text', 'sha', ${`${id}-${idx}`}, 'test',
                    ${vecLit(theta)}::vector, 'gemma', 'gemma-embeddinggemma-300m-768@v1')`;
  };
  await issue(WS_P011, 'EI-P011-LONG', 'harness:sheets', 1.2);
  await chunk('sheets', 'EI-P011-LONG', 0, 1.1);
  await chunk('sheets', 'EI-P011-LONG', 1, 0.05);
  await issue(WS_P011, 'EI-P011-SHORT', 'harness:docs', 0.3);
  await issue(WS_P011_DECOY, 'EI-P011-DECOY', 'harness:sheets', 1.4);
  await chunk('sheets', 'EI-P011-DECOY', 0, 0);
}

const params = (over: Partial<SearchSourceParams> = {}): SearchSourceParams => ({
  sql,
  query: 'kubernetes',
  workspaceId: WS_A,
  scopeFilter: null,
  limit: 20,
  embeddingProfile: {
    profileId: 'gemma-embeddinggemma-300m-768@v1',
    legacyMode: 'gemma',
  },
  ...over,
});

beforeAll(async () => {
  const subject = process.env.PAPERCUSP_SOURCES_SUBJECT;
  if (subject) {
    const mod = (await import(subject)) as { SEARCH_SOURCES: typeof DEFAULT_SEARCH_SOURCES };
    SEARCH_SOURCES = mod.SEARCH_SOURCES;
  }
  db = await createFreshPgDb('search-sources');
  sql = db.sql;
  await setupSchema(sql);
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
  await seed(sql);
  await seedP17(sql);
  await seedCompactToken(sql);
  await seedChunks(sql);
  await seedTurnChunks(sql);
  await seedWorkItemChunks(sql);
}, 60_000);

describe('P-011 — work_item.embedding reads work-item chunks (D-015)', () => {
  const run = (over: Partial<SearchSourceParams> = {}) =>
    embeddingOf('work_item')({ ...params({ workspaceId: WS_P011, ...over }), qVec: QVEC });
  const ids = (out: Awaited<ReturnType<typeof run>>) => out.map((r) => r.row.source_id);

  it('an item whose only near match is a chunk past the cut ranks first, scored by that chunk', async () => {
    const out = await run();
    expect(ids(out)).toEqual(['EI-P011-LONG', 'EI-P011-SHORT']);
    expect(out[0]!.row.score).toBeCloseTo(Math.cos(0.05), 5);
    expect(out[0]!.key).toBe('work_item:EI-P011-LONG');
    expect(out[0]!.row.scope).toBe('harness:sheets');
  });

  it('SECURITY — the chunk leg is scoped by workspace: another workspace\'s on-query chunk never appears', async () => {
    expect(ids(await run())).not.toContain('EI-P011-DECOY');
    // The decoy's own workspace does see it, through its chunk.
    const decoy = await run({ workspaceId: WS_P011_DECOY });
    expect(ids(decoy)).toEqual(['EI-P011-DECOY']);
    expect(decoy[0]!.row.score).toBeCloseTo(1, 5);
  });

  it('the scope filter applies inside the chunk leg', async () => {
    expect(ids(await run({ scopeFilter: 'docs' }))).toEqual(['EI-P011-SHORT']);
    expect(ids(await run({ scopeFilter: 'sheets' }))).toEqual(['EI-P011-LONG']);
  });

  it('control: without its chunks, the long item falls below the item whose own vector is nearer', async () => {
    await sql`DELETE FROM harness_shared.text_chunks WHERE surface = 'work_items' AND parent_key = ${['sheets', 'EI-P011-LONG']}::text[]`;
    try {
      const out = await run();
      expect(ids(out)).toEqual(['EI-P011-SHORT', 'EI-P011-LONG']);
      expect(out[1]!.row.score).toBeCloseTo(Math.cos(1.2), 5);
    } finally {
      await seedChunkRows();
    }
  });

  // Restores LONG's chunks after the control drops them.
  async function seedChunkRows(): Promise<void> {
    for (const [idx, theta] of [[0, 1.1], [1, 0.05]] as const) {
      await sql`INSERT INTO harness_shared.text_chunks
                  (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version,
                   embedding, embedding_mode, embedding_profile)
                VALUES ('work_items', ${['sheets', 'EI-P011-LONG']}::text[], ${idx}, 'window text', 'sha', ${`EI-P011-LONG-${idx}`}, 'test',
                        ${vecLit(theta)}::vector, 'gemma', 'gemma-embeddinggemma-300m-768@v1')`;
    }
  }
});

describe('P-010 — turns.embedding reads operator-turn chunks (D-017)', () => {
  const run = () => embeddingOf('turns')({ ...params({ workspaceId: WS_P010 }), qVec: QVEC });
  const ids = (out: Awaited<ReturnType<typeof run>>) => out.map((r) => r.row.source_id);

  it('a turn whose only near match is a chunk past the cut ranks first, scored by that chunk less the margin', async () => {
    const out = await run();
    expect(ids(out)[0]).toBe(P010.long);
    expect(out[0]!.row.score).toBeCloseTo(Math.cos(0.05) - 0.06, 5);
    // One row per turn however many of its chunks matched.
    expect(ids(out).filter((id) => id === P010.long)).toHaveLength(1);
  });

  it('the 0.06 margin keeps a chunk that only just beats a turn\'s own vector below it', async () => {
    // Without the margin EDGE's chunk (cos 0.45 = .900) outranks SHORT's own vector (cos 0.5 = .878);
    // with it (.840) it does not.
    expect(Math.cos(0.45)).toBeGreaterThan(Math.cos(0.5));
    expect(Math.cos(0.45) - 0.06).toBeLessThan(Math.cos(0.5));
    const order = ids(await run());
    expect(order.indexOf(P010.short)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(P010.short)).toBeLessThan(order.indexOf(P010.edge));
  });

  it('SECURITY — the chunk leg is scoped through the conversation: another workspace\'s on-query chunk never appears', async () => {
    const out = await run();
    expect(ids(out)).not.toContain(P010.decoy);
    expect(ids(out).sort()).toEqual([P010.long, P010.short, P010.edge].sort());
  });

  it('a chunk embedded in another space is not read', async () => {
    const out = await embeddingOf('turns')({
      ...params({ workspaceId: WS_P010, embeddingProfile: { profileId: 'openai-text-embedding-3-small-768@v1', legacyMode: null } }),
      qVec: QVEC,
    });
    expect(out).toEqual([]);
  });
});

afterAll(async () => {
  await db?.cleanup();
});

/** P001: real registered SQL, independently read stored fields and scope changes.
 * This is a stored-row fixture, not ingestion, live authorization or index proof.
 */
describe('P001 — actual prose stored-field freshness witness', () => {
  const names = ['escalations', 'brainstorm', 'turns', 'decisions'] as const;
  type Name = typeof names[number];
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const receipts: unknown[] = [];
  const completed: string[] = [];
  const query = 'zephyrfreshness';
  const fields = ['excerpt', 'highlight'] as const;
  const unmark = (value: string) => value.replace(/<\/?mark>/g, '');

  async function fixture(name: Name, workspace: string, key: string, version: string) {
    const text = `${query} ${version} canonical body`;
    if (name === 'turns') {
      const [conversation] = await sql`INSERT INTO harness_shared.operator_conversations (workspace_id)
        VALUES (${workspace}) RETURNING id`;
      const [turn] = await sql`INSERT INTO harness_shared.operator_turns
        (conversation_id, role, text, text_embedding) VALUES (${conversation.id}, 'user', ${text}, ${QVEC}::vector) RETURNING id`;
      return { key: String(turn.id), conversation: String(conversation.id) };
    }
    if (name === 'escalations') await sql`INSERT INTO harness_shared.harness_escalations
      (workspace_id, harness_slug, escalation, supervisor_notes, body_embedding)
      VALUES (${workspace}, ${key}, ${text}, ${`${version} canonical notes`}, ${QVEC}::vector)`;
    if (name === 'brainstorm') await sql`INSERT INTO harness_shared.harness_brainstorm
      (workspace_id, harness_slug, content, content_embedding) VALUES (${workspace}, ${key}, ${text}, ${QVEC}::vector)`;
    if (name === 'decisions') await sql`INSERT INTO harness_shared.harness_decisions
      (workspace_id, harness_slug, line_hash, iso, verb, args, body_embedding)
      VALUES (${workspace}, ${key}, 'freshness', '2026-10-25', 'ADOPT', ${text}, ${QVEC}::vector)`;
    return { key, conversation: null };
  }

  type CanonicalRow = { workspace_id: string; revision: string; id: string; excerpt: string; highlight: string };
  async function canonical(name: Name, key: string) {
    // This oracle reads the base relations, never the source's returned fields.
    const rows = name === 'escalations' ? await sql<CanonicalRow[]>`SELECT workspace_id, xmin::text AS revision,
        harness_slug || ':' || phase AS id, escalation || E'\n' || supervisor_notes AS excerpt,
        escalation || E'\n' || supervisor_notes AS highlight FROM harness_shared.harness_escalations WHERE harness_slug = ${key}`
      : name === 'brainstorm' ? await sql<CanonicalRow[]>`SELECT workspace_id, xmin::text AS revision,
        harness_slug || ':' || phase AS id, content AS excerpt, content AS highlight
        FROM harness_shared.harness_brainstorm WHERE harness_slug = ${key}`
      : name === 'decisions' ? await sql<CanonicalRow[]>`SELECT workspace_id, xmin::text AS revision,
        harness_slug || ':' || line_hash AS id, '[' || iso || '] ' || verb || ' ' || args AS excerpt,
        verb || ' ' || args AS highlight FROM harness_shared.harness_decisions WHERE harness_slug = ${key}`
      : await sql<CanonicalRow[]>`SELECT c.workspace_id, t.xmin::text || ':' || c.xmin::text AS revision, t.id::text AS id,
        '[' || t.role || '] ' || t.text AS excerpt, '[' || t.role || '] ' || t.text AS highlight
        FROM harness_shared.operator_turns t JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
        WHERE t.id = ${key}::uuid`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error(`canonical oracle found no ${name} row for ${key}`);
    return { ...row, readAtMs: Date.now() };
  }

  async function mutate(name: Name, key: string) {
    const text = `${query} newwitness canonical body`;
    if (name === 'escalations') await sql`UPDATE harness_shared.harness_escalations
      SET escalation = ${text}, supervisor_notes = 'newwitness canonical notes' WHERE harness_slug = ${key}`;
    if (name === 'brainstorm') await sql`UPDATE harness_shared.harness_brainstorm SET content = ${text} WHERE harness_slug = ${key}`;
    if (name === 'decisions') await sql`UPDATE harness_shared.harness_decisions
      SET iso = '2026-10-26', verb = 'RETAIN', args = ${text} WHERE harness_slug = ${key}`;
    if (name === 'turns') await sql`UPDATE harness_shared.operator_turns SET role = 'assistant', text = ${text} WHERE id = ${key}::uuid`;
  }

  async function remove(name: Name, key: string) {
    if (name === 'escalations') await sql`DELETE FROM harness_shared.harness_escalations WHERE harness_slug = ${key}`;
    if (name === 'brainstorm') await sql`DELETE FROM harness_shared.harness_brainstorm WHERE harness_slug = ${key}`;
    if (name === 'decisions') await sql`DELETE FROM harness_shared.harness_decisions WHERE harness_slug = ${key}`;
    if (name === 'turns') await sql`DELETE FROM harness_shared.operator_turns WHERE id = ${key}::uuid`;
  }

  async function move(name: Name, key: string, workspace: string, conversation: string | null) {
    if (name === 'escalations') await sql`UPDATE harness_shared.harness_escalations SET workspace_id = ${workspace} WHERE harness_slug = ${key}`;
    if (name === 'brainstorm') await sql`UPDATE harness_shared.harness_brainstorm SET workspace_id = ${workspace} WHERE harness_slug = ${key}`;
    if (name === 'decisions') await sql`UPDATE harness_shared.harness_decisions SET workspace_id = ${workspace} WHERE harness_slug = ${key}`;
    if (name === 'turns') await sql`UPDATE harness_shared.operator_conversations SET workspace_id = ${workspace} WHERE id = ${conversation}::uuid`;
  }

  for (const name of names) for (const leg of ['lexical', 'embedding'] as const) {
    it(`${name}.${leg}: canonical values, update, candidate changes and workspace epoch`, async () => {
      const caseId = `${name}/${leg}`;
      const workspaceId = `p001-freshness-${name}-${leg}`;
      const target = await fixture(name, workspaceId, `${workspaceId}-target`, 'oldwitness');
      const foreign = await fixture(name, `${workspaceId}-foreign`, `${workspaceId}-decoy`, 'foreignwitness');
      const run = (workspace = workspaceId) => leg === 'lexical'
        ? byName(name).lexical(params({ workspaceId: workspace, query }))
        : embeddingOf(name)({ ...params({ workspaceId: workspace, query }), qVec: QVEC });
      const foreignId = (await canonical(name, foreign.key)).id;

      async function capture(phase: string, expectedKeys: string[]) {
        const requestStartedAtMs = Date.now();
        const before = await canonical(name, target.key);
        const results = await run();
        const responseAtMs = Date.now();
        const after = await canonical(name, target.key);
        expect(results.map(r => r.row.source_id).sort()).toEqual([...expectedKeys].sort());
        expect(results.map(r => r.row.source_id)).not.toContain(foreignId);
        expect(after.revision).toBe(before.revision);
        const returned = results.find(r => r.row.source_id === after.id)?.row;
        if (returned) for (const fieldPath of fields) {
          expect(unmark(String(returned[fieldPath]))).toBe(after[fieldPath]);
          const canonicalValue = fieldPath === 'highlight'
            ? String(after.highlight).replaceAll(query, `<mark>${query}</mark>`)
            : after.excerpt;
          expect(returned[fieldPath]).toBe(canonicalValue);
          const boundary = PROSE_FIELD_FRESHNESS_BOUNDARIES.find(b => b.source === name && b.policy.fieldPath === fieldPath)!;
          const input = { returned: { entityRef: `${name}:${after.id}`, fieldPath,
            valueFingerprint: digest(returned[fieldPath]) }, indexed: null,
            canonical: { entityRef: `${name}:${after.id}`, fieldPath, valueFingerprint: digest(canonicalValue),
              authority: boundary.policy.authority, authorityEpoch: digest({ workspaceId: after.workspace_id }),
              sourceRevision: String(after.revision), readAtMs: after.readAtMs }, requestStartedAtMs, responseAtMs };
          const oracle = assertSearchFieldFreshness(boundary.policy, input);
          expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
          expect(oracle.reasons).toContain('index witness unavailable');
          receipts.push({ caseId, phase, fieldPath, canonicalBefore: before, canonicalAfter: after,
            returned, input, oracle, expectedIds: expectedKeys, observedIds: results.map(r => r.row.source_id) });
        }
        if (!returned) receipts.push({ caseId, phase, canonicalBefore: before, canonicalAfter: after,
          expectedIds: expectedKeys, observedIds: results.map(r => r.row.source_id) });
        return after;
      }

      const initial = await canonical(name, target.key);
      await capture('stored-fields', [initial.id]);
      await mutate(name, target.key);
      const updated = await capture('content-update', [initial.id]);
      expect(updated.revision).not.toBe(initial.revision);
      expect(updated.excerpt).toContain('newwitness');
      expect(updated.excerpt).not.toContain('oldwitness');
      const added = await fixture(name, workspaceId, `${workspaceId}-added`, 'addedwitness');
      const addedId = (await canonical(name, added.key)).id;
      await capture('candidate-added', [initial.id, addedId]);
      await remove(name, added.key);
      await capture('candidate-removed', [initial.id]);
      await move(name, target.key, `${workspaceId}-revoked`, target.conversation);
      const moved = await capture('workspace-revoked', []);
      expect(moved.workspace_id).toBe(`${workspaceId}-revoked`);
      expect(moved.revision).not.toBe(updated.revision);
      expect((await run(`${workspaceId}-revoked`)).map(r => r.row.source_id)).toEqual([initial.id]);
      completed.push(caseId);
    });
  }

  afterAll(() => {
    if (!process.env.PAPERCUSP_PROSE_FRESHNESS_WITNESS_FILE) return;
    const expected = names.flatMap(name => ['lexical', 'embedding'].map(leg => `${name}/${leg}`));
    expect([...completed].sort()).toEqual(expected.sort());
    const paths = ['packages/operator-core/lib/agent-tools/search/sources.ts',
      'packages/operator-core/lib/agent-tools/search/sources.integration.test.ts',
      'packages/operator-core/lib/search/surface-registry.ts'];
    const pins = paths.map(path => ({ path, sha256: createHash('sha256')
      .update(readFileSync(new URL(`../../../../../${path}`, import.meta.url))).digest('hex') }));
    writeFileSync(process.env.PAPERCUSP_PROSE_FRESHNESS_WITNESS_FILE, JSON.stringify({ schemaVersion: 1,
      population: expected, completed, pins, receipts,
      limits: ['Stored-row fixture; production ingestion and current server authorization are unmeasured.',
        'No index witness: field currentness remains unknown.',
        'Covers four prose sources, not work_item/session_turn/coord_message/report/plan/doc.'] }, null, 2));
  });
});

/**
 * P-034 / D-016 — the chunk union on `session_turn.embedding`.
 *
 * THE DEFECT MODELLED HERE. A turn's own vector is built from `left(text,
 * 2000)`, so a turn whose relevant content sits PAST that cut has a parent
 * vector pointing nowhere near the query. `CHUNKED` below is exactly that
 * shape: parent at θ=1.2 (sim .362 — far), one chunk at θ=0.05 (sim .999 —
 * dead on). `SHORT` is a wholly ordinary turn at θ=0.2 (sim .980).
 *
 * That gives the suite a built-in falsifiable control: ranked by PARENT vectors
 * alone, SHORT (.980) beats CHUNKED (.362) and the buried content is
 * unretrievable — the status quo. If the union leg regresses to parent-only,
 * the ordering assertion below flips and fails. The test cannot pass for the
 * wrong reason.
 */
describe('P-034 — session_turn.embedding unions chunk vectors, deduped by MAX', () => {
  const chunkParams = (over: Partial<SearchSourceParams> = {}): SearchSourceParams =>
    params({ query: 'buried', filters: { sessionId: CH_SESSION }, ...over });
  const idsOf = (out: Awaited<ReturnType<EmbeddingFn>>): string[] =>
    out.map((r) => r.row.source_id);

  it('scores a turn by its BEST chunk, not by its own vector', async () => {
    const out = await embeddingOf('session_turn')({ ...chunkParams(), qVec: QVEC });
    const hit = out.find((r) => r.row.source_id === `claude:${CH_SESSION}:1`);
    expect(hit, 'the chunked turn must be retrievable at all').toBeDefined();
    // MAX over {parent cos(1.2)=.362, chunks cos(0.9)=.622, cos(0.05)=.9988}
    expect(hit!.score).toBeCloseTo(Math.cos(0.05), 3);
    // and emphatically NOT the parent's own score, which is what the
    // pre-P-034 leg would have returned.
    expect(hit!.score).not.toBeCloseTo(Math.cos(1.2), 3);
  });

  it('the buried turn now OUTRANKS an ordinary turn it used to lose to', async () => {
    const out = await embeddingOf('session_turn')({ ...chunkParams(), qVec: QVEC });
    const ids = idsOf(out);
    // Parent-only ordering would be [SHORT(.980), CHUNKED(.362)]. The union
    // inverts it — this assertion IS the regression guard for the whole change.
    expect(ids.indexOf(`claude:${CH_SESSION}:1`)).toBeLessThan(
      ids.indexOf(`claude:${CH_SESSION}:2`),
    );
  });

  it('emits each parent turn exactly ONCE however many chunks matched', async () => {
    const out = await embeddingOf('session_turn')({ ...chunkParams(), qVec: QVEC });
    const ids = idsOf(out);
    // turn 1 has three chunks, two of which score highly.
    expect(ids.filter((i) => i === `claude:${CH_SESSION}:1`)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a turn with no chunks is unaffected — still scored by its own vector', async () => {
    const out = await embeddingOf('session_turn')({ ...chunkParams(), qVec: QVEC });
    const hit = out.find((r) => r.row.source_id === `claude:${CH_SESSION}:2`);
    expect(hit!.score).toBeCloseTo(Math.cos(0.2), 3);
  });

  it('does NOT leak workspace B through the new chunk leg', async () => {
    // The decoy's CHUNK sits exactly on the query (θ=0), so it would top the
    // result set if the chunk leg's scope filter were missing or applied only
    // to the parent leg. This is the leak tripwire for the added SQL.
    const out = await embeddingOf('session_turn')({ ...chunkParams(), qVec: QVEC });
    expect(idsOf(out)).not.toContain(`claude:${CH_SESSION}:3`);
    expect(out.every((r) => r.row.excerpt.includes('decoy') === false)).toBe(true);
  });

  it('honours the filter bag on the chunk leg too (speaker)', async () => {
    // Filters live on the parent row, so the chunk leg must JOIN to apply them.
    // Without that join this returns the chunked turn anyway.
    const out = await embeddingOf('session_turn')({
      ...chunkParams({ filters: { sessionId: CH_SESSION, speaker: 'user' } }),
      qVec: QVEC,
    });
    expect(idsOf(out)).not.toContain(`claude:${CH_SESSION}:1`);
  });
});

describe('GAP 10 — per-source bm25 SQL: scope isolation + row mapping', () => {
  it('escalations.lexical: only workspace A; composite source_id `${slug}:${phase}`, scope=slug, rankers=[bm25]', async () => {
    const out = await byName('escalations').lexical(params());
    const ids = out.map((r) => r.row.source_id).sort();
    expect(ids).toEqual(['docs:staging', 'sheets:staging']);
    // No B/decoy row leaked in.
    expect(out.some((r) => r.row.source_id.startsWith('decoy'))).toBe(false);

    const sheets = out.find((r) => r.row.source_id === 'sheets:staging')!;
    expect(sheets.row.source).toBe('escalations');
    expect(sheets.row.scope).toBe('sheets');
    expect(sheets.row.rankers).toEqual(['lexical']);
    expect(sheets.row.excerpt).toContain('kubernetes scaling escalation');
    expect(sheets.row.excerpt).toContain('reviewed by lead'); // escalation + supervisor_notes joined
    expect(sheets.row.highlight).toContain('<mark>');
    expect(sheets.key).toBe('escalations:sheets:staging');
  });

  it('brainstorm.lexical: only A; source_id=`${slug}:${phase}`, scope=slug', async () => {
    const out = await byName('brainstorm').lexical(params());
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
    expect(out[0].row.scope).toBe('sheets');
    expect(out[0].row.source).toBe('brainstorm');
    expect(out[0].row.excerpt).toContain('kubernetes autoscaling');
  });

  it('decisions.lexical: only A; source_id=`${slug}:${line_hash}`, excerpt prefixed with [iso]', async () => {
    const out = await byName('decisions').lexical(params());
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:h1']);
    expect(out[0].row.scope).toBe('sheets');
    expect(out[0].row.excerpt).toBe('[2026-01-01] ADOPT kubernetes for orchestration');
    expect(out[0].key).toBe('decisions:sheets:h1');
  });

  it('SECURITY — turns.lexical: workspace A ONLY via the conversation JOIN; the B-workspace decoy turn does NOT leak', async () => {
    const out = await byName('turns').lexical(params());
    // Exactly the two A turns; NOT the B decoy.
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.row.source).toBe('turns');
      expect(r.row.scope).toBeUndefined(); // turns carries no scope (no harness_slug)
      expect(r.row.rankers).toEqual(['lexical']);
      // role-prefixed excerpt/highlight
      expect(r.row.excerpt).toMatch(/^\[(user|assistant)\] /);
      expect(r.row.highlight).toMatch(/^\[(user|assistant)\] /);
    }
    // The decoy's distinctive phrase must be absent from every excerpt.
    expect(out.some((r) => r.row.excerpt.includes('another workspace'))).toBe(false);
  });

  it('coord_message.lexical: unfiltered search returns the workspace-A row', async () => {
    const seeded = await sql<Array<{ msg_id: string; summary: string | null; body_text: string | null; matches: boolean }>>`
      SELECT msg_id, body->>'summary' AS summary, body->>'body' AS body_text,
             to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000))
               @@ plainto_tsquery('english', 'kubernetes') AS matches
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${WS_A} AND surface = 'messages'
    `;
    expect(seeded[0], JSON.stringify(seeded)).toMatchObject({
      msg_id: 'coord-A',
      summary: 'kubernetes coordination note',
      body_text: 'shared coordination context',
      matches: true,
    });
    const out = await byName('coord_message').lexical(params({ query: 'kubernetes' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['coord-A']);
    expect(out[0]?.row.source).toBe('coord_message');
  });

  it('coord_message.lexical: cancels a blocked read at the shared lexical statement deadline', async () => {
    const blockerDb = postgres(db.url, { max: 1 });
    const blocker = await blockerDb.reserve();
    await blocker.unsafe('BEGIN');
    await blocker.unsafe('LOCK TABLE harness_shared.coord_event_log IN ACCESS EXCLUSIVE MODE');
    const startedAt = Date.now();
    try {
      await expect(byName('coord_message').lexical(params())).rejects.toMatchObject({
        pgCode: '57014',
        timeoutSource: 'pg',
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(7_000);
      expect(elapsedMs).toBeLessThan(20_000);
    } finally {
      await blocker.unsafe('ROLLBACK');
      blocker.release();
      await blockerDb.end({ timeout: 5 });
    }
  }, 25_000);

  it('coord_message.lexical: explicit transcript session fails closed instead of scanning the coord corpus (EI-23130749427955806)', async () => {
    const out = await byName('coord_message').lexical(
      params({ query: 'kubernetes', filters: { sessionId: P17_SESSION } }),
    );
    expect(out).toEqual([]);
  });

  // EI-6984: the work_item source. Its embedding leg (P-005) has its own describe
  // block below; these cover the lexical leg.
  it('SECURITY — work_item.lexical: only workspace A; source_id=issue_id, scope=the harness:<slug> scope column, excerpt prefixed [kind/state/severity]', async () => {
    const out = await byName('work_item').lexical(params());
    const ids = out.map((r) => r.row.source_id).sort();
    expect(ids).toEqual(['EI-1', 'EI-2']);
    expect(out.some((r) => r.row.source_id === 'EI-9')).toBe(false); // the B decoy never leaks

    const ei1 = out.find((r) => r.row.source_id === 'EI-1')!;
    expect(ei1.row.source).toBe('work_item');
    expect(ei1.row.scope).toBe('harness:sheets');
    expect(ei1.row.rankers).toEqual(['lexical']);
    expect(ei1.row.excerpt).toBe('[bug/open/major] kubernetes scaling bug\npods do not autoscale');
    expect(ei1.row.highlight).toContain('<mark>');
    expect(ei1.key).toBe('work_item:EI-1');
  });

  it('work_item.lexical with scopeFilter=sheets → only EI-1 (scope column stores harness:<slug>)', async () => {
    const out = await byName('work_item').lexical(params({ scopeFilter: 'sheets' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['EI-1']);
  });

  it('a B-scoped work_item.lexical returns ONLY the B decoy, never the A issues', async () => {
    const out = await byName('work_item').lexical(params({ workspaceId: WS_B }));
    expect(out.map((r) => r.row.source_id)).toEqual(['EI-9']);
  });
});

/**
 * P-005 / D-078 — the work_item source's embedding leg.
 *
 * WHAT THE FIXTURE MAKES FALSIFIABLE. EI-3 is the nearest vector (θ=0.05) AND
 * contains none of the query's terms, so the lexical leg cannot return it at all.
 * Every assertion about ordering therefore fails if the leg is silently text-ranked
 * — which is the way a "wired up" leg most plausibly goes wrong, since a
 * text-ranked result set looks entirely reasonable from the outside.
 *
 * The vector column reaches production through migration 776, which appends it to
 * the `engineer_issues` VIEW; it lived on `harness_shared.work_items` all along.
 */
describe('P-005 — work_item.embedding (the semantic leg D-078 was missing)', () => {
  const idsOf = (out: Awaited<ReturnType<EmbeddingFn>>): string[] =>
    out.map((r) => r.row.source_id);

  it('the source registers an embedding ranker at all', () => {
    expect(byName('work_item').embedding).toBeTypeOf('function');
  });

  it('ranks by VECTOR distance, not by text — the lexically-unmatchable EI-3 comes FIRST', async () => {
    const out = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    expect(idsOf(out)).toEqual(['EI-3', 'EI-2', 'EI-1']);

    // ... and the control: that same row is invisible to the lexical leg, so this
    // ordering cannot have been produced by ts_rank_cd under another name.
    const lex = await byName('work_item').lexical(params());
    expect(lex.map((r) => r.row.source_id)).not.toContain('EI-3');
  });

  it('scores each hit as cosine similarity (1 - distance), matching the fixture angles', async () => {
    const out = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    const byId = new Map(out.map((r) => [r.row.source_id, r.score]));
    expect(byId.get('EI-3')).toBeCloseTo(Math.cos(0.05), 3);
    expect(byId.get('EI-2')).toBeCloseTo(Math.cos(0.1), 3);
    expect(byId.get('EI-1')).toBeCloseTo(Math.cos(0.9), 3);
  });

  it('omits rows with no embedding rather than scoring them as distant', async () => {
    const out = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    expect(idsOf(out)).not.toContain('EI-4');
    // EI-4 is a real, reachable row — it is absent from THIS leg only.
    const lex = await byName('work_item').lexical(params({ query: 'upgrade' }));
    expect(lex.map((r) => r.row.source_id)).toContain('EI-4');
  });

  it('SECURITY — never leaks workspace B, even though the B decoy is the nearest vector of all', async () => {
    const out = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    expect(idsOf(out)).not.toContain('EI-9');

    const b = await embeddingOf('work_item')({ ...params({ workspaceId: WS_B }), qVec: QVEC });
    expect(idsOf(b)).toEqual(['EI-9']);
  });

  it('honours scopeFilter with the same harness:<slug> semantics as the lexical leg', async () => {
    const out = await embeddingOf('work_item')({ ...params({ scopeFilter: 'sheets' }), qVec: QVEC });
    // EI-2 is harness:docs and drops out; EI-4 has no vector.
    expect(idsOf(out)).toEqual(['EI-3', 'EI-1']);
  });

  it('maps rows to the SAME identity + shape as the lexical leg, so RRF fuses instead of duplicating', async () => {
    const emb = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    const lex = await byName('work_item').lexical(params());
    const e1 = emb.find((r) => r.row.source_id === 'EI-1')!;
    const l1 = lex.find((r) => r.row.source_id === 'EI-1')!;

    expect(e1.key).toBe(l1.key); // 'work_item:EI-1' — the fusion key
    expect(e1.row.source).toBe('work_item');
    expect(e1.row.scope).toBe(l1.row.scope);
    expect(e1.row.excerpt).toBe(l1.row.excerpt);
    expect(e1.row.rankers).toEqual(['embeddings']);
    expect(l1.row.rankers).toEqual(['lexical']);
  });

  it('respects the limit', async () => {
    const out = await embeddingOf('work_item')({ ...params({ limit: 2 }), qVec: QVEC });
    expect(idsOf(out)).toEqual(['EI-3', 'EI-2']);
  });
});

/**
 * P-009 — both work_item legs must project `ts`.
 *
 * This is the PRECONDITION for the corpus leg's recency re-rank, and its absence
 * is silent in the worst way: `applyRecencyRerank` scores a hit with no timestamp
 * as `decay = 0` — MAXIMALLY OLD — never as "unknown". Measured 2026-08-09,
 * work-items were 36.6% of surfaced corpus refs and every one arrived `ts: null`,
 * so a regression here does not disable recency for work-items, it demotes all of
 * them for being unmeasurable, while looking exactly like recency working.
 *
 * Asserted against the DB rather than by reading the SQL because the failure this
 * catches is a dropped COLUMN, which only the real query can observe.
 */
describe('P-009 — work_item legs project the recency timestamp', () => {
  it('lexical carries ts from updated_at', async () => {
    const out = await byName('work_item').lexical(params());
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.row.ts, `work_item:${r.row.source_id} reached the engine with no ts`).toBeTruthy();
      expect(Number.isFinite(new Date(r.row.ts as string | Date).getTime())).toBe(true);
    }
  });

  it('falls back to created_at when updated_at is NULL — both columns are nullable', async () => {
    // Seeded in its OWN workspace so it cannot perturb the WS_A / WS_B row-set
    // assertions above, which pin exact id lists.
    const WS_P009 = 'ws-P009';
    const createdAt = '2026-07-04T00:00:00.000Z';
    await sql`INSERT INTO harness_shared.engineer_issues
                (workspace_id, issue_id, scope, title, body, kind, state, severity, updated_at, created_at)
              VALUES (${WS_P009}, 'EI-NULLTS', 'harness:sheets', 'kubernetes scaling bug',
                      'updated_at is null here', 'bug', 'open', 'major', NULL, ${createdAt})`;

    const out = await byName('work_item').lexical(params({ workspaceId: WS_P009 }));
    const row = out.find((r) => r.row.source_id === 'EI-NULLTS')!;
    expect(row).toBeDefined();
    expect(new Date(row.row.ts as string | Date).toISOString()).toBe(createdAt);
  });

  it('embedding carries it too — the legs must not disagree about the same row', async () => {
    const emb = await embeddingOf('work_item')({ ...params(), qVec: QVEC });
    const lex = await byName('work_item').lexical(params());
    const e1 = emb.find((r) => r.row.source_id === 'EI-1')!;
    const l1 = lex.find((r) => r.row.source_id === 'EI-1')!;
    expect(e1.row.ts).toBeTruthy();
    // Same row, same fusion key — a ts that differed by leg would make the blended
    // score depend on which leg happened to win the RRF merge.
    expect(new Date(e1.row.ts as string | Date).getTime()).toBe(
      new Date(l1.row.ts as string | Date).getTime(),
    );
  });
});

describe('GAP 10 — harness_slug scopeFilter narrows the ws-scoped sources', () => {
  it('escalations.lexical with scopeFilter=sheets → only the sheets row', async () => {
    const out = await byName('escalations').lexical(params({ scopeFilter: 'sheets' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
  });

  it('escalations.lexical with scopeFilter=docs → only the docs row', async () => {
    const out = await byName('escalations').lexical(params({ scopeFilter: 'docs' }));
    expect(out.map((r) => r.row.source_id)).toEqual(['docs:staging']);
  });

  it('decisions.lexical with a non-matching scopeFilter → empty', async () => {
    const out = await byName('decisions').lexical(params({ scopeFilter: 'no-such-harness' }));
    expect(out).toEqual([]);
  });
});

describe('GAP 10 — embedding SQL: cosine sim = 1 - (emb <=> qVec), nearest-first, scope-isolated', () => {
  it('escalations.embedding: A-only, ordered nearest-first, score = cos(angle gap)', async () => {
    const out = await embeddingOf('escalations')({ ...params(), qVec: QVEC });
    // A rows at angles 0.1 (sheets) and 0.9 (docs); decoy is angle 0.01 in B.
    // Nearest to the query (angle 0) is sheets (0.1) then docs (0.9). Decoy,
    // though angularly NEAREST of all (0.01), is in workspace B and must be absent.
    expect(out.map((r) => r.row.source_id)).toEqual(['sheets:staging', 'docs:staging']);
    expect(out.some((r) => r.row.source_id.startsWith('decoy'))).toBe(false);

    expect(out[0].row.rankers).toEqual(['embeddings']);
    // sim of the first row ≈ cos(0.1). 1-(<=>) is the cosine sim by construction.
    expect(out[0].row.score).toBeCloseTo(Math.cos(0.1), 5);
    expect(out[1].row.score).toBeCloseTo(Math.cos(0.9), 5);
    // Descending similarity (nearest-first).
    expect(out[0].row.score).toBeGreaterThan(out[1].row.score);
  });

  it('SECURITY — turns.embedding: A-only via the JOIN; the angularly-nearest decoy (B) does NOT leak', async () => {
    const out = await embeddingOf('turns')({ ...params(), qVec: QVEC });
    expect(out).toHaveLength(2); // the two A turns only
    // A turns at angles 0.25 and 0.5 → nearest-first = 0.25 then 0.5.
    expect(out[0].row.score).toBeCloseTo(Math.cos(0.25), 5);
    expect(out[1].row.score).toBeCloseTo(Math.cos(0.5), 5);
    expect(out[0].row.score).toBeGreaterThan(out[1].row.score);
    // The B decoy (angle 0.04, the closest of all) is excluded by the ws JOIN.
    expect(out.some((r) => r.row.excerpt.includes('another workspace'))).toBe(false);
  });

  it('brainstorm.embedding + decisions.embedding: A-only, score = cosine sim', async () => {
    const bs = await embeddingOf('brainstorm')({ ...params(), qVec: QVEC });
    expect(bs.map((r) => r.row.source_id)).toEqual(['sheets:staging']);
    expect(bs[0].row.score).toBeCloseTo(Math.cos(0.2), 5);
    expect(bs[0].row.rankers).toEqual(['embeddings']);

    const dec = await embeddingOf('decisions')({ ...params(), qVec: QVEC });
    expect(dec.map((r) => r.row.source_id)).toEqual(['sheets:h1']);
    expect(dec[0].row.score).toBeCloseTo(Math.cos(0.15), 5);
    expect(dec[0].row.excerpt.startsWith('[2026-01-01]')).toBe(true);
  });

  it('embedding scopeFilter narrows too (escalations → docs only)', async () => {
    const out = await embeddingOf('escalations')({ ...params({ scopeFilter: 'docs' }), qVec: QVEC });
    expect(out.map((r) => r.row.source_id)).toEqual(['docs:staging']);
  });
});

describe('GAP 10 — workspace B sees its OWN rows (proves the filter is scoping, not just hiding)', () => {
  it('a B-scoped escalations.lexical returns ONLY the B decoy, never the A rows', async () => {
    const out = await byName('escalations').lexical(params({ workspaceId: WS_B }));
    expect(out.map((r) => r.row.source_id)).toEqual(['decoy:staging']);
  });

  it('a B-scoped turns.lexical returns ONLY the B turn, never the two A turns', async () => {
    const out = await byName('turns').lexical(params({ workspaceId: WS_B }));
    expect(out).toHaveLength(1);
    expect(out[0].row.excerpt).toContain('another workspace');
  });
});

/**
 * P-017 / D-062 — `lexicalSql`, the corpus injection leg's term-combination mode.
 *
 * The regression this suite exists to prevent is asymmetric, so it is guarded in
 * both directions:
 *
 *   * `'and'` (the DEFAULT, and what every caller still gets) must be EXACTLY
 *     today's query. The first test asserts that against the literal pre-P-017
 *     SQL run side-by-side — same rows, same order, same rank floats, same
 *     highlight bytes — because the shared `sources.ts` registry backs
 *     `search:fulltext`, `search:semantic`, `sessions:search` and
 *     `ask-knowledge-tier` as well, and silently re-ranking those was never in
 *     scope.
 *   * `'coverage-graded'` must be a strict SUPERSET with the AND rows in the top
 *     tier — the no-regression property that let this ship as one query instead
 *     of a two-pass cascade.
 */
const p17Params = (over: Partial<SearchSourceParams> = {}): SearchSourceParams =>
  params({ query: P17_QUERY, ...over });

/** Mirrors `HEADLINE_OPTS` in sources.ts — duplicated on purpose: the point of
 *  the equivalence test is that the SHIPPED constant produces these bytes. */
const HEADLINE_OPTS_MIRROR =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

describe('P-017 — session_turn.lexical lexicalMode', () => {
  it('rejects a pre-aborted source call before probing BM25 or reading rows', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(byName('session_turn').lexical(p17Params({ signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it("'and' mode is the PRE-P-017 query exactly — same rows, order, ranks and highlight bytes", async () => {
    // The literal query as it stood before `lexicalSql` was introduced.
    const legacy = (await sql`
      SELECT source_kind, session_id, turn_idx,
             ts_rank_cd(text_tsv, plainto_tsquery('english', ${P17_QUERY})) AS rank,
             ts_headline('english', left(text, 4000),
               plainto_tsquery('english', ${P17_QUERY}),
               ${HEADLINE_OPTS_MIRROR}) AS highlight
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${WS_A} OR workspace_id = 'default')
         AND text_tsv @@ plainto_tsquery('english', ${P17_QUERY})
    ORDER BY rank DESC LIMIT 20
    `) as unknown as Array<{ source_kind: string; session_id: string; turn_idx: number; rank: number; highlight: string }>;

    const out = await byName('session_turn').lexical(p17Params());

    expect(out.map((r) => r.row.source_id)).toEqual(
      legacy.map((r) => `${r.source_kind}:${r.session_id}:${r.turn_idx}`),
    );
    expect(out.map((r) => r.score)).toEqual(legacy.map((r) => r.rank));
    expect(out.map((r) => r.row.highlight)).toEqual(legacy.map((r) => r.highlight));
    // …and it is the all-terms set, nothing more: AND cannot reach T_FOUR.
    expect(out.map((r) => r.row.source_id).sort()).toEqual([T_ALL_A, T_ALL_B]);
  });

  it("'coverage-graded' is a strict SUPERSET of 'and', with the AND rows in the top coverage tier", async () => {
    const and = await byName('session_turn').lexical(p17Params());
    const graded = await byName('session_turn').lexical(p17Params({ lexicalMode: 'coverage-graded' }));

    const andIds = and.map((r) => r.row.source_id);
    const gradedIds = graded.map((r) => r.row.source_id);

    // Containment — the property that makes this no-regression by construction.
    for (const id of andIds) expect(gradedIds).toContain(id);
    expect(gradedIds.length).toBeGreaterThan(andIds.length);

    // The AND set occupies the top tier — not merely present, but FIRST.
    expect(gradedIds.slice(0, andIds.length).sort()).toEqual([...andIds].sort());
  });

  it('recovers a 4-of-5 document the AND query discards outright', async () => {
    const and = await byName('session_turn').lexical(p17Params());
    const graded = await byName('session_turn').lexical(p17Params({ lexicalMode: 'coverage-graded' }));

    expect(and.map((r) => r.row.source_id)).not.toContain(T_FOUR);
    expect(graded.map((r) => r.row.source_id)).toContain(T_FOUR);
    // It sits directly below the coverage-5 tier, above the coverage-2 trap.
    expect(graded.map((r) => r.row.source_id)).toEqual([
      ...graded.slice(0, 2).map((r) => r.row.source_id),
      T_FOUR,
      T_TRAP,
    ]);
  });

  it('COVERAGE outranks ts_rank_cd — the frequency trap scores higher yet places last', async () => {
    const graded = await byName('session_turn').lexical(p17Params({ lexicalMode: 'coverage-graded' }));
    const byId = new Map(graded.map((r) => [r.row.source_id, r]));

    const trap = byId.get(T_TRAP);
    const allTerms = byId.get(T_ALL_A);
    expect(trap).toBeDefined();
    expect(allTerms).toBeDefined();

    // BOTH halves matter. If the first assertion ever fails the fixture has
    // stopped exercising the trap, and the second would pass vacuously.
    expect(trap!.score).toBeGreaterThan(allTerms!.score);
    expect(graded[graded.length - 1].row.source_id).toBe(T_TRAP);
  });

  it('the rarest-lexeme anchor is STRICT — 4-of-5 documents lacking it are excluded (the cost that bounds the scan)', async () => {
    const graded = await byName('session_turn').lexical(p17Params({ lexicalMode: 'coverage-graded' }));
    const ids = graded.map((r) => r.row.source_id);
    // stId(10) matches corpus+recall+pointer+section — coverage 4, no `clamp`.
    expect(ids).not.toContain(stId(10));
    expect(ids).toEqual([T_ALL_A, T_ALL_B, T_FOUR, T_TRAP].filter((id) => ids.includes(id)));
    expect(ids).toHaveLength(4);
  });

  it('graded highlights render against the DISJUNCTIVE query, so a partial match gets a real fragment', async () => {
    const graded = await byName('session_turn').lexical(p17Params({ lexicalMode: 'coverage-graded' }));
    const four = graded.find((r) => r.row.source_id === T_FOUR);
    expect(four?.row.highlight).toContain('<mark>');
  });

  it('SECURITY — the workspace-B decoy is counted by the unfiltered DF probe but leaks into NEITHER mode', async () => {
    for (const mode of ['and', 'coverage-graded'] as const) {
      const out = await byName('session_turn').lexical(p17Params({ lexicalMode: mode }));
      expect(out.map((r) => r.row.source_id)).not.toContain(T_DECOY_B);
      for (const r of out) expect(r.row.excerpt).not.toContain('another workspace');
    }
    // …and B still sees its OWN row, so this is scoping, not blanket hiding.
    const b = await byName('session_turn').lexical(
      p17Params({ workspaceId: WS_B, lexicalMode: 'coverage-graded' }),
    );
    expect(b.map((r) => r.row.source_id)).toEqual([T_DECOY_B]);
  });
});

describe('EI-23237047797741772 — compact transcript tokens use the literal fallback', () => {
  it('retrieves a pasted compact URL token when dictionary lookup misses it', async () => {
    // EI-23737056070911495: the simple-dictionary leg of this probe went away
    // with migration 1163's column, which stays parked as `.DRAFT` and is never
    // applied. That leg asserted `false` ANYWAY — both dictionaries miss a
    // compact pasted token — so dropping it leaves this test's real claim fully
    // intact: dictionary lookup misses the token, and the bounded literal
    // substring fallback is what actually retrieves the row.
    const dictionaryProbe = await sql<Array<{ english_matches: boolean; literal_match: boolean }>>`
      SELECT text_tsv @@ plainto_tsquery('english', ${COMPACT_QUERY}) AS english_matches,
             position(lower(${COMPACT_QUERY}) in lower(text)) > 0 AS literal_match
        FROM harness_shared.session_turns
       WHERE workspace_id = ${WS_A}
         AND source_kind = 'codex'
         AND session_id = ${COMPACT_SESSION}
         AND turn_idx = 1
    `;
    expect(dictionaryProbe).toEqual([{ english_matches: false, literal_match: true }]);

    const out = await byName('session_turn').lexical(
      params({ query: COMPACT_QUERY, limit: 20 }),
    );

    expect(out.map((r) => r.row.source_id)).toEqual([COMPACT_ID]);
    expect(out[0].row.highlight).toContain('https://www.furnishedfinder.com/rooms/123');
    expect(out[0].row.rankers).toEqual(['lexical']);
  });

  it('keeps the fallback workspace-scoped and does not surface the B decoy', async () => {
    const a = await byName('session_turn').lexical(
      params({ query: COMPACT_QUERY, limit: 20 }),
    );
    expect(a.map((r) => r.row.source_id)).not.toContain(COMPACT_DECOY_ID);
    expect(a).toHaveLength(1);
    expect(a[0].row.excerpt).toContain('compact domain link');

    const b = await byName('session_turn').lexical(
      params({ query: COMPACT_QUERY, workspaceId: WS_B, limit: 20 }),
    );
    expect(b.map((r) => r.row.source_id)).toEqual([COMPACT_DECOY_ID]);
  });

  it('preserves the English ranker for ordinary terms', async () => {
    const out = await byName('session_turn').lexical(params({ query: P17_QUERY }));
    expect(out.map((r) => r.row.source_id).sort()).toEqual([T_ALL_A, T_ALL_B].sort());
    expect(out.every((r) => r.row.highlight.includes('<mark>'))).toBe(true);
  });
});

/**
 * EI-24045346484356708 — the literal-substring match used to be an OR arm of the
 * index-served query, which no index can serve: live, a rare term went from a
 * 1ms GIN bitmap scan to a 6.4s parallel seq scan of the whole table on EVERY
 * call. It is now a separate, windowed FILL that runs only for a compact token
 * and only for slots the dictionary match left empty.
 *
 * These assertions read the SQL actually SENT, through a second client whose
 * postgres.js `debug` hook records every statement — so they cannot pass by
 * re-deriving what the source "should" send. The positive control proves the
 * recorder does see a substring statement when one is sent.
 */
describe('EI-24045346484356708 — the literal fallback is a bounded FILL, never an arm of the index query', () => {
  let traced: postgres.Sql;
  const sent: string[] = [];
  const POSITION = /\bposition\s*\(/i;
  const substringStatements = (): string[] => sent.filter((q) => POSITION.test(q));
  const run = async (over: Partial<SearchSourceParams>) => {
    sent.length = 0;
    return byName('session_turn').lexical(params({ sql: traced, ...over }));
  };

  beforeAll(() => {
    traced = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      prepare: false,
      debug: (_connection, query) => {
        sent.push(query);
      },
    });
  });

  afterAll(async () => {
    await traced?.end({ timeout: 5 });
  });

  it('compactLiteralToken admits a single compact token of 3+ chars and nothing else', () => {
    expect(compactLiteralToken('furnishedfinder')).toBe('furnishedfinder');
    expect(compactLiteralToken('  furnishedfinder  ')).toBe('furnishedfinder');
    expect(compactLiteralToken('www.furnishedfinder.com/rooms')).toBe('www.furnishedfinder.com/rooms');
    expect(compactLiteralToken('furnished finder')).toBeNull();
    expect(compactLiteralToken('ok')).toBeNull();
    expect(compactLiteralToken('   ')).toBeNull();
  });

  it('a multi-word query sends NO substring predicate at all, and its result is unchanged', async () => {
    const out = await run({ query: P17_QUERY });
    expect(out.map((r) => r.row.source_id).sort()).toEqual([T_ALL_A, T_ALL_B].sort());
    expect(sent.some((q) => q.includes('ts_rank_cd'))).toBe(true);
    expect(substringStatements()).toEqual([]);
  });

  it('R2 applies its bounded planner profile inside the real transaction without leaking it', async () => {
    await traced.unsafe('SET max_parallel_workers_per_gather = 7');
    await traced.unsafe('SET parallel_setup_cost = 987');
    await traced.unsafe('SET parallel_tuple_cost = 0.37');
    let inside: { workers: string; setup: string; tuple: string } | undefined;
    const begin = traced.begin.bind(traced);
    // Preserve PostgreSQL's real BEGIN/COMMIT; inspect the same connection
    // after the source query completes but before its transaction commits.
    const inspected = new Proxy(traced, {
      get(target, key, receiver) {
        if (key === 'begin') {
          return (action: (tx: postgres.TransactionSql) => Promise<unknown>) => begin(async (tx) => {
            const result = await action(tx);
            const rows = await tx<{ workers: string; setup: string; tuple: string }[]>`
              SELECT current_setting('max_parallel_workers_per_gather') AS workers,
                     current_setting('parallel_setup_cost') AS setup,
                     current_setting('parallel_tuple_cost') AS tuple
            `;
            inside = rows[0];
            return result;
          });
        }
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const out = await byName('session_turn').lexical(params({ sql: inspected, query: P17_QUERY }));
      expect(out.map((r) => r.row.source_id).sort()).toEqual([T_ALL_A, T_ALL_B].sort());
      expect(inside).toEqual({ workers: '2', setup: '0', tuple: '0.01' });
      const after = await traced<{ workers: string; setup: string; tuple: string }[]>`
        SELECT current_setting('max_parallel_workers_per_gather') AS workers,
               current_setting('parallel_setup_cost') AS setup,
               current_setting('parallel_tuple_cost') AS tuple
      `;
      expect(after[0]).toEqual({ workers: '7', setup: '987', tuple: '0.37' });
    } finally {
      await traced.unsafe('RESET max_parallel_workers_per_gather');
      await traced.unsafe('RESET parallel_setup_cost');
      await traced.unsafe('RESET parallel_tuple_cost');
    }
  });

  it('a compact token whose dictionary hits already fill the limit sends no substring predicate', async () => {
    // `clamp` matches four workspace-A turns through the dictionary; limit 2
    // leaves no slot for a rank-0 literal row to occupy.
    const out = await run({ query: 'clamp', limit: 2 });
    expect(out).toHaveLength(2);
    expect(substringStatements()).toEqual([]);
  });

  it('positive control: with empty slots the same token sends ONE windowed fill, separate from the index query', async () => {
    const out = await run({ query: 'clamp', limit: 20 });
    expect(out).toHaveLength(4);
    const subs = substringStatements();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatch(/ORDER BY ingested_at DESC\s+LIMIT/i);
    const indexQuery = sent.find((q) => q.includes('ts_rank_cd'));
    expect(indexQuery).toBeDefined();
    expect(indexQuery).not.toMatch(POSITION);
  });

  it('EI-23237047797741772 recall still arrives, through the fill, at rank 0', async () => {
    const out = await run({ query: COMPACT_QUERY, limit: 20 });
    expect(out.map((r) => r.row.source_id)).toEqual([COMPACT_ID]);
    expect(out[0].score).toBe(0);
    expect(out[0].row.highlight).toContain('https://www.furnishedfinder.com/rooms/123');
    expect(substringStatements()).toHaveLength(1);
  });

  it('coverage-graded mode never sends the fill (it never admitted literal rows)', async () => {
    await run({ query: COMPACT_QUERY, limit: 20, lexicalMode: 'coverage-graded' });
    expect(sent.length).toBeGreaterThan(0);
    expect(substringStatements()).toEqual([]);
  });
});

describe('P-017 — work_item.lexical lexicalMode (the second source the corpus leg reads)', () => {
  it("'and' returns only the all-terms issue; 'coverage-graded' is a superset ordered by coverage", async () => {
    const and = await byName('work_item').lexical(p17Params());
    const graded = await byName('work_item').lexical(p17Params({ lexicalMode: 'coverage-graded' }));

    expect(and.map((r) => r.row.source_id)).toEqual(['EI-C1']);
    // C2 is 4-of-5 with the anchor; C3 is 2-of-5 with the anchor; the N-rows
    // lack `clamp` entirely and the anchor excludes them.
    expect(graded.map((r) => r.row.source_id)).toEqual(['EI-C1', 'EI-C2', 'EI-C3']);
    for (const id of and.map((r) => r.row.source_id)) {
      expect(graded.map((r) => r.row.source_id)).toContain(id);
    }
  });

  it('SECURITY — the workspace-B issue never leaks under either mode', async () => {
    for (const mode of ['and', 'coverage-graded'] as const) {
      const out = await byName('work_item').lexical(p17Params({ lexicalMode: mode }));
      expect(out.map((r) => r.row.source_id)).not.toContain('EI-D9');
    }
  });
});
