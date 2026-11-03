import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { createImplementationReadiness, sealImplementationAcceptance, countWorkItemPresentationStages, intakeStageAdmitsClaim, implementationReadinessAdmitsClaim } from './harness/improvements/agent-review-policy';
import { getBuildInfo } from './build-info';
import { readProcessIdentity } from './process-identity';
import { reapStrandedAdmissionRuns } from './admission-runs-reaper';
import {
  DEFAULT_DEDUP_RESCREEN_CONCURRENCY,
  DEFAULT_DEDUP_RESCREEN_WALL_BUDGET_MS,
  rescreenDegradedPendingRows,
  type DedupRescreenRow,
  type DedupRescreenVerdict,
} from './work-items-admission-dedup-rescreen';
import { flushFallbackObservations, observeFallback } from './degradation/fallback-observations';
import { configureRuntimeVintageStore, InMemoryRuntimeVintageStore, reportRuntimeVintage, resetRuntimeVintageStore } from './runtime-vintage';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  scopePolicy: undefined as import('./work-scope-policy').WorkScopePolicy | null | undefined,
  // undefined ⇒ the real policy (none under VITEST). A test sets it to exercise the work-scope hold.
  scopeTerms: undefined as {
    exact: string[];
    likePrefixes: string[];
    exceptions?: {
      exactHarnesses: string[];
      harnessLikePrefixes: string[];
      plans: string[];
      goals: string[];
      workItems: string[];
    };
  } | null | undefined,
  scopeDecisions: [] as Array<{ harness?: string | null; verdict: string; note?: string }>,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Exercise the actual routine action against this file's disposable PG; registering it
// must not start the host's routine engine or announce fixtures to live agents.
vi.mock('./harness/routines/system-actions', async (orig) => ({
  ...await orig<typeof import('./harness/routines/system-actions')>(),
  registerSystemAction: vi.fn(),
}));
vi.mock('./work-items-events', () => ({ emitWorkItemClaimableEvent: vi.fn() }));
vi.mock('./work-scope-policy', async (orig) => {
  const actual = await orig<typeof import('./work-scope-policy')>();
  return {
    ...actual,
    isHarnessInScope: (slug: string | null | undefined) =>
      h.scopePolicy === undefined ? actual.isHarnessInScope(slug) : actual.isHarnessInScope(slug, h.scopePolicy),
    evaluateWorkScope: (subject: import('./work-scope-policy').WorkScopeSubject) =>
      h.scopePolicy === undefined ? actual.evaluateWorkScope(subject) : actual.evaluateWorkScope(subject, h.scopePolicy),
    workScopeSqlTerms: (...args: Parameters<typeof actual.workScopeSqlTerms>) =>
      h.scopeTerms === undefined ? actual.workScopeSqlTerms(...args) : h.scopeTerms,
    recordWorkScopeDecision: async (d: Parameters<typeof actual.recordWorkScopeDecision>[0]) => {
      if (h.scopeTerms === undefined) return actual.recordWorkScopeDecision(d);
      h.scopeDecisions.push({ harness: d.harness, verdict: d.verdict, note: d.note });
    },
  };
});

const {
  ADMISSION_REVIEW_MOOT_OUTCOME,
  admissionPairKey,
  applyReviewedAdmissionCleanup,
  closeMootAdmissionReviews,
  DEFAULT_FAIL_OPEN_BATCH_SIZE,
  judgedPairsMissingAdjudication,
  persistAdmissionPlan,
  previewReviewedAdmissionCleanup,
  readAdmissionMergeSnapshots,
  readPendingBatch,
  readWorkItemAdmissionSnapshot,
  readWorkItemAdmissionQueueHealth,
  readWorkItemAdmissionProducerPressure,
  readWorkItemReadinessProjection,
  readPromoterLiveness,
  readPromoterWindow,
  runWorkItemAdmissionFailOpen,
  runWorkItemAdmissionPromoter,
  WORK_ITEM_ADMISSION_PROMOTER,
} = await import('./work-items-admission-promoter');
const {
  WorkItemDependencyAdmissionError,
  repointWorkItemDependencyRefsInTransaction,
  withWorkItemDependencyAdmissionTransaction,
} = await import('./dbos/work-item-deps-store');

const WS = 'default';
const HARNESS = 'papercusp';
const NOW = Date.parse('2026-08-26T12:00:00Z');
let db: FreshPgDb;
let vintage: InMemoryRuntimeVintageStore;

const DDL = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, workspace_id text NOT NULL,
    actor text NOT NULL, action text NOT NULL, subject text NOT NULL, details jsonb
  );
  CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(value text)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT value = ANY(ARRAY['done','dropped','deprecated','passed','failed','resolved','closed']::text[])
  $$;
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text,
    item_kind text,
    parent_id text,
    taken_by text,
    -- Mirrors migration 1110's stored payload projections. The readiness
    -- reader consumes these physical booleans without repeatedly detoasting
    -- the polymorphic payload.
    claim_hold boolean GENERATED ALWAYS AS ((payload ->> '_claimHold') = 'true') STORED,
    needs_owner_action boolean GENERATED ALWAYS AS ((payload ->> 'needsOwnerAction') = 'true') STORED,
    admission text,
    admitted_at timestamptz,
    first_claimed_at timestamptz,
    admitted_by text,
    condition_key text,
    lane text,
    payload jsonb,
    agent_review_projection jsonb GENERATED ALWAYS AS (
      NULLIF(payload -> 'agentReview', 'null'::jsonb)
    ) STORED,
    implementation_readiness_projection jsonb GENERATED ALWAYS AS (
      NULLIF(payload -> 'implementationReadiness', 'null'::jsonb)
    ) STORED,
    implementation_readiness_enrolled boolean GENERATED ALWAYS AS (
      payload ? 'implementationReadiness'
    ) STORED,
    reopen_history_projection jsonb GENERATED ALWAYS AS (
      NULLIF(payload -> 'reopenHistory', 'null'::jsonb)
    ) STORED,
    external_blockers_projection jsonb GENERATED ALWAYS AS (
      NULLIF(payload -> 'externalBlockers', 'null'::jsonb)
    ) STORED,
    see_also text[],
    origin text NOT NULL DEFAULT 'local',
    -- WI-10006515: issueOwnAuthorWhereSql reads author_pubkey to tell an own-node row stranded
    -- at origin='remote' from a true peer row.
    author_pubkey text,
    completion_ref jsonb,
    terminal_completion_ref text,
    authority text,
    source_plan_slug text,
    goal_id text,
    source_plan_item_ids text[],
    created_ts bigint,
    updated_ts bigint,
    closed_ts bigint,
    expected_cost_cents bigint,
    terminal_reason text,
    terminal_owner text,
    embedding vector(3),
    embedding_mode text,
    embedding_profile text,
    -- migration 1534 (bug-inflow-one-problem-one-row-2026-10-18#D-001): the promoter
    -- stamps its merge verdict here (persistAdmissionDuplicateLink), alongside the
    -- coord_links 'duplicates' edge. Same CHECKs as production, so a bad write fails here.
    duplicate_of text,
    duplicate_source text,
    duplicate_confidence real,
    duplicate_evidence jsonb,
    CONSTRAINT work_items_duplicate_source_check CHECK (
      duplicate_source IS NULL
      OR duplicate_source IN ('create-match', 'admission-promoter', 'fold', 'agent')
    ),
    CONSTRAINT work_items_duplicate_of_not_self CHECK (duplicate_of IS NULL OR duplicate_of <> feature_id),
    CONSTRAINT work_items_duplicate_detail_check CHECK (
      (duplicate_confidence IS NULL OR (duplicate_of IS NOT NULL AND duplicate_confidence >= 0 AND duplicate_confidence <= 1))
      AND (duplicate_evidence IS NULL OR duplicate_of IS NOT NULL)
    ),
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  CREATE TABLE harness_shared.coord_links (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    src_kind text NOT NULL,
    src_ref text NOT NULL,
    dst_kind text NOT NULL,
    dst_ref text NOT NULL,
    rel text NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX coord_links_edge_uq
    ON harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel);
  CREATE TABLE harness_shared.work_item_deps (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    blocked_kind text NOT NULL,
    blocked_ref text NOT NULL,
    blocker_kind text NOT NULL,
    blocker_ref text NOT NULL,
    dep_type text NOT NULL DEFAULT 'blocks',
    satisfaction text NOT NULL DEFAULT 'settled',
    created_by text
  );
  CREATE UNIQUE INDEX work_item_deps_edge_uniq
    ON harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type);
  CREATE TABLE harness_shared.dedup_edges (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    cos real NOT NULL,
    trgm real,
    run_id text NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.dedup_adjudications (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    verdict text NOT NULL,
    canonical text,
    judged_by text NOT NULL,
    run_id text NOT NULL,
    judged_at timestamptz NOT NULL DEFAULT now(),
    evidence jsonb,
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.admission_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    run_kind text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    batch_size integer,
    promoted integer,
    merged integer,
    held integer,
    auto_promoted_unreviewed integer,
    census_before integer,
    census_after integer,
    model_id text,
    tokens_in bigint,
    tokens_out bigint,
    latency_ms integer,
    detail jsonb
  );
  CREATE TABLE harness_shared.work_item_occurrences (
    occurrence_id bigserial PRIMARY KEY,
    workspace_id text NOT NULL,
    canonical_harness_slug text NOT NULL,
    canonical_work_item_id text NOT NULL,
    reporter text,
    source_tool text NOT NULL,
    report_kind text NOT NULL,
    reported_title text NOT NULL,
    evidence jsonb,
    admission_identity jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE harness_shared.routines (
    id text PRIMARY KEY,
    install_slug text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (install_slug, name)
  );
`;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission-promoter');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
  // Promoter fallbacks are real buffered writes. createFreshPgDb provisions the
  // fallback_observations sink for every fixture (WI-6554700010013241); this file asserts the
  // column the promoter's correlated writes depend on is present.
  const [fallbackSchema] = await db.sql`SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'fallback_observations' AND column_name = 'correlation_id'`;
  expect(fallbackSchema?.data_type).toBe('uuid');
}, 60_000);

afterAll(async () => {
  await flushFallbackObservations();
  resetRuntimeVintageStore();
  await db?.cleanup();
});

beforeEach(async () => {
  await flushFallbackObservations();
  await db.sql`TRUNCATE harness_shared.audit_log, harness_shared.work_items, harness_shared.coord_links, harness_shared.work_item_deps, harness_shared.dedup_edges,
    harness_shared.dedup_adjudications, harness_shared.admission_runs,
    harness_shared.work_item_occurrences, harness_shared.routines, harness_shared.fallback_observations RESTART IDENTITY`;
  h.scopeTerms = undefined;
  h.scopePolicy = undefined;
  h.scopeDecisions.length = 0;
  vintage = new InMemoryRuntimeVintageStore();
  configureRuntimeVintageStore(vintage);
  await reportRuntimeVintage({
    workspaceId: WS, unit: 'fixture-producer', pid: process.pid,
    treeSha: 'a'.repeat(40), bundleVersion: 'runtime-fixture',
  });
});

it('renews request authorization after model work and before any admission mutation', async () => {
  await seedItem({ id: 'WI-auth-target' });
  await expect(runWorkItemAdmissionPromoter({
    workspaceId: WS, harnessSlug: HARNESS, sql: db.sql, runId: 'recovery-revoked',
    targetItemIds: ['WI-auth-target'],
    llmCall: vi.fn(async () => { throw new Error('no neighbour needs a model'); }),
    beforePersist: async () => { throw new Error('caller authorization revoked'); },
  })).rejects.toThrow('caller authorization revoked');
  const [row] = await db.sql`SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-auth-target'`;
  expect(row!.admission).toBe('pending');
});

async function seedItem(input: {
  id: string;
  title?: string;
  summary?: string;
  admission?: string | null;
  status?: string;
  createdAtMs?: number;
  vector?: string | null;
  embeddingProfile?: string | null;
  conditionKey?: string | null;
  /** Defaults to the run's own harness/workspace; set to seed a NEIGHBOUR the sweep may or may not reach. */
  harness?: string;
  workspaceId?: string;
  payload?: Record<string, unknown>;
  itemKind?: string;
  parentId?: string | null;
  takenBy?: string | null;
  firstClaimedAt?: string | null;
  expectedCostCents?: number | null;
  closedTs?: number | null;
  authority?: string | null;
  sourcePlanSlug?: string | null;
  goalId?: string | null;
  origin?: string;
  authorPubkey?: string | null;
}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, parent_id,
       taken_by, admission, admitted_at, first_claimed_at, condition_key, lane, payload,
       created_ts, updated_ts, closed_ts, authority, expected_cost_cents, origin, author_pubkey, source_plan_slug, goal_id,
       embedding, embedding_mode, embedding_profile)
    VALUES (${input.workspaceId ?? WS}, ${input.harness ?? HARNESS}, ${input.id},
            ${input.title ?? 'vitest clone failure'},
            ${input.summary ?? 'same finding and same retry remedy'}, ${input.status ?? 'open'}, ${input.itemKind ?? 'bug'},
            ${input.parentId ?? null}, ${input.takenBy ?? null},
            ${input.admission === undefined ? 'pending' : input.admission},
            ${input.admission === 'admitted' ? '2026-08-26T11:00:00Z' : null},
            ${input.firstClaimedAt ?? null}, ${input.conditionKey ?? null}, NULL,
            ${JSON.stringify(input.payload ?? {})}::text::jsonb,
            ${input.createdAtMs ?? NOW - 10_000}, ${input.createdAtMs ?? NOW - 10_000},
            ${input.closedTs ?? null}, ${input.authority ?? null}, ${input.expectedCostCents ?? null},
            ${input.origin ?? 'local'}, ${input.authorPubkey ?? null}, ${input.sourcePlanSlug ?? null}, ${input.goalId ?? null},
            ${input.vector === undefined ? '[1,0,0]' : input.vector}::vector,
            ${input.vector === null ? null : 'gemma'},
            ${input.vector === null ? null : (input.embeddingProfile ?? null)})`;
}

function judgementCall(verdict: 'r-finding-merge' | 'r-remedy-keep') {
  return vi.fn(async (input: { messages: Array<{ content: string }> }) => {
    const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    return {
      text: '',
      json: { judgements: keys.map((pairKey) => ({ pairKey, verdict, reason: 'fixture verdict' })) },
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0042,
    };
  });
}

describe('work-item admission promoter (real Postgres)', () => {
  it.each([false, true])('excludes typed source and direct child lineage in either screening direction (reverse=%s)', async (reverse) => {
    await seedItem({ id: 'WI-source-record', itemKind: 'ticket', admission: reverse ? 'pending' : null });
    await seedItem({ id: 'WI-report', admission: reverse ? 'admitted' : 'pending', payload: {
      admission: { sourceKind: 'record', sourceKey: 'WI-source-record' },
    } });
    await seedItem({ id: 'WI-reproduction-child', parentId: 'WI-report', admission: reverse ? 'pending' : 'auto' });
    await seedItem({ id: 'WI-independent', admission: 'admitted' });
    for (const target of reverse ? ['WI-source-record', 'WI-reproduction-child'] : ['WI-report']) {
      const window = await readPromoterWindow(db.sql, {
        workspaceId: WS, harnessSlug: HARNESS, batchSize: 1,
        targetItemIds: [target], recentTerminalDays: 30, nowMs: NOW,
      });
      expect(window.pairRows.some(pair => [pair.a.id, pair.b.id].includes('WI-report') &&
        [pair.a.id, pair.b.id].some(id => id === 'WI-source-record' || id === 'WI-reproduction-child'))).toBe(false);
      expect(window.pairRows.some(pair => [pair.a.id, pair.b.id].includes('WI-independent'))).toBe(true);
    }
  });

  it.each([HARNESS, 'papercusp/*'])('screens a harness admitted by the %s scope exception', async (exception) => {
    const harness = exception === HARNESS ? HARNESS : 'papercusp/drill';
    h.scopePolicy = {
      mode: 'enforce', allowHarnesses: ['home-only'],
      exceptions: [{ harness: exception, reason: 'Owner-authorized drill' }],
    };
    h.scopeTerms = { exact: ['home-only'], likePrefixes: [] };
    await seedItem({ id: 'WI-exception', harness, vector: null });
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: harness, runId: 'promoter-harness-exception',
      sql: db.sql, llmCall, now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 1, held: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    const [item] = await db.sql`SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-exception'`;
    expect(item.admission).toBe('admitted');
    const [run] = await db.sql`SELECT detail->>'status' AS status FROM harness_shared.admission_runs WHERE id = 'promoter-harness-exception'`;
    expect(run.status).toBe('complete');
  });

  it('keeps a neighbouring harness pending when its scope exception does not match', async () => {
    h.scopePolicy = {
      mode: 'enforce', allowHarnesses: ['home-only'],
      exceptions: [{ harness: 'papercusp/*', reason: 'Owner-authorized drill' }],
    };
    h.scopeTerms = { exact: ['home-only'], likePrefixes: [] };
    await seedItem({ id: 'WI-held-scope', harness: 'unrelated-app', vector: null });
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: 'unrelated-app', runId: 'promoter-unmatched-scope',
      sql: db.sql, llmCall, now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    const [item] = await db.sql`SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-held-scope'`;
    expect(item.admission).toBe('pending');
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs WHERE id = 'promoter-unmatched-scope'`).toEqual([]);
    expect(h.scopeDecisions).toContainEqual(expect.objectContaining({ harness: 'unrelated-app', verdict: 'held' }));
  });

  it.each([false, true])('records the queue selection witness before model work and preserves it on replay (targeted=%s)', async (targeted) => {
    await seedItem({ id: 'WI-selection-input' });
    await seedItem({ id: 'WI-selection-comparison', admission: 'admitted' });
    const selection = {
      schemaVersion: 1,
      runScope: targeted ? 'targeted' : 'scheduled',
      selectedItemIds: ['WI-selection-input'],
      comparisonItemIds: ['WI-selection-comparison'],
    };
    const model = judgementCall('r-remedy-keep');
    const llmCall = vi.fn(async (input: Parameters<typeof model>[0]) => {
      const [running] = await db.sql`
        SELECT detail FROM harness_shared.admission_runs WHERE id = 'selection-complete'`;
      expect(running.detail.status).toBe('running');
      expect(running.detail.queueSelection).toEqual(selection);
      return model(input);
    });
    const options = {
      workspaceId: WS, harnessSlug: HARNESS, runId: 'selection-complete', sql: db.sql,
      batchSize: 1, now: () => NOW,
      ...(targeted ? { targetItemIds: ['WI-selection-input'] } : {}),
    };
    await runWorkItemAdmissionPromoter({ ...options, llmCall });
    expect(llmCall).toHaveBeenCalledOnce();
    const [complete] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'selection-complete'`;
    expect(complete.detail.status).toBe('complete');
    expect(complete.detail.queueSelection).toEqual(selection);
    // Exact-target guards may retain the row. Explicitly empty the later input
    // so replay must preserve the original witness instead of replacing it with [].
    await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted'
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-selection-input'`;
    const replayModel = vi.fn(async () => { throw new Error('empty replay must not call the model'); });
    await runWorkItemAdmissionPromoter({ ...options, llmCall: replayModel });
    expect(replayModel).not.toHaveBeenCalled();
    const [replayed] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'selection-complete'`;
    expect(replayed.detail.queueSelection).toEqual(selection);
  });

  it('retains the queue selection witness when model work fails', async () => {
    await seedItem({ id: 'WI-selection-input' });
    await seedItem({ id: 'WI-selection-comparison', admission: 'admitted' });
    await expect(runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'selection-failed', sql: db.sql,
      batchSize: 1, targetItemIds: ['WI-selection-input'], now: () => NOW,
      llmCall: async () => { throw new Error('selection witness model failure'); },
    })).rejects.toThrow('selection witness model failure');
    const [failed] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'selection-failed'`;
    expect(failed.detail.status).toBe('failed');
    expect(failed.detail.queueSelection).toEqual({
      schemaVersion: 1, runScope: 'targeted',
      selectedItemIds: ['WI-selection-input'], comparisonItemIds: ['WI-selection-comparison'],
    });
  });

  it.each([false, true])('records an explicit empty queue selection witness (targeted=%s)', async (targeted) => {
    const llmCall = vi.fn();
    await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'selection-empty', sql: db.sql,
      now: () => NOW, llmCall, ...(targeted ? { targetItemIds: ['WI-selection-missing'] } : {}),
    });
    const [empty] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'selection-empty'`;
    expect(empty.detail.queueSelection).toEqual({
      schemaVersion: 1, runScope: targeted ? 'targeted' : 'scheduled',
      selectedItemIds: [], comparisonItemIds: [],
    });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('records the actual producing runtime process and preserves it during stranded recovery', async () => {
    const build = getBuildInfo();
    const identity = readProcessIdentity(process.pid);
    await reportRuntimeVintage({
      workspaceId: WS, unit: 'fixture-producer', pid: process.pid,
      treeSha: build.sha, bundleVersion: build.version,
    });
    await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-actual', sql: db.sql,
      llmCall: vi.fn(), now: () => NOW,
    });
    const [run] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-actual'`;
    expect(run.detail.producingRuntime).toMatchObject({
      host: hostname(), pid: process.pid, processIdentity: identity,
      buildSha: build.sha, version: build.version,
      buildIdentityStatus: build.sha ? 'matched-boot-record' : 'unknown',
    });
    if (process.platform === 'linux' || process.platform === 'darwin') expect(identity).toEqual(expect.any(String));
    // Simulate a producer dying with its original run-start detail still stored.
    await db.sql`
      UPDATE harness_shared.admission_runs
         SET started_at = to_timestamp(${NOW - 3 * 60 * 60_000} / 1000.0), finished_at = NULL,
             detail = jsonb_set(detail, '{status}', '"running"'::jsonb)
       WHERE id = 'runtime-actual'`;
    const reaped = await reapStrandedAdmissionRuns(db.sql, {
      workspaceId: WS, reaperRunId: 'runtime-reaper', nowMs: NOW,
    });
    expect(reaped.map(row => row.id)).toEqual(['runtime-actual']);
    const [recovered] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-actual'`;
    expect(recovered.detail.status).toBe('failed');
    expect(recovered.detail.producingRuntime).toEqual(run.detail.producingRuntime);
  });

  it('retains the producing runtime through completion and same-run replay', async () => {
    await seedItem({ id: 'WI-runtime-a' });
    await seedItem({ id: 'WI-runtime-b' });
    const model = judgementCall('r-finding-merge');
    let original: Record<string, unknown> | undefined;
    await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-complete', sql: db.sql, now: () => NOW,
      llmCall: async (input) => {
        const [running] = await db.sql`
          SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-complete'`;
        expect(running.detail.status).toBe('running');
        original = running.detail.producingRuntime;
        expect(original).toMatchObject({
          schemaVersion: 1, host: hostname(), pid: process.pid,
          buildSha: 'a'.repeat(40), version: 'runtime-fixture',
          buildIdentityStatus: 'matched-boot-record', buildIdentitySource: 'runtime-vintage-kernel-pin',
        });
        expect(original!.observedAt).toEqual(expect.any(String));
        // A later process/build must never re-label the original run.
        await reportRuntimeVintage({
          workspaceId: WS, unit: 'fixture-producer', pid: process.pid,
          treeSha: 'b'.repeat(40), bundleVersion: 'later-runtime',
        });
        return model(input);
      },
    });
    expect(original).toBeDefined();
    const [complete] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-complete'`;
    expect(complete.detail.status).toBe('complete');
    expect(complete.detail.producingRuntime).toEqual(original);
    await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-complete', sql: db.sql,
      llmCall: vi.fn(), now: () => NOW,
    });
    const [replayed] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-complete'`;
    expect(replayed.detail.producingRuntime).toEqual(original);
  });

  it('retains the producing runtime when the model fails', async () => {
    await seedItem({ id: 'WI-runtime-fail-a' });
    await seedItem({ id: 'WI-runtime-fail-b' });
    let original: Record<string, unknown> | undefined;
    await expect(runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-failed', sql: db.sql, now: () => NOW,
      llmCall: async () => {
        const [running] = await db.sql`
          SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-failed'`;
        original = running.detail.producingRuntime;
        await reportRuntimeVintage({
          workspaceId: WS, unit: 'fixture-producer', pid: process.pid,
          treeSha: 'b'.repeat(40), bundleVersion: 'later-runtime',
        });
        throw new Error('runtime witness model failure');
      },
    })).rejects.toThrow('runtime witness model failure');
    expect(original).toBeDefined();
    const [failed] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-failed'`;
    expect(failed.detail.status).toBe('failed');
    expect(failed.detail.producingRuntime).toEqual(original);
  });

  it('records unknown build identity and preserves it through fail-open completion', async () => {
    vintage.rows.clear();
    await runWorkItemAdmissionFailOpen({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-unknown', sql: db.sql, now: () => NOW,
    });
    const [run] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-unknown'`;
    expect(run.detail.status).toBe('complete');
    expect(run.detail.mode).toBe('fail-open');
    expect(run.detail.producingRuntime).toMatchObject({
      buildSha: null, buildIdentityStatus: 'unknown', buildIdentityReason: 'boot-record-absent',
      host: hostname(), pid: process.pid,
    });
  });

  it.each(['stale-process', 'missing-sha', 'ambiguous'] as const)(
    'keeps an unverifiable producing runtime UNKNOWN (%s)', async kind => {
      if (kind === 'stale-process') {
        await vintage.report({
          workspaceId: WS, unit: 'fixture-producer', pid: process.pid,
          treeSha: 'a'.repeat(40), extra: { kernelProcessIdentity: 'replaced-process' },
        });
      } else {
        await reportRuntimeVintage({
          workspaceId: WS, unit: kind === 'ambiguous' ? 'second-unit' : 'fixture-producer',
          pid: process.pid, treeSha: kind === 'missing-sha' ? null : 'a'.repeat(40),
        });
      }
      await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: `runtime-${kind}`, sql: db.sql,
        llmCall: vi.fn(), now: () => NOW,
      });
      const [run] = await db.sql`
        SELECT detail FROM harness_shared.admission_runs WHERE id = ${`runtime-${kind}`}`;
      expect(run.detail.producingRuntime).toMatchObject({
        buildSha: null, environmentFingerprint: null, buildIdentityStatus: 'unknown',
        buildIdentityReason: kind === 'stale-process' ? 'boot-process-identity-mismatch'
          : kind === 'missing-sha' ? 'boot-record-unverifiable' : 'boot-record-ambiguous',
      });
    },
  );

  it('does not backfill a legacy run with the replaying runtime identity', async () => {
    await db.sql`
      INSERT INTO harness_shared.admission_runs (id, workspace_id, harness_slug, run_kind, started_at, detail)
      VALUES ('runtime-legacy', ${WS}, ${HARNESS}, 'promoter-tick', now(), '{"status":"running"}'::jsonb)`;
    await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'runtime-legacy', sql: db.sql,
      llmCall: vi.fn(), now: () => NOW,
    });
    const [run] = await db.sql`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'runtime-legacy'`;
    expect(run.detail.status).toBe('complete');
    expect(run.detail).not.toHaveProperty('producingRuntime');
  });

  it('does not compare equal-mode rows whose exact stored profiles differ', async () => {
    await seedItem({
      id: 'WI-gemma',
      title: 'alpha profile candidate',
      admission: 'pending',
      embeddingProfile: 'gemma-embeddinggemma-300m-768@v1',
    });
    await seedItem({
      id: 'WI-openai',
      title: 'orthogonal profile candidate',
      admission: 'admitted',
      embeddingProfile: 'openai-text-embedding-3-small-768@v1',
    });
    const llmCall = vi.fn();
    const onNewlyAdmitted = vi.fn(async (rows: readonly { id: string; harness: string }[]) => {
      const stored = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-gemma'`;
      expect(stored[0]?.admission).toBe('admitted');
      expect(rows).toEqual([{ id: 'WI-gemma', harness: HARNESS }]);
    });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-exact-profile-isolation',
      sql: db.sql,
      llmCall,
      now: () => NOW,
      onNewlyAdmitted,
    });

    expect(result).toMatchObject({ promoted: 1, merged: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    expect(onNewlyAdmitted).toHaveBeenCalledOnce();
  });

  describe('dependency-reference rewrite transaction boundary', () => {
    const insertDependency = async (blockedRef: string, blockerRef: string): Promise<void> => {
      await db.sql`
        INSERT INTO harness_shared.work_item_deps
          (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
        VALUES (${WS}, 'issue', ${blockedRef}, 'issue', ${blockerRef}, 'blocks', 'settled', 'fixture')`;
    };

    it('runs at SERIALIZABLE and leaves identity rewrites as a true no-op', async () => {
      await seedItem({ id: 'WI-noop-blocked', admission: 'admitted' });
      await seedItem({ id: 'WI-noop-blocker', admission: 'admitted' });
      await insertDependency('WI-noop-blocked', 'WI-noop-blocker');

      const result = await withWorkItemDependencyAdmissionTransaction(db.sql, async (tx) => {
        const [isolation] = await tx<Array<{ transaction_isolation: string }>>`SHOW transaction_isolation`;
        const receipts = await repointWorkItemDependencyRefsInTransaction(tx, {
          workspaceId: WS,
          rewrites: [{ from: 'WI-noop-blocked', to: 'WI-noop-blocked' }],
        });
        return { isolation: isolation?.transaction_isolation, receipts };
      });

      expect(result).toEqual({ isolation: 'serializable', receipts: [] });
      expect(await db.sql`
        SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY id
      `).toEqual([{ blocked_ref: 'WI-noop-blocked', blocker_ref: 'WI-noop-blocker' }]);
    });

    it('rejects conflicting rewrites before touching the stored edge', async () => {
      await seedItem({ id: 'WI-conflict-source', admission: 'admitted' });
      await seedItem({ id: 'WI-conflict-a', admission: 'admitted' });
      await seedItem({ id: 'WI-conflict-b', admission: 'admitted' });
      await insertDependency('WI-conflict-source', 'WI-conflict-a');

      await expect(
        withWorkItemDependencyAdmissionTransaction(db.sql, (tx) =>
          repointWorkItemDependencyRefsInTransaction(tx, {
            workspaceId: WS,
            rewrites: [
              { from: 'WI-conflict-source', to: 'WI-conflict-a' },
              { from: 'WI-conflict-source', to: 'WI-conflict-b' },
            ],
          }),
        ),
      ).rejects.toThrow(/conflicting dependency ref rewrites/);
      expect(await db.sql`
        SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY id
      `).toEqual([{ blocked_ref: 'WI-conflict-source', blocker_ref: 'WI-conflict-a' }]);
    });

    it('rolls back sibling writes when a repoint would introduce a dependency cycle', async () => {
      for (const id of ['WI-cycle-loser', 'WI-cycle-a', 'WI-cycle-b']) {
        await seedItem({ id, admission: 'admitted', summary: `${id} original` });
      }
      await insertDependency('WI-cycle-loser', 'WI-cycle-a');
      await insertDependency('WI-cycle-a', 'WI-cycle-b');

      await expect(
        withWorkItemDependencyAdmissionTransaction(db.sql, async (tx) => {
          await tx`UPDATE harness_shared.work_items SET summary = 'must roll back' WHERE feature_id = 'WI-cycle-a'`;
          return repointWorkItemDependencyRefsInTransaction(tx, {
            workspaceId: WS,
            rewrites: [{ from: 'WI-cycle-loser', to: 'WI-cycle-b' }],
          });
        }),
      ).rejects.toBeInstanceOf(WorkItemDependencyAdmissionError);

      const [item] = await db.sql<Array<{ summary: string }>>`
        SELECT summary FROM harness_shared.work_items WHERE feature_id = 'WI-cycle-a'`;
      expect(item?.summary).toBe('WI-cycle-a original');
      expect(await db.sql`
        SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY blocked_ref, blocker_ref
      `).toEqual([
        { blocked_ref: 'WI-cycle-a', blocker_ref: 'WI-cycle-b' },
        { blocked_ref: 'WI-cycle-loser', blocker_ref: 'WI-cycle-a' },
      ]);
    });

    it('serializes concurrent disjoint repoints that would otherwise commit a two-cycle', async () => {
      for (const id of ['WI-race-a', 'WI-race-b', 'WI-race-loser-a', 'WI-race-loser-b']) {
        await seedItem({ id, admission: 'admitted' });
      }
      await insertDependency('WI-race-loser-a', 'WI-race-a');
      await insertDependency('WI-race-loser-b', 'WI-race-b');

      let arrivals = 0;
      let openBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
      });
      const beforeWrite = async (): Promise<void> => {
        arrivals += 1;
        if (arrivals === 2) openBarrier();
        if (arrivals <= 2) await barrier;
      };
      const repoint = (from: string, to: string) =>
        withWorkItemDependencyAdmissionTransaction(db.sql, (tx) =>
          repointWorkItemDependencyRefsInTransaction(
            tx,
            { workspaceId: WS, rewrites: [{ from, to }] },
            { beforeWrite },
          ),
        );

      const results = await Promise.allSettled([
        repoint('WI-race-loser-a', 'WI-race-b'),
        repoint('WI-race-loser-b', 'WI-race-a'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: expect.any(WorkItemDependencyAdmissionError) });

      const edges = await db.sql<Array<{ blocked_ref: string; blocker_ref: string }>>`
        SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY blocked_ref, blocker_ref`;
      expect(edges).toHaveLength(2);
      const edgeKeys = new Set(edges.map((edge) => `${edge.blocked_ref}<-${edge.blocker_ref}`));
      expect(edgeKeys.has('WI-race-a<-WI-race-b') && edgeKeys.has('WI-race-b<-WI-race-a')).toBe(false);
    }, 60_000);
  });

  it('targets the original item without admitting an older unrelated row or another scope', async () => {
    await seedItem({ id: 'WI-target', title: 'unique selected recovery', vector: null });
    await seedItem({ id: 'WI-older', title: 'unrelated older work', vector: null, createdAtMs: NOW - 30_000 });
    await seedItem({ id: 'WI-target', title: 'foreign workspace', vector: null, workspaceId: 'other' });
    await seedItem({ id: 'WI-target', title: 'foreign harness', vector: null, harness: 'other' });
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'exact-original', sql: db.sql,
      targetItemIds: ['WI-target'], batchSize: 1, llmCall, now: () => NOW,
    });
    expect(result).toMatchObject({ batchSize: 1, promoted: 1, merged: 0, held: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
    expect(await db.sql`
      SELECT workspace_id, harness_slug, feature_id FROM harness_shared.work_items WHERE admission = 'admitted'
    `).toEqual([{ workspace_id: WS, harness_slug: HARNESS, feature_id: 'WI-target' }]);
    expect(await db.sql`SELECT 1 FROM harness_shared.work_items`).toHaveLength(4);
  });

  it.each(['r-finding-merge', 'r-remedy-keep'] as const)(
    'screens out-of-batch neighbours but refuses their mutation component (%s)', async (verdict) => {
      await seedItem({ id: 'WI-target' });
      await seedItem({ id: 'WI-neighbour', admission: 'unreviewed', createdAtMs: NOW - 20_000 });
      const before = await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`;
      const llmCall = judgementCall(verdict);
      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: `exact-neighbour-${verdict}`, sql: db.sql,
        targetItemIds: ['WI-target'], llmCall, now: () => NOW,
      });
      expect(llmCall).toHaveBeenCalledTimes(1);
      expect(llmCall.mock.calls[0]![0].messages[0]!.content).toContain('WI-neighbour');
      expect(result).toMatchObject({ batchSize: 1, flaggedPairs: 1, promoted: 0, merged: 0, writerCoverageGap: [] });
      expect(result.guardRefusals).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: 'WI-target', reason: 'outside-mutation-scope' }),
      ]));
      expect(await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`).toEqual(before);
      expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM harness_shared.coord_links`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
    },
  );

  it('permits a fully targeted component while retaining snapshot-drift refusal', async () => {
    await seedItem({ id: 'WI-a' });
    await seedItem({ id: 'WI-b' });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'exact-component', sql: db.sql,
      targetItemIds: ['WI-a', 'WI-b'], llmCall: judgementCall('r-finding-merge'), now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 1, merged: 1, guardRefusals: [], writerCoverageGap: [] });

    await seedItem({ id: 'WI-drift', title: 'isolated drift probe', vector: null });
    const snapshots = await readAdmissionMergeSnapshots(db.sql, {
      workspaceId: WS, harnessSlug: HARNESS, ids: ['WI-drift'],
    });
    await db.sql`UPDATE harness_shared.work_items SET summary = 'changed' WHERE feature_id = 'WI-drift'`;
    const refused = await persistAdmissionPlan(db.sql, {
      workspaceId: WS, harnessSlug: HARNESS, runId: 'exact-drift', modelId: 'fixture', nowMs: NOW,
      pending: await readPendingBatch(db.sql, WS, HARNESS, 1, ['WI-drift']),
      snapshots: [...snapshots.values()], mutationItemIds: ['WI-drift'],
      plan: { dispositions: [{ itemId: 'WI-drift', action: 'promote' }], adjudications: [], relatedPairs: [] },
    });
    expect(refused.promotedIds).toEqual([]);
    expect(refused.guardRefusals).toEqual([expect.objectContaining({ reason: 'snapshot-drift' })]);
  });

  it('refuses a legacy promote disposition without aborting the transaction', async () => {
    await seedItem({ id: 'WI-legacy-promote', admission: null });
    const snapshots = await readAdmissionMergeSnapshots(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      ids: ['WI-legacy-promote'],
    });

    const result = await persistAdmissionPlan(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-legacy-promote-guard',
      modelId: 'fixture',
      nowMs: NOW,
      pending: [],
      snapshots: [...snapshots.values()],
      plan: {
        dispositions: [{ itemId: 'WI-legacy-promote', action: 'promote' }],
        adjudications: [],
        relatedPairs: [],
      },
    });

    expect(result).toMatchObject({
      promotedIds: [],
      mergedIds: [],
      held: [{ itemId: 'WI-legacy-promote', reason: expect.stringContaining('admission-state-ineligible') }],
      guardRefusals: [
        {
          itemId: 'WI-legacy-promote',
          reason: 'admission-state-ineligible',
          detail: expect.stringContaining('expected pending or unreviewed'),
        },
      ],
    });
    const [row] = await db.sql<Array<{ admission: string | null; status: string }>>`
      SELECT admission, status FROM harness_shared.work_items WHERE feature_id = 'WI-legacy-promote'`;
    expect(row).toEqual({ admission: null, status: 'open' });
  });

  it('does not turn an admitted recurrence replacement into a zero-row promote', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 30_000 });
    await seedItem({
      id: 'WI-keyed-canonical',
      admission: 'admitted',
      createdAtMs: NOW - 20_000,
      payload: { watchdogKey: 'watchdog:shared-promoter' },
    });
    await seedItem({ id: 'WI-pending-bridge', admission: 'pending', createdAtMs: NOW - 10_000 });

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-admitted-recurrence-replacement',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });

    expect(result).toMatchObject({ promoted: 0, merged: 2, held: 0, guardRefusals: [], writerCoverageGap: [] });
    const rows = await db.sql<Array<{ feature_id: string; status: string; admission: string | null }>>`
      SELECT feature_id, status, admission FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-canonical', status: 'dropped', admission: 'admitted' },
      { feature_id: 'WI-keyed-canonical', status: 'open', admission: 'admitted' },
      { feature_id: 'WI-pending-bridge', status: 'dropped', admission: 'admitted' },
    ]);
  }, 60_000);

  it('does not merge a younger outside-batch loser even when the target is canonical', async () => {
    await seedItem({ id: 'WI-target', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-outside', createdAtMs: NOW - 10_000 });
    const before = await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`;
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'exact-outside-loser', sql: db.sql,
      targetItemIds: ['WI-target'], llmCall: judgementCall('r-finding-merge'), now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 0, merged: 0, flaggedPairs: 1, writerCoverageGap: [] });
    expect(result.guardRefusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'WI-target', reason: 'outside-mutation-scope' }),
      expect.objectContaining({ itemId: 'WI-outside', reason: 'outside-mutation-scope' }),
    ]));
    expect(await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`).toEqual(before);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
  });

  it('holds a fully targeted merge whose reference rewrite would touch an outside row', async () => {
    await seedItem({ id: 'WI-a', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-b', createdAtMs: NOW - 10_000 });
    await seedItem({ id: 'WI-reference', title: 'unrelated reference source', vector: null });
    await db.sql`UPDATE harness_shared.work_items SET see_also = ARRAY['WI-b'] WHERE feature_id = 'WI-reference'`;
    const before = await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`;
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'exact-outside-reference', sql: db.sql,
      targetItemIds: ['WI-a', 'WI-b'], llmCall: judgementCall('r-finding-merge'), now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 0, merged: 0, writerCoverageGap: [] });
    expect(result.guardRefusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'WI-b', reason: 'outside-mutation-scope' }),
    ]));
    expect(await db.sql`SELECT * FROM harness_shared.work_items ORDER BY feature_id`).toEqual(before);
    expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
  });

  it('never interprets missing or invalid exact targets as the global batch', async () => {
    await seedItem({ id: 'WI-stays-pending', vector: null });
    expect(await readPendingBatch(db.sql, WS, HARNESS, 20, ['WI-absent'])).toEqual([]);
    await expect(readPendingBatch(db.sql, WS, HARNESS, 20, [])).rejects.toThrow('targetItemIds');
    await expect(runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'invalid-targets', sql: db.sql,
      targetItemIds: [], llmCall: vi.fn(),
    })).rejects.toThrow('targetItemIds');
    expect(await db.sql`SELECT 1 FROM harness_shared.admission_runs`).toHaveLength(0);
    expect(await db.sql`SELECT admission FROM harness_shared.work_items`).toEqual([{ admission: 'pending' }]);
  });

  it('previews reviewed cleanup with current readiness and preserves no-signal/insufficient evidence', async () => {
    const notReady = {
      implementationReadiness: {
        schemaVersion: 'implementation-readiness-v1',
        status: 'not-ready',
        source: 'triage-freshness',
        reason: 'current code still carries the reported gap',
        updatedAt: '2026-08-26T11:59:00.000Z',
      },
    };
    for (const [id, payload] of [
      ['WI-a', {}],
      ['WI-b', {}],
      ['WI-c', notReady],
      ['WI-d', {}],
    ] as const) {
      await seedItem({ id, admission: 'admitted', conditionKey: 'watch:clone', payload });
    }

    const preview = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals: [
        {
          itemId: 'WI-a',
          action: 'merge',
          canonicalId: 'WI-b',
          evidence: { status: 'ready', ref: 'ledger#a', reason: 'current full-body equivalence verified' },
        },
        {
          itemId: 'WI-c',
          action: 'merge',
          canonicalId: 'WI-b',
          evidence: { status: 'ready', ref: 'ledger#c', reason: 'external review proposed merge' },
        },
        {
          itemId: 'WI-d',
          action: 'preserve',
          evidence: { status: 'unknown', ref: 'ledger#d', reason: 'no candidate signal' },
        },
        {
          itemId: 'WI-missing',
          action: 'merge',
          canonicalId: 'WI-b',
          evidence: { status: 'ready', ref: 'ledger#missing', reason: 'stale ledger proposal' },
        },
      ],
    });

    expect(preview).toMatchObject({
      schemaVersion: 'reviewed-admission-cleanup-preview-v1',
      mutates: false,
      modelCalled: false,
      counts: { total: 4, eligible: 1, preserved: 2, unknown: 1 },
      entries: [
        {
          itemId: 'WI-a',
          outcome: 'eligible',
          fingerprints: { item: expect.any(String), canonical: expect.any(String) },
        },
        {
          itemId: 'WI-c',
          outcome: 'preserved',
          reasons: [{ code: 'implementation-readiness-not-ready', endpointId: 'WI-c' }],
        },
        { itemId: 'WI-d', outcome: 'preserved', reasons: [{ code: 'evidence-unknown' }] },
        { itemId: 'WI-missing', outcome: 'unknown', reasons: [{ code: 'snapshot-missing' }] },
      ],
    });
    expect(preview.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE status <> 'open'`).toHaveLength(0);
  });

  it('binds a reviewed preview hash to its workspace and harness scope', async () => {
    const proposals = [
      {
        itemId: 'WI-missing',
        action: 'preserve' as const,
        evidence: { status: 'unknown' as const, ref: 'ledger#missing', reason: 'no current row' },
      },
    ];
    const local = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
    });
    const neighbouringHarness = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: 'email',
      proposals,
    });
    const neighbouringWorkspace = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: 'another-workspace',
      harnessSlug: HARNESS,
      proposals,
    });

    expect(neighbouringHarness.inputHash).toBe(local.inputHash);
    expect(neighbouringWorkspace.inputHash).toBe(local.inputHash);
    expect(neighbouringHarness.previewHash).not.toBe(local.previewHash);
    expect(neighbouringWorkspace.previewHash).not.toBe(local.previewHash);
  });

  it('applies only the exact eligible reviewed preview and persists its evidence binding', async () => {
    for (const id of ['WI-a', 'WI-b', 'WI-preserve']) {
      await seedItem({ id, admission: 'admitted', conditionKey: 'watch:clone', payload: {} });
    }
    const proposals = [
      {
        itemId: 'WI-a',
        action: 'merge' as const,
        canonicalId: 'WI-b',
        evidence: {
          status: 'ready' as const,
          ref: 'ledger#WI-a',
          reason: 'current full-body equivalence verified',
          sourceSha256: 'a'.repeat(64),
        },
      },
      {
        itemId: 'WI-preserve',
        action: 'preserve' as const,
        evidence: {
          status: 'unknown' as const,
          ref: 'ledger#WI-preserve',
          reason: 'no current candidate signal',
        },
      },
    ];
    const preview = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
    });

    const applied = await applyReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
      previewHash: preview.previewHash,
      runId: 'reviewed-apply-exact',
      actor: 'su:review-owner',
      nowMs: NOW,
    });

    expect(applied).toMatchObject({
      schemaVersion: 'reviewed-admission-cleanup-apply-v1',
      requestedPreviewHash: preview.previewHash,
      currentPreviewHash: preview.previewHash,
      applied: true,
      mutates: true,
      modelCalled: false,
      reason: 'applied',
      counts: { total: 2, eligible: 1, preserved: 1, unknown: 0, merged: 1, replayed: 0, retained: 1 },
      guardRefusals: [],
      persistence: { mergedIds: ['WI-a'], uniqueRowsChanged: 1 },
    });
    const rows = await db.sql<
      Array<{ feature_id: string; status: string; payload: Record<string, any>; terminal_owner: string | null }>
    >`
      SELECT feature_id, status, payload, terminal_owner
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows.find((row) => row.feature_id === 'WI-a')).toMatchObject({
      status: 'dropped',
      terminal_owner: 'su:review-owner',
      payload: {
        admissionMerge: {
          state: 'complete',
          canonicalId: 'WI-b',
          runId: 'reviewed-apply-exact',
          reviewedCleanup: {
            schemaVersion: 'reviewed-admission-cleanup-binding-v1',
            previewHash: preview.previewHash,
            inputHash: preview.inputHash,
            evidence: {
              status: 'ready',
              ref: 'ledger#WI-a',
              reason: 'current full-body equivalence verified',
              sourceSha256: 'a'.repeat(64),
            },
          },
        },
      },
    });
    expect(rows.find((row) => row.feature_id === 'WI-b')).toMatchObject({ status: 'open' });
    expect(rows.find((row) => row.feature_id === 'WI-preserve')).toMatchObject({ status: 'open', payload: {} });
    const adjudications = await db.sql<Array<{ verdict: string; canonical: string; run_id: string }>>`
      SELECT verdict, canonical, run_id FROM harness_shared.dedup_adjudications`;
    expect(adjudications).toEqual([{ verdict: 'r-finding-merge', canonical: 'WI-b', run_id: 'reviewed-apply-exact' }]);
  });

  it('rejects a stale cohort hash before applying any otherwise eligible merge', async () => {
    for (const id of ['WI-a', 'WI-b', 'WI-c', 'WI-d']) {
      await seedItem({ id, admission: 'admitted', conditionKey: 'watch:clone', payload: {} });
    }
    const proposals = [
      {
        itemId: 'WI-a',
        action: 'merge' as const,
        canonicalId: 'WI-b',
        evidence: { status: 'ready' as const, ref: 'ledger#a', reason: 'reviewed pair a/b' },
      },
      {
        itemId: 'WI-c',
        action: 'merge' as const,
        canonicalId: 'WI-d',
        evidence: { status: 'ready' as const, ref: 'ledger#c', reason: 'reviewed pair c/d' },
      },
    ];
    const preview = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
    });
    await db.sql`
      UPDATE harness_shared.work_items
         SET summary = 'changed after review'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-c'`;

    const refused = await applyReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
      previewHash: preview.previewHash,
      runId: 'reviewed-apply-stale',
      actor: 'su:review-owner',
      nowMs: NOW,
    });

    expect(refused).toMatchObject({
      applied: false,
      mutates: false,
      modelCalled: false,
      reason: 'preview-hash-mismatch',
      requestedPreviewHash: preview.previewHash,
      counts: { eligible: 2, merged: 0, replayed: 0, retained: 2 },
      persistence: null,
    });
    expect(refused.currentPreviewHash).not.toBe(preview.previewHash);
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE status <> 'open'`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
  });

  it('rolls back the whole reviewed apply when its adjudication cannot be persisted', async () => {
    for (const id of ['WI-a', 'WI-b']) {
      await seedItem({ id, admission: 'admitted', conditionKey: 'watch:clone', payload: {} });
    }
    const proposals = [
      {
        itemId: 'WI-a',
        action: 'merge' as const,
        canonicalId: 'WI-b',
        evidence: { status: 'ready' as const, ref: 'ledger#a', reason: 'current equivalence review' },
      },
    ];
    const preview = await previewReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
    });
    await db.sql`
      INSERT INTO harness_shared.dedup_adjudications
        (workspace_id, harness_slug, a, b, verdict, canonical, judged_by, run_id, evidence)
      VALUES (${WS}, ${HARNESS}, 'WI-a', 'WI-b', 'r-remedy-keep', NULL,
              'prior-reviewer', 'prior-review', '{}'::jsonb)`;

    const refused = await applyReviewedAdmissionCleanup(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      proposals,
      previewHash: preview.previewHash,
      runId: 'reviewed-apply-conflict',
      actor: 'su:review-owner',
      nowMs: NOW,
    });

    expect(refused).toMatchObject({
      applied: false,
      mutates: false,
      reason: 'transactional-revalidation-refused',
      counts: { eligible: 1, merged: 0, replayed: 0, retained: 1 },
      guardRefusals: [
        {
          itemId: 'WI-a',
          canonicalId: 'WI-b',
          reason: 'conditional-write-miss',
          detail: expect.stringContaining('did not persist adjudication'),
        },
      ],
      persistence: null,
    });
    const rows = await db.sql<
      Array<{ feature_id: string; status: string; payload: Record<string, unknown>; see_also: string[] | null }>
    >`
      SELECT feature_id, status, payload, see_also
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-a', status: 'open', payload: {}, see_also: null },
      { feature_id: 'WI-b', status: 'open', payload: {}, see_also: null },
    ]);
    expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
    const adjudications = await db.sql<Array<{ verdict: string; run_id: string }>>`
      SELECT verdict, run_id FROM harness_shared.dedup_adjudications`;
    expect(adjudications).toEqual([{ verdict: 'r-remedy-keep', run_id: 'prior-review' }]);
  });

  it('rejects a reviewed merge graph whose canonical is also a cohort loser', async () => {
    await expect(
      previewReviewedAdmissionCleanup(db.sql, {
        workspaceId: WS,
        harnessSlug: HARNESS,
        proposals: [
          {
            itemId: 'WI-a',
            action: 'merge',
            canonicalId: 'WI-b',
            evidence: { status: 'ready', ref: 'ledger#a', reason: 'first link' },
          },
          {
            itemId: 'WI-b',
            action: 'merge',
            canonicalId: 'WI-c',
            evidence: { status: 'ready', ref: 'ledger#b', reason: 'second link' },
          },
        ],
      }),
    ).rejects.toThrow('canonical WI-b is also scheduled as a merge loser');
  });

  it('replays six vitest clones: one promotes and five merge into one canonical', async () => {
    for (let i = 1; i <= 6; i += 1) await seedItem({ id: `WI-${i}`, createdAtMs: NOW - 20_000 + i });
    const llmCall = judgementCall('r-finding-merge');
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-clones',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      batchSize: 6,
      promoted: 1,
      merged: 5,
      held: 0,
      modelCalled: true,
      writerCoverageGap: [],
    });
    expect(llmCall).toHaveBeenCalledTimes(1);
    const rows = await db.sql<
      Array<{
        feature_id: string;
        status: string;
        admission: string;
        payload: { admissionMerge?: { canonicalId?: string } } | null;
        terminal_reason: string | null;
        terminal_completion_ref: string | null;
      }>
    >`
      SELECT wi.feature_id, wi.status, wi.admission, wi.payload, wi.terminal_reason, wi.terminal_completion_ref
        FROM harness_shared.work_items wi ORDER BY feature_id`;
    expect(rows[0]).toMatchObject({ feature_id: 'WI-1', status: 'open', admission: 'admitted' });
    for (const [index, row] of rows.slice(1).entries()) {
      expect(row).toMatchObject({
        feature_id: `WI-${index + 2}`,
        status: 'dropped',
        admission: 'admitted',
        terminal_reason: expect.stringContaining('duplicate of WI-1'),
        // WI-6554700010008454: the disposition also lands on the canonical drop column,
        // which is the only one WorkItem readers (the burn-down cohort audit) can see.
        terminal_completion_ref: expect.stringContaining('duplicate of WI-1'),
      });
      expect(row.terminal_completion_ref).toBe(row.terminal_reason);
      expect(row.payload).toMatchObject({
        admissionMerge: {
          schemaVersion: 2,
          state: 'complete',
          canonicalId: 'WI-1',
          runId: 'promoter-clones',
          reversalInstructions: { transactionRequired: true },
        },
      });
    }
    const run = await db.sql<Array<{ promoted: number; merged: number; status: string; model_cost_usd: number }>>`
      SELECT promoted, merged, detail->>'status' AS status,
             (detail->>'modelCostUsd')::double precision AS model_cost_usd
        FROM harness_shared.admission_runs WHERE id = 'promoter-clones'`;
    expect(run).toEqual([{ promoted: 1, merged: 5, status: 'complete', model_cost_usd: 0.0042 }]);
    // D-003: the ledger must carry the promoted-to-first-claim DISTRIBUTION, not
    // only promotion volume. An independent acceptance grader measured 0 of 208
    // real promoter-tick rows carrying it (EI-21844734848781188) — the value was
    // computed for the backpressure read and then dropped on the floor.
    const latency = await db.sql<Array<{ latency: Record<string, unknown> | null }>>`
      SELECT detail->'promotedToFirstClaim' AS latency
        FROM harness_shared.admission_runs WHERE id = 'promoter-clones'`;
    expect(latency[0]?.latency).toMatchObject({
      sampleSize: expect.any(Number),
      p50Ms: null,
      p95Ms: null,
    });
    // A failed telemetry read persists an explicit marker instead of a silent
    // zero, so "no samples yet" stays distinguishable from "not measured". If
    // this key ever appears, the block above is reporting absence as data.
    expect(latency[0]?.latency).not.toHaveProperty('unavailable');
    const identities = await db.sql<
      Array<{ a_fingerprint: string; b_fingerprint: string; canonical_fingerprint: string }>
    >`
      SELECT evidence #>> '{judgmentIdentity,a}' AS a_fingerprint,
             evidence #>> '{judgmentIdentity,b}' AS b_fingerprint,
             evidence #>> '{judgmentIdentity,canonical}' AS canonical_fingerprint
        FROM harness_shared.dedup_adjudications
       WHERE run_id = 'promoter-clones'
       ORDER BY a, b`;
    expect(identities).toHaveLength(15);
    for (const identity of identities) {
      expect(identity.a_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.b_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.canonical_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);

  it('retains priced model usage when response validation fails after the call', async () => {
    await seedItem({ id: 'WI-failed-a', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-failed-b', createdAtMs: NOW - 19_000 });

    await expect(
      runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'promoter-invalid-response',
        model: 'model-priced',
        sql: db.sql,
        llmCall: vi.fn(async () => ({
          text: '',
          json: { judgements: [{ pairKey: 'not-a-real-pair', verdict: 'r-remedy-keep', reason: 'invalid fixture' }] },
          inputTokens: 77,
          outputTokens: 11,
          costUsd: 0.0065,
        })),
        now: () => NOW,
      }),
    ).rejects.toThrow('unknown pairKey');

    const [run] = await db.sql<
      Array<{
        state: string;
        model_id: string;
        tokens_in: number;
        tokens_out: number;
        model_cost_usd: number;
      }>
    >`
      SELECT detail->>'status' AS state, model_id, tokens_in, tokens_out,
             (detail->>'modelCostUsd')::double precision AS model_cost_usd
        FROM harness_shared.admission_runs
       WHERE id = 'promoter-invalid-response'`;
    expect(run).toEqual({
      state: 'failed',
      model_id: 'model-priced',
      tokens_in: 77,
      tokens_out: 11,
      model_cost_usd: 0.0065,
    });
  });

  it('holds conflicting recurrence identities without starving an unrelated pending item', async () => {
    const conflictingIds = ['WI-producer-first', 'WI-producer-second'];
    for (const id of conflictingIds) {
      await seedItem({ id, payload: { watchdogKey: `watchdog:${id}` } });
    }
    await seedItem({
      id: 'WI-independent-review',
      title: 'Independent release signing review',
      summary: 'Inventory the remaining package signing inputs.',
      vector: '[0,1,0]',
    });
    const modelCall = judgementCall('r-finding-merge');

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-recurrence-component-hold',
      sql: db.sql,
      llmCall: modelCall,
      now: () => NOW,
    });

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ batchSize: 3, promoted: 1, merged: 0, held: 2, writerCoverageGap: [] });
    const rows = await db.sql<
      Array<{ feature_id: string; status: string; admission: string; watchdog_key: string | null }>
    >`
      SELECT feature_id, status, admission, payload->>'watchdogKey' AS watchdog_key
        FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-independent-review', status: 'open', admission: 'admitted', watchdog_key: null },
      ...conflictingIds.map((id) => ({
        feature_id: id,
        status: 'open',
        admission: 'pending',
        watchdog_key: `watchdog:${id}`,
      })),
    ]);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    const [run] = await db.sql<
      Array<{ status: string; held: number; reasons: Array<{ itemId: string; reason: string }> }>
    >`
      SELECT detail->>'status' AS status, held, detail->'heldReasons' AS reasons
        FROM harness_shared.admission_runs WHERE id = 'promoter-recurrence-component-hold'`;
    expect(run).toMatchObject({
      status: 'complete',
      held: 2,
      reasons: conflictingIds.map((itemId) => ({
        itemId,
        reason: expect.stringContaining('conflicting stable producer identities'),
      })),
    });
  });

  it('selects the keyed pending survivor and preserves recurrence, references, satisfied deps and reversal data', async () => {
    const historicalId = 'WI-historical-unkeyed';
    const keyedId = 'WI-keyed-successor';
    const conditionKey = 'recurrence:shared-promoter';
    const watchdogKey = 'watchdog:shared-promoter';
    await seedItem({ id: historicalId, admission: 'admitted', createdAtMs: NOW - 20_000 });
    await seedItem({ id: keyedId, admission: 'pending', createdAtMs: NOW - 10_000, conditionKey });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = '{"legacyEvidence":true}'::jsonb,
             source_plan_slug = 'source-plan', source_plan_item_ids = ARRAY['P-003'],
             see_also = ARRAY['WI-outgoing'], updated_ts = ${NOW - 20_000}
       WHERE feature_id = ${historicalId}`;
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = ${JSON.stringify({ watchdogKey, repeatCount: 1 })}::text::jsonb,
             see_also = ARRAY['WI-canonical-existing'], updated_ts = ${NOW - 10_000}
       WHERE feature_id = ${keyedId}`;
    for (const [id, title, status] of [
      ['WI-outgoing', 'Outgoing reference target', 'open'],
      ['WI-canonical-existing', 'Canonical reference target', 'open'],
      ['WI-referrer', 'Incoming reference source', 'open'],
      ['WI-done-blocker', 'Satisfied dependency blocker', 'done'],
    ] as const) {
      await seedItem({ id, title, status, admission: 'admitted', vector: null, createdAtMs: NOW - 30_000 });
    }
    await db.sql`
      UPDATE harness_shared.work_items
         SET see_also = ARRAY[${historicalId}], updated_ts = ${NOW - 30_000}
       WHERE feature_id = 'WI-referrer'`;
    const [historicalOccurrence] = await db.sql<Array<{ occurrence_id: string | number }>>`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool,
         report_kind, reported_title, evidence, admission_identity)
      VALUES (${WS}, ${HARNESS}, ${historicalId}, 'test', 'improvements:capture',
              'canonical-created', 'Historical occurrence', '{"historical":true}'::jsonb, '{}'::jsonb)
      RETURNING occurrence_id`;
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
      VALUES
        (${WS}, 'issue', ${historicalId}, 'issue', 'WI-done-blocker', 'blocks', 'success', 'loser-writer'),
        (${WS}, 'issue', ${keyedId}, 'issue', 'WI-done-blocker', 'blocks', 'settled', 'canonical-writer')`;

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-recurrence-and-reversal',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 1, merged: 1, held: 0, guardRefusals: [] });

    const [canonical] = await db.sql<
      Array<{
        status: string;
        condition_key: string | null;
        watchdog_key: string | null;
        source_plan_slug: string | null;
        source_plan_item_ids: string[];
        see_also: string[];
      }>
    >`
      SELECT status, condition_key, payload->>'watchdogKey' AS watchdog_key,
             source_plan_slug, COALESCE(source_plan_item_ids, ARRAY[]::text[]) AS source_plan_item_ids,
             COALESCE(see_also, ARRAY[]::text[]) AS see_also
        FROM harness_shared.work_items WHERE feature_id = ${keyedId}`;
    expect(canonical).toEqual({
      status: 'open',
      condition_key: conditionKey,
      watchdog_key: watchdogKey,
      source_plan_slug: 'source-plan',
      source_plan_item_ids: ['P-003'],
      see_also: [historicalId, 'WI-canonical-existing', 'WI-outgoing'].sort(),
    });

    const [loser] = await db.sql<Array<{ status: string; condition_key: string | null; receipt: Record<string, any> }>>`
      SELECT status, condition_key, payload->'admissionMerge' AS receipt
        FROM harness_shared.work_items WHERE feature_id = ${historicalId}`;
    expect(loser?.status).toBe('dropped');
    expect(loser?.condition_key).toBeNull();
    expect(loser?.receipt).toMatchObject({
      schemaVersion: 2,
      state: 'complete',
      canonicalId: keyedId,
      mergedAtMs: NOW,
      prior: {
        status: 'open',
        admission: 'admitted',
        takenBy: null,
        sourcePlanSlug: 'source-plan',
        sourcePlanItemIds: ['P-003'],
        seeAlso: ['WI-outgoing'],
      },
      canonical: {
        prior: { takenBy: null, sourcePlanSlug: null, sourcePlanItemIds: null, seeAlso: ['WI-canonical-existing'] },
        applied: { sourcePlanSlug: 'source-plan', sourcePlanItemIds: ['P-003'] },
      },
      transfers: {
        incomingReferenceSources: ['WI-referrer'],
        occurrences: [{ occurrenceId: String(historicalOccurrence?.occurrence_id) }],
        duplicateOccurrenceCreated: true,
        dependencyEdges: [
          {
            disposition: 'merged-with-existing-edge',
            before: { blockedRef: historicalId, satisfaction: 'success', createdBy: 'loser-writer' },
            after: { blockedRef: keyedId, satisfaction: 'success', createdBy: 'canonical-writer' },
            targetPrior: { blockedRef: keyedId, satisfaction: 'settled', createdBy: 'canonical-writer' },
          },
        ],
      },
      reversalInstructions: { schemaVersion: 1, transactionRequired: true, compareAppliedStateBeforeRestore: true },
    });

    const [referrer] = await db.sql<Array<{ see_also: string[] }>>`
      SELECT COALESCE(see_also, ARRAY[]::text[]) AS see_also
        FROM harness_shared.work_items WHERE feature_id = 'WI-referrer'`;
    expect(referrer?.see_also).toEqual([historicalId, keyedId].sort());
    const dependencies = await db.sql<
      Array<{ blocked_ref: string; blocker_ref: string; satisfaction: string; created_by: string | null }>
    >`
      SELECT blocked_ref, blocker_ref, satisfaction, created_by
        FROM harness_shared.work_item_deps ORDER BY id`;
    expect(dependencies).toEqual([
      { blocked_ref: keyedId, blocker_ref: 'WI-done-blocker', satisfaction: 'success', created_by: 'canonical-writer' },
    ]);
    const occurrences = await db.sql<Array<{ canonical: string; kind: string; merged_from: string | null }>>`
      SELECT canonical_work_item_id AS canonical, report_kind AS kind, evidence->>'mergedFrom' AS merged_from
        FROM harness_shared.work_item_occurrences ORDER BY occurrence_id`;
    expect(occurrences).toEqual([
      { canonical: keyedId, kind: 'canonical-created', merged_from: null },
      { canonical: keyedId, kind: 'duplicate', merged_from: historicalId },
    ]);
    const links = await db.sql<
      Array<{ workspace_id: string; src_kind: string; src_ref: string; dst_kind: string; dst_ref: string; rel: string }>
    >`
      SELECT workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel
        FROM harness_shared.coord_links
       WHERE workspace_id = ${WS}
       ORDER BY id`;
    expect(links).toEqual([
      {
        workspace_id: WS,
        src_kind: 'issue',
        src_ref: historicalId,
        dst_kind: 'issue',
        dst_ref: keyedId,
        rel: 'duplicates',
      },
    ]);
  }, 60_000);

  it.each([
    [
      'claim',
      async () =>
        db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-live-holder', updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-loser'`,
      'snapshot-drift',
    ],
    [
      'canonical claim',
      async () =>
        db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-live-canonical-holder', updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-canonical'`,
      'snapshot-drift',
    ],
    [
      'claim hold',
      async () =>
        db.sql`UPDATE harness_shared.work_items
                  SET payload = payload || '{"_claimHold":true,"claim_hold_by":"su-parker"}'::jsonb,
                      updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-loser'`,
      'snapshot-drift',
    ],
    [
      'remote origin',
      async () =>
        db.sql`UPDATE harness_shared.work_items SET origin = 'remote', updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-loser'`,
      'snapshot-drift',
    ],
    [
      'remedy and completion evidence',
      async () =>
        db.sql`UPDATE harness_shared.work_items
                  SET summary = 'A newly distinct remedy that must survive',
                      payload = payload || '{"_completionEvidence":{"verifiedHow":"new proof","testsRun":"new test"}}'::jsonb,
                      updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-loser'`,
      'snapshot-drift',
    ],
    [
      'harness scope',
      async () =>
        db.sql`UPDATE harness_shared.work_items SET harness_slug = 'moved-after-judge', updated_ts = updated_ts + 1
                WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-loser'`,
      'scope-or-identity-changed',
    ],
  ])(
    'refuses a %s change after judging before any adjudication, link, occurrence, or drop',
    async (_label, mutate, reason) => {
      await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 20_000 });
      await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: `promoter-drift-${String(_label).replaceAll(' ', '-')}`,
        sql: db.sql,
        llmCall: async () => {
          await mutate();
          return {
            text: '',
            json: {
              judgements: [
                { pairKey: 'WI-canonical::WI-loser', verdict: 'r-finding-merge', reason: 'same finding and remedy' },
              ],
            },
            inputTokens: 100,
            outputTokens: 20,
          };
        },
        now: () => NOW,
      });

      expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1, guardRefusals: [{ reason }] });
      const rows = await db.sql<Array<{ feature_id: string; status: string; links: string[] }>>`
      SELECT feature_id, status, COALESCE(see_also, ARRAY[]::text[]) AS links
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ANY(ARRAY['WI-canonical','WI-loser']::text[])
       ORDER BY feature_id`;
      expect(rows).toEqual([
        { feature_id: 'WI-canonical', status: 'open', links: [] },
        { feature_id: 'WI-loser', status: 'open', links: [] },
      ]);
      expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
    },
    60_000,
  );

  it.each([
    [
      'incoming dependency',
      async () =>
        db.sql`INSERT INTO harness_shared.work_item_deps
                 (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction)
               VALUES (${WS}, 'issue', 'WI-dependent', 'issue', 'WI-loser', 'blocks', 'settled')`,
    ],
    [
      'incoming see-also reference',
      async () =>
        db.sql`INSERT INTO harness_shared.work_items
                 (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, admission,
                  lane, payload, see_also, created_ts, updated_ts)
               VALUES (${WS}, ${HARNESS}, 'WI-referrer', 'Referrer', 'Preserve this incoming reference',
                       'open', 'bug', 'admitted', NULL, '{}'::jsonb, ARRAY['WI-loser'], ${NOW}, ${NOW})`,
    ],
  ])(
    'invalidates the judgement when an %s appears after judging',
    async (_label, mutate) => {
      await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 20_000 });
      await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: `promoter-reference-drift-${String(_label).replaceAll(' ', '-')}`,
        sql: db.sql,
        llmCall: async () => {
          await mutate();
          return {
            text: '',
            json: {
              judgements: [
                { pairKey: 'WI-canonical::WI-loser', verdict: 'r-finding-merge', reason: 'same finding and remedy' },
              ],
            },
            inputTokens: 100,
            outputTokens: 20,
          };
        },
        now: () => NOW,
      });
      expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1, guardRefusals: [{ reason: 'snapshot-drift' }] });
      expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    },
    60_000,
  );

  it('refuses a terminal canonical that has no applicable completion evidence', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', status: 'done', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-terminal-canonical-without-completion',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
      // A TARGETED run keeps the historical read, so the model judges the pair and the
      // persistence guard itself refuses the write. A scheduled tick never asks (WI-10004724;
      // see 'drops a pair whose counterpart is permanently unresolvable' below).
      targetItemIds: ['WI-canonical', 'WI-loser'],
    });
    expect(result).toMatchObject({
      promoted: 0,
      merged: 0,
      held: 1,
      guardRefusals: [{ reason: 'terminal-canonical-without-completion' }],
    });
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    const [loser] = await db.sql<Array<{ status: string }>>`
      SELECT status FROM harness_shared.work_items WHERE feature_id = 'WI-loser'`;
    expect(loser?.status).toBe('open');
  }, 60_000);

  describe('scheduled-tick prescreen (WI-10004724)', () => {
    const distinctCall = () =>
      vi.fn(async (input: { messages: Array<{ content: string }> }) => {
        const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
        return {
          text: '',
          json: { judgements: keys.map((pairKey) => ({ pairKey, verdict: 'distinct', reason: 'fixture distinct' })) },
          inputTokens: 100,
          outputTokens: 20,
        };
      });
    const promptKeys = (call: ReturnType<typeof distinctCall>, index = 0) =>
      [...call.mock.calls[index]![0].messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
    const admissionOf = async (id: string) =>
      (await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE feature_id = ${id}`)[0]?.admission;

    it.each(['pending', 'unreviewed'])('screens a %s reproduction-validation bug without granting implementation authority', async (admission) => {
      const agentReview = {
        status: 'revision-requested', revisionKind: 'reproduction',
        submittedBy: 'su-reporter', ledgerIdeaId: 'idea-validation', round: 1,
      };
      const implementationReadiness = {
        schemaVersion: 'implementation-readiness-v1', status: 'not-ready', source: 'agent-review',
        reason: 'fixture-reproduction-required', updatedAt: '2026-08-26T11:00:00.000Z',
      };
      await seedItem({ id: 'WI-existing', admission: 'admitted', createdAtMs: NOW - 20_000 });
      await seedItem({
        id: 'WI-validation', admission, createdAtMs: NOW - 10_000,
        payload: { agentReview, implementationReadiness },
      });
      const modelCall = distinctCall();
      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: `prescreen-validation-${admission}`,
        sql: db.sql, llmCall: modelCall, now: () => NOW,
      });

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(promptKeys(modelCall)).toEqual(['WI-existing::WI-validation']);
      expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, guardRefusals: [] });
      expect(result.prescreen).toMatchObject({ selected: 1, selfBlocked: 0, deferred: 0 });
      const [row] = await db.sql<Array<{ admission: string; payload: Record<string, unknown>; taken_by: string | null }>>`
        SELECT admission, payload, taken_by FROM harness_shared.work_items WHERE feature_id = 'WI-validation'`;
      expect(row).toMatchObject({ admission: 'admitted', taken_by: null, payload: { agentReview, implementationReadiness } });
      const claimInput = { payload: row!.payload, kind: 'bug', title: 'vitest clone failure', summary: 'same finding and same retry remedy', createdAtMs: NOW - 10_000 };
      expect(intakeStageAdmitsClaim(claimInput)).toBe(true);
      expect(implementationReadinessAdmitsClaim(claimInput)).toBe(false);
    }, 60_000);

    it('keeps a reproduction-validation duplicate pending when the destructive merge guard refuses it', async () => {
      const agentReview = {
        status: 'revision-requested', revisionKind: 'reproduction',
        submittedBy: 'su-reporter', ledgerIdeaId: 'idea-validation', round: 1,
      };
      await seedItem({ id: 'WI-existing', admission: 'admitted', createdAtMs: NOW - 20_000 });
      await seedItem({ id: 'WI-validation', payload: { agentReview }, createdAtMs: NOW - 10_000 });
      const modelCall = judgementCall('r-finding-merge');
      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'prescreen-validation-duplicate',
        sql: db.sql, llmCall: modelCall, now: () => NOW,
      });

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1, guardRefusals: [{ reason: 'review-gated' }] });
      const [row] = await db.sql<Array<{ admission: string; status: string; payload: Record<string, unknown> }>>`
        SELECT admission, status, payload FROM harness_shared.work_items WHERE feature_id = 'WI-validation'`;
      expect(row).toMatchObject({ admission: 'pending', status: 'open', payload: { agentReview } });
      expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
    }, 60_000);

    it('skips an older self-blocked re-review row and refills the batch with the row behind it', async () => {
      // Before the prescreen the oldest row took the only slot every tick, was refused
      // (review-gated), and the movable row behind it was never reached.
      await seedItem({
        id: 'WI-review-gated',
        title: 'Old re-review row',
        admission: 'unreviewed',
        createdAtMs: NOW - 90_000,
        vector: '[0,1,0]',
        payload: {
          agentReview: { status: 'revision-requested', submittedBy: 'su-author', ledgerIdeaId: 'idea-r', round: 1 },
        },
      });
      await seedItem({ id: 'WI-movable', title: 'Fresh distinct filing', createdAtMs: NOW - 10_000, vector: '[0,0,1]' });
      const modelCall = distinctCall();

      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'prescreen-self-blocked',
        sql: db.sql,
        llmCall: modelCall,
        batchSize: 1,
        now: () => NOW,
      });

      expect(modelCall).not.toHaveBeenCalled();
      expect(result).toMatchObject({ batchSize: 1, promoted: 1, held: 0, guardRefusals: [] });
      expect(result.prescreen).toMatchObject({ selected: 1, selfBlocked: 1, deferred: 0 });
      expect(result.prescreen?.samples).toContainEqual({
        itemId: 'WI-review-gated',
        class: 'self-blocked',
        reason: 'review-gated',
        blockedBy: null,
      });
      expect(await admissionOf('WI-movable')).toBe('admitted');
      expect(await admissionOf('WI-review-gated')).toBe('unreviewed');
      const [run] = await db.sql<Array<{ prescreen: { selfBlocked: number } }>>`
        SELECT detail->'prescreen' AS prescreen FROM harness_shared.admission_runs WHERE id = 'prescreen-self-blocked'`;
      expect(run?.prescreen.selfBlocked).toBe(1);
    }, 60_000);

    it('drops a pair whose counterpart is permanently unresolvable and promotes without a model call', async () => {
      await seedItem({ id: 'WI-remote-twin', admission: 'admitted', origin: 'remote', createdAtMs: NOW - 20_000 });
      await seedItem({ id: 'WI-local', admission: 'pending', createdAtMs: NOW - 10_000 });
      const modelCall = distinctCall();

      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'prescreen-unresolvable',
        sql: db.sql,
        llmCall: modelCall,
        now: () => NOW,
      });

      expect(modelCall).not.toHaveBeenCalled();
      expect(result).toMatchObject({ flaggedPairs: 0, promoted: 1, held: 0, guardRefusals: [] });
      expect(result.prescreen).toMatchObject({ unresolvablePairs: 1, protectedPairs: 0, forcedHolds: 0 });
      expect(await admissionOf('WI-local')).toBe('admitted');
      expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    }, 60_000);

    it('preserves a component screening opportunity without spending a batch slot on its protected twin', async () => {
      await seedItem({ id: 'WI-protected', title: 'component finding', admission: 'admitted', vector: '[1,0,0]', takenBy: 'su-holder', payload: { _claimHold: true }, createdAtMs: NOW - 40_000 });
      await seedItem({ id: 'WI-free', title: 'component finding', admission: 'admitted', vector: '[1,0,0]', createdAtMs: NOW - 30_000 });
      await seedItem({ id: 'WI-request', title: 'component finding', vector: '[1,0,0]', createdAtMs: NOW - 20_000 });
      await seedItem({ id: 'WI-unrelated', title: 'unrelated finding', vector: '[0,1,0]', createdAtMs: NOW - 10_000 });
      const input = { workspaceId: WS, harnessSlug: HARNESS, batchSize: 1,
        recentTerminalDays: 30, nowMs: NOW, componentScreeningItemIds: ['WI-request'] };
      const protectedWindow = await readPromoterWindow(db.sql, input);
      expect(protectedWindow.pendingRows.map((item) => item.id)).toEqual(['WI-unrelated']);
      expect(protectedWindow.forcedHolds.size).toBe(0);
      expect(protectedWindow.prescreen).toMatchObject({ selected: 1, deferred: 1 });

      await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, payload = payload - '_claimHold', updated_ts = updated_ts + 1
                    WHERE feature_id = 'WI-protected'`;
      const releasedWindow = await readPromoterWindow(db.sql, input);
      expect(releasedWindow.pendingRows.map((item) => item.id)).toEqual(['WI-request']);
      expect(releasedWindow.pairRows.map((pair) => pair.pairKey).sort()).toEqual([
        'WI-free::WI-request', 'WI-protected::WI-request',
      ]);
      expect(await admissionOf('WI-request')).toBe('pending');
    }, 90_000);

    describe.each(['agent', 'watchdog'] as const)('authenticated audited %s park comparison', creator => {
      const actor = 'su-f376159c-ff71-45aa-b34c-cded72705429';
      const reason = 'future independent source work';
      const readComparison = async () => (await db.sql`
        SELECT * FROM harness_shared.work_items WHERE feature_id = 'WI-parked'`)[0];
      const seedPark = async (id = 'WI-parked', admission = 'admitted') => {
        const releaseContract = { owner: actor, trigger: 'work-item:done:WI-canonical',
          condition: 'WI-canonical reaches done, then reconcile this duplicate.',
          evidence: 'canonical work item', reachability: 'reachable' };
        const payload = { _claimHold: true, _ei: creator === 'watchdog'
          ? { source: 'su', created_by: 'system:improvement-watchdog', found_during: 'improvement-watchdog' }
          : { source: 'su', created_by: actor },
          ...(creator === 'watchdog' ? { claim_hold_release: releaseContract } : {}),
          claim_hold_by: actor, claim_hold_reason: reason, claim_hold_at: new Date(NOW - 1000).toISOString() };
        await seedItem({ id, admission, takenBy: null, payload, createdAtMs: NOW - 10_000 });
        await db.sql`INSERT INTO harness_shared.audit_log (id, ts, workspace_id, actor, action, subject, details)
          VALUES (${id + '-audit'}, ${NOW - 992}, ${WS}, ${actor}, 'work_items:claim_hold:set', ${id},
            ${JSON.stringify({ mode: 'claim_hold', by: actor, reason,
              ...(creator === 'watchdog' ? { releaseContract } : {}) })}::text::jsonb)`;
        return readComparison();
      };
      const run = (llmCall: Parameters<typeof runWorkItemAdmissionPromoter>[0]['llmCall'], beforePersist?: () => Promise<void>) =>
        runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql,
          runId: 'authenticated-agent-park', now: () => NOW, llmCall,
          componentScreeningItemIds: ['WI-original'], beforePersist });

      it.each(['admitted', 'pending'])('advances only the distinct original against an audited %s park', async admission => {
        const before = await seedPark('WI-parked', admission);
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        const result = await run(distinctCall());
        expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, guardRefusals: [] });
        expect(await admissionOf('WI-original')).toBe('admitted');
        expect(await readComparison()).toEqual(before);
        expect(await db.sql`SELECT verdict FROM harness_shared.dedup_adjudications`).toEqual([{ verdict: 'distinct' }]);
        expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
        expect(await db.sql`SELECT 1 FROM harness_shared.coord_links`).toHaveLength(0);
      }, 60_000);

      it.each(['omitted', 'hold', 'r-related', 'r-remedy-keep', 'r-finding-merge', 'unknown'])('holds the original for %s without changing its park', async verdict => {
        const before = await seedPark();
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        const model = vi.fn(async () => ({ text: '', inputTokens: 10, outputTokens: 10,
          json: { judgements: verdict === 'omitted' ? [] : [{ pairKey: 'WI-original::WI-parked', verdict, reason: 'control' }] } }));
        if (verdict === 'unknown') await expect(run(model)).rejects.toThrow();
        else {
          const result = await run(model);
          expect(result.promoted).toBe(0); expect(result.merged).toBe(0);
        }
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(before);
        expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
        expect(await db.sql`SELECT 1 FROM harness_shared.coord_links`).toHaveLength(0);
      }, 60_000);

      it.each(['missing', 'foreign-workspace', 'wrong-actor', 'clear', 'wrong-reason'])('refuses %s canonical provenance before calling the model', async kind => {
        await seedPark();
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        if (kind === 'missing') await db.sql`DELETE FROM harness_shared.audit_log`;
        else if (kind === 'foreign-workspace') await db.sql`UPDATE harness_shared.audit_log SET workspace_id = 'other'`;
        else if (kind === 'wrong-actor') await db.sql`UPDATE harness_shared.audit_log SET actor = 'owner'`;
        else if (kind === 'clear') await db.sql`UPDATE harness_shared.audit_log SET action = 'work_items:claim_hold:clear'`;
        else await db.sql`UPDATE harness_shared.audit_log SET details = details || '{"reason":"forged"}'::jsonb`;
        const before = await readComparison(), model = distinctCall();
        const result = await run(model);
        expect(model).not.toHaveBeenCalled(); expect(result.promoted).toBe(0);
        expect(await readComparison()).toEqual(before);
      }, 60_000);

      it.each(['hold', 'payload', 'audit', 'claim', 'original-claim', 'dependency'])('refuses %s drift before persistence', async kind => {
        await seedPark();
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        const result = await run(distinctCall(), async () => {
          if (kind === 'audit') await db.sql`UPDATE harness_shared.audit_log SET details = details || '{"reason":"changed"}'::jsonb`;
          else if (kind === 'hold') await db.sql`UPDATE harness_shared.work_items SET payload = payload - '_claimHold' WHERE feature_id = 'WI-parked'`;
          else if (kind === 'payload') await db.sql`UPDATE harness_shared.work_items SET payload = payload || '{"newProof":true}'::jsonb WHERE feature_id = 'WI-parked'`;
          else if (kind === 'dependency') await db.sql`INSERT INTO harness_shared.work_item_deps
            (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
            VALUES (${WS}, 'issue', 'WI-parked', 'issue', 'WI-new-blocker', 'blocks', ${actor})`;
          else await db.sql`UPDATE harness_shared.work_items SET taken_by = ${actor}
            WHERE feature_id = ${kind === 'original-claim' ? 'WI-original' : 'WI-parked'}`;
        });
        expect(result.promoted).toBe(0); expect(result.merged).toBe(0);
        expect(result.guardRefusals).toContainEqual(expect.objectContaining({ reason: 'snapshot-drift' }));
        expect(await admissionOf('WI-original')).toBe('pending');
      }, 60_000);

      it.each([
        { name: 'ordinary-unauthenticated', noModel: false, targeted: false, authenticated: false },
        { name: 'targeted', noModel: false, targeted: true, authenticated: true },
        { name: 'no-model', noModel: true, targeted: false, authenticated: true },
      ])('does not extend park comparison authority to $name', async ({ noModel, targeted, authenticated }) => {
        const before = await seedPark();
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
          sql: db.sql, runId: 'park-without-authority', now: () => NOW, llmCall: distinctCall(), noModel,
          ...(authenticated ? { componentScreeningItemIds: ['WI-original'] } : {}),
          ...(targeted ? { targetItemIds: ['WI-original'] } : {}),
        });
        expect(result.promoted).toBe(0); expect(result.merged).toBe(0);
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(before);
      }, 60_000);

      it.each(['claimed', 'blocked', 'needs-human', 'review', 'owner', 'external', 'lease', 'policy'])('preserves the additional %s protection before model work', async kind => {
        await seedPark();
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        if (kind === 'claimed') await db.sql`UPDATE harness_shared.work_items SET taken_by = ${actor} WHERE feature_id = 'WI-parked'`;
        else if (kind === 'blocked' || kind === 'needs-human') await db.sql`UPDATE harness_shared.work_items SET status = ${kind} WHERE feature_id = 'WI-parked'`;
        else {
          const patch = kind === 'review' ? { agentReview: { status: 'pending', submittedBy: actor, ledgerIdeaId: 'idea', round: 1 } }
            : kind === 'owner' ? { needsOwnerAction: true }
            : kind === 'lease' ? { held_open_by: actor }
            : kind === 'policy' ? { claim_hold_reason: 'policy-tier approval' }
            : { externalBlockers: [{ kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit',
              ref: 'runtime:pending', summary: 'Runtime dependency', status: 'active',
              createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), createdBy: actor }] };
          await db.sql`UPDATE harness_shared.work_items SET payload = payload || ${JSON.stringify(patch)}::text::jsonb WHERE feature_id = 'WI-parked'`;
        }
        const before = await readComparison(), model = distinctCall();
        const result = await run(model);
        expect(model).not.toHaveBeenCalled(); expect(result.promoted).toBe(0);
        expect(await readComparison()).toEqual(before);
      }, 60_000);

      it('holds the original when one of two audited parks lacks a distinct judgment', async () => {
        await seedPark(); await seedPark('WI-second-park');
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        const result = await run(vi.fn(async () => ({ text: '', inputTokens: 10, outputTokens: 10,
          json: { judgements: [{ pairKey: 'WI-original::WI-parked', verdict: 'distinct', reason: 'one pair only' }] } })));
        expect(result.promoted).toBe(0); expect(await admissionOf('WI-original')).toBe('pending');
      }, 60_000);
    });

    describe('authenticated claimed comparison', () => {
      const readComparison = async () => (await db.sql`
        SELECT * FROM harness_shared.work_items WHERE feature_id = 'WI-comparison'`)[0];
      const seedComparison = async (admission = 'admitted') => {
        await seedItem({ id: 'WI-comparison', admission, takenBy: 'su-holder',
          payload: { checkpoint: 'independent proof remains pending' }, createdAtMs: NOW - 10_000 });
        await seedItem({ id: 'WI-original', createdAtMs: NOW - 20_000 });
        return readComparison();
      };
      const run = (llmCall: Parameters<typeof runWorkItemAdmissionPromoter>[0]['llmCall'], beforePersist?: () => Promise<void>) =>
        runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql,
          runId: 'authenticated-comparison', now: () => NOW, llmCall,
          componentScreeningItemIds: ['WI-original'], beforePersist });

      it.each(['admitted', 'pending'])('promotes a complete distinct result against a claimed %s neighbour without changing it', async (admission) => {
        const before = await seedComparison(admission);
        const modelCall = distinctCall();
        const result = await run(modelCall);
        expect(promptKeys(modelCall)).toEqual(['WI-comparison::WI-original']);
        expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, guardRefusals: [] });
        expect(await admissionOf('WI-original')).toBe('admitted');
        expect(await readComparison()).toEqual(before);
        expect(await db.sql`SELECT verdict FROM harness_shared.dedup_adjudications`).toEqual([{ verdict: 'distinct' }]);
        expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
        expect(await db.sql`SELECT 1 FROM harness_shared.coord_links`).toHaveLength(0);
      }, 60_000);

      it.each(['admitted', 'pending'])('holds a duplicate without merging either canonical direction (%s neighbour)', async (admission) => {
        const before = await seedComparison(admission);
        const modelCall = judgementCall('r-finding-merge');
        const result = await run(modelCall);
        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1 });
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(before);
        expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
        expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
      }, 60_000);

      it.each(['distinct', 'omitted'])('keeps an overdue claimed comparison read-only within the same window (%s result)', async (verdict) => {
        await seedComparison('unreviewed');
        await db.sql`UPDATE harness_shared.work_items SET payload = payload || ${JSON.stringify({
          admissionReview: { state: 'pending', reviewDueAt: new Date(NOW - 60_000).toISOString() },
        })}::text::jsonb WHERE feature_id = 'WI-comparison'`;
        const before = await readComparison();
        const modelCall = vi.fn(async () => ({ text: '', inputTokens: 10, outputTokens: 10,
          json: { judgements: verdict === 'omitted' ? [] : [{ pairKey: 'WI-comparison::WI-original', verdict, reason: 'complete distinct finding' }] } }));
        const result = await run(modelCall);
        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(result.promoted).toBe(verdict === 'distinct' ? 1 : 0);
        expect(await readComparison()).toEqual(before);
      }, 60_000);

      it.each(['omitted', 'hold', 'r-related', 'r-remedy-keep'])('keeps the original pending for a %s result without changing the claimed neighbour', async (verdict) => {
        const before = await seedComparison();
        const modelCall = vi.fn(async () => ({ text: '', inputTokens: 10, outputTokens: 10,
          json: { judgements: verdict === 'omitted' ? [] : [{ pairKey: 'WI-comparison::WI-original', verdict, reason: 'not a distinct finding' }] } }));
        const result = await run(modelCall);
        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1 });
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(before);
        expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
        expect(await db.sql`SELECT 1 FROM harness_shared.coord_links`).toHaveLength(0);
      }, 60_000);

      it.each(['payload', 'claim'])('refuses promotion when the comparison %s drifts during the model call', async (field) => {
        await seedComparison();
        const modelCall = distinctCall();
        let drifted = await readComparison();
        const result = await run(modelCall, async () => {
          if (field === 'payload') await db.sql`UPDATE harness_shared.work_items SET payload = payload || '{"newProof":true}'::jsonb, updated_ts = updated_ts + 1 WHERE feature_id = 'WI-comparison'`;
          else await db.sql`UPDATE harness_shared.work_items SET taken_by = 'su-new-holder', updated_ts = updated_ts + 1 WHERE feature_id = 'WI-comparison'`;
          drifted = await readComparison();
        });
        expect(modelCall).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ promoted: 0, merged: 0, guardRefusals: [{ itemId: 'WI-original', reason: 'snapshot-drift' }] });
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(drifted);
        expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
      }, 60_000);

      it('refuses a transitive merge into the original when its claimed comparison drifts', async () => {
        await seedComparison();
        await seedItem({ id: 'WI-peer', createdAtMs: NOW - 10_000 });
        const before = await db.sql`SELECT feature_id, payload, admission FROM harness_shared.work_items
          WHERE feature_id IN ('WI-original', 'WI-peer') ORDER BY feature_id`;
        const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
          sql: db.sql, runId: 'claimed-comparison-component-drift', now: () => NOW, batchSize: 1,
          componentScreeningItemIds: ['WI-original'],
          llmCall: async (input) => ({ text: '', inputTokens: 10, outputTokens: 10, json: { judgements:
            [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map(match => ({ pairKey: match[1]!,
              verdict: match[1]!.includes('WI-peer') ? 'r-finding-merge' : 'distinct', reason: 'component control' })) } }),
          beforePersist: async () => {
            await db.sql`UPDATE harness_shared.work_items SET payload = payload || '{"laterProof":true}'::jsonb,
              updated_ts = updated_ts + 1 WHERE feature_id = 'WI-comparison'`;
          },
        });
        expect(result).toMatchObject({ promoted: 0, merged: 0 });
        expect(result.guardRefusals).toContainEqual(expect.objectContaining({ itemId: 'WI-original', reason: 'snapshot-drift' }));
        expect(await db.sql`SELECT feature_id, payload, admission FROM harness_shared.work_items
          WHERE feature_id IN ('WI-original', 'WI-peer') ORDER BY feature_id`).toEqual(before);
        expect(await db.sql`SELECT 1 FROM harness_shared.work_item_occurrences`).toHaveLength(0);
      }, 60_000);

      it.each([
        { name: 'ordinary', noModel: false, targeted: false, authenticated: false },
        { name: 'no-model', noModel: true, targeted: false, authenticated: true },
        { name: 'targeted', noModel: false, targeted: true, authenticated: true },
      ])('does not extend read-only authority to the $name path', async ({ noModel, targeted, authenticated }) => {
        const before = await seedComparison();
        const modelCall = judgementCall('r-finding-merge');
        const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
          sql: db.sql, now: () => NOW, runId: 'comparison-without-authority', llmCall: modelCall, noModel,
          ...(authenticated ? { componentScreeningItemIds: ['WI-original'] } : {}),
          ...(targeted ? { targetItemIds: ['WI-original'] } : {}),
        });
        expect(result.promoted).toBe(0);
        expect(result.merged).toBe(0);
        expect(await admissionOf('WI-original')).toBe('pending');
        expect(await readComparison()).toEqual(before);
      }, 60_000);
    });

    it.each(['pending', 'unreviewed'] as const)('defers a row whose only twin is protected, holds one with a movable twin, and releases both when the protection lifts (%s)', async (admission) => {
      // alpha: the pending row's ONLY twin is claimed → deferred (no slot, no model).
      await seedItem({ id: 'WI-alpha-claimed', title: 'alpha finding', admission: 'admitted', vector: '[1,0,0]', takenBy: 'su-holder', createdAtMs: NOW - 50_000 });
      await seedItem({ id: 'WI-alpha-new', title: 'alpha finding', vector: '[1,0,0]', createdAtMs: NOW - 10_000 });
      // beta: one claimed twin + one movable twin → judged on the movable pair, then HELD.
      await seedItem({ id: 'WI-beta-claimed', title: 'beta finding', admission: 'admitted', vector: '[0,0,1]', takenBy: 'su-holder', createdAtMs: NOW - 40_000 });
      await seedItem({ id: 'WI-beta-free', title: 'beta finding', admission: 'admitted', vector: '[0,0,1]', createdAtMs: NOW - 30_000 });
      await seedItem({ id: 'WI-beta-new', title: 'beta finding', admission, vector: '[0,0,1]', createdAtMs: NOW - 5_000 });

      const first = distinctCall();
      const tick1 = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'prescreen-protected-1', sql: db.sql, llmCall: first, now: () => NOW,
      });
      expect(first).toHaveBeenCalledTimes(1);
      expect(promptKeys(first)).toEqual(['WI-beta-free::WI-beta-new']);
      expect(tick1).toMatchObject({ promoted: 0, held: 1, guardRefusals: [] });
      expect(tick1.prescreen).toMatchObject({ selected: 1, deferred: 1, protectedPairs: 2, forcedHolds: 1 });
      // Neither outcome advances lastRetryAt, so both enter the rotation ledger (WI-6554700010018072).
      expect([...(tick1.prescreen?.rotatedIds ?? [])].sort()).toEqual(['WI-alpha-new', 'WI-beta-new']);
      expect(await admissionOf('WI-alpha-new')).toBe('pending');
      expect(await admissionOf('WI-beta-new')).toBe(admission);
      const [held] = await db.sql`SELECT payload->'admissionHold' AS hold,
                                   payload#>>'{admissionReview,lastRetryAt}' AS retry
                                 FROM harness_shared.work_items
                                 WHERE feature_id = 'WI-beta-new'`;
      expect(held?.hold.screeningDeferred).toBe(true);
      expect(held?.retry).toBeNull();
      expect(
        await db.sql`SELECT verdict FROM harness_shared.dedup_adjudications WHERE a = 'WI-beta-free' AND b = 'WI-beta-new'`,
      ).toEqual([{ verdict: 'distinct' }]);

      // Unchanged state: both rows are now deferred and the tick spends NO model time.
      const second = distinctCall();
      const tick2 = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'prescreen-protected-2', sql: db.sql, llmCall: second, now: () => NOW,
      });
      expect(second).not.toHaveBeenCalled();
      expect(tick2).toMatchObject({ batchSize: 0, promoted: 0, held: 0 });
      expect(tick2.prescreen).toMatchObject({ selected: 0, deferred: 2 });

      // The claims end: nothing is memoized, so both rows re-enter and are judged at once.
      await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, updated_ts = updated_ts + 1
                    WHERE feature_id IN ('WI-alpha-claimed', 'WI-beta-claimed')`;
      const third = distinctCall();
      const tick3 = await runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'prescreen-protected-3', sql: db.sql, llmCall: third, now: () => NOW,
      });
      expect(promptKeys(third).sort()).toEqual(['WI-alpha-claimed::WI-alpha-new', 'WI-beta-claimed::WI-beta-new']);
      expect(tick3).toMatchObject({ promoted: 2, held: 0 });
      expect(await admissionOf('WI-alpha-new')).toBe('admitted');
      expect(await admissionOf('WI-beta-new')).toBe('admitted');
    }, 90_000);

    it('rotates structurally skipped rows behind unexamined ones so the window head cannot stall (WI-6554700010018072)', async () => {
      // Three pending rows whose ONLY twin is claimed: each is deferred on every tick and gets no
      // verdict that advances lastRetryAt. batchSize 1 makes the window 3 rows, so on the old
      // ordering they held the whole window on every tick and WI-fresh was never examined
      // (live 2026-10-20: the same 60 rows, 13 scheduled runs, 1 promotion).
      await seedItem({ id: 'WI-gate', title: 'gate finding', admission: 'admitted', vector: '[1,0,0]', takenBy: 'su-holder', createdAtMs: NOW - 60_000 });
      for (const [index, id] of ['WI-held-1', 'WI-held-2', 'WI-held-3'].entries()) {
        await seedItem({ id, title: 'gate finding', vector: '[1,0,0]', createdAtMs: NOW - 50_000 + index * 1_000 });
      }
      await seedItem({ id: 'WI-fresh', title: 'zebra telemetry outage', vector: '[0,1,0]', createdAtMs: NOW - 10_000 });
      const heldStamps = async () => db.sql<Array<{ feature_id: string; updated_ts: string }>>`
        SELECT feature_id, updated_ts FROM harness_shared.work_items
         WHERE feature_id LIKE 'WI-held-%' ORDER BY feature_id`;
      const tick = (runId: string) => runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId, sql: db.sql, llmCall: distinctCall(), now: () => NOW, batchSize: 1,
      });

      const before = await heldStamps();
      const tick1 = await tick('rotation-1');
      expect(tick1.prescreen).toMatchObject({
        window: 3, selected: 0, deferred: 3, rotatedIds: ['WI-held-1', 'WI-held-2', 'WI-held-3'],
      });
      expect(await admissionOf('WI-fresh')).toBe('pending');
      const [ledger] = await db.sql<Array<{ rotated: string[] }>>`
        SELECT detail #> '{prescreen,rotatedIds}' AS rotated FROM harness_shared.admission_runs WHERE id = 'rotation-1'`;
      expect(ledger?.rotated).toEqual(['WI-held-1', 'WI-held-2', 'WI-held-3']);

      // The ledger stamp sorts the deferred rows behind the never-examined row, which now gets
      // its turn — and the rotation wrote nothing to the deferred rows themselves.
      const tick2 = await tick('rotation-2');
      expect(tick2).toMatchObject({ promoted: 1 });
      expect(await admissionOf('WI-fresh')).toBe('admitted');
      expect(await heldStamps()).toEqual(before);

      // Outside the scheduled model window the ledger is ignored: a plain read keeps FIFO order.
      expect((await readPendingBatch(db.sql, WS, HARNESS, 3)).map((row) => row.id))
        .toEqual(['WI-held-1', 'WI-held-2', 'WI-held-3']);
    }, 90_000);

    it('rotates judged-held pending rows behind unexamined ones too (WI-6554700010029586)', async () => {
      // A judged hold on a still-PENDING row writes only admissionHold: lastRetryAt is stamped
      // for `unreviewed` rows only, and a judged hold is not a prescreen rotation. On the old
      // ordering the oldest held row led every window (live 2026-10-26: the same rows held on
      // 15-20 ticks in 24h while ~1,800 candidate rows behind them were never reviewed).
      await seedItem({ id: 'WI-judged-twin', title: 'gate finding', admission: 'admitted', vector: '[1,0,0]', createdAtMs: NOW - 60_000 });
      await seedItem({ id: 'WI-judged-held', title: 'gate finding', vector: '[1,0,0]', createdAtMs: NOW - 50_000 });
      await seedItem({ id: 'WI-fresh', title: 'zebra telemetry outage', vector: '[0,1,0]', createdAtMs: NOW - 10_000 });
      const holdCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
        const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
        return {
          text: '',
          json: { judgements: keys.map((pairKey) => ({ pairKey, verdict: 'hold' as const, reason: 'fixture ambiguous' })) },
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
        };
      });
      const tick = (runId: string) => runWorkItemAdmissionPromoter({
        workspaceId: WS, harnessSlug: HARNESS, runId, sql: db.sql, llmCall: holdCall, now: () => NOW, batchSize: 1,
      });

      const tick1 = await tick('judged-rotation-1');
      expect(tick1).toMatchObject({ promoted: 0, held: 1 });
      expect(await admissionOf('WI-judged-held')).toBe('pending');
      expect(await admissionOf('WI-fresh')).toBe('pending');
      const [ledger] = await db.sql<Array<{ held: Array<{ itemId: string }> | null; rotated: string[] | null }>>`
        SELECT detail -> 'heldReasons' AS held, detail #> '{prescreen,rotatedIds}' AS rotated
          FROM harness_shared.admission_runs WHERE id = 'judged-rotation-1'`;
      // The hold is judged, not structural: only heldReasons records it, and the row itself
      // carries no retry watermark.
      expect((ledger?.held ?? []).map((entry) => entry.itemId)).toEqual(['WI-judged-held']);
      expect(ledger?.rotated ?? []).not.toContain('WI-judged-held');
      const [heldRow] = await db.sql<Array<{ retry: string | null }>>`
        SELECT payload #>> '{admissionReview,lastRetryAt}' AS retry
          FROM harness_shared.work_items WHERE feature_id = 'WI-judged-held'`;
      expect(heldRow?.retry ?? null).toBeNull();

      // The heldReasons stamp sorts the judged row behind the never-reviewed one, which now gets
      // its turn although the model would hold the judged row again.
      const tick2 = await tick('judged-rotation-2');
      expect(tick2).toMatchObject({ promoted: 1 });
      expect(await admissionOf('WI-fresh')).toBe('admitted');
      expect(await admissionOf('WI-judged-held')).toBe('pending');
    }, 90_000);
  });

  it('allows a terminal canonical with applicable completion evidence', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', status: 'done', createdAtMs: NOW - 20_000 });
    await db.sql`
      UPDATE harness_shared.work_items
         SET terminal_completion_ref = 'verified by focused integration suite', authority = 'committed'
       WHERE feature_id = 'WI-canonical'`;
    await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-terminal-canonical-with-completion',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 0, merged: 1, held: 0, guardRefusals: [] });
    const [loser] = await db.sql<Array<{ status: string; canonical: string | null }>>`
      SELECT status, payload #>> '{admissionMerge,canonicalId}' AS canonical
        FROM harness_shared.work_items WHERE feature_id = 'WI-loser'`;
    expect(loser).toEqual({ status: 'dropped', canonical: 'WI-canonical' });
  }, 60_000);

  it('judges a pending counterpart against a completed twin with a retained runtime blocker', async () => {
    const blocker = {
      kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit',
      ref: 'runtime:completed-work', summary: 'Obsolete execution dependency', status: 'active',
      createdAt: new Date(NOW - 30_000).toISOString(), updatedAt: new Date(NOW - 30_000).toISOString(), createdBy: 'su-test',
    };
    await seedItem({
      id: 'WI-canonical', admission: 'admitted', status: 'done', createdAtMs: NOW - 20_000,
      authority: 'committed', payload: { externalBlockers: [blocker] },
    });
    await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
    const llmCall = judgementCall('r-finding-merge');
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS, harnessSlug: HARNESS, runId: 'promoter-terminal-runtime-blocker',
      sql: db.sql, llmCall, now: () => NOW,
    });
    expect(llmCall).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ promoted: 0, merged: 1, held: 0, guardRefusals: [] });
    const [loser] = await db.sql`
      SELECT status, payload #>> '{admissionMerge,canonicalId}' AS canonical
        FROM harness_shared.work_items WHERE feature_id = 'WI-loser'`;
    expect(loser).toEqual({ status: 'dropped', canonical: 'WI-canonical' });
    const [canonical] = await db.sql`
      SELECT payload->'externalBlockers' AS blockers FROM harness_shared.work_items WHERE feature_id = 'WI-canonical'`;
    expect(canonical.blockers).toEqual([blocker]);
    expect(await db.sql`SELECT verdict FROM harness_shared.dedup_adjudications`).toEqual([{ verdict: 'r-finding-merge' }]);
  }, 60_000);

  it('never merges or judges a loser that already participates in an active dependency', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction)
      VALUES (${WS}, 'issue', 'WI-dependent', 'issue', 'WI-loser', 'blocks', 'settled')`;
    const modelCall = judgementCall('r-finding-merge');
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-active-dependency',
      sql: db.sql,
      llmCall: modelCall,
      now: () => NOW,
    });
    // The same endpointProtection branch that refuses the write at persistence now skips the
    // row before any model call (WI-10004724). The persist-time refusal for a dependency that
    // appears AFTER judging is covered by 'invalidates the judgement when an incoming dependency…'.
    expect(modelCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ batchSize: 0, promoted: 0, merged: 0, held: 0, guardRefusals: [] });
    expect(result.prescreen).toMatchObject({ selfBlocked: 1 });
    expect(result.prescreen?.samples).toContainEqual({
      itemId: 'WI-loser',
      class: 'self-blocked',
      reason: 'active-dependency',
      blockedBy: null,
    });
    const [loser] = await db.sql<Array<{ status: string; admission: string }>>`
      SELECT status, admission FROM harness_shared.work_items WHERE feature_id = 'WI-loser'`;
    expect(loser).toEqual({ status: 'open', admission: 'pending' });
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
  }, 60_000);

  it('replays the same guarded merge idempotently without duplicating its occurrence or row mutation', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-loser', admission: 'pending', createdAtMs: NOW - 10_000 });
    const snapshots = await readAdmissionMergeSnapshots(db.sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      ids: ['WI-canonical', 'WI-loser'],
    });
    const pending = await readPendingBatch(db.sql, WS, HARNESS, 20);
    const plan = {
      dispositions: [{ itemId: 'WI-loser', action: 'merge' as const, canonicalId: 'WI-canonical' }],
      adjudications: [
        {
          pairKey: 'WI-canonical::WI-loser',
          verdict: 'r-finding-merge' as const,
          reason: 'same finding and remedy',
          a: 'WI-canonical',
          b: 'WI-loser',
          canonical: 'WI-canonical',
          signals: ['title-key' as const],
          cosine: 1,
        },
      ],
      relatedPairs: [],
    };
    const input = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-idempotent-persist',
      modelId: 'test-model',
      nowMs: NOW,
      pending,
      plan,
      snapshots: [...snapshots.values()],
    };

    const first = await persistAdmissionPlan(db.sql, input);
    const replay = await persistAdmissionPlan(db.sql, input);
    expect(first).toMatchObject({ mergedIds: ['WI-loser'], replayedIds: [], uniqueRowsChanged: 1 });
    expect(replay).toMatchObject({ mergedIds: [], replayedIds: ['WI-loser'], uniqueRowsChanged: 0 });
    const counts = await db.sql<Array<{ occurrences: number; adjudications: number; links: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.work_item_occurrences) AS occurrences,
             (SELECT count(*)::int FROM harness_shared.dedup_adjudications) AS adjudications,
             (SELECT cardinality(COALESCE(see_also, ARRAY[]::text[]))
                FROM harness_shared.work_items WHERE feature_id = 'WI-canonical') AS links`;
    expect(counts).toEqual([{ occurrences: 1, adjudications: 1, links: 1 }]);
  }, 60_000);

  it('promotes a zero-flag item without any model call', async () => {
    await seedItem({ id: 'WI-unique', title: 'uniquely worded isolated queue item', vector: null });
    const llmCall = vi.fn();
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-zero-flag',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });
    expect(result).toMatchObject({ flaggedPairs: 0, promoted: 1, merged: 0, modelCalled: false });
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('re-reviews a fail-open row, increments retry attempts, and clears its alert', async () => {
    await seedItem({ id: 'WI-unreviewed', admission: 'unreviewed', vector: null });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_build_object(
           'admissionFailOpen', jsonb_build_object('reason', 'pending-age-exceeded-two-promoter-ticks'),
           'admissionReview', jsonb_build_object(
             'state', 'pending',
             'enteredAt', '2026-08-26T10:00:00Z',
             'reviewDueAt', '2026-08-26T11:00:00Z',
             'retryOwner', 'system:work-item-admission-promoter',
             'retryAttempts', 0,
             'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
           )
         )
       WHERE feature_id = 'WI-unreviewed'`;

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-rereview',
      sql: db.sql,
      llmCall: vi.fn(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, modelCalled: false });
    const [row] = await db.sql<Array<{ admission: string; payload: Record<string, any> }>>`
      SELECT admission, payload FROM harness_shared.work_items WHERE feature_id = 'WI-unreviewed'`;
    expect(row).toMatchObject({
      admission: 'admitted',
      payload: {
        admissionReview: {
          state: 'reviewed',
          retryAttempts: 1,
          reviewedBy: 'system:work-item-admission-promoter',
          alert: { key: 'work-item-admission-review-debt', state: 'cleared' },
        },
      },
    });
  });

  describe('overdue claimed fail-open re-review (WI-6554700010008443)', () => {
    const overdueReview = {
      admissionReview: {
        state: 'pending',
        enteredAt: '2026-08-26T10:00:00Z',
        reviewDueAt: '2026-08-26T11:00:00Z',
        retryOwner: 'system:work-item-admission-promoter',
        retryAttempts: 0,
      },
    };

    it('gives a claimed overdue row a head turn, judges it, promotes a distinct verdict and advances its watermark', async () => {
      // Three older, never-retried unclaimed rows would win oldest-first; before the fix the claimed
      // row was also demoted last and then self-blocked as 'claimed', so it was never judged.
      // Distinct titles and no vectors: no row has a duplicate candidate, so the judgement is model-free.
      for (const [index, id] of ['WI-older-a', 'WI-older-b', 'WI-older-c'].entries()) {
        await seedItem({
          id,
          title: `unrelated older finding ${index}`,
          admission: 'unreviewed',
          vector: null,
          payload: overdueReview,
          createdAtMs: NOW - 90_000 + index,
        });
      }
      await seedItem({
        id: 'WI-claimed-rereview',
        title: 'claimed overdue finding',
        admission: 'unreviewed',
        vector: null,
        takenBy: 'su-worker',
        payload: overdueReview,
        createdAtMs: NOW - 10_000,
      });

      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'promoter-claimed-rereview',
        sql: db.sql,
        llmCall: vi.fn(),
        now: () => NOW,
        batchSize: 1,
      });

      expect(result).toMatchObject({ batchSize: 1, promoted: 1, merged: 0, held: 0 });
      const rows = await db.sql<Array<{ feature_id: string; admission: string; taken_by: string | null; payload: Record<string, any> }>>`
        SELECT feature_id, admission, taken_by, payload FROM harness_shared.work_items ORDER BY feature_id`;
      const byId = new Map(rows.map((row) => [row.feature_id, row]));
      expect(byId.get('WI-claimed-rereview')).toMatchObject({
        admission: 'admitted',
        taken_by: 'su-worker',
        payload: { admissionReview: { state: 'reviewed', retryAttempts: 1 } },
      });
      for (const id of ['WI-older-a', 'WI-older-b', 'WI-older-c']) {
        expect(byId.get(id)?.admission).toBe('unreviewed');
      }
    });

    it('re-reviews a claimed blocked overdue row without changing its blocked status', async () => {
      // The prescreen window is three rows. These older blocked rows would fill it if the
      // overdue blocked review lost its queue priority.
      for (const [index, id] of ['WI-blocked-older-a', 'WI-blocked-older-b', 'WI-blocked-older-c'].entries()) {
        await seedItem({
          id,
          title: `older blocked finding ${index}`,
          admission: 'unreviewed',
          status: 'blocked',
          vector: null,
          createdAtMs: NOW - 90_000 + index,
        });
      }
      await seedItem({
        id: 'WI-claimed-blocked-rereview',
        title: 'claimed blocked overdue finding',
        admission: 'unreviewed',
        status: 'blocked',
        vector: null,
        takenBy: 'su-worker',
        payload: overdueReview,
        createdAtMs: NOW - 10_000,
      });

      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'promoter-claimed-blocked-rereview',
        sql: db.sql,
        llmCall: vi.fn(),
        now: () => NOW,
        batchSize: 1,
      });

      expect(result).toMatchObject({ batchSize: 1, promoted: 1, merged: 0, held: 0, modelCalled: false });
      const rows = await db.sql<Array<{ feature_id: string; status: string; admission: string; taken_by: string | null; payload: Record<string, any> }>>`
        SELECT feature_id, status, admission, taken_by, payload FROM harness_shared.work_items ORDER BY feature_id`;
      const byId = new Map(rows.map((row) => [row.feature_id, row]));
      expect(byId.get('WI-claimed-blocked-rereview')).toMatchObject({
        status: 'blocked',
        admission: 'admitted',
        taken_by: 'su-worker',
        payload: { admissionReview: { state: 'reviewed', retryAttempts: 1 } },
      });
      for (const id of ['WI-blocked-older-a', 'WI-blocked-older-b', 'WI-blocked-older-c']) {
        expect(byId.get(id)?.admission).toBe('unreviewed');
      }
    });

    it.each([false, true])('re-reviews its own active review-debt blocker while retaining blocked lifecycle (qualified=%s)', async qualified => {
      const id = 'WI-self-review-debt';
      const debt = {
        ref: qualified ? `work-item-admission-review-debt:${id}` : 'work-item-admission-review-debt',
        kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit',
        status: 'active', summary: 'Waiting for this item admission review',
        createdAt: '2026-08-26T10:00:00Z', updatedAt: '2026-08-26T10:00:00Z', createdBy: 'su-worker',
      };
      await seedItem({ id, title: 'isolated self review debt', status: 'blocked', admission: 'unreviewed',
        vector: null, takenBy: 'su-worker', payload: { ...overdueReview, externalBlockers: [debt] } });

      const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
        runId: 'promoter-self-review-debt', sql: db.sql, llmCall: vi.fn(), now: () => NOW, batchSize: 1 });

      expect(result).toMatchObject({ promoted: 1, merged: 0, held: 0, modelCalled: false });
      const [row] = await db.sql<Array<{ status: string; admission: string; taken_by: string; payload: Record<string, any> }>>`
        SELECT status, admission, taken_by, payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(row).toMatchObject({ status: 'blocked', admission: 'admitted', taken_by: 'su-worker',
        payload: { admissionReview: { state: 'reviewed', retryAttempts: 1 }, externalBlockers: [debt] } });
    });

    it.each([
      { name: 'another runtime dependency', ref: 'runtime:other', kind: 'runtime', capability: 'live-dependency', reason: 'external-blocked' },
      { name: 'another item review debt', ref: 'work-item-admission-review-debt:WI-other', kind: 'runtime', capability: 'live-dependency', reason: 'external-blocked' },
      { name: 'a human product decision', ref: 'work-item-admission-review-debt', kind: 'human', capability: 'product-decision', reason: 'external-blocked' },
      { name: 'a runtime product decision', ref: 'work-item-admission-review-debt', kind: 'runtime', capability: 'product-decision', reason: 'external-blocked' },
      { name: 'a malformed runtime capability', ref: 'work-item-admission-review-debt', kind: 'runtime', capability: 'unsupported', reason: 'external-blocked' },
      { name: 'an owner credential', ref: 'work-item-admission-review-debt', kind: 'human', capability: 'credential', reason: 'owner-blocked' },
    ])('retains $name while reviewing blocked self-debt', async ({ ref, kind, capability, reason }) => {
      const id = 'WI-self-debt-protected';
      const debt = {
        ref: `work-item-admission-review-debt:${id}`, kind: 'runtime', capability: 'live-dependency',
        capabilitySource: 'explicit', status: 'active', summary: 'Waiting for own admission review',
        createdAt: '2026-08-26T10:00:00Z', updatedAt: '2026-08-26T10:00:00Z', createdBy: 'su-worker',
      };
      const payload = { ...overdueReview, externalBlockers: [debt, { ...debt, ref, kind, capability }] };
      await seedItem({ id, status: 'blocked', admission: 'unreviewed', takenBy: 'su-worker', vector: null, payload });
      const llmCall = vi.fn();
      const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
        runId: 'promoter-self-debt-protected', sql: db.sql, llmCall, now: () => NOW });

      expect(llmCall).not.toHaveBeenCalled();
      expect(result).toMatchObject({ promoted: 0, merged: 0, held: 0, prescreen: { selfBlocked: 1 } });
      expect(result.prescreen?.samples).toContainEqual({ itemId: id, class: 'self-blocked', reason, blockedBy: null });
      const [row] = await db.sql<Array<{ status: string; admission: string; taken_by: string; payload: Record<string, unknown> }>>`
        SELECT status, admission, taken_by, payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
      expect(row).toEqual({ status: 'blocked', admission: 'unreviewed', taken_by: 'su-worker', payload });
    });

    it.each(['r-remedy-keep', 'r-finding-merge'] as const)(
      'reviews blocked self-debt twins with %s while preserving their claims and merge protection', async verdict => {
        for (const id of ['WI-self-debt-a', 'WI-self-debt-b']) {
          await seedItem({ id, admission: 'unreviewed', status: 'blocked', takenBy: `su-${id}`, vector: '[1,0,0]',
            payload: { ...overdueReview, externalBlockers: [{
              ref: `work-item-admission-review-debt:${id}`, kind: 'runtime', capability: 'live-dependency',
              capabilitySource: 'explicit', status: 'active', summary: 'Waiting for own admission review',
              createdAt: '2026-08-26T10:00:00Z', updatedAt: '2026-08-26T10:00:00Z', createdBy: `su-${id}`,
            }] } });
        }
        const result = await runWorkItemAdmissionPromoter({ workspaceId: WS, harnessSlug: HARNESS,
          runId: 'promoter-self-debt-twins', sql: db.sql, llmCall: judgementCall(verdict), now: () => NOW });
        expect(result).toMatchObject({ modelCalled: true, merged: 0,
          promoted: verdict === 'r-remedy-keep' ? 2 : 0, held: verdict === 'r-remedy-keep' ? 0 : 2 });
        const rows = await db.sql<Array<{ feature_id: string; status: string; taken_by: string; payload: Record<string, any> }>>`
          SELECT feature_id, status, taken_by, payload FROM harness_shared.work_items ORDER BY feature_id`;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({ status: 'blocked', taken_by: `su-${row.feature_id}`,
            payload: { admissionReview: { retryAttempts: 1 }, externalBlockers: [{ status: 'active' }] } });
        }
        if (verdict === 'r-finding-merge') expect(await db.sql`SELECT * FROM harness_shared.dedup_adjudications`).toHaveLength(0);
      },
    );

    it('holds a claimed overdue row judged a duplicate: never merged, reason persisted, watermark advanced, pair left unadjudicated', async () => {
      await seedItem({ id: 'WI-canonical', admission: 'admitted', vector: '[1,0,0]', createdAtMs: NOW - 30_000 });
      await seedItem({
        id: 'WI-claimed-dup',
        admission: 'unreviewed',
        vector: '[1,0,0]',
        takenBy: 'su-worker',
        payload: overdueReview,
        createdAtMs: NOW - 20_000,
      });

      const result = await runWorkItemAdmissionPromoter({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'promoter-claimed-dup',
        sql: db.sql,
        llmCall: judgementCall('r-finding-merge'),
        now: () => NOW,
      });

      expect(result).toMatchObject({ promoted: 0, merged: 0, held: 1, modelCalled: true });
      const rows = await db.sql<Array<{ feature_id: string; status: string; admission: string; taken_by: string | null; payload: Record<string, any> }>>`
        SELECT feature_id, status, admission, taken_by, payload FROM harness_shared.work_items ORDER BY feature_id`;
      const byId = new Map(rows.map((row) => [row.feature_id, row]));
      expect(byId.get('WI-canonical')).toMatchObject({ status: 'open', admission: 'admitted' });
      const held = byId.get('WI-claimed-dup');
      expect(held).toMatchObject({
        status: 'open',
        admission: 'unreviewed',
        taken_by: 'su-worker',
        payload: {
          admissionReview: { state: 'pending', retryAttempts: 1 },
          admissionHold: { runId: 'promoter-claimed-dup' },
        },
      });
      expect(held?.payload.admissionHold.reason).toContain('duplicate of WI-canonical');
      expect(held?.payload.admissionReview.lastRetryAt).toEqual(expect.any(String));
      const adjudications = await db.sql`SELECT a, b FROM harness_shared.dedup_adjudications`;
      expect(adjudications).toHaveLength(0);
    });
  });

  it('persists a hold reason on a still-pending row and does not rewrite it while the reason is unchanged (WI-6554700010008443)', async () => {
    await seedItem({ id: 'WI-admitted-twin', admission: 'admitted', vector: '[1,0,0]', createdAtMs: NOW - 30_000 });
    await seedItem({ id: 'WI-pending-held', admission: 'pending', vector: '[1,0,0]', createdAtMs: NOW - 20_000 });
    const holdCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
      return {
        text: '',
        json: { judgements: keys.map((pairKey) => ({ pairKey, verdict: 'hold' as const, reason: 'fixture ambiguous' })) },
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
      };
    });
    const readHeld = async () => {
      const [row] = await db.sql<Array<{ admission: string; updated_ts: string; payload: Record<string, any> }>>`
        SELECT admission, updated_ts, payload FROM harness_shared.work_items WHERE feature_id = 'WI-pending-held'`;
      return row!;
    };

    const first = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-pending-hold-1',
      sql: db.sql,
      llmCall: holdCall,
      now: () => NOW,
    });
    expect(first).toMatchObject({ promoted: 0, merged: 0, held: 1 });
    const afterFirst = await readHeld();
    expect(afterFirst).toMatchObject({
      admission: 'pending',
      payload: { admissionHold: { reason: 'fixture ambiguous', runId: 'promoter-pending-hold-1' } },
    });

    await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-pending-hold-2',
      sql: db.sql,
      llmCall: holdCall,
      now: () => NOW + 60_000,
    });
    const afterSecond = await readHeld();
    expect(afterSecond.payload.admissionHold.runId).toBe('promoter-pending-hold-1');
    expect(String(afterSecond.updated_ts)).toBe(String(afterFirst.updated_ts));
  });

  it('terminalizes an unreviewed duplicate with a terminal review outcome', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', vector: '[1,0,0]' });
    await seedItem({ id: 'WI-unreviewed-duplicate', admission: 'unreviewed', vector: '[1,0,0]' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_build_object('admissionReview', jsonb_build_object(
           'state', 'pending', 'retryAttempts', 0,
           'enteredAt', '2026-08-26T10:00:00Z',
           'reviewDueAt', '2026-08-26T11:00:00Z',
           'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
         ))
       WHERE feature_id = 'WI-unreviewed-duplicate'`;
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-rereview-merge',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });

    expect(result).toMatchObject({ promoted: 0, merged: 1, held: 0, modelCalled: true });
    const [row] = await db.sql<Array<{ status: string; payload: Record<string, any> }>>`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = 'WI-unreviewed-duplicate'`;
    expect(row).toMatchObject({
      status: 'dropped',
      payload: {
        admissionReview: {
          state: 'terminal',
          retryAttempts: 1,
          terminalOutcome: 'duplicate-merge',
          alert: { key: 'work-item-admission-review-debt', state: 'cleared' },
        },
      },
    });
  });

  it('terminalizes a legacy-admission loser surfaced only through a transitive merge component', async () => {
    await seedItem({ id: 'WI-canonical', admission: 'admitted', createdAtMs: NOW - 30_000, vector: '[1,0,0]' });
    await seedItem({ id: 'WI-legacy-loser', admission: null, createdAtMs: NOW - 20_000, vector: '[1,0,0]' });
    await seedItem({ id: 'WI-pending-bridge', admission: 'pending', createdAtMs: NOW - 10_000, vector: '[1,0,0]' });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-transitive-legacy',
      sql: db.sql,
      llmCall: judgementCall('r-finding-merge'),
      now: () => NOW,
    });

    expect(result).toMatchObject({ batchSize: 1, promoted: 0, merged: 2, held: 0, modelCalled: true });
    const rows = await db.sql<
      Array<{
        feature_id: string;
        status: string;
        admission: string | null;
        terminal_reason: string | null;
        payload: Record<string, any> | null;
      }>
    >`
      SELECT feature_id, status, admission, terminal_reason, payload
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ feature_id: 'WI-canonical', status: 'open', admission: 'admitted' });
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({
        status: 'dropped',
        admission: 'admitted',
        terminal_reason: expect.stringContaining('duplicate of WI-canonical'),
        payload: {
          admissionMerge: {
            canonicalId: 'WI-canonical',
            runId: 'promoter-transitive-legacy',
            actor: 'system:work-item-admission-promoter',
          },
        },
      });
    }
  });

  it('keeps and cross-links an R-remedy pair', async () => {
    await seedItem({ id: 'WI-1', summary: 'remedy: intake lease' });
    await seedItem({ id: 'WI-2', summary: 'remedy: refractory window' });
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-remedies',
      sql: db.sql,
      llmCall: judgementCall('r-remedy-keep'),
      now: () => NOW,
    });
    expect(result).toMatchObject({ promoted: 2, merged: 0 });
    const rows = await db.sql<Array<{ feature_id: string; admission: string; see_also: string[] }>>`
      SELECT feature_id, admission, see_also FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-1', admission: 'admitted', see_also: ['WI-2'] },
      { feature_id: 'WI-2', admission: 'admitted', see_also: ['WI-1'] },
    ]);
  });

  // EI-21728201456300634 / EI-21866311570152646: the ticking promoter's own census-rise
  // alarm fired "major bug" TWICE on a run whose writer did nothing wrong. Root cause was a
  // TOCTOU race — censusBefore/censusAfter are two non-atomic reads of a workspace-wide,
  // continuously-growing count, separated by real time (the LLM call). Reproduce that race
  // deterministically: insert an unrelated dedup_edges row (simulating another agent's
  // concurrently-created near-duplicate items) INSIDE the mocked llmCall, so it lands exactly
  // between censusBefore and censusAfter, exactly as it would in production.
  it('does not flag a concurrent dedup_edges insert from organic corpus growth, even though the raw census rises', async () => {
    await seedItem({ id: 'WI-1', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-2', createdAtMs: NOW - 19_000 });
    const llmCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      await db.sql`
        INSERT INTO harness_shared.dedup_edges (workspace_id, harness_slug, a, b, cos, run_id)
        VALUES (${WS}, ${HARNESS}, 'WI-concurrent-a', 'WI-concurrent-b', 0.97, 'concurrent-edge-run')`;
      const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
      return {
        text: '',
        json: {
          judgements: keys.map((pairKey) => ({
            pairKey,
            verdict: 'r-finding-merge' as const,
            reason: 'fixture verdict',
          })),
        },
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-organic-growth',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    // The precondition that caused the false alarms genuinely reproduces here.
    expect(result.censusAfter).toBeGreaterThan(result.censusBefore);
    // ...yet the writer correctly retired the one pair it actually judged, so the targeted
    // signal — the only thing that should ever alarm — stays clean.
    expect(result.merged).toBe(1);
    expect(result.writerCoverageGap).toEqual([]);
  });

  // A `hold` verdict is a deliberate "still needs review" — persistAdmissionPlan intentionally
  // never writes a dedup_adjudications row for it (work-items-admission-promoter.ts:1170,1184).
  // That must never register as a writer defect: held pairs are excluded from
  // plan.adjudications entirely, so they can never appear in writerCoverageGap.
  it('does not flag a hold verdict as a writer coverage gap', async () => {
    await seedItem({ id: 'WI-1', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-2', createdAtMs: NOW - 19_000 });
    const llmCall = vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
      return {
        text: '',
        json: {
          judgements: keys.map((pairKey) => ({ pairKey, verdict: 'hold' as const, reason: 'ambiguous' })),
        },
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-hold',
      sql: db.sql,
      llmCall,
      now: () => NOW,
    });

    expect(result.held).toBe(2);
    expect(result.writerCoverageGap).toEqual([]);
    const adjudications = await db.sql`SELECT a, b FROM harness_shared.dedup_adjudications`;
    expect(adjudications).toHaveLength(0);
  });

  it('judgedPairsMissingAdjudication reports only pairs with no dedup_adjudications row', async () => {
    await db.sql`
      INSERT INTO harness_shared.dedup_adjudications
        (workspace_id, harness_slug, a, b, verdict, canonical, judged_by, run_id, evidence)
      VALUES (${WS}, ${HARNESS}, 'WI-1', 'WI-2', 'r-finding-merge', 'WI-1', 'model', 'run-x', '{}'::jsonb)`;

    const gap = await judgedPairsMissingAdjudication(db.sql, WS, HARNESS, [
      { pairKey: admissionPairKey('WI-1', 'WI-2'), a: 'WI-1', b: 'WI-2' },
      { pairKey: admissionPairKey('WI-3', 'WI-4'), a: 'WI-3', b: 'WI-4' },
    ]);

    expect(gap).toEqual([admissionPairKey('WI-3', 'WI-4')]);
    expect(await judgedPairsMissingAdjudication(db.sql, WS, HARNESS, [])).toEqual([]);
  });

  it('admits only rows older than two ticks and alarms when the promoter is killed', async () => {
    await seedItem({ id: 'WI-old', createdAtMs: NOW - 61 * 60_000, vector: null });
    await seedItem({ id: 'WI-fresh', createdAtMs: NOW - 59 * 60_000, vector: null });
    await db.sql`
      INSERT INTO harness_shared.routines (id, install_slug, workspace_id, name, active, created_at)
      VALUES ('rt-promoter', ${HARNESS}, ${WS}, ${WORK_ITEM_ADMISSION_PROMOTER}, false,
              to_timestamp(${NOW - 4 * 60 * 60_000} / 1000.0))`;

    const onNewlyAdmitted = vi.fn(async (rows: readonly { id: string; harness: string }[]) => {
      const stored = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-old'`;
      expect(stored[0]?.admission).toBe('unreviewed');
      expect(rows).toEqual([{ id: 'WI-old', harness: HARNESS }]);
    });
    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-killed',
      sql: db.sql,
      now: () => NOW,
      onNewlyAdmitted,
    });
    expect(result.autoPromoted).toEqual(['WI-old']);
    expect(onNewlyAdmitted).toHaveBeenCalledOnce();
    expect(result.liveness).toMatchObject({ stale: true, reason: 'promoter routine is inactive' });
    expect(result.reviewDebt).toMatchObject({ pending: 1, overdue: 1, reReviewed: 0, stillOpen: 0, terminal: 0 });
    const rows = await db.sql<Array<{ feature_id: string; admission: string; payload: Record<string, unknown> }>>`
      SELECT feature_id, admission, payload FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-fresh', admission: 'pending', payload: {} },
      {
        feature_id: 'WI-old',
        admission: 'unreviewed',
        payload: expect.objectContaining({
          admissionReview: expect.objectContaining({
            state: 'pending',
            retryOwner: 'system:work-item-admission-promoter',
            retryAttempts: 0,
            alert: expect.objectContaining({ key: 'work-item-admission-review-debt', state: 'open' }),
          }),
        }),
      },
    ]);
  });

  it.each(['harness', 'workspace'] as const)('keeps unresolved duplicate candidates and degraded dedup rows pending during %s fail-open', async (scope) => {
    await seedItem({ id: 'WI-plain-old', createdAtMs: NOW - 61 * 60_000, vector: null });
    await seedItem({
      id: 'WI-candidate-old',
      createdAtMs: NOW - 62 * 60_000,
      vector: null,
      payload: { dedupCandidates: [{ id: 'WI-canonical', similarity: 0.94, method: 'semantic-hard' }] },
    });
    await seedItem({
      id: 'WI-degraded-old',
      createdAtMs: NOW - 63 * 60_000,
      vector: null,
      payload: { dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true } },
    });
    await seedItem({
      id: 'WI-checked-old', createdAtMs: NOW - 61 * 60_000, vector: null,
      payload: { dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false } },
    });
    const onNewlyAdmitted = vi.fn(async (_rows: readonly { id: string; harness: string }[]) => {});

    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: `fail-open-duplicate-guard-${scope}`,
      sql: db.sql,
      now: () => NOW,
      scope,
      onNewlyAdmitted,
    });

    expect(result.autoPromoted).toEqual(['WI-checked-old', 'WI-plain-old']);
    expect(onNewlyAdmitted).toHaveBeenCalledWith(expect.arrayContaining([
      { id: 'WI-checked-old', harness: HARNESS },
      { id: 'WI-plain-old', harness: HARNESS },
    ]));
    const rows = await db.sql<Array<{ feature_id: string; admission: string; payload: Record<string, unknown> }>>`
      SELECT feature_id, admission, payload
        FROM harness_shared.work_items
       WHERE feature_id IN ('WI-plain-old', 'WI-candidate-old', 'WI-degraded-old')
       ORDER BY feature_id`;
    expect(rows).toEqual([
      {
        feature_id: 'WI-candidate-old',
        admission: 'pending',
        payload: { dedupCandidates: [{ id: 'WI-canonical', similarity: 0.94, method: 'semantic-hard' }] },
      },
      {
        feature_id: 'WI-degraded-old',
        admission: 'pending',
        payload: { dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true } },
      },
      {
        feature_id: 'WI-plain-old',
        admission: 'unreviewed',
        payload: expect.objectContaining({ admissionFailOpen: expect.any(Object) }),
      },
    ]);
  });

  it('binds fail-open receipts to their exact producing runs even when timestamps coincide', async () => {
    const legacyReceipt = { actor: 'system:work-item-admission-fail-open', at: new Date(NOW).toISOString() };
    await seedItem({ id: 'WI-legacy-run', admission: 'unreviewed', payload: { admissionFailOpen: legacyReceipt } });
    const run = (runId: string) => runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId,
      sql: db.sql,
      now: () => NOW,
      onNewlyAdmitted: async () => {},
    });

    await seedItem({ id: 'WI-run-a', createdAtMs: NOW - 61 * 60_000, vector: null });
    expect((await run('fail-open-exact-a')).autoPromoted).toEqual(['WI-run-a']);
    await seedItem({ id: 'WI-run-b', createdAtMs: NOW - 61 * 60_000, vector: null });
    expect((await run('fail-open-exact-b')).autoPromoted).toEqual(['WI-run-b']);

    const rows = await db.sql<Array<{
      feature_id: string;
      receipt: { at: string; runId?: string };
      producing_run: string | null;
      producing_runtime: Record<string, unknown> | null;
    }>>`
      SELECT wi.feature_id, wi.payload->'admissionFailOpen' AS receipt,
             ar.id AS producing_run, ar.detail->'producingRuntime' AS producing_runtime
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.admission_runs ar
          ON ar.workspace_id = wi.workspace_id
         AND ar.id = wi.payload #>> '{admissionFailOpen,runId}'
       WHERE wi.workspace_id = ${WS} AND wi.harness_slug = ${HARNESS}
       ORDER BY wi.feature_id`;
    expect(rows.map(({ feature_id, producing_run }) => ({ feature_id, producing_run }))).toEqual([
      { feature_id: 'WI-legacy-run', producing_run: null },
      { feature_id: 'WI-run-a', producing_run: 'fail-open-exact-a' },
      { feature_id: 'WI-run-b', producing_run: 'fail-open-exact-b' },
    ]);
    expect(rows[0]!.receipt).toEqual(legacyReceipt); // no guessed historical backfill
    expect(rows[1]!.receipt.at).toBe(rows[2]!.receipt.at); // timestamps cannot identify this producer
    expect(rows[1]!.receipt.runId).toBe('fail-open-exact-a'); // the second tick preserves the first receipt
    for (const row of rows.slice(1)) {
      expect(row.producing_runtime).toMatchObject({ schemaVersion: 1, pid: process.pid });
    }
  });

  it('caps each fail-open update at the oldest eligible rows', async () => {
    const firstCreatedAt = NOW - 2 * 60 * 60_000;
    const count = DEFAULT_FAIL_OPEN_BATCH_SIZE + 1;
    for (let index = 0; index < count; index += 1) {
      await seedItem({
        id: `WI-fail-open-batch-${String(index).padStart(3, '0')}`,
        createdAtMs: firstCreatedAt + index,
        vector: null,
      });
    }

    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-bounded-batch',
      sql: db.sql,
      now: () => NOW,
    });

    expect(result.autoPromoted).toHaveLength(DEFAULT_FAIL_OPEN_BATCH_SIZE);
    const pending = await db.sql<Array<{ feature_id: string; admission: string }>>`
      SELECT feature_id, admission
        FROM harness_shared.work_items
       WHERE admission = 'pending'
       ORDER BY created_ts ASC, feature_id ASC`;
    expect(pending).toEqual([{
      feature_id: `WI-fail-open-batch-${String(count - 1).padStart(3, '0')}`,
      admission: 'pending',
    }]);
    const [run] = await db.sql<Array<{ batch_size: number }>>`
      SELECT batch_size FROM harness_shared.admission_runs WHERE id = 'fail-open-bounded-batch'`;
    expect(run?.batch_size).toBe(DEFAULT_FAIL_OPEN_BATCH_SIZE);
  });

  it('admits the full run through bounded statements when a large UPDATE exceeds the write budget', async () => {
    for (let index = 0; index <= DEFAULT_FAIL_OPEN_BATCH_SIZE; index += 1) {
      await seedItem({ id: `WI-write-budget-${String(index).padStart(3, '0')}`,
        createdAtMs: NOW - 2 * 60 * 60_000 + index, vector: null });
    }
    // A deterministic PostgreSQL statement budget, rather than a timing assertion:
    // the old 100-row UPDATE fails; independently committed small statements pass.
    await db.sql.unsafe(`
      CREATE FUNCTION harness_shared.fail_open_statement_budget() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (SELECT count(*) FROM changed_rows) > 5 THEN
          RAISE EXCEPTION 'fail-open statement write budget exceeded' USING ERRCODE = '57014';
        END IF;
        RETURN NULL;
      END; $fn$;
      CREATE TRIGGER fail_open_statement_budget AFTER UPDATE ON harness_shared.work_items
        REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT
        EXECUTE FUNCTION harness_shared.fail_open_statement_budget();
    `).simple();
    try {
      const announced: string[] = [];
      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'fail-open-write-budget', sql: db.sql, now: () => NOW,
        onNewlyAdmitted: async (rows) => { announced.push(...rows.map((row) => row.id)); },
      });
      expect(result.autoPromoted).toHaveLength(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      expect([...announced].sort()).toEqual(result.autoPromoted);
      expect(new Set(announced).size).toBe(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      const pending = await db.sql`SELECT feature_id FROM harness_shared.work_items
        WHERE admission = 'pending' ORDER BY feature_id`;
      expect(pending.map((row) => row.feature_id)).toEqual([
        `WI-write-budget-${String(DEFAULT_FAIL_OPEN_BATCH_SIZE).padStart(3, '0')}`,
      ]);
    } finally {
      await db.sql.unsafe('DROP TRIGGER fail_open_statement_budget ON harness_shared.work_items; DROP FUNCTION harness_shared.fail_open_statement_budget()').simple();
    }
  });

  it('retains and announces committed admission progress when a later write chunk fails', async () => {
    for (let index = 0; index <= DEFAULT_FAIL_OPEN_BATCH_SIZE; index += 1) {
      await seedItem({ id: `WI-partial-write-${String(index).padStart(3, '0')}`,
        createdAtMs: NOW - 2 * 60 * 60_000 + index, vector: null });
    }
    await db.sql.unsafe(`
      CREATE FUNCTION harness_shared.fail_open_later_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.feature_id = 'WI-partial-write-005' THEN
          RAISE EXCEPTION 'later admission write failed' USING ERRCODE = '57014';
        END IF;
        RETURN NEW;
      END; $fn$;
      CREATE TRIGGER fail_open_later_write BEFORE UPDATE ON harness_shared.work_items
        FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_open_later_write();
    `).simple();
    try {
      const announced: string[] = [];
      await expect(runWorkItemAdmissionFailOpen({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'fail-open-partial-write', sql: db.sql, now: () => NOW,
        onNewlyAdmitted: async (rows) => { announced.push(...rows.map((row) => row.id)); },
      })).rejects.toThrow();
      const admitted = await db.sql`SELECT feature_id, payload #>> '{admissionFailOpen,runId}' AS producer
        FROM harness_shared.work_items WHERE admission = 'unreviewed' ORDER BY feature_id`;
      expect(admitted).toEqual(Array.from({ length: 5 }, (_, index) => ({
        feature_id: `WI-partial-write-${String(index).padStart(3, '0')}`, producer: 'fail-open-partial-write',
      })));
      expect(announced).toEqual(admitted.map((row) => row.feature_id));
      const [receipt] = await db.sql`SELECT auto_promoted_unreviewed, detail,
          jsonb_typeof(detail->'committedItems') AS journal_type,
          jsonb_typeof(detail->'announcedCount') AS cursor_type
        FROM harness_shared.admission_runs WHERE id = 'fail-open-partial-write'`;
      expect(receipt).toMatchObject({ auto_promoted_unreviewed: 5, journal_type: 'array', cursor_type: 'number', detail: {
        status: 'failed', committedItemIds: announced,
        outcome: { successful: 5, uniqueRowsChanged: 5, rolledBack: null },
      } });
      await db.sql.unsafe('DROP TRIGGER fail_open_later_write ON harness_shared.work_items');
      const resume = () => runWorkItemAdmissionFailOpen({
        workspaceId: WS, harnessSlug: HARNESS, runId: 'fail-open-partial-write', sql: db.sql, now: () => NOW,
        onNewlyAdmitted: async (rows) => { announced.push(...rows.map((row) => row.id)); },
      });
      const resumed = await resume();
      expect(resumed.autoPromoted).toHaveLength(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      expect(announced).toHaveLength(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      expect(new Set(announced).size).toBe(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      // The same logical run keeps its original cap even across another replay.
      expect((await resume()).autoPromoted).toEqual(resumed.autoPromoted);
      expect(announced).toHaveLength(DEFAULT_FAIL_OPEN_BATCH_SIZE);
      const remaining = await db.sql`SELECT feature_id FROM harness_shared.work_items WHERE admission = 'pending'`;
      expect(remaining.map((row) => row.feature_id)).toEqual([
        `WI-partial-write-${String(DEFAULT_FAIL_OPEN_BATCH_SIZE).padStart(3, '0')}`,
      ]);
    } finally {
      await db.sql.unsafe('DROP TRIGGER IF EXISTS fail_open_later_write ON harness_shared.work_items; DROP FUNCTION harness_shared.fail_open_later_write()').simple();
    }
  });

  it('recovers notifications after admission committed but the announcer failed', async () => {
    await seedItem({ id: 'WI-notify-recovery', createdAtMs: NOW - 2 * 60 * 60_000, vector: null });
    const options = { workspaceId: WS, harnessSlug: HARNESS, runId: 'fail-open-notify-recovery', sql: db.sql, now: () => NOW };
    await expect(runWorkItemAdmissionFailOpen({ ...options,
      onNewlyAdmitted: async () => { throw new Error('notification unavailable'); },
    })).rejects.toThrow('notification unavailable');
    const [before] = await db.sql`SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-notify-recovery'`;
    expect(before?.admission).toBe('unreviewed');
    const announced: string[] = [];
    const result = await runWorkItemAdmissionFailOpen({ ...options,
      onNewlyAdmitted: async (rows) => { announced.push(...rows.map((row) => row.id)); },
    });
    expect(result.autoPromoted).toEqual(['WI-notify-recovery']);
    expect(announced).toEqual(['WI-notify-recovery']);
  });

  it('rolls back admission when its atomic progress journal cannot be written', async () => {
    await seedItem({ id: 'WI-journal-failure', createdAtMs: NOW - 2 * 60 * 60_000, vector: null });
    await db.sql.unsafe(`
      CREATE FUNCTION harness_shared.fail_open_journal_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.id = 'fail-open-journal-failure' AND NEW.detail ? 'committedItems' THEN
          RAISE EXCEPTION 'admission journal unavailable' USING ERRCODE = '57014';
        END IF;
        RETURN NEW;
      END; $fn$;
      CREATE TRIGGER fail_open_journal_write BEFORE UPDATE ON harness_shared.admission_runs
        FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_open_journal_write();
    `).simple();
    try {
      const announce = vi.fn(async () => undefined);
      await expect(runWorkItemAdmissionFailOpen({ workspaceId: WS, harnessSlug: HARNESS,
        runId: 'fail-open-journal-failure', sql: db.sql, now: () => NOW, onNewlyAdmitted: announce,
      })).rejects.toThrow();
      const [row] = await db.sql`SELECT admission FROM harness_shared.work_items WHERE feature_id = 'WI-journal-failure'`;
      expect(row?.admission).toBe('pending');
      expect(announce).not.toHaveBeenCalled();
    } finally {
      await db.sql.unsafe('DROP TRIGGER fail_open_journal_write ON harness_shared.admission_runs; DROP FUNCTION harness_shared.fail_open_journal_write()').simple();
    }
  });

  it('never fail-opens a row that carries a typed duplicate verdict (bug-inflow-one-problem-one-row-2026-10-18 SPEC-P-006-PROMOTE)', async () => {
    const createdAtMs = NOW - 2 * 60 * 60_000;
    await seedItem({ id: 'WI-dup-canonical', createdAtMs, vector: null, admission: 'auto' });
    await seedItem({ id: 'WI-dup-loser', createdAtMs: createdAtMs + 1, vector: null });
    await seedItem({ id: 'WI-dup-control', createdAtMs: createdAtMs + 2, vector: null });
    await db.sql`
      UPDATE harness_shared.work_items
         SET duplicate_of = 'WI-dup-canonical', duplicate_source = 'agent'
       WHERE feature_id = 'WI-dup-loser'`;

    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-skips-duplicate',
      sql: db.sql,
      now: () => NOW,
    });

    // The twin with no verdict is the control: same age, same harness, admitted.
    expect(result.autoPromoted).toEqual(['WI-dup-control']);
    const rows = await db.sql<Array<{ feature_id: string; admission: string; duplicate_of: string | null }>>`
      SELECT feature_id, admission, duplicate_of
        FROM harness_shared.work_items
       WHERE feature_id IN ('WI-dup-loser', 'WI-dup-control')
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-dup-control', admission: 'unreviewed', duplicate_of: null },
      { feature_id: 'WI-dup-loser', admission: 'pending', duplicate_of: 'WI-dup-canonical' },
    ]);
  });

  // The promoter is seeded per-harness by a hand-run script that defaults to the operator home
  // harness, so in practice only ONE harness ever has one. A harness-scoped fail-open therefore
  // guarantees liveness for that harness and silently starves every other one: measured
  // 2026-08-28, sb-devboard-hive held pending rows for 40.7h and email for ~2d with zero rows
  // ever admitted, while papercusp promoted normally throughout and no error was raised anywhere.
  describe('workspace-scoped fail-open', () => {
    it('rescues an over-age pending row in a harness that has no promoter of its own', async () => {
      await seedItem({ id: 'WI-home', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({ id: 'WI-neighbour', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-workspace',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.scope).toBe('workspace');
      expect(result.autoPromoted).toEqual(['WI-home', 'WI-neighbour']);
      expect(result.autoPromotedByHarness).toEqual({ [HARNESS]: ['WI-home'], email: ['WI-neighbour'] });
      const rows = await db.sql<Array<{ harness_slug: string; admission: string }>>`
        SELECT harness_slug, admission FROM harness_shared.work_items ORDER BY harness_slug`;
      expect(rows).toEqual([
        { harness_slug: 'email', admission: 'unreviewed' },
        { harness_slug: HARNESS, admission: 'unreviewed' },
      ]);
    });

    // Control: the widening must be the SCOPE doing the work, not the guard having gone blanket.
    it('leaves the neighbouring harness pending under the default harness scope', async () => {
      await seedItem({ id: 'WI-home', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({ id: 'WI-neighbour', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-harness-scope',
        sql: db.sql,
        now: () => NOW,
      });

      expect(result.scope).toBe('harness');
      expect(result.autoPromoted).toEqual(['WI-home']);
      expect(result.autoPromotedByHarness).toEqual({ [HARNESS]: ['WI-home'] });
      const [neighbour] = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE harness_slug = 'email'`;
      expect(neighbour).toEqual({ admission: 'pending' });
    });

    // A workspace sweep widens across harnesses inside ONE tenant — never across tenants.
    it('never crosses a workspace boundary', async () => {
      await seedItem({ id: 'WI-mine', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({
        id: 'WI-other-tenant',
        createdAtMs: NOW - 61 * 60_000,
        vector: null,
        harness: 'email',
        workspaceId: 'some-other-workspace',
      });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-tenant-isolation',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual(['WI-mine']);
      const [foreign] = await db.sql<Array<{ admission: string }>>`
        SELECT admission FROM harness_shared.work_items WHERE workspace_id = 'some-other-workspace'`;
      expect(foreign).toEqual({ admission: 'pending' });
    });

    it('applies harness and named-subject exceptions to admission and the held census', async () => {
      const old = NOW - 61 * 60_000;
      h.scopeTerms = {
        exact: [HARNESS],
        likePrefixes: [],
        exceptions: {
          exactHarnesses: ['recipe-app'],
          harnessLikePrefixes: [],
          plans: ['exception-plan'],
          goals: ['exception-goal'],
          workItems: ['WI-item-exception'],
        },
      };
      await seedItem({ id: 'WI-scope-home', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-harness-exception', harness: 'recipe-app', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-plan-exception', harness: 'email', sourcePlanSlug: 'exception-plan', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-goal-exception', harness: 'calendar', goalId: 'exception-goal', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-item-exception', harness: 'email', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-held', harness: 'work-scope-exception-unmatched', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-fresh-exception', harness: 'recipe-app', createdAtMs: NOW - 59 * 60_000, vector: null });
      await seedItem({
        id: 'WI-foreign-exception',
        harness: 'email',
        workspaceId: 'some-other-workspace',
        sourcePlanSlug: 'exception-plan',
        createdAtMs: old,
        vector: null,
      });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-work-scope-exceptions',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual([
        'WI-goal-exception',
        'WI-harness-exception',
        'WI-item-exception',
        'WI-plan-exception',
        'WI-scope-home',
      ]);
      expect(result.heldByScope).toEqual({ 'work-scope-exception-unmatched': 1 });
      const rows = await db.sql<Array<{ feature_id: string; admission: string }>>`
        SELECT feature_id, admission
          FROM harness_shared.work_items
         WHERE feature_id = ANY(${['WI-fresh-exception', 'WI-foreign-exception', 'WI-held']}::text[])
         ORDER BY feature_id`;
      expect(rows).toEqual([
        { feature_id: 'WI-foreign-exception', admission: 'pending' },
        { feature_id: 'WI-fresh-exception', admission: 'pending' },
        { feature_id: 'WI-held', admission: 'pending' },
      ]);
    });

    // Widening the harness axis must not weaken the age floor on the rows it newly reaches.
    it('still honours the two-tick age floor in the harnesses it newly reaches', async () => {
      await seedItem({ id: 'WI-neighbour-old', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });
      await seedItem({ id: 'WI-neighbour-fresh', createdAtMs: NOW - 59 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-age-floor',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual(['WI-neighbour-old']);
      const rows = await db.sql<Array<{ feature_id: string; admission: string }>>`
        SELECT feature_id, admission FROM harness_shared.work_items ORDER BY feature_id`;
      expect(rows).toEqual([
        { feature_id: 'WI-neighbour-fresh', admission: 'pending' },
        { feature_id: 'WI-neighbour-old', admission: 'unreviewed' },
      ]);
    });

    it.each([false, true])('does not admit or report terminal pending rows (scope policy: %s)', async (withPolicy) => {
      // The production scope-decision log is throttled once per harness/process.
      // Keep this census cohort separate from the following log-assertion case.
      const platformHome = `operator:terminal-control-${WS}`;
      const otherPot = 'terminal-control-other-pot';
      const old = NOW - 61 * 60_000;
      h.scopeTerms = withPolicy ? { exact: [HARNESS], likePrefixes: [] } : null;
      const terminalStates = ['done', 'dropped', 'deprecated', 'passed', 'failed', 'resolved', 'closed'];
      for (const harness of [HARNESS, platformHome, otherPot]) {
        for (const status of terminalStates) {
          await seedItem({
            id: `WI-terminal-${harness}-${status}`,
            status,
            harness,
            createdAtMs: old,
            vector: null,
            payload: { retainedTerminalReceipt: status },
          });
        }
      }
      await seedItem({ id: 'WI-live-home', createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-live-platform', harness: platformHome, createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-live-other', harness: otherPot, createdAtMs: old, vector: null });
      await seedItem({ id: 'WI-live-legacy', createdAtMs: old, vector: null });
      await db.sql`UPDATE harness_shared.work_items SET status = NULL WHERE feature_id = 'WI-live-legacy'`;
      const onNewlyAdmitted = vi.fn(async (_rows: readonly { id: string; harness: string }[]) => {});

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: `fail-open-terminal-control-${withPolicy}`,
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
        onNewlyAdmitted,
      });

      const expectedAdmitted = withPolicy
        ? ['WI-live-home', 'WI-live-legacy']
        : ['WI-live-home', 'WI-live-legacy', 'WI-live-other', 'WI-live-platform'];
      expect(result.autoPromoted).toEqual(expectedAdmitted);
      expect(onNewlyAdmitted).toHaveBeenCalledOnce();
      expect(onNewlyAdmitted.mock.calls[0]?.[0].map((row) => row.id).sort()).toEqual(expectedAdmitted);
      expect(result.heldByScope).toEqual(withPolicy ? { [otherPot]: 1, [platformHome]: 1 } : {});
      const [run] = await db.sql<Array<{ misHomed: unknown; held: unknown }>>`
        SELECT detail->'misHomedByScope' AS "misHomed", detail->'heldByScope' AS held
          FROM harness_shared.admission_runs WHERE id = ${`fail-open-terminal-control-${withPolicy}`}`;
      expect(run).toEqual({
        misHomed: withPolicy ? { [platformHome]: 1 } : {},
        held: withPolicy ? { [otherPot]: 1, [platformHome]: 1 } : {},
      });
      const terminalRows = await db.sql<Array<{
        status: string; admission: string; admitted_at: string | null; admitted_by: string | null;
        updated_ts: string; payload: Record<string, unknown>;
      }>>`
        SELECT status, admission, admitted_at, admitted_by, updated_ts, payload
          FROM harness_shared.work_items WHERE feature_id LIKE 'WI-terminal-%'`;
      expect(terminalRows).toHaveLength(terminalStates.length * 3);
      for (const row of terminalRows) {
        expect(row).toMatchObject({
          admission: 'pending', admitted_at: null, admitted_by: null,
          payload: { retainedTerminalReceipt: row.status },
        });
        expect(Number(row.updated_ts)).toBe(old);
        expect(row.payload).not.toHaveProperty('admissionReview');
        expect(row.payload).not.toHaveProperty('admissionFailOpen');
      }
    });

    // WI-10004723 (P-003): the work-scope hold must tell a mis-homed platform row apart from another
    // pot's deliberately held work. Measured 2026-10-01: 14 learning-loop alarms sat 6 days in
    // `operator:papercusp-workspace`, reported by every tick as a "deliberate hold".
    it('reports a held row in the platform non-pot harness as mis-homed, not as a deliberate hold', async () => {
      const platformHome = `operator:${WS}`;
      h.scopeTerms = { exact: [HARNESS], likePrefixes: [] };
      await seedItem({ id: 'WI-home', createdAtMs: NOW - 61 * 60_000, vector: null });
      await seedItem({ id: 'WI-misHomed', createdAtMs: NOW - 61 * 60_000, vector: null, harness: platformHome });
      await seedItem({ id: 'WI-other-pot', createdAtMs: NOW - 61 * 60_000, vector: null, harness: 'email' });

      const result = await runWorkItemAdmissionFailOpen({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'fail-open-mis-homed',
        sql: db.sql,
        now: () => NOW,
        scope: 'workspace',
      });

      expect(result.autoPromoted).toEqual(['WI-home']);
      expect(result.heldByScope).toEqual({ email: 1, [platformHome]: 1 });
      const [run] = await db.sql<Array<{ misHomed: unknown; held: unknown }>>`
        SELECT detail->'misHomedByScope' AS "misHomed", detail->'heldByScope' AS held
          FROM harness_shared.admission_runs WHERE id = 'fail-open-mis-homed'`;
      // Control: `email` is held too, but it is another pot's harness, so it is NOT mis-homed.
      expect(run).toEqual({ misHomed: { [platformHome]: 1 }, held: { email: 1, [platformHome]: 1 } });
      const notes = Object.fromEntries(h.scopeDecisions.map((d) => [d.harness ?? '', d.note ?? '']));
      expect(notes[platformHome]).toMatch(/^MIS-HOMED: 1 .*work_items:rehome/);
      expect(notes.email).toMatch(/deliberate hold/);
      expect(notes.email).not.toMatch(/MIS-HOMED/);
      // Neither held row is admitted; both stay pending (never deleted).
      const held = await db.sql<Array<{ feature_id: string; admission: string }>>`
        SELECT feature_id, admission FROM harness_shared.work_items
         WHERE feature_id <> 'WI-home' ORDER BY feature_id`;
      expect(held).toEqual([
        { feature_id: 'WI-misHomed', admission: 'pending' },
        { feature_id: 'WI-other-pot', admission: 'pending' },
      ]);
    });
  });

  it('serves the owner snapshot with real SQL filters, percentiles, trend, and latest-rise evidence', async () => {
    await seedItem({ id: 'WI-pending', admission: 'pending' });
    await seedItem({ id: 'WI-unreviewed', admission: 'unreviewed' });
    await seedItem({ id: 'WI-claimed-fast', admission: 'admitted' });
    await seedItem({ id: 'WI-claimed-slow', admission: 'admitted' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = CASE feature_id
           WHEN 'WI-unreviewed' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'pending',
             'enteredAt', '2026-08-26T10:00:00Z',
             'reviewDueAt', '2026-08-26T11:00:00Z',
             'retryAttempts', 0,
             'alert', jsonb_build_object('key', 'work-item-admission-review-debt', 'state', 'open')
           ))
           WHEN 'WI-claimed-fast' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'reviewed', 'reviewedAt', '2026-08-26T11:00:00Z'
           ))
           WHEN 'WI-claimed-slow' THEN jsonb_build_object('admissionReview', jsonb_build_object(
             'state', 'terminal', 'terminalAt', '2026-08-26T11:00:00Z', 'terminalOutcome', 'duplicate-merge'
           ))
           ELSE payload
         END
       WHERE feature_id IN ('WI-unreviewed', 'WI-claimed-fast', 'WI-claimed-slow')`;
    await db.sql`
      UPDATE harness_shared.work_items
         SET admitted_at = CASE feature_id
               WHEN 'WI-claimed-fast' THEN '2026-08-26T10:00:00Z'::timestamptz
               WHEN 'WI-claimed-slow' THEN '2026-08-26T11:00:00Z'::timestamptz
             END,
             first_claimed_at = CASE feature_id
               WHEN 'WI-claimed-fast' THEN '2026-08-26T10:00:01Z'::timestamptz
               WHEN 'WI-claimed-slow' THEN '2026-08-26T11:00:05Z'::timestamptz
             END
       WHERE workspace_id = ${WS}
         AND harness_slug = ${HARNESS}
         AND feature_id IN ('WI-claimed-fast', 'WI-claimed-slow')`;
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at,
         batch_size, promoted, merged, held, census_before, census_after,
         model_id, tokens_in, tokens_out, latency_ms, detail)
      VALUES
        ('census-old', ${WS}, ${HARNESS}, 'census', '2026-08-26T13:00:00Z', '2026-08-26T13:00:01Z',
         10, 0, 0, 0, 10, 7, NULL, 0, 0, 1000, '{"status":"complete"}'::jsonb),
        ('promoter-rise', ${WS}, ${HARNESS}, 'promoter-tick', '2026-08-26T14:00:00Z', '2026-08-26T14:00:02Z',
         4, 2, 1, 1, 7, 8, 'model-a', 100, 20, 2000,
         '{"status":"complete","modelCostUsd":0.0125}'::jsonb)`;

    const snapshot = await readWorkItemAdmissionSnapshot({
      workspaceId: WS,
      harnessSlug: HARNESS,
      kind: 'promoter-tick',
      state: 'complete',
      sql: db.sql,
    });

    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      id: 'promoter-rise',
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.0125,
      censusDelta: 1,
    });
    expect(snapshot.summary).toMatchObject({
      pending: 1,
      unreviewed: 1,
      promotedToFirstClaim: { sampleSize: 2, p50Ms: 3000, p95Ms: 4800 },
      latestCensus: { runId: 'promoter-rise', after: 8 },
      latestCensusRise: { runId: 'promoter-rise', delta: 1 },
      usage: {
        cap: 100,
        modelRuns: 1,
        inputTokens: 100,
        outputTokens: 20,
        pricedRuns: 1,
        unpricedRuns: 0,
        costUsd: 0.0125,
        pricedSubtotalUsd: 0.0125,
      },
      reviewDebt: {
        pending: 1,
        overdue: 1,
        reReviewed: 1,
        stillOpen: 1,
        terminal: 1,
        oldestAgeMs: expect.any(Number),
      },
    });
    expect(snapshot.censusTrend.map((point) => point.runId)).toEqual(['census-old', 'promoter-rise']);
    await expect(
      readWorkItemAdmissionProducerPressure({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql }),
    ).resolves.toMatchObject({
      source: 'p005-queue-health',
      level: 'normal',
      pending: 1,
      // The cumulative snapshot above retains the historical fixture samples;
      // current pressure only samples first claims within one liveness window.
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: null,
    });
  });

  it('restores producer capacity after terminal backlog drains without erasing historical latency (EI-25814378379068278)', async () => {
    for (const status of ['done', 'dropped', 'resolved']) await seedItem({ id: `EI-terminal-${status}`, status });
    await seedItem({ id: 'EI-observation' });
    await db.sql`UPDATE harness_shared.work_items SET lane = 'observation' WHERE feature_id = 'EI-observation'`;
    await seedItem({ id: 'EI-live' });
    await seedItem({ id: 'EI-old-slow', admission: 'admitted', status: 'done' });
    await seedItem({ id: 'EI-recent-fast', admission: 'admitted', status: 'done' });
    await db.sql`UPDATE harness_shared.work_items SET admitted_at = now() - interval '11 days',
      first_claimed_at = now() - interval '1 day' WHERE feature_id = 'EI-old-slow'`;
    await db.sql`UPDATE harness_shared.work_items SET admitted_at = now() - interval '3 minutes',
      first_claimed_at = now() - interval '1 minute' WHERE feature_id = 'EI-recent-fast'`;

    const health = await readWorkItemAdmissionQueueHealth({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    expect(health.pending).toBe(5);
    expect(health.promotedToFirstClaim.sampleSize).toBe(2);
    expect(health.promotedToFirstClaim.p95Ms).toBeGreaterThan(180 * 60_000);
    expect(health.producerPressure).toMatchObject({
      pending: 1, latencyWindowMs: 90 * 60_000,
      promotedToFirstClaim: { sampleSize: 1, p50Ms: 120_000, p95Ms: 120_000 },
    });
    await expect(readWorkItemAdmissionProducerPressure({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql }))
      .resolves.toMatchObject({ level: 'normal', pending: 1, maxIdeators: null });

    await db.sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = 'EI-live'`;
    await expect(readWorkItemAdmissionProducerPressure({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql }))
      .resolves.toMatchObject({ level: 'normal', pending: 0 });
    await db.sql`UPDATE harness_shared.work_items SET admitted_at = now() - interval '4 hours',
      first_claimed_at = now() - interval '1 minute' WHERE feature_id = 'EI-recent-fast'`;
    await expect(readWorkItemAdmissionProducerPressure({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql }))
      .resolves.toMatchObject({ level: 'deep', pending: 0, maxIdeators: 1 });
  });

  it('persists buffered fallback observations in the disposable promoter database (EI-25815421487979701)', async () => {
    const correlationId = '93cec0c7-780e-449c-8c49-236654daeb08';
    expect(observeFallback('admission.fixture-dependency', { eligible: 2, applied: 0, reason: 'fixture-probe' },
      { sql: db.sql, workspaceId: WS, correlationId })).toBe(true);
    expect(await flushFallbackObservations()).toMatchObject({ failed: 0 });
    const rows = await db.sql`SELECT eligible, applied, reason, correlation_id
      FROM harness_shared.fallback_observations WHERE mechanism = 'admission.fixture-dependency'`;
    expect(rows).toEqual([{ eligible: 2, applied: 0, reason: 'fixture-probe', correlation_id: correlationId }]);
  });

  it('rolls queue health up over the admission-pipeline population, never an unadmitted row payload (WI-10003692)', async () => {
    // Two rows that entered admission.
    await seedItem({ id: 'WI-pipeline-pending', admission: 'pending' });
    await seedItem({
      id: 'WI-pipeline-reviewed',
      admission: 'admitted',
      payload: { admissionReview: { state: 'reviewed', reviewedAt: '2026-08-26T11:00:00Z' } },
    });
    // Two rows that never entered admission (admission and admitted_at both NULL),
    // the shape of the ~140k live agent observations. Their payloads carry review
    // states that WOULD count if the rollup still read every row's payload: no
    // admissionReview writer produces this pairing, so counting them would be
    // both wrong and the ~4s detoast of the whole harness this item removed.
    await seedItem({
      id: 'EI-observation-reviewed',
      admission: null,
      payload: { admissionReview: { state: 'reviewed' }, note: 'x'.repeat(4096) },
    });
    await seedItem({
      id: 'EI-observation-terminal',
      admission: null,
      payload: { admissionReview: { state: 'terminal', terminalOutcome: 'duplicate-merge' } },
    });

    const snapshot = await readWorkItemAdmissionSnapshot({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });

    expect(snapshot.summary).toMatchObject({
      pending: 1,
      unreviewed: 0,
      reviewDebt: { pending: 0, reReviewed: 1, stillOpen: 1, terminal: 0 },
    });
  });

  it('starts every independent owner-snapshot read before any of them resolves', async () => {
    const started: string[] = [];
    const resolved: string[] = [];
    let releaseReads!: () => void;
    const readsHeld = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const controlledSql = new Proxy(db.sql, {
      apply(target, thisArg, args) {
        const query = Array.isArray(args[0]) ? (args[0] as string[]).join(' ') : '';
        const label = query.includes("ar.detail->>'status' AS recorded_state")
          ? 'runs'
          : query.includes('percentile_cont(0.50)')
            ? 'queue-health'
            : query.includes('active_dependency_refs AS MATERIALIZED')
              ? 'readiness-stock-flow'
              : query.includes('FROM harness_shared.work_item_occurrences')
                ? 'readiness-recurrence'
                : query.includes('ar.census_before IS NOT NULL')
                  ? 'census'
                  : null;
        if (label == null) return Reflect.apply(target, thisArg, args);
        let consumed: Promise<unknown> | undefined;
        const consume = () => {
          consumed ??= readsHeld.then(async () => {
            const result = await Reflect.apply(target, thisArg, args);
            resolved.push(label);
            return result;
          });
          if (!started.includes(label)) started.push(label);
          return consumed;
        };
        return {
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            consume().then(onFulfilled, onRejected),
        };
      },
    }) as typeof db.sql;

    const snapshotPromise = readWorkItemAdmissionSnapshot({
      workspaceId: WS,
      harnessSlug: HARNESS,
      sql: controlledSql,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let startAssertionError: unknown;
    try {
      expect([...started].sort()).toEqual(
        ['census', 'queue-health', 'readiness-stock-flow', 'runs'].sort(),
      );
      expect(resolved).toEqual([]);
    } catch (error) {
      startAssertionError = error;
    } finally {
      releaseReads();
    }

    await expect(snapshotPromise).resolves.toMatchObject({
      runs: [],
      censusTrend: [],
    });
    if (startAssertionError) throw startAssertionError;
    expect([...resolved].sort()).toEqual([...started].sort());
  });

  it('partitions readiness by precedence while keeping overlapping reasons and stock/flow evidence separate', async () => {
    const readiness = (status: 'ready' | 'unknown' | 'not-ready', updatedAt: string) => ({
      schemaVersion: 'implementation-readiness-v1',
      status,
      source: 'agent-review',
      reason: `fixture-${status}`,
      updatedAt,
    });
    await seedItem({
      id: 'WI-terminal',
      admission: 'admitted',
      status: 'done',
      authority: 'committed',
      closedTs: NOW - 1_000,
      payload: { implementationReadiness: readiness('ready', '2026-08-26T11:00:00.000Z') },
    });
    await seedItem({
      id: 'WI-active',
      admission: 'admitted',
      takenBy: 'su-worker',
      firstClaimedAt: '2026-08-26T11:30:00Z',
      payload: { implementationReadiness: readiness('ready', '2026-08-26T11:00:00.000Z') },
    });
    await seedItem({
      id: 'WI-revision',
      admission: 'admitted',
      payload: {
        agentReview: { status: 'revision-requested', submittedBy: 'su-author', ledgerIdeaId: 'idea-r', round: 1 },
        implementationReadiness: readiness('not-ready', '2026-08-26T11:10:00.000Z'),
      },
    });
    await seedItem({
      id: 'WI-review',
      admission: 'admitted',
      payload: {
        agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'idea-p', round: 1 },
        implementationReadiness: readiness('unknown', '2026-08-26T11:20:00.000Z'),
      },
    });
    await seedItem({
      id: 'WI-held',
      admission: 'admitted',
      payload: {
        _claimHold: true,
        implementationReadiness: readiness('ready', '2026-08-26T11:30:00.000Z'),
      },
    });
    await seedItem({
      id: 'WI-ready-legacy-revision',
      admission: 'admitted',
      expectedCostCents: 250,
      payload: {
        agentReview: {
          status: 'revision-requested',
          submittedBy: 'system:legacy-agent-review',
          ledgerIdeaId: 'idea-l',
          round: 1,
        },
        reopenHistory: [{ at: '2026-08-26T11:40:00.000Z', by: 'su-fixer', prevState: 'done' }],
      },
    });
    await seedItem({ id: 'WI-ready-unpriced', admission: 'admitted' });
    await seedItem({
      id: 'WI-unknown',
      admission: 'admitted',
      payload: { implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } },
    });
    // A `success` dependency remains active when its blocker is deprecated but
    // did not succeed. This pins the readiness projection to the writer's two
    // distinct settled-vs-success denominators instead of a generic terminal proxy.
    await seedItem({ id: 'F-blocker', itemKind: 'feature', admission: 'admitted', status: 'deprecated' });
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
      VALUES ('default', 'issue', 'WI-held', 'feature', ${`${HARNESS}#F-blocker`}, 'blocks', 'success', 'fixture')`;
    await db.sql`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool,
         report_kind, reported_title, evidence, admission_identity, occurred_at)
      VALUES
        (${WS}, ${HARNESS}, 'WI-ready-legacy-revision', 'su-a', 'improvements:capture',
         'canonical-created', 'ready', '{}'::jsonb, '{}'::jsonb, '2026-08-26T11:35:00Z'),
        (${WS}, ${HARNESS}, 'WI-ready-legacy-revision', 'su-b', 'improvements:capture',
         'regression', 'ready again', '{}'::jsonb, '{}'::jsonb, '2026-08-26T11:45:00Z')`;

    const projection = await readWorkItemReadinessProjection({
      workspaceId: WS,
      harnessSlug: HARNESS,
      sql: db.sql,
      now: () => NOW,
      windowDays: 30,
    });

    expect(projection.headline).toEqual({
      population: 8,
      nonTerminal: 7,
      terminal: 1,
      active: 1,
      awaitingRevision: 1,
      awaitingReview: 1,
      held: 1,
      ready: 2,
      unknown: 1,
    });
    expect(projection.reasons).toMatchObject({
      revisionRequestedAgentReview: 2,
      legacyRevisionException: 1,
      pendingAgentReview: 1,
      claimHold: 1,
      activeDependency: 1,
      readinessMalformed: 1,
    });
    expect(projection.flow).toMatchObject({
      arrivals: 8,
      terminalInWindow: 1,
      verifiedCompletionsInWindow: 0,
      retainedReopenEventsInWindow: 1,
      reopenedItemsInWindow: 1,
      readyExpectedCost: { coveredRows: 1, totalRows: 2, pricedSubtotalCents: 250, cents: null },
      recurrence: { canonicalClusters: 1, rawOccurrences: 2, duplicateOccurrences: 1 },
    });
    expect(projection.aging.neverClaimed.count).toBe(6);
    expect(projection.availability).toMatchObject({
      corpus: 'nonempty',
      writerReady: 'ready',
      claimSpec: 'not-evaluated',
      fleetControl: 'not-evaluated',
    });
    expect(
      projection.headline.terminal +
        projection.headline.active +
        projection.headline.awaitingRevision +
        projection.headline.awaitingReview +
        projection.headline.held +
        projection.headline.ready +
        projection.headline.unknown,
    ).toBe(projection.headline.population);
  });

  // bug-queue-legitimacy D-007/D-008 (P-010 category b): the revision-requested reason splits
  // into reproduction (claimable validation work) and content (the adopt-next discovery pool),
  // and with the legacy exception the three sum exactly to revisionRequestedAgentReview.
  it('splits revision-requested rows into an exact reproduction/content/legacy partition', async () => {
    const review = (submittedBy: string, revisionKind?: string) => ({
      agentReview: {
        status: 'revision-requested',
        submittedBy,
        ledgerIdeaId: `idea-${submittedBy}`,
        round: 1,
        ...(revisionKind ? { revisionKind } : {}),
      },
    });
    await seedItem({ id: 'WI-rev-repro', admission: 'admitted', itemKind: 'bug', payload: review('su-author', 'reproduction') });
    await seedItem({ id: 'WI-rev-content', admission: 'admitted', payload: review('su-author', 'content') });
    // A revision written before D-006 carries no revisionKind: it is a content revision.
    await seedItem({ id: 'WI-rev-pre-d006', admission: 'admitted', payload: review('su-author') });
    await seedItem({ id: 'WI-rev-legacy', admission: 'admitted', payload: review('system:legacy-agent-review') });
    await seedItem({ id: 'WI-rev-pending', admission: 'admitted', payload: { agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'idea-p', round: 1 } } });

    const projection = await readWorkItemReadinessProjection({
      workspaceId: WS,
      harnessSlug: HARNESS,
      sql: db.sql,
      now: () => NOW,
      windowDays: 30,
    });

    const r = projection.reasons;
    expect(r).toMatchObject({
      revisionRequestedAgentReview: 4,
      revisionReproductionValidation: 1,
      revisionContentAdoptionCandidates: 2,
      legacyRevisionException: 1,
      pendingAgentReview: 1,
    });
    expect(r.revisionReproductionValidation + r.revisionContentAdoptionCandidates + r.legacyRevisionException)
      .toBe(r.revisionRequestedAgentReview);
  });

  it('partitions accepted work once and matches the shared classifier without counting legacy or duplicate closes as delivery', async () => {
    const title = 'Repair trailing token';
    const summary = 'Parser loses the final token';
    const sealed = sealImplementationAcceptance({
      source: { kind: 'bug', title, summary },
      proposal: { problem: summary, evidence: ['parser.test.ts failure'], outcome: 'Preserve trailing token', scope: 'Parser only', completionCheck: 'Regression passes' },
      authority: { kind: 'agent-review', reviewer: 'reviewer', submittedBy: 'author', round: 1 },
      reason: 'independent reviewer accepted', acceptedAt: '2026-08-26T11:00:00.000Z',
      // P-006: a bug's acceptance carries its reproduction receipt.
      reproduction: { kind: 'failing-test', ref: 'parser.test.ts', buildSha: 'abcdef1' },
    });
    if (!sealed.ok) throw new Error('fixture must seal');
    const ready = createImplementationReadiness({ status: 'ready', source: 'agent-review', reason: 'accepted', updatedAt: '2026-08-26T11:00:00.000Z', evidence: { acceptance: sealed.contract } });
    const rows = [
      { id: 'ready', status: 'open', payload: { implementationReadiness: ready } },
      { id: 'active', status: 'open', assignee: 'worker', payload: { implementationReadiness: ready } },
      // Keeps accepted-ready (1) and accepted-active (2) unequal. With one of each, a writer that
      // counted one stage under the other's FILTER matched the classifier by arithmetic accident
      // (mutation probe 2026-10-01, test run 20440804: an active->ready FILTER swap survived).
      { id: 'active-2', status: 'open', assignee: 'worker-2', payload: { implementationReadiness: ready } },
      { id: 'blocked', status: 'open', payload: { implementationReadiness: ready, _claimHold: true } },
      { id: 'failed-retryable', status: 'failed', payload: { implementationReadiness: ready } },
      { id: 'delivered', status: 'done', completionAuthority: 'committed', payload: { implementationReadiness: ready } },
      { id: 'duplicate', status: 'deprecated', completionAuthority: 'committed', payload: { implementationReadiness: ready } },
      { id: 'legacy-close', status: 'done', completionAuthority: 'committed', payload: {} },
      { id: 'candidate', status: 'open', payload: { implementationReadiness: { ...ready, evidence: {} } } },
      { id: 'unknown', status: 'open', payload: {} },
      { id: 'stale', status: 'open', payload: { implementationReadiness: ready }, title: 'Changed problem' },
    ];
    for (const row of rows) await seedItem({
      id: row.id, title: row.title ?? title, summary, itemKind: 'bug', status: row.status,
      takenBy: row.assignee, payload: row.payload, authority: row.completionAuthority,
      closedTs: ['done','deprecated'].includes(row.status) ? NOW - 1000 : null, admission: 'admitted',
    });
    await seedItem({ id: 'foreign-workspace', title, summary, payload: { implementationReadiness: ready }, workspaceId: 'other' });
    await seedItem({ id: 'foreign-harness', title, summary, payload: { implementationReadiness: ready }, harness: 'other' });
    await seedItem({ id: 'observation', payload: { lane: 'observation' }, admission: 'admitted' });
    await db.sql`UPDATE harness_shared.work_items SET lane = 'observation' WHERE feature_id = 'observation'`;
    const actual = await readWorkItemReadinessProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql, now: () => NOW });
    const expected = countWorkItemPresentationStages(rows.map(row => ({ ...row, kind: 'bug', title: row.title ?? title, summary })));
    expect(actual.presentation).toEqual({ ...expected, writer: 'readWorkItemReadinessProjection', classifier: 'deriveWorkItemPresentationStage' });
    expect(actual.presentation?.population).toBe(actual.headline.population);
    expect(Object.values(actual.presentation!.counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(actual.presentation).toMatchObject({ remainingBugs: 5, verifiedCompletions: 1, counts: { 'terminal-other': 2, candidate: 2, observation: 0, 'accepted-ready': 1, 'accepted-active': 2 } });
    expect(actual.flow.verifiedCompletionsInWindow).toBe(1);
    expect(actual.scope).toMatchObject({ workspaceId: WS, harnessSlug: HARNESS, population: 'root issue-family rows excluding observation-lane records' });
  });

  it('keeps workspace-wide readiness set-based, primary-key indexable, and payload-narrow', () => {
    const source = readFileSync(new URL('./work-items-admission-promoter.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function readWorkItemReadinessProjection');
    const end = source.indexOf('export async function readWorkItemAdmissionSnapshot', start);
    const reader = source.slice(start, end);
    const store = readFileSync(new URL('./dbos/work-item-deps-store.ts', import.meta.url), 'utf8');
    const helperStart = store.indexOf('export function activeWorkItemDependencyRefsSql(');
    const helperEnd = store.indexOf('/** The issue-family endpoint kind', helperStart);
    const dependencyReader = store.slice(helperStart, helperEnd);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(reader).toContain('activeWorkItemDependencyRefsSql(sql, {');
    expect(reader).toContain('WITH occurrence_counts AS MATERIALIZED');
    expect(reader).toContain('active_dependency_refs AS MATERIALIZED');
    expect(reader).not.toContain('readIssueOccurrenceCounts(');
    expect(reader).toContain('wi.agent_review_projection AS agent_review');
    expect(reader).toContain('wi.implementation_readiness_projection AS implementation_readiness');
    expect(reader).toContain('wi.implementation_readiness_enrolled AS readiness_enrolled');
    expect(reader).toContain('wi.reopen_history_projection AS reopen_history');
    expect(reader).toContain('wi.external_blockers_projection AS external_blockers');
    expect(dependencyReader).toContain("blocker.harness_slug = split_part(d.blocker_ref, '#', 1)");
    expect(dependencyReader).toContain("blocker.feature_id = substring(d.blocker_ref from position('#' in d.blocker_ref) + 1)");
    expect(reader).toContain('LEFT JOIN active_dependency_refs dependency');
    expect(reader).not.toContain('jsonb_to_record');
    expect(reader).not.toContain('wi.payload');
    expect(reader).toContain('COALESCE(wi.claim_hold, FALSE)');
    expect(reader).toContain('COALESCE(wi.needs_owner_action, FALSE)');
    expect(reader).not.toContain("blocker.harness_slug || '#' || blocker.feature_id = d.blocker_ref");
    expect(dependencyReader).not.toContain("blocker.harness_slug || '#' || blocker.feature_id = d.blocker_ref");
    expect(reader).not.toMatch(/^\s*wi\.payload,\s*$/m);
    expect(reader).not.toContain("COALESCE(s.payload, '{}'::jsonb)");

    const draftMigration = new URL(
      '../../../libs/papercusp/libs/db/sql/1294-work-item-readiness-payload-projections.sql.DRAFT',
      import.meta.url,
    );
    const armedMigration = new URL(
      '../../../libs/papercusp/libs/db/sql/1294-work-item-readiness-payload-projections.sql',
      import.meta.url,
    );
    const migration = readFileSync(existsSync(draftMigration) ? draftMigration : armedMigration, 'utf8');
    for (const column of [
      'agent_review_projection',
      'implementation_readiness_projection',
      'implementation_readiness_enrolled',
      'reopen_history_projection',
      'external_blockers_projection',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(migration).toContain("NULLIF(payload -> 'implementationReadiness', 'null'::jsonb)");
    expect(migration).toContain("payload ? 'implementationReadiness'");
  });

  it('keeps stored readiness payload projections synchronized and preserves explicit JSON null presence', async () => {
    await seedItem({
      id: 'WI-generated-projections',
      payload: {
        agentReview: null,
        implementationReadiness: null,
        reopenHistory: null,
        externalBlockers: null,
      },
    });

    const [nullPayload] = await db.sql`
      SELECT agent_review_projection,
             implementation_readiness_projection,
             implementation_readiness_enrolled,
             reopen_history_projection,
             external_blockers_projection
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS}
         AND harness_slug = ${HARNESS}
         AND feature_id = 'WI-generated-projections'`;
    expect(nullPayload).toEqual({
      agent_review_projection: null,
      implementation_readiness_projection: null,
      implementation_readiness_enrolled: true,
      reopen_history_projection: null,
      external_blockers_projection: null,
    });

    const replacementPayload = {
      agentReview: { status: 'pending' },
      implementationReadiness: { schemaVersion: 'implementation-readiness-v1', status: 'ready' },
      reopenHistory: [],
      externalBlockers: [],
    };
    const updatedRows = await db.sql`
      UPDATE harness_shared.work_items
         SET payload = ${JSON.stringify(replacementPayload)}::text::jsonb
       WHERE workspace_id = ${WS}
         AND harness_slug = ${HARNESS}
         AND feature_id = 'WI-generated-projections'
      RETURNING payload,
                agent_review_projection,
                implementation_readiness_projection,
                implementation_readiness_enrolled,
                reopen_history_projection,
                external_blockers_projection`;
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]).toEqual({
      payload: replacementPayload,
      agent_review_projection: { status: 'pending' },
      implementation_readiness_projection: replacementPayload.implementationReadiness,
      implementation_readiness_enrolled: true,
      reopen_history_projection: [],
      external_blockers_projection: [],
    });
  });

  it('uses writer status over finished_at and keeps outcome totals unit-separated', async () => {
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at, batch_size,
         promoted, merged, held, detail)
      VALUES
        ('status-blocked', ${WS}, ${HARNESS}, 'daily-digest', now(), now(), 0, 0, 0, 0,
         '{"status":"blocked","blockedReason":"awaiting-bulk","outcome":{"unit":"links","attempted":0,"successful":0,"rolledBack":0,"unchanged":0,"uniqueRowsChanged":0,"blockedReason":"awaiting-bulk"}}'::jsonb),
        ('status-failed', ${WS}, ${HARNESS}, 'bulk-stage', now(), now(), 7, 0, 0, 0,
         '{"status":"failed","error":"transport down","outcome":{"unit":"pairs","attempted":7,"successful":null,"rolledBack":null,"unchanged":null,"uniqueRowsChanged":null,"failureReason":"transport down"}}'::jsonb),
        ('status-invalid', ${WS}, ${HARNESS}, 'census', now(), now(), 2, 0, 0, 0,
         '{"status":"future-status"}'::jsonb)`;

    const snapshot = await readWorkItemAdmissionSnapshot({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    expect(snapshot.runs.map((run) => [run.id, run.state, run.stateSource])).toEqual(
      expect.arrayContaining([
        ['status-blocked', 'blocked', 'writer'],
        ['status-failed', 'failed', 'writer'],
        ['status-invalid', 'failed', 'invalid-writer'],
      ]),
    );
    expect(snapshot.runs.find((run) => run.id === 'status-blocked')?.outcome.blockedReason).toBe('awaiting-bulk');
    expect(snapshot.runs.find((run) => run.id === 'status-failed')?.outcome.failureReason).toBe('transport down');
    expect(snapshot.summary.runCounts.byUnit?.links?.runs).toBe(1);
    expect(snapshot.summary.runCounts.byUnit?.pairs?.runs).toBe(1);
    expect(snapshot.summary.runCounts.byUnit?.snapshots?.runs).toBe(1);
  });
});

describe('readPendingBatch resolver-input priority (P-006)', () => {
  async function seedPending(input: {
    id: string;
    createdAtMs: number;
    dedupCandidates?: unknown;
    dedupCoverageDegraded?: boolean;
  }): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.dedupCandidates !== undefined) payload.dedupCandidates = input.dedupCandidates;
    if (input.dedupCoverageDegraded !== undefined) {
      payload.dedupCoverage = { lexical: 'ok', semantic: 'ok', degraded: input.dedupCoverageDegraded };
    }
    // sql.json() — NOT `${JSON.stringify(payload)}::jsonb` — per the documented
    // postgres-js gotcha (_pg-helpers.ts header, dock-layouts.ts): on this
    // production-faithful client config, the JSON.stringify+cast form
    // double-encodes to a jsonb STRING (jsonb_typeof=string), which silently
    // defeats every `payload -> 'key'` predicate (a string has no keys, so
    // `IS NOT NULL` reads false for every row and the priority boost never
    // fires — reproduced + root-caused via a standalone script before this fix).
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         admission, condition_key, lane, payload, created_ts, updated_ts)
      VALUES (${WS}, ${HARNESS}, ${input.id}, 'title', 'summary', 'open', 'bug',
              'pending', NULL, NULL, ${db.sql.json(payload as unknown as Parameters<typeof db.sql.json>[0])},
              ${input.createdAtMs}, ${input.createdAtMs})`;
  }

  it('orders candidate-stamped rows first, then dedupCoverage.degraded rows, then plain FIFO', async () => {
    // Seeded OLDEST-first by id so a plain created_ts order would read WI-1..WI-4 — the
    // priority boost must override that for the stamped/degraded rows regardless.
    await seedPending({ id: 'WI-1', createdAtMs: NOW - 40_000 }); // plain, oldest
    await seedPending({ id: 'WI-2', createdAtMs: NOW - 30_000, dedupCoverageDegraded: true }); // degraded
    await seedPending({ id: 'WI-3', createdAtMs: NOW - 20_000 }); // plain, newer than WI-1
    await seedPending({
      id: 'WI-4',
      createdAtMs: NOW - 10_000, // youngest of all, but candidate-stamped
      dedupCandidates: [{ id: 'WI-9', similarity: 0.91, method: 'semantic-hard' }],
    });

    const batch = await readPendingBatch(db.sql, WS, HARNESS, 10);
    // WI-4 (candidate-stamped) first; WI-2 (degraded) second; then plain FIFO WI-1, WI-3.
    expect(batch.map((item) => item.id)).toEqual(['WI-4', 'WI-2', 'WI-1', 'WI-3']);
  });

  it('an EMPTY dedupCandidates array is not stamped by the writers and does not boost', async () => {
    // dedup-candidates-stamp.ts is explicit: the key is written ONLY when non-empty. A row
    // whose payload carries `dedupCandidates: []` (e.g. a hand-authored fixture, or a future
    // writer regression) must still be readable as "no candidates" via the boost, not as a
    // false positive — `IS NOT NULL` on an empty JSON array is still true, so this guards the
    // one shape that predicate CANNOT distinguish and documents it as an accepted edge rather
    // than a silent surprise.
    await seedPending({ id: 'WI-5', createdAtMs: NOW - 20_000 });
    await seedPending({ id: 'WI-6', createdAtMs: NOW - 10_000, dedupCandidates: [] });
    const batch = await readPendingBatch(db.sql, WS, HARNESS, 10);
    // An empty array still satisfies `IS NOT NULL`, so WI-6 sorts first — recorded here as
    // the KNOWN behaviour (both writers only ever stamp non-empty, per dedup-candidates-
    // stamp.ts's contract) rather than left for a reader to rediscover by surprise.
    expect(batch.map((item) => item.id)).toEqual(['WI-6', 'WI-5']);
  });

  it('prioritizes component screening only in the ordinary model window and keeps peer guards first', async () => {
    await seedPending({ id: 'WI-old', createdAtMs: NOW - 30_000 });
    await seedPending({ id: 'WI-recovery', createdAtMs: NOW - 20_000 });
    await seedPending({ id: 'WI-peer', createdAtMs: NOW - 10_000 });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'live-peer' WHERE feature_id = 'WI-peer'`;
    const opts = { demoteGuardBlocked: true, componentScreeningItemIds: ['WI-recovery', 'WI-peer'] };
    expect((await readPendingBatch(db.sql, WS, HARNESS, 3, undefined, opts)).map((r) => r.id))
      .toEqual(['WI-recovery', 'WI-old', 'WI-peer']);
    expect((await readPendingBatch(db.sql, WS, HARNESS, 3)).map((r) => r.id))
      .toEqual(['WI-old', 'WI-recovery', 'WI-peer']);
    expect((await readPendingBatch(db.sql, WS, HARNESS, 3, undefined, { ...opts, preferModelFree: true })).map((r) => r.id))
      .toEqual(['WI-old', 'WI-recovery', 'WI-peer']);
    expect((await readPendingBatch(db.sql, WS, HARNESS, 3, ['WI-old', 'WI-recovery'], opts)).map((r) => r.id))
      .toEqual(['WI-old', 'WI-recovery']);
  });

  it('ranks an authenticated component-screening request ahead of the unbounded overdue re-review lead (EI-26286722843068668)', async () => {
    // Live 2026-10-20: 121 claimed overdue re-review rows led a 60-row window, so a hinted row
    // ranked below them never entered it and the scope-held recovery stayed pending.
    for (const [index, id] of ['WI-lead-a', 'WI-lead-b', 'WI-lead-c'].entries()) {
      await seedPending({ id, createdAtMs: NOW - 50_000 + index * 10_000 });
    }
    await db.sql`
      UPDATE harness_shared.work_items
         SET admission = 'unreviewed', taken_by = 'su-worker',
             payload = payload || jsonb_build_object('admissionReview', jsonb_build_object(
               'state', 'pending', 'retryAttempts', 0, 'reviewDueAt', '2026-08-26T11:00:00Z'))
       WHERE feature_id LIKE 'WI-lead-%'`;
    await seedPending({ id: 'WI-hint', createdAtMs: NOW - 20_000 });
    await seedPending({ id: 'WI-hint-peer', createdAtMs: NOW - 10_000 });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'live-peer' WHERE feature_id = 'WI-hint-peer'`;
    const read = (batch: number, hints?: string[]) =>
      readPendingBatch(db.sql, WS, HARNESS, batch, undefined,
        { demoteGuardBlocked: true, ...(hints ? { componentScreeningItemIds: hints } : {}) })
        .then((rows) => rows.map((row) => row.id));

    expect(await read(2)).toEqual(['WI-lead-a', 'WI-lead-b']);
    expect(await read(2, ['WI-hint', 'WI-hint-peer'])).toEqual(['WI-hint', 'WI-lead-a']);
    // A peer's valid claim still demotes its hinted row behind everything unblocked.
    expect(await read(5, ['WI-hint', 'WI-hint-peer']))
      .toEqual(['WI-hint', 'WI-lead-a', 'WI-lead-b', 'WI-lead-c', 'WI-hint-peer']);
  });

  it('rotates scheduled ambiguous reviews behind never-reviewed and less-recently reviewed rows', async () => {
    await seedPending({ id: 'WI-repeat', createdAtMs: NOW - 30_000, dedupCandidates: [{ id: 'WI-twin' }] });
    await seedPending({ id: 'WI-earlier-review', createdAtMs: NOW - 20_000 });
    await seedPending({ id: 'WI-never-reviewed', createdAtMs: NOW - 10_000 });
    await db.sql`
      UPDATE harness_shared.work_items
         SET admission = 'unreviewed', payload = payload || jsonb_build_object('admissionReview',
           CASE feature_id
             WHEN 'WI-repeat' THEN jsonb_build_object('state', 'pending', 'retryAttempts', 176,
               'lastRetryAt', to_jsonb(to_timestamp(${NOW - 1_000} / 1000.0)))
             WHEN 'WI-earlier-review' THEN jsonb_build_object('state', 'pending', 'retryAttempts', 1,
               'lastRetryAt', to_jsonb(to_timestamp(${NOW - 10_000} / 1000.0)))
             ELSE jsonb_build_object('state', 'pending', 'retryAttempts', 0)
           END)`;
    const next = () => readPendingBatch(db.sql, WS, HARNESS, 2, undefined, { demoteGuardBlocked: true });
    expect((await next()).map((item) => item.id)).toEqual(['WI-never-reviewed', 'WI-earlier-review']);
    await db.sql`
      UPDATE harness_shared.work_items SET payload = payload || jsonb_build_object('admissionReview',
        jsonb_build_object('state', 'pending', 'retryAttempts', 1, 'lastRetryAt', to_jsonb(to_timestamp(${NOW} / 1000.0))))
       WHERE feature_id = 'WI-never-reviewed'`;
    expect((await next()).map((item) => item.id)).toEqual(['WI-earlier-review', 'WI-repeat']);
    // Explicit target reads retain resolver candidate/FIFO priority.
    expect((await readPendingBatch(db.sql, WS, HARNESS, 2,
      ['WI-repeat', 'WI-earlier-review', 'WI-never-reviewed'])).map((item) => item.id))
      .toEqual(['WI-repeat', 'WI-earlier-review']);
  });

  it('treats malformed retry timestamps as unmeasured and retains model-free candidate priority', async () => {
    await seedPending({ id: 'WI-retried', createdAtMs: NOW - 20_000, dedupCandidates: [{ id: 'WI-twin' }] });
    await seedPending({ id: 'WI-malformed', createdAtMs: NOW - 10_000 });
    await db.sql`
      UPDATE harness_shared.work_items SET admission = 'unreviewed',
        payload = payload || jsonb_build_object('admissionReview', jsonb_build_object('state', 'pending',
          'lastRetryAt', CASE WHEN feature_id = 'WI-malformed' THEN '2026-02-31T12:00:00Z'
                             ELSE '2026-08-26T10:00:00Z' END))`;
    expect((await readPendingBatch(db.sql, WS, HARNESS, 2, undefined,
      { demoteGuardBlocked: true })).map((item) => item.id)).toEqual(['WI-malformed', 'WI-retried']);
    // The no-model path still prioritizes rows it can resolve without judging.
    await db.sql`
      UPDATE harness_shared.work_items SET payload = payload - 'dedupCandidates'
       WHERE feature_id = 'WI-retried'`;
    await db.sql`
      UPDATE harness_shared.work_items SET payload = payload || '{"dedupCandidates":[{"id":"WI-twin"}]}'::jsonb
       WHERE feature_id = 'WI-malformed'`;
    expect((await readPendingBatch(db.sql, WS, HARNESS, 2, undefined,
      { demoteGuardBlocked: true, preferModelFree: true })).map((item) => item.id))
      .toEqual(['WI-retried', 'WI-malformed']);
  });
});

// WI-10004725 / plan work-queue-bulk-cleanup-remediation-2026-10-01 P-007. Measured 2026-10-01:
// 1,084 of papercusp's 2,176 fail-open rows still "owed" a duplication review although their item
// was already terminal, and the LLM spend pause stopped the only path that promotes rows without a
// model, so the debt could only grow.
describe('review-debt policy (P-007): moot terminal reviews and the no-model pass', () => {
  const PENDING_REVIEW = {
    admissionFailOpen: { reason: 'pending-age-exceeded-two-promoter-ticks' },
    admissionReview: {
      state: 'pending',
      enteredAt: '2026-08-26T10:00:00Z',
      reviewDueAt: '2026-08-26T11:00:00Z',
      retryOwner: 'system:work-item-admission-promoter',
      retryAttempts: 0,
      alert: { key: 'work-item-admission-review-debt', state: 'open' },
    },
  };

  async function reviewRow(id: string) {
    const [row] = await db.sql<Array<{ admission: string; status: string; payload: Record<string, any> }>>`
      SELECT admission, status, payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
    return row!;
  }

  it('closes a terminal row\'s owed review as review-moot with a reason, and leaves open rows owing it', async () => {
    await seedItem({ id: 'WI-moot-done', admission: 'unreviewed', status: 'done', vector: null, payload: PENDING_REVIEW });
    // No admissionReview block at all: an unreviewed row with an absent state still owes review.
    await seedItem({ id: 'WI-moot-implicit', admission: 'unreviewed', status: 'dropped', vector: null });
    await seedItem({ id: 'WI-still-open', admission: 'unreviewed', status: 'open', vector: null, payload: PENDING_REVIEW });
    // Already reviewed: the sweep must never rewrite a finished review.
    await seedItem({
      id: 'WI-reviewed-done',
      admission: 'admitted',
      status: 'done',
      vector: null,
      payload: { admissionReview: { state: 'reviewed', retryAttempts: 1, reviewedBy: 'system:work-item-admission-promoter' } },
    });

    const result = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-review-moot',
      sql: db.sql,
      now: () => NOW,
      onNewlyAdmitted: async () => {},
    });

    expect(result.reviewMoot).toEqual({ closed: 2, byHarness: { [HARNESS]: 2 }, truncatedByLimit: false });
    // Closed BEFORE the debt census, so the census reports the real remaining debt.
    expect(result.reviewDebt).toMatchObject({ pending: 1, terminal: 2, reReviewed: 1 });

    const done = await reviewRow('WI-moot-done');
    expect(done).toMatchObject({
      admission: 'admitted',
      status: 'done',
      payload: {
        // Fail-open provenance survives the close.
        admissionFailOpen: { reason: 'pending-age-exceeded-two-promoter-ticks' },
        admissionReview: {
          state: 'terminal',
          terminalOutcome: ADMISSION_REVIEW_MOOT_OUTCOME,
          reviewedBy: 'system:work-item-admission-fail-open',
          retryAttempts: 0,
          alert: { key: 'work-item-admission-review-debt', state: 'cleared' },
        },
      },
    });
    expect(done.payload.admissionReview.mootReason).toContain('item was already done');
    const implicit = await reviewRow('WI-moot-implicit');
    expect(implicit.payload.admissionReview).toMatchObject({ state: 'terminal', terminalOutcome: 'review-moot' });
    expect(implicit.payload.admissionReview.mootReason).toContain('item was already dropped');

    expect(await reviewRow('WI-still-open')).toMatchObject({
      admission: 'unreviewed',
      payload: { admissionReview: { state: 'pending', alert: { state: 'open' } } },
    });
    expect((await reviewRow('WI-reviewed-done')).payload.admissionReview).toEqual({
      state: 'reviewed',
      retryAttempts: 1,
      reviewedBy: 'system:work-item-admission-promoter',
    });

    // The per-tick trend is durable on the ledger, beside reviewDebt.
    const [ledger] = await db.sql<Array<{ detail: Record<string, any> }>>`
      SELECT detail FROM harness_shared.admission_runs WHERE id = 'fail-open-review-moot'`;
    expect(ledger!.detail.reviewMoot).toEqual({ closed: 2, byHarness: { [HARNESS]: 2 }, truncatedByLimit: false });
  });

  it('follows the fail-open scope: a workspace tick reaches a neighbour harness, a harness tick does not', async () => {
    await seedItem({ id: 'WI-home-done', admission: 'unreviewed', status: 'done', vector: null });
    await seedItem({ id: 'WI-email-done', admission: 'unreviewed', status: 'done', vector: null, harness: 'email' });
    await seedItem({
      id: 'WI-other-tenant-done',
      admission: 'unreviewed',
      status: 'done',
      vector: null,
      workspaceId: 'some-other-workspace',
    });

    const harnessTick = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-moot-harness',
      sql: db.sql,
      now: () => NOW,
      onNewlyAdmitted: async () => {},
    });
    expect(harnessTick.reviewMoot).toEqual({ closed: 1, byHarness: { [HARNESS]: 1 }, truncatedByLimit: false });
    expect((await db.sql`SELECT admission FROM harness_shared.work_items WHERE harness_slug = 'email'`)[0]).toEqual({
      admission: 'unreviewed',
    });

    const workspaceTick = await runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'fail-open-moot-workspace',
      sql: db.sql,
      now: () => NOW,
      scope: 'workspace',
      onNewlyAdmitted: async () => {},
    });
    expect(workspaceTick.reviewMoot).toEqual({ closed: 1, byHarness: { email: 1 }, truncatedByLimit: false });
    const [foreign] = await db.sql<Array<{ admission: string }>>`
      SELECT admission FROM harness_shared.work_items WHERE workspace_id = 'some-other-workspace'`;
    expect(foreign).toEqual({ admission: 'unreviewed' });
  });

  it('bounds one call and drains the rest oldest-first on the next', async () => {
    for (let i = 0; i < 3; i++) {
      await seedItem({
        id: `WI-moot-${i}`,
        admission: 'unreviewed',
        status: 'done',
        vector: null,
        createdAtMs: NOW - (10 - i) * 60_000,
      });
    }
    const first = await closeMootAdmissionReviews(db.sql, { workspaceId: WS, harnessSlug: HARNESS, nowMs: NOW, limit: 2 });
    expect(first).toEqual({ closed: 2, byHarness: { [HARNESS]: 2 }, truncatedByLimit: true });
    const remaining = await db.sql<Array<{ feature_id: string }>>`
      SELECT feature_id FROM harness_shared.work_items WHERE admission = 'unreviewed'`;
    expect(remaining.map((row) => row.feature_id)).toEqual(['WI-moot-2']);

    const second = await closeMootAdmissionReviews(db.sql, { workspaceId: WS, harnessSlug: HARNESS, nowMs: NOW, limit: 2 });
    expect(second).toEqual({ closed: 1, byHarness: { [HARNESS]: 1 }, truncatedByLimit: false });
    expect(await closeMootAdmissionReviews(db.sql, { workspaceId: WS, nowMs: NOW })).toEqual({
      closed: 0,
      byHarness: {},
      truncatedByLimit: false,
    });
  });

  it('no-model pass promotes candidate-free rows and leaves paired rows untouched for the model', async () => {
    await seedItem({ id: 'WI-solo', title: 'a uniquely worded standalone finding', vector: null });
    await seedItem({ id: 'WI-twin-pending', createdAtMs: NOW - 20_000 });
    await seedItem({ id: 'WI-twin-unreviewed', admission: 'unreviewed', createdAtMs: NOW - 19_000, payload: PENDING_REVIEW });
    const llmCall = vi.fn();

    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-no-model-pass',
      sql: db.sql,
      llmCall,
      now: () => NOW,
      noModel: true,
      onNewlyAdmitted: async () => {},
    });

    expect(llmCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ promoted: 1, merged: 0, modelCalled: false, flaggedPairs: 1, deferredToModel: 2 });
    expect(result.held).toBe(2);
    expect((await reviewRow('WI-solo')).admission).toBe('admitted');
    // Deferred, not held: nothing is written, so the re-review watermark only counts real reviews.
    expect(await reviewRow('WI-twin-pending')).toMatchObject({ admission: 'pending', payload: {} });
    expect((await reviewRow('WI-twin-unreviewed')).payload.admissionReview).toEqual(PENDING_REVIEW.admissionReview);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);

    const [ledger] = await db.sql<Array<{ run_kind: string; model_id: string | null; tokens_in: string; detail: Record<string, any> }>>`
      SELECT run_kind, model_id, tokens_in::text, detail FROM harness_shared.admission_runs WHERE id = 'promoter-no-model-pass'`;
    expect(ledger).toMatchObject({
      run_kind: 'promoter-tick',
      model_id: null,
      tokens_in: '0',
      detail: { status: 'complete', mode: 'promoter-no-model', deferredToModel: 2, modelCostUsd: 0 },
    });

    // The same rows with the model available are judged, so the deferral is the flag doing the work.
    const modelRun = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-model-pass',
      sql: db.sql,
      llmCall: judgementCall('r-remedy-keep'),
      now: () => NOW,
      onNewlyAdmitted: async () => {},
    });
    expect(modelRun).toMatchObject({ promoted: 2, modelCalled: true });
    expect(modelRun.deferredToModel).toBeUndefined();
  });

  it('a no-model tick never satisfies the model promoter\'s liveness alarm', async () => {
    const nowMs = Date.now();
    await db.sql`
      INSERT INTO harness_shared.routines (id, install_slug, workspace_id, name, active, created_at)
      VALUES ('rt-promoter', ${HARNESS}, ${WS}, ${WORK_ITEM_ADMISSION_PROMOTER}, true,
              to_timestamp(${nowMs - 4 * 60 * 60_000} / 1000.0))`;
    await seedItem({ id: 'WI-solo', title: 'a uniquely worded standalone finding', vector: null });
    await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'promoter-no-model-liveness',
      sql: db.sql,
      llmCall: vi.fn(),
      noModel: true,
      onNewlyAdmitted: async () => {},
    });

    expect(await readPromoterLiveness(db.sql, WS, HARNESS, nowMs, 90)).toMatchObject({ stale: true });
    // Positive control: the identical row recorded as a MODEL tick does clear the alarm, so the
    // stale verdict above is the mode filter, not a row the reader cannot see.
    await db.sql`
      UPDATE harness_shared.admission_runs
         SET detail = jsonb_set(detail, '{mode}', '"promoter"')
       WHERE id = 'promoter-no-model-liveness'`;
    expect(await readPromoterLiveness(db.sql, WS, HARNESS, nowMs, 90)).toMatchObject({ stale: false });
  });

  it('production fail-open wiring promotes without model spend while the model routine is paused', async () => {
    const { makeWorkItemAdmissionFailOpenAction } =
      await import('./harness/routines/work-item-admission-promoter-action');
    const nowMs = Date.now();
    await db.sql`
      INSERT INTO harness_shared.routines (id, install_slug, workspace_id, name, active, created_at)
      VALUES ('rt-spend-paused', ${HARNESS}, ${WS}, ${WORK_ITEM_ADMISSION_PROMOTER}, true,
              to_timestamp(${nowMs - 4 * 60 * 60_000} / 1000.0))`;
    await db.sql`
      INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, finished_at, detail)
      VALUES ('recent-model-success', ${WS}, ${HARNESS}, 'promoter-tick', clock_timestamp(),
              '{"mode":"promoter","status":"complete"}'::jsonb)`;
    await seedItem({ id: 'WI-pause-solo', title: 'a uniquely worded standalone finding', vector: null, createdAtMs: nowMs - 10_000 });
    await seedItem({ id: 'WI-pause-twin-pending', createdAtMs: nowMs - 20_000 });
    await seedItem({ id: 'WI-pause-twin-unreviewed', admission: 'unreviewed', payload: PENDING_REVIEW, createdAtMs: nowMs - 19_000 });
    const log = vi.fn();
    const action = makeWorkItemAdmissionFailOpenAction({
      // Only outward notifications are replaced: liveness, both admission paths,
      // the no-model callback's throw-on-model guard, and reaping remain production code.
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    });
    const ctx = { installSlug: HARNESS, workspaceId: WS, triggerConfig: {}, payloadTemplate: null };

    await action(ctx);
    expect(log.mock.calls.at(-1)![0]).toContain('no-model=skipped(promoter live)');
    expect((await reviewRow('WI-pause-solo')).admission).toBe('pending');
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs WHERE detail->>'mode' = 'promoter-no-model'`).toHaveLength(0);

    // The private routine's spend pause is the only changed input. No fleet policy,
    // shared routine, live ledger, credentials or model transport is touched.
    await db.sql`UPDATE harness_shared.routines SET active = false WHERE id = 'rt-spend-paused'`;
    await action(ctx);
    expect(log.mock.calls.at(-1)![0]).toMatch(/no-model run=.* promoted=1 merged=0 deferred-to-model=2/);
    expect(log.mock.calls.at(-1)![0]).toContain('reaped-stranded=0');
    expect((await reviewRow('WI-pause-solo')).admission).toBe('admitted');
    expect(await reviewRow('WI-pause-twin-pending')).toMatchObject({ admission: 'pending', payload: {} });
    expect((await reviewRow('WI-pause-twin-unreviewed')).payload.admissionReview).toEqual(PENDING_REVIEW.admissionReview);
    expect(await db.sql`SELECT 1 FROM harness_shared.dedup_adjudications`).toHaveLength(0);
    const [ledger] = await db.sql`
      SELECT run_kind, model_id, tokens_in::text, tokens_out::text, detail
        FROM harness_shared.admission_runs WHERE detail->>'mode' = 'promoter-no-model'`;
    expect(ledger).toMatchObject({
      run_kind: 'promoter-tick', model_id: null, tokens_in: '0', tokens_out: '0',
      detail: { status: 'complete', mode: 'promoter-no-model', deferredToModel: 2, modelCostUsd: 0 },
    });
    expect(await readPromoterLiveness(db.sql, WS, HARNESS, Date.now(), 90)).toMatchObject({ stale: true, active: false });
  });

  it('orders the no-model window: candidate-free pending rows first, unreviewed rows last', async () => {
    const insert = async (id: string, admission: string, createdAtMs: number, payload: Record<string, unknown>) => {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
           admission, payload, created_ts, updated_ts)
        VALUES (${WS}, ${HARNESS}, ${id}, 'title', 'summary', 'open', 'bug', ${admission},
                ${db.sql.json(payload as unknown as Parameters<typeof db.sql.json>[0])}, ${createdAtMs}, ${createdAtMs})`;
    };
    const stamped = { dedupCandidates: [{ id: 'WI-9', similarity: 0.91, method: 'semantic-hard' }] };
    await insert('WI-unreviewed-plain', 'unreviewed', NOW - 50_000, {});
    await insert('WI-pending-stamped', 'pending', NOW - 40_000, stamped);
    await insert('WI-pending-plain', 'pending', NOW - 30_000, {});

    const noModel = await readPendingBatch(db.sql, WS, HARNESS, 10, undefined, { preferModelFree: true });
    expect(noModel.map((item) => item.id)).toEqual(['WI-pending-plain', 'WI-pending-stamped', 'WI-unreviewed-plain']);
    // Control: the model promoter's own order is unchanged (candidate-stamped first, then FIFO).
    const model = await readPendingBatch(db.sql, WS, HARNESS, 10);
    expect(model.map((item) => item.id)).toEqual(['WI-pending-stamped', 'WI-unreviewed-plain', 'WI-pending-plain']);
  });
});

describe('own-node rows stranded at origin=remote (WI-10006515)', () => {
  it('promotes an OWN-NODE row stranded at origin=remote and still refuses a true peer row as remote-owned', async () => {
    // K-own is one of THIS workspace's keys: a local row carries it. K-peer never appears locally.
    // Distinct titles/summaries and no vectors, so no dedup pair forms and no model is consulted.
    const own = { vector: null, authorPubkey: 'K-own' } as const;
    await seedItem({ ...own, id: 'WI-own-anchor', title: 'anchor row for the local key', summary: 'alpha', admission: 'admitted', origin: 'local', createdAtMs: NOW - 60_000 });
    await seedItem({ ...own, id: 'WI-own-strand', title: 'own row stranded by a sync echo', summary: 'bravo', admission: 'pending', origin: 'remote', createdAtMs: NOW - 10_000 });
    await seedItem({ id: 'WI-peer', title: 'genuine peer authored row', summary: 'charlie', admission: 'pending', origin: 'remote', authorPubkey: 'K-peer', vector: null, createdAtMs: NOW - 20_000 });

    const snapshots = await readAdmissionMergeSnapshots(db.sql, {
      workspaceId: WS, harnessSlug: HARNESS, ids: ['WI-own-strand', 'WI-peer'],
    });
    expect(snapshots.get('WI-own-strand')?.ownNode).toBe(true);
    // Absent, not false: a row that is not own-node keeps its snapshot fingerprint unchanged.
    expect(snapshots.get('WI-peer')).toBeDefined();
    expect('ownNode' in snapshots.get('WI-peer')!).toBe(false);

    // Well-formed if reached, so an unexpected call fails the assertion below instead of crashing the run.
    const llmCall = vi.fn(async () => ({ text: '', json: { judgements: [] }, inputTokens: 0, outputTokens: 0 }));
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'own-node-strand',
      sql: db.sql,
      targetItemIds: ['WI-own-strand', 'WI-peer'],
      llmCall,
      now: () => NOW,
    });

    expect(llmCall).not.toHaveBeenCalled();
    expect(result.promoted).toBe(1);
    expect(result.guardRefusals).toEqual([
      expect.objectContaining({ reason: 'remote-owned', detail: expect.stringContaining('WI-peer') }),
    ]);
    const rows = await db.sql<Array<{ feature_id: string; admission: string }>>`
      SELECT feature_id, admission FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ANY(ARRAY['WI-own-strand','WI-peer']::text[])
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'WI-own-strand', admission: 'admitted' },
      { feature_id: 'WI-peer', admission: 'pending' },
    ]);
  }, 60_000);
});

/**
 * WI-6554700010018098 — a create-time dedup leg timeout used to park a row FOREVER: the
 * fail-open runner (correctly) refuses unscreened rows, and the model promoter reaches only a
 * few rows a tick, candidate rows first. The runner now re-screens its over-age degraded rows
 * before admitting. These pin all three outcomes, the cooldown rotation, and the isolation.
 */
describe('degraded-row dedup re-screen in the fail-open runner (WI-6554700010018098)', () => {
  const ORIGINAL = { lexical: 'unavailable', semantic: 'ok', degraded: true };
  const OLD = NOW - 61 * 60_000;
  const clean: DedupRescreenVerdict = { lexical: 'ok', semantic: 'ok', candidates: [] };
  const stillDown: DedupRescreenVerdict = { lexical: 'unavailable', semantic: 'ok', candidates: [] };
  const screenWith = (verdicts: Record<string, DedupRescreenVerdict | Array<DedupRescreenVerdict>>) => {
    const calls = new Map<string, number>();
    return vi.fn(async (row: DedupRescreenRow): Promise<DedupRescreenVerdict> => {
      const v = verdicts[row.id];
      if (!v) throw new Error(`screen leg down for ${row.id}`);
      const n = calls.get(row.id) ?? 0;
      calls.set(row.id, n + 1);
      return Array.isArray(v) ? v[Math.min(n, v.length - 1)]! : v;
    });
  };
  const failOpenAt = (atMs: number, screen: ReturnType<typeof screenWith>, runId: string) =>
    runWorkItemAdmissionFailOpen({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId,
      sql: db.sql,
      now: () => atMs,
      dedupRescreen: screen,
      onNewlyAdmitted: async () => {},
    });
  const readRow = async (id: string) =>
    (await db.sql<Array<{ admission: string; coverage_type: string | null; payload: Record<string, any> }>>`
      SELECT admission, jsonb_typeof(payload -> 'dedupCoverage') AS coverage_type, payload
        FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`)[0]!;

  it('admits a clean re-screen in the same run, stamps found twins for the promoter, and records a still-degraded attempt', async () => {
    await seedItem({ id: 'WI-rs-clean', createdAtMs: OLD - 3_000, vector: null, payload: { dedupCoverage: ORIGINAL } });
    await seedItem({ id: 'WI-rs-twin', createdAtMs: OLD - 2_000, vector: null, payload: { dedupCoverage: ORIGINAL } });
    await seedItem({ id: 'WI-rs-still', createdAtMs: OLD - 1_000, vector: null, payload: { dedupCoverage: ORIGINAL } });
    // Not over-age: the re-screen honours the same cutoff as admission.
    await seedItem({ id: 'WI-rs-young', createdAtMs: NOW - 5 * 60_000, vector: null, payload: { dedupCoverage: ORIGINAL } });
    // Already carries candidates: promoter work, never re-screened.
    await seedItem({
      id: 'WI-rs-candidate', createdAtMs: OLD, vector: null,
      payload: { dedupCoverage: ORIGINAL, dedupCandidates: [{ id: 'WI-x', similarity: 0.9, method: 'semantic-hard' }] },
    });
    await seedItem({ id: 'WI-rs-plain', createdAtMs: OLD, vector: null });
    const screen = screenWith({
      'WI-rs-clean': clean,
      // Strong candidates remain promoter work; semantic-soft alone is now
      // deliberately eligible for the fail-open backstop.
      'WI-rs-twin': { lexical: 'ok', semantic: 'ok', candidates: [{ id: 'WI-canonical', similarity: 0.91, method: 'semantic-hard' }] },
      'WI-rs-still': stillDown,
    });

    const result = await failOpenAt(NOW, screen, 'fail-open-rescreen-outcomes');

    expect(screen.mock.calls.map(([row]) => row.id).sort()).toEqual(['WI-rs-clean', 'WI-rs-still', 'WI-rs-twin']);
    expect(result.dedupRescreen).toMatchObject({
      attempted: 3,
      clean: ['WI-rs-clean'],
      candidatesFound: ['WI-rs-twin'],
      stillDegraded: ['WI-rs-still'],
      raceSkipped: [],
      errored: [],
      budgetExhausted: false,
    });
    // The clean re-screen is admitted by the SAME run, beside the ordinary clean row.
    expect(result.autoPromoted).toEqual(['WI-rs-clean', 'WI-rs-plain']);

    const cleanRow = await readRow('WI-rs-clean');
    expect(cleanRow.admission).toBe('unreviewed');
    // An object, not a double-encoded jsonb string — `payload -> 'key'` predicates depend on it.
    expect(cleanRow.coverage_type).toBe('object');
    expect(cleanRow.payload.dedupCoverage).toMatchObject({
      lexical: 'ok', semantic: 'ok', degraded: false,
      rescreen: { attempts: 1, outcome: 'clean', runId: 'fail-open-rescreen-outcomes', prior: ORIGINAL },
    });

    const twinRow = await readRow('WI-rs-twin');
    expect(twinRow.admission).toBe('pending');
    expect(twinRow.payload.dedupCandidates).toEqual([{ id: 'WI-canonical', similarity: 0.91, method: 'semantic-hard' }]);
    expect(twinRow.payload.dedupCoverage).toMatchObject({ degraded: false, rescreen: { outcome: 'candidates' } });

    const stillRow = await readRow('WI-rs-still');
    expect(stillRow.admission).toBe('pending');
    expect(stillRow.payload.dedupCoverage).toMatchObject({ lexical: 'unavailable', degraded: true, rescreen: { attempts: 1, outcome: 'degraded' } });

    expect((await readRow('WI-rs-young')).payload).toEqual({ dedupCoverage: ORIGINAL });
    expect((await readRow('WI-rs-candidate')).admission).toBe('pending');

    const [run] = await db.sql<Array<{ rescreen: Record<string, unknown> }>>`
      SELECT detail -> 'dedupRescreen' AS rescreen FROM harness_shared.admission_runs
       WHERE workspace_id = ${WS} AND id = 'fail-open-rescreen-outcomes'`;
    expect(run!.rescreen).toMatchObject({ attempted: 3, clean: ['WI-rs-clean'] });
  });

  it('cools a still-degraded row down for two ticks, then retries it and keeps the ORIGINAL coverage as prior', async () => {
    await seedItem({ id: 'WI-rs-flaky', createdAtMs: OLD, vector: null, payload: { dedupCoverage: ORIGINAL } });
    const screen = screenWith({ 'WI-rs-flaky': [stillDown, clean] });

    const first = await failOpenAt(NOW, screen, 'fail-open-rescreen-cool-1');
    expect(first.dedupRescreen).toMatchObject({ stillDegraded: ['WI-rs-flaky'] });

    // Inside the cooldown: not re-screened, so a dead leg cannot pin the batch on one row.
    const second = await failOpenAt(NOW + 10 * 60_000, screen, 'fail-open-rescreen-cool-2');
    expect(second.dedupRescreen).toMatchObject({ attempted: 0 });
    expect(screen).toHaveBeenCalledTimes(1);

    const third = await failOpenAt(NOW + 61 * 60_000, screen, 'fail-open-rescreen-cool-3');
    expect(screen).toHaveBeenCalledTimes(2);
    expect(third.autoPromoted).toEqual(['WI-rs-flaky']);
    const row = await readRow('WI-rs-flaky');
    expect(row.payload.dedupCoverage).toMatchObject({ degraded: false, rescreen: { attempts: 2, outcome: 'clean', prior: ORIGINAL } });
  });

  it('a screen that throws never blocks admission, and the row is retried later rather than admitted unscreened', async () => {
    await seedItem({ id: 'WI-rs-boom', createdAtMs: OLD, vector: null, payload: { dedupCoverage: ORIGINAL } });
    await seedItem({ id: 'WI-rs-ok', createdAtMs: OLD, vector: null });
    const screen = screenWith({});

    const result = await failOpenAt(NOW, screen, 'fail-open-rescreen-throws');

    expect(result.autoPromoted).toEqual(['WI-rs-ok']);
    expect(result.dedupRescreen).toMatchObject({ attempted: 1, errored: ['WI-rs-boom'] });
    const row = await readRow('WI-rs-boom');
    expect(row.admission).toBe('pending');
    expect(row.payload.dedupCoverage).toMatchObject({ degraded: true, rescreen: { attempts: 1, outcome: 'error' } });
  });

  // WI-6554700010018182: the row cap used to bind before the wall budget, so a backlog drained
  // at 20 rows per 30-minute run. With fast screens the whole backlog clears in one run.
  const BACKLOG = 25;
  const backlogIds = Array.from({ length: BACKLOG }, (_, i) => `WI-rs-backlog-${String(i).padStart(2, '0')}`);
  const seedBacklog = async () => {
    // Oldest first: index 0 is the row the FIFO selector reaches first.
    for (const [i, id] of backlogIds.entries()) {
      await seedItem({ id, createdAtMs: OLD - (BACKLOG - i) * 1_000, vector: null, payload: { dedupCoverage: ORIGINAL } });
    }
  };

  it('re-screens a backlog larger than the old 20-row cap in one run when the wall budget allows', async () => {
    await seedBacklog();
    const screen = screenWith(Object.fromEntries(backlogIds.map((id) => [id, clean])));

    const result = await failOpenAt(NOW, screen, 'fail-open-rescreen-backlog');

    expect(screen).toHaveBeenCalledTimes(BACKLOG);
    expect(result.dedupRescreen).toMatchObject({ attempted: BACKLOG, budgetExhausted: false, stillDegraded: [], errored: [] });
    expect([...(result.dedupRescreen as { clean: string[] }).clean].sort()).toEqual(backlogIds);
    expect([...result.autoPromoted].sort()).toEqual(backlogIds);
  });

  it('the wall budget, not the row cap, stops a slow pass, and leaves the rest for the next run', async () => {
    await seedBacklog();
    let clock = NOW;
    const perScreenMs = 10_000;
    const screen = vi.fn(async (): Promise<DedupRescreenVerdict> => {
      clock += perScreenMs;
      return clean;
    });

    const summary = await rescreenDegradedPendingRows({
      workspaceId: WS,
      harnessSlug: HARNESS,
      cutoffMs: NOW - 60 * 60_000,
      cooldownCutoffMs: NOW - 60 * 60_000,
      nowMs: NOW,
      runId: 'rescreen-budget-stop',
      screen,
      sql: db.sql,
      now: () => clock,
    });

    // Starts at 0, 10s, ..., 40s are inside the 45s budget; the start at 50s is not.
    const fits = Math.ceil(DEFAULT_DEDUP_RESCREEN_WALL_BUDGET_MS / perScreenMs);
    expect(fits).toBe(5);
    expect(summary).toMatchObject({ attempted: fits, budgetExhausted: true });
    expect(summary.clean).toEqual(backlogIds.slice(0, fits));
    for (const id of backlogIds.slice(fits)) {
      expect((await readRow(id)).payload).toEqual({ dedupCoverage: ORIGINAL });
    }
  });

  // WI-6554700010018182: live, one screen at a time took ~2s, so the 45s budget fit 21 rows
  // per run whatever the row cap was. Overlapping screens is what multiplies throughput.
  it('overlaps screens up to the concurrency limit and still reports outcomes in selection order', async () => {
    await seedBacklog();
    let inFlight = 0;
    let maxInFlight = 0;
    const screen = vi.fn(async (): Promise<DedupRescreenVerdict> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return clean;
    });

    const summary = await rescreenDegradedPendingRows({
      workspaceId: WS,
      harnessSlug: HARNESS,
      cutoffMs: NOW - 60 * 60_000,
      cooldownCutoffMs: NOW - 60 * 60_000,
      nowMs: NOW,
      runId: 'rescreen-concurrency',
      screen,
      sql: db.sql,
    });

    expect(DEFAULT_DEDUP_RESCREEN_CONCURRENCY).toBeGreaterThan(1);
    expect(maxInFlight).toBe(DEFAULT_DEDUP_RESCREEN_CONCURRENCY);
    expect(summary).toMatchObject({ attempted: BACKLOG, budgetExhausted: false, errored: [], raceSkipped: [] });
    expect(summary.clean).toEqual(backlogIds);
  });
});
