/**
 * external-app-access P-009 (WI-10004020): the own-tunnel service and its reconciler, driven
 * through fake dependencies — an in-memory row, a recording listener seam and connector, and
 * a fake Cloudflare API. Covers who acts (listener gate, connector gate, adoption of a moved
 * operator port), the kill switch, provisioning (sign-in label, full hostname, pasted token)
 * and removal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudflareApi } from './cloudflare-api';
import type { ArgoTunnelLogin } from './config';
import type { ConnectorStatus } from './runtime';
import {
  CONNECTOR_RESTART_BACKOFF_MS,
  ownTunnelStatus,
  provisionOwnTunnel,
  reconcileOwnTunnel,
  removeOwnTunnel,
  resetOwnTunnelServiceStateForTests,
  setOwnTunnelEnabledNow,
  useManualTunnel,
  type OwnTunnelDeps,
} from './service';
import type { OwnTunnelRow, SaveCloudflareTunnel } from './store';

const OP_PORT = 3070;
const RUN_TOKEN = 'run-token-'.padEnd(48, 'x');

function cloudflareRow(over: Partial<OwnTunnelRow> = {}): OwnTunnelRow {
  return {
    mode: 'cloudflare',
    enabled: true,
    ingressPort: 45123,
    operatorPort: OP_PORT,
    hostname: 'papercusp.example.com',
    cfAccountId: 'acct-1',
    cfZoneId: 'zone-1',
    cfZoneName: 'example.com',
    cfTunnelId: 'tun-1',
    cfTunnelName: 'papercusp-box',
    cfDnsRecordId: 'dns-1',
    lastError: null,
    lastErrorAt: null,
    updatedAt: new Date(0),
    ...over,
  };
}

interface Harness {
  deps: OwnTunnelDeps;
  row: { current: OwnTunnelRow | null };
  secrets: { apiToken: string | null; runToken: string | null };
  listenerCalls: Array<number | null>;
  connectorStarts: Array<{ token: string; bin: string }>;
  connectorStops: number;
  errors: Array<string | null>;
  saved: SaveCloudflareTunnel[];
  adopted: number[];
  removed: number;
  clock: { now: number };
  connector: { running: boolean; startedAt: string | null; exit: ConnectorStatus['exit'] };
  apiCalls: string[];
  putConfigs: unknown[];
  signIn: { login: ArgoTunnelLogin | null; cleared: number };
}

function makeApi(h: Pick<Harness, 'apiCalls' | 'putConfigs'>, opts: { failDelete?: boolean } = {}): CloudflareApi {
  const log = (name: string) => h.apiCalls.push(name);
  return {
    getZone: async (id: string) => {
      log(`getZone:${id}`);
      return { id, name: 'example.com', account: { id: 'acct-1' } };
    },
    findZoneByName: async (name: string) => {
      log(`findZoneByName:${name}`);
      return name === 'example.com' ? { id: 'zone-1', name, account: { id: 'acct-9' } } : null;
    },
    listTunnelsByName: async () => [],
    getTunnel: async () => ({ id: 'tun-1', name: 'papercusp-box' }),
    createTunnel: async (_a: string, name: string) => {
      log(`createTunnel:${name}`);
      return { id: 'tun-1', name };
    },
    putTunnelConfig: async (_a: string, _t: string, config: unknown) => {
      h.putConfigs.push(config);
      return {};
    },
    getTunnelToken: async () => RUN_TOKEN,
    cleanupConnections: async () => ({}),
    deleteTunnel: async () => {
      log('deleteTunnel');
      if (opts.failDelete) {
        const { CloudflareApiError } = await import('./cloudflare-api');
        throw new CloudflareApiError(500, 'cloudflare is down', null);
      }
      return {};
    },
    listDnsRecords: async () => [],
    createCname: async (_z: string, name: string, content: string) => ({ id: 'dns-1', type: 'CNAME', name, content }),
    deleteDnsRecord: async () => ({}),
  } as unknown as CloudflareApi;
}

function harness(opts: {
  row?: OwnTunnelRow | null;
  owner?: boolean;
  serves?: boolean;
  env?: NodeJS.ProcessEnv;
  bin?: string | null;
  operatorAnswers?: boolean;
  failDelete?: boolean;
} = {}): Harness {
  const h = {
    row: { current: opts.row === undefined ? cloudflareRow() : opts.row },
    secrets: { apiToken: 'api-token', runToken: RUN_TOKEN },
    listenerCalls: [] as Array<number | null>,
    connectorStarts: [] as Array<{ token: string; bin: string }>,
    connectorStops: 0,
    errors: [] as Array<string | null>,
    saved: [] as SaveCloudflareTunnel[],
    adopted: [] as number[],
    removed: 0,
    clock: { now: 1_000_000 },
    connector: { running: false, startedAt: null as string | null, exit: null as ConnectorStatus['exit'] },
    apiCalls: [] as string[],
    putConfigs: [] as unknown[],
    signIn: { login: null as ArgoTunnelLogin | null, cleared: 0 },
  } as Harness;
  let listenerPort: number | null = null;
  h.deps = {
    store: {
      read: async () => h.row.current,
      readSecrets: async () => h.secrets,
      saveCloudflare: async (t) => {
        h.saved.push(t);
        h.secrets = { apiToken: t.apiToken, runToken: t.runToken };
        h.row.current = cloudflareRow({
          ingressPort: t.ingressPort,
          operatorPort: t.operatorPort,
          hostname: t.hostname,
          cfAccountId: t.accountId,
          cfZoneId: t.zoneId,
          cfZoneName: t.zoneName,
          cfTunnelId: t.tunnelId,
          cfTunnelName: t.tunnelName,
          cfDnsRecordId: t.dnsRecordId,
        });
      },
      saveManual: async (t) => {
        h.secrets = { apiToken: null, runToken: null };
        h.row.current = cloudflareRow({
          mode: 'manual',
          ingressPort: t.ingressPort,
          operatorPort: t.operatorPort,
          hostname: t.hostname ?? null,
          cfAccountId: null,
          cfZoneId: null,
          cfZoneName: null,
          cfTunnelId: null,
          cfTunnelName: null,
          cfDnsRecordId: null,
        });
      },
      setEnabled: async (enabled) => {
        if (!h.row.current) return false;
        h.row.current = { ...h.row.current, enabled };
        return true;
      },
      recordError: async (message) => {
        h.errors.push(message);
        if (h.row.current) h.row.current = { ...h.row.current, lastError: message };
      },
      setOperatorPort: async (port) => {
        h.adopted.push(port);
        if (h.row.current) h.row.current = { ...h.row.current, operatorPort: port };
      },
      remove: async () => {
        h.removed++;
        h.row.current = null;
      },
    },
    api: () => makeApi(h, { failDelete: opts.failDelete }),
    env: opts.env ?? { PAPERCUSP_HONO_PORT: String(OP_PORT) },
    isConnectorOwner: () => opts.owner ?? true,
    servesRequests: () => opts.serves ?? true,
    ensureListener: async (port) => {
      h.listenerCalls.push(port);
      listenerPort = port;
      return true;
    },
    listenerPort: () => listenerPort,
    connector: {
      running: () => h.connector.running,
      status: () => ({
        running: h.connector.running,
        pid: h.connector.running ? 4242 : null,
        taskId: null,
        startedAt: h.connector.startedAt,
        exit: h.connector.exit,
        logTail: ['ERR failed to connect'],
      }),
      start: async (token, bin) => {
        h.connectorStarts.push({ token, bin });
        h.connector.running = true;
        h.connector.startedAt = new Date(h.clock.now).toISOString();
        h.connector.exit = null;
      },
      stop: async () => {
        h.connectorStops++;
        h.connector.running = false;
      },
    },
    cloudflaredBin: () => (opts.bin === undefined ? '/opt/cloudflared' : opts.bin),
    signIn: {
      completed: () => h.signIn.login,
      clear: () => {
        h.signIn.cleared++;
        h.signIn.login = null;
      },
    },
    pickFreePort: async (avoid) => {
      expect(avoid).toContain(OP_PORT);
      return 47001;
    },
    operatorAnswers: async () => opts.operatorAnswers ?? false,
    installLabel: () => 'Avi’s Box',
    now: () => h.clock.now,
  };
  return h;
}

beforeEach(() => resetOwnTunnelServiceStateForTests());

describe('reconcileOwnTunnel — who acts', () => {
  it('opens the listener on the row ingress port and starts cloudflared with the run token', async () => {
    const h = harness();
    const r = await reconcileOwnTunnel(h.deps);
    expect(r).toMatchObject({ listener: 'open', connector: 'started', error: null });
    expect(h.listenerCalls).toEqual([45123]);
    expect(h.connectorStarts).toEqual([{ token: RUN_TOKEN, bin: '/opt/cloudflared' }]);
  });

  it('a second operator on the same database (different port) never opens the listener', async () => {
    const h = harness({ env: { PAPERCUSP_HONO_PORT: '3170' }, owner: false });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.listener).toBe('closed');
    expect(h.listenerCalls).toEqual([null]);
    expect(r.connector).toBe('not-owner');
    expect(h.connectorStarts).toEqual([]);
  });

  it('a process that is not the host singleton never runs cloudflared', async () => {
    const h = harness({ owner: false });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r).toMatchObject({ listener: 'open', connector: 'not-owner' });
    expect(h.connectorStarts).toEqual([]);
  });

  it('a process that does not serve requests leaves the listener alone', async () => {
    const h = harness({ serves: false });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.listener).toBe('not-serving');
    expect(h.listenerCalls).toEqual([]);
    expect(r.connector).toBe('started');
  });

  it('PAPERCUSP_EXTERNAL_INGRESS_PORT wins: the static listener is never opened or closed here', async () => {
    const h = harness({ env: { PAPERCUSP_HONO_PORT: String(OP_PORT), PAPERCUSP_EXTERNAL_INGRESS_PORT: '9999' } });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.listener).toBe('static');
    expect(h.listenerCalls).toEqual([]);
    expect((await ownTunnelStatus(h.deps)).ingressPort).toBe(9999);
  });

  it('adopts the tunnel when the recorded operator port no longer answers (desktop port hint moved)', async () => {
    const h = harness({
      row: cloudflareRow({ operatorPort: 51000 }),
      env: { PAPERCUSP_HONO_PORT: String(OP_PORT), PAPERCUSP_DESKTOP: '1' },
      operatorAnswers: false,
    });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.adoptedOperatorPort).toBe(OP_PORT);
    expect(h.adopted).toEqual([OP_PORT]);
    expect(r.listener).toBe('open');
  });

  it('does not adopt while the recorded operator still answers (dev box staging vs release)', async () => {
    const h = harness({ row: cloudflareRow({ operatorPort: 51000 }), operatorAnswers: true });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.adoptedOperatorPort).toBeNull();
    expect(h.adopted).toEqual([]);
    expect(r.listener).toBe('closed');
  });

  it.each(['manual', 'cloudflare'] as const)('preserves the configured %s listener owner through a server health gap', async (mode) => {
    const serving = harness({
      row: cloudflareRow({ mode, operatorPort: 3170 }),
      env: { PAPERCUSP_HONO_PORT: '3170' },
      owner: false,
    });
    expect((await reconcileOwnTunnel(serving.deps)).listener).toBe('open');

    // Background ownership allows running cloudflared, not taking the serving
    // operator's listener when /api/health times out during its restart.
    const background = harness({ env: { PAPERCUSP_HONO_PORT: '3271' }, operatorAnswers: false });
    background.row = serving.row;
    const gap = await reconcileOwnTunnel(background.deps);
    expect(gap.adoptedOperatorPort).toBeNull();
    expect(background.adopted).toEqual([]);
    expect(background.listenerCalls).toEqual([null]);
    expect(serving.row.current?.operatorPort).toBe(3170);

    const recovered = await reconcileOwnTunnel(serving.deps);
    expect(recovered).toMatchObject({ listener: 'open', error: null });
    expect(serving.listenerCalls).toEqual([45123, 45123]);
  });

  it('does not move desktop custody while its previous operator still answers', async () => {
    const h = harness({
      row: cloudflareRow({ operatorPort: 51000 }),
      env: { PAPERCUSP_HONO_PORT: String(OP_PORT), PAPERCUSP_DESKTOP: '1' },
      operatorAnswers: true,
    });
    expect((await reconcileOwnTunnel(h.deps)).adoptedOperatorPort).toBeNull();
    expect(h.adopted).toEqual([]);
    expect(h.listenerCalls).toEqual([null]);
  });

  it('records a missing cloudflared binary as the row error', async () => {
    const h = harness({ bin: null });
    const r = await reconcileOwnTunnel(h.deps);
    expect(r.connector).toBe('missing-binary');
    expect(h.errors.at(-1)).toMatch(/cloudflared is not installed/);
  });

  it('clears a manual listener failure only after the serving operator successfully reopens it', async () => {
    const h = harness({ row: cloudflareRow({ mode: 'manual' }), owner: false });
    const ensureListener = h.deps.ensureListener;
    let fail = true;
    const deps: OwnTunnelDeps = {
      ...h.deps,
      ensureListener: async (port) => {
        if (fail) throw new Error('EADDRINUSE');
        return ensureListener(port);
      },
    };

    expect((await reconcileOwnTunnel(deps)).listener).toBe('failed');
    expect(await ownTunnelStatus(deps)).toMatchObject({ health: 'down', listening: false });
    expect(h.row.current?.lastError).toContain('EADDRINUSE');
    fail = false;

    expect(await reconcileOwnTunnel(deps)).toMatchObject({ listener: 'open', error: null });
    expect(await ownTunnelStatus(deps)).toMatchObject({ health: 'up', listening: true, lastError: null });
    expect(h.errors.at(-1)).toBeNull();
  });

  it.each([
    { name: 'another operator', row: { operatorPort: 51000 }, env: {}, serves: true },
    { name: 'a disabled tunnel', row: { enabled: false }, env: {}, serves: true },
    { name: 'a non-serving process', row: {}, env: {}, serves: false },
    { name: 'an externally managed listener', row: {}, env: { PAPERCUSP_EXTERNAL_INGRESS_PORT: '9999' }, serves: true },
  ])('retains the manual error without observed recovery: $name', async ({ row, env, serves }) => {
    const h = harness({
      row: cloudflareRow({ mode: 'manual', lastError: 'listener failed', ...row }),
      env: { PAPERCUSP_HONO_PORT: String(OP_PORT), ...env },
      serves,
    });
    await reconcileOwnTunnel(h.deps);
    expect(h.row.current?.lastError).toBe('listener failed');
    expect(h.errors).toEqual([]);
  });

  it('retains a Cloudflare error until the connector has demonstrated healthy operation', async () => {
    const h = harness({ row: cloudflareRow({ lastError: 'cloudflared exited' }) });
    await reconcileOwnTunnel(h.deps);
    await reconcileOwnTunnel(h.deps);
    expect(h.row.current?.lastError).toBe('cloudflared exited');
    expect(h.errors).toEqual([]);
  });

  it('backs off after cloudflared exits, reports why, then restarts', async () => {
    const h = harness();
    await reconcileOwnTunnel(h.deps);
    h.connector.running = false;
    h.connector.exit = { code: 1, signal: null, at: new Date(h.clock.now).toISOString() };
    h.clock.now += 1_000;
    const backoff = await reconcileOwnTunnel(h.deps);
    expect(backoff.connector).toBe('backoff');
    expect(h.errors.at(-1)).toMatch(/cloudflared exited \(code 1\): ERR failed to connect/);
    h.clock.now += CONNECTOR_RESTART_BACKOFF_MS;
    const restarted = await reconcileOwnTunnel(h.deps);
    expect(restarted.connector).toBe('started');
    expect(h.connectorStarts).toHaveLength(2);
  });
});

describe('kill switch', () => {
  it('off closes the listener and stops cloudflared at once; on brings both back', async () => {
    const h = harness();
    await reconcileOwnTunnel(h.deps);
    const off = await setOwnTunnelEnabledNow(false, h.deps);
    expect(off).toMatchObject({ enabled: false, health: 'off', listening: false });
    expect(h.listenerCalls.at(-1)).toBeNull();
    expect(h.connectorStops).toBe(1);
    const on = await setOwnTunnelEnabledNow(true, h.deps);
    expect(on.enabled).toBe(true);
    expect(h.listenerCalls.at(-1)).toBe(45123);
    expect(h.connectorStarts).toHaveLength(2);
  });

  it('refuses when no tunnel is set up', async () => {
    const h = harness({ row: null });
    await expect(setOwnTunnelEnabledNow(false, h.deps)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('provisionOwnTunnel', () => {
  it('one-click sign-in + a label: hostname is <label>.<zone>, ingress targets the picked loopback port', async () => {
    const h = harness({ row: null });
    h.signIn.login = { accountId: 'acct-1', zoneId: 'zone-1', apiToken: 'login-api-token' };
    const status = await provisionOwnTunnel({ label: 'papercusp' }, h.deps);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      hostname: 'papercusp.example.com',
      ingressPort: 47001,
      operatorPort: OP_PORT,
      accountId: 'acct-1',
      zoneId: 'zone-1',
      apiToken: 'login-api-token',
      runToken: RUN_TOKEN,
      tunnelName: 'papercusp-avi-s-box',
    });
    expect(h.putConfigs[0]).toEqual({
      ingress: [{ hostname: 'papercusp.example.com', service: 'http://127.0.0.1:47001' }, { service: 'http_status:404' }],
    });
    expect(h.signIn.cleared).toBe(1);
    expect(status).toMatchObject({
      configured: true,
      mode: 'cloudflare',
      mcpUrl: 'https://papercusp.example.com/api/mcp',
      ingressPort: 47001,
      servedByThisOperator: true,
      listening: true,
    });
    expect(h.connectorStarts).toEqual([{ token: RUN_TOKEN, bin: '/opt/cloudflared' }]);
  });

  it('a pasted API token finds the zone and account from the hostname', async () => {
    const h = harness({ row: null });
    await provisionOwnTunnel({ hostname: 'https://Tunnel.Example.com/', apiToken: ' pasted ' }, h.deps);
    expect(h.apiCalls).toContain('findZoneByName:example.com');
    expect(h.saved[0]).toMatchObject({ hostname: 'tunnel.example.com', accountId: 'acct-9', zoneId: 'zone-1', apiToken: 'pasted' });
  });

  it('keeps the existing ingress port on a re-run', async () => {
    const h = harness();
    await provisionOwnTunnel({ hostname: 'papercusp.example.com', apiToken: 'pasted' }, h.deps);
    expect(h.saved[0]!.ingressPort).toBe(45123);
  });

  it('refuses without a sign-in or a token, and a pasted token needs a full hostname', async () => {
    const h = harness({ row: null });
    await expect(provisionOwnTunnel({ label: 'x' }, h.deps)).rejects.toMatchObject({ code: 'not_signed_in' });
    await expect(provisionOwnTunnel({ apiToken: 't' }, h.deps)).rejects.toMatchObject({ code: 'hostname_required' });
  });
});

describe('useManualTunnel and removeOwnTunnel', () => {
  it('manual mode opens the listener but never runs cloudflared', async () => {
    const h = harness({ row: null });
    const status = await useManualTunnel({}, h.deps);
    expect(status).toMatchObject({ mode: 'manual', ingressPort: 47001, ingressTarget: 'http://127.0.0.1:47001', listening: true });
    expect(h.connectorStarts).toEqual([]);
  });

  it('manual mode refuses the operator port as the ingress port', async () => {
    const h = harness({ row: null });
    await expect(useManualTunnel({ port: OP_PORT }, h.deps)).rejects.toMatchObject({ code: 'ingress_is_operator_port' });
  });

  it('switching a Cloudflare tunnel to manual deletes the Cloudflare side first', async () => {
    const h = harness();
    await useManualTunnel({ port: 46000 }, h.deps);
    expect(h.apiCalls).toContain('deleteTunnel');
    expect(h.row.current?.mode).toBe('manual');
  });

  it('remove stops the tunnel, deletes it in Cloudflare, then deletes the row', async () => {
    const h = harness();
    await reconcileOwnTunnel(h.deps);
    const r = await removeOwnTunnel({}, h.deps);
    expect(r).toEqual({ removed: true, cloudflare: 'done', error: null });
    expect(h.connectorStops).toBe(1);
    expect(h.removed).toBe(1);
    expect(h.listenerCalls.at(-1)).toBeNull();
  });

  it('remove keeps the disabled row when Cloudflare fails, so the user can retry', async () => {
    const h = harness({ failDelete: true });
    const r = await removeOwnTunnel({ keepIfCloudflareFails: true }, h.deps);
    expect(r).toMatchObject({ removed: false, cloudflare: 'failed' });
    expect(h.removed).toBe(0);
    expect(h.row.current?.enabled).toBe(false);
    expect(h.errors.at(-1)).toMatch(/removing the tunnel from Cloudflare failed/);
  });
});
