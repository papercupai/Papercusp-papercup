/**
 * coord:await-inbox — idle-state annotation and repair for the standing
 * inbox-wake watch (turn-lifecycle-control-2026-06-08 D-005; was the wake
 * scaffold of local-hive-orchestration-2026-06-06 Phase 4 P-041).
 *
 * Arming is normally automatic: the operator (re-)arms each agent's standing
 * inbox-wake watch at SessionStart (always-arm, D-001). A lifecycle race or
 * lapsed watch can still leave the current session temporarily unwakeable, so
 * this tool refreshes the row through `armInboxWake` and reports a live
 * before/after reachability verdict. It still ends with "now end your turn".
 *
 * The `min_sleep_sec` floor bounds the re-wake burn if a Queen fires several
 * sends in a burst (they coalesce into one wake).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { armInboxWake } from '../../../events/await/inbox-wake-arm';
import { EXPLICIT_PARK_NOTE_MARKER } from '../../../events/await/types';
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../../events/await/wake-reachability';
import { softText, clampText, LIMITS } from '../../limits';

type ReachabilitySnapshot = Pick<
  WakeReachabilityVerdict,
  'reachable' | 'channel' | 'durableWhileAlive' | 'summary' | 'warning' | 'awaitRepairable' | 'wouldBeChannel'
>;

function snapshotReachability(verdict: WakeReachabilityVerdict | null): ReachabilitySnapshot | null {
  if (!verdict) return null;
  return {
    reachable: verdict.reachable,
    channel: verdict.channel,
    durableWhileAlive: verdict.durableWhileAlive,
    summary: verdict.summary,
    ...(verdict.warning ? { warning: verdict.warning } : {}),
    awaitRepairable: verdict.awaitRepairable,
    wouldBeChannel: verdict.wouldBeChannel,
  };
}

export function reachabilityAdvice(
  before: WakeReachabilityVerdict | null,
  after: WakeReachabilityVerdict | null,
): string {
  if (!after) {
    return (
      'Inbox-wake watch refreshed, but live reachability could not be measured. ' +
      'If you hold unfinished work in an autonomy mode and have neither an armed loop nor a guaranteed wake, ' +
      'do not end yet: add a bounded events:await with on_timeout:"wake", complete the work, or release it. ' +
      'If no unfinished work remains or a loop/guaranteed wake exists, END YOUR TURN. Do not poll.'
    );
  }

  if (after.reachable) {
    const reachability = before?.reachable
      ? 'It was already wake-reachable via ' + before.channel + ' and is reachable via ' + after.channel + ' now.'
      : before?.awaitRepairable
        ? 'You were unarmed before this call; it is now wake-reachable via ' + after.channel + '.'
        : 'It is now wake-reachable via ' + after.channel + '.';
    return (
      'Inbox-wake watch refreshed. ' +
      reachability +
      ' It can receive an incoming coord:send with {wake:true}, but this unbounded standing watch is not a guaranteed timed wake. ' +
      'If you hold unfinished work in an autonomy mode and have neither an armed loop nor a guaranteed wake, do not end yet: ' +
      'register a bounded events:await for the blocker or this inbox key with timeout_sec and on_timeout:"wake", ' +
      'arm a loop, complete the work, or release it. ' +
      'If no unfinished work remains or a guaranteed wake is active, END YOUR TURN. Do not poll.'
    );
  }

  return (
    'Inbox-wake watch refreshed, but it is still NOT wake-reachable: ' +
    after.summary +
    '. If you hold unfinished autonomous work, END YOUR TURN only when another guaranteed wake source will resume you; ' +
    'otherwise fix the reported reachability issue or add a bounded wake. If no unfinished work remains, END YOUR TURN. Do not poll.'
  );
}

export default defineTool({
  name: 'coord:await-inbox',
  description:
    'Annotate your idle state at end-of-turn: refresh the "why I am idle" note on your inbox-wake watch (and optionally its wake floor), and report live reachability before and after the refresh. Use the returned advice to decide whether it is safe to end your turn: a reachable standing inbox watch can receive a message, but is not a guaranteed timed wake for autonomous sessions holding unfinished work. SessionStart normally arms the watch, but a lifecycle race or lapse can leave it unarmed. Returns the watch id, inbox-wake key, and reachability evidence.',
  guidance: {
    when:
      'Optional, at end-of-turn when idle — to record WHY you are idle (the note rides the wake turn), tune your wake floor, and verify/repair the standing inbox-wake watch. Read the returned before/after reachability verdict and advice. If you hold unfinished work in an autonomy mode, end only when a loop or guaranteed wake exists, or after completing/releasing the work.',
    notWhen:
      'You still have queued work — keep going. A specific one-shot readiness (a lock grant, a peer\'s artifact) — use events:await on that exact key. A sub-minute wait inside one turn — just block.',
    chaining:
      'coord:await-inbox → check the advice against your held-work and loop state before ending. On wake the turn text carries the message that woke you (read coord:inbox for the full set). To stop watching: events:cancel.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why you are idle / what you are waiting for — echoed into the wake turn. Auto-truncated to 2000 chars if longer.'),
    min_sleep_sec: z
      .number()
      .int()
      .nonnegative()
      .max(7 * 24 * 60 * 60)
      .optional()
      .describe(
        'Per-subscriber wake floor: never re-wake within this window; a burst of sends inside it coalesces into ONE wake. Default: a sane standing floor.',
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('If you are a plan run, the wake resumes the run via plans:resume instead of a session resume.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // SessionStart normally arms this standing row (always-arm, D-001), but a
    // lifecycle race or lapse can leave it absent. Capture the live verdict on
    // both sides of the idempotent refresh so the caller sees whether this call
    // repaired a missing await or merely refreshed an already-armed one.
    const beforeReachability = await probeWakeReachability(identity.ownerId).catch(() => null);
    const { awaitId, eventKey, handleNote, minSleepSec } = await armInboxWake({
      ownerId: identity.ownerId,
      note: `${EXPLICIT_PARK_NOTE_MARKER} ${
        clampText(args.note, LIMITS.ANNOTATION) ?? 'idle — awaiting work/direction (deliver-and-wake)'
      }`,
      minSleepSec: args.min_sleep_sec,
      planRunId: args.plan_run_id,
      workspaceId: identity.workspaceId ?? undefined,
    });
    const afterReachability = await probeWakeReachability(identity.ownerId).catch(() => null);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            watch: {
              id: awaitId,
              pattern: eventKey,
              wake: true,
              once: false,
              // The RESOLVED floor actually armed on the row (EI-11648) — not the
              // raw arg, which is `null` when omitted even though a 60s default is armed.
              min_sleep_sec: minSleepSec,
            },
            inbox_wake_key: eventKey,
            wake_handle: handleNote,
            reachability: {
              before: snapshotReachability(beforeReachability),
              after: snapshotReachability(afterReachability),
            },
            advice: reachabilityAdvice(beforeReachability, afterReachability),
          }),
        },
      ],
    };
  },
});
