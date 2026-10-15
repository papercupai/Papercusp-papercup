/**
 * Settings pages — render-without-crash smoke for the operator's settings surface.
 *
 * /settings/* hosts ~20 pages. This spec verifies each renders (HTTP 200 or
 * auth-redirect 30x). It does NOT click through forms — those are layer-2 work.
 */
import { test, expect } from './_egress';
import type { Page } from '@playwright/test';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const SETTINGS_PAGES = [
  '/settings/profile',
  '/settings/backups',
  '/settings/voice',
  '/settings/shortcuts',
  '/settings/personalization',
  '/settings/remote-access',
  '/settings/agent',
  '/settings/plugins',
  '/settings/plugins/tools',
  '/settings/operator',
  '/settings/p2p',
  '/settings/api-keys',
  '/settings/omp',
  '/settings/user',
  '/settings/user/search',
  '/settings/user/memory',
  '/settings/publishing',
  '/settings/plugin-runtime',
  '/settings/deploy-accounts',
  '/settings/expert-routing',
  '/settings/identities',
  '/settings/integrations',
  '/settings/personal-vault',
  '/settings/pot-customization',
  '/settings/prompt-studio',
  '/settings/storage',
  '/settings/trust',
  '/settings/setup-wizard',
];

test.describe('settings pages render', () => {
  for (const path of SETTINGS_PAGES) {
    test(`${path} renders without 500`, async ({ page }) => {
      const res = await page.goto(`${baseURL}${path}`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
      expect(res?.status() ?? 0).toBeLessThan(500);
      expect([200, 302, 307]).toContain(res?.status() ?? 0);
    });
  }
});

/** Match native hosts that center the surface in a flex row. Keep a wide
 * viewport so compact behavior has to follow the pane, not a media query. */
async function setPaneWidth(page: Page, width: number) {
  await page.locator('.pc-settings-frame').evaluate((frame, paneWidth) => {
    Object.assign(frame.parentElement!.style, {
      display: 'flex', justifyContent: 'center', width: `${paneWidth}px`,
      minWidth: '0', margin: '0',
    });
  }, width);
}

test.describe('settings visual layout in native panes', () => {
  test.use({ viewport: { width: 1658, height: 927 } });

  test.beforeEach(async ({ page }) => {
    // Deterministic data, no credential reads/writes or live account steering.
    await page.route('**/api/admin/deploy-accounts', (route) => route.fulfill({
      json: { ok: true, accounts: [{
        id: 'settings-layout-account', provider: 'claude',
        credentialRef: 'token:settings-layout-fixture', boundTo: [],
        rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
      }] },
    }));
    await page.route('**/api/admin/deploy-accounts/session-override', (route) =>
      route.fulfill({ json: { ok: true, override: {} } }));
    await page.route('**/api/admin/inference-gateway/stats', (route) =>
      route.fulfill({ json: { ok: false } }));
  });

  for (const width of [1100, 650, 400]) {
    test(`Inference fills a ${width}px pane without overlapping account controls`, async ({ page }) => {
      await page.goto(`${baseURL}/settings/deploy-accounts`);
      await expect(page.locator('.pc-da__identity').first()).toContainText('settings-layout-account');
      await setPaneWidth(page, width);
      const shell = page.locator('.pc-settings-shell');
      const content = page.locator('.pc-settings-content');
      await expect.poll(async () => (await shell.boundingBox())!.width).toBe(Math.min(width, 1080));
      await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThan(width < 720 ? width - 40 : 700);
      await expect(page.locator('.pc-settings-mobile-picker')).toBeVisible({ visible: width <= 720 });
      const card = page.locator('.pc-da__card');
      await expect(card).toBeVisible();
      const identity = await card.locator('.pc-da__identity').boundingBox();
      const remove = await card.locator('.pc-da__card-remove').boundingBox();
      expect(identity!.x + identity!.width).toBeLessThanOrEqual(remove!.x);
      expect(await content.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
  }

  test('keyboard controls remain inside a narrow pane on a wide screen', async ({ page }) => {
    await page.goto(`${baseURL}/settings/shortcuts`);
    await expect(page.locator('.kbd-settings-input').first()).toBeVisible();
    await setPaneWidth(page, 400);
    await expect(page.locator('.pc-settings-mobile-picker')).toBeVisible();
    const content = await page.locator('.pc-settings-content').boundingBox();
    for (const control of await page.locator('.kbd-settings-row-controls').all()) {
      const box = await control.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(content!.x + content!.width + 1);
    }
  });

  test('Personal Vault setup cards reflow inside a narrow pane', async ({ page }) => {
    await page.goto(`${baseURL}/settings/personal-vault`);
    await expect(page.locator('.pc-vault-steps')).toBeVisible();
    await setPaneWidth(page, 400);
    for (const selector of ['.pc-vault-steps', '.pc-vault-summary']) {
      const items = await page.locator(`${selector} > *`).all();
      const first = (await items[0].boundingBox())!;
      for (const item of items.slice(1)) {
        const box = (await item.boundingBox())!;
        expect(box.x).toBeCloseTo(first.x, 0);
        expect(box.y).toBeGreaterThanOrEqual(first.y + first.height);
      }
    }
    await page.locator('.pc-vault-advanced-disclosure > summary').click();
    const content = (await page.locator('.pc-settings-content').boundingBox())!;
    for (const control of await page.locator('.pc-vault-advanced-content input:visible, .pc-vault-advanced-content button:visible').all()) {
      const box = (await control.boundingBox())!;
      // Data tables have their own horizontal scroll region.
      const scrollable = await control.evaluate((el) => {
        for (let p = el.parentElement; p && !p.classList.contains('pc-settings-content'); p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'auto') return true;
        }
        return false;
      });
      if (!scrollable) expect(box.x + box.width, await control.evaluate((el) => el.outerHTML.slice(0,200))).toBeLessThanOrEqual(content.x + content.width + 1);
    }
  });

  test('Expert routing keeps model names and action buttons readable in a narrow pane', async ({ page }) => {
    await page.goto(`${baseURL}/settings/expert-routing`);
    await expect(page.getByTestId('expert-model-row').first()).toBeVisible();
    await setPaneWidth(page, 400);
    for (const row of await page.getByTestId('expert-model-row').all()) {
      const box = (await row.boundingBox())!;
      const identity = (await row.locator('.pc-expert-model-identity').boundingBox())!;
      expect(identity.width).toBeGreaterThanOrEqual(160);
      for (const button of await row.getByRole('button').all()) {
        const action = (await button.boundingBox())!;
        expect(action.x + action.width).toBeLessThanOrEqual(box.x + box.width);
        expect(action.y).toBeGreaterThanOrEqual(identity.y + identity.height);
      }
    }
  });

  test('AI backend routing tables scroll inside the pane to reach every control', async ({ page }) => {
    // Suppress auto-save traffic: this test inspects layout only.
    await page.route('**/api/agent-config', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fulfill({ json: { ok: true } });
      } else {
        await route.fulfill({ json: {
          config: { backend: 'claude-code', cmd: 'claude', models: {}, tiers: [], tierCeilings: {} },
          binaries: { claude: '/test/claude', codex: null, omp: null, pi: null },
          codexDiagnostics: null, effectiveBackend: 'claude-code',
          envOverrides: { AGENT_BACKEND: null, AGENT_CMD: null, CLAUDE_CMD: null },
          roleLaunch: {},
        } });
      }
    });
    await page.goto(`${baseURL}/settings/agent`);
    const tiers = page.getByRole('region', { name: 'Reasoning tiers' });
    const roles = page.getByRole('region', { name: 'Role routing' });
    await expect(tiers).toBeVisible();
    await setPaneWidth(page, 400);
    for (const table of [tiers, roles]) {
      const bounds = (await table.boundingBox())!;
      const content = (await page.locator('.pc-settings-content').boundingBox())!;
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(content.x + content.width);
      expect(await table.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
      expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
      await table.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    }
    const remove = (await tiers.getByRole('button', { name: 'remove', exact: true }).first().boundingBox())!;
    const bounds = (await tiers.boundingBox())!;
    expect(remove.x + remove.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  });

  test('plugin runtime keeps Reset cache inside the pane', async ({ page }) => {
    await page.route('**/api/plugins/runtime/status', (route) => route.fulfill({ json: {
      loaded: 1234, errors: 0, reactionRules: [], plugins: [], loadErrors: [],
      initializedPairs: [], registeredActions: [],
    } }));
    await page.goto(`${baseURL}/settings/plugin-runtime`);
    const reset = page.getByRole('button', { name: 'Reset cache', exact: true });
    await expect(reset).toBeVisible();
    await setPaneWidth(page, 400);
    const button = (await reset.boundingBox())!;
    const content = (await page.locator('.pc-settings-content').boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(content.x + content.width);
  });

  test('Prompt Studio stacks bounded editors and keeps its toolbar reachable', async ({ page }) => {
    await page.goto(`${baseURL}/settings/prompt-studio`);
    await expect(page.locator('.pc-prompt-studio-workspace')).toBeVisible();
    await setPaneWidth(page, 400);
    const workspace = page.locator('.pc-prompt-studio-workspace');
    const panels = await workspace.locator(':scope > div').all();
    const editor = (await panels[0].boundingBox())!;
    const preview = (await panels[1].boundingBox())!;
    expect(preview.x).toBeCloseTo(editor.x, 0);
    expect(preview.y).toBeGreaterThanOrEqual(editor.y + editor.height);
    expect((await workspace.boundingBox())!.height).toBeLessThan(927);
    const content = (await page.locator('.pc-settings-content').boundingBox())!;
    const refresh = (await page.getByRole('button', { name: 'Refresh', exact: true }).boundingBox())!;
    expect(refresh.x + refresh.width).toBeLessThanOrEqual(content.x + content.width);
  });

  test('Plugin tools keeps long registry names and metadata inside the pane', async ({ page }) => {
    await page.route('**/api/plugins/tools?stats=true', (route) => route.fulfill({ json: { tools: [{
      name: 'layout:test-tool-with-a-long-registry-name', pluginName: 'agent-mcp',
      description: 'A long registry entry for layout verification.', capabilities: ['intel:read'],
      expose: { http: { path: '/api/agent-tools/layout/test-tool-with-a-long-registry-name', methods: ['POST'] }, mcp: { name: 'layout:test-tool-with-a-long-registry-name' } },
    }] } }));
    await page.goto(`${baseURL}/settings/plugins/tools`);
    await expect(page.locator('.pc-settings-content')).toContainText('layout:test-tool-with-a-long-registry-name');
    await setPaneWidth(page, 400);
    expect(await page.locator('.pc-settings-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });

  test('Memory search and Add memory actions remain inside a narrow pane', async ({ page }) => {
    await page.route('**/api/user/memory/backend', (route) => route.fulfill({ json: {
      backend: 'hybrid-pg', available: [], userId: null,
    } }));
    await page.route('**/api/user/memory/feedback', (route) => route.fulfill({ json: {} }));
    await page.goto(`${baseURL}/settings/user/memory`);
    await expect(page.getByRole('searchbox', { name: 'Search memories' })).toBeVisible();
    await setPaneWidth(page, 400);
    const content = (await page.locator('.pc-settings-content').boundingBox())!;
    for (const name of [/semantic/, /Add memory/]) {
      const button = (await page.getByRole('button', { name }).boundingBox())!;
      expect(button.x + button.width).toBeLessThanOrEqual(content.x + content.width);
    }
  });
});
