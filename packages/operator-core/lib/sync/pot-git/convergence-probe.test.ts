/**
 * Unit tests for the pot-git convergence probe (WI-6372, fix D).
 *
 * The bulk of these are NEVER-FIRES-ON-HEALTHY tests. That weighting is
 * deliberate and is the lesson from WI-6364's fix C: a mechanism that REFUSES
 * or ALARMS is only as good as the guard that keeps it silent on a healthy
 * case, because a detector that cries wolf gets ignored and then the one true
 * alarm is lost. Each guard is exercised in isolation so a mutation to it fails
 * exactly its own test.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONVERGENCE_PERSISTENCE_MS,
  DEFAULT_RELEASE_CONSISTENCY_MAX_OBSERVATION_AGE_MS,
  formatConvergenceVerdict,
  formatReleaseConsistencyVerdict,
  judgeConvergence,
  judgeReleaseConsistency,
  selectConvergenceCandidates,
  type ConvergenceState,
} from './convergence-probe';

const SELF = 'SELFdevicePubkeyBase64AAAAAAAAAAAAAAAAAAAAAAA=';
const PEER = 'PEERdevicePubkeyBase64AAAAAAAAAAAAAAAAAAAAAAA=';
const PEER2 = 'PEER2devicePubkeyBase64AAAAAAAAAAAAAAAAAAAA=';
const STRANGER = 'STRANGERdevicePubkeyBase64AAAAAAAAAAAAAAAAA=';

const NOW = 1_800_000_000_000;
const STORE_GENERATION = 'store-generation-a';
const SIGREFS_OID = 'a'.repeat(40);
const NEXT_SIGREFS_OID = 'b'.repeat(40);

/** The healthy baseline: one attested peer, we mirror exactly what it announced. */
function judge(over: Partial<Parameters<typeof judgeConvergence>[0]> = {}) {
  return judgeConvergence({
    candidateDevicePubkeys: [PEER],
    announced: [{ devicePubkeyBase64: PEER, version: 7 }],
    local: [{ devicePubkeyBase64: PEER, version: 7 }],
    priorState: null,
    nowMs: NOW,
    ...over,
  });
}

/** The release baseline: fresh, signed lineage + exact local snapshot equality. */
function judgeExact(over: Partial<Parameters<typeof judgeReleaseConsistency>[0]> = {}) {
  return judgeReleaseConsistency({
    expectedDevicePubkeys: [PEER],
    announced: [
      {
        devicePubkeyBase64: PEER,
        version: 7,
        sequence: 100,
        sigrefsOid: SIGREFS_OID,
        observedAtMs: NOW - 1_000,
        signedAtMs: NOW - 2_000,
        storeGeneration: STORE_GENERATION,
      },
    ],
    local: [
      {
        devicePubkeyBase64: PEER,
        version: 7,
        sigrefsOid: SIGREFS_OID,
        storeGeneration: STORE_GENERATION,
      },
    ],
    nowMs: NOW,
    ...over,
  });
}

describe('judgeReleaseConsistency — fail-closed exact release acceptance', () => {
  it('never promotes a later-arriving replay over the signed store-generation order', () => {
    const old = `sg2-1-${'a'.repeat(40)}`;
    const current = `sg2-2-${'b'.repeat(40)}`;
    const verdict = judgeExact({
      announced: [
        { devicePubkeyBase64: PEER, version: 999, sequence: 12, sigrefsOid: SIGREFS_OID, storeGeneration: old, observedAtMs: NOW, signedAtMs: NOW },
        { devicePubkeyBase64: PEER, version: 1, sequence: 11, sigrefsOid: NEXT_SIGREFS_OID, storeGeneration: current, observedAtMs: NOW, signedAtMs: NOW },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 999, sigrefsOid: SIGREFS_OID, storeGeneration: old }],
    });
    expect(verdict.state).not.toBe('current');
    expect(verdict.issues).toContainEqual(expect.objectContaining({ code: 'replayed-announcement' }));
    expect(verdict.issues).toContainEqual(expect.objectContaining({ code: 'store-generation-mismatch' }));
  });
  it('is CURRENT only when every expected peer has a fresh exact generation/sequence/snapshot match', () => {
    const verdict = judgeExact();
    expect(verdict).toMatchObject({
      state: 'current',
      expectedDevicePubkeys: [PEER],
      currentDevicePubkeys: [PEER],
      watermarkSequence: 100,
      issues: [],
    });
    expect(verdict.peers[0]).toMatchObject({
      state: 'current',
      storeGeneration: STORE_GENERATION,
      announcedVersion: 7,
      localVersion: 7,
      announcedSigrefsOid: SIGREFS_OID,
      localSigrefsOid: SIGREFS_OID,
    });
    expect(formatReleaseConsistencyVerdict(verdict)).toContain('CURRENT');
  });

  it('does not grant vacuous success when the expected peer set is empty', () => {
    const verdict = judgeExact({ expectedDevicePubkeys: [], announced: [], local: [] });
    expect(verdict.state).toBe('unknown');
    expect(verdict.issues.map((issue) => issue.code)).toEqual(['expected-peer-set-empty']);
  });

  it('keeps an absent expected peer UNKNOWN even when another peer and a filtered stranger are exact', () => {
    const baseline = judgeExact();
    const verdict = judgeExact({
      expectedDevicePubkeys: [PEER, PEER2],
      announced: [
        ...baseline.peers.map((peer) => ({
          devicePubkeyBase64: peer.devicePubkeyBase64,
          version: peer.announcedVersion!,
          sequence: peer.receiverSequence!,
          sigrefsOid: peer.announcedSigrefsOid!,
          observedAtMs: peer.observedAtMs!,
          signedAtMs: peer.signedAtMs!,
          storeGeneration: peer.storeGeneration!,
        })),
        {
          devicePubkeyBase64: STRANGER,
          version: 999,
          sequence: 999,
          sigrefsOid: NEXT_SIGREFS_OID,
          observedAtMs: NOW,
          signedAtMs: NOW,
          storeGeneration: 'stranger-generation',
        },
      ],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.currentDevicePubkeys).toEqual([PEER]);
    expect(verdict.issues).toContainEqual(
      expect.objectContaining({ devicePubkeyBase64: PEER2, code: 'missing-announcement' }),
    );
    expect(verdict.peers.some((peer) => peer.devicePubkeyBase64 === STRANGER)).toBe(false);
  });

  it('calls transient exact lag CATCHING-UP even while the health judge deliberately stays green', () => {
    const health = judge({
      announced: [{ devicePubkeyBase64: PEER, version: 8, sequence: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
    });
    const exact = judgeExact({
      announced: [
        {
          devicePubkeyBase64: PEER,
          version: 8,
          sequence: 100,
          sigrefsOid: NEXT_SIGREFS_OID,
          observedAtMs: NOW - 1_000,
          signedAtMs: NOW - 2_000,
          storeGeneration: STORE_GENERATION,
        },
      ],
    });
    expect(health.converged).toBe(true);
    expect(exact.state).toBe('catching-up');
    expect(exact.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['generation-sequence-mismatch', 'snapshot-oid-mismatch']),
    );
  });

  it('treats a missing local mirror as observed CATCHING-UP, not UNKNOWN or CURRENT', () => {
    const verdict = judgeExact({ local: [] });
    expect(verdict.state).toBe('catching-up');
    expect(verdict.issues.map((issue) => issue.code)).toEqual(['missing-local-mirror']);
  });

  it('keeps legacy v1 evidence without a signed store generation UNKNOWN', () => {
    const verdict = judgeExact({
      announced: [
        {
          devicePubkeyBase64: PEER,
          version: 7,
          sequence: 100,
          sigrefsOid: SIGREFS_OID,
          observedAtMs: NOW - 1_000,
          signedAtMs: NOW - 2_000,
        },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 7, sigrefsOid: SIGREFS_OID }],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-store-generation', 'missing-local-store-generation']),
    );
  });

  it('does not let a freshly received replay lower the per-generation sequence bar', () => {
    const verdict = judgeExact({
      announced: [
        {
          devicePubkeyBase64: PEER,
          version: 7,
          sequence: 101,
          sigrefsOid: SIGREFS_OID,
          observedAtMs: NOW - 1_000,
          signedAtMs: NOW - 2_000,
          storeGeneration: STORE_GENERATION,
        },
        {
          devicePubkeyBase64: PEER,
          version: 8,
          sequence: 100,
          sigrefsOid: NEXT_SIGREFS_OID,
          observedAtMs: NOW - 2_000,
          signedAtMs: NOW - 3_000,
          storeGeneration: STORE_GENERATION,
        },
      ],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.issues).toContainEqual(expect.objectContaining({ code: 'replayed-announcement' }));
  });

  it('does not let an identical signed replay refresh release evidence', () => {
    const announcement = {
      devicePubkeyBase64: PEER,
      version: 7,
      sigrefsOid: SIGREFS_OID,
      observedAtMs: NOW - 1_000,
      signedAtMs: NOW - 2_000,
      storeGeneration: STORE_GENERATION,
    };
    const verdict = judgeExact({
      announced: [
        { ...announcement, sequence: 101 },
        { ...announcement, sequence: 100, observedAtMs: NOW - 5_000 },
      ],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.issues).toContainEqual(expect.objectContaining({ code: 'replayed-announcement' }));
  });

  it('keeps stale sender or receiver evidence UNKNOWN', () => {
    const staleAt = NOW - DEFAULT_RELEASE_CONSISTENCY_MAX_OBSERVATION_AGE_MS - 1;
    const verdict = judgeExact({
      announced: [
        {
          devicePubkeyBase64: PEER,
          version: 7,
          sequence: 100,
          sigrefsOid: SIGREFS_OID,
          observedAtMs: staleAt,
          signedAtMs: staleAt,
          storeGeneration: STORE_GENERATION,
        },
      ],
    });
    expect(verdict.state).toBe('unknown');
    expect(verdict.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['stale-observation', 'stale-signed-snapshot']),
    );
  });

  it('keeps complete-but-different lineage or snapshot evidence CATCHING-UP', () => {
    const verdict = judgeExact({
      local: [
        {
          devicePubkeyBase64: PEER,
          version: 7,
          sigrefsOid: NEXT_SIGREFS_OID,
          storeGeneration: 'store-generation-b',
        },
      ],
    });
    expect(verdict.state).toBe('catching-up');
    expect(verdict.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['store-generation-mismatch', 'snapshot-oid-mismatch']),
    );
  });
});

describe('judgeConvergence — never fires on a healthy case', () => {
  it('is converged when local equals announced', () => {
    const v = judge();
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
    expect(v.notConverged).toEqual([]);
    expect(v.judged).toBe(1);
    expect(v.state).toEqual({});
  });

  it('is converged when local is AHEAD of the announcement (we fetched past a stale announce)', () => {
    const v = judge({ local: [{ devicePubkeyBase64: PEER, version: 9 }] });
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });

  it('GUARD 1: ignores SELF — our own device is never judged against its own announcement', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER], // self deliberately absent, as the leg computes it
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: SELF, version: 99 }, // we hold no sigrefs row for self here
      ],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
  });

  it('GUARD 1: ignores an announcement from a device that is not an attested member', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: STRANGER, version: 4_000_000 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
    expect(v.state[STRANGER]).toBeUndefined();
  });

  it('GUARD 2: a member that has never announced is never judged behind, even with no local mirror', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: 7 }], // nothing at all for PEER2
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(1);
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });

  it('GUARD 5: a malformed announced version is skipped, not trusted', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: Number.NaN },
        { devicePubkeyBase64: PEER, version: 1.5 },
        { devicePubkeyBase64: PEER, version: -3 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 2 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.judged).toBe(0);
    expect(v.converged).toBe(true);
  });

  it('GUARD 3: a recovered device DROPS its prior lag state instead of carrying it', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 7, local: 3, since: NOW - 10 * DEFAULT_CONVERGENCE_PERSISTENCE_MS },
    };
    const v = judge({ priorState });
    expect(v.converged).toBe(true);
    expect(v.state[PEER]).toBeUndefined();
  });

  it('with no `sequence` anywhere, falls back to array order (newest-first) rather than to max-version', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 9 }, // caller supplies newest-first
        { devicePubkeyBase64: PEER, version: 2 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 5 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind).toHaveLength(1);
    expect(v.behind[0]!.announced).toBe(9);
  });
});

describe('judgeConvergence — GUARD 7: the bar is the NEWEST announcement, never the highest', () => {
  it('THE DEFECT: a re-keyed peer whose version restarted does NOT get judged against the dead lineage', () => {
    // The live shape: the tower re-keyed and its counter went 662 -> 105 while
    // our mirror sits at 104, i.e. ONE version behind and perfectly healthy.
    // Taking max(version) pins the bar at 662 — unreachable forever.
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 105, sequence: 468842 }, // current lineage
        { devicePubkeyBase64: PEER, version: 662, sequence: 455690 }, // dead lineage
      ],
      local: [{ devicePubkeyBase64: PEER, version: 104 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind).toHaveLength(1);
    expect(v.behind[0]!.announced).toBe(105); // NOT 662
    expect(v.converged).toBe(true); // one version behind, transient — no alarm
  });

  it('orders by `sequence` regardless of the order the caller happens to pass them in', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 662, sequence: 455690 },
        { devicePubkeyBase64: PEER, version: 105, sequence: 468842 },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 104 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind[0]!.announced).toBe(105);
  });

  it('a re-key DROPS the carried persistence clock instead of inheriting an unbounded one', () => {
    // Without this, the clock accumulated against the 662 bar carries straight
    // over and the device is instantly, permanently "persistently behind".
    const priorState: ConvergenceState = {
      [PEER]: { announced: 662, local: 104, since: NOW - 6 * 60 * 60 * 1000 }, // 6h of dead-lineage lag
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 105, sequence: 468842 }],
      local: [{ devicePubkeyBase64: PEER, version: 104 }],
      priorState,
      nowMs: NOW,
    });
    expect(v.behind[0]!.since).toBe(NOW); // clock restarted
    expect(v.behind[0]!.lagMs).toBe(0);
    expect(v.notConverged).toHaveLength(0);
    expect(v.converged).toBe(true);
    expect(v.lineageResets).toEqual([{ devicePubkeyBase64: PEER, priorAnnounced: 662, announced: 105 }]);
  });

  it('a re-key is reported even when the device is otherwise fully converged', () => {
    const priorState: ConvergenceState = { [PEER]: { announced: 662, local: 600, since: NOW - 60_000 } };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 105, sequence: 468842 }],
      local: [{ devicePubkeyBase64: PEER, version: 105 }], // caught up on the new lineage
      priorState,
      nowMs: NOW,
    });
    expect(v.converged).toBe(true);
    expect(v.behind).toHaveLength(0);
    expect(v.lineageResets).toHaveLength(1);
    expect(formatConvergenceVerdict(v)).toContain('lineage reset');
  });

  it('a genuinely stuck mirror STILL goes persistent after a re-key — the alarm is not disarmed', () => {
    // The fix must not become a blanket amnesty: once the clock restarts on the
    // NEW lineage, a mirror that still does not move must fire as before.
    const afterReset = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 105, sequence: 468842 }],
      local: [{ devicePubkeyBase64: PEER, version: 10 }],
      priorState: { [PEER]: { announced: 662, local: 10, since: NOW - 6 * 60 * 60 * 1000 } },
      nowMs: NOW,
    });
    expect(afterReset.converged).toBe(true); // clock dropped, starts clean

    const laterStillStuck = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 106, sequence: 468999 }],
      local: [{ devicePubkeyBase64: PEER, version: 10 }], // never moved
      priorState: afterReset.state,
      nowMs: NOW + DEFAULT_CONVERGENCE_PERSISTENCE_MS + 1,
    });
    expect(laterStillStuck.converged).toBe(false);
    expect(laterStillStuck.notConverged[0]!.announced).toBe(106);
  });

  it('an announced counter moving FORWARD is not a lineage reset', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 120, sequence: 5 }],
      local: [{ devicePubkeyBase64: PEER, version: 100 }],
      priorState: { [PEER]: { announced: 110, local: 100, since: NOW - 60_000 } },
      nowMs: NOW,
    });
    expect(v.lineageResets).toHaveLength(0);
    expect(v.behind[0]!.since).toBe(NOW - 60_000); // clock correctly CARRIED
  });

  it('a malformed `sequence` never displaces a well-ordered announcement', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [
        { devicePubkeyBase64: PEER, version: 105, sequence: 468842 },
        { devicePubkeyBase64: PEER, version: 662, sequence: Number.NaN },
      ],
      local: [{ devicePubkeyBase64: PEER, version: 104 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind[0]!.announced).toBe(105);
  });
});

describe('judgeConvergence — GUARD 6: the clock tracks LOCAL PROGRESS, not behind-ness', () => {
  it('a busy peer we trail but keep advancing on NEVER goes persistent, however long it trails', () => {
    // The false-positive that would get this detector disabled: peer announces
    // a new version every tick, we fetch it a tick later. Permanently "behind",
    // permanently HEALTHY.
    let priorState: ConvergenceState | null = null;
    let converged = true;
    for (let tick = 0; tick < 200; tick++) {
      const nowMs = NOW + tick * 5 * 60_000; // 200 ticks ≈ 16 hours
      const v = judgeConvergence({
        candidateDevicePubkeys: [PEER],
        announced: [{ devicePubkeyBase64: PEER, version: 100 + tick }],
        local: [{ devicePubkeyBase64: PEER, version: 99 + tick }], // always one behind, always moving
        priorState,
        nowMs,
      });
      converged &&= v.converged;
      priorState = v.state;
    }
    expect(converged).toBe(true);
  });

  it('a mirror frozen while the pot runs ahead DOES go persistent — the WI-6364 shape', () => {
    let priorState: ConvergenceState | null = null;
    let verdict = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState,
      nowMs: NOW,
    });
    // First observation: behind, but NOT yet persistent — one sample proves nothing.
    expect(verdict.behind).toHaveLength(1);
    expect(verdict.converged).toBe(true);

    priorState = verdict.state;
    verdict = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 118 }], // pot ran further ahead
      local: [{ devicePubkeyBase64: PEER, version: 42 }], // we did not move
      priorState,
      nowMs: NOW + DEFAULT_CONVERGENCE_PERSISTENCE_MS + 1,
      });
    expect(verdict.converged).toBe(false);
    expect(verdict.notConverged).toHaveLength(1);
    expect(verdict.notConverged[0]!.local).toBe(42);
    expect(verdict.notConverged[0]!.announced).toBe(118);
    expect(verdict.notConverged[0]!.since).toBe(NOW); // clock carried from the FIRST observation
  });

  it('local progress RESETS the clock even while still behind', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW - 10 * DEFAULT_CONVERGENCE_PERSISTENCE_MS },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 43 }], // moved by one — progress
      priorState,
      nowMs: NOW,
    });
    expect(v.converged).toBe(true);
    expect(v.behind[0]!.since).toBe(NOW);
    expect(v.behind[0]!.lagMs).toBe(0);
  });

  it('a cold joiner with no mirror at all is behind but NOT immediately not-converged', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.behind).toHaveLength(1);
    expect(v.behind[0]!.local).toBeNull();
    expect(v.converged).toBe(true);
  });

  it('a mirror ABSENT for the whole window goes persistent (the never-seeded stuck joiner)', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 7, local: null, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState,
      nowMs: NOW,
    });
    expect(v.converged).toBe(false);
    expect(v.notConverged[0]!.local).toBeNull();
  });

  it('a `since` in the future (clock skew / metadata from another box) reads as no lag, never instant failure', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW + 60 * 60_000 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 100 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState,
      nowMs: NOW,
    });
    expect(v.behind[0]!.lagMs).toBe(0);
    expect(v.converged).toBe(true);
  });

  it('judges each device independently — one stuck peer does not clear a healthy one, or vice versa', () => {
    const priorState: ConvergenceState = {
      [PEER]: { announced: 100, local: 42, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 },
    };
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [
        { devicePubkeyBase64: PEER, version: 100 },
        { devicePubkeyBase64: PEER2, version: 5 },
      ],
      local: [
        { devicePubkeyBase64: PEER, version: 42 },
        { devicePubkeyBase64: PEER2, version: 5 },
      ],
      priorState,
      nowMs: NOW,
    });
    expect(v.judged).toBe(2);
    expect(v.converged).toBe(false);
    expect(v.notConverged).toHaveLength(1);
    expect(v.notConverged[0]!.devicePubkeyBase64).toBe(PEER);
    expect(v.state[PEER2]).toBeUndefined(); // the healthy one carries no state
  });

  it('GUARD 4: never compares versions across devices', () => {
    // PEER2 announces a much higher counter than PEER. If the code ever
    // compared across devices, PEER's local v7 would read as far behind v900.
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER, PEER2],
      announced: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: PEER2, version: 900 },
      ],
      local: [
        { devicePubkeyBase64: PEER, version: 7 },
        { devicePubkeyBase64: PEER2, version: 900 },
      ],
      priorState: null,
      nowMs: NOW,
    });
    expect(v.converged).toBe(true);
    expect(v.behind).toEqual([]);
  });
});

describe('formatConvergenceVerdict', () => {
  it('says so plainly when there is nothing to compare against', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [],
      local: [],
      priorState: null,
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(v)).toMatch(/no announced peer snapshots/);
  });

  it('distinguishes healthy trailing from NOT CONVERGED', () => {
    const trailing = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 8 }],
      local: [{ devicePubkeyBase64: PEER, version: 7 }],
      priorState: null,
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(trailing)).toMatch(/trailing \(healthy/);
    expect(formatConvergenceVerdict(trailing)).not.toMatch(/NOT CONVERGED/);

    const stuck = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 118 }],
      local: [{ devicePubkeyBase64: PEER, version: 42 }],
      priorState: { [PEER]: { announced: 100, local: 42, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 } },
      nowMs: NOW,
    });
    const line = formatConvergenceVerdict(stuck);
    expect(line).toMatch(/NOT CONVERGED/);
    expect(line).toMatch(/local v42 < announced v118/);
    expect(line).toMatch(/without local progress/);
  });

  it('names an ABSENT mirror distinctly from a stale one', () => {
    const v = judgeConvergence({
      candidateDevicePubkeys: [PEER],
      announced: [{ devicePubkeyBase64: PEER, version: 7 }],
      local: [{ devicePubkeyBase64: PEER, version: null }],
      priorState: { [PEER]: { announced: 7, local: null, since: NOW - DEFAULT_CONVERGENCE_PERSISTENCE_MS - 1 } },
      nowMs: NOW,
    });
    expect(formatConvergenceVerdict(v)).toMatch(/local ABSENT < announced v7/);
  });
});

describe('selectConvergenceCandidates — GUARD 1 input: a REVOKED device is never judged (WI-10006394)', () => {
  const NONE = new Set<string>();

  it('drops self, keeps every other member device, de-duplicates in first-seen order', () => {
    expect(
      selectConvergenceCandidates({
        memberDevicePubkeys: [PEER, SELF, PEER2, PEER, ''],
        selfDevicePubkey: SELF,
        revokedDevicePubkeys: NONE,
      }),
    ).toEqual([PEER, PEER2]);
  });

  it('keeps every member device when self is unknown', () => {
    expect(
      selectConvergenceCandidates({ memberDevicePubkeys: [PEER, PEER2], selfDevicePubkey: undefined, revokedDevicePubkeys: NONE }),
    ).toEqual([PEER, PEER2]);
  });

  it('drops a revoked device of a CURRENT member, and only that device', () => {
    expect(
      selectConvergenceCandidates({
        memberDevicePubkeys: [SELF, PEER, PEER2],
        selfDevicePubkey: SELF,
        revokedDevicePubkeys: new Set([PEER2]),
      }),
    ).toEqual([PEER]);
  });

  // The measured case: a capacity-test VM borrowed the tower's GitHub identity, announced v1,
  // and was deleted before its snapshot was fetched. Its attestation stays on the member row,
  // so without revocation it is judged forever (63 h on hello-world-3-pot) and never clears.
  it('a departed device whose snapshot was never fetched stays NOT CONVERGED until it is revoked, then is not judged at all', () => {
    const departed = PEER2;
    const announced = [
      { devicePubkeyBase64: PEER, version: 7, sequence: 10 },
      { devicePubkeyBase64: departed, version: 1, sequence: 11 },
    ];
    const local = [
      { devicePubkeyBase64: PEER, version: 7 },
      { devicePubkeyBase64: departed, version: null },
    ];
    const priorState: ConvergenceState = {
      [departed]: { announced: 1, local: null, since: NOW - 3816 * 60_000 },
    };

    const unrevoked = judgeConvergence({
      candidateDevicePubkeys: selectConvergenceCandidates({
        memberDevicePubkeys: [SELF, PEER, departed],
        selfDevicePubkey: SELF,
        revokedDevicePubkeys: NONE,
      }),
      announced,
      local,
      priorState,
      nowMs: NOW,
    });
    expect(unrevoked.converged).toBe(false);
    expect(unrevoked.notConverged.map((d) => d.devicePubkeyBase64)).toEqual([departed]);

    const revoked = judgeConvergence({
      candidateDevicePubkeys: selectConvergenceCandidates({
        memberDevicePubkeys: [SELF, PEER, departed],
        selfDevicePubkey: SELF,
        revokedDevicePubkeys: new Set([departed]),
      }),
      announced,
      local,
      priorState,
      nowMs: NOW,
    });
    expect(revoked.converged).toBe(true);
    expect(revoked.judged).toBe(1);
    expect(revoked.state[departed]).toBeUndefined();
    expect(formatConvergenceVerdict(revoked)).toBe('converged with 1 announced peer snapshot(s)');
  });
});
