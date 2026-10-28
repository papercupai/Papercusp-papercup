/**
 * The `beforeSleep` protocol `watch:create` attaches to a standing
 * `work-item:claimable` wake watch.
 *
 * Kept in a dependency-free leaf on purpose. The behavioral SU experiment
 * (`llm-testing/scenarios/su/S42-drain-watch-recheck.ts`) consumes this exact
 * protocol, and production reaches that scenario statically
 * (`scorecards → rubric-instrument-registry → fleet/capacity-recovery-evidence → S42`).
 * Importing it from `watch.ts` dragged the whole events/await → inference-gateway →
 * blueprint graph into `scorecards`, closing a static cycle back through
 * `acceptance-bar-lifecycle-evaluator → acceptance-bar-contract-snapshot`
 * (WI-6554700010030904). Keep this module free of imports.
 */
export function claimableWatchBeforeSleep(pattern: string, once: boolean) {
  return !once && pattern === 'work-item:claimable'
    ? { tool: 'scheduler:get_next', required: true,
        afterMiss: { tool: 'loop:end', required: true },
        reason: 'Re-run scheduler:get_next BEFORE sleeping: work may predate this watch or arrive during registration. Continue on a claim; only a verified miss permits loop:end to stop the timer loop and end your turn, with this standing watch retained.' }
    : undefined;
}
