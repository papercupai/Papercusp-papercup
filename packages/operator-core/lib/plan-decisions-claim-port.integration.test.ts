import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from './agent-tools/plans/with-plan-lock';
import {
  registerHarnessProject,
  setupPlanPgFixture,
  type PlanPgFixture,
} from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { getClaimTimePlanDecisions, renderPlanDecisionsNote } from './plan-decisions-claim-port';

const HARNESS = `zzz-affects-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TARGET = 'affected-authority-target';
const SOURCE = 'affected-authority-source';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let workspaceId: string;

function plan(slug: string, decisions: string): string {
  return `---
title: ${slug}
slug: ${slug}
status: draft
created: 2026-09-07
updated: 2026-09-07
---

## Now

**State:** verifying
**Next:** none

## Phase 1

- **P-001** \`todo\` verify authority

## Decisions

${decisions}
`;
}

async function write(slug: string, content: string): Promise<void> {
  const result = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent: 'affected authority integration fixture', harnessSlug: HARNESS, workspaceId, ttlSec: 30 },
    async () => ({ newBody: content, value: { ok: true } }),
  );
  if (result.kind !== 'applied') throw new Error(`plan fixture write failed: ${JSON.stringify(result)}`);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  workspaceId = fx.workspaceId;
  await registerHarnessProject(admin, workspaceId, HARNESS);
});

afterAll(async () => {
  await admin`DELETE FROM harness_shared.harness_plans
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS}`;
  await fx.dispose();
});

describe('cross-plan affects authority at claim time', () => {
  it('reads the derived reverse edge and orders source-qualified authority before local decisions', async () => {
    await write(
      TARGET,
      plan(TARGET, '### D-001 — local ruling\nDate: 2026-09-07\nlocal body'),
    );
    await write(
      SOURCE,
      plan(
        SOURCE,
        `### D-009 — inbound authority\nDate: 2026-09-07\nAffects: ${TARGET}\nsource body`,
      ),
    );

    const brief = await getClaimTimePlanDecisions({
      planSlug: TARGET,
      harness: HARNESS,
      workspaceId,
    });

    expect(brief?.decisions.map((decision) => decision.id)).toEqual(['D-009', 'D-001']);
    expect(brief?.decisions[0]).toMatchObject({
      sourcePlanSlug: SOURCE,
      ref: `${SOURCE}#D-009`,
      relation: 'affects',
    });
    expect(renderPlanDecisionsNote(brief!)).toMatch(
      /^⚠ CROSS-PLAN AUTHORITY CONFLICT\/SUPERSESSION WARNING:/,
    );
  });
});
