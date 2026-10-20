/**
 * Harness settings flow — the per-harness Settings surface inside /adv
 * (app-wide e2e coverage audit).
 *
 * The harness settings panel lives on the /adv shell's `?tab=settings`
 * tab (operator-vite routes/adv/index.tsx → AdvHarnessPanelPage →
 * SettingsTab). The panel is flag-swapped (FLAGS.BLUEPRINT_AWARE_SETTINGS,
 * default ON in libs/flags/src/types.ts):
 *
 *   - BlueprintSettingsPanel — schema-driven controls from the harness
 *     blueprint's declared params (may legitimately declare none), or
 *   - the legacy HarnessSettingsPanel — hardcoded Workers / AI backend /
 *     Community badge sections.
 *
 * BOTH variants render `<h1>Settings — <slug></h1>` plus the shared
 * "Saved prompts" and "Plugins" sections, so the assertions here target
 * that common contract and stay tolerant of the flag state — the point
 * is "the settings surface opens and its panels/fields render", not
 * pinning one panel implementation.
 *
 * READ-ONLY by design: this spec never clicks Save, never types into a
 * field, never toggles a control — the e2e workspace's real config.json
 * must not be mutated by a render-coverage spec.
 *
 * Sibling-pattern notes (adv-shell-nav.spec.ts / dock.spec.ts):
 *   - a REAL harness slug is resolved from /api/harness/projects/lite
 *     (an explicit valid `?slug=` deep link wins over the persisted
 *     selection restore — adv-harness-selection.ts rule 1 — so no
 *     stubbing is needed and the panel loads real config);
 *   - tests SKIP rather than fail when the SPA serves a blank #root
 *     (stale HMR-disabled :3055) or when the workspace has no projects.
 */
import { test, expect, assertMounted, type Page } from './_egress';

// Mirror playwright.config.ts's BASE_URL derivation — honoring
// OPERATOR_E2E_PORT keeps this spec on the SAME server the config's
// webServer boots (EI-208).
const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

const SKIP_MSG_BLANK =
  'The /adv shell did not mount the tab strip. Run against an HMR-enabled operator-vite ' +
  '(the playwright.config webServer) — a stale HMR-disabled :3055 serves a blank #root.';

// Resolve a harness slug that exists in THE WORKSPACE THE PAGE WILL USE
// (dock.spec.ts pattern): a fresh Playwright profile has no injected
// __PAPERCUSP_WS__ and no `?ws=`, so getBrowserWorkspaceId() falls back to
// 'default' and every in-page fetch stamps `x-papercusp-workspace: default`.
// Resolving here WITHOUT that header reads a DIFFERENT workspace's registry,
// so the page 404s on a slug its own workspace doesn't contain. Prefer
// `papercup` when present, else a stable-looking project; do NOT prefer
// test-looking fixtures — other suites create/destroy those mid-run.
const PAGE_WORKSPACE = 'default';
let SLUG = process.env.HARNESS_SETTINGS_E2E_SLUG ?? '';
let projectsReachable = true;

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
      '';
  } catch {
    projectsReachable = false;
  }
});

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

/** The settings tab's panel container (AdvHarnessPanelPage section). */
const settingsPanel = (page: Page) =>
  page.locator('section[aria-label="ADV Settings workspace"]');

/** Both panel variants render this exact heading once config context loads. */
const settingsHeading = (page: Page) =>
  page.getByRole('heading', { name: `Settings — ${SLUG}` });

/**
 * Open /adv?tab=settings for the resolved slug. `?scope=expanded` keeps the
 * per-pot tab set visible (under scope=all the Settings tab is hidden and
 * the shell snaps to Overview). Returns false when the shell never mounts.
 */
async function gotoSettings(page: Page): Promise<boolean> {
  const res = await page.goto(
    `${baseURL}/adv?tab=settings&slug=${SLUG}&scope=expanded`,
    { waitUntil: 'domcontentloaded' },
  );
  expect([200, 304]).toContain(res?.status() ?? 0);
  return page
    .getByRole('tablist', { name: 'Adv sections' })
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

function skipWithoutSlug() {
  test.skip(!projectsReachable, '/api/harness/projects/lite unreachable — cannot resolve a harness slug');
  test.skip(!SLUG, 'no projects exist in the e2e workspace — no harness settings to open');
}

test.describe('harness settings surface (/adv?tab=settings)', () => {
  test('opens on the Settings tab and mounts the per-harness panel clean', async ({ page }) => {
    skipWithoutSlug();
    const consoleErrors = collectConsoleErrors(page);
    const mounted = await gotoSettings(page);
    assertMounted(mounted, SKIP_MSG_BLANK);

    // Landed on the tab: the selected trigger says so. (The shell's `<h1>` title
    // was the other half of this assertion until 2026-07-27, when the owner had
    // the whole title bar removed so the tab strip sits at the very top.)
    await expect(
      page.getByRole('tab', { name: 'settings', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');

    // The per-harness panel mounted for OUR slug — both the blueprint-aware
    // and the legacy panel render this heading.
    await expect(settingsPanel(page)).toBeVisible();
    await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });

    // No error boundary latched.
    await expect(
      page.getByRole('alert').filter({ hasText: 'This view hit an error' }),
    ).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    expect(scrubConsoleErrors(consoleErrors)).toEqual([]);
  });

  test('panel sections render with form fields present (read-only)', async ({ page }) => {
    skipWithoutSlug();
    const mounted = await gotoSettings(page);
    assertMounted(mounted, SKIP_MSG_BLANK);

    const panel = settingsPanel(page);
    await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });

    // Shared sections — rendered by BOTH panel variants
    // (SavedPromptsSection + HarnessPluginsSection).
    await expect(panel.getByRole('heading', { name: 'Saved prompts' })).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByRole('heading', { name: 'Plugins' })).toBeVisible();

    // Form fields present. Legacy panel: native inputs (max workers, AI
    // backend rows, …). Blueprint panel: native inputs plus Radix
    // Checkbox/Select (role=checkbox / role=combobox) per declared param —
    // OR, legitimately, zero params ("declares no tunable settings").
    // Accept either declared-empty or ≥1 control; anything else means the
    // form never rendered.
    const noParamsMsg = panel.getByText(/declares no tunable settings/i);
    const controls = panel.locator(
      'input, select, textarea, [role="checkbox"], [role="combobox"]',
    );
    await expect
      .poll(
        async () => (await noParamsMsg.count()) > 0 || (await controls.count()) > 0,
        { timeout: 20_000, message: 'settings form fields (or the declared-empty notice) never rendered' },
      )
      .toBe(true);

    // When a config form rendered, its Save affordance exists. We assert
    // presence ONLY — never click it (read-only spec; no config mutation).
    if ((await controls.count()) > 0 && (await noParamsMsg.count()) === 0) {
      await expect(
        panel.getByRole('button', { name: /^(Save|Saving…)$/ }).first(),
      ).toBeVisible();
    }
  });

  test('?tab=settings&slug= nuqs state round-trips a reload', async ({ page }) => {
    skipWithoutSlug();
    const mounted = await gotoSettings(page);
    assertMounted(mounted, SKIP_MSG_BLANK);
    await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });

    // The URL is the store: tab + slug survive and the same panel remounts.
    const params = new URL(page.url()).searchParams;
    expect(params.get('tab')).toBe('settings');
    expect(params.get('slug')).toBe(SLUG);
    await expect(
      page.getByRole('tab', { name: 'settings', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(settingsHeading(page)).toBeVisible({ timeout: 20_000 });
  });
});
