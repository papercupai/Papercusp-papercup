import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown> | null,
  readState: vi.fn(),
}));

// Exercise the real shared collector, with unrelated machine/PG probes isolated.
vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (definition: unknown) => definition }));
vi.mock('../../../operator-state-pg', () => ({ readOperatorState: fixture.readState }));
vi.mock('../../../credentials', () => ({ readCredentials: async () => ({}) }));
vi.mock('../../../device-store', () => ({ listDevices: async () => [] }));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'fixture', readRegistry: () => ({ workspaces: [] }),
}));
vi.mock('../../../backup', () => ({ workspaceBackupFor: () => ({ getSettings: async () => null }) }));
vi.mock('../../../agent-auth-detect', () => ({ anyAgentSignedIn: () => false }));
vi.mock('../../../preflight-binaries', () => ({
  detectClaude: async () => false, detectCodex: async () => false, detectOmp: async () => false,
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { INFERENCE_GATEWAY: 'fixture' } }));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    callback(new Error('Git identity is deliberately unavailable in this fixture'));
  },
}));
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { Socket: class extends EventEmitter {
    setTimeout() {}
    connect() { this.emit('connect'); }
    destroy() {}
  } } };
});
vi.mock('../../../managed-update-policy', async importOriginal => ({
  ...(await importOriginal<object>()), readManagedUpdateChannel: vi.fn(() => null),
}));

import route, { collectSetupStatus } from './setup-status';
import statusTool from '../../../agent-tools/setup/status';
import { ManagedUpdatePolicyError, readManagedUpdateChannel } from '../../../managed-update-policy';

beforeEach(() => {
  vi.stubEnv('PAPERCUSP_USE_EMBEDDED_PG', '0');
  fixture.state = { telemetry_enabled: false };
  fixture.readState.mockReset().mockImplementation(async () => fixture.state);
  vi.mocked(readManagedUpdateChannel).mockReset().mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe('setup auto-update detection', () => {
  it.each(['alpha', 'beta', 'stable'] as const)('accepts managed %s without a saved user choice', async channel => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue(channel);
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('ok');
    expect(status.autoUpdate).toEqual({
      status: 'ok', effectiveChannel: channel, managed: true, source: 'administrator', error: null,
    });
    expect(fixture.state).toEqual({ telemetry_enabled: false });
  });

  it('re-reads administrator policy after a conflicting user choice and subsequent policy change', async () => {
    fixture.state!.update_channel = 'alpha';
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    expect((await collectSetupStatus()).autoUpdate).toEqual({
      status: 'ok', effectiveChannel: 'stable', managed: true, source: 'administrator', error: null,
    });
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => {
      throw new ManagedUpdatePolicyError('managed_policy_invalid', 'Invalid administrator policy');
    });
    const changed = await collectSetupStatus();
    expect(changed.statuses['auto-update']).toBe('needs-attention');
    expect(changed.autoUpdate).toEqual({
      status: 'needs-attention', effectiveChannel: null, managed: true,
      source: 'administrator', error: 'managed_policy_invalid',
    });
    expect(readManagedUpdateChannel).toHaveBeenCalledTimes(2);
    expect(fixture.state!.update_channel).toBe('alpha');
  });

  it.each(['invalid', 'unreadable'])('does not report ready with %s policy and a saved choice', async reason => {
    fixture.state!.update_channel = 'stable';
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => {
      throw new ManagedUpdatePolicyError('managed_policy_invalid', `${reason}: sensitive contents`);
    });
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('needs-attention');
    expect(status.autoUpdate).toEqual({
      status: 'needs-attention', effectiveChannel: null, managed: true,
      source: 'administrator', error: 'managed_policy_invalid',
    });
    expect(status.statuses.telemetry).toBe('ok');
    expect(JSON.stringify(status)).not.toContain('sensitive contents');
  });

  it.each(['alpha', 'beta', 'stable'])('preserves saved %s when policy reader reports unmanaged', async channel => {
    fixture.state!.update_channel = channel;
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('ok');
    expect(status.autoUpdate).toEqual({
      status: 'ok', effectiveChannel: channel, managed: false, source: 'user', error: null,
    });
  });

  it.each([undefined, 'nightly', 'invalid'])('requires a valid choice when unmanaged: %s', async channel => {
    fixture.state!.update_channel = channel;
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('needs-attention');
    expect(status.autoUpdate).toEqual({
      status: 'needs-attention', effectiveChannel: null, managed: false, source: null, error: null,
    });
  });

  it('still detects a managed channel if the saved-state probe fails', async () => {
    fixture.readState.mockRejectedValue(new Error('State unavailable'));
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('ok');
    expect(status.autoUpdate.effectiveChannel).toBe('stable');
    expect(status.autoUpdate.managed).toBe(true);
  });

  it('isolates unexpected policy probe failures as unknown', async () => {
    fixture.state!.update_channel = 'stable';
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => { throw new Error('Unexpected probe failure'); });
    const status = await collectSetupStatus();
    expect(status.statuses['auto-update']).toBe('unknown');
    expect(status.autoUpdate).toEqual({
      status: 'unknown', effectiveChannel: null, managed: null, source: null, error: 'probe_failed',
    });
    expect(status.statuses.telemetry).toBe('ok');
    expect(JSON.stringify(status)).not.toContain('Unexpected probe failure');
  });

  it('projects the real collector through both HTTP and setup:status', async () => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    const http = await route.handler(new Request('http://fixture/desktop/setup-status'), {} as never);
    const tool = await statusTool.handler({} as never, {} as never);
    const httpBody = await http.json();
    const first = 'data' in tool ? undefined : tool.content[0];
    const toolBody = 'data' in tool ? tool.data : first?.type === 'text' ? JSON.parse(first.text) : null;
    expect(httpBody.statuses['auto-update']).toBe('ok');
    expect(httpBody.autoUpdate).toEqual({
      status: 'ok', effectiveChannel: 'stable', managed: true, source: 'administrator', error: null,
    });
    expect(toolBody).toEqual(httpBody);
  });
});
