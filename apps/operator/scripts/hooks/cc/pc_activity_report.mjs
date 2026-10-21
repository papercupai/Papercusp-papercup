/**
 * pc_activity_report — the shared node plumbing for a Claude hook that records ONE
 * `activity:report` row (harness_shared.agent_activity) and must never alter or
 * slow the session (plan client-native-features-adoption-2026-10-21 P-003).
 *
 * Imported, never executed, so installed 0644 (CC_HOOK_LIB_FILES). Every export is
 * fail-open: a missing token, an unreachable operator or a malformed stdin answers
 * an empty / false value and never throws.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspHome } from './pc_home.mjs';

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
 * Returns true when the operator answered 2xx; never throws.
 * @param {{ owner: string } & Record<string, unknown> | null | undefined} args
 * @param {{ env?: NodeJS.ProcessEnv, token: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<boolean>}
 */
export async function postActivityReport(args, { env = process.env, token, fetchImpl = fetch }) {
  if (!args || !token) return false;
  const params = new URLSearchParams({ superuser: '1', origin: 'hook', client: args.owner });
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
    return res.ok;
  } catch {
    return false;
  }
}
