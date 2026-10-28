/**
 * fleet-roster.integration.test.ts — end-to-end proof for WI-1408
 * ("--fleet join registration must actually set fleetSlug, not null").
 *
 * `listFleetRoster` (the real IO-integrated roster read, used by fleet:status /
 * fleet:recolor) previously had ZERO test coverage of any kind — only its pure
 * helpers (filterPresenceToFleet / foldFleetRoster) were unit-tested. This file
 * closes that gap against REAL Postgres (the baseline-schema fixture, same
 * pattern as assignments.integration.test.ts / presence.integration.test.ts).
 *
 * It drives the exact mechanism a `--fleet=<slug>` launch goes through end to
 * end, WITHOUT hand-simulating the DB writes (WI-1893 cluster-safe form — the
 * old per-worker in-memory setPendingFleet map is GONE):
 *
 *   1. `appendFleetMembershipIfAbsent(...)` — what bootstrap-su.ts /
 *      bootstrap-role.ts / operator-spawn call AT BOOT, in whichever cluster
 *      worker serves the launch: the DURABLE membership fact
 *      (harness_shared.fleet_membership_events).
 *   2. `writePresence(identity, ...)` — the member's own first presence write,
 *      exactly as psu-launcher's bootstrap call triggers, usually served by a
 *      DIFFERENT worker. The mig-430 materialize trigger applies the fact onto
 *      the fresh presence row (fact-first ordering — the exact ordering the old
 *      in-memory map lost).
 *
 * Then it asserts the WI's explicit TERMINAL bar on the two real read surfaces
 * named in the dossier:
 *   (a) the raw `coord_presence.fleet_slug` column is non-null (the bug was:
 *       it stayed null), and
 *   (b) the member "shows grouped under that fleet" in BOTH `listFleetRoster`
 *       (the fleet:status/roster reader) and `listFleetAssignments` +
 *       `groupByAgent` (fleet:assignments, the claim-primary reader).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { writePresence } from '../agent-tools/coordination/presence';
import { appendFleetMembershipIfAbsent } from '../fleet-membership-store';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { listFleetRoster } from './fleet-roster';
import { listFleetAssignments, groupByAgent } from './assignments';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'default';

async function truncateAll(): Promise<void> {
  await admin`TRUNCATE harness_shared.coord_presence`;
  await admin`TRUNCATE harness_shared.fleet_membership_events RESTART IDENTITY`;
  await admin`TRUNCATE harness_shared.plan_item_claims`;
  await admin`TRUNCATE harness_shared.plan_item_assignments`;
  await admin`DELETE FROM harness_shared.session_briefs WHERE owner_id LIKE 'fr-test-%'`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
  await truncateAll();
}, 120_000);

afterAll(async () => {
  await truncateAll().catch(() => {});
  await fx.dispose();
});

beforeEach(async () => {
  await truncateAll();
});

function memberIdentity(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'fleet-spawn',
    workspaceId: WS,
    userId: null,
  };
}

async function withFleetEnvCleared<T>(run: () => Promise<T>): Promise<T> {
  const prevSlug = process.env.PAPERCUSP_FLEET_SLUG;
  const prevRole = process.env.PAPERCUSP_FLEET_ROLE;
  delete process.env.PAPERCUSP_FLEET_SLUG;
  delete process.env.PAPERCUSP_FLEET_ROLE;
  try {
    return await run();
  } finally {
    if (prevSlug === undefined) delete process.env.PAPERCUSP_FLEET_SLUG;
    else process.env.PAPERCUSP_FLEET_SLUG = prevSlug;
    if (prevRole === undefined) delete process.env.PAPERCUSP_FLEET_ROLE;
    else process.env.PAPERCUSP_FLEET_ROLE = prevRole;
  }
}

describe('--fleet launch registration → real fleetSlug + roster grouping (WI-1408)', () => {
  it('a member launched with --fleet (fleet:launch-on-plan path) registers with a non-null fleetSlug and shows grouped under that fleet in listFleetRoster + fleet:assignments', async () => {
    const ownerId = 'fr-test-member';
    const fleetSlug = 'fr-test-fleet-alpha';
    const identity = memberIdentity(ownerId);

    // 1. What bootstrap-su.ts does once resolveFleet() resolves the --fleet join:
    //    stamp the DURABLE membership fact at boot (WI-1893 — worker-agnostic,
    //    unlike the removed in-memory pending map).
    await appendFleetMembershipIfAbsent({
      workspaceId: WS,
      ownerId,
      ownerLabel: ownerId,
      fleetSlug,
      fleetRole: 'member',
    });

    // 2. The member's own first presence write (psu-launcher's bootstrap call) —
    //    the mig-430 trigger materializes the fact onto the fresh row.
    await writePresence(identity, { intent: 'building' }, null);

    // (a) the raw column: this is the exact bug the WI describes — it must NOT be null.
    const rows = await admin`
      SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
      WHERE workspace_id = ${WS} AND owner_id = ${ownerId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fleet_slug).toBe(fleetSlug);
    expect(rows[0]!.fleet_role).toBe('member');

    // (b1) shows grouped under that fleet in the roster (fleet:status reader).
    const roster = await listFleetRoster({ fleetSlug, workspaceId: WS });
    expect(roster.map((r) => r.agentId)).toContain(ownerId);
    const rosterEntry = roster.find((r) => r.agentId === ownerId)!;
    expect(rosterEntry.fleetSlug).toBe(fleetSlug);
    expect(rosterEntry.fleetRole).toBe('member');

    // A different fleet's roster must NOT pick up this member (scoping sanity).
    const otherRoster = await listFleetRoster({ fleetSlug: 'fr-test-fleet-unrelated', workspaceId: WS });
    expect(otherRoster.map((r) => r.agentId)).not.toContain(ownerId);

    // (b2) shows grouped under that fleet in fleet:assignments (the claim-primary reader).
    const assignmentRows = await listFleetAssignments({ workspaceId: WS });
    const grouped = groupByAgent(assignmentRows);
    const assignmentEntry = grouped.find((a) => a.agentId === ownerId);
    expect(assignmentEntry).toBeDefined();
    expect(assignmentEntry!.fleetSlug).toBe(fleetSlug);
    expect(assignmentEntry!.fleetRole).toBe('member');
  });

  it('keeps all recent respawn-style member identities in the canonical fleet roster', async () => {
    const fleetSlug = 'fr-test-fleet-respawned';
    const ownerIds = [
      'su-respawn-63bfff47ddf3583f5111e499fb21db10',
      'su-respawn-a0591f4fa7c5fb461e434592f28b4d7d',
      'su-respawn-ebb0fbe43e480e827420268a317e294b',
    ];

    for (const ownerId of ownerIds) {
      await appendFleetMembershipIfAbsent({
        workspaceId: WS,
        ownerId,
        ownerLabel: ownerId,
        fleetSlug,
        fleetRole: 'member',
      });
      await writePresence(memberIdentity(ownerId), { intent: 'resumed with current work' }, null);
    }

    const roster = await listFleetRoster({ fleetSlug, workspaceId: WS });

    expect(roster.map((entry) => entry.agentId)).toEqual(expect.arrayContaining(ownerIds));
    expect(roster.filter((entry) => ownerIds.includes(entry.agentId))).toHaveLength(3);
  });

  it('a direct member launch with --fleet (bootstrap-role path) also lands a non-null fleetSlug', async () => {
    // Mirrors bootstrap-role.ts's own boot-time membership stamp keyed by
    // spec.sid — a historically SEPARATE bug from bootstrap-su's, per the
    // route's WI-1408 doc-comments. Exercised here as a second, distinct
    // caller identity so the two launch paths can't share a false-positive.
    const ownerId = 'fr-test-member-direct';
    const fleetSlug = 'fr-test-fleet-bravo';
    const identity = memberIdentity(ownerId);

    await appendFleetMembershipIfAbsent({
      workspaceId: WS,
      ownerId,
      ownerLabel: ownerId,
      fleetSlug,
      fleetRole: 'leader',
    });
    await writePresence(identity, { intent: 'leading' }, null);

    const rows = await admin`
      SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
      WHERE workspace_id = ${WS} AND owner_id = ${ownerId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fleet_slug).toBe(fleetSlug);
    expect(rows[0]!.fleet_role).toBe('leader');

    const roster = await listFleetRoster({ fleetSlug, workspaceId: WS });
    expect(roster.map((r) => r.agentId)).toContain(ownerId);
  });

  it('with no pending fleet placement, a plain presence write leaves fleetSlug null (control — no false positives)', async () => {
    const ownerId = 'fr-test-member-unfleeted';
    const identity = memberIdentity(ownerId);

    await withFleetEnvCleared(async () => {
      await writePresence(identity, { intent: 'idle' }, null);
    });

    const rows = await admin`
      SELECT fleet_slug FROM harness_shared.coord_presence
      WHERE workspace_id = ${WS} AND owner_id = ${ownerId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fleet_slug).toBeNull();
  });
});
