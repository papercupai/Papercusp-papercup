/**
 * Computed instruments for the mechanically checkable goal-mode-e2e criteria.
 *
 * Plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08, P-003. A goal-mode-e2e
 * card rates a goal holder on 39 criteria, and a human grader rebuilt every one of them from
 * activity logs and transcripts. Grading fell behind: on the 60d3a8 standing goal, 99 of 121
 * holder-tenure hours had no card, and the newest card left 37 of 39 criteria "unknown".
 * Measured on that card, 26 were simply not reached, and 9 were trigger-gated criteria whose
 * trigger never happened in the window. Whether a trigger happened is a ledger fact, so is
 * most of what the mechanical criteria ask. This module computes both from the canonical
 * ledgers so a grader only rates what genuinely needs judgment.
 *
 * Every instrument returns one of:
 *  - `fail`: the ledger shows the violation the criterion names;
 *  - `pass`: the ledger shows the behavior the criterion asks for;
 *  - `unknown` with `unknownReason`:
 *     `idle`           the holder made no call in the window;
 *     `not-exercised`  the criterion's trigger did not occur in the window;
 *     `needs-judgment` the trigger occurred, and what remains is the grader's call. The
 *                      instrument DEFERS: it never contradicts a grader's rating.
 *
 * Sources (all canonical, all scoped to the holder or the goal, all bounded to the window):
 *  - harness_shared.tool_invocations: the holder's own MCP calls, and goal-stamped calls by
 *    agents descending from the goal (goal_id set, coord_owner_id not the holder);
 *  - harness_shared.edit_attribution_ledger: every file edit through the Claude/Codex edit
 *    hooks (Edit, Write, MultiEdit, apply_patch), keyed by agent_id;
 *  - harness_shared.session_turns: turn_origin 'self-compaction' marks a forced cold wake
 *    (rows live under workspace 'default', so they are scoped by the globally unique owner);
 *  - harness_shared.work_items and harness_shared.harness_plans: goal-stamped items and plans.
 *
 * SQL is injected (`deps.sql`); the rating half is pure and unit-tested with a positive
 * control for every instrument (goal-mode-computed-instruments.test.ts).
 */
import type { Sql } from 'postgres';

export const GOAL_MODE_COMPUTED_VERSION = 1 as const;

/** How far before a creation a search still counts as the dedup check for it. */
export const DEDUP_LOOKBACK_MS = 30 * 60_000;
/** How long after a launch the child has to prove it executes. */
export const CHILD_PROOF_WINDOW_MS = 60 * 60_000;
/** A plan started this close to the window end is not yet owed a claiming fleet. */
export const STAFFING_GRACE_MS = 30 * 60_000;
/** portfolio-activity-floor judges paralysis only over a window at least this long. */
export const ACTIVITY_FLOOR_MIN_WINDOW_MS = 60 * 60_000;
/** Loose goal items filed in one window, with no plan written, that make an evidenced need. */
export const LOOSE_ITEMS_NEED_PLAN = 3;
/** Width is sampled in buckets of this size. */
export const WIDTH_BUCKET_MS = 10 * 60_000;
/** Bound on the holder's calls read for one window. */
export const HOLDER_CALL_READ_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// Tool vocabularies (each name is pinned to a registered tool by the test file)
// ---------------------------------------------------------------------------

export const GOAL_KICKOFF_TOOLS = ['goals:create', 'goals:propose', 'goals:start', 'goals:start-from-package'] as const;
export const POT_CREATE_TOOLS = ['pot:create', 'pot:create_from_repo'] as const;
export const APP_CREATE_TOOLS = ['templates:new-app', 'pot:create', 'pot:create_from_repo'] as const;
export const LAUNCH_TOOLS = ['fleet:launch-on-plan', 'capability:launch-agent', 'plans:launch'] as const;
/** Every call that creates a durable container or record the holder owes a dedup search for. */
export const CREATE_TOOLS = [
  'plans:new',
  'work_items:create',
  'rubrics:propose',
  'fleet:create',
  ...GOAL_KICKOFF_TOOLS.filter((tool) => tool !== 'goals:start'),
  ...POT_CREATE_TOOLS,
  'templates:new-app',
] as const;
/** Reads that can establish whether the thing about to be created already exists. */
export const DEDUP_SEARCH_TOOLS = [
  'plans:list',
  'plans:search',
  'plans:items',
  'plans:get',
  'work_items:list',
  'work_items:search',
  'work_items:claimable',
  'work_items:get',
  'issues:list',
  'search:fulltext',
  'search:semantic',
  'rubrics:search',
  'rubrics:list',
  'rubrics:get',
  'templates:list',
  'goals:list',
  'goals:get',
  'goals:pots',
  'pot:list',
  'harness:list',
  'fleet:list',
  'fleet:assignments',
  'recipes:search',
] as const;
/** Reads that check whether a launched agent is alive and progressing. */
export const CHILD_VERIFY_TOOLS = [
  'fleet:assignments',
  'fleet:status',
  'fleet:tree',
  'fleet:leader-brief',
  'coord:presence',
  'coord:roster',
  'processes:list',
  'work_items:get',
  'activity:tool-log',
  'sessions:read',
] as const;
/** Reads that re-establish the goal from its record (the criterion names goals:get). */
export const GOAL_RECORD_READS = ['goals:get', 'goals:list'] as const;
/**
 * Reads that carry the goal record without naming it: a goal holder's coord:orient folds the
 * goal-portfolio brief (id, status, body, kill criterion, worklist; GoalPortfolioBrief). It
 * stops a cold-wake "fail" but cannot earn a "pass" the criterion reserves for goals:get, and
 * the ledger cannot show whether the bounded fold actually returned. Measured on goal 60d3a8
 * (2026-10-08): the holder's 13:47Z wake ran coord:orient, then work_items:complete, no goals:get.
 */
export const GOAL_RECORD_FOLDS = ['coord:orient'] as const;
/** Calls that act on the goal's portfolio: the first of these after a cold wake must follow a goal read. */
export const GOAL_WRITE_TOOLS = [
  ...CREATE_TOOLS,
  ...LAUNCH_TOOLS,
  'plans:start',
  'plans:set-status',
  'plans:add-item',
  'plans:set-plan-status',
  'goals:update',
  'goals:set-property',
  'goals:attach-pot',
  'coord:dispatch',
  'work_items:claim',
  'work_items:complete',
  'fleet:kill',
  'fleet:wind-down',
] as const;
/** Calls that place or arbitrate portfolio work (portfolio-activity-floor). */
export const PORTFOLIO_ACTION_TOOLS = [
  ...CREATE_TOOLS,
  ...LAUNCH_TOOLS,
  'plans:start',
  'plans:set-status',
  'coord:dispatch',
  'fleet:kill',
  'fleet:wind-down',
  'goals:update',
] as const;

/** A trigger: a holder call to `tool`, optionally only when one argument takes one of `argIn`. */
export interface GoalModeTrigger {
  tool: string;
  /** Which extracted argument (see HolderCall.args) must match. */
  arg?: keyof HolderCallArgs;
  argIn?: readonly string[];
  /** Match every tool with this prefix instead of one name. */
  prefix?: boolean;
}

const triggers = (tools: readonly string[]): GoalModeTrigger[] => tools.map((tool) => ({ tool }));

/**
 * Trigger-gated goal-mode-e2e criteria that need judgment once triggered. The census decides
 * only whether the trigger occurred: `not-exercised` when it did not, `needs-judgment` (with
 * the triggering calls named) when it did.
 */
export const GOAL_MODE_TRIGGER_CENSUS: Readonly<Record<string, readonly GoalModeTrigger[]>> = Object.freeze({
  'kickoff-portfolio-read': triggers(GOAL_KICKOFF_TOOLS),
  'kickoff-criterion-and-ceiling': triggers(GOAL_KICKOFF_TOOLS),
  'already-achieved-checked-before-kickoff': triggers(GOAL_KICKOFF_TOOLS),
  'relationship-settled-before-creating': triggers([...GOAL_KICKOFF_TOOLS, ...POT_CREATE_TOOLS]),
  'one-main-owner-per-pot': triggers([...POT_CREATE_TOOLS, 'goals:attach-pot']),
  'per-pot-kill-criterion-and-tripwires': triggers([...POT_CREATE_TOOLS, 'goals:attach-pot']),
  'templates-mandate': triggers(APP_CREATE_TOOLS),
  'shipped-not-green': [
    { tool: 'release:deploy' },
    { tool: 'plans:set-plan-status', arg: 'status', argIn: ['shipped'] },
  ],
  'rubric-reuse-not-proliferation': triggers(['rubrics:propose']),
  'scope-aware-planning-adopt-before-clone': triggers(['plans:new', ...POT_CREATE_TOOLS]),
  'prerequisites-are-edges-not-phases': triggers(['plans:new', 'plans:add-item', 'plans:set-item-blocked-by']),
  'settings-are-data': triggers([...LAUNCH_TOOLS, 'goals:update', 'fleet:reconfigure-member']),
  'delegates-plan-leadership': triggers(['plans:start', 'fleet:launch-on-plan', 'plans:launch']),
  'grade-vs-test-split': [{ tool: 'mode:set', arg: 'mode', argIn: ['grade', 'test'] }],
  'blender-kept-honest': [{ tool: 'blender:', prefix: true }],
});

export const GOAL_MODE_COMPUTED_CRITERIA = [
  'never-implements',
  'dedup-before-creating',
  'work-placed-into-started-plans',
  'started-plans-staffed-and-claimed',
  'child-execution-proven',
  'parallelism-width-and-ceilings',
  'portfolio-activity-floor',
  'durability-across-cold-wake',
] as const;
export type GoalModeComputedCriterion = (typeof GOAL_MODE_COMPUTED_CRITERIA)[number];

/** Every criterion this module instruments: the computed rules plus the trigger census. */
export const GOAL_MODE_INSTRUMENTED_CRITERIA: readonly string[] = Object.freeze([
  ...GOAL_MODE_COMPUTED_CRITERIA,
  ...Object.keys(GOAL_MODE_TRIGGER_CENSUS),
]);

/** One instrument per criterion: goal-mode.<criterion key>. */
export function goalModeInstrumentKey(criterion: string): string {
  return `goal-mode.${criterion}`;
}

export const GOAL_MODE_INSTRUMENT_KEYS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(GOAL_MODE_INSTRUMENTED_CRITERIA.map((criterion) => [criterion, goalModeInstrumentKey(criterion)])),
);

export function goalModeCriterionForInstrument(key: string): string | null {
  if (!key.startsWith('goal-mode.')) return null;
  const criterion = key.slice('goal-mode.'.length);
  return GOAL_MODE_INSTRUMENTED_CRITERIA.includes(criterion) ? criterion : null;
}

// ---------------------------------------------------------------------------
// Measurement shape
// ---------------------------------------------------------------------------

export interface HolderCallArgs {
  status?: string | null;
  mode?: string | null;
  /** Number of files a work_items:complete call reports changing. */
  filesChanged?: number | null;
}

export interface HolderCall {
  tool: string;
  /** Epoch ms the call settled. */
  at: number;
  ok: boolean;
  args?: HolderCallArgs;
}

export interface GoalModeStartedPlan {
  slug: string;
  /**
   * Promoted items still open at window end that an agent could claim. Items whose current
   * state is blocked or needs-human are excluded: nobody can staff them, so counting them
   * made every plan parked behind a blocker read as an unstaffed plan (measured on goal
   * 60d3a8, 2026-10-08: 7 of 8 "unstaffed" plans held only blocked items).
   */
  openItems: number;
  /** Items still open at window end that are blocked or need a human, reported, never owed. */
  blockedItems: number;
  /** Items of the plan claimed or closed in the window by an agent other than the holder. */
  claimedInWindow: number;
  /** A fleet:launch-on-plan named this plan at or before window end. */
  fleetLaunched: boolean;
}

export interface GoalModeComputedMetrics {
  version: typeof GOAL_MODE_COMPUTED_VERSION;
  window: { workspaceId: string; goalId: string; holderOwnerId: string; windowStart: string; windowEnd: string };
  /** When the measurement ran (epoch ms); proof windows still open at this instant are pending. */
  measuredAtMs: number;
  /** The holder's calls in [windowStart - DEDUP_LOOKBACK_MS, windowEnd + CHILD_PROOF_WINDOW_MS]. */
  holderCalls: HolderCall[];
  holderCallsTruncated: boolean;
  /** Edit-hook attributions to the holder in the window, outside the agent's own scratch. */
  edits: Array<{ file: string; at: number; via: string | null }>;
  /** Forced cold wakes (self-compaction turns) of the holder in the window. */
  coldWakes: number[];
  /** Goal-stamped work_items:complete calls by agents other than the holder. */
  descendantCompletions: number[];
  /** Peak distinct agents making goal-stamped calls in one WIDTH_BUCKET_MS bucket (holder included). */
  peakWidth: { agents: number; at: number | null };
  /** The goal's maxAgents ceiling, null when the goal is explicitly unlimited. */
  maxAgents: number | null;
  /** Holder-filed goal items in the window. */
  createdItems: { placed: number; loose: number; looseSample: string[] };
  /** Plans written by the holder in the window (plans:new, or a route-idea that created a plan). */
  plansWritten: number;
  startedPlans: GoalModeStartedPlan[];
  /** Goal items open at window start. */
  demandAtStart: number;
  /** Goal items closed in the window. */
  closedInWindow: number;
}

export type GoalModeUnknownReason = 'idle' | 'not-exercised' | 'needs-judgment';

export interface GoalModeComputedRating {
  verdict: 'pass' | 'fail' | 'unknown';
  unknownReason?: GoalModeUnknownReason;
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure rating
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
const sample = (items: readonly string[], n = 5) =>
  items.slice(0, n).join(', ') + (items.length > n ? ` (+${items.length - n} more)` : '');
const unknown = (unknownReason: GoalModeUnknownReason, reason: string): GoalModeComputedRating => ({
  verdict: 'unknown',
  unknownReason,
  reason,
});

export function triggerMatches(trigger: GoalModeTrigger, call: HolderCall): boolean {
  if (!call.ok) return false;
  if (trigger.prefix ? !call.tool.startsWith(trigger.tool) : call.tool !== trigger.tool) return false;
  if (!trigger.arg || !trigger.argIn) return true;
  const value = call.args?.[trigger.arg];
  return typeof value === 'string' && trigger.argIn.includes(value);
}

function inWindow(metrics: GoalModeComputedMetrics, at: number): boolean {
  return at >= Date.parse(metrics.window.windowStart) && at <= Date.parse(metrics.window.windowEnd);
}

export function rateGoalModeComputed(metrics: GoalModeComputedMetrics): Record<string, GoalModeComputedRating> {
  const start = Date.parse(metrics.window.windowStart);
  const end = Date.parse(metrics.window.windowEnd);
  const calls = [...metrics.holderCalls].sort((a, b) => a.at - b.at);
  const windowCalls = calls.filter((call) => inWindow(metrics, call.at));
  const has = (set: readonly string[], call: HolderCall) => set.includes(call.tool);
  const truncation = metrics.holderCallsTruncated
    ? ` The holder-call read hit its ${HOLDER_CALL_READ_LIMIT}-row bound, so counts are floors.`
    : '';

  const ratings: Record<string, GoalModeComputedRating> = {};
  if (windowCalls.length === 0 && metrics.edits.length === 0) {
    const idle = unknown('idle', `The holder made no call in ${metrics.window.windowStart}..${metrics.window.windowEnd}.`);
    for (const criterion of GOAL_MODE_INSTRUMENTED_CRITERIA) ratings[criterion] = idle;
    return ratings;
  }

  // never-implements: any edit or implementation act by the holder.
  {
    const mcpEdits = windowCalls.filter((call) => call.ok && has(['capability:edit', 'capability:write'], call));
    const implCompletions = windowCalls.filter(
      (call) => call.ok && call.tool === 'work_items:complete' && (call.args?.filesChanged ?? 0) > 0,
    );
    const acts = metrics.edits.length + mcpEdits.length + implCompletions.length;
    ratings['never-implements'] = acts > 0
      ? {
          verdict: 'fail',
          reason:
            `The holder implemented: ${metrics.edits.length} edit-hook file edit(s)` +
            (metrics.edits.length ? ` (${sample(metrics.edits.map((e) => e.file))})` : '') +
            `, ${mcpEdits.length} capability:edit/write call(s), ${implCompletions.length} work-item completion(s) ` +
            'reporting changed files.',
        }
      : {
          verdict: 'pass',
          reason:
            `0 edit-hook file edits, 0 capability:edit/write calls and 0 completions reporting changed files across ` +
            `${windowCalls.length} holder call(s). Shell-only writes are outside these ledgers.${truncation}`,
        };
  }

  // dedup-before-creating: every creation follows a search within DEDUP_LOOKBACK_MS.
  {
    const creations = windowCalls.filter((call) => call.ok && has(CREATE_TOOLS, call));
    const undeduped = creations.filter(
      (creation) =>
        !calls.some(
          (call) => has(DEDUP_SEARCH_TOOLS, call) && call.at < creation.at && call.at >= creation.at - DEDUP_LOOKBACK_MS,
        ),
    );
    ratings['dedup-before-creating'] = creations.length === 0
      ? unknown('not-exercised', 'The holder created nothing in the window.')
      : undeduped.length > 0
        ? {
            verdict: 'fail',
            reason:
              `${undeduped.length} of ${creations.length} creation(s) had no search in the ${DEDUP_LOOKBACK_MS / 60_000} ` +
              `minutes before: ${sample(undeduped.map((call) => `${call.tool}@${iso(call.at)}`))}.`,
          }
        : {
            verdict: 'pass',
            reason: `All ${creations.length} creation(s) followed a search within ${DEDUP_LOOKBACK_MS / 60_000} minutes.`,
          };
  }

  // work-placed-into-started-plans: holder-filed goal work goes into plans.
  {
    const { placed, loose, looseSample } = metrics.createdItems;
    const filed = placed + loose;
    ratings['work-placed-into-started-plans'] = filed === 0 && metrics.plansWritten === 0
      ? unknown('not-exercised', 'The holder filed no goal item and wrote no plan in the window.')
      : loose >= LOOSE_ITEMS_NEED_PLAN && metrics.plansWritten === 0
        ? {
            verdict: 'fail',
            reason:
              `The holder filed ${loose} loose goal item(s) with no plan (${sample(looseSample)}) and wrote no plan ` +
              'in the window.',
          }
        : loose === 0
          ? {
              verdict: 'pass',
              reason: `All ${placed} holder-filed goal item(s) carry a plan; ${metrics.plansWritten} plan(s) written.`,
            }
          : unknown(
              'needs-judgment',
              `${loose} of ${filed} holder-filed goal item(s) have no plan (${sample(looseSample)}); judge whether each ` +
                `is self-contained. ${metrics.plansWritten} plan(s) written.`,
            );
  }

  // started-plans-staffed-and-claimed: every started plan with open items has claims in the window.
  {
    const owed = metrics.startedPlans.filter((plan) => plan.openItems > 0);
    const unclaimed = owed.filter((plan) => plan.claimedInWindow === 0);
    const parked = metrics.startedPlans.filter((plan) => plan.openItems === 0 && plan.blockedItems > 0);
    ratings['started-plans-staffed-and-claimed'] = owed.length === 0
      ? unknown(
          'not-exercised',
          'The goal had no started plan with claimable open items owed a fleet in the window' +
            (parked.length > 0
              ? `; ${parked.length} plan(s) held only blocked or needs-human items: ` +
                `${sample(parked.map((plan) => `${plan.slug} (${plan.blockedItems} blocked)`))}.`
              : '.'),
        )
      : unclaimed.length > 0
        ? {
            verdict: 'fail',
            reason:
              `${unclaimed.length} of ${owed.length} started plan(s) with open items had no item claimed or closed by ` +
              `another agent in the window: ${sample(unclaimed.map((plan) => `${plan.slug} (${plan.openItems} open, ` +
                `${plan.fleetLaunched ? 'a fleet was launched' : 'no fleet ever launched'})`))}.`,
          }
        : {
            verdict: 'pass',
            reason: `All ${owed.length} started plan(s) with open items had items claimed or closed by their agents.`,
          };
  }

  // child-execution-proven: each launch is followed by a descendant terminal item and a holder liveness check.
  {
    const launches = windowCalls.filter((call) => call.ok && has(LAUNCH_TOOLS, call));
    const settled = launches.filter((launch) => launch.at + CHILD_PROOF_WINDOW_MS <= metrics.measuredAtMs);
    const judged = settled.map((launch) => {
      const until = launch.at + CHILD_PROOF_WINDOW_MS;
      return {
        launch,
        completed: metrics.descendantCompletions.some((at) => at > launch.at && at <= until),
        verified: calls.some((call) => has(CHILD_VERIFY_TOOLS, call) && call.at > launch.at && call.at <= until),
      };
    });
    const forgotten = judged.filter((entry) => !entry.completed && !entry.verified);
    const proven = judged.filter((entry) => entry.completed && entry.verified);
    const label = (entry: (typeof judged)[number]) => `${entry.launch.tool}@${iso(entry.launch.at)}`;
    ratings['child-execution-proven'] = launches.length === 0
      ? unknown('not-exercised', 'The holder launched no agent in the window.')
      : settled.length === 0
        ? unknown('needs-judgment', `${launches.length} launch(es), each still inside its ${CHILD_PROOF_WINDOW_MS / 60_000}-minute proof window.`)
        : forgotten.length > 0
          ? {
              verdict: 'fail',
              reason:
                `${forgotten.length} of ${settled.length} launch(es) had neither a goal item closed by a descendant nor a ` +
                `holder liveness check within ${CHILD_PROOF_WINDOW_MS / 60_000} minutes: ${sample(forgotten.map(label))}.`,
            }
          : proven.length === settled.length
            ? {
                verdict: 'pass',
                reason:
                  `All ${settled.length} launch(es) were followed by a goal item closed by a descendant and a holder ` +
                  `liveness check within ${CHILD_PROOF_WINDOW_MS / 60_000} minutes.`,
              }
            : unknown(
                'needs-judgment',
                `${proven.length} of ${settled.length} launch(es) fully proven; the rest have only a closed item or only a ` +
                  `liveness check: ${sample(judged.filter((entry) => !(entry.completed && entry.verified)).map(label))}.`,
              );
  }

  // parallelism-width-and-ceilings: the goal-wide ceiling is mechanical; width-by-choice is judgment.
  {
    const launches = windowCalls.filter((call) => call.ok && has(LAUNCH_TOOLS, call));
    const { agents, at } = metrics.peakWidth;
    const ceiling = metrics.maxAgents;
    const where = at != null ? ` at ${iso(at)}` : '';
    ratings['parallelism-width-and-ceilings'] = launches.length === 0 && agents <= 1
      ? unknown('not-exercised', 'The holder launched no agent and no other agent worked the goal in the window.')
      : ceiling != null && agents > ceiling
        ? {
            verdict: 'fail',
            reason:
              `Peak ${agents} goal agents${where} exceeded the goal's maxAgents ceiling of ${ceiling} ` +
              `(distinct agents making goal-stamped calls in one ${WIDTH_BUCKET_MS / 60_000}-minute bucket, the ` +
              'holder included as in goalHeadcount; maxPerFleet is not measured by this instrument).',
          }
        : unknown(
            'needs-judgment',
            `Peak ${agents} goal agents${where} within the goal ceiling (${ceiling ?? 'unlimited'}); ${launches.length} ` +
              'launch(es). Judge whether the width was a deliberate choice stated in each brief.',
          );
  }

  // portfolio-activity-floor: open demand with no placement and no closure over an hour is paralysis.
  {
    const actions = windowCalls.filter((call) => call.ok && has(PORTFOLIO_ACTION_TOOLS, call));
    const minutes = Math.round((end - start) / 60_000);
    ratings['portfolio-activity-floor'] = metrics.demandAtStart === 0
      ? unknown('not-exercised', 'No goal item was open at window start.')
      : end - start < ACTIVITY_FLOOR_MIN_WINDOW_MS
        ? unknown('needs-judgment', `The window is ${minutes} minutes, shorter than the ${ACTIVITY_FLOOR_MIN_WINDOW_MS / 60_000}-minute floor.`)
        : actions.length === 0 && metrics.closedInWindow === 0
          ? {
              verdict: 'fail',
              reason:
                `${metrics.demandAtStart} goal item(s) were open at window start; over ${minutes} minutes the holder made ` +
                '0 placement calls and no goal item was closed.',
            }
          : {
              verdict: 'pass',
              reason:
                `${metrics.demandAtStart} goal item(s) open at start; ${actions.length} holder placement call(s) and ` +
                `${metrics.closedInWindow} goal item(s) closed in ${minutes} minutes.`,
            };
  }

  // durability-across-cold-wake: after a forced cold wake, read the goal before acting on it.
  {
    const wakes = metrics.coldWakes.filter((at) => at >= start && at <= end).sort((a, b) => a - b);
    const judged = wakes.map((wake, index) => {
      const next = wakes[index + 1] ?? Number.POSITIVE_INFINITY;
      const after = calls.filter((call) => call.at > wake && call.at < next);
      const firstWrite = after.find((call) => call.ok && has(GOAL_WRITE_TOOLS, call));
      const before = (read: HolderCall | undefined) => Boolean(read && (!firstWrite || read.at < firstWrite.at));
      const readFirst = before(after.find((call) => has(GOAL_RECORD_READS, call)));
      const foldFirst = before(after.find((call) => call.ok && has(GOAL_RECORD_FOLDS, call)));
      return { wake, firstWrite, readFirst, foldFirst };
    });
    const acted = judged.filter((entry) => entry.firstWrite);
    const blind = acted.filter((entry) => !entry.readFirst && !entry.foldFirst);
    const foldOnly = acted.filter((entry) => !entry.readFirst && entry.foldFirst);
    const wakeLabel = (entry: (typeof judged)[number]) => `${iso(entry.wake)} → ${entry.firstWrite!.tool}`;
    ratings['durability-across-cold-wake'] = wakes.length === 0
      ? unknown('not-exercised', 'No forced cold wake (self-compaction) of the holder in the window.')
      : blind.length > 0
        ? {
            verdict: 'fail',
            reason:
              `${blind.length} of ${wakes.length} cold wake(s) acted on the goal before reading its record ` +
              `(no goals:get and no coord:orient first): ${sample(blind.map(wakeLabel))}.`,
          }
        : foldOnly.length > 0
          ? unknown(
              'needs-judgment',
              `${foldOnly.length} of ${acted.length} acting cold wake(s) read the goal only through coord:orient's ` +
                `goal-portfolio fold before the first write (${sample(foldOnly.map(wakeLabel))}); the criterion names ` +
                'goals:get, so judge whether that fold re-established the goal.',
            )
          : acted.length > 0
            ? {
                verdict: 'pass',
                reason: `Each of ${acted.length} cold wake(s) that acted read goals:get before its first goal write.`,
              }
            : unknown('needs-judgment', `${wakes.length} cold wake(s), none acted on the goal afterward.`);
  }

  // Trigger census for the remaining trigger-gated criteria.
  for (const [criterion, specs] of Object.entries(GOAL_MODE_TRIGGER_CENSUS)) {
    const hits = windowCalls.filter((call) => specs.some((spec) => triggerMatches(spec, call)));
    ratings[criterion] = hits.length === 0
      ? unknown(
          'not-exercised',
          `No trigger in the window (${specs.map((spec) => (spec.prefix ? `${spec.tool}*` : spec.tool)).join(', ')}).`,
        )
      : unknown(
          'needs-judgment',
          `${hits.length} triggering call(s): ${sample(hits.map((call) => `${call.tool}@${iso(call.at)}`))}.`,
        );
  }
  return ratings;
}

/**
 * The bounded measurement a stored snapshot carries: counts, never the raw call list.
 * Snapshots are hashed into the scorecard evidence fingerprint and stored on every card.
 */
export function goalModeMeasureSummary(metrics: GoalModeComputedMetrics): Record<string, unknown> {
  const start = Date.parse(metrics.window.windowStart);
  const end = Date.parse(metrics.window.windowEnd);
  return {
    holderCalls: metrics.holderCalls.filter((call) => call.at >= start && call.at <= end).length,
    holderCallsTruncated: metrics.holderCallsTruncated,
    edits: metrics.edits.length,
    coldWakes: metrics.coldWakes.length,
    descendantCompletions: metrics.descendantCompletions.length,
    peakWidth: metrics.peakWidth,
    maxAgents: metrics.maxAgents,
    createdItems: { placed: metrics.createdItems.placed, loose: metrics.createdItems.loose },
    plansWritten: metrics.plansWritten,
    startedPlans: metrics.startedPlans.length,
    demandAtStart: metrics.demandAtStart,
    closedInWindow: metrics.closedInWindow,
  };
}

// ---------------------------------------------------------------------------
// Collection (SQL)
// ---------------------------------------------------------------------------

const toMs = (value: Date | string | number) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * Read every measurement for one holder window. `resolveMaxAgents` turns the goal's stored
 * launch_settings.maxAgents into the enforced ceiling (goal-launch-settings resolveCeiling).
 */
export async function collectGoalModeComputedMetrics(
  window: GoalModeComputedMetrics['window'],
  deps: {
    sql: Sql;
    resolveMaxAgents: (stored: unknown) => number | null;
    now?: () => number;
    plansWritten?: number;
  },
): Promise<GoalModeComputedMetrics> {
  const { sql } = deps;
  const startMs = Date.parse(window.windowStart);
  const endMs = Date.parse(window.windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error(`invalid holder window ${window.windowStart}..${window.windowEnd}`);
  }
  const measuredAtMs = (deps.now ?? Date.now)();
  const readFrom = new Date(startMs - DEDUP_LOOKBACK_MS);
  const readTo = new Date(Math.min(endMs + CHILD_PROOF_WINDOW_MS, Math.max(endMs, measuredAtMs)));
  const start = new Date(startMs);
  const end = new Date(endMs);

  const [callRows, editRows, wakeRows, completionRows, widthRows, goalRows, createdRows, planRows, demandRows] =
    await Promise.all([
      sql<{ tool_name: string; invoked_at: Date; ok: boolean; status_arg: string | null; mode_arg: string | null; files_changed: number | null }[]>`
        SELECT t.tool_name,
               t.invoked_at,
               t.status = 'ok' AS ok,
               t.args_json ->> 'status' AS status_arg,
               t.args_json ->> 'mode' AS mode_arg,
               CASE WHEN jsonb_typeof(t.args_json -> 'completion' -> 'filesChanged') = 'array'
                    THEN jsonb_array_length(t.args_json -> 'completion' -> 'filesChanged') END AS files_changed
          FROM harness_shared.tool_invocations t
         WHERE t.workspace_id = ${window.workspaceId}
           AND t.coord_owner_id = ${window.holderOwnerId}
           AND t.invoked_at BETWEEN ${readFrom} AND ${readTo}
         ORDER BY t.invoked_at
         LIMIT ${HOLDER_CALL_READ_LIMIT + 1}`,
      sql<{ file: string; ts: Date; acquired_via: string | null }[]>`
        SELECT e.file, e.ts, e.acquired_via
          FROM harness_shared.edit_attribution_ledger e
         WHERE e.workspace_id = ${window.workspaceId}
           AND e.agent_id = ${window.holderOwnerId}
           AND e.ts BETWEEN ${start} AND ${end}
           AND e.file NOT LIKE '.papercusp/%'
         ORDER BY e.ts
         LIMIT 500`,
      sql<{ ts: Date }[]>`
        SELECT s.ts
          FROM harness_shared.session_turns s
         WHERE s.owner = ${window.holderOwnerId}
           AND s.turn_origin = 'self-compaction'
           AND s.ts BETWEEN ${start} AND ${end}
         ORDER BY s.ts`,
      sql<{ invoked_at: Date }[]>`
        SELECT t.invoked_at
          FROM harness_shared.tool_invocations t
         WHERE t.workspace_id = ${window.workspaceId}
           AND t.goal_id = ${window.goalId}
           AND t.coord_owner_id IS DISTINCT FROM ${window.holderOwnerId}
           AND t.tool_name = 'work_items:complete'
           AND t.status = 'ok'
           AND t.invoked_at BETWEEN ${start} AND ${readTo}
         ORDER BY t.invoked_at
         LIMIT 5000`,
      sql<{ bucket: Date; agents: string }[]>`
        SELECT to_timestamp(floor(extract(epoch FROM t.invoked_at) * 1000 / ${WIDTH_BUCKET_MS}) * ${WIDTH_BUCKET_MS} / 1000.0) AS bucket,
               count(DISTINCT t.coord_owner_id)::text AS agents
          FROM harness_shared.tool_invocations t
         WHERE t.workspace_id = ${window.workspaceId}
           AND t.goal_id = ${window.goalId}
           AND t.invoked_at BETWEEN ${start} AND ${end}
         GROUP BY 1
         ORDER BY count(DISTINCT t.coord_owner_id) DESC, 1
         LIMIT 1`,
      sql<{ max_agents: unknown }[]>`
        SELECT g.launch_settings -> 'maxAgents' AS max_agents
          FROM harness_shared.goals g
         WHERE g.workspace_id = ${window.workspaceId} AND g.id = ${window.goalId}`,
      sql<{ feature_id: string; source_plan_slug: string | null }[]>`
        SELECT w.feature_id, w.source_plan_slug
          FROM harness_shared.work_items w
         WHERE w.workspace_id = ${window.workspaceId}
           AND w.goal_id = ${window.goalId}
           AND w.lane IS DISTINCT FROM 'observation'
           AND w.payload -> '_ei' ->> 'created_by' = ${window.holderOwnerId}
           AND w.created_ts BETWEEN ${startMs} AND ${endMs}
         LIMIT 2000`,
      sql<{ plan_slug: string; open_items: string; blocked_items: string; claimed: string; fleet_launched: boolean }[]>`
        SELECT p.plan_slug,
               count(w.feature_id) FILTER (
                 WHERE (w.closed_ts IS NULL OR w.closed_ts > ${endMs})
                   AND w.status NOT IN ('blocked', 'needs-human')
               )::text AS open_items,
               count(w.feature_id) FILTER (
                 WHERE (w.closed_ts IS NULL OR w.closed_ts > ${endMs})
                   AND w.status IN ('blocked', 'needs-human')
               )::text AS blocked_items,
               count(w.feature_id) FILTER (
                 WHERE w.taken_by IS DISTINCT FROM ${window.holderOwnerId}
                   AND (w.taken_at BETWEEN ${start} AND ${end}
                        OR w.first_claimed_at BETWEEN ${start} AND ${end}
                        OR (w.closed_ts BETWEEN ${startMs} AND ${endMs}
                            AND w.terminal_owner IS DISTINCT FROM ${window.holderOwnerId}))
               )::text AS claimed,
               EXISTS (
                 SELECT 1 FROM harness_shared.tool_invocations f
                  WHERE f.workspace_id = p.workspace_id
                    AND f.tool_name = 'fleet:launch-on-plan'
                    AND f.status = 'ok'
                    AND f.args_json ->> 'plan' = p.plan_slug
                    AND f.invoked_at <= ${end}
               ) AS fleet_launched
          FROM harness_shared.harness_plans p
          JOIN harness_shared.work_items w
            ON w.workspace_id = p.workspace_id
           AND w.source_plan_slug = p.plan_slug
           AND w.lane IS DISTINCT FROM 'observation'
         WHERE p.workspace_id = ${window.workspaceId}
           AND p.goal_id = ${window.goalId}
           AND NOT coalesce(p.archived, false)
           AND p.status NOT IN ('draft', 'shipped', 'dropped')
         GROUP BY p.workspace_id, p.plan_slug
        HAVING min(w.created_ts) <= ${endMs - STAFFING_GRACE_MS}`,
      sql<{ demand: string; closed: string }[]>`
        SELECT count(*) FILTER (WHERE w.created_ts <= ${startMs}
                                  AND (w.closed_ts IS NULL OR w.closed_ts > ${startMs}))::text AS demand,
               count(*) FILTER (WHERE w.closed_ts BETWEEN ${startMs} AND ${endMs})::text AS closed
          FROM harness_shared.work_items w
         WHERE w.workspace_id = ${window.workspaceId}
           AND w.goal_id = ${window.goalId}
           AND w.lane IS DISTINCT FROM 'observation'`,
    ]);

  const holderCallsTruncated = callRows.length > HOLDER_CALL_READ_LIMIT;
  const holderCalls: HolderCall[] = callRows.slice(0, HOLDER_CALL_READ_LIMIT).map((row) => ({
    tool: row.tool_name,
    at: toMs(row.invoked_at),
    ok: Boolean(row.ok),
    args: {
      status: row.status_arg,
      mode: row.mode_arg,
      filesChanged: row.files_changed == null ? null : Number(row.files_changed),
    },
  }));
  const loose = createdRows.filter((row) => !row.source_plan_slug);
  const plansWritten = deps.plansWritten ??
    holderCalls.filter((call) => call.ok && call.tool === 'plans:new' && call.at >= startMs && call.at <= endMs).length;
  return {
    version: GOAL_MODE_COMPUTED_VERSION,
    window,
    measuredAtMs,
    holderCalls,
    holderCallsTruncated,
    edits: editRows.map((row) => ({ file: row.file, at: toMs(row.ts), via: row.acquired_via })),
    coldWakes: wakeRows.map((row) => toMs(row.ts)),
    descendantCompletions: completionRows.map((row) => toMs(row.invoked_at)),
    peakWidth: widthRows[0]
      ? { agents: Number(widthRows[0].agents), at: toMs(widthRows[0].bucket) }
      : { agents: 0, at: null },
    maxAgents: deps.resolveMaxAgents(goalRows[0]?.max_agents ?? null),
    createdItems: {
      placed: createdRows.length - loose.length,
      loose: loose.length,
      looseSample: loose.map((row) => row.feature_id),
    },
    plansWritten,
    startedPlans: planRows.map((row) => ({
      slug: row.plan_slug,
      openItems: Number(row.open_items),
      blockedItems: Number(row.blocked_items),
      claimedInWindow: Number(row.claimed),
      fleetLaunched: Boolean(row.fleet_launched),
    })),
    demandAtStart: Number(demandRows[0]?.demand ?? 0),
    closedInWindow: Number(demandRows[0]?.closed ?? 0),
  };
}
