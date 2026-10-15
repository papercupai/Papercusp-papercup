/**
 * The hourly anchoring pass (P-041, R-29; D-024 §5): ticks each workspace and
 * files ONE deduplicated missed-hour alert per workspace, naming the failure.
 */
import { describe, expect, it } from 'vitest';
import { appendLinks, entryDigest } from '@papercusp/hash-chain';
import { verifyConsistency } from '@papercusp/merkle-log';
import { HOUR_SECONDS, memoryLedgerAnchorStore, type AnchorBackend, type AnchorLinkFeed } from './ledger-anchor';
import { missedHourWatchdogKey, runLedgerAnchorPass } from './ledger-anchor-runtime';

const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
const links = appendLinks('money-journal', null, [entryDigest({ c: 1 }), entryDigest({ c: 2 })]);
const feed: AnchorLinkFeed = { links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) };

function alerts() {
  const filed: { watchdogKey: string; title: string; body: string; workspaceId: string }[] = [];
  const open = new Set<string>();
  return {
    filed,
    deps: {
      hasOpenAlert: async (key: string) => open.has(key),
      file: async (input: { watchdogKey: string; title: string; body: string; workspaceId: string }) => {
        filed.push(input);
        open.add(input.watchdogKey);
      },
    },
  };
}

const okBackend = (): AnchorBackend => {
  let n = 0;
  return {
    kind: 'test-chain',
    publish: async () => ({ backend: 'test-chain', chainId: 84532, ref: `0x${(++n).toString(16).padStart(64, '0')}`, txHash: null, attester: null }),
  };
};
const brokenBackend: AnchorBackend = {
  kind: 'eas',
  publish: async () => {
    throw new Error('insufficient funds for gas * price + value\nmore detail');
  },
};

describe('ledger anchor pass', () => {
  it('anchors each workspace and raises no alert while the cadence holds', async () => {
    const store = memoryLedgerAnchorStore();
    const a = alerts();
    const r = await runLedgerAnchorPass({ nowSeconds: T0 + 300, backend: okBackend(), store, feed, workspaces: ['ws-1'], alertDeps: a.deps });
    expect(r.workspaces[0]).toMatchObject({ workspaceId: 'ws-1', tick: { status: 'anchored' }, cadence: { status: 'on-time' } });
    expect(a.filed).toEqual([]);
  });

  it('a failing publication becomes ONE missed-hour alert naming the failure, deduplicated across passes', async () => {
    const store = memoryLedgerAnchorStore();
    const a = alerts();
    await runLedgerAnchorPass({ nowSeconds: T0 + 300, backend: okBackend(), store, feed, workspaces: ['ws-1'], alertDeps: a.deps });
    // Two hours later every publication fails.
    const later = T0 + 2 * HOUR_SECONDS + 30 * 60;
    const r1 = await runLedgerAnchorPass({ nowSeconds: later, backend: brokenBackend, store, feed, workspaces: ['ws-1'], alertDeps: a.deps });
    const r2 = await runLedgerAnchorPass({ nowSeconds: later + 900, backend: brokenBackend, store, feed, workspaces: ['ws-1'], alertDeps: a.deps });
    expect(r1.workspaces[0]).toMatchObject({ tick: { status: 'failed', error: 'insufficient funds for gas * price + value' }, cadence: { status: 'missed', hoursBehind: 2 } });
    expect(r2.workspaces[0]!.cadence).toMatchObject({ status: 'missed' });
    expect(a.filed).toHaveLength(1);
    expect(a.filed[0]).toMatchObject({ watchdogKey: missedHourWatchdogKey('ws-1'), workspaceId: 'ws-1' });
    expect(a.filed[0]!.body).toContain('insufficient funds');
  });

  it('with no backend it still checks cadence, and alerts per workspace', async () => {
    const a = alerts();
    const r = await runLedgerAnchorPass({
      nowSeconds: T0 + 45 * 60,
      backend: null,
      store: memoryLedgerAnchorStore(),
      feed,
      workspaces: ['ws-a', 'ws-b'],
      alertDeps: a.deps,
    });
    expect(r.workspaces.map((w) => w.tick.status)).toEqual(['skipped', 'skipped']);
    expect(a.filed.map((f) => f.watchdogKey)).toEqual([missedHourWatchdogKey('ws-a'), missedHourWatchdogKey('ws-b')]);
  });
});

describe('ledger anchor pass with the Cupboard Worker feed (D-027)', () => {
  const pgOnlyWs1: AnchorLinkFeed = {
    links: async (ws) => (ws === 'ws-1' ? links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) : []),
  };
  const workerLinks = [
    ...appendLinks('cupboard-commerce', null, [entryDigest({ order: 1 })]),
    ...appendLinks('cupboard-treasury', null, [entryDigest({ grant: 1 }), entryDigest({ grant: 2 })]),
  ].map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash }));
  const workerFeed: AnchorLinkFeed = { links: async (ws) => (ws === 'ws-treasury' ? workerLinks : []) };

  it("anchors the treasury workspace from the Worker's links even when PG holds none for it", async () => {
    const store = memoryLedgerAnchorStore();
    const r = await runLedgerAnchorPass({
      nowSeconds: T0 + 300,
      backend: okBackend(),
      store,
      feed: pgOnlyWs1,
      workspaces: ['ws-1'],
      alertDeps: alerts().deps,
      cupboard: { feed: workerFeed, treasuryWorkspace: 'ws-treasury' },
    });
    expect(r.cupboardFeedUnavailable).toBeNull();
    expect(r.workspaces.map((w) => w.workspaceId)).toEqual(['ws-1', 'ws-treasury']);
    expect(r.workspaces[0]).toMatchObject({ tick: { status: 'anchored', newLeaves: 2 }, feedErrors: [] });
    expect(r.workspaces[1]).toMatchObject({ tick: { status: 'anchored', newLeaves: 3 }, feedErrors: [] });
    expect((await store.leaves('ws-treasury')).length).toBe(3);
    expect((await store.leaves('ws-1')).length).toBe(2);
  });

  it('a failing Worker feed is reported per workspace and does not stop the PG links being anchored', async () => {
    const store = memoryLedgerAnchorStore();
    const failing: AnchorLinkFeed = {
      links: async () => {
        throw new Error('cupboard worker 503\n<html>…</html>');
      },
    };
    const r = await runLedgerAnchorPass({
      nowSeconds: T0 + 300,
      backend: okBackend(),
      store,
      feed: pgOnlyWs1,
      workspaces: ['ws-1'],
      alertDeps: alerts().deps,
      cupboard: { feed: failing, treasuryWorkspace: 'ws-treasury' },
    });
    expect(r.workspaces[0]).toMatchObject({ workspaceId: 'ws-1', tick: { status: 'anchored', newLeaves: 2 }, feedErrors: ['cupboard: cupboard worker 503'] });
    expect(r.workspaces[1]).toMatchObject({ workspaceId: 'ws-treasury', feedErrors: ['cupboard: cupboard worker 503'] });
    expect((await store.leaves('ws-treasury')).length).toBe(0);
  });

  it('cupboard: null feeds no Worker links and adds no treasury workspace', async () => {
    const r = await runLedgerAnchorPass({
      nowSeconds: T0 + 300,
      backend: okBackend(),
      store: memoryLedgerAnchorStore(),
      feed: pgOnlyWs1,
      workspaces: ['ws-1'],
      alertDeps: alerts().deps,
      cupboard: null,
    });
    expect(r.workspaces.map((w) => w.workspaceId)).toEqual(['ws-1']);
    expect(r.cupboardFeedUnavailable).toBeNull();
  });

  it('joins delayed Worker links after an outage without rewriting or duplicating the primary prefix', async () => {
    const store = memoryLedgerAnchorStore();
    const backend = okBackend();
    let unavailable = true;
    const recovering: AnchorLinkFeed = {
      links: async () => {
        if (unavailable) throw new Error('cupboard worker 503');
        return workerLinks;
      },
    };
    const pass = (nowSeconds: number) => runLedgerAnchorPass({
      nowSeconds, backend, store, feed: pgOnlyWs1, workspaces: ['ws-1'], alertDeps: alerts().deps,
      cupboard: { feed: recovering, treasuryWorkspace: 'ws-1' },
    });
    const down = await pass(T0 + 300);
    expect(down.workspaces[0]).toMatchObject({ tick: { status: 'anchored', newLeaves: 2 }, feedErrors: ['cupboard: cupboard worker 503'] });
    const prefix = await store.leaves('ws-1');
    unavailable = false;
    const recovered = await pass(T0 + HOUR_SECONDS + 300);
    expect(recovered.workspaces[0]).toMatchObject({ tick: { status: 'anchored', newLeaves: 3 }, feedErrors: [] });
    const joined = await store.leaves('ws-1');
    expect(joined.slice(0, prefix.length)).toEqual(prefix);
    expect(joined.slice(prefix.length).map(({ streamId, seq, entryHash }) => ({ streamId, seq, entryHash }))).toEqual(workerLinks);
    const anchors = await store.anchors('ws-1');
    expect(anchors.map(a => a.treeSize)).toEqual([2, 5]);
    expect(verifyConsistency({
      oldSize: 2, newSize: 5, oldRoot: anchors[0]!.logRoot, newRoot: anchors[1]!.logRoot, proof: anchors[1]!.consistencyProof,
    })).toBe(true);
    expect((await pass(T0 + 2 * HOUR_SECONDS + 300)).workspaces[0]).toMatchObject({ tick: { status: 'anchored', newLeaves: 0 }, feedErrors: [] });
    expect(await store.leaves('ws-1')).toEqual(joined);
  });
});
