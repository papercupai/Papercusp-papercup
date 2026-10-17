/** Durable hourly system action for work-item admission P-011 burst detection. */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  captureImprovement,
  recordCaptureReviewFailure,
  setCaptureReviewState,
} from '../improvements/capture-core';
import { enterAgentReview } from '../improvements/agent-review';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { optionalModelSpec } from '../../learning/model-policy';
import { notifySyncInvalidate } from '../../sync-sse';
import { linkWorkItem, resolveWorkItemRef } from '../../work-items';
import {
  DEFAULT_DELTA_CLUSTER_EXEMPLARS,
  DEFAULT_DELTA_TITLE_WINDOW_HOURS,
  DEFAULT_DELTA_WINDOW_MINUTES,
  DELTA_SWEEP_ACTOR,
  runWorkItemAdmissionDeltaSweep,
  WORK_ITEM_ADMISSION_DELTA_SWEEP,
  type DeltaSweepRunResult,
  type DeltaSweepUmbrellaFiler,
  type DeltaSweepUmbrellaLinker,
} from '../../work-items-admission-delta-sweep';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function runId(): string {
  return DBOS.workflowID?.trim() || `${WORK_ITEM_ADMISSION_DELTA_SWEEP}:${randomUUID()}`;
}

export const productionFileUmbrella: DeltaSweepUmbrellaFiler = async (input) => {
  const result = await captureImprovement({
    title: `Possible shared cause: ${input.proposal.title}`,
    kind: 'change',
    reviewRequired: true,
    reviewHarness: input.harnessSlug,
    body:
      `${input.proposal.body}\n\nModel-proposed shared-root-cause hypothesis (not independently verified): ${input.proposal.reason}\n\n` +
      `Contributing admitted work-items: ${input.proposal.memberIds.join(', ')}.`,
    scope: `harness:${input.harnessSlug}`,
    foundDuring: `${WORK_ITEM_ADMISSION_DELTA_SWEEP} ${input.runId}`,
    dedupScope: 'open',
    watchdogKey: input.watchdogKey,
    sourceRole: 'system',
    createdBy: DELTA_SWEEP_ACTOR,
    payloadExtra: {
      admissionDeltaSweep: {
        runId: input.runId,
        memberIds: input.proposal.memberIds,
        reason: input.proposal.reason,
      },
    },
  });
  const reviewId = result.issue?.id;
  if (
    result.created &&
    result.reviewRequired &&
    result.reviewState === 'blocked' &&
    !result.agentReviewFailure &&
    reviewId
  ) {
    let enrollmentSucceeded = false;
    try {
      const enrollment = await enterAgentReview({
        id: reviewId,
        submittedBy: DELTA_SWEEP_ACTOR,
        harnessSlug: input.harnessSlug,
      });
      if (!enrollment.entered) {
        throw new Error(`agent-review enrollment was not entered${enrollment.reason ? `: ${enrollment.reason}` : ''}`);
      }
      enrollmentSucceeded = true;
      const reopened = await setCaptureReviewState(reviewId, 'open', {
        harness: input.harnessSlug,
        by: DELTA_SWEEP_ACTOR,
        reason: 'agent-review enrollment succeeded',
      });
      if ((reopened.appliedState ?? reopened.workItem?.state) !== 'open') {
        throw new Error(`review reopen did not apply open state (appliedState=${reopened.appliedState ?? 'null'})`);
      }
    } catch (error) {
      const phase = enrollmentSucceeded ? 'reopen' : 'enrollment';
      const failure = {
        phase,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      } as const;
      await setCaptureReviewState(reviewId, 'blocked', {
        harness: input.harnessSlug,
        by: DELTA_SWEEP_ACTOR,
        reason: `agent-review-${phase}-failed`,
      }).catch(() => undefined);
      await recordCaptureReviewFailure(
        reviewId,
        failure,
        { submittedBy: DELTA_SWEEP_ACTOR, harness: input.harnessSlug },
      );
    }
  }
  const canonical =
    result.issue?.id ??
    result.possibleDuplicates?.find((candidate) => candidate.state === 'open')?.id ??
    result.possibleDuplicates?.[0]?.id;
  if (!canonical) {
    throw new Error(
      `delta-sweep capture produced no linkable umbrella for '${input.proposal.title}' (${result.reason ?? 'unknown'})`,
    );
  }
  return { id: canonical, created: result.created };
};

export const productionLinkUmbrella: DeltaSweepUmbrellaLinker = async (input) => {
  const umbrella = await resolveWorkItemRef(input.umbrellaId, input.harnessSlug);
  if (!umbrella) throw new Error(`delta-sweep umbrella '${input.umbrellaId}' could not be resolved after capture`);
  let written = 0;
  for (const sourceId of input.sourceIds) {
    const result = await linkWorkItem(sourceId, umbrella, 'relates', {
      harness: input.harnessSlug,
      by: DELTA_SWEEP_ACTOR,
    });
    if ('error' in result)
      throw new Error(`delta-sweep could not link ${sourceId} to ${input.umbrellaId}: ${result.error}`);
    written += 1;
  }
  return written;
};

export interface AdmissionDeltaSweepActionDeps {
  run: (ctx: SystemActionCtx) => Promise<DeltaSweepRunResult>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

async function productionRun(ctx: SystemActionCtx): Promise<DeltaSweepRunResult> {
  if (process.env.VITEST) throw new Error('production admission delta sweep must not run from a unit test');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const payload = ctx.payloadTemplate ?? {};
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runWorkItemAdmissionDeltaSweep({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: runId(),
    recentWindowMinutes: positiveInteger(payload.recentWindowMinutes, DEFAULT_DELTA_WINDOW_MINUTES),
    titleWindowHours: positiveInteger(payload.titleWindowHours, DEFAULT_DELTA_TITLE_WINDOW_HOURS),
    clusterExemplarsPerShard: positiveInteger(payload.clusterExemplarsPerShard, DEFAULT_DELTA_CLUSTER_EXEMPLARS),
    model: optionalModelSpec(payload.model, 'delta sweep'),
    llmCall: (input) => llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug }),
    fileUmbrella: productionFileUmbrella,
    linkUmbrella: productionLinkUmbrella,
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionDeltaSweepAction(overrides: Partial<AdmissionDeltaSweepActionDeps> = {}) {
  const deps: AdmissionDeltaSweepActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_DELTA_SWEEP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    deps.log(
      `${ctx.installSlug}: run=${result.runId} recent=${result.recentItems} ` +
        `umbrellas=${result.umbrellaYield} links=${result.linksWritten} tokens=${result.tokensIn}+${result.tokensOut}`,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_DELTA_SWEEP, makeWorkItemAdmissionDeltaSweepAction());
