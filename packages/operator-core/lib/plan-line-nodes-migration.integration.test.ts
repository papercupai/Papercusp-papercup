// @vitest-environment node
/**
 * Migration 1601: plan lines become top-level work-item nodes, and blocked-by becomes
 * work_item_deps edges (one-work-graph-structured-holds-2026-10-26 P-003; design D-010, D-011).
 *
 * SPEC-P-003: every plan line is exactly one top-level work-item node, and the schema
 * refuses a second node for the same line.
 * SPEC-P-003-EDGES: every blocked-by entry between two lines of a plan is one edge between
 * their nodes in work_item_deps.
 *
 * Runs on a clone of the full armed migration chain (so the real work_items triggers fire),
 * seeds plans in their pre-1601 shape, then applies 1601 (the .DRAFT until it is armed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

const here = dirname(fileURLToPath(import.meta.url));
const ARMED = resolve(here, '../../../libs/papercusp/libs/db/sql/1601-plan-line-work-item-nodes.sql');
const MIGRATION = existsSync(ARMED) ? ARMED : `${ARMED}.DRAFT`;

const WS = 'ws-1601-a';
const WS2 = 'ws-1601-b';
const H = 'papercusp';
const PLAN = 'plan-1601';
const BY = 'migration:plan-line-work-item-nodes';

interface Line {
  id: string;
  seq: number;
  status: string;
  blockedBy?: string[] | null;
  phase?: string;
  importance?: string;
  decisions?: string[];
  deliverable?: string;
}

const LINES: Line[] = [
  { id: 'P-001', seq: 1, status: 'done' },
  { id: 'P-002', seq: 2, status: 'todo', blockedBy: ['P-001'], phase: 'build', importance: 'high', decisions: ['D-001'], deliverable: 'code' },
  { id: 'P-003', seq: 3, status: 'todo' },
  { id: 'P-004', seq: 4, status: 'dropped' },
  { id: 'P-005', seq: 5, status: 'done', blockedBy: ['P-003'] },
  { id: 'P-006', seq: 6, status: 'blocked', blockedBy: [] },
  { id: 'P-007', seq: 7, status: 'todo', blockedBy: ['P-099'] },
  { id: 'P-008', seq: 8, status: 'todo', blockedBy: ['P-008'] },
  { id: 'P-009', seq: 9, status: 'wip' },
  { id: 'P-010', seq: 10, status: 'todo' },
  { id: 'P-011', seq: 11, status: 'needs-human', blockedBy: [' P-002', 'P-003'] },
];

let db: OrgTestDb;
let sql: postgres.Sql;

async function applyMigration(): Promise<void> {
  // A multi-statement simple query runs as one implicit transaction, so the file's own
  // BEGIN/COMMIT are dropped (postgres.js refuses a raw BEGIN on a pooled connection).
  const text = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((l) => !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
    .join('\n');
  await sql.unsafe(text).simple();
}

async function seedPlan(ws: string, lines: Line[]): Promise<void> {
  await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
            VALUES (${ws}, ${H}, ${PLAN})`;
  for (const l of lines) {
    await sql`
      INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status, importance, phase,
         blocked_by, decision_refs, deliverable)
      VALUES (${ws}, ${H}, ${PLAN}, ${l.id}, ${l.seq}, ${`Line ${l.id} text`}, ${l.status},
              ${l.importance ?? null}, ${l.phase ?? null},
              ${l.blockedBy === null ? null : sql.array(l.blockedBy ?? [])},
              ${sql.array(l.decisions ?? [])}, ${l.deliverable ?? null})`;
  }
}

async function seedItem(i: {
  id: string; kind?: string; status?: string; line?: string; createdTs: number; parent?: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, nature, audience, origin,
       source_plan_slug, source_plan_item_ids, created_ts, updated_ts, ts, parent_id)
    VALUES (${WS}, ${H}, ${i.id}, ${`item ${i.id}`}, ${i.status ?? 'open'}, ${i.kind ?? 'feature'},
            'work', 'agent', 'local', ${i.line ? PLAN : null},
            ${i.line ? sql.array([i.line]) : null}, ${i.createdTs}, ${i.createdTs}, ${i.createdTs},
            ${i.parent ?? null})`;
}

async function nodeOf(ws: string, line: string) {
  const rows = await sql<Record<string, any>[]>`
    SELECT * FROM harness_shared.work_items
     WHERE workspace_id = ${ws} AND harness_slug = ${H} AND plan_slug = ${PLAN} AND plan_line_id = ${line}`;
  expect(rows, `nodes for ${ws} ${line}`).toHaveLength(1);
  return rows[0]!;
}

function ref(n: Record<string, any>): { kind: string; ref: string } {
  return ['bug', 'change', 'task', 'cleanup'].includes(n.item_kind)
    ? { kind: 'issue', ref: n.feature_id }
    : { kind: 'feature', ref: `${H}#${n.feature_id}` };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  await seedPlan(WS, LINES);
  await seedPlan(WS2, [{ id: 'P-001', seq: 1, status: 'todo' }]);
  await seedItem({ id: 'EI-1601-a', kind: 'change', status: 'done', line: 'P-001', createdTs: 1_000 });
  await seedItem({ id: 'WI-1601-b', line: 'P-002', createdTs: 1_000 });
  await seedItem({ id: 'WI-1601-c', line: 'P-002', createdTs: 2_000 });
  await seedItem({ id: 'WI-1601-x', createdTs: 1_000 });
  await seedItem({ id: 'WI-1601-d', line: 'P-010', createdTs: 1_000, parent: 'WI-1601-x' });
  await applyMigration();
}, 600_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 1601: plan lines become work-item nodes (SPEC-P-003)', () => {
  it('gives every plan line in every workspace exactly one top-level node', async () => {
    const rows = await sql<{ workspace_id: string; lines: number; nodes: number; top_level: number }[]>`
      SELECT pi.workspace_id, count(*)::int AS lines,
             count(n.feature_id)::int AS nodes,
             count(n.feature_id) FILTER (WHERE n.parent_id IS NULL)::int AS top_level
        FROM harness_shared.plan_items pi
        LEFT JOIN harness_shared.work_items n
          ON n.workspace_id = pi.workspace_id AND n.harness_slug = pi.harness_slug
         AND n.plan_slug = pi.plan_slug AND n.plan_line_id = pi.item_id
       WHERE pi.workspace_id IN (${WS}, ${WS2})
       GROUP BY pi.workspace_id ORDER BY pi.workspace_id`;
    expect(rows).toEqual([
      { workspace_id: WS, lines: LINES.length, nodes: LINES.length, top_level: LINES.length },
      { workspace_id: WS2, lines: 1, nodes: 1, top_level: 1 },
    ]);
  });

  it('attaches the earliest unparented stamped work-item and copies the plan fields onto it', async () => {
    expect((await nodeOf(WS, 'P-001')).feature_id).toBe('EI-1601-a');
    const n = await nodeOf(WS, 'P-002');
    expect(n).toMatchObject({
      feature_id: 'WI-1601-b', plan_seq: 2, plan_phase: 'build', plan_importance: 'high',
      plan_decision_refs: ['D-001'], plan_deliverable: 'code', plan_line_text: 'Line P-002 text',
    });
  });

  it('hangs the line\'s other stamped work-items under its node', async () => {
    const [c] = await sql`SELECT parent_id, plan_line_id FROM harness_shared.work_items
                           WHERE workspace_id = ${WS} AND feature_id = 'WI-1601-c'`;
    expect(c).toEqual({ parent_id: 'WI-1601-b', plan_line_id: null });
  });

  it('creates open nodes parked out of self-selection and terminal nodes closed (D-011)', async () => {
    const open = await nodeOf(WS, 'P-003');
    expect(open).toMatchObject({ status: 'open', item_kind: 'feature', admission: null, parent_id: null });
    expect(open.payload).toMatchObject({ _claimHold: true, claim_hold_by: BY });
    expect(open.feature_id).toMatch(/^WI-/);
    for (const [line, status] of [['P-004', 'dropped'], ['P-005', 'done']] as const) {
      const n = await nodeOf(WS, line);
      expect(n.status).toBe(status);
      expect(n.closed_ts).not.toBeNull();
      expect(n.payload?._claimHold).toBeUndefined();
    }
    const ids = await sql`SELECT count(DISTINCT feature_id)::int AS n FROM harness_shared.work_items
                           WHERE workspace_id = ${WS} AND plan_line_id IS NOT NULL`;
    expect(ids[0]!.n).toBe(LINES.length);
  });

  it('leaves a stamped work-item that already has a parent in place', async () => {
    const [d] = await sql`SELECT parent_id, plan_line_id FROM harness_shared.work_items
                           WHERE workspace_id = ${WS} AND feature_id = 'WI-1601-d'`;
    expect(d).toEqual({ parent_id: 'WI-1601-x', plan_line_id: null });
    expect((await nodeOf(WS, 'P-010')).feature_id).not.toBe('WI-1601-d');
  });

  it('refuses a second node for a line, a nested node and a half-set line pair', async () => {
    const base = { workspace_id: WS, harness_slug: H, title: 't', status: 'open', item_kind: 'feature', nature: 'work' };
    await expect(sql`INSERT INTO harness_shared.work_items ${sql({ ...base, feature_id: 'WI-1601-dup', plan_slug: PLAN, plan_line_id: 'P-003' })}`)
      .rejects.toMatchObject({ code: '23505' });
    await expect(sql`INSERT INTO harness_shared.work_items ${sql({ ...base, feature_id: 'WI-1601-half', plan_slug: PLAN })}`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE harness_shared.work_items SET parent_id = 'WI-1601-x'
                      WHERE workspace_id = ${WS} AND plan_slug = ${PLAN} AND plan_line_id = 'P-003'`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE harness_shared.work_items SET plan_deliverable = 'Not A Type'
                      WHERE workspace_id = ${WS} AND plan_slug = ${PLAN} AND plan_line_id = 'P-003'`)
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('migration 1601: blocked-by becomes work_item_deps edges (SPEC-P-003-EDGES)', () => {
  it('writes exactly one settled blocks-edge per blocked-by pair between two lines', async () => {
    const pairs: [string, string][] = [['P-002', 'P-001'], ['P-005', 'P-003'], ['P-011', 'P-002'], ['P-011', 'P-003']];
    const expected = [];
    for (const [blocked, blocker] of pairs) {
      const a = ref(await nodeOf(WS, blocked));
      const b = ref(await nodeOf(WS, blocker));
      expected.push({ blocked_kind: a.kind, blocked_ref: a.ref, blocker_kind: b.kind, blocker_ref: b.ref,
                      dep_type: 'blocks', satisfaction: 'settled', workspace_id: 'default' });
    }
    const edges = await sql`
      SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, workspace_id
        FROM harness_shared.work_item_deps WHERE created_by = ${BY}
       ORDER BY blocked_ref, blocker_ref`;
    const sortKey = (e: { blocked_ref: string; blocker_ref: string }) => `${e.blocked_ref}|${e.blocker_ref}`;
    expect([...edges].sort((x, y) => sortKey(x as any).localeCompare(sortKey(y as any))))
      .toEqual(expected.sort((x, y) => sortKey(x).localeCompare(sortKey(y))));
    // An issue-family node is addressed by its bare id, a feature node by harness#id.
    expect(edges.find((e) => e.blocker_ref === 'EI-1601-a'))
      .toMatchObject({ blocker_kind: 'issue', blocked_kind: 'feature', blocked_ref: `${H}#WI-1601-b` });
  });

  it('records contradictions as findings instead of resolving them silently', async () => {
    const rows = await sql<{ plan_line_id: string; finding_kind: string }[]>`
      SELECT plan_line_id, finding_kind FROM harness_shared.plan_line_conversion_findings
       WHERE workspace_id = ${WS} ORDER BY plan_line_id, finding_kind`;
    expect(rows.map((r) => [r.plan_line_id, r.finding_kind])).toEqual([
      ['P-006', 'blocked-line-without-edges'],
      ['P-007', 'blocker-line-missing'],
      ['P-008', 'self-blocking-line'],
      ['P-009', 'active-line-without-work-item'],
      ['P-010', 'stamped-item-has-parent'],
      ['P-011', 'active-line-without-work-item'],
    ]);
  });
});

describe('migration 1601: idempotency', () => {
  it('is a no-op when re-applied or when the conversion is called again', async () => {
    const snapshot = async () => sql`
      SELECT (SELECT count(*)::int FROM harness_shared.work_items WHERE workspace_id IN (${WS}, ${WS2})) AS items,
             (SELECT count(*)::int FROM harness_shared.work_item_deps WHERE created_by = ${BY}) AS edges,
             (SELECT count(*)::int FROM harness_shared.plan_line_conversion_findings
               WHERE workspace_id IN (${WS}, ${WS2})) AS findings`;
    const before = await snapshot();
    await applyMigration();
    const [again] = await sql`SELECT * FROM harness_shared.convert_plan_lines_to_nodes(${WS})`;
    expect(again).toEqual({ attached: 0, created: 0, children: 0, edges: 0, findings: 6 });
    expect(await snapshot()).toEqual(before);
  });
});
