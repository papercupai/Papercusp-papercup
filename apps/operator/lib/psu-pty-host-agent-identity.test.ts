/**
 * D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326): psu's PTY host runs its
 * agent child through `resolveAgentPtyTarget`. Without the hosted agent-identity spec (desktop,
 * dev) the child is exactly what psu asked for; with it, the pty runs the identity transport and
 * a staging refusal propagates — there is no silent fallback to the service user.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentityTtyRequest } from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';
import { AGENT_IDENTITY_SPEC_ENV } from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';
import { resolveAgentPtyTarget } from '../scripts/psu-pty-host.mjs';

const target = {
  command: 'claude',
  args: ['--system-prompt-file', '/state/.papercusp/launch-context/s.md'],
  env: { PATH: '/usr/bin', PAPERCUSP_SID: 'su-x' } as Record<string, string | undefined>,
  cwd: '/workspace',
};

describe('psu PTY agent target (D-424)', () => {
  it('is the unchanged child when no identity spec is present', () => {
    const stage = vi.fn();
    const resolved = resolveAgentPtyTarget(target, { stage });
    expect(resolved).toEqual({ command: target.command, args: target.args, env: target.env });
    expect(stage).not.toHaveBeenCalled();
  });

  it('runs the identity transport the stage returns, with only its env', () => {
    const env = { ...target.env, [AGENT_IDENTITY_SPEC_ENV]: '{"v":1}' };
    const stage = vi.fn(() => ({
      command: '/usr/bin/ssh',
      args: ['-tt', '-l', 'papercusp-workspace', '127.0.0.1', 'exec node -e … /x/exec.json'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/state', TERM: 'xterm-256color' },
      execHeaderPath: '/x/exec.json',
      identity: 'papercusp-workspace@127.0.0.1',
    }));
    const resolved = resolveAgentPtyTarget({ ...target, env }, { stage });
    expect(stage).toHaveBeenCalledWith('{"v":1}', { command: 'claude', args: target.args, env, cwd: '/workspace' });
    expect(resolved.command).toBe('/usr/bin/ssh');
    expect(resolved.args).toContain('-tt');
    expect(resolved.env).not.toHaveProperty(AGENT_IDENTITY_SPEC_ENV);
    expect(resolved.env).not.toHaveProperty('PAPERCUSP_SID');
  });

  it('propagates a staging refusal instead of spawning as the service user', () => {
    const env = { ...target.env, [AGENT_IDENTITY_SPEC_ENV]: '{"v":1}' };
    const stage = vi.fn(() => {
      throw Object.assign(new Error('agent toolchain missing'), { code: 'agent_toolchain_missing' });
    });
    expect(() => resolveAgentPtyTarget({ ...target, env }, { stage })).toThrow('agent toolchain missing');
  });
});

describe('managed native MCP carrier', () => {
  const parent = '11111111-1111-4111-8111-111111111111';
  const fork = '22222222-2222-4222-8222-222222222222';
  const successor = '33333333-3333-4333-8333-333333333333';

  it('pins the forced fork child before hosted identity staging, never the parent', () => {
    const env = {
      ...target.env, [AGENT_IDENTITY_SPEC_ENV]: '{"v":1}',
      PAPERCUSP_NATIVE_SESSION_ID: parent,
    };
    const args = ['--resume', parent, '--fork-session', '--session-id', fork];
    const stage = vi.fn((_spec: unknown, child: AgentIdentityTtyRequest) => ({
      command: child.command,
      args: child.args,
      env: Object.fromEntries(Object.entries(child.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      execHeaderPath: '/x/exec.json',
      identity: 'papercusp-workspace@127.0.0.1',
    }));
    const resolved = resolveAgentPtyTarget({ ...target, args, env }, { stage });
    expect(resolved.env.PAPERCUSP_NATIVE_SESSION_ID).toBe(fork);
    expect(stage.mock.calls[0]?.[1].env.PAPERCUSP_NATIVE_SESSION_ID).toBe(fork);
    expect(env.PAPERCUSP_NATIVE_SESSION_ID).toBe(parent);
    expect(resolved.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('rederives the carrier on each respawn while preserving the coordination owner', () => {
    const env = { ...target.env, PAPERCUSP_NATIVE_SESSION_ID: parent };
    for (const args of [['--session-id', fork], ['--session-id=' + successor], ['--resume', fork]]) {
      const resolved = resolveAgentPtyTarget({ ...target, args, env });
      expect(resolved.env.PAPERCUSP_NATIVE_SESSION_ID).toBe(args[0].includes('=') ? successor : fork);
      expect(resolved.env.PAPERCUSP_SID).toBe('su-x');
      expect(resolved.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    }
    expect(env.PAPERCUSP_NATIVE_SESSION_ID).toBe(parent);
  });

  it.each([
    [], ['--resume', parent, '--fork-session'], ['fork', parent],
    ['--resume', 'not-a-native-uuid'], ['--session-id=invalid'],
  ].map((args) => ({ args })))('clears a stale carrier when the child identity is unknown: $args', ({ args }) => {
    const env = { ...target.env, PAPERCUSP_NATIVE_SESSION_ID: parent };
    const resolved = resolveAgentPtyTarget({ ...target, args, env });
    expect(resolved.env.PAPERCUSP_NATIVE_SESSION_ID).toBeUndefined();
    expect(env.PAPERCUSP_NATIVE_SESSION_ID).toBe(parent);
  });
});
