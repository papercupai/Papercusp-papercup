export { preparePlaywrightTempDirectory, PLAYWRIGHT_TEMP_MIN_BYTES, PLAYWRIGHT_TEMP_MIN_INODES } from './lib/playwright-temp-directory.cjs';
export function browserCachePath(env?: NodeJS.ProcessEnv): string;
export function requiredBrowsers(env?: NodeJS.ProcessEnv): string[];
export function hasBrowserInstall(cacheDir: string, browser: string, revision?: string): boolean;
export function expectedBrowserRevision(browser: string): string | null;
export function missingPlaywrightBrowsers(options?: { env?: NodeJS.ProcessEnv }): string[];
export function ensurePlaywrightBrowsers(options?: {
  env?: NodeJS.ProcessEnv;
  run?: typeof import('node:child_process').spawnSync;
}): { installed: boolean; cacheDir: string; missing: string[]; ranInstall: boolean };
