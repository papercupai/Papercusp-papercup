import { stripCommentsOnly } from './strip-comments-and-strings.mjs';

/** Read the maintained route registry at a pinned ref without executing its runner.
 * Unknown syntax refuses inventory rather than silently dropping routes.
 * @param {string} source
 * @returns {{prefix: string, workspace: string}[]}
 */
export function pinnedNonWorkspacePathRoutes(source) {
  const text = stripCommentsOnly(source);
  const match = /\bconst\s+NON_WORKSPACE_PATH_ROUTES\s*=\s*(\[[\s\S]*?\n\]);/.exec(text);
  if (!match) throw new Error('pinned non-workspace path route registry unavailable');
  const rows = JSON.parse(match[1].replace(/\b(prefix|workspace)\s*:/g, '"$1":').replace(/,\s*([}\]])/g, '$1'));
  if (!Array.isArray(rows) || rows.some(row => !row || Object.keys(row).sort().join(',') !== 'prefix,workspace' ||
      typeof row.prefix !== 'string' || !row.prefix || typeof row.workspace !== 'string' || !row.workspace))
    throw new Error('invalid pinned non-workspace path route registry');
  return rows;
}

/** The same reverse dependency walk for live task selection and pinned admission discovery.
 * `included` retains directly changed test-only workspaces without propagating them.
 * @param {Iterable<string>} seeds
 * @param {Map<string, Set<string>>} reverseDeps
 * @param {Iterable<string>} [included]
 */
export function expandAffectedWorkspaceNames(seeds, reverseDeps, included = seeds) {
  const affected = new Set(included);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i += 1) {
    for (const name of reverseDeps.get(queue[i]) ?? []) {
      if (affected.has(name)) continue;
      affected.add(name);
      queue.push(name);
    }
  }
  return affected;
}
