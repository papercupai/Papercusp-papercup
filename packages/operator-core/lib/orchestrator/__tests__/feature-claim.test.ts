/**
 * feature-claim — Model B Stage-5 LWW advisory claim tests.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 *
 * Covers:
 *   - claimFeature appends exactly one claim op to the OWN log and returns
 *     `{ claimed: true }` immediately (no merge-order wait).
 *   - The appended op's value is a `FeatureClaimRow` that the EXISTING
 *     feature-claims projection's `decodeValue` accepts, and its `hbKey` is
 *     the projection's `composeKey` of that row — so it round-trips PG.
 *   - `feature_claims` is APPEND-ONLY: two claims on the same feature get
 *     DISTINCT `hbKey`s because `seq = ownLog.length` advances, so both
 *     round-trip the read-merge as separate audit rows — there is NO
 *     cross-author key collision and NO clobber on the claim path. (Who
 *     currently holds a feature is a separate latest-`claimed_at` read, not
 *     an LWW winner on this path.)
 *   - Validation (harness_slug + feature_id + claimer_github_user_id).
 */

import { describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type HeldOwnLogAppender } from '../../sync/hyperbee/peer-log';
import {
  claimFeature,
  ClaimValidationError,
  type ClaimOwnLog,
} from '../feature-claim';
import { CURRENT_SCHEMA_VERSION } from '../../sync/hyperbee/schema-version';
import { _testing as projection } from '../../sync/hyperbee/projections/feature-claims';
import type { PeerLogOp } from '../../sync/hyperbee/peer-log';
import { mergeAdmittedLogs, type AdmittedLog } from '../../sync/hyperbee/read-merge';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';

/**
 * In-memory own-log fake. Captures appended ops + reports `length`/`keyHex`
 * exactly like the booted handle's `ownLog`. NO merge / read-back wait —
 * `claimFeature` returns as soon as `append` resolves.
 */
class FakeOwnLog implements ClaimOwnLog {
  public ops: PeerLogOp[] = [];
  constructor(public readonly keyHex: string) {}
  get length(): number {
    return this.ops.length;
  }
  async append(op: PeerLogOp): Promise<void> {
    this.ops.push(op);
  }
  async withAppendsHeld<T>(fn: (log: HeldOwnLogAppender) => Promise<T>): Promise<T> {
    return fn({ appendBatch: async ops => { this.ops.push(...ops); } });
  }
}

/** Wrap a list of PeerLogOps as an AdmittedLog the read-merge can read. */
function logFrom(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return ops[i] ?? null;
    },
  };
}

describe('claimFeature — Model B advisory claim', () => {
  it('appends one claim op to the own log and returns { claimed: true }', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    const r = await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 1700000000000,
    });

    expect(r).toEqual({ claimed: true });
    expect(ownLog.ops).toHaveLength(1);

    const op = ownLog.ops[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('claims');
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(op.ts).toBe(1700000000000);
    expect(op.author_pubkey).toBe(ownLog.keyHex);
  });

  it('appended op value round-trips the feature-claims projection', async () => {
    const ownLog = new FakeOwnLog('bb'.repeat(32));
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-7',
      claimer_github_user_id: 99,
      now_ms: 1700000000123,
    });

    const op = ownLog.ops[0];
    // The projection MUST be able to decode the value...
    const row = projection.decodeValue(op.value);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      harness_slug: 'sheets',
      feature_id: 'F-7',
      seq: 0,
      claimer_pubkey: ownLog.keyHex,
      claimer_github_user_id: 99,
      claimed_at: 1700000000123,
      outcome: 'won',
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    // ...and the op's hbKey MUST equal the projection's composeKey for it.
    expect(op.hbKey).toBe(projection.composeKey(row!));
    expect(op.hbKey).toBe(`F-7/${ownLog.keyHex}/0`);
  });

  it('returns immediately without any merge / read-back', async () => {
    // A FakeOwnLog with no read surface (no get) is sufficient — claimFeature
    // never reads back. If it tried to await convergence this would hang/throw.
    const ownLog = new FakeOwnLog('cc'.repeat(32));
    const r = await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
    });
    expect(r.claimed).toBe(true);
  });

  it('two claims on the same feature get DISTINCT hbKeys (append-only audit) — both round-trip, no collision', async () => {
    // `feature_claims` is an APPEND-ONLY per-attempt audit history. Each
    // claim a peer makes lands at `seq = ownLog.length`, which advances per
    // append — so two claims on the SAME feature occupy DIFFERENT keys
    // (`F-1/0` then `F-1/1`) and survive the read-merge as TWO separate audit
    // rows. There is no cross-author key collision and no clobber on the
    // claim path: "who currently holds F-1" is derived separately by the
    // latest `claimed_at` read, NOT by an LWW winner on this key.
    const peer = new FakeOwnLog('a0'.repeat(32));

    await claimFeature(peer, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
      now_ms: 1,
    });
    await claimFeature(peer, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 2,
      now_ms: 2,
    });

    // seq advances 0 → 1, so the two claims on the same feature key DISTINCTLY.
    expect(peer.ops[0].hbKey).toBe(`F-1/${peer.keyHex}/0`);
    expect(peer.ops[1].hbKey).toBe(`F-1/${peer.keyHex}/1`);

    const applied: OpEnvelope[] = [];
    await mergeAdmittedLogs([logFrom(peer.keyHex, peer.ops)], {
      getTimeoutMs: 0,
      applyImpl: async (op) => {
        applied.push(op);
        return true;
      },
    });

    // Both claims apply — distinct keys → distinct LWW groups → no clobber.
    // Both audit rows persist; neither overwrites the other.
    expect(applied).toHaveLength(2);
    const byKey = new Map(applied.map((op) => [op.hbKey, op]));
    expect(byKey.get(`F-1/${peer.keyHex}/0`)).toBeDefined();
    expect(byKey.get(`F-1/${peer.keyHex}/1`)).toBeDefined();
    expect(projection.decodeValue(byKey.get(`F-1/${peer.keyHex}/0`)!.value)?.claimer_github_user_id).toBe(1);
    expect(projection.decodeValue(byKey.get(`F-1/${peer.keyHex}/1`)!.value)?.claimer_github_user_id).toBe(2);
  });

  it('lwwPick (in isolation, NOT claim contention): later ts wins for a single key', async () => {
    // This exercises the generic read-merge primitive `lwwPick` directly, on
    // a SINGLE shared key — it does NOT model claim contention, which can't
    // produce a cross-author key collision (see the append-only test above).
    const { lwwPick } = await import('../../sync/hyperbee/projection');
    const a: OpEnvelope = { type: 'put', table: 'claims', hbKey: 'F-1/0', value: {}, ts: 1 };
    const b: OpEnvelope = { type: 'put', table: 'claims', hbKey: 'F-1/0', value: {}, ts: 2 };
    expect(lwwPick(a, b)).toBe(b);
    expect(lwwPick(b, a)).toBe(b);
  });

  it('rejects empty harness_slug', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await expect(
      claimFeature(ownLog, { harness_slug: '', feature_id: 'F-1', claimer_github_user_id: 1 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('rejects empty feature_id', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await expect(
      claimFeature(ownLog, { harness_slug: 'sheets', feature_id: '', claimer_github_user_id: 1 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('rejects non-positive / non-integer claimer_github_user_id', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    for (const bad of [0, -5, 1.5]) {
      await expect(
        claimFeature(ownLog, {
          harness_slug: 'sheets',
          feature_id: 'F-1',
          claimer_github_user_id: bad,
        }),
      ).rejects.toBeInstanceOf(ClaimValidationError);
    }
  });

  it('uses now_ms override for deterministic ts + claimed_at', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
      now_ms: 1234567,
    });
    expect(ownLog.ops[0].ts).toBe(1234567);
    expect(projection.decodeValue(ownLog.ops[0].value)?.claimed_at).toBe(1234567);
  });

  it('uses ownLog.length as the append-only seq', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    // Pre-seed two prior ops so the next claim lands at seq 2.
    ownLog.ops.push({} as PeerLogOp, {} as PeerLogOp);
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-9',
      claimer_github_user_id: 1,
      now_ms: 100,
    });
    const op = ownLog.ops[2];
    expect(projection.decodeValue(op.value)?.seq).toBe(2);
    expect(op.hbKey).toBe(`F-9/${ownLog.keyHex}/2`);
  });

  it('allocates each concurrent claim at its actual core position while ordinary appends compete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p532-claim-position-'));
    const store = new Corestore(dir);
    try {
      await store.ready();
      const own = await openOwnLog(store);
      await Promise.all([
        ...Array.from({ length: 12 }, () => claimFeature(own, {
          harness_slug: 'sheets', feature_id: 'F-race', claimer_github_user_id: 42,
        })),
        own.append({ type: 'put', table: 'presence', hbKey: 'noise', value: {},
          ts: 1, schema_version: CURRENT_SCHEMA_VERSION, author_pubkey: own.keyHex }),
      ]);
      const claims: number[] = [];
      for (let index = 0; index < own.length; index++) {
        const op = (await own.get(index))!;
        expect(op.hlc).toMatch(/^\d{15}:\d{5}(?::[0-9a-f]{16})?$/);
        if (op.table !== 'claims') continue;
        const row = projection.decodeValue(op.value)!;
        expect(row.seq).toBe(index);
        expect(op.hbKey).toBe(`F-race/${own.keyHex}/${index}`);
        claims.push(row.seq);
      }
      expect(claims).toHaveLength(12);
      expect(new Set(claims).size).toBe(12);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a claim handle without an append serializer before writing', async () => {
    let wrote = false;
    const own: ClaimOwnLog = { keyHex: 'a'.repeat(64), length: 0,
      append: async () => { wrote = true; } };
    await expect(claimFeature(own, { harness_slug: 'sheets', feature_id: 'F-1',
      claimer_github_user_id: 42 })).rejects.toThrow('append_serializer');
    expect(wrote).toBe(false);
  });
});
