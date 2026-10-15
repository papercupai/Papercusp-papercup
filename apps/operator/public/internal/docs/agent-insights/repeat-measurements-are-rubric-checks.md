# Repeat measurements are rubric checks, not hand ratings
URL: /internal/docs/agent-insights/repeat-measurements-are-rubric-checks

A repeatable measurement belongs in a rubric check recorded to the results ledger, never in a hand rating. How criteria, checks and tests differ, which check kind to bind (tests, probe, sql, registered instrument), how scorecards:emit { fromLedger:true } rates from the ledger, and how a plan schedule re-scores a rubric and alerts on a pass-to-fail crossing.

## The rule

**A repeatable measurement belongs in a rubric check recorded to the results ledger, never in a hand rating.** If a number can be measured again by a command, a read-only tool call or a read-only SQL query, bind that measurement to the rubric criterion as an executable check. The check writes one row per execution into `harness_shared.test_runs` (framework `rubric-check`), and the scorecard rates the criterion from that row. A grader typing a rating for a number a check could have measured produces a value nobody can re-derive, compare across runs, or alert on.

This is the default for audits too: an audit that measures something once and will want the same number next week records it as a check, so the next audit reads a trend instead of re-measuring by hand.

## Criteria, checks and tests are three different things

| term          | what it is                                                                          | where it lives                                     |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| **criterion** | a claim about the subject that a scorecard rates ("p95 latency stays under 500 ms") | a rubric row (`rubrics:propose` / `rubrics:amend`) |
| **check**     | the executable procedure bound to a criterion that measures it                      | the criterion's `check` field                      |
| **test**      | a committed test file in one of the four canonical frameworks                       | the repo; its run is a `test_runs` row             |

A `tests` check is one kind of check: it points a criterion at test files. The other kinds measure a live value:

* **probe** (`kind:'probe'`, children `kind:'tool'` or `kind:'sql'`): read-only tool calls or read-only SQL through the `dev:pg_query` guard, each with an `expect` predicate.
* **instrument** (`kind:'instrument'`, `instrumentKey`): a command registered in `packages/operator-core/lib/rubric-instrument-registry.ts` with a parser and a unit. Authoring refuses an unregistered key; `manual` remains the explicit opt-out for a genuinely human judgment.

A criterion with no check is a judgment criterion: the grader rates it by hand, with evidence. That is correct only when nothing executable can measure it.

## How the ledger is filled and read

1. Each executed probe child or instrument writes one `test_runs` row whose `execution_details.check` is `{ id, rubricRef, criterionKey, value, unit }` (`packages/operator-core/lib/check-results-ledger.ts`). A value that could not be measured is recorded as `error`, never as a silent 0.
2. `scorecards:emit { fromLedger: true }` rates every executable criterion from its latest ledger row, re-judged against the criterion's current threshold (`packages/operator-core/lib/scorecard-ledger-fill.ts`), and asks the grader only for the remaining judgment criteria.

## Recurring measurements and regression alerts

A measurement worth repeating is re-run by a plan schedule, not a hand-rolled timer:

```
plans:set-schedule { slug, schedule: { kind:'rrule', rrule:'FREQ=DAILY',
  action: { system:'rubric-rescore', input: { rubricRef } } } }
plans:arm-schedule { slug }
watch:create { pattern:'rubric:criterion-regressed:<rubricRef>', targetKind:'event', wake:false }
```

The armed routine `plan-schedule-<slug>` fires `system:rubric-rescore`, which runs the rubric's executable checks, records the rows, and emits `rubric:criterion-regressed:<rubricRef>` for each criterion that moved from meeting its bar to failing it. A criterion that stays at its bar, has no prior result, or could not be measured emits nothing.

## Smells

* A scorecard rating that quotes a number in its evidence prose while the criterion has no check.
* An audit report table of measured values with no `test_runs` rows behind it.
* `instrumentKey` set to a free-text label instead of a registered instrument.
* A recurring "check the number again" work-item instead of an armed re-score schedule.
