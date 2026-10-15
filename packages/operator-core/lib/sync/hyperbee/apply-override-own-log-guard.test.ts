/**
 * apply-override-own-log-guard.test.ts — recurrence guard for WI-6554700010008569.
 *
 * The defect class: an `applyOverride` closure passed to `bootHarnessSubstrate` that reads
 * the RETURNED handle's own log (`handleB!.ownLog.keyHex`, `peer.handle.ownLog.keyHex`).
 * A merge pass can run BEFORE `bootHarnessSubstrate` returns — a rejoining peer already holds
 * admitted logs, or a peer-connect handshake folds content on the very first connection — so
 * at that moment the handle variable is still `undefined` and the closure throws a TypeError
 * inside the merge pass. boot.ts therefore hands every override a `ctx` carrying
 * `ownLogKeyHex`, built from the own log BEFORE the first merge pass; closures must use it.
 *
 * How this proves it:
 *   1. A detector scans source with comments AND string/template literals blanked
 *      (`stripCommentsAndStrings`, offset-preserving), finds each `applyOverride:` closure,
 *      bounds its body by bracket depth, and reports any `.ownLog` member read inside it.
 *   2. Calibration: a known-bad fixture is flagged (so the control can never pass
 *      vacuously), known-good shapes are not, and a `.ownLog` read in a SIBLING property is
 *      not attributed to the closure.
 *   3. `probeStringLiteralBlindness` proves the detector cannot flag the token as prose —
 *      the bad fixture below lives in a string literal of THIS file, which the tree scan reads.
 *   4. The tree scan over packages/operator-core/lib must find a real population of closures
 *      (a walker that scanned nothing would otherwise report a clean zero) and zero reads.
 *
 * The rule is deliberately "no `.ownLog` read at all inside the closure", not "not your own
 * handle": which handle a variable names is not decidable syntactically, and a read of an
 * already-booted peer's key is better captured into a const BEFORE the boot call anyway
 * (feature-content-federation's `aOwnLogKeyHex` is the worked example).
 *
 * Scope note: an `applyOverride` given by IDENTIFIER (a function defined elsewhere) is not
 * followed; every override in the tree today is an inline closure.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  probeStringLiteralBlindness,
  stripCommentsAndStrings,
} from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = dirname(new URL(import.meta.url).pathname);
const OPERATOR_CORE = resolve(HERE, '../../..');
const SCAN_ROOT = join(OPERATOR_CORE, 'lib');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.papercusp', '.vitest-tmp']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;

const OPENER_TO_CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** `applyOverride:` followed by an arrow parameter list or a `function` expression. */
const KEY = /\bapplyOverride\s*:\s*(?:async\s+)?(?:function\b[^(]*)?\(/g;
const OWN_LOG_READ = /\.ownLog\b/g;

/** Index of the bracket closing the one at `open`, or -1. Code-only text: strings are blanked. */
function matchClose(code: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch in OPENER_TO_CLOSER) stack.push(OPENER_TO_CLOSER[ch]!);
    else if (CLOSERS.has(ch)) {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** End (exclusive) of an expression-bodied arrow: the first depth-0 `,` or unmatched closer. */
function expressionEnd(code: string, start: number): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (ch in OPENER_TO_CLOSER) depth++;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) return i;
      depth--;
    } else if (ch === ',' && depth === 0) return i;
  }
  return code.length;
}

/** [start, end) of the closure body whose parameter list opens at `paramsOpen`, or null. */
function closureBody(code: string, paramsOpen: number, isFunction: boolean): [number, number] | null {
  const paramsClose = matchClose(code, paramsOpen);
  if (paramsClose < 0) return null;
  if (isFunction) {
    const brace = code.indexOf('{', paramsClose);
    if (brace < 0) return null;
    const end = matchClose(code, brace);
    return end < 0 ? null : [brace, end + 1];
  }
  const arrow = code.indexOf('=>', paramsClose);
  if (arrow < 0) return null;
  let k = arrow + 2;
  while (k < code.length && /\s/.test(code[k]!)) k++;
  if (code[k] === '{') {
    const end = matchClose(code, k);
    return end < 0 ? null : [k, end + 1];
  }
  return [k, expressionEnd(code, k)];
}

export interface OwnLogRead {
  line: number;
  text: string;
}

/** Scan one source text: how many `applyOverride` closures, and every `.ownLog` read inside one. */
export function scanApplyOverrideClosures(
  src: string,
  fileName = 'source.ts',
): { closures: number; reads: OwnLogRead[] } {
  const code = stripCommentsAndStrings(src, fileName);
  const rawLines = src.split('\n');
  const reads: OwnLogRead[] = [];
  let closures = 0;
  for (const m of code.matchAll(KEY)) {
    const paramsOpen = m.index! + m[0].length - 1;
    const body = closureBody(code, paramsOpen, /\bfunction\b/.test(m[0]));
    if (!body) continue;
    closures++;
    const slice = code.slice(body[0], body[1]);
    for (const r of slice.matchAll(OWN_LOG_READ)) {
      const offset = body[0] + r.index!;
      const line = code.slice(0, offset).split('\n').length;
      reads.push({ line, text: (rawLines[line - 1] ?? '').trim() });
    }
  }
  return { closures, reads };
}

const detector = (src: string) => scanApplyOverrideClosures(src).reads;

// ── Fixtures. They are STRING LITERALS, so the tree scan (which blanks strings) never sees them. ──

/** The defect, exactly as it stood at the migrated sites: must be flagged once. */
const BAD_BLOCK_FIXTURE = `
const handle = await bootHarnessSubstrate({
  applyOverride: (op) => {
    applyB ??= buildPeerApply(dbB.sql, handleB!.ownLog.keyHex);
    return applyB(op);
  },
  mergePollMs: 0,
});
`;

const BAD_EXPRESSION_FIXTURE = `boot({ applyOverride: (op) => build(peer.handle.ownLog.keyHex)(op), x: 1 });`;
const BAD_ASYNC_FUNCTION_FIXTURE = `boot({ applyOverride: async function (op) { return apply(h!.ownLog.keyHex, op); } });`;

/** The migrated shape: no finding. */
const GOOD_FIXTURE = `
boot({
  applyOverride: (op, ctx) => {
    applyB ??= buildPeerApply(dbB.sql, ctx.ownLogKeyHex);
    return applyB(op);
  },
});
`;

/** A `.ownLog` read AFTER the closure, in a sibling property: not the closure's read. */
const SIBLING_FIXTURE = `boot({ applyOverride: (op, ctx) => apply(ctx.ownLogKeyHex, op), lenBefore: handleA.ownLog.length });`;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('applyOverride closures never read the returned handle’s own log (WI-6554700010008569)', () => {
  it('flags the known-bad fixture exactly once, on the closure line (control is still detector-shaped)', () => {
    const reads = detector(BAD_BLOCK_FIXTURE);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.text).toContain('handleB!.ownLog.keyHex');
  });

  it('flags expression-bodied arrows and async function expressions', () => {
    expect(detector(BAD_EXPRESSION_FIXTURE)).toHaveLength(1);
    expect(detector(BAD_ASYNC_FUNCTION_FIXTURE)).toHaveLength(1);
  });

  it('accepts the ctx.ownLogKeyHex shape and does not attribute a sibling property’s read', () => {
    expect(scanApplyOverrideClosures(GOOD_FIXTURE)).toEqual({ closures: 1, reads: [] });
    expect(scanApplyOverrideClosures(SIBLING_FIXTURE)).toEqual({ closures: 1, reads: [] });
  });

  it('is blind to the token in prose (string, template, comment)', () => {
    const probe = probeStringLiteralBlindness(
      detector,
      'applyOverride: (op) => build(handleB!.ownLog.keyHex)',
    );
    expect(probe.ok, probe.detail).toBe(true);
  });

  it('no applyOverride closure under packages/operator-core/lib reads .ownLog', () => {
    let closures = 0;
    const offenders: string[] = [];
    for (const abs of walk(SCAN_ROOT)) {
      const src = readFileSync(abs, 'utf8');
      if (!src.includes('applyOverride')) continue;
      const result = scanApplyOverrideClosures(src, abs);
      closures += result.closures;
      for (const r of result.reads) offenders.push(`${relative(OPERATOR_CORE, abs)}:${r.line}  ${r.text}`);
    }
    // Population floor: 50+ inline closures existed when this guard landed. A walker that
    // scanned nothing (wrong root, broken KEY regex) must fail here, not report a clean zero.
    expect(closures).toBeGreaterThanOrEqual(30);
    // Offenders go in the MESSAGE so a failure prints every one (a value diff elides them).
    expect(
      offenders.length,
      'take the own-log key from the boot ctx: `applyOverride: (op, ctx) => …ctx.ownLogKeyHex…`\n' +
        offenders.join('\n'),
    ).toBe(0);
  });
});
