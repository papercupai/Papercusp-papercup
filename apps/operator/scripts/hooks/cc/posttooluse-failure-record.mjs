#!/usr/bin/env node
/**
 * posttooluse-failure-record — the Claude `PostToolUseFailure` hook (plan
 * client-native-features-adoption-2026-10-21 P-003, requirement R-3).
 *
 * A native tool call that FAILS fires `PostToolUseFailure` INSTEAD of
 * `PostToolUse`, so the PostToolUse activity hook never sees it and the fleet view
 * showed the call as if it never finished. This hook records it durably: ONE
 * `activity:report` row in harness_shared.agent_activity carrying the tool name
 * (`tool_name`), the session (`session_id`) and the failure (`status` plus the
 * error text in `summary`).
 *
 * Payload (Claude Code 2.1.293, read from the shipped binary): the common hook
 * fields (`session_id`, `transcript_path`, `cwd`, …) plus
 *   hook_event_name: "PostToolUseFailure", tool_name, tool_input, tool_use_id,
 *   error, is_interrupt, duration_ms.
 * Output and exit code are ignored.
 *
 * Shape (plan Decision, P-003): `kind:'tool'`, `phase:'post'`, the tool's own name
 * and use id, so the row sits in the tool stream next to its PreToolUse row. The
 * error goes in `summary` because, with `tool_name` set, the server derives the
 * row's `detail` from the tool input (activity-bridge summariseActivity) and would
 * drop an error carried there. `tool_input` is reduced to its scalar fields, each
 * clipped, so a failed Write of a large file cannot bloat the report.
 *
 * FAIL-OPEN + SILENT: stdout is always empty and the exit always 0. Scope guard:
 * psu sessions only (PAPERCUSP_SID + the superuser token), and never a CLI nested
 * inside another agent (it inherited the su's PAPERCUSP_SID).
 */
import { clip, postActivityReport, readHookStdin, readSuperuserToken, str } from './pc_activity_report.mjs';
import { nestedCliCached } from './pc_nested_cli.mjs';

export const TOOL_FAILURE_SUMMARY_PREFIX = '✖ tool failed';
export const TOOL_INTERRUPT_SUMMARY_PREFIX = '⏹ tool interrupted';
const STDIN_TIMEOUT_MS = 500;
const ERROR_CAP = 400;
const SUMMARY_CAP = 500;
const INPUT_FIELD_CAP = 512;
const INPUT_MAX_FIELDS = 20;

/**
 * The scalar fields of a tool input, strings clipped — enough for the server to
 * name what the call touched (a file path, a command) without shipping its body.
 * @param {unknown} input
 * @returns {Record<string, string | number | boolean>}
 */
export function reduceToolInput(input) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(input)) {
    if (n >= INPUT_MAX_FIELDS) break;
    if (typeof value === 'string') out[key] = clip(value, INPUT_FIELD_CAP);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else continue;
    n += 1;
  }
  return out;
}

/**
 * The `activity:report` arguments for one PostToolUseFailure payload, or null when
 * there is nothing to record (not a psu session, another event, no session id or
 * no tool name). Pure: no I/O.
 * @param {Record<string, unknown> | null | undefined} hook
 * @param {NodeJS.ProcessEnv} env
 */
export function buildToolFailureReport(hook, env) {
  const owner = (env.PAPERCUSP_SID || '').trim();
  if (!owner || !hook || typeof hook !== 'object') return null;
  const event = str(hook.hook_event_name ?? hook.hookEventName);
  if (event && event !== 'PostToolUseFailure') return null;
  const sessionId = str(hook.session_id ?? hook.sessionId);
  const toolName = str(hook.tool_name ?? hook.toolName);
  if (!sessionId || !toolName) return null;
  const interrupted = hook.is_interrupt === true || hook.isInterrupt === true;
  const error = clip(str(hook.error) || 'unknown error', ERROR_CAP);
  const toolUseId = str(hook.tool_use_id ?? hook.toolUseId);
  const cwd = str(hook.cwd);
  const prefix = interrupted ? TOOL_INTERRUPT_SUMMARY_PREFIX : TOOL_FAILURE_SUMMARY_PREFIX;
  return {
    owner,
    agent: clip((env.PAPERCUSP_AGENT || 'claude').trim().toLowerCase(), 32),
    session_id: clip(sessionId, 256),
    kind: 'tool',
    phase: 'post',
    status: interrupted ? 'interrupted' : 'error',
    tool_name: clip(toolName, 128),
    ...(toolUseId ? { tool_use_id: clip(toolUseId, 256) } : {}),
    tool_input: reduceToolInput(hook.tool_input ?? hook.toolInput),
    summary: clip(`${prefix}: ${toolName} — ${error}`, SUMMARY_CAP),
    ...(cwd ? { cwd: clip(cwd, 1024) } : {}),
  };
}

async function main() {
  try {
    const env = process.env;
    if (!env.PAPERCUSP_SID) return;
    const token = readSuperuserToken(env);
    if (!token) return;
    if (nestedCliCached({ env })) return;
    const raw = await readHookStdin(STDIN_TIMEOUT_MS);
    const hook = raw.trim() ? JSON.parse(raw) : null;
    await postActivityReport(buildToolFailureReport(hook, env), { env, token });
  } catch {
    // Fail silent: a missed failure record must never alter or slow the session.
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('posttooluse-failure-record.mjs');
if (invokedDirectly) main().finally(() => process.exit(0));
