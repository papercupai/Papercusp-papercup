/**
 * inbox-wake-held-work-reminder — the DELIVERY-TIME half of the silent-halt fix (WI-6554700010018536,
 * report rpt_24408ef5-04d2-45ca-b56a-27ee3cca8c98 item #3).
 *
 * Measured (WI-6554700010015550): codex su-08effe51, AUTO on, holding two items, was woken by an
 * always-armed `coord:inbox-wake:<owner>`. The wake text ended with the EI-16648 reconcile NOTE
 * ("the quoted message may ALREADY have been surfaced + handled … do NOT re-do handled mail") and
 * said nothing about the work the agent still held. It reconciled the mail, read "mail handled" as
 * "lane done", ended the turn with no loop armed, and took no turn for 4h28m.
 *
 * The turn-end guard (turn-end-held-work-guard.ts) refuses that stop after the fact, on clients
 * whose Stop hook runs it. This module fixes the prompt that invited it: when an inbox-wake is
 * delivered to a session that holds unfinished work-items, the wake text says so, names them, and
 * says that answering the mail does not finish the lane. When that session is also in an autonomy
 * mode with no armed loop, it says that nothing will wake it after this turn.
 *
 * Read at DELIVERY time, not fire time: a held-work list taken when the message was sent goes stale
 * across the fire→delivery gap exactly like the quoted body does. Every read is bounded and every
 * failure degrades to '' — a reminder must never delay or break a wake.
 *
 * WHICH WORKSPACE (WI-6554700010018671): the await/delivery plane is pinned to
 * DEFAULT_COORD_WORKSPACE (WI-3575), so a delivery row's workspace_id is the literal 'default' for
 * every wake — never the recipient's tenant. Held work-items and registered modes live under the
 * tenant, so reading them under the delivery's workspace returned nothing and the reminder never
 * fired live (measured 2026-10-21, delivery #927561). The tenant is resolved from the recipient's
 * own session row; the delivery workspace is used only when it is a concrete non-coordination id
 * and the session lookup found nothing. No tenant ⇒ no reminder (never guess another tenant).
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { workspaceForCoordOwner } from '../../adv-sessions';
import { getLoopStatus } from '../../harness/routines/loop';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import { concreteWorkspaceIdOrNull } from '../../workspace-registry';
import { INBOX_WAKE_KEY_PREFIX, listParkedAwaitsForSubscribers } from './store';
import { isTurnEndRewakeKey } from './turn-end-rewake';
import {
  guaranteesWake,
  readHeldWorkItems,
  readWorkItemAwaitTargets,
  type HeldWorkItem,
} from './wake-source-predicate';

/** How many held ids the reminder names before summarising the rest. */
export const INBOX_WAKE_HELD_WORK_LISTED_CAP = 5;

/** The whole reminder read must finish inside this budget or it is skipped. */
export const INBOX_WAKE_HELD_WORK_BUDGET_MS = 1500;

/** Everything the reminder depends on, already read. */
export interface InboxWakeHeldWorkFacts {
  /** Non-terminal, non-observation work-items this session holds. */
  held: readonly Pick<HeldWorkItem, 'id'>[];
  /** Registered modes of this session that imply autonomy (auto, cold-auto, drain, goal, grade). */
  autonomyModes: readonly string[];
  /** true = an engine loop is armed; false = none; null = unknown (never claims "no loop"). */
  loopActive: boolean | null;
  /** Whether a current, bounded await guarantees a wake; null = unknown. */
  guaranteedAwaitWake: boolean | null;
}

/** The single-line reminder for these facts; '' when the session holds nothing. Pure. */
export function inboxWakeHeldWorkReminderText(f: InboxWakeHeldWorkFacts): string {
  if (f.held.length === 0) return '';
  const ids = f.held.map((h) => h.id);
  const listed =
    ids.slice(0, INBOX_WAKE_HELD_WORK_LISTED_CAP).join(', ') +
    (ids.length > INBOX_WAKE_HELD_WORK_LISTED_CAP ? `, +${ids.length - INBOX_WAKE_HELD_WORK_LISTED_CAP} more` : '');
  const parts = [
    `REMINDER (work list snapshot): a recent read found ${ids.length} unfinished work-item(s) [${listed}].` +
      " This snapshot may be stale by the time you act; recheck each item's current state and assignee with work_items:get before continuing. " +
      'Answering or reconciling this message does not finish any still-open items.',
  ];
  if (f.autonomyModes.length > 0 && f.loopActive === false && f.guaranteedAwaitWake === false) {
    parts.push(
      'No bounded wake is currently guaranteed (the recent read found no armed loop or wake-on-timeout await). ' +
        'This snapshot may be stale by the time you stop; recheck loop:status and events:status before ending with held work.',
    );
  }
  return parts.join(' ');
}

/** IO seams, injectable for tests. */
export interface InboxWakeHeldWorkDeps {
  /** The recipient session's own tenant workspace (its most recent adv-session row), or null. */
  resolveRecipientWorkspace: (ownerId: string) => Promise<string | null>;
  readHeldWorkItems: (ownerId: string, workspaceId: string) => Promise<HeldWorkItem[]>;
  getModes: (workspaceId: string, ownerId: string) => Promise<Array<{ mode: string }>>;
  getLoopActive: (ownerId: string) => Promise<boolean | null>;
  hasGuaranteedAwaitWake: (ownerId: string) => Promise<boolean>;
  budgetMs: number;
}

const defaultDeps: InboxWakeHeldWorkDeps = {
  resolveRecipientWorkspace: (ownerId) => workspaceForCoordOwner(ownerId),
  readHeldWorkItems: (ownerId, workspaceId) => readHeldWorkItems(ownerId, workspaceId),
  getModes: (workspaceId, ownerId) => getModes(workspaceId, ownerId),
  getLoopActive: async (ownerId) => {
    const status = await getLoopStatus(ownerId);
    return status ? status.active === true : null;
  },
  hasGuaranteedAwaitWake: async (ownerId) => {
    const awaits = (await listParkedAwaitsForSubscribers([ownerId])).filter(
      (entry) => !isTurnEndRewakeKey(entry.eventKey),
    );
    const targets = await readWorkItemAwaitTargets(awaits);
    return awaits.some((entry) => guaranteesWake(entry, targets, INBOX_WAKE_KEY_PREFIX));
  },
  budgetMs: INBOX_WAKE_HELD_WORK_BUDGET_MS,
};

/**
 * The delivery row's workspace when it names a real tenant; null for the coordination namespace
 * every delivery is pinned to today (WI-3575), and for '*' / blank / malformed values. Pure.
 */
export function tenantFromDeliveryWorkspace(deliveryWorkspaceId: string | null | undefined): string | null {
  const ws = concreteWorkspaceIdOrNull(deliveryWorkspaceId);
  return ws === DEFAULT_COORD_WORKSPACE ? null : ws;
}

/**
 * The reminder for one inbox-wake recipient at delivery time, or ''. Resolves the recipient's tenant
 * first (see "WHICH WORKSPACE" above), then reads held work (the cheapest exit: most recipients hold
 * nothing). A failed or slow mode/loop read drops only the autonomy sentence, never the held-work
 * one; a failed or slow tenant or held-work read yields ''.
 */
export async function prepareInboxWakeHeldWorkReminder(input: {
  ownerId: string;
  /** The delivery row's workspace_id — the coordination namespace, NOT the recipient's tenant. */
  deliveryWorkspaceId: string;
  deps?: Partial<InboxWakeHeldWorkDeps>;
}): Promise<string> {
  const deps: InboxWakeHeldWorkDeps = { ...defaultDeps, ...input.deps };
  const { ownerId } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.budgetMs);
  });
  const within = <T>(p: Promise<T>): Promise<T | 'timeout'> => Promise.race([p, timedOut]);
  try {
    const resolved = await within(deps.resolveRecipientWorkspace(ownerId).catch(() => null));
    if (resolved === 'timeout') return '';
    const workspaceId =
      concreteWorkspaceIdOrNull(resolved) ?? tenantFromDeliveryWorkspace(input.deliveryWorkspaceId);
    if (!workspaceId) return '';
    const held = await within(deps.readHeldWorkItems(ownerId, workspaceId));
    if (held === 'timeout' || held.length === 0) return '';
    const [modes, loopActive] = await Promise.all([
      within(deps.getModes(workspaceId, ownerId)).catch(() => 'timeout' as const),
      within(deps.getLoopActive(ownerId)).catch(() => 'timeout' as const),
    ]);
    const autonomyModes =
      modes === 'timeout' ? [] : modes.map((row) => row.mode).filter((mode) => modeImpliesAutonomy(mode));
    let guaranteedAwaitWake: boolean | null = null;
    if (autonomyModes.length > 0 && loopActive === false) {
      const awaitWake = await within(deps.hasGuaranteedAwaitWake(ownerId).catch(() => null));
      guaranteedAwaitWake = awaitWake === 'timeout' ? null : awaitWake;
    }
    return inboxWakeHeldWorkReminderText({
      held,
      autonomyModes,
      loopActive: loopActive === 'timeout' ? null : loopActive,
      guaranteedAwaitWake,
    });
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
