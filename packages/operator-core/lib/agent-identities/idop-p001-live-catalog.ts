import { createHash } from 'node:crypto';
import { parse as parseToml } from '@iarna/toml';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentMcpConnectionError, connectAgentMcp, type AgentMcpClientOptions } from '../agent-mcp-client';
import { listAllTools } from '../../../../apps/operator/scripts/ptool.mjs';
import { isSuTierRole } from '../su-tier-roles.mjs';

type Connector = (options: AgentMcpClientOptions) => Promise<{
  client: Pick<Client, 'listTools' | 'close'>;
  transportKind: 'http' | 'uds';
}>;
type Server = { url?: string; http_headers?: Record<string, string>; bearer_token_env_var?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Read the launching caller's configuration, never construct a superuser or asRole URL. */
export async function captureIdopLiveCatalog(
  configText: string,
  env: NodeJS.ProcessEnv,
  connect: Connector = connectAgentMcp,
) {
  let config: { mcp_servers?: Record<string, Server> };
  try { config = parseToml(configText) as unknown as typeof config; }
  catch { throw new Error('Invalid caller MCP configuration'); }
  const candidates = ['papercusp', 'papercusp-su'].filter(key => config.mcp_servers?.[key]);
  if (candidates.length !== 1) throw new Error('Expected one caller Papercusp MCP server');
  const server = config.mcp_servers![candidates[0]];
  if (!server.url) throw new Error('Caller MCP server has no HTTP URL');
  let url: URL;
  try { url = new URL(server.url); }
  catch { throw new Error('Invalid caller MCP URL'); }
  const ownerId = env.PAPERCUSP_SID?.trim();
  const nativeSessionId = env.PAPERCUSP_NATIVE_SESSION_ID?.trim() || env.CODEX_SESSION_ID?.trim();
  if (!ownerId || !nativeSessionId) throw new Error('Missing actual caller session attribution');
  if (url.searchParams.getAll('client').length !== 1 || url.searchParams.get('client') !== ownerId)
    throw new Error('Caller MCP client mismatch');
  const configuredRole = url.searchParams.get('role');
  const actualRole = env.PAPERCUSP_AGENT_ROLE || env.PAPERCUSP_ROLE;
  if (env.PAPERCUSP_AGENT_ROLE && env.PAPERCUSP_ROLE && env.PAPERCUSP_AGENT_ROLE !== env.PAPERCUSP_ROLE)
    throw new Error('Caller MCP role mismatch');
  const globalSu = candidates[0] === 'papercusp-su' && !url.searchParams.has('role') &&
    url.searchParams.getAll('superuser').length === 1 && url.searchParams.get('superuser') === '1';
  if (!globalSu && (!configuredRole || url.searchParams.getAll('role').length !== 1 ||
      configuredRole !== actualRole || url.searchParams.has('superuser')))
    throw new Error('Caller MCP role mismatch');
  if (globalSu && actualRole && actualRole !== 'su' && !isSuTierRole(actualRole))
    throw new Error('Role caller requires its launcher role endpoint');
  const configuredHarness = url.searchParams.get('harness');
  if (!env.PAPERCUSP_WORKSPACE || url.searchParams.getAll('workspace').length !== 1 ||
      url.searchParams.get('workspace') !== env.PAPERCUSP_WORKSPACE)
    throw new Error('Caller MCP scope mismatch');
  // bootstrap-su intentionally uses a workspace-wide MCP endpoint, even when
  // the process launched in a harness. Observe that unchanged scope, not a
  // manufactured harness/role URL. Fresh SU launches need not export a role;
  // do not invent a nominal specialization from its absence (join launch proof).
  if ((!globalSu || url.searchParams.has('harness')) && (!env.PAPERCUSP_HARNESS_SLUG ||
      url.searchParams.getAll('harness').length !== 1 || configuredHarness !== env.PAPERCUSP_HARNESS_SLUG))
    throw new Error('Caller MCP scope mismatch');
  const configuredNative = url.searchParams.get('native_session');
  if (url.searchParams.has('native_session') && (url.searchParams.getAll('native_session').length !== 1 ||
      configuredNative !== nativeSessionId)) throw new Error('Caller MCP native session mismatch');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Unsupported caller MCP endpoint');
  const headers = { ...server.http_headers };
  if (Object.values(headers).some(value => typeof value !== 'string' || value.startsWith('!')))
    throw new Error('Caller MCP headers require unsupported evaluation');
  if (server.bearer_token_env_var) {
    const token = env[server.bearer_token_env_var];
    if (!token) throw new Error('Missing caller MCP bearer environment');
    if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization'))
      throw new Error('Ambiguous caller MCP authorization');
    headers.Authorization = `Bearer ${token}`;
  }
  const secrets = [server.url, ...url.searchParams.values(), ...Object.values(headers),
    ...Object.values(headers).map(value => value.replace(/^Bearer\s+/i, ''))]
    .filter(value => value.length >= 8).sort((a, b) => b.length - a.length);
  const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  const pages: Array<{ capturedAt: string; request: { cursor?: string }; result: ListToolsResult }> = [];
  const startedAt = new Date().toISOString();
  let connection: Awaited<ReturnType<Connector>> | undefined;
  let catalog: Awaited<ReturnType<typeof listAllTools>> = [];
  let failure: { stage: string; message: string; diagnostic?: AgentMcpConnectionError['diagnostic'] } | null = null;
  let stage = 'connect';
  try {
    // Preserve the signed URL and credentials byte-for-byte. No coordination reads,
    // fallback token, role override, or native-session retry occurs in this instrument.
    connection = await connect({ url: server.url, headers, mode: 'http', timeoutMs: 30_000,
      name: 'idop-p001-actual-caller-catalog' });
    stage = 'tools/list';
    const seenCursors = new Set<string>();
    catalog = await listAllTools({ listTools: async (params, options) => {
      const cursor = params?.cursor ?? '';
      if (seenCursors.has(cursor)) throw new Error('Repeated catalog cursor');
      seenCursors.add(cursor);
      const result = await connection!.client.listTools(params, options);
      pages.push({ capturedAt: new Date().toISOString(), request: { ...params }, result });
      const markers = result as Record<string, unknown>;
      if (markers._partial || markers._projection || !Array.isArray(result.tools))
        throw new Error('Incomplete catalog page');
      return result;
    } }, { timeoutMs: 30_000, totalTimeoutMs: 90_000 });
    const names = new Set<string>();
    for (const tool of catalog) {
      if (!tool.name || !tool.inputSchema || names.has(tool.name)) throw new Error('Invalid or duplicate catalog tool');
      names.add(tool.name);
    }
  } catch (error) {
    failure = { stage, message: redact(error instanceof Error ? error.message : String(error)),
      ...(error instanceof AgentMcpConnectionError ? { diagnostic: error.diagnostic } : {}) };
  } finally {
    if (connection) {
      try { await connection.client.close(); }
      catch { failure ??= { stage: 'close', message: 'MCP close failed' }; }
    }
  }
  return {
    schemaVersion: 1, kind: 'actual-caller-sdk-catalog', startedAt, completedAt: new Date().toISOString(),
    caller: { ownerId, nativeSessionId, configuredRole, configuredHarness, reportedRole: actualRole ?? null,
      endpointTier: globalSu ? 'global-su' : 'role', launchHarness: env.PAPERCUSP_HARNESS_SLUG ?? null,
      workspace: env.PAPERCUSP_WORKSPACE,
      harness: env.PAPERCUSP_HARNESS_SLUG, configSha256: hash(configText), endpointSha256: hash(server.url),
      endpointOrigin: url.origin, endpointPath: url.pathname },
    transportKind: connection?.transportKind ?? null, complete: failure === null, failure, pages,
    toolCount: failure ? null : catalog.length,
    limits: ['SDK-decoded tools/list pages, not raw HTTP wire bytes or a native model tool-list frame.',
      'Caller configuration and launch attribution require independent native/launch receipt verification.',
      'Input schemas do not prove effective argument authorization; full P-001 and historical acceptance remain open.'],
  };
}
