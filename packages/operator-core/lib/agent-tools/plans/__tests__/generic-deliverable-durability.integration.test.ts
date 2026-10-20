/**
 * R-9 — platform-held artifacts count as durable deliverables
 * (plan-verification-profiles-2026-10-17 P-003).
 *
 * The ship gate's `ephemeral_deliverable_unbacked` check refuses a plan that cites a
 * presentation-only deliverable (an Artifact URL, a scratch path) without naming a durable
 * companion. A report published to the report library is durable, so `durable source:
 * rpt_…` must satisfy the check — but only while that report really exists. These cases
 * run the gate's own durability function against a private integration database, with the
 * report published through `publishReport`, the same writer `reports:publish` uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { publishReport } from '../../../report-library';
import { evaluateEphemeralDeliverableDurabilityInStore } from '../../../plan-acceptance-gate';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

const WS = DEFAULT_WORKSPACE_ID;
const ARTIFACT_URL = 'https://claude.ai/public/artifacts/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let liveReportId: string;
let retiredReportId: string;

const planCiting = (companion: string) =>
  `## Now\n\nThe audit report was delivered at ${ARTIFACT_URL}.\n\ndurable source: ${companion}\n`;

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  const live = await publishReport(admin, {
    workspaceId: WS,
    title: 'R-9 durable report',
    bodyMd: '# Findings\n\nEvery table was checked.\n',
  });
  liveReportId = live.reportId;
  const retired = await publishReport(admin, {
    workspaceId: WS,
    title: 'R-9 retired report',
    bodyMd: '# Withdrawn\n',
  });
  retiredReportId = retired.reportId;
  await admin`UPDATE harness_shared.report_library SET retired_at = now() WHERE report_id = ${retiredReportId}`;
}, 120_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.report_library WHERE report_id IN (${liveReportId ?? ''}, ${retiredReportId ?? ''})`.catch(() => {});
  }
  await fx?.dispose();
});

describe('ephemeral_deliverable_unbacked accepts platform-held artifacts (R-9)', () => {
  it('a plan whose Artifact URL is backed by a published report satisfies the durability check', async () => {
    const result = await evaluateEphemeralDeliverableDurabilityInStore(planCiting(liveReportId), WS);

    expect(result.references.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ satisfied: true, companions: [liveReportId], unresolvedCompanions: [] });
  });

  it('refuses a report id that does not exist in the library', async () => {
    const result = await evaluateEphemeralDeliverableDurabilityInStore(planCiting('rpt_doesnotexist'), WS);

    expect(result).toMatchObject({ satisfied: false, companions: [], unresolvedCompanions: ['rpt_doesnotexist'] });
  });

  it('refuses a retired report', async () => {
    const result = await evaluateEphemeralDeliverableDurabilityInStore(planCiting(retiredReportId), WS);

    expect(result).toMatchObject({ satisfied: false, unresolvedCompanions: [retiredReportId] });
  });

  it('refuses a report that belongs to another workspace', async () => {
    const result = await evaluateEphemeralDeliverableDurabilityInStore(planCiting(liveReportId), 'zzz-other-workspace');

    expect(result).toMatchObject({ satisfied: false, unresolvedCompanions: [liveReportId] });
  });

  it('leaves a plan with no ephemeral reference untouched', async () => {
    const result = await evaluateEphemeralDeliverableDurabilityInStore('## Now\n\ndurable source: rpt_doesnotexist\n', WS);

    expect(result).toMatchObject({ satisfied: true, references: [], unresolvedCompanions: [] });
  });
});
