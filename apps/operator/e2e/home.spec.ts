import { expect, test } from './_egress';

/**
 * Root route (`/`) behavior.
 *
 * The standalone marketing home (wordmark + Marketplace/Support nav) was
 * RETIRED — `/` is now a pure redirect gateway (operator-vite
 * `src/routes/index.tsx`): it reads the setup-wizard state and throws a
 * TanStack-Router redirect to `/adv?tab=harnesses` once setup is finished,
 * or `/setup` otherwise. These specs assert that current behavior — landing
 * on a real app surface with no console errors — instead of the dead
 * marketing page.
 */
test.describe('root route', () => {
  // The unfinished-setup landing is `firstRunTarget()` in operator-vite
  // `src/routes/index.tsx`: `/onboarding` while the agent-first onboarding flag is
  // on (the default), `/setup` otherwise. A fresh/isolated DB is unfinished, so
  // the old `/(adv|setup)/` pin failed every isolated run (WI-10006791).
  const LANDING = /\/(adv|setup|onboarding)\b/;

  test('/ redirects to the primary surface (/adv) or the first-run surface', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(LANDING);
  });

  test('/ lands without app console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(LANDING);
    // Flag only genuine app errors. Ignore: third-party / hydration noise, and
    // failed-resource 401/403 — the landed app surface fetches authed data, and
    // a raw e2e browser has no verified session, so those are expected here.
    expect(
      consoleErrors.filter(
        (e) =>
          !/chatwoot|chat\.papercupai|hydration|favicon/i.test(e) &&
          !/Failed to load resource.*\b(401|403)\b/i.test(e) &&
          !/\b(401|403)\b.*(Unauthorized|Forbidden)/i.test(e),
      ),
    ).toEqual([]);
  });
});
