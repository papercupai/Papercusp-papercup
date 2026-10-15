/**
 * Per-leg routing of a frozen repair queue (green-main-cycle-time-2026-10-08 P-013,
 * D-028 as amended by D-029) — the effectful half.
 *
 * The gate's terminal handler calls {@link routeFrozenRepairLegs} once per tick with the
 * queue the tick ended holding. It reads which leg items are already open (the condition
 * fold), plans the delta with the pure `planFrozenRepairLegRouting`, opens the new legs as
 * one-shot conditions and resolves the departed ones in ONE message. The condition bridge
 * then mints / settles the claimable work-items exactly as it does for every other
 * actionable condition; nothing here touches work_items directly.
 *
 * Every dependency is injectable so the whole flow is unit-testable without a database.
 * Best-effort by contract: callers swallow, because routing must never fail a gate tick.
 */

import {
  frozenRepairLegKeyPrefix,
  planFrozenRepairLegRouting,
  type FrozenRepairLegRoutingPlan,
} from './frozen-repair-agent-routing';

export interface FrozenRepairLegRoutingDeps {
  /** Keys currently OPEN in the condition fold that start with `prefix`. */
  readOpenConditionKeys(prefix: string): Promise<string[]>;
  /** Latest recorded failure output per entry on either sha; best-effort, may be empty. */
  readFailureTails(input: {
    candidate: string;
    repairHead: string;
    entries: readonly string[];
  }): Promise<Map<string, string>>;
  broadcastOpen(ev: { conditionKey: string; summary: string; body: string }): Promise<boolean>;
  broadcastResolved(res: { conditionKeys: string[]; summary: string; body?: string }): Promise<boolean>;
}

export interface FrozenRepairLegRoutingRequest {
  pipeline: string;
  /** See FrozenRepairLegRoutingInput.queue: null resolves every open leg of the pipeline. */
  queue: { candidate: string; repairHead: string; failingTests: readonly string[] } | null;
}

export interface FrozenRepairLegRoutingOutcome {
  plan: FrozenRepairLegRoutingPlan;
  opened: string[];
  resolved: string[];
}

export async function routeFrozenRepairLegs(
  req: FrozenRepairLegRoutingRequest,
  deps: FrozenRepairLegRoutingDeps = productionFrozenRepairLegRoutingDeps(),
): Promise<FrozenRepairLegRoutingOutcome> {
  const openLegKeys = await deps.readOpenConditionKeys(frozenRepairLegKeyPrefix(req.pipeline));
  // Plan once without tails to learn which legs are NEW; read tails only for those, so a
  // steady-state tick (nothing changed) costs one fold read and no test_runs query.
  const firstPass = planFrozenRepairLegRouting({ pipeline: req.pipeline, queue: req.queue, openLegKeys });
  let plan = firstPass;
  if (req.queue && firstPass.open.length > 0) {
    let tails = new Map<string, string>();
    try {
      tails = await deps.readFailureTails({
        candidate: req.queue.candidate,
        repairHead: req.queue.repairHead,
        entries: firstPass.open.map((o) => o.entry),
      });
    } catch {
      // Best-effort: an item without its tail still names the leg and the admit call.
    }
    plan = planFrozenRepairLegRouting({
      pipeline: req.pipeline,
      queue: req.queue,
      openLegKeys,
      failureTails: tails,
    });
  }
  const opened: string[] = [];
  for (const o of plan.open) {
    if (await deps.broadcastOpen({ conditionKey: o.conditionKey, summary: o.summary, body: o.body })) {
      opened.push(o.conditionKey);
    }
  }
  const resolved: string[] = [];
  if (plan.resolve.length > 0) {
    const ok = await deps.broadcastResolved({
      conditionKeys: plan.resolve,
      summary: req.queue
        ? `[${req.pipeline}] ${plan.resolve.length} frozen-repair leg(s) left the failing set — their items close.`
        : `[${req.pipeline}] the frozen repair queue cleared — ${plan.resolve.length} leg item(s) close.`,
      body: plan.resolve.map((k) => `  · ${k}`).join('\n'),
    });
    if (ok) resolved.push(...plan.resolve);
  }
  return { plan, opened, resolved };
}

/** Production wiring: the condition fold, the CI test ledger, and the severe-event rail. */
export function productionFrozenRepairLegRoutingDeps(): FrozenRepairLegRoutingDeps {
  return {
    async readOpenConditionKeys(prefix) {
      const { computeConditionStates, readConditionEnvelopes } = await import(
        '../agent-tools/coordination/tools/conditions'
      );
      return computeConditionStates(await readConditionEnvelopes())
        .filter((s) => s.open && s.condition_key.startsWith(prefix))
        .map((s) => s.condition_key);
    },
    async readFailureTails({ candidate, repairHead, entries }) {
      const out = new Map<string, string>();
      if (entries.length === 0) return out;
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      // The gate's own rows only (source='ci', clean checkout), on the two shas the queue
      // judges; newest first so a repairHead failure outranks the candidate's original one.
      const rows = await sql<{ file_path: string; output_tail: string | null }[]>`
        SELECT DISTINCT ON (file_path) file_path, output_tail
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND worktree_dirty = false
           AND commit_sha IN (${candidate}, ${repairHead})
           AND file_path = ANY(${[...entries]})
           AND status IN ('fail', 'error')
           AND output_tail IS NOT NULL
         ORDER BY file_path, finished_at DESC
      `;
      for (const r of rows) if (r.output_tail) out.set(r.file_path, r.output_tail);
      return out;
    },
    async broadcastOpen(ev) {
      const { broadcastSevereEvent } = await import('../severe-event-broadcast');
      // oneShot: this emitter is change-only (D-029), so its silence carries no information
      // and the staleness sweep must not read it as recovery. It closes by the explicit
      // resolve below, which the next tick re-sends if this one was lost.
      return broadcastSevereEvent({ ...ev, category: 'severe-event', oneShot: true });
    },
    async broadcastResolved(res) {
      const { broadcastSevereEventResolvedMany } = await import('../severe-event-broadcast');
      return broadcastSevereEventResolvedMany(res);
    },
  };
}
