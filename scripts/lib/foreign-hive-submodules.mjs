/**
 * Foreign-hive submodules: nested checkouts of ANOTHER hive's repository that live inside
 * this superproject (registered in `.gitmodules`, e.g. by git-sync for a drill fixture app).
 *
 * Their source, configs and remote follow the OWNING hive's conventions, and that hive's own
 * gate judges them. Papercusp's repo-wide guards (the module-pin scan, the vitest-config
 * enrollment walk, the `.gitmodules` URL convention) therefore skip them through this ONE
 * registry instead of each guard growing its own per-path exemption.
 *
 * Two-way pinned by packages/operator-core/lib/harness/gitmodules-invariants.test.ts: every
 * entry must be declared in `.gitmodules` with the same url, and every `.gitmodules` url outside
 * the Papercusp SSH convention must be registered here. Adding a foreign hive means adding it
 * HERE, once (WI-6554700010009815).
 */

/**
 * @typedef {object} ForeignHiveSubmodule
 * @property {string} path repo-relative submodule path, exactly as declared in `.gitmodules`
 * @property {string} url the submodule url, exactly as declared in `.gitmodules`
 * @property {string} ref the work-item that introduced the foreign hive
 */

/** @type {ReadonlyArray<Readonly<ForeignHiveSubmodule>>} */
export const FOREIGN_HIVE_SUBMODULES = Object.freeze([
  Object.freeze({
    // The drill fixture app @bug-drill/fixture: its own repo, registered by git-sync.
    path: 'apps/slack-asana-bug-drill',
    url: 'https://github.com/papercupai/slack-asana-bug-drill-20261009.git',
    ref: 'WI-6554700010009161',
  }),
]);

/**
 * True when the repo-relative `relPath` is a registered foreign hive's root or lies inside one.
 * Accepts either path separator and a leading `./`; a sibling that merely shares the prefix
 * (`apps/slack-asana-bug-drill-x`) does not match.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isInForeignHive(relPath) {
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return FOREIGN_HIVE_SUBMODULES.some(({ path }) => rel === path || rel.startsWith(`${path}/`));
}
