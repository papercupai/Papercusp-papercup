/**
 * /settings/agent auto-save — layer-2 form flow (the settings-pages.spec.ts
 * smoke only asserts render).
 *
 * Regression suite for the 2026-06-11 owner bugs:
 *   1. WIPE-ON-RELOAD — an invalid/incomplete tier edit used to be EXCLUDED
 *      from the auto-saved body, silently deleting the row from the store;
 *      reload re-hydrated the gutted config. Invalid sections now HOLD their
 *      last saved value (assemble-config.ts) and the strict POST rejects
 *      lossy bodies (422).
 *   2. MID-TYPING WENT LIVE — every keystroke persisted after the debounce.
 *      Text fields are now DraftInput: commit on blur/Enter, after validation.
 *
 * STATEFUL: this spec edits the real agent config of the stack under test,
 * so it captures the stored config up front and restores it in afterAll
 * (empty values restore the host's boot env — EI-337). Tests run SERIAL —
 * each step builds on the previous stored state.
 *
 * Sibling-pattern notes (harness-settings-flow.spec.ts): baseURL mirrors
 * playwright.config.ts; tests SKIP rather than fail when the SPA serves a
 * blank #root (stale HMR-disabled :3055). The agent config store is
 * WORKSPACE-scoped, and a fresh Playwright profile's in-page fetches stamp
 * `x-papercusp-workspace: default` — every request-fixture call here must
 * stamp the SAME header or the fixture reads/writes a different workspace's
 * config than the page (the dock.spec.ts workspace-resolution lesson).
 */
import { test, expect, assertMounted, type Page } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

const SKIP_MSG_BLANK =
  '/settings/agent did not mount. Run against an HMR-enabled operator-vite ' +
  '(the playwright.config webServer) — a stale HMR-disabled :3055 serves a blank #root.';


// Debounce in page.tsx is 600ms — anything still unsaved after this window
// was (correctly) never scheduled.
const SAVE_WINDOW_MS = 1200;

// P-020 (autonomous-loop-prod-audit-2026-07-02) inserted a 5th default tier
// (`luna`, gpt-5.6-luna:high) between `deep` and `max` — `max` is now Tier 5.
const SPEC_INPUT = 'input[aria-label="Tier 5 model spec"]';

let originalConfig: Record<string, unknown> | null = null;

// The stored config is read and written through the PAGE's own fetch, never a
// bare request fixture. The page's fetch carries the identity the backend
// actually resolves the page against (its cookies, plus the workspace header
// installWorkspaceHeaderFetch stamps); a request fixture carries neither. On a
// fresh isolated rig the fixture therefore read a DIFFERENT store than the page
// wrote: 0 tiers right after a committed, reload-visible save, while the two
// "nothing persisted" tests passed vacuously against that other, empty store
// (WI-10006792). A hardcoded or learned workspace header did not close the gap.
async function getStoredConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const r = await fetch('/api/agent-config');
    if (!r.ok) throw new Error(`GET /api/agent-config -> ${r.status}`);
    return ((await r.json()) as { config: Record<string, unknown> }).config;
  });
}

async function putStoredConfig(page: Page, config: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (body) => {
    const r = await fetch('/api/agent-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST /api/agent-config -> ${r.status}`);
  }, config);
}

async function openPage(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/settings/agent`, { waitUntil: 'load', timeout: 30_000 });
  return page
    .locator('h1', { hasText: 'AI backend' })
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Fill the tier-5 (`max`) model spec and blur it (blur = the commit trigger). */
async function editSpecAndBlur(page: Page, value: string) {
  const input = page.locator(SPEC_INPUT);
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(value);
  await input.blur();
}

test.describe.configure({ mode: 'serial' });

test.describe('/settings/agent auto-save validation', () => {
  test.beforeAll(async ({ browser }) => {
    const probe = await browser.newPage();
    try {
      // A page that fails to mount is left to each test's assertMounted, so a
      // mount failure stays visible instead of turning into a skip here.
      if (!(await openPage(probe))) return;
      originalConfig = await getStoredConfig(probe).catch(() => null);
      test.skip(originalConfig == null, 'agent-config API unreachable');
      // Known baseline for the tier flow: default menu, no ceilings. Everything
      // else (backend/cmd/models/surfaces) keeps the stack's real values.
      await putStoredConfig(probe, { ...originalConfig, tiers: [], tierCeilings: {} });
    } finally {
      await probe.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!originalConfig) return;
    const restore = await browser.newPage();
    try {
      if (await openPage(restore)) await putStoredConfig(restore, originalConfig);
    } finally {
      await restore.close();
    }
  });

  test('mid-typing never persists (commit is blur-gated)', async ({ page }) => {
    assertMounted(await openPage(page), SKIP_MSG_BLANK);
    const input = page.locator(SPEC_INPUT);
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    // Default-menu baseline, read from the page rather than hardcoded: this
    // test is about blur-gated commits, not about which model is the Tier 5
    // default (that changed opus:xhigh -> opus[1m]:xhigh and stranded the
    // literal; DEFAULT_MODEL_TIERS owns that value — WI-10006792).
    await expect(input).toHaveValue(/^\S+:\S+$/);
    const baseline = await input.inputValue();
    await input.click();
    await input.pressSequentially('fab'); // mid-word, still focused — no blur
    await page.waitForTimeout(SAVE_WINDOW_MS);
    const cfg = await getStoredConfig(page);
    expect(cfg.tiers).toEqual([]); // still the untouched default menu
    await page.keyboard.press('Escape'); // revert the draft
    await expect(input).toHaveValue(baseline);
  });

  test('an invalid spec is flagged inline and never persisted', async ({ page }) => {
    assertMounted(await openPage(page), SKIP_MSG_BLANK);
    await editSpecAndBlur(page, 'opush'); // bare unknown alias — the typo class
    await expect(page.getByRole('alert').filter({ hasText: 'not a known model alias' })).toBeVisible();
    await page.waitForTimeout(SAVE_WINDOW_MS);
    const cfg = await getStoredConfig(page);
    expect(cfg.tiers).toEqual([]); // nothing persisted, nothing wiped
  });

  test('a valid edit commits on blur and survives reload', async ({ page }) => {
    assertMounted(await openPage(page), SKIP_MSG_BLANK);
    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/agent-config') && r.request().method() === 'POST' && r.status() === 200,
      { timeout: 15_000 },
    );
    await editSpecAndBlur(page, 'fable:max');
    await saved;
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
    const cfg = await getStoredConfig(page);
    const tiers = cfg.tiers as Array<{ name: string; spec: string }>;
    expect(tiers).toHaveLength(5);
    expect(tiers[4]).toMatchObject({ name: 'max', spec: 'fable:max' });
  });

  test('WIPE REGRESSION: an invalid edit holds the stored value across reload', async ({ page }) => {
    assertMounted(await openPage(page), SKIP_MSG_BLANK);
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
    await editSpecAndBlur(page, 'opus:'); // mid-typed effort suffix — invalid
    await expect(page.getByRole('alert').filter({ hasText: 'invalid spec' })).toBeVisible();
    await page.waitForTimeout(SAVE_WINDOW_MS);
    // The store kept the last valid menu — the row was NOT deleted…
    const cfg = await getStoredConfig(page);
    const tiers = cfg.tiers as Array<{ spec: string }>;
    expect(tiers).toHaveLength(5);
    expect(tiers[4].spec).toBe('fable:max');
    // …and a reload re-hydrates the saved value, not a gutted menu.
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator(SPEC_INPUT)).toHaveValue('fable:max', { timeout: 15_000 });
  });
});
