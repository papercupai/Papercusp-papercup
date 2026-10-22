/**
 * pc_activity_report — the shared node plumbing for a Claude hook that records ONE
 * `activity:report` row (harness_shared.agent_activity) and must never alter or
 * slow the session (plan client-native-features-adoption-2026-10-21 P-003).
 *
 * Imported, never executed, so installed 0644 (CC_HOOK_LIB_FILES). Every export is
 * fail-open: a missing token, an unreachable operator or a malformed stdin answers
 * an empty / false value and never throws.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { papercuspHome } from './pc_home.mjs';
import { parseManagedCarryResponse } from './precompact-managed-carry.mjs';

const REPORT_TIMEOUT_MS = 4000;

/** A trimmed string form of any hook field; structured values are JSON-serialized.
 * @param {unknown} v @returns {string} */
export function str(v) {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Cap `s` at `n` characters, marking a cut with an ellipsis.
 * @param {string} s @param {number} n @returns {string} */
export function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The operator base URL a hook posts to.
 * @param {NodeJS.ProcessEnv} env @returns {string} */
export function operatorBase(env) {
  return (env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\/+$/, '');
}

/** The superuser token, or '' when none is readable.
 * @param {NodeJS.ProcessEnv} env @returns {string} */
export function readSuperuserToken(env) {
  try {
    return readFileSync(join(papercuspHome(env), 'superuser-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** The hook's stdin, or '' after `timeoutMs` (a hook must never hang on stdin).
 * @param {number} timeoutMs @returns {Promise<string>} */
export function readHookStdin(timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
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

/**
 * POST one `activity:report` call to the operator's MCP endpoint as `args.owner`.
 * Returns true only for a confirmed inserted row. Reuses the managed hook MCP
 * parser (JSON/SSE, structuredContent, text content). Undelivered records are
 * retained privately in hook-state for recovery; stdout and exit remain silent.
 * @param {{ owner: string } & Record<string, unknown> | null | undefined} args
 * @param {{ env?: NodeJS.ProcessEnv, token: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<boolean>}
 */
export async function postActivityReport(args, { env = process.env, token, fetchImpl = fetch }) {
  if (!args) return false;
  const failed = (reason) => {
    preserveUndeliveredActivity(args, env, reason);
    return false;
  };
  if (!token) return failed('superuser token unavailable');
  const params = new URLSearchParams({ superuser: '1', origin: 'hook', client: args.owner, format: 'json' });
  if (env.PAPERCUSP_WORKSPACE) params.set('workspace', env.PAPERCUSP_WORKSPACE);
  try {
    const res = await fetchImpl(`${operatorBase(env)}/api/mcp?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'activity:report', arguments: args },
      }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (!res.ok) return failed(`HTTP ${res.status}`);
    let raw = await res.text();
    // Accept pretty JSON as well as the parser's line-delimited SSE frames.
    try { raw = JSON.stringify(JSON.parse(raw)); } catch { /* SSE */ }
    const parsed = parseManagedCarryResponse(raw);
    const body = parsed.inner;
    if (parsed.ok && !parsed.isError && body?.ok === true &&
        body.id != null && String(body.id).trim() && !body.dropped) return true;
    return failed(parsed.detail || 'operator did not confirm an inserted activity row');
  } catch (error) {
    return failed(String(error?.message ?? error));
  }
}

/** Preserve a failed report, never a token. This is evidence for recovery, not
 * a successful server insertion or an automatic retry (which could duplicate a
 * row after a lost acknowledgement). */
function preserveUndeliveredActivity(args, env, reason) {
  try {
    const dir = join(papercuspHome(env), 'hook-state', 'undelivered-activity');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ recordedAt: new Date().toISOString(), reason, args }),
      { mode: 0o600, flag: 'wx' });
    process.stderr.write(`papercusp: activity report unconfirmed; preserved at ${path}\n`);
  } catch {
    try { process.stderr.write('papercusp: activity report unconfirmed; could not preserve recovery record\n'); } catch { /* fail open */ }
  }
}
