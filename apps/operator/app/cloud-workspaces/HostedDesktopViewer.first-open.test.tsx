// @vitest-environment jsdom

/*
 * WI-10004214: the first desktop a page opens used to hang on "Opening your
 * desktop…" until a full browser reload. The host answered in ~90ms (the
 * broker audited desktop.ready at 15:36:16.256 for a 15:36:15.951 ticket), but
 * the viewer only constructs noVNC after `await import("@novnc/novnc")`. On a
 * cold page that chunk is still downloading when KasmVNC's version greeting
 * arrives, and the relay channel dropped it; noVNC then waits for a greeting
 * that already came. This file delivers the greeting at the import's await
 * boundary, before RFB construction. Keep noVNC's dynamic imports real: Vitest
 * 4.1.8 leaks real exports to overlapping mocked imports, even with synchronous
 * factories (EI-25590151938600382). Control the existing static adapter instead.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  buildDesktopDataRelay,
  type HostedDesktopViewerMode,
} from "./hosted-desktop-viewer-protocol";
import * as kasmvnc from "./kasmvnc-rfb";

const H = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static CONNECTING = 0;
    static CLOSING = 2;
    readyState = FakeSocket.OPEN;
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    close = vi.fn((code = 1000, reason = "") => {
      this.readyState = FakeSocket.CLOSED;
      this.emit("close", { code, reason });
    });

    constructor(readonly url: string) {
      H.sockets.push(this);
      const desktopSessionId = new URL(url).searchParams.get("desktopSessionId")!;
      // connect() assigns the relay handlers synchronously, then awaits import.
      // This microtask answers before that await can construct RFB, even when
      // the module is already cached. Record the ordering instead of assuming it.
      queueMicrotask(() => {
        const messages = H.earlyMessages.get(desktopSessionId);
        if (!messages) return;
        H.earlyMessages.delete(desktopSessionId);
        H.earlyDeliveries.push({
          desktopSessionId,
          rfbInstances: H.AttachingRFB.instances.length,
        });
        for (const data of messages) this.emit("message", { data });
      });
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    send(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  type RawChannel = {
    readyState: number;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onopen: (() => void) | null;
  };

  /** Attaches to the channel the way noVNC 1.7's RFB + Websock.attach() do. */
  class AttachingRFB {
    static instances: AttachingRFB[] = [];
    readonly listeners = new Map<string, () => void>();
    readonly disconnect = vi.fn();
    /** What reached the handshake, or "early" for bytes delivered before it began. */
    readonly received: string[] = [];
    handshake: "" | "ProtocolVersion" = "";
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    resizeSession = true;
    focusOnClick = false;
    background = "";

    constructor(_target: unknown, channel: RawChannel, _options: unknown) {
      AttachingRFB.instances.push(this);
      channel.onmessage = ({ data }) => {
        if (this.handshake !== "ProtocolVersion") {
          this.received.push("early");
          return;
        }
        this.received.push(new TextDecoder().decode(data));
        this.listeners.get("connect")?.();
      };
      channel.onopen = () => {
        this.handshake = "ProtocolVersion";
      };
      // rfb.js _connect(): an already-open channel starts the handshake at once.
      if (channel.readyState === 1) this.handshake = "ProtocolVersion";
    }

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    _sendMouse(): void {}
  }

  return {
    AttachingRFB,
    FakeSocket,
    fetch: vi.fn(),
    sockets: [] as FakeSocket[],
    earlyMessages: new Map<string, string[]>(),
    earlyDeliveries: [] as Array<{
      desktopSessionId: string;
      rfbInstances: number;
    }>,
  };
});

import { HostedDesktopViewer } from "./HostedDesktopViewer";

const adaptRfb = kasmvnc.kasmvncRfbClass;

beforeEach(() => {
  H.sockets.length = 0;
  H.AttachingRFB.instances.length = 0;
  H.earlyMessages.clear();
  H.earlyDeliveries.length = 0;
  // Both viewers import real noVNC; only construction uses the handshake fake.
  // Retain the real KasmVNC subclass adapter around that fake.
  vi.spyOn(kasmvnc, "kasmvncRfbClass").mockImplementation(() =>
    adaptRfb(H.AttachingRFB as unknown as Parameters<typeof adaptRfb>[0]),
  );
  H.fetch.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, ticket: `ht_${"a".repeat(43)}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", H.fetch);
  vi.stubGlobal("WebSocket", H.FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("resolves overlapping noVNC imports to the same real constructor without a viewer", async () => {
  const modules = await Promise.all([
    import("@novnc/novnc"),
    import("@novnc/novnc"),
  ]);
  expect(typeof modules[0]!.default).toBe("function");
  expect(modules[0]!.default).not.toBe(H.AttachingRFB);
  expect(modules[1]!.default).toBe(modules[0]!.default);
  expect(kasmvnc.kasmvncRfbClass).not.toHaveBeenCalled();
  expect(H.AttachingRFB.instances).toHaveLength(0);
});

function scheduleEarlyGreeting(
  desktopSessionId: string,
  mode: HostedDesktopViewerMode,
  inputAllowed: boolean,
  greeting = "RFB 003.008\n",
) {
  H.earlyMessages.set(desktopSessionId, [
    JSON.stringify({ type: "desktop.ready", action: mode, inputAllowed }),
    buildDesktopDataRelay(new TextEncoder().encode(greeting)),
  ]);
}

it.each([
  { mode: "watch", inputAllowed: false, viewOnly: true },
  { mode: "takeover", inputAllowed: false, viewOnly: true },
  { mode: "takeover", inputAllowed: true, viewOnly: false },
] as const)(
  "preserves $mode inputAllowed=$inputAllowed when the greeting arrives before noVNC constructs the viewer",
  async ({ mode, inputAllowed, viewOnly }) => {
    const onStateChange = vi.fn();
    scheduleEarlyGreeting("desktop-1", mode, inputAllowed);
    render(
      <HostedDesktopViewer
        workspaceId="customer-workspace-1"
        hostId="host-1"
        routeLabel="workspace-relay"
        desktopSessionId="desktop-1"
        mode={mode}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => expect(H.AttachingRFB.instances).toHaveLength(1));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("connected"),
    );
    expect(H.earlyDeliveries).toEqual([
      { desktopSessionId: "desktop-1", rfbInstances: 0 },
    ]);
    expect(H.AttachingRFB.instances[0]!.received).toEqual(["RFB 003.008\n"]);
    expect(H.AttachingRFB.instances[0]!.viewOnly).toBe(viewOnly);
  },
);

it.each([
  { firstMode: "watch", firstInputAllowed: true },
  { firstMode: "takeover", firstInputAllowed: false },
] as const)(
  "connects simultaneous $firstMode/$firstInputAllowed and granted takeover viewers with independent early greetings",
  async ({ firstMode, firstInputAllowed }) => {
    const firstState = vi.fn();
    const secondState = vi.fn();
    scheduleEarlyGreeting("desktop-1", firstMode, firstInputAllowed);
    scheduleEarlyGreeting("desktop-2", "takeover", true, "RFB 003.007\n");
    render(
      <>
        <HostedDesktopViewer
          workspaceId="customer-workspace-1"
          hostId="host-1"
          routeLabel="workspace-relay"
          desktopSessionId="desktop-1"
          mode={firstMode}
          onStateChange={firstState}
        />
        <HostedDesktopViewer
          workspaceId="customer-workspace-1"
          hostId="host-1"
          routeLabel="workspace-relay"
          desktopSessionId="desktop-2"
          mode="takeover"
          onStateChange={secondState}
        />
      </>,
    );
    await waitFor(() => expect(H.AttachingRFB.instances).toHaveLength(2));
    await waitFor(() => {
      expect(firstState).toHaveBeenLastCalledWith("connected");
      expect(secondState).toHaveBeenLastCalledWith("connected");
    });
    expect(H.earlyDeliveries).toEqual([
      { desktopSessionId: "desktop-1", rfbInstances: 0 },
      { desktopSessionId: "desktop-2", rfbInstances: 0 },
    ]);
    const [first, second] = H.AttachingRFB.instances;
    expect(first!.received).toEqual(["RFB 003.008\n"]);
    expect(second!.received).toEqual(["RFB 003.007\n"]);
    expect(first!.viewOnly).toBe(true);
    expect(second!.viewOnly).toBe(false);
    act(() => H.sockets[1]!.emit("close", { code: 1006, reason: "" }));
    expect(second!.viewOnly).toBe(true);
    expect(firstState).toHaveBeenLastCalledWith("connected");
  },
);
