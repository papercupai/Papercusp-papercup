/**
 * /adv shell tab navigation (P-011, app-wide-test-coverage-2026-06-05).
 *
 * The /adv operator shell is one TanStack route whose sections are pure
 * `?tab=` nuqs state (operator-vite routes/adv/index.tsx + AdvShell.tsx).
 * Existing adv specs cover individual panels (contributors, member axis,
 * creation fork); NONE covered the top-level navigation contract itself.
 * This spec drives it end-to-end:
 *
 *   1. only the PRIMARY tabs (hud-first-nav-and-dossier-2026-07-26 D-001)
 *      render in the visible strip, in order — everything else lives behind
 *      the "More" menu,
 *   2. every tab in the FULL ADV_TABS set — primary or secondary — deep-links
 *      via `?tab=<id>` and renders without the route error boundary
 *      ("This view hit an error", RouteErrorBoundary.tsx) and without app
 *      console errors, whether or not it has its own strip entry,
 *   3. clicking a primary tab writes `?tab=` to the URL (the nuqs contract:
 *      agents read/write the URL, users deep-link it); selecting a secondary
 *      tab from the "More" menu does the same and closes the menu,
 *   4. URL round-trip — a reload lands on the same tab, primary or secondary,
 *   5. scope coupling — under `?scope=all` ("All Pots") the strip still shows
 *      only the primary tabs (all of which happen to be workspace-level), and
 *      a per-pot tab reached via deep link stays PINNED (title + `?tab=`
 *      unchanged, the More trigger marked active) rather than snapping back
 *      to Overview — the old snap-back was swapped for pinning by owner ask
 *      2026-06-17 (AdvShell.tsx's `visibleTabs` append).
 *
 * D-001 (owner decision, option C, 2026-07-26) moved every ADV_TABS entry
 * except Overview/HUD/Work/Learning off the visible Tabs.List and into a
 * searchable/grouped "More" popover (cmdk, AdvMoreMenu) — `Tabs.List` in
 * AdvShell.tsx renders ONLY `primaryTabs`, so a secondary tab's deep link
 * still lands and renders (content is driven by `activeTab` regardless of
 * strip visibility) but is never itself a `role=tab` element; it is reachable
 * only via the "More sections" button + its cmdk items (`role=option`).
 *
 * Hermetic where it matters: `/api/harness/projects/lite` is stubbed (like
 * adv-harness-member-axis.spec.ts) so the slug in the URL is always a valid
 * project regardless of workspace contents — otherwise AdvShell's persisted-
 * selection restore would flip a fresh browser context into all-mode and
 * hide the per-pot tabs. Status/lanes/agents are stubbed benign; the rest of
 * the tab content fetches hit the live proxy and may 401/404 for the
 * fictional slug, which the console scrub treats as environment noise.
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA in the
 * e2e Chromium project. A stale HMR-disabled :3055 serves a blank `#root`
 * ('/@vite/client' createHotContext stub) — the shell never mounts and these
 * tests skip rather than fail (the config's own webServer boots an
 * HMR-enabled Vite, where everything renders).
 */
import { test, expect, assertMounted, type Page } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

// Fictional slug — valid because projects/lite is stubbed, hermetic because
// no real workspace harness is touched.
const SLUG = 'e2e-nav-pot';

const PROJECTS_LITE = {
  projects: [
    {
      slug: SLUG,
      path: `/tmp/${SLUG}`,
      hasState: true,
      hasSpec: true,
      parent_slug: null,
      harness_kind: 'project',
      is_shared: false,
    },
  ],
};

/**
 * The FULL tab set, mirroring ADV_TABS in
 * apps/operator-vite/src/components/adv/AdvShell.tsx (declaration order).
 * `label` is the trigger/menu-item's accessible name (rendered lowercase on the
 * strip, title-case in the More menu). It was ALSO the shell's `<h1>` title until
 * 2026-07-27, when the owner had the whole title bar removed so the strip sits at
 * the very top — see expectActiveSection for what replaced reading the title. The
 * strip-contents test below fails if PRIMARY_TAB_IDS (or this list) drifts from
 * the real ADV_TABS / PRIMARY_ADV_TAB_IDS.
 */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'hud', label: 'HUD' },
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'plans', label: 'Create' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'calendar', label: 'Calendar' },
  // Label renamed Harnesses → Progress → Working → Work (owner asks, 2026-06-10/11
  // and 2026-07-26); the tab ID stays 'harnesses' — it's URL-serialized
  // (?tab=harnesses deep links).
  { id: 'harnesses', label: 'Work' },
  { id: 'health', label: 'Health' },
  { id: 'frames', label: 'Frames' },
  { id: 'git', label: 'Git' },
  { id: 'stats', label: 'Stats' },
  { id: 'testing', label: 'Tests' },
  { id: 'docs', label: 'Docs' },
  { id: 'history', label: 'History' },
  { id: 'insights', label: 'Insights' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'learning', label: 'Learning' },
  { id: 'evals', label: 'Evaluation' },
  { id: 'settings', label: 'Settings' },
] as const;

/**
 * PRIMARY_ADV_TAB_IDS (D-001, option C): the only tabs that render as real
 * `role=tab` strip entries. Order matches TABS/ADV_TABS declaration order —
 * `splitPrimarySecondary` preserves it, no separate ordering needed here.
 */
const PRIMARY_TAB_IDS = new Set(['overview', 'hud', 'workflows', 'harnesses', 'learning']);
const PRIMARY_TABS = TABS.filter((t) => PRIMARY_TAB_IDS.has(t.id));

const SKIP_MSG =
  'The /adv shell did not mount the tab strip. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist, or a vite preview OPERATOR_E2E_BASE_URL=http://127.0.0.1:4173) — ' +
  "a stale HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

/**
 * Stub the shell's own data dependencies so navigation is hermetic:
 * projects/lite validates the URL slug (and keeps the persisted-selection
 * restore from flipping to all-mode); status/lanes/agents keep the header
 * widgets + Harnesses dock benign. Tab CONTENT fetches stay live on purpose
 * — a tab that crashes on real (empty) data is exactly what test 1 hunts.
 */
async function stubShellApis(page: Page) {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECTS_LITE),
    });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }),
    });
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ lanes: [], max: 1 }),
    });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [] }),
    });
  });
}

/**
 * Console-error scrub (home.spec.ts pattern, widened for this suite's
 * fictional slug). Ignored as ENVIRONMENT noise, not app bugs:
 *   - third-party / hydration / favicon chatter,
 *   - failed resource loads — slug-scoped + authed fetches 401/403/404
 *     against the live proxy for a stubbed slug in a raw e2e browser.
 * Everything else (uncaught exceptions, React render errors, the
 * RouteErrorBoundary's own console.error) stays flagged.
 */
function scrubConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
      !/Failed to load resource/i.test(e) &&
      !/\b(401|403|404)\b.*(Unauthorized|Forbidden|Not Found)/i.test(e),
  );
}

/** Attach BEFORE goto so boot-time errors are captured too. */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

/**
 * Navigate to /adv with the given search and report whether the shell's tab
 * strip mounted. A blank HMR-disabled :3055 never mounts it, so the caller
 * skips rather than fails (mirrors the sibling adv specs).
 */
async function gotoAdv(page: Page, search: string): Promise<boolean> {
  const res = await page.goto(`${baseURL}/adv${search}`, { waitUntil: 'domcontentloaded' });
  // The SPA shell itself must serve (any tab — content is client-rendered).
  expect([200, 304]).toContain(res?.status() ?? 0);
  return page
    .getByRole('tablist', { name: 'Adv sections' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * "Which section am I on" — WITHOUT a title bar to read it off. The shell's
 * `<h1>` (and the whole "ADVANCED ORCHESTRATION / <title>" row it sat in) was
 * removed 2026-07-27 by owner ask so the tab strip sits at the very top, so the
 * durable signals are the two the shell still renders: a PRIMARY tab marks itself
 * aria-selected, and a SECONDARY tab (no strip entry, D-001) lights the "More"
 * trigger — plus `?tab=`, which is the actual store.
 */
async function expectActiveSection(page: Page, id: string): Promise<void> {
  const label = TABS.find((t) => t.id === id)!.label.toLowerCase();
  if (PRIMARY_TAB_IDS.has(id)) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } else {
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveCount(0);
    await expect(moreTrigger(page)).toHaveClass(/pc-advshell__more-trigger--active/);
  }
  await expect
    .poll(
      () => {
        const v = tabParam(page);
        // nuqs clearOnDefault may strip `tab=overview` — equivalent state.
        return v === null && id === 'overview' ? 'overview' : v;
      },
      { timeout: 10_000 },
    )
    .toBe(id);
}

/** The "More sections" trigger — only rendered while secondary tabs exist
 *  for the current scope (always true here: TABS has secondary members). */
function moreTrigger(page: Page) {
  return page.getByRole('button', { name: 'More sections' });
}

/**
 * No error boundary latched: neither the Outlet-level RouteErrorBoundary
 * fallback nor TanStack's bare root "Something went wrong" boundary.
 */
async function expectNoErrorBoundary(page: Page) {
  await expect(page.getByRole('alert').filter({ hasText: 'This view hit an error' })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

function tabParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('tab');
}

test.describe('/adv shell tab navigation (P-011)', () => {
  test('the strip renders exactly the primary tab set, in order (D-001)', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    assertMounted(mounted, SKIP_MSG);

    // toHaveText with an array asserts count AND order — drift between this
    // spec's PRIMARY_TABS and the real PRIMARY_ADV_TAB_IDS fails here, not via
    // a silent no-op getByRole miss in the per-tab tests. Every other ADV_TABS
    // entry lives behind "More" now (D-001), never as its own strip tab.
    await expect(
      page.getByRole('tablist', { name: 'Adv sections' }).getByRole('tab'),
    ).toHaveText(PRIMARY_TABS.map((t) => t.label.toLowerCase()));

    // The secondary tabs are still discoverable, just not on the strip.
    await expect(moreTrigger(page)).toBeVisible();
  });

  for (const tab of TABS) {
    const isPrimary = PRIMARY_TAB_IDS.has(tab.id);
    test(`deep link ?tab=${tab.id} lands on ${tab.label} and renders clean${isPrimary ? '' : ' (secondary — More menu only)'}`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page);
      await stubShellApis(page);
      const mounted = await gotoAdv(page, `?tab=${tab.id}&slug=${SLUG}&scope=expanded`);
      assertMounted(mounted, SKIP_MSG);

      // Landed on the tab regardless of whether it has its own strip entry —
      // content is driven by `activeTab`, not strip membership (AdvShell.tsx:
      // panel content renders imperatively off activeTab; Tabs.Content stubs are
      // forceMount/display:none a11y shims only).
      if (isPrimary) {
        await expect(
          page.getByRole('tab', { name: tab.label.toLowerCase(), exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
      } else {
        // A secondary tab never gets its own Tabs.Trigger (D-001) — instead
        // the "More" trigger reflects the active secondary tab.
        await expect(page.getByRole('tab', { name: tab.label.toLowerCase(), exact: true })).toHaveCount(0);
        await expect(moreTrigger(page)).toHaveClass(/pc-advshell__more-trigger--active/);
      }

      // The nuqs param survived mount — nothing rewrote/dropped it. The
      // default tab is the one exception: nuqs clearOnDefault may strip
      // `tab=overview`, which is equivalent state, so both spellings pass.
      if (tab.id === 'overview') {
        expect([tab.id, null]).toContain(tabParam(page));
      } else {
        expect(tabParam(page)).toBe(tab.id);
      }

      await expectNoErrorBoundary(page);
      expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
    });
  }

  test('clicking a primary tab writes ?tab= (nuqs) and the state survives reload', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    assertMounted(mounted, SKIP_MSG);

    // No ?tab= → the default landing surface (Overview).
    await expectActiveSection(page, 'overview');

    // Click → URL reflects the selection (the agent/deep-link contract).
    // 'hud' and 'harnesses' (Work) are both PRIMARY tabs, so they click
    // directly off the strip.
    await page.getByRole('tab', { name: 'hud', exact: true }).click();
    await expectActiveSection(page, 'hud');

    await page.getByRole('tab', { name: 'work', exact: true }).click();
    await expectActiveSection(page, 'harnesses');

    // Reload → the nuqs state round-trips (URL is the store, not useState).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectActiveSection(page, 'harnesses');

    // Back to the default tab: nuqs clearOnDefault drops the param (or
    // writes the default literally — both encode "overview").
    await page.getByRole('tab', { name: 'overview', exact: true }).click();
    await expectActiveSection(page, 'overview');
  });

  test('selecting a secondary tab from the "More" menu writes ?tab=, closes the menu, and survives reload', async ({ page }) => {
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    assertMounted(mounted, SKIP_MSG);

    await moreTrigger(page).click();
    // cmdk renders each secondary tab as a role=option item (cmdk's own
    // "role":"option" on CommandItem). Brainstorm leads the restored
    // "Create & Build" group.
    await expect(page.getByText('Create & Build', { exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Brainstorm', exact: true }).click();

    // Brainstorm never gets its own strip tab; the trigger reflects the selection.
    await expectActiveSection(page, 'brainstorm');
    // The popover closes on select (AdvShell's onSelect calls setMoreOpen(false)).
    await expect(page.getByRole('option', { name: 'Brainstorm', exact: true })).toHaveCount(0);

    // Reload → the nuqs state round-trips even for a secondary tab.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectActiveSection(page, 'brainstorm');
  });

  test('?scope=all still shows only the primary tabs, and pins a per-pot deep link instead of snapping to Overview', async ({ page }) => {
    await stubShellApis(page);
    // Git is a per-pot tab — hidden from the workspace-level strip. Since
    // owner ask 2026-06-17 the shell KEEPS a deep-linked per-pot tab pinned
    // (?tab= unchanged) rather than snapping back to Overview, so its body can
    // show the "pick a pot" prompt (AdvShell.tsx's `visibleTabs` append + the
    // comment at "owner ask 2026-06-17"). The pinned tab is still secondary
    // (D-001), so it surfaces via the "More" trigger's active state, never as
    // its own strip tab.
    const mounted = await gotoAdv(page, `?tab=git&slug=${SLUG}&scope=all`);
    assertMounted(mounted, SKIP_MSG);

    await expectActiveSection(page, 'git');

    // The strip shows exactly the primary tabs — same set as single-pot mode,
    // since every PRIMARY_ADV_TAB_IDS member is also a WORKSPACE_TAB_IDS
    // member (overview/hud/harnesses/learning all aggregate workspace-wide).
    await expect(
      page.getByRole('tablist', { name: 'Adv sections' }).getByRole('tab'),
    ).toHaveText(PRIMARY_TABS.map((t) => t.label.toLowerCase()));
    await expect(page.getByRole('tab', { name: 'git', exact: true })).toHaveCount(0);

    // The pinned secondary tab is marked active on the More trigger, and
    // shows its own active marker inside the menu (AdvMoreMenuItem's
    // data-active — the app's own "this is the active tab" signal, distinct
    // from cmdk's internal keyboard-navigation selection state).
    await expect(moreTrigger(page)).toHaveClass(/pc-advshell__more-trigger--active/);
    await moreTrigger(page).click();
    // The More menu lists a visited section twice, once under 'Recent' and once
    // in its own group, and both rows carry data-active (AdvMoreMenu, D-001).
    // So assert the intent, not a count: Git is active and no OTHER section is
    // (WI-10006792).
    await expect(page.locator('.pc-advshell__more-item[data-active]', { hasText: 'Git' }).first()).toBeVisible();
    await expect(page.locator('.pc-advshell__more-item[data-active]', { hasNotText: 'Git' })).toHaveCount(0);
  });

  test('the packaged 1280x720 header keeps every visible control in the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route('**/api/workspaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          current: 'default',
          workspaces: [{ id: 'default', name: 'Default', createdAt: 0 }],
        }),
      });
    });
    await stubShellApis(page);
    const mounted = await gotoAdv(page, `?slug=${SLUG}&scope=expanded`);
    assertMounted(mounted, SKIP_MSG);

    const controls = await page.locator('.pc-header a:visible, .pc-header button:visible').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      }),
    );

    // Self-diagnosing failure (WI-10006979): the header's box, its right lane,
    // the docked-rail CSS vars and the body reservation are what decide where
    // the right-side controls land, so a red names its cause, not just a pixel.
    const geometry = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      const header = document.querySelector('.pc-header');
      const rootStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const headerStyle = header ? getComputedStyle(header) : null;
      return {
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyClass: document.body.className,
        bodyPadding: `${bodyStyle.paddingLeft} / ${bodyStyle.paddingRight}`,
        vars: ['--op-chat-w', '--left-sidebar-w', '--dev-rail-w'].map((v) => `${v}=${rootStyle.getPropertyValue(v).trim() || 'unset'}`).join(' '),
        header: box(header),
        headerWidthStyle: headerStyle?.width,
        headerColumns: headerStyle?.gridTemplateColumns,
        headerClass: header?.className,
        left: box(document.querySelector('.pc-header-left')),
        center: box(document.querySelector('.pc-header-center')),
        right: box(document.querySelector('.pc-header-right')),
      };
    });
    const geometryNote = `header geometry: ${JSON.stringify(geometry)}`;

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.left, `${control.name} starts outside the viewport; ${geometryNote}`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.name} ends outside the viewport; ${geometryNote}`).toBeLessThanOrEqual(1280);
      expect(control.top, `${control.name} is above the viewport`).toBeGreaterThanOrEqual(0);
      expect(control.bottom, `${control.name} is below the viewport`).toBeLessThanOrEqual(720);
    }

    const workspaceTrigger = page.getByRole('button', { name: 'Switch or manage workspaces' });
    await expect(workspaceTrigger).toBeVisible();
    await workspaceTrigger.focus();
    await expect(workspaceTrigger).toBeFocused();
    await workspaceTrigger.click({ trial: true });
  });
});

type ViteCssFailureObservation = {
  message: string;
  failedUrl: string | null;
  appOrigin: string;
  pageUrl: string;
  timeOrigin: number;
  eventResourceTiming: Array<{
    name: string;
    startTime: number;
    duration: number;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
    responseStatus: number | null;
  }>;
  resourceTiming: Array<{
    name: string;
    startTime: number;
    duration: number;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
    responseStatus: number | null;
  }>;
};

type ViteCssFailureWindow = Window & {
  __viteCssFailureProbe?: { events: ViteCssFailureObservation[] };
};

test('first lazy HUD CSS preload failure captures response and timing before reload', async ({ page }, testInfo) => {
  // Switching from Overview to the HUD lazy subtree causes Vite's production
  // import-preload helper to add an extracted CSS link.
  // The probe is installed before the app entry runs and snapshots timing in the
  // event handler itself, before any later navigation could clear it.
  await page.addInitScript(() => {
    const probe: { events: ViteCssFailureObservation[] } = { events: [] };
    (window as ViteCssFailureWindow).__viteCssFailureProbe = probe;
    window.addEventListener('vite:preloadError', (event) => {
      const payload = (event as Event & { payload?: unknown }).payload;
      const message = String((payload as { message?: unknown } | null)?.message ?? payload ?? '');
      const prefix = 'Unable to preload CSS for ';
      const failedUrl = message.startsWith(prefix)
        ? new URL(message.slice(prefix.length), location.origin).href
        : null;
      const resourceTiming = performance.getEntriesByType('resource')
        .filter((entry) => entry.name === failedUrl)
        .map((entry) => {
          const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
          return {
            name: timing.name,
            startTime: timing.startTime,
            duration: timing.duration,
            transferSize: timing.transferSize,
            encodedBodySize: timing.encodedBodySize,
            decodedBodySize: timing.decodedBodySize,
            responseStatus: timing.responseStatus ?? null,
          };
        });
      probe.events.push({
        message,
        failedUrl,
        appOrigin: location.origin,
        pageUrl: location.href,
        timeOrigin: performance.timeOrigin,
        eventResourceTiming: resourceTiming,
        resourceTiming: [],
      });
    });
  });

  await stubShellApis(page);
  const initialResponse = await page.goto('/adv?tab=overview&slug=e2e-nav-pot&scope=expanded', {
    waitUntil: 'domcontentloaded',
  });
  expect([200, 304]).toContain(initialResponse?.status() ?? 0);
  await expect(page.getByRole('tablist', { name: 'Adv sections' })).toBeVisible();

  const initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const failedStyleResponsePromise = page.waitForResponse((response) =>
    response.request().resourceType() === 'stylesheet' && response.status() === 503,
  );
  let failedUrl: string | undefined;
  const armStatus = await page.evaluate(async () => {
    const response = await fetch('/__e2e/arm-first-css-failure', { method: 'POST' });
    return response.status;
  });
  expect(armStatus).toBe(204);
  await page.getByRole('tab', { name: 'hud', exact: true }).click();
  await expect.poll(async () => page.evaluate(
    () => (window as ViteCssFailureWindow).__viteCssFailureProbe?.events.length ?? 0,
  )).toBe(1);
  const failedStyleResponse = await failedStyleResponsePromise;
  failedUrl = failedStyleResponse.url();
  const playwrightRequestTiming = failedStyleResponse.request().timing();

  const observation = await page.evaluate(
    () => {
      const recorded = (window as ViteCssFailureWindow).__viteCssFailureProbe!.events[0]!;
      const resourceTiming = performance.getEntriesByName(recorded.failedUrl!, 'resource').map((entry) => {
        const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
        return {
          name: timing.name,
          startTime: timing.startTime,
          duration: timing.duration,
          transferSize: timing.transferSize,
          encodedBodySize: timing.encodedBodySize,
          decodedBodySize: timing.decodedBodySize,
          responseStatus: timing.responseStatus ?? null,
        };
      });
      return { ...recorded, resourceTiming };
    },
  );
  expect(failedUrl).toBeDefined();
  expect(observation.message).toContain('Unable to preload CSS for');
  expect(observation.failedUrl).toBe(failedUrl);
  expect(new URL(failedUrl!).origin).toBe(observation.appOrigin);
  expect(failedStyleResponse.status()).toBe(503);
  expect(new URL(failedStyleResponse.url()).origin).toBe(observation.appOrigin);
  expect(observation.eventResourceTiming).toEqual([]);
  expect(observation.resourceTiming.length).toBeLessThanOrEqual(1);
  if (observation.resourceTiming.length === 1) {
    expect(observation.resourceTiming[0]!.name).toBe(failedUrl);
    expect(observation.resourceTiming[0]!.startTime).toBeGreaterThanOrEqual(0);
  }
  expect(playwrightRequestTiming.startTime).toBeGreaterThan(0);
  expect(playwrightRequestTiming.responseStart).toBeGreaterThanOrEqual(0);
  if (playwrightRequestTiming.responseEnd >= 0) {
    expect(playwrightRequestTiming.responseEnd).toBeGreaterThanOrEqual(playwrightRequestTiming.responseStart);
  }
  await testInfo.attach('first-css-preload-observation.json', {
    body: JSON.stringify({
      observation,
      response: {
        url: failedStyleResponse.url(),
        status: failedStyleResponse.status(),
        origin: new URL(failedStyleResponse.url()).origin,
        playwrightRequestTiming,
      },
    }, null, 2),
    contentType: 'application/json',
  });
  expect(observation.pageUrl).toContain('/adv');
  expect(observation.timeOrigin).toBe(initialTimeOrigin);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigin);
});
