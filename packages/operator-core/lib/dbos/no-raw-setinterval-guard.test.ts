/**
 * no-raw-setinterval-guard.test.ts — the no-raw-setInterval CI guard's detection
 * predicate (schedule-inventory-and-ephemeral-tier-2026-06-26, P-007).
 *
 * The guard (`scripts/check-no-raw-setinterval.mjs`) runs green on the clean tree
 * (no-false-positive direction). This locks the direction P-007 actually asks for —
 * that it FLAGS a NEW bare setInterval() while NOT flagging managedSetInterval, the
 * injectable timer seam, type references, or prose mentions in comments.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findOffenders, usesRawSetInterval } from '../../../../scripts/check-no-raw-setinterval.mjs';

describe('no-raw-setinterval guard predicate (P-007)', () => {
  it('classifies the actual killed-owner fixture as a separate test process', () => {
    const path = 'scripts/lib/runtime-compatibility-admission.mjs';
    const source = readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8');
    // The real raw timer remains detectable; only its process classification differs.
    expect(usesRawSetInterval(source, path)).toBe(true);
    expect(findOffenders().offenders).not.toContain(path);
  });

  it('FLAGS a bare setInterval(...) call', () => {
    expect(usesRawSetInterval('const t = setInterval(() => tick(), 1000);')).toBe(true);
  });

  it('FLAGS window./global.setInterval(...) forms', () => {
    expect(usesRawSetInterval('const t = window.setInterval(poll, 500);')).toBe(true);
    expect(usesRawSetInterval('globalThis.setInterval(beat, 2000);')).toBe(true);
  });

  it('does NOT flag managedSetInterval(...) (the registry wrapper)', () => {
    expect(
      usesRawSetInterval("managedSetInterval('x', 1000, fn, { category: 'global-sweep' });"),
    ).toBe(false);
  });

  it('does NOT flag the injectable timer seam (setIntervalImpl / setIntervalFn)', () => {
    expect(usesRawSetInterval('const h = opts.setIntervalImpl(cb, ms);')).toBe(false);
    expect(usesRawSetInterval('const setIv = deps.setIntervalFn ?? setInterval;')).toBe(false); // bare ref, no call
  });

  it('does NOT flag a type-level reference (typeof setInterval)', () => {
    expect(usesRawSetInterval('let timer: ReturnType<typeof setInterval> | null = null;')).toBe(false);
  });

  it('does NOT flag a setInterval() mentioned only in a comment (comments are stripped)', () => {
    const codeWithComment = [
      '// the legacy setInterval() worker stood down once DBOS owned the schedule',
      '/** Replaces the setInterval(...) ticker. */',
      "managedSetInterval('y', 2000, fn, { category: 'watchdog' });",
    ].join('\n');
    expect(usesRawSetInterval(codeWithComment)).toBe(false);
  });
});
