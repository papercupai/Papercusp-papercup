/**
 * turn-end-held-work-guard — the TURN-END half of loop:end's claim-holder refusal (P-009 of
 * parked-agent-census-resumption-and-root-cause-2026-10-09).
 *
 * loop:end already refuses an autonomous session that still holds unfinished work-items and has no
 * guaranteed wake source. But a session can halt without ever calling loop:end: it just ends its
 * turn with no loop armed. Measured (WI-6554700010015550): codex su-08effe51, AUTO on, holding two
 * items, ended an inbox-wake turn at 2026-10-15T19:04Z with no loop and took no turn for 4h28m,
 * until the owner asked why it stopped. No Stop hook on either client checked this.
 *
 * This module asks loop:end's question at the turn-end hook, with loop:end's own definitions
 * (readHeldWorkItems, guaranteesWake, modeImpliesAutonomy). The identity stop port
 * (POST /api/agent-mcp/stop-context) renders a non-empty answer as a stop refusal on Claude and
 * Codex alike. Both adapters drop the second stop (`stop_hook_active`), so this refuses ONCE per
 * stop and can never loop a session.
 *
 * Owner ruling [owner 2026-10-16, directive #1939 answer]: build the turn-end gate, and do NOT
 * page the owner. This module only talks to the agent.
 *
 * Positive-finding-only: any read failure answers '' (never refuses on a DB hiccup).
 */

import { getLoopStatus } from '../../harness/routines/loop';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import { hasPendingDeliberateWakeDelivery, INBOX_WAKE_KEY_PREFIX, listParkedAwaitsForSubscribers } from './store';
import {
  guaranteesWake,
  readHeldWorkItems,
  readWorkItemAwaitTargets,
  type HeldWorkItem,
  type WakeSourceAwait,
  type WorkItemAwaitTargets,
} from './wake-source-predicate';

/** How many held ids the refusal names before summarising the rest. */
export const TURN_END_HELD_WORK_LISTED_CAP = 8;

/** Everything the verdict depends on, already read. */
export interface TurnEndHeldWorkFacts {
  /** Registered modes of this session that imply autonomy (auto, cold-auto, drain, goal, grade). */
  autonomyModes: readonly string[];
  /** Non-terminal, non-observation work-items this session holds. */
  held: readonly HeldWorkItem[];
  /** An engine loop is armed: it will fire a next turn. */
  loopActive: boolean;
  /** A bounded, wake-on-timeout await or an already-queued deliberate wake exists. */
  guaranteedWake: boolean;
}

/** The refusal text for these facts; '' when ending the turn is safe. Pure. */
export function turnEndHeldWorkStopText(f: TurnEndHeldWorkFacts): string {
  if (f.autonomyModes.length === 0 || f.held.length === 0 || f.loopActive || f.guaranteedWake) return '';
  const ids = f.held.map((h) => h.id);
  const listed =
    ids.slice(0, TURN_END_HELD_WORK_LISTED_CAP).join(', ') +
    (ids.length > TURN_END_HELD_WORK_LISTED_CAP ? `, +${ids.length - TURN_END_HELD_WORK_LISTED_CAP} more` : '');
  const blockerKeys = [...new Set(f.held.flatMap((h) => h.eventBlockers.map((b) => b.ref)))];
  const awaitHint =
    blockerKeys.length > 0
      ? `events:await { event: '${blockerKeys[0]}', timeout_sec: 1800, on_timeout: 'wake' } (your held item names that blocker)`
      : `events:await { event, timeout_sec, on_timeout: 'wake' } for what you are waiting on`;
  return [
    `⛔ TURN-END REFUSED: you are in ${f.autonomyModes.join('+')} mode and hold ${ids.length} unfinished work-item(s) [${listed}], ` +
      'and nothing will wake you after this turn (no armed loop, no timed await). Ending now strands that work: this is the silent halt.',
    'Answering or reconciling a wake message does not finish your lane. Before you stop, do ONE of:',
    '  1. Take the next step you can take now on a held item.',
    `  2. Arm a wake: loop:arm { intervalSec, goal }, or ${awaitHint}.`,
    '  3. work_items:checkpoint, then work_items:release the items you cannot advance, so someone else can.',
    '  4. work_items:complete the items that are actually finished.',
  ].join('\n');
}

/** IO seams, injectable for tests. */
export interface TurnEndHeldWorkDeps {
  getModes: (workspaceId: string, ownerId: string) => Promise<Array<{ mode: string }>>;
  readHeldWorkItems: (ownerId: string, workspaceId: string) => Promise<HeldWorkItem[]>;
  getLoopActive: (ownerId: string) => Promise<boolean | null>;
  listParkedAwaits: (ownerId: string) => Promise<WakeSourceAwait[]>;
  readAwaitTargets: (awaits: WakeSourceAwait[]) => Promise<WorkItemAwaitTargets>;
  hasPendingDeliberateWakeDelivery: (ownerId: string) => Promise<boolean>;
}

const defaultDeps: TurnEndHeldWorkDeps = {
  getModes: (workspaceId, ownerId) => getModes(workspaceId, ownerId),
  readHeldWorkItems: (ownerId, workspaceId) => readHeldWorkItems(ownerId, workspaceId),
  getLoopActive: async (ownerId) => {
    const status = await getLoopStatus(ownerId);
    return status ? status.active === true : null;
  },
  listParkedAwaits: async (ownerId) =>
    (await listParkedAwaitsForSubscribers([ownerId])).map((a) => ({ ...a, subscriberId: ownerId })),
  readAwaitTargets: (awaits) => readWorkItemAwaitTargets(awaits),
  hasPendingDeliberateWakeDelivery: (ownerId) => hasPendingDeliberateWakeDelivery(ownerId),
};

/**
 * The turn-end verdict for one session: the refusal text, or '' to let the turn end.
 * Reads are ordered cheapest-exit first (most sessions have no autonomy mode), and every failure
 * degrades to ''.
 */
export async function evaluateTurnEndHeldWorkStop(input: {
  ownerId: string;
  workspaceId: string;
  deps?: Partial<TurnEndHeldWorkDeps>;
}): Promise<string> {
  const deps: TurnEndHeldWorkDeps = { ...defaultDeps, ...input.deps };
  const { ownerId, workspaceId } = input;
  try {
    const autonomyModes = (await deps.getModes(workspaceId, ownerId))
      .map((row) => row.mode)
      .filter((mode) => modeImpliesAutonomy(mode));
    if (autonomyModes.length === 0) return '';
    const held = await deps.readHeldWorkItems(ownerId, workspaceId);
    if (held.length === 0) return '';
    const loopActive = await deps.getLoopActive(ownerId);
    // An unreadable loop status is unknown, and unknown never refuses.
    if (loopActive !== false) return '';
    const [parked, pendingDelivery] = await Promise.all([
      deps.listParkedAwaits(ownerId),
      deps.hasPendingDeliberateWakeDelivery(ownerId),
    ]);
    if (pendingDelivery) return '';
    const targets = await deps.readAwaitTargets(parked);
    const guaranteedWake = parked.some((a) => guaranteesWake(a, targets, INBOX_WAKE_KEY_PREFIX));
    return turnEndHeldWorkStopText({ autonomyModes, held, loopActive, guaranteedWake });
  } catch {
    return '';
  }
}
