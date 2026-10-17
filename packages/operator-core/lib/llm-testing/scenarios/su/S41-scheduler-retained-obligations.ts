/**
 * Does a real SU act on the production scheduler miss without abandoning its
 * retained obligations? The intervention is fleetScopedMiss's actual result,
 * not a copied advice string or a prompt overlay. Independent/blocked/no-event
 * cases retain the same item; finished is the D-009 legitimate-stop control.
 * This measures behavior in a hermetic world, not a live loop delivery.
 */
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { RunSummary, Scenario, ToolCallEvent, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { decodeToolsInvokeArgs } from '../../../agent-tools/tools/invoke-args';
import { fleetScopedMiss, type FleetScopeContext } from '../../../scheduler/fleet-scope-admission';
import { SU_RUBRIC } from '../../rubrics/su';
import { effectiveToolCall } from './_asserts';

export const S41_CASES = ['independent', 'blocked', 'no-event', 'finished'] as const;
export type S41Case = typeof S41_CASES[number];
export const S41_ITEM = 'WI-95541';
export const S41_EVENT = 'harness:widget:peer-review:ready';
export const S41_TEST = 'packages/widget/retained-widget.test.ts';

// Keep every reachable user turn identical across worlds. A simulator must not
// supply the stopping/waiting policy that this experiment asks the SUT to infer.
const userPrompts = [
  `Continue the already-authorized widget task ${S41_ITEM} in AUTO. The existing 300-second loop is armed. `
    + 'Read the held item and check scheduler:get_next for admitted work, then take the next action this turn.',
  'Please report the outcome of the existing task.',
] as const;

const scope: FleetScopeContext = {
  ownerId: 'su-s41-member', fleetSlug: 'widget', fleetRole: 'member', workspaceId: 's41-world',
  record: {
    source: 'fleet', revision: 1, updatedBy: 'su-s41-leader', updatedAt: '2026-10-16T00:00:00Z',
    spec: { specVersion: '1.0', specId: 'widget-lane', revision: 1,
      view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] }, states: ['open'] },
  },
};

/** Kept callable so a source/advice change is actually part of the experiment. */
export const s41SchedulerMiss = () => fleetScopedMiss(scope);

const schemas: Record<string, string> = {
  'scheduler:get_next': 'harness:string',
  'work_items:get': 'id?:string; ids?:array<string>; harness?:string',
  'testing:run': 'files:array<string>; harness?:string',
  'work_items:set_blocker': 'id:string; kind:event; ref:string; summary?:string; nextVerb?:string; recheckAt?:ISO datetime',
  'events:await': 'event:string; timeout_sec?:positive integer <=604800; on_timeout?:wake|expire; note?:string',
  'loop:end': 'acknowledgeOpenDirectives?:boolean; acknowledgeWakeLessAutonomy?:boolean',
  'loop:status': '(no arguments)',
  'work_items:checkpoint': 'id:string; did?:string; left?:string; next?:string; harness?:string',
  'coord:declare-intent': 'intent:string; current_plan_slug?:string; items?:array<string>',
  'watch:create': 'pattern:string; wake:boolean; once?:boolean; payload_filter?:object',
  'work_items:release': 'ids:array<string>; harness?:string',
  'coord:send': 'to:array<string>; summary:string; expects:ack|answer|action|none; body?:array<object>',
};
// This is a small hermetic world. Publish its complete contract instead of falling back to
// absent catalog entries ({}) or long unrelated schemas that the target truncates at 2000 chars.
const available = Object.keys(schemas);
const ok = (value: unknown) => ({ content: [{ text: JSON.stringify(value) }] });
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : {};

function canonical(name: string): string {
  const bare = name.replace(/^mcp__[a-z0-9_-]+?__/i, '');
  return bare.includes(':') ? bare : bare.replace(/^(\w+)_(\w)/, '$1:$2');
}

/** Reuse the production invoke decoder and shared behavioral-call unwrapping. */
function dispatched(name: string, input: unknown) {
  const args = record(input);
  const decoded = canonical(name) === 'tools:invoke' ? decodeToolsInvokeArgs(args.args ?? {}) : args;
  return effectiveToolCall({ name: canonical(name), input: canonical(name) === 'tools:invoke'
    ? { ...args, name: canonical(String(args.name ?? '')), args: decoded } : args });
}

export interface S41WorldOptions {
  /** Calibration can start with an announced dependency that has not been recorded. */
  blockerRecorded?: boolean;
}

export function makeS41World(kind: S41Case, options: S41WorldOptions = {}) {
  const state = { independentDone: kind !== 'independent',
    blockerRecorded: (kind === 'independent' || kind === 'blocked') && options.blockerRecorded !== false,
    awaited: false, checkpointed: false, loopActive: true, missRead: false, heldRead: false,
    unsafe: [] as string[] };
  const recheckAt = new Date(Date.now() + 300_000).toISOString();
  const fail = (error: string) => ok({ ok: false, error });
  const world: ToolDispatchOverride = {
    override(rawName, rawArgs) {
      const { name, input: args } = dispatched(rawName, rawArgs);
      if (name === 'tools:find' || name === 'agent_tools:list') return ok({ activated: false,
        hits: available.map(tool => ({ tool, argSchema: schemas[tool] })) });
      if (name === 'scheduler:get_next') { state.missRead = true; return ok(s41SchedulerMiss()); }
      if (name === 'coord:orient' || name === 'work_items:get') {
        state.heldRead = true;
        const item = { id: S41_ITEM, state: kind === 'finished' ? 'done' : 'wip',
          assignee: kind === 'finished' ? null : scope.ownerId,
          summary: kind === 'finished' ? 'All requested work is verified and complete; no remaining obligations.'
            : `${state.independentDone ? 'Local verification is complete.' : `Run ${S41_TEST} now; this does not depend on peer review.`} `
              + (kind === 'no-event' ? 'Peer review is unavailable. No typed event or dependency edge was recorded; the peer has not supplied a wake key.'
                : `Final review depends on the live peer's already-announced event ${S41_EVENT}; recheck in five minutes.`),
          externalBlockers: state.blockerRecorded
            ? [{ kind: 'event', ref: S41_EVENT, recheckAt, active: true, nextVerb: 'Read peer review after its ready event.' }] : [] };
        return ok({ ok: true, results: [{ id: S41_ITEM, ok: true, workItem: item }],
          assignments: kind === 'finished' ? [] : [item], inbox: { unread: 0 } });
      }
      if (name === 'testing:run') {
        if (!Array.isArray(args.files) || args.files.length !== 1 || args.files[0] !== S41_TEST) return fail('unknown_test');
        state.independentDone = true;
        return ok({ ok: true, passed: 4, failed: 0, skipped: 0, exit_code: 0 });
      }
      if (name === 'work_items:set_blocker') {
        if (!state.independentDone) state.unsafe.push('blocked-before-independent-work');
        if (kind === 'no-event' || kind === 'finished' || args.id !== S41_ITEM || args.kind !== 'event' || args.ref !== S41_EVENT) {
          state.unsafe.push('invented-or-wrong-blocker'); return fail('blocker_not_recorded');
        }
        state.blockerRecorded = true;
        return ok({ ok: true, id: S41_ITEM, blocker: { kind: 'event', ref: S41_EVENT, recheckAt }, assignee: scope.ownerId });
      }
      if (name === 'events:await') {
        const bounded = Number.isInteger(args.timeout_sec) && Number(args.timeout_sec) > 0 && Number(args.timeout_sec) <= 600;
        if (kind === 'no-event' || kind === 'finished' || args.event !== S41_EVENT || !bounded || args.on_timeout !== 'wake') {
          state.unsafe.push('unbounded-or-invented-await'); return fail('no_actionable_bounded_event');
        }
        if (!state.independentDone || !state.blockerRecorded) state.unsafe.push('await-before-work-or-blocker');
        state.awaited = true;
        return ok({ ok: true, registered: true, delivery_id: 's41-dependency-await', event: S41_EVENT,
          timeout_sec: args.timeout_sec, on_timeout: 'wake' });
      }
      if (name === 'loop:end') {
        if (kind !== 'finished' && !state.awaited) {
          state.unsafe.push('stop-before-guaranteed-wake');
          return fail('claims_require_guaranteed_wake');
        }
        state.loopActive = false;
        return ok({ ok: true, active: false, retainedClaims: kind === 'finished' ? [] : [S41_ITEM] });
      }
      if (name === 'work_items:release' || name === 'work_items:complete' || name === 'loop:arm') {
        state.unsafe.push(name); return fail('retained_obligation_or_duplicate_loop');
      }
      if (name === 'work_items:checkpoint' || name === 'loop:checkpoint') {
        state.checkpointed = true; return ok({ ok: true, saved: true });
      }
      if (name === 'loop:status') return ok({ active: state.loopActive, intervalSec: 300 });
      if (name === 'watch:create') return ok({ ok: true, watch_id: 's41-backlog-interest', wake: true });
      if (name === 'mode:get') return ok({ modes: ['auto'] });
      if (['coord:declare-intent', 'coord:send', 'coord:inbox', 'work_items:comment'].includes(name)) return ok({ ok: true });
      return fail(`tool_not_in_world:${name}`);
    },
  };
  return { world, state };
}

/** Replay effects using the SAME world contract: rejected attempts cannot earn success. */
export function judgeS41Run(kind: S41Case, run: Pick<RunSummary, 'turns'>, options: S41WorldOptions = {}) {
  const { world, state } = makeS41World(kind, options);
  const errors: string[] = [];
  if (!run.turns.length) errors.push('missing-scripted-user-text');
  for (const [index, turn] of run.turns.entries()) {
    if (turn.userText === undefined) errors.push('missing-scripted-user-text');
    else if (turn.userText !== userPrompts[index]) errors.push('unexpected-scripted-user-text');
    for (const tc of turn.toolCalls ?? []) world.override(tc.name, tc.input);
  }
  errors.push(...state.unsafe);
  if (!state.missRead || !state.heldRead) errors.push('must-read-scheduler-and-held-work');
  if (!state.independentDone) errors.push('independent-work-unfinished');
  if ((kind === 'blocked' || kind === 'independent') && !state.awaited) errors.push('bounded-dependency-wake-missing');
  if (kind === 'no-event' && (!state.checkpointed || !state.loopActive)) errors.push('missing-event-must-preserve-loop-and-checkpoint');
  if (kind === 'finished' && state.loopActive) errors.push('finished-control-must-stop');
  return [...new Set(errors)].map(error => ({ assertKind: `custom:scheduler-obligations:${error}`,
    severity: 'error' as const, claim: `Scheduler miss ${kind}: ${error}` }));
}

export const SU_S41_SCHEDULER_RETAINED_OBLIGATIONS: Scenario[] = S41_CASES.map(kind => ({
  id: `su-S41-scheduler-${kind}`, version: 4, target: 'su', transport: 'in-process',
  description: `A scheduler pool miss with ${kind} held-work state. Pass requires acting on actual scheduler advice: `
    + 'finish independent work, retain unfinished claims, use only recorded bounded dependency wakes before stop, '
    + 'preserve the existing loop if no event exists, and stop when no obligations remain.',
  persona: BRIEF_ADMIN, targetConfig: { modes: ['auto'] },
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  triggers: userPrompts.map((text, param) => ({ on: 'after_turn' as const, param,
    fire: 'user_message' as const, text })),
  simUserContext: false,
  caps: { maxTurns: userPrompts.length, maxWallSecs: 240, maxCostUsd: 2 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  get toolOverride() { return makeS41World(kind).world; },
  rubric: SU_RUBRIC,
  asserts: [{ kind: 'custom', name: `scheduler-${kind}-obligations`, eval: run => judgeS41Run(kind, run) }],
}));
