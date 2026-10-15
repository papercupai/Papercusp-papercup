import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Page } from '@playwright/test';
import { expect, test } from './_egress';
import { containsAll, decodedThumbnailWidths, startDesktopGridFixtureServer } from './_desktop-grid-fixture-server';

// Plan agent-multi-desktops-grid-2026-10-06 P-007 + P-005 (R-5): "This computer" on the
// Desktops page renders every agent desktop on this machine through the SAME grid as the
// cloud workspaces — thumbnails that refresh on the ~5s cadence and stop for a tile that
// is already streaming live, owner/work-item labels, pinning, the live viewer — and a
// desktop an agent starts appears as soon as the roster stream delivers it.
// Real browser, real LocalDesktopWorkspace / DesktopGrid / LocalDesktopViewer / nuqs; the
// roster stream, HTTP seam and RFB framebuffer are substituted
// (__fixtures__/desktop-grid-local.tsx). The run against real Xvfb desktops through an
// isolated sidecar is the separate live e2e on WI-10006486.
// 180s: on the shared fleet box (load ~200 on 128 cores, measured 2026-10-06) a trivial
// assertion round-trip costs 2-5s and the first navigation ~13s.
test.describe.configure({ mode: 'serial', timeout: 180_000 });
// Evidence is the explicit capture() screenshots; an always-on video only adds encoder load
// and a slow context teardown on that box. A click is ~6 renderer round-trips (scroll,
// hit-target, move/down/up acks), so the 10s config actionTimeout is under that cost there.
test.use({ video: 'off', actionTimeout: 30_000 });
const output = process.env.DESKTOP_GRID_OUTPUT_DIR;
let server: ViteDevServer;
let origin: string;

const DESKTOPS = [
  { id: 'local-desktop-1', title: 'browser', owner: 'Agent su-alpha', workItem: 'WI-201 · book the venue', display: 111 },
  { id: 'local-desktop-2', title: 'terminal', owner: 'Agent su-beta', workItem: 'WI-202 · bisect the regression', display: 112 },
  { id: 'local-desktop-3', title: 'spreadsheet', owner: 'Agent su-gamma', workItem: null, display: 113 },
  { id: 'local-desktop-4', title: 'editor', owner: 'Agent su-delta', workItem: 'WI-204 · draft the release notes', display: 114 },
  { id: 'local-desktop-5', title: 'mail', owner: 'Agent su-epsilon', workItem: 'WI-205 · reply to the vendor', display: 115 },
] as const;

test.beforeAll(async () => {
  ({ server, origin } = await startDesktopGridFixtureServer(
    'apps/operator/e2e/__fixtures__/desktop-grid-local.tsx',
    { '@papercusp/sync': 'apps/operator/e2e/__fixtures__/desktop-grid-sync.ts' },
  ));
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: 'Desktops on this computer' })).toBeVisible();
  return errors;
}

// What __fixtures__/desktop-grid-local.tsx and desktop-grid-sync.ts expose on window.
interface FixtureWindow {
  __thumbnailRequests: Record<string, number>;
  __vncSessions: Array<{ display: number; mode: string; target: string }>;
  __desktopGridSync: { rows: unknown[]; set: (rows: unknown[]) => void };
}

function thumbnailRequests(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window as unknown as FixtureWindow).__thumbnailRequests }));
}

async function capture(page: Page, name: string): Promise<void> {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 60_000 });
}

test('[grid.local.tiles] This computer lists every agent desktop with a thumbnail and its owner/work-item', async ({ page }) => {
  const errors = await open(page);
  const surface = page.getByRole('region', { name: 'Desktops on this computer' });
  await expect(surface.getByRole('heading', { name: 'This computer' })).toBeVisible();
  const tiles = surface.getByRole('list', { name: 'Available desktops' }).getByRole('listitem');
  await expect(tiles).toHaveCount(DESKTOPS.length);
  await expect(surface.getByRole('region', { name: 'Desktop grid' }).getByRole('status'))
    .toHaveText(`${DESKTOPS.length} desktops · 0/2 live`);
  for (const desktop of DESKTOPS) {
    const tile = tiles.filter({ has: page.getByRole('button', { name: `Watch ${desktop.title}`, exact: true }) });
    await expect(tile).toHaveCount(1);
    // One retrying assertion per tile (owner, work-item, state) — see the timeout note above.
    await expect(tile).toHaveText(containsAll(desktop.owner, desktop.workItem, 'ready · 1280×800'));
    await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/);
  }
  // A real decoded 320px JPEG per tile, not the placeholder icon.
  await expect.poll(() => decodedThumbnailWidths(page), { timeout: 30_000 }).toEqual(DESKTOPS.map(() => 320));
  await capture(page, 'local-grid.png');
  expect(errors).toEqual([]);
});

test('[grid.local.thumbnails] thumbnails refresh on the ~5s cadence and stop for a tile streaming live', async ({ page }) => {
  const errors = await open(page);
  await expect.poll(async () => Object.keys(await thumbnailRequests(page)).length).toBe(DESKTOPS.length);
  // Pin one tile: it streams live in place, so it needs no more thumbnails.
  await page.getByRole('button', { name: 'Pin terminal live', exact: true }).click();
  await expect(page.getByRole('group', { name: 'terminal live', exact: true })
    .locator('canvas[data-ready-fixture="true"]')).toBeVisible();
  const before = await thumbnailRequests(page);
  // Two refresh periods (DESKTOP_GRID_THUMBNAIL_REFRESH_MS = 5s) plus slack.
  await page.waitForTimeout(11_000);
  const after = await thumbnailRequests(page);
  for (const desktop of DESKTOPS) {
    const added = (after[desktop.id] ?? 0) - (before[desktop.id] ?? 0);
    if (desktop.id === 'local-desktop-2') expect(added, `${desktop.id} is live and must not be polled`).toBe(0);
    else expect(added, `${desktop.id} refreshes about every 5s`).toBeGreaterThanOrEqual(2);
  }
  expect(errors).toEqual([]);
});

test('[grid.local.open] clicking a tile mints a watch session for that display and opens the live viewer', async ({ page }) => {
  const errors = await open(page);
  const watch = page.getByRole('button', { name: 'Watch editor', exact: true });
  await watch.click();
  const viewer = page.getByLabel('Desktop viewer for editor', { exact: true });
  await expect(viewer.getByText('connected · watch-only', { exact: true })).toBeVisible();
  await expect(viewer.locator('canvas[data-ready-fixture="true"]')).toBeVisible();
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__vncSessions))
    .toContainEqual({ display: 114, mode: 'watch', target: 'local' });
  await expect.poll(() => new URL(page.url()).searchParams.get('desktop')).toBe('watch:local-desktop-4');
  await capture(page, 'local-grid-open.png');
  expect(errors).toEqual([]);
});

test('[grid.local.pin] two local tiles stream live, a third pin is refused, and pins are URL state', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'Pin browser live', exact: true }).click();
  await page.getByRole('button', { name: 'Pin mail live', exact: true }).click();
  for (const title of ['browser', 'mail']) {
    await expect(page.getByRole('group', { name: `${title} live`, exact: true })
      .locator('canvas[data-ready-fixture="true"]')).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Pin terminal live', exact: true })).toBeDisabled();
  await expect.poll(() => new URL(page.url()).searchParams.get('desktopPins')).toBe('local-desktop-1,local-desktop-5');
  await capture(page, 'local-grid-pinned.png');
  expect(errors).toEqual([]);
});

test('[grid.local.arrival] a desktop an agent starts appears when the roster stream delivers it', async ({ page }) => {
  const errors = await open(page);
  const tiles = page.getByRole('list', { name: 'Available desktops' }).getByRole('listitem');
  await expect(tiles).toHaveCount(DESKTOPS.length);
  await page.evaluate(() => {
    const sync = (window as unknown as FixtureWindow).__desktopGridSync;
    const first = sync.rows[0] as Record<string, unknown>;
    sync.set([...sync.rows, {
      ...first, id: 'local-desktop-6', display: 116, displayRaw: ':116', scopeRef: 'su-zeta:main',
      owner: 'su-zeta', name: 'video call', workItemId: 'WI-206', workItemIntent: 'record the demo',
    }]);
  });
  await expect(tiles).toHaveCount(DESKTOPS.length + 1);
  const arrived = tiles.filter({ has: page.getByRole('button', { name: 'Watch video call', exact: true }) });
  await expect(arrived.getByText('Agent su-zeta', { exact: true })).toBeVisible();
  await expect(arrived.getByText('WI-206 · record the demo', { exact: true })).toBeVisible();
  await expect(arrived.locator('img')).toHaveAttribute('src', /^blob:/, { timeout: 12_000 });
  expect(errors).toEqual([]);
});

test('[grid.local.empty] with no agent desktops the page says how one appears', async ({ page }) => {
  const errors = await open(page, '?empty=1');
  await expect(page.getByText('No agent desktops on this computer', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available desktops' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
