import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 1 });
const errors = [], network = [], captures = [], interactions = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (!request.url().startsWith('file:') && !request.url().startsWith('data:')) network.push(request.url());
});
const url = pathToFileURL(join(directory, 'inbox.html'));
url.searchParams.set('capture', '1');
try {
  await page.goto(url.href);
  await page.waitForFunction(() => Boolean(window.__inbox));
  await page.evaluate(() => document.fonts.ready);
  for (const layout of ['a', 'b', 'c']) {
    await page.evaluate(layout => window.__inbox.reset(layout), layout);
    await page.getByRole('radio', { name: /Badge only/ }).click();
    const replyActionVisible = await page.locator('[data-send]').evaluate(el => {
      const action = el.getBoundingClientRect();
      const viewport = el.closest('.queue,.focus-body').getBoundingClientRect();
      return action.top >= viewport.top && action.bottom <= viewport.bottom;
    });
    assert.ok(replyActionVisible, `${layout}: primary reply action must be visible without scrolling`);
    const file = `inbox-${layout}.png`;
    try {
      await page.locator('.panel').screenshot({ path: join(directory, file), animations: 'disabled' });
    } catch (error) {
      throw new Error(`Inbox screenshot failed for layout ${layout}; browserErrors=${JSON.stringify(errors)}`, { cause: error });
    }
    const geometry = await page.locator('.panel').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    assert.ok(geometry.x >= 0 && geometry.y >= 32 && geometry.right <= 1440 && geometry.bottom <= 880, `${layout}: panel outside desktop`);
    assert.equal(geometry.scrollWidth, geometry.clientWidth, `${layout}: horizontal overflow`);
    captures.push({ layout, file, geometry });

    await page.getByRole('button', { name: /Send & next/ }).click();
    assert.equal(await page.evaluate(() => window.__inbox.get().done), 1);
    assert.equal(await page.evaluate(() => window.__inbox.get().pending), 3);
    await page.getByRole('status').filter({ hasText: 'nothing was sent' }).waitFor();
    interactions.push(`${layout}: quick answer advances queue and confirms sample-only save`);

    await page.getByRole('textbox', { name: 'Or write a reply' }).fill('Please show the preview after lunch.');
    await page.keyboard.press('Control+Enter');
    assert.equal(await page.evaluate(() => window.__inbox.get().done), 2);
    interactions.push(`${layout}: written reply with Ctrl+Enter advances queue`);

    await page.getByRole('button', { name: 'Snooze' }).click();
    assert.equal(await page.evaluate(() => window.__inbox.get().snoozed), 1);
    assert.equal(await page.evaluate(() => window.__inbox.get().pending), 1);
    interactions.push(`${layout}: snooze removes one sample question`);

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__inbox.get().hidden), true);
    await page.keyboard.press('Control+Alt+i');
    assert.equal(await page.evaluate(() => window.__inbox.get().hidden), false);
    interactions.push(`${layout}: Escape dismisses; browser shortcut summons`);
  }
  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: 'Blocking only' }).click();
  assert.equal(await page.locator('.list-row').count(), 1);
  interactions.push('b: blocking filter retains only the blocking question');
  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: /Rowan.*Ready for/ }).click();
  assert.match(await page.locator('.detail h2').innerText(), /Ubuntu sidebar/);
  interactions.push('b: selecting a question changes the reading pane');

  // Exercise the preview's complete bulk journey, including scope and resume.
  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: 'Blocking only' }).click();
  await page.getByRole('button', { name: 'Bulk resolve 1 filtered items' }).click();
  const filteredRun = await page.evaluate(() => window.__inbox.get().bulk);
  assert.deepEqual(filteredRun.seed, ['arrival']);
  await page.getByRole('button', { name: /Blocking only/ }).click();
  assert.equal(await page.locator('.list-row').count(), 4);
  assert.deepEqual(await page.evaluate(() => window.__inbox.get().bulk.seed), ['arrival']);
  interactions.push('b bulk: starts from exact visible filtered rows; later filter changes do not widen the run');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__inbox.get().bulk.phase), 'review');
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 0);
  await page.getByRole('button', { name: /Continue .* retryable/ }).click();
  assert.equal(await page.evaluate(() => window.__inbox.get().bulk.id), filteredRun.id);
  await page.waitForFunction(() => window.__inbox.get().bulk.phase === 'review');
  assert.equal(await page.evaluate(() => window.__inbox.get().bulk.decided), 1);
  interactions.push('b bulk: Stop preserves questions and Continue resumes the same run');

  await page.evaluate(() => window.__inbox.reset('b'));
  await page.getByRole('button', { name: 'Bulk resolve 4 filtered items' }).click();
  const runId = await page.evaluate(() => window.__inbox.get().bulk.id);
  await page.locator('.panel').screenshot({ path: join(directory, 'inbox-b-running.png'), animations: 'disabled' });
  captures.push({ file: 'inbox-b-running.png', layout: 'b', state: 'running' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+i');
  assert.equal(await page.evaluate(() => window.__inbox.get().bulk.id), runId);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__inbox));
  assert.equal(await page.evaluate(() => window.__inbox.get().bulk.id), runId);
  await page.waitForFunction(() => window.__inbox.get().bulk.phase === 'review');
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 0);
  interactions.push('b bulk: existing run survives dismiss/summon and page reload; assessment alone sends no answers');
  await page.getByRole('button', { name: 'Review decisions' }).click();
  assert.equal(await page.locator('.rec-card').count(), 3);
  assert.equal(await page.locator('.owner-question').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Accept 0 selected' }).isDisabled(), true);
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 0);
  interactions.push('b bulk: grouped reasons and editable replies; owner decision excluded; explicit selection required');
  await page.getByRole('checkbox', { name: 'Select reply for Maya' }).check();
  await page.locator('#draft-arrival').fill('');
  assert.equal(await page.getByRole('button', { name: 'Accept 1 selected' }).isDisabled(), true);
  const editedReply = 'Keep the badge quiet; I will open Inbox after my current task.';
  await page.locator('#draft-arrival').fill(editedReply);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__inbox));
  assert.equal(await page.locator('#draft-arrival').inputValue(), editedReply);
  assert.equal(await page.getByRole('checkbox', { name: 'Select reply for Maya' }).isChecked(), true);
  await page.locator('.panel').screenshot({ path: join(directory, 'inbox-b-review.png'), animations: 'disabled' });
  captures.push({ file: 'inbox-b-review.png', layout: 'b', state: 'review' });
  const acceptVisible = await page.locator('[data-bulk-accept]').evaluate(el => {
    const r = el.getBoundingClientRect(), pane = el.closest('.queue').getBoundingClientRect();
    return r.top >= pane.top && r.bottom <= pane.bottom;
  });
  assert.ok(acceptVisible, 'b bulk: explicit acceptance visible while reviewing');
  await page.getByRole('button', { name: 'Accept 1 selected' }).click();
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 1);
  assert.equal(await page.evaluate(() => window.__inbox.get().drafts.arrival), editedReply);
  assert.equal(await page.locator('.rec-card').count(), 2);
  interactions.push('b bulk: empty replies cannot apply; edits and selection survive reload; accepts only selected edited reply');
  await page.getByRole('checkbox', { name: 'Suggested replies · 2' }).check();
  await page.getByRole('button', { name: 'Accept 2 selected' }).click();
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 3);
  assert.equal(await page.evaluate(() => window.__inbox.get().pending), 1);
  await page.getByRole('button', { name: 'Answer this question' }).click();
  assert.match(await page.locator('.detail h2').innerText(), /interface polish/);
  await page.getByRole('radio', { name: 'Maintenance first' }).click();
  await page.getByRole('button', { name: /Send & next/ }).click();
  assert.equal(await page.evaluate(() => window.__inbox.get().done), 4);
  await page.getByRole('button', { name: 'Dismiss summary' }).click();
  assert.equal(await page.getByRole('button', { name: 'Bulk resolve 0 filtered items' }).isDisabled(), true);
  interactions.push('b bulk: grouped acceptance leaves owner-only question for manual answer; empty queue cannot start a run');

  const bulkComparison = await browser.newPage({ viewport: { width: 1720, height: 800 }, deviceScaleFactor: 1 });
  const bulkTiles = [];
  for (const [file, title, subtitle] of [
    ['inbox-b.png', '1 · Start from your queue', 'Bulk resolve the exact filtered questions you see.'],
    ['inbox-b-running.png', '2 · Keep working', 'Progress and Stop stay at the foot of the list.'],
    ['inbox-b-review.png', '3 · Review with context', 'Read reasons, edit replies, accept only what you choose.'],
  ]) {
    const base64 = (await readFile(join(directory, file))).toString('base64');
    bulkTiles.push(`<section><h2>${title}</h2><p>${subtitle}</p><img alt="${title}" src="data:image/png;base64,${base64}"></section>`);
  }
  await bulkComparison.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#f4f3ed;color:#29372e;font-family:Inter,Arial,sans-serif}h1{font-size:25px;font-weight:550;letter-spacing:-.6px;margin:0 0 8px}header p{font-size:12px;color:#73816b;margin:0 0 25px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}h2{font-size:15px;font-weight:550;margin:0 0 8px}p{font-size:11px;color:#6a7b63;margin:0 0 14px}img{display:block;width:100%;border-radius:8px;box-shadow:0 6px 22px #25331f19}footer{font-size:11px;color:#72826b;margin-top:20px}</style></head><body><header><h1>Inbox B / Bulk resolving</h1><p>Selected direction · question list + context pane · existing GUI workflow</p></header><main>${bulkTiles.join('')}</main><footer>Interactive design preview · sample questions and replies · native product acceptance remains separate</footer></body></html>`);
  await bulkComparison.screenshot({ path: join(directory, 'inbox-bulk-states.png'), animations: 'disabled' });
  captures.push({ file: 'inbox-bulk-states.png', comparison: true });
  await bulkComparison.close();

  const comparison = await browser.newPage({ viewport: { width: 1810, height: 1015 }, deviceScaleFactor: 1 });
  const tiles = [];
  for (const [layout, title, subtitle] of [
    ['a', 'A · Question stack', 'Small footprint · answer directly in each card'],
    ['b', 'B · Inbox + context', 'More context · scan the queue while replying'],
    ['c', 'C · Focus queue', 'One decision at a time · keep moving']
  ]) {
    const base64 = (await readFile(join(directory, `inbox-${layout}.png`))).toString('base64');
    tiles.push(`<section><h2>${title}</h2><p>${subtitle}</p><img alt="${title}" src="data:image/png;base64,${base64}"></section>`);
  }
  await comparison.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#f4f3ed;color:#29372e;font-family:Inter,Arial,sans-serif}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}h1{font-size:25px;font-weight:550;letter-spacing:-.6px;margin:0}header span{font-size:12px;color:#73816b}main{display:grid;grid-template-columns:438px 824px 490px;gap:22px;transform:scale(.974);transform-origin:top left}h2{font-size:16px;font-weight:550;margin:0 0 7px}p{font-size:11px;color:#6a7b63;margin:0 0 17px}img{display:block;width:100%;border-radius:8px;box-shadow:0 6px 22px #25331f19}footer{font-size:11px;color:#72826b;margin-top:6px}</style></head><body><header><h1>Workbench / Inbox</h1><span>Same question. Three ways to answer. · Native sidebar design study</span></header><main>${tiles.join('')}</main><footer>Illustrative questions · local interactions only · no live replies or OS shortcut registration</footer></body></html>`);
  await comparison.screenshot({ path: join(directory, 'compare-inbox.png'), animations: 'disabled' });
  captures.push({ file: 'compare-inbox.png', comparison: true });
  await comparison.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  const verification = { capturedAt: new Date().toISOString(), purpose: 'Visual mockup and sample interaction verification; not native product acceptance.', captures, interactions, browserErrors: errors, externalRequests: network };
  await writeFile(join(directory, 'inbox-verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ captures: captures.length, interactions: interactions.length, browserErrors: errors, externalRequests: network.length }));
} finally {
  await browser.close();
}
