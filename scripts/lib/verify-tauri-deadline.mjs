import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitTaskDeadline } from './task-deadline.mjs';

function readCalibration(path) {
  const body = readFileSync(path, 'utf8');
  const rows = body.trim().split('\n').map(line => JSON.parse(line));
  const completed = rows.filter(row => row.phase === 'prepare');
  if (completed.length !== 1 || completed[0].status !== 'passed' ||
      !Number.isSafeInteger(completed[0].elapsedMs) || completed[0].elapsedMs < 0)
    throw new Error('Verifier budget requires one completed prepare phase');
  return { body, elapsedMs: completed[0].elapsedMs };
}

/**
 * One forecast for the shell guard and parents which must allocate its clocks.
 * This module runs before dependency copying; keep imports limited to Node.
 * @param {{ env?: NodeJS.ProcessEnv, phase?: string, prepareOnly?: string,
 * assertionMode?: string, attemptsDone?: number, elapsedSec?: number }} [options]
 */
export function verifierTaskBudget({ env = process.env, phase = 'prepare', prepareOnly = '0',
  assertionMode = '0', attemptsDone = 0, elapsedSec = 0 } = {}) {
  if (!['prepare', 'boot', 'assert'].includes(phase)) throw new Error('Invalid verifier budget phase');
  const integer = (key, fallback, minimum = 0) => {
    const raw = env[key];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${key}`);
    return value;
  };
  let prepareMs = env.VERIFY_TAURI_PREPARE_ESTIMATE_MS
    ? integer('VERIFY_TAURI_PREPARE_ESTIMATE_MS', 0, 1) : null;
  if (env.VERIFY_TAURI_BUDGET_FROM) {
    const { elapsedMs } = readCalibration(env.VERIFY_TAURI_BUDGET_FROM);
    prepareMs = Math.max(prepareMs ?? 0, Math.ceil(elapsedMs * 1.25));
  }
  if (prepareMs !== null) prepareMs = Math.max(0, prepareMs - Number(elapsedSec) * 1000);
  const attempts = Math.max(0, integer('VERIFY_TAURI_MAX_BOOT_ATTEMPTS', 2, 1) - Number(attemptsDone));
  const bootMs = prepareOnly === '1' || phase === 'assert' ? 0 : attempts * 1000 *
    (integer('VERIFY_TAURI_BUILD_TIMEOUT', 300, 1) + integer('VERIFY_TAURI_TIMEOUT', 180, 1));
  let assertionMs = 0;
  if (prepareOnly !== '1' && assertionMode === '1') {
    assertionMs = integer('VERIFY_TAURI_ASSERT_ESTIMATE_MS', 0);
    if (env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE) {
      // Reuse the assertion's maintained prerequisite profile. A missing or
      // smaller caller estimate must not erase a known long-running journey
      // and admit a parent clock which will kill it after native preparation.
      const root = env.PAPERCUSP_REPO_DIR ?? fileURLToPath(new URL('../..', import.meta.url));
      // This budget pass runs BEFORE verify-tauri-assertion-env.mjs, so it is the
      // first reader of the profile: report the same refusal that check does, not
      // a raw ENOENT/SyntaxError whose subject the caller has to guess.
      let profile;
      try {
        profile = JSON.parse(readFileSync(resolve(root,
          env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE), 'utf8'));
      } catch (error) {
        throw new Error(`live profile could not be read: ${error.message}`);
      }
      if (profile.assertionEstimateMs !== undefined) {
        if (!Number.isSafeInteger(profile.assertionEstimateMs) || profile.assertionEstimateMs <= 0)
          throw new Error('Invalid live-profile assertionEstimateMs');
        assertionMs = Math.max(assertionMs, profile.assertionEstimateMs);
      }
    }
  }
  const unknownTasks = Number(phase === 'prepare' && prepareMs === null) +
    Number(prepareOnly !== '1' && assertionMode === '1' && assertionMs === 0);
  const knownEstimateMs = (phase === 'prepare' ? prepareMs ?? 0 : 0) + bootMs + assertionMs + 120_000;
  return { prepareMs, bootMs, assertionMs, knownEstimateMs,
    knownTasks: 1 + Number(bootMs > 0) + Number(assertionMs > 0) +
      Number(phase === 'prepare' && prepareMs !== null), unknownTasks };
}

function main() {
  if (process.argv[2] === '--snapshot-budget') {
    const [, , , input, output] = process.argv;
    if (!input || !output || process.argv.length !== 5) throw new Error('Expected calibration input and snapshot output');
    const { body } = readCalibration(input);
    writeFileSync(output, body, { flag: 'wx', mode: 0o600 });
    console.error(`VERIFY_TAURI_BUDGET_SNAPSHOT original=${input} snapshot=${output} sha256=${createHash('sha256').update(body).digest('hex')}`);
    return;
  }
  const [phase = 'prepare', prepareOnly = '0', assertionMode = '0', attemptsDone = '0', elapsedSec = '0'] = process.argv.slice(2);
  const budget = verifierTaskBudget({ phase, prepareOnly, assertionMode,
    attemptsDone: Number(attemptsDone), elapsedSec: Number(elapsedSec) });
  const { unknownTasks, assertionMs } = budget;
  const admission = admitTaskDeadline(budget);
  console.error(`VERIFY_TAURI_TASK_BUDGET phase=${phase} deadlineEpochMs=${admission.deadlineEpochMs ?? 'unknown'} ` +
    `remainingMs=${admission.remainingMs ?? 'unknown'} knownEstimateMs=${admission.knownEstimateMs} ` +
    `unknownTasks=${unknownTasks} assertionEstimateMs=${assertionMs} childCutoffEpochMs=${admission.childCutoffEpochMs ?? 'unknown'}`);
}
// Copied verbatim and invoked by bare Node before node_modules exists. This
// count-bounded standalone guard is enrolled in lint:no-hand-rolled-cli-entry.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
