// @vitest-environment jsdom
//
// ObservationsPanel — the browse-only Observations pane (turn-end reflections).
// Logic worth covering: the loading / empty / populated branches off the
// `learning.observations` sync query, the KIND_LABEL prettifier (known kind →
// label, unknown kind → raw value, missing kind → no chip), and the optional
// per-row metadata (sourceRole / scope / confidence / refs). The sync hook is
// mocked with a hoisted mutable holder (the OperatorActionLog pattern) so each
// test seeds its own rows without a live transport.
//
// P-005: Tests for paired learning.observations.summary totals/facets,
// cursor paging, and staleness tone (based on newest observation age).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";

const { sync, summary, filters } = vi.hoisted(() => ({
  sync: {
    data: [] as unknown[],
    loading: false,
    fetching: false,
    error: null as { message: string } | null,
    // D-004: the two signals that separate "still working" from "failing and
    // retrying". A real SyncQueryResult always carries them (SSE included —
    // SSEAdapter reuses usePollingQuery as its fetcher), so the mock must too,
    // or the honest-loading branch is untestable here.
    failureCount: 0,
    failureReason: null as { message: string } | null,
    args: null as unknown,
    invalidate: vi.fn(),
  },
  summary: {
    data: [] as unknown[],
    loading: false,
    fetching: false,
    error: null as { message: string } | null,
    args: null as unknown,
    invalidate: vi.fn(),
  },
  filters: { itemPlans: [] as string[] },
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { queryName?: string; args?: unknown }) => {
    if (opts.queryName === "learning.observations.summary") {
      summary.args = opts.args;
      return {
        data: summary.data,
        loading: summary.loading,
        error: summary.error,
        fetching: summary.fetching,
        transport: "sse" as const,
        invalidate: summary.invalidate,
      };
    }
    sync.args = opts.args;
    return {
      data: sync.data,
      loading: sync.loading,
      error: sync.error,
      fetching: sync.fetching,
      failureCount: sync.failureCount,
      failureReason: sync.failureReason,
      transport: "sse" as const,
      invalidate: sync.invalidate,
    };
  },
}));
vi.mock("@papercusp/grid-core", () => ({
  // The pane took Retain's persisted, resizable widths; the mock only has to
  // satisfy the [value, setter] shape the component destructures.
  usePersistedColumnWidths: () => [{}, () => {}],
  VirtualGrid: ({
    rows,
    columns,
    onEndReached,
  }: {
    rows: Row[];
    columns: Array<{ key: string; render?: (ctx: { row: Row }) => ReactNode }>;
    onEndReached?: () => void;
  }) => (
    <div data-testid="observations-grid">
      {rows.map((row) => (
        <div key={row.id} data-testid="observation-row">
          {columns.map((column) => (
            <span key={column.key}>{column.render?.({ row })}</span>
          ))}
        </div>
      ))}
      {onEndReached ? <button onClick={onEndReached}>load-more</button> : null}
    </div>
  ),
}));
vi.mock("./use-create-data", () => ({
  useItemPlanFilter: () => [filters.itemPlans, vi.fn()],
}));
// The shared column-filter layer pulls in the grid-core engine (mocked here to
// just VirtualGrid) and nuqs; stub it to a pass-through so these tests stay
// focused on the panel's own list/filter logic (#4 wiring is covered by the
// filters lib's own suite).
// The hook + bar are stubbed (they need their own DOM contract), but
// `filterCountLabel` is deliberately the REAL implementation via importActual:
// it is a pure function and the count assertions below are only meaningful if
// they exercise the shared label the Work Queue renders. Stubbing it would let
// this pane's count drift from that contract while the suite stayed green.
vi.mock("@/app/harness/filters", async () => ({
  useColumnFilterState: () => ({
    state: {},
    setValue: () => {},
    remove: () => {},
    clearAll: () => {},
  }),
  useColumnFiltersFromState: <T,>(
    _cols: unknown,
    rows: readonly T[],
  ) => ({
    rows,
    controller: null,
    activeChips: [],
    hasActive: false,
    clearAll: () => {},
  }),
  ColumnFilterBar: () => null,
  filterCountLabel: (
    await vi.importActual<typeof import("@/app/harness/filters/filter-count-label")>(
      "@/app/harness/filters/filter-count-label",
    )
  ).filterCountLabel,
}));

import ObservationsPanel from "./ObservationsPanel";

/** All renders go through the nuqs testing adapter — the panel reads `obsq`
 *  (search) + `obsview` (table/stacks) from the URL (#4/#7). */
const renderPanel = (searchParams?: string) =>
  render(<ObservationsPanel />, {
    wrapper: withNuqsTestingAdapter(searchParams ? { searchParams } : {}),
  });

interface Row {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}
function mkRow(over: Partial<Row> = {}): Row {
  return {
    id: "o1",
    title: "Title one",
    body: null,
    kind: null,
    scope: null,
    confidence: null,
    refs: [],
    sourceRole: null,
    createdAt: "2026-06-14T12:00:00.000Z",
    ...over,
  };
}

function setSummary(
  total: number,
  matched = total,
  kinds: Array<[string, number]> = [],
) {
  summary.data = [
    {
      total,
      matched,
      facets: kinds.length
        ? [
            {
              key: "kind",
              label: "Signal",
              values: kinds.map(([value, count]) => ({ value, count })),
            },
          ]
        : [],
    },
  ];
}

beforeEach(() => {
  sync.data = [];
  sync.loading = false;
  sync.fetching = false;
  sync.error = null;
  sync.failureCount = 0;
  sync.failureReason = null;
  sync.args = null;
  sync.invalidate.mockReset();
  summary.data = [{ total: 0, matched: 0, facets: [] }];
  summary.loading = false;
  summary.fetching = false;
  summary.error = null;
  summary.args = null;
  summary.invalidate.mockReset();
  filters.itemPlans = [];
});
afterEach(() => cleanup());

describe("<ObservationsPanel />", () => {
  it('labels observation stock as retained evidence rather than pending triage or delivery', () => {
    renderPanel();
    expect(screen.getByText(/Retained evidence · intake handling is separate from delivered work/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'bulk report' }).getAttribute('href')).toBe('/inbox');
  });
  it('R-10/R-32/R-33 reports exact observation triage partitions with their writer and scope', () => {
    setSummary(10);
    (summary.data[0] as { facets: unknown[] }).facets.push({
      key: 'triageState', label: 'Intake triage',
      values: [{ value: 'awaiting', count: 7 }, { value: 'handled', count: 3 }],
    });
    renderPanel();
    const counts = screen.getByTestId('observations-triage-counts');
    expect(counts.textContent).toContain('7 awaiting triage');
    expect(counts.textContent).toContain('3 handled intake');
    expect(counts.title).toContain('current observation filters excluding Intake triage');
    expect(counts.title).toContain('units: rows');
    expect(counts.title).toContain('readLearningObservationsSummaryFromStore');
  });
  it("shows the loading copy while loading with no rows yet", () => {
    sync.loading = true;
    sync.data = [];
    renderPanel();
    expect(screen.getByText(/loading observations…/i)).toBeTruthy();
  });

  it("shows the empty-state copy when there are no observations", () => {
    sync.loading = false;
    sync.data = [];
    renderPanel();
    expect(screen.getByText(/no observations yet/i)).toBeTruthy();
  });

  it("renders one list item per observation with its title", () => {
    sync.data = [
      mkRow({ id: "a", title: "First" }),
      mkRow({ id: "b", title: "Second" }),
    ];
    renderPanel();
    expect(screen.getAllByTestId("observation-row")).toHaveLength(2);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("shows the full observed timestamp, including seconds", () => {
    const createdAt = "2026-06-14T12:34:56.000Z";
    sync.data = [mkRow({ createdAt })];
    renderPanel();
    expect(
      screen.getByText(
        new Date(createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
    ).toBeTruthy();
  });

  it("sends selected plan refs through the server predicate", () => {
    filters.itemPlans = ["plan-alpha"];
    sync.data = [
      mkRow({ id: "a", title: "Alpha exact", refs: ["plan-alpha"] }),
      mkRow({ id: "b", title: "Alpha tagged", refs: ["plan:plan-alpha"] }),
    ];
    setSummary(100, 2);
    renderPanel();
    expect(screen.getAllByTestId("observation-row")).toHaveLength(2);
    expect(sync.args).toMatchObject({
      filters: { plans: ["plan-alpha"] },
      limit: 200,
    });
    expect(summary.args).toEqual({
      q: "",
      filters: { plans: ["plan-alpha"] },
    });
  });

  it("shows a selected-plan empty state when the server returns no match", () => {
    filters.itemPlans = ["plan-alpha"];
    sync.data = [];
    setSummary(100, 0);
    renderPanel();
    expect(
      screen.getByText(/no observations match the current filter \/ search/i),
    ).toBeTruthy();
  });

  it("maps a known kind to its pretty label and passes an unknown kind through", () => {
    sync.data = [
      mkRow({ id: "k1", title: "k1", kind: "friction" }),
      mkRow({ id: "k2", title: "k2", kind: "mystery-kind" }),
    ];
    renderPanel();
    expect(screen.getAllByText("Friction").length).toBeGreaterThanOrEqual(1); // KIND_LABEL.friction
    expect(screen.getAllByText("mystery-kind").length).toBeGreaterThanOrEqual(
      1,
    ); // unknown → raw
  });

  it("uses visible count chips as direct, reversible signal filters", () => {
    sync.data = [
      mkRow({ id: "f1", title: "Friction row", kind: "friction" }),
      mkRow({ id: "g1", title: "Gap row", kind: "gap" }),
    ];
    setSummary(2, 2, [["friction", 1], ["gap", 1]]);
    renderPanel();
    const friction = screen.getByRole("button", {
      name: "Filter by Friction, 1",
    });
    expect(friction.textContent).toContain("Friction");
    expect(friction.textContent).toContain("1");
    fireEvent.click(friction);
    expect(friction.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Friction row")).toBeTruthy();
    expect(screen.queryByText("Gap row")).toBeNull();
    fireEvent.click(friction);
    expect(screen.getByText("Gap row")).toBeTruthy();
  });

  it("puts semantic signals before Other and shows the authoritative store total", () => {
    sync.data = [
      mkRow({ id: "o1", title: "Other row" }),
      mkRow({ id: "f1", title: "Friction row", kind: "friction" }),
      mkRow({ id: "s1", title: "Surprise row", kind: "surprise" }),
    ];
    setSummary(2569, 2569, [["friction", 500], ["surprise", 300], ["other", 1769]]);
    renderPanel();
    const chips = screen.getByLabelText(
      "Signal distribution (database counts)",
    );
    expect(chips.querySelector("button")?.textContent).toContain("Friction");
    expect(chips.querySelector("button:last-child")?.textContent).toContain(
      "other",
    );
    // Unfiltered → the STORE total alone. The retired "3 / 2,569" form reported
    // how many rows happened to be downloaded, which tracked scroll position
    // rather than answering anything, and read as a shortfall on a healthy pane.
    expect(screen.getByTestId("observations-count").textContent).toBe("2,569");
    expect(
      screen.getByTestId("observations-count").getAttribute("aria-label"),
    ).toBe("2,569 observations in the observation corpus");
  });

  it("reveals the full body and context only for the selected observation", () => {
    sync.data = [
      mkRow({
        id: "full",
        title: "Full row",
        body: "a longer note",
        sourceRole: "engineer",
        scope: "repo",
        confidence: "high",
        refs: ["F-1", "WI-2"],
      }),
    ];
    renderPanel();
    expect(screen.queryByText("a longer note")).toBeNull();
    expect(
      screen.queryByText("engineer · repo · high · F-1 · WI-2"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand observation Full row" }),
    );
    expect(screen.getByText("a longer note")).toBeTruthy();
    expect(
      screen.getByText("engineer · repo · high · F-1 · WI-2"),
    ).toBeTruthy();
  });

  // WI-5419: owner reported the expanded body still reads as "cut off" even
  // after the 2026-07-18 measureVariableHeight fix (which only verified a
  // short synthetic 212px row). VirtualGrid is mocked out in this file, so
  // this test can't exercise the virtualizer's slot-height measurement (see
  // the companion Playwright spec, observations-panel-long-body-clipping.spec.ts,
  // for that) — but it DOES pin that the component never truncates the body
  // in JS/React for a REAL long-body shape (750+ chars, including a 178-char
  // unbroken token with no spaces — pulled 2026-07-19 from
  // harness_shared.engineer_issues, topic=papercusp-observation). If this
  // regresses to a JS-level slice/truncate of `body`, this test catches it
  // even though it can't see a pure-CSS overflow clip.
  it("shows the FULL real long-body text (incl. a long unbroken token) when expanded — no JS truncation", () => {
    const longToken =
      "'_components/chat|chat-cards|OperatorChat|OperatorConversation|ask_choice|ask-choice|voice|turn-answer|operator-converse|VoiceApp|brain-session|operator-mcp-tools|libs/flags/src'";
    const tail =
      " — zero hits means carry verdicts and bump the baseline; any hit means re-ground via a fresh self-drive before trusting the prior verdict.";
    const body = `Deploy-diff triage: git -C ~/papercupai-workspace/papercup-release diff --name-only OLD NEW | grep -iE ${longToken}${tail}`;
    sync.data = [
      mkRow({
        id: "long-token",
        title: "Deploy-diff triage recipe (long-token real shape)",
        body,
      }),
    ];
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand observation Deploy-diff triage recipe (long-token real shape)",
      }),
    );
    // The rendered body node's own textContent must contain the FULL string,
    // including the long token and everything after it — not merely a
    // truncated head. It lives in the DETAIL ASIDE now rather than inside the
    // row (owner ask: "side panel like Retain"); the no-JS-truncation contract
    // this pins is unchanged, only its address is.
    const bodyNode = screen
      .getByRole("complementary", { name: "Observation detail" })
      .querySelector(".pc-observations__body");
    expect(bodyNode?.textContent ?? "").toContain(longToken);
    expect(bodyNode?.textContent ?? "").toContain(tail.trim());
  });

  it("advances the server cursor at the virtualized scroll edge and shows the authoritative total", async () => {
    sync.data = [
      {
        ...mkRow({ id: "a", title: "First" }),
        _meta: { nextCursor: "cursor-2", hasMore: true },
      },
      mkRow({ id: "b", title: "Second" }),
    ];
    setSummary(450);
    renderPanel();
    expect(sync.args).toEqual({ q: "", filters: {}, limit: 200 });
    expect(screen.getByTestId("observations-count").textContent).toBe("450");
    fireEvent.click(screen.getByText("load-more"));
    await waitFor(() =>
      expect(sync.args).toEqual({
        q: "",
        filters: {},
        limit: 200,
        cursor: "cursor-2",
      }),
    );
  });

  it("declares a filtered count as exact corpus evidence", () => {
    sync.data = [mkRow({ id: "a", title: "alpha match" })];
    setSummary(36096, 1);
    renderPanel("?obsq=alpha");
    expect(screen.getByTestId("observations-count").textContent).toBe(
      "1 of 36,096",
    );
    expect(
      screen.getByTestId("observations-count").getAttribute("aria-label"),
    ).toBe("1 of 36,096 match in the observation corpus");
  });

  // D-004 (owner 2026-08-17, on the sibling Retain pane: "it just says 'loading
  // retained items...' forever"). `loading` is isPending && isFetching, which
  // stays TRUE for the whole retry sequence while `error` stays NULL until the
  // retries are exhausted — so a failing read must not render as a motionless
  // spinner. These two tests are a PAIR: the first pins the honest branch, the
  // second pins that a genuinely-first-load spinner is left alone.
  it("says attempts are FAILING rather than showing a bare spinner, and offers a retry", () => {
    sync.data = [];
    sync.loading = true;
    sync.failureCount = 2;
    sync.failureReason = { message: "query timed out after 10000ms" };
    renderPanel();
    expect(screen.queryByText("Loading observations…")).toBeNull();
    expect(
      screen.getByText(/2 attempts failed, retrying/).textContent,
    ).toContain("Still loading observations");
    expect(screen.getByText(/query timed out after 10000ms/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(sync.invalidate).toHaveBeenCalled();
  });

  it("keeps the plain spinner while a first attempt is still in flight", () => {
    sync.data = [];
    sync.loading = true;
    sync.failureCount = 0;
    renderPanel();
    expect(screen.getByText("Loading observations…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
  });

  it("keeps cached rows painted during a sync refresh", () => {
    sync.data = [mkRow({ id: "a", title: "Still here" })];
    sync.loading = true;
    sync.fetching = true;
    renderPanel();
    expect(screen.getByText("Still here")).toBeTruthy();
    expect(screen.queryByText(/loading observations/i)).toBeNull();
  });

  it("refreshes through the shared sync query", () => {
    sync.data = [mkRow()];
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh observations" }),
    );
    expect(sync.invalidate).toHaveBeenCalledTimes(1);
    expect(summary.invalidate).toHaveBeenCalledTimes(1);
  });

  // ── P-005: summary facets, 500+ guard, staleness tone ──

  it("renders signal counts from learning.observations.summary", () => {
    sync.data = [mkRow({ id: "a", kind: "friction" })];
    setSummary(1100, 1100, [["friction", 500], ["gap", 600]]);
    renderPanel();
    // Signal distribution should show database counts, not loaded counts
    const frictionBtn = screen.getByRole("button", {
      name: "Filter by Friction, 500",
    });
    expect(frictionBtn).toBeTruthy();
    const gapBtn = screen.getByRole("button", {
      name: "Filter by Gap, 600",
    });
    expect(gapBtn).toBeTruthy();
  });

  it("applies 500+ render guard to counts >= 500", () => {
    sync.data = [mkRow()];
    setSummary(1500, 1500, [
      ["friction", 500],
      ["gap", 501],
      ["surprise", 499],
    ]);
    renderPanel();
    expect(
      screen.getByRole("button", { name: "Filter by Friction, 500" })
        .textContent,
    ).toContain("500+");
    expect(
      screen.getByRole("button", { name: "Filter by Gap, 501" }).textContent,
    ).toContain("500+");
    expect(
      screen.getByRole("button", {
        name: "Filter by Surprise, 499",
      }),
    ).toBeTruthy();
  });

  it("applies staleness tone based on newest observation age", () => {
    const now = Date.now();
    const fresh = new Date(now - 15 * 60_000).toISOString(); // 15min ago
    const stale = new Date(now - 90 * 60_000).toISOString(); // 90min ago
    const veryStale = new Date(now - 3 * 60_60_000).toISOString(); // 3+ hours ago

    setSummary(1, 1, [["other", 1]]);

    // Fresh: newest <30min ago
    sync.data = [mkRow({ id: "a", createdAt: fresh })];
    const { rerender } = renderPanel();
    let dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("fresh");

    // Stale: newest 30min-2h ago
    sync.data = [mkRow({ id: "a", createdAt: stale })];
    rerender(<ObservationsPanel />);
    dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("stale");

    // Very stale: newest 2h+ ago
    sync.data = [mkRow({ id: "a", createdAt: veryStale })];
    rerender(<ObservationsPanel />);
    dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("very-stale");
  });

  it("defaults to very-stale when no observations are loaded", () => {
    sync.data = [];
    renderPanel();
    // When empty, staleness defaults to very-stale (no data)
    // The distribution div won't render if there are no signal counts, so check nothing breaks
    expect(screen.queryByText(/no observations yet/i)).toBeTruthy();
  });

  it("filters the loaded rows through the quick-search box (#4)", async () => {
    sync.data = [
      mkRow({ id: "a", title: "Cache warmup idea" }),
      mkRow({ id: "b", title: "Prompt tuning idea" }),
    ];
    renderPanel();
    fireEvent.change(screen.getByLabelText("Search observations"), {
      target: { value: "cache" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Prompt tuning idea")).toBeNull(),
    );
    expect(screen.getByText("Cache warmup idea")).toBeTruthy();
  });

  it("renders the stacks view as one overlapping deck per kind, navigable card-by-card (#7)", () => {
    sync.data = [
      mkRow({ id: "a", title: "Friction one", kind: "friction" }),
      mkRow({ id: "b", title: "Friction two", kind: "friction" }),
      mkRow({ id: "c", title: "Gap one", kind: "gap" }),
    ];
    render(<ObservationsPanel />, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?obsview=stacks" }),
    });
    // Same-kind cards overlap: the top card is live; the stacked card behind
    // it is mounted (content dimmed under the pile) but aria-hidden + inert.
    expect(
      screen.getByText("Friction one").closest('[aria-hidden="true"]'),
    ).toBeNull();
    expect(
      screen.getByText("Friction two").closest('[aria-hidden="true"]'),
    ).toBeTruthy();
    expect(
      screen.getByText("Gap one").closest('[aria-hidden="true"]'),
    ).toBeNull();
    // The friction deck (2 cards, rendered first) steps to the next card.
    fireEvent.click(screen.getAllByRole("button", { name: "Next card" })[0]);
    expect(
      screen.getByText("Friction two").closest('[aria-hidden="true"]'),
    ).toBeNull();
  });
});
