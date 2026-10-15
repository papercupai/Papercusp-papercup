import { describe, expect, it } from 'vitest';
import { probeAssignedFrozenRepairFixer } from './release-actions';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  type FrozenCandidateRepairQueueRead,
} from '../../release/frozen-candidate-repair-queue';

// WI-10007408: the scheduled gate tick probes the fixer an awaiting-fixer queue names and hands
// the verdict to successor reconciliation, keyed by the spawn id it probed.
const target = { workspaceId: 'ws', installSlug: 'papercusp' };
const awaiting = (fixerSpawnId: string | null) => ({
  ...markFrozenCandidateVerificationRed(
    createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
    { failingTests: ['broken.test.ts'], nowMs: 300 },
  ),
  fixerSpawnId,
});
const read = (queue: ReturnType<typeof awaiting>): (() => Promise<FrozenCandidateRepairQueueRead>) =>
  async () => ({ status: 'value', queue });

describe('probeAssignedFrozenRepairFixer', () => {
  it('maps the fixer probe onto runner liveness, keyed by the probed spawn id', async () => {
    const probed: string[] = [];
    const cases: Array<[boolean | null, 'live' | 'dead' | 'unknown']> = [
      [true, 'live'],
      [false, 'dead'],
      [null, 'unknown'],
    ];
    for (const [alive, liveness] of cases) {
      const out = await probeAssignedFrozenRepairFixer(target, {
        readQueue: read(awaiting('s-1')),
        fixerAlive: async (spawnId) => {
          probed.push(spawnId);
          return alive;
        },
      });
      expect(out).toEqual({ spawnId: 's-1', liveness });
    }
    expect(probed).toEqual(['s-1', 's-1', 's-1']);
  });

  it('reports unknown (fail-closed), never dead, when the liveness read throws', async () => {
    const out = await probeAssignedFrozenRepairFixer(target, {
      readQueue: read(awaiting('s-1')),
      fixerAlive: async () => {
        throw new Error('pg down');
      },
    });
    expect(out).toEqual({ spawnId: 's-1', liveness: 'unknown' });
  });

  it('returns null when there is no assigned fixer to judge', async () => {
    const never = async (): Promise<boolean | null> => {
      throw new Error('must not probe');
    };
    // awaiting-fixer with no fixer assigned (the WI-10007398 handoff covers that shape)
    expect(await probeAssignedFrozenRepairFixer(target, { readQueue: read(awaiting(null)), fixerAlive: never })).toBeNull();
    // a different phase
    expect(
      await probeAssignedFrozenRepairFixer(target, {
        readQueue: read({ ...awaiting('s-1'), phase: 'ready-to-verify' }),
        fixerAlive: never,
      }),
    ).toBeNull();
    // no queue
    expect(
      await probeAssignedFrozenRepairFixer(target, { readQueue: async () => ({ status: 'absent' }), fixerAlive: never }),
    ).toBeNull();
  });
});
