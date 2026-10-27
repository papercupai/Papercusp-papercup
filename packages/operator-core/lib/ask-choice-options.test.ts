/**
 * WI-5175 — ask_choice option coercion.
 *
 * Owner repro 2026-07-17: clicking a card option produced
 *   `turn-answer failed: ((intermediate value) ?? []).map is not a function`
 * because the model stringified `options` and the server's
 * `(args?.options ?? []).map(...)` assumed an array — `??` only catches
 * null/undefined, so a STRING reached `.map`.
 *
 * These lock the coercion contract shared by BOTH readers (the card render
 * path and the turn-answer answer path), which is the point: they used to
 * disagree, so the card rendered and then 500'd on click.
 */
import { describe, expect, it } from 'vitest';
import { askChoiceOptionIds, coerceAskChoiceOptions, canonicalAskChoiceInput,
  normalizeParsedChoiceArgs, askChoiceArgsSchema } from './ask-choice-options';

describe('P010 canonical native ask-choice arguments', () => {
  it('uses the same canonical form for raw native input and already parsed dispatch args', () => {
    const raw = { question: 'Choose', options: '[{"id":"YES","label":"Proceed","ignored":true}]', ignored: true };
    const parsed = askChoiceArgsSchema.parse(raw);
    expect(canonicalAskChoiceInput(raw)).toEqual({ question: 'Choose', options: [{ id: 'yes', label: 'Proceed' }] });
    expect(normalizeParsedChoiceArgs(parsed)).toEqual(canonicalAskChoiceInput(raw));
    expect(raw.options).toBeTypeOf('string');
    expect(parsed.options).toEqual([{ id: 'YES', label: 'Proceed' }]);
  });
  it.each([null, {}, { question: 'Choose', options: 'invalid' },
    { question: 'Choose', options: [{ id: '!', label: 'invalid' }] },
  ])('refuses invalid raw args without guessing a normalized payload: %j', raw => {
    expect(canonicalAskChoiceInput(raw)).toBeNull();
  });
});

describe('coerceAskChoiceOptions', () => {
  it('passes a real array straight through', () => {
    const arr = [{ id: 'a', label: 'A' }];
    expect(coerceAskChoiceOptions(arr)).toBe(arr);
  });

  it('parses a stringified array — the exact WI-5175 payload shape', () => {
    const raw = JSON.stringify([{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]);
    const out = coerceAskChoiceOptions(raw);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect((out![0] as { id: string }).id).toBe('one');
  });

  it('returns null for a non-JSON string rather than throwing', () => {
    expect(coerceAskChoiceOptions('not json at all')).toBeNull();
  });

  it('returns null for a JSON string that does not encode an array', () => {
    expect(coerceAskChoiceOptions('{"id":"a"}')).toBeNull();
  });

  it('returns null for nullish / wrong-typed payloads', () => {
    expect(coerceAskChoiceOptions(undefined)).toBeNull();
    expect(coerceAskChoiceOptions(null)).toBeNull();
    expect(coerceAskChoiceOptions(42)).toBeNull();
    expect(coerceAskChoiceOptions({ id: 'a' })).toBeNull();
  });

  it('never throws on a hostile payload (render + click paths must not explode)', () => {
    const hostile: unknown[] = [Symbol('x'), () => {}, new Map(), '[[[', '{"a":'];
    for (const h of hostile) {
      expect(() => coerceAskChoiceOptions(h)).not.toThrow();
    }
  });
});

describe('askChoiceOptionIds', () => {
  it('extracts ids from an array payload', () => {
    expect(askChoiceOptionIds([{ id: 'a' }, { id: 'b' }])).toEqual(new Set(['a', 'b']));
  });

  it('extracts ids from a STRINGIFIED payload — the regression that 500ed the click', () => {
    const raw = JSON.stringify([{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]);
    expect(askChoiceOptionIds(raw)).toEqual(new Set(['one', 'two']));
  });

  it('skips options with a missing or non-string id', () => {
    expect(askChoiceOptionIds([{ id: 'a' }, {}, { id: 5 }, { id: '' }])).toEqual(new Set(['a']));
  });

  it('yields an EMPTY set for an uncoercible payload — callers skip validation, never reject', () => {
    // turn-answer only validates when knownIds.size > 0. An empty set therefore
    // means "cannot validate", so a legitimate pick is still accepted. Rejecting
    // it because the model stringified its own payload would be the same defect
    // wearing a different hat.
    expect(askChoiceOptionIds('garbage').size).toBe(0);
    expect(askChoiceOptionIds(undefined).size).toBe(0);
  });

  it('does not throw on a hostile payload', () => {
    expect(() => askChoiceOptionIds([null, undefined, 'x'])).not.toThrow();
  });
});
