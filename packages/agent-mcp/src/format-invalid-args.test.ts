/**
 * Direct unit tests for `formatInvalidArgs` (server.ts) — the pure renderer
 * that turns Standard-Schema validation issues into the agent-facing
 * `invalid_args` message. No mocking needed: the function takes plain
 * issue/input data and returns a string, so these tests exercise it directly
 * rather than through the full `dispatch()` path (see server-dispatch.test.ts
 * for that; its own `too_big string` case is the precedent this mirrors).
 *
 * Kept mock-free deliberately: `server-dispatch.test.ts` mocks `standardValidate`
 * (a generic Standard-Schema function) via a bare `vi.fn()` module factory, which
 * cannot carry the real signature through `vi.mocked()` and forces every fixture
 * in that file through an `as never` escape — a file-wide baseline this repo's
 * `lint:mock-cast-escape` ratchet holds fixed (shrink-only). Testing the pure
 * renderer directly needs no such mock at all.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatInvalidArgs } from './server';

describe('formatInvalidArgs', () => {
  it('too_big number → reports the requested value and usable ceiling (EI-25689908429575401)', () => {
    const input = { byte_limit: 8192 };
    const parsed = z.object({ byte_limit: z.number().int().positive().max(4096) }).safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected byte_limit to exceed the 4096 ceiling');

    expect(formatInvalidArgs(parsed.error.issues, input)).toBe(
      'byte_limit: too big — 8192 over the 4096 limit; use ≤4096.',
    );
  });

  it('too_big number without a numeric actual value at the issue path → falls back to the bare ceiling message', () => {
    // Defensive: the raw input can lack the offending value at the issue's
    // path (undefined/non-number). The rendered message must stay well-formed
    // rather than compute a NaN/garbage delta.
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected number to be <=10',
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          path: ['threadLimit'],
        },
      ],
      {},
    );
    expect(message).toBe('threadLimit: too big — over the 10 limit; use ≤10.');
  });

  it('too_big number at exactly the maximum reads as "over" only when strictly greater', () => {
    // A too_big issue only fires when the value exceeds the max, so `over`
    // should never be reported as 0 or negative in practice — but guard the
    // arithmetic explicitly for a value equal to the maximum.
    const message = formatInvalidArgs(
      [{ message: 'Too big', code: 'too_big', origin: 'number', maximum: 10, path: ['n'] }],
      { n: 10 },
    );
    expect(message).toBe('n: too big — over the 10 limit; use ≤10.');
  });

  it('too_big string case is unaffected by the new number branch (regression guard)', () => {
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected string to have <=500 characters',
          code: 'too_big',
          origin: 'string',
          maximum: 500,
          path: ['goal'],
        },
      ],
      { goal: 'x'.repeat(912) },
    );
    expect(message).toBe('goal: too long — 412 chars over the 500-char limit; trim to 500.');
  });

  it('a non-too_big issue keeps its original path: message rendering', () => {
    const message = formatInvalidArgs([{ message: 'bad', path: ['x'] }], { x: 'no' });
    expect(message).toBe('x: bad');
  });

  it('multiple issues join with "; "', () => {
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected number to be <=10',
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          path: ['threadLimit'],
        },
        { message: 'required', path: ['id'] },
      ],
      { threadLimit: 25 },
    );
    expect(message).toBe('threadLimit: too big — 25 over the 10 limit; use ≤10.; id: required');
  });
});

describe('formatInvalidArgs — invalid_union branch selection', () => {
  it('preserves an explicit union-level message instead of replacing it with a branch issue', () => {
    const accepted = 'choose a string payload or an object payload';
    const schema = z.object({
      choice: z.union([
        z.object({ left: z.string() }),
        z.object({ right: z.number() }),
      ], { error: accepted }),
    });
    const r = schema.safeParse({ choice: { left: 42 } });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatInvalidArgs(r.error.issues, { choice: { left: 42 } })).toBe(`choice: ${accepted}`);
    }
  });

  it('chooses the closer facts-style branch on a depth tie (EI-21892816644875129)', () => {
    // This is the reported facts:assert shape: the first sibling branch has
    // unrelated federation requirements, while the later private-fact branch
    // has only the missing settledBy issue. Both locate a top-level field, so
    // depth alone incorrectly keeps the first branch.
    const message = formatInvalidArgs(
      [
        {
          message: 'Invalid input',
          code: 'invalid_union',
          path: [],
          errors: [
            [
              { message: 'Invalid input: expected true', path: ['shareable'] },
              { message: 'Required', path: ['settledBy'] },
            ],
            [{ message: 'Required', path: ['settledBy'] }],
          ],
        },
      ],
      { shareable: false, kind: 'conclusion' },
    );

    expect(message).toBe('settledBy: Required');
    expect(message).not.toContain('shareable');
  });

  it('counts unrecognized_keys at the depth of the key they identify', () => {
    const message = formatInvalidArgs(
      [
        {
          message: 'Invalid input',
          code: 'invalid_union',
          path: [],
          errors: [
            [
              { message: 'Required', path: ['harness'] },
              { message: 'Invalid input: expected true', path: ['shareable'] },
            ],
            [
              {
                message: 'Unrecognized key: "ttlDays"',
                code: 'unrecognized_keys',
                keys: ['ttlDays'],
                path: [],
              },
            ],
          ],
        },
      ],
      { ttlDays: 7 },
    );

    expect(message).toBe('Unrecognized key: "ttlDays"');
    expect(message).not.toContain('harness');
    expect(message).not.toContain('shareable');
  });
});
