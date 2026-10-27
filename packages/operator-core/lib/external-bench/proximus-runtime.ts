/** D-059/D-060: bind the official host loop to the existing task/grade contract.
 * This specification grants no process, credential, request or spend authority.
 */
import { requireCurrentBenchmarkAssignment, currentProtocolPriceTable, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { priceRun } from '@papercusp/bench-metrics';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { execFile, spawn, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { CurrentBenchAccountingBinding, CurrentBenchHostReferenceGateway } from './current-su';
import type { LearningSpendReservationCensus } from '../learning-governor/store';
import type { GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import { createHash, randomUUID } from 'node:crypto';
import { isModelRequestId } from '../observability/tracing';
import type { Sql } from 'postgres';
import { StringDecoder } from 'node:string_decoder';
import { prepareProximusSandbox, createProximusTaskBroker, type ProximusTaskBinding } from './proximus-confinement';

export function proximusRunSpec(config: unknown, execution: Parameters<typeof requireCurrentBenchmarkAssignment>[1] & {
  handle: Pick<FrontierSweEnvHandle, 'containerId' | 'image' | 'instanceId'>;
  /** Host-measured installed dependency digest; never obtained from agent output. */
  runtimeRevision: string;
  /** Hard process deadline, including finalization. */
  maxWallClockMs: number;
  outputTokenLimit: number;
}) {
  const protocol = requireCurrentBenchmarkAssignment(config, execution);
  const arm = protocol.arms.find(arm => arm.id === execution.armId)!;
  const runtime = arm.runtime.proximus;
  if (arm.agent !== 'proximus' || !runtime || execution.runtimeRevision !== arm.runtime.runtimeRevision ||
      !execution.handle.containerId.trim() || execution.handle.instanceId !== execution.taskId ||
      execution.handle.image !== protocol.grader.images?.[execution.taskId]) {
    throw new Error('Proximus requires its exact installed runtime and immutable FrontierSWE task image.');
  }
  const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
  if (!Number.isSafeInteger(execution.maxWallClockMs) || execution.maxWallClockMs <= 0 ||
      execution.maxWallClockMs > arm.generationBudget.maxWallClockMs ||
      !Number.isSafeInteger(execution.outputTokenLimit) || execution.outputTokenLimit <= 0 ||
      execution.outputTokenLimit > rate.outputTokenCeiling! ||
      arm.generationBudget.maxTokens !== undefined && execution.outputTokenLimit > arm.generationBudget.maxTokens) {
    throw new Error('Proximus hard time/output allowance is invalid or wider than its frozen caps.');
  }
  // The host process deadline remains exact. Upstream hard_timeout_sec adds
  // finalization headroom; it must never replace/widen this hard allowance.
  return Object.freeze({
    agent: 'harbor_proximus:Proximus' as const,
    sourceRevision: arm.runtime.sourceRevision, runtimeRevision: arm.runtime.runtimeRevision,
    clientVersion: arm.runtime.clientVersion, harborVersion: runtime.harborVersion,
    containerId: execution.handle.containerId, taskId: execution.taskId, image: execution.handle.image,
    model: arm.model, modelName: `${runtime.provider}/${arm.model}`, provider: runtime.provider,
    maxWallClockMs: execution.maxWallClockMs, maxUsd: arm.generationBudget.maxUsd,
    options: Object.freeze({
      time_budget_sec: execution.maxWallClockMs / 1000, reasoning_effort: arm.effort,
      model_info: Object.freeze({ max_input_tokens: runtime.maxInputTokens, supports_vision: runtime.supportsVision,
        ...(runtime.provider === 'openai' ? { mode: 'responses' } : {}) }),
      llm_call_kwargs: Object.freeze({ max_tokens: execution.outputTokenLimit }),
    }),
  });
}

export type ProximusRunSpec = ReturnType<typeof proximusRunSpec>;

export interface ProximusRuntimeReceipt {
  schemaVersion: 1; runtimeRevision: string; sourceRevision: string;
  clientVersion: string; harborVersion: string; fileCount: number;
}

type ProximusTerminalAttempt = {
  attemptId: string; gatewayRequestId: string; accountId: string;
  transport: 'bearer-http' | 'anthropic-http'; bodySha256: string;
  outcome: 'send-refused' | 'fetch-failed' | 'response-completed' | 'response-incomplete';
  responseStatus: number | null;
  responseSha256?: string; responseBytes?: number;
  providerCompletion?: Extract<GatewayCarryTrialAttemptResult, { outcome: 'response-completed' }>['providerCompletion'];
};
export type ProximusAttemptPopulation = {
  status: 'terminal'; source: 'learning-spend-reservations'; populationSha256: string;
  attempts: ProximusTerminalAttempt[];
  requests: { gatewayRequestId: string; attemptIds: string[] }[];
  /** Exact model-call census plus known token subtotals across provider attempts.
   * tokensIn excludes cache reads/writes, as required by AgentRunUsage. Unknown
   * sends/cache splits keep usageComplete false; they are never measured zeros. */
  knownUsage: { modelCalls: number; tokensIn: number; tokensOut: number;
    tokensCacheRead: number; tokensCacheWrite: number };
  usageComplete: boolean; billingStatus: 'unreconciled';
} | { status: 'unavailable'; reason: 'ledger-unavailable' | 'ledger-changed' | 'invalid-ledger' | 'no-attempts' };

/** Reuse the full reservation census; one gateway request may have several
 * provider attempts. Terminal includes failed/partial sends with UNKNOWN usage.
 * This proves ledger coverage only: neither process terminality, confinement,
 * nor actual billing follows from these two stable reads. The host launcher
 * must establish those properties separately before accepting a benchmark. */
export async function readProximusAttemptPopulation(binding: CurrentBenchAccountingBinding,
  readCensus: () => Promise<LearningSpendReservationCensus | undefined>): Promise<ProximusAttemptPopulation> {
  let before: LearningSpendReservationCensus | undefined, after: LearningSpendReservationCensus | undefined;
  try {
    // Detach both snapshots before another await: adapters may reuse objects.
    before = structuredClone(await readCensus());
    after = structuredClone(await readCensus());
  } catch { return { status: 'unavailable', reason: 'ledger-unavailable' }; }
  if (before?.status !== 'complete' || after?.status !== 'complete')
    return { status: 'unavailable', reason: 'ledger-unavailable' };
  if (before.populationSha256 !== after.populationSha256 || JSON.stringify(before.reservations) !== JSON.stringify(after.reservations))
    return { status: 'unavailable', reason: 'ledger-changed' };
  const invalid = (): ProximusAttemptPopulation => ({ status: 'unavailable', reason: 'invalid-ledger' });
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
  const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  try {
    if (!text(binding.workspaceId) || !text(binding.loopId) || !text(binding.runId) || !sha(binding.preregHash) ||
        !binding.assignmentId.startsWith('bench-assignment:') ||
        before.source !== 'learning-spend-reservations' || after.source !== before.source ||
        before.populationSha256 !== createHash('sha256').update(JSON.stringify({ version: 1,
          workspaceId: binding.workspaceId, loopId: binding.loopId, sinceMs: null, reservations: before.reservations })).digest('hex')) return invalid();
    const ids = new Set<string>(), responseIds = new Set<string>(), foreignRequests = new Set<string>();
    const requests = new Map<string, string[]>(), attempts: ProximusTerminalAttempt[] = [];
    const knownUsage = { modelCalls: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
    let usageComplete = true;
    for (const row of before.reservations) {
      if (!text(row.id) || ids.has(row.id) || row.workspaceId !== binding.workspaceId || row.loopId !== binding.loopId ||
          row.attemptKind !== 'evaluation' || row.runRef !== `manifest:${binding.preregHash}/attempt:${row.id}`) return invalid();
      ids.add(row.id);
      const note = JSON.parse(row.note ?? 'null'), attempt = note?.nativeGatewayAttempt;
      if (!attempt || attempt.attemptId !== row.id || attempt.manifestSha256 !== binding.preregHash ||
          !text(attempt.armId) || attempt.armId !== row.resources?.armId || !isModelRequestId(attempt.gatewayRequestId)) return invalid();
      if (attempt.armId !== binding.assignmentId) { foreignRequests.add(attempt.gatewayRequestId); continue; }
      const result = note.nativeGatewayAttemptResult as GatewayCarryTrialAttemptResult | undefined;
      const identityKeys = ['attemptId', 'gatewayRequestId', 'manifestSha256', 'armId', 'transport', 'accountId',
        'credentialHeader', 'credentialSha256', 'target', 'bodySha256', 'clockId'] as const;
      if (!result || result.reservationRef !== row.id || identityKeys.some(key => result[key] !== attempt[key]) ||
          ![attempt.accountId, attempt.clockId].every(text) || ![attempt.bodySha256, attempt.credentialSha256].every(sha) ||
          attempt.nativeSessionId !== undefined || attempt.nativeTurnId !== undefined ||
          result.nativeSessionId !== undefined || result.nativeTurnId !== undefined ||
          !['open', 'settled', 'cancelled'].includes(row.status) ||
          ![row.requestedUsd, row.reservedUsd, row.usedUsd].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
          (attempt.transport === 'bearer-http' ? attempt.target !== 'https://api.openai.com/v1/responses' || attempt.credentialHeader !== 'authorization'
            : attempt.transport !== 'anthropic-http' || attempt.target !== 'https://api.anthropic.com/v1/messages' || attempt.credentialHeader !== 'x-api-key')) return invalid();
      const entry: ProximusTerminalAttempt = { attemptId: row.id, gatewayRequestId: attempt.gatewayRequestId,
        accountId: attempt.accountId, transport: attempt.transport, bodySha256: attempt.bodySha256,
        outcome: result.outcome as ProximusTerminalAttempt['outcome'], responseStatus: result.responseStatus };
      if (result.outcome === 'send-refused') {
        if (result.responseStatus !== null || result.costUsd !== 0 || result.costUsdMeasurementMissing !== false ||
            row.status !== 'cancelled' || row.usedUsd !== 0) return invalid();
      } else {
        if (result.costUsdMeasurementMissing !== true) return invalid();
        if (result.outcome === 'fetch-failed') {
          if (result.responseStatus !== null) return invalid();
          usageComplete = false;
        } else if (result.outcome === 'response-completed' || result.outcome === 'response-incomplete') {
          if (!count(result.responseStatus) || result.responseStatus < 100 || result.responseStatus > 599 ||
              !sha(result.responseSha256) || !count(result.responseBytes)) return invalid();
          entry.responseSha256 = result.responseSha256; entry.responseBytes = result.responseBytes;
          if (result.outcome === 'response-completed') {
            const p = result.providerCompletion, u = p?.usage;
            if (result.responseStatus < 200 || result.responseStatus >= 300 || result.responseBytes === 0 ||
                !text(p?.responseId) || responseIds.has(p.responseId) || !text(p.model) ||
                p.providerEffort !== null && !text(p.providerEffort) || !u || u.inputTokenBasis !== 'inclusive' ||
                !count(u.inputTokens) || !count(u.outputTokens) ||
                u.cacheReadTokens !== null && !count(u.cacheReadTokens) || u.cacheCreationTokens !== null && !count(u.cacheCreationTokens) ||
                (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0) > u.inputTokens) return invalid();
            responseIds.add(p.responseId);
            // Whitelist nested evidence too; caller quotes/output never escape.
            entry.providerCompletion = { responseId: p.responseId, model: p.model, providerEffort: p.providerEffort,
              usage: { inputTokenBasis: u.inputTokenBasis, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
                cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens } };
            knownUsage.tokensOut += u.outputTokens;
            knownUsage.tokensCacheRead += u.cacheReadTokens ?? 0;
            knownUsage.tokensCacheWrite += u.cacheCreationTokens ?? 0;
            if (u.cacheReadTokens !== null && u.cacheCreationTokens !== null)
              knownUsage.tokensIn += u.inputTokens - u.cacheReadTokens - u.cacheCreationTokens;
            if (u.cacheReadTokens === null || u.cacheCreationTokens === null) usageComplete = false;
          } else usageComplete = false;
        } else return invalid();
      }
      requests.set(entry.gatewayRequestId, [...(requests.get(entry.gatewayRequestId) ?? []), row.id]);
      attempts.push(entry);
    }
    if ([...requests.keys()].some(id => foreignRequests.has(id))) return invalid();
    knownUsage.modelCalls = requests.size;
    if (!Object.values(knownUsage).every(count)) return invalid();
    return attempts.length ? { status: 'terminal', source: before.source, populationSha256: before.populationSha256,
      attempts, requests: [...requests].map(([gatewayRequestId, attemptIds]) => ({ gatewayRequestId, attemptIds })),
      knownUsage, usageComplete, billingStatus: 'unreconciled' } : { status: 'unavailable', reason: 'no-attempts' };
  } catch { return invalid(); }
}
export type ProximusBilling = {
  status: 'complete' | 'incomplete'; knownSubtotalMicros: string; billedInferenceMicros: string | null;
  missingAttemptIds: string[]; populationSha256: string;
  samples: { attemptId: string; sampleId: string; billedInferenceMicros: string }[];
} | { status: 'unavailable'; reason: 'ledger-unavailable' | 'ledger-changed' | 'invalid-ledger' | 'no-attempts' |
  'billing-unavailable' | 'invalid-billing' };

export type ProximusPricing = {
  status: 'complete' | 'incomplete'; populationSha256: string; priceTableVersion: string;
  knownSubtotalUsd: number; normalizedCostUsd: number | null; missingAttemptIds: string[];
  attempts: { attemptId: string; model: string | null; knownSubtotalUsd: number; complete: boolean }[];
} | { status: 'unavailable'; reason: string };

/** Price every provider attempt, including retries, using the assignment's
 * frozen schedule. Actual bills and agent-reported cost never supply a rate.
 * Missing usage retains only the categories the authenticated response measured. */
export function priceProximusAttempts(protocol: CurrentBenchmarkProtocol,
  population: ProximusAttemptPopulation): ProximusPricing {
  if (population.status !== 'terminal') return { status: 'unavailable', reason: population.reason };
  const attempts: Extract<ProximusPricing, { status: 'complete' | 'incomplete' }>['attempts'] = [];
  const missingAttemptIds: string[] = [];
  let knownSubtotalUsd = 0;
  for (const attempt of population.attempts) {
    const p = attempt.providerCompletion, u = p?.usage;
    let subtotal = 0, complete = attempt.outcome === 'send-refused';
    if (attempt.outcome === 'response-completed' && p && u) {
      try {
        const table = currentProtocolPriceTable(protocol, [{ modelId: p.model, tokensCacheWrite: u.cacheCreationTokens }]);
        const splitKnown = u.cacheReadTokens !== null && u.cacheCreationTokens !== null;
        subtotal = priceRun({ tokensIn: splitKnown ? u.inputTokens - u.cacheReadTokens! - u.cacheCreationTokens! : 0,
          tokensOut: u.outputTokens, tokensCacheRead: u.cacheReadTokens ?? 0,
          tokensCacheWrite: u.cacheCreationTokens ?? 0 }, p.model, table);
        if (!Number.isFinite(subtotal) || subtotal < 0) throw new Error('Invalid normalized request cost.');
        complete = splitKnown;
      } catch { subtotal = 0; complete = false; }
    }
    if (!complete) missingAttemptIds.push(attempt.attemptId);
    knownSubtotalUsd += subtotal;
    attempts.push({ attemptId: attempt.attemptId, model: p?.model ?? null, knownSubtotalUsd: subtotal, complete });
  }
  if (!Number.isFinite(knownSubtotalUsd)) return { status: 'unavailable', reason: 'invalid-normalized-total' };
  const complete = population.usageComplete && attempts.length > 0 && !missingAttemptIds.length;
  return { status: complete ? 'complete' : 'incomplete', populationSha256: population.populationSha256,
    priceTableVersion: protocol.priceSchedule.version, knownSubtotalUsd,
    normalizedCostUsd: complete ? knownSubtotalUsd : null, missingAttemptIds, attempts };
}

/** Official Proximus writes completed agent steps to AgentContext.metadata.
 * Request counts, diagnostic tokens and context.cost_usd are different measures. */
export function readProximusTurns(context: unknown): number | null {
  const turns = (context as { metadata?: { n_turns?: unknown } } | null)?.metadata?.n_turns;
  return typeof turns === 'number' && Number.isSafeInteger(turns) && turns >= 0 ? turns : null;
}

/** Exact request billing uses the existing canonical usage table, independently
 * of reservation amounts and agent-reported context costs. This grants no send
 * authority, proves no confinement, and does not settle spend reservations. */
export async function readProximusBilling(sql: Sql, input: CurrentBenchAccountingBinding,
  readCensus: () => Promise<LearningSpendReservationCensus | undefined>): Promise<ProximusBilling> {
  const binding = { ...input };
  const population = await readProximusAttemptPopulation(binding, readCensus);
  if (population.status !== 'terminal') return population;
  type BillRow = {
    sample_id: string; gateway_request_id: string; gateway_attempt_id: string; provider_response_id: string;
    manifest_sha256: string; assignment_id: string; run_id: string; account_id: string; provider: string; model: string;
    cost_source: string | null; cost_bound: string | null; price_table_version: string | null;
    cost_micros: string | null; response_id_source: string | null; grain: string | null;
  };
  let rows: BillRow[];
  try {
    rows = structuredClone(await sql<BillRow[]>`
      SELECT id::text AS sample_id,
             usage_provenance->>'gatewayRequestId' AS gateway_request_id,
             usage_provenance->>'gatewayAttemptId' AS gateway_attempt_id,
             usage_provenance->>'providerResponseId' AS provider_response_id,
             usage_provenance->>'manifestSha256' AS manifest_sha256,
             usage_provenance->>'assignmentId' AS assignment_id,
             usage_provenance->>'providerResponseIdSource' AS response_id_source,
             usage_provenance->>'grain' AS grain,
             run_id, account_id, provider, model, cost_source, price_table_version,
             usage_provenance->>'costBound' AS cost_bound,
             (cost_usd::numeric * 1000000)::text AS cost_micros
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${binding.workspaceId}
         AND usage_provenance->>'gatewayRequestId' = ANY(${population.requests.map(r => r.gatewayRequestId)}::text[])
       ORDER BY id`);
  } catch { return { status: 'unavailable', reason: 'billing-unavailable' }; }
  const after = await readProximusAttemptPopulation(binding, readCensus);
  if (after.status !== 'terminal') return after;
  if (after.populationSha256 !== population.populationSha256) return { status: 'unavailable', reason: 'ledger-changed' };
  const invalid = (): ProximusBilling => ({ status: 'unavailable', reason: 'invalid-billing' });
  const attempts = new Map(population.attempts.map(a => [a.attemptId, a]));
  const seenSamples = new Set<string>(), bills = new Map<string, { sampleId: string; micros: bigint }>();
  try {
    for (const row of rows) {
      const attempt = attempts.get(row.gateway_attempt_id), completion = attempt?.providerCompletion;
      if (!attempt || attempt.outcome !== 'response-completed' || !completion ||
          !row.sample_id?.trim() || seenSamples.has(row.sample_id) || bills.has(attempt.attemptId) ||
          row.gateway_request_id !== attempt.gatewayRequestId || row.account_id !== attempt.accountId ||
          row.provider_response_id !== completion.responseId || row.model !== completion.model ||
          row.provider !== (attempt.transport === 'bearer-http' ? 'openai' : 'anthropic') ||
          row.manifest_sha256 !== binding.preregHash || row.assignment_id !== binding.assignmentId || row.run_id !== binding.runId ||
          row.grain !== 'request' || row.response_id_source !== 'authenticated-gateway-provider-response' ||
          row.cost_source !== 'provider' || row.cost_bound !== null || row.price_table_version !== null) return invalid();
      const money = typeof row.cost_micros === 'string' ? /^(\d+)(?:\.0+)?$/.exec(row.cost_micros) : null;
      if (!money) return invalid();
      seenSamples.add(row.sample_id);
      bills.set(attempt.attemptId, { sampleId: row.sample_id, micros: BigInt(money[1]!) });
    }
    let subtotal = 0n;
    const missingAttemptIds: string[] = [], samples: Extract<ProximusBilling, { knownSubtotalMicros: string }>['samples'] = [];
    for (const attempt of population.attempts) {
      if (attempt.outcome === 'send-refused') continue;
      const bill = bills.get(attempt.attemptId);
      if (!bill) { missingAttemptIds.push(attempt.attemptId); continue; }
      subtotal += bill.micros;
      samples.push({ attemptId: attempt.attemptId, sampleId: bill.sampleId, billedInferenceMicros: bill.micros.toString() });
    }
    return { status: missingAttemptIds.length ? 'incomplete' : 'complete', knownSubtotalMicros: subtotal.toString(),
      billedInferenceMicros: missingAttemptIds.length ? null : subtotal.toString(), missingAttemptIds, samples,
      populationSha256: population.populationSha256 };
  } catch { return invalid(); }
}
interface ProximusHostProcessInput {
  pythonBin: string; operation: 'measure' | 'run'; maxWallClockMs: number;
  stdin?: string; signal?: AbortSignal;
  confinement?: { trialDir: string; gatewayBaseURL: string; task: ProximusTaskBinding };
}

/** Evidence issued by the parent after successful worker/broker reaping and
 * sandbox cleanup. Serialized fields describe the observation; possession of
 * copied JSON is never authority to accept it. No gateway token is retained. */
export interface ProximusHostConfinementReceipt {
  schemaVersion: 1; source: 'confined-host-process'; executionId: string;
  pythonBin: string; maxWallClockMs: number; payloadSha256: string; workerResultSha256: string;
  trialDir: string; gatewayBaseURL: string; task: Readonly<ProximusTaskBinding>;
}
const processReceipts = new WeakMap<object, ProximusHostConfinementReceipt>();
const hostRunReceipts = new WeakMap<object, { receipt: ProximusHostConfinementReceipt; resultSha256: string }>();
const evidenceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function processBinding(input: ProximusHostProcessInput) {
  return { pythonBin: input.pythonBin, maxWallClockMs: input.maxWallClockMs,
    payloadSha256: createHash('sha256').update(input.stdin ?? '{}').digest('hex'), ...input.confinement! };
}

/** Verify the exact completed run object before serializing it for storage.
 * A durable JSON copy remains evidence, not a new acceptance capability. */
export function requireProximusHostConfinement(result: unknown): ProximusHostConfinementReceipt {
  const issued = result && typeof result === 'object' ? hostRunReceipts.get(result) : undefined;
  if (!issued || issued.resultSha256 !== evidenceHash(result))
    throw new Error('Proximus requires its unchanged host-issued confinement receipt.');
  return issued.receipt;
}

/** Host process, with no inherited API credentials/proxies or shell. The
 * process-group kill bounds even an upstream finalizer ignoring cancellation. */
export async function proximusHostProcess(input: ProximusHostProcessInput): Promise<unknown> {
  // Freeze the authority used across asynchronous broker preparation. In
  // particular a caller cannot redirect the recorded task after it starts.
  input = { ...input, ...(input.confinement ? { confinement: structuredClone(input.confinement) } : {}) };
  if (!isAbsolute(input.pythonBin) || !Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs <= 0 ||
      input.stdin !== undefined && Buffer.byteLength(input.stdin) > 1024 * 1024)
    return Promise.reject(new Error('Invalid Proximus host process/deadline/payload.'));
  if (input.signal?.aborted) return Promise.reject(new Error('Proximus host process was aborted.'));
  if (input.operation === 'run' && !input.confinement) throw new Error('Proximus run requires a confined task binding.');
  const sandbox = prepareProximusSandbox({ pythonBin: input.pythonBin, ...input.confinement });
  let broker: Awaited<ReturnType<typeof createProximusTaskBroker>> | undefined;
  let completed: unknown;
  try {
    if (input.confinement) broker = await createProximusTaskBroker(input.confinement.task, input.maxWallClockMs);
    if (input.signal?.aborted) throw new Error('Proximus host process was aborted during preparation.');
    const wrapped = sandbox.wrap(['-I', '-B', fileURLToPath(new URL('./proximus-host.py', import.meta.url)), input.operation]);
    completed = await new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.argv,
      { env: sandbox.env, cwd: sandbox.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const output: Buffer[] = [];
    let bytes = 0, failed: string | undefined;
    const kill = (reason: string) => {
      failed ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => kill('aborted');
    const timer = setTimeout(() => kill('deadline exceeded'), input.maxWallClockMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    let line = '', pending: Promise<void> | undefined, ordinal = 0;
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) return kill('output limit exceeded');
      line += decoder.write(chunk);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) return kill('output limit exceeded');
      let index: number;
      while ((index = line.indexOf('\n')) !== -1 && !failed) {
        const message = line.slice(0, index); line = line.slice(index + 1);
        let row: any;
        try { row = JSON.parse(message); } catch { kill('invalid worker protocol'); break; }
        if (!row || typeof row !== 'object') { kill('invalid worker protocol'); break; }
        if (row.kind === 'task-command') {
          if (!broker || pending || row.id !== ++ordinal) { kill('invalid task command sequence'); break; }
          pending = broker.command(row.args, row.timeout).then(result => {
            if (!failed) child.stdin.write(JSON.stringify({ kind: 'task-result', id: row.id, ...result }) + '\n');
          }).catch(() => kill('task command refused')).finally(() => { pending = undefined; });
        } else if (output.length) kill('multiple terminal worker receipts');
        else output.push(Buffer.from(message));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Upstream diagnostics may contain request data. Bound and discard it;
      // the private trial artifacts retain the official trajectory.
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) kill('output limit exceeded');
    });
    child.stdin.on('error', () => { kill('stdin unavailable'); });
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', async code => {
      clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      await broker?.stop(); await pending;
      if (failed || spawnFailed || code !== 0) return reject(new Error(`Proximus host process failed: ${failed ?? 'execution failed'}.`));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8') + line + decoder.end())); }
      catch { reject(new Error('Proximus host process returned invalid evidence.')); }
    });
    // stdin remains open for broker responses. The initial payload is a
    // separate bounded line, and never becomes argv or a task file.
    child.stdin.write((input.stdin ?? '{}') + '\n');
    // Abort may race subscription; do not let that lose the hard stop.
    if (input.signal?.aborted) abort();
    });
  } finally { await broker?.stop(); sandbox.cleanup(); }
  if (input.operation === 'run' && completed && typeof completed === 'object' && !Array.isArray(completed)) {
    const binding = processBinding(input);
    processReceipts.set(completed, Object.freeze({ schemaVersion: 1, source: 'confined-host-process',
      executionId: randomUUID(), ...binding, task: Object.freeze(binding.task), workerResultSha256: evidenceHash(completed) }));
  }
  return completed;
}

function runtimeReceipt(value: unknown): ProximusRuntimeReceipt {
  const row = value as ProximusRuntimeReceipt | null;
  if (!row || row.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(row.runtimeRevision) ||
      typeof row.sourceRevision !== 'string' || typeof row.clientVersion !== 'string' ||
      typeof row.harborVersion !== 'string' || !Number.isSafeInteger(row.fileCount) || row.fileCount <= 0)
    throw new Error('Proximus installed runtime measurement is incomplete.');
  return Object.freeze({ schemaVersion: row.schemaVersion, runtimeRevision: row.runtimeRevision,
    sourceRevision: row.sourceRevision, clientVersion: row.clientVersion, harborVersion: row.harborVersion, fileCount: row.fileCount });
}

/** Preparation only: no gateway, task access, provider send or spend grant. */
export async function measureProximusRuntime(input: { pythonBin: string; signal?: AbortSignal },
  execute = proximusHostProcess): Promise<ProximusRuntimeReceipt> {
  return runtimeReceipt(await execute({ ...input, operation: 'measure', maxWallClockMs: 120_000 }));
}

async function installProximusRuntime(command: string, args: string[], options: ExecFileOptionsWithStringEncoding) {
  return (await promisify(execFile)(command, args, options)).stdout;
}

/** Reuse the vendored frozen uv project and measure the resulting interpreter.
 * Preparation has no task, gateway, provider credential or spend authority.
 * Every caller remeasures installed bytes; an existing venv is not a receipt. */
export async function prepareProximusRuntime(input: { signal?: AbortSignal } = {}, ports: {
  install?: typeof installProximusRuntime;
  measure?: typeof measureProximusRuntime;
} = {}) {
  input.signal?.throwIfAborted();
  const project = fileURLToPath(new URL('../../vendor/proximus', import.meta.url));
  const lock = createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex');
  const environment = join(tmpdir(), `papercusp-proximus-${lock.slice(0, 16)}`);
  const env: NodeJS.ProcessEnv = { UV_PROJECT_ENVIRONMENT: environment, PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'XDG_CACHE_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const stdout = await (ports.install ?? installProximusRuntime)('uv', [
    'run', '--frozen', '--no-dev', '--python', '3.12', '--project', project,
    'python', '-I', '-c', 'import sys;print(sys.executable)',
  ], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env, signal: input.signal });
  input.signal?.throwIfAborted();
  const pythonBin = stdout.trim();
  if (!isAbsolute(pythonBin) || dirname(pythonBin) !== join(environment, 'bin') ||
      !/^python(?:3(?:\.12)?)?$/.test(basename(pythonBin)))
    throw new Error('Proximus preparation returned an interpreter outside its frozen runtime.');
  const runtime = runtimeReceipt(await (ports.measure ?? measureProximusRuntime)({ pythonBin, signal: input.signal }));
  input.signal?.throwIfAborted();
  return Object.freeze({ pythonBin, runtime });
}

/** Existing task + frozen assignment + actual installed bytes + live opaque
 * gateway. A completed host process still requires terminal bill reconciliation
 * and official grading before it is a benchmark result. */
export async function runProximusHost(config: unknown,
  execution: Omit<Parameters<typeof proximusRunSpec>[1], 'runtimeRevision'> & {
    pythonBin: string; trialDir: string; instruction: string; network: string;
    networkMode: 'no-network' | 'public' | 'allowlist';
    gateway: CurrentBenchHostReferenceGateway; signal?: AbortSignal;
  }, execute = proximusHostProcess) {
  execution = { ...execution, handle: structuredClone(execution.handle), budget: structuredClone(execution.budget) };
  const protocol = requireCurrentBenchmarkAssignment(config, execution);
  const { requireCurrentBenchHostReferenceGateway } = await import('./current-su');
  requireCurrentBenchHostReferenceGateway(execution.gateway, protocol, execution);
  if (!isAbsolute(execution.trialDir) || !execution.instruction.trim())
    throw new Error('Proximus requires a host trial directory and exact task instruction.');
  const measured = await measureProximusRuntime(execution, execute);
  const spec = proximusRunSpec(protocol, { ...execution, runtimeRevision: measured.runtimeRevision });
  if (spec.sourceRevision !== measured.sourceRevision || spec.clientVersion !== measured.clientVersion ||
      spec.harborVersion !== measured.harborVersion) throw new Error('Proximus installed source/version differs from its assignment.');
  // Recheck after async preparation; a revoked grant must not start the loop.
  const grant = requireCurrentBenchHostReferenceGateway(execution.gateway, protocol, execution);
  const payload = { spec, gateway: grant.gateway, trialDir: execution.trialDir, instruction: execution.instruction,
    network: execution.network, networkMode: execution.networkMode };
  const processInput: ProximusHostProcessInput = { pythonBin: execution.pythonBin, operation: 'run', maxWallClockMs: spec.maxWallClockMs,
    signal: execution.signal, stdin: JSON.stringify(payload), confinement: {
      trialDir: execution.trialDir, gatewayBaseURL: grant.gateway.baseURL,
      task: { containerId: spec.containerId, image: spec.image, network: execution.network, networkMode: execution.networkMode },
    } };
  const binding = structuredClone(processBinding(processInput));
  const result = await execute(processInput) as {
      schemaVersion: number; status: string; runtime: unknown; diagnosticContext: unknown; billingStatus: string;
    } | null;
  if (!result || result.schemaVersion !== 1 || result.status !== 'completed' || result.billingStatus !== 'unreconciled' ||
      JSON.stringify(runtimeReceipt(result.runtime)) !== JSON.stringify(measured))
    throw new Error('Proximus host result differs from its measured runtime or lacks terminal process evidence.');
  const receipt = processReceipts.get(result);
  processReceipts.delete(result);
  if (!receipt || receipt.workerResultSha256 !== evidenceHash(result) ||
      Object.entries(binding).some(([key, value]) => evidenceHash(receipt[key as keyof typeof receipt]) !== evidenceHash(value)))
    throw new Error('Proximus requires an exact single-use host-issued confinement receipt.');
  const completed = Object.freeze({ status: 'completed' as const, runtime: measured,
    diagnosticContext: structuredClone(result.diagnosticContext), billingStatus: 'unreconciled' as const, confinement: receipt });
  hostRunReceipts.set(completed, { receipt, resultSha256: evidenceHash(completed) });
  return completed;
}
