/**
 * EI-19385475092979200 — teeth tests for the dev:restart gate-collision guard.
 *
 * These are structured so the guard is proven to FIRE on the real shape and to stay SILENT
 * for each single condition removed. A test that only asserted "clear tree ⇒ no collision"
 * would pass identically with the condition INVERTED, which is the false-green class that
 * already bit two guards in this repo (the plugin-spawn-impl ambient-environment assertion,
 * and the typeless-reexport live-leg). Every block below therefore pairs a POSITIVE with the
 * minimal negative that distinguishes it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  judgeGateCollision,
  probeGateCollision,
  checkGateCollision,
  isGateSensitiveTarget,
  GATE_SENSITIVE_RESTART_TARGETS,
  IMMINENT_FIRE_LOOKAHEAD_SEC,
  IMMINENT_FIRE_LOOKBEHIND_SEC,
  gateRunCgroupRelation,
  GIT_SYNC_SENSITIVE_RESTART_TARGETS,
  isGitSyncSensitiveTarget,
  judgeGitSyncCollision,
  probeGitSyncCollision,
  checkGitSyncCollision,
  checkStagingSyncCollision,
  STAGING_SYNC_LOCK_PATH,
  acquireGitSyncRestartBarrier,
  GIT_SYNC_RESTART_BARRIER_RESOURCE,
  GIT_SYNC_RESTART_BARRIER_TTL_SEC,
  type GateCollisionProbe,
  type GateCollisionProbeDeps,
  type GitSyncCollisionProbe,
  type GitSyncCollisionProbeDeps,
  type GitSyncRestartBarrierDeps,
  probeInFlightLocalSync,
  waitForInFlightLocalSync,
  type InFlightLocalSyncProbeDeps,
} from './gate-collision-guard';
import type { StoredInFlightRetriage } from './in-flight-retriage';

const CLEAR: GateCollisionProbe = {
  probeFailed: false,
  runLockHeld: false,
  runElapsedSec: null,
  nextFireInSec: null,
  refire: null,
};

const judge = (probe: Partial<GateCollisionProbe>, target = 'embed-sidecar', override = false) =>
  judgeGateCollision({ target, probe: { ...CLEAR, ...probe }, override });

describe('gate-sensitive target set', () => {
  it('covers exactly the three shared hosts a gate run depends on', () => {
    expect([...GATE_SENSITIVE_RESTART_TARGETS]).toEqual(['embed-sidecar', 'gateway', 'bg-host']);
  });

  it('does NOT guard the operator web hosts — they are not gate dependencies', () => {
    expect(isGateSensitiveTarget('dev')).toBe(false);
    expect(isGateSensitiveTarget('staging')).toBe(false);
  });
});

describe('run-in-flight (the primary condition)', () => {
  it('BLOCKS a gate-sensitive restart while the run-lock is held', () => {
    const v = judge({ runLockHeld: true, runElapsedSec: 1980 });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.note).toContain('IN FLIGHT');
    // The run's AGE must reach the caller — it is what decides "wait it out" vs "override".
    expect(v.note).toContain('33min');
    expect(v.detail.runElapsedSec).toBe(1980);
  });

  it('single condition removed — lock NOT held, nothing else true ⇒ CLEAR', () => {
    expect(judge({ runLockHeld: false }).blocked).toBe(false);
    expect(judge({ runLockHeld: false }).kind).toBe('clear');
  });

  it('single condition removed — same held lock on a NON-gate-sensitive target ⇒ CLEAR', () => {
    for (const t of ['dev', 'staging']) {
      const v = judge({ runLockHeld: true, runElapsedSec: 1980 }, t);
      expect(v.blocked).toBe(false);
      expect(v.kind).toBe('not-gate-sensitive');
    }
  });

  it('enriches the note from the refire marker when one is in flight', () => {
    const refire: StoredInFlightRetriage = {
      fromCandidate: '1ee32228',
      refiringCandidate: '4a9b218b',
      refireAttempt: 1,
      maxRefires: 2,
      failingFiles: ['lib/x.test.ts'],
      observedAtMs: Date.now(),
    };
    const v = judge({ runLockHeld: true, runElapsedSec: 60, refire });
    expect(v.note).toContain('MID AUTO-REFIRE');
    expect(v.note).toContain('4a9b218b');
    expect(v.detail.refiringCandidate).toBe('4a9b218b');
  });
});

describe('mechanism-aware run-in-flight guard', () => {
  const userSlice = '/user.slice/user-1000.slice/user@1000.service/app.slice';
  const targetCgroup = `${userSlice}/papercup-bg-host.service`;

  it('treats a target cgroup and its child cgroup as shared', () => {
    expect(gateRunCgroupRelation(`${targetCgroup}/checkpoint.scope`, targetCgroup)).toBe('same');
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: `${targetCgroup}/checkpoint.scope`,
      targetCgroupPath: targetCgroup,
    });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.detail.cgroupRelation).toBe('same');
    expect(v.note).not.toContain('EI-18793581783459047');
  });

  it('proceeds when a detached checkpoint unit is a known sibling cgroup', () => {
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: `${userSlice}/papercup-green-checkpoint-manual.scope`,
      targetCgroupPath: targetCgroup,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('run-in-flight-isolated');
    expect(v.detail.cgroupRelation).toBe('different');
    expect(v.note).toContain('residual risk');
  });

  it('fails open, explicitly, when either cgroup path is unknown', () => {
    const v = judge({
      runLockHeld: true,
      runElapsedSec: 60,
      runLockCgroupPath: null,
      targetCgroupPath: null,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('run-in-flight-unknown');
    expect(v.detail.cgroupRelation).toBe('unknown');
    expect(v.note).toContain('could not be determined');
  });

  it('passes the actual restart target to the cgroup reader', async () => {
    const readTargetCgroup = vi.fn(async (target: (typeof GATE_SENSITIVE_RESTART_TARGETS)[number]) => {
      expect(target).toBe('gateway');
      return '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-gateway.service';
    });
    const probe = await probeGateCollision(
      {
        readRunLock: () => ({ held: true, elapsedSec: 10, pid: 42 }),
        readRunLockCgroup: () => '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-gateway.service',
        readTargetCgroup,
        readNextFireInSec: async () => 3_000,
        readRefire: async () => null,
      },
      'gateway',
    );
    expect(readTargetCgroup).toHaveBeenCalledWith('gateway');
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).blocked).toBe(true);
  });
});

describe('imminent fire — the two-sided window', () => {
  it('BLOCKS just AHEAD of a scheduled fire', () => {
    const v = judge({ nextFireInSec: 40 });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('imminent-fire');
    expect(v.note).toContain('fires in 40s');
  });

  /**
   * THE REGRESSION GUARD. The reported near-miss happened at :15:36 — 36 seconds AFTER the
   * scheduled :15:00 fire, with the run process alive but the lock not yet observed. A
   * forward-only window would sail straight past the very incident this guard exists for.
   */
  it('BLOCKS just BEHIND a scheduled fire (the 2026-08-02 near-miss at :15:36)', () => {
    const v = judge({ nextFireInSec: -36, runLockHeld: false });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('imminent-fire');
    expect(v.note).toContain('fired 36s ago');
  });

  it('is CLEAR when the next fire is far ahead (the live steady-state: ~640s)', () => {
    const v = judge({ nextFireInSec: 640 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('clear');
    expect(v.note).toContain('next scheduled fire');
  });

  it('is CLEAR when next_fire_at is long past — a paused/stale routine must not wedge restarts', () => {
    expect(judge({ nextFireInSec: -3600 }).blocked).toBe(false);
    expect(judge({ nextFireInSec: -3600 }).kind).toBe('clear');
  });

  it('honours both window boundaries exactly', () => {
    expect(judge({ nextFireInSec: IMMINENT_FIRE_LOOKAHEAD_SEC }).blocked).toBe(true);
    expect(judge({ nextFireInSec: IMMINENT_FIRE_LOOKAHEAD_SEC + 1 }).blocked).toBe(false);
    expect(judge({ nextFireInSec: -IMMINENT_FIRE_LOOKBEHIND_SEC }).blocked).toBe(true);
    expect(judge({ nextFireInSec: -IMMINENT_FIRE_LOOKBEHIND_SEC - 1 }).blocked).toBe(false);
  });

  it('a null schedule alone never blocks — absence of data is not evidence of a fire', () => {
    expect(judge({ nextFireInSec: null }).blocked).toBe(false);
  });
});

describe('fail-open contract', () => {
  it('a failed probe PROCEEDS, and says so rather than reporting a verified all-clear', () => {
    const v = judge({ probeFailed: true });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('probe-failed');
    expect(v.note).toContain('Could NOT determine');
  });

  it('a failed probe outranks a would-be block — it never silently blocks on unknown state', () => {
    const v = judge({ probeFailed: true, runLockHeld: true, nextFireInSec: 10 });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('probe-failed');
  });
});

describe('override (soft block, not hard block)', () => {
  it('lets a real collision through, flags it, and preserves the attribution warning', () => {
    const v = judge({ runLockHeld: true, runElapsedSec: 120 }, 'embed-sidecar', true);
    expect(v.blocked).toBe(false);
    expect(v.overridden).toBe(true);
    expect(v.kind).toBe('run-in-flight');
    expect(v.note).toContain('PROCEEDING ANYWAY');
    expect(v.note).toContain('attribute it to THIS restart');
  });

  it('does not invent an override on a clear probe', () => {
    expect(judge({}, 'embed-sidecar', true).overridden).toBe(false);
  });

  it('the block message names the exact override arg, so the caller is never stuck', () => {
    expect(judge({ runLockHeld: true }).note).toContain('override_gate_collision: true');
  });
});

describe('probe shell — one broken reader degrades one field, not the verdict', () => {
  const deps = (over: Partial<GateCollisionProbeDeps>): GateCollisionProbeDeps => ({
    readRunLock: () => ({ held: false, elapsedSec: null }),
    readNextFireInSec: async () => null,
    readRefire: async () => null,
    ...over,
  });

  it('a throwing routines read still BLOCKS on a readable held run-lock', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => ({ held: true, elapsedSec: 300 }),
        readNextFireInSec: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(probe.runLockHeld).toBe(true);
    expect(probe.probeFailed).toBe(true);
    // probeFailed fails OPEN by contract — the point here is that the lock was still READ.
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).kind).toBe('probe-failed');
  });

  it('a throwing refire read is NOT a probe failure — the marker only enriches the message', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => ({ held: true, elapsedSec: 42 }),
        readRefire: async () => {
          throw new Error('no marker');
        },
      }),
    );
    expect(probe.probeFailed).toBe(false);
    expect(probe.refire).toBeNull();
    expect(judgeGateCollision({ target: 'gateway', probe, override: false }).blocked).toBe(true);
  });

  it('a throwing run-lock read marks the probe failed', async () => {
    const probe = await probeGateCollision(
      deps({
        readRunLock: () => {
          throw new Error('unreadable lock dir');
        },
      }),
    );
    expect(probe.probeFailed).toBe(true);
  });
});

describe('checkGateCollision', () => {
  it('short-circuits a non-gate-sensitive target WITHOUT probing at all', async () => {
    const readRunLock = vi.fn(() => ({ held: true, elapsedSec: 1 }));
    const v = await checkGateCollision('dev', false, {
      readRunLock,
      readNextFireInSec: async () => 0,
      readRefire: async () => null,
    });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('not-gate-sensitive');
    expect(readRunLock).not.toHaveBeenCalled();
  });

  it('probes and blocks for each gate-sensitive target', async () => {
    for (const t of GATE_SENSITIVE_RESTART_TARGETS) {
      const v = await checkGateCollision(t, false, {
        readRunLock: () => ({ held: true, elapsedSec: 10 }),
        readNextFireInSec: async () => 3000,
        readRefire: async () => null,
      });
      expect(v.blocked, `${t} must be guarded`).toBe(true);
    }
  });
});

const GIT_SYNC_CLEAR: GitSyncCollisionProbe = {
  probeFailed: false,
  targetCgroupPath: '/user.slice/app.slice/papercup-bg-host.service',
  operations: [],
};

const gitSyncOperation = (over: Partial<GitSyncCollisionProbe['operations'][number]> = {}) => ({
  resource: 'git-sync:papercusp',
  owner: 'system:git-sync:4242:run-1',
  acquiredAtMs: 1_000,
  expiresAtMs: 601_000,
  pid: 4242,
  alive: true,
  processCgroupPath: '/user.slice/app.slice/papercup-bg-host.service',
  cgroupRelation: 'same' as const,
  ageSec: 120,
  ...over,
});

describe('git-sync restart-collision target set', () => {
  it('covers every host that can execute git-sync and excludes unrelated services', () => {
    expect([...GIT_SYNC_SENSITIVE_RESTART_TARGETS]).toEqual(['dev', 'bg-host']);
    expect(isGitSyncSensitiveTarget('dev')).toBe(true);
    expect(isGitSyncSensitiveTarget('staging')).toBe(false);
    expect(isGitSyncSensitiveTarget('bg-host')).toBe(true);
    for (const target of ['gateway', 'embed-sidecar', 'mcp-proxy', 'desktop-dev']) {
      expect(isGitSyncSensitiveTarget(target)).toBe(false);
    }
  });
});

describe('git-sync operation-in-flight verdict', () => {
  it('BLOCKS when a live holder PID shares the restart target cgroup', () => {
    const verdict = judgeGitSyncCollision({
      target: 'bg-host',
      probe: { ...GIT_SYNC_CLEAR, operations: [gitSyncOperation()] },
      override: false,
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.kind).toBe('operation-in-flight');
    expect(verdict.detail.collidingResources).toEqual(['git-sync:papercusp']);
    expect(verdict.detail.collidingPids).toEqual([4242]);
    expect(verdict.note).toContain('SIGKILL');
    expect(verdict.note).toContain('override_git_sync_collision:true');
  });

  it('single condition removed — a provably dead holder never blocks', () => {
    const verdict = judgeGitSyncCollision({
      target: 'bg-host',
      probe: { ...GIT_SYNC_CLEAR, operations: [gitSyncOperation({ alive: false, cgroupRelation: 'unknown' })] },
      override: false,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.kind).toBe('clear');
    expect(verdict.detail.deadResources).toEqual(['git-sync:papercusp']);
  });

  it('single condition removed — a live holder in a sibling cgroup is isolated', () => {
    const verdict = judgeGitSyncCollision({
      target: 'bg-host',
      probe: {
        ...GIT_SYNC_CLEAR,
        operations: [
          gitSyncOperation({
            processCgroupPath: '/user.slice/app.slice/papercup-dev-api.service',
            cgroupRelation: 'different',
          }),
        ],
      },
      override: false,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.kind).toBe('operation-in-flight-isolated');
  });

  it('single condition removed — the same operation on an unrelated restart target does not apply', () => {
    const verdict = judgeGitSyncCollision({
      target: 'gateway',
      probe: { ...GIT_SYNC_CLEAR, operations: [gitSyncOperation()] },
      override: false,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.kind).toBe('not-git-sync-sensitive');
  });

  it('fails closed when process/cgroup evidence is unreadable, with the audited override as escape hatch', () => {
    const verdict = judgeGitSyncCollision({
      target: 'bg-host',
      probe: {
        ...GIT_SYNC_CLEAR,
        targetCgroupPath: null,
        operations: [gitSyncOperation({ alive: null, processCgroupPath: null, cgroupRelation: 'unknown' })],
      },
      override: false,
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.kind).toBe('operation-in-flight-unknown');
    expect(verdict.note).toContain('Restart safety is unknown');
    const overridden = judgeGitSyncCollision({
      target: 'bg-host',
      probe: {
        ...GIT_SYNC_CLEAR,
        targetCgroupPath: null,
        operations: [gitSyncOperation({ alive: null, processCgroupPath: null, cgroupRelation: 'unknown' })],
      },
      override: true,
    });
    expect(overridden.blocked).toBe(false);
    expect(overridden.overridden).toBe(true);
    expect(overridden.note).toContain('audited override');
  });

  it('fails closed when the holder ledger cannot be read', () => {
    const probe = { ...GIT_SYNC_CLEAR, probeFailed: true };
    expect(judgeGitSyncCollision({ target: 'dev', probe, override: false }).blocked).toBe(true);
    expect(judgeGitSyncCollision({ target: 'dev', probe, override: true })).toMatchObject({
      blocked: false,
      overridden: true,
      kind: 'probe-failed',
    });
  });

  it('allows a deliberate override and preserves attribution fields', () => {
    const verdict = judgeGitSyncCollision({
      target: 'dev',
      probe: {
        ...GIT_SYNC_CLEAR,
        targetCgroupPath: '/user.slice/app.slice/papercup-dev-api.service',
        operations: [
          gitSyncOperation({
            processCgroupPath: '/user.slice/app.slice/papercup-dev-api.service/worker',
          }),
        ],
      },
      override: true,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.overridden).toBe(true);
    expect(verdict.detail.collidingPids).toEqual([4242]);
    expect(verdict.note).toContain('audited');
  });
});

describe('git-sync collision probe shell', () => {
  const deps = (over: Partial<GitSyncCollisionProbeDeps> = {}): GitSyncCollisionProbeDeps => ({
    readHolders: async () => [],
    readProcess: () => ({ alive: true, cgroupPath: '/user.slice/app.slice/papercup-bg-host.service' }),
    readTargetCgroup: async () => '/user.slice/app.slice/papercup-bg-host.service',
    nowMs: () => 121_000,
    ...over,
  });

  it('parses the writer-backed system:git-sync PID and proves the cgroup collision', async () => {
    const readProcess = vi.fn(() => ({
      alive: true,
      cgroupPath: '/user.slice/app.slice/papercup-bg-host.service/worker',
    }));
    const probe = await probeGitSyncCollision(
      deps({
        readHolders: async () => [
          {
            resource: 'git-sync:papercusp',
            owner: 'system:git-sync:4242:uuid',
            acquiredAtMs: 1_000,
            expiresAtMs: 601_000,
          },
        ],
        readProcess,
      }),
      'bg-host',
    );
    expect(readProcess).toHaveBeenCalledWith(4242);
    expect(probe.operations[0]).toMatchObject({ pid: 4242, alive: true, cgroupRelation: 'same', ageSec: 120 });
    expect(judgeGitSyncCollision({ target: 'bg-host', probe, override: false }).blocked).toBe(true);
  });

  it('the refusal points at git_sync_drain_sec, and marks the override as wedged-host-only (EI-21930094737784126)', async () => {
    // A refusal is read as instructions. This one used to name only
    // override_git_sync_collision, which SIGKILLs an in-flight commit and strands a
    // peer's uncommitted work — so the note taught the dangerous lever and never
    // mentioned the safe one, on a host where the cgroup proxy is ~always true.
    const readProcess = vi.fn(async () => ({
      alive: true,
      cgroupPath: '/user.slice/app.slice/papercup-bg-host.service/worker',
    }));
    const probe = await probeGitSyncCollision(
      deps({
        readHolders: async () => [
          {
            resource: 'git-sync:papercusp',
            owner: 'system:git-sync:4242:uuid',
            acquiredAtMs: 1_000,
            expiresAtMs: 601_000,
          },
        ],
        readProcess,
      }),
      'bg-host',
    );
    const verdict = judgeGitSyncCollision({ target: 'bg-host', probe, override: false });
    expect(verdict.blocked).toBe(true);
    expect(verdict.note).toContain('git_sync_drain_sec');
    // The override must still be reachable, but qualified — never as the plain
    // way through a merely busy host.
    expect(verdict.note).toContain('override_git_sync_collision');
    expect(verdict.note).toMatch(/WEDGED host only/);
  });

  it('ignores an advisory/manual holder whose owner is not a git-sync operation identity', async () => {
    const readProcess = vi.fn();
    const probe = await probeGitSyncCollision(
      deps({
        readHolders: async () => [
          { resource: 'git-sync:papercusp', owner: 'su-manual-holder', acquiredAtMs: 1_000, expiresAtMs: 601_000 },
        ],
        readProcess,
      }),
      'bg-host',
    );
    expect(readProcess).not.toHaveBeenCalled();
    expect(judgeGitSyncCollision({ target: 'bg-host', probe, override: false }).kind).toBe('clear');
  });

  it('short-circuits unrelated targets, including staging, without reading holders', async () => {
    const readHolders = vi.fn(async () => [
      { resource: 'git-sync:papercusp', owner: 'system:git-sync:1:x', acquiredAtMs: 0, expiresAtMs: 1 },
    ]);
    for (const target of ['gateway', 'staging']) {
      const verdict = await checkGitSyncCollision(target, false, deps({ readHolders }));
      expect(verdict.kind).toBe('not-git-sync-sensitive');
    }
    expect(readHolders).not.toHaveBeenCalled();
  });
});

describe('staging-sync restart collision guard', () => {
  it('blocks a staging restart while the sync service holds its exclusive checkout lock', async () => {
    const verdict = await checkStagingSyncCollision('staging', async () => true);
    expect(verdict).toMatchObject({
      blocked: true,
      kind: 'staging-sync-in-flight',
      detail: { lockPath: STAGING_SYNC_LOCK_PATH, lockHeld: true },
    });
    expect(verdict.note).toContain('Nothing was restarted');
  });

  it('allows the final sync restart after the script downgrades its lock to shared', async () => {
    const probe = vi.fn(async () => false);
    const verdict = await checkStagingSyncCollision('staging', probe);
    expect(verdict).toMatchObject({
      blocked: false,
      kind: 'clear',
      detail: { lockPath: STAGING_SYNC_LOCK_PATH, lockHeld: false },
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not inspect the staging lock for other restart targets', async () => {
    const probe = vi.fn(async () => true);
    const verdict = await checkStagingSyncCollision('dev', probe);
    expect(verdict).toMatchObject({ blocked: false, kind: 'not-staging-target' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails closed when the lock state cannot be measured', async () => {
    const verdict = await checkStagingSyncCollision('staging', async () => {
      throw new Error('flock unavailable');
    });
    expect(verdict).toMatchObject({
      blocked: true,
      kind: 'probe-failed',
      detail: { lockPath: STAGING_SYNC_LOCK_PATH, lockHeld: null },
    });
  });

  it.each([
    { code: 'EACCES', message: 'flock could not open the lock', stderr: 'Permission denied' },
    { code: 64, message: 'flock invocation failed', stderr: 'Invalid argument' },
    { code: null, message: 'flock timed out', signal: 'SIGTERM' },
  ])('retains the failed probe diagnostic without claiming a held lock: $message', async (failure) => {
    const verdict = await checkStagingSyncCollision('staging', async () => {
      throw Object.assign(new Error(failure.message), failure);
    });
    expect(verdict).toMatchObject({
      blocked: true,
      kind: 'probe-failed',
      detail: { lockHeld: null, probeError: failure },
    });
    expect(verdict.note).toContain('Nothing was restarted');
  });

  it('bounds child output and retains non-Error probe failures', async () => {
    const verbose = await checkStagingSyncCollision('staging', async () => {
      throw Object.assign(new Error('m'.repeat(800)), { stderr: 's'.repeat(800), signal: 'x'.repeat(100) });
    });
    expect(verbose.detail.probeError).toEqual({ code: null, message: 'm'.repeat(500),
      stderr: 's'.repeat(500), signal: 'x'.repeat(64) });
    const primitive = await checkStagingSyncCollision('staging', async () => { throw null; });
    expect(primitive).toMatchObject({ blocked: true, kind: 'probe-failed',
      detail: { lockHeld: null, probeError: { code: null, message: 'null' } } });
  });
});

describe('git-sync restart atomic barrier (WI-222053 / WI-222686)', () => {
  const deps = (over: Partial<GitSyncRestartBarrierDeps> = {}): GitSyncRestartBarrierDeps => ({
    resolveDomain: vi.fn(() => 'workspace-domain'),
    newOwner: () => 'system:dev-restart:git-sync-barrier:42:uuid',
    acquire: vi.fn(async () => ({
      ok: true as const,
      lock_id: 'barrier-1',
      expires_ts: new Date('2026-08-27T19:00:00Z'),
    })),
    release: vi.fn(async () => undefined),
    ...over,
  });

  it('passes the caller drain budget through as maxWaitSec, so a busy sweep is waited out rather than bounced', async () => {
    // EI-21930094737784126. Measured 2026-08-31: git-sync fires hold this barrier
    // ~5-10s in bursts of ~6, and it was FREE in 20 of 40 sampled seconds. A bare
    // try-acquire lands on a burst and refuses; a drain budget clears it, because a
    // draining exclusive also refuses NEW shared acquires and so stops the sweep
    // feeding itself. 20/20 hand attempts failed before this existed.
    const acquire = vi.fn(async () => ({
      ok: true as const,
      lock_id: 'barrier-1',
      expires_ts: new Date('2026-08-27T19:00:00Z'),
    }));
    await acquireGitSyncRestartBarrier('Agent', deps({ acquire }), { maxDrainSec: 45 });
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ maxWaitSec: 45 }));
  });

  it('RELEASES the queued exclusive a failed acquire leaves behind — an abandoned one back-pressures every harness', async () => {
    // The hazard, hit by hand on 2026-08-31 before it was guarded: a FAILED
    // acquire still returns a lock_id and parks the exclusive in 'draining', which
    // REFUSES NEW SHARED ACQUIRES. Left there it throttles every harness's git-sync
    // until TTL — a restart attempt that quietly degrades the whole fleet.
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({
      ok: false as const,
      reason: 'drain_timeout',
      holders: [{ owner: 'system:git-sync:1:x', mode: 'shared', status: 'held' }],
      lock_id: 'queued-exclusive-1',
    }));
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }), { maxDrainSec: 20 });

    expect(result).toMatchObject({ acquired: false, reason: 'drain_timeout' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ lockId: 'queued-exclusive-1' }));
  });

  it.each([90, 130])('keeps the drain lease alive while a shared holder lasts %i seconds', async (sharedHolderSeconds) => {
    // EI-24359373316570369: a 120s drain used a 60s lease, so the wait
    // returned early when its exclusive disappeared. Model the two independent
    // deadlines: lease expiry and the requested drain budget. A holder ending
    // at 90s must permit restart; one still running at 130s must not.
    const acquire = vi.fn<GitSyncRestartBarrierDeps['acquire']>(async ({ ttlSec, maxWaitSec }) => {
      if (sharedHolderSeconds >= Math.min(ttlSec, maxWaitSec)) {
        return {
          ok: false,
          reason: 'drain_timeout',
          holders: [{ owner: 'system:git-sync:1:x', mode: 'shared', status: 'held' }],
          lock_id: 'queued-exclusive-lease',
        };
      }
      return { ok: true, lock_id: 'queued-exclusive-lease', expires_ts: new Date(ttlSec * 1000) };
    });
    const release = vi.fn(async () => {});
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }), { maxDrainSec: 120 });

    expect(result.acquired).toBe(sharedHolderSeconds < 120);
    if (result.acquired) {
      // The lease must also cover the existing post-acquisition kill handoff.
      expect(acquire.mock.calls[0][0].ttlSec - 120).toBeGreaterThanOrEqual(GIT_SYNC_RESTART_BARRIER_TTL_SEC);
      expect(release).not.toHaveBeenCalled();
    } else {
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ lockId: 'queued-exclusive-lease' }));
    }
  });

  it('retries transient contention while releasing a timed-out queued exclusive', async () => {
    // EI-22627342911348772: a live restart timed out behind a shared git-sync
    // holder, then its one-shot cleanup lost the hot workspace transaction.
    // Once the shared holder left, that abandoned row promoted to `held`; the
    // next restart refused against its own predecessor. The injected release
    // seam lets this test prove the barrier wrapper itself retries cleanup.
    const contention = Object.assign(new Error('workspace lock timed out'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    const release = vi.fn().mockRejectedValueOnce(contention).mockResolvedValueOnce(undefined);
    const acquire = vi.fn(async () => ({
      ok: false as const,
      reason: 'drain_timeout',
      holders: [{ owner: 'system:git-sync:1:x', mode: 'shared', status: 'held' }],
      lock_id: 'queued-exclusive-retry',
    }));

    const result = await acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }), { maxDrainSec: 20 });

    expect(result).toMatchObject({ acquired: false, reason: 'drain_timeout' });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ lockId: 'queued-exclusive-retry' }),
    );
  });

  it('does not attempt a release when the failure left NO queue row', async () => {
    // Control for the test above: releasing a lock_id we never got would be a
    // different bug, and would make the guard pass for the wrong reason.
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({
      ok: false as const,
      reason: 'held_exclusive',
      holders: [],
    }));
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }));
    expect(result).toMatchObject({ acquired: false, reason: 'held_exclusive' });
    expect(release).not.toHaveBeenCalled();
  });

  it('never reports a parked draining queue row as an acquisition', async () => {
    // `status:'draining'` comes back as ok:true from the wait module (maxWaitSec 0),
    // which is the one shape that could read as success while holding nothing. If it
    // ever did, dev:restart would proceed to SIGKILL a live git-sync commit.
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({
      ok: false as const,
      reason: 'draining',
      holders: [{ owner: 'system:git-sync:1:x', mode: 'shared', status: 'held' }],
      lock_id: 'queued-exclusive-2',
    }));
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }));
    expect(result).toMatchObject({ acquired: false, reason: 'draining' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ lockId: 'queued-exclusive-2' }));
  });

  it('a release failure does not mask the acquire failure the caller needs to see', async () => {
    const release = vi.fn(async () => {
      throw new Error('pg down');
    });
    const acquire = vi.fn(async () => ({
      ok: false as const,
      reason: 'drain_timeout',
      holders: [],
      lock_id: 'queued-exclusive-3',
    }));
    // Must resolve, not reject: the TTL is the backstop for the orphaned row, and
    // swallowing the real refusal behind a cleanup error would be strictly worse.
    await expect(
      acquireGitSyncRestartBarrier('Agent', deps({ acquire, release }), { maxDrainSec: 10 }),
    ).resolves.toMatchObject({ acquired: false, reason: 'drain_timeout' });
  });

  it('resolves the existing exact git-sync resource through the canonical domain mapper and acquires it exclusively', async () => {
    const resolveDomain = vi.fn(() => 'workspace-domain');
    const acquire = vi.fn(async () => ({
      ok: true as const,
      lock_id: 'barrier-1',
      expires_ts: new Date('2026-08-27T19:00:00Z'),
    }));
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ resolveDomain, acquire }));
    expect(resolveDomain).toHaveBeenCalledWith(GIT_SYNC_RESTART_BARRIER_RESOURCE);
    expect(acquire).toHaveBeenCalledWith({
      coordinationDomain: 'workspace-domain',
      resource: 'git-sync',
      owner: 'system:dev-restart:git-sync-barrier:42:uuid',
      ownerLabel: 'Agent',
      ttlSec: GIT_SYNC_RESTART_BARRIER_TTL_SEC,
      // EI-21930094737784126: the DEFAULT stays no-wait, so every existing caller
      // keeps today's immediate fast-fail. Draining is opt-in per call.
      maxWaitSec: 0,
    });
    expect(result).toMatchObject({
      acquired: true,
      resource: 'git-sync',
      expiresAt: '2026-08-27T19:00:00.000Z',
    });
  });

  it('returns the live holder instead of pretending the atomic barrier was acquired', async () => {
    const result = await acquireGitSyncRestartBarrier(
      'Agent',
      deps({
        acquire: async () => ({
          ok: false,
          reason: 'held_exclusive',
          holders: [
            {
              owner: 'system:git-sync:77:run',
              owner_label: 'git-sync:papercusp',
              mode: 'exclusive',
              status: 'held',
            },
          ],
        }),
      }),
    );
    expect(result).toEqual({
      acquired: false,
      resource: 'git-sync',
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'system:git-sync:77:run',
          owner_label: 'git-sync:papercusp',
          mode: 'exclusive',
          status: 'held',
        },
      ],
    });
  });

  it('releases by the captured domain + unique owner on an abort path', async () => {
    const release = vi.fn(async () => undefined);
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ release }));
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('expected barrier');
    await result.release();
    expect(release).toHaveBeenCalledWith({
      coordinationDomain: 'workspace-domain',
      owner: 'system:dev-restart:git-sync-barrier:42:uuid',
      lockId: 'barrier-1',
    });
  });

  it('EI-25556999491855818: signals a held barrier release only after its transaction confirms deletion', async () => {
    let confirmRelease!: (receipt: { released: number; exclusiveResources: string[] }) => void;
    const release = vi.fn(() => new Promise<{ released: number; exclusiveResources: string[] }>((resolve) => {
      confirmRelease = resolve;
    }));
    const emitReleased = vi.fn();
    const result = await acquireGitSyncRestartBarrier('Agent', deps({ release, emitReleased }));
    if (!result.acquired) throw new Error('expected barrier');
    expect(emitReleased).not.toHaveBeenCalled();

    const pending = result.release();
    expect(emitReleased).not.toHaveBeenCalled();
    confirmRelease({ released: 1, exclusiveResources: ['git-sync'] });
    await pending;

    expect(emitReleased).toHaveBeenCalledExactlyOnceWith('git-sync', 'workspace-domain');
    release.mockResolvedValueOnce({ released: 0, exclusiveResources: [] });
    await result.release();
    expect(emitReleased).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { released: 0, exclusiveResources: [] },
    { released: 1, exclusiveResources: ['another-resource'] },
  ])('does not signal a release without a matching deletion receipt (%j)', async (receipt) => {
    const emitReleased = vi.fn();
    const result = await acquireGitSyncRestartBarrier('Agent', deps({
      release: vi.fn(async () => receipt),
      emitReleased,
    }));
    if (!result.acquired) throw new Error('expected barrier');
    await result.release();
    expect(emitReleased).not.toHaveBeenCalled();
  });

  it('does not signal a failed release', async () => {
    const emitReleased = vi.fn();
    const result = await acquireGitSyncRestartBarrier('Agent', deps({
      release: vi.fn(async () => { throw new Error('pg down'); }),
      emitReleased,
    }));
    if (!result.acquired) throw new Error('expected barrier');
    await expect(result.release()).rejects.toThrow('pg down');
    expect(emitReleased).not.toHaveBeenCalled();
  });

  it('signals actual queued-exclusive cleanup once after a transient release failure while preserving the refusal', async () => {
    const contention = Object.assign(new Error('workspace lock timed out'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    const release = vi.fn()
      .mockRejectedValueOnce(contention)
      .mockResolvedValueOnce({ released: 1, exclusiveResources: ['git-sync'] });
    const emitReleased = vi.fn();
    const result = await acquireGitSyncRestartBarrier('Agent', deps({
      acquire: async () => ({ ok: false, reason: 'drain_timeout', holders: [], lock_id: 'queued-exclusive' }),
      release,
      emitReleased,
    }), { maxDrainSec: 20 });
    expect(result).toMatchObject({ acquired: false, reason: 'drain_timeout' });
    expect(release).toHaveBeenCalledTimes(2);
    expect(emitReleased).toHaveBeenCalledExactlyOnceWith('git-sync', 'workspace-domain');
  });

  it('extends the lease by holdExtraSec so a post-acquire wait cannot eat the kill-handoff window', async () => {
    const acquire = vi.fn<GitSyncRestartBarrierDeps['acquire']>(async ({ ttlSec }) => ({
      ok: true,
      lock_id: 'held',
      expires_ts: new Date(ttlSec * 1000),
    }));
    const deps: GitSyncRestartBarrierDeps = {
      resolveDomain: () => 'workspace-domain',
      newOwner: () => 'system:dev-restart:git-sync-barrier:1:x',
      acquire,
      release: vi.fn(async () => undefined),
    };
    await acquireGitSyncRestartBarrier(null, deps, { maxDrainSec: 120, holdExtraSec: 30 });
    await acquireGitSyncRestartBarrier(null, deps, { maxDrainSec: 120 });
    expect(acquire.mock.calls[0][0].ttlSec).toBe(120 + 30 + GIT_SYNC_RESTART_BARRIER_TTL_SEC);
    expect(acquire.mock.calls[1][0].ttlSec).toBe(120 + GIT_SYNC_RESTART_BARRIER_TTL_SEC);
  });
});

// WI-6554700010010484 (P-031): the lease-keyed checks cannot see a pass whose leases
// lapsed; this probe reads the commit process's own writer-backed activity marker.
describe('probeInFlightLocalSync', () => {
  const NOW = 1_800_000_000_000;
  const TARGET_CGROUP = '/user.slice/papercusp-bg-host.service';
  const marker = (over: Record<string, unknown> = {}) => ({
    active: true,
    phase: 'local-sync',
    started_at: NOW - 120_000,
    updated_at: NOW - 5_000,
    completed_at: null,
    outcome_status: null,
    owner: 'system:git-sync:4242:fire',
    owner_pid: 4242,
    ...over,
  });
  const deps = (
    activity: unknown[],
    processes: Record<number, { alive: boolean | null; cgroupPath: string | null }> = {
      4242: { alive: true, cgroupPath: TARGET_CGROUP },
    },
  ): InFlightLocalSyncProbeDeps => ({
    readActivityRows: async () => activity.map((a, i) => ({ installSlug: `slug-${i}`, activity: a })),
    readProcess: (pid) => processes[pid] ?? { alive: false, cgroupPath: null },
    readTargetCgroup: () => TARGET_CGROUP,
    freshForMs: 660_000,
    nowMs: () => NOW,
  });

  it('reports a fresh local-sync pass whose live owner shares the target cgroup', async () => {
    const probe = await probeInFlightLocalSync('bg-host', deps([marker()]));
    expect(probe).toMatchObject({
      probeFailed: false,
      targetCgroupPath: TARGET_CGROUP,
      inFlight: [{ installSlug: 'slug-0', ownerPid: 4242, updatedAtMs: NOW - 5_000, cgroupRelation: 'same' }],
    });
  });

  it.each([
    ['a post-legs marker (legs re-take their own lock by design)', marker({ phase: 'post-legs' })],
    ['a completed marker', marker({ active: false, phase: 'complete' })],
    ['a stale heartbeat beyond the idle-timeout bound', marker({ updated_at: NOW - 700_000 })],
    ['a marker with no valid owner pid', marker({ owner_pid: null })],
  ])('ignores %s', async (_label, activity) => {
    const probe = await probeInFlightLocalSync('bg-host', deps([activity]));
    expect(probe).toMatchObject({ probeFailed: false, inFlight: [] });
  });

  it('ignores a dead owner and a sibling-cgroup owner, but fails closed on an unreadable one', async () => {
    const probe = await probeInFlightLocalSync(
      'bg-host',
      deps([marker({ owner_pid: 1 }), marker({ owner_pid: 2 }), marker({ owner_pid: 3 })], {
        1: { alive: false, cgroupPath: null },
        2: { alive: true, cgroupPath: '/user.slice/run-r1234.scope' },
        3: { alive: null, cgroupPath: null },
      }),
    );
    expect(probe.inFlight).toEqual([expect.objectContaining({ ownerPid: 3, cgroupRelation: 'unknown' })]);
  });

  it('reports probeFailed when the marker rows cannot be read', async () => {
    const failing: InFlightLocalSyncProbeDeps = {
      ...deps([]),
      readActivityRows: async () => {
        throw new Error('pool exhausted');
      },
    };
    expect(await probeInFlightLocalSync('dev', failing)).toEqual({
      probeFailed: true,
      targetCgroupPath: null,
      inFlight: [],
    });
  });

  it('waitForInFlightLocalSync returns as soon as the pass settles, else after the budget', async () => {
    let reads = 0;
    let clock = NOW;
    const settling: InFlightLocalSyncProbeDeps = {
      ...deps([]),
      readActivityRows: async () => [{ installSlug: 'papercusp', activity: reads++ < 2 ? marker() : marker({ active: false, phase: 'complete' }) }],
    };
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const settled = await waitForInFlightLocalSync('bg-host', { waitSec: 10, deps: settling, sleep, nowMs: () => clock });
    expect(settled.inFlight).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(2);

    clock = NOW;
    sleep.mockClear();
    const stuck = await waitForInFlightLocalSync('bg-host', { waitSec: 3, deps: deps([marker()]), sleep, nowMs: () => clock });
    expect(stuck.inFlight).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
