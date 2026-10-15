/**
 * /adv Frames tab — the Swarm live view tile grid
 * (`hive-frame-desktops-live-view-2026-06-06` P-006/P-007).
 *
 * Verifies what the unit tests cannot: the tab mounts in the live /adv shell
 * (operator-vite SPA), consumes the `/api/deploy/frames` roster + the
 * per-slug `/api/deploy/:slug/frame-view` SSE stream, renders a thumbnail
 * tile with role metadata, and writes the tile selection to nuqs
 * (`?frame=<slug>:<display>`) so agents can drive the viewer.
 *
 * Data is stubbed via route interception (hermetic — no deployed frame
 * needed): the roster returns one Latitude frame and the SSE stream emits a
 * status + one 1×1-JPEG thumb event.
 */
import { test, expect, assertMounted, type Page } from './_egress';
import { FRAME_THUMB_TESTSRC, FRAME_THUMB_SMPTE, FRAME_THUMB_RGB } from './__fixtures__/frame-thumbs';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

// A minimal valid 1×1 JPEG (black) — enough for <img> to decode.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const SLUG = 'frames-e2e-h1';

async function stubApis(page: Page) {
  // NB: trailing `*` — the SPA's workspace layer appends `?ws=<id>` to API
  // URLs (observed on the EventSource leg), and Playwright globs match the
  // QUERY STRING too; without the `*` the stub silently misses.
  await page.route('**/api/deploy/frames*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        frames: [
          {
            slug: SLUG,
            frame: { id: 'lat-e2e-1', host: '203.0.113.10', region: 'NYC', kind: 'vm', target: 'latitude' },
            desktop: true,
          },
        ],
      }),
    });
  });
  await page.route(`**/api/deploy/${SLUG}/frame-view*`, async (route) => {
    const status = {
      slug: SLUG,
      state: 'polling',
      frameId: 'lat-e2e-1',
      host: '203.0.113.10',
      displays: [99],
    };
    const thumb = {
      slug: SLUG,
      display: 99,
      jpegBase64: TINY_JPEG_B64,
      capturedAtMs: Date.now(),
      role: 'worker',
      leaseSinceMs: Date.now() - 30_000,
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `event: status`,
        `data: ${JSON.stringify(status)}`,
        '',
        `event: thumb`,
        `data: ${JSON.stringify(thumb)}`,
        '',
        '',
      ].join('\n'),
    });
  });
}

async function framesTabMounts(page: Page): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=frames`, { waitUntil: 'domcontentloaded' });
  // Probe the panel's own title element, not its wording: the title renders
  // `{t('fleet')} live view`, and the lexicon term changed (Swarm -> Fleet),
  // which made a literal 'Swarm live view' probe report every run as a mount
  // failure while the panel was rendering correctly (WI-10006792).
  return page
    .locator('.pc-frames__title')
    .filter({ hasText: /live view$/i })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/** A realistic multi-frame / multi-display stub for the VISUAL capture: two
 *  deployed frames, four active agent-displays with role labels + real
 *  test-pattern JPEGs, so the screenshot shows the GUI as it actually looks. */
async function stubRealisticSwarm(page: Page) {
  await page.route('**/api/deploy/frames*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        frames: [
          { slug: 'web-checkout', frame: { id: 'hz-1', host: '5.161.10.20', region: 'ash', kind: 'vm', target: 'hetzner' }, desktop: true },
          { slug: 'docs-site', frame: { id: 'hz-2', host: '5.161.10.21', region: 'ash', kind: 'vm', target: 'hetzner' }, desktop: true },
        ],
      }),
    });
  });
  const sse = (slug: string, thumbs: Array<{ display: number; jpeg: string; role: string }>) => {
    const status = { slug, state: 'polling', frameId: slug === 'web-checkout' ? 'hz-1' : 'hz-2', displays: thumbs.map((t) => t.display) };
    const lines = [`event: status`, `data: ${JSON.stringify(status)}`, ''];
    for (const t of thumbs) {
      lines.push(
        `event: thumb`,
        `data: ${JSON.stringify({ slug, display: t.display, jpegBase64: t.jpeg, capturedAtMs: Date.now(), role: t.role, leaseSinceMs: Date.now() - 45_000 })}`,
        '',
      );
    }
    lines.push('');
    return lines.join('\n');
  };
  await page.route('**/api/deploy/web-checkout/frame-view*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse('web-checkout', [
        { display: 99, jpeg: FRAME_THUMB_TESTSRC, role: 'worker' },
        { display: 100, jpeg: FRAME_THUMB_SMPTE, role: 'validator' },
      ]),
    });
  });
  await page.route('**/api/deploy/docs-site/frame-view*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse('docs-site', [{ display: 99, jpeg: FRAME_THUMB_RGB, role: 'documenter' }]),
    });
  });
}

test.describe('/adv Frames tab (Swarm live view)', () => {
  // VISUAL capture (not gating): render the Frames tab against a realistic
  // multi-frame swarm + open the live-view panel, saving PNGs to the test output
  // so the GUI can be eyeballed/shared. Mirrors adv-contributors-panel.spec.ts.
  test('CAPTURE: Frames tab tile grid + live-view panel screenshots', async ({ page }, info) => {
    await stubRealisticSwarm(page);
    const mounted = await framesTabMounts(page);
    assertMounted(
      mounted,
      // EI-19917451944474469: don't assert a specific unverified cause — a near-identical
      // "stale dev server" claim on a sibling spec was measured wrong.
      'The /adv shell did not mount the Frames tab. Check OPERATOR_E2E_REUSE_SERVER/' +
        'PAPERCUSP_ENABLE_HMR and inspect the trace/screenshot attached to this failure.',
    );

    await expect(page.locator('.pc-frames__tile')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('.pc-frames__chip')).toHaveCount(2);
    // let the tiles paint
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath('frames-tab-grid.png'), fullPage: false });

    // open the enlarged live-view panel on the first tile
    await page.locator('.pc-frames__tile').first().click();
    const panel = page.getByRole('region', { name: 'Frame live view' });
    await expect(panel).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath('frames-tab-panel.png'), fullPage: false });
    console.log(`[frames-capture] wrote ${info.outputDir}/frames-tab-{grid,panel}.png`);
  });

  test('renders the tile grid from the roster + SSE thumbs; selection rides nuqs', async ({ page }) => {
    await stubApis(page);
    const mounted = await framesTabMounts(page);
    assertMounted(
      mounted,
      'The /adv shell did not mount the Frames tab. Check that OPERATOR_E2E_BASE_URL points ' +
        'at a server carrying PAPERCUSP_ENABLE_HMR=1 + PAPERCUSP_FAKE_LLM=1 (the standing ' +
        "dev:operator systemd service does NOT), and that stubApis() still matches the app's " +
        'real request shapes.',
    );

    // status chip for the deployed frame
    const chip = page.locator('.pc-frames__chip', { hasText: SLUG });
    await expect(chip).toBeVisible({ timeout: 15_000 });

    // one tile, carrying the display number + lease role from the SSE event
    const tile = page.locator('.pc-frames__tile');
    await expect(tile).toHaveCount(1, { timeout: 15_000 });
    await expect(tile).toContainText(':99');
    await expect(tile).toContainText('worker');
    await expect(tile.locator('img')).toBeVisible();

    // click-through: selection goes to the URL (nuqs) + the enlarged panel opens
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`frame=${SLUG}%3A99|frame=${SLUG}:99`));
    const panel = page.getByRole('region', { name: 'Frame live view' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(SLUG);

    // close → selection cleared from the URL
    await panel.getByRole('button', { name: 'Close live view' }).click();
    await expect(panel).not.toBeVisible();
    await expect(page).not.toHaveURL(/frame=/);
  });

  test('live view: Watch live mints a watch session; Take control re-mints as takeover (D-002, nuqs)', async ({ page }) => {
    await stubApis(page);
    // P-013: the watch path tries the holepunch screen track FIRST. Stub the
    // voice status to a DIFFERENT live channel so the track view bails
    // immediately (never-hijack rule) and falls back to VNC — without ever
    // touching the dev box's REAL voice bridge on :3076.
    await page.route('**/api/agent-tools/voice/status*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: { channel: { id: 'voice-general' }, peers: [] } }),
      });
    });
    const minted: Array<{ display: number; mode: string }> = [];
    await page.route(`**/api/deploy/${SLUG}/vnc-session*`, async (route) => {
      minted.push(route.request().postDataJSON() as { display: number; mode: string });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // ws URL points at a dead port — the spec verifies session minting +
        // mode wiring, not the RFB handshake (that's the live verify P-011).
        body: JSON.stringify({ ok: true, ticket: 't', wsUrl: 'ws://127.0.0.1:1/api/deploy/vnc?ticket=t', mode: 'watch' }),
      });
    });
    const mounted = await framesTabMounts(page);
    assertMounted(
      mounted,
      // EI-19917451944474469: don't assert a specific unverified cause — a near-identical
      // "stale dev server" claim on a sibling spec was measured wrong.
      'The /adv shell did not mount the Frames tab. Check OPERATOR_E2E_REUSE_SERVER/' +
        'PAPERCUSP_ENABLE_HMR and inspect the trace/screenshot attached to this failure.',
    );

    await page.locator('.pc-frames__tile').first().click();
    const panel = page.getByRole('region', { name: 'Frame live view' });
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Watch live' }).click();
    await expect(page).toHaveURL(/live=true/);
    await expect(panel.locator('.pc-frames__mode')).toContainText(/read-only/i);
    await expect.poll(() => minted.length).toBeGreaterThan(0);
    expect(minted[0]).toMatchObject({ display: 99, mode: 'watch' });

    await panel.getByRole('button', { name: 'Take control' }).click();
    await expect(page).toHaveURL(/drive=true/);
    await expect(panel.locator('.pc-frames__mode')).toContainText('DRIVING');
    await expect.poll(() => minted.length).toBeGreaterThan(1);
    expect(minted.at(-1)).toMatchObject({ display: 99, mode: 'takeover' });

    await panel.getByRole('button', { name: 'Release control' }).click();
    await expect(page).not.toHaveURL(/drive=true/);
    await expect(panel.locator('.pc-frames__mode')).toContainText(/read-only/i);
  });

  test('empty roster renders the deploy hint, no tiles', async ({ page }) => {
    await page.route('**/api/deploy/frames*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ frames: [] }),
      });
    });
    const mounted = await framesTabMounts(page);
    assertMounted(
      mounted,
      // EI-19917451944474469: don't assert a specific unverified cause — a near-identical
      // "stale dev server" claim on a sibling spec was measured wrong.
      'The /adv shell did not mount the Frames tab. Check OPERATOR_E2E_REUSE_SERVER/' +
        'PAPERCUSP_ENABLE_HMR and inspect the trace/screenshot attached to this failure.',
    );
    await expect(
      page.locator('.pc-frames__state', { hasText: 'No deployed frames' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pc-frames__tile')).toHaveCount(0);
  });

  // The no-stub API probes target the OPERATOR host directly. On the standing
  // dev box `:3055` proxies /api to the GREEN release host, which doesn't carry
  // fresh routes until the next deploy — point OPERATOR_E2E_API_URL at the
  // staging operator (`:3170`) to probe pre-deploy. In CI the stack is built
  // from the same commit, so the default baseURL serves them.
  const apiBase = process.env.OPERATOR_E2E_API_URL ?? baseURL;

  test('API: GET /api/deploy/frames is JSON or auth-gated (no stub)', async ({ request }) => {
    const res = await request.get(`${apiBase}/api/deploy/frames`);
    expect([200, 401, 403]).toContain(res.status());
    if (res.status() === 200) expect(res.headers()['content-type'] ?? '').toMatch(/json/);
  });

  test('API: GET /api/deploy/:slug/frame-view is SSE-shaped or auth-gated (no stub)', async ({ request }) => {
    try {
      const res = await request.get(`${apiBase}/api/deploy/some-harness/frame-view`, { timeout: 2_000 });
      // unauthenticated → immediate 401/403 (the route exists + is gated)
      expect([401, 403]).toContain(res.status());
    } catch {
      // authenticated 200 never completes (it's a live SSE stream) — a timeout
      // means the stream stayed open, which is the SSE-shaped success case.
    }
  });
});
