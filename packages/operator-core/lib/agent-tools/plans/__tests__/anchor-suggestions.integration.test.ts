import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './_pg-tool-fixture';
import { persistResearchBatch, type ResearchSubject } from '../../../code-intelligence/research-trail';
import { runWithWorkspace } from '../../../workspace-als';
import newTool from '../new';
import addTool from '../add-item';

const fixture = vi.hoisted(() => ({ root: '' }));
// Anchor resolution uses real fixture files; optional unrelated reuse providers are out of scope.
vi.mock('../../../plan-items/anchors', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../plan-items/anchors')>();
  return { ...actual, resolveHarnessAnchors: async (_workspace: string, _harness: string,
    inputs: import('../../../plan-items/anchors').AnchorInput[]) => actual.resolvePlanItemAnchors(inputs,
    { root: fixture.root, snapshot: null, budgetMs: 5000 }) };
});
vi.mock('../../../code-intelligence/reuse-authoring', () => ({ authoringReuse: async () => null }));

const HARNESS = 'zzz-anchor-suggestions';
const PLAN = 'anchor-suggestions-fixture';
const OWNER = 'zzz-anchor-suggestion-owner';
let fx: PlanPgFixture;
const ctx = (owner = OWNER) => ({ signal: new AbortController().signal, role: 'su', workspaceId: fx.workspaceId,
  log: () => {}, progress: () => {}, metadata: () => {},
  principal: { kind: 'agent', slug: owner, workspaceId: fx.workspaceId } }) as never;
function data(result: unknown): any {
  const value = result as { data?: unknown; content?: { text?: string }[] };
  if (value.data !== undefined) return value.data;
  const text = value.content?.find(part => part.text?.startsWith('{'))?.text;
  if (!text) throw new Error('Expected JSON tool response');
  return JSON.parse(text);
}
async function add(owner = OWNER, anchors?: { path: string }[]) {
  const response = await runWithWorkspace(fx.workspaceId, () => addTool.handler({
    harness: HARNESS, slug: PLAN, phase: 'Phase 1 — Work', text: 'Investigate the linked fixture code',
    importance: 'normal', ...(anchors ? { anchors } : {}),
  } as never, ctx(owner)));
  const result = data(response).results[0];
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}
async function capture(owner: string, subjects: ResearchSubject[], scope = { workspace: '', harness: HARNESS }) {
  await persistResearchBatch({ owner, workspace: scope.workspace || fx.workspaceId,
    harness: scope.harness, root: fixture.root, client: 'codex', calls: [] }, subjects);
}
async function stored(slug = PLAN) {
  return fx.admin`SELECT item_id, requested, path FROM harness_shared.plan_item_anchors
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${slug} ORDER BY id`;
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  const path = join(harnessRoot(), '../../libs/db/sql/1561-code-intel-research-trail.sql');
  await fx.admin.unsafe(await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readFile(path + '.DRAFT', 'utf8');
    throw error;
  }));
  fixture.root = await mkdtemp(join(tmpdir(), 'anchor-suggestions-'));
  await writeFile(join(fixture.root, 'target.ts'), 'export function target() { return 1; }\n');
}, 180_000);
beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.plan_item_anchors WHERE harness_slug=${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.code_intel_research_trails`;
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, PLAN, `---\ntitle: Anchor suggestion fixture\nslug: ${PLAN}\nstatus: draft\ncreated: 2026-11-02\nupdated: 2026-11-02\n---\n# Anchor suggestion fixture\n\n## Phase 1 — Work\n\n## Decisions\n`);
});
afterAll(async () => {
  await fx?.dispose();
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
});

describe('P012 suggestions through real plan tool handlers and isolated PostgreSQL', () => {
  it('P012-suggest: offers ranked caller files and symbols without storing them; explicit selection stores only the chosen anchor', async () => {
    const now = Date.now();
    await capture(OWNER, [{ kind: 'path', requested: 'target.ts', path: 'target.ts', seenAt: now },
      { kind: 'symbol', requested: 'target', path: 'target.ts', symbolId: 'fixture:target', seenAt: now }]);
    const result = await add();
    expect(result.suggestedAnchors).toEqual({ manualEntry: true,
      anchors: [{ symbol: 'target', path: 'target.ts' }, { path: 'target.ts' }] });
    expect(await stored()).toEqual([]);
    const chosen = await add(OWNER, [result.suggestedAnchors.anchors[1]]);
    expect(await stored()).toEqual([expect.objectContaining({ item_id: chosen.itemId, requested: 'target.ts', path: 'target.ts' })]);
  });

  it('P012-isolation: excludes other owners, workspaces and harnesses while preserving the stable caller across carries', async () => {
    const subject = (path: string): ResearchSubject[] => [{ kind: 'path', requested: path, path, seenAt: Date.now() }];
    await capture(OWNER, subject('target.ts'));
    await capture('foreign-owner', subject('foreign-owner.ts'));
    await capture(OWNER, subject('foreign-workspace.ts'), { workspace: 'foreign-workspace', harness: HARNESS });
    await capture(OWNER, subject('foreign-harness.ts'), { workspace: fx.workspaceId, harness: 'foreign-harness' });
    expect((await add()).suggestedAnchors.anchors).toEqual([{ path: 'target.ts' }]);
    expect((await add(OWNER)).suggestedAnchors.anchors).toEqual([{ path: 'target.ts' }]);
  });

  it('P012-empty: distinguishes recorded empty research from unsupported capture and preserves manual entry', async () => {
    await capture('empty-owner', []);
    expect((await add('empty-owner')).suggestedAnchors).toEqual({ anchors: [], reason: 'nothing recorded', manualEntry: true });
    expect((await add('uncaptured-owner')).suggestedAnchors).toEqual({ anchors: [], reason: 'trail not captured for this client', manualEntry: true });
    const manual = await add('uncaptured-owner', [{ path: 'target.ts' }]);
    expect(await stored()).toEqual([expect.objectContaining({ item_id: manual.itemId, requested: 'target.ts' })]);
  });

  it('P012-new: returns caller research when creating a plan, without persisting any suggested anchor', async () => {
    await capture(OWNER, [{ kind: 'path', requested: 'target.ts', path: 'target.ts', seenAt: Date.now() }]);
    const result = data(await runWithWorkspace(fx.workspaceId, () => newTool.handler({ harness: HARNESS,
      slug: 'zzz-marigold-telemetry-2026-11-02', title: 'Marigold telemetry', force: true,
    } as never, ctx())));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.suggestedAnchors).toEqual({ anchors: [{ path: 'target.ts' }], manualEntry: true });
    expect(await stored(result.slug)).toEqual([]);
  });
});
