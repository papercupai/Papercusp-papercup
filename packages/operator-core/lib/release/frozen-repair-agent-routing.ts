/**
 * Pure policy for routing a HELD frozen-candidate repair to agents.
 *
 * WHY THIS EXISTS (WI-2141736 P-003, measured 2026-09-02)
 * -------------------------------------------------------
 * Freeze-and-converge has exactly two repair paths: an auto-dispatched release-fixer,
 * and agents converging fixes onto `repairHead`. When the fixer's provider is usage-walled
 * the first path is unavailable — on 2026-09-02 for SIX DAYS — and the queue is now HELD
 * rather than retired (`wait-for-dispatch-capacity` with `zeroAttemptStalled`, see
 * frozen-candidate-repair-queue.ts). A held queue with no fixer and no owner converges
 * nowhere: it simply waits out its hold budget and is then retired, which is the same
 * treadmill by a slower route.
 *
 * So the hold has to ROUTE the repair. This module builds the alarm that mints exactly one
 * claimable convergence work-item (via the condition bridge — the same substrate as
 * `gate-red-streak:<pipeline>`), naming the three things a claimant otherwise reconstructs
 * by hand: WHICH sha is frozen, WHAT is failing on it, and the EXACT converge call that
 * admits a fix to it.
 *
 * The alarm names the frozen candidate deliberately, because the default behaviour it
 * corrects is agents fixing the red AT TIP: a fix at tip is not in the frozen candidate,
 * so the gate re-reds on the same file and the fix looks like it did not work.
 *
 * This module performs no git, filesystem, database, or process work.
 */

/**
 * Condition family. One open condition per pipeline; the bridge mints its owning work-item.
 *
 * RE-EXPORTED, not re-declared: the literal lives in `coord/actionable-conditions.ts`, the
 * zero-import leaf that also carries this family's opt-in entry. A prefix spelled in both
 * places can drift out of its own catalog entry, and the failure is silent — the alarm
 * broadcasts, mints nothing, and reads exactly like a gate that never held anything.
 */
import {
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
  FROZEN_REPAIR_LEG_CONDITION_PREFIX,
} from '../coord/actionable-conditions';

export { FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX, FROZEN_REPAIR_LEG_CONDITION_PREFIX };

/** The single condition key for one pipeline's held-repair routing. */
export function frozenRepairConvergenceConditionKey(pipeline: string): string {
  return `${FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX}${pipeline}`;
}

export interface FrozenRepairConvergenceRoutingInput {
  /** `pipelineName(cfg.integrationRoot)` — the key segment and summary tag. */
  pipeline: string;
  /** The frozen candidate sha. Fixes must land ON TOP of this, never at tip. */
  candidate: string;
  /** The movable head fixes converge onto. This is what the queue re-tests. */
  repairHead: string;
  /** The queue's current failing set (replaced each red, so this is the live round). */
  failingTests: readonly string[];
  /** The measured provider wall's own reset time, when the probe reported one. */
  capacityRetryAtMs?: number | null;
  /** The capacity probe's own words (e.g. "all codex accounts are usage-walled"). */
  capacitySummary?: string | null;
  /** How long this queue has been held, and the budget it is held against. */
  heldMs: number;
  convergenceHoldMs: number;
  /** Injected so the rendered deadline is deterministic under test. */
  nowMs: number;
}

/** How many failing paths are named inline before the list is summarized. */
const MAX_NAMED_FAILING = 12;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Per-leg items (green-main-cycle-time-2026-10-08 P-013, D-028 as amended by D-029)
// ─────────────────────────────────────────────────────────────────────────────────────────

/** At most this many legs hold their own item at once; the next one is routed as one clears. */
export const MAX_ROUTED_LEGS = MAX_NAMED_FAILING;

/** How much of a leg's recorded failure output its item carries (the tail, not the head). */
const MAX_FAILURE_TAIL_CHARS = 1500;

/** The key prefix shared by every leg item of one pipeline. */
export function frozenRepairLegKeyPrefix(pipeline: string): string {
  return `${FROZEN_REPAIR_LEG_CONDITION_PREFIX}${pipeline}:`;
}

/** The condition key for one failing leg (`frozen-repair-leg:<pipeline>:<entry>`). */
export function frozenRepairLegConditionKey(pipeline: string, entry: string): string {
  return `${frozenRepairLegKeyPrefix(pipeline)}${entry}`;
}

export interface FrozenRepairLegRoutingInput {
  /** `pipelineName(cfg.integrationRoot)`. */
  pipeline: string;
  /**
   * The frozen queue this tick ended holding, or null when there is none (it went green,
   * was retired, or never existed). Null resolves every open leg item of the pipeline.
   * The CALLER decides null: an UNREADABLE queue must not be passed as null, because that
   * would close every leg on a read fault — skip routing for that tick instead.
   */
  queue: { candidate: string; repairHead: string; failingTests: readonly string[] } | null;
  /** Leg keys of this pipeline currently OPEN in the condition fold. */
  openLegKeys: readonly string[];
  /** Recorded failure output per failing entry, best-effort; absent entries say so. */
  failureTails?: ReadonlyMap<string, string>;
}

export interface FrozenRepairLegOpen {
  conditionKey: string;
  entry: string;
  summary: string;
  body: string;
}

export interface FrozenRepairLegRoutingPlan {
  /** Legs to OPEN this tick: failing, within the routed window, and not already open. */
  open: FrozenRepairLegOpen[];
  /** Open leg keys to RESOLVE: their entry left the failing set, or the queue is gone. */
  resolve: string[];
  /** The entries that should hold an item after this tick (the routed window). */
  routed: string[];
}

/** A failing entry is admitted by path only when it IS a path; a leg name is not one. */
function looksLikePath(entry: string): boolean {
  return entry.includes('/') && !/\s/.test(entry);
}

/**
 * PURE: which per-leg items to open and which to resolve on this tick.
 *
 * Change-only by design (D-029). Each leg is broadcast ONCE when it enters the routed
 * window, as a one-shot condition, and resolved explicitly when it leaves — not re-fired
 * every tick. Re-firing up to 12 legs per gate tick would push every one of them into every
 * running agent's inbox on every tick, for the whole life of a red that has already lasted
 * days. Because the plan is recomputed against the condition fold every tick, a lost open
 * or resolve message is repaired on the next tick, which is the property the staleness
 * sweep was otherwise providing.
 *
 * Entries are routed in the queue's own order, de-duplicated, up to MAX_ROUTED_LEGS. A leg
 * beyond the window gets its item when one inside it clears.
 */
export function planFrozenRepairLegRouting(
  input: FrozenRepairLegRoutingInput,
): FrozenRepairLegRoutingPlan {
  const prefix = frozenRepairLegKeyPrefix(input.pipeline);
  const open = new Set(input.openLegKeys.filter((k) => k.startsWith(prefix)));
  const routed: string[] = [];
  if (input.queue) {
    const seen = new Set<string>();
    for (const raw of input.queue.failingTests) {
      if (typeof raw !== 'string') continue;
      const entry = raw.trim();
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      routed.push(entry);
      if (routed.length >= MAX_ROUTED_LEGS) break;
    }
  }
  const wanted = new Set(routed.map((e) => frozenRepairLegConditionKey(input.pipeline, e)));
  const plan: FrozenRepairLegRoutingPlan = { open: [], resolve: [], routed };
  for (const key of open) if (!wanted.has(key)) plan.resolve.push(key);
  plan.resolve.sort();
  if (!input.queue) return plan;
  const total = new Set(
    input.queue.failingTests.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
  ).size;
  for (const entry of routed) {
    const conditionKey = frozenRepairLegConditionKey(input.pipeline, entry);
    if (open.has(conditionKey)) continue;
    plan.open.push({
      conditionKey,
      entry,
      ...buildFrozenRepairLegBroadcast({
        pipeline: input.pipeline,
        candidate: input.queue.candidate,
        repairHead: input.queue.repairHead,
        entry,
        failingCount: total,
        failureTail: input.failureTails?.get(entry) ?? null,
      }),
    });
  }
  return plan;
}

/** PURE: the summary and body of one leg's item. */
export function buildFrozenRepairLegBroadcast(input: {
  pipeline: string;
  candidate: string;
  repairHead: string;
  entry: string;
  failingCount: number;
  failureTail?: string | null;
}): { summary: string; body: string } {
  const tailRaw = input.failureTail?.trim() ?? '';
  const tail =
    tailRaw.length > MAX_FAILURE_TAIL_CHARS
      ? `…[earlier output truncated]\n${tailRaw.slice(-MAX_FAILURE_TAIL_CHARS)}`
      : tailRaw;
  const admit = looksLikePath(input.entry)
    ? `release:repair-queue { op: 'admit', paths: ['${input.entry}'] }`
    : `release:repair-queue { op: 'admit', paths: [ <the files you changed to fix ${input.entry}> ] }`;
  const summary =
    `[${input.pipeline}] failing on frozen candidate ${shortSha(input.candidate)}: ${input.entry} — ` +
    `claimable: fix it and admit the fix (no gate ownership needed).`;
  const body =
    `One failing leg of the frozen repair queue (1 of ${input.failingCount}). Any agent may take ` +
    `it: claim THIS item, fix the leg on the shared staging checkout, wait for git-sync to commit ` +
    `the fix, then admit it onto the frozen lineage. Admission needs no gate ownership and no ` +
    `checkpoint run; the queue re-tests repairHead itself.\n\n` +
    `LEG: ${input.entry}\n` +
    `FROZEN CANDIDATE: ${input.candidate}\n` +
    `CONVERGE ONTO (repairHead): ${input.repairHead}\n\n` +
    `ADMIT WITH (dry run first, then confirm:true):\n    ${admit}\n` +
    `Admission is hunk-exact; a refusal 'admission-incomplete' names a sibling path to admit too.\n\n` +
    `RECORDED FAILURE OUTPUT:\n` +
    (tail
      ? tail
      : '  (none recorded for this leg on the candidate or repairHead; reproduce it with ' +
        `testing:run { files: ['${input.entry}'] } when it is a test file)`) +
    `\n\n⚠ A fix committed to staging tip is NOT in ${shortSha(input.candidate)}: until it is ` +
    `admitted the gate keeps judging the old blob. This item resolves on its own when the leg ` +
    `leaves the queue's failing set (it passed at repairHead) or the queue clears.`;
  return { summary, body };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function renderDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/**
 * PURE: the severe-event alarm that routes a held frozen repair to agents.
 *
 * Returns the `conditionKey` alongside the message so a caller cannot broadcast the body
 * under a hand-typed key — a near-miss key mints a SECOND work-item for the same red, which
 * is the specific failure this whole item exists to avoid.
 *
 * ⚠ `oneShot` is deliberately NOT part of this contract, and that is the opposite choice
 * from the neighbouring `gate-red-streak:<pipeline>` broadcast — read this before "fixing"
 * it. `one_shot` exists (WI-6228) for emitters that fire ONCE per episode and then stay
 * deliberately silent, whose frozen `last_seen` the condition-staleness sweep would
 * otherwise misread as recovery. This emitter is the other kind: it re-fires on EVERY gate
 * tick for as long as the hold is actually held, so its silence genuinely means the hold
 * ended (the wall lifted, the candidate went green, or the queue was retired) and letting
 * `selectAbsentConditions` close it on absence is CORRECT. Marking it one-shot would leave
 * a convergence work-item open pointing at a candidate that no longer exists.
 */
export function buildFrozenRepairConvergenceBroadcast(
  input: FrozenRepairConvergenceRoutingInput,
): { conditionKey: string; summary: string; body: string } {
  const failing = input.failingTests.filter(
    (t) => typeof t === 'string' && t.trim() !== '',
  );
  const named = failing.slice(0, MAX_NAMED_FAILING);
  const remaining = failing.length - named.length;
  const remainingMs = Math.max(0, input.convergenceHoldMs - input.heldMs);

  const wall = input.capacitySummary?.trim()
    ? input.capacitySummary.trim()
    : 'the release-fixer provider has no dispatchable capacity';
  const lifts =
    typeof input.capacityRetryAtMs === 'number' &&
    Number.isFinite(input.capacityRetryAtMs)
      ? ` The wall lifts at ${new Date(input.capacityRetryAtMs).toISOString()}` +
        `${input.capacityRetryAtMs > input.nowMs ? ` (${renderDuration(input.capacityRetryAtMs - input.nowMs)} away)` : ''}.`
      : ' The probe reported no reset time.';

  const summary =
    `[${input.pipeline}] frozen candidate ${shortSha(input.candidate)} is HELD for AGENT convergence — ` +
    `no fixer can be dispatched, so ${failing.length || 'its'} failing ` +
    `${failing.length === 1 ? 'file' : 'files'} must be fixed by agents on the frozen lineage ` +
    `within ${renderDuration(remainingMs)}.`;

  const body =
    `The green-checkpoint's frozen repair queue is being HELD rather than retired: ${wall}.${lifts} ` +
    `Retiring would only re-cut a queue that meets the same wall, so the freeze is kept and ` +
    `agent/human convergence is now the ONLY repair path for this candidate.\n\n` +
    `FROZEN CANDIDATE: ${input.candidate}\n` +
    `CONVERGE ONTO (repairHead): ${input.repairHead}\n` +
    `HELD FOR: ${renderDuration(input.heldMs)} of ${renderDuration(input.convergenceHoldMs)} ` +
    `— ${renderDuration(remainingMs)} before the hold gives up and the candidate is retired.\n` +
    `ADMIT WITH: release:repair-queue { op: 'admit', paths: [<the paths you changed>] } — author on the ` +
    `shared staging checkout, dry-run first, then confirm:true. An edit that is never admitted is ` +
    `invisible to the gate (D-010: there is no repair worktree).\n` +
    `\nFAILING ON THE FROZEN CANDIDATE (${failing.length}):\n` +
    (named.length
      ? named.map((t) => `  · ${t}`).join('\n') +
        (remaining > 0 ? `\n  · … +${remaining} more` : '') +
        '\n'
      : '  (the queue recorded no failing-file list for this round)\n') +
    `\n⚠ FIX ON THE FROZEN LINEAGE, NOT AT TIP. A fix committed to staging tip is NOT in ` +
    `${shortSha(input.candidate)}, so this gate re-reds on the same file and the fix reads as ` +
    `not having worked. Admit it to the queue instead:\n\n` +
    `    release:repair-queue { op: 'admit', paths: [ <the files you fixed> ] }\n\n` +
    `That replays exactly those paths onto \`repairHead\` and the queue re-tests THAT sha. Confirm containment ` +
    `afterwards with \`dev:pipeline_position { path }\` or ` +
    `\`state:read { cell: 'gate.greenCheckpoint.candidate', as: '<path>' }\` — ancestry is not ` +
    `containment.\n\n` +
    `This condition owns ONE work-item for this held candidate, so claim that item rather than ` +
    `opening another. It closes on its own when the hold ends — the wall lifts, the candidate ` +
    `goes green, or the hold budget expires and the candidate is retired.`;

  return {
    conditionKey: frozenRepairConvergenceConditionKey(input.pipeline),
    summary,
    body,
  };
}
