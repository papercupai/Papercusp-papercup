/**
 * Codex PreToolUse RTK rewrite (WI-6554700010009447, owner #1759/#1764).
 *
 * Pins the parts of Codex's hook contract this hook depends on (codex-cli
 * 0.162.1): a rewrite is applied only when permissionDecision is "allow", the
 * shell tool is named "Bash", and updatedInput must carry a string `command`.
 * Also pins that the rewrite policy is the SAME one Claude's native Bash uses
 * (rtkRewriteSync from the egress guard), including the vitest exclusion.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_CODE_MODE_CALL_PREFIX,
  CODEX_RTK_MATCHER,
  CODEX_SHELL_TOOL,
  decideCodexRtk,
  isCodeModeNestedCall,
} from '../pretooluse-codex-rtk-rewrite.mjs';
import { RTK_BIN_ENV } from '../pretooluse-restricted-egress-guard.mjs';

const HOOK = fileURLToPath(new URL('../pretooluse-codex-rtk-rewrite.mjs', import.meta.url));

/** A stand-in for `rtk rewrite <cmd>` covering the exit codes rtk uses. */
function fakeRtk() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rtk-'));
  const bin = join(dir, 'rtk');
  writeFileSync(
    bin,
    `#!/bin/sh
[ "$1" = rewrite ] || exit 64
case "$2" in
  "git status") echo "rtk git status"; exit 0 ;;
  "cd /tmp && git log -n 3") echo "cd /tmp && rtk git log -n 3"; exit 3 ;;
  "rg -n x . | "*) echo "rtk $2"; exit 0 ;;
  deny*) exit 2 ;;
  *vitest*) echo "rtk vitest"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('decideCodexRtk', () => {
  const rtk = (command: string) => (command.startsWith('git ') ? `rtk ${command}` : null);

  it('returns allow + updatedInput, the only shape Codex applies a rewrite from', () => {
    const out = decideCodexRtk({ toolName: 'Bash', toolInput: { command: 'git status' }, rtk });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('RTK'),
        updatedInput: { command: 'rtk git status' },
      },
    });
  });

  it('keeps the other tool_input fields beside the rewritten command', () => {
    const out = decideCodexRtk({
      toolName: 'Bash',
      toolInput: { command: 'git status', workdir: '/tmp', timeout_ms: 5000 },
      rtk,
    });
    expect(out?.hookSpecificOutput.updatedInput).toEqual({
      command: 'rtk git status',
      workdir: '/tmp',
      timeout_ms: 5000,
    });
  });

  it('leaves the call alone when rtk has no equivalent or returns the same command', () => {
    expect(decideCodexRtk({ toolName: 'Bash', toolInput: { command: 'echo hi' }, rtk })).toBeNull();
    expect(decideCodexRtk({ toolName: 'Bash', toolInput: { command: 'git x' }, rtk: (c) => c })).toBeNull();
  });

  it('only rewrites the Bash tool with a string command', () => {
    const spy = (command: string) => `rtk ${command}`;
    expect(decideCodexRtk({ toolName: 'apply_patch', toolInput: { command: 'git status' }, rtk: spy })).toBeNull();
    expect(decideCodexRtk({ toolName: 'Bash', toolInput: { command: ['bash', '-lc', 'ls'] }, rtk: spy })).toBeNull();
    expect(decideCodexRtk({ toolName: 'Bash', toolInput: undefined, rtk: spy })).toBeNull();
  });

  it('rewrites a direct model call but leaves a code-mode script call verbatim (its script parses the output)', () => {
    const spy = (command: string) => `rtk ${command}`;
    const direct = decideCodexRtk({
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      toolUseId: 'call_Ab12',
      rtk: spy,
    });
    expect(direct?.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git status' });
    const nested = decideCodexRtk({
      toolName: 'Bash',
      toolInput: { command: 'git status --porcelain' },
      toolUseId: 'exec-3f0c1c9e-8a4b-4d6c-9f8e-2b7a1d0e5c44',
      rtk: spy,
    });
    expect(nested).toBeNull();
    // The prefix is codex's `{PUBLIC_TOOL_NAME}-{uuid}` for nested calls (code_mode/delegate.rs).
    expect(CODEX_CODE_MODE_CALL_PREFIX).toBe('exec-');
    expect(isCodeModeNestedCall('exec-1')).toBe(true);
    expect(isCodeModeNestedCall('call_exec-1')).toBe(false);
    expect(isCodeModeNestedCall(undefined)).toBe(false);
  });

  it('names the tool Codex reports for every shell handler', () => {
    expect(CODEX_SHELL_TOOL).toBe('Bash');
    expect(new RegExp(CODEX_RTK_MATCHER).test('Bash')).toBe(true);
    expect(new RegExp(CODEX_RTK_MATCHER).test('apply_patch')).toBe(false);
    expect(new RegExp(CODEX_RTK_MATCHER).test('mcp__papercusp_su__capability_bash')).toBe(false);
  });

  it('uses the same rewrite policy as Claude Bash: rtk exit 0/3 rewrite, vitest and denials pass through', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      const cmd = (command: string) =>
        decideCodexRtk({ toolName: 'Bash', toolInput: { command }, env })?.hookSpecificOutput.updatedInput.command ?? null;
      expect(cmd('git status')).toBe('rtk git status');
      expect(cmd('cd /tmp && git log -n 3')).toBe('cd /tmp && rtk git log -n 3');
      expect(cmd('npx vitest run a.test.ts')).toBeNull();
      expect(cmd('deny this')).toBeNull();
      expect(cmd('echo hi')).toBeNull();
      expect(cmd('RTK_DISABLED=1 git status')).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('leaves a pipe into head alone, though rtk would rewrite it (WI-6554700010009543)', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      const cmd = (command: string) =>
        decideCodexRtk({ toolName: 'Bash', toolInput: { command }, env })?.hookSpecificOutput.updatedInput.command ?? null;
      // control: the fake rewrites this pipe shape, so a null below is the skip rule, not the fake
      expect(cmd('rg -n x . | tail -5')).toBe('rtk rg -n x . | tail -5');
      expect(cmd('rg -n x . | head -5')).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('fails open when PAPERCUSP_RTK_BIN disables rtk', () => {
    expect(decideCodexRtk({ toolName: 'Bash', toolInput: { command: 'git status' }, env: { [RTK_BIN_ENV]: '' } })).toBeNull();
  });
});

describe('script wiring', () => {
  function run(payload: unknown, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, [RTK_BIN_ENV]: '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  /** A payload with every field Codex's pre-tool-use.command.input schema requires. */
  const codexPayload = (command: string, toolUseId = 'call_1') => ({
    cwd: tmpdir(),
    hook_event_name: 'PreToolUse',
    model: 'gpt-test',
    permission_mode: 'bypassPermissions',
    session_id: 's',
    tool_input: { command },
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    transcript_path: null,
    turn_id: 't',
  });

  it('prints nothing for a code-mode script call, reading tool_use_id from the payload', () => {
    const fake = fakeRtk();
    try {
      const res = run(codexPayload('git status', 'exec-7d1e'), { [RTK_BIN_ENV]: fake.bin });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
    } finally {
      fake.cleanup();
    }
  });

  it('prints a Codex rewrite for a real-shaped Codex payload', () => {
    const fake = fakeRtk();
    try {
      const res = run(codexPayload('git status'), { [RTK_BIN_ENV]: fake.bin });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput).toMatchObject({
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'rtk git status' },
      });
    } finally {
      fake.cleanup();
    }
  });

  it('prints nothing (exit 0) when there is no rewrite, rtk is missing, or stdin is not JSON', () => {
    const fake = fakeRtk();
    try {
      const none = run(codexPayload('echo hi'), { [RTK_BIN_ENV]: fake.bin });
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    } finally {
      fake.cleanup();
    }
    const missing = run(codexPayload('git status'), { [RTK_BIN_ENV]: '/nonexistent/rtk' });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('');
    const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', timeout: 20_000 });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });
});
