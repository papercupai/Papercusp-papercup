/**
 * Learn which workspace the PAGE resolves against, so request-fixture calls
 * read and write the SAME workspace the UI does.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The SPA's fetch wrapper (`installWorkspaceHeaderFetch`, RootSyncProvider.tsx)
 * stamps `x-papercusp-workspace` on every API fetch, and the EventSource
 * wrapper appends `?ws=`. A Playwright `request` fixture does neither: with no
 * header the backend resolves against its GLOBAL workspace, and with a
 * hardcoded guess (`default`) it resolves against whatever that names. On a
 * fresh isolated rig those differ from the page's workspace, and the spec
 * then asserts against a different workspace than the one it drove. Measured
 * twice in one run (WI-10006792): settings-agent-autosave read 0 tiers right
 * after the page committed 5, and plan-detail-flow resolved plan fixtures that
 * the page's own rail never listed.
 *
 * So: never assume the page's workspace. Observe it from the page's own
 * traffic and reuse it.
 */
import type { Page, Request } from '@playwright/test';

/** The header set a request fixture should send to match the page. */
export type WorkspaceHeaders = Record<string, string>;

function workspaceOf(req: Request): string | null {
  const header = req.headers()['x-papercusp-workspace'];
  if (header) return header;
  try {
    return new URL(req.url()).searchParams.get('ws');
  } catch {
    return null;
  }
}

/**
 * Navigate `page` to `url` and return the workspace headers its first stamped
 * `/api/` request carried. Returns `{}` when the page made API calls but
 * stamped none (the backend then resolves the page against its global
 * workspace, so the fixture must send no header either). Returns `fallback`
 * only when the page made NO API request within the window, so the caller's
 * documented default stays in force rather than being replaced by a guess.
 */
export async function learnPageWorkspaceHeaders(
  page: Page,
  url: string,
  { fallback = {}, timeoutMs = 30_000 }: { fallback?: WorkspaceHeaders; timeoutMs?: number } = {},
): Promise<WorkspaceHeaders> {
  let sawApi = false;
  const stamped = page
    .waitForRequest(
      (r) => {
        if (!r.url().includes('/api/')) return false;
        sawApi = true;
        return workspaceOf(r) != null;
      },
      { timeout: timeoutMs },
    )
    .catch(() => null);
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  const req = await stamped;
  if (req) {
    const ws = workspaceOf(req);
    return ws ? { 'x-papercusp-workspace': ws } : {};
  }
  return sawApi ? {} : fallback;
}
