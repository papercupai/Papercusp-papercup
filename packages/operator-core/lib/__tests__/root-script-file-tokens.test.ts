/**
 * WI-10005939 — every repo-relative FILE token in the root package.json `scripts` must name a
 * file that exists, and no token may fuse two paths together.
 *
 * THE GAP THIS PINS. On 2026-10-03 06:17Z three root scripts (`lint:plane-guards`,
 * `lint:tool-prompts`, `lint:design-primitives`) lost the space after
 * `scripts/test-files.mjs`, so each became `node … scripts/test-files.mjspackages/…`. Node
 * died with ERR_MODULE_NOT_FOUND before running a single test. Nothing noticed for hours: a
 * script that crashes before measuring anything looks like any other red, and the guards it
 * wraps reported nothing at all. The defect class is "a script points at a file that is not
 * there", and it is cheap to check statically.
 *
 * SHAPE. The extraction is tested against synthetic commands (the mechanism), then applied to
 * the committed root package.json (a source file, not machine state — a clean checkout of
 * the gate sees the same bytes).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Overridable so a mutation probe can point the guard at a mutated COPY (never the tree). */
const PKG_PATH = process.env.ROOT_SCRIPT_TOKENS_PKG ?? join(REPO_ROOT, 'package.json');

const PATH_ROOT = /^(?:\.\/)?(?:scripts|packages|apps|libs|bin)\//;
const FILE_EXT = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|sh|py)$/;
/** A file extension glued straight onto the next repo path: the dropped-separator signature. */
const FUSED = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|sh|py)(?:\.\/)?(?:scripts|packages|apps|libs|bin)\//;
/** Tokens carrying shell expansion or placeholders are not literal paths; skip them. */
const NOT_LITERAL = /[*$?{}<>[\]]/;

function rawTokens(command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, '').replace(/^--?[\w-]+=/, ''))
    .filter((t) => t.length > 0);
}

/** Repo-relative file paths a script command names as literal tokens. */
function scriptFileTokens(command: string): string[] {
  return rawTokens(command).filter(
    (t) => PATH_ROOT.test(t) && FILE_EXT.test(t) && !NOT_LITERAL.test(t),
  );
}

/** Tokens where one path runs straight into another with no separator. */
function fusedPathTokens(command: string): string[] {
  return rawTokens(command).filter((t) => FUSED.test(t));
}

describe('scriptFileTokens / fusedPathTokens (mechanism)', () => {
  it('extracts direct, ./-prefixed, flag-valued and quoted file paths', () => {
    expect(
      scriptFileTokens(
        `node --import ./scripts/lib/loader.mjs scripts/test-files.mjs packages/a/b.test.ts && bash 'scripts/x.sh' --config=apps/operator/vitest.config.ts`,
      ),
    ).toEqual([
      './scripts/lib/loader.mjs',
      'scripts/test-files.mjs',
      'packages/a/b.test.ts',
      'scripts/x.sh',
      'apps/operator/vitest.config.ts',
    ]);
  });

  it('ignores globs, env expansion, directories and non-repo paths', () => {
    expect(
      scriptFileTokens('vitest run packages/**/*.test.ts $FILE apps/operator /tmp/x.mjs node_modules/a.js'),
    ).toEqual([]);
  });

  it('flags the dropped-separator signature, and only that', () => {
    const broken = 'node --import ./scripts/lib/loader.mjs scripts/test-files.mjspackages/a/b.test.ts';
    expect(fusedPathTokens(broken)).toEqual(['scripts/test-files.mjspackages/a/b.test.ts']);
    expect(fusedPathTokens(broken.replace('.mjspackages', '.mjs packages'))).toEqual([]);
  });
});

describe('root package.json scripts (committed source)', () => {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
    scripts: Record<string, string>;
  };
  const entries = Object.entries(pkg.scripts);

  it('has scripts to check (positive control: the parse found the population)', () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.flatMap(([, cmd]) => scriptFileTokens(cmd)).length).toBeGreaterThan(50);
  });

  it('no script fuses two paths together', () => {
    const fused = entries.flatMap(([name, cmd]) => fusedPathTokens(cmd).map((t) => `${name}: ${t}`));
    expect(fused).toEqual([]);
  });

  it('every repo-relative file a script names exists', () => {
    const missing = entries.flatMap(([name, cmd]) =>
      scriptFileTokens(cmd)
        .filter((t) => !existsSync(join(REPO_ROOT, t)))
        .map((t) => `${name}: ${t}`),
    );
    expect(missing).toEqual([]);
  });
});
