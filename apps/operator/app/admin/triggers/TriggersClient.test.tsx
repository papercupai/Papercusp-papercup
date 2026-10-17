// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import TriggersClient, { idleManualReviewRuns } from "./TriggersClient";

const useFlag = vi.fn(() => true);
const askConfirm = vi.fn(async () => true);
vi.mock("@/lib/flag-hooks", () => ({ useFlag: () => useFlag() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/harness/useConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: askConfirm, element: null }),
}));

const BINDING_ID = "10000000-0000-4000-8000-000000000001";
const payload = {
  enabled: true,
  counts: { sources: 1, bindings: 1, armed: 0, recentFailures: 1 },
  sources: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      kind: "gmail",
      status: "connected",
      config: {},
      credentialRef: "google-oauth:fixture",
      cursor: {},
      lastConnectedAt: "2026-08-22T00:00:00.000Z",
      lastError: null,
      bindingCount: 1,
      armedBindingCount: 0,
      failedDeliveries24h: 1,
      social: null,
    },
    {
      // An opaque provider position without host sync time must not look cold.
      id: "20000000-0000-4000-8000-000000000002",
      kind: "reddit",
      status: "connected",
      config: {},
      // Deliberately unconnected: keeps "credential: configured" unique to the
      // gmail row, and matches today's reality (no social credential is wired).
      credentialRef: null,
      cursor: { provider: "opaque:t3_abc123" },
      lastConnectedAt: "2026-08-22T00:00:00.000Z",
      lastError: null,
      bindingCount: 0,
      armedBindingCount: 0,
      failedDeliveries24h: 0,
      social: {
        platformId: "reddit",
        label: "Reddit",
        verified: true,
        blockedOn: null,
        authMode: "self-serve-oauth",
        readTransport: "poll",
        cursor: {
          state: "position-only" as const,
          at: null,
          ageMs: null,
          position: "opaque:t3_abc123",
          detail: "provider cursor is present; its internal shape is opaque",
        },
        rateBudget: { maxRuns: 6, windowSeconds: 300, basis: "rate-budget", hold: null },
        writeVerified: true,
        writeVerbs: ["reply", "post"],
      },
    },
  ],
  bindings: [
    {
      id: BINDING_ID,
      sourceId: "20000000-0000-4000-8000-000000000001",
      sourceKind: "gmail",
      sourceStatus: "connected",
      planHarnessSlug: "papercusp",
      planSlug: "triage-mail",
      goalId: null,
      workItemHarnessSlug: null,
      workItemKind: null,
      eventPattern: "ext:gmail:message.*",
      eventFilter: { label: "support" },
      action: { type: "launch-plan" },
      armed: false,
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      createdBy: "owner",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      lastRun: null,
    },
  ],
  recentRuns: [],
};

beforeEach(() => {
  useFlag.mockReturnValue(true);
  askConfirm.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return new Response(JSON.stringify({ ok: true, binding: {} }), {
          status: 200,
        });
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
});

afterEach(() => {
  // Without this, every render in this file stayed mounted and queries matched
  // across accumulated trees. It went unnoticed while only ONE test rendered
  // the sources view; a second one turns every getBy into "found multiple".
  cleanup();
  (payload.recentRuns as unknown[]).splice(0);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderClient(searchParams = "?view=bindings") {
  return render(<TriggersClient />, {
    wrapper: withNuqsTestingAdapter({ searchParams }),
  });
}

describe("/admin/triggers client", () => {
  it("renders the URL-selected bindings view from the shared snapshot", async () => {
    renderClient();
    expect(await screen.findByText("ext:gmail:message.*")).toBeTruthy();
    expect(screen.getByText("→ plan papercusp/triage-mail")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Arm ext:gmail:message.*" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("requires a human confirm and sends the server confirmation sentinel", async () => {
    renderClient();
    const toggle = await screen.findByRole("switch", {
      name: "Arm ext:gmail:message.*",
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(askConfirm).toHaveBeenCalledWith({
        title: "Arm ext:gmail:message.*?",
        body: "Matching events may immediately start this plan.",
        confirmLabel: "Arm",
        destructive: true,
      });
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
        op: "set-armed",
        id: BINDING_ID,
        armed: true,
        confirm: true,
      });
    });
  });

  it("deep-links to the sources view through nuqs state", async () => {
    renderClient("?view=sources");
    expect(await screen.findByText(/credential:\s*configured/)).toBeTruthy();
    expect(screen.queryByText("google-oauth:fixture")).toBeNull();
    expect(screen.getByText("1 binding · 0 armed")).toBeTruthy();
    expect(screen.getByText("poll")).toBeTruthy();
    expect(screen.queryByText(/wave [ABC]/)).toBeNull();
  });

  it("renders an opaque provider position without inventing a vendor timestamp contract", async () => {
    renderClient("?view=sources");
    expect(await screen.findByText(/cursor:\s*advancing/)).toBeTruthy();
    expect(screen.getByText(/opaque:t3_abc123.*host sync time not recorded/)).toBeTruthy();
    expect(screen.queryByText(/never synced/)).toBeNull();
  });

  it("shows the platform rate budget rather than an unbounded storm", async () => {
    renderClient("?view=sources");
    expect(await screen.findByText(/budget:\s*up to 6 runs \/ 300s/)).toBeTruthy();
  });

  it("filters to social sources through nuqs state", async () => {
    renderClient("?view=sources&sources=social");
    // The reddit source survives the filter; the gmail one is excluded.
    expect(await screen.findByText("Reddit")).toBeTruthy();
    expect(screen.queryByText(/credential:\s*configured/)).toBeNull();
  });

  it("CONTROL: the unfiltered sources view still shows the non-social source", async () => {
    // Without this, the filter test above would also pass if the social filter
    // were stuck on and gmail never rendered at all.
    renderClient("?view=sources");
    expect(await screen.findByText(/credential:\s*configured/)).toBeTruthy();
    expect(screen.getByText("Reddit")).toBeTruthy();
  });

  it("renders the global trigger-activity feed with cause, policy, plan progress, and outcome", async () => {
    (payload.recentRuns as unknown[]).push({
      id: "run-1",
      bindingId: BINDING_ID,
      sourceKind: "gmail",
      eventPattern: "ext:gmail:message.created",
      planHarnessSlug: "papercusp",
      planSlug: "triage-mail",
      status: "succeeded",
      attempts: 1,
      triggeredAt: "2026-08-22T18:00:00.000Z",
      completedAt: "2026-08-22T18:00:01.000Z",
      planRunRef: "7",
      error: null,
      causeSummary: "Launch review · Ada",
      policyDisposition: "ran",
      policyDetail: "ran",
      planRun: {
        id: 7,
        instancePlanSlug: "triage-mail@run-1",
        status: "done",
        workItems: { total: 2, passed: 2, failed: 0, open: 0 },
        agents: ["su-1"],
      },
      outcomeLinks: [{
        kind: "gmail-draft",
        label: "Re: Launch review",
        href: "https://mail.google.com/mail/u/0/#drafts/draft-1",
      }],
    });
    renderClient("?view=runs");
    expect(await screen.findByText("Launch review · Ada")).toBeTruthy();
    expect(screen.getByText("ran")).toBeTruthy();
    expect(screen.getByText("triage-mail@run-1")).toBeTruthy();
    expect(screen.getByText("done · 2/2 · 1 agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Re: Launch review" }).getAttribute("href")).toContain("drafts/draft-1");
  });

  it("links an operation-backed trigger run to its actual work-item target", async () => {
    (payload.recentRuns as unknown[]).push({
      id: "run-operation",
      bindingId: BINDING_ID,
      sourceKind: "gmail",
      eventPattern: "ext:gmail:message.created",
      planHarnessSlug: null,
      planSlug: null,
      goalId: null,
      workItemHarnessSlug: null,
      workItemKind: null,
      status: "succeeded",
      attempts: 1,
      triggeredAt: "2026-08-22T18:00:00.000Z",
      completedAt: "2026-08-22T18:00:01.000Z",
      planRunRef: null,
      error: null,
      causeSummary: "Operation message",
      policyDisposition: "ran",
      policyDetail: "ran",
      planRun: null,
      blueprintOperation: {
        workspaceId: "papercusp-workspace",
        harnessSlug: "papercusp",
        receiptId: 71,
        operationId: "triage-message",
        specificationRevision: "a".repeat(64),
        target: { kind: "work-item", id: "WI-operation-71" },
      },
      outcomeLinks: [],
    });
    renderClient("?view=runs");
    const link = await screen.findByRole("link", { name: "papercusp#triage-message → WI-operation-71" });
    expect(link.getAttribute("href")).toContain("item=WI-operation-71");
  });

  it("surfaces aged trigger work that is waiting for manual review", async () => {
    const run = {
      id: "run-manual-review",
      bindingId: BINDING_ID,
      sourceKind: "gmail",
      eventPattern: "ext:gmail:message.created",
      planHarnessSlug: "email",
      planSlug: "triage-mail",
      status: "succeeded",
      attempts: 1,
      triggeredAt: "2026-08-22T18:00:00.000Z",
      completedAt: "2026-08-22T18:00:01.000Z",
      planRunRef: "8",
      error: null,
      causeSummary: "Manual review",
      policyDisposition: "ran",
      policyDetail: "ran",
      planRun: {
        id: 8,
        instancePlanSlug: "triage-mail@run-2",
        status: "running",
        workItems: { total: 1, passed: 0, failed: 0, open: 1 },
        agents: [],
      },
      outcomeLinks: [],
    };
    expect(
      idleManualReviewRuns([run] as never, Date.parse("2026-08-23T18:00:00.000Z")),
    ).toHaveLength(1);
    (payload.recentRuns as unknown[]).push(run);
    renderClient("?view=runs");
    expect(await screen.findByText(/Needs review: 1 trigger run has open work/)).toBeTruthy();
  });

  it("renders the flag-off kill-switch without fetching data", () => {
    useFlag.mockReturnValue(false);
    renderClient();
    expect(
      screen.getByText("External trigger administration is switched off."),
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
