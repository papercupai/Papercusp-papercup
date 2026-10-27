import { describe, expect, it } from "vitest";
import { HOSTED_WORKSPACE_MAX_MESSAGE_BYTES } from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-session";
import {
  HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES,
  HOSTED_WORKSPACE_SESSION_PROTOCOL,
  base64ToBytes,
  base64ToUtf8,
  buildHostedWorkspaceSocketUrl,
  bytesToBase64,
  parseHostedWorkspaceProtocolMessage,
  readHostedWorkspaceConnector,
  readHostedWorkspaceId,
  readHostedWorkspaceTicket,
  readHostedWorkspaceSocketOrigin,
  utf8ToBase64,
} from "./hosted-workspace-session-protocol";

const TICKET = `ht_${"a".repeat(43)}`;

describe("hosted workspace browser protocol", () => {
  it("uses the authenticated ticket's HTTPS socket origin and rejects unsafe origins", () => {
    expect(readHostedWorkspaceSocketOrigin({}, "http://localhost:3170")).toBe("http://localhost:3170");
    expect(readHostedWorkspaceSocketOrigin({ socketOrigin: "https://cloud.example" }, "http://localhost:3170"))
      .toBe("https://cloud.example");
    for (const socketOrigin of ["http://cloud.example", "https://cloud.example/path", "https://user@cloud.example", "file:///tmp/socket", null]) {
      expect(() => readHostedWorkspaceSocketOrigin({ socketOrigin }, "http://localhost:3170")).toThrow();
    }
  });
  it("binds ticket exchange to the selected hosted workspace and same-origin socket", () => {
    expect(
      readHostedWorkspaceId({
        ok: true,
        session: { workspaceId: "customer-workspace-1" },
      }),
    ).toBe("customer-workspace-1");
    expect(readHostedWorkspaceTicket({ ok: true, ticket: TICKET })).toBe(
      TICKET,
    );
    expect(
      buildHostedWorkspaceSocketUrl(
        "https://app.papercusp.com/settings",
        TICKET,
      ),
    ).toBe(
      `wss://app.papercusp.com/api/hosted/connectors/socket?ticket=${TICKET}`,
    );
    expect(buildHostedWorkspaceSocketUrl("http://127.0.0.1:3170", TICKET)).toBe(
      `ws://127.0.0.1:3170/api/hosted/connectors/socket?ticket=${TICKET}`,
    );
    expect(() =>
      buildHostedWorkspaceSocketUrl("file:///tmp/operator", TICKET),
    ).toThrow("unsupported_hosted_workspace_origin");
    expect(
      readHostedWorkspaceTicket({ ok: true, ticket: "replayed" }),
    ).toBeNull();
  });

  it("round-trips UTF-8 and binary frames without Node-only Buffer semantics", () => {
    const value = "paste λ → workspace\n";
    expect(base64ToUtf8(utf8ToBase64(value))).toBe(value);
    expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe("AH+A/w==");
  });

  it("round-trips zero-byte payloads while rejecting malformed non-empty base64", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
    expect(base64ToUtf8("")).toBe("");
    expect(() => base64ToBytes("not base64!")).toThrow("invalid_base64");
  });

  it("parses controller binding, arbitration, resume, output, and exit payloads", () => {
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "session.bound",
        protocol: HOSTED_WORKSPACE_SESSION_PROTOCOL,
        channelId: "channel-1",
        role: "controller",
        binding: { generation: 7, hostedSessionId: "session-1" },
      }),
    ).toEqual({
      kind: "bound",
      channelId: "channel-1",
      role: "controller",
      generation: 7,
      hostedSessionId: "session-1",
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "session.role",
        role: "observer",
        reason: "control_claimed_elsewhere",
      }),
    ).toEqual({
      kind: "role",
      role: "observer",
      reason: "control_claimed_elsewhere",
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.ready",
        resumed: true,
        role: "observer",
      }),
    ).toEqual({ kind: "ready", resumed: true, role: "observer" });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.output",
        data: utf8ToBase64("hello"),
      }),
    ).toEqual({
      kind: "terminal-data",
      source: "output",
      data: new TextEncoder().encode("hello"),
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.exit",
        code: 130,
        signal: 2,
      }),
    ).toEqual({ kind: "exit", code: 130, signal: 2 });
  });

  it("parses file results and explicit controller denials/errors", () => {
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "file.result",
        requestId: "list-1",
        operation: "list",
        entries: [
          { name: "src", kind: "directory" },
          { name: "README.md", kind: "file", bytes: 19 },
          { name: "unsafe", kind: "unknown" },
        ],
      }),
    ).toEqual({
      kind: "file-result",
      requestId: "list-1",
      operation: "list",
      entries: [
        { name: "src", kind: "directory" },
        { name: "README.md", kind: "file", bytes: 19 },
      ],
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "file.result",
        requestId: "read-empty-1",
        operation: "read",
        path: "empty.txt",
        bytes: 0,
        encoding: "base64",
        data: "",
      }),
    ).toEqual({
      kind: "file-result",
      requestId: "read-empty-1",
      operation: "read",
      path: "empty.txt",
      bytes: 0,
      encoding: "base64",
      data: "",
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "session.denied",
        reason: "observer_read_only",
        requestType: "file.upload",
      }),
    ).toEqual({
      kind: "denied",
      reason: "observer_read_only",
      requestType: "file.upload",
    });
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "operation.error",
        requestId: "upload-1",
        operation: "file.upload",
        code: "secret_path_denied",
      }),
    ).toEqual({
      kind: "operation-error",
      requestId: "upload-1",
      operation: "file.upload",
      code: "secret_path_denied",
    });
  });

  it("rejects protocol drift, malformed frames, and non-WebSocket tunnel state", () => {
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "session.bound",
        protocol: "future-protocol",
        channelId: "channel-1",
        role: "controller",
        binding: { generation: 7, hostedSessionId: "session-1" },
      }),
    ).toBeNull();
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.snapshot",
        data: "not base64!",
      }),
    ).toBeNull();
    expect(
      readHostedWorkspaceConnector({
        hostedConnector: { routeLabel: "alpha", transport: "websocket" },
      }),
    ).toEqual({ routeLabel: "alpha", transport: "websocket" });
    expect(
      readHostedWorkspaceConnector({
        connector: { routeLabel: "alpha", transport: "sse" },
      }),
    ).toBeNull();
    expect(
      readHostedWorkspaceConnector({
        state: "connected",
        transport: "gcp-iap-ssh",
      }),
    ).toBeNull();
  });

  it("reads upload limits as a capability, never as a default to assume", () => {
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.ready",
        resumed: false,
        role: "controller",
        limits: { maxFileBytes: 8388608, maxUploadChunkBytes: 524288 },
      }),
    ).toEqual({
      kind: "ready",
      resumed: false,
      role: "controller",
      limits: { maxFileBytes: 8388608, maxUploadChunkBytes: 524288 },
    });

    /* A host that predates chunked upload sends no `limits`, and the parse must
     * leave it ABSENT rather than substituting the current values. Filling it in
     * would make the client chunk at a host that writes each chunk as a whole
     * file, leaving only the last one on disk — a silent truncation. */
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "pty.ready",
        resumed: false,
        role: "controller",
      }),
    ).toEqual({ kind: "ready", resumed: false, role: "controller" });

    /* Half a capability is not a capability: a partially-readable `limits` is
     * dropped whole, not merged with assumptions. */
    for (const limits of [
      { maxFileBytes: 8388608 },
      { maxUploadChunkBytes: 524288 },
      { maxFileBytes: 8388608, maxUploadChunkBytes: 0 },
      { maxFileBytes: "8388608", maxUploadChunkBytes: 524288 },
      "not-an-object",
    ]) {
      expect(
        parseHostedWorkspaceProtocolMessage({
          type: "pty.ready",
          resumed: false,
          role: "controller",
          limits,
        }),
      ).toEqual({ kind: "ready", resumed: false, role: "controller" });
    }
  });

  it("reads the per-chunk upload ack the client paces on", () => {
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "file.progress",
        requestId: "upload-1",
        uploadId: "up-1",
        received: 1024,
        chunks: 2,
        count: 5,
      }),
    ).toEqual({
      kind: "upload-progress",
      requestId: "upload-1",
      uploadId: "up-1",
      received: 1024,
      chunks: 2,
      count: 5,
    });
    /* Dropped rather than half-read: the ack is what releases the next chunk,
     * so acting on an unidentifiable one would advance the wrong upload. */
    expect(
      parseHostedWorkspaceProtocolMessage({
        type: "file.progress",
        requestId: "upload-1",
        received: 1024,
        chunks: 2,
        count: 5,
      }),
    ).toBeNull();
  });

  it("keeps the whole-file guard inside the relay envelope it exists to respect", () => {
    /* PIN, not a restatement (derived-truth ladder rung 2). The client cap is a
     * second copy of a bound the RELAY owns, so this imports the relay's real
     * constant and fails if either side drifts. The failure it prevents is
     * specific: over the envelope the relay CLOSES the browser socket, taking
     * the terminal down with the upload, so a client cap that no longer fits is
     * not a rounding error — it is a destroyed session. */
    const encoded = Math.ceil((HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES * 4) / 3);
    expect(encoded).toBeLessThan(HOSTED_WORKSPACE_MAX_MESSAGE_BYTES);
    /* And it must leave room for the JSON envelope around the payload (type,
     * requestId, path, encoding), not merely squeak under the raw cap. */
    expect(HOSTED_WORKSPACE_MAX_MESSAGE_BYTES - encoded).toBeGreaterThan(4096);
  });
});
