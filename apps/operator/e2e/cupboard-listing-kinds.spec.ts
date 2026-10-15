/**
 * Cupboard storefront — three listing kinds + filter + per-kind action (E4).
 *
 * Plan: harness-blueprint-distribution-2026-06-03 (P-007 / D-005). Verifies the
 * live browser behavior the jsdom component test
 * (app/cupboard/__tests__/CupboardClient.test.tsx) can't:
 *   - the kind filter tabs render and drive the `?kind=` query the proxy forwards
 *   - clicking a kind tab re-fetches + filters the grid to that kind
 *   - each card's primary action is the listing's action (View Hive for a
 *     hive-bound harness row, none for a legacy one — per-harness join is
 *     retired, comb-retire-per-harness-sharing-2026-06-11 — Fork/Install
 *     for blueprint/plugin/pack)
 *
 * Hermetic: `/api/cupboard/listings` is stubbed (and honors the `kind` query
 * param) so the test does not need a live Cupboard worker. Drives the
 * operator-vite SPA in the e2e Chromium project (the sanctioned browser-E2E
 * framework); the storefront is engine-agnostic.
 */
import { test, expect, assertMounted, type Page } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

interface Listing {
  id: string;
  listing_kind: 'harness' | 'blueprint' | 'pack' | 'plugin';
  title: string;
  description: string;
  claim_status: 'unclaimed' | 'claimed';
  github_owner: string;
  github_name: string;
  github_url: string;
  topic_hex: string | null;
  project_ref: string | null;
  listing_ref: string | null;
  last_activity_at: number | null;
  publisher_permission: string | null;
  hive_pubkey?: string | null;
  hive_title?: string | null;
}

const LISTINGS: Listing[] = [
  {
    // Hive-bound member-repo row (worker mig 007): action = View Hive.
    id: 'h1', listing_kind: 'harness', title: 'Demo harness', description: 'A shared harness',
    claim_status: 'unclaimed', github_owner: 'o', github_name: 'h', github_url: 'https://github.com/o/h',
    topic_hex: 'a'.repeat(64), project_ref: 'o/h', listing_ref: null, last_activity_at: null, publisher_permission: 'write',
    hive_pubkey: 'A'.repeat(43) + '=', hive_title: 'Demo Hive',
  },
  {
    id: 'b1', listing_kind: 'blueprint', title: 'Web App blueprint', description: 'A blueprint stream',
    claim_status: 'unclaimed', github_owner: 'papercupai', github_name: 'demo', github_url: 'https://github.com/papercupai/demo',
    topic_hex: null, project_ref: 'papercupai/demo', listing_ref: 'web-app', last_activity_at: null, publisher_permission: 'admin',
  },
  {
    id: 's1', listing_kind: 'pack', title: 'Demo pack', description: 'A runtime-less code-tool pack',
    claim_status: 'unclaimed', github_owner: 'papercupai', github_name: 'demo', github_url: 'https://github.com/papercupai/demo',
    topic_hex: null, project_ref: 'papercupai/demo', listing_ref: 'pack-3', last_activity_at: null, publisher_permission: 'admin',
  },
  {
    id: 'p1', listing_kind: 'plugin', title: 'Slack notify', description: 'A distributable plugin',
    claim_status: 'unclaimed', github_owner: 'papercupai', github_name: 'plugins', github_url: 'https://github.com/papercupai/plugins',
    topic_hex: null, project_ref: 'papercupai/plugins', listing_ref: 'slack-notify', last_activity_at: null, publisher_permission: 'admin',
  },
];

async function stubCupboard(page: Page) {
  await page.route('**/api/cupboard/listings**', async (route) => {
    const url = new URL(route.request().url());
    const kind = url.searchParams.get('kind');
    const project = url.searchParams.get('project');
    // Mirror the worker: `project` (per-Hive rollup, D-005) narrows by
    // project_ref and supersedes `kind`; otherwise `kind` filters.
    let listings = LISTINGS;
    if (project) listings = listings.filter((l) => l.project_ref === project);
    else if (kind) listings = listings.filter((l) => l.listing_kind === kind);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ listings }),
    });
  });
}

/** Mount /cupboard; false if the SPA didn't render (stale HMR :3055 — see
 *  adv-contributors-panel.spec.ts for the same defensive skip). */
async function cupboardMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/cupboard`, { waitUntil: 'domcontentloaded' });
  return page
    .getByTestId('cupboard-kind-tab-all')
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('Cupboard storefront — three listing kinds (E4)', () => {
  test('filters by kind and shows the correct per-kind action', async ({ page }) => {
    await stubCupboard(page);
    const mounted = await cupboardMounts(page);
    assertMounted(
      mounted,
      // EI-19917451944474469: don't assert a specific unverified cause here — a
      // near-identical "stale HMR" claim on a sibling spec was measured wrong.
      'The /cupboard SPA did not mount. Check OPERATOR_E2E_REUSE_SERVER/PAPERCUSP_ENABLE_HMR ' +
        'and inspect the trace/screenshot attached to this failure.',
    );

    // All kinds visible initially. Hive-first browse (P-002): the hive-bound
    // harness row folds into ONE card for its owning hive (no kind badge, opened
    // via "View <pot>"); every other kind is a plain badged listing card.
    await expect(page.getByTestId('cupboard-hive-card')).toHaveCount(1);
    await expect(page.getByTestId('cupboard-hive-card-open')).toHaveCount(1);
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveCount(3);
    // Action buttons reflect each plain listing's action. The `fork` action is
    // retired: listingActionFor() (packages/operator-core/lib/cupboard/types.ts)
    // maps blueprint, plugin and pack all to 'install' (clone the listing).
    await expect(page.locator('[data-testid="cupboard-action"][data-action="fork"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cupboard-action"][data-action="install"]')).toHaveCount(3);   // blueprint + plugin + pack

    // Filter to Blueprints → one blueprint card, action = install.
    await page.getByTestId('cupboard-kind-tab-blueprint').click();
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveCount(1);
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveAttribute('data-kind', 'blueprint');
    await expect(page.locator('[data-testid="cupboard-action"]')).toHaveAttribute('data-action', 'install');

    // Filter to Plugins → one plugin card, action = install.
    await page.getByTestId('cupboard-kind-tab-plugin').click();
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveCount(1);
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveAttribute('data-kind', 'plugin');
    await expect(page.locator('[data-testid="cupboard-action"]')).toHaveAttribute('data-action', 'install');

    // Back to Harnesses → still hive-first: the hive-bound row is reached
    // through its hive card (per-harness join is retired), and no plain
    // listing card or per-row action renders for it.
    await page.getByTestId('cupboard-kind-tab-harness').click();
    await expect(page.getByTestId('cupboard-hive-card-open')).toHaveCount(1);
    await expect(page.getByTestId('cupboard-kind-badge')).toHaveCount(0);
  });

  test('per-Hive rollup groups a project\'s facets together (D-005)', async ({ page }) => {
    await stubCupboard(page);
    const mounted = await cupboardMounts(page);
    assertMounted(
      mounted,
      // EI-19917451944474469: don't assert a specific unverified cause here — a
      // near-identical "stale HMR" claim on a sibling spec was measured wrong.
      'The /cupboard SPA did not mount. Check OPERATOR_E2E_REUSE_SERVER/PAPERCUSP_ENABLE_HMR ' +
        'and inspect the trace/screenshot attached to this failure.',
    );

    // Each card carries a Hive chip; the `papercupai/demo` project has two
    // facets (blueprint + pack). Click its chip to enter the rollup.
    const hiveChip = page.locator('[data-testid="cupboard-hive-chip"][data-hive="papercupai/demo"]').first();
    await expect(hiveChip).toBeVisible();
    await hiveChip.click();

    // Rollup mode: header names the Hive; kind tabs are hidden.
    await expect(page.getByTestId('cupboard-hive-header')).toBeVisible();
    await expect(page.getByTestId('cupboard-hive-name')).toHaveText('papercupai/demo');
    await expect(page.getByTestId('cupboard-kind-tab-all')).toHaveCount(0);

    // Only the Hive's two facets are grouped; the other kinds are absent.
    await expect(page.getByTestId('cupboard-hive-group-blueprint')).toBeVisible();
    await expect(page.getByTestId('cupboard-hive-group-pack')).toBeVisible();
    await expect(page.getByTestId('cupboard-hive-group-harness')).toHaveCount(0);
    await expect(page.getByTestId('cupboard-hive-group-plugin')).toHaveCount(0);

    // Back → flat browse, tabs return, header gone.
    await page.getByTestId('cupboard-hive-back').click();
    await expect(page.getByTestId('cupboard-kind-tab-all')).toBeVisible();
    await expect(page.getByTestId('cupboard-hive-header')).toHaveCount(0);
  });
});
