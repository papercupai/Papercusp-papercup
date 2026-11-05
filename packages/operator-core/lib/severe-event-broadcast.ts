/**
 * severe-event-broadcast — a process-level watchdog's opt-in severe-event topic rail.
 *
 * The gap this closes: the pipeline stall watchdogs (green-stall-watchdog, git-sync-stall-
 * watchdog) alarmed only via `notifyAttention` — an OWNER-facing toast. If the owner isn't
 * looking, a SEVERE pipeline event (green-checkpoint not producing greens; git-sync firing but
 * not committing — code silently stranding for hours) sat unclaimed. A fleet of agents IS
 * running and any of them could green the gate / rescue the stranded work — but they never saw
 * it.
 *
 * This broadcasts the event to ALL running agents (`to:['*']`) INJECT-ONLY (no wake): every
 * agent sees it in its inbox on its NEXT turn (via the always-armed inbox rail), so someone
 * claims it — WITHOUT a storm of forced wake-ups mid-turn (owner-requested: wake=false). It is
 * the coordination-floor complement to the owner toast, not a replacement.
 *
 * Best-effort + fail-soft: a broadcast failure must NEVER break the watchdog sweep that calls it.
 */
import { createHash } from 'node:crypto';
import { sendMessage } from './agent-tools/coordination/messages';
import { wakeRecipients } from './agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { renderSevereEventEmitter, severeEventEmitter } from './severe-event-emitter';

/** The system identity severe-event broadcasts are attributed to (mirrors the
 *  hive-owner-key-health escalation identity — a workspace-level system sender). */
const SEVERE_EVENT_IDENTITY: AgentIdentity = {
  ownerId: 'system-watchdog',
  ownerLabel: 'system-watchdog',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/**
 * The ownership/routing leg (EI-10060, a follow-up to EI-9939's flap suppression):
 * ADDITIVE to the `@topic:severe-events` notice below — it never replaces it.
 * When present, a SEPARATE directed message + best-effort wake also goes to the
 * resolved responsible party, so they get a full-fidelity, expected-to-act-or-ack
 * notice instead of relying on the opt-in topic. Build via
 * `resolveSevereEventOwner()` (severe-event-owner.ts) — this module never resolves
 * ownership itself, only routes to what the caller already resolved.
 */
export interface SevereEventRoute {
  /** A coord:send audience selector ('@role:<slot>' / '@fleet-leader:<slug>') or a
   *  concrete ownerId. */
  ownerSelector: string;
  /** Human-readable — who/why, folded into the directed message's body. */
  reason: string;
}

export interface SevereEventBroadcast {
  /** One-line inbox summary — what's wrong + that it's claimable. */
  summary: string;
  /** Optional fuller body (evidence + the recommended first step). */
  body?: string;
  /** Ambient category for coord:inbox filtering (default 'severe-event'). */
  category?: string;
  /**
   * Condition-lifecycle key (WI-1444): a stable identifier for the CONDITION this
   * broadcast reports (e.g. `git-sync-stall:<install_slug>`). When the condition
   * later clears, the emitter calls broadcastSevereEventResolved with the SAME
   * key — the coord:inbox read then annotates this alarm `resolved:true`, so an
   * agent waking hours later never burns a turn investigating a dead condition.
   * Omit for one-off events with no meaningful recovery.
   */
  conditionKey?: string;
  /**
   * WI-6228: this emitter alarms ONCE per episode and stays SILENT until recovery
   * (the `if (alerted) continue; // one-shot until recovery` pattern shared by
   * origin-freshness, green-stall, git-sync-stall, gate-canary and
   * federation-join-stall). Declaring it stops the condition-staleness
   * reconciler from reading that deliberate silence as "the signal cleared".
   *
   * Why the EMITTER must declare it: `last_seen` is derived purely from alarm
   * broadcasts, so a one-shot condition's `last_seen` freezes at its first alarm
   * even while the condition is continuously observed and worsening. The
   * signal-absence guard (condition-staleness-alarm.ts guard #3) then resolves it
   * after `absenceMs` — a FALSE GREEN that is *guaranteed*, not probabilistic, for
   * any one-shot condition outlasting that window. Measured live 2026-07-26:
   * `origin-freshness:papercusp` alarmed once at 21:13:41Z during a fleet-wide git
   * egress freeze and was auto-resolved at 23:13:48Z — 120m+7s later, to the
   * second — while the outage was still live; the genuine RECOVERED broadcast did
   * not land until 23:39:42Z. Only the emitter knows whether it re-alarms; the
   * guard cannot infer it from the envelope stream.
   */
  oneShot?: boolean;
  /** Original detector evidence, retained on the condition even when attention is cooling down. */
  data?: Record<string, unknown>;
  /** EI-10060: the resolved responsible party, if any. See {@link SevereEventRoute}. */
  route?: SevereEventRoute;
  /**
   * Further responsible parties paged the same way as `route`, each with its own directed
   * message + wake (e.g. a gate holder AND its fleet leader). Delivered after `route`.
   */
  extraRoutes?: readonly SevereEventRoute[];
}

// WI-7309: the emitter stamp (type, snapshot, trailer renderer) lives in the leaf module
// ./severe-event-emitter so coord:inbox can recognise the trailer without importing this
// broadcast path. Re-exported here so existing importers are unchanged.
export {
  renderSevereEventEmitter,
  severeEventEmitter,
  type SevereEventEmitter,
} from './severe-event-emitter';

/**
 * The Mug role slot, INLINED rather than imported from placement-watchdog's
 * `MUG_COORD_SLOT` — same precedent as scout/nudge-recipient.ts: this is a comparison
 * against a wire constant, and importing that module here would drag the placement
 * watchdog into every severe-event broadcast path.
 */
const MUG_ROLE_SLOT = '@role:mug';

/**
 * WI-37625 — gate the DELIVERY, not the decision to send (D-027).
 *
 * `resolveSevereEventOwner` routes two condition classes (`health-tick-stale`,
 * `dead-routines`) at `@role:mug`. That slot is drained by exactly one consumer
 * (`pot/mug-brief-launch.ts`, at Mug spawn), so with the spawn gate closed (D-018) a
 * severe-event route lands somewhere nothing reads — the condition is still detected,
 * still broadcast to `*`, but the ROUTED "you are on the hook" leg silently dead-ends,
 * which is the exact dual failure EI-10060 existed to close.
 *
 * The fix belongs HERE and not in the registry for two measured reasons:
 *   1. `resolveSevereEventOwner` is deliberately PURE/SYNC (its doc-comment prizes this,
 *      so `@fleet-leader:` never goes stale relative to a leadership change), and the
 *      retirement flag is async — gating there would infect it with I/O.
 *   2. The Scout ladder does not fit either: `SEVERE_EVENT_IDENTITY.workspaceId` is
 *      `null` and `resolveNudgeRecipient` is workspace-scoped, so there is no workspace
 *      to resolve a live su against. `human` is the honest fallback — these two classes
 *      ("a frozen health tick blinds fleet placement", "dead routines stall placement")
 *      are owner-worthy by construction, and the module's own step 3 already says an
 *      unresolved condition should escalate toward human attention.
 *
 * When the tier is switched back ON for testing the legacy slot is preserved unchanged.
 */
async function gateMugSelector(
  route: SevereEventRoute,
): Promise<{ selector: string; reason: string }> {
  if (route.ownerSelector !== MUG_ROLE_SLOT) {
    return { selector: route.ownerSelector, reason: route.reason };
  }
  let enabled = true;
  try {
    const { mugKettleSystemEnabled } = await import('./pot/started');
    enabled = await mugKettleSystemEnabled();
  } catch {
    // Fail SAFE toward the legacy slot: if we cannot read the flag we must not silently
    // redirect a severe event to the owner (that would page a human on a flag hiccup).
    enabled = true;
  }
  if (enabled) return { selector: route.ownerSelector, reason: route.reason };
  return {
    selector: 'human',
    reason:
      `${route.reason} — the Mug tier is retired, so this routed to you instead of ` +
      `'${MUG_ROLE_SLOT}', a slot only a Mug spawn drains`,
  };
}

/**
 * Best-effort directed route: a durable message to the gated owner selector + a
 * best-effort wake of whoever that selector resolves to LIVE right now (mirrors
 * `wakeMug`'s two-halves pattern in pot/placement-watchdog.ts — a direct wake for
 * a currently-live holder, a durable send for a role slot with none yet). Never
 * throws; a routing failure must never break the underlying broadcast.
 */
async function deliverRoute(route: SevereEventRoute, summary: string, body: string | undefined): Promise<void> {
  try {
    const { selector, reason } = await gateMugSelector(route);
    const env = await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: [selector],
      summary: `[routed: ${reason}] ${summary}`,
      body,
      expectsReply: true,
    });
    if (env.to.length > 0) {
      await wakeRecipients(env.to, { summary, source: 'severe-event-broadcast' }).catch(() => {});
    }
  } catch (e) {

    console.warn(`[severe-event-broadcast] route delivery failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * WI-6554700010011878 / EI-26479741876796670: condition repeats are decided at
 * this chokepoint, so every severe-event producer gets the same transition
 * semantics. One-shot alarms stay silent for the whole episode. Level-triggered
 * alarms still refresh the durable condition timestamp, but the refresh is an
 * empty-audience heartbeat and therefore never burns an agent inbox entry.
 *
 * `oneShot` (WI-6228) means the emitter "alarms once per episode and stays silent until
 * recovery". Nothing held emitters to that. Measured 2026-10-14: 42,378 of the 56,193
 * condition-keyed rows in the 30-day coord log (75%, 747 keys) were one-shot alarms that
 * repeated the previous summary of a still-open key. ungraded-filings and rubric-staleness
 * re-sent theirs about every 2 minutes. That volume overflowed `readConditionEnvelopes`'
 * 25k-row fold window (the condition-reconciler flap on the ascending build; 90 long-open
 * one-shot conditions dropped from coord:conditions on the descending one). It also re-sent
 * every routed directed message and wake on each tick.
 *
 * A repeat is a condition alarm whose key's NEWEST envelope is an alarm (not a resolution)
 * with the SAME summary. Everything else passes through: the first alarm, an alarm after any
 * resolution (a new episode), and a changed summary (new information). The decision is pure,
 * so the durable condition log remains the source of truth across processes and restarts.
 */
export function isRepeatOfOpenConditionAlarm(
  latest: Record<string, unknown> | null,
  conditionKey: string,
  summary: string,
): boolean {
  if (!latest) return false;
  // Any resolution naming the key (singular or batched) closed the episode.
  if (typeof latest['resolves_condition'] === 'string' || Array.isArray(latest['resolves_conditions'])) {
    return false;
  }
  return latest['condition_key'] === conditionKey && latest['summary'] === summary;
}

/** Backward-compatible name for callers/tests that pin the one-shot contract. */
export function isRepeatOfOpenOneShotAlarm(
  latest: Record<string, unknown> | null,
  conditionKey: string,
  summary: string,
): boolean {
  return isRepeatOfOpenConditionAlarm(latest, conditionKey, summary);
}

/** Fail-OPEN: a read failure broadcasts, because a lost alarm costs more than a duplicate. */
async function readOpenConditionRepeat(ev: SevereEventBroadcast): Promise<boolean> {
  if (!ev.conditionKey) return false;
  try {
    const { readLatestConditionEnvelope } = await import('./agent-tools/coordination/condition-state');
    return isRepeatOfOpenConditionAlarm(
      await readLatestConditionEnvelope(ev.conditionKey),
      ev.conditionKey,
      ev.summary,
    );
  } catch (e) {
    console.warn(`[severe-event-broadcast] condition repeat check failed, broadcasting (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Refresh a level-triggered condition without delivering another agent-facing
 * message. `coord:conditions` folds this marker into `last_seen`, while the
 * empty recipient list keeps it out of every inbox. One-shot emitters do not
 * need this marker: their silence is itself part of the one-shot contract.
 */
async function recordConditionHeartbeat(
  ev: SevereEventBroadcast,
  emitter: ReturnType<typeof severeEventEmitter>,
  body: string,
): Promise<void> {
  if (!ev.conditionKey || ev.oneShot) return;
  await sendMessage(SEVERE_EVENT_IDENTITY, {
    to: [],
    summary: ev.summary,
    body,
    category: ev.category ?? 'severe-event',
    extra: {
      emitter,
      condition_key: ev.conditionKey,
      condition_heartbeat: true,
    },
  });
}

/**
 * Publish a SEVERE pipeline event to subscribers of the stable severe-events topic, inject-only
 * (no wake). It remains queryable by that audience even when it has no current subscribers.
 * Never throws. A repeated condition summary is
 * not re-sent. One-shot alarms stay silent; level-triggered alarms append a durable, empty-
 * audience heartbeat so `coord:conditions.last_seen` remains fresh.
 */
export async function broadcastSevereEvent(ev: SevereEventBroadcast): Promise<boolean> {
  try {
    // WI-7309: emitter identity is stamped UNCONDITIONALLY — an alarm whose emitter is
    // unknown is an alarm nobody can attribute, and attribution is the expensive part.
    const emitter = severeEventEmitter();
    const body = `${ev.body ?? ''}${renderSevereEventEmitter(emitter)}`;
    if (await readOpenConditionRepeat(ev)) {
      await recordConditionHeartbeat(ev, emitter, body);
      return true;
    }
    // No `wake` option ⇒ plain inject: lands in severe-events subscribers' inboxes for their
    // next turn, without a forced re-invoke storm. The original selector remains in audience
    // history even when no subscribers resolve; coord:conditions reads the shared log.
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['@topic:severe-events'],
      summary: ev.summary,
      body,
      category: ev.category ?? 'severe-event',
      extra: {
        emitter,
        ...(ev.data ? { data: ev.data } : {}),
        ...(ev.conditionKey
          ? {
              condition_key: ev.conditionKey,
              // WI-6228: carried on the envelope so the condition fold can mark the
              // state one_shot without any per-family knowledge.
              ...(ev.oneShot ? { one_shot: true } : {}),
            }
          : {}),
      },
    });
    if (ev.route) await deliverRoute(ev.route, ev.summary, body);
    for (const extra of ev.extraRoutes ?? []) await deliverRoute(extra, ev.summary, body);
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface SevereEventResolution {
  /** The original alarm envelope identity, for atomic concurrent recovery of that episode. */
  alarmMessageId?: string;
  /** The SAME conditionKey the original broadcastSevereEvent carried. */
  conditionKey: string;
  /** One-line all-clear (e.g. "git-sync RECOVERED on papercusp — commits landing again."). */
  summary: string;
  /** Optional detail (what recovered it / evidence). */
  body?: string;
}

/**
 * Publish that a previously-alarmed severe condition has CLEARED (WI-1444). Every prior
 * alarm carrying the same `condition_key` is annotated `resolved:true` at coord:inbox read
 * time, including historical alarms whose audience differs from current topic subscribers.
 * Inject-only, same topic as the alarm. Never throws.
 */
export async function broadcastSevereEventResolved(res: SevereEventResolution): Promise<boolean> {
  try {
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      ...(res.alarmMessageId ? { msgId: `condition-resolution-${createHash('sha256')
        .update(JSON.stringify([res.conditionKey, res.alarmMessageId])).digest('hex')}` } : {}),
      to: ['@topic:severe-events'],
      summary: res.summary,
      body: res.body,
      category: 'severe-event-resolved',
      extra: { resolves_condition: res.conditionKey, condition_key: res.conditionKey },
    });
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] resolve failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface SevereEventResolutionMany {
  /** The conditionKeys of EVERY alarm this ONE message supersedes. */
  conditionKeys: string[];
  /** One-line all-clear covering all of them (e.g. "git-sync RECOVERED on 6 harnesses …"). */
  summary: string;
  /** Optional detail. */
  body?: string;
}

/**
 * Publish that SEVERAL previously-alarmed conditions have cleared in ONE message
 * (EI-9030b) — instead of one recovery notice per condition. Carries
 * `resolves_conditions` (plural array); coord:inbox's
 * `annotateResolvedConditions` supersedes every listed condition's prior alarm.
 * A single key stays byte-equivalent to `broadcastSevereEventResolved` for readers
 * that key on the singular field (both `resolves_condition` + the plural are stamped).
 * Inject-only, same topic as the alarm. Never throws; a 0-key call is a no-op.
 */
export async function broadcastSevereEventResolvedMany(res: SevereEventResolutionMany): Promise<boolean> {
  if (res.conditionKeys.length === 0) return true;
  try {
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['@topic:severe-events'],
      summary: res.summary,
      body: res.body,
      category: 'severe-event-resolved',
      extra: {
        resolves_conditions: res.conditionKeys,
        // Stamp the singular fields too (first key) so a reader that only knows the
        // singular shape still supersedes at least the primary condition.
        resolves_condition: res.conditionKeys[0],
        condition_key: res.conditionKeys[0],
      },
    });
    return true;
  } catch (e) {

    console.warn(`[severe-event-broadcast] resolve-many failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
