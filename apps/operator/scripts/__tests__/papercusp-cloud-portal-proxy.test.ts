import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import http from "node:http";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PROXY = resolve(__dirname, "../systemd/papercusp-cloud-portal-proxy.mjs");

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

describe("Cloud Portal stable front-door proxy", () => {
  it.each(["GET", "POST"])("protects failed invite requests using %s", async (method) => {
    const targetPort = await reservePort();
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?invite-${method}`);
    const proxy: Server = createPortalProxy({ targetPort, retryWindowMs: 50, retryDelayMs: 10 });
    const proxyPort = await listen(proxy);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/phone/invite/private-invite/join`, {
        method,
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(await response.text()).not.toContain("private-invite");
      expect(errorLog.mock.calls.flat().join(" ")).toContain("ECONNREFUSED");
    } finally {
      errorLog.mockRestore();
      await close(proxy);
    }
  });

  it("does not log credential-bearing transport error messages or arbitrary codes", async () => {
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?private-error`);
    const proxy: Server = createPortalProxy({ targetPort: await reservePort() });
    const proxyPort = await listen(proxy);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = vi.spyOn(http, "request").mockImplementation(() => {
      const request = new PassThrough();
      request.once("finish", () => request.emit("error", Object.assign(
        new Error("failed /invite/private-invite with Bearer private-bearer"),
        { code: "private-error-code" },
      )));
      return request as unknown as ReturnType<typeof http.request>;
    });
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/phone/invite/private-invite/join`, {
        method: "POST",
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("upstream unavailable");
      const logged = errorLog.mock.calls.flat().join(" ");
      expect(logged).toContain("upstream_error");
      expect(logged).not.toContain("private-invite");
      expect(logged).not.toContain("private-bearer");
      expect(logged).not.toContain("private-error-code");
    } finally {
      transport.mockRestore();
      errorLog.mockRestore();
      await close(proxy);
    }
  });

  it("holds a safe GET through a bounded backend handoff instead of surfacing 502", async () => {
    const targetPort = await reservePort();
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: ready\ndata: ok\n\n");
    });
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?get-retry`);
    const proxy: Server = createPortalProxy({ targetPort, retryWindowMs: 1_500, retryDelayMs: 20 });
    const proxyPort = await listen(proxy);

    try {
      const responsePromise = fetch(`http://127.0.0.1:${proxyPort}/api/operator-sync/sse`);
      await delay(100);
      await listen(upstream, targetPort);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("event: ready");
    } finally {
      await close(proxy);
      await close(upstream);
    }
  });

  it("does not replay a state-changing request when the backend is unavailable", async () => {
    const targetPort = await reservePort();
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?post-no-retry`);
    const proxy: Server = createPortalProxy({ targetPort, retryWindowMs: 1_000, retryDelayMs: 20 });
    const proxyPort = await listen(proxy);
    const startedAt = Date.now();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/write`, {
        method: "POST",
        body: "payload",
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("upstream unavailable");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      await close(proxy);
    }
  });

  // WI-10003268: deploy-cloud-portal.sh installs the proxy into ~/.local/bin, outside every
  // node_modules tree. A workspace import resolved fine here and in the repo, then crash-looped
  // :3081 with ERR_MODULE_NOT_FOUND the first time the installed copy was started.
  it("starts as a standalone program copied outside every node_modules tree", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "portal-proxy-install-"));
    const installed = join(installDir, "papercusp-cloud-portal-proxy.mjs");
    copyFileSync(PROXY, installed);
    // Control: the copy must sit where workspace packages do NOT resolve, or this test
    // would pass even with the workspace import back in place.
    expect(() => createRequire(installed).resolve("@papercusp/operator-core/package.json")).toThrow();

    const listenPort = await reservePort();
    const child = spawn(process.execPath, [installed], {
      cwd: installDir,
      env: {
        ...process.env,
        PAPERCUSP_CLOUD_PORTAL_PROXY_LISTEN_PORT: String(listenPort),
        PAPERCUSP_CLOUD_PORTAL_PROXY_TARGET_PORT: String(await reservePort()),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    try {
      const deadline = Date.now() + 5_000;
      while (!output.includes("front door listening") && child.exitCode === null && Date.now() < deadline) {
        await delay(25);
      }
      expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(output).toContain(`front door listening on http://127.0.0.1:${listenPort}/`);
    } finally {
      child.kill();
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});
