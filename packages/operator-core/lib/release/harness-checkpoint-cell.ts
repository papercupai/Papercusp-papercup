import type { CellSpec } from '../cell-registry';

/** Each caller reads only its own authenticated workspace/harness, never a home-pipeline fallback. */
export const HARNESS_CHECKPOINT_CELL: CellSpec = {
  cell: 'gate.harnessCheckpoint',
  registeredOn: '2026-11-02',
  owner: 'su-32ef73d7-119c-4839-97cf-351eb9891cf1',
  headline: 'checkpoint.qualification.phase',
  assessment: {
    path: 'checkpoint.assessment',
    codes: {
      recorded: { meaning: 'The caller harness has a checkpoint metadata row; this is recorded authority, with runner liveness explicitly unmeasured.',
        safeAction: 'Use the named candidate, attempt and runner to inspect that harness. Check its ownership before any live gate action; verify exact runner liveness before recovery.' },
      'no-checkpoint': { meaning: 'The scoped query found no checkpoint routine for this caller harness.',
        safeAction: 'Verify this harness release-gate configuration; do not substitute the operator-home gate.' },
      unscoped: { meaning: 'The request has no concrete authenticated workspace and harness.',
        safeAction: 'Bind the request to its intended harness before reading checkpoint state.' },
      unavailable: { meaning: 'The scoped read or one of its persisted authority records is unreadable.',
        safeAction: 'Resolve the named unknown before launch or recovery; absence and unreadability are different states.' },
    },
    evidence: ['checkpoint.target', 'checkpoint.qualification.status', 'checkpoint.repairQueue.status'],
  },
  nullable: true,
  unknownHoist: 'checkpoint.unknown',
  callerRelativity: { kind: 'ambient', source: 'authenticated ctx.workspaceId and ctx.harnessSlug' },
  provenance: {
    obtainedBy: 'One parameterized read of the caller harness checkpoint routine; canonical qualification and frozen-queue parsers.',
    liveExercised: true,
    evidence: 'Canonical-worktree live read in task 0mvzughu0sfz0ltkfa6 (exit 0), 2026-11-02: papercusp-workspace/papercusp-pr-drill-20261014-pot returned its own recorded terminal qualification 7ebc88be-8e09-44cc-bf9b-6664772b1357 and absent repair queue, without reading home pipeline state. This is historical recorded state, not a shipment verdict.',
  },
  resolver: 'readHarnessCheckpointState() @ packages/operator-core/lib/release/harness-checkpoint-state.ts',
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'checkpoint:state_snapshot', path: 'checkpoint' },
  shape: '{ target, observedAtMs, qualification, runId, repairHead, pendingRepairHead, recordedRunner, repairQueue, unknown[], note, assessment }',
};
