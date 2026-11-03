// @vitest-environment jsdom
/**
 * Tests for perf-marks.ts — the page-relative interaction-timing substrate
 * (desktop-performance-suite-2026-07-20 P-001 / P-003).
 *
 * Uses the real User Timing API available in the jsdom/Node test env. Marks +
 * measures are process-global, so each test clears them first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERF_INTERACTIONS,
  STALE_START_MS,
  beginInteraction,
  endInteraction,
  endStartupUsable,
  getLatestMeasure,
  clearInteraction,
  markInteractionPhase,
} from "./perf-marks";
import { DESKTOP_PERF_BUDGETS } from "@papercusp/operator-core/lib/system-health/desktop-perf-budgets";

const NAME = PERF_INTERACTIONS.planPopupOpen;
const START = `${NAME}:start`;

function resetTimeline(): void {
  performance.clearMarks?.();
  performance.clearMeasures?.();
}

beforeEach(resetTimeline);
afterEach(() => {
  vi.restoreAllMocks();
  resetTimeline();
});

describe("PERF_INTERACTIONS registry", () => {
  it("names the plan-popup-open interaction", () => {
    expect(PERF_INTERACTIONS.planPopupOpen).toBe("plan-popup-open");
  });

  it("names the P-013 Inbox bulk-report interaction", () => {
    expect(PERF_INTERACTIONS.inboxBulkReportOpen).toBe(
      "inbox-bulk-report-open",
    );
  });

  it("names the P-006 broadened interactions with stable kebab values", () => {
    // These string values are the contract between the emitting hooks
    // (begin/endInteraction call sites) and DESKTOP_PERF_BUDGETS.interactions
    // keys + the desktopPerformanceChecks measure keys. Pinned so a rename can't
    // silently sever the wiring.
    expect(PERF_INTERACTIONS.commandPaletteOpen).toBe("command-palette-open");
    expect(PERF_INTERACTIONS.conversationThreadLoad).toBe(
      "conversation-thread-load",
    );
    expect(PERF_INTERACTIONS.harnessDockOpen).toBe("harness-dock-open");
    expect(PERF_INTERACTIONS.reportMarkdownFirstMount).toBe("report-markdown-first-mount");
    expect(PERF_INTERACTIONS.reportMarkdownInputDelay).toBe("report-markdown-input-delay");
  });

  it("every registered interaction has a DESKTOP_PERF_BUDGETS entry (no unbudgeted instrumentation)", () => {
    for (const name of Object.values(PERF_INTERACTIONS)) {
      expect(
        DESKTOP_PERF_BUDGETS.interactions[name],
        `PERF_INTERACTIONS.${name} is instrumented but has no budget in DESKTOP_PERF_BUDGETS.interactions`,
      ).toBeTypeOf("number");
    }
  });

  it("every P-006 interaction begins + ends like plan-popup-open (shared substrate)", () => {
    for (const name of [
      PERF_INTERACTIONS.commandPaletteOpen,
      PERF_INTERACTIONS.conversationThreadLoad,
      PERF_INTERACTIONS.harnessDockOpen,
      PERF_INTERACTIONS.reportMarkdownFirstMount,
      PERF_INTERACTIONS.reportMarkdownInputDelay,
    ]) {
      resetTimeline();
      // no-op unless a matching begin ran — safe on shared render paths
      expect(endInteraction(name)).toBeNull();
      beginInteraction(name);
      const d = endInteraction(name);
      expect(d).not.toBeNull();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(performance.getEntriesByName(name, "measure")).toHaveLength(1);
    }
  });
});

describe('native startup to usable content', () => {
  let measure: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.defineProperty(window, '__papercuspStartupOrigin', { configurable: true,
      value: { startedAtEpochMs: 8000, pid: 42, primaryWindow: true } });
    window.__papercuspServerConnectionRestored = true;
    delete window.__papercuspServerConnectionRequired;
    delete window.__papercuspBootError;
    measure = vi.fn();
    vi.stubGlobal('performance', { timeOrigin: 10000, now: () => 250,
      mark: vi.fn(), measure });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__papercuspStartupOrigin');
    delete window.__papercuspServerConnectionRestored;
    delete window.__papercuspServerConnectionRequired;
    delete window.__papercuspBootError;
    window.sessionStorage.clear();
  });

  it('includes native work before navigation and keeps real endpoints', () => {
    expect(endStartupUsable()).toBe(2250);
    expect(measure).toHaveBeenCalledWith('startup-usable', {
      start: 0, duration: 2250,
      detail: { startedAtEpochMs: 8000, endedAtEpochMs: 10250,
        pageTimeOrigin: 10000, pid: 42, primaryWindow: true,
        clock: 'native-entry-epoch', endpoint: 'overview-usable' },
    });
    expect(endStartupUsable()).toBeNull();
    // A new document can lose its timeline; the process latch survives.
    measure.mockClear();
    expect(endStartupUsable()).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it('does not report before attachment or while a boot error blocks input', () => {
    window.__papercuspServerConnectionRestored = false;
    expect(endStartupUsable()).toBeNull();
    window.__papercuspServerConnectionRestored = true;
    window.__papercuspBootError = 'connection lost';
    expect(endStartupUsable()).toBeNull();
    delete window.__papercuspBootError;
    window.__papercuspServerConnectionRequired = 'server unavailable';
    expect(endStartupUsable()).toBeNull();
    expect(measure).not.toHaveBeenCalled();
    delete window.__papercuspServerConnectionRequired;
    expect(endStartupUsable()).toBe(2250);
  });

  it('waits for removal of the blocking connection dialog after the flag changes', () => {
    const gate = document.createElement('p');
    gate.dataset.testid = 'server-connection-reason';
    document.body.append(gate);
    try {
      expect(endStartupUsable()).toBeNull();
      expect(measure).not.toHaveBeenCalled();
    } finally { gate.remove(); }
    expect(endStartupUsable()).toBe(2250);
  });

  it.each([
    undefined,
    { startedAtEpochMs: 10001, pid: 42, primaryWindow: true },
    { startedAtEpochMs: 0, pid: 42, primaryWindow: true },
    { startedAtEpochMs: NaN, pid: 42, primaryWindow: true },
    { startedAtEpochMs: 8000, pid: 0, primaryWindow: true },
    { startedAtEpochMs: 8000, pid: 42, primaryWindow: false },
  ])('keeps missing/invalid/non-primary origin unknown: %j', (origin) => {
    Object.defineProperty(window, '__papercuspStartupOrigin', { configurable: true, value: origin });
    expect(endStartupUsable()).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it('does not fall back to another clock when storage is unavailable', () => {
    // jsdom Storage is an exotic proxy: assigning/spying on a method can
    // create a storage entry instead of replacing the callable method.
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => window.sessionStorage).toThrow('blocked');
    expect(endStartupUsable()).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it('permits a retry after a failed User Timing write without recording a success', () => {
    measure.mockImplementationOnce(() => { throw new Error('User Timing unavailable'); });
    expect(endStartupUsable()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(endStartupUsable()).toBe(2250);
  });
});

describe('interaction phases', () => {
  it('does not let a late item response end or clear a different selection', () => {
    beginInteraction(PERF_INTERACTIONS.workItemOpen, 'alpha:WI-2');
    expect(endInteraction(PERF_INTERACTIONS.workItemOpen, 'alpha:WI-1')).toBeNull();
    clearInteraction(PERF_INTERACTIONS.workItemOpen, 'alpha:WI-1');
    expect(endInteraction(PERF_INTERACTIONS.workItemOpen, 'alpha:WI-2')).not.toBeNull();
    expect(endInteraction(PERF_INTERACTIONS.workItemOpen, 'alpha:WI-2')).toBeNull();
  });

  it('clears an aborted scoped journey without recording a success', () => {
    beginInteraction(PERF_INTERACTIONS.workItemClaim, 'alpha:WI-1:claim');
    clearInteraction(PERF_INTERACTIONS.workItemClaim, 'alpha:WI-1:claim');
    expect(endInteraction(PERF_INTERACTIONS.workItemClaim, 'alpha:WI-1:claim')).toBeNull();
    expect(getLatestMeasure(PERF_INTERACTIONS.workItemClaim)).toBeNull();
  });
  it('retains the original total start and records each phase only once', () => {
    beginInteraction(NAME);
    const start = performance.getEntriesByName(START)[0]!.startTime;
    expect(markInteractionPhase(NAME, 'content-ready')).toBeGreaterThanOrEqual(0);
    markInteractionPhase(NAME, 'content-ready');
    const phases = performance.getEntriesByName(`${NAME}:phase:content-ready`);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.startTime).toBe(start);
    expect(endInteraction(NAME)).not.toBeNull();
    expect(performance.getEntriesByName(NAME)[0]!.startTime).toBe(start);
    expect(markInteractionPhase(NAME, 'after-end')).toBeNull();
  });

  it('does not credit cancelled, stale, or unrelated renders and clears old phases on reopen', () => {
    expect(markInteractionPhase(NAME, 'content-ready')).toBeNull();
    beginInteraction(NAME);
    markInteractionPhase(NAME, 'content-ready');
    clearInteraction(NAME);
    expect(markInteractionPhase(NAME, 'renderer-ready')).toBeNull();
    beginInteraction(NAME);
    expect(performance.getEntriesByName(`${NAME}:phase:content-ready`)).toHaveLength(0);
    const start = performance.getEntriesByName(START)[0]!;
    vi.spyOn(performance, 'now').mockReturnValue(start.startTime + STALE_START_MS + 1);
    expect(markInteractionPhase(NAME, 'content-ready')).toBeNull();
  });
});

describe("begin/endInteraction", () => {
  it("measures a non-negative duration and emits a synchronously-readable measure entry", () => {
    beginInteraction(NAME);
    const d = endInteraction(NAME);
    expect(d).not.toBeNull();
    expect(d).toBeGreaterThanOrEqual(0);
    // The measure entry is what the packaged-binary wdio runner reads.
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(1);
    expect(getLatestMeasure(NAME)).toBe(d);
  });

  it("is a no-op (null, no measure) with no prior begin — safe to call on a shared render path", () => {
    const d = endInteraction(NAME);
    expect(d).toBeNull();
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(0);
  });

  it("consumes the start mark (measure-once): a second end returns null and adds no measure", () => {
    beginInteraction(NAME);
    expect(endInteraction(NAME)).not.toBeNull();
    expect(endInteraction(NAME)).toBeNull();
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(1);
    expect(performance.getEntriesByName(START, "mark")).toHaveLength(0);
  });

  it("discards a stale start (a begin whose end never came within STALE_START_MS)", () => {
    beginInteraction(NAME);
    const start = performance.getEntriesByName(START, "mark")[0]!;
    vi.spyOn(performance, "now").mockReturnValue(
      start.startTime + STALE_START_MS + 1,
    );
    const d = endInteraction(NAME);
    expect(d).toBeNull();
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(0);
    // the stale start is cleared so it can't poison a later render
    expect(performance.getEntriesByName(START, "mark")).toHaveLength(0);
  });

  it("a fresh begin replaces a prior unconsumed start (exactly one measure on end)", () => {
    beginInteraction(NAME);
    beginInteraction(NAME);
    expect(performance.getEntriesByName(START, "mark")).toHaveLength(1);
    expect(endInteraction(NAME)).not.toBeNull();
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(1);
  });

  it("clearInteraction drops a pending start so a later end is a no-op", () => {
    beginInteraction(NAME);
    clearInteraction(NAME);
    expect(endInteraction(NAME)).toBeNull();
    expect(performance.getEntriesByName(NAME, "measure")).toHaveLength(0);
  });
});

describe("getLatestMeasure", () => {
  it("returns null before any measure and the last duration after", () => {
    expect(getLatestMeasure(NAME)).toBeNull();
    beginInteraction(NAME);
    const d = endInteraction(NAME);
    expect(getLatestMeasure(NAME)).toBe(d);
  });
});
