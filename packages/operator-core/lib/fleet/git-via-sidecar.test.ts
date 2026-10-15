import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  isSpawnOffloadHost,
  markSpawnOffloadHost,
  resetSpawnOffloadHostForTest,
} from './git-via-sidecar';
import { execProcess, type ExecProcessDeps } from './sidecar-exec-process';
import type { GovernedExecution } from '../resource-governor/execution';

function testExecution(): GovernedExecution {
  return {
    receiptId: 'test-receipt',
    context: {
      contractVersion: 1,
      requestId: 'test-request',
      rootRequestId: 'test-request',
      parentRequestId: null,
      idempotencyKey: 'test-sidecar-process',
      admissionClass: 'process',
      priority: 0,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: 1,
      decisionGeneration: 1,
    },
    lease: { leaseId: 'test-lease', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: async () => true,
    cancel: async () => true,
  };
}

// lazyReceiptMs:0 — these tests pin admit-BEFORE-spawn; the lazy path has its own suite
// (sidecar-exec-lazy-receipt.test.ts).
const executionDeps: ExecProcessDeps = { beginExecution: async () => testExecution(), lazyReceiptMs: 0 };

/**
 * These guard the ENABLE DECISION for routing `git` through the spawner sidecar
 * (EI-18808838427010743). The decision is small but load-bearing in two
 * directions: leaving it off silently restores a ~165ms-per-git-call event-loop
 * stall on the bg-host, and getting the mode-var wrong makes the SIDECAR route
 * to itself — an infinite spawn recursion rather than a quiet perf regression.
 */
describe('gitSidecarEnabled', () => {
  it('is OFF when nothing is set (the sidecar is opt-in)', () => {
    expect(gitSidecarEnabled(undefined, {})).toBe(false);
  });

  it('does not treat an inherited shared enable var as proof this process owns the host sidecar', () => {
    expect(gitSidecarEnabled(undefined, { PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(false);
  });

  it('honors the shared enable var on a process marked as the offload host', () => {
    try {
      markSpawnOffloadHost();
      expect(gitSidecarEnabled(undefined, { PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(true);
    } finally {
      resetSpawnOffloadHostForTest();
    }
  });

  it('is OFF INSIDE the sidecar process itself, even with the enable var set', () => {
    // The recursion guard: the sidecar sets the MODE var on itself. Without
    // this, a git call made inside the sidecar would be dispatched to the
    // sidecar, which would dispatch it to the sidecar, ...
    expect(
      gitSidecarEnabled(undefined, {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });

  it("the caller's explicit var can force it ON while the shared var is unset", () => {
    expect(gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', { PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '1' })).toBe(true);
  });

  it("the caller's explicit var can force it OFF while the shared var is ON (per-subsystem bisect)", () => {
    expect(
      gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', {
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
      }),
    ).toBe(false);
  });

  it('the MODE recursion guard beats an explicit ON', () => {
    expect(
      gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', {
        PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });

  it('keeps the two subsystems independent (git-sync vs pot-git)', () => {
    const env = {
      PAPERCUSP_SPAWNER_SIDECAR: '1',
      PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
    };
    try {
      markSpawnOffloadHost();
      expect(gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR', env)).toBe(false);
      expect(gitSidecarEnabled('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', env)).toBe(true);
    } finally {
      resetSpawnOffloadHostForTest();
    }
  });
});

// WI-10002709: a MARKED spawn-offload host (the request operator, hono-host.ts)
// defaults every seam to the sidecar once its socket exists — so a site nobody
// opted in by name (git-pipeline-position on :3070) stops forking from a ~2 GB
// worker. The marker is in-memory, never inherited through env.
describe('gitSidecarEnabled on a marked spawn-offload host (WI-10002709)', () => {
  const SOCKET = { PAPERCUSP_SPAWNER_IPC_SOCKET: '/tmp/papercusp-spawner-1.sock' };
  beforeEach(() => resetSpawnOffloadHostForTest());
  afterEach(() => resetSpawnOffloadHostForTest());

  it('control: an UNMARKED process with a socket in env stays OFF (inherited env alone never enables it)', () => {
    expect(isSpawnOffloadHost()).toBe(false);
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', SOCKET)).toBe(false);
  });

  it('a marked host with an established socket defaults an un-opted-in site ON', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', SOCKET)).toBe(true);
    expect(gitSidecarEnabled(undefined, SOCKET)).toBe(true);
  });

  it('a marked host with NO socket yet stays OFF (never spawns a sidecar just for git)', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', {})).toBe(false);
    expect(gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', { PAPERCUSP_SPAWNER_IPC_SOCKET: '  ' })).toBe(false);
  });

  it("the site's explicit var still wins on a marked host (per-site kill-switch)", () => {
    markSpawnOffloadHost();
    expect(
      gitSidecarEnabled('PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR', { ...SOCKET, PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR: '0' }),
    ).toBe(false);
  });

  it('the MODE recursion guard beats the host marker (the sidecar never routes through itself)', () => {
    markSpawnOffloadHost();
    expect(gitSidecarEnabled(undefined, { ...SOCKET, PAPERCUSP_SPAWNER_SIDECAR_MODE: '1' })).toBe(false);
  });
});

describe('isSidecarInfrastructureFault (WI-10002709)', () => {
  it("names the sidecar's own faults, so callers fall back instead of reporting them as the child's exit", () => {
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'spawner sidecar admission failed: x' })).toBe(true);
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'spawner sidecar could not spawn process: x' })).toBe(true);
  });

  it("does not claim a real child failure (a timeout kill or a non-zero exit is the child's answer)", () => {
    expect(isSidecarInfrastructureFault({ code: -1, stderr: 'systemctl --user show timed out after 3000ms' })).toBe(false);
    expect(isSidecarInfrastructureFault({ code: 1, stderr: 'spawner sidecar admission failed' })).toBe(false);
    expect(isSidecarInfrastructureFault({ code: 0, stderr: '' })).toBe(false);
  });
});

describe('spawner-sidecar process progress guard', () => {
  it.each([0, 1_200])('drains already-written progress before judging an idle deadline after a parent-loop stall (startup %ims)', async (startupMs) => {
    // Startup is a precondition, not the idle-drain behavior under test. Freeze
    // guard timers until real pipe output arrives, then restore the real event
    // loop before the stall. The delayed case exceeds the initial idle window
    // and prevents child startup from masquerading as a drain-order regression.
    const idleTimeoutMs = 1_000;
    const stallMs = 1_500; // > idleTimeoutMs, so the idle deadline expires inside the stall
    const script = [
      "const send = phase => process.stderr.write(JSON.stringify({ phase, at: Date.now() }) + '\\n');",
      `setTimeout(() => { send('ready'); setInterval(() => send('progress'), 40); }, ${startupMs});`,
    ].join(' ');
    const abort = new AbortController();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const watchdog = realSetTimeout(() => abort.abort(), 15_000);
    let queuedBlock = false;
    let blockedFrom = 0;
    let blockedUntil = 0;
    let drainedAfterStall = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let res: Awaited<ReturnType<typeof execProcess>>;
    try {
      res = await execProcess({
      command: process.execPath,
      args: ['-e', script],
      idleTimeoutMs,
      timeoutMs: 15_000,
    }, {
      ...executionDeps,
      signal: abort.signal,
      onOutputActivity: () => {
        if (blockedUntil > 0) {
          if (drainedAfterStall) return;
          drainedAfterStall = true;
          // This is the POLL-phase drain of output written during the stall.
          // The expired idle deadline queued its verdict (an immediate) in the
          // TIMERS phase BEFORE this drain, so an immediate queued here runs
          // AFTER it in the same CHECK phase: a verdict the drain failed to
          // cancel would kill the child first, as 'no output progress'.
          setImmediate(() => abort.abort());
          return;
        }
        if (queuedBlock) return;
        queuedBlock = true;
        // reportOutput runs before armIdleTimer, so the first real output
        // arms a real idle timer after retiring the frozen startup timers.
        vi.useRealTimers();
        // The child has reported readiness. Occupy the CHECK phase while it
        // keeps writing, so the expired timer races the next POLL phase.
        setImmediate(() => {
          blockedFrom = Date.now();
          while (Date.now() - blockedFrom < stallMs) { /* deliberate parent-loop stall */ }
          blockedUntil = Date.now();
        });
      },
      onStage: (stage) => { if (stage === 'child-close') vi.useRealTimers(); },
      });
    } finally {
      vi.useRealTimers();
      realClearTimeout(watchdog);
      abort.abort();
    }
    const writes = res.stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    // The stall really outlasted the idle deadline, and the child really wrote
    // during it: distinguish absent child progress from progress in the OS pipe.
    expect(blockedUntil - blockedFrom, res.stderr).toBeGreaterThanOrEqual(stallMs);
    expect(writes.filter((entry) => entry.phase === 'progress' && entry.at > blockedFrom && entry.at < blockedUntil).length).toBeGreaterThanOrEqual(3);
    expect(drainedAfterStall).toBe(true);
    expect(res.stderr).not.toContain('no output progress');
    expect(res.stderr).toContain('aborted by caller');
    expect(res.code).toBe(-1);
  }, 20_000);

  it.each([0, 1_200])('does not kill a child that exited while the parent loop stalled past the idle deadline (startup %ims)', async (startupMs) => {
    // Gate red at repair head 6bf86578 (2026-09-27): a lagging host loop resumes
    // with the idle timer expired AND the child's EOF/exit pending. The idle
    // verdict runs in CHECK, but 'close' (and the exit fence) land after it, so
    // an already-finished child was killed and reported as a guard failure.
    // As in the drain fixture, startup must finish before guard time starts.
    // Keep the real stall and kernel exit fence after that readiness boundary.
    let queuedBlock = false;
    const abort = new AbortController();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const watchdog = realSetTimeout(() => abort.abort(), 15_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let res: Awaited<ReturnType<typeof execProcess>>;
    try {
      res = await execProcess({
      command: process.execPath,
      args: ['-e', `setTimeout(() => { process.stderr.write('ready\\n'); setTimeout(() => process.exit(0), 100); }, ${startupMs});`],
      idleTimeoutMs: 1_000,
      timeoutMs: 15_000,
    }, {
      ...executionDeps,
      signal: abort.signal,
      onOutputActivity: () => {
        if (queuedBlock) return;
        queuedBlock = true;
        vi.useRealTimers();
        setImmediate(() => {
          const from = Date.now();
          while (Date.now() - from < 2_500) { /* stall until the child has exited */ }
        });
      },
      onStage: (stage) => { if (stage === 'child-close') vi.useRealTimers(); },
      });
    } finally {
      vi.useRealTimers();
      realClearTimeout(watchdog);
      abort.abort();
    }
    expect(queuedBlock, res.stderr).toBe(true);
    expect(res.stderr).not.toContain('no output progress');
    expect(res.code, res.stderr).toBe(0);
  }, 20_000);

  it('still idle-kills a child that closed its pipes but stays alive past the exit grace', async () => {
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', "const fs = require('fs'); fs.closeSync(1); fs.closeSync(2); setTimeout(() => {}, 60_000);"],
      // idle-window-ok: this test ASSERTS the idle kill; a slow child boot can only delay it, never prevent it.
      idleTimeoutMs: 120,
      timeoutMs: 5_000,
    }, executionDeps);
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });

  it('retains the absolute deadline when output never stops', async () => {
    // The idle clock is armed at spawn, so the child's node boot is charged to its first
    // window (WI-10004030): the window must outlast a loaded boot, and the hard deadline
    // must still be the bound that fires.
    const IDLE_MS = 1_000;
    const HARD_MS = 2_500;
    expect(IDLE_MS).toBeLessThan(HARD_MS);
    const res = await execProcess({
      command: process.execPath,
      args: ['-e', "process.stderr.write('ready\\n'); setInterval(() => process.stderr.write('progress\\n'), 20);"],
      idleTimeoutMs: IDLE_MS,
      timeoutMs: HARD_MS,
    }, executionDeps);
    expect(res.stderr).toContain('progress');
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(`timed out after ${HARD_MS}ms`);
    expect(res.stderr).not.toContain('no output progress');
  });

  it('refreshes the idle deadline on child output while retaining the absolute hard ceiling', async () => {
    // WI-6554700010008342: advance guard time only between observed real pipe
    // events. Node boot and reaping no longer consume the idle window, and the
    // child keeps writing until the actual hard guard kills its process group.
    const IDLE_MS = 1_000;
    const STEP_MS = 900;
    const HARD_MS = 5_000;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      watchdogTimer = realSetTimeout(() => reject(new Error('sidecar output/exit rendezvous timed out')), 20_000);
    });
    let outputCount = 0;
    let outputReady: (() => void) | undefined;
    const nextOutput = (): Promise<void> => new Promise((resolve) => { outputReady = resolve; });
    const ready = nextOutput();
    const abort = new AbortController();
    let settled = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = execProcess({
        command: process.execPath,
        args: ['-e', "process.stderr.write('progress\\n'); setInterval(() => process.stderr.write('progress\\n'), 20);"],
        idleTimeoutMs: IDLE_MS,
        timeoutMs: HARD_MS,
    }, {
      ...executionDeps,
      signal: abort.signal,
      onOutputActivity: () => {
        outputCount++;
        outputReady?.();
        outputReady = undefined;
      },
      // The real group exit fence can need asynchronous probes after close.
      // Restore its real timers instead of faking successful process cleanup.
      onStage: (stage) => { if (stage === 'child-close') vi.useRealTimers(); },
    }).then((res) => { settled = true; return res; });
    const exitedBeforeProgress = result.then((res) => {
      throw new Error(`child exited before the next progress event: ${res.stderr}`);
    });
    try {
      await Promise.race([ready, exitedBeforeProgress, watchdog]);
      for (let step = 0; step < 5; step++) {
        const progress = nextOutput();
        vi.advanceTimersByTime(STEP_MS);
        await Promise.race([progress, exitedBeforeProgress, watchdog]);
        expect(settled).toBe(false);
      }
      // Five real output events kept the child alive beyond four initial idle
      // windows. The original hard deadline must still fire at exactly 5000.
      expect(outputCount).toBeGreaterThanOrEqual(6);
      vi.advanceTimersByTime(HARD_MS - 5 * STEP_MS - 1);
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      const res = await Promise.race([result, watchdog]);
      expect(res.code).toBe(-1);
      expect(res.stderr).toContain(`timed out after ${HARD_MS}ms`);
      expect(res.stderr).not.toContain('no output progress');
    } finally {
      realClearTimeout(watchdogTimer);
      vi.useRealTimers();
      abort.abort();
      await result;
      // A successful hard kill also resolves this diagnostic branch.
      await exitedBeforeProgress.catch(() => {});
    }
  }, 30_000);

  it('kills a silent child at the idle deadline instead of waiting for the hard ceiling', async () => {
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60_000)'],
        // idle-window-ok: this test ASSERTS the idle kill of a silent child; boot time cannot turn it into a pass.
        idleTimeoutMs: 120,
        timeoutMs: 2_000,
      },
      executionDeps,
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/made no output progress for 120ms/);
  });
});
