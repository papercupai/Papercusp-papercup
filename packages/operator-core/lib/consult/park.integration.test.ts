/**
 * park.integration.test.ts — consult-backed parking end to end against a real,
 * fully migrated Postgres (consult-backed-parking-2026-10-12 P-009, bar R-9).
 *
 * The pure resolver (park-resolver.test.ts) and the row mapping
 * (park-adapters.test.ts) are unit-tested. What only a real database can prove:
 *  - the park identity stored on consult_state.routing.cascade (D-013), the
 *    reviewer stance on consult_post_meta.stance (migration 1482) and the park
 *    progress on consult_state.park_state (migration 1483) round-trip through
 *    loadParkState → runParkTriggers → appendParkOutcome;
 *  - the PRODUCTION effect seams (makeProdParkSeams) clear the work item's real
 *    product-decision blocker (the exact record set_blocker writes) and fire the
 *    real awaited-event engine, so the parked agent's verdict await is consumed
 *    (the agent is woken) with the verdict payload;
 *  - the deadline sweep (sweepDueParks) selects due parks by the stored deadline,
 *    leaves parks that are not yet due alone, and never re-settles a settled park.
 *
 * Only the wake TRANSPORT is stubbed (sendMessage / admitSpawn): the await row,
 * its fire and its payload are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-park-it',
  sendMessage: vi.fn(async () => ({ msg_id: 'm-park-it' })),
  admitSpawn: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    setAdminPoolStatementTimeoutProvider: () => {},
  };
});
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));
vi.mock('../agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/messages')>()),
  sendMessage: h.sendMessage,
}));
vi.mock('../fleet/governor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fleet/governor')>()),
  admitSpawn: h.admitSpawn,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const awaitStore = await import('../events/await/store');
const { readExternalBlockers, updateExternalBlockerHistory } = await import('../external-blockers');
const { parkVerdictEventKey } = await import('./park-resolver');
const { appendParkerResponse, loadParkState, parkBlockerRef, pollParkOwnerAnswers, recordParkOwnerAnswer, runParkTriggersForConsult, sweepDueParks } = await import('./park-adapters');
const { openDecisionReviewPark } = await import('./park-door');
const { makeProdParkSeams } = await import('./park-prod');

const WS = h.ws;
const QUESTION = 'Rename the export flag before the cutover?';
const DEFAULT_ACTION = 'Keep the current flag name and ship as-is';
const ALTERNATIVE = 'Rename the flag now and alias the old name for one release';

let db: OrgTestDb;
let sql: Sql;
let seq = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql as unknown as Sql;
  h.sql = sql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

interface SeededPark {
  consultId: string;
  workItemId: string;
  setterId: string;
  blockerRef: string;
  eventKey: string;
  deadlineAt: string;
}

/** A park exactly as set_blocker's park door leaves it: consult + blocker + verdict await. */
async function seedPark(deadlineAt: string, ownerAuthorityTopic: string | null = null): Promise<SeededPark> {
  seq += 1;
  const consultId = `conv-park-it-${seq}-${Date.now()}`;
  const workItemId = `WI-PARK-IT-${seq}-${Date.now()}`;
  const setterId = `su-parker-${seq}`;
  const blockerRef = parkBlockerRef(consultId);
  const routing = {
    selection: {
      // Two reviewers: after the first objects, the cascade is NOT exhausted, so the
      // parker gets to adopt/rebut (R-16) instead of an owner question (R-17).
      selected: [
        { ownerId: `su-reviewer-${seq}`, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' },
        { ownerId: `su-reviewer2-${seq}`, via: 'floor', score: 0.8, similarity: 0.7, liveness: 'live' },
      ],
    },
  };
  // Exercise the same validated door set_blocker calls, preserving its actual
  // cascade metadata through SQL rather than constructing ownerAuthority by hand.
  const opened = await openDecisionReviewPark({
    workItemId, setterId, question: QUESTION, defaultIfUnanswered: DEFAULT_ACTION,
    decideBy: deadlineAt, ownerAuthorityTopic,
  }, {
    now: () => Date.now(),
    openConsult: async ({ question, cascade }) => {
      await sql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, responder_id, state, question,
           latency_contract, expires_at, routing, cascade_cursor)
        VALUES (${WS}, ${consultId}, ${setterId}, ${`su-reviewer-${seq}`}, 'awaiting_responder', ${question},
                'proceed', NULL, ${sql.json({ ...routing, cascade } as never)}, 0)`;
      return { consultId };
    },
    registerVerdictWake: async ({ subscriberId, eventKey, timeoutSec, note }) => {
      await awaitStore.registerAwait({ subscriberId, eventKey, timeoutSec, note });
    },
    notifyOwner: async () => {},
  });
  expect(opened).toMatchObject({ ok: true, park: { consultId, ownerAuthorityTopic, wakeRegistered: true } });
  const { blockers } = updateExternalBlockerHistory(
    {},
    {
      kind: 'human',
      capability: 'product-decision',
      ref: blockerRef,
      summary: QUESTION,
      defaultIfUnanswered: DEFAULT_ACTION,
      decideBy: deadlineAt,
    },
    setterId,
  );
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload, nature)
    VALUES (${WS}, 'papercusp', ${workItemId}, 'feature', ${QUESTION}, 'open', ${Date.now()},
            ${sql.json({ externalBlockers: blockers } as never)}, 'work')`;
  const eventKey = parkVerdictEventKey(consultId);
  return { consultId, workItemId, setterId, blockerRef, eventKey, deadlineAt };
}

function registerVerdictAwait(subscriberId: string, eventKey: string) {
  return awaitStore.registerAwait({ subscriberId, eventKey, note: 'park verdict', timeoutSec: 7200 });
}

async function postStance(park: SeededPark, author: string, stance: Record<string, unknown>): Promise<string> {
  const postId = 900_000 + seq * 10 + Math.floor(Math.random() * 9);
  await sql`
    INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind, stance)
    VALUES (${WS}, ${postId}, ${park.consultId}, ${author}, 'answer', ${sql.json(stance as never)})`;
  return String(postId);
}

async function blockerStatus(park: SeededPark): Promise<{ status: string; record: unknown } | null> {
  const rows = await sql<Array<{ payload: unknown }>>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${park.workItemId}`;
  const b = readExternalBlockers(rows[0]?.payload).find((x) => x.ref === park.blockerRef);
  return b ? { status: b.status, record: b } : null;
}

/** The parked agent's verdict awaits, newest first: fired (= woken) or still pending. */
async function verdictAwaits(park: SeededPark) {
  return sql<Array<{ fired_at: Date | null; fired_payload: Record<string, unknown> | null }>>`
    SELECT fired_at, fired_payload FROM harness_shared.event_awaits
     WHERE subscriber_id = ${park.setterId} AND event_key = ${park.eventKey}
     ORDER BY created_at DESC, id DESC`;
}

const seams = (ws: string) => makeProdParkSeams(sql, ws);

describe('consult-backed parking against real Postgres (R-9)', () => {
  it.each(['settled', 'durable-park', 'event-remains', 'credential-remains'] as const)(
    'settles issue-family human classification atomically: %s', async (scenario) => {
      const deadline = Date.now() + 3_600_000;
      const park = await seedPark(new Date(deadline).toISOString());
      const [before] = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND feature_id = ${park.workItemId}`;
      let payload: Record<string, unknown> = { ...before.payload, needsOwnerAction: true, needsHuman: true };
      if (scenario === 'event-remains' || scenario === 'credential-remains') {
        const human = scenario === 'credential-remains';
        const { blockers } = updateExternalBlockerHistory(payload, {
          kind: human ? 'human' : 'event', ref: `remaining:${park.workItemId}`,
          ...(human ? { capability: 'credential' as const, defaultIfUnanswered: 'Keep blocked' } : {}),
          summary: human ? 'A credential is still required' : 'Await the real dependency',
        }, park.setterId);
        payload = { ...payload, externalBlockers: blockers };
      }
      const stored = scenario === 'durable-park'
        ? { ...payload, claim_hold_by: park.setterId, claim_hold_reason: 'Keep historical timeout blocked',
            claim_hold_at: new Date().toISOString(), _claimHold: true }
        : payload;
      await sql`UPDATE harness_shared.work_items
        SET item_kind = 'bug', status = 'needs-human', payload = ${sql.json(stored as never)}
        WHERE workspace_id = ${WS} AND feature_id = ${park.workItemId}`;

      const result = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS),
        new Date(deadline + 1_000).toISOString());
      expect(result?.applied).toContain('clear-blocker');
      const [after] = await sql<Array<{ status: string; payload: Record<string, unknown> }>>`
        SELECT status, payload FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND feature_id = ${park.workItemId}`;
      expect((await blockerStatus(park))?.status).toBe('cleared');
      if (scenario === 'credential-remains') {
        expect(after.status).toBe('needs-human');
        expect(after.payload).toMatchObject({ needsOwnerAction: true, needsHuman: true });
      } else {
        expect(after.payload.needsOwnerAction).toBeUndefined();
        expect(after.payload.needsHuman).toBeUndefined();
        // A settled decision is not proof of a fix or authority to lift a park.
        expect(after.status).toBe('blocked');
      }
      if (scenario === 'durable-park') {
        expect(after.payload).toMatchObject({ claim_hold_by: park.setterId,
          claim_hold_reason: 'Keep historical timeout blocked', _claimHold: true });
      }
      const active = readExternalBlockers(after.payload).filter((blocker) => blocker.status === 'active');
      expect(active).toHaveLength(scenario.endsWith('-remains') ? 1 : 0);
    }, 60_000,
  );

  it('persisted owner-authority survives park creation and expiry: no clear, exactly one owner question with both options', async () => {
    const deadline = Date.now() + 3_600_000;
    const park = await seedPark(new Date(deadline).toISOString(), 'spend');
    expect(await loadParkState(sql, WS, park.consultId)).toMatchObject({ ownerAuthority: true, ownerAuthorityTopic: 'spend' });
    const prod = seams(WS);
    const askOwner = vi.fn(prod.askOwner);
    const seamsFor = () => ({ ...prod, askOwner });
    const now = new Date(deadline + 1_000).toISOString();
    const first = await sweepDueParks({ sql, seamsFor, now });
    expect(first.failures).toEqual([]);
    expect(first.resolved).toContainEqual(expect.objectContaining({ consultId: park.consultId, verdict: 'owner-deciding' }));
    expect(askOwner).toHaveBeenCalledTimes(1);
    expect(askOwner).toHaveBeenCalledWith(expect.objectContaining({ consultId: park.consultId, ownerAuthorityTopic: 'spend' }), {
      question: `${QUESTION} [owner-authority: spend]`, options: [DEFAULT_ACTION, 'Do not take the default action'],
    });
    expect((await blockerStatus(park))?.status).toBe('active');
    expect((await verdictAwaits(park))[0]?.fired_payload).toMatchObject({ verdict: 'owner-deciding', defaultAction: DEFAULT_ACTION, recordedAs: 'peer-review' });
    const [stored] = await sql<Array<{ park_state: { ownerConversationId: string; ownerQuestionOpened: boolean } }>>`
      SELECT park_state FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id = ${park.consultId}`;
    expect(stored.park_state.ownerQuestionOpened).toBe(true);
    expect(stored.park_state.ownerConversationId).toEqual(expect.any(String));
    const again = await sweepDueParks({ sql, seamsFor, now });
    expect(again.failures).toEqual([]);
    expect(again.resolved.map((r) => r.consultId)).not.toContain(park.consultId);
    expect(await runParkTriggersForConsult(sql, WS, park.consultId, seamsFor(), now)).toMatchObject({ verdict: null, applied: [] });
    expect(askOwner).toHaveBeenCalledTimes(1);
    expect((await blockerStatus(park))?.status).toBe('active');
  }, 60_000);

  it('persisted owner answer settles the park and a later peer reply cannot override it', async () => {
    const deadline = Date.now() + 3_600_000;
    const park = await seedPark(new Date(deadline).toISOString(), 'spend');
    const now = new Date(deadline + 1_000).toISOString();
    await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS), now);
    await registerVerdictAwait(park.setterId, park.eventKey);
    const readAnswer = vi.fn(async () => ({ answered: true, answer: 'Use the owner-approved flag' }));
    const answered = await pollParkOwnerAnswers({ sql, seamsFor: seams, readAnswer, now });
    expect(answered.failures).toEqual([]);
    expect(answered.resolved).toContainEqual(expect.objectContaining({ consultId: park.consultId, verdict: 'owner-decided' }));
    expect(readAnswer).toHaveBeenCalledWith({ workspaceId: WS, conversationId: expect.any(String), askerId: park.setterId });
    expect((await blockerStatus(park))?.status).toBe('cleared');
    const [ownerWake] = await verdictAwaits(park);
    expect(ownerWake.fired_at).not.toBeNull();
    expect(ownerWake.fired_payload).toMatchObject({ verdict: 'owner-decided', ownerText: 'Use the owner-approved flag', recordedAs: 'owner', consultId: park.consultId });
    expect(await recordParkOwnerAnswer(sql, WS, park.consultId, { at: now, text: 'Conflicting later answer' })).toBe(false);
    await registerVerdictAwait(park.setterId, park.eventKey);
    await postStance(park, `su-late-reviewer-${seq}`, { position: 'object', basis: 'alternative', reason: 'Prefer a rename', alternative: ALTERNATIVE });
    expect(await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS), now)).toMatchObject({ verdict: null, applied: [] });
    expect((await verdictAwaits(park))[0]?.fired_at).toBeNull();
    expect((await loadParkState(sql, WS, park.consultId))?.ownerAnswer?.text).toBe('Use the owner-approved flag');
    expect((await blockerStatus(park))?.status).toBe('cleared');
  }, 60_000);

  it('persisted rebuttal forwards both positions once without waking or clearing the parker', async () => {
    const park = await seedPark(new Date(Date.now() + 3_600_000).toISOString());
    const objectionId = await postStance(park, `su-reviewer-${seq}`, { position: 'object', basis: 'alternative', reason: 'Old flag collides', alternative: ALTERNATIVE });
    const prod = seams(WS);
    const advanceCascade = vi.fn(async () => {});
    const effects = { ...prod, advanceCascade };
    const t0 = Date.now();
    await runParkTriggersForConsult(sql, WS, park.consultId, effects, new Date(t0).toISOString());
    await registerVerdictAwait(park.setterId, park.eventKey);
    await appendParkerResponse(sql, WS, park.consultId, { kind: 'rebut', at: new Date(t0 + 1).toISOString(), text: 'The alias already avoids collision', objectionId });
    const result = await runParkTriggersForConsult(sql, WS, park.consultId, effects, new Date(t0 + 2).toISOString());
    expect(result?.applied).toEqual(['advance-cascade', 'record-outcome']);
    expect(advanceCascade).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ consultId: park.consultId }), {
      default: DEFAULT_ACTION, rebuttal: 'The alias already avoids collision', objection: 'Old flag collides', alternative: ALTERNATIVE,
    });
    expect((await verdictAwaits(park))[0]?.fired_at).toBeNull();
    expect((await blockerStatus(park))?.status).toBe('active');
    expect(await runParkTriggersForConsult(sql, WS, park.consultId, effects, new Date(t0 + 3).toISOString())).toMatchObject({ verdict: null, applied: [] });
    expect(advanceCascade).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('adopt-alternative: an objection with an alternative wakes the parker, adopting it settles the park as peer review', async () => {
    const park = await seedPark(new Date(Date.now() + 3_600_000).toISOString());
    const objectionId = await postStance(park, `su-reviewer-${seq}`, {
      position: 'object',
      basis: 'alternative',
      reason: 'Old name collides with the analytics export',
      alternative: ALTERNATIVE,
    });

    // 1. The objection wakes the parked agent to adopt or rebut; the park stays blocked.
    const first = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(first?.verdict).toBe('consider-alternative');
    expect(first?.applied).not.toContain('clear-blocker');
    const [woken] = await verdictAwaits(park);
    expect(woken?.fired_at).not.toBeNull();
    expect(woken?.fired_payload).toMatchObject({
      verdict: 'consider-alternative',
      alternative: ALTERNATIVE,
      workItemId: park.workItemId,
      recordedAs: 'peer-review',
    });
    expect((await blockerStatus(park))?.status).toBe('active');

    // 2. The parker re-awaits and adopts the alternative.
    await registerVerdictAwait(park.setterId, park.eventKey);
    await appendParkerResponse(sql, WS, park.consultId, {
      kind: 'adopt',
      at: new Date().toISOString(),
      text: 'Adopting the rename with an alias',
      objectionId,
    });
    const second = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(second?.verdict).toBe('adopted');
    expect(second?.applied).toContain('clear-blocker');

    const blocker = await blockerStatus(park);
    expect(blocker?.status).toBe('cleared');
    expect(JSON.stringify(blocker?.record)).toContain('peer-review');
    const [adoptWake] = await verdictAwaits(park);
    expect(adoptWake?.fired_at).not.toBeNull();
    expect(adoptWake?.fired_payload).toMatchObject({
      verdict: 'adopted',
      alternative: ALTERNATIVE,
      blockerRef: park.blockerRef,
      recordedAs: 'peer-review',
    });

    const [{ park_state }] = await sql<Array<{ park_state: { outcomes: Array<{ verdict: string }> } }>>`
      SELECT park_state FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id = ${park.consultId}`;
    expect(park_state.outcomes.map((o) => o.verdict)).toEqual(['consider-alternative', 'adopted']);

    // 3. A settled park is idempotent: a later trigger changes nothing.
    const third = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(third).toMatchObject({ verdict: null, applied: [] });
  }, 60_000);

  it('silent-proceed: with no objection the deadline sweep proceeds with the default, clears the blocker and wakes the parker', async () => {
    const deadline = Date.now() + 3_600_000;
    const park = await seedPark(new Date(deadline).toISOString());
    const notDue = await seedPark(new Date(deadline + 7_200_000).toISOString());

    // Before the deadline the sweep leaves the silent park alone.
    const early = await sweepDueParks({ sql, seamsFor: seams });
    expect(early.resolved.map((r) => r.consultId)).not.toContain(park.consultId);
    expect((await verdictAwaits(park))[0]?.fired_at).toBeNull();

    // At the deadline it proceeds with the default.
    const atDeadline = new Date(deadline + 1_000).toISOString();
    const swept = await sweepDueParks({ sql, seamsFor: seams, now: atDeadline });
    expect(swept.failures).toEqual([]);
    expect(swept.resolved).toContainEqual(expect.objectContaining({ consultId: park.consultId, verdict: 'proceed' }));
    expect(swept.resolved.map((r) => r.consultId)).not.toContain(notDue.consultId);

    const blocker = await blockerStatus(park);
    expect(blocker?.status).toBe('cleared');
    expect(JSON.stringify(blocker?.record)).toContain('peer-review');
    const [woken] = await verdictAwaits(park);
    expect(woken?.fired_at).not.toBeNull();
    expect(woken?.fired_payload).toMatchObject({
      verdict: 'proceed',
      defaultAction: DEFAULT_ACTION,
      workItemId: park.workItemId,
      recordedAs: 'peer-review',
    });

    // The not-yet-due park is untouched.
    expect((await blockerStatus(notDue))?.status).toBe('active');
    expect((await verdictAwaits(notDue))[0]?.fired_at).toBeNull();

    // A second sweep never re-settles the proceeded park.
    const again = await sweepDueParks({ sql, seamsFor: seams, now: atDeadline });
    expect(again.resolved.map((r) => r.consultId)).not.toContain(park.consultId);
  }, 60_000);
});
