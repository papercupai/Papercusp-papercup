/**
 * mcp-dark-watchdog — the safety net (Layer 4) for the "tool-less session after a deploy" class.
 *
 * THE GAP: a :3070 (papercup-dev-api) restart on every deploy drops each agent's long-lived
 * HTTP-MCP socket. Layers 1–3 make reconnection automatic (permanent signed URLs · name-sticky
 * approval · the always-up :9071 proxy fronting :3070). But if a client STILL fails to re-attach,
 * an agent can silently work on with NO `mcp__papercusp*` tools — a "dark" session — burning a
 * whole run tool-less with nobody noticing. This watches for exactly that and raises it.
 *
 * THE SIGNAL (why this is robust, not a guess): the two heartbeats a spawned bee carries have
 * DIFFERENT couplings —
 *   • coord_presence.heartbeat_at is shared dispatch/keepalive telemetry, not agent-tool-list
 *     proof. Hook-origin calls and the psu supervisor's 60s keepalive can refresh it while the
 *     agent-facing catalog is empty. The interactive sweep checks assistant turns since the
 *     last agent-origin invocation as an independent signal.
 *   • spawned_agents.heartbeat_at is the SUPERVISOR beat — written out-of-band by the nursery/
 *     bg-host (a SEPARATE process from :3070 that a deploy does NOT restart), every ~60s while it
 *     holds the child. A dark MCP ⇒ it stays FRESH (the process is alive).
 *   • spawned_agents.last_output_at is the child's stdout — FRESH ⇒ the bee is actively generating
 *     RIGHT NOW (a live turn that NEEDS its tools), not idle/parked.
 * So a running bee that is (a) alive (supervisor fresh), (b) actively generating output, yet (c)
 * has made ZERO successful MCP calls since the operator came back up (presence heartbeat predates
 * the restart), after (d) a grace window for the client's own reconnect — is working DARK. Very low
 * false-positive: the only benign match is a bee doing ONLY local tools (Read/Edit/Bash) for the
 * whole grace window post-restart, and the response is a claimable inbox nudge, not a page.
 *
 * Process-level (NOT a DBOS routine) for the same reason as the git-sync/green stall watchdogs: a
 * routine-based watchdog queues on the very engine a wedge would freeze.
 *
 * restartAt = this watchdog's own start time. It starts at operator boot, so "presence heartbeat
 * older than restartAt" == "no successful MCP call landed since :3070 came back". No restart-event
 * table needed.
 *
 * On alarm (per newly-dark owner, cross-process exactly-once via an INSERT…ON CONFLICT DO NOTHING
 * claim on harness_escalations): a consolidated owner `notifyAttention` + a fleet BROADCAST
 * (severe-event-broadcast — reaches the HEALTHY agents + the Queen, who can relaunch the dark bee;
 * the dark bee itself can't read its own inbox, which is the whole point). Recovery (the bee
 * reconnects — presence advances past restartAt — or exits) clears its escalation row idempotently.
 *
 * Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
 */
import os from 'node:os';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent } from '../severe-event-broadcast';
import { agentToolInvocationPredicate } from '../agent-tools/sessions/automatic-tool-names';
import type { PsuPtyHost } from '../events/await/psu-pty-discovery';
import type { RespawnLaunchSpec } from '../carry-respawn';

/** Supervisor beat is ~60s; fresh within 3× ⇒ the process is alive. */
const DEFAULT_SUPERVISOR_FRESH_MS = 3 * 60_000; // 3 min
/** Child stdout within this window ⇒ the bee is actively generating (a live turn that needs tools). */
const DEFAULT_WORKING_MS = 5 * 60_000; // 5 min
/** Grace after the restart for the client's OWN reconnect before we alarm. */
const DEFAULT_GRACE_MS = 5 * 60_000; // 5 min
/** How often the watchdog sweeps. Prompt enough to catch a dark run early, not spammy. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60_000; // 5 min

/** The per-owner harness_escalations phase prefix — one transient row per dark bee. */
const PHASE_PREFIX = 'mcp-dark:';

export interface McpDarkThresholds {
  supervisorFreshMs?: number;
  workingMs?: number;
  graceMs?: number;
}

/** The per-bee snapshot the verdict is computed from (all epoch ms; null = absent). */
export interface McpDarkSnapshot {
  ownerId: string;
  /** spawned_agents.started_at — the bee must predate the restart to be "should-have-reconnected". */
  startedMs: number | null;
  /** spawned_agents.heartbeat_at — the deploy-surviving supervisor beat (process-alive). */
  supervisorHeartbeatMs: number | null;
  /** spawned_agents.last_output_at — child stdout (actively-generating). */
  lastOutputMs: number | null;
  /** Shared presence beat; hook dispatch and psu supervisor keepalives may refresh it. */
  presenceHeartbeatMs: number | null;
}

export interface McpDarkVerdict {
  dark: boolean;
  /** Human reason for the alarm body, or null when not dark. */
  reason: string | null;
}

const mins = (ms: number): number => Math.round(ms / 60_000);

/**
 * Pure: is this running bee working with a DARK MCP binding? All five gates must hold (see the
 * module header for the full rationale). Exported for unit testing; the DB wiring is in
 * checkMcpDark.
 */
export function evaluateMcpDark(
  s: McpDarkSnapshot,
  restartAtMs: number,
  nowMs: number,
  opts: McpDarkThresholds = {},
): McpDarkVerdict {
  const supervisorFreshMs = opts.supervisorFreshMs ?? DEFAULT_SUPERVISOR_FRESH_MS;
  const workingMs = opts.workingMs ?? DEFAULT_WORKING_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  // (e) grace: give the client's own reconnect time to land before we alarm.
  if (nowMs - restartAtMs <= graceMs) return { dark: false, reason: null };
  // (a) existed before the restart ⇒ it SHOULD have reconnected (a bee spawned after is just booting).
  if (s.startedMs == null || s.startedMs >= restartAtMs) return { dark: false, reason: null };
  // (b) process alive: the deploy-surviving supervisor beat is fresh.
  const alive = s.supervisorHeartbeatMs != null && nowMs - s.supervisorHeartbeatMs < supervisorFreshMs;
  if (!alive) return { dark: false, reason: null };
  // (c) actively generating output right now (a live turn that needs its tools — not idle/parked).
  const working = s.lastOutputMs != null && nowMs - s.lastOutputMs < workingMs;
  if (!working) return { dark: false, reason: null };
  // (d) NO presence update since the restart. This shared beat can also be refreshed
  // by hooks or a psu supervisor keepalive without proving the client received tools/list.
  const reconnected = s.presenceHeartbeatMs != null && s.presenceHeartbeatMs >= restartAtMs;
  if (reconnected) return { dark: false, reason: null };

  const lastMcp =
    s.presenceHeartbeatMs == null
      ? 'never (no coord_presence row)'
      : `~${mins(nowMs - s.presenceHeartbeatMs)}m ago, before the restart`;
  return {
    dark: true,
    reason:
      `alive (supervisor beat ~${mins(nowMs - s.supervisorHeartbeatMs!)}m) and generating output ` +
      `(~${mins(nowMs - s.lastOutputMs!)}m ago), but its last MCP tool call was ${lastMcp} — it has ` +
      `NOT re-attached its papercusp MCP since :3070 restarted ~${mins(nowMs - restartAtMs)}m ago, so ` +
      `it is working tool-less (dark).`,
  };
}

/** Pure: the harness_escalations body for one dark bee (testable). */
export function mcpDarkEscalationBody(opts: {
  ownerId: string;
  reason: string;
  restartAtMs: number;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: 'mcp-dark-watchdog',
    owner_id: opts.ownerId,
    boot_at: opts.restartAtMs,
    emitted_at: opts.nowMs,
    detail:
      `Agent ${opts.ownerId} is working with a DARK papercusp MCP binding: ${opts.reason} ` +
      `Layers 1–3 (permanent signed URLs · name-sticky approval · the :9071 proxy) should auto-heal ` +
      `this; if it persists, RELAUNCH the bee (its fresh process re-mints + re-approves a clean MCP ` +
      `config). It cannot read its own inbox (that needs MCP), so this must be actioned by a peer/owner.`,
  });
}

export interface McpDarkWatchdogResult {
  darkOwners: string[];
  /** Owners this pass NEWLY claimed (fired an alarm for) — cross-process exactly-once. */
  alarmed: string[];
  recovered: string[];
}

/**
 * One watchdog pass: scan every running/restarting spawned bee, join its shared presence
 * beat, evaluate darkness, claim each newly-dark owner exactly once (INSERT…ON CONFLICT DO NOTHING),
 * fire a consolidated owner notify + fleet broadcast for the claimed set, and clear the escalation
 * of any owner that has recovered (reconnected or exited). Never throws.
 */
export async function checkMcpDark(
  sql: Sql,
  restartAtMs: number,
  opts: McpDarkThresholds = {},
): Promise<McpDarkWatchdogResult> {
  const out: McpDarkWatchdogResult = { darkOwners: [], alarmed: [], recovered: [] };
  try {
    const rows = await sql<
      {
        owner_id: string;
        harness_slug: string | null;
        workspace_id: string | null;
        presence_label: string | null;
        started_ms: string | number | null;
        supervisor_heartbeat_ms: string | number | null;
        last_output_ms: string | number | null;
        presence_heartbeat_ms: string | number | null;
      }[]
    >`
      SELECT sa.session_owner AS owner_id,
             sa.harness_slug,
             sa.workspace_id,
             cp.owner_label AS presence_label,
             extract(epoch from sa.started_at) * 1000     AS started_ms,
             extract(epoch from sa.heartbeat_at) * 1000   AS supervisor_heartbeat_ms,
             extract(epoch from sa.last_output_at) * 1000 AS last_output_ms,
             extract(epoch from cp.heartbeat_at) * 1000   AS presence_heartbeat_ms
        FROM harness_shared.spawned_agents sa
        LEFT JOIN harness_shared.coord_presence cp
               ON cp.owner_id = sa.session_owner
       WHERE sa.status IN ('running', 'restarting')
         AND sa.session_owner IS NOT NULL`;

    const now = Date.now();
    const num = (v: string | number | null): number | null => (v != null ? Number(v) : null);

    const dark: Array<{
      ownerId: string;
      harnessSlug: string;
      workspaceId: string | null;
      reason: string;
    }> = [];
    for (const row of rows) {
      const verdict = evaluateMcpDark(
        {
          ownerId: row.owner_id,
          startedMs: num(row.started_ms),
          supervisorHeartbeatMs: num(row.supervisor_heartbeat_ms),
          lastOutputMs: num(row.last_output_ms),
          presenceHeartbeatMs: num(row.presence_heartbeat_ms),
        },
        restartAtMs,
        now,
        opts,
      );
      if (verdict.dark && verdict.reason) {
        dark.push({
          ownerId: row.owner_id,
          harnessSlug: row.harness_slug ?? 'unknown',
          workspaceId: row.workspace_id,
          reason: verdict.reason,
        });
      }
    }
    out.darkOwners = dark.map((d) => d.ownerId);

    // ── Claim each newly-dark owner exactly once (cross-process safe). ──
    const newly: typeof dark = [];
    for (const d of dark) {
      const claimed = await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${d.harnessSlug}, ${PHASE_PREFIX + d.ownerId}, ${mcpDarkEscalationBody({
          ownerId: d.ownerId,
          reason: d.reason,
          restartAtMs,
          nowMs: now,
        })}, ${now}, ${d.workspaceId})
        ON CONFLICT (harness_slug, phase) DO NOTHING
        RETURNING phase`;
      if (claimed.length === 1) newly.push(d);
    }

    if (newly.length > 0) {
      out.alarmed = newly.map((d) => d.ownerId);
      const list = newly.map((d) => d.ownerId).join(', ');
      const summary = `${newly.length} agent(s) working MCP-DARK after a :3070 restart — tool-less, need a reconnect/relaunch: ${list}.`;
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: `${newly.length} agent(s) working MCP-dark (tool-less) after a restart`,
          body:
            `${summary}\n\n${newly[0].reason}\n\nLayers 1–3 should auto-heal this; if it persists, ` +
            `relaunch the bee(s). They can't read their own inbox (needs MCP), so a peer/owner must act.`,
          importance: 'high',
          workspaceId: newly[0].workspaceId ?? undefined,
          data: { darkOwners: newly.map((d) => d.ownerId) },
        });
      } catch (e) {
        console.warn(`[mcp-dark-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      // Fleet broadcast: inject-only (wake=false). Reaches the HEALTHY agents + the Queen (the dark
      // bee itself can't — its inbox read needs MCP), so someone relaunches it.
      await broadcastSevereEvent({
        summary,
        body:
          `These agents are alive + actively generating output but have NOT re-attached their papercusp ` +
          `MCP since :3070 last restarted, so they're burning a run tool-less. Claim it: relaunch the ` +
          `listed bee(s) (a fresh process re-mints + re-approves a clean MCP config). Owners: ${list}.`,
        category: 'severe-event',
      });
      console.warn(`[mcp-dark-watchdog] ALARM: ${list}`);
    }

    // ── Recovery: clear the escalation of any previously-dark owner no longer dark. ──
    const alertedRows = await sql<{ phase: string }[]>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE phase LIKE ${PHASE_PREFIX + '%'} AND escalation IS NOT NULL`;
    const darkPhases = new Set(dark.map((d) => PHASE_PREFIX + d.ownerId));
    const toRecover = alertedRows.map((r) => r.phase).filter((p) => !darkPhases.has(p));
    if (toRecover.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE phase = ANY(${toRecover}) AND escalation IS NOT NULL`;
      out.recovered = toRecover.map((p) => p.slice(PHASE_PREFIX.length));
    }
    return out;
  } catch (e) {
    console.warn(`[mcp-dark-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

// ═══ Interactive-session transport-death sweep + heal ladder ═══════════════════
// (mcp-transport-resilience P-005, 2026-07-13 — owner directive: "I'd
// rather just have /mcp inject — that's better than having my session suddenly
// die on me"; kill+resume is acceptable for HEADLESS sessions only.)
//
// The bee sweep above structurally cannot see the class that produced the
// su-39f07 incident (a 5h-dark INTERACTIVE session): (1) interactive psu
// sessions have no spawned_agents row; (2) its darkness test is pinned to
// restartAt = OPERATOR boot, but a CLIENT-side transport death (a Claude Code
// self-re-exec: auto-update relaunch / TUI fullscreen switch) happens hours
// later with presence ≥ restartAt; (3) its actively-generating gate never
// matches a headed session idling at its prompt between loop wakes.
//
// THE SIGNAL here is the same two-heartbeat decoupling, re-based per session:
// the psu-pty host discovery file is the process-alive beat (FS, transport-
// independent), while coord_presence.heartbeat_at can be refreshed by hook
// dispatches or the psu supervisor's 60s keepalive, even if the client never
// receives tools/list. The sweep therefore also counts assistant turns since
// the last agent-origin invocation. An ARMED LOOP (harness_shared.routines
// loop-<owner>, active) makes the expected MCP cadence known (≈ its interval),
// so staleness is judged against it; without a loop, fresh pty activity + a
// long-stale presence beat is the weaker signal.
//
// THE HEAL preserves headed sessions in place: inject mode:'mcp-reconnect' into
// the session's own pty host (the /mcp dialog macro, psu-pty-host P-003) when
// that host advertises forced reconnect support. Headless hosts, and older
// headed hosts without that capability, use carry-respawn when available. It
// replaces only the CLI child inside the existing host; the host gates it on
// terminal idle, cleared owner input, and a completed agent turn. Both paths
// are rate-capped and judged ONLY by transport truth (the
// presence beat advancing on a later pass, never the socket write); an old or
// incapable host falls back to a mode-specific notification. On confirmed
// recovery, ONE follow-up wake tells the agent to re-arm lost awaits and
// re-park state.

/** Distinct escalation prefix — 'mcp-dark:%' (bee) does NOT match this, so the
 *  bee pass's recovery sweep never clears interactive claims (and vice versa). */
const INTERACTIVE_PHASE_PREFIX = 'mcp-dark-int:';

/** Heal attempts per owner per rolling hour before falling back to notify. */
const DEFAULT_HEAL_MAX_ATTEMPTS = 2;
const HEAL_ATTEMPT_WINDOW_MS = 60 * 60_000;
/** Fleet-wide reconnect-storm guard. Mirrors cluster-fork's proven rolling
 * maxRespawns shape: a full window defers, then automatically drains. */
const DEFAULT_SHARED_HEAL_MAX_ATTEMPTS = 4;
const DEFAULT_SHARED_HEAL_WINDOW_MS = 10 * 60_000;
/** Small owner-stable spread so the admitted reconnects do not re-handshake in
 * lockstep. Detection is already minutes past the server's Retry-After: 2s. */
const DEFAULT_HEAL_JITTER_MAX_MS = 2_000;
/** Ignore hosts younger than this — a fresh session hasn't tool-called yet. */
const DEFAULT_INTERACTIVE_GRACE_MS = 10 * 60_000;
/** No-loop clause: pty activity fresher than this counts as "session in use". */
const DEFAULT_PTY_FRESH_MS = 10 * 60_000;
/** No-loop clause: presence beat staler than this while the pty is in use. */
const DEFAULT_NO_LOOP_STALE_MS = 30 * 60_000;
/** Repeated assistant turns with no agent-origin MCP call indicate a missing client tool catalog. */
const DEFAULT_TOOLLESS_ASSISTANT_TURN_THRESHOLD = 3;
/** Armed-loop clause floor (beats 3× a short loop interval). */
const DEFAULT_LOOP_STALE_FLOOR_MS = 20 * 60_000;
/** Positive-evidence recovery: an agent-origin invocation this fresh means
 *  Papercusp tools are demonstrably flowing NOW (2026-07-14 false-heal fix —
 *  recovery is never inferred from ¬dark). */
const RECOVERED_FRESH_MS = 5 * 60_000;
/** Conservative carry budget when the live served model window is unavailable. */
const FALLBACK_RECOVERY_WINDOW_TOKENS = 200_000;

type RecoverySpec = Pick<RespawnLaunchSpec, 'firstPrompt' | 'systemPromptAddendum'>;
type BuildRecoverySpec = (ownerId: string) => Promise<RecoverySpec | null>;

export interface InteractiveDarkSnapshot {
  ownerId: string;
  /** psu-pty discovery file: host start + freshest pty stream activity (epoch ms). */
  hostStartedMs: number | null;
  hostLastActivityMs: number | null;
  /** Shared heartbeat; hook dispatch and psu supervisor keepalives may keep it fresh (epoch ms). */
  presenceHeartbeatMs: number | null;
  /** An ACTIVE loop routine (harness_shared.routines loop-<owner>) + its interval. */
  loopActive: boolean;
  loopIntervalSec: number | null;
  /** Indexed assistant turns since the current host started or its last agent-origin MCP call. */
  assistantTurnsSinceLastAgentCall?: number;
  /** Timestamp of the latest indexed assistant turn in that no-agent-call streak. */
  lastAssistantTurnMs?: number | null;
}

export interface InteractiveDarkThresholds {
  graceMs?: number;
  ptyFreshMs?: number;
  noLoopStaleMs?: number;
  loopStaleFloorMs?: number;
  assistantTurnsWithoutAgentMcp?: number;
}

/**
 * Pure: is this live interactive session's MCP transport dead? NOT pinned to any
 * restart — the staleness is judged against the session's own expected cadence.
 * Exported for unit testing; the FS/DB wiring is in checkInteractiveMcpDark.
 */
export function evaluateInteractiveMcpDark(
  s: InteractiveDarkSnapshot,
  nowMs: number,
  opts: InteractiveDarkThresholds = {},
): McpDarkVerdict {
  const graceMs = opts.graceMs ?? DEFAULT_INTERACTIVE_GRACE_MS;
  const ptyFreshMs = opts.ptyFreshMs ?? DEFAULT_PTY_FRESH_MS;
  const noLoopStaleMs = opts.noLoopStaleMs ?? DEFAULT_NO_LOOP_STALE_MS;
  const loopStaleFloorMs = opts.loopStaleFloorMs ?? DEFAULT_LOOP_STALE_FLOOR_MS;

  // Host too young (or unknown age): the session may simply not have tool-called yet.
  if (s.hostStartedMs == null || nowMs - s.hostStartedMs < graceMs) return { dark: false, reason: null };
  // A missing coord_presence beat is non-actionable by itself: the session may
  // never have used Papercusp tools, or its row may have expired. Hook activity
  // with zero agent-origin calls does not resolve that ambiguity; the same gap
  // fits an idle or parked client, so it cannot upgrade the session to dark or
  // trigger an automatic /mcp heal. Only the live cadence evidence below is
  // actionable.
  if (s.presenceHeartbeatMs == null) return { dark: false, reason: null };
  // A projected hook call can keep the shared presence beat fresh even while
  // this client's tools/list never arrived. Require multiple indexed assistant
  // turns after the last agent-origin MCP call, and a recent final turn, before
  // treating that mismatch as actionable.
  const assistantTurnsWithoutAgentMcp = s.assistantTurnsSinceLastAgentCall ?? 0;
  const lastAssistantTurnAgeMs = s.lastAssistantTurnMs == null ? null : nowMs - s.lastAssistantTurnMs;
  if (
    assistantTurnsWithoutAgentMcp >=
      (opts.assistantTurnsWithoutAgentMcp ?? DEFAULT_TOOLLESS_ASSISTANT_TURN_THRESHOLD) &&
    lastAssistantTurnAgeMs != null &&
    lastAssistantTurnAgeMs >= 0 &&
    lastAssistantTurnAgeMs < ptyFreshMs
  ) {
    return {
      dark: true,
      reason:
        'interactive session completed ' +
        assistantTurnsWithoutAgentMcp +
        ' assistant turns without an agent-origin Papercusp tool call (latest ~' +
        mins(lastAssistantTurnAgeMs) +
        'm ago) while its pty host is live; supervisor keepalives and hook-origin dispatches can refresh the shared ' +
        'presence beat without restoring the client tool catalog.',
    };
  }
  const staleMs = nowMs - s.presenceHeartbeatMs;

  if (s.loopActive) {
    // An armed loop pins the expected MCP cadence: every wake makes tool calls,
    // so a beat older than 3 intervals (floored) is a dead transport, not idleness.
    const intervalMs = Math.max(1, s.loopIntervalSec ?? 600) * 1000;
    const threshold = Math.max(3 * intervalMs, loopStaleFloorMs);
    if (staleMs <= threshold) return { dark: false, reason: null };
    return {
      dark: true,
      reason:
        `interactive session with an ARMED loop (interval ~${Math.round(intervalMs / 1000)}s) whose ` +
        `shared presence beat is ~${mins(staleMs)}m stale (> ${mins(threshold)}m) while its ` +
        `pty host is live — the MCP transport is severed (loop wakes cannot re-register either).`,
    };
  }

  // No loop: only a session actively IN USE (fresh pty bytes) with a long-stale
  // beat is suspect — an idle headed session legitimately makes no calls.
  const inUse = s.hostLastActivityMs != null && nowMs - s.hostLastActivityMs < ptyFreshMs;
  if (!inUse || staleMs <= noLoopStaleMs) return { dark: false, reason: null };
  return {
    dark: true,
    reason:
      `interactive session in active use (pty activity ~${mins(nowMs - (s.hostLastActivityMs ?? nowMs))}m ago) ` +
      `whose last MCP tool call was ~${mins(staleMs)}m ago — the transport is severed while the session works on dark ` +
      `(local tools only).`,
  };
}

export type InteractiveHealAction = 'heal' | 'defer-budget' | 'notify' | 'announce-healed' | 'none';

/** Mutable process-wide rolling budget. The background primary owns one
 * instance; tests inject a fresh one so no pass leaks capacity across cases. */
export interface InteractiveHealBudgetState {
  attemptsMs: number[];
  maxAttempts: number;
  windowMs: number;
}

export interface InteractiveHealStep {
  ownerId: string;
  action: InteractiveHealAction;
}

interface OwnerHealState {
  attemptsMs: number[];
  /** Heal attempts whose macro envelope actually LANDED ('sent'). Only these can
   *  ever justify an announce — a no-cap/no-host attempt injected nothing and
   *  cannot have healed anything (live false-heal bug #3, 2026-07-14). */
  sentCount: number;
  notified: boolean;
}

/**
 * Pure cross-pass planner: given each live owner's tri-state verdict + the
 * in-memory heal state, decide this pass's action per owner.
 *
 * VERDICT SEMANTICS (rewritten after the 2026-07-14 live false-heal incident —
 * the first deployed pass announced "healed" to two sessions whose transports
 * were still dead): recovery is POSITIVE EVIDENCE ONLY. `recovered` = a FRESH
 * recent agent-origin invocation exists right now (tools demonstrably
 * flowing); `dark` = the evaluateInteractiveMcpDark verdict. NEITHER
 * (¬dark ∧ ¬recovered — e.g. the session merely went idle and slipped under
 * the in-use gate, or its presence row is reaped/absent) is INDETERMINATE:
 * hold all state, take no action. The old ¬dark ⇒ healed inference flip-
 * flopped on the in-use hysteresis (su-5651d: HEALED 02:46 → DARK 02:51) and
 * announced heals off behavioral changes, not transport truth.
 *
 * The ladder [owner-mandated]: dark + attempts left ⇒ 'heal' (fire the /mcp
 * macro; the executor marks whether the envelope landed via markHealSent);
 * dark + attempts exhausted ⇒ 'notify' (once); recovered after a SENT attempt
 * ⇒ 'announce-healed' (one follow-up wake: re-arm + re-park); recovered
 * otherwise (owner ran /mcp himself, or only no-cap attempts) ⇒ clear state
 * silently. State mutates in place. Exported for tests.
 */
export function planInteractiveHeal(
  state: Map<string, OwnerHealState>,
  verdicts: Array<{ ownerId: string; dark: boolean; recovered?: boolean }>,
  nowMs: number,
  maxAttempts = DEFAULT_HEAL_MAX_ATTEMPTS,
  sharedBudget?: InteractiveHealBudgetState,
): InteractiveHealStep[] {
  const out: InteractiveHealStep[] = [];
  if (sharedBudget) {
    while (sharedBudget.attemptsMs.length && nowMs - sharedBudget.attemptsMs[0]! >= sharedBudget.windowMs) {
      sharedBudget.attemptsMs.shift();
    }
  }
  // FAIRNESS (P-014 finding): the shared budget admits owners in ascending prior-attempt
  // order, so a never-tried session is not starved by already-tried sessions retaking
  // capacity every time the window drains. Ties keep input order; output order is unchanged.
  const admitted = new Set<string>();
  {
    const candidates: Array<{ ownerId: string; attempts: number; idx: number }> = [];
    verdicts.forEach((v, idx) => {
      if (v.recovered || !v.dark) return;
      const attempts = (state.get(v.ownerId)?.attemptsMs ?? []).filter((t) => nowMs - t < HEAL_ATTEMPT_WINDOW_MS).length;
      if (attempts < maxAttempts) candidates.push({ ownerId: v.ownerId, attempts, idx });
    });
    candidates.sort((a, b) => a.attempts - b.attempts || a.idx - b.idx);
    const capacity = sharedBudget
      ? Math.max(0, sharedBudget.maxAttempts - sharedBudget.attemptsMs.length)
      : candidates.length;
    for (const c of candidates.slice(0, capacity)) admitted.add(c.ownerId);
  }
  for (const v of verdicts) {
    const st = state.get(v.ownerId);
    if (v.recovered) {
      // Positive evidence the transport is alive NOW. Announce only when one of
      // OUR macro envelopes actually landed — otherwise (self-recovered / owner
      // /mcp / no-cap attempts) clear silently: the session will discover its
      // live tools on its own, and a wrong "the macro healed you" is worse.
      if (st && st.sentCount > 0) {
        state.delete(v.ownerId);
        out.push({ ownerId: v.ownerId, action: 'announce-healed' });
      } else {
        if (st) state.delete(v.ownerId);
        out.push({ ownerId: v.ownerId, action: 'none' });
      }
      continue;
    }
    if (!v.dark) {
      // INDETERMINATE (¬dark ∧ ¬recovered): the session may have gone idle, its
      // presence row may be reaped — no transport truth either way. Hold state
      // (attempts/notified latches survive) and do nothing.
      out.push({ ownerId: v.ownerId, action: 'none' });
      continue;
    }
    const cur = st ?? { attemptsMs: [], sentCount: 0, notified: false };
    cur.attemptsMs = cur.attemptsMs.filter((t) => nowMs - t < HEAL_ATTEMPT_WINDOW_MS);
    if (cur.attemptsMs.length < maxAttempts) {
      if (sharedBudget && !admitted.has(v.ownerId)) {
        // Do NOT consume the owner's attempt: this session has not been tried.
        // The rolling window drains automatically, then a later sweep admits it.
        state.set(v.ownerId, cur);
        out.push({ ownerId: v.ownerId, action: 'defer-budget' });
        continue;
      }
      cur.attemptsMs.push(nowMs);
      sharedBudget?.attemptsMs.push(nowMs);
      state.set(v.ownerId, cur);
      out.push({ ownerId: v.ownerId, action: 'heal' });
    } else if (!cur.notified) {
      cur.notified = true;
      state.set(v.ownerId, cur);
      out.push({ ownerId: v.ownerId, action: 'notify' });
    } else {
      state.set(v.ownerId, cur);
      out.push({ ownerId: v.ownerId, action: 'none' });
    }
  }
  return out;
}

/** Stable bounded jitter for one admitted reconnect. Owner identity spreads a
 * burst; the rolling-window epoch changes the delay on a later attempt. */
export function interactiveHealJitterMs(ownerId: string, nowMs: number, maxMs = DEFAULT_HEAL_JITTER_MAX_MS): number {
  const cap = Math.max(0, Math.floor(maxMs));
  if (cap === 0) return 0;
  const key = `${ownerId}:${Math.floor(nowMs / DEFAULT_SHARED_HEAL_WINDOW_MS)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 1 + ((hash >>> 0) % cap);
}

/** Executor callback: mark that a 'heal' action's macro envelope actually LANDED
 *  ('sent') — the only attempts that can later justify an announce. Exported for
 *  tests. */
export function markHealSent(state: Map<string, OwnerHealState>, ownerId: string): void {
  const st = state.get(ownerId);
  if (st) st.sentCount += 1;
}

/** The one follow-up wake a healed session gets (exported for tests). */
export function healedWakeText(ownerId: string, staleMins: number): string {
  return (
    `⚠ MCP transport auto-heal (mcp-dark-watchdog P-005): your papercusp-su MCP transport was DEAD ` +
    `(last successful tool call ~${staleMins}m before the heal) and was just reconnected in place via ` +
    `your host's /mcp macro — your terminal and context are intact. Everything registered on the OLD ` +
    `transport died with it, so NOW: (1) loop:status — re-arm only when durable loop state/checkpoint says ` +
    `the transport loss interrupted an active mission; do NOT re-arm a deliberately ended loop; ` +
    `(2) re-park unflushed state (loop:checkpoint / work_items:checkpoint / facts:assert); ` +
    `(3) resume what you were doing. If tools still fail, tell the owner to run /mcp in this window.`
  );
}

/**
 * Enrol the watchdog-authored wake in the same verified turn-provenance ledger
 * used by every other machine injector. The ledger row is written before the
 * tagged text is returned for PTY injection, so UserPromptSubmit can never
 * classify this machine turn as interactive OWNER speech. Fail-soft delivery
 * preserves the watchdog's recovery role if provenance storage is unavailable.
 */
export async function taggedHealedWakeText(
  ownerId: string,
  staleMins: number,
  options: { dir?: string; nowMs?: number } = {},
): Promise<string> {
  const text = healedWakeText(ownerId, staleMins);
  try {
    const { tagTurnForInjection } = await import('../turn-provenance/turn-provenance');
    return (
      await tagTurnForInjection({
        sid: ownerId,
        origin: 'watchdog',
        text,
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      })
    ).taggedText;
  } catch {
    return text;
  }
}

/** The carry prompt delivered when the watchdog resumes a headless session. */
export function headlessMcpRecoveryWakeText(ownerId: string, staleMins: number): string {
  return (
    `⚠ MCP transport auto-recovery (mcp-dark-watchdog P-005): headless session ${ownerId} had no ` +
    `Papercusp MCP call for ~${staleMins}m. Its psu host resumed this same conversation with a ` +
    `watchdog-tagged carry. Re-read the active work-item and loop checkpoints, then continue. If ` +
    `Papercusp tools still fail, report the exact error. Do not start a second CLI for this session.`
  );
}

/** The carry prompt delivered when the watchdog resumes a headed session. */
export function headedMcpRecoveryWakeText(ownerId: string, staleMins: number): string {
  return (
    '⚠ MCP transport auto-recovery (mcp-dark-watchdog P-005): headed session ' +
    ownerId +
    ' had no Papercusp MCP call for ~' +
    staleMins +
    'm. Its existing psu host kept the terminal open and relaunched the CLI child with a ' +
    'watchdog-tagged carry. Re-read the active work-item and loop checkpoints, then continue. ' +
    'If Papercusp tools still fail, report the exact error. Do not start a second CLI for this session.'
  );
}

/** Register the headless carry prompt before the host submits it as a turn. */
export async function taggedHeadlessMcpRecoveryWakeText(
  ownerId: string,
  staleMins: number,
  options: { dir?: string; nowMs?: number } = {},
): Promise<string> {
  const text = headlessMcpRecoveryWakeText(ownerId, staleMins);
  try {
    const { tagTurnForInjection } = await import('../turn-provenance/turn-provenance');
    return (
      await tagTurnForInjection({
        sid: ownerId,
        origin: 'watchdog',
        text,
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      })
    ).taggedText;
  } catch {
    return text;
  }
}

/** Register the headed carry prompt before the host submits it as a turn. */
export async function taggedHeadedMcpRecoveryWakeText(
  ownerId: string,
  staleMins: number,
  options: { dir?: string; nowMs?: number } = {},
): Promise<string> {
  const text = headedMcpRecoveryWakeText(ownerId, staleMins);
  try {
    const { tagTurnForInjection } = await import('../turn-provenance/turn-provenance');
    return (
      await tagTurnForInjection({
        sid: ownerId,
        origin: 'watchdog',
        text,
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      })
    ).taggedText;
  } catch {
    return text;
  }
}

/** Owner-actionable recovery guidance for the two supported session classes. */
export function interactiveDarkRecoveryInstructions(
  sessionClass: 'headed' | 'headless',
  cause: string,
): string {
  if (sessionClass === 'headless') {
    return (
      `This headless host has no interactive /mcp dialog, and carry-respawn was unavailable (${cause}). ` +
      `If its old process is still running, stop it first; then resume the SAME conversation with ` +
      `psu --resume <session-id> so Papercusp MCP initializes at launch. Do not start a second CLI ` +
      `against the live host.`
    );
  }
  return (
    'The watchdog could not confirm an in-place MCP recovery (' +
    cause +
    '). Run node scripts/mcp-reconnect.mjs from the Papercusp checkout. It checks whether this ' +
    'host can force the reconnect; if not, run the carry-respawn command it prints. That replaces ' +
    'only the CLI child and keeps this terminal open.'
  );
}

/**
 * Assemble the same deterministic carry used by every other context boundary.
 * The watchdog is an external cut, so it must mark the boundary as forced and
 * never claim the session flushed its own state. Resolve the live transcript so
 * the session's original kickoff remains available even when it has not
 * made a successful MCP call yet.
 */
async function buildCanonicalRecoverySpec(ownerId: string): Promise<RecoverySpec | null> {
  try {
    const [{ buildOwnerRespawnLaunchSpec }, { estimateContextWindowForOwner, resolveSessionRefReconciled }] =
      await Promise.all([import('../carry-respawn'), import('../compaction-usage')]);
    const { activeWorkspaceId } = await import('../workspace-registry');

    const measuredWindow = await estimateContextWindowForOwner(ownerId).catch(() => null);
    const effectiveWindowTokens =
      typeof measuredWindow === 'number' && Number.isFinite(measuredWindow) && measuredWindow > 0
        ? measuredWindow
        : FALLBACK_RECOVERY_WINDOW_TOKENS;

    const ref = await resolveSessionRefReconciled(ownerId).catch(() => null);
    let transcriptPath: string | null = null;
    let transcriptSourceKind: 'claude' | 'codex' = 'claude';
    if (ref?.agent === 'codex') {
      const { resolveSelfSession } = await import('../search/self-session');
      const self = await resolveSelfSession(ownerId).catch(() => null);
      if (self?.sourceKind === 'codex') {
        transcriptPath = self.filePath;
        transcriptSourceKind = 'codex';
      }
    } else if (ref?.agent !== 'omp') {
      const { findSessionTranscript, newestTranscriptUnderOwner } = await import('../claude-sessions');
      transcriptPath =
        (ref?.sessionId ? await findSessionTranscript(ref.sessionId, { owner: ownerId }) : null) ??
        newestTranscriptUnderOwner(ownerId);
    }

    return await buildOwnerRespawnLaunchSpec(ownerId, {
      effectiveWindowTokens,
      buildOpts: {
        workspaceId: activeWorkspaceId(),
        transcriptPath,
        transcriptSourceKind,
        boundaryDeliberate: false,
        boundarySelfRequested: false,
      },
    });
  } catch {
    // A failed carry build must never turn a dark recovery into a blind recycle.
    return null;
  }
}

const interactiveHealState = new Map<string, OwnerHealState>();
const interactiveHealBudget: InteractiveHealBudgetState = {
  attemptsMs: [],
  maxAttempts: DEFAULT_SHARED_HEAL_MAX_ATTEMPTS,
  windowMs: DEFAULT_SHARED_HEAL_WINDOW_MS,
};

export interface InteractiveMcpDarkResult {
  darkOwners: string[];
  healed: string[];
  healSent: string[];
  notified: string[];
  /** Owners proven dark but deferred without consuming a per-owner attempt
   * because the process-wide reconnect budget is full. */
  budgetDeferred: string[];
  /** Escalation phases cleared this pass because their owner is no longer in
   *  the current dark set — either a live session that recovered, OR (the
   *  case the per-owner heal ladder can never reach) a session that ENDED
   *  entirely, so it dropped out of `hosts` and would otherwise never be
   *  revisited again. See the recovery-sweep comment in checkInteractiveMcpDark. */
  recovered: string[];
  /** EI-13020: owners whose CLAUDE_CONFIG_DIR was found NOT launch-ready and was
   *  repaired at heal time — i.e. the dark was (at least partly) CONFIG-caused,
   *  not transport-caused. A `/mcp` reconnect cannot fix that class on its own,
   *  so this is the measurement that decides whether a relaunch escalation is
   *  worth building. Empty on a healthy fleet. */
  configRepaired: string[];
}

/**
 * One interactive-sweep pass: live psu-pty hosts (FS discovery) × presence beat ×
 * armed-loop routines → verdicts → the heal ladder. Never throws. The psu-pty
 * modules are imported lazily so a box with no interactive infra (or a test
 * without the FS layout) degrades to a no-op sweep.
 */
export async function checkInteractiveMcpDark(
  sql: Sql,
  opts: InteractiveDarkThresholds & {
    maxAttempts?: number;
    sharedMaxAttempts?: number;
    sharedWindowMs?: number;
    jitterMaxMs?: number;
    sharedBudget?: InteractiveHealBudgetState;
    /** Test seam for the canonical watchdog carry assembly. */
    buildRecoverySpec?: BuildRecoverySpec;
  } = {},
): Promise<InteractiveMcpDarkResult> {
  const out: InteractiveMcpDarkResult = {
    darkOwners: [],
    healed: [],
    healSent: [],
    notified: [],
    budgetDeferred: [],
    recovered: [],
    configRepaired: [],
  };
  try {
    const discovery = await import('../events/await/psu-pty-discovery');
    // Async (WI-10004559): a sync scan of the shared psu-pty directory can block this
    // thread in D-state for 20s+ during a journal stall, and the sentinel then kills us.
    const hosts = await discovery.listLiveHostsAsync();
    // NOTE: unlike an earlier version of this function, we do NOT early-return
    // here when hosts.length === 0 — the recovery sweep below (which clears
    // stale escalations for owners no longer in the dark set) must still run
    // on an empty-hosts pass, or an escalation raised for a session that has
    // since ENDED entirely is never revisited again (see that comment).
    const owners = hosts.map((h) => h.ownerId);
    const liveOwnerIds = new Set(owners);
    const recoveredOwnerIds = new Set<string>();
    const now = Date.now();
    const assistantTurnThreshold = opts.assistantTurnsWithoutAgentMcp ?? DEFAULT_TOOLLESS_ASSISTANT_TURN_THRESHOLD;
    const toolFreeTurnRowsPromise =
      owners.length > 0
        ? sql<
            {
              owner_id: string;
              assistant_turn_count: string | number | null;
              last_assistant_turn_ms: string | number | null;
              last_agent_call_ms: string | number | null;
            }[]
          >`
      WITH live_hosts AS (
        SELECT owner_id, host_started_at
          FROM UNNEST(
            ${sql.array(owners)}::text[],
            ${sql.array(hosts.map((host) => new Date(host.startedAt)))}::timestamptz[]
          ) AS h(owner_id, host_started_at)
      ),
      last_agent AS (
        SELECT h.owner_id, max(t.invoked_at) AS invoked_at
          FROM live_hosts h
          JOIN harness_shared.tool_invocations t
            ON t.coord_owner_id = h.owner_id
           AND t.invoked_at >= h.host_started_at
           AND ${agentToolInvocationPredicate(sql, 't')}
         GROUP BY h.owner_id
      )
      SELECT h.owner_id,
             turns.assistant_turn_count,
             turns.last_assistant_turn_ms,
             extract(epoch from a.invoked_at) * 1000 AS last_agent_call_ms
        FROM live_hosts h
        LEFT JOIN last_agent a ON a.owner_id = h.owner_id
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS assistant_turn_count,
                 max(extract(epoch from recent.ts) * 1000) AS last_assistant_turn_ms
            FROM (
              SELECT p.ts
                FROM harness_shared.session_turns p
               WHERE p.workspace_id = 'default'
                 AND p.owner = h.owner_id
                 AND p.speaker = 'assistant'
                 AND p.ts >= coalesce(a.invoked_at, h.host_started_at)
                 AND p.ts <= ${new Date(now)}
               ORDER BY p.ts DESC
               LIMIT ${assistantTurnThreshold}
            ) recent
        ) turns
      `
        : Promise.resolve([]);

    // Only query per-host presence/loop state, agent-origin invocation and
    // assistant-turn evidence + run the verdict/heal ladder
    // when there IS at least one live host — an empty `owners` array feeding
    // `= ANY(${owners})` is exactly what the original hosts.length===0 guard
    // avoided, and skipping this block leaves darkOwners empty (correct: zero
    // live hosts means zero owners can be dark THIS pass), which the recovery
    // sweep below then treats identically to "all clear".
    if (owners.length > 0) {
      const [presenceRows, loopRows, agentInvocationRows] = await Promise.all([
        sql<{ owner_id: string; presence_ms: string | number | null }[]>`
          SELECT owner_id, extract(epoch from heartbeat_at) * 1000 AS presence_ms
            FROM harness_shared.coord_presence
           WHERE owner_id = ANY(${owners})`,
        sql<{ target_owner_id: string; reschedule_interval_sec: string | number | null }[]>`
          SELECT target_owner_id, reschedule_interval_sec
            FROM harness_shared.routines
           WHERE active
             AND reschedule_interval_sec IS NOT NULL
             AND name LIKE 'loop-%'
             AND target_owner_id = ANY(${owners})`,
        sql<{ owner_id: string }[]>`
          SELECT DISTINCT t.coord_owner_id AS owner_id
            FROM harness_shared.tool_invocations t
           WHERE t.coord_owner_id = ANY(${owners})
             AND t.invoked_at >= ${new Date(now - RECOVERED_FRESH_MS)}
             AND ${agentToolInvocationPredicate(sql, 't')}
        `,
      ]);
      const toolFreeTurnRows = await toolFreeTurnRowsPromise;
      const presenceBy = new Map(
        presenceRows.map((r) => [r.owner_id, r.presence_ms != null ? Number(r.presence_ms) : null]),
      );
      const loopBy = new Map(
        loopRows.map((r) => [
          r.target_owner_id,
          r.reschedule_interval_sec != null ? Number(r.reschedule_interval_sec) : null,
        ]),
      );
      const agentInvocationOwners = new Set(agentInvocationRows.map((r) => r.owner_id));
      const toolFreeTurnsByOwner = new Map(
        toolFreeTurnRows.map((r) => [
          r.owner_id,
          {
            count: r.assistant_turn_count == null ? 0 : Number(r.assistant_turn_count),
            lastTurnMs: r.last_assistant_turn_ms == null ? null : Number(r.last_assistant_turn_ms),
            lastAgentMs: r.last_agent_call_ms == null ? null : Number(r.last_agent_call_ms),
          },
        ]),
      );

      const verdictByOwner = new Map<
        string,
        { dark: boolean; recovered: boolean; reason: string | null; staleMins: number }
      >();
      for (const h of hosts) {
        const presenceMs = presenceBy.get(h.ownerId) ?? null;
        const toolFreeTurns = toolFreeTurnsByOwner.get(h.ownerId);
        const verdict = evaluateInteractiveMcpDark(
          {
            ownerId: h.ownerId,
            hostStartedMs: h.startedAt ?? null,
            hostLastActivityMs: h.lastActivityAt ?? null,
            presenceHeartbeatMs: presenceMs,
            loopActive: loopBy.has(h.ownerId),
            loopIntervalSec: loopBy.get(h.ownerId) ?? null,
            assistantTurnsSinceLastAgentCall: toolFreeTurns?.count ?? 0,
            lastAssistantTurnMs: toolFreeTurns?.lastTurnMs ?? null,
          },
          now,
          opts,
        );
        // Positive recovery is a recent agent-origin invocation, not a fresh
        // coord_presence beat. Supervisor, hook, and inbox writers can refresh
        // that shared beat without proving the agent-facing MCP surface works.
        const recovered = agentInvocationOwners.has(h.ownerId);
        if (recovered) recoveredOwnerIds.add(h.ownerId);
        verdictByOwner.set(h.ownerId, {
          dark: recovered ? false : verdict.dark,
          recovered,
          reason: verdict.reason,
          // The shared presence beat may be refreshed by hooks while the client
          // has made no agent-origin call. For the tool-less-turn alarm, report
          // silence from the last agent call (or host start), not that fresh
          // hook beat; otherwise a real ~60m gap is rendered as "~0m".
          staleMins: mins(
            Math.max(
              0,
              now -
                (toolFreeTurns
                  ? (toolFreeTurns.lastAgentMs ?? h.startedAt ?? presenceMs ?? now)
                  : (presenceMs ?? h.startedAt ?? now)),
            ),
          ),
        });
      }
      out.darkOwners = [...verdictByOwner.entries()].filter(([, v]) => v.dark).map(([o]) => o);

      const sharedBudgetState = opts.sharedBudget ?? interactiveHealBudget;
      // Per-pass overrides must never retune the process-global defaults for
      // later sweeps; only the timestamp array is intentionally shared.
      const sharedBudget: InteractiveHealBudgetState = {
        attemptsMs: sharedBudgetState.attemptsMs,
        maxAttempts: opts.sharedMaxAttempts ?? sharedBudgetState.maxAttempts,
        windowMs: opts.sharedWindowMs ?? sharedBudgetState.windowMs,
      };
      const plan = planInteractiveHeal(
        interactiveHealState,
        [...verdictByOwner.entries()].map(([ownerId, v]) => ({ ownerId, dark: v.dark, recovered: v.recovered })),
        now,
        opts.maxAttempts ?? DEFAULT_HEAL_MAX_ATTEMPTS,
        sharedBudget,
      );
      const hostByOwner = new Map(hosts.map((host) => [host.ownerId, host]));

      for (const step of plan) {
        const v = verdictByOwner.get(step.ownerId);
        try {
          if (step.action === 'heal') {
            const jitterMs = interactiveHealJitterMs(step.ownerId, now, opts.jitterMaxMs ?? DEFAULT_HEAL_JITTER_MAX_MS);
            if (jitterMs > 0) await new Promise((resolve) => setTimeout(resolve, jitterMs));
          }
          await runInteractiveHealStep(step, v, {
            sql,
            discovery,
            out,
            now,
            host: hostByOwner.get(step.ownerId),
            buildRecoverySpec: opts.buildRecoverySpec ?? buildCanonicalRecoverySpec,
          });
        } catch (e) {
          // One owner's failure must not abort the rest of the pass (live incident
          // 2026-07-14: the workspace_id NOT NULL crash killed every later step).
          console.warn(
            `[mcp-dark-watchdog] interactive step ${step.action} failed for ${step.ownerId} (non-fatal): ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // ── Recovery sweep (durability follow-up, 2026-07-14): clear a standing
    // mcp-dark-int:% escalation only when its owner is absent from the live-host
    // inventory (ended) or has a recent agent-origin invocation. A live owner
    // missing from the dark set is ambiguous and cannot prove MCP recovery.
    // The per-owner heal ladder above only ever visits owners in `hosts`
    // (CURRENTLY live psu-pty sessions), so runInteractiveHealStep's own
    // escalation-clear (on 'announce-healed') can NEVER reach an owner whose
    // session has since ENDED entirely — it simply drops out of `hosts` and is
    // never revisited again. Without this sweep, an escalation raised while a
    // session was dark stays open FOREVER once that session exits (the exact
    // shape of EI-12059 / su-39f079d3: session ended ~03:15, zero live hosts or
    // presence rows for it since, escalation still open 14+h later because
    // nothing in this file's control flow was ever going to touch it again).
    // Safe/idempotent for the live-and-recovered case too (already cleared
    // above via 'announce-healed' — this just re-confirms it, a no-op UPDATE).
    const alertedInteractiveRows = await sql<{ phase: string }[]>`
      SELECT phase FROM harness_shared.harness_escalations
       WHERE phase LIKE ${INTERACTIVE_PHASE_PREFIX + '%'} AND escalation IS NOT NULL`;
    const darkInteractivePhases = new Set(out.darkOwners.map((o) => INTERACTIVE_PHASE_PREFIX + o));
    const toRecoverInteractive = alertedInteractiveRows
      .map((r) => r.phase)
      .filter((phase) => {
        if (!phase.startsWith(INTERACTIVE_PHASE_PREFIX)) return false;
        const ownerId = phase.slice(INTERACTIVE_PHASE_PREFIX.length);
        return (
          !darkInteractivePhases.has(phase) &&
          (!liveOwnerIds.has(ownerId) || recoveredOwnerIds.has(ownerId))
        );
      });
    if (toRecoverInteractive.length > 0) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE phase = ANY(${toRecoverInteractive}) AND escalation IS NOT NULL`;
      out.recovered = toRecoverInteractive.map((p) => p.slice(INTERACTIVE_PHASE_PREFIX.length));
    }
    return out;
  } catch (e) {
    console.warn(
      `[mcp-dark-watchdog] interactive pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    return out;
  }
}

/** One planned action for one owner — factored out so the pass loop can isolate
 *  failures per owner (2026-07-14). */
async function runInteractiveHealStep(
  step: InteractiveHealStep,
  v: { dark: boolean; recovered: boolean; reason: string | null; staleMins: number } | undefined,
  ctx: {
    sql: Sql;
    discovery: typeof import('../events/await/psu-pty-discovery');
    out: InteractiveMcpDarkResult;
    now: number;
    host: PsuPtyHost | undefined;
    buildRecoverySpec: BuildRecoverySpec;
  },
): Promise<void> {
  const { sql, discovery, out, now, host, buildRecoverySpec } = ctx;
  if (step.action === 'defer-budget') {
    out.budgetDeferred.push(step.ownerId);
    console.warn(
      `[mcp-dark-watchdog] interactive DARK ${step.ownerId} — reconnect DEFERRED: ` +
        `shared rolling budget exhausted; owner attempt not consumed`,
    );
  } else if (step.action === 'heal') {
    // EI-13020: a `/mcp` reconnect can only reconnect servers the session's config
    // DECLARES. If this session is dark because its CLAUDE_CONFIG_DIR holds the
    // EI-12938 stub `.claude.json` (an `oauthAccount` but NO `mcpServers` — what
    // claude mints for itself on a first-run boot into a transcript-only dir),
    // then the macro below has nothing to reconnect to: the heal lands as 'sent',
    // burns both attempts, escalates to "owner action needed, /mcp in its
    // terminal" — and even that manual /mcp cannot recover it. Repair the dir
    // FIRST so the reconnect (or the owner's relaunch/resume) has a server.
    //
    // Safe unconditionally: `ensureInteractiveClaudeConfig` never throws, and a
    // healthy dir is left BYTE-IDENTICAL for the cost of one lstat. Lazily
    // imported per this module's convention so a box with no interactive infra
    // degrades to a no-op.
    //
    // This is deliberately NOT gated on the open question of whether claude's
    // /mcp RE-READS the config from disk or only reconnects birth-known servers
    // (EI-13020's proposed experiment) — the repair strictly helps either way:
    // if it re-reads, the live process heals here; if it does not, the on-disk
    // config is correct so the next relaunch/resume recovers instead of the
    // session staying permanently unhealable. `repaired` also INSTRUMENTS that
    // question for free: it reports how much of the interactive dark set is
    // config-caused, which is what decides whether a relaunch escalation is
    // worth building.
    let repaired = false;
    try {
      const { ensureInteractiveClaudeConfig } = await import('../interactive-claude-config');
      ({ repaired } = await ensureInteractiveClaudeConfig({ sid: step.ownerId }));
      if (repaired) out.configRepaired.push(step.ownerId);
    } catch {
      // Never let config repair block the heal it is trying to enable.
    }
    const headless = discovery.sessionClassForHost(host) === 'claude-headless';
    let sent: 'sent' | 'no-host' | 'no-cap' | 'send-failed' | 'carry-build-failed';
    if (!host) {
      sent = 'no-host';
    } else if (headless || !discovery.hostSupports(host, 'mcp-reconnect-force')) {
      // The base mcp-reconnect capability does not promise that force:true is
      // honored. Older headed hosts cannot adopt new host code while a terminal
      // is attached, but they can safely carry-respawn inside that same PTY host.
      if (!discovery.hostSupports(host, 'carry-respawn')) {
        sent = 'no-cap';
      } else {
        let spec: RecoverySpec | null = null;
        try {
          spec = await buildRecoverySpec(step.ownerId);
        } catch {
          spec = null;
        }
        if (!spec) {
          sent = 'carry-build-failed';
        } else {
          // An unresolved owner request is already the canonical first prompt;
          // when there is none, use the watchdog-tagged recovery instruction so
          // the successor wakes without inventing an owner directive.
          const carry =
            spec.firstPrompt ??
            (await (headless
              ? taggedHeadlessMcpRecoveryWakeText(step.ownerId, v?.staleMins ?? 0)
              : taggedHeadedMcpRecoveryWakeText(step.ownerId, v?.staleMins ?? 0)));
          const accepted = await discovery.injectIntoHost(host.sock, {
            mode: 'carry-respawn',
            data: carry,
            systemPromptAddendum: spec.systemPromptAddendum,
            ownerId: step.ownerId,
          });
          sent = accepted ? 'sent' : 'send-failed';
        }
      }
    } else {
      // This sweep is only entered after the interactive detector has evidence
      // of a toolless session (recent assistant turns without an agent-origin
      // MCP call). Claude can still render the server as "connected" while its
      // tools/list binding is gone, so an advertised forced-reconnect macro is
      // required before we queue the in-place /mcp action.
      sent = await discovery.mcpReconnectViaPty(step.ownerId, 'papercusp-su', { force: true });
    }
    console.warn(
      `[mcp-dark-watchdog] interactive DARK ${step.ownerId} — heal ${sent}` +
        `${repaired ? ' (config dir REPAIRED — was config-caused dark)' : ''}: ${v?.reason ?? ''}`,
    );
    if (sent === 'sent') {
      out.healSent.push(step.ownerId);
      // Only LANDED envelopes may later justify an announce (false-heal bug #3).
      markHealSent(interactiveHealState, step.ownerId);
    } else {
      // No injectable host / old host / write failure ⇒ no heal will ever land
      // this way — skip straight to the notify posture on this same pass.
      const st = interactiveHealState.get(step.ownerId);
      if (st && !st.notified) {
        st.notified = true;
        await notifyInteractiveDark(
          sql,
          step.ownerId,
          v?.reason ?? 'transport dead',
          `heal unavailable (${sent})`,
          headless ? 'headless' : 'headed',
        );
        out.notified.push(step.ownerId);
      }
    }
  } else if (step.action === 'notify') {
    await notifyInteractiveDark(
      sql,
      step.ownerId,
      v?.reason ?? 'transport dead',
      'heal attempts exhausted',
      discovery.sessionClassForHost(host) === 'claude-headless' ? 'headless' : 'headed',
    );
    out.notified.push(step.ownerId);
  } else if (step.action === 'announce-healed') {
    out.healed.push(step.ownerId);
    // POSITIVE transport truth (fresh beat after a SENT envelope) — tell the
    // session ONCE to re-arm.
    const host = await discovery.findLiveHostAsync(step.ownerId);
    if (host) {
      await discovery.injectIntoHost(host.sock, {
        mode: 'turn',
        data: await taggedHealedWakeText(step.ownerId, v?.staleMins ?? 0),
        ownerId: step.ownerId,
      });
    }
    // Clear any standing escalation row (idempotent).
    await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${now}
       WHERE phase = ${INTERACTIVE_PHASE_PREFIX + step.ownerId} AND escalation IS NOT NULL`;
    console.warn(`[mcp-dark-watchdog] interactive HEALED ${step.ownerId} — follow-up wake injected`);
  }
}

/** Claim + notify for one MCP-dark session with class-specific recovery guidance. */
async function notifyInteractiveDark(
  sql: Sql,
  ownerId: string,
  reason: string,
  cause: string,
  sessionClass: 'headed' | 'headless' = 'headed',
): Promise<void> {
  const now = Date.now();
  // workspace_id is NOT NULL on harness_escalations (live crash 2026-07-14:
  // "null value in column workspace_id … violates not-null constraint" — the
  // notify never landed AND the thrown error aborted the rest of the pass).
  // Interactive hosts don't carry a workspace, so use the active one.
  const { activeWorkspaceId } = await import('../workspace-registry');
  const workspaceId = activeWorkspaceId();
  const claimed = await sql`
    INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
    VALUES ('papercusp', ${INTERACTIVE_PHASE_PREFIX + ownerId}, ${JSON.stringify({
      kind: 'mcp-dark-watchdog-interactive',
      owner_id: ownerId,
      emitted_at: now,
      detail: `${sessionClass} session ${ownerId} is MCP-dark (${cause}): ${reason}`,
    })}, ${now}, ${workspaceId})
    ON CONFLICT (harness_slug, phase) DO NOTHING
    RETURNING phase`;
  if (claimed.length !== 1) return; // already claimed — cross-process exactly-once
  const recoveryInstructions = interactiveDarkRecoveryInstructions(sessionClass, cause);
  try {
    const { notifyAttention } = await import('../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `${sessionClass === 'headless' ? 'Headless' : 'Interactive'} session ${ownerId.slice(0, 12)}… is MCP-dark (auto-heal ${cause})`,
      body: `${reason}\n\n${recoveryInstructions}`,
      importance: 'high',
      data: { ownerId, cause, sessionClass },
    });
  } catch (e) {
    console.warn(`[mcp-dark-watchdog] interactive notify failed: ${e instanceof Error ? e.message : e}`);
  }
  await broadcastSevereEvent({
    summary: `${sessionClass === 'headless' ? 'Headless' : 'Interactive'} session ${ownerId} MCP-dark — auto-heal ${cause}; recovery action needed.`,
    body:
      `${reason}\n\n${recoveryInstructions} The session cannot read its own inbox while MCP is down.`,
    category: 'severe-event',
  });
}

let watchdogTimer: ManagedHandle | null = null;
let restartAtMs: number | null = null;

/**
 * Start the watchdog: a grace-delayed boot check + a recurring process-level sweep. restartAt is
 * pinned to this call (== operator boot). Idempotent. Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
 * The interactive transport-death sweep (P-005) rides the same timer; its own kill-switch is
 * PAPERCUSP_MCP_DARK_INTERACTIVE='0'.
 */
export function startMcpDarkWatchdog(sql: Sql, opts: McpDarkThresholds & { intervalMs?: number } = {}): void {
  if (process.env.PAPERCUSP_MCP_DARK_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  restartAtMs = Date.now();
  const bootAt = restartAtMs;

  const run = (): void => {
    void checkMcpDark(sql, bootAt, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[mcp-dark-watchdog] alarmed on: ${r.alarmed.join(', ')} (host ${os.hostname()})`);
      }
    });
    if (process.env.PAPERCUSP_MCP_DARK_INTERACTIVE !== '0') {
      void checkInteractiveMcpDark(sql);
    }
  };

  if (watchdogTimer) watchdogTimer.stop();
  // No immediate boot check: within the grace window every session legitimately predates the
  // restart, so the first useful sweep is one interval in (past the grace gate).
  watchdogTimer = managedSetInterval('mcp-dark-watchdog', intervalMs, run, { category: 'watchdog' });
}
