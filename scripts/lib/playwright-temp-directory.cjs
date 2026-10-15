// CommonJS keeps this single preflight usable by Playwright's native config
// loader as well as the ESM browser-install CLI. The loader rewrites .mjs
// imports to CommonJS in a config graph, which Node cannot execute as ESM.
const { accessSync, constants, mkdirSync, statfsSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

// --disable-dev-shm-usage allocates Chromium shared memory in the temp dir.
// This admission floor is not a reservation against concurrent volume growth.
const PLAYWRIGHT_TEMP_MIN_BYTES = 1024 ** 3;
const PLAYWRIGHT_TEMP_MIN_INODES = 128;

function preparePlaywrightTempDirectory({
  env = process.env, statfs = statfsSync, mkdir = mkdirSync, access = accessSync,
  minBytes = PLAYWRIGHT_TEMP_MIN_BYTES, minInodes = PLAYWRIGHT_TEMP_MIN_INODES,
} = {}) {
  const preferred = resolve(env.TMPDIR || env.TMP || env.TEMP || tmpdir());
  const cache = env.XDG_CACHE_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.cache');
  const fallback = resolve(cache, 'papercusp', 'playwright-tmp');
  const attempts = [];
  for (const path of new Set([preferred, fallback])) {
    try {
      if (path === fallback && path !== preferred) mkdir(path, { recursive: true, mode: 0o700 });
      access(path, constants.W_OK);
      const stats = statfs(path);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      const freeInodes = Number(stats.ffree);
      const hasInodeAccounting = Number(stats.files) > 0;
      if (!Number.isFinite(availableBytes) || availableBytes < minBytes ||
          (hasInodeAccounting && (!Number.isFinite(freeInodes) || freeInodes < minInodes))) {
        attempts.push(`${path}: availableBytes=${availableBytes}, freeInodes=${freeInodes}`);
        continue;
      }
      // Both Playwright's parent profile/artifact directories and Chromium's
      // child allocations must use the admitted volume.
      env.TMPDIR = path;
      env.TMP = path;
      env.TEMP = path;
      return { path, availableBytes, freeInodes, usedFallback: path !== preferred };
    } catch (error) {
      attempts.push(`${path}: ${error.message}`);
    }
  }
  throw new Error(`No writable Playwright temporary directory with ${minBytes} bytes and ${minInodes} free inodes. ${attempts.join('; ')}`);
}

module.exports = { preparePlaywrightTempDirectory, PLAYWRIGHT_TEMP_MIN_BYTES, PLAYWRIGHT_TEMP_MIN_INODES };
