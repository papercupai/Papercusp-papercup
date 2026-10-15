import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessFrozenLineageLaunchCas, type FrozenRepairQueuePreflight } from './checkpoint-required-ancestor';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { projectFrozenRepairMarker, readFrozenRepairMarker } from './frozen-repair-edit-marker';
import {
  classifyFrozenLineageShellCommand,
  evaluateFrozenLineageCarryText,
  evaluateFrozenLineageShellCommand,
  frozenLineageCarryViolationPayload,
  readFrozenLineageIdentity,
} from './frozen-lineage-execution-policy';

const CANDIDATE = 'c'.repeat(40);
const REPAIR_HEAD = 'r'.repeat(40);
const STAGING_TIP = 's'.repeat(40);
const QUEUE_REVISION = 1_788_763_360_000;
const ROOT = '/workspace/papercusp';

const scratchDirs: string[] = [];

function liveQueue(): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 3,
    phase: 'ready-to-verify',
    candidate: CANDIDATE,
    base: 'b'.repeat(40),
    repairHead: REPAIR_HEAD,
    worktreePath: '/tmp/frozen-repair',
    attempts: 1,
    openedAtMs: QUEUE_REVISION - 1_000,
    updatedAtMs: QUEUE_REVISION,
    fixerSpawnId: null,
    failingTests: ['packages/operator-core/lib/release/stale-d017.test.ts'],
    signature: [],
    admissions: [],
    manifest: null,
  } as unknown as FrozenCandidateRepairQueue;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('frozen lineage stale-D-017 recurrence', () => {
  it('reads the projected live queue and refuses stale carry plus staging-tip launch without blocking repair controls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-lineage-d017-'));
    scratchDirs.push(dir);
    const markerPath = join(dir, 'frozen-repair-edit-marker.json');
    const queue = liveQueue();
    projectFrozenRepairMarker(queue, markerPath);

    const marker = readFrozenRepairMarker(markerPath);
    const liveIdentity = readFrozenLineageIdentity(markerPath);
    expect(marker).not.toBeNull();
    expect(liveIdentity).toEqual({
      candidate: CANDIDATE,
      repairHead: REPAIR_HEAD,
      queueRevision: QUEUE_REVISION,
    });

    const staleCarry = evaluateFrozenLineageCarryText(
      {
        surface: 'compaction-continuation',
        text: 'D-017 — Then pin whatever staging resolves to at that instant, still never a quoted sha.',
        target: null,
      },
      { marker },
    );
    expect(staleCarry).toMatchObject({
      allowed: false,
      errorCode: 'frozen_candidate_lineage_violation',
      unsafeSource: 'staging',
      liveIdentity,
    });
    expect(frozenLineageCarryViolationPayload(staleCarry)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'compaction-continuation',
      liveIdentity,
    });

    const livePreflight: FrozenRepairQueuePreflight = {
      proceed: true,
      reason: 'clear',
      candidate: REPAIR_HEAD,
      candidateSource: 'frozen-repair-queue',
      repairQueue: queue,
      frozenLineageIdentity: liveIdentity,
      queueDecision: 'verify-repair',
      nextAttempt: null,
      fixerSpawnId: null,
      fixerAlive: false,
    };
    expect(assessFrozenLineageLaunchCas(liveIdentity, livePreflight, STAGING_TIP)).toMatchObject({
      allowed: false,
      reason: 'checkout-head-mismatch',
      checkoutHead: STAGING_TIP,
      liveIdentity,
    });
    expect(assessFrozenLineageLaunchCas(liveIdentity, livePreflight, REPAIR_HEAD)).toMatchObject({
      allowed: true,
      reason: 'repair-head-match',
      checkoutHead: REPAIR_HEAD,
      liveIdentity,
    });

    for (const command of [
      'npm --workspace packages/operator-core test -- frozen-lineage-execution-policy.integration.test.ts',
      'ptool release:repair-queue --json - <<\'JSON\'\n{"op":"admit","paths":["a.ts"]}\nJSON',
    ]) {
      const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });
      expect(classification).toBeNull();
      await expect(evaluateFrozenLineageShellCommand(classification, ROOT, { marker })).resolves.toMatchObject({
        allowed: true,
        reason: 'operation-not-governed',
      });
    }
  });
});
