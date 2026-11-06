/**
 * start-auto-flip.integration.test.ts — plans:start auto-approves a draft (P2-3).
 *
 * Starting a plan IS the approval signal: a still-`draft` plan has its
 * frontmatter auto-advanced to `ready` (best-effort, inside withPlanLock), and
 * the start result reports `autoApproved: true`. start-guard.test.ts stubs
 * withPlanLock to a no-op, so it never exercises the flip — this drives the REAL
 * flip against Postgres via the shared baseline-schema fixture.
 *
 * Covers:
 *   - draft start → frontmatter reads `ready`, autoApproved:true;
 *   - re-start (now ready) → autoApproved:false, no second flip;
 *   - a non-draft (ready) start → autoApproved:false, frontmatter unchanged.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/start-auto-flip.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { runWithWorkspace } from '../../../workspace-als';
import type { PlanPgFixture } from './_pg-tool-fixture';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../../scorecards';
import { metadataClauseWrite } from '../coordination-metadata-fixtures';
import { evaluatePlanSpecQuality, SPEC_QUALITY_RUBRIC_REF } from '../spec-quality';
import { parsePlan } from '../parser';
import { dispatchProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';
import { toolGuardText } from '../../../endpoint-route/routes/agent-mcp/identity-hook-sinks';
import { controlAnchorKernelResolver } from '../../../projected-tool-deps';

// WI-5825: plans:start resolves its write key through resolvePlanScope — the SAME
// authority its plan READ uses — not the ambient activeWorkspaceId(). Pin the resolver
// to what this fixture seeds under, rather than depending on the real machine's
// harness registry / workspace-registry file.
vi.mock('../source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: DEFAULT_WORKSPACE_ID,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

// P-047 (retire-mug-kettle-su-only-2026-08-09): plans:start's op_status write is
// gated on the Mug/Kettle retirement flag, whose default is OFF. This suite is
// about the AUTO-APPROVE half, which survives the retirement untouched — so pin
// the tier ON here rather than rewrite assertions that are not about the gate.
// The retired shape (no op_status write, promotion still runs) is pinned in
// start-guard.test.ts, and the surviving auto-approve is re-asserted at the foot
// of this file with the tier OFF, so neither half can regress unnoticed.
// vi.hoisted, not a plain const: vi.mock factories are hoisted above module-scope
// declarations, so a bare const read inside one is a TDZ hazard.
const MUG_KETTLE = vi.hoisted(() => ({ on: true }));
vi.mock('../../../pot/started', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../pot/started')>();
  return { ...actual, mugKettleSystemEnabled: async () => MUG_KETTLE.on };
});

// This fixture targets the real draft→ready body write and revision spine, not
// the lifecycle/admission contracts that every production start must satisfy.
// Keep those unrelated doors deterministic, matching start-guard.test.ts; the
// Postgres-backed withPlanLock below remains real and is the subject under test.
const START_GATES = vi.hoisted(() => ({
  activation: vi.fn(),
  admission: vi.fn(),
  laneHealth: vi.fn(),
  useLaneHealthFixture: false,
  claimSpec: vi.fn(),
  startable: vi.fn(),
  promotion: vi.fn(),
  prediction: vi.fn(),
  listCards: vi.fn(),
  afterQuality: vi.fn(),
  barCritique: vi.fn(),
}));
const REVISION_MOCK = vi.hoisted(() => ({ failInTransaction: false }));
// Keep the real clause/class readers and quality evaluator. Only the unrelated
// scorecard ledger is supplied; the hook models a policy change after preflight.
// P-007 critique enforcement is a separate start contract, so keep it out of this race fixture.
vi.mock('../plan-spec-quality-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-spec-quality-gate')>();
  return {
    ...actual,
    evaluatePlanSpecQualityGate: async (input: Parameters<typeof actual.evaluatePlanSpecQualityGate>[0]) => {
      const result = await actual.evaluatePlanSpecQualityGate(input, { listCards: START_GATES.listCards });
      await START_GATES.afterQuality(result);
      return result;
    },
  };
});
vi.mock('../plan-start-critique-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-start-critique-gate')>();
  return {
    ...actual,
    evaluatePlanStartBarCritique: (...args: Parameters<typeof actual.evaluatePlanStartBarCritique>) =>
      START_GATES.barCritique(...args),
  };
});
vi.mock('../revisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../revisions')>();
  return {
    ...actual,
    planRevisionCapture: (...args: Parameters<typeof actual.planRevisionCapture>) => {
      const capture = actual.planRevisionCapture(...args);
      if (!REVISION_MOCK.failInTransaction || !capture.inTransaction) return capture;
      return {
        ...capture,
        inTransaction: async () => {
          throw new actual.PlanRevisionUnavailableError(
            args[1],
            new Error('simulated plan_revisions insert outage'),
          );
        },
      };
    },
  };
});
vi.mock('../plan-start-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-start-gate')>();
  return {
    ...actual,
    checkPlanStartable: async (...args: Parameters<typeof actual.checkPlanStartable>) =>
      START_GATES.startable(await actual.checkPlanStartable(...args)),
  };
});
vi.mock('../plan-activation-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-activation-gate')>();
  return {
    ...actual,
    evaluateConversationActivationGate: (...args: unknown[]) => START_GATES.activation(...args),
  };
});
vi.mock('../plan-admission-preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-admission-preflight')>();
  return {
    ...actual,
    preflightExactPlanLaneHealth: (...args: Parameters<typeof actual.preflightExactPlanLaneHealth>) =>
      START_GATES.useLaneHealthFixture
        ? START_GATES.laneHealth(...args)
        : actual.preflightExactPlanLaneHealth(...args),
    preflightExactPlanAdmission: (...args: unknown[]) => START_GATES.admission(...args),
  };
});
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: (...args: unknown[]) => START_GATES.promotion(...args),
}));
vi.mock('../../../calibration/capture', () => ({
  recordPrediction: (...args: unknown[]) => START_GATES.prediction(...args),
}));
vi.mock('../../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    setClaimSpec: (...args: unknown[]) => START_GATES.claimSpec(...args),
  };
});

// Import AFTER the mock is declared (vi.mock is hoisted, but these pull in `start`,
// which resolves the scope at call time, not at import time — either ordering works;
// kept dynamic for symmetry with the mock-then-import convention elsewhere).
const startTool = (await import('../start')).default;
const { setupPlanPgFixture, cleanupPlans, seedPlan } = await import('./_pg-tool-fixture');

const HARNESS = `zzz-start-flip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// The baseline can still carry migration 1004's workspace+subjectPlan unique
// index. Isolate the subject as well as its harness; never delete a peer's seed
// or require a live schema migration just to exercise this class-change race.
const SLUG = `${HARNESS}-plan`;
const WS = DEFAULT_WORKSPACE_ID;

async function seedLegacyPlan(status: 'draft' | 'ready', withItem = false) {
  const body = withItem ? planBody(status).replace('## Decisions',
    '## Tasks\n\n- **P-001** `todo` Record baseline findings deliverable: doc\n\n## Decisions') : planBody(status);
  await seedPlan(admin, WS, HARNESS, SLUG, body);
  // Migration 1111 marks every INSERT as post-epoch. These approval/revision
  // fixtures deliberately represent existing legacy plans, which have no BAR
  // contract. Seed that identity in the throwaway DB; keep the real reader and
  // evaluator so a missing/unknown subject can never masquerade as legacy.
  await admin`
    UPDATE harness_shared.harness_plans
       SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
}

function planBody(status: 'draft' | 'ready'): string {
  return `---
title: Auto-Approve Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: ${status}
---

# Auto-Approve Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose for the body.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-start-flip-test', workspaceId: WS },
  } as never;
}

async function runStart(): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  // Bulk-pattern tools return a structured `{ data: { ok, results, counts } }`
  // envelope (../_bulk bulkContent) — the per-slug result is data.results[0], and
  // a failure shows as counts.failed > 0 (no legacy `content[0].text` / isError).
  // This fixture isolates the draft→ready write and revision spine; explicitly
  // override the unrelated live-peer checkpoint consult so fleet liveness cannot
  // turn the deterministic auto-flip assertion into a consult_available refusal.
  // Direct handler invocation omits the dispatcher's request workspace. Bind
  // it here so canonical snapshot readers see this fixture's seeded plan too.
  const res = (await runWithWorkspace(WS, () => startTool.handler({
    harness: HARNESS,
    slug: SLUG,
    consulted: false,
    consult_reason: 'auto-flip integration fixture isolates revisioned approval write',
  } as never, makeCtx()))) as {
    data: { results: Record<string, unknown>[]; counts?: { failed?: number } };
  };
  return { data: res.data.results[0], isError: (res.data.counts?.failed ?? 0) > 0 };
}

async function frontmatterStatus(): Promise<string | null> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  const content = rows[0]?.content ?? '';
  const m = /^status:[ \t]*([A-Za-z][\w-]*)/m.exec(content.split('\n---')[0] ?? '');
  return m?.[1] ?? null;
}

async function revisionRows(): Promise<Array<{ seq: number; content_hash: string; content_snapshot: string; rationale: string | null }>> {
  return admin<Array<{ seq: number; content_hash: string; content_snapshot: string; rationale: string | null }>>`
    SELECT seq, content_hash, content_snapshot, rationale
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
       AND rationale IS DISTINCT FROM 'plans:start completed canonical promotion, admission and claim binding'
     ORDER BY seq
  `;
}

async function persistedStartState() {
  const rows = await admin`
    SELECT content, content_hash, version, op_status, op_started_at, op_updated_at
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return { plan: rows[0], revisions: await revisionRows() };
}

async function cleanupFixture() {
  await admin`DELETE FROM harness_shared.work_items
    WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
  // Revisions are append-only, even for the test admin. Teardown on the
  // injected throwaway database suppresses triggers on THIS transaction only:
  // no shared ALTER TABLE and no changes to the production immutability guard.
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    await tx`DELETE FROM harness_shared.plan_spec_clauses
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  });
  expect((await admin`SHOW session_replication_role`)[0]?.session_replication_role).toBe('origin');
  await admin`DELETE FROM harness_shared.plan_items
    WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  await cleanupPlans(admin, WS, HARNESS);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await admin.unsafe(await readFile(new URL('../../../../../../libs/papercusp/libs/db/sql/1613-plan-execution-start-revision.sql', import.meta.url), 'utf8'));
}, 60_000);

afterAll(async () => {
  await cleanupFixture();
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupFixture();
  MUG_KETTLE.on = true;
  START_GATES.activation.mockReset();
  START_GATES.activation.mockResolvedValue({ satisfied: true, auditSeq: 1, grandfathered: true });
  START_GATES.admission.mockReset();
  START_GATES.admission.mockResolvedValue({
    ready: true,
    status: 'ready',
    reason: 'ready',
    message: 'exact-plan admission fixture override',
  });
  START_GATES.useLaneHealthFixture = false;
  START_GATES.laneHealth.mockReset();
  START_GATES.laneHealth.mockResolvedValue({ effective: { claimable: 1 } });
  START_GATES.claimSpec.mockReset();
  START_GATES.claimSpec.mockResolvedValue({ ok: true, errors: [], revision: 1 });
  START_GATES.startable.mockReset();
  START_GATES.startable.mockImplementation((gate) => gate);
  START_GATES.promotion.mockReset();
  START_GATES.promotion.mockResolvedValue({ promoted: 0, skipped: 0, flagOff: false, workItems: [] });
  START_GATES.prediction.mockReset();
  START_GATES.prediction.mockResolvedValue(undefined);
  START_GATES.listCards.mockReset();
  START_GATES.listCards.mockResolvedValue([]);
  START_GATES.afterQuality.mockReset();
  START_GATES.afterQuality.mockResolvedValue(undefined);
  START_GATES.barCritique.mockReset();
  START_GATES.barCritique.mockResolvedValue(null);
  REVISION_MOCK.failInTransaction = false;
});

describe('plans:start — draft auto-approve (P2-3)', () => {
  it('refuses a migration park before approval and permits its lane after audited release', async () => {
    await seedLegacyPlan('draft', true);
    const node = `WI-start-park-${HARNESS}`;
    const payload = { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes',
      plan_item: { plan_slug: SLUG, harness_slug: HARNESS, item_id: 'P-001' } };
    await admin`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts,
       source_plan_slug, source_plan_item_ids, plan_slug, plan_line_id, plan_deliverable, plan_line_text, plan_seq, payload)
      VALUES (${WS}, ${HARNESS}, ${node}, 'feature', 'parked first lane', 'open', 0, 0,
        ${SLUG}, ARRAY['P-001']::text[], ${SLUG}, 'P-001', 'doc', 'Record baseline findings', 1,
        ${JSON.stringify(payload)}::text::jsonb)`;
    const before = await persistedStartState();
    const { initialChangeScopeProblems } = await import('../initial-change-scope');
    expect(initialChangeScopeProblems({ content: before.plan.content, anchors: {} }),
      'the document-only fixture must satisfy the independent initial-scope gate').toEqual([]);
    const source = await import('../source');
    const snapshot = await source.getPlanRow(SLUG, { workspaceId: WS, harnessSlug: HARNESS });
    expect(snapshot, 'the fixture must have a canonical indexed plan').not.toBeNull();
    expect(source.planItemsForRow(snapshot!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'P-001', storedStatus: 'todo' }),
    ]));
    const { listWorkItems } = await import('../../../work-items');
    const census = await runWithWorkspace(WS, () => listWorkItems({
      harness: HARNESS, sourcePlanSlug: SLUG, includeChildren: true,
    }));
    expect(census, JSON.stringify(census)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: node, payload: expect.objectContaining(payload) }),
    ]));
    const refused = await runStart();
    expect(refused.data, JSON.stringify(refused.data)).toMatchObject({
      ok: false, error: 'admission_refused', admissionReason: 'promotion-lag',
    });
    expect(refused.data.message).toContain('P-008 / D-011');
    expect(await persistedStartState()).toEqual(before);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.claimSpec).not.toHaveBeenCalled();
    const [held] = await admin`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node}`;
    expect(held.payload).toEqual(payload);

    // Model the separate migration authority's audited release in this private
    // database. Start itself must neither clear the park nor create a new node.
    await admin`UPDATE harness_shared.work_items SET payload=payload - '_claimHold' - 'claim_hold_by'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node}`;
    const started = await runStart();
    expect(started.isError, JSON.stringify(started.data)).toBe(false);
    expect(started.data).toMatchObject({ status: 'started', autoApproved: true });
    expect(await frontmatterStatus()).toBe('ready');
    const rows = await admin`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND source_plan_slug=${SLUG}`;
    expect(rows.map(row => row.feature_id)).toEqual([node]);
  });

  it.each(['promotion','binding'])('issues no authority when the final %s leg fails', async leg => {
    await seedLegacyPlan('ready');
    if (leg === 'promotion') START_GATES.promotion.mockRejectedValueOnce(new Error('promotion unavailable'));
    else START_GATES.claimSpec.mockRejectedValueOnce(new Error('binding unavailable'));
    const { isError } = await runStart();
    expect(isError).toBe(true);
    const [row] = await admin`SELECT execution_start_revision_seq FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(row.execution_start_revision_seq).toBeNull();
  });

  it('starting a DRAFT plan flips its frontmatter to ready and reports autoApproved:true', async () => {
    await seedLegacyPlan('draft');
    expect(await frontmatterStatus()).toBe('draft');

    const { data, isError } = await runStart();
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: true, transitioned: true });

    // The real withPlanLock flip landed: the frontmatter now reads ready.
    expect(await frontmatterStatus()).toBe('ready');

    // The approval write is a canonical plan-body mutation, so it must leave a
    // revision spine row for activation audits/BAR pinning to resolve.
    await expect(revisionRows()).resolves.toEqual([
      expect.objectContaining({
        seq: 1,
        rationale: 'plans:start → auto-approve draft',
        content_snapshot: expect.stringContaining('status: ready'),
      }),
    ]);
  });

  it('re-starting the now-ready plan does NOT flip again (autoApproved:false)', async () => {
    await seedLegacyPlan('draft');
    const first = await runStart();
    expect(first.data.autoApproved).toBe(true);
    expect(await frontmatterStatus()).toBe('ready');

    const second = await runStart();
    expect(second.isError).toBe(false);
    // Already ready → expectedCurrent:'draft' makes the flip a no-op.
    expect(second.data.autoApproved).toBe(false);
    // Idempotent re-start: op_status was already started → not a transition.
    expect(second.data.transitioned).toBe(false);
    expect(await frontmatterStatus()).toBe('ready');
    // The idempotent re-start performs no body write and must not append a
    // duplicate revision.
    expect(await revisionRows()).toHaveLength(1);
  });

  it('starting a plan that is ALREADY ready does not auto-approve', async () => {
    await seedLegacyPlan('ready');
    expect(await frontmatterStatus()).toBe('ready');

    const { data, isError } = await runStart();
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: false, transitioned: true });
    // Frontmatter untouched — it was never a draft.
    expect(await frontmatterStatus()).toBe('ready');
  });
});

describe('plans:start — refused approval leaves no persisted start (P-002)', () => {
  it('rolls back draft approval when strict revision capture is unavailable', async () => {
    await seedLegacyPlan('draft');
    const before = await persistedStartState();
    REVISION_MOCK.failInTransaction = true;

    const refused = await runStart();

    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({
      ok: false,
      error: 'plan_revision_unavailable',
    });
    expect(await persistedStartState()).toEqual(before);
    expect(await revisionRows()).toHaveLength(0);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.prediction).not.toHaveBeenCalled();
  });

  it('rejects the old exact card when the persisted class changes after preflight, then starts with new-class evidence', async () => {
    await seedLegacyPlan('draft');
    const content = `${planBody('draft')}\n## Phase\n- **P-001** \`todo\` Submit an event\n`;
    expect(parsePlan(content).items.map((item) => item.id)).toEqual(['P-001']);
    await admin`UPDATE harness_shared.harness_plans SET content = ${content}, content_hash = md5(${content})
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    await admin`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
      VALUES (${WS}, ${HARNESS}, ${SLUG}, 'P-001', 1, 'Submit an event', 'todo')`;
    // Source readers render work-graph nodes; this class-race fixture has no
    // unrelated initial code-scope requirement.
    const { writePlanLineNodes, readPlanLineNodes } = await import('../plan-line-graph');
    await writePlanLineNodes(admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }, [], [{
      id: 'P-001', text: 'Submit an event', status: 'todo', importance: 'normal',
      phase: 'Phase', decisionRefs: [], blockedBy: [], deliverable: 'doc',
    }]);
    const planItems = await readPlanLineNodes(admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    const rubricId = `${SLUG}-acceptance`;
    const data = { kind: 'acceptance', subjectPlan: SLUG, subjectHarnessSlug: HARNESS,
      classRef: 'plan-class-feature-ship', characteristic: 'plan-acceptance',
      criteria: [], ratingScale: ['pass', 'fail', 'unknown'] };
    await admin`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, template, template_data)
      VALUES (${WS}, ${HARNESS}, ${rubricId}, '', md5(${rubricId}), ${rubricId},
        'active', 'rubric', ${JSON.stringify(data)}::text::jsonb)`;
    const { setSpecClause, listSpecClauses } = await import('../spec-clauses-store');
    const clauses = await runWithWorkspace(WS, async () => {
      expect(await setSpecClause(metadataClauseWrite({
        harnessSlug: HARNESS, planSlug: SLUG, sourceValId: null, behaviorClass: 'boundary',
      }))).toMatchObject({ status: 'created' });
      return listSpecClauses({ harnessSlug: HARNESS, planSlug: SLUG });
    });
    // Positive control: cleanup must not leave the real write path with the
    // revision guard disabled. This exact revision exists and rejects deletion.
    expect(clauses).toHaveLength(1);
    await expect(admin`DELETE FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`
    ).rejects.toThrow(/immutable/);
    const cardFor = (classRef: 'plan-class-feature-ship' | 'plan-class-bugfix'): ScorecardRow => {
      const evaluation = evaluatePlanSpecQuality({
        planSlug: SLUG, harnessSlug: HARNESS, planItemIds: ['P-001'], planItems, clauses, classRef,
      });
      expect(evaluation.verdict).toBe('pass');
      return {
        issueId: `EI-fixture-${classRef}`, createdAt: '2026-09-07T00:00:00Z', createdBy: 'independent-reviewer',
        subject: evaluation.scorecardDraft.subject, rubricRef: SPEC_QUALITY_RUBRIC_REF,
        ratings: evaluation.ratings, nKeys: Object.keys(evaluation.ratings).length,
        missingKeys: [], extraKeys: [], rubricResolved: true, synthesized: false,
        evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef: SPEC_QUALITY_RUBRIC_REF, ratings: evaluation.ratings }),
        score10: 10, linkedItems: [],
      };
    };
    const oldCard = cardFor('plan-class-feature-ship');
    const newCard = cardFor('plan-class-bugfix');
    expect(newCard.subject?.ref).not.toBe(oldCard.subject?.ref);
    expect(newCard.evidenceFingerprint).not.toBe(oldCard.evidenceFingerprint);
    // The migration-park case exercises the real lane-health preflight. Keep this
    // scorecard race independent of fleet-lane state so it reaches the class recheck.
    START_GATES.useLaneHealthFixture = true;
    START_GATES.listCards.mockResolvedValue([oldCard]);
    START_GATES.afterQuality.mockImplementationOnce(async (verdict) => {
      expect(verdict, JSON.stringify(verdict)).toMatchObject({ satisfied: true, classRef: 'plan-class-feature-ship' });
      await admin`UPDATE harness_shared.harness_plans
        SET template_data = jsonb_set(template_data, '{classRef}', '"plan-class-bugfix"'::jsonb)
        WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${rubricId}`;
    });
    const before = await persistedStartState();
    const refused = await runStart();
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ ok: false, error: 'spec_quality_scorecard_missing' });
    expect(START_GATES.afterQuality).toHaveBeenCalledTimes(2);
    expect(START_GATES.afterQuality.mock.calls[1][0]).toMatchObject({
      satisfied: false, classRef: 'plan-class-bugfix', code: 'spec_quality_scorecard_missing',
    });
    expect(await persistedStartState()).toEqual(before);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.prediction).not.toHaveBeenCalled();

    START_GATES.listCards.mockResolvedValue([newCard]);
    const retry = await runStart();
    expect(retry.isError, JSON.stringify(retry.data)).toBe(false);
    expect(retry.data).toMatchObject({ status: 'started', autoApproved: true });
    expect(START_GATES.promotion).toHaveBeenCalledTimes(1);
  });

  it.each(['draft', 'ready'] as const)('preserves the %s row when the locked admission recheck refuses, then retries the same plan', async (status) => {
    await seedLegacyPlan(status);
    const before = await persistedStartState();
    START_GATES.startable
      .mockImplementationOnce((gate) => gate)
      .mockImplementationOnce((gate) => ({
        ok: false,
        kind: 'admission',
        row: gate.row,
        refusal: { error: 'plan_not_admitted', code: 'plan_not_admitted', slug: SLUG },
      }));

    const refused = await runStart();
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ ok: false, error: 'plan_not_admitted' });
    expect(START_GATES.startable).toHaveBeenCalledTimes(2);
    expect(await persistedStartState()).toEqual(before);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.prediction).not.toHaveBeenCalled();

    const retry = await runStart();
    expect(retry.isError).toBe(false);
    expect(retry.data).toMatchObject({ status: 'started', transitioned: true, autoApproved: status === 'draft' });
    expect(await frontmatterStatus()).toBe('ready');
    expect(await revisionRows()).toHaveLength(status === 'draft' ? 1 : 0);
    expect(START_GATES.promotion).toHaveBeenCalledTimes(1);
  });

  it('preserves the row when the canonical body writer refuses activation after the mutator passes', async () => {
    await seedLegacyPlan('draft');
    const before = await persistedStartState();
    START_GATES.activation
      .mockResolvedValueOnce({ satisfied: true, auditSeq: 1 })
      .mockResolvedValueOnce({ satisfied: false, code: 'conversation_audit_required' });

    const refused = await runStart();
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ ok: false, error: 'conversation_audit_required' });
    expect(START_GATES.activation).toHaveBeenCalledTimes(2);
    expect(await persistedStartState()).toEqual(before);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.prediction).not.toHaveBeenCalled();
  });

  it('preserves the row when the locked prerequisite reader throws', async () => {
    await seedLegacyPlan('draft');
    const before = await persistedStartState();
    START_GATES.startable
      .mockImplementationOnce((gate) => gate)
      .mockRejectedValueOnce(new Error('prerequisite reader unavailable'));

    const refused = await runStart();
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ ok: false, error: 'plan_start_revalidation_unavailable' });
    expect(await persistedStartState()).toEqual(before);
    expect(START_GATES.promotion).not.toHaveBeenCalled();
    expect(START_GATES.prediction).not.toHaveBeenCalled();
  });
});

/**
 * P-047 — the same auto-approve, with the OPERATIONAL axis retired.
 *
 * The retirement gates the op_status WRITE, not the verb (D-010): approval and
 * promotion are what a user actually starts a plan for, and they must survive.
 * The unit suite pins the SQL shape; this pins the real end-to-end effect
 * against Postgres, because "the frontmatter flip still lands" is a claim about
 * a withPlanLock write no mocked-tx assertion can make.
 */
describe('plans:start — draft auto-approve survives the retired op_status axis (P-047)', () => {
  beforeEach(() => {
    MUG_KETTLE.on = false;
  });
  afterAll(() => {
    MUG_KETTLE.on = true;
  });

  it('flips draft→ready and reports the retirement, without ever writing op_status', async () => {
    await seedLegacyPlan('draft');

    const { data, isError } = await runStart();
    expect(isError, JSON.stringify(data)).toBe(false);
    // The approval half is untouched...
    expect(data).toMatchObject({ autoApproved: true, opStatusRetired: true });
    expect(await frontmatterStatus()).toBe('ready');
    // ...and the operational half never happened — asserted against the ROW, not
    // the tool's own report, so a handler that lied could not pass this.
    expect(data).toMatchObject({ status: null, transitioned: false });
    const rows = await admin<{ op_status: string | null }[]>`
      SELECT op_status FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(rows[0]?.op_status ?? null).toBeNull();
    const proof = await admin<{ content_snapshot: string }[]>`
      SELECT r.content_snapshot FROM harness_shared.harness_plans p
      JOIN harness_shared.plan_revisions r ON r.workspace_id=p.workspace_id AND r.harness_slug=p.harness_slug
        AND r.plan_slug=p.plan_slug AND r.seq=p.execution_start_revision_seq
      WHERE p.workspace_id=${WS} AND p.harness_slug=${HARNESS} AND p.plan_slug=${SLUG}`;
    const receipt = JSON.parse(proof[0]!.content_snapshot);
    expect(receipt.schema).toBe('plan-execution-start-v1');
    expect(receipt.body).toContain('status: ready');
    const { readPlanExecutionStart } = await import('../plan-execution-authority');
    expect(await readPlanExecutionStart({ planSlug: SLUG, harnessSlug: HARNESS }, WS)).toEqual([]);
    // Admission must consume the receipt made by canonical start, not a test-issued shortcut.
    const ownerId = `su-${HARNESS}`;
    await admin`INSERT INTO harness_shared.session_briefs (owner_id,workspace_id,current_plan_slug,harness_slug)
      VALUES (${ownerId},${WS},${SLUG},${HARNESS})`;
    try {
      const native = await toolGuardText({ ownerId, workspaceId: WS,
        call: { tool: 'apply_patch', input: {}, client: 'codex' } }, async () => null);
      expect(native).toBe('');
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'private write admitted' }] }));
      const tool = { pluginName: 'fixture', description: 'private write', inputSchema: { type: 'object' },
        capabilities: [], expose: { mcp: { name: 'capability:write' } }, fn: handler } as ProjectedTool;
      const result = await dispatchProjectedTool(tool, 'capability:write', {},
        { workspaceId: WS, isSuperuser: true, uiClientId: ownerId, signal: new AbortController().signal,
          log: () => {}, progress: () => {}, emit: () => {} }, { kernelEnforcement: controlAnchorKernelResolver });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await admin`DELETE FROM harness_shared.session_briefs WHERE owner_id=${ownerId}`;
    }
  });
});

/**
 * WI-10005177 (EI-23764501791910357 slice 3b): the plan-start consult override takes
 * an optional structured `consult_id`, resolved against a consult_state row the CALLER
 * requested. Real PG, real resolver — "the override names a real consult of yours" is a
 * claim about harness_shared.consult_state that no mocked lookup can make.
 */
describe('plans:start — consult_id links the override to a requested consult (WI-10005177)', () => {
  // makeCtx's principal slug IS the caller's coord owner id (operationCallerId with no
  // uiClientId), so it is the requester id a seeded consult must carry.
  const CALLER = 'agent-start-flip-test';
  const FULL_ID = 'conv-cid1-0000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OTHER_ID = 'conv-cid2-0000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const BLOCKING_ID = 'conv-cid3-0000-cccccccccccccccccccccccccccccccc';

  async function seedConsultRow(opts: {
    id: string;
    requester: string;
    latency?: 'proceed' | 'hard-blocked';
    outcome?: Record<string, unknown> | null;
  }) {
    // consult_state has no FK to coord_conversations, and the resolver reads
    // consult_state only — seeding a conversation row would be fixture noise.
    await admin`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, max_exchanges, exchanges_used, wakes_used, routing, outcome)
      VALUES
        (${WS}, ${opts.id}, ${opts.requester}, 'resp-1', 'awaiting_responder', 'q',
         ${opts.latency ?? 'proceed'}, 4, 0, 0, ${admin.json({} as never)},
         ${opts.outcome === undefined || opts.outcome === null ? null : admin.json(opts.outcome as never)})
    `;
  }

  async function runWithConsultId(consultId: string): Promise<{ data: Record<string, unknown>; isError: boolean }> {
    const res = (await runWithWorkspace(WS, () => startTool.handler({
      harness: HARNESS,
      slug: SLUG,
      consulted: true,
      consult_reason: 'consult concluded the plan assumptions hold',
      consult_id: consultId,
    } as never, makeCtx()))) as {
      data: { results: Record<string, unknown>[]; counts?: { failed?: number } };
    };
    return { data: res.data.results[0], isError: (res.data.counts?.failed ?? 0) > 0 };
  }

  beforeEach(async () => {
    await admin`DELETE FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id LIKE 'conv-cid%'`;
  });
  afterAll(async () => {
    await admin`DELETE FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id LIKE 'conv-cid%'`;
  });

  it('records the resolved consult on the start result and says a proceed consult still owes reconciliation', async () => {
    await seedLegacyPlan('draft');
    await seedConsultRow({ id: FULL_ID, requester: CALLER });

    const { data, isError } = await runWithConsultId(FULL_ID);
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: true });
    expect(data.checkpointConsult).toMatchObject({
      overridden: true,
      consulted: true,
      reason: 'consult concluded the plan assumptions hold',
      consultId: FULL_ID,
      latencyContract: 'proceed',
    });
    expect(await frontmatterStatus()).toBe('ready');
  });

  it('resolves a unique PREFIX to the full id (the truncated-id shape consult verbs also accept)', async () => {
    await seedLegacyPlan('draft');
    await seedConsultRow({ id: FULL_ID, requester: CALLER });

    const { data, isError } = await runWithConsultId('conv-cid1');
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data.checkpointConsult).toMatchObject({ consultId: FULL_ID });
  });

  it('links historical and blocking consultations without requiring a reporting action', async () => {
    await seedConsultRow({
      id: FULL_ID,
      requester: CALLER,
      outcome: { reconciliation: { disposition: 'confirmed', note: 'n', by: CALLER, at: '2026-10-02T00:00:00Z', consult_state: 'answered' } },
    });
    await seedConsultRow({ id: BLOCKING_ID, requester: CALLER, latency: 'hard-blocked' });

    await seedLegacyPlan('draft');
    const reconciled = await runWithConsultId(FULL_ID);
    expect(reconciled.isError, JSON.stringify(reconciled.data)).toBe(false);
    expect(reconciled.data.checkpointConsult).toMatchObject({ consultId: FULL_ID });
    expect(reconciled.data.checkpointConsult).not.toHaveProperty('reconciliationOwed');
    expect(reconciled.data.checkpointConsult).not.toHaveProperty('reconcileWith');

    const blocking = await runWithConsultId(BLOCKING_ID);
    expect(blocking.isError, JSON.stringify(blocking.data)).toBe(false);
    expect(blocking.data.checkpointConsult).toMatchObject({
      consultId: BLOCKING_ID,
      latencyContract: 'hard-blocked',
    });
    expect(blocking.data.checkpointConsult).not.toHaveProperty('reconciliationOwed');
    expect(blocking.data.checkpointConsult).not.toHaveProperty('reconcileWith');
  });

  it("refuses a consult the caller did NOT request, and refuses BEFORE any approval write (plan stays draft)", async () => {
    await seedLegacyPlan('draft');
    await seedConsultRow({ id: OTHER_ID, requester: 'someone-else' });

    const { data, isError } = await runWithConsultId(OTHER_ID);
    expect(isError).toBe(true);
    expect(data).toMatchObject({ error: 'invalid_consult_id', consultError: { error: 'not_the_requester' } });
    // The refusal is a read-only pre-check: no half-started plan.
    expect(await frontmatterStatus()).toBe('draft');
    expect(await revisionRows()).toEqual([]);
  });

  it('refuses an unknown consult id with not_a_consult and leaves the plan draft', async () => {
    await seedLegacyPlan('draft');

    const { data, isError } = await runWithConsultId('conv-nope-0000-dddddddddddddddddddddddddddddddd');
    expect(isError).toBe(true);
    expect(data).toMatchObject({ error: 'invalid_consult_id', consultError: { error: 'not_a_consult' } });
    expect(await frontmatterStatus()).toBe('draft');
  });

  it('the schema refuses consult_id WITHOUT consulted (it names the consult behind an override)', () => {
    const parsed = (startTool.args as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      slug: SLUG,
      consult_id: FULL_ID,
    });
    expect(parsed.success).toBe(false);
    const withConsulted = (startTool.args as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      slug: SLUG,
      consulted: true,
      consult_id: FULL_ID,
    });
    expect(withConsulted.success).toBe(true);
  });
});
