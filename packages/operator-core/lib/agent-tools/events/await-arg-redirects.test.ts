/**
 * events:await argument-redirect contract (EI-21240881678776697).
 *
 * The filed defect was "the live schema rejects `after_generation` and `policy`".
 * Half of it fixed itself: `after_generation` became a REAL declared key on
 * 2026-08-25 (1daf98522a41), 22 hours after the last validation recheck said it
 * was rejected. The other half never will — `policy` is not an events:await
 * concept at all. Every await is a one-shot wake; the wake-vs-inject axis the
 * caller is reaching for belongs to watch:create.
 *
 * That split is the whole lesson, and it is why this guard exists rather than a
 * prose note. An authored redirect asserts "this key is NOT valid here, go
 * there instead". `after_generation` is the proof that such an assertion can
 * silently become FALSE: had anyone authored a redirect for it before 08-25, it
 * would today be actively misdirecting callers away from a key that works, and
 * nothing would fail. A redirect is code-describing metadata about the schema
 * beside it, so it gets pinned to that schema (derived-truth ladder, rung 2)
 * instead of hand-maintained.
 *
 * The load-bearing assertion is therefore the DISJOINTNESS one: a redirect key
 * that has since become declared is a lie the caller pays for, and it is exactly
 * the drift this tool has already demonstrated once.
 */
import { describe, expect, it } from 'vitest';
import { invalidInputCorrections, unknownArgHint } from '@papercusp/tooldef/define-tool';
import tool from './await';

type ArgRedirect = string | { tool: string; args?: Record<string, unknown>; note?: string };

function declaredKeys(): string[] {
  const shape = (tool as unknown as { args: { shape: Record<string, unknown> } }).args.shape;
  return Object.keys(shape);
}

function argRedirects(): Record<string, ArgRedirect> {
  const guidance = (tool as unknown as { guidance?: { argRedirects?: Record<string, ArgRedirect> } }).guidance;
  return guidance?.argRedirects ?? {};
}

/**
 * PURE, so the assertion below can be run against a deliberately-wrong input as
 * well as the live one. A guard that has only ever been shown to PASS has not
 * been shown to work at all, and the repo's falsifiability rule for an imported
 * module is a permanent wrong-input control here in the test file — never a
 * mutation of the shared tree, which git-sync can commit mid-probe.
 */
export function shadowedRedirectKeys(
  declared: readonly string[],
  redirects: Record<string, ArgRedirect>,
): string[] {
  const declaredSet = new Set(declared);
  return Object.keys(redirects).filter((key) => declaredSet.has(key));
}

describe('events:await argRedirects', () => {
  it('reads the real declared schema (positive control)', () => {
    // Without this, every assertion below passes vacuously if the shape probe
    // ever returns [] — the empty-instrument failure that makes a broken guard
    // indistinguishable from a clean one.
    const keys = declaredKeys();
    expect(keys.length).toBeGreaterThan(5);
    expect(keys).toContain('event');
    expect(keys).toContain('timeout_sec');
  });

  it('declares redirects at all (positive control)', () => {
    expect(Object.keys(argRedirects()).length).toBeGreaterThan(0);
  });

  it('redirects a rejected `reason` key to the declared `note` field', () => {
    const redirect = argRedirects().reason;
    expect(redirect).toBe('note');

    const input = { event: 'resource:released:git-sync:papercusp', reason: 'wait for release' };
    const rejected = tool.args.safeParse(input);
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('reason must remain an unrecognized key');

    const corrections = invalidInputCorrections(
      rejected.error.issues,
      tool.args,
      tool.guidance?.argRedirects,
      input,
    );
    expect(corrections).toMatchObject([{ rejectedArg: 'reason', target: 'note', kind: 'authored-redirect' }]);

    const hint = unknownArgHint(
      rejected.error.issues,
      tool.args,
      tool.guidance?.argRedirects,
      input,
      'events:await',
    );
    expect(hint).toContain('note');
  });

  it('never redirects a key the schema actually declares', () => {
    // The historical failure mode: `after_generation` moved from rejected to
    // declared. A redirect naming a declared key can never fire, and until it
    // is noticed it tells the caller a valid argument is invalid.
    expect(shadowedRedirectKeys(declaredKeys(), argRedirects())).toEqual([]);
  });

  it('CONTROL: the shadowing check actually catches a shadowed key', () => {
    // The exact historical drift, replayed against the real declared schema:
    // `after_generation` was once invalid and is now declared, so a redirect
    // still naming it must be reported. If this control ever goes green while
    // asserting [], the detector has stopped detecting and every clean verdict
    // above is worthless.
    expect(
      shadowedRedirectKeys(declaredKeys(), { after_generation: 'event', policy: 'watch:create' }),
    ).toEqual(['after_generation']);
  });

  it('points every same-tool alias at a key that exists', () => {
    // The terse string form renders "pass it as `X` instead", so X must resolve.
    const declared = new Set(declaredKeys());
    const dangling = Object.entries(argRedirects())
      .filter(([, value]) => typeof value === 'string')
      .filter(([, value]) => !declared.has(value as string))
      .map(([key, value]) => `${key} -> ${String(value)}`);
    expect(dangling).toEqual([]);
  });

  it('routes cross-tool redirects to a named tool with a reason', () => {
    const malformed = Object.entries(argRedirects())
      .filter(([, value]) => typeof value !== 'string')
      .filter(([, value]) => {
        const redirect = value as Exclude<ArgRedirect, string>;
        return !redirect.tool || !redirect.note;
      })
      .map(([key]) => key);
    expect(malformed).toEqual([]);
  });

  it('keeps `after_generation` declared and `policy` absent', () => {
    // The two halves of the filed defect, pinned in opposite directions. If
    // `policy` ever becomes a real key, DELETE its redirect — the disjointness
    // test above will fail first and say so.
    const declared = new Set(declaredKeys());
    expect(declared.has('after_generation')).toBe(true);
    expect(declared.has('policy')).toBe(false);
    expect(argRedirects()).toHaveProperty('policy');
  });
});
