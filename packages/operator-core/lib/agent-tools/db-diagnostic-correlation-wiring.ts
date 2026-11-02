/**
 * Wire the db-org local diagnostic correlation seam to the existing named-hop
 * AsyncLocalStorage. The db package owns the optional channel; operator-core
 * owns the stage/attempt policy and supplies the current local context.
 *
 * This is observation-only: the returned tuple never enters LocalWriteOp,
 * crypto AAD, SQL, parameters, or a federated envelope.
 */

import {
  pgDiagnosticIdentity,
  recordPgDiagnosticResponse,
  setPgDiagnosticContextResolver,
  type PgDiagnosticQueryLeg,
  type PgResultDiagnosticCorrelation,
} from '@papercusp/db-org/acquire-registry';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { currentStageDiagnosticContext } from '../sync/hyperbee/stage-stall-log';

/** Source-owned boundaries, never goal ids, query text, or caller payloads. */
type NamedQueryStage = 'goal-detail-dependencies' | 'goal-detail-sql' | 'goal-holder-liveness' |
  'goal-mode-state' | 'goal-portfolio' | 'goal-stewardship' | 'goal-worklist-history' |
  'stewardship-dependencies' | 'stewardship-scorecards' | 'stewardship-rubrics' |
  'stewardship-repairs' | 'stewardship-lineage' | 'scorecards-generation' | 'scorecards-rubric' |
  'native-session-verifier-workspace-transaction' | 'native-session-verifier-global-transaction' |
  'native-session-verifier-owner-row-lookup' | 'native-session-verifier-owner-candidate-rows-lookup' |
  'work-item-detail-import' | 'work-item-detail-enrichment' | 'work-item-detail-row' |
  'work-item-detail-dimensions' | 'work-item-detail-reporter' | 'work-item-detail-presentation' |
  'work-item-dependencies-import' | 'work-item-dependencies-sql' |
  'work-item-dependency-waits-import' | 'work-item-dependency-waits-sql' |
  'scorecards-get-evidence-read' | 'scorecards-get-rubric-read' |
  'rubric-plan-row-read' | 'rubric-row-map' | 'rubric-first-party-seed' |
  'dream-dependencies-import' | 'dream-observation-import' | 'dream-journal-dependencies-import' |
  'dream-action-journal' | 'dream-gym-journal' | 'dream-decision-journal-snapshot' | 'dream-workspace-transaction' | 'dream-observation-read' |
  'dream-observation-flags' | 'dream-observation-routines' | 'dream-observation-gym' |
  'dream-observation-governors' | 'dream-observation-activity' | 'dream-observation-spend' |
  'testing-runs-rollup' | 'testing-runs-latest-rows' | 'testing-runs-history-rows' |
  'testing-runs-source-omissions' | 'testing-runs-foreground-run' | 'testing-runs-case-results';
interface NamedQueryStageTiming {
  stage: NamedQueryStage;
  startedAt: number;
  elapsedMs: number | null;
  outcome: 'pending' | 'fulfilled' | 'rejected';
}

const REQUEST_CONTEXT = pinModuleState(
  'operator-core.db-diagnostic-correlation.request-context',
  () => new AsyncLocalStorage<PgResultDiagnosticCorrelation & {
    diagnostics: { stages: NamedQueryStageTiming[]; omittedStages: number };
  }>(),
);

/** The route passes only a registry-confirmed name, or null for an unknown operation. */
export function withNamedQueryDiagnosticContext<T>(
  operation: string | null,
  fn: (requestId: string) => T,
  requestIdOverride?: string | null,
): T {
  // The MCP proxy trace is already validated at the transport boundary. Keep
  // the seam strict too, so an arbitrary caller cannot turn request metadata
  // into a retained correlation token.
  const requestId = typeof requestIdOverride === 'string' && /^[a-f0-9-]{36}$/i.test(requestIdOverride)
    ? requestIdOverride
    : randomUUID();
  return REQUEST_CONTEXT.run(Object.freeze({
    ...pgDiagnosticIdentity(),
    rowId: null,
    attemptId: requestId,
    hopId: null,
    stage: null,
    boundary: null,
    requestId,
    diagnostics: { stages: [], omittedStages: 0 },
    ...(operation ? { operation } : {}),
  }), () => fn(requestId));
}

/** Add a source-owned leg label to one query while preserving the request identity. */
export function withNamedQueryDiagnosticLeg<T>(queryLeg: PgDiagnosticQueryLeg, fn: () => T): T {
  const request = REQUEST_CONTEXT.getStore();
  if (!request) return fn();
  return REQUEST_CONTEXT.run(Object.freeze({ ...request, queryLeg }), fn);
}

/** Retain pending boundaries too: a timeout must name work that never settled. */
export async function traceNamedQueryStage<T>(stage: NamedQueryStage, run: () => PromiseLike<T>): Promise<T> {
  const context = REQUEST_CONTEXT.getStore();
  if (!context) return await run();
  if (context.diagnostics.stages.length >= 32) {
    context.diagnostics.omittedStages++;
    return await run();
  }
  const timing: NamedQueryStageTiming = { stage, startedAt: performance.now(), elapsedMs: null, outcome: 'pending' };
  context.diagnostics.stages.push(timing);
  try {
    const value = await run();
    timing.outcome = 'fulfilled';
    return value;
  } catch (error) {
    timing.outcome = 'rejected';
    throw error;
  } finally {
    timing.elapsedMs = Math.max(0, performance.now() - timing.startedAt);
  }
}

/** Snapshot the current request only; overlapping stages are not additive. */
export function namedQueryStageTimings(): {
  requestId: string | undefined;
  omittedStages: number;
  stages: Array<{ stage: NamedQueryStage; elapsedMs: number; outcome: NamedQueryStageTiming['outcome'] }>;
} | null {
  const context = REQUEST_CONTEXT.getStore();
  if (!context?.diagnostics.stages.length) return null;
  return { requestId: context.requestId, omittedStages: context.diagnostics.omittedStages, stages: context.diagnostics.stages.map(timing => ({
    stage: timing.stage,
    elapsedMs: Math.round(timing.elapsedMs ?? Math.max(0, performance.now() - timing.startedAt)),
    outcome: timing.outcome,
  })) };
}

/** Record the exact main-process objects, never a serializer-worker clone. */
export function recordNamedQueryResponse(
  phase: 'resolvedRows' | 'responseValue', value: unknown,
): void {
  const context = REQUEST_CONTEXT.getStore();
  if (context) recordPgDiagnosticResponse(context, phase, value);
}

export function installDbDiagnosticCorrelationWiring(): void {
  setPgDiagnosticContextResolver((): PgResultDiagnosticCorrelation | null => {
    const stage = currentStageDiagnosticContext();
    const request = REQUEST_CONTEXT.getStore();
    if (!stage) return request ?? null;
    return request ? {
      ...stage,
      requestId: request.requestId,
      operation: request.operation,
      ...(request.queryLeg ? { queryLeg: request.queryLeg } : {}),
    } : stage;
  });
}

installDbDiagnosticCorrelationWiring();
