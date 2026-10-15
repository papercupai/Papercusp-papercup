import { describe, expect, it } from 'vitest';
import {
  assertGatewayLaneCapability,
  gatewayLaneConformanceMatrix,
  gatewayProviderStatuses,
  legacyExecutorForGatewayTransport,
  makeGatewayLaneRegistry,
  makeGatewayProviderAdapters,
  providerForGatewayPath,
  providerForGatewayRequest,
  type GatewayLaneCapabilityRequest,
  type GatewayProviderId,
} from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';

const account = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-token` });
const pool = (id: string): AccountPool => {
  const active = account(id);
  return {
    active: () => active,
    onExhausted: () => null,
    select: (accountId) => (accountId === id ? active : null),
  };
};

describe('gateway provider adapters', () => {
  it('rejects a required output limit unless the concrete transport declares enforcement', () => {
    const lanes = makeGatewayLaneRegistry({ claudePool: pool('claude-a'), codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test', openaiUpstreamBase: 'https://openai.test' });
    const rows = gatewayLaneConformanceMatrix(lanes);
    for (const row of rows) {
      const required = { ...row, requireOutputTokenLimit: true };
      if (row.transport === 'bearer-http') expect(assertGatewayLaneCapability(row.lane, required).enforcesOutputTokenLimit).toBe(true);
      else expect(() => assertGatewayLaneCapability(row.lane, required)).toThrow(/output-token-limit/);
    }
    const bearer = lanes.openaiResponses.transports.find(t => t.id === 'bearer-http')!;
    delete bearer.enforcesOutputTokenLimit;
    const row = rows.find(r => r.transport === 'bearer-http')!;
    expect(() => assertGatewayLaneCapability(row.lane, { ...row, requireOutputTokenLimit: true })).toThrow(/output-token-limit/);
  });
  it('declares a static lane registry across client, protocol, upstream, and transport axes', () => {
    const lanes = makeGatewayLaneRegistry({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      codexCliAccountCount: () => 1,
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(Object.keys(lanes)).toEqual(['anthropicMessages', 'openaiResponses', 'localOpenAiChat']);
    expect(lanes.anthropicMessages).toMatchObject({
      protocol: 'anthropic-messages',
      clients: ['claude', 'omp'],
      upstreams: ['anthropic-api'],
      admissionProfile: 'claude',
      rateLimitDialect: 'anthropic-unified',
    });
    expect(lanes.openaiResponses).toMatchObject({
      protocol: 'openai-responses',
      clients: ['codex', 'omp'],
      upstreams: ['openai-api', 'chatgpt-codex'],
      admissionProfile: 'codex',
      rateLimitDialect: 'codex-windows',
    });
    // P-008 / D-028: there is no `legacyEntryExecutor` field left to assert on — the whole
    // lane-entry concept was deleted with the strangler bridge, so re-adding one to a lane no
    // longer type-checks. That is a STRUCTURAL guarantee, which is why the explicit
    // "declares no entry executor" assertions that stood here through P-011 are gone rather
    // than merely passing: the compiler now enforces what they were watching for.
    expect(lanes.openaiResponses.transports).toEqual([
      expect.objectContaining({
        id: 'bearer-http',
        streaming: true,
        nonStreaming: true,
        legacyExecutor: 'proxyOpenAi',
      }),
      expect.objectContaining({
        id: 'oauth-http',
        streaming: true,
        nonStreaming: true,
        legacyExecutor: 'serveCodexOAuthProxy',
      }),
      expect.objectContaining({
        id: 'cli-exec',
        streaming: false,
        nonStreaming: true,
        legacyExecutor: 'serveCodexCliBridge',
        degraded: true,
      }),
    ]);
    expect(lanes.localOpenAiChat).toMatchObject({
      protocol: 'openai-chat',
      upstreams: ['local-registry'],
      admissionProfile: 'local',
      retryPolicy: 'local-backend-failover',
      accountPool: null,
    });
    // The local-http TRANSPORT still names its handler; only the LANE ENTRY went away.
    expect(lanes.localOpenAiChat.transports).toEqual([
      expect.objectContaining({ id: 'local-http', legacyExecutor: 'proxyLocal' }),
    ]);
  });

  it('binds every legacy handler to a static lane or transport strategy and fails closed', () => {
    const lanes = makeGatewayLaneRegistry({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    // P-008 / D-028: the LANE-ENTRY half of this contract is gone — no lane is entered through
    // the strangler bridge any more, so `legacyEntryExecutor` and `legacyEntryRouteForGatewayLane`
    // were deleted with it. What remains under test is the TRANSPORT half, which is not
    // scaffolding: the Codex lane still resolves a chosen transport to its handler at runtime.
    expect(legacyExecutorForGatewayTransport(lanes.openaiResponses, 'oauth-http')).toBe(
      'serveCodexOAuthProxy',
    );
    expect(legacyExecutorForGatewayTransport(lanes.openaiResponses, 'cli-exec')).toBe(
      'serveCodexCliBridge',
    );
    expect(() => legacyExecutorForGatewayTransport(lanes.anthropicMessages, 'cli-exec')).toThrow(
      /does not support transport 'cli-exec'/,
    );
    // A lane with NO transports at all still fails closed on the transport lookup rather than
    // returning undefined — the fail-open regression this case has always been about.
    expect(() =>
      legacyExecutorForGatewayTransport({ ...lanes.anthropicMessages, transports: [] }, 'oauth-http'),
    ).toThrow(/does not support transport 'oauth-http'/);
  });

  it('generates an exhaustive backend/protocol/transport conformance matrix from the registry', () => {
    const lanes = makeGatewayLaneRegistry({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      codexCliAccountCount: () => 1,
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    const matrix = gatewayLaneConformanceMatrix(lanes);

    expect(matrix).toHaveLength(44);
    expect(new Set(matrix.map((row) => row.id)).size).toBe(matrix.length);
    expect(matrix.filter((row) => row.client === 'claude')).toHaveLength(6);
    expect(matrix.filter((row) => row.client === 'codex')).toHaveLength(15);
    expect(matrix.filter((row) => row.client === 'omp')).toHaveLength(23);
    expect(
      [...new Set(matrix.filter((row) => row.client === 'omp').map((row) => row.protocol))].sort(),
    ).toEqual(['anthropic-messages', 'openai-chat', 'openai-responses']);
    expect(matrix.some((row) => row.protocol === ('omp' as never))).toBe(false);

    for (const row of matrix) {
      expect(assertGatewayLaneCapability(row.lane, row).id).toBe(row.transport);
    }
    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: 'claude',
          protocol: 'anthropic-messages',
          upstream: 'anthropic-api',
          transport: 'oauth-http',
          auth: 'oauth',
        }),
        expect.objectContaining({
          client: 'codex',
          protocol: 'openai-responses',
          upstream: 'openai-api',
          transport: 'bearer-http',
          auth: 'bearer',
        }),
        expect.objectContaining({
          client: 'codex',
          upstream: 'chatgpt-codex',
          transport: 'oauth-http',
          auth: 'oauth',
        }),
        expect.objectContaining({
          client: 'codex',
          transport: 'cli-exec',
          auth: 'cli-home',
          streaming: false,
        }),
        expect.objectContaining({
          client: 'omp',
          protocol: 'openai-chat',
          upstream: 'local-registry',
          transport: 'local-http',
          auth: 'none',
        }),
      ]),
    );
  });

  it('fails closed on every unsupported capability axis instead of substituting a fallback', () => {
    const lanes = makeGatewayLaneRegistry({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    const matrix = gatewayLaneConformanceMatrix(lanes);
    const bearer = matrix.find(
      (row) => row.client === 'codex' && row.transport === 'bearer-http' && !row.streaming,
    )!;
    const cli = matrix.find((row) => row.client === 'codex' && row.transport === 'cli-exec')!;
    const local = matrix.find((row) => row.transport === 'local-http' && !row.streaming)!;
    const reject = (
      lane: typeof lanes.anthropicMessages,
      request: GatewayLaneCapabilityRequest,
      code: string,
    ) => expect(() => assertGatewayLaneCapability(lane, request)).toThrow(new RegExp(`\\[${code}\\]`));

    reject(cli.lane, { ...cli, streaming: true }, 'stream-mode');
    reject(bearer.lane, { ...bearer, auth: 'oauth' }, 'auth-mode');
    reject(bearer.lane, { ...bearer, modelDiscovery: 'upstream' }, 'model-discovery');
    reject(local.lane, { ...local, retryPolicy: 'account-failover' }, 'retry-policy');
    reject(local.lane, { ...local, accountPin: 'hard' }, 'account-pin');
    reject(bearer.lane, { ...bearer, upstream: 'anthropic-api' }, 'upstream-route');
    reject(bearer.lane, { ...bearer, protocol: 'anthropic-messages' }, 'wire-protocol');
  });

  it('declares Claude, Codex, and OMP provider contracts explicitly', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(Object.keys(adapters).sort()).toEqual(['claude', 'codex', 'omp'] satisfies GatewayProviderId[]);
    expect(adapters.claude).toMatchObject({ id: 'claude', protocol: 'anthropic', upstreamBase: 'https://anthropic.test' });
    expect(adapters.codex).toMatchObject({ id: 'codex', protocol: 'openai-compatible', upstreamBase: 'https://openai.test' });
    // OMP is multi-provider (delegates per-session to Claude or Codex) — diagnostics row, not a routing target.
    expect(adapters.omp).toMatchObject({ id: 'omp', protocol: 'multi', upstreamBase: 'https://anthropic.test' });
    expect(adapters.omp.lane).toBe(adapters.claude.lane);
    expect(adapters.codex.lane.id).toBe('openai-responses');
    expect(adapters.omp.unavailableMessage).toBeNull();
  });

  it('routes OpenAI-compatible responses to Codex and leaves other /v1 paths on Claude', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(providerForGatewayPath('/v1/responses', adapters).id).toBe('codex');
    expect(providerForGatewayPath('/v1/responses?stream=false', adapters).id).toBe('codex');
    expect(providerForGatewayPath('/v1/messages', adapters).id).toBe('claude');
    expect(providerForGatewayPath('/v1/count_tokens', adapters).id).toBe('claude');
  });

  it('routes /v1/models to Codex only when the request is pinned to a Codex account', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(providerForGatewayRequest('/v1/models', { 'x-papercusp-account': 'codex-a' }, adapters)).toBe(adapters.codex);
    expect(providerForGatewayRequest('/v1/models?limit=1', { 'x-papercusp-account': 'claude-a' }, adapters)).toBe(adapters.claude);
    expect(providerForGatewayRequest('/v1/models', {}, adapters)).toBe(adapters.claude);
  });

  it('WI-3651: routes an UNPINNED /v1/models probe to Codex when the codex CLI self-identifies via its own headers', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    // No x-papercusp-account pin at all (WI-3645 auto-routing) -- disambiguate by the headers
    // the codex CLI stamps on every request instead of defaulting to Claude.
    expect(providerForGatewayRequest('/v1/models', { originator: 'codex_cli_rs' }, adapters)).toBe(adapters.codex);
    expect(providerForGatewayRequest('/v1/models', { 'openai-beta': 'responses=experimental' }, adapters)).toBe(adapters.codex);
    // Case/array-header handling reuses headerValue's existing normalization.
    expect(providerForGatewayRequest('/v1/models', { originator: ['codex_cli_rs'] }, adapters)).toBe(adapters.codex);
    // A genuinely ambiguous probe (neither pin nor codex-identifying header) still defaults Claude.
    expect(providerForGatewayRequest('/v1/models', { originator: 'something-else' }, adapters)).toBe(adapters.claude);
    // Works even with NO codex bearer pool at all (all-CLI codex deployment, WI-3068) -- pure
    // header sniffing, no pool lookup required.
    const cliOnlyAdapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexCliAccountCount: () => 1,
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    expect(providerForGatewayRequest('/v1/models', { originator: 'codex_cli_rs' }, cliOnlyAdapters)).toBe(cliOnlyAdapters.codex);
  });

  it('keeps Codex present but unavailable when no Codex account pool is configured', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(adapters.codex.pool).toBeNull();
    expect(adapters.codex.unavailableMessage).toMatch(/no Codex account pool/i);
  });

  it('summarizes provider routeability for gateway diagnostics', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(gatewayProviderStatuses(adapters)).toEqual([
      expect.objectContaining({ id: 'claude', configured: true, protocol: 'anthropic', laneId: 'anthropic-messages' }),
      expect.objectContaining({ id: 'codex', configured: false, protocol: 'openai-compatible', laneId: 'openai-responses', unavailableMessage: expect.stringMatching(/no Codex account pool/i) }),
      expect.objectContaining({ id: 'omp', configured: true, protocol: 'multi', laneId: 'anthropic-messages' }),
    ]);
  });

  it('EI-21891944321682303: labels OMP as multi-provider, not Claude/Anthropic-only', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });

    expect(adapters.omp.protocol).toBe('multi');
    expect(adapters.omp.label).not.toMatch(/via claude/i);
    const omp = gatewayProviderStatuses(adapters).find((s) => s.id === 'omp')!;
    expect(omp.protocol).toBe('multi');
  });

  it('reports codex configured:true (with its openai upstreamBase) once a Codex pool is present', () => {
    // The existing diagnostics test only covers codex WITHOUT a pool (configured:false); pin the
    // true-branch so a working codex provider is reported routeable.
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    const codex = gatewayProviderStatuses(adapters).find((s) => s.id === 'codex')!;
    expect(codex.configured).toBe(true);
    expect(codex.upstreamBase).toBe('https://openai.test');
  });

  it('counts codex CLI-bridge accounts toward configured when the bearer pool is absent (WI-3068)', () => {
    // ChatGPT-subscription codex accounts have NO API bearer, so the bearer codexPool is
    // empty BY DESIGN — the diagnostics must not report a working all-CLI deployment as
    // "not configured" with the misleading unavailableMessage.
    let cli = 1;
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexCliAccountCount: () => cli,
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    expect(adapters.codex.pool).toBeNull();
    const codex = () => gatewayProviderStatuses(adapters).find((s) => s.id === 'codex')!;
    expect(codex()).toMatchObject({ configured: true, cliAccountCount: 1, unavailableMessage: null });
    // the count is a live GETTER: a hot-reload that removes the last CLI account flips the
    // status back to unconfigured (+ the fallback message) on the very next diagnostics read
    cli = 0;
    expect(codex()).toMatchObject({ configured: false, cliAccountCount: 0, unavailableMessage: expect.stringMatching(/no Codex account pool/i) });
  });

  it('providerForGatewayPath returns the actual adapter object and matches by PREFIX, not substring', () => {
    const adapters = makeGatewayProviderAdapters({
      claudePool: pool('claude-a'),
      codexPool: pool('codex-a'),
      anthropicUpstreamBase: 'https://anthropic.test',
      openaiUpstreamBase: 'https://openai.test',
    });
    // Exact adapter identity (not just id) so the caller gets the right pool + upstreamBase.
    expect(providerForGatewayPath('/v1/responses', adapters)).toBe(adapters.codex);
    expect(providerForGatewayPath('/v1/messages', adapters)).toBe(adapters.claude);
    // A path that only CONTAINS 'responses' but does not START with /v1/responses stays on Claude.
    expect(providerForGatewayPath('/v1/messages/responses', adapters).id).toBe('claude');
    expect(providerForGatewayPath('/responses', adapters).id).toBe('claude');
  });
});
