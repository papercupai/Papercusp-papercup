import type { Page } from '@playwright/test';

/**
 * Put the page on the origin of `url` before an in-page `fetch(url)`.
 *
 * A fixture page starts on about:blank, which has an OPAQUE origin, and the
 * operator API sends no CORS headers (the desktop is same-origin by design). So
 * an in-page fetch to the API from about:blank fails with "TypeError: Failed to
 * fetch" before it ever reaches the route, and a spec asserting on the route's
 * status or an abort measures nothing (WI-10006736). The origin must match
 * exactly: `localhost` and `127.0.0.1` are different origins.
 *
 * Callers should build `url` from the same host as the Playwright config's
 * baseURL (`http://localhost:<port>`), so the egress monitor sees these
 * requests as same-origin.
 */
export async function onAppOrigin(page: Page, url: string): Promise<void> {
  const origin = new URL(url).origin;
  if (page.url().startsWith(`${origin}/`)) return;
  await page.goto(`${origin}/favicon.ico`);
}
