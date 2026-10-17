/**
 * Candidate admission for raw harness_plans writers that cannot use
 * withPlanLock's standard content upsert (federation projections, recomposition,
 * and other column-specialized storage paths). This keeps dependency and plan
 * lifecycle checks under the same advisory lock as the write.
 *
 * The callback runs under the SAME advisory transaction lock as withPlanLock.
 * The live body/status/op_status read and the caller's write therefore form one
 * serialized before/after decision rather than a stale preflight. Test tagged-SQL
 * shims without `begin` run inline; production postgres.Sql clients always take
 * the transaction branch.
 */

import type { Sql, TransactionSql } from 'postgres';
import {
  findTerminalPlanChildMutations,
  isTerminalItemStatus,
  isTerminalPlanStatus,
  parsePlan,
} from '@papercusp/plan-parser';
import {
  isExecutablePlanCandidate,
  validatePlanCandidateDependencyTransition,
  type PlanCandidateDependencyVerdict,
} from './plan-candidate-dependencies';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './plan-lock-key';
import { summarizeForcedPast } from './forced-past-stamp';

export type PlanDependencyAdmissionSql = Sql | TransactionSql;

export interface PlanDependencyAdmissionTransactionArgs {
  sql: PlanDependencyAdmissionSql;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  candidateContent: string;
  /** Canonical structured lifecycle when it can differ from markdown. */
  candidateStatus?: string | null;
}

export interface PlanLifecycleAdmissionRejection {
  code: 'plan_items_unfinished' | 'terminal_parent_child_mutation';
  message: string;
  itemIds: string[];
}

export type PlanDependencyAdmissionTransactionResult<T> =
  | { admitted: true; verdict: PlanCandidateDependencyVerdict; value: T }
  | {
      admitted: false;
      verdict: PlanCandidateDependencyVerdict;
      rejection?: PlanLifecycleAdmissionRejection;
    };

function executableOpStatus(
  lifecycleStatus: string | null | undefined,
  opStatus: string | null | undefined,
): string | null {
  const normalized = opStatus ?? null;
  return isExecutablePlanCandidate(lifecycleStatus, normalized)
    ? (normalized ?? 'started')
    : normalized;
}

function terminalPlanLifecycleRejection(args: {
  before: ReturnType<typeof parsePlan> | null;
  after: ReturnType<typeof parsePlan>;
  beforeStatus: string | null;
  afterStatus: string | null;
  candidateContent: string;
}): PlanLifecycleAdmissionRejection | null {
  const { before, after, beforeStatus, afterStatus, candidateContent } = args;
  if (!isTerminalPlanStatus(afterStatus)) return null;

  const beforeItems = before?.items.map((item) => ({ id: item.id, status: item.storedStatus })) ?? [];
  const afterItems = after.items.map((item) => ({ id: item.id, status: item.storedStatus }));

  // A raw writer can change the frontmatter status without going through
  // plans:set-plan-status. Require the same visible waiver that the canonical
  // ship/supersede gate writes when it explicitly allows unfinished children.
  if (!isTerminalPlanStatus(beforeStatus)) {
    const unfinished = after.items.filter((item) => !isTerminalItemStatus(item.storedStatus));
    const waived = summarizeForcedPast(candidateContent)?.latest.checks.includes('plan_items_unfinished') === true;
    if (unfinished.length > 0 && !waived) {
      const itemIds = unfinished.map((item) => item.id);
      return {
        code: 'plan_items_unfinished',
        message:
          `Refused terminal plan transition to '${afterStatus}' with unfinished item(s) ` +
          `${itemIds.join(', ')}; only an explicit plan_items_unfinished waiver can permit this shape.`,
        itemIds,
      };
    }
    return null;
  }

  // Keep the existing terminal-parent rule for later writes: no new live child
  // and no reopening a finished child. Existing live children in old records may
  // still advance, so unrelated edits do not get frozen by historical drift.
  const childMutations = findTerminalPlanChildMutations(afterStatus, beforeItems, afterItems);
  if (childMutations.length === 0) return null;
  const itemIds = childMutations.map((change) => change.itemId);
  return {
    code: 'terminal_parent_child_mutation',
    message:
      `Refused adding or reopening unfinished item(s) ${itemIds.join(', ')} ` +
      `under terminal plan '${afterStatus}'.`,
    itemIds,
  };
}

/** Run one specialized plan write under canonical dependency admission. */
export async function withPlanDependencyAdmissionTransaction<T>(
  args: PlanDependencyAdmissionTransactionArgs,
  write: (tx: PlanDependencyAdmissionSql) => Promise<T>,
): Promise<PlanDependencyAdmissionTransactionResult<T>> {
  const run = async (tx: PlanDependencyAdmissionSql): Promise<PlanDependencyAdmissionTransactionResult<T>> => {
    const lockKey = planAdvisoryLockKey(args.workspaceId, args.harnessSlug, args.planSlug);
    // WI-2143102: this wait is now BOUNDED. It was a bare `pg_advisory_xact_lock`, and
    // `withWorkspace` sets no `lock_timeout`, so a waiter here held one org-app pool connection
    // for as long as the convoy lasted — measured at 18–21 backends queued on a single plan's key
    // with the oldest waiter at 59 minutes. Exhausting the budget now aborts this transaction with
    // PG 55P03 instead, which releases the connection and fails the write fast; the same
    // fail-fast-over-wedge trade the issues-engineer and work-items txns already make.
    await acquirePlanAdvisoryLock(tx, lockKey);

    // to_jsonb keeps this compatible with historical-schema integration fixtures
    // that intentionally predate op_status while reading the real column in
    // production. Missing there means null, never a fabricated executable state.
    const rows = await tx<
      Array<{ content: string; status: string | null; op_status: string | null }>
    >`
      SELECT p.content,
             p.status,
             to_jsonb(p) ->> 'op_status' AS op_status
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${args.workspaceId}
         AND p.harness_slug = ${args.harnessSlug}
         AND p.plan_slug = ${args.planSlug}
       LIMIT 1
    `;
    const live = rows[0] ?? null;
    const locator = `plan://${args.harnessSlug}/${args.planSlug}`;
    const before = live ? parsePlan(live.content, { filePath: locator }) : null;
    const after = parsePlan(args.candidateContent, { filePath: locator });
    const beforeStatus = live?.status ?? before?.frontmatter.status ?? null;
    const beforeOpStatus = executableOpStatus(live?.status, live?.op_status);
    const afterStatus = args.candidateStatus ?? after.frontmatter.status ?? null;
    const afterOpStatus = executableOpStatus(afterStatus, live?.op_status);
    const verdict = validatePlanCandidateDependencyTransition(
      before,
      after,
      beforeOpStatus,
      afterOpStatus,
    );
    if (verdict.state === 'rejected') return { admitted: false, verdict };
    const lifecycleRejection = terminalPlanLifecycleRejection({
      before,
      after,
      beforeStatus,
      afterStatus,
      candidateContent: args.candidateContent,
    });
    if (lifecycleRejection) return { admitted: false, verdict, rejection: lifecycleRejection };
    return { admitted: true, verdict, value: await write(tx) };
  };

  if ('begin' in args.sql && typeof args.sql.begin === 'function') {
    return args.sql.begin((tx) => run(tx));
  }
  return run(args.sql);
}
