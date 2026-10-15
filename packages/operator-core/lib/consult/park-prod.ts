/**
 * Production side-effect seams for consult-backed parking
 * (consult-backed-parking-2026-10-12 P-006, WI-6554700010009494).
 *
 * park-resolver.ts decides; park-adapters.ts binds the decision to the consult tables;
 * this module binds the four effects that live in OTHER subsystems:
 *  - emitVerdict    → the awaited-event engine (the parker awaits consult:park-verdict:<id>);
 *  - clearBlocker   → the work-item's product-decision blocker (ref consult:<id>), cleared
 *                     with clearExternalBlockersOnLockedRow inside one row-locked transaction;
 *  - advanceCascade → the review cascade's next reviewer, with a digest entry holding the
 *                     default, the objection, the alternative and the rebuttal (R-16);
 *  - askOwner       → one coord:ask-owner question naming both options (R-17); its
 *                     conversation id is stored so the answer can be read back (R-18).
 *
 * Every import is dynamic: this module is loaded from the consult expiry routine and the
 * consult verbs, and a static import of the coord-ops / work-items graph there would pull
 * those graphs into every importer of the resolver.
 */
import type { Sql } from 'postgres';
import { setParkOwnerConversation, type ParkEffectSeams } from './park-adapters';
import type { ParkState } from './park-resolver';

/** Attribution for park effects that no live session performs. */
export const PARK_SYSTEM_ACTOR = 'system:consult-park';

/** One digest line carrying both positions to the next reviewer (R-16). */
export function rebuttalDigestText(positions: {
  default: string;
  rebuttal: string;
  objection: string;
  alternative: string | null;
}): string {
  const alt = positions.alternative ? ` Alternative proposed: ${positions.alternative}.` : '';
  return (
    `Parked agent rebutted an objection. Default: ${positions.default}. ` +
    `Objection: ${positions.objection}.${alt} Rebuttal: ${positions.rebuttal}`
  );
}

/** The owner question body: the decision and exactly the two options (R-17). */
export function ownerQuestionBody(state: ParkState, question: string, options: [string, string]): string {
  return [
    question,
    '',
    `Work item: ${state.workItemId} (parked by ${state.parkerOwnerId}; peer review did not settle it).`,
    `Option 1 — the default: ${options[0]}`,
    `Option 2 — the objection: ${options[1]}`,
    '',
    'Answer with the option to take (or your own instruction). The first answer settles the park.',
  ].join('\n');
}

const CONSULT_OPEN_STATES = ['routing', 'awaiting_responder', 'active'];

export function makeProdParkSeams(sql: Sql, workspaceId: string): ParkEffectSeams {
  return {
    async emitVerdict(eventKey, payload) {
      const { emitAwaitedEvent } = await import('../events/await/engine');
      await emitAwaitedEvent({
        key: eventKey,
        payload,
        summary: `Park verdict for ${payload.workItemId}: ${payload.verdict}`,
        source: PARK_SYSTEM_ACTOR,
        workspaceId,
      });
    },

    async clearBlocker(state, input) {
      const { clearExternalBlockersOnLockedRow } = await import('../work-items');
      const now = new Date().toISOString();
      await sql.begin(async (tx) => {
        const rows = await tx<
          Array<{ workspace_id: string; feature_id: string; item_kind: string | null; status: string | null; payload: unknown }>
        >`
          SELECT workspace_id, feature_id, item_kind, status, payload
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId} AND feature_id = ${state.workItemId}
           FOR UPDATE`;
        const row = rows[0];
        if (!row) return;
        await clearExternalBlockersOnLockedRow(
          tx as never,
          row,
          [{ kind: 'human', ref: state.blockerRef, evidence: `${input.recordedAs}: ${input.note}` }],
          PARK_SYSTEM_ACTOR,
          now,
        );
      });
    },

    async advanceCascade(state, positions) {
      const [{ advanceCascade, makeDigestEntry }, { consultExpiryDispatch }, { makeConsultReachDispatcher }] =
        await Promise.all([import('./cascade-core'), import('./consult-expiry-adapters'), import('./consult-dispatch')]);
      const rows = await sql<
        Array<{
          question: string;
          latency_contract: string;
          requester_id: string;
          routing: unknown;
          cascade_cursor: number;
          cascade_digest: unknown;
          state: string;
          expires_at: string | null;
        }>
      >`
        SELECT question, latency_contract, requester_id, routing, cascade_cursor, cascade_digest, state, expires_at
          FROM harness_shared.consult_state
         WHERE workspace_id = ${workspaceId} AND conversation_id = ${state.consultId}`;
      const row = rows[0];
      // A closed consult has no reviewer left to ask; the resolver escalates on
      // exhaustion instead (R-17).
      if (!row || !CONSULT_OPEN_STATES.includes(row.state)) return;
      const nowIso = new Date().toISOString();
      const dispatch = consultExpiryDispatch((ctx) => makeConsultReachDispatcher(ctx));
      await advanceCascade(
        {
          workspaceId,
          conversationId: state.consultId,
          question: row.question,
          latencyContract: row.latency_contract,
          requesterId: row.requester_id,
          routing: row.routing,
          cascadeCursor: row.cascade_cursor,
          digest: row.cascade_digest,
          expectedState: row.state,
          event: makeDigestEntry(state.parkerOwnerId, 'new_fact', nowIso, rebuttalDigestText(positions)),
          stateOnAdvance: 'awaiting_responder',
          nowIso,
        },
        sql,
        (opts) => dispatch({ ...opts, workspaceId }),
      );
    },

    async askOwner(state, input) {
      const [{ askOp, askArgs }, { buildCoordOpCtx }] = await Promise.all([
        import('../coord-ops/ops/compose'),
        import('../coord-ops/prod-caps'),
      ]);
      const args = askArgs.parse({
        question: input.question,
        body: ownerQuestionBody(state, input.question, input.options),
        timeout_s: 0,
        topics: ['consult-park'],
      });
      const ctx = buildCoordOpCtx({
        identity: { ownerId: state.parkerOwnerId },
        workspaceId,
        callerId: state.parkerOwnerId,
        workItemId: state.workItemId,
      });
      const res = await askOp.run(args, ctx);
      if (res.conversation_id) {
        await setParkOwnerConversation(sql, workspaceId, state.consultId, res.conversation_id);
      }
    },
  };
}

/** Read an owner-question answer through the same capability coord:ask-owner polls. */
export async function readParkOwnerAnswer(input: {
  workspaceId: string;
  conversationId: string;
  askerId: string;
}): Promise<{ answered: boolean; answer: string | null }> {
  const { buildCoordOpCaps } = await import('../coord-ops/prod-caps');
  const caps = buildCoordOpCaps({ identity: { ownerId: input.askerId }, workspaceId: input.workspaceId });
  const ans = await caps.readAnswer({ conversationId: input.conversationId, askerId: input.askerId });
  return { answered: ans.answered, answer: ans.answer ?? null };
}
