import { describe, expect, it } from 'vitest';
import { describeError, errorFields, type ErrorFields } from './error-detail.js';
import { WORKER_SOURCE_FOR_TEST } from './worker-transport.js';

/** What Node raises when a connect fails on every address of a multi-address host: an EMPTY message. */
function happyEyeballsFailure(): Error {
  const v4 = Object.assign(new Error('connect ECONNREFUSED 104.18.24.46:443'), { code: 'ECONNREFUSED' });
  const v6 = Object.assign(new Error('connect ENETUNREACH 2606:4700::6812:182e:443'), { code: 'ENETUNREACH' });
  return Object.assign(new AggregateError([v4, v6], ''), { code: 'ECONNREFUSED' });
}

/** The errorFields() copy the worker thread evaluates, extracted from its source. */
function workerErrorFields(): (err: unknown) => ErrorFields {
  const start = WORKER_SOURCE_FOR_TEST.indexOf('function errorFields(err, depth) {');
  const end = WORKER_SOURCE_FOR_TEST.indexOf('\n}\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const source = WORKER_SOURCE_FOR_TEST.slice(start, end + 2);
  return new Function(`${source}\nreturn errorFields;`)() as (err: unknown) => ErrorFields;
}

const CASES: Array<[string, () => unknown]> = [
  ['an AggregateError with an empty message', happyEyeballsFailure],
  ['a TypeError whose cause holds the reason', () => new TypeError('fetch failed', { cause: happyEyeballsFailure() })],
  ['an Error with an empty message and no code', () => new Error('')],
  ['an Error with a numeric code', () => Object.assign(new Error('boom'), { code: 42 })],
  ['a thrown string', () => 'socket gone'],
  ['undefined', () => undefined],
  ['null', () => null],
];

describe('describeError (WI-10005372: a network-error detail is never empty)', () => {
  it('names the code and every per-address failure of an AggregateError whose message is empty', () => {
    const detail = describeError(happyEyeballsFailure());
    expect(detail).toBe(
      'AggregateError [ECONNREFUSED] (Error [ECONNREFUSED]: connect ECONNREFUSED 104.18.24.46:443; ' +
        'Error [ENETUNREACH]: connect ENETUNREACH 2606:4700::6812:182e:443)',
    );
  });

  it('positive control: the message alone, which the ledger used to store, is empty for that failure', () => {
    expect(happyEyeballsFailure().message).toBe('');
  });

  it('follows the cause of an undici-style "fetch failed"', () => {
    const detail = describeError(new TypeError('fetch failed', { cause: happyEyeballsFailure() }));
    expect(detail).toMatch(/^TypeError: fetch failed; cause: AggregateError \[ECONNREFUSED\] \(/);
  });

  it.each(CASES)('is never empty for %s', (_label, make) => {
    const detail = describeError(make());
    expect(detail.trim()).not.toBe('');
  });

  it('says "(no message)" instead of a bare class name when nothing else is known', () => {
    expect(describeError(new Error(''))).toBe('Error (no message)');
    expect(describeError(undefined)).toBe('Error (no message)');
  });

  it('renders posted fields exactly as it renders the error they were copied from', () => {
    const err = happyEyeballsFailure();
    expect(describeError(errorFields(err))).toBe(describeError(err));
  });

  it('bounds the nesting depth of a self-referencing cause chain', () => {
    const loop = new Error('outer') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(describeError(loop).split('cause:').length - 1).toBe(3);
  });
});

describe("the worker thread's errorFields copy matches error-detail.ts", () => {
  const workerCopy = workerErrorFields();
  it.each(CASES)('for %s', (_label, make) => {
    expect(workerCopy(make())).toEqual(errorFields(make()));
  });
});
