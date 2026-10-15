import { test, expect } from './_egress';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadIsolatedHostedTestUserKit } from '../../../packages/operator-core/lib/llm-testing/isolated-hosted-test-user.mts';
import { tsImport } from 'tsx/esm/api';
import { capturePublicManualFailure, withPublicManualFailureEvidence } from '../lib/public-manual-failure-evidence.mts';

// Actual hosted admission and served pages, using the Portal's maintained TEST
// user kit. Explicit private-runtime inputs are required before creating data.
const enabled = process.env.PUBLIC_MANUAL_PRODUCT_E2E === '1';
const origin = process.env.PORTAL_TUTORIAL_SERVED_ORIGIN;
const portalRoot = process.env.PUBLIC_MANUAL_PRODUCT_PORTAL_ROOT;
test.use({ channel: 'chrome', trace: 'off', video: 'off',
  ignoreHTTPSErrors: !!origin && new URL(origin).hostname === 'localhost' });

// Share the retained fixture's isolated import/admission/cleanup boundary with
// the Vitest readiness case. No candidate tool graph enters this worker.
async function createHostedUser(opts: Record<string, unknown>) {
  const kit = await loadIsolatedHostedTestUserKit({ portalRoot: portalRoot! });
  return await kit.create(opts);
}

async function fixture(page: any) {
  expect(origin).toBeTruthy(); expect(portalRoot).toBeTruthy();
  expect(new URL(origin!).hostname).toBe('localhost');
  const artifactModule = await tsImport(pathToFileURL(resolve(portalRoot!, 'e2e/served-artifact.ts')).href, import.meta.url);
  const artifacts = { ...artifactModule.default, ...artifactModule };
  const response = await page.request.get(origin!);
  expect(response.status()).toBe(200);
  const release = artifacts.resolveServedRelease({ html: await response.text(),
    releasesDir: process.env.PORTAL_TUTORIAL_SERVED_RELEASES_DIR, journeyStartedAt: new Date() });
  expect(release.buildId).toBe(process.env.PORTAL_TUTORIAL_SERVED_BUILD_ID);
  return { kit: { create: createHostedUser }, release };
}

test.describe('manual instructions on an actual private hosted Portal', () => {
  test.skip(!enabled, 'Requires explicit retained Portal artifact and isolated operator/database');
  test.setTimeout(180_000);

  test('account icon exposes authenticated identity, Status and organization Billing', async ({ page }, info) => {
    const { kit, release } = await fixture(page);
    const nonce = randomUUID();
    const user = await kit.create({ email: `manual-account-${nonce}@papercusp.com`, attemptId: `manual-account-${nonce}`,
      firstName: 'Manual TEST', lastName: 'Account', displayName: 'Manual account TEST' });
    await withPublicManualFailureEvidence(async () => {
      await page.context().addCookies([user.cookie(origin!)]);
      await page.goto(origin!);
      await page.getByRole('button', { name: 'Manage your account and preferences', exact: true }).click();
      await page.getByRole('link', { name: 'Open account', exact: true }).click();
      const trigger = page.getByRole('button', { name: /^Portal account:.*Status:/ });
      await expect(trigger).toBeVisible();
      const panel = page.getByRole('dialog', { name: 'Portal account', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Manual');
      await expect(panel).toContainText('Status:');
      await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await panel.getByRole('link', { name: 'Billing', exact: true }).click();
      await expect(page).toHaveURL(new URL('/billing', origin!).href);
      await expect(page.locator('.billing-card')).toBeVisible();
      const guide = readFileSync(resolve(import.meta.dirname, '../../papercusp-docs/src/content/docs/accounts-and-billing.mdx'));
      await info.attach('manual-account-runtime', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        release, guideSha256: createHash('sha256').update(guide).digest('hex'),
        accountTrigger: true, statusLabel: true, authenticatedSignOut: true, billingDestination: true,
        scope: 'Actual TEST account status and Billing navigation; excludes payment, organization selection and manual shipment',
      })) });
    }, () => capturePublicManualFailure(page, info, origin!),
    () => user.cleanup('public manual account journey cleanup'));
  });

  test('authorized workspace lists admitted resources without claiming a connected host', async ({ page }, info) => {
    const { kit, release } = await fixture(page);
    const nonce = randomUUID();
    const user = await kit.create({ email: `manual-workspace-${nonce}@papercusp.com`, attemptId: `manual-workspace-${nonce}`,
      firstName: 'Manual TEST', lastName: 'Workspace', displayName: 'Manual workspace TEST', preassignedWorkspace: true });
    await withPublicManualFailureEvidence(async () => {
      await page.context().addCookies([user.cookie(origin!)]);
      const session = await page.request.get(new URL('/api/hosted/auth/session', origin!).href);
      expect(session.status()).toBe(200);
      expect((await session.json()).session.workspaceId).toBe(user.workspaceId);
      // Health and session admission do not exercise the workspace transport.
      // Verify this authenticated control-plane leg before a missing region can
      // obscure a relay refusal as an ordinary UI readiness failure.
      const controlPath = '/api/hosted/browser/rest-query?name=workspaceHosts.control&args=%7B%7D';
      const control = await page.request.get(new URL(controlPath, origin!).href);
      const controlBody = await control.json();
      await info.attach('manual-workspace-control-preflight', {
        contentType: 'application/json', body: Buffer.from(JSON.stringify({
          status: control.status(), error: controlBody.error ?? null,
          rowsPresent: Array.isArray(controlBody.rows),
          scope: 'Authenticated hosted workspace control query; excludes connector and provider readiness',
        })),
      });
      expect(control.ok(), `Hosted workspace control query returned HTTP ${control.status()}: ${controlBody.error ?? 'no named error'}`).toBe(true);
      expect(Array.isArray(controlBody.rows), 'Hosted workspace control query must return rows').toBe(true);
      await page.goto(origin!);
      await page.getByRole('button', { name: 'Choose the right workspace', exact: true }).click();
      await page.getByRole('link', { name: 'Open workspaces', exact: true }).click();
      const surface = page.locator('[data-portal-surface-slot="workspaces"]:not([hidden])');
      await expect(surface).toBeVisible();
      await expect(surface.getByRole('region', { name: 'Provider connections', exact: true })).toBeVisible();
      await expect(surface.getByRole('region', { name: 'Your workspaces', exact: true })).toBeVisible();
      await expect(surface).toContainText('Private tutorial TEST');
      await expect(surface).toContainText('none of the states below are health-verified');
      await info.attach('manual-workspace-runtime', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        release, sessionHasAuthorizedWorkspace: true, providerVisible: true, healthUnverifiedExplanation: true,
        scope: 'Real admission, session and served resource listing with inert provisioning transport; excludes actual provider readiness',
      })) });
    }, () => capturePublicManualFailure(page, info, origin!),
    () => user.cleanup('public manual workspace journey cleanup'));
  });
});
