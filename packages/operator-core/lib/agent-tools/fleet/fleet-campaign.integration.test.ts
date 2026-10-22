import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import {
  FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY,
  readFleetCampaign,
} from './fleet-campaign';

const WS = 'fleet-campaign-ws';
const HARNESS = 'fleet-campaign-harness';
const FLEET = 'campaign-alpha';
const MEMBER = 'su-campaign-member';
const SINCE = '2026-08-13T00:00:00.000Z';

describe('fleet campaign (real Postgres)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql`
      INSERT INTO harness_shared.fleet_membership_events
        (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event, at)
      VALUES
        (${WS}, ${MEMBER}, 'campaign member', ${FLEET}, 'member', 'join',
         '2026-08-13T01:00:00Z'::timestamptz)
    `;
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
         window_key, invoked_at, status, coord_owner_id)
      VALUES
        (990001, ${WS}, ${HARNESS}, 'core', 'scheduler:get_next', 'su', 'spawn-campaign',
         'campaign-window', '2026-08-13T02:00:00Z'::timestamptz, 'ok', ${MEMBER}),
        (990002, ${WS}, ${HARNESS}, 'core', 'work_items:complete', 'su', 'spawn-campaign',
         'campaign-window', '2026-08-13T03:00:00Z'::timestamptz, 'ok', ${MEMBER})
    `;
    await db.adminSql`
      INSERT INTO harness_shared.event_key_fires
        (workspace_id, event_key, first_fired_at, last_fired_at, fire_count)
      VALUES
        (${WS}, ${`fleet:item-completed:${FLEET}`}, '2026-08-13T02:30:00Z'::timestamptz,
         '2026-08-13T03:30:00Z'::timestamptz, 7)
    `;
    await db.adminSql`
      INSERT INTO harness_shared.task_ledger
        (task_id, workspace_id, harness_slug, root_task_id, class, title, argv,
         launched_by, state, started_at, detail)
      VALUES
        ('campaign-task', ${WS}, ${HARNESS}, 'campaign-task', 'test-run', 'campaign test',
         '[]'::jsonb, ${MEMBER}, 'exited', '2026-08-13T04:00:00Z'::timestamptz,
         '{"carry":"warm"}'::jsonb)
    `;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, payload,
         terminal_owner, terminal_completion_ref, authority, closed_ts)
      VALUES
        (${WS}, ${HARNESS}, 'campaign-member-close', 'member completion', 'done', 'change',
         '{"_completionEvidence":{"verifiedHow":"unit","testsRun":"npm run test:file -- fleet-campaign.integration.test.ts","testResult":"green","addedTests":true,"filesChanged":["fleet-campaign.ts"]}}'::jsonb,
         ${MEMBER}, 'verified member completion', 'committed',
         (extract(epoch FROM '2026-08-13T05:00:00Z'::timestamptz) * 1000)::bigint),
        (${WS}, ${HARNESS}, 'campaign-nonmember-close', 'non-member completion', 'done', 'change',
         '{}'::jsonb, 'su-not-in-fleet', 'newer non-member completion', 'proposed',
         (extract(epoch FROM '2026-08-13T06:00:00Z'::timestamptz) * 1000)::bigint)
    `;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('reads exact writer-backed membership, speaking, gate, and job flow', async () => {
    const campaign = await readFleetCampaign({
      workspaceId: WS,
      fleetSlug: FLEET,
      fleetCreatedAtMs: Date.parse('2026-08-12T00:00:00Z'),
      since: SINCE,
      harnessSlug: HARNESS,
    }, db.adminSql);

    expect(campaign.boundary).toEqual({ at: SINCE, source: 'explicit-since' });
    expect(campaign.everMembers).toMatchObject({ available: true, count: 1 });
    expect(campaign.axes.membership).toMatchObject({ available: true, data: { total: 1 } });
    expect(campaign.axes.speaking).toMatchObject({
      available: true,
      data: { calls: 2, distinctOwners: 1 },
    });
    expect(campaign.axes.gateEvents).toMatchObject({
      available: true,
      data: { activeKeys: 1, lifetimeFires: 7 },
    });
    expect(campaign.axes.jobs).toMatchObject({
      available: true,
      data: { total: 1, byCarry: { warm: 1 } },
    });
    expect(campaign.axes.terminals).toMatchObject({
      available: true,
      data: {
        byFleetMembership: { member: 1, nonMember: 1, unattributed: 0 },
        auditFeed: {
          total: 1,
          shown: 1,
          truncated: false,
          rows: [{
            id: 'campaign-member-close',
            terminalOwner: MEMBER,
            terminalCompletionRef: 'verified member completion',
            completionEvidence: {
              verifiedHow: 'unit',
              testsRun: 'npm run test:file -- fleet-campaign.integration.test.ts',
              testResult: 'green',
              addedTests: true,
              filesChanged: ['fleet-campaign.ts'],
            },
            completionAuthority: 'committed',
            countsTowardBurnDown: true,
            terminalizedAt: '2026-08-13T05:00:00.000Z',
          }],
        },
      },
    });
  });

  it('reports member-attributed axes unavailable for an unknown fleet, never zero', async () => {
    const campaign = await readFleetCampaign({
      workspaceId: WS,
      fleetSlug: 'unknown-fleet',
      fleetCreatedAtMs: Date.parse(SINCE),
      harnessSlug: HARNESS,
    }, db.adminSql);

    expect(campaign.everMembers).toMatchObject({ available: true, count: 0, reason: 'no-ever-members' });
    for (const axis of ['speaking', 'claims', 'terminals', 'jobs', 'corrections'] as const) {
      expect(campaign.axes[axis]).toMatchObject({
        available: false,
        data: null,
        reason: 'no-ever-members',
      });
    }
  });

  it('overlaps independent database axes within the bounded read width', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const instrumentedSql = new Proxy(db.adminSql, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args) as { then?: unknown };
        const firstSql =
          typeof args[0]?.[0] === 'string' ? args[0][0].trimStart().toUpperCase() : '';
        const isReadQuery = firstSql.startsWith('SELECT') || firstSql.startsWith('WITH');
        if (!isReadQuery || !result || typeof result.then !== 'function') return result;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        return Promise.resolve(result).finally(() => {
          inFlight -= 1;
        });
      },
    });

    const campaign = await readFleetCampaign(
      {
        workspaceId: WS,
        fleetSlug: FLEET,
        fleetCreatedAtMs: Date.parse('2026-08-12T00:00:00Z'),
        since: SINCE,
        harnessSlug: HARNESS,
      },
      instrumentedSql,
    );

    expect(campaign.axes.membership.available).toBe(true);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY);
  });
});
