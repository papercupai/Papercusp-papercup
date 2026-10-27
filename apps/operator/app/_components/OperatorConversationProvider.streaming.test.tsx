// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EMPTY_SYNC_DATA: unknown[] = [];
const EMPTY_CARDS: unknown[] = [];
const SYNC = vi.hoisted(() => ({
  turnPage: null as null | { turns: unknown[]; hasMoreEarlier: boolean },
  revision: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (input: { queryName?: string; enabled?: boolean }) => {
    useSyncExternalStore(
      (listener) => {
        SYNC.listeners.add(listener);
        return () => SYNC.listeners.delete(listener);
      },
      () => SYNC.revision,
      () => SYNC.revision,
    );
    return {
      data:
        input.queryName === "operatorTurns.page" &&
        input.enabled !== false &&
        SYNC.turnPage
          ? [SYNC.turnPage]
          : EMPTY_SYNC_DATA,
    };
  },
}));

vi.mock("@/lib/use-workspace-id", () => ({
  useWorkspaceId: () => "papercusp-workspace",
}));

vi.mock("@/lib/use-state-snapshots", () => ({
  useStateSnapshots: () => ({ cards: EMPTY_CARDS }),
}));

vi.mock("@papercusp/operator-core/lib/operator-window-sync", () => ({
  adoptableSharedState: () => null,
  broadcastGenerating: vi.fn(),
  installOperatorWindowSync: () => () => {},
  peerGeneratingNow: () => false,
}));

vi.mock("./voice/voice-mode", () => ({
  getVoiceState: () => ({ mode: "off" }),
  speak: vi.fn(),
  subscribeVoiceState: () => () => {},
}));

vi.mock("./voice/voice-prefs-client", () => ({
  loadVoicePrefsClient: () => ({
    audienceMode: "engineer",
    cardAnsweringEnabled: true,
    proactiveTicksEnabled: false,
  }),
  subscribeVoicePrefsClient: () => () => {},
}));

vi.mock("./voice/voice-converse-handler", () => ({
  setVoiceConverseHandler: vi.fn(),
}));

vi.mock("@papercusp/operator-core/lib/operator-shared-state", () => ({
  sharedState: { paused: true },
}));

import {
  OperatorConversationProvider,
  useOperatorConversation,
  type GenerationFn,
} from "./OperatorConversationProvider";

function Probe() {
  const conversation = useOperatorConversation();
  return (
    <>
      <button
        type="button"
        onClick={() => conversation.sendUserMessage("Stream this reply")}
      >
        Send test
      </button>
      <div data-testid="busy">{String(conversation.busy)}</div>
      <div data-testid="history-hydrated">
        {String(conversation.historyHydrated)}
      </div>
      <div data-testid="error">{conversation.error ?? ""}</div>
      <div data-testid="messages">
        {conversation.messages.map((message, index) => (
          <div
            key={`${message.id ?? "none"}-${index}`}
            data-role={message.role}
            data-seq={typeof message.seq === "number" ? message.seq : "none"}
            data-ts={message.ts ?? "none"}
            data-results={JSON.stringify(message.results ?? [])}
          >
            {message.content}
          </div>
        ))}
      </div>
    </>
  );
}

function AnswerChoiceProbe() {
  const conversation = useOperatorConversation();
  const card = conversation.messages.find((message) =>
    message.tools?.some((tool) => tool.name === "chat:ask_choice"),
  );
  const answered = card?.tools?.some(
    (tool) => tool.name === "chat:ask_choice" && tool.answered,
  );
  return (
    <>
      <div data-testid="choice-state">{answered ? "answered" : "live"}</div>
      <div data-testid="choice-messages">
        {conversation.messages.map((message) => message.content).join("|")}
      </div>
      <div data-testid="choice-turns">
        {conversation.messages
          .map((message) => `${message.id ?? ""}:${message.seq ?? ""}`)
          .join("|")}
      </div>
      <button
        type="button"
        onClick={() =>
          void conversation.answerChoice({
            assistantSeq: 42,
            toolIndex: 0,
            picks: [{ option_id: "keep", label: "Keep" }],
          })
        }
      >
        Answer choice
      </button>
    </>
  );
}

function publishTurnPage(page: { turns: unknown[]; hasMoreEarlier: boolean }) {
  SYNC.turnPage = page;
  SYNC.revision += 1;
  for (const listener of [...SYNC.listeners]) listener();
}

describe("OperatorConversationProvider streamed say projection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    SYNC.turnPage = null;
    SYNC.revision = 0;
    SYNC.listeners.clear();
    sessionStorage.clear();
    sessionStorage.setItem(
      "papercusp.operatorMessages",
      JSON.stringify([{ role: "system", content: "Existing conversation" }]),
    );
    let seq = 100;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? {
                conversationId: "conversation-1",
                turn: { id: `turn-${seq}`, seq: seq++ },
              }
            : { turns: [] },
        text: async () => "",
      })),
    );
  });

  it.each([true, false])("P010 actual converse fetch preserves card call identities and legacy calls (identified=%s)", async identified => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const tools = ["first", "second"].map(id => ({
      name: "chat:ask_choice",
      input: { question: id, options: [{ id: "keep", label: "Keep" }] },
      ...(identified ? { callId: `choice-${id}` } : {}),
    }));
    const frames = tools.map(tool => `event: tool_call\ndata: ${JSON.stringify(tool)}\n\n`).join("")
      + 'event: done\ndata: {}\n\n';
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/agent-mcp/operator-converse"
        ? new Response(frames, { headers: { "content-type": "text/event-stream" } })
        : fallback(input, init));
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener("papercusp:operatorToolCall", listener);
    try {
      render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
      await waitFor(() => {
        const bodies = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
          .map(([, init]) => JSON.parse(String(init?.body)));
        expect(bodies.find(body => body.role === "assistant")?.tools).toEqual(tools);
      });
      expect(events).toEqual(tools.map(tool => expect.objectContaining(tool)));
    } finally {
      window.removeEventListener("papercusp:operatorToolCall", listener);
    }
  });

  it("P010 actual converse fetch rejects mismatched shared event discriminants", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const tool = { name: "chat:ask_choice", input: { question: "Valid card" } };
    const frames = 'event: tool_call\ndata: {"type":"delta","name":"wrong-card"}\n\n'
      + `event: tool_call\ndata: ${JSON.stringify(tool)}\n\n`
      + 'event: done\ndata: {}\n\n';
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/agent-mcp/operator-converse"
        ? new Response(frames, { headers: { "content-type": "text/event-stream" } })
        : fallback(input, init));
    render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => {
      const bodies = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies.find(body => body.role === "assistant")?.tools).toEqual([tool]);
    });
  });

  it("P010 browser persistence reuses one turn identity after a lost acknowledgement", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const writes: Record<string, unknown>[] = [];
    let acknowledged = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === "POST" && String(input).includes("/turns")) {
        const body = JSON.parse(String(init.body));
        if (body.role === "assistant") {
          writes.push(body);
          if (!acknowledged) { acknowledged = true; throw new Error("Committed but acknowledgement lost"); }
        }
      }
      return fallback(input, init);
    });
    const generationFn: GenerationFn = async () => ({ chunks: (async function* () { yield "<say>One reply</say>"; })() });
    render(<OperatorConversationProvider generationFn={generationFn}><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(writes).toHaveLength(2), { timeout: 3000 });
    expect(writes[0].turnId).toEqual(expect.any(String));
    expect(writes[1]).toEqual(writes[0]);
  });

  it("P010 browser adopts the server committed row without posting a duplicate assistant", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const persistedTurn = { conversationId: "conversation-1", turnId: "11111111-2222-4333-8444-555555555555", seq: 104 };
    const frames = 'event: delta\ndata: {"text":"<say>Server saved</say>"}\n\n'
      + `event: done\ndata: ${JSON.stringify({ persistedTurn })}\n\n`;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/agent-mcp/operator-converse"
      ? new Response(frames, { headers: { "content-type": "text/event-stream" } }) : fallback(input, init));
    render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(screen.getByTestId("busy").textContent).toBe("false"));
    expect(screen.getByText("Server saved").getAttribute("data-seq")).toBe("104");
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes.filter(body => body.role === "assistant")).toEqual([]);
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("P010 browser retains result-only canonical turns across replay without admitting legacy result frames or duplicating the saved turn", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const identity = { conversationId: "conversation-1", turnId: "11111111-2222-4333-8444-555555555555" };
    const block = { id: "report-one", kind: "report", title: "Authorized result", sources: [{ ref: "report:r-1" }] };
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const result = { schemaVersion: 1, ...identity, sequence: 1, eventId: "result-one",
      event: { type: "result", blocks: [block] } };
    let requests = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/agent-mcp/operator-converse") return fallback(input, init);
      requests++;
      const request = JSON.parse(String(init?.body));
      if (request.operation === "reconnect") return new Response(frame("chat-event", result)
        + frame("chat-event", { schemaVersion: 1, ...identity, sequence: 2, eventId: "result-updated",
          event: { type: "result", blocks: [{ ...block, title: "Current authorized result" }] } })
        + frame("done", { persistedTurn: { ...identity, seq: 104 } }));
      return new Response(frame("turn-meta", { schemaVersion: 1, ...identity })
        + frame("chat-event", result)
        + frame("result", { blocks: [{ ...block, id: "legacy-spoof", title: "Unvalidated result" }] }));
    });
    render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => {
      const rows = screen.getByTestId("messages").querySelectorAll('[data-role="assistant"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute("data-seq")).toBe("104");
      expect(JSON.parse(rows[0].getAttribute("data-results")!)).toEqual([{ ...block, title: "Current authorized result" }]);
    });
    expect(requests).toBe(2);
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body))).filter(body => body.role === "assistant")).toEqual([]);
  });

  it("P010 history hydration preserves the durable structured result view", async () => {
    const block = { id: "history-result", kind: "document", title: "Saved document", sources: [{ ref: "document:one" }] };
    SYNC.turnPage = { turns: [{ id: "history-turn", conversationId: "saved-conversation", seq: 4,
      role: "assistant", text: "", createdAt: 1000, results: [block] }], hasMoreEarlier: false };
    render(<OperatorConversationProvider target={{ kind: "work-item", conversationId: "saved-conversation" }}><Probe /></OperatorConversationProvider>);
    await waitFor(() => {
      const row = screen.getByTestId("messages").querySelector('[data-role="assistant"]');
      expect(JSON.parse(row?.getAttribute("data-results") ?? "null")).toEqual([block]);
    });
  });

  it.each(["eof", "socket-error", "crlf"])("P010 disconnect versus cancel: resumes after %s without repeating text, tools or provider admission", async failure => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const identity = { conversationId: "conversation-1", turnId: "11111111-2222-4333-8444-555555555555" };
    const receipt = { ...identity, seq: 104 };
    const frame = (event: string, data: unknown) => {
      const wire = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      return failure === "crlf" ? wire.replaceAll("\n", "\r\n") : wire;
    };
    const envelope = (sequence: number, event: unknown) => ({ schemaVersion: 1, ...identity,
      eventId: `event-${sequence}`, sequence, event });
    const first = envelope(1, { type: "delta", text: "<say>Saved " });
    const requests: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/agent-mcp/operator-converse") return fallback(input, init);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (body.operation === "reconnect") {
        return new Response(frame("chat-event", first)
          + frame("chat-event", envelope(2, { type: "delta", text: "once</say>" }))
          + frame("chat-event", envelope(3, { type: "tool_call", name: "read", callId: "native-read", input: { path: "safe" } }))
          + frame("chat-event", envelope(4, { type: "done" }))
          + frame("done", { persistedTurn: receipt }));
      }
      const prefix = frame("run-meta", { chatProtocolVersion: 1, turnPersistence: 1, conversationId: identity.conversationId })
        + frame("turn-meta", { schemaVersion: 1, ...identity }) + frame("chat-event", first)
        + frame("delta", { text: "must ignore duplicate legacy frame" });
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(prefix));
        else if (failure === "socket-error") controller.error(new Error("socket lost"));
        else controller.close();
      } }));
    });
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("papercusp:operatorToolCall", listener);
    try {
      render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
      await waitFor(() => expect(screen.getByTestId("busy").textContent).toBe("false"));
      expect(screen.getByText("Saved once").getAttribute("data-seq")).toBe("104");
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ chatProtocolVersion: 1, messages: expect.any(Array) });
      expect(requests[1]).toEqual({ chatProtocolVersion: 1, operation: "reconnect", ...identity, afterSequence: 1 });
      expect(seen).toEqual([expect.objectContaining({ callId: "native-read", name: "read" })]);
      const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(writes.filter(body => body.role === "assistant")).toEqual([]);
      expect(screen.getByTestId("error").textContent).toBe("");
    } finally { window.removeEventListener("papercusp:operatorToolCall", listener); }
  });

  it.each(["foreign-turn", "sequence-gap", "conflicting-duplicate", "state-on-event-channel", "future-version"])(
    "P010 browser refuses %s without legacy persistence or a replacement execution", async failure => {
      const fallback = vi.mocked(fetch).getMockImplementation()!;
      const identity = { conversationId: "conversation-1", turnId: "11111111-2222-4333-8444-555555555555" };
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const first = { schemaVersion: 1, ...identity, eventId: "first", sequence: 1,
        event: { type: "delta", text: "<say>Partial" } };
      const invalid = { ...first, eventId: "second", sequence: 2,
        ...(failure === "foreign-turn" ? { turnId: "foreign" } : {}),
        ...(failure === "sequence-gap" ? { sequence: 3 } : {}),
        ...(failure === "conflicting-duplicate" ? { sequence: 1 } : {}),
        ...(failure === "state-on-event-channel" ? { event: { type: "state", version: 1, snapshot: {} } } : {}),
        ...(failure === "future-version" ? { schemaVersion: 2 } : {}),
      };
      const requests: unknown[] = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input) !== "/api/agent-mcp/operator-converse") return fallback(input, init);
        requests.push(JSON.parse(String(init?.body)));
        return new Response(frame("turn-meta", { schemaVersion: 1, ...identity })
          + frame("chat-event", first) + frame("chat-event", invalid));
      });
      render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
      await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
      expect(requests).toHaveLength(1);
      const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(writes.filter(body => body.role === "assistant")).toEqual([]);
    });

  it("P010 disconnect versus cancel: explicitly cancels the prior durable turn when a new user turn aborts its generation", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const identity = { conversationId: "conversation-1", turnId: "11111111-2222-4333-8444-555555555555" };
    const replacement = { ...identity, turnId: "66666666-7777-4888-8999-aaaaaaaaaaaa", seq: 106 };
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const requests: Record<string, unknown>[] = [];
    let cancelCommit!: () => void;
    const commit = new Promise<void>(resolve => { cancelCommit = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/agent-mcp/operator-converse") return fallback(input, init);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (body.operation === "cancel") {
        // The independent cancel request must survive the aborted stream.
        expect(init?.signal?.aborted).toBe(false);
        await commit;
        return Response.json({ ok: true, state: { schemaVersion: 1, ...identity, revision: 2,
          phase: "cancelled", lastSequence: 1, capabilities: { connectionReplay: true, persistedHistory: true,
            persistedInteractionDecisions: true, completedToolCheckpoints: false, interruptedTurnRecovery: false } } });
      }
      if (requests.filter(request => !request.operation).length === 1) {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(frame("turn-meta", { schemaVersion: 1, ...identity })
            + frame("chat-event", { schemaVersion: 1, ...identity, sequence: 1, eventId: "partial",
              event: { type: "delta", text: "<say>Partial" } })));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        } }));
      }
      return new Response(frame("delta", { text: "<say>Replacement</say>" }) + frame("done", { persistedTurn: replacement }));
    });
    try {
      render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
      await waitFor(() => expect(screen.getByText("Partial")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
      await waitFor(() => expect(requests.filter(body => body.operation === "cancel")).toEqual([
        { chatProtocolVersion: 1, operation: "cancel", ...identity },
      ]));
      cancelCommit();
      await waitFor(() => expect(screen.getByText("Replacement").getAttribute("data-seq")).toBe("106"));
      expect(requests.filter(body => body.operation === "reconnect")).toEqual([]);
      const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(writes.filter(body => body.role === "assistant")).toEqual([]);
    } finally { cancelCommit(); }
  });

  it("P010 browser rejects an invalid committed receipt without falling back to a new assistant write", async () => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const frames = 'event: delta\ndata: {"text":"<say>Partial</say>"}\n\n'
      + 'event: done\ndata: {"persistedTurn":{"conversationId":"conversation-1","turnId":"invalid","seq":104}}\n\n';
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/agent-mcp/operator-converse"
      ? new Response(frames, { headers: { "content-type": "text/event-stream" } }) : fallback(input, init));
    render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toContain("acknowledgement"));
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes.filter(body => body.role === "assistant")).toEqual([]);
  });

  it.each(["disconnect", "provider-error"])("P010 server managed %s keeps the partial refusal local and never appends a second row", async failure => {
    const fallback = vi.mocked(fetch).getMockImplementation()!;
    const frames = 'event: run-meta\ndata: {"runId":"run-a","turnPersistence":1,"conversationId":"conversation-1"}\n\n'
      + 'event: delta\ndata: {"text":"<say>Partial</say>"}\n\n'
      + (failure === "provider-error" ? 'event: error\ndata: {"message":"provider-failed"}\n\n' : '');
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === "/api/agent-mcp/operator-converse"
      ? new Response(frames, { headers: { "content-type": "text/event-stream" } }) : fallback(input, init));
    render(<OperatorConversationProvider><Probe /></OperatorConversationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toContain(failure === "provider-error" ? "provider-failed" : "recovery"));
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes.filter(body => body.role === "assistant")).toEqual([]);
  });

  it("renders the first safe say delta before completion, then finalizes one assistant row", async () => {
    let releaseFinal!: () => void;
    const waitForFinal = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>First useful words";
        await waitForFinal;
        yield " arrive before completion?</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await waitFor(() => {
      expect(screen.getByText("First useful words")).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("true");
    });
    expect(screen.getAllByText("First useful words")).toHaveLength(1);

    releaseFinal();

    await waitFor(() => {
      expect(
        screen.getByText("First useful words arrive before completion?"),
      ).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen.getAllByText("First useful words arrive before completion?"),
    ).toHaveLength(1);
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("preserves a persisted operator turn's createdAt as the message ISO timestamp", async () => {
    const conversationId = "timestamp-conversation";
    const createdAt = new Date("2026-09-07T16:58:12.345Z").getTime();
    SYNC.turnPage = {
      turns: [
        {
          id: "timestamp-turn",
          conversationId,
          seq: 7,
          role: "assistant",
          text: "Persisted with time",
          createdAt,
        },
      ],
      hasMoreEarlier: false,
    };

    render(
      <OperatorConversationProvider
        generationFn={vi.fn()}
        target={{ kind: "work-item", conversationId }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );

    await waitFor(() => {
      const row = screen
        .getByTestId("messages")
        .querySelector('[data-role="assistant"]');
      expect(row?.getAttribute("data-ts")).toBe(
        "2026-09-07T16:58:12.345Z",
      );
    });
  });

  it("backfills the persisted seq onto in-session messages so a streamed chat:ask_choice card is answerable without a reload (P-011)", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      // Exact regression shape: the model's entire response is the tool call,
      // so there is no <say> delta to allocate a streamed assistant id first.
      chunks: (async function* () {})(),
      tools: [
        {
          name: "chat:ask_choice",
          input: {
            question: "Keep this change?",
            options: [
              { id: "keep", label: "Keep" },
              { id: "drop", label: "Drop" },
            ],
          },
        },
      ],
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    // Both the optimistic user turn and the streamed assistant turn must
    // end up with the server-assigned seq — OperatorChat's onAnswer gate
    // (`typeof msg.seq !== 'number'`) silently drops card clicks on a
    // seq-less message.
    await waitFor(() => {
      const rows = [
        ...screen.getByTestId("messages").querySelectorAll("[data-role]"),
      ];
      const user = rows.filter((r) => r.getAttribute("data-role") === "user");
      const assistant = rows.filter(
        (r) => r.getAttribute("data-role") === "assistant",
      );
      expect(user).toHaveLength(1);
      expect(assistant).toHaveLength(1);
      expect(assistant[0].textContent).toBe("");
      expect(Number(user[0].getAttribute("data-seq"))).toBeGreaterThanOrEqual(
        100,
      );
      expect(
        Number(assistant[0].getAttribute("data-seq")),
      ).toBeGreaterThanOrEqual(100);
    });
  });

  it("keeps an answered choice card answered when the persisted follow-up rehydrates the same page", async () => {
    const conversationId = "choice-conversation-42";
    const unansweredTools = [
      {
        name: "chat:ask_choice",
        input: {
          question: "Keep this change?",
          options: [{ option_id: "keep", label: "Keep" }],
        },
      },
    ];
    const answeredTools = [
      {
        ...unansweredTools[0],
        answered: {
          picks: [{ option_id: "keep", label: "Keep" }],
          at: 2000,
        },
      },
    ];
    SYNC.turnPage = {
      turns: [
        {
          id: "assistant-42",
          conversationId,
          seq: 42,
          role: "assistant",
          text: "",
          createdAt: 1000,
          tools: unansweredTools,
        },
      ],
      hasMoreEarlier: false,
    };
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Follow-up persisted.</say>";
      })(),
    }));

    const view = render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{ kind: "work-item", conversationId }}
      >
        <AnswerChoiceProbe />
      </OperatorConversationProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("choice-state").textContent).toBe("live"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer choice" }));

    await waitFor(() => {
      expect(screen.getByTestId("choice-state").textContent).toBe("answered");
      expect(screen.getByTestId("choice-messages").textContent).toContain(
        "Follow-up persisted.",
      );
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes("/turn-answer")),
    ).toBe(true);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) =>
          String(input).includes(`/conversations/${conversationId}/turns`),
        ),
    ).toBe(true);

    SYNC.turnPage = {
      turns: [
        {
          id: "assistant-42",
          conversationId,
          seq: 42,
          role: "assistant",
          text: "",
          createdAt: 1000,
          tools: answeredTools,
        },
        {
          id: "user-43",
          conversationId,
          seq: 43,
          role: "user",
          text: "Keep",
          createdAt: 2001,
        },
        {
          id: "assistant-44",
          conversationId,
          seq: 44,
          role: "assistant",
          text: "Follow-up persisted.",
          createdAt: 2002,
        },
      ],
      hasMoreEarlier: false,
    };
    view.rerender(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{ kind: "work-item", conversationId }}
      >
        <AnswerChoiceProbe />
      </OperatorConversationProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("choice-state").textContent).toBe("answered"),
    );
  });

  it("reconciles persisted answered tools after SSE invalidation/refetch when the page length is unchanged", async () => {
    const conversationId = "choice-conversation-invalidation-43";
    const unansweredTools = [
      {
        name: "chat:ask_choice",
        input: {
          question: "Keep this change?",
          options: [{ option_id: "keep", label: "Keep" }],
        },
      },
    ];
    const answeredTools = [
      {
        ...unansweredTools[0],
        answered: {
          picks: [{ option_id: "keep", label: "Keep" }],
          at: 2000,
        },
      },
    ];
    const pageBeforeAnswer = {
      turns: [
        {
          id: "user-41",
          conversationId,
          seq: 41,
          role: "user",
          text: "Earlier context",
          createdAt: 1000,
        },
        {
          id: "assistant-42",
          conversationId,
          seq: 42,
          role: "assistant",
          text: "",
          createdAt: 1001,
          tools: unansweredTools,
        },
      ],
      hasMoreEarlier: false,
    };
    const pageAfterAnswer = {
      // The server's tail still contains two rows: the assistant row was
      // mutated in place and the appended card-pick row replaced the older
      // user row at the fixed page boundary.
      turns: [
        {
          id: "assistant-42",
          conversationId,
          seq: 42,
          role: "assistant",
          text: "",
          createdAt: 1001,
          tools: answeredTools,
        },
        {
          id: "user-43",
          conversationId,
          seq: 43,
          role: "user",
          text: "Keep",
          createdAt: 2001,
        },
      ],
      hasMoreEarlier: false,
    };
    SYNC.turnPage = pageBeforeAnswer;
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {})(),
    }));

    render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{ kind: "work-item", conversationId }}
      >
        <AnswerChoiceProbe />
      </OperatorConversationProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("choice-state").textContent).toBe("live"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer choice" }));

    await waitFor(() =>
      expect(screen.getByTestId("choice-state").textContent).toBe("answered"),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes("/turn-answer")),
    ).toBe(true);

    // Model the server's notifySyncInvalidate('operatorTurns.page', ...)
    // reaching an active useSyncQuery observer, followed by its refetch.
    // This deliberately avoids view.rerender: a real SSE invalidation must
    // wake the query subscription itself.
    publishTurnPage(pageAfterAnswer);

    await waitFor(() =>
      expect(screen.getByTestId("choice-state").textContent).toBe("answered"),
    );
    expect(screen.getByTestId("choice-messages").textContent).toContain("Keep");
    await waitFor(() =>
      expect(screen.getByTestId("choice-turns").textContent).toContain(
        "user-43:43",
      ),
    );
  });

  it("removes the partial and persists an assistant refusal when the stream errors", async () => {
    let failStream!: () => void;
    const waitToFail = new Promise<void>((resolve) => {
      failStream = resolve;
    });
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Temporary partial";
        await waitToFail;
        throw new Error("provider unavailable");
      })(),
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await screen.findByText("Temporary partial");

    failStream();

    await waitFor(() => {
      expect(screen.queryByText("Temporary partial")).toBeNull();
      expect(screen.getByTestId("error").textContent).toBe(
        "provider unavailable",
      );
      expect(screen.getByText("The operator could not complete this turn: provider unavailable")).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(1);

    await waitFor(() => {
      const refusalPost = vi.mocked(fetch).mock.calls.find(([input, init]) => {
        if (
          !String(input).includes("/api/operator/conversations/") ||
          !String(input).endsWith("/turns") ||
          init?.method !== "POST"
        ) {
          return false;
        }
        const body = JSON.parse(String(init.body)) as {
          role?: string;
          text?: string;
        };
        return body.role === "assistant" && body.text?.includes("provider unavailable");
      });
      expect(refusalPost).toBeTruthy();
    });
  });

  it("removes the old partial when a newer user turn aborts its generation", async () => {
    let calls = 0;
    const generationFn: GenerationFn = vi.fn(async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          chunks: (async function* () {
            yield "<say>Old partial";
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          })(),
        };
      }
      return {
        chunks: (async function* () {
          yield "<say>Replacement response?</say>";
        })(),
      };
    });

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    const send = screen.getByRole("button", { name: "Send test" });
    fireEvent.click(send);
    await screen.findByText("Old partial");

    fireEvent.click(send);

    await waitFor(() => {
      expect(screen.queryByText("Old partial")).toBeNull();
      expect(screen.getByText("Replacement response?")).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("fails closed before optimistic mutation when a scoped id has not resolved", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>must not run</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{ kind: "work-item", conversationId: null }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );

    // Scoped runtimes do not hydrate the global sessionStorage paint cache.
    expect(screen.queryByText("Existing conversation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toMatch(
        /still resolving.*No message was sent/i,
      );
    });
    expect(generationFn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("messages").children).toHaveLength(0);
  });

  it("marks a scoped conversation history hydrated only after its persisted turn window resolves", async () => {
    SYNC.turnPage = { turns: [], hasMoreEarlier: false };

    render(
      <OperatorConversationProvider
        target={{ kind: "work-item", conversationId: "work-item-empty-99" }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("history-hydrated").textContent).toBe("true"),
    );
    expect(screen.getByTestId("messages").children).toHaveLength(0);
  });

  it("uses only the explicit scoped id for history, writes, and generation", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Scoped reply.</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{
          kind: "work-item",
          conversationId: "work-item-conversation-42",
        }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await screen.findByText("Scoped reply.");
    await waitFor(() => expect(generationFn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(generationFn).mock.calls[0][0]).toMatchObject({
      conversationId: "work-item-conversation-42",
      modality: "text",
      mayAskActive: false,
    });

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(
      urls.every((url) =>
        url.includes(
          "/api/operator/conversations/work-item-conversation-42/turns",
        ),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.includes("/active/"))).toBe(false);

    // No scoped turn may overwrite the root/global paint cache.
    expect(
      JSON.parse(sessionStorage.getItem("papercusp.operatorMessages") ?? "[]"),
    ).toEqual([{ role: "system", content: "Existing conversation" }]);
  });
});
