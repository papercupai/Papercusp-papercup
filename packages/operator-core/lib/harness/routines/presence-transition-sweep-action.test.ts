/**
 * Unit tests for the P-039 presence-transition sweep
 * (context-injection-audit-2026-07-28, D-012). Every seam is injected, so this
 * exercises the real sweep body without PG, the locks store, or the coord rail.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runPresenceTransitionSweep,
  __resetPresenceTransitionSnapshotForTests,
  type PresenceTransitionSweepDeps,
} from './presence-transition-sweep-action';
import type { Commitment, PresenceNotice, PresenceObservation } from '../../presence-transition-emitter';

const obs = (agentId: string, sessionState: string | null): PresenceObservation => ({ agentId, sessionState });

/** A sweep harness: successive gather() rounds, capturing what got delivered. */
function harness(rounds: PresenceObservation[][], commitments: Commitment[] = []) {
  let round = 0;
  const delivered: PresenceNotice[] = [];
  const gatherCommitments = vi.fn(async () => commitments);
  const deps: PresenceTransitionSweepDeps = {
    gather: async () => rounds[Math.min(round++, rounds.length - 1)] ?? [],
    gatherCommitments,
    // Preserve the production seam's fail-open behavior without falling through
    // to the real fleet-assignment/PG reader in cases that do not need a state
    // transition recheck.
    currentObservation: async () => ({ sessionState: null }),
    deliver: async (n) => {
      delivered.push(n);
    },
  };
  return { deps, delivered, gatherCommitments };
}

function parkedAwait(expiresAtMs: number) {
  return {
    subscriberId: 'peer',
    eventKey: 'dependency:ready',
    note: null,
    expiresTs: new Date(expiresAtMs).toISOString(),
    timeoutBehavior: 'wake' as const,
    createdAt: new Date(expiresAtMs - 1_000).toISOString(),
    rootId: null,
    boundTo: null,
    once: true,
  };
}

beforeEach(() => {
  __resetPresenceTransitionSnapshotForTests();
});

describe('runPresenceTransitionSweep', () => {
  it('the first sweep establishes a baseline and alerts nobody', async () => {
    const { deps, delivered } = harness([[obs('peer', 'ended')]]);
    expect(await runPresenceTransitionSweep(deps)).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('delivers ONE line to the agent whose commitment the death voided', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply', detail: 'msg-1' }],
    );
    expect(await runPresenceTransitionSweep(deps)).toBe(0); // baseline
    expect(await runPresenceTransitionSweep(deps)).toBe(1); // the crossing
    expect(delivered).toHaveLength(1);
    expect(delivered[0].receiverId).toBe('me');
    expect(delivered[0].summary).toContain('is DEAD');
  });

  it('defers a suspect notice through a declared one-shot wake deadline, then alerts', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'suspect')], [obs('peer', 'suspect')], [obs('peer', 'suspect')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply', detail: 'msg-1' }],
    );
    const deadlineMs = 3_000;
    let nowMs = 1_000;
    deps.now = () => nowMs;
    deps.listParkedAwaits = vi.fn(async (subscriberIds) => {
      expect(subscriberIds).toEqual(['peer']);
      return [parkedAwait(deadlineMs)];
    });
    deps.currentObservation = async () => ({ sessionState: 'suspect' });

    expect(await runPresenceTransitionSweep(deps)).toBe(0); // baseline
    expect(await runPresenceTransitionSweep(deps)).toBe(0); // deferred
    expect(delivered).toEqual([]);
    nowMs = deadlineMs - 1;
    expect(await runPresenceTransitionSweep(deps)).toBe(0); // still before timeout
    expect(delivered).toEqual([]);
    nowMs = deadlineMs;
    expect(await runPresenceTransitionSweep(deps)).toBe(1); // timeout reached
    expect(delivered).toHaveLength(1);
    expect(delivered[0].summary).toContain('NOT RESPONDING');
  });

  it('keeps ended alerts immediate even when the subject has a bounded wake wait', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply', detail: 'msg-1' }],
    );
    const listParkedAwaits = vi.fn(async () => [parkedAwait(Date.now() + 60_000)]);
    deps.listParkedAwaits = listParkedAwaits;
    deps.currentObservation = async () => ({ sessionState: 'ended' });

    expect(await runPresenceTransitionSweep(deps)).toBe(0); // baseline
    expect(await runPresenceTransitionSweep(deps)).toBe(1);
    expect(listParkedAwaits).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].summary).toContain('is DEAD');
  });

  it('suppresses a queued DEAD notice when the peer re-registers live before delivery', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply', detail: 'msg-1' }],
    );
    const currentObservation = vi.fn(async () => ({ sessionState: 'live' }));
    deps.currentObservation = currentObservation;

    await runPresenceTransitionSweep(deps);
    expect(await runPresenceTransitionSweep(deps)).toBe(0);
    expect(delivered).toEqual([]);
    expect(currentObservation).toHaveBeenCalledWith('peer');
  });

  it('a crossing with NO intersecting commitment costs nothing and says nothing', async () => {
    const { deps, delivered, gatherCommitments } = harness([[obs('peer', 'live')], [obs('peer', 'ended')]], []);
    await runPresenceTransitionSweep(deps);
    expect(await runPresenceTransitionSweep(deps)).toBe(0);
    expect(delivered).toEqual([]);
    // The commitment read DID run (there was a crossing to resolve)…
    expect(gatherCommitments).toHaveBeenCalledTimes(1);
  });

  it('a QUIET sweep never reads commitments at all — the cost stops at the diff', async () => {
    // The overwhelmingly common case, and the reason a per-minute sweep is cheap.
    const { deps, gatherCommitments } = harness([[obs('peer', 'live')], [obs('peer', 'live')]]);
    await runPresenceTransitionSweep(deps);
    await runPresenceTransitionSweep(deps);
    expect(gatherCommitments).not.toHaveBeenCalled();
  });

  it('does not re-alert on every later sweep while the peer stays dead', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')], [obs('peer', 'ended')], [obs('peer', 'ended')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply' }],
    );
    await runPresenceTransitionSweep(deps);
    await runPresenceTransitionSweep(deps);
    await runPresenceTransitionSweep(deps);
    await runPresenceTransitionSweep(deps);
    expect(delivered).toHaveLength(1); // exactly one, not one per sweep
  });

  it('advances the snapshot even when delivery THROWS, so a failure cannot re-fire forever', async () => {
    const { deps } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')], [obs('peer', 'ended')]],
      [{ receiverId: 'me', subjectId: 'peer', kind: 'awaiting-reply' }],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    deps.deliver = async () => {
      calls += 1;
      throw new Error('rail down');
    };
    await runPresenceTransitionSweep(deps);
    expect(await runPresenceTransitionSweep(deps)).toBe(0); // threw ⇒ nothing delivered
    await runPresenceTransitionSweep(deps);
    expect(calls).toBe(1); // the edge was consumed, not retried every sweep
    warn.mockRestore();
  });

  it('one undeliverable line does not swallow the rest', async () => {
    const { deps, delivered } = harness(
      [[obs('peer', 'live')], [obs('peer', 'ended')]],
      [
        { receiverId: 'r1', subjectId: 'peer', kind: 'awaiting-reply' },
        { receiverId: 'r2', subjectId: 'peer', kind: 'awaiting-reply' },
      ],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok: PresenceNotice[] = [];
    deps.deliver = async (n) => {
      if (n.receiverId === 'r1') throw new Error('nope');
      ok.push(n);
    };
    await runPresenceTransitionSweep(deps);
    expect(await runPresenceTransitionSweep(deps)).toBe(1);
    expect(ok.map((n) => n.receiverId)).toEqual(['r2']);
    warn.mockRestore();
    expect(delivered).toEqual([]); // deliver was replaced
  });

  it('an UNFLEETED agent is covered — the case the fleet feed drops by design', async () => {
    // gatherPresenceObservations deliberately does not filter on fleetSlug; this
    // asserts the sweep body treats such an agent like any other.
    const { deps, delivered } = harness(
      [[obs('solo', 'live')], [obs('solo', 'ended')]],
      [{ receiverId: 'me', subjectId: 'solo', kind: 'blocked-on-lock', detail: 'src/x.ts' }],
    );
    await runPresenceTransitionSweep(deps);
    await runPresenceTransitionSweep(deps);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].summary).toContain('queued behind their lock');
  });
});
