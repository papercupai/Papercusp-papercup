import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@papercusp/tooldef';

import capabilityEdit from './capability/edit';
import launchAgent from './capability/launch-agent';
import migrate from './db/migrate';
import consultDecline from './consult/decline';
import consultGetFeedback from './consult/get-feedback';
import consultReply from './consult/reply';
import fleetLaunchOnPlan from './fleet_registry/launch-on-plan';
import gradeIdea from './scout/grade-idea';
import repairQueue from './release/repair-queue';
import scorecardsEmit from './scorecards/emit';
import workItemsCreate from './work_items/create';
import workItemsSetBlocker from './work_items/set_blocker';
import workItemsCheckpoint from './work_items/checkpoint';
import codeRun from './code/run';
import testingRun, { testingRunAbortCompletionReceipt } from './testing/run';
import docsAuthor from './docs/author';
import coordSend from './coordination/tools/send';
import coordDispatch from './coordination/tools/dispatch';
import agentReview from './improvements/agent-review';
import storagePrune from './storage/prune';
import bindSpecEvidence from './plans/bind-spec-evidence';
import plansSetSpecs, { SET_SPECS_MAX_CONCURRENCY, setSpecsAbortCompletionReceipt } from './plans/set-specs';
import buildTypecheck, { buildTypecheckAbortCompletionReceipt } from './build/typecheck';
import { bulkRunReport } from './inbox/bulk-run';
import gitSyncRun from './git_sync/run';
import plansAudit from './plans/audit';

/**
 * WI-10005670 recurrence guard — the commit-unknown window.
 *
 * A mutating tool whose handler returns AFTER the dispatch deadline is reported as a bare
 * `timeout` ("handler returned but signal had aborted") although its write committed, and the
 * caller retries a write that already landed. The only per-tool fix is an `abortCompletionReceipt`
 * resolver that names the effect the completed attempt recorded. This pins the population that
 * the invocation ledger MEASURED hitting that window (7d, 2026-10-02: blender:grade-idea 5,
 * consult:reply 7, fleet:launch-on-plan 3) plus the receipts that were already landed, so a
 * refactor that drops the resolver fails here instead of reappearing as production timeouts.
 *
 * ADD a tool here the moment `tool_invocations` shows `error_code='timeout'` with
 * `handler returned but signal had aborted` on a mutating tool; the receipt it needs is a
 * resolver over its own result (see consult/abort-completion.ts, abort-completion-payload.ts).
 */
const LATE_RETURN_MUTATORS = {
  'plans:audit': plansAudit,
  'blender:grade-idea': gradeIdea,
  // EI-24923632103429261: the p95 budget detector measured an over-budget tail.
  'consult:get_feedback': consultGetFeedback,
  'consult:reply': consultReply,
  'consult:decline': consultDecline,
  'fleet:launch-on-plan': fleetLaunchOnPlan,
  'capability:launch-agent': launchAgent,
  // EI-27646651852056454: the nested repair-queue dispatch follows the committed replacement.
  'capability:edit': capabilityEdit,
  // EI-25219048009184886: a late migration success must carry the schema ledger identity.
  'db:migrate': migrate,
  // EI-25175620446966840: the write tool's p95 reached 82% of its dispatch budget.
  'release:repair-queue': repairQueue,
  'scorecards:emit': scorecardsEmit,
  // EI-25216756674045452: code:run can complete nested writes after its dispatch deadline.
  'code:run': codeRun,
  // EI-25248391444384694: a completed test run needs its run-group identity after late return.
  'testing:run': testingRun,
  // EI-25261691219544543: docs:author crosses the default dispatch budget; identify the canonical doc on late return.
  'docs:author': docsAuthor,
  // WI-10005718: the INSERT precedes the response; a late return lost the id + downgrade notice.
  'work_items:create': workItemsCreate,
  // EI-25996559668652955: a completed blocker mutation exceeded its dispatch deadline after persisting.
  'work_items:set_blocker': workItemsSetBlocker,
  // EI-26067444415170093: checkpoint writes can commit before the verify/advisory tail returns.
  'work_items:checkpoint': workItemsCheckpoint,
  // EI-25288245178425318: a delivered coord:send must expose its persisted message id after a late return.
  'coord:send': coordSend,
  // EI-25922563546988521: dispatch must receipt only proven message and assignment effects.
  'coord:dispatch': coordDispatch,
  // EI-25374615774698673: a late review claim/resubmission must name its completed effect.
  'improvements:agent-review': agentReview,
  // EI-25430676827648397: prune can commit deletes before its slow maintenance tail returns.
  'storage:prune': storagePrune,
  // EI-25965568135498194: bind can return after dispatch aborts with durable evidence rows.
  'plans:bind-spec-evidence': bindSpecEvidence,
  // EI-26072621145526647: bulk clause writes can finish after dispatch aborts with revisions committed.
  'plans:set-specs': plansSetSpecs,
  // EI-25833565319673625: the long compiler tail needs an attempt receipt so a late verdict is not retried blindly.
  'build:typecheck': buildTypecheck,
  // EI-26207329377923256: a late report must name its exact updated run rows.
  'inbox:bulk-run-report': bulkRunReport,
  // EI-26678535936174570: near-budget git-sync calls must expose their completed commit identity.
  'git-sync:run': gitSyncRun,
} as const;

/** The population check, factored so the calibration control below can run the same code. */
function toolsWithoutReceipt(tools: Record<string, { name?: string; abortCompletionReceipt?: unknown }>): string[] {
  return Object.entries(tools)
    .filter(([, tool]) => typeof tool.abortCompletionReceipt !== 'function')
    .map(([name]) => name);
}

describe('late-return mutating tools declare an abortCompletionReceipt (WI-10005670)', () => {
  it('CALIBRATION: the check flags a tool that has no receipt (so a pass is not vacuous)', () => {
    expect(toolsWithoutReceipt({ 'fake:mutator': { name: 'fake:mutator' } })).toEqual(['fake:mutator']);
  });

  it('every pinned tool declares a resolver, registered under the name the ledger measured', () => {
    expect(toolsWithoutReceipt(LATE_RETURN_MUTATORS)).toEqual([]);
    for (const [name, tool] of Object.entries(LATE_RETURN_MUTATORS)) {
      expect(tool.name).toBe(name);
    }
  });

  it('capability:edit identifies committed replacements and fails closed on ambiguous results', () => {
    const receipt = capabilityEdit.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');
    const attempt = { callId: 'capability-edit-call-1', toolName: 'capability:edit' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as ToolResult;

    expect(receipt!({}, result({ ok: true, path: '/repo/source.ts', replacements: 1 }), attempt))
      .toMatchObject({
        status: 'recorded',
        effectRef: 'capability-edit:capability-edit-call-1:/repo/source.ts',
        diagnostics: { path: '/repo/source.ts', replacements: 1 },
      });
    expect(receipt!({}, result({ ok: false, reason: 'not_found' }), attempt)).toMatchObject({
      status: 'not-recorded',
      reason: 'capability:edit returned before the file replacement (not_found)',
    });
    expect(receipt!({}, result({ ok: true, path: '/repo/source.ts' }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-edit-result-identity'],
    });
  });

  it('inbox:bulk-run-report identifies partial writes and explicit no-write results', () => {
    const receipt = bulkRunReport.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');
    const attempt = { callId: 'bulk-report-call-1', toolName: 'inbox:bulk-run-report' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as ToolResult;

    expect(receipt!({}, result({
      ok: false,
      runId: 'run-1',
      wrote: 2,
      updatedItemIds: ['item-1', 'item-2'],
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'inbox-bulk-run-report:bulk-report-call-1:run-1:items:item-1,item-2',
      diagnostics: { runId: 'run-1', wrote: 2, updatedItemIds: ['item-1', 'item-2'] },
    });

    expect(receipt!({}, result({
      ok: false,
      error: 'no_active_run',
      runId: null,
      wrote: 0,
      updatedItemIds: [],
    }), attempt)).toMatchObject({ status: 'not-recorded' });

    expect(receipt!({}, result({
      ok: true,
      runId: 'run-1',
      wrote: 1,
      updatedItemIds: [],
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-report-write-evidence'],
    });
  });

  it('testing:run distinguishes completed verdicts, durable recovery, and unknown outcomes', () => {
    const attempt = { callId: 'test-call-1', toolName: 'testing:run' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as ToolResult;

    expect(testingRunAbortCompletionReceipt({}, result({ ok: true, runId: 'run-pass', files: 1 }), attempt))
      .toMatchObject({ status: 'recorded', effectRef: 'testing-run:run-pass' });
    expect(testingRunAbortCompletionReceipt({}, result({ ok: false, runId: 'run-fail', files: 1 }), attempt))
      .toMatchObject({ status: 'recorded', effectRef: 'testing-run:run-fail' });
    expect(testingRunAbortCompletionReceipt({}, result({
      ok: false,
      runId: 'run-origin',
      error: 'timeout',
      detachedRunId: 'run-recovery',
      detachedDurable: true,
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'testing-run:run-origin:detached:run-recovery',
    });
    expect(testingRunAbortCompletionReceipt({}, result({
      ok: false,
      runId: 'run-active',
      error: 'timeout',
      taskId: 'task-1',
      terminationUnconfirmed: true,
    }), attempt)).toMatchObject({ status: 'recorded', effectRef: 'testing-run:run-active:task:task-1' });
    expect(testingRunAbortCompletionReceipt({}, result({ ok: false, error: 'invalid_root' }), attempt))
      .toMatchObject({ status: 'not-recorded' });
    expect(testingRunAbortCompletionReceipt({}, result({
      ok: false,
      error: 'invalid_root',
      evidenceBundle: { status: 'retirement-incomplete' },
    }), attempt)).toMatchObject({ status: 'recovery-incomplete', failures: ['evidence-retirement-unconfirmed'] });
    expect(testingRunAbortCompletionReceipt({}, result({
      ok: false,
      runId: 'run-unknown',
      error: 'timeout',
      detachedRunId: 'run-undurable',
      detachedDurable: false,
    }), attempt)).toMatchObject({ status: 'recovery-incomplete' });
  });

  it('build:typecheck distinguishes a completed verdict, a timeout, and a refusal', () => {
    const attempt = { callId: 'typecheck-call-coverage', toolName: 'build:typecheck' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ data: payload }) }],
    }) as ToolResult;

    expect(buildTypecheckAbortCompletionReceipt(
      {},
      result({ ok: true, project: 'packages/operator-core', errorCount: 0 }),
      attempt,
    )).toMatchObject({
      status: 'recorded',
      effectRef: 'build-typecheck:typecheck-call-coverage:packages/operator-core',
    });
    expect(buildTypecheckAbortCompletionReceipt(
      {},
      result({ ok: false, error: 'timeout', project: 'packages/operator-core' }),
      attempt,
    )).toMatchObject({ status: 'recovery-incomplete', failures: ['typecheck-timeout'] });
    expect(buildTypecheckAbortCompletionReceipt(
      {},
      result({ ok: false, error: 'scope_requires_files' }),
      attempt,
    )).toMatchObject({ status: 'not-recorded' });
  });

  it('storage:prune reports the effect or fails closed when an aborted attempt is unclear', () => {
    expect(storagePrune.timeoutSec).toBe(90);
    const receipt = storagePrune.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');
    const context = { callId: 'prune-call-1', toolName: 'storage:prune' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as ToolResult;

    expect(
      receipt!({ category: 'substrate-outbox' }, result({
        ok: true,
        categoryId: 'substrate-outbox',
        dryRun: false,
        removed: 12,
        partial: true,
        totalRemaining: 8,
        vacuumed: false,
      }), context),
    ).toMatchObject({
      status: 'recorded',
      effectRef: 'storage-prune:prune-call-1:substrate-outbox',
      diagnostics: { categoryId: 'substrate-outbox', removed: 12, partial: true, totalRemaining: 8 },
    });

    expect(
      receipt!({ category: 'scratch', dryRun: true }, result({ ok: true, categoryId: 'scratch', dryRun: true, removed: 0, vacuumed: false }), context),
    ).toMatchObject({ status: 'not-recorded' });
    expect(
      receipt!({ category: 'route-invocations' }, result({ ok: true, categoryId: 'route-invocations', dryRun: false, removed: 0, complete: true }), context),
    ).toMatchObject({ status: 'not-recorded' });
    expect(
      receipt!({ category: 'wake-spills' }, result({ ok: true, categoryId: 'wake-spills', dryRun: false, removed: 0 }), context),
    ).toMatchObject({ status: 'recovery-incomplete' });
    expect(
      receipt!({ category: 'substrate-outbox' }, result({ ok: false, categoryId: 'substrate-outbox', dryRun: false, removed: 0 }), context),
    ).toMatchObject({ status: 'recovery-incomplete' });
  });

  it('plans:bind-spec-evidence reports committed binding and retraction IDs after a late return', () => {
    const attempt = { callId: 'bind-call-1', toolName: 'plans:bind-spec-evidence' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ data: payload }) }],
    }) as ToolResult;
    const receipt = bindSpecEvidence.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');

    expect(receipt!({}, result({
      ok: false,
      results: [
        { ok: true, id: 44621, status: 'created', slug: 'adhoc-work-item-specs' },
        { ok: false, error: 'instrument_provenance_invalid' },
      ],
      counts: { ok: 1, failed: 1 },
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'plans-spec-evidence:bind-call-1:bindings:44621',
      diagnostics: { bindingIds: [44621], retractedIds: [] },
    });

    expect(receipt!({ retract: [{ bindingId: 44621, reason: 'replace stale proof' }] }, result({
      ok: true,
      results: [
        { ok: true, status: 'retracted', bindingId: 44621 },
        { ok: true, status: 'already_retracted', bindingId: 44622 },
      ],
      counts: { ok: 2, failed: 0 },
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'plans-spec-evidence:bind-call-1:retracted:44621,44622',
      diagnostics: { bindingIds: [], retractedIds: [44621, 44622] },
    });

    expect(receipt!({}, result({
      ok: false,
      results: [{ ok: true, status: 'created' }],
      counts: { ok: 1, failed: 0 },
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-landed-evidence-id'],
    });
  });

  it('plans:set-specs reports committed clause revisions and fails closed on incomplete rows', () => {
    expect(plansSetSpecs.abortCompletionReceipt).toBe(setSpecsAbortCompletionReceipt);
    expect(SET_SPECS_MAX_CONCURRENCY).toBe(4);
    const attempt = { callId: 'set-specs-call-1', toolName: 'plans:set-specs' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ data: payload }) }],
    }) as ToolResult;
    const receipt = plansSetSpecs.abortCompletionReceipt!;

    expect(receipt({}, result({
      ok: false,
      results: [
        { ok: true, slug: 'plan', specId: 'SPEC-B', status: 'revised', revision: 3 },
        { ok: false, slug: 'plan', specId: 'SPEC-C', error: 'conflict' },
        { ok: true, slug: 'plan', specId: 'SPEC-A', status: 'created', revision: 1 },
      ],
      counts: { ok: 2, failed: 1 },
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'plans-set-specs:set-specs-call-1:revisions:SPEC-A@1,SPEC-B@3',
      diagnostics: {
        revisions: [
          { specId: 'SPEC-A', revision: 1, status: 'created' },
          { specId: 'SPEC-B', revision: 3, status: 'revised' },
        ],
      },
    });

    expect(receipt({}, result({
      ok: false,
      results: [{ ok: false, slug: 'plan', specId: 'SPEC-C', error: 'conflict' }],
      counts: { ok: 0, failed: 1 },
    }), attempt)).toMatchObject({ status: 'not-recorded' });

    expect(setSpecsAbortCompletionReceipt({}, result({
      ok: true,
      results: [{ ok: true, slug: 'plan', specId: 'SPEC-A', status: 'revised' }],
      counts: { ok: 1, failed: 0 },
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-landed-spec-revision'],
    });
  });
});
