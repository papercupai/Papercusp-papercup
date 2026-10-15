/**
 * /adv Work-items DETAIL PANE + chat-launch end-to-end (real browser).
 *
 * WI-3238: the unified work-item Detail pane (DetailPanel → WorkItemDetail) and
 * its "Chat" affordance (EI-290 / WI-125) had unit coverage but no e2e — the
 * real journey a user takes was never exercised through a browser:
 *
 *   pick a work item in the grid  →  the Detail pane renders that item  →
 *   click "Chat"  →  a worker chat is created for it and a chat panel opens.
 *
 * Why an e2e and not just the jsdom render tests (WorkItemDetail.test.tsx):
 * the flow crosses THREE seams a jsdom test stubs away — the dockview
 * master-detail layout (the seeded Work-items-over-Detail split), the nuqs
 * `?sel` selection contract that couples the grid row-click to the Detail
 * pane, and `openFeatureChat`'s window-event → dock-drain that mounts the chat
 * panel. Only a real engine renders the dock + honours the event drain.
 *
 * Hermetic via route-stubbing (mirrors adv-work-items-filter.spec.ts): the
 * shell's projects/lite is stubbed so the slug always mounts the dock; the sync
 * batch returns two WI rows; the harness status / issues-list REST bootstraps
 * (which the Detail pane's useHarnessFeatures / useHarnessIssues gate on — a
 * null features/issues keeps the pane on "Loading…") return empty; and the
 * agent-chats list/create/load endpoints are stubbed so the chat launches
 * without a populated substrate.
 *
 * Like the sibling adv specs this drives the operator-vite SPA in the e2e
 * Chromium project. A stale HMR-disabled :3055 serves a blank #root — the shell
 * never mounts and the spec SKIPS (it does not falsely fail). Run against an
 * HMR-enabled Vite (the config's own webServer boots one) to actually exercise it.
 */
import { test, expect, assertMounted, type Page, type Route } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';
import type { WorkItemPresentation } from '@papercusp/operator-core/lib/work-item-presentation-contract';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

// Fictional slug — valid because projects/lite is stubbed; hermetic because no
// real workspace harness is touched. Unique so no persisted dock layout for a
// real slug hydrates over the default Work-items-over-Detail seed.
const SLUG = process.env.ADV_WI_DETAIL_E2E_SLUG ?? 'e2e-wi-detail-pot';

// Two stubbed work items. Both carry WI-* ids so `resolveSelectionKind` routes
// them to the unified WorkItemDetail (F-*/I-* would take the feature/issue
// detail paths, which read different lists).
const WORK_ITEMS = [
  {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    title: 'First stubbed item',
    summary: 'A stubbed work item used to exercise the detail pane.',
    state: 'open',
    assignee: 'alice',
    assignedBy: null,
    severity: 'high',
    priority: 1,
    rank: 1,
    planSlug: null,
    spineRole: null,
    spineStatus: null,
    updatedAt: '2026-07-06T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    presentation: {
      stage: 'candidate', reason: 'awaiting-qualifying-acceptance', evidenceRefs: [], completionRef: null,
    } satisfies WorkItemPresentation,
  },
  {
    id: 'WI-2',
    kind: 'task',
    family: 'issue',
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
    updatedAt: '2026-07-06T00:00:00.000Z',
    origin: null,
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    presentation: {
      stage: 'accepted-active', reason: 'accepted-work-reserved', evidenceRefs: [], completionRef: null,
      workEvidence: {
        reservation: { owner: 'bob', claimedAt: '2026-07-06T00:00:00.000Z' },
        recentItemWork: { status: 'unknown', at: null, windowMs: 600000, writer: 'work_items.last_progress_at' },
        waiting: { status: 'registered', refs: ['work-item:done:WI-dependency'] },
        nativeAttestation: { status: 'unknown', reason: 'No owner-bound native observation' },
      },
    } satisfies WorkItemPresentation,
  },
];

const SKIP_MSG =
  'The /adv shell did not mount the harnesses dock. Run against an HMR-enabled ' +
  'operator-vite (the config webServer boots one with PAPERCUSP_ENABLE_HMR=1) — a ' +
  "stale HMR-disabled :3055 serves a blank #root ('/@vite/client' noop stub).";

// Records every agent-chat CREATE (POST) the page makes, so a test can assert
// the chat-launch fired with the right work-item binding.
interface CreatedChat {
  role?: string;
  featureId?: string | null;
  title?: string | null;
}

/**
 * The harness registry row for the fictional slug, served over BOTH paths that
 * carry it — the REST bootstrap (`/api/harness/projects/lite`) and the sync
 * query (`harnessProjects.lite`). Stubbing only one leaves the slug
 * unresolvable on the other and the dock mounts no panels.
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

async function stubApis(page: Page, created: CreatedChat[]): Promise<SyncQueryStub> {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: PROJECTS }),
    });
  });

  // Top-bar status + the Detail pane's useHarnessFeatures REST bootstrap both
  // hit /status — carry BOTH shapes (counts for the bar, features:[] so the
  // features list resolves to [] and the pane leaves "Loading…").
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 }, features: [] }),
    });
  });
  // useHarnessIssues REST bootstrap — issues:[] so the issues list resolves.
  await page.route('**/api/harness/*/issues-list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ issues: [], pending: [] }),
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
      body: JSON.stringify({ agents: [], runs: [] }),
    });
  });

  // Agent-chats: the reuse-check LIST (GET …/agent-chats), the CREATE
  // (POST …/agent-chats) and the ChatPanel LOAD (GET …/agent-chats/<id>).
  // Ordered before the generic list route below? No — Playwright matches the
  // MOST-RECENTLY-registered route first, so this specific one must be
  // registered AFTER the batch route (it is). We disambiguate by method + path.
  await page.route('**/api/harness/*/agent-chats**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Path after …/agent-chats : '' for list/create, '/<id>…' for a specific chat.
    const tail = url.pathname.replace(/^.*\/agent-chats/, '');
    const hasChatId = tail.length > 1; // '' or '/' → list/create; '/<id>' → specific

    if (!hasChatId) {
      if (req.method() === 'POST') {
        const body = (req.postDataJSON() ?? {}) as {
          role?: string;
          feature_id?: string | null;
          title?: string | null;
        };
        created.push({ role: body.role, featureId: body.feature_id, title: body.title });
        // Return title:null so the opened dock tab falls back to the
        // distinctive `${role} · ${featureId}` label the drain computes.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'chat-e2e-1',
            role: body.role ?? 'worker',
            feature_id: body.feature_id ?? null,
            title: null,
          }),
        });
        return;
      }
      // GET list → empty so openFeatureChat takes the create path.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [] }),
      });
      return;
    }

    // Specific chat load / delete — benign so ChatPanel mounts without error.
    if (req.method() === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'chat-e2e-1',
        role: 'worker',
        feature_id: 'WI-1',
        title: null,
        mode: 'discuss',
        messages: [],
      }),
    });
  });

  // Sync — rows per query NAME over the LIVE contract: one
  // `GET /api/zero-harness/rest-query?name=&args=` per query (see
  // `_sync-stub.ts`). The grid + Detail pane read byHarness; the pane also
  // issues its own 1-row `workItems.detail`. Everything this spec does not
  // model returns `undefined` and FALLS THROUGH — answering `[]` for every
  // query starves the dock layout (dockLayouts.byName → "layout not found").
  return stubSyncQueries(page, (name, args) => {
    if (name === 'harnessProjects.lite') return PROJECTS;
    if (name === 'workItems.byHarness') return WORK_ITEMS;
    if (name === 'workItems.detail') {
      const id = typeof args.id === 'string' ? args.id : '';
      return WORK_ITEMS.filter((w) => w.id === id);
    }
    return undefined;
  });
}

/**
 * Drives to the harnesses dock and reports whether it mounted. `welcome=0`
 * suppresses the no-work HarnessWelcome overlay (default-on, gated on
 * useHarnessHasNoWork) — with empty features/issues stubs it otherwise covers
 * the dock and intercepts every click.
 */
async function dockMounts(page: Page, sel?: string): Promise<boolean> {
  const selPart = sel ? `&sel=${sel}` : '';
  await page.goto(`${baseURL}/adv?tab=harnesses&slug=${SLUG}&scope=self&welcome=0${selPart}`, {
    waitUntil: 'domcontentloaded',
  });
  return page
    .getByRole('button', { name: 'Add panel' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

test.describe('/adv work-item Detail pane + chat launch', () => {
  test('deep-linked work item renders the Detail pane and its Chat button launches a worker chat', async ({
    page,
  }) => {
    const created: CreatedChat[] = [];
    const sync = await stubApis(page, created);
    const mounted = await dockMounts(page, 'WI-1');
    assertMounted(mounted, SKIP_MSG);

    // Prove the stub is feeding the panes BEFORE the 20s content wait below: a
    // bypassed stub then fails in seconds with a diagnostic instead of
    // surfacing as an unexplained empty pane.
    await sync.waitForServed(['workItems.byHarness']);

    // The seeded Detail pane resolves ?sel=WI-1 against workItems.byHarness and
    // renders WorkItemDetail — id + title in the header, the Chat action below.
    const detail = page.locator('.pc-adv-detail').first();
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('First stubbed item', {
      timeout: 20_000,
    });
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-1');
    const chatBtn = detail.getByTestId('wi-detail-chat');
    await expect(chatBtn).toBeVisible();

    // Launch the chat — openFeatureChat POSTs /agent-chats then fires the
    // open-chat event the dock drains into a Chat panel.
    await chatBtn.click();

    // The create must carry THIS item's binding (worker role, discuss is
    // sent per-message not in the create body).
    await expect
      .poll(() => created.find((c) => c.featureId === 'WI-1'), { timeout: 10_000 })
      .toBeTruthy();
    const chat = created.find((c) => c.featureId === 'WI-1')!;
    expect(chat.role).toBe('worker');
    expect(chat.title).toBe('First stubbed item');

    // The drain mounts a Chat panel — its tab falls back to `worker · WI-1`
    // (created chat title is null), proving the event reached the dock.
    await expect(page.getByText('worker · WI-1').first()).toBeVisible({ timeout: 15_000 });

    // Falsifier for this spec's own hermeticity — a never-hit stub means every
    // assertion above ran against real, unstubbed traffic.
    sync.assertServed('workItems.byHarness');
  });

  test('queue and detail distinguish candidates, reservations, registered waits and unknown work attestation', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    const sync = await stubApis(page, []);
    const mounted = await dockMounts(page, 'WI-1');
    assertMounted(mounted, SKIP_MSG);
    await sync.waitForServed(['workItems.byHarness']);
    const detail = page.locator('.pc-adv-detail').first();
    const grid = page.locator('.pc-advpanel').first();
    await expect(detail.getByText('Reproduction or review candidates', { exact: true })).toBeVisible();
    await expect(detail.getByText('Work evidence unknown', { exact: true })).toBeVisible();
    const reservedRow = grid.getByRole('row').filter({ hasText: 'Second stubbed item' });
    await expect(reservedRow).toBeVisible();
    await expect(reservedRow).toContainText('Reserved accepted work');
    await expect(reservedRow).toContainText('Work attestation unknown');
    await reservedRow.click();
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-2');
    await expect(detail.getByText('Reserved accepted work', { exact: true })).toBeVisible();
    await expect(detail.getByText('Reserved · Item updates unknown · Registered item wait · Work attestation unknown', { exact: true })).toBeVisible();
    await expect(detail.getByText('Active accepted work', { exact: true })).toHaveCount(0);
    sync.assertServed('workItems.byHarness');
    sync.assertServed('workItems.detail');
  });

  test('clicking a grid row drives the Detail pane selection', async ({ page }) => {
    const created: CreatedChat[] = [];
    const sync = await stubApis(page, created);
    const mounted = await dockMounts(page); // no ?sel — pane starts on the empty state
    assertMounted(mounted, SKIP_MSG);

    await sync.waitForServed(['workItems.byHarness']);

    // The Work-items grid renders both rows; the Detail pane shows its
    // pick-an-item empty state until a row is clicked.
    const detail = page.locator('.pc-adv-detail').first();
    const grid = page.locator('.pc-advpanel').first();
    const secondRow = grid.getByRole('row').filter({ hasText: 'Second stubbed item' });
    await expect(secondRow).toBeVisible({ timeout: 20_000 });

    // Row click sets ?sel via nuqs → the Detail pane follows to that item.
    await secondRow.click();
    await expect(detail.locator('.pc-adv-detail__title')).toHaveText('Second stubbed item', {
      timeout: 15_000,
    });
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText('WI-2');
    await expect(detail.getByTestId('wi-detail-chat')).toBeVisible();

    sync.assertServed('workItems.byHarness');
  });
});
