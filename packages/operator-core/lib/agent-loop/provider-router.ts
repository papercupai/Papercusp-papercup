/**
 * ModelPort router for the owned loop (P-009 / D-010).
 *
 * Subscription models keep riding Papercusp's proven inference gateway;
 * explicitly provider-qualified API-key models use AI SDK v6 provider
 * packages. The loop above this module sees only ModelPort.
 */
import { createHash } from 'node:crypto';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { priorityTierHeaders, routeAccountHeaders } from '../agent-chat-stream';
import { readCredentials, type Credentials } from '../credentials';
import type { AccountPool, ActiveAccount } from '../inference-gateway/provider-contracts';
import { createAiSdkPort } from './ai-sdk-port';
import { createAnthropicPort } from './anthropic-port';
import { MODEL_PROVIDER_REQUEST_CAPTURE, type ModelPort,
  type ModelRequest, type ModelStreamEvent } from './model-port';
import {
  loadModelsDevCatalog,
  openRouterTokenPrice,
  resolveLoopModelSpec,
  type AiSdkProviderId,
  type LoopModelSelection,
  type ModelsDevCatalog,
} from './model-selection';

// Catalog metadata is advisory. Credential slots are local authority: a remote
// catalog must never select an unrelated secret for a provider's request.
const API_KEY_ENV: Record<Exclude<AiSdkProviderId, 'openrouter'>, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
};

export interface ProviderFactoryArgs {
  selection: LoopModelSelection;
  apiKey?: string;
  gatewayBaseUrl: string;
}

// Declared in the no-import leaf so hosted billing can name them without this
// module's graph (WI-10006711); re-exported for existing router callers.
import type { OpenRouterRequestCapture, OpenRouterRequestContext } from './model-port';
export type { OpenRouterRequestCapture, OpenRouterRequestContext } from './model-port';

export interface RoutedModelPortOptions {
  /** Fixed catalog/test seam. `undefined` loads the cached live models.dev catalog. */
  catalog?: ModelsDevCatalog | null;
  loadCatalog?: () => Promise<ModelsDevCatalog>;
  credentials?: () => Promise<Credentials>;
  env?: NodeJS.ProcessEnv;
  gatewayBaseUrl?: string;
  anthropicPort?: ModelPort;
  createLanguageModel?: (args: ProviderFactoryArgs) => Promise<LanguageModelV3>;
  /** Runtime-owned OpenRouter pool; no ambient operator key or account is inferred. */
  openRouterAccounts?: AccountPool;
  /** Authenticated host composition only. Creates a fresh, synchronous capture
   * closure per request; writes belong in the returned awaited observation
   * handler. No default authority or production paid integration is installed. */
  openRouterRequestCapture?: (context: Readonly<OpenRouterRequestContext>) => OpenRouterRequestCapture;
}

function gatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  const port = Number(env.PAPERCUSP_GATEWAY_PORT);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8788}/v1`;
}

function storedKey(provider: AiSdkProviderId, credentials: Credentials): string | undefined {
  if (provider === 'openai') return credentials.openai_api_key?.trim() || undefined;
  if (provider === 'anthropic') return credentials.anthropic_api_key?.trim() || undefined;
  return undefined;
}

function apiKeyFor(
  selection: LoopModelSelection,
  credentials: Credentials,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (selection.provider === 'gateway-anthropic' || selection.provider === 'gateway-codex'
    || selection.provider === 'openrouter') {
    return undefined;
  }
  const fromStore = storedKey(selection.provider, credentials);
  if (fromStore) return fromStore;
  const names = API_KEY_ENV[selection.provider];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function openRouterCredentials(
  pool: AccountPool | undefined,
  pin: string | undefined,
): Promise<{ apiKey: string; accountId: string }> {
  if (!pool) throw new Error('an explicitly supplied OpenRouter account pool is required');
  const pinned = pin !== undefined && pin !== 'auto' && pin !== 'default';
  let account: ActiveAccount | null | undefined;
  try {
    account = pinned ? pool.select?.(pin) : pool.active();
  } catch {
    // Pool implementations can touch credential stores. Their exception text
    // cannot cross the ModelPort boundary or trigger an ambient-key fallback.
    throw new Error('failed to select OpenRouter account');
  }
  if (!account || (pinned && account.accountId !== pin)) {
    throw new Error('OpenRouter account pin is unavailable');
  }
  const accountId = account.accountId;
  if (account.authMode !== 'api-key') throw new Error('OpenRouter account must use API-key authentication');
  let key: string;
  try {
    key = (await account.token()).trim();
  } catch {
    throw new Error('failed to read OpenRouter account credentials');
  }
  if (!key) throw new Error('OpenRouter account has no API key');
  return { apiKey: key, accountId };
}

async function defaultLanguageModel(args: ProviderFactoryArgs): Promise<LanguageModelV3> {
  const { selection, apiKey } = args;
  switch (selection.provider) {
    case 'gateway-codex': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        baseURL: args.gatewayBaseUrl,
        apiKey: 'papercusp-gateway',
      })(selection.modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(selection.modelId);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(selection.modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(selection.modelId);
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral');
      return createMistral({ apiKey })(selection.modelId);
    }
    case 'groq': {
      const { createGroq } = await import('@ai-sdk/groq');
      return createGroq({ apiKey })(selection.modelId);
    }
    case 'xai': {
      const { createXai } = await import('@ai-sdk/xai');
      return createXai({ apiKey })(selection.modelId);
    }
    case 'openrouter': {
      const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
      return createOpenRouter({ apiKey }).chat(selection.modelId);
    }
    case 'gateway-anthropic':
      throw new Error('gateway-anthropic is handled by the native Anthropic ModelPort');
  }
}

async function catalogFor(opts: RoutedModelPortOptions): Promise<ModelsDevCatalog | null> {
  if (opts.catalog !== undefined) return opts.catalog;
  try {
    return await (opts.loadCatalog?.() ?? loadModelsDevCatalog());
  } catch {
    // The catalog enriches selection/capability validation; it is not allowed
    // to take the two subscription gateways down. Unknown bare ids still fail
    // closed in resolveLoopModelSpec without it.
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default ModelPort for agent chats: route each request from its model spec. */
export function createRoutedModelPort(opts: RoutedModelPortOptions = {}): ModelPort {
  const env = opts.env ?? process.env;
  const nativeAnthropic = opts.anthropicPort ?? createAnthropicPort();
  const createLanguageModel = opts.createLanguageModel ?? defaultLanguageModel;
  const readCreds = opts.credentials ?? readCredentials;
  const baseUrl = opts.gatewayBaseUrl ?? gatewayBaseUrl(env);
  const captureFactory = opts.openRouterRequestCapture;

  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      let selection: LoopModelSelection;
      try {
        selection = resolveLoopModelSpec(req.model, await catalogFor(opts));
      } catch (error) {
        yield { type: 'error', message: errorMessage(error) };
        return;
      }

      if (req.temperature !== undefined && selection.metadata?.temperature === false) {
        yield {
          type: 'error',
          message: `${selection.modelId} does not accept temperature according to models.dev metadata`,
        };
        return;
      }

      if (selection.provider === 'gateway-anthropic') {
        yield* nativeAnthropic.stream({ ...req, model: selection.modelId });
        return;
      }
      // Capture the narrowed discriminant before the async resolver closure;
      // property narrowings do not survive an async boundary in TypeScript.
      const aiProvider: Exclude<LoopModelSelection['provider'], 'gateway-anthropic'> =
        selection.provider;
      // Capture the selected rates before asynchronous credential/model work;
      // later mutations of an injected advisory catalog cannot reprice this call.
      const pricing = aiProvider === 'openrouter' ? { provider: 'openrouter' as const,
        modelId: selection.modelId, price: openRouterTokenPrice(selection) } : undefined;

      let apiKey: string | undefined;
      let servedAccount: string | undefined;
      try {
        if (aiProvider === 'openrouter') {
          const selected = await openRouterCredentials(opts.openRouterAccounts, req.account);
          apiKey = selected.apiKey;
          servedAccount = selected.accountId;
        } else {
          const credentials = aiProvider === 'gateway-codex' ? {} : await readCreds();
          apiKey = apiKeyFor(selection, credentials, env);
        }
      } catch (error) {
        yield { type: 'error', message: aiProvider === 'openrouter'
          ? errorMessage(error) : `failed to read provider credentials: ${errorMessage(error)}` };
        return;
      }
      if (aiProvider !== 'gateway-codex' && aiProvider !== 'openrouter' && !apiKey) {
        const names = API_KEY_ENV[aiProvider];
        yield {
          type: 'error',
          message:
            `${selection.provider}/${selection.modelId} needs an API key ` +
            `(${names.join(' or ')}); configure the key or use a claude/ or codex/ subscription model`,
        };
        return;
      }

      let capture: OpenRouterRequestCapture | undefined;
      if (aiProvider === 'openrouter' && captureFactory) {
        try {
          capture = captureFactory(Object.freeze({ modelId: selection.modelId, servedAccount: servedAccount!,
            credentialSha256: createHash('sha256').update(apiKey!).digest('hex') }));
          if (typeof capture !== 'function') throw new Error('invalid capture');
        } catch {
          yield { type: 'error', message: 'OpenRouter request capture could not be configured' };
          return;
        }
      }

      const aiPort = createAiSdkPort({
        resolveModel: async () => ({
          model: await createLanguageModel({ selection, apiKey, gatewayBaseUrl: baseUrl }),
          provider: aiProvider,
          modelId: selection.modelId,
          ...(pricing ? { pricing } : {}),
          effort: selection.effort,
          ...(aiProvider === 'gateway-codex'
            ? { headers: { ...priorityTierHeaders(req.priority), ...routeAccountHeaders(req.account) } }
            : {}),
        }),
      });
      if (aiProvider === 'gateway-codex' && req.maxTokens !== undefined) {
        // ChatGPT's subscription Responses backend rejects the otherwise
        // standard `max_output_tokens` field (HTTP 400, live-verified during
        // P-009). AI SDK emits that field whenever maxOutputTokens is set.
        // Omit it on this ONE wire rather than breaking compaction's bounded
        // summarizer call; direct OpenAI/API-key providers still receive and
        // enforce the requested limit.
        const { maxTokens: _unsupportedMaxTokens, ...gatewayReq } = req;
        yield* aiPort.stream({ ...gatewayReq, model: selection.modelId });
        return;
      }
      for await (const event of aiPort.stream({ ...req, model: selection.modelId })) {
        const routed = (event.type === 'stop' || event.type === 'provider_request') && servedAccount !== undefined
          ? { ...event, servedAccount }
          : event;
        if (routed.type !== 'provider_request' || !capture) { yield routed; continue; }
        const observed = routed.request;
        const snapshot = Object.freeze({ provider: observed.provider, modelId: observed.modelId,
          ...(observed.response ? { response: Object.freeze({
            ...(observed.response.id !== undefined ? { id: observed.response.id } : {}),
            ...(observed.response.modelId !== undefined ? { modelId: observed.response.modelId } : {}),
          }) } : {}), ...(observed.identityUncertain !== undefined ? { identityUncertain: observed.identityUncertain } : {}) });
        let pending: Promise<void> | undefined;
        let captured = false;
        const commit = () => pending ??= Promise.resolve().then(() => capture!(snapshot)).then(() => { captured = true; },
          () => { throw new Error('OpenRouter request capture failed; reservation remains unresolved'); });
        yield { ...routed, [MODEL_PROVIDER_REQUEST_CAPTURE]: commit };
        // A direct ModelPort consumer cannot bypass admission by ignoring the
        // private continuation. In particular, no next pull may dispatch wire I/O.
        if (!captured) throw new Error('OpenRouter request capture was not awaited');
      }
    },
  };
}
