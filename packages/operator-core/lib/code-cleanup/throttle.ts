/**
 * Regression throttle and outcome metrics for a cleanup campaign
 * (code-cleanup-campaigns-2026-10-26 P-008, R-9, D-004).
 *
 * Review is off by default (D-004), so the automated gate is the only default safety net. When
 * gate reds attributed to a campaign's cleanup changes exceed the threshold (default 2 within
 * 7 days), the campaign starts no new batches and its review setting becomes `required` until an
 * OWNER principal resets it.
 *
 * Attribution:
 *  - papercusp tree (`ledger` mode): a failing test counts against a batch when its affected
 *    radius intersects a file that has an edit_attribution_ledger row for the batch's work-item;
 *  - user repos (`commit` mode): the gate attributes each red to a commit, and the red counts
 *    when that commit is one the batch landed.
 * A red outside every batch's radius is never counted. Each red counts once, however many
 * batches it touches. Reds observed at or before the last owner reset do not count again, so a
 * reset is not undone by the reds that caused the trip.
 *
 * Owner principal: the authenticated human doors (`admin:*`, `user:*`), classified by
 * governance-policy/authority `principalKindOf`. Every other principal, including any agent
 * session id, is a service identity and cannot reset a throttled campaign.
 *
 * Everything here is pure. The durable throttle state, the owner-reset door and the native
 * readers (edit_attribution_ledger, test_runs) land with the campaign runner (P-009, D-010, D-013).
 */
import { principalKindOf } from '../governance-policy/authority';
import { admitBatches, type AdmissionDeps, type AdmissionInput, type AdmissionSkip, type AdmittedBatch } from './admission';
import type { CampaignReview } from './campaign-plan';

export const DEFAULT_REGRESSION_THRESHOLD = 2;
export const DEFAULT_REGRESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AttributionMode = 'ledger' | 'commit';

/** One failing gate observation. */
export interface GateRed {
  /** Stable id of the observation (for example the test_runs row id). */
  id: string;
  testFile: string;
  at: Date;
  /** `ledger` mode: files whose change selects this test. */
  affectedRadius?: readonly string[];
  /** `commit` mode: the commit the gate attributed this red to. */
  attributedCommit?: string | null;
}

/** A batch that landed, with what attribution needs to know about it. */
export interface LandedBatch {
  batchId: string;
  workItemId: string;
  /** `ledger` mode: files with edit_attribution_ledger rows for the batch's work-item. */
  editedFiles?: readonly string[];
  /** `commit` mode: commits the batch landed. */
  commits?: readonly string[];
  /** Lines the batch removed (net), for the outcome metrics. */
  linesRemoved?: number;
}

export interface CampaignThrottleState {
  throttled: boolean;
  review: CampaignReview;
  /** The review setting to restore on reset; null while not throttled. */
  reviewBeforeTrip: CampaignReview | null;
  trippedAt: Date | null;
  resetAt: Date | null;
  resetBy: string | null;
}

export function initialThrottleState(review: CampaignReview): CampaignThrottleState {
  return { throttled: false, review, reviewBeforeTrip: null, trippedAt: null, resetAt: null, resetBy: null };
}

export interface AttributedRed { redId: string; testFile: string; at: Date; batchIds: string[] }

/** The reds that land inside at least one batch's radius, each once, with the batches it hits. */
export function attributeReds(reds: readonly GateRed[], batches: readonly LandedBatch[], mode: AttributionMode): AttributedRed[] {
  const out = new Map<string, AttributedRed>();
  for (const red of reds) {
    if (out.has(red.id)) continue;
    const hit = batches.filter(b => batchOwnsRed(b, red, mode)).map(b => b.batchId);
    if (hit.length) out.set(red.id, { redId: red.id, testFile: red.testFile, at: red.at, batchIds: [...new Set(hit)].sort() });
  }
  return [...out.values()];
}

function batchOwnsRed(batch: LandedBatch, red: GateRed, mode: AttributionMode): boolean {
  if (mode === 'commit') {
    return !!red.attributedCommit && (batch.commits ?? []).includes(red.attributedCommit);
  }
  const edited = new Set(batch.editedFiles ?? []);
  return (red.affectedRadius ?? []).some(f => edited.has(f));
}

export interface ThrottleEvaluationInput {
  state: CampaignThrottleState;
  reds: readonly GateRed[];
  batches: readonly LandedBatch[];
  mode: AttributionMode;
  now: Date;
  threshold?: number;
  windowMs?: number;
}

export interface ThrottleEvaluation {
  /** Attributed reds inside the window and after the last reset. */
  counted: AttributedRed[];
  count: number;
  threshold: number;
  /** True only on the evaluation that moved the campaign into the throttled state. */
  tripped: boolean;
  state: CampaignThrottleState;
}

function nonNegativeInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return value;
}

/** Count attributed reds and trip the throttle when they exceed the threshold. */
export function evaluateRegressionThrottle(input: ThrottleEvaluationInput): ThrottleEvaluation {
  const threshold = nonNegativeInt(input.threshold ?? DEFAULT_REGRESSION_THRESHOLD, 'threshold');
  const windowMs = input.windowMs ?? DEFAULT_REGRESSION_WINDOW_MS;
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error(`windowMs must be a positive integer, got ${windowMs}`);
  const now = input.now.getTime();
  const since = now - windowMs;
  const resetAt = input.state.resetAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const counted = attributeReds(input.reds, input.batches, input.mode).filter(r => {
    const t = r.at.getTime();
    return t >= since && t <= now && t > resetAt;
  });
  const count = counted.length;
  if (input.state.throttled || count <= threshold) {
    return { counted, count, threshold, tripped: false, state: input.state };
  }
  return {
    counted, count, threshold, tripped: true,
    state: { ...input.state, throttled: true, review: 'required', reviewBeforeTrip: input.state.review, trippedAt: input.now },
  };
}

export type ThrottleResetResult =
  | { ok: true; state: CampaignThrottleState }
  | { ok: false; code: 'not-owner' | 'not-throttled'; detail: string };

/** Clear a throttled campaign. Only an owner principal may; review returns to its pre-trip value. */
export function resetRegressionThrottle(state: CampaignThrottleState, principal: string, now: Date): ThrottleResetResult {
  if (principalKindOf(principal) !== 'human') {
    return { ok: false, code: 'not-owner', detail: `principal "${principal}" is not an owner principal (admin:* or user:*); agents cannot reset a throttled campaign` };
  }
  if (!state.throttled) return { ok: false, code: 'not-throttled', detail: 'campaign is not throttled' };
  return {
    ok: true,
    state: { throttled: false, review: state.reviewBeforeTrip ?? state.review, reviewBeforeTrip: null, trippedAt: null, resetAt: now, resetBy: principal },
  };
}

export type GatedSkipReason = AdmissionSkip['reason'] | 'campaign-throttled';
export interface GatedSkip extends Omit<AdmissionSkip, 'reason'> { reason: GatedSkipReason }
export interface GatedAdmissionResult { throttled: boolean; admitted: AdmittedBatch[]; skipped: GatedSkip[] }

/**
 * One admission round under the throttle: a throttled campaign starts nothing and takes no locks;
 * otherwise admission (R-7) decides as usual.
 */
export async function admitCampaignRound(
  input: AdmissionInput, deps: AdmissionDeps, state: CampaignThrottleState,
): Promise<GatedAdmissionResult> {
  if (state.throttled) {
    const detail = `campaign ${input.campaignId} is throttled since ${state.trippedAt?.toISOString() ?? 'unknown'}; an owner principal must reset it`;
    return {
      throttled: true,
      admitted: [],
      skipped: input.candidates.map(b => ({ batchId: b.id, reason: 'campaign-throttled', paths: [...b.targetFiles], detail })),
    };
  }
  return { throttled: false, ...(await admitBatches(input, deps)) };
}

export interface CampaignOutcome {
  batchesLanded: number;
  linesRemoved: number;
  attributedReds: number;
  /** Attributed reds per landed batch; 0 when nothing landed. */
  regressionRate: number;
}

/** The outcome metrics the campaign's outcome rubric grades (batches landed, lines removed, regression rate). */
export function campaignOutcome(batches: readonly LandedBatch[], attributed: readonly AttributedRed[]): CampaignOutcome {
  const batchesLanded = batches.length;
  const linesRemoved = batches.reduce((n, b) => n + Math.max(0, b.linesRemoved ?? 0), 0);
  const attributedReds = new Set(attributed.map(r => r.redId)).size;
  return { batchesLanded, linesRemoved, attributedReds, regressionRate: batchesLanded ? attributedReds / batchesLanded : 0 };
}
