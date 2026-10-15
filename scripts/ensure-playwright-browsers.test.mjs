import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePlaywrightBrowsers,
  expectedBrowserRevision,
  hasBrowserInstall,
  missingPlaywrightBrowsers,
  preparePlaywrightTempDirectory,
} from './ensure-playwright-browsers.mjs';

const chromiumRevision = expectedBrowserRevision('chromium');
const headlessShellRevision = expectedBrowserRevision('chromium-headless-shell');
const ffmpegRevision = expectedBrowserRevision('ffmpeg');

test('detects an installed browser by its completion sentinel', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, 'chromium-999'), { recursive: true });
  writeFileSync(join(cache, 'chromium-999', 'INSTALLATION_COMPLETE'), '');
  assert.equal(hasBrowserInstall(cache, 'chromium'), true);
});

test('isolated missing cache runs injected installer without network', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  const env = {
    ...process.env,
    HOME: cache,
    PLAYWRIGHT_BROWSERS_PATH: cache,
    PLAYWRIGHT_INSTALL_COMMAND: `node -e "const fs=require('fs'); for (const dir of ['chromium-${chromiumRevision}','chromium_headless_shell-${headlessShellRevision}','ffmpeg-${ffmpegRevision}']) { fs.mkdirSync('${cache}/'+dir,{recursive:true}); fs.writeFileSync('${cache}/'+dir+'/INSTALLATION_COMPLETE','') }"`,
  };
  const result = ensurePlaywrightBrowsers({ env });
  assert.equal(result.ranInstall, true);
  assert.equal(hasBrowserInstall(cache, 'chromium'), true);
});

test('ready cache is idempotent and does not invoke installer', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  for (const dir of [
    `chromium-${chromiumRevision}`,
    `chromium_headless_shell-${headlessShellRevision}`,
    `ffmpeg-${ffmpegRevision}`,
  ]) {
    mkdirSync(join(cache, dir), { recursive: true });
    writeFileSync(join(cache, dir, 'INSTALLATION_COMPLETE'), '');
  }
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  const result = ensurePlaywrightBrowsers({ env, run: () => { throw new Error('installer should not run'); } });
  assert.equal(result.ranInstall, false);
});

test('chromium without its headless shell is not a healthy Playwright install', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, `chromium-${chromiumRevision}`), { recursive: true });
  writeFileSync(join(cache, `chromium-${chromiumRevision}`, 'INSTALLATION_COMPLETE'), '');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  assert.deepEqual(missingPlaywrightBrowsers({ env }), [
    'chromium-headless-shell',
    'ffmpeg',
  ]);
});

test('stale browser revision fails the installed-registry health check', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, 'chromium-stale'), { recursive: true });
  writeFileSync(join(cache, 'chromium-stale', 'INSTALLATION_COMPLETE'), '');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  assert.deepEqual(missingPlaywrightBrowsers({ env }), [
    'chromium',
    'chromium-headless-shell',
    'ffmpeg',
  ]);
});

const healthyStats = { bsize: 4096, bavail: 1024 * 1024, files: 10000, ffree: 9000 };

test('low temporary disk headroom selects the healthy cache volume for parent and browser', () => {
  const env = { TMPDIR: '/nearly-full', HOME: '/healthy-home' };
  const made = [];
  const result = preparePlaywrightTempDirectory({
    env,
    mkdir: (path, options) => made.push({ path, options }),
    access: () => {},
    statfs: path => path === '/nearly-full' ? { ...healthyStats, bavail: 12 } : healthyStats,
  });
  assert.equal(result.path, '/healthy-home/.cache/papercusp/playwright-tmp');
  assert.equal(result.usedFallback, true);
  assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], [result.path, result.path, result.path]);
  assert.deepEqual(made, [{ path: result.path, options: { recursive: true, mode: 0o700 } }]);
});

test('healthy explicit TMPDIR is preserved without creating a fallback directory', () => {
  const env = { TMPDIR: '/healthy-explicit', XDG_CACHE_HOME: '/unused-cache' };
  const result = preparePlaywrightTempDirectory({ env, statfs: () => healthyStats, access: () => {}, mkdir: () => { throw new Error('unexpected fallback'); } });
  assert.equal(result.path, '/healthy-explicit');
  assert.equal(result.usedFallback, false);
});

test('inode exhaustion and unwritable preferred paths also select measured fallback', () => {
  for (const reason of ['inodes', 'permission']) {
    const env = { TMPDIR: '/bad', XDG_CACHE_HOME: '/xdg' };
    const result = preparePlaywrightTempDirectory({
      env, mkdir: () => {},
      access: path => { if (reason === 'permission' && path === '/bad') throw new Error('EACCES'); },
      statfs: path => path === '/bad' ? { ...healthyStats, ffree: 0 } : healthyStats,
    });
    assert.equal(result.path, '/xdg/papercusp/playwright-tmp');
  }
});

test('no healthy volume fails before browser launch and preserves the caller environment', () => {
  const env = { TMPDIR: '/full', HOME: '/also-full' };
  assert.throws(() => preparePlaywrightTempDirectory({
    env, mkdir: () => {}, access: () => {}, statfs: () => ({ ...healthyStats, bavail: 0 }),
  }), /No writable Playwright temporary directory.*\/full.*\/also-full/);
  assert.deepEqual(env, { TMPDIR: '/full', HOME: '/also-full' });
});
