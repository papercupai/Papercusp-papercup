// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LocalDesktopSyncRow } from "./local-desktop-protocol";

const H = vi.hoisted(() => {
  class FakeRFB {
    static instances: FakeRFB[] = [];
    readonly listeners = new Map<string, () => void>();
    readonly disconnect = vi.fn();
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    resizeSession = true;
    focusOnClick = false;
    background = "";

    constructor(
      readonly element: unknown,
      readonly url: unknown,
      readonly options: unknown,
    ) {
      FakeRFB.instances.push(this);
    }

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    emit(type: string): void {
      this.listeners.get(type)?.();
    }

    _sendMouse(): void {}
  }
  return {
    FakeRFB,
    rows: [] as LocalDesktopSyncRow[],
    params: {} as Record<string, unknown>,
    updates: [] as Array<[string, unknown]>,
    queries: [] as string[],
    invalidate: vi.fn(),
  };
});

vi.mock("@novnc/novnc", () => ({ default: H.FakeRFB }));
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    H.queries.push(queryName);
    return { data: H.rows, loading: false, fetching: false, error: null, invalidate: H.invalidate };
  },
}));
vi.mock("nuqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nuqs")>();
  const React = await import("react");
  return {
    ...actual,
    useQueryState: (key: string, config?: { defaultValue?: unknown }) => {
      const [value, setValue] = React.useState<unknown>(
        H.params[key] ?? config?.defaultValue ?? null,
      );
      return [
        value,
        (next: unknown) => {
          H.updates.push([key, next]);
          setValue(next ?? config?.defaultValue ?? null);
          return Promise.resolve(next);
        },
      ];
    },
  };
});

import { LocalDesktopWorkspace } from "./LocalDesktopWorkspace";

function desktop(id: string, overrides: Partial<LocalDesktopSyncRow> = {}): LocalDesktopSyncRow {
  return {
    id,
    slug: "papercusp",
    kind: "xvfb",
    scope: "agent",
    scopeRef: `su-${id}:main`,
    display: id === "ds-1" ? 110 : 111,
    displayRaw: id === "ds-1" ? ":110" : ":111",
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    captureGeometry: { width: 1280, height: 800 },
    state: "ready",
    viewerMode: "none",
    viewerActor: null,
    capabilities: {},
    lastActiveAt: "2026-10-06T09:00:00.000Z",
    owner: `su-${id}`,
    name: id === "ds-1" ? "browser" : "terminal",
    workItemId: id === "ds-1" ? "WI-12" : null,
    workItemIntent: id === "ds-1" ? "build the grid" : null,
    ...overrides,
  } as LocalDesktopSyncRow;
}

let objectUrls = 0;
const fetchImpl = vi.fn();

function sessionBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as { display: number; mode: string; target: string };
}

beforeEach(() => {
  H.rows = [desktop("ds-1"), desktop("ds-2")];
  H.params = {};
  H.updates = [];
  H.queries = [];
  H.FakeRFB.instances.length = 0;
  objectUrls = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:frame-${++objectUrls}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  fetchImpl.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/thumbnail")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url.endsWith("/vnc-session")) {
      const { display, mode } = sessionBody(init);
      return new Response(
        JSON.stringify({
          ok: true,
          wsUrl: `ws://127.0.0.1:3078/vnc?ticket=${mode}-${display}`,
          desktopSessionId: display === 110 ? "ds-1" : "ds-2",
          rfb: "kasmvnc",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(cleanup);

function thumbnailCalls(): string[] {
  return fetchImpl.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.endsWith("/thumbnail"));
}

function sessionCalls(): Array<{ url: string; body: ReturnType<typeof sessionBody> }> {
  return fetchImpl.mock.calls
    .filter(([url]) => String(url).endsWith("/vnc-session"))
    .map(([url, init]) => ({ url: String(url), body: sessionBody(init as RequestInit) }));
}

describe("LocalDesktopWorkspace — This computer (P-007)", () => {
  it("reads the desktops.local sync query and labels each tile with its agent and work-item", async () => {
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect(H.queries).toContain("desktops.local");
    const tiles = screen.getByRole("list", { name: "Available desktops" });
    expect(within(tiles).getByText("browser")).toBeTruthy();
    expect(within(tiles).getByText("Agent su-ds-1")).toBeTruthy();
    expect(within(tiles).getByText("WI-12 · build the grid")).toBeTruthy();
    expect(within(tiles).getByText("terminal")).toBeTruthy();
    expect(within(tiles).getByText("Agent su-ds-2")).toBeTruthy();
  });

  it("fetches a fresh thumbnail per tile and renders it", async () => {
    const { container } = render(
      <LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('img[src^="blob:frame-"]')).toHaveLength(2),
    );
    expect(thumbnailCalls().toSorted()).toEqual([
      "/api/deploy/local-desktops/ds-1/thumbnail",
      "/api/deploy/local-desktops/ds-2/thumbnail",
    ]);
  });

  it("keeps the last frame when a capture misses", async () => {
    const { container } = render(
      <LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('img[src^="blob:frame-"]')).toHaveLength(2),
    );
    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelectorAll('img[src^="blob:frame-"]')).toHaveLength(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("opens a watch-only KasmVNC viewer on click and records it in the URL", async () => {
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch browser" }));
    expect(H.updates).toContainEqual(["desktop", "watch:ds-1"]);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    const rfb = H.FakeRFB.instances[0]!;
    // The registry desktop is KasmVNC: the viewer must use the KasmVNC subclass.
    expect(rfb.constructor).not.toBe(H.FakeRFB);
    expect(rfb).toBeInstanceOf(H.FakeRFB);
    expect(rfb.url).toBe("ws://127.0.0.1:3078/vnc?ticket=watch-110");
    expect(rfb.viewOnly).toBe(true);
    expect(sessionCalls()).toEqual([
      {
        url: "/api/deploy/papercusp/vnc-session",
        body: { display: 110, mode: "watch", target: "local" },
      },
    ]);
  });

  it("takes control on a fresh takeover session", async () => {
    H.params.desktop = "watch:ds-1";
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    act(() => H.FakeRFB.instances[0]!.emit("connect"));
    fireEvent.click(await screen.findByRole("button", { name: /Take control/ }));
    expect(H.updates).toContainEqual(["desktop", "takeover:ds-1"]);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(2));
    expect(H.FakeRFB.instances[0]!.disconnect).toHaveBeenCalled();
    const takeover = H.FakeRFB.instances[1]!;
    expect(takeover.viewOnly).toBe(false);
    expect(sessionCalls().map((call) => call.body.mode)).toEqual(["watch", "takeover"]);
  });

  it("streams a pinned tile live (watch-only) and stops fetching its thumbnail", async () => {
    H.params.desktopPins = ["ds-2"];
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect(screen.getByRole("group", { name: "terminal live" })).toBeTruthy();
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    expect(H.FakeRFB.instances[0]!.viewOnly).toBe(true);
    expect(sessionCalls().map((call) => call.body)).toEqual([
      { display: 111, mode: "watch", target: "local" },
    ]);
    // A pinned tile has no Take control of its own.
    expect(screen.queryByRole("button", { name: /Take control/ })).toBeNull();
    await waitFor(() => expect(thumbnailCalls()).toHaveLength(1));
    expect(thumbnailCalls()).toEqual(["/api/deploy/local-desktops/ds-1/thumbnail"]);
  });

  it("says plainly when this computer runs no agent desktops", () => {
    H.rows = [];
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect(screen.getByText("No agent desktops on this computer")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Available desktops" })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to show a different desktop that reused the display", async () => {
    fetchImpl.mockImplementation(async (url: string) =>
      url.endsWith("/vnc-session")
        ? new Response(
            JSON.stringify({ ok: true, wsUrl: "ws://x", desktopSessionId: "ds-OTHER", rfb: "kasmvnc" }),
            { status: 200 },
          )
        : new Response(null, { status: 204 }),
    );
    H.params.desktop = "watch:ds-1";
    render(<LocalDesktopWorkspace fetchImpl={fetchImpl as unknown as typeof fetch} />);
    expect(await screen.findByText(/Desktop stream failed: desktop_changed/)).toBeTruthy();
    expect(H.FakeRFB.instances).toHaveLength(0);
  });
});
