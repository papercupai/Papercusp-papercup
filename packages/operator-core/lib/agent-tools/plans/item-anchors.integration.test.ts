import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { parsePushSnapshot, type PushSnapshot } from '../../code-intelligence/push-snapshot';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import * as anchorStore from '../../plan-items/anchor-store';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import addTool from './add-item';
import editTool from './edit';
import getTool from './get';
import { deriveIndexFromContent } from './derive-index';
import { hashPlanContent } from './content-hash';
import { writePlanLineNodes, readPlanLineNodes } from './plan-line-graph';
import { writePlanIndexRows } from './plan-index-rows';
import { withPlanLock } from './with-plan-lock';
import { checkPlanStartable } from './plan-start-gate';
import * as lifecycle from '../../acceptance-bar-lifecycle-evaluator';
import * as admission from './plan-admission-gate';
import { resolvePlanItemAnchors } from '../../plan-items/anchors';

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
function body() { return `---\ntitle: Anchor fixture\nslug: ${SLUG}\nstatus: draft\ncreated: 2026-10-22\nupdated: 2026-10-22\n---\n# Anchor fixture\n\n## Now\n\n**State:** Fixture.\n\n**Next:** Check links.\n\n## Phase 1 — Work\n\n- **P-001** \`todo\` Existing item\n\n## Decisions\n`; }
function data(result: unknown): any {
  const envelope = result as { data?: unknown; content?: { type: string; text?: string }[] };
  if (envelope.data !== undefined) return envelope.data;
  const text = envelope.content?.find(c => c.type === 'text' && c.text?.startsWith('{'))?.text;
  if (!text) throw new Error('No JSON tool result');
  return JSON.parse(text);
}
const add = (extra: Record<string, unknown> = {}) => addTool.handler({ slug: SLUG, harness: HARNESS,
  phase: 'Phase 1 — Work', text: 'Added item', importance: 'normal', ...extra } as never, ctx());
async function clearFixtureWorkItems() {
  const items = await fx.admin<{ feature_id: string }[]>`SELECT feature_id FROM harness_shared.work_items
    WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
  const endpoints = items.map(({ feature_id }) => `${HARNESS}#${feature_id}`);
  if (endpoints.length) {
    await fx.admin`DELETE FROM harness_shared.work_item_deps WHERE workspace_id=${DEFAULT_COORD_WORKSPACE}
      AND ((blocked_kind='feature' AND blocked_ref=ANY(${endpoints}::text[]))
        OR (blocker_kind='feature' AND blocker_ref=ANY(${endpoints}::text[])))`;
  }
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
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
  await clearFixtureWorkItems();
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
    await clearFixtureWorkItems();
    await cleanupPlans(fx.admin, WS, HARNESS);
    await fx.dispose();
  }
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
});

describe('plan item anchors through the real plan tools', () => {
  const change = { action: 'modify' as const, summary: 'Persist recovery state', reason: 'Prevent lost work' };
  async function executable(status = 'active', suffix = '') {
    const before = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    // The writer's preimage is canonical nodes with durable featureId, never
    // a parsed index or an empty array for an already materialized plan.
    expect(before.map(item => item.id)).toEqual(['P-001']);
    expect(before.every(item => Boolean(item.featureId))).toBe(true);
    const content = body().replace('status: draft', `status: ${status}`).replace('Existing item', `Existing item${suffix}`);
    const index = deriveIndexFromContent(content);
    await fx.admin`UPDATE harness_shared.harness_plans SET content=${content}, content_hash=${hashPlanContent(content)},
      status=${status}, verification_profile='coding', op_status=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    await fx.admin.begin(async tx => {
      await writePlanLineNodes(tx as never, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }, before, index.items);
      await writePlanIndexRows(tx as never, { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, index);
    });
  }
  async function storeAnchors(inputs: Parameters<typeof resolvePlanItemAnchors>[0]) {
    const anchors = await resolvePlanItemAnchors(inputs, { root: fixture.root, snapshot: fixture.snapshot, budgetMs: 5000 });
    await fx.admin.begin(tx => anchorStore.writePlanItemAnchors(tx, {
      workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, { itemId: 'P-001', anchors }, 'agent-anchor-test'));
  }
  async function snapshot() {
    return {
      plans: [...await fx.admin`SELECT content, content_hash, version, status, op_status FROM harness_shared.harness_plans
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`],
      anchors: await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }),
      items: [...await fx.admin`SELECT * FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS} ORDER BY feature_id`],
      lines: await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }),
    };
  }
  async function start() {
    // Keep the production start gate, input decision and anchor persistence.
    // These unrelated acceptance/governance decisions are outside this fixture.
    const a = vi.spyOn(lifecycle, 'readAndEvaluateAcceptanceBarLifecycle');
    mockResolvedTyped(a, {
      phase: 'pre-start', applicable: true, satisfied: true, codes: [], blockingBars: [], contractCodes: [],
      codeAttribution: [], staleGradingScorecardId: null, nextRepair: null, message: null,
    });
    const b = vi.spyOn(admission, 'checkPlanAdmission');
    mockResolvedTyped(b, { admitted: true, skipped: 'no-admission-policy' });
    try { return await checkPlanStartable(SLUG, { workspaceId: WS, harnessSlug: HARNESS }); }
    finally { a.mockRestore(); b.mockRestore(); }
  }
  it('refuses absent initial scope at the real start boundary without mutation', async () => {
    await executable('ready');
    const before = await snapshot();
    expect(await start()).toMatchObject({ ok: false, refusal: { code: 'initial_change_scope_missing' } });
    expect(await snapshot()).toEqual(before);
  });
  it('refuses incomplete target action intended change or rationale at the real start boundary without mutation', async () => {
    await executable('ready');
    for (const field of ['target', 'action', 'summary', 'reason']) {
      await storeAnchors([{ path: 'code.ts', change }]);
      const value = field === 'target' ? { ...change } : { ...change, [field]: '' };
      if (field === 'target') await fx.admin`UPDATE harness_shared.plan_item_anchors SET requested='', path=NULL, symbol_name=NULL
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
      else await fx.admin`UPDATE harness_shared.plan_item_anchors SET change_intent=${JSON.stringify(value)}::text::jsonb
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
      const before = await snapshot();
      expect(await start(), field).toMatchObject({ ok: false, refusal: { code: 'initial_change_scope_missing' } });
      expect(await snapshot(), field).toEqual(before);
    }
  });
  it('accepts valid scope and non-code planned-create and investigation controls at the real start boundary', async () => {
    await executable('ready');
    for (const anchors of [[{ path: 'code.ts', change }],
      [{ path: 'future.ts', change: { ...change, action: 'create' as const } }],
      [{ symbol: 'unknown', change: { ...change, action: 'investigate' as const } }]]) {
      await storeAnchors(anchors);
      expect(await start()).toMatchObject({ ok: true });
    }
    await executable('ready', ' deliverable: doc');
    await storeAnchors([]);
    expect(await start()).toMatchObject({ ok: true });
  });
  it('refuses an active-plan coding item addition with absent or incomplete initial scope before mutation', async () => {
    await executable();
    for (const anchors of [undefined, [], [{ path: 'code.ts' }]]) {
      const before = await snapshot();
      const result = data(await add({ anchors }));
      expect(result.results[0]).toMatchObject({ ok: false, error: 'initial_change_scope_missing' });
      expect(await snapshot()).toEqual(before);
    }
    // Malformed supplied fields are rejected by the real public tool schema
    // before its handler; missing optional metadata reaches the scope gate above.
    for (const field of ['action', 'summary', 'reason']) {
      const before = await snapshot();
      expect(addTool.args.safeParse({ slug: SLUG, harness: HARNESS, phase: 'Phase 1 — Work', text: 'Added item',
        anchors: [{ path: 'code.ts', change: { ...change, [field]: '' } }] }).success).toBe(false);
      expect(await snapshot()).toEqual(before);
    }
  });
  it('refuses an active-plan edit that removes or invalidates executable initial scope before mutation', async () => {
    await executable();
    await storeAnchors([{ path: 'code.ts', change }]);
    for (const anchors of [[], [{ path: 'code.ts' }]]) {
      const before = await snapshot();
      expect(data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001', anchors } as never, ctx())))
        .toMatchObject({ ok: false, code: 'initial_change_scope_missing' });
      expect(await snapshot()).toEqual(before);
    }
    for (const field of ['action', 'summary', 'reason']) {
      const before = await snapshot();
      expect(editTool.args.safeParse({ slug: SLUG, harness: HARNESS, itemId: 'P-001',
        anchors: [{ path: 'code.ts', change: { ...change, [field]: '' } }] }).success).toBe(false);
      expect(await snapshot()).toEqual(before);
    }
  });
  it('admits active-plan scoped additions and complete scope evolution with non-code controls', async () => {
    await executable(); // P-001 deliberately retains unrelated legacy missing scope.
    const beforeLegacy = (await snapshot()).lines.find(item => item.id === 'P-001');
    for (const anchors of [[{ path: 'code.ts', change }],
      [{ path: 'future.ts', change: { ...change, action: 'create' } }],
      [{ symbol: 'unknown', change: { ...change, action: 'investigate' } }]]) {
      const result = data(await add({ anchors })).results[0];
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: result.itemId,
        anchors: [{ path: 'code.ts', change: { ...change, summary: 'Revised complete scope' } }] } as never, ctx()));
      expect(edited.ok, JSON.stringify(edited)).toBe(true);
    }
    expect(data(await add({ deliverable: 'doc' })).results[0].ok).toBe(true);
    expect((await snapshot()).lines.find(item => item.id === 'P-001')).toEqual(beforeLegacy);
  });
  it('preserves unrelated accepted anchors across concurrent plan rewrites', async () => {
    await storeAnchors([{ path: 'code.ts', change }]);
    const first = (await snapshot()).anchors['P-001'];
    const results = await Promise.all([
      add({ anchors: [{ path: 'future.ts', change: { ...change, action: 'create' } }] }),
      add({ text: 'Independent item', anchors: [{ symbol: 'linked', change }] }),
    ]);
    const added = results.map(result => data(result).results[0]);
    expect(added.every(result => result.ok), JSON.stringify(added)).toBe(true);
    const after = (await snapshot()).anchors;
    expect(after['P-001']).toEqual(first);
    expect(added.map(result => after[result.itemId][0].change)).toEqual([{ ...change, action: 'create' }, change]);
  });
  it('preserves legacy item IDs and dependencies through an anchor-only edit without graph rows', async () => {
    const legacy = body().replace('\n## Decisions\n', '\n- **P-002** `blocked` Dependent item blocked-by: P-001\n\n## Decisions\n');
    const index = deriveIndexFromContent(legacy);
    await clearFixtureWorkItems();
    await fx.admin`UPDATE harness_shared.harness_plans
      SET content=${legacy}, content_hash=${hashPlanContent(legacy)}, items=${JSON.stringify(index.items)}::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual([]);

    const read = async () => data(await getTool.handler({
      slug: SLUG, harness: HARNESS, mode: 'full', includeRaw: true, includeEnrichments: false,
    } as never, ctx())).results[0];
    const before = await read();
    expect(before.items.map((item: { id: string }) => item.id)).toEqual(['P-001', 'P-002']);
    expect(before.items[1].blockedBy).toEqual(['P-001']);

    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-002',
      anchors: [{ path: 'code.ts', change: { action: 'modify', summary: 'Update dependent source', reason: 'Preserve the approved task' } }],
    } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const after = await read();
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(['P-001', 'P-002']);
    expect(after.items[1].blockedBy).toEqual(['P-001']);
    expect(after.items[1].anchors[0].path).toBe('code.ts');
    expect(after.raw).toContain('Existing item');
    expect(after.raw).toContain('Dependent item');

    const followup = data(await editTool.handler({ slug: SLUG, harness: HARNESS,
      old_string: 'Dependent item', new_string: 'Revised dependent item',
    } as never, ctx()));
    expect(followup.ok, JSON.stringify(followup)).toBe(true);
    const revised = await read();
    expect(revised.items[1].text).toBe('Revised dependent item');
    expect(revised.items[1].blockedBy).toEqual(['P-001']);
  });

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
  it.each(['done', 'dropped'])('refuses an unauthenticated %s graph projection and rolls back the plan rewrite', async status => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const before = await readPlanLineNodes(fx.admin, scope);
    const featureId = before[0].featureId;
    await fx.admin`UPDATE harness_shared.work_items SET taken_by='agent-anchor-test'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${featureId}`;
    const proposed = body().replace('`todo`', '`' + status + '`');
    await expect(fx.admin.begin(async tx => {
      await tx`UPDATE harness_shared.harness_plans SET content=${proposed}, version=version + 1
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
      await writePlanLineNodes(tx as never, scope, before, deriveIndexFromContent(proposed).items);
    })).rejects.toThrow('plan_line_status_change_requires_lifecycle_writer');
    const [stored] = await fx.admin`SELECT status, taken_by, authority, terminal_owner, closed_ts
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${featureId}`;
    expect(stored).toMatchObject({ status: 'open', taken_by: 'agent-anchor-test',
      authority: null, terminal_owner: null, closed_ts: null });
    const [plan] = await fx.admin`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(plan.content).toBe(body());
  });

  it.each([
    { status: 'active', opStatus: null },
    { status: 'draft', opStatus: 'started' },
  ])('rejects a terminal plan rewrite after execution admission: %j', async ({ status, opStatus }) => {
    await fx.admin`UPDATE harness_shared.harness_plans SET status=${status}, op_status=${opStatus}
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    await expect(withPlanLock(null, {
      workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'terminal projection regression',
    }, async () => ({ newBody: body().replace('`todo`', '`done`'), value: { ok: true } })))
      .rejects.toThrow('plan_line_status_change_requires_lifecycle_writer');
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0].status)
      .toBe('todo');
  });

  it('preserves an existing terminal authority record during an unrelated graph rewrite', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const [node] = await readPlanLineNodes(fx.admin, scope);
    // Seed an already-settled row; the projection must preserve its authority.
    await fx.admin`UPDATE harness_shared.work_items SET status='done', authority='committed',
      terminal_owner='agent-anchor-test', taken_by=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
    const before = await readPlanLineNodes(fx.admin, scope);
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, scope, before,
      before.map(item => ({ ...item, text: 'Revised settled item' }))));
    const [stored] = await fx.admin`SELECT status, authority, terminal_owner, taken_by, plan_line_text
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
    expect(stored).toMatchObject({ status: 'done', authority: 'committed',
      terminal_owner: 'agent-anchor-test', taken_by: null, plan_line_text: 'Revised settled item' });
  });

  it('anchor-only edits preserve stored prose and reconcile stale graph line text', async () => {
    const canonical = body().replace('Existing item', 'Reconciled native item').replace('`todo`', '`wip`');
    await fx.admin`
      UPDATE harness_shared.harness_plans
      SET content=${canonical}, content_hash=${hashPlanContent(canonical)}, version=version + 1
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
    `;
    const [stale] = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    expect(stale).toMatchObject({ text: 'Existing item', status: 'todo' });
    await fx.admin`
      UPDATE harness_shared.work_items SET status='wip'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${stale.featureId}
    `;
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0].status)
      .toBe('wip');

    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001',
      anchors: [{ symbol: 'linked' }] } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);

    const [stored] = await fx.admin<{ content: string; content_hash: string }[]>`
      SELECT content, content_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
    `;
    expect(stored.content).toBe(canonical);
    expect(stored.content_hash).toBe(hashPlanContent(canonical));
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0])
      .toMatchObject({ text: 'Reconciled native item', status: 'wip' });
    expect((await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }))['P-001'][0])
      .toMatchObject({ symbolName: 'linked', path: 'code.ts' });
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
