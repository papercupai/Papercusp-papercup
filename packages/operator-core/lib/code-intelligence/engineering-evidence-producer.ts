import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A passing producer must be joinable to the selected serving artifact. */
export function assertProducerBuildIdentity(buildSha: string, runnerCommit: string | null,
  reporterCommit?: string): void {
  const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
  if (!fullSha.test(buildSha) || !runnerCommit || !fullSha.test(runnerCommit)
    || runnerCommit !== buildSha || (reporterCommit?.trim() && reporterCommit.trim() !== runnerCommit)) {
    throw new Error('Engineering producer requires the test runner and reporter to use the exact selected serving commit; run the committed producer with --ref=' + buildSha);
  }
}

export function verifyProducerBuildIdentity(buildSha: string): void {
  // Read the checkout that owns this module, including a maintained committed
  // verification checkout. The caller's requested build is not source evidence.
  const runnerCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 15_000,
  }).trim();
  assertProducerBuildIdentity(buildSha, runnerCommit, process.env.PAPERCUSP_TEST_RUN_COMMIT);
}
