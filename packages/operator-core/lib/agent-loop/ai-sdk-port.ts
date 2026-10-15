/**
 * AI SDK v6 provider adapter behind the owned ModelPort (P-009 / D-010).
 *
 * This module imports only AI SDK's provider specification. Concrete provider
 * packages are selected in provider-router.ts; no AI SDK type escapes the
 * ModelPort boundary.
 */
import { costFromTokens, type ModelPrice, type TokenUsage } from '@papercusp/model-pricing';
import type {
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type {
  ModelContentPart,
  ModelMessage,
  ModelPort,
  ModelProviderResponse,
  ModelRequest,
  ModelStopReason,
  ModelStreamEvent,
  ModelUsage,
} from './model-port';
import type { AiSdkProviderId } from './model-selection';
import {
  modelToolNameCodec,
  providerWireToolName,
  type ModelToolNameCodec,
} from './model-tool-name-codec';

export interface AiSdkPortModel {
  model: LanguageModelV3;
  provider: AiSdkProviderId | 'gateway-codex';
  /** Provider-scoped model id used for canonical pricing. */
  modelId: string;
  /** Explicit route/model-bound list rates. Missing OpenRouter rates never
   * inherit a direct-provider table price or a different catalog variant. */
  pricing?: { provider: 'openrouter'; modelId: string; price: ModelPrice | null };
  effort?: string | null;
  /** Per-request headers (the gateway priority tier lives here). */
  headers?: Record<string, string | undefined>;
}

export interface AiSdkPortOptions {
  resolveModel(req: ModelRequest): Promise<AiSdkPortModel> | AiSdkPortModel;
}

/**
 * AI-provider function names share a conservative alphanumeric/underscore/
 * hyphen wire contract. Papercusp's canonical projected-tool names contain a
 * namespace colon (`capability:read`), so send a deterministic readable alias
 * and translate it back at the ModelPort boundary. The digest makes aliases
 * collision-resistant while the 64-char cap remains valid across providers.
 */
export function aiSdkWireToolName(name: string): string {
  return providerWireToolName(name);
}

function toolNameCodec(req: ModelRequest): ModelToolNameCodec {
  return modelToolNameCodec(req.tools);
}

function jsonValue(value: unknown): JSONValue | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}

function toolNames(messages: ModelMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_call') names.set(part.id, part.name);
    }
  }
  return names;
}

function resultOutput(part: Extract<ModelContentPart, { type: 'tool_result' }>): LanguageModelV3ToolResultOutput {
  const value = jsonValue(part.content);
  if (part.isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value };
}

/** Map owned messages to the AI SDK v6 provider-spec prompt. */
export function toAiSdkPrompt(
  system: string | undefined,
  messages: ModelMessage[],
  encodeToolName: (name: string) => string = (name) => name,
): LanguageModelV3Message[] {
  const prompt: LanguageModelV3Message[] = [];
  if (system) prompt.push({ role: 'system', content: system });
  const names = toolNames(messages);

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: Extract<LanguageModelV3Message, { role: 'assistant' }>['content'] = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'tool_call') {
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: encodeToolName(part.name),
            input: part.input ?? {},
          });
        }
      }
      if (content.length) prompt.push({ role: 'assistant', content });
      continue;
    }

    const text = message.content.filter((part) => part.type === 'text');
    if (text.length) {
      prompt.push({
        role: 'user',
        content: text.map((part) => ({ type: 'text' as const, text: part.text })),
      });
    }
    const results = message.content.filter((part) => part.type === 'tool_result');
    if (results.length) {
      prompt.push({
        role: 'tool',
        content: results.map((part) => ({
          type: 'tool-result' as const,
          toolCallId: part.toolCallId,
          toolName: encodeToolName(names.get(part.toolCallId) ?? 'unknown_tool'),
          output: resultOutput(part),
        })),
      });
    }
  }
  return prompt;
}

export function effortProviderOptions(
  provider: AiSdkPortModel['provider'],
  effort: string | null | undefined,
): SharedV3ProviderOptions | undefined {
  // D-016 requires request-level ZDR regardless of reasoning support or
  // account defaults. Keep it on the shared call seam so streaming, endpoint
  // failures and injected SDK-model defaults cannot relax the policy.
  if (provider === 'openrouter') {
    return { openrouter: { provider: { zdr: true }, ...(effort ? { reasoning: { effort } } : {}) } };
  }
  if (!effort) return undefined;
  switch (provider) {
    case 'anthropic':
      return { anthropic: { effort } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case 'gateway-codex':
    case 'openai':
      return { openai: { reasoningEffort: effort } };
    case 'mistral':
      return { mistral: { reasoningEffort: effort } };
    case 'groq':
      return { groq: { reasoningEffort: effort } };
    case 'xai':
      return { xai: { reasoningEffort: effort } };
  }
}

export function buildAiSdkCallOptions(
  req: ModelRequest,
  resolved: AiSdkPortModel,
  codec: ModelToolNameCodec = toolNameCodec(req),
): LanguageModelV3CallOptions {
  return {
    prompt: toAiSdkPrompt(req.system, req.messages, codec.encode),
    ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            name: codec.encode(tool.name),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            // ModelPort owns JSON Schema as a provider-neutral object. AI SDK
            // consumes draft-07 here; capability schemas already use it.
            inputSchema: tool.inputSchema as never,
          })),
          toolChoice: { type: 'auto' as const },
        }
      : {}),
    ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    ...(effortProviderOptions(resolved.provider, resolved.effort)
      ? { providerOptions: effortProviderOptions(resolved.provider, resolved.effort) }
      : {}),
  };
}

function stopReason(raw: LanguageModelV3StreamPart & { type: 'finish' }): ModelStopReason {
  switch (raw.finishReason.unified) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool-calls':
      return 'tool_use';
    default:
      return 'other';
  }
}

function usage(raw: LanguageModelV3StreamPart & { type: 'finish' }, provider: AiSdkPortModel['provider']): ModelUsage {
  const input = raw.usage.inputTokens;
  const output = raw.usage.outputTokens;
  const inputTokens = input.total ?? ((input.noCache ?? 0) + (input.cacheRead ?? 0)
    + (provider === 'openrouter' ? 0 : (input.cacheWrite ?? 0)));
  const outputTokens = output.total ?? ((output.text ?? 0) + (output.reasoning ?? 0));
  return {
    inputTokens,
    outputTokens,
    ...(input.cacheRead !== undefined ? { cacheReadTokens: input.cacheRead } : {}),
    ...(input.cacheWrite !== undefined ? { cacheCreationTokens: input.cacheWrite } : {}),
  };
}

/** ModelUsage keeps total input for display. Canonical pricing takes UNCACHED
 * input plus disjoint cache subsets and a full per-request tier discriminator.
 * OpenRouter SDK 2.9.1 `noCache` subtracts reads only, so derive from total and
 * both subsets instead. Unknown writes are not measured zeroes. */
function pricingUsage(raw: LanguageModelV3StreamPart & { type: 'finish' }, provider: AiSdkPortModel['provider']): TokenUsage | null {
  const input = raw.usage.inputTokens;
  const output = raw.usage.outputTokens;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if ([input.total, input.noCache, input.cacheRead, input.cacheWrite, output.total, output.text, output.reasoning]
    .some((n) => n !== undefined && !count(n))) return null;
  if (!count(input.cacheRead) || !count(input.cacheWrite)) return null;
  const total = input.total ?? (input.noCache !== undefined
    ? input.noCache + input.cacheRead + (provider === 'openrouter' ? 0 : input.cacheWrite) : undefined);
  const out = output.total ?? (output.text !== undefined && output.reasoning !== undefined
    ? output.text + output.reasoning : undefined);
  if (!count(total) || !count(out)) return null;
  const uncached = total - input.cacheRead - input.cacheWrite;
  if (!count(uncached) || (provider !== 'openrouter' && input.noCache !== undefined && input.noCache !== uncached)
      || (output.total !== undefined && output.text !== undefined && output.reasoning !== undefined
        && output.total !== output.text + output.reasoning)) return null;
  return { requestInputTokens: total, inputTokens: uncached, outputTokens: out,
    cacheReadTokens: input.cacheRead, cacheCreationTokens: input.cacheWrite,
    ...(provider === 'anthropic' && input.cacheWrite > 0 ? { cacheCreationTierUnknown: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error) ?? String(error);
}

async function* readAiSdkStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  resolved: AiSdkPortModel,
  decodeToolName: (name: string) => string = (name) => name,
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent, void, void> {
  const reader = stream.getReader();
  let finished = false;
  let responseId: string | undefined;
  let responseModelId: string | undefined;
  let invalidResponseId = false;
  let invalidResponseModelId = false;
  let lastObservation: string | undefined;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (signal?.aborted) break;
      if (done) break;
      switch (value.type) {
        case 'response-metadata':
          if (resolved.provider === 'openrouter') {
            const validId = typeof value.id === 'string' && /^gen-[0-9A-Za-z-]{1,124}$/.test(value.id);
            const validModel = typeof value.modelId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value.modelId);
            // Repeated identical frames are normal. A conflicting or invalid
            // id must never become the generation selected for reconciliation.
            if (value.id !== undefined) {
              if (typeof value.id !== 'string' || !/^gen-[0-9A-Za-z-]{1,124}$/.test(value.id)
                  || (responseId !== undefined && responseId !== value.id)) invalidResponseId = true;
              if (!invalidResponseId) responseId = value.id;
            }
            if (value.modelId !== undefined) {
              if (typeof value.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value.modelId)
                  || (responseModelId !== undefined && responseModelId !== value.modelId)) invalidResponseModelId = true;
              if (!invalidResponseModelId) responseModelId = value.modelId;
            }
            // Emit before asking the provider for another frame. An error,
            // lost finish frame or cancellation cannot erase this identity.
            const id = validId ? value.id : value.id === undefined && !invalidResponseId ? responseId : undefined;
            const modelId = validModel ? value.modelId : value.modelId === undefined && !invalidResponseModelId ? responseModelId : undefined;
            const response = { ...(id !== undefined ? { id } : {}), ...(modelId !== undefined ? { modelId } : {}) };
            const request = { provider: 'openrouter', modelId: resolved.modelId,
              ...(Object.keys(response).length ? { response } : {}),
              ...(invalidResponseId || invalidResponseModelId ? { identityUncertain: true } : {}) };
            const signature = JSON.stringify(request);
            if (signature !== lastObservation && (Object.keys(response).length || request.identityUncertain)) {
              lastObservation = signature;
              yield { type: 'provider_request', request };
            }
          }
          break;
        case 'text-delta':
          yield { type: 'text_delta', text: value.delta };
          break;
        case 'reasoning-delta':
          yield { type: 'reasoning_delta', text: value.delta };
          break;
        case 'tool-call': {
          let input: unknown = {};
          if (value.input.trim()) {
            try {
              input = JSON.parse(value.input);
            } catch {
              input = { __unparsed: value.input };
            }
          }
          yield {
            type: 'tool_call',
            id: value.toolCallId,
            name: decodeToolName(value.toolName),
            input,
          };
          break;
        }
        case 'finish': {
          if (value.finishReason.unified === 'error') {
            yield { type: 'error', message: 'AI SDK provider reported an unsuccessful finish' };
            return;
          }
          // The maintained OpenRouter SDK flushes a synthetic finish on EOF,
          // even when the wire never supplied finish_reason. That closes its
          // stream but cannot certify a completed provider request.
          if (resolved.provider === 'openrouter' && (typeof value.finishReason.raw !== 'string' || !value.finishReason.raw.trim())) {
            yield { type: 'error', message: 'OpenRouter stream ended without a provider finish reason' };
            return;
          }
          const baseUsage = usage(value, resolved.provider);
          const tokens = pricingUsage(value, resolved.provider);
          const price = resolved.pricing?.provider === 'openrouter' && resolved.pricing.modelId === resolved.modelId
            ? resolved.pricing.price : null;
          const routeModelMatches = resolved.provider !== 'openrouter' || (!invalidResponseModelId
            && (responseModelId === undefined || responseModelId === resolved.modelId));
          const priced = tokens && routeModelMatches ? costFromTokens(resolved.modelId, tokens,
            resolved.provider === 'openrouter' ? { price } : {}) : { usd: 0, priced: false };
          let providerResponse: ModelProviderResponse | undefined;
          if (resolved.provider === 'openrouter') {
            const metadata = value.providerMetadata?.openrouter;
            const reported = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
              ? metadata.usage : undefined;
            const cost = reported && typeof reported === 'object' && !Array.isArray(reported)
              ? reported.cost : undefined;
            const validCost = typeof cost === 'number' && Number.isFinite(cost)
              && cost >= 0 && cost <= Number.MAX_SAFE_INTEGER;
            const id = invalidResponseId ? undefined : responseId;
            const modelId = invalidResponseModelId ? undefined : responseModelId;
            if (id !== undefined || modelId !== undefined || validCost) {
              providerResponse = { provider: 'openrouter',
                ...(id !== undefined ? { id } : {}),
                ...(modelId !== undefined ? { modelId } : {}),
                ...(validCost ? { reportedCostUsd: cost } : {}) };
            }
          }
          yield {
            type: 'stop',
            reason: stopReason(value),
            usage: priced.priced ? { ...baseUsage, costUsd: priced.usd } : baseUsage,
            ...(providerResponse ? { providerResponse } : {}),
          };
          finished = true;
          break;
        }
        case 'error':
          yield { type: 'error', message: errorMessage(value.error), raw: value.error };
          return;
        default:
          break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    if (!finished) cancelReader();
    reader.releaseLock();
  }
  if (!finished) {
    yield signal?.aborted ? { type: 'stop', reason: 'aborted' }
      : { type: 'error', message: 'AI SDK provider stream ended without a finish event' };
  }
}

export function createAiSdkPort(opts: AiSdkPortOptions): ModelPort {
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      let resolved: AiSdkPortModel;
      try {
        resolved = await opts.resolveModel(req);
      } catch (error) {
        yield { type: 'error', message: errorMessage(error) };
        return;
      }
      try {
        if (req.signal?.aborted) { yield { type: 'stop', reason: 'aborted' }; return; }
        const codec = toolNameCodec(req);
        if (resolved.provider === 'openrouter') {
          yield { type: 'provider_request', request: { provider: 'openrouter', modelId: resolved.modelId } };
          if (req.signal?.aborted) { yield { type: 'stop', reason: 'aborted' }; return; }
        }
        const result = await resolved.model.doStream(buildAiSdkCallOptions(req, resolved, codec));
        yield* readAiSdkStream(result.stream, resolved, codec.decode, req.signal);
      } catch (error) {
        if (req.signal?.aborted) {
          yield { type: 'stop', reason: 'aborted' };
          return;
        }
        yield { type: 'error', message: errorMessage(error) };
      }
    },
  };
}
