/**
 * emit-agent-run-evidence-record.integration.test.ts — a scorecard graded against an
 * AGENT RUN lands with a server-derived evidence record, against real migrated Postgres.
 *
 * Acceptance clause R-1 of goal-agent-behavior-feedback-2026-09-06
 * (AUTO-BAR-R-1-P-001/P-002/P-014): "Each sampled run has an evidence record containing
 * its goal, holder, observation window, source generation and instruction exposure."
 * WI-10003539 measured the live gap: 0/10 live goal-mode-e2e cards carried a goal id or a
 * structured instruction exposure.
 *
 * This suite drives the real emit path (real rubric read, real ledger write, real
 * durable-source lookups) and asserts:
 *   1. an agent-run card lands with goal (from goals.metadata.agentOwnerId), holder,
 *      window, the holder's launch generation and its recorded instruction exposure;
 *   2. a holder whose launch predates specification artifacts gets exposure
 *      'not-recorded' and goal 'not-found', never fabricated values;
 *   3. the record is server-derived: a grader-supplied `evidenceRecord` argument cannot
 *      replace it;
 *   4. a card whose subject is not an agent run carries no evidence record.
 *
 * The derivation's branch logic is unit-covered in agent-run-evidence-record.test.ts.
 * Docker-gated, like every `*.integration.test.ts` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

// Same seam as emit-goal-run-completeness.integration.test.ts: reads AND writes go to the
// migrated throwaway DB.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

// Auditor recruitment is out of scope and must not reach out of the test process.
vi.mock('../../grading-integrity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../grading-integrity')>();
  return {
    ...actual,
    dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
  };
});

// The grading host's generation reads host/deploy state a throwaway DB does not model.
vi.mock('../../scout/generation-watermark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/generation-watermark')>();
  return { ...actual, readRunningGeneration: async () => null };
});

const { emitScorecard } = await import('./emit');
const { listScorecards } = await import('../../scorecards');
const { issuesScopeWorkspace } = await import('../../issues-engineer');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');

const RUBRIC = 'goal-mode-e2e';
const RUBRIC_OWNER = 'su-goal-rubric-owner';
const GRADER = 'su-evidence-record-grader';
const HOLDER_RECORDED = 'su-evidence-holder-recorded';
const HOLDER_LEGACY = 'su-evidence-holder-legacy';
const GOAL_ID = 'restore-backups-goal-9368ec';
const SPEC = 'c'.repeat(64);
const STATE = '0d1ac02554663ebcf2401aed';
const WINDOW = { windowStart: '2026-09-26T10:00:00.000Z', windowEnd: '2026-09-26T12:00:00.000Z' };
const KEYS = ['never-implements', 'settings-are-data'];

const SCALE = ['pass', 'partial', 'fail', 'unknown', 'n/a'];
const criterion = (key: string) => ({
  key,
  title: `Criterion ${key}`,
  model: `The goal agent satisfies ${key}.`,
  method: `Read the run transcript for ${key}.`,
  driftMarkers: `A run that violates ${key}.`,
  ratingScale: SCALE,
});
const rated = () =>
  // unknownReason is required on the goal-behavior rubric (AUTO-BAR-R-3, scorecards.ts
  // validateGoalBehaviorUnknownDisclosure); prose in `evidence` alone is refused at emit.
  Object.fromEntries(
    KEYS.map((k) => [k, { rating: 'unknown', unknownReason: 'not-exercised', evidence: `no observed opportunity for ${k} in the window` }]),
  );

async function upsertGoalRubric(db: OrgTestDb): Promise<void> {
  await db.adminSql`DELETE FROM harness_shared.harness_plans WHERE plan_slug = ${RUBRIC}`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${activeWorkspaceId()}, 'papercusp', ${RUBRIC}, '', md5(${RUBRIC}), 1,
            'Goal mode end-to-end', 'active', '2026-09-10', '2026-09-10', ${RUBRIC_OWNER}, false,
            'rubric',
            ${JSON.stringify({
              kind: 'standard',
              characteristic: 'goal-mode-conduct',
              criteria: KEYS.map(criterion),
              ratingScale: ['pass', 'partial', 'fail', 'unknown'],
              methodRef: 'goal-mode-e2e-grading-runbook',
              description: 'Grades one run of one goal agent.',
            })}::text::jsonb,
            null, 'local')`;
}

async function seedDurableSources(db: OrgTestDb): Promise<void> {
  const ws = activeWorkspaceId();
  await db.adminSql`DELETE FROM harness_shared.goals WHERE workspace_id = ${ws}`;
  await db.adminSql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id IN (${HOLDER_RECORDED}, ${HOLDER_LEGACY})`;
  // The durable goal↔holder link, created before the graded window.
  await db.adminSql`
    INSERT INTO harness_shared.goals (id, install_slug, title, status, created_at, workspace_id, metadata)
    VALUES (${GOAL_ID}, 'papercusp', 'Restore hourly backups', 'active', '2026-09-26T08:00:00Z', ${ws},
            ${JSON.stringify({ agentOwnerId: HOLDER_RECORDED })}::text::jsonb)`;
  // A goal created AFTER the window must not be attributed to it.
  await db.adminSql`
    INSERT INTO harness_shared.goals (id, install_slug, title, status, created_at, workspace_id, metadata)
    VALUES ('later-goal', 'papercusp', 'Later goal', 'active', '2026-09-26T13:00:00Z', ${ws},
            ${JSON.stringify({ agentOwnerId: HOLDER_RECORDED })}::text::jsonb)`;
  // Launch records: an older launch, the one running at the window end, and a later one.
  await db.adminSql`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, started_at, coord_owner_id, launch_spec)
    VALUES
      (${ws}, 'console', '2026-09-26T06:00:00Z', ${HOLDER_RECORDED},
        ${JSON.stringify({ v: 1, model: 'old', specificationRevision: 'd'.repeat(64), stateRevision: 'old-state' })}::text::jsonb),
      (${ws}, 'console', '2026-09-26T09:30:00Z', ${HOLDER_RECORDED},
        ${JSON.stringify({ v: 1, model: 'opus', specificationRevision: SPEC, stateRevision: STATE })}::text::jsonb),
      (${ws}, 'console', '2026-09-26T12:30:00Z', ${HOLDER_RECORDED},
        ${JSON.stringify({ v: 1, model: 'new', specificationRevision: 'e'.repeat(64), stateRevision: 'new-state' })}::text::jsonb),
      (${ws}, 'console', '2026-09-26T09:00:00Z', ${HOLDER_LEGACY},
        ${JSON.stringify({ v: 1, model: 'sonnet', agent: 'claude' })}::text::jsonb)`;
}

async function readBackCards(db: OrgTestDb): Promise<Array<{ observation: Record<string, unknown> }>> {
  return db.adminSql<Array<{ observation: Record<string, unknown> }>>`
    SELECT payload -> 'observation' AS observation
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND payload -> 'observation' ->> 'rubricRef' = ${RUBRIC}
     ORDER BY created_at DESC`;
}

const asGrader = () => ({ createdBy: GRADER, workspaceId: activeWorkspaceId(), ctxHarness: 'papercusp' });

describe('scorecards:emit — an agent-run card carries a server-derived evidence record (R-1), real PG', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
    await db.adminSql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${issuesScopeWorkspace()}`;
    await upsertGoalRubric(db);
    await seedDurableSources(db);
  });

  it('stamps goal, holder, window, launch generation and recorded exposure on the landed card', async () => {
    const r = await emitScorecard(
      { rubricRef: RUBRIC, subject: { kind: 'agent-run', ref: HOLDER_RECORDED, ...WINDOW }, ratings: rated(), terminal: true } as never,
      asGrader() as never,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    const landed = await readBackCards(db);
    expect(landed).toHaveLength(1);
    const rec = landed[0].observation.evidenceRecord as Record<string, unknown>;
    expect(rec).toMatchObject({
      derivedBy: 'server',
      holder: HOLDER_RECORDED,
      window: { start: WINDOW.windowStart, end: WINDOW.windowEnd },
      goalId: GOAL_ID,
      goalSource: 'goals.agentOwnerId',
      sourceGeneration: { model: 'opus', startedAt: '2026-09-26T09:30:00.000Z' },
      instructionExposure: {
        status: 'recorded',
        generation: STATE,
        consumedPayloadHash: `sha256:${SPEC}`,
        source: 'adv_sessions.launch_spec',
      },
    });
    // The emit result surfaces the same record to the grader.
    expect((r as { evidenceRecord?: unknown }).evidenceRecord).toEqual(rec);
  });

  it('records not-found goal and not-recorded exposure for a legacy holder, never fabricated values', async () => {
    const r = await emitScorecard(
      { rubricRef: RUBRIC, subject: { kind: 'agent-run', ref: HOLDER_LEGACY, ...WINDOW }, ratings: rated(), terminal: true } as never,
      asGrader() as never,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    const rec = (await readBackCards(db))[0].observation.evidenceRecord as Record<string, unknown>;
    expect(rec).toMatchObject({ holder: HOLDER_LEGACY, goalId: null, goalSource: 'not-found' });
    expect(rec.instructionExposure).toMatchObject({ status: 'not-recorded' });
    expect(rec.instructionExposure).not.toHaveProperty('consumedPayloadHash');
    expect(rec.sourceGeneration).toMatchObject({ model: 'sonnet' });
  });

  it('a grader-supplied evidenceRecord cannot replace the server-derived one', async () => {
    const forged = {
      goalId: 'forged-goal',
      instructionExposure: { status: 'recorded', generation: 'forged', consumedPayloadHash: 'sha256:forged' },
    };
    const r = await emitScorecard(
      {
        rubricRef: RUBRIC,
        subject: { kind: 'agent-run', ref: HOLDER_LEGACY, ...WINDOW },
        ratings: rated(),
        terminal: true,
        evidenceRecord: forged,
      } as never,
      asGrader() as never,
    );

    // Either the schema refuses the unknown argument, or the card lands with the derived record.
    if ((r as { ok: boolean }).ok) {
      const rec = (await readBackCards(db))[0].observation.evidenceRecord as Record<string, unknown>;
      expect(rec.goalId).toBeNull();
      expect(rec.instructionExposure).toMatchObject({ status: 'not-recorded' });
      expect(JSON.stringify(rec)).not.toContain('forged');
    } else {
      expect(await readBackCards(db)).toEqual([]);
    }
  });

  it('preserves distinct grader and instrument uncertainty reasons through partial emit, storage and canonical readback', async () => {
    const ratings = {
      'never-implements': {
        rating: 'unknown',
        unknownReason: 'not-assessed',
        evidence: 'The grader has not assessed implementation activity yet.',
        nextEvidenceAction: 'Assess implementation activity in the recorded window.',
      },
      'settings-are-data': {
        rating: 'unknown',
        unknownReason: 'instrument-unavailable',
        evidence: 'The settings measurement could not be collected.',
        nextEvidenceAction: 'Restore the settings measurement and collect it again.',
      },
    };
    const r = await emitScorecard(
      { rubricRef: RUBRIC, subject: { kind: 'session', ref: HOLDER_RECORDED }, ratings, terminal: false } as never,
      asGrader() as never,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    const landed = await readBackCards(db);
    expect(landed).toHaveLength(1);
    expect(landed[0].observation.ratings).toMatchObject(ratings);

    const cards = await listScorecards({ rubricRef: RUBRIC, subjectKind: 'session', subjectRef: HOLDER_RECORDED });
    expect(cards).toHaveLength(1);
    expect(cards[0].ratings['never-implements']).toMatchObject({ rating: 'unknown', unknownReason: 'not-assessed' });
    expect(cards[0].ratings['settings-are-data']).toMatchObject({ rating: 'unknown', unknownReason: 'instrument-unavailable' });
  });

  it('a card whose subject is not an agent run carries no evidence record', async () => {
    const r = await emitScorecard(
      { rubricRef: RUBRIC, subject: { kind: 'session', ref: HOLDER_RECORDED }, ratings: rated(), terminal: true } as never,
      asGrader() as never,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    const landed = await readBackCards(db);
    expect(landed).toHaveLength(1);
    expect(landed[0].observation).not.toHaveProperty('evidenceRecord');
    expect(r).not.toHaveProperty('evidenceRecord');
  });
});
