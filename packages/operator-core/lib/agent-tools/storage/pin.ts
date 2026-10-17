import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { completedResultPayload } from '../abort-completion-payload';
import { readIdentity } from '../locks/identity';
import { withFsMutex } from '../../../../../scripts/lib/fs-mutex.mjs';

function pinCompletion(_args: unknown, result: ToolResult): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  if (payload?.ok !== true) return { status: 'recovery-incomplete', reason: 'Pin effect was not established' };
  if (payload.op === 'list' || (payload.op === 'unpin' && payload.removed === false)) {
    return { status: 'not-recorded', reason: 'No pin mutation' };
  }
  const pin = payload.pin as { id?: unknown } | undefined;
  const id = payload.op === 'pin' ? pin?.id : payload.id;
  if (typeof id === 'string' && (payload.op === 'pin' || (payload.op === 'unpin' && payload.removed === true))) {
    return { status: 'recorded', effectRef: `retention-pin:${id}:${payload.op}` };
  }
  return { status: 'recovery-incomplete', reason: 'Missing pin mutation identity' };
}

/** New effect on the existing storage surface; the backing store is unchanged. */
export default defineTool({
  name: 'storage:pin',
  profile: 'engineer',
  description: 'Pin agent output beyond its default retention with an owner, reason and finite expiry; list pins or release your own pin. Uses the existing retention leases honoured by disk reclaim and release deleters.',
  capability: 'storage:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  abortCompletionReceipt: pinCompletion,
  guidance: {
    when: 'Agent scratch, evidence or a build copy must survive its default age while a review or task is in progress. Always supply a reason and expiry.',
    notWhen: 'To make owner/system data disposable, change retention rules, or bypass live process protections.',
    chaining: 'storage:pin {op:"pin",path,reason,expiresAt} → work → storage:pin {op:"unpin",id}. List with op:"list".',
  },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('pin'), path: z.string().min(1), reason: z.string().trim().min(1).max(2000), expiresAt: z.string().datetime({ offset: true }) }),
    z.object({ op: z.literal('list'), includeExpired: z.boolean().optional() }),
    z.object({ op: z.literal('unpin'), id: z.string().uuid() }),
  ]),
  async handler(args, ctx) {
    const { createRetentionPin, readRetentionPins, removeRetentionPin } = await import('../../storage/retention-pins');
    if (args.op === 'list') {
      const read = readRetentionPins({ includeExpired: args.includeExpired });
      return { data: { ok: read.errors.length === 0, op: args.op, ...read }, isError: read.errors.length > 0 };
    }
    const { ownerId } = readIdentity(ctx);
    // The reclaim reads leases only after it holds this same mutex. A pin either
    // lands before that read, or verifies its target still exists after reclaim.
    // Keep the shared fs-mutex wait policy when the host did not provide a
    // deadline. The previous six-second fallback became a hard five-second
    // cap, so a normal retention pass could make a valid pin fail transiently.
    const deadlineAtMs = ctx.deadlineAtMs;
    const mutexOptions = typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs)
      ? { timeoutMs: Math.max(1, deadlineAtMs - Date.now() - 1_000) }
      : {};
    return withFsMutex('papercusp-disk-retention', async () => {
      if (args.op === 'pin') {
        const pin = createRetentionPin({ path: args.path, reason: args.reason, expiresAt: args.expiresAt, owner: ownerId });
        return { data: { ok: true, op: args.op, pin } };
      }
      return { data: { ok: true, op: args.op, id: args.id, removed: removeRetentionPin(args.id, ownerId) } };
    }, mutexOptions);
  },
});
