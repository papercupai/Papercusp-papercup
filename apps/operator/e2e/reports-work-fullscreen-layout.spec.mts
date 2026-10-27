import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { startDesktopGridFixtureServer, type DesktopGridFixtureServer } from './_desktop-grid-fixture-server';

const shellCss = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const reportsCss = readFileSync(new URL('../../operator-vite/src/components/reports/ReportsRoute.css', import.meta.url), 'utf8');

test('Reports fullscreen reader escapes the route content box', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/*', route => route.abort());
  await page.setContent(`
    <style>${shellCss}\n${reportsCss}</style>
    <main data-route-transition-page="true" style="margin: 80px 48px; width: 900px; height: 500px">
      <div class="reports-page">
        <section class="reports-reader reports-reader--fullscreen" aria-label="Report reader">
          <button>Restore report reader</button>
        </section>
      </div>
    </main>
  `);

  await expect.poll(() => page.getByRole('region', { name: 'Report reader' }).boundingBox()).toEqual({
    x: 0, y: 0, width: 1280, height: 800,
  });
});

test.describe('Work pane split geometry', () => {
  let fixture: DesktopGridFixtureServer;
  test.beforeAll(async () => {
    const seams = 'apps/operator/e2e/__fixtures__/work-fullscreen-seams.tsx';
    fixture = await startDesktopGridFixtureServer('apps/operator/e2e/__fixtures__/work-fullscreen.tsx',
      Object.fromEntries(['@papercusp/dock-workbench', '@papercusp/sync', '@/lib/use-workspace-id',
        '@/app/_components/perf/perf-marks', './MissingPanel', './dock-actions', './close-guard',
        './useNavShortcuts', './useLayoutResetShortcut', './useRegisterPluginPanels',
        './useFocusedPanelTracker', './iframe-host', '../useConfirmDialog'].map(id => [id, seams])));
  });
  test.afterAll(async () => { await fixture?.server.close(); });

  for (const mode of ['document', 'resized window'] as const) {
  test(`each pane restores exact split sizes and mounted drafts after ${mode} fullscreen`, async ({ page }) => {
    page.on('pageerror', error => console.error(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.setViewportSize({ width: 1280, height: 800 });
    if (mode === 'resized window') await page.addInitScript(() => {
      // Desktop window resizing and browser fallback share the fixed surface.
      Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined });
    });
    await page.goto(fixture.origin);
    const titles = ['Work items', 'Dependency graph', 'Detail'];
    const geometry = () => page.locator('.dv-groupview').evaluateAll(elements =>
      elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      }));
    await expect(page.getByRole('button', { name: 'Fullscreen Work items', exact: true })).toBeVisible();
    await expect.poll(geometry).toHaveLength(3);
    const before = await geometry();
    for (const [index, title] of titles.entries()) {
      const draft = page.getByRole('textbox', { name: `${title} draft` });
      await draft.fill(`Unsaved ${title}`);
      const mounted = await draft.elementHandle();
      await page.getByRole('button', { name: `Fullscreen ${title}`, exact: true }).click();
      await expect.poll(() => page.getByTestId('dock-fullscreen-surface').boundingBox())
        .toEqual({ x: 0, y: 0, width: 1280, height: 800 });
      await expect.poll(() => page.locator('.dv-groupview:visible').count()).toBe(1);
      if (mode === 'resized window') await page.setViewportSize({ width: 1600, height: 1000 });
      if (index === 1) {
        // Native window and full-window fallback deliver Escape to the app.
        await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined);
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      } else await page.getByRole('button', { name: `Restore ${title}`, exact: true }).click();
      if (mode === 'resized window') await page.setViewportSize({ width: 1280, height: 800 });
      await expect.poll(geometry).toEqual(before);
      expect(await draft.evaluate((element, original) => element === original, mounted)).toBe(true);
      await expect(draft).toHaveValue(`Unsaved ${title}`);
    }
  });
  }
});
