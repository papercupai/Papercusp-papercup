/**
 * no-unenrolled-detached-import-guard.test.ts — the detection predicate behind
 * `scripts/check-no-unenrolled-detached-import.mjs` (follow-up hardening for
 * EI-20349773342925327, filed as WI-39811).
 *
 * The guard runs green on the clean tree, which only proves the no-false-positive
 * direction. This file locks the direction that actually matters — that it FLAGS a NEW
 * unenrolled `void import(...)` — and does so falsifiably.
 *
 * ── WHY THERE ARE DELIBERATELY-WRONG DETECTORS BELOW ───────────────────────────────
 * A guard test that has never failed is a guard you have not tested, and the safe way to
 * prove falsifiability here is NOT to mutate the shared tree (git-sync sweeps it every few
 * minutes and would commit the mutant — CLAUDE.md § "Proving a guard is falsifiable").
 * The subject is a MODULE we import, so the prescribed tier applies: keep permanently-wrong
 * implementations in the test file as CONTROLS and assert they fail the very corpus the real
 * predicate passes. If a future refactor weakens the real predicate into either control's
 * shape, the calibration tests below go red.
 *
 * Both controls are needed, because they fail in opposite directions:
 *   - `blindToMasking` catches PROSE (it never strips comments/strings) → proves the
 *     negative cases have teeth. This is the phantom-offender defect that red-pinned the
 *     fleet gate once already.
 *   - `neverFlags` catches nothing → proves the positive cases have teeth.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only.
import {
  findUnenrolledDetachedImports,
  classifyVitestConfig,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
} from '../../../../scripts/check-no-unenrolled-detached-import.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { probeStringLiteralBlindness } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

type Detector = (text: string, fileName?: string) => { line: number }[];

const detect: Detector = (text, fileName = 'subject.ts') =>
  findUnenrolledDetachedImports(text, fileName);

const flags = (text: string): boolean => detect(text).length > 0;

/** CONTROL A (permanently wrong): no masking, so prose and string literals become offenders. */
const blindToMasking: Detector = (text) =>
  text.includes('void import(') ? [{ line: 1 }] : [];

/** CONTROL B (permanently wrong): reports nothing, ever. */
const neverFlags: Detector = () => [];

/** Sources the guard MUST flag. */
const MUST_FLAG: [string, string][] = [
  ['a bare detached import', "void import('./side-effect');"],
  [
    'a detached import with a then/catch chain',
    "void import('../../sync-sse')\n  .then((m) => m.notifySyncInvalidate('x'))\n  .catch(() => {});",
  ],
  [
    'a detached import split across lines',
    "void import(\n  './very/long/module/specifier'\n);",
  ],
  ['a detached import indented inside a block', "if (ready) {\n    void import('./lazy');\n  }"],
];

/** Sources the guard MUST NOT flag. */
const MUST_NOT_FLAG: [string, string][] = [
  ['an ENROLLED import (the whole point)', "void trackDetached(import('./side-effect'));"],
  [
    'an enrolled import with a chain',
    "void trackDetached(import('../../sync-sse'))\n  .then((m) => m.notifySyncInvalidate('x'))\n  .catch(() => {});",
  ],
  ['an awaited import (not detached)', "const m = await import('./mod');"],
  ['an assigned import (caller keeps the promise)', "const p = import('./mod');"],
  ['a returned import', "return import('./mod');"],
  ['a static import', "import { thing } from './mod';"],
];

describe('no-unenrolled-detached-import guard predicate (WI-39811)', () => {
  it.each(MUST_FLAG)('FLAGS %s', (_label, src) => {
    expect(flags(src)).toBe(true);
  });

  it.each(MUST_NOT_FLAG)('does NOT flag %s', (_label, src) => {
    expect(flags(src)).toBe(false);
  });

  it('reports the 1-based line of each offender', () => {
    const src = ["const a = 1;", "void import('./one');", "const b = 2;", "void import('./two');"].join(
      '\n',
    );
    expect(detect(src).map((h) => h.line)).toEqual([2, 4]);
  });

  it('does NOT flag the idiom mentioned only in a comment', () => {
    const src = [
      "// A detached `void import('x')` can outlive its test file — wrap it in trackDetached.",
      "/** Replaces the old void import(...) form. */",
      "void trackDetached(import('./mod'));",
    ].join('\n');
    expect(flags(src)).toBe(false);
  });

  it('does NOT flag the idiom appearing only inside a string/template literal', () => {
    // The shared recurrence guard for the phantom-offender class: a comments-only strip
    // reports a phantom here, which is the defect that red-pinned the fleet gate.
    const probe = probeStringLiteralBlindness(
      (src: string) => detect(src),
      "wrap a bare void import( call in trackDetached",
    );
    expect(probe.ok, probe.detail).toBe(true);
  });
});

describe('CALIBRATION — the corpus discriminates (permanently-wrong controls fail it)', () => {
  it('the real predicate passes BOTH directions of the corpus', () => {
    for (const [, src] of MUST_FLAG) expect(flags(src)).toBe(true);
    for (const [, src] of MUST_NOT_FLAG) expect(flags(src)).toBe(false);
  });

  it('CONTROL A (no masking) is caught — it flags prose, so the negatives have teeth', () => {
    const prose = "// wrap a bare void import( call in trackDetached\n";
    expect(blindToMasking(prose).length > 0).toBe(true); // control is wrong...
    expect(flags(prose)).toBe(false); // ...and the real predicate is not
  });

  it('CONTROL B (never flags) is caught — so the positives have teeth', () => {
    const anyOffender = MUST_FLAG[0][1];
    expect(neverFlags(anyOffender).length > 0).toBe(false); // control is wrong...
    expect(flags(anyOffender)).toBe(true); // ...and the real predicate is not
  });
});

describe('derived failing scope — classifyVitestConfig (WI-39811)', () => {
  it('recognises a lane-split workspace that wires the drain', () => {
    const cfg = [
      "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';",
      'export default defineVitestConfig({',
      "  layer: 'unit',",
      '  laneSplit: true,',
      "  setupFiles: [resolve(__dirname, 'lib/detached-imports/setup-vitest.ts')],",
      '});',
    ].join('\n');
    expect(classifyVitestConfig(cfg)).toEqual({ laneSplit: true, drainWired: true });
  });

  it('flags a lane-split workspace with NO drain wiring (every trackDetached there is inert)', () => {
    const cfg = ['export default defineVitestConfig({', '  laneSplit: true,', '});'].join('\n');
    // IN scope (isolate:false is reachable) but with no drain — the combination the guard
    // must fail loudly on, because trackDetached would be silently inert there.
    expect(classifyVitestConfig(cfg)).toEqual({ laneSplit: true, drainWired: false });
  });

  it('does not treat a workspace without the lane split as in scope', () => {
    const cfg = ['export default defineVitestConfig({', "  layer: 'unit',", '});'].join('\n');
    expect(classifyVitestConfig(cfg).laneSplit).toBe(false);
  });

  it('does NOT count a laneSplit mentioned only in a comment', () => {
    const cfg = ['// laneSplit: true would opt this workspace in; it does not.', 'export default {};'].join(
      '\n',
    );
    expect(classifyVitestConfig(cfg).laneSplit).toBe(false);
  });

  it('does NOT count drain wiring mentioned only in a comment', () => {
    // The failure this prevents: operator-core's config DESCRIBES the wiring in prose. A
    // check reading raw text would call every such config "wired" and could only ever pass.
    const cfg = [
      '// detached-imports/setup-vitest.ts drains tracked imports — we should add it one day.',
      'export default defineVitestConfig({ laneSplit: true });',
    ].join('\n');
    expect(classifyVitestConfig(cfg)).toEqual({ laneSplit: true, drainWired: false });
  });

  it('keeps the apps/operator teardown drain wired', () => {
    for (const config of ['vitest.config.ts', 'vitest.integration.config.ts']) {
      const cfg = readFileSync(new URL(`../../../../apps/operator/${config}`, import.meta.url), 'utf8');
      expect(classifyVitestConfig(cfg, `apps/operator/${config}`).drainWired).toBe(true);
    }
  });
});
