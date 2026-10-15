// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import RFB from "@novnc/novnc";
import {
  encodeKasmvncPointerEvent,
  KASMVNC_POINTER_EVENT_BYTES,
  kasmvncRfbClass,
} from "./kasmvnc-rfb";

/** Collects what noVNC queues on its Websock, in the order it would hit the wire. */
function captureSock() {
  const bytes: number[] = [];
  const push = (value: number, width: number) => {
    for (let shift = (width - 1) * 8; shift >= 0; shift -= 8)
      bytes.push((value >> shift) & 0xff);
  };
  return {
    bytes,
    sQpush8: (value: number) => push(value, 1),
    sQpush16: (value: number) => push(value, 2),
    sQpush32: (value: number) => push(value, 4),
    sQpushBytes: (value: Uint8Array) => bytes.push(...value),
    flush: () => {},
  };
}

type SendMouse = (x: number, y: number, mask: number) => void;

/** An instance of `Class` wired to a capture socket, without running the DOM constructor. */
function instanceOf(Class: typeof RFB, state = { connected: true, viewOnly: false }) {
  const sock = captureSock();
  const instance = Object.create(Class.prototype) as Record<string, unknown>;
  instance._rfbConnectionState = state.connected ? "connected" : "connecting";
  instance._viewOnly = state.viewOnly;
  instance._extendedPointerEventSupported = false;
  instance._sock = sock;
  instance._display = { absX: (x: number) => x, absY: (y: number) => y };
  const sendMouse = (instance._sendMouse as SendMouse).bind(instance);
  return { sock, sendMouse };
}

/** Message lengths as KasmVNC's SMsgReader reads them, for the messages this test sends. */
const KASMVNC_MESSAGE_LENGTH: Record<number, number> = {
  4: 8, // KeyEvent: type, down, 2 pad, U32 keysym
  5: KASMVNC_POINTER_EVENT_BYTES, // PointerEvent: type, U16 mask, U16 x, U16 y, S16, S16
};

/** Walk a client stream the way KasmVNC does; returns message types, or the byte it rejects. */
function kasmvncReads(bytes: number[]): { types: number[]; rejected: number | null } {
  const types: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const type = bytes[offset]!;
    const length = KASMVNC_MESSAGE_LENGTH[type];
    if (length === undefined) return { types, rejected: type };
    types.push(type);
    offset += length;
  }
  return { types, rejected: null };
}

function keyEvent(sock: ReturnType<typeof captureSock>) {
  const messages = (RFB as unknown as { messages: Record<string, (...args: unknown[]) => void> })
    .messages;
  messages.keyEvent!(sock, 0x61, 1);
}

describe("encodeKasmvncPointerEvent", () => {
  it("lays out type, U16 mask, U16 x, U16 y, S16 scrollX, S16 scrollY", () => {
    expect([
      ...encodeKasmvncPointerEvent({ x: 300, y: 2, mask: 0x101, scrollX: -1, scrollY: 2 }),
    ]).toEqual([5, 0x01, 0x01, 0x01, 0x2c, 0x00, 0x02, 0xff, 0xff, 0x00, 0x02]);
  });

  it("clamps coordinates into U16 and refuses the reserved top mask bit", () => {
    expect([...encodeKasmvncPointerEvent({ x: -4, y: 70_000, mask: 0 })].slice(3, 7)).toEqual([
      0, 0, 0xff, 0xff,
    ]);
    expect(() => encodeKasmvncPointerEvent({ x: 0, y: 0, mask: 0x8000 })).toThrow(/mask/);
  });
});

describe("kasmvncRfbClass over the real @novnc/novnc", () => {
  it("calibration: stock noVNC sends the 6-byte form and KasmVNC then rejects the next message", () => {
    // Proves the capture harness drives the real `_sendMouse`; without this, the override
    // test below could pass against a harness that never reaches noVNC's code at all.
    const { sock, sendMouse } = instanceOf(RFB);
    sendMouse(10, 20, 1);
    expect(sock.bytes).toHaveLength(6);
    keyEvent(sock);
    expect(kasmvncReads(sock.bytes).rejected).not.toBeNull();
  });

  it("sends every pointer event in KasmVNC's 11-byte form, keeping the stream aligned", () => {
    const { sock, sendMouse } = instanceOf(kasmvncRfbClass(RFB));
    sendMouse(10, 20, 1);
    sendMouse(11, 21, 0);
    keyEvent(sock);
    expect(sock.bytes.slice(0, KASMVNC_POINTER_EVENT_BYTES)).toEqual([
      ...encodeKasmvncPointerEvent({ x: 10, y: 20, mask: 1 }),
    ]);
    expect(kasmvncReads(sock.bytes)).toEqual({ types: [5, 5, 4], rejected: null });
  });

  it("sends nothing while view-only or not yet connected", () => {
    const KasmvncRfb = kasmvncRfbClass(RFB);
    for (const state of [
      { connected: true, viewOnly: true },
      { connected: false, viewOnly: false },
    ]) {
      const { sock, sendMouse } = instanceOf(KasmvncRfb, state);
      sendMouse(10, 20, 1);
      expect(sock.bytes).toEqual([]);
    }
  });

  it("refuses a noVNC with no _sendMouse rather than silently sending the 6-byte form", () => {
    class NoSendMouse {}
    expect(() => kasmvncRfbClass(NoSendMouse as unknown as typeof RFB)).toThrow(
      /_sendMouse/,
    );
  });

  // The Playwright fixtures replace @novnc/novnc with this framebuffer stand-in, and the
  // viewers wrap it in kasmvncRfbClass. When the refusal above landed, the stand-in had no
  // `_sendMouse`, so every e2e viewer rendered "Desktop stream failed" for two weeks with no
  // signal: test:affected never selects e2e specs. This keeps the two in step.
  it("accepts the e2e framebuffer stand-in the Playwright fixtures alias @novnc/novnc to", async () => {
    const { default: FixtureRfb } = await import(
      "../../e2e/__fixtures__/desktop-render-rfb"
    );
    expect(() =>
      kasmvncRfbClass(FixtureRfb as unknown as typeof RFB),
    ).not.toThrow();
  });
});
