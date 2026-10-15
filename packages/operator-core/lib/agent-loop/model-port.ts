/**
 * ModelPort — the OWNED provider seam for Papercusp's agent loop.
 *
 * Plan own-tui-full-divorce-2026-08-24, P-007 / D-010: everything above this
 * port — loop, sessions, native protocol, HITL, auth — is ours; a provider
 * library (AI SDK v6, the gateway's native anthropic-messages path, a future
 * openai-responses leg) supplies only the wire dialect BEHIND an adapter that
 * implements this interface. Loop code (loop.ts, P-009 sessions) imports THESE
 * types and never a provider SDK's — that inversion is the ratified decision,
 * not a style preference: it is what keeps AI SDK a swappable seat instead of
 * a substrate marriage.
 *
 * Deliberately thin: one streaming call, provider-neutral messages with
 * explicit tool_call / tool_result parts, JSON-Schema tool definitions
 * (the same currency the agent-tools registry and MCP already speak).
 */

/** One content part of a conversation message. Provider-neutral: adapters map
 *  these onto their wire dialect (anthropic content blocks, openai parts…). */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | {
      /** A tool invocation the ASSISTANT emitted. `id` correlates the later
       *  tool_result part; adapters must preserve it round-trip. */
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
    }
  | {
      /** The executed tool's outcome, sent back in a USER-role message.
       *  `content` is JSON-serializable; `isError: true` marks a failed or
       *  denied execution so the model can react instead of hallucinating
       *  success. */
      type: 'tool_result';
      toolCallId: string;
      content: unknown;
      isError?: boolean;
    };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContentPart[];
}

/** Convenience: a plain-text message. */
export function textMessage(role: ModelMessage['role'], text: string): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

/** A tool as the MODEL sees it — name + description + JSON Schema input.
 *  The same shape the capability:* doors / MCP already publish, so projecting
 *  the registry into a request is a rename, not a translation. */
export interface ModelToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input (draft-07-compatible object schema). */
  inputSchema: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Additive cache-priced inputs, when the provider reports them. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

/** Whitelisted provider report for ONE completed request. This is routing/
 * accounting preparation, not an authenticated billing-account identity,
 * exact commercial receipt or invoice-finality claim. Keep the reported
 * charge separate from ModelUsage.costUsd's token-based estimate. Incomplete
 * or failed streams do not supply this completed-response record. */
export interface ModelProviderResponse {
  provider: string;
  id?: string;
  modelId?: string;
  reportedCostUsd?: number;
}

/** Dispatch intent and early response identity for one request. This is an
 * obligation observation, including when no generation id arrives; it does
 * not establish provider acceptance, zero liability, completion or a bill.
 * Keep every valid conflicting identity for reconciliation, mark uncertainty,
 * and never include raw provider metadata, credentials or prompt content. */
export interface ModelProviderRequest {
  provider: string;
  /** Exact model selected for this route. */
  modelId: string;
  response?: Pick<ModelProviderResponse, 'id' | 'modelId'>;
  identityUncertain?: boolean;
}

/** Local identity of the credential actually selected for ONE OpenRouter
 * request. It is private server context, not a provider billing-account
 * ownership claim. Declared here (a no-import leaf) rather than in
 * provider-router.ts so hosted billing code can name it without pulling the
 * router's credential/gateway graph into every consumer's typecheck
 * (WI-10006711: the portal build failed on exactly that). */
export interface OpenRouterRequestContext {
  readonly modelId: string;
  readonly servedAccount: string;
  readonly credentialSha256: string;
}
export type OpenRouterRequestCapture = (request: Readonly<ModelProviderRequest>) => Promise<void>;

/** Server-only continuation on the existing observation seam. The owned
 * consumer awaits it before pulling again; public snapshots omit symbols.
 * It contains no serializable grant, credential or billing authority. */
export const MODEL_PROVIDER_REQUEST_CAPTURE = Symbol('model-provider-request-capture');

export async function captureModelProviderRequest(
  event: Extract<ModelStreamEvent, { type: 'provider_request' }>,
): Promise<void> {
  await event[MODEL_PROVIDER_REQUEST_CAPTURE]?.();
}

export type ModelStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'aborted'
  | 'other';

/** One event of a streamed model response. The adapter accumulates partial
 *  tool-call JSON internally and emits each `tool_call` COMPLETE — the loop
 *  never sees half-parsed arguments. Exactly one terminal event ends a healthy
 *  stream (`stop`); `error` is terminal too. */
export type ModelStreamEvent =
  | { type: 'provider_request'; request: ModelProviderRequest; servedAccount?: string;
      [MODEL_PROVIDER_REQUEST_CAPTURE]?: () => Promise<void> }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: ModelStopReason; usage?: ModelUsage; servedAccount?: string;
      providerResponse?: ModelProviderResponse }
  | { type: 'error'; message: string; raw?: unknown };

export interface ModelRequest {
  /** Provider-scoped model id (adapters own the mapping to wire ids). */
  model: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ModelToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Abort mid-stream; adapters must respect it (surface as stop/aborted or error). */
  signal?: AbortSignal;
  /** Inference-gateway admission-tier label (x-papercusp-priority) — see
   *  gateway-priority-tiers-2026-06-22. Untiered calls are starved under
   *  fleet load, so interactive callers should always set one. */
  priority?: string;
  /** Optional per-request inference-gateway account route. Undefined means
   * gateway auto-routing. OpenRouter also honors pins in its explicitly supplied
   * runtime account pool; other direct API-key providers ignore this axis. */
  account?: string;
  /** Stable caller identity forwarded to the inference gateway for routing
   * attribution (owned loop/chat id, not a user-provided label). */
  ownerId?: string;
}

/** The one seam. Implementations: the gateway-native anthropic-messages
 *  adapter (first-class per D-010), an AI SDK v6 adapter (P-009 provider
 *  wiring), and test fakes. */
export interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
