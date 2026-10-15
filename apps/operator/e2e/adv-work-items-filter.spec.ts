/**
 * /adv Work-items panel — column FILTER BAR end-to-end (real browser).
 *
 * Bug (user-reported, 2026-06-14): on the /adv "Working" tab WorkItemsPanel,
 * clicking the "+ Add filter" dropdown and picking a column "does nothing" —
 * the per-column filter editor popover never opens.
 *
 * Root cause (ColumnFilterBar.tsx): the `+ Add filter` is a Radix <Select>.
 * On selection it set `editingKey` SYNCHRONOUSLY inside `onValueChange`, which
 * mounts the editor <Popover> in the SAME click gesture. The Select's closing
 * pointer event then lands on the freshly-mounted Popover's dismissable layer
 * as an "outside" interaction and dismisses it instantly. The fix defers the
 * open to a MACROTASK (`setTimeout(() => setEditingKey(key), 0)`) so the Select
 * fully closes + the gesture drains before the Popover mounts. requestAnimation-
 * Frame is NOT enough (it runs before paint, still in the Select's task tail);
 * only setTimeout escapes the race. The same `openEditor` defer also guards
 * clicking an existing chip to re-edit it.
 *
 * Why an e2e (not a jsdom render test): the dismiss is a REAL Radix
 * dismissable-layer pointer-event race — jsdom fires no layout/pointer events
 * for it, so the synchronous version "passes" there. Only a real browser engine
 * reproduces the bug. Flip the defer back to synchronous `setEditingKey(key)`
 * (or rAF, which is also insufficient) and this spec goes red — the causation
 * guard for the fix.
 *
 * ONE test, ONE mount: the /adv dock mount is the expensive + occasionally-flaky
 * step against a reused dev server, so we mount once and exercise every editor
 * type + interaction in sequence rather than re-mounting per case (a batch of
 * separate mounts was flaky when run together; each passed in isolation).
 *
 * Hermetic via route-stubbing (mirrors adv-dep-graph-interlock.spec.ts): the
 * shell's projects/lite is stubbed so the slug always mounts the dock, and the
 * sync layer is stubbed through `_sync-stub.ts` so `workItems.byHarness` returns
 * a couple of rows and `workItems.summary` returns their facets (the State/Kind
 * enum option lists come from the summary, not the rows) without depending on a
 * populated substrate. This spec used to stub
 * `POST /api/zero-harness/rest-query-batch`, which the client has not spoken
 * since 2026-07-26 — the stub was never hit and the panel rendered from real,
 * unstubbed traffic (WI-39533).
 *
 * NB: like the sibling adv specs this drives the operator-vite SPA in the e2e
 * Chromium project. A stale HMR-disabled :3055 serves a blank #root — the shell
 * never mounts and the spec SKIPS (it does not falsely fail). Run against an
 * HMR-enabled Vite (the config's own webServer boots one) to actually exercise it.
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched.
const SLUG = process.env.ADV_WI_FILTER_E2E_SLUG ?? 'e2e-wi-filter-pot';

// Two stubbed work items so the enum option lists (State / Kind) are non-empty.
// `family` drives which status-pill table the State cell renders from — both
// values present so neither render path is skipped.
const WORK_ITEMS = [
  {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    title: 'First stubbed item',
    summary: null,
    state: 'open',
    assignee: 'alice',
    assignedBy: null,
    severity: 'high',
    priority: 1,
    rank: 1,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-06-14T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
  {
    id: 'F-2',
    kind: 'feature',
    family: 'feature',
    title: 'Second stubbed item',
    summary: null,
    state: 'in_progress',
    assignee: 'bob',
    assignedBy: null,
    severity: null,
    priority: 2,
    rank: 2,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-06-14T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
  },
];

/**
 * The enum option lists (State / Kind / …) are the SERVER's drill-down facets,
 * read from the `workItems.summary` sync query (WorkItemsPanel →
 * workItemFacetOptions in app/adv/harnesses/work-item-list-query.ts), NOT
 * re-derived from the loaded rows. Unstubbed, that query answers from the real
 * (empty) DB and every option list is empty. Derived from WORK_ITEMS so the two
 * stubs can never disagree about what the panel holds.
 */
const FACET_KEYS = ['kind', 'state', 'assignee', 'severity'] as const;
const WORK_ITEMS_SUMMARY = {
  total: WORK_ITEMS.length,
  matched: WORK_ITEMS.length,
  facets: FACET_KEYS.map((key) => {
    const counts = new Map<string, number>();
    for (const row of WORK_ITEMS) {
      const value = row[key];
      if (typeof value === 'string' && value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const values = [...counts].map(([value, count]) => ({ value, count }));
    return { key, values, hiddenValueCount: 0, distinctCount: values.length };
  }),
};

const SKIP_MSG =
  'The /adv shell did not mount the Work items panel. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

/**
 * The harness registry row for the fictional slug. Served over BOTH paths that
 * carry it — the REST bootstrap (`/api/harness/projects/lite`) and the sync query
 * (`harnessProjects.lite`). Stubbing only one leaves the slug unresolvable on the
 * other, and the dock then mounts no panels at all.
 */
const PROJECTS = [
  {
    slug: SLUG,
    path: `/tmp/${SLUG}`,
    name: SLUG,
    hasState: true,
    hasSpec: true,
    parent_slug: null,
    harness_kind: 'project',
    is_shared: false,
  },
];

/**
 * Stub the data the shell + panel need so this is hermetic:
 *   - projects/lite validates the URL slug (keeps the persisted-selection
 *     restore from flipping to all-mode and hiding the per-pot dock),
 *   - status/lanes/agents keep the top bar benign,
 *   - the sync layer returns rows per query NAME over the LIVE contract, one
 *     `GET /api/zero-harness/rest-query?name=&args=` per query (see
 *     `_sync-stub.ts`). Queries this spec does not model return `undefined` and
 *     FALL THROUGH — answering `[]` for everything starves the dock layout.
 */
async function stubApis(page: Page): Promise<SyncQueryStub> {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: PROJECTS }),
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

  return stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return PROJECTS;
    if (name === 'workItems.byHarness') return WORK_ITEMS;
    // One summary row per query (WorkItemsPanel reads `summaryQuery.data?.[0]`).
    if (name === 'workItems.summary') return [WORK_ITEMS_SUMMARY];
    return undefined;
  });
}

/**
 * Drives to the harnesses ("Working") dock and reports whether it mounted.
 * `welcome=0` suppresses the no-work HarnessWelcome overlay (default-on,
 * gated on useHarnessHasNoWork) — with the empty features/issues stubs above
 * it otherwise covers the dock and intercepts every click (mirrors the same
 * fix in adv-dep-graph-interlock.spec.ts's dockMounts).
 */
async function dockMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self&welcome=0`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Ensure a Work items panel is mounted + focused via the real Add-panel catalog
 * (the user-facing flow). The default dock layout already seeds one; the catalog
 * click focuses that existing instance rather than duplicating it. Either way the
 * filter bar ends up on screen. Returns the bar root locator.
 */
async function openWorkItemsPanel(page: Page) {
  await page.getByRole('button', { name: 'Add panel' }).click();
  const catalog = page.getByRole('dialog', { name: 'Panel catalog' });
  await expect(catalog).toBeVisible();
  await catalog.getByText('Work items', { exact: true }).first().click();

  // The filter bar renders from the panel's static filterable columns even with
  // zero rows, so it is the stable anchor for "the panel is up".
  const bar = page.locator('.pc-advpanel__filterbar').first();
  await expect(bar).toBeVisible({ timeout: 15_000 });
  return bar;
}

function wifParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('wif');
}

test.describe('/adv Work items panel — column filter bar', () => {
  test('add (dismiss-race), chip-edit reopen, Clear all, and text/number Enter-to-close', async ({
    page,
  }) => {
    const sync = await stubApis(page);
    const mounted = await dockMounts(page);
    assertMounted(mounted, SKIP_MSG);

    const bar = await openWorkItemsPanel(page);

    // Prove the stub is actually feeding the panel BEFORE the enum-option
    // assertions below: a bypassed stub then fails in seconds with a diagnostic
    // instead of surfacing as an empty option list at the locator's timeout.
    await sync.waitForServed(['workItems.byHarness', 'workItems.summary']);
    const addFilter = bar.getByRole('combobox', { name: 'Add a column filter' });
    await expect(addFilter).toBeVisible();

    // ── 1. ENUM add — the dismiss-race fix. Picking a column from the Select
    //       must OPEN the editor and keep it open. With the synchronous (buggy)
    //       setEditingKey the Select's closing pointer event dismisses it in the
    //       same gesture, so this dialog never appears.
    await addFilter.click();
    await page.getByRole('option', { name: 'State', exact: true }).click();
    const stateEditor = page.getByRole('dialog', { name: 'Edit State filter' });
    await expect(stateEditor).toBeVisible({ timeout: 5_000 });
    // The enum editor lists the live values derived from the stubbed rows.
    await expect(stateEditor.getByText('open', { exact: true })).toBeVisible();
    await expect(stateEditor.getByText('in_progress', { exact: true })).toBeVisible();
    await stateEditor.getByRole('checkbox', { name: 'open' }).click();
    const stateChip = bar.locator('.pc-advpanel__chip', { hasText: 'State: open' });
    await expect(stateChip).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).not.toBeNull();
    await stateEditor.getByRole('button', { name: 'Close filter editor' }).click();
    await expect(stateEditor).toBeHidden({ timeout: 5_000 });

    // ── 2. CHIP-EDIT — clicking an existing chip must REOPEN its editor. This
    //       path also set editingKey synchronously and hit the same dismiss
    //       race; the shared openEditor setTimeout(0) defer fixes it.
    await stateChip.click();
    const reopened = page.getByRole('dialog', { name: 'Edit State filter' });
    await expect(reopened).toBeVisible({ timeout: 5_000 });
    await reopened.getByRole('button', { name: 'Close filter editor' }).click();
    await expect(reopened).toBeHidden({ timeout: 5_000 });

    // ── 3. CLEAR ALL — drops the chip + the wif URL param.
    await bar.getByRole('button', { name: 'Clear all' }).click();
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'State: open' })).toHaveCount(0);
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).toBeNull();

    // ── 4. TEXT + Enter — value saves live as you type; Enter SAVES + CLOSES the
    //       box (the user-requested behaviour).
    await addFilter.click();
    await page.getByRole('option', { name: 'Title', exact: true }).click();
    const titleEditor = page.getByRole('dialog', { name: 'Edit Title filter' });
    await expect(titleEditor).toBeVisible({ timeout: 5_000 });
    const titleInput = titleEditor.getByRole('textbox', { name: 'Filter Title' });
    await titleInput.fill('First');
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'Title: First' })).toBeVisible();
    await titleInput.press('Enter');
    await expect(titleEditor).toBeHidden({ timeout: 5_000 });
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'Title: First' })).toBeVisible();
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).toContain('title:');
    await bar.getByRole('button', { name: 'Clear all' }).click();
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).toBeNull();

    // ── 5. NUMBER + Enter — same: typing a bound saves live, Enter closes.
    await addFilter.click();
    await page.getByRole('option', { name: 'Prio', exact: true }).click();
    const prioEditor = page.getByRole('dialog', { name: 'Edit Prio filter' });
    await expect(prioEditor).toBeVisible({ timeout: 5_000 });
    const prioMin = prioEditor.getByRole('spinbutton', { name: 'Prio minimum' });
    await prioMin.fill('2');
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'Prio: ≥2' })).toBeVisible();
    await prioMin.press('Enter');
    await expect(prioEditor).toBeHidden({ timeout: 5_000 });
    await expect(bar.locator('.pc-advpanel__chip', { hasText: 'Prio: ≥2' })).toBeVisible();
    await expect.poll(() => wifParam(page), { timeout: 10_000 }).toContain('priority:');

    // The falsifier for this spec's own hermeticity: if the sync stub was never
    // reached, every assertion above ran against real, unstubbed traffic.
    sync.assertServed('workItems.byHarness');
  });
});
