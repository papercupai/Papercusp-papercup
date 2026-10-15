import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyScopedNativeGateway, effectiveAutoMode, parseArgs, prepareCodexGatewayLaunch,
  sanitizeInheritedEnv } from '../../../../apps/operator/scripts/psu-launcher.mjs';
import { resolveBackendLaunch } from '../backend-bin-resolve.mjs';
import { SCOPED_INFERENCE_GATEWAY_ENV } from '@papercusp/orchestrator/codex-gateway-config';
import { buildAgentLaunchCommand } from '../agent-launch-core';
import { currentBenchLaunchRequest, type CurrentSuBenchOptions } from './current-su';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';

const options: CurrentSuBenchOptions = {
  workspaceId: 'bench-autonomy-private', runId: 'run-1', armId: 'papercusp', seed: 1,
  agent: 'codex', model: 'gpt-6-luna', effort: 'max', account: 'auto',
  preregistration: { config: currentProtocolFixture(), preregHash: 'a'.repeat(64) },
};
const handle = { slug: 'xbench-autonomy-private', featureId: 'xbench-private-assignment', worktreePath: '/tmp/bench-autonomy-private' };

describe('current-su native assignment launch authority', () => {
  it('keeps the private gateway and exact backend together at the native boundary without starting an agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'bench-boundary-'));
    const backend = join(home, 'codex');
    const gateway = { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) };
    try {
      writeFileSync(backend, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(join(home, 'config.toml'), 'model_provider = "openai"\n');
      // The actual launcher sanitizes inherited selectors, then adds the
      // trusted host envelope back before resolving the executable and route.
      const env = { ...sanitizeInheritedEnv({ PATH: process.env.PATH }),
        PAPERCUSP_AGENT: 'codex', CODEX_HOME: home, PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
        PAPERCUSP_BACKEND_BIN_CODEX: backend, [SCOPED_INFERENCE_GATEWAY_ENV]: JSON.stringify(gateway) };
      expect(resolveBackendLaunch('codex', { env })).toMatchObject({ bin: backend, override: true });
      applyScopedNativeGateway(env);
      const args = prepareCodexGatewayLaunch(env, ['-c', 'model_provider="openai"']);
      expect(args).toEqual(['-c', 'model_provider="papercusp-codex-gateway"']);
      const config = readFileSync(join(home, 'config.toml'), 'utf8');
      expect(config).toContain(gateway.baseURL + '/v1');
      expect(config).toContain(gateway.token);
      expect(resolveBackendLaunch('codex', { env: { ...env, PAPERCUSP_BACKEND_BIN_CODEX: join(home, 'missing') } })).toBeNull();
      expect(() => applyScopedNativeGateway({ ...env, [SCOPED_INFERENCE_GATEWAY_ENV]: '{}' }))
        .toThrow(/Invalid scoped inference gateway/);
      expect(() => applyScopedNativeGateway({ ...env, PAPERCUSP_AGENT: 'claude' }))
        .toThrow(/isolated Codex home/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('registers AUTO for the independent headless assignment through the actual command and psu parser', () => {
    const request = currentBenchLaunchRequest(options, handle, 'Implement the isolated benchmark task.');
    const command = buildAgentLaunchCommand({ mode: 'fresh', agent: options.agent,
      harness: handle.slug, feature: handle.featureId, role: 'su', model: options.model,
      modelSource: 'explicit', effort: options.effort, account: options.account,
      headless: request.headless, extraArgs: request.extraArgs });
    expect(command.startsWith('psu ')).toBe(true);
    // Exercise the maintained shell quoting without running psu or an agent.
    // Only these source-controlled fixture values enter the command.
    const argv = execFileSync('bash', ['-c', `set -- ${command.slice(4)}; printf '%s\\0' "$@"`],
      { encoding: 'utf8' }).split('\0').filter(Boolean);
    const parsed = parseArgs(argv);
    expect(parsed.headless).toBe(true);
    expect(parsed.fleet ?? null).toBeNull();
    expect(parsed.mode ?? null).toBeNull();
    expect(effectiveAutoMode(parsed)).toBe(true);
  });

  it('keeps an ordinary independent headless launch non-autonomous and honors an explicit veto', () => {
    const parsed = parseArgs(['--headless', '--agent=codex', '--model=gpt-6-luna:max', '--model-source=explicit']);
    expect(effectiveAutoMode(parsed)).toBe(false);
    expect(effectiveAutoMode({ ...parsed, auto: false })).toBe(false);
  });
});
