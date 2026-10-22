#!/usr/bin/env node
/**
 * stop-failure-record — the Claude `StopFailure` hook (plan
 * client-native-features-adoption-2026-10-21 P-002, requirement R-2).
 *
 * A Claude turn that dies on an API error (rate limit, overload, auth, billing,
 * server error, …) fires `StopFailure` INSTEAD of `Stop`, so the Stop hooks —
 * including the per-turn journal — never see it and the turn was invisible.
 * This hook records it durably: ONE `activity:report` row in
 * harness_shared.agent_activity naming the session (`session_id`), the error kind
 * (`detail.error`, also in the summary) and the time (`created_at`).
 *
 * Payload (Claude Code 2.1.293, read from the shipped binary): the common hook
 * fields (`session_id`, `transcript_path`, `cwd`, …) plus
 *   hook_event_name: "StopFailure", error: <kind, default "unknown">,
 *   error_details: <optional>, last_assistant_message: <optional>.
 * Output and exit code are ignored by Claude for this event.
 *
 * Reuse, not a new ledger: `kind:'lifecycle'` with a summary that matches neither
 * session marker is a stored row with NO lifecycle side effect (activity/report.ts
 * lifecyclePhase → null), and a report with no tool_name stores `tool_input` as the
 * row's structured `detail` (activity-bridge summariseActivity).
 *
 * FAIL-OPEN: stdout is always empty and the exit always 0. Unconfirmed reports
 * are preserved by the shared helper with a stderr recovery-path diagnostic. Scope guard:
 * psu sessions only (PAPERCUSP_SID + the superuser token), and never a CLI nested
 * inside another agent (it inherited the su's PAPERCUSP_SID).
 */
import { clip, postActivityReport, readHookStdin, readSuperuserToken, str } from './pc_activity_report.mjs';
export { operatorBase } from './pc_activity_report.mjs';
import { nestedCliCached } from './pc_nested_cli.mjs';

export const STOP_FAILURE_SUMMARY_PREFIX = '✖ turn failed on API error';
const STDIN_TIMEOUT_MS = 500;
const DETAILS_CAP = 400;
const SUMMARY_CAP = 500;

/**
 * The `activity:report` arguments for one StopFailure payload, or null when there
 * is nothing to record (not a psu session, not a StopFailure, no session id).
 * Pure: no I/O.
 * @param {Record<string, unknown> | null | undefined} hook
 * @param {NodeJS.ProcessEnv} env
 */
export function buildStopFailureReport(hook, env) {
  const owner = (env.PAPERCUSP_SID || '').trim();
  if (!owner || !hook || typeof hook !== 'object') return null;
  const event = str(hook.hook_event_name ?? hook.hookEventName);
  if (event && event !== 'StopFailure') return null;
  const sessionId = str(hook.session_id ?? hook.sessionId);
  if (!sessionId) return null;
  const error = clip(str(hook.error) || 'unknown', 64);
  const details = clip(str(hook.error_details ?? hook.errorDetails), DETAILS_CAP);
  const cwd = str(hook.cwd);
  const summary = clip(`${STOP_FAILURE_SUMMARY_PREFIX}: ${error}${details ? ` — ${details}` : ''}`, SUMMARY_CAP);
  return {
    owner,
    agent: clip((env.PAPERCUSP_AGENT || 'claude').trim().toLowerCase(), 32),
    session_id: clip(sessionId, 256),
    kind: 'lifecycle',
    status: 'error',
    summary,
    tool_input: {
      hook_event_name: 'StopFailure',
      error,
      ...(details ? { error_details: details } : {}),
    },
    ...(cwd ? { cwd: clip(cwd, 1024) } : {}),
  };
}

/**
 * POST the report to the operator's MCP endpoint. Returns true when the operator
 * confirmed an inserted row; otherwise preserves the undelivered report.
 * @param {ReturnType<typeof buildStopFailureReport>} args
 * @param {{ env?: NodeJS.ProcessEnv, token: string, fetchImpl?: typeof fetch }} opts
 */
export async function postStopFailureReport(args, { env = process.env, token, fetchImpl = fetch }) {
  return postActivityReport(args, { env, token, fetchImpl });
}

async function main() {
  try {
    const env = process.env;
    if (!env.PAPERCUSP_SID) return;
    if (nestedCliCached({ env })) return;
    const token = readSuperuserToken(env);
    const raw = await readHookStdin(STDIN_TIMEOUT_MS);
    const hook = raw.trim() ? JSON.parse(raw) : null;
    await postStopFailureReport(buildStopFailureReport(hook, env), { env, token });
  } catch {
    // Fail silent: a missed failure record must never alter or slow the session.
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('stop-failure-record.mjs');
if (invokedDirectly) main().finally(() => process.exit(0));
