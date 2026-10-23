/**
 * Real-PG proof that a structured plan writer cannot bypass the dependency
 * candidate verdict in withPlanLock. The exercised handler intentionally does
 * no whole-document lint of its own: plans:set-item-blocked-by surgically
 * rewrites one item line, making it the regression shape for the central seam.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { parsePlan, resolveEffectiveStatus } from '@papercusp/plan-parser';
import setItemBlockedByTool from '../set-item-blocked-by';
import { withPlanLock } from '../with-plan-lock';
import { mutateWorkItemDependencies, mutateWorkItemDependenciesInTransaction } from '../../../dbos/work-item-deps-store';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-candidate-deps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'candidate-dependency-structured-writer';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

const workId = (item: string) => `WI-${HARNESS}-${item}`;
const endpoint = (item: string) => ({ kind: 'feature', ref: `${HARNESS}#${workId(item)}` });

async function seedPromotedItems() {
  for (const item of ['P-001', 'P-002', 'external']) {
    const payload = item === 'external' ? {} : {
      plan_item: { plan_slug: SLUG, item_id: item, harness_slug: HARNESS },
    };
    await admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, payload)
      VALUES (${wsId}, ${HARNESS}, ${workId(item)}, 'feature', ${item}, 'open', 0, 0,
        ${JSON.stringify(payload)}::text::jsonb)`;
  }
}

async function seedEdge(blocked: string, blocker: string, independent = false) {
  await mutateWorkItemDependencies({
    workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: wsId,
    mutations: [{ op: 'add', blocked: endpoint(blocked), blocker: endpoint(blocker),
      ...(independent ? { createdBy: 'independent-author', satisfaction: 'success' as const } : {}) }],
  }, { sql: admin });
}

async function liveEdges() {
  return admin`
    SELECT blocked_ref, blocker_ref, created_by, satisfaction FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND blocked_ref LIKE ${`${HARNESS}#%`}
     ORDER BY blocked_ref, blocker_ref`;
}

async function cleanupPromotedItems() {
  await mutateWorkItemDependencies({ workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: wsId,
    mutations: ['P-001', 'P-002', 'external'].flatMap((item) => [
      { op: 'replace' as const, blocked: endpoint(item), blockers: [] },
      { op: 'replace' as const, blocked: { kind: 'issue', ref: workId(item) }, blockers: [] },
    ]),
  }, { sql: admin });
  await admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS}`;
}

function planBody(
  status: 'draft' | 'ready' | 'active',
  opts: { p1BlockedBy?: string[]; p2BlockedBy?: string[] } = {},
  slug = SLUG,
): string {
  const blockedBy = (refs: string[] | undefined) => (refs?.length ? ` blocked-by: ${refs.join(', ')}` : '');
  return `---
title: candidate dependency structured writer
slug: ${slug}
status: ${status}
created: 2026-08-27
updated: 2026-08-27
---

# candidate dependency structured writer

## Phase 1

- **P-001** \`todo\` first${blockedBy(opts.p1BlockedBy)}
- **P-002** \`todo\` second${blockedBy(opts.p2BlockedBy)}
`;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: wsId,
    principal: { kind: 'agent', slug: 'agent-candidate-dependency-test', workspaceId: wsId },
  } as never;
}

async function runSetBlockedBy(item: string, blockedBy: string[]) {
  const data = await runSetBlockedByArgs({ harness: HARNESS, slug: SLUG, item, blockedBy });
  return {
    result: data.results[0]!,
    counts: data.counts,
  };
}

async function runSetBlockedByArgs(args: Record<string, unknown>) {
  const response = (await setItemBlockedByTool.handler(args as never, makeCtx())) as {
    data: {
      counts: { ok: number; failed: number };
      results: Array<Record<string, unknown>>;
    };
  };
  return response.data;
}

async function livePlan(slug = SLUG): Promise<{ content: string; version: number }> {
  const rows = await admin<Array<{ content: string; version: string | number }>>`
    SELECT content, version
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
  `;
  const row = rows[0]!;
  return { content: row.content, version: Number(row.version) };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 90_000);

beforeEach(async () => {
  await cleanupPromotedItems();
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await cleanupPromotedItems().catch(() => {});
  await cleanupPlans(admin, wsId, HARNESS).catch(() => {});
  await fx?.dispose();
});

describe('withPlanLock candidate dependency admission — structured writer', () => {
  it('preserves an independently authored blocker even when it overlaps a removed plan dependency', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001', true);
    const before = await liveEdges();
    await runSetBlockedBy('P-002', []);
    expect(await liveEdges()).toEqual(before);
  }, 60_000);

  it('refuses an unresolved promoted blocker and preserves the prior plan', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    await seedPromotedItems();
    await admin`DELETE FROM harness_shared.work_items
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-001')}`;
    const before = await livePlan();
    const result = await runSetBlockedBy('P-002', ['P-001']);
    expect(result.counts).toEqual({ ok: 0, failed: 1 });
    expect(await livePlan()).toEqual(before);
    expect(await liveEdges()).toHaveLength(0);
  }, 60_000);

  it('rejects use of the coupled dependency writer inside a READ COMMITTED transaction', async () => {
    await expect(admin.begin((tx) => mutateWorkItemDependenciesInTransaction(tx as unknown as postgres.Sql, {
      workspaceId: DEFAULT_COORD_WORKSPACE, mutations: [],
    }))).rejects.toThrow('requires a SERIALIZABLE admission transaction');
  }, 60_000);

  it('resolves promoted task endpoints to the canonical issue family', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    await seedPromotedItems();
    await admin`UPDATE harness_shared.work_items SET item_kind = 'task'
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-002')}`;
    expect((await runSetBlockedBy('P-002', ['P-001'])).counts).toEqual({ ok: 1, failed: 0 });
    const edges = await admin`SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref
      FROM harness_shared.work_item_deps WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
        AND blocked_ref = ${workId('P-002')}`;
    expect(edges).toMatchObject([{
      blocked_kind: 'issue', blocked_ref: workId('P-002'),
      blocker_kind: 'feature', blocker_ref: endpoint('P-001').ref,
    }]);
    await runSetBlockedBy('P-002', []);
    expect(await admin`SELECT id FROM harness_shared.work_item_deps
      WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND blocked_ref = ${workId('P-002')}`).toHaveLength(0);
  }, 60_000);

  it('serializes concurrent promoted removals and additions without a stale reconciliation', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001');
    const outcomes = await Promise.all([runSetBlockedBy('P-002', []), runSetBlockedBy('P-002', ['P-001'])]);
    expect(outcomes.map((outcome) => outcome.counts)).toEqual([{ ok: 1, failed: 0 }, { ok: 1, failed: 0 }]);
    const blockers = parsePlan((await livePlan()).content).items[1]!.blockedBy;
    expect(await liveEdges()).toHaveLength(blockers.length);
    if (blockers.length) expect(await liveEdges()).toMatchObject([{
      blocked_ref: endpoint('P-002').ref, blocker_ref: endpoint('P-001').ref,
    }]);
  }, 60_000);

  it('removes the last promoted blocker while preserving an independently authored success edge', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001');
    await seedEdge('P-002', 'external', true);
    const independent = (await liveEdges()).find((edge) => edge.blocker_ref === endpoint('external').ref);

    expect((await runSetBlockedBy('P-002', [])).counts).toEqual({ ok: 1, failed: 0 });

    expect(await liveEdges()).toEqual([independent]);
    expect(parsePlan((await livePlan()).content).items[1]?.blockedBy).toEqual([]);
  }, 60_000);

  it('reconciles promoted blockers for a generic body write, including a removed plan item', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001');
    const result = await withPlanLock(makeCtx(), {
      harnessSlug: HARNESS, workspaceId: wsId, slug: SLUG, intent: 'remove promoted dependent',
    }, async (body) => ({ newBody: body!.replace(/^- \*\*P-002\*\*.*\n/m, ''), value: true }));
    expect(result.kind).toBe('applied');
    expect(await liveEdges()).toHaveLength(0);
  }, 60_000);

  it('reorients promoted dependencies using one admitted batch rather than an intermediate cycle', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001');
    const data = await runSetBlockedByArgs({ harness: HARNESS, items: [
      { slug: SLUG, item: 'P-001', blockedBy: ['P-002'] },
      { slug: SLUG, item: 'P-002', blockedBy: [] },
    ] });
    expect(data.counts).toEqual({ ok: 2, failed: 0 });
    expect(await liveEdges()).toMatchObject([{
      blocked_ref: endpoint('P-001').ref, blocker_ref: endpoint('P-002').ref,
    }]);
  }, 60_000);

  it('rolls back the plan when canonical dependency admission refuses a new blocker behind active work', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    await seedPromotedItems();
    await admin`UPDATE harness_shared.work_items SET status = 'wip', taken_by = 'active-agent'
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-002')}`;
    const before = await livePlan();
    const data = await runSetBlockedBy('P-002', ['P-001']);
    expect(data.counts).toEqual({ ok: 0, failed: 1 });
    expect(await livePlan()).toEqual(before);
    expect(await liveEdges()).toHaveLength(0);
  }, 60_000);

  it('does not backfill an unchanged dependency behind active work during a status-only edit', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await admin`UPDATE harness_shared.work_items SET status = 'wip', taken_by = 'active-agent'
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-002')}`;

    const result = await withPlanLock(makeCtx(), {
      harnessSlug: HARNESS, workspaceId: wsId, slug: SLUG, intent: 'record unrelated source progress',
    }, async (body) => ({ newBody: body!.replace('`todo` first', '`wip` first'), value: true }));

    expect(result.kind).toBe('applied');
    expect(parsePlan((await livePlan()).content).items[0]?.storedStatus).toBe('wip');
    expect(parsePlan((await livePlan()).content).items[1]?.blockedBy).toEqual(['P-001']);
    expect(resolveEffectiveStatus(parsePlan((await livePlan()).content)).items[1]?.effectiveStatus).toBe('blocked');
    expect(await liveEdges()).toHaveLength(0);
  }, 60_000);

  it('removes a completed prerequisite without backfilling an unchanged sibling prerequisite', async () => {
    const body = planBody('ready', { p2BlockedBy: ['P-001', 'P-003'] }) + '- **P-003** `todo` third\n';
    await seedPlan(admin, wsId, HARNESS, SLUG, body);
    await seedPromotedItems();
    await admin`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, payload)
      VALUES (${wsId}, ${HARNESS}, ${workId('P-003')}, 'feature', 'third', 'open', 0, 0,
        ${JSON.stringify({ plan_item: { plan_slug: SLUG, item_id: 'P-003', harness_slug: HARNESS } })}::text::jsonb)`;
    await seedEdge('P-002', 'P-001');
    await admin`UPDATE harness_shared.work_items SET status = 'done', authority = 'committed'
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-001')}`;
    await admin`UPDATE harness_shared.work_items SET status = 'wip', taken_by = 'active-agent'
      WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND feature_id = ${workId('P-002')}`;

    const result = await withPlanLock(makeCtx(), {
      harnessSlug: HARNESS, workspaceId: wsId, slug: SLUG, intent: 'reflect completed source prerequisite',
    }, async (current) => ({ newBody: current!.replace('`todo` first', '`done` first'), value: true }));

    expect(result.kind).toBe('applied');
    const items = parsePlan((await livePlan()).content).items;
    expect(items[0]?.storedStatus).toBe('done');
    expect(items[1]?.blockedBy).toEqual(['P-001', 'P-003']);
    expect(items[2]?.storedStatus).toBe('todo');
    expect(resolveEffectiveStatus(parsePlan((await livePlan()).content)).items[1]?.unresolvedBlockers).toEqual(['P-003']);
    expect(resolveEffectiveStatus(parsePlan((await livePlan()).content)).items[1]?.effectiveStatus).toBe('blocked');
    expect(await liveEdges()).toHaveLength(0);
  }, 60_000);

  it('rolls back both records on a coupled hook failure and keeps a later writer current', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready', { p2BlockedBy: ['P-001'] }));
    await seedPromotedItems();
    await seedEdge('P-002', 'P-001');
    const before = await livePlan();
    await expect(withPlanLock(makeCtx(), {
      harnessSlug: HARNESS, workspaceId: wsId, slug: SLUG, intent: 'failed coupled write',
      inTransaction: async () => { throw new Error('coupled-write-failure'); },
    }, async (body) => ({ newBody: body!.replace(' blocked-by: P-001', ''), value: true })))
      .rejects.toThrow('coupled-write-failure');
    expect(await livePlan()).toEqual(before);
    expect(await liveEdges()).toHaveLength(1);
    await runSetBlockedBy('P-002', []);
    await runSetBlockedBy('P-002', ['P-001']);
    expect(await liveEdges()).toMatchObject([{
      blocked_ref: endpoint('P-002').ref, blocker_ref: endpoint('P-001').ref,
    }]);
  }, 60_000);

  it.each([
    ['invalid_plan_dependencies', (body: string) => body.replace('status: draft', 'status: ready').replace('first', 'first blocked-by: P-001')],
    ['child_seed_template_reserved', (body: string) => body.replace('status: draft', 'status: draft\ntemplate: child-seed')],
    ['conversation_audit_required', (body: string) => body.replace('status: draft', 'status: ready')],
  ] as const)('returns a distinct refused result for %s without writing or running hooks', async (code, candidate) => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft'));
    const before = await livePlan();
    const afterWrite = vi.fn();
    const result = await withPlanLock(
      makeCtx(), { harnessSlug: HARNESS, workspaceId: wsId, slug: SLUG, intent: 'typed refusal regression', afterWrite },
      async (body) => ({ newBody: candidate(body!), value: { created: true } }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('Expected central domain refusal');
    expect(result.value).toMatchObject({ ok: false, code });
    expect(result.value).not.toHaveProperty('created');
    expect(await livePlan()).toEqual(before);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('allows a draft forward ref, writes it, and surfaces invalid-draft evidence on the tool value', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft'));

    const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

    expect(counts).toEqual({ ok: 1, failed: 0 });
    expect(result).toMatchObject({
      ok: true,
      itemId: 'P-001',
      to: ['P-099'],
      dependencyDiagnostics: [
        {
          code: 'dependency_endpoint_missing',
          disposition: 'invalid-draft',
          itemId: 'P-001',
          ref: 'P-099',
          path: ['P-001', 'P-099'],
        },
      ],
    });
    expect((await livePlan()).content).toContain('P-001** `todo` first blocked-by: P-099');

    // The same invalid draft remains editable: removing the unresolved forward
    // ref is a normal valid transition and preserves its draft lifecycle.
    const repaired = await runSetBlockedBy('P-001', []);
    expect(repaired.counts).toEqual({ ok: 1, failed: 0 });
    expect(repaired.result).toMatchObject({ ok: true, itemId: 'P-001', from: ['P-099'], to: [] });
    expect(repaired.result).not.toHaveProperty('dependencyDiagnostics');
    const repairedPlan = parsePlan((await livePlan()).content);
    expect(repairedPlan.frontmatter.status).toBe('draft');
    expect(repairedPlan.items.find((item) => item.id === 'P-001')?.blockedBy).toEqual([]);
  }, 60_000);

  it.each(['ready', 'active'] as const)(
    'rejects a dangling ref in an already-%s plan before the structured write lands',
    async (status) => {
      const seeded = planBody(status);
      await seedPlan(admin, wsId, HARNESS, SLUG, seeded);
      const before = await livePlan();

      const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

      expect(counts).toEqual({ ok: 0, failed: 1 });
      expect(result).toMatchObject({
        ok: false,
        itemId: 'P-001',
        error: 'invalid_plan_dependencies',
      });
      expect(await livePlan()).toEqual(before);
    },
    60_000,
  );

  it('uses locked op_status truth: a frontmatter draft already started cannot gain a dangling ref', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft'));
    await admin`
      UPDATE harness_shared.harness_plans
         SET op_status = 'started'
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', ['P-099']);

    expect(counts).toEqual({ ok: 0, failed: 1 });
    expect(result).toMatchObject({ ok: false, error: 'invalid_plan_dependencies' });
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('rejects a reciprocal cycle even in a draft and leaves the prior DAG intact', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('draft', { p2BlockedBy: ['P-001'] }));
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', ['P-002']);

    expect(counts).toEqual({ ok: 0, failed: 1 });
    expect(result).toMatchObject({ ok: false, error: 'invalid_plan_dependencies' });
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('commits a strict-subset repair of legacy-invalid content and surfaces the residual defect', async () => {
    await seedPlan(
      admin,
      wsId,
      HARNESS,
      SLUG,
      planBody('ready', { p1BlockedBy: ['P-099'], p2BlockedBy: ['P-098'] }),
    );
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', []);

    expect(counts).toEqual({ ok: 1, failed: 0 });
    expect(result).toMatchObject({
      ok: true,
      itemId: 'P-001',
      to: [],
      dependencyDiagnostics: [
        {
          disposition: 'legacy-residual',
          itemId: 'P-002',
          ref: 'P-098',
        },
      ],
    });
    const after = await livePlan();
    expect(after.version).toBe(before.version + 1);
    expect(after.content).not.toContain('first blocked-by:');
    expect(after.content).toContain('second blocked-by: P-098');
  }, 60_000);

  it('rejects a same-count legacy defect swap and leaves the row byte-identical', async () => {
    await seedPlan(
      admin,
      wsId,
      HARNESS,
      SLUG,
      planBody('ready', { p1BlockedBy: ['P-099'], p2BlockedBy: ['P-098'] }),
    );
    const before = await livePlan();

    const { result, counts } = await runSetBlockedBy('P-001', ['P-097']);

    expect(counts).toEqual({ ok: 0, failed: 1 });
    expect(result).toMatchObject({ ok: false, error: 'invalid_plan_dependencies' });
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('applies a same-plan edge reorientation as one final-state candidate and one version bump', async () => {
    await seedPlan(
      admin,
      wsId,
      HARNESS,
      SLUG,
      planBody('ready', { p2BlockedBy: ['P-001'] }),
    );
    const before = await livePlan();

    const data = await runSetBlockedByArgs({
      harness: HARNESS,
      items: [
        { slug: SLUG, item: 'P-001', blockedBy: ['P-002'] },
        { slug: SLUG, item: 'P-002', blockedBy: [] },
      ],
    });

    expect(data.counts).toEqual({ ok: 2, failed: 0 });
    expect(data.results).toMatchObject([
      { ok: true, itemId: 'P-001', from: [], to: ['P-002'] },
      { ok: true, itemId: 'P-002', from: ['P-001'], to: [] },
    ]);
    expect(data.results[0]?.revision).toEqual(data.results[1]?.revision);
    const after = await livePlan();
    expect(after.version).toBe(before.version + 1);
    expect(after.content).toContain('first blocked-by: P-002');
    expect(after.content).not.toContain('second blocked-by:');
    const parsed = parsePlan(after.content);
    expect(parsed.frontmatter.status).toBe('ready');
    expect(
      parsed.items.map((item) => ({ id: item.id, status: item.storedStatus, phase: item.phase })),
    ).toEqual([
      { id: 'P-001', status: 'todo', phase: 'Phase 1' },
      { id: 'P-002', status: 'todo', phase: 'Phase 1' },
    ]);
  }, 60_000);

  it('aborts every same-plan edit when one item is missing', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    const before = await livePlan();

    const data = await runSetBlockedByArgs({
      harness: HARNESS,
      items: [
        { slug: SLUG, item: 'P-001', blockedBy: ['P-002'] },
        { slug: SLUG, item: 'P-999', blockedBy: [] },
      ],
    });

    expect(data.counts).toEqual({ ok: 0, failed: 2 });
    expect(data.results).toMatchObject([
      {
        ok: false,
        itemId: 'P-001',
        error: 'atomic_group_aborted',
        cause: 'item_not_found',
        failedItemIds: ['P-999'],
      },
      { ok: false, itemId: 'P-999', error: 'item_not_found' },
    ]);
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('rejects an atomic batch whose final graph is cyclic without committing an intermediate edit', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    const before = await livePlan();

    const data = await runSetBlockedByArgs({
      harness: HARNESS,
      items: [
        { slug: SLUG, item: 'P-001', blockedBy: ['P-002'] },
        { slug: SLUG, item: 'P-002', blockedBy: ['P-001'] },
      ],
    });

    expect(data.counts).toEqual({ ok: 0, failed: 2 });
    expect(data.results).toMatchObject([
      { ok: false, itemId: 'P-001', error: 'invalid_plan_dependencies' },
      { ok: false, itemId: 'P-002', error: 'invalid_plan_dependencies' },
    ]);
    expect(data.results[0]?.dependencyDiagnostics).toEqual(data.results[1]?.dependencyDiagnostics);
    expect(await livePlan()).toEqual(before);
  }, 60_000);

  it('keeps heterogeneous plan groups independent when one group is refused', async () => {
    const otherSlug = `${SLUG}-other`;
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    await seedPlan(admin, wsId, HARNESS, otherSlug, planBody('ready', {}, otherSlug));
    const firstBefore = await livePlan();
    const otherBefore = await livePlan(otherSlug);

    const data = await runSetBlockedByArgs({
      harness: HARNESS,
      items: [
        { slug: SLUG, item: 'P-001', blockedBy: ['P-001'] },
        { slug: otherSlug, item: 'P-001', blockedBy: ['P-002'] },
      ],
    });

    expect(data.counts).toEqual({ ok: 1, failed: 1 });
    expect(data.results).toMatchObject([
      { ok: false, slug: SLUG, itemId: 'P-001', error: 'self_block' },
      { ok: true, slug: otherSlug, itemId: 'P-001', to: ['P-002'] },
    ]);
    expect(await livePlan()).toEqual(firstBefore);
    const otherAfter = await livePlan(otherSlug);
    expect(otherAfter.version).toBe(otherBefore.version + 1);
    expect(otherAfter.content).toContain('first blocked-by: P-002');
  }, 60_000);

  it('serializes concurrent reciprocal additions so exactly one edge lands and the cycle is refused', async () => {
    await seedPlan(admin, wsId, HARNESS, SLUG, planBody('ready'));
    const before = await livePlan();

    const [left, right] = await Promise.all([
      runSetBlockedBy('P-001', ['P-002']),
      runSetBlockedBy('P-002', ['P-001']),
    ]);

    const outcomes = [left.result, right.result];
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const refused = outcomes.find((result) => !result.ok);
    expect(refused).toMatchObject({
      ok: false,
      error: 'invalid_plan_dependencies',
      dependencyDiagnostics: [
        {
          code: 'dependency_cycle',
          members: ['P-001', 'P-002'],
          path: ['P-001', 'P-002', 'P-001'],
        },
      ],
    });

    const after = await livePlan();
    expect(after.version).toBe(before.version + 1);
    const edges = parsePlan(after.content).items.flatMap((item) =>
      item.blockedBy.map((blocker) => `${item.id}->${blocker}`),
    );
    expect(edges).toHaveLength(1);
    expect(['P-001->P-002', 'P-002->P-001']).toContain(edges[0]);
  }, 60_000);
});
