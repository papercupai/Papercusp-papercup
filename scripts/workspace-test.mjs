#!/usr/bin/env node
/**
 * Run a workspace's normal Vitest suite, or route explicit test-file requests
 * through the repository's owning-config guard.
 *
 * Workspace `test` scripts are also used for focused re-runs. Calling Vitest
 * directly lets it silently discard a path owned by another workspace when a
 * second path matches, so explicit file requests must use test-files.mjs. With
 * no file request, retain the workspace's ordinary full-suite command.
 *
 * The routing decision lives in scripts/lib/workspace-test-invocation.mjs so the
 * passing-verdict cache can measure exactly what this launcher spawns
 * (WI-6554700010030941).
 */
import { spawnSync } from 'node:child_process';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { workspaceTestInvocation } from './lib/workspace-test-invocation.mjs';

export { isVitestTestFileArg, workspaceTestInvocation } from './lib/workspace-test-invocation.mjs';

export function main(argv = process.argv.slice(2)) {
  const invocation = workspaceTestInvocation(argv);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`workspace test launcher failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main());
}
