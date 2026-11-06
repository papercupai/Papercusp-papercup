/** Real Postgres proof that every terminal colour persists once with its exact attempt. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(async (tx) => run(tx as unknown as Sql)),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-checkpoint-terminal-outcomes' }));
vi.mock('../events/dispatch-reaction', () => ({
  fireReactionInProcess: vi.fn(), reactionBackgroundActivityAllowed: vi.fn(async () => true),
}));

import {
  beginStoredQualification,
  readStoredQualification,
  recordStoredQualificationWorkProgress,
  recordStoredQualificationVerdict,
  reserveStoredQualificationRunner,
} from './checkpoint-qualification-transaction';
import { executeDurableReaction, type DurableReactionPayload } from '@papercusp/event-reaction';
import { claimReaction, completeReaction, markReactionFailed, markReactionUncertain,
  reactionOutcome, releaseReaction } from '../events/reaction-dedup';
import * as reactionLedger from '../events/reaction-dedup';
import { executeDurableReaction as executeHostDurableReaction } from '../events/durable-exec';
import { fireReactionInProcess } from '../events/dispatch-reaction';
import { executeWithGateActionReceipt, reconcileGateActionReceipt } from './gate-action-receipt';
import { checkpointTerminalDelivery, recoverCheckpointTerminalEvents } from './checkpoint-qualification-terminal-events';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-checkpoint-terminal-outcomes', installSlug: 'papercusp' };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fireReactionInProcess).mockReset();
  await sql`DELETE FROM harness_shared.audit_log WHERE workspace_id = ${target.workspaceId}`;
  await sql`DELETE FROM harness_shared.event_reactions WHERE workspace_id = ${target.workspaceId}`;
  await sql`DELETE FROM harness_shared.pipeline_events WHERE workspace_id = ${target.workspaceId}`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-checkpoint-terminal-outcomes', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, '{}'::jsonb)
  `;
});

describe('checkpoint qualification terminal outcomes (real Postgres)', () => {
  it.each(['pending-before-send', 'admitted-before-projection', 'unacknowledged', 'wrong-identity', 'projection-without-receipt', 'superseded'] as const)(
    'durable terminal wake recovery: %s', async boundary => {
      const identity = { ...target, attemptId: 'wake-attempt', candidate: 'wake-candidate',
        runId: 'wake-run', green: false, candidates: ['wake-candidate'] };
      const delivery = checkpointTerminalDelivery(identity, [{
        key: 'green-checkpoint:red:papercusp', summary: 'Frozen candidate is red.',
        payload: { sha: identity.candidate, runId: identity.runId },
      }]);
      await beginStoredQualification(target, { attemptId: identity.attemptId, candidate: identity.candidate, nowMs: 100 });
      expect((await recordStoredQualificationVerdict(target, { ...identity, reason: 'not-green', nowMs: 200,
        terminalEvent: { status: 'not-green', detail: { attemptId: identity.attemptId,
          fullCandidate: identity.candidate, candidate: identity.candidate, runId: identity.runId,
          green: false, terminalDelivery: delivery } } })).status).toBe('updated');
      const emit = vi.fn(async () => boundary === 'unacknowledged'
        ? { ok: true, latchRecorded: true, notified: ['subscriber'], msgId: null }
        : { ok: true, latchRecorded: true, notified: ['subscriber'], msgId: 'durable-message' });
      if (boundary === 'admitted-before-projection') {
        expect((await recoverCheckpointTerminalEvents(target, { emit })).failed).toEqual([]);
        // Lose only the pipeline projection; the real reaction receipt remains.
        await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail, '{terminalDelivery}',
          ${JSON.stringify(delivery)}::jsonb) WHERE workspace_id = ${target.workspaceId}`;
      } else if (boundary === 'superseded') {
        expect((await beginStoredQualification(target, { attemptId: 'successor-attempt', candidate: 'successor-candidate', nowMs: 300 })).status)
          .toBe('updated');
      } else if (boundary === 'wrong-identity') {
        await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail,
          '{terminalDelivery,identity,runId}', '"another-run"'::jsonb) WHERE workspace_id = ${target.workspaceId}`;
      } else if (boundary === 'projection-without-receipt') {
        await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail,
          ${['terminalDelivery', 'accepted', delivery.events[0]!.id]}::text[], 'true'::jsonb)
          WHERE workspace_id = ${target.workspaceId}`;
      }
      const recovered = await recoverCheckpointTerminalEvents(target, { emit });
      const success = boundary === 'pending-before-send' || boundary === 'admitted-before-projection';
      expect(recovered.failed).toHaveLength(success ? 0 : 1);
      const [row] = await sql<{ detail: { terminalDelivery: typeof delivery } }[]>`
        SELECT detail FROM harness_shared.pipeline_events WHERE workspace_id = ${target.workspaceId}`;
      expect(row!.detail.terminalDelivery.pending).toBe(!success);
      if (success) {
        expect(row!.detail.terminalDelivery.accepted).toEqual({ [delivery.events[0]!.id]: true });
        expect(await reactionOutcome(delivery.events[0]!.id)).toBe('completed');
      }
      await recoverCheckpointTerminalEvents(target, { emit });
      expect(emit).toHaveBeenCalledTimes(['wrong-identity', 'projection-without-receipt', 'superseded'].includes(boundary) ? 0 : 1);
      expect((await readStoredQualification(target))).toMatchObject(boundary === 'superseded'
        ? { transaction: { attemptId: 'successor-attempt', candidate: 'successor-candidate', outcome: { kind: 'pending' } } }
        : { transaction: { outcome: { kind: 'red' }, attemptId: identity.attemptId, runId: identity.runId } });
    });

  it.each(['receiver-settled', 'receiver-unsettled', 'changed-request'] as const)(
    'automatic receiver reconciliation: %s never launches twice', async boundary => {
      const payload: DurableReactionPayload = { dedupId: `qualification:receiver:${boundary}`,
        fire: 'release:deploy', ruleId: 'terminal-recovery', triggerTool: 'event:release:green',
        parent: { workspaceId: target.workspaceId }, args: { op: 'trigger', confirm: true },
        cause: { ruleId: 'terminal-recovery', rootRunId: 'run-receiver', depth: 0, chain: [] } };
      let launches = 0;
      let executionId = '';
      vi.mocked(fireReactionInProcess).mockImplementation(async request => {
        executionId = request.executionId!;
        const accepted = await executeWithGateActionReceipt({ action: request.fire,
          actor: 'receiver-fixture', ownerId: 'receiver-fixture', executionId,
          conditionKey: 'gate-receiver-fixture', allowUnowned: true,
          target: { op: 'trigger', greenPinSha: 'candidate-receiver' },
          run: async () => {
            launches++;
            if (boundary === 'receiver-unsettled') throw new Error('receiver died before settlement');
            return { launched: true };
          },
          summarize: () => ({ status: 'detached-launch-accepted', deployedSha: 'unknown' }),
        });
        return { ok: accepted.ok, ...(!accepted.ok ? { error: accepted.reason } : {}) };
      });
      // Commit the receiver's real audit settlement, then lose only the runner's acknowledgment.
      const completion = vi.spyOn(reactionLedger, 'completeReaction')
        .mockRejectedValueOnce(new Error('runner died before acknowledgment'));
      await expect(executeHostDurableReaction(payload)).rejects.toThrow('needs reconciliation');
      completion.mockRestore();
      expect(await reactionOutcome(payload.dedupId)).toBe('uncertain');
      const replay = boundary === 'changed-request'
        ? { ...payload, args: { ...payload.args, commit: 'different-candidate' } } : payload;
      if (boundary === 'receiver-settled') {
        await executeHostDurableReaction(replay);
        expect(await reactionOutcome(payload.dedupId)).toBe('completed');
      } else {
        await expect(executeHostDurableReaction(replay)).rejects.toThrow('needs reconciliation');
        expect(await reactionOutcome(payload.dedupId)).toBe('uncertain');
      }
      expect(launches).toBe(1);
      expect(fireReactionInProcess).toHaveBeenCalledOnce();
      const rows = await sql<{ details: Record<string, unknown> }[]>`SELECT details FROM harness_shared.audit_log
        WHERE workspace_id = ${target.workspaceId} AND details->>'executionId' = ${executionId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ phase: boundary === 'receiver-unsettled' ? 'intent' : 'settled' });
      expect(await reconcileGateActionReceipt({ workspaceId: 'another-workspace', action: 'release:deploy', executionId }))
        .toBe('uncertain');
      expect(await reconcileGateActionReceipt({ workspaceId: target.workspaceId, action: 'release:checkpoint-run', executionId }))
        .toBe('uncertain');
    });

  it.each(['durable-before-ack', 'after-ack'] as const)('%s: terminal replay preserves the frozen population and receipts', async boundary => {
    await beginStoredQualification(target, { attemptId: 'attempt-interrupted', candidate: 'candidate-interrupted', nowMs: 100 });
    const owner = { attemptId: 'attempt-interrupted', candidate: 'candidate-interrupted', runnerId: 'runner-interrupted',
      runId: 'run-interrupted', pid: process.pid, pidIdentity: 'boot:fixture', leaseDurationMs: 1000, nowMs: 200 };
    expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
    const manifest = { schemaVersion: 1 as const, units: [
      { id: 'finished', kind: 'test' as const, path: 'finished.test.ts' },
      { id: 'pending', kind: 'test' as const, path: 'pending.test.ts' },
      { id: 'delivery', kind: 'post-suite' as const, path: 'delivery.ts' },
    ] };
    const receipt = { unitId: 'finished', completionId: 'passed-before-finalization', observedAtMs: 250,
      state: 'pass' as const, firstAttemptVerdict: 'pass' as const, observedCount: 1, worktreeDirty: false };
    expect((await recordStoredQualificationWorkProgress(target, { ...owner, repairHead: null, root: '/repo',
      taskKey: 'full-qualification', runnerIdentity: 'proof-v3 node', runContext: 'ci', manifest,
      retryStates: [], updates: [{ receipt }], nowMs: 300 })).status).toBe('updated');
    const terminal = { attemptId: owner.attemptId, candidate: owner.candidate, runId: owner.runId,
      reason: 'not-green', green: false, nowMs: 400,
      terminalEvent: { status: 'not-green', detail: { candidate: owner.candidate, runId: owner.runId } } };
    const commit = async () => {
      const committed = await recordStoredQualificationVerdict(target, terminal);
      if (boundary === 'durable-before-ack') throw new Error('connection lost after commit before acknowledgment');
      return committed;
    };
    if (boundary === 'durable-before-ack') await expect(commit()).rejects.toThrow('after commit');
    else expect((await commit()).status).toBe('updated');

    // Independent JSONB read, not the writer's returned object, is the recovery authority.
    const [stored] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}
        AND install_slug = ${target.installSlug}`;
    const before = structuredClone(stored!.metadata.qualificationTransaction);
    expect(before).toMatchObject({ phase: 'terminal', outcome: { kind: 'red' },
      continuation: { manifest, receipts: [receipt] } });
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('terminal');
    expect(await readStoredQualification(target)).toMatchObject({ status: 'present', transaction: before });
    const rows = await sql`SELECT detail FROM harness_shared.pipeline_events
      WHERE workspace_id = ${target.workspaceId} AND kind = 'green_checkpoint'`;
    expect(rows).toHaveLength(1);
    // A replay cannot upgrade incomplete coverage into a green/promotion authority.
    expect((await recordStoredQualificationVerdict(target, { ...terminal, green: true, reason: 'advanced' })).status).toBe('conflict');
    expect(await readStoredQualification(target)).toMatchObject({ status: 'present', transaction: before });
  });

  it.each(['promotion', 'deployment', 'notification'] as const)(
    'delivered-before-receipt: %s stays uncertain and duplicate recovery does not repeat its effect', async effect => {
      const dedupId = `qualification:${target.workspaceId}:attempt-1:run-1:${effect}`;
      const payload: DurableReactionPayload = { dedupId, fire: `test:${effect}`, ruleId: 'terminal-recovery',
        triggerTool: 'test:terminal-recovery', parent: { workspaceId: target.workspaceId }, args: {},
        cause: { ruleId: 'terminal-recovery', rootRunId: 'run-1', depth: 0, chain: [] } };
      let effects = 0;
      const fire = vi.fn(async () => { effects++; return { ok: true }; });
      const deps = { store: { claim: claimReaction, release: releaseReaction, markFailed: markReactionFailed,
        outcome: reactionOutcome, uncertain: markReactionUncertain,
        complete: async () => { throw new Error('crash after external delivery before receipt'); } }, fire };
      await expect(executeDurableReaction(payload, deps)).rejects.toThrow('needs reconciliation');
      await expect(executeDurableReaction(payload, deps)).rejects.toThrow('needs reconciliation');
      expect(effects).toBe(1);
      expect(fire).toHaveBeenCalledOnce();
      expect(await reactionOutcome(dedupId)).toBe('uncertain');
      const [row] = await sql`SELECT status FROM harness_shared.event_reactions WHERE dedup_id = ${dedupId}`;
      expect(row!.status).toBe('needs_reconciliation');
      // This is an explicit late durable acknowledgment from the effect's owner.
      // An uncertain claim alone must never manufacture it.
      await completeReaction(dedupId);
      await executeDurableReaction(payload, deps);
      expect(effects).toBe(1);
      expect(await reactionOutcome(dedupId)).toBe('completed');
    });

  it.each([
    { reason: 'advanced', green: true, outcome: 'green' },
    { reason: 'not-green', green: false, outcome: 'red' },
    // Infra inconclusive is a retryable pre-suite no-verdict; this code outcome is terminal.
    { reason: 'not-fast-forward', green: null, outcome: 'code-inconclusive' },
  ] as const)('persists one $outcome result and rejects a foreign candidate', async ({ reason, green, outcome }) => {
    const runId = `run-${reason}`;
    expect((await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    })).status).toBe('updated');

    const terminal = {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId,
      reason, green, nowMs: 200,
      terminalEvent: { status: reason, detail: { candidate: 'candidate-1', runId } },
    };
    expect((await recordStoredQualificationVerdict(target, {
      ...terminal, candidate: 'foreign-candidate',
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('terminal');

    expect(await readStoredQualification(target)).toMatchObject({
      status: 'present',
      transaction: {
        attemptId: 'attempt-1', candidate: 'candidate-1', runId,
        phase: 'terminal', lastTerminalVerdictAtMs: 200,
        outcome: { kind: outcome, reason },
      },
    });
    // WI-10007497: the caller's detail carries no attemptId; the committed event must still name
    // the logical attempt it settled, from the transaction itself.
    const events = await sql<{ status: string; candidate: string; run_id: string; attempt_id: string | null }[]>`
      SELECT status, detail->>'candidate' AS candidate, detail->>'runId' AS run_id,
             detail->>'attemptId' AS attempt_id
        FROM harness_shared.pipeline_events
       WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
         AND kind = 'green_checkpoint'
    `;
    expect(events).toEqual([{ status: reason, candidate: 'candidate-1', run_id: runId, attempt_id: 'attempt-1' }]);
  });
});
