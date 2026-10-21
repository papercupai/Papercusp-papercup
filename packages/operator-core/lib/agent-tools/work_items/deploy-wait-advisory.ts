/**
 * deploy-wait-advisory — filing-time nudge for a new work-item that defers non-final work
 * until main/:3070 is deployed (plan staging-build-tool-routing-2026-10-21, R-5 / P-005).
 *
 * The census behind that plan found items filed as "accept once the deploy lands" when the
 * change could already be exercised on staging. Prompt rules alone did not stop it, so the
 * filing itself says so, at the moment the deferral is written. Advisory only: the item is
 * still created, and a false positive costs one ignorable line.
 *
 * The classification is the staging-first guard's (`nonFinalDeployWaitClauses`), so a
 * filing, a blocker and a plan activation all agree on what a non-final deploy wait is.
 */
import { nonFinalDeployWaitClauses } from '../plans/staging-first-activation-guard';

const MAX_QUOTED_CLAUSE_CHARS = 160;

/** The advisory text for a new item's title + summary, or null when it defers nothing. */
export function deployWaitAdvisory(title: string, summary?: string | null): string | null {
  const clauses = nonFinalDeployWaitClauses([title, summary ?? ''].filter(Boolean).join('\n'));
  if (clauses.length === 0) return null;
  const first = clauses[0]!;
  const quoted = first.length > MAX_QUOTED_CLAUSE_CHARS ? `${first.slice(0, MAX_QUOTED_CLAUSE_CHARS)}…` : first;
  return (
    `This item defers its work until main/:3070 is deployed ("${quoted}"). It was created, but ` +
    `non-final work is accepted on staging: exercise a new or changed tool with build: 'staging' — ` +
    `tools:find { query, build: 'staging' }, then tools:invoke { name, args, build: 'staging' }. ` +
    `If one check truly needs deployed main, file it as a SEPARATE post-ship item that names that ` +
    `deployed-only property and why staging cannot exercise it, and keep it out of this item's acceptance.`
  );
}
