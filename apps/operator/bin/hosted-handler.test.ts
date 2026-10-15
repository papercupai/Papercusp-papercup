import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as desktopAudit from "@papercusp/operator-core/lib/desktop/desktop-audit";
import { createTextCollector } from "@papercusp/operator-core/lib/child-output";
import { BYOC_SEALED_PROTOCOL } from "@papercusp/operator-core/lib/workspace-host/byoc-sealed-channel";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { HostedWorkspaceConnectorGateway } from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-connector";
import { classifyHostedWorkspaceHosting, createHostedHandler, readAttachRequest } from "./hosted-handler";

describe('hosted relay hosting classification', () => {
  const record = (configuration: Record<string, unknown>) => ({
    hostedDelegation: { workspaceId: 'workspace-1', status: 'verified', configuration },
  });
  it('classifies customer GCP/AWS delegations as BYOC and explicit vendor hosts separately', () => {
    expect(classifyHostedWorkspaceHosting(record({ provider: 'gcp', source: { method: 'workload-identity' } }), 'workspace-1')).toBe('byoc');
    expect(classifyHostedWorkspaceHosting(record({ provider: 'aws', source: { method: 'customer-role' } }), 'workspace-1')).toBe('byoc');
    expect(classifyHostedWorkspaceHosting(record({ provider: 'gcp', source: { method: 'papercusp-hosted' } }), 'workspace-1')).toBe('papercusp');
    expect(classifyHostedWorkspaceHosting(record({ provider: 'aws', source: { method: 'customer-role' }, papercuspHosted: { hostId: 'host-1' } }), 'workspace-1')).toBe('papercusp');
  });
  it('fails closed for missing or mismatched delegation records', () => {
    expect(classifyHostedWorkspaceHosting(null, 'workspace-1')).toBeNull();
    expect(classifyHostedWorkspaceHosting(record({ provider: 'gcp', source: { method: 'workload-identity' } }), 'other')).toBeNull();
    expect(classifyHostedWorkspaceHosting({ hostedDelegation: {
      workspaceId: 'workspace-1', status: 'pending', configuration: { provider: 'gcp', source: { method: 'papercusp-hosted' } },
    } }, 'workspace-1')).toBeNull();
  });
});

describe("readAttachRequest", () => {
  const read = (query: string) => readAttachRequest(new Request(`https://h.example/api/hosted/connectors/socket${query}`));
  it("reads the D-418 operator-http relay kind", () => {
    expect(read("?kind=operator-http")).toEqual({ kind: "operator-http" });
  });
  it("keeps an absent or unknown kind a PTY", () => {
    expect(read("")).toEqual({});
    expect(read("?kind=operator-admin")).toEqual({});
  });
  it("still reads desktop attachments", () => {
    expect(read("?kind=desktop&desktopSessionId=s1&desktopMode=takeover"))
      .toEqual({ kind: "desktop", desktopSessionId: "s1", desktopMode: "takeover" });
  });
  it("reads the D-002 psu kind with its JSON argv", () => {
    const argv = encodeURIComponent(JSON.stringify(["--agent", "codex"]));
    expect(read(`?kind=psu&argv=${argv}`)).toEqual({ kind: "psu", argv: ["--agent", "codex"] });
    expect(read("?kind=psu")).toEqual({ kind: "psu" });
  });
  it("hands an unparseable psu argv on raw, so the broker refuses it instead of dropping it", () => {
    expect(read("?kind=psu&argv=--agent%20codex")).toEqual({ kind: "psu", argv: "--agent codex" });
  });
});

const servers: Array<ReturnType<typeof serve>> = [];
it('composes live session/membership checks on the existing connector broker', async () => {
  let active = true;
  const membership = { userId: 'user-1', organizationId: 'org-1', permissionVersion: 1,
    permissions: new Set(['workspace:operate']) };
  const plane = { app: new Hono(), mounted: [], components: {
    sessionStore: { resolve: async () => ({ id: 'session-1', userId: 'user-1', organizationId: 'org-1',
      workspaceId: 'workspace-1', permissionVersion: 1, revokedAt: null }) },
    membershipAuthority: { resolveActive: async () => active ? membership : null,
      workspaceBelongsToOrganization: async () => true },
  } } as unknown as AssembledHostedControlPlane;
  const hosted = createHostedHandler(plane, new Hono(), { controlPlaneWorkspaceId: 'control',
    resolveWorkspaceHosting: async () => 'papercusp', resolveCustomerWorkspaceHosting: async () => 'papercusp' });
  const host = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, frames: [] as Record<string, unknown>[],
    send(data: string | Buffer) { this.frames.push(JSON.parse(data.toString())); },
    close() { this.readyState = 3; host.emit('close'); } });
  const browser = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1,
    send() {}, close() { this.readyState = 3; browser.emit('close'); } });
  const binding = { controlPlaneWorkspaceId: 'control', organizationId: 'org-1', customerWorkspaceId: 'workspace-1',
    hostId: 'host-1', routeLabel: 'alpha', generation: 1, state: 'active' as const, transport: 'websocket' as const };
  hosted.relay.attachConnector(binding, host);
  hosted.relay.attachBrowser({ ...binding, kind: 'session', audience: 'workspace-operator', userId: 'user-1',
    hostedSessionId: 'session-1', expiresAt: new Date(Date.now() + 60_000) }, browser, { kind: 'operator-http' });
  const channelId = host.frames.find(m => m.type === 'relay.open')!.channelId;
  const requestId = '11111111-1111-4111-8111-111111111111';
  const query = () => host.emit('message', Buffer.from(JSON.stringify({ type: 'session.authorize', channelId, requestId })), false);
  query();
  await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({ type: 'session.authorized',
    authority: expect.objectContaining({ userId: 'user-1', sessionId: 'session-1', permissions: ['workspace:operate'] }) })));
  active = false; query();
  await vi.waitFor(() => expect(host.frames).toContainEqual({ type: 'session.authorized', channelId, requestId, authority: null }));
  browser.close(); host.close(); hosted.relay.dispose();
});

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function fixture(connectorGateway?: HostedWorkspaceConnectorGateway) {
  const api = new Hono().basePath("/api");
  api.get("/health", () => Response.json({ ok: true }));
  const plane = {
    app: api,
    mounted: [],
    components: connectorGateway ? { connectorGateway } : {},
  } as unknown as AssembledHostedControlPlane;
  const spa = new Hono();
  spa.get(
    "*",
    () =>
      new Response("<html>hosted-spa</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
  return createHostedHandler(plane, spa, {
    resolveWorkspaceHosting: async () => 'papercusp',
    resolveCustomerWorkspaceHosting: async () => 'papercusp',
  });
}

describe("hosted handler", () => {
  it.each(['byoc', 'papercusp'] as const)('censuses %s desktop audit and liveness warning applicability through the composed broker', async (hosting) => {
    const marker = 'CUSTOMER_AUDIT_CONTENT_7d31';
    const hostPayload = 'CUSTOMER_FRAME_CONTENT_b884';
    const databaseError = new DrizzleQueryError('insert into audit_log (details) values ($1)', [marker], new Error('constraint failure'));
    const gateway = { recordLiveness: vi.fn<HostedWorkspaceConnectorGateway['recordLiveness']>(async (_binding, _alive, onError) => { onError?.(databaseError); }) } as unknown as HostedWorkspaceConnectorGateway;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audit = vi.spyOn(desktopAudit, 'recordDesktopAudit').mockImplementation((_event, deps) => { deps!.onError!(databaseError); });
    const hosted = fixture(gateway);
    const host = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, frames: [] as Record<string, unknown>[],
      send(data: string | Buffer) { this.frames.push(JSON.parse(data.toString())); },
      close() { this.readyState = 3; host.emit('close'); } });
    const browser = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1,
      send() {}, close() { this.readyState = 3; browser.emit('close'); } });
    const binding = { controlPlaneWorkspaceId: 'control', organizationId: 'org-1', customerWorkspaceId: 'workspace-1',
      hostId: 'host-1', routeLabel: 'alpha', generation: 1, state: 'active' as const, transport: 'websocket' as const, hosting };
    try {
      hosted.relay.attachConnector(binding, host);
      hosted.relay.attachBrowser({ ...binding, kind: 'session', audience: 'workspace-operator', userId: 'user-1',
        hostedSessionId: 'session-1', expiresAt: new Date(Date.now() + 60_000) }, browser,
      { kind: 'desktop', desktopSessionId: marker, desktopMode: 'watch' });
      const open = host.frames.find((frame) => frame.type === 'relay.open');
      if (hosting === 'byoc') {
        expect(open).toBeUndefined();
        expect(browser.readyState).toBe(3);
        expect(audit).not.toHaveBeenCalled();
      } else {
        expect(open).toBeDefined();
        host.emit('message', Buffer.from(JSON.stringify({ type: 'relay', channelId: open!.channelId,
          payload: { type: 'desktop.ready', action: 'watch', detail: hostPayload } })), false);
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ detail: `desktop=${marker}` }) }),
          expect.objectContaining({ idPrefix: 'hosted-relay-vnc' }));
        expect(JSON.stringify(audit.mock.calls.map(([event]) => event))).not.toContain(hostPayload);
      }
      // Both hosting classes report connector liveness through the actual handler callback.
      expect(gateway.recordLiveness).toHaveBeenCalled();
      expect(warning.mock.calls).toContainEqual(['[hosted-relay] connector liveness write failed:', 'connector_alive_write_failed']);
      if (hosting === 'papercusp') expect(warning.mock.calls).toContainEqual(['[hosted-relay] desktop audit write failed:', 'desktop_audit_write_failed']);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('insert into');
      expect(JSON.stringify(warning.mock.calls)).not.toContain(hostPayload);
    } finally {
      browser.close(); host.close(); hosted.relay.dispose(); audit.mockRestore(); warning.mockRestore();
    }
  });

  it("refuses an offline sealed phone before WebSocket upgrade with a typed 503", async () => {
    const hosted = fixture();
    const server = serve({ fetch: hosted.handler, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    server.on("upgrade", (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => { if (!handled) socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server not listening");
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/workspaces/missing/api/device/sealed`);
    const refusal = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      websocket.once("unexpected-response", (_request, response) => {
        const body = createTextCollector(response);
        response.on("end", () => { websocket.terminate(); resolve({ status: response.statusCode!, body: body.text() }); });
      });
      websocket.on("error", () => {});
      websocket.once("open", () => reject(new Error("offline ingress upgraded")));
    });
    expect(refusal.status).toBe(503);
    expect(JSON.parse(refusal.body)).toEqual({ ok: false, error: "workspace_offline" });
    hosted.relay.dispose();
  });

  it.each(['byoc', 'papercusp'] as const)("upgrades the %s sealed phone route without a portal ticket and refuses plaintext on the native transport", async (hosting) => {
    const hosted = fixture(); // No connector gateway: phone auth is on the VM.
    const connector = Object.assign(new EventEmitter(), {
      OPEN: 1, readyState: 1, frames: [] as Record<string, unknown>[],
      send(data: string | Buffer) { this.frames.push(JSON.parse(data.toString())); },
      close() { this.readyState = 3; connector.emit("close"); },
    });
    const binding = {
      controlPlaneWorkspaceId: "control", organizationId: "org-1",
      customerWorkspaceId: "workspace-1", hostId: "host-1", routeLabel: hosting,
      generation: 1, transport: "websocket" as const, state: "active" as const, hosting,
    };
    hosted.relay.attachConnector(binding, connector);
    const server = serve({ fetch: hosted.handler, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    server.on("upgrade", (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => { if (!handled) socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server not listening");
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/workspaces/workspace-1/api/device/sealed`);
    await new Promise<void>((resolve, reject) => { websocket.once("open", resolve); websocket.once("error", reject); });
    expect(connector.frames).toContainEqual(expect.objectContaining({ type: "relay.open", kind: "device-http", audience: "device", sealed: true }));
    const packet = { type: "sealed.packet", protocol: BYOC_SEALED_PROTOCOL, contentType: null, packet: "YWJj" };
    websocket.send(JSON.stringify(packet));
    const forwarded = await new Promise<Record<string, unknown>>((resolve) => {
      const check = () => {
        const frame = connector.frames.find((value) => value.type === "relay");
        if (frame) resolve(frame);
        else setImmediate(check);
      };
      check();
    });
    expect(forwarded.payload).toEqual(packet);
    const closed = new Promise<number>((resolve) => websocket.once("close", resolve));
    websocket.send(JSON.stringify({ type: "http.request", path: "/api/device/heartbeat" }));
    expect(await closed).toBe(4403);
    connector.close();
    hosted.relay.dispose();
  });

  it("refuses offline BYOC portal and OAuth content paths through the server hosting resolver", async () => {
    const api = new Hono().basePath('/api');
    const plane = { app: api, mounted: [], components: {} } as unknown as AssembledHostedControlPlane;
    const resolved: string[] = [];
    const hosted = createHostedHandler(plane, new Hono(), {
      resolveWorkspaceHosting: async () => 'byoc',
      resolveCustomerWorkspaceHosting: async (id) => { resolved.push(id); return 'byoc'; },
    });
    for (const path of ['/api/workspaces/workspace-1/mcp', '/api/workspaces/workspace-1/oauth/token']) {
      const response = await hosted.handler(new Request(`https://app.papercusp.com${path}`, {
        method: 'POST', body: 'BYOC_SECRET',
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'byoc_plaintext_relay_refused',
        alternatives: ['customer_controlled_ingress', 'sealed_channel'],
      });
    }
    expect(resolved).toEqual(['workspace-1', 'workspace-1']);
  });

  it("serves the hosted API and existing SPA from one origin", async () => {
    const hosted = fixture();
    const health = await hosted.handler(
      new Request("https://app.papercusp.com/api/health"),
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const shell = await hosted.handler(
      new Request("https://app.papercusp.com/cloud-workspaces"),
    );
    expect(shell.status).toBe(200);
    await expect(shell.text()).resolves.toContain("hosted-spa");
  });

  it.each([
    ["POST", "/api/auth/login"],
    ["GET", "/api/agent-mcp/tools"],
    ["GET", "/api/files/read"],
    ["GET", "/api/pty"],
    ["GET", "/api/provision/status"],
    ["GET", "/internal/docs/secret"],
    ["GET", "/docs/operator"],
    ["GET", "/wiki"],
    ["GET", "/drizzle-studio"],
  ])("does not mount the local %s %s surface", async (method, pathname) => {
    const response = await fixture().handler(
      new Request(`https://app.papercusp.com${pathname}`, { method }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("hosted-spa");
  });

  it("keeps an unknown API path out of the SPA fallback", async () => {
    const response = await fixture().handler(
      new Request("https://app.papercusp.com/api/not-mounted"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("hosted-spa");
  });

  it("authenticates and binds a native WebSocket on the real HTTP upgrade transport", async () => {
    const binding = {
      controlPlaneWorkspaceId: "control",
      organizationId: "org-1",
      customerWorkspaceId: "workspace-1",
      hostId: "host-1",
      routeLabel: "alpha",
      generation: 4,
      transport: "websocket" as const,
      state: "active" as const,
    };
    const gateway = new HostedWorkspaceConnectorGateway({
      authenticate: async () => binding,
      recordLiveness: async () => true,
    } as never);
    const hosted = fixture(gateway);
    const server = serve({ fetch: hosted.handler, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    server.on("upgrade", (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => { if (!handled) socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const bearer = `hc_${"A".repeat(43)}`;
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`, {
      headers: { authorization: `Bearer ${bearer}`, host: "alpha.workspaces.papercusp.com" },
    });
    const message = await new Promise<string>((resolve, reject) => {
      websocket.once("message", (value) => resolve(value.toString()));
      websocket.once("error", reject);
    });
    expect(JSON.parse(message)).toEqual(expect.objectContaining({
      type: "bound",
      role: "connector",
      protocol: "papercusp-hosted-workspace.v1",
      binding: { ...binding, hosting: 'papercusp' },
    }));
    await new Promise<void>((resolve) => {
      websocket.once("close", resolve);
      websocket.close();
    });
  });

  // P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29): on the real `ws` transport, a
  // connector that answers pings stays and is stamped alive; one that has gone silent is
  // terminated and stamped gone, so the CLI stops calling its machine reachable.
  it("pings connectors over the real transport, stamps liveness, and terminates a silent one", async () => {
    const binding = {
      controlPlaneWorkspaceId: "control",
      organizationId: "org-1",
      customerWorkspaceId: "workspace-1",
      hostId: "host-1",
      routeLabel: "alpha",
      generation: 5,
      transport: "websocket" as const,
      state: "active" as const,
    };
    const stamps: boolean[] = [];
    const gateway = new HostedWorkspaceConnectorGateway({
      authenticate: async () => binding,
      recordLiveness: async (_binding: unknown, alive: boolean) => { stamps.push(alive); return true; },
    } as never);
    const hosted = fixture(gateway);
    const server = serve({ fetch: hosted.handler, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    server.on("upgrade", (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => { if (!handled) socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    const until = async (predicate: () => boolean) => {
      for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    const dial = (autoPong: boolean) => new Promise<WebSocket>((resolve, reject) => {
      const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`, {
        headers: { authorization: `Bearer hc_${"A".repeat(43)}`, host: "alpha.workspaces.papercusp.com" },
        autoPong,
      });
      websocket.once("message", () => resolve(websocket));
      websocket.once("error", reject);
    });

    const healthy = await dial(true);
    await until(() => stamps.length === 1);
    hosted.relay.sweepLiveness();
    await until(() => stamps.length === 2);
    hosted.relay.sweepLiveness();
    await until(() => stamps.length === 3);
    expect(stamps).toEqual([true, true, true]);
    expect(healthy.readyState).toBe(WebSocket.OPEN);

    // A second socket for the same generation replaces the first; now make it go silent.
    const silent = await dial(false);
    await until(() => healthy.readyState === WebSocket.CLOSED);
    const closed = new Promise<number>((resolve) => silent.once("close", (code) => resolve(code)));
    hosted.relay.sweepLiveness();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(silent.readyState).toBe(WebSocket.OPEN);
    hosted.relay.sweepLiveness();
    // terminate() drops TCP without a close frame: the client sees 1006.
    expect(await closed).toBe(1006);
    await until(() => stamps.at(-1) === false);
    hosted.relay.dispose();
  });
});
