/**
 * Find-in-page (Ctrl/⌘+F) end-to-end — the behaviours that only exist in a
 * real browser, since the engine is the CSS Custom Highlight API (jsdom can't
 * run it; the pure helpers are unit-tested in
 * `apps/operator/lib/find-in-page/engine.test.ts`).
 *
 * Covers: Ctrl+F opens the bar (claimed from the webview's native find);
 * typing highlights matches via `CSS.highlights['papercup-find']`; the count
 * reflects the match total; Enter/Shift+Enter move the active match
 * (`papercup-find-active`); Escape closes and clears all highlights.
 *
 * The search term is derived from whatever the route actually rendered, so the
 * spec isn't coupled to specific copy. Override the route with
 * OPERATOR_E2E_FIND_ROUTE if `/` is gated in your environment.
 */
import { test, expect, type Page } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;
// Default to `/support` — a static, auth-free SPA page with reliable text in
// `<main data-route-transition-page>`. (`/` redirects to /adv, whose main is
// auth-gated/sparse for an unauthenticated e2e browser → nothing to search.)
const ROUTE = process.env.OPERATOR_E2E_FIND_ROUTE ?? '/support';

// `/support` is the one route that deliberately boots the Chatwoot support widget
// (ChatwootWidget.tsx: shouldEnableSupportWidget → pathname starts with /support), which
// loads `<base>/packs/js/sdk.js` from our own chat host. That egress is the product working
// as designed on this route, not a vendoring bug, so declare it rather than fail every run
// (WI-10006845: the standing isolated run went red on exactly these 2 requests). Keep the
// default in step with ChatwootWidget's DEFAULT_BASE_URL; a drift fails loudly here with the
// egress report naming the new origin.
const CHATWOOT_ORIGIN = new URL(process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? 'https://chat.papercupai.com').origin;
test.use({ egressAllowedOrigins: ROUTE.startsWith('/support') ? [CHATWOOT_ORIGIN] : [] });

/** A word (≥4 letters) that is actually present in <main>, so a match exists. */
async function pickSearchTerm(page: Page): Promise<string> {
  const term = await page.evaluate(() => {
    const main = document.querySelector('main[data-route-transition-page]');
    const text = (main as HTMLElement | null)?.innerText ?? '';
    const word = text.match(/[A-Za-z]{4,}/)?.[0];
    return word ?? null;
  });
  expect(term, 'expected <main> to contain a ≥4-letter word to search for').toBeTruthy();
  return term as string;
}

const highlightSize = (page: Page, name: string) =>
  page.evaluate((n) => globalThis.CSS?.highlights?.get(n)?.size ?? 0, name);

async function openFind(page: Page) {
  await page.goto(`${baseURL}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  // NOTE: no waitForLoadState('networkidle') — the shell opens long-lived SSE
  // streams so the network never idles (would hang 30s). The web-first assert
  // below (main has text) is the real readiness gate.
  // Wait until <main> has rendered some text to search.
  await expect
    .poll(async () =>
      page.evaluate(
        () => (document.querySelector('main[data-route-transition-page]') as HTMLElement | null)?.innerText.length ?? 0,
      ),
    )
    .toBeGreaterThan(20);
  await page.keyboard.press('Control+f');
  return page.getByPlaceholder('Find in page');
}

test.describe('find-in-page (Ctrl+F)', () => {
  test('Ctrl+F opens the find bar and focuses the input', async ({ page }) => {
    const input = await openFind(page);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    // URL reflects open-state (nuqs ?find=1).
    expect(new URL(page.url()).searchParams.get('find')).toBeTruthy();
  });

  test('typing highlights matches and shows a non-zero count', async ({ page }) => {
    const input = await openFind(page);
    const term = await pickSearchTerm(page);
    await input.fill(term);

    await expect.poll(() => highlightSize(page, 'papercup-find')).toBeGreaterThan(0);
    const count = await page.locator('.pc-find__count').innerText();
    const total = Number(count.split('/')[1]);
    expect(total).toBeGreaterThan(0);
  });

  test('Enter moves to a match (registers the active highlight)', async ({ page }) => {
    const input = await openFind(page);
    const term = await pickSearchTerm(page);
    await input.fill(term);
    await expect.poll(() => highlightSize(page, 'papercup-find')).toBeGreaterThan(0);

    await input.press('Enter');
    // The active match is its own single-range highlight.
    await expect.poll(() => highlightSize(page, 'papercup-find-active')).toBe(1);
    // Count label is 1-based "n/total".
    const count = await page.locator('.pc-find__count').innerText();
    expect(Number(count.split('/')[0])).toBeGreaterThanOrEqual(1);
  });

  test('Escape closes the bar and clears all highlights', async ({ page }) => {
    const input = await openFind(page);
    const term = await pickSearchTerm(page);
    await input.fill(term);
    await expect.poll(() => highlightSize(page, 'papercup-find')).toBeGreaterThan(0);

    await input.press('Escape');
    await expect(input).toBeHidden();
    expect(await highlightSize(page, 'papercup-find')).toBe(0);
    expect(await highlightSize(page, 'papercup-find-active')).toBe(0);
    // nuqs applies the bar's state immediately but flushes the URL write on its own
    // throttled queue, so the hidden bar can be observed before `?find` is removed.
    // Poll the URL: a synchronous page.url() read here raced that flush and failed
    // with the stale "true" (WI-10006845, run group operator-e2e-nightly:ac3738ad-…).
    // A param that is never cleared still fails, at the poll timeout.
    await expect.poll(() => new URL(page.url()).searchParams.get('find')).toBeFalsy();
  });
});
