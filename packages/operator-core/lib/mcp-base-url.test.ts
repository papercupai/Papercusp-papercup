/**
 * mcp-base-url.test.ts — resolveAgentMcpBaseUrl (WI-573). The opt-in proxy redirect:
 * env set → proxy base (deploy-restart-resilient); env unset → operator base unchanged
 * (so a no-proxy env can never break). Run: npx vitest run mcp-base-url
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAgentMcpBaseUrl,
  resolveBackgroundHostAgentsBase,
  resolveChildSessionOperatorBaseUrl,
  resolveInheritedOperatorBaseUrl,
  resolveLongLivedSessionMcpBaseUrl,
  resolveResumedSessionOperatorBaseUrl,
  resolveSpawnHostOperatorBaseUrl,
} from './mcp-base-url';
import { readFileSync } from 'node:fs';

const KEY = 'PAPERCUSP_MCP_PROXY_BASE';
const TARGET_PORT_KEY = 'PAPERCUSP_MCP_PROXY_TARGET_PORT';
const STAGING_PROXY_PORT_KEY = 'PAPERCUSP_MCP_STAGING_PROXY_PORT';
const HONO_PORT_KEY = 'PAPERCUSP_HONO_PORT';
const BG_AGENTS_KEY = 'PAPERCUSP_BG_HOST_AGENTS_MCP_BASE';
const ORIGINAL_ENV = {
  proxy: process.env[KEY],
  targetPort: process.env[TARGET_PORT_KEY],
  stagingProxyPort: process.env[STAGING_PROXY_PORT_KEY],
  honoPort: process.env[HONO_PORT_KEY],
  bgAgents: process.env[BG_AGENTS_KEY],
};
beforeEach(() => {
  // Each fixture declares its complete routing configuration. A background
  // session's inherited target=3271 must not become an unstated test input.
  delete process.env[KEY];
  delete process.env[TARGET_PORT_KEY];
  delete process.env[STAGING_PROXY_PORT_KEY];
  delete process.env[HONO_PORT_KEY];
  delete process.env[BG_AGENTS_KEY];
});
afterEach(() => {
  if (ORIGINAL_ENV.honoPort === undefined) delete process.env[HONO_PORT_KEY];
  else process.env[HONO_PORT_KEY] = ORIGINAL_ENV.honoPort;
  if (ORIGINAL_ENV.bgAgents === undefined) delete process.env[BG_AGENTS_KEY];
  else process.env[BG_AGENTS_KEY] = ORIGINAL_ENV.bgAgents;
  if (ORIGINAL_ENV.proxy === undefined) delete process.env[KEY];
  else process.env[KEY] = ORIGINAL_ENV.proxy;
  if (ORIGINAL_ENV.targetPort === undefined) delete process.env[TARGET_PORT_KEY];
  else process.env[TARGET_PORT_KEY] = ORIGINAL_ENV.targetPort;
  if (ORIGINAL_ENV.stagingProxyPort === undefined) delete process.env[STAGING_PROXY_PORT_KEY];
  else process.env[STAGING_PROXY_PORT_KEY] = ORIGINAL_ENV.stagingProxyPort;
});

describe('resolveAgentMcpBaseUrl', () => {
  it('env UNSET → operator base unchanged (trailing slash trimmed)', () => {
    delete process.env[KEY];
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
    expect(resolveAgentMcpBaseUrl('http://localhost:3070/')).toBe('http://localhost:3070');
  });

  it('env SET → proxy base wins (deploy-restart-resilient)', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://127.0.0.1:9071');
  });

  it('every explicit non-live operator port stays direct when the :3070 proxy is configured', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    process.env[TARGET_PORT_KEY] = '3070';
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3170/')).toBe('http://127.0.0.1:3170');
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3295/')).toBe('http://127.0.0.1:3295');
  });

  it('routes only a local staging operator through its configured same-vintage proxy', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    process.env[STAGING_PROXY_PORT_KEY] = '9171';
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://127.0.0.1:9171');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3170/')).toBe('http://127.0.0.1:9171');
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
    expect(resolveAgentMcpBaseUrl('http://example.com:3170')).toBe('http://example.com:3170');
    expect(resolveAgentMcpBaseUrl('https://localhost:3170')).toBe('https://localhost:3170');
  });

  it('routes a local :3271 background host only through a proxy explicitly pinned to :3271', () => {
    process.env[KEY] = 'http://127.0.0.1:9271';
    process.env[TARGET_PORT_KEY] = '3271';
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://127.0.0.1:9271');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3271/')).toBe('http://127.0.0.1:9271');
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    expect(resolveAgentMcpBaseUrl('http://example.com:3271')).toBe('http://example.com:3271');
  });

  it('keeps :3271 direct when the configured proxy fronts another runtime vintage', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    process.env[TARGET_PORT_KEY] = '3070';
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
  });

  it('keeps local staging direct when the staging proxy port is invalid', () => {
    for (const port of ['0', '3170', '65536', '91/../../']) {
      process.env[STAGING_PROXY_PORT_KEY] = port;
      expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    }
  });

  it('env set to whitespace/empty → falls back to operator base (no accidental break)', () => {
    process.env[KEY] = '   ';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
  });

  it('proxy base trailing slash is trimmed', () => {
    process.env[KEY] = 'http://127.0.0.1:9071/';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://127.0.0.1:9071');
  });

  it('never hands a :3070 base to a proxy declared to front another port (cross-vintage leak)', () => {
    // bg-host's unit: its own proxy :9271 fronts :3271. wake-executor normalizes the inherited
    // PAPERCUSP_OPERATOR_URL (:3070) through here; it must not land on bg-host via :9271.
    process.env[HONO_PORT_KEY] = '3271';
    process.env[KEY] = 'http://127.0.0.1:9271';
    process.env[TARGET_PORT_KEY] = '3271';
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
    // The same-vintage pin for its own base is unchanged when no agents endpoint is declared.
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://127.0.0.1:9271');
  });
});

describe('background-host agents endpoint (WI-6554700010008332)', () => {
  const bgHostUnit = () => {
    process.env[HONO_PORT_KEY] = '3271';
    process.env[KEY] = 'http://127.0.0.1:9271';
    process.env[TARGET_PORT_KEY] = '3271';
    process.env[BG_AGENTS_KEY] = 'http://127.0.0.1:9071/';
  };

  it('moves agents the background host mints for its own or the inherited live base', () => {
    bgHostUnit();
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://127.0.0.1:9071');
    expect(resolveAgentMcpBaseUrl('http://127.0.0.1:3271/')).toBe('http://127.0.0.1:9071');
    expect(resolveAgentMcpBaseUrl('http://localhost:3070')).toBe('http://127.0.0.1:9071');
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://127.0.0.1:9071');
  });

  it('leaves remote, staging and hermetic bases where they are', () => {
    bgHostUnit();
    expect(resolveAgentMcpBaseUrl('http://example.com:3271')).toBe('http://example.com:3271');
    expect(resolveAgentMcpBaseUrl('http://localhost:3170')).toBe('http://localhost:3170');
    expect(resolveAgentMcpBaseUrl('http://localhost:4100')).toBe('http://localhost:4100');
  });

  it('is honoured only by the :3271 process itself, so a :3271 pin chosen elsewhere stays a pin', () => {
    process.env[HONO_PORT_KEY] = '3070';
    process.env[KEY] = 'http://127.0.0.1:9071';
    process.env[BG_AGENTS_KEY] = 'http://127.0.0.1:9071';
    expect(resolveBackgroundHostAgentsBase()).toBeUndefined();
    expect(resolveAgentMcpBaseUrl('http://localhost:3271')).toBe('http://localhost:3271');
  });

  it('routes long-lived and child sessions the background host starts to the declared endpoint', () => {
    bgHostUnit();
    expect(resolveLongLivedSessionMcpBaseUrl()).toBe('http://127.0.0.1:9071');
    expect(resolveChildSessionOperatorBaseUrl()).toBe('http://127.0.0.1:9071');
  });

  it('keeps the child session on its spawner elsewhere: live via its proxy, desktop and staging direct', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveChildSessionOperatorBaseUrl({ PAPERCUSP_HONO_PORT: '3070' })).toBe('http://127.0.0.1:9071');
    expect(resolveChildSessionOperatorBaseUrl({ PAPERCUSP_HONO_PORT: '3170' })).toBe('http://localhost:3170');
    expect(resolveChildSessionOperatorBaseUrl({ OPERATOR_DEV_PORT: '33700', PAPERCUSP_HONO_PORT: '3170' }))
      .toBe('http://localhost:33700');
  });

  it('without the declaration the background host keeps its children on its own vintage', () => {
    process.env[HONO_PORT_KEY] = '3271';
    process.env[KEY] = 'http://127.0.0.1:9271';
    process.env[TARGET_PORT_KEY] = '3271';
    expect(resolveChildSessionOperatorBaseUrl()).toBe('http://127.0.0.1:9271');
    expect(resolveLongLivedSessionMcpBaseUrl()).toBe('http://127.0.0.1:9271');
  });
});

describe('resolveInheritedOperatorBaseUrl', () => {
  it('undefined/empty input passes through unchanged', () => {
    expect(resolveInheritedOperatorBaseUrl(undefined)).toBe(undefined);
    expect(resolveInheritedOperatorBaseUrl('')).toBe('');
    expect(resolveInheritedOperatorBaseUrl('   ')).toBe('   ');
  });

  it('bare origin, no proxy configured → unchanged', () => {
    delete process.env[KEY];
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070')).toBe('http://localhost:3070');
  });

  it('/api/mcp-suffixed origin is stripped back to bare (the doubled-path bug)', () => {
    delete process.env[KEY];
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://localhost:3070');
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp/')).toBe('http://localhost:3070');
  });

  it('suffixed origin + proxy configured → stripped AND routed through the proxy', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://127.0.0.1:9071');
  });

  it('staging/current-build inherited URL stays direct when the live proxy is configured', () => {
    process.env[KEY] = 'http://127.0.0.1:9071';
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3170/api/mcp')).toBe('http://localhost:3170');
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3271/api/mcp')).toBe('http://localhost:3271');
  });
});

describe('resolveSpawnHostOperatorBaseUrl (WI-6154)', () => {
  it('uses the desktop sidecar dev port over an inherited staging Hono port', () => {
    expect(resolveSpawnHostOperatorBaseUrl({
      OPERATOR_DEV_PORT: '33700', PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
    })).toBe('http://localhost:33700');
  });

  it('HONO_PORT set (this process IS an operator host) → own identity wins, even with a stale inherited OPERATOR_URL', () => {
    // Reproduces the staging-host leak: .env.local sets PAPERCUSP_OPERATOR_URL to
    // the LIVE :3070 operator, and the staging service ADDITIONALLY exports its
    // own PAPERCUSP_HONO_PORT=3170 on top — a spawn from staging must pin :3170.
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp',
      }),
    ).toBe('http://localhost:3170');
  });

  it('HONO_PORT unset (a plain client/agent session, not itself an operator host) → falls back to the inherited OPERATOR_URL', () => {
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      }),
    ).toBe('http://127.0.0.1:9071');
  });

  it('inherited OPERATOR_URL /api/mcp suffix is stripped back to the bare origin', () => {
    expect(
      resolveSpawnHostOperatorBaseUrl({
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp',
      }),
    ).toBe('http://localhost:3070');
  });

  it('neither var set → defaults to the live operator origin', () => {
    expect(resolveSpawnHostOperatorBaseUrl({})).toBe('http://localhost:3070');
  });

  it('HONO_PORT set, no inherited OPERATOR_URL at all → still pins to own identity', () => {
    expect(resolveSpawnHostOperatorBaseUrl({ PAPERCUSP_HONO_PORT: '4100' })).toBe('http://localhost:4100');
  });
});

describe('resolveLongLivedSessionMcpBaseUrl', () => {
  it('routes staging-host launches through the same-vintage proxy, not the live proxy', () => {
    expect(
      resolveLongLivedSessionMcpBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070',
        PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
        PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
      }),
    ).toBe('http://127.0.0.1:9171');
  });

  it('keeps staging on its own port when the same-vintage proxy is not configured', () => {
    expect(
      resolveLongLivedSessionMcpBaseUrl({
        PAPERCUSP_HONO_PORT: '3170',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070',
        PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
      }),
    ).toBe('http://localhost:3170');
  });

  it('keeps the configured stable proxy for live-host launches and trims trailing slashes', () => {
    expect(
      resolveLongLivedSessionMcpBaseUrl({
        PAPERCUSP_HONO_PORT: '3070',
        PAPERCUSP_OPERATOR_URL: 'http://localhost:3070',
        PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071/',
      }),
    ).toBe('http://127.0.0.1:9071');
  });
});

describe('resolveResumedSessionOperatorBaseUrl (WI-6554700010008371)', () => {
  const DEV_PORT_KEY = 'OPERATOR_DEV_PORT';
  const originalDevPort = process.env[DEV_PORT_KEY];
  beforeEach(() => {
    delete process.env[DEV_PORT_KEY];
  });
  afterEach(() => {
    if (originalDevPort === undefined) delete process.env[DEV_PORT_KEY];
    else process.env[DEV_PORT_KEY] = originalDevPort;
  });

  it('routes a direct live :3070 base from a host without the proxy env to the long-lived endpoint', () => {
    // The desktop-dev :3270 operator sourcing apps/operator/.env.local: this is the env that
    // resumed su-d70c727a pinned direct to :3070 on 2026-10-11.
    process.env[HONO_PORT_KEY] = '3270';
    expect(resolveInheritedOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://localhost:3070');
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://127.0.0.1:9071');
    expect(resolveResumedSessionOperatorBaseUrl('http://127.0.0.1:3070')).toBe('http://127.0.0.1:9071');
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3070/')).toBe('http://127.0.0.1:9071');
  });

  it('matches a fresh long-lived launch on the same host', () => {
    process.env[HONO_PORT_KEY] = '3270';
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe(
      resolveLongLivedSessionMcpBaseUrl(),
    );
  });

  it('leaves every other inherited base on the inherited answer', () => {
    expect(resolveResumedSessionOperatorBaseUrl(undefined)).toBe(undefined);
    expect(resolveResumedSessionOperatorBaseUrl('')).toBe('');
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3170/api/mcp')).toBe('http://localhost:3170');
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3271/api/mcp')).toBe('http://localhost:3271');
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3270')).toBe('http://localhost:3270');
    expect(resolveResumedSessionOperatorBaseUrl('http://10.0.0.5:3070')).toBe('http://10.0.0.5:3070');
    expect(resolveResumedSessionOperatorBaseUrl('http://127.0.0.1:9071')).toBe('http://127.0.0.1:9071');
  });

  it('keeps the desktop sidecar direct (OPERATOR_DEV_PORT set)', () => {
    process.env[DEV_PORT_KEY] = '3070';
    expect(resolveResumedSessionOperatorBaseUrl('http://localhost:3070/api/mcp')).toBe('http://localhost:3070');
  });

  it('is the resolver both wake-executor resume sites use', () => {
    const src = readFileSync(new URL('./events/await/wake-executor.ts', import.meta.url), 'utf8');
    expect(src.match(/resolveResumedSessionOperatorBaseUrl\(process\.env\.PAPERCUSP_OPERATOR_URL\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/resolveInheritedOperatorBaseUrl\(process\.env/);
  });
});
