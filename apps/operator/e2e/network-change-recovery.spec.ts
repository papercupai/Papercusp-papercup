/**
 * WI-6554700010008424 — the recovery path of `waitVisibleRecoveringNetworkChange` (_egress.ts).
 *
 * The helper is a TEMPORARY MITIGATION: this dev box churns network interfaces, Chromium answers
 * each address change by aborting in-flight requests with net::ERR_NETWORK_CHANGED, and a page
 * whose module graph was loading at that moment never mounts. The helper reloads once, and only
 * for that error. Ordinary e2e runs almost never hit the churn, so they prove the helper does not
 * regress anything but never exercise the reload. This spec exercises it on purpose.
 *
 * Chromium cannot be made to emit ERR_NETWORK_CHANGED on demand: neither `route.abort` nor the
 * CDP `Fetch.failRequest` reasons include it. So the spec serves a real page through a route
 * (first load blank, later loads mounted) and delivers a `requestfailed` event carrying that exact
 * errorText to the page's listeners. What is under test is the helper's decision and reload, not
 * Chromium's error classification.
 */
import { test, expect, type Page, waitVisibleRecoveringNetworkChange, watchNetworkChange } from './_egress';

const PROBE_PATH = '/__wi8424-network-change-probe';
const READY = '#network-change-ready';

/** Serve PROBE_PATH; `mounts(n)` decides whether load number n renders the ready element. */
async function serveProbe(page: Page, mounts: (load: number) => boolean): Promise<() => number> {
  let loads = 0;
  await page.route(`**${PROBE_PATH}`, async (route) => {
    loads += 1;
    const body = mounts(loads) ? `<main id="${READY.slice(1)}">mounted</main>` : '<main></main>';
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
  });
  return () => loads;
}

/** Deliver a request failure with `errorText` to every `requestfailed` listener on `page`. */
function deliverRequestFailure(page: Page, errorText: string): void {
  const request = { failure: () => ({ errorText }), url: () => `http://localhost${PROBE_PATH}/module.js` };
  (page as unknown as { emit(event: 'requestfailed', payload: unknown): boolean }).emit('requestfailed', request);
}

function recoveryAnnotations(): number {
  return test.info().annotations.filter((a) => a.type === 'network-change-recovery').length;
}

test.describe('waitVisibleRecoveringNetworkChange (WI-6554700010008424)', () => {
  test('reloads once and mounts when ERR_NETWORK_CHANGED left the first load blank', async ({ page }) => {
    const loads = await serveProbe(page, (n) => n >= 2);
    watchNetworkChange(page);
    await page.goto(PROBE_PATH);
    deliverRequestFailure(page, 'net::ERR_NETWORK_CHANGED');

    await waitVisibleRecoveringNetworkChange(page.locator(READY), 1_500);

    expect(loads()).toBe(2);
    expect(recoveryAnnotations()).toBe(1);
    await expect(page.locator(READY)).toBeVisible();
  });

  test('rethrows the timeout without reloading for any other request failure', async ({ page }) => {
    const loads = await serveProbe(page, () => false);
    watchNetworkChange(page);
    await page.goto(PROBE_PATH);
    deliverRequestFailure(page, 'net::ERR_CONNECTION_RESET');

    await expect(waitVisibleRecoveringNetworkChange(page.locator(READY), 1_000)).rejects.toThrow(/Timeout/);

    expect(loads()).toBe(1);
    expect(recoveryAnnotations()).toBe(0);
  });

  test('reloads at most once: a second blank load still fails the wait', async ({ page }) => {
    const loads = await serveProbe(page, () => false);
    watchNetworkChange(page);
    await page.goto(PROBE_PATH);
    deliverRequestFailure(page, 'net::ERR_NETWORK_CHANGED');

    await expect(waitVisibleRecoveringNetworkChange(page.locator(READY), 1_000)).rejects.toThrow(/Timeout/);

    expect(loads()).toBe(2);
    expect(recoveryAnnotations()).toBe(1);
  });
});
