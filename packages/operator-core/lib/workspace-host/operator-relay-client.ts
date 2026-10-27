/** Shared authenticated operator-http client, extracted from Portal's maintained relay. */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type OperatorTransportInit = {
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
  signal?: AbortSignal;
};

/** A failure the relay could not turn into an HTTP response. */
export class OperatorRelayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`operator relay: ${code}`);
    this.name = "OperatorRelayError";
  }
}

export interface RelayConfig {
  /** Loopback origin of the hosted control plane (the connector broker). */
  controlPlaneOrigin: string;
  /** The public host the control plane checks connector sockets against. */
  publicHost: string;
  /** The public origin a cookie-authenticated call is attributed to. */
  publicOrigin: string;
}

// ── The channel ─────────────────────────────────────────────────────────────

type Pending = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  started: boolean;
  cleanup: () => void;
};

/** Minimal socket surface; `ws.WebSocket` satisfies it. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type RelaySocketFactory = (url: string, headers: Record<string, string>) => RelaySocket;

const defaultSocketFactory: RelaySocketFactory = (url, headers) =>
  new WebSocket(url, { headers, maxPayload: 2 * 1024 * 1024 }) as unknown as RelaySocket;

/** Connect budget: ticket → socket → `session.bound` → host `http.ready`. */
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;
/** Largest request body the host accepts (hosted-operator-http.ts). */
export const RELAY_MAX_REQUEST_BODY_BYTES = 512 * 1024;

export class OperatorRelayChannel {
  private readonly pending = new Map<string, Pending>();
  private closedReason: string | null = null;

  private constructor(private readonly socket: RelaySocket) {
    socket.on("message", (data) => this.onMessage(data));
    const fail = (reason: string) => this.shutdown(reason);
    socket.on("close", (code, reason) => fail(reason.toString() || `closed_${code}`));
    socket.on("error", (error) => fail(error.message || "socket_error"));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Open a channel and resolve once the HOST has confirmed it is serving operator-http. */
  static open(
    config: RelayConfig,
    ticket: string,
    factory: RelaySocketFactory = defaultSocketFactory,
    timeoutMs = RELAY_CONNECT_TIMEOUT_MS,
  ): Promise<OperatorRelayChannel> {
    const url = new URL(`${config.controlPlaneOrigin.replace(/^http/, "ws")}/api/hosted/connectors/socket`);
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("kind", "operator-http");
    const socket = factory(url.toString(), { host: config.publicHost });
    return new Promise((resolve, reject) => {
      let bound = false;
      const timer = setTimeout(() => {
        socket.close(1000, "relay_connect_timeout");
        reject(new OperatorRelayError("relay_connect_timeout", 504));
      }, timeoutMs);
      timer.unref?.();
      const settle = (error: OperatorRelayError | null, channel?: OperatorRelayChannel) => {
        clearTimeout(timer);
        if (error) {
          socket.close(1000, error.code);
          reject(error);
        } else resolve(channel!);
      };
      const onHandshake = (data: WebSocket.RawData) => {
        let message: Record<string, unknown> | null;
        try {
          message = record(JSON.parse(data.toString()));
        } catch {
          return;
        }
        if (!message) return;
        if (message.type === "session.bound") {
          // An older control plane degrades an unknown kind to a PTY. A terminal
          // must never be mistaken for an operator pipe.
          if (message.kind !== "operator-http") return settle(new OperatorRelayError("relay_kind_unsupported", 503));
          bound = true;
          return;
        }
        // An older HOST ignores the kind and sends nothing; the timeout names that.
        if (bound && message.type === "http.ready") settle(null, new OperatorRelayChannel(socket));
      };
      socket.on("message", onHandshake);
      socket.on("close", (code, reason) =>
        settle(new OperatorRelayError(reason.toString() || `relay_closed_${code}`, code === 4411 ? 503 : 502)));
      socket.on("error", () => settle(new OperatorRelayError("relay_unreachable", 502)));
    });
  }

  /** One operator request over the channel. */
  fetch(path: string, init: OperatorTransportInit): Promise<Response> {
    if (this.closedReason) return Promise.reject(new OperatorRelayError("relay_closed", 502));
    if (init.signal?.aborted) return Promise.reject(new OperatorRelayError("client_aborted", 499));
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? Buffer.from(init.body, "utf8")
          : Buffer.from(init.body);
    if (body && body.byteLength > RELAY_MAX_REQUEST_BODY_BYTES) {
      return Promise.resolve(Response.json({ ok: false, error: "request_body_too_large" }, { status: 413 }));
    }
    const requestId = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        this.send({ type: "http.abort", requestId });
        this.finish(requestId, new OperatorRelayError("client_aborted", 499));
      };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        stream: null,
        started: false,
        cleanup: () => init.signal?.removeEventListener("abort", onAbort),
      });
      this.send({
        type: "http.request",
        requestId,
        method: init.method,
        path,
        headers: init.headers,
        ...(body ? { body: body.toString("base64") } : {}),
      });
    });
  }

  close(reason = "portal_closed"): void {
    this.socket.close(1000, reason);
    this.shutdown(reason);
  }

  private send(value: unknown): void {
    try {
      this.socket.send(JSON.stringify(value));
    } catch {
      this.shutdown("relay_send_failed");
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: Record<string, unknown> | null;
    try {
      message = record(JSON.parse(data.toString()));
    } catch {
      return;
    }
    const requestId = typeof message?.requestId === "string" ? message.requestId : null;
    const entry = requestId ? this.pending.get(requestId) : undefined;
    if (!message || !requestId || !entry) return;

    if (message.type === "http.response") {
      const status = typeof message.status === "number" ? message.status : 502;
      const headers = new Headers();
      for (const [name, value] of Object.entries(record(message.headers) ?? {})) {
        if (typeof value === "string") headers.set(name, value);
      }
      entry.started = true;
      const nullBody = status === 204 || status === 304 || (status >= 100 && status < 200);
      const stream = nullBody
        ? null
        : new ReadableStream<Uint8Array>({
            start: (controller) => {
              entry.stream = controller;
            },
            cancel: () => {
              this.send({ type: "http.abort", requestId });
              this.finish(requestId, null);
            },
          });
      entry.resolve(new Response(stream, { status, headers }));
      return;
    }
    if (message.type === "http.body" && typeof message.data === "string") {
      entry.stream?.enqueue(new Uint8Array(Buffer.from(message.data, "base64")));
      return;
    }
    if (message.type === "http.end") {
      this.finish(requestId, null);
      return;
    }
    if (message.type === "http.error") {
      const code = typeof message.code === "string" ? message.code : "operator_error";
      const status = typeof message.status === "number" ? message.status : 502;
      if (!entry.started && status < 500) {
        // A refusal the host decided (403 route_not_relayed, 413, 429) is an
        // ordinary HTTP answer, not a transport failure.
        entry.started = true;
        entry.resolve(Response.json({ ok: false, error: code }, { status }));
        this.finish(requestId, null);
        return;
      }
      this.finish(requestId, new OperatorRelayError(code, status));
    }
  }

  private finish(requestId: string, error: Error | null): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.cleanup();
    if (!entry.started) {
      entry.reject(error ?? new OperatorRelayError("relay_no_response", 502));
      return;
    }
    try {
      if (error) entry.stream?.error(error);
      else entry.stream?.close();
    } catch {
      /* the reader already cancelled */
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, new OperatorRelayError("relay_closed", 502));
    }
  }
}
