/**
 * Where a finished OAuth flow may send the person back to (plan linear-asana-task-sync-2026-10-05,
 * D-014.2).
 *
 * A caller of `GET /api/oauth/start` may name the in-app page to land on afterwards, so a flow
 * started from Settings → Integrations returns there instead of to its connection adapter's fixed
 * page. Only internal Settings pages are accepted, checked at start (refused with 400) and again
 * at the callback (ignored), so a crafted start link can never turn the callback into an open
 * redirect: no scheme, no host, no `//`, no `..`, no backslash, nothing outside `/settings/`.
 */

export const OAUTH_RETURN_PATH_MAX = 200;

/** `/settings/<lower-case path>` with an optional plain query string. */
const SETTINGS_PATH = /^\/settings\/[a-z0-9][a-z0-9/-]*(?:\?[A-Za-z0-9_.~=&%-]*)?$/;

/** The path when it is an allowed return destination, else null. */
export function safeOAuthReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (!path || path.length > OAUTH_RETURN_PATH_MAX) return null;
  if (path.includes('//') || path.includes('..') || path.includes('\\')) return null;
  return SETTINGS_PATH.test(path) ? path : null;
}
