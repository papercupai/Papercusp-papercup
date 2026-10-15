/**
 * replication-liveness.test.ts — P-004 (WI-1840, WI-183 class).
 *
 * The detector that makes connected-but-dead replication VISIBLE: per-log
 * registry verdicts (no_replicator / frozen / sampling_stale), edge-triggered
 * stall episodes, the health-verdict input, and the durable-EI dedup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sampleReplicationLiveness,
  getReplicationLiveness,
  dropReplicationLogState,
  dropReplicationLiveness,
  setReplicationStallRecoveryReporterForTests,
  setOpenStallEiProbeForTests,
  setReplicationRepairHandler,
  setDhtUniverseAssertion,
  touchReplicationLivenessSamples,
  _resetReplicationLivenessForTests,
  SAMPLING_STALE_AFTER_MS,
  SWARM_CHURN_TOLERANCE_MS,
  type ReplicationStallEpisode,
} from '../replication-liveness';
import {
  fileReplicationStallEi,
  resolveReplicationStallEi,
  replicationStallEiTitle,
  _resetReplicationStallEiForTests,
  type ReplicationStallEiDeps,
  type StallEiEpisode,
} from '../replication-stall-ei';
import { assessHarnessSubstrateHealth } from '../health';
import {
  _resetBootHistoryForTests,
  _setMirrorForTests,
  _setNowForTests,
  _setPgWriteForTests,
  type BootHistoryEntry,
} from '../boot-history';

const WS = 'ws-1';
const HS = 'harness-a';
const KEY = 'a'.repeat(64);
const GRACE = 10_000;

afterEach(() => {
  _resetReplicationLivenessForTests();
  _resetReplicationStallEiForTests();
});

function collect(): { episodes: ReplicationStallEpisode[]; on: (e: ReplicationStallEpisode) => void } {
  const episodes: ReplicationStallEpisode[] = [];
  return { episodes, on: (e) => episodes.push(e) };
}

describe('WI-10007965: retained replication episode transitions', () => {
  let writes: BootHistoryEntry[];
  let now: number;

  beforeEach(() => {
    writes = [];
    now = 1_000_000;
    _resetBootHistoryForTests();
    _setNowForTests(() => now);
    _setMirrorForTests(() => {});
    _setPgWriteForTests((entry) => writes.push(entry));
    setOpenStallEiProbeForTests(async () => false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetBootHistoryForTests();
    vi.restoreAllMocks();
  });

  function sample(peers: number, length = 5, position = 5): void {
    // Exercise the production reporters, not the per-call callback overrides.
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: length, mergedPosition: position, peersCount: peers },
      { graceMs: GRACE, nowMs: now },
    );
  }

  it('retains keyed start/end/re-stall edges without periodic duplicates or registry dependence', () => {
    sample(1);
    now += GRACE + 1;
    sample(0);
    sample(0);
    now += 1;
    sample(1);
    now += GRACE + 1;
    sample(0);

    expect(writes.map((entry) => entry.kind)).toEqual([
      'replication_episode_started',
      'replication_condition_ended',
      'replication_episode_started',
    ]);
    expect(writes.map((entry) => entry.ts)).toEqual([1_010_001, 1_010_002, 1_020_003]);
    for (const entry of writes) {
      expect(entry).toMatchObject({ workspaceId: WS, harnessSlug: HS });
      expect(JSON.parse(entry.message!)).toMatchObject({
        logKeyHex: KEY,
        detectorKind: 'no_replicator',
        stalledForMs: expect.any(Number),
        detail: expect.any(String),
      });
    }

    _resetReplicationLivenessForTests();
    _resetBootHistoryForTests();
    expect(getReplicationLiveness()).toEqual([]);
    expect(writes).toHaveLength(3); // the handed-off durable records survive both rings
  });

  it('records frozen ending on detachment without claiming healthy replication', () => {
    sample(1, 10, 5);
    now += GRACE + 1;
    sample(1, 10, 5);
    sample(0, 10, 5);
    sample(0, 10, 5);

    expect(writes.map((entry) => entry.kind)).toEqual([
      'replication_episode_started',
      'replication_condition_ended',
    ]);
    expect(JSON.parse(writes[1]!.message!)).toMatchObject({
      logKeyHex: KEY,
      detectorKind: 'frozen',
      detail: expect.stringContaining('replicator detached'),
    });
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.peersCount).toBe(0);
  });

  it('still detects and recovers when the durable history sink throws', () => {
    _setPgWriteForTests(() => { throw new Error('history sink unavailable'); });
    sample(1);
    now += GRACE + 1;
    expect(() => sample(0)).not.toThrow();
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('no_replicator');
    expect(() => sample(1)).not.toThrow();
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
  });
});

describe('no_replicator axis (the original WI-183 symptom)', () => {
  it('fires ONCE per stall episode after grace, only for a log that WAS replicating; clears + re-fires on recovery→re-stall', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (peers: number, len = 5, pos = 5) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );

    sample(1); // was replicating
    now += 1_000;
    sample(0); // detached
    expect(episodes).toHaveLength(0); // within grace
    now += GRACE; // past grace
    sample(0);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('no_replicator');
    now += 5_000;
    sample(0); // still stalled — edge-triggered, no re-fire
    expect(episodes).toHaveLength(1);

    // Recovery clears the latch…
    now += 1_000;
    sample(2);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
    // …and a LATER stall fires a fresh episode.
    now += 1_000;
    sample(0);
    now += GRACE;
    sample(0);
    expect(episodes).toHaveLength(2);
  });

  it('NEVER alarms for a log that has never shown a replicator peer (ordinary offline churn)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 3, mergedPosition: 0, peersCount: 0 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now - 1, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'never_connected',
    );
  });

  describe('EI-7110: onRecovery fires ONLY on a genuine alarm→recovered transition', () => {
    function collectRecovery(): {
      recoveries: ReplicationStallEpisode[];
      onRecovery: (e: ReplicationStallEpisode) => void;
    } {
      const recoveries: ReplicationStallEpisode[] = [];
      return { recoveries, onRecovery: (e) => recoveries.push(e) };
    }

    it('fires once when a log that alarmed no_replicator regains a live peer, with the stall duration', () => {
      const { episodes, on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      let now = 1_000_000;
      const sample = (peers: number) =>
        sampleReplicationLiveness(
          WS,
          HS,
          { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
          { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery },
        );

      sample(1); // was replicating
      now += 1_000;
      sample(0); // detached
      now += GRACE; // past grace — alarms
      sample(0);
      expect(episodes).toHaveLength(1);
      expect(recoveries).toHaveLength(0); // still down, nothing recovered yet

      now += 20_000;
      sample(3); // regains a peer
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0]!.kind).toBe('no_replicator');
      expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE + 20_000);
      expect(recoveries[0]!.detail).toContain('regained a live replicator peer');

      // A later re-stall + re-recovery fires again (edge-triggered both ways).
      now += 1_000;
      sample(0);
      now += GRACE;
      sample(0);
      now += 1_000;
      sample(1);
      expect(recoveries).toHaveLength(2);
    });

    it('never fires for ordinary flapping that never crossed the alarm threshold', () => {
      const { on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      let now = 1_000_000;
      const sample = (peers: number) =>
        sampleReplicationLiveness(
          WS,
          HS,
          { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
          { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery },
        );

      sample(1);
      now += 1_000;
      sample(0); // detaches
      now += 2_000; // well within grace
      sample(1); // reconnects before ever alarming
      expect(recoveries).toHaveLength(0);
    });

    it('never fires for a log that never had a live replicator peer (nothing to recover from)', () => {
      const { on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 3, mergedPosition: 0, peersCount: 1 },
        { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: on, onRecovery },
      );
      expect(recoveries).toHaveLength(0);
    });
  });
});

// EI-18778631943888326: a frozen episode used to say, unconditionally, "replicator
// attached but ingest frozen" — naming the REPLICATOR as the suspect. That is only ONE
// of two causes. During the WI-559 diagnosis it was the WRONG one: replication was
// healthy (the peer was streaming) while the MERGE PASS aborted every ~60s on an FK
// violation, so mergedPosition never moved. The alarm pointed at the replicator/swarm
// layer while the defect sat in apply.
//
// `knownLength` is the writer length AS KNOWN TO OUR REPLICA, so it advances only when
// replication is actually delivering — a free discriminator from data already sampled.
// These pin BOTH attributions. Teeth: hard-coding stalledStage to 'transport' (the old
// unconditional reading) flips the first test red.
describe('frozen axis — stage attribution (transport vs apply)', () => {
  const frozenSampler = (on: (e: ReplicationStallEpisode) => void) => {
    let now = 1_000_000;
    return {
      at: (len: number, pos: number, advanceMs = 0) => {
        now += advanceMs;
        sampleReplicationLiveness(
          WS,
          HS,
          { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: 1 },
          { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
        );
      },
    };
  };

  it("attributes to APPLY when the writer length ADVANCED during the stall (replication is delivering)", () => {
    const { episodes, on } = collect();
    const s = frozenSampler(on);
    s.at(10, 4); // seed the progress clock
    s.at(15, 4, GRACE / 2); // delivery observed: writer length moved, merge did NOT
    s.at(20, 4, GRACE / 2 + 1); // grace elapsed with zero merge progress ⇒ alarm

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen'); // still the same axis — no alarm is lost
    expect(episodes[0]!.stalledStage).toBe('apply');
    const detail = episodes[0]!.detail;
    expect(detail).toContain('APPLY/MERGE frozen');
    expect(detail).toContain('DELIVERING');
    expect(detail).toContain('NOT the'); // "...NOT the replicator or swarm"
    // The old, misleading wording must be gone from this branch.
    expect(detail).not.toContain('replicator attached but ingest frozen');
  });

  it('attributes to TRANSPORT when the writer length never advanced (classic attached-but-dead)', () => {
    const { episodes, on } = collect();
    const s = frozenSampler(on);
    s.at(10, 4);
    s.at(10, 4, GRACE); // nothing moved at all — blocks are not flowing

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.stalledStage).toBe('transport');
    expect(episodes[0]!.detail).toContain('NOT DELIVERING');
    expect(episodes[0]!.detail).toContain('replicator/swarm');
    // Must NOT blame apply when we have no evidence replication delivered anything.
    expect(episodes[0]!.detail).not.toContain('APPLY/MERGE frozen');
  });

  it('a writer length that advanced only BEFORE the stall window does not count as delivering', () => {
    // The discriminator must be scoped to THIS stall, not "ever delivered". A log that
    // received updates earlier and then went dark is a TRANSPORT freeze; reading any
    // historical delivery as evidence would mis-route it to apply forever.
    const { episodes, on } = collect();
    const s = frozenSampler(on);
    s.at(10, 8); // caught-up-ish, delivery happening
    s.at(14, 14); // merge keeps up — advances BOTH clocks, no backlog
    s.at(20, 14, 1_000); // now behind: this observation starts a fresh freeze window
    s.at(20, 14, GRACE + 1); // nothing moves through the whole window

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.stalledStage).toBe('transport');
  });
});

describe('frozen axis (attached-but-dead: replicator present, ingest not flowing)', () => {
  it('fires once when the writer is ahead and merge position makes no progress past grace, with peers attached', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (len: number, pos: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: 1 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );

    sample(10, 4); // behind — first sight seeds the progress clock (no instant alarm)
    expect(episodes).toHaveLength(0);
    now += GRACE;
    sample(10, 4); // still behind, zero progress for a whole grace window
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    now += 1_000;
    sample(12, 4); // still frozen (writer pulls further ahead) — no re-fire
    expect(episodes).toHaveLength(1);

    // Ingest progress clears the latch.
    now += 1_000;
    sample(12, 9);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
  });

  it('reports a behind-head log as queued/live instead of falsely frozen', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const HEAD = 'b'.repeat(64);
    const sampleQueued = () =>
      sampleReplicationLiveness(
        WS,
        HS,
        {
          keyHex: KEY,
          knownLength: 62_356,
          localLength: 62_356,
          mergedPosition: 62_256,
          peersCount: 1,
          mergeQueueIndex: 1,
          mergeQueueHeadKeyHex: HEAD,
        },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );

    sampleQueued();
    now += GRACE * 2;
    sampleQueued();

    expect(episodes.filter((e) => e.kind === 'frozen')).toHaveLength(0);
    const view = getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!;
    const row = view.logs[0]!;
    expect(row.verdict).toBe('live');
    expect(row.localLength).toBe(62_356);
    expect(row.mergeQueueIndex).toBe(1);
    expect(row.mergeQueueHeadKeyHex).toBe(HEAD);
    expect(row.msSinceMergeQueueHead).toBeNull();
    // WI-6873: a live-but-behind log must report its ops-behind count and be
    // counted in the harness-level catchingUp rollup — this is exactly the
    // "still catching up" signal that was previously indistinguishable from
    // a fully-caught-up 'live' row.
    expect(row.backlogOps).toBe(100);
    expect(view.counts.catchingUp).toBe(1);
  });

  it('WI-6873: a fully caught-up live log reports zero backlog and is not counted as catching up', () => {
    const { on } = collect();
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 500, localLength: 500, mergedPosition: 500, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
    );
    const view = getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!;
    expect(view.logs[0]!.verdict).toBe('live');
    expect(view.logs[0]!.backlogOps).toBe(0);
    expect(view.counts.catchingUp).toBe(0);
  });

  it('WI-6873: backlogOps is nulled on a sampling_stale row, same convention as the other derived fields', () => {
    const { on } = collect();
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 700_000, localLength: 100_000, mergedPosition: 100_000, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
    );
    now += SAMPLING_STALE_AFTER_MS + 1_000;
    const view = getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!;
    expect(view.logs[0]!.verdict).toBe('sampling_stale');
    expect(view.logs[0]!.backlogOps).toBeNull();
    expect(view.counts.catchingUp).toBe(0);
  });

  it('starts a fresh frozen grace window when a queued log becomes merge head', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const HEAD = 'b'.repeat(64);
    const sample = (mergeQueueIndex: number, mergeQueueHeadKeyHex: string) =>
      sampleReplicationLiveness(
        WS,
        HS,
        {
          keyHex: KEY,
          knownLength: 62_356,
          mergedPosition: 62_256,
          peersCount: 1,
          mergeQueueIndex,
          mergeQueueHeadKeyHex,
        },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );

    sample(1, HEAD);
    now += GRACE * 2;
    sample(0, KEY);
    expect(episodes).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'live',
    );

    now += GRACE;
    sample(0, KEY);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
  });

  // WI-38376: `frozenGraceMs` — the frozen axis's OWN grace, mirroring the
  // WI-5686 split that gave the zombie axis one.
  //
  // Why it exists: the rig shortens ONLY the zombie grace, so `frozen` kept the
  // 180s production default — 2x replication_soak's 90s SLA. On full-matrix run
  // m1786592636 a real A→B stall therefore produced ZERO detector events on all
  // three frames: the scenario gave up at 90s, and the one axis that covers
  // "replicator attached, writer ahead, nothing arriving" needed 180s.
  //
  // The pair of assertions below is the whole point — a frozenGraceMs that was
  // simply ignored would still pass the first one on its own.
  it('fires on frozenGraceMs, not graceMs, when the two differ', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const FROZEN_GRACE = GRACE / 2;
    const sample = () =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 10, mergedPosition: 4, peersCount: 1 },
        {
          graceMs: GRACE,
          frozenGraceMs: FROZEN_GRACE,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: () => {},
        },
      );

    sample(); // seeds the progress clock
    expect(episodes).toHaveLength(0);
    now += FROZEN_GRACE;

    // Prove the READ path honors the shorter frozen grace before the sampler
    // has had a chance to latch alarmedFrozen. If getReplicationLiveness still
    // used graceMs here, this would incorrectly report live.
    expect(
      getReplicationLiveness({ nowMs: now, graceMs: GRACE, frozenGraceMs: FROZEN_GRACE })[0]!
        .logs[0]!.verdict,
    ).toBe('frozen');

    sample();
    // Fired at the SHORTER window: had the axis still read `graceMs`, nothing
    // would have fired here — this is the SLA-miss case that went unreported.
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
  });

  it('leaves the frozen axis on graceMs when frozenGraceMs is omitted', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = () =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 10, mergedPosition: 4, peersCount: 1 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );

    sample();
    now += GRACE / 2;
    sample(); // half a grace window — must NOT fire for an omitted override
    expect(episodes).toHaveLength(0);
    now += GRACE / 2;
    sample();
    expect(episodes).toHaveLength(1);
  });

  // The safety property that makes shortening this axis in the rig sound: the
  // WI-5672/WI-5686 false-positive class came from a cold restart legitimately
  // holding 0 peers past a short grace. `frozen` requires peersCount > 0, so a
  // 0-peer re-peer window cannot arm it however short frozenGraceMs is set.
  it('never fires with zero peers, however short frozenGraceMs is', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 10, mergedPosition: 4, peersCount: 0 },
        { graceMs: GRACE, frozenGraceMs: 1, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
      now += GRACE;
    }
    expect(episodes.filter((e) => e.kind === 'frozen')).toHaveLength(0);
  });

  it('a caught-up idle log never freezes (idle writer ≠ dead replication)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 4; i += 1) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 7, mergedPosition: 7, peersCount: 1 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    // …and a backlog appearing AFTER long idleness gets a fresh grace window.
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 9, mergedPosition: 7, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    expect(episodes).toHaveLength(0);
  });

  it('does not freeze-alarm while no replicator is attached (that is the other axis)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 2, peersCount: 0 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    now += GRACE * 2;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 2, peersCount: 0 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    expect(episodes.filter((e) => e.kind === 'frozen')).toHaveLength(0);
  });

  // EI-4643: the frozen axis must REPORT recovery (not just reset its latch) so
  // the durable EI a frozen episode filed auto-closes — previously only the
  // no_replicator axis was wired for onRecovery.
  it('reports recovery with kind=frozen once ingest resumes after a freeze alarm', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (len: number, pos: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: 1 },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: (e) => episodes.push(e),
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(10, 4); // behind — seeds the progress clock
    now += GRACE;
    sample(10, 4); // zero progress for a whole grace window → frozen alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    expect(recoveries).toHaveLength(0);

    now += 3_000;
    sample(10, 9); // ingest resumes → recovery reported (auto-closes the EI)
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('frozen');
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('ingest resumed');

    // No spurious recovery for a freeze that never crossed the alarm grace.
    recoveries.length = 0;
    now += 1_000;
    sample(12, 9); // becomes behind — fresh window, no alarm
    now += 1_000;
    sample(12, 12); // catches up before ever alarming
    expect(recoveries).toHaveLength(0);
  });

  // EI-7834: a FROZEN log whose replicator DETACHES (peers → 0) must report a
  // frozen recovery so its durable EI auto-closes. The frozen-recovery path only
  // fires on ingest-progress / caught-up, neither of which can happen with 0
  // peers, so before this the frozen latch stayed set and the frozen EI orphaned
  // open forever (observed pile-up: log 298a676c froze, then lost its replicator —
  // the no_replicator/zombie EIs cycled but the frozen EI never resolved).
  it('reports recovery with kind=frozen when the replicator detaches (peers→0) after a freeze alarm', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (len: number, pos: number, peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: peers },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: (e) => episodes.push(e),
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(10, 4, 1); // behind, replicator attached — seeds the progress clock
    now += GRACE;
    sample(10, 4, 1); // zero ingest for a whole grace window → frozen alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    expect(recoveries).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'frozen',
    );

    // The replicator detaches while still frozen. The frozen premise (attached)
    // is gone → exactly ONE frozen recovery fires (so the EI auto-closes), and the
    // frozen latch clears (the verdict no longer reads 'frozen').
    now += 2_000;
    sample(10, 4, 0);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('frozen');
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('replicator detached');
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).not.toBe(
      'frozen',
    );

    // No double-report: staying detached does not re-fire the frozen recovery,
    // and the now-detached log settles into the no_replicator axis past grace.
    now += GRACE;
    sample(10, 4, 0);
    expect(recoveries.filter((r) => r.kind === 'frozen')).toHaveLength(1);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'no_replicator',
    );
  });

  it('a behind log that never crossed the freeze grace fires NO frozen recovery when its replicator detaches', () => {
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 10, mergedPosition: 4, peersCount: peers },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: () => {},
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(1); // behind, attached — but never held past grace
    now += 2_000; // well within grace
    sample(0); // replicator detaches before ever freeze-alarming
    expect(recoveries.filter((r) => r.kind === 'frozen')).toHaveLength(0);
  });
});

describe('read-time verdicts + registry lifecycle', () => {
  it('reports sampling_stale when the merge loop stops feeding the registry', () => {
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    now += SAMPLING_STALE_AFTER_MS;
    const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE });
    expect(h!.logs[0]!.verdict).toBe('sampling_stale');
    expect(h!.counts.samplingStale).toBe(1);
  });

  describe('EI-19328421457282435: a stale row cannot be mistaken for a live one', () => {
    it('nulls every live-looking field once the row goes sampling_stale, and marks it unmissably', () => {
      const sampleAt = 1_000_000;
      sampleReplicationLiveness(
        WS,
        HS,
        {
          keyHex: KEY,
          knownLength: 630251,
          mergedPosition: 600962,
          peersCount: 1,
          mergeQueueIndex: 0,
          mergeQueueHeadKeyHex: KEY,
          swarmConnections: 2,
        },
        { graceMs: GRACE, nowMs: sampleAt },
      );
      // Still fresh: every field reads live, `stale` is false, `sampledAt`
      // pins the exact sample time.
      const [freshHarness] = getReplicationLiveness({ nowMs: sampleAt, graceMs: GRACE });
      const freshRow = freshHarness!.logs[0]!;
      expect(freshRow.stale).toBe(false);
      expect(freshRow.sampledAt).toBe(sampleAt);
      expect(freshRow.knownLength).toBe(630251);
      expect(freshRow.mergedPosition).toBe(600962);

      // Two reads of the SAME frozen sample, 20 minutes apart — the exact
      // shape of the incident: an investigator polling twice and diffing
      // mergedPosition/knownLength across the gap.
      const readOne = sampleAt + SAMPLING_STALE_AFTER_MS + 1;
      const readTwo = readOne + 20 * 60 * 1000;
      for (const readAt of [readOne, readTwo]) {
        const [h] = getReplicationLiveness({ nowMs: readAt, graceMs: GRACE });
        const row = h!.logs[0]!;
        expect(row.verdict).toBe('sampling_stale');
        expect(row.stale).toBe(true);
        // `sampledAt` is identical across both reads — the unmissable tell
        // that this is ONE frozen sample, not two live observations.
        expect(row.sampledAt).toBe(sampleAt);
        // Every field the false root cause was built on diffing must be
        // null, so there is nothing left to compare across the two reads.
        expect(row.knownLength).toBeNull();
        expect(row.localLength).toBeNull();
        expect(row.mergedPosition).toBeNull();
        expect(row.peersCount).toBeNull();
        expect(row.msSinceReplicatorSeen).toBeNull();
        expect(row.msSinceIngestProgress).toBeNull();
        expect(row.mergeQueueIndex).toBeNull();
        expect(row.mergeQueueHeadKeyHex).toBeNull();
        expect(row.msSinceMergeQueueHead).toBeNull();
        expect(row.lastSwarmConnections).toBeNull();
        // The staleness signal itself remains live and accurate.
        expect(row.msSinceSampled).toBe(readAt - sampleAt);
      }
    });
  });

  describe('EI-20453145044075727: touchReplicationLivenessSamples (intra-pass heartbeat)', () => {
    it('a heartbeat inside the dead-man window keeps a legitimately-slow, actively-progressing log off sampling_stale', () => {
      let now = 1_000_000;
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
        { graceMs: GRACE, nowMs: now },
      );
      // A single merge pass over a large backlog can legitimately run past
      // SAMPLING_STALE_AFTER_MS without sampleReplicationLiveness being fed
      // again — but the fold's own onCursorAdvance hook fires meanwhile.
      now += SAMPLING_STALE_AFTER_MS - 1;
      touchReplicationLivenessSamples(WS, HS, [KEY], { nowMs: now });
      // Now push PAST another full dead-man window from the heartbeat. Without
      // the fix this would already have read sampling_stale at `now` above;
      // with it, the clock only just restarted at the heartbeat.
      now += SAMPLING_STALE_AFTER_MS - 1;
      const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE });
      expect(h!.logs[0]!.verdict).not.toBe('sampling_stale');
      expect(h!.logs[0]!.verdict).toBe('live');
      expect(h!.counts.samplingStale).toBe(0);
    });

    it('still reports sampling_stale once the heartbeats themselves stop (a genuinely wedged merge loop is not masked)', () => {
      let now = 1_000_000;
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
        { graceMs: GRACE, nowMs: now },
      );
      now += SAMPLING_STALE_AFTER_MS / 2;
      touchReplicationLivenessSamples(WS, HS, [KEY], { nowMs: now });
      // Nothing touches the registry again after this — the dead-man axis must
      // still fire once SAMPLING_STALE_AFTER_MS elapses past the LAST heartbeat.
      now += SAMPLING_STALE_AFTER_MS;
      const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE });
      expect(h!.logs[0]!.verdict).toBe('sampling_stale');
    });

    it('is a safe no-op for a key with no tracked state (never sampled, or already dropped)', () => {
      const now = 1_000_000;
      expect(() =>
        touchReplicationLivenessSamples(WS, HS, [KEY], { nowMs: now }),
      ).not.toThrow();
      // No entry was created — the harness still has zero tracked logs.
      expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })).toHaveLength(0);
    });
  });

  it('filters by workspace/harness, exposes counts, and drops state on revoke/close', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    sampleReplicationLiveness(
      WS,
      'harness-b',
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    expect(getReplicationLiveness({ nowMs: now })).toHaveLength(2);
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })).toHaveLength(1);
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]!.counts.live).toBe(1);

    dropReplicationLogState(WS, HS, KEY); // revoked / re-verify-dropped
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]!.logs).toHaveLength(0);
    dropReplicationLiveness(WS, 'harness-b'); // handle close
    expect(getReplicationLiveness({ harnessSlug: 'harness-b', nowMs: now })).toHaveLength(0);
  });
});

describe('WI-3604: DHT-universe mismatch axis (split-DHT-universe outage class)', () => {
  it('a flagged harness reads dht_universe_mismatch on every log — not no_replicator/frozen', () => {
    const now = 1_000_000;
    // A log that WOULD otherwise read 'frozen' (replicator attached, ingest stalled past grace).
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now + GRACE + 1, onStallEpisode: () => {} },
    );
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'joined the PUBLIC DHT, expected isolated' });
    const [h] = getReplicationLiveness({ nowMs: now + GRACE + 1, graceMs: GRACE, harnessSlug: HS });
    expect(h!.dhtUniverseMismatch).toBe(true);
    expect(h!.dhtUniverseDetail).toMatch(/PUBLIC DHT/);
    expect(h!.logs[0]!.verdict).toBe('dht_universe_mismatch');
    expect(h!.counts.dhtUniverseMismatch).toBe(1);
    expect(h!.counts.frozen).toBe(0);
    expect(h!.counts.noReplicator).toBe(0);
  });

  it('surfaces the mismatch even with ZERO sampled logs (flag set before any admission)', () => {
    setDhtUniverseAssertion(WS, 'harness-empty', { ok: false, detail: 'mismatch, no logs yet' });
    const [h] = getReplicationLiveness({ harnessSlug: 'harness-empty' });
    expect(h!.dhtUniverseMismatch).toBe(true);
    expect(h!.logs).toHaveLength(0);
    expect(h!.counts.dhtUniverseMismatch).toBe(0);
  });

  it('ok:true clears a previously-recorded mismatch (re-join after the fix)', () => {
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'mismatch' });
    expect(getReplicationLiveness({ harnessSlug: HS })[0]!.dhtUniverseMismatch).toBe(true);
    setDhtUniverseAssertion(WS, HS, { ok: true, detail: 'matches' });
    expect(getReplicationLiveness({ harnessSlug: HS })).toHaveLength(0);
  });

  it('feeds assessHarnessSubstrateHealth as a distinct unhealthy reason', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'joined the PUBLIC DHT' });
    const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE, harnessSlug: HS });
    const result = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      replicationLiveness: {
        noReplicator: h!.counts.noReplicator,
        frozen: h!.counts.frozen,
        samplingStale: h!.counts.samplingStale,
        dhtUniverseMismatch: h!.counts.dhtUniverseMismatch,
      },
    });
    expect(result.verdict).toBe('unhealthy');
    expect(result.reasons.join(' ')).toMatch(/DHT-universe mismatch/);
    expect(result.reasons.join(' ')).not.toMatch(/WI-183 class/);
  });
});

describe('EI-7788: dropping an ALARMED log auto-resolves its durable EI (orphan fix)', () => {
  function collectDropRecoveries(): ReplicationStallEpisode[] {
    const recoveries: ReplicationStallEpisode[] = [];
    // The drop path routes through the module-level recovery reporter (no opts arg),
    // so capture it via the module seam rather than a per-call onRecovery.
    setReplicationStallRecoveryReporterForTests((e) => {
      recoveries.push(e);
    });
    return recoveries;
  }

  it('dropReplicationLogState fires a recovery for an alarmed no_replicator log so the EI can auto-close', () => {
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(1); // was replicating
    now += GRACE + 1_000;
    sample(0); // stalled past grace → alarmed + EI filed
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'no_replicator',
    );

    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY); // peer revoked / re-verify-dropped while stalled
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('no_replicator');
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.detail).toContain('dropped from tracking');
    // State is gone regardless.
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]?.logs ?? []).toHaveLength(0);
  });

  it('dropping a HEALTHY (never-alarmed) log fires NO recovery (no spurious EI resolve)', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
    );
    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY);
    expect(recoveries).toHaveLength(0);
  });

  it('dropReplicationLiveness (handle close) fires recoveries for every alarmed log in the harness', () => {
    let now = 1_000_000;
    const KEY_B = 'b'.repeat(64);
    const sample = (key: string, peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: key, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(KEY, 1); // KEY was replicating…
    sample(KEY_B, 1); // KEY_B stays live (no alarm)
    now += GRACE + 1_000;
    sample(KEY, 0); // KEY stalls past grace → alarmed
    sample(KEY_B, 1);

    const recoveries = collectDropRecoveries();
    dropReplicationLiveness(WS, HS); // harness handle close
    // Only the alarmed log (KEY) reports a recovery; the live one (KEY_B) does not.
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.kind).toBe('no_replicator');
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })).toHaveLength(0);
  });

  it('drop is idempotent — a second drop of the same log fires no further recovery', () => {
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(1);
    now += GRACE + 1_000;
    sample(0);
    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY);
    dropReplicationLogState(WS, HS, KEY); // boot.ts double-calls on revoke — must not re-fire
    expect(recoveries).toHaveLength(1);
  });
});

describe('health-verdict input (P-004: stalls flip the harness off healthy)', () => {
  const base = { flagEnabled: true, handlePresent: true } as const;

  it('any no_replicator or frozen log ⇒ unhealthy with a WI-183-class reason', () => {
    const r = assessHarnessSubstrateHealth({
      ...base,
      replicationLiveness: { noReplicator: 1, frozen: 2 },
    });
    expect(r.verdict).toBe('unhealthy');
    expect(r.reasons.join(' ')).toContain('WI-183');
  });

  it('sampler-stale alone degrades (detector blind ≠ proven divergence); zero counts stay healthy', () => {
    expect(
      assessHarnessSubstrateHealth({
        ...base,
        replicationLiveness: { noReplicator: 0, frozen: 0, samplingStale: 1 },
      }).verdict,
    ).toBe('degraded');
    expect(
      assessHarnessSubstrateHealth({
        ...base,
        replicationLiveness: { noReplicator: 0, frozen: 0, samplingStale: 0 },
      }).verdict,
    ).toBe('healthy');
  });
});

describe('durable EI escalation (replication-stall-ei)', () => {
  const episode: ReplicationStallEpisode = {
    workspaceId: WS,
    harnessSlug: HS,
    logKeyHex: KEY,
    kind: 'no_replicator',
    stalledForMs: 200_000,
    detail: 'log=aaaaaaaaaaaa… has had 0 live replicator peers for 200s',
  };

  function fakeDeps(open: Array<{ id?: string; title: string }>): {
    deps: ReplicationStallEiDeps;
    created: Array<{ title: string }>;
    resolved: Array<{ id: string; note: string }>;
  } {
    const created: Array<{ title: string }> = [];
    const resolved: Array<{ id: string; note: string }> = [];
    return {
      created,
      resolved,
      deps: {
        listOpenByTopic: async () => open.map((o) => ({ id: o.id ?? 'EI-OPEN', title: o.title })),
        create: async (input) => {
          created.push({ title: input.title });
          return { id: 'EI-999' };
        },
        resolve: async (id, note) => {
          resolved.push({ id, note });
        },
      },
    };
  }

  it('files a bug EI with the stable dedup title', async () => {
    const { deps, created } = fakeDeps([]);
    const id = await fileReplicationStallEi(episode, deps);
    expect(id).toBe('EI-999');
    expect(created[0]!.title).toBe(replicationStallEiTitle(episode));
  });

  it('dedupes against an already-open EI with the same title', async () => {
    const { deps, created } = fakeDeps([{ title: replicationStallEiTitle(episode) }]);
    const id = await fileReplicationStallEi(episode, deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a different kind for the same log is a DIFFERENT escalation (not deduped)', async () => {
    const { deps, created } = fakeDeps([{ title: replicationStallEiTitle(episode) }]);
    const id = await fileReplicationStallEi({ ...episode, kind: 'frozen' }, deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
  });

  it('WI-2136 drain_orphan_tail files under its own dead-key title + runbook body', async () => {
    const { deps, created } = fakeDeps([]);
    let body = '';
    deps.create = async (input) => {
      created.push({ title: input.title });
      body = input.body;
      return { id: 'EI-999' };
    };
    // logKeyHex is the DEAD prior-era key so distinct dead eras page separately.
    const orphan: StallEiEpisode = {
      ...episode,
      kind: 'drain_orphan_tail',
      logKeyHex: 'bb'.repeat(32),
      detail: 'orphan-tail probe',
    };
    const id = await fileReplicationStallEi(orphan, deps);
    expect(id).toBe('EI-999');
    expect(created[0]!.title).toBe(replicationStallEiTitle(orphan));
    expect(created[0]!.title).toContain('drain_orphan_tail');
    // The body carries the runbook (drained_at=NULL re-emit) + the root fix hint.
    expect(body).toContain('drained_at=NULL');
    expect(body).toContain('keypair');
  });

  describe('EI-7110: resolveReplicationStallEi (auto-close on recovery)', () => {
    it('resolves the matching open EI with a recovery note', async () => {
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([{ id: 'EI-7110', title }]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'regained a peer after 300s' },
        deps,
      );
      expect(ids).toEqual(['EI-7110']);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.id).toBe('EI-7110');
      expect(resolved[0]!.note).toContain('auto-resolved');
      expect(resolved[0]!.note).toContain('regained a peer after 300s');
    });

    it('no-ops when no open EI matches the title (already resolved, or never crossed the escalation grace)', async () => {
      const { deps, resolved } = fakeDeps([]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      expect(ids).toEqual([]);
      expect(resolved).toHaveLength(0);
    });

    it('a DIFFERENT kind for the same log does not resolve an unrelated open EI (title is kind-scoped)', async () => {
      const { deps, resolved } = fakeDeps([{ id: 'EI-1', title: replicationStallEiTitle({ ...episode, kind: 'frozen' }) }]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      expect(ids).toEqual([]);
      expect(resolved).toHaveLength(0);
    });

    it('EI-6772: resolves ALL duplicate open EIs for one (harness, log, kind), not just the first', async () => {
      // Duplicate opens arise legitimately across the federated multi-machine
      // ledger: two machines each file an origin:remote EI for one stall before
      // the other replicates in (exactly EI-6772 + its sibling EI-7764 — same
      // harness/log/kind). A .find recovery closed EI-7764 and stranded EI-6772
      // open forever; the .filter fix sweeps up every duplicate on recovery.
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([
        { id: 'EI-7764', title },
        { id: 'EI-6772', title },
      ]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'regained a peer after 180s' },
        deps,
      );
      expect(ids).toEqual(['EI-7764', 'EI-6772']);
      expect(resolved.map((r) => r.id)).toEqual(['EI-7764', 'EI-6772']);
      for (const r of resolved) expect(r.note).toContain('auto-resolved');
    });

    it('resolves the healthy siblings even when one resolve() call throws (per-EI best-effort)', async () => {
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([
        { id: 'EI-A', title },
        { id: 'EI-B', title },
      ]);
      const inner = deps.resolve;
      deps.resolve = async (id, note) => {
        if (id === 'EI-A') throw new Error('transient PG failure');
        await inner(id, note);
      };
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      // EI-A's resolve threw, but EI-B is still closed (siblings never stranded).
      expect(ids).toEqual(['EI-B']);
      expect(resolved.map((r) => r.id)).toEqual(['EI-B']);
    });
  });
});

describe('connected_never_replicated axis (WI-183 zombie connections, rig run m1783114921)', () => {
  const sampleWith = (
    on: (e: ReplicationStallEpisode) => void,
    now: number,
    opts: { peers?: number; swarm?: number; pos?: number },
  ) =>
    sampleReplicationLiveness(
      WS,
      HS,
      {
        keyHex: KEY,
        knownLength: 5,
        mergedPosition: opts.pos ?? 0,
        peersCount: opts.peers,
        swarmConnections: opts.swarm,
      },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
    );

  it('fires ONCE after grace when the swarm is connected but the log never attached a replicator; verdict reads no_replicator', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 2 }); // zombie window opens
    expect(episodes).toHaveLength(0);
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 2 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
    expect(episodes[0]!.detail).toContain('zombie');
    // Edge-triggered: still zombied → no re-fire.
    now += 5_000;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    // Read-time verdict lands in the red bucket consumers already handle.
    const view = getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!;
    expect(view.logs[0]!.verdict).toBe('no_replicator');
  });

  // EI-18726252562537043 REGRESSION GUARD. The old wording ("this log has
  // NEVER attached a replicator") named a LOCAL cause the observation does
  // not establish — peersCount==0 is equally consistent with the REMOTE never
  // opening/serving the core. That phrasing sent a real investigation
  // (WI-5673) down a dead end. The stable grep tokens (`kind`, the bracketed
  // `[never_attached]` sub-case) must NOT change — only the human-facing
  // sentence, which must name both hypotheses instead of asserting one.
  it('EI-18726252562537043: the never_attached message states the observation, not a local-fault verdict', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 2 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 2 });
    expect(episodes).toHaveLength(1);
    const { detail } = episodes[0]!;
    // Stable grep tokens unchanged.
    expect(detail).toContain('[never_attached]');
    // No longer asserts a local-only cause.
    expect(detail).not.toContain('NEVER attached a replicator');
    expect(detail).not.toMatch(/this log has NEVER attached/);
    // Names the remote-side hypothesis explicitly.
    expect(detail.toLowerCase()).toContain('remote');
    expect(detail.toLowerCase()).toContain('either');
  });

  it('NEVER alarms with zero swarm connections (offline churn) or when the axis is unfed', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      sampleWith(on, now, { peers: 0, swarm: 0 }); // offline peer — churn
      now += GRACE;
    }
    for (let i = 0; i < 5; i += 1) {
      sampleWith(on, now, { peers: 0 }); // no swarm handle — axis disabled
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'never_connected',
    );
  });

  it('churn gaps within tolerance KEEP the window (zombie connections churn ~10s); the alarm still fires', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // window opens
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 0 }); // reconnect gap — within tolerance, kept
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // churned back
    now += 2_000; // total window = GRACE
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
  });

  it('a SUSTAINED offline stretch (past churn tolerance) RESETS the clock — genuinely-offline never alarms', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // window opens
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 0 }); // goes offline…
    now += SWARM_CHURN_TOLERANCE_MS + 1_000; // …and STAYS offline past tolerance
    sampleWith(on, now, { peers: 0, swarm: 0 }); // sustained → reset (no fire: swarm 0 never fires)
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // fresh window from here
    now += GRACE - 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // inside the fresh window
    expect(episodes).toHaveLength(0);
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // fresh window elapses → fires
    expect(episodes).toHaveLength(1);
  });

  it('replicator attachment recovers the log (live verdict) and a later zombie window re-fires', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    // Replication finally attaches AND ingests (the 22:00:00 heal on the rig:
    // once the channel paired, the whole backlog crossed in <1s).
    now += 1_000;
    sampleWith(on, now, { peers: 1, swarm: 1, pos: 5 });
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
    // WI-5639: a log that LOSES its replicator while the swarm still holds live
    // connections RE-ARMS the zombie axis. This used to assert the opposite
    // ("once a log HAS replicated the zombie axis stays off — no_replicator owns
    // the was-replicating stall"), and that premise is precisely the bug:
    // no_replicator is EXCLUDED from boot.ts's REPAIRABLE_EPISODE_KINDS, so
    // handing this state to no_replicator alone left it with NO repair path at
    // all (gate run 20260725-143908: frame a sat dead for 25 minutes, swallowing
    // restart_durability's post-restart write and reconnect_catchup's baseline).
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1, pos: 5 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1, pos: 5 });
    expect(episodes).toHaveLength(3);
    expect(episodes[1]!.kind).toBe('no_replicator');
    expect(episodes[2]!.kind).toBe('connected_never_replicated');
    expect(episodes[2]!.detail).toContain('[replicator_lost]');
  });

  // WI-5639 REGRESSION GUARD. The failure class: peer restarts, this log's
  // replicator detaches, but the swarm still reports live connections — so
  // swarm.ts's severed-link escalation (needs liveConnectionCount === 0) never
  // trips, `frozen` needs a replicator ATTACHED, and no_replicator is excluded
  // from repair. The zombie axis is the ONLY repairable rung that can cover it,
  // so it MUST fire on the SHORT zombie grace, not no_replicator's long one.
  it('WI-5639: a log that LOST its replicator (swarm still connected) alarms on the ZOMBIE grace, not the long grace', () => {
    const { episodes, on } = collect();
    // The rig runs graceMs=180s with the zombie axis shortened to 15s; the same
    // ratio at test scale (GRACE is 10s here).
    const ZOMBIE = 2_000;
    let now = 1_000_000;
    const sample = (peers: number, swarm: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers, swarmConnections: swarm },
        {
          graceMs: GRACE,
          connectedNeverReplicatedGraceMs: ZOMBIE,
          nowMs: now,
          onStallEpisode: on,
        },
      );

    // Healthy: replicating normally.
    sample(1, 1);
    expect(episodes).toHaveLength(0);

    // The peer restarts: the replicator detaches while the swarm socket stays up.
    now += 1_000;
    sample(0, 1);
    expect(episodes).toHaveLength(0); // inside the zombie grace — no alarm yet

    // Held past the ZOMBIE grace but FAR short of the long grace.
    expect(ZOMBIE).toBeLessThan(GRACE); // the whole point: it must not wait for GRACE
    now += ZOMBIE;
    sample(0, 1);
    // Exactly ONE episode: the long-grace no_replicator axis has NOT fired yet
    // (that is what took 181s on the rig and is unrepairable anyway).
    expect(episodes).toHaveLength(1);
    expect(episodes.some((e) => e.kind === 'no_replicator')).toBe(false);
    // The kind is deliberately unchanged so boot.ts's REPAIRABLE_EPISODE_KINDS
    // already covers it and historical boot_events / rig log greps stay valid.
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
    expect(episodes[0]!.detail).toContain('[replicator_lost]');
  });

  // WI-5639: the alarm latch must clear with the window it belongs to, or the
  // `!st.alarmedConnectedNever` fire guard silences this log permanently.
  it('WI-5639: a sustained-offline reset CLEARS the alarm latch so a later zombie window can re-fire', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // window opens
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // alarms → latch set
    expect(episodes).toHaveLength(1);

    // Peer goes genuinely offline past churn tolerance → window + latch reset.
    now += SWARM_CHURN_TOLERANCE_MS + 1_000;
    sampleWith(on, now, { peers: 0, swarm: 0 });

    // Peer returns; a FRESH zombie window must be able to alarm again.
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(2);
    expect(episodes[1]!.kind).toBe('connected_never_replicated');
  });

  // EI-4643: a zombie-connection EI must AUTO-CLOSE once the log attaches a live
  // replicator. Previously the connected_never_replicated axis reset its latch
  // silently (no onRecovery), so its durable EI sat open forever — this pins the
  // recovery-reporting wiring for the exact class EI-4643 belongs to.
  it('EI-4643: reports recovery with kind=connected_never_replicated once a live replicator attaches', () => {
    const { episodes, on } = collect();
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number | undefined, swarm: number, pos = 0) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: pos, peersCount: peers, swarmConnections: swarm },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(0, 2); // swarm-connected but never replicated — zombie window opens
    now += GRACE;
    sample(0, 2); // held past grace → alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
    expect(recoveries).toHaveLength(0);

    now += 5_000;
    sample(1, 1, 5); // a live replicator finally attaches → recovery reported
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('connected_never_replicated');
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('replicator');
  });

  it('never reports recovery for a zombie window that never crossed the alarm grace', () => {
    const { on } = collect();
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number | undefined, swarm: number, pos = 0) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: pos, peersCount: peers, swarmConnections: swarm },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(0, 1); // window opens
    now += 2_000; // well within grace
    sample(1, 1, 5); // replicator attaches before ever alarming
    expect(recoveries).toHaveLength(0);
  });
});

describe('WI-5686: connectedNeverReplicatedGraceMs is INDEPENDENT of the general graceMs', () => {
  // Repro of the false-positive class (WI-5672/WI-5686): a rig soak shortens
  // ONLY the zombie axis's grace (WI-5634, ~15s in production) so repair-on-
  // detect gets a chance inside the soak's SLA. Before this fix, that same
  // short value was the ONE `graceMs` sampleReplicationLiveness/getReplication
  // Liveness apply to ALL THREE axes — so no_replicator (a log that WAS
  // replicating and legitimately holds 0 peers for the length of an ordinary
  // cold-restart+re-peer cycle, comfortably longer than 15s) false-fired on
  // every restart, even though the peer was never a zombie and reconnected
  // fine well inside the real 180s production grace.
  const shortZombieGrace = 15_000; // WI-5634's rig default
  const realisticRestartGapMs = 90_000; // a healthy but slow cold-restart+re-peer
  const productionLikeGraceMs = 200_000; // > realisticRestartGapMs, unlike the file's tiny GRACE=10s

  it('a realistic restart-cycle gap (90s) does NOT false-fire no_replicator when the zombie axis alone is shortened to 15s', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        {
          graceMs: productionLikeGraceMs, // production-shaped general grace (180s in prod)
          connectedNeverReplicatedGraceMs: shortZombieGrace,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: () => {},
        },
      );
    sample(1); // was replicating
    now += realisticRestartGapMs; // frame cold-restarts + re-peers — 0 peers the whole time
    // 90s > shortZombieGrace(15s) but < productionLikeGraceMs(200s) — must NOT alarm.
    sample(0);
    expect(episodes).toHaveLength(0);
    now += 1_000;
    sample(1); // reconnects — healthy
    expect(episodes).toHaveLength(0);
  });

  it('BEFORE this fix (simulated: pass the short value as the shared graceMs) the same gap WOULD have false-fired — proves the fix is load-bearing', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        // The OLD behavior: one shared grace fed to everything (no
        // connectedNeverReplicatedGraceMs override — or, equivalently, the
        // pre-fix code path where the rig's short value WAS `graceMs`).
        { graceMs: shortZombieGrace, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
    sample(1);
    now += realisticRestartGapMs; // same healthy 90s restart gap
    sample(0);
    expect(episodes).toHaveLength(1); // false-fires — this is the bug this test documents
    expect(episodes[0]!.kind).toBe('no_replicator');
  });

  it('a GENUINE zombie (swarm connected, never replicated) still alarms promptly at the short grace, unaffected by the general graceMs', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (swarm: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 0, peersCount: 0, swarmConnections: swarm },
        {
          graceMs: productionLikeGraceMs, // long general grace — must not slow the zombie axis down
          connectedNeverReplicatedGraceMs: shortZombieGrace,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: () => {},
        },
      );
    sample(1); // zombie window opens: swarm connected, never replicated
    expect(episodes).toHaveLength(0);
    now += shortZombieGrace;
    sample(1); // still zombied, past the SHORT grace (far short of productionLikeGraceMs)
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
  });

  it('read-time getReplicationLiveness honors the same split via connectedNeverReplicatedGraceMs', () => {
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: productionLikeGraceMs, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
    );
    now += realisticRestartGapMs;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 0 },
      { graceMs: productionLikeGraceMs, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
    );
    // Read-time verdict with the split grace: 90s hasn't crossed the general
    // productionLikeGraceMs(200s), so still 'live' even though it WOULD read
    // no_replicator against a naive shared-short-grace read.
    const view = getReplicationLiveness({
      nowMs: now,
      graceMs: productionLikeGraceMs,
      connectedNeverReplicatedGraceMs: shortZombieGrace,
    })[0]!;
    expect(view.logs[0]!.verdict).toBe('live');
  });
});

describe('WI-3684 repair-on-detect: the per-harness repair-handler seam', () => {
  // Drive the zombie axis (swarm connected, replicator never attached): two
  // samples spanning the grace window fire exactly one episode.
  const driveZombieEpisode = (
    on: (e: ReplicationStallEpisode) => void,
    startMs = 1_000_000,
  ): void => {
    const sample = (now: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 0, peersCount: 0, swarmConnections: 3 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
    sample(startMs);
    sample(startMs + GRACE);
  };

  it('a registered handler receives the connected_never_replicated episode ALONGSIDE the reporter', () => {
    const { episodes, on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    driveZombieEpisode(on);
    expect(episodes).toHaveLength(1);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.kind).toBe('connected_never_replicated');
    expect(repairs[0]!.logKeyHex).toBe(KEY);
    expect(repairs[0]!.workspaceId).toBe(WS);
    expect(repairs[0]!.harnessSlug).toBe(HS);
  });

  it('the seam is kind-agnostic — a no_replicator episode dispatches too (registrants filter)', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
    sample(1); // was replicating
    now += 1_000;
    sample(0); // detached
    now += GRACE;
    sample(0); // past grace → no_replicator episode
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.kind).toBe('no_replicator');
  });

  it('a THROWING handler never breaks the sample — the episode still reaches the reporter', () => {
    const { episodes, on } = collect();
    setReplicationRepairHandler(WS, HS, () => {
      throw new Error('repair exploded');
    });
    expect(() => driveZombieEpisode(on)).not.toThrow();
    expect(episodes).toHaveLength(1);
  });

  it('only the matching harness dispatches; null unregisters', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, 'some-other-harness', (e) => repairs.push(e));
    driveZombieEpisode(on);
    expect(repairs).toHaveLength(0); // wrong harness — never dispatched

    _resetReplicationLivenessForTests();
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    setReplicationRepairHandler(WS, HS, null); // unregister
    driveZombieEpisode(on);
    expect(repairs).toHaveLength(0);
  });

  it('dropReplicationLiveness (handle close) clears the handler — a post-close episode never reaches it', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    dropReplicationLiveness(WS, HS); // handle closed — handler must die with it
    driveZombieEpisode(on); // fresh state re-alarms after grace
    expect(repairs).toHaveLength(0);
  });
});

/**
 * WI-7011 — a recovery path gated on IN-PROCESS state cannot resolve a DURABLE
 * artifact filed by a PREVIOUS process.
 *
 * Every test above drives an alarm and a recovery inside ONE process, so the
 * `alarmedX` flag is always set when recovery arrives. The bug lives in the case
 * those tests structurally cannot express: the alarm was raised by a process that
 * has since EXITED. A fresh process starts with `alarmedX = false`, so the log
 * recovering reports nothing and the durable EI stays open forever. Measured
 * 2026-08-02: 43 of 47 open non-drain EIs had been silent 5.7–27.5 days, 36 of
 * them on the two most-RESTARTED harnesses.
 *
 * A restart is simulated exactly as the module itself defines one — a cleared
 * registry (`_resetReplicationLivenessForTests`, which is what `afterEach` does)
 * — so "fresh process" here means the same thing it means in production.
 */
describe('WI-7011: durable-EI rehydration across a process restart', () => {
  function collectRecovery(): {
    recoveries: ReplicationStallEpisode[];
    onRecovery: (e: ReplicationStallEpisode) => void;
  } {
    const recoveries: ReplicationStallEpisode[] = [];
    return { recoveries, onRecovery: (e) => recoveries.push(e) };
  }

  /** The probe is fire-and-forget; let its microtask chain settle. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** Records what the probe was asked, so we can assert the read is BOUNDED. */
  function stubProbe(isOpen: boolean): { asked: string[] } {
    const asked: string[] = [];
    setOpenStallEiProbeForTests(async (e) => {
      asked.push(`${e.kind}:${e.logKeyHex.slice(0, 4)}`);
      return isOpen;
    });
    return { asked };
  }

  it('no_replicator: a healthy log with an EI left open by a PREVIOUS process reports the recovery this process never saw', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    const { asked } = stubProbe(true);

    // Fresh process (empty registry), first-ever sample, log is perfectly healthy.
    // There is NO alarm→recovered transition here — that is the entire point.
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: () => {}, onRecovery },
    );
    await settle();

    // All THREE axes are probed on a healthy first sight, by design: a restart
    // could have orphaned an EI on any of them, and this log reads healthy on
    // all three. Assert this axis specifically rather than the whole set.
    expect(asked).toContain('no_replicator:aaaa');
    const noRepl = recoveries.filter((r) => r.kind === 'no_replicator');
    expect(noRepl).toHaveLength(1);
    // The stall began in a process that is gone, so its duration is genuinely
    // unknown — report 0 rather than inventing one from this process's clock.
    expect(noRepl[0]!.stalledForMs).toBe(0);
    expect(noRepl[0]!.detail).toContain('previous process');
  });

  it('reports NOTHING when no EI is open — the overwhelmingly common case must stay silent', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    stubProbe(false);

    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: () => {}, onRecovery },
    );
    await settle();

    expect(recoveries).toHaveLength(0);
  });

  it('probes at most ONCE per (log, axis) per process however many passes run — the merge pass is hot', async () => {
    const { onRecovery } = collectRecovery();
    const { asked } = stubProbe(false);

    // 25 passes of a steadily healthy log. Gating the probe on "healthy &&
    // !alarmed" ALONE (with no latch) would read PG on every one of them —
    // that regression is what this asserts against, and it is why the latch
    // exists rather than just the flag check.
    for (let i = 0; i < 25; i++) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
        { graceMs: GRACE, nowMs: 1_000_000 + i * 1_000, onStallEpisode: () => {}, onRecovery },
      );
    }
    await settle();

    // One read per axis, not per pass: no_replicator + connected_never + frozen.
    expect(asked.filter((a) => a.startsWith('no_replicator'))).toHaveLength(1);
    expect(asked.filter((a) => a.startsWith('connected_never'))).toHaveLength(1);
    expect(asked.filter((a) => a.startsWith('frozen'))).toHaveLength(1);
  });

  it('connected_never_replicated rehydrates even though its recovery BRANCH is unreachable in a fresh process', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    stubProbe(true);

    // The in-process recovery branch for this axis requires
    // `connectedNeverReplSinceMs !== null` — a zombie window THIS process opened.
    // A fresh process has it null, so that branch can never run after a restart
    // and the orphaned EI could never clear through it. The probe must not ride
    // that branch; this test fails if it does.
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1, swarmConnections: 2 },
      { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: () => {}, onRecovery },
    );
    await settle();

    expect(recoveries.map((r) => r.kind)).toContain('connected_never_replicated');
  });

  it('frozen rehydrates when ingest is healthy', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    stubProbe(true);

    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: () => {}, onRecovery },
    );
    await settle();

    expect(recoveries.map((r) => r.kind)).toContain('frozen');
  });

  it('does NOT probe an axis this process alarmed and resolved itself — no wasted read, and no duplicate report racing the async resolve', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    const { asked } = stubProbe(true);
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery },
      );

    sample(1); // healthy first sight — probes (finds an open EI, reports once)
    await settle();
    const afterFirst = recoveries.filter((r) => r.kind === 'no_replicator').length;

    now += 1_000;
    sample(0); // detached
    now += GRACE + 1;
    sample(0); // alarms in-process
    now += 1_000;
    sample(1); // genuine in-process recovery — first-hand knowledge
    await settle();

    // Exactly ONE more no_replicator recovery (the genuine one), and no second
    // probe: this process watched the whole episode, so there is nothing to
    // rehydrate, and a probe racing the in-flight resolve would still read the
    // EI as open and report it twice.
    expect(recoveries.filter((r) => r.kind === 'no_replicator')).toHaveLength(afterFirst + 1);
    expect(asked.filter((a) => a.startsWith('no_replicator'))).toHaveLength(1);
  });

  it('a probe that REJECTS never breaks the merge pass — the sampler must stay total', async () => {
    const { recoveries, onRecovery } = collectRecovery();
    setOpenStallEiProbeForTests(() => Promise.reject(new Error('pg down')));

    expect(() =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
        { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: () => {}, onRecovery },
      ),
    ).not.toThrow();
    await settle();

    // Degrades to exactly the pre-fix behavior: the EI is left for manual triage.
    expect(recoveries).toHaveLength(0);
  });
});
