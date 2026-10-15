import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sourcePaths = [
  'packages/operator-core/lib/harness/git-sync/git-fetch-headroom.ts',
  'packages/operator-core/lib/storage/package-cache-retention.ts',
  'scripts/lib/fs-mutex.mjs',
];
const sourceHashes = () => Object.fromEntries(sourcePaths.map((path) => [
  path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
]));

describe('Git fetch cache recovery in an isolated runtime', () => {
  it('bounds a real install-reader lease wait without weakening the disk reserve or releasing the reader', () => {
    const before = sourceHashes();
    const probe = `
      import { execFileSync } from 'node:child_process';
      import { createHash } from 'node:crypto';
      import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
      import { join } from 'node:path';
      import { withGitFetchHeadroom } from './packages/operator-core/lib/harness/git-sync/git-fetch-headroom.ts';
      import { runPackageCacheRetention } from './packages/operator-core/lib/storage/package-cache-retention.ts';
      import { PACKAGE_CACHE_MUTEX_NAME, withFsMutexRead } from './scripts/lib/fs-mutex.mjs';

      const home = process.env.HOME;
      console.log('GIT_FETCH_MUTEX_HOME ' + home);
      const watchdog = setTimeout(() => {
        console.error('GIT_FETCH_MUTEX_FAILURE recovery exceeded the isolated probe budget');
        process.exit(70);
      }, 30000);
      const GIB = 1024 ** 3;
      const objects = join(home, 'repository', 'objects');
      const cache = join(home, 'npm-cache');
      const fixture = join(cache, 'sparse-cache-fixture');
      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(home, 'cache-mutex');
      process.env.NPM_CONFIG_CACHE = cache;
      process.env.BUN_INSTALL_CACHE_DIR = join(home, 'bun-cache');
      process.env.PNPM_STORE_DIR = join(home, 'pnpm-store');
      // A broken control must never invoke a real package-manager cleanup.
      process.env.PAPERCUSP_NPM_BIN = join(home, 'cleanup-must-not-execute');
      await Promise.all([
        objects, cache, process.env.BUN_INSTALL_CACHE_DIR, process.env.PNPM_STORE_DIR,
      ].map((path) => mkdir(path, { recursive: true })));
      const file = await open(fixture, 'w');
      try { await file.truncate(9 * GIB); } finally { await file.close(); }
      const fixtureStat = await stat(fixture);
      const paths = [
        'packages/operator-core/lib/harness/git-sync/git-fetch-headroom.ts',
        'packages/operator-core/lib/storage/package-cache-retention.ts',
        'scripts/lib/fs-mutex.mjs',
      ];
      const hashes = Object.fromEntries(await Promise.all(paths.map(async (path) => [
        path, createHash('sha256').update(await readFile(path)).digest('hex'),
      ])));
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const warnings = [];
      console.warn = (...parts) => warnings.push(parts.join(' '));
      let acquired;
      const acquiredGate = new Promise((resolve) => { acquired = resolve; });
      let release;
      const releaseGate = new Promise((resolve) => { release = resolve; });
      const reader = withFsMutexRead(PACKAGE_CACHE_MUTEX_NAME, async () => {
        acquired();
        await releaseGate;
      }, { timeoutMs: 1000 });
      await acquiredGate;
      const readerPath = join(process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR, PACKAGE_CACHE_MUTEX_NAME + '.readers');
      const sample = async () => [{
        path: objects, totalBytes: 20 * GIB, freeBytes: 0, freePct: 0,
        totalInodes: 0, freeInodes: 0, freeInodesPct: 0,
      }];
      let actualCalls = 0;
      const run = async () => {
        actualCalls++;
        return { code: 0, stdout: objects, stderr: '' };
      };
      let controlCalls = 0;
      let cleanupCalls = 0;
      let settled = false;
      let control;
      let actual;
      let readerPreserved;
      let cachePreserved;
      let controlPending;
      try {
        actual = await withGitFetchHeadroom(['fetch'], run, undefined, sample);
        readerPreserved = (await readdir(readerPath)).length > 0;
        cachePreserved = (await stat(fixture)).size === fixtureStat.size;
        // Permanent pre-fix control: use the maintenance default instead of the fetch deadline.
        control = withGitFetchHeadroom(['fetch'], async () => {
          controlCalls++;
          return { code: 0, stdout: objects, stderr: '' };
        }, undefined, sample, async (pressurePath) => {
          await runPackageCacheRetention({
            pressurePath,
            runCommand: async () => {
              cleanupCalls++;
              return { ok: true, exitCode: 0, timedOut: false, output: '' };
            },
          });
        }).then((result) => { settled = true; return result; });
        await new Promise((resolve) => setTimeout(resolve, 6500));
        controlPending = !settled && cleanupCalls === 0;
      } finally {
        release();
        await reader;
      }
      const controlResult = await control;
      clearTimeout(watchdog);
      console.log('GIT_FETCH_MUTEX_PROBE ' + JSON.stringify({
        home, head, hashes, actual, actualCalls, readerPreserved, cachePreserved,
        controlPending, controlResult, controlCalls, cleanupCalls, warnings,
        logicalCacheBytes: fixtureStat.size,
        allocatedCacheBytes: fixtureStat.blocks * 512,
        privateMutex: process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR.startsWith(home + '/'),
        privateBackground: process.env.PAPERCUSP_BACKGROUND_WORKERS === '1' &&
          process.env.DBOS__VMID.startsWith('test-runtime-') &&
          process.env.PAPERCUSP_DBOS_ROUTINES === '0',
        privateHome: process.env.PAPERCUSP_HOME === home + '/.papercusp',
        noProviderCredentials: !Object.keys(process.env).some((key) => /^(OPENAI_|ANTHROPIC_)/.test(key)),
      }));
    `;
    const result = spawnSync(process.execPath, [
      join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe,
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    const failure = result.stderr.slice(-3000) + result.stdout.slice(-2000);
    const childHome = result.stdout.match(/^GIT_FETCH_MUTEX_HOME (.+)$/m)?.[1];
    expect(childHome, failure).toBeTruthy();
    expect(existsSync(childHome!)).toBe(false);
    expect(result.status, failure).toBe(0);
    const payload = result.stdout.match(/^GIT_FETCH_MUTEX_PROBE (.+)$/m)?.[1];
    expect(payload, failure).toBeTruthy();
    const measured = JSON.parse(payload!) as {
      head: string; hashes: Record<string, string>;
      actual: { code: number; stderr: string }; actualCalls: number;
      readerPreserved: boolean; cachePreserved: boolean; controlPending: boolean;
      controlResult: { code: number; stderr: string }; controlCalls: number; cleanupCalls: number;
      warnings: string[]; logicalCacheBytes: number; allocatedCacheBytes: number;
      privateMutex: boolean; privateBackground: boolean; privateHome: boolean; noProviderCredentials: boolean;
    };
    expect(measured.head).toMatch(/^[a-f0-9]{40}$/);
    expect(measured.hashes).toEqual(before);
    expect(sourceHashes()).toEqual(before);
    expect(measured.actual).toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
    expect(measured.actualCalls).toBe(1);
    expect(measured.warnings.some((warning) => warning.includes('mutex-unavailable') && warning.includes('5000ms'))).toBe(true);
    expect(measured.readerPreserved).toBe(true);
    expect(measured.cachePreserved).toBe(true);
    expect(measured.controlPending).toBe(true);
    expect(measured.controlResult).toMatchObject({ code: -1, stderr: expect.stringContaining('critical reserve') });
    expect(measured.controlCalls).toBe(1);
    expect(measured.cleanupCalls).toBe(1);
    expect(measured.logicalCacheBytes).toBe(9 * 1024 ** 3);
    expect(measured.allocatedCacheBytes).toBeLessThan(1024 ** 2);
    expect(measured.privateMutex).toBe(true);
    expect(measured.privateBackground).toBe(true);
    expect(measured.privateHome).toBe(true);
    expect(measured.noProviderCredentials).toBe(true);
  }, 150_000);
});
