/**
 * computeHasStalledLogs — EI-18665254552552477.
 *
 * `hasStalledLogs()` is `joinHarnessSwarm`'s WI-1534 anti-entropy signal: while
 * true, the self-heal refresh loop stays on the FAST cadence instead of
 * settling into the 60s slow keepalive. The pure decision was extracted from
 * boot.ts's `hasStalledLogs` closure specifically so this axis — previously
 * only exercised indirectly via a real two-peer integration boot
 * (wi1534-quiescent-hive-self-heal.integration.test.ts) or a fully-mocked
 * callback (swarm-self-heal.test.ts) — gets direct, fast unit coverage,
 * including the PRE-admission case that a live gate run
 * (EI-18662944242304583, run 20260725-183831) proved was silently blind: 20.5
 * minutes, 188 established connections, zero inbound frames, zero admissions,
 * and the loop sat on the slow cadence the entire time.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeHasStalledLogs } from '../boot';

const OWN_KEY = 'own-log-key-hex';

function admittedOf(entries: Array<[string, unknown]>): Map<string, unknown> {
  return new Map(entries);
}

describe('computeHasStalledLogs (EI-18665254552552477)', () => {
  it('not stalled: no remote admissions and no live connections (genuinely solo/offline node)', () => {
    // This is the false-positive guard the issue calls out explicitly: an
    // axis armed on "admitted is empty" alone (no live-peer leg) would also
    // fire for a peer that simply isn't there, which must stay slow-cadence.
    expect(computeHasStalledLogs(admittedOf([]), OWN_KEY, /* liveConnectionCount */ 0)).toBe(false);
  });

  it('not stalled: only ownLog is admitted, no live connections', () => {
    expect(computeHasStalledLogs(admittedOf([[OWN_KEY, {}]]), OWN_KEY, 0)).toBe(false);
  });

  it('STALLED (the new pre-admission axis): zero admitted remotes but live connections exist', () => {
    // The exact live-observed shape: connections established, nothing
    // admitted yet. Pre-fix this fell through the original loop to `false`
    // ("not stalled") — exactly backwards, since this is the worst case the
    // predicate can observe.
    expect(computeHasStalledLogs(admittedOf([]), OWN_KEY, /* liveConnectionCount */ 3)).toBe(true);
  });

  it('STALLED: only ownLog admitted (no remote) but live connections exist', () => {
    expect(computeHasStalledLogs(admittedOf([[OWN_KEY, {}]]), OWN_KEY, 1)).toBe(true);
  });

  it('STALLED (original WI-1534 axis, unchanged): an admitted remote log reports zero peers', () => {
    const remote = { peersCount: () => 0 };
    expect(
      computeHasStalledLogs(admittedOf([[OWN_KEY, {}], ['remote-1', remote]]), OWN_KEY, 0),
    ).toBe(true);
  });

  it('not stalled: an admitted remote log has live peers, even with zero live connections reported', () => {
    // liveConnectionCount is only consulted on the pre-admission branch; a
    // healthy admitted remote short-circuits before it matters.
    const remote = { peersCount: () => 2 };
    expect(
      computeHasStalledLogs(admittedOf([[OWN_KEY, {}], ['remote-1', remote]]), OWN_KEY, 0),
    ).toBe(false);
  });

  it('not stalled: multiple admitted remotes, all with live peers', () => {
    const a = { peersCount: () => 1 };
    const b = { peersCount: () => 4 };
    expect(
      computeHasStalledLogs(admittedOf([['remote-a', a], ['remote-b', b]]), OWN_KEY, 5),
    ).toBe(false);
  });

  it('STALLED: one of several admitted remotes has zero peers (short-circuits true)', () => {
    const healthy = { peersCount: () => 2 };
    const dead = { peersCount: () => 0 };
    expect(
      computeHasStalledLogs(admittedOf([['remote-a', healthy], ['remote-b', dead]]), OWN_KEY, 9),
    ).toBe(true);
  });

  it('a throwing peersCount() on an admitted remote is treated as "not stalled" for that log', () => {
    const throwing = {
      peersCount: () => {
        throw new Error('boom');
      },
    };
    // No other remote, throwing probe swallowed → sawRemoteAdmitted stays
    // true → falls through to `false`, never re-consults liveConnectionCount.
    expect(computeHasStalledLogs(admittedOf([['remote-1', throwing]]), OWN_KEY, 7)).toBe(false);
  });

  it('a fake/mock log with no peersCount() at all is skipped, not treated as stalled', () => {
    expect(
      computeHasStalledLogs(admittedOf([['remote-1', { notPeersCount: 1 }]]), OWN_KEY, 0),
    ).toBe(false);
  });

  it('WI-10005287: boot.ts feeds leg (b) the TOPIC-scoped socket count, never the swarm-wide one', () => {
    // The predicate is only as topic-correct as its third input. Fed the shared
    // swarm's liveConnectionCount, one peer connected for other harnesses held
    // leg (b) true forever on 48 of 89 bg-host topics (2026-10-02). The
    // topic-scoped count itself is pinned in topic-stall-candidate.test.ts;
    // this pins the call site that chooses it.
    const src = readFileSync(new URL('../boot.ts', import.meta.url), 'utf8');
    const calls = src.match(/computeHasStalledLogs\(admitted,[^)]*\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('topicStallCandidateCount');
    expect(calls[0]).not.toContain('liveConnectionCount');
  });
});
