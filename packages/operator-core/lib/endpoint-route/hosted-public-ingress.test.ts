import { describe, expect, it } from 'vitest';
import {
  HOSTED_INGRESS_FAMILIES,
  HOSTED_INGRESS_PROBE_CONCURRENCY,
  PORTAL_SESSION_GATE_ERROR,
  auditHostedIngressRules,
  familiesForMountedRouteKey,
  hostedIngressSamples,
  parseCloudflaredIngressYaml,
  probeHostedPublicIngress,
  routeCloudflaredIngress,
  sameIngressService,
  sampleMatchesPlanePredicate,
} from './hosted-public-ingress';
import { HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS } from './hosted-runtime';
import { PORTAL_MCP_OAUTH_ROUTES, matchPortalMcpOAuthRoute } from '../connected-apps/portal-mcp-oauth';
import { PHONE_DEVICE_PATHS } from '../device-ingress-paths';
import { parseDeviceRelayPath } from '../workspace-host/hosted-app-relay';

const HOST = 'app.papercusp.com';
const PLANE = 'http://localhost:3880';
const PORTAL = 'http://localhost:3801';

/**
 * The app.papercusp.com rules of ~/.cloudflared/papercup-demos.yml as fixed on
 * 2026-10-01, each keyed by the incident that added it.
 */
const PLANE_RULES: Record<string, string> = {
  browser: '^/api/hosted/browser/',
  connectors: '^/api/hosted/connectors/',
  workspaceConnectors: '^/api/hosted/workspaces/[^/]+/connectors/',
  'WI-10003292 cli': '^/api/hosted/cli/',
  'P-014 F2 relay': '^/api/hosted/relay/',
  'WI-10004436 app relay + oauth':
    '^/api/workspaces/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/(mcp|agent-tools/.+|hooks/[^/]+|oauth/(register|authorize|consent|token)|\\.well-known/oauth-authorization-server)$',
  'WI-10004436 well-known': '^/\\.well-known/oauth-(protected-resource|authorization-server)/api/workspaces/',
  'WI-10005066 workos webhook': '^/api/auth/workos/webhook$',
  'WI-10007014 device relay': '^/api/workspaces/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/api/device/',
};

function configYaml(without: ReadonlyArray<string> = [], extra: ReadonlyArray<string> = []): string {
  const rules = [
    ...Object.entries(PLANE_RULES)
      .filter(([key]) => !without.includes(key))
      .map(([, path]) => path),
    ...extra,
  ].map((path) => `  - hostname: ${HOST}\n    path: '${path}'\n    service: ${PLANE}\n`);
  return `tunnel: test\ningress:\n${rules.join('')}  - hostname: ${HOST}\n    service: ${PORTAL}\n  - service: http_status:404\n`;
}

function audit(yaml: string) {
  return auditHostedIngressRules({ rules: parseCloudflaredIngressYaml(yaml), hostname: HOST, controlPlaneService: PLANE });
}

describe('hosted ingress route families', () => {
  it('puts every mounted plane route in exactly one family', () => {
    const misfiled = HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS.map((key) => ({
      key,
      families: familiesForMountedRouteKey(key).map((family) => family.id),
    })).filter(({ families }) => families.length !== 1);
    expect(misfiled).toEqual([]);
  });

  it('builds samples the plane itself routes, for every family', () => {
    const samples = hostedIngressSamples();
    expect(samples.filter((sample) => !sampleMatchesPlanePredicate(sample))).toEqual([]);
    expect(samples.filter((sample) => sample.family === 'unclassified')).toEqual([]);
    const sampled = new Set(samples.map((sample) => sample.family));
    expect(HOSTED_INGRESS_FAMILIES.map((family) => family.id).filter((id) => !sampled.has(id))).toEqual([]);
    expect(samples.length).toBeGreaterThan(HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS.length);
  });

  it('samples every mounted route key once', () => {
    const sources = hostedIngressSamples().map((sample) => sample.source);
    for (const key of HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS) expect(sources.filter((source) => source === key)).toHaveLength(1);
  });

  /** OAuth routes the portal router serves that the samples do not hit exactly once, at the route's own method. */
  function oauthRoutesNotSampledOnce(samples: ReadonlyArray<{ family: string; method: string; path: string }>): string[] {
    const oauth = samples.filter((sample) => sample.family === 'mcp-oauth');
    return PORTAL_MCP_OAUTH_ROUTES.filter((route) => {
      const hits = oauth.filter((sample) => matchPortalMcpOAuthRoute(sample.path)?.route === route);
      return hits.length !== 1 || hits[0]!.method !== route.sampleMethod;
    }).map((route) => route.template);
  }

  it('samples every MCP OAuth route the portal router serves, once each, so a new route is probed too (WI-10005092)', () => {
    const samples = hostedIngressSamples();
    expect(oauthRoutesNotSampledOnce(samples)).toEqual([]);
    expect(samples.filter((sample) => sample.family === 'mcp-oauth')).toHaveLength(PORTAL_MCP_OAUTH_ROUTES.length);
  });

  it('samples every phone device path once, so a device route added later is probed too (WI-10007014)', () => {
    const device = hostedIngressSamples('ws-ingress-probe').filter((sample) => sample.family === 'device-relay');
    expect(device.map((sample) => sample.source)).toEqual([...PHONE_DEVICE_PATHS]);
    for (const sample of device) {
      expect(parseDeviceRelayPath(sample.path)).toEqual({ customerWorkspaceId: 'ws-ingress-probe', machinePath: sample.source });
    }
  });

  it('control: a hand-listed sample set that misses a route is caught', () => {
    const base = '/api/workspaces/ws-ingress-probe';
    const handListed = [
      ['GET', `/.well-known/oauth-protected-resource${base}/mcp`],
      ['GET', `/.well-known/oauth-authorization-server${base}`],
      ['POST', `${base}/oauth/register`],
      ['GET', `${base}/oauth/authorize`],
      ['GET', `${base}/oauth/consent`],
      ['POST', `${base}/oauth/token`],
    ].map(([method, path]) => ({ family: 'mcp-oauth', method: method!, path: path! }));
    expect(oauthRoutesNotSampledOnce(handListed)).toEqual(['/api/workspaces/:workspaceId/.well-known/oauth-authorization-server']);
  });
});

describe('routeCloudflaredIngress', () => {
  const rules = parseCloudflaredIngressYaml(
    [
      'ingress:',
      '  - hostname: a.example.com',
      '    path: /api/x',
      '    service: http://localhost:1',
      '  - hostname: "*.example.com"',
      '    service: http://localhost:2',
      '  - service: http_status:404',
    ].join('\n'),
  );

  it('takes the first matching rule, with an unanchored path regex', () => {
    expect(routeCloudflaredIngress(rules, 'a.example.com', '/v1/api/x/y')).toEqual({ ruleNumber: 1, service: 'http://localhost:1' });
    expect(routeCloudflaredIngress(rules, 'a.example.com', '/other')).toEqual({ ruleNumber: 2, service: 'http://localhost:2' });
  });

  it('matches wildcard hostnames and falls through to a host-less rule', () => {
    expect(routeCloudflaredIngress(rules, 'B.Example.com', '/')?.ruleNumber).toBe(2);
    expect(routeCloudflaredIngress(rules, 'example.org', '/')?.service).toBe('http_status:404');
  });

  it('returns null when nothing matches', () => {
    expect(routeCloudflaredIngress(rules.slice(0, 1), 'b.example.com', '/api/x')).toBeNull();
  });

  it('refuses a config without an ingress list or a rule without a service', () => {
    expect(() => parseCloudflaredIngressYaml('tunnel: x\n')).toThrow(/no ingress list/);
    expect(() => parseCloudflaredIngressYaml('ingress:\n  - hostname: a\n')).toThrow(/rule 1 has no service/);
  });

  it('treats loopback spellings of one port as the same service', () => {
    expect(sameIngressService('http://localhost:3880', 'http://127.0.0.1:3880/')).toBe(true);
    expect(sameIngressService('http://localhost:3880', 'http://localhost:3801')).toBe(false);
  });
});

describe('auditHostedIngressRules', () => {
  it('passes the current app.papercusp.com rules', () => {
    const result = audit(configYaml());
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(hostedIngressSamples().length);
  });

  it.each([
    ['WI-10003292 cli', ['cli']],
    ['P-014 F2 relay', ['relay-link']],
    // One rule carries the app routes AND the OAuth verbs, so losing it strands both families.
    ['WI-10004436 app relay + oauth', ['app-relay', 'mcp-oauth']],
    ['WI-10004436 well-known', ['mcp-oauth']],
    ['WI-10005066 workos webhook', ['workos-webhook']],
    ['WI-10007014 device relay', ['device-relay']],
  ])('flags the %s incident when its rule is missing', (rule, families) => {
    const findings = audit(configYaml([rule])).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((finding) => finding.family))).toEqual(new Set(families));
    for (const finding of findings) {
      expect(finding).toMatchObject({ problem: 'not-routed-to-control-plane', service: PORTAL });
    }
  });

  it('flags a deliberately unpublished family routed to the plane', () => {
    const findings = audit(configYaml([], ['^/api/hosted/workspaces/[^/]+/provider-delegations/'])).findings;
    expect(findings.length).toBe(4);
    expect(findings.every((finding) => finding.family === 'provider-delegations' && finding.problem === 'published-on-control-plane')).toBe(true);
  });

  it('flags a family when no rule routes it at all', () => {
    const findings = auditHostedIngressRules({ rules: [], hostname: HOST, controlPlaneService: PLANE }).findings;
    expect(findings.some((finding) => finding.family === 'workos-webhook' && finding.service === null)).toBe(true);
  });
});

describe('probeHostedPublicIngress', () => {
  it('flags only paths the portal session gate answered, and sends nothing but GETs', async () => {
    const methods = new Set<string>();
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await probeHostedPublicIngress({
      origin: 'https://app.papercusp.com/',
      workspaceId: 'ws-ingress-probe',
      fetch: async (url, init) => {
        methods.add(init?.method ?? 'GET');
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        const path = new URL(String(url)).pathname;
        if (path === '/api/auth/workos/webhook') {
          return new Response(JSON.stringify({ ok: false, error: PORTAL_SESSION_GATE_ERROR }), { status: 401 });
        }
        if (path.endsWith('/oauth/token')) {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
        }
        return new Response(JSON.stringify({ error: 'app_key_required' }), { status: 401 });
      },
    });
    expect([...methods]).toEqual(['GET']);
    expect(maxInFlight).toBeLessThanOrEqual(HOSTED_INGRESS_PROBE_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(result.checked).toBe(hostedIngressSamples().filter((sample) => sample.expect === 'control-plane').length);
    expect(result.findings).toEqual([
      expect.objectContaining({ family: 'workos-webhook', status: 401, problem: 'portal-session-gate' }),
      expect.objectContaining({ family: 'mcp-oauth', status: null, problem: 'unreachable', detail: 'fetch failed (ECONNREFUSED)' }),
    ]);
  });
});
