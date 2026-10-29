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

import { workspaceForCoordOwner } from '../../adv-sessions';
import { getLoopStatus } from '../../harness/routines/loop';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import {
  isDelayedPendingRespawn,
  readPriorRespawnOutcome,
  type PriorRespawn,
} from '../../carry-respawn-outcome';
import { hasPendingDeliberateWakeDelivery, INBOX_WAKE_KEY_PREFIX, listParkedAwaitsForSubscribers } from './store';
import {
  armTurnEndRewake,
  cancelTurnEndRewake,
  isTurnEndRewakeKey,
  turnEndRewakeRefusalLine,
  type TurnEndRewakeOutcome,
} from './turn-end-rewake';
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

/** A fresh host receipt proves carry acceptance, but is not itself a wake guarantee. */
export function isFreshPendingCarryRespawn(prior: PriorRespawn): boolean {
  return (
    prior.outcome === 'pending' &&
    prior.ageMs !== null &&
    prior.ageMs !== undefined &&
    Number.isFinite(prior.ageMs) &&
    prior.ageMs >= 0 &&
    !isDelayedPendingRespawn(prior)
  );
}

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
      'and no bounded wake is guaranteed after this turn (no armed loop, no wake-on-timeout await). An unbounded event wait may still wake if its event arrives, but ending now can strand this work if it does not: this is the silent halt.',
    'Answering or reconciling a wake message does not finish your lane. Before you stop, do ONE of:',
    '  1. Take the next step you can take now on a held item.',
    `  2. Arm a bounded wake: loop:arm { intervalSec, goal }, or ${awaitHint}.`,
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
  hasPendingDeliberateWakeDelivery: (ownerId: string, excludeDeliveryIds?: readonly number[]) => Promise<boolean>;
  /** A recent host-ledger receipt says this owner has an accepted carry-respawn in flight. */
  hasFreshPendingCarryRespawn: (ownerId: string) => Promise<boolean>;
  /** Arm this session's rewake timer for a refused stop (turn-end-rewake.ts). */
  armRewake: (input: { ownerId: string; held: readonly HeldWorkItem[] }) => Promise<TurnEndRewakeOutcome>;
  /** Drop this session's pending rewake timer once a stop is known safe. */
  cancelRewake: (ownerId: string) => Promise<void>;
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
  hasPendingDeliberateWakeDelivery: (ownerId, excludeDeliveryIds) =>
    hasPendingDeliberateWakeDelivery(ownerId, excludeDeliveryIds),
  hasFreshPendingCarryRespawn: async (ownerId) => {
    return isFreshPendingCarryRespawn(await readPriorRespawnOutcome(ownerId));
  },
  armRewake: (input) => armTurnEndRewake(input),
  cancelRewake: (ownerId) => cancelTurnEndRewake({ ownerId }),
};

export type TurnEndRewakeDeliveryVerdict =
  | { kind: 'keep'; reason?: string }
  | { kind: 'obsolete'; reason: string };

type TurnEndRewakeDeliveryDeps = Pick<
  TurnEndHeldWorkDeps,
  | 'getModes'
  | 'readHeldWorkItems'
  | 'getLoopActive'
  | 'listParkedAwaits'
  | 'readAwaitTargets'
  | 'hasPendingDeliberateWakeDelivery'
> & {
  resolveRecipientWorkspace: (ownerId: string) => Promise<string | null>;
};

const defaultTurnEndRewakeDeliveryDeps: TurnEndRewakeDeliveryDeps = {
  resolveRecipientWorkspace: workspaceForCoordOwner,
  getModes: defaultDeps.getModes,
  readHeldWorkItems: defaultDeps.readHeldWorkItems,
  getLoopActive: defaultDeps.getLoopActive,
  listParkedAwaits: defaultDeps.listParkedAwaits,
  readAwaitTargets: defaultDeps.readAwaitTargets,
  hasPendingDeliberateWakeDelivery: defaultDeps.hasPendingDeliberateWakeDelivery,
};

/**
 * Re-check whether a fired turn-end fallback is still needed immediately before delivery.
 * Its await may already have fired into the delivery queue before a newer dependency await,
 * loop, or released claim made that fallback obsolete. Unknown reads fail open: preserve the wake.
 */
export async function classifyTurnEndRewakeDelivery(input: {
  ownerId: string;
  excludeDeliveryIds?: readonly number[];
  deps?: Partial<TurnEndRewakeDeliveryDeps>;
}): Promise<TurnEndRewakeDeliveryVerdict> {
  const deps: TurnEndRewakeDeliveryDeps = { ...defaultTurnEndRewakeDeliveryDeps, ...input.deps };
  const { ownerId } = input;
  try {
    const workspaceId = await deps.resolveRecipientWorkspace(ownerId);
    if (!workspaceId) return { kind: 'keep', reason: 'recipient workspace is unknown' };

    const modes = await deps.getModes(workspaceId, ownerId);
    const autonomyModes = modes.map((row) => row.mode).filter((mode) => modeImpliesAutonomy(mode));
    if (autonomyModes.length === 0) return { kind: 'obsolete', reason: 'recipient has no active autonomy mode' };

    const held = await deps.readHeldWorkItems(ownerId, workspaceId);
    if (held.length === 0) return { kind: 'obsolete', reason: 'recipient holds no unfinished work' };

    const loopActive = await deps.getLoopActive(ownerId);
    if (loopActive === null) return { kind: 'keep', reason: 'loop status is unknown' };
    if (loopActive) return { kind: 'obsolete', reason: 'an engine loop is active' };

    const excludeDeliveryIds = input.excludeDeliveryIds ?? [];
    if (await deps.hasPendingDeliberateWakeDelivery(ownerId, excludeDeliveryIds)) {
      return { kind: 'obsolete', reason: 'another deliberate wake delivery is already pending' };
    }

    // The timer itself is not a chosen wake source. The standing inbox keepalive is
    // excluded by guaranteesWake; a bounded deliberate inbox await still counts.
    const chosen = (await deps.listParkedAwaits(ownerId)).filter((awaited) => !isTurnEndRewakeKey(awaited.eventKey));
    const targets = await deps.readAwaitTargets(chosen);
    if (chosen.some((awaited) => guaranteesWake(awaited, targets, INBOX_WAKE_KEY_PREFIX))) {
      return { kind: 'obsolete', reason: 'a current bounded wake is already guaranteed' };
    }

    return { kind: 'keep' };
  } catch {
    return { kind: 'keep', reason: 'freshness read failed' };
  }
}

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
    // From here on, a stop KNOWN to be safe drops this session's pending rewake timer: whatever it
    // was set to catch is gone (the work is released, or a real wake source now exists).
    const safeStop = async (): Promise<string> => {
      await deps.cancelRewake(ownerId).catch(() => undefined);
      return '';
    };
    const held = await deps.readHeldWorkItems(ownerId, workspaceId);
    if (held.length === 0) return safeStop();
    const loopActive = await deps.getLoopActive(ownerId);
    // An unreadable loop status is unknown, and unknown never refuses (nor cancels anything).
    if (loopActive === null) return '';
    if (loopActive) return safeStop();
    const [parked, pendingDelivery, pendingCarryRespawn] = await Promise.all([
      deps.listParkedAwaits(ownerId),
      deps.hasPendingDeliberateWakeDelivery(ownerId),
      deps.hasFreshPendingCarryRespawn(ownerId),
    ]);
    if (pendingDelivery) return safeStop();
    // The gate's own rewake timer is a backstop for a stop the gate refused, not a wake source the
    // agent chose: counting it would silence the refusal on every later stop.
    const chosen = parked.filter((a) => !isTurnEndRewakeKey(a.eventKey));
    const targets = await deps.readAwaitTargets(chosen);
    const guaranteedWake = chosen.some((a) => guaranteesWake(a, targets, INBOX_WAKE_KEY_PREFIX));
    if (guaranteedWake) return safeStop();
    if (pendingCarryRespawn) {
      // The host may still terminally drop an accepted carry. Let the pty go quiet only after
      // retaining this bounded fallback; a failed/exhausted timer keeps the refusal in force.
      const fallback = await deps.armRewake({ ownerId, held }).catch(() => null);
      if (fallback?.kind === 'armed') return '';
      const refusal = turnEndHeldWorkStopText({ autonomyModes, held, loopActive, guaranteedWake });
      return fallback
        ? [refusal, turnEndRewakeRefusalLine(fallback)].join('\n')
        : refusal;
    }
    const refusal = turnEndHeldWorkStopText({ autonomyModes, held, loopActive, guaranteedWake });
    if (!refusal) return '';
    // The refusal fires once; the adapters drop the next stop. The timer covers an agent that
    // stops anyway. Arming is best-effort: a failed write never withholds the refusal.
    const rewake = await deps.armRewake({ ownerId, held }).catch(() => null);
    return rewake ? `${refusal}\n${turnEndRewakeRefusalLine(rewake)}` : refusal;
  } catch {
    return '';
  }
}
