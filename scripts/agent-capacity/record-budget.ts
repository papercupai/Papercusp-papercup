/** Paid corpus admission at the existing gateway's actual provider-send seam.
 * Reservations are list-price upper bounds, never invoices or refundable usage.
 * Reuses carryTrial rather than estimating how many retries a client request has.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { priceFor, priceTableVersion } from '@papercusp/model-pricing';
import { processMonotonicClock } from '../../packages/operator-core/lib/process-monotonic-clock';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult, GatewayCarryTrialBinding } from '../../packages/operator-core/lib/inference-gateway/gateway';

export interface RecordingBudgetConfig {
  model: 'gpt-6-luna';
  effort: 'low';
  accountId: string;
  /** SHA256 of the complete outgoing Authorization header (including "Bearer "), not the raw token. */
  credentialSha256: string;
  target: string;
  maxAttempts: number;
  maxUsdMicros: number;
}

// Official model page read 2026-10-17: full intrinsic bounds, not a byte/token guess.
// https://developers.openai.com/api/docs/models/gpt-6-luna
const INPUT_TOKENS = 922_000;
const OUTPUT_TOKENS = 128_000;

/** Exclusive append-only evidence: a torn final line cannot erase prior reservations.
 * Each provider send waits for its full snapshot and fsync, including the first
 * directory entry. Existing files (including symlinks) are never reused.
 */
export function recordingBudgetJournal(file: string) {
  const fd = openSync(file, 'wx', 0o600);
  let closed = false;
  let failed = false;
  try {
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { closeSync(fd); throw error; }
  return {
    persist(snapshot: unknown) {
      if (closed || failed) throw new Error('Recording budget journal is closed or failed');
      try {
        const bytes = Buffer.from(JSON.stringify(snapshot) + '\n');
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Recording budget journal write made no progress');
          offset += written;
        }
        fsyncSync(fd);
      } catch (error) { failed = true; throw error; }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}

export function recordingAttemptReserve() {
  const price = priceFor('gpt-6-luna');
  if (!price) throw new Error('Recording model is unpriced');
  const inputRate = Math.max(price.in, price.cacheRead ?? price.in * 0.1,
    price.cacheWrite ?? price.in * 1.25, price.cacheWrite1h ?? 0) *
    Math.max(1, price.longContext?.inputMultiplier ?? 1);
  const outputRate = price.out * Math.max(1, price.longContext?.outputMultiplier ?? 1);
  if (![inputRate, outputRate].every(rate => Number.isFinite(rate) && rate > 0)) {
    throw new Error('Recording model has invalid prices');
  }
  // Round each component upward in integer USD micros. Include Fast (2x) and
  // regional (1.1x) premiums even when the selected route does not charge them.
  const baseMicros = Math.ceil((INPUT_TOKENS * Math.ceil(inputRate * 1e6) +
    OUTPUT_TOKENS * Math.ceil(outputRate * 1e6)) / 1e6);
  const usdMicros = Math.ceil(baseMicros * 22 / 10);
  if (!Number.isSafeInteger(usdMicros) || usdMicros <= 0) throw new Error('Unsafe recording reserve');
  return { usdMicros, inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS,
    priceTableVersion: priceTableVersion(), costSource: 'estimated-upper-bound' as const };
}

export function recordingBudgetFromArgv(argv: readonly string[], selection?: { model: string; effort: string }): RecordingBudgetConfig | undefined {
  const flags = ['--max-model-usd', '--max-provider-attempts', '--provider-account',
    '--provider-credential-sha256', '--provider-target'];
  if (!flags.some(flag => argv.includes(flag))) return undefined;
  const values = flags.map(flag => {
    const i = argv.indexOf(flag);
    const value = i < 0 ? undefined : argv[i + 1];
    if (!value || value.startsWith('--') || argv.lastIndexOf(flag) !== i) throw new Error(`Recording budget requires one ${flag}`);
    return value;
  });
  const [usd, attempts, accountId, credentialSha256, target] = values;
  if (selection?.model !== 'gpt-6-luna' || selection.effort !== 'low' ||
      !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(usd) || !/^[1-9][0-9]*$/.test(attempts)) {
    throw new Error('Recording budget requires gpt-6-luna/low, positive USD (at most six decimals) and attempts');
  }
  const [whole, fraction = ''] = usd.split('.');
  return validateConfig({ model: 'gpt-6-luna', effort: 'low', accountId, credentialSha256, target,
    maxUsdMicros: Number(whole) * 1e6 + Number(fraction.padEnd(6, '0')), maxAttempts: Number(attempts) });
}

function validateConfig(input: RecordingBudgetConfig): RecordingBudgetConfig {
  const config = { ...input };
  if (config.model !== 'gpt-6-luna' || config.effort !== 'low' ||
      !config.accountId.trim() || config.accountId !== config.accountId.trim() ||
      !/^[a-f0-9]{64}$/.test(config.credentialSha256) ||
      !['https://chatgpt.com/backend-api/codex/responses', 'https://api.openai.com/v1/responses'].includes(config.target) ||
      ![config.maxAttempts, config.maxUsdMicros].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid recording provider budget binding');
  }
  return Object.freeze(config);
}

function localTextRequest(body: string, config: RecordingBudgetConfig): boolean {
  const request = JSON.parse(body);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const named = (tool: Record<string, unknown>) => typeof tool.name === 'string' && tool.name.trim().length > 0;
  const localTool = (tool: unknown) => object(tool) && named(tool) && ['function', 'custom'].includes(String(tool.type));
  // Match the existing current-su input contract: native namespaces contain
  // local definitions whose JSON-schema types are not multimodal content.
  const localTools = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every(tool =>
    localTool(tool) || object(tool) && tool.type === 'namespace' && named(tool) &&
      Array.isArray(tool.tools) && tool.tools.length > 0 && tool.tools.every(localTool));
  if (!request || request.model !== config.model || request.reasoning?.effort !== config.effort ||
      request.background === true || request.previous_response_id != null || request.conversation != null ||
      request.prompt != null || request.context_management != null ||
      request.audio != null || request.modalities != null ||
      request.tools !== undefined && (!Array.isArray(request.tools) ||
        !request.tools.every((tool: unknown) => localTools([tool])))) return false;
  const types = new Set(['message', 'input_text', 'output_text', 'function_call', 'function_call_output',
    'custom_tool_call', 'custom_tool_call_output', 'reasoning', 'summary_text']);
  const textOnly = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(textOnly);
    const item = value as Record<string, unknown>;
    if (item.type === 'additional_tools') return item.role === 'developer' && localTools(item.tools) &&
      Object.keys(item).every(key => ['type', 'id', 'role', 'tools'].includes(key));
    return (item.type === undefined || typeof item.type === 'string' && types.has(item.type)) &&
      Object.values(item).every(textOnly);
  };
  return (typeof request.input === 'string' || Array.isArray(request.input)) && textOnly(request.input);
}

export function recordingProviderBudget(input: RecordingBudgetConfig, persist: (snapshot: unknown) => void) {
  const config = validateConfig(input);
  const reserve = Object.freeze(recordingAttemptReserve());
  const token = randomBytes(32).toString('hex');
  const armId = `capacity-recording:${randomUUID()}`;
  const manifestSha256 = createHash('sha256').update(JSON.stringify({ config, reserve, armId })).digest('hex');
  const attempts: Array<{ attemptId: string; reservationRef: string; bodySha256: string;
    accountId: string; target: string; transport: string; reservedUsdMicros: number;
    outcome: string; responseStatus: number | null; usage?: unknown }> = [];
  let reservedUsdMicros = 0;
  let denied = 0;
  const refusalReasons: Record<string, number> = {};
  let stopped = false;
  const snapshot = () => ({ ...config, ...reserve, manifestSha256, armId, reservedUsdMicros,
    admitted: attempts.length, denied, refusalReasons: { ...refusalReasons }, stopped, measuredInvoiceUsd: null,
    attempts: attempts.map(attempt => ({ ...attempt })) });
  // Write-ahead: failure to save the reservation prevents the provider send.
  const save = () => persist(snapshot());
  const binding: GatewayCarryTrialBinding = Object.freeze({
    armId, manifestSha256, ownerId: 'agent-capacity-corpus', protocols: ['openai-responses'] as const,
    requestTokenSha256: createHash('sha256').update(token).digest('hex'),
    async authorizeAttempt(attempt: GatewayCarryTrialAttempt) {
      let refusalReason = 'malformed-request';
      try {
        const checks: Array<[string, boolean]> = [
          ['binding', attempt.manifestSha256 === manifestSha256 && attempt.armId === armId],
          ['account', attempt.accountId === config.accountId],
          ['credential', attempt.credentialSha256 === config.credentialSha256 && attempt.credentialHeader === 'authorization'],
          ['target', attempt.target === config.target],
          ['transport', attempt.transport === (config.target.startsWith('https://chatgpt.com/') ? 'oauth-http' : 'bearer-http')],
          ['body-integrity', attempt.bodySha256 === createHash('sha256').update(attempt.body).digest('hex')],
          ['clock', attempt.clockId === processMonotonicClock.id],
        ];
        refusalReason = checks.find(([, valid]) => !valid)?.[0] ?? '';
        if (!refusalReason && !localTextRequest(attempt.body, config)) refusalReason = 'request-shape';
      } catch { refusalReason = 'malformed-request'; }
      if (refusalReason || stopped || attempt.signal.aborted) {
        const reason = refusalReason || (stopped ? 'stopped' : 'aborted');
        denied++; refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1; save(); return null;
      }
      const reservationRef = `${armId}:${attempt.attemptId}`;
      let reserved = false;
      const observe = async (result: GatewayCarryTrialAttemptResult) => {
        const row = attempts.find(row => row.reservationRef === reservationRef);
        if (!row || result.attemptId !== attempt.attemptId || result.reservationRef !== reservationRef) return;
        row.outcome = result.outcome;
        row.responseStatus = result.responseStatus;
        if (result.outcome === 'response-completed') row.usage = { ...result.providerCompletion,
          usage: { ...result.providerCompletion.usage } };
        // No response outcome or token report refunds an upper-bound reservation.
        save();
      };
      return { attemptId: attempt.attemptId, reservationRef, clockId: attempt.clockId,
        validUntilMonotonicMs: processMonotonicClock.now() + 30_000,
        validateAuthorization() {
          if (reserved || stopped || attempt.signal.aborted || attempts.some(row => row.attemptId === attempt.attemptId) ||
              attempts.length >= config.maxAttempts || reserve.usdMicros > config.maxUsdMicros - reservedUsdMicros) {
            denied++; save(); throw new Error('Recording provider allowance exhausted or revoked');
          }
          // One synchronous counter covers workers, retries and outer OAuth recovery.
          reserved = true;
          reservedUsdMicros += reserve.usdMicros;
          attempts.push({ attemptId: attempt.attemptId, reservationRef, bodySha256: attempt.bodySha256,
            accountId: attempt.accountId, target: attempt.target, transport: attempt.transport,
            reservedUsdMicros: reserve.usdMicros, outcome: 'reserved-usage-unknown', responseStatus: null });
          save();
        },
        observeAttemptResult: observe, observeAttemptCompletion: observe };
    },
  });
  save();
  return { binding, snapshot, stop() { stopped = true; save(); },
    // Host-owned proxy headers; the CLI never receives the private gateway credential.
    headers: Object.freeze({ authorization: `Bearer ${token}`, 'x-papercusp-account': config.accountId,
      'x-papercusp-account-pin': 'hard', 'x-papercusp-owner': 'agent-capacity-corpus' }) };
}

/** Dynamic service load keeps ordinary recordings and unit imports independent of PG. */
export async function startRecordingBudgetGateway(config: RecordingBudgetConfig, persist: (snapshot: unknown) => void,
  startService: (binding: GatewayCarryTrialBinding) => Promise<{ port: number; stop(): Promise<void> }> = async binding => {
    const { startGatewayService } = await import('../../packages/operator-core/lib/inference-gateway/launch');
    return startGatewayService({ port: 0, workspace: process.env.PAPERCUSP_WORKSPACE, carryTrial: binding });
  }) {
  const budget = recordingProviderBudget(config, persist);
  try {
    const service = await startService(budget.binding);
    return { upstream: `http://127.0.0.1:${service.port}`, headers: budget.headers, snapshot: budget.snapshot,
      async stop() { try { budget.stop(); } finally { await service.stop(); } } };
  } catch (error) { budget.stop(); throw error; }
}
