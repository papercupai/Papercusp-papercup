/**
 * WI-2339 (defect #1) — CHARACTERIZATION / regression test locking in the loop's fire-success
 * gap found in the cold-loop death/respawn watchdog investigation, BEFORE any fix lands.
 *
 * Root cause (WI-2339 post 50246, su-4072faf3, 2026-07-04): `fireLoopWake` treats
 * `reached = (fan.woken ?? 0) > 0 || (fan.staged ?? 0) > 0` as its ONLY success signal — the
 * ONE path that would `deactivateLoop` / record `no-session-now` requires `reached === false`
 * (loop-fire.ts ~L237-238). But the standing (`once=false`) `coord:inbox-wake:<owner>` await
 * every psu/console session arms at launch (`armInboxWake` → `upsertInboxWakeAwait`,
 * store.ts: `once=false`, `timeout_behavior='expire'`, `expires_ts=NULL` — no TTL, ever) is
 * MATCHED WITHOUT CONSUMING on every emit (`fireAwaitsForKey`'s standing-watch branch), and is
 * cancelled ONLY by `cancelInboxWakeAwaits`, which runs ONLY off a graceful SessionEnd
 * lifecycle hook (inbox-wake-arm.ts, documented as "SessionEnd hygiene"). An unplanned death
 * (terminal killed / crash / OOM / desktop-session restart) never runs that hook — so the
 * standing await survives the death FOREVER, `wakeRecipients` (via `emitAwaitedEvent` →
 * `fireAwaitsForKey`) reports `woken:1` on every single tick till the end of time, and
 * `fireLoopWake` is structurally incapable of ever reaching its own `no-session-now`
 * auto-deactivation path for a session that died without a graceful exit.
 *
 * RESOLUTION (WI-2339 fix landed, 2026-07-04): the death detection was deliberately placed
 * DOWNSTREAM of the fire gate, NOT at it (proposal A — "make fireLoopWake pre-check
 * probeWakeReachability and deactivate on reachable:false" — was NOT taken: it removes the
 * WI-1399 debounce, so it would kill a healthy loop on a transient blip, and it CANNOT catch the
 * actual su-95cf8308 case anyway — a resumable-but-dead session probes `reachable:true` via the
 * `resume` channel). The synchronous fire gate genuinely CANNOT distinguish a ghost standing-await
 * match from a real delivery — the delivery is async + decoupled — so these "TODAY (the bug)"
 * assertions are now a PERMANENT CHARACTERIZATION of that intrinsic limitation, not a red-to-green
 * target. The catch lives where the real-delivery signal actually exists: the reconcile
 * completion-signal feedback (`recordFire('ok')` on a settled turn / `'error'` on the stuck-park
 * backstop) opens the fire-circuit after ≥threshold undelivered turns, and the WI-1399 terminal
 * guard's resumable-dead path (`loop-unreachable-guard.ts`, WI-2339) then auto-pauses + escalates
 * the loop. So a ghost woken:1 no longer keeps a dead loop alive forever — reconcile terminates it
 * a few dwell-windows later. See loop-unreachable-guard.test.ts + reconcile-loop-routines.test.ts.
 *
 * EI-16166 (2026-07-19): the `!reached` (woken:0, staged:0) fast path itself no longer
 * `deactivateLoop`s either — it PREVIOUSLY did, unconditionally, on the very first such miss,
 * with no retry and no owner escalation. That miss is reachable for a TRANSIENT cause too (a
 * SessionEnd hook cancelling the standing await on an abnormal exit, e.g. a fatal
 * rate-limit/auth_wall kill mid-turn — not a genuinely dead owner), so killing on the first
 * occurrence is exactly the "kill a healthy loop on a transient blip" anti-pattern proposal A
 * was rejected for above. It now records an `error` (feeding the same failure-streak circuit /
 * stuck-park+quick-retry ladder as every other death signal) and leaves the loop parked; only
 * the reachability-vetoed terminal guard may eventually auto-pause it, and it does so loudly.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireLoopWake, type LoopFireDeps } from './loop-fire';

function mkDeps(
  over: Partial<LoopFireDeps> = {},
): Required<Pick<LoopFireDeps, 'checkFireGate' | 'recordFire' | 'wake' | 'costCap' | 'readWakeDelta'>> {
  return {
    readWakeDelta: vi.fn(async () => null),
    checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })) as never,
    recordFire: vi.fn(async () => {}) as never,
    wake: vi.fn(async () => ({ targets: ['su-dead'], keys: ['coord:inbox-wake:su-dead'], woken: 1, staged: 0 })) as never,
    costCap: vi.fn(async () => ({ breach: false, spendCents: 0, capCents: null })) as never,
    ...over,
  };
}

const baseInput = {
  routineId: 'rt_papercusp_loop_su-dead',
  routineName: 'loop-su-dead',
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  targetOwnerId: 'su-dead',
  payloadTemplate: null as Record<string, unknown> | null,
};

describe('fireLoopWake — WI-2339 gap: a ghost standing-await match is indistinguishable from a real delivery', () => {
  it('TODAY (the bug): wake() reporting woken:1 for a target whose SESSION IS ACTUALLY DEAD (a standing-await ghost match, not a real delivery) is reported fired:true, and the loop is NEVER deactivated / no error is ever recorded', async () => {
    // This `wake` mock represents exactly what the REAL `wakeRecipients` returns in
    // production for a dead target: `emitAwaitedEvent` → `fireAwaitsForKey`'s standing-watch
    // branch (`once=false`) matches the still-armed inbox-wake await UNCONDITIONALLY — it has
    // no concept of "is the matching session alive" at all, so `woken` is 1 regardless of
    // whether anything is actually there to receive the turn.
    const deps = mkDeps();
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    // The ONLY path that would ever record `no-session-now` (feeding the failure-streak
    // circuit toward an eventual, escalated auto-pause) requires `reached === false` — a
    // ghost woken:1 never produces that, so this dead loop is re-armed by the routine engine
    // forever, exactly like the WI-2339 soak-test subject (su-95cf8308) whose loop kept
    // firing ~3h after its terminal died.
    expect(deps.recordFire).not.toHaveBeenCalledWith(
      baseInput.installSlug,
      baseInput.routineName,
      expect.stringContaining('no-session-now'),
      expect.anything(),
    );
    // Instead it's recorded as a normal successful enqueue — visually indistinguishable in
    // fire-history from a genuinely live loop.
    expect(deps.recordFire).toHaveBeenCalledWith(baseInput.installSlug, baseInput.routineName, 'queued', 'attempt');
  });

  it('for contrast: the ONLY way `fireLoopWake` ever sees "dead" is a wake() that reports BOTH woken:0 AND staged:0 — which the real ghost-standing-await path never produces once a session has died', async () => {
    // This is the branch the existing loop-fire.test.ts suite covers — included here for
    // contrast: it only fires when `wake()` itself reports nothing matched, which requires the
    // standing await to have been cancelled first. Per the root cause above, nothing cancels it
    // on an unplanned death, so production code never naturally reaches this branch for a
    // session that died WITHOUT a graceful exit — but it DOES reach it for a session whose
    // SessionEnd hook ran on an ABNORMAL-but-graceful exit (e.g. a fatal rate-limit kill,
    // EI-16166), which is exactly why this fast path must no longer immediately deactivate.
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-dead'], keys: [], woken: 0, staged: 0 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    expect(deps.recordFire).toHaveBeenCalledWith(
      baseInput.installSlug,
      baseInput.routineName,
      'no-session-now',
      'error',
    );
  });
});
