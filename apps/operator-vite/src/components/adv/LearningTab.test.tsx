// @vitest-environment jsdom
//
// LearningTab render coverage — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
// Mounts the tab against realistic `learning.improvements` / `learning.gym` /
// `learning.apiary` / `learning.scout` snapshots (useSyncQuery +
// nuqs mocked, the pinned sibling pattern — see AdvConversationsTab.test.tsx).
// useSyncQuery dispatches on queryName so each sub-view gets its own shape. Asserts the
// Improvements scoreboard + lanes (default view), the lifecycle navigation, the Gym
// and Benchmark views, and the Scout rails/tick view. Empty states are pinned per view.
// Scout grading (B-07, scout-idea-grading-2026-06-12): star control, attribution
// chip, optimistic write through the `blender:grade-idea` tool proxy (+ rollback),
// the `?grade=` note popover, and the lens-weight strip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// P-009: this vitest env exposes Node's built-in localStorage (method-less
// without --localstorage-file — see libs/test-config/src/index.ts's note), not
// jsdom's. Install a real in-memory Storage so the orientation-banner
// persistence path is actually exercised.
const memStorage: Storage = (() => {
  let bag: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in bag ? bag[k] : null),
    setItem: (k: string, v: string) => {
      bag[k] = String(v);
    },
    removeItem: (k: string) => {
      delete bag[k];
    },
    clear: () => {
      bag = {};
    },
    key: () => null,
    get length() {
      return Object.keys(bag).length;
    },
  } as Storage;
})();
Object.defineProperty(window, "localStorage", {
  value: memStorage,
  configurable: true,
});

// P-005: grading in the merged Improve view renders through a Radix Popover,
// which measures its trigger via @radix-ui/react-use-size — that requires
// ResizeObserver, and jsdom ships none. Without this the grade panel THROWS on
// mount ("ReferenceError: ResizeObserver is not defined") instead of rendering,
// which is what kept the grading contracts (7-11) un-re-established after the
// P-003 merge retired the old inline-radio card. A no-op is correct here: these
// tests assert DOM and behaviour, never layout, so there is nothing to measure.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

const nuqsState: Record<string, unknown> = {
  lview: "improvements",
  lane: "all",
  tab: null,
  grade: null,
  irail: null,
  impf: null,
  impq: "",
  rtf: null,
  rrubric: null,
  lretain: null,
  lhive: "",
  slug: null,
};
// Capture the setter per key so tests can assert the hive picker writes ?lhive.
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = (nuqsSetters[key] ??= vi.fn((v: unknown) => {
      // Functional-updater form too (`setRsel((cur) => …)`) — the Retained
      // ledger's row click toggles selection through it (WI-39534).
      nuqsState[key] =
        typeof v === "function"
          ? (v as (cur: unknown) => unknown)(nuqsState[key] ?? null)
          : v;
    }));
    return [nuqsState[key], setter];
  },
  // P-009: useOpenArming + the orientation banner write the LeftSidebar rail
  // keys (`lsb`/`lst`) as ONE group — mirror useQueryState over the same
  // nuqsState bag so a click's write is observable via nuqsState.
  useQueryStates: (spec: Record<string, unknown>) => {
    const setter = (nuqsSetters.__rail ??= vi.fn(
      (patch: Record<string, unknown>) => {
        Object.assign(nuqsState, patch);
      },
    ));
    const value: Record<string, unknown> = {};
    for (const key of Object.keys(spec)) value[key] = nuqsState[key] ?? null;
    return [value, setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  // `parseAsColumnFilters` builds a custom parser during render; the component
  // test's keyed state mock does not consume it, but nuqs still requires the
  // factory export to exist.
  createParser: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
  parseAsBoolean: { withDefault: () => ({}) },
}));

// @tanstack/react-virtual: the Retained ledger renders through a REAL
// VirtualGrid (@papercusp/grid-core). jsdom has no layout engine, so the real
// virtualizer sees a zero-height scroll container and yields no virtual items —
// the ledger would render nothing and row text could never be found. Mock
// useVirtualizer to yield one VirtualItem per row so the full window mounts
// under test (mirrors grid-core's own RichGrid.virtual.test.tsx and
// AdvConversationsTab.test.tsx).
// WI-523949: `scrollToIndex` is the ONLY way a virtualized list can bring a row
// the reader cannot currently see into view — an unmounted row has no element to
// run `scrollIntoView` on. So it is the observable a deep-link contract has to be
// asserted against; hoisted out of the factory so a test can read what the
// component actually asked the virtualizer for.
const virtualizerSpies = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock("@tanstack/react-virtual", () => {
  const stubVirtualizer = ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey?: (index: number) => string | number;
  }) => {
    const ROW = 30;
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      key: getItemKey?.(index) ?? `vrow-${index}`,
      start: index * ROW,
      end: index * ROW + ROW,
      size: ROW,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * ROW,
      measureElement: () => {},
      measure: () => {},
      scrollToIndex: virtualizerSpies.scrollToIndex,
    };
  };
  // The factory REPLACES the whole module, so every export a mounted view
  // touches must exist: VirtualGrid uses useVirtualizer, the Improvements
  // list uses useWindowVirtualizer.
  return {
    useVirtualizer: stubVirtualizer,
    useWindowVirtualizer: stubVirtualizer,
  };
});

// The pot lens is INHERITED from the top-bar selector via useAdvScope (owner
// directive 2026-07-26 — the tab's own ?lhive= picker is gone). Tests drive the
// lens by mutating this bag; beforeEach resets it to the alpha-hive default the
// old first-list-entry fallback used, so scoping expectations read the same.
const advScopeState = {
  allMode: false,
  slug: "alpha-hive" as string | null,
  hive: "alpha-hive",
  ready: true,
};
vi.mock("./AdvShell", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./AdvShell")>();
  return { ...orig, useAdvScope: () => ({ ...advScopeState }) };
});

vi.mock("@/app/_components/RubricsPanel", () => ({
  default: ({ onSelect }: { onSelect?: (id: string) => void }) => (
    <button data-testid="rubrics-panel" onClick={() => onSelect?.("rubric-1")}>
      rubrics-panel
    </button>
  ),
}));
vi.mock("@/app/_components/RubricDetailPanel", () => ({
  default: ({
    rubricId,
    onBack,
  }: {
    rubricId: string;
    onBack?: () => void;
  }) => (
    <div data-testid="rubric-detail">
      detail:{rubricId}
      <button onClick={onBack}>back</button>
    </div>
  ),
}));
vi.mock("@/app/adv/create/ObservationsPanel", () => ({
  default: () => <div data-testid="observations-panel" />,
}));

// LearningTab's dropdowns now use the themed <Select> (Radix). Mock it as a native
// <select> with the same contract (mirrors AdvShell.test) so the hive-lens
// assertions (getByLabelText / option roles / value / disabled) still hold; the
// placeholder is rendered as the value="" option so the "no hives yet" case asserts.
// The shared column-filter layer (Work-Queue parity, owner ask 2026-07-19) is
// covered by the filters lib's own suite; stub it to a pass-through so these
// tests exercise the view's OWN quick-search / lane / source logic.
// The filter CONTROLS are stubbed (they need a real DOM controller), but
// `filterCountLabel` is supplied REAL via importActual: it is a pure function
// that produces the count copy several assertions below read, so stubbing it
// would make those assertions test the stub instead of the shipped label.
vi.mock("@/app/harness/filters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/harness/filters")>();
  return {
    ...actual,
    useColumnFilters: <T,>(_cols: unknown, rows: readonly T[]) => ({
      rows,
      controller: null,
      activeChips: [],
      hasActive: false,
      clearAll: () => {},
    }),
    ColumnFilterBar: () => null,
  };
});

vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const improvementsDigest = {
  generatedAt: new Date(0).toISOString(),
  census: { total: 135 },
  window: {
    examined: 135,
    windowed: false,
    open: 117,
    byKind: { bug: 107, change: 28 },
    bySeverity: { major: 87, minor: 40, critical: 5, nit: 3 },
    byState: { open: 117, resolved: 15, closed: 3 },
  },
  autoEligible: [
    {
      id: "EI-75",
      kind: "bug",
      title: "cup:spawn children are coordination-MUTE",
      scope: "operator",
      severity: "critical",
      state: "open",
      assignee: null,
      assignedAt: null,
      attempts: 0,
      tier: "auto",
      score: 46,
      ageDays: 2.6,
      tierReason: "no protected path → AUTO",
      ideaType: "process",
    },
  ],
  humanQueue: [
    {
      id: "EI-85",
      kind: "bug",
      title: "Peer restarts massacre in-flight spawns",
      scope: "operator",
      severity: "critical",
      state: "open",
      assignee: null,
      assignedAt: null,
      attempts: 0,
      tier: "human",
      score: 42,
      ageDays: 2.5,
      tierReason: "protected keyword deploy → human",
      ideaType: "process",
    },
  ],
  likelyDuplicates: [],
  recurringSignatures: [],
  headline: "papercusp-improvement digest: 135 captured (117 open)",
  // P-041 flow scoreboard — flows, not stocks. lastTickAt is relative to now
  // because the strip's watchdog-health tone is computed against Date.now().
  flow: {
    captured7d: 12,
    resolved7d: 8,
    net7d: 4,
    medianOpenAgeDays: 14.2,
    recurringSignatureCount: 3,
    watchdog: {
      lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      ticks24h: 96,
      captured24h: 5,
    },
  },
};

const gymSnapshot = {
  proposals: [
    {
      id: "v1__worker",
      harnessSlug: "papercup-gym",
      cycle: 3,
      role: "worker",
      rationale: "tighten the worker acceptance check",
      devAnchorDelta: 0.042,
      costDelta: -0.01,
      status: "accepted",
      createdAt: 1,
      decidedAt: 2,
    },
    {
      id: "v2__architect",
      harnessSlug: "papercup-gym",
      cycle: 3,
      role: "architect",
      rationale: "more explicit chunk sizing",
      devAnchorDelta: -0.018,
      costDelta: 0.02,
      status: "rejected",
      createdAt: 1,
      decidedAt: 2,
    },
  ],
  autoloops: [
    {
      harnessSlug: "papercup-gym",
      enabled: true,
      status: "running",
      budgetUsd: 20,
      spentUsd: 4.5,
      lastCycle: 3,
    },
  ],
};

// Composites use the LIVE judge scale (0..10 — real gen-0 rows sit at 4.06..5.95),
// not 0..1: the BenchmarkTrend projection must stay scale-free (B-12).
const apiarySnapshot = {
  instances: [
    {
      instanceId: "gen0-bbb2222-ws",
      codeSha: "bbb2222",
      createdAt: new Date(2_000_000).toISOString(),
      totalRuns: 20,
      successfulRuns: 16,
      successRate: 0.8,
      meanComposite: 5.95,
      meanTimeToGreenSecs: 95,
      meanTokens: 12000,
      escalationRate: 0.1,
      firstAttemptRate: 0.6,
    },
    {
      instanceId: "gen0-aaa1111-ws",
      codeSha: "aaa1111",
      createdAt: new Date(1_000_000).toISOString(),
      totalRuns: 20,
      successfulRuns: 14,
      successRate: 0.7,
      meanComposite: 4.06,
      meanTimeToGreenSecs: 110,
      meanTokens: 13500,
      escalationRate: 0.15,
      firstAttemptRate: 0.5,
    },
  ],
};

const knowledgeSnapshot = {
  insights: {
    count: 38,
    recent: [
      {
        slug: "adding-a-sync-query",
        title: "Adding a sync query",
        description: "The per-entry resolver recipe.",
        status: "active",
        tags: ["sync"],
        modifiedAt: new Date(3_000_000).toISOString(),
      },
      {
        slug: "postgres-js-jsonb-binding",
        title: "postgres.js jsonb binding",
        description: "sql.json throws under getOrgPg.",
        status: "active",
        tags: ["pg"],
        modifiedAt: new Date(2_000_000).toISOString(),
      },
    ],
  },
  memory: {
    totalMemories: 168,
    entityRows: 1829,
    feedback30d: 3,
    recalls7d: 40,
    zeroHit7d: 10,
    zeroHitRate7d: 0.25,
    topScoreP50: 0.52,
    topScoreP90: 0.74,
    fragmentHits7d: 0,
  },
};

const scoutSnapshot = {
  totalRouted: 4,
  railCounts: [
    { rail: "plan", count: 3 },
    { rail: "gym", count: 1 },
  ],
  recent: [
    {
      ideaId: "idea-1",
      lens: "reframing",
      rail: "plan",
      routedRef: "plan:scout-cache-warmup",
      title: "Cache-warmup plan draft",
      routedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      outcome: "pending",
      humanGrade: null,
      humanFeedback: null,
      gradedBy: null,
      // P-004 trace fields: grounded in one opaque wi: ref (title resolved via
      // groundingTitles below) + one readable typed ref.
      origin: "scout",
      cycleId: "scout-100",
      addressesPatternRefs: ["wi:EI-100", "fact:workspace:some-standing-fact"],
    },
    {
      ideaId: "idea-2",
      lens: "analogical",
      rail: "gym",
      routedRef: "gym:proposal-7",
      title: "Tighter scoper prompt",
      routedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      outcome: "won",
      // Auto-graded (C-1c) — the row shows the attribution chip; owner regrade stays open.
      humanGrade: 4,
      humanFeedback: "Sharp framing — ship it",
      gradedBy: "auto-grader",
      origin: "scout",
      cycleId: "scout-99",
      addressesPatternRefs: [],
    },
  ],
  lastTick: {
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    outcome: "gated",
    detail: "min-interval",
  },
  // P-002 tick-economics strip (newest first) + P-003 server-evaluated health.
  ticks: [
    {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      status: "gated",
      stop: "min-interval",
      generated: 0,
      routed: 0,
      deduped: 0,
      spendUsd: null,
      cycleId: null,
      lenses: {},
    },
    {
      at: new Date(Date.now() - 35 * 60_000).toISOString(),
      status: "ran",
      stop: "completed",
      generated: 8,
      routed: 3,
      deduped: 2,
      spendUsd: 1.62,
      cycleId: "scout-100",
      lenses: { reframing: 2, analogical: 1 },
    },
  ],
  health: { status: "good", markers: [] },
  // P-004: server-resolved titles for the opaque wi: grounding refs.
  groundingTitles: { "wi:EI-100": "coord invariant: wake-queue depth growth" },
};

let improvementsResult: Record<string, unknown> = {
  data: [improvementsDigest],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let gymResult: Record<string, unknown> = {
  data: [gymSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let apiaryResult: Record<string, unknown> = {
  data: [apiarySnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let knowledgeResult: Record<string, unknown> = {
  data: [knowledgeSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let scoutResult: Record<string, unknown> = {
  data: [scoutSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let hiveEvalResult: Record<string, unknown> = {
  data: [{ instances: [] }],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// P-042: the tab-level hive picker reuses learning.hiveList; the Learnings view
// reads learning.hive + knowledgePacks.list. Defaults: two hives so the picker
// renders real options.
let hiveListResult: Record<string, unknown> = {
  data: [
    { slug: "alpha-hive", remote: false },
    { slug: "beta-hive", remote: true },
  ],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// WI-39535: the unified Retained ledger feed — the shared-memory pool rides it
// as kind 'memory'. Tests override `retainFeedResult` to model rows / counts /
// degraded legs, and `retainDetailResult` for the selected row's detail aside
// (WI-39534). (The standalone learning.hive pool read this file used to mock is
// gone with the standalone section.)
let retainFeedResult: Record<string, unknown> = {
  data: [
    {
      rows: [],
      counts: null,
      nextCursor: null,
      degraded: [],
      generatedAt: "2026-08-16T00:00:00.000Z",
    },
  ],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let retainDetailResult: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// WI-39900: the tab badges are their own read (learning.retainCounts), split
// off the feed page — tests model badge sizes HERE, not on the page's counts.
let retainCountsResult: Record<string, unknown> = {
  data: [null],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let retainSummaryResult: Record<string, unknown> = {
  data: [{ total: 0, matched: 0, facets: [] }],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let improvementsSummaryResult: Record<string, unknown> = {
  data: [{ total: 4, matched: 1, facets: [] }],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// WI-6383: when set, `learning.hiveThroughput` returns THIS — lets a test model
// the DEGRADED snapshot the resolver returns for an unreadable substrate (a
// successful read carrying `unavailable`, never a thrown transport error).
let throughputResult: Record<string, unknown> | null = null;
// Per-query args the tab passed — asserted by the P-042 hive-lens tests.
const seenArgs: Record<string, unknown> = {};
// When set, a hive-less (`{}`) learning.gym read returns THIS instead of
// gymResult — lets a test model the client's scoped→workspace-wide fallback.
let gymWideResult: Record<string, unknown> | null = null;
vi.mock("@papercusp/sync", async () => ({
  ORIGIN_SCHEDULER_CLASSES: ["interactive-control", "foreground-read", "background-sync", "bulk"],
  // WI-6948: this suite mocks ./AdvShell with importOriginal, so it loads the REAL
  // shell -> TasksRunningPill -> lazyWithRetry, which this package re-exports. Without
  // it the re-export is undefined and vitest surfaces the throw as the generic
  // "error when mocking a module", which reads like an unrelated hoisting bug.
  lazyWithRetry: (await import("react")).lazy,
  // P-013: the tab renders LearningPotDrawer, whose scout-cycle budget fields
  // write the pot config through useSyncMutate. This factory ENUMERATES the
  // module, so an export the tree reaches but this list omits fails every test
  // in the file at import time — not on the assertion that needed it.
  useSyncMutate: () => async () => ({ ok: true }),
  useSyncQuery: (opts: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    // Only record ACTUALLY-firing queries — a hook gated `enabled: false` (e.g.
    // the gym view's workspace-wide fallback when the scoped read has data) does
    // not fetch, so it must not clobber the recorded args of the real read.
    if (opts.enabled !== false) seenArgs[opts.queryName] = opts.args;
    if (opts.queryName === "learning.gym") {
      const hasHive = Boolean(
        (opts.args as { hive?: string } | undefined)?.hive,
      );
      return !hasHive && gymWideResult ? gymWideResult : gymResult;
    }
    if (opts.queryName === "learning.hiveThroughput" && throughputResult) {
      return throughputResult;
    }
    if (opts.queryName === "learning.retainFeed") return retainFeedResult;
    if (opts.queryName === "learning.retainCounts") return retainCountsResult;
    if (opts.queryName === "learning.retainFeed.summary")
      return retainSummaryResult;
    if (opts.queryName === "learning.retainDetail") return retainDetailResult;
    if (opts.queryName === "learning.retainPlanChildren") {
      return {
        data: [],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }
    if (opts.queryName === "learning.scoutDrafts") {
      // The Improvements view's thin drafts read — empty by default.
      // WI-6395: enveloped, so the empty is `[{ items: [] }]` (an observed
      // empty) rather than `[]`, which now means something different.
      return {
        data: [{ items: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }
    if (opts.queryName === "learning.improvements.summary") {
      return improvementsSummaryResult;
    }
    return opts.queryName === "learning.apiary"
      ? apiaryResult
      : opts.queryName === "learning.hiveEvalTrend"
        ? hiveEvalResult
        : opts.queryName === "learning.knowledge"
          ? knowledgeResult
          : opts.queryName === "learning.scout"
            ? scoutResult
            : opts.queryName === "learning.hiveList"
              ? hiveListResult
              : opts.queryName === "learning.retain"
                ? {
                    data: [
                      {
                        banked: { improvementsFiled7d: 5, plansDrafted7d: 2 },
                        lensWeights: null,
                        rubricChanges: [],
                        insightDocs: [],
                        recipes: [],
                        generatedAt: "2026-07-19T00:00:00.000Z",
                      },
                    ],
                    loading: false,
                    fetching: false,
                    error: null,
                    invalidate: vi.fn(),
                  }
                : opts.queryName === "knowledgePacks.list" ||
                    opts.queryName === "knowledgePacks.candidates"
                  ? {
                      data: [],
                      loading: false,
                      fetching: false,
                      error: null,
                      invalidate: vi.fn(),
                    }
                  : improvementsResult;
  },
}));

// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot', t('brain') → 'brain',
// t('contributor') → 'contributor') — isolates the routed copy from the THE_HIVE
// flag hook so assertions pin the ROUTED KEY, not a pack word (restore-pot-lexicon P-006).
vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

import { setFlagPayload } from "@papercusp/flags/client";
import { FLAGS, FLAG_DEFAULTS } from "@papercusp/flags";

/** Arm/disarm FLAGS.TESTING — the Gym view's gate (WI-6315). Flags live in a
 *  MODULE-level store, so any suite that arms it must disarm it or the flag
 *  leaks into every later test in the file; the top-level beforeEach disarms.
 *
 *  (MUG_KETTLE_SYSTEM used to be pinned ON here so that seeding from
 *  FLAG_DEFAULTS would not silently hide the `wake-efficiency` view under every
 *  test in the file. That view is DELETED as of P-059 / D-076, so the flag no
 *  longer changes anything this file renders and the pin is gone with it.) */
const setTestingFlag = (on: boolean) =>
  setFlagPayload({
    flags: { ...FLAG_DEFAULTS, [FLAGS.TESTING]: on },
    evaluatedAt: Date.now(),
    source: "override",
  });
import LearningTab, {
  ARMING_WORKFLOWS_KIND,
  ARMING_WORKFLOWS_TAB,
  graderChipLabel,
  railChipPromise,
} from "./LearningTab";

beforeEach(() => {
  // Flags are a MODULE-level store, so an armed flag would leak into every later
  // test in the file. Reset to defaults first (outer beforeEach runs before the
  // nested ones), letting a suite that needs FLAGS.TESTING arm it explicitly.
  setTestingFlag(false);
  nuqsState.lview = "improvements";
  nuqsState.lane = "all";
  nuqsState.tab = null;
  nuqsState.wfView = null;
  nuqsState.wfFilter = null;
  nuqsState.wfKind = null;
  nuqsState.grade = null;
  nuqsState.irail = null;
  nuqsState.lsrc = null;
  nuqsState.impf = null;
  nuqsState.impq = "";
  nuqsState.rtf = null;
  nuqsState.itrace = null;
  nuqsState.rrubric = null;
  nuqsState.lretain = null;
  nuqsState.slug = null;
  advScopeState.allMode = false;
  advScopeState.slug = "alpha-hive";
  advScopeState.hive = "alpha-hive";
  advScopeState.ready = true;
  // P-009 rail keys (useOpenArming / the orientation banner write these).
  nuqsState.lsb = null;
  nuqsState.lst = null;
  // P-009: `useOpenArming` now opens the every-pot scope picker, whose open
  // state is the nuqs key `lpick`. This bag is MODULE-level, so without a reset
  // the first test that clicks "Open Arming" leaves the picker open for the
  // whole rest of the file — and it is a Radix MODAL, so every later
  // getByRole/getByText searches a page Radix has made inert and fails with
  // "unable to find an accessible element", naming a control that is present
  // and simply behind the dialog. That reads as six unrelated regressions.
  nuqsState.lpick = null;
  nuqsState.lpickq = null;
  // P-012: the per-pot drawer is a second Radix MODAL on this tab, keyed by pot
  // SLUG rather than a boolean — so a leaked `lpot` is worse than a leaked
  // `lpick`: any non-empty string opens it. Same failure mode as above (later
  // tests report "unable to find an accessible element" for controls that are
  // present, just behind an aria-modal), so it gets the same reset.
  nuqsState.lpot = null;
  window.localStorage.removeItem("pc-learning-orientation-dismissed");
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  for (const k of Object.keys(seenArgs)) delete seenArgs[k];
  improvementsResult = {
    data: [improvementsDigest],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  improvementsSummaryResult = {
    data: [{ total: 4, matched: 1, facets: [] }],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  gymResult = {
    data: [gymSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  gymWideResult = null;
  apiaryResult = {
    data: [apiarySnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  knowledgeResult = {
    data: [knowledgeSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  scoutResult = {
    data: [scoutSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  hiveEvalResult = {
    data: [{ instances: [] }],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  hiveListResult = {
    data: [
      { slug: "alpha-hive", remote: false },
      { slug: "beta-hive", remote: true },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  retainFeedResult = {
    data: [
      {
        rows: [],
        counts: null,
        nextCursor: null,
        degraded: [],
        generatedAt: "2026-08-16T00:00:00.000Z",
      },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  retainDetailResult = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  retainCountsResult = {
    data: [null],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  retainSummaryResult = {
    data: [{ total: 0, matched: 0, facets: [] }],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  // Retained-ledger URL state (WI-39493/WI-39534) — reset like every other key.
  nuqsState.rtab = "all";
  nuqsState.rq = "";
  nuqsState.rplan = null;
  nuqsState.rsel = null;
  throughputResult = null;
});
afterEach(() => cleanup());

describe("LearningTab — Improvements view (default)", () => {
  it("renders the scoreboard from the digest rollups", () => {
    render(<LearningTab />);
    // Improve now holds ONE view, so it renders no view-tab strip at all —
    // the same shape Analyze (Pipeline) and Retain (Learnings) already had.
    // Assert the merged pane itself rather than a tab that correctly no
    // longer exists.
    expect(screen.getByLabelText("Where these came from")).toBeTruthy();
    // Scoped to the stat line's <dd>: since P-003 the lane segments carry their
    // own <em> count badges (the Retain chrome), so a bare getByText("135")
    // legitimately matches two nodes.
    expect(screen.getByText("135", { selector: "dd" })).toBeTruthy(); // captured (stat line)
    // open now rides the quiet header signal ("117 open") rather than a standalone
    // hero number (owner ask 2026-07-19: header pill + metric tiles → one stat line).
    expect(screen.getByText(/117\s+open/)).toBeTruthy(); // open (header signal)
    expect(screen.getByText("15")).toBeTruthy(); // resolved (stat line)
  });

  it("renders the merged list through the shared VirtualGrid (WI-39536)", () => {
    render(<LearningTab />);

    // WI-39536: the dashboard-mode Improve list renders through the same grid
    // engine as the work queue / Retained ledger (VirtualGrid — the virtualizer
    // stub above mounts every row). Each merged row is a grid row carrying its
    // title cell; the old windowed-<li> contract (absolute positioning,
    // data-index) retired with the card list.
    const gridRows = Array.from(
      document.querySelectorAll<HTMLElement>('[role="row"]'),
    ).filter((el) => el.querySelector(".pc-learning__title"));
    expect(gridRows.length).toBeGreaterThan(0);
    // Both halves of the merged population render: a filed work item…
    expect(
      gridRows.some((el) =>
        el.textContent?.includes("cup:spawn children are coordination-MUTE"),
      ),
    ).toBe(true);
    // …and an idea-only row (routed to a non-`wi:` rail).
    expect(
      gridRows.some((el) =>
        el.textContent?.includes("Cache-warmup plan draft"),
      ),
    ).toBe(true);
  });

  it("keeps every routed idea that targets the same work item", () => {
    const olderIdea = {
      ...scoutSnapshot.recent[0],
      ideaId: "idea-shared-older",
      lens: "risk-first",
      rail: "improvement",
      routedRef: "wi:EI-75",
      title: "Older route to EI-75",
      routedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    };
    const newerIdea = {
      ...olderIdea,
      ideaId: "idea-shared-newer",
      lens: "value-first",
      title: "Newer route to EI-75",
      routedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    scoutResult = {
      ...scoutResult,
      data: [
        {
          ...scoutSnapshot,
          recent: [newerIdea, olderIdea, ...scoutSnapshot.recent],
        },
      ],
    };

    render(<LearningTab />);

    const sharedItemButtons = screen.getAllByRole("button", {
      name: /Show where “cup:spawn children are coordination-MUTE” came from/,
    });
    expect(sharedItemButtons).toHaveLength(2);

    nuqsState.itrace = "idea-shared-newer";
    cleanup();
    render(<LearningTab />);
    expect(
      screen.getByLabelText("Pipeline trace for Newer route to EI-75"),
    ).toBeTruthy();

    nuqsState.itrace = "idea-shared-older";
    cleanup();
    render(<LearningTab />);
    expect(
      screen.getByLabelText("Pipeline trace for Older route to EI-75"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Pipeline trace for Newer route to EI-75"),
    ).toBeNull();
  });

  it("lists both lanes in the all view", () => {
    render(<LearningTab />);
    expect(
      screen.getByText("cup:spawn children are coordination-MUTE"),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Peer restarts massacre in-flight spawns"),
    ).toHaveLength(1);
    expect(screen.getByText("EI-75")).toBeTruthy();
    expect(screen.queryByText("Decide next")).toBeNull();
  });

  it("keeps Auto-fixable rows through provenance, then makes an unmatched rail explicitly empty", () => {
    // A live auto-fixable row can have a source but no routed idea, so it has
    // provenance for the scope bar without an idea rail. Keep both facts in
    // the fixture: the lane must retain the row, while a rail filter must not
    // invent a match for it.
    improvementsResult = {
      ...improvementsResult,
      data: [
        {
          ...improvementsDigest,
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], source: "system" },
          ],
        },
      ],
    };

    const renderCurrent = () => {
      cleanup();
      render(<LearningTab />);
    };
    const autoTitle = "cup:spawn children are coordination-MUTE";
    const humanTitle = "Peer restarts massacre in-flight spawns";

    render(<LearningTab />);
    fireEvent.click(screen.getByRole("tab", { name: /^Auto-fixable/ }));
    expect(nuqsState.lane).toBe("auto");

    // The lane selection is sent to the server and the returned auto row is
    // projected into the merged grid; the human row and idea-only rows are not.
    renderCurrent();
    expect(seenArgs["learning.improvements"]).toEqual({
      hive: "alpha-hive",
      lanes: ["auto"],
    });
    expect(screen.getByText(autoTitle)).toBeTruthy();
    expect(screen.queryByText(humanTitle)).toBeNull();

    // Source/provenance is an independent predicate and must preserve the
    // matching auto row rather than blanking the lane during projection.
    // P-003 split the old single scope bar into sibling segments on one row:
    // "Where these came from" is now the SCOPE axis (From the loop / Every
    // capture) and provenance lives in its own "Filed by" segment. They are
    // different predicates, so they no longer share one aria-label.
    fireEvent.click(
      within(screen.getByLabelText("Filed by")).getByRole("button", {
        name: "system",
      }),
    );
    expect(nuqsState.lsrc).toBe("system");
    renderCurrent();
    expect(seenArgs["learning.improvements"]).toEqual({
      hive: "alpha-hive",
      lanes: ["auto"],
      sources: ["system"],
    });
    expect(screen.getByText(autoTitle)).toBeTruthy();

    // This auto row has no routed idea/rail. Selecting a real rail therefore
    // yields an honest zero, not a disappearing lane that looks like a broken
    // auto predicate; the request args and empty copy make that distinction
    // observable.
    const routing = screen.getByLabelText("Idea routing");
    const planRail = within(routing).getByRole("button", {
      name: /^plan draft/,
    });
    expect(planRail.textContent).toContain("0");
    fireEvent.click(planRail);
    expect(nuqsState.irail).toBe("plan");
    renderCurrent();
    expect(seenArgs["learning.improvements"]).toEqual({
      hive: "alpha-hive",
      lanes: ["auto"],
      sources: ["system"],
      rails: ["plan"],
    });
    expect(screen.queryByText(autoTitle)).toBeNull();
    expect(
      screen.getByText("Nothing matches the current filter / search"),
    ).toBeTruthy();
  });

  // ── WI-471938: the "Filed by" OPTION SET is a corpus claim, not a window one ──
  //
  // The chips used to derive their options from `autoEligible + humanQueue` — the
  // projected 500-row window — whenever no server predicate was active, which is exactly
  // the default landing view. A source whose rows all sat past the cap therefore rendered
  // NO chip and could not be selected, and the only way to reach it was to filter by
  // something else first. Measured on the live corpus 2026-08-28: `system` had 15 rows and
  // none of them in the window.

  it("offers a chip for a source that exists in the corpus but has NO row in the loaded window", () => {
    improvementsResult = {
      ...improvementsResult,
      data: [
        {
          ...improvementsDigest,
          // The window holds only Scout rows…
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], source: "Scout" },
          ],
          humanQueue: [],
          // …while the corpus aggregate knows about `system` too. Counts mirror the
          // live measurement that motivated the fix.
          sourceOptions: [
            { value: "Scout", count: 1007 },
            { value: "system", count: 15 },
          ],
        },
      ],
    };
    render(<LearningTab />);

    const filedBy = screen.getByLabelText("Filed by");
    // The window-derived option is still there…
    expect(within(filedBy).getByRole("button", { name: "Scout" })).toBeTruthy();
    // …and so is the one that exists only in the unloaded tail. Before the fix this
    // getByRole threw: the chip was never rendered.
    const system = within(filedBy).getByRole("button", { name: "system" });

    // And it is a working filter, not just a visible one: selecting it sends the
    // predicate to the server, which filters the CORPUS rather than the window.
    fireEvent.click(system);
    expect(nuqsState.lsrc).toBe("system");
    cleanup();
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toMatchObject({
      sources: ["system"],
    });
  });

  it("still derives the option set from the window when the corpus aggregate is ABSENT", () => {
    // The aggregate is best-effort on the server: a failed read degrades to `undefined`
    // rather than sinking the digest, and the old window-derived behaviour has to remain
    // as the fallback — wrong in the tail, but not a blank filter strip.
    improvementsResult = {
      ...improvementsResult,
      data: [
        {
          ...improvementsDigest,
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], source: "Scout" },
          ],
          humanQueue: [],
          // no sourceOptions key at all
        },
      ],
    };
    render(<LearningTab />);
    const filedBy = screen.getByLabelText("Filed by");
    expect(within(filedBy).getByRole("button", { name: "Scout" })).toBeTruthy();
    expect(
      within(filedBy).queryByRole("button", { name: "system" }),
    ).toBeNull();
  });

  it("treats an EMPTY corpus aggregate as 'no sources exist', not as 'we could not ask'", () => {
    // The distinction the wire field is shaped around: `[]` is an answer (nothing is
    // filed under any source), `undefined` is the absence of one. An empty answer must
    // NOT silently fall through to the window, or a corpus with no sources would show
    // chips derived from whatever rows happened to load.
    improvementsResult = {
      ...improvementsResult,
      data: [
        {
          ...improvementsDigest,
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], source: "Scout" },
          ],
          humanQueue: [],
          sourceOptions: [],
        },
      ],
    };
    render(<LearningTab />);
    expect(screen.queryByLabelText("Filed by")).toBeNull();
  });

  it.each([
    { unavailable: true, unavailableKind: "read-failed", unavailableReason: "Snapshot read failed" },
    { _meta: { derivedRead: { missing: true } } },
    { ...improvementsDigest, window: undefined },
  ])("keeps an unavailable Improve snapshot retryable and recovers when data arrives (%j)", (snapshot) => {
    improvementsResult = {
      data: [snapshot],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<LearningTab />);
    expect(screen.getByText("Improve unavailable")).toBeTruthy();
    expect(screen.queryByText("The loop has not produced anything here yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(improvementsResult.invalidate).toHaveBeenCalled();

    improvementsResult = { ...improvementsResult, data: [improvementsDigest] };
    rerender(<LearningTab />);
    expect(screen.queryByText("Improve unavailable")).toBeNull();
    expect(screen.getByLabelText("Search ideas and work")).toBeTruthy();
  });

  it("filters the backlog through the quick-search box, Work-Queue style (owner ask 2026-07-19)", () => {
    nuqsState.impq = "massacre";
    render(<LearningTab />);
    expect(screen.getByLabelText("Search ideas and work")).toBeTruthy();
    expect(
      screen.getByText("Peer restarts massacre in-flight spawns"),
    ).toBeTruthy();
    expect(
      screen.queryByText("cup:spawn children are coordination-MUTE"),
    ).toBeNull();
    // The match count reads shown-of-total while a search is active. Post-merge
    // the TOTAL spans both halves of the loop's output — the work items plus
    // the routed ideas not yet filed as work — so it is deliberately larger
    // than the digest's own row count.
    expect(screen.getByText(/^1 of \d+$/)).toBeTruthy();
    nuqsState.impq = "";
  });

  it("keeps the toolbar and exact zero evidence mounted for an empty server-filter result", () => {
    nuqsState.impq = "p014-impossible-match";
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          census: { total: 0 },
          window: {
            examined: 0,
            windowed: false,
            open: 0,
            byKind: {},
            bySeverity: {},
            byState: {},
          },
          autoEligible: [],
          humanQueue: [],
          routedRows: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    improvementsSummaryResult = {
      data: [{ total: 2_295, matched: 0, facets: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };

    render(<LearningTab />);

    expect(screen.getByLabelText("Search ideas and work")).toBeTruthy();
    expect(screen.getByText("0 of 0")).toBeTruthy();
    expect(
      screen.getByText("Nothing matches the current filter / search"),
    ).toBeTruthy();
    expect(seenArgs["learning.improvements"]).toEqual({
      hive: "alpha-hive",
      q: "p014-impossible-match",
    });
    expect(seenArgs["learning.improvements.summary"]).toEqual({
      hive: "alpha-hive",
      q: "p014-impossible-match",
    });
  });

  // WI-386679. The count element's tooltip may not describe a different
  // population than the number it annotates. It used to say "the list holds the
  // most recent {examined} of {total} captured", but
  // `digest.window.examined` counts only the WORK ITEMS the read projected
  // (== autoEligible + humanQueue on the wire), while the rendered set also
  // carries the routed ideas not yet filed as work that `allRows` appends when
  // lane === 'all'. Same defect class as D-003, one level out from the rail chips.
  //
  // The lane is deliberately left at its 'all' default: `serverPredicateActive`
  // is true for ANY lane/source/rail/search/column selection, so a narrowed view
  // renders one of the two filtered tooltips instead and can never reach this
  // branch. This is the only shape in which the windowed tooltip is visible at
  // all, which is why the divergence it must not misdescribe is one-directional.
  it("never claims the list holds the read's window, which excludes unfiled ideas", () => {
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          // Realistic: `window.examined` equals autoEligible + humanQueue
          // (1 + 1). The fixture's two routed ideas are unfiled (`plan:` /
          // `gym:` refs, not `wi:`), so they are listed too — 4 rows under a
          // "2" window.
          window: { ...improvementsDigest.window, examined: 2, windowed: true },
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };

    render(<LearningTab />);

    const count = screen.getByText("4 listed");
    const title = count.getAttribute("title") ?? "";
    // The window figure survives — as a fact about the READ, and explicitly as
    // a floor rather than a description of the list.
    expect(title).toContain(
      "the 2 most recent of 135 captured work items, plus any routed ideas not yet filed as work",
    );
    // ...but never as a claim about the list, which holds 4.
    expect(title).not.toContain("The list holds");
    // Nor may it repeat the earlier wrong repair, which blamed the narrowing
    // selections that cannot be active on this branch at all.
    expect(title).not.toContain("selections narrow");
    // And the visible suffix must not call this count "loaded": two of the four
    // rows are ideas the read never loaded as work.
    expect(screen.queryByText("4 loaded")).toBeNull();
  });

  it("preserves a server-classified auto-row whose only search hit was raw tierReason", () => {
    nuqsState.impq = "no protected path";
    improvementsResult = {
      data: [{ ...improvementsDigest, humanQueue: [], routedRows: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };

    render(<LearningTab />);

    expect(
      screen.getByText("cup:spawn children are coordination-MUTE"),
    ).toBeTruthy();
  });

  it("threads bounded impf storage axes and impq to the server while leaving presentation filters client-side", () => {
    nuqsState.impf = {
      kind: ["bug"],
      severity: ["critical"],
      scope: ["harness:foo"],
      stage: ["in-flight"],
      ideaType: ["code-bug"],
      lens: ["risk-first"],
    };
    nuqsState.impq = "timeout";

    render(<LearningTab />);

    expect(seenArgs["learning.improvements"]).toEqual({
      hive: "alpha-hive",
      kinds: ["bug"],
      severities: ["critical"],
      scopes: ["harness:foo"],
      stages: ["in-flight"],
      ideaTypes: ["code-bug"],
      lenses: ["risk-first"],
      q: "timeout",
    });
  });

  it("shows the four-stage loop and keeps Improvements inside Improve", () => {
    render(<LearningTab />);
    expect(screen.getByRole("tab", { name: /^Auto-fixable/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Needs review/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Observe" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Improve" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Verify" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Retain" })).toBeTruthy();
    // Ideas is GONE (P-003): it merged into Improvements, so Improve holds one
    // list rather than two views over the same population.
    expect(screen.queryByRole("tab", { name: "Ideas" })).toBeNull();
    // Gym is NOT here by default any more: it rides FLAGS.TESTING (default off)
    // because it is not public-release ready [owner 2026-07-27]. The flag-ON
    // case is the next test.
    expect(screen.queryByRole("tab", { name: "Gym" })).toBeNull();
    // Improve now holds ONE view, so it renders no view-tab strip at all —
    // the same shape Analyze (Pipeline) and Retain (Learnings) already had.
    // Assert the merged pane itself rather than a tab that correctly no
    // longer exists.
    expect(screen.getByLabelText("Where these came from")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Improve" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  /** The Gym gate (WI-6315) [owner 2026-07-27: "Put all the gym features behind a
   *  testing flag, it isnt ready at all"]. Both directions are pinned: hiding it
   *  by default is the release requirement, and the flag-ON path must still be
   *  the full tab — a gate that silently deleted the view would be a different
   *  bug from the one being fixed. The deep-link case matters because `?lview=`
   *  is bookmarkable and appears in reports, so a stale gym link must LAND
   *  somewhere real rather than render a pane the tab no longer offers. */
  describe("Gym view gating (FLAGS.TESTING)", () => {
    afterEach(() => {
      setTestingFlag(false);
    });

    it("shows the Gym view when FLAGS.TESTING is on", () => {
      setTestingFlag(true);
      render(<LearningTab />);
      expect(screen.getByRole("tab", { name: "Gym" })).toBeTruthy();
    });

    it("redirects a stale ?lview=gym deep-link to the default view when the flag is off", () => {
      nuqsState.lview = "gym";
      render(<LearningTab />);
      expect(screen.queryByRole("tab", { name: "Gym" })).toBeNull();
      // Landed on Improve → Improvements (the default), not an empty pane.
      expect(
        screen
          .getByRole("tab", { name: "Improve" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      // Improve now holds ONE view, so it renders no view-tab strip at all —
      // the same shape Analyze (Pipeline) and Retain (Learnings) already had.
      // Assert the merged pane itself rather than a tab that correctly no
      // longer exists.
      expect(screen.getByLabelText("Where these came from")).toBeTruthy();
    });
  });

  /** The view-tab strip's clipped-edge fade (P-007) only exists if something is
   *  WATCHING the strip: the effect at LearningTab.tsx:768 attaches a scroll
   *  listener and a ResizeObserver, and `viewOverflow` — hence data-of-left /
   *  data-of-right — can never leave {false,false} without them.
   *
   *  That effect is keyed [updateViewOverflow, activeStage], and NEITHER dep can
   *  see the strip mount. `updateViewOverflow` is useCallback(…,[]), and
   *  `activeStage` is stageForView(view), which resolves against the STATIC
   *  STAGES constant. But the strip's gate is `activeStageMeta.views.length > 1`,
   *  and that view set is FLAG-derived (visibleStages(testingOn)).
   *
   *  Improve holds exactly two views — `gym` (the sole TESTING_ONLY_VIEWS member)
   *  and `improvements` — so it sits exactly on that boundary, and FLAGS.TESTING
   *  is dark (default OFF) while useFlag seeds from FLAG_DEFAULTS until the async
   *  loadFlags() resolves. So the real production ordering is: render with one
   *  view and no strip, THEN gain the strip when the flag lands — with the effect
   *  skipped, because "improve" is still "improve".
   *
   *  These assert on the OBSERVER rather than on layout: jsdom reports every
   *  scrollWidth/clientWidth as 0, so tabOverflowState would return
   *  {false,false} for a correctly-wired strip too — asserting the data-attrs
   *  would pass whether or not the bug is present. Asserting that the element is
   *  watched is the assertion the bug can actually fail. */
  describe("view-tab strip overflow wiring (P-007)", () => {
    const observed: Element[] = [];
    let priorObserver: unknown;

    beforeEach(() => {
      observed.length = 0;
      priorObserver = (globalThis as unknown as { ResizeObserver: unknown })
        .ResizeObserver;
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
          observe(el: Element) {
            observed.push(el);
          }
          unobserve() {}
          disconnect() {}
        };
    });

    afterEach(() => {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        priorObserver;
      setTestingFlag(false);
    });

    const strip = () =>
      document.querySelector<HTMLElement>(".pc-learning__view-list");

    /** CALIBRATION. The flag armed BEFORE render is the one ordering that always
     *  worked — the strip exists when the effect first runs. Without this, a
     *  recording-observer that never records would make the real test below pass
     *  vacuously for the wrong reason. */
    it("observes the strip when it is already present at first render", () => {
      setTestingFlag(true);
      render(<LearningTab />);
      const list = strip();
      expect(list).toBeTruthy();
      expect(observed).toContain(list);
    });

    it("observes the strip when it mounts AFTER the flag resolves", () => {
      render(<LearningTab />);
      // Improve holds ONE visible view while TESTING is off, so there is no
      // strip yet and nothing for the first effect run to attach to.
      expect(strip()).toBeNull();

      // loadFlags() landing mid-life — the real sequence for any user whose
      // server-side TESTING value is on.
      act(() => {
        setTestingFlag(true);
      });

      const list = strip();
      expect(list).toBeTruthy();
      expect(observed).toContain(list);
    });
  });

  /** The Mug/Kettle tier RETIREMENT (retire-mug-kettle-su-only-2026-08-09
   *  P-059 / D-076, superseding the P-012 / D-020 flag gate).
   *
   *  `wake-efficiency` was the live-Mug read. It is no longer flag-hidden — it
   *  is DELETED, so there is no flag to toggle and no calibration control to
   *  write for one. Two things still need pinning, and they are the two a
   *  deletion is most likely to get wrong: a stale deep-link must still land
   *  somewhere sane, and the drill panels beside it must NOT have gone with
   *  it. */
  describe("Mug/Kettle tier retirement (wake-efficiency deleted)", () => {
    // `?lview=benchmark` selects the VERIFY stage — the row Wake efficiency
    // used to live on. Without it the view-tab strip on screen belongs to
    // Improve, every queryByRole below returns null no matter what, and the
    // check looks proven while nothing was measured — the vacuous pass the
    // calibration control caught when these were first written.
    const renderVerifyRow = () => {
      nuqsState.lview = "benchmark";
      render(<LearningTab />);
    };

    it("no longer offers the Wake efficiency view at all", () => {
      renderVerifyRow();
      expect(screen.queryByRole("tab", { name: "Wake efficiency" })).toBeNull();
      // The row itself is on screen — otherwise the assertion above is vacuous.
      expect(screen.getByRole("tab", { name: "EKG" })).toBeTruthy();
    });

    /** The observable SURVIVES the deletion; its MECHANISM does not, and that
     *  is exactly why this test is re-pointed rather than deleted with the
     *  view. While `wake-efficiency` existed it was a KNOWN id that
     *  `hiddenViews` hid, and the redirect came from the flag gate. Now it is
     *  not in LVIEWS at all, so the membership test in LearningTab rejects it
     *  into the default. Real bookmarks and old links exist, so the landing
     *  behaviour must not regress just because the path to it changed. */
    it("redirects a stale ?lview=wake-efficiency deep-link to the default view", () => {
      nuqsState.lview = "wake-efficiency";
      render(<LearningTab />);
      expect(screen.queryByRole("tab", { name: "Wake efficiency" })).toBeNull();
      expect(
        screen
          .getByRole("tab", { name: "Improve" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    /** D-020, pinned as a test because the mistake is attractive and silent.
     *
     *  P-012's own file list told an implementer to gate RedQueenPanel and
     *  FrontierPanel alongside the Mug ones, and a filename scan agrees ("Red
     *  Queen" contains a tier token; both sit in the same directory). Both are
     *  wrong: "Red Queen" is the evolutionary arms-race term for the SELF-HEALING
     *  DRILL — packages/operator-core/lib/red-queen/ has zero references to
     *  wakeMug, getPotStarted, pot/wake or kettle — and Frontier renders the
     *  learning-loop lane grid. Both belong to the learning system D-001 keeps
     *  INTACT.
     *
     *  Retiring them would be a REGRESSION that looks like progress, and
     *  nothing else in the suite would notice: the tab simply stops being
     *  offered. The risk is HIGHER now than under the flag gate — a deletion
     *  pass sweeping "the Mug files" has no flag to flip back. */
    it("does NOT retire the Red Queen or Frontier views — they are the learning system, not the Mug (D-020)", () => {
      renderVerifyRow();
      expect(screen.getByRole("tab", { name: "Red Queen" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Frontier" })).toBeTruthy();
      // ...in the same render in which the Mug view IS gone, so this cannot
      // pass by the retirement simply never having landed.
      expect(screen.queryByRole("tab", { name: "Wake efficiency" })).toBeNull();
    });
  });

  it("uses visual hierarchy instead of explanatory prose", () => {
    render(<LearningTab />);
    expect(screen.queryByText("How this works")).toBeNull();
    expect(document.querySelector(".pc-learning__copy")).toBeNull();
  });

  it("renders the empty state only when BOTH halves of the loop's output are empty", () => {
    // Post-merge, "nothing here" means no work items AND no routed ideas: a pot
    // with ideas the loop has not filed yet has a non-empty Improve list, so
    // emptying only the digest must NOT produce the empty state.
    scoutResult = {
      data: [{ totalRouted: 0, railCounts: [], recent: [], lastTick: null }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          census: { total: 0 },
          window: {
            examined: 0,
            windowed: false,
            open: 0,
            byKind: {},
            bySeverity: {},
            byState: {},
          },
          autoEligible: [],
          humanQueue: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(
      screen.getByText("The loop has not produced anything here yet"),
    ).toBeTruthy();
  });

  it("lists routed ideas that have no work item yet, even when the digest is empty (P-003)", () => {
    // [owner 2026-07-27 verbatim] "THE IMPROVE SHOULD JUST BE THE IDEAS BEFORE
    // THEY GET INTO WORK ITEMS OR THE WORK ITEMS THAT CAME FROM IDEAS" — the
    // pre-filing half of the loop's output is IN scope. Regression guard: the
    // small-queue path once rendered work items only, which showed an empty
    // state while the pot held routed ideas.
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          census: { total: 0 },
          window: {
            examined: 0,
            windowed: false,
            open: 0,
            byKind: {},
            bySeverity: {},
            byState: {},
          },
          autoEligible: [],
          humanQueue: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(
      screen.queryByText("The loop has not produced anything here yet"),
    ).toBeNull();
    expect(screen.getByText("Cache-warmup plan draft")).toBeTruthy();
    // An unfiled idea states its pipeline position rather than leaving it
    // blank — in the P-004 public vocabulary, not the storage words.
    expect(screen.getAllByText("not ready yet").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  // ── P-004: the pipeline-state vocabulary ──────────────────────────────────
  // The words are the deliverable, so they are asserted literally. The point of
  // the change is that a reader never meets the storage vocabulary
  // (open/assignee/resolved) or the retired approval vocabulary
  // (review/auto/"waits for your review"), because the loop is full-auto and
  // grading is the only human control.

  it("labels an unclaimed filed item 'approved', not by its triage tier", () => {
    render(<LearningTab />);
    // The fixture holds one tier:'auto' and one tier:'human' item, both
    // unassigned. Under the retired vocabulary they read as two DIFFERENT
    // things ("auto" vs "review"); they are in fact in the same pipeline
    // position, and now say so.
    expect(screen.getAllByText("approved").length).toBeGreaterThanOrEqual(2);
  });

  it("shows no human-approval affordance anywhere in the Improve list", () => {
    render(<LearningTab />);
    // The exact strings the tier chip used. A row must never again imply that
    // work is queued behind a human decision.
    expect(screen.queryByTitle("Waits for your review")).toBeNull();
    expect(screen.queryByTitle("An agent may fix this on its own")).toBeNull();
    expect(screen.queryByText("review")).toBeNull();
    // ...and the facet that sliced by that gate is gone with it: filtering by a
    // property no row displays is not a coherent control.
    expect(screen.queryByText("Tier")).toBeNull();
  });

  it("says 'in flight' when an agent holds the item", () => {
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], assignee: "su-abc123" },
          ],
          humanQueue: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getAllByText("in flight").length).toBeGreaterThanOrEqual(1);
  });

  it("reads the COLLAPSED lifecycle, so a resolved item is 'shipped' and a closed one is 'dropped'", () => {
    // Guard for the vocabulary-confusion class behind EI-18792873324746237.
    // ScoredItem.state is the 3-value lifecycle (open|resolved|closed), NOT the
    // raw work-item enum (done|dropped|...) the server's SQL sees. If someone
    // "aligns" this derivation with the server's word list, `resolved` stops
    // matching and every shipped row silently reads as `approved` — which is
    // exactly the shape of failure that put a permanent 0 on this tab.
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          autoEligible: [
            { ...improvementsDigest.autoEligible[0], state: "resolved" },
          ],
          humanQueue: [
            { ...improvementsDigest.humanQueue[0], state: "closed" },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getAllByText("shipped").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("dropped").length).toBeGreaterThanOrEqual(1);
  });

  it("counts the funnel's shipped stage WITHOUT folding in the abandoned ones", () => {
    // EI-18792873324746237 regression guard. `dropped` is reported separately
    // and must never be added to `done`: an idea the loop gave up on is not one
    // it delivered, and summing them overstates the loop's output.
    scoutResult = {
      data: [
        {
          ...scoutSnapshot,
          improveFunnel: {
            routed: 825,
            filed: 598,
            claimed: 12,
            done: 137,
            dropped: 7,
          },
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // The funnel lives inside the "How the loop is doing" disclosure, and Radix
    // Collapsible does not mount closed content — open it before querying.
    fireEvent.click(screen.getByText("How the loop is doing"));
    const funnel = screen.getByLabelText("Idea-to-work funnel");
    expect(funnel.textContent).toContain("137");
    // 144 = 137 shipped + 7 dropped — the sum the old query would have produced.
    expect(funnel.textContent).not.toContain("144");
    // The funnel speaks the SAME words as the row chips, not the storage ones.
    expect(funnel.textContent).toContain("shipped");
    expect(funnel.textContent).toContain("in flight");
    expect(funnel.textContent).toContain("approved");
    expect(funnel.textContent).not.toContain("filed as work");
    expect(funnel.textContent).not.toContain("claimed");
  });

  it("skips the dashboard and duplicate decision rail for a sparse queue", () => {
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          census: { total: 1 },
          window: {
            ...improvementsDigest.window,
            examined: 1,
            windowed: false,
            open: 1,
            byState: { open: 1 },
          },
          autoEligible: [],
          humanQueue: [improvementsDigest.humanQueue[0]],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(document.querySelector(".pc-learning-visual__statline")).toBeNull();
    expect(document.querySelector(".pc-hqdrain")).toBeNull();
    expect(
      screen.getByText("Peer restarts massacre in-flight spawns"),
    ).toBeTruthy();
    expect(screen.queryByText("Captured improvements")).toBeNull();
    expect(document.querySelector(".pc-learning__lanecol")).toBeNull();
  });

  it("renders the P-041 flow strip above the scoreboard — in/out, net, median age, recurrence, watchdog health", () => {
    render(<LearningTab />);
    // Loop diagnostics live behind the "How the loop is doing"
    // disclosure (owner ask 2026-07-19b) — open it first.
    fireEvent.click(
      screen.getByRole("button", { name: /How the loop is doing/ }),
    );
    const strip = screen.getByLabelText("Improvement flow (trailing window)");
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("12"); // captured 7d
    expect(strip.textContent).toContain("8"); // resolved 7d
    expect(strip.textContent).toContain("+4"); // net arrow (backlog grew)
    expect(strip.textContent).toContain("median open");
    expect(strip.textContent).toContain("14d"); // median open age label
    expect(strip.textContent).toContain("3 recurring");
    // last tick 10 minutes ago → green ("Nm ago" label, wd-good chip)
    expect(strip.textContent).toMatch(/watchdog\s*\d+m ago/);
    expect(strip.querySelector(".pc-learning__flowchip--wd-good")).toBeTruthy();
    expect(strip.textContent).toContain("96 ticks / 5 captured · 24h");
  });

  it("omits the flow strip when the resolver row carries no flow block (older payloads)", () => {
    const { flow: _flow, ...digestSansFlow } = improvementsDigest as Record<
      string,
      unknown
    > & { flow: unknown };
    improvementsResult = {
      data: [digestSansFlow],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // Loop diagnostics always visible (owner ask 2026-07-19) — no disclosure to open.
    expect(
      screen.queryByLabelText("Improvement flow (trailing window)"),
    ).toBeNull();
    // Scoped to <dd> for the same reason as above (P-003 lane count badges).
    expect(screen.getByText("135", { selector: "dd" })).toBeTruthy(); // the stat line still renders
  });

  it("renders the dispatch-ledger chip when flow.dispatch is present — fired/fixed counts, red on dead dispatches (P-010 / B-04)", () => {
    const base = improvementsDigest as Record<string, unknown> & {
      flow: Record<string, unknown>;
    };
    const dispatch = {
      total: 9,
      fired7d: 6,
      firing: 0,
      inProgress: 2,
      overdue: 1,
      fireFailed: 1,
      orphaned: 1,
      resolved: { fixed: 3, couldNotFix: 1, needsHuman: 0 },
      fixed7d: 3,
      lastDispatchAt: new Date().toISOString(),
      lastOutcomeAt: new Date().toISOString(),
    };
    improvementsResult = {
      data: [{ ...base, flow: { ...base.flow, dispatch } }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // Loop diagnostics live behind the "How the loop is doing"
    // disclosure (owner ask 2026-07-19b) — open it first.
    fireEvent.click(
      screen.getByRole("button", { name: /How the loop is doing/ }),
    );
    const strip = screen.getByLabelText("Improvement flow (trailing window)");
    expect(strip.textContent).toMatch(/dispatch\s*6\s*fired \/\s*3\s*fixed/);
    expect(strip.textContent).toContain("3 dead"); // overdue + fire-failed + orphaned
    expect(
      strip.querySelectorAll(".pc-learning__flowchip--wd-bad").length,
    ).toBeGreaterThanOrEqual(1);
    // The base fixture carries no dispatch block → the existing flow-strip test
    // doubles as the omitted-chip case.
  });
});

describe("LearningTab — Gym view", () => {
  // The Gym rides FLAGS.TESTING (WI-6315) — arm it, or the tab redirects
  // `?lview=gym` to the default view and none of these assertions can run.
  beforeEach(() => {
    nuqsState.lview = "gym";
    setTestingFlag(true);
  });
  afterEach(() => {
    setTestingFlag(false);
  });

  it("leads directly with sparse gym challengers", () => {
    render(<LearningTab />);
    expect(screen.getByText("Prompt gym")).toBeTruthy();
    expect(screen.getByText("Recent challengers")).toBeTruthy();
    expect(document.querySelector(".pc-learning__gymflow")).toBeNull();
    expect(
      screen.getByText("tighten the worker acceptance check"),
    ).toBeTruthy();
    expect(screen.getByText("more explicit chunk sizing")).toBeTruthy();
    // the champion (accepted) proposal's role — on the deck badge AND the row
    expect(screen.getAllByText("worker").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the gym empty state when no proposals exist", () => {
    gymResult = {
      data: [{ proposals: [], autoloops: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // WI-5809: the empty state NAMES the selected pot (lhive='' resolves to the
    // first list entry) rather than claiming to speak for the whole workspace.
    expect(screen.getByText("No gym activity for alpha-hive yet")).toBeTruthy();
    // P-009 teaching empty: body copy + the arming action ride the same state.
    expect(screen.getByText(/A\/B-refine their blueprints/)).toBeTruthy();
    // P-009: was "Arm the Gym". The action opens the pot SCOPE picker, which is
    // a GATE and cannot arm the gym lane (D-007), so the label names where it
    // actually goes rather than promising an action its destination cannot do.
    expect(
      screen.getByRole("button", { name: "Check learning scope" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Arm the Gym" })).toBeNull();
  });

  // WI-5809 (owner report 2026-07-25): NO CROSS-TENANT FALLBACK. This used to
  // assert the opposite — that an empty pot-scoped read fell back to the
  // workspace-wide rollup. That fallback is how selecting Oddsmith rendered
  // PAPERCUSP's gym experiments, so it was removed from BOTH the server
  // (`learning.gym` resolver) and this view. A selected pot now shows only its
  // own data, or an honest empty state naming it.
  it("does NOT fall back to the workspace-wide rollup when the pot-scoped read is empty (WI-5809 — no cross-tenant leak)", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    // The `papercusp` pot: 1 autoloop config, 0 proposals, 0 archiveSeeds.
    gymResult = {
      data: [
        {
          proposals: [],
          autoloops: [
            {
              harnessSlug: "papercusp",
              enabled: false,
              status: "idle",
              spentUsd: 0,
            },
          ],
          archiveSeeds: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    // The workspace-wide read (hive-less args) DOES have experiments — and the
    // view must still NOT reach for them.
    gymWideResult = {
      data: [
        {
          proposals: [{ id: "wp1", status: "pending" }],
          autoloops: [],
          archiveSeeds: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // The honest, pot-named empty state — not another tenant's challengers.
    expect(screen.getByText("No gym activity for papercusp yet")).toBeTruthy();
    expect(screen.queryByText("Recent challengers")).toBeNull();
    // The gym read stays scoped to the selected pot: no second hive-less fetch.
    expect(seenArgs["learning.gym"]).toEqual({ hive: "papercusp" });
  });

  it("shows loading — NOT the empty state — before the gym query has resolved (undefined snapshot)", () => {
    // Regression (owner report 2026-07-19): a not-yet-fetched gym query (snap
    // undefined, e.g. while the hive lens is still resolving so `enabled` is
    // false) must read as loading. It previously fell through to "No gym
    // experiments" even though the workspace had proposals server-side.
    gymResult = {
      data: undefined,
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Loading gym experiments…")).toBeTruthy();
    // Match the CURRENT empty-state copy ("No gym activity …"); the old
    // /No gym experiments/ regex silently stopped matching anything.
    expect(screen.queryByText(/No gym activity/)).toBeNull();
  });

  // WI-5420 flagged `scopeFallback: true` when the server fell back to the
  // workspace-wide rollup, and this view rendered a note disclosing it. WI-5809
  // deleted the fallback itself — showing tenant A's rows under tenant B's lens
  // is a correctness bug that a disclosure note does not make correct — so the
  // server never sets the flag any more. A legacy/cached payload that still
  // carries it must render as ordinary scoped data, with no cross-tenant note.
  it("renders a legacy scopeFallback payload as ordinary scoped data — no cross-tenant note (WI-5809)", () => {
    gymResult = {
      data: [
        {
          proposals: [{ id: "p1", status: "pending" }],
          autoloops: [],
          scopeFallback: true,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Recent challengers")).toBeTruthy();
    expect(screen.queryByText(/none are scoped to this pot yet/)).toBeNull();
    expect(screen.queryByText(/Showing gym experiments from all/)).toBeNull();
  });
});

describe("LearningTab — unified Signals views", () => {
  it("renders Observations and Rubrics inside Observe", () => {
    nuqsState.lview = "observations";
    render(<LearningTab />);
    expect(screen.getByTestId("observations-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Observations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rubrics" })).toBeTruthy();
  });

  it("renders the merged loop-output list inside Improve, and redirects the retired ?lview=ideas to it (P-003)", () => {
    // `ideas` is a RETIRED view id. It must not render a dead pane, and it must
    // not leave the URL naming a view nobody is looking at.
    nuqsState.lview = "ideas";
    render(<LearningTab />);
    expect(screen.getByLabelText("Where these came from")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Improve" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(nuqsSetters.lview).toHaveBeenCalledWith("improvements");
  });

  it("renders Rubrics inside Observe and drills into a rubric", () => {
    nuqsState.lview = "rubrics";
    const { rerender } = render(<LearningTab />);
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("rubrics-panel"));
    rerender(<LearningTab />);
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
    expect(document.querySelector(".pc-learning__rubricdetail")).not.toBeNull();
    expect(screen.getByTestId("rubric-detail").textContent).toContain(
      "rubric-1",
    );
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
  });

  it("opens an unscored rubric from its Learning URL selection without a list click", () => {
    nuqsState.lview = "rubrics";
    nuqsState.rrubric = "native-unknown-breakdown";
    render(<LearningTab />);
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
    expect(screen.getByLabelText("Rubric evidence")).toBeTruthy();
    expect(screen.getByTestId("rubric-detail").textContent).toContain(
      "native-unknown-breakdown",
    );
    expect(nuqsSetters.rrubric).not.toHaveBeenCalled();
  });

  it("keeps a visited sync pane mounted when navigating to another stage", () => {
    nuqsState.lview = "pipeline";
    const { rerender } = render(<LearningTab />);
    expect(document.querySelector('[data-view="pipeline"]')).not.toBeNull();

    nuqsState.lview = "observations";
    rerender(<LearningTab />);
    expect(
      document.querySelector('[data-view="pipeline"]')?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-view="observations"]')
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("bounds warm panes to the current view and two recent views", () => {
    nuqsState.lview = "pipeline";
    const { rerender } = render(<LearningTab />);
    for (const next of ["observations", "rubrics", "benchmark"]) {
      nuqsState.lview = next;
      rerender(<LearningTab />);
    }
    expect(document.querySelector('[data-view="pipeline"]')).toBeNull();
    expect(document.querySelectorAll(".pc-learning__viewpane")).toHaveLength(3);
    expect(document.querySelector('[data-view="observations"]')).not.toBeNull();
    expect(document.querySelector('[data-view="rubrics"]')).not.toBeNull();
    expect(document.querySelector('[data-view="benchmark"]')).not.toBeNull();
  });

  it("clears transient idea-grade detail when leaving the merged Improve view", () => {
    // Grading moved onto the merged list with the P-003 merge, so ?grade= is
    // now cleared on leaving `improvements` — the view that owns it.
    nuqsState.lview = "improvements";
    nuqsState.grade = "idea-1";
    const { rerender } = render(<LearningTab />);
    nuqsState.lview = "observations";
    rerender(<LearningTab />);
    expect(nuqsSetters.grade).toHaveBeenCalledWith(null);
  });

  it("keeps operational destinations out of the learning header", () => {
    render(<LearningTab />);
    expect(screen.queryByRole("heading", { name: "Learning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Loop health" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insights" })).toBeNull();
  });
});

describe("LearningTab — Benchmark view", () => {
  beforeEach(() => {
    nuqsState.lview = "benchmark";
  });

  it("renders the benchmark answer-first comparison and generation trend", () => {
    render(<LearningTab />);
    expect(screen.getByText("Recent generations")).toBeTruthy();
    // P-006: the compare-view leads with the question it answers.
    expect(screen.getByText("Did the new build get better?")).toBeTruthy();
    expect(screen.getAllByText("80%").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".pc-learning-visual__hero")).not.toBeNull();
    expect(
      document.querySelector(".pc-learning-visual__comparison"),
    ).not.toBeNull();
    expect(
      document.querySelector(".pc-learning-visual__evidence"),
    ).not.toBeNull();
    // shas + composites appear in the generation rows AND the BenchmarkTrend line (B-12)
    expect(screen.getAllByText("bbb2222").length).toBeGreaterThanOrEqual(1); // latest generation sha
    expect(screen.getAllByText("4.060").length).toBeGreaterThanOrEqual(1); // older generation composite
    expect(screen.getAllByText("5.950").length).toBeGreaterThanOrEqual(1); // latest composite (scoreboard + trend)
    // the trend line itself: one polyline + one dot per scored generation
    const figure = document.querySelector("figure.pc-benchtrend");
    expect(figure).not.toBeNull();
    expect(figure!.querySelectorAll("circle")).toHaveLength(2);
  });

  it("renders the owner-gated empty state when there are no generations", () => {
    apiaryResult = {
      data: [{ instances: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("No benchmark runs")).toBeTruthy();
    expect(screen.queryByText("No pot-eval runs")).toBeNull();
  });

  it("keeps the latest scored generation primary while showing a newer unscored run as pending", () => {
    apiaryResult = {
      data: [
        {
          instances: [
            {
              ...apiarySnapshot.instances[0],
              instanceId: "pending-run",
              codeSha: "pending7",
              totalRuns: 4,
              successfulRuns: 0,
              successRate: 0,
              meanComposite: null,
              meanTimeToGreenSecs: null,
              meanTokens: null,
              escalationRate: null,
            },
            ...apiarySnapshot.instances,
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getAllByText("pending").length).toBeGreaterThanOrEqual(1);
    expect(
      document.querySelector(".pc-learning__pendinginline")?.textContent,
    ).toContain("pending · 0/4");
    expect(screen.getAllByText("5.950").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("first generation")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Benchmark" })
        .querySelector(".pc-learning__statusmark"),
    ).toBeNull();
  });

  it("promotes every former benchmark section into the Verify tab row", () => {
    render(<LearningTab />);
    expect(screen.getByRole("tab", { name: "Benchmark" })).toBeTruthy();
    // P-006: the view shows hive-eval SCORING trends, so the label says so.
    expect(screen.getByRole("tab", { name: "Pot scoring" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Framework bake-off" }),
    ).toBeTruthy();
    // "Wake efficiency" was promoted here too, and is deliberately NOT asserted
    // any more: the view was DELETED with the Mug/Kettle tier (P-059 / D-076).
    // Do not "restore" this line — the retirement is pinned by the
    // "Mug/Kettle tier retirement" block above.
    expect(screen.getByRole("tab", { name: "EKG" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Red Queen" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Experiments" })).toBeTruthy();
  });

  // WI-6383. The RENDER-layer half of the reachability fix — the layer the user
  // actually sees. `learning-view-reachability.guard.test.ts` proves the catalog
  // lists Throughput; this proves the catalog entry becomes a tab on screen and
  // that opening the view lights the stage that owns it. Asserting only the
  // catalog would repeat the WI-6384 mistake (a read-layer fix certified green
  // while a render-layer short-circuit still discarded it).
  it("restores Throughput as a clickable Verify view (WI-6383)", () => {
    render(<LearningTab />);
    const tab = screen.getByRole("tab", { name: "Throughput" });
    expect(tab).toBeTruthy();
    // Inside the Verify subtab row, not loose in the header: the 2026-07-12
    // header removal was deliberate and is still pinned by the test below.
    expect(
      within(screen.getByRole("tablist", { name: "Verify views" })).getByRole(
        "tab",
        { name: "Throughput" },
      ),
    ).toBeTruthy();
  });

  it("opens the Throughput view and selects Verify for it (WI-6383)", () => {
    nuqsState.lview = "throughput";
    render(<LearningTab />);
    expect(
      screen.getByRole("tab", { name: "Verify" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "Throughput" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // The dispatch actually mounted ThroughputView — before this fix the view
    // rendered fine here while being unreachable in the UI, so pin BOTH.
    expect(screen.getByText("No throughput recorded yet")).toBeTruthy();
  });

  // WI-6383 live-drive finding: every Throughput assertion until now ran against an
  // EMPTY snapshot, so the per-pot card path — the whole point of the view — had never
  // been rendered by any test in its life. That is what 15 days of unreachability buys:
  // not just no users, no coverage either. Real-shaped data, one pot, one tick.
  it("renders the per-pot throughput cards from a populated snapshot (WI-6383)", () => {
    nuqsState.lview = "throughput";
    throughputResult = {
      data: [
        {
          hives: [
            {
              potSlug: "alpha-hive",
              latest: {
                potSlug: "alpha-hive",
                tickAt: new Date(Date.now() - 60_000).toISOString(),
                frontierDepth: 7,
                cupsBusy: 3,
                cupsCap: 4,
                utilization: 0.75,
                placements: 2,
                completed: 5,
                mttcMs: 930_000,
                stuckCount: 1,
                questionRungs: { self: 4, peer: 1 },
              },
              recent: [],
              operatingWell: false,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.queryByText("No throughput recorded yet")).toBeNull();
    expect(screen.getByLabelText("alpha-hive throughput health")).toBeTruthy();
    expect(screen.getByLabelText("alpha-hive throughput")).toBeTruthy();
    expect(screen.getByText("3/4")).toBeTruthy(); // cups busy / cap
    expect(screen.getByText("75%")).toBeTruthy(); // utilization
    // Scoped to the pot's own health chip: "needs attention" is ALSO the stage/view
    // status-description text, so an unscoped query matches three nodes.
    expect(
      within(screen.getByLabelText("alpha-hive throughput health")).getByText(
        "needs attention",
      ),
    ).toBeTruthy(); // operatingWell:false
    expect(screen.getByLabelText("alpha-hive question rungs")).toBeTruthy();
  });

  // WI-6382's panel sweep skipped ThroughputView because no user could open it.
  // Making it reachable without this would ship the exact defect that item
  // closed: an unreadable substrate rendering as a calm "nothing yet" card that
  // then tells the reader to go start a pot and wait for data that can never
  // arrive. The resolver returns a SUCCESSFUL snapshot for that case, so
  // `sync.error` stays null — the provenance tag is the only signal.
  it("shows a degraded Throughput read as a fault, not as 'nothing yet' (WI-6382)", () => {
    nuqsState.lview = "throughput";
    throughputResult = {
      data: [
        {
          hives: [],
          unavailable: true,
          unavailableKind: "pre-migration",
          unavailableReason: "hive_throughput_ticks does not exist",
        },
      ],
      loading: false,
      fetching: false,
      error: null, // the point: a data-layer fault with NO transport error
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.queryByText("No throughput recorded yet")).toBeNull();
    expect(
      screen.getByText(
        "Throughput not available yet — this install hasn't created its storage (hive_throughput_ticks does not exist)",
      ),
    ).toBeTruthy();
  });

  it("renders Pot scoring (né Pot orchestration) as its own Verify view (HE-07)", () => {
    nuqsState.lview = "orchestration";
    hiveEvalResult = {
      data: [
        {
          instances: [
            {
              instanceId: "hev-new",
              codeSha: "ccc3333",
              createdAt: new Date(2_000_000).toISOString(),
              totalRuns: 4,
              scoredRuns: 4,
              meanComposite: 7.2,
              meanEfficiency: 7,
              meanSpeed: 8,
              meanCriticalPathRatio: 1.3,
              outcomeGatePassRate: 1,
              fabricationRate: 0,
            },
            {
              instanceId: "hev-old",
              codeSha: "ddd4444",
              createdAt: new Date(1_000_000).toISOString(),
              totalRuns: 4,
              scoredRuns: 4,
              meanComposite: 5.5,
              meanEfficiency: 6,
              meanSpeed: 6,
              meanCriticalPathRatio: 1.6,
              outcomeGatePassRate: 0.75,
              fabricationRate: 0,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Outcome gate")).toBeTruthy();
    // P-006: leads with the question the scoring trend answers.
    expect(
      screen.getByText("Are orchestration scores improving?"),
    ).toBeTruthy();
    expect(screen.getByText("1.30×")).toBeTruthy(); // latest critical-path ratio
    expect(screen.getAllByText("7.200").length).toBeGreaterThanOrEqual(1); // latest composite
    expect(document.querySelectorAll("figure.pc-benchtrend")).toHaveLength(1);
    expect(
      screen.getByRole("tab", { name: "Verify" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("data-complete"),
    ).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Verify" })
        .querySelector(".pc-learning__statusmark"),
    ).toBeNull();
  });

  it("renders the Pot-eval empty state only in the Pot orchestration view", () => {
    nuqsState.lview = "orchestration";
    render(<LearningTab />);
    expect(screen.getByText("No pot-eval runs")).toBeTruthy();
  });
});

// RETIRED with the Ideas view (P-003, learning-tab-surface-public-release):
// these covered `ScoutView`, which no longer exists — the Ideas ledger merged
// into Improvements. The BEHAVIOUR they pinned did not go away with the
// component, so P-005 re-establishes each contract against the merged view
// (rendered as <LearningTab /> at ?lview=improvements, with BOTH
// learning.improvements and learning.scout mocked).
//
// STATUS (P-005): ALL ELEVEN are re-established. 7-11 (grading) are in the
// describe-block immediately below, which also carries the ResizeObserver note
// that unblocked them; 1-6 (display + navigation) are in the block after it.
// Nothing is left as prose here — a contract described in a comment is not a
// contract, and the six sat un-re-established for exactly as long as they were
// only written down.

// P-005 RE-ESTABLISHED (contracts 7-11). These were pinned against the retired
// `ScoutView`; the COMPONENT went away in the P-003 merge but the BEHAVIOUR did
// not, so each is re-asserted below against the merged Improve list.
//
// Why these five got done first: grading is the ONLY row control the owner kept
// (2026-07-27 ruling — in a full-auto loop the human teaches the generator, it
// does not approve the work), so it is the one behaviour the merge must not have
// quietly broken. Every approval affordance around it was deliberately deleted
// in P-004; if grading had broken too, the row would have no human control at all.
//
// RETARGETED, not copied: the merged row grades through a Popover + GradePanel,
// so these key on `.pc-learning__notebtn` / `.pc-learning__gradechip` — the
// retired card's inline `.pc-learning__stargrade` radios no longer exist.
describe("LearningTab — grading, the only row control the merge kept (P-005: contracts 7-11)", () => {
  // Both fixtures come from scoutSnapshot.recent and are routed to NON-`wi:`
  // refs, so they survive the merge as standalone idea rows in the Improve list:
  //   idea-1 — ungraded            (rail plan)
  //   idea-2 — graded ★4 by "auto-grader" (rail gym)
  const GRADE_URL = "/api/agent-tools/scout/grade-idea";

  const stubFetch = (impl: {
    ok: boolean;
    status?: number;
    body?: unknown;
  }) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: impl.ok,
      status: impl.status ?? (impl.ok ? 200 : 500),
      json: async () => impl.body ?? { ok: true, applied: true },
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("7. POSTs {ideaId, grade, feedback?} to the grade-idea tool, then invalidates the scout read", async () => {
    const fetchMock = stubFetch({ ok: true });
    const invalidate = vi.fn();
    scoutResult = { ...scoutResult, invalidate };

    nuqsState.grade = "idea-1";
    render(<LearningTab />);

    fireEvent.click(screen.getByLabelText("Grade 5 of 5"));
    fireEvent.change(screen.getByLabelText("Grading note"), {
      target: { value: "  sharp reframing  " },
    });
    fireEvent.click(screen.getByText("save grade"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRADE_URL);
    expect(init.method).toBe("POST");
    // The note is trimmed, and `feedback` is omitted entirely when blank —
    // the server distinguishes "no note" from "empty note".
    expect(JSON.parse(String(init.body))).toEqual({
      ideaId: "idea-1",
      grade: 5,
      feedback: "sharp reframing",
    });
    // Invalidating is what makes the optimistic value converge on the truth;
    // without it the row keeps showing a grade the server may have rejected.
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it("7b. omits `feedback` entirely when the note is left blank", async () => {
    const fetchMock = stubFetch({ ok: true });
    nuqsState.grade = "idea-1";
    render(<LearningTab />);

    fireEvent.click(screen.getByLabelText("Grade 2 of 5"));
    fireEvent.click(screen.getByText("save grade"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      ideaId: "idea-1",
      grade: 2,
    });
  });

  it("8. rolls the optimistic grade BACK and surfaces the error when the write fails", async () => {
    stubFetch({ ok: false, status: 500 });
    nuqsState.grade = "idea-1";
    render(<LearningTab />);

    fireEvent.click(screen.getByLabelText("Grade 3 of 5"));
    fireEvent.click(screen.getByText("save grade"));

    // The failure is SURFACED, not swallowed — a silently-dropped grade would
    // read to the owner as a grade that stuck.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Grade failed");
    expect(alert.textContent).toContain("HTTP 500");

    // ROLLED BACK: idea-1 must not have kept the optimistic ★3 — its control
    // still offers to grade rather than to review an existing grade.
    await waitFor(() =>
      expect(screen.queryByLabelText("Grade this idea")).toBeTruthy(),
    );
  });

  it("8b. rolls back when the tool answers applied:false, even though HTTP succeeded", async () => {
    // A 200 carrying applied:false is the nastier case: the transport is fine,
    // so only the payload says the grade did not land.
    stubFetch({
      ok: true,
      body: { ok: true, applied: false, reason: "idea is gone" },
    });
    nuqsState.grade = "idea-1";
    render(<LearningTab />);

    fireEvent.click(screen.getByLabelText("Grade 4 of 5"));
    fireEvent.click(screen.getByText("save grade"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("idea is gone");
  });

  // The grade chip is PER ROW, and idea-2 carries one straight from the fixture,
  // so an unscoped `querySelector('.pc-learning__gradechip')` answers about
  // whichever row happens to come first — scope to the row by its title.
  const gradeChipFor = (title: string): string =>
    screen
      .getByText(title)
      .closest("[data-index]")
      ?.querySelector(".pc-learning__gradechip")
      ?.textContent?.replace(/\s+/g, " ") ?? "";

  /** The fixture snapshot with one idea's STORED grade replaced — i.e. what the
      refetched read carries after somebody else graded that row. */
  const snapshotWithStoredGrade = (
    ideaId: string,
    humanGrade: number,
    gradedBy: string,
  ) => ({
    ...scoutSnapshot,
    recent: scoutSnapshot.recent.map((idea) =>
      idea.ideaId === ideaId
        ? { ...idea, humanGrade, humanFeedback: "regraded elsewhere", gradedBy }
        : idea,
    ),
  });

  it("11c-calibration. a refetched snapshot DOES re-render the grade cell (row this session never graded)", () => {
    // CALIBRATION for 11d below. It drives the SAME instrument — swap the
    // module-level `scoutResult`, rerender — against a row carrying no
    // optimistic overlay. If this one ever fails, 11d's failure proves nothing
    // about the overlay, only that the snapshot swap is dead.
    const { rerender } = render(<LearningTab />);
    expect(gradeChipFor("Tighter scoper prompt")).toContain("★4");

    scoutResult = {
      ...scoutResult,
      data: [snapshotWithStoredGrade("idea-2", 1, "auto-grader")],
    };
    rerender(<LearningTab />);

    expect(gradeChipFor("Tighter scoper prompt")).toContain("★1");
  });

  it("11d. the optimistic grade YIELDS to the refetched snapshot — it must not shadow a later grade from another source", async () => {
    stubFetch({ ok: true });
    nuqsState.grade = "idea-1";
    const { rerender } = render(<LearningTab />);

    fireEvent.click(screen.getByLabelText("Grade 5 of 5"));
    fireEvent.click(screen.getByText("save grade"));

    // The overlay is doing its job first: ★5 shows immediately, before any
    // refetch can land.
    await waitFor(() =>
      expect(gradeChipFor("Cache-warmup plan draft")).toContain("★5"),
    );

    // Now the invalidated read comes back and the LEDGER disagrees — a peer
    // regraded idea-1 (owner regrade is always allowed, and the auto-grader
    // writes this same column). The overlay was only ever a bridge to that
    // refetch; the ledger is the authority the moment it answers. An overlay
    // that outlives its own confirmation renders this session's stale value on
    // a live SSE row forever, with no stale marker and no way to clear it.
    scoutResult = {
      ...scoutResult,
      data: [snapshotWithStoredGrade("idea-1", 2, "auto-grader")],
    };
    rerender(<LearningTab />);

    await waitFor(() => {
      const chip = gradeChipFor("Cache-warmup plan draft");
      expect(chip).toContain("★2");
      expect(chip).not.toContain("★5");
    });
  });

  it("9. ?grade=<ideaId> opens the panel, and saving is gated on picking a star", () => {
    nuqsState.grade = "idea-1";
    render(<LearningTab />);

    // Opened by URL state alone (so `ui:dispatch` can drive it, per the nuqs rule).
    expect(screen.getByLabelText("Grade this idea 1 to 5")).toBeTruthy();

    // GATED: with no star picked there is no note field and no save button —
    // a grade is required, a note is optional, and the UI enforces that order.
    expect(screen.queryByLabelText("Grading note")).toBeNull();
    expect(screen.queryByText("save grade")).toBeNull();
    expect(
      screen.getByText(/Pick a grade — 5 counts as a win for this lens/),
    ).toBeTruthy();

    // Picking a star opens both, and the hint switches to that grade's meaning.
    fireEvent.click(screen.getByLabelText("Grade 4 of 5"));
    expect(screen.getByLabelText("Grading note")).toBeTruthy();
    expect(screen.getByText("save grade")).toBeTruthy();
  });

  it("9b. does NOT open a grade panel when ?grade names no row", () => {
    nuqsState.grade = "idea-does-not-exist";
    render(<LearningTab />);
    expect(screen.queryByLabelText("Grade this idea 1 to 5")).toBeNull();
  });

  it("10. renders attribution on an already-graded row, with the regrade affordance still live", () => {
    render(<LearningTab />);

    // idea-2 was auto-graded ★4; `graderLabel` maps "auto-grader" to the
    // brain word (the lexicon is mocked identity, so it renders as "brain").
    const chip = document.querySelector(".pc-learning__gradechip");
    expect(chip?.textContent?.replace(/\s+/g, " ")).toContain("★4 · brain");
    // The grader's note rides on the chip title rather than taking row space.
    expect(chip?.getAttribute("title")).toContain("Sharp framing — ship it");

    // REGRADE STAYS OPEN: an auto-grade is a suggestion, not a lock — the
    // owner's grade is sovereign (D-004), so the control must still be there.
    expect(screen.getByLabelText("Review idea grade")).toBeTruthy();
    // ...and the ungraded row still invites a first grade.
    expect(screen.getByLabelText("Grade this idea")).toBeTruthy();
  });

  it("10b. the grade chip shortens a peer agent's session id; the title keeps it whole (WI-10006513)", () => {
    // A full `su-<uuid>` made the nowrap chip ~250px and pushed the row's note
    // button out of its cell at 1366px. The chip shows the presence-style
    // short id; the full id stays in the title.
    const longId = "su-2f324ce6-c2d6-415e-8572-f263eca5d1b0";
    expect(graderChipLabel(longId, "brain")).toBe("su-2f324");
    expect(graderChipLabel("owner", "brain")).toBe("Owner");
    expect(graderChipLabel("auto-grader", "brain")).toBe("brain");
    // A non-id label passes through untouched rather than being mangled.
    expect(graderChipLabel("reviewer-7", "brain")).toBe("reviewer-7");

    scoutResult = {
      ...scoutResult,
      data: [
        {
          ...scoutSnapshot,
          recent: scoutSnapshot.recent.map((idea) =>
            idea.humanGrade != null ? { ...idea, gradedBy: longId } : idea,
          ),
        },
      ],
    };
    render(<LearningTab />);
    const chip = document.querySelector(".pc-learning__gradechip");
    expect(chip?.textContent?.replace(/\s+/g, " ")).toContain("su-2f324");
    expect(chip?.textContent).not.toContain(longId);
    expect(chip?.getAttribute("title")).toContain(longId);
  });

  it("10c. the chip columns carry px floors so a narrow window never cuts a chip (WI-10006513)", () => {
    // Measured on the deployed cloud portal at 1024x650: the bare fr tracks
    // shrank to 49-60px while the lens/severity/stage chips need up to 80px +
    // 20px cell padding, and the overflow:hidden cells cut them mid-word.
    render(<LearningTab />);
    const templates = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .map((el) => el.style.gridTemplateColumns)
      .filter(Boolean);
    // Positive control: the items grid (identified by its Age floor) rendered.
    const itemsGrid = templates.filter((t) => t.includes("minmax(64px, 0.7fr)"));
    expect(itemsGrid.length).toBeGreaterThan(0);
    for (const t of itemsGrid) {
      // lens + stage
      expect(t.split("minmax(104px, 1.1fr)").length - 1).toBe(2);
      // severity
      expect(t).toContain("minmax(72px, 0.9fr)");
      // score (cut at 1024px by a bare 0.6fr track, re-sweep 2026-10-06)
      expect(t).toContain("minmax(56px, 0.6fr)");
      // the pre-fix bare tracks are gone
      expect(
        t.split(" ").filter((track) => track === "1.1fr" || track === "0.9fr" || track === "0.6fr"),
      ).toHaveLength(0);
    }
  });

  it("11. renders lens weights as shares, sorted descending", () => {
    scoutResult = {
      ...scoutResult,
      data: [
        {
          ...scoutSnapshot,
          // Deliberately unsorted and not summing to 100 — the component must
          // normalise to shares AND order them, rather than trusting the server.
          lensWeights: { reframing: 1, analogical: 3, "first-principles": 4 },
        },
      ],
    };
    render(<LearningTab />);

    const strip = screen.getByLabelText("Lens sampling weights");
    const shares = Array.from(strip.querySelectorAll(".pc-learning__lens")).map(
      (el) => el.getAttribute("title") ?? "",
    );

    // 4/8, 3/8, 1/8 → 50%, 38%, 13%, descending.
    expect(shares[0]).toContain("first-principles: 50%");
    expect(shares[1]).toContain("analogical: 38%");
    expect(shares[2]).toContain("reframing: 13%");
  });

  it("11b. omits the lens-weight strip entirely when the snapshot carries none", () => {
    // Absent, not a zeroed strip — an empty chart would imply the ideator has
    // learned that every lens is worthless, which is a different claim.
    for (const weights of [undefined, null, {}, { reframing: 0 }]) {
      cleanup();
      scoutResult = {
        ...scoutResult,
        data: [{ ...scoutSnapshot, lensWeights: weights }],
      };
      render(<LearningTab />);
      expect(screen.queryByLabelText("Lens sampling weights")).toBeNull();
      expect(screen.queryByText("Lens weights")).toBeNull();
    }
  });
});

// P-005 RE-ESTABLISHED (contracts 1-6) — the display + navigation half of the
// retired ScoutView suite, retargeted at the merged Improve view.
//
// These are the contracts that decide whether an idea's PROVENANCE survived the
// merge. The list now shows work and ideas as one population, so the only thing
// still saying where a row came from — which lens made it, what it was grounded
// in, where it routed, how it turned out — is the row's idea half and the trace
// behind it. If that quietly stopped rendering, the merged list would still look
// completely correct: a tidy list of work, with the loop's output silently
// reduced to rows that no longer explain themselves.
//
// Two mechanical notes, both earned:
//   • the nuqs mock's setters write `nuqsState` but do NOT re-render, so a
//     round-trip is asserted in two halves — click, assert the WRITE; re-render
//     with that state, assert the READ. Asserting only the write would pass
//     against a component that never reads the param back.
//   • the rail label ("plan draft") is rendered by BOTH the facet button and the
//     row's lead id, so row assertions scope to the <li>, never the document.
describe("LearningTab — an idea's provenance on a merged row: rail, lens, trace, deep-links (P-005: contracts 1-6)", () => {
  beforeEach(() => {
    // Written by the trace deep-links (contract 5); not in the shared reset.
    nuqsState.plan = null;
    nuqsState.view = null;
    nuqsState.lsel = null;
  });

  const rowFor = (title: string): HTMLElement => {
    // WI-39536: the merged list is a VirtualGrid, so a row is a `[role="row"]`
    // wrapper (header rows carry no title cell, so the filter skips them).
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[role="row"]'),
    ).find(
      (el) => el.querySelector(".pc-learning__title")?.textContent === title,
    );
    if (!row) throw new Error(`no row titled "${title}" in the merged list`);
    return row;
  };
  const txt = (el: Element | null | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  it("1. renders a routed idea as a row carrying its rail as the lead id and its lens as a chip", () => {
    render(<LearningTab />);

    // idea-1 routed to `plan:` and idea-2 to `gym:` — neither is a `wi:` ref, so
    // both survive the merge as standalone idea rows rather than folding into a
    // work item.
    const planIdea = rowFor("Cache-warmup plan draft");
    const gymIdea = rowFor("Tighter scoper prompt");

    // The rail LEADS an idea-only row (a work item would lead with its id) —
    // the human-readable label, not the raw rail key.
    expect(txt(planIdea.querySelector(".pc-learning__id"))).toBe("plan draft");
    expect(txt(gymIdea.querySelector(".pc-learning__id"))).toBe("gym");

    // The lens rides as its own chip: which creative move produced this.
    expect(txt(planIdea.querySelector(".pc-learning__chip--idea"))).toBe(
      "reframing",
    );
    expect(txt(gymIdea.querySelector(".pc-learning__chip--idea"))).toBe(
      "analogical",
    );

    // An idea that never became work is "not ready yet" — the ONE stage
    // vocabulary (P-004), and the only stage an idea-only row can hold.
    expect(txt(planIdea.querySelector("[class*='chip--stage-']"))).toBe(
      "not ready yet",
    );
  });

  it("1b. keeps OUTCOME off the row and in the trace — including the won one, not just pending", () => {
    nuqsState.itrace = "idea-2";
    render(<LearningTab />);

    // idea-2's outcome is "won" — a genuinely interesting value, and still not
    // row furniture. The row carries what you SCAN by (rail, lens, stage, age);
    // outcome is part of the idea's story, which is what the trace is for.
    // Asserting this on the won row matters: a rule stated as "pending is
    // suppressed" would be satisfied by a component that shows every other
    // outcome, which is not the contract.
    const row = rowFor("Tighter scoper prompt");
    // The open trace renders INSIDE the row wrapper as the grid's expanded
    // node, so scope to the CELLS — the row's first child grid — the same way
    // the old card scoped to its meta cell. Pin the positive matches FIRST —
    // every assertion below is a negative, and a negative against an element
    // that silently stopped matching passes for the wrong reason.
    const cells = row.firstElementChild as HTMLElement;
    expect(txt(cells)).toContain("analogical");
    expect(txt(cells)).toContain("not ready yet");
    expect(txt(cells)).not.toContain("won");
    expect(txt(cells)).not.toContain("pending");

    // ...and it IS in the trace, which is open on this row.
    const trace = screen.getByLabelText(
      "Pipeline trace for Tighter scoper prompt",
    );
    expect(txt(trace)).toContain("won");
  });

  it("2. renders one tick-economics row per tick behind the loop disclosure, newest first", () => {
    render(<LearningTab />);
    // Radix Collapsible does not mount closed content — open it before querying.
    fireEvent.click(
      screen.getByRole("button", { name: /How the loop is doing/ }),
    );

    const strip = screen.getByLabelText("scout tick economics, newest first");
    const ticks = within(strip).getAllByRole("listitem");
    expect(ticks).toHaveLength(2);

    // NEWEST FIRST — the fixture's gated tick is 5m old, the ran one 35m. The
    // order is the whole point of the strip: it is read as a recent history.
    const [newest, older] = ticks;

    // A self-gated tick: no cycle ran, so there is no generated→routed funnel
    // and no spend to show. It still gets a row — an invisible gate is exactly
    // how "the loop looks idle and nobody knows why" happens.
    expect(txt(newest)).toContain("gated");
    expect(txt(newest)).toContain("skipped — min-interval");
    expect(newest.querySelector(".pc-learning__tickspend")).toBeNull();
    expect(newest.className).toContain("pc-learning__tickrow--idle");

    // A completed run: the funnel that WI-4482's lens collapse hid, plus spend.
    expect(txt(older)).toContain("8→3");
    expect(txt(older)).toContain("generated 8, routed 3 · completed");
    expect(txt(older.querySelector(".pc-learning__tickspend"))).toBe("$1.62");
    expect(older.className).toContain("pc-learning__tickrow--good");
  });

  it("2b. degrades to the single last-tick chip on a legacy payload with no ticks, and reads 'none yet' with no tick at all", () => {
    const { ticks: _ticks, ...legacy } = scoutSnapshot as Record<
      string,
      unknown
    > & { ticks: unknown };
    scoutResult = { ...scoutResult, data: [legacy] };
    render(<LearningTab />);
    fireEvent.click(
      screen.getByRole("button", { name: /How the loop is doing/ }),
    );

    // Degrade, never crash: an older server snapshot predates the per-tick rows.
    const strip = screen.getByLabelText("scout tick economics, newest first");
    expect(within(strip).queryAllByRole("listitem")).toHaveLength(0);
    expect(txt(strip)).toContain("last tick");
    // lastTick survives on the legacy shape, so it still reports WHEN.
    expect(txt(strip)).not.toContain("none yet");

    // Nothing recorded at all ⇒ say so plainly rather than rendering a blank
    // strip, which reads as a broken instrument instead of an idle one.
    cleanup();
    scoutResult = {
      ...scoutResult,
      data: [{ ...legacy, lastTick: null }],
    };
    render(<LearningTab />);
    fireEvent.click(
      screen.getByRole("button", { name: /How the loop is doing/ }),
    );
    expect(
      txt(screen.getByLabelText("scout tick economics, newest first")),
    ).toContain("none yet");
  });

  it("3. teaches on the empty list, and its Open Arming lands on the Workflows AI catalog", () => {
    improvementsResult = {
      ...improvementsResult,
      data: [
        {
          ...improvementsDigest,
          census: { total: 0 },
          window: {
            examined: 0,
            windowed: false,
            open: 0,
            byKind: {},
            bySeverity: {},
            byState: {},
          },
          autoEligible: [],
          humanQueue: [],
        },
      ],
    };
    scoutResult = {
      ...scoutResult,
      data: [{ ...scoutSnapshot, recent: [], totalRouted: 0, railCounts: [] }],
    };
    render(<LearningTab />);

    const empty = document.querySelector(
      ".pc-learning-visual__empty",
    ) as HTMLElement;
    expect(txt(empty)).toContain("The loop has not produced anything here yet");
    // TEACHING, not just empty: an empty learning surface is indistinguishable
    // from a broken one unless it says what fills it.
    expect(txt(empty)).toContain("routes surviving ideas here");
    expect(txt(empty)).toContain("once armed");

    // The banner renders its own "Open Arming" — scope to the empty state, or
    // this asserts the wrong button (they share a hook, not a call site).
    fireEvent.click(within(empty).getByRole("button", { name: "Open Arming" }));
    // P-009: this opens the every-pot SCOPE PICKER. It used to deep-link to
    // `tab=workflows&wfKind=routine` — the routine SCHEDULE list, which answers
    // "when does this run" and carries no control for "is this pot learning at
    // all", which is what the reader clicked for.
    expect(nuqsState.lpick).toBe(true);
    // ...and it must NOT still route to Workflows. Asserted against the exported
    // constants so a silent revert reds here instead of shipping.
    expect(nuqsState.tab).not.toBe(ARMING_WORKFLOWS_TAB);
    expect(nuqsState.wfKind).not.toBe(ARMING_WORKFLOWS_KIND);
    expect(nuqsState.wfView).toBeNull();
    expect(nuqsState.wfFilter).toBeNull();
  });

  it("3b. withholds the teaching copy when the list is empty because of a FILTER", () => {
    // "Nothing matches your filter" must not offer to arm the loop — the loop is
    // already producing; the reader hid it. Teaching here would misdiagnose.
    nuqsState.irail = "instance"; // a rail nothing in the fixture routed to
    render(<LearningTab />);

    const empty = document.querySelector(
      ".pc-learning-visual__empty",
    ) as HTMLElement;
    expect(txt(empty)).toContain("Nothing matches the current filter");
    expect(
      within(empty).queryByRole("button", { name: "Open Arming" }),
    ).toBeNull();
    expect(txt(empty)).not.toContain("once armed");
  });

  it("4. renders the pipeline trace end to end: resolved grounding, readable refs, stripped route, and the GAPS", () => {
    nuqsState.itrace = "idea-1";
    render(<LearningTab />);

    const trace = screen.getByLabelText(
      "Pipeline trace for Cache-warmup plan draft",
    );
    const chips = Array.from(trace.querySelectorAll(".pc-learning__tracechip"));

    // GROUNDING — an opaque `wi:` ref resolves to its TITLE. The raw id alone is
    // unreadable evidence: "grounded in EI-100" tells the reader nothing about
    // whether the grounding was any good.
    const wiChip = chips.find((c) => txt(c).startsWith("wi"))!;
    expect(txt(wiChip)).toContain("coord invariant: wake-queue depth growth");
    expect(txt(wiChip)).not.toContain("EI-100");

    // A typed ref that is not a work item stays readable: kind split off the
    // front, the rest intact — never a re-doubled "fact: fact:…".
    const factChip = chips.find((c) => txt(c).startsWith("fact"))!;
    expect(txt(factChip)).toBe("factworkspace:some-standing-fact");

    // ROUTE — the rail chip already names the destination, so the ref renders
    // WITHOUT its prefix (owner ask 2026-07-19: "gym gym:SP-004" read as a bug).
    const routed = trace.querySelector(
      ".pc-learning__tracechip--link b",
    ) as HTMLElement;
    expect(txt(routed)).toBe("scout-cache-warmup");
    expect(txt(trace)).not.toContain("plan:scout-cache-warmup");

    // THE GAPS ARE THE SIGNAL — an ungraded idea on a starving grading loop is
    // the finding. Render it dimmed; never omit the row, which would make a
    // starved loop look identical to a healthy one.
    const rows = Array.from(trace.querySelectorAll(".pc-learning__tracerow"));
    const gradeRow = rows.find((r) => txt(r).startsWith("grade"))!;
    expect(txt(gradeRow)).toContain("ungraded");
    expect(gradeRow.className).toContain("is-missing");

    const outcomeRow = rows.find((r) => txt(r).startsWith("outcome"))!;
    expect(txt(outcomeRow)).toContain("pending");
    expect(outcomeRow.className).toContain("is-missing");

    // The lens row carries the origin alongside it.
    expect(txt(rows.find((r) => txt(r).startsWith("lens")))).toContain(
      "reframing",
    );
  });

  it("4c. falls back to the raw ref when the server resolved no title for it", () => {
    // The falsifying twin of contract 4's title assertion. Same ref, same chip,
    // title lookup empty ⇒ the id renders. If 4 were passing because the chip
    // happens to print whatever it is given, this test could not differ from it
    // — that it DOES is what proves 4 is reading a real resolution.
    scoutResult = {
      ...scoutResult,
      data: [{ ...scoutSnapshot, groundingTitles: {} }],
    };
    nuqsState.itrace = "idea-1";
    render(<LearningTab />);

    const wiChip = Array.from(
      screen
        .getByLabelText("Pipeline trace for Cache-warmup plan draft")
        .querySelectorAll(".pc-learning__tracechip"),
    ).find((c) => txt(c).startsWith("wi"))!;
    // Degrade to the id rather than rendering an empty chip: an unresolvable
    // ref is still evidence, and the reader can look it up by hand.
    expect(txt(wiChip)).toBe("wiEI-100");
    expect(txt(wiChip)).not.toContain("coord invariant");
  });

  it("4b. renders 'none recorded' when an idea has no grounding at all", () => {
    // idea-2 carries no addressesPatternRefs. Same rule as above: say the
    // evidence is missing rather than dropping the row and implying none was
    // ever expected.
    nuqsState.itrace = "idea-2";
    render(<LearningTab />);

    const trace = screen.getByLabelText(
      "Pipeline trace for Tighter scoper prompt",
    );
    const grounded = Array.from(
      trace.querySelectorAll(".pc-learning__tracerow"),
    ).find((r) => txt(r).startsWith("grounded in"))!;
    expect(txt(grounded)).toContain("none recorded");
    expect(grounded.className).toContain("is-missing");
    // A graded idea fills the grade row instead of dimming it.
    const gradeRow = Array.from(
      trace.querySelectorAll(".pc-learning__tracerow"),
    ).find((r) => txt(r).startsWith("grade"))!;
    expect(gradeRow.className).not.toContain("is-missing");
  });

  it("5. deep-links a plan-rail trace to Create → Plans, and a gym-rail one to the Gym view", () => {
    nuqsState.itrace = "idea-1";
    render(<LearningTab />);

    const trace = screen.getByLabelText(
      "Pipeline trace for Cache-warmup plan draft",
    );
    fireEvent.click(
      within(trace)
        .getAllByRole("button")
        .find((b) => txt(b).includes("scout-cache-warmup"))!,
    );

    // All three params, all nuqs — so `ui:dispatch` can drive the same
    // navigation an operator does. The slug is passed WITHOUT its `plan:` prefix.
    expect(nuqsState.plan).toBe("scout-cache-warmup");
    expect(nuqsState.view).toBe("plans");
    expect(nuqsState.tab).toBe("plans");

    // CONTRAST: a gym-rail idea stays on this tab and switches the view instead
    // — the rail decides the destination, so both branches need pinning.
    cleanup();
    nuqsState.itrace = "idea-2";
    nuqsState.tab = null;
    render(<LearningTab />);
    const gymTrace = screen.getByLabelText(
      "Pipeline trace for Tighter scoper prompt",
    );
    fireEvent.click(
      within(gymTrace)
        .getAllByRole("button")
        .find((b) => txt(b).includes("proposal-7"))!,
    );
    expect(nuqsState.lview).toBe("gym");
    expect(nuqsState.tab).toBeNull(); // never leaves the Learning tab
  });

  it("6. round-trips the rail filter through ?irail — pressed state AND the filtered list", () => {
    render(<LearningTab />);
    // ⚠ Query the rail facet by its aria-label, NOT by `.pc-learning__idea-filters`:
    // the provenance scope bar ("Where these came from") reuses that same class
    // and renders FIRST, so a class query silently returns the wrong bar — whose
    // buttons are also aria-pressed toggles, which is how it would go unnoticed.
    const facets = () => screen.getByLabelText("Idea routing");
    const facetNamed = (label: string) =>
      Array.from(facets().querySelectorAll("button")).find((b) =>
        txt(b).startsWith(label),
      )!;

    // Unfiltered: "All rails" is the pressed one.
    expect(facetNamed("All rails").getAttribute("aria-pressed")).toBe("true");
    expect(facetNamed("plan draft").getAttribute("aria-pressed")).toBe("false");
    // D-003 (learning-tab-filters-are-page-scoped-2026-08-17): a number rendered
    // ON a filter control is a promise about what clicking it yields, so these
    // counts are derived from the rows the filter runs on — NOT from the
    // snapshot's corpus-wide `railCounts`. This assertion is the inverse of the
    // one it replaces, which pinned the superseded contract ("they describe the
    // whole population, not this page of it") and is exactly the behaviour the
    // owner called broken: the chip advertised a number the list could not show.
    //
    // The fixture encodes that gap deliberately: railCounts claims plan:3 / gym:1
    // (totalRouted 4) while `recent` carries ONE plan idea and ONE gym idea.
    expect(txt(facetNamed("plan draft"))).toContain("1");
    // The falsifier — reverting to snap.railCounts prints the corpus 3 here.
    expect(txt(facetNamed("plan draft"))).not.toContain("3");
    // ⚠ "All rails" is NOT a useful guard in this fixture: the loaded set is 4
    // rows (2 digest items + 2 unfiled ideas), which COINCIDES with the stale
    // totalRouted of 4 — it passes under both contracts. Asserting it would look
    // like coverage while proving nothing, so the promise is pinned on the rail
    // chip above and on the rows the click actually delivers, below.
    expect(txt(facetNamed("All rails"))).toContain("4");

    // WRITE half of the round-trip.
    fireEvent.click(facetNamed("plan draft"));
    expect(nuqsState.irail).toBe("plan");

    // READ half: re-render with the state the click just wrote. Asserting only
    // the write would pass against a component that never reads the param back.
    cleanup();
    render(<LearningTab />);
    expect(facetNamed("plan draft").getAttribute("aria-pressed")).toBe("true");
    expect(facetNamed("All rails").getAttribute("aria-pressed")).toBe("false");
    // ...and the list is genuinely filtered, not just the button re-styled.
    expect(screen.getByText("Cache-warmup plan draft")).toBeTruthy();
    expect(screen.queryByText("Tighter scoper prompt")).toBeNull();

    // Clicking the pressed facet clears it — a filter you cannot leave is a trap.
    fireEvent.click(facetNamed("plan draft"));
    expect(nuqsState.irail).toBeNull();
  });

  // WI-469537. The test above pins the chip's visible NUMBER (the loaded rows,
  // per D-003). This one pins its PROMISE, which is a separate claim and was the
  // one that had drifted: `shown` describes the current window, but selecting the
  // rail puts `rails:[…]` into the server predicate and
  // projectLearningImproveRows filters the WHOLE corpus before windowing
  // (learning-improve-view-query.ts:278-283) — so the click yields up to the
  // corpus tally, not `shown`. D-003's original bug OVER-promised; pinning the
  // number to the loaded rows fixed that and left the mirror-image UNDER-promise.
  //
  // Asserted on the pure helper rather than through a render because the chip's
  // tooltip is a Radix `asChild` trigger whose content is portaled and appears
  // only on hover.
  it("7. a rail chip promises what SELECTING it yields, not what the window happens to hold", () => {
    const promise = railChipPromise("Routed to a plan", 1, 312);
    // The corpus figure must be stated as the RESULT of the click...
    expect(promise).toContain("selecting it re-reads the corpus and lists up to 312");
    // ...and the loaded count must be scoped to the list as it stands.
    expect(promise).toContain("1 of the rows loaded here");
    // The superseded framing presented the corpus number as background context,
    // which is precisely what let the chip under-promise. It must not return.
    expect(promise).not.toContain("routed to this rail in all");
    // No divergence ⇒ no promise to make, so the chip says only what it is.
    expect(railChipPromise("Routed to a plan", 4, 4)).toBe("Routed to a plan");
  });

  // ── WI-523949. `?lsel` is documented at its own declaration as "highlighted +
  // scrolled into view". Only the CARD list ever scrolled, and the card list is
  // the one a pot with FEWER than 4 open items gets — the short one. Every list
  // long enough for the promise to matter renders through the virtualized grid,
  // where a highlight on an unmounted row is not observable by anyone.
  //
  // These assert on `scrollToIndex` because it is the only thing that can move a
  // virtualized list to a row that is not mounted. 8b is the calibration control
  // for 8: it drives the identical instrument with no selection and must NOT
  // scroll, so a passing 8 cannot be an always-firing effect; 8c pins the third
  // state (a target the row set does not hold) that separates "nothing to scroll
  // to" from "scrolls to whatever index findIndex returned", which for a miss
  // is -1 — an index the virtualizer would happily accept.
  it("8. brings the ?lsel deep-link target into view in the virtualized grid, not just highlights it", () => {
    virtualizerSpies.scrollToIndex.mockClear();
    // Both deep-link params are pinned in every case below, so each test states
    // WHICH target it is attributing the scroll to rather than inheriting one
    // from whatever ran before it.
    nuqsState.itrace = null;
    nuqsState.lsel = "EI-85";
    render(<LearningTab />);

    // CALIBRATION, in-test: the dead-instrument reading of a "was not called"
    // result is that nothing rendered or the deep-link never applied. Rule both
    // out first — the row IS mounted and IS visibly selected — so the only
    // remaining explanation for a missing scroll is that none was requested.
    const row = rowFor("Peer restarts massacre in-flight spawns");
    expect(row.style.background).toContain("color-mix");

    // The grid's own wrapper carries the virtual index it was rendered at, so
    // the expectation is read from the component's own numbering rather than a
    // hand-counted fixture order that a later fixture edit would silently break.
    const wrapper = row.closest("[data-index]") as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    const expectedIndex = Number(wrapper!.dataset.index);
    expect(Number.isFinite(expectedIndex)).toBe(true);

    expect(virtualizerSpies.scrollToIndex).toHaveBeenCalled();
    expect(virtualizerSpies.scrollToIndex.mock.calls[0]?.[0]).toBe(expectedIndex);
  });

  it("8b. CONTROL: the same render with no deep-link scrolls nowhere", () => {
    virtualizerSpies.scrollToIndex.mockClear();
    nuqsState.lsel = null;
    nuqsState.itrace = null;
    render(<LearningTab />);

    // Same instrument, same mounted grid — proof that 8's call came from the
    // deep-link and not from an effect that fires on every mount.
    expect(
      document.querySelectorAll('[role="row"]').length,
    ).toBeGreaterThan(1);
    expect(virtualizerSpies.scrollToIndex).not.toHaveBeenCalled();
  });

  it("8c. does not scroll for a deep-link the loaded rows do not hold", () => {
    virtualizerSpies.scrollToIndex.mockClear();
    nuqsState.itrace = null;
    nuqsState.lsel = "EI-does-not-exist";
    render(<LearningTab />);

    // A miss must be a no-op, never `scrollToIndex(-1)`. It must also stay
    // unlatched: the target routinely arrives on a later read, and the scroll is
    // re-attempted then.
    expect(virtualizerSpies.scrollToIndex).not.toHaveBeenCalled();
  });
});

describe("LearningTab — inherited pot lens (owner directive 2026-07-26; was P-042's per-tab picker)", () => {
  const badge = () => document.querySelector(".pc-learning__hivepick");

  it("shows the inherited-pot badge on hive-aware views (Improvements), named via potHomeLabel", () => {
    render(<LearningTab />); // default view = improvements (hive-aware)
    // potHomeLabel strips the `-hive` home suffix for display
    // (workspace-hive-ui-2026-06-17); the badge is read-only — the selection
    // lives in the top-bar pot selector, not here.
    expect(badge()?.textContent).toContain("alpha");
    expect(document.querySelector("select[aria-label='pot lens']")).toBeNull();
  });

  it("shows the badge on the Gym and Learnings views too", () => {
    nuqsState.lview = "gym";
    render(<LearningTab />);
    expect(badge()).toBeTruthy();
    cleanup();
    nuqsState.lview = "learnings";
    render(<LearningTab />);
    expect(badge()).toBeTruthy();
  });

  it("HIDES the badge on workspace-global views", () => {
    // P-005 (pot-scope-all-learnings): ideas/frontier/throughput joined the
    // hive-aware set — only views whose tables carry no pot identity stay here.
    for (const v of ["observations", "rubrics", "benchmark", "signals"]) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(badge()).toBeNull();
    }
  });

  it("shows the badge on the P-005 pot-scoped views (ideas / frontier / throughput)", () => {
    for (const v of ["ideas", "frontier", "throughput"]) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(badge()).toBeTruthy();
    }
  });

  it("scopes the feed to the inherited pot — badge and threaded arg agree", () => {
    render(<LearningTab />);
    expect(badge()?.textContent).toContain("alpha");
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "alpha-hive" });
  });

  // The lens is inherited from the top-bar pot selection (useAdvScope, owner
  // directive 2026-07-26) — the tab-level picker is gone, so the threading
  // tests drive the SCOPE, exactly as AdvShell resolves it from ?slug=.
  it("threads the inherited pot into the Improvements query args", () => {
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the inherited pot into the Gym query args", () => {
    nuqsState.lview = "gym";
    // The Gym rides FLAGS.TESTING (WI-6315) — without it the view never mounts,
    // so it would never issue the query whose args this asserts on.
    setTestingFlag(true);
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    gymResult = {
      data: [{ proposals: [{ id: "p1", status: "pending" }], autoloops: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(seenArgs["learning.gym"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the inherited pot into the Learnings (retained ledger) query args", () => {
    nuqsState.lview = "learnings";
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    render(<LearningTab />);
    // The ledger feed + the always-on strip both carry the lens (WI-39535 —
    // the standalone learning.hive pool read is gone; memories ride the feed).
    expect(seenArgs["learning.retainFeed"]).toMatchObject({
      hive: "beta-hive",
    });
    expect(seenArgs["learning.retain"]).toEqual({ hive: "beta-hive" });
  });

  it("All Pots (hive '') scopes every hive-aware query workspace-wide", () => {
    advScopeState.allMode = true;
    advScopeState.slug = null;
    advScopeState.hive = "";
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toEqual({});
  });

  // WI-6384 residual: the resolver + the query GATE were fixed to serve the
  // workspace-wide rollup for hive '', but LearningsView still short-circuited
  // the RENDER on `hive === ""` and printed "No pots" — so the rollup arrived
  // and was thrown away one layer below the fix. The lens guard could not see
  // this: it asserts on query enablement/args, and both were already correct.
  // A read-layer guard is structurally blind to a render-layer refusal, so the
  // All-Pots contract needs a test that renders.
  it("All Pots (hive '') RENDERS the workspace-wide retained ledger, not 'No pots'", () => {
    nuqsState.lview = "learnings";
    advScopeState.allMode = true;
    advScopeState.slug = null;
    advScopeState.hive = "";
    retainFeedResult = {
      data: [
        {
          rows: [
            {
              kind: "memory",
              id: "learning-rollup-1",
              title:
                "Workspace-wide retained learning visible under the All Pots lens.",
              ts: "2026-08-15T12:00:00.000Z",
              status: null,
              shipped: false,
              meta: {},
            },
          ],
          counts: {
            memories: 1,
            plans: 0,
            wi: 0,
            rubrics: 0,
            runbooks: 0,
            recipes: 0,
          },
          nextCursor: null,
          degraded: [],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(document.body.textContent).toContain(
      "Workspace-wide retained learning visible under the All Pots lens.",
    );
    expect(document.body.textContent).not.toContain("No pot");
  });

  // The other half of the same contract: a leg that failed to read must surface
  // VISIBLY (WI-6382's class — the calm empty state hiding a fault). The feed
  // degrades per leg server-side and names the fallen legs; the ledger renders
  // them rather than silently omitting that kind.
  it("All Pots (hive '') surfaces a degraded feed leg by name", () => {
    nuqsState.lview = "learnings";
    advScopeState.allMode = true;
    advScopeState.slug = null;
    advScopeState.hive = "";
    retainFeedResult = {
      data: [
        {
          rows: [],
          counts: null,
          nextCursor: null,
          degraded: ["memory"],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(document.body.textContent).toContain("degraded: memory");
  });

  // WI-39675 — the same WI-6382 class one level deeper, and the defect the owner
  // actually reported ("in the retain tab, it just says 'loading retained
  // items...' forever", 2026-08-17).
  //
  // A RETRYING load is not a loading load. `loading` is TanStack's isLoading
  // (isPending && isFetching), which stays TRUE for the entire retry sequence
  // while `error` stays NULL until the last retry is exhausted — so a feed whose
  // every attempt times out is, to a bare `loading` branch, indistinguishable
  // from a healthy first paint, for ~47s (3 retries, 1s/2s/4s backoff, 10s
  // server timeout). The user reads that as "forever".
  //
  // This pins BOTH directions, because a guard that only checks the failing case
  // would pass just as happily on a branch that always cries "retrying".
  it("a retrying retain load says so and offers a retry — a healthy one does not", () => {
    nuqsState.lview = "learnings";
    const loadingPage = (failureCount: number) => ({
      data: [],
      loading: true,
      fetching: true,
      error: null,
      failureCount,
      failureReason: failureCount
        ? new Error('sync query "learning.retainFeed" timed out after 10000ms')
        : null,
      invalidate: vi.fn(),
    });

    // Scoped to the Retain section, not document.body: other panels on this tab
    // legitimately use the word "retrying", and a body-wide negative assertion
    // would fail on their copy rather than on this branch's.
    const ledger = () =>
      within(screen.getByRole("region", { name: "Retained ledger" }));

    // Healthy first paint: the plain spinner copy, and NO alarm.
    retainFeedResult = loadingPage(0);
    render(<LearningTab />);
    expect(ledger().getByText(/Loading retained items…/)).toBeTruthy();
    expect(ledger().queryByText(/retrying/)).toBeNull();
    expect(ledger().queryByRole("button", { name: /retry now/i })).toBeNull();
    cleanup();

    // Two attempts have already failed: say so, name the reason, offer the retry.
    retainFeedResult = loadingPage(2);
    render(<LearningTab />);
    expect(ledger().getByText(/2 attempts failed, retrying…/)).toBeTruthy();
    expect(ledger().getByText(/timed out after 10000ms/)).toBeTruthy();

    // The retry affordance must actually refetch, not just decorate.
    fireEvent.click(ledger().getByRole("button", { name: /retry now/i }));
    expect(retainFeedResult.invalidate).toHaveBeenCalled();
  });

  // WI-39534: a memory row's detail aside — click selects (rsel), the aside
  // renders the FULL body (the row title is the 200-char clamp), and an
  // editable memory exposes edit/remove. Close clears the selection.
  it("opens a memory row's detail aside on click and closes it again", () => {
    nuqsState.lview = "learnings";
    retainFeedResult = {
      data: [
        {
          rows: [
            {
              kind: "memory",
              id: "learning-1",
              title:
                "Migration 557 completed the canonical federation table rename.",
              ts: "2026-08-15T12:00:00.000Z",
              status: null,
              shipped: false,
              meta: { memKind: "migration", createdBy: "system-migration" },
            },
          ],
          counts: null,
          nextCursor: null,
          degraded: [],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    retainDetailResult = {
      data: [
        {
          kind: "memory",
          id: "learning-1",
          title:
            "Migration 557 completed the canonical federation table rename.",
          status: null,
          ts: "2026-08-15T12:00:00.000Z",
          body: "Migration 557 completed the canonical federation table rename. Live code now uses pot-prefixed tables everywhere.",
          bodyTruncated: false,
          code: null,
          listItems: [],
          fields: [{ label: "kind", value: "migration" }],
          editable: true,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<LearningTab />);
    fireEvent.click(
      screen.getByText(/Migration 557 completed the canonical federation/),
    );
    expect(nuqsState.rsel).toBe("memory:learning-1");
    rerender(<LearningTab />);
    expect(screen.getByLabelText("Retained item detail")).toBeTruthy();
    expect(
      screen.getByText(/Live code now uses pot-prefixed tables everywhere/),
    ).toBeTruthy();
    // The editable footer — the pool's inline edit/remove moved here (WI-39535).
    expect(screen.getByRole("button", { name: "edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "remove" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(nuqsState.rsel).toBeNull();
  });

  describe("retained memory mutation responses", () => {
    let memoryFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      nuqsState.lview = "learnings";
      nuqsState.rsel = "memory:mutation-selected";
      retainFeedResult = {
        data: [{ rows: [{ kind: "memory", id: "mutation-selected", title: "Selected learning",
          ts: "2026-08-15T12:00:00.000Z", status: null, shipped: false, meta: {} }],
          counts: null, nextCursor: null, degraded: [], generatedAt: "2026-08-16T00:00:00.000Z" }],
        loading: false, fetching: false, error: null, invalidate: vi.fn(),
      };
      retainDetailResult = {
        data: [{ kind: "memory", id: "mutation-selected", title: "Selected learning", status: null,
          ts: "2026-08-15T12:00:00.000Z", body: "Original selected learning body.",
          bodyTruncated: false, code: null, listItems: [], fields: [], editable: true }],
        loading: false, fetching: false, error: null, invalidate: vi.fn(),
      };
      memoryFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", memoryFetch);
    });

    afterEach(() => vi.unstubAllGlobals());

    const invalidators = () => [retainDetailResult, retainFeedResult, retainSummaryResult, retainCountsResult]
      .map(result => result.invalidate);

    async function submitMemoryAction(method: "PATCH" | "DELETE", cancel = false) {
      fireEvent.click(screen.getByRole("button", { name: method === "PATCH" ? "edit" : "remove" }));
      if (method === "PATCH") {
        fireEvent.change(screen.getByLabelText("Learning text"), { target: { value: "Updated selected learning body." } });
      }
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: cancel ? "Cancel" : method === "PATCH" ? "Save" : "Remove" }));
      });
    }

    it.each([
      ["PATCH", 403], ["PATCH", 500], ["DELETE", 403], ["DELETE", 500],
    ] as const)("keeps selected memory and reports rejected %s HTTP %s without success refresh", async (method, status) => {
      memoryFetch.mockResolvedValue(new Response(JSON.stringify({ error: "Memory change denied" }), { status }));
      render(<LearningTab />);
      await screen.findByText("Original selected learning body.");
      await submitMemoryAction(method);
      expect(memoryFetch).toHaveBeenCalledTimes(1);
      expect(memoryFetch.mock.calls[0][1]).toMatchObject({ method });
      expect(nuqsState.rsel).toBe("memory:mutation-selected");
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(`HTTP ${status}`);
      expect(alert.textContent).toContain("Memory change denied");
      expect(screen.getByText("Original selected learning body.")).toBeTruthy();
      for (const invalidate of invalidators()) expect(invalidate).not.toHaveBeenCalled();

      // The same selected item can be retried; the successful receipt clears the error.
      memoryFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await submitMemoryAction(method);
      expect(memoryFetch).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(nuqsState.rsel).toBe(method === "PATCH" ? "memory:mutation-selected" : null);
      for (const invalidate of invalidators()) expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it.each(["PATCH", "DELETE"] as const)("refreshes the selected memory only after a successful %s receipt", async method => {
      render(<LearningTab />);
      await screen.findByText("Original selected learning body.");
      await submitMemoryAction(method);
      expect(memoryFetch).toHaveBeenCalledTimes(1);
      const [url, init] = memoryFetch.mock.calls[0];
      expect(url).toBe(method === "PATCH" ? "/api/user/memory" : "/api/user/memory?id=mutation-selected");
      expect(init.method).toBe(method);
      if (method === "PATCH") expect(JSON.parse(init.body)).toEqual({ id: "mutation-selected", text: "Updated selected learning body." });
      expect(nuqsState.rsel).toBe(method === "PATCH" ? "memory:mutation-selected" : null);
      expect(screen.queryByRole("alert")).toBeNull();
      for (const invalidate of invalidators()) expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it.each(["PATCH", "DELETE"] as const)("preserves the memory and reports a %s network failure", async method => {
      memoryFetch.mockRejectedValue(new TypeError("Network request failed"));
      render(<LearningTab />);
      await screen.findByText("Original selected learning body.");
      await submitMemoryAction(method);
      expect((await screen.findByRole("alert")).textContent).toContain("Network request failed");
      expect(nuqsState.rsel).toBe("memory:mutation-selected");
      expect(screen.getByText("Original selected learning body.")).toBeTruthy();
      for (const invalidate of invalidators()) expect(invalidate).not.toHaveBeenCalled();
    });

    it("keeps a newer selection when an earlier successful delete finishes", async () => {
      let finish!: (response: Response) => void;
      memoryFetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
      render(<LearningTab />);
      await screen.findByText("Original selected learning body.");
      await submitMemoryAction("DELETE");
      expect(memoryFetch).toHaveBeenCalledTimes(1);
      nuqsState.rsel = "memory:neighbor-selected";
      await act(async () => { finish(new Response(null, { status: 204 })); });
      expect(nuqsState.rsel).toBe("memory:neighbor-selected");
      for (const invalidate of invalidators()) expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it.each(["PATCH", "DELETE"] as const)("cancels %s without a memory write or refresh", async method => {
      render(<LearningTab />);
      await screen.findByText("Original selected learning body.");
      await submitMemoryAction(method, true);
      expect(memoryFetch).not.toHaveBeenCalled();
      expect(nuqsState.rsel).toBe("memory:mutation-selected");
      for (const invalidate of invalidators()) expect(invalidate).not.toHaveBeenCalled();
    });
  });

  it("pins a deep-linked ?rsel selection into the detail aside on first render", () => {
    nuqsState.lview = "learnings";
    nuqsState.rsel = "memory:learning-8";
    retainFeedResult = {
      data: [
        {
          rows: Array.from({ length: 8 }, (_, index) => ({
            kind: "memory",
            id: `learning-${index + 1}`,
            title: `Learning ${index + 1}. Supporting detail.`,
            ts: "2026-08-15T12:00:00.000Z",
            status: null,
            shipped: false,
            meta: {},
          })),
          counts: null,
          nextCursor: null,
          degraded: [],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    retainDetailResult = {
      data: [
        {
          kind: "memory",
          id: "learning-8",
          title: "Learning 8. Supporting detail.",
          status: null,
          ts: "2026-08-15T12:00:00.000Z",
          body: "Learning 8 full body.",
          bodyTruncated: false,
          code: null,
          listItems: [],
          fields: [],
          editable: true,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByLabelText("Retained item detail")).toBeTruthy();
    expect(screen.getByText("Learning 8 full body.")).toBeTruthy();
    // The detail read asked for exactly the deep-linked row.
    expect(seenArgs["learning.retainDetail"]).toMatchObject({
      kind: "memory",
      id: "learning-8",
    });
  });

  it("filters retained rows through the ledger quick-search", () => {
    nuqsState.lview = "learnings";
    retainFeedResult = {
      data: [
        {
          rows: [
            {
              kind: "memory",
              id: "a",
              title: "Alpha memory.",
              ts: "2026-08-15T12:00:00.000Z",
              status: null,
              shipped: false,
              meta: {},
            },
            {
              kind: "memory",
              id: "b",
              title: "Beta memory.",
              ts: "2026-08-15T11:00:00.000Z",
              status: null,
              shipped: false,
              meta: {},
            },
          ],
          counts: null,
          nextCursor: null,
          degraded: [],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<LearningTab />);
    expect(screen.getByText("Alpha memory.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter retained items"), {
      target: { value: "beta" },
    });
    // The nuqs mock is not reactive — the write lands in nuqsState; re-render
    // to observe the filtered ledger (same dance as the older lretain tests).
    rerender(<LearningTab />);
    expect(screen.getByText("Beta memory.")).toBeTruthy();
    expect(screen.queryByText("Alpha memory.")).toBeNull();
  });

  it("threads rq/rtf into paired Retain reads and renders the exact companion count", () => {
    nuqsState.lview = "learnings";
    nuqsState.rq = "target";
    nuqsState.rtf = {
      title: "migration",
      status: ["done", "open"],
      lens: ["risk-first"],
    };
    retainFeedResult = {
      data: [
        {
          rows: [
            {
              kind: "wi",
              id: "WI-target",
              title: "Target migration",
              ts: "2026-08-15T12:00:00.000Z",
              status: "done",
              shipped: true,
              meta: { lens: "risk-first" },
            },
          ],
          counts: null,
          nextCursor: null,
          degraded: [],
          generatedAt: "2026-08-16T00:00:00.000Z",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    retainSummaryResult = {
      data: [
        {
          total: 10,
          matched: 1,
          facets: [
            {
              key: "status",
              values: [
                { value: "done", count: 4 },
                { value: "open", count: 6 },
              ],
              hiddenValueCount: 0,
              distinctCount: 2,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };

    render(<LearningTab />);

    const expected = {
      // `filter` is deliberately absent: P-001/P-002 removed the
      // Shipped/In-flight retain filter entirely, so the query no longer
      // carries that arg.
      tab: "all",
      q: "target",
      filters: {
        title: "migration",
        statuses: ["done", "open"],
        lenses: ["risk-first"],
      },
      hive: "alpha-hive",
    };
    expect(seenArgs["learning.retainFeed"]).toEqual(expected);
    expect(seenArgs["learning.retainFeed.summary"]).toEqual(expected);
    expect(
      screen.getByLabelText(
        /1 of 10 match in the complete selected Retain corpus/i,
      ),
    ).toBeTruthy();
  });

  // WI-39535: the Memories tab is a first-class kind tab on the unified ledger
  // — selecting it narrows SERVER-side (the tab arg) rather than client-side.
  it("the Memories tab narrows the feed server-side and badges the corpus size", () => {
    nuqsState.lview = "learnings";
    // WI-39900: badges ride learning.retainCounts, their own read — the feed
    // page carries counts: null by default and the badge must not need it.
    retainCountsResult = {
      data: [
        { memories: 42, plans: 1, wi: 2, rubrics: 3, runbooks: 4, recipes: 5 },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<LearningTab />);
    const memoriesTab = screen.getByRole("tab", { name: /Memories/ });
    expect(memoriesTab.textContent).toContain("42");
    fireEvent.click(memoriesTab);
    expect(nuqsState.rtab).toBe("memories");
    rerender(<LearningTab />);
    expect(seenArgs["learning.retainFeed"]).toMatchObject({
      tab: "memories",
    });
  });

  it("gates hive-aware queries until the inherited scope is resolved (WI-5412 first-fetch perf)", () => {
    // scope not ready (projects list still loading) → the heavy improvements
    // read must not fire with a half-resolved lens.
    advScopeState.ready = false;
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toBeUndefined();
  });
});

// P-009 (learning-tab-first-run-ux-plan, owner-reviewed 2026-07-26): the
// once-per-workspace orientation banner, its arming deep-link, and the visible
// view gloss (strap).
describe("LearningTab — P-009 first-run orientation", () => {
  it("shows the banner on first run; dismissal persists (once per workspace)", () => {
    render(<LearningTab />);
    expect(screen.getByText(/learns as you work/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/learns as you work/)).toBeNull();
    expect(
      window.localStorage.getItem("pc-learning-orientation-dismissed"),
    ).toBe("1");
    cleanup();
    // A remount (same workspace) must NOT re-show it.
    render(<LearningTab />);
    expect(screen.queryByText(/learns as you work/)).toBeNull();
  });

  it("the banner's Open Arming opens the every-pot scope picker (P-009)", () => {
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Open Arming" }));
    expect(nuqsState.lpick).toBe(true);
    // The old destination was the routine SCHEDULE list, not an arming surface.
    expect(nuqsState.tab).not.toBe(ARMING_WORKFLOWS_TAB);
    expect(nuqsState.wfKind).not.toBe(ARMING_WORKFLOWS_KIND);
    expect(nuqsState.wfView).toBeNull();
    expect(nuqsState.wfFilter).toBeNull();
  });

  /**
   * P-012 REGRESSION GUARD, and it is named because its natural failure is
   * ANONYMOUS. The drawer's open state is a pot SLUG (`lpot`), not a boolean,
   * so "closed" is the empty string — and a `potSlug !== ""` check reads an
   * UNSET key (null here, because this file's nuqs mock returns the raw bag
   * value and ignores `withDefault`) as OPEN. The drawer is a Radix modal over
   * the whole tab, so the symptom is not "a drawer is stuck": it is 29 tests in
   * this file failing with "unable to find an accessible element" for tabs and
   * buttons that are present and merely behind an aria-modal. Measured: that is
   * exactly what happened on the first run of this change. This asserts the
   * cheap, legible version of that signal.
   */
  it("does not open the per-pot drawer when lpot is unset (P-012)", () => {
    expect(nuqsState.lpot).toBeNull();
    render(<LearningTab />);
    expect(document.querySelector(".pc-potdraw")).toBeNull();
    // The tab chrome must still be reachable — this is what a stray modal eats.
    expect(screen.getByRole("tab", { name: "Improve" })).toBeTruthy();
  });

  it("renders the visible view gloss for the active view (same source as the tab tooltips)", () => {
    render(<LearningTab />);
    const strap = document.querySelector(".pc-learning__strap");
    expect(strap?.textContent).toContain("What the learning loop produced");
  });
});

/**
 * Owner escalation 2026-07-26 (~20 reports of "no recent gym runs"): the runs
 * list is newest-first at the top of a scrolling pane and the judge cards are
 * below it, so scrolling to read a card pushes every recent run off-screen and
 * the list appears to start hours ago. The runs header is therefore STICKY and
 * carries the newest run's age, so recency is legible at any scroll position.
 */
describe("GymView — recent-challengers header carries recency", () => {
  // As above: the Gym rides FLAGS.TESTING (WI-6315).
  beforeEach(() => {
    setTestingFlag(true);
  });
  afterEach(() => {
    setTestingFlag(false);
  });

  it("stamps the newest run age + count into a sticky header", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    gymResult = {
      data: [
        {
          proposals: [],
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-newest",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 3 * 3600_000,
              finishedAt: now - 2 * 3600_000, // newest
              decision: null,
              isBaseline: false,
            },
            {
              harnessSlug: "papercusp",
              variantId: "cand-older",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 10 * 3600_000,
              finishedAt: now - 9 * 3600_000,
              decision: null,
              isBaseline: false,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);

    const head = document.querySelector(
      ".pc-learning__sectionhead--stickyruns",
    );
    expect(head).toBeTruthy(); // the header must be the sticky variant
    const recency = head?.querySelector(".pc-learning__runsrecency");
    expect(recency).toBeTruthy();
    // Derived from the NEWEST run (2h), never the oldest (9h), and states the count.
    expect(recency?.textContent).toContain("2h");
    expect(recency?.textContent).not.toContain("9h");
    expect(recency?.textContent).toContain("2 listed");
  });

  /**
   * Owner ask 2026-07-27 ("why isn't RECENT CHALLENGERS just cards like the other
   * section?"): the compact lines duplicated the proposal cards (measured 15 of 17
   * overlapping) because WI-5696's promised dedupe was never written, and the cards
   * were a 1-of-N carousel so the lines were silently doing overview duty. Now each
   * challenger is ONE grid card carrying both halves, and a line renders only for an
   * execution with no proposal.
   */
  it("groups challenger cards by role (collapsible), groups newest-first, cards newest-first inside", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    const mkProp = (
      id: string,
      variantId: string,
      createdAt: number,
      role = "worker",
    ) => ({
      id,
      variantId,
      role,
      status: "rejected",
      cycle: 1,
      createdAt,
      harnessSlug: "papercusp",
    });
    gymResult = {
      data: [
        {
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          proposals: [
            mkProp("p-old", "cand-old", now - 9 * 3600_000),
            mkProp("p-new", "cand-new", now - 1 * 3600_000),
            mkProp("p-mid", "cand-mid", now - 5 * 3600_000, "director"),
          ],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-new",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 2 * 3600_000,
              finishedAt: now - 1 * 3600_000,
              decision: null,
              isBaseline: false,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);

    // Grouped by role — the per-type stacks the CardStack decks used to give.
    const groups = document.querySelectorAll(".pc-learning__gymrolegroup");
    expect(groups).toHaveLength(2); // worker + director
    const groupLabels = [...groups].map(
      (g) => g.getAttribute("aria-label") ?? "",
    );
    // Groups ordered by the recency of their newest challenger: worker (1h) before
    // director (5h) — NOT by group size.
    expect(groupLabels[0]).toContain("worker");
    expect(groupLabels[1]).toContain("director");
    // Each group header carries its count + newest age, so a collapsed group still
    // tells you whether it is active.
    const head = groups[0]!.querySelector(".pc-learning__gymrolehead");
    expect(head?.textContent).toContain("worker");
    expect(head?.textContent).toContain("2"); // two worker challengers
    expect(head?.getAttribute("aria-expanded")).toBe("true"); // expanded by default

    const cards = document.querySelectorAll(".pc-learning__gymcard");
    expect(cards).toHaveLength(3); // every challenger visible at once (no 1-of-N)
    // Newest-first WITHIN the worker group: p-new (1h) before p-old (9h).
    const workerCards = groups[0]!.querySelectorAll(".pc-learning__gymcard");
    expect(workerCards[0]!.getAttribute("aria-label")).toContain("cand-new");
    expect(workerCards[1]!.getAttribute("aria-label")).toContain("cand-old");
    // The matching run group's execution facts are folded into the card…
    expect(workerCards[0]!.textContent).toContain("3 runs");
    expect(workerCards[0]!.textContent).toContain("escalated");
    // …and that run no longer ALSO renders a duplicate compact line.
    expect(document.querySelector(".pc-learning__gymcycles")).toBeNull();
  });

  it("keeps a compact line ONLY for an execution with no proposal (the baseline)", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    gymResult = {
      data: [
        {
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          proposals: [
            {
              id: "p1",
              variantId: "cand-carded",
              role: "worker",
              status: "accepted",
              cycle: 1,
              createdAt: now - 3600_000,
              harnessSlug: "papercusp",
            },
          ],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-carded",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 2 * 3600_000,
              finishedAt: now - 3600_000,
              decision: "accept",
              isBaseline: false,
            },
            {
              harnessSlug: "papercusp",
              variantId: "baseline",
              cycle: 0,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 4 * 3600_000,
              finishedAt: now - 3 * 3600_000,
              decision: null,
              isBaseline: true,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);

    expect(document.querySelectorAll(".pc-learning__gymcard")).toHaveLength(1);
    const lines = document.querySelector(".pc-learning__gymcycles");
    expect(lines).toBeTruthy(); // the baseline has no card, so it keeps its line
    expect(lines!.children).toHaveLength(1);
    expect(lines!.textContent).toContain("baseline");
    expect(lines!.textContent).not.toContain("cand-carded"); // no duplicate
  });

  it("omits the recency chip when there are no runs (no bogus 'newest')", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    gymResult = {
      data: [
        {
          proposals: [{ id: "p1", status: "pending", role: "worker" }],
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          runs: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(document.querySelector(".pc-learning__runsrecency")).toBeNull();
  });
});
