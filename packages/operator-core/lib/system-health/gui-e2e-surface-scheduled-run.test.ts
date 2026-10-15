import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';
import {
  GUI_E2E_SURFACE_SCHEDULED_SID,
  RUN_TIMEOUT_MS,
  guiE2eSurfaceSuiteEnv,
  runGuiE2eSurfaceScheduledRun,
  parseGuiE2eSurfaceSuiteOutput,
  type GuiE2eSurfaceScheduledRunIO,
} from './gui-e2e-surface-scheduled-run';

/** A fake ChildProcess whose stdout/stderr/close/error we drive by hand. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  (ee as unknown as { kill: (sig?: string) => void }).kill = vi.fn();
  return ee;
}

function io(overrides: Partial<GuiE2eSurfaceScheduledRunIO> = {}): {
  io: GuiE2eSurfaceScheduledRunIO;
  child: ReturnType<typeof fakeChild>;
  spawnFn: ReturnType<typeof vi.fn>;
  escalate: ReturnType<typeof vi.fn>;
} {
  const child = fakeChild();
  const spawnFn = vi.fn(() => child as never);
  const escalate = overrides.escalate ?? vi.fn(() => Promise.resolve(true));
  return {
    io: {
      spawnFn: spawnFn as unknown as GuiE2eSurfaceScheduledRunIO['spawnFn'],
      readEnabled: overrides.readEnabled ?? (() => Promise.resolve(true)),
      escalate: escalate as unknown as GuiE2eSurfaceScheduledRunIO['escalate'],
    },
    child,
    spawnFn,
    escalate: escalate as ReturnType<typeof vi.fn>,
  };
}

// See desktop-perf-scheduled-run.test.ts's own comment: `readEnabled()` is
// awaited before the child is spawned and its listeners wired, so even a
// synchronously-resolved promise defers wiring by one microtask tick.
async function flushReadEnabledTick(): Promise<void> {
  await Promise.resolve();
}

describe('parseGuiE2eSurfaceSuiteOutput', () => {
  it('parses every PASS/FAIL line regardless of surrounding noise', () => {
    const output = [
      '=== leg: quick-panel ===',
      'P003_TAURI_SURFACE_VERIFY_OK leg=quick-panel output=/tmp/x',
      '=== leg: gym ===',
      'P004_TAURI_SURFACE_VERIFY_FAIL leg=gym output=/tmp/y',
      'some unrelated line',
      'P007_TAURI_SURFACE_VERIFY_OK leg=login output=/tmp/z',
    ].join('\n');
    expect(parseGuiE2eSurfaceSuiteOutput(output)).toEqual([
      { leg: 'quick-panel', ok: true },
      { leg: 'gym', ok: false },
      { leg: 'login', ok: true },
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(parseGuiE2eSurfaceSuiteOutput('no leg lines here at all')).toEqual([]);
  });

  it("parses the runner's own P000 line for a leg that died before printing one", () => {
    expect(
      parseGuiE2eSurfaceSuiteOutput('P000_TAURI_SURFACE_VERIFY_FAIL leg=login reason=verifier-exit rc=1 log=/tmp/x'),
    ).toEqual([{ leg: 'login', ok: false }]);
  });
});

describe('guiE2eSurfaceSuiteEnv (WI-10006730)', () => {
  it('gives the scheduled suite an attributable PAPERCUSP_SID when the host has none', () => {
    expect(guiE2eSurfaceSuiteEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', PAPERCUSP_SID: GUI_E2E_SURFACE_SCHEDULED_SID });
    expect(guiE2eSurfaceSuiteEnv({ PAPERCUSP_SID: '  ' }).PAPERCUSP_SID).toBe(GUI_E2E_SURFACE_SCHEDULED_SID);
  });

  it("keeps a caller's own PAPERCUSP_SID", () => {
    expect(guiE2eSurfaceSuiteEnv({ PAPERCUSP_SID: 'su-abc' }).PAPERCUSP_SID).toBe('su-abc');
  });
});

/**
 * Runs the REAL scripts/tauri-surface-verify-suite.sh against stub legs and a stub verifier
 * (its TAURI_SURFACE_VERIFY_SUITE_LEGS / _VERIFIER seams), then parses its output with the
 * producer's own parser. Guards the class WI-10006730 found: a leg whose verifier dies before the
 * leg runs must still yield a parseable FAIL naming it, never "0 legs parsed".
 */
describe('tauri-surface-verify-suite.sh per-leg verdict contract', () => {
  function runSuite(legs: Record<string, string | null>, verifier: string) {
    const dir = mkdtempSync(join(tmpdir(), 'pcv-suite-test-'));
    try {
      const verifierPath = join(dir, 'verifier.sh');
      writeFileSync(verifierPath, `#!/usr/bin/env bash\n${verifier}\n`);
      chmodSync(verifierPath, 0o755);
      const entries = Object.entries(legs).map(([leg, body]) => {
        const script = join(dir, `${leg}.sh`);
        if (body !== null) writeFileSync(script, `${body}\n`);
        return `${leg}:0:${script}`;
      });
      const run = spawnSync('bash', [join(REPO_ROOT, 'scripts/tauri-surface-verify-suite.sh')], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TAURI_SURFACE_VERIFY_SUITE_LEGS: entries.join(' '),
          TAURI_SURFACE_VERIFY_SUITE_VERIFIER: verifierPath,
          TAURI_SURFACE_VERIFY_SUITE_OUT: join(dir, 'out'),
        },
        timeout: 30_000,
      });
      return { status: run.status, legs: parseGuiE2eSurfaceSuiteOutput(`${run.stdout}\n${run.stderr}`) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Runs the leg, then prints teardown noise so the leg's own verdict falls outside `tail -n 8`.
  // The suite invokes `<verifier> -- bash <leg script>`.
  const runLegThenTeardown = 'shift; "$@"; rc=$?; for i in $(seq 1 12); do echo "teardown $i"; done; exit $rc';

  it('names every leg as failed when the verifier refuses before the leg runs', () => {
    const r = runSuite(
      { login: 'echo P007_TAURI_SURFACE_VERIFY_OK leg=login', gym: 'echo P004_TAURI_SURFACE_VERIFY_OK leg=gym' },
      'echo "FATAL: PAPERCUSP_SID is unset" >&2; exit 1',
    );
    expect(r.status).toBe(1);
    expect(r.legs).toEqual([{ leg: 'login', ok: false }, { leg: 'gym', ok: false }]);
  });

  it("re-emits a passing leg's own verdict even when teardown pushed it out of the tail", () => {
    const r = runSuite({ login: 'echo P007_TAURI_SURFACE_VERIFY_OK leg=login output=/tmp/x' }, runLegThenTeardown);
    expect(r.status).toBe(0);
    expect(r.legs).toEqual([{ leg: 'login', ok: true }]);
  });

  it('fails a leg that exits 0 without printing a verdict, and a missing leg script', () => {
    const r = runSuite({ quiet: 'echo done', ghost: null }, runLegThenTeardown);
    expect(r.status).toBe(1);
    expect(r.legs).toEqual([{ leg: 'quiet', ok: false }, { leg: 'ghost', ok: false }]);
  });

  it("keeps a leg's own FAIL verdict without adding a second line", () => {
    const r = runSuite({ gym: 'echo P004_TAURI_SURFACE_VERIFY_FAIL leg=gym output=/tmp/y; exit 1' }, runLegThenTeardown);
    expect(r.status).toBe(1);
    expect(r.legs).toEqual([{ leg: 'gym', ok: false }]);
  });
});

describe('runGuiE2eSurfaceScheduledRun', () => {
  it('skips entirely without spawning when the flag is off', async () => {
    const { io: fakeIo, spawnFn, escalate } = io({ readEnabled: () => Promise.resolve(false) });
    const r = await runGuiE2eSurfaceScheduledRun(fakeIo);
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toMatch(/flag is off/);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(escalate).not.toHaveBeenCalled();
  });

  it('spawns the suite script and resolves ran:true, escalated:false on a clean exit', async () => {
    const { io: fakeIo, child, spawnFn, escalate } = io();
    const p = runGuiE2eSurfaceScheduledRun(fakeIo);
    await flushReadEnabledTick();
    child.stdout.emit(
      'data',
      Buffer.from('P008_TAURI_SURFACE_SUITE_OK legs=8 output=/tmp/pcv-suite-x\n'),
    );
    child.emit('close', 0);
    const r = await p;
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.escalated).toBe(false);
    expect(typeof r.durationMs).toBe('number');
    expect(escalate).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('tauri-surface-verify-suite.sh')],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    // WI-10006730: without a PAPERCUSP_SID the verifier refuses every leg.
    const spawnEnv = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(spawnEnv.PAPERCUSP_SID).toBeTruthy();
  });

  it('resolves ran:true on a nonzero exit and ESCALATES naming the failing leg(s) — not a tick failure', async () => {
    const { io: fakeIo, child, escalate } = io();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = runGuiE2eSurfaceScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.stdout.emit(
        'data',
        Buffer.from(
          'P003_TAURI_SURFACE_VERIFY_OK leg=quick-panel output=/tmp/a\n' +
            'P004_TAURI_SURFACE_VERIFY_FAIL leg=gym output=/tmp/b\n' +
            'P008_TAURI_SURFACE_SUITE_FAIL legs=gym output=/tmp/pcv-suite-x\n',
        ),
      );
      child.emit('close', 1);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.exitCode).toBe(1);
      expect(r.timedOut).toBeUndefined();
      expect(r.legs).toEqual([
        { leg: 'quick-panel', ok: true },
        { leg: 'gym', ok: false },
      ]);
      expect(r.escalated).toBe(true);
      expect(escalate).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('1 leg(s) failing'),
          body: expect.stringContaining('gym'),
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('suite exited 1'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still escalates (generically) when the exit is nonzero but no per-leg line parses', async () => {
    const { io: fakeIo, child, escalate } = io();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = runGuiE2eSurfaceScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.stdout.emit('data', Buffer.from('bash: scripts/verify-tauri-headless.sh: not found\n'));
      child.emit('close', 127);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.legs).toEqual([]);
      expect(r.escalated).toBe(true);
      expect(escalate).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('unparsed') }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT escalate when escalateAlarm reports the cooldown suppressed it', async () => {
    const { io: fakeIo, child, escalate } = io({ escalate: vi.fn(() => Promise.resolve(false)) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = runGuiE2eSurfaceScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.stdout.emit('data', Buffer.from('P004_TAURI_SURFACE_VERIFY_FAIL leg=gym\n'));
      child.emit('close', 1);
      const r = await p;
      expect(r.escalated).toBe(false);
      expect(escalate).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves ran:false with a reason on a spawn error (never throws)', async () => {
    const { io: fakeIo, child, escalate } = io();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = runGuiE2eSurfaceScheduledRun(fakeIo);
      await flushReadEnabledTick();
      child.emit('error', new Error('ENOENT: bash not found'));
      const r = await p;
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toMatch(/spawn error/);
      expect(r.skippedReason).toMatch(/ENOENT/);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to spawn'));
      expect(escalate).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('kills the child and resolves timedOut:true after the bound (fake timers)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { io: fakeIo, child, escalate } = io();
      const kill = vi.fn();
      (child as unknown as { kill: typeof kill }).kill = kill;
      const p = runGuiE2eSurfaceScheduledRun(fakeIo);
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1);
      const r = await p;
      expect(r.ran).toBe(true);
      expect(r.timedOut).toBe(true);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out after'));
      expect(escalate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
