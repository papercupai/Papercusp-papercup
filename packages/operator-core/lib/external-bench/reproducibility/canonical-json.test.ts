/**
 * canonicalJson — deterministic key-sorted JSON (the precondition for a stable
 * content hash; a third party recomputes prereg_hash from the published config).
 * Pure, no I/O. Added in the test-coverage audit (was an untested gap).
 */
import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json';

describe('canonicalJson — deterministic (key-sorted) JSON', () => {
  it('serializes equal objects identically regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const z = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(z);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts keys recursively in nested objects', () => {
    expect(canonicalJson({ outer: { y: 1, x: 2 }, alpha: 0 })).toBe(
      '{"alpha":0,"outer":{"x":2,"y":1}}',
    );
  });

  it('preserves parsed own prototype-looking keys at every depth without digest collisions', () => {
    const first = JSON.parse('{"safe":1,"__proto__":{"value":"one"},"constructor":{"prototype":2}}');
    const different = JSON.parse('{"safe":1,"__proto__":{"value":"two"},"constructor":{"prototype":2}}');
    const reordered = JSON.parse('{"constructor":{"prototype":2},"__proto__":{"value":"one"},"safe":1}');
    expect(canonicalJson(first)).not.toBe(canonicalJson(different));
    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(JSON.parse(canonicalJson(first))).toEqual(first);
    const nested = { objects: [first], outer: { nested: first } };
    expect(JSON.parse(canonicalJson(nested))).toEqual(nested);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'value')).toBe(false);
  });

  it('preserves array order (order is semantic for task/seed lists)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('sorts keys of objects inside an array but keeps the array order', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { d: 4, c: 3 }])).toBe(
      '[{"a":2,"b":1},{"c":3,"d":4}]',
    );
  });

  it('drops undefined object members but preserves null', () => {
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it('maps undefined array members to null (JSON array semantics) while keeping order', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('passes primitives through', () => {
    expect(canonicalJson(5)).toBe('5');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });
});
