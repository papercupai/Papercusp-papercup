/**
 * work-group.integration.test.ts — plan work-group membership, the cross-user
 * PULL opt-in (D-005, migration 140), against a real Postgres (testcontainer).
 *
 * The behavior a fake-sql unit test can't prove is the composite-key SCOPING that
 * IS the cross-user gate: workGroupExists / isWorkGroupMember must be keyed on
 * (workspace, harness, plan, user). Get the plan filter wrong and one plan's
 * work-group leaks into another — flipping the pull gate open where it should be
 * shut. Plus the join upsert (ON CONFLICT DO UPDATE member_name).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { joinWorkGroup, leaveWorkGroup, isWorkGroupMember, workGroupExists, listWorkGroup } =
  await import('./work-group');

const WS = 'ws-wg';
const HARNESS = 'web';
const PLAN_A = 'plan-a';
const PLAN_B = 'plan-b';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `wg_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // plan_work_group_members, faithful to migration 140 (4-col PK + member nonempty CHECK).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plan_work_group_members (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      member_user text NOT NULL,
      member_name text,
      joined_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT plan_work_group_members_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, member_user),
      CONSTRAINT plan_work_group_members_user_nonempty CHECK (member_user <> '')
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('plan work-group membership (PG)', () => {
  it('a plan with no members has no work-group (the gate is OPEN until declared)', async () => {
    expect(await workGroupExists(WS, HARNESS, PLAN_A)).toBe(false);
    expect(await isWorkGroupMember(WS, HARNESS, PLAN_A, 'alice')).toBe(false);
  });

  it('joinWorkGroup declares the work-group and adds the member', async () => {
    const m = await joinWorkGroup(WS, HARNESS, PLAN_A, 'alice', 'builder-1');
    expect(m).toMatchObject({ planSlug: PLAN_A, memberUser: 'alice', memberName: 'builder-1' });
    expect(await workGroupExists(WS, HARNESS, PLAN_A)).toBe(true); // gate now SHUT (pull-only)
    expect(await isWorkGroupMember(WS, HARNESS, PLAN_A, 'alice')).toBe(true);
    expect(await isWorkGroupMember(WS, HARNESS, PLAN_A, 'bob')).toBe(false);
  });

  it('re-joining is an upsert — updates member_name, stays ONE row', async () => {
    await joinWorkGroup(WS, HARNESS, PLAN_A, 'alice', 'queen-9'); // same key, new name
    const all = await listWorkGroup(WS, HARNESS, PLAN_A);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ memberUser: 'alice', memberName: 'queen-9' });
  });

  it('membership is SCOPED to its plan — plan A members do not make plan B exist', async () => {
    expect(await workGroupExists(WS, HARNESS, PLAN_A)).toBe(true);
    expect(await workGroupExists(WS, HARNESS, PLAN_B)).toBe(false); // independent plan
    expect(await isWorkGroupMember(WS, HARNESS, PLAN_B, 'alice')).toBe(false);
  });

  it('listWorkGroup returns every member of the plan (and only that plan)', async () => {
    await joinWorkGroup(WS, HARNESS, PLAN_A, 'carol', null);
    await joinWorkGroup(WS, HARNESS, PLAN_B, 'dave', null); // other plan
    const a = (await listWorkGroup(WS, HARNESS, PLAN_A)).map((m) => m.memberUser).sort();
    expect(a).toEqual(['alice', 'carol']);
    expect((await listWorkGroup(WS, HARNESS, PLAN_B)).map((m) => m.memberUser)).toEqual(['dave']);
  });

  it('leaveWorkGroup removes the member (true), is false when there was nothing to remove', async () => {
    expect(await leaveWorkGroup(WS, HARNESS, PLAN_A, 'alice')).toBe(true);
    expect(await isWorkGroupMember(WS, HARNESS, PLAN_A, 'alice')).toBe(false);
    expect(await leaveWorkGroup(WS, HARNESS, PLAN_A, 'alice')).toBe(false); // already gone
    expect(await workGroupExists(WS, HARNESS, PLAN_A)).toBe(true); // carol still there
    await leaveWorkGroup(WS, HARNESS, PLAN_A, 'carol');
    expect(await workGroupExists(WS, HARNESS, PLAN_A)).toBe(false); // last member gone → gate OPEN again
  });
});
