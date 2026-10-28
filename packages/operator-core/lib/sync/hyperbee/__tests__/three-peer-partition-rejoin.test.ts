/**
 * three-peer-partition-rejoin.test.ts — P-001 of coord-system-e2e-testing-2026-06-10.
 *
 * Extends the two-peer rig (two-peer.test.ts) to THREE peers with SEVERABLE
 * replication links, and drives a majority/minority partition through heal:
 *
 *   phase 1  A↔B↔C fully linked — every peer converges on every author's ops;
 *   phase 2  C is partitioned off (links severed). The MINORITY peer C keeps
 *            appending; the MAJORITY side A+B also keeps appending, including
 *            a CROSS-AUTHOR conflict on one shared key (A writes it at a lower
 *            ts than C does on the other side of the partition);
 *   phase 3  heal (links re-established) — all three converge: NO op lost, NO
 *            op double-applied, the shared key resolves LWW to the minority's
 *            later write on every peer, and a quiescent extra pass applies
 *            zero ops (no echo loop).
 *
 * Watermarks (the incremental merge's per-log cursors, `MergeCursor.positions`)
 * are snapshotted after EVERY pass on every peer and asserted MONOTONIC
 * non-decreasing throughout — including across the partition and the heal —
 * and `truncated` is asserted false on every pass (no fork/reset ever).
 *
 * Like two-peer.test.ts this is a normal `*.test.ts`: no PG, no Docker — the
 * apply sink is injected, so assertions stop at the read-merge → apply
 * boundary (the projection→PG hop is covered per-table elsewhere). All real
 * modules otherwise: peer-log over real Corestores, real piped replication
 * streams (severing a partition = destroying the streams), the real
 * incremental LWW merge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp, type RemoteLog } from '../peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  type IncrementalMergeResult,
  type MergeCursor,
} from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';
import { stampOpHlc } from '../hlc-stamp';
import { HlcClock, newHlcNodeId } from '@papercusp/locks-core';

const TABLE = 'features_consolidated';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* teardown best-effort */
    }
  }
});

function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* tmp dir already gone */
    }
  });
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

/** A severable replication link between two Corestores (a "network cable"). */
interface Link {
  sever(): void;
}
function link(s1: Corestore, s2: Corestore): Link {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
  return {
    sever() {
      try {
        a.destroy();
      } catch {
        /* already closed */
      }
      try {
        b.destroy();
      } catch {
        /* already closed */
      }
    },
  };
}

class TestPeer {
  readonly store: Corestore;
  own!: OwnLog;
  readonly cursor: MergeCursor = createMergeCursor();
  readonly remotes = new Map<string, RemoteLog>();
  /** Every envelope the apply sink accepted, in apply order. */
  readonly applied: OpEnvelope[] = [];
  /** This simulated peer's own HLC (independent, as a real peer process's is). */
  readonly clock = new HlcClock({ node: newHlcNodeId() });
  /** Watermark snapshots (per-log cursor positions) after each merge pass. */
  private lastPositions = new Map<string, number>();

  constructor(readonly name: string) {
    this.store = makeStore(`p001-${name}-`);
  }

  async init(): Promise<void> {
    await this.store.ready();
    this.own = await openOwnLog(this.store);
  }

  async openRemote(other: TestPeer): Promise<void> {
    this.remotes.set(other.name, await openRemoteLog(this.store, other.own.keyHex));
  }

  async append(hbKey: string, ts: number): Promise<void> {
    const op: PeerLogOp = {
      type: 'put',
      table: TABLE,
      hbKey,
      value: { from: this.name, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${this.name}`,
    };
    // Own-log append HLC-stamps every op (P-010), and `lwwPick` orders by that
    // HLC. Real peers are separate processes with INDEPENDENT clocks; sharing
    // the process-global clock across three simulated peers would order the
    // cross-partition conflict by in-process append interleave instead of each
    // author's own clock. Pre-stamp from this peer's own clock (a preset `hlc`
    // is preserved by the append seam).
    await this.own.append(stampOpHlc(op, this.clock));
  }

  /** One incremental merge pass; asserts watermark monotonicity + no truncation. */
  async merge(): Promise<IncrementalMergeResult> {
    for (const r of this.remotes.values()) await r.update();
    const res = await mergeAdmittedLogsIncremental(
      [this.own, ...this.remotes.values()],
      this.cursor,
      {
        applyImpl: async (op) => {
          this.applied.push(op);
          return true;
        },
        getTimeoutMs: 2_000,
      },
    );
    expect(res.truncated).toBe(false); // no fork/reset, ever, in this scenario

    // WATERMARK MONOTONICITY: per-log cursors never move backwards — across
    // appends, the partition, and the heal.
    for (const [keyHex, pos] of this.cursor.positions) {
      const prev = this.lastPositions.get(keyHex) ?? 0;
      expect(pos, `${this.name}'s cursor for log ${keyHex.slice(0, 8)}… regressed`).toBeGreaterThanOrEqual(prev);
      this.lastPositions.set(keyHex, pos);
    }
    return res;
  }

  /** The peer's converged view: per hbKey, the latest-applied (winning) op. */
  finalState(): Map<string, { ts: number; from: string }> {
    const state = new Map<string, { ts: number; from: string }>();
    for (const op of this.applied) {
      const cur = state.get(op.hbKey!);
      if (!cur || op.ts! >= cur.ts) {
        state.set(op.hbKey!, { ts: op.ts!, from: (op.value as { from: string }).from });
      }
    }
    return state;
  }

  appliedKeys(): Set<string> {
    return new Set(this.applied.map((op) => op.hbKey!));
  }
}

describe('three-peer partition/rejoin — majority/minority asymmetry (P-001)', () => {
  it('minority keeps appending through a partition; on heal all three converge with no loss/dup and monotonic watermarks', async () => {
    const A = new TestPeer('A');
    const B = new TestPeer('B');
    const C = new TestPeer('C');
    const peers = [A, B, C];
    for (const p of peers) await p.init();
    for (const p of peers) {
      for (const q of peers) if (p !== q) await p.openRemote(q);
    }

    // ── Phase 1: fully linked, baseline convergence ──────────────────────────
    let linkAB = link(A.store, B.store);
    let linkAC = link(A.store, C.store);
    let linkBC = link(B.store, C.store);

    await A.append('doc-A1', 1_001);
    await B.append('doc-B1', 1_002);
    await C.append('doc-C1', 1_003);

    for (const p of peers) {
      const res = await p.merge();
      expect(res.caughtUp).toBe(true);
    }
    for (const p of peers) {
      expect(p.appliedKeys()).toEqual(new Set(['doc-A1', 'doc-B1', 'doc-C1']));
    }

    // ── Phase 2: partition C off (the minority). Everyone keeps writing. ─────
    linkAC.sever();
    linkBC.sever();

    // Minority C appends through the partition…
    await C.append('doc-C2', 2_001);
    await C.append('doc-C3', 2_002);
    // …including the CONFLICT key, at a LATER ts than the majority's write…
    await C.append('doc-shared', 2_010);
    // …while the majority side also writes (incl. the conflict key, earlier ts).
    await A.append('doc-A2', 2_003);
    await A.append('doc-shared', 2_005);
    await B.append('doc-B2', 2_004);

    for (const p of peers) await p.merge();
    // A second pass per peer: the majority pair exchanges over the surviving
    // link; the minority only re-reads itself.
    for (const p of peers) await p.merge();

    // MAJORITY view: has both majority authors' partition ops, NONE of C's.
    for (const p of [A, B]) {
      const keys = p.appliedKeys();
      expect(keys.has('doc-A2')).toBe(true);
      expect(keys.has('doc-B2')).toBe(true);
      expect(keys.has('doc-C2')).toBe(false);
      expect(keys.has('doc-C3')).toBe(false);
      expect(p.finalState().get('doc-shared')).toEqual({ ts: 2_005, from: 'A' });
    }
    // MINORITY view: only its own partition ops, none of the majority's.
    const cKeys = C.appliedKeys();
    expect(cKeys.has('doc-C2')).toBe(true);
    expect(cKeys.has('doc-C3')).toBe(true);
    expect(cKeys.has('doc-A2')).toBe(false);
    expect(cKeys.has('doc-B2')).toBe(false);
    expect(C.finalState().get('doc-shared')).toEqual({ ts: 2_010, from: 'C' });

    // ── Phase 3: heal — relink and converge ─────────────────────────────────
    linkAC = link(A.store, C.store);
    linkBC = link(B.store, C.store);

    for (const p of peers) await p.merge();
    for (const p of peers) {
      const res = await p.merge();
      expect(res.caughtUp).toBe(true);
    }

    // NO LOSS: every op every author ever wrote is visible on every peer.
    const ALL_KEYS = new Set([
      'doc-A1', 'doc-B1', 'doc-C1',
      'doc-A2', 'doc-B2', 'doc-C2', 'doc-C3',
      'doc-shared',
    ]);
    for (const p of peers) {
      expect(p.appliedKeys()).toEqual(ALL_KEYS);
    }

    // CONVERGENCE: identical final state on all three peers, and the conflict
    // key resolved LWW to the MINORITY's later write everywhere.
    const stateA = A.finalState();
    expect(stateA.get('doc-shared')).toEqual({ ts: 2_010, from: 'C' });
    for (const p of [B, C]) {
      expect(p.finalState()).toEqual(stateA);
    }

    // NO DUP: a given (hbKey, ts) applied at most once per peer. (The shared
    // key legitimately applies twice on the majority side — once per winner —
    // but never the SAME winner twice.)
    for (const p of peers) {
      const seen = new Set<string>();
      for (const op of p.applied) {
        const sig = `${op.hbKey}@${op.ts}`;
        expect(seen.has(sig), `${p.name} double-applied ${sig}`).toBe(false);
        seen.add(sig);
      }
    }

    // NO ECHO: a quiescent extra pass applies nothing anywhere.
    for (const p of peers) {
      const res = await p.merge();
      expect(res.applied).toBe(0);
      expect(res.caughtUp).toBe(true);
    }

    linkAB.sever();
    linkAC.sever();
    linkBC.sever();
  }, 30_000);
});
