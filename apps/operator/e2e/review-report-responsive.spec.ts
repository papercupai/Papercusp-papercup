/**
 * Shared ReviewReportShell 520px geometry regression.
 *
 * jsdom cannot measure layout, so this pins the real browser contract for both
 * persisted-report consumers: no horizontal overflow, complete action labels,
 * and a header that remains sticky while the takeover scrolls.
 */
import { test, expect, assertMounted, type Page } from "./_egress";
import { stubSyncQueries } from "./_sync-stub";

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  "http://127.0.0.1:" +
    String(Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055);

const SLUG = "e2e-review-report-responsive";
const INBOX_RUN_ID = "e2e-inbox-review-520";
const PLANS_RUN_ID = "e2e-plans-review-520";

const PROJECTS = [
  {
    slug: SLUG,
    path: "/tmp/" + SLUG,
    name: SLUG,
    hasState: true,
    hasSpec: true,
    parent_slug: null,
    harness_kind: "project",
    is_shared: false,
  },
];

const inboxRun = {
  runId: INBOX_RUN_ID,
  harnessSlug: SLUG,
  phase: "review",
  totalItems: 24,
  autoResolved: 0,
  recommended: 12,
  skipped: 12,
  failed: 0,
  error: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
};

const inboxItems = Array.from({ length: 24 }, (_, position) => {
  const actionable = position < 12;
  const itemId = "inbox-row-" + String(position).padStart(2, "0");
  return {
    runId: INBOX_RUN_ID,
    itemId,
    position,
    kind: "coord-message",
    title: "Inbox review row " + position,
    ref: { kind: "coord-message", msgId: "msg-" + position },
    ownerAgentId: "su-e2e",
    outcome: actionable ? "recommended" : "skipped",
    actionId: actionable ? "ack" : null,
    rationale: actionable
      ? "The request is ready for acknowledgement."
      : "This item needs a manual source decision.",
    draftAnswer: null,
    confidence: "high",
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
  };
});

const plansRun = {
  runId: PLANS_RUN_ID,
  phase: "review",
  runKind: "plan-cleanup",
  seedRefs: [],
  totalItems: 24,
  autoResolved: 0,
  recommended: 24,
  skipped: 0,
  failed: 0,
  error: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
};

const planFindings = Array.from({ length: 24 }, (_, position) => {
  const actionable = position < 12;
  const planSlug = "responsive-plan-" + position;
  return {
    runId: PLANS_RUN_ID,
    findingId: (actionable ? "flip:" : "now:") + planSlug,
    kind: actionable ? "flip-to-done" : "stale-now",
    planSlug,
    harnessSlug: SLUG,
    itemId: actionable ? "P-" + String(position + 1).padStart(3, "0") : null,
    target: actionable ? planSlug + " item" : planSlug + " ## Now",
    from: actionable ? "todo" : "stale text",
    to: actionable ? "done" : "authored current text",
    confidence: actionable ? "provable" : "recommended",
    evidence: [
      { kind: "fixture", ref: "EI-21434338975681613", note: "520px geometry" },
    ],
    position,
    outcome: "recommended",
    error: null,
    decidedAt: null,
  };
});

async function stubFlags(page: Page): Promise<void> {
  await page.route("**/api/flags/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flags: {
          "papercusp-inbox-bulk-resolve": true,
          "papercusp-plan-cleanup": true,
        },
        evaluatedAt: Date.now(),
        source: "override",
      }),
    });
  });
  await page.route("**/api/flags/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": review-report-responsive e2e flags pinned\n\n",
    });
  });
}

async function stubReports(page: Page) {
  return stubSyncQueries(page, (name, args) => {
    if (name === "harnessProjects.lite") return PROJECTS;
    if (name === "plans.attentionBulkRun" && args.runId === INBOX_RUN_ID) {
      return [{ run: inboxRun, items: inboxItems }];
    }
    if (name === "plans.cleanupRun" && args.runId === PLANS_RUN_ID) {
      return [{ run: plansRun, findings: planFindings }];
    }
    return undefined;
  });
}

const scenarios = [
  {
    name: "Inbox bulk resolve",
    tab: "inbox",
    param: "opcbr",
    owner: "opcbr",
    runId: INBOX_RUN_ID,
    queryName: "plans.attentionBulkRun",
    // The commit button carries the selected verb's own label, not the generic
    // "Apply selected (n)" fallback (WI-10006792). Inbox rows are coord-message
    // items, so the verb is VERBS["ack"].commit; the Plans scenario below is
    // flip-to-done → VERBS["mark-done"].commit (measured on the rig, 22:46Z).
    applyLabel: "Acknowledge 12",
  },
  {
    name: "Plans cleanup",
    tab: "plans",
    param: "opcln",
    owner: "opcln",
    runId: PLANS_RUN_ID,
    queryName: "plans.cleanupRun",
    // The commit button carries the selected verb's own label
    // (ReviewReportShell VERBS["mark-done"].commit), not the generic
    // "Apply selected (n)" fallback (WI-10006792).
    applyLabel: "Mark 12 done",
  },
] as const;

test.use({ viewport: { width: 520, height: 844 } });

for (const scenario of scenarios) {
  test(
    scenario.name + " stays usable in a 520px container",
    async ({ page }, testInfo) => {
      await stubFlags(page);
      const sync = await stubReports(page);
      const query =
        "tab=" +
        scenario.tab +
        "&" +
        scenario.param +
        "=" +
        scenario.runId +
        "&oprpt=" +
        scenario.owner +
        "&slug=" +
        SLUG +
        "&scope=self";
      const response = await page.goto(baseURL + "/adv?" + query, {
        waitUntil: "domcontentloaded",
      });
      expect([200, 304]).toContain(response?.status() ?? 0);
      await sync.waitForServed([scenario.queryName]);

      const takeover = page.locator(".review-report-takeover");
      const report = page.getByTestId("review-report");
      const mounted = await report
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      assertMounted(
        mounted,
        scenario.name + " ReviewReportShell did not mount.",
      );

      await expect(takeover).toBeFocused();
      const siblingIsolation = await takeover.evaluate((node) =>
        Array.from(node.parentElement?.children ?? [])
          .filter(
            (sibling): sibling is HTMLElement =>
              sibling !== node && sibling instanceof HTMLElement,
          )
          .map((sibling) => ({
            tag: sibling.tagName,
            className: sibling.className,
            testId: sibling.dataset.testid ?? null,
            inert: sibling.hasAttribute("inert"),
            ariaHidden: sibling.getAttribute("aria-hidden"),
          })),
      );
      expect(siblingIsolation.length).toBeGreaterThan(0);
      expect(
        siblingIsolation.filter(
          (sibling) => !sibling.inert || sibling.ariaHidden !== "true",
        ),
      ).toEqual([]);

      const geometry = await takeover.evaluate((node) => {
        const reportNode = node.querySelector(".review-report") as HTMLElement;
        const header = node.querySelector(
          ".review-report__head",
        ) as HTMLElement;
        const buttons = Array.from(
          node.querySelectorAll(".review-report__actions button"),
        ) as HTMLElement[];
        const toggles = Array.from(
          node.querySelectorAll(".review-report__group-toggle"),
        ) as HTMLElement[];
        return {
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          takeoverOverflow: node.scrollWidth - node.clientWidth,
          reportOverflow: reportNode.scrollWidth - reportNode.clientWidth,
          scrollRange: node.scrollHeight - node.clientHeight,
          headerPosition: getComputedStyle(header).position,
          actions: buttons.map((button) => ({
            text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
            overflow: button.scrollWidth - button.clientWidth,
          })),
          clippedGroupToggles: toggles.filter(
            (toggle) => toggle.scrollWidth > toggle.clientWidth + 1,
          ).length,
          // Self-diagnosis for an overflow red: the elements whose right edge
          // sticks out past the report's content box, widest first, so the
          // failure names the culprit instead of only a pixel count.
          overflowCulprits: (() => {
            const edge = reportNode.getBoundingClientRect().right + 1;
            return (Array.from(reportNode.querySelectorAll("*")) as HTMLElement[])
              .map((el) => ({ el, right: el.getBoundingClientRect().right }))
              .filter(({ right }) => right > edge)
              .sort((a, b) => b.right - a.right)
              .slice(0, 6)
              .map(({ el, right }) =>
                `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""}` +
                ` +${Math.round(right - edge + 1)}px "${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`,
              );
          })(),
        };
      });

      const culprits = "overflowing elements: " + JSON.stringify(geometry.overflowCulprits);
      expect(geometry.documentOverflow, culprits).toBeLessThanOrEqual(1);
      expect(geometry.takeoverOverflow, culprits).toBeLessThanOrEqual(1);
      expect(geometry.reportOverflow, culprits).toBeLessThanOrEqual(1);
      expect(geometry.scrollRange).toBeGreaterThan(300);
      expect(geometry.headerPosition).toBe("sticky");
      expect(geometry.actions.map((action) => action.text)).toEqual([
        scenario.applyLabel,
        "Close",
      ]);
      expect(geometry.actions.every((action) => action.overflow <= 1)).toBe(
        true,
      );
      expect(geometry.clippedGroupToggles).toBe(0);

      await takeover.evaluate((node) => {
        node.scrollTop = 180;
      });
      const stickyTopA = await report
        .locator(".review-report__head")
        .evaluate((node) => node.getBoundingClientRect().top);
      await takeover.evaluate((node) => {
        node.scrollTop = 360;
      });
      const stickyTopB = await report
        .locator(".review-report__head")
        .evaluate((node) => node.getBoundingClientRect().top);
      expect(Math.abs(stickyTopB - stickyTopA)).toBeLessThanOrEqual(1);

      await report.screenshot({
        path: testInfo.outputPath(scenario.param + "-review-report-520px.png"),
        animations: "disabled",
      });
      sync.assertServed(scenario.queryName);
    },
  );
}
