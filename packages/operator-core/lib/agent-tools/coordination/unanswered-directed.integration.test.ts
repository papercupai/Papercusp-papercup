/**
 * unanswered-directed.integration.test.ts — `fetchUnansweredDirected` against
 * REAL Postgres (baseline-schema DB), covering EI-13819.
 *
 * EI-13819: a leader sent a lane offer with expectsReply:true; the member did
 * the work, then replied with a FRESH "DONE, standing down" message (no
 * `related_msg_id`) followed by a separate `related_msg_id`-carrying ack of
 * the leader's own later closing message — a completely normal exchange, but
 * NEITHER reply pointed at the ORIGINAL lane-offer msg_id, so the strict
 * exact-thread check (`related_msg_id = the ask's msg_id`) left it
 * "unanswered" forever. The pure fold (unanswered-directed.test.ts) never
 * exercised the SQL's "answered" NOT EXISTS clause at all — this drives the
 * real query through `sendMessage` so the stored envelope shape matches
 * production exactly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage } from './messages';
import { fetchUnansweredDirected, fetchOpenAsks } from './unanswered-directed';
import { fetchDirectiveActuations } from './directive-effect';
import { fetchDirectiveActuationSummaries } from './directive-effect-read';
import { coordWorkspaceId } from './log';

let fx: BaselineCoordFixture;
let effectWorkspace: string;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const LEADER = ident('unans-leader');
const MEMBER = ident('unans-member');
const OTHER = ident('unans-other');
const EFFECT_ITEM = 'EI-unanswered-expect-effect-checkpoint';
const EFFECT_SCOPE = `workitem:papercusp:${EFFECT_ITEM}`;
let EXPLICIT_SCOPE_WORKSPACE = 'default';
const EXPLICIT_SCOPE_ITEM = 'EI-unanswered-explicit-scope-effect';
const EXPLICIT_SCOPE_ITEM_NOTE = `workitem:papercusp:${EXPLICIT_SCOPE_ITEM}`;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  // The coord log is per-workspace in the production path. Resolve the same
  // concrete partition used by fetchDirectiveActuationSummaries rather than
  // assuming the legacy `default` partition used by older fixtures.
  effectWorkspace = coordWorkspaceId();
  EXPLICIT_SCOPE_WORKSPACE = effectWorkspace === 'default' ? 'papercusp-workspace' : 'default';
});
afterAll(async () => {
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${effectWorkspace} AND scope = ${EFFECT_SCOPE}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${effectWorkspace} AND harness_slug = 'papercusp' AND feature_id = ${EFFECT_ITEM}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${EXPLICIT_SCOPE_WORKSPACE} AND scope = ${EXPLICIT_SCOPE_ITEM_NOTE}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${EXPLICIT_SCOPE_WORKSPACE} AND harness_slug = 'papercusp' AND feature_id = ${EXPLICIT_SCOPE_ITEM}`.catch(() => {});
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${effectWorkspace} AND scope = ${EFFECT_SCOPE}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${effectWorkspace} AND harness_slug = 'papercusp' AND feature_id = ${EFFECT_ITEM}`;
  await fx.admin`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${EXPLICIT_SCOPE_WORKSPACE} AND scope = ${EXPLICIT_SCOPE_ITEM_NOTE}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${EXPLICIT_SCOPE_WORKSPACE} AND harness_slug = 'papercusp' AND feature_id = ${EXPLICIT_SCOPE_ITEM}`;
});

describe('fetchUnansweredDirected (EI-13819 SQL path)', () => {
  it('a directed expectsReply message with NO reply at all is unanswered', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('an EXACT threaded reply (related_msg_id = the ask) clears it (existing behavior)', async () => {
    const ask = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'done', related_msg_id: ask.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('EI-25484540030666284: a threaded reply from a system-namespaced session alias clears the bare recipient ask', async () => {
    const ask = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'please claim P-012',
      expectsReply: true,
    });
    const aliasMember = ident(`system:judge/${MEMBER.ownerId}`);
    await sendMessage(aliasMember, {
      to: [LEADER.ownerId],
      summary: 'done',
      related_msg_id: ask.msg_id,
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('EI-24800378908837374: a reply to one all-hive fan-out copy leaves no sibling broadcast unread', async () => {
    const firstCopy = await sendMessage(LEADER, {
      to: ['*'],
      summary: 'Avi: pause work',
      expectsReply: true,
      extra: { allHiveBroadcast: true },
    });
    await sendMessage(LEADER, {
      to: ['*'],
      summary: 'Avi: pause work',
      expectsReply: true,
      extra: { allHiveBroadcast: true },
    });
    const directAsk = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'please confirm the next lane',
      expectsReply: true,
    });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'acknowledged the broadcast',
      related_msg_id: firstCopy.msg_id,
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
    expect(map.get(MEMBER.ownerId)?.newest[0]?.msgId).toBe(directAsk.msg_id);
  });

  it('EI-22458045233456597: one exact reply clears an earlier same-goal ask cluster, but not a later ask', async () => {
    const goalRef = 'EI-22458045233456597#cluster';
    const firstAsk = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'cluster ask 1',
      expectsReply: true,
      extra: { why: { goalRef } },
    });
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'cluster ask 2',
      expectsReply: true,
      extra: { why: { goalRef } },
    });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'substantive reply covers the cluster',
      related_msg_id: firstAsk.msg_id,
      extra: { why: { goalRef } },
    });
    const laterAsk = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'later ask in the same goal',
      expectsReply: true,
      extra: { why: { goalRef } },
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
    expect(map.get(MEMBER.ownerId)?.newest[0]).toMatchObject({
      msgId: laterAsk.msg_id,
      from: LEADER.ownerId,
      summary: 'later ask in the same goal',
    });
  });

  it('EI-13819: a reply-shaped message threaded onto something ELSE in the same correspondence, sent after the ask, also clears it', async () => {
    const ask = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'New URGENT lane P-012: GREEN THE GATE — claim and drive',
      expectsReply: true,
    });
    // The leader later sends an unrelated follow-up (not itself a reply).
    const closing = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'CLOSED by leader, drop your awaits' });
    // The member never threads back onto `ask` directly — it sends a fresh
    // "DONE" status update (no related_msg_id) …
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'DONE: gate green, standing down', expectsReply: true });
    // … then acks the leader's closing message instead.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'Ack — closure confirmed', related_msg_id: closing.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
    void ask;
  });

  it('a reply-shaped message to a DIFFERENT sender does not clear an unrelated ask (scoping preserved)', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    // Member replies to OTHER, not to LEADER — must not clear LEADER's ask.
    const otherAsk = await sendMessage(OTHER, { to: [MEMBER.ownerId], summary: 'unrelated question' });
    await sendMessage(MEMBER, { to: [OTHER.ownerId], summary: 'unrelated reply', related_msg_id: otherAsk.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('WI-5345: a bare unthreaded status update back to the sender (no related_msg_id) DOES clear it', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    // A fresh, un-threaded message back to the sender is not "reply-shaped"
    // in the EI-13819 sense (no related_msg_id at all) but IS still a real,
    // directed reply from the recipient to the original asker — the common
    // case this fleet's agents actually produce, per WI-5345.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'still working on other things' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('WI-5345: several standalone genuine-status replies (no related_msg_id) after multiple separate asks all clear the count', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 1', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: still on P-012, tests green so far' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 2', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: P-012 done, moving to P-013' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 3', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: P-013 claimed, investigating repro' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('a reply-shaped message sent BEFORE the ask does not clear it (chronology enforced)', async () => {
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'earlier unrelated reply', related_msg_id: 'some-earlier-thread' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  // ---- WI-6729: the loose branch must not silently EAT a real obligation ----

  it('WI-6729: a reply threaded to a DIFFERENT message does NOT clear an open ask (the live false-zero)', async () => {
    // The exact production sequence. The member asks a design-fork question it
    // is blocked on; the leader replies ~6min later about an unrelated
    // work-item, threaded onto a different message. Before WI-6729 that reply
    // cleared the fork question and every surface reported 0 owed.
    const otherTopic = await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'FYI: WI-6699 lane widening' });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'D3 design fork on WI-6680 — which option? I am blocked.',
      expectsReply: true,
    });
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 're WI-6699: widened, go ahead',
      related_msg_id: otherTopic.msg_id,
    });

    const map = await fetchUnansweredDirected([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
  });

  it('WI-6729: one un-threaded reply clears only ONE ask — the older ones stay open', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 1', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 2', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 3', expectsReply: true });
    // A single standalone reply cannot retire three distinct questions.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'on question 3: yes' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(2);
  });

  it('WI-6729: continued correspondence still converges — N replies clear N asks (no EI-13819 stuck-at-1)', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 1', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 2', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'answer to 2' });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'and circling back on 1' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('WI-6729: an exact threaded reply still clears its own ask even when older asks stay open', async () => {
    const q1 = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 1', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'question 2', expectsReply: true });
    // Threaded squarely onto q1 — q1 clears, q2 remains owed.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'answering q1', related_msg_id: q1.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
    expect(map.get(MEMBER.ownerId)?.newest[0]?.summary).toBe('question 2');
  });

  // ---- EI-19315474516256070: SYSTEM/machine noise must not read as unanswered ----

  it('EI-19315474516256070: an explicit expects:"none" overrides a stale/inconsistent expectsReply:true (the live divergence)', async () => {
    // The confirmed live shape (work_items/request_release.ts): a raw sendMessage() caller
    // passes expectsReply:true directly, while `expects` independently reads 'none' — e.g.
    // the write-time machine-emitter stamp in messages.ts overwrote it because the same call
    // also set `auto:true`. `expects`, being the more specific/authoritative D-048 field, must
    // win: the sender said no reply is wanted, so this must NOT count as owed.
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'release request (auto-stamped expects:none, but legacy expectsReply:true)',
      expectsReply: true,
      extra: { expects: 'none' },
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('EI-19315474516256070: a machine-pattern sender is excluded even when it sets expectsReply:true', async () => {
    const WATCHDOG = ident('system-watchdog');
    await sendMessage(WATCHDOG, {
      to: [MEMBER.ownerId],
      summary: 'severe event broadcast',
      expectsReply: true,
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('WI-7147: release_request remains visible despite machine lifecycle stamps', async () => {
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'release request with a real reclaim deadline',
      expectsReply: true,
      extra: { auto: true, lifecycle: 'release_request' },
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('EI-19315474516256070: auto:true lifecycle chatter is excluded even when it sets expectsReply:true', async () => {
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'lifecycle chatter with a stray expectsReply',
      expectsReply: true,
      extra: { auto: true },
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('a genuine expects:"answer" (or unset expects) directed message still counts (no over-exclusion)', async () => {
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'please claim P-012',
      expectsReply: true,
      extra: { expects: 'answer' },
    });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('WI-4537(c) baseline: an unthreaded ack-shaped reply to the recipient\'s own message ping-pongs and clears (no expects override)', async () => {
    // Recipient (A=LEADER here, i.e. the one calling fetchUnansweredDirected) sent something
    // first; MEMBER replies to it with a plain ack (no explicit expects, so it defaults through
    // the same path as expects:'ack'). This is the ORIGINAL WI-4537(c) shape and must still
    // ping-pong-clear — the EI-22192594388203470 fix only carves out explicit action/answer.
    const leaderMsg = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'FYI: gate went green' });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'Ack — confirmed',
      expectsReply: true,
      related_msg_id: leaderMsg.msg_id,
    });

    const map = await fetchUnansweredDirected([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)).toBeUndefined();
  });

  it('EI-22192594388203470: a reply carrying expects:"action" is NOT swallowed as ack-ping-pong — it is a fresh decision request', async () => {
    // Repro from the filed bug: A (fleet leader) sends B a directive. B refuses it and asks for
    // a different mechanism, replying with expects:'action' threaded onto A's message. Before
    // the fix, WI-4537(c)'s structural "this is a reply to something A sent" test alone excluded
    // it, so fetchUnansweredDirected([A]) reported a confident 0 while B sat genuinely blocked on
    // a decision only A could make.
    const directive = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'widen the claim spec now' });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'refused — mechanically unexecutable; widen the lane and I take it next get_next',
      expectsReply: true,
      related_msg_id: directive.msg_id,
      extra: { expects: 'action' },
    });

    const map = await fetchUnansweredDirected([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
  });

  it('EI-22192594388203470: a reply carrying expects:"answer" is likewise NOT swallowed as ack-ping-pong', async () => {
    const question = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'closing this out — objections?' });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'wait — which of the two candidates did you mean?',
      expectsReply: true,
      related_msg_id: question.msg_id,
      extra: { expects: 'answer' },
    });

    const map = await fetchUnansweredDirected([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
  });

  it('EI-21547691921890849: a satisfied expectEffect checkpoint clears the same directed action from unanswered_directed', async () => {
    await fx.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
      VALUES
        (${effectWorkspace}, 'papercusp', ${EFFECT_ITEM}, 'bug', ${`checkpoint fixture ${EFFECT_ITEM}`}, 'open', 0, 0)
    `;

    const directive = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: `checkpoint ${EFFECT_ITEM} before compact`,
      expectsReply: true,
      extra: {
        expects: 'action',
        expectEffect: { kind: 'checkpoint', itemId: EFFECT_ITEM, harness: 'papercusp' },
      },
    });
    const sentAtMs = Date.parse(directive.ts);
    expect(Number.isFinite(sentAtMs)).toBe(true);

    await fx.admin`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
      VALUES (${effectWorkspace}, ${EFFECT_SCOPE}, 'checkpoint written after directive', ${sentAtMs + 1})
    `;

    const actuation = await fetchDirectiveActuationSummaries([MEMBER.ownerId], {
      fromId: LEADER.ownerId,
    });
    expect(actuation.get(MEMBER.ownerId)).toMatchObject({ total: 1, satisfied: 1, notYet: 0 });

    const unanswered = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(unanswered.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('honors an explicit workspace for unanswered counts and expectEffect actuation', async () => {
    await fx.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
      VALUES
        (${EXPLICIT_SCOPE_WORKSPACE}, 'papercusp', ${EXPLICIT_SCOPE_ITEM}, 'bug', ${`explicit scope ${EXPLICIT_SCOPE_ITEM}`}, 'open', 0, 0)
    `;
    const sentAtMs = Date.now() - 60_000;
    await fx.admin`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
      VALUES (${EXPLICIT_SCOPE_WORKSPACE}, ${EXPLICIT_SCOPE_ITEM_NOTE}, 'checkpoint after explicit-scope ask', ${sentAtMs + 1})
    `;

    const bodies = [
      {
        msg_id: 'unans-explicit-scope-open',
        ts: new Date(sentAtMs).toISOString(),
        from: LEADER.ownerId,
        to: [MEMBER.ownerId],
        kind: 'message',
        expectsReply: true,
        expects: 'action',
        summary: 'open explicit-scope ask',
      },
      {
        msg_id: 'unans-explicit-scope-effect',
        ts: new Date(sentAtMs).toISOString(),
        from: LEADER.ownerId,
        to: [MEMBER.ownerId],
        kind: 'message',
        expectsReply: true,
        expects: 'action',
        summary: 'completed explicit-scope checkpoint ask',
        expectEffect: { kind: 'checkpoint', itemId: EXPLICIT_SCOPE_ITEM, harness: 'papercusp' },
      },
    ];
    const seededMessages: Array<{ workspace_id: string; msg_id: string }> = [];
    for (const body of bodies) {
      const insertedRows = await fx.admin<{
        workspace_id: string;
        msg_id: string;
        body_type: string;
        body_from: string | null;
        has_expect_effect: boolean;
      }[]>`
        INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts, workspace_id, origin)
        VALUES ('messages', ${body.msg_id}, ${fx.admin.json(body)}, ${new Date(sentAtMs)}, ${EXPLICIT_SCOPE_WORKSPACE}, 'local')
        RETURNING workspace_id, msg_id,
                  jsonb_typeof(body) AS body_type,
                  body->>'from' AS body_from,
                  body ? 'expectEffect' AS has_expect_effect
      `;
      expect(insertedRows).toEqual([expect.objectContaining({
        workspace_id: EXPLICIT_SCOPE_WORKSPACE,
        msg_id: body.msg_id,
        body_type: 'object',
        body_from: LEADER.ownerId,
        has_expect_effect: Object.hasOwn(body, 'expectEffect'),
      })]);
      seededMessages.push(...insertedRows.map(({ workspace_id, msg_id }) => ({ workspace_id, msg_id })));
    }
    expect(seededMessages.map((row) => row.msg_id).sort()).toEqual(bodies.map((body) => body.msg_id).sort());
    const inserted = await fx.admin`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE body ? 'expectEffect')::int AS effect_count
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${EXPLICIT_SCOPE_WORKSPACE}
         AND surface = 'messages'
         AND body->>'from' = ${LEADER.ownerId}
         AND msg_id = ANY(${bodies.map((body) => body.msg_id)}::text[])
    `;
    expect(inserted[0]).toMatchObject({ total: 2, effect_count: 1 });

    const actuation = await fetchDirectiveActuationSummaries([MEMBER.ownerId], {
      fromId: LEADER.ownerId,
      workspaceId: EXPLICIT_SCOPE_WORKSPACE,
    });
    expect(actuation.get(MEMBER.ownerId)).toMatchObject({ total: 1, satisfied: 1, notYet: 0 });

    const unanswered = await fetchUnansweredDirected([MEMBER.ownerId], {
      workspaceId: EXPLICIT_SCOPE_WORKSPACE,
    });
    expect(unanswered.get(MEMBER.ownerId)?.count).toBe(1);

    const activeScope = await fetchUnansweredDirected([MEMBER.ownerId], {
      workspaceId: effectWorkspace,
    });
    expect(activeScope.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('EI-21665996495417179: committed terminal completion is a checkpoint-safety alternative', async () => {
    const closedAt = Date.now();
    const payload = JSON.stringify({
      _completionEvidence: {
        verifiedHow: 'integration',
        testsRun: 'npm run test:file -- directive-effect.test.ts',
        testResult: 'PASS',
      },
    });
    await fx.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, payload,
         terminal_owner, authority, created_ts, updated_ts, closed_ts)
      VALUES
        (${effectWorkspace}, 'papercusp', ${EFFECT_ITEM}, 'bug', ${`terminal fixture ${EFFECT_ITEM}`}, 'done',
         ${payload}::text::jsonb, ${MEMBER.ownerId}, 'committed', ${closedAt - 1}, ${closedAt}, ${closedAt})
    `;

    const actuations = await fetchDirectiveActuations(
      [{ kind: 'checkpoint', itemId: EFFECT_ITEM, harness: 'papercusp', sentAtMs: closedAt + 1 }],
      { workspaceId: effectWorkspace },
    );
    expect(actuations).toEqual([
      expect.objectContaining({
        verdict: 'pre-existing',
        alternativeProof: 'terminal-completion',
        observedAtMs: closedAt,
      }),
    ]);
  });

  it('keeps an expectEffect directive unanswered until its named effect is proven', async () => {
    await fx.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
      VALUES
        (${effectWorkspace}, 'papercusp', ${EFFECT_ITEM}, 'bug', ${`checkpoint fixture ${EFFECT_ITEM}`}, 'open', 0, 0)
    `;

    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: `checkpoint ${EFFECT_ITEM} before compact`,
      expectsReply: true,
      extra: {
        expects: 'action',
        expectEffect: { kind: 'checkpoint', itemId: EFFECT_ITEM, harness: 'papercusp' },
      },
    });

    const unanswered = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(unanswered.get(MEMBER.ownerId)?.count).toBe(1);
  });

  // ── EI-20085805220385722: the live/stale split ────────────────────────────
  // The pure fold (unanswered-directed.test.ts) proves the PARTITION; only these
  // prove the `per_sender` / `sender_rollup` CTEs actually populate it. Without
  // them the SQL columns are attested only by "the rest of the suite did not
  // break", which a rollup returning empty arrays would also satisfy.
  it('EI-20085805220385722: the SQL per-sender rollup comes back populated (busiest first), and nothing is demoted by default', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'claim P-012', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'and P-013', expectsReply: true });
    await sendMessage(OTHER, { to: [MEMBER.ownerId], summary: 'review my diff', expectsReply: true });

    const summary = (await fetchUnansweredDirected([MEMBER.ownerId])).get(MEMBER.ownerId);

    expect(summary?.count).toBe(3);
    expect(summary?.senders.map((s) => [s.from, s.count])).toEqual([
      [LEADER.ownerId, 2],
      [OTHER.ownerId, 1],
    ]);
    for (const s of summary?.senders ?? []) expect(s.oldestAgeMs).toBeGreaterThanOrEqual(0);
    expect(summary?.sendersTruncated).toBeUndefined();
    // Default seam = endedRecordedOwnerIds. Neither fixture sender has a recorded
    // ENDED session, so both are ABSENT from the set — the fail-open direction.
    expect(summary?.staleCount).toBe(0);
    expect(summary?.staleCountBounded).toBeUndefined();
  });

  it('EI-20085805220385722: a positively-ended sender moves to staleCount while an unknown sender still counts', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'claim P-012', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'and P-013', expectsReply: true });
    await sendMessage(OTHER, { to: [MEMBER.ownerId], summary: 'review my diff', expectsReply: true });

    const summary = (
      await fetchUnansweredDirected([MEMBER.ownerId], {
        endedSendersFn: async (ids) => new Set(ids.filter((id) => id === LEADER.ownerId)),
      })
    ).get(MEMBER.ownerId);

    // OTHER is not PROVEN dead, so its ask still outranks the recipient's own work.
    expect(summary?.count).toBe(1);
    expect(summary?.staleCount).toBe(2);
    expect(summary?.staleOldestAgeMs).toBeGreaterThanOrEqual(0);
    expect(summary?.newest.find((e) => e.from === LEADER.ownerId)?.senderState).toBe('ended');
    expect(summary?.newest.find((e) => e.from === OTHER.ownerId)?.senderState).toBe('unknown');
  });

  it('EI-20085805220385722: a THROWING death-evidence read demotes nothing (fail open through the real path)', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'claim P-012', expectsReply: true });

    const summary = (
      await fetchUnansweredDirected([MEMBER.ownerId], {
        endedSendersFn: async () => {
          throw new Error('adv_sessions unreachable');
        },
      })
    ).get(MEMBER.ownerId);

    expect(summary?.count).toBe(1);
    expect(summary?.staleCount).toBe(0);
  });
});

describe('fetchOpenAsks (sender-side mirror; WI-4537(c) mirrored exclusion, EI-22192594388203470)', () => {
  it('a directed expectsReply message with no reply at all is a still-open ask', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });

    const map = await fetchOpenAsks([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
  });

  it('EI-22458045233456597 mirrored: one exact reply clears an earlier same-goal ask cluster, but not a later ask', async () => {
    const goalRef = 'EI-22458045233456597#cluster-mirror';
    const firstAsk = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'cluster ask 1',
      expectsReply: true,
      extra: { why: { goalRef } },
    });
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'cluster ask 2',
      expectsReply: true,
      extra: { why: { goalRef } },
    });
    await sendMessage(MEMBER, {
      to: [LEADER.ownerId],
      summary: 'substantive reply covers the cluster',
      related_msg_id: firstAsk.msg_id,
      extra: { why: { goalRef } },
    });
    const laterAsk = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'later ask in the same goal',
      expectsReply: true,
      extra: { why: { goalRef } },
    });

    const map = await fetchOpenAsks([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
    expect(map.get(LEADER.ownerId)?.newest[0]).toMatchObject({
      msgId: laterAsk.msg_id,
      to: MEMBER.ownerId,
      summary: 'later ask in the same goal',
    });
  });

  it('EI-22401733710869471: SQL rolls up recipients and partitions ended recipients in one batch', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'member ask 1', expectsReply: true });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'member ask 2', expectsReply: true });
    await sendMessage(LEADER, { to: [OTHER.ownerId], summary: 'other ask', expectsReply: true });

    const calls: string[][] = [];
    const map = await fetchOpenAsks([LEADER.ownerId], {
      recipientStatesFn: async (ids) => {
        calls.push(ids);
        return new Map([[MEMBER.ownerId, 'ended' as const]]);
      },
    });
    const summary = map.get(LEADER.ownerId);

    expect(calls).toEqual([[MEMBER.ownerId, OTHER.ownerId]]);
    expect(summary?.recipients.map((r) => [r.to, r.count])).toEqual([
      [MEMBER.ownerId, 2],
      [OTHER.ownerId, 1],
    ]);
    expect(summary?.count).toBe(1); // OTHER is unknown, so it remains owed
    expect(summary?.staleCount).toBe(2);
    expect(summary?.newest.find((e) => e.to === MEMBER.ownerId)?.recipientState).toBe('ended');
    expect(summary?.newest.find((e) => e.to === OTHER.ownerId)?.recipientState).toBe('unknown');
  });

  it('EI-22401733710869471: a throwing recipient-liveness read fails open through the SQL path', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'still waiting', expectsReply: true });

    const map = await fetchOpenAsks([LEADER.ownerId], {
      recipientStatesFn: async () => {
        throw new Error('presence unavailable');
      },
    });

    expect(map.get(LEADER.ownerId)).toMatchObject({ count: 1, staleCount: 0 });
  });

  it('baseline: our own plain ack-shaped reply to something the recipient sent does NOT count as a fresh ask on them (mirrored ping-pong)', async () => {
    // MEMBER sent LEADER something first; LEADER's threaded reply back is LEADER's answer
    // arriving, not a fresh ask LEADER is making of MEMBER — must not appear in fetchOpenAsks([LEADER]).
    const memberMsg = await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'FYI: done with P-009' });
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'Ack — confirmed',
      expectsReply: true,
      related_msg_id: memberMsg.msg_id,
    });

    const map = await fetchOpenAsks([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)).toBeUndefined();
  });

  it('EI-22192594388203470 mirrored: OUR OWN reply carrying expects:"action" still counts as a fresh ask, even though it is threaded onto something the recipient sent', async () => {
    const memberMsg = await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'proposal: widen the spec' });
    await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'no — do X instead, confirm you will',
      expectsReply: true,
      related_msg_id: memberMsg.msg_id,
      extra: { expects: 'action' },
    });

    const map = await fetchOpenAsks([LEADER.ownerId]);
    expect(map.get(LEADER.ownerId)?.count).toBe(1);
  });
});
