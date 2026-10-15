// @vitest-environment jsdom
/** Grouped Inbox bulk-resolve report coverage (cleanup-report-flows P-008/P-011). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import type { BulkRun, BulkRunItem } from "./use-inbox-bulk-run";
import {
  PERF_INTERACTIONS,
  beginInteraction,
  getLatestMeasure,
} from "../perf/perf-marks";
import { partitionReviewRows } from "../review-report/ReviewReportShell";

const H = vi.hoisted(() => ({
  accept: vi.fn(),
  dismiss: vi.fn(),
  resume: vi.fn(),
  dismissItem: vi.fn(),
  reconcileItem: vi.fn(),
  undoItem: vi.fn(),
  detail: vi.fn(),
  details: new Map<string, AttentionItem>(),
}));

function openRowDetails(itemId: string): void {
  if (screen.queryByTestId(`review-row-detail-${itemId}`)) return;
  fireEvent.click(screen.getByTestId(`review-row-${itemId}`));
}

vi.mock("./use-inbox-bulk-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-inbox-bulk-run")>();
  return {
    ...real,
    useBulkRunOps: () => ({
      acceptRecommendation: H.accept,
      dismiss: H.dismiss,
      resume: H.resume,
      dismissItem: H.dismissItem,
      reconcileItem: H.reconcileItem,
      undoItem: H.undoItem,
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

vi.mock("@/app/admin/plans/plans-api", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/admin/plans/plans-api")>();
  return {
    ...real,
    usePlanAttentionItem: (id: string | null) => H.detail(id),
  };
});

vi.mock("@/app/admin/plans/PlanOtherList", () => ({
  KIND_LABEL: {
    "coord-message": "Message",
    "coord-escalation": "Escalation",
  },
}));

vi.mock("./InboxBulkRecommendation", () => ({
  default: ({
    rec,
    onAccept,
    onDiscuss,
  }: {
    rec: BulkRunItem;
    onAccept: (draftOverride: string | null) => Promise<{ ok: boolean }>;
    onDiscuss?: () => void;
  }) => (
    <span>
      <button
        type="button"
        data-testid={`recommendation-${rec.itemId}`}
        onClick={() => void onAccept(null)}
      >
        recommendation
      </button>
      {onDiscuss ? (
        <button
          type="button"
          data-testid={`discuss-${rec.itemId}`}
          onClick={onDiscuss}
        >
          discuss
        </button>
      ) : null}
    </span>
  ),
}));

import InboxBulkReport, {
  buildInboxBulkReviewGroups,
  bulkRunItemToAttentionSnapshot,
  bulkUndoAvailability,
  inboxBulkReviewConfidence,
} from "./InboxBulkReport";

const BULK_REPORT_CSS = readFileSync(
  join(__dirname, "inbox-bulk-report.css"),
  "utf8",
);

function attention(
  id: string,
  kind: AttentionItem["kind"] = "coord-message",
  over: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    kind,
    source: "coord",
    harnessSlug: "papercusp",
    title: `Live title ${id}`,
    body: `Body ${id}`,
    status: "open",
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ownerAgentId: "su-live",
    triageState: "untriaged",
    actions: [
      { id: "ack", label: "Acknowledge" },
      { id: "drop", label: "Drop" },
    ],
    ref: { kind, msgId: `m-${id}` },
    ...over,
  };
}

function runItem(over: Partial<BulkRunItem> = {}): BulkRunItem {
  return {
    runId: "run-8",
    itemId: "a",
    position: 0,
    kind: "coord-message",
    title: "Snapshot title a",
    ref: { kind: "coord-message", msgId: "m-a" },
    ownerAgentId: "su-snapshot",
    outcome: "recommended",
    actionId: "ack",
    rationale: "The request is satisfied.",
    draftAnswer: null,
    confidence: "high",
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
    ...over,
  };
}

describe("bulkUndoAvailability", () => {
  it("opens only inside the persisted reversal window and closes after revert", () => {
    const applied = runItem({
      outcome: "auto_resolved",
      revertHandle: { kind: "attention-bulk-item" },
      reversalWindowUntil: "2026-09-02T00:00:00.000Z",
    });
    expect(
      bulkUndoAvailability(applied, Date.parse("2026-09-01T00:00:00.000Z")),
    ).toEqual({
      available: true,
    });
    expect(
      bulkUndoAvailability(applied, Date.parse("2026-09-03T00:00:00.000Z")),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/expired/i),
    });
    expect(
      bulkUndoAvailability({
        ...applied,
        revertedAt: "2026-09-01T12:00:00.000Z",
      }),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/already reverted/i),
    });
  });
});

function highCardinalityRunItems(count = 200): BulkRunItem[] {
  return Array.from({ length: count }, (_, position) =>
    runItem({
      itemId: `item-${position.toString().padStart(3, "0")}`,
      position,
      ref: { kind: "coord-message", msgId: `m-${position}` },
    }),
  );
}

/** Canonical observed run shape from the P-007 acceptance evidence:
 * 13 handled, 6 drafted answers, 3 ready non-answer actions, 136 unresolved. */
function observedInboxRunItems(): BulkRunItem[] {
  let position = 0;
  const next = (over: Partial<BulkRunItem>): BulkRunItem => {
    const current = position++;
    const itemId = over.itemId ?? `observed-${current}`;
    return runItem({
      itemId,
      position: current,
      ref: { kind: "coord-message", msgId: `m-${itemId}` },
      ...over,
    });
  };

  return [
    ...Array.from({ length: 13 }, (_, index) =>
      next({
        itemId: `handled-${index}`,
        outcome: "auto_resolved",
        // Real runs can persist the same action on handled and still-live
        // rows; this mixed group is the mount-cost regression case.
        actionId: "drop",
      }),
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      next({
        itemId: `draft-answer-${index}`,
        outcome: "recommended",
        actionId: "answer",
        draftAnswer: `Draft reply ${index + 1}`,
      }),
    ),
    ...["drop", "drop", "mark-done"].map((actionId, index) =>
      next({
        itemId: `ready-${index}`,
        outcome: "recommended",
        actionId,
      }),
    ),
    ...Array.from({ length: 136 }, (_, index) =>
      next({
        itemId: `unresolved-${index}`,
        outcome: "skipped",
        actionId: null,
        rationale:
          index < 72
            ? "Needs human action from the source surface."
            : index < 93
              ? "Owner ratification is available only from the source surface."
              : "No safe resolver action was available.",
      }),
    ),
  ];
}

const run: BulkRun = {
  runId: "run-8",
  harnessSlug: "papercusp",
  phase: "review",
  totalItems: 3,
  autoResolved: 1,
  recommended: 2,
  skipped: 0,
  failed: 0,
  error: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
};

beforeEach(() => {
  H.resume.mockResolvedValue({ ok: true, phase: "running", launched: true });
  H.dismissItem.mockResolvedValue({ ok: true, phase: "review" });
  H.reconcileItem.mockResolvedValue({ ok: true, phase: "review" });
  H.details.clear();
  H.details.set("a", attention("a"));
  H.details.set("b", attention("b"));
  H.detail.mockImplementation((id: string | null) => ({
    data: id ? (H.details.get(id) ?? null) : null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  performance.clearMarks?.();
  performance.clearMeasures?.();
});

describe("bulkRunItemToAttentionSnapshot", () => {
  it("rebuilds terminal dispatch coordinates from the persisted run row only", () => {
    const snapshot = bulkRunItemToAttentionSnapshot(runItem(), run);
    expect(snapshot).toMatchObject({
      id: "a",
      kind: "coord-message",
      source: "bulk-run-snapshot",
      harnessSlug: "papercusp",
      title: "Snapshot title a",
      ownerAgentId: "su-snapshot",
      ref: { kind: "coord-message", msgId: "m-a" },
    });
    expect(snapshot?.actions).toBeUndefined();
  });

  it("fails closed when the persisted kind and ref discriminant disagree", () => {
    expect(
      bulkRunItemToAttentionSnapshot(
        runItem({ ref: { kind: "coord-escalation", msgId: "m-a" } }),
        run,
      ),
    ).toBeNull();
  });
});

describe("buildInboxBulkReviewGroups", () => {
  it("groups by recommended action + kind and preserves report statuses", () => {
    const items = new Map([
      ["a", attention("a")],
      ["b", attention("b")],
      ["c", attention("c", "coord-escalation")],
    ]);
    const groups = buildInboxBulkReviewGroups(
      [
        runItem({ itemId: "a", position: 0 }),
        runItem({ itemId: "b", position: 1, outcome: "auto_resolved" }),
        runItem({
          itemId: "c",
          position: 2,
          kind: "coord-escalation",
          ref: { kind: "coord-escalation", msgId: "m-c" },
          outcome: "skipped",
          actionId: null,
        }),
      ],
      items,
    );

    const ack = groups.find((group) => group.id === "ack:coord-message");
    const ackOtherResults = groups.find(
      (group) => group.id === "ack:coord-message:other-results",
    );
    expect(ack?.rows).toHaveLength(1);
    expect(ackOtherResults).toMatchObject({
      title: "Acknowledge · Message · Other results",
    });
    expect(ackOtherResults?.rows).toHaveLength(1);
    expect(ack?.rows.find((row) => row.id === "a")).toMatchObject({
      status: "pending",
      selectable: true,
      accounting: "ready",
      confidence: "high",
      sourceLabel: "Message",
      referenceLabel: "Acknowledge",
    });
    expect(ackOtherResults?.rows.find((row) => row.id === "b")).toMatchObject({
      status: "applied",
      selectable: false,
      accounting: "handled",
      confidence: "high",
    });
    expect(
      groups.find((group) => group.title === "Skipped · Escalation")?.rows[0],
    ).toMatchObject({
      status: "pending",
      selectable: false,
      accounting: "not-applied",
    });
  });

  it("preserves canonical confidence and fails closed when no assessment was recorded", () => {
    for (const confidence of [
      "high",
      "medium",
      "low",
      "insufficient",
    ] as const) {
      expect(
        inboxBulkReviewConfidence(
          runItem({
            recommendation: {
              kind: "owner_action",
              label: "Review",
              rationale: "Recorded rationale",
              evidenceBasis: ["recorded evidence"],
              confidence,
              responsibility: "owner",
              actionId: null,
            },
            confidenceLevel: confidence === "low" ? "high" : null,
          }),
        ),
      ).toBe(confidence);
    }

    expect(
      inboxBulkReviewConfidence(
        runItem({ recommendation: null, confidenceLevel: "medium" }),
      ),
    ).toBe("medium");
    expect(
      inboxBulkReviewConfidence(
        runItem({
          recommendation: null,
          confidenceLevel: null,
          confidence: "low",
        }),
      ),
    ).toBe("low");
    for (const outcome of ["pending", "failed"] as const) {
      expect(
        inboxBulkReviewConfidence(
          runItem({
            outcome,
            recommendation: null,
            confidenceLevel: null,
            confidence: null,
          }),
        ),
      ).toBe("insufficient");
    }
  });

  it("keeps only a non-empty drafted Answer selectable among navigate actions", () => {
    const items = new Map([["a", attention("a")]]);
    const drafted = buildInboxBulkReviewGroups(
      [runItem({ actionId: "answer", draftAnswer: "Use the dev key." })],
      items,
    );
    const empty = buildInboxBulkReviewGroups(
      [runItem({ actionId: "answer", draftAnswer: "   " })],
      items,
    );
    expect(drafted[0]?.rows[0]).toMatchObject({
      selectable: true,
      accounting: "manual",
    });
    expect(empty[0]?.rows[0]).toMatchObject({
      selectable: false,
      accounting: "manual",
    });
  });

  it("accounts for the observed 158-row Inbox partition while mounting actionable rows first", () => {
    const runItems = observedInboxRunItems();
    const attentionById = new Map(
      runItems.map((item) => [item.itemId, attention(item.itemId)]),
    );
    const groups = buildInboxBulkReviewGroups(runItems, attentionById);
    const rows = groups.flatMap((group) => group.rows);

    expect(rows).toHaveLength(158);
    expect(partitionReviewRows(groups)).toEqual({
      results: 158,
      ready: 3,
      handled: 13,
      manual: 6,
      // P-004: rows the resolver never reached are their own outcome. This
      // real 158-row capture has none, which is itself the point — the
      // category is additive and does not reshuffle a completed run.
      notAssessed: 0,
      notApplied: 136,
    });
    expect(
      rows.filter((row) => row.accounting === "manual" && row.selectable),
    ).toHaveLength(6);
    expect(
      rows.filter(
        (row) =>
          row.accounting === "not-applied" &&
          row.status === "pending" &&
          row.selectable === false,
      ),
    ).toHaveLength(136);

    render(
      <InboxBulkReport
        run={{
          ...run,
          totalItems: 158,
          autoResolved: 13,
          recommended: 9,
          skipped: 136,
        }}
        runItems={runItems}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("review-report-results-count").textContent).toBe(
      "158",
    );
    expect(screen.getByTestId("review-report-ready-count").textContent).toBe(
      "3",
    );
    expect(screen.getByTestId("review-report-handled-count").textContent).toBe(
      "13",
    );
    expect(screen.getByTestId("review-report-manual-count").textContent).toBe(
      "6",
    );
    expect(
      screen.getByTestId("review-report-not-applied-count").textContent,
    ).toBe("136");
    expect(document.querySelectorAll("[data-review-row-id]")).toHaveLength(9);
    const handledToggle = screen.getByTestId(
      "review-group-toggle-drop:coord-message:other-results",
    );
    expect(handledToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("review-row-handled-0")).toBeNull();
    const unresolvedToggle = screen.getByTestId(
      "review-group-toggle-skipped:coord-message",
    );
    expect(unresolvedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("review-row-unresolved-0")).toBeNull();

    fireEvent.click(unresolvedToggle);
    expect(unresolvedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("review-row-unresolved-0")).toBeTruthy();
    expect(document.querySelectorAll("[data-review-row-id]")).toHaveLength(145);

    fireEvent.click(handledToggle);
    expect(handledToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("review-row-handled-0")).toBeTruthy();
    expect(document.querySelectorAll("[data-review-row-id]")).toHaveLength(158);
  });
});

describe("<InboxBulkReport>", () => {
  it('separates unresolved intake from applied retention without counting unrelated inbox rows', () => {
    const intake = (itemId: string, over: Partial<BulkRunItem>) => runItem({
      itemId, kind: 'improvement', ref: { kind: 'improvement', issueId: itemId }, ...over,
    });
    const items = [
      intake('pending-intake', { outcome: 'pending', actionId: null }),
      intake('failed-intake', { outcome: 'failed', actionId: null }),
      intake('unapplied-intake', { outcome: 'recommended', actionId: 'apply-intake' }),
      intake('retained-intake', { outcome: 'auto_resolved', intakeDecision: {
        disposition: 'retain', reason: 'Preserve the observation', decidedBy: 'reviewer', owner: 'agent',
        targetRef: null, missingInformation: null, decidedAt: '2026-10-01T12:00:00Z',
        workKind: null, acceptance: null, reproduction: null, sourceRevision: 'src-v1:fixture',
      } }),
      intake('rejected-intake', { outcome: 'dismissed' }),
      runItem({ itemId: 'unrelated-message', outcome: 'pending', actionId: null }),
    ];
    render(<InboxBulkReport presentation="settled" run={{ ...run, phase: 'complete', totalItems: items.length }} runItems={items} onClose={vi.fn()} />);
    expect(screen.getByText(/3 intake still open · 2 intake handled · 1 retained-evidence decisions/)).toBeTruthy();
    expect(screen.getByText(/not the retained observation ledger or delivered work/)).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-report-footer').textContent).toContain('processing an observation does not establish');
  });

  it('keeps failed and unreached intake explicit in a settled report and preserves decision evidence', () => {
    const items = [
      runItem({ itemId: 'triage-failed', outcome: 'failed', actionId: null, error: 'Missing source evidence' }),
      runItem({ itemId: 'triage-unreached', outcome: 'pending', actionId: null }),
      runItem({ itemId: 'triage-decided', outcome: 'auto_resolved', actionId: 'apply-intake', intakeDecision: {
        disposition: 'merge', reason: 'Same bounded-parser defect', decidedBy: 'reviewer', owner: 'agent',
        targetRef: 'WI-canonical', missingInformation: null, decidedAt: '2026-10-01T12:00:00Z',
        workKind: null, acceptance: null, reproduction: null, sourceRevision: 'src-v1:fixture',
      } }),
    ];
    const groups = buildInboxBulkReviewGroups(items, new Map());
    expect(groups.flatMap(group => group.rows)).toHaveLength(3);
    const decision = groups.flatMap(group => group.rows).find(row => row.id === 'triage-decided');
    expect(decision?.evidence).toEqual(expect.arrayContaining([
      'intake decision · merge · Same bounded-parser defect', 'canonical target · WI-canonical',
    ]));
    const view = render(<InboxBulkReport run={{ ...run, phase: 'complete', totalItems: 3 }} runItems={items} onClose={vi.fn()} />);
    expect(screen.getByText(/1 failed triage · 1 not reached/)).toBeTruthy();
    expect(screen.getByText(/Writer: deriveRunCounts/)).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-report-footer').textContent).toContain('Closing the report never completes unresolved work');
    view.rerender(<InboxBulkReport presentation="settled" run={{ ...run, phase: 'complete', totalItems: 1 }} runItems={[items[2]!]} onClose={vi.fn()} />);
    expect(screen.getByTestId('inbox-bulk-report-footer').textContent).toContain('processing an observation does not establish that accepted work was completed');
  });

  it("keeps recommendation content and controls inside phone-width details", () => {
    const phoneStart = BULK_REPORT_CSS.indexOf("@container (max-width: 420px)");
    expect(phoneStart).toBeGreaterThan(-1);
    const phoneCss = BULK_REPORT_CSS.slice(phoneStart);

    expect(phoneCss).toMatch(
      /\.inbox-bulk-report__hover-detail\s*\{[^}]*padding:\s*8px;/s,
    );
    expect(phoneCss).toMatch(
      /\.inbox-bulk-report__detail-head,\s*\.inbox-bulk-report__hover-detail \.op-inbox__rec-why\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(phoneCss).toMatch(
      /\.inbox-bulk-report__hover-detail \.op-inbox__rec\s*\{[^}]*min-width:\s*0;[^}]*margin-inline:\s*0;/s,
    );
    expect(phoneCss).toMatch(
      /\.inbox-bulk-report__hover-detail \.op-inbox__rec-actions\s*\{[^}]*flex-wrap:\s*wrap;/s,
    );
    expect(phoneCss).toMatch(
      /\.inbox-bulk-report__hover-detail \.op-inbox__rec-spacer\s*\{[^}]*display:\s*none;/s,
    );
  });

  it("ends the named page-relative report-open measure after the first committed render", async () => {
    beginInteraction(PERF_INTERACTIONS.inboxBulkReportOpen);
    render(
      <InboxBulkReport run={run} runItems={[runItem()]} onClose={vi.fn()} />,
    );

    await waitFor(() =>
      expect(
        getLatestMeasure(PERF_INTERACTIONS.inboxBulkReportOpen),
      ).not.toBeNull(),
    );
  });

  it("applies selected persisted snapshots in run order and closes on completion", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({ ok: true, phase: "complete" });
    const onClose = vi.fn();
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem({ itemId: "a", position: 1 }),
          runItem({
            itemId: "b",
            position: 0,
            actionId: "drop",
            ref: { kind: "coord-message", msgId: "m-b" },
          }),
        ]}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(2));
    expect(H.accept.mock.calls.map((call) => call[1].id)).toEqual(["b", "a"]);
    expect(H.accept.mock.calls[0]?.[1]).toMatchObject({
      source: "bulk-run-snapshot",
      ref: { msgId: "m-b" },
    });
    expect(H.detail).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps 200 selected actions in persisted position order without detail hydration", async () => {
    const ordered = highCardinalityRunItems();
    H.accept.mockResolvedValue({ ok: true, phase: "review" });
    render(
      <InboxBulkReport
        run={{
          ...run,
          totalItems: ordered.length,
          recommended: ordered.length,
        }}
        runItems={[...ordered].reverse()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(ordered.length));
    expect(H.accept.mock.calls.map((call) => call[1].id)).toEqual(
      ordered.map((item) => item.itemId),
    );
    expect(H.detail).not.toHaveBeenCalled();
  });

  it("keeps a stale-target failure visible and unrecorded for retry", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({
        ok: false,
        phase: "review",
        error: "The Inbox action was rejected as stale.",
      });
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem({ itemId: "a", position: 0 }),
          runItem({
            itemId: "b",
            position: 1,
            ref: { kind: "coord-message", msgId: "m-b" },
          }),
        ]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    const alert = await screen.findByTestId("review-row-error-b");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("rejected as stale");
    expect(screen.getByTestId("review-row-mark-a").textContent).toBe("✓");

    // P-010: the failed row LEAVES the pending pool rather than staying ticked.
    // Pressing Apply again must not blind-re-dispatch a resolve that just
    // failed; it is hoisted into "Failed to apply" with its reason and a Retry
    // verb, and recovery goes through the row's own menu.
    expect(screen.getByTestId("review-report-apply").textContent).toContain(
      "(0)",
    );
    expect(screen.getByTestId("review-group-apply-failed")).toBeTruthy();
    expect(screen.getByTestId("review-row-verb-b").textContent).toContain(
      "Retry",
    );
    expect(screen.queryByTestId("review-row-check-b")).toBeNull();
    expect(screen.getByTestId("review-row-menu-b")).toBeTruthy();
  });

  it("hydrates only one explicitly opened detail across 200 report rows", () => {
    const items = highCardinalityRunItems();
    for (const item of items) {
      H.details.set(item.itemId, attention(item.itemId));
    }
    render(
      <InboxBulkReport
        run={{
          ...run,
          totalItems: items.length,
          recommended: items.length,
          autoResolved: 0,
        }}
        runItems={items}
        onClose={vi.fn()}
      />,
    );

    expect(H.detail).not.toHaveBeenCalled();
    const firstId = items[0]!.itemId;
    const secondId = items[1]!.itemId;
    const rowA = screen.getByTestId(`review-row-${firstId}`);
    fireEvent.pointerEnter(rowA);
    expect(H.detail).not.toHaveBeenCalled();
    openRowDetails(firstId);
    expect(screen.getByTestId(`review-row-detail-${firstId}`)).toBeTruthy();
    expect(screen.getByTestId(`recommendation-${firstId}`)).toBeTruthy();
    expect(H.detail).toHaveBeenLastCalledWith(firstId);
    expect(H.detail).toHaveBeenCalledTimes(1);
    expect(
      screen.queryAllByRole("region", { name: /^Details for / }),
    ).toHaveLength(1);

    fireEvent.pointerLeave(rowA);
    openRowDetails(secondId);
    expect(screen.queryByTestId(`review-row-detail-${firstId}`)).toBeNull();
    expect(screen.getByTestId(`review-row-detail-${secondId}`)).toBeTruthy();
    expect(screen.getByTestId(`recommendation-${secondId}`)).toBeTruthy();
    expect(H.detail).toHaveBeenLastCalledWith(secondId);
    expect(H.detail).toHaveBeenCalledTimes(2);
    expect(
      screen.queryAllByRole("region", { name: /^Details for / }),
    ).toHaveLength(1);
  });

  it("shows a terminal stale-item message instead of an endless loading state", () => {
    H.details.delete("a");
    render(
      <InboxBulkReport run={run} runItems={[runItem()]} onClose={vi.fn()} />,
    );

    openRowDetails("a");
    expect(
      screen.getByText(/no longer available in the live Inbox/),
    ).toBeTruthy();
    expect(screen.queryByTestId("recommendation-a")).toBeNull();
  });

  it("reconciles a manual source action only after the live item disappears", async () => {
    H.details.delete("a");
    render(
      <InboxBulkReport run={run} runItems={[runItem()]} onClose={vi.fn()} />,
    );
    openRowDetails("a");
    fireEvent.click(screen.getByTestId("inbox-bulk-reconcile-a"));

    await waitFor(() =>
      expect(H.reconcileItem).toHaveBeenCalledWith("run-8", "a"),
    );
    expect(screen.getByTestId("review-row-mark-a").textContent).toBe("✓");
  });

  it("retries or dismisses an unresolved skipped row after expanding its group", async () => {
    const skipped = runItem({ outcome: "skipped", actionId: null });
    const onClose = vi.fn();
    const { rerender } = render(
      <InboxBulkReport run={run} runItems={[skipped]} onClose={onClose} />,
    );
    const toggle = screen.getByTestId(
      "review-group-toggle-skipped:coord-message",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    openRowDetails("a");
    fireEvent.click(screen.getByTestId("inbox-bulk-retry-a"));
    await waitFor(() => expect(H.resume).toHaveBeenCalledWith("run-8", ["a"]));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <InboxBulkReport run={run} runItems={[skipped]} onClose={onClose} />,
    );
    openRowDetails("a");
    fireEvent.click(screen.getByTestId("inbox-bulk-dismiss-item-a"));
    await waitFor(() =>
      expect(H.dismissItem).toHaveBeenCalledWith(
        "run-8",
        "a",
        "Owner dismissed this item from the grouped recovery report",
      ),
    );
    expect(screen.getByTestId("review-row-mark-a").textContent).toBe("—");
  });

  it("closes only the report view without mutating unresolved rows", () => {
    const onClose = vi.fn();
    render(
      <InboxBulkReport run={run} runItems={[runItem()]} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("review-report-dismiss"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(H.dismiss).not.toHaveBeenCalled();
  });

  it("routes inline accept and Discuss through the hydrated current item", async () => {
    const live = attention("a", "coord-message", {
      ownerAgentId: "su-current",
      harnessSlug: "current-harness",
      ref: { kind: "coord-message", msgId: "m-current" },
    });
    H.details.set("a", live);
    H.accept.mockResolvedValue({ ok: true, phase: "review" });
    const onOpenThread = vi.fn();
    render(
      <InboxBulkReport
        run={run}
        runItems={[runItem()]}
        onOpenThread={onOpenThread}
        onClose={vi.fn()}
      />,
    );

    openRowDetails("a");
    fireEvent.click(screen.getByTestId("discuss-a"));
    expect(onOpenThread).toHaveBeenCalledWith(live);

    fireEvent.click(screen.getByTestId("recommendation-a"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(1));
    expect(H.accept.mock.calls[0]?.[1]).toMatchObject({
      ownerAgentId: "su-current",
      harnessSlug: "current-harness",
      ref: { msgId: "m-current" },
    });
  });
});
