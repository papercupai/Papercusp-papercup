/**
 * relevance-router.integration.test.ts — routeConsult against a real Postgres
 * (pgvector), P-002 of get-feedback-relevance-consults-2026-08-16.
 *
 * Fixture geometry (same trick as sources.integration.test.ts): 384-d unit
 * vectors from a single direction angle, v(θ) = [cos θ, sin θ, 0, …], so the
 * cosine similarity between the query v(q) and a turn v(θ) is exactly
 * cos(q − θ) and the ranking is analytically checkable.
 *
 * What only a real-PG test can prove here:
 *  - the turn leg's SQL (workspace OR 'default', requester exclusion,
 *    machine-surface exclusion, vector ordering) against real pgvector;
 *  - the verification leg (completion_authority='committed', 90d window) and
 *    the authorship leg (payload->'paths' LATERAL match) against real jsonb;
 *  - the D-003 honesty invariants end-to-end: no_qualified_responder is a
 *    first-class verdict (far query), the HARD sim sub-floor blocks a
 *    high-track-record candidate even when its BLENDED score clears the floor,
 *    and a missing embedder degrades honestly while exposing only an explicit
 *    lexical fallback path (never semantic qualification).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../../test/_disclosure-ledger-fixture';
import { D006_TRANSCRIPT_RULE } from '../personal-vault/transcript-exclusion';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordExpertiseRoutingInvocation, readExpertiseRoutingRecorderHealth, EXPERTISE_ROUTING_PATH } from '../endpoint-route/telemetry';
import { readExpertiseExecutionHealth } from './consult-routing-health';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../search/prose-vector-dims';
import {
  routeConsult,
  extractPathTokens,
  DEFAULT_SIM_FLOOR,
  DEFAULT_RELEVANCE_FLOOR,
  SUBJECT_EVIDENCE_OWNER_LIMIT,
  SUBJECT_EVIDENCE_TIMEOUT_MS,
  scoreSubjectEvidence,
  snapshotCandidateQualifies,
  type ConsultRouteDeps,
  type ExpertiseRoutingReceipt,
} from './relevance-router';

const WS = 'ws-consult';
const NOW = new Date('2026-08-16T00:00:00Z');
const DAY = 86_400_000;

/** 768-d unit vector at angle θ in the (0,1) plane. */
const vecAt = (theta: number): number[] => {
  const v = new Array<number>(768).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
};

let rootSql: Sql;
let fixtureDb: MigratedTestDb;
let recordNativeTurnQuery = false;
let nativeTurnQuery: { query: string; parameters: unknown[] } | null = null;

const deps = (embedTheta: number | null, over: Partial<ConsultRouteDeps> = {}): ConsultRouteDeps => ({
  getSql: () => rootSql,
  embed: embedTheta === null ? null : async () => vecAt(embedTheta),
  embeddingProfile: embedTheta === null
    ? null
    : resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
  embeddingMode: embedTheta === null ? null : 'gemma',
  now: () => NOW,
  // Analytic vector fixtures isolate the PG/vector contract. Subject scenarios
  // override this seam with independent positive/counterexample evidence.
  scoreSubjectEvidence: async (_subject, texts) => texts.map(() => 1),
  ...over,
});

let turnSeq = 0;
async function insertTurn(owner: string, theta: number, tsMsAgo: number, over: { verdict?: string; text?: string } = {}) {
  turnSeq += 1;
  const text = over.text ?? `turn ${turnSeq} of ${owner}`;
  await rootSql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
       text_embedding, text_embedding_mode, text_embedding_profile, turn_origin_verdict)
    VALUES ('default', 'claude', ${'sess-' + owner}, ${turnSeq},
            ${new Date(NOW.getTime() - tsMsAgo).toISOString()}::timestamptz,
            ${owner}, 'assistant', ${text},
            ${JSON.stringify(vecAt(theta))}::vector,
            'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId},
            ${over.verdict ?? null})`;
}

let wiSeq = 0;
async function insertWorkItem(owner: string, authority: string, closedMsAgo: number, paths: string[] | null) {
  wiSeq += 1;
  await rootSql`
    INSERT INTO harness_shared.work_items (feature_id, terminal_owner, authority, closed_ts, payload)
    VALUES (${'WI-T' + wiSeq}, ${owner}, ${authority},
            ${NOW.getTime() - closedMsAgo},
            ${paths ? rootSql.json({ paths }) : rootSql.json({})})`;
}

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consultr' });
  rootSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {},
    debug: (_connection, query, parameters) => {
      if (recordNativeTurnQuery && query.includes('AS "subjectText"')) {
        nativeTurnQuery = { query, parameters };
      }
    } });
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  const ledgerMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/archive/077-route-invocations.sql', import.meta.url));
  await rootSql.unsafe(readFileSync(ledgerMigration, 'utf8').replace(/^\\.*$/gm, ''));
  const metadataMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1429-route-invocation-metadata.sql', import.meta.url));
  await rootSql.unsafe(readFileSync(existsSync(metadataMigration) ? metadataMigration : metadataMigration + '.DRAFT', 'utf8'));
  // D-006: routing excludes experts who have held a disclosure; the ledger must exist.
  await rootSql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  // Only the columns the router reads. ⚠ These names MUST match the real
  // migration-owned schema exactly — a hand-rolled fixture that invents column
  // names makes this suite self-consistent and WRONG. That is not hypothetical:
  // this table previously declared `completion_authority text` / `closed_at
  // timestamptz`, matching the router's SQL but NOT the live schema (which has
  // `authority text` / `closed_ts bigint`). The suite passed green while every
  // consult:get_feedback call in production died on `column
  // "completion_authority" does not exist` (EI-20816404371786180). Verify any
  // column added here against information_schema before trusting a green run.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL DEFAULT 'default',
      source_kind text NOT NULL,
      session_id text NOT NULL,
      turn_idx integer NOT NULL,
      ts timestamptz,
      owner text,
      speaker text NOT NULL,
      text text NOT NULL,
      chunked_at timestamptz,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      text_embedding vector(768),
      text_embedding_mode text,
      text_embedding_profile text,
      text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      turn_origin_verdict text,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      admission text, admitted_at timestamptz, admitted_by text,
      terminal_owner text,
      authority text,
      closed_ts bigint,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
  // Registry columns match 000-baseline + 115-adv-session-native-id.sql.
  // These are population hints; the native resolver still measures liveness.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      agent text, role text, session_id text, omp_thread_id text,
      ended_at timestamptz
    )`);
  // Exact canonical column names from the existing plan-claim store; only
  // population selection reads this fixture, never claim lifecycle operations.
  await rootSql.unsafe(`CREATE TABLE harness_shared.plan_item_claims (
    workspace_id text NOT NULL, owner text NOT NULL, expires_ts timestamptz NOT NULL
  )`);

  // ── The corpus ─────────────────────────────────────────────────────────
  // alpha: highly similar (θ≈0.2), recent, verified, authored the named path.
  await insertTurn('agent-alpha', 0.15, 1 * DAY);
  await insertTurn('agent-alpha', 0.2, 2 * DAY);
  await insertTurn('agent-alpha', 0.25, 3 * DAY);
  for (let i = 0; i < 5; i++) {
    await insertWorkItem('agent-alpha', 'committed', (i + 1) * DAY, [
      'packages/operator-core/lib/consult/relevance-router.ts',
    ]);
  }
  // beta: moderately similar (θ=0.85 → sim≈0.66 vs q=0), STALE (40d), unverified.
  await insertTurn('agent-beta', 0.85, 40 * DAY);
  await insertTurn('agent-beta', 0.9, 41 * DAY);
  // self: the requester's own perfect-similarity turn — must be excluded.
  await insertTurn('agent-self', 0, 1 * DAY);
  // machineonly: near-perfect similarity but machine-surface — must be excluded.
  await insertTurn('agent-machineonly', 0.05, 1 * DAY, { verdict: 'machine-surface' });
  // looponly: near-perfect similarity but agent-injected loop-fire text — must
  // be excluded from the routing evidence just like machine-surface text.
  await insertTurn('agent-looponly', 0.04, 1 * DAY, { verdict: 'agent-injected' });
  // subfloor: sim cos(1.2)≈0.362 < DEFAULT_SIM_FLOOR, but massive fresh track
  // record — the D-003 hard-gate case.
  await insertTurn('agent-subfloor', 1.2, 0.5 * DAY);
  for (let i = 0; i < 50; i++) {
    await insertWorkItem('agent-subfloor', 'committed', (i % 30) * DAY, null);
  }
  // proposed-only closes must NOT count as verification.
  await insertWorkItem('agent-beta', 'proposed', 1 * DAY, null);
}, 120_000);

afterAll(async () => {
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

const baseParams = { workspaceId: WS, requesterId: 'agent-self', question: 'how does the consult router work?' };

describe('native source population before retrieval and subject bounds', () => {
  const nativeConsult = { sourceBackend: 'claude', sourceState: 'live', targetBackend: 'codex' } as const;
  const question = 'testing:run native acceptance source';
  const addedOwners: string[] = [];
  afterEach(async () => {
    await rootSql`DELETE FROM harness_shared.session_turns WHERE owner = ANY(${addedOwners}::text[])`;
    await rootSql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ANY(${addedOwners}::text[])`;
    await rootSql`DELETE FROM harness_shared.plan_item_claims WHERE owner = ANY(${addedOwners}::text[])`;
    addedOwners.length = 0;
  });
  async function source(owner: string, angle: number, options: {
    backend?: string; ended?: boolean; session?: string; currentSession?: string;
    workspace?: string; role?: string; text?: string;
  } = {}) {
    addedOwners.push(owner);
    await insertTurn(owner, angle, DAY);
    const session = options.session ?? 'sess-' + owner;
    await rootSql`UPDATE harness_shared.session_turns
      SET source_kind = ${options.backend ?? 'claude'}, session_id = ${session},
          text = ${options.text ?? question}, chunked_at = NULL WHERE owner = ${owner}`;
    await rootSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, coord_owner_id, agent, role, session_id, ended_at)
      VALUES (${options.workspace ?? WS}, ${owner}, ${options.backend ?? 'claude'}, ${options.role ?? null},
        ${options.currentSession ?? session}, ${options.ended ? NOW.toISOString() : null}::timestamptz)`;
  }

  it('does not spend bounded turns or subject checks on incompatible native evidence', async () => {
    for (let n = 0; n < SUBJECT_EVIDENCE_OWNER_LIMIT + 2; n++) {
      await source('native-pop-codex-' + n, n * 0.005, { backend: 'codex' });
    }
    await source('native-pop-ended', 0.06, { ended: true });
    await source('native-pop-old', 0.07, { currentSession: 'new-native' });
    await source('native-pop-foreign', 0.08, { workspace: 'another-workspace' });
    await source('native-pop-role', 0.09, { role: 'judge' });
    await source('native-pop-live', 0.25, { text: question + ' compatible' });
    await source('native-pop-mismatch', 0.27, { text: question + ' unrelated' });
    await source('native-pop-below-floor', 1.4);
    const seen: string[] = [];
    const result = await routeConsult({ ...baseParams, question, nativeConsult,
      turnLimit: 3, maxCandidates: 1, maxQualified: 1 }, deps(0, {
      scoreSubjectEvidence: async (_subject, texts) => {
        seen.push(...texts);
        return texts.map(text => text.endsWith('compatible') ? 0.9 : 0.2);
      },
    }));
    expect(result.qualified.map(c => c.ownerId)).toEqual(['native-pop-live']);
    expect(result.qualified[0]?.evidence.map(ref => ref.session_id)).toEqual(['sess-native-pop-live']);
    expect(seen).toHaveLength(2);
    expect(seen.every(text => text.endsWith('compatible') || text.endsWith('unrelated'))).toBe(true);
    expect(result.snapshot.subjectValidation).toMatchObject({ evaluated: 2, unmeasured: 0 });
    expect(result.snapshot.simFloor).toBe(DEFAULT_SIM_FLOOR);
    expect(result.snapshot.relevanceFloor).toBe(DEFAULT_RELEVANCE_FLOOR);
  });

  it('retains ended historical evidence across native-id reanchors, while live evidence must be current', async () => {
    await source('native-pop-history', 0.1, { ended: true,
      session: 'historical-native', currentSession: 'newer-ended-native' });
    const result = await routeConsult({ ...baseParams, nativeConsult: { ...nativeConsult, sourceState: 'ended' },
      turnLimit: 1 }, deps(0));
    expect(result.qualified.map(c => c.ownerId)).toEqual(['native-pop-history']);
    expect(result.qualified[0]?.evidence[0]?.session_id).toBe('historical-native');
  });

  it('requires genuine source plan leases before bounded semantic and lexical retrieval', async () => {
    await source('native-plan-empty', 0.01);
    await source('native-plan-expired', 0.02);
    await source('native-plan-foreign', 0.03);
    await source('native-plan-held', 0.2);
    await rootSql`INSERT INTO harness_shared.plan_item_claims (workspace_id, owner, expires_ts) VALUES
      (${WS}, 'native-plan-expired', clock_timestamp() - interval '1 minute'),
      ('another-workspace', 'native-plan-foreign', clock_timestamp() + interval '1 hour'),
      (${WS}, 'native-plan-held', clock_timestamp() + interval '1 hour')`;
    const request = { ...baseParams, question, nativeConsult: { ...nativeConsult, requireSourcePlanClaims: true },
      turnLimit: 1, maxCandidates: 1, maxQualified: 1 };
    const measured = await routeConsult(request, deps(0));
    expect(measured.qualified.map(c => c.ownerId)).toEqual(['native-plan-held']);
    expect(measured.snapshot.simFloor).toBe(DEFAULT_SIM_FLOOR);
    expect(measured.snapshot.relevanceFloor).toBe(DEFAULT_RELEVANCE_FLOOR);
    const lexical = await routeConsult(request, deps(null));
    expect(lexical.qualified).toEqual([]);
    expect(lexical.snapshot.candidates.map(c => c.ownerId)).toEqual(['native-plan-held']);
    expect(lexical.snapshot).toMatchObject({ degraded: 'embed-unavailable', fallback: 'lexical' });
    // Omitting the internal predicate preserves the ordinary native population.
    const ordinary = await routeConsult({ ...request, nativeConsult }, deps(0));
    expect(ordinary.qualified.map(c => c.ownerId)).toEqual(['native-plan-empty']);
  });

  it('constrains lexical fallback too, without treating it as measured expertise', async () => {
    await source('native-pop-lexical-wrong', 0, { backend: 'codex' });
    await source('native-pop-lexical-right', 0.2);
    const result = await routeConsult({ ...baseParams, question, nativeConsult, turnLimit: 1 }, deps(null));
    expect(result.qualified).toEqual([]);
    expect(result.snapshot.candidates.map(c => c.ownerId)).toEqual(['native-pop-lexical-right']);
    expect(result.snapshot).toMatchObject({ degraded: 'embed-unavailable', fallback: 'lexical' });
  });

  it('retrieves a claimed live native source outside the global HNSW scan budget', async () => {
    const owner = 'native-hnsw-held';
    const noise = 'native-hnsw-incompatible';
    await source(owner, 0.2);
    await rootSql`INSERT INTO harness_shared.plan_item_claims (workspace_id, owner, expires_ts)
      VALUES (${WS}, ${owner}, clock_timestamp() + interval '1 hour')`;
    addedOwners.push(noise);
    await rootSql`INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, owner, speaker, text,
       text_embedding, text_embedding_mode, text_embedding_profile)
      SELECT 'default', 'codex', ${'sess-' + noise}, n, ${noise}, 'assistant', ${question},
             ${JSON.stringify(vecAt(0))}::vector, 'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId}
        FROM generate_series(1, 2000) n`;
    // source() above (and earlier tests) HOT-update session_turns rows. If a dead
    // HOT-updated tuple is still RECENTLY_DEAD when the index is built, PostgreSQL
    // sets pg_index.indcheckxmin, and the planner then ignores the new index until
    // every transaction older than the build has ended. On the busy shared cluster
    // that made the EXPLAIN below fall back to a disabled Sort over a disabled Seq
    // Scan on some runs (WI-6554700010019308). VACUUM FULL rewrites the heap without
    // HOT chains, so the build cannot mark the index.
    await rootSql.unsafe('VACUUM FULL harness_shared.session_turns');
    await rootSql.unsafe(`CREATE INDEX native_source_hnsw_test
      ON harness_shared.session_turns USING hnsw (text_embedding vector_cosine_ops)
      WITH (m = 4, ef_construction = 8)`);
    const [indexState] = await rootSql<{ indcheckxmin: boolean }[]>`SELECT indcheckxmin
      FROM pg_index WHERE indexrelid = 'harness_shared.native_source_hnsw_test'::regclass`;
    // If this fails, the plan assertion below is timing-dependent again.
    expect(indexState?.indcheckxmin).toBe(false);
    try {
      await rootSql.begin(async tx => {
        await tx.unsafe('SET LOCAL enable_seqscan = off');
        await tx.unsafe('SET LOCAL enable_sort = off');
        await tx.unsafe('SET LOCAL hnsw.iterative_scan = relaxed_order');
        await tx.unsafe('SET LOCAL hnsw.ef_search = 1');
        await tx.unsafe('SET LOCAL hnsw.max_scan_tuples = 1');
        const plan = await tx`EXPLAIN (FORMAT JSON) SELECT session_id
          FROM harness_shared.session_turns WHERE owner = ${owner}
          ORDER BY text_embedding <=> ${JSON.stringify(vecAt(0))}::vector LIMIT 1`;
        expect(JSON.stringify(plan)).toContain('native_source_hnsw_test');
        // A global ANN scan can stop before reaching this existing source.
        // The router must measure within the eligible native population.
        const exact = await tx`SELECT session_id FROM harness_shared.session_turns
          WHERE session_id = ${'sess-' + owner} AND owner = ${owner}`;
        expect(exact).toHaveLength(1);
        nativeTurnQuery = null;
        recordNativeTurnQuery = true;
        const result = await routeConsult({ ...baseParams, question: 'native source evidence',
          nativeConsult: { ...nativeConsult, requireSourcePlanClaims: true },
          turnLimit: 1, maxCandidates: 1, maxQualified: 1 },
        deps(0, { getSql: () => tx as unknown as Sql }));
        recordNativeTurnQuery = false;
        expect(nativeTurnQuery).not.toBeNull();
        // Verify the actual router query, not only a simpler lookalike query.
        const executedPlan = await tx.unsafe('EXPLAIN (FORMAT JSON) ' + nativeTurnQuery!.query,
          nativeTurnQuery!.parameters as never[]);
        const planText = JSON.stringify(executedPlan);
        expect(planText.includes('native_source_hnsw_test') || planText.includes('native_turns')).toBe(true);
        expect(result.qualified.map(candidate => candidate.ownerId)).toEqual([owner]);
        expect(result.snapshot.simFloor).toBe(DEFAULT_SIM_FLOOR);
        expect(result.snapshot.relevanceFloor).toBe(DEFAULT_RELEVANCE_FLOOR);
      });
    } finally {
      recordNativeTurnQuery = false;
      await rootSql.unsafe('DROP INDEX IF EXISTS harness_shared.native_source_hnsw_test');
    }
  });
});

describe('bounded subject evidence against real transcript SQL', () => {
  const question = 'stale desktop registry rows block computer:provision_desktop; invoke soleOwner reconciliation?';
  let addedOwners: string[] = [];
  afterEach(async () => {
    if (addedOwners.length) await rootSql`DELETE FROM harness_shared.session_turns WHERE owner = ANY(${addedOwners}::text[])`;
    addedOwners = [];
  });
  async function passage(owner: string, text: string, angle: number, previouslyChunked = false) {
    addedOwners.push(owner);
    await insertTurn(owner, angle, DAY);
    if (previouslyChunked) {
      await rootSql`UPDATE harness_shared.session_turns SET chunked_at = ${NOW.toISOString()}::timestamptz WHERE owner = ${owner}`;
    }
    await rootSql`UPDATE harness_shared.session_turns SET text = ${text}, chunked_at = NULL WHERE owner = ${owner}`;
  }

  it('invalidates a previous chunk marker when replacing fixture transcript text', async () => {
    await passage('subject-chunk-marker', 'replacement transcript', 0, true);
    const rows = await rootSql`SELECT text, chunked_at FROM harness_shared.session_turns WHERE owner = 'subject-chunk-marker'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'replacement transcript', chunked_at: null });
  });

  it('rejects the sole-live-gate collision while keeping direct and conceptual expertise', async () => {
    await passage('subject-gate', 'The ownership cell is held-live; this is the sole live gate lane. Do not run the checkpoint.', 0);
    await passage('subject-direct', 'Fixed computer:provision_desktop stale rows on desktop_sessions_live_display_uq.', 0.1);
    await passage('subject-concept', 'Xvfb screen allocations use database leases; reclaim an orphan only after verifying the former process died.', 0.2);
    const seen: string[] = [];
    const result = await routeConsult({ ...baseParams, question }, deps(0, {
      scoreSubjectEvidence: async (subject, texts, deadline) => {
        expect(subject).toBe('computer:provision_desktop');
        expect(deadline - Date.now()).toBeLessThanOrEqual(SUBJECT_EVIDENCE_TIMEOUT_MS);
        seen.push(...texts);
        return texts.map(text => text.includes('Xvfb') ? 0.692 : text.includes('Fixed computer:') ? 0.902 : 0.350);
      },
    }));
    expect(seen.some(text => text.includes('Xvfb'))).toBe(true);
    expect(result.qualified.map(c => c.ownerId)).toEqual(['subject-direct', 'subject-concept']);
    const gate = result.snapshot.candidates.find(c => c.ownerId === 'subject-gate')!;
    expect(gate.signals.similarity).toBe(1);
    expect(snapshotCandidateQualifies(result.snapshot, gate)).toBe(false);
    expect(snapshotCandidateQualifies(result.snapshot, {
      ...gate,
      subjectEvidence: undefined,
      subjectEvidenceCoverage: undefined,
    })).toBe(true);
    expect(result.snapshot.subjectValidation?.unmeasured).toBe(0);
  });

  it('validates the complete natural lease question instead of generic before/after history', async () => {
    const leaseQuestion = 'For native isolated session-port consults, what evidence distinguishes child mutation of source plan leases from legitimate source renewal, system cleanup, and mutate-then-revert? I need a concrete actor-correlated before/after audit that preserves the original native receipt when timeout cleanup runs.';
    await passage('subject-generic-history', 'Verified continuation identity and AUTO state before/after recovering the storage scanner.', 0);
    await passage('subject-lease-actor', 'A claim ledger recorded the source lease writer and actor on each renewal, child mutation, revert and timeout-cleanup transition; retain the original native receipt.', 0.1);
    const subjects: string[] = [];
    const result = await routeConsult({ ...baseParams, question: leaseQuestion }, deps(0, {
      scoreSubjectEvidence: async (subject, texts) => {
        subjects.push(subject);
        // A broad procedural token explains both passages. The actual question
        // requires lease/actor evidence; vector geometry cannot supply it.
        return texts.map(text => subject === leaseQuestion ? text.includes('claim ledger') ? 0.9 : 0.1 : 0.8);
      },
    }));
    expect(subjects).toEqual([leaseQuestion]);
    expect(result.qualified.map(c => c.ownerId)).toEqual(['subject-lease-actor']);
    const generic = result.snapshot.candidates.find(c => c.ownerId === 'subject-generic-history')!;
    expect(generic.signals.similarity).toBe(1);
    expect(generic.subjectEvidenceCoverage).toMatchObject({ status: 'mismatch', required: [leaseQuestion] });
    expect(snapshotCandidateQualifies(result.snapshot, generic)).toBe(false);
    // Explicit caller anchors still take precedence over this fallback.
    const explicit = await routeConsult({ ...baseParams, question: leaseQuestion, subjectRefs: ['src/lease.ts'] }, deps(0, {
      scoreSubjectEvidence: async (subject, texts) => {
        expect(subject).toBe('src/lease.ts');
        return texts.map(() => 0.9);
      },
    }));
    expect(explicit.snapshot.subjectRefs).toEqual(['src/lease.ts']);
  });

  it('leaves an overlapping-contract expert unmeasured while admitting a distinct absolute-floor win', async () => {
    await passage('subject-tied', 'equal release gate checkpoint', 0);
    await passage('subject-floor', 'distinct release gate checkpoint', 0.1);
    const contracts = [
      { name: 'computer:provision_desktop', description: 'Start a sandboxed GUI desktop.' },
      { name: 'release:checkpoint-run', description: 'Run the release gate checkpoint suite.' },
    ];
    const result = await routeConsult({ ...baseParams, question }, deps(0, {
      scoreSubjectEvidence: (subject, texts, deadline) => scoreSubjectEvidence(subject, texts, deadline, {
        contracts,
        scorer: async text => text.startsWith('distinct') ? [0.5, 0.1] : [0.8, 0.8],
      }),
    }));
    const tied = result.snapshot.candidates.find(c => c.ownerId === 'subject-tied')!;
    expect(tied.subjectEvidence).toMatchObject({ status: 'unmeasured', score: null });
    expect(snapshotCandidateQualifies(result.snapshot, tied)).toBe(false);
    const floor = result.snapshot.candidates.find(c => c.ownerId === 'subject-floor')!;
    expect(floor.subjectEvidence).toMatchObject({ status: 'supported', score: 0.5 });
    expect(result.qualified.map(c => c.ownerId)).toEqual(['subject-floor']);
    expect(result.snapshot.subjectValidation?.unmeasured).toBeGreaterThan(0);
    expect(result.snapshot.degraded).toBe('evidence-unavailable');
  });

  it('distinguishes failed/malformed scores from a measured no-expert case', async () => {
    for (const scoreSubjectEvidence of [async () => { throw new Error('scorer unavailable'); }, async () => [], async (_q: string, texts: string[]) => texts.map(() => NaN)]) {
      const result = await routeConsult({ ...baseParams, question }, deps(0, { scoreSubjectEvidence }));
      expect(result.verdict).toBe('relevance_unmeasured');
      expect(result.snapshot.degraded).toBe('evidence-unavailable');
      expect(result.qualified).toEqual([]);
    }
    const measured = await routeConsult({ ...baseParams, question }, deps(0, { scoreSubjectEvidence: async (_q, texts) => texts.map(() => 0.1) }));
    expect(measured.verdict).toBe('no_qualified_responder');
    expect(measured.snapshot.subjectValidation?.unmeasured).toBe(0);
  });

  it('caps scored owners and leaves overflow explicitly unmeasured', async () => {
    for (let i = 0; i < SUBJECT_EVIDENCE_OWNER_LIMIT + 2; i++) await passage(`subject-cap-${i}`, 'virtual screen lease diagnosis', i * 0.01);
    let pairs = 0;
    const result = await routeConsult({ ...baseParams, question }, deps(0, {
      scoreSubjectEvidence: async (_q, texts) => { pairs = texts.length; return texts.map(() => 0.9); },
    }));
    expect(pairs).toBeLessThanOrEqual(SUBJECT_EVIDENCE_OWNER_LIMIT * 3);
    expect(result.snapshot.subjectValidation?.unmeasured).toBeGreaterThan(0);
    expect(result.snapshot.degraded).toBe('evidence-unavailable');
    expect(result.qualified.length).toBeGreaterThan(0);
  });
});

describe('shared routing telemetry in the real invocation ledger', () => {
  beforeEach(async () => {
    await rootSql`DELETE FROM harness_shared.route_invocations WHERE workspace_id = ${WS}`;
  });

  it('persists the exact returned stage receipt and remains distinct from HTTP/MCP invocations', async () => {
    const writes: Promise<void>[] = [];
    const result = await routeConsult({ ...baseParams, telemetry: {
      caller: 'fixture-consult', policy: 'consult-default', buildSha: '1234567', correlationId: 'ledger-success',
    } }, deps(0, { recordTelemetry: r => { writes.push(recordExpertiseRoutingInvocation(r, rootSql)); } }));
    await Promise.all(writes);
    const rows = await rootSql<{ method: string; path: string; metadata_json: ExpertiseRoutingReceipt }[]>`
      SELECT method, path, metadata_json FROM harness_shared.route_invocations
       WHERE workspace_id = ${WS} AND metadata_json->>'correlationId' = 'ledger-success'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('INTERNAL');
    expect(rows[0].path).toBe(EXPERTISE_ROUTING_PATH);
    expect(rows[0].metadata_json).toEqual(result.snapshot.measurement);
    const executionHealth = await readExpertiseExecutionHealth(rootSql, WS, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
    expect(executionHealth).toMatchObject({ status: 'measured', cohort: 'routing-execution-start', rowsScanned: 1, invalidReceipts: 0 });
    expect(executionHealth.groups).toEqual([expect.objectContaining({
      caller: 'fixture-consult', policy: 'consult-default', buildSha: '1234567', calls: 1,
      outcomes: { returned: 1, degraded: 0, threw: 0 },
      latencyMs: { observed: 1, p50: rows[0].metadata_json.durationMs, p95: rows[0].metadata_json.durationMs },
    })]);
    // Counterexample: postgres.js serializes a string AGAIN when PG describes
    // its parameter as jsonb. The writer must bind text before converting it.
    const legacy = await rootSql.unsafe<{ kind: string }[]>(
      'SELECT jsonb_typeof($1::jsonb) AS kind', [JSON.stringify(rows[0].metadata_json)],
    );
    expect(legacy[0].kind).toBe('string');
    expect(rows[0].metadata_json.stages).toMatchObject({
      disclosure: { outcome: 'returned' }, embedding: { outcome: 'returned' },
      transcripts: { outcome: 'returned' }, verification: { outcome: 'returned' }, ranking: { outcome: 'returned' },
    });
    expect(JSON.stringify(rows[0].metadata_json)).not.toContain(baseParams.question);
  });

  it('persists a thrown pre-consult route even when no consultation was created', async () => {
    const writes: Promise<void>[] = [];
    const error = Object.assign(new Error('private database details'), { code: '57P01' });
    await expect(routeConsult({ ...baseParams, telemetry: {
      caller: 'fixture-preview', policy: 'consult-default', buildSha: null, correlationId: 'ledger-throw',
    } }, deps(0, {
      getSql: () => { throw error; },
      recordTelemetry: r => { writes.push(recordExpertiseRoutingInvocation(r, rootSql)); },
    }))).rejects.toBe(error);
    await Promise.all(writes);
    const rows = await rootSql<{ metadata_json: ExpertiseRoutingReceipt }[]>`
      SELECT metadata_json FROM harness_shared.route_invocations
       WHERE workspace_id = ${WS} AND metadata_json->>'correlationId' = 'ledger-throw'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata_json).toMatchObject({ caller: 'fixture-preview', outcome: 'threw', verdict: null, errorCode: '57P01' });
    expect(JSON.stringify(rows)).not.toContain('private database');
  });

  it('exposes recorder failures independently of ledger cohorts without replacing the original error', async () => {
    const before = readExpertiseRoutingRecorderHealth();
    const error = Object.assign(new Error('private recorder failure'), { code: '57P01' });
    const receipt: ExpertiseRoutingReceipt = {
      schemaVersion: 1, correlationId: 'sink-failure', workspaceId: WS, requesterId: 'fixture-requester',
      caller: 'fixture-recorder', policy: 'consult-default', buildSha: null,
      startedAt: NOW.toISOString(), durationMs: 1, outcome: 'threw', verdict: null, errorCode: null, stages: {},
    };
    const failingSql = { begin: async () => { throw error; } } as unknown as Sql;
    await expect(recordExpertiseRoutingInvocation(receipt, failingSql)).rejects.toBe(error);
    const after = readExpertiseRoutingRecorderHealth();
    expect(after).toMatchObject({
      scope: 'serving-process', attempted: before.attempted + 1, persisted: before.persisted,
      failed: before.failed + 1, pending: before.pending,
      lastFailure: { code: '57P01', caller: 'fixture-recorder', policy: 'consult-default' },
    });
    expect(JSON.stringify(after)).not.toContain('private');
    const health = await readExpertiseExecutionHealth(rootSql, WS, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
    expect(health).toMatchObject({ status: 'measured-empty', rowsScanned: 0, groups: [] });
  });
});

describe('routeConsult — routing + blend', () => {
  it('routes to the similar+recent+verified owner; snapshot carries the D-008 shape', async () => {
    const r = await routeConsult(baseParams, deps(0));
    expect(r.verdict).toBe('routed');
    expect(r.qualified[0]?.ownerId).toBe('agent-alpha');
    const alpha = r.qualified[0]!;
    expect(alpha.signals.similarity).toBeGreaterThan(0.95); // cos(0.15) ≈ 0.989
    expect(alpha.signals.verification).toBeCloseTo(5 / 9, 2); // 5 committed / (5+4)
    expect(alpha.signals.authorship).toBe(0); // question names no path
    // alpha holds the freshest qualified transcript, so it IS the stage-2
    // reference point: zero relative age, full freshness (D-001 §2).
    expect(alpha.relativeAgeDays).toBe(0);
    expect(alpha.signals.freshness).toBe(1);
    expect(alpha.score).toBeCloseTo(alpha.relevance, 10);
    expect(alpha.evidence.length).toBeGreaterThan(0);
    expect(alpha.evidence[0]).toMatchObject({ session_id: 'sess-agent-alpha' });
    expect(alpha.evidence[0]!.sim).toBeGreaterThan(0.95);
    // Snapshot invariants (persisted verbatim into consult_state.routing).
    expect(r.snapshot.query).toBe(baseParams.question);
    expect(r.snapshot.relevanceFloor).toBe(DEFAULT_RELEVANCE_FLOOR);
    expect(r.snapshot.simFloor).toBe(DEFAULT_SIM_FLOOR);
    expect(r.snapshot.candidates.map((c) => c.ownerId)).toContain('agent-beta');
    expect(r.snapshot.degraded).toBeUndefined();
  });

  it('excludes the requester — a perfect-similarity own turn never self-routes', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-self');
  });

  it('excludes machine-surface turns — injected boilerplate is not engagement', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-machineonly');
  });

  it('excludes agent-injected loop-fire turns — replayed carry notes are not engagement', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-looponly');
  });

  it('does not route an amendment review using a high-similarity fork that reviewed a different rubric', async () => {
    const targetRef = 'acceptance-pui-first-party-public-release-2026-09-07';
    const differentRef = 'acceptance-pui-chat-first-ux-2026-09-28';
    const question =
      `Outside-lineage review of a started acceptance-BAR amendment to ${targetRef}. ` +
      'The relevance router picked you and screened you with rubrics:check-approver.';
    const vectorAt = (theta: number) => {
      const vector = new Array<number>(768).fill(0);
      vector[100] = Math.cos(theta);
      vector[101] = Math.sin(theta);
      return vector;
    };
    const insertReviewTurn = async (owner: string, text: string, theta: number) => {
      turnSeq += 1;
      await rootSql`
        INSERT INTO harness_shared.session_turns
          (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
           text_embedding, text_embedding_mode, text_embedding_profile)
        VALUES ('default', 'claude', ${'sess-subject-' + owner}, ${turnSeq}, ${NOW.toISOString()}::timestamptz,
                ${owner}, 'user', ${text}, ${JSON.stringify(vectorAt(theta))}::vector,
                'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId})`;
    };
    await insertReviewTurn(
      'fork-reviewing-different-rubric',
      'subjectanchor Outside-lineage review of a started acceptance-BAR amendment to ' +
        differentRef +
        '. The relevance router picked you and screened you with rubrics:check-approver.',
      0,
    );
    await insertReviewTurn(
      'reviewer-on-target-rubric',
      'subjectanchor Detailed review notes for rubric ' +
        targetRef +
        ': the amendment changes the acceptance bar and its falsifier.',
      0.15,
    );
    await insertReviewTurn(
      'reviewer-on-near-target-rubric',
      'subjectanchor Detailed review notes for rubric ' +
        targetRef +
        '-followup: the amendment changes the acceptance bar and its falsifier.',
      0.2,
    );

    const routeDeps = { ...deps(0), embed: async () => vectorAt(0) };
    const unscoped = await routeConsult(
      { workspaceId: WS, requesterId: 'review-requester', question },
      routeDeps,
    );
    expect(unscoped.qualified[0]?.ownerId).toBe('fork-reviewing-different-rubric');

    const scoped = await routeConsult(
      { workspaceId: WS, requesterId: 'review-requester', question, subjectRef: targetRef },
      routeDeps,
    );
    expect(scoped.qualified.map((candidate) => candidate.ownerId)).toEqual(['reviewer-on-target-rubric']);

    // A decision id used as a trial tag is still an exact corpus predicate.
    // An empty filtered trial does not exercise subject scoring.
    const scoreUnusedFilter = vi.fn(async (_subject: string, texts: string[]) => texts.map(() => 0.9));
    const unusedFilter = await routeConsult(
      { workspaceId: WS, requesterId: 'review-requester', question, subjectRef: 'D-029' },
      { ...routeDeps, scoreSubjectEvidence: scoreUnusedFilter },
    );
    expect(unusedFilter.snapshot.candidates).toEqual([]);
    expect(unusedFilter.snapshot.subjectValidation).toBeUndefined();
    expect(scoreUnusedFilter).not.toHaveBeenCalled();

    const lexicalScoped = await routeConsult(
      {
        workspaceId: WS,
        requesterId: 'review-requester',
        question: 'subjectanchor review amendment',
        subjectRef: targetRef,
      },
      deps(null),
    );
    expect(lexicalScoped.snapshot.candidates.map((candidate) => candidate.ownerId)).toEqual([
      'reviewer-on-target-rubric',
    ]);
  });

  it('requires supported evidence for every resolved anchor and fails closed on incomplete documents', async () => {
    const owners = ['manual-anchor-complete', 'manual-anchor-partial'];
    const subjectRefs = ['src/billing.ts', 'src/backup.ts'];
    const question = 'Review the public manual source anchors for billing and backup behavior.';
    try {
      await insertTurn(owners[0]!, 0.1, DAY, { text: 'Reviewed billing reconciliation and backup recovery in production.' });
      await insertTurn(owners[1]!, 0.12, DAY, { text: 'Reviewed billing reconciliation in production.' });

      const scoreCoverage = async (subject: string, texts: string[]) => {
        const topic = subject === 'src/billing.ts' ? 'billing' : 'backup';
        return texts.map(text => text.includes(topic) ? 0.95 : 0.1);
      };
      const covered = await routeConsult({ ...baseParams, question, subjectRefs }, deps(0, {
        scoreSubjectEvidence: scoreCoverage,
      }));

      expect(covered.snapshot.subjectRefs).toEqual(subjectRefs);
      expect(covered.qualified.map(candidate => candidate.ownerId)).toEqual(['manual-anchor-complete']);
      expect(covered.snapshot.candidates.find(candidate => candidate.ownerId === 'manual-anchor-complete')?.subjectEvidenceCoverage)
        .toMatchObject({ status: 'supported', required: subjectRefs, unresolved: [] });
      expect(covered.snapshot.candidates.find(candidate => candidate.ownerId === 'manual-anchor-partial')?.subjectEvidenceCoverage)
        .toMatchObject({
          status: 'mismatch',
          evidence: [
            { subject: 'src/billing.ts', status: 'supported' },
            { subject: 'src/backup.ts', status: 'mismatch' },
          ],
        });

      const incomplete = await routeConsult({
        ...baseParams,
        question,
        subjectRefs,
        unresolvedSubjectRefs: ['apps/papercusp-docs/src/content/docs/incomplete.mdx'],
      }, deps(0, { scoreSubjectEvidence: scoreCoverage }));
      expect(incomplete.qualified).toEqual([]);
      expect(incomplete.snapshot.unresolvedSubjectRefs).toEqual(['apps/papercusp-docs/src/content/docs/incomplete.mdx']);
      expect(incomplete.snapshot.subjectValidation).toMatchObject({
        subjects: subjectRefs,
        unresolved: ['apps/papercusp-docs/src/content/docs/incomplete.mdx'],
        unmeasured: expect.any(Number),
      });
      expect(incomplete.snapshot.subjectValidation?.unmeasured).toBeGreaterThanOrEqual(2);
      const checked = incomplete.snapshot.candidates.filter(candidate => candidate.subjectEvidenceCoverage);
      expect(checked.length).toBeGreaterThanOrEqual(2);
      expect(checked.every(candidate => candidate.subjectEvidenceCoverage?.status === 'unmeasured')).toBe(true);
    } finally {
      await rootSql`DELETE FROM harness_shared.session_turns WHERE owner = ANY(${owners}::text[])`;
    }
  });

  it('R-13/D-001: 40 days of idleness does NOT disqualify — beta still clears the floor, it just ranks last', async () => {
    // The pre-D-001 router scored beta 0.55×0.660 + 0.15×recency(40d) ≈ 0.38
    // against a 0.5 blended floor and dropped it. That was the vacation defect:
    // beta's TRANSCRIPT never got less relevant, only older. Its relevance is
    // unchanged at ≈0.427, which is above the 0.412 floor, so it qualifies —
    // and the cost of being stale is paid in the ORDERING instead.
    const r = await routeConsult(baseParams, deps(0));
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(beta).toBeDefined();
    expect(beta!.signals.similarity).toBeGreaterThan(0.6);
    expect(beta!.signals.verification).toBe(0); // its only close is 'proposed'
    expect(beta!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR);
    expect(r.qualified.map((c) => c.ownerId)).toContain('agent-beta');
    // …and the freshness multiplier is what demotes it: 39 days behind the
    // reference, so it lands below alpha rather than beside it.
    expect(beta!.relativeAgeDays).toBeCloseTo(39, 0);
    expect(beta!.signals.freshness).toBeLessThan(0.3);
    expect(beta!.score).toBeLessThan(r.qualified[0]!.score);
    expect(r.qualified[0]!.ownerId).toBe('agent-alpha');
  });

  it('the freshness multiplier can never zero a qualified expert out of the ranking', async () => {
    // freshness bottoms out at FRESHNESS_BASE, not 0. Without that floor a
    // long-idle expert's score would decay toward zero and the ordering would
    // re-create the disqualification D-001 removed from the floor.
    const r = await routeConsult(baseParams, deps(0));
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta')!;
    expect(beta.signals.freshness).toBeGreaterThanOrEqual(0.2);
    expect(beta.score).toBeGreaterThan(0);
  });

  it('annotates liveness from the injected oracle, defaulting to unknown', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, { getLiveness: async () => ({ 'agent-alpha': 'live' }) }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(alpha!.liveness).toBe('live');
    expect(beta!.liveness).toBe('unknown');
  });

  it('carries the oracle warmIdle signal into the routing snapshot', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, {
        getLiveness: async () => ({
          'agent-alpha': { sessionState: 'parked', warmIdle: true },
        }),
      }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    expect(alpha).toMatchObject({ liveness: 'parked', warmIdle: true });
  });

  it('carries the canonical ownerPaused signal into the routing snapshot', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, {
        getLiveness: async () => ({
          'agent-alpha': { sessionState: 'live', ownerPaused: true },
        }),
      }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    expect(alpha).toMatchObject({ liveness: 'live', ownerPaused: true });
  });

  it('authorship: a question naming a path boosts the owner whose completed work touched it', async () => {
    const r = await routeConsult(
      { ...baseParams, question: 'who understands packages/operator-core/lib/consult/relevance-router.ts?' },
      deps(0),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(alpha!.signals.authorship).toBeGreaterThan(0);
    expect(beta!.signals.authorship).toBe(0);
  });
});

describe('routeConsult — D-003 honesty invariants', () => {
  it('far query → first-class no_qualified_responder with the audit-trail candidates kept', async () => {
    const r = await routeConsult(baseParams, deps(-1.3)); // sim to best owner ≈ cos(1.45) ≈ 0.12
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    // The snapshot still records what WAS considered — the calibration feed.
    expect(r.snapshot.candidates.length).toBeGreaterThan(0);
    for (const c of r.snapshot.candidates) expect(c.signals.similarity).toBeLessThan(DEFAULT_SIM_FLOOR);
  });

  it('the HARD sim sub-floor blocks a high-track-record owner even when its relevance clears the floor', async () => {
    // Weights tilted toward track record so agent-subfloor's RELEVANCE clears
    // the floor: (sim .362×.3 + ver ~.93×.3) / .7 ≈ 0.55 ≥ 0.41.
    const r = await routeConsult(
      { ...baseParams, weights: { similarity: 0.3, verification: 0.3, authorship: 0.1 } },
      deps(0),
    );
    const sub = r.snapshot.candidates.find((c) => c.ownerId === 'agent-subfloor');
    expect(sub).toBeDefined();
    expect(sub!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR); // relevance alone WOULD pass…
    expect(sub!.signals.similarity).toBeLessThan(DEFAULT_SIM_FLOOR); // …but similarity is sub-floor…
    expect(r.qualified.map((c) => c.ownerId)).not.toContain('agent-subfloor'); // …so it must not qualify.
  });

  it('no embedder → unmeasured, NOT a measured absence of qualified peers', async () => {
    const r = await routeConsult(baseParams, deps(null));
    // `no_qualified_responder` would claim similarity was computed and nobody
    // cleared the floor. Nothing was computed here, so the router has no claim
    // to make about the peer population at all (EI-21485716602970457).
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.verdict).not.toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    expect(r.snapshot.degraded).toBe('embed-unavailable');
    expect(r.snapshot.candidates).toEqual([]);
  });

  it('no embedder → bounded lexical fallback keeps measurable ranking but no semantic qualification', async () => {
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, turn_origin_verdict)
      VALUES
        ('default', 'claude', 'sess-lexical-best', 1, ${NOW.toISOString()}::timestamptz,
         'agent-lexical-best', 'assistant', 'consult router fallback evidence for manual review', NULL),
        ('default', 'claude', 'sess-lexical-second', 1, ${new Date(NOW.getTime() - DAY).toISOString()}::timestamptz,
         'agent-lexical-second', 'assistant', 'consult router fallback notes', NULL),
        ('default', 'claude', 'sess-lexical-loop', 1, ${NOW.toISOString()}::timestamptz,
         'agent-lexical-loop', 'assistant', 'consult router fallback evidence for manual review', 'agent-injected')
    `;
    const r = await routeConsult(
      { ...baseParams, question: 'consult router fallback' },
      deps(null, { getLiveness: async (owners) => Object.fromEntries(owners.map((owner) => [owner, 'live'])) }),
    );
    // Lexical candidates DO come back here — which is exactly why the verdict
    // must not read as "nobody qualified": they were never ranked for relevance.
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.qualified).toEqual([]);
    expect(r.snapshot.degraded).toBe('embed-unavailable');
    expect(r.snapshot.fallback).toBe('lexical');
    expect(r.snapshot.candidates.map((c) => c.ownerId)).toEqual([
      'agent-lexical-best',
      'agent-lexical-second',
    ]);
    expect(r.snapshot.candidates[0]).toMatchObject({ fallback: 'lexical' });
    expect(r.snapshot.candidates[0]!.score).toBeGreaterThan(0);
    expect(r.snapshot.candidates[0]!.signals.similarity).toBe(0);
    expect(r.snapshot.candidates[0]!.evidence[0]!.lexicalRank).toBeGreaterThan(0);
    expect(r.queryVec).toBeNull();
  });

  it('an embedder that throws degrades the same way', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, { embed: async () => { throw new Error('sidecar down'); } }),
    );
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.snapshot.degraded).toBe('embed-unavailable');
  });
});

// P-007 FALSIFIABILITY CONTROLS — prove each honesty verdict above is caused by
// the mechanism the test names, not vacuously true. A router whose candidate
// discovery silently broke would ALSO answer no_qualified_responder to every
// scenario above; these controls are what make that failure mode detectable.
// (Same calibration-control idiom as the identity-scan gate's "a clean bundle
// passes" test: without a control, fail-on-everything satisfies every assertion.)
describe('routeConsult — P-007 falsifiability controls', () => {
  it('CONTROL: the far-query no-route is FLOOR-driven — zeroed floors ROUTE the identical scenario', async () => {
    // Identical far embedder to the honesty test (sim ≈ 0.12 for the best owner);
    // only the floors change. If this routes, the far-query no_qualified_responder
    // verdict above is attributable to the floors, not to a dead pipeline.
    const r = await routeConsult({ ...baseParams, relevanceFloor: 0, simFloor: 0 }, deps(-1.3));
    expect(r.verdict).toBe('routed');
    expect(r.qualified.length).toBeGreaterThan(0);
    // The audit snapshot must echo the floors ACTUALLY applied (D-008: the
    // persisted routing record is the calibration feed — a snapshot that echoes
    // defaults while overrides governed would poison every later re-grade).
    expect(r.snapshot.relevanceFloor).toBe(0);
    expect(r.snapshot.simFloor).toBe(0);
  });

  it('CONTROL: the routed verdict is floor-governed too — an unreachable floor no-routes the happy path', async () => {
    // Relevance renormalizes a convex combination of [0,1] signals, so it can
    // never exceed 1 and a 1.01 floor is unreachable. If this still routed, the
    // floor filter would be decorative and every no_qualified_responder
    // assertion above would be testing nothing.
    const r = await routeConsult({ ...baseParams, relevanceFloor: 1.01 }, deps(0));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    // Candidates are still recorded — the floor blocks QUALIFICATION, not audit.
    expect(r.snapshot.candidates.length).toBeGreaterThan(0);
  });

  it('CONTROL: the sub-floor exclusion is the SIM sub-floor specifically — zeroing it admits agent-subfloor', async () => {
    // Same tilted weights as the D-003 hard-gate test; only simFloor changes.
    // Qualifying here proves that test excludes agent-subfloor via the sim
    // sub-floor, not via some other filter that would mask a sub-floor regression.
    const r = await routeConsult(
      {
        ...baseParams,
        simFloor: 0,
        weights: { similarity: 0.3, verification: 0.3, authorship: 0.1 },
      },
      deps(0),
    );
    expect(r.qualified.map((c) => c.ownerId)).toContain('agent-subfloor');
  });
});

/**
 * consult-expert-routing-2026-09-22 P-001 — the two-stage router.
 *
 * These own their corpus in a DIFFERENT embedding plane from every fixture
 * above: `vecInPlane(4, …)` / `vecInPlane(6, …)` are orthogonal to the
 * `vecAt()` vectors, so a query here has cosine similarity EXACTLY 0 with the
 * main corpus and none of its owners can clear simFloor. That isolation is
 * load-bearing — the stage-2 reference point is the freshest QUALIFIED
 * candidate, so a stray qualifier from another test's corpus would silently
 * move the baseline these assertions are computed against.
 */
describe('routeConsult — D-001 two-stage: recency compares, never qualifies', () => {
  const vecInPlane = (dim: number, theta: number): number[] => {
    const v = new Array<number>(768).fill(0);
    v[dim] = Math.cos(theta);
    v[dim + 1] = Math.sin(theta);
    return v;
  };
  const planeDeps = (dim: number, theta = 0): ConsultRouteDeps => ({
    ...deps(0),
    embed: async () => vecInPlane(dim, theta),
  });

  let planeSeq = 0;
  async function insertPlaneTurn(owner: string, dim: number, theta: number, tsMsAgo: number) {
    planeSeq += 1;
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
         text_embedding, text_embedding_mode, text_embedding_profile)
      VALUES ('default', 'claude', ${'sess-' + owner}, ${planeSeq},
              ${new Date(NOW.getTime() - tsMsAgo).toISOString()}::timestamptz,
              ${owner}, 'assistant', ${'plane turn of ' + owner},
              ${JSON.stringify(vecInPlane(dim, theta))}::vector,
              'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId})`;
  }

  // Ordering corpus (plane 4). Similarity runs OPPOSITE to freshness on
  // purpose: the STALEST transcript is the most similar. Recency-free
  // relevance therefore ranks stale > mid > fresh, and only the stage-2
  // multiplier can produce the fresh-first order R-9 demands — so an
  // implementation that dropped stage 2 fails on ORDER, not on a tolerance.
  const FRESH = 'plane-fresh';   // θ=0.3, 1d   → sim ≈ 0.955, relevance ≈ 0.618
  const MID = 'plane-mid';       // θ=0.2, 8d   → sim ≈ 0.980, relevance ≈ 0.634
  const STALE = 'plane-stale';   // θ=0.1, 30d  → sim ≈ 0.995, relevance ≈ 0.644
  const ORDERING_OWNERS = [FRESH, MID, STALE];

  const shiftDays = async (owners: string[], days: number) => {
    await rootSql`
      UPDATE harness_shared.session_turns
         SET ts = ts - ${days} * interval '1 day'
       WHERE owner = ANY(${owners}::text[])`;
  };

  beforeAll(async () => {
    await insertPlaneTurn(FRESH, 4, 0.3, 1 * DAY);
    await insertPlaneTurn(MID, 4, 0.2, 8 * DAY);
    await insertPlaneTurn(STALE, 4, 0.1, 30 * DAY);
    // Veteran corpus (plane 6): its ONLY committed completions are far older
    // than the retired 90-day verification window.
    await insertPlaneTurn('plane-veteran', 6, 0.1, 5 * DAY);
    for (let i = 0; i < 4; i++) await insertWorkItem('plane-veteran', 'committed', (200 + i) * DAY, null);
  });

  it('R-13 clause 1 + R-9: every age qualifies, and freshness REVERSES the relevance order', async () => {
    const r = await routeConsult(baseParams, planeDeps(4));
    expect(r.verdict).toBe('routed');
    // Stage 1: all three clear the floor. A 30-day-old transcript is not a
    // worse transcript — this is the assertion the pre-D-001 router failed.
    const byId = new Map(r.snapshot.candidates.map((c) => [c.ownerId, c]));
    for (const owner of ORDERING_OWNERS) {
      expect(byId.get(owner)!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR);
    }
    expect(r.qualified.map((c) => c.ownerId).sort()).toEqual([...ORDERING_OWNERS].sort());
    // Recency-free relevance would order them stale-first…
    expect(byId.get(STALE)!.relevance).toBeGreaterThan(byId.get(MID)!.relevance);
    expect(byId.get(MID)!.relevance).toBeGreaterThan(byId.get(FRESH)!.relevance);
    // …and stage 2 inverts that, which is what "materially higher" means.
    expect(r.qualified.map((c) => c.ownerId)).toEqual([FRESH, MID, STALE]);
  });

  it('R-13 clause 2: a UNIFORM time shift leaves every score bit-for-bit unchanged', async () => {
    const before = await routeConsult(baseParams, planeDeps(4));
    const baseline = before.qualified.map((c) => [c.ownerId, c.score, c.relevance, c.relativeAgeDays] as const);
    // Everyone's history ages by the same 90 days — the vacation case, applied
    // to the whole workspace at once.
    await shiftDays(ORDERING_OWNERS, 90);
    try {
      const after = await routeConsult(baseParams, planeDeps(4));
      expect(after.qualified.map((c) => [c.ownerId, c.score, c.relevance, c.relativeAgeDays] as const)).toEqual(
        baseline,
      );
      // Not merely the same ORDER: the same numbers. An absolute decay term
      // would have multiplied every score by 2^(-90/H) here.
      expect(after.qualified[0]!.score).toBe(before.qualified[0]!.score);
    } finally {
      await shiftDays(ORDERING_OWNERS, -90);
    }
  });

  it('CONTROL: shifting ONE candidate DOES change the ranking — the invariance above is not vacuous', async () => {
    // Same instrument, non-uniform shift. If this also came back unchanged,
    // the test above would be proving that recency is ignored entirely rather
    // than that it is measured relatively.
    await shiftDays([FRESH], 60);
    try {
      const r = await routeConsult(baseParams, planeDeps(4));
      expect(r.qualified.map((c) => c.ownerId)).not.toEqual([FRESH, MID, STALE]);
      expect(r.qualified[0]!.ownerId).toBe(MID);
      // Still QUALIFIED though — the shift moved its rank, never its eligibility.
      expect(r.qualified.map((c) => c.ownerId)).toContain(FRESH);
    } finally {
      await shiftDays([FRESH], -60);
    }
  });

  it('D-007(a): the floor sees the FULL candidate list, not the snapshot slice', async () => {
    // maxCandidates:1 is the pre-D-007 killer — the score-ordered cut ran
    // first, so only the top candidate could ever be measured against the
    // floor and MID/STALE were dropped before qualification.
    const r = await routeConsult({ ...baseParams, maxCandidates: 1 }, planeDeps(4));
    expect(r.qualified.map((c) => c.ownerId).sort()).toEqual([...ORDERING_OWNERS].sort());
    // And the persisted snapshot still explains its own verdict: a returned
    // qualifier is never cut out of the audit record it is the result of.
    for (const owner of ORDERING_OWNERS) {
      expect(r.snapshot.candidates.map((c) => c.ownerId)).toContain(owner);
    }
  });

  it('D-007(b): verification counts completions older than the retired 90-day window', async () => {
    const r = await routeConsult(baseParams, planeDeps(6));
    const vet = r.snapshot.candidates.find((c) => c.ownerId === 'plane-veteran');
    expect(vet).toBeDefined();
    // 4 committed closes, ALL ~200 days old. The old trailing window scored
    // this 0 — an expert's track record decaying purely because they were idle,
    // which is the same vacation defect one signal over.
    expect(vet!.signals.verification).toBeCloseTo(4 / 8, 2);
  });

  it('the snapshot records the half-life it compared with, so an ordering stays re-derivable', async () => {
    const r = await routeConsult({ ...baseParams, recencyHalfLifeDays: 3 }, planeDeps(4));
    expect(r.snapshot.recencyHalfLifeDays).toBe(3);
    // A shorter half-life punishes staleness harder — the setting is live, not
    // decorative (P-005 is what will persist it).
    const stale = r.snapshot.candidates.find((c) => c.ownerId === STALE)!;
    const atDefault = (await routeConsult(baseParams, planeDeps(4))).snapshot.candidates.find(
      (c) => c.ownerId === STALE,
    )!;
    expect(stale.score).toBeLessThan(atDefault.score);
    expect(stale.relevance).toBe(atDefault.relevance); // …but qualification is untouched
  });
});

// Plan personal-data-reader-set-labels-2026-10-01 P-013 / D-006 / D-009: consult
// forks a routed expert's WHOLE transcript, so an expert who has EVER held a
// disclosure is not routable at all, and the count it reports must not depend
// on the question (a per-question count would confirm a guess about the text).
describe('routeConsult — D-006 restricted experts are excluded in SQL', () => {
  async function disclose(owner: string, released = false): Promise<void> {
    await rootSql`
      INSERT INTO harness_shared.personal_disclosures
        (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set,
         delivered_via, delivered_at, released_at, released_by, release_ref)
      VALUES (${WS}, gen_random_uuid(), ${owner}, gen_random_uuid(), 'gmail', 'participants',
              ${['owner@me.example']}::text[], 'personal:search', ${new Date(NOW.getTime() - 90 * DAY).toISOString()}::timestamptz,
              ${released ? new Date(NOW.getTime() - 60 * DAY).toISOString() : null}::timestamptz,
              ${released ? 'owner' : null}, ${released ? 'test-release' : null})`;
  }
  async function turnsOf(owner: string): Promise<number> {
    const [row] = await rootSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_turns
       WHERE owner = ${owner} AND (workspace_id = ${WS} OR workspace_id = 'default')`;
    return row!.n;
  }
  afterEach(async () => {
    await rootSql`DELETE FROM harness_shared.personal_disclosures`;
  });

  it('never routes to an expert who held a disclosure and reports the same count for a near and a far question', async () => {
    const before = await routeConsult(baseParams, deps(0));
    expect(before.qualified[0]?.ownerId).toBe('agent-alpha');
    expect(before.snapshot.withheld).toBeUndefined();

    await disclose('agent-alpha');
    const near = await routeConsult(baseParams, deps(0));
    expect(near.snapshot.candidates.map((c) => c.ownerId)).not.toContain('agent-alpha');
    expect(near.qualified.map((c) => c.ownerId)).not.toContain('agent-alpha');
    expect(near.snapshot.withheld).toEqual({
      restricted_turns: await turnsOf('agent-alpha'),
      restricted_owners: 1,
      rule: D006_TRANSCRIPT_RULE,
    });
    expect(near.snapshot.withheld!.restricted_turns).toBeGreaterThan(0);
    // D-009: the count is a property of the ledger, never of the question.
    const far = await routeConsult(baseParams, deps(-1.3));
    expect(far.snapshot.withheld).toEqual(near.snapshot.withheld);
  });

  it('a released disclosure still excludes the expert — its transcript still holds the content', async () => {
    await disclose('agent-alpha', true);
    const r = await routeConsult(baseParams, deps(0));
    expect(r.snapshot.candidates.map((c) => c.ownerId)).not.toContain('agent-alpha');
    expect(r.snapshot.withheld?.restricted_owners).toBe(1);
  });

  it("does not count the requester's own disclosure against it", async () => {
    await disclose('agent-self');
    const r = await routeConsult(baseParams, deps(0));
    expect(r.snapshot.withheld).toBeUndefined();
    expect(r.qualified[0]?.ownerId).toBe('agent-alpha');
  });

  it('the lexical fallback excludes a restricted expert the same way', async () => {
    const word = 'quokkafluxion';
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
      VALUES ('default', 'claude', 'sess-lex-a', 1, ${NOW.toISOString()}::timestamptz, 'agent-lex-a', 'assistant', ${'the ' + word + ' detail'}),
             ('default', 'claude', 'sess-lex-b', 1, ${NOW.toISOString()}::timestamptz, 'agent-lex-b', 'assistant', ${'another ' + word + ' detail'})`;
    try {
      const params = { ...baseParams, question: word };
      const open = await routeConsult(params, deps(null));
      expect(open.snapshot.candidates.map((c) => c.ownerId)).toEqual(expect.arrayContaining(['agent-lex-a', 'agent-lex-b']));

      await disclose('agent-lex-a');
      const closed = await routeConsult(params, deps(null));
      const owners = closed.snapshot.candidates.map((c) => c.ownerId);
      expect(owners).toContain('agent-lex-b');
      expect(owners).not.toContain('agent-lex-a');
      expect(closed.snapshot.withheld).toMatchObject({ restricted_owners: 1, restricted_turns: 1 });
    } finally {
      await rootSql`DELETE FROM harness_shared.session_turns WHERE owner IN ('agent-lex-a', 'agent-lex-b')`;
    }
  });

  it('refuses rather than routing unfiltered when the ledger cannot be read', async () => {
    await rootSql.unsafe('ALTER TABLE harness_shared.personal_disclosures RENAME TO personal_disclosures_gone');
    try {
      await expect(routeConsult(baseParams, deps(0))).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
    } finally {
      await rootSql.unsafe('ALTER TABLE harness_shared.personal_disclosures_gone RENAME TO personal_disclosures');
    }
  });
});

describe('extractPathTokens', () => {
  it('extracts slash paths, trims trailing punctuation, caps at 4, dedupes', () => {
    expect(extractPathTokens('see packages/foo/bar.ts.')).toEqual(['packages/foo/bar.ts']);
    expect(extractPathTokens('no paths here at all')).toEqual([]);
    expect(
      extractPathTokens('a/b.ts c/d.ts a/b.ts e/f.ts g/h.ts i/j.ts'),
    ).toHaveLength(4);
  });
});

describe('fetchTurnExcerpts (P-010 dead-context retrieval — the SQL seam)', () => {
  // Dedicated rows: exact (session_id, turn_idx) match means the router corpus
  // above cannot interfere, and vice versa.
  const SESS = 'sess-excerpt-fixture';
  beforeAll(async () => {
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, text_embedding)
      VALUES
        ('default', 'claude', ${SESS}, 9001, ${NOW.toISOString()}::timestamptz,
         'agent-exc', 'assistant', ${'long turn: ' + 'y'.repeat(1000)}, ${JSON.stringify(vecAt(0))}::vector),
        ('default', 'claude', ${SESS}, 9002, ${NOW.toISOString()}::timestamptz,
         'agent-exc', 'assistant', 'short turn body', ${JSON.stringify(vecAt(0.1))}::vector)
    `;
  });

  it('round-trips evidence refs to capped excerpt text, best-sim first, skipping misses', async () => {
    const { fetchTurnExcerpts, PLAN_START_EXCERPT_CHARS } = await import('./plan-start-consult');
    const out = await fetchTurnExcerpts(rootSql, WS, [
      {
        ownerId: 'agent-exc',
        evidence: [
          { session_id: SESS, turn_idx: 9002, ts: NOW.toISOString(), sim: 0.9 },
          { session_id: SESS, turn_idx: 9001, ts: NOW.toISOString(), sim: 0.6 },
          // A miss (no such turn) must be skipped, never an error/empty-out.
          { session_id: 'sess-no-such', turn_idx: 1, ts: null, sim: 0.99 },
        ],
      },
    ]);
    // The miss had the top sim but resolves to nothing; the two hits come back
    // ordered by sim desc.
    expect(out.map((e) => e.turn_idx)).toEqual([9002, 9001]);
    expect(out[0].excerpt).toBe('short turn body');
    expect(out[1].excerpt.length).toBe(PLAN_START_EXCERPT_CHARS);
    expect(out[1].excerpt.startsWith('long turn: yyy')).toBe(true);
    expect(out.every((e) => e.ownerId === 'agent-exc')).toBe(true);
  });

  it('caps the injected set at PLAN_START_EXCERPTS_MAX across candidates', async () => {
    const { fetchTurnExcerpts, PLAN_START_EXCERPTS_MAX } = await import('./plan-start-consult');
    const evidence = Array.from({ length: 10 }, (_, i) => ({
      session_id: SESS,
      turn_idx: i % 2 === 0 ? 9001 : 9002,
      ts: null,
      sim: 0.5 + i / 100,
    }));
    const out = await fetchTurnExcerpts(rootSql, WS, [{ ownerId: 'agent-exc', evidence }]);
    expect(out.length).toBeLessThanOrEqual(PLAN_START_EXCERPTS_MAX);
    expect(out.length).toBeGreaterThan(0);
  });
});
