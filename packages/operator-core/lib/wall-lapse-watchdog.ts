/**
 * wall-lapse-watchdog.ts — the OWNER-WALL TTL-lapse pager
 * (owner-wall-ttl-lapse-hardening-2026-07-26, EI-18669544162414270).
 *
 * The motivating gap: `WI-4723` (a critical, still-unremediated public-credential
 * exposure) carried a closing instruction — "still LIVE = NOT rotated, do NOT
 * close this item on the strength of clean scans" — anchored to a standing fact
 * asserted with the ORDINARY 7-day default TTL. The fact lapsed silently on
 * 2026-07-20 while the exposure stood; a successor reading it after that date
 * would see "no fact" and could easily misread that as "resolved" — a critical
 * safety signal that decayed to the SAFE-LOOKING state with nobody told.
 *
 * `facts:assert { slot:'wall' }` (agent-tools/facts/assert.ts) keys the fact under
 * `wall:` and defaults its TTL to 90d. Expiry requests review; the current
 * unretracted wall stays folded and retained until explicit retraction or
 * supersession. This module is the READ-side escalation when the review deadline
 * passes without a re-assert or explicit retract — TTL lapse must be LOUD, never
 * silent. Same chassis as the sibling watchdogs
 * (rubric-staleness-watchdog.ts, release-deploy-staleness): a PURE alert
 * formatter (unit-tested with no DB), a thin PG sweep wired into the shared
 * routinesTick as one durable step, fail-soft throughout, and the shared
 * fires-ledger debounce (one page per wall per window, not one per tick).
 */
import { listLapsedWallFacts, type LapsedWallFact } from './agent-facts/store';
import { recentWatchdogFires, recordFire } from './pot/watchdog';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { resolveAlarm, type AlarmAttentionDeps } from './alarm-attention';
import { broadcastSevereEvent } from './severe-event-broadcast';

const CONDITION_PREFIX = 'alarm:wall-lapse:';
type WallIdentity = Pick<LapsedWallFact, 'workspaceId' | 'scope' | 'scopeRef' | 'key' | 'sourceHive'>;
function wallConditionKey(fact: WallIdentity): string {
  return CONDITION_PREFIX + encodeURIComponent(JSON.stringify([
    fact.workspaceId, fact.scope, fact.scopeRef ?? '', fact.key, fact.sourceHive ?? '',
  ]));
}

async function readOpenWallConditionKeys(): Promise<string[]> {
  const { computeConditionStates, readConditionEnvelopes } = await import('./agent-tools/coordination/tools/conditions');
  return computeConditionStates(await readConditionEnvelopes())
    .filter((condition) => condition.open && condition.condition_key.startsWith(CONDITION_PREFIX))
    .map((condition) => condition.condition_key);
}

/** Re-page on the same still-lapsed wall at most once per this many hours. */
const WALL_LAPSE_DEBOUNCE_HOURS = 24;

/** Fallback installSlug for a wall fact not scoped to a concrete harness
 *  (workspace/role/owner/work_item scope) — matches the sibling watchdogs'
 *  own single-install default (this platform has one install today). */
const DEFAULT_INSTALL_SLUG = 'papercusp';

// ── pure formatter (unit-tested without DB) ─────────────────────────────────

/**
 * PURE: build the escalation summary + body for one lapsed wall fact. Kept
 * separate from the PG sweep so the wording is testable without a database.
 */
export function formatWallLapseAlert(
  fact: Pick<LapsedWallFact, 'scope' | 'scopeRef' | 'key' | 'body' | 'createdBy' | 'expiresAt'>,
  now: number,
): { summary: string; body: string } {
  const lapsedDays = Math.max(0, Math.round((now - Date.parse(fact.expiresAt)) / 86_400_000));
  const scopeLabel = fact.scopeRef ? `${fact.scope}:${fact.scopeRef}` : fact.scope;
  return {
    summary: `Owner-gated wall fact '${fact.key}' LAPSED ${lapsedDays}d ago, unretracted — its absence must NOT be read as resolved`,
    body:
      `[${scopeLabel}] ${fact.body}\n\n` +
      `This fact was asserted as a WALL (slot:'wall') — an owner-gated blocker — and its TTL expired ` +
      `${fact.expiresAt} without ever being explicitly retracted. TTL decay always fails toward "clear", ` +
      `which is the wrong direction for an unremediated risk: do NOT infer the underlying condition resolved ` +
      `just because this fact stopped folding into orients/briefs.\n\n` +
      `Either the condition is STILL LIVE — re-assert it (facts:assert { slot:'wall', key:'${fact.key}', body:'...' }, ` +
      `TTL defaults to 90d) — or it genuinely resolved, in which case retract it explicitly (facts:retract) rather ` +
      `than letting it time out. Originally asserted by ${fact.createdBy}.`,
  };
}

// ── the PG sweep ─────────────────────────────────────────────────────────────

export interface WallLapseSweepResult {
  key: string;
  outcome: 'alerted' | 'debounced' | 'error';
  reason: string;
}

/** Synthetic identity for the background lapse escalation (mirrors the
 *  sibling watchdogs' wedge/staleness identities). */
const WALL_LAPSE_IDENTITY: AgentIdentity = {
  ownerId: 'wall-lapse-watchdog',
  ownerLabel: 'system · wall-lapse-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Injectable seams so the sweep's orchestration is testable without PG. */
export interface WallLapseSweepDeps {
  listLapsedWallFacts?: typeof listLapsedWallFacts;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  rail?: AlarmAttentionDeps;
  readOpenConditionKeys?: () => Promise<string[]>;
  now?: number;
}

/**
 * The wall-lapse sweep: every unretracted, TTL-expired `wall:` fact fires one
 * debounced (24h) alert — a `pot_watchdog_fires` row (source 'wall-fact-lapse',
 * scoped by the fact's own key so N simultaneously-lapsed walls each page
 * independently, mirroring the rubric-staleness per-rubric fix) plus a coord
 * escalation naming the fact, how long it's been lapsed, and how to re-assert
 * or retract it. Fail-soft per fact AND overall — a watchdog that throws
 * guards nothing.
 */
export async function wallLapseSweep(deps: WallLapseSweepDeps = {}): Promise<WallLapseSweepResult[]> {
  const now = deps.now ?? Date.now();
  const results: WallLapseSweepResult[] = [];
  let facts: LapsedWallFact[];
  try {
    facts = await (deps.listLapsedWallFacts ?? listLapsedWallFacts)();
  } catch (e) {
    return [{ key: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) }];
  }
  const keys = new Set(facts.map(wallConditionKey));
  // Conditions ALREADY open. `null` = the read failed, so nothing is known to be open and every
  // lapsed wall is broadcast (fail LOUD — a missed page is the failure this module exists for).
  let alreadyOpen: ReadonlySet<string> | null = null;
  try {
    const open = await (deps.readOpenConditionKeys ?? readOpenWallConditionKeys)();
    alreadyOpen = new Set(open);
    for (const key of open) keys.add(key);
  } catch (e) {
    console.warn(`[wall-fact-lapse] condition read failed (non-fatal): ${String(e)}`);
  }
  for (const fact of facts) {
    try {
      const workspaceId = fact.workspaceId || 'default';
      const installSlug = fact.scope === 'harness' && fact.scopeRef ? fact.scopeRef : DEFAULT_INSTALL_SLUG;
      const { summary, body } = formatWallLapseAlert(fact, now);
      // ONE broadcast per episode (WI-6554700010008923). The event is declared `oneShot`, which
      // promises the condition fold that the emitter alarms ONCE and stays silent until recovery —
      // so an already-open condition needs no re-broadcast to stay open. Before this gate the
      // broadcast ran on EVERY routines tick, ahead of the 24h debounce below, to `*`: measured
      // 2026-10-12 14:00–14:25Z, 836 broadcasts for 76 walls (~2 MB of coord log), every one
      // re-injected into every live agent's next tool result as a `[coord+N]` block.
      const conditionKey = wallConditionKey(fact);
      if (!alreadyOpen?.has(conditionKey)) {
        try {
          const event = { conditionKey, summary, body, oneShot: true };
          if (deps.rail?.broadcast) await deps.rail.broadcast(event);
          else await broadcastSevereEvent(event);
        } catch (e) {
          console.warn(`[wall-fact-lapse] condition broadcast failed (non-fatal): ${String(e)}`);
        }
      }
      const firedRecently =
        (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
          workspaceId,
          installSlug,
          WALL_LAPSE_DEBOUNCE_HOURS,
          'wall-fact-lapse',
          fact.key,
        )) > 0;
      if (firedRecently) {
        results.push({ key: fact.key, outcome: 'debounced', reason: 'fires-ledger debounce' });
        continue;
      }
      console.warn(`[wall-fact-lapse] ALERT: ${summary}`);
      await (deps.recordFire ?? recordFire)({
        workspaceId,
        installSlug,
        source: 'wall-fact-lapse',
        reason: summary,
        wakeAt: null,
      });
      await (deps.openEscalation ?? openEscalation)(WALL_LAPSE_IDENTITY, {
        severity: 'blocker',
        summary,
        body,
      });
      results.push({ key: fact.key, outcome: 'alerted', reason: summary });
    } catch (e) {
      results.push({ key: fact.key, outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  // Read exact CURRENT fact identities, including explicit retractions and
  // reassertions, after opening. A bounded candidate scan's absence cannot clear
  // an episode, and the durable condition fold survives an operator restart.
  const recoveryFor: WallIdentity[] = [];
  for (const key of keys) {
    if (!key.startsWith(CONDITION_PREFIX)) continue;
    try {
      const identity: unknown = JSON.parse(decodeURIComponent(key.slice(CONDITION_PREFIX.length)));
      if (!Array.isArray(identity) || identity.length !== 5 || !identity.every((part) => typeof part === 'string')) continue;
      const [workspaceId, scope, scopeRef, factKey, sourceHive] = identity;
      if (!['workspace', 'role', 'owner', 'harness', 'work_item'].includes(scope) || !factKey.startsWith('wall:')) continue;
      recoveryFor.push({ workspaceId, scope: scope as LapsedWallFact['scope'], scopeRef, key: factKey, sourceHive });
    } catch { /* Unknown key format supplies no recovery evidence. */ }
  }
  if (recoveryFor.length > 0) {
    try {
      const measured = await (deps.listLapsedWallFacts ?? listLapsedWallFacts)({ recoveryFor });
      for (const fact of measured) {
        if (fact.recovered === true && keys.has(wallConditionKey(fact))) {
          await resolveAlarm(wallConditionKey(fact), 'wall-lapse-watchdog', deps.rail);
        }
      }
    } catch (e) {
      console.warn(`[wall-fact-lapse] recovery read failed (non-fatal): ${String(e)}`);
    }
  }
  return results;
}
