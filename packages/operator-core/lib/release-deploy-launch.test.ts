/**
 * release-deploy-launch.test.ts — the pure status/recommendation decision-tree + the detached
 * deploy launch (release-pipeline-resilience P-015). No PG, no real deploy — the spawn seam is
 * injected so launch is asserted by its systemd-run argv + close-code outcome.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-deploy-launch.test.ts
 */
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { frozenRepairLatency } from './release/frozen-candidate-repair-queue';

const gitPipelineSnapshotM = vi.hoisted(() => vi.fn());
vi.mock('./git-pipeline-stats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git-pipeline-stats')>()),
  gitPipelineSnapshot: gitPipelineSnapshotM,
}));
import {
  computeDeployStatus,
  computeDeployInFlight,
  parseSystemctlShow,
  readDeployInFlight,
  readDeployStatus,
  buildDeployCliArgs,
  buildSystemdRunArgv,
  launchDetachedDeploy,
  DEPLOY_UNIT,
} from './release-deploy-launch';
import type { DeployInFlight } from './release-deploy-launch';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import type { PipelineEventRow } from './harness/git-sync/pipeline-events';
import type { LiveReleaseCertification } from './release/live-release-certification';
import {
  buildDeployTerminalShell,
  DEPLOY_TERMINAL_MARKER_PATH,
  readDeployTerminalMarker,
} from './release-deploy-terminal';

/** Minimal snapshot fixture — computeDeployStatus reads gate + deploy (+ recent, EI-10902).
 *  Tests that exercise live checkpoint liveness add `activeRun` explicitly. */
function mkSnap(
  gate: Partial<GitPipelineSnapshot['gate']>,
  deploy: Partial<GitPipelineSnapshot['deploy']>,
  recent: PipelineEventRow[] = [],
): GitPipelineSnapshot {
  return {
    routines: {
      gitSync: null,
      greenCheckpoint: null,
      releaseTrigger: {
        name: 'release-trigger',
        active: true,
        cron: '0 */15 * * * *',
        lastFiredAtMs: Date.now(),
        nextFireAtMs: Date.now() + 15 * 60_000,
        pause: null,
      },
    },
    gate: {
      consecutiveReds: 0,
      lastGreenAtMs: null,
      // EI-20706962612084953: defaults to null = "the writer stamped no verdict marker",
      // i.e. the pre-fix blob shape, so every EXISTING case here keeps exercising the old
      // behaviour and only the cases that opt in below assert the new one.
      recordedVerdict: null,
      firstRedAtMs: null,
      stalled: false,
      lastFiredAtMs: null,
      fireStale: false,
      fireStaleReason: null,
      verdictObservedAtMs: null,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      failingTestsMeasured: null,
      ...gate,
    },
    deploy: {
      integrationRoot: '/x',
      releaseRoot: '/x-release',
      releaseRef: 'main',
      integrationBranch: 'staging',
      stagingHead: { sha: 'staging00head', shortSha: 'staging0', committedAtMs: 0, subject: 's' },
      ready: { sha: 'greenpin0sha', shortSha: 'greenpin', committedAtMs: 0, subject: 'g' },
      deployed: { sha: 'deployed0sha', shortSha: 'deployed', committedAtMs: 0, subject: 'd' },
      deployedAtMs: 1,
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      errors: [],
      ...deploy,
    },
    activeRun: null,
    recent,
  } as unknown as GitPipelineSnapshot;
}

function liveCertification(
  status: LiveReleaseCertification['status'] = 'certified',
): LiveReleaseCertification {
  return {
    status,
    targetSha: 'greenpin0sha',
    certified: status === 'certified',
    reason: status === 'certified' ? 'exact source certified' : `certification ${status}`,
    bankPath: '/tmp/verdicts.jsonl',
    evidence: null,
    invalidLines: 0,
  };
}

describe('computeDeployStatus — decision tree', () => {
  it('preserves an unmeasured gate stalled signal as unknown', () => {
    const s = computeDeployStatus(mkSnap({ stalled: null }, {}));
    expect(s.gate.stalled).toBeNull();
  });

  it('projects the normalized repair queue into release status', () => {
    const repairQueue = {
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      repairHead: 'b'.repeat(40),
      attempts: 1,
      openedAtMs: 1,
      updatedAtMs: 2,
      ageMs: 3,
      ageEscalationRung: 0,
      repairLatency: frozenRepairLatency({ openedAtMs: 1, phase: 'awaiting-fixer' }, 60_001),
      ageEscalationIntervalMs: 8 * 60 * 60_000,
      zeroAttemptStalled: false,
      zeroAttemptStallMs: 15 * 60_000,
      fixerSpawnId: 'fixer-1',
      fixerAlive: false,
      legs: [],
      signature: [],
      admissions: [],
      blockedReason: null,
      dispatchReservation: null,
      decision: 'recover-dead-fixer',
      retireAllowed: true,
      retireRefusal: null,
      // No shared-tree edit set is supplied here, so the collision probe is explicitly
      // UNMEASURED rather than a false all-clear. `collidingPaths` carries an explicit
      // `string[]` because the enclosing `as const` would otherwise infer `readonly []`,
      // which is not assignable to the interface's mutable `string[]`.
      manifest: null,
      manifestSummary: null,
      sharedTreeCollision: {
        measured: false,
        repairInFlight: false,
        collidingPaths: [] as string[],
        collisionCount: 0,
        truncated: false,
        detail: null,
      },
      nextAction: 'release:repair-queue',
    } as const;
    const s = computeDeployStatus(mkSnap({ repairQueue }, {}));
    expect(s.gate.repairQueue).toEqual(repairQueue);
  });

  it('green-deployable: green gate + green code ahead of the live deploy → canTriggerGreen', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 2 }));
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
    expect(s.recommendation).toMatch(/trigger/i);
  });

  it('P-010: a measured missing exact-SHA certificate blocks an otherwise-green deploy', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 2 }),
      null,
      liveCertification('missing'),
    );

    expect(s.state).toBe('live-certification-required');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.liveCertification?.status).toBe('missing');
    expect(s.recommendation).toMatch(/fail-closed|independent certification/i);
  });

  it('P-010: a measured exact-SHA live RED is distinct from missing certification', () => {
    const s = computeDeployStatus(
      mkSnap({}, { deployedBehindGreenPin: 1 }),
      null,
      liveCertification('failed'),
    );

    expect(s.state).toBe('live-certification-failed');
    expect(s.canTriggerGreen).toBe(false);
  });

  it('P-010: a current exact-SHA live certificate preserves the green deploy path', () => {
    const s = computeDeployStatus(
      mkSnap({}, { deployedBehindGreenPin: 1 }),
      null,
      liveCertification('certified'),
    );

    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
  });

  it('gate-red: reds present → NOT triggerable, recommendation says fix the reds', () => {
    const s = computeDeployStatus(
      mkSnap(
        { consecutiveReds: 2, lastFixerStatus: 'spawned', failingTests: ['lib/red.test.ts'] },
        { deployedBehindGreenPin: 0 },
      ),
    );
    expect(s.state).toBe('gate-red');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/FIX the reds/);
    expect(s.recommendation).toMatch(/owner/i); // force only with owner sign-off
  });

  it('gate-red with no attributable failures does not send responders hunting for tests', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 1, failingTests: [] }, { deployedBehindGreenPin: 0 }),
    );
    expect(s.state).toBe('gate-red');
    expect(s.recommendation).toMatch(/names no failing tests/);
    expect(s.recommendation).toMatch(/do NOT go hunting for tests/i);
    expect(s.recommendation).not.toMatch(/FIX the reds/);
  });

  it('a green PIN ahead is triggerable even when the gate is currently RED (the pin is green by construction)', () => {
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 1 }, { deployedBehindGreenPin: 3 }));
    // A later red must NOT strand an already-green pin: hasGreenAhead → green-deployable AND
    // canTriggerGreen, decoupled from the current gate color (auto-serve ships "green main ahead"
    // regardless). Previously canTriggerGreen also required gateGreen, which wedged op:trigger in
    // exactly the state whose recommendation told you to run it.
    expect(s.gate.green).toBe(false);
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
    expect(s.recommendation).toMatch(/trigger/i);
  });

  it('projects release-trigger timing and a stale-fire verdict into deploy status', () => {
    const nowMs = Date.parse('2026-09-23T12:00:00.000Z');
    const snap = mkSnap({}, { deployedBehindGreenPin: 4 });
    snap.routines.releaseTrigger = {
      ...snap.routines.releaseTrigger!,
      lastFiredAtMs: nowMs - 31 * 60_000,
      nextFireAtMs: nowMs + 14 * 60_000,
    };

    const status = computeDeployStatus(snap, null, undefined, null, nowMs);

    expect(status.releaseTrigger).toMatchObject({
      active: true,
      cron: '0 */15 * * * *',
      lastFiredAtMs: nowMs - 31 * 60_000,
      nextFireAtMs: nowMs + 14 * 60_000,
      fireStale: true,
    });
    expect(status.releaseTrigger.fireStaleReason).toContain('has not FIRED');
  });

  it('keeps a recently fired release-trigger healthy while green code is pending', () => {
    const nowMs = Date.parse('2026-09-23T12:00:00.000Z');
    const snap = mkSnap({}, { deployedBehindGreenPin: 4 });
    snap.routines.releaseTrigger = {
      ...snap.routines.releaseTrigger!,
      lastFiredAtMs: nowMs - 5 * 60_000,
    };

    const status = computeDeployStatus(snap, null, undefined, null, nowMs);

    expect(status.releaseTrigger.fireStale).toBe(false);
    expect(status.releaseTrigger.fireStaleReason).toBeNull();
  });

  it('a deliberate release-trigger pause blocks and explains an otherwise green deploy', () => {
    const snap = mkSnap({}, { deployedBehindGreenPin: 3 });
    snap.routines.releaseTrigger = {
      ...snap.routines.releaseTrigger!,
      active: false,
      pause: {
        reason: 'hold until checkout repair is included in a fresh green pin',
        pausedBy: 'su-release-owner',
        pausedAtMs: Date.parse('2026-08-15T09:07:00Z'),
        // P-004: null = no auto-resume scheduled for this fixture's hold.
        expiresAtMs: null,
      },
    };
    const s = computeDeployStatus(snap);
    expect(s.state).toBe('release-trigger-paused');
    expect(s.releaseTrigger).toMatchObject({ active: false, blocked: true });
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/checkout repair|Do NOT resume/);
  });

  it('fails an ordinary trigger closed when release-trigger control is unavailable', () => {
    const snap = mkSnap({}, { deployedBehindGreenPin: 1 });
    snap.routines.releaseTrigger = null;
    const s = computeDeployStatus(snap);
    expect(s.state).toBe('release-trigger-unavailable');
    expect(s.releaseTrigger.blocked).toBe(true);
    expect(s.canTriggerGreen).toBe(false);
  });

  it('gate-wedged: 0 reds but the checkpoint is not firing → surface to an operator', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: true, fireStaleReason: 'no fire in 9h' }, { deployedBehindGreenPin: 0 }),
    );
    expect(s.state).toBe('gate-wedged');
    expect(s.canTriggerGreen).toBe(false);
    expect(s.recommendation).toMatch(/WEDGED|no fire in 9h/);
  });

  it('a live checkpoint run suppresses the age-only WEDGED classification', () => {
    const s = computeDeployStatus({
      ...mkSnap(
        { consecutiveReds: 0, fireStale: true, fireStaleReason: 'no GREEN verdict in ~12h' },
        { deployedBehindGreenPin: 0, greenPinBehindStaging: 3 },
      ),
      activeRun: {
        active: true,
        logPath: '/tmp/papercup-green-checkpoint-manual-demo.log',
        candidate: '80cde64e',
        startedAtMs: Date.now() - 15 * 60_000,
        elapsedSec: 900,
      },
    });
    expect(s.gate.fireStale).toBe(false);
    expect(s.checkpointRunInFlight?.logPath).toBe('/tmp/papercup-green-checkpoint-manual-demo.log');
    expect(s.gate.fireStaleReason).toBeNull();
    expect(s.state).toBe('staging-buffered');
    expect(s.recommendation).not.toMatch(/WEDGED/);
  });

  it('surfaces an active auto-refire and never recommends a duplicate checkpoint run', () => {
    const activeRun = {
      active: true,
      candidate: 'fb941a2c',
      initialCandidate: '80cde64e',
      refireObserved: true,
      startedAtMs: Date.now() - 15 * 60_000,
      elapsedSec: 900,
    };
    const s = computeDeployStatus({
      ...mkSnap(
        { consecutiveReds: 13, verdictStale: true, verdictStaleReason: 'stale candidate' },
        { deployedBehindGreenPin: 0 },
      ),
      activeRun,
    });
    expect(s.checkpointRunInFlight).toEqual(activeRun);
    expect(s.recommendation).toMatch(/ACTIVE.*fb941a2c/);
    expect(s.recommendation).toMatch(/Do NOT run `release:checkpoint-run` again/);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run for a FRESH verdict/);
  });

  it('a probed-idle checkpoint run does not suppress a genuine WEDGED classification', () => {
    const s = computeDeployStatus({
      ...mkSnap(
        { consecutiveReds: 0, fireStale: true, fireStaleReason: 'no fire in 9h' },
        { deployedBehindGreenPin: 0 },
      ),
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
    });
    expect(s.gate.fireStale).toBe(true);
    expect(s.state).toBe('gate-wedged');
  });

  it('staging-buffered: green gate, nothing deployable yet, staging awaiting the next checkpoint', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 0, greenPinBehindStaging: 4 }));
    expect(s.state).toBe('staging-buffered');
    expect(s.canTriggerGreen).toBe(false);
  });

  it('up-to-date: live :3070 is at the green pin', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 0, greenPinBehindStaging: 0 }));
    expect(s.state).toBe('up-to-date');
    expect(s.nothingToDeploy).toBe(true);
  });

  it('a latest non-verdict checkpoint tick is a wedge, not staging-buffered optimism', () => {
    const skippedLocked: PipelineEventRow = {
      id: 'skipped-locked-1',
      kind: 'green_checkpoint',
      status: 'skipped-locked',
      detail: {},
      createdAtMs: 2,
    };
    const olderVerdict: PipelineEventRow = {
      id: 'advanced-1',
      kind: 'green_checkpoint',
      status: 'advanced',
      detail: { green: true },
      createdAtMs: 1,
    };
    const s = computeDeployStatus(
      mkSnap(
        { consecutiveReds: 0, fireStale: false },
        { deployedBehindGreenPin: 0, greenPinBehindStaging: 4 },
        [skippedLocked, olderVerdict],
      ),
    );

    expect(s.gate.lastVerdict?.status).toBe('skipped-locked');
    expect(s.state).toBe('gate-wedged');
    expect(s.recommendation).toMatch(/skipped-locked/);
    expect(s.recommendation).toMatch(/no gate verdict|FRESH verdict/i);
    expect(s.recommendation).toMatch(/scheduled routine/i);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run/);
  });

  it('D-067: a live repair hold is a typed blocker, not a verdict, and suppresses inherited failures', () => {
    const repairHold: PipelineEventRow = {
      id: 'repair-in-progress-1',
      kind: 'green_checkpoint',
      status: 'repair-in-progress',
      detail: { candidate: 'dfe7bd9f', failingTests: ['historical-red.test.ts'] },
      createdAtMs: 2,
    };
    const snap = mkSnap(
      {
        consecutiveReds: 41,
        failingTests: ['historical-red.test.ts'],
        verdictStale: true,
        verdictStaleReason: 'its runs are being SKIPPED (run-lock contention), so this red is unverified',
        inconclusive: {
          status: 'repair-in-progress',
          candidate: 'dfe7bd9f',
          detail: 'frozen repair queue owns progress',
          observedAtMs: 1,
        },
      },
      { deployedBehindGreenPin: 0 },
      [repairHold],
    );
    snap.activeRun = { active: false, candidate: null, startedAtMs: null, elapsedSec: null };

    const s = computeDeployStatus(snap);

    expect(s.gate.lastVerdict?.status).toBe('repair-in-progress');
    expect(s.checkpoint).toMatchObject({
      state: 'blocked',
      authority: 'live-probe',
      blocker: "latest checkpoint ended 'repair-in-progress' without a gate verdict",
      verdictPending: false,
    });
    expect(s.gate.failingTests).toEqual([]);
    expect(s.gate.verdictStaleReason).toMatch(/completed without producing a gate verdict/);
    expect(s.gate.verdictStaleReason).toMatch(/reason: repair-in-progress/);
    expect(s.gate.verdictStaleReason).toMatch(/not evidence of run-lock contention/);
    expect(s.gate.verdictStaleReason).not.toMatch(/SKIPPED \(run-lock contention\)/);
    expect(s.state).toBe('gate-wedged');
    expect(s.recommendation).toMatch(/scheduled routine.*FRESH guarded verdict/i);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run/);
  });

  it('D-067: an idle run plus an absent repair queue retires the stale repair hold and historical failures', () => {
    const staleRepairHold: PipelineEventRow = {
      id: 'repair-in-progress-terminal-1',
      kind: 'green_checkpoint',
      status: 'repair-in-progress',
      detail: { candidate: 'dfe7bd9f', failingTests: ['historical-red.test.ts'] },
      createdAtMs: 2,
    };
    const snap = mkSnap(
      {
        consecutiveReds: 41,
        failingTests: ['historical-red.test.ts'],
        // `git-pipeline-stats.currentGateInconclusive` returns null once repair_queue
        // is authoritatively absent. This is the live dfe7bd9f mismatch D-067 names.
        inconclusive: null,
      },
      { deployedBehindGreenPin: 0 },
      [staleRepairHold],
    );
    snap.activeRun = { active: false, candidate: null, startedAtMs: null, elapsedSec: null };

    const s = computeDeployStatus(snap);

    expect(s.gate.lastVerdict).toBeNull();
    expect(s.checkpoint).toMatchObject({ state: 'idle', authority: 'live-probe', blocker: null });
    expect(s.gate.failingTests).toEqual([]);
    expect(s.gate.verdictStale).toBe(true);
    expect(s.gate.verdictStaleReason).toMatch(/repair queue is absent.*run-lock is measured idle/i);
    expect(s.state).toBe('gate-verdict-stale');
    expect(s.recommendation).not.toContain('historical-red.test.ts');
    expect(s.recommendation).toMatch(/scheduled routine.*FRESH verdict/i);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run/);
  });

  it('does not classify a non-verdict tick as wedged while a checkpoint is active', () => {
    const s = computeDeployStatus({
      ...mkSnap(
        { consecutiveReds: 0, fireStale: true, fireStaleReason: 'no fresh verdict' },
        { deployedBehindGreenPin: 0, greenPinBehindStaging: 4 },
        [{ id: 'skipped-locked-2', kind: 'green_checkpoint', status: 'skipped-locked', detail: {}, createdAtMs: 2 }],
      ),
      activeRun: {
        active: true,
        candidate: 'candidate1234',
        startedAtMs: 1,
        elapsedSec: 60,
      },
    });

    expect(s.state).toBe('staging-buffered');
    expect(s.state).not.toBe('gate-wedged');
    expect(s.recommendation).toMatch(/ACTIVE/);
  });
});

describe('buildDeployCliArgs', () => {
  it('trigger → plain --execute (green pin)', () => {
    expect(buildDeployCliArgs({})).toEqual(['--execute']);
  });
  it('force → --deploy-commit <sha> --force --execute', () => {
    expect(buildDeployCliArgs({ force: true, commit: 'abc1234' })).toEqual([
      '--deploy-commit',
      'abc1234',
      '--force',
      '--execute',
    ]);
  });
  it('force without a valid sha throws (no blind un-green deploy)', () => {
    expect(() => buildDeployCliArgs({ force: true })).toThrow(/commit sha/i);
    expect(() => buildDeployCliArgs({ force: true, commit: 'not-a-sha!' })).toThrow(/commit sha/i);
  });
});

describe('buildSystemdRunArgv', () => {
  it('runs the deploy as the shared transient unit, self-authorizing the restart', () => {
    const argv = buildSystemdRunArgv('/repo', ['--execute'], '/tmp/x.log', '/usr/bin');
    expect(argv).toContain(`--unit=${DEPLOY_UNIT}`);
    expect(argv).toContain('--property=CollectMode=inactive-or-failed');
    expect(argv).toContain('--working-directory=/repo');
    expect(argv).toContain('--setenv=PATH=/usr/bin');
    const inner = argv[argv.length - 1]!;
    expect(inner).toMatch(/PAPERCUSP_ALLOW_DEV_RESTART=1/);
    expect(inner).toMatch(/deploy-cli\.ts --execute/);
    expect(inner).toMatch(/> \/tmp\/x\.log 2>&1/);
    expect(inner).toContain(DEPLOY_TERMINAL_MARKER_PATH);
    expect(inner).toContain('trap _papercusp_write_deploy_terminal EXIT');
  });
});

describe('detached deploy terminal marker', () => {
  it('removes stale evidence, atomically records failure, and preserves the payload exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-terminal-'));
    const marker = join(dir, 'terminal.json');
    try {
      writeFileSync(marker, '{"exitCode":0,"finishedAt":"2000-01-01T00:00:00Z"}\n');
      const shell = buildDeployTerminalShell('test ! -e "$marker"; exit 7', marker);
      const result = spawnSync('bash', ['-c', shell], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });

      expect(result.status).toBe(7);
      expect(readDeployTerminalMarker(marker)).toMatchObject({
        exitCode: 7,
        markerPath: marker,
      });
      expect(readdirSync(dir)).toEqual(['terminal.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats malformed terminal evidence as unknown, never as success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-terminal-'));
    const marker = join(dir, 'terminal.json');
    try {
      writeFileSync(marker, '{"exitCode":"zero","finishedAt":"not-a-date"}\n');
      expect(readDeployTerminalMarker(marker)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fake child_process: emits the given close code (+ optional stderr) on the next tick. */
function fakeSpawn(closeCode: number, stderr = '') {
  const calls: { cmd: string; argv: string[] }[] = [];
  const fn = ((cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', closeCode);
    });
    return child as unknown;
  }) as unknown as typeof import('node:child_process').spawn & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

describe('launchDetachedDeploy', () => {
  it('launches systemd-run and reports launched on exit 0 — never fires a real deploy', async () => {
    const fn = fakeSpawn(0);
    const r = await launchDetachedDeploy({ root: '/repo' }, fn);
    expect(r.launched).toBe(true);
    expect(r.mode).toBe('trigger');
    expect(r.unit).toBe(DEPLOY_UNIT);
    const call = (fn as unknown as { calls: { cmd: string; argv: string[] }[] }).calls[0]!;
    expect(call.cmd).toBe('systemd-run');
    expect(call.argv).toContain(`--unit=${DEPLOY_UNIT}`);
  });

  it('a non-zero exit (unit already exists ⇒ deploy in flight) reports NOT launched + a reason', async () => {
    const fn = fakeSpawn(1, 'Unit papercup-auto-deploy.service already exists.');
    const r = await launchDetachedDeploy({ root: '/repo' }, fn);
    expect(r.launched).toBe(false);
    expect(r.reason).toMatch(/already.*exist|in flight/i);
  });

  it('force mode shells the --force --deploy-commit flags', async () => {
    const fn = fakeSpawn(0);
    const r = await launchDetachedDeploy({ root: '/repo', force: true, commit: 'deadbeef' }, fn);
    expect(r.mode).toBe('force');
    const inner = r.argv[r.argv.length - 1]!;
    expect(inner).toMatch(/--deploy-commit deadbeef --force --execute/);
  });

  it('WI-10005763 (D-012): a held restricted write refuses BEFORE spawning, trigger and force alike; nothing held spawns', async () => {
    const held = {
      error: 'restricted_write_held' as const,
      hint: '1 held restricted write(s) in /repo (secret.ts). This action executes code from that tree with network access (D-012)',
    };
    for (const opts of [{ root: '/repo' }, { root: '/repo', force: true, commit: 'deadbeef' }]) {
      const fn = fakeSpawn(0);
      const fence = vi.fn(async (_roots: readonly string[]) => held);
      const r = await launchDetachedDeploy(opts, fn, fence);
      expect(fence).toHaveBeenCalledWith(['/repo']);
      expect((fn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
      expect(r).toMatchObject({ launched: false, reason: 'restricted_write_held', restrictedHold: held });
    }
    // Control: the same call with nothing held reaches systemd-run.
    const fn = fakeSpawn(0);
    const r = await launchDetachedDeploy({ root: '/repo' }, fn, vi.fn(async () => null));
    expect(r.launched).toBe(true);
    expect((fn as unknown as { calls: unknown[] }).calls).toHaveLength(1);
  });
});

/**
 * WI-4489 — a STALE red must not masquerade as the gate's current colour.
 *
 * The live incident (2026-07-12): `gate_health` froze on 4 reds from the pnpm-hijack window while
 * the routine kept firing and skipping on the run-lock. `op:status` reported `gate-red` + "FIX the
 * reds" for ~3.5h. All 8 named tests passed; the gate was green on every real run. That
 * recommendation is what dispatched the fixer whose manual runs held the lock that kept the routine
 * skipping — the stale red sustained itself.
 */
describe('WI-4489: gate verdict staleness', () => {
  it('⭐ a STALE red does NOT report gate-red, and does NOT send anyone to fix the tests it names', () => {
    const s = computeDeployStatus(
      mkSnap(
        { consecutiveReds: 4, verdictStale: true, verdictStaleReason: 'the release pin has advanced' },
        { deployedBehindGreenPin: 0 },
      ),
    );
    expect(s.state).toBe('gate-verdict-stale');
    expect(s.state).not.toBe('gate-red');
    expect(s.recommendation).toMatch(/STALE/);
    expect(s.recommendation).toMatch(/Do NOT chase the failing tests/);
    expect(s.recommendation).toMatch(/scheduled routine.*FRESH verdict/i);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run/);
    // …and it must NOT claim the gate is green either. The honest state is "unknown".
    expect(s.gate.green).toBe(false);
    expect(s.gate.verdictStale).toBe(true);
  });

  it('⭐ a LIVE red still reports gate-red — the fix must not blind the gate (the EI-10609 lesson)', () => {
    const s = computeDeployStatus(
      mkSnap(
        { consecutiveReds: 4, verdictStale: false, failingTests: ['lib/red.test.ts'] },
        { deployedBehindGreenPin: 0 },
      ),
    );
    expect(s.state).toBe('gate-red');
    expect(s.recommendation).toMatch(/FIX the reds/);
  });

  it('EI-21547567568436120: candidate-fossil names the sole authority instead of adding to the materializer convoy', () => {
    const fossilEvent: PipelineEventRow = {
      id: 'candidate-fossil-1',
      kind: 'green_checkpoint',
      status: 'candidate-fossil',
      detail: { candidate: 'fossil123456' },
      createdAtMs: 2,
    };
    const authority = {
      withheld: true as const,
      governingRef: 'WI-40086',
      source: 'serializer-fence' as const,
      reason: 'WI-40086 owns the exclusive checkpoint serializer fence.',
    };
    const s = computeDeployStatus(
      mkSnap(
        {
          consecutiveReds: 44,
          verdictStale: true,
          verdictStaleReason: 'candidate-fossil',
          verdictStaleReasonCode: 'candidate-fossil',
        },
        { deployedBehindGreenPin: 0 },
        [fossilEvent],
      ),
      null,
      undefined,
      authority,
    );

    expect(s.state).toBe('gate-verdict-stale');
    expect(s.manualRunAuthority).toEqual(authority);
    expect(s.recommendation).toMatch(/Candidate selection is already owned by WI-40086/);
    expect(s.recommendation).toMatch(/exclusive materializer/);
    expect(s.recommendation).toMatch(/scheduled green-checkpoint routine/);
    expect(s.recommendation).not.toMatch(/Run release:checkpoint-run for a FRESH verdict/);
  });

  it('CONTROL: candidate-fossil without withheld authority preserves the ordinary scheduled-routine guidance', () => {
    const s = computeDeployStatus(
      mkSnap(
        {
          consecutiveReds: 44,
          verdictStale: true,
          verdictStaleReason: 'candidate-fossil',
          verdictStaleReasonCode: 'candidate-fossil',
        },
        { deployedBehindGreenPin: 0 },
      ),
    );

    expect(s.manualRunAuthority).toBeNull();
    expect(s.recommendation).toMatch(/scheduled routine.*FRESH verdict/i);
    expect(s.recommendation).not.toMatch(/exclusive materializer/);
  });

  it('a stale red never strands a deployable green pin — green-deployable still wins', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 4, verdictStale: true }, { deployedBehindGreenPin: 146 }),
    );
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true); // decoupled from gate colour by design (line ~118)
  });
});

/**
 * EI-18646778682511611 — a partial ('advanced-prefix', P-016/D-010) advance resets
 * `consecutiveReds` to 0 by design (the stall streak means "is main frozen", and a
 * partial advance proves it isn't) — but `tryLongestGreenPrefix` returns `green: false`
 * for that same tick on purpose: the candidate/tip is a CONFIRMED, reproducing red, only
 * the longest green prefix behind it shipped. Reusing the reset stall counter as "the
 * gate is green" reported gate.green=true for a tick with real, non-flaky test failures —
 * the live incident: three genuine regressions (a migration-atomicity lint + two design-
 * token lints) reproduced identically across the retry, yet op:status read green=true.
 */
describe('EI-18646778682511611: an advanced-prefix tick must not report gate.green=true', () => {
  const advancedPrefixEvent: PipelineEventRow = {
    id: '1',
    kind: 'green_checkpoint',
    status: 'advanced-prefix',
    detail: { green: false, candidate: 'redtip0000000', from: 'lastready00000', logPath: '/tmp/x-run.log' },
    createdAtMs: 1_720_000_000_000,
  };

  it('⭐ gate.green is false right after an advanced-prefix tick, even though consecutiveReds was reset to 0', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false }, {}, [advancedPrefixEvent]),
    );
    expect(s.gate.lastVerdict?.status).toBe('advanced-prefix');
    expect(s.gate.green).toBe(false);
  });

  it('a genuine full advance (status "advanced") still reports gate.green=true — the fix is scoped to advanced-prefix only', () => {
    const advancedEvent: PipelineEventRow = { ...advancedPrefixEvent, status: 'advanced', detail: { green: true } };
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false }, {}, [advancedEvent]));
    expect(s.gate.green).toBe(true);
  });

  it('the green pin still ships behind an advanced-prefix tip — canTriggerGreen decoupled from gate.green', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 1 }, [advancedPrefixEvent]),
    );
    expect(s.gate.green).toBe(false);
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true); // deploying the CONFIRMED-green prefix is still safe
  });

  /**
   * EI-20706962612084953 — the SAME laundering, one status over, and the reason the
   * exclusion above had to stop being enumerated per-status.
   *
   * `trackGateStall`'s `reset` class zeroes `consecutiveReds` for a genuinely NOT-GREEN
   * verdict too, whenever the release pin moved (`main` advancing via a path the routine
   * never saw — a manual run, another lineage's gate). That tick's status is plain
   * 'not-green', so the `advanced-prefix` carve-out above never sees it, and `gate.green`
   * read TRUE for a run whose recorded verdict was red. The writer now states its own
   * verdict in `gate_health.lastVerdict`, surfaced here as `recordedVerdict`, which
   * settles it for every status at once instead of one incident at a time.
   */
  it('⭐ gate.green is false when the writer RECORDED not-green, even with consecutiveReds 0 and no advanced-prefix event', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false, recordedVerdict: 'not-green' }, {}),
    );
    expect(s.gate.green).toBe(false);
  });

  it('a recorded GREEN verdict still reports gate.green=true', () => {
    const s = computeDeployStatus(
      mkSnap({ consecutiveReds: 0, fireStale: false, recordedVerdict: 'green' }, {}),
    );
    expect(s.gate.green).toBe(true);
  });

  it('a blob predating the marker (recordedVerdict null) degrades to the previous behaviour', () => {
    // CONTROL: proves the new clause is scoped to an explicit 'not-green' and is not
    // quietly turning every unmarked read red.
    const s = computeDeployStatus(mkSnap({ consecutiveReds: 0, fireStale: false, recordedVerdict: null }, {}));
    expect(s.gate.green).toBe(true);
  });

  /**
   * CONTROL (permanent, pure): a guard that has never been observed to FAIL is a guard
   * nobody has tested. This keeps the PRE-FIX predicate in the file as a deliberately-wrong
   * implementation, so the ⭐ case above is provably falsifiable without mutating the shared
   * tree (which git-sync can commit mid-probe). If the `!lastVerdictRecordedNotGreen` clause
   * is ever dropped from `computeDeployStatus`, the real subject converges on this control
   * and the ⭐ case goes red.
   */
  it('control: the PRE-FIX predicate reports GREEN for the exact input the fix reports red for', () => {
    const g = { consecutiveReds: 0, fireStale: false, recordedVerdict: 'not-green' as const };
    const lastVerdictWasPartialRed = false; // no advanced-prefix event — the old carve-out cannot see this tick

    // the predicate as it stood before EI-20706962612084953
    const preFixGateGreen = g.consecutiveReds === 0 && !g.fireStale && !lastVerdictWasPartialRed;
    expect(preFixGateGreen).toBe(true); // ← the false green this item was filed about

    // the real subject, same input
    expect(computeDeployStatus(mkSnap(g, {})).gate.green).toBe(false);
  });
});

/**
 * EI-10902: "what did the last gate tick decide, and on what code?" — previously answerable
 * only by grepping ANSI-coloured log files + cross-referencing a checkout's git log. The
 * candidate sha / failing tests / log path were ALREADY persisted (WI-4494's recordCheckpointVerdict
 * writes them into harness_shared.pipeline_events; WI-4533 already threaded failingTests into
 * GitPipelineSnapshot.gate) — this just threads BOTH through to the existing agent-facing
 * release:deploy{op:status} surface instead of leaving them stranded in the snapshot.
 */
describe('EI-10902: lastVerdict + failingTests surfaced on DeployStatus.gate', () => {
  const greenEvent: PipelineEventRow = {
    id: '1',
    kind: 'green_checkpoint',
    status: 'advanced',
    detail: { green: true, candidate: 'deadbeefcafe', from: '28a3a3d50258', logPath: '/tmp/x-run.log' },
    createdAtMs: 1_720_000_000_000,
  };

  it('lastVerdict is null when no green_checkpoint event has ever been recorded', () => {
    const s = computeDeployStatus(mkSnap({}, {}, []));
    expect(s.gate.lastVerdict).toBeNull();
    expect(s.gate.failingTests).toEqual([]);
  });

  it('lastVerdict surfaces the newest green_checkpoint event candidate/from/status/logPath', () => {
    const s = computeDeployStatus(mkSnap({}, {}, [greenEvent]));
    expect(s.gate.lastVerdict).toEqual({
      tickAtMs: 1_720_000_000_000,
      candidate: 'deadbeefcafe',
      from: '28a3a3d50258',
      status: 'advanced',
      logPath: '/tmp/x-run.log',
    });
  });

  it('picks the FIRST (newest) green_checkpoint event, skipping other pipeline-event kinds ahead of it', () => {
    const newer: PipelineEventRow = { id: '2', kind: 'git_sync', status: 'synced', detail: {}, createdAtMs: 2 };
    const s = computeDeployStatus(mkSnap({}, {}, [newer, greenEvent]));
    expect(s.gate.lastVerdict?.candidate).toBe('deadbeefcafe');
  });

  it('a RED tick with no candidate/logPath recorded (old-CLI skew) degrades to nulls, not a throw', () => {
    const bareRed: PipelineEventRow = { id: '3', kind: 'green_checkpoint', status: 'not-green', detail: {}, createdAtMs: 5 };
    const s = computeDeployStatus(mkSnap({}, {}, [bareRed]));
    expect(s.gate.lastVerdict).toEqual({ tickAtMs: 5, candidate: null, from: null, status: 'not-green', logPath: null });
  });

  it('gate_health.failingTests (WI-4533) is threaded through unchanged', () => {
    const s = computeDeployStatus(
      mkSnap({ failingTests: ['lib/a.test.ts', 'lib/b.test.ts'], failingTestsMeasured: true }, {}, []),
    );
    expect(s.gate.failingTests).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(s.gate.failingTestsMeasured).toBe(true);
  });

  it('keeps a no-verdict empty list explicitly unmeasured', () => {
    const s = computeDeployStatus(mkSnap({ failingTests: [], failingTestsMeasured: false }, {}, []));
    expect(s.gate.failingTests).toEqual([]);
    expect(s.gate.failingTestsMeasured).toBe(false);
  });

  it('P-009 suppresses a stale historical failing-test list at the shared status writer', () => {
    const s = computeDeployStatus(
      mkSnap({
        consecutiveReds: 3,
        verdictStale: true,
        verdictStaleReason: 'the judged candidate was superseded',
        failingTests: ['historical-red.test.ts'],
      }, {}),
    );
    expect(s.state).toBe('gate-verdict-stale');
    expect(s.gate.failingTests).toEqual([]);
    expect(s.gate.failingTestsMeasured).toBe(false);
  });

  it('P-009 distinguishes an externally-held run, preserves phase, and reports verdict pending', () => {
    const snap = mkSnap(
      { consecutiveReds: 2, failingTests: ['historical-red.test.ts'] },
      { deployedBehindGreenPin: 0 },
    );
    snap.activeRun = {
      active: true,
      heldExternally: true,
      probeFailed: true,
      probeDetail: 'systemctl failed; the independent run lock is held',
      candidate: 'abcdef12',
      startedAtMs: 1,
      progressAtMs: 2,
      currentPhase: 'setup',
      elapsedSec: 3,
    };

    const s = computeDeployStatus(snap);
    expect(s.state).toBe('gate-red');
    expect(s.checkpoint).toEqual({
      state: 'running',
      authority: 'shared-run-lock',
      phase: 'setup',
      blocker: null,
      verdictPending: true,
      probe: { status: 'failed', detail: 'systemctl failed; the independent run lock is held' },
    });
    expect(s.gate.failingTests).toEqual([]);
    expect(s.recommendation).toMatch(/ACTIVE.*abcdef12.*phase: setup/s);
    expect(s.recommendation).toMatch(/Do NOT run `release:checkpoint-run` again/);
  });

  it('P-009 reports pre-lock materialization as running under process authority, never idle', () => {
    const snap = mkSnap(
      { consecutiveReds: 2, failingTests: ['historical-red.test.ts'] },
      { deployedBehindGreenPin: 0 },
    );
    snap.activeRun = {
      active: true,
      preLockAuthority: {
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        cgroupPath: '/user.slice/run-u42.scope',
        pid: 4242,
      },
      candidate: null,
      startedAtMs: 1,
      progressAtMs: 1,
      currentPhase: 'materializing',
      elapsedSec: 3,
    };

    const s = computeDeployStatus(snap);
    expect(s.checkpoint).toEqual({
      state: 'running',
      authority: 'process-authority',
      phase: 'materializing',
      blocker: null,
      verdictPending: true,
      probe: { status: 'ok', detail: null },
    });
    expect(s.gate.failingTests).toEqual([]);
    expect(s.recommendation).toMatch(/ACTIVE/);
    expect(s.recommendation).toMatch(/Do NOT run `release:checkpoint-run` again/);
  });

  it('P-009 distinguishes a measured idle probe from a deliberate routine pause', () => {
    const idle = mkSnap({}, {});
    idle.routines.greenCheckpoint = {
      name: 'green-checkpoint',
      active: true,
      cron: '0 15 * * * *',
      lastFiredAtMs: 1,
      nextFireAtMs: 2,
      groupSlug: 'release',
      pause: null,
    };
    idle.activeRun = {
      active: false,
      candidate: null,
      startedAtMs: null,
      progressAtMs: null,
      elapsedSec: null,
    };
    expect(computeDeployStatus(idle).checkpoint).toMatchObject({
      state: 'idle',
      authority: 'live-probe',
      blocker: null,
      verdictPending: false,
    });

    const paused = mkSnap({}, {});
    paused.routines.greenCheckpoint = {
      ...idle.routines.greenCheckpoint,
      active: false,
      pause: {
        reason: 'D-012/D-013 live quiescence hold under WI-40086: waiting for immutable deps',
        pausedBy: 'su-owner',
        pausedAtMs: 1,
        // P-004: the structured serializer quiescence hold is deliberately NOT TTL'd —
        // it is re-armed on owner non-liveness, not on a clock (release-pause-ttl.ts).
        expiresAtMs: null,
      },
    };
    paused.activeRun = idle.activeRun;
    const status = computeDeployStatus(paused);
    expect(status.checkpoint).toMatchObject({
      state: 'paused',
      authority: 'routine-control',
      blocker: 'D-012/D-013 live quiescence hold under WI-40086: waiting for immutable deps',
      verdictPending: false,
    });
    expect(status.state).toBe('gate-paused');
    expect(status.recommendation).toMatch(/DELIBERATELY PAUSED.*waiting for immutable deps/s);
    expect(status.recommendation).toMatch(/Do not launch a manual checkpoint.*scheduled routine/s);
    expect(status.recommendation).not.toMatch(/Run release:checkpoint-run/);
  });

  it('P-009 treats an uncorroborated failed liveness probe as unknown, never idle', () => {
    const snap = mkSnap({}, {});
    snap.activeRun = {
      active: true,
      probeFailed: true,
      probeDetail: 'systemctl show timed out and no run lock was observed',
      candidate: null,
      startedAtMs: null,
      progressAtMs: null,
      elapsedSec: null,
    };
    const s = computeDeployStatus(snap);
    expect(s.state).toBe('gate-wedged');
    expect(s.checkpoint).toMatchObject({
      state: 'unknown',
      authority: 'unmeasured',
      blocker: 'systemctl show timed out and no run lock was observed',
      verdictPending: false,
    });
    expect(s.recommendation).toMatch(/unknown execution state, not an idle reading/i);
  });
});

/**
 * EI-18724155280048738 — the missing "is a deploy running right now?" state.
 *
 * The incident: `op:trigger` returned a transport error (CONNECTION_CLOSED against PgBouncer
 * :6432) while the handler had in fact run to completion and launched the deploy — audit_log
 * records launched:true for that very trigger. The sanctioned recovery ("don't retry blind,
 * check with `ps`") then FALSE-NEGATIVES, because `systemd-run` returns as soon as the unit is
 * started while the deploy-cli process tree takes ~20s more to appear. `op:status` reported
 * `green-deployable` throughout — indistinguishable from "the trigger did nothing" — so the
 * operator triggered a second time against the shared release checkout.
 *
 * These lock the discriminator that cannot false-negative: the transient systemd unit, which
 * exists from the instant systemd-run exits 0.
 */
function fakeShowSpawn(stdout: string, closeCode = 0) {
  const calls: { cmd: string; argv: string[] }[] = [];
  const fn = ((cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', closeCode);
    });
    return child as unknown;
  }) as unknown as typeof import('node:child_process').spawn & { calls: typeof calls };
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

/** The real shape of `systemctl --user show papercup-auto-deploy` while a deploy runs. */
const RUNNING_SHOW = [
  'ActiveState=active',
  'SubState=running',
  'ExecMainStartTimestamp=Sun 2026-07-26 12:09:43 EDT',
  '',
].join('\n');

describe('parseSystemctlShow', () => {
  it('parses Key=Value lines and ignores blanks', () => {
    expect(parseSystemctlShow(RUNNING_SHOW)).toEqual({
      ActiveState: 'active',
      SubState: 'running',
      ExecMainStartTimestamp: 'Sun 2026-07-26 12:09:43 EDT',
    });
  });

  it('keeps `=` inside a value (a timestamp/path is not split twice)', () => {
    expect(parseSystemctlShow('X=a=b')).toEqual({ X: 'a=b' });
  });
});

describe('computeDeployInFlight', () => {
  it('active + running ⇒ in flight, with the log path to watch', () => {
    const f = computeDeployInFlight({
      props: parseSystemctlShow(RUNNING_SHOW),
      logPath: '/tmp/l.log',
      logMtimeMs: 42,
    });
    expect(f.active).toBe(true);
    expect(f.activeState).toBe('active');
    expect(f.subState).toBe('running');
    expect(f.unit).toBe(DEPLOY_UNIT);
    expect(f.logPath).toBe('/tmp/l.log');
    expect(f.logMtimeMs).toBe(42);
    expect(f.source).toBe('systemd');
  });

  it('activating counts as in flight — THE window `ps` misses (unit started, child not yet spawned)', () => {
    const f = computeDeployInFlight({
      props: { ActiveState: 'activating', SubState: 'start' },
      logPath: '/tmp/l.log',
      logMtimeMs: null,
    });
    expect(f.active).toBe(true);
  });

  it('deactivating still counts — the deploy restarts :3070 late, so it is not settled yet', () => {
    const f = computeDeployInFlight({ props: { ActiveState: 'deactivating' }, logPath: '/l', logMtimeMs: null });
    expect(f.active).toBe(true);
  });

  it('inactive (the --collect unit was garbage-collected) ⇒ not in flight', () => {
    const f = computeDeployInFlight({ props: { ActiveState: 'inactive', SubState: 'dead' }, logPath: '/l', logMtimeMs: 1 });
    expect(f.active).toBe(false);
  });

  /**
   * VERBATIM output captured from the real box on 2026-07-26 while working this item — the
   * `--collect` transient unit is garbage-collected once the deploy exits, which BLANKS
   * ExecMainStartTimestamp rather than removing the key. `Date.parse('')` is NaN, so this is
   * the shape that would emit a bogus startedAtMs if the parse were trusted unguarded.
   */
  it('the REAL post-run output (unit collected, timestamp blank) ⇒ not in flight, startedAtMs null', () => {
    const f = computeDeployInFlight({
      props: parseSystemctlShow('ExecMainStartTimestamp=\nActiveState=inactive\nSubState=dead\n'),
      logPath: '/l',
      logMtimeMs: 1,
    });
    expect(f.active).toBe(false);
    expect(f.activeState).toBe('inactive');
    expect(f.subState).toBe('dead');
    expect(f.startedAtMs).toBeNull();
  });

  it('failed ⇒ not in flight (the deploy is over; its outcome is reported elsewhere)', () => {
    const f = computeDeployInFlight({ props: { ActiveState: 'failed' }, logPath: '/l', logMtimeMs: 1 });
    expect(f.active).toBe(false);
  });

  it('parses systemd ExecMainStartTimestamp to a real instant', () => {
    const f = computeDeployInFlight({ props: parseSystemctlShow(RUNNING_SHOW), logPath: '/l', logMtimeMs: null });
    expect(f.startedAtMs).toBe(Date.parse('2026-07-26T16:09:43Z'));
  });

  it('an UNPARSEABLE timestamp degrades startedAtMs to null WITHOUT disturbing `active`', () => {
    // A host in a zone V8 cannot parse must not yield a wrong instant — and must never cost us
    // the in-flight verdict, which is the field the double-trigger actually hinges on.
    const f = computeDeployInFlight({
      props: { ActiveState: 'active', ExecMainStartTimestamp: 'Sun 2026-07-26 12:09:43 XYZ' },
      logPath: '/l',
      logMtimeMs: null,
    });
    expect(f.startedAtMs).toBeNull();
    expect(f.active).toBe(true);
  });

  it('systemd unreadable ⇒ source flags UNKNOWN rather than silently asserting "idle"', () => {
    const f = computeDeployInFlight({
      props: null,
      logPath: '/l',
      logMtimeMs: 7,
      terminal: { exitCode: 17, finishedAt: '2026-08-15T09:00:00Z', markerPath: '/tmp/terminal' },
    });
    expect(f.source).toBe('systemd-unavailable');
    expect(f.active).toBe(false);
    expect(f.activeState).toBeNull();
    expect(f.logMtimeMs).toBe(7);
    expect(f.terminal?.exitCode).toBe(17);
  });
});

describe('readDeployInFlight', () => {
  it('queries the transient unit by name for the three properties it needs', async () => {
    const fn = fakeShowSpawn(RUNNING_SHOW);
    const f = await readDeployInFlight({ spawnFn: fn, logMtimeMs: () => null });
    const call = (fn as unknown as { calls: { cmd: string; argv: string[] }[] }).calls[0];
    expect(call.cmd).toBe('systemctl');
    expect(call.argv).toEqual([
      '--user',
      'show',
      DEPLOY_UNIT,
      '--property=ActiveState',
      '--property=SubState',
      '--property=ExecMainStartTimestamp',
    ]);
    expect(f.active).toBe(true);
  });

  it('a non-zero systemctl exit degrades to UNKNOWN, never throws', async () => {
    const f = await readDeployInFlight({
      spawnFn: fakeShowSpawn('', 1),
      logMtimeMs: () => null,
      terminalMarker: () => ({
        exitCode: 9,
        finishedAt: '2026-08-15T09:00:00Z',
        markerPath: '/tmp/terminal',
      }),
    });
    expect(f.source).toBe('systemd-unavailable');
    expect(f.active).toBe(false);
    expect(f.terminal?.exitCode).toBe(9);
  });

  it('a spawn error (no systemd on the box) degrades to UNKNOWN, never throws', async () => {
    const fn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child as unknown;
    }) as unknown as typeof import('node:child_process').spawn;
    const f = await readDeployInFlight({ spawnFn: fn, logMtimeMs: () => null });
    expect(f.source).toBe('systemd-unavailable');
  });
});

describe('EI-18724155280048738: an in-flight deploy must be distinguishable from a no-op trigger', () => {
  const inFlight = (over: Partial<DeployInFlight> = {}): DeployInFlight => ({
    active: true,
    unit: DEPLOY_UNIT,
    activeState: 'active',
    subState: 'running',
    startedAtMs: Date.parse('2026-07-26T16:09:43Z'),
    logPath: `/tmp/${DEPLOY_UNIT}.log`,
    logMtimeMs: null,
    source: 'systemd',
    ...over,
  });

  it('THE REGRESSION: green code ahead + a deploy RUNNING no longer reports plain green-deployable', () => {
    const snap = mkSnap({ consecutiveReds: 0, fireStale: false }, { deployedBehindGreenPin: 2 });
    // Before the fix this was 'green-deployable' with canTriggerGreen:true — the exact reading
    // that invited a second trigger 20s into a live deploy.
    expect(computeDeployStatus(snap).state).toBe('green-deployable');
    const s = computeDeployStatus(snap, inFlight());
    expect(s.state).toBe('deploy-in-flight');
    expect(s.canTriggerGreen).toBe(false);
  });

  it('the recommendation names the unit, the log to watch, and forbids a second trigger', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 2 }), inFlight());
    expect(s.recommendation).toContain(DEPLOY_UNIT);
    expect(s.recommendation).toContain(`/tmp/${DEPLOY_UNIT}.log`);
    expect(s.recommendation).toMatch(/do NOT trigger another/i);
    // and it must warn off the discriminator that caused the incident
    expect(s.recommendation).toMatch(/\bps\b/);
  });

  /**
   * EI-19448585641887174 — this recommendation used to end with a flat "or await the
   * release:deployed / deploy-failed events", and an agent followed it mid-deploy and
   * burned a 900s timeout. `release:deployed` is emitted at the END of a deploy (after
   * the restart AND its health probe), so for a deploy already past its restart it has
   * ALREADY fired and an await armed now waits for the NEXT one.
   *
   * We cannot cheaply tell from here WHICH side of the restart this deploy is on, so the
   * requirement is not "recommend the right thing" — it is "do not assert the wrong half".
   * State the timing and name the check that decides it.
   */
  it('does not flatly recommend awaiting release:deployed — it states WHEN that event fires and names the check', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 2 }), inFlight());

    // The bare imperative is gone…
    expect(s.recommendation).not.toMatch(/or await the release:deployed/i);
    // …replaced by the timing fact that makes the advice decidable…
    expect(s.recommendation).toMatch(/only at the END of the deploy/i);
    expect(s.recommendation).toMatch(/ALREADY fired/i);
    // …and the discriminator a caller can actually act on.
    expect(s.recommendation).toMatch(/serving\.startedSinceCodeChange/);
  });

  it('deploy-in-flight OUTRANKS every parked state — each of them reads as "nothing is happening"', () => {
    const cases: [string, GitPipelineSnapshot][] = [
      ['green ahead', mkSnap({}, { deployedBehindGreenPin: 2 })],
      ['gate red', mkSnap({ consecutiveReds: 3 }, { deployedBehindGreenPin: 0 })],
      ['staging buffered', mkSnap({}, { deployedBehindGreenPin: 0, greenPinBehindStaging: 4 })],
      ['up to date', mkSnap({}, { deployedBehindGreenPin: 0 })],
    ];
    for (const [label, snap] of cases) {
      expect(computeDeployStatus(snap, inFlight()).state, label).toBe('deploy-in-flight');
    }
  });

  it('an in-flight deploy makes canTriggerGreen false even with green code ahead', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 5 }), inFlight());
    expect(s.canTriggerGreen).toBe(false);
  });

  it('a FINISHED unit restores the normal decision tree (no sticky in-flight)', () => {
    const s = computeDeployStatus(
      mkSnap({}, { deployedBehindGreenPin: 2 }),
      inFlight({ active: false, activeState: 'inactive' }),
    );
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
  });

  it('deployInFlight rides on the status object for the tool to surface', () => {
    expect(computeDeployStatus(mkSnap({}, {}), inFlight()).deployInFlight?.active).toBe(true);
  });

  it('the durable terminal record rides top-level on status after unit collection', () => {
    const terminal = {
      exitCode: 23,
      finishedAt: '2026-08-15T09:00:00Z',
      markerPath: '/tmp/terminal',
    };
    expect(computeDeployStatus(mkSnap({}, {}), inFlight({ active: false, terminal })).deployTerminal).toEqual(terminal);
  });

  it('BACK-COMPAT: the pure one-arg call (staleness watchdog) is unchanged and reports null', () => {
    const s = computeDeployStatus(mkSnap({}, { deployedBehindGreenPin: 2 }));
    expect(s.deployInFlight).toBeNull();
    expect(s.checkpointRunInFlight).toBeNull();
    expect(s.state).toBe('green-deployable');
    expect(s.canTriggerGreen).toBe(true);
  });
});

describe('readDeployStatus wiring', () => {
  it('identifies a hanging authority read without mistaking completed status reads for pending', async () => {
    const progress: string[][] = [];
    const inFlight = computeDeployInFlight({ props: null, logPath: '/l', logMtimeMs: null });
    void readDeployStatus({
      loadSnapshot: async () => mkSnap({}, {}),
      loadInFlight: async () => inFlight,
      loadManualRunAuthority: () => new Promise<null>(() => {}),
      onReadProgress: (pending) => progress.push(pending),
    });
    await vi.waitFor(() => expect(progress.at(-1)).toEqual(['manualRunAuthority']));
  });

  it('reads P-010 certification for the exact green pin and threads it into status', async () => {
    const greenPin = {
      sha: '0123456789abcdef0123456789abcdef01234567',
      shortSha: '01234567',
      committedAtMs: 0,
      subject: 'green',
    };
    const loadLiveCertification = vi.fn(async (targetSha: string) => ({
      ...liveCertification('certified'),
      targetSha,
    }));
    const s = await readDeployStatus({
      loadSnapshot: async () => mkSnap({}, { greenPin, deployedBehindGreenPin: 2 }),
      loadInFlight: async () => computeDeployInFlight({ props: null, logPath: '/l', logMtimeMs: null }),
      loadLiveCertification,
    });

    expect(loadLiveCertification).toHaveBeenCalledWith(greenPin.sha);
    expect(s.liveCertification).toMatchObject({ status: 'certified', targetSha: greenPin.sha });
    expect(s.state).toBe('green-deployable');
  });

  it('threads the reader-aware manual-run authority into status', async () => {
    const authority = {
      withheld: true as const,
      governingRef: 'WI-40086',
      source: 'serializer-fence' as const,
      reason: 'sole serializer owns candidate selection',
    };
    const loadManualRunAuthority = vi.fn(async () => authority);
    const s = await readDeployStatus({
      readerOwnerId: 'su-reader',
      loadSnapshot: async () => mkSnap({}, {}),
      loadInFlight: async () => computeDeployInFlight({ props: null, logPath: '/l', logMtimeMs: null }),
      loadManualRunAuthority,
    });

    expect(loadManualRunAuthority).toHaveBeenCalledTimes(1);
    expect(s.manualRunAuthority).toEqual(authority);
  });

  it('keeps the live diagnostic git reads off the spawner sidecar', async () => {
    gitPipelineSnapshotM.mockReset();
    gitPipelineSnapshotM.mockResolvedValue(mkSnap({}, { deployedBehindGreenPin: 2 }));
    const inFlight = computeDeployInFlight({ props: null, logPath: '/l', logMtimeMs: null });

    const s = await readDeployStatus({ loadInFlight: async () => inFlight });

    expect(s.state).toBe('green-deployable');
    expect(gitPipelineSnapshotM).toHaveBeenCalledWith(undefined, {
      includeActiveRun: true,
      useSpawnerSidecar: false,
    });
  });

  it('populates deployInFlight from the probe and lets it drive the state', async () => {
    const s = await readDeployStatus({
      loadSnapshot: async () => mkSnap({}, { deployedBehindGreenPin: 2 }),
      loadInFlight: async () =>
        computeDeployInFlight({ props: parseSystemctlShow(RUNNING_SHOW), logPath: '/l', logMtimeMs: null }),
    });
    expect(s.deployInFlight?.active).toBe(true);
    expect(s.state).toBe('deploy-in-flight');
  });

  it('carries the active checkpoint probe through the status object', async () => {
    const activeRun = {
      active: true,
      candidate: 'fb941a2c',
      refireObserved: true,
      initialCandidate: '80cde64e',
      startedAtMs: Date.now() - 15 * 60_000,
      elapsedSec: 900,
    };
    const s = await readDeployStatus({
      loadSnapshot: async () => ({ ...mkSnap({}, {}), activeRun }),
      loadInFlight: async () =>
        computeDeployInFlight({
          props: parseSystemctlShow('ExecMainStartTimestamp=\nActiveState=inactive\nSubState=dead\n'),
          logPath: '/l',
          logMtimeMs: null,
        }),
    });
    expect(s.checkpointRunInFlight).toEqual(activeRun);
  });

  it('a THROWING probe never fails the status read — it degrades to null', async () => {
    const s = await readDeployStatus({
      loadSnapshot: async () => mkSnap({}, { deployedBehindGreenPin: 2 }),
      loadInFlight: async () => {
        throw new Error('systemd exploded');
      },
    });
    expect(s.deployInFlight).toBeNull();
    expect(s.state).toBe('green-deployable');
  });
});

/**
 * WI-2141736 P-004: the freeze-and-converge disposition must be READABLE in the prose an
 * agent actually sees, not only in the structured payload. `repairQueue: null` is three
 * different facts wearing one value — the owner switched the freeze off, the gate just
 * retired a candidate, or nothing was ever frozen — and collapsing them is what let
 * freeze-and-converge sit disabled fleet-wide for a day with nobody noticing.
 */
describe('computeDeployStatus — freeze-and-converge disposition in the summary', () => {
  const T0 = 1_800_000_000_000;
  type FreezeRecord = NonNullable<GitPipelineSnapshot['gate']['freezeAndConverge']>;
  const freeze = (over: Partial<FreezeRecord>): FreezeRecord =>
    ({
      enabled: true,
      state: 'held',
      reason: 'provider capacity wall outlasts the stall window',
      candidate: 'c'.repeat(40),
      holdUntilMs: T0 + 3_600_000,
      capacityRetryAtMs: T0 + 7_200_000,
      observedAtMs: T0,
      ...over,
    }) as FreezeRecord;

  it('states that the freeze is ON, its state, and its reason', () => {
    const s = computeDeployStatus(
      mkSnap({ freezeAndConverge: freeze({}) }, {}),
      null,
      null,
      null,
      T0 + 60_000,
    );
    expect(s.summary).toContain('freeze-and-converge is ON, held');
    expect(s.summary).toContain('provider capacity wall outlasts the stall window');
    // The state/recommendation half is untouched — the disposition is APPENDED, never
    // substituted for the deploy verdict a caller is already reading.
    expect(s.summary.startsWith(`[${s.state}]`)).toBe(true);
  });

  it('states that the freeze is OFF and WHY — the read that used to be archaeology', () => {
    const s = computeDeployStatus(
      mkSnap(
        {
          freezeAndConverge: freeze({
            enabled: false,
            state: 'off',
            reason: 'RELEASE_FREEZE_AND_CONVERGE flag is disabled',
          }),
        },
        {},
      ),
      null,
      null,
      null,
      T0 + 60_000,
    );
    expect(s.summary).toContain('freeze-and-converge is OFF');
    expect(s.summary).toContain('RELEASE_FREEZE_AND_CONVERGE flag is disabled');
  });

  it('FALSIFIER: an absent record appends NOTHING rather than a healthy-sounding default', () => {
    const withRecord = computeDeployStatus(
      mkSnap({ freezeAndConverge: freeze({}) }, {}),
      null,
      null,
      null,
      T0,
    );
    const without = computeDeployStatus(mkSnap({}, {}), null, null, null, T0);
    // Positive control: the same call DOES append when a record exists, so an empty
    // summary here is a real absence and not a summarizer that never fires.
    expect(withRecord.summary).toContain('freeze-and-converge is');
    expect(without.summary).not.toContain('freeze-and-converge');
    expect(without.summary).toBe(`[${without.state}] ${without.recommendation}`);
  });

  it('marks a record the gate has stopped refreshing as history, not current state', () => {
    const s = computeDeployStatus(
      mkSnap({ freezeAndConverge: freeze({}) }, {}),
      null,
      null,
      null,
      T0 + 5 * 60 * 60 * 1_000,
    );
    expect(s.summary).toContain('last observed');
    expect(s.summary).toContain('history, not current state');
  });
});
