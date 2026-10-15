// @vitest-environment jsdom
/**
 * OperatorChat — operator-state adapter over the shared <PapercupChat>. It owns the
 * input draft state, the submit handler (trim → onSend → clear), the
 * passive/active empty-state copy, the quick-draft prompt buttons, the optional
 * "Generate ideas" composer button, and the PendingCardsBar gating. We stub
 * PapercupChat mount is stubbed to surface the controller + host props so we can
 * assert the adapter logic without the virtualized transcript. It renders the
 * empty state, composer chrome, banner, footer, and a tiny controlled composer.
 * virtualized transcript. Heavy children (cards, logo, Tooltip) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";

/* ── Mocks ─────────────────────────────────────────────────────────── */
// chat-ref-pills-2026-07-26 P-008: OperatorChat now owns `useQueryState` calls
// (the "which popup is open" state for the D-002 seam below) — every suite
// that renders it needs a nuqs mock. A hand-rolled keyed store (same pattern
// PlansPane.test.tsx uses for its own `pplan`) rather than `createNuqsMock()`'s
// singleton, so it can be RESET between tests (the singleton's state would
// otherwise leak across this suite's own test cases).
const { nuqs, nuqsSetters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkNuqsSetter(key: string) {
  if (!nuqsSetters[key])
    nuqsSetters[key] = vi.fn(async (v: unknown) => {
      nuqs[key] = v;
    });
  return nuqsSetters[key];
}
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkNuqsSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
// WI-6601: the two popup DESTINATIONS are no longer rendered by this component
// (or imported by it) — `chat/ChatRefPopupHost` mounts them once at the router
// root, and their render contract is asserted in that component's own test.
// So there is deliberately nothing to stub here: this suite asserts only what
// OperatorChat still owns, which is the param WRITE.
// Capture the props OperatorChat hands the shared component.
let lastProps: Record<string, any> = {};
let lastCardProps: Record<string, any> = {};
vi.mock("@papercusp/operator-ui/papercup-chat", () => ({
  EMPTY_TURN: {
    text: "",
    toolCalls: [],
    provenance: null,
    errorCode: null,
    errorMessage: null,
    retryAfterMs: null,
    cards: [],
    done: false,
  },
  PAPERCUP_CHAT_CSS: "",
  PapercupChat: (props: Record<string, any>) => {
    lastProps = props;
    const submit = () => {
      const text = String(props.inputValue ?? "").trim();
      if (!text) return;
      props.onInputChange?.("");
      void props.chat.send(text);
    };
    return (
      <div data-testid="chat">
        <div data-testid="empty-body">{props.emptyState}</div>
        <div data-testid="banner">{props.banner}</div>
        <div data-testid="transcript-tail">{props.footer}</div>
        <div data-testid="composer-extra">{props.composerChrome}</div>
        <input
          data-testid="input"
          value={props.inputValue}
          onChange={(e) => props.onInputChange?.(e.currentTarget.value)}
        />
        <button data-testid="submit" onClick={submit}>
          send
        </button>
      </div>
    );
  },
}));

vi.mock("./chat/PendingCardsBar", () => ({
  PendingCardsBar: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="pending-cards" data-conv={conversationId} />
  ),
}));
vi.mock("@/lib/chat-cards", () => ({
  renderCard: (_name: string, props: Record<string, any>) => {
    lastCardProps = props;
    return null;
  },
}));
vi.mock("./OperatorLogoMark", () => ({ OperatorLogoMark: () => null }));
vi.mock("../harness/Tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { OperatorChat } from "./OperatorChat";
import { toast } from "sonner";
import { CardAnswerError } from "./OperatorConversationProvider";

function baseProps(over: Record<string, any> = {}) {
  return {
    messages: [],
    busy: false,
    passive: false,
    onSend: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  lastProps = {};
  lastCardProps = {};
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  // The setters are vi.fn()s memoized per key and reused across tests — their
  // CALL history has to be cleared too, or a "never wrote" assertion passes or
  // fails on a previous test's write.
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  cleanup();
});

describe("OperatorChat (operator sidebar chat wrapper)", () => {
  it("loads host bubble tokens without requiring a session-popup ancestor", () => {
    render(<OperatorChat {...baseProps()} />);
    expect(lastProps.className).toBe("op-chat-shared");
    const source = readFileSync(resolve(__dirname, "OperatorChat.tsx"), "utf8");
    expect(source).toContain('import "./operator-chat.css"');
    const css = readFileSync(resolve(__dirname, "operator-chat.css"), "utf8");
    const hostTokens = css.split("}").find((block) => block.includes(".op-chat-shared {"));
    expect(hostTokens).toMatch(/--pc-chat-bubble-assistant:\s*var\(--bg-2\)/);
    expect(hostTokens).toMatch(/--pc-chat-bubble-assistant-fg:\s*var\(--fg\)/);
    expect(hostTokens).toMatch(/--pc-chat-bubble-user:\s*var\(--bg-popover,\s*var\(--bg\)\)/);
    expect(hostTokens).toMatch(/--pc-chat-bubble-user-fg:\s*var\(--fg\)/);
    expect(hostTokens).toMatch(/--pc-chat-link:\s*var\(--accent\)/);
    expect(hostTokens).not.toMatch(/\.session-chat\s+\.op-chat-shared|#f7f7f8|#eef2ff/);
  });

  it("renders the active-mode empty-state body", () => {
    render(<OperatorChat {...baseProps({ passive: false })} />);
    expect(screen.getByTestId("empty-body").textContent).toMatch(
      /inspect, scan, or unblock/i,
    );
  });

  it("renders the passive-mode empty-state body", () => {
    render(<OperatorChat {...baseProps({ passive: true })} />);
    expect(screen.getByTestId("empty-body").textContent).toMatch(
      /passive mode/i,
    );
  });

  it("hides and guards the composer when the counterparty cannot receive messages", () => {
    const onSend = vi.fn();
    render(
      <OperatorChat
        {...baseProps({
          onSend,
          composerDisabled: true,
          composerDisabledMessage:
            "This session has ended — relaunch or resume the agent.",
        })}
      />,
    );

    expect(lastProps.composerDisabled).toBe(true);
    expect(screen.getByTestId("empty-body").textContent).toContain(
      "session has ended",
    );
    expect(
      screen.getByTestId("session-chat-composer-unavailable").textContent,
    ).toContain("relaunch or resume");

    // The prop also guards the wrapper's submit callback, so a stale child
    // event cannot send after the session becomes non-wakeable.
    fireEvent.change(screen.getByTestId("input"), {
      target: { value: "  stale send  " },
    });
    fireEvent.click(screen.getByTestId("submit"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('defaults the empty-state title + composer placeholder to "Papercup"', () => {
    render(<OperatorChat {...baseProps({ passive: false })} />);
    expect(screen.getByTestId("empty-body").textContent).toContain("Papercup");
    expect(lastProps.composerPlaceholder).toBe("Reply to Papercup…");
    expect(lastProps.hostTrust).toBe("owner");
  });

  it("agentName (owner-inbox-single-pane P-007) overrides the empty-state title + placeholder, active and passive", () => {
    const { rerender } = render(
      <OperatorChat
        {...baseProps({ passive: false, agentName: "su · live-1" })}
      />,
    );
    expect(screen.getByTestId("empty-body").textContent).toContain("su · live-1");
    expect(lastProps.composerPlaceholder).toBe("Reply to su · live-1…");

    rerender(
      <OperatorChat
        {...baseProps({ passive: true, agentName: "su · live-1" })}
      />,
    );
    expect(lastProps.composerPlaceholder).toBe("Type to wake su · live-1…");
  });

  it('hides the Papercup-specific "Quick draft prompts" panel when agentName is overridden — those prompts are wrong for a different agent', () => {
    render(<OperatorChat {...baseProps({ agentName: "su · live-1" })} />);
    expect(screen.queryByText("Scan workspaces")).toBeNull();
  });

  it("lets a scoped Papercup thread replace the global empty copy and suppress global quick drafts", () => {
    render(
      <OperatorChat
        {...baseProps({
          emptyStateBody: "Starting a discussion about WI-99…",
          showQuickDraftPrompts: false,
        })}
      />,
    );
    expect(screen.getByTestId("empty-body").textContent).toContain("Papercup");
    expect(screen.getByTestId("empty-body").textContent).toContain("Starting a discussion about WI-99…");
    expect(screen.queryByText("Scan workspaces")).toBeNull();
  });

  it("WI-6503: paneIcon remains the non-user avatar fallback on the shared renderer", () => {
    const AgentMark = () => <span data-testid="agent-mark" />;
    render(
      <OperatorChat
        {...baseProps({
          paneIcon: AgentMark,
          messages: [{ id: "a1", role: "assistant", content: "hi" }],
        })}
      />,
    );
    render(lastProps.renderAvatar(lastProps.chat.turns[0]));
    expect(screen.getByTestId("agent-mark")).toBeTruthy();
  });

  it("quick-draft prompt buttons populate the composer input", () => {
    render(<OperatorChat {...baseProps()} />);
    // The empty-state extra panel renders the three starting-prompt rows.
    const scan = screen.getByText("Scan workspaces");
    fireEvent.click(scan.closest("button")!);
    // setInput was called with the prompt → PapercupChat re-renders with it.
    expect(lastProps.inputValue).toMatch(/Scan my workspaces/i);
  });

  it("submit trims the input, calls onSend, and clears the draft", () => {
    const onSend = vi.fn();
    render(<OperatorChat {...baseProps({ onSend })} />);
    fireEvent.change(screen.getByTestId("input"), {
      target: { value: "  hello  " },
    });
    fireEvent.click(screen.getByTestId("submit"));
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(lastProps.inputValue).toBe(""); // cleared after send
  });

  it("does not call onSend when the input is only whitespace", () => {
    const onSend = vi.fn();
    render(<OperatorChat {...baseProps({ onSend })} />);
    fireEvent.change(screen.getByTestId("input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("submit"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the Generate ideas button only when onGenerateIdeas is provided", () => {
    const onGenerateIdeas = vi.fn();
    render(<OperatorChat {...baseProps({ onGenerateIdeas })} />);
    const btn = screen.getByLabelText("Generate ideas");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onGenerateIdeas).toHaveBeenCalledTimes(1);
  });

  it("omits the Generate ideas button when onGenerateIdeas is absent", () => {
    render(<OperatorChat {...baseProps()} />);
    expect(screen.queryByLabelText("Generate ideas")).toBeNull();
  });

  it("forwards footer through the shared PapercupChat host slot", () => {
    const footer = <div data-testid="session-footer">status</div>;
    render(<OperatorChat {...baseProps({ footer })} />);
    expect(screen.getByTestId("session-footer")).toBeTruthy();
  });

  it("renders PendingCardsBar at the transcript tail only when both ids are set (WI-40828)", () => {
    const { rerender } = render(
      <OperatorChat {...baseProps({ conversationId: "c1" })} />,
    );
    expect(screen.queryByTestId("pending-cards")).toBeNull(); // workspaceId missing

    rerender(
      <OperatorChat
        {...baseProps({ conversationId: "c1", workspaceId: "w1" })}
      />,
    );
    const bar = screen.getByTestId("pending-cards");
    expect(bar.getAttribute("data-conv")).toBe("c1");
    expect(screen.getByTestId("transcript-tail").contains(bar)).toBe(true);
    expect(screen.getByTestId("banner").contains(bar)).toBe(false);
  });

  it("forwards a persisted card decline to answerChoice (WI-4976)", () => {
    const onAnswerChoice = vi.fn();
    render(<OperatorChat {...baseProps({ onAnswerChoice })} />);
    lastProps.renderToolCard(
      { name: "chat:ask_choice", input: { question: "Q", options: [] } },
      { id: "t42", role: "assistant", text: "", createdAt: 0, seq: 42 },
      0,
    );
    lastCardProps.onAnswer({ picks: [], declined: true });
    expect(onAnswerChoice).toHaveBeenCalledWith({
      assistantSeq: 42,
      toolIndex: 0,
      picks: [],
      declined: true,
    });
  });

  // ── WI-5175 — a card click ALWAYS produces feedback ───────────────────
  // Owner repro 2026-07-17: "I clicked one of the options but nothing
  // happened." Every branch below used to return silently or log to the
  // console, which the user never sees — indistinguishable from a dead
  // button. These lock in that each one now SAYS something.
  describe("card answer never fails silently", () => {
    // The suite-level afterEach clears render state but not the toast spies —
    // without this, one test's toast leaks into the next one's assertions.
    // The console.warn spy is deliberate: the handler still logs the raw error
    // for devtools (the toast is for the USER, the log is for us), and this
    // repo fails tests that warn without expecting it.
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.info).mockClear();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warnSpy.mockRestore());

    const card = {
      name: "chat:ask_choice",
      input: { question: "Q", options: [] },
    };
    const renderCardFor = (
      turn: Record<string, any>,
      props: Record<string, any> = {},
    ) => {
      render(<OperatorChat {...baseProps(props)} />);
      lastProps.renderToolCard(card, turn, 0);
    };

    it("tells the user when the message has no seq yet (answer has nowhere to land)", () => {
      const onAnswerChoice = vi.fn();
      // seq undefined — the turn has not persisted yet.
      renderCardFor({ id: "t", role: "assistant", text: "", createdAt: 0 }, { onAnswerChoice });
      lastCardProps.onAnswer({ picks: [{ option_id: "a", label: "A" }] });
      expect(onAnswerChoice).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringMatching(/still saving/i),
      );
    });

    it("tells the user when the surface has no answer handler at all", () => {
      renderCardFor({ id: "t", role: "assistant", text: "", createdAt: 0, seq: 42 }, {});
      lastCardProps.onAnswer({ picks: [{ option_id: "a", label: "A" }] });
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringMatching(/interactive/i),
      );
    });

    it("surfaces an already-answered card as info (the card reconciles to the truth)", async () => {
      const onAnswerChoice = vi
        .fn()
        .mockRejectedValue(
          new CardAnswerError(
            "This question was already answered.",
            "already_answered",
          ),
        );
      renderCardFor(
        { id: "t", role: "assistant", text: "", createdAt: 0, seq: 42 },
        { onAnswerChoice },
      );
      lastCardProps.onAnswer({ picks: [{ option_id: "a", label: "A" }] });
      await vi.waitFor(() => {
        expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
          "This question was already answered.",
        );
      });
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it("surfaces an expired card as an error the user can actually read", async () => {
      const onAnswerChoice = vi
        .fn()
        .mockRejectedValue(
          new CardAnswerError(
            "This question has expired — it's no longer open.",
            "expired",
          ),
        );
      renderCardFor(
        { id: "t", role: "assistant", text: "", createdAt: 0, seq: 42 },
        { onAnswerChoice },
      );
      lastCardProps.onAnswer({ picks: [{ option_id: "a", label: "A" }] });
      await vi.waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          expect.stringMatching(/expired/i),
        );
      });
    });

    it("surfaces an unexpected failure rather than swallowing it into the console", async () => {
      const onAnswerChoice = vi
        .fn()
        .mockRejectedValue(new Error("network exploded"));
      renderCardFor(
        { id: "t", role: "assistant", text: "", createdAt: 0, seq: 42 },
        { onAnswerChoice },
      );
      lastCardProps.onAnswer({ picks: [{ option_id: "a", label: "A" }] });
      await vi.waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith("network exploded");
      });
    });
  });

  describe("ref-pill popup routing (chat-ref-pills-2026-07-26 P-008, D-002 seam)", () => {
    it("forwards harnessSlug straight through to PapercupChat", () => {
      render(<OperatorChat {...baseProps({ harnessSlug: "papercusp" })} />);
      expect(lastProps.harnessSlug).toBe("papercusp");
    });

    // WI-6601: OperatorChat WRITES these params and no longer renders them —
    // `chat/ChatRefPopupHost` owns the single root-level mount. So the contract
    // asserted here is the WRITE. The render half lives in
    // chat/ChatRefPopupHost.test.tsx; that split is the whole point of the fix
    // (a per-instance render is what left the sidebar with no mount at all).
    it("writes a harness-scoped `wpop` on a work-item ref activation", () => {
      render(<OperatorChat {...baseProps({ harnessSlug: "papercusp" })} />);
      expect(nuqs.wpop).toBeUndefined();

      act(() => {
        lastProps.onWorkRefActivate({ id: "WI-5952", kind: "work-item" });
      });

      expect(nuqs.wpop).toBe("papercusp::WI-5952");
    });

    it("writes a harness-scoped `wppop` on a plan-item ref activation, with the message plan_slug", () => {
      render(<OperatorChat {...baseProps({ harnessSlug: "papercusp" })} />);

      act(() => {
        lastProps.onWorkRefActivate({
          id: "P-008",
          kind: "plan-item",
          planSlug: "chat-ref-pills-2026-07-26",
        });
      });

      // The harness rides in the VALUE: the single root renderer can only fall
      // back to the surface's `?slug`, which is the wrong harness whenever a
      // session chat for harness X is open over a board scoped to Y.
      expect(nuqs.wppop).toBe("papercusp::chat-ref-pills-2026-07-26");
    });

    it("does not open a plan popup for a plan-item ref with no message plan_slug (no safe destination)", () => {
      render(<OperatorChat {...baseProps({ harnessSlug: "papercusp" })} />);

      act(() => {
        lastProps.onWorkRefActivate({
          id: "P-008",
          kind: "plan-item",
          planSlug: null,
        });
      });

      expect(nuqs.wppop).toBeUndefined();
      // The setter is BOUND on every render, so its existence proves nothing —
      // assert it was never CALLED.
      expect(nuqsSetters.wppop).not.toHaveBeenCalled();
    });

    it("does not write a work-item ref it cannot scope (no harnessSlug to encode)", () => {
      render(<OperatorChat {...baseProps()} />);

      act(() => {
        lastProps.onWorkRefActivate({ id: "WI-5952", kind: "work-item" });
      });

      // Nothing is written at all — an unscoped `wpop` would resolve
      // `workItems.detail` against whatever harness the URL happens to carry.
      expect(nuqs.wpop).toBeUndefined();
      expect(nuqsSetters.wpop).not.toHaveBeenCalled();
    });
  });

  it("projects provider messages and streaming state into the shared controller", () => {
    const { rerender } = render(
      <OperatorChat
        {...baseProps({
          messages: [{ id: "u1", role: "user", content: "hello", seq: 7, planSlug: "p" }],
        })}
      />,
    );
    expect(lastProps.chat.turns).toEqual([
      expect.objectContaining({ id: "u1", role: "user", text: "hello", seq: 7, planSlug: "p" }),
    ]);
    expect(lastProps.chat.live).toBeNull();

    rerender(
      <OperatorChat
        {...baseProps({
          busy: true,
          messages: [
            { id: "u1", role: "user", content: "hello" },
            { id: "opt-assistant-1", role: "assistant", content: "streaming" },
          ],
        })}
      />,
    );
    expect(lastProps.chat.turns).toHaveLength(1);
    expect(lastProps.chat.live).toEqual(expect.objectContaining({ text: "streaming", done: false }));
    expect(lastProps.chat.streaming).toBe(true);
  });
});
