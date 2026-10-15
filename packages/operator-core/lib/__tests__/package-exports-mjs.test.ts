import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-10004970: operator-core's `exports` map sent every `lib/*` subpath to `lib/*.ts`, so a
 * package-specifier import of a plain-Node `.mjs` module (`@papercusp/operator-core/lib/x.mjs`)
 * resolved to a nonexistent `x.mjs.ts`. `psu-launcher.mjs` gained one such import and every
 * plain-Node load of it failed with ERR_MODULE_NOT_FOUND. The `./lib/*.mjs` entry fixes the class.
 *
 * Resolution is asked of a real `node` process, not of vitest: vite has its own resolver, and the
 * failure only existed under Node's.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function nodeResolve(specifier: string): string {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
  );
  return fileURLToPath(out.trim());
}

describe('@papercusp/operator-core exports map under plain Node', () => {
  it('resolves a .mjs subpath to the .mjs file itself', () => {
    const resolved = nodeResolve('@papercusp/operator-core/lib/agent-kickoff/prompt-transport.mjs');
    expect(resolved.endsWith(`${path.sep}lib${path.sep}agent-kickoff${path.sep}prompt-transport.mjs`)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('still maps an extensionless subpath to its .ts source', () => {
    const resolved = nodeResolve('@papercusp/operator-core/lib/util/cli-entry');
    expect(resolved.endsWith(`${path.sep}lib${path.sep}util${path.sep}cli-entry.ts`)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('loads psu-launcher.mjs, the importer that broke', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(path.join(repoRoot, 'apps/operator/scripts/psu-launcher.mjs'))}); process.stdout.write('LOADED')`,
      ],
      // Imported, not run: its main() is gated on isCliEntry, which is false under `-e`.
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    expect(out).toContain('LOADED');
  });
});
