/**
 * Property-based round-trip invariants for `tryParseJson` (gym/parse-json.ts).
 *
 * The unit test pins specific wrappings; these properties assert the core
 * contract over arbitrary JSON-serializable *objects*: however the object's
 * JSON is presented — bare, ```json-fenced, or embedded in brace-free prose —
 * parsing recovers the original object (`toEqual` after a JSON round-trip).
 *
 * Why objects specifically (not arbitrary JSON values): the `{`…`}`
 * slice-fallback branch keys on the first `{` / last `}`, so the prose-wrapping
 * invariant only holds for values whose serialization is brace-delimited (an
 * object). The bare + fenced branches are value-agnostic and are also checked.
 *
 * Wrapping prose is drawn from a brace-free AND quote-free alphabet so it can
 * never corrupt the recovery: a stray `{`/`}` corrupts the slice span, and a
 * quote PAIR around the payload turns the whole reply into a *valid JSON
 * string* (`" {} "` IS the JSON string " {} "), where "recover the object"
 * and "a bare string round-trips" are mutually undecidable — the parser's
 * documented precedence is whole-document validity first. Both are adversarial
 * prose, genuinely unrecoverable and out of scope for round-trip. (The quote
 * case was found by fast-check as seed 1619552845's counterexample
 * [{}, '"', '"'] — see eval-battery/src/parse-json.test.ts for the pinned
 * precedence.)
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tryParseJson } from './parse-json';

// Arbitrary JSON-serializable OBJECT. Keys/values use fc.jsonValue so nested
// arrays/objects/strings/numbers/bools/null all appear. A normalized JSON
// round-trip (parse(stringify(x))) is the canonical form we compare against —
// it collapses any -0 / key-order quirks so the comparison is well-defined.
const jsonObject = fc
  .dictionary(fc.string(), fc.jsonValue())
  .map((o) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>);

// Any JSON value (objects, arrays, primitives) for the branches that don't
// depend on brace-slicing.
const anyJsonValue = fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)));

// Inert prose: brace-free (no fake slice spans), quote-free (a quote pair
// around the payload would make the WHOLE reply a valid JSON string — the
// undecidable class described in the header) AND bracket-free (a bracket pair
// makes the whole reply a valid JSON ARRAY: `[ {} ]` IS the array [{}], so
// whole-document precedence correctly returns the array, not the object —
// fast-check seed -712458106, counterexample [{}, '[', ']'], green-checkpoint
// run 762a13a6 at 382606c4). Strings and arrays are the only JSON containers
// that can enclose an object, so excluding both delimiters closes the class.
const braceFreeProse = fc
  .string()
  .map((s) => s.replace(/[{}"[\]]/g, ''));

describe('tryParseJson — round-trip properties', () => {
  it('recovers any JSON value from its bare serialization', () => {
    fc.assert(
      fc.property(anyJsonValue, (value) => {
        expect(tryParseJson(JSON.stringify(value))).toEqual(value);
      }),
      { numRuns: 300 },
    );
  });

  it('recovers any JSON value from a ```json-fenced serialization', () => {
    fc.assert(
      fc.property(anyJsonValue, (value) => {
        const wrapped = '```json\n' + JSON.stringify(value) + '\n```';
        expect(tryParseJson(wrapped)).toEqual(value);
      }),
      { numRuns: 300 },
    );
  });

  it('recovers any JSON value from a bare (no-lang) fence', () => {
    fc.assert(
      fc.property(anyJsonValue, (value) => {
        const wrapped = '```\n' + JSON.stringify(value) + '\n```';
        expect(tryParseJson(wrapped)).toEqual(value);
      }),
      { numRuns: 200 },
    );
  });

  it('recovers an OBJECT from brace-free prose wrapping (slice fallback)', () => {
    fc.assert(
      fc.property(jsonObject, braceFreeProse, braceFreeProse, (obj, before, after) => {
        const wrapped = `${before} ${JSON.stringify(obj)} ${after}`;
        expect(tryParseJson(wrapped)).toEqual(obj);
      }),
      { numRuns: 300 },
    );
  });

  it('recovers an OBJECT from a non-anchored fence inside prose (slice fallback)', () => {
    fc.assert(
      fc.property(jsonObject, braceFreeProse, (obj, prefix) => {
        // Prefix prose means the fence is no longer at string-start, so the
        // anchored fence regex misses and the slice branch must do the work.
        const wrapped = `${prefix}\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
        expect(tryParseJson(wrapped)).toEqual(obj);
      }),
      { numRuns: 200 },
    );
  });
});
