/**
 * acceptance-author-identity-edits.integration.test.ts — R-5 / R-10 of plan
 * code-intel-relevance-routing-2026-10-21: recorded edits attributed to a plan
 * (or one of its work-items) put the editor in that plan's implementer set, so
 * the grader exclusion sees it; edits attributed only to another plan do not.
 *
 * WHY real Postgres: the attribution rule (plan_slug OR a work-item of the
 * plan) is one SQL predicate; a fake `sql` would only restate it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { resolvePlanImplementerIdentities } from './acceptance-author-identity';
import {
  resolveAcceptanceGraderEligibility,
  type GraderEligibilityDeps,
} from './agent-tools/scorecards/grader-eligibility';

// The eligibility check reads the rubric revision and the vetting critics
// AFTER the implementer-lineage rail. Neither bears on R-5/R-10, so they are
// pinned to "readable, no critics"; the implementer set itself comes from the
// real resolver against the fixture database below.
vi.mock('./rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('./rubrics')>();
  return { ...real, readRubricPlanRevision: async () => ({ ok: true, revision: 1 }) };
});
vi.mock('./scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./scorecards')>();
  return { ...real, listScorecards: async () => [] };
});

const WS = 'ws-edits';
let fixtureDb: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'impledits' });
  sql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, source_plan_slug text, terminal_owner text,
      taken_by text, last_released_by text, worked_by_history jsonb);
    CREATE TABLE harness_shared.plan_audits (
      workspace_id text NOT NULL, plan_slug text NOT NULL, audit_kind text NOT NULL, created_by text, audit_seq int);
    CREATE TABLE harness_shared.edit_attribution_ledger (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, file text NOT NULL, agent_id text NOT NULL,
      work_item_id text, plan_slug text, ts timestamptz NOT NULL DEFAULT now());
  `);
  await sql`INSERT INTO harness_shared.work_items (workspace_id, feature_id, source_plan_slug, taken_by)
            VALUES (${WS}, 'WI-A1', 'plan-a', 'claimant'), (${WS}, 'WI-B1', 'plan-b', 'other-claimant')`;
  await sql`INSERT INTO harness_shared.plan_audits (workspace_id, plan_slug, audit_kind, created_by, audit_seq)
            VALUES (${WS}, 'plan-a', 'activation', 'auditor', 1)`;
  const edit = (agent: string, opts: { plan?: string; wi?: string; ws?: string }) => sql`
    INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, file, agent_id, plan_slug, work_item_id)
    VALUES (${opts.ws ?? WS}, 'packages/x/shared.ts', ${agent}, ${opts.plan ?? null}, ${opts.wi ?? null})`;
  await edit('plan-editor', { plan: 'plan-a' });
  await edit('item-editor', { wi: 'WI-A1' });
  await edit('other-plan-editor', { plan: 'plan-b' });
  await edit('other-item-editor', { wi: 'WI-B1' });
  await edit('unattributed-editor', {});
  await edit('foreign-workspace-editor', { plan: 'plan-a', ws: 'other-ws' });
});

afterAll(async () => {
  try { await sql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

describe('resolvePlanImplementerIdentities edit attribution', () => {
  it('includes agents whose only link to the plan is recorded edits attributed to the plan or one of its work-items (R-5)', async () => {
    const ids = await resolvePlanImplementerIdentities('plan-a', { workspaceId: WS, sql });
    expect(ids).toEqual(expect.arrayContaining(['plan-editor', 'item-editor', 'claimant', 'auditor']));
  });

  it('does not include agents whose edits are attributed only to other plans, or to no plan (R-10)', async () => {
    const ids = await resolvePlanImplementerIdentities('plan-a', { workspaceId: WS, sql });
    expect(ids).not.toContain('other-plan-editor');
    expect(ids).not.toContain('other-item-editor');
    expect(ids).not.toContain('unattributed-editor');
    expect(ids).not.toContain('foreign-workspace-editor');
    expect(ids).toEqual(['auditor', 'claimant', 'item-editor', 'plan-editor']);
  });

  it('fails closed when the edit ledger cannot be read', async () => {
    await sql.unsafe('ALTER TABLE harness_shared.edit_attribution_ledger RENAME TO edit_attribution_ledger_x');
    try {
      await expect(resolvePlanImplementerIdentities('plan-a', { workspaceId: WS, sql }))
        .rejects.toThrow(/acceptance_lineage_unreadable/);
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.edit_attribution_ledger_x RENAME TO edit_attribution_ledger');
    }
  });
});

describe('acceptance-grader eligibility sees edit attribution end to end', () => {
  // The rubric author is an unrelated identity, so any refusal below can only
  // come from the plan's implementer set, which the real resolver derives from
  // the fixture ledger. Lineage is identity equality here: spawn/rebind edges
  // are covered by acceptance-author-identity.integration.test.ts.
  const rubric = {
    rubricId: 'acceptance-plan-a',
    status: 'active',
    createdBy: 'rubric-author',
    subjectPlan: 'plan-a',
  };
  const deps: GraderEligibilityDeps = {
    sameAcceptanceAuthor: async (a, b) => (a ?? '').trim() === (b ?? '').trim(),
    lineageRelated: async (a, b) => (a ?? '').trim() !== '' && (a ?? '').trim() === (b ?? '').trim(),
    resolvePlanImplementerIdentities: (slug, opts) =>
      resolvePlanImplementerIdentities(slug, { ...opts, workspaceId: WS, sql }),
  };
  const gradeAs = (callerId: string) =>
    resolveAcceptanceGraderEligibility({ rubric, callerId, workspaceId: WS, intent: 'grading', deps });

  it('refuses as an implementer a grader whose only link to the plan is attributed edits (R-5)', async () => {
    for (const editor of ['plan-editor', 'item-editor']) {
      const verdict = await gradeAs(editor);
      expect(verdict.principalImplementers).toContain(editor);
      expect(verdict.refusal?.code).toBe('grader_in_implementer_lineage');
      expect(verdict.refusal?.error).toContain(`plan implementer '${editor}'`);
    }
  });

  it('does not refuse a grader whose edits are attributed only to other plans (R-10)', async () => {
    for (const editor of ['other-plan-editor', 'other-item-editor']) {
      const verdict = await gradeAs(editor);
      expect(verdict.principalImplementers).not.toContain(editor);
      expect(verdict.refusal).toBeNull();
    }
    // Positive control: the same path refuses a plan-attributed editor, so a
    // null refusal above is not an eligibility check that never refuses.
    expect((await gradeAs('plan-editor')).refusal?.code).toBe('grader_in_implementer_lineage');
  });

  it('refuses grading rather than swallowing an unreadable edit ledger (R-11)', async () => {
    await sql.unsafe('ALTER TABLE harness_shared.edit_attribution_ledger RENAME TO edit_attribution_ledger_x');
    try {
      await expect(gradeAs('other-plan-editor')).rejects.toThrow(/acceptance_lineage_unreadable/);
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.edit_attribution_ledger_x RENAME TO edit_attribution_ledger');
    }
  });
});
