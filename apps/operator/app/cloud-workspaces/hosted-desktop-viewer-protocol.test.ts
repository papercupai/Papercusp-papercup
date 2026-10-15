import { describe, expect, it, vi } from "vitest";
import {
  HostedDesktopRelayChannel,
  buildDesktopDataRelay,
  buildDesktopRosterRequest,
  buildDesktopStartRequest,
  buildDesktopThumbnailRequest,
  buildHostedDesktopSocketUrl,
  parseHostedDesktopProtocolMessage,
} from "./hosted-desktop-viewer-protocol";

const TICKET = `ht_${"a".repeat(43)}`;

type FakeSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
};

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  readonly OPEN = FakeSocket.OPEN;
  readonly CLOSED = FakeSocket.CLOSED;
  readonly CONNECTING = FakeSocket.CONNECTING;
  readonly CLOSING = FakeSocket.CLOSING;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: FakeSocketEvent) => void>
  >();

  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: FakeSocketEvent) => void,
  ): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  emit(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("hosted desktop browser protocol", () => {
  it("builds a same-origin desktop attach URL and bounded discovery requests", () => {
    expect(
      buildHostedDesktopSocketUrl(
        "https://app.papercusp.com/cloud-workspaces",
        TICKET,
        "desktop-1",
        "watch",
      ),
    ).toBe(
      `wss://app.papercusp.com/api/hosted/connectors/socket?ticket=${TICKET}&kind=desktop&desktopSessionId=desktop-1&desktopMode=watch`,
    );
    expect(buildDesktopRosterRequest("roster-1")).toBe(
      JSON.stringify({ type: "desktop.roster", requestId: "roster-1" }),
    );
    expect(buildDesktopStartRequest("start-1")).toBe(
      JSON.stringify({ type: "desktop.start", requestId: "start-1" }),
    );
    expect(buildDesktopThumbnailRequest("thumb-1", "desktop-1")).toBe(
      JSON.stringify({
        type: "desktop.thumbnail",
        requestId: "thumb-1",
        desktopSessionId: "desktop-1",
      }),
    );
    expect(() =>
      buildHostedDesktopSocketUrl(
        "https://app.papercusp.com",
        TICKET,
        " ",
        "watch",
      ),
    ).toThrow("desktop_session_required");
  });

  it("parses a started desktop and rejects one the viewer could not open (D-405)", () => {
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.start.result",
        requestId: "start-1",
        desktop: { desktopSessionId: "desktop-9", state: "ready", displayNumber: 110 },
      }),
    ).toEqual({
      kind: "started",
      requestId: "start-1",
      desktop: { desktopSessionId: "desktop-9", state: "ready", displayNumber: 110 },
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.start.result",
        requestId: "start-1",
        desktop: { desktopSessionId: "", state: "ready" },
      }),
    ).toBeNull();
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.start.result",
        desktop: { desktopSessionId: "desktop-9", state: "ready" },
      }),
    ).toBeNull();
  });

  it("parses ready, roster, thumbnail, and explicit operation errors", () => {
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.ready",
        action: "takeover",
        inputAllowed: true,
      }),
    ).toEqual({ kind: "ready", action: "takeover", inputAllowed: true });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.roster.result",
        requestId: "roster-1",
        desktops: [
          {
            desktopSessionId: "desktop-1",
            state: "ready",
            displayNumber: 2,
            geometry: "1280x720",
          },
          { desktopSessionId: "", state: "bad" },
        ],
      }),
    ).toEqual({
      kind: "roster",
      requestId: "roster-1",
      desktops: [
        {
          desktopSessionId: "desktop-1",
          state: "ready",
          displayNumber: 2,
          geometry: "1280x720",
        },
      ],
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.thumbnail.result",
        requestId: "thumb-1",
        desktopSessionId: "desktop-1",
        data: "AQI=",
        bytes: 2,
      }),
    ).toEqual({
      kind: "thumbnail",
      requestId: "thumb-1",
      desktopSessionId: "desktop-1",
      data: "AQI=",
      bytes: 2,
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.thumbnail.result",
        requestId: "thumb-2",
        desktopSessionId: "desktop-1",
        data: null,
      }),
    ).toEqual({
      kind: "thumbnail",
      requestId: "thumb-2",
      desktopSessionId: "desktop-1",
      data: null,
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.thumbnail.result",
        requestId: "thumb-3",
        desktopSessionId: "desktop-1",
        data: "not base64!",
      }),
    ).toBeNull();
    expect(
      parseHostedDesktopProtocolMessage({
        type: "operation.error",
        requestId: "roster-1",
        operation: "desktop.roster",
        code: "desktop_unsupported",
      }),
    ).toEqual({
      kind: "error",
      requestId: "roster-1",
      operation: "desktop.roster",
      code: "desktop_unsupported",
    });
  });

  it("asks for the caller's own desktop and keeps its user scope (personal-cloud-desktop R-5)", () => {
    // A personal start carries `personal: true`; a plain start never does,
    // so a sandbox start cannot be mistaken for the caller's own seat.
    expect(JSON.parse(buildDesktopStartRequest("start-p", { personal: true }))).toEqual({
      type: "desktop.start",
      requestId: "start-p",
      personal: true,
    });
    expect(JSON.parse(buildDesktopStartRequest("start-s", { personal: false }))).toEqual({
      type: "desktop.start",
      requestId: "start-s",
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.start.result",
        requestId: "start-p",
        desktop: { desktopSessionId: "mine", state: "ready", scope: "user" },
      }),
    ).toEqual({
      kind: "started",
      requestId: "start-p",
      desktop: { desktopSessionId: "mine", state: "ready", scope: "user" },
    });
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.roster.result",
        requestId: "roster-p",
        desktops: [{ desktopSessionId: "mine", state: "running", scope: "user" }],
      }),
    ).toEqual({
      kind: "roster",
      requestId: "roster-p",
      desktops: [{ desktopSessionId: "mine", state: "running", scope: "user" }],
    });
  });

  it("carries owner, scope, name and the owner's work-item on roster rows (P-006)", () => {
    expect(
      parseHostedDesktopProtocolMessage({
        type: "desktop.roster.result",
        requestId: "roster-2",
        desktops: [
          {
            desktopSessionId: "desktop-a",
            state: "running",
            scope: "agent",
            owner: "su-1a2b",
            name: "browser",
            workItemId: "WI-12",
            workItemIntent: "build the grid",
          },
          // Unknown scope dropped; an intent without its id is not shown alone.
          {
            desktopSessionId: "desktop-b",
            state: "running",
            scope: "everyone",
            owner: "",
            workItemIntent: "orphan intent",
          },
        ],
      }),
    ).toEqual({
      kind: "roster",
      requestId: "roster-2",
      desktops: [
        {
          desktopSessionId: "desktop-a",
          state: "running",
          scope: "agent",
          owner: "su-1a2b",
          name: "browser",
          workItemId: "WI-12",
          workItemIntent: "build the grid",
        },
        { desktopSessionId: "desktop-b", state: "running" },
      ],
    });
  });

  it("adapts JSON/base64 relay frames to noVNC's raw channel contract", () => {
    const socket = new FakeSocket();
    const channel = new HostedDesktopRelayChannel(socket);
    const onReady = vi.fn();
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    channel.onready = onReady;
    channel.onopen = onOpen;
    channel.onmessage = onMessage;
    channel.onclose = onClose;

    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.ready",
        action: "takeover",
        inputAllowed: true,
      }),
    });
    expect(channel.readyState).toBe(channel.OPEN);
    expect(channel.inputAllowed).toBe(true);
    expect(onReady).toHaveBeenCalledWith({
      kind: "ready",
      action: "takeover",
      inputAllowed: true,
    });
    expect(onOpen).toHaveBeenCalledOnce();

    socket.emit("message", {
      data: JSON.stringify({ type: "desktop.data", data: "AQI=" }),
    });
    expect(onMessage).toHaveBeenCalledWith({
      data: new Uint8Array([1, 2]).buffer,
    });

    channel.send(new Uint8Array([3, 4]));
    expect(socket.sent).toContain(
      buildDesktopDataRelay(new Uint8Array([3, 4])),
    );
    socket.close(1000, "done");
    expect(channel.readyState).toBe(channel.CLOSED);
    expect(channel.inputAllowed).toBe(false);
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: "done" });
  });

  describe("bytes that arrive before noVNC attaches (WI-10004214)", () => {
    const ready = JSON.stringify({
      type: "desktop.ready",
      action: "watch",
      inputAllowed: false,
    });
    const frame = (text: string) => ({
      data: buildDesktopDataRelay(new TextEncoder().encode(text)),
    });

    it("holds them, then delivers them in order once the handshake has begun", async () => {
      const socket = new FakeSocket();
      const channel = new HostedDesktopRelayChannel(socket);
      socket.emit("message", { data: ready });
      socket.emit("message", frame("RFB 003.008\n"));
      socket.emit("message", frame("second"));

      // noVNC's attach(): assign onmessage, THEN start the handshake synchronously.
      const received: string[] = [];
      let handshaking = false;
      channel.onmessage = ({ data }) => {
        received.push(handshaking ? new TextDecoder().decode(data) : "early");
      };
      handshaking = true;
      expect(received).toEqual([]);

      await Promise.resolve();
      expect(received).toEqual(["RFB 003.008\n", "second"]);
      socket.emit("message", frame("live"));
      expect(received).toEqual(["RFB 003.008\n", "second", "live"]);
    });

    it("discards them when the channel closes before anything attaches", async () => {
      const socket = new FakeSocket();
      const channel = new HostedDesktopRelayChannel(socket);
      socket.emit("message", { data: ready });
      socket.emit("message", frame("RFB 003.008\n"));
      socket.close(1000, "viewer_detached");

      const onMessage = vi.fn();
      channel.onmessage = onMessage;
      await Promise.resolve();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("still exposes every property noVNC 1.7's Websock.attach() requires", () => {
      // core/websock.js rawChannelProps, checked the way attach() checks them.
      const channel = new HostedDesktopRelayChannel(new FakeSocket());
      const props = [
        ...Object.keys(channel),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel)),
      ];
      for (const prop of [
        "send",
        "close",
        "binaryType",
        "onerror",
        "onmessage",
        "onopen",
        "protocol",
        "readyState",
      ])
        expect(props).toContain(prop);
    });
  });

  it("does not invoke noVNC onopen after onready closes a mismatched channel", () => {
    const socket = new FakeSocket();
    const channel = new HostedDesktopRelayChannel(socket);
    const onReady = vi.fn(() => channel.close(1008, "desktop_action_mismatch"));
    const onOpen = vi.fn();
    channel.onready = onReady;
    channel.onopen = onOpen;

    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.ready",
        action: "watch",
        inputAllowed: false,
      }),
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(channel.readyState).toBe(channel.CLOSED);
  });
});
