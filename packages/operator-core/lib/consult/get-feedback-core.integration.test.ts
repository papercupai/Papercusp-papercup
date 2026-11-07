/**
 * get-feedback-core.integration.test.ts — getFeedbackCore against a real
 * Postgres, P-003 of get-feedback-relevance-consults-2026-08-16.
 *
 * The consult_state table is created by applying the REAL migration file
 * (834-consult-threads.sql, readFileSync) — never a hand-mirrored CREATE that
 * silently falls behind the schema (the known stale-fixture trap). Only the
 * migration's coord_conversations ALTER needs a minimal stub table to land on.
 *
 * What only a real-PG test can prove here:
 *  - the consult_state INSERT satisfies the migration's CHECK constraints
 *    (state enum, latency enum, depth) and the routing snapshot round-trips
 *    VERBATIM through jsonb;
 *  - the D-005 wake-budget aggregation over origin_task_ref against real rows;
 *  - the origin_task_ref default (most recently progressed wip work-item);
 *  - D-002 owner-pause selectability and transcript-based routing for parked
 *    or dead experts persist; below-floor and unavailable-relevance outcomes
 *    remain distinct in the persisted routing record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import type { RouteResult, RoutingCandidate, RoutingSnapshot } from './relevance-router';
import { routingHealthFromRows, type RoutingHealthConsultRow } from './consult-routing-health';
import { appendDispatchRecord, makeConsultReachDispatcher, rejudgeFirstTurn } from './consult-dispatch';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import {
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
import { CONSULT_QUESTIONS_CHUNK_SURFACE } from '../search/chunks/registry';
import { runChunkSyncTick } from '../search/chunks/tick';
import {
  DEFAULT_ARCHIVE_FLOOR,
  acceptFeedbackRequestCore,
  continueFeedbackRequestCore,
  getFeedbackCore,
  HARD_BLOCKED_EXPIRY_MS,
  MAX_CONSULT_DEPTH,
  PROCEED_EXPIRY_MS,
  type GetFeedbackDeps,
  type GetFeedbackError,
  type GetFeedbackRequest,
  type GetFeedbackResult,
  readVettingConsultCritique,
} from './get-feedback-core';
import { peersKnowLookup } from './peers-know';
import { readRoutingHealthRows } from './consult-routing-health';
import { consultReplyCore, consultDeclineCore } from './consult-verbs-core';
import { sweepExpiredConsults } from './consult-expiry-core';
import { advanceCascade, continueCascadeDispatchCore, selectionFromRouting } from './cascade-core';
import { closeSourceAuditConsults, independentSourceAuditRoute, routeSourceGradingAudit, routeGoalTenureGrading, closeGoalTenureGradingRequests } from '../grading-audit-routing';
import { dispatchPendingGradingAudits, type DispatchPendingGradingAuditsInput } from '../grading-integrity';
import { specQualitySubjectRef } from '../agent-tools/plans/spec-quality';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { GRADING_INTEGRITY_AUDIT_POLICY } from './selection-policies';
import type { ScorecardRow } from '../scorecards';
import type { Rubric } from '../rubrics';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

// grading-integrity's dispatch path records fallback observations; their timer
// flush opens the live org-admin pool, which the real-PG rail refuses with a
// console.warn that fails whichever test is running (WI-6554700010009686).
// Same stub as grading-integrity.test.ts; the afterAll guard keeps it honest.
vi.mock('../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
afterAll(() => { expect(readRealPgRailBlocks().blocked).toBe(0); });

/** Narrow the P-005 result union for the tests that expect success. */
function asOk(r: GetFeedbackResult | GetFeedbackError): GetFeedbackResult {
  if ('error' in r) throw new Error(`unexpected getFeedbackCore error: ${r.error}`);
  return r;
}

const WS = 'ws-consult-core';
const NOW = new Date('2026-08-16T00:00:00Z');
const SOURCE_AUDIT_RESERVED_AT = '2026-08-16T00:00:00.000Z';
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);
const MIGRATION_837 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/837-consult-query-embedding.sql', import.meta.url),
);
const MIGRATION_847 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/847-widen-consult-interest-vecs-to-768.sql', import.meta.url),
);
const MIGRATION_1225 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1225-consult-dispatch-attempts.sql', import.meta.url),
);
// The shared chunk store (generic-rag-chunking P-003): peersKnowLookup ranks each
// settled question by its own vector and its window chunks (P-012, D-027).
const MIGRATION_1242 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1242-text-chunks.sql', import.meta.url),
);
// consult-backed-parking P-003: widens consult_state's state CHECK with
// 'no_launchable_responder' (selected experts, none launchable).
const MIGRATION_1484 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1484-consult-state-no-launchable-responder.sql', import.meta.url),
);
const GEMMA_QUERY_PROFILE = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!;

let rootSql: Sql;
let fixtureDb: MigratedTestDb;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consultc' });
  rootSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Minimal landing pad for the migration's coord_conversations kind-CHECK
  // widening (the real table is migration-132-owned). Keep the workspace key
  // and lifecycle columns used by expiry settlement in sync with that table.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id)
    )`);
  // The REAL migration — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  // P-006 archive-retrieval leg: pgvector (the test image ships it — same
  // idiom as relevance-router.integration.test.ts) + the REAL 837 migration
  // (query_embedding column + hnsw index behind its extension guard).
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe(readFileSync(MIGRATION_837, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_847, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_1225, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_1242, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_1484, 'utf8'));
  await rootSql.unsafe(`
    ALTER TABLE harness_shared.consult_state
      ADD COLUMN query_embedding_mode text,
      ADD COLUMN query_embedding_profile text
  `);
  // Migration 844 (cascade_cursor + cascade_digest) — .sql once armed, .DRAFT
  // while iterating, so the suite is valid on both sides of the arming mv.
  const MIGRATION_844_ARMED = fileURLToPath(
    new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
  );
  await rootSql.unsafe(
    readFileSync(existsSync(MIGRATION_844_ARMED) ? MIGRATION_844_ARMED : `${MIGRATION_844_ARMED}.DRAFT`, 'utf8'),
  );
  // Only the columns the core's origin-ref default reads (work_items is
  // migration-owned; the core touches taken_by/status/timestamps/feature_id).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'ws-consult-core',
      admission text, admitted_at timestamptz, admitted_by text,
      taken_by text,
      status text,
      taken_at timestamptz,
      last_progress_at timestamptz,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
  // Rubric-vetting independence reads the authoring identities from the
  // rubric-template plan row, not from the scorecard work-item ledger.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL DEFAULT 'papercusp',
      plan_slug text NOT NULL,
      template text,
      template_slug text,
      owner text,
      template_data jsonb,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  // Minimal real-PG read fixture for the immutable seq-1 plan-author lookup.
  // It intentionally allows contradictory duplicate origins so the router's
  // fail-closed ambiguity guard remains covered.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plan_revisions (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      seq integer NOT NULL,
      author_kind text NOT NULL,
      author_id text
    )`);
  // The source-audit router's persisted-responder liveness check uses the same
  // session-log evidence as the production oracle. Keep this fixture minimal,
  // but real PostgreSQL-backed, so ended and launch-window recorded rows cannot
  // regress into an active-chain dedupe without a failing integration test.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      mode text NOT NULL DEFAULT 'console',
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      coord_owner_id text,
      agent text,
      role text
    )`);
}, 120_000);

afterAll(async () => {
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

// ── Fixture builders ─────────────────────────────────────────────────────
const cand = (ownerId: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => {
  // These fixtures reason in terms of `score` (the ranking). Relevance tracks
  // it by default so `via` labeling and the wake copy stay coherent; a test
  // that needs the two stages to disagree overrides `relevance` explicitly.
  const score = over.score ?? 0.7;
  return {
    ownerId,
    score,
    relevance: score,
    relativeAgeDays: 0,
    signals: { similarity: 0.72, verification: 0.3, authorship: 0, freshness: 1 },
    evidence: [{ session_id: `sess-${ownerId}`, turn_idx: 3, ts: NOW.toISOString(), sim: 0.72 }],
    liveness: 'live',
    ...over,
  };
};

const snapshotOf = (
  candidates: RoutingCandidate[],
  degraded?: RoutingSnapshot['degraded'],
  fallback?: 'lexical',
): RoutingSnapshot => ({
  query: 'q',
  relevanceFloor: 0.41,
  simFloor: 0.4,
  weights: { similarity: 0.55, verification: 0.15, authorship: 0.15 },
  recencyHalfLifeDays: 7,
  candidates,
  computedAt: NOW.toISOString(),
  ...(degraded ? { degraded } : {}),
  ...(fallback ? { fallback } : {}),
});

const routeOf = (
  qualified: RoutingCandidate[],
  opts: {
    degraded?: RoutingSnapshot['degraded'];
    fallback?: 'lexical';
    all?: RoutingCandidate[];
    queryVec?: number[] | null;
    queryProfile?: ProseProfileSelection | null;
    queryMode?: string | null;
  } = {},
): RouteResult => ({
  verdict: qualified.length > 0 ? 'routed' : 'no_qualified_responder',
  qualified,
  snapshot: snapshotOf(opts.all ?? qualified, opts.degraded, opts.fallback),
  // Default null: existing scenarios exercise the pre-P-006 paths (no archive
  // leg); archive tests pass an explicit vector.
  queryVec: opts.queryVec ?? null,
  queryProfile: opts.queryProfile === undefined
    ? (opts.queryVec ? GEMMA_QUERY_PROFILE : null)
    : opts.queryProfile,
  queryMode: opts.queryMode === undefined
    ? (opts.queryVec ? 'gemma' : null)
    : opts.queryMode,
});

let convSeq = 0;
function makeDeps(
  route: RouteResult,
  options: { answeringOwnerId?: string | null } = {},
) {
  const opened: Array<Parameters<GetFeedbackDeps['open']>[0]> = [];
  const reached: Array<Parameters<GetFeedbackDeps['reach']>[0]> = [];
  const routeCalls: Array<Parameters<GetFeedbackDeps['route']>[0]> = [];
  const deps: GetFeedbackDeps = {
    getSql: () => rootSql,
    route: async (params) => {
      routeCalls.push(params);
      return route;
    },
    open: async (input) => {
      opened.push(input);
      convSeq += 1;
      const id = input.id ?? `conv-${convSeq}`;
      return { conversation_id: id, thread_id: `thr-${id}`, delivered: input.direct_to.length };
    },
    reach: async (o) => {
      reached.push(o);
      // D-002: the seam DISPATCHES. `queued:1` is a launched answering session;
      // pickupConfirmed stays false because a launch is not yet a started turn.
      const answeringOwnerId =
        options.answeringOwnerId === undefined ? `${o.responder}-fork` : options.answeringOwnerId;
      if (answeringOwnerId) await o.onAnsweringOwner?.(answeringOwnerId);
      return { queued: 1, woke: 1, pickupConfirmed: false, answeringOwnerId };
    },
    now: () => NOW,
  };
  return { deps, opened, reached, routeCalls };
}

const baseReq: GetFeedbackRequest = {
  workspaceId: WS,
  requesterId: 'req-1',
  question: 'why does the sync resolver drop SSE events under load?',
  originTaskRef: null, // explicit null: no default lookup, no budget aggregation
};

describe('goal tenure backlog recovery in real PostgreSQL', () => {
  beforeAll(async () => {
    // Minimal read-side landing pads, like work_items above. consult_state is
    // still created by its real migrations, including its lifecycle checks.
    await rootSql.unsafe(`CREATE TABLE harness_shared.goals (
      workspace_id text NOT NULL, id text NOT NULL, status text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    )`);
    await rootSql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
      workspace_id text NOT NULL, goal_id text, goal_actor_class text,
      coord_owner_id text, invoked_at timestamptz NOT NULL
    )`);
  });

  async function fixture() {
    const goal = { workspaceId: WS, goalId: `goal-residual-${randomBytes(6).toString('hex')}` };
    await rootSql`INSERT INTO harness_shared.goals (workspace_id, id, status)
      VALUES (${goal.workspaceId}, ${goal.goalId}, 'active')`;
    await rootSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, goal_id, goal_actor_class, coord_owner_id, invoked_at)
      VALUES (${goal.workspaceId}, ${goal.goalId}, 'holder-agent', 'residual-holder', ${NOW})`;
    const core = makeDeps(routeOf([cand('archived-grading-expert')]));
    const feedback = vi.fn(async (request: GetFeedbackRequest) => getFeedbackCore(request, {
      ...core.deps,
      getPartyKeys: async (_workspace, ids) => new Map(ids.map(id => [id, id])),
    }));
    const deps = { sql: rootSql, now: () => NOW.getTime(), feedback,
      resolveResponderLiveness: vi.fn(async () => ({ sessionState: 'live' as const })) };
    return { goal, core, deps };
  }

  it('persists one request under concurrent ticks and reads its answering session before deduping', async () => {
    const { goal, core, deps } = await fixture();
    const results = await Promise.all([routeGoalTenureGrading(goal, deps), routeGoalTenureGrading(goal, deps)]);
    expect(results.map(result => result.state).sort()).toEqual(['deduped', 'pending']);
    expect(deps.feedback).toHaveBeenCalledTimes(1);
    expect(deps.resolveResponderLiveness).toHaveBeenCalledWith('archived-grading-expert-fork');
    expect(core.reached[0]!.body).toContain('terminal:true');
    expect(core.reached[0]!.body).not.toContain('Answer FROM the transcript');
    const rows = await rootSql`SELECT conversation_id, routing FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND routing->'cascade'->>'goalId' = ${goal.goalId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routing.cascade).toMatchObject({ flavor: 'goal-tenure-grading', ...goal,
      holderOwnerIds: ['residual-holder'] });
    await closeGoalTenureGradingRequests(goal, rootSql);
    expect((await stateRow(rows[0]!.conversation_id)).state).toBe('closed_answered');
  });

  it('retires an expired request before replacement and never resumes a paused goal', async () => {
    const { goal, deps } = await fixture();
    const first = await routeGoalTenureGrading(goal, deps);
    await rootSql`UPDATE harness_shared.consult_state SET expires_at = ${new Date(NOW.getTime() - 1)}
      WHERE workspace_id = ${WS} AND conversation_id = ${first.conversationId!}`;
    const next = await routeGoalTenureGrading(goal, deps);
    expect(next.state).toBe('pending');
    expect(next.conversationId).not.toBe(first.conversationId);
    expect((await stateRow(first.conversationId!)).state).toBe('expired');
    const active = await rootSql`SELECT conversation_id FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND routing->'cascade'->>'goalId' = ${goal.goalId}
        AND state IN ('awaiting_responder', 'active')`;
    expect(active).toHaveLength(1);
    await rootSql`UPDATE harness_shared.goals SET status = 'paused'
      WHERE workspace_id = ${WS} AND id = ${goal.goalId}`;
    expect(await routeGoalTenureGrading(goal, deps)).toMatchObject({ state: 'skipped' });
    expect(deps.feedback).toHaveBeenCalledTimes(2);
  });
});

describe('source-audit dispatcher through persisted consult routing', () => {
  it('excludes the creator from the plan origin revision for spec-quality audits', async () => {
    const planSlug = `spec-quality-origin-${randomBytes(5).toString('hex')}`;
    const planCreator = 'spec-quality-plan-creator';
    const latestEditor = 'spec-quality-latest-editor';
    const issueId = 'EI-spec-quality-plan-creator-exclusion';
    const subjectRef = specQualitySubjectRef(planSlug, 'plan-class-feature-ship', 'a'.repeat(64));
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, owner)
      VALUES (${WS}, 'papercusp', ${planSlug}, NULL)`;
    await rootSql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, author_kind, author_id)
      VALUES
        (${WS}, 'papercusp', ${planSlug}, 1, 'agent', ${planCreator}),
        (${WS}, 'papercusp', ${planSlug}, 2, 'agent', ${latestEditor})`;

    const fixture = makeDeps(routeOf([
      cand(planCreator), cand('spec-quality-plan-creator-child'), cand('scorecard-author'), cand('eligible-auditor'),
    ]));
    const feedback = vi.fn(async (
      req: GetFeedbackRequest,
      _identity: unknown,
      options: {
        harnessSlug?: string | null;
        filterRoute?: (route: RouteResult) => Promise<RouteResult>;
      } = {},
    ) =>
      getFeedbackCore(req, {
        ...fixture.deps,
        route: async (params) => {
          const routed = await fixture.deps.route(params);
          return options.filterRoute ? options.filterRoute(routed) : routed;
        },
      }),
    );

    const result = await routeSourceGradingAudit({
      card: {
        issueId,
        createdBy: 'scorecard-author',
        rubricRef: 'spec-quality',
        subject: { kind: 'plan', ref: subjectRef },
      } as ScorecardRow,
      reservationKey: `grading-audit:${issueId}`,
      reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
      brief: 'Audit the exact specification set.',
      ctx: { workspaceId: WS, uiClientId: 'spec-quality-audit-requester', isSuperuser: true },
      harness: 'papercusp',
    }, {
      getSql: () => rootSql,
      feedback,
      confirmReservation: async () => true,
      resolveParties: async (ids) => new Map(ids.filter((id): id is string => typeof id === 'string').map((id) => [
        id,
        id === 'spec-quality-plan-creator-child' ? planCreator : id,
      ])),
      resolveResponderLiveness: async () => ({ sessionState: 'live' }),
    });

    expect(result.state).toBe('routed');
    expect(feedback.mock.calls[0]?.[0].excludeOwners).toContain(planCreator);
    expect(fixture.reached.map((delivery) => delivery.responder)).toEqual(['eligible-auditor']);
  });

  it.each([
    { provenance: 'missing', authors: [] },
    { provenance: 'ambiguous', authors: ['origin-a', 'origin-b'] },
  ])('refuses a spec-quality audit when plan creator provenance is $provenance', async ({ provenance, authors }) => {
    const planSlug = `spec-quality-${provenance}-${randomBytes(5).toString('hex')}`;
    const issueId = `EI-spec-quality-${provenance}-creator`;
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, owner)
      VALUES (${WS}, 'papercusp', ${planSlug}, NULL)`;
    for (const author of authors) {
      await rootSql`
        INSERT INTO harness_shared.plan_revisions
          (workspace_id, harness_slug, plan_slug, seq, author_kind, author_id)
        VALUES (${WS}, 'papercusp', ${planSlug}, 1, 'agent', ${author})`;
    }
    const feedback = vi.fn();
    await expect(routeSourceGradingAudit({
      card: {
        issueId,
        createdBy: 'scorecard-author',
        rubricRef: 'spec-quality',
        subject: { kind: 'plan', ref: specQualitySubjectRef(planSlug, 'plan-class-feature-ship', 'b'.repeat(64)) },
      } as ScorecardRow,
      reservationKey: `grading-audit:${issueId}`,
      reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
      brief: 'Audit the exact specification set.',
      ctx: { workspaceId: WS, uiClientId: `spec-quality-${provenance}-requester`, isSuperuser: true },
      harness: 'papercusp',
    }, {
      getSql: () => rootSql,
      feedback,
      confirmReservation: async () => true,
    })).rejects.toThrow(/plan creator provenance is missing or ambiguous/);
    expect(feedback).not.toHaveBeenCalled();
  });

  it('retires a consult from an older reservation epoch and dedupes the current epoch', async () => {
    const issueId = 'EI-stale-reservation-epoch-' + randomBytes(5).toString('hex');
    const reservationKey = 'grading-audit:' + issueId;
    const priorReservedAt = '2026-08-15T23:45:00.000Z';
    const currentReservedAt = SOURCE_AUDIT_RESERVED_AT;
    const conversationId = 'conv-stale-reservation-epoch-' + randomBytes(5).toString('hex');
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question, routing, outcome)
      VALUES (
        ${WS}, ${conversationId}, 'audit-requester', 'prior-epoch-auditor', 'awaiting_responder',
        'stale reservation epoch regression',
        ${rootSql.json({
          cascade: { flavor: 'grading-integrity', reservationKey, reservationReservedAt: priorReservedAt, issueId },
        } as never)}, NULL
      )`;

    const fixture = makeDeps(routeOf([cand('fresh-epoch-auditor')]));
    const feedback = vi.fn(async (
      req: GetFeedbackRequest,
      _identity: unknown,
      options: {
        harnessSlug?: string | null;
        filterRoute?: (route: RouteResult) => Promise<RouteResult>;
      } = {},
    ) =>
      getFeedbackCore(req, {
        ...fixture.deps,
        route: async (params) => {
          const routed = await fixture.deps.route(params);
          return options.filterRoute ? options.filterRoute(routed) : routed;
        },
      }),
    );
    const input = {
      card: { issueId, createdBy: 'source-author' } as ScorecardRow,
      reservationKey,
      reservationReservedAt: currentReservedAt,
      brief: 'Audit the current reservation epoch',
      ctx: { workspaceId: WS, uiClientId: 'current-epoch-requester', isSuperuser: true },
    };
    const routeDeps = {
      getSql: () => rootSql,
      feedback,
      confirmReservation: async () => true,
      resolveParties: async (ids: readonly (string | null | undefined)[]) => new Map(
        ids.filter((id): id is string => Boolean(id)).map((id) => [id, id]),
      ),
      resolveResponderLiveness: async () => ({ sessionState: 'live' as const }),
    };

    const first = await routeSourceGradingAudit(input, routeDeps);
    if (first.state !== 'routed') throw new Error('expected current epoch to route, got ' + first.state);
    expect(feedback).toHaveBeenCalledOnce();

    const oldRow = await stateRow(conversationId);
    expect(oldRow.state).toBe('expired');
    expect(oldRow.outcome).toMatchObject({
      dispatch: 'stale-reservation-epoch',
      priorReservedAt,
      currentReservedAt,
    });
    expect((await stateRow(first.conversationId)).routing).toMatchObject({
      cascade: { reservationKey, reservationReservedAt: currentReservedAt },
    });

    const replay = await routeSourceGradingAudit(input, routeDeps);
    if (replay.state !== 'deduped') throw new Error('expected same-epoch replay to dedupe, got ' + replay.state);
    expect(replay.conversationId).toBe(first.conversationId);
    expect(feedback).toHaveBeenCalledOnce();
  });

  it.each(['ended', 'recorded'] as const)(
    'falls back in the initial reservation epoch when the newly routed responder is already %s',
    async (sessionState) => {
      const issueId = `EI-newly-stale-responder-${sessionState}`;
      const responderId = `newly-stale-${sessionState}-responder`;
      const fixture = makeDeps(routeOf([cand(responderId)]));
      let conversationId = '';
      const feedback = vi.fn(async (
        req: GetFeedbackRequest,
        _identity: unknown,
        options: {
          harnessSlug?: string | null;
          filterRoute?: (route: RouteResult) => Promise<RouteResult>;
        } = {},
      ) => {
        const result = await getFeedbackCore(req, {
          ...fixture.deps,
          route: async (params) => {
            const routed = await fixture.deps.route(params);
            return options.filterRoute ? options.filterRoute(routed) : routed;
          },
        });
        if (!('error' in result)) conversationId = result.conversation_id;
        return result;
      });
      const resolveResponderLiveness = vi.fn(async () => ({ sessionState }));

      const result = await routeSourceGradingAudit(
        {
          card: { issueId, createdBy: 'source-author' } as ScorecardRow,
          reservationKey: `grading-audit:${issueId}`,
          reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
          brief: 'Audit newly stale responder regression',
          ctx: { workspaceId: WS, uiClientId: `newly-stale-${sessionState}-requester`, isSuperuser: true },
        },
        {
          getSql: () => rootSql,
          feedback,
          confirmReservation: async () => true,
          resolveParties: async (ids) =>
            new Map(ids.filter((id): id is string => Boolean(id)).map((id) => [id, id])),
          resolveResponderLiveness,
        },
      );

      expect(result).toMatchObject({
        state: 'fallback',
        reason: expect.stringContaining(`became ${sessionState} before pickup`),
      });
      expect(resolveResponderLiveness).toHaveBeenCalledWith(responderId);
      expect(fixture.reached.map((delivery) => delivery.responder)).toEqual([responderId]);
      const row = await stateRow(conversationId);
      expect(row.state).toBe('expired');
      expect(row.outcome).toMatchObject({
        dispatch: 'stale-responder',
        responderId,
        sessionState,
        phase: 'post-route',
      });
    },
  );

  it.each(['ended', 'recorded'] as const)(
    'does not dedupe an active reservation whose persisted responder is %s',
    async (sessionState) => {
      const issueId = `EI-stale-responder-${sessionState}`;
      const reservationKey = `grading-audit:${issueId}`;
      const responderId = `stale-${sessionState}-responder`;
      const conversationId = `conv-stale-${sessionState}`;
      const nowMs = Date.now();
      await rootSql`
        INSERT INTO harness_shared.adv_sessions
          (workspace_id, mode, started_at, ended_at, coord_owner_id, agent, role)
        VALUES (
          ${WS}, 'console', ${new Date(nowMs - 1_000).toISOString()}::timestamptz,
          ${sessionState === 'ended' ? new Date(nowMs - 500).toISOString() : null}::timestamptz,
          ${responderId}, 'su', 'judge'
        )`;
      await rootSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, responder_id, state, question, routing, outcome)
        VALUES (
          ${WS}, ${conversationId}, 'audit-requester', ${responderId}, 'awaiting_responder',
          'stale responder regression',
          ${rootSql.json({
            cascade: { flavor: 'grading-integrity', reservationKey, reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, issueId },
          } as never)}, NULL
        )`;

      const fixture = makeDeps(routeOf([cand('fresh-auditor')]));
      const feedback = vi.fn(async (
        req: GetFeedbackRequest,
        _identity: unknown,
        options: {
          harnessSlug?: string | null;
          filterRoute?: (route: RouteResult) => Promise<RouteResult>;
        } = {},
      ) =>
        getFeedbackCore(req, {
          ...fixture.deps,
          route: async (params) => {
            const routed = await fixture.deps.route(params);
            return options.filterRoute ? options.filterRoute(routed) : routed;
          },
        }),
      );
      const resolveResponderLiveness = vi.fn(async (ownerId: string) => {
        const recorded = await rootSql<Array<{ coord_owner_id: string; started_at: string; ended_at: string | null }>>`
          SELECT DISTINCT ON (coord_owner_id) coord_owner_id, started_at, ended_at
            FROM harness_shared.adv_sessions
           WHERE coord_owner_id = ${ownerId}
           ORDER BY coord_owner_id, started_at DESC`;
        const verdicts = await resolveSessionStates([{ ownerId }], {
          nowMs,
          fetchWakeabilityFn: async (ids) => new Map(ids.map((id) => [id, { wakeable: false, liveTurn: false }])),
          fetchRecordedLiveFn: async (ids) => new Set(
            recorded
              .filter((row) => ids.includes(row.coord_owner_id) && row.ended_at == null &&
                Date.parse(row.started_at) > nowMs - 10 * 60_000)
              .map((row) => row.coord_owner_id),
          ),
          fetchRecordedEndedFn: async (ids) => new Set(
            recorded.filter((row) => ids.includes(row.coord_owner_id) && row.ended_at != null)
              .map((row) => row.coord_owner_id),
          ),
        });
        return verdicts.get(ownerId);
      });
      const input = {
        card: { issueId, createdBy: 'source-author' } as ScorecardRow,
        reservationKey,
        reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
        brief: 'Audit stale responder regression',
        ctx: { workspaceId: WS, uiClientId: `stale-${sessionState}-requester`, isSuperuser: true },
      };
      const routeDeps = {
        getSql: () => rootSql,
        feedback,
        confirmReservation: async () => true,
        resolveParties: async (ids: readonly (string | null | undefined)[]) => new Map(
          ids.filter((id): id is string => Boolean(id)).map((id) => [id, id]),
        ),
        resolveResponderLiveness,
      };

      const first = await routeSourceGradingAudit(input, routeDeps);
      if (first.state !== 'routed') throw new Error(`expected first route, got ${first.state}`);
      expect(resolveResponderLiveness).toHaveBeenCalledWith(responderId);
      expect(feedback).toHaveBeenCalledOnce();
      const oldRow = await stateRow(conversationId);
      expect(oldRow.state).toBe('expired');
      expect(oldRow.outcome).toMatchObject({
        dispatch: 'stale-responder', responderId, sessionState,
      });

      // The fresh consult is still deduped on replay; the stale row is the only
      // one retired, so a retry cannot create a second active chain.
      const replay = await routeSourceGradingAudit(input, routeDeps);
      if (replay.state !== 'deduped') throw new Error(`expected replay dedupe, got ${replay.state}`);
      expect(replay.conversationId).toBe(first.conversationId);
      expect(feedback).toHaveBeenCalledOnce();
    },
  );

  it.each(['direct-launch', 'duplicate-chain', 'excluded-reviewer'] as const)(
    'counterexample: the persisted dispatch oracle detects %s and accepts the repaired route',
    async (fault) => {
      // Restore each defect at the existing dependency seam. Production files
      // stay untouched; the real dispatcher, adapter, core and PG store execute.
      async function exercise(broken: boolean) {
        const issueId = `EI-counterexample-${fault}-${broken}`;
        const source = {
          issueId, createdBy: 'excluded-author', rubricRef: 'source-rubric',
          createdAt: NOW.toISOString(), evidenceFingerprint: 'exact-counterexample-subject',
          gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
        } as ScorecardRow;
        const fixture = makeDeps(routeOf([cand('author-child'), cand('eligible-reviewer')]));
        const effects: string[] = [];
        const launch = vi.fn(async () => {
          effects.push('launch');
          return { data: { deduped: false, launch: { opened: 1, tasks: [{ taskId: 'fixture-launch' }] } } };
        });
        let attempt = 0;
        const route = async (input: Parameters<typeof routeSourceGradingAudit>[0]) => {
          if (broken && fault === 'direct-launch') {
            return { state: 'fallback' as const, reason: 'negative control: legacy direct launch' };
          }
          return routeSourceGradingAudit({
            ...input,
            ...(broken && fault === 'duplicate-chain' ? { reservationKey: `${input.reservationKey}:${++attempt}` } : {}),
            reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
          }, {
            getSql: () => rootSql,
            resolveResponderLiveness: async () => ({ sessionState: 'live' as const }),
            confirmReservation: async () => true,
            resolveParties: async (ids) => new Map(ids.filter((id): id is string => Boolean(id))
              .map((id) => [id, id === 'author-child' ? 'excluded-author' : id])),
            feedback: async (req, _identity, options) => getFeedbackCore(req, {
              ...fixture.deps,
              route: async (params) => {
                const candidates = await fixture.deps.route(params);
                const selected = broken && fault === 'excluded-reviewer'
                  ? candidates : await options!.filterRoute!(candidates);
                effects.push('selection');
                return selected;
              },
              reach: async (reachInput) => {
                effects.push('delivery');
                return fixture.deps.reach(reachInput);
              },
            }),
          });
        };
        const dispatchDeps = {
          listScorecards: async () => [source], getRubric: async () => ({ kind: 'standard' } as Rubric),
          // This fixture has no task-manager rows. Keep the live-task guard
          // inside the fixture instead of opening the production org database.
          listTasks: async () => [],
          // The restored direct-launch defect returns a synthetic task receipt;
          // its task row is absent in this fixture, too.
          getTask: async () => null,
          reserve: async () => ({ status: 'claimed' as const }), release: async () => true,
          confirmReservation: async () => true,
          listWorkspaceWideLoopStanddownOwners: async () => new Set<string>(), route, launch,
        };
        const request = { targetIds: [issueId], ctx: { workspaceId: WS, uiClientId: 'counterexample-requester', isSuperuser: true } as DispatchPendingGradingAuditsInput['ctx'] };
        const first = await dispatchPendingGradingAudits(request, dispatchDeps);
        const replay = await dispatchPendingGradingAudits(request, dispatchDeps);
        // Counterexamples deliberately leave live chains (including duplicates).
        // Settle this fixture's exact subject before later workspace-wide sweeps.
        await closeSourceAuditConsults(WS, issueId, rootSql);
        return () => {
          expect(effects).toEqual(['selection', 'delivery']);
          expect(launch).not.toHaveBeenCalled();
          expect(first.receipts[0]).toMatchObject({ state: 'routed' });
          expect(replay.receipts[0]).toMatchObject({ state: 'deduped', conversationId: first.receipts[0].conversationId });
          expect(fixture.opened).toHaveLength(1);
          expect(fixture.reached.map((r) => r.responder)).toEqual(['eligible-reviewer']);
          expect(fixture.reached[0].body).toContain('exact-counterexample-subject');
        };
      }
      const repairedOracle = await exercise(false);
      expect(repairedOracle).not.toThrow();
      const brokenOracle = await exercise(true);
      expect(brokenOracle).toThrow();
    },
  );

  it('fails closed when lineage is unavailable and never hands an unfiltered candidate pool to selection', async () => {
    const source = { createdBy: 'source-author' } as ScorecardRow;
    const pool = routeOf([cand('source-author'), cand('peer')]);
    await expect(independentSourceAuditRoute(pool, source, WS, async () => { throw new Error('lineage unavailable'); }))
      .rejects.toThrow('lineage unavailable');
    await expect(independentSourceAuditRoute(pool, source, WS, async () => new Map()))
      .rejects.toThrow('incomplete');
  });

  it('uses explicit fallback after no candidates and reuses it on retry without opening another consult', async () => {
    const fixture = makeDeps(routeOf([]));
    const input = {
      card: { issueId: 'EI-no-route', createdBy: 'source-author' } as ScorecardRow,
      reservationKey: 'grading-audit:EI-no-route', reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
      brief: 'Audit empty route',
      ctx: { workspaceId: WS, uiClientId: 'source-requester', isSuperuser: true },
    };
    const feedback = vi.fn(async (req: GetFeedbackRequest) => getFeedbackCore(req, fixture.deps));
    const first = await routeSourceGradingAudit(input, { getSql: () => rootSql, feedback, confirmReservation: async () => true });
    expect(first).toMatchObject({ state: 'fallback', reason: expect.stringContaining('no_qualified_responder') });
    const replay = await routeSourceGradingAudit(input, { getSql: () => rootSql, feedback, confirmReservation: async () => true });
    expect(replay).toMatchObject({ state: 'fallback', reason: expect.stringContaining('reuse reserved launch fallback') });
    expect(feedback).toHaveBeenCalledOnce();
    expect(fixture.reached).toHaveLength(0);
  });

  it('refuses consult recruitment when the current reservation epoch is no longer owned', async () => {
    const feedback = vi.fn();
    const issueId = 'EI-reservation-epoch-lost';
    const result = await routeSourceGradingAudit({
      card: { issueId, createdBy: 'source-author' } as ScorecardRow,
      reservationKey: `grading-audit:${issueId}`,
      reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
      brief: 'Audit an epoch that was superseded',
      ctx: { workspaceId: WS, uiClientId: 'stale-source-requester', isSuperuser: true },
    }, {
      getSql: () => rootSql,
      feedback,
      confirmReservation: async () => false,
    });

    expect(result).toMatchObject({ state: 'reservation-lost' });
    expect(feedback).not.toHaveBeenCalled();
  });

  it('repairs missed settlement cleanup on expiry without waking another auditor', async () => {
    const fixture = makeDeps(routeOf([cand('settled-a'), cand('settled-b')]));
    const result = asOk(await getFeedbackCore({ ...baseReq, question: 'settlement recovery', archiveFloor: 2,
      cascade: { flavor: 'grading-integrity', issueId: 'EI-settled', reservationKey: 'settled', reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, brief: 'Audit exact settled card.' },
    }, fixture.deps));
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, payload) VALUES ('EI-settled', '{"observation":{"gradingAudit":{"state":"passed"}}}'::jsonb)`;
    await rootSql`UPDATE harness_shared.consult_state SET expires_at = ${new Date(NOW.getTime() - 1).toISOString()} WHERE conversation_id = ${result.conversation_id}`;
    const dispatch = vi.fn(async () => ({ woke: 1 }));
    await sweepExpiredConsults({ getSql: () => rootSql, now: () => NOW, emitReplyEvent: async () => {}, notifyRequester: async () => {}, dispatch });
    expect((await stateRow(result.conversation_id)).state).toBe('closed_answered');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('closes a no-qualified source-audit consult when the exact target settles', async () => {
    const issueId = 'EI-settled-no-qualified-close-helper';
    const fixture = makeDeps(routeOf([cand('settled-close-a'), cand('settled-close-b')]));
    const result = asOk(await getFeedbackCore({
      ...baseReq,
      question: 'settled source audit with no qualified responder',
      archiveFloor: 2,
      cascade: {
        flavor: 'grading-integrity', issueId, reservationKey: 'settled-close-helper',
        reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, brief: 'Audit the exact settled card.',
      },
    }, fixture.deps));
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, payload)
      VALUES (${issueId}, '{"observation":{"gradingAudit":{"state":"passed"}}}'::jsonb)
    `;
    await rootSql`
      UPDATE harness_shared.consult_state
         SET state = 'no_qualified_responder', expires_at = NULL
       WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id}
    `;

    await closeSourceAuditConsults(WS, issueId, rootSql);

    const row = await stateRow(result.conversation_id);
    expect(row.state).toBe('closed_answered');
    expect(row.closed_at).not.toBeNull();
    expect(row.outcome).toMatchObject({ source: 'grading-integrity', issueId });
  });

  it('repairs an expired source-audit consult when its exact target later settles', async () => {
    const issueId = 'EI-settled-after-expired-source-audit';
    const conversationId = 'conv-settled-after-expired-source-audit';
    const reservationKey = `grading-audit:${issueId}`;
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, expires_at, closed_at, routing)
      VALUES (
        ${WS}, ${conversationId}, 'audit-requester', 'audit-responder', 'expired',
        'audit exact source card', 'hard-blocked', ${new Date(NOW.getTime() + 30 * 60_000).toISOString()}::timestamptz,
        ${NOW.toISOString()}::timestamptz,
        ${rootSql.json({ cascade: {
          flavor: 'grading-integrity', issueId, reservationKey,
          reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
        } } as never)}
      )
    `;

    await closeSourceAuditConsults(WS, issueId, rootSql);

    const row = await stateRow(conversationId);
    expect(row.state).toBe('closed_answered');
    expect(row.closed_at).not.toBeNull();
    expect(row.outcome).toMatchObject({ source: 'grading-integrity', issueId });
  });

  it('repairs a missed no-qualified settlement cleanup before any further cascade dispatch', async () => {
    const issueId = 'EI-settled-no-qualified-cascade';
    const fixture = makeDeps(routeOf([cand('settled-cascade-a'), cand('settled-cascade-b')]));
    const result = asOk(await getFeedbackCore({
      ...baseReq,
      question: 'settled source audit before cascade advance',
      archiveFloor: 2,
      cascade: {
        flavor: 'grading-integrity', issueId, reservationKey: 'settled-cascade',
        reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, brief: 'Audit the exact settled card.',
      },
    }, fixture.deps));
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, payload)
      VALUES (${issueId}, '{"observation":{"gradingAudit":{"state":"passed"}}}'::jsonb)
    `;
    await rootSql`
      UPDATE harness_shared.consult_state
         SET state = 'no_qualified_responder', expires_at = NULL
       WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id}
    `;
    const [row] = await rootSql<Array<{
      question: string;
      latencyContract: string;
      requesterId: string;
      routing: unknown;
      cascadeCursor: number;
      cascadeDigest: unknown;
    }>>`
      SELECT question, latency_contract AS "latencyContract", requester_id AS "requesterId",
             routing, cascade_cursor AS "cascadeCursor", cascade_digest AS "cascadeDigest"
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id}
    `;
    const dispatch = vi.fn(async () => ({ woke: 1 }));

    const advance = await advanceCascade({
      workspaceId: WS,
      conversationId: result.conversation_id,
      question: row!.question,
      latencyContract: row!.latencyContract,
      requesterId: row!.requesterId,
      routing: row!.routing,
      cascadeCursor: row!.cascadeCursor,
      digest: row!.cascadeDigest,
      event: { ownerId: 'settled-cascade-a', kind: 'decline', at: NOW.toISOString(), excerpt: 'target already settled' },
      stateOnAdvance: 'awaiting_responder',
      nowIso: NOW.toISOString(),
    }, rootSql, dispatch);

    expect(advance).toMatchObject({ advanced: false, raced: true, woke: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    const settledRow = await stateRow(result.conversation_id);
    expect(settledRow.state).toBe('closed_answered');
    expect(settledRow.outcome).toMatchObject({ source: 'grading-integrity', issueId });
  });

  it('a DEAD audit expert is dispatched (not revived) and carries the audit brief, not a transcript-answer brief', async () => {
    const fixture = makeDeps(routeOf([cand('audit-dead', { liveness: 'ended' })]));
    await getFeedbackCore({ ...baseReq, question: 'audit dispatch', archiveFloor: 2,
      cascade: { flavor: 'grading-integrity', issueId: 'EI-revived', reservationKey: 'revived', reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, brief: 'Audit exact revival source.' },
    }, fixture.deps);
    // Deadness is not a gate any more (R-2): the expert is dispatched like any other.
    expect(fixture.reached).toHaveLength(1);
    expect(fixture.reached[0]).toMatchObject({ responder: 'audit-dead' });
    expect(fixture.reached[0].body).toContain('Audit exact revival source.');
    // vacuous-negative-ok: the transcript-answer instruction belongs to the grading route only; pins it out of this route's body
    expect(fixture.reached[0].body).not.toContain('Answer FROM your transcript');
  });

  it('excludes author/critic lineage and limits each reservation epoch to one audit responder', async () => {
    const source = {
      issueId: 'EI-source-router', createdBy: 'source-author', rubricRef: 'source-rubric',
      createdAt: NOW.toISOString(), subject: { kind: 'plan', ref: 'frozen-plan' },
      evidenceFingerprint: 'frozen-source-bytes', vetting: { critics: ['critic'] },
      gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
    } as ScorecardRow;
    const pool = ['source-author', 'author-child', 'critic', 'critic-child', 'independent-a', 'independent-b', 'independent-c'].map((id) => cand(id));
    const fixture = makeDeps(routeOf(pool));
    const launch = vi.fn();
    const route = (
      input: Parameters<typeof routeSourceGradingAudit>[0],
      routeDeps?: Parameters<typeof routeSourceGradingAudit>[1],
    ) => routeSourceGradingAudit(input, {
      getSql: () => rootSql,
      resolveResponderLiveness: async () => ({ sessionState: 'live' as const }),
      confirmReservation: routeDeps?.confirmReservation ?? (async () => true),
      resolveParties: async (ids) => new Map(ids.filter((id): id is string => Boolean(id)).map((id) => [id,
        id === 'author-child' ? 'source-author' : id === 'critic-child' ? 'critic' : id])),
      feedback: async (req, _identity, options) => getFeedbackCore(req, {
        ...fixture.deps,
        route: async (params) => options!.filterRoute!(await fixture.deps.route(params)),
      }),
    });
    const ctx = { workspaceId: WS, uiClientId: 'requester', isSuperuser: true } as DispatchPendingGradingAuditsInput['ctx'];
    const dispatchDeps = {
      listScorecards: async () => [source], getRubric: async () => ({ kind: 'standard' } as Rubric),
      listTasks: async () => [],
      reserve: async (_issueId: string, reservationKey: string) => ({
        status: 'claimed' as const,
        reservation: { key: reservationKey, reservedAt: SOURCE_AUDIT_RESERVED_AT },
      }), release: async () => true,
      confirmReservation: async () => true,
      listWorkspaceWideLoopStanddownOwners: async () => new Set<string>(), route, launch,
    };
    const first = await dispatchPendingGradingAudits({ targetIds: [source.issueId], ctx }, dispatchDeps);
    const conversationId = first.receipts[0].conversationId!;
    expect(first.receipts[0].state).toBe('routed');
    expect(launch).not.toHaveBeenCalled();
    expect(fixture.reached[0].responder).toBe('independent-a');
    expect(fixture.reached[0].body).toContain('frozen-source-bytes');
    // vacuous-negative-ok: the transcript-answer instruction belongs to the grading route only; pins it out of this route's body
    expect(fixture.reached[0].body).not.toContain('Answer FROM your transcript');
    const row = await stateRow(conversationId);
    const snapshot = row.routing as RoutingSnapshot;
    expect(snapshot.candidates.map((c) => c.ownerId)).toEqual(['independent-a', 'independent-b', 'independent-c']);
    expect(snapshot.policy).toBe(GRADING_INTEGRITY_AUDIT_POLICY);
    expect(snapshot.selection).toMatchObject({ max: 1, selected: [expect.objectContaining({ ownerId: 'independent-a' })] });
    expect(snapshot.cascade).toMatchObject({
      flavor: 'grading-integrity', issueId: source.issueId,
      reservationKey: `grading-audit:${source.issueId}`, reservationReservedAt: SOURCE_AUDIT_RESERVED_AT,
    });
    const replay = await dispatchPendingGradingAudits({ targetIds: [source.issueId], ctx }, dispatchDeps);
    expect(replay.receipts[0]).toMatchObject({ state: 'deduped', conversationId });
    expect(fixture.opened).toHaveLength(1);
    await rootSql`UPDATE harness_shared.consult_state SET expires_at = ${new Date(NOW.getTime() - 1).toISOString()} WHERE conversation_id = ${conversationId}`;
    await sweepExpiredConsults({ getSql: () => rootSql, now: () => NOW, emitReplyEvent: async () => {},
      notifyRequester: async () => {},
      dispatch: async (input) => { fixture.reached.push(input); return { woke: 1 }; },
    });
    expect(fixture.reached).toHaveLength(1);
    expect((await stateRow(conversationId)).state).toBe('expired');
    await rootSql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{observation,gradingAudit,state}', '"passed"'::jsonb, true) WHERE feature_id = ${source.issueId}`;
    await closeSourceAuditConsults(WS, source.issueId, rootSql);
    expect((await stateRow(conversationId)).state).toBe('closed_answered');
    const deliveries = fixture.reached.length;
    await sweepExpiredConsults({ getSql: () => rootSql, now: () => new Date(NOW.getTime() + 36e5), emitReplyEvent: async () => {},
      notifyRequester: async () => {},
      dispatch: async (input) => { fixture.reached.push(input); return { woke: 1 }; },
    });
    expect(fixture.reached).toHaveLength(deliveries);
  });

  it('minimum-fill and failed-wake cascade retain the source audit flavor', async () => {
    const fixture = makeDeps(routeOf([], { all: [cand('audit-min-a'), cand('audit-min-b')] }));
    fixture.deps.reach = async (input) => { fixture.reached.push(input); return { queued: fixture.reached.length === 1 ? 0 : 1 }; };
    const result = asOk(await getFeedbackCore({ ...baseReq, question: 'audit minimum and failed wake', archiveFloor: 2, minResponders: 2,
      cascade: { flavor: 'grading-integrity', issueId: 'EI-minimum', reservationKey: 'minimum', reservationReservedAt: SOURCE_AUDIT_RESERVED_AT, brief: 'Audit frozen minimum evidence.' },
    }, fixture.deps));
    expect(result.responder?.ownerId).toBe('audit-min-b');
    expect(fixture.reached).toHaveLength(2);
    for (const reached of fixture.reached) {
      expect(reached.body).toContain('Audit frozen minimum evidence.');
      expect(reached.body).not.toContain('answer FROM your transcript');
    }
  });
});

async function stateRow(conversationId: string, ws: string = WS) {
  const rows = (await rootSql`
    SELECT *, query_embedding IS NOT NULL AS has_query_embedding
      FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize so assertions
  // compare structure, not driver serialization.
  if (typeof row.routing === 'string') row.routing = JSON.parse(row.routing);
  if (typeof row.outcome === 'string') row.outcome = JSON.parse(row.outcome);
  return row;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('recoverable interactive feedback requests', () => {
  it('retains the original runtime through same-key retries on another host and durable recovery', async () => {
    const fixture = makeDeps(routeOf([cand('runtime-expert')]));
    const request = { ...baseReq, requestKey: 'saved-runtime', launchOperatorBaseUrl: 'http://localhost:3170' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    const retry = await acceptFeedbackRequestCore({ ...request, launchOperatorBaseUrl: 'http://localhost:3271' }, fixture.deps);
    expect(retry).not.toHaveProperty('error');
    expect(retry).toMatchObject({ conversation_id: accepted.conversation_id });
    const execute = vi.fn(async (payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) => {
      expect(payload).toMatchObject({ launchOperatorBaseUrl: 'http://localhost:3170' });
      return getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context });
    });
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW, execute });
    expect(execute).toHaveBeenCalledOnce();
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({
      request: { payload: { launchOperatorBaseUrl: 'http://localhost:3170' } },
    });
  });

  it('deduplicates automatic request keys across runtimes while detecting saved-runtime tampering', async () => {
    const fixture = makeDeps(routeOf([cand('runtime-auto-expert')]));
    const request = { ...baseReq, question: 'automatic runtime retry', launchOperatorBaseUrl: 'http://localhost:3170' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    const retry = await acceptFeedbackRequestCore({ ...request, launchOperatorBaseUrl: 'http://localhost:3271' }, fixture.deps);
    expect(retry).toMatchObject({ conversation_id: accepted.conversation_id });
    await rootSql`UPDATE harness_shared.consult_state SET routing = jsonb_set(routing,
      '{request,payload,launchOperatorBaseUrl}', '"http://localhost:3271"'::jsonb)
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    const execute = vi.fn();
    await expect(continueFeedbackRequestCore(WS, accepted.conversation_id,
      { getSql: () => rootSql, now: () => NOW, execute })).rejects.toThrow('consult-request-provenance-mismatch');
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires explicit METHOD context, fingerprints it, and retains it through durable recovery', async () => {
    const fixture = makeDeps(routeOf([cand('method-context-expert')]));
    const request = { ...baseReq, requestKey: 'method-context', policy: 'method-review',
      methodReviewRubricRef: 'acceptance-method-context' };
    await expect(acceptFeedbackRequestCore({ ...request, methodReviewRubricRef: undefined }, fixture.deps))
      .rejects.toThrow('method_review_requires_acceptance_rubric');
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    expect(await acceptFeedbackRequestCore({ ...request, methodReviewRubricRef: 'acceptance-other' }, fixture.deps))
      .toMatchObject({ error: 'request_key_conflict', conversation_id: accepted.conversation_id });
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
      execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }) });
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ policy: 'method-review',
      methodReviewRubricRef: request.methodReviewRubricRef,
      request: { payload: { methodReviewRubricRef: request.methodReviewRubricRef } },
    });
    // Read the REAL persisted JSON through the production deferred dispatcher.
    // A system sweep launcher must not replace the saved applier/target. The
    // denied source must return before resolving a session or spending capacity.
    const dbOrg = await import('@papercusp/db-org');
    const spy = vi.spyOn(dbOrg, 'getOrgPg');
    mockOrgPgSql(spy, rootSql);
    const checkApprover = vi.fn(async (input: { rubricId: string; ownerId: string; applierId?: string }) => ({
      ...input, subjectPlan: 'method-context-subject', eligible: false as const,
      reason: 'related_to_plan_implementer' as const, eligibleWithUnrelatedApplier: false,
    }));
    const resolveResumeTarget = vi.fn();
    try {
      const result = await makeConsultReachDispatcher({ workspaceId: WS, harnessSlug: 'papercusp',
        launchedBy: 'system:consult-expiry-sweep' }, {
        checkApprover, resolveResumeTarget, recordDispatchAttempts: async () => {},
      })({ conversationId: accepted.conversation_id, responder: 'method-context-expert', summary: 'method', body: 'current method' });
      expect(result.queued).toBe(0);
      expect(checkApprover).toHaveBeenCalledWith({ rubricId: request.methodReviewRubricRef,
        applierId: baseReq.requesterId, ownerId: 'method-context-expert' });
      expect(resolveResumeTarget).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('round-trips native constraints through durable request recovery and rejects retry/tamper changes', async () => {
    const nativeConsult = { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' } as const;
    const fixture = makeDeps(routeOf([cand('native-persisted-expert')]));
    const request: GetFeedbackRequest = { ...baseReq, requestKey: 'native-persisted-constraints', nativeConsult };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    const changed = await acceptFeedbackRequestCore({ ...request,
      nativeConsult: { ...nativeConsult, targetBackend: 'claude' } }, fixture.deps);
    expect(changed).toMatchObject({ error: 'request_key_conflict', conversation_id: accepted.conversation_id });
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
      execute: async (payload, context) => {
        expect(payload.nativeConsult).toEqual(nativeConsult);
        return getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context });
      } });
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ nativeConsult,
      request: { payload: { nativeConsult } } });

    const second = await acceptFeedbackRequestCore({ ...request, requestKey: 'native-tamper-constraints' }, fixture.deps);
    if ('error' in second) throw new Error(second.error);
    await rootSql`UPDATE harness_shared.consult_state
      SET routing = jsonb_set(routing, '{request,payload,nativeConsult,targetBackend}', '"claude"'::jsonb)
      WHERE workspace_id = ${WS} AND conversation_id = ${second.conversation_id}`;
    const execute = vi.fn();
    await expect(continueFeedbackRequestCore(WS, second.conversation_id, { getSql: () => rootSql, now: () => NOW, execute }))
      .rejects.toThrow('consult-request-provenance-mismatch');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps one request per retry while expired feedback and launch failures remain separate cohorts', async () => {
    const workspaceId = `${WS}-cohort-regression`;
    const fixture = makeDeps(routeOf([cand('cohort-expert')]));
    const requests = [
      { ...baseReq, workspaceId, requestKey: 'cohort-answer' },
      { ...baseReq, workspaceId, requestKey: 'cohort-pending' },
      { ...baseReq, workspaceId, requestKey: 'cohort-retrieval', allowDispatch: false },
      { ...baseReq, workspaceId, requestKey: 'cohort-legacy' },
    ];
    const accepted = [];
    for (const request of requests) {
      const result = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in result) throw new Error(result.error);
      accepted.push(result);
    }
    const conversationId = accepted[0].conversation_id;
    // Acceptance uses the database clock. Pin this isolated fixture population
    // to the reader's explicit window rather than the test helper's clock seam.
    await rootSql`UPDATE harness_shared.consult_state SET created_at = ${NOW.toISOString()}::timestamptz
      WHERE workspace_id = ${workspaceId}`;
    await rootSql`UPDATE harness_shared.consult_state SET routing = routing - 'deliveryIntent'
      WHERE workspace_id = ${workspaceId} AND conversation_id = ${accepted[3].conversation_id}`;
    const sinceMs = NOW.getTime() - 60_000;
    const untilMs = NOW.getTime() + 60_000;
    const read = async () => {
      const { rows, truncated } = await readRoutingHealthRows(rootSql, workspaceId,
        new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), 5000,
        new Date(NOW.getTime() + 30_000).toISOString());
      expect(truncated).toBe(false);
      expect(rows).toHaveLength(4);
      return routingHealthFromRows(rows, { sinceMs, untilMs, nowMs: NOW.getTime() + 30_000 });
    };
    const initial = await read();
    expect(initial.requestCohort.totals).toMatchObject({ requests: 4, dispatchRequested: 2,
      retrievalOnly: 1, legacyIntentUnknown: 1, outcomes: { pending: 2, received: 0, failed: 0 } });
    expect(initial.totals).toMatchObject({ launched: 0, failed: 0 });

    for (let retry = 0; retry < 3; retry++) {
      const accepted = await acceptFeedbackRequestCore(requests[0], fixture.deps);
      if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
      expect(accepted.conversation_id).toBe(conversationId);
    }
    // Persist both walks through the production writer. They are two launch
    // attempts for the same request, not two additional requests or a terminal
    // delivery failure once a typed responder receipt exists.
    await appendDispatchRecord(rootSql, { workspaceId, conversationId, sourceOwnerId: 'cohort-expert',
      result: { dispatched: false, answeringOwnerId: null, operation: null, agent: null,
        model: null, verified: null, detail: 'fixture failed first launch', attempts: [
          { rank: 0, agent: 'codex', model: 'sol', operation: 'fork', outcome: 'failed',
            reason: 'launch-failed', detail: 'fixture failed first launch' },
        ] },
    }, NOW.toISOString());
    await appendDispatchRecord(rootSql, { workspaceId, conversationId, sourceOwnerId: 'cohort-expert',
      result: { dispatched: true, answeringOwnerId: 'cohort-answerer', operation: 'fork', agent: 'codex',
        model: 'sol', verified: true, detail: 'fixture recovered launch', attempts: [
          { rank: 1, agent: 'codex', model: 'sol', operation: 'fork', outcome: 'dispatched',
            detail: 'fixture recovered launch' },
        ] },
    }, new Date(NOW.getTime() + 1000).toISOString());
    await rootSql`UPDATE harness_shared.consult_state SET state = 'expired', cascade_digest = '[]'::jsonb
      WHERE workspace_id = ${workspaceId} AND conversation_id IN
        (${conversationId}, ${accepted[2].conversation_id})`;
    await rootSql`INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, created_at)
      VALUES (${workspaceId}, 991001, ${conversationId}, 'cohort-answerer', 'answer',
        ${new Date(NOW.getTime() + 2000).toISOString()}::timestamptz)`;
    const final = await read();
    expect(final.requestCohort.totals).toMatchObject({ requests: 4, dispatchRequested: 2,
      retrievalOnly: 1, legacyIntentUnknown: 1,
      outcomes: { received: 1, pending: 1, declined: 0, unavailable: 0, failed: 0, unmeasured: 0 } });
    expect(final.totals).toMatchObject({ launched: 1, failed: 1 });
    expect(final.totals.failedReasons).toEqual({ 'launch-failed': 1 });
    expect(final.requestCohort.window.cohort).toBe('request-time');
    expect(final.window.cohort).toBe('launch-time');
    expect(fixture.routeCalls).toHaveLength(0);
    expect(fixture.reached).toHaveLength(0);
  });

  it.each([undefined, false] as const)('records request intent and pending classification before routing (%s)', async (allowDispatch) => {
    const fixture = makeDeps(routeOf([cand('accepted-expert')]));
    const request = { ...baseReq, requestKey: `accepted-cohort-${allowDispatch ?? 'default'}`, allowDispatch };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    const stored = await stateRow(accepted.conversation_id);
    expect(stored.routing).toMatchObject({ deliveryIntent: allowDispatch === false ? 'retrieval-only' : 'dispatch' });
    const health = routingHealthFromRows([stored as unknown as RoutingHealthConsultRow], {
      sinceMs: 0, untilMs: Date.parse('2100-01-01T00:00:00Z'), nowMs: Date.now(),
    });
    expect(health.requestCohort.totals).toMatchObject({ requests: 1, legacyIntentUnknown: 0,
      dispatchRequested: allowDispatch === false ? 0 : 1, retrievalOnly: allowDispatch === false ? 1 : 0,
      outcomes: { pending: allowDispatch === false ? 0 : 1 } });
    expect(accepted).toMatchObject({ state: 'routing', pending: true });
    expect(health.totals.launched).toBe(0);
    expect(fixture.routeCalls).toHaveLength(0);
    expect(fixture.reached).toHaveLength(0);
  });

  it('binds accepted scoring to the actual request lease without changing the saved payload', async () => {
    const fixture = makeDeps(routeOf([]));
    const request = { ...baseReq, requestKey: 'accepted-scoring-lease-bound' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const execute = vi.fn((payload, context) => getFeedbackCore(payload, {
      ...fixture.deps, acceptedRequest: context,
    }));
    await continueFeedbackRequestCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW, execute,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1]).toMatchObject({
      conversation_id: accepted.conversation_id, leaseUntilMs: NOW.getTime() + 120_000,
    });
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ request: { payload: request } });
    expect(request).not.toHaveProperty('leaseUntilMs');
  });

  it.each(['embed-unavailable', 'evidence-unavailable', undefined] as const)(
    'retains measured outcomes and preserves unmeasured history through explicit retry (%s)', async (degraded) => {
      const fixture = makeDeps(routeOf([], { degraded }));
      const request = { ...baseReq, requestKey: `recoverable-result-${degraded ?? 'measured'}`, minResponders: 0 };
      const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
      expect(accepted).not.toHaveProperty('result');
      await continueFeedbackRequestCore(WS, accepted.conversation_id, {
        getSql: () => rootSql, now: () => NOW,
        execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
      });
      const stored = await stateRow(accepted.conversation_id);
      const previous = (stored.routing as { request: { result: GetFeedbackResult } }).request.result;
      expect(previous).toMatchObject({
        state: 'no_qualified_responder', verdict: degraded ? 'relevance_unmeasured' : 'no_qualified_responder',
        reason: degraded === 'embed-unavailable' ? 'embed_unavailable'
          : degraded === 'evidence-unavailable' ? 'evidence_unavailable' : 'below_floor' });
      const retry = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in retry) throw new Error(retry.error);
      expect(retry).toMatchObject({ conversation_id: accepted.conversation_id,
        pending: Boolean(degraded), state: degraded ? 'routing' : 'no_qualified_responder' });
      if (degraded) {
        expect(retry).not.toHaveProperty('result');
        expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ request: {
          payload: request, recoveryHistory: [{ at: NOW.toISOString(), result: previous }],
        } });
        // Still unavailable is another honest outcome, never a launch or an
        // automatic retry loop. A later attempt requires another requester call.
        expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, {
          getSql: () => rootSql, now: () => NOW,
          execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
        })).toBe(true);
        expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ request: {
          result: previous, recoveryHistory: [{ result: previous }],
        } });
      } else expect(retry.result).toEqual(previous);
      expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, {
        getSql: () => rootSql, execute: async () => { throw new Error('no automatic reroute'); },
      })).toBe(false);
      expect(fixture.routeCalls).toHaveLength(degraded ? 2 : 1);
      expect(fixture.reached).toHaveLength(0);
    },
  );

  it.each(['embed-unavailable', 'evidence-unavailable'] as const)(
    'recovers the same unmeasured request once under concurrent retries (%s)', async (degraded) => {
      const fixture = makeDeps(routeOf([], { degraded }));
      const request = { ...baseReq, requestKey: `unmeasured-concurrent-${degraded}` };
      const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
      const run = (execute: Parameters<typeof continueFeedbackRequestCore>[2]['execute']) =>
        continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW, execute });
      await run((payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }));
      const previous = (await stateRow(accepted.conversation_id)).routing;
      expect(await acceptFeedbackRequestCore({ ...request, excludeOwners: ['changed-payload'] }, fixture.deps))
        .toMatchObject({ error: 'request_key_conflict' });
      expect((await stateRow(accepted.conversation_id)).routing).toEqual(previous);
      const retries = await Promise.all([
        acceptFeedbackRequestCore(request, fixture.deps), acceptFeedbackRequestCore(request, fixture.deps),
      ]);
      for (const retry of retries) expect(retry).toMatchObject({ conversation_id: accepted.conversation_id,
        request_key: request.requestKey, state: 'routing', pending: true });
      const history = (await stateRow(accepted.conversation_id)).routing as {
        request: { recoveryHistory: Array<{ result: GetFeedbackResult }> };
      };
      expect(history.request.recoveryHistory).toHaveLength(1);
      expect(history.request.recoveryHistory[0].result.verdict).toBe('relevance_unmeasured');
      const recovered = makeDeps(routeOf([cand('recovered-qualified-expert')]));
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const execute = vi.fn(async (payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) => {
        entered(); await barrier;
        return getFeedbackCore(payload, { ...recovered.deps, acceptedRequest: context });
      });
      const first = run(execute);
      await started;
      const contender = await run(execute);
      release();
      expect(await first).toBe(true);
      expect(contender).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(recovered.reached).toHaveLength(1);
      expect(recovered.opened).toHaveLength(0);
      expect(await acceptFeedbackRequestCore(request, fixture.deps)).toMatchObject({
        conversation_id: accepted.conversation_id, state: 'awaiting_responder', pending: false,
        result: { verdict: 'routed' },
      });
      expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ request: {
        payload: request, recoveryHistory: history.request.recoveryHistory,
      } });
    },
  );

  it('refreshes derived subject metadata when the same unmeasured request recovers', async () => {
    const fixture = makeDeps(routeOf([], { degraded: 'evidence-unavailable' }));
    const request = { ...baseReq, requestKey: 'unmeasured-derived-subject',
      resolvedSubjectRefs: ['plans:start'], unresolvedSubjectRefs: [] };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    const run = (execute: Parameters<typeof continueFeedbackRequestCore>[2]['execute']) =>
      continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW, execute });
    await run((payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }));
    const previous = (await stateRow(accepted.conversation_id)).routing;
    const { resolvedSubjectRefs: _resolved, unresolvedSubjectRefs: _unresolved, ...corrected } = request;
    for (const changed of [{ ...corrected, question: 'A different question?' },
      { ...corrected, subjectRefs: ['explicit-new-subject'] }]) {
      expect(await acceptFeedbackRequestCore(changed, fixture.deps)).toMatchObject({ error: 'request_key_conflict' });
      expect((await stateRow(accepted.conversation_id)).routing).toEqual(previous);
    }
    const retries = await Promise.all([
      acceptFeedbackRequestCore(corrected, fixture.deps), acceptFeedbackRequestCore(corrected, fixture.deps),
    ]);
    for (const retry of retries) expect(retry).toMatchObject({
      conversation_id: accepted.conversation_id, state: 'routing', pending: true,
    });
    const routing = (await stateRow(accepted.conversation_id)).routing as {
      request: { payload: GetFeedbackRequest; recoveryHistory: unknown[] };
    };
    expect(routing.request.payload).toEqual(corrected);
    expect(routing.request.recoveryHistory).toHaveLength(1);
    const recovered = makeDeps(routeOf([cand('correct-subject-expert')]));
    expect(await run((payload, context) => {
      expect(payload).toEqual(corrected);
      return getFeedbackCore(payload, { ...recovered.deps, acceptedRequest: context });
    })).toBe(true);
    // A late retry with stale derived metadata must not undo selection or launch twice.
    const before = await stateRow(accepted.conversation_id);
    expect(await acceptFeedbackRequestCore(request, fixture.deps)).toMatchObject({
      conversation_id: accepted.conversation_id, state: 'awaiting_responder', pending: false,
    });
    expect(await stateRow(accepted.conversation_id)).toEqual(before);
    expect(recovered.reached).toHaveLength(1);
  });

  it('refuses recovery when the persisted derived payload fails its provenance check', async () => {
    const fixture = makeDeps(routeOf([], { degraded: 'evidence-unavailable' }));
    const request = { ...baseReq, requestKey: 'unmeasured-derived-subject-tampered',
      resolvedSubjectRefs: ['original-subject'] };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(accepted.error);
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
      execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
    });
    await rootSql`UPDATE harness_shared.consult_state
      SET routing = jsonb_set(routing, '{request,payload,resolvedSubjectRefs}', '["tampered"]'::jsonb)
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    const before = await stateRow(accepted.conversation_id);
    expect(await acceptFeedbackRequestCore({ ...request, resolvedSubjectRefs: ['corrected-subject'] }, fixture.deps))
      .toMatchObject({ error: 'request_key_conflict' });
    expect(await stateRow(accepted.conversation_id)).toEqual(before);
    expect(fixture.reached).toHaveLength(0);
  });

  it.each(['selected', 'responder', 'dispatch-attempt', 'pending-dispatch', 'wake', 'exchange',
    'cascade', 'closed', 'closed-conversation', 'reply', 'retrieval-only', 'unexpired-lease',
    'result-dispatch', 'result-wake', 'missing-selection'] as const)(
    'does not rearm an unmeasured request with a %s fence', async (fence) => {
      const fixture = makeDeps(routeOf([], { degraded: 'embed-unavailable' }));
      const request = { ...baseReq, requestKey: `unmeasured-fence-${fence}`,
        ...(fence === 'retrieval-only' ? { allowDispatch: false } : {}) };
      const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
      await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
        execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
      });
      const patch = fence === 'selected' ? { selection: { selected: [{ ownerId: 'possibly-launched' }] } }
        : fence === 'pending-dispatch' ? { cascadeDispatch: { state: 'pending' } } : {};
      await rootSql`UPDATE harness_shared.consult_state SET
        routing = routing || ${rootSql.json(patch)},
        responder_id = ${fence === 'responder' ? 'reserved-owner' : null},
        dispatch_attempts = ${rootSql.json(fence === 'dispatch-attempt' ? [{ dispatched: false, attempts: [] }] : [])},
        wakes_used = ${fence === 'wake' ? 1 : 0}, exchanges_used = ${fence === 'exchange' ? 1 : 0},
        cascade_digest = ${rootSql.json(fence === 'cascade' ? [{ ownerId: 'old-owner', kind: 'expired' }] : [])},
        closed_at = ${fence === 'closed' ? NOW.toISOString() : null}::timestamptz
        WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
      if (fence === 'unexpired-lease') await rootSql`UPDATE harness_shared.consult_state
        SET routing = jsonb_set(routing, '{request,leaseUntil}',
          ${rootSql.json(new Date(NOW.getTime() + 60_000).toISOString())})
        WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
      if (fence === 'result-dispatch' || fence === 'result-wake') await rootSql`UPDATE harness_shared.consult_state
        SET routing = jsonb_set(routing, '{request,result}', (routing #> '{request,result}') ||
          ${rootSql.json(fence === 'result-dispatch' ? { dispatch: { answeringOwnerId: 'reserved-owner' } }
            : { wake: { attempted: true, queued: 0, woke: 0 } })})
        WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
      if (fence === 'missing-selection') await rootSql`UPDATE harness_shared.consult_state
        SET routing = routing - 'selection'
        WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
      if (fence === 'reply') await rootSql`INSERT INTO harness_shared.consult_post_meta
        (workspace_id, post_id, conversation_id, author_id, kind)
        VALUES (${WS}, 990201, ${accepted.conversation_id}, 'prior-answer', 'answer')`;
      if (fence === 'closed-conversation') await rootSql`INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, state) VALUES (${WS}, ${accepted.conversation_id}, 'closed')`;
      const before = await stateRow(accepted.conversation_id);
      expect(await acceptFeedbackRequestCore(request, fixture.deps)).toMatchObject({
        conversation_id: accepted.conversation_id, state: 'no_qualified_responder', pending: false,
      });
      expect(await acceptFeedbackRequestCore({ ...request, resolvedSubjectRefs: ['corrected-subject'] }, fixture.deps))
        .toMatchObject({ conversation_id: accepted.conversation_id, state: 'no_qualified_responder', pending: false });
      expect(await stateRow(accepted.conversation_id)).toEqual(before);
      expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, {
        getSql: () => rootSql, execute: async () => { throw new Error('fenced request executed'); },
      })).toBe(false);
      expect(fixture.routeCalls).toHaveLength(1);
      expect(fixture.reached).toHaveLength(0);
    },
  );

  it('recomputes bar-critique independence from the saved payload after instrument recovery', async () => {
    const planSlug = `unmeasured-critique-${randomBytes(5).toString('hex')}`;
    await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES (${WS}, 'papercusp', ${planSlug})`;
    const fixture = makeDeps(routeOf([], { degraded: 'embed-unavailable' }));
    const request = { ...baseReq, requestKey: planSlug, policy: 'bar-critique', originTaskRef: planSlug,
      harnessSlug: 'papercusp', excludeOwners: ['explicitly-excluded'], maxResponders: 1 };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
      execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
    });
    // The first critic finishes while the second request's instrument is down.
    const priorId = `first-${planSlug}`;
    await rootSql`INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question, origin_task_ref, routing, closed_at)
      VALUES (${WS}, ${priorId}, 'first-requester', 'first-source', 'closed_answered', 'first critique',
        ${planSlug}, ${rootSql.json({ policy: 'bar-critique' })}, ${NOW.toISOString()}::timestamptz)`;
    await rootSql`INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind)
      VALUES (${WS}, 990202, ${priorId}, 'first-answerer', 'answer')`;
    const recovered = makeDeps(routeOf([cand('first-source'), cand('first-answerer'),
      cand('same-first-party'), cand('explicitly-excluded'), cand('distinct-qualified-critic')]));
    recovered.deps.getPartyKeys = async (_workspace, owners) => new Map(owners.map(owner =>
      [owner, ['first-source', 'first-answerer', 'same-first-party'].includes(owner) ? 'first-party' : owner]));
    expect(await acceptFeedbackRequestCore(request, fixture.deps)).toMatchObject({ state: 'routing' });
    await continueFeedbackRequestCore(WS, accepted.conversation_id, { getSql: () => rootSql, now: () => NOW,
      execute: (payload, context) => getFeedbackCore(payload, { ...recovered.deps, acceptedRequest: context }),
    });
    expect(recovered.routeCalls[0]).toMatchObject({
      excludeOwners: expect.arrayContaining(['explicitly-excluded']),
      excludePartyOwners: expect.arrayContaining(['first-source', 'first-answerer']),
    });
    expect(recovered.reached.map(call => call.responder)).toEqual(['distinct-qualified-critic']);
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ policy: 'bar-critique', request: {
      key: request.requestKey, payload: request, result: { verdict: 'routed' },
    } });
  });

  it.each(['terminal', 'refill-launched', 'refill-exhausted'] as const)(
    'retains accepted request identity and outcome through initial cascade %s', async (scenario) => {
      const candidates = [cand('accepted-head'), cand('accepted-next'),
        ...(scenario === 'terminal' ? [] : [cand('accepted-refill')])];
      const fixture = makeDeps(routeOf(candidates));
      const reach = fixture.deps.reach;
      fixture.deps.reach = async (opts) => {
        if (scenario === 'refill-launched' && opts.responder === 'accepted-refill') return reach(opts);
        fixture.reached.push(opts);
        return { queued: 0, pickupConfirmed: false };
      };
      const request = { ...baseReq, requestKey: `recoverable-cascade-${scenario}`,
        minResponders: 2, maxResponders: 2 };
      const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
      if ('error' in accepted) throw new Error(accepted.error);
      expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, {
        getSql: () => rootSql, now: () => NOW,
        execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
      })).toBe(true);
      const stored = await stateRow(accepted.conversation_id);
      expect(stored.routing).toMatchObject({ request: {
        key: request.requestKey, payload: request, leaseToken: null, leaseUntil: null,
        // Experts WERE selected and none launched: a dispatch failure, stored apart
        // from the measured absence (consult-backed-parking R-2).
        result: { verdict: scenario === 'refill-launched' ? 'routed' : 'no_launchable_responder' },
      } });
      if (scenario === 'refill-launched') {
        expect(stored.routing).toMatchObject({ selection: { selected: [
          { ownerId: 'accepted-head' }, { ownerId: 'accepted-next' },
          { ownerId: 'accepted-refill', answeringOwnerId: 'accepted-refill-fork' },
        ] } });
      } else {
        expect(stored.routing).toMatchObject({ selection: { underFilled: { answers: 0, min: 2 } } });
      }
      const dispatches = fixture.reached.length;
      const retry = await acceptFeedbackRequestCore(request, fixture.deps);
      expect(retry).toMatchObject({ conversation_id: accepted.conversation_id, pending: false,
        result: (stored.routing as { request: { result: unknown } }).request.result });
      expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, {
        getSql: () => rootSql, now: () => NOW,
        execute: async () => { throw new Error('a completed request must not dispatch again'); },
      })).toBe(false);
      expect(fixture.reached).toHaveLength(dispatches);
      expect(fixture.routeCalls).toHaveLength(1);
    },
  );

  it('accepts one identity before routing and deduplicates concurrent transport retries', async () => {
    const fixture = makeDeps(routeOf([cand('recoverable-expert')]));
    const request = { ...baseReq, requestKey: 'recoverable-concurrent', question: 'recoverable concurrent request' };
    const [a, b] = await Promise.all([
      acceptFeedbackRequestCore(request, fixture.deps), acceptFeedbackRequestCore(request, fixture.deps),
    ]);
    if ('error' in a) throw new Error(`unexpected acceptance refusal: ${a.error}`);
    if ('error' in b) throw new Error(`unexpected acceptance refusal: ${b.error}`);
    expect(a).toMatchObject({ verdict: 'accepted', pending: true, state: 'routing' });
    expect(b).toMatchObject({ conversation_id: a.conversation_id, request_key: request.requestKey });
    expect(fixture.routeCalls).toHaveLength(0);
    expect(fixture.reached).toHaveLength(0);
    const rows = await rootSql`SELECT conversation_id FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${a.conversation_id}`;
    expect(rows).toHaveLength(1);
  });

  it('refuses a changed payload under a key and partitions identity by requester and workspace', async () => {
    const fixture = makeDeps(routeOf([]));
    const request = { ...baseReq, requestKey: 'recoverable-conflict', question: 'original recoverable question' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    expect(await acceptFeedbackRequestCore({ ...request, question: 'changed question' }, fixture.deps))
      .toMatchObject({ error: 'request_key_conflict', conversation_id: accepted.conversation_id });
    const peer = await acceptFeedbackRequestCore({ ...request, requesterId: 'another-requester' }, fixture.deps);
    if ('error' in peer) throw new Error(`unexpected acceptance refusal: ${peer.error}`);
    const otherWorkspace = await acceptFeedbackRequestCore({ ...request, workspaceId: 'another-workspace' }, fixture.deps);
    if ('error' in otherWorkspace) throw new Error(`unexpected acceptance refusal: ${otherWorkspace.error}`);
    expect(peer.conversation_id).not.toBe(accepted.conversation_id);
    expect(otherWorkspace.conversation_id).not.toBe(accepted.conversation_id);
  });

  it('resumes an accepted request after response loss and restart through the existing sweep exactly once', async () => {
    const fixture = makeDeps(routeOf([cand('restart-expert')]));
    const request = { ...baseReq, requestKey: 'recoverable-restart', question: 'response lost before routing starts' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const execute = vi.fn(async (payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) =>
      getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }));
    const resumeRequest = (workspace: string, id: string) => id === accepted.conversation_id
      ? continueFeedbackRequestCore(workspace, id, { getSql: () => rootSql, now: () => NOW, execute })
      : Promise.resolve(false);
    await sweepExpiredConsults({ getSql: () => rootSql, now: () => NOW,
      resumeRequest, emitReplyEvent: async () => {}, notifyRequester: async () => {} });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.reached).toHaveLength(1);
    expect(fixture.opened).toHaveLength(1);
    expect(await resumeRequest(WS, accepted.conversation_id)).toBe(false);
    const replay = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in replay) throw new Error(`unexpected acceptance refusal: ${replay.error}`);
    expect(replay).toMatchObject({ conversation_id: accepted.conversation_id, state: 'awaiting_responder', pending: false });
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({
      request: { key: request.requestKey, result: { verdict: 'routed' } },
      selection: { selected: [{ answeringOwnerId: 'restart-expert-fork' }] },
    });
  });

  it('allows one preparation lease and recovers an expired lease without duplicate dispatch', async () => {
    const fixture = makeDeps(routeOf([cand('lease-expert')]));
    const request = { ...baseReq, requestKey: 'recoverable-lease', question: 'single worker lease' };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const execute = vi.fn(async (payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) => {
      entered(); await barrier;
      return getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context });
    });
    const deps = { getSql: () => rootSql, now: () => NOW, execute };
    const first = continueFeedbackRequestCore(WS, accepted.conversation_id, deps);
    await started;
    expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, deps)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(fixture.reached).toHaveLength(1);

    const abandoned = await acceptFeedbackRequestCore({ ...request, requestKey: 'recoverable-abandoned' }, fixture.deps);
    if ('error' in abandoned) throw new Error(`unexpected acceptance refusal: ${abandoned.error}`);
    await rootSql`UPDATE harness_shared.consult_state SET routing = jsonb_set(routing, '{request}',
      (routing->'request') || ${rootSql.json({ leaseToken: 'dead-process', leaseUntil: NOW.toISOString() } as never)})
      WHERE workspace_id = ${WS} AND conversation_id = ${abandoned.conversation_id}`;
    expect(await continueFeedbackRequestCore(WS, abandoned.conversation_id, {
      ...deps, execute: (payload, context) => getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context }),
    })).toBe(true);
    expect(fixture.reached).toHaveLength(2);
  });

  it('refuses a stale worker before dispatch after another lease won', async () => {
    const fixture = makeDeps(routeOf([cand('stale-worker-expert')]));
    const accepted = await acceptFeedbackRequestCore({ ...baseReq, requestKey: 'recoverable-stale-worker' }, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    await expect(continueFeedbackRequestCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW,
      execute: async (payload, context) => {
        await rootSql`UPDATE harness_shared.consult_state SET routing = jsonb_set(routing, '{request,leaseToken}', '"new-worker"'::jsonb)
          WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
        return getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context });
      },
    })).rejects.toThrow('consult-request-lease-lost');
    expect(fixture.reached).toHaveLength(0);
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ request: { leaseToken: 'new-worker' } });
  });

  it.each([undefined, 'method-review'])('recovers initial delivery for %s after process loss without re-routing or duplicate launch', async (policy) => {
    const fixture = makeDeps(routeOf([cand('durable-initial-expert')]));
    const accepted = await acceptFeedbackRequestCore({ ...baseReq, requestKey: `durable-initial-${policy ?? 'default'}`, policy,
      ...(policy === 'method-review' ? { methodReviewRubricRef: 'acceptance-durable-method' } : {}) }, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const execute = vi.fn((payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) =>
      getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context,
        resumeInitialDispatch: () => { throw new Error('process stopped before initial continuation'); } }));
    const requestDeps = { getSql: () => rootSql, now: () => NOW, execute };
    await expect(continueFeedbackRequestCore(WS, accepted.conversation_id, requestDeps)).rejects.toThrow('process stopped');
    const selected = await stateRow(accepted.conversation_id);
    expect(selected.state).toBe('awaiting_responder');
    expect(selected.routing).toMatchObject({ cascadeDispatch: {
      version: 1, cursor: 0, responder: 'durable-initial-expert', leaseToken: null, leaseUntil: null,
      body: expect.stringContaining(baseReq.question),
    } });
    if (policy === 'method-review') {
      expect(selected.routing).toMatchObject({ policy, cascadeDispatch: {
        body: expect.stringContaining('CURRENT METHOD'),
      } });
      expect(selected.routing).not.toMatchObject({ cascadeDispatch: {
        body: expect.stringContaining('Answer FROM the transcript'),
      } });
    }
    expect(fixture.reached).toHaveLength(0);
    expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, requestDeps)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const dispatch = vi.fn(async (opts: Parameters<GetFeedbackDeps['reach']>[0]) => {
      expect(opts.body).toContain(baseReq.question);
      if (policy === 'method-review') expect(opts.body).toContain('CURRENT METHOD');
      await opts.onAnsweringOwner?.('durable-initial-answerer');
      entered();
      await held;
      return { woke: 1, answeringOwnerId: 'durable-initial-answerer' };
    });
    const recovery = { getSql: () => rootSql, now: () => NOW, dispatch: () => dispatch };
    const first = continueCascadeDispatchCore(WS, accepted.conversation_id, recovery);
    await started;
    // A concurrent sweep, and a sweep after the lease expires, both respect
    // the early reservation even if the first process never returns.
    expect(await continueCascadeDispatchCore(WS, accepted.conversation_id, recovery)).toBe(false);
    expect(await continueCascadeDispatchCore(WS, accepted.conversation_id, {
      ...recovery, now: () => new Date(NOW.getTime() + 120_001),
    })).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(selectionFromRouting((await stateRow(accepted.conversation_id)).routing)[0])
      .toMatchObject({ answeringOwnerId: 'durable-initial-answerer' });
  });

  it('persists a native target capacity stop through deferred recovery and expiry without trying another source', async () => {
    const fixture = makeDeps(routeOf([cand('capacity-first'), cand('capacity-next')]));
    const request = { ...baseReq, requestKey: 'native-capacity-recovery', maxResponders: 2 };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    await continueFeedbackRequestCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW,
      execute: (payload, acceptedRequest) => getFeedbackCore(payload, {
        ...fixture.deps, acceptedRequest, resumeInitialDispatch: () => {},
      }),
    });
    const detail = 'native target claude capacity unavailable: all accounts walled';
    const dispatch = vi.fn(async () => ({ woke: 0, answeringOwnerId: null, targetCapacityUnavailable: detail }));
    expect(await continueCascadeDispatchCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW, dispatch: () => dispatch,
    })).toBe(true);
    expect((await stateRow(accepted.conversation_id)).routing).toMatchObject({ targetCapacityUnavailable: detail });
    const next = vi.fn(async () => ({ woke: 1, answeringOwnerId: 'unwanted-answerer' }));
    await sweepExpiredConsults({ getSql: () => rootSql, now: () => NOW,
      dispatch: next, emitReplyEvent: async () => {}, notifyRequester: async () => {} });
    expect(next).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const row = await stateRow(accepted.conversation_id);
    expect(row.state).toBe('expired');
    expect(row.cascade_cursor).toBe(0);
    expect(row.cascade_digest).toEqual([expect.objectContaining({ kind: 'dispatch_failed', excerpt: detail })]);
  });

  it('does not persist a target-capacity stop after its deferred dispatch lease is replaced', async () => {
    const fixture = makeDeps(routeOf([cand('capacity-stale')]));
    const accepted = await acceptFeedbackRequestCore({ ...baseReq, requestKey: 'capacity-stale-lease' }, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    await continueFeedbackRequestCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW,
      execute: (payload, acceptedRequest) => getFeedbackCore(payload, {
        ...fixture.deps, acceptedRequest, resumeInitialDispatch: () => {},
      }),
    });
    await continueCascadeDispatchCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW,
      dispatch: () => async () => {
        await rootSql`UPDATE harness_shared.consult_state
          SET routing = jsonb_set(routing, '{cascadeDispatch,leaseToken}', '"replacement"'::jsonb)
          WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
        return { woke: 0, targetCapacityUnavailable: 'stale capacity refusal' };
      },
    });
    const row = await stateRow(accepted.conversation_id);
    expect(row.routing).not.toHaveProperty('targetCapacityUnavailable');
    expect(row.routing).toMatchObject({ cascadeDispatch: { leaseToken: 'replacement' } });
    expect(row.expires_at instanceof Date && row.expires_at.getTime() > NOW.getTime()).toBe(true);
  });

  it.each(['routed', 'retrieval', 'empty'] as const)('reports accepted initial %s delivery without inventing a launch', async kind => {
    const fixture = makeDeps(routeOf(kind === 'empty' ? [] : [cand(`durable-${kind}`)]));
    const request = { ...baseReq, requestKey: `durable-${kind}`, allowDispatch: kind !== 'retrieval', minResponders: 0 };
    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const resumeInitialDispatch = vi.fn();
    let result: GetFeedbackResult | GetFeedbackError | undefined;
    await continueFeedbackRequestCore(WS, accepted.conversation_id, {
      getSql: () => rootSql, now: () => NOW,
      execute: async (payload, acceptedRequest) => {
        result = await getFeedbackCore(payload, { ...fixture.deps, acceptedRequest, resumeInitialDispatch });
        return result;
      },
    });
    expect(fixture.reached).toHaveLength(0);
    expect(result).toMatchObject({
      verdict: kind === 'routed' ? 'routed' : kind === 'retrieval' ? 'retrieval_only' : 'no_qualified_responder',
      wake: { queued: 0, woke: 0, pickupConfirmed: false },
    });
    expect(resumeInitialDispatch).toHaveBeenCalledTimes(kind === 'routed' ? 1 : 0);
    if (kind === 'routed') expect(result).toMatchObject({ hint: expect.stringContaining('no answering session is confirmed yet') });
    else expect((await stateRow(accepted.conversation_id)).routing).not.toHaveProperty('cascadeDispatch');
  });

  it('does not replay dispatch after losing the response beyond the selected-row commit', async () => {
    const fixture = makeDeps(routeOf([cand('post-commit-expert')]));
    const accepted = await acceptFeedbackRequestCore({ ...baseReq, requestKey: 'recoverable-post-commit' }, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const execute = vi.fn((payload: GetFeedbackRequest, context: NonNullable<GetFeedbackDeps['acceptedRequest']>) =>
      getFeedbackCore(payload, { ...fixture.deps, acceptedRequest: context,
        reach: async () => { throw new Error('process lost after selected row committed'); } }));
    const deps = { getSql: () => rootSql, now: () => NOW, execute };
    await expect(continueFeedbackRequestCore(WS, accepted.conversation_id, deps)).rejects.toThrow('process lost');
    expect((await stateRow(accepted.conversation_id)).state).toBe('awaiting_responder');
    expect(await continueFeedbackRequestCore(WS, accepted.conversation_id, deps)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('getFeedbackCore — routed', () => {
  it.each([
    ['acceptance-bar-amendment-review', 'floor'], ['acceptance-bar-amendment-review', 'minimum'],
    ['acceptance-bar-amendment-review', 'lexical'], ['rubric-vetting', 'floor'],
    ['rubric-vetting', 'minimum'], ['rubric-vetting', 'lexical'],
    ['method-review', 'floor'], ['method-review', 'minimum'], ['method-review', 'lexical'],
  ] as const)(
    'delivers the complete current review request for %s on the initial %s route',
    async (policy, selection) => {
      const question = 'Review the new acceptance amendment. Historical cleanup is background only.\n' +
        '{"requirement":{"key":"r-006","verification":{"check":{"kind":"tests","files":["soak.test.ts"]}}}}\n' +
        'Preserve the deployed literal 24-hour soak. Approval: thread-post:12345.';
      const candidate = cand('amendment-reviewer', {
        ...(selection === 'floor' ? {} : { score: 0.1, relevance: 0.1 }),
        ...(selection === 'lexical' ? { fallback: 'lexical' as const } : {}),
        evidence: [{ session_id: 'old-cleanup-only', turn_idx: 0, sim: 0.86, ts: '2026-10-13T00:00:00Z' }],
      });
      const fixture = makeDeps(routeOf(selection === 'floor' ? [candidate] : [], {
        all: [candidate],
        ...(selection === 'lexical' ? { degraded: 'embed-unavailable', fallback: 'lexical' } : {}),
      }));
      const result = asOk(await getFeedbackCore({ ...baseReq, question, policy, archiveFloor: 2,
        ...(policy === 'method-review' ? { methodReviewRubricRef: 'acceptance-current-method' } : {}) }, fixture.deps));
      expect(fixture.reached).toHaveLength(1);
      expect(fixture.reached[0].body).toContain(question);
      expect(fixture.reached[0].body).toContain(policy === 'rubric-vetting'
        ? 'CURRENT RUBRIC' : policy === 'method-review' ? 'CURRENT METHOD' : 'CURRENT AMENDMENT');
      expect(fixture.reached[0].body).toContain('results[0].conversation.body');
      expect(fixture.reached[0].body).toContain('do not decline solely');
      expect(fixture.reached[0].body).not.toContain('Answer FROM the transcript');
      expect((await stateRow(result.conversation_id)).routing).toMatchObject({ policy });
    },
  );

  it('persists the requested reviewer model with the consult for later cascades', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' } as const;
    const { deps } = makeDeps(routeOf([cand('agent-model')]));
    const result = asOk(await getFeedbackCore({
      ...baseReq, question: 'independent BAR model selection', reviewerModel,
    }, deps));
    expect((await stateRow(result.conversation_id)).routing).toMatchObject({ reviewerModel });
  });

  it('includes decision-park context in the reviewer-facing persisted consult body', async () => {
    const fixture = makeDeps(routeOf([cand('decision-park-reviewer')]));
    const workItemId = 'EI-27142685879939701';
    const blockerRef = 'native-repository-plan-declarations-2026-10-23#D-001';
    const evidence = 'Live plan read confirms D-001 names P-001 as owner and forbids reassignment.';
    const defaultAction = 'resume P-001 unless a reviewer supplies a superseding decision';
    const decisionAtStake = [
      `Parked work item: ${workItemId}`,
      `Blocker reference: ${blockerRef}`,
      `Default if no reviewer objects by 2026-11-02T03:00:00.000Z: ${defaultAction}`,
    ].join('\n');

    const result = asOk(await getFeedbackCore({
      ...baseReq,
      question: 'Should the named P-001 owner resume P-001, or supersede D-001?',
      originTaskRef: workItemId,
      observed: evidence,
      decisionAtStake,
    }, fixture.deps));

    expect(result.conversation_id).toBeTruthy();
    expect(fixture.opened).toHaveLength(1);
    expect(fixture.opened[0].body).toContain('Should the named P-001 owner resume P-001, or supersede D-001?');
    expect(fixture.opened[0].body).toContain('## Observed');
    expect(fixture.opened[0].body).toContain(evidence);
    expect(fixture.opened[0].body).toContain('## Decision at stake');
    expect(fixture.opened[0].body).toContain(workItemId);
    expect(fixture.opened[0].body).toContain(blockerRef);
    expect(fixture.opened[0].body).toContain(defaultAction);
  });

  it('routes to the top live candidate, persists the snapshot VERBATIM, wakes with evidence', async () => {
    const top = cand('agent-a');
    const second = cand('agent-b', { score: 0.6 });
    const route = routeOf([top, second]);
    const { deps, opened, reached } = makeDeps(route);

    const r = asOk(await getFeedbackCore({ ...baseReq, tried: 'restarted the provider', observed: 'events stop after ~40 queries' }, deps));

    expect(r.verdict).toBe('routed');
    expect(r.state).toBe('awaiting_responder');
    expect(r.responder?.ownerId).toBe('agent-a');
    expect(r.remaining_candidates).toEqual([
      { ownerId: 'agent-b', score: 0.6, relevance: 0.6, liveness: 'live', via: 'floor' },
    ]);
    expect(r.park_key).toBeNull(); // proceed contract
    expect(r.wake).toEqual({ attempted: true, queued: 1, woke: 0, pickupConfirmed: false });
    expect(r.hint).toContain('answering session launched');

    // Conversation: kind consult, addressed to NOBODY — D-002 delivery is a
    // launch, and a direct_to here would notify the very agent we must not wake.
    expect(opened).toHaveLength(1);
    expect(opened[0].kind).toBe('consult');
    expect(opened[0].direct_to).toEqual([]);
    expect(opened[0].body).toContain('## Tried');
    expect(opened[0].body).toContain('## Observed');

    // The dispatch brief carries the why-you-were-chosen evidence refs (D-008 §5).
    expect(reached).toHaveLength(1);
    expect(reached[0].responder).toBe('agent-a');
    expect(reached[0].evidence).toEqual(top.evidence);
    expect(reached[0].body).toContain('sess-agent-a#3');

    // Row: snapshot verbatim, expiry from the proceed contract, wake debited.
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('agent-a');
    expect(row.wakes_used).toBe(1);
    expect((row.routing as RoutingSnapshot).selection?.selected[0]?.evidence).toEqual(top.evidence);
    // Verbatim EXCEPT the dispatch stamp (D-002): the answering identity is
    // written onto the cursor entry after the route, and is the ONLY thing this
    // path may add. Named explicitly rather than loosened to a partial match,
    // so a second unannounced mutation of the snapshot still fails here.
    const expectedSnapshot = JSON.parse(JSON.stringify(route.snapshot));
    expectedSnapshot.selection.selected[0].answeringOwnerId = 'agent-a-fork';
    expect(row.routing).toEqual(expectedSnapshot);
    expect(new Date(row.expires_at as string).getTime()).toBe(NOW.getTime() + PROCEED_EXPIRY_MS);
  });

  it('hard-blocked contract: park_key + the shorter expiry', async () => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore({ ...baseReq, latencyContract: 'hard-blocked' }, deps));
    expect(r.park_key).toBe(`consult:reply:${r.conversation_id}`);
    expect(r.hint).toContain('events:await');
    expect(r.hint).toContain('a subsequent reply wakes you');
    expect(r.hint).toContain('a reply that arrives before registration is an earlier edge');
    expect(r.hint).not.toContain('latched');
    const row = await stateRow(r.conversation_id);
    expect(row.latency_contract).toBe('hard-blocked');
    expect(new Date(row.expires_at as string).getTime()).toBe(NOW.getTime() + HARD_BLOCKED_EXPIRY_MS);
  });

  it.each([true, false])('persists explicit dispatch intent %s for request-cohort reporting', async (allowDispatch) => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    if (!allowDispatch) deps.reach = async () => ({ queued: 0, woke: 0, pickupConfirmed: false });
    const result = asOk(await getFeedbackCore({ ...baseReq, allowDispatch }, deps));
    const stored = await stateRow(result.conversation_id);
    expect((stored.routing as RoutingSnapshot).deliveryIntent).toBe(allowDispatch ? 'dispatch' : 'retrieval-only');
  });

  it.each(['proceed', 'hard-blocked'] as const)('retrieval-only %s returns the full menu without dispatch or a promised answer', async (latencyContract) => {
    const { deps, reached } = makeDeps(routeOf([cand('agent-a'), cand('agent-b')]));
    const result = asOk(await getFeedbackCore({ ...baseReq, allowDispatch: false, latencyContract }, deps));

    expect(reached).toEqual([]);
    expect(result).toMatchObject({
      verdict: 'retrieval_only',
      reason: 'retrieval_only',
      state: 'no_qualified_responder',
      responder: null,
      responder_via: null,
      expires_at: null,
      park_key: null,
      wake: { attempted: false, queued: 0, woke: 0, pickupConfirmed: false },
    });
    expect(result.remaining_candidates.map((candidate) => candidate.ownerId)).toEqual(['agent-a', 'agent-b']);
    expect(result.hint).toContain('Retrieval-only');
    expect(result.hint).not.toContain('NO allowed model');
    const stored = await stateRow(result.conversation_id);
    expect(stored).toMatchObject({ state: 'no_qualified_responder', responder_id: null, expires_at: null, wakes_used: 0 });
    expect((stored.routing as RoutingSnapshot).deliveryIntent).toBe('retrieval-only');
  });

  it.each(['answer', 'new_fact', 'decline'] as const)('reads typed responder receipts after expiry independently of the bounded cascade digest: %s', async (kind) => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const result = asOk(await getFeedbackCore(baseReq, deps));
    const sql = deps.getSql();
    const sinceMs = NOW.getTime() - 60_000;
    const untilMs = NOW.getTime() + 10_000;
    const asOf = '2026-08-16T00:00:00.123456Z';
    await sql`
      UPDATE harness_shared.consult_state
         SET state = 'expired', cascade_digest = '[]'::jsonb, created_at = ${NOW.toISOString()}::timestamptz
       WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id}
    `;
    await sql`
      INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind, created_at)
      VALUES (${WS}, ${910000 + convSeq * 2}, ${result.conversation_id}, ${baseReq.requesterId}, 'new_fact', '2026-08-16T00:00:00.123450Z')
    `;
    const read = () => readRoutingHealthRows(sql, WS, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), 5000, asOf);
    expect((await read()).rows.find((row) => row.conversation_id === result.conversation_id)).toMatchObject({ has_feedback: false, has_decline: false });
    await sql`
      INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind, created_at)
      VALUES (${WS}, ${910001 + convSeq * 2}, ${result.conversation_id}, 'agent-a-fork', ${kind}, '2026-08-16T00:00:00.123457Z')
    `;
    expect((await read()).rows.find((row) => row.conversation_id === result.conversation_id)).toMatchObject({ has_feedback: false, has_decline: false });
    await sql`UPDATE harness_shared.consult_post_meta SET created_at = '2026-08-16T00:00:00.123455Z' WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id} AND author_id = 'agent-a-fork'`;
    const { rows, truncated } = await read();
    // Prepared timestamptz parameters are serialized through a JS Date by
    // postgres.js. A text parameter preserves the database's microsecond cut.
    const [cuts] = await sql`
      SELECT ${asOf}::timestamptz::text AS inferred_cut,
             ${asOf}::text::timestamptz::text AS exact_cut,
             '2026-08-16T00:00:00.123455Z'::timestamptz <= ${asOf}::timestamptz AS inferred_includes,
             '2026-08-16T00:00:00.123455Z'::timestamptz <= ${asOf}::text::timestamptz AS exact_includes
    `;
    expect(cuts.inferred_includes).toBe(false);
    expect(cuts.exact_includes).toBe(true);
    expect(rows.find((row) => row.conversation_id === result.conversation_id),
      JSON.stringify({ cuts, asOf, selectedRow: rows.find((row) => row.conversation_id === result.conversation_id) }),
    ).toMatchObject({ has_feedback: kind !== 'decline', has_decline: kind === 'decline' });
    expect(truncated).toBe(false);
    const receiptRow = rows.find((row) => row.conversation_id === result.conversation_id)!;
    const receiptHealth = routingHealthFromRows([receiptRow], { sinceMs, untilMs, nowMs: Date.parse(asOf), truncatedByLimit: false });
    expect(receiptHealth.requestCohort.totals.outcomes[kind === 'decline' ? 'declined' : 'received']).toBe(1);
    expect(receiptHealth.requestCohort.totals.outcomes.failed).toBe(0);
    await sql`UPDATE harness_shared.consult_post_meta SET created_at = ${asOf}::text::timestamptz WHERE workspace_id = ${WS} AND conversation_id = ${result.conversation_id} AND author_id = 'agent-a-fork'`;
    expect((await read()).rows.find((row) => row.conversation_id === result.conversation_id)).toMatchObject({ has_feedback: kind !== 'decline', has_decline: kind === 'decline' });
  });

  it('R-2: a DEAD top candidate is selected, not skipped — deadness changes neither rank nor eligibility', async () => {
    const deadTop = cand('agent-dead', { score: 0.9, liveness: 'ended' });
    const liveSecond = cand('agent-live', { score: 0.6, liveness: 'parked' });
    const { deps, opened, reached } = makeDeps(routeOf([deadTop, liveSecond]));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.responder?.ownerId).toBe('agent-dead');
    expect(r.responder_via).toBe('floor');
    expect(opened[0].direct_to).toEqual([]);
    // Dispatched from the dead expert's transcript — the whole point of D-002.
    expect(reached.map((d) => d.responder)).toEqual(['agent-dead']);
    // …and the LIVE second stays on the menu BEHIND the dead head rather than
    // being promoted past it. That ordering IS R-2: liveness moved neither
    // candidate, so a decline or expiry cascades to the live one next.
    expect(r.remaining_candidates.map((c) => c.ownerId)).toEqual(['agent-live']);
  });

  it('owner-pause gate: a verified paused candidate is skipped for a fallback', async () => {
    const pausedTop = cand('agent-owner-paused', { score: 0.9, liveness: 'live', ownerPaused: true });
    const liveFallback = cand('agent-live-owner-pause-fallback', {
      score: 0.2,
      liveness: 'live',
      signals: { similarity: 0.2, verification: 0, authorship: 0, freshness: 1 },
    });
    const { deps, opened } = makeDeps(
      routeOf([pausedTop], { all: [pausedTop, liveFallback] }),
    );
    const r = asOk(await getFeedbackCore(baseReq, deps));
    // The ONE gate D-002 keeps: an owner pause is an authoritative stand-down,
    // and a fork still spends that identity's transcript and fleet budget.
    expect(r.responder?.ownerId).toBe('agent-live-owner-pause-fallback');
    expect(r.responder_via).toBe('minimum');
    expect(opened[0].direct_to).toEqual([]);

    const row = await stateRow(r.conversation_id);
    expect((row.routing as RoutingSnapshot).candidates).toContainEqual(
      expect.objectContaining({ ownerId: 'agent-owner-paused', ownerPaused: true }),
    );
  });

  it('R-2: a warm-idle parked top candidate keeps its rank — warm-idle is not a gate either', async () => {
    const warmIdle = cand('agent-warm-idle', { score: 0.9, liveness: 'parked', warmIdle: true });
    const liveFallback = cand('agent-live-fallback', {
      score: 0.2,
      liveness: 'live',
      signals: { similarity: 0.2, verification: 0, authorship: 0, freshness: 1 },
    });
    const { deps, opened } = makeDeps(routeOf([warmIdle], { all: [warmIdle, liveFallback] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.responder?.ownerId).toBe('agent-warm-idle');
    expect(r.responder_via).toBe('floor');
    expect(opened[0].direct_to).toEqual([]);
    expect(r.remaining_candidates).toEqual([]);

    const row = await stateRow(r.conversation_id);
    const candidates = (row.routing as RoutingSnapshot).candidates;
    expect(candidates).toContainEqual(expect.objectContaining({ ownerId: 'agent-warm-idle', warmIdle: true }));
  });

  it('parked responders remain selectable without a liveness gate', async () => {
    const freshParked = cand('agent-fresh-parked', { score: 0.9, liveness: 'parked', warmIdle: false });
    const liveFallback = cand('agent-live-fallback-2', {
      score: 0.2,
      liveness: 'live',
      signals: { similarity: 0.2, verification: 0, authorship: 0, freshness: 1 },
    });
    const { deps } = makeDeps(routeOf([freshParked], { all: [freshParked, liveFallback] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.responder?.ownerId).toBe('agent-fresh-parked');
    expect(r.responder_via).toBe('floor');
  });

  it('R-2: an unknown/no-presence candidate is selectable — a missing presence signal is not a verdict about the transcript', async () => {
    const unknownTop = cand('agent-no-presence', { score: 0.9, liveness: 'unknown' });
    const liveFallback = cand('agent-live-fallback-3', {
      score: 0.2,
      liveness: 'live',
      signals: { similarity: 0.2, verification: 0, authorship: 0, freshness: 1 },
    });
    const { deps, opened, reached } = makeDeps(
      routeOf([unknownTop], { all: [unknownTop, liveFallback] }),
    );

    const r = asOk(await getFeedbackCore(baseReq, deps));

    expect(r.responder?.ownerId).toBe('agent-no-presence');
    expect(r.responder_via).toBe('floor');
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(1);
    expect(reached[0].responder).toBe('agent-no-presence');

    const row = await stateRow(r.conversation_id);
    expect(row.responder_id).toBe('agent-no-presence');
    const selection = (row.routing as RoutingSnapshot).selection;
    expect(selection?.selected[0]).toMatchObject({
      ownerId: 'agent-no-presence',
      via: 'floor',
      liveness: 'unknown',
    });
  });

  it('routes a rubric review, then cascades only the dispatch whose launch log ends on provider 429', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'consult-request-429-'));
    try {
      const rejectedOwner = `request-429-reviewer-${randomBytes(5).toString('hex')}`;
      const rejectedAnswerer = `${rejectedOwner}-fork`;
      const rejectedFixture = makeDeps(routeOf([cand(rejectedOwner), cand(`${rejectedOwner}-fallback`)]), {
        answeringOwnerId: rejectedAnswerer,
      });
      const rejectedRequest = asOk(await getFeedbackCore({
        ...baseReq,
        question: `Review a rubric for terminal provider failure ${rejectedOwner}.`,
        policy: 'rubric-vetting',
        archiveFloor: 2,
        latencyContract: 'hard-blocked',
      }, rejectedFixture.deps));

      const quotedOwner = `request-429-quoted-${randomBytes(5).toString('hex')}`;
      const quotedAnswerer = `${quotedOwner}-fork`;
      const quotedFixture = makeDeps(routeOf([cand(quotedOwner), cand(`${quotedOwner}-fallback`)]), {
        answeringOwnerId: quotedAnswerer,
      });
      const quotedRequest = asOk(await getFeedbackCore({
        ...baseReq,
        question: `Review a rubric that discusses a provider error as text ${quotedOwner}.`,
        policy: 'rubric-vetting',
        archiveFloor: 2,
        latencyContract: 'hard-blocked',
      }, quotedFixture.deps));

      const healthyOwner = `request-429-healthy-${randomBytes(5).toString('hex')}`;
      const healthyAnswerer = `${healthyOwner}-fork`;
      const healthyFixture = makeDeps(routeOf([cand(healthyOwner), cand(`${healthyOwner}-fallback`)]), {
        answeringOwnerId: healthyAnswerer,
      });
      const healthyRequest = asOk(await getFeedbackCore({
        ...baseReq,
        question: `Review a rubric with a healthy response despite a launcher 429 ${healthyOwner}.`,
        policy: 'rubric-vetting',
        archiveFloor: 2,
        latencyContract: 'hard-blocked',
      }, healthyFixture.deps));

      const kickoffAt = new Date(NOW.getTime() - 2 * 60_000).toISOString();
      const rejectedTranscript = join(directory, 'rejected-rollout.jsonl');
      const quotedTranscript = join(directory, 'quoted-rollout.jsonl');
      const healthyTranscript = join(directory, 'healthy-rollout.jsonl');
      const rejectedLog = join(directory, 'rejected-launch.log');
      const quotedLog = join(directory, 'quoted-launch.log');
      const healthyLog = join(directory, 'healthy-launch.log');
      const started = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
      writeFileSync(rejectedTranscript, `${started}\n`);
      writeFileSync(quotedTranscript, `${started}\n`);
      writeFileSync(healthyTranscript, `${started}\n${JSON.stringify({
        type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'review complete' },
      })}\n`);
      writeFileSync(rejectedLog,
        "review brief\n⎿ API Error: Request rejected (429) · This request would exceed your account's rate limit.\n");
      writeFileSync(quotedLog,
        "The review brief quotes API Error: Request rejected (429) · This request would exceed your account's rate limit.\n");
      writeFileSync(healthyLog,
        "review brief\n⎿ API Error: Request rejected (429) · This request would exceed your account's rate limit.\n");

      for (const entry of [
        {
          conversationId: rejectedRequest.conversation_id,
          sourceOwnerId: rejectedOwner,
          answeringOwnerId: rejectedAnswerer,
          transcriptPath: rejectedTranscript,
          launchLogPath: rejectedLog,
        },
        {
          conversationId: quotedRequest.conversation_id,
          sourceOwnerId: quotedOwner,
          answeringOwnerId: quotedAnswerer,
          transcriptPath: quotedTranscript,
          launchLogPath: quotedLog,
        },
        {
          conversationId: healthyRequest.conversation_id,
          sourceOwnerId: healthyOwner,
          answeringOwnerId: healthyAnswerer,
          transcriptPath: healthyTranscript,
          launchLogPath: healthyLog,
        },
      ]) {
        await appendDispatchRecord(rootSql, {
          workspaceId: WS,
          conversationId: entry.conversationId,
          sourceOwnerId: entry.sourceOwnerId,
          result: {
            dispatched: true,
            answeringOwnerId: entry.answeringOwnerId,
            operation: 'fork',
            agent: 'codex',
            model: 'sol',
            verified: true,
            detail: 'forked and registered',
            attempts: [{
              rank: 1,
              agent: 'codex',
              model: 'sol',
              operation: 'fork',
              outcome: 'dispatched',
              detail: 'first turn not yet observed',
              launchLogPath: entry.launchLogPath,
              firstTurnUnjudged: { agent: 'codex', transcriptPath: entry.transcriptPath, kickoffAt },
            }],
          },
        }, kickoffAt);
      }

      const reached: Array<{ conversationId: string; responder: string }> = [];
      const r = await sweepExpiredConsults({
        getSql: () => rootSql,
        now: () => NOW,
        emitReplyEvent: async () => {},
        notifyRequester: async () => {},
        rejudgeFirstTurn: (unjudged) => rejudgeFirstTurn(unjudged),
        dispatch: async (opts) => {
          reached.push({ conversationId: opts.conversationId, responder: opts.responder });
          return { woke: 1, answeringOwnerId: `${opts.responder}-fork` };
        },
      });

      expect(r.advanced).toBeGreaterThanOrEqual(1);
      expect(await stateRow(rejectedRequest.conversation_id)).toMatchObject({
        state: 'awaiting_responder', responder_id: `${rejectedOwner}-fallback`, cascade_cursor: 1,
      });
      expect(await stateRow(quotedRequest.conversation_id)).toMatchObject({
        state: 'awaiting_responder', responder_id: quotedOwner, cascade_cursor: 0,
      });
      expect(await stateRow(healthyRequest.conversation_id)).toMatchObject({
        state: 'awaiting_responder', responder_id: healthyOwner, cascade_cursor: 0,
      });
      expect(reached.filter((entry) => entry.conversationId === rejectedRequest.conversation_id)
        .map((entry) => entry.responder)).toEqual([`${rejectedOwner}-fallback`]);
      expect(reached.filter((entry) => entry.conversationId === quotedRequest.conversation_id)).toEqual([]);
      expect(reached.filter((entry) => entry.conversationId === healthyRequest.conversation_id)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('getFeedbackCore — honest no_qualified_responder', () => {
  it('below_floor (pure-floor min:0): still opens + persists the verdict (D-003 honesty feed), no wake', async () => {
    // Under the D-003 global min of 1 a live below-floor pool now ROUTES
    // (minimum-fill) — the honest below_floor verdict survives via min:0.
    const { deps, opened, reached } = makeDeps(routeOf([], { all: [cand('agent-sub', { score: 0.3 })] }));
    const r = asOk(await getFeedbackCore({ ...baseReq, minResponders: 0 }, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor');
    expect(r.hint).toContain('Proceed on your own judgment');
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('no_qualified_responder');
    expect(row.responder_id).toBeNull();
    expect(row.wakes_used).toBe(0);
    expect(row.expires_at).toBeNull();
  });

  it('does not minimum-fill a transcript that fails a required source reference', async () => {
    const subject = 'code-cleanup-campaigns-2026-10-26';
    const unrelated = cand('unrelated', { subjectEvidenceCoverage: {
      status: 'mismatch', required: [subject],
      evidence: [{ subject, status: 'mismatch', score: 0.1 }], unresolved: [],
    } });
    const { deps, opened, reached } = makeDeps(routeOf([], { all: [unrelated] }));
    const r = asOk(await getFeedbackCore({ ...baseReq, resolvedSubjectRefs: [subject] }, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor');
    expect(r.hint).toContain('unrelated transcripts were not dispatched');
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row).toMatchObject({ state: 'no_qualified_responder', responder_id: null, wakes_used: 0 });
  });

  it('an all-dead qualified pool ROUTES (the no_live_responder verdict is retired with the wake)', async () => {
    const { deps, reached } = makeDeps(
      routeOf([cand('agent-d1', { liveness: 'ended' }), cand('agent-d2', { liveness: 'recorded' })]),
    );
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('routed');
    expect(r.reason).toBeUndefined();
    expect(r.responder?.ownerId).toBe('agent-d1');
    expect(reached.map((d) => d.responder)).toEqual(['agent-d1']);
    const row = await stateRow(r.conversation_id);
    expect(row.state).toBe('awaiting_responder');
  });

  it('embed_unavailable: cannot-measure ≠ measured-nothing, and the VERDICT says so', async () => {
    const { deps } = makeDeps(routeOf([], { degraded: 'embed-unavailable' }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    // The distinction used to live only in `reason`/`degraded`/`hint`, while
    // `verdict` — the field a caller actually branches on — still reported the
    // measured absence. That made a cold-start latency breach read as "no one
    // knows more than you do" (EI-21485716602970457).
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.verdict).not.toBe('no_qualified_responder');
    expect(r.reason).toBe('embed_unavailable');
    expect(r.degraded).toBe('embed-unavailable');
    const row = await stateRow(r.conversation_id);
    expect((row.routing as { degraded?: string }).degraded).toBe('embed-unavailable');
    // The PERSISTED lifecycle state deliberately does NOT change: the row is a
    // genuine no-responder conversation, and `consult_state_state_check` admits
    // no new value. verdict (routing outcome) and state (conversation lifecycle)
    // are separate fields — `routed` already pairs with `awaiting_responder`.
    expect(r.state).toBe('no_qualified_responder');
    expect(row.state).toBe('no_qualified_responder');
  });

  it('keeps unavailable subject evidence honest at the requester contract', async () => {
    const { deps } = makeDeps(routeOf([], { degraded: 'evidence-unavailable' }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.reason).toBe('evidence_unavailable');
    expect(r.degraded).toBe('evidence-unavailable');
    expect(r.hint).toContain('does not prove no expert exists');
    expect(r.unmeasured_candidates).toEqual([]);
    expect(r.hint).toContain('No unmeasured candidate transcript references');
    expect((await stateRow(r.conversation_id)).routing).toMatchObject({ degraded: 'evidence-unavailable' });
  });

  it('returns bounded unmeasured transcript refs without selecting or dispatching them', async () => {
    const subject = 'packages/operator-core/lib/agent-tools/plans/spec-quality.ts';
    const candidates = Array.from({ length: 5 }, (_, index) => cand(`unmeasured-${index}`, {
      evidence: Array.from({ length: 5 }, (_, turn) => ({
        session_id: `session-${index}`, turn_idx: turn, ts: NOW.toISOString(), sim: 0.72,
      })),
      subjectEvidenceCoverage: { status: 'unmeasured', required: [subject],
        evidence: [{ subject, status: 'unmeasured', score: null }], unresolved: [] },
    }));
    const mismatch = cand('measured-mismatch', { subjectEvidenceCoverage: {
      status: 'mismatch', required: [subject],
      evidence: [{ subject, status: 'mismatch', score: 0.1 }], unresolved: [],
    } });
    const { deps, opened, reached } = makeDeps(routeOf([], {
      degraded: 'evidence-unavailable', all: [mismatch, ...candidates],
    }));
    const r = asOk(await getFeedbackCore({ ...baseReq, resolvedSubjectRefs: [subject] }, deps));
    expect(r).toMatchObject({ verdict: 'relevance_unmeasured', reason: 'evidence_unavailable',
      state: 'no_qualified_responder', responder: null, remaining_candidates: [] });
    expect(r.unmeasured_candidates).toEqual(candidates.slice(0, 3).map(candidate => ({
      ownerId: candidate.ownerId, qualification: 'unmeasured', evidence: candidate.evidence.slice(0, 3),
    })));
    expect(r.hint).toContain('sessions:read');
    expect(r.hint).toContain('not selected or dispatchable');
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(0);
    const row = await stateRow(r.conversation_id);
    expect(row).toMatchObject({ state: 'no_qualified_responder', responder_id: null, wakes_used: 0 });
    expect((row.routing as RoutingSnapshot).candidates).toEqual([mismatch, ...candidates]);
    expect((row.routing as { selection: { selected: unknown[] } }).selection.selected).toEqual([]);
  });

  it('embed_unavailable lexical candidates route one bounded manual-review pick', async () => {
    const lexical = cand('agent-lexical', {
      score: 0.31,
      relevance: 0,
      signals: { similarity: 0, verification: 0, authorship: 0, freshness: 1 },
      evidence: [{
        session_id: 'sess-agent-lexical',
        turn_idx: 4,
        ts: NOW.toISOString(),
        sim: 0,
        lexicalRank: 0.42,
      }],
      fallback: 'lexical',
    });
    const second = cand('agent-lexical-2', {
      score: 0.2,
      relevance: 0,
      signals: { similarity: 0, verification: 0, authorship: 0, freshness: 0.6 },
      fallback: 'lexical',
    });
    const { deps, opened, reached } = makeDeps(
      routeOf([], { degraded: 'embed-unavailable', fallback: 'lexical', all: [lexical, second] }),
    );
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('routed');
    expect(r.reason).toBeUndefined();
    expect(r.degraded).toBe('embed-unavailable');
    expect(r.responder).toMatchObject({ ownerId: 'agent-lexical', fallback: 'lexical' });
    expect(r.responder_via).toBe('minimum');
    // The default minimum is one, so the lexical fallback does not broadcast
    // to the second candidate; it remains only in the router snapshot.
    expect(r.remaining_candidates).toEqual([]);
    expect(opened[0].direct_to).toEqual([]);
    expect(reached).toHaveLength(1);
    expect(reached[0].body).toContain('MANUAL-REVIEW');
    expect(reached[0].body).toContain('lexical rank 0.420');
    expect(r.hint).toContain('BOUNDED MANUAL-REVIEW');
    const row = await stateRow(r.conversation_id);
    expect((row.routing as { fallback?: string }).fallback).toBe('lexical');
    expect((row.routing as { selection?: { selected: Array<{ fallback?: string }> } }).selection?.selected[0]?.fallback).toBe(
      'lexical',
    );
  });
});

describe('getFeedbackCore — wake budget REMOVED (consult-min-max-and-rubric-vetting D-005)', () => {
  it('routes + wakes regardless of how many wakes sibling consults on the same origin ref already spent', async () => {
    const ref = 'WI-BUDGET-1';
    // Seed well past the OLD budget of 4 — under the removed gate this consult
    // would have been delivered by subscription only; now it must still wake.
    for (let i = 0; i < 6; i++) {
      await rootSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, state, question, origin_task_ref, wakes_used)
        VALUES (${WS}, ${`conv-seed-${ref}-${i}`}, 'req-1', 'awaiting_responder', 'q', ${ref}, 1)`;
    }
    const { deps, reached } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore({ ...baseReq, originTaskRef: ref }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.state).toBe('awaiting_responder');
    expect(r.wake).toEqual({ attempted: true, queued: 1, woke: 0, pickupConfirmed: false }); // no budget surfaces at all
    expect(r.hint).not.toContain('budget');
    expect(reached).toHaveLength(1);
    const row = await stateRow(r.conversation_id);
    expect(row.wakes_used).toBe(1); // still WRITTEN as a plain stat (D-005)
  });
});

describe('getFeedbackCore — rubric grader/critic role separation (EI-21469207548268721)', () => {
  it('excludes prior scorecard authors before routing a critique of that rubric', async () => {
    const rubricRef = 'acceptance-hlc-contention-free-clock-2026-08-12';
    const grader = cand('agent-rubric-grader', { score: 0.91 });
    const rubricAuthor = cand('agent-rubric-author', { score: 0.87 });
    const rubricProposer = cand('agent-rubric-proposer', { score: 0.83 });
    const independent = cand('agent-independent-critic', { score: 0.79 });
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, workspace_id, status, payload)
      VALUES
        ('EI-RUBRIC-GRADE-1', ${WS}, 'done', ${rootSql.json({
          _ei: { created_by: grader.ownerId },
          observation: { rubricRef, ratings: { c1: { rating: 'healthy', evidence: 'first grade' } } },
        })}),
        ('EI-RUBRIC-GRADE-2', ${WS}, 'done', ${rootSql.json({
          _ei: { created_by: grader.ownerId },
          observation: {
            rubricRef,
            ratings: { c1: { rating: 'healthy', evidence: 'superseding grade' } },
            supersedes: 'EI-RUBRIC-GRADE-1',
          },
        })})`;
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, plan_slug, template, template_slug, owner, template_data)
      VALUES
        (${WS}, ${rubricRef}, 'rubric', NULL, ${rubricAuthor.ownerId}, ${rootSql.json({ proposedBy: rubricProposer.ownerId })})`;

    const routed = routeOf([grader, rubricAuthor, rubricProposer, independent], {
      all: [grader, rubricAuthor, rubricProposer, independent],
    });
    const { deps, routeCalls } = makeDeps(routed);
    // Mirror the production routeConsult seam: owners passed in excludeOwners
    // cannot appear in either the qualified or minimum-fill candidate pool.
    deps.route = async (params) => {
      routeCalls.push(params);
      const excluded = new Set(params.excludeOwners ?? []);
      return routeOf(
        routed.qualified.filter((candidate) => !excluded.has(candidate.ownerId)),
        { all: routed.snapshot.candidates.filter((candidate) => !excluded.has(candidate.ownerId)) },
      );
    };

    const result = asOk(
      await getFeedbackCore(
        {
          ...baseReq,
          question:
            `Fresh successor critique request for ${rubricRef} revision 2. ` +
            'Are its criteria non-overlapping, outcome-focused, falsifiable, and complete?',
        },
        deps,
      ),
    );

    expect(routeCalls).toHaveLength(1);
    expect(new Set(routeCalls[0]?.excludeOwners)).toEqual(
      new Set([grader.ownerId, rubricAuthor.ownerId, rubricProposer.ownerId]),
    );
    expect(result.responder?.ownerId).toBe('agent-independent-critic');
  });

  it('does not exclude a grader from an ordinary explanation request about its scorecard', async () => {
    const rubricRef = 'acceptance-explain-scorecard-2026-08-25';
    const grader = cand('agent-scorecard-explainer', { score: 0.91 });
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, workspace_id, status, payload)
      VALUES ('EI-RUBRIC-EXPLAIN', ${WS}, 'done', ${rootSql.json({
        _ei: { created_by: grader.ownerId },
        observation: { rubricRef, ratings: { c1: { rating: 'healthy', evidence: 'grade evidence' } } },
      })})`;

    const { deps, routeCalls } = makeDeps(routeOf([grader]));
    const result = asOk(
      await getFeedbackCore(
        {
          ...baseReq,
          question: `Explain the evidence recorded in rubricRef: '${rubricRef}'.`,
        },
        deps,
      ),
    );

    expect(routeCalls[0]?.excludeOwners).toBeUndefined();
    expect(result.responder?.ownerId).toBe(grader.ownerId);
  });
});

describe('getFeedbackCore — prior non-helpful responders on a re-ask (EI-22180634511432554)', () => {
  /** Mirrors the production routeConsult seam (see the rubric-grader block
   * above): owners passed in excludeOwners cannot appear in the candidate pool. */
  function filteringDeps(routed: RouteResult) {
    const { deps, routeCalls } = makeDeps(routed);
    deps.route = async (params) => {
      routeCalls.push(params);
      const excluded = new Set(params.excludeOwners ?? []);
      return routeOf(
        routed.qualified.filter((c) => !excluded.has(c.ownerId)),
        { all: routed.snapshot.candidates.filter((c) => !excluded.has(c.ownerId)) },
      );
    };
    return { deps, routeCalls };
  }

  it('excludes a responder who closed_cant_help this EXACT question before, and notes it in the hint', async () => {
    const question = 'Does rubric-vetting-cycle-fix cover the D-009 independence gate?';
    const priorResponder = 'su-declined-before';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question)
      VALUES (${WS}, 'conv-prior-cant-help', ${baseReq.requesterId}, ${priorResponder}, 'closed_cant_help', ${question})
    `;

    const routed = routeOf([cand(priorResponder, { score: 0.95 }), cand('su-fresh-candidate', { score: 0.88 })]);
    const { deps, routeCalls } = filteringDeps(routed);

    const result = asOk(await getFeedbackCore({ ...baseReq, question }, deps));

    expect(routeCalls[0]?.excludeOwners).toEqual([priorResponder]);
    expect(result.responder?.ownerId).toBe('su-fresh-candidate');
    expect(result.hint).toContain(priorResponder);
    expect(result.hint).toContain('already told you "not this one"');
  });

  it('folds in EVERY decliner of a menu-exhausted `declined` consult on the exact question, via cascade_digest', async () => {
    const question = 'Is F-9001 ready to ship past its acceptance gate?';
    const decliner1 = 'su-decliner-one';
    const decliner2 = 'su-decliner-two';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question, cascade_digest)
      VALUES (
        ${WS}, 'conv-prior-declined', ${baseReq.requesterId}, ${decliner2}, 'declined', ${question},
        ${rootSql.json([
          { ownerId: decliner1, kind: 'decline', at: NOW.toISOString(), excerpt: 'not my area' },
          { ownerId: decliner2, kind: 'decline', at: NOW.toISOString(), excerpt: 'menu exhausted' },
        ] as never)}
      )
    `;

    const routed = routeOf([
      cand(decliner1, { score: 0.9 }),
      cand(decliner2, { score: 0.85 }),
      cand('su-fresh-candidate-2', { score: 0.7 }),
    ]);
    const { deps, routeCalls } = filteringDeps(routed);

    const result = asOk(await getFeedbackCore({ ...baseReq, question }, deps));

    expect(new Set(routeCalls[0]?.excludeOwners)).toEqual(new Set([decliner1, decliner2]));
    expect(result.responder?.ownerId).toBe('su-fresh-candidate-2');
  });

  it('does NOT exclude across a merely-different question — exact match only, never fuzzy', async () => {
    const priorResponder = 'su-declined-elsewhere';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question)
      VALUES (${WS}, 'conv-different-question', ${baseReq.requesterId}, ${priorResponder}, 'closed_cant_help', 'a completely unrelated prior question')
    `;
    const { deps, routeCalls } = makeDeps(routeOf([cand(priorResponder)]));

    const result = asOk(
      await getFeedbackCore({ ...baseReq, question: 'a fresh, never-before-asked question' }, deps),
    );

    expect(routeCalls[0]?.excludeOwners).toBeUndefined();
    expect(result.responder?.ownerId).toBe(priorResponder);
  });

  it('does not double-report an exclusion the caller already named via excludeOwners', async () => {
    const question = 'Explicitly-excluded re-ask question (EI-22180634511432554)';
    const priorResponder = 'su-already-named';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question)
      VALUES (${WS}, 'conv-explicit-exclude', ${baseReq.requesterId}, ${priorResponder}, 'closed_cant_help', ${question})
    `;
    const routed = routeOf([cand('su-fresh-candidate-3', { score: 0.6 })]);
    const { deps } = filteringDeps(routed);

    const result = asOk(
      await getFeedbackCore({ ...baseReq, question, excludeOwners: [priorResponder] }, deps),
    );

    expect(result.hint).not.toContain('already told you');
  });
});

describe('getFeedbackCore — exclusion boundary', () => {
  it('does not route an explicitly excluded dead owner', async () => {
    const excludedOwner = 'su-explicitly-excluded-dead';
    const remainingDeadOwner = 'su-remaining-dead';
    const routed = routeOf([
      cand(excludedOwner, { liveness: 'ended' }),
      cand(remainingDeadOwner, { liveness: 'ended' }),
    ]);
    const { deps, routeCalls, reached } = makeDeps(routed);

    const result = asOk(
      await getFeedbackCore(
        { ...baseReq, question: 'explicit exclusion must not leak into fallback candidates', excludeOwners: [excludedOwner] },
        deps,
      ),
    );

    expect(routeCalls[0]?.excludeOwners).toEqual([excludedOwner]);
    // Deadness no longer refuses the route, so what this pins is the EXCLUSION:
    // the excluded owner appears in neither the responder nor the fallback refs.
    expect(result.responder?.ownerId).toBe(remainingDeadOwner);
    expect(result.remaining_candidates.map((candidate) => candidate.ownerId)).not.toContain(excludedOwner);
    expect(reached.map((d) => d.responder)).toEqual([remainingDeadOwner]);
    expect(reached.map((d) => d.responder)).not.toContain(excludedOwner);
  });
});

describe('getFeedbackCore — min/max selection (consult-min-max-and-rubric-vetting D-001/D-002/D-003)', () => {
  /** The persisted selection block of a consult_state.routing snapshot. */
  const selectionOf = (routing: unknown) =>
    (routing as { selection?: { min: number; max: number; selected: Array<{ ownerId: string; via: string }> } })
      .selection;

  it('below-floor minimum-fill: routes the best-available candidate, labeled everywhere + honest wake body', async () => {
    const below = cand('agent-min', {
      score: 0.31,
      signals: { similarity: 0.22, verification: 0.3, authorship: 0, freshness: 1 },
    });
    const { deps, reached } = makeDeps(routeOf([], { all: [below] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('routed'); // D-003: min 1 fills even below the floor
    expect(r.responder?.ownerId).toBe('agent-min');
    expect(r.responder_via).toBe('minimum');
    expect(r.hint).toContain('minimum-fill'); // the viaNote warning rides the hint
    // D-002 honest wake body: first-principles request, no costumed expertise.
    expect(reached).toHaveLength(1);
    expect(reached[0].body).toContain('BEST-AVAILABLE');
    expect(reached[0].body).toContain('FIRST-PRINCIPLES');
    expect(reached[0].body).toContain('do NOT decline solely for lack of context');
    // Persisted provenance: the snapshot's selection block survives verbatim.
    const sel = selectionOf((await stateRow(r.conversation_id)).routing);
    expect(sel?.min).toBe(1);
    expect(sel?.selected).toEqual([expect.objectContaining({ ownerId: 'agent-min', via: 'minimum' })]);
  });

  it('maxResponders caps the menu; delivery stays single-wake; provenance persisted', async () => {
    const qs = [cand('agent-1', { score: 0.9 }), cand('agent-2', { score: 0.8 }), cand('agent-3', { score: 0.7 })];
    const { deps, reached } = makeDeps(routeOf(qs));
    const r = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 2 }, deps));
    expect(r.responder?.ownerId).toBe('agent-1');
    expect(r.responder_via).toBe('floor');
    expect(r.remaining_candidates).toEqual([
      { ownerId: 'agent-2', score: 0.8, relevance: 0.8, liveness: 'live', via: 'floor' },
    ]);
    expect(reached).toHaveLength(1); // cascade, never a parallel-wake set
    const sel = selectionOf((await stateRow(r.conversation_id)).routing);
    expect(sel?.max).toBe(2);
    expect(sel?.selected.map((s) => s.ownerId)).toEqual(['agent-1', 'agent-2']);
  });

  it('persists the selection policy on the routing snapshot so the expiry sweep can recognize a review consult (P-014)', async () => {
    const qs = [cand('agent-1', { score: 0.9 }), cand('agent-2', { score: 0.8 })];
    const vetting = makeDeps(routeOf(qs));
    const r = asOk(await getFeedbackCore({ ...baseReq, question: 'vet rubric X', policy: 'rubric-vetting' }, vetting.deps));
    expect((await stateRow(r.conversation_id)).routing).toMatchObject({ policy: 'rubric-vetting' });

    // A consult opened without a policy stays unmarked — the sweep must not
    // mistake an ordinary consult for a review.
    const plain = makeDeps(routeOf(qs));
    const p = asOk(await getFeedbackCore({ ...baseReq, question: 'an ordinary question' }, plain.deps));
    expect((await stateRow(p.conversation_id)).routing).not.toHaveProperty('policy');
  });

  it('minResponders 0 restores pure-floor selection: a live below-floor pool is an honest below_floor', async () => {
    const below = cand('agent-min', { score: 0.31 });
    const { deps, reached } = makeDeps(routeOf([], { all: [below] }));
    const r = asOk(await getFeedbackCore({ ...baseReq, minResponders: 0 }, deps));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.reason).toBe('below_floor'); // The candidate missed the configured floors.
    expect(reached).toHaveLength(0);
  });

  it('a minimum fillable only by the dead IS filled — the minimum-fill no longer needs a live body', async () => {
    const dead = cand('agent-dead', { liveness: 'ended' });
    const { deps, reached } = makeDeps(routeOf([], { all: [dead] }));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.verdict).toBe('routed');
    expect(r.responder?.ownerId).toBe('agent-dead');
    expect(r.responder_via).toBe('minimum');
    expect(reached.map((d) => d.responder)).toEqual(['agent-dead']);
  });
});

describe('getFeedbackCore — origin_task_ref default', () => {
  it('defaults to the requester’s most recently progressed wip work-item', async () => {
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, taken_by, status, taken_at, last_progress_at) VALUES
        ('WI-OLD',  'req-1', 'wip',  ${new Date(NOW.getTime() - 3 * 86_400_000).toISOString()}::timestamptz, NULL),
        ('WI-HOT',  'req-1', 'wip',  ${new Date(NOW.getTime() - 2 * 86_400_000).toISOString()}::timestamptz,
                                     ${new Date(NOW.getTime() - 3_600_000).toISOString()}::timestamptz),
        ('WI-DONE', 'req-1', 'done', ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz),
        ('WI-PEER', 'peer',  'wip',  ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const { originTaskRef: _omit, ...reqNoRef } = baseReq;
    const r = asOk(await getFeedbackCore(reqNoRef, deps));
    expect(r.origin_task_ref).toBe('WI-HOT');
    const row = await stateRow(r.conversation_id);
    expect(row.origin_task_ref).toBe('WI-HOT');
  });

  it('explicit null stays null (no lookup, no aggregation)', async () => {
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect(r.origin_task_ref).toBeNull();
  });
});

describe('getFeedbackCore — bar-critique records its plan (P-007 / SPEC-P-007-CRITIQUE-REF)', () => {
  it('stores the plan slug as origin_task_ref and the policy on the persisted routing', async () => {
    const planSlug = `bar-critique-plan-${randomBytes(5).toString('hex')}`;
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, owner)
      VALUES (${WS}, 'papercusp', ${planSlug}, NULL)`;
    const { deps } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore({ ...baseReq, policy: 'bar-critique', originTaskRef: planSlug,
      harnessSlug: 'papercusp' }, deps));
    expect(r.origin_task_ref).toBe(planSlug);
    const [row] = (await rootSql`
      SELECT origin_task_ref, routing->>'policy' AS policy
        FROM harness_shared.consult_state WHERE conversation_id = ${r.conversation_id}
    `) as unknown as Array<{ origin_task_ref: string | null; policy: string | null }>;
    expect(row).toEqual({ origin_task_ref: planSlug, policy: 'bar-critique' });
  });

  it('excludes source responders and answer-author parties from existing same-plan critiques', async () => {
    const planSlug = 'bar-critique-lineage-' + randomBytes(5).toString('hex');
    const activeConversation = 'prior-active-' + planSlug;
    const closedConversation = 'prior-closed-' + planSlug;
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, owner)
      VALUES (${WS}, 'papercusp', ${planSlug}, NULL)
    `;
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         origin_task_ref, routing)
      VALUES (${WS}, ${activeConversation}, 'prior-requester', 'critique-source-open',
              'active', 'prior critique question', ${planSlug},
              ${rootSql.json({ policy: 'bar-critique' })})
    `;
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         origin_task_ref, routing, closed_at)
      VALUES (${WS}, ${closedConversation}, 'prior-requester', 'critique-source-closed',
              'closed_answered', 'prior critique question', ${planSlug},
              ${rootSql.json({ policy: 'bar-critique' })}, ${NOW.toISOString()}::timestamptz)
    `;
    await rootSql`
      INSERT INTO harness_shared.consult_post_meta
        (workspace_id, post_id, conversation_id, author_id, kind, created_at)
      VALUES (${WS}, 990101, ${activeConversation}, 'critique-open-fork', 'answer',
              ${NOW.toISOString()}::timestamptz),
             (${WS}, 990102, ${closedConversation}, 'critique-closed-fork', 'answer',
              ${new Date(NOW.getTime() + 1000).toISOString()}::timestamptz)
    `;

    const route = routeOf([
      cand('critique-open-fork'),
      cand('critique-closed-fork'),
      cand('critique-fresh'),
    ]);
    const fixture = makeDeps(route);
    const partyByOwner = new Map([
      ['critique-source-open', 'critique-open-party'],
      ['critique-open-fork', 'critique-open-party'],
      ['critique-source-closed', 'critique-closed-party'],
      ['critique-closed-fork', 'critique-closed-party'],
    ]);
    fixture.deps.getPartyKeys = async (_workspaceId, ownerIds) =>
      new Map(ownerIds.map((ownerId) => [ownerId, partyByOwner.get(ownerId) ?? ownerId]));

    asOk(await getFeedbackCore({
      ...baseReq,
      policy: 'bar-critique',
      originTaskRef: planSlug,
      harnessSlug: 'papercusp',
    }, fixture.deps));

    expect(fixture.routeCalls[0]?.excludePartyOwners).toEqual(expect.arrayContaining([
      'critique-source-open',
      'critique-open-fork',
      'critique-source-closed',
      'critique-closed-fork',
    ]));
    expect(route.qualified.map((candidate) => candidate.ownerId)).toEqual(['critique-fresh']);
    expect(route.snapshot.candidates.map((candidate) => candidate.ownerId)).toEqual(['critique-fresh']);
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['blank', '  '],
    ['existing work-item id', 'WI-WIP'],
    ['incident id', 'EI-26731140517030664'],
    ['unregistered plan slug', 'not-a-registered-plan'],
  ] as const)('refuses a bar-critique whose origin_task_ref is %s, writing no consult row', async (_label, ref) => {
    // A wip work-item exists, so the omitted case would otherwise DEFAULT to it —
    // exactly the wrong-reference outcome the clause's falsifier names.
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, taken_by, status, taken_at)
      VALUES ('WI-WIP', ${baseReq.requesterId}, 'wip', ${NOW.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING`;
    const { originTaskRef: _omit, ...reqNoRef } = baseReq;
    const req = ref === undefined ? { ...reqNoRef, harnessSlug: 'papercusp' }
      : { ...reqNoRef, originTaskRef: ref, harnessSlug: 'papercusp' };
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-a')]));
    const [{ n: before }] = (await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state`) as unknown as Array<{ n: number }>;
    const r = await getFeedbackCore({ ...req, policy: 'bar-critique' }, deps);
    expect('error' in r ? r.error : null).toBe('bar_critique_requires_plan');
    const [{ n: after }] = (await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state`) as unknown as Array<{ n: number }>;
    expect(after).toBe(before);
    expect(routeCalls).toHaveLength(0);
  });

  it.each([
    ['another harness', 'other-harness', WS],
    ['another workspace', 'papercusp', 'ws-foreign-plan'],
  ] as const)('refuses a registered plan slug that belongs to %s', async (_label, planHarness, planWorkspace) => {
    const planSlug = `out-of-scope-plan-${randomBytes(5).toString('hex')}`;
    await rootSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, owner)
      VALUES (${planWorkspace}, ${planHarness}, ${planSlug}, NULL)`;
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-a')]));
    const [{ n: before }] = (await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state`) as unknown as Array<{ n: number }>;
    const r = await getFeedbackCore({ ...baseReq, policy: 'bar-critique', originTaskRef: planSlug,
      harnessSlug: 'papercusp' }, deps);
    expect('error' in r ? r.error : null).toBe('bar_critique_requires_plan');
    const [{ n: after }] = (await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state`) as unknown as Array<{ n: number }>;
    expect(after).toBe(before);
    expect(routeCalls).toHaveLength(0);
  });
});

describe('getFeedbackCore — subjectRef routing', () => {
  it('passes the exact routing subject through to transcript retrieval', async () => {
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-a')]));
    asOk(await getFeedbackCore({ ...baseReq, subjectRef: 'acceptance-x' }, deps));
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.subjectRef).toBe('acceptance-x');
  });

  it('persists and forwards the complete expanded source-ref set', async () => {
    const fixture = makeDeps(routeOf([cand('agent-anchor-reviewer')]));
    const request: GetFeedbackRequest = {
      ...baseReq,
      requestKey: 'subject-ref-expansion-persistence',
      subjectRefs: ['apps/papercusp-docs/src/content/docs/faq.mdx'],
      resolvedSubjectRefs: ['src/billing.ts', 'src/backup.ts'],
      unresolvedSubjectRefs: ['apps/papercusp-docs/src/content/docs/incomplete.mdx'],
    };

    const accepted = await acceptFeedbackRequestCore(request, fixture.deps);
    if ('error' in accepted) throw new Error(`unexpected acceptance refusal: ${accepted.error}`);
    const stored = await rootSql`
      SELECT routing->'request'->'payload' AS payload
      FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(stored[0]?.payload).toMatchObject({
      subjectRefs: request.subjectRefs,
      resolvedSubjectRefs: request.resolvedSubjectRefs,
      unresolvedSubjectRefs: request.unresolvedSubjectRefs,
    });

    asOk(await getFeedbackCore(request, fixture.deps));
    expect(fixture.routeCalls[0]).toMatchObject({
      subjectRefs: request.resolvedSubjectRefs,
      unresolvedSubjectRefs: request.unresolvedSubjectRefs,
    });
  });
});

// ── P-005: recursion lineage — depth + cycle refusal (D-005 / D-007 §7) ──
describe('getFeedbackCore — recursion lineage (P-005)', () => {
  /** Seed a consult_state row that acts as a lineage parent. */
  async function seedParent(opts: {
    id: string;
    requesterId: string;
    responderId: string | null;
    depth?: number;
    parentConsultId?: string | null;
  }): Promise<string> {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         depth, parent_consult_id)
      VALUES (${WS}, ${opts.id}, ${opts.requesterId}, ${opts.responderId},
              'active', 'parent q', ${opts.depth ?? 0}, ${opts.parentConsultId ?? null})`;
    return opts.id;
  }

  it('a consult opened from within a consult carries parent depth+1 and persists the lineage', async () => {
    const parent = await seedParent({ id: 'lin-d0', requesterId: 'req-1', responderId: 'resp-b' });
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-c')]));
    const r = asOk(
      await getFeedbackCore({ ...baseReq, requesterId: 'resp-b', parentConsultId: parent }, deps),
    );
    expect(r.verdict).toBe('routed');
    const row = await stateRow(r.conversation_id);
    expect(row.depth).toBe(1);
    expect(row.parent_consult_id).toBe(parent);
    // The lineage's participants were excluded from routing (cycle refusal by construction).
    expect(routeCalls[0].excludeOwners).toEqual(expect.arrayContaining(['req-1', 'resp-b']));
  });

  it(`depth past ${MAX_CONSULT_DEPTH} is refused structurally — before any row/conversation is written`, async () => {
    await seedParent({ id: 'lin-deep-0', requesterId: 'a', responderId: 'b' });
    await seedParent({ id: 'lin-deep-1', requesterId: 'b', responderId: 'c', depth: 1, parentConsultId: 'lin-deep-0' });
    await seedParent({ id: 'lin-deep-2', requesterId: 'c', responderId: 'd', depth: 2, parentConsultId: 'lin-deep-1' });
    const { deps, opened } = makeDeps(routeOf([cand('agent-e')]));
    const r = await getFeedbackCore({ ...baseReq, requesterId: 'd', parentConsultId: 'lin-deep-2' }, deps);
    expect(r).toMatchObject({ error: 'consult_depth_exceeded', depth: 3, max_depth: MAX_CONSULT_DEPTH });
    expect(opened).toHaveLength(0); // no conversation, no consult_state row
  });

  it('the whole lineage chain (not just the direct parent) is excluded from routing', async () => {
    await seedParent({ id: 'lin-chain-0', requesterId: 'root-req', responderId: 'mid-resp' });
    await seedParent({ id: 'lin-chain-1', requesterId: 'mid-resp', responderId: 'leaf-resp', depth: 1, parentConsultId: 'lin-chain-0' });
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-fresh')]));
    const r = asOk(
      await getFeedbackCore({ ...baseReq, requesterId: 'leaf-resp', parentConsultId: 'lin-chain-1' }, deps),
    );
    expect(r.verdict).toBe('routed');
    expect(routeCalls[0].excludeOwners).toEqual(
      expect.arrayContaining(['root-req', 'mid-resp', 'leaf-resp']),
    );
    expect((await stateRow(r.conversation_id)).depth).toBe(2);
  });

  it('belt+braces: a route that hands back a lineage owner anyway is refused as consult_cycle', async () => {
    const parent = await seedParent({ id: 'lin-cycle', requesterId: 'cyc-req', responderId: 'cyc-resp' });
    // A (hypothetical, non-excluding) route impl returning the original requester.
    const { deps, opened } = makeDeps(routeOf([cand('cyc-req')]));
    const r = await getFeedbackCore({ ...baseReq, requesterId: 'cyc-resp', parentConsultId: parent }, deps);
    expect(r).toMatchObject({ error: 'consult_cycle' });
    if ('error' in r && r.error === 'consult_cycle') {
      expect(r.lineage).toEqual(expect.arrayContaining(['cyc-req', 'cyc-resp']));
    }
    expect(opened).toHaveLength(0);
  });

  it('an unknown parent_consult_id is refused (parent_consult_not_found)', async () => {
    const { deps, opened } = makeDeps(routeOf([cand('agent-a')]));
    const r = await getFeedbackCore({ ...baseReq, parentConsultId: 'no-such-consult' }, deps);
    expect(r).toMatchObject({ error: 'parent_consult_not_found', parent_consult_id: 'no-such-consult' });
    expect(opened).toHaveLength(0);
  });

  it('a requester-initiated consult (no parent) stays depth 0 with no lineage exclusions', async () => {
    const { deps, routeCalls } = makeDeps(routeOf([cand('agent-a')]));
    const r = asOk(await getFeedbackCore(baseReq, deps));
    expect((await stateRow(r.conversation_id)).depth).toBe(0);
    expect(routeCalls[0].excludeOwners).toBeUndefined();
  });
});

// ── P-006: archive-first retrieval ───────────────────────────────────────
// Each test uses its OWN workspace: the archive lookup matches any
// closed_answered row in the workspace, so shared-workspace seeds would
// couple the tests to execution order.

/** 768-d unit vector at angle θ in the (0,1) plane — cosine sim between two
 * vecAt angles is exactly cos(θ₁−θ₂), so archive similarity is controllable
 * (same idiom as relevance-router.integration.test.ts). */
function vecAt(theta: number): number[] {
  const v: number[] = new Array(768).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

/** Seed a CLOSED consult directly (the archive population). */
async function seedClosedConsult(opts: {
  ws: string;
  conv: string;
  vec: number[];
  responder?: string | null;
  question?: string;
  outcome?: Record<string, unknown>;
  mode?: string | null;
  profile?: string | null;
  /** Defaults to closed_answered, the only state the archive reads. */
  state?: string;
}): Promise<void> {
  // sql.json, NOT JSON.stringify + ::jsonb: this fixture connection runs
  // prepare:true, under which the hand-stringified idiom double-encodes into a
  // jsonb STRING scalar (->>'key' = NULL) — the exact corruption the core's
  // no-copy-of-copy predicate test would then falsely pass/fail on.
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       routing, outcome, closed_at, query_embedding, query_embedding_mode, query_embedding_profile)
    VALUES
      (${opts.ws}, ${opts.conv}, 'req-past', ${opts.responder ?? 'resp-arch'},
       ${opts.state ?? 'closed_answered'}, ${opts.question ?? 'an earlier, similar question'},
       '{}'::jsonb, ${rootSql.json((opts.outcome ?? { answer: 'archived answer', confidence: 'high' }) as never)},
       ${NOW.toISOString()}::timestamptz, ${JSON.stringify(opts.vec)}::vector,
       ${opts.mode === undefined ? 'gemma' : opts.mode},
       ${opts.profile === undefined ? EMBEDDER_DIM_SPECS.gemma.profileId : opts.profile})
  `;
}

describe('getFeedbackCore — archive-first retrieval (P-006)', () => {
  const qv = vecAt(0);

  it('routes a new method review even when an identical archived answer exists and archive_floor is lowered', async () => {
    const ws = 'ws-arch-current-method';
    await seedClosedConsult({ ws, conv: 'old-method-answer', vec: vecAt(0), responder: 'old-reviewer' });
    const fixture = makeDeps(routeOf([cand('current-method-reviewer')], { queryVec: qv }));
    const result = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws,
      policy: 'method-review', methodReviewRubricRef: 'acceptance-current-method', archiveFloor: 0 }, fixture.deps));
    expect(result.verdict).toBe('routed');
    expect(fixture.reached).toHaveLength(1);
    expect(fixture.reached[0].body).toContain('CURRENT METHOD');
    expect((await stateRow(result.conversation_id, ws)).routing).toMatchObject({ policy: 'method-review' });
  });

  it('a closed_answered consult with a highly similar question serves from the archive: instant close, no wake, provenance cited', async () => {
    const ws = 'ws-arch-serve';
    await seedClosedConsult({
      ws,
      conv: 'arch-src-1',
      vec: vecAt(0), // sim 1.0 vs qv
      responder: 'resp-arch',
      outcome: { answer: 'bump hnsw.ef_search', confidence: 'high' },
    });
    const { deps, opened, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('served_from_archive');
    expect(r.state).toBe('served_from_archive');
    expect(r.archive).toMatchObject({
      source_conversation_id: 'arch-src-1',
      responder_id: 'resp-arch',
      answer: { answer: 'bump hnsw.ef_search', confidence: 'high' },
    });
    expect(r.archive!.sim).toBeGreaterThanOrEqual(0.99);
    expect(r.hint).toContain('arch-src-1');
    // No wake, no budget: served, not consulted (D-006).
    expect(reached).toHaveLength(0);
    expect(r.wake).toMatchObject({ attempted: false, woke: 0 });
    // The conversation row still exists (D-008 §1 PK) but is delivered to no one.
    expect(opened).toHaveLength(1);
    expect(opened[0].direct_to).toEqual([]);
    // DB row REUSES closed_answered (no enum widening) + outcome.source='archive'.
    const row = await stateRow(r.conversation_id, ws);
    expect(row.state).toBe('closed_answered');
    expect(row.closed_at).not.toBeNull();
    expect(row.wakes_used).toBe(0);
    expect(row.outcome).toMatchObject({ source: 'archive', source_conversation_id: 'arch-src-1' });
    expect(row.has_query_embedding).toBe(true);
    expect(row.query_embedding_mode).toBe('gemma');
    expect(row.query_embedding_profile).toBe(EMBEDDER_DIM_SPECS.gemma.profileId);

    // WI-1713046 — the row must not misreport ITSELF, independently of whether
    // the answer it served was the right one.
    //
    // NO RESPONDER. `wakes_used: 0` above is the other half of this assertion:
    // together they say nobody was woken AND nobody is named, which is the only
    // self-consistent pair. Copying the source consult's responder here (what
    // this used to do) asserted that 'resp-arch' answered THIS consult when
    // they were never woken and never saw the question — and it is the
    // top-level column that is indexed (consult_state_responder_idx) and that
    // queries read.
    expect(row.responder_id).toBeNull();
    // The provenance is not lost — it lives one field away, correctly labelled
    // as the SOURCE consult's responder rather than this row's.
    expect(row.outcome).toMatchObject({ source_responder_id: 'resp-arch' });
    // …and the caller was already being told the truth; only the column lied.
    expect(r.responder).toBeNull();

    // NOT CLOSED BEFORE IT OPENED. `closed_at` used to come from a JS clock
    // read before the embed + route + vector search (~1.9s), while created_at
    // takes the column default at INSERT — so every archive row was stamped
    // closed before it existed. Same clock now, so this cannot invert.
    expect(new Date(row.closed_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(row.created_at as string).getTime(),
    );
  });

  it('rejects an exact foreign profile even when mode and dimensions look compatible', async () => {
    const ws = 'ws-arch-profile-mismatch';
    await seedClosedConsult({
      ws,
      conv: 'arch-foreign-profile',
      vec: vecAt(0),
      mode: 'gemma',
      profile: EMBEDDER_DIM_SPECS.openai.profileId,
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('accepts a legacy NULL profile only through that mode current declared profile', async () => {
    const ws = 'ws-arch-legacy-current-profile';
    await seedClosedConsult({
      ws,
      conv: 'arch-legacy-gemma',
      vec: vecAt(0),
      mode: 'gemma',
      profile: null,
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));
    expect(r.verdict).toBe('served_from_archive');
    expect(r.archive?.source_conversation_id).toBe('arch-legacy-gemma');
    expect(reached).toHaveLength(0);
  });

  it('fails closed when a vector arrives without exact query provenance', async () => {
    const ws = 'ws-arch-query-profile-missing';
    await seedClosedConsult({ ws, conv: 'arch-would-match', vec: vecAt(0) });
    const route = routeOf([cand('cand-live')], {
      queryVec: qv,
      queryProfile: null,
      queryMode: null,
    });
    const { deps, reached } = makeDeps(route);
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
    expect((await stateRow(r.conversation_id, ws)).has_query_embedding).toBe(false);
  });

  it('CONTROL: the self-description assertions are FALSIFIABLE — the pre-fix row shape is caught', async () => {
    // WI-1713046. The two assertions above are NEGATIVES about a row the
    // product wrote, and a negative is satisfiable by an instrument that
    // cannot see the field at all — `stateRow` selecting `*` today is no
    // guarantee it will tomorrow, and `null` vs `undefined` vs a missing
    // column all read the same through `toBeNull()`. So keep the exact row the
    // archive serve USED to write, permanently, and prove both predicates flip.
    //
    // Written straight through rootSql on purpose: this must not be reachable
    // from the product path (that is the whole point of the fix), and mutating
    // the shared tree to re-create it would be committed by the git-sync sweep.
    const ws = 'ws-arch-prefix-control';
    const conv = 'arch-prefix-1';
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         routing, outcome, closed_at, wakes_used)
      VALUES
        (${ws}, ${conv}, 'req-1', 'resp-arch', 'closed_answered', 'q',
         '{}'::jsonb,
         ${rootSql.json({ source: 'archive', source_responder_id: 'resp-arch' } as never)},
         now() - interval '1.9 seconds', 0)
    `;
    const bad = await stateRow(conv, ws);

    // 1. Phantom responder: named, yet never woken. The pair is the defect —
    //    either alone is legitimate elsewhere in the table.
    expect(bad.responder_id).not.toBeNull();
    expect(bad.wakes_used).toBe(0);

    // 2. Closed before created. If the clock comparison above were inverted or
    //    reading an absent column, this would pass too — it must not.
    expect(new Date(bad.closed_at as string).getTime()).toBeLessThan(
      new Date(bad.created_at as string).getTime(),
    );

    // Calibration: the instrument is not simply always-reporting-bad. The
    // fixed shape must read clean through the SAME helper and comparison.
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         routing, outcome, closed_at, wakes_used)
      VALUES
        (${ws}, 'arch-postfix-1', 'req-1', NULL, 'closed_answered', 'q',
         '{}'::jsonb,
         ${rootSql.json({ source: 'archive', source_responder_id: 'resp-arch' } as never)},
         now(), 0)
    `;
    const good = await stateRow('arch-postfix-1', ws);
    expect(good.responder_id).toBeNull();
    expect(new Date(good.closed_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(good.created_at as string).getTime(),
    );
  });

  it('does not archive-serve a rubric critique answered by an owner who already graded that rubric', async () => {
    const ws = 'ws-arch-rubric-role-conflict';
    const rubricRef = 'acceptance-archive-role-conflict-2026-08-25';
    const grader = 'agent-archived-grader';
    const question =
      `Critique rubric ${rubricRef}: are its criteria independent, falsifiable, and complete?`;
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, workspace_id, status, payload)
      VALUES ('EI-ARCHIVE-RUBRIC-GRADE', ${ws}, 'done', ${rootSql.json({
        _ei: { created_by: grader },
        observation: { rubricRef, ratings: { c1: { rating: 'healthy', evidence: 'prior grade' } } },
      })})`;
    await seedClosedConsult({
      ws,
      conv: 'arch-rubric-conflicted-answer',
      vec: vecAt(0),
      responder: grader,
      question,
      outcome: { answer: 'the rubric is fine', confidence: 'high' },
    });

    const independent = cand('agent-archive-independent');
    const { deps, reached, routeCalls } = makeDeps(
      routeOf([independent], { queryVec: qv }),
    );
    const result = asOk(
      await getFeedbackCore(
        { ...baseReq, workspaceId: ws, question },
        deps,
      ),
    );

    expect(routeCalls[0]?.excludeOwners).toEqual([grader]);
    expect(result.verdict).toBe('routed');
    expect(result.archive).toBeUndefined();
    expect(result.responder?.ownerId).toBe(independent.ownerId);
    expect(reached).toHaveLength(1);
  });

  it('does not reuse a high-similarity archive answer across incompatible named rubric/plan subjects', async () => {
    const ws = 'ws-arch-subject-fence';
    await seedClosedConsult({
      ws,
      conv: 'arch-wrong-subject',
      vec: vecAt(0),
      question:
        'Vet rubric goal-mode-design-intent-hardening-acceptance for plan goal-mode-design-intent-hardening-2026-08-16 against Decisions D-001..D-006.',
      outcome: { answer: 'criteria C1 C3 C4 from the unrelated plan', confidence: 'high' },
    });
    const { deps, reached } = makeDeps(
      routeOf([cand('cand-live')], { queryVec: qv }),
    );
    const r = asOk(
      await getFeedbackCore(
        {
          ...baseReq,
          workspaceId: ws,
          question:
            'Vet rubric goal-mode-design-intent-hardening-acceptance for plan goal-mode-design-intent-hardening-2026-08-16 against Decision D-010.',
        },
        deps,
      ),
    );

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('does not reuse the exact production archive answer for the SideStage rubric', async () => {
    const ws = 'ws-arch-production-subject-fence';
    const archivedQuestion =
      'Critique acceptance rubric acceptance-plan-completion-audit-verdict-2026-08-13 against meta-acceptance-rubric. Subject plan goal: make plan completion require per-item code-truth audit, incremental citation re-verification, a vetted post-implementation rubric, independent grading, and an explicit implementer accept/reject verdict. Proposed criteria cover: (1) per-item provenance/carry-forward/staleness; (2) code-truth ship refusals and scoped force; (3) current vetting → non-implementer grade → author verdict; (4) dropped-reason and forcedPast attribution; (5) default-on flags plus citation spot-check in all four plan classes. Each has a falsification drill and relevant bound Vitest files. Identify overlap, missing failure modes, untraceable scope, weak/irrelevant checks, or diff-restatement wording; recommend exact revisions.';
    const currentQuestion =
      'Please independently critique acceptance rubric acceptance-sidestage-web-pagespeed-exceptional-2026-08-21 against every criterion in meta-acceptance-rubric. Identify any outcome-vs-diff restatement, missing trace to the SideStage plan objective or D-001, unfalsifiable criterion, uncovered failure mode, overlap, or objectively checkable criterion that should carry a structured test/instrument binding. Name exact rubric keys and concrete proposed changes; an explicit no-change finding is acceptable only with criterion-by-criterion evidence.';
    await seedClosedConsult({
      ws,
      conv: 'conv-mt3hcpaf-0000-a4050c703a97449785c520397326810a',
      vec: vecAt(0),
      question: archivedQuestion,
      outcome: { answer: 'unrelated acceptance-plan critique', confidence: 'high' },
    });
    const { deps, reached } = makeDeps(
      routeOf([cand('cand-live')], { queryVec: qv }),
    );
    const r = asOk(
      await getFeedbackCore(
        { ...baseReq, workspaceId: ws, question: currentQuestion },
        deps,
      ),
    );

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('does not reuse a high-similarity archive across different untyped dated rubric subjects', async () => {
    const ws = 'ws-arch-untyped-dated-rubric-subject-fence';
    const archivedQuestion =
      'Vet acceptance-work-on-everything-stewardship-remediation-2026-08-30 rev2/hash7603e472917dfb0b90c2eb79d96c09a5a88e57c67ef2293611d1159ebc3bd101 against meta-acceptance-rubric: do its six legacy-backfilled outcome bars preserve existing R001..007/Acceptance1..6 and D011/12/13?';
    const currentQuestion =
      'Vet current acceptance-goal-brief-to-claimed-plan-work-2026-09-23 rev7 after additive R2 D032/D035/D039 coverage amendment. Does it now cover those known inverse semantic gaps without weakening organic live pickup or D042/D043? Read immutable6/7 and exact bound assertions, not title grep. Identify remaining meta-acceptance-rubric findings with rerunnable evidence; do not infer shipment from construction tests.';
    await seedClosedConsult({
      ws,
      conv: 'arch-wrong-untyped-rubric-subject',
      vec: vecAt(0),
      question: archivedQuestion,
      outcome: { answer: 'RATIFIED a different rubric revision', confidence: 'high' },
    });
    const { deps, reached } = makeDeps(
      routeOf([cand('cand-live')], { queryVec: qv }),
    );
    const r = asOk(
      await getFeedbackCore(
        {
          ...baseReq,
          workspaceId: ws,
          question: currentQuestion,
          policy: 'rubric-vetting',
        },
        deps,
      ),
    );

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it.each([
    ['changed revision', `rev7/hash${'a'.repeat(64)}`],
    ['changed criteria hash', `rev8/hash${'b'.repeat(64)}`],
    ['missing criteria hash', 'rev8'],
    ['missing revision and hash', ''],
  ])('does not reuse a same-subject archive with %s', async (label, archivedPins) => {
    const ws = `ws-arch-pins-${label.replaceAll(' ', '-')}`;
    const subject = 'acceptance-byoc-delivery-acceleration-2026-09-06';
    await seedClosedConsult({
      ws,
      conv: 'arch-stale-pins',
      vec: vecAt(0),
      question: `Vet ${subject} ${archivedPins} against meta-acceptance-rubric.`,
      outcome: { answer: 'An older or unpinned construction review', confidence: 'high' },
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({
      ...baseReq,
      workspaceId: ws,
      question: `Vet ${subject} revision8 criteriaHash${'a'.repeat(64)} against meta-acceptance-rubric.`,
      policy: 'rubric-vetting',
    }, deps));

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('reuses a same-subject archive with equivalent explicit revision and hash pins', async () => {
    const ws = 'ws-arch-current-pins';
    const subject = 'acceptance-byoc-delivery-acceleration-2026-09-06';
    const hash = 'a'.repeat(64);
    await seedClosedConsult({
      ws,
      conv: 'arch-current-pins',
      vec: vecAt(0),
      question: `Vet ${subject} rev8/hash${hash} against meta-acceptance-rubric.`,
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({
      ...baseReq,
      workspaceId: ws,
      question: `Vet ${subject} revision: 8 criteriaHash: ${hash.toUpperCase()} against meta-acceptance-rubric.`,
      policy: 'rubric-vetting',
    }, deps));

    expect(r.verdict).toBe('served_from_archive');
    expect(r.archive?.source_conversation_id).toBe('arch-current-pins');
    expect(reached).toHaveLength(0);
  });

  it('reuses a high-similarity archive answer when all named subjects match exactly', async () => {
    const ws = 'ws-arch-subject-match';
    await seedClosedConsult({
      ws,
      conv: 'arch-same-subject',
      vec: vecAt(0),
      question:
        'Vet rubric goal-mode-design-intent-hardening-acceptance for plan goal-mode-design-intent-hardening-2026-08-16.',
    });
    const { deps, reached } = makeDeps(
      routeOf([cand('cand-live')], { queryVec: qv }),
    );
    const r = asOk(
      await getFeedbackCore(
        {
          ...baseReq,
          workspaceId: ws,
          question:
            'Please review rubric goal-mode-design-intent-hardening-acceptance against plan goal-mode-design-intent-hardening-2026-08-16.',
        },
        deps,
      ),
    );

    expect(r.verdict).toBe('served_from_archive');
    expect(r.archive?.source_conversation_id).toBe('arch-same-subject');
    expect(reached).toHaveLength(0);
  });

  it('a dissimilar archive row does not serve — normal routing proceeds, and the new consult forward-fills query_embedding', async () => {
    const ws = 'ws-arch-dissimilar';
    await seedClosedConsult({ ws, conv: 'arch-orth', vec: vecAt(Math.PI / 2) }); // sim 0 vs qv
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1); // woken as usual
    // Forward-fill: the routed consult still stores its embedding, growing the archive.
    const row = await stateRow(r.conversation_id, ws);
    expect(row.state).toBe('awaiting_responder');
    expect(row.has_query_embedding).toBe(true);
  });

  it('archive-served copies are never re-served — only ORGANIC closes are sources (no copy-of-copy chains)', async () => {
    const ws = 'ws-arch-no-chain';
    // The ONLY archive row is itself archive-served (outcome.source='archive'),
    // at sim 1.0 — it must be excluded from candidacy.
    await seedClosedConsult({
      ws,
      conv: 'arch-copy',
      vec: vecAt(0),
      outcome: { source: 'archive', source_conversation_id: 'arch-src-0', answer: { answer: 'copied' } },
    });
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));

    expect(r.verdict).toBe('routed'); // NOT served_from_archive
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('falsifiability: archiveFloor 0 serves even a maximally-dissimilar archive row (the floor comparison is live)', async () => {
    const ws = 'ws-arch-floor-zero';
    await seedClosedConsult({ ws, conv: 'arch-far', vec: vecAt(Math.PI / 2) }); // sim 0
    const { deps } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws, archiveFloor: 0 }, deps));
    expect(r.verdict).toBe('served_from_archive');
    expect(r.archive?.source_conversation_id).toBe('arch-far');
  });

  it('falsifiability: an unreachable archiveFloor never serves even an identical question', async () => {
    const ws = 'ws-arch-floor-unreachable';
    await seedClosedConsult({ ws, conv: 'arch-same', vec: vecAt(0) }); // sim 1.0
    const { deps, reached } = makeDeps(routeOf([cand('cand-live')], { queryVec: qv }));
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws, archiveFloor: 2 }, deps));
    expect(r.verdict).toBe('routed');
    expect(r.archive).toBeUndefined();
    expect(reached).toHaveLength(1);
  });

  it('no queryVec (embed degrade): the archive leg is skipped and the insert stores no embedding', async () => {
    const ws = 'ws-arch-no-vec';
    await seedClosedConsult({ ws, conv: 'arch-unreachable', vec: vecAt(0) });
    const { deps } = makeDeps(routeOf([cand('cand-live')])); // queryVec: null (default)
    const r = asOk(await getFeedbackCore({ ...baseReq, workspaceId: ws }, deps));
    expect(r.verdict).toBe('routed');
    const row = await stateRow(r.conversation_id, ws);
    expect(row.has_query_embedding).toBe(false);
  });
});

// ── readVettingConsultCritique (EI-20821478338037350) ──────────────────────
//
// The rubric-vetting gate's predicate is SQL, and the emit-side unit suite
// mocks this function wholesale — so the authorship and kind exclusions that
// make it mean "critique happened" rather than "a row exists" are only ever
// exercised HERE, against the real migration-834 tables.
describe('readVettingConsultCritique — the vetting gate reads CRITIQUE, not existence', () => {
  const WSV = 'ws-vetting';
  const REQUESTER = 'su-rubric-author'; // opens the consult AND emits the attestation

  /** Seed one consult + its typed posts. Post rows are [author, kind] pairs. */
  async function seedConsult(
    conv: string,
    state: string,
    posts: [author: string | null, kind: string][],
    question = 'critique this rubric',
    routing: unknown = {},
  ) {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, state, question, routing)
      VALUES (${WSV}, ${conv}, ${REQUESTER}, ${state}, ${question}, ${rootSql.json(routing as never)})
    `;
    let postId = Math.floor(Math.random() * 1_000_000) * 100;
    for (const [author, kind] of posts) {
      await rootSql`
        INSERT INTO harness_shared.consult_post_meta
          (workspace_id, post_id, conversation_id, author_id, kind)
        VALUES (${WSV}, ${(postId += 1)}, ${conv}, ${author}, ${kind})
      `;
    }
  }

  it('a consult with no row at all is exists:false — a DANGLING link, distinct from an unanswered one', async () => {
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-nonexistent', REQUESTER);
    expect(v).toEqual({ exists: false, state: null, critiquePosts: 0, declinePosts: 0, critics: [] });
  });

  it('an opened-but-unanswered consult is exists:true with ZERO critique — the hole this closes', async () => {
    await seedConsult('conv-silent', 'awaiting_responder', []);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-silent', REQUESTER);
    expect(v).toMatchObject({ exists: true, state: 'awaiting_responder', critiquePosts: 0, critics: [] });
  });

  it('counts a third-party reply as critique and names its author', async () => {
    await seedConsult('conv-answered', 'active', [
      ['su-reviewer', 'answer'],
      ['su-reviewer', 'new_fact'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-answered', REQUESTER);
    expect(v).toMatchObject({ exists: true, critiquePosts: 2, declinePosts: 0, critics: ['su-reviewer'] });
  });

  it('binds relevance to the durable opening question', async () => {
    await seedConsult(
      'conv-question-relevant',
      'active',
      [['su-reviewer', 'answer']],
      'Critique acceptance-rubric-alpha against the meta rubric',
    );
    const questionMatch = await readVettingConsultCritique(
      rootSql,
      WSV,
      'conv-question-relevant',
      REQUESTER,
      ['acceptance-rubric-alpha', 'plan-alpha'],
    );
    expect(questionMatch.relevance).toEqual({
      matched: true,
      matchedRefs: ['acceptance-rubric-alpha'],
      via: ['question'],
    });
    await seedConsult(
      'conv-unrelated',
      'active',
      [['su-reviewer', 'answer']],
      'Review a queue scheduling design',
    );
    const unrelated = await readVettingConsultCritique(
      rootSql,
      WSV,
      'conv-unrelated',
      REQUESTER,
      ['acceptance-rubric-alpha', 'plan-alpha'],
    );
    expect(unrelated.relevance).toEqual({ matched: false, matchedRefs: [], via: [] });
  });

  it('EXCLUDES the requester’s own follow-ups — the ask is not the answer', async () => {
    await seedConsult('conv-self-only', 'awaiting_responder', [
      [REQUESTER, 'question'],
      [REQUESTER, 'new_fact'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-self-only', REQUESTER);
    expect(v.critiquePosts).toBe(0);
    expect(v.critics).toEqual([]);
  });

  it('EXCLUDES the EMITTER even when the emitter is not the requester — self-critique is not vetting', async () => {
    await seedConsult('conv-emitter-posts', 'active', [['su-emitter', 'answer']]);
    // Requester opened it; su-emitter is attesting, so su-emitter's own post cannot count.
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-emitter-posts', 'su-emitter');
    expect(v.critiquePosts).toBe(0);
    // CONTROL: the same row IS critique for a different emitter — proving the
    // exclusion is authorship-driven, not a predicate stuck at zero.
    const other = await readVettingConsultCritique(rootSql, WSV, 'conv-emitter-posts', REQUESTER);
    expect(other.critiquePosts).toBe(1);
    expect(other.critics).toEqual(['su-emitter']);
  });

  it('counts the stamped rubric-vetting answerer only when that identity authored a non-decline critique', async () => {
    const routing = {
      policy: 'rubric-vetting',
      selection: {
        selected: [{ ownerId: 'su-source-reviewer', answeringOwnerId: 'su-routed-reviewer' }],
      },
    };
    await seedConsult(
      'conv-routed-vetter',
      'active',
      [
        ['su-routed-reviewer', 'answer'],
        ['su-routed-reviewer', 'new_fact'],
      ],
      'Critique acceptance-rubric-alpha against the meta rubric',
      routing,
    );
    const routed = await readVettingConsultCritique(rootSql, WSV, 'conv-routed-vetter', 'su-routed-reviewer');
    expect(routed).toMatchObject({
      critiquePosts: 2,
      critics: ['su-routed-reviewer'],
      routedVettingCritic: 'su-routed-reviewer',
    });

    await seedConsult(
      'conv-unselected-vetter',
      'active',
      [['su-unselected-reviewer', 'answer']],
      'Critique acceptance-rubric-alpha against the meta rubric',
      routing,
    );
    const unselected = await readVettingConsultCritique(
      rootSql,
      WSV,
      'conv-unselected-vetter',
      'su-unselected-reviewer',
    );
    expect(unselected.critiquePosts).toBe(0);
    expect(unselected.critics).toEqual([]);
    expect(unselected).not.toHaveProperty('routedVettingCritic');

    await seedConsult(
      'conv-routed-vetter-decline',
      'active',
      [['su-routed-reviewer', 'decline']],
      'Critique acceptance-rubric-alpha against the meta rubric',
      routing,
    );
    const declined = await readVettingConsultCritique(
      rootSql,
      WSV,
      'conv-routed-vetter-decline',
      'su-routed-reviewer',
    );
    expect(declined).toMatchObject({ critiquePosts: 0, declinePosts: 1, critics: [] });
    expect(declined).not.toHaveProperty('routedVettingCritic');

    await seedConsult(
      'conv-other-policy-vetter',
      'active',
      [['su-routed-reviewer', 'answer']],
      'Critique acceptance-rubric-alpha against the meta rubric',
      { ...routing, policy: 'consult-default' },
    );
    const otherPolicy = await readVettingConsultCritique(
      rootSql,
      WSV,
      'conv-other-policy-vetter',
      'su-routed-reviewer',
    );
    expect(otherPolicy.critiquePosts).toBe(0);
    expect(otherPolicy).not.toHaveProperty('routedVettingCritic');
  });

  it('a DECLINE is not critique — counted separately so the refusal can say "re-route", not "wait"', async () => {
    await seedConsult('conv-declined', 'declined', [
      ['su-a', 'decline'],
      ['su-b', 'decline'],
    ]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-declined', REQUESTER);
    expect(v).toMatchObject({ critiquePosts: 0, declinePosts: 2, critics: [] });
  });

  it('a NULL author cannot evidence external critique', async () => {
    await seedConsult('conv-null-author', 'active', [[null, 'answer']]);
    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-null-author', REQUESTER);
    expect(v.critiquePosts).toBe(0);
  });

  it('counts a structured answer on an archive-served wrapper as one critique from the source responder', async () => {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question, outcome)
      VALUES
        (
          ${WSV}, 'conv-archive-wrapper', ${REQUESTER}, 'su-reviewer', 'closed_answered',
          'critique this rubric',
          ${rootSql.json({
            source: 'archive',
            source_conversation_id: 'conv-archive-source',
            source_responder_id: 'su-reviewer',
            answer: { answer: 'The release evidence criterion still needs a live-pin check.', confidence: 0.9 },
          })}
        )
    `;

    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-archive-wrapper', REQUESTER);
    expect(v).toMatchObject({
      exists: true,
      state: 'closed_answered',
      critiquePosts: 1,
      declinePosts: 0,
      critics: ['su-reviewer'],
    });
  });

  it('does not treat archive provenance or confidence without answer text as critique', async () => {
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question, outcome)
      VALUES
        (
          ${WSV}, 'conv-archive-malformed', ${REQUESTER}, 'su-reviewer', 'closed_answered',
          'critique this rubric',
          ${rootSql.json({
            source: 'archive',
            source_conversation_id: 'conv-archive-source',
            source_responder_id: 'su-reviewer',
            answer: { confidence: 0.9 },
          })}
        )
    `;

    const v = await readVettingConsultCritique(rootSql, WSV, 'conv-archive-malformed', REQUESTER);
    expect(v).toMatchObject({ exists: true, critiquePosts: 0, declinePosts: 0, critics: [] });
  });

  it('is workspace-scoped — a same-named consult in another workspace is invisible', async () => {
    await seedConsult('conv-scoped', 'active', [['su-reviewer', 'answer']]);
    const v = await readVettingConsultCritique(rootSql, 'ws-other', 'conv-scoped', REQUESTER);
    expect(v.exists).toBe(false);
  });
});

// ── D-002 fork/convert dispatch, against real PG (replaces the WI-39852 ──────
//     revival leg: there is nothing to revive when delivery forks a transcript)
describe('getFeedbackCore — dispatch walk (D-002/D-004)', () => {
  /** makeDeps with a dispatch seam whose per-call verdict the test controls.
   *  `queued: 0` is the honest "every allowed model was exhausted for THIS
   *  expert" — the signal the cascade failover reads. */
  function makeDispatchDeps(route: RouteResult, queuedByCall: number[] = []) {
    const base = makeDeps(route);
    let call = 0;
    base.deps.reach = async (o) => {
      base.reached.push(o);
      const queued = queuedByCall[call++] ?? 1;
      const answeringOwnerId = queued > 0 ? `${o.responder}-fork` : null;
      if (answeringOwnerId) await o.onAnsweringOwner?.(answeringOwnerId);
      return { queued, woke: queued, pickupConfirmed: false, answeringOwnerId };
    };
    return base;
  }

  const deadExpert = cand('dead-x', { liveness: 'ended', score: 0.9 });
  const liveLow = cand('live-low', {
    score: 0.3,
    signals: { similarity: 0.2, verification: 0.3, authorship: 0, freshness: 1 },
  });

  it('a DEAD above-floor expert beats a live below-floor fill and is dispatched — liveness gates nothing (R-2)', async () => {
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert], { all: [deadExpert, liveLow] }));
    const res = asOk(await getFeedbackCore(baseReq, deps));
    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('dead-x');
    expect(res.responder_via).toBe('floor');
    // Delivered by dispatch, to the EXPERT as the transcript source.
    expect(reached).toHaveLength(1);
    expect(reached[0].responder).toBe('dead-x');
    // The brief the launched session boots on: the question in the summary line,
    // and the thread door in the body. The FULL question (plus tried/observed)
    // lives in the conversation's opening post, which is why the body's job is
    // to send it there rather than to restate it.
    expect(reached[0].summary).toContain(baseReq.question);
    expect(reached[0].body).toContain(`conversations:get { id: '${res.conversation_id}' }`);
    const row = await stateRow(res.conversation_id);
    expect(row.responder_id).toBe('dead-x');
    const sel = (row.routing as { selection?: { selected?: Array<Record<string, unknown>> } }).selection;
    // The fork's identity is persisted at the cursor — the participant key its
    // first consult:reply is gated on.
    expect(sel?.selected?.[0]).toMatchObject({
      ownerId: 'dead-x',
      via: 'floor',
      answeringOwnerId: 'dead-x-fork',
    });
    expect(sel?.selected?.[0]?.revived).toBeUndefined();
    // …and the LIVE below-floor candidate is not on the menu at all: the dead
    // above-floor expert already filled min:1, so no minimum fill fired. Being
    // alive bought it nothing — which is the R-2 claim stated as an absence.
    expect(sel?.selected).toHaveLength(1);
    expect(res.remaining_candidates).toEqual([]);
  });

  it('a parked expert is dispatched exactly like a live one — parked is not a selection signal either', async () => {
    const parkedTop = cand('parked-top', { liveness: 'parked', score: 0.9 });
    const { deps, reached } = makeDispatchDeps(routeOf([parkedTop], { all: [parkedTop, liveLow] }));

    const res = asOk(await getFeedbackCore(baseReq, deps));

    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('parked-top');
    expect(res.responder_via).toBe('floor');
    expect(reached.map((d) => d.responder)).toEqual(['parked-top']);
    const row = await stateRow(res.conversation_id);
    expect(row.responder_id).toBe('parked-top');
    const sel = (row.routing as { selection?: { selected?: Array<Record<string, unknown>> } }).selection;
    expect(sel?.selected?.[0]).toMatchObject({ ownerId: 'parked-top', via: 'floor', liveness: 'parked' });
  });

  it('the launched session may reply DURING dispatch: the early identity stamp makes its first turn a participant', async () => {
    let firstTurn: Awaited<ReturnType<typeof consultReplyCore>> | undefined;
    const { deps } = makeDispatchDeps(routeOf([deadExpert], { all: [deadExpert] }));
    deps.reach = async ({ conversationId, onAnsweringOwner }) => {
      // The real dispatcher announces the answering identity, then WAITS up to
      // 15s for host registration. The launched session can post inside that
      // window, and the reply gate refuses an author the row does not name.
      await onAnsweringOwner?.('dead-x-fork');
      firstTurn = await consultReplyCore(
        {
          workspaceId: WS,
          authorId: 'dead-x-fork',
          conversationId,
          kind: 'answer',
          body: 'the dispatched first-turn answer',
          evidence: [{ session_id: 'sess-dead-x', turn_idx: 3 }],
        },
        {
          getSql: () => rootSql,
          post: async (input) => ({
            post: {
              id: 91_001,
              thread_id: `thr-${input.conversation_id}`,
              author_id: 'dead-x-fork',
              body: input.body,
              created_ts: NOW.toISOString(),
            },
            author_origin: 'agent',
            delivered: 0,
          }),
          emitReplyEvent: async () => {},
          now: () => NOW,
        },
      );
      return { queued: 1, woke: 1, pickupConfirmed: false, answeringOwnerId: 'dead-x-fork' };
    };

    const res = asOk(await getFeedbackCore(baseReq, deps));

    // Without the early stamp this reads `{ error: 'not_a_participant' }` —
    // the launcher refusing the session it just launched.
    expect(firstTurn).toMatchObject({ ok: true, role: 'responder', state: 'active' });
    const row = await stateRow(res.conversation_id);
    expect(row.state).toBe('active');
    expect(row.responder_id).toBe('dead-x');
    const sel = (row.routing as { selection?: { selected?: Array<Record<string, unknown>> } }).selection;
    expect(sel?.selected?.[0]).toMatchObject({ ownerId: 'dead-x', answeringOwnerId: 'dead-x-fork' });
  });

  it('clears early answering-owner reservations when dispatch fails after the callback', async () => {
    const second = cand('expert-b', { score: 0.65 });
    const third = cand('expert-c', { score: 0.6 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second, third]));
    deps.reach = async (o) => {
      reached.push(o);
      const answeringOwnerId = o.responder + '-fork';
      // The identity is stamped before launch; a failed dispatch must not make
      // this reservation look like a session that can answer.
      await o.onAnsweringOwner?.(answeringOwnerId);
      if (o.responder !== 'expert-c') {
        return { queued: 0, woke: 0, pickupConfirmed: false, answeringOwnerId: null };
      }
      return { queued: 1, woke: 1, pickupConfirmed: false, answeringOwnerId };
    };

    const res = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 3 }, deps));

    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'expert-b', 'expert-c']);
    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('expert-c');
    const row = await stateRow(res.conversation_id);
    expect(row).toMatchObject({ state: 'awaiting_responder', responder_id: 'expert-c', cascade_cursor: 2 });
    const selected = (row.routing as { selection: { selected: Array<Record<string, unknown>> } }).selection.selected;
    expect(selected[0]?.answeringOwnerId).toBeUndefined();
    expect(selected[1]?.answeringOwnerId).toBeUndefined();
    expect(selected[2]?.answeringOwnerId).toBe('expert-c-fork');
    expect(row.cascade_digest).toMatchObject([
      { ownerId: 'dead-x', kind: 'dispatch_failed' },
      { ownerId: 'expert-b', kind: 'dispatch_failed' },
    ]);
  });

  it('stops initial source failover and refill when the native target has no capacity', async () => {
    const second = cand('capacity-second', { score: 0.65 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second], { all: [deadExpert, second, liveLow] }));
    deps.reach = async opts => {
      reached.push(opts);
      return { queued: 0, woke: 0, answeringOwnerId: null,
        targetCapacityUnavailable: 'native target claude capacity unavailable: all accounts walled' };
    };
    const result = asOk(await getFeedbackCore({ ...baseReq, minResponders: 2, maxResponders: 2 }, deps));
    expect(reached.map(entry => entry.responder)).toEqual(['dead-x']);
    expect(result.verdict).toBe('no_launchable_responder');
    expect(await stateRow(result.conversation_id)).toMatchObject({
      state: 'no_launchable_responder', responder_id: null, cascade_cursor: 0, expires_at: null,
    });
  });

  it('stops a later source failure walk before its next candidate or refill when target capacity is unavailable', async () => {
    const second = cand('capacity-second', { score: 0.65 });
    const third = cand('capacity-third', { score: 0.6 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second, third], { all: [deadExpert, second, third, liveLow] }));
    deps.reach = async opts => {
      reached.push(opts);
      return { queued: 0, woke: 0, answeringOwnerId: null,
        ...(opts.responder === 'capacity-second' ? { targetCapacityUnavailable: 'native target codex capacity unavailable' } : {}) };
    };
    const result = asOk(await getFeedbackCore({ ...baseReq, minResponders: 3, maxResponders: 3 }, deps));
    expect(reached.map(entry => entry.responder)).toEqual(['dead-x', 'capacity-second']);
    expect(result.verdict).toBe('no_launchable_responder');
    const row = await stateRow(result.conversation_id);
    expect(row.cascade_cursor).toBe(1);
    expect(row.routing).toMatchObject({ targetCapacityUnavailable: 'native target codex capacity unavailable' });
  });

  it('an expert whose whole allowlist is exhausted fails over to the next selectee, digesting dispatch_failed', async () => {
    // Two QUALIFIED experts, so the menu has a second seat to fail over into.
    // Call 1 (the head) launches nobody; call 2 (the failover) launches.
    const second = cand('expert-b', { score: 0.65 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second]), [0, 1]);
    const res = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 2 }, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'expert-b']);
    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('expert-b');
    const row = await stateRow(res.conversation_id);
    expect(row.responder_id).toBe('expert-b');
    expect(row.cascade_cursor).toBe(1);
    const digest = typeof row.cascade_digest === 'string' ? JSON.parse(row.cascade_digest) : row.cascade_digest;
    // The reason is named on the row, not inferred from an empty advance.
    expect(digest).toEqual([expect.objectContaining({ ownerId: 'dead-x', kind: 'dispatch_failed' })]);
    const sel = (row.routing as { selection?: { selected?: Array<Record<string, unknown>> } }).selection;
    expect(sel?.selected?.[1]).toMatchObject({ ownerId: 'expert-b', answeringOwnerId: 'expert-b-fork' });
    // The head that launched nobody carries NO answering identity.
    expect(sel?.selected?.[0]?.answeringOwnerId).toBeUndefined();
  });

  it('EI-24351703367365896: skipping multiple refused launches stamps only the expert that actually launched', async () => {
    const second = cand('expert-b', { score: 0.65 });
    const third = cand('expert-c', { score: 0.6 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second, third]), [0, 0, 1]);
    const res = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 3 }, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'expert-b', 'expert-c']);
    expect(res.responder?.ownerId).toBe('expert-c');
    const row = await stateRow(res.conversation_id);
    expect(row).toMatchObject({ responder_id: 'expert-c', cascade_cursor: 2 });
    const selected = (row.routing as { selection: { selected: Array<Record<string, unknown>> } }).selection.selected;
    expect(selected[0].answeringOwnerId).toBeUndefined();
    expect(selected[1].answeringOwnerId).toBeUndefined();
    expect(selected[2].answeringOwnerId).toBe('expert-c-fork');
    expect(row.cascade_digest).toMatchObject([
      { ownerId: 'dead-x', kind: 'dispatch_failed' }, { ownerId: 'expert-b', kind: 'dispatch_failed' },
    ]);
  });

  it('EI-24351703367365896: creation reports a launched refill expert outside its initial menu', async () => {
    const second = cand('expert-b', { score: 0.65 });
    const { deps, reached } = makeDispatchDeps(
      routeOf([deadExpert, second], { all: [deadExpert, second, liveLow] }), [0, 0, 1],
    );
    const res = asOk(await getFeedbackCore({ ...baseReq, minResponders: 2, maxResponders: 2 }, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'expert-b', 'live-low']);
    expect(res.responder?.ownerId).toBe('live-low');
    expect(res.responder_via).toBe('minimum');
    expect(await stateRow(res.conversation_id)).toMatchObject({ responder_id: 'live-low', cascade_cursor: 2 });
  });

  it('EI-24351703367365896: creation preserves a concurrent winner after a refused failover', async () => {
    const second = cand('expert-b', { score: 0.65 });
    const third = cand('expert-c', { score: 0.6 });
    const { deps } = makeDispatchDeps(routeOf([deadExpert, second, third]));
    const reached: string[] = [];
    deps.reach = async (o) => {
      reached.push(o.responder);
      if (o.responder === 'expert-b') {
        await rootSql`UPDATE harness_shared.consult_state
          SET cascade_cursor = 2, responder_id = 'expert-c'
          WHERE workspace_id = ${WS} AND conversation_id = ${o.conversationId}`;
      }
      return { queued: 0, woke: 0, pickupConfirmed: false };
    };
    const res = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 3 }, deps));
    expect(reached).toEqual(['dead-x', 'expert-b']);
    expect(res.responder?.ownerId).toBe('expert-c');
    expect(res.reason).not.toBe('no_available_responder');
    expect(await stateRow(res.conversation_id)).toMatchObject({
      state: 'awaiting_responder', responder_id: 'expert-c', cascade_cursor: 2, closed_at: null,
    });
  });

  it('every selectee exhausted — the honest terminal is no_launchable_responder, settled NOW rather than left to expiry', async () => {
    const second = cand('expert-b', { score: 0.65 });
    const { deps, reached } = makeDispatchDeps(routeOf([deadExpert, second]), [0, 0]);
    const res = asOk(await getFeedbackCore({ ...baseReq, maxResponders: 2 }, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'expert-b']);
    // No session was launched, so no responder is named and nothing is coming.
    // Experts WERE selected, so this is a dispatch failure, stored apart from
    // the measured absence `no_qualified_responder` (consult-backed-parking R-2).
    expect(res.verdict).toBe('no_launchable_responder');
    expect(res.state).toBe('no_launchable_responder');
    expect(res.reason).toBe('no_available_responder');
    expect(res.responder).toBeNull();
    expect(res.expires_at).toBeNull();
    expect(res.park_key).toBeNull();
    expect(res.hint).toContain('Nothing is coming, so do not park');
    const row = await stateRow(res.conversation_id);
    expect(row.state).toBe('no_launchable_responder');
    expect(row.responder_id).toBeNull();
    expect(row.expires_at).toBeNull();
    // The retrieval fallback survives: the refs are still the caller's next move.
    expect(res.remaining_candidates.length).toBeGreaterThan(0);
  });

  it('an ALL-DEAD pool routes normally — `no_live_responder` is gone, because liveness no longer keeps anyone out', async () => {
    const { deps } = makeDispatchDeps(routeOf([deadExpert], { all: [deadExpert] }));
    const res = asOk(await getFeedbackCore(baseReq, deps));
    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('dead-x');
    expect(res.reason).toBeUndefined();
    expect(res.state).toBe('awaiting_responder');
    expect(res.expires_at).not.toBeNull();
  });

  it('a single-selectee menu whose dispatch launches nobody is no_available_responder, not a silent awaiting row', async () => {
    const onlyOne = cand('sole-expert');
    const { deps, reached } = makeDispatchDeps(routeOf([onlyOne]), [0]);
    const res = asOk(await getFeedbackCore(baseReq, deps));
    expect(reached.map((d) => d.responder)).toEqual(['sole-expert']);
    expect(res.verdict).toBe('no_launchable_responder');
    expect(res.reason).toBe('no_available_responder');
    expect(res.responder).toBeNull();
    expect(res.wake).toEqual({ attempted: true, queued: 0, woke: 0, pickupConfirmed: false });
    const row = await stateRow(res.conversation_id);
    expect(row.state).toBe('no_launchable_responder');
  });

  it('WI-6554700010008590: a single-seat menu refused pre-launch refills from the untried pool instead of ending no_available_responder', async () => {
    // The live incident: the menu seated ONE floor-qualified expert whose transcript
    // was not archived, while the routing pool held further unseated candidates.
    // The creation-leg failover used to require >1 SEATED expert, so the untried
    // pool was never consulted and the consult ended no_qualified_responder.
    const { deps, reached } = makeDispatchDeps(
      routeOf([deadExpert], { all: [deadExpert, liveLow] }),
      [0, 1],
    );
    const res = asOk(await getFeedbackCore(baseReq, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x', 'live-low']);
    expect(res.verdict).toBe('routed');
    expect(res.responder?.ownerId).toBe('live-low');
    const row = await stateRow(res.conversation_id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('live-low');
    const digest = typeof row.cascade_digest === 'string' ? JSON.parse(row.cascade_digest) : row.cascade_digest;
    expect(digest).toEqual([expect.objectContaining({ ownerId: 'dead-x', kind: 'dispatch_failed' })]);
    const sel = (row.routing as { selection?: { selected?: Array<Record<string, unknown>>; refill?: unknown } }).selection;
    expect(sel?.selected?.map((s) => s.ownerId)).toEqual(['dead-x', 'live-low']);
    expect(sel?.refill).toBeTruthy();
  });

  it('WI-6554700010008590: an untried pool does not refill a min-0 consult', async () => {
    const { deps, reached } = makeDispatchDeps(
      routeOf([deadExpert], { all: [deadExpert, liveLow] }),
      [0, 1],
    );
    const res = asOk(await getFeedbackCore({ ...baseReq, minResponders: 0 }, deps));
    expect(reached.map((d) => d.responder)).toEqual(['dead-x']);
    expect(res.verdict).toBe('no_launchable_responder');
    expect(res.reason).toBe('no_available_responder');
  });

  it('dispatch-failed: advances to the next selected responder', async () => {
    const first = cand('zombie-first');
    const second = cand('live-second', { score: 0.65 });
    const base = makeDeps(routeOf([first, second]));
    let reachCount = 0;
    base.deps.reach = async (o) => {
      base.reached.push(o);
      reachCount += 1;
      return reachCount === 1
        ? { queued: 0, woke: 0, pickupConfirmed: false }
        : { queued: 1, woke: 1, pickupConfirmed: false };
    };

    const res = asOk(await getFeedbackCore(baseReq, base.deps));

    expect(res.responder?.ownerId).toBe('live-second');
    expect(res.responder_via).toBe('floor');
    expect(res.wake).toEqual({ attempted: true, queued: 1, woke: 0, pickupConfirmed: false });
    expect(base.reached.map((d) => d.responder)).toEqual(['zombie-first', 'live-second']);

    const row = await stateRow(res.conversation_id);
    expect(row.responder_id).toBe('live-second');
    expect(row.cascade_cursor).toBe(1);
    const digest = typeof row.cascade_digest === 'string' ? JSON.parse(row.cascade_digest) : row.cascade_digest;
    expect(digest).toEqual([
      expect.objectContaining({ ownerId: 'zombie-first', kind: 'dispatch_failed' }),
    ]);
  });
});

// ── peersKnowLookup (consult-revival-and-honest-min-2026-08-18 P-006) ────────
//
// The orient peers-know fold's read-only archive lookup. Only a real-PG test
// can prove the corpus predicate (closed_answered + non-archive-source +
// embedding present) and the pgvector ranking against real rows — the same
// reason the archive-first serve above is tested here.
describe('peersKnowLookup — the orient peers-know fold reads the settled archive, read-only', () => {
  const fakeEmbed = (vec: number[]) => async (_text: string) => vec;
  const query = (
    vec: number[],
    profile: ProseProfileSelection = GEMMA_QUERY_PROFILE,
  ) => ({ embed: fakeEmbed(vec), profile });

  it('an above-floor closed_answered row surfaces: one-liner answer + provenance + sim; nothing is written', async () => {
    const ws = 'ws-pk-hit';
    await seedClosedConsult({
      ws,
      conv: 'pk-src-1',
      vec: vecAt(0),
      responder: 'resp-expert',
      outcome: { answer: '  bump   hnsw.ef_search\n(the scan stops early otherwise)  ', confidence: 'high' },
    });
    const before = await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state WHERE workspace_id = ${ws}`;
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: ws,
      intent: 'why does my hnsw vector scan under-return rows?',
    });
    expect(hit).not.toBeNull();
    expect(hit!.ref).toBe('pk-src-1');
    expect(hit!.responder).toBe('resp-expert');
    expect(hit!.sim).toBeGreaterThanOrEqual(0.99);
    expect(hit!.closedAt).toBe(NOW.toISOString());
    // Whitespace collapsed into a ONE-liner.
    expect(hit!.answer).toBe('bump hnsw.ef_search (the scan stops early otherwise)');
    // READ-ONLY: no row was opened/inserted (the serve leg would have added one).
    const after = await rootSql`SELECT count(*)::int AS n FROM harness_shared.consult_state WHERE workspace_id = ${ws}`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('a below-floor (dissimilar) row is a null — precision-biased, no noise hit', async () => {
    const ws = 'ws-pk-miss';
    await seedClosedConsult({ ws, conv: 'pk-orth', vec: vecAt(Math.PI / 2) }); // sim 0
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: ws,
      intent: 'a question about something entirely unrelated',
    });
    expect(hit).toBeNull();
  });

  it('archive-served COPIES are excluded — never surfaces a copy-of-a-copy', async () => {
    const ws = 'ws-pk-archcopy';
    await seedClosedConsult({
      ws,
      conv: 'pk-copy',
      vec: vecAt(0),
      outcome: { source: 'archive', answer: 'copied answer' },
    });
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: ws,
      intent: 'the same question the archive copy carries',
    });
    expect(hit).toBeNull();
  });

  it('an outcome with no string answer is a null — a garbled hit is worse than none', async () => {
    const ws = 'ws-pk-noanswer';
    await seedClosedConsult({ ws, conv: 'pk-bare', vec: vecAt(0), outcome: { confidence: 'high' } });
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: ws,
      intent: 'a question whose settled row lost its answer text',
    });
    expect(hit).toBeNull();
  });

  it('degrades to null with no embedder and for a too-short intent — never throws', async () => {
    const ws = 'ws-pk-degrade';
    await seedClosedConsult({ ws, conv: 'pk-deg', vec: vecAt(0) });
    expect(await peersKnowLookup(rootSql, null, { workspaceId: ws, intent: 'long enough intent text here' })).toBeNull();
    expect(await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: 'short' })).toBeNull();
    // An embedder that rejects degrades too (the .catch leg).
    const throwingEmbed = async (_text: string): Promise<number[]> => {
      throw new Error('embed backend down');
    };
    expect(
      await peersKnowLookup(rootSql, { embed: throwingEmbed, profile: GEMMA_QUERY_PROFILE }, { workspaceId: ws, intent: 'long enough intent text here' }),
    ).toBeNull();
  });

  it('uses the same exact-profile and legacy-current compatibility rule as archive serving', async () => {
    const mismatchWs = 'ws-pk-profile-mismatch';
    await seedClosedConsult({
      ws: mismatchWs,
      conv: 'pk-foreign-profile',
      vec: vecAt(0),
      mode: 'gemma',
      profile: EMBEDDER_DIM_SPECS.openai.profileId,
    });
    expect(await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: mismatchWs,
      intent: 'profile identity must match this settled answer',
    })).toBeNull();

    const legacyWs = 'ws-pk-legacy-current';
    await seedClosedConsult({
      ws: legacyWs,
      conv: 'pk-legacy-current',
      vec: vecAt(0),
      mode: 'gemma',
      profile: null,
    });
    expect((await peersKnowLookup(rootSql, query(vecAt(0)), {
      workspaceId: legacyWs,
      intent: 'legacy mode maps only to its current profile',
    }))?.ref).toBe('pk-legacy-current');
  });
});

// ── peersKnowLookup retrieve mode (generic-rag-chunking-2026-09-29 P-012, D-027) ──
//
// A settled question longer than the 2,000-character embedding window has a parent
// vector over its head only. P-012 stores window chunks for the rest, and
// peersKnowLookup ranks each question by the nearer of its parent vector and its
// chunks (a chunk less the surface's chunk margin). Every long question below keeps
// its parent vector far from the intent (θ = 1.2, cos 0.36, under the archive
// floor), so a hit can only arrive through a chunk.
describe('peersKnowLookup retrieve mode — an intent matching only the tail of a long settled question', () => {
  const CUT = 2000;
  const FAR = 1.2;
  const MARGIN = CONSULT_QUESTIONS_CHUNK_SURFACE.chunkMargin ?? 0;
  const TAIL = 'Pin hnsw.iterative_scan to relaxed_order before a filtered vector query, or the index returns too few rows.';
  const HEAD = 'The consult cascade walks the ranked responders in order and records each decline. '.repeat(30).slice(0, CUT);
  const LONG_QUESTION = `${HEAD}\n${TAIL}`;
  const INTENT = 'filtered hnsw vector query returns too few rows';
  const query = (vec: number[]) => ({ embed: async (_text: string) => vec, profile: GEMMA_QUERY_PROFILE });

  async function seedQuestionChunk(opts: {
    ws: string;
    conv: string;
    idx: number;
    content: string;
    vec: number[];
    profile?: string;
  }): Promise<void> {
    await rootSql`
      INSERT INTO harness_shared.text_chunks
        (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version,
         embedding, embedding_mode, embedding_profile)
      VALUES (${CONSULT_QUESTIONS_CHUNK_SURFACE.surface}, ${[opts.ws, opts.conv]}::text[], ${opts.idx},
              ${opts.content}, 'sha', ${`${opts.conv}-${opts.idx}`}, 'window-1500-250@v1',
              ${JSON.stringify(opts.vec)}::vector, 'gemma',
              ${opts.profile ?? EMBEDDER_DIM_SPECS.gemma.profileId})`;
  }

  /** A long settled question: parent vector and head chunk far, tail chunk at `tailTheta`. */
  async function seedLongQuestion(opts: {
    ws: string;
    conv: string;
    tailTheta: number;
    outcome?: Record<string, unknown>;
    state?: string;
    chunks?: boolean;
    chunkProfile?: string;
  }): Promise<void> {
    await seedClosedConsult({
      ws: opts.ws,
      conv: opts.conv,
      vec: vecAt(FAR),
      question: LONG_QUESTION,
      outcome: opts.outcome,
      state: opts.state,
    });
    if (opts.chunks === false) return;
    await seedTailChunks(opts.ws, opts.conv, opts.tailTheta, opts.chunkProfile);
  }

  async function seedTailChunks(ws: string, conv: string, tailTheta: number, profile?: string): Promise<void> {
    await seedQuestionChunk({ ws, conv, idx: 0, content: LONG_QUESTION.slice(0, 1500), vec: vecAt(FAR + 0.05), profile });
    await seedQuestionChunk({ ws, conv, idx: 1, content: LONG_QUESTION.slice(1250), vec: vecAt(tailTheta), profile });
  }

  it('the fixture is valid: the shared text lies past the cut, the parent vector is under the floor, a near chunk is over it', () => {
    expect(LONG_QUESTION.indexOf(TAIL)).toBeGreaterThan(CUT);
    expect(LONG_QUESTION.slice(1250)).toContain(TAIL);
    expect(Math.cos(FAR)).toBeLessThan(DEFAULT_ARCHIVE_FLOOR);
    expect(MARGIN).toBeGreaterThan(0);
    expect(Math.cos(0.05) - MARGIN).toBeGreaterThanOrEqual(DEFAULT_ARCHIVE_FLOOR);
  });

  it('surfaces the long settled question through its tail chunk, over closer non-settled, archive-copy and other-workspace rows', async () => {
    const ws = 'ws-pk-tail';
    await seedLongQuestion({
      ws,
      conv: 'pk-long',
      tailTheta: 0.05,
      outcome: { answer: 'set hnsw.iterative_scan = relaxed_order', confidence: 'high' },
    });
    // Each competitor's tail chunk sits EXACTLY on the intent, nearer than pk-long's,
    // so only the corpus predicate can keep it out.
    await seedLongQuestion({ ws, conv: 'pk-long-copy', tailTheta: 0, outcome: { source: 'archive', answer: 'copied answer' } });
    await seedLongQuestion({ ws, conv: 'pk-long-active', tailTheta: 0, state: 'active' });
    await seedLongQuestion({ ws, conv: 'pk-long-cant-help', tailTheta: 0, state: 'closed_cant_help' });
    await seedLongQuestion({ ws: 'ws-pk-tail-elsewhere', conv: 'pk-long-elsewhere', tailTheta: 0 });

    const countRows = async () => {
      const [r] = await rootSql`
        SELECT (SELECT count(*)::int FROM harness_shared.consult_state) AS consults,
               (SELECT count(*)::int FROM harness_shared.text_chunks) AS chunks`;
      return r;
    };
    const before = await countRows();
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: INTENT });
    expect(hit).not.toBeNull();
    expect(hit!.ref).toBe('pk-long');
    expect(hit!.answer).toBe('set hnsw.iterative_scan = relaxed_order');
    // sim is 1 - the chunk's distance plus the margin, not the chunk's raw cosine.
    expect(hit!.sim).toBeCloseTo(Math.cos(0.05) - MARGIN, 5);
    // Read-only: neither the archive nor the chunk store was written.
    expect(await countRows()).toEqual(before);
  });

  it('ranks through the filtered slice (scan exact, generic-rag-chunking D-040), not a whole-surface chunk scan', async () => {
    const ws = 'ws-pk-tail-exact';
    await seedLongQuestion({ ws, conv: 'pk-long-exact', tailTheta: 0.05 });
    const opts = (rootSql as unknown as { options: { debug?: unknown } }).options;
    const prior = opts.debug;
    const seen: string[] = [];
    opts.debug = (_conn: unknown, text: string) => {
      if (text.includes('text_chunks')) seen.push(text);
    };
    try {
      const hit = await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: INTENT });
      expect(hit?.ref).toBe('pk-long-exact');
    } finally {
      opts.debug = prior;
    }
    expect(seen).toHaveLength(1);
    // The exact leg materialises the settled questions once and reaches their
    // chunks by key; the ANN leg would read consult_state a second time for the join.
    expect(seen[0]).toContain('chunk_leg_slice');
    expect(seen[0]).toMatch(/parent_key = ARRAY\[/);
  });

  it('control: the same row misses without its chunks and hits once they exist', async () => {
    const ws = 'ws-pk-tail-nochunk';
    await seedLongQuestion({ ws, conv: 'pk-long-bare', tailTheta: 0, chunks: false });
    expect(await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: INTENT })).toBeNull();

    await seedTailChunks(ws, 'pk-long-bare', 0);
    expect((await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: INTENT }))?.ref).toBe('pk-long-bare');
  });

  it('applies the chunk margin before the archive floor; a parent vector at the same angle is not penalised', async () => {
    // Cosine just over the floor, which the margin pushes under it.
    const theta = Math.acos(DEFAULT_ARCHIVE_FLOOR + MARGIN / 2);
    const chunkWs = 'ws-pk-tail-margin';
    await seedLongQuestion({ ws: chunkWs, conv: 'pk-long-margin', tailTheta: theta });
    expect(await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: chunkWs, intent: INTENT })).toBeNull();

    const parentWs = 'ws-pk-parent-margin';
    await seedClosedConsult({ ws: parentWs, conv: 'pk-short-margin', vec: vecAt(theta) });
    const hit = await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: parentWs, intent: INTENT });
    expect(hit?.ref).toBe('pk-short-margin');
    expect(hit!.sim).toBeCloseTo(DEFAULT_ARCHIVE_FLOOR + MARGIN / 2, 5);
  });

  it('does not read a chunk embedded under a different profile', async () => {
    const ws = 'ws-pk-tail-foreign';
    await seedLongQuestion({ ws, conv: 'pk-long-foreign', tailTheta: 0, chunkProfile: EMBEDDER_DIM_SPECS.openai.profileId });
    expect(await peersKnowLookup(rootSql, query(vecAt(0)), { workspaceId: ws, intent: INTENT })).toBeNull();
  });

  // generic-rag-chunking D-048: the surface holds only the population the reader
  // searches, so the ANN chunk leg's candidates are (nearly) all slice members.
  it('the consult surface chunks only settled questions and prunes one that leaves the set (D-048)', async () => {
    const ws = 'ws-pk-sync-d048';
    // A private surface name and workspace scope, so this sync neither selects nor
    // prunes another test's rows; the population predicate is the registry's own.
    const surface = {
      ...CONSULT_QUESTIONS_CHUNK_SURFACE,
      surface: 'consult_questions_d048_it',
      eligibleSql: `(${CONSULT_QUESTIONS_CHUNK_SURFACE.eligibleSql}) AND p.workspace_id = '${ws}'`,
    };
    await seedLongQuestion({ ws, conv: 'pk-sync-settled', tailTheta: 0, chunks: false });
    await seedLongQuestion({ ws, conv: 'pk-sync-copy', tailTheta: 0, chunks: false, outcome: { source: 'archive', answer: 'copied' } });
    await seedLongQuestion({ ws, conv: 'pk-sync-active', tailTheta: 0, chunks: false, state: 'active' });
    await seedLongQuestion({ ws, conv: 'pk-sync-cant-help', tailTheta: 0, chunks: false, state: 'closed_cant_help' });
    const chunked = async () =>
      (
        await rootSql<{ conv: string }[]>`
          SELECT DISTINCT parent_key[2] AS conv FROM harness_shared.text_chunks
           WHERE surface = ${surface.surface} ORDER BY 1`
      ).map((r) => r.conv);
    const logger = { warn: () => {}, error: () => {} };

    const first = await runChunkSyncTick({ sql: rootSql, surfaces: [surface], logger });
    expect(first).toHaveProperty('surfaces');
    expect(await chunked()).toEqual(['pk-sync-settled']);

    // Re-opened: it leaves the settled set, and the engine's own prune removes its chunks.
    await rootSql`
      UPDATE harness_shared.consult_state SET state = 'active'
       WHERE workspace_id = ${ws} AND conversation_id = 'pk-sync-settled'`;
    await runChunkSyncTick({ sql: rootSql, surfaces: [surface], logger });
    expect(await chunked()).toEqual([]);
  });
});
