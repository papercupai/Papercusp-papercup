import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

import { DEFAULT_MAX_IN_FLIGHT } from './proxy';

const service = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy.service', import.meta.url),
  'utf8',
);
const stagingService = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy-staging.service', import.meta.url),
  'utf8',
);
const backgroundService = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy-bg-host.service', import.meta.url),
  'utf8',
);
const stagingHost = readFileSync(
  new URL('../../scripts/systemd/papercup-staging-api.service.d/95-bundled-entry.conf', import.meta.url),
  'utf8',
);
const backgroundHost = readFileSync(
  new URL('../../scripts/systemd/papercup-bg-host.service.d/99-mcp-proxy.conf', import.meta.url),
  'utf8',
);

function serviceEnvNumber(name: string, source = service): number {
  const match = source.match(new RegExp(`^Environment=${name}=(\\d+)$`, 'm'));
  return Number(match?.[1] ?? Number.NaN);
}

describe('papercup-mcp-proxy production admission profile', () => {
  it('starts the real tsx service entry across the CommonJS/ESM boundary', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCUSP_MCP_PROXY_PORT: '0',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3170',
    };
    // Match host-native-module.test.ts: exercise the actual service's tsx
    // environment, not the runner's CommonJS committed-source transform guard.
    // That guard has its own suite; startup here must evaluate current source.
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/mcp-proxy.ts'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = createTextCollector(child.stdout);
    output.attach(child.stderr);
    const closed = once(child, 'close');
    try {
      await vi.waitFor(() => {
        expect(child.exitCode, output.peek()).toBeNull();
        expect(output.peek()).toContain('[mcp-proxy] listening on 127.0.0.1:0');
      }, { timeout: 10_000 });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 15_000);

  it('EI-21524993137902308: preserves a full 30-member reconnect lane inside the hard cap', () => {
    const reserve = serviceEnvNumber('PAPERCUSP_MCP_PROXY_CONTROL_PLANE_RESERVE');
    const handshakes = serviceEnvNumber('PAPERCUSP_MCP_PROXY_MAX_HANDSHAKES_IN_FLIGHT');

    expect(reserve).toBeGreaterThanOrEqual(64);
    expect(handshakes).toBeGreaterThanOrEqual(30);
    expect(handshakes).toBeLessThanOrEqual(reserve);
    expect(reserve).toBeLessThan(DEFAULT_MAX_IN_FLIGHT);
  });
});

describe('papercup-mcp-proxy staging restart profile', () => {
  it('EI-24735123650974198: keeps same-build proxy and caller budgets above the observed 90s outage', () => {
    const proxyRetryMs = serviceEnvNumber('PAPERCUSP_MCP_PROXY_RETRY_MS', stagingService);
    const callerRetryMs = serviceEnvNumber('PAPERCUSP_MCP_PROXY_RETRY_MS', stagingHost);

    expect(proxyRetryMs).toBe(300_000);
    expect(callerRetryMs).toBe(proxyRetryMs);
    expect(stagingService).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_PORT=9171$/m);
    expect(stagingService).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_TARGET_PORT=3170$/m);
  });
});

describe('papercup-mcp-proxy background-host restart profile', () => {
  it('pins the stable client route and proxy upstream to the same :3271 vintage', () => {
    expect(serviceEnvNumber('PAPERCUSP_MCP_PROXY_PORT', backgroundService)).toBe(9271);
    expect(serviceEnvNumber('PAPERCUSP_MCP_PROXY_TARGET_PORT', backgroundService)).toBe(3271);
    expect(backgroundHost).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_BASE=http:\/\/127\.0\.0\.1:9271$/m);
    expect(backgroundHost).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_TARGET_PORT=3271$/m);
  });

  it('routes the SU and console agents bg-host starts through the live proxy (WI-6554700010008332)', () => {
    // Owner decision 2026-10-11. Gate-repair roles keep the :9271 pin above (WI-212675).
    expect(backgroundHost).toMatch(/^Environment=PAPERCUSP_BG_HOST_AGENTS_MCP_BASE=http:\/\/127\.0\.0\.1:9071$/m);
  });
});
