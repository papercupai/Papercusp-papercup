import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check every frozen source pin in one bounded journey phase. */
export async function verifyEngineeringJourneySources(input: {
  pins: { path: string; sha256: string }[];
  runtime: string;
  health: () => Promise<string>;
  read: (pin: { path: string; sha256: string }) => Promise<{
    acceptedSource?: { matches?: boolean; runtimeContainment?: Record<string, boolean> };
  }>;
  retain?: (reading: { path: string; status: 'pass' | 'fail'; elapsedMs: number; error?: string }) => void;
}): Promise<void> {
  if (!input.pins.length) throw new Error('Engineering journey requires source pins.');
  const before = await input.health();
  // The reads are independent. Settle every read before leaving the phase so
  // a failed pin cannot leave unobserved work running inside another case.
  const results = await Promise.allSettled(input.pins.map(async pin => {
    const startedAt = Date.now();
    try {
      const measured = await input.read(pin);
      if (measured.acceptedSource?.matches !== true
        || measured.acceptedSource.runtimeContainment?.[input.runtime] !== true)
        throw new Error('Selected runtime does not contain accepted source: ' + pin.path);
      input.retain?.({ path: pin.path, status: 'pass', elapsedMs: Date.now() - startedAt });
    } catch (error) {
      input.retain?.({ path: pin.path, status: 'fail', elapsedMs: Date.now() - startedAt,
        error: String(error instanceof Error ? error.message : error) });
      throw error;
    }
  }));
  if (await input.health() !== before) throw new Error('Selected runtime changed during source preflight.');
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason),
    'Engineering journey source preflight failed.');
}

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
