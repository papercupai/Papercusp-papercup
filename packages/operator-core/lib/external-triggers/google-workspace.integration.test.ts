import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { provisionOwnedGoogleWorkspaceSources } from './google-workspace';

const WS = 'google-workspace-source-test';
// The retired built-in Calendar meeting-prep binding: connect used to ensure a
// launch-plan binding to this plan; app-agent-tasks-durable-execution-2026-10-06
// D-011 moved meeting prep to an app-submitted blueprint operation and retired
// it. Fixture-only now: nothing in the product names this plan any more.
const LEGACY_MEETING_PREP_HARNESS = 'papercusp';
const LEGACY_MEETING_PREP_PLAN = 'meeting-prep-brief-2026-08-22';
const LEGACY_MEETING_PREP_EVENT = 'ext:gcal:event-upcoming';
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'google-workspace-owner-' + Date.now()}, 'Workspace Owner')
    RETURNING id`;
  userId = users[0].id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  // Strict shared-container DROP DATABASE cleanup is documented at 6s-267s;
  // keep this real-PG suite on the canonical teardown budget instead of the
  // integration layer's ordinary 90s hook deadline (EI-21580561576387499).
}, 300_000);

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await sql`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS}
       AND harness_slug = ${LEGACY_MEETING_PREP_HARNESS}
       AND plan_slug = ${LEGACY_MEETING_PREP_PLAN}`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (
      ${WS}, ${LEGACY_MEETING_PREP_HARNESS}, ${LEGACY_MEETING_PREP_PLAN},
      'Meeting prep', 'ready', '# Meeting prep', 'meeting-prep-v1', '[]'::jsonb
    )`;
});

/** Every binding on this workspace's sources, retired (detached) ones included. */
async function allBindings(): Promise<
  Array<{ sourceKind: string; planSlug: string | null; armed: boolean; detached: boolean }>
> {
  return sql<Array<{ sourceKind: string; planSlug: string | null; armed: boolean; detached: boolean }>>`
    SELECT s.kind AS "sourceKind",
           b.plan_slug AS "planSlug",
           b.armed,
           (b.detached_at IS NOT NULL) AS detached
      FROM harness_shared.trigger_bindings b
      JOIN harness_shared.data_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
     WHERE b.workspace_id = ${WS}
     ORDER BY b.created_at, b.id`;
}

describe('Google Workspace owned trigger-source provisioning', () => {
  it('creates Gmail + Calendar + Contacts once and preserves cursors/preferences across re-consent', async () => {
    const first = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'owner@example.com',
      field: 'owner',
    });
    expect(first.map((row) => row.kind).sort()).toEqual(['contacts', 'gcal', 'gmail']);
    expect(first.every((row) => row.credentialRef === 'google-workspace:owner')).toBe(true);

    const calendar = first.find((row) => row.kind === 'gcal')!;
    await sql`
      UPDATE harness_shared.data_sources
         SET cursor = '{"syncToken":"keep-me"}'::jsonb,
             status = 'degraded',
             last_error = 'transient'
       WHERE workspace_id = ${WS} AND id = ${calendar.id}::uuid`;
    const contacts = first.find((row) => row.kind === 'contacts')!;
    await sql`
      UPDATE harness_shared.data_sources
         SET config = config || '{"capabilityEnabled":false}'::jsonb,
             status = 'disabled'
       WHERE workspace_id = ${WS} AND id = ${contacts.id}::uuid`;

    const second = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'owner@example.com',
      field: 'owner-reconnected',
    });
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(second.every((row) => row.credentialRef === 'google-workspace:owner-reconnected')).toBe(true);
    expect(second.filter((row) => row.kind !== 'contacts').every((row) => row.status === 'connected')).toBe(true);
    expect(second.find((row) => row.kind === 'contacts')).toMatchObject({
      status: 'disabled',
      config: { capabilityEnabled: false },
    });
    expect(second.find((row) => row.kind === 'gcal')?.cursor).toEqual({ syncToken: 'keep-me' });

    const rows = await sql<Array<{ kind: string; count: number }>>`
      SELECT kind, count(*)::int AS count
        FROM harness_shared.data_sources
       WHERE workspace_id = ${WS} AND owner_user_id = ${userId}::uuid
       GROUP BY kind
       ORDER BY kind`;
    expect(rows).toEqual([
      { kind: 'contacts', count: 1 },
      { kind: 'gcal', count: 1 },
      { kind: 'gmail', count: 1 },
    ]);

    // Connect and re-consent create no binding on any Google source: Gmail
    // drafts are opt-in through a trigger pack (D-019.3) and Calendar meeting
    // prep is submitted by the Calendar app (app-agent-tasks D-011).
    expect(await allBindings()).toEqual([]);
  });

  it('keeps a second account and its reconnect isolated across sources, cursors, credentials, and bindings', async () => {
    const first = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'first@example.com',
      field: 'first-field',
    });
    const firstGmail = first.find((row) => row.kind === 'gmail')!;
    await sql`
      UPDATE harness_shared.data_sources
         SET cursor = '{"historyId":"keep-first-history"}'::jsonb,
             status = 'degraded',
             last_error = 'first-account-transient'
       WHERE workspace_id = ${WS} AND id = ${firstGmail.id}::uuid`;

    const second = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'second@example.com',
      field: 'second-field',
    });
    expect(second.map((row) => row.kind).sort()).toEqual(['contacts', 'gcal', 'gmail']);
    expect(second.every((row) => row.credentialRef === 'google-workspace:second-field')).toBe(true);
    expect(second.every((row) => first.every((candidate) => candidate.id !== row.id))).toBe(true);

    const rowsBeforeReconnect = await sql<
      Array<{
        id: string;
        kind: string;
        providerAccountId: string;
        credentialRef: string;
        status: string;
        cursor: Record<string, unknown>;
      }>
    >`
      SELECT id::text,
             kind,
             provider_account_id AS "providerAccountId",
             credential_ref AS "credentialRef",
             status,
             cursor
        FROM harness_shared.data_sources
       WHERE workspace_id = ${WS}
         AND owner_user_id = ${userId}::uuid
       ORDER BY provider_account_id, kind`;
    expect(rowsBeforeReconnect).toHaveLength(6);
    expect(
      rowsBeforeReconnect
        .filter((row) => row.providerAccountId === 'first@example.com')
        .map((row) => row.id)
        .sort(),
    ).toEqual(first.map((row) => row.id).sort());
    expect(
      rowsBeforeReconnect
        .filter((row) => row.providerAccountId === 'second@example.com')
        .map((row) => row.id)
        .sort(),
    ).toEqual(second.map((row) => row.id).sort());
    expect(rowsBeforeReconnect.find((row) => row.id === firstGmail.id)).toMatchObject({
      credentialRef: 'google-workspace:first-field',
      status: 'degraded',
      cursor: { historyId: 'keep-first-history' },
    });

    // Neither account's connect created a binding (D-019.3 / app-agent-tasks D-011).
    expect(await allBindings()).toEqual([]);

    const reconnectedSecond = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'second@example.com',
      field: 'second-rotated',
    });
    expect(reconnectedSecond.map((row) => row.id).sort()).toEqual(second.map((row) => row.id).sort());
    expect(reconnectedSecond.every((row) => row.credentialRef === 'google-workspace:second-rotated')).toBe(true);

    const rowsAfterReconnect = await sql<
      Array<{
        id: string;
        providerAccountId: string;
        credentialRef: string;
        status: string;
        cursor: Record<string, unknown>;
      }>
    >`
      SELECT id::text,
             provider_account_id AS "providerAccountId",
             credential_ref AS "credentialRef",
             status,
             cursor
        FROM harness_shared.data_sources
       WHERE workspace_id = ${WS}
         AND owner_user_id = ${userId}::uuid
       ORDER BY provider_account_id, kind`;
    const firstAfterReconnect = rowsAfterReconnect.filter((row) => row.providerAccountId === 'first@example.com');
    expect(firstAfterReconnect.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(firstAfterReconnect.every((row) => row.credentialRef === 'google-workspace:first-field')).toBe(true);
    expect(firstAfterReconnect.find((row) => row.id === firstGmail.id)).toMatchObject({
      status: 'degraded',
      cursor: { historyId: 'keep-first-history' },
    });

    // ...and neither did the reconnect.
    expect(await allBindings()).toEqual([]);
  });

  it('converges concurrent reconnects onto one source per kind and creates no binding', async () => {
    await Promise.all([
      provisionOwnedGoogleWorkspaceSources(sql, {
        workspaceId: WS,
        ownerUserId: userId,
        providerAccountId: 'owner@example.com',
        field: 'owner-a',
      }),
      provisionOwnedGoogleWorkspaceSources(sql, {
        workspaceId: WS,
        ownerUserId: userId,
        providerAccountId: 'owner@example.com',
        field: 'owner-b',
      }),
    ]);
    const rows = await sql<Array<{ kind: string; count: number }>>`
      SELECT kind, count(*)::int AS count
        FROM harness_shared.data_sources
       WHERE workspace_id = ${WS}
       GROUP BY kind
       ORDER BY kind`;
    expect(rows).toEqual([
      { kind: 'contacts', count: 1 },
      { kind: 'gcal', count: 1 },
      { kind: 'gmail', count: 1 },
    ]);
    expect(await allBindings()).toEqual([]);
  });

  // EI-25243055141955619: connect used to ensure a launch-plan meeting-prep
  // binding on the Calendar source, matching only NON-detached rows. Retiring
  // the binding (disarm + detach, app-agent-tasks D-011) therefore did not
  // stick: the next reconnect minted a fresh one. The retired row must stay
  // the only binding, still detached and disarmed, after a reconnect.
  it('does not resurrect a retired Calendar meeting-prep binding on reconnect', async () => {
    const first = await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'owner@example.com',
      field: 'owner',
    });
    const calendar = first.find((row) => row.kind === 'gcal')!;
    await sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, detached_at, created_by)
      VALUES (
        ${WS}, ${calendar.id}::uuid, ${LEGACY_MEETING_PREP_HARNESS}, ${LEGACY_MEETING_PREP_PLAN},
        ${LEGACY_MEETING_PREP_EVENT}, '{"attendees.0":{"exists":true}}'::jsonb,
        '{"type":"launch-plan"}'::jsonb, false, now(), 'test:retired-meeting-prep'
      )`;
    const retired = [{ sourceKind: 'gcal', planSlug: LEGACY_MEETING_PREP_PLAN, armed: false, detached: true }];
    expect(await allBindings()).toEqual(retired);

    await provisionOwnedGoogleWorkspaceSources(sql, {
      workspaceId: WS,
      ownerUserId: userId,
      providerAccountId: 'owner@example.com',
      field: 'owner-reconnected',
    });
    expect(await allBindings()).toEqual(retired);
  });
});
