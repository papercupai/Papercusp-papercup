/**
 * The routing decision of scripts/workspace-test.mjs, kept free of side effects
 * and of TypeScript imports.
 *
 * Two consumers need the same answer to "what does this launcher spawn?": the
 * launcher itself, and the passing-verdict cache's runtime identity
 * (passing-task-verdict-cache.mjs `captureNpmTaskRuntimeIdentity`), which may
 * bind a proof only to a measured runtime topology (WI-6554700010030941).
 * Keeping one implementation here means the cache cannot drift from what the
 * launcher really runs. This module must stay importable by plain `node`
 * (affected-tests.mjs loads it), so it imports nothing from the TypeScript
 * workspaces.
 */
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_FILE_RE = /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isVitestTestFileArg(arg) {
  return typeof arg === 'string' && TEST_FILE_RE.test(arg);
}

/**
 * npm runs a workspace script with that workspace as cwd, while test-files.mjs
 * resolves requested paths from the repository root. Keep the convenient
 * package-relative spelling (`lib/foo.test.ts`) working when the launcher is
 * invoked through `npm --workspace`, and preserve paths already rooted at the
 * repository.
 */
function repositoryRelativeFiles(files, repoRoot, cwd) {
  const workspaceRel = relative(repoRoot, cwd);
  if (!workspaceRel || workspaceRel === '.' || workspaceRel.startsWith('..')) return files;
  const workspacePrefix = workspaceRel.split(sep).join('/');
  return files.map((file) => {
    if (typeof file !== 'string' || file.startsWith('/') || file.startsWith(`${workspacePrefix}/`)) return file;
    if (existsSync(resolve(repoRoot, file))) return file;
    const fromWorkspace = resolve(cwd, file);
    if (!existsSync(fromWorkspace)) return file;
    return relative(repoRoot, fromWorkspace).split(sep).join('/');
  });
}

/**
 * Build the child invocation without running it, keeping the routing decision
 * independently testable. The package script supplies --passWithNoTests as a
 * fixed argument; the router does not need that flag after it has verified the
 * requested file set, so it is removed from routed invocations.
 *
 * @param {string[]} [argv] launcher arguments (defaults to this process's argv)
 * @param {string} [repoRoot] repository root the loader and router resolve against
 */
export function workspaceTestInvocation(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  // The integration package script uses this same launcher. For explicit files,
  // test-files.mjs chooses each owner's config; a fixed --config would override it.
  const integration = argv.includes('--workspace-integration');
  const args = argv.filter((arg) => arg !== '--workspace-integration');
  const files = args.filter(isVitestTestFileArg);
  if (files.length === 0) {
    return {
      command: 'npx',
      args: ['vitest', 'run', ...(integration ? ['--config', 'vitest.integration.config.ts'] : []), ...args],
      cwd: process.cwd(),
      routed: false,
    };
  }

  const vitestArgs = args.filter((arg) => !isVitestTestFileArg(arg) && arg !== '--passWithNoTests' && arg !== '--');
  const routedFiles = repositoryRelativeFiles(files, repoRoot, process.cwd());
  return {
    command: process.execPath,
    // WI-10005802: the router runs under the committed-source loader, so it and every module it
    // imports run their committed (HEAD) bytes before its restricted-hold census can judge anything.
    args: [
      '--import',
      resolve(repoRoot, 'scripts/lib/committed-source-loader.mjs'),
      resolve(repoRoot, 'scripts/test-files.mjs'),
      ...routedFiles,
      ...(vitestArgs.length ? ['--', ...vitestArgs] : []),
    ],
    cwd: process.cwd(),
    routed: true,
  };
}
