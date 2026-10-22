/** Independent prospective P532 acceptance, WI-6554700010020476. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  _clearRegistryForTests,
  applyOpVia,
  getProjection,
  lwwPick,
  registerProjection,
  type TableProjection,
} from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import { encodeHlc } from '@papercusp/locks-core';

afterEach(() => _clearRegistryForTests());

function projection() {
  const written: unknown[] = [];
  const p: TableProjection<{ key: string; value: number }> = {
    tableTag: 'p532-independent',
    composeKey: (row) => row.key,
    decodeValue: (raw) => raw as { key: string; value: number },
    writeToPg: async (row) => {
      written.push(row);
    },
    deleteFromPg: async () => {},
  };
  return { p, written };
}
function op(hlc?: string): OpEnvelope {
  return {
    type: 'put',
    table: 'p532-independent',
    hbKey: 'row',
    value: { key: 'row', value: 7 },
    ts: 9_000,
    writerPubkey: 'remote',
    sourceLogKeyHex: 'remote-log',
    ...(hlc ? { hlc } : {}),
  };
}

describe('P532 prospective declared merge and mandatory causal clock', () => {
  it('refuses registration of a replicated table with no declared merge rule', () => {
    const { p } = projection();
    expect(() => registerProjection(p)).toThrow(/merge.*rule|rule.*merge/i);
    expect(getProjection(p.tableTag)).toBeNull();
  });

  it('refuses a remote table operation without HLC before writing data', async () => {
    const { p, written } = projection();
    const declared = { ...p, mergeRule: 'lww' as const };
    const applied = await applyOpVia(() => declared, op(), { ownLogKeyHex: 'own-log' });
    expect(applied).toBe(false);
    expect(written).toEqual([]);
  });

  it('a declared LWW table accepts an operation carrying its causal clock', async () => {
    const { p, written } = projection();
    const declared = { ...p, mergeRule: 'lww' as const };
    registerProjection(declared);
    const applied = await applyOpVia(getProjection, op(encodeHlc({ ms: 2_000, count: 0 })), {
      ownLogKeyHex: 'own-log',
    });
    expect(applied).toBe(true);
    expect(written).toEqual([{ key: 'row', value: 7 }]);
  });

  it('the causal winner is independent of arrival order and contrary wall-clock order', () => {
    const early = { ...op(encodeHlc({ ms: 1_000, count: 0 })), ts: 99_000, value: { key: 'row', value: 1 } };
    const late = { ...op(encodeHlc({ ms: 2_000, count: 0 })), ts: 1, value: { key: 'row', value: 2 } };
    expect(lwwPick(early, late)).toEqual(late);
    expect(lwwPick(late, early)).toEqual(late);
  });
});
