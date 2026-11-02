import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { parsePushSnapshot, type PushSnapshot } from '../../code-intelligence/push-snapshot';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import * as anchorStore from '../../plan-items/anchor-store';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import addTool from './add-item';
import editTool from './edit';
import getTool from './get';
import { deriveIndexFromContent } from './derive-index';
import { writePlanLineNodes, readPlanLineNodes } from './plan-line-graph';
import { writePlanIndexRows } from './plan-index-rows';

it('round-trips intended changes through add, unrelated plan rewrites and target updates', async () => {
  const change = { action: 'modify', summary: 'Persist recovery state', reason: 'Avoid lost work' };
  const result = data(await add({ anchors: [{ symbol: 'linked', path: 'code.ts', change }] }));
  const item = result.results[0];
  expect(item.ok, JSON.stringify(item)).toBe(true);
  await add({ text: 'Unrelated index rewrite' });
  const read = data(await getTool.handler({ slug: SLUG, harness: HARNESS, mode: 'full', includeEnrichments: false } as never, ctx())).results[0];
  expect(read.items.find((i: any) => i.id === item.itemId).anchors[0].change).toEqual(change);
  expect(read.prose).toContain('Persist recovery state');
  const planned = { action: 'create', summary: 'Add recovery helper', reason: 'Keep existing queue ownership' };
  const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: item.itemId,
    rationale: 'Implementation identified a new helper', anchors: [{ symbol: 'recoverNew', path: 'recovery.ts', change: planned }] } as never, ctx()));
  expect(edited.anchors[0]).toMatchObject({ path: 'recovery.ts', unknownReason: 'planned', change: planned });
  const stored = await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG });
  expect(stored[item.itemId][0].change).toEqual(planned);
});

const fixture = vi.hoisted(() => ({ root: '', snapshot: null as PushSnapshot | null }));
vi.mock('../../plan-items/anchors', async importOriginal => {
  const actual = await importOriginal<typeof import('../../plan-items/anchors')>();
  return { ...actual, resolveHarnessAnchors: async (_workspace: string, _harness: string, inputs: import('../../plan-items/anchors').AnchorInput[]) =>
    actual.resolvePlanItemAnchors(inputs, { root: fixture.root, snapshot: fixture.snapshot, budgetMs: 5000 }) };
});

const HARNESS = `zzz-anchors-${Date.now()}`;
const SLUG = 'zzz-plan-anchors';
const WS = DEFAULT_WORKSPACE_ID;
let fx: PlanPgFixture;
const source = 'export function linked() { return 1; }\n';
const digest = createHash('sha256').update(source).digest('hex');
const declarationDigest = createHash('sha256').update('export function linked() { return 1; }').digest('hex');
const ctx = () => ({ signal: new AbortController().signal, role: 'su', workspaceId: WS,
  log: () => {}, progress: () => {}, metadata: () => {},
  principal: { kind: 'agent', slug: 'agent-anchor-test', workspaceId: WS } }) as never;
function body() { return `---\ntitle: Anchor fixture\nslug: ${SLUG}\nstatus: active\ncreated: 2026-10-22\nupdated: 2026-10-22\n---\n# Anchor fixture\n\n## Now\n\n**State:** Fixture.\n\n**Next:** Check links.\n\n## Phase 1 — Work\n\n- **P-001** \`todo\` Existing item\n\n## Decisions\n`; }
function data(result: unknown): any {
  const envelope = result as { data?: unknown; content?: { type: string; text?: string }[] };
  if (envelope.data !== undefined) return envelope.data;
  const text = envelope.content?.find(c => c.type === 'text' && c.text?.startsWith('{'))?.text;
  if (!text) throw new Error('No JSON tool result');
  return JSON.parse(text);
}
const add = (extra: Record<string, unknown> = {}) => addTool.handler({ slug: SLUG, harness: HARNESS,
  phase: 'Phase 1 — Work', text: 'Added item', importance: 'normal', ...extra } as never, ctx());
beforeAll(async () => {
  fx = await setupPlanPgFixture();
  // The draft is deliberately not armed until these isolated real-PG tests pass.
  const migration = join(harnessRoot(), '../../libs/db/sql/1559-plan-item-code-anchors.sql');
  const ddl = await readFile(migration, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readFile(migration + '.DRAFT', 'utf8');
    throw error;
  });
  await fx.admin.unsafe(ddl);
  const intentDdl = await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/1610-plan-anchor-change-intent.sql', import.meta.url), 'utf8');
  await fx.admin.unsafe(intentDdl);
  await fx.admin.unsafe(intentDdl);
  fixture.root = await mkdtemp(join(tmpdir(), 'plan-anchor-handler-'));
  await writeFile(join(fixture.root, 'code.ts'), source);
  const caller = "import { linked } from './code';\nlinked();\n";
  await writeFile(join(fixture.root, 'flow.test.ts'), caller);
  const files: Record<string, string> = { 'code.ts': source, 'flow.test.ts': caller };
  const paths = Object.keys(files);
  const symbols = buildSymbolSnapshot({ files: paths, readSource: path => files[path] ?? null,
    resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, new Set(paths)) });
  fixture.snapshot = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
    index: { backend: 'first-party-imports', lastCommit: 'd'.repeat(40) }, generatedAt: new Date().toISOString(),
    edges: [{ importer: 'flow.test.ts', imported: 'code.ts',
      importerSha256: createHash('sha256').update(caller).digest('hex') }], symbols }));
  expect(fixture.snapshot?.symbols?.get('linked')).toHaveLength(1);
}, 180_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await fx.admin`DELETE FROM harness_shared.plan_item_anchors WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await seedPlan(fx.admin, WS, HARNESS, SLUG, body());
  const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
  const index = deriveIndexFromContent(body());
  await fx.admin.begin(async tx => {
    await writePlanLineNodes(tx as never, scope, [], index.items);
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0], { ...scope, planSlug: SLUG }, index);
  });
  expect((await readPlanLineNodes(fx.admin, scope)).map(item => item.id)).toEqual(['P-001']);
});
afterAll(async () => {
  if (fx) {
    await fx.admin`DELETE FROM harness_shared.plan_item_anchors WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
    await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
    await cleanupPlans(fx.admin, WS, HARNESS);
    await fx.dispose();
  }
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
});

describe('plan item anchors through the real plan tools', () => {
  it('add and item-edit store equivalent resolved links that survive plan-index rewrites and read back', async () => {
    const result = data(await add({ anchors: [{ symbol: 'linked' }] }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const added = result.results[0];
    expect(added.ok).toBe(true);
    expect(added.anchors[0]).toMatchObject({
      symbolId: 'code.ts:1:linked', symbolName: 'linked', path: 'code.ts',
      signature: 'export function linked() ', contentHash: declarationDigest, resolution: 'resolved',
      consumers: [{ path: 'flow.test.ts', line: 2 }], consumersTotal: 1, tests: ['flow.test.ts'],
    });
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001', anchors: [{ symbol: 'linked' }] } as never, ctx()));
    expect(edited.anchors).toEqual(added.anchors);
    await add({ text: 'Unrelated index rewrite' });
    const read = data(await getTool.handler({ slug: SLUG, harness: HARNESS, mode: 'full', includeEnrichments: false } as never, ctx())).results[0];
    expect(read.ok).toBe(true);
    for (const id of ['P-001', added.itemId]) {
      expect(read.items.find((item: any) => item.id === id)?.anchors[0]).toMatchObject(added.anchors[0]);
    }
    expect(read.prose).toContain('↳ code:');
  });
  it('file links retain content hashes, unresolved links retain reasons, and general plans get no no-links warning', async () => {
    const added = data(await add({ anchors: [{ path: 'code.ts' }, { symbol: 'absent' }] })).results[0];
    expect(added.anchors).toMatchObject([{ path: 'code.ts', contentHash: digest, resolution: 'resolved' },
      { requested: 'absent', resolution: 'unknown', unknownReason: 'not-found' }]);
    const noLinks = data(await add()).results[0];
    expect(noLinks.ok).toBe(true);
    expect(noLinks.warnings).toEqual([expect.stringContaining('no code links')]);
    await fx.admin`UPDATE harness_shared.harness_plans SET verification_profile='general'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(data(await add()).results[0].warnings).toBeUndefined();
  });
  it('a storage failure rolls back the plan mutation and its rebuilt index', async () => {
    await add({ text: 'Populate the derived index' });
    const beforeItems = await fx.admin`SELECT item_id FROM harness_shared.plan_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY item_id`;
    const beforePlan = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(beforeItems.length).toBeGreaterThan(0);
    const write = vi.spyOn(anchorStore, 'writePlanItemAnchors').mockRejectedValueOnce(new Error('fixture storage failure'));
    const result = data(await add({ anchors: [{ path: 'code.ts' }] }));
    expect(write).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('fixture storage failure');
    const rows = await fx.admin`SELECT item_id FROM harness_shared.plan_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY item_id`;
    expect(rows.map(row => row.item_id)).toEqual(beforeItems.map(row => row.item_id));
    const afterPlan = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(afterPlan.map(row => [row.content, row.version])).toEqual(beforePlan.map(row => [row.content, row.version]));
  });
  it('pasted generated link lines do not become plan content or a stale receipt hash', async () => {
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, old_string: 'Existing item',
      new_string: 'Existing item\n  ↳ code: generated display only' } as never, ctx()));
    expect(edited.ok).toBe(true);
    const [row] = await fx.admin`SELECT content,content_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(row.content).not.toContain('↳ code:');
    expect(edited.contentHash).toBe(row.content_hash);
  });
});
