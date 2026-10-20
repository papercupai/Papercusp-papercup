// WI-6554700010018316 fix 3: a client attached to an OBSERVER seat must say so,
// instead of silently dropping every key the user types.
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { defaultOpenHostedTerminal, HOSTED_VIEWER_NOTICE } from "./psu-connection-front-controller.mjs";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  constructor(public url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = "") {
    const event = Object.assign(new Event("close"), { code, reason });
    queueMicrotask(() => this.dispatchEvent(event));
  }
  receive(message: Record<string, unknown>) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
  }
}

class FakeStdin extends EventEmitter {
  isTTY = false;
  resume() {}
  pause() {}
  type(text: string) {
    this.emit("data", Buffer.from(text));
  }
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  FakeSocket.last = null;
});

async function attach() {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const notices: string[] = [];
  const stdin = new FakeStdin();
  const stdout = { columns: 80, rows: 24, write: () => true };
  const done = defaultOpenHostedTerminal({
    socketUrl: "wss://example.invalid/s",
    initialInput: undefined,
    notice: (line: string) => notices.push(line),
    stdin: stdin as never,
    stdout: stdout as never,
  });
  await new Promise((r) => setTimeout(r, 0));
  const socket = FakeSocket.last!;
  return { notices, stdin, socket, done };
}

const inputs = (socket: FakeSocket) => socket.sent.filter((m) => m.type === "pty.input");

describe("hosted terminal viewer seat", () => {
  it("announces a read-only viewer attach once and sends no keys", async () => {
    const { notices, stdin, socket, done } = await attach();
    socket.receive({ type: "pty.ready", role: "observer" });
    stdin.type("ls\r");
    stdin.type("pwd\r");
    expect(notices.filter((n) => n === HOSTED_VIEWER_NOTICE)).toHaveLength(1);
    expect(inputs(socket)).toHaveLength(0);
    socket.close();
    await done;
  });

  it("a controller attach is silent and forwards keys", async () => {
    const { notices, stdin, socket, done } = await attach();
    socket.receive({ type: "pty.ready", role: "controller" });
    stdin.type("ls\r");
    expect(notices).toEqual([]);
    expect(inputs(socket)).toHaveLength(1);
    socket.close();
    await done;
  });

  it("keeps the take-over notice and announces control returning", async () => {
    const { notices, stdin, socket, done } = await attach();
    socket.receive({ type: "pty.ready", role: "controller" });
    socket.receive({ type: "session.role", role: "observer" });
    stdin.type("x");
    socket.receive({ type: "session.role", role: "controller" });
    stdin.type("y");
    expect(notices).toEqual([
      "psu: another viewer took control of this shell; output stays live here",
      "psu: you have control of this shell again",
    ]);
    expect(inputs(socket)).toHaveLength(1);
    socket.close();
    await done;
  });
});
