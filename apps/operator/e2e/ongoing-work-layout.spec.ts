import {
  test, expect, type Locator, type Page, waitVisibleRecoveringNetworkChange, watchNetworkChange,
} from './_egress';
import { stubSyncQueries } from './_sync-stub';

const goal = {
  id: 'layout-current', title: 'Workspace steward layout', status: 'active', standing: true,
  effectiveStatus: 'active', holderLiveness: 'held', needsHuman: 31,
  spendRecentUsd: 12.34, spendRecentWindowDays: 3, budgetCents: 10000, budgetWindowSec: 604800,
};

async function prepareLayout(page: Page) {
  const projects = [{ slug: 'papercusp', name: 'papercusp', path: '/tmp/ongoing-layout-fixture',
    hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }];
  await page.route('**/api/harness/projects/lite', route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ projects }) }));
  return stubSyncQueries(page, name => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [goal], totalGoals: 1, goalPackages: [{
      ref: 'work-on-everything', title: goal.title, description: 'Advances priority work across the workspace.',
      layer: 'bundled', version: '1.0.0', standing: true, featured: true,
      budgetCents: goal.budgetCents, budgetWindowSec: goal.budgetWindowSec, activeGoalId: goal.id,
      instances: [{ goalId: goal.id, status: 'active', adoptableStub: false }],
    }] }];
    if (name === 'goals.detail') return [{ goal, holderLiveness: 'held', effectiveStatus: 'active',
      goalModeState: { portfolio: { priorities: ['Reconcile priority placement', 'Triage blocked work'] } },
      waitingOnYouTotal: 31, waitingOnYou: [{ id: 'WI-layout-approval', title: 'Choose release scope' }],
      activity: [{ id: 'WI-layout-outcome', title: 'Search repair verified', status: 'done',
        closedAt: '2026-10-06T12:00:00Z' }],
      plans: [{ planSlug: 'layout-search', harnessSlug: 'papercusp', title: 'Search plan',
        stamped: true, openItems: 2 }],
    }];
    // Model only the unrelated shell reads that share the finite request queue.
    // The real dock-layout query must still mount the HUD being exercised.
    if (name === 'taskManager.inventory') return [{ enabled: false }];
    if (name === 'hive.controlState') return [];
    if (name === 'plans.attentionCounts') return [{ decisionItems: 0, decisionPlans: 0,
      alerts: 0, total: 0, degraded: false }];
    if (name === 'plans.list' || name === 'plans.attention' || name === 'plans.attentionRefs'
      || name === 'planWorkActivity.list') return [];
    return undefined;
  });
}

async function expectLayoutFits(page: Page, surface: Locator, action: Locator) {
  await expect(surface).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport();
  const dimensions = await surface.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      left: bounds.left, right: bounds.right,
      content: el.scrollWidth, available: el.clientWidth,
    };
  });
  expect(dimensions.document, 'document horizontal overflow').toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.content, 'ongoing-work content horizontal overflow').toBeLessThanOrEqual(dimensions.available);
  expect(dimensions.left).toBeGreaterThanOrEqual(-1);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
  const control = await action.boundingBox();
  expect(control).not.toBeNull();
  expect(control!.x).toBeGreaterThanOrEqual(0);
  expect(control!.x + control!.width).toBeLessThanOrEqual(dimensions.viewport);
}

for (const width of [1280, 390]) {
  test(`ongoing-work layouts fit the document and keep controls usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sync = await prepareLayout(page);
    watchNetworkChange(page);
    await page.goto('/adv?tab=hud&scope=all&hudtab=goals&welcome=0', { waitUntil: 'domcontentloaded' });
    const tabs = page.getByRole('tablist', { name: 'HUD board' });
    await waitVisibleRecoveringNetworkChange(tabs, 30_000);
    await sync.waitForServed(['goals.list', 'goals.detail']);
    const rail = page.getByTestId('goal-packages-rail');
    await expectLayoutFits(page, rail, rail.getByRole('button', { name: 'View ongoing work', exact: true }));
    await expect(rail.getByText('Reconcile priority placement')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`ongoing-layout-${width}-featured.png`) });

    await tabs.getByRole('tab', { name: 'Sessions', exact: true }).click();
    const open = rail.getByRole('button', { name: 'View work', exact: true });
    await expectLayoutFits(page, rail, open);
    await expect(rail.getByText('31 needs you')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`ongoing-layout-${width}-compact.png`) });

    await open.click();
    const overview = page.locator('.hud-ongoing--detail');
    await expectLayoutFits(page, overview, overview.getByRole('button', { name: 'Search plan', exact: true }));
    await expect(overview.getByText('$12.34 in the last 3 days', { exact: false })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`ongoing-layout-${width}-detail.png`) });
    sync.assertServed('goals.list', 'goals.detail');
  });
}
