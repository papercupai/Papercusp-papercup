/**
 * Pins Astro's generated prerender caches outside git-sync's source set.
 *
 * Astro/Starlight writes `.astro/.prerender` modules containing resolved source IDs.
 * Those IDs include the checkout path, so an accidentally repo-root cache must stay
 * ignored just like the package-local caches. Probe Git itself rather than matching
 * `.gitignore` text: the path behavior is the contract this guard protects.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GIT_TIMEOUT_MS = 15_000;

function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relPath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

describe('Astro prerender caches are gitignored', () => {
  it.each([
    '.astro/.prerender/chunks/generated-page.mjs',
    'apps/operator-docs/.astro/.prerender/chunks/generated-page.mjs',
    'apps/papercusp-docs/.astro/.prerender/chunks/generated-page.mjs',
  ])('ignores generated cache path %s', (relPath) => {
    expect(isIgnored(relPath), `${relPath} should be ignored but is not`).toBe(true);
  });

  it.each([
    'apps/operator-docs/astro.config.mjs',
    'apps/papercusp-docs/astro.config.mjs',
  ])('does not ignore authored Astro source %s', (relPath) => {
    expect(isIgnored(relPath), `${relPath} is authored source and must remain stageable`).toBe(false);
  });

  it('contains no already-tracked repo-root Astro cache files', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '.astro/'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(tracked.trim().split('\n').filter(Boolean)).toEqual([]);
  });
});
