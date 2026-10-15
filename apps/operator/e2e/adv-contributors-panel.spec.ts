/**
 * /adv Contributors panel (P-048) — live browser render + screenshot.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 (P-048),
 * and the user-requested "capture the live UI, saved as a repeatable test"
 * (2026-06-02). This is the FIRST e2e coverage of the /adv dock panels.
 *
 * What this verifies that the jsdom render test
 * (app/adv/harnesses/__tests__/AdvContributorsPanel.test.tsx) cannot:
 *   - the panel actually mounts in the live /adv shell dock (operator-vite SPA)
 *     via the real "Add panel" catalog flow, in a real browser engine
 *   - the real GET /api/harness/:slug/contributors fetch + GET /api/viewer
 *     wiring runs (both stubbed here for deterministic rows — the endpoint's
 *     own SQL is verified live elsewhere)
 *   - the tier badges, P-048d zeroing of unverified contributors, and the
 *     "(you)" viewer marker render correctly end-to-end
 *   - a captured screenshot artifact (test-results + a committed copy)
 *
 * Data is stubbed via route interception so the test is hermetic — it does
 * not depend on the substrate being populated (it is empty on a dev box until
 * a harness goes through the ShareWizard).
 *
 * NB: the /adv operator UI is designed for the Tauri (WebKitGTK) shell; this
 * spec drives the same SPA in the e2e Chromium project (the sanctioned
 * browser-E2E framework). The dock-height absolute-fill hack in
 * HarnessesDock.tsx makes the layout engine-agnostic, so the panel renders in
 * both; pixel-identical WebKitGTK capture is out of scope here.
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;
// papercup lives in papercusp-workspace (the /adv shell's active workspace).
// The contributors API is stubbed, so the slug only needs to mount the dock.
const SLUG = process.env.ADV_CONTRIB_E2E_SLUG ?? 'papercup';

const ARTIFACT_DIR = join(import.meta.dirname, '__artifacts__');

// Two contributors: a VERIFIED viewer (alice, id 42) with real tier numbers,
// and an UNVERIFIED peer (bob, id 7) whose non-zero raw stats MUST be zeroed
// by the panel's P-048d gate (statsAggregateForStatus).
const CONTRIBUTORS = [
  {
    github_user_id: 42,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    joined_at: 1_700_000_000_000,
    last_seen_at: null,
    binding_status: 'verified',
    binding_last_checked_at: null,
    device_count: 2,
    prs_merged: 3,
    features_shipped: 4,
    activity_events: 5,
  },
  {
    github_user_id: 7,
    github_username: 'bob',
    display_name: null,
    avatar_url: null,
    joined_at: 1_690_000_000_000,
    last_seen_at: null,
    binding_status: 'unverified',
    binding_last_checked_at: null,
    device_count: 0,
    // raw non-zero values the panel must ZERO because bob is unverified:
    prs_merged: 9,
    features_shipped: 9,
    activity_events: 9,
  },
];

async function stubApis(page: Page): Promise<SyncQueryStub> {
  // The panel reads its rows through the `contributors.byHarness` SYNC query
  // (AdvContributorsPanel useSyncQuery), not the REST route below — a REST-only
  // stub was silently bypassed and the panel rendered 0 rows on a fresh DB
  // (WI-10006792). The REST routes stay for any non-sync caller.
  const sync = await stubSyncQueries(page, (name) => {
    if (name === 'contributors.byHarness') return CONTRIBUTORS;
    if (name === 'harnessProjects.lite') {
      return [{ slug: SLUG, path: `/tmp/${SLUG}`, name: SLUG, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project' }];
    }
    return undefined;
  });
  await page.route('**/api/harness/**/contributors', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ contributors: CONTRIBUTORS }),
    });
  });
  // alice (42) is the viewer → her row gets the "(you)" marker.
  await page.route('**/api/viewer', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ github_user_id: 42, github_login: 'alice' }),
    });
  });
  // The shell keeps ?scope=self (per-harness dock) only when the active slug
  // is present in /api/harness/projects/lite — stub it so the dock mounts for
  // SLUG regardless of which harnesses the live workspace actually has.
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [{ slug: SLUG, name: SLUG, parent_slug: null, harness_kind: 'project' }],
      }),
    });
  });
  return sync;
}

/**
 * Returns true once the per-harness dock has mounted (the toolbar "Add panel"
 * affordance is visible). Returns false if the /adv shell never rendered it —
 * which happens against an HMR dev server in a broken state (a known
 * `'/@vite/client' … createHotContext` mismatch on a stale local :3055). The
 * caller skips rather than fails in that case; the prebuilt bundle (vite
 * preview, and a clean CI build) renders fine.
 */
async function dockMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

async function openContributorsPanel(page: Page) {
  await page.getByRole('button', { name: 'Add panel' }).click();
  const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
  await expect(catalog).toBeVisible();
  // Contributors must be in the catalog allowlist (HarnessTopBar) — it was
  // missing until 2026-06-02, registered but unreachable. This click is the
  // regression guard for that.
  await catalog.getByText('Contributors', { exact: true }).first().click();
}

test.describe('/adv Contributors panel (P-048)', () => {
  test('renders verified + zeroed-unverified rows with the viewer marker', async ({ page }) => {
    const sync = await stubApis(page);
    const mounted = await dockMounts(page);
    assertMounted(
      mounted,
      'The /adv shell did not mount the dock. Inspect the Playwright trace and Vite output; ' +
        'this assertion does not establish why mounting failed.',
    );
    await openContributorsPanel(page);
    // Falsifier: the stub must actually be hit, or the row assertions below
    // would be measuring unstubbed (empty) live data.
    await sync.waitForServed(['contributors.byHarness']);

    const rows = page.locator('.pc-adv-contributors__row');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    const aliceRow = rows.filter({ hasText: '@alice' });
    const bobRow = rows.filter({ hasText: '@bob' });
    await expect(aliceRow).toHaveCount(1);
    await expect(bobRow).toHaveCount(1);

    // verified alice: real tier numbers
    await expect(aliceRow).toContainText('✓3 PR');
    await expect(aliceRow).toContainText('✓4 shipped');
    await expect(aliceRow).toContainText('5 act');
    await expect(aliceRow).toContainText('2 devices');
    // viewer marker + profile link
    await expect(aliceRow.getByText('(you)')).toBeVisible();
    await expect(aliceRow.locator('a.pc-adv-contributors__who')).toHaveAttribute(
      'href',
      '/users/github/42',
    );

    // unverified bob: P-048d zeroes the stats despite the stub sending 9s
    await expect(bobRow).toContainText('✓0 PR');
    await expect(bobRow).toContainText('✓0 shipped');
    await expect(bobRow).toContainText('0 act');
    // and is greyed (opacity dimmed)
    await expect(bobRow).toHaveAttribute('style', /opacity/);

    // Capture the live screenshot artifact the verification calls for.
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    await page
      .locator('.pc-adv-contributors')
      .screenshot({ path: join(ARTIFACT_DIR, 'adv-contributors-panel.png') });
  });

  test('Add-panel catalog lists both Contributors and Insights (reachability)', async ({ page }) => {
    await stubApis(page);
    const mounted = await dockMounts(page);
    assertMounted(mounted, 'The /adv shell did not mount the dock.');
    await page.getByRole('button', { name: 'Add panel' }).click();
    const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
    await expect(catalog).toBeVisible();
    // Both were registered in HarnessesDock but absent from the catalog
    // allowlist until 2026-06-02 — unreachable to users. Guard both.
    await expect(catalog.getByText('Contributors', { exact: true })).toBeVisible();
    await expect(catalog.getByText('Insights', { exact: true })).toBeVisible();
  });
});
