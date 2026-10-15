import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';

let executeMemo: typeof execFile.__promisify__ | null = null;
const execute = ((...args: unknown[]) =>
  Reflect.apply((executeMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const root = resolve(import.meta.dirname, '../../..');
export type Assertion = { id: string; passed: boolean; evidence: string; status?: string };
export type Evidence = {
  kind: string;
  exitCode: number;
  assertions: Assertion[];
  residualUnknowns: string[];
  observations: { lineages: Array<{ goal: string; verdict: string }> };
};

/** Run the existing read-only probes, preserving assertion failures and refusing
 * to treat process/transport failures as successful negative evidence. */
export async function observe(counterexample: boolean, kind: 'R2' | 'R4' | 'R10' = 'R2'):
Promise<{ status: number; evidence: Evidence }> {
  const env = { ...process.env };
  delete env.R2_COUNTEREXAMPLE;
  delete env.R4_COUNTEREXAMPLE;
  delete env.R10_COUNTEREXAMPLE;
  if (counterexample) env[`${kind}_COUNTEREXAMPLE`] = kind === 'R2' ? 'scope-mismatch'
    : kind === 'R4' ? 'duplicate-launch-in-refusal-window' : 'wrong-holder';
  const probe = resolve(root, kind === 'R2' ? 'docs/evidence/goal-brief-r2-live-probe-2026-09-29.mts'
    : kind === 'R4' ? 'docs/evidence/goal-brief-r4-behavioral-probe-2026-09-29.mts'
      : 'docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.mts');
  let stdout: string;
  let status = 0;
  try {
    ({ stdout } = await execute(process.execPath, ['--import', 'tsx', probe], {
      cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; killed?: boolean };
    if (failure.code !== 1 || failure.killed || !failure.stdout) throw error;
    stdout = failure.stdout;
    status = 1;
  }
  const evidence = JSON.parse(stdout) as Evidence;
  expect(evidence.kind).toBe('operational-test-evidence');
  expect(evidence.exitCode).toBe(status);
  expect(evidence.assertions.length).toBeGreaterThan(0);
  return { status, evidence };
}
