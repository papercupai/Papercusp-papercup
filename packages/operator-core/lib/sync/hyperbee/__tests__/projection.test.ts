/**
 * projection.test.ts — Model B projection-apply seam + LWW tiebreak.
 *
 * Two cross-stage gaps from the holistic review are covered here:
 *
 *   Fix 2 (per-harness projection apply) — the GLOBAL registry is keyed by
 *   `tableTag`, so two booted harnesses registering the same tag overwrite each
 *   other and the global `applyHyperbeeOpToPg` dispatches to whoever registered
 *   LAST → the other harness's ops are silently dropped. The fix is a
 *   PER-HARNESS scoped apply (`buildHarnessProjectionApply`) bound to that
 *   harness's own projection set, dispatching through the shared `applyOpVia`
 *   core. These tests prove a scoped apply for harness A routes an A-row to A's
 *   writer (not B's) and vice-versa — no cross-harness drop — and contrast it
 *   with the global registry's last-writer-wins collision.
 *
 *   P-001 (unforgeable LWW tiebreak, D-004) — on an exact `ts` tie with the
 *   same op type, `lwwPick` breaks the tie on the receiver-stamped, unforgeable
 *   `sourceLogKeyHex` (NOT the self-declared `writerPubkey` a peer controls) so
 *   the winner is identical on every peer regardless of fold order, and a peer
 *   cannot steal a tie by self-declaring a maximal pubkey.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import {
  applyOpVia,
  applyHyperbeeOpToPg,
  registerProjection,
  getProjection,
  lwwPick,
  resetUnthreadedApplyDetectorForTest,
  setUnthreadedApplyWarnSinkForTest,
  unthreadedSkipOwnOpsApplyCount,
  _clearRegistryForTests,
  type ProjectionLookup,
  type ProvenanceContext,
  type TableProjection,
} from '../projection';
import type { OpEnvelope } from '../op-envelope-types';

afterEach(() => _clearRegistryForTests());

/** A capturing projection for one harness: spy writers + a per-harness guard
 *  mirroring the real projections (`if (row.harness_slug !== ours) return`). */
function spyProjection(tableTag: string, harnessSlug: string) {
  const writes: Array<{ id: string; harness_slug: string }> = [];
  const deletes: string[] = [];
  const proj: TableProjection<{ id: string; harness_slug: string }> = {
    tableTag,
    composeKey: (row) => row.id,
    decodeValue: (raw) =>
      raw && typeof raw === 'object' ? (raw as { id: string; harness_slug: string }) : null,
    writeToPg: async (row) => {
      if (row.harness_slug !== harnessSlug) return; // the real guard
      writes.push(row);
    },
    deleteFromPg: async (key) => { deletes.push(key); },
  };
  return { proj, writes, deletes };
}

/** A scoped apply over a private one-projection set — exactly what
 *  `buildHarnessProjectionApply` does (a `Map` lookup → `applyOpVia`). */
function scopedApplyOver(proj: TableProjection<unknown>): (op: OpEnvelope) => Promise<boolean> {
  const set = new Map<string, TableProjection<unknown>>([[proj.tableTag, proj]]);
  const lookup: ProjectionLookup = (tag) => set.get(tag) ?? null;
  return (op) => applyOpVia(lookup, op);
}

describe('per-harness scoped apply (Fix 2 — no cross-harness drop)', () => {
  it('a scoped apply for harness A routes an A-row to A\'s writer, not B\'s', async () => {
    const A = spyProjection('presence', 'harness-A');
    const B = spyProjection('presence', 'harness-B');

    const applyA = scopedApplyOver(A.proj as TableProjection<unknown>);
    const applyB = scopedApplyOver(B.proj as TableProjection<unknown>);

    const aRow = { id: 'row-A', harness_slug: 'harness-A' };
    const bRow = { id: 'row-B', harness_slug: 'harness-B' };

    // A-row through A's scoped apply → A's writer sees it.
    expect(
      await applyA({ type: 'put', table: 'presence', hbKey: 'row-A', value: aRow }),
    ).toBe(true);
    // B-row through B's scoped apply → B's writer sees it.
    expect(
      await applyB({ type: 'put', table: 'presence', hbKey: 'row-B', value: bRow }),
    ).toBe(true);

    // Each writer saw ONLY its own harness's row — no cross-harness drop, no
    // cross-harness leak.
    expect(A.writes).toEqual([aRow]);
    expect(B.writes).toEqual([bRow]);

    // And the inverse: an A-row sent through B's scoped apply is dropped by B's
    // own harness_slug guard (proving the sets are truly independent — B would
    // NOT have silently swallowed A's op in place of A).
    A.writes.length = 0;
    B.writes.length = 0;
    await applyB({ type: 'put', table: 'presence', hbKey: 'row-A', value: aRow });
    expect(B.writes).toEqual([]); // guarded out
    expect(A.writes).toEqual([]); // never reached A either
  });

  it('contrast: the GLOBAL registry collides (last registration wins, the earlier harness is dropped)', async () => {
    // This is the bug the per-harness apply fixes: registering two harnesses'
    // SAME tag into the global registry overwrites — only the last one's writer
    // is reachable via the global applyHyperbeeOpToPg.
    const A = spyProjection('presence', 'harness-A');
    const B = spyProjection('presence', 'harness-B');
    registerProjection(A.proj);
    registerProjection(B.proj); // overwrites A by tableTag

    // The global registry now resolves 'presence' to B only.
    expect(getProjection('presence')).toBe(B.proj as unknown as TableProjection<unknown>);

    // An A-row through the GLOBAL apply hits B's projection, whose guard drops
    // it → A's op is silently lost. (Scoped apply above avoids exactly this.)
    const aRow = { id: 'row-A', harness_slug: 'harness-A' };
    await applyHyperbeeOpToPg({ type: 'put', table: 'presence', hbKey: 'row-A', value: aRow });
    expect(A.writes).toEqual([]); // dropped — the collision the fix removes
    expect(B.writes).toEqual([]); // B's guard rejected A's slug
  });

  it('applyOpVia dispatches del to the deleter and tolerates unknown tables / bad shapes', async () => {
    const A = spyProjection('presence', 'harness-A');
    const apply = scopedApplyOver(A.proj as TableProjection<unknown>);
    expect(await apply({ type: 'del', table: 'presence', hbKey: 'k1' })).toBe(true);
    expect(A.deletes).toEqual(['k1']);
    // Unknown table → false (dropped).
    expect(await apply({ type: 'put', table: 'nope', hbKey: 'k', value: {} })).toBe(false);
    // addWriter (retired) / missing table → false.
    expect(await apply({ type: 'addWriter' as never })).toBe(false);
  });
});

describe('lwwPick tiebreak binds to the unforgeable sourceLogKeyHex (P-001 — D-004)', () => {
  it('later ts wins regardless of source', () => {
    const a = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'zzz' };
    const b = { type: 'put' as const, ts: 200, sourceLogKeyHex: 'aaa' };
    expect(lwwPick(a, b)).toBe(b);
    expect(lwwPick(b, a)).toBe(b);
  });

  it('on a ts tie, del still beats put (type decides before source)', () => {
    const put = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'zzz' };
    const del = { type: 'del' as const, ts: 100, sourceLogKeyHex: 'aaa' };
    expect(lwwPick(put, del)).toBe(del);
    expect(lwwPick(del, put)).toBe(del);
  });

  it('on a ts tie + same type, the GREATER sourceLogKeyHex wins — order-independent', () => {
    const lo = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'aaa' };
    const hi = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'bbb' };
    // hi wins regardless of which arg is first → identical on every peer.
    expect(lwwPick(lo, hi)).toBe(hi);
    expect(lwwPick(hi, lo)).toBe(hi);
  });

  it('a forged self-declared writerPubkey CANNOT flip the tiebreak winner', () => {
    // Security property (D-004): the tiebreak keys off the receiver-stamped,
    // unforgeable source-log key — NOT the self-declared `writerPubkey` a peer
    // controls. The loser self-declares a maximal pubkey to try to steal the
    // tie; the unforgeable `sourceLogKeyHex` must still decide.
    const loForged = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'aaa', writerPubkey: 'zzzzzz' };
    const hiHonest = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'bbb', writerPubkey: 'aaaaaa' };
    expect(lwwPick(loForged, hiHonest)).toBe(hiHonest);
    expect(lwwPick(hiHonest, loForged)).toBe(hiHonest);
  });

  it('treats a missing sourceLogKeyHex as \'\' (stable, total order)', () => {
    const none = { type: 'put' as const, ts: 100 };                  // source undefined ⇒ ''
    const some = { type: 'put' as const, ts: 100, sourceLogKeyHex: 'a' };
    // 'a' > '' so the op WITH a source key wins, both orders.
    expect(lwwPick(none, some)).toBe(some);
    expect(lwwPick(some, none)).toBe(some);
    // Two missing source keys: '' >= '' → first arg (deterministic, never throws).
    const n1 = { type: 'put' as const, ts: 100 };
    const n2 = { type: 'put' as const, ts: 100 };
    expect(lwwPick(n1, n2)).toBe(n1);
  });

  it('is fold-order independent for three same-ts same-type ops (the divergence the fix prevents)', () => {
    const x = { type: 'put' as const, ts: 5, sourceLogKeyHex: 'x' };
    const y = { type: 'put' as const, ts: 5, sourceLogKeyHex: 'y' };
    const z = { type: 'put' as const, ts: 5, sourceLogKeyHex: 'z' };
    // Fold in any order → the lexicographically-greatest source key ('z') wins.
    // `lwwPick` returns the wider `OpEnvelope`, so seed/annotate the reduce as
    // `OpEnvelope` (the narrow inferred element type can't hold the result).
    const fold = (ops: OpEnvelope[]) =>
      ops.reduce<OpEnvelope>((acc, op) => lwwPick(acc, op), ops[0]!);
    expect(fold([x, y, z])).toBe(z);
    expect(fold([z, y, x])).toBe(z);
    expect(fold([y, z, x])).toBe(z);
    expect(fold([y, x, z])).toBe(z);
  });
});

describe('provenance attribution binds to the unforgeable source log, not the self-declared field (P-002 — D-004)', () => {
  // A projection that captures the ProvenanceContext handed to writeToPg.
  function provCapture(tableTag = 'presence') {
    const seen: Array<ProvenanceContext | undefined> = [];
    const proj: TableProjection<{ id: string }> = {
      tableTag,
      composeKey: (r) => r.id,
      decodeValue: (raw) => (raw && typeof raw === 'object' ? (raw as { id: string }) : null),
      writeToPg: async (_row, provenance) => { seen.push(provenance); },
      deleteFromPg: async () => {},
    };
    const set = new Map<string, TableProjection<unknown>>([[tableTag, proj as TableProjection<unknown>]]);
    const lookup: ProjectionLookup = (t) => set.get(t) ?? null;
    return { lookup, seen };
  }

  const putOp = (extra: Partial<OpEnvelope>): OpEnvelope => ({
    type: 'put', table: 'presence', hbKey: 'k', value: { id: 'k' },
    ts: 1000, hlc: encodeHlc({ ms: 1000, count: 0 }), ...extra,
  });

  it('a REMOTE op stamps author from the unforgeable source-log key, ignoring a forged writerPubkey', async () => {
    const { lookup, seen } = provCapture();
    await applyOpVia(
      lookup,
      putOp({ writerPubkey: 'FORGED-DEVICE', sourceLogKeyHex: 'REMOTE-LOG-KEY' }),
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    // origin=remote (source ≠ own) → attribution is the receiver-stamped log
    // key, NOT the attacker-controlled writerPubkey. WI-3734: the raw source-log
    // key also rides along for per-projection apply guards (home-log exclusion).
    expect(seen[0]).toEqual({
      authorPubkey: 'REMOTE-LOG-KEY',
      origin: 'remote',
      sourceLogKeyHex: 'REMOTE-LOG-KEY',
      hbKey: 'k', ts: 1000, fedHlc: encodeHlc({ ms: 1000, count: 0 }),
    });
  });

  it('a LOCAL op keeps the trustworthy self-declared writerPubkey (own writes are not a forgery vector)', async () => {
    const { lookup, seen } = provCapture();
    await applyOpVia(
      lookup,
      putOp({ writerPubkey: 'MY-OWN-DEVICE', sourceLogKeyHex: 'OWN-LOG-KEY' }),
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    expect(seen[0]).toEqual({
      authorPubkey: 'MY-OWN-DEVICE',
      origin: 'local',
      sourceLogKeyHex: 'OWN-LOG-KEY',
      hbKey: 'k', ts: 1000, fedHlc: encodeHlc({ ms: 1000, count: 0 }),
    });
  });

  it('a REMOTE op with no source key records NO forgeable identity (never the self-declared field)', async () => {
    const { lookup, seen } = provCapture();
    await applyOpVia(
      lookup,
      putOp({ writerPubkey: 'FORGED-DEVICE', sourceLogKeyHex: undefined }),
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    // source undefined ≠ own ⇒ origin=remote; with no unforgeable source the
    // author is left empty rather than trusting the forged writerPubkey.
    expect(seen[0]).toEqual({ authorPubkey: '', origin: 'remote',
      hbKey: 'k', ts: 1000, fedHlc: encodeHlc({ ms: 1000, count: 0 }) });
  });
});

describe('skipOwnOps — the EI-117 echo breaker (own-log replays on CDC tables)', () => {
  function spyWithFlag(skipOwnOps: boolean | undefined, tableTag = 'plans-by-slug') {
    const writes: Array<{ id: string }> = [];
    const deletes: string[] = [];
    const proj: TableProjection<{ id: string }> = {
      tableTag,
      ...(skipOwnOps === undefined ? {} : { skipOwnOps }),
      composeKey: (r) => r.id,
      decodeValue: (raw) => (raw && typeof raw === 'object' ? (raw as { id: string }) : null),
      writeToPg: async (row) => { writes.push(row); },
      deleteFromPg: async (key) => { deletes.push(key); },
    };
    const set = new Map<string, TableProjection<unknown>>([[tableTag, proj as TableProjection<unknown>]]);
    const lookup: ProjectionLookup = (t) => set.get(t) ?? null;
    return { lookup, writes, deletes };
  }

  const putOp = (extra: Partial<OpEnvelope>): OpEnvelope => ({
    type: 'put', table: 'plans-by-slug', hbKey: 'k', value: { id: 'k' },
    ts: 1000, hlc: encodeHlc({ ms: 1000, count: 0 }), ...extra,
  });

  it('a log-source-VERIFIED own put on a skipOwnOps projection is skipped (no write, returns false)', async () => {
    const { lookup, writes } = spyWithFlag(true);
    const applied = await applyOpVia(
      lookup,
      putOp({ sourceLogKeyHex: 'OWN-LOG-KEY' }),
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    expect(applied).toBe(false);
    expect(writes).toEqual([]);
  });

  it('WI-1684: an own DEL on a skipOwnOps projection is NOT skipped — it applies (cleans up a drain-window resurrection)', async () => {
    // The skip is narrowed to PUTS. An own del must apply: during the drain window a
    // concurrent lower-hlc foreign put can resurrect the row on the author peer via
    // the no-row INSERT path, and the winning own del is the only thing that clears
    // it (echo-safe — a 0-row / origin='remote' delete never re-enters the outbox).
    const { lookup, deletes } = spyWithFlag(true);
    const applied = await applyOpVia(
      lookup,
      { type: 'del', table: 'plans-by-slug', hbKey: 'k', sourceLogKeyHex: 'OWN-LOG-KEY' },
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    expect(applied).toBe(true);
    expect(deletes).toEqual(['k']);
  });

  it('a REMOTE op on a skipOwnOps projection still applies (only own replays are skipped)', async () => {
    const { lookup, writes } = spyWithFlag(true);
    const applied = await applyOpVia(
      lookup,
      putOp({ sourceLogKeyHex: 'REMOTE-LOG-KEY' }),
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    expect(applied).toBe(true);
    expect(writes).toEqual([{ id: 'k' }]);
  });

  it('an own op on a LOG-FIRST projection (no skipOwnOps) still applies — its PG state arrives via the merge', async () => {
    const { lookup, writes } = spyWithFlag(undefined, 'queue');
    const applied = await applyOpVia(
      lookup,
      { type: 'put', table: 'queue', hbKey: 'k', value: { id: 'k' }, sourceLogKeyHex: 'OWN-LOG-KEY' },
      { ownLogKeyHex: 'OWN-LOG-KEY' },
    );
    expect(applied).toBe(true);
    expect(writes).toEqual([{ id: 'k' }]);
  });

  it('without an ownLogKeyHex (legacy/global path) nothing is skipped — the skip is gated on log-source verification, and the WI-6210 detector fires', async () => {
    // WI-6210: this is not a benign legacy case — with no own-log key the echo
    // breaker cannot fire AND provenance defaults to origin='local' from the
    // forgeable writerPubkey, which is how a remote publisher's row gets
    // permanently shadowed by this host's own echo. The apply still proceeds
    // (the fix belongs at the caller), but it must be AUDIBLE.
    resetUnthreadedApplyDetectorForTest();
    const seen: string[] = [];
    setUnthreadedApplyWarnSinkForTest((m) => seen.push(m));
    try {
      const { lookup, writes } = spyWithFlag(true);
      const applied = await applyOpVia(lookup, putOp({ sourceLogKeyHex: 'OWN-LOG-KEY' }));
      expect(applied).toBe(true);
      expect(writes).toEqual([{ id: 'k' }]);
      expect(unthreadedSkipOwnOpsApplyCount()).toBe(1);
      expect(seen[0] ?? '').toContain('WI-6210 UN-THREADED apply');
    } finally {
      resetUnthreadedApplyDetectorForTest();
    }
  });
});

void vi; // (vi imported for parity with sibling tests; spies are inline above)
