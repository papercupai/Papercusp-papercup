import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeFatalPgError } from './fatal-diagnostics';

describe('fatal postgres attribution', () => {
  it('identifies hidden driver SQL without exposing its literals or parameters', () => {
    const query = "SELECT * FROM harness_shared.work_items WHERE secret = 'private-literal' AND id = $1";
    const error = Object.assign(new Error('write CONNECTION_DESTROYED localhost:5432'), {
      code: 'CONNECTION_DESTROYED',
    });
    Object.defineProperties(error, {
      query: { value: query },
      parameters: { value: ['private-parameter'] },
    });
    const result = describeFatalPgError(error);
    expect(result).toEqual({
      code: 'CONNECTION_DESTROYED',
      queryAvailable: true,
      queryHash: createHash('sha256').update(query).digest('hex'),
      queryFamily: 'select:harness_shared.work_items',
    });
    expect(JSON.stringify(result)).not.toMatch(/private-literal|private-parameter|WHERE/);
  });

  it('distinguishes missing query evidence from a query with no caller stack', () => {
    expect(describeFatalPgError({ code: 'CONNECTION_DESTROYED' })).toEqual({
      code: 'CONNECTION_DESTROYED', queryAvailable: false,
    });
    expect(describeFatalPgError({ code: 'CONNECTION_DESTROYED', query: 'select 1' })?.queryAvailable).toBe(true);
  });

  it('never invokes error getters while a host is already failing', () => {
    const error = { code: 'CONNECTION_DESTROYED', get query(): string { throw new Error('getter ran'); } };
    expect(describeFatalPgError(error)).toEqual({ code: 'CONNECTION_DESTROYED', queryAvailable: false });
    expect(describeFatalPgError(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('proxy ran'); } }))).toBeNull();
  });

  it('does not reinterpret arbitrary errors as postgres failures', () => {
    for (const error of [null, 'CONNECTION_DESTROYED', new Error('other'), { code: 'EPIPE' }]) {
      expect(describeFatalPgError(error)).toBeNull();
    }
  });

  it('hashes oversized queries while bounding SQL classification', () => {
    const query = 'select ' + 'x'.repeat(70_000);
    expect(describeFatalPgError({ code: 'CONNECTION_ENDED', query })).toEqual({
      code: 'CONNECTION_ENDED', queryAvailable: true,
      queryHash: createHash('sha256').update(query).digest('hex'), queryFamily: 'oversized',
    });
  });
});
