// vendored-manifest — the ONE rule for what a VENDORED package copy must contain,
// shared by the writer (scripts/sync-template-kit-vendored.mjs) and the guard
// (packages/operator-core/lib/cupboard/template-bundle-integrity.test.ts, invariant 2).
//
// WHY (WI-6554700010009816, gate fix 10): a vendored copy at templates/<ref>/<pkg>/
// is overlaid into a user's materialized app, outside this monorepo, and it omits the
// canonical package's dev harness (tests, vitest.config.ts, README.md). The canonical
// manifest still declares that harness's own dependency, @papercusp/test-config: a
// private, never-published workspace package that only vitest.config.ts imports,
// declared because scripts/check-workspace-deps-complete.mjs requires every local
// import to be declared. A byte copy of the canonical manifest therefore hands the
// user an unresolvable devDependency for a file they never receive. The vendored
// manifests were corrected by hand while the guard still demanded a byte copy and
// the writer still produced one, so the gate went red. The guard and the writer now
// share this one derivation, so they cannot disagree again.

/**
 * Files that exist ONLY in the canonical package: the dev harness a vendored copy
 * omits. Kept deliberately small and explicit rather than a broad glob: every entry
 * is a hole in the symmetry check, so a new one should be an argued decision.
 *
 * @param {string} rel path relative to the package root
 * @returns {boolean}
 */
export function isVendorDevOnly(rel) {
  const base = rel.split(/[\\/]/).pop() ?? rel;
  return base.endsWith('.test.ts') || base === 'vitest.config.ts' || base === 'README.md';
}

/**
 * devDependencies that serve ONLY the dev harness above, so a vendored manifest omits
 * them. Same bar as isVendorDevOnly: each entry must be a private workspace package
 * that nothing a vendored copy ships imports.
 *
 * @type {readonly string[]}
 */
export const VENDOR_DEV_ONLY_DEPENDENCIES = Object.freeze(['@papercusp/test-config']);

/**
 * The exact text a vendored package.json must have, given the canonical text. With
 * nothing to drop it is the canonical text unchanged (a byte copy). Otherwise the
 * dev-harness-only devDependencies are removed (and an emptied devDependencies
 * object with them), and the manifest is re-serialized as 2-space JSON with a
 * trailing newline, the format of every package.json in this repo.
 *
 * @param {string} canonicalText
 * @returns {string}
 */
export function vendoredManifestOf(canonicalText) {
  const manifest = JSON.parse(canonicalText);
  const dev = manifest === null || typeof manifest !== 'object' ? undefined : manifest.devDependencies;
  if (dev === null || typeof dev !== 'object' || Array.isArray(dev)) return canonicalText;
  const drop = Object.keys(dev).filter((name) => VENDOR_DEV_ONLY_DEPENDENCIES.includes(name));
  if (drop.length === 0) return canonicalText;
  for (const name of drop) delete dev[name];
  if (Object.keys(dev).length === 0) delete manifest.devDependencies;
  return JSON.stringify(manifest, null, 2) + '\n';
}
