/**
 * P-006/P-007 (composable-event-awaits-2026-07-11): the idle-puller recipe, delivered at
 * the exact moment it applies — an EMPTY pull. Retires the ~60s idle re-poll cadence:
 * register a standing wake watch over the canonical `work-item:claimable` key
 * (P-007 dual-emit — it fires on every created-unclaimed / claim-released /
 * last-blocker-cleared transition, collapsing the 3-leaf composed any-spec this recipe
 * originally taught); payload carries {id,kind,severity,harness,title,state,reason,plan,
 * tags,goal} so `payload_filter` narrows it to your claim spec's view (including
 * goal-scoped lanes), with `wake:true, once:false` so it remains armed after each wake.
 * The wake is a HINT, never a claim — get_next stays the single authoritative claim path,
 * so a spurious/racing wake costs one cheap re-miss, never a double-claim.
 * Exported through get_next for the recurrence-guard pin test (idle-loop-recipe-pin.test.ts).
 */
export const IDLE_PULL_MISS_ADVICE =
  'Idle recipe (composable-event-awaits P-006/P-007): do NOT re-poll on a timer — register the standing wake watch, then re-run scheduler:get_next BEFORE sleeping: ' +
  'watch:create { pattern: "work-item:claimable", wake:true, once:false, payload_filter: { harness: { eq: "<your-harness>" } } /* narrow to your claim spec\'s view — id/kind/title/plan/tags/goal are carried */ } ' +
  '— work-item:claimable fires on every created-unclaimed / claim-released / unblocked transition; the standing watch re-invokes you on each matching transition and remains armed after a re-miss. ' +
  'Registration observes future transitions; the second pull closes the gap for existing work and supply arriving during registration. If it claims work, continue; only a verified miss permits END YOUR TURN: call loop:end to stop the timer loop, with the standing watch retained. ' +
  'The wake is a HINT that work may exist, never a claim: scheduler:get_next stays the AUTHORITATIVE claim on the wake turn; ' +
  'do not pass targetKind with wake:true, and a re-miss does not require re-registering the watch.';
