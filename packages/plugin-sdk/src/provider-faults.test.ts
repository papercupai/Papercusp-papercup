import { describe, expect, it } from 'vitest';
import { PROVIDER_SYNC_ERROR_KINDS, providerSyncErrorOf } from './provider';
import {
  providerHeaderValue,
  providerSyncFault,
  rateLimitedFault,
  retryAfterSecondsOf,
} from './provider-faults';

const NOW = Date.parse('2026-10-21T06:00:00.000Z');

describe('providerSyncFault', () => {
  it('builds a fault the host reads back with the same kind and message, for every kind', () => {
    for (const kind of PROVIDER_SYNC_ERROR_KINDS) {
      const fault = providerSyncFault('bluesky', kind, 'request_failed');
      expect(fault).toBeInstanceOf(Error);
      expect(fault.message).toBe('bluesky:request_failed');
      expect(providerSyncErrorOf(fault)).toEqual({ kind, message: 'bluesky:request_failed' });
    }
  });

  it('carries a valid retryAfterSeconds through providerSyncErrorOf', () => {
    const fault = providerSyncFault('x', 'rate-limited', 'throttled', { retryAfterSeconds: 42 });
    expect(providerSyncErrorOf(fault)).toEqual({ kind: 'rate-limited', retryAfterSeconds: 42, message: 'x:throttled' });
  });

  it('drops a retryAfterSeconds that is not a finite non-negative number, or on another kind', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '30']) {
      const fault = providerSyncFault('x', 'rate-limited', 'throttled', { retryAfterSeconds: bad });
      expect('retryAfterSeconds' in fault).toBe(false);
      expect(providerSyncErrorOf(fault)).toEqual({ kind: 'rate-limited', message: 'x:throttled' });
    }
    const transient = providerSyncFault('x', 'transient', 'http_503', { retryAfterSeconds: 5 });
    expect('retryAfterSeconds' in transient).toBe(false);
  });

  it('keeps extra diagnostic fields but never lets them override kind or message', () => {
    const fault = providerSyncFault('reddit', 'auth', 'token_revoked', {
      kind: 'transient',
      message: 'spoofed',
      status: 401,
      detail: undefined,
    });
    expect(fault.kind).toBe('auth');
    expect(fault.message).toBe('reddit:token_revoked');
    expect(fault.status).toBe(401);
    expect('detail' in fault).toBe(false);
  });

  it('omits the prefix separator when no prefix is given', () => {
    expect(providerSyncFault('', 'transient', 'boom').message).toBe('boom');
  });

  it('refuses a kind the host does not recognise', () => {
    expect(() => providerSyncFault('x', 'fatal' as never, 'boom')).toThrow(TypeError);
  });
});

describe('providerHeaderValue', () => {
  it('matches names case-insensitively in plain objects and takes the first array value', () => {
    expect(providerHeaderValue({ 'Retry-After': '7' }, 'retry-after')).toBe('7');
    expect(providerHeaderValue({ 'retry-after': ['8', '9'] }, 'Retry-After')).toBe('8');
    expect(providerHeaderValue({ 'retry-after': 10 }, 'retry-after')).toBe('10');
    expect(providerHeaderValue({ other: '1' }, 'retry-after')).toBeUndefined();
    expect(providerHeaderValue(undefined, 'retry-after')).toBeUndefined();
  });

  it('reads a WHATWG Headers object', () => {
    const headers = new Headers({ 'Retry-After': '11' });
    expect(providerHeaderValue(headers, 'retry-after')).toBe('11');
    expect(providerHeaderValue(new Headers(), 'retry-after')).toBeUndefined();
  });
});

describe('retryAfterSecondsOf', () => {
  it('reads delta-seconds, rounding a fractional value up', () => {
    expect(retryAfterSecondsOf({ 'retry-after': '120' }, NOW)).toBe(120);
    expect(retryAfterSecondsOf({ 'retry-after': ' 1.2 ' }, NOW)).toBe(2);
    expect(retryAfterSecondsOf({ 'retry-after': '0' }, NOW)).toBe(0);
  });

  it('reads an HTTP-date relative to now, and a past date as 0', () => {
    expect(retryAfterSecondsOf({ 'retry-after': 'Wed, 21 Oct 2026 06:01:30 GMT' }, NOW)).toBe(90);
    expect(retryAfterSecondsOf({ 'retry-after': 'Wed, 21 Oct 2026 05:00:00 GMT' }, NOW)).toBe(0);
  });

  it('returns undefined for an absent, empty, negative or garbled header', () => {
    for (const value of [undefined, '', '   ', '-5', '1e3', 'soon', 'NaN', '12abc']) {
      expect(retryAfterSecondsOf(value === undefined ? {} : { 'retry-after': value }, NOW)).toBeUndefined();
    }
    expect(retryAfterSecondsOf(null, NOW)).toBeUndefined();
  });
});

describe('rateLimitedFault', () => {
  it('takes retryAfterSeconds from the response header', () => {
    const fault = rateLimitedFault('bluesky', 'throttled', { 'retry-after': '30' }, undefined, NOW);
    expect(providerSyncErrorOf(fault)).toEqual({ kind: 'rate-limited', retryAfterSeconds: 30, message: 'bluesky:throttled' });
  });

  it('lets an explicit retryAfterSeconds (an epoch-reset platform) win over the header', () => {
    const fault = rateLimitedFault('x', 'throttled', { 'retry-after': '30' }, { retryAfterSeconds: 900 }, NOW);
    expect(fault.retryAfterSeconds).toBe(900);
  });

  it('leaves retryAfterSeconds unset when nothing readable says how long to wait', () => {
    const fault = rateLimitedFault('devto', 'throttled', { 'retry-after': 'later' }, undefined, NOW);
    expect(providerSyncErrorOf(fault)).toEqual({ kind: 'rate-limited', message: 'devto:throttled' });
    expect(providerSyncErrorOf(rateLimitedFault('devto', 'throttled'))).toEqual({
      kind: 'rate-limited',
      message: 'devto:throttled',
    });
  });
});
