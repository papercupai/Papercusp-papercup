/**
 * scripts/lib/host-bundle-ascii.mjs - the ASCII verdict lint:host-bundle-builds renders
 * on the BUILT host bundle (WI-6554700010009506).
 *
 * The ascii-escape pass (apps/operator/bin/ascii-escape-bundle.mjs) never fails the
 * build: one non-ASCII char inside a String.raw template makes it ship the WHOLE bundle
 * un-escaped (two-byte source, ~2x resident in every host process). These tests pin the
 * guard that turns that silent fallback into a named failure, and pin it against the
 * REAL pass so the two cannot drift apart.
 *
 * Fixture text is built from code points so this file itself stays ASCII.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const ESCAPE_PASS = join(REPO_ROOT, 'apps/operator/bin/ascii-escape-bundle.mjs');
const RSQUO = String.fromCharCode(0x2019);
const MIDDOT = String.fromCharCode(0xb7);
const BT = '`';
const MARKER = '// ../../packages/operator-core/lib/carry-surface-provenance-lint.ts';

interface Site {
  line: number;
  module: string | null;
  codePoints: string[];
}
interface Verdict {
  ok: boolean;
  nonAscii: number;
  sites: Site[];
}
let verdict: (src: string) => Verdict;

beforeAll(async () => {
  const mod = await import(pathToFileURL(join(REPO_ROOT, 'scripts/lib/host-bundle-ascii.mjs')).href);
  verdict = mod.hostBundleAsciiVerdict;
});

const bundle = (...lines: string[]) => lines.join('\n') + '\n';
// "var R = new RegExp(String.raw`^['<x>]s`)" built without a template literal in this file.
const rawRegexLine = (inner: string) => 'var R = new RegExp(String.raw' + BT + "^['" + inner + "]s" + BT + ');';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-bundle-ascii-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hostBundleAsciiVerdict', () => {
  it('passes a pure-ASCII bundle, including a String.raw that interpolates its non-ASCII char', () => {
    const src = bundle(MARKER, rawRegexLine('${RIGHT_SINGLE_QUOTE}'));
    expect(verdict(src)).toEqual({ ok: true, nonAscii: 0, sites: [] });
  });

  it('names a String.raw site that carries a literal non-ASCII char, with its module and line', () => {
    const src = bundle('// ../../packages/other/lib/a.ts', 'var a = 1;', MARKER, 'var b = 2;', rawRegexLine(RSQUO));
    expect(verdict(src)).toEqual({
      ok: false,
      nonAscii: 1,
      sites: [{ line: 5, module: MARKER.slice(3), codePoints: ['U+2019'] }],
    });
  });

  it('fails without blaming String.raw when the leftover chars are elsewhere', () => {
    const src = bundle(MARKER, '// a comment with a middle dot ' + MIDDOT, 'var x = 1;');
    expect(verdict(src)).toEqual({ ok: false, nonAscii: 1, sites: [] });
  });
});

describe('agreement with the real ascii-escape pass', () => {
  function runPass(text: string): string {
    const file = join(dir, 'hono-host.mjs');
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, [ESCAPE_PASS, file], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    return readFileSync(file, 'utf8');
  }

  it('a site the guard names is one the pass refuses on, leaving the bundle un-escaped', () => {
    const text = bundle(MARKER, '// comment ' + MIDDOT, rawRegexLine(RSQUO), 'export {};');
    const out = runPass(text);
    expect(out).toBe(text);
    const v = verdict(out);
    expect(v.ok).toBe(false);
    expect(v.sites).toEqual([{ line: 3, module: MARKER.slice(3), codePoints: ['U+2019'] }]);
  });

  it('the interpolated form lets the pass escape everything else, so the guard passes', () => {
    const text = bundle(
      MARKER,
      '// comment ' + MIDDOT,
      'var RIGHT_SINGLE_QUOTE = String.fromCharCode(0x2019);',
      rawRegexLine('${RIGHT_SINGLE_QUOTE}'),
      'export {};',
    );
    const out = runPass(text);
    expect(out).not.toBe(text);
    expect(verdict(out)).toEqual({ ok: true, nonAscii: 0, sites: [] });
  });
});
