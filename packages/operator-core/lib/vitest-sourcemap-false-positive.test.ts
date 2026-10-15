import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-6554700010008868: Vitest pretty-prints every failure stack by reading each named file and
 * extracting its inline source map (`@vitest/utils` `extractSourcemapFromFile`). Tools that
 * GENERATE source maps (tsx, esbuild) carry the literal `//# sourceMappingURL=data:application/json;base64,`
 * at a line start inside a template string. convert-source-map matches that literal and JSON-parses
 * base64-decoded JavaScript. The resulting SyntaxError ('"�" is not valid JSON') then REPLACED
 * the test failure whose stack named that file. A child process's stack embedded in an assertion
 * message (for example `expect(run.status, run.stderr)`) names exactly such files.
 *
 * patches/vitest++@vitest+utils+4.1.8.patch makes an unparseable map mean "no map". This suite
 * exercises the INSTALLED module Vitest itself resolves, against the INSTALLED tsx file that
 * produced the original crash, not a copy of either.
 */
const requireHere = createRequire(import.meta.url);
const requireFromVitest = createRequire(requireHere.resolve('vitest/package.json'));
const sourceMapNodePath = requireFromVitest.resolve('@vitest/utils/source-map/node');
const requireFromUtils = createRequire(sourceMapNodePath);
const convertSourceMap = requireFromUtils('convert-source-map') as { fromSource(code: string): unknown };
const { extractSourcemapFromFile } = (await import(pathToFileURL(sourceMapNodePath).href)) as {
  extractSourcemapFromFile(code: string, filePath: string): { map: { version: number; sources: string[] } } | undefined;
};

const LITERAL = 'sourceMappingURL=data:application/json;base64,';
const tsxDist = join(dirname(requireHere.resolve('tsx/package.json')), 'dist');
const generatorFiles = readdirSync(tsxDist)
  .filter((name) => /\.(c|m)?js$/.test(name))
  .map((name) => join(tsxDist, name))
  .filter((file) => readFileSync(file, 'utf8').includes(LITERAL));

describe('Vitest source-map extraction over files that generate source maps', () => {
  it('the installed tsx carries the false-positive literal and convert-source-map throws on it (fixture calibration)', () => {
    expect(generatorFiles.length, `no file under ${tsxDist} contains ${LITERAL}; re-pick the real fixture`).toBeGreaterThan(0);
    const throwing = generatorFiles.filter((file) => {
      try {
        convertSourceMap.fromSource(readFileSync(file, 'utf8'));
        return false;
      } catch (error) {
        return error instanceof SyntaxError;
      }
    });
    expect(throwing.length, 'no installed tsx file reproduces the convert-source-map SyntaxError').toBeGreaterThan(0);
  });

  it('extractSourcemapFromFile returns no map instead of throwing for every such file', () => {
    for (const file of generatorFiles) {
      expect(() => extractSourcemapFromFile(readFileSync(file, 'utf8'), file), file).not.toThrow();
      expect(extractSourcemapFromFile(readFileSync(file, 'utf8'), file), file).toBeUndefined();
    }
  });

  it('a genuine inline source map is still extracted', () => {
    const map = { version: 3, sources: ['probe.ts'], names: [], mappings: 'AAAA' };
    const code = `export const x = 1;\n//# ${LITERAL}${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
    expect(extractSourcemapFromFile(code, '/tmp/probe.js')?.map).toMatchObject({ version: 3, sources: ['probe.ts'] });
  });
});
