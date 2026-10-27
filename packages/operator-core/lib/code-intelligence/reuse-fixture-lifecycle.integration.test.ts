/** D039: canonical fixture disposal against a private migrated database.
 * These are lifecycle safety checks, never an R20 native/staging witness.
 */
import { readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, registerHarnessProject, seedPlan,
  type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { recordAdvSession, markAdvSessionEnded } from '../adv-sessions';
import { createWorkItem, getWorkItem } from '../work-items';
import { loadHarnessRegistry, mutateHarnessRegistry } from '../harness-registry';
import { runWithWorkspace } from '../workspace-als';
import { cleanupReuseFixture, createReuseFixture, trackReuseFixture, reuseFixtureLifecyclePorts,
  type ReuseFixtureIdentity } from './reuse-fixture-lifecycle';
import { recordReuseBriefIssued } from './reuse-brief-ledger';

// The canonical terminal CAS remains real. Its delayed external housekeeping
// is independently covered by the session lifecycle suites.
vi.mock('../session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: vi.fn() }));
vi.mock('../session-archive-hook', () => ({ scheduleArchiveForAdvSession: vi.fn() }));

let fx: PlanPgFixture;
const fixtures: ReuseFixtureIdentity[] = [];
beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 180_000);
afterAll(async () => {
  await fx?.dispose();
  for (const owned of fixtures) {
    await rm(owned.root, { recursive: true, force: true });
    await rm(owned.evidenceRoot, { recursive: true, force: true });
  }
});

async function prepare(workspace = 'reuse-lifecycle', owner = 'su-reuse-lifecycle') {
  const owned = await createReuseFixture(workspace, owner); fixtures.push(owned);
  const harness = { slug: `r-${owned.token.slice(0, 8)}`, path: owned.root,
    registrationOnly: { commitSha: 'a'.repeat(40) } };
  await trackReuseFixture(owned, { harness });
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, harness] }), workspace);
  // Standard private-PG fixture scope; no live registry or database is used.
  await registerHarnessProject(fx.admin, workspace, harness.slug);
  const plan = `fixture-${owned.token}`;
  await seedPlan(fx.admin, workspace, harness.slug, plan, 'Retained fixture planning proof');
  const item = await runWithWorkspace(workspace, () => createWorkItem({ kind: 'task',
    title: 'Controlled fixture claim', harness: harness.slug, workspaceId: workspace, assignee: owner }));
  await trackReuseFixture(owned, { claim: { id: item.id, harness: harness.slug } });
  const id = Number(await recordAdvSession({ workspaceId: workspace, coordOwnerId: owner,
    sessionId: `fixture-${owned.token}`, cwd: owned.root, planSlug: plan, mode: 'console' }));
  expect(id).toBeGreaterThan(0);
  const session = (await reuseFixtureLifecyclePorts.readSession(id))!;
  await trackReuseFixture(owned, { session });
  return { owned, harness, item, session, plan };
}

it('disposes only exact runtime resources and retains issued and planning proof through retry', async () => {
  const own = await prepare();
  const siblingOwner = await prepare(own.owned.workspaceId, 'su-sibling');
  const siblingWorkspace = await prepare('reuse-sibling-workspace', own.owned.owner);
  // A real ledger writer with a test-only turn fixture. This seeded turn is
  // deliberately not evidence of a native CLI or model invocation.
  await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id,owner_id,turn_id)
    VALUES (${own.owned.workspaceId},${own.owned.owner},'lifecycle-test-turn')`;
  expect(await recordReuseBriefIssued({ context: {
    surface: 'claim', workspaceId: own.owned.workspaceId, owner: own.owned.owner,
    invocation: own.owned.token, workItem: own.item.id, plan: own.plan, paths: ['a.ts'],
    sourceVersion: 'a'.repeat(64), repository: { workspaceId: own.owned.workspaceId,
      harness: own.harness.slug, rootPath: own.owned.root },
  }, observations: [{ provider: 'clones', status: 'issued', reason: 'complete',
    sourceVersion: 'a'.repeat(64), indexVersion: 'i1', chars: 20, citedPaths: ['a.ts'] }],
  recover: { tool: 'work_items:get', args: { id: own.item.id, harness: own.harness.slug } },
  }, new AbortController().signal)).toBe(true);
  const proof = async () => ({
    issued: await fx.admin`SELECT * FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${own.owned.workspaceId} AND owner_id = ${own.owned.owner}`,
    planning: await fx.admin`SELECT * FROM harness_shared.harness_plans
      WHERE workspace_id = ${own.owned.workspaceId} AND harness_slug = ${own.harness.slug}`,
  });
  const before = await proof();
  expect(before.issued).toHaveLength(1); expect(before.planning).toHaveLength(1);
  // JSONB canonicalizes key order, unlike the filesystem journal. Exact
  // identity must compare values rather than object serialization order.
  expect(await reuseFixtureLifecyclePorts.readHarness(own.owned.workspaceId, own.harness.slug)).toEqual(own.harness);
  await cleanupReuseFixture(own.owned);
  await cleanupReuseFixture(own.owned);
  await expect(lstat(own.owned.root)).rejects.toMatchObject({ code: 'ENOENT' });
  const journal = JSON.parse(await readFile(join(own.owned.evidenceRoot, 'lifecycle.json'), 'utf8'));
  expect(journal).toMatchObject({ cleaned: true, token: own.owned.token, sessions: [{ id: own.session.id }],
    claims: [{ id: own.item.id }] });
  expect(await proof()).toEqual(before);
  expect(await reuseFixtureLifecyclePorts.readSession(own.session.id)).toMatchObject({ ended: true });
  expect(await runWithWorkspace(own.owned.workspaceId, () => getWorkItem(own.item.id, own.harness.slug)))
    .toMatchObject({ assignee: null });
  expect((await loadHarnessRegistry(own.owned.workspaceId, { fresh: true })).projects)
    .toEqual([siblingOwner.harness]);
  for (const sibling of [siblingOwner, siblingWorkspace]) {
    expect(await reuseFixtureLifecyclePorts.readSession(sibling.session.id)).toMatchObject({ ended: false });
    expect(await runWithWorkspace(sibling.owned.workspaceId, () => getWorkItem(sibling.item.id, sibling.harness.slug)))
      .toMatchObject({ assignee: sibling.owned.owner });
    expect((await lstat(sibling.owned.root)).isDirectory()).toBe(true);
    await cleanupReuseFixture(sibling.owned);
  }
}, 90_000);

it.each(['workspaceId', 'cwd', 'planSlug'] as const)('canonical terminal CAS rejects changed %s after preflight', async field => {
  const { owned, session } = await prepare();
  const binding = { coordOwnerId: owned.owner, sessionId: session.sessionId, startedAt: session.startedAt,
    workspaceId: owned.workspaceId, cwd: owned.root, planSlug: session.planSlug };
  expect(await markAdvSessionEnded(session.id, null, 'cleanup', { throwOnError: true,
    expectedBinding: { ...binding, [field]: 'sibling-value' } })).toBe(false);
  expect(await reuseFixtureLifecyclePorts.readSession(session.id)).toMatchObject({ ended: false });
  await cleanupReuseFixture(owned);
}, 60_000);
