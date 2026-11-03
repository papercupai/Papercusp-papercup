// The papercusp HOST PREFLIGHT for vitest (WI-10005724, follow-up of WI-10005713 / WI-10005634 —
// plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
//
// libs/test-config is a generic submodule, so it carries no papercusp policy. Its
// host-preflight globalSetup loads THIS module by convention (<monorepo root>/scripts/lib/
// vitest-host-preflight.mjs) after vitest has resolved the run's files and before any test
// executes, and calls `hostPreflight`. A repository without this file runs no preflight.
//
// The runtime preflight policy is the restricted-write fence: refuse to execute code a
// session holding an active personal disclosure wrote, from a process that has the network.
// testing:run and the raw router already apply it; this is the door for `npx vitest` and the
// per-workspace vitest runs `npm run test:affected` starts.
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  formatVitestRestrictedHoldRefusal,
  runVitestRootPreflight,
} from './restricted-hold-preflight.mjs';

/** Keep native config imports behind the committed-source loader before Vitest
 * can transform them. Shared by the router and direct native fixture producers.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [execArgv]
 */
export function vitestConfigLoaderPolicy(args, env = process.env, execArgv = process.execArgv) {
  let selected = null;
  const remaining = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--configLoader') selected = args[++i] ?? '';
    else if (arg.startsWith('--configLoader=')) selected = arg.slice('--configLoader='.length);
    else remaining.push(arg);
  }
  const guarded = `${env.NODE_OPTIONS ?? ''} ${execArgv.join(' ')}`.includes('committed-source-loader.mjs');
  if (guarded && selected !== null && !['native', 'bundle'].includes(selected)) {
    throw new Error('committed-source config requires --configLoader native or bundle; runner transforms bypass its source boundary');
  }
  // Bundles retain Vite's dependency census. The committed-source loader checks
  // every inline source-map input against HEAD and refuses dirty/unverifiable
  // bundles; keep that guard installed. Native remains the default because it
  // can substitute HEAD bytes in a dirty shared config.
  if (guarded && selected === null) selected = 'native';
  return { configLoaderArgs: selected === null ? [] : ['--configLoader', selected], vitestArgs: remaining };
}

/** Native fixtures inherit the committed-source loader, while Vitest reads local
 * test modules. Refuse mixed tracer inputs before any native child is launched.
 * Reuse the cost-fixture's Git-blob comparison without importing the loader:
 * importing that module installs process-wide hooks.
 * @param {{ root: string, files: string[] }} input
 * @param {{ committed?: (root: string, path: string) => Buffer,
 *   working?: (path: string) => Buffer }} [readers]
 */
export function nativeChildSourcePreflight({ root, files }, readers = {}) {
  const suites = [
    'packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts',
    'packages/operator-core/test/committed-reader-source-preflight.test.ts',
  ];
  const selected = files.map(file => relative(root, isAbsolute(file) ? file : resolve(root, file)).replaceAll('\\', '/'))
    .filter(file => suites.includes(file));
  if (!selected.length) return null;
  const committed = readers.committed ?? ((cwd, path) => {
    const absolute = resolve(cwd, path);
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const options = { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']) };
    // Shared test-config is a real submodule: its blob lives in its own HEAD.
    const top = execFileSync('git', ['-C', dirname(absolute), 'rev-parse', '--show-toplevel'], options).toString().trim();
    return execFileSync('git', ['-C', top, 'show', `HEAD:${relative(top, absolute).replaceAll('\\', '/')}`], options);
  });
  const working = readers.working ?? readFileSync;
  for (const path of [
    'scripts/lib/vitest-startup-trace.mjs',
    'packages/operator-core/lib/process-identity.ts',
    'libs/test-config/src/configuration-snapshot.ts',
    'libs/test-config/src/executed-config-load-capture.ts',
    ...new Set(selected),
  ]) {
    try {
      if (committed(root, path).equals(working(resolve(root, path)))) continue;
    } catch {
      return { verdict: 'refuse', message: `NATIVE_CHILD_SOURCE_REFUSED measured=none unreadable committed input: ${path}` };
    }
    return { verdict: 'refuse', message: `NATIVE_CHILD_SOURCE_REFUSED measured=none ${path} must match HEAD before native child verification; wait for git-sync` };
  }
  return null;
}

/**
 * Contract (owned by libs/test-config/src/host-preflight-global-setup.ts):
 *   → { verdict: 'admit', setEnv? } | { verdict: 'skipped', reason } | { verdict: 'refuse', message }
 * A refusal aborts the vitest run with `message`; `setEnv` is applied to vitest's main-process env.
 * @param {{ root: string, files: string[], env: NodeJS.ProcessEnv }} input
 */
export function hostPreflight({ root, files, env }) {
  const sourceRefusal = nativeChildSourcePreflight({ root, files });
  if (sourceRefusal) return sourceRefusal;
  const result = runVitestRootPreflight({ repoRoot: root, files, env });
  if (result.verdict === 'refuse') return { verdict: 'refuse', message: formatVitestRestrictedHoldRefusal(result) };
  return result;
}

/**
 * A vitest globalSetup for the standalone packages that cannot import @papercusp/test-config
 * (scripts/check-vitest-config-enrollment.mjs PLAIN_CONFIG_EXEMPTIONS, WI-10005765). Each such
 * config walks up to this file and lists it in `globalSetup` only when it exists, so a standalone
 * clone runs none. Same semantics as test-config's runHostPreflight: refuse throws before any test
 * runs; admit sets the marker in vitest's main-process env.
 * @param {{ vitest: { state: { getPaths(): string[] } } }} project
 */
export async function setup(project) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = hostPreflight({ root, files: project.vitest.state.getPaths(), env: process.env });
  if (result.verdict === 'refuse') throw new Error(result.message);
  if (result.verdict === 'admit') Object.assign(process.env, result.setEnv ?? {});
}
