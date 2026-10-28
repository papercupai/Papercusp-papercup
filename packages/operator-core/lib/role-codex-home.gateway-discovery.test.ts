/**
 * Integration: the su CODEX_HOME that PSU gets for a gateway-routed Codex session
 * must make Codex read `/model` from the Papercusp gateway catalog
 * (plan codex-gateway-live-model-catalog-2026-09-22, R-6 / D-001).
 *
 * This crosses the real boundary Codex sees, end to end: the operator-side writers
 * PSU launches through (`writeSuCodexHome` for a fresh session,
 * `ensureSuCodexHomeConfig` for the resume/repair leg that psu's
 * ensureCodexHomeViaOperator calls) render with the orchestrator's
 * `codexGatewayConfigToml` + `codexManagedFeaturesToml`, write `config.toml` to a
 * real directory, and the file is then parsed with a real TOML parser.
 *
 * Parsing is the point. The unit tests in codex-gateway-config.test.ts check that
 * the generator EMITS the lines; they cannot see a line that lands in the wrong
 * table (`api_key_model_discovery` outside `[features]`, `model_catalog_url`
 * outside the provider table) or a duplicated table that makes Codex reject the
 * whole file. Any of those leaves Codex inferring the catalog from the inference
 * `base_url` — the regression where PSU `--account=auto` sessions could run
 * GPT-6 but never offered it in `/model`.
 */
import * as TOML from '@iarna/toml';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// writeSuCodexHome resolves ~/.papercusp/su-codex-homes via os.homedir(), which on
// Linux reads the password DB rather than $HOME — redirect it to a throwaway dir.
const homeHolder = { home: '' };
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.home };
});

const MODEL = 'gpt-5.6-sol:xhigh';
const MCP_URL = 'http://127.0.0.1:3070/api/mcp?superuser=1&workspace=default';
// A non-default port proves the catalog URL is derived from the gateway the
// session routes to, not a hard-coded :8788.
const GATEWAY_PORT = '9876';
const GATEWAY_ORIGIN = `http://127.0.0.1:${GATEWAY_PORT}`;
const PROVIDER_ID = 'papercusp-codex-gateway';

const originalPort = process.env.PAPERCUSP_GATEWAY_PORT;

beforeEach(() => {
  homeHolder.home = mkdtempSync(join(tmpdir(), 'codex-gateway-discovery-'));
  process.env.PAPERCUSP_GATEWAY_PORT = GATEWAY_PORT;
  vi.resetModules();
});

afterEach(() => {
  if (homeHolder.home) rmSync(homeHolder.home, { recursive: true, force: true });
  if (originalPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = originalPort;
});

type ParsedConfig = {
  mcp_servers?: Record<string, { http_headers?: Record<string, string> }>;
  model_provider?: string;
  features?: Record<string, unknown>;
  model_providers?: Record<string, { base_url?: string; model_catalog_url?: string; requires_openai_auth?: boolean; http_headers?: Record<string, string> }>;
};

/** Parse the file exactly as written to disk; a TOML error fails the test. */
function parseConfig(configPath: string): ParsedConfig {
  return TOML.parse(readFileSync(configPath, 'utf8')) as ParsedConfig;
}

it('publishes distinct runtime possession only in local private provider and MCP headers', async () => {
  const { writeSuCodexHome, suCodexConfigToml } = await import('./role-codex-home');
  const nativeRuntimeBearer = 'n'.repeat(43);
  const written = writeSuCodexHome({ sessionKey: 'native-private', mcpUrl: MCP_URL,
    sid: 'su-native-private', model: MODEL, promptText: 'prompt', codexGatewayAuto: true, nativeRuntimeBearer });
  const config = parseConfig(written.configPath);
  expect(config.model_providers?.[PROVIDER_ID]?.http_headers?.['x-papercusp-native-runtime']).toBe(nativeRuntimeBearer);
  expect(config.mcp_servers?.['papercusp-su']?.http_headers?.['x-papercusp-native-runtime']).toBe(nativeRuntimeBearer);
  expect(statSync(written.configPath).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(written)).not.toContain(nativeRuntimeBearer);
  expect(readFileSync(written.agentsPath, 'utf8')).not.toContain(nativeRuntimeBearer);
  expect(readFileSync(join(written.codexHome, 'papercusp-diagnostics.json'), 'utf8')).not.toContain(nativeRuntimeBearer);
  expect(() => suCodexConfigToml({ mcpUrl: 'https://external.invalid/mcp', sid: 'su-private', nativeRuntimeBearer }))
    .toThrow('native_runtime_delivery_denied');
  expect(() => suCodexConfigToml({ mcpUrl: MCP_URL, sid: 'su-private', nativeRuntimeBearer: 'bad\nheader' }))
    .toThrow('native_runtime_delivery_denied');
});

it.each([true, false])('repair removes unreissued possession on gateway=%s and accepts only an explicitly supplied replacement', async (codexGatewayAuto) => {
  const { writeSuCodexHome, ensureSuCodexHomeConfig } = await import('./role-codex-home');
  const base = { sessionKey: 'native-repair', mcpUrl: MCP_URL, sid: 'su-native-repair', model: MODEL, codexGatewayAuto };
  const written = writeSuCodexHome({ ...base, promptText: 'prompt', nativeRuntimeBearer: 'n'.repeat(43) });
  const repaired = ensureSuCodexHomeConfig(base);
  expect(repaired.repaired).toBe(true);
  expect(readFileSync(written.configPath, 'utf8')).not.toContain('n'.repeat(43));
  const replacement = { ...base, nativeRuntimeBearer: 'r'.repeat(43) };
  expect(ensureSuCodexHomeConfig(replacement).repaired).toBe(true);
  expect(parseConfig(written.configPath).mcp_servers?.['papercusp-su']?.http_headers?.['x-papercusp-native-runtime'])
    .toBe(replacement.nativeRuntimeBearer);
  expect(ensureSuCodexHomeConfig(replacement).repaired).toBe(false);
  expect(statSync(written.configPath).mode & 0o777).toBe(0o600);
});

/** The three D-001 discovery settings, asserted on the PARSED structure. */
function expectGatewayCatalogDiscovery(config: ParsedConfig) {
  // 1. Codex only consults a custom provider's catalog URL with this feature on.
  expect(config.features?.api_key_model_discovery).toBe(true);
  // The session actually selects the gateway provider the catalog URL lives on.
  expect(config.model_provider).toBe(PROVIDER_ID);
  const provider = config.model_providers?.[PROVIDER_ID];
  expect(provider).toBeDefined();
  // Ambient auth.json is retained for direct-route/plugin use, not gateway auth.
  expect(provider?.requires_openai_auth).toBe(false);
  // 2. The catalog is the gateway's full /v1/models URL on the same gateway as inference.
  expect(provider?.base_url).toBe(`${GATEWAY_ORIGIN}/v1`);
  expect(provider?.model_catalog_url).toBe(`${GATEWAY_ORIGIN}/v1/models`);
  expect(new URL(provider!.model_catalog_url!).origin).toBe(new URL(provider!.base_url!).origin);
  // 3. The catalog request identifies itself as Codex, so an unpinned auto request is
  //    answered with the Codex catalog shape rather than Claude's.
  expect(provider?.http_headers?.originator).toBe('codex_cli_rs');
  return provider!;
}

describe('PSU su CODEX_HOME routes Codex model discovery to the gateway catalog (R-6)', () => {
  it('fresh auto-routed su home: parsed config.toml enables discovery, points the catalog at the gateway, and stamps the Codex originator', async () => {
    const { writeSuCodexHome } = await import('./role-codex-home');
    const home = writeSuCodexHome({
      sessionKey: 'discovery-auto',
      mcpUrl: MCP_URL,
      promptText: 'P',
      sid: 'su-discovery-auto',
      model: MODEL,
      codexGatewayAuto: true,
      codexGatewayPriority: 'su',
    });
    const provider = expectGatewayCatalogDiscovery(parseConfig(home.configPath));
    // Unpinned: the gateway picks the account, so no pin header may be sent.
    expect(provider.http_headers?.['x-papercusp-account']).toBeUndefined();
    expect(provider.http_headers?.['x-papercusp-owner']).toBe('su-discovery-auto');
  });

  it('fresh account-pinned su home: the same discovery wiring, carrying the pinned account', async () => {
    const { writeSuCodexHome } = await import('./role-codex-home');
    const home = writeSuCodexHome({
      sessionKey: 'discovery-pinned',
      mcpUrl: MCP_URL,
      promptText: 'P',
      sid: 'su-discovery-pinned',
      model: MODEL,
      codexGatewayAccountId: 'chatgpt-a',
    });
    const provider = expectGatewayCatalogDiscovery(parseConfig(home.configPath));
    expect(provider.http_headers?.['x-papercusp-account']).toBe('chatgpt-a');
  });

  it('resume leg: repairing a home written for the direct route onto the auto route yields the same parsed discovery wiring', async () => {
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await import('./role-codex-home');
    const direct = writeSuCodexHome({
      sessionKey: 'discovery-resume',
      mcpUrl: MCP_URL,
      promptText: 'P',
      sid: 'su-discovery-resume',
      model: MODEL,
    });
    // Precondition: the direct-route home has no gateway provider to discover from.
    const before = parseConfig(direct.configPath);
    expect(before.model_provider).toBeUndefined();
    expect(before.model_providers?.[PROVIDER_ID]).toBeUndefined();
    // A rollout the resume must not lose.
    const rollout = join(direct.codexHome, 'rollout-keep.jsonl');
    writeFileSync(rollout, '{"payload":{}}\n');

    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'discovery-resume',
      mcpUrl: MCP_URL,
      sid: 'su-discovery-resume',
      model: MODEL,
      codexGatewayAuto: true,
      codexGatewayPriority: 'su',
    });
    expect(repaired.repaired).toBe(true);
    expectGatewayCatalogDiscovery(parseConfig(repaired.configPath));
    expect(readFileSync(rollout, 'utf8')).toBe('{"payload":{}}\n');
  });

  it('control: a su home on the direct route gets no gateway provider, so Codex keeps its native catalog', async () => {
    const { writeSuCodexHome } = await import('./role-codex-home');
    const home = writeSuCodexHome({
      sessionKey: 'discovery-direct',
      mcpUrl: MCP_URL,
      promptText: 'P',
      sid: 'su-discovery-direct',
      model: MODEL,
    });
    const config = parseConfig(home.configPath);
    expect(config.model_provider).toBeUndefined();
    expect(config.model_providers?.[PROVIDER_ID]).toBeUndefined();
  });
});
