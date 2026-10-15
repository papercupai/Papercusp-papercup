import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Page } from '@playwright/test';
import { expect, test } from './_egress';
import { containsAll, decodedThumbnailWidths, startDesktopGridFixtureServer } from './_desktop-grid-fixture-server';

// Plan agent-multi-desktops-grid-2026-10-06 P-006 (R-4): the cloud Desktops page shows
// EVERY agent desktop on a workspace as a tile — thumbnail, owning agent, work-item,
// state — opens one in the live viewer on click, streams up to two pinned tiles live in
// place, filters, and keeps all of that in the URL (nuqs). Real browser, real
// HostedDesktopWorkspace / DesktopGrid / HostedDesktopViewer / nuqs; the relay socket,
// session ticket and RFB framebuffer are substituted (see __fixtures__/desktop-grid.tsx).
// The live hosted-VM run of the same surface is EI-25225008797935576 (plan D-017).
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
  { id: 'grid-desktop-1', title: 'research browser', owner: 'Agent su-alpha', workItem: 'WI-101 · compare vendor pricing' },
  { id: 'grid-desktop-2', title: 'spreadsheet', owner: 'Agent su-beta', workItem: 'WI-102 · reconcile invoices' },
  { id: 'grid-desktop-3', title: 'terminal', owner: 'Agent su-gamma', workItem: 'WI-103 · run the migration' },
  { id: 'grid-desktop-4', title: 'design review', owner: 'Agent su-delta', workItem: null },
  { id: 'grid-desktop-5', title: 'email triage', owner: 'Agent su-epsilon', workItem: 'WI-105 · answer support queue' },
  { id: 'grid-desktop-6', title: 'form filler', owner: 'Agent su-zeta', workItem: 'WI-106 · submit the permit' },
] as const;

test.beforeAll(async () => {
  ({ server, origin } = await startDesktopGridFixtureServer('apps/operator/e2e/__fixtures__/desktop-grid.tsx'));
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('region', { name: 'Desktop grid' })).toBeVisible();
  return errors;
}

function urlParam(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 60_000 });
}

test('[grid.cloud.tiles] every agent desktop is a tile with its thumbnail, owner, work-item and state', async ({ page }) => {
  const errors = await open(page);
  const tiles = page.getByRole('list', { name: 'Available desktops' }).getByRole('listitem');
  await expect(tiles).toHaveCount(DESKTOPS.length);
  await expect(page.getByRole('region', { name: 'Desktop grid' }).getByRole('status'))
    .toHaveText(`${DESKTOPS.length} desktops · 0/2 live`);
  for (const desktop of DESKTOPS) {
    const tile = tiles.filter({ has: page.getByRole('button', { name: `Watch ${desktop.title}`, exact: true }) });
    await expect(tile).toHaveCount(1);
    // One retrying assertion per tile (owner, work-item, state): on the shared fleet box
    // every Playwright round-trip costs seconds, so per-field assertions blow the budget.
    await expect(tile).toHaveText(containsAll(desktop.owner, desktop.workItem, 'running · 1280x720'));
    await expect(tile.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  }
  // A real decoded 320px JPEG per tile, not the placeholder icon.
  await expect.poll(() => decodedThumbnailWidths(page), { timeout: 30_000 }).toEqual(DESKTOPS.map(() => 320));
  await capture(page, 'cloud-grid.png');
  expect(errors).toEqual([]);
});

test('[grid.cloud.open] clicking a tile opens the live viewer in watch mode and the selection is URL state', async ({ page }) => {
  const errors = await open(page);
  const watch = page.getByRole('button', { name: 'Watch terminal', exact: true });
  await watch.click();
  const viewer = page.getByLabel('Desktop viewer for terminal', { exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('connected · watch-only', { exact: true })).toBeVisible();
  await expect(viewer.locator('canvas[data-ready-fixture="true"]')).toBeVisible();
  await expect(watch).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => urlParam(page, 'desktop')).toBe('watch:grid-desktop-3');
  await capture(page, 'cloud-grid-open.png');
  expect(errors).toEqual([]);
});

test('[grid.cloud.pin] two tiles stream live in place, a third pin is refused, and pins are URL state', async ({ page }) => {
  const errors = await open(page);
  const status = page.getByRole('region', { name: 'Desktop grid' }).getByRole('status');
  await page.getByRole('button', { name: 'Pin spreadsheet live', exact: true }).click();
  await page.getByRole('button', { name: 'Pin email triage live', exact: true }).click();
  await expect(status).toHaveText(`${DESKTOPS.length} desktops · 2/2 live`);
  for (const title of ['spreadsheet', 'email triage']) {
    const live = page.getByRole('group', { name: `${title} live`, exact: true });
    await expect(live).toBeVisible();
    // The pinned tile shows its live framebuffer in place of the thumbnail.
    await expect(live.locator('canvas[data-ready-fixture="true"]')).toBeVisible();
    await expect(live.locator('img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Unpin ${title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByRole('button', { name: 'Pin research browser live', exact: true })).toBeDisabled();
  await expect.poll(() => urlParam(page, 'desktopPins')).toBe('grid-desktop-2,grid-desktop-5');
  await capture(page, 'cloud-grid-pinned.png');

  await page.getByRole('button', { name: 'Unpin spreadsheet', exact: true }).click();
  await expect(status).toHaveText(`${DESKTOPS.length} desktops · 1/2 live`);
  await expect(page.getByRole('button', { name: 'Pin research browser live', exact: true })).toBeEnabled();
  await expect(page.getByRole('group', { name: 'spreadsheet live', exact: true })).toHaveCount(0);
  await expect.poll(() => urlParam(page, 'desktopPins')).toBe('grid-desktop-5');
  expect(errors).toEqual([]);
});

test('[grid.cloud.filter] the filter matches agent, work-item and name, and is URL state', async ({ page }) => {
  const errors = await open(page);
  const tiles = page.getByRole('list', { name: 'Available desktops' }).getByRole('listitem');
  const filter = page.getByRole('searchbox', { name: 'Filter desktops' });
  await filter.fill('invoices');
  await expect(tiles).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Watch spreadsheet', exact: true })).toBeVisible();
  await expect.poll(() => urlParam(page, 'desktopFilter')).toBe('invoices');
  await filter.fill('su-gamma');
  await expect(tiles).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Watch terminal', exact: true })).toBeVisible();
  await filter.fill('nothing-matches');
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText('No desktops match “nothing-matches”.', { exact: true })).toBeVisible();
  await filter.fill('');
  await expect(tiles).toHaveCount(DESKTOPS.length);
  await expect.poll(() => urlParam(page, 'desktopFilter')).toBeNull();
  expect(errors).toEqual([]);
});

test('[grid.cloud.url] a shared URL restores the open viewer and the pinned tiles', async ({ page }) => {
  const errors = await open(page, '?desktop=watch:grid-desktop-6&desktopPins=grid-desktop-1,grid-desktop-4');
  await expect(page.getByRole('group', { name: 'research browser live', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'design review live', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Desktop grid' }).getByRole('status'))
    .toHaveText(`${DESKTOPS.length} desktops · 2/2 live`);
  const viewer = page.getByLabel('Desktop viewer for form filler', { exact: true });
  await expect(viewer.getByText('connected · watch-only', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
