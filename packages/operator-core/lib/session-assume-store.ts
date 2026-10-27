/** Production receipt adapter over the existing launch ledger and append-only
 * coordination log. The receipt CAS and its audit append commit together. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination';
import { claimAgentLaunch } from './agent-launch-core';
import {
  assumePreparationFingerprint, assumePreparationSchema, assumeTransitionKey,
  type AssumePreparation, type AssumeTransitionDeps, type AssumeTransitionReceipt,
} from './session-assume';

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const receiptSchema = z.object({
  transitionKey: text, preparationFingerprint: hash, preparation: assumePreparationSchema,
  state: z.enum(['prepared', 'caller-checkpointed', 'caller-quiesced', 'target-custody-acquired',
    'handoff-requested', 'handoff-accepted', 'target-verified', 'refused', 'rolled-back', 'indeterminate']),
  updatedAt: z.number().int().nonnegative(), durable: z.literal(true), reason: text.optional(),
  recovery: z.object({ checkpointRef: text, checkpointSha256: hash,
    returnRef: z.object({ ownerId: text, workspaceId: text, nativeSessionId: text, incarnation: text }).strict(),
  }).strict().optional(),
  disposition: z.object({
    releasedWorkClaims: z.array(z.object({ id: text, checkpointRef: text }).strict()),
    releasedPlanClaims: z.array(z.object({ plan: text, item: text, checkpointRef: text }).strict()),
    pausedLoopRef: text.nullable(), pausedAwaitIds: z.array(positive),
    inbox: z.literal('retained'), directives: z.literal('retained'),
  }).strict().optional(),
  startup: z.object({ attemptId: z.string().uuid(), generation: positive,
    authorizedAt: z.number().int().nonnegative(), launcherPid: positive, launcherProcessStart: text,
    ptyPid: positive.optional(), ptyProcessStart: text.optional(),
  }).strict().refine(value => (value.ptyPid === undefined) === (value.ptyProcessStart === undefined)).optional(),
  callerReturn: z.object({ transitionKey: text, caller: assumePreparationSchema.shape.caller,
    nativeProcessStart: text, restoredAt: z.number().int().nonnegative() }).strict().optional(),
  observation: z.object({
    transitionKey: text, observedAt: z.number().int().nonnegative(), hostId: text, attachmentId: text,
    callerNativePid: positive, callerExited: z.boolean(), targetOwnerId: text, targetNativeSessionId: text,
    backend: z.enum(['claude', 'codex', 'omp']), contextSha256: hash,
    nativeBinding: z.object({ advSessionId: positive, ownerId: text, sourceNativeSessionId: text,
      nativeSessionId: text, transitionKey: text }).strict().optional(),
    nativePid: positive, nativeProcessStart: text, nativeWriterPids: z.array(positive),
    ptyPid: positive.optional(), ptyProcessStart: text.optional(),
    directedMessage: z.object({ id: text, recipient: text, consumedBy: text, consumptions: positive }).strict(),
    assignment: z.object({ id: text, assignee: text, observedBy: text }).strict(),
  }).strict().optional(),
}).strict();

function summary(receipt: AssumeTransitionReceipt): Record<string, unknown> {
  // Never persist replay-only transport fields, arbitrary adapter errors or raw
  // transcript/credential material in this coordination receipt.
  const { replayed: _replayed, ...value } = receipt as AssumeTransitionReceipt & { replayed?: boolean };
  return { sessionAssume: receiptSchema.parse(value) };
}

export function createAssumeReceiptStore(plan: AssumePreparation):
  Pick<AssumeTransitionDeps, 'claim' | 'save'> & { load(): Promise<AssumeTransitionReceipt | null> } {
  const workspaceId = plan.caller.workspaceId;
  const key = assumeTransitionKey(plan);
  const fingerprint = assumePreparationFingerprint(plan);
  let previous: Record<string, unknown> | null = null;
  const decode = (value: unknown): AssumeTransitionReceipt => {
    const receipt = receiptSchema.parse(z.object({ sessionAssume: z.unknown() }).strict().parse(value).sessionAssume);
    if (receipt.transitionKey !== key || receipt.preparationFingerprint !== assumePreparationFingerprint(receipt.preparation) ||
        assumeTransitionKey(receipt.preparation) !== key || receipt.preparation.caller.workspaceId !== workspaceId) {
      throw new Error('assume-receipt-invalid');
    }
    return receipt;
  };
  return {
    async claim(receipt) {
      if (receipt.transitionKey !== key || receipt.preparationFingerprint !== fingerprint || receipt.state !== 'prepared') {
        throw new Error('assume-receipt-invalid');
      }
      const initialSummary = summary(receipt);
      const result = await claimAgentLaunch({ workspaceId, idempotencyKey: key,
        launchedBy: plan.caller.ownerId, initialSummary, failClosed: true });
      const prior = result.won ? null : result.priorSummary ? decode(result.priorSummary) : null;
      previous = result.won ? initialSummary : result.priorSummary;
      return { won: result.won, prior };
    },
    async load() {
      const { sql } = getOrgPg();
      const [row] = await sql<Array<{ summary: unknown }>>`
        SELECT summary FROM harness_shared.agent_launch_idempotency
         WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
      `;
      if (!row) { previous = null; return null; }
      const receipt = decode(row.summary);
      previous = summary(receipt);
      return receipt;
    },
    async save(receipt) {
      if (!previous || receipt.transitionKey !== key || receipt.preparationFingerprint !== fingerprint) {
        throw new Error('assume-receipt-not-owned');
      }
      if (decode(previous).startup && !receipt.startup) throw new Error('assume-startup-not-owned');
      const next = summary(receipt);
      const digest = createHash('sha256').update(JSON.stringify(next)).digest('hex');
      const envelope: CoordEnvelope = {
        msg_id: `${key}:${digest}`, ts: new Date(receipt.updatedAt).toISOString(),
        from: plan.caller.ownerId, to: [], kind: 'message', category: 'session-assume-audit',
        harness_slug: plan.target.harnessSlug, summary: `session:assume ${receipt.state}`,
        // Identity, admission and context pins only. Checkpoint contents and
        // credentials are deliberately absent from this append-only record.
        sessionAssume: next.sessionAssume,
      };
      const { sql } = getOrgPg();
      const log = new PgCoordLog({ getSql: () => sql, workspaceId, ensureSchema: async () => {} });
      await log.appendLineIfAbsent('messages', plan.caller.ownerId, envelope, {
        prepare: async tx => {
          const rows = await tx<Array<{ idempotency_key: string }>>`
            UPDATE harness_shared.agent_launch_idempotency
               SET summary = ${JSON.stringify(next)}::text::jsonb
             WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
               AND summary = ${JSON.stringify(previous)}::text::jsonb
            RETURNING idempotency_key
          `;
          if (rows.length !== 1) throw new Error('assume-receipt-changed');
          return envelope;
        },
      });
      previous = next;
    },
  };
}
