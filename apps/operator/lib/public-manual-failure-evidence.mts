import type { Page, TestInfo } from '@playwright/test';

// The e2e package is ESM; this explicit extension keeps its imported helper
// on the same Playwright loader without changing the operator's package type.
/** A revoked TEST session changes the page; collect evidence while it still exists. */
export async function withPublicManualFailureEvidence<T>(
  work: () => Promise<T>,
  capture: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Diagnostics must never replace the assertion that triggered them.
    try { await capture(); } catch { /* the original failure remains authoritative */ }
    throw error;
  } finally {
    await cleanup();
  }
}

export async function capturePublicManualFailure(page: Page, info: Pick<TestInfo, 'attach'>, origin: string) {
  // Capture the document FIRST: even read-only probes can race a polling render.
  const documentState = await page.evaluate(() => ({
    path: location.pathname + location.search,
    slots: Array.from(document.querySelectorAll<HTMLElement>('[data-portal-surface-slot]')).map(slot => ({
      key: slot.dataset.portalSurfaceSlot,
      hidden: slot.hidden,
      displayed: getComputedStyle(slot).display !== 'none',
      headings: Array.from(slot.querySelectorAll('h1,h2')).map(heading => heading.textContent),
    })),
    headings: Array.from(document.querySelectorAll('main h1,main h2')).map(heading => heading.textContent),
  }));
  await info.attach('manual-failure-document-before-cleanup', {
    contentType: 'application/json', body: Buffer.from(JSON.stringify(documentState)),
  });
  await info.attach('manual-failure-screenshot-before-cleanup', {
    contentType: 'image/png', body: await page.screenshot(),
  });
  const paths = [
    '/api/hosted/auth/session', '/api/apps',
    '/api/hosted/browser/rest-query?name=workspaceHosts.control&args=%7B%7D',
  ];
  const probes = await Promise.all(paths.map(async path => {
    try {
      const response = await page.request.get(new URL(path, origin).href, { timeout: 5_000 });
      const body = await response.json().catch(() => null);
      // Do not attach sessions, cookies, tenant IDs or the complete response.
      return { path, status: response.status(),
        errorCode: typeof body?.error === 'string' && /^[a-z][a-z0-9_]+$/.test(body.error) ? body.error : null,
        authenticated: path === paths[0] ? !!body?.session : undefined,
        workspaceAppEnabled: path === paths[1] ? Array.isArray(body?.apps)
          && body.apps.some((app: { kind?: string; enabled?: boolean }) => app.kind === 'workspaces' && app.enabled === true) : undefined,
        rowsPresent: path === paths[2] ? Array.isArray(body?.rows) : undefined };
    } catch { return { path, status: null, observation: 'probe unavailable' }; }
  }));
  await info.attach('manual-failure-probes-before-cleanup', {
    contentType: 'application/json', body: Buffer.from(JSON.stringify({ probes,
      scope: 'Failure diagnostics before TEST fixture revocation; not an acceptance verdict' })),
  });
}
