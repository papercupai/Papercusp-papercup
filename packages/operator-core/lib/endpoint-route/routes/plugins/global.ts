/**
 * GET /api/plugins/global — list every installed global plugin.
 * Ported from app/api/plugins/global/route.ts. `auth: 'public'`.
 */
import { basename } from 'node:path';
import { GLOBAL_PLUGINS_DIR, listPluginsIn } from '../../../plugin-catalog';
import { defineTool } from '@papercusp/agent-mcp';

const HIDDEN_PLUGIN_BASENAMES = new Set([
  'notion-export', 'slack-notifier',
]);

// Reserved by the CLI's lock-resolve node:test fixtures. Those tests used to
// write into the real global-plugins directory and a killed process could
// leave production-visible manifests behind. Keep the API safe during mixed
// version rollouts while old debris is removed and new tests become hermetic.
const LOCK_RESOLVE_FIXTURE_RE = /^lockresolve-\d+-/;

export function isLockResolveFixtureName(value: string | undefined | null): boolean {
  return typeof value === 'string' && LOCK_RESOLVE_FIXTURE_RE.test(value);
}

function isHidden(slugOrName: string | undefined | null): boolean {
  if (!slugOrName) return false;
  const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
  return HIDDEN_PLUGIN_BASENAMES.has(base);
}

export default defineTool({
  method: 'GET',
  path: '/plugins/global',
  auth: 'public',
  async handler() {
    // The catalog scan (plugin-catalog listPluginsIn) is the one directory walk:
    // dirs and symlinks to dirs, one level of @scope/ recursion, deduped by
    // manifest name. This route used to carry its own copy (EI-21114087507786980).
    const plugins = (await listPluginsIn(GLOBAL_PLUGINS_DIR(), 'global')).filter(
      (p) => !isLockResolveFixtureName(basename(p.path)) && !isLockResolveFixtureName(p.name) && !isHidden(p.name),
    );
    return Response.json({ plugins });
  },
});
