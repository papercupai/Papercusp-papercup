/** Cheap real-PG scope preflight before allocating the native DAO rig. */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidInputError } from '@papercusp/tooldef';
import { insertHiveIfAbsent } from './hive-store';
import { getPlanRow, resolvePlanScope } from './agent-tools/plans/source';
import { readPlanAdmissionGovernanceSnapshot } from './agent-tools/plans/plan-admission-governance-store';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const homeSlug = `zzz-dao-scope-${stamp}`;
const ownerWorkspace = `dao-scope-owner-${stamp}`;
const foreignWorkspace = `dao-scope-foreign-${stamp}`;
const unboundWorkspace = `dao-scope-unbound-${stamp}`;
const proposalSlug = 'dao-scope-proposal-2026-10-11';
let fixture: PlanPgFixture;

describe('DAO native scope preflight against the production plan reader', () => {
  beforeAll(async () => {
    fixture = await setupPlanPgFixture();
    await seedPlan(fixture.admin, ownerWorkspace, homeSlug, proposalSlug,
      `---\ntitle: Scope proposal\nslug: ${proposalSlug}\nstatus: draft\n---\n\n# Scope proposal\n`);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const foreignHive = await insertHiveIfAbsent({ workspaceId: foreignWorkspace, homeSlug,
      pubkeyBase64: publicKey, keychainId: `synthetic-scope:${stamp}`, title: 'Foreign scope preflight' }, fixture.admin);
    expect(foreignHive.created).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (!fixture) return;
    try {
      for (const workspace of [ownerWorkspace, foreignWorkspace]) {
        await cleanupPlans(fixture.admin, workspace, homeSlug);
        await fixture.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${workspace} AND slug = ${homeSlug}`;
      }
    } finally { await fixture.dispose(); }
  });

  it('first proves the proposal exists in the registered owner scope', async () => {
    expect(await resolvePlanScope({ workspaceId: ownerWorkspace, harnessSlug: homeSlug }))
      .toEqual({ workspaceId: ownerWorkspace, harnessSlug: homeSlug });
    expect(await getPlanRow(proposalSlug, { workspaceId: ownerWorkspace, harnessSlug: homeSlug }))
      .toMatchObject({ planSlug: proposalSlug, workspaceId: ownerWorkspace, harnessSlug: homeSlug });
  });

  it('rejects an unbound foreign scope rather than interpreting it as an empty plan result', async () => {
    await expect(getPlanRow(proposalSlug, { workspaceId: unboundWorkspace, harnessSlug: homeSlug }))
      .rejects.toBeInstanceOf(InvalidInputError);
    expect((await readPlanAdmissionGovernanceSnapshot({ workspaceId: unboundWorkspace, potHomeSlug: homeSlug }, fixture.admin)).events)
      .toEqual([]);
  });

  it('resolves a registered foreign Hive but cannot read the owner proposal', async () => {
    expect(await resolvePlanScope({ workspaceId: foreignWorkspace, harnessSlug: homeSlug }))
      .toEqual({ workspaceId: foreignWorkspace, harnessSlug: homeSlug });
    expect(await getPlanRow(proposalSlug, { workspaceId: foreignWorkspace, harnessSlug: homeSlug })).toBeNull();
    expect((await readPlanAdmissionGovernanceSnapshot({ workspaceId: foreignWorkspace, potHomeSlug: homeSlug }, fixture.admin)).events)
      .toEqual([]);
  });
});
