// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RubricDetailPanel, {
  mergeScorecardHistoryPage,
} from "./RubricDetailPanel";

const sync = vi.hoisted(() => {
  const trendData = [
    {
      rubricRef: "rubric-quality",
      scorecardCount: 497,
      sample: { limit: 500, inputCount: 500 },
      window: {},
      unknownBreakdown: {
        total: 12,
        graderIncomplete: 7,
        instrumentUnavailable: 2,
        byReason: { "not-assessed": 7, "instrument-unavailable": 2, unspecified: 3 },
      },
      criteria: [
        {
          criterion: "Stable evidence",
          count: 3,
          distribution: { pass: 3 },
          idleCount: 0,
          first: { rating: "pass", at: "2026-07-01" },
          latest: { rating: "pass", at: "2026-07-03" },
          direction: "stable",
          mean10: 8,
        },
        {
          criterion: "Improving clarity",
          count: 3,
          distribution: { pass: 2, partial: 1 },
          idleCount: 0,
          first: { rating: "partial", at: "2026-07-01" },
          latest: { rating: "pass", at: "2026-07-03" },
          direction: "improving",
          mean10: 7,
        },
        {
          criterion: "Regressing cost",
          count: 3,
          distribution: { fail: 2, partial: 1 },
          idleCount: 0,
          first: { rating: "pass", at: "2026-07-01" },
          latest: { rating: "fail", at: "2026-07-03" },
          direction: "regressing",
          mean10: 3,
          instrumentKey: "gate-red-count",
        },
      ],
      status: "active",
      proposedBy: "su-f69a7079-b041-49de-8468-b012df5abb2e",
      ratifiedBy: "su-eb9b7ae3-d528-4584-8379-e69f2b8fe7b9",
      definition: {
        rubricId: "rubric-quality",
        kind: "acceptance",
        subjectPlan: "quality-release-2026-08-24",
        classRef: "plan-class-feature-ship",
        characteristic: "release-quality",
        title: "Rubric quality",
        description:
          "The complete quality contract, including criteria that have never been graded.",
        criteria: [
          {
            key: "never-graded-durability",
            title: "Never graded durability",
            model: "The result remains correct after a cold restart.",
            method: "Run the restart-focused component suite.",
            driftMarkers: "State disappears or changes after restart.",
            replication:
              "Create the fixture, restart the service, then compare the restored state.",
            ratingScale: ["exemplary", "pass", "fail", "unknown"],
            instrumentKey: "restart-durability",
            window: { kind: "rolling", ms: 172_800_000 },
            criterionClass: "violatable",
            check: {
              kind: "tests",
              files: ["apps/operator/app/restart-durability.test.tsx"],
            },
          },
          {
            key: "instrumented-health",
            title: "Instrumented health",
            model: "The health instrument remains green.",
            method: "Read the canonical health instrument.",
            driftMarkers: "The instrument returns fail or unknown.",
            check: {
              kind: "instrument",
              instrumentKey: "quality-health-check",
            },
          },
          {
            key: "coverage-depth",
            title: "Coverage depth",
            model: "Every relevant sync query has intent-level coverage.",
            method: "Read the deterministic coverage census.",
            driftMarkers: "Any relevant sync query falls below L3.",
            window: {
              kind: "post-watermark",
              watermarkRef: "latest-release",
            },
            check: {
              kind: "coverage",
              scope: {
                surfaceKind: "sync-query",
                sourceFiles: ["packages/operator-core/lib/sync-resolver"],
              },
              floor: "l3",
            },
          },
        ],
        ratingScale: ["healthy", "degraded", "broken", "unknown"],
        methodRef: "rubric-quality-runbook",
        releaseGating: true,
        stalenessWatched: true,
        historyResetAt: "2026-07-01T00:00:00.000Z",
        status: "active",
        createdBy: "su-creator",
        proposedBy: "su-f69a7079-b041-49de-8468-b012df5abb2e",
        ratifiedBy: "su-eb9b7ae3-d528-4584-8379-e69f2b8fe7b9",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    },
  ];
  const firstPage = [
    {
      issueId: "scorecard-3",
      createdAt: "2026-07-03T00:00:00.000Z",
      createdBy: "owner",
      score10: 6,
      nKeys: 3,
      rubricResolved: true,
      missingKeys: [],
      _meta: { nextCursor: "cursor-2", hasMore: true },
    },
  ];
  const secondPage = [
    {
      issueId: "scorecard-2",
      createdAt: "2026-07-02T00:00:00.000Z",
      createdBy: "owner",
      score10: 5,
      nKeys: 3,
      rubricResolved: true,
      missingKeys: [],
      _meta: { nextCursor: null, hasMore: false },
    },
  ];
  const summaryData = [{ total: 843, matched: 843, facets: [], selection: [] }];
  return {
    useSyncQuery: vi.fn(
      ({
        queryName,
        args,
      }: {
        queryName: string;
        args?: { cursor?: string };
      }) => ({
        data:
          queryName === "rubrics.trend"
            ? trendData
            : queryName === "scorecards.summary"
              ? summaryData
              : args?.cursor
                ? secondPage
                : firstPage,
        loading: false,
        fetching: false,
        error: null,
      }),
    ),
  };
});

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: sync.useSyncQuery,
}));

const defaultSyncQuery = sync.useSyncQuery.getMockImplementation()!;

afterEach(() => {
  cleanup();
  sync.useSyncQuery.mockClear();
  sync.useSyncQuery.mockImplementation(defaultSyncQuery);
});

describe("RubricDetailPanel unknown rating breakdown", () => {
  function overrideTrend(overrides: Record<string, unknown>) {
    sync.useSyncQuery.mockImplementation((options) => ({
      ...defaultSyncQuery(options),
      ...(options.queryName === "rubrics.trend" ? overrides : {}),
    }));
  }

  it("keeps grader incompleteness distinct from instrument failure in the trend window", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const breakdown = screen.getByLabelText("Unknown rating breakdown");
    expect(breakdown.textContent).toContain("Grader incomplete: 7");
    expect(breakdown.textContent).toContain("Instrument unavailable: 2");
    expect(breakdown.textContent).toContain("Criterion ratings in this trend window");
    expect(breakdown.getAttribute("data-evidence")).toBe("window");
  });

  it("shows measured zeros explicitly", () => {
    const row = defaultSyncQuery({ queryName: "rubrics.trend" }).data[0];
    overrideTrend({
      data: [{ ...row, unknownBreakdown: { total: 0, graderIncomplete: 0, instrumentUnavailable: 0, byReason: {} } }],
    });
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const breakdown = screen.getByLabelText("Unknown rating breakdown");
    expect(breakdown.textContent).toContain("Grader incomplete: 0");
    expect(breakdown.textContent).toContain("Instrument unavailable: 0");
    expect(breakdown.getAttribute("data-evidence")).toBe("window");
  });

  it.each(["missing breakdown", "missing trend row"])("does not turn %s into measured zeros", (state) => {
    const row = defaultSyncQuery({ queryName: "rubrics.trend" }).data[0];
    overrideTrend({ data: state === "missing breakdown" ? [{ ...row, unknownBreakdown: undefined }] : [] });
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const breakdown = screen.getByLabelText("Unknown rating breakdown");
    expect(breakdown.textContent).toBe("Unknown rating breakdown unavailable.");
    expect(breakdown.getAttribute("data-evidence")).toBe("unknown");
  });

  it.each(["loading", "fetching", "error"])("hides cached counts while the trend is %s", (state) => {
    overrideTrend(state === "error" ? { error: new Error("offline") } : { [state]: true });
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const breakdown = screen.getByLabelText("Unknown rating breakdown");
    expect(breakdown.textContent).toBe(state === "error" ? "Unknown rating breakdown unavailable." : "Updating unknown rating breakdown…");
    expect(breakdown.textContent).not.toContain("Grader incomplete: 7");
    expect(breakdown.textContent).not.toContain("Instrument unavailable: 2");
    expect(breakdown.getAttribute("data-evidence")).toBe("unknown");
  });
});

describe("RubricDetailPanel focused evidence", () => {
  it("keeps corpus, loaded-history, and bounded-trend populations explicit while paging", async () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);

    expect(
      screen.getByLabelText(
        "843 scorecards in scorecards filed against rubric-quality",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("rubric-trend-sample-count").textContent).toBe(
      "497 of 500 match in latest 500 scorecards (cap 500); 843 in the full corpus",
    );
    expect(screen.getByTestId("rubric-history-count").textContent).toBe(
      "1 of 843",
    );

    expect(sync.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: "scorecards.list",
        args: { rubricRef: "rubric-quality", limit: 100 },
      }),
    );
    expect(sync.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: "scorecards.summary",
        args: { rubricRef: "rubric-quality" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Grading history/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Load older scorecards" }),
    );
    await waitFor(() => expect(screen.getByText("scorecard-2")).toBeTruthy());
    expect(screen.getByTestId("rubric-history-count").textContent).toBe(
      "2 of 843",
    );
    expect(sync.useSyncQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryName: "scorecards.list",
        args: {
          rubricRef: "rubric-quality",
          limit: 100,
          cursor: "cursor-2",
        },
      }),
    );
  });

  it("puts regressions before improvements and collapses stable criteria and history", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    expect(screen.getByLabelText("Rubric summary")).toBeTruthy();

    const changingTable = screen.getByRole("table", {
      name: "2 changing criteria, regressions first",
    });
    const changingRows = within(changingTable).getAllByRole("row");
    expect(changingRows[1]?.textContent).toContain("Regressing cost");
    expect(changingRows[2]?.textContent).toContain("Improving clarity");
    expect(
      within(changingTable).getByRole("img", {
        name: /2× fail, 1× partial; 3 rated/,
      }),
    ).toBeTruthy();
    expect(changingTable.textContent).not.toContain("Rated");
    expect(screen.queryByText("Stable evidence")).toBeNull();
    expect(screen.queryByText("scorecard-3")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Stable criteria/ }));
    expect(screen.getByText("Stable evidence")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Grading history/ }));
    expect(screen.getByText("scorecard-3")).toBeTruthy();
  });

  it("surfaces the governance provenance chain with the split badge (WI-4607, D-012)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const gov = document.querySelector(".pc-rubric-detail__gov");
    expect(gov).not.toBeNull();
    // status prominence
    expect(
      gov?.querySelector(".pc-rubric-detail__gov-status")?.textContent,
    ).toBe("Active");
    // both identities in the chain, shortened
    expect(gov?.textContent).toContain("su-f69a7079");
    expect(gov?.textContent).toContain("su-eb9b7ae3");
    // author ≠ ratifier ⇒ split badge (the D-012 governance point)
    expect(gov?.querySelector(".pc-rubric-detail__gov-split")).not.toBeNull();
  });

  it("shows the full rubric definition, testing criteria, and ungraded criteria", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);

    expect(screen.getByTestId("rubric-definition")).toBeTruthy();
    expect(
      screen.getByText(
        "The complete quality contract, including criteria that have never been graded.",
      ),
    ).toBeTruthy();

    const properties = screen.getByLabelText("Rubric properties");
    expect(within(properties).getByText("acceptance")).toBeTruthy();
    expect(
      within(properties).getByText("quality-release-2026-08-24"),
    ).toBeTruthy();
    expect(
      within(properties).getByText("plan-class-feature-ship"),
    ).toBeTruthy();
    expect(within(properties).getByText("rubric-quality-runbook")).toBeTruthy();
    expect(within(properties).getAllByText("yes")).toHaveLength(2);

    // This criterion has no trend row or scorecard. It still comes from the
    // definition and is open by default so the testing contract is immediately visible.
    expect(screen.getByText("Never graded durability")).toBeTruthy();
    expect(
      screen.getByText("The result remains correct after a cold restart."),
    ).toBeTruthy();
    expect(
      screen.getByText("Run the restart-focused component suite."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Create the fixture, restart the service, then compare the restored state.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("apps/operator/app/restart-durability.test.tsx"),
    ).toBeTruthy();
    expect(screen.getByText("2d rolling")).toBeTruthy();
    expect(screen.getByText("violatable")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Instrumented health/ }),
    );
    expect(screen.getByText("quality-health-check")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Coverage depth/ }));
    expect(screen.getByText("Since latest-release")).toBeTruthy();
    expect(screen.getByLabelText("Coverage check").textContent).toMatch(
      /Every surface: sync-query.*must meet L3/,
    );
  });

  it("shows the per-criterion instrument binding badge (WI-4607)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const instr = document.querySelector(".pc-rubric-trend__instr");
    expect(instr).not.toBeNull();
    expect(instr?.textContent).toBe("gate-red-count");
  });

  it("renders the Trend column as a colored icon, keeping the word in the aria-label + tooltip (WI-5415)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const changingTable = screen.getByRole("table", {
      name: "2 changing criteria, regressions first",
    });
    // The "regressing" row gets a down-trend icon whose accessible name still
    // carries the word — prose is gone from the visible cell, not from a11y.
    const regressing = within(changingTable).getByRole("img", {
      name: "regressing",
    });
    expect(regressing.querySelector("svg")).not.toBeNull();
    expect(regressing.getAttribute("title")).toBe("regressing");
    expect(regressing.textContent).toBe(""); // no prose left in the visible cell

    fireEvent.click(screen.getByRole("button", { name: /Stable criteria/ }));
    expect(screen.getByRole("img", { name: "stable" })).toBeTruthy();
  });
});

describe("RubricDetailPanel rubric switching (WI-10002802)", () => {
  // The Learning tab reuses ONE panel instance while the selected rubric changes. When the
  // next rubric's reads are already cached they settle immediately (fetching=false), so a
  // render that still held the previous rubric's loaded history paired it with the new
  // rubric's total and filterCountLabel threw "window count cannot exceed corpusTotal",
  // replacing the whole tab with its error boundary.
  it("never pairs the previous rubric's loaded history with the next rubric's total", () => {
    const original = sync.useSyncQuery.getMockImplementation();
    const row = (issueId: string) => ({
      issueId,
      createdAt: "2026-07-03T00:00:00.000Z",
      createdBy: "owner",
      score10: 6,
      nKeys: 3,
      rubricResolved: true,
      missingKeys: [],
      _meta: { nextCursor: null, hasMore: false },
    });
    const byRubric: Record<string, { rows: ReturnType<typeof row>[]; matched: number }> = {
      "rubric-many": { rows: [row("many-1"), row("many-2"), row("many-3")], matched: 3 },
      "rubric-few": { rows: [row("few-1")], matched: 1 },
    };
    const cachedReads = (opts: { queryName: string; args?: unknown }) => {
      const rubricRef = (opts.args as { rubricRef?: string } | undefined)?.rubricRef ?? "";
      const entry = byRubric[rubricRef];
      const data =
        opts.queryName === "scorecards.summary"
          ? [{ total: entry.matched, matched: entry.matched, facets: [], selection: [] }]
          : opts.queryName === "scorecards.list"
            ? entry.rows
            : [];
      return { data, loading: false, fetching: false, error: null };
    };
    sync.useSyncQuery.mockImplementation(
      cachedReads as unknown as Parameters<typeof sync.useSyncQuery.mockImplementation>[0],
    );
    try {
      const { rerender } = render(<RubricDetailPanel rubricId="rubric-many" />);
      expect(screen.getByTestId("rubric-history-count").textContent).toBe("3 of 3");

      rerender(<RubricDetailPanel rubricId="rubric-few" />);
      expect(screen.getByTestId("rubric-history-count").textContent).toBe("1 of 1");
      expect(screen.queryByText("many-1")).toBeNull();

      rerender(<RubricDetailPanel rubricId="rubric-many" />);
      expect(screen.getByTestId("rubric-history-count").textContent).toBe("3 of 3");
    } finally {
      if (original) sync.useSyncQuery.mockImplementation(original);
    }
  });
});

describe("mergeScorecardHistoryPage", () => {
  it("replaces page one and appends cursor pages without duplicate issue ids", () => {
    const first = [
      { issueId: "EI-3", createdAt: "2026-01-03" },
      { issueId: "EI-2", createdAt: "2026-01-02" },
    ] as never[];
    expect(mergeScorecardHistoryPage([], first, null)).toEqual(first);
    const appended = mergeScorecardHistoryPage(
      first,
      [
        { issueId: "EI-2", createdAt: "2026-01-02", createdBy: "updated" },
        { issueId: "EI-1", createdAt: "2026-01-01" },
      ] as never[],
      "cursor-1",
    );
    expect(appended.map((row) => row.issueId)).toEqual([
      "EI-3",
      "EI-2",
      "EI-1",
    ]);
    expect(appended[1]?.createdBy).toBe("updated");
  });
});
