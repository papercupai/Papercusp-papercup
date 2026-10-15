/**
 * plan-acceptance-gate-independent-evidence.integration.test.ts
 *
 * verification-system-improvements-2026-10-10 P-008 (D-005), AUTO-BAR-R-8-P-008.
 * Drives the REAL plans:set-plan-status → shipped handler (no gate mock) against the
 * integration baseline DB, on a fixture plan with one mandatory live-plane BAR clause.
 *
 * `force:{reason}` waives the code-truth family (unfinished items, audit, spec proof) so
 * the evaluation reaches the independent-verification door. That door is NOT
 * force-waivable.
 *
 * The rubric-completion flag is switched OFF through its env override for this file. A
 * BAR-derived clause makes the BAR lifecycle applicable, and that lifecycle refuses
 * before the door unless a complete adopted contract (epoch, cohort seed, BAR rubric,
 * vetting, proof, author verdict) is seeded, and no fixture builds one. The door is not
 * gated by that flag, so it still runs, and a plan that clears it really SHIPS (ok:true):
 * a stronger positive control than a later refusal. The BAR-adopted ordering (door
 * before grader recruitment when only grading is missing) is pinned by the unit suite
 * plan-acceptance-gate-independent-evidence.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import setPlanStatusTool from './agent-tools/plans/set-plan-status';
import { DEFAULT_WORKSPACE_ID } from './workspace-registry';
import { runWithWorkspace } from './workspace-als';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import {
  evaluateIndependentVerificationGate,
  INDEPENDENT_VERIFICATION_REQUIRED_AFTER,
} from './independent-verification-gate';
import { bindSpecEvidence, type BindSpecEvidenceInput } from './agent-tools/plans/spec-evidence-store';

// A fresh harness per seed: plan_spec_clause_revisions is append-only (an immutability
// trigger refuses DELETE), so rows cannot be cleaned between tests and must never collide.
const freshHarness = () => `zzz-iv-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let HARNESS = freshHarness();
const SLUG = 'zzz-iv-gate-plan-2026-10-11';
const WS = DEFAULT_WORKSPACE_ID;
const SPEC = 'AUTO-BAR-R-1-P-001';
const IMPLEMENTER = 'su-zzz-iv-implementer';
const FORK = 'su-zzz-iv-implementer-fork';
const OUTSIDER = 'su-zzz-iv-outsider';
const SHIPPER = 'agent-zzz-iv-shipper';
const HEX = (c: string) => c.repeat(64);
const SOURCE_FP = 'src-fp-implementer-observed-build';
const ENV_FP = 'env-fp-live-3070';
// One work-item id per seed, derived from that seed's fresh harness. A work-item id
// names ONE row per workspace (UNIQUE (workspace_id, feature_id), migration 1444,
// scope-unique-identifiers-2026-07-26#P-012), so a constant id re-inserted under a
// fresh harness each seed is a same-workspace twin: the index refuses the second
// seed with 23505, and on a pre-1444 reused container the leftovers block 1444.
const workItemFor = (harness: string) => `WI-${harness}`;
let WORK_ITEM = workItemFor(HARNESS);
const SPEC_FP = HEX('c'); // the clause revision's content_hash

function planBody(): string {
  return `---
title: Independent Verification Fixture
slug: ${SLUG}
created: 2026-10-11
updated: 2026-10-11
status: active
---

# Independent Verification Fixture

## Now

**State:** Implemented; the live bar has implementer proof.

**Next:** Ship once the live proof is independently re-observed.

## Background

Fixture for the P-008 independent-verification ship door.

## Decisions
`;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: SHIPPER, workspaceId: WS },
  } as never;
}

async function ship(): Promise<{ ok?: boolean; error?: string; message?: string }> {
  // The MCP transport wraps every tool call in the caller's workspace ALS
  // (runWithWorkspaceIfConcrete); the gate reads activeWorkspaceId(), not ctx.workspaceId.
  // Without the same scope it would resolve the process-global workspace and never
  // find the fixture plan.
  const res = (await runWithWorkspace(WS, () => setPlanStatusTool.handler({
    harness: HARNESS,
    slug: SLUG,
    status: 'shipped',
    force: { reason: 'R-8 fixture: waive code-truth so the independent-verification door is reached.' },
  } as never, makeCtx()))) as { data: { results: Record<string, unknown>[] } };
  return res.data.results[0] as { ok?: boolean; error?: string; message?: string };
}

async function planStatus(): Promise<string | null> {
  const [row] = await admin<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return row?.status ?? null;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

/** Best-effort, step-independent: one refused step must not strand the rest. */
async function cleanup(): Promise<void> {
  await admin`DELETE FROM harness_shared.spec_evidence_bindings WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
  await admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS} AND coord_owner_id IN (${FORK}, ${OUTSIDER}, ${IMPLEMENTER})`.catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
}

/** A fresh harness holding the plan, its implementer work item, one clause and the edge. */
async function seedBase(plane: 'live' | 'deployed' | 'tree', createdAt: string): Promise<void> {
  await cleanup();
  HARNESS = freshHarness();
  WORK_ITEM = workItemFor(HARNESS);
  await seedPlan(admin, WS, HARNESS, SLUG, planBody());
  // The implementer: the work item that delivered the plan names it.
  await admin`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, nature, source_plan_slug, taken_by, terminal_owner)
    VALUES (${WS}, ${HARNESS}, ${WORK_ITEM}, 'work', ${SLUG}, ${IMPLEMENTER}, ${IMPLEMENTER})`;
  await seedClause(plane, createdAt);
  // spec_evidence_bindings' FK target: the work item's edge to this clause revision.
  await admin`
    INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
    VALUES (${WS}, ${HARNESS}, ${WORK_ITEM}, ${SLUG}, ${SPEC}, 1, ${SPEC_FP}, ${IMPLEMENTER})`;
}

const AFTER_CUTOFF = () => new Date(Date.parse(INDEPENDENT_VERIFICATION_REQUIRED_AFTER) + 60_000).toISOString();
const BEFORE_CUTOFF = () => new Date(Date.parse(INDEPENDENT_VERIFICATION_REQUIRED_AFTER) - 60_000).toISOString();

/** One mandatory BAR-derived clause on the given plane, revision created at `createdAt`. */
async function seedClause(plane: 'live' | 'deployed' | 'tree', createdAt: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`
      INSERT INTO harness_shared.plan_spec_clauses
        (workspace_id, harness_slug, plan_slug, spec_id, created_by, current_revision)
      VALUES (${WS}, ${HARNESS}, ${SLUG}, ${SPEC}, ${IMPLEMENTER}, 1)`;
    await tx`
      INSERT INTO harness_shared.plan_spec_clause_revisions
        (workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id, behavior, behavior_class,
         lifecycle_status, content_hash, created_by, accepted_by, accepted_at, created_at,
         source_bar_key, source_bar_hash, source_bar_set_hash, source_rubric_slug, source_rubric_revision, evidence_plane)
      VALUES (${WS}, ${HARNESS}, ${SLUG}, ${SPEC}, 1, 'P-001',
              'The deployed operator serves the new door.', 'happy-path',
              'active', ${SPEC_FP}, ${IMPLEMENTER}, ${IMPLEMENTER}, ${createdAt}::timestamptz, ${createdAt}::timestamptz,
              'R-1', ${HEX('a')}, ${HEX('b')}, ${`${SLUG}-acceptance`}, 1, ${plane})`;
  });
}

async function bind(opts: {
  kind: string;
  createdBy: string;
  sourceFp?: string;
  envFp?: string | null;
  verifies?: number;
  tag: string;
}): Promise<number> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint,
       evidence_kind, evidence_ref, source_fingerprint, environment_fingerprint, binding_fingerprint,
       created_by, details, verifies_binding_id)
    VALUES (${WS}, ${HARNESS}, ${WORK_ITEM}, ${SLUG}, ${SPEC}, 1, ${SPEC_FP},
            ${opts.kind}, ${`receipt:${opts.tag}`}, ${opts.sourceFp ?? SOURCE_FP},
            ${opts.envFp === undefined ? ENV_FP : opts.envFp},
            encode(sha256(convert_to(${opts.tag}, 'UTF8')), 'hex'),
            ${opts.createdBy}, ${JSON.stringify({ fixture: opts.tag })}::jsonb, ${opts.verifies ?? null})
    RETURNING id`;
  return Number(row!.id);
}

const RUBRIC_GATE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPTANCE_RUBRIC_COMPLETION_GATE';
let prevRubricGateEnv: string | undefined;

beforeAll(async () => {
  prevRubricGateEnv = process.env[RUBRIC_GATE_ENV];
  process.env[RUBRIC_GATE_ENV] = '0';
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanup().catch(() => {});
  await fx?.dispose();
  if (prevRubricGateEnv === undefined) delete process.env[RUBRIC_GATE_ENV];
  else process.env[RUBRIC_GATE_ENV] = prevRubricGateEnv;
});

beforeEach(async () => {
  await seedBase('live', AFTER_CUTOFF());
});

describe('plans:set-plan-status → shipped refuses unverified live/deployed bars (real handler)', () => {
  it('implementer-only proof: independent_verification_missing is present', async () => {
    await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-only' });

    const res = await ship();

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ error: 'independent_verification_missing' });
  });

  it('a verifier whose source/environment fingerprint differs from the cited binding does not count', async () => {
    const implId = await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-mismatch' });
    // Written around the store (which refuses this at bind time) to prove the door
    // re-checks the fingerprints instead of trusting whatever row exists.
    await bind({
      kind: 'independent-verification', createdBy: OUTSIDER, verifies: implId,
      sourceFp: 'src-fp-a-different-build', tag: 'iv-src-mismatch',
    });
    await bind({
      kind: 'independent-verification', createdBy: OUTSIDER, verifies: implId,
      envFp: 'env-fp-a-different-host', tag: 'iv-env-mismatch',
    });

    const res = await ship();

    expect(res).toMatchObject({ error: 'independent_verification_missing' });
  });

  it('a fork of the implementer (spawn lineage) is not independent', async () => {
    const implId = await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-fork' });
    await admin`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
      VALUES (${WS}, 'console', ${FORK}, ${JSON.stringify({ launchedBy: IMPLEMENTER })}::jsonb)`;
    await bind({ kind: 'independent-verification', createdBy: FORK, verifies: implId, tag: 'iv-fork' });

    const res = await ship();

    expect(res).toMatchObject({ error: 'independent_verification_missing' });
  });

  it('an outside-lineage verifier with matching fingerprints clears the door', async () => {
    const implId = await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-valid' });
    await bind({ kind: 'independent-verification', createdBy: OUTSIDER, verifies: implId, tag: 'iv-valid' });

    const res = await ship();

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(await planStatus()).toBe('shipped');
  });

  it('cohort: a live bar revised before the door existed is not in scope', async () => {
    await seedBase('live', BEFORE_CUTOFF());
    await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-legacy' });

    const res = await ship();

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('a tree-plane bar needs no independent re-observation', async () => {
    await seedBase('tree', AFTER_CUTOFF());
    await bind({ kind: 'test', createdBy: IMPLEMENTER, tag: 'impl-tree' });

    const res = await ship();

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('a refused plan is left unshipped', async () => {
    await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'impl-unshipped' });

    await ship();

    expect(await planStatus()).not.toBe('shipped');
  });
});

// SPEC-P-008-INDEPENDENT-EVIDENCE r3: the STORE refuses a malformed independent-verification
// binding at bind time, so the ship door never has to judge one. Lineage is judged only at
// the door (D-023); the store judges citation shape and fingerprint equality.
describe('bindSpecEvidence: independent-verification bindings cite the implementer row they re-observed', () => {
  const ivInput = (over: Partial<BindSpecEvidenceInput> = {}) => ({
    harnessSlug: HARNESS,
    planSlug: SLUG,
    workItemId: WORK_ITEM,
    specId: SPEC,
    evidenceKind: 'independent-verification',
    evidenceRef: 'receipt:outsider-reobserved-live',
    sourceFingerprint: SOURCE_FP,
    environmentFingerprint: ENV_FP,
    actorId: OUTSIDER,
    ...over,
  }) as BindSpecEvidenceInput;
  const store = (over: Partial<BindSpecEvidenceInput> = {}) =>
    runWithWorkspace(WS, () => bindSpecEvidence(ivInput(over)));

  let implementerBinding = 0;
  beforeEach(async () => {
    await seedBase('live', AFTER_CUTOFF());
    implementerBinding = await bind({ kind: 'operational', createdBy: IMPLEMENTER, tag: 'store-impl' });
  });

  it('refuses an independent-verification row that cites nothing (verified_binding_required)', async () => {
    expect(await store()).toMatchObject({ status: 'verified_binding_required' });
  });

  it('refuses a citation on any other evidence kind (verified_binding_not_allowed)', async () => {
    expect(await store({ evidenceKind: 'operational', verifiesBindingId: implementerBinding }))
      .toMatchObject({ status: 'verified_binding_not_allowed' });
  });

  it('refuses a citation of a missing row or of another independent-verification row (verified_binding_not_found)', async () => {
    expect(await store({ verifiesBindingId: 999_999_999 }))
      .toMatchObject({ status: 'verified_binding_not_found', verifiesBindingId: 999_999_999 });
    const ivRow = await bind({
      kind: 'independent-verification', createdBy: OUTSIDER, verifies: implementerBinding, tag: 'store-iv',
    });
    expect(await store({ verifiesBindingId: ivRow }))
      .toMatchObject({ status: 'verified_binding_not_found', verifiesBindingId: ivRow });
  });

  it.each([
    ['source', { sourceFingerprint: 'src-fp-a-different-build' }],
    ['environment', { environmentFingerprint: 'env-fp-staging-3170' }],
  ] as const)('refuses a re-observation whose %s fingerprint differs from the cited binding', async (which, over) => {
    expect(await store({ verifiesBindingId: implementerBinding, ...over })).toMatchObject({
      status: 'independent_fingerprint_mismatch', verifiesBindingId: implementerBinding, mismatched: [which],
    });
  });

  it('persists a matching re-observation with its citation (positive control)', async () => {
    const res = await store({ verifiesBindingId: implementerBinding });
    expect(res).toMatchObject({ status: 'created' });
    const id = (res as { id: number }).id;
    const [row] = await admin<{ verifies_binding_id: string | null; created_by: string }[]>`
      SELECT verifies_binding_id, created_by FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`;
    expect(row).toMatchObject({ created_by: OUTSIDER });
    expect(Number(row!.verifies_binding_id)).toBe(implementerBinding);
  });

  it('the table itself refuses an uncited independent-verification row written around the store', async () => {
    await expect(bind({ kind: 'independent-verification', createdBy: OUTSIDER, tag: 'raw-uncited' })).rejects.toThrow();
  });
});

describe('evaluateIndependentVerificationGate fails closed on an unreadable measurement', () => {
  it('a failed read returns independent_verification_unavailable, never satisfied', async () => {
    const broken = (() => {
      throw new Error('connection reset');
    }) as never;

    const verdict = await evaluateIndependentVerificationGate(
      { planSlug: SLUG, harnessSlug: HARNESS, workspaceId: WS },
      { sql: broken },
    );

    expect(verdict.satisfied).toBe(false);
    expect(verdict.code).toBe('independent_verification_unavailable');
    expect(verdict.readFailure).toContain('connection reset');
  });
});
