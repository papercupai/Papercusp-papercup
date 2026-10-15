import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { runOneAutoloopCycle } from '../autoloop-cycle';
import { findFreeBasePort } from '../../deployment/p2p-perf-tier3/free-port-base';
import { getFlag } from '@papercusp/flags/server';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { applyGatewayLlmEnv, resolveSpawnGatewayEnv } from '../../inference-gateway/spawn-env';
import { sweepOrphanedGymSubstrates } from '../gym-substrate-orphan-sweep';

// These are setup boundaries, not a fake cycle implementation. A missing native
// limit must return before any of them can run or touch the shared environment.
vi.mock('../../deployment/p2p-perf-tier3/free-port-base', () => ({ findFreeBasePort: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@testcontainers/postgresql', () => ({ PostgreSqlContainer: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'PRIVATE_ACCOUNT_WORKSPACE' }));
vi.mock('../gym-substrate-orphan-sweep', () => ({
  sweepOrphanedGymSubstrates: vi.fn(), createGymSubstrateRoot: vi.fn(),
}));
vi.mock('../../inference-gateway/spawn-env', async importOriginal => {
  const actual = await importOriginal<typeof import('../../inference-gateway/spawn-env')>();
  return { ...actual, applyGatewayLlmEnv: vi.fn(actual.applyGatewayLlmEnv), resolveSpawnGatewayEnv: vi.fn() };
});

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('native Gym proposer output admission before setup', () => {
  it('refuses absent gateway authority with a valid supplied output bound before setup', async () => {
    const outcome = await runOneAutoloopCycle('PRIVATE_HARNESS', { fake: false, proposerMaxTokens: 500 });
    expect(outcome).toMatchObject({ ok: false, result: null,
      report: { costUsd: 0, error: expect.stringContaining('requires its configured gateway authority') } });
    expect(findFreeBasePort).not.toHaveBeenCalled();
    expect(getFlag).not.toHaveBeenCalled();
    expect(PostgreSqlContainer).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses absent or invalid bound %s without ports, flags, containers or env mutation', async proposerMaxTokens => {
      vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'PRIVATE_UNCHANGED_ROUTE');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'PRIVATE_UNCHANGED_BASE');
      const outcome = await runOneAutoloopCycle('PRIVATE_HARNESS', { fake: false, proposerMaxTokens });
      expect(outcome).toMatchObject({ ok: false, result: null,
        report: { costUsd: 0, error: expect.stringContaining('proposer requires its configured output token limit') } });
      expect(findFreeBasePort).not.toHaveBeenCalled();
      expect(getFlag).not.toHaveBeenCalled();
      expect(PostgreSqlContainer).not.toHaveBeenCalled();
      expect(process.env.PAPERCUSP_ANTHROPIC_URL).toBe('PRIVATE_UNCHANGED_ROUTE');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('PRIVATE_UNCHANGED_BASE');
    });
});

describe('native Gym role routing uses a cycle-local environment', () => {
  const token = 'PRIVATE_FIXTURE_CALLER_TOKEN_123456789';
  const options = () => ({ fake: false, port: 39_001, proposerMaxTokens: 500, log: () => {},
    nativeGateway: { token, carryTrial: { manifestSha256: 'a'.repeat(64), armId: 'PRIVATE_ARM',
      requestTokenSha256: createHash('sha256').update(token).digest('hex'),
      protocols: ['anthropic-messages', 'openai-responses'] as const,
      authorizeAttempt: async () => null,
    } },
  });
  const stopBeforeSetup = () => {
    vi.mocked(getFlag).mockResolvedValue(true);
    vi.mocked(sweepOrphanedGymSubstrates).mockImplementation(() => { throw new Error('PRIVATE_SETUP_BOUNDARY'); });
    vi.stubEnv('PAPERCUSP_GATEWAY_PORT', '39002');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'PRIVATE_ACCOUNT_WORKSPACE');
    vi.stubEnv('GYM_LOOP_ACCOUNT_WORKSPACE', 'PRIVATE_ACCOUNT_WORKSPACE');
    vi.stubEnv('GYM_LOOP_WORKSPACE', 'PRIVATE_DATA_WORKSPACE');
  };

  it.each([undefined, '', 'https://api.anthropic.com', 'http://127.0.0.1:39003'])(
    'patches only its copy of route %s and keeps AUTO account policy', async route => {
      stopBeforeSetup();
      vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', route);
      vi.stubEnv('ANTHROPIC_BASE_URL', route);
      vi.mocked(resolveSpawnGatewayEnv).mockResolvedValue({
        ANTHROPIC_AUTH_TOKEN: 'PRIVATE_POOL_PLACEHOLDER', PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
      });
      await expect(runOneAutoloopCycle('PRIVATE_HARNESS', options())).rejects.toThrow('PRIVATE_SETUP_BOUNDARY');
      expect(process.env.PAPERCUSP_ANTHROPIC_URL).toBe(route);
      expect(process.env.ANTHROPIC_BASE_URL).toBe(route);
      expect(applyGatewayLlmEnv).toHaveBeenCalledOnce();
      const env = vi.mocked(applyGatewayLlmEnv).mock.calls[0][1]!;
      expect(env).not.toBe(process.env);
      const expected = route?.startsWith('http://127.0.0.1:39003') ? route : 'http://127.0.0.1:39002';
      expect(env.PAPERCUSP_ANTHROPIC_URL).toBe(expected);
      expect(env.ANTHROPIC_BASE_URL).toBe(expected);
      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith({ workspaceId: 'PRIVATE_ACCOUNT_WORKSPACE',
        slug: 'PRIVATE_HARNESS', account: 'auto', backend: 'claude', role: 'gym' });
      expect(PostgreSqlContainer).not.toHaveBeenCalled();
    });

  it('keeps the entry snapshot when the host route changes during account resolution', async () => {
    stopBeforeSetup();
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'http://127.0.0.1:39003');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:39003');
    vi.mocked(resolveSpawnGatewayEnv).mockImplementation(async () => {
      process.env.PAPERCUSP_ANTHROPIC_URL = 'http://127.0.0.1:39004';
      process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:39004';
      return {};
    });
    await expect(runOneAutoloopCycle('PRIVATE_HARNESS', options())).rejects.toThrow('PRIVATE_SETUP_BOUNDARY');
    const env = vi.mocked(applyGatewayLlmEnv).mock.calls[0]?.[1];
    expect(env?.PAPERCUSP_ANTHROPIC_URL).toBe('http://127.0.0.1:39003');
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:39003');
    expect(process.env.PAPERCUSP_ANTHROPIC_URL).toBe('http://127.0.0.1:39004');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:39004');
    expect(PostgreSqlContainer).not.toHaveBeenCalled();
  });
});
