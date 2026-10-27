/**
 * Reflective proposer (P-015) — GEPA's reflective-mutation mechanism (D-007),
 * v1 prompts-only (D-015).
 *
 * Reads the parent variant's worst-scoring train traces + the judge's RATIONALES
 * (the reflection signal) + the running changelog, and emits a targeted PROMPT diff
 * for one or a few roles → a candidate overlay (parent overrides ⊕ the proposed
 * changes). Model/orchestration mutation is reserved for a later phase (D-015). LLM
 * injected so build → call → parse → merge is unit-tested without the network.
 */
import { tryParseJson } from './parse-json';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import type { GymLlmCall } from './task-generator';
import type { JudgeLlmCall } from './judge';
import { createHash } from 'node:crypto';
import type { RunAgentChatOptions } from '../agent-chat-stream';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult, GatewayCarryTrialBinding } from '../inference-gateway/gateway';
import type { GatewayServiceOptions, RunningGatewayService } from '../inference-gateway/launch';
import { runGovernedSpendAttempt, type GovernorGlueDeps, type SpendAttemptReport } from '../learning-governor/registrants';
import type { CycleSpendReservationScope, LearningReservationResourceBudget, ReserveLearningSpendInput } from '../learning-governor/store';
import { recordLearningSpendAttemptResult } from '../learning-governor/store';
import { processMonotonicClock } from '../process-monotonic-clock';

export interface WorstTrace {
  taskId: string;
  composite: number;
  rationale: string;
  /** Optional distilled trace excerpt for deeper reflection. */
  distilledTrace?: string;
}

export interface ProposeInput {
  /** The parent variant's overlay to mutate from. */
  parentOverlay: VariantOverlay;
  /** The parent's worst-scoring train traces (with judge rationales). */
  worstTraces: WorstTrace[];
  /** The running judge changelog (anchored to hard numbers + narrative). */
  changelog: string;
  /** Model that proposes — should differ from the judge for the same decorrelation spirit. */
  proposerModel: string;
  /** Supplied output bound; no model-dependent default is invented here. */
  maxTokens?: number;
  /**
   * P-032 (learning-system-audit): operator improvement ideas TRIAGED TO THE GYM
   * (payload.ideaLifecycle.triageDecision='gym'), pre-formatted one per line.
   * Surfaced to the proposer as OPTIONAL candidate directions; empty/absent ⇒
   * the prompt is byte-identical to before (purely additive).
   */
  candidateDirections?: string[];
  /**
   * P-030 (consume-edges B-09): recent champions' MEASURED post-acceptance
   * outcomes (live success-rate delta vs the pre-acceptance baseline),
   * pre-formatted one entry per line (post-acceptance-outcomes.ts,
   * formatChampionOutcomeEntries). Empty/absent ⇒ byte-identical prompt.
   */
  championOutcomes?: string[];
}

export interface ParsedProposal {
  promptOverrides: Record<string, string>;
  rationale: string;
}

export interface CandidateProposal {
  overlay: VariantOverlay;
  rationale: string;
  diffFromParent: string;
  /** Cost of the proposer call, including a response that later fails validation. */
  costUsd: number;
  /** The reported cost is only a subtotal; keep the reservation open. */
  costUsdMeasurementMissing?: boolean;
  unreportedFrames?: number;
}

/** Native judge/proposer network recovery. Another dispatch is safe here only
 * after a complete, explicitly measured zero-cost failure. A network error
 * alone does not establish that inference never ran; preserve unknown spend
 * for the caller's reservation/settlement path. */
export function withGymLlmNetworkRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  deps: { log: (message: string) => void; sleep?: (ms: number) => Promise<void> },
): (...args: A) => Promise<R> {
  const sleep = deps.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });
  return async (...args: A): Promise<R> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { return await fn(...args); }
      catch (error) {
        lastErr = error;
        const message = error instanceof Error ? error.message : String(error);
        const usage = error as { costUsd?: unknown; costUsdMeasurementMissing?: unknown; unreportedFrames?: unknown } | null;
        const measuredZero = usage?.costUsd === 0 &&
          (usage.costUsdMeasurementMissing === undefined || usage.costUsdMeasurementMissing === false) &&
          (usage.unreportedFrames === undefined || usage.unreportedFrames === 0);
        if (!/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message) ||
          !measuredZero || attempt === 2) throw error;
        deps.log(`llm call known-zero network failure (attempt ${attempt + 1}/3): ${message.slice(0, 120)}`);
        await sleep(2_000 * (attempt + 1));
      }
    }
    throw lastErr;
  };
}

type NativeGymLlmRequest = Parameters<JudgeLlmCall>[0] & {
  priority?: string;
  harnessSlug?: string;
  requireOutputTokenLimit?: boolean;
} & Pick<RunAgentChatOptions, 'statelessGateway' | 'authorizeStatelessRequest'>;

type NativeGymTransport = Pick<RunAgentChatOptions, 'statelessGateway' | 'authorizeStatelessRequest'>;

/** Host-issued authority for this cycle. The host owns authenticated provider
 * identity, native bounds, reservation and settlement; a caller bearer digest
 * alone does not establish any of those. Never derive authority from env. */
export interface NativeGymGatewayConfig {
  token: string;
  carryTrial: GatewayCarryTrialBinding;
}

/** Host authentication must identify the final provider credential, model and
 * body before supplying these approved bounds. A caller token is insufficient.
 * The check must also remain valid synchronously at the provider send. */
export interface NativeGymProviderAuthorization {
  attemptKind: 'evaluation' | 'proposer';
  requestedUsd: number;
  inputTokens: number;
  outputTokens: number;
  validUntilMonotonicMs: number;
  validateAuthorization: () => void;
  inputEvidence?: {
    kind: 'provider-input-count'; sourceSha256: string; bodySha256: string;
    countBodySha256: string; responseSha256: string; requestId: string | null;
    measuredInputTokens: number;
  } | {
    /** A route with no count endpoint and no per-request output field (a
     * ChatGPT Codex subscription) reserves the provider's own frozen limits.
     * It is the only evidence that lets an oauth-http body omit its output cap. */
    kind: 'provider-intrinsic-limit'; sourceSha256: string; bodySha256: string;
    inputTokens: number; outputTokens: number;
  } | {
    /** A fresh canonical Anthropic model response, not an estimated count.
     * The request retains its explicit output cap and uses no beta headers. */
    kind: 'provider-model-limit'; sourceSha256: string; bodySha256: string;
    responseSha256: string; requestId: string | null; model: string;
    inputTokens: number; outputTokens: number; anthropicVersion: '2023-06-01';
  };
}

/** Issue authority through the existing cycle ledger and gateway receipt. No
 * account, model, token budget or monetary policy is inferred here. The host
 * must supply its registered policy and authenticate each selected provider.
 * Header/fetch evidence cannot settle usage; only pre-fetch refusal proves zero.
 */
export function createNativeGymGatewayController(input: {
  workspaceId: string;
  loopId: string;
  potSlug?: string | null;
  token: string;
  manifestSha256: string;
  armId: string;
  outputTokenLimit?: number;
  /** Existing Gym cycles and frozen benchmark lifetime grants share the same
   * authenticated send guard. Exactly one budget identity must be supplied. */
  cycle?: { runId: string; budgetUsd: number; resourceBudget: LearningReservationResourceBudget };
  exact?: { binding: string; budgetUsd: number; resourceBudget: LearningReservationResourceBudget };
  authorizeProviderAttempt: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>;
}, governor?: GovernorGlueDeps): { gateway: NativeGymGatewayConfig; revoke: () => void } {
  const invalid = () => Object.assign(new Error('Native Gym gateway controller requires approved policy'), { costUsd: 0 });
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const usd = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 &&
    Number.isSafeInteger(Math.round(n * 1_000_000)) && Math.round(n * 1_000_000) / 1_000_000 === n;
  const text = (s: unknown): s is string => typeof s === 'string' && s.trim() === s && s.length > 0;
  if (!input || Boolean(input.cycle) === Boolean(input.exact)) throw invalid();
  // Snapshot caller policy and callbacks before any asynchronous authentication.
  const { workspaceId, loopId, potSlug, token, manifestSha256, armId, outputTokenLimit, authorizeProviderAttempt } = input;
  const scope = input.exact ?? input.cycle!;
  const budgetUsd = scope.budgetUsd;
  const runId = input.cycle?.runId;
  const binding = input.exact?.binding;
  if (!scope.resourceBudget || !Array.isArray(scope.resourceBudget.armIds)) throw invalid();
  const resourceBudget = { ...scope.resourceBudget, armIds: [...scope.resourceBudget.armIds] };
  if (!text(workspaceId) || !text(loopId) || !text(armId) || armId.length > 256 ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) || !text(token) || token.length < 32 ||
    (input.cycle ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId!) :
      !/^[a-f0-9]{64}$/.test(binding!) || binding !== manifestSha256) || !usd(budgetUsd) ||
    !count(resourceBudget.inputTokens) || !count(resourceBudget.outputTokens) || resourceBudget.outputTokens === 0 ||
    !count(resourceBudget.requestsPerArm) || resourceBudget.requestsPerArm === 0 ||
    resourceBudget.totalTokensPerArm !== undefined && (!count(resourceBudget.totalTokensPerArm) || resourceBudget.totalTokensPerArm === 0) ||
    outputTokenLimit !== undefined && (!count(outputTokenLimit) || outputTokenLimit === 0 || outputTokenLimit > resourceBudget.outputTokens) ||
    resourceBudget.armIds.length > 1000 || !resourceBudget.armIds.every(text) ||
    new Set(resourceBudget.armIds).size !== resourceBudget.armIds.length || !resourceBudget.armIds.includes(armId) ||
    typeof authorizeProviderAttempt !== 'function') throw invalid();
  Object.freeze(resourceBudget.armIds); Object.freeze(resourceBudget);
  const deps = governor ? { ...governor } : undefined;
  let live = true;
  const seen = new Set<string>();
  const pending = new Set<() => void>();
  const gateway = snapshotNativeGymGatewayConfig({ token, carryTrial: {
    manifestSha256, armId, requestTokenSha256: createHash('sha256').update(token).digest('hex'),
    ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
    protocols: ['anthropic-messages', 'openai-responses'],
    async authorizeAttempt(value) {
      const attempt = Object.freeze({ ...value });
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
        !text(attempt.attemptId) || seen.has(attempt.attemptId) || attempt.manifestSha256 !== manifestSha256 ||
        attempt.armId !== armId || !text(attempt.accountId) || !/^[a-f0-9]{64}$/.test(attempt.credentialSha256) ||
        attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex')) return null;
      seen.add(attempt.attemptId);
      try {
        const supplied = await authorizeProviderAttempt(attempt);
        if (!supplied) return null;
        const authority = Object.freeze({ ...supplied });
        const body = JSON.parse(attempt.body);
        const proof = authority.inputEvidence;
        // The subscription backend rejects max_output_tokens, so the gateway strips it.
        // Only host evidence of the provider's own frozen output limit can stand in.
        const intrinsic = proof?.kind === 'provider-intrinsic-limit' && attempt.transport === 'oauth-http' &&
          body.max_output_tokens === undefined;
        const output = attempt.transport === 'anthropic-http' ? body.max_tokens :
          intrinsic ? proof.outputTokens : body.max_output_tokens;
        if (!live || attempt.signal.aborted || !['evaluation', 'proposer'].includes(authority.attemptKind) ||
          !usd(authority.requestedUsd) || authority.requestedUsd > budgetUsd ||
          !count(authority.inputTokens) || authority.inputTokens > resourceBudget.inputTokens ||
          !count(authority.outputTokens) || authority.outputTokens === 0 || output !== authority.outputTokens ||
          authority.outputTokens > resourceBudget.outputTokens ||
          resourceBudget.totalTokensPerArm !== undefined &&
            (!count(authority.inputTokens + authority.outputTokens) || authority.inputTokens + authority.outputTokens > resourceBudget.totalTokensPerArm) ||
          typeof authority.validateAuthorization !== 'function' ||
          !Number.isFinite(authority.validUntilMonotonicMs) || processMonotonicClock.now() >= authority.validUntilMonotonicMs) return null;
        const resources = { armId, inputTokens: authority.inputTokens, outputTokens: authority.outputTokens };
        const digests = (values: unknown[]) => values.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
        if (proof && (proof.bodySha256 !== attempt.bodySha256 || (proof.kind === 'provider-input-count' ? (
            !digests([proof.sourceSha256, proof.bodySha256, proof.countBodySha256, proof.responseSha256]) ||
            !count(proof.measuredInputTokens) || proof.measuredInputTokens > authority.inputTokens ||
            proof.requestId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(proof.requestId)) : proof.kind === 'provider-intrinsic-limit' ? (
            !intrinsic || !digests([proof.sourceSha256, proof.bodySha256]) ||
            proof.inputTokens !== authority.inputTokens || proof.outputTokens !== authority.outputTokens) :
          proof.kind === 'provider-model-limit' ? (
            attempt.transport !== 'anthropic-http' || attempt.target !== 'https://api.anthropic.com/v1/messages' ||
            attempt.credentialHeader !== 'x-api-key' || attempt.anthropicBeta !== null ||
            proof.anthropicVersion !== '2023-06-01' || attempt.anthropicVersion !== proof.anthropicVersion ||
            proof.model !== body.model || !text(proof.model) ||
            !digests([proof.sourceSha256, proof.bodySha256, proof.responseSha256]) ||
            proof.inputTokens !== authority.inputTokens || !count(proof.outputTokens) ||
            proof.outputTokens === 0 || authority.outputTokens > proof.outputTokens ||
            proof.requestId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(proof.requestId)) : true))) return null;
        // Copy only validated evidence fields. Never serialize a host callback
        // object wholesale: extra properties could carry credential material.
        const inputEvidence = !proof ? undefined : proof.kind === 'provider-input-count'
          ? { kind: proof.kind, sourceSha256: proof.sourceSha256, bodySha256: proof.bodySha256,
            countBodySha256: proof.countBodySha256, responseSha256: proof.responseSha256,
            requestId: proof.requestId, measuredInputTokens: proof.measuredInputTokens }
          : proof.kind === 'provider-model-limit'
          ? { kind: proof.kind, sourceSha256: proof.sourceSha256, bodySha256: proof.bodySha256,
            responseSha256: proof.responseSha256, requestId: proof.requestId, model: proof.model,
            inputTokens: proof.inputTokens, outputTokens: proof.outputTokens, anthropicVersion: proof.anthropicVersion }
          : { kind: proof.kind, sourceSha256: proof.sourceSha256, bodySha256: proof.bodySha256,
            inputTokens: proof.inputTokens, outputTokens: proof.outputTokens };
        const expectedResourceBudget = { ...resourceBudget, armIds: [...resourceBudget.armIds] };
        const cycle: CycleSpendReservationScope | undefined = runId === undefined ? undefined :
          { runId, budgetUsd, resources, expectedResourceBudget };
        const exact: ReserveLearningSpendInput['exact'] = binding === undefined ? undefined :
          { reservationId: attempt.attemptId, binding, expectedBudgetUsd: budgetUsd, resources, expectedResourceBudget };
        const { body: _body, signal: _signal, ...identity } = attempt;
        // The governed helper owns reserve/validate/settle. Its work waits for
        // this exact gateway observer instead of aggregate caller usage.
        return await new Promise<Awaited<ReturnType<GatewayCarryTrialBinding['authorizeAttempt']>>>(resolveReceipt => {
          let finish: ((report: SpendAttemptReport<null>) => void) | undefined;
          const completion = runGovernedSpendAttempt({ workspaceId, loopId, potSlug,
            attemptKind: authority.attemptKind, requestedUsd: authority.requestedUsd,
            ...(exact ? { exact, floorUsd: 0 } : { cycle }),
            note: JSON.stringify({ nativeGatewayAttempt: identity, ...(inputEvidence ? { inputEvidence } : {}) }),
            async run(grant) {
              if (!live || attempt.signal.aborted || grant.clamped || grant.reservedUsd !== authority.requestedUsd) {
                throw Object.assign(new Error('Native Gym gateway grant revoked'), { costUsd: 0 });
              }
              return new Promise<SpendAttemptReport<null>>(resolveReport => {
                let observed = false;
                let checked = false;
                const incomplete = () => { observed = true; resolveReport({ costUsd: 0, value: null, costUsdMeasurementMissing: true }); };
                pending.add(incomplete);
                finish = report => { pending.delete(incomplete); resolveReport(report); };
                resolveReceipt(Object.freeze({ attemptId: attempt.attemptId, reservationRef: grant.reservationId,
                  clockId: attempt.clockId, validUntilMonotonicMs: authority.validUntilMonotonicMs,
                  validateAuthorization() {
                    if (!live || observed || checked || attempt.signal.aborted ||
                      processMonotonicClock.now() >= authority.validUntilMonotonicMs) throw invalid();
                    checked = true;
                    const result: unknown = authority.validateAuthorization();
                    if (result !== undefined) {
                      void Promise.resolve(result).catch(() => {});
                      throw invalid();
                    }
                    if (!live || attempt.signal.aborted || processMonotonicClock.now() >= authority.validUntilMonotonicMs) throw invalid();
                  },
                  async observeAttemptResult(result: GatewayCarryTrialAttemptResult) {
                    if (observed || result.reservationRef !== grant.reservationId ||
                      Object.entries(identity).some(([key, expected]) => result[key as keyof GatewayCarryTrialAttemptResult] !== expected)) {
                      pending.delete(incomplete); incomplete(); await completion; throw invalid();
                    }
                    observed = true;
                    try {
                      const sql = deps?.getSql ? await deps.getSql() : (await import('@papercusp/db-org')).getOrgPg().sql;
                      const saved = await (deps?.recordAttemptResult ?? recordLearningSpendAttemptResult)(sql,
                        { workspaceId, reservationId: grant.reservationId, result });
                      if (!saved.ok) throw invalid();
                    } catch { pending.delete(incomplete); incomplete(); await completion; throw invalid(); }
                    const zero = result.outcome === 'send-refused' && result.responseStatus === null &&
                      result.costUsd === 0 && result.costUsdMeasurementMissing === false;
                    finish!({ costUsd: 0, value: null, ...(zero ? { cancelled: true } : { costUsdMeasurementMissing: true }) });
                    await completion;
                  },
                  async observeAttemptCompletion(result: GatewayCarryTrialAttemptResult) {
                    if (!observed || result.reservationRef !== grant.reservationId ||
                        !['response-completed', 'response-incomplete'].includes(result.outcome) ||
                        Object.entries(identity).some(([key, expected]) => result[key as keyof GatewayCarryTrialAttemptResult] !== expected)) throw invalid();
                    const sql = deps?.getSql ? await deps.getSql() : (await import('@papercusp/db-org')).getOrgPg().sql;
                    const saved = await (deps?.recordAttemptResult ?? recordLearningSpendAttemptResult)(sql,
                      { workspaceId, reservationId: grant.reservationId, result });
                    if (!saved.ok) throw invalid();
                  } }));
              });
            } }, deps);
          // A refusal or invalid store receipt never exposes send authority.
          // Errors before dispatch are sanitized and never guessed as usage.
          void completion.then(() => resolveReceipt(null), () => resolveReceipt(null));
        });
      } catch { return null; }
    } } });
  return { gateway, revoke() { live = false; for (const close of pending) close(); pending.clear(); } };
}

/** Capture before cycle setup. Both protocols are required because the frozen
 * judge is Anthropic and the configured proposer may use Codex. */
export function snapshotNativeGymGatewayConfig(value: NativeGymGatewayConfig): NativeGymGatewayConfig {
  const invalid = () => Object.assign(new Error('Native Gym requires its configured gateway authority'), { costUsd: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const token = value.token, binding = value.carryTrial;
  if (typeof token !== 'string' || token.trim() !== token || token.length < 32 ||
    !binding || typeof binding !== 'object' || Array.isArray(binding)) throw invalid();
  const { manifestSha256, armId, requestTokenSha256, outputTokenLimit, authorizeAttempt } = binding;
  const protocols = binding.protocols;
  if (!/^[a-f0-9]{64}$/.test(manifestSha256) || typeof armId !== 'string' || !armId.trim() ||
    requestTokenSha256 !== createHash('sha256').update(token).digest('hex') ||
    outputTokenLimit !== undefined && (!Number.isSafeInteger(outputTokenLimit) || outputTokenLimit <= 0) ||
    typeof authorizeAttempt !== 'function' || !Array.isArray(protocols) || protocols.length !== 2 ||
    !protocols.includes('anthropic-messages') || !protocols.includes('openai-responses')) throw invalid();
  const carryTrial: GatewayCarryTrialBinding = Object.freeze({ manifestSha256, armId, requestTokenSha256,
    ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
    protocols: Object.freeze([...protocols]),
    async authorizeAttempt(attempt: GatewayCarryTrialAttempt) {
      if (attempt.manifestSha256 !== manifestSha256 || attempt.armId !== armId || attempt.signal.aborted) return null;
      const receipt = await authorizeAttempt(attempt);
      // Native authority must be rechecked at the actual selected-provider send,
      // not merely at the earlier asynchronous issuer boundary.
      return receipt && typeof receipt.validateAuthorization === 'function'
        ? Object.freeze({ ...receipt }) : null;
    },
  });
  return Object.freeze({ token, carryTrial });
}

/** Reuse the maintained service/account pool for the cycle's scoped caller
 * token. The local guard binds the exact private route; the carryTrial hook
 * authenticates and admits the FINAL selected-provider request separately. */
export async function startNativeGymGateway(
  config: NativeGymGatewayConfig,
  workspaceId: string,
  log: (message: string) => void,
  start: (options: GatewayServiceOptions) => Promise<RunningGatewayService> = async options =>
    (await import('../inference-gateway/launch')).startGatewayService(options),
): Promise<{ transport: NativeGymTransport; stop: () => Promise<void> }> {
  const frozen = snapshotNativeGymGatewayConfig(config);
  let live = true;
  const service = await start({ port: 0, workspace: workspaceId,
    carryTrial: { ...frozen.carryTrial, async authorizeAttempt(attempt) {
      if (!live) return null;
      const receipt = await frozen.carryTrial.authorizeAttempt(attempt);
      if (!live || !receipt) return null;
      return { ...receipt, validateAuthorization() {
        if (!live) throw new Error('Native Gym gateway authority revoked');
        const validation: unknown = receipt.validateAuthorization!();
        if (validation !== undefined) {
          void Promise.resolve(validation).catch(() => {});
          throw new Error('Native Gym gateway authority requires a synchronous check');
        }
        if (!live) throw new Error('Native Gym gateway authority revoked');
      } };
    } }, log: (level, message) => log(`native gateway ${level}: ${message}`) });
  if (!Number.isSafeInteger(service.port) || service.port <= 0 || service.port > 65535) {
    live = false;
    await service.stop();
    throw Object.assign(new Error('Native Gym gateway did not bind a private port'), { costUsd: 0 });
  }
  const baseURL = `http://127.0.0.1:${service.port}`;
  const credentialSha256 = createHash('sha256').update(JSON.stringify({
    authorization: `Bearer ${frozen.token}`, apiKey: null,
  })).digest('hex');
  let stopping: Promise<void> | undefined;
  return {
    transport: { statelessGateway: { baseURL, token: frozen.token },
      async authorizeStatelessRequest(attempt) {
        const request = { ...attempt };
        const valid = () => live && !request.signal.aborted && request.method === 'POST' &&
          (request.url === `${baseURL}/v1/messages` || request.url === `${baseURL}/v1/responses`) &&
          request.credentialSha256 === credentialSha256 &&
          request.bodySha256 === createHash('sha256').update(request.body).digest('hex');
        if (!valid()) return null;
        return () => { if (!valid()) throw new Error('Native Gym gateway request refused'); };
      } },
    stop() {
      live = false;
      return stopping ??= Promise.resolve().then(() => service.stop());
    },
  };
}

/** Shared native admission guard, used before cycle setup and before transport. */
export function requireNativeGymOutputLimit(value: unknown, consumer: 'judge' | 'proposer'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new RangeError(`Native Gym ${consumer} requires its configured output token limit`), { costUsd: 0 });
  }
  return value;
}

/** The real cycle's transport binding. A frozen judge limit must be enforced
 * by the selected provider route, including SDK retries. This does not issue
 * a monetary grant; both consumers still need their admitted resource policy. */
export function bindNativeGymLlmCalls(
  call: (opts: NativeGymLlmRequest) => ReturnType<JudgeLlmCall>,
  harnessSlug: string,
  deps: { log: (message: string) => void; sleep?: (ms: number) => Promise<void>; transport?: NativeGymTransport },
): { judge: JudgeLlmCall; proposer: GymLlmCall } {
  const transport = deps.transport ? { ...deps.transport,
    ...(deps.transport.statelessGateway ? { statelessGateway: Object.freeze({ ...deps.transport.statelessGateway }) } : {}),
  } : {};
  const dispatch = withGymLlmNetworkRetry((opts: NativeGymLlmRequest) =>
    call({ ...opts, ...transport, priority: 'gym', harnessSlug }), deps);
  const snapshot = (opts: NativeGymLlmRequest): NativeGymLlmRequest => ({
    ...opts, messages: opts.messages.map(message => ({ ...message })),
  });
  return {
    async judge(opts) {
      const request = snapshot(opts);
      requireNativeGymOutputLimit(request.maxTokens, 'judge');
      return dispatch({ ...request, requireOutputTokenLimit: true });
    },
    async proposer(opts) {
      const request = snapshot(opts);
      requireNativeGymOutputLimit(request.maxTokens, 'proposer');
      return dispatch({ ...request, requireOutputTokenLimit: true });
    },
  };
}

/** Read a provider-reported cost from a successful value or a thrown error. */
export function costUsdOf(value: unknown): number {
  const candidate =
    typeof value === 'number'
      ? value
      : (value as { costUsd?: unknown } | null | undefined)?.costUsd;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

/** Preserve the known subtotal separately from whether this call's usage is complete.
 * Validation failures may supply the completed response as their usage evidence. */
export function throwWithCostUsd(error: unknown, incurredCostUsd: number, usageEvidence: unknown = error): never {
  const usage = usageEvidence as { costUsd?: unknown; costUsdMeasurementMissing?: unknown; unreportedFrames?: unknown } | null;
  const measured = typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0;
  const unreportedFrames = typeof usage?.unreportedFrames === 'number' && usage.unreportedFrames > 0
    ? usage.unreportedFrames : undefined;
  const missing = !measured || usage?.costUsdMeasurementMissing === true || unreportedFrames !== undefined;
  const costUsd = costUsdOf(error) + costUsdOf(incurredCostUsd);
  const failure = error instanceof Error ? error : new Error(String(error));
  Object.assign(failure, { costUsd, ...(missing ? { costUsdMeasurementMissing: true } : {}),
    ...(unreportedFrames === undefined ? {} : { unreportedFrames }) });
  throw failure;
}

export function buildProposerPrompt(input: ProposeInput): { system: string; user: string } {
  const system = [
    'You optimize a multi-agent coding harness by improving its ROLE PROMPTS. You are given',
    'the harness’s worst-scoring runs with an independent judge’s RATIONALES, plus a changelog',
    'of past prompt changes. Diagnose the recurring failure mode and propose a TARGETED prompt',
    'change to ONE or a FEW roles that would most raise the judge’s scores. Change prompts only',
    '— do not propose model swaps or orchestration changes.',
    '',
    'Output ONLY a single JSON object (no prose, no fences):',
    '{"promptOverrides": {"<role>": "<full replacement prompt markdown>"}, "rationale": "<why this change targets the failures>"}',
  ].join('\n');

  const user = [
    '## Running changelog',
    input.changelog || '(none yet)',
    // P-030: live post-acceptance measurement of past accepted changes. Zero
    // finalized champions ⇒ no section (the prompt stays byte-identical).
    ...(input.championOutcomes?.length
      ? [
          '',
          '## Recent champion outcomes (live post-acceptance measurement)',
          'Live-run outcomes measured AFTER each recently accepted prompt change, vs the same window',
          'before it. Build on changes that improved live outcomes; avoid repeating ones that regressed.',
          ...input.championOutcomes,
        ]
      : []),
    '',
    '## Worst-scoring runs (judge rationales)',
    ...input.worstTraces.map(
      (t) =>
        `- task ${t.taskId} (composite ${t.composite.toFixed(2)}): ${t.rationale}` +
        (t.distilledTrace ? `\n  trace: ${t.distilledTrace}` : ''),
    ),
    // P-032: triage-routed improvement ideas as OPTIONAL candidate directions. Zero
    // routed ideas ⇒ no section at all (the prompt stays byte-identical to before).
    ...(input.candidateDirections?.length
      ? [
          '',
          '## Candidate directions (operator improvement ideas triaged to the gym)',
          'Optional directions from the operator’s improvement backlog. Adopt one ONLY when it',
          'plausibly targets the failure modes evidenced above; otherwise ignore them.',
          ...input.candidateDirections.map((d) => `- ${d}`),
        ]
      : []),
    '',
    '## Current role overrides (parent variant)',
    JSON.stringify(input.parentOverlay.promptOverrides, null, 2),
  ].join('\n');

  return { system, user };
}

export function parseProposal(raw: unknown): ParsedProposal {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`proposal must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const po = o.promptOverrides;
  if (typeof po !== 'object' || po === null) {
    throw new Error('proposal is missing a "promptOverrides" object');
  }
  if (typeof o.rationale !== 'string' || !o.rationale.trim()) {
    throw new Error('proposal is missing a non-empty "rationale"');
  }
  const promptOverrides = po as Record<string, string>;
  // Validate the roles (rejects unknown roles incl. the frozen judge) — reuse the overlay validator.
  planVariantOverlay({ promptOverrides });
  return { promptOverrides, rationale: o.rationale };
}

export async function proposeCandidate(
  input: ProposeInput,
  deps: { llmCall: GymLlmCall },
): Promise<CandidateProposal> {
  const maxTokens = input.maxTokens;
  if (maxTokens !== undefined) requireNativeGymOutputLimit(maxTokens, 'proposer');
  const { system, user } = buildProposerPrompt(input);
  let res: Awaited<ReturnType<GymLlmCall>>;
  try {
    res = await deps.llmCall({
      model: input.proposerModel,
      system,
      messages: [{ role: 'user', content: user }],
      responseFormat: 'json',
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  } catch (error) {
    // A provider can attach costUsd even when the request ultimately throws.
    // Keep that property intact for the loop's spend ledger.
    throwWithCostUsd(error, 0);
  }

  try {
    const proposal = parseProposal(res.json ?? tryParseJson(res.text));

    // Candidate overlay = parent overrides ⊕ proposed changes (prompts-only).
    const merged: Record<string, string> = { ...input.parentOverlay.promptOverrides, ...proposal.promptOverrides };
    const overlay: VariantOverlay = { promptOverrides: merged };
    // Validate the merged overlay too.
    planVariantOverlay(overlay);

    const diffFromParent = Object.keys(proposal.promptOverrides).sort().join(', ');
    const measured = typeof res.costUsd === 'number' && Number.isFinite(res.costUsd) && res.costUsd >= 0;
    const missing = !measured || res.costUsdMeasurementMissing === true || (res.unreportedFrames ?? 0) > 0;
    return { overlay, rationale: proposal.rationale, diffFromParent, costUsd: costUsdOf(res.costUsd),
      ...(missing ? { costUsdMeasurementMissing: true } : {}),
      ...(res.unreportedFrames === undefined ? {} : { unreportedFrames: res.unreportedFrames }) };
  } catch (error) {
    // The model response may have been billed even when parsing/validation rejects it.
    throwWithCostUsd(error, res.costUsd, res);
  }
}
