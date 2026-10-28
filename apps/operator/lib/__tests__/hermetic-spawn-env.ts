/**
 * Spawn env for tests that run `scripts/verify-tauri-headless.sh` (WI-6554700010030901).
 *
 * The test runner usually executes inside a managed task (capability:bash,
 * pc-heavy, the green-checkpoint), so `process.env` carries that task's
 * context markers. A suite that spawns the verifier with `...process.env`
 * leaks them into the script under test, and the verifier then acts on the
 * RUNNER's context instead of the case being tested: the deadline admission
 * prints TASK_DEADLINE_REFUSAL and exits 2 before the preflight the test is
 * exercising (WI-6554700010030899), and the background-task marker trips the
 * task-lifetime guard.
 *
 * Use `hermeticSpawnEnv()` wherever such a suite would spread `process.env`.
 * A case that tests one of these guards sets the var explicitly AFTER the
 * spread, which still wins. The guard in
 * `verify-tauri-headless-hermetic-env.test.ts` fails on any raw spread.
 */
export const RUNNER_TASK_CONTEXT_VARS = [
  'PAPERCUSP_TASK_DEADLINE_EPOCH_MS',
  'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
] as const;

export function hermeticSpawnEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of RUNNER_TASK_CONTEXT_VARS) delete env[key];
  return env;
}
