/**
 * WI-10006911: the Vite client tree must never call a bare `require(...)`.
 *
 * The operator UI is a Vite ESM app (it was Next.js/webpack, which tolerated a
 * lazy `require()` in client code). In the browser `require` does not exist, so
 * a bare call throws `ReferenceError: require is not defined` the moment its
 * branch runs. `defaultGenerationFn` in OperatorConversationProvider did exactly
 * that before every brain request, so EVERY operator converse turn (typed or
 * spoken) failed with "The operator could not complete this turn: require is not
 * defined" — and nothing caught it: typecheck accepts the `typeof import(...)`
 * cast, and the call sat behind an eslint-disable for no-require-imports.
 *
 * Comments and string literals are masked first, so prose that mentions
 * `require(` (like this header) cannot trip the guard, and a member call such
 * as `module.require(` or `createRequire(` is not a bare call.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripCommentsAndStrings } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const OPERATOR_ROOT = join(__dirname, '..');
/** Directories Vite serves to the browser (the SPA client tree). */
const CLIENT_DIRS = ['app', 'providers'];
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP_RE = /(\.test\.|\.spec\.|\.stories\.|\/__tests__\/|\/node_modules\/)/;
/** A call to the free identifier `require` — not `x.require(`, not `createRequire(`. */
const BARE_REQUIRE_RE = /(^|[^.\w$])require\s*\(/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_RE.test(p)) continue;
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (SOURCE_RE.test(name)) out.push(p);
  }
}

export function findBareRequires(source: string, fileName: string): number[] {
  const masked = stripCommentsAndStrings(source, fileName) as string;
  const lines: number[] = [];
  for (const m of masked.matchAll(BARE_REQUIRE_RE)) {
    const at = (m.index ?? 0) + m[1].length;
    lines.push(masked.slice(0, at).split('\n').length);
  }
  return lines;
}

describe('Vite client tree has no bare require() (WI-10006911)', () => {
  const files: string[] = [];
  for (const d of CLIENT_DIRS) walk(join(OPERATOR_ROOT, d), files);

  it('calibration: the scan actually covers the client tree', () => {
    // A path or SKIP_RE regression that silently scanned nothing would make
    // the real assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('OperatorConversationProvider.tsx'))).toBe(true);
  });

  it('no client source file calls a bare require()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const hits = findBareRequires(readFileSync(f, 'utf8'), f);
      for (const line of hits) offenders.push(`${relative(OPERATOR_ROOT, f)}:${line}`);
    }
    expect(offenders, 'use a static import (or `await import()`) — the browser has no require').toEqual([]);
  });

  it('control: the detector catches the exact shape that shipped', () => {
    const shipped =
      'const fn = async () => {\n  const { getOrCreateClientId } =\n    require("@papercusp/operator-core/lib/ui/client-id") as typeof import("@papercusp/operator-core/lib/ui/client-id");\n};\n';
    expect(findBareRequires(shipped, 'shipped.tsx')).toEqual([3]);
  });

  it('control: comments, strings and member calls are not bare calls', () => {
    const benign = [
      '// require("x")',
      '/* require("y") */',
      'const s = "require(z)";',
      'const t = `require(w)`;',
      'module.require("a");',
      'const r = createRequire(import.meta.url);',
      'type T = typeof import("b");',
    ].join('\n');
    expect(findBareRequires(benign, 'benign.ts')).toEqual([]);
  });
});
