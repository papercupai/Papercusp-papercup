/**
 * Multi-step UI flow: signup → land authenticated, navigate, verify state persistence.
 *
 * Catches:
 *   - Cookie not set correctly after signup
 *   - Redirect loop on /settings/user without auth
 *   - Form submit doesn't redirect on success
 *   - logout doesn't clear the cookie
 *
 * Username pattern (from app/login/page.tsx:210): [a-z0-9_-]{2,32}
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

function genUsername(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${rand}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 30);
}

async function doSignup(page: import('@playwright/test').Page, username: string): Promise<void> {
  // `?switch=1` (switch-account mode): the e2e operator is auto-signed-in as
  // the default user, and plain /login auto-redirects away when a session
  // exists (login.tsx: `if (j.user && !isSwitching) navigate(redirectTo)`),
  // which destabilises the form. Switch mode skips that redirect so the
  // signup form stays mounted — the same path a real signed-in user takes to
  // create another account.
  await page.goto(`${baseURL}/login?switch=1`);

  // Switch to signup mode — wait for the "Create a new user instead" toggle.
  // The form initially renders in login mode (only username + password checkbox).
  const toggle = page.getByRole('button', { name: /create a new user/i });
  await toggle.waitFor({ state: 'visible', timeout: 5_000 });
  await toggle.click();

  // After the toggle, the display_name input appears. Wait for it before filling.
  const displayNameInput = page.getByLabel(/display name/i);
  await displayNameInput.waitFor({ state: 'visible', timeout: 5_000 });

  // Fill required fields
  await page.getByLabel(/^username$/i).fill(username);
  await displayNameInput.fill(`E2E ${username.slice(-6)}`);

  // Submit, and read the signup response. A refused signup (e.g. 403
  // signup_disabled when papercusp-open-signup is off and a user already exists)
  // only shows a toast and stays on /login, which used to surface as a blind 10s
  // waitForURL timeout (WI-10006791). Fail with the server's own error instead.
  const [signupRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/signup') && r.request().method() === 'POST', { timeout: 15_000 }),
    page.getByRole('button', { name: /^create user$/i }).click(),
  ]);
  expect(signupRes.ok(), `POST /api/auth/signup -> ${signupRes.status()} ${await signupRes.text().catch(() => '')}`).toBe(true);

  // Wait for redirect off /login
  await page.waitForURL((u) => !u.toString().includes('/login'), {
    timeout: 10_000,
    waitUntil: 'commit',
  });
}

async function skipIfPgUnavailable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    const r = await request.get(`${baseURL}/api/auth/me`);
    const j = await r.json();
    return Boolean(j.pgUnavailable);
  } catch {
    return false;
  }
}

test.describe('UI flow: signup → settings round-trip', () => {
  test.beforeEach(async ({ request }) => {
    if (await skipIfPgUnavailable(request)) {
      test.skip(true, 'PG unavailable in this env; UI signup flow requires PG');
    }
  });

  test('signup creates session and lands authenticated', async ({ page, context }) => {
    const username = genUsername('flow1');
    await doSignup(page, username);

    // Verify session cookie is set
    const cookies = await context.cookies(baseURL);
    const session = cookies.find((c) => c.name === 'papercusp_session');
    expect(session?.value).toBeTruthy();
    expect(session?.httpOnly).toBe(true);

    // Verify /me reflects the new user
    const meRes = await page.request.get(`${baseURL}/api/auth/me`);
    const me = await meRes.json();
    expect(me.user?.username).toBe(username);
    expect(me.autoLogin).toBeFalsy();
  });

  test('authenticated user reaches /settings/user (no auth redirect)', async ({ page }) => {
    const username = genUsername('flow2');
    await doSignup(page, username);

    const res = await page.goto(`${baseURL}/settings/user`);
    expect(res?.status()).toBe(200);
    expect(page.url()).not.toContain('/login');
  });

  test('logout clears the session and reverts to default user', async ({ page }) => {
    const username = genUsername('flow3');
    await doSignup(page, username);

    // Confirm signed in
    let me = await page.request.get(`${baseURL}/api/auth/me`).then((r) => r.json());
    expect(me.user?.username).toBe(username);

    // POST /api/auth/logout
    const out = await page.request.post(`${baseURL}/api/auth/logout`);
    expect(out.status()).toBe(200);

    // After logout, /me should now return autoLogin=true (default user)
    me = await page.request.get(`${baseURL}/api/auth/me`).then((r) => r.json());
    expect(me.autoLogin).toBe(true);
    expect(me.user?.username).toBe('default');
  });

  test('login form sanitises invalid username input', async ({ page }) => {
    await page.goto(`${baseURL}/login?switch=1`);
    await page.getByRole('button', { name: /create a new user/i }).click();

    // The username input sanitises on change (login.tsx onChange): it lowercases
    // and strips anything outside [a-z0-9_-], so invalid characters never reach
    // the value. (A pattern="[a-z0-9_-]{2,32}" also guards length at submit.) So
    // filling mixed-case + punctuation yields a clean, valid value rather than a
    // patternMismatch — the input prevents bad input rather than just flagging it.
    const usernameInput = page.getByLabel(/^username$/i);
    await usernameInput.fill('UPPER Case!@#-ok');
    await expect(usernameInput).toHaveValue('uppercase-ok');
  });

  test('login as existing user works after signup', async ({ page, context }) => {
    const username = genUsername('flow5');
    await doSignup(page, username);

    // Logout
    await page.request.post(`${baseURL}/api/auth/logout`);
    await context.clearCookies();

    // Login as that user (passwordless flow allowed)
    await page.goto(`${baseURL}/login?switch=1`);
    await page.getByLabel(/^username$/i).fill(username);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    // waitUntil: 'commit' — resolve as soon as the post-submit navigation
    // leaves /login; don't wait for the heavy /adv shell to fully 'load'
    // (its persistent SSE streams + the box's load make 'load' flaky here).
    await page.waitForURL((u) => !u.toString().includes('/login'), {
      timeout: 15_000,
      waitUntil: 'commit',
    });

    const me = await page.request.get(`${baseURL}/api/auth/me`).then((r) => r.json());
    expect(me.user?.username).toBe(username);
  });
});
