/**
 * WI-10005287 — the pre-admission stall leg must count sockets on THIS topic.
 *
 * `computeHasStalledLogs` leg (b) reports a stall when no remote log is admitted
 * while a live connection exists. It used to receive `liveConnectionCount`, the
 * shared swarm's whole socket set. One Hyperswarm socket per peer serves every
 * topic in the process, so a peer connected for OTHER harnesses held leg (b)
 * true forever on each topic it does not share. Measured on bg-host
 * 2026-10-02 (CDP trace on the hasStalledLogs closure, 20 s, 712 calls): 48 of
 * 89 joins had admitted = own log only, one socket, this topic's announce
 * channel created locally but never opened, and that socket's channels open on
 * 2 other topics.
 *
 * `isTopicStallCandidateSocket` / `SwarmHandle.topicStallCandidateCount` are the
 * topic-scoped replacement. These tests pin both sides of the rule: the measured
 * not-a-participant case stops counting, and EI-18665254552552477's dead data
 * path (no channel ever opened on the socket) still counts.
 *
 * Fake muxer: protomux's (protocol, id)-keyed channels (same pattern as
 * content-peer-count.test.ts), except `open()` fires `onopen` only for topics
 * the simulated remote participates in. Real Protomux fires `onopen` only once
 * the remote has opened the same (protocol, id), so a topic the remote never
 * joined stays created-but-unopened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  isTopicStallCandidateSocket,
  joinHarnessSwarm,
  openAnnounceChannel,
  type HyperswarmLike,
  _setSharedSwarmForTests,
} from '../swarm';
import { _setSwarmGuardForTests } from '../swarm-guard';
import type { SignedAnnounce } from '../announce';

function announce(logCoreKey: string): SignedAnnounce {
  return {
    device_pubkey: 'AAAA',
    github_user_id: 1,
    github_login: 'tester',
    attestation_gist_id: 'gist',
    log_core_key: logCoreKey,
    ts: Date.now(),
    sig: 'sig',
  };
}

/** A peer socket whose remote has joined exactly `remoteTopics`. */
function peerSocket(remoteTopics: Buffer[]): { userData: unknown; pipe: () => void } {
  const remote = new Set(remoteTopics.map((t) => t.toString('hex')));
  const channels = new Map<string, { opened: boolean }>();
  const mux = {
    isProtomux: true as const,
    createChannel(opts: { protocol: string; id?: Buffer | null; onopen?: () => void }) {
      const idHex = opts.id ? Buffer.from(opts.id).toString('hex') : '';
      const key = `${opts.protocol}##${idHex}`;
      if (channels.get(key)?.opened) return null; // protomux `unique` default
      const ch = {
        opened: false,
        addMessage() {
          return { send: () => {} };
        },
        open() {
          if (remote.has(idHex)) {
            ch.opened = true;
            opts.onopen?.();
          }
        },
        close() {},
      };
      channels.set(key, ch);
      return ch;
    },
    pair(): void {
      /* lazy-accept notifier — the remote-initiated path is not exercised here */
    },
  };
  return { userData: mux, pipe: vi.fn() };
}

function topic(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

function fakeSharedSwarm(connections: Set<unknown>): HyperswarmLike {
  const swarm: HyperswarmLike = {
    join() {
      return { flushed: () => Promise.resolve() };
    },
    leave() {},
    on() {
      return swarm;
    },
    off() {
      return swarm;
    },
  };
  (swarm as { connections?: Iterable<unknown> }).connections = connections;
  return swarm;
}

function fakeStore(): Corestore {
  return { replicate: () => ({ pipe: vi.fn() }) } as unknown as Corestore;
}

afterEach(() => {
  _setSharedSwarmForTests(null);
  _setSwarmGuardForTests(null);
});

describe('isTopicStallCandidateSocket (WI-10005287)', () => {
  it('counts a socket with no muxer state (minimal fakes keep the old behaviour)', () => {
    expect(isTopicStallCandidateSocket({ pipe: vi.fn() }, topic(1).toString('hex'))).toBe(true);
    expect(isTopicStallCandidateSocket(null, topic(1).toString('hex'))).toBe(true);
  });

  it('measured bg-host shape: a socket paired on another topic does NOT count for a topic its peer never opened', () => {
    const shared = topic(11);
    const notShared = topic(12);
    const socket = peerSocket([shared]);
    openAnnounceChannel(socket, shared, { ourAnnounce: announce('log-shared') });
    openAnnounceChannel(socket, notShared, { ourAnnounce: announce('log-not-shared') });

    expect(isTopicStallCandidateSocket(socket, shared.toString('hex'))).toBe(true);
    expect(isTopicStallCandidateSocket(socket, notShared.toString('hex'))).toBe(false);
  });

  it('EI-18665254552552477 kept: a socket that has paired NO channel at all still counts for every topic', () => {
    // Established socket, zero inbound frames: nothing can open, and we cannot
    // tell which topic it is for, so the pre-admission stall must stay armed.
    const a = topic(21);
    const b = topic(22);
    const silent = peerSocket([]);
    openAnnounceChannel(silent, a, { ourAnnounce: announce('log-a') });
    openAnnounceChannel(silent, b, { ourAnnounce: announce('log-b') });

    expect(isTopicStallCandidateSocket(silent, a.toString('hex'))).toBe(true);
    expect(isTopicStallCandidateSocket(silent, b.toString('hex'))).toBe(true);
  });
});

describe('SwarmHandle.topicStallCandidateCount (WI-10005287)', () => {
  it('is topic-scoped while liveConnectionCount stays swarm-wide', async () => {
    const shared = topic(31);
    const notShared = topic(32);
    // One healthy peer that joined only `shared`, one silent peer (dead data path).
    const healthy = peerSocket([shared]);
    const silent = peerSocket([]);
    const connections = new Set<unknown>([healthy, silent]);
    const swarm = fakeSharedSwarm(connections);

    const onShared = await joinHarnessSwarm({
      store: fakeStore(),
      topic: shared,
      swarm,
      ourAnnounce: announce('log-shared'),
    });
    const onNotShared = await joinHarnessSwarm({
      store: fakeStore(),
      topic: notShared,
      swarm,
      ourAnnounce: announce('log-not-shared'),
    });

    // Both handles see the same two shared sockets...
    expect(onShared.liveConnectionCount).toBe(2);
    expect(onNotShared.liveConnectionCount).toBe(2);
    // ...but only `shared` has the healthy peer as a participant. The silent
    // socket counts on both because it has paired nothing anywhere.
    expect(onShared.topicStallCandidateCount).toBe(2);
    expect(onNotShared.topicStallCandidateCount).toBe(1);

    // Once the silent peer goes away, the not-shared topic has no candidate
    // socket left, so leg (b) can no longer hold it stalled.
    connections.delete(silent);
    expect(onNotShared.liveConnectionCount).toBe(1);
    expect(onNotShared.topicStallCandidateCount).toBe(0);
    expect(onShared.topicStallCandidateCount).toBe(1);

    await onShared.close();
    await onNotShared.close();
  });
});
