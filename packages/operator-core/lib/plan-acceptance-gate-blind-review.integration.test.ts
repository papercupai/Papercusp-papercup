/**
 * plan-acceptance-gate-blind-review.integration.test.ts
 *
 * verification-system-improvements-2026-10-10 P-006 (D-006, D-039): AUTO-BAR-R-6-P-006,
 * SPEC-P-006-BLIND-REVIEW-GATE, -GAP-DISPOSITION, -LEDGER and -SHIP-GATE.
 *
 * Drives the REAL awaiting-acceptance writers (the plans:set-status handler, whose item
 * flip drains the plan in its lock, and applyPlanDrainTransition, the sweep/reaction
 * path) and the REAL plans:set-plan-status → shipped handler against the integration
 * baseline DB, with real rows in plan_audits, plan_blind_reviews, tool_invocations and
 * work_items. Nothing in the door is mocked.
 *
 * As in plan-acceptance-gate-independent-evidence.integration.test.ts, the ship call
 * passes force:{reason} (waives the code-truth family only) and the rubric-completion
 * flag is switched OFF for this file, so a plan that clears the blind door really ships.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';

import setStatusTool from './agent-tools/plans/set-status';
import setPlanStatusTool from './agent-tools/plans/set-plan-status';
import blindReviewTool from './agent-tools/plans/blind-review';
import { applyPlanDrainTransition } from './agent-tools/plans/plan-drain-transition';
import { DEFAULT_WORKSPACE_ID } from './workspace-registry';
import { runWithWorkspace } from './workspace-als';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { BLIND_REVIEW_REQUIRED_AFTER, evaluateBlindReviewGate } from './blind-review-gate';

const WS = DEFAULT_WORKSPACE_ID;
const IMPLEMENTER = 'su-zzz-br-implementer';
const REVIEWER = 'su-zzz-br-blind-reviewer';
const PEEKER = 'su-zzz-br-peeker';
const WRAPPED_PEEKER = 'su-zzz-br-wrapped-peeker';
const AUTHOR = 'agent-zzz-br-author';
const HEX = (c: string) => c.repeat(64);
const sqlRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
const outcomeMigrationPath = new URL('1564-blind-review-outcomes.sql', sqlRoot);
const outcomeMigration = readFileSync(existsSync(outcomeMigrationPath) ? outcomeMigrationPath : new URL('1564-blind-review-outcomes.sql.DRAFT', sqlRoot), 'utf8');
const RUBRIC_GATE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPTANCE_RUBRIC_COMPLETION_GATE';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let prevRubricGateEnv: string | undefined;
let HARNESS = '';
let SLUG = '';

function planBody(slug: string): string {
  return `---
title: Blind Review Fixture
slug: ${slug}
created: 2026-10-11
updated: 2026-10-11
status: active
---

# Blind Review Fixture

## Now

**State:** Implementing.

**Next:** Finish P-002, then acceptance.

## Items

- **P-001** \`done\` Export every invoice as CSV.
- **P-002** \`wip\` Make the export work offline.

## Decisions

### D-001 — Offline export on flaky networks is an accepted risk
Date: 2026-10-11
Accepted risk for the blind-review fixture.
`;
}

function ctxAs(ownerId: string) {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: ownerId, workspaceId: WS },
    ownerId,
    coordOwnerId: ownerId,
  } as never;
}

type ToolResult = { content?: Array<{ text: string }>; data?: { results: Record<string, unknown>[] } };

async function flipItem(itemId: string, status: string): Promise<Record<string, unknown>> {
  // set-status emits this intentional timing diagnostic only when a flip crosses
  // its slow-path threshold. This fixture checks blind-review behavior; the
  // separate latency investigation owns that signal. Keep every other warning red.
  const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (typeof message === 'string' && message.startsWith('[plans:set-status] slow ')) return;
    throw new Error('unexpected warning during blind-review fixture flip: ' + String(message));
  });
  try {
    const res = (await runWithWorkspace(WS, () => setStatusTool.handler({
      harness: HARNESS, slug: SLUG, item: itemId, status, note: 'blind-review fixture flip',
    } as never, ctxAs(AUTHOR)))) as ToolResult;
    return (res.data?.results?.[0] ?? JSON.parse(res.content?.[0]?.text ?? '{}')) as Record<string, unknown>;
  } finally {
    warn.mockRestore();
  }
}

async function blindReview(ownerId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await runWithWorkspace(WS, () => blindReviewTool.handler(
    { harness: HARNESS, slug: SLUG, ...(args.op === 'post' ? { outcome: 'conclusive' } : {}), ...args } as never, ctxAs(ownerId),
  ))) as ToolResult;
  return JSON.parse(res.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

async function ship(): Promise<{ ok?: boolean; error?: string; message?: string }> {
  const res = (await runWithWorkspace(WS, () => setPlanStatusTool.handler({
    harness: HARNESS, slug: SLUG, status: 'shipped',
    force: { reason: 'P-006 fixture: waive code-truth so the blind gap review door is reached.' },
  } as never, ctxAs(AUTHOR)))) as { data: { results: Record<string, unknown>[] } };
  return res.data.results[0] as { ok?: boolean; error?: string; message?: string };
}

async function planStatus(): Promise<string | null> {
  const [row] = await admin<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return row?.status ?? null;
}

async function seedActivationAudit(seq: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
       audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
    VALUES (${WS}, ${HARNESS}, ${SLUG}, ${seq}, ${AUTHOR}, 'activation',
            ${admin.json({ mappings: [], sourceRanges: [] } as never)}, ${seq}, ${seq}, ${HEX('d')})`;
}

/** A tool_invocations row as the MCP transport records it. */
async function recordCall(ownerId: string, toolName: string, args: Record<string, unknown>, at = new Date(Date.now() - 60_000)): Promise<void> {
  await admin`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, args_json, coord_owner_id, invoked_at)
    VALUES (${WS}, ${HARNESS}, 'papercusp', ${toolName}, 'su', 'zzz-br-spawn', 'zzz-br', 'ok',
            ${admin.json(args as never)}, ${ownerId}, ${at})`;
}

async function cleanup(): Promise<void> {
  if (!SLUG) return;
  await admin`DELETE FROM harness_shared.plan_blind_reviews WHERE workspace_id = ${WS} AND plan_slug = ${SLUG}`.catch(() => {});
  await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND plan_slug = ${SLUG}`.catch(() => {});
  await admin`DELETE FROM harness_shared.tool_invocations WHERE window_key = 'zzz-br' AND coord_owner_id LIKE 'su-zzz-br-%'`.catch(() => {});
  await admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
}

/** Fresh plan (created now: inside the cohort), its implementer, and activation audit #1. */
async function seed(): Promise<void> {
  await cleanup();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  HARNESS = `zzz-br-${tag}`;
  SLUG = `zzz-br-plan-${tag}`;
  await seedPlan(admin, WS, HARNESS, SLUG, planBody(SLUG));
  await admin`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, nature, source_plan_slug, taken_by, terminal_owner)
    VALUES (${WS}, ${HARNESS}, ${`WI-${HARNESS}`}, 'work', ${SLUG}, ${IMPLEMENTER}, ${IMPLEMENTER})`;
  await seedActivationAudit(1);
}

beforeAll(async () => {
  prevRubricGateEnv = process.env[RUBRIC_GATE_ENV];
  process.env[RUBRIC_GATE_ENV] = '0';
  // This file applies real DDL; never change a shared integration baseline.
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  const [column] = await admin`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'plan_blind_reviews' AND column_name = 'protocol_version'`;
  if (!column) await admin.begin((tx) => tx.unsafe(outcomeMigration));
}, 60_000);

afterAll(async () => {
  await cleanup().catch(() => {});
  await fx?.dispose();
  if (prevRubricGateEnv === undefined) delete process.env[RUBRIC_GATE_ENV];
  else process.env[RUBRIC_GATE_ENV] = prevRubricGateEnv;
});

describe('P-006 blind gap review door — real awaiting-acceptance writers and ship handler', () => {
  it('keeps historical material and switches old and new concurrent writers to v2 atomically', async () => {
    const schema = `zzz_br_protocol_${Date.now()}`;
    const table = `${schema}.plan_blind_reviews`;
    const rewrite = (sql: string) => sql.replaceAll('harness_shared', schema);
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    let ddl: Awaited<ReturnType<typeof admin.reserve>> | undefined;
    let writer: Awaited<ReturnType<typeof admin.reserve>> | undefined;
    let lateInsert: Promise<unknown> | undefined;
    try {
      await admin.unsafe(rewrite(readFileSync(new URL('1453-plan-blind-reviews.sql', sqlRoot), 'utf8')));
      await admin.unsafe(rewrite(readFileSync(new URL('1560-plan-blind-review-resume-bindings.sql', sqlRoot), 'utf8')));
      await admin.unsafe(`INSERT INTO ${table}
        (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,gaps,summary,created_by,idempotency_key)
        VALUES ('ws','h','p','review',5,'[]','Completed product review','su-old','old-1'),
               ('ws','h','p','review',5,'[]','INCONCLUSIVE: product blocked','su-blocked','old-2')`);
      const before = await admin.unsafe(`SELECT * FROM ${table} ORDER BY id`);
      ddl = await admin.reserve();
      writer = await admin.reserve();
      await ddl`BEGIN`;
      await ddl.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      const [{ pid }] = await writer`SELECT pg_backend_pid() AS pid`;
      lateInsert = writer.unsafe(`INSERT INTO ${table}
        (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,created_by)
        VALUES ('ws','h','p','review',5,'su-late-old')`).then(() => undefined);
      // Prove a real old-shape insert is waiting on the migration's lock.
      await vi.waitFor(async () => {
        // Both pool slots are reserved; inspect using the lock holder itself.
        const [blocked] = await ddl!`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
        expect(blocked.blocked).toBe(true);
      }, { timeout: 5000 });
      await ddl.unsafe(rewrite(outcomeMigration));
      await ddl`COMMIT`;
      await lateInsert;
      await writer.unsafe(`INSERT INTO ${table}
        (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,created_by,outcome)
        VALUES ('ws','h','p','review',5,'su-late-new','conclusive')`);
      const after = await ddl.unsafe(`SELECT * FROM ${table} ORDER BY id`);
      expect(after.slice(0, 2).map(({ protocol_version, outcome, ...material }) => material)).toEqual([...before]);
      expect(after.map((r) => [r.protocol_version, r.outcome])).toEqual([[1, null], [1, null], [2, null], [2, 'conclusive']]);
      await expect(ddl.unsafe(`UPDATE ${table} SET summary='rewritten' WHERE id=1`)).rejects.toThrow('append-only');
    } finally {
      await ddl?.unsafe('ROLLBACK').catch(() => {});
      await lateInsert?.catch(() => {});
      ddl?.release();
      writer?.release();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  }, 60_000);

  it('an explicitly inconclusive empty-gap receipt cannot drain or ship', async () => {
    await seed();
    const receipt = await blindReview(REVIEWER, { op: 'post', outcome: 'inconclusive', gaps: [], summary: 'INCONCLUSIVE: product could not be exercised' });
    expect(receipt).toMatchObject({ ok: true, counts: false, rejected: { reason: 'inconclusive' } });
    const flipped = await flipItem('P-002', 'done');
    expect(flipped.acceptanceBlocked).toMatchObject({ code: 'blind_review_missing' });
    expect(await runWithWorkspace(WS, () => applyPlanDrainTransition(SLUG, HARNESS)))
      .toMatchObject({ applied: false, skipped: 'blind_review_missing' });
    expect(await ship()).toMatchObject({ ok: false, error: 'blind_review_missing' });
    const retry = await blindReview(REVIEWER, { op: 'post', outcome: 'conclusive', gaps: [] });
    expect(retry).toMatchObject({ error: 'idempotency_conflict' });
  }, 60_000);

  it('retains valid v1 eligibility while legacy inconclusive and outcome-less late writers fail closed', async () => {
    await seed();
    await admin`INSERT INTO harness_shared.plan_blind_reviews
      (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,created_by,protocol_version,summary)
      VALUES (${WS},${HARNESS},${SLUG},'review',1,${REVIEWER},1,'INCONCLUSIVE: UI blocked')`;
    // Old writer shape AFTER upgrade must never inherit legacy eligibility.
    await admin`INSERT INTO harness_shared.plan_blind_reviews
      (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,created_by)
      VALUES (${WS},${HARNESS},${SLUG},'review',1,'su-zzz-br-late-writer')`;
    const rejected = await runWithWorkspace(WS, () => evaluateBlindReviewGate({ workspaceId: WS, planSlug: SLUG, harnessSlug: HARNESS }));
    expect(rejected).toMatchObject({ satisfied: false, code: 'blind_review_missing', acceptedReviewIds: [] });
    expect(rejected.rejectedReviews.map((r) => r.reason)).toEqual(['inconclusive', 'invalid-completion']);
    const [legacy] = await admin`INSERT INTO harness_shared.plan_blind_reviews
      (workspace_id,harness_slug,plan_slug,record_kind,activation_audit_seq,created_by,protocol_version,summary)
      VALUES (${WS},${HARNESS},${SLUG},'review',1,'su-zzz-br-legacy',1,'Completed product review') RETURNING id`;
    const accepted = await runWithWorkspace(WS, () => evaluateBlindReviewGate({ workspaceId: WS, planSlug: SLUG, harnessSlug: HARNESS }));
    expect(accepted).toMatchObject({ satisfied: true, acceptedReviewIds: [Number(legacy.id)] });
  }, 60_000);
  it('R-6 / BLIND-REVIEW-GATE: with no review recorded, the drain flip returns blind_review_missing and the plan stays put', async () => {
    await seed();
    const flipped = await flipItem('P-002', 'done');
    expect(flipped.ok).toBe(true);
    expect(flipped.newStatus).toBe('done');
    expect(flipped.acceptanceBlocked).toMatchObject({ code: 'blind_review_missing' });
    expect(await planStatus()).not.toBe('awaiting-acceptance');

    // The sweep/reaction writer refuses the same move.
    const swept = await runWithWorkspace(WS, () => applyPlanDrainTransition(SLUG, HARNESS));
    expect(swept).toMatchObject({ applied: false, skipped: 'blind_review_missing', to: 'awaiting-acceptance' });
    expect(await planStatus()).not.toBe('awaiting-acceptance');
  }, 60_000);

  it('LEDGER / R-6: a review whose reviewer read the plan (directly or via tools:invoke) before posting does not count', async () => {
    await seed();
    await recordCall(PEEKER, 'plans:get', { slug: SLUG, harness: HARNESS });
    await recordCall(WRAPPED_PEEKER, 'tools:invoke', { name: 'rubrics:get', args: { slug: `acceptance-${SLUG}` } });
    // A brief fetched through the sanctioned blind surface is NOT a read of the plan.
    await recordCall(REVIEWER, 'plans:blind-review', { slug: SLUG, op: 'brief' });

    const peeked = await blindReview(PEEKER, { op: 'post', gaps: [] });
    expect(peeked).toMatchObject({ ok: true, counts: false, rejected: { reason: 'read-plan-artifacts' } });
    const wrapped = await blindReview(WRAPPED_PEEKER, { op: 'post', gaps: [] });
    expect(wrapped).toMatchObject({ ok: true, counts: false, rejected: { reason: 'read-plan-artifacts' } });
    const implementer = await blindReview(IMPLEMENTER, { op: 'post', gaps: [] });
    expect(implementer).toMatchObject({ ok: true, counts: false, rejected: { reason: 'owner-or-implementer' } });

    const flipped = await flipItem('P-002', 'done');
    expect(flipped.acceptanceBlocked).toMatchObject({ code: 'blind_review_missing' });
    expect(await planStatus()).not.toBe('awaiting-acceptance');

    // Positive control: the clean reviewer's post counts and the sweep moves the plan.
    const clean = await blindReview(REVIEWER, { op: 'post', activationAuditSeq: 1, gaps: [] });
    expect(clean).toMatchObject({ ok: true, counts: true, door: { satisfied: true } });
    const swept = await runWithWorkspace(WS, () => applyPlanDrainTransition(SLUG, HARNESS));
    expect(swept).toMatchObject({ applied: true, to: 'awaiting-acceptance' });
    expect(await planStatus()).toBe('awaiting-acceptance');
  }, 60_000);

  it('GAP-DISPOSITION: no awaiting-acceptance while a gap has neither a plan item nor an accepted-risk Decision', async () => {
    await seed();
    const posted = await blindReview(REVIEWER, {
      op: 'post', activationAuditSeq: 1,
      gaps: [{ text: 'Exported CSV drops the currency column.' }, { text: 'Offline export fails on a flaky network.' }],
    });
    expect(posted).toMatchObject({ ok: true, counts: true, gapIds: ['G-1', 'G-2'], door: { code: 'blind_review_gap_undispositioned' } });
    const reviewId = posted.id as number;

    const flipped = await flipItem('P-002', 'done');
    expect(flipped.acceptanceBlocked).toMatchObject({ code: 'blind_review_gap_undispositioned' });
    expect(await planStatus()).not.toBe('awaiting-acceptance');

    // A disposition to an item or decision that does not exist is refused at write time.
    const bad = await blindReview(AUTHOR, { op: 'dispose', dispositions: [{ reviewId, gapId: 'G-1', itemId: 'P-099' }] });
    expect(bad).toMatchObject({ error: 'disposition_target_missing' });

    // One gap dispositioned: still refused.
    await blindReview(AUTHOR, { op: 'dispose', dispositions: [{ reviewId, gapId: 'G-1', itemId: 'P-001' }] });
    const half = await runWithWorkspace(WS, () => applyPlanDrainTransition(SLUG, HARNESS));
    expect(half).toMatchObject({ applied: false, skipped: 'blind_review_gap_undispositioned' });

    // Both dispositioned: the move happens.
    const done = await blindReview(AUTHOR, { op: 'dispose', dispositions: [{ reviewId, gapId: 'G-2', acceptedRiskDecisionId: 'D-001' }] });
    expect(done).toMatchObject({ ok: true, door: { satisfied: true } });
    const swept = await runWithWorkspace(WS, () => applyPlanDrainTransition(SLUG, HARNESS));
    expect(swept).toMatchObject({ applied: true, to: 'awaiting-acceptance' });
    expect(await planStatus()).toBe('awaiting-acceptance');
  }, 60_000);

  it('SHIP-GATE: ship refuses blind_review_missing for a revision with no review, and ships once one is recorded', async () => {
    await seed();
    // Never passed through awaiting-acceptance and never reviewed.
    const refused = await ship();
    expect(refused.ok).not.toBe(true);
    expect(refused.error).toBe('blind_review_missing');

    // Reviewed at activation audit #1, then re-activated (#2): the review no longer covers it.
    await blindReview(REVIEWER, { op: 'post', activationAuditSeq: 1, gaps: [] });
    await seedActivationAudit(2);
    const stale = await ship();
    expect(stale.error).toBe('blind_review_missing');
    const verdict = await runWithWorkspace(WS, () => evaluateBlindReviewGate({ planSlug: SLUG, harnessSlug: HARNESS }));
    expect(verdict).toMatchObject({ code: 'blind_review_missing', activationAuditSeq: 2 });

    // A brief built for #1 cannot be posted against #2.
    const mismatched = await blindReview(REVIEWER, { op: 'post', activationAuditSeq: 1, gaps: [] });
    expect(mismatched).toMatchObject({ error: 'activation_audit_mismatch' });

    // Positive control: a review of #2 clears the door and the plan ships.
    await blindReview(REVIEWER, { op: 'post', activationAuditSeq: 2, gaps: [] });
    const shipped = await ship();
    expect(shipped.error).toBeUndefined();
    expect(shipped.ok).toBe(true);
    expect(await planStatus()).toBe('shipped');
  }, 90_000);

  it('a plan created before the cohort cutoff, with no review recorded, drains without one', async () => {
    await seed();
    await admin`
      UPDATE harness_shared.harness_plans
         SET created_at = ${new Date(Date.parse(BLIND_REVIEW_REQUIRED_AFTER) - 3_600_000)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const flipped = await flipItem('P-002', 'done');
    expect(flipped.acceptanceBlocked).toBeUndefined();
    expect(await planStatus()).toBe('awaiting-acceptance');
  }, 60_000);
});
