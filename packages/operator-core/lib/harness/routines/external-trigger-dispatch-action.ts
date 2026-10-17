/** Durable outbox drain for external-trigger binding executions (P-003). */
import { getOrgPg } from '@papercusp/db-org';
import { dispatchPendingTriggerRuns, type TriggerDispatchResult } from '../../external-triggers/binding-engine';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function positiveConfig(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The dispatcher routine is also the spend pause surface for binding actions.
 * Keep the whole-routine `active:false` pause untouched: it is an explicit
 * owner disarm and cancels every queued receipt. This flag only holds the
 * model-spending action classes while deterministic bindings drain.
 */
export function spendPauseEnabled(triggerConfig: Record<string, unknown>): boolean {
  return triggerConfig.spend_paused === true || triggerConfig.spendPaused === true;
}

export async function runExternalTriggerDispatch(
  ctx: SystemActionCtx,
): Promise<TriggerDispatchResult> {
  const { sql } = getOrgPg();
  return dispatchPendingTriggerRuns(sql, {
    batchSize: positiveConfig(ctx.triggerConfig.batch_size, 25),
    staleAfterSeconds: positiveConfig(ctx.triggerConfig.stale_after_seconds, 60),
    spendPaused: spendPauseEnabled(ctx.triggerConfig),
  });
}

registerSystemAction('external-trigger-dispatch', async (ctx) => {
  const result = await runExternalTriggerDispatch(ctx);
  if (result.claimed > 0) {
    console.log(
      `[external-trigger-dispatch] claimed=${result.claimed} ` +
        `succeeded=${result.succeeded} failed=${result.failed}`,
    );
  }
});
