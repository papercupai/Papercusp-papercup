// @vitest-environment node
/**
 * Migration 1602: a plan-line node is work, so it never sits in the observation lane
 * (WI-6554700010042249, follow-up to one-work-graph-structured-holds-2026-10-26 P-003).
 *
 * Seeds plans in their pre-1601 shape with observation-lane items stamped onto lines, applies
 * 1601 with the 1602 trigger absent (the state 1601 left in production), then applies 1602.
 * Runs on a clone of the full armed migration chain, so the real work_items triggers fire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(here, '../../../libs/papercusp/libs/db/sql');
const armedOrDraft = (name: string) => {
  const armed = resolve(SQL_DIR, name);
  return existsSync(armed) ? armed : `${armed}.DRAFT`;
};
const M1601 = armedOrDraft('1601-plan-line-work-item-nodes.sql');
const M1602 = armedOrDraft('1602-plan-line-node-is-work.sql');

const WS = 'ws-1602';
const H = 'papercusp';
const PLAN = 'plan-1602';
const HOLD_BY = 'migration:plan-line-work-item-nodes';
const TRIGGER = 'plan_line_node_leaves_observation_lane';

let db: OrgTestDb;
let sql: postgres.Sql;

async function apply(path: string): Promise<void> {
  // A multi-statement simple query runs as one implicit transaction, so the file's own
  // BEGIN/COMMIT are dropped (postgres.js refuses a raw BEGIN on a pooled connection).
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
    .join('\n');
  await sql.unsafe(text).simple();
}

async function seedLine(id: string, seq: number, status: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
    VALUES (${WS}, ${H}, ${PLAN}, ${id}, ${seq}, ${`Line ${id} text`}, ${status})`;
}

async function seedItem(i: {
  id: string; line?: string; status?: string; lane?: string | null; payload?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, nature, audience, origin,
       source_plan_slug, source_plan_item_ids, created_ts, updated_ts, ts, payload)
    VALUES (${WS}, ${H}, ${i.id}, ${`item ${i.id}`}, ${i.status ?? 'open'}, 'change', 'work', 'agent',
            'local', ${i.line ? PLAN : null}, ${i.line ? sql.array([i.line]) : null}, 1000, 1000, 1000,
            ${sql.json((i.payload ?? {}) as postgres.JSONValue)})`;
}

async function item(id: string): Promise<Record<string, any>> {
  const [row] = await sql<Record<string, any>[]>`
    SELECT feature_id, plan_line_id, status, lane, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  expect(row, `item ${id}`).toBeDefined();
  return row!;
}

async function findings(): Promise<Array<[string, string]>> {
  const rows = await sql<{ plan_line_id: string; node: string }[]>`
    SELECT plan_line_id, detail ->> 'node' AS node FROM harness_shared.plan_line_conversion_findings
     WHERE workspace_id = ${WS} AND finding_kind = 'node-was-observation' ORDER BY plan_line_id`;
  return rows.map((r) => [r.plan_line_id, r.node]);
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  // Reproduce what 1601 left behind: the conversion ran before this rule existed.
  await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON harness_shared.work_items`);
  await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug) VALUES (${WS}, ${H}, ${PLAN})`;
  await seedLine('P-001', 1, 'todo');
  await seedLine('P-002', 2, 'done');
  await seedLine('P-003', 3, 'todo');
  await seedItem({ id: 'EI-1602-open-obs', line: 'P-001', lane: 'observation',
    payload: { lane: 'observation', keep: 'me' } });
  await seedItem({ id: 'EI-1602-done-obs', line: 'P-002', status: 'done', payload: { _lane: 'observation' } });
  await seedItem({ id: 'EI-1602-work', line: 'P-003', payload: { keep: 'me' } });
  await seedItem({ id: 'EI-1602-loose-obs', lane: 'observation', payload: { lane: 'observation' } });
  await apply(M1601);
  await sql`SELECT * FROM harness_shared.convert_plan_lines_to_nodes(${WS})`;
  expect((await item('EI-1602-open-obs')).lane, 'precondition: 1601 adopted an observation').toBe('observation');
  await apply(M1602);
}, 600_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 1602: nodes 1601 adopted from the observation lane become work', () => {
  it('clears the lane column and the observation payload keys, keeping other payload', async () => {
    const open = await item('EI-1602-open-obs');
    expect(open).toMatchObject({ plan_line_id: 'P-001', lane: null });
    expect(open.payload).not.toHaveProperty('lane');
    expect(open.payload.keep).toBe('me');
    const done = await item('EI-1602-done-obs');
    expect(done).toMatchObject({ plan_line_id: 'P-002', lane: null });
    expect(done.payload).not.toHaveProperty('_lane');
  });

  it('parks the open node the way 1601 parks the open nodes it creates, and not the done one', async () => {
    const open = await item('EI-1602-open-obs');
    expect(open.payload).toMatchObject({ _claimHold: true, claim_hold_by: HOLD_BY });
    expect(open.payload.claim_hold_reason).toContain('P-008');
    expect((await item('EI-1602-done-obs')).payload).not.toHaveProperty('_claimHold');
  });

  it('leaves ordinary nodes and observations that are not nodes alone', async () => {
    const work = await item('EI-1602-work');
    expect(work).toMatchObject({ plan_line_id: 'P-003', lane: null });
    expect(work.payload).toEqual({ keep: 'me' });
    expect(await item('EI-1602-loose-obs')).toMatchObject({ plan_line_id: null, lane: 'observation' });
  });

  it('records one node-was-observation finding per converted line', async () => {
    expect(await findings()).toEqual([
      ['P-001', 'EI-1602-open-obs'],
      ['P-002', 'EI-1602-done-obs'],
    ]);
  });
});

describe('migration 1602: the rule holds for later writers', () => {
  it('takes an observation out of the lane when a conversion re-run adopts it', async () => {
    await seedLine('P-004', 4, 'todo');
    await seedItem({ id: 'EI-1602-late-obs', line: 'P-004', lane: 'observation', payload: { lane: 'observation' } });
    const [run] = await sql`SELECT * FROM harness_shared.convert_plan_lines_to_nodes(${WS})`;
    expect(run).toMatchObject({ attached: 1, created: 0 });
    const late = await item('EI-1602-late-obs');
    expect(late).toMatchObject({ plan_line_id: 'P-004', lane: null });
    expect(late.payload).toMatchObject({ _claimHold: true, claim_hold_by: HOLD_BY });
    expect(late.payload).not.toHaveProperty('lane');
    expect(await findings()).toContainEqual(['P-004', 'EI-1602-late-obs']);
  });

  it('takes an existing node back out when a write puts it into the observation lane', async () => {
    await sql`UPDATE harness_shared.work_items SET payload = payload || '{"lane":"observation"}'::jsonb
               WHERE workspace_id = ${WS} AND feature_id = 'EI-1602-work'`;
    expect((await item('EI-1602-work')).lane).toBeNull();
    await sql`UPDATE harness_shared.work_items SET payload = payload || '{"_lane":"observation"}'::jsonb
               WHERE workspace_id = ${WS} AND feature_id = 'EI-1602-work'`;
    const work = await item('EI-1602-work');
    expect(work.lane).toBeNull();
    expect(work.payload).not.toHaveProperty('_lane');
    expect(await findings()).toContainEqual(['P-003', 'EI-1602-work']);
  });
});

describe('migration 1602: idempotency', () => {
  it('changes nothing when re-applied', async () => {
    const snapshot = async () => sql`
      SELECT (SELECT jsonb_agg(jsonb_build_array(feature_id, lane, payload) ORDER BY feature_id)
                FROM harness_shared.work_items WHERE workspace_id = ${WS}) AS items,
             (SELECT count(*)::int FROM harness_shared.plan_line_conversion_findings
               WHERE workspace_id = ${WS}) AS findings`;
    const before = await snapshot();
    await apply(M1602);
    expect(await snapshot()).toEqual(before);
  });
});
