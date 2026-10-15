# Fleet recovery must preserve an exhausted monitor's standdown
URL: /internal/docs/agent-insights/exhausted-fleet-monitor-recovery

Inactive monitor recovery is not a new mandate: preserve zero quiet-wake budgets without losing inbox or transition watches, while permitting an explicitly renewed positive budget.

## Measured failure

EI-25292075686873281 records a leader-control recovery that rearmed an inactive monitor while retaining remainingNoDeltaBudget: 0. The origin was ensureFleetLeaderControl: it treated every inactive loop as a missing wake source and materialized it without consulting exhaustion evidence. The pre-fix maintained regression fe375d15 /20883467 reproduced three materialization calls for exhausted status, payload, and marker-only fixtures; ordinary positive-budget controls passed.

EI-25295901151703284 identifies the separate member entry point, autoArmFleetMemberLoop. Its inactive recovery branch likewise omitted exhaustion discrimination, and passed monitor mode without the monitor policy to materializeLoop. The writer replaces the payload, so recovery discarded a positive remaining budget as well. Pre-fix maintained run 5a819365 /20887514 demonstrated two zero-budget recovery failures and two positive-policy preservation failures; the active-arm race control passed. Its initial marker-only fixture used the wrong metadata key and is not causal evidence for that case. The corrected fixture uses the canonical metadata.monitor\_standdown writer/parser shape.

## Recovery boundary

An active loop remains untouched. For an inactive monitor, zero remaining budget in either saved status or payload suppresses materialization. When monitor config is absent, no\_delta\_budget\_exhausted standdown metadata also prevents manufacturing a default budget. Intentional leader standdown is returned as loop.standdown while loop.healthy remains true: healthy means no recovery is needed, not that a periodic loop is active. Inbox and standing transition-watch reconciliation still run; blocker watches are neither consumed nor canceled.

Member auto-arm returns armed:false with reason:no-delta-budget-exhausted and leaves the existing row and push watches untouched. For a recoverable monitor, it carries the saved monitor policy through the existing materializeLoop input so the remaining budget, authority, predicate, and stop condition survive payload replacement.

A historical standdown marker alone must not defeat a later explicitly renewed positive budget. MaterializeLoop retains that historical metadata, so the current monitor config is necessary to interpret it. Recovery retains an unexhausted config and the existing onlyIfInactive race guard; explicit loop:arm semantics are unchanged.

## Verification and limits

The conventional leader-control test checks zero-budget evidence independently of the historical marker, watch custody, marker-only legacy recovery, and positive-budget renewal. Full source verification 6fd3f897 passed 213 tests across leader-control, loop:arm, monitor-policy, and monitor-standdown. Exact-build acceptance 54bcbc6e /20886985 exercised the four selected recovery controls through the pinned :3170 testing API on containing build 256a4151bc.

The member recurrence guards live in loop.test.ts and loop.integration.test.ts. Unfiltered matrix 697d8cae /20887531–20887535 passed 237 tests across loop units, isolated-PG loop persistence, monitor-policy, monitor-standdown, and leader-control. Real-PG coverage checks that an exhausted inactive row stays byte-identical and that a positive remaining budget of 73 survives inactive recovery. The corrected marker-only fixture and renewed-positive controls distinguish historical standdown from current exhaustion.

Local source evidence does not prove an operator loaded a change. Operator-api acceptance requires the containing origin/staging build on :3170 and its measured request/response. Never resurrect a real exhausted monitor merely to obtain verification.

Keep the original wake-transport incident EI-25257321199641888 separate: its first attempt's cause remains unknown; current socket reachability and historical delivery errors measure different times and predicates.
