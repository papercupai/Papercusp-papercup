// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";
import type { WorkItemAdmissionSnapshot } from "@papercusp/operator-core/lib/work-items-admission-promoter";
import { WORK_ITEM_PRESENTATION_LABELS } from "@papercusp/operator-core/lib/work-item-presentation-contract";

let syncResult: {
  data: WorkItemAdmissionSnapshot[] | undefined;
  loading: boolean;
  error: Error | null;
};
let lastSyncOptions: {
  queryName: string;
  args?: Record<string, unknown>;
  staleTime?: number;
} | null;

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (options: {
    queryName: string;
    args?: Record<string, unknown>;
    staleTime?: number;
  }) => {
    lastSyncOptions = options;
    return { ...syncResult, fetching: false, invalidate: vi.fn() };
  },
}));

// Radix Select's portal/geometry is orthogonal here. Preserve the accessible
// label and selected value while keeping this render-tier test deterministic.
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <button type="button" aria-label={ariaLabel}>
      {value}
    </button>
  ),
}));

import AdmissionRunsClient from "./AdmissionRunsClient";

function payload(
  overrides: Partial<WorkItemAdmissionSnapshot> = {},
): WorkItemAdmissionSnapshot {
  return {
    runs: [
      {
        id: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        state: "complete",
        stateSource: "writer",
        startedAt: "2026-08-26T15:00:00.000Z",
        finishedAt: "2026-08-26T15:00:01.000Z",
        batchSize: 4,
        promoted: 2,
        merged: 1,
        held: 1,
        autoPromotedUnreviewed: 0,
        censusBefore: 7,
        censusAfter: 8,
        censusDelta: 1,
        modelId: "model-a",
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.0125,
        latencyMs: 1_000,
        outcome: {
          unit: "items",
          attempted: 4,
          successful: 3,
          rolledBack: 0,
          unchanged: 1,
          uniqueRowsChanged: 3,
          failureReason: null,
          blockedReason: null,
        },
        outcomeSource: "writer",
        detail: { status: "complete" },
      },
    ],
    censusTrend: [
      {
        runId: "run-0",
        harnessSlug: "papercusp",
        runKind: "census",
        startedAt: "2026-08-26T14:00:00.000Z",
        before: 10,
        after: 7,
        delta: -3,
      },
      {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
    ],
    summary: {
      pending: 9,
      unreviewed: 3,
      promotedToFirstClaim: { sampleSize: 5, p50Ms: 1_200, p95Ms: 9_400 },
      latestCensus: {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
      latestCensusRise: {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
      runCounts: {
        total: 1,
        running: 0,
        complete: 1,
        failed: 0,
        blocked: 0,
        attempted: 4,
        successful: 3,
        rolledBack: 0,
        unchanged: 1,
        uniqueRowsChanged: 3,
        byUnit: {
          items: {
            attempted: 4,
            successful: 3,
            rolledBack: 0,
            unchanged: 1,
            uniqueRowsChanged: 3,
            runs: 1,
          },
        },
      },
      readiness: {
        schemaVersion: "work-item-readiness-projection-v1",
        measuredAt: "2026-08-26T15:00:00.000Z",
        presentation: {
          population: 10, unit: 'work-item rows', writer: 'readWorkItemReadinessProjection', classifier: 'deriveWorkItemPresentationStage', mutuallyExclusive: true,
          counts: { observation: 0, candidate: 2, unknown: 1, 'accepted-ready': 1, 'accepted-active': 1, 'accepted-blocked': 2, 'verified-completion': 1, 'terminal-other': 2 },
          remainingBugs: 4, verifiedCompletions: 1,
        },
        scope: {
          workspaceId: "papercusp-workspace",
          harnessSlug: "papercusp",
          itemKinds: ["bug", "change", "task"],
          population:
            "root issue-family rows excluding observation-lane records",
        },
        headline: {
          population: 10,
          nonTerminal: 8,
          terminal: 2,
          active: 1,
          awaitingRevision: 2,
          awaitingReview: 1,
          held: 2,
          ready: 1,
          unknown: 1,
        },
        reasons: {
          admissionPending: 2,
          admissionUnreviewed: 1,
          pendingAgentReview: 1,
          revisionRequestedAgentReview: 3,
          revisionReproductionValidation: 1,
          revisionContentAdoptionCandidates: 1,
          legacyRevisionException: 1,
          readinessAbsentLegacy: 4,
          readinessReady: 3,
          readinessUnknown: 1,
          readinessNotReady: 2,
          readinessMalformed: 1,
          activeClaim: 1,
          blockedStatus: 1,
          claimHold: 2,
          needsOwnerAction: 1,
          activeExternalBlocker: 1,
          activeDependency: 2,
          remoteOrigin: 1,
          terminalWithoutCommittedEvidence: 1,
        },
        aging: {
          neverClaimed: { count: 5, oldestAgeMs: 3 * 24 * 60 * 60_000 },
          awaitingReview: { count: 1, oldestAgeMs: 2 * 60 * 60_000 },
          awaitingRevision: { count: 2, oldestAgeMs: 4 * 60 * 60_000 },
        },
        flow: {
          windowDays: 30,
          since: "2026-07-27T15:00:00.000Z",
          arrivals: 8,
          currentApprovalsUpdatedInWindow: 3,
          currentRevisionRequestsUpdatedInWindow: 2,
          terminalInWindow: 2,
          verifiedCompletionsInWindow: 1,
          retainedReopenEventsInWindow: 2,
          reopenedItemsInWindow: 1,
          recurrence: {
            canonicalClusters: 2,
            rawOccurrences: 5,
            duplicateOccurrences: 3,
            units: {
              canonicalClusters:
                "distinct canonical work-item ids with occurrences",
              rawOccurrences: "append-only report rows",
              duplicateOccurrences: "report rows not creating a canonical item",
            },
            writer: "harness_shared.work_item_occurrences",
          },
          readyExpectedCost: {
            coveredRows: 1,
            totalRows: 1,
            pricedSubtotalCents: 250,
            cents: 250,
          },
        },
        availability: {
          corpus: "nonempty",
          writerReady: "ready",
          claimSpec: "not-evaluated",
          fleetControl: "not-evaluated",
          note: "Corpus stock, writer readiness, claim-spec matching, and fleet pause are separate axes. This workspace/harness projection never calls a paused or spec-empty lane drained.",
        },
        contract: {
          precedence: [
            "terminal",
            "active",
            "awaitingRevision",
            "awaitingReview",
            "held",
            "ready",
            "unknown",
          ],
          headline: "non-overlapping",
          reasons: "overlapping",
          readinessWriter:
            "payload.implementationReadiness + payload.agentReview + work-item lifecycle columns",
          recurrenceWriter: "harness_shared.work_item_occurrences",
          reopenWriter:
            "payload.reopenHistory (newest five retained by the writer)",
          truncation:
            "none for stock/flow SQL; reopen history is writer-bounded to five entries per item",
        },
      },
      usage: {
        scope: "shown runs after kind/state filters and limit",
        cap: 100,
        modelRuns: 1,
        inputTokens: 100,
        outputTokens: 20,
        pricedRuns: 1,
        unpricedRuns: 0,
        costUsd: 0.0125,
        pricedSubtotalUsd: 0.0125,
      },
    },
    ...overrides,
  };
}

function renderClient(searchParams = ""): ReturnType<typeof render> {
  const ui: ReactElement = <AdmissionRunsClient />;
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  syncResult = { data: undefined, loading: false, error: null };
  lastSyncOptions = null;
});
afterEach(cleanup);

describe("AdmissionRunsClient", () => {
  it("renders a dedicated loading state", () => {
    syncResult = { data: undefined, loading: true, error: null };
    renderClient();
    expect(screen.getByText("Loading admission runs…")).toBeTruthy();
  });

  it("renders a dedicated error state", () => {
    syncResult = {
      data: undefined,
      loading: false,
      error: new Error("ledger offline"),
    };
    renderClient();
    expect(screen.getByRole("alert").textContent).toContain("ledger offline");
  });

  it("renders queue stats, latency, census trend, rise alarm, and the run table", () => {
    syncResult = { data: [payload()], loading: false, error: null };
    renderClient();

    expect(screen.getByText("Pending admission")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText("1.2s")).toBeTruthy();
    expect(screen.getByText("9.4s")).toBeTruthy();
    expect(screen.getByTestId("census-rise-alarm").textContent).toContain(
      "rose by 1",
    );
    expect(
      screen.getByRole("img", { name: /Unadjudicated census trend/ }),
    ).toBeTruthy();
    expect(screen.getByText("promoter-tick")).toBeTruthy();
    expect(screen.getByText("model-a · 120 · $0.0125")).toBeTruthy();
    expect(screen.getByText("Run states (shown)")).toBeTruthy();
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText(/3 unique row change/)).toBeTruthy();
    expect(screen.getByText("Model cost (shown runs)")).toBeTruthy();
  });

  it("renders the readiness partition, overlapping reasons, stock/flow evidence, and independent availability axes", () => {
    syncResult = { data: [payload()], loading: false, error: null };
    renderClient();

    const readiness = screen.getByRole("region", { name: "Queue readiness" });
    expect(readiness.textContent).toContain(
      "Partition precedence: terminal → active → revision → review → held → claimable → unknown",
    );
    expect(readiness.textContent).toContain("Claimable by writer policy1");
    const stages = screen.getByRole('region', { name: 'Accepted work and intake' });
    // Labels come from the shared presentation contract the component renders, so a label
    // rename there cannot leave this assertion hard-coding a string nothing renders any more.
    expect(stages.textContent).toContain(`${WORK_ITEM_PRESENTATION_LABELS.candidate}2`);
    expect(stages.textContent).toContain(`${WORK_ITEM_PRESENTATION_LABELS['accepted-ready']}1`);
    expect(stages.textContent).toContain(`${WORK_ITEM_PRESENTATION_LABELS['accepted-active']}1`);
    expect(stages.textContent).toContain(`${WORK_ITEM_PRESENTATION_LABELS['accepted-blocked']}2`);
    expect(stages.textContent).toContain(`${WORK_ITEM_PRESENTATION_LABELS['verified-completion']}1`);
    expect(stages.textContent).toContain('10 root issue-family work-item rows');
    expect(stages.textContent).toContain('Writer: readWorkItemReadinessProjection');
    expect(screen.getByRole('link', { name: 'bulk review report' }).getAttribute('href')).toBe('/inbox');
    expect(readiness.textContent).toContain("Never claimed5oldest 3.0d");
    expect(readiness.textContent).toContain("Verified completions · 30d1");
    expect(readiness.textContent).toContain("Duplicate occurrences · 30d3");
    expect(readiness.textContent).toContain("Claimable expected cost$2.50");
    expect(readiness.textContent).toContain("Reason facets overlap by design");
    expect(readiness.textContent).toContain("Revision requested: 3");
    expect(readiness.textContent).toContain("Legacy revision exception: 1");
    expect(readiness.textContent).toContain("CorpusNonempty");
    expect(readiness.textContent).toContain("Claim specNot evaluated");
    expect(readiness.textContent).toContain(
      "Fleet control / pauseNot evaluated",
    );
    expect(readiness.textContent).toContain(
      "never calls a paused or spec-empty lane drained",
    );
  });

  it("passes URL-backed kind and run-state filters to the single sync query", () => {
    syncResult = { data: [payload()], loading: false, error: null };
    renderClient("?kind=promoter-tick&state=failed");
    expect(lastSyncOptions).toEqual({
      queryName: "workItemAdmission.runs",
      args: { kind: "promoter-tick", state: "failed", limit: 100 },
      staleTime: 30_000,
    });
  });

  it("renders the clean empty state without fabricating an alarm", () => {
    const empty = payload({
      runs: [],
      censusTrend: [],
      summary: {
        pending: 0,
        unreviewed: 0,
        promotedToFirstClaim: { sampleSize: 0, p50Ms: null, p95Ms: null },
        latestCensus: null,
        latestCensusRise: null,
        runCounts: {
          total: 0,
          running: 0,
          complete: 0,
          failed: 0,
          blocked: 0,
          attempted: 0,
          successful: 0,
          rolledBack: 0,
          unchanged: 0,
          uniqueRowsChanged: 0,
          byUnit: {},
        },
      },
    });
    syncResult = { data: [empty], loading: false, error: null };
    renderClient();
    expect(
      screen.getByText("No admission runs match these filters."),
    ).toBeTruthy();
    expect(screen.queryByTestId("census-rise-alarm")).toBeNull();
    expect(screen.getByText("Not enough census samples yet.")).toBeTruthy();
  });
});
