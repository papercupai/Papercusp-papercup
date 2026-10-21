import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitTaskDeadline } from './task-deadline.mjs';

const [phase = 'prepare', prepareOnly = '0', assertionMode = '0', attemptsDone = '0', elapsedSec = '0'] = process.argv.slice(2);
try {
  if (!['prepare', 'boot', 'assert'].includes(phase)) throw new Error('Invalid verifier budget phase');
  const integer = (key, fallback, minimum = 0) => {
    const raw = process.env[key];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${key}`);
    return value;
  };
  let prepareMs = null;
  if (process.env.VERIFY_TAURI_BUDGET_FROM) {
    const rows = readFileSync(process.env.VERIFY_TAURI_BUDGET_FROM, 'utf8').trim()
      .split('\n').map(line => JSON.parse(line));
    const completed = rows.filter(row => row.phase === 'prepare');
    if (completed.length !== 1 || completed[0].status !== 'passed' ||
        !Number.isSafeInteger(completed[0].elapsedMs) || completed[0].elapsedMs < 0)
      throw new Error('Verifier budget requires one completed prepare phase');
    prepareMs = Math.max(0, Math.ceil(completed[0].elapsedMs * 1.25) - Number(elapsedSec) * 1000);
  }
  const attempts = Math.max(0, integer('VERIFY_TAURI_MAX_BOOT_ATTEMPTS', 2, 1) - Number(attemptsDone));
  const bootMs = prepareOnly === '1' || phase === 'assert' ? 0 : attempts * 1000 *
    (integer('VERIFY_TAURI_BUILD_TIMEOUT', 300, 1) + integer('VERIFY_TAURI_TIMEOUT', 180, 1));
  let assertionMs = 0;
  if (prepareOnly !== '1' && assertionMode === '1') {
    assertionMs = integer('VERIFY_TAURI_ASSERT_ESTIMATE_MS', 0);
    if (process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE) {
      // Reuse the assertion's maintained prerequisite profile. A missing or
      // smaller caller estimate must not erase a known long-running journey
      // and admit a parent clock which will kill it after native preparation.
      const root = process.env.PAPERCUSP_REPO_DIR ?? fileURLToPath(new URL('../..', import.meta.url));
      // This budget pass runs BEFORE verify-tauri-assertion-env.mjs, so it is the
      // first reader of the profile: report the same refusal that check does, not
      // a raw ENOENT/SyntaxError whose subject the caller has to guess.
      let profile;
      try {
        profile = JSON.parse(readFileSync(resolve(root,
          process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE), 'utf8'));
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
  const admission = admitTaskDeadline({ knownEstimateMs, knownTasks: 1 + Number(bootMs > 0) +
    Number(assertionMs > 0) + Number(phase === 'prepare' && prepareMs !== null), unknownTasks });
  console.error(`VERIFY_TAURI_TASK_BUDGET phase=${phase} deadlineEpochMs=${admission.deadlineEpochMs ?? 'unknown'} ` +
    `remainingMs=${admission.remainingMs ?? 'unknown'} knownEstimateMs=${admission.knownEstimateMs} ` +
    `unknownTasks=${unknownTasks} assertionEstimateMs=${assertionMs} childCutoffEpochMs=${admission.childCutoffEpochMs ?? 'unknown'}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
