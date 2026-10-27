/**
 * repeat-report-reads.integration.test.ts — WI-6554700010029331, against REAL Postgres.
 *
 * Messages are persisted through the production `sendMessage`, so the stored
 * envelope (`from`, `to`, `summary`, `body`, the `citedItemStates` stamp) is
 * exactly what the rail reads in production. Pins:
 *   - a no-delta re-send of the same item to the same recipient is refused,
 *     naming the prior message;
 *   - an item state change opens the door again;
 *   - a different recipient, another sender's report, and an unstamped prior
 *     whose item changed afterwards are not repeats;
 *   - an unstamped prior (sent before the rail) still refuses when the item has
 *     not moved since (timestamp fallback).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage } from './messages';
import { coordWorkspaceId } from './log';
import { evaluateRepeatReport } from './repeat-report-reads';
import { CITED_ITEM_STATES_FIELD } from './repeat-report';

let fx: BaselineCoordFixture;
const ITEM = 'WI-99000101';
const OTHER_ITEM = 'WI-99000102';

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: coordWorkspaceId(), userId: null } as AgentIdentity;
}

const MEMBER = ident('rr-member');
const PEER = ident('rr-peer');
const LEADER = 'rr-leader';

async function seedItem(id: string, status = 'open'): Promise<void> {
  await fx.admin`
    INSERT INTO harness_shared.work_items (feature_id, workspace_id, harness_slug, status, taken_by, payload)
    VALUES (${id}, ${coordWorkspaceId()}, 'rr-h', ${status}, ${MEMBER.ownerId}, ${fx.admin.json({})})`;
}

async function clean(): Promise<void> {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE feature_id IN (${ITEM}, ${OTHER_ITEM})`;
}

function evaluate(from: AgentIdentity, to: string[], refs: string[]) {
  return evaluateRepeatReport({ from: from.ownerId, to, refs, workspaceId: coordWorkspaceId(), judge: true });
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await clean().catch(() => {});
  await fx.dispose();
});
beforeEach(clean);

describe('repeat_report_no_delta reads (WI-6554700010029331)', () => {
  it('stamps the first report, refuses the identical no-delta re-send, and reopens on a state change', async () => {
    await seedItem(ITEM);
    const first = await evaluate(MEMBER, [LEADER], [ITEM]);
    expect(first.kind).toBe('pass');
    expect(first.stamps.map((stamp) => stamp.ref)).toEqual([ITEM]);
    const sent = await sendMessage(MEMBER, {
      to: [LEADER],
      summary: `Still blocked on ${ITEM}: admission pending`,
      extra: { [CITED_ITEM_STATES_FIELD]: first.stamps },
    });

    const second = await evaluate(MEMBER, [LEADER], [ITEM]);
    expect(second.kind).toBe('refuse');
    if (second.kind !== 'refuse') return;
    expect(second.repeats).toEqual([
      expect.objectContaining({ ref: ITEM, priorMsgId: sent.msg_id, status: 'open', holder: MEMBER.ownerId }),
    ]);

    await fx.admin`UPDATE harness_shared.work_items SET status = 'wip', state_changed_at = now()
                    WHERE feature_id = ${ITEM}`;
    expect((await evaluate(MEMBER, [LEADER], [ITEM])).kind).toBe('pass');
  });

  it('is scoped to the same recipients and the same sender', async () => {
    await seedItem(ITEM);
    const stamps = (await evaluate(MEMBER, [LEADER], [ITEM])).stamps;
    await sendMessage(MEMBER, { to: [LEADER], summary: `Blocked on ${ITEM}`, extra: { [CITED_ITEM_STATES_FIELD]: stamps } });

    expect((await evaluate(MEMBER, ['rr-someone-else'], [ITEM])).kind).toBe('pass');
    expect((await evaluate(PEER, [LEADER], [ITEM])).kind).toBe('pass');
  });

  it('a new item alongside a repeated one passes the whole message', async () => {
    await seedItem(ITEM);
    await seedItem(OTHER_ITEM);
    const stamps = (await evaluate(MEMBER, [LEADER], [ITEM])).stamps;
    await sendMessage(MEMBER, { to: [LEADER], summary: `Blocked on ${ITEM}`, extra: { [CITED_ITEM_STATES_FIELD]: stamps } });

    expect((await evaluate(MEMBER, [LEADER], [ITEM, OTHER_ITEM])).kind).toBe('pass');
  });

  it('an UNSTAMPED prior (sent before the rail) refuses only while the item has not moved since it', async () => {
    await seedItem(ITEM);
    await sendMessage(MEMBER, { to: [LEADER], summary: `Blocked on ${ITEM}`, body: 'no stamp on this one' });

    expect((await evaluate(MEMBER, [LEADER], [ITEM])).kind).toBe('refuse');

    await fx.admin`UPDATE harness_shared.work_items SET taken_by = ${PEER.ownerId}, taken_at = now()
                    WHERE feature_id = ${ITEM}`;
    expect((await evaluate(MEMBER, [LEADER], [ITEM])).kind).toBe('pass');
  });
});
