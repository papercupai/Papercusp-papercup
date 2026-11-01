/**
 * Coverage for console-spawn.buildConsoleOneliner — the one-liner that the
 * spawned terminal runs as its first command. This is the mechanism behind
 * capability:terminal: the `greeting` is the caller's arbitrary command, and it
 * must (a) run in a subshell, (b) survive shell-quoting verbatim, then (c) hand
 * off to an interactive login shell so the window stays open.
 */
import { EventEmitter } from 'node:events';
// NOTE: 'node:child_process' is vi.mock'd below with the original module
// spread — only `spawn` is stubbed, so this execFileSync is the real one
// (used to prove one-liners parse/execute under actual bash).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import * as nodePty from '@lydell/node-pty';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { controlPlaneTempRoot } from './control-plane-temp.mjs';
import {
  buildConsoleOneliner,
  keepWindowOpenOnFailure,
  advSessionTitleTag,
  macConsoleInvocation,
  macHasGuiSession,
  spawnConsole,
  spawnHeadless,
  headlessLogPath,
  headlessNormalizedLogPath,
  wrapHeadlessSigtermDiagnostic,
  buildHeadlessSpawnCommand,
  buildConsoleScopedSpawnCommand,
  normalizeHeadlessAgentEnv,
  normalizeHeadlessAgentTerm,
  KICKOFF_PROOF_PATH_ENV,
  KICKOFF_PROOF_TOKEN_ENV,
  KICKOFF_PROOF_WINDOW_MS,
  _resetTerminalCacheForTests,
  pickLinuxTerminal,
  resolveTerminalPreference,
  findDisplayHonoringTerminal,
  _resetDisplayHonoringTerminalCacheForTests,
  type AppearanceOpts,
  type DesktopEnvProbes,
} from './console-spawn';
import type { ConsoleEnvelope } from './console-launcher';

const prepareProfileMock = vi.hoisted(() => vi.fn(async (terminal: { bin: string; args: string[] }) => terminal));
vi.mock('./gnome-terminal-profile.mjs', () => ({
  prepareGnomeTerminal: prepareProfileMock,
}));
import { consumeKickoffPromptFile, KICKOFF_PROMPT_FILE_ENV } from './agent-kickoff/prompt-transport.mjs';
import { isWindowsDesktopHost } from './windows-desktop-windows';
import { requestDesktopConsoleLaunch } from './console-launch-bridge';
import {
  headlessRoleMcpVerifyWorstCaseMs,
  publishKickoffProofReceipt,
} from '../../../apps/operator/scripts/psu-pty-host.mjs';

// WI-1882: make the WSL2/Windows-desktop signal deterministic on the Linux CI
// host (where process.platform is already 'linux'). console-spawn consumes only
// isWindowsDesktopHost from this module.
vi.mock('./windows-desktop-windows', () => ({ isWindowsDesktopHost: vi.fn(() => false) }));

// WI-3289: stub the desktop bridge so no sync-bus emit / PG connection happens.
vi.mock('./console-launch-bridge', () => ({ requestDesktopConsoleLaunch: vi.fn() }));

// WI-1886: mock the OS spawn so these tests NEVER open a real desktop window
// (the dev box HAS gnome-terminal + an X socket — an unmocked Linux-path call
// would now actually open one, since spawnConsole injects the desktop env).
const spawnMock = vi.fn();
const taskEnrolment = vi.hoisted(() => ({
  begin: vi.fn(() => ({ taskId: 'task1234', confined: false, scopeUnit: null })),
  complete: vi.fn(),
}));
const taskControl = vi.hoisted(() => ({
  kill: vi.fn(async () => ({ ok: true, taskId: 'task1234', action: 'kill' })),
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
}));
vi.mock('./task-manager/enroll-sync', () => ({
  beginSyncEnrolment: taskEnrolment.begin,
  completeSyncEnrolment: taskEnrolment.complete,
}));
vi.mock('./task-manager/control', () => ({ killTask: taskControl.kill }));

/** A fake detached terminal child: emit 'exit' to simulate an early death. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = () => {};
  return child;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

const APPEARANCE: AppearanceOpts = { mode: 'console', planSlug: null, label: null };

/** Decode the shell-escaped rcfile payload from buildConsoleOneliner. */
function interactiveRcScript(oneliner: string): string {
  const match = /--rcfile <\(printf '%s\\n' (.*)\) -i$/.exec(oneliner);
  expect(match).not.toBeNull();
  return execFileSync('bash', ['-c', `printf '%s' ${match![1]}`], { encoding: 'utf8' });
}

describe('raceWithTimeout cleanup', () => {
  it('clears the losing deadline when the operation resolves first', async () => {
    vi.useFakeTimers();
    try {
      await expect(raceWithTimeout(Promise.resolve('exited'), 3_000, () => new Error('timed out')))
        .resolves.toBe('exited');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// WI-3114: HERMETIC desktop-env probes. The stubbed DISPLAY=:99 alone is NOT
// deterministic — resolveLinuxDesktopEnv validates the display's X socket
// against the REAL /tmp/.X11-unix (WI-2840 stale-DISPLAY healing), so these
// tests passed or failed with the box's live X state (the 2026-07-05 /tmp wipe
// removed X99 → the healing console.warn → vitest-fail-on-console red-pinned
// the green gate). Every spawnConsole call that reaches the Linux desktop path
// must inject these so no real socket/cookie is ever consulted.
const FAKE_DESKTOP_PROBES: DesktopEnvProbes = {
  existsSync: () => true, // every socket/cookie the resolver checks "exists"
  readdirSync: () => ['X99'],
  uid: 1000,
  home: '/home/test',
};

describe('spawnConsole Windows-desktop (WSL2) defer — WI-1882', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReset();
    vi.mocked(requestDesktopConsoleLaunch).mockReset();
    spawnMock.mockReset();
    // Deterministic desktop env: the resolver short-circuits when DISPLAY is set.
    vi.stubEnv('DISPLAY', ':99');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns code:501 (defer to the Tauri console_launch) on a Windows desktop host, even though process.platform is "linux" inside WSL', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    const r = await spawnConsole({ envelope });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(501);
    expect(spawnMock).not.toHaveBeenCalled();
    // Without allowDesktopBridge the bridge must NOT be consulted — the 501 is
    // the renderer-fallback contract for the user "+" path (native-console.ts).
    expect(vi.mocked(requestDesktopConsoleLaunch)).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit to 501 on a real Linux desktop (isWindowsDesktopHost false)', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    // A child that dies instantly → the WI-1886 probe reports 502, not 501.
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    if (r.status === 'error') expect(r.code).not.toBe(501);
  });
});

// WI-3289: the agent-tool callers (capability:terminal, fleet:launch-on-plan)
// opt into the desktop bridge — a Windows host relays the envelope to the
// desktop shell's Tauri console_launch instead of hard-501ing the agent.
describe('spawnConsole Windows desktop-bridge — WI-3289', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --no-picker',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReset();
    vi.mocked(requestDesktopConsoleLaunch).mockReset();
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('allowDesktopBridge on a Windows desktop host relays via the bridge and returns ok (child:null)', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    vi.mocked(requestDesktopConsoleLaunch).mockResolvedValue({ ok: true, pid: 777, error: null });
    const r = await spawnConsole({
      envelope,
      allowDesktopBridge: true,
      label: 'lbl',
      planSlug: 'p1',
    });
    expect(vi.mocked(requestDesktopConsoleLaunch)).toHaveBeenCalledWith(
      expect.objectContaining({ envelope, label: 'lbl', planSlug: 'p1' }),
    );
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.terminal).toContain('desktop-bridge');
    expect(ok.pid).toBe(777);
    expect(ok.child).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled(); // never a Session-0 WSL spawn
  });

  it('surfaces a LOUD bridge failure (desktop shell closed / timeout) instead of ok-with-no-window', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    vi.mocked(requestDesktopConsoleLaunch).mockResolvedValue({
      ok: false,
      pid: null,
      error: 'no desktop shell answered the console-launch request within 30000ms',
    });
    const r = await spawnConsole({ envelope, allowDesktopBridge: true });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(502);
    expect(err.error).toMatch(/desktop-bridge launch failed/);
    expect(err.error).toMatch(/no desktop shell answered/);
  });

  it('allowDesktopBridge is a no-op on a real Linux desktop — the server-side spawn stays in charge', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({
      envelope,
      allowDesktopBridge: true,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
    });
    expect(vi.mocked(requestDesktopConsoleLaunch)).not.toHaveBeenCalled();
    if (r.status === 'error') expect(r.code).not.toBe(501);
  });
});

describe('spawnConsole early-exit probe — WI-1886(b)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
    // These tests mock `spawn`, so no real terminal ever runs — but spawnConsole
    // still calls findLinuxTerminal() first, which needs a terminal emulator on
    // PATH. On a headless host (packaged install / CI runner) there is none, so it
    // returned "no terminal emulator found" (500) before the mocked spawn was ever
    // reached. Point $TERMINAL at bash (always present; never actually executed
    // since spawn is mocked) and clear the resolver's memo so the stub takes effect.
    vi.stubEnv('TERMINAL', 'bash');
    _resetTerminalCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetTerminalCacheForTests();
  });

  it('a terminal client that dies nonzero inside the probe ⇒ LOUD error (no more ok+pid ghost windows)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(1111);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(502);
    expect(err.error).toMatch(/no window opened/i);
    expect(err.error).toMatch(/WI-1886/);
  });

  it('a client killed by a signal inside the probe ⇒ LOUD error', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(2222);
      queueMicrotask(() => child.emit('exit', null, 'SIGSEGV'));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('error');
    expect((r as { error: string }).error).toContain('SIGSEGV');
  });

  it('a client that outlives the probe ⇒ ok with its pid', async () => {
    spawnMock.mockImplementation(() => fakeChild(3333)); // never exits
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(3333);
  }, 10_000);

  it('forwards the prepared profile through the scoped terminal command', async () => {
    prepareProfileMock.mockImplementationOnce(async (terminal) => ({
      ...terminal, args: ['--profile=test-bounded', ...terminal.args],
    }));
    spawnMock.mockImplementation(() => fakeChild(3333));
    const result = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(result.status).toBe('ok');
    expect(spawnMock.mock.calls[0][1]).toContain('--profile=test-bounded');
  }, 10_000);
});

describe('spawnConsole boot receipt — the visible-path phantom-ok (EI-19330040718883562)', () => {
  // Same live shape as the spawnHeadless boot-receipt suite above: the window
  // survives EARLY_EXIT_PROBE_MS because buildConsoleOneliner unconditionally
  // `exec`s a login shell after the greeting — so a dead agent command never
  // shows up as a process exit, and the OLD code reported a phantom ok.
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --fleet=fed-drill',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  const AUTH_DEATH =
    '[papercusp] initial terminal command exited with status 1; terminal left open for inspection.\n';
  const TICK = (_ms: number) => new Promise<void>((r) => { setTimeout(r, 5); });

  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
    vi.stubEnv('TERMINAL', 'bash');
    _resetTerminalCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetTerminalCacheForTests();
  });

  it('verifyBootReceipt OMITTED (default): a client that outlives the probe ⇒ ok immediately, receipt never consulted', async () => {
    spawnMock.mockImplementation(() => fakeChild(7001)); // never exits
    // A bootProbes.readLog that WOULD report a failure — proving it is never
    // even called when verifyBootReceipt is not set, i.e. byte-identical to
    // the pre-fix behavior for every caller that didn't opt in.
    let readLogCalls = 0;
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      bootProbes: { readLog: () => { readLogCalls++; return AUTH_DEATH; }, sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('ok');
    expect(readLogCalls).toBe(0);
  }, 10_000);

  it('verifyBootReceipt:true + greeting-failure sentinel ⇒ error, even though the process is still alive', async () => {
    spawnMock.mockImplementation(() => fakeChild(7002)); // never exits — the live shape
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      verifyBootReceipt: true,
      bootProbes: { readLog: () => AUTH_DEATH, sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/died at boot \(exit 1\)/);
    expect((r as { error: string }).error).toMatch(/EI-19330040718883562/);
  }, 10_000);

  it('verifyBootReceipt:true + a healthy member (no sentinel) ⇒ ok — never manufacture a failure', async () => {
    spawnMock.mockImplementation(() => fakeChild(7003));
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      verifyBootReceipt: true,
      bootProbes: { readLog: () => '', sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(7003);
  }, 10_000);

  it('retains a private failed receipt and returns its addressable cause', async () => {
    spawnMock.mockImplementation(() => fakeChild(7005));
    let path = '';
    try {
      const r = await spawnConsole({
        envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES, verifyBootReceipt: true,
        bootProbes: {
          readLog: (receipt) => {
            path = receipt;
            writeFileSync(receipt, `PSU_ACTUAL_REFUSAL\n${AUTH_DEATH}`, { mode: 0o600 });
            return readFileSync(receipt, 'utf8');
          },
          sleep: TICK, windowMs: 60,
        },
      });
      expect(r.status).toBe('error');
      expect((r as { error: string }).error).toContain('PSU_ACTUAL_REFUSAL');
      expect((r as { error: string }).error).toContain(`boot receipt retained: ${path}`);
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/papercup-console-receipt-.*\.log$/);
    } finally {
      if (path) rmSync(path, { force: true });
    }
  }, 10_000);

  it('verifyBootReceipt:true — the sentinel appearing LATE (after the early-exit probe) is still caught', async () => {
    spawnMock.mockImplementation(() => fakeChild(7004));
    let reads = 0;
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      verifyBootReceipt: true,
      bootProbes: {
        readLog: () => (++reads < 4 ? '' : AUTH_DEATH),
        sleep: TICK,
        windowMs: 400,
      },
    });
    expect(r.status).toBe('error');
    expect(reads).toBeGreaterThan(3); // it kept watching past the first look
  }, 10_000);
});

describe('buildConsoleOneliner boot-receipt tee (EI-19330040718883562)', () => {
  it('captures the actual boot refusal before the sentinel, without changing the exit status', () => {
    const root = mkdtempSync(join(tmpdir(), 'console-boot-detail-'));
    const receipt = join(root, "quote's boot.log");
    try {
      // Delay the receipt consumer so nested process-substitution races cannot
      // hide behind a fast tail process. The footer must wait for this flush.
      const tail = join(root, 'tail');
      writeFileSync(tail, '#!/bin/bash\nsleep 0.1\nexec /usr/bin/tail "$@"\n');
      chmodSync(tail, 0o700);
      const script = interactiveRcScript(keepWindowOpenOnFailure(
        "printf 'PSU_REAL_BOOT_REFUSAL\\n' >&2; exit 2", { receiptPath: receipt },
      ));
      const result = spawnSync('bash', ['-c', script], {
        env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, SHELL: '/bin/true' },
        encoding: 'utf8', timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0); // the inspection shell still opens
      expect(result.stderr).toContain('PSU_REAL_BOOT_REFUSAL');
      const captured = readFileSync(receipt, 'utf8');
      expect(captured).toContain('PSU_REAL_BOOT_REFUSAL');
      expect(captured).toContain('exited with status 2');
      expect(captured.indexOf('PSU_REAL_BOOT_REFUSAL')).toBeLessThan(captured.indexOf('exited with status 2'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds verbose boot stderr and retains the late failure, rather than only its footer', () => {
    const root = mkdtempSync(join(tmpdir(), 'console-boot-tail-'));
    const receipt = join(root, 'boot.log');
    try {
      const script = interactiveRcScript(keepWindowOpenOnFailure(
        "printf '%25000s' '' >&2; printf '\\nLATE_BOOT_REFUSAL\\n' >&2; exit 2", { receiptPath: receipt },
      ));
      const result = spawnSync('bash', ['-c', script], {
        env: { ...process.env, SHELL: '/bin/true' }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      const captured = readFileSync(receipt, 'utf8');
      expect(Buffer.byteLength(captured)).toBeLessThan(17000);
      expect(captured).toContain('LATE_BOOT_REFUSAL');
      expect(captured).toContain('exited with status 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps greeting stdin/stdout on the real PTY while copying only its stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'console-boot-tty-'));
    const receipt = join(root, 'boot.log');
    let terminal: ReturnType<typeof nodePty.spawn> | undefined;
    try {
      const script = interactiveRcScript(keepWindowOpenOnFailure(
        '[ -t 0 ] && [ -t 1 ] || { echo TTY_LOST >&2; exit 3; }; ' +
        'printf "TTY_PRESERVED\\n"; printf "ACTUAL_REFUSAL\\n" >&2; exit 2',
        { receiptPath: receipt },
      ));
      let output = '';
      terminal = nodePty.spawn('bash', ['-c', script], {
        cwd: root, env: { ...process.env, SHELL: '/bin/true' }, name: 'xterm-256color',
      });
      terminal.onData((data) => { output += data; });
      const code = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('receipt PTY fixture did not exit')), 5000);
        terminal!.onExit((event) => { clearTimeout(timeout); resolve(event.exitCode); });
      });
      expect(code).toBe(0);
      expect(output).toContain('TTY_PRESERVED');
      expect(output).not.toContain('TTY_LOST');
      const captured = readFileSync(receipt, 'utf8');
      expect(captured).toContain('ACTUAL_REFUSAL');
      expect(captured).not.toContain('TTY_PRESERVED');
    } finally {
      try { terminal?.kill(); } catch { /* already exited */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omitting bootReceiptPath is byte-identical to the pre-fix banner', () => {
    const out = buildConsoleOneliner('/x', {}, 'false', APPEARANCE);
    expect(out).not.toContain('tee -a');
  });

  it('a supplied bootReceiptPath tees the failure banner into it, without changing the printed text', () => {
    const withReceipt = buildConsoleOneliner('/x', {}, 'false', APPEARANCE, '/tmp/receipt.log');
    const without = buildConsoleOneliner('/x', {}, 'false', APPEARANCE, null);
    const withReceiptScript = interactiveRcScript(withReceipt);
    const withoutScript = interactiveRcScript(without);
    expect(withReceiptScript).toContain("| tee -a '/tmp/receipt.log'");
    expect(withReceiptScript).toContain('initial terminal command exited with status %s');
    // The greeting now captures stderr, but the failure banner itself is unchanged.
    const banner = '__papercusp_greeting_rc=$?';
    expect(withReceiptScript.slice(withReceiptScript.indexOf(banner)).replace(" | tee -a '/tmp/receipt.log'", ''))
      .toBe(withoutScript.slice(withoutScript.indexOf(banner)));
  });
});

describe('spawnConsole terminal PID receipt (EI-21653040525457620)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'terminal-pid-sid',
  };

  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
    vi.stubEnv('TERMINAL', 'bash');
    _resetTerminalCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetTerminalCacheForTests();
  });

  it('writes the interactive shell PID from inside the terminal, not the emulator PID', () => {
    const out = buildConsoleOneliner(
      '/repo',
      {},
      'true',
      APPEARANCE,
      null,
      true,
      true,
      '/tmp/terminal-pid.receipt',
    );
    const script = interactiveRcScript(out);
    expect(script).toContain(`printf '%s\\n' "$$" > '/tmp/terminal-pid.receipt'`);
    expect(script).toContain('export PAPERCUSP_TERMINAL_PID="$$"');
  });

  it('returns the receipt PID separately while preserving the emulator PID', async () => {
    spawnMock.mockImplementation(() => fakeChild(7005));
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      captureTerminalPid: true,
      terminalPidProbes: {
        readReceipt: () => '7006\n',
        sleep: async () => {},
        windowMs: 60,
      },
    });

    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(7005);
    expect((r as { terminalPid: number | null }).terminalPid).toBe(7006);
  });

  it('returns null when the receipt is absent instead of reusing the emulator PID', async () => {
    spawnMock.mockImplementation(() => fakeChild(7007));
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      captureTerminalPid: true,
      terminalPidProbes: {
        readReceipt: () => '',
        sleep: async () => {},
        windowMs: 0,
      },
    });

    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(7007);
    expect((r as { terminalPid: number | null }).terminalPid).toBeNull();
  });
});

describe('headlessLogPath — per-session log filename (headless-fleet-launch P-002)', () => {
  it('slugifies the label + stamps pid/time under the given dir', () => {
    const p = headlessLogPath({ logDir: '/var/log/fleet', label: 'my-fleet · member 1/3 (plan)', pid: 42, nowMs: 1000 });
    expect(p.startsWith('/var/log/fleet/')).toBe(true);
    const base = p.slice('/var/log/fleet/'.length);
    // no whitespace or shell-meta survives into the filename
    expect(base).not.toMatch(/[\s·()]/);
    expect(base).toBe('my-fleet-member-1-3-plan-42-1000.log');
  });
  it('uses the control-plane runtime root when no log directory is given', () => {
    const p = headlessLogPath({ logDir: null, label: '···', pid: 1, nowMs: 2 });
    expect(p.startsWith(controlPlaneTempRoot('log') + sep)).toBe(true);
    expect(p).toMatch(/headless-1-2\.log$/);
  });
});

describe('headlessNormalizedLogPath — grep-safe companion filename', () => {
  it('keeps the companion beside the raw log without introducing another timestamp', () => {
    expect(headlessNormalizedLogPath('/tmp/fleet/member-42-1000.log')).toBe(
      '/tmp/fleet/member-42-1000.normalized.log',
    );
    expect(headlessNormalizedLogPath('/tmp/fleet/member-42-1000.raw')).toBe(
      '/tmp/fleet/member-42-1000.raw.normalized.log',
    );
  });

  it('returns an empty path for an empty input', () => {
    expect(headlessNormalizedLogPath('  ')).toBe('');
  });
});

describe('spawnHeadless — no-window managed-pty launch (headless-fleet-launch P-002)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --headless',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    // A fleet-launched test runner carries its own launcher provenance. Keep
    // this suite's "not supplied" cases independent of the invoking session.
    vi.stubEnv('PAPERCUSP_LAUNCHED_BY', undefined);
    spawnMock.mockReset();
    taskEnrolment.begin.mockClear();
    taskEnrolment.complete.mockClear();
    taskControl.kill.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the default kickoff-proof budget beyond the headless MCP verification worst case', () => {
    expect(KICKOFF_PROOF_WINDOW_MS).toBeGreaterThanOrEqual(headlessRoleMcpVerifyWorstCaseMs());
  });

  // No-systemd-run fallback path — pin hasSystemdRun:false so these don't flake
  // with whichever host/CI runner actually runs the suite (same class of bug
  // findLinuxTerminal's _resetTerminalCacheForTests exists for).
  const noSystemdRun = { spawnCommandProbes: { hasSystemdRun: () => false } };

  it('cancels before enrolment when the caller becomes stale during the install-boundary wait', async () => {
    let current = true;
    let releaseInstallWait!: () => void;
    const release = vi.fn();
    const beforeSpawn = vi.fn(() => current);
    spawnMock.mockImplementation(() => fakeChild());
    const result = spawnHeadless({
      envelope,
      beforeSpawn,
      installBoundary: async () => {
        await new Promise<void>((resolve) => { releaseInstallWait = resolve; });
        return { outcome: 'acquired', waitedMs: 1, release };
      },
      bootProbes: { windowMs: 0 },
      ...noSystemdRun,
    });

    await vi.waitFor(() => expect(releaseInstallWait).toBeTypeOf('function'));
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    current = false;
    releaseInstallWait();

    expect(await result).toMatchObject({ status: 'error', cancelled: true });
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(taskEnrolment.begin).not.toHaveBeenCalled();
    expect(taskEnrolment.complete).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(taskControl.kill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('launches a still-current caller after the install-boundary wait', async () => {
    let installReady = false;
    const release = vi.fn();
    const beforeSpawn = vi.fn(async () => installReady);
    spawnMock.mockImplementation(() => fakeChild());
    const result = await spawnHeadless({
      envelope,
      coordOwnerId: 'su-headless-owner',
      beforeSpawn,
      installBoundary: async () => {
        installReady = true;
        return { outcome: 'acquired', waitedMs: 1, release };
      },
      bootProbes: { windowMs: 0 },
      ...noSystemdRun,
    });

    expect(result.status).toBe('ok');
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      env: { PAPERCUSP_AGENT_TASK_ID: 'task1234' },
    });
    expect(taskEnrolment.complete).toHaveBeenCalledOnce();
    // The real lease is idempotent: boot completion and finally both release it.
    expect(release).toHaveBeenCalled();
  });

  it('records the exact work-item on the headless task-ledger enrollment', async () => {
    spawnMock.mockImplementation(() => fakeChild(7795));
    const workItemId = 'EI-26931290267778996';
    const result = await spawnHeadless({
      envelope,
      workItemId,
      bootProbes: { windowMs: 0 },
      ...noSystemdRun,
    });

    expect(result.status).toBe('ok');
    expect(taskEnrolment.complete).toHaveBeenCalledOnce();
    expect(taskEnrolment.complete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ class: 'agent-session', workItemId }),
      7795,
    );
  });

  it('establishes kickoff proof on the private runtime mount when scratch is unusable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kickoff-runtime-'));
    const runtime = join(root, 'runtime');
    const scratch = join(root, 'unusable-scratch');
    mkdirSync(runtime, { mode: 0o700 });
    writeFileSync(scratch, 'not a directory');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    vi.stubEnv('TMPDIR', scratch);
    spawnMock.mockImplementation(() => fakeChild(7794));
    let receiptPath = '';
    try {
      const result = await spawnHeadless({
        envelope,
        label: 'runtime-proof',
        logDir: join(root, 'logs'),
        kickoffProof: true,
        kickoffProofProbes: {
          windowMs: 0,
          readReceipt: (path, token) => {
            receiptPath = path;
            expect(path.startsWith(runtime + '/')).toBe(true);
            return JSON.stringify({ token, persisted: true, nativeRef: 'native:runtime', reason: null });
          },
        },
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });
      expect(result).toMatchObject({ status: 'ok', kickoffProof: { persisted: true } });
      expect(receiptPath).not.toBe('');
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans an idle task when the host proves the kickoff was never submitted', async () => {
    spawnMock.mockImplementation(() => fakeChild(7790));
    const r = await spawnHeadless({
      envelope,
      label: 'unsubmitted',
      kickoffProof: true,
      kickoffProofProbes: {
        windowMs: 0,
        readReceipt: (_path, token) => JSON.stringify({
          token,
          persisted: false,
          nativeRef: null,
          reason: 'kickoff-not-submitted:kickoff-marker-echo-unconfirmed',
        }),
      },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(taskControl.kill).toHaveBeenCalledWith('task1234');
    expect(r).toMatchObject({ status: 'error', code: 502 });
  });

  it('keeps an uncertain kickoff available for recovery', async () => {
    spawnMock.mockImplementation(() => fakeChild(7791));
    const r = await spawnHeadless({
      envelope,
      label: 'uncertain',
      kickoffProof: true,
      kickoffProofProbes: { windowMs: 0, readReceipt: () => '' },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(taskControl.kill).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'ok', kickoffProof: { persisted: false, reason: 'kickoff-proof-timeout' } });
    // The retained child owns the placeholder until its exit; do not leak it
    // from the fixture now that the parent's timeout correctly preserves it.
    (r as { child: EventEmitter }).child.emit('exit', 0, null);
    await (r as { childExit: Promise<unknown> }).childExit;
  });

  it.each([
    { label: 'refusal', event: 'exit', args: [1, null], diagnostic: 'exit 1' },
    { label: 'clean exit without proof', event: 'exit', args: [0, null], diagnostic: 'exit 0' },
    { label: 'signal', event: 'exit', args: [null, 'SIGTERM'], diagnostic: 'signal SIGTERM' },
    { label: 'spawn error', event: 'error', args: [new Error('launcher refused')], diagnostic: 'launcher refused' },
  ])('kickoff child exit: reports $label during proof polling rather than timeout', async ({ event, args, diagnostic }) => {
    const child = fakeChild(7795);
    spawnMock.mockImplementation(() => child);
    let reads = 0;
    let sleeps = 0;
    let receiptPath = '';
    const result = await spawnHeadless({
      envelope,
      label: 'terminal-kickoff',
      kickoffProof: true,
      kickoffProofProbes: {
        windowMs: 1000,
        pollMs: 250,
        readReceipt: (path) => { receiptPath = path; reads++; return ''; },
        sleep: async () => { sleeps++; child.emit(event, ...args); },
      },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(result).toMatchObject({ status: 'error', code: 502 });
    expect(result).toHaveProperty('error', expect.stringContaining(diagnostic));
    expect(result).toHaveProperty('logPath', expect.any(String));
    expect(reads).toBe(2);
    expect(sleeps).toBe(1);
    expect(existsSync(receiptPath)).toBe(false);
    expect(taskControl.kill).not.toHaveBeenCalled();
  });

  it('kickoff child exit: detects a child already ended after the early boot probe', async () => {
    const child = fakeChild(7796);
    spawnMock.mockImplementation(() => child);
    const result = await spawnHeadless({
      envelope,
      label: 'already-terminal-kickoff',
      kickoffProof: true,
      kickoffProofProbes: { windowMs: 0, readReceipt: () => '' },
      bootProbes: {
        readLog: () => { child.emit('exit', 1, null); return ''; },
        sleep: async () => {}, windowMs: 0,
      },
      ...noSystemdRun,
    });
    expect(result).toMatchObject({ status: 'error', code: 502 });
    expect(result).toHaveProperty('error', expect.stringContaining('exit 1'));
  });

  it.each([
    'tracked fork is unavailable for codex source; refusing untracked fork',
    'psu: --account auto could not be honored: inference gateway off / no pool',
  ])('kickoff child exit: retains the launcher refusal instead of a timeout: %s', async (refusal) => {
    const child = fakeChild(7798);
    spawnMock.mockImplementation(() => child);
    const logs = mkdtempSync(join(tmpdir(), 'kickoff-exit-log-'));
    try {
      const result = await spawnHeadless({
        envelope,
        label: 'refused-kickoff',
        logDir: logs,
        kickoffProof: true,
        kickoffProofProbes: {
          windowMs: 1000,
          readReceipt: () => '',
          sleep: () => {
            const log = readdirSync(logs).find((name) => name.endsWith('.log'))!;
            writeFileSync(join(logs, log), refusal);
            queueMicrotask(() => child.emit('exit', 1, null));
            return new Promise<void>(() => {});
          },
        },
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });
      expect(result).toMatchObject({ status: 'error', code: 502 });
      expect(result).toHaveProperty('error', expect.stringContaining(refusal));
      expect(readFileSync((result as { logPath: string }).logPath, 'utf8')).toBe(refusal);
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('kickoff child exit: preserves a valid native receipt when the child also exits', async () => {
    const child = fakeChild(7797);
    spawnMock.mockImplementation(() => child);
    const result = await spawnHeadless({
      envelope,
      label: 'proved-terminal-kickoff',
      kickoffProof: true,
      kickoffProofProbes: {
        windowMs: 0,
        readReceipt: (_path, token) => {
          child.emit('exit', 0, null);
          return JSON.stringify({ token, persisted: true, nativeRef: 'native:completed', reason: null });
        },
      },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(result).toMatchObject({
      status: 'ok', kickoffProof: { persisted: true, nativeRef: 'native:completed', reason: null },
    });
    expect(taskControl.kill).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'late proof', proof: { persisted: true, nativeRef: 'native:late', reason: null } },
    { label: 'late refusal', proof: { persisted: false, nativeRef: null, reason: 'kickoff-not-submitted:successor-reanchor-unconfirmed' } },
  ])('preserves the secure rendezvous for $label after the parent deadline', async ({ proof }) => {
    const child = fakeChild(7793);
    spawnMock.mockImplementation(() => child);
    let receiptPath = '';
    let receiptToken = '';
    try {
      const r = await spawnHeadless({
        envelope, label: 'late-kickoff', kickoffProof: true,
        kickoffProofProbes: {
          windowMs: 0,
          readReceipt: (path, token) => { receiptPath = path; receiptToken = token; return ''; },
        },
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });
      expect(r).toMatchObject({ status: 'ok', kickoffProof: { persisted: false, reason: 'kickoff-proof-timeout' } });
      expect(readFileSync(receiptPath, 'utf8')).toBe('');
      // Use the real host writer, including its same-UID/0600/no-symlink and
      // atomic-replacement checks, after the parent has returned uncertainty.
      expect(publishKickoffProofReceipt(proof, {
        [KICKOFF_PROOF_PATH_ENV]: receiptPath,
        [KICKOFF_PROOF_TOKEN_ENV]: receiptToken,
      })).toEqual({ published: true });
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ token: receiptToken, ...proof });
      expect(taskControl.kill).not.toHaveBeenCalled();
      child.emit('exit', 0, null);
      await (r as { childExit: Promise<unknown> }).childExit;
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      child.emit('exit', 0, null);
      if (receiptPath) rmSync(receiptPath, { force: true });
    }
  });

  it('retains the retired task and refusal when an unsubmitted kickoff is cleaned up', async () => {
    spawnMock.mockImplementation(() => fakeChild(7794));
    const result = await spawnHeadless({
      envelope,
      label: 'retired-kickoff',
      kickoffProof: true,
      kickoffProofProbes: {
        windowMs: 0,
        readReceipt: (_path, token) => JSON.stringify({
          token, persisted: false, nativeRef: null,
          reason: 'kickoff-not-submitted:role-mcp-unavailable',
        }),
      },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(taskControl.kill).toHaveBeenCalledWith('task1234');
    expect(result).toMatchObject({
      status: 'error', code: 502, taskId: 'task1234', logPath: expect.any(String),
      kickoffProof: { persisted: false, nativeRef: null, reason: 'kickoff-not-submitted:role-mcp-unavailable' },
    });
  });

  it('preserves a partial launch when cleanup of an unsubmitted kickoff fails', async () => {
    spawnMock.mockImplementation(() => fakeChild(7792));
    taskControl.kill.mockRejectedValueOnce(new Error('task store unavailable'));
    const r = await spawnHeadless({
      envelope,
      label: 'cleanup-failed',
      kickoffProof: true,
      kickoffProofProbes: {
        windowMs: 0,
        readReceipt: (_path, token) => JSON.stringify({
          token,
          persisted: false,
          nativeRef: null,
          reason: 'kickoff-not-submitted:kickoff-marker-echo-unconfirmed',
        }),
      },
      bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
      ...noSystemdRun,
    });
    expect(r).toMatchObject({
      status: 'ok',
      taskId: 'task1234',
      kickoffProof: { persisted: false, reason: 'kickoff-not-submitted:kickoff-marker-echo-unconfirmed' },
    });
  });

  it('writes the envelope MCP config into the headless cwd when opted in', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'papercup-headless-mcp-'));
    const mcpJsonContents = '{"mcpServers":{"papercusp":{"url":"http://127.0.0.1"}}}';
    spawnMock.mockImplementation(() => fakeChild(7776));

    try {
      const r = await spawnHeadless({
        envelope: { ...envelope, cwd, mcpJsonContents },
        label: 'hl',
        logDir: null,
        writeMcpJson: true,
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });

      expect(r.status).toBe('ok');
      expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe(mcpJsonContents);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  // EI-23765667869335651. A SIGNED door (role-launch-spec's signSpawnParams stamps
  // `sig=`) authenticates as exactly ONE agent. A superuser session supplies no
  // --mcp-config, so claude AUTO-DISCOVERS `<cwd>/.mcp.json` — a signed door left in
  // a shared checkout therefore becomes a second `papercusp` door on every su session
  // in that tree, answering as the ROLE. Post-compaction that returns the role's
  // control state (modes:[], loop inactive), which reads as "autonomy revoked".
  //
  // This is the SILENCE arm; the unsigned test above is the complementary WRITE arm,
  // so reverting the guard kills this test and an always-fire guard kills that one.
  it('does NOT write a signed single-agent MCP config into a shared cwd, but still launches', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'papercup-headless-signed-mcp-'));
    const signed = JSON.stringify({
      mcpServers: {
        papercusp: {
          type: 'http',
          url:
            'http://127.0.0.1:9071/api/mcp?harness=papercusp&role=judge&run=1-judge' +
            '&spawn=dffe6c9a-d34b-4e9d-bbb4-869208b1bb25' +
            '&client=role-352387e3-9bea-432a-ac8c-a89397cecf54&exp=0&sig=qa2yRLkb2_06_sBmZQHZ',
        },
      },
    });
    spawnMock.mockImplementation(() => fakeChild(7778));
    // The skip must be OBSERVABLE, never silent — assert the warning rather than
    // merely tolerating it (this suite is fail-on-console).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const r = await spawnHeadless({
        envelope: { ...envelope, cwd, mcpJsonContents: signed },
        label: 'hl',
        logDir: null,
        writeMcpJson: true,
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });

      // The leak is refused...
      expect(existsSync(join(cwd, '.mcp.json'))).toBe(false);
      // ...loudly...
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('refusing to write a signed single-agent .mcp.json'),
      );
      // ...and skipping is non-fatal: the role reaches its door via an explicit
      // --mcp-config <sessionMcpDir>/.mcp.json, so the cwd copy was redundant.
      expect(r.status).toBe('ok');
    } finally {
      warn.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  // WI-10005243: the write path went async (fs/promises). Pin the user-visible
  // contract it must keep: an existing user .mcp.json is moved to the one-shot
  // backup, a READ-ONLY stale .mcp.json is still replaced (rename needs only the
  // directory's write bit), and no temp file is left behind.
  it('backs up the user .mcp.json once, replaces a read-only one, and leaves no temp file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'papercup-headless-mcp-bak-'));
    const mcpJsonContents = '{"mcpServers":{"papercusp":{"url":"http://127.0.0.1"}}}';
    spawnMock.mockImplementation(() => fakeChild(7779));
    const run = () =>
      spawnHeadless({
        envelope: { ...envelope, cwd, mcpJsonContents },
        label: 'hl',
        logDir: null,
        writeMcpJson: true,
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        ...noSystemdRun,
      });

    try {
      writeFileSync(join(cwd, '.mcp.json'), '{"user":true}');
      expect((await run()).status).toBe('ok');
      expect(readFileSync(join(cwd, '.mcp.json.papercusp.bak'), 'utf8')).toBe('{"user":true}');
      expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe(mcpJsonContents);

      // Second launch: the backup already exists, so the stale file is NOT moved
      // aside. Make it read-only to reproduce the 2026-07-11 EACCES regression.
      chmodSync(join(cwd, '.mcp.json'), 0o444);
      expect((await run()).status).toBe('ok');
      expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe(mcpJsonContents);
      expect(readFileSync(join(cwd, '.mcp.json.papercusp.bak'), 'utf8')).toBe('{"user":true}');

      expect(readdirSync(cwd).filter((f) => f.startsWith('.mcp.json.tmp-'))).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  // WI-10005227 / WI-10005243 recurrence guard: spawnConsole/spawnHeadless run on
  // the operator's and bg-host's event loop, and a sync rename over an existing
  // .mcp.json blocked bg-host's main thread 22-156 ms (ext4 flushes the replaced
  // file's data at rename). The .mcp.json writer must stay on fs/promises.
  it('keeps the .mcp.json writer off the event loop (no *Sync fs calls)', () => {
    const src = readFileSync(join(__dirname, 'console-spawn.ts'), 'utf8');
    const start = src.indexOf('async function writeMcpJsonFile(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    // Strip comments first: the function's own rationale mentions
    // `writeFileSync(mcpPath, …)` as history, and must not trip the guard.
    const code = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // The slice must contain the write it guards, or the guard passes vacuously.
    expect(code).toMatch(/\bawait fsp\.rename\(tmp, mcpPath\)/);
    expect(code).toMatch(/\bawait fsp\.writeFile\(tmp, /);
    expect(code).not.toMatch(/\b\w+Sync\(/);
  });

  it('falls back to bash -lc (no terminal emulator, no systemd-run) detached with a log fd, and reports ok+pid when the session outlives the probe', async () => {
    spawnMock.mockImplementation(() => fakeChild(7777)); // never exits = a live agent
    const r = await spawnHeadless({ envelope, label: 'hl', logDir: null, ...noSystemdRun });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(7777);
    expect((r as { taskId?: string }).taskId).toMatch(/^[0-9a-z]{4,64}$/);
    expect((r as { logPath?: string }).logPath).toMatch(/hl-.*\.log$/);
    expect((r as { normalizedLogPath?: string }).normalizedLogPath).toBe(
      headlessNormalizedLogPath((r as { logPath: string }).logPath),
    );
    // the spawned program is bash -lc <oneliner>, NOT a terminal emulator
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('bash');
    expect(args[0]).toBe('-lc');
    expect(args[1]).toContain('psu --headless');
    expect(args[1]).toContain('export PAPERCUSP_PSU_HEADLESS_NORMALIZED_LOG=');
    expect(args[1]).toContain((r as { normalizedLogPath: string }).normalizedLogPath);
  }, 10_000);

  it('forwards a known launcher into the pty host environment without inventing one', async () => {
    spawnMock.mockImplementation(() => fakeChild(7780));
    // Two production boot windows require at least 14.4 seconds, exceeding
    // this test's 10-second budget. This fixture checks environment provenance;
    // the separate boot-receipt suite exercises the actual polling windows.
    const bootProbes = { readLog: () => '', sleep: async () => {}, windowMs: 0 };
    await spawnHeadless({
      envelope,
      label: 'launched',
      launchedBy: '  su-launching-agent  ',
      bootProbes,
      ...noSystemdRun,
    });
    let [, , options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string | undefined> },
    ];
    expect(options.env?.PAPERCUSP_LAUNCHED_BY).toBe('su-launching-agent');

    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild(7781));
    await spawnHeadless({ envelope, label: 'unmarked', bootProbes, ...noSystemdRun });
    [, , options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string | undefined> },
    ];
    expect(options.env?.PAPERCUSP_LAUNCHED_BY).toBeUndefined();
  }, 10_000);

  it('passes the kickoff proof token through the child environment without putting it in argv', async () => {
    const routes = [
      { label: 'direct-bash', expectedBin: 'bash', spawnCommandProbes: { hasSystemdRun: () => false } },
      {
        label: 'systemd-run',
        expectedBin: 'systemd-run',
        spawnCommandProbes: { platform: 'linux' as const, hasSystemdRun: () => true },
      },
    ];
    for (const [index, route] of routes.entries()) {
      spawnMock.mockReset();
      spawnMock.mockImplementation(() => fakeChild(7781 + index));
      await spawnHeadless({
        envelope,
        label: route.label,
        kickoffProof: true,
        kickoffProofProbes: { windowMs: 0, readReceipt: () => '' },
        bootProbes: { readLog: () => '', sleep: async () => {}, windowMs: 0 },
        spawnCommandProbes: route.spawnCommandProbes,
      });

      const [bin, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env?: Record<string, string | undefined> },
      ];
      const token = options.env?.[KICKOFF_PROOF_TOKEN_ENV];
      const argv = [bin, ...args].join('\0');
      expect(bin).toBe(route.expectedBin);
      expect(typeof token === 'string' && /^[a-f0-9]{48}$/i.test(token)).toBe(true);
      expect(typeof token === 'string' && argv.includes(token)).toBe(false);
      expect(argv.includes(KICKOFF_PROOF_TOKEN_ENV)).toBe(false);
    }
  }, 10_000);

  it('stamps a known trimmed coord owner only into the agent-session ledger detail', async () => {
    spawnMock.mockImplementation(() => fakeChild(7788));
    await spawnHeadless({
      envelope,
      label: 'hl',
      logDir: null,
      coordOwnerId: '  su-known-owner  ',
      ...noSystemdRun,
    });

    expect(taskEnrolment.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        class: 'agent-session',
        detail: { headless: true, label: 'hl', coordOwnerId: 'su-known-owner' },
      }),
      7788,
    );
  }, 10_000);

  it('a psu that dies at boot inside the probe ⇒ LOUD error (not a false ok+pid)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(8888);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnHeadless({ envelope, label: 'hl', logDir: null, ...noSystemdRun });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/died at boot/i);
  });

  it('keeps a large kickoff out of both headless shell argv and inherited env', async () => {
    vi.stubEnv('PAPERCUSP_KICKOFF_PROMPT', 'parent recovery note must never be inherited');
    spawnMock.mockImplementation(() => fakeChild(7789));
    const prompt = 'Full independent review — preserve every condition.\n'.repeat(6000);
    try {
      const result = await spawnHeadless({
        envelope: { ...envelope, env: { ...envelope.env, PAPERCUSP_KICKOFF_PROMPT: prompt } },
        label: 'large-kickoff',
        logDir: null,
        ...noSystemdRun,
      });
      expect(result.status).toBe('ok');
      const [, argv, options] = spawnMock.mock.calls[0];
      expect(argv.every((arg: string) => Buffer.byteLength(arg) < 32 * 1024)).toBe(true);
      expect(options.env.PAPERCUSP_KICKOFF_PROMPT).toBeUndefined();
      expect(argv.join(' ')).not.toContain('Full independent review');
      expect(consumeKickoffPromptFile(options.env[KICKOFF_PROMPT_FILE_ENV])).toBe(prompt);
    } finally { vi.unstubAllEnvs(); }
  }, 10_000);

  it('EI-9748: installs a TERM trap ahead of the greeting so a cgroup-restart kill logs a diagnostic instead of dying silently', async () => {
    spawnMock.mockImplementation(() => fakeChild(7778));
    await spawnHeadless({ envelope, label: 'hl', logDir: null, ...noSystemdRun });
    const oneliner = spawnMock.mock.calls[0][1][1] as string;
    expect(oneliner).toMatch(/^trap '.*' TERM;/);
    expect(oneliner).toContain('EI-9748');
    expect(oneliner).toContain('exit 143');
    // still runs the real greeting after the trap is installed
    expect(oneliner).toContain('psu --headless');
    // Headless members have no desktop window or native .mcp.json watcher;
    // they must not leave a per-process marker in the launch cwd.
    expect(oneliner).not.toContain('.papercup-console-active');
  }, 30_000);

  it('EI-9748 Route (A): when systemd-run is available on Linux, spawns via systemd-run --user --scope instead of plain bash — the cgroup escape', async () => {
    spawnMock.mockImplementation(() => fakeChild(7779));
    const r = await spawnHeadless({
      envelope,
      label: 'hl',
      logDir: null,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => true },
    });
    expect(r.status).toBe('ok');
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('systemd-run');
    expect(args).toEqual(
      expect.arrayContaining([
        '--user',
        '--scope',
        '--collect',
        '--property=CollectMode=inactive-or-failed',
        '--quiet',
        'bash',
        '-lc',
      ]),
    );
    expect(args.some((a: string) => /^--unit=papercup-headless-hl-/.test(a))).toBe(true);
    // the actual oneliner (with the EI-9748 TERM trap) still travels as the
    // final argv element, unmodified by the systemd-run wrapping
    const oneliner = args[args.length - 1] as string;
    expect(oneliner).toMatch(/^trap '.*' TERM;/);
    expect(oneliner).toContain('psu --headless');
  }, 10_000);

  it('EI-9748 Route (A): falls back to plain bash on a platform/host without systemd-run (e.g. macOS)', async () => {
    spawnMock.mockImplementation(() => fakeChild(7780));
    const r = await spawnHeadless({
      envelope,
      label: 'hl',
      logDir: null,
      spawnCommandProbes: { platform: 'darwin', hasSystemdRun: () => true }, // even if somehow true, platform gates it
    });
    expect(r.status).toBe('ok');
    const [bin] = spawnMock.mock.calls[0];
    expect(bin).toBe('bash');
  }, 10_000);

  // WI-10003189: on a hosted workspace host `systemd-run` is installed but there is no
  // user manager, so the task manager's live scope probe fails and enrolment reports
  // `no-scope-support`. Wrapping the member in `systemd-run --user --scope` anyway made
  // every New Session die at boot with "Failed to connect to bus: No medium found".
  it('WI-10003189: launches plain bash when the live scope probe has already failed (no-scope-support), even with systemd-run on PATH', async () => {
    taskEnrolment.begin.mockReturnValueOnce({
      taskId: 'task1234',
      confined: false,
      scopeUnit: null,
      unconfinedReason: 'no-scope-support',
    } as ReturnType<typeof taskEnrolment.begin>);
    spawnMock.mockImplementation(() => fakeChild(7781));
    const r = await spawnHeadless({
      envelope,
      label: 'hl',
      logDir: null,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => true },
    });
    expect(r.status).toBe('ok');
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('bash');
    expect(args[0]).toBe('-lc');
    expect(args).not.toContain('--user');
  }, 10_000);

  it('WI-10003189 control: a PENDING probe keeps the EI-9748 cgroup escape — only a failed probe drops it', async () => {
    taskEnrolment.begin.mockReturnValueOnce({
      taskId: 'task1234',
      confined: false,
      scopeUnit: null,
      unconfinedReason: 'probe-pending',
    } as ReturnType<typeof taskEnrolment.begin>);
    spawnMock.mockImplementation(() => fakeChild(7782));
    const r = await spawnHeadless({
      envelope,
      label: 'hl',
      logDir: null,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => true },
    });
    expect(r.status).toBe('ok');
    const [bin] = spawnMock.mock.calls[0];
    expect(bin).toBe('systemd-run');
  }, 10_000);
});

describe('buildHeadlessSpawnCommand — default probe requires a reachable USER manager, not just systemd-run on PATH (WI-10003189)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not wrap in systemd-run --user when neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set (a system-service operator)', () => {
    // The exact environment of the hosted operator on avi-test r50. No hasSystemdRun
    // injected: this exercises the DEFAULT probe, which is what production uses.
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    const { bin, args, scopeUnit } = buildHeadlessSpawnCommand('exec psu --headless', 'hl', { platform: 'linux' });
    expect(bin).toBe('bash');
    expect(args).toEqual(['-lc', 'exec psu --headless']);
    expect(scopeUnit).toBeNull();
  });

  it('the visible-console builder shares the same default probe', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    const { bin } = buildConsoleScopedSpawnCommand('xterm', ['-e', 'bash'], 'hl', { platform: 'linux' });
    expect(bin).toBe('xterm');
  });
});

describe('normalizeHeadlessAgentEnv — interactive CLI TERM contract', () => {
  it('replaces inherited TERM=dumb with a supported terminal type', () => {
    expect(normalizeHeadlessAgentEnv({ TERM: 'dumb', TMUX: '/tmp/operator-pane' })).toMatchObject({
      TERM: 'xterm-256color',
    });
    expect(normalizeHeadlessAgentEnv({ TERM: 'dumb', TMUX: '/tmp/operator-pane' })).not.toHaveProperty('TMUX');
  });

  it('supplies TERM when the headless service environment omitted it', () => {
    expect(normalizeHeadlessAgentEnv({}).TERM).toBe('xterm-256color');
  });

  it('preserves a supported TERM while still scrubbing terminal-context markers', () => {
    expect(normalizeHeadlessAgentEnv({ TERM: 'screen-256color', ZELLIJ: 'session' })).toEqual({
      TERM: 'screen-256color',
    });
  });

  it('normalizes an already-scrubbed environment without reintroducing context markers', () => {
    expect(normalizeHeadlessAgentTerm({ TERM: 'dumb' })).toEqual({ TERM: 'xterm-256color' });
  });
});

describe('buildHeadlessSpawnCommand (EI-9748 Route A — cgroup escape)', () => {
  it('picks systemd-run --user --scope --collect on Linux with systemd-run available', () => {
    const { bin, args } = buildHeadlessSpawnCommand('exec claude', 'my label', {
      platform: 'linux',
      hasSystemdRun: () => true,
    });
    expect(bin).toBe('systemd-run');
    expect(args.slice(0, 5)).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--property=CollectMode=inactive-or-failed',
      '--quiet',
    ]);
    expect(args.some((a) => /^--unit=papercup-headless-my-label-/.test(a))).toBe(true);
    expect(args).toContain('--property=MemoryMax=6442450944');
    expect(args).not.toContain('--property=MemorySwapMax=0');
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'exec claude']);
  });

  it('sanitizes the label into a safe systemd unit-name fragment', () => {
    const { args } = buildHeadlessSpawnCommand('x', 'fleet · member 1/3 (plan!)', {
      platform: 'linux',
      hasSystemdRun: () => true,
    });
    const unitArg = args.find((a) => a.startsWith('--unit='))!;
    expect(unitArg).toMatch(/^--unit=papercup-headless-[A-Za-z0-9._-]+$/);
  });

  it('falls back to plain bash -lc when systemd-run is unavailable', () => {
    const { bin, args } = buildHeadlessSpawnCommand('exec claude', 'hl', {
      platform: 'linux',
      hasSystemdRun: () => false,
    });
    expect(bin).toBe('bash');
    expect(args).toEqual(['-lc', 'exec claude']);
  });

  it('falls back to plain bash -lc on a non-Linux platform even if hasSystemdRun somehow returns true', () => {
    const { bin, args } = buildHeadlessSpawnCommand('exec claude', 'hl', {
      platform: 'darwin',
      hasSystemdRun: () => true,
    });
    expect(bin).toBe('bash');
    expect(args).toEqual(['-lc', 'exec claude']);
  });
});

describe('buildHeadlessSpawnCommand — the scope is never created outside our slice (EI-19366263067183489)', () => {
  // WHAT WENT WRONG. `--slice` used to be emitted only when `taskScope` was non-null, so the
  // un-enrolled fallback still created a REAL systemd scope holding a real agent subtree —
  // in `app.slice`, with no ledger row. Untracked AND unreapable simultaneously: nothing knew
  // it existed, and nothing could sweep it. 90 such scopes accumulated over 16 days (422
  // processes, 20.9 GB, ~29 cores). These tests exist so that combination cannot come back.

  const OWNED = /^--slice=papercusp(-[a-z0-9-]+)?\.slice$/;

  it('emits a slice for the UN-ENROLLED fallback, not just the enrolled path', () => {
    const { bin, args } = buildHeadlessSpawnCommand('exec claude', 'hl', {
      platform: 'linux',
      hasSystemdRun: () => true,
    }); // taskScope omitted => the un-enrolled fallback, the exact path that leaked
    expect(bin).toBe('systemd-run');
    const slice = args.find((a) => a.startsWith('--slice='));
    expect(slice).toBeDefined();
    // It must land somewhere `isOwnedCgroupPath` recognizes. `papercusp-agent-session.slice`
    // nests under `papercusp.slice` by systemd's dash-hierarchy rule, so a slice-level sweep
    // reaches it even with no ledger row to look it up by.
    expect(slice).toMatch(OWNED);
  });

  it('still honours the caller-supplied slice when enrolment DID succeed', () => {
    // CONTROL for the test above: if the fallback were the only path emitting a slice, or if
    // a hardcoded slice had replaced the caller's, that bug would pass the first assertion
    // and fail here.
    const { args } = buildHeadlessSpawnCommand(
      'exec claude',
      'hl',
      { platform: 'linux', hasSystemdRun: () => true },
      { unit: 'pc-task-abc.scope', slice: 'papercusp-agent-session.slice' },
    );
    expect(args).toContain('--slice=papercusp-agent-session.slice');
    expect(args).toContain('--unit=pc-task-abc.scope');
  });

  it('STRUCTURAL: every input that produces a scope produces a slice', () => {
    // The recurrence guard. Asserting the two cases above by hand would not stop a THIRD
    // branch being added later that forgets the slice again — which is exactly how this
    // regressed the first time (the enrolled path was added, the null path left behind).
    // So enumerate: whatever the taskScope, if we chose systemd-run we must have a slice.
    const scopes = [
      undefined,
      null,
      { unit: 'pc-task-1.scope', slice: 'papercusp-agent-session.slice' },
      { unit: 'pc-task-2.scope', slice: 'papercusp.slice' },
    ];
    for (const taskScope of scopes) {
      const { bin, args } = buildHeadlessSpawnCommand(
        'exec claude',
        'hl',
        { platform: 'linux', hasSystemdRun: () => true },
        taskScope,
      );
      expect(bin).toBe('systemd-run');
      const slices = args.filter((a) => a.startsWith('--slice='));
      // Exactly one — a duplicated flag would let systemd pick and make the effective
      // placement depend on argv order.
      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatch(OWNED);
      expect(args.some((a) => a.startsWith('--unit='))).toBe(true);
    }
  });

  it('adds no slice on the non-systemd fallback, where there is no scope to place', () => {
    // The guard above must not be read as "always pass --slice": with no systemd there is no
    // scope at all, and a --slice on a plain `bash -lc` would be a broken argv.
    for (const probes of [
      { platform: 'linux' as const, hasSystemdRun: () => false },
      { platform: 'darwin' as const, hasSystemdRun: () => true },
    ]) {
      const { bin, args } = buildHeadlessSpawnCommand('exec claude', 'hl', probes);
      expect(bin).toBe('bash');
      expect(args.some((a) => a.startsWith('--slice='))).toBe(false);
    }
  });
});

describe('buildHeadlessSpawnCommand — the scope NAME is returned, so the ledger row can join on it (EI-19366263067183489)', () => {
  // SIBLING of the slice guard above, and the other half of the same defect.
  //
  // The slice fix made the un-enrolled fallback scope REAPABLE (it lands inside
  // `papercusp.slice`, so a slice-level sweep reaches it). It did not make it FINDABLE.
  // `spawnHeadless` ledgers the unconfined path on purpose — `managed-spawn.ts` states the
  // intent as "run UNCONFINED but still ledgered" — but it recorded
  // `scopeUnit: taskScope?.unit ?? null`, i.e. NULL, while this builder had just put the
  // process into a real named scope. The ledger said "no scope"; the kernel said "scope
  // papercup-headless-X". Nothing could join the two, so the row never matched its process
  // and the reconciler classified it `unaccounted` forever.
  //
  // The root of it: the name was computed inside the builder and discarded inside the
  // builder. The caller could not record what it was never told.

  it('returns the unit name it used on the UN-ENROLLED fallback', () => {
    const { bin, args, scopeUnit } = buildHeadlessSpawnCommand('exec claude', 'hl', {
      platform: 'linux',
      hasSystemdRun: () => true,
    }); // taskScope omitted => the fallback, the path whose name used to be unrecoverable
    expect(bin).toBe('systemd-run');
    expect(scopeUnit).toBeTruthy();
    expect(scopeUnit).toMatch(/^papercup-headless-/);
    // The returned name must be THE name in argv — a plausible-looking but different string
    // would re-create the same unjoinable row while passing a weaker assertion.
    expect(args).toContain(`--unit=${scopeUnit}`);
  });

  it('returns the caller-supplied unit when enrolment DID succeed', () => {
    const { scopeUnit, args } = buildHeadlessSpawnCommand(
      'exec claude',
      'hl',
      { platform: 'linux', hasSystemdRun: () => true },
      { unit: 'pc-task-abc.scope', slice: 'papercusp-agent-session.slice' },
    );
    expect(scopeUnit).toBe('pc-task-abc.scope');
    expect(args).toContain('--unit=pc-task-abc.scope');
  });

  it('returns null where there is genuinely no scope (no systemd-run)', () => {
    // null must mean "no scope exists", never "a scope exists and we forgot its name" —
    // that conflation is the original bug, and it is why this asserts the bin too.
    for (const probes of [
      { platform: 'linux' as const, hasSystemdRun: () => false },
      { platform: 'darwin' as const, hasSystemdRun: () => true },
    ]) {
      const { bin, scopeUnit } = buildHeadlessSpawnCommand('exec claude', 'hl', probes);
      expect(bin).toBe('bash');
      expect(scopeUnit).toBeNull();
    }
  });

  it('STRUCTURAL: a returned scopeUnit and the --unit= argv can never disagree', () => {
    // The recurrence guard, matching the slice block's structural test. Enumerate every
    // taskScope shape: if we chose systemd-run there is a scope, so scopeUnit must be
    // non-null AND must be exactly what argv asks systemd for. A future branch that adds a
    // third code path and forgets to surface its name fails here rather than silently
    // writing another unjoinable ledger row.
    const scopes = [
      undefined,
      null,
      { unit: 'pc-task-1.scope', slice: 'papercusp-agent-session.slice' },
      { unit: 'pc-task-2.scope', slice: 'papercusp.slice' },
    ];
    for (const taskScope of scopes) {
      const { bin, args, scopeUnit } = buildHeadlessSpawnCommand(
        'exec claude',
        'hl',
        { platform: 'linux', hasSystemdRun: () => true },
        taskScope,
      );
      expect(bin).toBe('systemd-run');
      expect(scopeUnit).toBeTruthy();
      const unitArgs = args.filter((a) => a.startsWith('--unit='));
      expect(unitArgs).toHaveLength(1);
      expect(unitArgs[0]).toBe(`--unit=${scopeUnit}`);
    }
  });
});

describe('buildConsoleScopedSpawnCommand (WI-37476, EI-9748 Route B — cgroup escape for VISIBLE terminals)', () => {
  it('wraps the terminal emulator in systemd-run --user --scope --collect on Linux with systemd-run available', () => {
    const { bin, args } = buildConsoleScopedSpawnCommand(
      'gnome-terminal',
      ['--wait', '--window', '--', 'bash', '-lc', 'exec claude'],
      'my label',
      { platform: 'linux', hasSystemdRun: () => true },
    );
    expect(bin).toBe('systemd-run');
    expect(args.slice(0, 5)).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--property=CollectMode=inactive-or-failed',
      '--quiet',
    ]);
    expect(args.some((a) => /^--unit=papercup-console-my-label-/.test(a))).toBe(true);
    expect(args.some((a) => a.startsWith('--slice='))).toBe(true);
    // the wrapped command is preserved verbatim, in order, after the `--` separator
    expect(args.slice(-7)).toEqual([
      'gnome-terminal',
      '--wait',
      '--window',
      '--',
      'bash',
      '-lc',
      'exec claude',
    ]);
  });

  it('falls back to the plain terminal bin+args, byte-identical, when systemd-run is unavailable', () => {
    const { bin, args, scopeUnit } = buildConsoleScopedSpawnCommand('xterm', ['-e', 'bash'], 'hl', {
      platform: 'linux',
      hasSystemdRun: () => false,
    });
    expect(bin).toBe('xterm');
    expect(args).toEqual(['-e', 'bash']);
    expect(scopeUnit).toBeNull();
  });

  it('falls back on a non-Linux platform even if hasSystemdRun somehow returns true', () => {
    const { bin, args } = buildConsoleScopedSpawnCommand('xterm', ['-e'], 'hl', {
      platform: 'darwin',
      hasSystemdRun: () => true,
    });
    expect(bin).toBe('xterm');
    expect(args).toEqual(['-e']);
  });

  it('lands in the owned papercusp slice, never task-manager-enrolled (always the un-enrolled fallback naming)', () => {
    // Two independent calls must not collide on the same unit name/pid+time
    // sensitivity, and both must carry a papercusp-owned slice — the same
    // recurrence guard buildHeadlessSpawnCommand's sibling tests assert, ported
    // here since this caller always takes the un-enrolled (taskScope: null) path.
    const a = buildConsoleScopedSpawnCommand('xterm', ['-e'], 'hl', {
      platform: 'linux',
      hasSystemdRun: () => true,
    });
    const slice = a.args.find((x) => x.startsWith('--slice='));
    expect(slice).toMatch(/^--slice=papercusp(-[a-z0-9-]+)?\.slice$/);
    expect(a.scopeUnit).toMatch(/^papercup-console-/);
  });
});

describe('spawnConsole — the VISIBLE-terminal window escapes the operator cgroup too (WI-37476, EI-9748 Route B)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
    vi.stubEnv('TERMINAL', 'bash'); // see WI-1886(b) block above for why
    _resetTerminalCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetTerminalCacheForTests();
  });

  it('spawns via systemd-run --user --scope, not the plain terminal binary, when systemd-run is available', async () => {
    spawnMock.mockImplementation(() => fakeChild(4444)); // outlives the probe
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => true },
    });
    expect(r.status).toBe('ok');
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('systemd-run');
    expect(args).toContain('bash'); // the stubbed $TERMINAL, still present after `--`
    // the reported `terminal` field still names the real emulator, not the wrapper —
    // callers care what window opened, not the escape mechanism.
    expect((r as { terminal: string }).terminal).toBe('bash');
  }, 10_000);

  it('is byte-identical to the pre-fix plain spawn when systemd-run is unavailable', async () => {
    spawnMock.mockImplementation(() => fakeChild(5555));
    const r = await spawnConsole({
      envelope,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
    });
    expect(r.status).toBe('ok');
    const [bin] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('bash'); // the stubbed $TERMINAL binary itself, unwrapped
  }, 10_000);
});

describe('wrapHeadlessSigtermDiagnostic (EI-9748)', () => {
  it('prepends a TERM trap that logs + exits 143, then runs the original oneliner unmodified', () => {
    const out = wrapHeadlessSigtermDiagnostic("cd '/proj' ; (eval 'psu --headless')");
    expect(out.startsWith("trap '")).toBe(true);
    expect(out).toContain(" TERM; cd '/proj' ; (eval 'psu --headless')");
    expect(out).toContain('EI-9748');
    expect(out).toContain("exit 143");
  });

  it('the trap body is syntactically balanced (single-quoted, no unescaped internal single-quotes)', () => {
    const out = wrapHeadlessSigtermDiagnostic('exec claude');
    // trap '...' TERM — everything between the first and the matching closing
    // "' TERM" must not itself contain a bare unescaped single-quote, or bash
    // would parse it as a premature close.
    const m = /^trap '(.*)' TERM;/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/(?<!\\)'/);
  });
});

describe('buildConsoleOneliner', () => {
  it('cds, starts an interactive supervisor, evals the greeting, then execs a login shell', () => {
    const out = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    const script = interactiveRcScript(out);
    expect(out).toContain("cd '/proj'");
    expect(out).toContain("exec bash --noprofile --rcfile <(printf '%s\\n'");
    expect(script).toContain("(eval 'npm run dev'); __papercusp_greeting_rc=$?");
    expect(script).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  it('always drops to the shell after the greeting and prints a failure banner for non-zero greetings', () => {
    const out = buildConsoleOneliner('/x', {}, 'false', APPEARANCE);
    const script = interactiveRcScript(out);
    // The post-greeting separator must be ';' so exit-non-zero
    // does not short-circuit the interactive shell (matches native_console.rs).
    expect(script).toContain('); __papercusp_greeting_rc=$?');
    expect(script).toContain('initial terminal command exited with status %s');
    expect(script).toContain('; exec "${SHELL:-/bin/bash}" -l');
    expect(script).not.toContain(') && exec');
  });

  it('drops the sentinel + EXIT trap so the desktop side can detect shell exit', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', APPEARANCE);
    const script = interactiveRcScript(out);
    expect(script).toContain('touch .papercup-console-active.$$');
    expect(script).toContain("trap 'rm -f .papercup-console-active.$$' EXIT");
  });

  it('stamps a shell birth identity before the greeting for orphan-window cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercup-console-identity-'));
    try {
      const out = buildConsoleOneliner(
        dir,
        { SHELL: '/bin/true' },
        `printf '%s' "$PAPERCUSP_CONSOLE_IDENTITY" > identity.txt`,
        APPEARANCE,
      );
      expect(out).toContain('export PAPERCUSP_CONSOLE_IDENTITY');
      expect(out).toContain('/proc/sys/kernel/random/boot_id');

      execFileSync('bash', ['-c', out], { stdio: 'ignore' });

      const identity = readFileSync(join(dir, 'identity.txt'), 'utf8');
      expect(identity).not.toBe('');
      if (process.platform === 'linux') expect(identity).toMatch(/^linux:[^:]+:\d+$/);
      if (process.platform === 'darwin') expect(identity).toMatch(/^darwin:\S(?:.*\S)?$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can omit the cwd sentinel for no-window managed launches', () => {
    const out = buildConsoleOneliner('/repo', {}, 'true', APPEARANCE, null, false);
    const script = interactiveRcScript(out);
    expect(script).not.toContain('.papercup-console-active');
    expect(script).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  describe('headless exit mode (EI-21199387444499618)', () => {
    it('runs a successful greeting and exits without retaining a login shell', () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercup-headless-oneliner-'));
      try {
        const out = buildConsoleOneliner(
          dir,
          { SHELL: '/bin/bash' },
          "printf 'HEADLESS_OK' > marker.txt",
          APPEARANCE,
          null,
          false,
          false,
        );
        const result = spawnSync('bash', ['-c', out], { encoding: 'utf8', timeout: 2_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(join(dir, 'marker.txt'), 'utf8')).toBe('HEADLESS_OK');
        expect(out).not.toContain('exec bash --noprofile --rcfile');
        expect(out).not.toContain('exec "${SHELL:-/bin/bash}" -l');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('prints the failure banner and preserves a failed greeting status', () => {
      const out = buildConsoleOneliner('/tmp', {}, 'exit 7', APPEARANCE, null, false, false);
      const result = spawnSync('bash', ['-c', out], { encoding: 'utf8', timeout: 2_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(`${result.stdout}${result.stderr}`).toContain('headless launch exiting');
    });
  });

  it(
    'keeps the interactive supervisor alive when Ctrl+C interrupts the greeting',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'papercup-console-sigint-'));
      const home = join(dir, 'home');
      mkdirSync(home);
      const survivedMarker = 'TERMINAL_SURVIVED_SIGINT';
      const out = buildConsoleOneliner(
        dir,
        {
          HOME: home,
          SHELL: '/bin/bash',
          PS1: 'PAPERCUSP-SURVIVED> ',
          PAPERCUSP_TEST_SURVIVED_SIGINT: survivedMarker,
        },
        "printf 'GREETING_STARTED\\n'; sleep 30",
        APPEARANCE,
      );
      const terminal = nodePty.spawn('bash', ['--noprofile', '--norc', '-lc', out], {
        cwd: dir,
        env: { ...process.env, HOME: home, TERM: 'xterm-256color' },
        cols: 100,
        rows: 30,
      });
      let captured = '';
      terminal.onData((data) => {
        captured += data;
      });
      let exitEvent: unknown = null;
      const exited = new Promise<void>((resolve) => terminal.onExit((event) => {
        exitEvent = event;
        resolve();
      }));
      const waitForOutput = async (needle: string, fromOffset = 0) => {
        const deadline = Date.now() + 3_000;
        while (captured.indexOf(needle, fromOffset) === -1) {
          if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for ${needle}; output=${JSON.stringify(captured)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };

      try {
        await waitForOutput('GREETING_STARTED');
        const interruptOffset = captured.length;
        terminal.write('\x03');
        await waitForOutput('^C', interruptOffset);

        // The login shell's system profile can override inherited PS1. Set a
        // controlled prompt after Ctrl+C, then require command output (not PTY
        // echo of the input line) and the following prompt before sending exit.
        const markerOffset = captured.length;
        terminal.write("PS1='PAPERCUSP-SURVIVED> '; printf '%s\\n' \"$PAPERCUSP_TEST_SURVIVED_SIGINT\"\n");
        await waitForOutput(survivedMarker, markerOffset);
        const outputOffset = captured.indexOf(survivedMarker, markerOffset) + survivedMarker.length;
        await waitForOutput('PAPERCUSP-SURVIVED> ', outputOffset);

        terminal.write('exit\n');
        await raceWithTimeout(exited, 3_000, () => {
          let pidState = 'alive';
          try {
            process.kill(terminal.pid, 0);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            pidState = code === 'ESRCH' ? 'exited' : `unknown (${code ?? String(error)})`;
          }
          return new Error(
            `terminal did not exit (ptyPid=${terminal.pid}, pidState=${pidState}, ` +
            `onExit=${JSON.stringify(exitEvent)}); output=${JSON.stringify(captured)}`,
          );
        });

        expect(captured).toContain('^C');
        expect(captured).toContain(survivedMarker);
      } finally {
        try {
          terminal.kill();
        } catch {
          // Already exited after the explicit `exit` above.
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    8_000,
  );

  it('carries a command containing quotes as an escaped eval literal (no breakout, no mangle)', () => {
    const out = buildConsoleOneliner('/x', {}, "echo 'hi there'", APPEARANCE);
    const script = interactiveRcScript(out);
    // The greeting is shellEscape'd as ONE literal the subshell evals — the
    // pre-fix bare `'` → `'\''` replace (an escape for a single-quoted context
    // the greeting was never inside) made any quoted greeting unparseable
    // (macOS Terminal: `unexpected EOF while looking for matching "'"`).
    expect(script).toContain("(eval 'echo '\\''hi there'\\''')");
  });

  it('a quote-bearing greeting yields a one-liner bash can actually parse (bash -n)', () => {
    // The exact failure class from the 2026-07-07 mac fleet launch: a greeting
    // with legitimate shq()-style quoting killed the whole window at parse time.
    const greeting = "psu --context='it'\\''s a fleet' --plan=p1 | tee log && echo done";
    const out = buildConsoleOneliner('/proj', { A: "va'l" }, greeting, {
      mode: 'console',
      planSlug: 'plan-x',
      label: "owner's run",
      scheme: null,
    });
    expect(() => execFileSync('bash', ['-n', '-c', out])).not.toThrow();
  });

  it('executes a quoted greeting verbatim end-to-end (subshell eval round-trip)', () => {
    // Full execution proof: run the one-liner with SHELL=/bin/true so the
    // trailing `exec "${SHELL:-/bin/bash}" -l` terminates instead of going
    // interactive; the greeting must have written its apostrophe payload.
    const dir = mkdtempSync(join(tmpdir(), 'papercup-oneliner-'));
    try {
      const payload = "it's a fleet's directive";
      const greeting = `printf %s '${payload.replace(/'/g, "'\\''")}' > out.txt`;
      const out = buildConsoleOneliner(dir, { SHELL: '/bin/true' }, greeting, APPEARANCE);
      execFileSync('bash', ['-c', out], { stdio: 'ignore' });
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a MALFORMED greeting (unbalanced quote) errors inside the subshell without killing the one-liner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercup-oneliner-'));
    try {
      const out = buildConsoleOneliner(dir, { SHELL: '/bin/true' }, "echo 'oops", APPEARANCE);
      // Parses fine (the broken greeting is data, not syntax) …
      expect(() => execFileSync('bash', ['-n', '-c', out])).not.toThrow();
      // … and still reaches the trailing exec (exit 0 via /bin/true) — the
      // window would stay open showing eval's error instead of dying at parse.
      expect(() => execFileSync('bash', ['-c', out], { stdio: 'ignore' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves pipes / redirects / && in the arbitrary command', () => {
    const cmd = 'grep -r foo . | tee out.log && echo done';
    const out = buildConsoleOneliner('/x', {}, cmd, APPEARANCE);
    expect(interactiveRcScript(out)).toContain(`(eval '${cmd}')`);
  });

  it('exports env vars with valid bash names and skips invalid ones', () => {
    const out = buildConsoleOneliner('/x', { GOOD_NAME: 'v', '1BAD': 'nope', 'BAD-DASH': 'nope' }, 'true', APPEARANCE);
    expect(out).toContain("export GOOD_NAME='v'");
    expect(out).not.toContain('1BAD');
    expect(out).not.toContain('BAD-DASH');
  });

  it('prepends PAPERCUSP_BIN_DIR ahead of PAPERCUSP_SCRIPTS_DIR on PATH', () => {
    const out = buildConsoleOneliner(
      '/x',
      { PAPERCUSP_BIN_DIR: '/home/u/.papercusp/bin', PAPERCUSP_SCRIPTS_DIR: '/bundle/scripts' },
      'true',
      APPEARANCE,
    );
    expect(out).toContain("export PATH='/home/u/.papercusp/bin':'/bundle/scripts':${PATH}");
  });

  // WI-37920 / P-001 — the operator-resolved backend dirs.
  describe('backend PATH dirs (WI-37920 / P-001)', () => {
    it('APPENDS them after ${PATH} — never ahead of the user\'s own PATH', () => {
      const out = buildConsoleOneliner(
        '/x',
        {
          PAPERCUSP_BIN_DIR: '/home/u/.papercusp/bin',
          PAPERCUSP_BACKEND_PATH_DIRS: `/home/u/.bun/bin${delimiter}/opt/homebrew/bin`,
        },
        'true',
        APPEARANCE,
      );
      // Order is the whole point: papercusp's own shims win, the USER's PATH wins
      // over our injected fallbacks, and the fallbacks only decide what would
      // otherwise be unresolvable. Prepending would silently re-point a user's
      // claude/node/bun at whatever the operator happened to resolve.
      expect(out).toContain(
        "export PATH='/home/u/.papercusp/bin':${PATH}:'/home/u/.bun/bin':'/opt/homebrew/bin'",
      );
    });

    it('emits a PATH export from the backend dirs ALONE (no papercusp dirs set)', () => {
      const out = buildConsoleOneliner('/x', { PAPERCUSP_BACKEND_PATH_DIRS: '/home/u/.bun/bin' }, 'true', APPEARANCE);
      expect(out).toContain("export PATH=${PATH}:'/home/u/.bun/bin'");
    });

    it('selects the Papercusp Node runtime ahead of an incompatible desktop PATH', () => {
      const root = mkdtempSync(join(tmpdir(), 'papercup-node-path-'));
      const runtimeDir = join(root, 'operator-node');
      const desktopDir = join(root, 'desktop-node');
      mkdirSync(runtimeDir);
      mkdirSync(desktopDir);
      writeFileSync(join(runtimeDir, 'node'), '#!/bin/sh\nprintf "%s\\n" "abi-141"\n');
      writeFileSync(join(desktopDir, 'node'), '#!/bin/sh\nprintf "%s\\n" "abi-127"\n');
      chmodSync(join(runtimeDir, 'node'), 0o755);
      chmodSync(join(desktopDir, 'node'), 0o755);

      try {
        const oneliner = buildConsoleOneliner(
          root,
          { PAPERCUSP_NODE_RUNTIME_DIR: runtimeDir, SHELL: '/bin/true' },
          'node --version > selected-node.txt',
          APPEARANCE,
        );
        execFileSync('/bin/bash', ['-c', oneliner], {
          cwd: root,
          env: { PATH: `${desktopDir}:/usr/bin:/bin` },
        });
        expect(readFileSync(join(root, 'selected-node.txt'), 'utf8').trim()).toBe('abi-141');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('runs a real Node shebang CLI through retained Node ahead of conflicting shim and desktop interpreters', () => {
      const root = mkdtempSync(join(tmpdir(), 'console-node-shebang-'));
      try {
        const runtimeDir = join(root, 'retained-node');
        const shimDir = join(root, 'shims');
        const desktopDir = join(root, 'desktop');
        for (const dir of [runtimeDir, shimDir, desktopDir]) mkdirSync(dir);
        symlinkSync(process.execPath, join(runtimeDir, 'node'));
        for (const dir of [shimDir, desktopDir]) {
          if (process.env.PAPERCUSP_RUNTIME_TEST_BUN) symlinkSync(process.env.PAPERCUSP_RUNTIME_TEST_BUN, join(dir, 'node'));
          else {
            writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit 79\n', { mode: 0o755 });
          }
        }
        const cli = join(shimDir, 'runtime-cli');
        const receiptPath = join(root, 'receipt.json');
        writeFileSync(cli, '#!/usr/bin/env node\n' +
          'require("node:fs").writeFileSync(process.env.CLI_RECEIPT,JSON.stringify({runtime:process.versions.bun?"bun":"node",executable:process.execPath,args:process.argv.slice(2)}))\n',
        { mode: 0o755 });
        const oneliner = buildConsoleOneliner(root, {
          PAPERCUSP_NODE_RUNTIME_DIR: runtimeDir, PAPERCUSP_BIN_DIR: shimDir, CLI_RECEIPT: receiptPath,
        }, 'runtime-cli "literal argument"', APPEARANCE, null, false, false);
        execFileSync('/bin/bash', ['-c', oneliner], {
          cwd: root, env: { PATH: `${desktopDir}:/usr/bin:/bin` }, encoding: 'utf8',
        });
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        expect(receipt).toEqual({ runtime: 'node', executable: realpathSync(process.execPath), args: ['literal argument'] });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('is byte-identical to the pre-fix line when the key is absent', () => {
      // The regression guard for every launch that resolves nothing: a box with no
      // extra backend dirs must produce exactly the old prelude.
      const before = buildConsoleOneliner('/x', { PAPERCUSP_BIN_DIR: '/b' }, 'true', APPEARANCE);
      expect(before).toContain('export PATH=\'/b\':${PATH} &&');
      expect(before).not.toContain('PAPERCUSP_BACKEND_PATH_DIRS');
    });

    it('shell-escapes a dir containing a quote', () => {
      const out = buildConsoleOneliner('/x', { PAPERCUSP_BACKEND_PATH_DIRS: "/home/o'brien/.bun/bin" }, 'true', APPEARANCE);
      expect(out).toContain(`'/home/o'\\''brien/.bun/bin'`);
    });
  });

  it('emits the OSC window-title prelude', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: 'my run' });
    expect(out).toContain('printf');
    expect(out).toContain('my run');
  });
});

// WI-4272: the demo-stage display override — pin the window to a caller-chosen
// X display (a provisioned sandbox Xvfb being recorded) instead of the seat.
describe('spawnConsole displayOverride (demo-stage) — WI-4272', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    // A poisoned seat env the override must IGNORE/strip, never inherit.
    vi.stubEnv('DISPLAY', ':0');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    // Hermetic emulator resolution: isOnPath unconditionally checks /usr/bin,
    // so PATH-stubbing can't simulate presence/absence — seed the memo instead.
    _resetDisplayHonoringTerminalCacheForTests({ bin: 'xterm', args: ['-e'] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetDisplayHonoringTerminalCacheForTests();
    _resetTerminalCacheForTests();
  });

  it('happy path: spawns the DISPLAY-honoring emulator with env.DISPLAY = the override, WAYLAND_DISPLAY stripped, resolvedVia caller-override', async () => {
    spawnMock.mockImplementation(() => fakeChild(5555)); // survives the probe
    const r = await spawnConsole({
      envelope,
      displayOverride: ':123',
      desktopEnvProbes: FAKE_DESKTOP_PROBES, // socket "exists"
      // WI-37476 (EI-9748 Route B): this test is about display-override env
      // handling, not the cgroup-escape wrapper — isolate it the same way the
      // Route-A tests isolate the headless spawn, so it doesn't flake between
      // "xterm" and "systemd-run" depending on whether THIS box happens to have
      // systemd-run on PATH.
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
    });
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.terminal).toBe('xterm');
    expect(ok.display).toBe(':123');
    expect(ok.desktopEnvResolvedVia).toBe('caller-override');
    const [bin, , spawnOpts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(bin).toBe('xterm');
    expect(spawnOpts.env.DISPLAY).toBe(':123'); // the override, NOT the seat's :0
    expect(spawnOpts.env.WAYLAND_DISPLAY).toBeUndefined(); // stripped so GTK/webkit binds X11
  }, 10_000);

  it('dead/unprovisioned display socket ⇒ LOUD 412 before any spawn (no off-screen ghost)', async () => {
    const r = await spawnConsole({
      envelope,
      displayOverride: ':777',
      desktopEnvProbes: { ...FAKE_DESKTOP_PROBES, existsSync: () => false },
    });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(412);
    expect(err.error).toMatch(/no X socket/);
    expect(err.error).toMatch(/WI-4272/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no DISPLAY-honoring emulator installed ⇒ 500 naming the installable candidates (never a client-server fallback)', async () => {
    _resetDisplayHonoringTerminalCacheForTests(null); // simulate a host with none
    const r = await spawnConsole({
      envelope,
      displayOverride: ':123',
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
    });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(500);
    expect(err.error).toMatch(/xterm \/ alacritty \/ kitty \/ wezterm/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('an unparseable override value ⇒ 400, not a silent seat spawn', async () => {
    const r = await spawnConsole({
      envelope,
      displayOverride: 'not-a-display',
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
    });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('default path (no override) is unchanged: seat resolution runs and reports its own resolvedVia', async () => {
    spawnMock.mockImplementation(() => fakeChild(6666));
    vi.stubEnv('TERMINAL', 'bash');
    _resetTerminalCacheForTests();
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.desktopEnvResolvedVia).toBe('operator-env'); // DISPLAY=:0 trusted (probes say socket exists)
    const [, , spawnOpts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(spawnOpts.env.WAYLAND_DISPLAY).toBe('wayland-0'); // NOT stripped on the default path
  }, 10_000);
});

describe('pickLinuxTerminal — preference is conditional on a detected desktop session (WI-4718)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const onlyOnPath = (...bins: string[]) => (bin: string) => bins.includes(bin);

  // WI-4718: gnome-terminal is the owner's STANDARD terminal and works from the
  // headless operator once resolveLinuxDesktopEnv injects the live session's D-Bus
  // bus (resolveSessionBus). So when a desktop session was detected
  // (preferClientServer=true) it MUST win; only with NO reachable session
  // (a bare Xvfb/sandbox) do we fall back to a process-per-window emulator.

  it('desktop session DETECTED ⇒ prefers the owner’s standard gnome-terminal over xterm', () => {
    vi.stubEnv('TERMINAL', '');
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), true);
    expect(t?.bin).toBe('gnome-terminal');
    // --wait keeps the client alive for the window's lifetime (adv-session tracking).
    expect(t?.args).toContain('--wait');
  });

  it('NO desktop session ⇒ prefers the reliable process-per-window xterm over gnome-terminal', () => {
    // A bare Xvfb / sandbox: gnome-terminal spawned there maps NO window
    // (standalone gnome-terminal.real lingers → false ok), while xterm binds the
    // injected DISPLAY directly and opens reliably. So xterm MUST win here.
    vi.stubEnv('TERMINAL', '');
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), false);
    expect(t?.bin).toBe('xterm');
  });

  it('default (no flag) is the no-session ordering — process-per-window first', () => {
    vi.stubEnv('TERMINAL', '');
    expect(pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'))?.bin).toBe('xterm');
  });

  it('desktop session DETECTED but only a process-per-window emulator installed ⇒ still uses it', () => {
    vi.stubEnv('TERMINAL', '');
    const t = pickLinuxTerminal(onlyOnPath('alacritty'), true);
    expect(t?.bin).toBe('alacritty');
  });

  it('NO session but only a client-server terminal installed ⇒ still falls back to it', () => {
    vi.stubEnv('TERMINAL', '');
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal'), false);
    expect(t?.bin).toBe('gnome-terminal');
    expect(t?.args).toContain('--wait');
  });

  it('an explicit $TERMINAL is still honored as-is, regardless of the preference flag', () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    expect(pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), false)?.bin).toBe('gnome-terminal');
    expect(pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), true)?.bin).toBe('gnome-terminal');
  });

  it('a strict process-per-window launch ignores $TERMINAL=gnome-terminal and chooses xterm', () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), false, true);
    expect(t).toEqual({ bin: 'xterm', args: ['-e'] });
  });

  it('a strict process-per-window launch fails when only a client-server terminal is installed', () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    expect(pickLinuxTerminal(onlyOnPath('gnome-terminal'), false, true)).toBeNull();
  });

  it('returns null when no known emulator is installed', () => {
    vi.stubEnv('TERMINAL', '');
    expect(pickLinuxTerminal(() => false, true)).toBeNull();
    expect(pickLinuxTerminal(() => false, false)).toBeNull();
  });
});

// EI-11578 provides an explicit process-per-window override for callers that
// need direct per-window ownership. Desktop resumes retain GNOME Terminal per
// owner correction; the earlier VTE-drop hypothesis did not reproduce in 20
// real resumes (2026-09-29, reverified 2026-10-21).
describe('resolveTerminalPreference — explicit process-per-window override (EI-11578)', () => {
  const onlyOnPath = (...bins: string[]) => (bin: string) => bins.includes(bin);

  it('a detected desktop session normally prefers client-server (gnome-terminal) — unchanged for a fresh launch', () => {
    // preferProcessPerWindow=false (a fresh launch) ⇒ base WI-4718 behavior.
    expect(resolveTerminalPreference(true, false)).toBe(true);
  });

  it('an explicit process-per-window requirement overrides client-server preference on a desktop', () => {
    expect(resolveTerminalPreference(true, true)).toBe(false);
  });

  it('no desktop session already prefers process-per-window, regardless of the override', () => {
    expect(resolveTerminalPreference(false, false)).toBe(false);
    expect(resolveTerminalPreference(false, true)).toBe(false);
  });

  it('composed with pickLinuxTerminal: an explicit process-per-window requirement picks xterm over gnome-terminal', () => {
    vi.stubEnv('TERMINAL', '');
    // An explicit process-per-window requirement → false → process-per-window
    // ordering, so xterm wins even though gnome-terminal is installed.
    const preferClientServer = resolveTerminalPreference(true, true);
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), preferClientServer);
    expect(t?.bin).toBe('xterm');
    vi.unstubAllEnvs();
  });

  it('composed with pickLinuxTerminal: a FRESH launch on the same desktop box still picks the standard gnome-terminal', () => {
    vi.stubEnv('TERMINAL', '');
    const preferClientServer = resolveTerminalPreference(true, false);
    const t = pickLinuxTerminal(onlyOnPath('gnome-terminal', 'xterm'), preferClientServer);
    expect(t?.bin).toBe('gnome-terminal');
    expect(t?.args).toContain('--wait');
    vi.unstubAllEnvs();
  });
});

describe('findDisplayHonoringTerminal — WI-4272', () => {
  beforeEach(() => _resetDisplayHonoringTerminalCacheForTests());
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetDisplayHonoringTerminalCacheForTests();
  });

  it('$TERMINAL=gnome-terminal must NOT hijack the override path (client-server: its window lands on the seat)', () => {
    vi.stubEnv('TERMINAL', 'gnome-terminal');
    const t = findDisplayHonoringTerminal();
    // Whatever the host has installed (xterm on the dev box, nothing on a bare
    // CI runner), the answer is NEVER the client-server $TERMINAL.
    expect(t?.bin).not.toBe('gnome-terminal');
  });

  it('$TERMINAL naming a DISPLAY-honoring candidate is honored when on PATH (bash stands in as not-a-candidate)', () => {
    vi.stubEnv('TERMINAL', 'bash'); // on PATH but not a candidate ⇒ ignored
    const t = findDisplayHonoringTerminal();
    expect(t?.bin).not.toBe('bash');
  });
});

describe('advSessionTitleTag', () => {
  it('formats a present id and elides a missing one', () => {
    expect(advSessionTitleTag(42)).toBe('[adv:42]');
    expect(advSessionTitleTag(null)).toBe('');
    expect(advSessionTitleTag(undefined)).toBe('');
  });
});

describe('fleet color scheme (AppearanceOpts.scheme)', () => {
  const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };

  it('a bound scheme drives fg (OSC 10), bg (OSC 11) and cursor (OSC 12) — overriding the plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'some-plan',
      label: null,
      scheme: SCHEME,
    });
    expect(out).toContain("printf '\\033]10;#f5e8ff\\007'");
    expect(out).toContain("printf '\\033]11;#581c87\\007'");
    expect(out).toContain("printf '\\033]12;#d8b4fe\\007'");
  });

  it('without a scheme: no cursor OSC, and bg falls back to the per-plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: null });
    expect(out).not.toContain('\\033]12;'); // no cursor sequence
    expect(out).toContain("printf '\\033]11;#1e1b4b\\007'"); // console null-slug fallback
  });
});

describe('macConsoleInvocation (operator-direct macOS spawn — approach C)', () => {
  const baseOpts = { tmpDir: '/tmp', nowMs: 1234, pid: 999, hasITerm: false };

  it('writes a one-shot .command that self-deletes then execs the login-shell one-liner', () => {
    const oneliner = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toMatch(/^#!\/bin\/bash\n/);
    expect(inv.content).toContain('rm -f "$0"'); // self-delete so /tmp doesn't accrete one-shots
    expect(inv.content).toContain('exec bash -lc');
    expect(inv.content).toContain('npm run dev'); // the full one-liner is carried
  });

  it('a quote-bearing greeting survives BOTH layers: the .command parses and its inner bash -lc payload parses', () => {
    // The 2026-07-07 owner repro: mac fleet launch → Terminal.app ran the
    // .command → `bash: -c: line 0: unexpected EOF while looking for matching
    // "'"`. The .command wraps the one-liner in shellEscape (outer layer); the
    // one-liner itself must ALSO be parseable when that inner bash -lc runs.
    const oneliner = buildConsoleOneliner(
      '/proj',
      {},
      "psu --context='it'\\''s a fleet' --plan=p1",
      APPEARANCE,
    );
    const inv = macConsoleInvocation(oneliner, baseOpts);
    // Outer layer: the .command body itself is valid bash.
    expect(() => execFileSync('bash', ['-n'], { input: inv.content })).not.toThrow();
    // Inner layer: what `exec bash -lc <arg>` will parse is the one-liner.
    expect(() => execFileSync('bash', ['-n', '-c', oneliner])).not.toThrow();
  });

  it('names a fresh .command per pid+timestamp under tmpDir', () => {
    const inv = macConsoleInvocation('true', { ...baseOpts, tmpDir: '/var/folders/x', nowMs: 42, pid: 7 });
    expect(inv.file).toBe('/var/folders/x/papercup-console-7-42.command');
  });

  it('opens a FRESH instance (open -na) so every call is a new window', () => {
    const inv = macConsoleInvocation('true', baseOpts);
    expect(inv.openArgs).toEqual(['-na', 'Terminal.app', inv.file]);
  });

  it('prefers iTerm when installed, else Terminal.app', () => {
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: true }).term).toBe('iTerm.app');
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: false }).term).toBe('Terminal.app');
  });

  it('carries the OSC color prelude into the .command (fleet colors work on Mac, no Rust port)', () => {
    const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };
    const oneliner = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'p',
      label: null,
      scheme: SCHEME,
    });
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toContain('#581c87'); // bg (OSC 11) survives into the .command
    expect(inv.content).toContain('#d8b4fe'); // cursor (OSC 12) survives
  });
});

describe('spawnMacConsole verifies `open` — GUI-less mac ghost members (EI-19311623077693508)', () => {
  // The live failure: a rig mac whose sidecar was started over ssh has NO GUI
  // session, so LaunchServices refuses (`osascript` ⇒ -10810, `/dev/console`
  // owned by root) and `open` exits NON-ZERO. This path used to return ok the
  // instant Node forked, so delegated-spawn-honor counted a phantom member as
  // `opened` — which ALSO made its own `r.status !== 'ok'` headless fallback
  // dead code on macOS, and the requesting leader waited out the whole offer
  // expiry for a member that never existed.
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  const realPlatform = process.platform;
  let tmp: string;

  // A mac WITH someone logged into the GUI, whose .command was executed (it
  // self-deletes, so "gone" is the execution receipt). The suite runs on Linux
  // where /dev/console is root-owned, and `spawn` is mocked so no terminal ever
  // really runs the script — without these fakes every case below would take the
  // new no-GUI / never-executed branches rather than exercising what it names.
  const GUI_OK = {
    consoleUid: () => 501,
    commandFileExists: () => false,
    sleep: async () => {},
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mac-spawn-'));
    vi.stubEnv('TMPDIR', tmp);
    spawnMock.mockReset();
    // spawnConsole dispatches on process.platform; the suite runs on Linux.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('`open` exiting NON-ZERO ⇒ LOUD error, not a phantom ok (the GUI-less rig mac)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5150);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({ envelope, macProbes: GUI_OK });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(502);
    expect(err.error).toMatch(/no window opened/i);
    expect(err.error).toContain('exit 1');
    // The message must point at the GUI-session cause — that is what turns a
    // silent phantom success into a diagnosable one.
    expect(err.error).toMatch(/-10810|GUI/);
  });

  it('`open` killed by a signal ⇒ error', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5151);
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return child;
    });
    const r = await spawnConsole({ envelope, macProbes: GUI_OK });
    expect(r.status).toBe('error');
    expect((r as { error: string }).error).toContain('SIGKILL');
  });

  it('`open` exiting 0 ⇒ ok — an early exit is NORMAL on mac (open is a launcher, not the terminal)', async () => {
    // Guards the mac-specific inversion: the Linux probe treats ANY early exit
    // as failure. Applying that rule here would fail every healthy mac launch,
    // since `open` hands off to LaunchServices and returns 0 immediately.
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5152);
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    const r = await spawnConsole({ envelope, macProbes: GUI_OK });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(5152);
    expect((r as { terminal: string }).terminal).toBe('Terminal.app');
  });

  it('a slow `open` that outlives the probe ⇒ ok (fail OPEN — never manufacture a failure)', async () => {
    spawnMock.mockImplementation(() => fakeChild(5153)); // never exits
    const r = await spawnConsole({ envelope, macProbes: GUI_OK });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(5153);
  }, 10_000);

  // EI-19311623077693508 (second half). THIS is the case the first fix missed,
  // and the reason a 64/64-green suite shipped a fix that did not fix the bug:
  // every existing case above emits 'exit', so none of them could see that
  // watchEarlyExit had no 'error' listener at all. A spawn that FAILS TO START
  // emits 'error' and — for ENOENT — never emits 'exit', so the probe used to
  // time out and take the fail-OPEN branch directly above, reporting a window
  // that was never opened. Note the deliberate absence of an 'exit' emit: adding
  // one would make this pass against the broken code and prove nothing.
  it("`open` that never STARTS (spawn 'error', no 'exit') ⇒ error, NOT a fail-open ok", async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5154);
      queueMicrotask(() => child.emit('error', new Error('spawn open ENOENT')));
      return child;
    });
    const r = await spawnConsole({ envelope, macProbes: GUI_OK });
    expect(r.status).toBe('error');
    const err = r as { error: string };
    expect(err.error).toMatch(/ENOENT/);
    expect(err.error).toMatch(/no window opened/i);
    // It must resolve on the error, not sit out the full probe window.
  }, 10_000);

  // EI-19311623077693508 (THIRD and final half) — the case both earlier fixes
  // missed, and the one that was actually happening. Verified on the rig mac
  // 2026-08-02: `open` exited 0 ("LaunchServices accepted"), the operator logged
  // `honored (1 member(s) opened)`, and ZERO agent processes existed. The proof
  // it never ran: the .command self-deletes (`rm -f "$0"`) as its first act, and
  // BOTH files from the two honors were still on disk afterwards.
  //
  // Note both tests below emit exit 0 — the *success* signal. That is the point:
  // every earlier test asserted against a failing `open`, so none could see that
  // a SUCCEEDING `open` proves nothing about whether a window appeared.
  it('no GUI session (/dev/console owned by root) ⇒ error BEFORE spawning — the rig mac', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5155);
      queueMicrotask(() => child.emit('exit', 0, null)); // open "succeeds"
      return child;
    });
    const r = await spawnConsole({
      envelope,
      macProbes: { consoleUid: () => 0, commandFileExists: () => false, sleep: async () => {} },
    });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/no GUI session/i);
    // It must not even fork `open`: there is nothing a window could be shown on.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('`open` exits 0 but the .command is NEVER executed ⇒ error, not a phantom ok', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5156);
      queueMicrotask(() => child.emit('exit', 0, null)); // accepted by LaunchServices
      return child;
    });
    const r = await spawnConsole({
      envelope,
      // GUI session present, but the launcher script is still on disk ⇒ it never ran.
      macProbes: { consoleUid: () => 501, commandFileExists: () => true, sleep: async () => {} },
    });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/never executed/i);
  }, 10_000);

  it('the .command disappearing mid-wait ⇒ ok (a slow but genuine launch is not failed)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(5157);
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    let polls = 0;
    const r = await spawnConsole({
      envelope,
      // Present for the first few polls, then executed (self-deleted).
      macProbes: { consoleUid: () => 501, commandFileExists: () => ++polls < 4, sleep: async () => {} },
    });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(5157);
    expect(polls).toBeGreaterThan(1); // it really did wait rather than pass instantly
  }, 10_000);
});

describe('spawnHeadless boot receipt — a member that dies AFTER the probe (EI-19311623077693508)', () => {
  // The live bug, reproduced. On the rig mac all three delegated spawns were
  // logged `honored (1 member(s) opened)` with zero agent processes: psu joined
  // the fleet, then died on an auth rejection ~2-4s in. watchEarlyExit cannot
  // ever catch this — buildConsoleOneliner prints the sentinel and then `exec`s
  // a login shell, so the CHILD NEVER EXITS. Note every case here keeps the
  // child alive, which is precisely what made the old code report success.
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --headless',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  const AUTH_DEATH =
    'psu: fleet — joined fleet fed-drill as member.\n' +
    'Your organization has disabled Claude subscription access for Claude Code\n' +
    '\n[papercusp] initial terminal command exited with status 1; terminal left open for inspection.\n';

  // A real (tiny) sleep: a no-op stub makes the wait loop busy-spin the whole window.
  const TICK = (_ms: number) => new Promise<void>((r) => { setTimeout(r, 5); });

  beforeEach(() => spawnMock.mockReset());

  it('greeting-failure sentinel ⇒ error, even though the process is still alive', async () => {
    spawnMock.mockImplementation(() => fakeChild(6001)); // never exits — the live shape
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: { readLog: () => AUTH_DEATH, sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/died at boot \(exit 1\)/);
    expect((r as { logPath?: string }).logPath).toBeTruthy();
    // The operator error must carry the member's own words, or the next person
    // debugging this has to go find the log themselves.
    expect((r as { error: string }).error).toMatch(/disabled Claude subscription access/);
  }, 10_000);

  it('keeps an unrelated issue reference out of the prompt-tiling boot failure reason', async () => {
    spawnMock.mockImplementation(() => fakeChild(6006));
    const tilingDeath =
      'psu: POST /api/agent-mcp/console/bootstrap-su (HTTP 400) — su.md tiling is unsound\n' +
      '[papercusp] initial terminal command exited with status 1; terminal left open for inspection.\n';
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: { readLog: () => tilingDeath, sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('error');
    const error = (r as { error: string }).error;
    expect(error).toContain('su.md tiling is unsound');
    expect(error).not.toContain('EI-19311623077693508');
  }, 10_000);

  it('sentinel appearing LATE (after the early-exit probe) is still caught', async () => {
    spawnMock.mockImplementation(() => fakeChild(6002));
    let reads = 0;
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: {
        // Clean for the first few polls — exactly the race that produced the phantom.
        readLog: () => (++reads < 4 ? 'psu: starting…\n' : AUTH_DEATH),
        sleep: TICK,
        windowMs: 400,
      },
    });
    expect(r.status).toBe('error');
    expect(reads).toBeGreaterThan(3); // it kept watching past the first look
  }, 10_000);

  it('a healthy member (no sentinel) ⇒ ok — never manufacture a failure', async () => {
    spawnMock.mockImplementation(() => fakeChild(6003));
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: {
        readLog: () => 'psu: fleet — joined fleet fed-drill as member.\npsu: kickoff — seeding first turn\n',
        sleep: TICK,
        windowMs: 60,
      },
    });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(6003);
  }, 10_000);

  it('sentinel with status 0 is ALSO a dead member (the agent command ended at all)', async () => {
    spawnMock.mockImplementation(() => fakeChild(6004));
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: {
        readLog: () => '[papercusp] initial terminal command exited with status 0; terminal left open for inspection.\n',
        sleep: TICK,
        windowMs: 60,
      },
    });
    // buildConsoleOneliner only prints this on a NON-zero rc, so status 0 should
    // not occur in practice. If it ever does, the agent command has still ended
    // and the shell is holding a dead session — which is not a live member
    // whatever the code was. Fail rather than hand back a phantom.
    expect(r.status).toBe('error');
    expect((r as { error: string }).error).toMatch(/exit 0/);
  }, 10_000);

  it('exposes a persistent child-exit promise after the receipt window, catching a later nonzero psu exit', async () => {
    spawnMock.mockImplementation(() => fakeChild(6005));
    const r = await spawnHeadless({
      envelope,
      spawnCommandProbes: { platform: 'linux', hasSystemdRun: () => false },
      bootProbes: { readLog: () => '', sleep: TICK, windowMs: 60 },
    });
    expect(r.status).toBe('ok');
    const childExit = (r as { childExit?: Promise<{ code: number | null; signal: string | null }> }).childExit;
    expect(childExit).toBeInstanceOf(Promise);
    const child = spawnMock.mock.results[0]?.value as EventEmitter;
    queueMicrotask(() => child.emit('exit', 2, null));
    await expect(childExit).resolves.toMatchObject({ code: 2, signal: null });
  }, 10_000);
});

describe('macHasGuiSession (EI-19311623077693508)', () => {
  it('root-owned /dev/console ⇒ no GUI session', () => {
    expect(macHasGuiSession(() => 0)).toBe(false);
  });
  it('user-owned /dev/console ⇒ GUI session', () => {
    expect(macHasGuiSession(() => 501)).toBe(true);
  });
  it('unreadable /dev/console ⇒ no GUI session (fail toward the path that RUNS)', () => {
    expect(macHasGuiSession(() => { throw new Error('ENOENT'); })).toBe(false);
  });
});
