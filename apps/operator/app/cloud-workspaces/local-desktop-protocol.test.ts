import { describe, expect, it, vi } from "vitest";
import {
  localDesktopThumbnailUrl,
  localDesktopTile,
  localDesktopTitle,
  requestLocalVncSession,
  type LocalDesktopSyncRow,
} from "./local-desktop-protocol";

function row(overrides: Partial<LocalDesktopSyncRow> = {}): LocalDesktopSyncRow {
  return {
    id: "ds-1",
    slug: "papercusp",
    kind: "xvfb",
    scope: "agent",
    scopeRef: "su-1a2b:main",
    display: 110,
    displayRaw: ":110",
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    captureGeometry: { width: 1280, height: 800 },
    state: "ready",
    viewerMode: "none",
    viewerActor: null,
    capabilities: {},
    lastActiveAt: "2026-10-06T09:00:00.000Z",
    owner: "su-1a2b",
    name: "browser",
    workItemId: "WI-12",
    workItemIntent: "build the grid",
    ...overrides,
  } as LocalDesktopSyncRow;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("localDesktopTile", () => {
  it("labels a tile with the agent, its work-item, state, geometry and activity", () => {
    expect(localDesktopTile(row(), "blob:frame")).toEqual({
      desktopSessionId: "ds-1",
      title: "browser",
      ownerLabel: "Agent su-1a2b",
      workItemLabel: "WI-12 · build the grid",
      state: "ready",
      geometry: "1280×800",
      lastActiveAt: "2026-10-06T09:00:00.000Z",
      thumbnailSrc: "blob:frame",
    });
  });

  it("falls back to the display, the harness and a bare work-item id", () => {
    const tile = localDesktopTile(
      row({ name: null, owner: null, scope: "pot", workItemIntent: null, lastActiveAt: null }),
      null,
    );
    expect(tile.title).toBe("Display :110");
    expect(tile.ownerLabel).toBe("Harness papercusp");
    expect(tile.workItemLabel).toBe("WI-12");
    expect(tile).not.toHaveProperty("lastActiveAt");
    expect(tile.thumbnailSrc).toBeNull();
  });

  it("phrases a pot owner the way the hosted roster does", () => {
    expect(localDesktopTile(row({ scope: "pot", owner: "alpha" }), null).ownerLabel).toBe(
      "Pot alpha",
    );
    expect(localDesktopTitle(row({ name: null }))).toBe("Display :110");
  });

  it("addresses a thumbnail by desktop session id, never by display", () => {
    expect(localDesktopThumbnailUrl("ds/1")).toBe(
      "/api/deploy/local-desktops/ds%2F1/thumbnail",
    );
  });
});

describe("requestLocalVncSession", () => {
  it("asks the bridge for a local session and reports the KasmVNC RFB class", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, wsUrl: "ws://127.0.0.1:3078/vnc?ticket=t", desktopSessionId: "ds-1", rfb: "kasmvnc" }),
    );
    await expect(
      requestLocalVncSession(
        { slug: "papercusp", display: 110, desktopSessionId: "ds-1", mode: "takeover" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ wsUrl: "ws://127.0.0.1:3078/vnc?ticket=t", rfb: "kasmvnc" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/deploy/papercusp/vnc-session");
    expect(JSON.parse(String(init.body))).toEqual({
      display: 110,
      mode: "takeover",
      target: "local",
    });
  });

  it("uses stock noVNC for an x11vnc stream and a placeholder slug for a slugless desktop", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, wsUrl: "ws://x", desktopSessionId: "ds-1", rfb: "standard" }),
    );
    await expect(
      requestLocalVncSession(
        { slug: null, display: 110, desktopSessionId: "ds-1", mode: "watch" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ wsUrl: "ws://x", rfb: "standard" });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/deploy/workspace/vnc-session");
  });

  it("surfaces the bridge's refusal", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "display :110 is not a registered agent desktop" }, 409),
    );
    await expect(
      requestLocalVncSession(
        { slug: "papercusp", display: 110, desktopSessionId: "ds-1", mode: "watch" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("not a registered agent desktop");
  });

  it("refuses a session minted for a different desktop on a reused display", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, wsUrl: "ws://x", desktopSessionId: "ds-OTHER", rfb: "kasmvnc" }),
    );
    await expect(
      requestLocalVncSession(
        { slug: "papercusp", display: 110, desktopSessionId: "ds-1", mode: "watch" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("desktop_changed");
  });

  it("reports the HTTP status when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(
      requestLocalVncSession(
        { slug: "papercusp", display: 110, desktopSessionId: "ds-1", mode: "watch" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("vnc-session HTTP 502");
  });
});
