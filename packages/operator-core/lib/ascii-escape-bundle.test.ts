/**
 * apps/operator/bin/ascii-escape-bundle.mjs - the post-build pass that keeps the
 * host bundle's module source one-byte in every host process.
 *
 * The threshold is ASCII, not Latin-1 (host-memory-reduction-2026-09-27 P-005,
 * measured on node 25.9): the ESM loader holds a module's source TWO-BYTE when it
 * contains ANY non-ASCII char, U+0080..U+00FF included. The pass used to escape
 * only >= U+0100, which left ~180 lines of `middle dot` / `times` / `section` /
 * accented letters in the release bundle and doubled its in-memory cost (63.5 MiB
 * file -> 127 MiB string) in every host process. The Latin-1 case below is the
 * regression pin for that.
 *
 * Fixture text is built from escapes so this file itself stays ASCII.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = process.env.PROBE_SCRIPT || join(REPO_ROOT, 'apps/operator/bin/ascii-escape-bundle.mjs');

const LATIN1 = String.fromCharCode(0xb7, 0xd7, 0xa7, 0xe9);
const WIDE = String.fromCharCode(0x2014, 0x2192);
const ASTRAL = String.fromCodePoint(0x1f600);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ascii-escape-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runPass(file: string): string {
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', timeout: 30_000 });
  expect(r.status).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

/** Evaluate the module in a plain node process (not through vitest's transform). */
function exportsOf(file: string): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); const re = m.re ? [...m.latin1, 'a'].map((c) => m.re.test(c)) : undefined; process.stdout.write(JSON.stringify({ ...m, re }));`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(out);
}

function nonAsciiBytes(file: string): number {
  return [...readFileSync(file)].filter((b) => b > 0x7f).length;
}

describe('ascii-escape-bundle.mjs', () => {
  function checkedPass(file: string) {
    const checks = join(dir, 'checks.log');
    const recorder = join(dir, 'record-check.mjs');
    writeFileSync(recorder, `import { appendFileSync } from 'node:fs';\nif (process.execArgv.includes('--check')) appendFileSync(${JSON.stringify(checks)}, 'check\\n');\n`);
    const result = spawnSync(process.execPath, [SCRIPT, file, '--check'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(recorder).href}` },
    });
    return { ...result, checks: existsSync(checks) ? readFileSync(checks, 'utf8').trim().split('\n').length : 0 };
  }

  it.each(['rewritten', 'ASCII', 'String.raw'])(
    'checks final %s bytes exactly once, including an extensionless builder path', kind => {
      const file = join(dir, 'bundle.tmp');
      const src = kind === 'ASCII' ? 'export const value = 1;\n'
        : kind === 'String.raw' ? `export const value = String.raw\`${LATIN1}\`;\n`
          : `export const value = ${JSON.stringify(LATIN1)};\n`;
      writeFileSync(file, src);
      const result = checkedPass(file);
      expect(result.status, result.stderr).toBe(0);
      expect(result.checks).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe(kind === 'rewritten'
        ? 'export const value = "\\u00b7\\u00d7\\u00a7\\u00e9";\n' : src);
    },
  );

  it('keeps a valid original when escaping Unicode whitespace would break syntax', () => {
    const file = join(dir, 'bundle.tmp');
    const src = `export${String.fromCharCode(0xa0)}const value = 1;\n`;
    writeFileSync(file, src);
    const result = checkedPass(file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('escaped bundle failed');
    expect(result.checks).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(src);
    expect(existsSync(`${file}.ascii.tmp.mjs`)).toBe(false);
  });

  it.each(['', `// ${LATIN1}\n`, `const raw = String.raw\`${LATIN1}\`;\n`])(
    'refuses invalid final bytes even when optimization is skipped or fails (%s)', prefix => {
      const file = join(dir, 'bundle.tmp');
      const src = `${prefix}export const broken = ;\n`;
      writeFileSync(file, src);
      const result = checkedPass(file);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('final bundle failed node --check');
      expect(readFileSync(file, 'utf8')).toBe(src);
      expect(existsSync(`${file}.ascii.tmp.mjs`)).toBe(false);
    },
  );

  it('escapes Latin-1, BMP and astral chars so the file is pure ASCII, without changing any value', () => {
    const file = join(dir, 'bundle.mjs');
    writeFileSync(
      file,
      [
        `// ${LATIN1} comment-only Latin-1 is enough to widen module source`,
        `export const latin1 = ${JSON.stringify(LATIN1)};`,
        `export const wide = ${JSON.stringify(WIDE)};`,
        `export const astral = ${JSON.stringify(ASTRAL)};`,
        `export const tpl = \`${LATIN1}${WIDE}\`;`,
        `export const re = /[${LATIN1}]/;`,
        '',
      ].join('\n'),
    );
    const before = exportsOf(file);
    expect(nonAsciiBytes(file)).toBeGreaterThan(0);

    const log = runPass(file);

    expect(log).toMatch(/non-ASCII chars escaped/);
    expect(nonAsciiBytes(file)).toBe(0);
    expect(exportsOf(file)).toEqual(before);
    expect(before).toMatchObject({ latin1: LATIN1, wide: WIDE, astral: ASTRAL, tpl: `${LATIN1}${WIDE}`, re: [true, true, true, true, false] });
  });

  it('escapes a bundle whose ONLY non-ASCII chars are Latin-1 (the pre-fix >= U+0100 threshold skipped it)', () => {
    const file = join(dir, 'bundle.mjs');
    writeFileSync(file, `export const latin1 = ${JSON.stringify(LATIN1)};\n`);

    runPass(file);

    expect(nonAsciiBytes(file)).toBe(0);
    expect(exportsOf(file)).toMatchObject({ latin1: LATIN1 });
  });

  it('leaves an already-ASCII bundle byte-identical', () => {
    const file = join(dir, 'bundle.mjs');
    const src = 'export const ok = 1;\n';
    writeFileSync(file, src);

    expect(runPass(file)).toMatch(/already all ASCII/);
    expect(readFileSync(file, 'utf8')).toBe(src);
  });

  it('refuses (leaves the file alone) when a String.raw template holds a char it would have to escape', () => {
    const file = join(dir, 'bundle.mjs');
    const src = `export const raw = String.raw\`${LATIN1}\`;\n`;
    writeFileSync(file, src);

    expect(runPass(file)).toMatch(/String\.raw/);
    expect(readFileSync(file, 'utf8')).toBe(src);
  });
});
