/**
 * RTK in capability:bash (WI-6554700010009291, owner directives #1759 / #1764).
 *
 * capability:bash replaces native Bash for fleet roles, so it must carry RTK's
 * output compression too. These tests pin three things:
 *  1. the rewrite seam honours every rtk exit code and fails open to the
 *     verbatim command (missing binary, error, timeout, denial, kill-switch);
 *  2. the handler spawns the RTK form while every gate keeps judging the
 *     original, and says so in the result;
 *  3. callers that parse output (code-mode, structured) and vitest commands
 *     (EI-9471) are never rewritten.
 * A fake `rtk` script stands in for the binary so the suite does not depend on
 * what the host has installed.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({
  startBackground: vi.fn((opts: { command: string; cwd: string }) => ({
    id: 'bash-rtk-test',
    taskId: 'task-rtk-test',
    command: opts.command,
    cwd: opts.cwd,
    status: 'completed' as const,
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    totalBytes: 0,
    logPath: '/tmp/capability-bash-rtk-test.log',
    timeoutMs: 10_000,
    deadlineAt: 10_001,
  })),
  waitForJobResponse: vi.fn(async () => 'terminal' as const),
  snapshotJobResult: vi.fn(() => ({
    status: 'completed' as const,
    exitCode: 0,
    durationMs: 1,
    output: 'out',
    truncated: false,
    totalBytes: 3,
    logPath: '/tmp/capability-bash-rtk-test.log',
  })),
}));

const flags = vi.hoisted(() => ({ rtkOn: true }));

vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: jobs.startBackground,
  waitForJobResponse: jobs.waitForJobResponse,
  snapshotJobResult: jobs.snapshotJobResult,
}));

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async (key: string) => (key === 'papercusp-capability-bash-rtk' ? flags.rtkOn : false)),
}));

import bashTool, { RTK_RESULT_NOTE } from './bash';
import { startBackground } from './bash-jobs';
import {
  RTK_BIN_ENV,
  RTK_MAX_COMMAND_CHARS,
  RTK_SESSION_ENV,
  resolveRtkBin,
  rtkCommandForCapabilityBash,
  rtkRewrite,
  rtkSkipReasonForCommand,
} from './rtk-rewrite';

type Tool = {
  handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const bash = bashTool as unknown as Tool;

/** A stand-in for `rtk rewrite <cmd>` covering every exit code rtk uses. */
const FAKE_RTK = `#!/bin/sh
[ "$1" = rewrite ] || exit 64
case "$2" in
  "git status") echo "rtk git status"; exit 0 ;;
  "git log -n 3") echo "warning on stderr" >&2; echo "rtk git log -n 3"; exit 3 ;;
  "cd /tmp && git status") echo "cd /tmp && rtk git status"; exit 0 ;;
  "npm run test:e2e:isolated -- e2e/content-reading.spec.ts") echo "rtk test -- npm run test:e2e:isolated -- e2e/content-reading.spec.ts"; exit 0 ;;
  deny*) exit 2 ;;
  slow*) sleep 5; echo "rtk slow"; exit 0 ;;
  crash*) exit 9 ;;
  same*) echo "$2"; exit 0 ;;
  *) exit 1 ;;
esac
`;

let root: string;
let binDir: string;
let fakeRtk: string;
let savedRtkBin: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'capability-rtk-'));
  binDir = join(root, 'bin');
  mkdirSync(binDir);
  fakeRtk = join(binDir, 'rtk');
  writeFileSync(fakeRtk, FAKE_RTK);
  chmodSync(fakeRtk, 0o755);
  savedRtkBin = process.env[RTK_BIN_ENV];
  flags.rtkOn = true;
  vi.mocked(startBackground).mockClear();
});

afterEach(() => {
  if (savedRtkBin === undefined) delete process.env[RTK_BIN_ENV];
  else process.env[RTK_BIN_ENV] = savedRtkBin;
  rmSync(root, { recursive: true, force: true });
});

describe('resolveRtkBin', () => {
  it('uses an executable override', () => {
    expect(resolveRtkBin({ [RTK_BIN_ENV]: fakeRtk })).toBe(fakeRtk);
  });

  it('treats an empty or non-executable override as no RTK', () => {
    expect(resolveRtkBin({ [RTK_BIN_ENV]: '' })).toBeNull();
    const notExec = join(root, 'not-exec');
    writeFileSync(notExec, 'x');
    expect(resolveRtkBin({ [RTK_BIN_ENV]: notExec })).toBeNull();
  });

  it('never picks up a host binary implicitly under vitest', () => {
    expect(resolveRtkBin({ VITEST: 'true', HOME: root, PATH: binDir })).toBeNull();
  });

  it('finds ~/.local/bin/rtk, then PATH, outside vitest', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    expect(resolveRtkBin({ HOME: home, PATH: binDir })).toBe(fakeRtk);
    const pinned = join(home, '.local', 'bin', 'rtk');
    writeFileSync(pinned, FAKE_RTK);
    chmodSync(pinned, 0o755);
    expect(resolveRtkBin({ HOME: home, PATH: binDir })).toBe(pinned);
  });
});

describe('rtkSkipReasonForCommand', () => {
  it('never offers vitest commands to rtk (EI-9471)', () => {
    expect(rtkSkipReasonForCommand('cd pkg && npx vitest run a.test.ts | grep x')).toBe('vitest');
  });

  it('honours the RTK_DISABLED=1 opt-out prefix', () => {
    expect(rtkSkipReasonForCommand('RTK_DISABLED=1 git status')).toBe('opt-out');
    expect(rtkSkipReasonForCommand('cd x && RTK_DISABLED=1 git log')).toBe('opt-out');
  });

  it('skips oversized commands that would overflow one argv element', () => {
    expect(rtkSkipReasonForCommand(`echo ${'a'.repeat(RTK_MAX_COMMAND_CHARS)}`)).toBe('too-long');
  });

  it('never offers a pipe into an early-exit consumer (WI-6554700010009543)', () => {
    // rtk collects the whole output first, so `head` closing the pipe would no longer stop the producer
    expect(rtkSkipReasonForCommand('rg -n x . | head -60')).toBe('early-exit-pipe');
    expect(rtkSkipReasonForCommand('cd pkg && git log |& head -5')).toBe('early-exit-pipe');
    expect(rtkSkipReasonForCommand('git log | grep -m 3 fix')).toBe('early-exit-pipe');
    expect(rtkSkipReasonForCommand('rg x | rg -m2 y')).toBe('early-exit-pipe');
    expect(rtkSkipReasonForCommand('git log | grep --max-count=3 fix')).toBe('early-exit-pipe');
    expect(rtkSkipReasonForCommand('git log | sed 20q')).toBe('early-exit-pipe');
    // not early-exit: tail and plain grep read everything; `||` is not a pipe
    expect(rtkSkipReasonForCommand('git log -n 3 | tail -5')).toBeNull();
    expect(rtkSkipReasonForCommand('git log | grep fix')).toBeNull();
    expect(rtkSkipReasonForCommand('git status || head -1 notes.txt')).toBeNull();
  });

  it('never offers grep -h / --no-filename, which rtk grep reads as --help (WI-6554700010009627)', () => {
    expect(rtkSkipReasonForCommand("grep -h -E 'foo|bar' a.log b.log")).toBe('grep-no-filename');
    expect(rtkSkipReasonForCommand('grep -hn foo a.log')).toBe('grep-no-filename');
    expect(rtkSkipReasonForCommand('grep -rh foo src')).toBe('grep-no-filename');
    expect(rtkSkipReasonForCommand('cd x && egrep -h foo a.log')).toBe('grep-no-filename');
    expect(rtkSkipReasonForCommand("grep -E 'a|b' -h a.log")).toBe('grep-no-filename');
    expect(rtkSkipReasonForCommand('grep --no-filename foo a.log b.log')).toBe('grep-no-filename');
    // not -h: an 'h' inside a pattern, a cluster without h, --help-like long flags, rg
    expect(rtkSkipReasonForCommand("grep -E 'h|x' a.log")).toBeNull();
    expect(rtkSkipReasonForCommand('grep -rn hello src')).toBeNull();
    expect(rtkSkipReasonForCommand('grep --include=*.sh foo .')).toBeNull();
    expect(rtkSkipReasonForCommand('rg -n foo .')).toBeNull();
  });

  it('lets ordinary commands through', () => {
    expect(rtkSkipReasonForCommand('git status')).toBeNull();
  });
});

describe('rtkRewrite — every rtk exit code', () => {
  it('exit 0 → rewritten', async () => {
    await expect(rtkRewrite('git status', { bin: fakeRtk, cwd: root })).resolves.toEqual({
      kind: 'rewritten',
      command: 'rtk git status',
      bin: fakeRtk,
    });
  });

  it('exit 3 (rtk wants to ask) → rewritten from stdout only, stderr ignored', async () => {
    await expect(rtkRewrite('git log -n 3', { bin: fakeRtk, cwd: root })).resolves.toMatchObject({
      kind: 'rewritten',
      command: 'rtk git log -n 3',
    });
  });

  it('exit 1 → unchanged, no RTK equivalent', async () => {
    await expect(rtkRewrite('echo hi', { bin: fakeRtk, cwd: root })).resolves.toEqual({
      kind: 'unchanged',
      reason: 'no-equivalent',
    });
  });

  it('identical output → unchanged', async () => {
    await expect(rtkRewrite('same thing', { bin: fakeRtk, cwd: root })).resolves.toMatchObject({
      reason: 'no-equivalent',
    });
  });

  it('exit 2 → unchanged, denied', async () => {
    await expect(rtkRewrite('deny me', { bin: fakeRtk, cwd: root })).resolves.toMatchObject({ reason: 'rtk-denied' });
  });

  it('any other exit → unchanged, error', async () => {
    await expect(rtkRewrite('crash now', { bin: fakeRtk, cwd: root })).resolves.toMatchObject({ reason: 'rtk-error' });
  });

  it('a hung rtk is killed at the timeout → unchanged', async () => {
    await expect(rtkRewrite('slow one', { bin: fakeRtk, cwd: root, timeoutMs: 200 })).resolves.toMatchObject({
      reason: 'rtk-timeout',
    });
  });

  it('a binary that vanished → unchanged, missing', async () => {
    await expect(rtkRewrite('git status', { bin: join(root, 'gone'), cwd: root })).resolves.toMatchObject({
      reason: 'rtk-missing',
    });
  });
});

describe('rtkCommandForCapabilityBash', () => {
  const flagOn = vi.fn(async () => true);
  beforeEach(() => flagOn.mockClear());

  it('rewrites and puts the binary directory on the child PATH when absent', async () => {
    const result = await rtkCommandForCapabilityBash('git status', {
      cwd: root,
      structuredCaller: false,
      flagEnabled: flagOn,
      env: { [RTK_BIN_ENV]: fakeRtk, PATH: '/usr/bin' },
    });
    expect(result.command).toBe('rtk git status');
    expect(result.env).toEqual({ ...RTK_SESSION_ENV, PATH: `${binDir}${delimiter}/usr/bin` });
  });

  it('adds no PATH when the binary directory is already on it', async () => {
    const result = await rtkCommandForCapabilityBash('git status', {
      cwd: root,
      structuredCaller: false,
      flagEnabled: flagOn,
      env: { [RTK_BIN_ENV]: fakeRtk, PATH: `/usr/bin${delimiter}${binDir}` },
    });
    expect(result.command).toBe('rtk git status');
    expect(result.env).toEqual(RTK_SESSION_ENV);
  });

  it('WI-6554700010009529: a rewritten command always carries the hook-nag suppression', async () => {
    // RTK otherwise prints `[rtk] /!\ No hook installed — run `rtk init -g`` into
    // the agent's output, telling it to install a competing hook.
    expect(RTK_SESSION_ENV).toEqual({ RTK_SUPPRESS_HOOK_WARNING: '1' });
    for (const PATH of ['/usr/bin', `/usr/bin${delimiter}${binDir}`]) {
      const result = await rtkCommandForCapabilityBash('git status', {
        cwd: root,
        structuredCaller: false,
        flagEnabled: flagOn,
        env: { [RTK_BIN_ENV]: fakeRtk, PATH },
      });
      expect(result.env?.RTK_SUPPRESS_HOOK_WARNING).toBe('1');
    }
  });

  it('structured callers get the verbatim command without touching rtk or the flag', async () => {
    const result = await rtkCommandForCapabilityBash('git status', {
      cwd: root,
      structuredCaller: true,
      flagEnabled: flagOn,
      env: { [RTK_BIN_ENV]: fakeRtk },
    });
    expect(result).toEqual({ command: 'git status', outcome: { kind: 'unchanged', reason: 'structured-caller' } });
    expect(flagOn).not.toHaveBeenCalled();
  });

  it('the kill-switch flag OFF, or a flag read that throws, runs the original', async () => {
    for (const flagEnabled of [async () => false, async () => Promise.reject(new Error('flag store down'))]) {
      const result = await rtkCommandForCapabilityBash('git status', {
        cwd: root,
        structuredCaller: false,
        flagEnabled,
        env: { [RTK_BIN_ENV]: fakeRtk },
      });
      expect(result).toEqual({ command: 'git status', outcome: { kind: 'unchanged', reason: 'flag-off' } });
    }
  });

  it('with no binary, reports rtk-missing and never reads the flag', async () => {
    const result = await rtkCommandForCapabilityBash('git status', {
      cwd: root,
      structuredCaller: false,
      flagEnabled: flagOn,
      env: { [RTK_BIN_ENV]: '' },
    });
    expect(result.outcome).toEqual({ kind: 'unchanged', reason: 'rtk-missing' });
    expect(flagOn).not.toHaveBeenCalled();
  });
});

function makeCtx(projectDir: string, extra: Record<string, unknown> = {}) {
  return {
    projectDir,
    stateDir: projectDir,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
    ...extra,
  } as never;
}

function spawned(): { command: string; originalCommand?: string; env?: Record<string, string> } {
  return vi.mocked(startBackground).mock.calls[0]![0] as never;
}

describe('capability:bash — RTK at the spawn seam', () => {
  it.each([false, true])('RTK budget identity: passes the authorized original separately from the spawned rewrite (background=%s)', async (run_in_background) => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    const command = 'npm run test:e2e:isolated -- e2e/content-reading.spec.ts';
    const result = await bash.handler({
      command, cwd: root, run_in_background,
      // This is a server-owned RunOptions field, never trusted from tool input.
      originalCommand: 'printf caller-forged-identity',
    }, makeCtx(root));
    expect(spawned().command).toBe('rtk test -- npm run test:e2e:isolated -- e2e/content-reading.spec.ts');
    expect(spawned().originalCommand).toBe(command);
    expect(result.content[0]!.text).toContain(RTK_RESULT_NOTE);
  });

  it('spawns the RTK form, adds the rtk directory to PATH, and says so in the result', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    const result = await bash.handler({ command: 'git status', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('rtk git status');
    expect(spawned().env?.PATH?.split(delimiter)[0]).toBe(binDir);
    // WI-6554700010009529: the spawned child gets the hook-nag suppression.
    expect(spawned().env?.RTK_SUPPRESS_HOOK_WARNING).toBe('1');
    expect(result.content[0]!.text).toContain(RTK_RESULT_NOTE);
  });

  it('keeps compound commands intact (cd prefix preserved)', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    await bash.handler({ command: 'cd /tmp && git status', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('cd /tmp && rtk git status');
  });

  it('runs the original command, with no note, when rtk has no equivalent', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    const result = await bash.handler({ command: 'echo hi', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('echo hi');
    expect(result.content[0]!.text).not.toContain(RTK_RESULT_NOTE);
  });

  it('never rewrites for a code-mode caller, whose script parses the output', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    await bash.handler({ command: 'git status', cwd: root }, makeCtx(root, { codeMode: true }));
    expect(spawned().command).toBe('git status');
  });

  it('never rewrites a vitest command (EI-9471)', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    await bash.handler({ command: 'npx vitest run a.test.ts', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('npx vitest run a.test.ts');
  });

  it('runs verbatim when the kill-switch flag is OFF', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    flags.rtkOn = false;
    const result = await bash.handler({ command: 'git status', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('git status');
    expect(result.content[0]!.text).not.toContain(RTK_RESULT_NOTE);
  });

  it('runs verbatim when no rtk binary is available', async () => {
    process.env[RTK_BIN_ENV] = '';
    await bash.handler({ command: 'git status', cwd: root }, makeCtx(root));
    expect(spawned().command).toBe('git status');
  });

  it('reports the RTK note on an explicit background launch too', async () => {
    process.env[RTK_BIN_ENV] = fakeRtk;
    const result = await bash.handler({ command: 'git status', cwd: root, run_in_background: true }, makeCtx(root));
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, rtk: RTK_RESULT_NOTE });
    expect(spawned().command).toBe('rtk git status');
  });
});
