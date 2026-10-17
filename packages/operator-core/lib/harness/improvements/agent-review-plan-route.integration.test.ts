/**
 * EI-218490 — a feature enrolled in agent review before blender:route-idea
 * reused its EI id for plan learning. The plan upsert replaced routed_ref=wi:EI
 * with plan:<slug>, while payload.agentReview.ledgerIdeaId stayed on the EI id;
 * grades then updated plan learning and never advanced the review lifecycle.
 *
 * Pin the complete real-PG lifecycle: enrolled review authority → plan route →
 * deterministic fallback authority → reviewer claim → grade → approval.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// Keep revision notifications inside this isolated fixture; lifecycle/ledger writes are real PG.
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../agent-tools/coordination/inbox-wake', async (orig) => ({
  ...(await orig<typeof import('../../agent-tools/coordination/inbox-wake')>()),
  wakeRecipients: vi.fn(async () => ({ woken: 0 })),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { getIssue, linkIssue } = await import('../../issues-engineer');
const { getWorkItem, mergeWorkItemPayload, releaseWorkItem } = await import('../../work-items');
const { recordRoutedIdea } = await import('../../scout/routed-ledger');
const { runRouteIdea } = await import('../../agent-tools/scout/route-idea');
const { runGradeIdea } = await import('../../agent-tools/scout/grade-idea');
const {
  claimAgentReview,
  enterAgentReview,
  preserveAgentReviewAuthorityBeforePlanRoute,
  resubmitAgentReview,
} = await import('./agent-review');
const { computeAgentReviewTiming, readAgentReviewService } = await import('./flow-metrics');
const { readAgentReviewState } = await import('./agent-review-policy');

const WS = 'ws-agent-review-plan-route';
const HARNESS = 'papercusp';
const ID = 'EI-218490-REGRESSION';
const FALLBACK = `agent-review:${ID}`;
const priorWorkspacePin = process.env.PAPERCUSP_WORKSPACE_ID;

describe('agent-review authority survives a later plan route (EI-218490, real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;

    const now = new Date('2026-08-30T04:00:00.000Z');
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         assignee, assigned_by, assigned_at, payload, found_during, created_by,
         signal_origin, created_at, updated_at, admission)
      VALUES
        (${WS}, ${ID}, 'change', ${`harness:${HARNESS}`},
         'Plan-routed feature under review', 'integration fixture', 'major', 'engineer', 'open',
         NULL, NULL, NULL,
         ${JSON.stringify({
           ideation: { lens: 'cost-leverage' },
           agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: ID, round: 1 },
         })}::text::jsonb,
         NULL, 'su-filer', 'organic', ${now}, ${now}, 'pending')`;
    await recordRoutedIdea({
      ideaId: ID,
      lens: 'agent-review',
      rail: 'improvement',
      routedRef: `wi:${ID}`,
      harnessSlug: HARNESS,
      workspaceId: WS,
      origin: 'agent-review',
      createdBy: 'su-filer',
      title: 'Plan-routed feature under review',
    });
  }, 180_000);

  afterAll(async () => {
    if (priorWorkspacePin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspacePin;
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  afterEach(async () => {
    // The timing census below reads this workspace's complete review population.
    // Each P-002 case owns its two private fixture ids; remove them before another
    // case measures history instead of silently contributing an undated round.
    await db.adminSql`DELETE FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS}
        AND feature_id IN ('EI-BQL-P002-TRIAGE-unheld', 'EI-BQL-P002-TRIAGE-su-peer', 'EI-BQL-P002-SIGNED')`;
    await db.adminSql`DELETE FROM harness_shared.tool_invocations
      WHERE workspace_id=${WS} AND spawn_id='bql-p002-signed-fixture'`;
  });

  it.each([
    ['trusted', 'spawn-url', 'harness', 'judge', 'su-signed', 'ended', null, true],
    ['untrusted', 'spawn-url', 'harness', 'judge', 'su-signed', 'ended', null, false],
    ['trusted', 'bearer', 'harness', 'judge', 'su-signed', 'ended', null, false],
    ['trusted', 'spawn-url', 'system', 'judge', 'su-signed', 'ended', null, false],
    ['trusted', 'spawn-url', 'harness', 'reviewer', 'su-signed', 'ended', null, false],
    ['trusted', 'spawn-url', 'harness', 'judge', 'su-forged', 'ended', null, false],
    ['trusted', 'spawn-url', 'harness', 'judge', 'su-signed', 'parked', null, false],
    ['trusted', 'spawn-url', 'harness', 'judge', 'su-signed', 'ended', 'su-peer', false],
    ['trusted', 'spawn-url', 'harness', 'judge', 'su-signed', 'ended', 'system:judge/su-signed', true],
  ] as const)('P-002 checks persisted signed alias trust=%s auth=%s kind=%s role=%s client=%s state=%s holder=%s', async (trust, authMethod, principalKind, role, client, sessionState, holder, allowed) => {
    const id = 'EI-BQL-P002-SIGNED';
    const submitter = 'system:judge/su-signed';
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, taken_by)
      VALUES (${WS}, ${HARNESS}, ${id}, 'Unvalidated signed report', 'Needs reproduction', 'bug', 'open',
        ${JSON.stringify({ agentReview: { status: 'revision-requested', submittedBy: submitter, ledgerIdeaId: id, round: 1 } })}::jsonb, ${holder})`;
    await db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
       coord_owner_id, principal_kind, principal_auth_method, principal_trust, metadata_json)
      VALUES (${WS}, ${HARNESS}, 'papercusp', 'improvements:capture', ${role}, 'bql-p002-signed-fixture',
        'run:bql-p002', 'ok', ${submitter}, ${principalKind}, ${authMethod}, ${trust},
        ${JSON.stringify({ requestOrigin: { query: { client } } })}::jsonb)`;
    const resolveSubmitterLiveness = vi.fn(async () => ({ sessionState }));
    const result = await resubmitAgentReview({ id, submittedBy: 'su-adopter' }, {
      getWorkItem, mergeWorkItemPayload, releaseWorkItem, resolveSubmitterLiveness,
    } as never);
    const stored = (await getWorkItem(id, HARNESS))!;
    expect(result.resubmitted).toBe(allowed);
    if (allowed) {
      expect(readAgentReviewState(stored.payload)).toMatchObject({ status: 'pending', submittedBy: 'su-adopter', round: 2 });
      expect(stored.assignee).toBeNull();
      expect(stored.payload).toMatchObject({ implementationReadiness: { status: 'unknown' } });
    } else {
      expect(readAgentReviewState(stored.payload)).toMatchObject({ status: 'revision-requested', submittedBy: submitter, round: 1 });
      expect(stored.assignee).toBe(holder);
    }
    if (trust !== 'trusted' || authMethod !== 'spawn-url' || principalKind !== 'harness' || role !== 'judge' || client !== 'su-signed') {
      expect(result).toMatchObject({ reason: 'not-submitter:authority-unknown' });
      expect(resolveSubmitterLiveness).not.toHaveBeenCalled();
    } else {
      expect(resolveSubmitterLiveness).toHaveBeenCalledWith('su-signed', { claimsHeld: holder === submitter });
    }
    expect(stored.payload).not.toHaveProperty('intakeReproduction');
  });

  it.each([null, 'su-peer'])('P-002 recovers triage provenance without accepting a bug or stealing holder %s', async (holder) => {
    const id = `EI-BQL-P002-TRIAGE-${holder ?? 'unheld'}`;
    const now = new Date('2026-10-10T00:00:00.000Z');
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         assignee, payload, created_by, signal_origin, created_at, updated_at, admission)
      VALUES (${WS}, ${id}, 'bug', ${`harness:${HARNESS}`},
        'Unvalidated legacy report', 'Requires a current reproduction receipt', 'minor', 'engineer', 'open',
        ${holder}, ${JSON.stringify({
          _ei: { created_by: 'su-filer' },
          ideaLifecycle: { state: 'triaged', triageDecision: 'gate', triagedAt: now.toISOString() },
          agentReview: { status: 'revision-requested', submittedBy: 'improvement-triage', ledgerIdeaId: id, round: 1 },
        })}::text::jsonb, 'su-filer', 'organic', ${now}, ${now}, 'pending')`;

    const result = await resubmitAgentReview({ id, submittedBy: 'su-filer' });
    const stored = (await getWorkItem(id, HARNESS))!;
    if (holder) {
      expect(result).toMatchObject({ resubmitted: false, reason: 'orphan-revision-held-by-other' });
      expect(stored.assignee).toBe(holder);
      expect(readAgentReviewState(stored.payload)).toMatchObject({ status: 'revision-requested', submittedBy: 'improvement-triage', round: 1 });
    } else {
      expect(result).toMatchObject({ resubmitted: true });
      expect(readAgentReviewState(stored.payload)).toMatchObject({ status: 'pending', submittedBy: 'su-filer', round: 2 });
      expect(stored.payload).toMatchObject({ implementationReadiness: { status: 'unknown', reason: 'agent-review-resubmitted' } });
      expect(stored.assignee).toBeNull();
    }
    expect(stored.kind).toBe('bug');
    expect(stored.payload).not.toHaveProperty('reproduction');
  });

  it('P-030 persists round entry/reset independently of report creation and first ledger routing', async () => {
    const id = 'EI-P030-PERSISTED-TIMING';
    const old = new Date('2026-01-01T00:00:00.000Z');
    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         payload, created_by, signal_origin, created_at, updated_at, admission)
      VALUES (${WS}, ${id}, 'change', ${`harness:${HARNESS}`},
        'Persisted review timing', 'Independent round timing regression', 'minor', 'engineer', 'open',
        '{}'::jsonb, 'su-filer', 'organic', ${old}, ${old}, 'pending')`;

    const before = Date.now();
    expect(await enterAgentReview({ id, submittedBy: 'su-filer', harnessSlug: HARNESS, workspaceId: WS }))
      .toMatchObject({ entered: true });
    const first = readAgentReviewState((await getWorkItem(id, HARNESS))!.payload)!;
    expect(first.timing?.round).toBe(1);
    expect(Date.parse(first.timing!.enteredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(first.timing!.enteredAt)).toBeLessThanOrEqual(Date.now());
    await db.adminSql`UPDATE harness_shared.scout_routed_ideas
      SET routed_at = ${old.getTime()} WHERE idea_id = ${first.ledgerIdeaId}`;
    await enterAgentReview({ id, submittedBy: 'su-filer', harnessSlug: HARNESS, workspaceId: WS });
    expect(readAgentReviewState((await getWorkItem(id, HARNESS))!.payload)!.timing).toEqual(first.timing);

    expect((await claimAgentReview({ id, reviewer: 'su-reviewer', harnessSlug: HARNESS })).claimed).toBe(true);
    expect(await runGradeIdea({ ideaId: first.ledgerIdeaId, grade: 2, feedback: 'Supply the missing reproduction.' },
      { ownerId: 'su-reviewer', role: 'operator' })).toMatchObject({ applied: true,
      agentReview: { status: 'revision-requested' } });
    const revision = readAgentReviewState((await getWorkItem(id, HARNESS))!.payload)!;
    expect(Date.parse(revision.timing!.decidedAt!)).toBeGreaterThanOrEqual(Date.parse(first.timing!.enteredAt));

    // A synthetic submitter may be absent from the liveness oracle, in which case
    // grade reconciliation intentionally retains the reviewer claim. This case
    // exercises round timing, so finish that reviewer claim before simulating the
    // submitter's resubmission; otherwise the fixture resubmits while another agent
    // still holds the row.
    const afterGrade = (await getWorkItem(id, HARNESS))!;
    expect([null, 'su-filer', 'su-reviewer']).toContain(afterGrade.assignee);
    if (afterGrade.assignee === 'su-reviewer') {
      expect(await releaseWorkItem(id, { harness: HARNESS, expectedAssignee: 'su-reviewer' })).not.toBeNull();
    }
    expect([null, 'su-filer']).toContain((await getWorkItem(id, HARNESS))!.assignee);

    const resetBefore = Date.now();
    expect(await resubmitAgentReview({ id, submittedBy: 'su-filer' })).toMatchObject({ resubmitted: true });
    const pending = (await getWorkItem(id, HARNESS))!;
    const second = readAgentReviewState(pending.payload)!;
    expect(second.timing).toEqual({ round: 2, enteredAt: expect.any(String) });
    expect(Date.parse(second.timing!.enteredAt)).toBeGreaterThanOrEqual(resetBefore);
    const nowMs = Date.now();
    const measured = computeAgentReviewTiming({ payload: pending.payload, createdAt: old.toISOString(),
      reviewRoutedAtMs: old.getTime(), nowMs });
    expect(measured).toMatchObject({ round: 2, reviewTimeUnknown: null, revisionAgeMs: null,
      reportAgeMs: nowMs - old.getTime(), ledgerRouteAgeMs: nowMs - old.getTime(),
      reviewWaitMs: nowMs - Date.parse(second.timing!.enteredAt) });
    expect(measured.reviewWaitMs).toBeLessThan(measured.ledgerRouteAgeMs!);
    const [ledger] = await db.adminSql<{ routed_at: number }[]>`
      SELECT routed_at FROM harness_shared.scout_routed_ideas WHERE idea_id = ${first.ledgerIdeaId}`;
    expect(Number(ledger.routed_at)).toBe(old.getTime());

    const service = await readAgentReviewService({ workspaceId: WS, harnessSlug: HARNESS,
      sinceMs: before, nowMs: Date.now(), verifierIds: ['su-reviewer'], verificationSpecs: [] });
    if (service.status === 'unknown') throw new Error(`Historical reader failed: ${JSON.stringify(service.failure)}`);
    expect(service.history).toMatchObject({ priorRounds: 1, recordedRounds: 1, unmeasuredRounds: 0,
      arrivals: 1, outcomes: { approved: 0, revisionRequested: 1 }, outcomesUnknown: 0, invalidReceipts: 0 });

    expect((await claimAgentReview({ id, reviewer: 'su-reviewer', harnessSlug: HARNESS })).claimed).toBe(true);
    expect(await runGradeIdea({ ideaId: first.ledgerIdeaId, grade: 5, feedback: 'The revision is ready.' },
      { ownerId: 'su-reviewer', role: 'operator' })).toMatchObject({ applied: true,
      agentReview: { status: 'approved' } });
    const approved = (await getWorkItem(id, HARNESS))!;
    const terminal = readAgentReviewState(approved.payload)!;
    expect(terminal.timing!.enteredAt).toBe(second.timing!.enteredAt);
    expect(computeAgentReviewTiming({ payload: approved.payload, createdAt: old.toISOString(),
      reviewRoutedAtMs: old.getTime(), nowMs: Date.parse(terminal.timing!.decidedAt!) + 1000 }).reviewWaitMs)
      .toBe(Date.parse(terminal.timing!.decidedAt!) - Date.parse(second.timing!.enteredAt));
  }, 120_000);

  it('P-030 reads independent current-round outcomes and exact-spec pickup dispositions from real PG', async () => {
    const workspaceId = 'ws-p030-service';
    const nowMs = Date.parse('2026-10-08T04:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const sinceMs = nowMs - dayMs;
    const enteredAt = new Date(sinceMs + 60_000).toISOString();
    const decidedAt = new Date(sinceMs + 120_000).toISOString();
    const cases = [
      { id: 'approved', status: 'approved' },
      { id: 'revision', status: 'revision-requested' },
      { id: 'creator', status: 'approved', createdBy: 'su-reviewer' },
      { id: 'implementer', status: 'approved', terminalOwner: 'su-reviewer' },
      { id: 'manual', status: 'approved', gradedBy: 'human' },
      { id: 'legacy', status: 'pending', undated: true },
      { id: 'overdue', status: 'pending', enteredAt: new Date(nowMs - 2 * dayMs).toISOString() },
      { id: 'foreign', status: 'approved', workspaceId: 'other-workspace' },
      { id: 'other-harness', status: 'approved', harnessSlug: 'other-harness' },
    ];
    for (const fixture of cases) {
      const id = `EI-P030-SERVICE-${fixture.id}`;
      const ws = fixture.workspaceId ?? workspaceId;
      const harnessSlug = fixture.harnessSlug ?? HARNESS;
      const payload = { agentReview: { status: fixture.status, submittedBy: 'su-filer', ledgerIdeaId: id, round: 1,
        ...(fixture.undated ? {} : { timing: { round: 1, enteredAt: fixture.enteredAt ?? enteredAt,
          ...(fixture.status === 'pending' ? {} : { decidedAt }) } }) } };
      expect(readAgentReviewState(payload), `Invalid service fixture: ${id}`).not.toBeNull();
      await db.adminSql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
           payload, created_by, signal_origin, created_at, updated_at, admission)
        VALUES (${ws}, ${id}, 'change', ${`harness:${harnessSlug}`}, ${id}, 'service census fixture',
          'minor', 'engineer', 'open', ${JSON.stringify(payload)}::jsonb,
          ${fixture.createdBy ?? 'su-filer'}, 'organic', ${new Date(sinceMs - dayMs)}, ${new Date(nowMs)}, 'pending')`;
      if (fixture.terminalOwner) await db.adminSql`
        UPDATE harness_shared.work_items SET terminal_owner = ${fixture.terminalOwner}
         WHERE workspace_id = ${ws} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      await recordRoutedIdea({ ideaId: id, lens: 'agent-review', rail: 'improvement', routedRef: `wi:${id}`,
        workspaceId: ws, harnessSlug, origin: 'agent-review', createdBy: 'su-filer', title: id });
      if (fixture.status !== 'pending') await db.adminSql`
        UPDATE harness_shared.scout_routed_ideas
           SET human_grade = ${fixture.status === 'approved' ? 5 : 2}, graded_by = ${fixture.gradedBy ?? 'su-reviewer'}
         WHERE workspace_id = ${ws} AND harness_slug = ${harnessSlug} AND idea_id = ${id}`;
    }
    const invocations = [
      { schedulerDisposition: { kind: 'claimed', workItemId: 'WI-VERIFIED', specId: 'verify', revision: 2 } },
      { schedulerDisposition: { kind: 'no-claim', reason: 'no-eligible-work', specId: 'verify', revision: 2 } },
      { schedulerDisposition: { kind: 'no-claim', reason: 'timeout', specId: 'verify', revision: 2 },
        schedulerLateSettlement: { kind: 'claimed', workItemId: 'WI-LATE', settledAt: decidedAt } },
      { schedulerDisposition: { kind: 'claimed', workItemId: 'WI-UNRELATED', specId: 'implementation', revision: 2 } },
      { schedulerDisposition: { kind: 'claimed', workItemId: 'WI-OLD-SPEC', specId: 'verify', revision: 1 } },
      { schedulerDisposition: { kind: 'no-claim', reason: 'unscoped' } },
    ];
    for (const metadata of invocations) await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
         coord_owner_id, invoked_at, duration_ms, metadata_json)
      VALUES (${workspaceId}, ${HARNESS}, 'operator', 'scheduler:get_next', 'su', 'p030-test', 'p030-test', 'ok',
        'su-reviewer', ${new Date(Date.parse(enteredAt))}, 20, ${JSON.stringify(metadata)}::jsonb)`;
    // A complete census must precede every display cap (P-032/R-5): 2,001 extra
    // pending rows must be included, even when a consumer samples at 2,000.
    const bulkPayload = { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'EI-P030-BULK', round: 1,
      timing: { round: 1, enteredAt } } };
    expect(readAgentReviewState(bulkPayload), 'Bulk service fixture must be a valid review').not.toBeNull();
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, payload, created_ts, updated_ts)
      SELECT ${workspaceId}, ${HARNESS}, 'EI-P030-BULK-' || n, 'change', 'open', 'Bulk pending review',
             jsonb_set(${JSON.stringify(bulkPayload)}::jsonb, '{agentReview,ledgerIdeaId}',
               to_jsonb('EI-P030-BULK-' || n)), ${sinceMs}, ${nowMs}
        FROM generate_series(1, 2001) AS n`;
    const service = await readAgentReviewService({ workspaceId, harnessSlug: HARNESS, sinceMs, nowMs,
      verifierIds: ['su-reviewer'], verificationSpecs: [{ specId: 'verify', revision: 2 }] });
    if (service.status === 'unknown') throw new Error(`P-030 reader failed: ${JSON.stringify(service.failure)}`);
    expect(service).toMatchObject({ status: 'known', basis: 'current-review-rounds', currentRounds: 2008,
      arrivals: 2006, arrivalsUnknown: 1, priorRoundsUnmeasured: 0, pending: 2003, pendingTimingUnknown: 1,
      overdueKnown: 1, oldestKnownPendingWaitMs: 2 * dayMs, oldestPendingWaitMs: null,
      outcomes: { approved: 1, revisionRequested: 1 }, outcomesUnknown: 3,
      pickups: { attempts: 3, claimed: 2, noClaim: 1, unknown: 0,
        noClaimReasons: { 'no-eligible-work': 1 } }, unscopedPickupAttempts: 1 });
  }, 120_000);

  it('P-030 preserves an actionable unknown when the persisted reader fails', async () => {
    const savedSql = h.sql;
    h.sql = () => { throw Object.assign(new Error('service reader detector fixture'), { code: 'P030-FIXTURE' }); };
    try {
      expect(await readAgentReviewService({ workspaceId: WS, harnessSlug: HARNESS, sinceMs: 0,
        nowMs: Date.now(), verifierIds: ['su-reviewer'], verificationSpecs: [{ specId: 'verify', revision: 2 }] }))
        .toMatchObject({ status: 'unknown', reason: 'service-read-failed',
          failure: { stage: 'review-census', code: 'P030-FIXTURE', message: 'service reader detector fixture' } });
    } finally { h.sql = savedSql; }
  });

  it('moves review authority before the plan upsert, refuses the colliding bare key, then grades the fallback', async () => {
    const out = await runRouteIdea(
      { featureId: ID, rail: 'plan' },
      { isSuperuser: true, uiClientId: 'su-router', workspaceId: WS, harnessSlug: HARNESS },
      {
        createPlanDraft: vi.fn(async () => ({ slug: 'plan-routed-feature-2026-08-30', created: true })),
        recordRoutedIdea,
        getIssue,
        linkIssue,
        preserveAgentReviewAuthority: preserveAgentReviewAuthorityBeforePlanRoute,
      },
    );
    expect(out).toMatchObject({ ok: true, featureId: ID, planRef: 'plan:plan-routed-feature-2026-08-30' });

    const ledger = await db.adminSql<{
      idea_id: string;
      routed_ref: string;
      origin: string;
      human_grade: number | null;
    }[]>`
      SELECT idea_id, routed_ref, origin, human_grade
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN (${ID}, ${FALLBACK})
       ORDER BY idea_id`;
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ idea_id: ID, routed_ref: 'plan:plan-routed-feature-2026-08-30', origin: 'su-ideate' }),
      expect.objectContaining({ idea_id: FALLBACK, routed_ref: `wi:${ID}`, origin: 'agent-review', human_grade: null }),
    ]));

    const migrated = await getWorkItem(ID, HARNESS);
    expect((migrated!.payload as { agentReview: { ledgerIdeaId: string } }).agentReview.ledgerIdeaId).toBe(FALLBACK);

    const [preClaim] = await db.adminSql<{
      admission: string | null;
      taken_by: string | null;
      review_status: string | null;
    }[]>`
      SELECT admission, taken_by, payload -> 'agentReview' ->> 'status' AS review_status
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${ID}`;
    expect(preClaim).toEqual({ admission: 'pending', taken_by: null, review_status: 'pending' });

    const claimed = await claimAgentReview({ id: ID, reviewer: 'su-reviewer', harnessSlug: HARNESS });
    expect(claimed.claimed).toBe(true);

    const bareGrade = await runGradeIdea(
      { ideaId: ID, grade: 4, feedback: 'This must not land on the historical plan row.' },
      { ownerId: 'su-reviewer', role: 'operator' },
    );
    expect(bareGrade).toMatchObject({
      applied: false,
      reason: 'agent-review-ledger-id-required',
      ledgerIdeaId: FALLBACK,
      gradeWith: { ideaId: FALLBACK },
    });

    const [historicalAfterRefusal] = await db.adminSql<{
      human_grade: number | null;
      human_feedback: string | null;
    }[]>`
      SELECT human_grade, human_feedback
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = ${ID}`;
    expect(historicalAfterRefusal).toEqual({ human_grade: null, human_feedback: null });
    const stillPending = await getWorkItem(ID, HARNESS);
    expect((stillPending!.payload as { agentReview: { status: string } }).agentReview.status).toBe('pending');

    const graded = await runGradeIdea(
      { ideaId: FALLBACK, grade: 5, feedback: 'The proposal is ready for implementation.' },
      { ownerId: 'su-reviewer', role: 'operator' },
    );
    expect(graded).toMatchObject({
      applied: true,
      ideaId: FALLBACK,
      agentReview: { workItemId: ID, status: 'approved', changed: true },
    });

    const approved = await getWorkItem(ID, HARNESS);
    expect((approved!.payload as { agentReview: { status: string; ledgerIdeaId: string } }).agentReview).toMatchObject({
      status: 'approved',
      ledgerIdeaId: FALLBACK,
    });
    expect(approved!.assignee).toBeNull();
  }, 120_000);
});
