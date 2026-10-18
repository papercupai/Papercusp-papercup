import {
  test, expect, type Page, type Locator, waitVisibleRecoveringNetworkChange, watchNetworkChange,
} from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { readTypedPropertyCollection, type OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';

const current = {
  id: 'ongoing-current', title: 'Renamed workspace steward', status: 'active', standing: true,
  effectiveStatus: 'active', holderLiveness: 'held', needsHuman: 31,
  spendRecentUsd: 12.34, spendRecentWindowDays: 3, budgetCents: 10000, budgetWindowSec: 604800,
};
const packageRow = {
  ref: 'work-on-everything', title: current.title, description: 'Advances priority work across the workspace.',
  layer: 'bundled', version: '1.0.0', standing: true, featured: true,
  budgetCents: 10000, budgetWindowSec: 604800, activeGoalId: current.id,
  instances: [{ goalId: current.id, status: 'active', adoptableStub: false }],
};

// These shell reads share the finite-request scheduler with the goal queries.
// Letting them reach the shared backend makes a fixture's goal admission depend
// on live process scans, attention aggregation and plan-list hydration. Model
// those ancillary contracts here without swallowing the required dock layout;
// the separate shipment profile still exercises real goal data without stubs.
function headerRows(name: string): readonly unknown[] | undefined {
  if (name === 'taskManager.inventory') return [{ enabled: false }];
  if (name === 'hive.controlState') return [];
  if (name === 'plans.attentionCounts') return [{ decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0, degraded: false }];
  if (name === 'plans.list' || name === 'plans.attention' || name === 'plans.attentionRefs'
      || name === 'planWorkActivity.list') return [];
  return undefined;
}

async function waitForHud(ready: Locator) {
  // Deep-linked goal dialogs hide the background HUD from accessibility queries.
  // Wait on the visible caller being exercised, with the same readiness deadline.
  // A page blanked by host network churn is reloaded once (WI-6554700010008424).
  await waitVisibleRecoveringNetworkChange(ready, 30_000);
}

async function openHud(page: Page, path: string, ready: Locator = page.getByRole('tablist', { name: 'HUD board' })) {
  // The caller's visible landmark is the acceptance boundary; unrelated
  // framed surfaces do not have to finish their whole-page load lifecycle.
  watchNetworkChange(page);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHud(ready);
}

async function scopeFixture(page: Page) {
  const projects = [{ slug: 'papercusp', name: 'papercusp', path: '/tmp/ongoing-ui-fixture',
    hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false }];
  await page.route('**/api/harness/projects/lite', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ projects }) }));
  return projects;
}


type CollectionKind = 'plans' | 'tea';
type CollectionJourney = 'priority' | 'selection' | 'refusal';

// These mounted shell consumers are outside the collection contract. Keep an
// explicit manifest: unknown queries and the real dock layout still fall through.
const collectionShellQueries = new Set([
  'accounts.pool', 'accounts.sessionOverride', 'dev.gitPipeline', 'hiveFromRepo.progress',
  'operatorConversations.current', 'operatorTurns.page', 'themes.catalog', 'toastLog.recent',
  'voicePrefs.effective', 'workspaceHosts.control',
]);

async function prepareDeclaredCollection(page: Page, kind: CollectionKind, journey: CollectionJourney) {
    const projects = await scopeFixture(page);
    // This editor never launches an agent. Its hidden launcher still requests
    // these options through the same two-slot request scheduler, so a live
    // bootstrap scan can consume the save/readback deadline before the
    // collection fixture is reached. Model that unrelated contract explicitly.
    // Match the path rather than a bare-URL glob: the launcher appends both
    // ?agent=... and ?identities=... to this endpoint.
    await page.route(url => url.pathname === '/api/agent-mcp/console/bootstrap-su/options', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        status: 'ok', identities: [], unreadable: [], nextAfter: null,
        fleets: [], accounts: [], schemes: [], ompCatalog: { status: 'unavailable', models: [] },
      }),
    }));
    const goal = { id: `collection-${kind}`, title: `${kind} collection`, status: 'active', standing: kind === 'plans' };
    const property = kind === 'plans' ? 'worklist' : 'tea_choices';
    const policyName = kind === 'plans' ? 'worklist_policy' : 'tea_policy';
    const ids = kind === 'plans' ? ['plan:papercusp/alpha', 'plan:papercusp/beta', 'plan:papercusp/blocked'] : ['mint', 'chamomile', 'rooibos'];
    const discoveredExtras = kind === 'plans' ? ['plan:papercusp/maintained-rubric'] : [];
    const visibleIds = [...ids, ...discoveredExtras];
    const dormant = kind === 'plans' ? 'plan:papercusp/dormant' : 'lavender';
    const labels = ['First choice', 'Second choice', 'Blocked choice', 'Maintained rubric'];
    const schema = {
      [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'string-list', default: [], editable_by: 'both',
        collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
          order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected: true } },
      [policyName]: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
    };
    let policy: OrderedSelectionPolicy = {
      order: journey === 'priority' ? [ids[0], dormant] : [ids[1], ids[0], ids[2], ...discoveredExtras, dormant],
      excluded: [dormant],
    };
    let version = 4;
    let refuseSave = false;
    const writes: Array<{ value: OrderedSelectionPolicy; expectedVersion: number }> = [];
    const refusedWrites: Array<{ value: OrderedSelectionPolicy; expectedVersion: number }> = [];
    const reads: Array<{ version: number; order: string[] }> = [];
    const unreadableReadbacks: string[] = [];
    const invalidations: Array<{ before: number; after: number }> = [];
    const acknowledgements: Array<{ expectedVersion: number; observedVersion?: number; phase: string }> = [];
    const unmodelledQueries = new Set<string>();
    const selection = () => readTypedPropertyCollection({ propertySchema: schema, property,
      properties: { [property]: { value: ids, version: 2, edited_by: 'agent', provenance: 'agent-edit', edited_at: '2026-10-07T00:00:00Z' },
        [policyName]: { value: policy, version, edited_by: 'owner', provenance: 'owner-edit', edited_at: '2026-10-07T00:00:00Z' } },
      ...(kind === 'plans' ? { source: { ok: true as const, items: visibleIds } } : {}) });
    const sync = await stubSyncQueries(page, (name) => {
      if (name === 'harnessProjects.lite') return projects;
      if (name === 'advRoster.list') return [{ active: [], pending: [] }];
      if (name === 'goals.list') return [{ goals: [goal], totalGoals: 1, goalPackages: [] }];
      if (name === 'goals.detail') {
        const selected = selection();
        if (!selected.ok || !selected.configured) throw new Error(JSON.stringify(selected));
        reads.push({ version: selected.policyVersion, order: selected.items.map((row) => row.id) });
        return [{ goal, goalData: { collections: { [property]: { selection: selected,
          rows: selected.items.map((row) => ({ ...row, label: labels[visibleIds.indexOf(row.id)],
            state: row.id === ids[2] ? 'blocked' : 'ready', reason: row.id === ids[2] ? 'Waiting for dependency' : null })) } } } }];
      }
      const ancillary = headerRows(name);
      if (ancillary !== undefined) return ancillary;
      if (collectionShellQueries.has(name)) return [];
      if (name !== 'dockLayouts.byName') unmodelledQueries.add(name);
      return undefined;
    }, { push: true });
    await page.route('**/api/admin/goals/set-property', async (route) => {
      const posted = route.request().postDataJSON();
      expect(posted.goalId).toBe(goal.id);
      expect(posted.property).toBe(policyName);
      expect(posted).not.toHaveProperty('provenance');
      if (refuseSave || posted.expectedVersion !== version) {
        refusedWrites.push(posted);
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale', actualVersion: version }) });
        return;
      }
      writes.push(posted);
      const before = reads.at(-1)!.version;
      policy = posted.value;
      version++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version, provenance: 'owner-edit' }) });
      invalidations.push({ before, after: version });
      await sync.invalidate('goals.detail');
    });
    const editor = page.getByTestId('goal-data');
    async function saveWithReadback(action: () => Promise<void>) {
      const expectedVersion = version + 1;
      acknowledgements.push({ expectedVersion, phase: 'action-start' });
      const saved = page.waitForResponse('**/api/admin/goals/set-property');
      const readback = page.waitForResponse(async (response) => {
        const url = new URL(response.url());
        if (!url.pathname.endsWith('/rest-query') || url.searchParams.get('name') !== 'goals.detail') return false;
        // Mount/real-backend invalidations can already have an older response
        // in flight. A write is acknowledged only by its exact goal/revision.
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          // An earlier response can lose its body across navigation. It cannot
          // acknowledge this save: keep waiting for the readable exact revision.
          const message = String(error);
          if (!message.includes('Network.getResponseBody')
              || !message.includes('No data found for resource with given identifier')) throw error;
          unreadableReadbacks.push(response.url());
          return false;
        }
        const observedVersion = payload.rows[0]?.goalData?.collections?.[property]?.selection?.policyVersion;
        acknowledgements.push({ expectedVersion, observedVersion, phase: 'canonical-response' });
        return payload.rows[0]?.goal?.id === goal.id && observedVersion === expectedVersion;
      });
      try {
        // Observe both responses while Playwright waits for the control. A
        // disabled control can outlast either response deadline; handle those
        // rejections here so the fixture evidence still reaches the attachment.
        const [, savedResponse, canonicalReadback] = await Promise.all([action(), saved, readback]);
        acknowledgements.push({ expectedVersion, phase: 'responses-complete' });
        expect(savedResponse.status()).toBe(200);
        const payload = await canonicalReadback.json();
        expect(payload.rows[0].goalData.collections[property].selection.policyVersion).toBe(version);
        const expected = selection();
        if (!expected.ok || !expected.configured) throw new Error('collection unavailable');
        expect(payload.rows[0].goalData.collections[property].rows.map((row: { id: string }) => row.id))
          .toEqual(expected.items.map((row) => row.id));
      } finally {
        // A response seen by Playwright is not proof that React applied it.
        // Keep the rendered state and the real SSE subscriber beside the
        // fixture ledger so a failed save names the boundary that stopped.
        const browser = await page.evaluate(() => {
          const fixture = window as unknown as {
            __syncQueryFixtureSources?: Set<EventSource>;
            __sync_metrics__?: { snapshot(): unknown };
          };
          const editor = document.querySelector('[data-testid="goal-data"]');
          return {
            saveStatus: editor?.querySelector('[aria-label="Save status"]')?.textContent ?? null,
            checkboxes: [...(editor?.querySelectorAll('[role="checkbox"]') ?? [])].map((node) => ({
              label: node.getAttribute('aria-label'), checked: node.getAttribute('aria-checked'),
              disabled: node.hasAttribute('disabled'),
            })),
            sources: [...(fixture.__syncQueryFixtureSources ?? [])].map((source) => ({
              url: source.url, readyState: source.readyState,
            })),
            sync: fixture.__sync_metrics__?.snapshot() ?? null,
          };
        }).catch((error) => ({ unavailable: String(error) }));
        await test.info().attach(`collection-${kind}-readback-v${version}`, {
          body: JSON.stringify({ reads, writes, invalidations, unreadableReadbacks, acknowledgements,
            unmodelledQueries: [...unmodelledQueries], policy, version, browser }), contentType: 'application/json',
        });
      }
    }
    async function reloadWithReadback() {
      // A fresh persisted query is allowed to skip REST on mount. First prove
      // the canonical response reached disk, then exercise that real reload
      // path without clearing the cache or requiring a redundant request.
      await expect.poll(() => page.evaluate(async ({ goalId, property }) => {
        // Inspect only an app-created database; polling must not create an empty
        // version-1 database before the app installs its object store.
        if (!(await indexedDB.databases()).some((db) => db.name === 'papercusp-sync-cache')) return null;
        const stored = await new Promise<unknown>((resolve, reject) => {
          const open = indexedDB.open('papercusp-sync-cache', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('snapshots')) { db.close(); resolve(null); return; }
            const tx = db.transaction('snapshots', 'readonly');
            const request = tx.objectStore('snapshots').get('papercusp:sync-cache:v1');
            request.onsuccess = () => resolve(request.result?.row?.value ? JSON.parse(request.result.row.value) : null);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
          };
        }) as { state?: { queries?: Array<{ queryKey: [string, string, { goalId?: string }]; state: { data?: { rows?: Array<{ goalData?: { collections?: Record<string, { selection?: unknown }> } }> } } }> } } | null;
        const query = stored?.state?.queries?.find((entry: { queryKey: [string, string, { goalId?: string }] }) =>
          entry.queryKey[1] === 'goals.detail' && entry.queryKey[2]?.goalId === goalId);
        return query?.state?.data?.rows?.[0]?.goalData?.collections?.[property]?.selection;
      }, { goalId: goal.id, property })).toMatchObject({ policyVersion: version, policy });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForHud(editor);
    }
    return {
      path: `/adv?tab=hud&scope=all&hudtab=goals&hudgoal=${goal.id}&welcome=0`,
      editor,
      sync,
      run: async () => {
    await expect(editor.getByText('Waiting for dependency')).toBeVisible();
    if (journey === 'priority') {
      await saveWithReadback(() => editor.getByRole('button', { name: 'Move Second choice up' }).click());
      expect(policy.order).toEqual([ids[1], ids[0], ids[2], ...discoveredExtras, dormant]);
      await reloadWithReadback();
      await expect(editor.locator('li').first()).toContainText('Second choice');
      expect(policy.excluded).toEqual([dormant]);
      expect(writes.map((write) => write.expectedVersion)).toEqual([4]);
      expect(invalidations).toEqual([{ before: 4, after: 5 }]);
      expect(version).toBe(5);
    } else if (journey === 'selection') {
      await expect(editor.locator('li').first()).toContainText('Second choice');
      await saveWithReadback(() => editor.getByRole('checkbox', { name: 'Include Second choice' }).click());
      expect(policy.excluded).toEqual([dormant, ids[1]]);
      await reloadWithReadback();
      await expect(editor.getByRole('checkbox', { name: 'Include Second choice' })).not.toBeChecked();
      await expect(editor.locator('li').first()).toContainText('Excluded');
      const afterExclusion = selection();
      if (!afterExclusion.ok || !afterExclusion.configured) throw new Error('collection unavailable');
      expect(afterExclusion.items.filter((row) => row.selected).map((row) => row.id)).toEqual([ids[0], ids[2], ...discoveredExtras]);
      if (kind === 'plans') await expect(editor.getByRole('checkbox', { name: 'Include Maintained rubric' })).toBeChecked();
      await saveWithReadback(() => editor.getByRole('checkbox', { name: 'Include Second choice' }).click());
      await reloadWithReadback();
      await expect(editor.getByRole('checkbox', { name: 'Include Second choice' })).toBeChecked();
      await expect(editor.locator('li').first()).toContainText('Second choice');
      expect(policy.order).toEqual([ids[1], ids[0], ids[2], ...discoveredExtras, dormant]);
      expect(policy.excluded).toEqual([dormant]);
      expect(writes.map((write) => write.expectedVersion)).toEqual([4, 5]);
      expect(invalidations).toEqual([{ before: 4, after: 5 }, { before: 5, after: 6 }]);
      expect(version).toBe(6);
    } else {
      refuseSave = true;
      await editor.getByRole('checkbox', { name: 'Include First choice' }).click();
      await expect(editor.getByRole('alert')).toContainText('stale');
      await expect(editor.getByRole('checkbox', { name: 'Include First choice' })).toBeChecked();
      expect(refusedWrites).toHaveLength(1);
      expect(refusedWrites[0].expectedVersion).toBe(4);
      expect(refusedWrites[0].value.excluded).toContain(ids[0]);
      expect(writes).toEqual([]);
      expect(invalidations).toEqual([]);
      expect(policy.excluded).toEqual([dormant]);
      expect(version).toBe(4);
    }
    if (kind === 'plans') await expect(editor.getByRole('checkbox', { name: 'Include Maintained rubric' })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath(`collection-${kind}-${journey}.png`) });
    sync.assertServed('goals.list', 'goals.detail');
    expect([...unmodelledQueries], 'new shell queries need an explicit fixture contract').toEqual([]);
      },
    };
}

// Navigation and editor readiness each have their existing 30s bound. They
// need separate fixture clocks: a 19s navigation must not reduce the editor's
// readiness bound to 11s. Real reloads, writes and refusal still share the
// unchanged 60s contract budget.
type DeclaredCollection = Awaited<ReturnType<typeof prepareDeclaredCollection>>;
const collectionTest = test.extend<{
  collectionKind: CollectionKind;
  collectionJourney: CollectionJourney;
  collectionFixture: DeclaredCollection;
  collectionNavigation: DeclaredCollection;
  collectionReady: DeclaredCollection;
  runCollection: () => Promise<void>;
}>({
  collectionKind: ['plans', { option: true }],
  collectionJourney: ['priority', { option: true }],
  collectionFixture: [async ({ page, collectionKind, collectionJourney }, use) => {
    await use(await prepareDeclaredCollection(page, collectionKind, collectionJourney));
  }, { timeout: 30_000 }],
  collectionNavigation: [async ({ page, collectionFixture }, use) => {
    await page.goto(collectionFixture.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await use(collectionFixture);
  }, { timeout: 30_000 }],
  collectionReady: [async ({ collectionNavigation }, use) => {
    await waitForHud(collectionNavigation.editor);
    collectionNavigation.sync.assertServed('goals.detail');
    await use(collectionNavigation);
  }, { timeout: 30_000 }],
  runCollection: async ({ collectionReady }, use) => {
    await use(collectionReady.run);
  },
});
const collectionJourneys = (['plans', 'tea'] as const).flatMap((kind) =>
  (['priority', 'selection', 'refusal'] as const).map((journey) => ({ kind, journey })));
test('declared collection fixture intercepts launcher option queries', async ({ page }) => {
  // A missed fixture route must fail locally rather than reach a live scan.
  await page.route('**/api/agent-mcp/console/bootstrap-su/options**', route => route.fulfill({
    status: 502, body: 'Unmodelled launcher options request',
  }));
  await page.route(/\/api\/zero-harness\/rest-query\?/, route => route.fulfill({
    status: 502, body: 'Unmodelled sync request',
  }));
  await prepareDeclaredCollection(page, 'tea', 'selection');
  for (const query of ['', '?agent=claude', '?identities=1&limit=30']) {
    const response = await page.goto(`/api/agent-mcp/console/bootstrap-su/options${query}`);
    expect(response?.status(), `fixture must cover launcher options${query}`).toBe(200);
    expect(await response!.json()).toMatchObject({ status: 'ok', identities: [], fleets: [], accounts: [] });
  }
  for (const name of [...collectionShellQueries, 'plans.attentionRefs']) {
    const response = await page.goto(`/api/zero-harness/rest-query?name=${name}&args={}`);
    expect(response?.status(), `fixture must cover shell query ${name}`).toBe(200);
    expect(await response!.json()).toMatchObject({ rows: [] });
  }
  for (const name of ['dockLayouts.byName', 'fixture.unmodelled']) {
    const response = await page.goto(`/api/zero-harness/rest-query?name=${name}&args={}`);
    expect(response?.status(), `fixture must preserve fallthrough for ${name}`).toBe(502);
  }
});
for (const { kind, journey } of collectionJourneys) {
  const contract = journey === 'priority' ? 'preserves owner order through reload'
    : journey === 'selection' ? 'preserves exclusion and reselection through reload'
      : 'rejects a stale save without changing selection';
  collectionTest.describe(`${kind} collection ${journey}`, () => {
    collectionTest.use({ collectionKind: kind, collectionJourney: journey });
    collectionTest(`declared ${kind} collection ${contract}`, async ({ runCollection }) => {
      await runCollection();
    });
  });
}

test('Design C cockpit keeps saved priorities and rubric duties visible across desktop and mobile', async ({ page }) => {
  const projects = await scopeFixture(page);
  const goal = { ...current, status: 'paused', goalPackage: { ref: 'work-on-everything' } };
  const ids = ['plan:papercusp/alpha', 'plan:papercusp/beta', 'plan:papercusp/mobile'];
  const counts = { todo: 2, wip: 1, blocked: 0, needsHuman: 0, done: 3 };
  const detail = { goal, holderLiveness: 'held', effectiveStatus: 'paused', waitingOnYouTotal: 31,
    waitingOnYou: [{ id: 'WI-approval', title: 'Choose release scope' }],
    activity: [{ id: 'WI-outcome', title: 'Search repair verified', status: 'done', closedAt: '2026-10-06T12:00:00Z' }],
    goalData: { worklistHistory: [{ id: 'priority-edit', ref: ids[1], at: '2026-10-07T12:00:00Z', actor: 'human',
      label: 'Added to this goal', detail: 'Owner selected Search reliability' }], collections: { worklist: {
      selection: { ok: true, configured: true, policyVersion: 7,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false },
        policy: { order: ids, included: ids.slice(0, 2), excluded: [] },
        items: ids.map((id, i) => ({ id, selected: i < 2 })), selected: ids.slice(0, 2) },
      rows: ids.map((id, i) => ({ id, selected: i < 2, harness: 'papercusp', planSlug: ['alpha', 'beta', 'mobile'][i],
        label: ['Cloud setup', 'Search reliability', 'Mobile workspace'][i], state: 'ready', reason: null,
        counts: i === 1 ? null : counts })) } } } };
  const sync = await stubSyncQueries(page, name => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [goal], totalGoals: 1, goalPackages: [packageRow] }];
    if (name === 'goals.detail') return [detail];
    return headerRows(name);
  });
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/admin/goals/')) writes.push(request.url());
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const panel = page.getByTestId('work-on-everything-console');
  await openHud(page, `/adv?tab=hud&scope=all&hudtab=goals&hudgoal=${goal.id}&welcome=0`, panel);
  await sync.waitForServed(['goals.detail']);
  const priorities = panel.getByRole('region', { name: 'Priority plans' });
  await expect(priorities.getByTestId('ongoing-priority-row')).toHaveCount(2);
  await expect(panel.getByRole('region', { name: 'Goal health' })).toContainText('Paused');
  await expect(panel.getByRole('region', { name: 'Selected plan progress' })).toContainText('totals are partial');
  await expect(panel.getByRole('region', { name: 'Needs you' })).toContainText('Showing 1 of 31 items');
  const quality = panel.getByRole('region', { name: 'Rubric stewardship' });
  for (const duty of ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade']) {
    await expect(quality.getByRole('heading', { name: duty })).toBeVisible();
  }
  expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('design-c-desktop.png') });
  await panel.getByRole('button', { name: 'Browse all plans' }).click();
  await expect(priorities.getByTestId('ongoing-priority-row')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Add Mobile workspace' })).toHaveCount(0);
  await panel.getByRole('button', { name: /^Edit priorities/ }).click();
  await panel.getByRole('button', { name: 'Remove Cloud setup' }).click();
  await expect(panel.getByRole('region', { name: 'Pending changes' })).toBeVisible();
  await panel.getByRole('button', { name: 'Back to overview' }).click();
  await expect(priorities.getByRole('button', { name: 'Cloud setup' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await expect(panel.getByRole('button', { name: /^Edit priorities/ })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('design-c-mobile.png') });
  const activity = panel.getByRole('region', { name: 'Recent activity' });
  await activity.scrollIntoViewIfNeeded();
  await expect(activity).toContainText('Added to this goal');
  await expect(activity).toContainText('Search repair verified');
  await panel.getByRole('button', { name: /^Edit priorities/ }).click();
  await expect(panel.getByRole('button', { name: 'Add Cloud setup' })).toBeVisible();
  await panel.getByRole('button', { name: 'Discard', exact: true }).click();
  expect(writes).toEqual([]);
});

test('ongoing work stays visible across tabs, keeps ordinary goals, and opens the same detail', async ({ page }) => {
  const projects = await scopeFixture(page);
  const sync = await stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [current,
      { id: 'ordinary', title: 'Work on everything', status: 'active', standing: false },
      { id: 'previous-instance', title: 'Previous workspace steward', status: 'killed', standing: true }],
      totalGoals: 3, goalPackages: [packageRow] }];
    if (name === 'goals.detail') return [{ goal: current, holderLiveness: 'held', effectiveStatus: 'active',
      goalModeState: { portfolio: { priorities: ['Reconcile priority placement', 'Triage blocked work'] } },
      waitingOnYouTotal: 31, waitingOnYou: [{ id: 'WI-approval', title: 'Choose release scope' }],
      activity: [{ id: 'WI-outcome', title: 'Search repair verified', status: 'done', closedAt: '2026-10-06T12:00:00Z' }],
      plans: [{ planSlug: 'search', harnessSlug: 'papercusp', title: 'Search plan', stamped: true, openItems: 2 }] }];
    return headerRows(name);
  });
  await openHud(page, '/adv?tab=hud&scope=all&hudtab=goals&welcome=0');
  await sync.waitForServed(['goals.list', 'goals.detail']);
  const rail = page.getByTestId('goal-packages-rail');
  await expect(rail.getByRole('button', { name: 'View ongoing work' })).toBeVisible();
  await expect(rail.getByText('Reconcile priority placement')).toBeVisible();
  await expect(rail.getByText('31 waiting on you')).toBeVisible();
  await expect(page.getByText('Work on everything', { exact: true })).toBeVisible();
  await expect(page.getByText('Previous workspace steward', { exact: true })).toBeVisible();
  const featured = page.getByRole('region', { name: `Ongoing work: ${current.title}` });
  await expect(featured).toBeVisible();
  await expect(featured.locator('svg.lucide-infinity')).toHaveCount(1);
  const featuredBox = await featured.boundingBox();
  const ordinaryBox = await page.getByText('Previous workspace steward', { exact: true }).boundingBox();
  expect(featuredBox).not.toBeNull();
  expect(ordinaryBox).not.toBeNull();
  expect(featuredBox!.y + featuredBox!.height).toBeLessThanOrEqual(ordinaryBox!.y);
  // The represented id has exactly one displayed title; title matching cannot hide ordinary goals.
  await expect(page.getByRole('heading', { name: current.title, exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('ongoing-featured.png') });
  for (const tab of ['Sessions', 'Plans', 'Work items']) {
    const target = page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true });
    await target.click();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await expect(rail.getByRole('button', { name: 'View work' })).toBeVisible();
    await expect(rail.getByText('31 needs you')).toBeVisible();
  }
  const openWork = rail.getByRole('button', { name: 'View work' });
  await openWork.focus();
  await expect(openWork).toBeFocused();
  await openWork.press('Enter');
  await expect(page).toHaveURL(/hudgoal=ongoing-current/);
  const overview = page.locator('.hud-ongoing--detail');
  await expect(overview.getByText('Where work is moving')).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Search plan' })).toBeVisible();
  const overviewBeforeEnds = await overview.evaluate((node) => {
    const ends = document.querySelector('[data-testid="goal-ends-section"]');
    return !!ends && !!(node.compareDocumentPosition(ends) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(overviewBeforeEnds).toBe(true);
  await page.screenshot({ path: test.info().outputPath('ongoing-detail.png') });
  await overview.getByRole('button', { name: 'Search repair verified' }).click();
  await expect(page).toHaveURL(/hudwi=WI-outcome/);
  sync.assertServed('goals.list');
  sync.assertServed('goals.detail');
});

test('mobile strip preserves truthful status after a refused pause', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projects = await scopeFixture(page);
  const sync = await stubSyncQueries(page, (name) => {
    if (name === 'harnessProjects.lite') return projects;
    if (name === 'advRoster.list') return [{ active: [], pending: [] }];
    if (name === 'goals.list') return [{ goals: [current], totalGoals: 1, goalPackages: [packageRow] }];
    if (name === 'goals.detail') return [{ goal: current, holderLiveness: 'held', effectiveStatus: 'active' }];
    return headerRows(name);
  });
  await page.route('**/api/admin/goals/update', (route) => route.fulfill({ status: 409,
    contentType: 'application/json', body: JSON.stringify({ error: { message: 'Pause refused for test' } }) }));
  await openHud(page, '/adv?tab=hud&scope=all&hudtab=sessions&welcome=0');
  await sync.waitForServed(['goals.list', 'goals.detail']);
  const rail = page.getByTestId('goal-packages-rail');
  await expect(rail.getByText('Running', { exact: true })).toBeVisible();
  const write = page.waitForResponse('**/api/admin/goals/update');
  await rail.getByRole('button', { name: /Pause/ }).click();
  await page.getByRole('dialog', { name: 'Pause this goal?' }).getByRole('button', { name: 'Pause goal', exact: true }).click();
  expect((await write).status()).toBe(409);
  await expect(rail.getByText('Running', { exact: true })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'View work' })).toBeInViewport();
  const horizontalOverflow = await rail.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(horizontalOverflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile.png') });
  await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: 'Goals', exact: true }).click();
  await expect(rail.getByRole('button', { name: 'View ongoing work' })).toBeInViewport();
  expect(await rail.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile-featured.png') });
  await rail.getByRole('button', { name: 'View ongoing work' }).click();
  const overview = page.locator('.hud-ongoing--detail');
  await expect(overview.getByText('Where work is moving')).toBeVisible();
  expect(await overview.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await expect(page.getByTestId('goal-work-rail')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('ongoing-mobile-detail.png') });
  sync.assertServed('goals.list');
  sync.assertServed('goals.detail');
  sync.assertServed('plans.attentionCounts', 'plans.list', 'plans.attention');
});
