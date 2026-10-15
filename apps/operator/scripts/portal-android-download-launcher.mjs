import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { spawnSync } from 'node:child_process';

/**
 * The narrow spawn seam this launcher actually uses — `spawnSync` satisfies it,
 * and a test fake only has to return the fields read below (not a full
 * `SpawnSyncReturns`).
 * @typedef {(command: string, args: readonly string[], options: import('node:child_process').SpawnSyncOptions) => { status: number | null, signal?: NodeJS.Signals | null, error?: Error }} AndroidCheckSpawn
 */

// Use the Portal's maintained loader for its nested fixture imports. The
// operator's loader is not interchangeable (historical fixture preflight ENOENT).
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {AndroidCheckSpawn} [spawn]
 * @returns {number}
 */
export function launchAndroidDownloadCheck(env = process.env, spawn = spawnSync) {
  if (env.PORTAL_ANDROID_CLICK_TEST !== '1') throw new Error('explicit_test_admission_required');
  if (!env.PORTAL_ANDROID_ROOT) throw new Error('explicit_portal_root_required');
  const root = resolve(env.PORTAL_ANDROID_ROOT);
  const launcher = join(root, 'node_modules/.bin/tsx');
  if (!existsSync(launcher)) throw new Error('portal_tsx_launcher_missing');
  const script = fileURLToPath(new URL('./portal-android-download-check.ts', import.meta.url));
  const result = spawn(launcher, [script], { env: { ...env, PORTAL_ANDROID_ROOT: root }, stdio: 'inherit' });
  if (result.error || result.signal || result.status === null) return 1;
  return result.status;
}

if (isCliEntry(import.meta.url)) {
  try { process.exitCode = launchAndroidDownloadCheck(); }
  catch { console.error('android_download_launcher_precondition_failed'); process.exitCode = 1; }
}
