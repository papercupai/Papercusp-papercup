/**
 * Packaged-binary interaction-perf spec — the BROADER real interactions
 * (desktop-performance-suite-2026-07-20 P-006), the fresh-harness half of the
 * in-app `desktopPerformanceChecks` interaction budgets. Each drives a REAL
 * interaction in a FRESH packaged binary and asserts the page-relative
 * `performance.measure` the perf-marks hooks emit (read via
 * performance.getEntriesByName — page-relative, immune to the eval-clock
 * confound EI-18128922194224210), against the interaction's budget.
 *
 * Covered here (the cleanly driver-triggerable ones):
 *   - command-palette-open     : ?palette=true → the lazy cmdk chunk mounts.
 *   - harness-dock-open        : /adv dock mount → dockview API bind (hydration);
 *                                emitted once on mount, so we read the latest.
 *   - conversation-thread-load : /adv Harnesses dock (WI-6543 P-022 fixture path,
 *                                2026-08-02) → click a work-item row → the Detail
 *                                pane's "Chat" button (`wi-detail-chat`, EI-290)
 *                                creates a REAL agent_chats row and the dock drain
 *                                mounts <ChatPanel>, which fires
 *                                beginInteraction/endInteraction(conversationThreadLoad)
 *                                (ChatPanel.tsx:168/171) when the transcript first
 *                                renders. No pre-seeded fixture id needed — the
 *                                harness's OWN live work items supply the row, the
 *                                same "click a real row" pattern plan-popup-open
 *                                uses.
 *   - learning-view-switch      : /adv Learning tab Observe stage → click the
 *                                real Observations view trigger and read the
 *                                page-relative learning-view-switch measure.
 *
 * inbox-list-settle was RETIRED (EI-18854256403211741 / WI-6543, 2026-08-02):
 * it drove the op-chat sidebar Inbox face, which was retired 2026-07-26
 * (hud-consolidation-2026-07-26 D-001, `_retired/inbox-pane/`). The HUD board
 * that replaced it has no comparable virtualized-list-filter interaction (a
 * Kanban board with a plain text-filter input, not a re-scoped virtualized
 * list), so the honest fix was to delete the check + its budget rather than
 * invent an instrumentation target nothing actually exercises. See
 * PERF_INTERACTIONS in perf-marks.ts for the still-live interaction set.
 *
 * Budgets MIRROR DESKTOP_PERF_BUDGETS.interactions
 * (packages/operator-core/lib/system-health/desktop-perf-budgets.ts). This runner
 * is deliberately OUT of the npm workspace (see ../README.md) so it cannot import
 * the canonical constants — keep the two in sync when a budget changes.
 *
 * Prereqs (../README.md): a built desktop binary, tauri-driver, WebKitWebDriver.
 * Run: `npm run test:all` from tools/perf-test/wdio (or `npm run perf:desktop` at root).
 */
import { browser } from "@wdio/globals";
import { recordInteractionMs } from "../perf-report";
import { isNonShellOperatorRoute, waitForAppMount, waitForPackagedAppUrl } from "../app-mount";
import { waitForMainThreadQuiet } from "../../../../libs/generic/gui-readiness/src/main-thread-quiet";

/**
 * The route that renders `AdvShell` — the shell every test in this file measures
 * against, and the route the packaged app boots into. Bare `/adv` on purpose:
 * each test appends the query it needs (`?palette=true`, `?tab=harnesses&...`),
 * so restoring a bare path is deterministic where restoring a captured boot URL
 * would carry one test's parameters into the next.
 */
const OPERATOR_SHELL_ROUTE = "/adv";
const FIXTURE_HARNESS = process.env.PAPERCUSP_PERF_HARNESS ?? 'papercusp';
const FIXTURE_ITEM = process.env.PAPERCUSP_PERF_WORK_ITEM;
if (!/^[\w-]+$/.test(FIXTURE_HARNESS) || (FIXTURE_ITEM && !/^[\w-]+$/.test(FIXTURE_ITEM))) {
  throw new Error('Invalid explicit performance fixture');
}

const COMMAND_PALETTE_OPEN_BUDGET_MS = 400;
const HARNESS_DOCK_OPEN_BUDGET_MS = 1500;
const CONVERSATION_THREAD_LOAD_BUDGET_MS = 1500;
const LEARNING_VIEW_SWITCH_BUDGET_MS = 1500;

/** Run the shared quiet primitive inside the packaged webview. */
async function waitForMainThreadQuietInPage(): Promise<void> {
  const result = (await browser.executeAsync(
    (source: string, done: (value: unknown) => void) => {
      try {
        const wait = globalThis.Function(`return (${source})`)() as () => Promise<unknown>;
        wait().then(done, (error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    },
    waitForMainThreadQuiet.toString(),
  )) as { ok?: boolean; elapsedMs?: number; error?: string };

  if (result?.ok !== true) {
    throw new Error(
      `main thread did not reach the D-003 quiet precondition${
        result?.error ? `: ${result.error}` : ''
      }${typeof result?.elapsedMs === 'number' ? ` after ${Math.round(result.elapsedMs)}ms` : ''}`,
    );
  }
}

/** Read the latest page-relative measure for a named interaction, or null. */
async function latestMeasure(name: string): Promise<number | null> {
  return browser.execute((n) => {
    const entries = performance.getEntriesByName(n, "measure");
    return entries.length
      ? Math.round(entries[entries.length - 1].duration)
      : null;
  }, name);
}

/**
 * Wait until the thin GUI has finished attaching to its Server. The shell and
 * route tree intentionally mount while connection recovery is still in
 * flight, so waitForAppMount alone is not a sufficient precondition for a
 * native click: ServerConnectionGate owns the hit target until Rust emits the
 * restored event. This wait is outside every interaction measure.
 */
async function waitForServerConnectionReady(): Promise<void> {
  const ready = await browser.waitUntil(
    async () =>
      await browser.execute(
        () =>
          !document.querySelector('[data-testid="server-connection-reason"]'),
      ),
    {
      timeout: 20_000,
      timeoutMsg: "Papercusp Server connection did not become ready within 20s",
    },
  ).then(() => true, () => false);

  if (ready) return;
  const snapshot = await browser.execute(() => {
    const w = window as Window & {
      __papercuspBootError?: string;
      __papercuspServerConnectionRequired?: string;
      __papercuspServerConnectionRestored?: boolean;
    };
    return {
      href: location.href,
      restored: w.__papercuspServerConnectionRestored ?? null,
      required: w.__papercuspServerConnectionRequired ?? null,
      bootError: w.__papercuspBootError ?? null,
      renderedReason:
        document
          .querySelector('[data-testid="server-connection-reason"]')
          ?.textContent?.trim() ?? null,
    };
  });
  throw new Error(
    "Papercusp Server connection did not become ready; " +
      `connection snapshot=${JSON.stringify(snapshot)}`,
  );
}

/**
 * The packaged shell hydrates the shared sync QueryClient from localStorage
 * before the first panel mounts. A normal rerun therefore exercises a warm
 * cache and can hide the first-fetch stage WI-5502 is diagnosing. Opt into a
 * genuinely cold run with PERF_COLD_SYNC=1: remove only the sync-cache entry
 * and reload the same app profile so module-eval hydration sees no snapshot.
 */
async function reloadWithoutPersistedSyncCache(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.removeItem("papercusp:sync-cache:v1");
    } catch {
      /* storage may be unavailable; the reload still gives a clean memory cache */
    }
    location.reload();
  });
  await waitForAppMount(browser);
}

/**
 * Focus a registered HarnessesDock panel even when the persisted layout does
 * not contain it. This mirrors requestDockPanelOpen without importing browser
 * application code into the out-of-workspace WDIO runner: the queue survives
 * the route's mount gap, while the event nudges an already-bound dock.
 */
async function requestHarnessPanel(type: string, title: string): Promise<void> {
  await browser.execute(
    (panelType, panelTitle) => {
      const w = window as Window & {
        __PAPERCUSP_PENDING_PANEL_OPENS__?: Array<{
          type: string;
          title?: string;
        }>;
      };
      const queue = (w.__PAPERCUSP_PENDING_PANEL_OPENS__ ??= []);
      if (!queue.some((request) => request.type === panelType)) {
        queue.push({ type: panelType, title: panelTitle });
      }
      window.dispatchEvent(
        new CustomEvent("papercusp:adv-open-dock-panel"),
      );
    },
    type,
    title,
  );
}

/**
 * SPA-navigate to a new path WITHOUT tearing down the WebDriver session.
 *
 * WHY NOT `history.pushState({}, "", path)` + a synthetic `popstate`
 * (WI-6543, verified live 2026-08-02 via tauri-agent-tools eval against the
 * running dev shell — not guessed from reading the test failure alone):
 *
 *   1. `history.pushState` is ALREADY MONKEY-PATCHED by TanStack Router
 *      (@tanstack/history's `createBrowserHistory`) to synchronously notify
 *      the router on every call (`onPushPop("PUSH")` → `history.notify(...)`).
 *      A plain `history.pushState(...)` call is therefore already a complete,
 *      correctly-classified PUSH navigation — no extra event needed.
 *   2. Dispatching a SYNTHETIC `PopStateEvent` on top of that is not a no-op:
 *      it fires the router's *separate* `popstate` listener
 *      (`onPushPopEvent`), which computes `delta = nextIndex - currentIndex`
 *      from `history.state[stateIndexKey]` to decide FORWARD/BACK/GO. Passing
 *      `{}` as the pushState `state` (as the old code did) means that index
 *      is `undefined` on both sides → `delta` is `NaN` → neither `isForward`
 *      nor `isBack` matches → the router misclassifies the navigation as a
 *      "GO" to an inconsistent history index and enters a slow recovery path.
 *   3. Measured impact: for a CROSS-ROUTE transition (/adv → /workbench) this
 *      added an unpredictable **10–40+ SECOND** stall before the new route's
 *      React tree actually rendered — comfortably eating the 20s budget this
 *      suite gives `harness-dock-open` to even RECORD a measure, independent
 *      of how fast the interaction under test actually is. (A SAME-route
 *      query-only change, as `command-palette-open` used, happened not to
 *      trip this — nuqs's own param read is unaffected by which router state
 *      the misclassified GO settles on — which is why that check kept
 *      passing while this one kept failing "no measure recorded".)
 *
 * The fix: call the (already-patched) `pushState` directly, preserve the
 * router's OWN state shape (`__TSR_index`/`__TSR_key`, not `{}`) so the
 * bookkeeping stays consistent even if something else later reads it, and
 * never dispatch a synthetic `popstate` for a navigation that was never a
 * real back/forward. Verified live: this took the /adv → /workbench
 * transition from 10–40s down to <1s.
 */
async function spaNavigate(path: string): Promise<void> {
  await browser.execute((p) => {
    const prevState = (window.history.state ?? {}) as Record<string, unknown>;
    const prevIndex =
      typeof prevState.__TSR_index === "number" ? prevState.__TSR_index : 0;
    history.pushState({ ...prevState, __TSR_index: prevIndex + 1 }, "", p);
  }, path);
}

describe("Packaged Papercusp desktop — broader real interactions (P-006)", () => {
  before(async () => {
    const workspace = process.env.PAPERCUSP_PERF_WORKSPACE_ID;
    if (!workspace) return;
    // Workspace hooks snapshot at mount; scope the measured document before
    // starting any of these interactions, as the plan/work drivers do.
    const url = new URL(await waitForPackagedAppUrl(browser));
    url.pathname = OPERATOR_SHELL_ROUTE;
    url.search = new URLSearchParams({ ws: workspace, slug: FIXTURE_HARNESS }).toString();
    url.hash = '';
    await browser.url(url.toString());
  });
  /**
   * Put every test back on the operator shell before it runs.
   *
   * Tests in this file SPA-navigate, and `harness-dock-open` deliberately ENDS on
   * `/workbench` — a route that mounts `HarnessDock` directly and never renders
   * `AdvShell` (apps/operator-vite/src/routes/workbench.tsx). Without this hook
   * the next test inherits that route and does two silently wrong things: it
   * waits for a shell marker that route cannot render, and it derives its target
   * URL from a `location.href` built on the wrong path.
   *
   * This is not defensive housekeeping — it is the fix for WI-38449. That
   * inheritance made `conversation-thread-load` time out on EVERY run from
   * 2026-08-02 to 2026-08-16. wdio then exited non-zero, the suite published no
   * measures, `harness_shared.desktop_perf_runs` went 13 days without a row, and
   * `DESKTOP_PERF_GATE` — whose freshness window is 24h — fail-soft PASSED every
   * deploy in that window while measuring nothing.
   *
   * Restored per-test (not at the end of the offending test) on purpose: a test
   * that fails its assertions never reaches its own cleanup, and the damage
   * would again be charged to the innocent test that runs next.
   *
   * Scoped to `isNonShellOperatorRoute` rather than "any path that is not /adv"
   * on purpose too. A blanket restore would also navigate away from a genuine
   * first-run/auth landing, hiding the exact false green `waitForAppMount` was
   * built to make impossible (EI-18889416741921988).
  */
  beforeEach(async () => {
    const current = await browser.execute(() => ({
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    }));
    const retainedPaletteWasOpen =
      new URLSearchParams(current.search).get("palette") === "true";
    if (isNonShellOperatorRoute(current.pathname)) {
      await spaNavigate(OPERATOR_SHELL_ROUTE);
    } else if (
      current.pathname === OPERATOR_SHELL_ROUTE &&
      (current.search || current.hash)
    ) {
      // Query-driven interactions are real app state too. In particular,
      // command-palette-open leaves ?palette=true behind; carrying that modal
      // into Learning intercepts the next user's click even though both tests
      // happen to share /adv. Restore the documented bare-shell baseline.
      await spaNavigate(OPERATOR_SHELL_ROUTE);
    }

    // The palette is a controlled Radix dialog, so clearing ?palette=true and
    // waiting for the router PUSH is not itself proof that the overlay has
    // consumed its close transition. Exercise the same Escape path a user does
    // and wait until BOTH URL state and the open dialog are gone before handing
    // the webview to the next interaction. Without this, the palette retained
    // focus and intercepted Learning's native Observations click even though
    // location.search was already bare.
    if (retainedPaletteWasOpen) {
      await browser.keys(["Escape"]);
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const palette = document.querySelector<HTMLElement>(
              '[aria-label="Command palette"]',
            );
            return (
              new URLSearchParams(location.search).get("palette") !== "true" &&
              palette?.getAttribute("data-state") !== "open"
            );
          }),
        {
          timeout: 5_000,
          timeoutMsg:
            "retained command palette did not close after Escape within 5s",
        },
      );
    }
  });

  it("opens the global command palette within budget", async () => {
    const NAME = "command-palette-open";
    await waitForAppMount(browser);
    // Measure the INTERACTION, not the app boot — see waitForMainThreadQuiet.
    await waitForMainThreadQuietInPage();

    // Clear any stale measure, then open the palette via its deep-link. The
    // open transition begins the interaction; the lazy cmdk chunk mount ends it.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
    }, NAME);
    const paletteUrl = await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("palette", "true");
      return u.pathname + u.search + u.hash;
    });
    // SPA-navigate — see spaNavigate's doc comment for why NOT pushState+popstate.
    await spaNavigate(paletteUrl);

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      { timeout: 8_000, timeoutMsg: `no "${NAME}" measure within 8s of open` },
    );

    const measuredMs = await latestMeasure(NAME);
    // Record BEFORE the asserts — `expect` throws on a breach, and a breach is
    // exactly the observation the release gate exists to catch.
    recordInteractionMs(NAME, measuredMs, COMMAND_PALETTE_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      COMMAND_PALETTE_OPEN_BUDGET_MS,
    );
  });

  it("switches Learning views within budget", async () => {
    const NAME = "learning-view-switch";
    await waitForAppMount(browser);

    // Cold-sync diagnosis is opt-in so ordinary release runs retain their
    // stable warm-cache acceptance semantics. Reload happens before the route
    // transition, allowing RootSyncProvider's module-eval restore to observe
    // the removed snapshot rather than a cache already hydrated in memory.
    if (process.env.PERF_COLD_SYNC === "1") {
      await reloadWithoutPersistedSyncCache();
    }

    // Start on the Observe stage so the real Observations tab is visible. The
    // first LearningTab mount is intentionally excluded from this interaction;
    // the click below is the measured view change (P-006).
    const learningUrl = await browser.execute((harness: string) => {
      const u = new URL(location.href);
      u.pathname = "/adv";
      u.searchParams.set("tab", "learning");
      u.searchParams.set("lview", "signals");
      u.searchParams.set("slug", harness);
      u.searchParams.set("scope", "self");
      u.searchParams.set("welcome", "0");
      return u.pathname + u.search + u.hash;
    }, FIXTURE_HARNESS);
    await spaNavigate(learningUrl);
    await waitForAppMount(browser);
    await waitForServerConnectionReady();

    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => Boolean(document.querySelector('button[aria-label="Observations"]')),
        ),
      {
        timeout: 15_000,
        timeoutMsg: 'no Learning Observations view trigger within 15s',
      },
    );
    await waitForMainThreadQuietInPage();

    // The page-local sync ledger records queue, resolver, transfer, and parse
    // time independently from the interaction measure below.  Snapshot its
    // cursor immediately before the click so a cold-budget failure identifies
    // the stage that was actually slow instead of blaming the companion SQL by
    // inference (WI-5502).
    const syncQueryCursor = await browser.execute(() => {
      const metrics = (
        window as Window & {
          __sync_metrics__?: { queries?: () => unknown[] };
        }
      ).__sync_metrics__;
      return metrics?.queries?.().length ?? 0;
    });

    // Clear any stale measure immediately before the real view-switch click.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
    }, NAME);

    // Close any layer that survived the route transition only after the
    // Learning body is mounted, then prove the native WebDriver click will
    // actually land on Observations. `isClickable()` was not enough here:
    // WebKit reported the button enabled and in-view while a retained overlay
    // still won hit-testing at its centre.
    await browser.keys(["Escape"]);
    const observationsHitTarget = await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const trigger = document.querySelector<HTMLElement>(
            'button[aria-label="Observations"]',
          );
          if (!trigger) return false;
          const rect = trigger.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return Boolean(hit && (hit === trigger || trigger.contains(hit)));
        }),
      {
        timeout: 5_000,
        timeoutMsg:
          "Learning Observations trigger remained covered after Escape",
      },
    ).then(() => true, () => false);

    if (!observationsHitTarget) {
      const snapshot = await browser.execute(() => {
        const trigger = document.querySelector<HTMLElement>(
          'button[aria-label="Observations"]',
        );
        const rect = trigger?.getBoundingClientRect();
        const stack = rect
          ? document.elementsFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            )
          : [];
        return {
          href: location.href,
          paletteQuery: new URLSearchParams(location.search).get("palette"),
          triggerRect: rect
            ? {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            : null,
          hitStack: stack.slice(0, 8).map((node) => {
            const el = node as HTMLElement;
            const style = getComputedStyle(el);
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              className: typeof el.className === "string" ? el.className : null,
              role: el.getAttribute("role"),
              ariaLabel: el.getAttribute("aria-label"),
              dataState: el.getAttribute("data-state"),
              pointerEvents: style.pointerEvents,
              zIndex: style.zIndex,
            };
          }),
          openLayers: Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-state="open"], [role="dialog"], [role="alertdialog"]',
            ),
          ).slice(0, 12).map((el) => ({
            tag: el.tagName.toLowerCase(),
            className: el.className,
            role: el.getAttribute("role"),
            ariaLabel: el.getAttribute("aria-label"),
            dataState: el.getAttribute("data-state"),
          })),
        };
      });
      throw new Error(
        "Learning Observations trigger remained covered after Escape; " +
          `hit-test snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    // Use WebDriver's native click path: this spec promises a REAL user
    // interaction, and it also surfaces an overlay/interception regression
    // that HTMLElement.click() would bypass.
    await browser.$('button[aria-label="Observations"]').click();

    const measured = await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      {
        timeout: 20_000,
        timeoutMsg: `no "${NAME}" measure emitted within 20s of switching views`,
      },
    ).then(() => true, () => false);

    if (!measured) {
      const snapshot = await browser.execute((name) => {
        const trigger = document.querySelector<HTMLElement>(
          'button[aria-label="Observations"]',
        );
        const selected = document.querySelector<HTMLElement>(
          ".pc-learning__view-tab[aria-selected=\"true\"]",
        );
        const pane = document.querySelector<HTMLElement>(
          '.pc-learning__viewpane[data-view="observations"]',
        );
        const starts = performance.getEntriesByName(`${name}:start`, "mark");
        const start = starts[starts.length - 1];
        return {
          href: location.href,
          triggerPresent: Boolean(trigger),
          triggerSelected: trigger?.getAttribute("aria-selected") ?? null,
          selectedView: selected?.getAttribute("data-value") ??
            selected?.getAttribute("value") ??
            selected?.getAttribute("aria-label") ??
            null,
          observationsPanePresent: Boolean(pane),
          observationsPaneHidden: pane?.hidden ?? null,
          observationsCount:
            pane?.querySelector('[data-testid="observations-count"]')
              ?.textContent?.trim() ?? null,
          observationsText: (pane?.textContent ?? "").trim().slice(0, 240),
          startMarkPresent: Boolean(start),
          startMarkAgeMs: start ? Math.round(performance.now() - start.startTime) : null,
          measureCount: performance.getEntriesByName(name, "measure").length,
        };
      }, NAME);
      throw new Error(
        `no "${NAME}" measure emitted within 20s of switching views; ` +
          `learning snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    const measuredMs = await latestMeasure(NAME);
    const learningQueryTimings = await browser.execute((cursor) => {
      type SyncQueryTiming = {
        name?: string;
        waitMs?: number;
        requestMs?: number;
        bytes?: number;
        outcome?: string;
        traceId?: string;
        stages?: {
          schedulerWaitMs?: number;
          resolverMs?: number;
          transferMs?: number;
          parseCacheMs?: number;
        };
      };
      const metrics = (
        window as Window & {
          __sync_metrics__?: { queries?: () => SyncQueryTiming[] };
        }
      ).__sync_metrics__;
      return (metrics?.queries?.() ?? [])
        .slice(cursor)
        .filter(
          (event) =>
            event.name === "learning.observations" ||
            event.name === "learning.observations.summary",
        );
    }, syncQueryCursor);
    console.log(
      `[perf-sync] ${NAME} queries=${JSON.stringify(learningQueryTimings)}`,
    );
    recordInteractionMs(NAME, measuredMs, LEARNING_VIEW_SWITCH_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    if ((measuredMs as number) > LEARNING_VIEW_SWITCH_BUDGET_MS) {
      throw new Error(
        `${NAME} took ${measuredMs}ms (budget ${LEARNING_VIEW_SWITCH_BUDGET_MS}ms); ` +
          `sync queries=${JSON.stringify(learningQueryTimings)}`,
      );
    }
    expect(measuredMs as number).toBeLessThanOrEqual(
      LEARNING_VIEW_SWITCH_BUDGET_MS,
    );
  });

  it("hydrates the harness dock within budget", async () => {
    const NAME = "harness-dock-open";
    await waitForAppMount(browser);
    await waitForMainThreadQuietInPage();

    // The dock emits harness-dock-open on mount → API bind. Navigate to a route
    // that ACTUALLY MOUNTS HarnessDock, then read the recorded measure.
    //
    // WHY NOT /adv (perf-testing-sweep-2026-07-27, P-022 — measured): this test
    // used to settle for "any /adv URL", but /adv is a tab shell and only some of
    // its sub-routes mount the dock (AdvCreateDock, AdvGitDock, HarnessesDock).
    // The bare /adv landing lands on the HUD tab, which mounts no dock at all, so
    // beginInteraction/endInteraction in HarnessDock.tsx never ran and the check
    // died on "no measure recorded within 20s" — read as broken instrumentation
    // when the instrumentation was fine and the TARGET was wrong. /workbench
    // mounts <HarnessDock layoutName="workbench" slug={harness}/> unconditionally
    // (apps/operator-vite/src/routes/workbench.tsx), so it is the honest target.
    // NB: SPA-navigate via spaNavigate() (pushState only) — NOT
    // pushState+popstate, and NOT location.assign(). A full document reload
    // inside the Tauri webview tears down the WebDriver session mid-test
    // ("Could not parse script result" then "invalid session id"), so the
    // measure could never be read back even when the dock did mount. The
    // synthetic popstate this used to also dispatch is worse than redundant —
    // see spaNavigate's doc comment: it desyncs TanStack Router's history
    // index and stalls the ACTUAL route transition 10-40+s, well past this
    // test's whole budget, independent of the dock itself (WI-6543).
    //
    // Deliberately NOT `await waitForAppMount(browser)` after this navigate:
    // that helper's mount marker is `.pc-advshell`/`[data-testid="operator-
    // shell"]` (AdvShell, the /adv shell) — /workbench never renders it (see
    // apps/operator-vite/src/routes/workbench.tsx), so that call can only
    // ever time out here. The `latestMeasure` wait below is this route's own,
    // honest readiness check.
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
    }, NAME);
    await spaNavigate('/workbench?harness=' + encodeURIComponent(FIXTURE_HARNESS));

    await browser.waitUntil(async () => (await latestMeasure(NAME)) !== null, {
      timeout: 20_000,
      timeoutMsg: `no "${NAME}" measure recorded within 20s of the dock route`,
    });

    const measuredMs = await latestMeasure(NAME);
    // Record BEFORE the asserts — see the note in the palette test above.
    recordInteractionMs(NAME, measuredMs, HARNESS_DOCK_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      HARNESS_DOCK_OPEN_BUDGET_MS,
    );
  });

  it("loads a conversation thread within budget when opened from a work item", async () => {
    const NAME = "conversation-thread-load";
    await waitForAppMount(browser);

    // Navigate to the /adv Harnesses dock — the seeded Work-items-over-Detail
    // split (WorkItemsPanel + DetailPanel). Same route the Playwright e2e
    // (apps/operator/e2e/adv-work-item-detail-chat.spec.ts) drives; here against
    // the REAL papercusp harness rather than a stubbed slug, so we discover a
    // row instead of deep-linking a fixed id. SPA-navigate via spaNavigate() —
    // location.assign() tears down the WebDriver session (see the note above),
    // and pushState+popstate stalls a cross-route transition 10-40+s (see
    // spaNavigate's doc comment, WI-6543).
    // Enter the Work tab first and wait for its ACTUAL body before adding the
    // slug. Applying ?slug= on the same turn as AdvShell's first registry
    // restore races that restore; the later write can legitimately replace
    // the unverified deep link with its persisted selection, leaving no dock
    // for the panel request to target. Do not gate on an ENABLED project
    // selector: a packaged session can render the real Work body before
    // harnessProjects.lite has populated, and HarnessesWorkspace deliberately
    // falls back to the explicit raw slug during that loading window.
    await spaNavigate("/adv?tab=harnesses");
    await waitForAppMount(browser);

    // waitForAppMount proves the long-lived AdvShell is present; it says
    // nothing about whether TanStack has replaced the PREVIOUS tab body. Wait
    // for the selected Work trigger AND HarnessesWorkspace itself so a later
    // selector failure is correctly attributed to the registry, not to a tab
    // navigation that never committed.
    const workBodyReady = await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const trigger = document.querySelector<HTMLElement>(
            ".pc-advshell__tab--harnesses",
          );
          return Boolean(
            trigger?.getAttribute("data-state") === "active" &&
              document.querySelector(
                ".pc-advshell__tabbody .pc-adv-harnesses",
              ),
          );
        }),
      {
        timeout: 20_000,
        timeoutMsg: "Work tab body did not render within 20s",
      },
    ).then(() => true, () => false);

    if (!workBodyReady) {
      const snapshot = await browser.execute(() => ({
        href: location.href,
        activeTabs: Array.from(
          document.querySelectorAll<HTMLElement>(
            '.pc-advshell__tab[data-state="active"]',
          ),
        ).map((tab) => ({
          className: tab.className,
          label: (tab.textContent ?? "").trim(),
        })),
        workTabState:
          document
            .querySelector<HTMLElement>(".pc-advshell__tab--harnesses")
            ?.getAttribute("data-state") ?? null,
        workBodyPresent: Boolean(
          document.querySelector(
            ".pc-advshell__tabbody .pc-adv-harnesses",
          ),
        ),
        tabBodyClasses: Array.from(
          document.querySelector<HTMLElement>(".pc-advshell__tabbody")
            ?.firstElementChild?.children ?? [],
        ).map((node) => (node as HTMLElement).className),
        tabError:
          document.querySelector<HTMLElement>('[data-testid="adv-tab-error"]')
            ?.textContent?.trim() ?? null,
        tabBodyText: (
          document.querySelector<HTMLElement>(".pc-advshell__tabbody")
            ?.textContent ?? ""
        ).trim().slice(0, 320),
      }));
      throw new Error(
        "Work tab body did not render after router PUSH; " +
          `work snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    const projectSelectorPresent = await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const trigger = document.querySelector<HTMLElement>(
            ".pc-advshell__select-trigger",
          );
          return Boolean(trigger);
        }),
      {
        timeout: 20_000,
        timeoutMsg: "Work-tab project selector did not render within 20s",
      },
    ).then(() => true, () => false);

    if (!projectSelectorPresent) {
      const snapshot = await browser.execute(() => {
        const trigger = document.querySelector<HTMLElement>(
          ".pc-advshell__select-trigger",
        );
        return {
          href: location.href,
          workTabState:
            document
              .querySelector<HTMLElement>(".pc-advshell__tab--harnesses")
              ?.getAttribute("data-state") ?? null,
          workBodyPresent: Boolean(
            document.querySelector(
              ".pc-advshell__tabbody .pc-adv-harnesses",
            ),
          ),
          projectSelectorPresent: Boolean(trigger),
          projectSelectorDisabled:
            trigger?.hasAttribute("disabled") ?? null,
          projectSelectorText: (trigger?.textContent ?? "").trim() || null,
          potBarPresent: Boolean(document.querySelector(".pc-potbar")),
          tabError:
            document.querySelector<HTMLElement>('[data-testid="adv-tab-error"]')
              ?.textContent?.trim() ?? null,
          tabBodyText: (
            document.querySelector<HTMLElement>(".pc-advshell__tabbody")
              ?.textContent ?? ""
          ).trim().slice(0, 320),
        };
      });
      throw new Error(
        "Work-tab project selector did not render; " +
          `selector snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    const harnessesUrl = await browser.execute((harness: string) => {
      const u = new URL(location.href);
      u.searchParams.set("tab", "harnesses");
      u.searchParams.set("slug", harness);
      u.searchParams.set("scope", "self");
      u.searchParams.set("welcome", "0");
      return u.pathname + u.search + u.hash;
    }, FIXTURE_HARNESS);
    await spaNavigate(harnessesUrl);
    const dockReady = await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(
            document.querySelector(
              ".pc-adv-harnesses .dockview-theme-dark",
            ),
          ),
        ),
      {
        timeout: 20_000,
        timeoutMsg: FIXTURE_HARNESS + " Work dock did not mount within 20s",
      },
    ).then(() => true, () => false);

    if (!dockReady) {
      const snapshot = await browser.execute(() => ({
        href: location.href,
        projectSelectorDisabled:
          document.querySelector<HTMLElement>(
            ".pc-advshell__select-trigger",
          )?.hasAttribute("disabled") ?? null,
        workspacePresent: Boolean(document.querySelector(".pc-adv-harnesses")),
        emptyText:
          document.querySelector<HTMLElement>(".pc-adv-harnesses__empty")
            ?.textContent?.trim() ?? null,
        bodyText: (document.body.textContent ?? "").trim().slice(0, 320),
      }));
      throw new Error(
        FIXTURE_HARNESS + " Work dock did not mount after the registry-ready deep link; " +
          `workspace snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    // Persisted dock layouts are user-defined and need not contain either the
    // Detail or Work items panel. Ensure Detail EXISTS first, then refocus Work
    // items for row selection. When both were absent, dockview opens the first
    // missing panel as a tab in the active group; the final focus order below
    // therefore works for both the seeded split layout and a customised
    // single-group layout.
    await requestHarnessPanel("adv:detail", "Detail");
    await requestHarnessPanel("adv:work-items", "Work items");

    // Wait for at least one row in the Work items grid. RichGrid (grid-core)
    // gives BOTH the header and every body row `role="row"` (see RichGrid.tsx —
    // no per-row data-testid exists), so index 0 is always the header and index
    // 1 is the first real data row once one has rendered.
    const rowsReady = await browser.waitUntil(
      async () =>
        await browser.execute(
          (itemId: string | null) => {
            // The count badge is intentionally absent while the companion
            // summary query is fetching. The semantic filter control is part
            // of the panel shell and remains mounted while rows hydrate.
            const workItemsPanel = document
              .querySelector('input[aria-label="Filter work items"]')
              ?.closest('.pc-advpanel');
            if (itemId) return Array.from(workItemsPanel?.querySelectorAll('[role="row"] code') ?? [])
              .some(el => el.textContent === itemId);
            return (
              (workItemsPanel?.querySelectorAll('[role="row"]').length ?? 0) > 1
            );
          }, FIXTURE_ITEM ?? null,
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no work-item rows within 20s (is the harness slug valid, and does it have work items?)",
      },
    ).then(() => true, () => false);

    if (!rowsReady) {
      const snapshot = await browser.execute(() => {
        const w = window as Window & {
          __PAPERCUSP_PENDING_PANEL_OPENS__?: Array<{
            type: string;
            title?: string;
          }>;
        };
        return {
          href: location.href,
          pendingPanelOpens: w.__PAPERCUSP_PENDING_PANEL_OPENS__ ?? [],
          dockTabs: Array.from(
            document.querySelectorAll<HTMLElement>(".dv-tab"),
          ).map((tab) => (tab.textContent ?? "").trim()).filter(Boolean),
          rowCount:
            document
              .querySelector('input[aria-label="Filter work items"]')
              ?.closest('.pc-advpanel')
              ?.querySelectorAll('[role="row"]').length ?? 0,
          workItemCount:
            document.querySelector('[data-testid="wi-count"]')?.textContent?.trim() ??
            null,
          workItemEmptyStates: Array.from(
            document.querySelectorAll<HTMLElement>(".pc-advpanel__empty"),
          ).map((node) => (node.textContent ?? "").trim()).filter(Boolean),
        };
      });
      throw new Error(
        "no work-item rows within 20s after requesting adv:work-items; " +
          `dock snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    // Select the explicit private item when provided; ordinary runs use the
    // first data row. Native clicks exercise the real RichGrid selection path.
    if (FIXTURE_ITEM) {
      await browser.$('[role="row"]:has(code[title="' + FIXTURE_ITEM + '"])').click();
    } else {
      const rows = await browser.$$('.pc-advpanel:has(input[aria-label="Filter work items"]) [role="row"]');
      await rows[1].click();
    }

    // If a customised layout placed Detail in the same tab group as Work
    // items, it is intentionally inactive during the click above and its
    // non-keepAlive React tree is unmounted. Focus it now so DetailPanel mounts
    // against the freshly written ?sel value. In the seeded split layout this
    // is a harmless focus of the already-visible bottom pane.
    await requestHarnessPanel("adv:detail", "Detail");

    // Wait for the Detail pane to resolve that selection and render its Chat
    // action (WorkItemDetail, DetailPanel.tsx — every WI-* row gets one).
    const detailReady = await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid="wi-detail-chat"]')),
        ),
      {
        timeout: 15_000,
        timeoutMsg:
          'no [data-testid="wi-detail-chat"] within 15s of selecting a work-item row',
      },
    ).then(() => true, () => false);

    if (!detailReady) {
      const snapshot = await browser.execute(() => ({
        href: location.href,
        dockTabs: Array.from(
          document.querySelectorAll<HTMLElement>(".dv-tab"),
        ).map((tab) => ({
          text: (tab.textContent ?? "").trim(),
          active: tab.classList.contains("dv-active-tab"),
        })),
        workItemCount:
          document.querySelector('[data-testid="wi-count"]')?.textContent?.trim() ??
          null,
        selectedRows: Array.from(
          document.querySelectorAll<HTMLElement>('[role="row"][aria-selected="true"]'),
        ).map((row) => ({
          text: (row.textContent ?? "").trim().slice(0, 160),
          itemId: row.dataset.itemId ?? null,
        })),
        detailPanels: document.querySelectorAll('[data-testid="wi-detail-chat"]')
          .length,
      }));
      throw new Error(
        'no [data-testid="wi-detail-chat"] after ensuring adv:detail and selecting a work item; ' +
          `detail snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    await waitForMainThreadQuietInPage();

    // Clear any stale measure, then click Chat: openFeatureChat POSTs a real
    // agent_chats row and fires the open-chat event; HarnessesDock's drain
    // mounts <ChatPanel>, which begins conversation-thread-load when chatId is
    // set and ends it when that chat's transcript first renders
    // (ChatPanel.tsx:168/171).
    await browser.execute((name) => {
      try {
        if (performance.clearMeasures) performance.clearMeasures(name);
      } catch {
        /* ignore */
      }
    }, NAME);
    await browser.$('[data-testid="wi-detail-chat"]').click();

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (name) => performance.getEntriesByName(name, "measure").length > 0,
          NAME,
        ),
      {
        timeout: 20_000,
        timeoutMsg: `no "${NAME}" measure emitted within 20s of opening the chat`,
      },
    );

    const measuredMs = await latestMeasure(NAME);
    // Record BEFORE the asserts — see the note in the palette test above.
    recordInteractionMs(NAME, measuredMs, CONVERSATION_THREAD_LOAD_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(
      CONVERSATION_THREAD_LOAD_BUDGET_MS,
    );
  });
});
