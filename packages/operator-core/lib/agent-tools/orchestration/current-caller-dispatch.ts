/**
 * The one current-caller dispatch wrapper for recipe-script execution.
 *
 * Inline code:run, saved-recipe replay, and future durable execution must all
 * enter this wrapper before the real projected-tool dispatcher. It reproduces
 * the workspace/principal/transaction binding of a direct MCP call for every
 * nested dispatch and forces lossless in-process result semantics. A recipe
 * carries source and revision metadata only; no author privilege reaches here.
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
import {
  boundWorkspaceTx,
  type UnifiedToolContext,
  type WrapDispatch,
} from '@papercusp/agent-mcp';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { runWithoutAmbientArgPeeling } from '../ambient-args-scope';
import { applyScopedSuperuserTransportBoundary } from '../../endpoint-route/routes/transport/scoped-superuser-transport-boundary';
import {
  dispatchNeedsTx,
  effectiveDispatchWorkspace,
  synthesizeDispatchPrincipal,
  synthesizeTransportPrincipal,
} from '../../endpoint-route/routes/transport/role-principal-caps';
import { ToolDispatchError, unwrapToolResult, type ToolResult } from '@papercusp/tooldef';
import { pinModuleState } from '@papercusp/module-singleton';
import { resolveHarnessScope } from '../_harness-scope';
import {
  applyNestedProjection,
  nestedProjectionContext,
  nestedProjectionInvalidMessage,
  prepareNestedProjection,
} from '../../result-projection';

type AcceptanceStep = 'pending' | 'passed' | 'stopped';
// runToolOrchestration creates a fresh signal for each run, including saved recipes
// and durable execution. A weak key keeps this barrier local to that run's lifetime.
const acceptanceRuns = pinModuleState('@papercusp/operator.acceptance-orchestration', () =>
  new WeakMap<AbortSignal, Map<string, AcceptanceStep>>(),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// An outer code:run may name the work-item whose nested shell calls serve. Keep
// this binding private to the orchestration context so a nested capability:bash
// can use it only when its own call omits work_item_id; explicit nested
// attribution always wins.
const NESTED_WORK_ITEM_ID = Symbol('papercusp.current-caller.nested-work-item-id');
type NestedWorkItemContext = UnifiedToolContext & { [NESTED_WORK_ITEM_ID]?: string };

export function withNestedWorkItemId(
  ctx: UnifiedToolContext,
  workItemId?: string | null,
): UnifiedToolContext {
  const id = workItemId?.trim();
  if (!id) return ctx;
  const enriched = { ...ctx } as NestedWorkItemContext;
  enriched[NESTED_WORK_ITEM_ID] = id;
  return enriched;
}

function nestedWorkItemId(ctx: UnifiedToolContext): string | undefined {
  return (ctx as NestedWorkItemContext)[NESTED_WORK_ITEM_ID];
}

function applyNestedWorkItemId(
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
): unknown {
  const workItemId = nestedWorkItemId(ctx);
  if (!workItemId) return input;

  const args = record(input);
  if (!args) return input;

  // Direct facade calls are the common path. Also cover the compatibility
  // tools:invoke spelling so both routes preserve the same attribution.
  if (toolName === 'capability:bash') {
    return Object.prototype.hasOwnProperty.call(args, 'work_item_id')
      ? input
      : { ...args, work_item_id: workItemId };
  }
  if (toolName === 'tools:invoke' && args.name === 'capability:bash') {
    const nestedArgs = record(args.args);
    if (!nestedArgs || Object.prototype.hasOwnProperty.call(nestedArgs, 'work_item_id')) return input;
    return { ...args, args: { ...nestedArgs, work_item_id: workItemId } };
  }
  return input;
}

function acceptanceCall(name: string, input: unknown, ctx: UnifiedToolContext) {
  let args = record(input);
  // The original caller used tools:invoke. Apply the same barrier to both spellings.
  while (name === 'tools:invoke' && typeof args?.name === 'string') {
    name = args.name;
    args = record(args.args);
  }
  const evaluation = name === 'plans:evaluate-spec-test-adequacy';
  const dependent = name === 'plans:certify-spec-clauses' ||
    (name === 'plans:set-plan-status' && (args?.status === 'shipped' || args?.status === 'done'));
  if ((!evaluation && !dependent) || !args) return undefined;
  const slugs = typeof args.slug === 'string' ? [args.slug] : Array.isArray(args.slugs) ? args.slugs : [];
  const harnessScope = resolveHarnessScope(typeof args.harness === 'string' ? args.harness : undefined, ctx);
  const harnessIdentity = harnessScope.kind === 'harness' ? `harness:${harnessScope.slug}` : harnessScope.kind;
  return {
    evaluation,
    keys: slugs.filter((slug): slug is string => typeof slug === 'string').map(slug =>
      JSON.stringify([ctx.workspaceId, harnessIdentity, slug])),
  };
}

function completePassingEvaluation(value: unknown): boolean {
  const result = record(value);
  const rows = result?.rows;
  return result?.ok === true && !result.error && result.partial !== true && result._partial !== true &&
    result.truncated !== true && record(result._projection)?.truncated !== true &&
    result.classRefSource === 'active-acceptance-rubric' && typeof result.classRef === 'string' &&
    typeof result.count === 'number' && result.count > 0 &&
    Array.isArray(result.wouldBlock) && result.wouldBlock.length === 0 &&
    Array.isArray(rows) && rows.length === result.count && rows.every(row => {
      const clause = record(row);
      return clause?.verdict === 'pass' && Array.isArray(clause.wouldBlock) && clause.wouldBlock.length === 0;
    });
}

/**
 * Rebind one nested orchestration call exactly as a direct MCP dispatch would.
 *
 * The common concrete-workspace path reuses an already-correct outer
 * transaction. Unscoped-superuser workspace hops, cross-workspace tools, and
 * transaction-free tools receive the same per-call binding they get outside a
 * recipe script. Every path gets code-mode, full-payload, transport-cap-exempt
 * semantics because intermediate values stay inside the script runtime.
 */
const rebindCurrentCallerDispatch: WrapDispatch = async (tool, _toolName, args, ctx, next) => {
  const spawnCtxLike = {
    workspaceId: ctx.workspaceId ?? '',
    role: ctx.role ?? '',
    isSuperuser: ctx.isSuperuser,
  };
  const boundary = await applyScopedSuperuserTransportBoundary(
    { name: _toolName, crossWorkspace: tool.crossWorkspace, profile: tool.profile },
    { workspaceId: spawnCtxLike.workspaceId, isSuperuser: spawnCtxLike.isSuperuser, profile: ctx.profile },
  );
  if (!boundary.ok) return boundary.result;

  const effectiveWs = effectiveDispatchWorkspace(spawnCtxLike, args);

  const baseCtx: UnifiedToolContext = {
    ...ctx,
    // Projection metadata describes the parent's result, not this child read.
    // Inheriting it can narrow source queries before the script sees the data.
    // projectedNext installs this child's own explicit projection afterward.
    sourceProjection: undefined,
    sourceMaterialization: undefined,
    // A direct facade call has no tools:invoke target argument on which the
    // projected dispatcher can carry `payloadTier:'full'`. Match that route's
    // materialization contract in the context as well: raw handlers that
    // derive their result shape from the resolved tier must see full detail,
    // just like handlers reached through the universal invoke door.
    contextTier: 'full',
    payloadTierOverride: 'full',
    transportCapExempt: true,
    codeMode: true,
    indirectDispatch: true,
  };

  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const callCtx: UnifiedToolContext = {
      ...baseCtx,
      workspaceId: effectiveWs,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, { ...spawnCtxLike, workspaceId: effectiveWs }),
    };
    return runWithWorkspaceIfConcrete(effectiveWs, () => next(callCtx));
  }

  const outerTx = boundWorkspaceTx(ctx);
  if (
    tool.needsWorkspaceTx === true &&
    effectiveWs === spawnCtxLike.workspaceId &&
    outerTx !== undefined
  ) {
    return next({ ...baseCtx, tx: outerTx });
  }

  const callSpawnCtx = { ...spawnCtxLike, workspaceId: effectiveWs };
  if (!dispatchNeedsTx(callSpawnCtx)) {
    return runWithWorkspaceIfConcrete(effectiveWs, () => next({ ...baseCtx, workspaceId: effectiveWs }));
  }

  // A concrete-workspace superuser principal is fully derivable from transport
  // context: it has the system/operator identity and capability bypass, never a
  // provisioned per-workspace capability set. Opening `withWorkspace` merely to
  // synthesize that principal retained an org-app pool slot for every nested
  // transaction-free capability and made hermetic orchestration tests attempt a
  // real Postgres connection. Direct transaction-free SU dispatch needs neither.
  if (tool.needsWorkspaceTx !== true && callSpawnCtx.isSuperuser === true) {
    return runWithWorkspaceIfConcrete(effectiveWs, () =>
      next({
        ...baseCtx,
        workspaceId: effectiveWs,
        tx: undefined,
        principal: synthesizeTransportPrincipal(callSpawnCtx) ?? undefined,
      }),
    );
  }

  if (tool.needsWorkspaceTx !== true) {
    return runWithWorkspaceIfConcrete(effectiveWs, () =>
      withWorkspace(effectiveWs, async (tx) => {
        const principal = await synthesizeDispatchPrincipal(tx, callSpawnCtx);
        return next({ ...baseCtx, workspaceId: effectiveWs, tx: undefined, principal });
      }),
    );
  }

  return runWithWorkspaceIfConcrete(effectiveWs, () =>
    withWorkspace(effectiveWs, async (tx) => {
      const callCtx: UnifiedToolContext = {
        ...baseCtx,
        workspaceId: effectiveWs,
        tx,
        principal: await synthesizeDispatchPrincipal(tx, callSpawnCtx),
      };
      return next(callCtx);
    }),
  );
};

/**
 * The wrapper every nested orchestration call actually enters.
 *
 * Adds one fact to the rebinding above: this dispatch peels NO ambient dispatch-level
 * args (EI-22295290349236847). Only the MCP transport strips `projection`/`view`, so a
 * nested call reaches the target schema with both intact and an invalid-args rejection
 * here must not advertise them as accepted — see `../ambient-args-scope.ts`.
 *
 * The scope wraps the WHOLE rebinding rather than each `next(...)` because that function
 * has seven return paths and a per-path wrap is one refactor away from silently missing
 * one. Argument validation runs inside `next` (orchestrate.ts's `call` → `realDispatch`),
 * so it is covered by this scope.
 */
export const bindCurrentCallerDispatch: WrapDispatch = async (tool, toolName, args, ctx, next) => {
  const prepared = prepareNestedProjection(args);
  if (prepared.error) {
    return Promise.reject(new ToolDispatchError(toolName, 'invalid_input', nestedProjectionInvalidMessage(prepared.error)));
  }

  const dispatchArgs = applyNestedWorkItemId(toolName, prepared.args, ctx);
  const acceptance = acceptanceCall(toolName, dispatchArgs, ctx);
  let steps: Map<string, AcceptanceStep> | undefined;
  if (acceptance && ctx.signal) {
    steps = acceptanceRuns.get(ctx.signal);
    if (!steps) acceptanceRuns.set(ctx.signal, steps = new Map());
    if (acceptance.keys.some(key => {
      const step = steps!.get(key);
      return step !== undefined && step !== 'passed';
    })) {
      throw new ToolDispatchError(toolName, 'acceptance_orchestration_stopped',
        'A prior evaluation is pending, refused, incomplete or uncertain. Archive the original receipt; ' +
        'do not replay evaluation or dispatch dependent certification/gate/recruitment in this run.');
    }
    if (acceptance.evaluation) for (const key of acceptance.keys) steps.set(key, 'pending');
  }

  let complete = false;

  const projectedNext = async (callCtx: UnifiedToolContext): Promise<unknown> => {
    const materializedCtx = nestedProjectionContext(callCtx, dispatchArgs, prepared.spec);
    const result = await next(materializedCtx, dispatchArgs);
    // Inspect the full receipt BEFORE a caller projection can hide the refusal.
    if (acceptance?.evaluation && steps) {
      const body = record(result)?.content ? unwrapToolResult(result as ToolResult) : result;
      const step = completePassingEvaluation(body) ? 'passed' : 'stopped';
      for (const key of acceptance.keys) steps.set(key, step);
      complete = true;
    }
    return applyNestedProjection(result, prepared.spec, { toolName, effect: tool.effect });
  };

  try {
    return await runWithoutAmbientArgPeeling(() =>
      rebindCurrentCallerDispatch(tool, toolName, dispatchArgs, ctx, projectedNext),
    );
  } finally {
    // Includes thrown timeouts and dispatch refusals that never entered projectedNext.
    // Catching one in the script cannot erase the barrier or replay the original call.
    if (acceptance?.evaluation && steps && !complete) {
      for (const key of acceptance.keys) steps.set(key, 'stopped');
    }
  }
};
