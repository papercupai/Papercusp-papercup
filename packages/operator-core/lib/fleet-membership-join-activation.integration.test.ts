/**
 * EI-27031443048618869 — fleet "churn" was mostly dead launches. psu appends the `join` fact at
 * bootstrap, before the CLI boots, so a launch refused at boot still leaves a join behind. The
 * Luna Max fleet showed 754 joins in a week; 234 of them never made a single MCP call.
 *
 * `readJoinActivation` is the one definition every churn reader uses to split those out. These
 * cases pin it against a real Postgres, because the whole behaviour is in the SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import { JOIN_ACTIVATION_GRACE_SEC, readJoinActivation } from './fleet-membership-store';
import { readMembershipChurn } from './fleet-brief-delta-store';

const WS = 'join-activation-ws';
const FLEET = 'join-activation-fleet';
const SINCE = '2026-08-01T00:00:00.000Z';

describe('readJoinActivation (real Postgres)', () => {
  let db: OrgTestDb;
  let invocationId = 991000;

  async function join(ownerId: string, at: string, opts: { fleet?: string; ws?: string; event?: string } = {}) {
    await db.adminSql`
      INSERT INTO harness_shared.fleet_membership_events
        (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event, at)
      VALUES (${opts.ws ?? WS}, ${ownerId}, ${ownerId}, ${opts.fleet ?? FLEET}, 'member',
              ${opts.event ?? 'join'}, ${at}::timestamptz)
    `;
  }

  async function call(ownerId: string, at: string) {
    invocationId += 1;
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
         window_key, invoked_at, status, coord_owner_id)
      VALUES (${invocationId}, ${WS}, 'join-activation-harness', 'core', 'coord:orient', 'su',
              'spawn-join-activation', 'join-activation-window', ${at}::timestamptz, 'ok', ${ownerId})
    `;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Booted: joined, then called.
    await join('su-booted', '2026-08-02T01:00:00Z');
    await call('su-booted', '2026-08-02T01:03:00Z');
    // Dead at boot: joined, never called.
    await join('su-dead-a', '2026-08-02T02:00:00Z');
    await join('su-dead-b', '2026-08-02T03:00:00Z');
    // writePresence path: the join is appended DURING the first call, so the call precedes it.
    await join('su-joined-mid-call', '2026-08-02T04:00:00Z');
    await call('su-joined-mid-call', '2026-08-02T03:59:58Z');
    // A call from long before the join is a previous life, not this launch's activity.
    await call('su-stale-life', '2026-08-01T01:00:00Z');
    await join('su-stale-life', '2026-08-02T05:00:00Z');
    // Still booting: joined a moment ago, no call yet — not judgeable.
    await db.adminSql`
      INSERT INTO harness_shared.fleet_membership_events
        (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event, at)
      VALUES (${WS}, 'su-booting', 'su-booting', ${FLEET}, 'member', 'join', now() - interval '30 seconds')
    `;
    // Noise that must not be counted: another fleet, another workspace, a non-join event,
    // and a join before the window.
    await join('su-other-fleet', '2026-08-02T06:00:00Z', { fleet: 'some-other-fleet' });
    await join('su-other-ws', '2026-08-02T06:00:00Z', { ws: 'another-ws' });
    await join('su-leader', '2026-08-02T06:00:00Z', { event: 'lead' });
    await join('su-before-window', '2026-07-30T06:00:00Z');
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('splits joins into booted, dead-at-boot, and still-booting', async () => {
    const a = await readJoinActivation({ workspaceId: WS, fleetSlug: FLEET, since: SINCE }, db.adminSql);
    // booted, dead-a, dead-b, joined-mid-call, stale-life, booting.
    expect(a.joined).toBe(6);
    // dead-a, dead-b, and stale-life (its only call predates the join by a day).
    expect(a.neverActive).toBe(3);
    expect(a.pending).toBe(1);
  });

  it('judges a silent fresh join dead once the grace is shortened past it', async () => {
    // Positive control for the grace window: same data, zero grace, so the booting join
    // is no longer pending.
    const a = await readJoinActivation(
      { workspaceId: WS, fleetSlug: FLEET, since: SINCE, graceSec: 0 },
      db.adminSql,
    );
    expect(a.pending).toBe(0);
    expect(a.neverActive).toBe(4);
    expect(JOIN_ACTIVATION_GRACE_SEC).toBeGreaterThanOrEqual(300);
  });

  it('leader-brief churn carries the split alongside the raw join count', async () => {
    const churn = await readMembershipChurn({ workspaceId: WS, fleetSlug: FLEET, since: SINCE }, db.adminSql);
    expect(churn).toEqual({ joined: 6, left: 0, neverActive: 3, pending: 1 });
  });
});
