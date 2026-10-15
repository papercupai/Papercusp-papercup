/**
 * Playwright globalSetup: warm the Vite dev server before any worker starts.
 *
 * Why: the webServer readiness probe (`url: BASE_URL`) passes as soon as Vite
 * answers index.html, but a cold dev server still has to discover, optimize and
 * transform the SPA's dependency graph on the FIRST page load ("Re-optimizing
 * dependencies because vite config has changed" in every isolated rig run,
 * since the rig copies the source into a fresh tree). Every worker's first test
 * raced that work and died on `page.goto: Timeout 30000ms exceeded`. Measured
 * 2026-10-06 (run group operator-e2e-specfix3-WI-10006792-20261006T214958Z): the
 * first test of each of the 4 workers timed out in goto while later tests in the
 * same files passed (WI-10006792, plan operator-e2e-standing-isolated-run-2026-10-06
 * P-004). Paying that cost once here, with a generous bound, removes the class.
 *
 * Playwright runs webServer setup before globalSetup (plugin setup tasks are
 * queued first), so the server is listening by the time this runs.
 *
 * Fail-soft: a warm-up failure is logged and the run continues; the specs then
 * report their own failures. OPERATOR_E2E_SKIP_WARMUP=1 skips it.
 */
import { chromium, type Browser, type FullConfig } from '@playwright/test';

/** Routes whose lazy chunks pull most of the dependency graph. */
export const WARMUP_PATHS = ['/adv', '/settings/agent', '/cupboard', '/admin/plans'] as const;

const WARMUP_NAV_TIMEOUT_MS = 180_000;
const WARMUP_MOUNT_TIMEOUT_MS = 120_000;

function isLocalUrl(raw: string): boolean {
  try {
    const { hostname, protocol } = new URL(raw);
    if (protocol === 'data:' || protocol === 'blob:') return true;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export type WarmDevServerOptions = {
  paths?: readonly string[];
  readySelector?: string;
  strict?: boolean;
};

export default async function warmDevServer(config: FullConfig, options: WarmDevServerOptions = {}): Promise<void> {
  if (process.env.OPERATOR_E2E_SKIP_WARMUP === '1') return;
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const started = Date.now();
  let browser: Browser | undefined;
  try {
    const use = config.projects[0]?.use;
    browser = await chromium.launch({
      ...use?.launchOptions,
      ...(use?.channel ? { channel: use.channel } : {}),
    });
    const page = await browser.newPage();
    // Never let the warm-up reach off-box: the specs' egress sensor does not
    // watch globalSetup, so keep it as hermetic as the specs themselves.
    await page.route('**/*', (route) =>
      isLocalUrl(route.request().url()) ? route.continue() : route.abort(),
    );
    for (const path of options.paths ?? WARMUP_PATHS) {
      const url = new URL(path, baseURL).toString();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: WARMUP_NAV_TIMEOUT_MS });
        if (options.readySelector) {
          // A profile's lazy view must mount before its test worker starts.
          // Shell children alone also appear while Suspense is still loading.
          await page.locator(options.readySelector).waitFor({
            state: 'visible', timeout: WARMUP_MOUNT_TIMEOUT_MS,
          });
        } else {
          await page.waitForFunction(
            () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
            null,
            { timeout: WARMUP_MOUNT_TIMEOUT_MS },
          );
        }
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      } catch (err) {
        if (options.strict) throw err;
        console.warn(`[e2e warm-up] ${path} did not settle: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  } catch (err) {
    if (options.strict) throw err;
    console.warn(`[e2e warm-up] skipped after error: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    try {
      await browser?.close();
    } catch (err) {
      if (options.strict) throw err;
      console.warn(`[e2e warm-up] browser cleanup failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log(`[e2e warm-up] preparation finished in ${Math.round((Date.now() - started) / 1000)}s`);
}
