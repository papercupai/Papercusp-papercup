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
import { decodeHlc, encodeHlc } from '@papercusp/locks-core';
import { stampOpHlc } from '../hlc-stamp';
import { buildHarnessProjections, REGISTERED_PROJECTION_TAGS } from '../projections/register-all';
import { createMergeCursor, mergeAdmittedLogs, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

afterEach(() => _clearRegistryForTests());

function projection() {
  const written: unknown[] = [];
  const p = {
    tableTag: 'p532-independent',
    composeKey: (row: unknown) => (row as { key: string }).key,
    decodeValue: (raw: unknown) => raw as { key: string; value: number },
    writeToPg: async (row: unknown) => {
      written.push(row);
    },
    deleteFromPg: async () => {},
  } as unknown as TableProjection<unknown>; // Deliberately invalid until a rule is supplied.
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

  it('refuses an unknown merge rule instead of silently defaulting to LWW', () => {
    const { p } = projection();
    const invalid = { ...p, mergeRule: 'not-a-rule' } as unknown as TableProjection<unknown>;
    expect(() => registerProjection(invalid)).toThrow(/merge.*rule|rule.*merge/i);
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

  it.each(['', 'not-an-hlc', '123', 'ffffffffffffffffffffffffffffffff'])('refuses malformed remote HLC %j before data writes', async (hlc) => {
    const { p, written } = projection();
    expect(await applyOpVia(() => ({ ...p, mergeRule: 'lww' as const }), op(hlc), { ownLogKeyHex: 'own-log' })).toBe(false);
    expect(written).toEqual([]);
  });

  it('the producer refuses or repairs a malformed preset clock instead of propagating it', () => {
    try {
      const stamped = stampOpHlc({ ts: 9_000, hlc: 'malformed-preset' });
      expect(stamped.hlc).toBe(encodeHlc(decodeHlc(stamped.hlc)));
      expect(decodeHlc(stamped.hlc).ms).toBeGreaterThan(0);
    } catch (error) {
      // Only an explicit input refusal is an admissible producer outcome.
      if (error instanceof Error && error.name === 'AssertionError') throw error;
      expect(String(error)).toMatch(/invalid|malformed|hlc|clock/i);
    }
  });

  it('the complete production projection census equals its declared registry and has a rule per table', () => {
    const built = buildHarnessProjections({ workspaceId: 'p532-prospective', harnessSlug: 'p532-prospective' });
    expect(built.map(p => p.tableTag).sort()).toEqual([...REGISTERED_PROJECTION_TAGS].sort());
    for (const p of built) {
      const rule = Reflect.get(p, 'mergeRule');
      expect(rule, `missing declared merge rule for ${p.tableTag}`).toBeDefined();
      expect(['lww', 'append-only', 'set-union', 'counter']).toContain(rule);
    }
  });

  it.each(['full', 'incremental'] as const)('%s fold converges to the causal LWW winner in both arrival orders', async (fold) => {
    const { p } = projection();
    const declared = { ...p, mergeRule: 'lww' as const };
    registerProjection(declared);
    const makeLog = (keyHex: string, value: number, ms: number, ts: number): AdmittedLog => {
      const row: PeerLogOp = { type: 'put', table: p.tableTag, hbKey: 'row', value: { key: 'row', value },
        ts, hlc: encodeHlc({ ms, count: 0 }), schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: keyHex };
      return { keyHex, length: 1, get: async () => row };
    };
    const a = makeLog('a'.repeat(64), 1, 1000, 99_000);
    const b = makeLog('b'.repeat(64), 2, 2000, 1);
    for (const logs of [[a, b], [b, a]]) {
      let state: unknown;
      const applyImpl = async (row: OpEnvelope) => { state = row.value; return true; };
      if (fold === 'full') await mergeAdmittedLogs(logs, { applyImpl, getTimeoutMs: 0 });
      else {
        const cursor = createMergeCursor();
        for (let pass = 0; pass < 4; pass++) {
          const result = await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl, getTimeoutMs: 0, maxOpsPerPass: 1 });
          if (result.caughtUp) break;
        }
      }
      expect(state).toEqual({ key: 'row', value: 2 });
    }
  });

  it.each(['append-only', 'set-union', 'counter'] as const)('%s contributions survive both fold paths and opposing arrivals without replay inflation', async (mergeRule) => {
    const { p } = projection();
    const declared = { ...p, mergeRule };
    registerProjection(declared);
    const contribution = (author: string, event: string, value: number, ms: number): PeerLogOp => ({
      type: 'put', table: p.tableTag, hbKey: 'shared-key', value: { event, elements: [author], amount: value },
      ts: ms === 1000 ? 99_000 : 1, hlc: encodeHlc({ ms, count: 0 }),
      schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: author,
    });
    const rowA = contribution('a'.repeat(64), 'same-seq', 2, 1000);
    const rowB = contribution('b'.repeat(64), 'same-seq', 3, 2000);
    const log = (row: PeerLogOp): AdmittedLog => ({ keyHex: row.author_pubkey, length: 1, get: async () => row });
    const a = log(rowA), b = log(rowB);
    for (const fold of ['full', 'incremental'] as const) for (const logs of [[a, b], [b, a]]) {
      // Model only the table writer's documented event/component idempotence.
      // The production fold must deliver BOTH authenticated contributions.
      const persisted = new Map<string, { amount: number; elements: string[] }>();
      const applyImpl = async (row: OpEnvelope) => {
        const value = row.value as { event: string; amount: number; elements: string[] };
        persisted.set(`${row.sourceLogKeyHex}:${value.event}`, value);
        return true;
      };
      const opts = { applyImpl, getTimeoutMs: 0, projectionLookup: () => declared };
      const cursor = createMergeCursor();
      for (let replay = 0; replay < 2; replay++) {
        if (fold === 'full') await mergeAdmittedLogs(logs, opts);
        else for (let pass = 0; pass < 4; pass++) {
          const result = await mergeAdmittedLogsIncremental(logs, cursor, { ...opts, maxOpsPerPass: 1 });
          if (result.caughtUp) break;
        }
      }
      expect(persisted.size, `${mergeRule}/${fold}`).toBe(2);
      expect([...new Set([...persisted.values()].flatMap(value => value.elements))].sort()).toEqual([rowA.author_pubkey, rowB.author_pubkey]);
      expect([...persisted.values()].reduce((sum, value) => sum + value.amount, 0)).toBe(5);
    }
  });

  it('append-only rejects a causal tombstone at the maintained apply boundary', async () => {
    const { p } = projection();
    let deleted = 0;
    const declared = { ...p, mergeRule: 'append-only' as const, deleteFromPg: async () => { deleted += 1; } };
    const tombstone: OpEnvelope = { type: 'del', table: p.tableTag, hbKey: 'immutable-event',
      ts: 1000, hlc: encodeHlc({ ms: 1000, count: 0 }), sourceLogKeyHex: 'remote-log' };
    expect(await applyOpVia(() => declared, tombstone, { ownLogKeyHex: 'own-log' })).toBe(false);
    expect(deleted).toBe(0);
  });
});
