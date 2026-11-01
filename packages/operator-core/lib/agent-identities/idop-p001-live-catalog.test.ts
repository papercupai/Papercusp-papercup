import { describe, expect, it, vi } from 'vitest';
import { captureIdopLiveCatalog } from './idop-p001-live-catalog';
import { AgentMcpConnectionError } from '../agent-mcp-client';

const env = { PAPERCUSP_SID: 'su-fixture', PAPERCUSP_NATIVE_SESSION_ID: 'native-fixture',
  PAPERCUSP_WORKSPACE: 'fixture', PAPERCUSP_HARNESS_SLUG: 'fixture', PAPERCUSP_AGENT_ROLE: 'architect', TOKEN: 'fixture-secret-token' };
const endpoint = 'http://127.0.0.1:9171/api/mcp?client=su-fixture&workspace=fixture&harness=fixture&role=architect&sig=fixture-secret-signature';
const config = (url = endpoint) => `[mcp_servers.papercusp]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "TOKEN"\n`;
const suEndpoint = 'http://127.0.0.1:9171/api/mcp?client=su-fixture&workspace=fixture&superuser=1';
const suConfig = (url = suEndpoint) => config(url).replace('mcp_servers.papercusp]', 'mcp_servers.papercusp-su]');
const tool = (name: string) => ({ name, description: 'unchanged description', inputSchema: {
  type: 'object' as const, properties: { scope: { type: 'string', enum: ['self'] } }, required: ['scope'], additionalProperties: false },
  annotations: { readOnlyHint: true } });
function connector(pages: object[]) {
  const listTools = vi.fn();
  for (const page of pages) listTools.mockResolvedValueOnce(page);
  const close = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ client: { listTools, close }, transportKind: 'http' as const });
  return { connect, listTools, close };
}

describe('P-001 actual caller raw catalog instrument', () => {
  it('uses the unchanged signed role endpoint and retains schemas and terminal pagination', async () => {
    const c = connector([{ tools: [tool('fixture:one')], nextCursor: 'next' }, { tools: [tool('fixture:two')] }]);
    const result = await captureIdopLiveCatalog(config(), env, c.connect);
    expect(c.connect.mock.calls[0][0]).toMatchObject({ url: endpoint, headers: { Authorization: `Bearer ${env.TOKEN}` } });
    expect(c.listTools.mock.calls.map(call => call[0])).toEqual([{}, { cursor: 'next' }]);
    expect(result).toMatchObject({ complete: true, toolCount: 2, failure: null });
    expect(result.pages.map(page => page.result.tools)).toEqual([[tool('fixture:one')], [tool('fixture:two')]]);
    expect(c.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it.each([
    ['client', endpoint.replace('client=su-fixture', 'client=su-foreign')],
    ['role', endpoint.replace('role=architect', 'role=judge')],
    ['role elevation', endpoint + '&superuser=1'],
    ['scope', endpoint.replace('workspace=fixture', 'workspace=other')],
    ['native session', endpoint + '&native_session=foreign'],
  ])('refuses a %s mismatch before opening a connection', async (message, url) => {
    const c = connector([]);
    await expect(captureIdopLiveCatalog(config(url), env, c.connect)).rejects.toThrow(message.replace(' elevation', '') + ' mismatch');
    expect(c.connect).not.toHaveBeenCalled();
  });
  it('preserves earlier pages and redacts a later refusal without claiming completeness', async () => {
    const c = connector([{ tools: [tool('fixture:one')], nextCursor: 'next' }]);
    c.listTools.mockRejectedValueOnce(new Error(`refused ${endpoint} ${env.TOKEN}`));
    const result = await captureIdopLiveCatalog(config(), env, c.connect);
    expect(result).toMatchObject({ complete: false, toolCount: null, failure: { stage: 'tools/list', message: 'refused [redacted] [redacted]' } });
    expect(result.pages).toHaveLength(1);
    expect(c.close).toHaveBeenCalledOnce();
  });
  it.each([
    ['partial', { tools: [tool('fixture:one')], _partial: true }, 'Incomplete'],
    ['duplicate', { tools: [tool('fixture:one'), tool('fixture:one')] }, 'duplicate'],
  ])('retains %s pages but refuses their coverage', async (_label, page, message) => {
    const c = connector([page]);
    const result = await captureIdopLiveCatalog(config(), env, c.connect);
    expect(result.complete).toBe(false);
    expect(result.failure?.message).toContain(message);
    expect(result.toolCount).toBeNull();
    expect(result.pages[0].result).toEqual(page);
  });
  it('bounds a repeated cursor without repeatedly reading the server', async () => {
    const c = connector([{ tools: [], nextCursor: 'again' }, { tools: [], nextCursor: 'again' }]);
    const result = await captureIdopLiveCatalog(config(), env, c.connect);
    expect(result.failure?.message).toBe('Repeated catalog cursor');
    expect(c.listTools).toHaveBeenCalledTimes(2);
  });
  it('refuses conflicting legacy and launcher role attribution before connecting', async () => {
    const c = connector([]);
    await expect(captureIdopLiveCatalog(config(), { ...env, PAPERCUSP_ROLE: 'su' }, c.connect)).rejects.toThrow('role mismatch');
    expect(c.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, 'su', 'planner'])('observes an unchanged global SU endpoint with reported role %s', async (role) => {
    const c = connector([{ tools: [tool('fixture:one')] }]);
    const result = await captureIdopLiveCatalog(suConfig(), { ...env, PAPERCUSP_AGENT_ROLE: role }, c.connect);
    expect(c.connect.mock.calls[0][0].url).toBe(suEndpoint);
    expect(result).toMatchObject({ complete: true, toolCount: 1, caller: {
      configuredRole: null, configuredHarness: null, reportedRole: role ?? null,
      endpointTier: 'global-su', launchHarness: 'fixture', workspace: 'fixture',
    } });
    expect(c.close).toHaveBeenCalledOnce();
  });
  it('preserves a matching explicitly configured SU harness without confusing it with launch scope', async () => {
    const c = connector([{ tools: [] }]);
    const result = await captureIdopLiveCatalog(suConfig(suEndpoint + '&harness=fixture'),
      { ...env, PAPERCUSP_AGENT_ROLE: 'planner' }, c.connect);
    expect(result.caller).toMatchObject({ configuredHarness: 'fixture', launchHarness: 'fixture' });
    expect(result.complete).toBe(true);
  });
  it.each([
    ['foreign client', suEndpoint.replace('client=su-fixture', 'client=foreign'), 'planner', 'client mismatch'],
    ['foreign workspace', suEndpoint.replace('workspace=fixture', 'workspace=foreign'), 'planner', 'scope mismatch'],
    ['missing workspace', suEndpoint.replace('&workspace=fixture', ''), 'planner', 'scope mismatch'],
    ['foreign harness', suEndpoint + '&harness=foreign', 'planner', 'scope mismatch'],
    ['duplicate harness', suEndpoint + '&harness=fixture&harness=fixture', 'planner', 'scope mismatch'],
    ['ordinary role', suEndpoint, 'architect', 'role endpoint'],
    ['unknown role', suEndpoint, 'not-a-registered-su-tier-role', 'role endpoint'],
    ['duplicate superuser', suEndpoint + '&superuser=1', 'planner', 'role mismatch'],
    ['disabled superuser', suEndpoint.replace('superuser=1', 'superuser=0'), 'planner', 'role mismatch'],
    ['absent superuser', suEndpoint.replace('&superuser=1', ''), 'planner', 'role mismatch'],
    ['role query', suEndpoint + '&role=planner', 'planner', 'role mismatch'],
    ['empty role query', suEndpoint + '&role=', 'planner', 'role mismatch'],
    ['duplicate native', suEndpoint + '&native_session=native-fixture&native_session=native-fixture', 'planner', 'native session mismatch'],
  ])('rejects global SU %s before connecting', async (_label, url, role, message) => {
    const c = connector([]);
    await expect(captureIdopLiveCatalog(suConfig(url), { ...env, PAPERCUSP_AGENT_ROLE: role }, c.connect))
      .rejects.toThrow(message);
    expect(c.connect).not.toHaveBeenCalled();
  });
  it('does not admit a global SU URL through an ordinary role server entry', async () => {
    const c = connector([]);
    await expect(captureIdopLiveCatalog(config(suEndpoint), { ...env, PAPERCUSP_AGENT_ROLE: 'planner' }, c.connect))
      .rejects.toThrow('role mismatch');
    expect(c.connect).not.toHaveBeenCalled();
  });
  it('still requires the ordinary role caller harness', async () => {
    const c = connector([]);
    await expect(captureIdopLiveCatalog(config(endpoint.replace('&harness=fixture', '')), env, c.connect))
      .rejects.toThrow('scope mismatch');
    expect(c.connect).not.toHaveBeenCalled();
  });
  it('retains allowlisted connection diagnosis without secrets or catalog coverage', async () => {
    const c = connector([]);
    c.connect.mockRejectedValueOnce(new AgentMcpConnectionError('http',
      Object.assign(new Error(`failed ${endpoint} ${env.TOKEN}`), { cause: { code: 'ECONNREFUSED' } })));
    const result = await captureIdopLiveCatalog(config(), env, c.connect);
    expect(result).toMatchObject({ complete: false, toolCount: null, pages: [], failure: {
      stage: 'connect', message: 'http_connection_failed', diagnostic: { category: 'network', systemCode: 'ECONNREFUSED' },
    } });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(c.connect).toHaveBeenCalledOnce();
    expect(c.close).not.toHaveBeenCalled();
  });
});
