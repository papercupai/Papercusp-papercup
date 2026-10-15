/**
 * Plan detail flow — /admin/plans (app-wide e2e coverage audit).
 *
 * plan-agent-launch.spec.ts already exercises the /api/admin/plans/* verbs
 * end-to-end but only smokes the PAGE (HTTP status). This spec drives the
 * actual browser flow through PlansClient / PlanRail / PlanDetail
 * (apps/operator/app/admin/plans/*):
 *
 *   1. /admin/plans renders 500-free: rail, view switcher, New plan —
 *      no app console errors,
 *   2. rail rows render with plan status badges (StatusPill,
 *      `.pc-pill--<status>`), and clicking a row writes the `?plans=`
 *      nuqs filter,
 *   3. a `?plan=<slug>` deep link opens PlanDetail (section
 *      `aria-label="Plan <slug>"` + the Editor/Revisions/Agents tablist),
 *      clicking Revisions writes `?ptab=revisions` (nuqs) and mounts the
 *      RevisionsPanel, and a reload round-trips BOTH params — the nuqs
 *      contract: the URL is the store,
 *   4. plan items render in the read-mode editor with their status
 *      decorations (`code.pc-plan-status`, plan-renderers.ts).
 *
 * Resilience (house pattern): fixtures are resolved in beforeAll from the
 * live `/api/admin/plans/list` — the SAME backend verb the UI calls. Tests
 * skip-with-message instead of hard-failing when the verb is unreachable
 * (e.g. an auth-gated rig), when zero plans exist, or when no plan has
 * items (test 4). Test-looking `e2e-*` slugs from concurrent suites are
 * deprioritized (dock.spec.ts lesson — those fixtures churn mid-run).
 *
 * NB: drives the operator-vite SPA — a stale HMR-disabled :3055 serves a
 * blank #root, so tests skip rather than fail when the shell never mounts.
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { learnPageWorkspaceHeaders } from './_page-workspace';

// Mirror playwright.config.ts's BASE_URL derivation — honoring
// OPERATOR_E2E_PORT keeps this spec on the SAME server the config's
// webServer boots (EI-208).
const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

const SKIP_MSG_BLANK =
  'The /admin/plans shell did not mount. Run against an HMR-enabled operator-vite ' +
  '(the playwright.config webServer) — a stale HMR-disabled :3055 serves a blank #root.';

interface PlanRow {
  slug: string;
  title: string | null;
  status: string;
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Record<string, number> | null;
}

let listReachable = false;
let plans: PlanRow[] = [];

test.beforeAll(async ({ request, browser }) => {
  try {
    // Resolve fixtures in the SAME workspace the page's rail lists: a bare
    // request fixture resolves against the backend's global workspace, which
    // on a fresh isolated rig is not the page's (WI-10006792).
    const probe = await browser.newPage();
    const headers = await learnPageWorkspaceHeaders(probe, `${baseURL}/admin/plans`).catch(() => ({}));
    await probe.close();
    const r = await request.get(`${baseURL}/api/admin/plans/list`, { timeout: 20_000, headers });
    if (!r.ok()) return;
    const body = (await r.json()) as { plans?: PlanRow[] };
    // Mirror the UI's default rail contents: non-archived plans.
    plans = (body.plans ?? []).filter((p) => !p.archived);
    listReachable = true;
  } catch {
    /* listReachable stays false → tests skip with a message */
  }
});

function itemTotal(p: PlanRow): number {
  if (!p.itemCounts) return 0;
  return Object.values(p.itemCounts).reduce((a, b) => a + (b ?? 0), 0);
}

/** Stable-first ordering: avoid other suites' churning e2e-* fixtures. */
function stableFirst(rows: PlanRow[]): PlanRow[] {
  return [...rows].sort((a, b) => Number(/^e2e-/.test(a.slug)) - Number(/^e2e-/.test(b.slug)));
}

/** The plan to open: prefer non-legacy with items (richest detail render). */
function pickPlan(): PlanRow | null {
  const ordered = stableFirst(plans);
  return (
    ordered.find((p) => !p.isLegacy && itemTotal(p) > 0) ??
    ordered.find((p) => !p.isLegacy) ??
    ordered[0] ??
    null
  );
}

/** A plan that definitely has items, for the status-decoration test. */
function pickItemPlan(): PlanRow | null {
  return stableFirst(plans).find((p) => !p.isLegacy && itemTotal(p) > 0) ?? null;
}

function skipWithoutPlans() {
  test.skip(
    !listReachable,
    'GET /api/admin/plans/list not reachable (auth-gated or server down) — cannot resolve a plan fixture',
  );
  test.skip(plans.length === 0, 'zero plans exist in this workspace — no plan detail to open');
}

/** Console-error scrub (adv-shell-nav.spec.ts pattern + WS/SSE transport flaps). */
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

/**
 * Navigate to /admin/plans (+search) and report whether the plans shell
 * mounted. NOTE: no waitForLoadState('networkidle') — the admin shell keeps
 * long-lived SSE/sync streams open, so the network never goes idle.
 */
async function gotoPlans(page: Page, search = ''): Promise<boolean> {
  const res = await page.goto(`${baseURL}/admin/plans${search}`, {
    waitUntil: 'domcontentloaded',
  });
  expect([200, 304]).toContain(res?.status() ?? 0);
  return page
    .locator('.pc-plans__rail')
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('/admin/plans — plan detail flow', () => {
  test('plans browser shell renders 500-free with rail + view switcher', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    const mounted = await gotoPlans(page);
    assertMounted(mounted, SKIP_MSG_BLANK);

    await expect(page.locator('[aria-label="Plans with matching items"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /New plan/ })).toBeVisible();
    // The rail's view switcher: Plans / Inbox / Sessions. The active view's
    // button carries a CSS-generated "✓" badge (plans.css "selected ✓") that
    // Chromium folds into the accessible name — so match the prefix, not exact.
    await expect(page.getByRole('button', { name: /^Plans\b/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Inbox/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sessions/ })).toBeVisible();

    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
  });

  test('rail rows render with status badges; clicking a row writes the ?plans= nuqs filter', async ({ page }) => {
    skipWithoutPlans();
    const plan = pickPlan()!;
    const mounted = await gotoPlans(page);
    assertMounted(mounted, SKIP_MSG_BLANK);

    // Rows arrive async (usePlanList) — at least one renders, each carrying
    // a status pill (StatusPill in PlanRail.tsx).
    // The default rail lists plans with matching items. A status bucket also
    // includes empty plans, which are valid fixtures in a fresh isolated DB.
    // Select the rendered lifecycle buckets rather than deriving one from
    // status alone: an active but unstarted plan belongs to Ready, not Running.
    const buckets = page.getByRole('group', { name: 'Plan status filters' }).getByRole('button');
    for (const bucket of await buckets.all()) {
      if (await bucket.getAttribute('aria-pressed') !== 'true') await bucket.click();
    }
    const rows = page.locator('.pc-plan-row');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.pc-plan-rail__rows .pc-pill').first()).toBeVisible();

    // Our fixture plan's row shows ITS status as the badge text.
    const fixtureRow = page.locator(`li[data-plan-slug="${plan.slug}"]`);
    await expect(fixtureRow).toBeVisible({ timeout: 20_000 });
    await expect(fixtureRow.locator(`.pc-pill--${plan.status}`)).toHaveText(plan.status);

    // Rail click = multi-select item filter (`?plans=`, nuqs array param) —
    // NOT the detail opener (that is the ?plan= deep link, next test).
    await fixtureRow.locator('.pc-plan-row').click();
    await expect
      .poll(() => param(page, 'plans'), { timeout: 10_000 })
      .toContain(plan.slug);
  });

  test('?plan= deep link opens the detail; Revisions opens; nuqs state round-trips a reload', async ({ page }) => {
    skipWithoutPlans();
    const plan = pickPlan()!;
    const consoleErrors = collectConsoleErrors(page);
    const mounted = await gotoPlans(page, `?plan=${encodeURIComponent(plan.slug)}`);
    assertMounted(mounted, SKIP_MSG_BLANK);

    // PlanDetail mounted for OUR slug (DetailShell aria-label) and the
    // tab strip rendered once the full plan body loaded.
    const detail = page.locator(`section[aria-label="Plan ${plan.slug}"]`);
    await expect(detail).toBeVisible({ timeout: 20_000 });
    const tablist = detail.getByRole('tablist', { name: 'Plan view' });
    await expect(tablist).toBeVisible({ timeout: 30_000 });
    await expect(tablist.getByRole('tab')).toHaveText(['Editor', 'Triggers', 'Revisions', 'Agents', 'Runs']);

    // Open the Revisions panel — the click writes `?ptab=revisions` (nuqs)
    // and mounts RevisionsPanel (any of its states carries the class).
    await tablist.getByRole('tab', { name: 'Revisions' }).click();
    await expect.poll(() => param(page, 'ptab'), { timeout: 10_000 }).toBe('revisions');
    await expect(tablist.getByRole('tab', { name: 'Revisions' })).toHaveAttribute('aria-selected', 'true');
    await expect(detail.locator('.pc-revisions-panel')).toBeVisible({ timeout: 20_000 });

    // Reload → BOTH nuqs params round-trip and the same view remounts.
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(param(page, 'plan')).toBe(plan.slug);
    expect(param(page, 'ptab')).toBe('revisions');
    await expect(page.locator(`section[aria-label="Plan ${plan.slug}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('tablist', { name: 'Plan view' }).getByRole('tab', { name: 'Revisions' }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.pc-revisions-panel')).toBeVisible({ timeout: 20_000 });

    expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
  });

  test('plan items render with status decorations in the read-mode editor', async ({ page }) => {
    skipWithoutPlans();
    const plan = pickItemPlan();
    test.skip(!plan, 'no non-legacy plan with items exists — item rendering has no fixture');

    const mounted = await gotoPlans(page, `?plan=${encodeURIComponent(plan!.slug)}`);
    assertMounted(mounted, SKIP_MSG_BLANK);

    const detail = page.locator(`section[aria-label="Plan ${plan!.slug}"]`);
    await expect(detail).toBeVisible({ timeout: 20_000 });

    // Vditor's preview render + the decoration pass (plan-renderers.ts) are
    // async; the item status markers land as `code.pc-plan-status` chips.
    await expect(detail.locator('code.pc-plan-status').first()).toBeVisible({ timeout: 30_000 });
  });
});
