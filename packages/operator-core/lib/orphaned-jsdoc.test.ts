import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  orphanedJsdocProblems,
  formatOrphanedJsdoc,
} from '../../../scripts/lib/orphaned-jsdoc.ts';

const REPO = resolve(__dirname, '../../..');

const one = (src: string) => orphanedJsdocProblems(new Map([['f.mjs', src]]));

describe('orphanedJsdocProblems', () => {
  it('CATCHES a signature block stranded before another JSDoc block', () => {
    const p = one(`/**
 * @param {string} tscCommand
 * @returns {string | null}
 */
/**
 * Some other thing.
 */
export const OTHER = 1;
`);
    expect(p).toHaveLength(1);
    expect(p[0]?.line).toBe(1);
    expect(formatOrphanedJsdoc(p)[0]).toContain('@param {string} tscCommand');
  });

  it('does NOT fire when the block is attached to its declaration', () => {
    expect(
      one(`/**
 * @param {string} x
 */
export function f(x) { return x; }
`),
    ).toEqual([]);
  });

  it.each(['/** @overload', '/**\n * @overload'])(
    'does NOT fire on an intentional overload chain starting with %s',
    (opening) => {
      expect(
        one(`${opening}
 * @param {string} value
 * @returns {string}
 */
${opening}
 * @param {number} value
 * @returns {number}
 */
/**
 * @param {string | number} value
 * @returns {string | number}
 */
export function identity(value) { return value; }
`),
      ).toEqual([]);
    },
  );

  it('still catches an ordinary signature stranded after an overload block', () => {
    const problems = one(`/** @overload
 * @param {string} value
 * @returns {string}
 */
/**
 * @param {string | number} value
 * @returns {string | number}
 */
/**
 * Another declaration.
 */
export const OTHER = 1;
`);
    expect(problems.map((problem) => problem.line)).toEqual([5]);
  });

  it('does NOT mistake an @overload mentioned in prose for an overload tag', () => {
    const problems = one(`/**
 * This is not an @overload signature.
 * @param {string} value
 */
/**
 * Another declaration.
 */
export const OTHER = 1;
`);
    expect(problems.map((problem) => problem.line)).toEqual([1]);
  });

  it('does NOT fire on a @typedef block that legitimately precedes another block', () => {
    expect(
      one(`/**
 * @typedef {object} Opts
 * @property {string} root
 */
/**
 * @param {Opts} o
 */
export function f(o) { return o; }
`),
    ).toEqual([]);
  });

  it('does NOT fire on a @param mentioned in PROSE inside a @typedef block', () => {
    // Regression: a first cut matched @param anywhere and false-fired on this real block.
    expect(
      one(`/**
 * Options bag.
 *
 * Written as a \`@typedef\` with \`@property\` tags, NOT as an inline \`@param {{ … }}\`.
 * @typedef {object} Opts
 * @property {string} root
 */
/**
 * @param {Opts} o
 */
export function f(o) { return o; }
`),
    ).toEqual([]);
  });

  it('does NOT fire on a prose-only block followed by another block (file header)', () => {
    expect(
      one(`/**
 * File header prose, documents nothing in particular.
 */
/**
 * @param {string} x
 */
export function f(x) { return x; }
`),
    ).toEqual([]);
  });

  it('reports every orphan, in line order', () => {
    const p = one(`/**
 * @param {string} a
 */
/**
 * @returns {number}
 */
/**
 * @param {string} c
 */
export function f(c) { return c; }
`);
    expect(p.map((x) => x.line)).toEqual([1, 4]);
  });

  it('CONTROL: the enrolled .mjs modules currently have zero orphans', () => {
    const cfg = resolve(REPO, 'tsconfig.declarations.json');
    if (!existsSync(cfg)) return; // not this checkout's concern
    const files: string[] =
      JSON.parse(readFileSync(cfg, 'utf8').replace(/^\s*\/\/.*$/gm, '')).files ?? [];
    const sources = new Map<string, string>();
    for (const f of files) {
      const abs = resolve(REPO, f);
      if (existsSync(abs)) sources.set(f, readFileSync(abs, 'utf8'));
    }
    expect(sources.size).toBeGreaterThan(0); // the control must actually read something
    expect(formatOrphanedJsdoc(orphanedJsdocProblems(sources))).toEqual([]);
  });
});
