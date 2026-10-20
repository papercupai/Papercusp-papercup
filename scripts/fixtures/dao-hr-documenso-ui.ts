/** Real provider UI actions shared by sandbox and isolated native E2E tests. */
import { randomBytes } from 'node:crypto';
import type { Browser, Page } from 'playwright-core';
import { expect } from 'vitest';
import { documensoCompletionDiagnostic, type SigningPerson } from '../../packages/operator-core/lib/dao-hr/documenso';

const baseUrl = process.env.DOCUMENSO_URL ?? '';
const mailUrl = process.env.DOCUMENSO_TEST_MAIL_URL ?? '';

/** Consume and retain the refusal before asserting; never retain arbitrary response text. */
export async function assertCompletionResponse(response: Pick<Response, 'status' | 'json'>, retain: (diagnostic: object) => void) {
  const body = await response.json().catch(() => null);
  const completion = documensoCompletionDiagnostic.safeParse(body?.completion);
  const codes = ['not_configured', 'provider_refused', 'invalid_completion', 'invalid_webhook', 'invalid_transition', 'contract_missing', 'invalid_input'];
  const diagnostic = { status: response.status, ok: body?.ok === true,
    ...(body?.error !== undefined ? { error: codes.includes(body.error) ? body.error as string : 'unclassified' } : {}),
    ...(completion.success ? { completion: completion.data } : {}) };
  retain(diagnostic);
  expect(diagnostic, 'Authenticated provider completion response').toMatchObject({ status: 200, ok: true });
}

function safeUiErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unclassified';
  // Classify against fixed literals; never copy an arbitrary message fragment.
  // Playwright's message also contains URLs, input values and its call log.
  const networkCodes = ['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
    'ERR_EMPTY_RESPONSE', 'ERR_ADDRESS_UNREACHABLE', 'ERR_NAME_NOT_RESOLVED',
    'ERR_INVALID_URL', 'ERR_ABORTED'] as const;
  const networkCode = error.message.match(/net::(ERR_[A-Z_]+)/)?.[1];
  if (networkCodes.some(code => code === networkCode)) return networkCode!;
  if (error.message.includes('Cannot navigate to invalid URL')) return 'invalid-url';
  if (error.message.includes('Target page, context or browser has been closed')) return 'target-closed';
  if (error.message.includes('Page crashed')) return 'page-crashed';
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AssertionError') return 'assertion';
  return 'unclassified';
}

async function uiPhase<T>(page: Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    // Do not include URLs, values, page text or Playwright call logs: they may
    // contain verification links, signing links, passwords or a new API token.
    const controls = await page.locator('input,button,[role="tab"]').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, name: element.getAttribute('name'), type: element.getAttribute('type'),
      testId: element.getAttribute('data-testid'), invalid: element.getAttribute('aria-invalid'),
      label: element.tagName === 'INPUT' ? element.getAttribute('aria-label') : element.textContent?.slice(0,80),
    }))).catch(() => []);
    const issues = await page.locator('body').evaluate(element => {
      const text = (element as HTMLElement).innerText;
      // Only return fixed categories, never provider text that could echo input.
      return [
        ['signup-disabled', 'Signup is currently disabled'],
        ['disposable-email', 'Disposable email addresses are not allowed'],
        ['account-creation-refused', 'We were unable to create your account'],
        ['captcha', 'Human verification required'],
        ['signature-required', 'We need your signature'],
        ['password-policy', 'Password should not be common'],
      ].filter(([, message]) => text.includes(message!)).map(([code]) => code);
    }).catch(() => []);
    const signupFields = name === 'submit provider signup' ?
      await page.locator('input').evaluateAll(elements => elements.flatMap(element => {
        const input = element as HTMLInputElement;
        if (!['name', 'email', 'password'].includes(input.name)) return [];
        // Fixed field categories and booleans only. Browser validation messages
        // and values can include the identity or password being submitted.
        return [{ field: input.name, present: input.value.length > 0,
          valid: input.validity.valid, valueMissing: input.validity.valueMissing,
          typeMismatch: input.validity.typeMismatch, tooShort: input.validity.tooShort,
          patternMismatch: input.validity.patternMismatch, customError: input.validity.customError }];
      })).catch(() => []) : undefined;
    const fieldLayout = name.includes('provider canvas signature field') ?
      await page.locator('#field-tooltip').evaluateAll(elements => elements.slice(0, 4).map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const document = element.ownerDocument;
        const centerTarget = document.elementFromPoint(x + width / 2, y + height / 2)?.tagName;
        // Geometry and fixed tag categories only: no DOM text, attributes,
        // URLs or provider identities enter the retained failure evidence.
        return { x, y, width, height,
          viewportWidth: document.defaultView?.innerWidth ?? 0,
          viewportHeight: document.defaultView?.innerHeight ?? 0,
          canvasCount: document.querySelectorAll('canvas').length,
          centerTarget: ['CANVAS', 'BUTTON', 'INPUT', 'DIV', 'SPAN'].includes(centerTarget ?? '') ? centerTarget : 'other' };
      })).catch(() => []) : undefined;
    const errorType = error instanceof Error && ['TimeoutError', 'AssertionError', 'Error'].includes(error.name) ? error.name : 'unexpected';
    throw new Error('Documenso UI phase failed: ' + name + '; errorType=' + errorType +
      '; errorCode=' + safeUiErrorCode(error) + '; issues=' + JSON.stringify(issues) + '; controls=' + JSON.stringify(controls) +
      (signupFields === undefined ? '' : '; signupFields=' + JSON.stringify(signupFields)) +
      (fieldLayout === undefined ? '' : '; fieldLayout=' + JSON.stringify(fieldLayout)));
  }
}

async function savedSignature(page: Page, name: string) {
  // Upstream packages/app-tests/e2e/fixtures/signature.ts uses these maintained
  // test ids. Use UI input and the dialog action, rather than injecting state.
  await page.getByTestId('signature-pad-dialog-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await dialog.getByTestId('signature-pad-type-input').fill(name);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => dialog.isVisible(), { timeout: 30_000 }).toBe(false);
}

async function verifyEmail(page: Page, email: string) {
  let messageId: string | undefined;
  await expect.poll(async () => {
    const response = await fetch(mailUrl + '/email', { signal: AbortSignal.timeout(5000) });
    expect(response.ok).toBe(true);
    const messages = await response.json() as Array<{ id: string; to: Array<{ address: string }> }>;
    messageId = messages.find(message => message.to.some(recipient => recipient.address === email))?.id;
    return Boolean(messageId);
  }, { timeout: 30_000 }).toBe(true);
  const response = await fetch(mailUrl + '/email/' + encodeURIComponent(messageId!), { signal: AbortSignal.timeout(5000) });
  expect(response.ok).toBe(true);
  const message = await response.json() as { html: string };
  const links = [...message.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]!.replaceAll('&amp;', '&'));
  const verification = links.find(link => {
    const url = new URL(link, baseUrl);
    return url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/verify-email/');
  });
  expect(Boolean(verification)).toBe(true);
  await page.goto(verification!);
  await expect.poll(() => page.locator('body').innerText(), { timeout: 30_000 }).toMatch(/Email Confirmed|Email already confirmed/i);
}

export async function register(browser: Browser, person: SigningPerson) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const password = randomBytes(24).toString('base64url') + 'Aa1!';
  await uiPhase(page, 'open provider signup form', async () => {
    await page.goto(baseUrl + '/signup');
  });
  // The interactive dialog proves the client form has hydrated. Filling the
  // server-rendered inputs first can lose those values when React attaches.
  await uiPhase(page, 'save required signup signature', () => savedSignature(page, person.name));
  await uiPhase(page, 'fill provider signup identity', async () => {
    await page.locator('input[name="name"]').fill(person.name);
    await page.locator('input[name="email"]').fill(person.email);
    await page.locator('input[name="password"]').fill(password);
  });
  await uiPhase(page, 'submit provider signup', async () => {
    expect({ name: await page.locator('input[name="name"]').inputValue() === person.name,
      email: await page.locator('input[name="email"]').inputValue() === person.email,
      password: await page.locator('input[name="password"]').inputValue() === password },
    'Signup fields retain the intended identity').toEqual({ name: true, email: true, password: true });
    expect(await page.locator('input[name="email"]').evaluate(input => (input as HTMLInputElement).form!.checkValidity())).toBe(true);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toBe('/signup');
  });
  await uiPhase(page, 'verify fixture email through provider UI', () => verifyEmail(page, person.email));
  return { context, page };
}

export async function authenticatedAccount(page: Page, email: string) {
  // Signup establishes the session, and verification keeps it. Confirm the
  // account rather than navigating to /signin, which redirects signed-in users.
  // This reads the provider session; it does not create/authenticate a fixture.
  const response = await page.context().request.get(baseUrl + '/api/auth/session');
  expect(response.ok()).toBe(true);
  const session = await response.json();
  expect(session.isAuthenticated).toBe(true);
  expect(session.user?.email === email).toBe(true);
}

export async function accountToken(page: Page) {
  const team = await uiPhase(page, 'find authenticated provider team', async () => {
    await page.goto(baseUrl + '/');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toMatch(/^\/t\/[^/]+\//);
    return new URL(page.url()).pathname.match(/^\/t\/([^/]+)\//)![1]!;
  });
  await uiPhase(page, 'open team API token dialog', async () => {
    await page.goto(baseUrl + '/t/' + team + '/settings/tokens');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
  });
  const dialog = page.getByRole('dialog');
  await uiPhase(page, 'submit team API token form', async () => {
    await dialog.locator('input[name="tokenName"]').fill('DAO HR non-binding sandbox');
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  });
  let token = '';
  await uiPhase(page, 'read created provider token', async () => {
    // Upstream createApiToken emits `api_${alphaid(16)}`: exactly 20
    // characters. Assert a boolean so a failure never prints the credential.
    await expect.poll(async () => {
      token = await dialog.locator('input[name="createdToken"]').inputValue();
      return token.startsWith('api_') && token.length === 20;
    }, { timeout: 30_000 }).toBe(true);
  });
  await uiPhase(page, 'close created-token dialog', async () => {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(() => dialog.isVisible(), { timeout: 30_000 }).toBe(false);
  });
  return token;
}

export async function sign(page: Page, url: string) {
  await uiPhase(page, 'navigate signing link', async () => {
    await page.goto(url);
  });
  await uiPhase(page, 'wait for provider PDF viewer readiness', async () => {
    // Next Field is usable before the lazy PDF viewer mounts. Its handler
    // sends data-scroll-to-page only to an existing [data-pdf-content]; an
    // early click loses navigation to signature pages outside the overscan.
    // A visible Konva canvas proves the client viewer mounted, rather than
    // treating the server-rendered signing controls as viewer readiness.
    await page.locator('[data-pdf-content] .konva-container canvas').first().waitFor({ state: 'visible' });
  });
  await uiPhase(page, 'reveal next provider signature field', async () => {
    await page.getByRole('button', { name: 'Next Field', exact: true }).first().click();
  });
  const field = page.locator('#field-tooltip');
  await uiPhase(page, 'locate provider canvas signature field', async () => {
    // Envelope API v2 uses Konva canvas, not the legacy data-field-type DOM.
    // Next Field positions this provider-owned overlay at the unsigned field.
    await field.waitFor({ state: 'visible' });
  });
  const bounds = await uiPhase(page, 'position provider canvas signature field', async () => {
    await field.scrollIntoViewIfNeeded();
    const bounds = await field.boundingBox();
    expect(Boolean(bounds && bounds.width > 0 && bounds.height > 0)).toBe(true);
    return bounds!;
  });
  await uiPhase(page, 'activate provider canvas signature field', async () => {
    // Click its screen center through the pointer; never inject canvas state.
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect.poll(async () => await page.getByRole('button', { name: 'Complete', exact: true }).count() > 0 ||
      await page.getByRole('dialog').isVisible(), { timeout: 30_000 }).toBe(true);
  });
  await uiPhase(page, 'use signature pad when requested', async () => {
    if (await page.getByRole('dialog').isVisible()) {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
      await dialog.getByTestId('signature-pad-type-input').fill('NON-BINDING TEST SIGNATURE');
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
    }
    await expect.poll(() => page.getByRole('button', { name: 'Complete', exact: true }).count(), { timeout: 30_000 }).toBeGreaterThan(0);
  });
  await uiPhase(page, 'confirm document signing consent', async () => {
    await page.getByRole('button', { name: 'Complete', exact: true }).first().click();
    const confirmation = page.getByRole('dialog');
    await confirmation.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect.poll(() => confirmation.isVisible(), { timeout: 30_000 }).toBe(false);
  });
}
