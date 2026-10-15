/**
 * converse-toolset — the host-TRUST-keyed tool surface + MCP mount
 * (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §2/§3;
 * PARITY op-tool-working-set / op-delegate-deep). Pure; the operator working
 * set is mocked narrow so the assertions read literally.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../operator-mcp-tools', () => ({
  ALL_AGENT_MCP_TOOLS: ['mcp__agentmcp__harness:status', 'mcp__agentmcp__chat:ask_choice', 'mcp__agentmcp__scorecards:list'],
  INTERACTIVE_CHAT_TOOLS: ['mcp__agentmcp__chat:ask_choice'],
}));

import { buildConverseMcpMount, DELEGATE_DEEP_TOOL, PUBLIC_MANUAL_TOOLS, selectConverseTools } from '../converse-toolset';

const doors = () => ['capability:read', 'capability:fetch', 'tasks:ops'];

describe('selectConverseTools', () => {
  it('owner trust: the operator role keeps today\'s curated working set, unchanged', () => {
    expect(selectConverseTools({ role: 'operator', hostTrust: 'owner', publicDoorNames: doors })).toEqual([
      'mcp__agentmcp__harness:status',
      'mcp__agentmcp__chat:ask_choice',
      'mcp__agentmcp__scorecards:list',
    ]);
  });

  it('owner trust: the papercup role = the working set + voice:delegate_deep (D-007 §3)', () => {
    expect(selectConverseTools({ role: 'papercup', hostTrust: 'owner', publicDoorNames: doors })).toEqual([
      'mcp__agentmcp__harness:status',
      'mcp__agentmcp__chat:ask_choice',
      'mcp__agentmcp__scorecards:list',
      DELEGATE_DEEP_TOOL,
      ...PUBLIC_MANUAL_TOOLS,
    ]);
  });

  it('public trust: the OWNED-loop doors + the card tool + delegate_deep — never the owner working set', () => {
    const pub = selectConverseTools({ role: 'papercup', hostTrust: 'public', publicDoorNames: doors });
    expect(pub).toEqual([
      'mcp__agentmcp__capability:read',
      'mcp__agentmcp__capability:fetch',
      'mcp__agentmcp__tasks:ops',
      'mcp__agentmcp__chat:ask_choice',
      DELEGATE_DEEP_TOOL,
      ...PUBLIC_MANUAL_TOOLS,
    ]);
    expect(pub).not.toContain('mcp__agentmcp__harness:status');
    // The door list is only consulted on public trust.
    const spy = vi.fn(doors);
    selectConverseTools({ role: 'papercup', hostTrust: 'owner', publicDoorNames: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('owner trust running as the hosted customer gets only the customer-safe tool surface', () => {
    expect(selectConverseTools({
      role: 'papercup',
      hostTrust: 'owner',
      agentRunsAsCustomer: true,
      publicDoorNames: doors,
    })).toEqual([
      'mcp__agentmcp__capability:read',
      'mcp__agentmcp__capability:fetch',
      'mcp__agentmcp__tasks:ops',
      'mcp__agentmcp__chat:ask_choice',
      DELEGATE_DEEP_TOOL,
      ...PUBLIC_MANUAL_TOOLS,
    ]);
  });
});

describe('buildConverseMcpMount', () => {
  it('voice slim narrows the owner catalog and actual mount; standard differs only in analytical tools', () => {
    const input = {
      role: 'papercup', hostTrust: 'owner' as const, publicDoorNames: doors,
      modality: 'voice' as const, supportsVoice: (name: string) => name !== 'chat:ask_choice',
    };
    const slim = selectConverseTools(input);
    const standard = selectConverseTools({ ...input, voiceProfile: 'standard' });
    expect(slim).toEqual(['mcp__agentmcp__harness:status', DELEGATE_DEEP_TOOL, ...PUBLIC_MANUAL_TOOLS]);
    expect(standard).toContain('mcp__agentmcp__scorecards:list');
    expect(standard).not.toContain('mcp__agentmcp__chat:ask_choice');
    const mount = buildConverseMcpMount({ hostTrust: 'owner', baseUrl: 'http://localhost', workspaceId: 'ws', tools: slim, uiClientId: null, superuserToken: 'owner-token', principalToken: null });
    expect(new URL(mount!.url).searchParams.get('tools')?.split(',')).toEqual(slim.map(name => name.replace('mcp__agentmcp__', '')));
  });

  it.each(['slim', 'standard'] as const)('voice %s never adds owner tools to a public or customer-run turn', (voiceProfile) => {
    const input = { role: 'papercup', publicDoorNames: doors, modality: 'voice' as const, voiceProfile, supportsVoice: (name: string) => name !== 'chat:ask_choice' };
    const pub = selectConverseTools({ ...input, hostTrust: 'public' });
    expect(pub).toEqual(['mcp__agentmcp__capability:read', 'mcp__agentmcp__capability:fetch', 'mcp__agentmcp__tasks:ops', DELEGATE_DEEP_TOOL, ...PUBLIC_MANUAL_TOOLS]);
    expect(selectConverseTools({ ...input, hostTrust: 'owner', agentRunsAsCustomer: true })).toEqual(pub);
  });

  const base = {
    baseUrl: 'http://localhost:3070',
    workspaceId: 'ws with space',
    tools: ['mcp__agentmcp__harness:status', 'mcp__agentmcp__chat:ask_choice'] as const,
    uiClientId: 'abcdef0123456789',
  };

  it('owner trust: superuser=1 + the disk token; the legacy param order is kept', () => {
    const m = buildConverseMcpMount({ ...base, hostTrust: 'owner', superuserToken: 'su-tok', principalToken: null });
    expect(m).toEqual({
      url: 'http://localhost:3070/api/mcp?superuser=1&workspace=ws%20with%20space&tools=harness%3Astatus%2Cchat%3Aask_choice&client=abcdef0123456789',
      bearer: 'su-tok',
    });
    expect(buildConverseMcpMount({ ...base, hostTrust: 'owner', superuserToken: '', principalToken: 'x' })).toBeNull();
  });

  it('public trust: NEVER superuser=1, NEVER the disk token — the boundary bearer or no mount', () => {
    const m = buildConverseMcpMount({ ...base, hostTrust: 'public', superuserToken: 'su-tok', principalToken: 'user-bearer' });
    expect(m).not.toBeNull();
    expect(m!.url).not.toContain('superuser');
    expect(m!.url).toBe(
      'http://localhost:3070/api/mcp?principal=pi&workspace=ws%20with%20space&tools=harness%3Astatus%2Cchat%3Aask_choice&client=abcdef0123456789',
    );
    expect(m!.bearer).toBe('user-bearer');
    // Fail-closed: no boundary bearer ⇒ no mount, even though a superuser token exists.
    expect(buildConverseMcpMount({ ...base, hostTrust: 'public', superuserToken: 'su-tok', principalToken: null })).toBeNull();
    expect(buildConverseMcpMount({ ...base, hostTrust: 'public', superuserToken: 'su-tok', principalToken: '  ' })).toBeNull();
  });

  it('omits &client= when there is no valid client id', () => {
    const m = buildConverseMcpMount({ ...base, uiClientId: null, hostTrust: 'owner', superuserToken: 't', principalToken: null });
    expect(m!.url).not.toContain('client=');
  });

  it('D-421: owner trust withholds the superuser mount when the agent runs as the hosted customer account', () => {
    // The customer workspace account must never hold the operator superuser token, even when
    // one is on disk and would otherwise be mounted.
    expect(
      buildConverseMcpMount({ ...base, hostTrust: 'owner', superuserToken: 'su-tok', principalToken: null, agentRunsAsCustomer: true }),
    ).toBeNull();
    // Unchanged when the agent runs as the operator itself.
    expect(
      buildConverseMcpMount({ ...base, hostTrust: 'owner', superuserToken: 'su-tok', principalToken: null, agentRunsAsCustomer: false })?.bearer,
    ).toBe('su-tok');
  });

  it('D-421: customer-run owner trust mounts only its exact PI bearer, never the disk token', () => {
    const m = buildConverseMcpMount({
      ...base,
      hostTrust: 'owner',
      superuserToken: 'su-tok',
      principalToken: ' customer-pi-bearer ',
      agentRunsAsCustomer: true,
    });
    expect(m).toEqual({
      url: 'http://localhost:3070/api/mcp?principal=pi&workspace=ws%20with%20space&tools=harness%3Astatus%2Cchat%3Aask_choice&client=abcdef0123456789',
      bearer: 'customer-pi-bearer',
    });
    expect(m?.url).not.toContain('superuser');
    expect(m?.bearer).not.toBe('su-tok');
    expect(buildConverseMcpMount({
      ...base,
      hostTrust: 'owner',
      superuserToken: 'su-tok',
      principalToken: '  ',
      agentRunsAsCustomer: true,
    })).toBeNull();
  });
});
