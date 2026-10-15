/** Public request schema and recovery remedies against the real consult store.
 * Reuses the registered tool, acceptance core, real migration, and shared PG
 * fixture. This is tree integration evidence; serving-runtime proof is separate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupByMcpName } from '@papercusp/tooldef';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
// Load the host's registration entrypoint during collection so executed-source
// evidence includes the catalog whose public contract these cases exercise.
import '../agent-tools/index';
import tool from '../agent-tools/consult/get-feedback';
import { acceptFeedbackRequestCore, type GetFeedbackDeps, type GetFeedbackRequest } from './get-feedback-core';
import { appendDispatchRecord, dispatchConsultResponder, readSourceDispatchRecords,
  type ConsultDispatchDeps } from './consult-dispatch';

const WS = 'public-consult-contract';
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('consult-contract');
  await db.sql.unsafe(`CREATE TABLE harness_shared.coord_conversations (
    workspace_id text NOT NULL, id text NOT NULL, kind text NOT NULL,
    PRIMARY KEY (workspace_id, id)
  )`);
  await applyMigrationForTest(db.sql, fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url,
  )));
  await applyMigrationForTest(db.sql, fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/1225-consult-dispatch-attempts.sql', import.meta.url,
  )));
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

const deps: Pick<GetFeedbackDeps, 'getSql' | 'open'> = {
  getSql: () => db.sql,
  open: async (input) => {
    if (!input.id) throw new Error('Durable acceptance must supply its identity');
    await db.sql`INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind)
      VALUES (${WS}, ${input.id}, ${input.kind}) ON CONFLICT DO NOTHING`;
    return { conversation_id: input.id, thread_id: `thread-${input.id}`, delivered: 0 };
  },
};

function request(requestKey: string, question = 'Recover this accepted consult'): GetFeedbackRequest {
  const args = tool.args.parse({ request_key: requestKey, question, allow_dispatch: false });
  return { workspaceId: WS, requesterId: 'contract-requester', requestKey: args.request_key,
    question: args.question, allowDispatch: args.allow_dispatch };
}

describe('registered consult contract and persisted recovery', () => {
  it('loads the production catalog without the retired reporting callable and retains ordinary consult and plan tools', async () => {
    for (const name of ['consult:get_feedback', 'consult:reply', 'consult:decline', 'consult:close', 'plans:start']) {
      expect(lookupByMcpName(name), `positive catalog control ${name}`).toBeDefined();
    }
    expect(lookupByMcpName('consult:reconcile')).toBeUndefined();
    // The remaining public workflow can still accept a request with no reporting
    // step, using the actual consult schema and store beneath that catalog.
    const accepted = await acceptFeedbackRequestCore(request('retired-reporting-catalog'), deps);
    expect(accepted).toMatchObject({ verdict: 'accepted', pending: true });
    const [stored] = await db.sql`SELECT requester_id, routing FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(stored.requester_id).toBe('contract-requester');
    expect(stored.routing.deliveryIntent).toBe('retrieval-only');
  });

  it('projects the same bounded retry field and recovery guidance that the store accepts', async () => {
    const projected = lookupByMcpName('consult:get_feedback');
    expect(projected).toBeDefined();
    const schema = projected!.inputSchema as {
      properties: { request_key: { minLength: number; maxLength: number } };
    };
    expect(schema.properties.request_key).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(projected!.description).toContain('conversations:get');
    expect(projected!.description).toContain('request_key');
    const input = request('x'.repeat(200));
    const accepted = await acceptFeedbackRequestCore(input, deps);
    const retry = await acceptFeedbackRequestCore(request(input.requestKey!), deps);
    expect(accepted).toMatchObject({ verdict: 'accepted', state: 'routing', pending: true });
    expect(retry.conversation_id).toBe(accepted.conversation_id);
    const rows = await db.sql`SELECT conversation_id, routing FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].routing.request.payload.requestKey).toBe(input.requestKey);
    expect(rows[0].routing.deliveryIntent).toBe('retrieval-only');
  });

  it('rejects invalid public retry fields before inserting a consult', async () => {
    const before = await db.sql`SELECT count(*)::int AS n FROM harness_shared.consult_state`;
    for (const key of ['', '   ', 'x'.repeat(201)]) {
      expect(() => request(key)).toThrow();
    }
    const after = await db.sql`SELECT count(*)::int AS n FROM harness_shared.consult_state`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('the persisted key-conflict remedy recovers the original payload or accepts a fresh key', async () => {
    const original = request('remedy-original');
    const accepted = await acceptFeedbackRequestCore(original, deps);
    const conflicting = await acceptFeedbackRequestCore(request('remedy-original', 'Changed question'), deps);
    expect(conflicting).toMatchObject({ error: 'request_key_conflict', conversation_id: accepted.conversation_id });
    expect(conflicting.hint).toContain('Reuse its original payload for recovery');
    expect(conflicting.hint).toContain('use a new key for a fresh consult');
    const recovered = await acceptFeedbackRequestCore(original, deps);
    const fresh = await acceptFeedbackRequestCore(request('remedy-fresh', 'Changed question'), deps);
    expect(recovered.conversation_id).toBe(accepted.conversation_id);
    expect(fresh).toMatchObject({ verdict: 'accepted', pending: true });
    expect(fresh.conversation_id).not.toBe(accepted.conversation_id);
    const rows = await db.sql`SELECT question FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(rows[0].question).toBe(original.question);
  });
});

describe('source preflight and persisted dispatch attempts', () => {
  it.each(['eligible', 'cyclic', 'non-plain', 'missing'] as const)(
    'validates the %s source before crossing the launch seam and persists its verdict', async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), 'consult-contract-source-'));
      const path = join(dir, 'source.jsonl');
      const sourceOwnerId = `contract-source-${kind}`;
      const sourceSessionId = `contract-session-${kind}`;
      const answeringOwnerId = `contract-answer-${kind}`;
      let launches = 0;
      try {
        if (kind !== 'missing') {
          await writeFile(path, [
            JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: kind === 'cyclic' ? 'a1' : null,
              message: { role: 'user', content: 'exact source question' } }),
            JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1',
              message: { role: 'assistant', content: 'exact source answer' } }),
          ].join('\n') + '\n');
        }
        const accepted = await acceptFeedbackRequestCore(request(`preflight-${kind}`), deps);
        const conversationId = accepted.conversation_id!;
        // Acceptance is initially routing. Simulate the completed routing
        // transition before exercising the independent dispatcher boundary.
        await db.sql`UPDATE harness_shared.consult_state SET state = 'awaiting_responder'
          WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}`;
        const dispatchDeps: Partial<ConsultDispatchDeps> = {
          resolveResumeTarget: async () => ({ ok: true, sessionId: sourceSessionId,
            resumeId: sourceSessionId, ompThreadId: null, ownerId: sourceOwnerId,
            agent: 'claude', cwd: dir, model: null, modelSource: null,
            endedAt: null, endedBy: null, live: true, advSessionId: 7,
            role: kind === 'non-plain' ? 'reviewer' : null, feature: null, account: null,
            binding: { coordOwnerId: sourceOwnerId, sessionId: sourceSessionId,
              startedAt: '2026-09-22T00:00:00Z' } }),
          checkResumeTranscript: async () => ({ available: true, detail: 'exact fixture source', transcriptPath: path }),
          // Omit checkPortTranscript: exercise the production reader and native adapter.
          readSourceDispatchRecords: (...args) => readSourceDispatchRecords(db.sql, ...args),
          recordDispatchAttempts: (record) => appendDispatchRecord(db.sql, record, new Date().toISOString()),
          readReviewerModel: async () => null,
          isConsultOpen: async (workspaceId, id) => {
            const rows = await db.sql`SELECT state FROM harness_shared.consult_state
              WHERE workspace_id = ${workspaceId} AND conversation_id = ${id}`;
            return rows[0]?.state === 'awaiting_responder';
          },
          loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }],
          fetchContextPressure: async () => new Map(),
          estimateTranscriptTokens: async () => null,
          analyzeClaudeTranscript: () => null,
          probeBackendAvailable: async () => ({ available: true, detail: 'fixture capacity' }),
          mintOwnerId: () => answeringOwnerId,
          buildConsoleEnvelope: async () => ({ cwd: dir, env: {}, greetingCmd: '',
            mcpJsonContents: '{}', needsSuperuserBootstrap: false, sessionId: 'fixture-window' }),
          // Launch and host verification stay bounded test seams; no native agent is started.
          spawnHeadless: async (input) => {
            launches++;
            expect(input.coordOwnerId).toBe(answeringOwnerId);
            expect(input.envelope.greetingCmd).toContain('--agent=codex');
            expect(JSON.parse(input.envelope.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN!))
              .toMatchObject({ sessionId: sourceSessionId, turnIndices: [1] });
            const rows = await db.sql`SELECT responder_id FROM harness_shared.consult_state
              WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}`;
            expect(rows[0].responder_id).toBe(answeringOwnerId);
            return { status: 'ok', pid: 42, taskId: 'fixture-launch', terminal: 'headless',
              child: null, display: null, desktopEnvResolvedVia: null,
              kickoffProof: { persisted: true, nativeRef: path, reason: null } };
          },
          verifyResumeStarted: async () => ({ started: true, waitedMs: 0,
            expectedSessionId: null, actualSessionId: null, mismatch: false }),
        };
        const result = await dispatchConsultResponder({ sourceOwnerId, conversationId,
          evidence: [{ session_id: sourceSessionId, turn_idx: 1, sim: 0.8 }], brief: 'Review exact source',
          onAnsweringOwner: async (id) => {
            await db.sql`UPDATE harness_shared.consult_state SET responder_id = ${id}
              WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}`;
          },
        }, { workspaceId: WS, harnessSlug: null, launchedBy: 'contract-requester' }, dispatchDeps);
        expect(result.dispatched, JSON.stringify(result)).toBe(kind === 'eligible');
        expect(launches).toBe(kind === 'eligible' ? 1 : 0);
        if (kind === 'eligible') {
          expect(result).toMatchObject({ operation: 'convert', answeringOwnerId, verified: true });
          expect(answeringOwnerId).not.toBe(sourceOwnerId);
        } else {
          expect(result.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'conversion-unavailable' });
          expect(result.attempts[0].detail).toContain(kind === 'cyclic' ? 'cycle detected'
            : kind === 'non-plain' ? 'plain tracked SU' : 'preflight refused');
        }
        const rows = await db.sql`SELECT dispatch_attempts FROM harness_shared.consult_state
          WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}`;
        expect(rows[0].dispatch_attempts).toHaveLength(1);
        expect(rows[0].dispatch_attempts[0]).toMatchObject({ sourceOwnerId,
          dispatched: result.dispatched, answeringOwnerId: result.answeringOwnerId,
          attempts: result.attempts });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
