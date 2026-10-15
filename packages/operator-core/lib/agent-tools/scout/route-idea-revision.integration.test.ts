/** EI-22044075415554418 — routed revisions stay auditable without bypassing authoring. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

import {
  cleanupPlans,
  registerHarnessProject,
  setupPlanPgFixture,
  type PlanPgFixture,
} from '../plans/__tests__/_pg-tool-fixture';
import { recordCurrentActivationAudit } from '../../plan-audits';
import { createScoutPlanDraft } from '../../scout/scout-plan-draft';
import type { EngineerIssue } from '../../issues-engineer';
import { buildRouteDraftBody, runRouteIdea, type RouteIdeaDeps } from './route-idea';

const WS = 'default';
const HARNESS = 'route-idea-revision-it';

describe('blender:route-idea revision spine', () => {
  let fx: PlanPgFixture;
  let admin: postgres.Sql;

  beforeAll(async () => {
    fx = await setupPlanPgFixture();
    admin = fx.admin;
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
    await admin`
      DELETE FROM harness_shared.plan_audits
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
    await registerHarnessProject(admin, WS, HARNESS);
  }, 180_000);

  afterAll(async () => {
    await admin`
      DELETE FROM harness_shared.plan_audits
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
    await fx?.dispose();
  });

  it.each([
    { authored: false, title: 'Revision spine routed feature', slug: 'revision-spine-routed-feature-2026-09-01', outcome: 'refuses unauthored activation' },
    { authored: true, title: 'Revision spine authored feature', slug: 'revision-spine-authored-feature-2026-09-01', outcome: 'admits authored activation' },
  ])('records the current bytes + resolved session and $outcome', async ({ authored, title, slug }) => {
    const sessionId = authored ? 'session-route-authored-test' : 'session-route-revision-test';
    const requirement = 'The routed plan records current bytes and the resolved session before activation.';
    const issue = {
      id: authored ? 'EI-route-authored' : 'EI-route-revision',
      title,
      body: requirement,
      payload: { ideation: { lens: 'risk-first' } },
      createdBy: 'su-originator',
    } as EngineerIssue;
    const deps = {
      createPlanDraft: (input: Parameters<RouteIdeaDeps['createPlanDraft']>[0]) =>
        createScoutPlanDraft({ ...input, date: '2026-09-01' }),
      recordRoutedIdea: vi.fn(async () => undefined),
      getIssue: vi.fn(async () => issue),
      linkIssue: vi.fn(async () => undefined),
      preserveAgentReviewAuthority: vi.fn(async () => ({ preserved: false, reason: 'not-agent-review' as const })),
      ...(authored ? {
        buildDraftBody: (args: Parameters<typeof buildRouteDraftBody>[0]) => {
          const contract = {
            intent: { request: requirement, sourceRefs: [`session_turn:plan_run:${sessionId}:0`] },
            acceptance: {
              condition: 'The activation audit references the initial revision containing the current plan bytes and resolved session.',
              falsifier: 'The audit accepts a missing revision, stale bytes, or a different session.',
              evidencePlane: 'tree',
              requiredScope: ['P-001'],
              requiredTestLayers: ['integration'],
            },
            verification: {
              method: 'Route a complete authored plan, compare its stored revision with the current bytes and session, then record its activation audit.',
              check: { kind: 'tests', files: ['packages/operator-core/lib/agent-tools/scout/route-idea-revision.integration.test.ts'] },
            },
          };
          const sections = [
            '## Requirements',
            '**R-1 — Routed revision provenance.**',
            '```requirement',
            JSON.stringify(contract),
            '```',
            '## Design',
            'Use the existing route writer to record the initial plan revision and resolved plan_run session. Audit those exact bytes after the Requirements and Design are authored.',
            '### Bar-to-work map for this plan',
            '| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |',
            '',
          ].join('\n\n');
          return buildRouteDraftBody(args).replace('## Phase 1', sections + '## Phase 1');
        },
      } : {}),
    } as unknown as RouteIdeaDeps;
    const ctx = {
      isSuperuser: true,
      uiClientId: 'su-route-revision-test',
      workspaceId: WS,
      harnessSlug: HARNESS,
      planRunSessionId: sessionId,
    };

    const routed = await runRouteIdea({ featureId: issue.id, rail: 'plan' }, ctx, deps);
    expect(routed).toMatchObject({ ok: true, created: true, slug });

    const revisions = await admin<Array<{
      seq: number;
      session_id: string | null;
      session_kind: string | null;
      matches_current: boolean;
    }>>`
      SELECT r.seq, r.session_id, r.session_kind,
             (r.content_hash = p.content_hash AND r.content_snapshot = p.content) AS matches_current
        FROM harness_shared.plan_revisions r
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = r.workspace_id AND p.harness_slug = r.harness_slug
         AND p.plan_slug = r.plan_slug
       WHERE r.workspace_id = ${WS} AND r.harness_slug = ${HARNESS} AND r.plan_slug = ${slug}
       ORDER BY r.seq`;
    expect(revisions).toEqual([{
      seq: 1,
      session_id: sessionId,
      session_kind: 'plan_run',
      matches_current: true,
    }]);

    const audit = await recordCurrentActivationAudit({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: slug,
      createdBy: 'su-route-revision-test',
      classRef: 'plan-class-feature-ship',
      activation: {
        sourceRanges: [{ sourceKind: 'plan_run', sessionId, fromTurn: 0, toTurn: 0 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: [`session_turn:plan_run:${sessionId}:0`],
          requirement,
          planTargets: authored ? ['R-1', 'P-001'] : ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
      summary: 'revision spine exists at route time',
    });
    if (authored) {
      expect(audit, JSON.stringify(audit)).toMatchObject({ ok: true });
      if (audit.ok) expect(audit.auditedPlanRevision.seq).toBe(1);
    } else {
      expect(audit, JSON.stringify(audit)).toMatchObject({ ok: false, error: 'bar_requirements_missing' });
      const audits = await admin`
        SELECT plan_slug FROM harness_shared.plan_audits
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
      expect(audits).toEqual([]);
      const rubrics = await admin`
        SELECT plan_slug FROM harness_shared.harness_plans
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${'acceptance-' + slug}`;
      expect(rubrics).toEqual([]);
    }
  }, 180_000);
});
