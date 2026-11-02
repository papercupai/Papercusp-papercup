import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 1 });
const errors = [];
const network = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) network.push(request.url());
});
const url = pathToFileURL(join(directory, 'index.html'));
url.searchParams.set('capture', '1');
await page.goto(url.href);
await page.waitForFunction(() => Boolean(window.__mockup));
await page.evaluate(() => document.fonts.ready);
const captures = [];
try {
  for (const direction of ['a', 'b', 'c']) {
    for (const surface of ['launcher', 'terminal', 'organizer', 'chat', 'accounts', 'overview']) {
      await page.evaluate(({ direction, surface }) => window.__mockup.set(direction, surface), { direction, surface });
      try {
        await page.screenshot({ path: join(directory, `${direction}-${surface}.png`), animations: 'disabled' });
      } catch (error) {
        const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight })).catch(() => null);
        throw new Error(`Screenshot failed for ${direction}/${surface}; viewport=${JSON.stringify(metrics)}; pageErrors=${JSON.stringify(errors)}: ${error.message}`, { cause: error });
      }
      const bounds = await page.evaluate(() => [...document.querySelectorAll('#stage > .window, #stage > .wing, #stage > .os-panel, #stage > .os-wing, #stage > .os-overview')].map(element => {
        const rect = element.getBoundingClientRect();
        return { title: element.querySelector('.titlebar,.wing-title')?.textContent?.trim() || 'Panel', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      }));
      const overviewCards = surface === 'overview' ? await page.locator('.overview-card > .overview-inner').count() : null;
      const expectedCards = direction === 'b' ? 6 : 5;
      if (surface === 'overview' && overviewCards !== expectedCards) errors.push(`Overview ${direction} must contain ${expectedCards} intact preview cards; found ${overviewCards}`);
      captures.push({ direction, surface, file: `${direction}-${surface}.png`, bounds, overviewCards });
    }
  }
  await page.evaluate(() => window.__mockup.set('b', 'goals'));
  await page.locator('.goal-directory [data-os-goal="native"]').click();
  await page.screenshot({ path: join(directory, 'b-goals.png'), animations: 'disabled' });
  captures.push({ direction: 'b', surface: 'goals', file: 'b-goals.png' });
  await page.locator('.goal-directory [data-os-goal="work-all"]').click();
  await page.screenshot({ path: join(directory, 'b-work-on-everything.png'), animations: 'disabled' });
  captures.push({ direction: 'b', surface: 'work-on-everything', file: 'b-work-on-everything.png' });
  await page.evaluate(() => window.__mockup.set('b', 'launcher'));
  await page.locator('#agent-search').fill('work on everything');
  await page.screenshot({ path: join(directory, 'b-goal-search.png'), animations: 'disabled' });
  captures.push({ direction: 'b', surface: 'goal-search', file: 'b-goal-search.png' });
  await page.locator('#agent-search').fill('');
  await page.evaluate(() => window.__mockup.set('b', 'chat'));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(directory, 'b-dismissed.png'), animations: 'disabled' });
  captures.push({ direction: 'b', surface: 'dismissed', file: 'b-dismissed.png', lifecycle: true });
  await page.keyboard.press('Control+Alt+p');
  await page.locator('[data-os-pin]').click();
  await page.screenshot({ path: join(directory, 'b-chat-pinned.png'), animations: 'disabled' });
  captures.push({ direction: 'b', surface: 'chat-pinned', file: 'b-chat-pinned.png', lifecycle: true });
  await page.evaluate(() => window.__mockup.get().osPins.clear());
  for (const platform of ['ubuntu', 'mac', 'windows']) {
    await page.evaluate(platform => window.__mockup.set('b', 'chat', platform), platform);
    await page.screenshot({ path: join(directory, `platform-${platform}.png`), animations: 'disabled' });
    captures.push({ platform, surface: 'chat', file: `platform-${platform}.png` });
  }
  const comparisonPage = await browser.newPage({ viewport: { width: 2520, height: 665 }, deviceScaleFactor: 1 });
  for (const [surface, label] of Object.entries({ launcher: 'Quick Access', terminal: 'Terminal HUD', organizer: 'Window organizer', chat: 'Papercup chat', accounts: 'Accounts' })) {
    const tiles = [];
    for (const [direction, name, subtitle] of [['a', 'Focus · earlier study', 'Compact floating windows'], ['b', 'Workbench · revised', 'Shortcut-summoned OS sidebars'], ['c', 'Orbit · earlier study', 'Edge controls and drawers']]) {
      const base64 = (await readFile(join(directory, `${direction}-${surface}.png`))).toString('base64');
      tiles.push(`<section><h2>${direction.toUpperCase()} / ${name}</h2><p>${subtitle}</p><img alt="${name}: ${label}" src="data:image/png;base64,${base64}"></section>`);
    }
    await comparisonPage.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:30px 30px 24px;background:#f4f3ed;color:#2c342d;font-family:Inter,Arial,sans-serif}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:25px}h1{font-size:24px;margin:0;font-weight:550;letter-spacing:-.5px}header span{font-size:12px;color:#777f70}main{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}h2{font-size:17px;margin:0 0 5px;font-weight:550}p{font-size:12px;color:#747d6d;margin:0 0 15px}img{display:block;width:100%;border:1px solid #d2d5c8;border-radius:11px}footer{font-size:11px;color:#7d8575;margin-top:21px}</style></head><body><header><h1>Papercup · ${label}</h1><span>Three native directions · sample data</span></header><main>${tiles.join('')}</main><footer>Remote actions reuse psu saved connections. Visual mockups; native behavior is not implemented.</footer></body></html>`);
    await comparisonPage.screenshot({ path: join(directory, `compare-${surface}.png`), animations: 'disabled' });
    captures.push({ surface, file: `compare-${surface}.png`, comparison: true });
  }
  await comparisonPage.close();
  const overflow = captures.flatMap(capture => (capture.bounds || []).filter(rect => rect.left < 0 || rect.top < 32 || rect.right > 1440 || rect.bottom > 880).map(rect => ({ file: capture.file, ...rect })));
  const verification = { capturedAt: new Date().toISOString(), viewport: { width: 1440, height: 880 }, captures, browserErrors: errors, networkRequests: network, windowOverflow: overflow, purpose: 'Visual mockup rendering; not production native integration acceptance.' };
  await writeFile(join(directory, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ captures: captures.length, browserErrors: errors, networkRequests: network.length, windowOverflow: overflow }));
  if (errors.length || network.length || overflow.length) process.exitCode = 1;
} finally {
  await browser.close();
}
