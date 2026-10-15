import { describe, expect, it, vi } from 'vitest';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { checkpointProducerCertificate, observeCheckpointProducer } from './checkpoint-verified-wait';
import { classifyVerifiedWaitTimeout } from './verified-wait';

function snapshot(overrides: Partial<GitPipelineSnapshot> = {}): GitPipelineSnapshot {
  return {
    slug: 'papercusp',
    generatedAtMs: 2_000,
    routines: {
      gitSync: null,
      greenCheckpoint: { name: 'green-checkpoint', active: true, cron: null, lastFiredAtMs: 1_200, nextFireAtMs: null },
      releaseTrigger: null,
    },
    activeRun: { active: true, candidate: 'abc123', startedAtMs: 1_100, elapsedSec: 1 },
    recent: [],
    ...overrides,
  } as GitPipelineSnapshot;
}

function papercuspSnapshot(overrides: Partial<GitPipelineSnapshot> = {}): GitPipelineSnapshot {
  return snapshot({
    deploy: { integrationRoot: '/workspace/papercusp' } as GitPipelineSnapshot['deploy'],
    ...overrides,
  });
}

describe('checkpoint verified-wait producer adapter', () => {
  it('captures producer identity, ownership, cadence, and baseline progress', () => {
    expect(
      checkpointProducerCertificate({
        pipeline: 'papercusp',
        candidateSha: 'abc1',
        ownerId: 'su-1',
        workItemId: 'WI-1',
        issuedAtMs: 1_500,
        expectedCadenceMs: 5_000,
        verificationDeadlineMs: 6_500,
        snapshot: snapshot(),
      }),
    ).toMatchObject({
      producer: { kind: 'green-checkpoint', id: 'abc123' },
      owner: { ownerId: 'su-1', workItemId: 'WI-1' },
      lastProgressAtMs: 1_100,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 6_500,
      details: { pipeline: 'papercusp', candidateSha: 'abc1' },
    });
  });

  it('preserves unknown producer ownership as null', () => {
    expect(
      checkpointProducerCertificate({
        pipeline: 'papercusp',
        ownerId: null,
        issuedAtMs: 1_500,
        expectedCadenceMs: 5_000,
        verificationDeadlineMs: 6_500,
        snapshot: snapshot(),
      }),
    ).toMatchObject({ owner: { ownerId: null, workItemId: null } });
  });

  it('observes an active producer without fabricating completion', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: snapshot(),
    });
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => snapshot() })).resolves.toMatchObject({
      producerPresent: true,
      completedAtMs: null,
      lastProgressAtMs: 1_100,
    });
  });

  it('EI-21132791298856136: a held run-lock upgrades a systemd-inactive snapshot to active', async () => {
    const current = papercuspSnapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: '4bd9c405',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });

    const observed = await observeCheckpointProducer(certificate, {
      snapshot: async () => current,
      runLock: () => ({ held: true, elapsedSec: 3_610, pid: 27_158_55 }),
    });

    expect(observed).toMatchObject({
      producerPresent: true,
      state: 'active',
      lastProgressAtMs: -3_608_000,
      evidence: {
        active: true,
        candidate: null,
        activeSource: 'run-lock',
        runLockPid: 27_158_55,
        producerState: 'active',
      },
    });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'progressing',
      nextAction: 're-await',
    });
  });

  it('probes the resolved non-default pipeline root instead of the operator deploy root', async () => {
    const current = snapshot({
      slug: 'sidestage',
      activeRunRoot: '/workspace/sidestage',
      deploy: { integrationRoot: '/workspace/papercusp' } as GitPipelineSnapshot['deploy'],
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'sidestage', candidateSha: 'abc123', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: current,
    });
    const runLock = vi.fn(() => ({ held: true, elapsedSec: 1, pid: 42 }));

    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current, runLock });

    expect(runLock).toHaveBeenCalledExactlyOnceWith('/workspace/sidestage');
    expect(observed).toMatchObject({
      state: 'active',
      evidence: { active: true, activeSource: 'run-lock', runLockPid: 42 },
    });
  });

  it.each([null, '/workspace/other'])('does not probe a fallback root when the resolved root is %s', async (activeRunRoot) => {
    const current = snapshot({
      slug: 'sidestage',
      activeRunRoot,
      deploy: { integrationRoot: '/workspace/sidestage' } as GitPipelineSnapshot['deploy'],
      activeRun: null,
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'sidestage', candidateSha: 'abc123', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: current,
    });
    const runLock = vi.fn(() => ({ held: true, elapsedSec: 1, pid: 42 }));

    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current, runLock });

    expect(runLock).not.toHaveBeenCalled();
    expect(observed).toMatchObject({ state: 'unknown', evidence: { active: null } });
  });

  it('does not fabricate liveness when the live run-lock is not held', async () => {
    const current = papercuspSnapshot({ activeRun: null });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });

    const observed = await observeCheckpointProducer(certificate, {
      snapshot: async () => current,
      runLock: () => ({ held: false, elapsedSec: null }),
    });

    expect(observed).toMatchObject({
      producerPresent: true,
      state: 'unknown',
      evidence: { active: null, candidate: null, producerState: 'unknown' },
    });
    expect(observed.evidence).not.toHaveProperty('activeSource');
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('uses the advancing active-run heartbeat instead of immutable startedAtMs', async () => {
    const active = {
      active: true,
      candidate: 'abc123',
      startedAtMs: 1_100,
      progressAtMs: 9_000,
      elapsedSec: 480,
    };
    const current = snapshot({ activeRun: active });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    expect(certificate.lastProgressAtMs).toBe(9_000);
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => current })).resolves.toMatchObject({
      producerPresent: true,
      lastProgressAtMs: 9_000,
    });
  });

  it('recognizes a matching verdict after the certificate was issued', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp', candidateSha: 'abc1', ownerId: 'su-1', issuedAtMs: 1_500,
      expectedCadenceMs: 5_000, verificationDeadlineMs: 2_000, snapshot: snapshot(),
    });
    const withVerdict = snapshot({
      recent: [{ id: '1', kind: 'green_checkpoint', status: 'advanced', detail: { candidate: 'abc123' }, createdAtMs: 1_900 }],
    });
    await expect(observeCheckpointProducer(certificate, { snapshot: async () => withVerdict })).resolves.toMatchObject({
      completedAtMs: 1_900,
      lastFireAtMs: 1_900,
      evidence: { verdictStatus: 'advanced' },
    });
  });

  it.each(['skipped-joined-attempt', 'decision-pending'])(
    'does not treat %s as completion of an active candidate-bound producer',
    async (status) => {
      const current = papercuspSnapshot({
        generatedAtMs: 2_000,
        activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
        recent: [{
          id: 'skip-1',
          kind: 'green_checkpoint',
          status,
          detail: { candidate: 'abc123', runId: 'requested-run' },
          createdAtMs: 1_900,
        }],
      });
      const certificate = checkpointProducerCertificate({
        pipeline: 'papercusp',
        candidateSha: 'abc1',
        runId: 'requested-run',
        ownerId: 'su-1',
        issuedAtMs: 1_500,
        expectedCadenceMs: 5_000,
        verificationDeadlineMs: 2_000,
        snapshot: current,
      });

      const observed = await observeCheckpointProducer(certificate, {
        snapshot: async () => current,
        runLock: () => ({ held: true, elapsedSec: 3, pid: 42 }),
      });

      expect(observed).toMatchObject({
        producerPresent: true,
        state: 'active',
        completedAtMs: null,
        lastFireAtMs: null,
        evidence: { active: true, activeSource: 'run-lock', verdictStatus: null },
      });
      expect(classifyVerifiedWaitTimeout(certificate, observed)).toMatchObject({
        classification: 'progressing',
        nextAction: 're-await',
      });
    },
  );

  it('does not call a configured routine with no observed run stalled', async () => {
    const current = snapshot({ activeRun: null });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed).toMatchObject({
      producerPresent: true,
      state: 'unknown',
      evidence: { producerState: 'unknown', routineActive: true, candidate: null },
    });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('labels a running routine with no candidate as expected idle', async () => {
    const current = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          groupSlug: 'release',
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed).toMatchObject({ state: 'idle', evidence: { active: false, producerState: 'idle' } });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'expected-idle',
      nextAction: 're-await',
    });
  });

  it('EI-21502021074096764: a DELIBERATELY PAUSED routine reports state "paused", not "idle"', async () => {
    // Reproduces the exact payload that nearly caused a takeover of a live
    // peer's critical-path gate: every scalar below reads as "the producer is
    // not running", and only routinePauseReason says it is intentional.
    const current = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: false,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          groupSlug: 'release',
          pause: {
            reason: 'D-080/D-083: held pending a clean WI-41743 union affected-radius verdict',
            pausedBy: 'su-de924ac1',
            pausedAtMs: 1_000,
            // P-004: null = this fixture's hold predates TTL stamping (no auto-resume).
            expiresAtMs: null,
          },
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });

    // The state token itself must carry the pause, so a reader anchoring on it
    // cannot arrive at "stranded" from an unread sibling field.
    expect(observed).toMatchObject({
      state: 'paused',
      evidence: {
        producerState: 'paused',
        active: false,
        routineActive: false,
        candidate: null,
        routinePauseReason:
          'D-080/D-083: held pending a clean WI-41743 union affected-radius verdict',
      },
    });
    expect(observed.state).not.toBe('idle');

    // Behaviour is deliberately UNCHANGED: still a non-takeover outcome.
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'expected-idle',
      nextAction: 're-await',
    });
  });

  it('EI-21045433666635330: a candidate-bound wait whose probe produced NO reading at all is unknown, never stalled', async () => {
    // activeRun is entirely null here -- the probe never observed anything (a
    // skipped/unresolvable root, a swallowed probe exception) -- as distinct from the
    // "run disappears" test below, where activeRun is a real object confirming a
    // negative reading. A candidate-bound wait must not fall through to the
    // timestamp-staleness heuristic (and possibly "stalled"/takeover) on an absent
    // observation the same way it correctly would not for an unbound wait.
    const current = snapshot({ activeRun: null });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'ed20de6d',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBe('unknown');
    expect(observed.evidence).toMatchObject({ active: null, producerState: 'unknown' });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('EI-20971831715218093: a candidate-bound wait with no checkpoint candidate/run at all is unknown, never stalled', async () => {
    // activeRun IS observed here (unlike the EI-21045433666635330 case above) but
    // carries no candidate -- the checkpoint mechanism has not started judging
    // anything. That reading previously fell through to the timestamp-staleness
    // heuristic and could misread an intentionally quiescent producer (e.g. one
    // waiting behind a live, unrelated affected-test verifier task) as "stalled",
    // recommending an owner-takeover that would provoke duplicate checkpoint work.
    // No candidate/run existing is not evidence THIS candidate's run stalled --
    // it may simply not have started yet.
    const current = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          groupSlug: 'release',
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'abc1',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBe('unknown');
    expect(observed.evidence).toMatchObject({ active: null, producerState: 'unknown' });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });

  it('keeps a candidate-bound wait on the stalled path once a DIFFERENT candidate is the one being judged', async () => {
    // Distinct from the case above: here activeRun.candidate is non-null, so the
    // checkpoint mechanism DID pick something up -- just not the candidate this
    // wait names. That is real evidence our candidate was skipped/superseded, so
    // the old stalled/absent (timestamp-staleness) diagnosis still applies.
    const current = snapshot({
      activeRun: { active: false, candidate: 'def456', startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: true,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          groupSlug: 'release',
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      candidateSha: 'abc1',
      ownerId: 'su-1',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: current,
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => current });
    expect(observed.state).toBeUndefined();
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
    });
  });

  it('EI-21201405924579516: inactive run plus inactive routine without pause metadata is unknown, never absent', async () => {
    const certificate = checkpointProducerCertificate({
      pipeline: 'papercusp',
      ownerId: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
      workItemId: 'WI-40086',
      issuedAtMs: 1_500,
      expectedCadenceMs: 5_000,
      verificationDeadlineMs: 2_000,
      snapshot: snapshot(),
    });
    const ambiguous = snapshot({
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      routines: {
        gitSync: null,
        greenCheckpoint: {
          name: 'green-checkpoint',
          active: false,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          groupSlug: 'release',
          pause: null,
        },
        releaseTrigger: null,
      },
    });
    const observed = await observeCheckpointProducer(certificate, { snapshot: async () => ambiguous });
    expect(observed).toMatchObject({
      producerPresent: false,
      state: 'unknown',
      completedAtMs: null,
    });
    expect(classifyVerifiedWaitTimeout(certificate, { ...observed, checkedAtMs: 2_000 })).toMatchObject({
      classification: 'unknown',
      nextAction: 're-await',
    });
  });
});
