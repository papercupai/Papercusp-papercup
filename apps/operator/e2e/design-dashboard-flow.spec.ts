/**
 * Design dashboard flow — /design/$slug (app-wide e2e coverage audit).
 *
 * The Design workspace is one TanStack route (operator-vite
 * routes/design/$slug.tsx) wrapping `DesignDashboard`
 * (apps/operator/app/design/[slug]/DesignDashboard.tsx). Its key surfaces:
 *
 *   - header (eyebrow + "Design · <slug>" title + queue metrics),
 *   - the pane tab strip (?pane= nuqs: features | memos | registry |
 *     tokens | sketch | regressions),
 *   - the feature-queue rail with status buckets (?bucket= nuqs:
 *     all | pending | accepted | ignored),
 *   - per-feature selection (?feature= nuqs).
 *
 * This spec drives: shell mounts 500-free with the key panels present,
 * every pane deep-links + renders without the error boundary or app
 * console errors, and the nuqs contract — clicks write ?pane=/?bucket=,
 * a reload round-trips the state (URL is the store, not useState).
 *
 * Hermetic where it matters: the route is gated behind FLAGS.DESIGN
 * ('papercusp-design', default OFF in libs/flags/src/types.ts) via a
 * `beforeLoad` requireFlag that resolves `/api/flags/bootstrap`
 * client-side (operator-vite lib/require-flag.ts). We stub bootstrap to
 * force the flag ON (and stub the /api/flags/stream SSE so a live
 * `flags_payload` push can't flip it back), so the dashboard itself is
 * exercised regardless of the rig's runtime flag state — otherwise the
 * default-off flag would 404 the route and this spec would never test
 * anything. Data fetches (/api/design/features, design-phase plugin
 * verbs) stay LIVE on purpose; their error/empty states are valid
 * renders and any 401/403/404 chatter is scrubbed as environment noise.
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA. A
 * stale HMR-disabled :3055 serves a blank `#root`, so tests skip rather
 * than fail when the shell never mounts (playwright.config.ts boots an
 * HMR-enabled Vite where everything renders).
 */
import { test, expect, assertMounted, type Page } from './_egress';

// Mirror playwright.config.ts's BASE_URL derivation — honoring
// OPERATOR_E2E_PORT keeps this spec on the SAME server the config's
// webServer boots (EI-208: a hardcoded :3055 silently targeted the
// standing dev server when a fresh rig ran on another port).
const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

/** Pane ids — keep in sync with PANES in DesignDashboard.tsx. */
const PANES = ['features', 'memos', 'registry', 'tokens', 'sketch', 'regressions', 'evidence'] as const;
/** Bucket ids — keep in sync with BUCKETS in DesignDashboard.tsx. */
const BUCKETS = ['all', 'pending', 'accepted', 'ignored'] as const;

const SKIP_MSG =
  'The Design dashboard did not mount. Run against an HMR-enabled operator-vite ' +
  '(the playwright.config webServer, or OPERATOR_E2E_BASE_URL at a vite preview) — ' +
  "a stale HMR-disabled :3055 serves a blank #root ('/@vite/client' createHotContext mismatch).";

// Resolve a harness slug that exists IN THE WORKSPACE THE PAGE WILL USE
// (dock.spec.ts pattern): a fresh Playwright profile stamps
// `x-papercusp-workspace: default` on every in-page fetch, so the slug must
// come from THAT workspace's registry or the route 404s. Prefer `papercup`
// when present, else a stable-looking project. The dashboard renders its
// shell regardless of the slug's data, so a fallback literal keeps the spec
// runnable everywhere.
const PAGE_WORKSPACE = 'default';
let SLUG = process.env.DESIGN_E2E_SLUG ?? '';

test.beforeAll(async ({ request }) => {
  if (SLUG) return;
  try {
    const r = await request.get(`${baseURL}/api/harness/projects/lite`, {
      timeout: 15_000,
      headers: { 'x-papercusp-workspace': PAGE_WORKSPACE },
    });
    const projects: Array<{ slug: string }> = (await r.json()).projects ?? [];
    SLUG =
      projects.find((p) => p.slug === 'papercup')?.slug ??
      projects.find((p) => !/e2e|smoke|test/.test(p.slug))?.slug ??
      projects[0]?.slug ??
      'papercup';
  } catch {
    SLUG = 'papercup';
  }
});

/**
 * Force the DESIGN flag on (requireFlag gate) and pin the stream so a live
 * push can't override the stub mid-test. Bootstrap shape = FlagPayload
 * (libs/flags/src/types.ts); resolveWithDefaults fills every other key from
 * FLAG_DEFAULTS, so the rest of the app runs at defaults — fine for this
 * route.
 */
async function stubFlags(page: Page) {
  await page.route('**/api/flags/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: { 'papercusp-design': true },
        evaluatedAt: Date.now(),
        source: 'override',
      }),
    });
  });
  await page.route('**/api/flags/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ': design-dashboard-flow e2e — flag stream stubbed\n\n',
    });
  });
}

/**
 * Console-error scrub (home.spec.ts / adv-shell-nav.spec.ts pattern).
 * Ignored as ENVIRONMENT noise, not app bugs: third-party / hydration /
 * favicon chatter, failed resource loads, authed fetches 401/403/404 in a
 * raw e2e browser (no verified session), and WS/SSE transport flaps (the
 * sync layer's browser fallback). Real app errors (uncaught exceptions,
 * React render errors, error-boundary logs) stay flagged.
 */
function scrubConsoleErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
      !/Failed to load resource/i.test(e) &&
      !/\b(401|403|404)\b.*(Unauthorized|Forbidden|Not Found)/i.test(e) &&
      !/WebSocket|EventSource/i.test(e),
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

function param(page: Page, key: string): string | null {
  return new URL(page.url()).searchParams.get(key);
}

const paneTabs = (page: Page) =>
  page.locator('nav[aria-label="Design workspace panes"]');
const paneTab = (page: Page, pane: string) =>
  paneTabs(page).getByRole('button', { name: pane, exact: true });
const bucketBtn = (page: Page, bucket: string) =>
  page
    .locator('[role="group"][aria-label="Filter design features by status"]')
    // P-011 gives the count node explicit corpus-evidence wording, so current
    // accessible names read e.g. "pending 47 features in the Design feature
    // queue". Keep accepting the legacy compact "pending47" form too: the
    // lookahead handles a digit with no boundary, while \b handles scoped copy.
    .getByRole('button', { name: new RegExp(`^${bucket}(?:\\b|(?=\\d))`, 'i') });

/**
 * Navigate and report whether the dashboard mounted. 'notfound' means the
 * flag gate tripped despite the stub (a real regression, not an env skip).
 */
async function gotoDesign(
  page: Page,
  search = '',
): Promise<'mounted' | 'notfound' | 'blank'> {
  const res = await page.goto(`${baseURL}/design/${SLUG}${search}`, {
    waitUntil: 'domcontentloaded',
  });
  expect([200, 304]).toContain(res?.status() ?? 0);
  const mounted = await paneTabs(page)
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (mounted) return 'mounted';
  // Root notFoundComponent renders #not-found-title (components/NotFound.tsx).
  return (await page.locator('#not-found-title').count()) > 0 ? 'notfound' : 'blank';
}

async function expectNoErrorBoundary(page: Page) {
  await expect(
    page.getByRole('alert').filter({ hasText: 'This view hit an error' }),
  ).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

test.describe('/design/$slug — design dashboard flow', () => {
  test('shell renders 500-free with header, metrics, rail, buckets, and pane strip', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await stubFlags(page);
    const state = await gotoDesign(page);
    expect(state, 'flag stub should keep the DESIGN gate open — 404 means requireFlag tripped').not.toBe('notfound');
    assertMounted(state !== "blank", SKIP_MSG);

    // Key panels mount.
    await expect(page.locator('.d-title')).toContainText('Design');
    await expect(page.locator('.d-title')).toContainText(SLUG);
    await expect(page.locator('[aria-label="Design queue summary"]')).toBeVisible();
    await expect(page.locator('aside[aria-label="Design feature queue"]')).toBeVisible();
    await expect(
      page.locator('[role="group"][aria-label="Filter design features by status"]'),
    ).toBeVisible();

    // The pane strip holds exactly the PANES set, in order (drift between
    // this spec and DesignDashboard.tsx fails here, not via silent misses).
    await expect(paneTabs(page).getByRole('button')).toHaveText([...PANES]);

    // Bucket filters all present.
    for (const b of BUCKETS) await expect(bucketBtn(page, b)).toBeVisible();

    await expectNoErrorBoundary(page);
    expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
  });

  for (const pane of PANES) {
    test(`deep link ?pane=${pane} lands on the ${pane} pane and renders clean`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page);
      await stubFlags(page);
      const state = await gotoDesign(page, `?pane=${pane}`);
      expect(state).not.toBe('notfound');
      assertMounted(state !== "blank", SKIP_MSG);

      await expect(paneTab(page, pane)).toHaveAttribute('aria-pressed', 'true');

      // The nuqs param survived mount. The default pane is the one
      // exception: clearOnDefault may strip `pane=features` (equivalent
      // state), so both spellings pass.
      if (pane === 'features') {
        expect(['features', null]).toContain(param(page, 'pane'));
      } else {
        expect(param(page, 'pane')).toBe(pane);
      }

      await expectNoErrorBoundary(page);
      expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
    });
  }

  test('clicking panes/buckets writes ?pane= / ?bucket= (nuqs) and the state survives reload', async ({ page }) => {
    await stubFlags(page);
    const state = await gotoDesign(page);
    expect(state).not.toBe('notfound');
    assertMounted(state !== "blank", SKIP_MSG);

    // Click a pane → URL reflects the selection (agent/deep-link contract).
    await paneTab(page, 'tokens').click();
    await expect.poll(() => param(page, 'pane'), { timeout: 10_000 }).toBe('tokens');
    await expect(paneTab(page, 'tokens')).toHaveAttribute('aria-pressed', 'true');

    // Click a bucket → ?bucket= written alongside.
    await bucketBtn(page, 'pending').click();
    await expect.poll(() => param(page, 'bucket'), { timeout: 10_000 }).toBe('pending');
    await expect(bucketBtn(page, 'pending')).toHaveAttribute('aria-pressed', 'true');

    // Reload → both round-trip (URL is the store, not useState).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(paneTab(page, 'tokens')).toHaveAttribute('aria-pressed', 'true');
    await expect(bucketBtn(page, 'pending')).toHaveAttribute('aria-pressed', 'true');
    expect(param(page, 'pane')).toBe('tokens');
    expect(param(page, 'bucket')).toBe('pending');

    // Back to defaults: nuqs clearOnDefault drops the params (or writes the
    // default literally — both encode the same state).
    await paneTab(page, 'features').click();
    await bucketBtn(page, 'all').click();
    await expect
      .poll(() => {
        const p = param(page, 'pane');
        const b = param(page, 'bucket');
        return (p === null || p === 'features') && (b === null || b === 'all');
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test('selecting a feature writes ?feature= (nuqs) and survives reload', async ({ page }) => {
    await stubFlags(page);
    const state = await gotoDesign(page);
    expect(state).not.toBe('notfound');
    assertMounted(state !== "blank", SKIP_MSG);

    // Wait for the queue to settle out of its loading row, then bail
    // gracefully when this workspace has no needs_design features — the
    // empty rail is a valid render, not a failure.
    await expect(page.getByText('Loading design features…')).toHaveCount(0, { timeout: 20_000 });
    const rows = page.locator('.d-feature-row');
    const count = await rows.count();
    test.skip(count === 0, `no design features in workspace harness '${SLUG}' — selection flow has nothing to click`);

    await rows.first().click();
    await expect.poll(() => param(page, 'feature'), { timeout: 10_000 }).not.toBeNull();
    const selected = param(page, 'feature');

    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(param(page, 'feature')).toBe(selected);
    // The selected row is re-marked active after the queue re-loads.
    await expect(page.locator('.d-feature-row[data-active="true"]')).toBeVisible({ timeout: 20_000 });
  });
});
