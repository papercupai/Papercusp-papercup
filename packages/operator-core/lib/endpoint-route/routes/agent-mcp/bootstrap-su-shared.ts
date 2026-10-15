/** Shared launch/refresh helpers, kept independent of the bootstrap route graph. */
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';

// Exported for the sibling launcher-facing routes split out of this file (the
// persona refresh) — one copy of the CORS/principal boilerplate, not two.
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization',
};

export function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

export async function gatePrincipal(headers: Headers): Promise<Response | null> {
  try {
    await requirePrincipal(headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return jsonRes({ status: 'error', error: err.reason }, err.status);
    }
    throw err;
  }
}


/**
 * fleet-auto-mode (WI-1356): the durable AUTO-mode activation a fleet/auto launch
 * bakes into the session — a fleet member has no human at its keyboard, so it must
 * start in the persona's "act, don't ask, loop until done" standing state. Injected
 * into the assembled system prompt (survives compaction) AND prepended to the seeded
 * turn-1 kickoff (so turn 1 enters AUTO). Shared so the two copies never drift.
 */
export const AUTO_MODE_DIRECTIVE =
  'AUTO mode is ON for this session — act on your judgment, do not stop to ask, ' +
  'loop continuously until the work is done. You are a fleet member with no human at your ' +
  'keyboard, so to persist across turns instead of PARKING after turn 1 you MUST ARM A ' +
  'SELF-SUSTAINING LOOP: call loop:arm { intervalSec, goal } toward your assigned work; each ' +
  'wake self-assign + advance a work_item; loop:end ONLY when the goal is done or you are ' +
  "blocked. (The persona's AUTO-mode section governs; the narrow irreversible-high-stakes " +
  'brakes still apply.)';

/**
 * kickoff-prompt-absorption-2026-07-17 P-004: the AUTO activation for a member
 * whose engine loop the server ALREADY armed at boot (P-001's
 * `autoArmFleetMemberLoop`). The "MUST ARM A SELF-SUSTAINING LOOP" compliance
 * clause is replaced by its landed absorber — persistence is now a structural
 * boot-time effect — leaving the one-line "already armed" notice P-004
 * specifies. Everything else (act-don't-ask posture, per-wake work contract,
 * loop:end exit, the persona pointer) is unchanged from AUTO_MODE_DIRECTIVE.
 */
export const AUTO_MODE_DIRECTIVE_LOOP_ARMED =
  'AUTO mode is ON for this session — act on your judgment, do not stop to ask, ' +
  'loop continuously until the work is done. You are a fleet member with no human at your ' +
  'keyboard; your self-sustaining engine loop is ALREADY ARMED server-side, so each wake ' +
  're-invokes you: self-assign + advance a work_item every wake (loop:status inspects it; ' +
  'loop:end + loop:arm retunes it; loop:end ONLY when the goal is done or you are blocked). ' +
  "(The persona's AUTO-mode section governs; the narrow irreversible-high-stakes brakes " +
  'still apply.)';


/** The AUTO activation a launch bakes/prepends, picked by whether P-001's
 *  server-side auto-arm actually took (never assume — a leader, an unplanned
 *  member, a disabled flag, or an arm error all fall back to the full
 *  self-arm instruction). */
export function autoModeDirective(loopAutoArmed: boolean): string {
  return loopAutoArmed ? AUTO_MODE_DIRECTIVE_LOOP_ARMED : AUTO_MODE_DIRECTIVE;
}

/**
 * drain-mode-2026-07-03 (P-003): the durable DRAIN-mode activation a `--mode=drain`
 * launch bakes into the session — the owner's "drain the work queue to terminal"
 * standing state. DRAIN IMPLIES AUTO (the server forces autoMode on), so this
 * directive REPLACES the plain AUTO one (never both) — it carries the act-don't-ask
 * posture itself plus the drain mission loop. Injected into the assembled system
 * prompt (survives compaction) AND prepended to the seeded turn-1 kickoff, same
 * dual delivery as AUTO_MODE_DIRECTIVE. The full operating clause lives in the
 * persona (operating-modes-policy.ts renderModesPolicy, 'full' tier § DRAIN mode);
 * this is the activation + a faithful compression of its 6-step loop.
 */
export const DRAIN_MODE_DIRECTIVE =
  'DRAIN mode is ON for this session — DRAIN implies AUTO mode ON: act on your judgment, do ' +
  'not stop to ask. Your mission is to drain the target work queue to TERMINAL, per the ' +
  "persona's DRAIN-mode section (which governs): (1) TRIAGE + RANK the queue first — the " +
  'ranking IS the batch plan, no hand-built batches; (2) CAPACITY PREFLIGHT before any fleet ' +
  'launch (accounts:status + gateway headroom); (3) CANARY-FIRST bring-up — take fleet ' +
  'leadership as your FIRST act, verify member first-turns via tool_invocations (join ≠ ' +
  'liveness), then loop:arm; (4) FEED BY CLAIM-SPEC (scheduler:set_claim_spec revision bumps ' +
  '+ member scheduler:get_next — never id-pins or hand-assignment); (5) run the lean LEADER ' +
  'LOOP each wake (burn-down delta, member liveness, completion-integrity spot-audits, ' +
  'orphan/stall reclaim, blocked triage); (6) WIND DOWN with loop:end + a final residue ' +
  'report when only owner-gated/live-dep residue remains. NOT licensed: skipping ' +
  'spawn-announcements (account + model), force-deploying past a red gate, or trading ' +
  'completion integrity for speed.';


/**
 * context-trimming-tiers P-007: the context-discipline line a fleet launch bakes
 * next to the AUTO directive — durable system prompt (survives compaction) +
 * turn-1 kickoff, same dual delivery. Six 200k-window members died mid-task on
 * 2026-07-01 ("Prompt is too long") because nothing told them to act on the
 * `context: N/LIMIT (X%)` signal the coord inbox injects (agent-managed-compaction
 * P-007) once the compliance watchdog seeds their limit.
 */
export const CONTEXT_DISCIPLINE_DIRECTIVE =
  'CONTEXT DISCIPLINE: your coord inbox injects a `context: N/LIMIT (X%)` usage line once ' +
  'your session carries a compaction limit. HONOR it — past ~80%, finish the current unit of ' +
  'work, write durable state (plan `## Now` / work_items:checkpoint), then call ' +
  'session:request-compaction at that clean stopping point. Do NOT run to the hard window: ' +
  '"Prompt is too long" kills the session mid-task and loses your in-flight work. On a ' +
  'trimmed session, tool payloads are already tier-shaped; pass payloadTier:"full" on a call ' +
  'only when you genuinely need the unshaped result.';

/**
 * The AUTO/DRAIN section a launch appends to the assembled system prompt — '' when
 * the session is neither. Shared with the carry-respawn persona refresh
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002) so a re-rendered prompt
 * carries byte-identical mode prose; it lives HERE, next to the directives it
 * composes and the kickoff that shares them, rather than in `su-persona-render`.
 *
 * drain-mode P-003: the DRAIN section REPLACES the plain AUTO one — the DRAIN
 * directive carries the act-don't-ask posture itself (DRAIN implies AUTO), so
 * baking both would just double-print the activation.
 */
export function composeModePromptSection(opts: {
  autoMode: boolean;
  drainMode: boolean;
  loopArmed: boolean;
}): string {
  if (opts.drainMode) {
    return `---\n## DRAIN mode\n\n${DRAIN_MODE_DIRECTIVE}\n\n${CONTEXT_DISCIPLINE_DIRECTIVE}\n`;
  }
  if (opts.autoMode) {
    return `---\n## AUTO mode\n\n${autoModeDirective(opts.loopArmed)}\n\n${CONTEXT_DISCIPLINE_DIRECTIVE}\n`;
  }
  return '';
}
