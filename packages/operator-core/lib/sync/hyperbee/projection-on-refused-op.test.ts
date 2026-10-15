/**
 * applyOpVia × onRefusedOp (F1-4 / P-012, federated-scout-gym) — the dispatch
 * wiring: when decodeValue returns null (a DECLINED op), applyOpVia invokes the
 * projection's optional onRefusedOp with the raw value + the SAME resolved
 * provenance the put path sees, and is FAIL-SOFT if the hook throws. A decode
 * SUCCESS never fires it; a projection without the hook still drops cleanly.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyOpVia, type TableProjection, type ProvenanceContext } from './projection';
import type { OpEnvelope } from './op-envelope-types';

interface Row {
  ok: true;
}

/** A projection whose decodeValue returns null unless the raw carries `{good:true}`. */
function proj(over: Partial<TableProjection<Row>> = {}): TableProjection<Row> {
  return {
    tableTag: 'test-tag',
    composeKey: () => 'k',
    decodeValue: (raw) => (raw && typeof raw === 'object' && (raw as Record<string, unknown>).good === true ? { ok: true } : null),
    writeToPg: async () => {},
    deleteFromPg: async () => {},
    ...over,
  };
}

const remotePut = (value: unknown): OpEnvelope => ({
  type: 'put',
  table: 'test-tag',
  hbKey: 'k',
  value,
  ts: 1,
  sourceLogKeyHex: 'remote-source-key',
});
const applyOpts = { ownLogKeyHex: 'my-own-key' };

describe('applyOpVia fires onRefusedOp on decode-null', () => {
  it('invokes the hook with the raw value + resolved REMOTE provenance, returns false', async () => {
    const seen: Array<{ raw: unknown; prov: ProvenanceContext | undefined }> = [];
    const p = proj({ onRefusedOp: (raw, prov) => void seen.push({ raw, prov }) });
    const applied = await applyOpVia(() => p as TableProjection<unknown>, remotePut({ bad: true }), applyOpts);
    expect(applied).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.raw).toEqual({ bad: true });
    expect(seen[0]!.prov?.origin).toBe('remote');
    expect(seen[0]!.prov?.authorPubkey).toBe('remote-source-key');
  });

  it('does NOT fire when decode SUCCEEDS (writeToPg runs instead)', async () => {
    const onRefusedOp = vi.fn();
    const writeToPg = vi.fn(async () => {});
    const p = proj({ onRefusedOp, writeToPg });
    const applied = await applyOpVia(() => p as TableProjection<unknown>, remotePut({ good: true }), applyOpts);
    expect(applied).toBe(true);
    expect(onRefusedOp).not.toHaveBeenCalled();
    expect(writeToPg).toHaveBeenCalledTimes(1);
  });

  it('is FAIL-SOFT — a throwing hook does not break apply (still returns false)', async () => {
    const p = proj({
      onRefusedOp: () => {
        throw new Error('counter exploded');
      },
    });
    await expect(applyOpVia(() => p as TableProjection<unknown>, remotePut({ bad: true }), applyOpts)).resolves.toBe(false);
  });

  it('a projection WITHOUT the hook still drops a declined op cleanly', async () => {
    const p = proj(); // no onRefusedOp
    await expect(applyOpVia(() => p as TableProjection<unknown>, remotePut({ bad: true }), applyOpts)).resolves.toBe(false);
  });

  it('preserves an immutable projection delete refusal for the merge cursor', async () => {
    const deleteFromPg = vi.fn(async () => false as const);
    const p = proj({ deleteFromPg });
    await expect(applyOpVia(() => p as TableProjection<unknown>,
      { ...remotePut(undefined), type: 'del' }, applyOpts)).resolves.toBe(false);
    expect(deleteFromPg).toHaveBeenCalledWith('k', 1, undefined,
      expect.objectContaining({ origin: 'remote', authorPubkey: 'remote-source-key' }));
  });

  it('keeps void-returning ordinary deletes applicable', async () => {
    await expect(applyOpVia(() => proj() as TableProjection<unknown>,
      { ...remotePut(undefined), type: 'del' }, applyOpts)).resolves.toBe(true);
  });
});
