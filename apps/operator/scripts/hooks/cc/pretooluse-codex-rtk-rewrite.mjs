#!/usr/bin/env node
/**
 * PreToolUse (Codex, matcher "^Bash$") — RTK output compression for Codex's
 * native shell (WI-6554700010009447, owner directives #1759/#1764).
 *
 * Claude's native Bash gets RTK through pretooluse-restricted-egress-guard.mjs,
 * and capability:bash applies it server-side. Managed Codex homes had neither,
 * so Codex's own shell ran every command verbatim. This hook closes that gap
 * with the SAME rewrite policy: it reuses rtkRewriteSync from the egress guard
 * (vitest exclusion per EI-9471, the RTK_DISABLED=1 opt-out, the size cap, the
 * 2s timeout, PAPERCUSP_RTK_BIN override/disable, fail-open on a missing or
 * failing binary). It does NOT run `rtk hook codex`, whose rules differ.
 *
 * Codex's contract (codex-cli 0.162.1, read from codex-rs at tag rust-v0.162.1):
 *   - Every shell handler (exec_command / unified exec / shell) reports
 *     tool_name "Bash" with tool_input.command a string (core/src/tools/
 *     hook_names.rs, HookToolName::bash). Shell calls nested inside a code-mode
 *     `exec` script dispatch through the same registry path and fire this hook.
 *   - updatedInput is applied ONLY when permissionDecision is "allow"
 *     (hooks/src/engine/output_parser.rs parse_pre_tool_use). Claude accepts a
 *     bare updatedInput; Codex silently ignores one. That is why this hook does
 *     not reuse the egress guard's output shape.
 *   - updatedInput must carry a string `command` (core/src/tools/handlers/
 *     mod.rs), which replaces the call's `cmd`.
 *   - When several hooks return updatedInput, the last one to finish wins
 *     (pre_tool_use.rs latest_updated_input). This must stay the ONLY Codex
 *     hook that rewrites a shell command; the others only deny. Any deny still
 *     wins over this rewrite.
 *   - "allow" grants nothing extra here: managed Codex homes run with
 *     approval_policy = "never" and sandbox_mode = "danger-full-access".
 *
 * CODE-MODE NESTED CALLS ARE LEFT VERBATIM. A shell call made from inside a
 * code-mode `exec` script reaches this hook with tool_use_id `exec-<uuid>`
 * (core/src/tools/code_mode/delegate.rs mints `{PUBLIC_TOOL_NAME}-{uuid}`, and
 * the registry passes invocation.call_id as tool_use_id). A direct model call
 * carries the API's `call_*` id. A script reads that output before the model
 * does and may parse it (git status --porcelain, cat file.json), so it gets the
 * verbatim command: the same structured-caller rule capability:bash follows
 * (capability/rtk-rewrite.ts). Measured 2026-10-12 over 24h of agent_activity:
 * 52,628 nested Codex Bash calls against 19 direct ones.
 *
 * Registered by writeCodexLockHooks (packages/operator-core/lib/role-codex-home.ts).
 * Copied by both installers: install-standalone-mcp.sh (enumerates hooks/cc) and
 * the desktop installer list in desktop-install/papercusp-files.ts.
 */
import { rtkRewriteSync } from './pretooluse-restricted-egress-guard.mjs';

const STDIN_TIMEOUT_MS = 2000;

/** Codex's hook name for its shell handlers. */
export const CODEX_SHELL_TOOL = 'Bash';
export const CODEX_RTK_MATCHER = '^Bash$';
export const CODEX_RTK_REASON = 'RTK output compression (WI-6554700010009447)';
/** tool_use_id prefix of a shell call made from inside a code-mode `exec` script. */
export const CODEX_CODE_MODE_CALL_PREFIX = 'exec-';

/**
 * Whether this call came from a code-mode script rather than the model.
 * @param {unknown} toolUseId
 */
export function isCodeModeNestedCall(toolUseId) {
  return typeof toolUseId === 'string' && toolUseId.startsWith(CODEX_CODE_MODE_CALL_PREFIX);
}

/**
 * The Codex PreToolUse output for one tool call, or null to leave the call as is.
 * @param {{ toolName: string, toolInput?: Record<string, unknown>, toolUseId?: string, cwd?: string,
 *   env?: NodeJS.ProcessEnv, rtk?: (command: string) => string | null }} params
 * @returns {{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
 *   permissionDecisionReason: string, updatedInput: Record<string, unknown> } } | null}
 */
export function decideCodexRtk({ toolName, toolInput, toolUseId, cwd, env = process.env, rtk }) {
  if (toolName !== CODEX_SHELL_TOOL) return null;
  if (isCodeModeNestedCall(toolUseId)) return null;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : null;
  const command = input && typeof input.command === 'string' ? input.command : null;
  if (!command) return null;
  const rewritten = (rtk ?? ((c) => rtkRewriteSync(c, { env, cwd })))(command);
  if (!rewritten || rewritten === command) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: CODEX_RTK_REASON,
      updatedInput: { ...input, command: rewritten },
    },
  };
}

function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  const raw = await readStdin(STDIN_TIMEOUT_MS);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const out = decideCodexRtk({
    toolName: String(payload.tool_name ?? ''),
    toolInput: payload.tool_input,
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
  });
  if (out) process.stdout.write(JSON.stringify(out));
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('pretooluse-codex-rtk-rewrite.mjs');
if (invokedDirectly) {
  main().catch(() => {
    // Fail open: a crashed rewrite leaves the command exactly as the model wrote it.
  });
}
