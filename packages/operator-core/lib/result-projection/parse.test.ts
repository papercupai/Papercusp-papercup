/**
 * parse.ts — the fail-CLOSED half of the projection stage.
 *
 * The load-bearing case is the POSIX bracket expression: it compiles as a JS
 * RegExp, returns rows, and every row is wrong. A test that only checked "bad
 * input is rejected" would pass with that guard deleted, so it is asserted by
 * name here.
 */

import { describe, expect, it } from 'vitest';
import { MAX_PICK_PATHS, MAX_PIPELINE_STAGES, describeProjection, parseProjection } from './parse';

describe('parseProjection', () => {
  it('absent projection is not an error — it is the common path', () => {
    expect(parseProjection(undefined)).toEqual({ ok: true, spec: null });
    expect(parseProjection(null)).toEqual({ ok: true, spec: null });
  });

  it('rejects a non-object, and a spec with neither pick nor pipe', () => {
    expect(parseProjection('grep foo')).toMatchObject({ ok: false });
    expect(parseProjection({})).toMatchObject({ ok: false, error: expect.stringContaining('at least one') });
  });

  it('explains how to recover from an empty pipe without weakening fail-closed validation', () => {
    expect(parseProjection({ pipe: [] })).toEqual({
      ok: false,
      error:
        'projection.pipe must be a non-empty array of stages; provide one or omit `pipe` ' +
        '(or omit `projection` if no selector remains).',
    });
  });

  // `projection` is reserved at the dispatch layer and therefore absent from every
  // tool's advertised inputSchema. A client that types its args from that schema
  // (Claude Code) has no type for it and sends a STRING — so refusing strings made
  // the knob unreachable from that client entirely, while the result-door footer
  // went on advertising it. Measured 2026-08-02: object form applied, identical
  // spec as a string refused. These assert the string is held to the SAME rules.
  describe('JSON-string form (a schema-driven client cannot type an undeclared arg)', () => {
    it('accepts a JSON-encoded spec and yields the SAME spec as the object form', () => {
      const obj = { pick: ['results[].id'] };
      expect(parseProjection(JSON.stringify(obj))).toEqual(parseProjection(obj));

      const piped = { pipe: [{ op: 'head', n: 20 }] };
      expect(parseProjection(JSON.stringify(piped))).toEqual(parseProjection(piped));
    });

    it('a JSON string is NOT a bypass — it gets the same validation as an object', () => {
      // The POSIX guard is the load-bearing one: it must survive the string path,
      // or the coercion would become a hole around the single check that exists
      // because its failure is INVISIBLE in the output.
      expect(parseProjection(JSON.stringify({ pipe: [{ op: 'grep', pattern: '[[:digit:]]' }] }))).toMatchObject({
        ok: false,
      });
      expect(parseProjection(JSON.stringify({}))).toMatchObject({ ok: false });
      expect(parseProjection(JSON.stringify({ pipe: [{ op: 'nope' }] }))).toMatchObject({ ok: false });
    });

    it('a string that is not JSON fails closed, and says so specifically', () => {
      const r = parseProjection('{not json');
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
    });

    it('an empty string is treated as absent, not as a malformed spec', () => {
      expect(parseProjection('')).toEqual({ ok: true, spec: null });
      expect(parseProjection('   ')).toEqual({ ok: true, spec: null });
    });

    it('a JSON string encoding a non-object is still rejected', () => {
      expect(parseProjection('42')).toMatchObject({ ok: false });
      expect(parseProjection('[1,2]')).toMatchObject({ ok: false });
      expect(parseProjection('"nested"')).toMatchObject({ ok: false });
    });
  });

  describe('grep', () => {
    it('accepts a plain regex and records nothing extra', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: 'err(or)?' }] });
      expect(r).toEqual({ ok: true, spec: { pipe: [{ op: 'grep', pattern: 'err(or)?' }] } });
    });

    it('REFUSES a POSIX bracket expression — it is valid JS with a different meaning', () => {
      // [[:digit:]] in JS is a character class of [ : d i g t. It matches, and
      // every row it returns is wrong — the one divergence that must be refused
      // rather than reported, because it is invisible in the output.
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '^[[:digit:]]+ ' }] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toContain('POSIX');
      expect(r.error).toContain('fixed:true');
    });

    it('catches a POSIX class nested inside a compound bracket expression', () => {
      expect(parseProjection({ pipe: [{ op: 'grep', pattern: '[[:digit:][:alpha:]]' }] }).ok).toBe(false);
    });

    it('allows a POSIX-looking pattern when fixed:true — a literal has no flavor', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '[[:digit:]]', fixed: true }] });
      expect(r).toMatchObject({ ok: true });
    });

    it('rejects a pattern that is not a valid JS RegExp, and points at fixed:true', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '(unclosed' }] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toContain('fixed:true');
    });

    it('explains ignoreCase:true when inline PCRE flags are rejected', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '(?i)error' }] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toContain('JavaScript RegExp');
      expect(r.error).toContain('ignoreCase:true');
    });

    it('grep -C expands to both sides, but an explicit -A/-B wins', () => {
      const both = parseProjection({ pipe: [{ op: 'grep', pattern: 'x', context: 3 }] });
      expect(both).toMatchObject({ ok: true, spec: { pipe: [{ before: 3, after: 3 }] } });
      const override = parseProjection({ pipe: [{ op: 'grep', pattern: 'x', context: 3, after: 1 }] });
      expect(override).toMatchObject({ ok: true, spec: { pipe: [{ before: 3, after: 1 }] } });
    });

    it('rejects a negative context width', () => {
      expect(parseProjection({ pipe: [{ op: 'grep', pattern: 'x', after: -1 }] }).ok).toBe(false);
    });
  });

  it('head/tail require a non-negative integer', () => {
    expect(parseProjection({ pipe: [{ op: 'head', n: 20 }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'head', n: 0 }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'head', n: -5 }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'tail', n: 1.5 }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'tail' }] }).ok).toBe(false);
  });

  it('cut fields are 1-indexed and must be present', () => {
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [1, 3] }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [0] }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [] }] }).ok).toBe(false);
  });

  it('rejects an unknown operator by name, listing the closed set', () => {
    const r = parseProjection({ pipe: [{ op: 'awk', pattern: 'x' }] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('grep');
  });

  it('bounds the pipeline and the pick list, including the JSON-string form', () => {
    const long = Array.from({ length: MAX_PIPELINE_STAGES + 1 }, () => ({ op: 'head', n: 1 }));
    expect(parseProjection({ pipe: long }).ok).toBe(false);
    const atLimit = Array.from({ length: MAX_PICK_PATHS }, (_, i) => `a${i}`);
    expect(parseProjection({ pick: atLimit })).toEqual({ ok: true, spec: { pick: atLimit } });
    const many = Array.from({ length: MAX_PICK_PATHS + 1 }, (_, i) => `a${i}`);
    const rejected = parseProjection({ pick: many });
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining(`projection.pick accepts at most ${MAX_PICK_PATHS} paths`),
    });
    // A schema-driven client may send the reserved projection as JSON text;
    // that form must not bypass the same cap.
    expect(parseProjection(JSON.stringify({ pick: many }))).toEqual(rejected);
  });

  it('pick entries must be non-empty strings and are trimmed', () => {
    expect(parseProjection({ pick: ['  results[].id  '] })).toEqual({
      ok: true,
      spec: { pick: ['results[].id'] },
    });
    expect(parseProjection({ pick: [''] }).ok).toBe(false);
    expect(parseProjection({ pick: [42] }).ok).toBe(false);
  });
});

describe('describeProjection — the reproducible echo D-041 requires', () => {
  it('renders the pipeline as the shell command it stands in for', () => {
    expect(
      describeProjection({
        pipe: [
          { op: 'grep', pattern: 'error', fixed: true, ignoreCase: true },
          { op: 'sort', unique: true },
          { op: 'head', n: 20 },
        ],
      }),
    ).toBe('grep -F -i "error" | sort -u | head -20');
  });

  it('renders symmetric context as -C and asymmetric as -B/-A', () => {
    expect(describeProjection({ pipe: [{ op: 'grep', pattern: 'x', before: 2, after: 2 }] })).toBe(
      'grep -C2 "x"',
    );
    expect(describeProjection({ pipe: [{ op: 'grep', pattern: 'x', before: 1, after: 4 }] })).toBe(
      'grep -B1 -A4 "x"',
    );
  });

  it('renders pick and count', () => {
    expect(describeProjection({ pick: ['results[].id'], pipe: [{ op: 'count' }] })).toBe(
      'pick results[].id | wc -l',
    );
  });
});
