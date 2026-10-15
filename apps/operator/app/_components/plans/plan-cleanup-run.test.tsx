// @vitest-environment jsdom
/** Plans clean-up strip + client seam coverage (cleanup-report-flows P-006). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  syncArgs: [] as Array<Record<string, unknown>>,
  syncData: { value: undefined as unknown },
  fetch: vi.fn(),
  resolverProfile: {
    model: "sol",
    effort: "xhigh" as const,
    account: "pool-a",
    carry: "cold" as const,
  },
}));

vi.mock("../bulk-resolver/bulk-resolver-settings", () => ({
  loadResolverLaunchProfile: async () => H.resolverProfile,
  useBulkResolverSettings: () => ({
    profile: H.resolverProfile,
    loading: false,
    saving: false,
    error: null,
    validationError: null,
    ready: true,
    updateProfile: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock("../bulk-resolver/BulkResolverSettingsControl", () => ({
  default: ({ kind, effective }: { kind: string; effective?: unknown }) => (
    <div
      data-testid={`${kind}-settings-control`}
      data-effective={effective ? JSON.stringify(effective) : undefined}
    />
  ),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (args: Record<string, unknown>) => {
    H.syncArgs.push(args);
    return {
      data: H.syncData.value,
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
  },
}));

vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, options, onChange, ariaLabel }: {
    value: string; options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void; ariaLabel: string;
  }) => <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));

import PlansCleanupStrip, {
  PlanCleanupReviewSelector,
  type PlansCleanupStripProps,
} from "./PlansCleanupStrip";
import {
  derivePlanCleanupCounts,
  parsePlanCleanupCoverage,
  planCleanupCoverageNotice,
  snapshotPlanSlugs,
  usePlanCleanupOps,
  usePlanCleanupRun,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from "./use-plan-cleanup-run";

function run(over: Partial<PlanCleanupRun> = {}): PlanCleanupRun {
  return {
    runId: "run-1",
    phase: "running",
    runKind: "plan-cleanup",
    seedRefs: ["p-one", "p-two"],
    totalItems: 2,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: "2026-08-24T12:00:00.000Z",
    startedAt: "2026-08-24T12:00:10.000Z",
    finishedAt: null,
    ...over,
  };
}

function finding(over: Partial<PlanCleanupFinding> = {}): PlanCleanupFinding {
  return {
    runId: "run-1",
    findingId: "flip-to-done:papercusp/p-one#P-001",
    kind: "flip-to-done",
    planSlug: "p-one",
    harnessSlug: "papercusp",
    itemId: "P-001",
    target: "P-001",
    from: "todo",
    to: "done",
    confidence: "provable",
    evidence: [],
    position: 0,
    outcome: "pending",
    error: null,
    decidedAt: null,
    ...over,
  };
}

function props(
  over: Partial<PlansCleanupStripProps> = {},
): PlansCleanupStripProps {
  return {
    planSlugs: ["p-one", "p-two"],
    filterSnapshot: { query: null, shownCount: 2 },
    run: null,
    findings: [],
    recommendations: [],
    pending: [],
    isRunning: false,
    isReview: false,
    onRunStarted: vi.fn(),
    onReview: vi.fn(),
    onRunCleared: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  H.syncArgs.length = 0;
  H.syncData.value = undefined;
  H.fetch.mockReset();
  H.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", H.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("plan clean-up derivation", () => {
  it("snapshots the pane order while trimming and deduping slugs", () => {
    expect(snapshotPlanSlugs([" p-two ", "p-one", "p-two", "", "  "])).toEqual([
      "p-two",
      "p-one",
    ]);
  });

  it("derives progress from finding rows, including owner-accepted as applied", () => {
    const counts = derivePlanCleanupCounts([
      finding({ findingId: "a", outcome: "auto_applied" }),
      finding({ findingId: "b", outcome: "accepted" }),
      finding({ findingId: "c", outcome: "recommended" }),
      finding({ findingId: "d", outcome: "skipped" }),
      finding({ findingId: "e", outcome: "failed" }),
      finding({ findingId: "f", outcome: "pending" }),
    ]);
    expect(counts).toMatchObject({
      total: 6,
      applied: 2,
      forReview: 1,
      skipped: 1,
      failed: 1,
      pending: 1,
      decided: 5,
      percent: 83,
    });
  });
});

describe("usePlanCleanupRun", () => {
  it("keeps the selected run usable and discloses an unavailable older-review inventory", () => {
    const inventory = { runs: [], total: 0, error: "Older cleanup reviews could not be loaded." };
    H.syncData.value = [{ run: run({ phase: "review" }), findings: [], reviewInventory: inventory }];
    const { result } = renderHook(() => usePlanCleanupRun("run-1"));
    expect(result.current.run?.runId).toBe("run-1");
    render(<PlanCleanupReviewSelector inventory={result.current.reviewInventory} selectedRunId="run-1" onReview={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("could not be loaded");
  });

  it("preserves older unresolved runs and opens their exact existing report id", () => {
    const inventory = { total: 2, runs: [
      { runId: "new-review", createdAt: "2026-10-07T12:00:00Z", unresolved: 77 },
      { runId: "old-review", createdAt: "2026-10-06T12:00:00Z", unresolved: 104 },
    ] };
    H.syncData.value = [{ run: run({ runId: "new-review", phase: "review" }), findings: [], reviewInventory: inventory }];
    const { result } = renderHook(() => usePlanCleanupRun());
    expect(result.current.reviewInventory).toEqual(inventory);
    const onReview = vi.fn();
    render(<PlanCleanupReviewSelector inventory={result.current.reviewInventory} selectedRunId="new-review" onReview={onReview} />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText(/104 need review/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Unresolved cleanup reviews" }), { target: { value: "old-review" } });
    expect(onReview).toHaveBeenCalledWith("old-review");
  });

  it("subscribes to plans.cleanupRun by deep-linked run id and derives phase lists", () => {
    const recommended = finding({ findingId: "rec", outcome: "recommended" });
    const pending = finding({ findingId: "pending", outcome: "pending" });
    H.syncData.value = [
      { run: run({ phase: "review" }), findings: [recommended, pending] },
    ];

    const { result } = renderHook(() =>
      usePlanCleanupRun("run-1", { enabled: true }),
    );
    expect(H.syncArgs.at(-1)).toMatchObject({
      queryName: "plans.cleanupRun",
      args: { runId: "run-1" },
      enabled: true,
    });
    expect(result.current.isReview).toBe(true);
    expect(result.current.recommendations.map((row) => row.findingId)).toEqual([
      "rec",
    ]);
    expect(result.current.pending.map((row) => row.findingId)).toEqual([
      "pending",
    ]);
  });

  it("holds no live subscription when the feature flag is off", () => {
    renderHook(() => usePlanCleanupRun(null, { enabled: false }));
    expect(H.syncArgs.at(-1)).toMatchObject({
      queryName: "plans.cleanupRun",
      args: {},
      enabled: false,
    });
  });
});

describe("plan clean-up coverage (P-005, WI-10004732)", () => {
  it("parses the start response's coverage triple and rejects malformed values", () => {
    expect(parsePlanCleanupCoverage({ requested: 750, accepted: 200, truncated: 550 })).toEqual({
      requested: 750,
      accepted: 200,
      truncated: 550,
    });
    expect(parsePlanCleanupCoverage({})).toBeUndefined();
    expect(parsePlanCleanupCoverage({ requested: 3, accepted: -1, truncated: 0 })).toBeUndefined();
  });

  it('says "first N of M" only when the run carries fewer plans than shown', () => {
    expect(planCleanupCoverageNotice({ requested: 750, accepted: 200, truncated: 550 })).toBe(
      "Scanning the first 200 of 750 shown plans (least recently scanned first) — run Clean-up again to cover the other 550.",
    );
    expect(planCleanupCoverageNotice({ requested: 12, accepted: 12, truncated: 0 })).toBeNull();
    expect(planCleanupCoverageNotice(undefined)).toBeNull();
  });

  it("start() surfaces the server's coverage on the result", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-capped",
        launched: false,
        resolverNeeded: false,
        requested: 750,
        accepted: 200,
        truncated: 550,
      }),
    });
    const { result } = renderHook(() => usePlanCleanupOps());
    const started = await result.current.start(["p-one"], { scope: "all" });
    expect(started.coverage).toEqual({ requested: 750, accepted: 200, truncated: 550 });
  });
});

describe("usePlanCleanupOps", () => {
  it("uses the saved Plans profile for start callers without an inline settings control", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, runId: "run-single", launched: true }),
    });
    const { result } = renderHook(() => usePlanCleanupOps());

    await result.current.start(["p-one"], { scope: "single-plan" });

    // loadResolverLaunchProfile is stubbed at the module boundary above; this
    // pins the consumer branch and the start-route payload, while the real GET
    // + normalization is covered in BulkResolverSettingsControl.test.tsx.
    expect(H.fetch.mock.calls[0][0]).toBe("/api/admin/plan-cleanup");
    expect(JSON.parse(H.fetch.mock.calls[0][1].body as string)).toMatchObject({
      planSlugs: ["p-one"],
      launch: H.resolverProfile,
    });
  });

  it("records one owner acceptance through the plan-cleanup route", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, phase: "complete", accepted: true }),
    });
    const { result } = renderHook(() => usePlanCleanupOps());
    const accepted = await result.current.accept(
      "run-1",
      "finding-1",
      "owner checked it",
    );
    expect(accepted).toEqual({ ok: true, phase: "complete" });
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "accept",
      runId: "run-1",
      findingId: "finding-1",
      note: "owner checked it",
    });
  });

  it("routes selected retry, live recheck, and per-finding dismissal through the existing owner endpoint", async () => {
    H.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          phase: "running",
          launched: true,
          preservedOutcomes: 3,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, phase: "review", resolved: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, phase: "complete", dismissed: true }),
      });
    const { result } = renderHook(() => usePlanCleanupOps());

    await expect(
      result.current.resume("run-1", [" f-1 ", "f-1"]),
    ).resolves.toMatchObject({
      ok: true,
      phase: "running",
      launched: true,
      preservedOutcomes: 3,
    });
    await expect(
      result.current.recheckFinding("run-1", "f-2"),
    ).resolves.toEqual({
      ok: true,
      resolved: false,
      phase: "review",
    });
    await expect(
      result.current.dismissFinding("run-1", "f-3", "Owner declined it"),
    ).resolves.toEqual({ ok: true, phase: "complete" });

    expect(
      H.fetch.mock.calls
        .slice(-3)
        .map((call) => JSON.parse(call[1].body as string)),
    ).toEqual([
      { op: "resume", runId: "run-1", findingIds: ["f-1"] },
      { op: "recheck-finding", runId: "run-1", findingId: "f-2" },
      {
        op: "dismiss-finding",
        runId: "run-1",
        findingId: "f-3",
        note: "Owner declined it",
      },
    ]);
  });
});

describe("PlansCleanupStrip", () => {
  it("starts from the exact shown-plan snapshot and returns the durable run id", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, runId: "run-new", launched: true }),
    });
    const p = props({ planSlugs: [" p-two ", "p-one", "p-two"] });
    render(<PlansCleanupStrip {...p} />);

    fireEvent.click(screen.getByTestId("plans-cleanup-start"));
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = H.fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/plan-cleanup");
    expect(JSON.parse(init.body as string)).toEqual({
      op: "start",
      planSlugs: ["p-two", "p-one"],
      filter: { query: null, shownCount: 2 },
      launch: H.resolverProfile,
    });
    expect(p.onRunStarted).toHaveBeenCalledWith("run-new");
  });

  it("shows a persisted launch failure instead of pretending the run is live", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-failed",
        launched: false,
        launchError: "no headless slot",
      }),
    });
    render(<PlansCleanupStrip {...props()} />);
    fireEvent.click(screen.getByTestId("plans-cleanup-start"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "resolver could not start: no headless slot",
    );
  });

  it("treats a deterministic no-resolver finish as success", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-deterministic",
        phase: "complete",
        launched: false,
        resolverNeeded: false,
        deterministic: { applied: 2, skipped: 0, failed: 0 },
      }),
    });
    const p = props();
    render(<PlansCleanupStrip {...p} />);
    fireEvent.click(screen.getByTestId("plans-cleanup-start"));
    await waitFor(() =>
      expect(p.onRunStarted).toHaveBeenCalledWith("run-deterministic"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // WI-10004730: a persisted failed run pinned its raw settle reason and the
  // Dismiss button cleared only the local notice, so it did nothing.
  it("labels a persisted failed run as a failure and lets Dismiss hide it", async () => {
    const failed = run({
      runId: "run-failed",
      phase: "failed",
      error: "settle refused: this run recorded no outcomes",
    });
    const view = render(<PlansCleanupStrip {...props({ run: failed })} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Clean-up run failed: settle refused: this run recorded no outcomes",
    );
    fireEvent.click(screen.getByLabelText("Dismiss clean-up notice"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    // A DIFFERENT failed run is new information and must surface again.
    view.rerender(
      <PlansCleanupStrip
        {...props({
          run: run({ runId: "run-failed-2", phase: "failed", error: null }),
        })}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Clean-up run failed: no reason was recorded",
    );
  });

  it("renders finding progress and lets Stop revoke the current run", async () => {
    const findings = [
      finding({ findingId: "done", outcome: "auto_applied" }),
      finding({ findingId: "review", outcome: "recommended" }),
      finding({ findingId: "left", outcome: "pending" }),
    ];
    const launched = {
      model: "sol",
      effort: "xhigh" as const,
      backend: "codex" as const,
      account: "pool-a",
      carry: "cold" as const,
    };
    render(
      <PlansCleanupStrip
        {...props({
          run: run({ launchSnapshot: launched }),
          findings,
          isRunning: true,
        })}
      />,
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 tidied",
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 for review",
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 left",
    );
    expect(
      screen
        .getByTestId("plan-cleanup-settings-control")
        .getAttribute("data-effective"),
    ).toBe(JSON.stringify(launched));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "67",
    );

    fireEvent.click(screen.getByTestId("plans-cleanup-stop"));
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "stop",
      runId: "run-1",
    });
  });

  it("hands review to ?opcln and hides it without completing unresolved findings", async () => {
    const recommendation = finding({ outcome: "recommended" });
    const p = props({
      run: run({ phase: "review", finishedAt: "2026-08-24T12:00:40.000Z" }),
      findings: [recommendation],
      recommendations: [recommendation],
      isReview: true,
    });
    render(<PlansCleanupStrip {...p} />);
    expect(
      screen.getByTestId("plans-cleanup-review-headline").textContent,
    ).toContain("1 assessed · 0 auto-applied · 1 still open");

    fireEvent.click(screen.getByTestId("plans-cleanup-open-review"));
    expect(p.onReview).toHaveBeenCalledWith("run-1");

    fireEvent.click(screen.getByTestId("plans-cleanup-hide"));
    expect(p.onRunCleared).toHaveBeenCalledTimes(1);
    expect(H.fetch).not.toHaveBeenCalled();
  });

  it("continues every untouched finding from a prior run without replacing its prepared outcomes", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        phase: "running",
        launched: true,
        preservedOutcomes: 7,
      }),
    });
    const recommendations = Array.from({ length: 3 }, (_, position) =>
      finding({
        findingId: `review-${position}`,
        position,
        outcome: "recommended",
      }),
    );
    const applied = Array.from({ length: 4 }, (_, index) =>
      finding({
        findingId: `applied-${index}`,
        position: recommendations.length + index,
        outcome: "auto_applied",
      }),
    );
    const pending = Array.from({ length: 5 }, (_, index) =>
      finding({
        findingId: `remaining-${index}`,
        position: recommendations.length + applied.length + index,
        outcome: "pending",
      }),
    );
    render(
      <PlansCleanupStrip
        {...props({
          run: run({
            runId: "cleanup-partial-12",
            phase: "review",
            totalItems: 12,
            autoResolved: 4,
            recommended: 3,
            finishedAt: "2026-08-24T12:05:00.000Z",
          }),
          findings: [...recommendations, ...applied, ...pending],
          recommendations,
          pending,
          isReview: true,
        })}
      />,
    );

    expect(
      screen.getByTestId("plans-cleanup-review-headline").textContent,
    ).toContain("12 assessed · 4 auto-applied · 8 still open");
    const continueButton = screen.getByTestId("plans-cleanup-continue");
    expect(continueButton.textContent).toContain("Continue 5 retryable");
    fireEvent.click(continueButton);

    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "resume",
      runId: "cleanup-partial-12",
      findingIds: pending.map((row) => row.findingId),
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Continuing 5 remaining · 7 prior outcomes preserved",
    );
  });
});
