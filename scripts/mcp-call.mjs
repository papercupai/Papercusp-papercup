#!/usr/bin/env node
/**
 * mcp-call — recover-now access to the operator MCP when the Claude Code
 * papercusp-su client has dropped (EI-1740 / EI-1750; runbook:
 * agent-insights/mcp-client-drop-curl-recovery). The server stays healthy when
 * the client disconnects; this drives it directly via a single-shot stateless
 * `tools/call` over the streamable-HTTP endpoint with the superuser bearer.
 *
 * Standardizes the technique several auto-mode agents were hand-rolling in
 * /tmp (and colliding on the same path) — pass your OWN --client so coord/plan
 * writes attribute correctly.
 *
 * Usage:
 *   node scripts/mcp-call.mjs <tool> [jsonArgs] [--json -|--json-file <path>] [--client <id>|--client=<id>] [--workspace <ws>|--workspace=<ws>] [--all-workspaces] [--harness <h>|--harness=<h>] [--port <n>|--port=<n>] [--idempotency-key <key>|--idempotency-key=<key>] [--raw] [--allow-partial]
 * Examples:
 *   node scripts/mcp-call.mjs coord:whoami
 *   node scripts/mcp-call.mjs work_items:get '{"id":"EI-1750"}' --harness papercup
 *   printf '%s\n' '{"id":"EI-1750","summary":"it's safe"}' | node scripts/mcp-call.mjs work_items:complete --json - --harness papercup
 *   node scripts/mcp-call.mjs work_items:complete --json-file payload.json --harness papercup
 *   node scripts/mcp-call.mjs plans:search '{"query":"infra","harness":"papercup"}' --client su-1234
 *   node scripts/mcp-call.mjs knowledge_packs:list --json-file payload.json --all-workspaces --client su-1234
 *
 * Prefer `--json -` or `--json-file <path>` for payloads containing apostrophes
 * or other shell-hostile text; the positional JSON form remains for compact,
 * quote-free arguments.
 *
 * Notes: tool names use COLONS (coord:whoami, plans:new, work_items:set_state —
 * arg is `itemId` not `item`). `tools/list` returns empty in this mode, but
 * `tools/call` reaches every tool. Reads the bearer from ~/.papercusp/superuser-token.
 * For an unknown-outcome retry, pass the same `--idempotency-key` value; it is
 * sent as transport metadata (`_meta.idempotencyKey`), not as a tool argument.
 *
 * Exit status: 0 the tool answered and did not report failure; 1 JSON-RPC or
 * tool error (isError), or no usable response; 2 usage or bad JSON arguments;
 * 3 no superuser token; 4 no operator endpoint reachable; 5 the tool ANSWERED
 * ok:false (top-level, or any `results[]` entry). The result is still printed
 * in full on stdout, so a caller that judges the answer itself can accept 5.
 * `--raw` prints the transport body unjudged and never exits 5.
 * A door-projected PARTIAL result (root `_partial`, or a value that is an
 * '[omitted: … see _projection.cursor]' placeholder) exits 6 after printing, unless
 * `--allow-partial` is given (EI-24678010189721217).
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The JSON-RPC id we send; parseSse selects the frame that answers it. */
const REQUEST_ID = 1;

/**
 * Exit status when the delivered result reports a refusal or output error: a
 * refused write, a missing id, or a partially failed batch. The result is still
 * printed in full on stdout. This matches ptool's PTOOL_TOOL_NOT_OK_EXIT, so a
 * script can tell "refused" (5) from "failed or unreachable" (1-4) with either
 * driver. Before this, an ok:false answer exited 0, and every
 * `mcp-call … || fail` guard silently passed a refused write
 * (EI-24654733539966460).
 */
export const MCP_CALL_TOOL_NOT_OK_EXIT = 5;

/**
 * Why a parsed tool result reports failure, or null when it does not. It fails
 * when its top-level `ok` is false, any entry of a `results` batch has
 * `ok: false`, or the canonical output envelope reports `state: 'error'`.
 * Other bodies without `ok` (projections, prose, arrays, application states)
 * are not refusals. The ok:false rules match ptool's toolNotOkReason.
 * @param {unknown} result
 * @returns {string | null}
 */
export function toolResultNotOkReason(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const outputError = result.schemaVersion === 'papercusp.output-envelope/v1' && result.state === 'error';
  const results = Array.isArray(result.results) ? result.results : [];
  const failed = results.filter((r) => r && typeof r === 'object' && r.ok === false);
  if (!outputError && result.ok !== false && failed.length === 0) return null;
  const envelopeError = outputError && result.error && typeof result.error === 'object' ? result.error : {};
  const envelopeReason = [envelopeError.code, envelopeError.message]
    .filter((value) => typeof value === 'string' && value.trim()).join(': ');
  const first = failed[0] ?? {};
  const detail = [envelopeReason, result.reason, result.error, result.code, first.error, first.reason, first.code]
    .find((v) => typeof v === 'string' && v.trim()) ?? 'no reason given';
  const reason = outputError ? `output envelope error: ${detail}`
    : failed.length > 0 ? `${failed.length} of ${results.length} result(s) ok:false; first: ${detail}` : detail;
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
}

/**
 * Exit status when the server's output door PROJECTED the result (EI-24678010189721217).
 * A forced projection replaces deep or long values with placeholder strings such as
 * '[omitted: depth limit — recover: see _projection.cursor]'. Those survive JSON.parse
 * and JSON.stringify, so a caller that copies a field (e.g. rubrics:amend dry-run
 * preview.approval into an approval comment) posts the placeholder as if it were data.
 * Measured twice: posts 1151113 (2026-09-30) and 1153517 (2026-10-01), two agents.
 */
export const MCP_CALL_PROJECTED_RESULT_EXIT = 6;

// Anchored on purpose: a value that IS a placeholder, or a string the door cut with a
// trailing TRUNCATED marker. Prose that merely QUOTES a placeholder mid-sentence (an
// issue body describing this trap) is ordinary data and must not trip the guard.
const OMITTED_PLACEHOLDER = /^\[omitted: [^\]]*see _projection\.cursor\]$/;
const TRUNCATED_SUFFIX = /\[TRUNCATED \+[^\]]*see _projection\.cursor\]$/;

/**
 * Why a parsed tool result is a door-projected PARTIAL body, or null when it is
 * complete: a root `_partial: true` / `_projection.truncated: true`, or any value
 * that is a projection placeholder. Names up to five JSON paths so the caller can
 * pick them explicitly.
 * @param {unknown} result
 * @returns {string | null}
 */
export function projectedResultReason(result) {
  if (!result || typeof result !== 'object') return null;
  const rootMarked = !Array.isArray(result)
    && (result._partial === true || (result._projection && result._projection.truncated === true));
  const paths = [];
  const stack = [[result, '$', 0]];
  let visited = 0;
  while (stack.length > 0 && paths.length < 5 && visited < 100_000) {
    const [value, path, depth] = stack.pop();
    visited += 1;
    if (typeof value === 'string') {
      if (OMITTED_PLACEHOLDER.test(value) || TRUNCATED_SUFFIX.test(value)) paths.push(path);
      continue;
    }
    if (!value || typeof value !== 'object' || depth > 64) continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push([value[i], `${path}[${i}]`, depth + 1]);
    } else {
      for (const key of Object.keys(value).reverse()) {
        if (key === '_projection') continue; // the door's own recovery metadata
        stack.push([value[key], `${path}.${key}`, depth + 1]);
      }
    }
  }
  if (!rootMarked && paths.length === 0) return null;
  const where = paths.length > 0 ? `placeholder value(s) at ${paths.join(', ')}` : 'root _partial marker';
  return `door-projected partial result: ${where}`;
}

/**
 * A managed staging restart can leave the explicitly pinned port refused while
 * systemd is rebuilding the host. Keep this recovery path aligned with the
 * always-up MCP proxy's measured restart budget, but only use it for an
 * explicit `--port` pin. An unpinned call must retain its immediate canonical
 * 3070 fallback instead of waiting 90s before discovering that its inherited
 * port hint is stale.
 */
export const MCP_CALL_CONNECTION_RETRY_WINDOW_MS = 90_000;
export const MCP_CALL_CONNECTION_RETRY_DELAY_MS = 1_000;

// Direct mcp-call invocations can bypass the resilient MCP proxy and therefore
// see the operator's pre-dispatch admission response themselves. The response
// is safe to retry: the admission gate rejected the request before the tool
// handler ran. Keep this retry bounded so a genuinely saturated host does not
// turn the recovery helper into another pressure source.
export const MCP_CALL_ADMISSION_MAX_ATTEMPTS = 5;
export const MCP_CALL_ADMISSION_RETRY_DELAY_MS = 1_000;
export const MCP_CALL_ADMISSION_RETRY_MAX_DELAY_MS = 10_000;
const MCP_CALL_ADMISSION_REASONS = new Set([
  'loop_pressure_critical',
  'operator_admission_capacity',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ECONNREFUSED is raised before an HTTP request can reach the operator. */
export function isConnectionRefusedError(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
    seen.add(current);
    if (current.code === 'ECONNREFUSED') return true;
    current = current.cause;
  }
  return false;
}

export function buildFallbackWarning({
  configuredPort,
  port,
  proxyPort,
  configuredPortError,
  authorityFallback = false,
}) {
  const endpoint = port === proxyPort
    ? 'the resilient MCP proxy on port ' + port
    : 'the canonical operator on port ' + port;

  if (authorityFallback) {
    const cause = 'PAPERCUSP_HONO_PORT=' + configuredPort +
      ' answered with a stale session-authority denial; reached ';
    const repair = port === proxyPort
      ? 'unset PAPERCUSP_HONO_PORT or set it to the actual operator port'
      : 'export PAPERCUSP_HONO_PORT=' + port + ' (or unset it)';
    return 'mcp-call: WARNING — ' + cause + endpoint + ' instead. ' +
      "Your environment's port is STALE: " + repair +
      ', or every other tool deriving its URL from that variable will keep failing.';
  }

  if (isConnectionRefusedError(configuredPortError)) {
    if (String(configuredPort) === '3070') {
      return 'mcp-call: WARNING — connection to canonical PAPERCUSP_HONO_PORT=3070 ' +
        'was refused at request time; reached ' + endpoint + ' instead. ' +
        'The environment setting is canonical; verify operator health before changing it.';
    }
    return 'mcp-call: WARNING — no listener accepted a connection on PAPERCUSP_HONO_PORT=' +
      configuredPort + ' at request time; reached ' + endpoint + ' instead. ' +
      'The configured port may be stale or restarting; unset PAPERCUSP_HONO_PORT or set it ' +
      'to the actual operator port only if it has been retired.';
  }

  return 'mcp-call: WARNING — the MCP request through PAPERCUSP_HONO_PORT=' +
    configuredPort + ' did not complete; reached ' + endpoint + ' instead. ' +
    'This does not establish that the port is stale; verify the transport before changing it.';
}

/**
 * Retry only a pre-connect refusal. Retrying resets, HTTP errors, or any other
 * fetch failure could duplicate a POST whose request reached the operator.
 * The injected seams keep the restart-window behavior directly testable.
 */
/**
 * WI-10004231: a caller that bounds this process with its own deadline (vmcall.sh,
 * 30s by default) cannot tell a slow CLIENT start from a slow SERVER answer, because
 * both surface as the same timeout. On same-box run 8 the VM dispatched the call ~1s
 * after vmcall had killed us, and nothing recorded when the request left. When
 * PAPERCUSP_MCP_CALL_SENT_MARKER names a file, stamp the epoch-ms at which the request
 * is handed to fetch, so the caller can classify its timeout. Best-effort: a
 * diagnostic must never fail the call.
 */
export function stampRequestSent(env = process.env, write = writeFileSync, now = Date.now) {
  const marker = env.PAPERCUSP_MCP_CALL_SENT_MARKER;
  if (!marker) return;
  try {
    write(marker, `${now()}\n`);
  } catch {
    // Diagnostic only.
  }
}

/**
 * @param {string | URL | Request} url
 * @param {RequestInit} init
 * @param {{fetchImpl?: typeof fetch, retryWindowMs?: number, retryDelayMs?: number, sleepImpl?: (ms: number) => Promise<unknown>, now?: () => number, onRetry?: (event: {attempt: number, delayMs: number, remainingMs: number}) => void}} [options]
 */
export async function fetchWithConnectionRecovery(
  url,
  init,
  {
    fetchImpl = fetch,
    retryWindowMs = MCP_CALL_CONNECTION_RETRY_WINDOW_MS,
    retryDelayMs = MCP_CALL_CONNECTION_RETRY_DELAY_MS,
    sleepImpl = sleep,
    now = Date.now,
    onRetry,
  } = {},
) {
  const budgetMs = Number.isFinite(retryWindowMs) ? Math.max(0, retryWindowMs) : 0;
  const delayMs = Number.isFinite(retryDelayMs) ? Math.max(1, retryDelayMs) : MCP_CALL_CONNECTION_RETRY_DELAY_MS;
  const deadline = now() + budgetMs;
  let attempt = 0;

  while (true) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (!isConnectionRefusedError(error)) throw error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw error;
      const waitMs = Math.min(delayMs, remainingMs);
      attempt += 1;
      onRetry?.({ attempt, delayMs: waitMs, remainingMs });
      await sleepImpl(waitMs);
    }
  }
}

/**
 * The operator's admission gate emits these errors only before dispatch. Keep
 * the matcher narrower than a generic -32000/429 check so provider failures or
 * tool-level errors are never replayed by this mutation-capable helper.
 */
export function isRetryableAdmissionShed(error, status = 0) {
  const code = Number(error?.code);
  const data = error?.data;
  return (Number(status) === 429 || code === -32000) &&
    data?.retryable === true &&
    typeof data.reason === 'string' &&
    MCP_CALL_ADMISSION_REASONS.has(data.reason);
}

/** Read the server's Retry-After hint, with a bounded fallback for direct calls. */
export function admissionRetryDelayMs(
  response,
  error,
  {
    fallbackMs = MCP_CALL_ADMISSION_RETRY_DELAY_MS,
    maxMs = MCP_CALL_ADMISSION_RETRY_MAX_DELAY_MS,
  } = {},
) {
  const header = response?.headers?.get?.('retry-after');
  const hintedSeconds = header ?? error?.data?.retryAfterSec;
  const seconds = Number(hintedSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.min(maxMs, Math.max(0, Math.ceil(seconds * 1_000)));
}

/**
 * Flags are declared ONCE here, in the camelCase spelling the readers use.
 *
 * The command line spells the only multi-word flag kebab-cased (`--json-file`)
 * while every reader asks for `flags.jsonFile`, so a parser that stored the
 * raw CLI key left that flag permanently undefined — `--json-file` selected no
 * JSON source and the call went out with EMPTY args, surfacing as a schema
 * error about the CALLER's payload rather than a flag error (WI-41249).
 * Normalizing here fixes the whole class rather than that one flag, and the
 * allowlist means a mistyped or renamed flag fails loudly instead of
 * degrading into a silently-empty payload — the same contract the operator
 * tools enforce on undeclared args (EI-10883).
 *
 * `--all-workspaces` is a boolean transport flag, not a tool argument. It
 * explicitly selects the unscoped superuser session (`workspace=*`), which is
 * required for cross-workspace tools when the scoped-superuser clamp is ON.
 */
export const BOOLEAN_FLAGS = new Set(['raw', 'allWorkspaces', 'help', 'allowPartial']);
export const VALUE_FLAGS = new Set(['json', 'jsonFile', 'client', 'workspace', 'harness', 'port', 'idempotencyKey', 'transport']);

/** `json-file` -> `jsonFile`. Leaves an already-camelCase key untouched. */
export function toCamelCaseFlag(key) {
  return key.replace(/-+([a-z0-9])/gi, (_match, char) => char.toUpperCase());
}

/**
 * @typedef {{raw?: boolean, allWorkspaces?: boolean, help?: boolean, allowPartial?: boolean, json?: string, jsonFile?: string, client?: string, workspace?: string, harness?: string, port?: string, idempotencyKey?: string, transport?: string}} McpCallFlags
 * @param {string[]} argv
 * @returns {{tool: string | undefined, jsonArgs: string | undefined, flags: McpCallFlags}}
 */
export function parseArgs(argv) {
  /** @type {McpCallFlags} */
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const rawKey = a.slice(2);
      const equalsAt = rawKey.indexOf('=');
      const cliKey = equalsAt === -1 ? rawKey : rawKey.slice(0, equalsAt);
      const key = toCamelCaseFlag(cliKey);
      if (BOOLEAN_FLAGS.has(key)) {
        if (equalsAt !== -1) throw new Error(`--${cliKey} does not take a value`);
        flags[key] = true;
      } else if (VALUE_FLAGS.has(key)) {
        const value = equalsAt === -1 ? argv[++i] : rawKey.slice(equalsAt + 1);
        if (value === undefined) throw new Error(`--${cliKey} requires a value`);
        flags[key] = value;
      } else {
        const accepted = [...BOOLEAN_FLAGS, ...VALUE_FLAGS].sort().join(', ');
        throw new Error(`unknown flag --${cliKey}; accepted flags: ${accepted}`);
      }
    } else pos.push(a);
  }
  return { tool: pos[0], jsonArgs: pos[1], flags };
}

/**
 * Select the JSON input source. `--json-file` takes priority over `--json`,
 * matching the ptool contract; the legacy positional form remains supported.
 * The source selection is pure so every quoting-safe path is testable without
 * spawning a shell or contacting the operator.
 * @param {{jsonArgs?: string, flags?: McpCallFlags}} [input]
 */
export function jsonSourceKind({ jsonArgs, flags = {} } = {}) {
  if (flags.jsonFile) return 'file';
  if (flags.json === '-') return 'stdin';
  if (flags.json !== undefined) return 'inline';
  if (jsonArgs !== undefined) return 'inline';
  return null;
}

/**
 * Read and parse the selected JSON args source. `readFile` is injectable for
 * tests; descriptor 0 is used for the `--json -` stdin sentinel.
 * @param {{jsonArgs?: string, flags?: McpCallFlags}} [input]
 * @param {{readFile?: (path: string | number, encoding: 'utf8') => string}} [options]
 */
export function readJsonArgs(
  { jsonArgs, flags = {} } = {},
  { readFile = readFileSync } = {},
) {
  const kind = jsonSourceKind({ jsonArgs, flags });
  if (kind === null) return {};

  const label = kind === 'file'
    ? `--json-file ${flags.jsonFile}`
    : kind === 'stdin'
      ? 'stdin'
      : 'inline JSON';
  let jsonText;
  try {
    if (kind === 'file') jsonText = readFile(flags.jsonFile, 'utf8');
    else if (kind === 'stdin') jsonText = readFile(0, 'utf8');
    else jsonText = flags.json ?? jsonArgs;
  } catch (error) {
    throw new Error(`could not read ${label}: ${error?.message ?? error}`);
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error?.message ?? error}`);
  }
}

/**
 * Extract the JSON-RPC result from an SSE stream or a JSON response body.
 *
 * The stream carries frames we did NOT ask for: the server emits
 * `notifications/tools/list_changed` (and friends) BEFORE the response to our
 * `tools/call`. Those are JSON-RPC *notifications* — a `method`, no `id`, no
 * `result`. Returning the first `data:` frame therefore handed callers the
 * notification instead of the tool result, and because the old fallback
 * (`d.result ?? d`) returned the raw frame rather than erroring, it looked like
 * a successful call that answered `{"method":"notifications/tools/list_changed"}`
 * — a well-formed, confidently wrong result on the exact path agents use when
 * the papercusp-su MCP client has dropped. Select the frame that RESPONDS to us
 * (`id` matching the request), never merely the first one.
 */
export function parseSse(raw, requestId = 1) {
  let sawFrame = false;
  // Admission sheds are HTTP 429 JSON-RPC bodies, not SSE frames. Parse both
  // transport shapes so the caller sees the retryable reason from the server.
  const frames = raw.trimStart().startsWith('{')
    ? [raw.trim()]
    : raw.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  for (const frame of frames) {
    let d;
    try { d = JSON.parse(frame); } catch { continue; }
    sawFrame = true;
    // A notification has no id and never answers our call — skip it.
    if (d.id === undefined || d.id === null) continue;
    if (d.id !== requestId) continue;
    if (d.error) return { error: d.error };
    if (!('result' in d)) continue;
    const result = d.result;
    // MCP tool failures are returned as successful JSON-RPC envelopes with
    // `result.isError: true`. Preserve the complete result so main() routes
    // the tool's text to stderr and exits nonzero instead of presenting a
    // refusal as a successful stdout value.
    if (result?.isError === true) return { error: result };
    // A projected result places trust-degrading warnings in a leading text
    // item and keeps the retained JSON body in a following item. Selecting
    // only content[0] turns a valid partial projection into a warning-only
    // response, silently discarding the data the caller asked for.
    const textItems = Array.isArray(result?.content)
      ? result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
      : [];
    for (const item of textItems) {
      try {
        return { result: JSON.parse(item.text) };
      } catch {
        // Advisory text and other human-readable blocks are expected; keep
        // looking for the JSON payload before falling back to plain text.
      }
    }
    if (Object.prototype.hasOwnProperty.call(result ?? {}, 'structuredContent')) {
      return { result: result.structuredContent };
    }
    const firstText = textItems[0]?.text;
    if (firstText !== undefined) {
      return { result: firstText };
    }
    return { result };
  }
  return {
    error: sawFrame
      ? { message: `no JSON-RPC response frame for id ${requestId} in SSE stream`, raw: raw.slice(0, 400) }
      : { message: 'no data: line in SSE response', raw: raw.slice(0, 400) },
  };
}

/**
 * Resolve implicit bearer files in the same order as ptool. An explicit
 * PAPERCUSP_MCP_TOKEN_FILE is authoritative; PAPERCUSP_OPERATOR_HOME names
 * the real operator home, while a workspace-scoped PAPERCUSP_HOME uses the
 * shared per-home token first.
 */
export function superuserTokenPaths(env = process.env, home = homedir()) {
  const explicit = typeof env?.PAPERCUSP_MCP_TOKEN_FILE === 'string'
    ? env.PAPERCUSP_MCP_TOKEN_FILE.trim()
    : '';
  if (explicit) return [explicit];

  const operatorHome = typeof env?.PAPERCUSP_OPERATOR_HOME === 'string'
    ? env.PAPERCUSP_OPERATOR_HOME.trim()
    : '';
  const operator = operatorHome ? join(operatorHome, '.papercusp', 'superuser-token') : null;
  const isolatedHome = typeof env?.PAPERCUSP_HOME === 'string' ? env.PAPERCUSP_HOME.trim() : '';
  const isolated = isolatedHome ? join(isolatedHome, 'superuser-token') : null;
  const shared = join(home, '.papercusp', 'superuser-token');
  const workspaceScoped = /(?:^|[\\/])\.papercusp-workspaces[\\/][^\\/]+(?:[\\/]|$)/.test(isolatedHome);
  const preferred = operator || (workspaceScoped ? shared : isolated) || shared;
  return [...new Set([preferred, shared, isolated].filter(Boolean))];
}

/** The first candidate is used in diagnostics and for legacy callers. */
export function superuserTokenPath(env = process.env, home = homedir()) {
  return superuserTokenPaths(env, home)[0];
}

/** Resolve the local operator port from the configured bare base URL. */
export function resolveOperatorUrlPort(env = process.env) {
  const configuredUrl = typeof env.PAPERCUSP_OPERATOR_URL === 'string'
    ? env.PAPERCUSP_OPERATOR_URL.trim()
    : '';
  if (!configuredUrl) return null;

  let parsed;
  try {
    // The VM-rig deploy copies this CLI by itself to /tmp. Keep the endpoint
    // normalization local so that a repo-relative import cannot break that
    // standalone copy before argument handling starts.
    const base = configuredUrl.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
    parsed = new URL(base);
  } catch {
    throw new Error('PAPERCUSP_OPERATOR_URL must be a valid local operator base URL.');
  }

  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname) ||
      (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(
      'mcp-call only sends the local superuser bearer to a loopback HTTP operator; ' +
      'PAPERCUSP_OPERATOR_URL must be a bare local base URL.',
    );
  }

  return parsed.port || '80';
}

/** Resolve the local resilient MCP proxy port using the same default as ptool. */
export function resolveMcpProxyPort(env = process.env) {
  const DEFAULT_MCP_PROXY_PORT = '9071';
  const envProxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT);
  return Number.isInteger(envProxyPort) && envProxyPort > 0 && envProxyPort <= 65535
    ? String(envProxyPort)
    : DEFAULT_MCP_PROXY_PORT;
}

/** Resolve the operator ports to try. An explicit CLI port is a fail-closed pin;
 * the inherited environment hint retains its recovery fallback to canonical and proxy. */
export function resolveCandidatePorts(flags = {}, env = process.env) {
  const CANONICAL_PORT = '3070';
  if (flags.port !== undefined) {
    const pinned = String(flags.port).trim();
    if (!/^\d+$/.test(pinned) || Number(pinned) < 1 || Number(pinned) > 65535) {
      throw new Error(`--port must be an integer from 1 to 65535 (received ${JSON.stringify(flags.port)})`);
    }
    return { configuredPort: pinned, candidatePorts: [pinned], pinned: true };
  }
  const operatorUrlPort = env.PAPERCUSP_HONO_PORT == null ? resolveOperatorUrlPort(env) : null;
  const configuredPort = env.PAPERCUSP_HONO_PORT ?? operatorUrlPort ?? CANONICAL_PORT;
  const proxyPort = resolveMcpProxyPort(env);
  return {
    configuredPort: String(configuredPort),
    // The local MCP proxy stays up while its operator target restarts. Keep it
    // last so an explicit runtime hint and canonical operator retain precedence.
    candidatePorts: [...new Set([String(configuredPort), CANONICAL_PORT, proxyPort])],
    pinned: false,
  };
}

export function buildSuperuserBearerDiagnostic({ tokenPath, port, tokenFallbackAttempted = false }) {
  return 'mcp-call: the operator on port ' + port + ' rejected the bearer read from ' + tokenPath +
    ' (superuser_invalid_bearer). Set PAPERCUSP_OPERATOR_URL or PAPERCUSP_HONO_PORT to the ' +
    'matching local operator; ' + (tokenFallbackAttempted
      ? 'mcp-call exhausted its ordered implicit token candidates.'
      : 'mcp-call did not substitute another token.');
}

/** Match ptool's exact pre-dispatch auth refusal; other tool errors are terminal. */
export function isInvalidSuperuserBearerResult(result) {
  return result?.isError === true &&
    Array.isArray(result.content) &&
    result.content.some((block) =>
      block?.type === 'text' && block.text === 'request_rejected: superuser_invalid_bearer');
}

/**
 * A live staging operator can be reachable but still run an older control-plane
 * build whose kernel cannot read this session's authority. That response is
 * recoverable for an unpinned helper call: the canonical :3070 operator is the
 * shared coordination endpoint and may already accept the same session. Keep
 * this matcher narrow so ordinary authorization failures remain visible.
 */
export function isRecoverableAuthorityDenial(raw) {
  return /authorization_denied[\s\S]*current session authority could not be read[\s\S]*no effect authorized/i.test(raw);
}

/**
 * Describe an exhausted endpoint search without turning every transport error
 * into a claim that the port had no listener. Only ECONNREFUSED proves the
 * request could not have reached the MCP handler; resets such as UND_ERR_SOCKET
 * leave the tool outcome unknown.
 */
export function buildUnreachableDiagnostic({ attempts, configuredPort, pinned }) {
  const renderedAttempts = attempts.map(({ port, error }) => {
    const reason = error?.cause?.code ?? error?.code ?? error?.message ?? 'unknown error';
    return `${port} (${reason})`;
  }).join(', ');
  const allRefused = attempts.length > 0 && attempts.every(({ error }) => isConnectionRefusedError(error));
  const outcome = allRefused
    ? 'Every connection attempt was refused before an MCP request could be sent; this request did not invoke the tool.'
    : 'At least one failure was not a connection refusal. This does not establish that no listener was present or whether the MCP tool ran; check a write outcome before retrying it.';

  return `mcp-call: could not reach the operator MCP endpoint. Tried port(s): ${renderedAttempts}.\n` +
    (pinned ? `  Port ${configuredPort} was explicitly pinned with --port, so no fallback was attempted.\n` : '') +
    `  ${outcome}\n` +
    `  These results describe this mcp-call process's attempts to the listed ports; a refusal does not identify why a connection was refused or whether another runtime can reach the operator.\n` +
    `  Run endpoint probes from the same execution environment that ran mcp-call; loopback reachability can differ across environments.\n` +
    `  A healthy operator on a different port may still be serving. Find the live port:\n` +
    `    ss -ltn | grep -E ':(3070|3170|9071)'   # then: PAPERCUSP_HONO_PORT=<live port> re-run\n` +
    `  The local MCP proxy may listen on :9071; that is a separate route from the direct operator ports.\n` +
    `  Confirm the canonical operator is healthy with:\n` +
    `    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3070/api/health\n` +
    `  See EI-20182275617587040 / agent-insights/mcp-client-drop-curl-recovery.`;
}

/**
 * Explain a retry after ECONNREFUSED without attributing the refusal to an
 * operator restart. The result is scoped to this helper's caller and endpoint.
 */
export function buildConnectionRetryDiagnostic({ port, attempt, delayMs, remainingMs }) {
  return `mcp-call: connection to port ${port} was refused from this mcp-call process; ` +
    `retry ${attempt} in ${delayMs}ms (${Math.ceil(remainingMs / 1000)}s left). ` +
    'A refusal alone does not identify the cause or imply that other callers cannot reach the operator.';
}

/**
 * Build the scoped-superuser query for the recovery transport.
 *
 * `mcp-call` promises JSON on stdout (and vmcall.sh validates that contract),
 * while the operator's default result encoding is intentionally compact/TOON.
 * Pin JSON at the transport boundary instead of depending on that mutable
 * default; otherwise a successful tool call becomes non-JSON output that the
 * maintained VM-rig driver correctly rejects.
 * Forward the launched role as an admission hint for bounded judge calls;
 * signed principal verification remains the authorization boundary.
 * @param {{client: string, workspace: string, harness?: string, role?: string, origin?: string, allWorkspaces?: boolean, nativeSessionOverride?: string | null, env?: NodeJS.ProcessEnv}} options
 */
export function buildMcpSessionQuery({
  client, workspace, harness, role, origin, allWorkspaces = false,
  nativeSessionOverride, env = process.env,
}) {
  const qs = new URLSearchParams({
    superuser: '1',
    client,
    workspace: allWorkspaces ? '*' : workspace,
    format: 'json',
  });
  if (harness) qs.set('harness', harness);
  if (role) qs.set('role', role);
  if (origin) qs.set('origin', origin);
  // Prefer the native session UUID recorded by the launcher and bound by the
  // operator. `/clear` can rotate CLAUDE_CODE_SESSION_ID while that binding
  // remains attached to the launch UUID, so forwarding the changing value is
  // rejected as superuser_foreign_native_session. Fall back to the active
  // client's session variable for older or externally launched sessions. A
  // Claude psu session can also inherit a stale CODEX_SESSION_ID from its shell.
  const nativeSession = String(nativeSessionOverride !== undefined
    ? nativeSessionOverride ?? ''
    : env.PAPERCUSP_NATIVE_SESSION_ID ||
      (String(env.PAPERCUSP_AGENT ?? '').trim() === 'claude'
        ? env.CLAUDE_CODE_SESSION_ID
        : env.CODEX_SESSION_ID) || '').trim();
  if (nativeSession && client === String(env.PAPERCUSP_SID ?? '').trim()) {
    qs.set('native_session', nativeSession);
  }
  return qs;
}

/** A foreign native-session refusal is emitted before the tool dispatcher runs. */
export function isForeignNativeSessionRejection(result) {
  return result?.isError === true &&
    Array.isArray(result.content) &&
    result.content.some((block) =>
      block?.type === 'text' && block.text === 'request_rejected: superuser_foreign_native_session');
}

/** Retry only an inherited Codex claim; an explicit launcher binding stays authoritative.
 * @param {unknown} result
 * @param {{client?: string, query?: URLSearchParams, env?: NodeJS.ProcessEnv}} [options]
 */
export function shouldRetryWithoutNativeSession(result, { client, query, env = process.env } = {}) {
  return isForeignNativeSessionRejection(result) &&
    Boolean(String(env.CODEX_SESSION_ID ?? '').trim()) &&
    !String(env.PAPERCUSP_NATIVE_SESSION_ID ?? '').trim() &&
    Boolean(client) && client === String(env.PAPERCUSP_SID ?? '').trim() &&
    query instanceof URLSearchParams && query.has('native_session');
}

/**
 * Build the stateless `tools/call` params for the recovery transport.
 *
 * Idempotency belongs to MCP transport metadata. Putting the key in
 * `arguments` would send it to the target tool schema, where it is either
 * ignored or rejected as an unrecognized tool argument instead of enabling
 * result replay after an unknown outcome.
 * @param {string} tool
 * @param {unknown} args
 * @param {{idempotencyKey?: string, outputGroupId?: string}} [options]
 */
export function buildMcpCallParams(tool, args, { idempotencyKey, outputGroupId } = {}) {
  return {
    name: tool,
    arguments: args,
    ...(idempotencyKey !== undefined || outputGroupId !== undefined
      ? { _meta: { ...(idempotencyKey !== undefined ? { idempotencyKey } : {}), ...(outputGroupId !== undefined ? { outputGroupId } : {}) } }
      : {}),
  };
}

/**
 * Resolve the session workspace. Ordinary calls remain scoped by default so
 * first-party tenant tools keep their workspace transaction. The explicit
 * `--all-workspaces` escape is the only CLI path that selects the unscoped
 * superuser session required by cross-workspace tools.
 * @param {McpCallFlags} [flags]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMcpWorkspace(flags = {}, env = process.env) {
  if (flags.allWorkspaces && flags.workspace !== undefined) {
    throw new Error('--all-workspaces cannot be combined with --workspace');
  }
  if (flags.allWorkspaces) return '*';
  return flags.workspace ?? env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
}

/**
 * Resolve the coordination identity used by the stateless MCP transport.
 *
 * A launched helper can make several `mcp-call` invocations from different
 * processes. `PAPERCUSP_SPAWN_ID` is stable for that launch, whereas a PID is
 * not; using only the PID strands work-item ownership between calls. Preserve
 * an explicit client or full session identity first, then reuse the launch id
 * before falling back to the legacy per-process identity for ordinary shells.
 * @param {McpCallFlags} [flags]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [pid]
 */
export function resolveMcpClientId(
  flags = {},
  env = process.env,
  pid = process.pid,
) {
  for (const candidate of [
    flags.client,
    env.PAPERCUSP_SID,
    env.PAPERCUSP_SPAWN_ID,
  ]) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return `mcp-call-${pid}`;
}

/**
 * The recovery helper uses a node user-agent and a one-shot URL, so the
 * telemetry classifier cannot recognize model calls from transport shape.
 * Declare agent only when the client is a managed Papercusp session/spawn
 * identity; generic and system-script clients remain unclassified.
 */
export function resolveMcpCallOrigin(clientId, env = process.env) {
  const client = String(clientId ?? '').trim();
  if (!client || client.toLowerCase().startsWith('system-') || client === 'su-loopback') {
    return undefined;
  }
  const sessionIds = [env.PAPERCUSP_SID, env.PAPERCUSP_SPAWN_ID]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return sessionIds.includes(client) || /^(?:su|s|pus)-[a-z0-9][a-z0-9._-]*$/i.test(client)
    ? 'agent'
    : undefined;
}

/** Role is an admission routing hint; signed principal checks still run downstream. */
export function resolveMcpRole(env = process.env) {
  return [env.PAPERCUSP_ROLE, env.PAPERCUSP_AGENT_ROLE]
    .map((value) => String(value ?? '').trim())
    .find(Boolean);
}

/**
 * `--transport` values. `auto` (the default) uses the operator's HTTP
 * endpoints and falls back to its agent-MCP unix socket only when EVERY HTTP
 * attempt was refused before a request was sent; `http` never falls back;
 * `uds` goes straight to the socket.
 */
export const MCP_CALL_TRANSPORTS = Object.freeze(['auto', 'http', 'uds']);

/**
 * Exit code when the unix-socket response was lost AFTER tools/call was sent:
 * the mutation outcome is unknown, so nothing is retried (WI-6554700010019317).
 */
export const MCP_CALL_OUTCOME_UNKNOWN_EXIT = 7;

/**
 * @param {McpCallFlags} [flags]
 * @returns {'auto' | 'http' | 'uds'}
 */
export function resolveMcpTransport(flags = {}) {
  const value = flags.transport ?? 'auto';
  if (!MCP_CALL_TRANSPORTS.includes(value)) {
    throw new Error(`--transport must be one of ${MCP_CALL_TRANSPORTS.join(', ')} (received ${JSON.stringify(value)})`);
  }
  return /** @type {'auto' | 'http' | 'uds'} */ (value);
}

/**
 * Whether to try the operator's agent-MCP unix socket after the HTTP pass.
 *
 * A psu Claude session's native Bash runs in its own network namespace
 * (bwrap --unshare-net), so every loopback TCP port refuses while the operator
 * is healthy, and the documented toolless-recovery fallback (this script)
 * dead-ended (WI-6554700010019317). The :3070 operator's agent socket lives
 * under /tmp, which that sandbox can still reach. Falling back is safe only
 * when no HTTP request can have reached a handler, i.e. every attempt failed
 * with ECONNREFUSED. Any other transport error leaves a mutation outcome
 * unknown, so the caller must stop rather than send the call a second time.
 * @param {{transport: 'auto' | 'http' | 'uds', attempts: Array<{port: string, error: unknown}>}} input
 * @returns {boolean}
 */
export function shouldTryUdsFallback({ transport, attempts }) {
  if (transport === 'uds') return true;
  if (transport === 'http') return false;
  return attempts.length > 0 && attempts.every((attempt) => isConnectionRefusedError(attempt.error));
}

/**
 * @param {Array<{port: string, error: unknown}>} attempts
 * @returns {string}
 */
export function buildUdsFallbackNotice(attempts) {
  const ports = attempts.map((attempt) => attempt.port).join(', ');
  return `mcp-call: every HTTP endpoint refused the connection (port(s) ${ports}), so no request was sent; ` +
    'trying the operator agent-MCP unix socket instead. A sandboxed shell without loopback TCP ' +
    '(psu native Bash) reaches the operator this way. Pass --transport http to disable.';
}

/**
 * @param {Array<{port: string, reason: string}>} unavailable
 * @returns {string}
 */
export function buildUdsUnavailableDiagnostic(unavailable) {
  const lines = unavailable.map((entry) => `  port ${entry.port}: ${entry.reason}`);
  return 'mcp-call: no operator agent-MCP unix socket accepted the connection (nothing was sent):\n' +
    (lines.length > 0 ? lines.join('\n') : '  (no candidate ports)') + '\n' +
    '  uds_endpoint_unavailable = no ~/.papercusp/endpoint-ipc.<port>.json advertises a socket for that port.\n' +
    '  uds_connection_failed = the socket exists but refused or failed the handshake; a sandbox that masks\n' +
    '  /run/user/<uid> cannot reach the :3170 or :3271 sockets, only the :3070 one under /tmp.';
}

/**
 * The directory whose `.papercusp/endpoint-ipc.<port>.json` advertises the
 * operator's agent socket. Deliberately NOT PAPERCUSP_HOME: a psu session sets
 * that to its workspace directory, where no operator writes a descriptor
 * (memory d3c1ce00, 2026-10-20). PAPERCUSP_OPERATOR_HOME is the real operator
 * home that an owned launcher preserves when it isolates the child HOME.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [home]
 * @returns {string}
 */
export function resolveAgentMcpDiscoveryHome(env = process.env, home = homedir) {
  const operatorHome = typeof env.PAPERCUSP_OPERATOR_HOME === 'string' ? env.PAPERCUSP_OPERATOR_HOME.trim() : '';
  return operatorHome || home();
}

/**
 * Load connectAgentMcp from the omp-plugin native bundle (the client ptool
 * uses for --transport=uds), so the socket wire format and its
 * initialize-time credentials have exactly one implementation.
 * @returns {Promise<Function>}
 */
async function loadAgentMcpConnect() {
  const bundle = new URL('../packages/omp-plugin/dist/native-client.cjs', import.meta.url);
  try {
    const mod = await import(bundle.href);
    const native = mod.default ?? mod;
    if (typeof native.connectAgentMcp !== 'function') throw new Error('connectAgentMcp is not exported');
    return native.connectAgentMcp;
  } catch (error) {
    throw new Error(
      `the agent-MCP client bundle ${fileURLToPath(bundle)} is not loadable (${error?.message ?? error}); ` +
        'build it with `npm --prefix packages/omp-plugin run build:native`.',
    );
  }
}

/**
 * @typedef {{kind: 'result', port: string, result: unknown}
 *   | {kind: 'error', port: string, error: {code?: number, message: string, data?: unknown}}
 *   | {kind: 'outcome-unknown', port: string, message: string}
 *   | {kind: 'unavailable', unavailable: Array<{port: string, reason: string}>}} UdsCallOutcome
 */

/**
 * Call one tool over the operator's agent-MCP unix socket.
 *
 * Ports are tried in order. A port with no advertised socket, or whose socket
 * refuses the connection or the initialize handshake, is skipped: tools/call
 * has not been sent yet, so trying the next port or bearer cannot run the
 * call twice. Once tools/call is sent the first answer is final. A JSON-RPC
 * error (numeric code) is the server's answer; anything else means the
 * response was lost and the outcome is unknown, which is never retried.
 * @param {{
 *   ports: string[],
 *   tokens: string[],
 *   query: string,
 *   params: object,
 *   connect: (options: {url: string, headers: Record<string, string>, mode: 'uds', name: string, home?: string}) => Promise<{client: {callTool: (params: object) => Promise<unknown>, close: () => Promise<void>}}>,
 *   home?: string,
 * }} input
 * @returns {Promise<UdsCallOutcome>}
 */
export async function callToolViaAgentMcpUds({ ports, tokens, query, params, connect, home }) {
  /** @type {Array<{port: string, reason: string}>} */
  const unavailable = [];
  for (const port of ports) {
    let connected = null;
    for (const token of tokens) {
      try {
        connected = await connect({
          url: `http://localhost:${port}/api/mcp?${query}`,
          headers: { Authorization: `Bearer ${token}` },
          mode: 'uds',
          name: 'mcp-call',
          home,
        });
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        unavailable.push({ port, reason });
        // No socket is advertised for this port: another bearer cannot help.
        if (/^uds_endpoint_unavailable/.test(reason)) break;
      }
    }
    if (!connected) continue;
    try {
      return { kind: 'result', port, result: await connected.client.callTool(params) };
    } catch (error) {
      const failure = /** @type {{code?: unknown, message?: unknown, data?: unknown}} */ (error ?? {});
      if (typeof failure.code === 'number') {
        return {
          kind: 'error',
          port,
          error: {
            code: failure.code,
            message: String(failure.message ?? 'MCP error'),
            ...(failure.data !== undefined ? { data: failure.data } : {}),
          },
        };
      }
      return {
        kind: 'outcome-unknown',
        port,
        message: String(failure.message ?? error) +
          ' — the response was lost after tools/call was sent, so the outcome is UNKNOWN. ' +
          'Read current state before retrying; reuse the same --idempotency-key, never a fresh one.',
      };
    } finally {
      await connected.client.close().catch(() => {});
    }
  }
  return { kind: 'unavailable', unavailable };
}

/**
 * Decide whether this module is the launched script after resolving filesystem
 * aliases. macOS exposes `/tmp` as a symlink to `/private/tmp`; the VM-rig
 * deploy invokes `/tmp/mcp-call.mjs`, while `import.meta.url` canonicalizes to
 * `/private/tmp/mcp-call.mjs`. Comparing their raw URLs suppresses main() and
 * produces a false-success, zero-byte result.
 * @param {string | undefined} argv1
 * @param {string | URL} moduleUrl
 * @param {(path: string) => string} [resolveRealpath]
 */
export function isInvokedDirectly(
  argv1,
  moduleUrl,
  resolveRealpath = realpathSync,
) {
  if (!argv1) return false;
  try {
    return resolveRealpath(argv1) === resolveRealpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main() {
  const { tool, jsonArgs, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !tool) {
    console.error('usage: node scripts/mcp-call.mjs <ns:verb> [jsonArgs] [--json -|--json-file <path>] [--client <id>|--client=<id>] [--workspace <ws>|--workspace=<ws>] [--all-workspaces] [--harness <h>|--harness=<h>] [--port <n>|--port=<n>] [--idempotency-key <key>|--idempotency-key=<key>] [--transport auto|http|uds] [--raw] [--allow-partial]');
    process.exit(flags.help ? 0 : 2);
  }
  const tokenPaths = superuserTokenPaths();
  const tokenCandidates = tokenPaths.flatMap((tokenPath) => {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      return token ? [{ path: tokenPath, token }] : [];
    } catch {
      return [];
    }
  });
  if (tokenCandidates.length === 0) {
    console.error('mcp-call: no superuser token at ' + tokenPaths.join(' or ') + ' — run on a host that has it.');
    process.exit(3);
  }
  let args;
  try {
    args = readJsonArgs({ jsonArgs, flags });
  } catch (error) {
    console.error(`mcp-call: ${error?.message ?? error}`);
    process.exit(2);
  }
  // EI-6631: blank explicit clients still fall through; EI-22014303182044906:
  // launched helpers reuse their stable session/spawn identity across processes.
  const client = resolveMcpClientId(flags);
  let workspace;
  try {
    // The scoped-superuser session requires a resolved workspace (else
    // `scoped_superuser_workspace_unresolved`). Default to the standard one;
    // override with --workspace or PAPERCUSP_WORKSPACE. Cross-workspace calls
    // must opt in explicitly with --all-workspaces.
    workspace = resolveMcpWorkspace(flags);
  } catch (error) {
    console.error(`mcp-call: ${error?.message ?? error}`);
    process.exit(2);
  }
  const queryArgs = {
    client,
    workspace,
    harness: flags.harness,
    role: resolveMcpRole(),
    origin: resolveMcpCallOrigin(client),
    allWorkspaces: flags.allWorkspaces,
  };
  const qs = buildMcpSessionQuery(queryArgs);
  // EI-20182275617587040: PAPERCUSP_HONO_PORT can OUTLIVE the process it described
  // (e.g. a per-session operator that has since died), and a bare fetch at a port with
  // no listener dies as an unactionable `fetch failed`. That is worst precisely HERE:
  // this script IS the documented recovery path for a dropped MCP client, so when it
  // inherits the same stale port, the primary and its fallback fail together and the
  // symptom reads as "the server is down" while the server is answering in ~4ms.
  // So: try the configured port, then canonical, then the resilient MCP proxy.
  const { configuredPort, candidatePorts, pinned } = resolveCandidatePorts(flags);
  const proxyPort = resolveMcpProxyPort();

  const transport = resolveMcpTransport(flags);
  // Each CLI invocation is a standalone MCP request, even when several
  // processes share one agent SID and start within the 2s legacy cohort
  // window. Do not let a previous process consume this request's budget.
  // The same params serve the HTTP request and the unix-socket fallback.
  const callParams = buildMcpCallParams(tool, args, {
    idempotencyKey: flags.idempotencyKey,
    outputGroupId: randomUUID(),
  });
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: 'tools/call',
      params: callParams,
    }),
  };
  const initForToken = (token) => ({
    ...init,
    headers: { ...init.headers, authorization: 'Bearer ' + token },
  });
  const fetchCandidate = async (port, token, query) => {
    for (let admissionAttempt = 1; ; admissionAttempt += 1) {
      stampRequestSent();
      const candidateRes = await fetchWithConnectionRecovery(
        'http://localhost:' + port + '/api/mcp?' + query,
        initForToken(token),
        {
          // An explicit pin means the caller deliberately chose this operator
          // and must not be silently routed to another port while it restarts.
          retryWindowMs: pinned ? MCP_CALL_CONNECTION_RETRY_WINDOW_MS : 0,
          onRetry: ({ attempt, delayMs, remainingMs }) => {
            // Keep a long retry loop quiet without hiding that retries are active.
            if (attempt === 1 || attempt % 10 === 0) {
              console.error(buildConnectionRetryDiagnostic({ port, attempt, delayMs, remainingMs }));
            }
          },
        },
      );
      const candidateRaw = await candidateRes.text();
      const candidateOut = parseSse(candidateRaw, REQUEST_ID);
      if (
        !isRetryableAdmissionShed(candidateOut.error, candidateRes.status) ||
        admissionAttempt >= MCP_CALL_ADMISSION_MAX_ATTEMPTS
      ) {
        return { candidateRes, candidateRaw, candidateOut };
      }

      const delayMs = admissionRetryDelayMs(candidateRes, candidateOut.error);
      const reason = candidateOut.error?.data?.reason ?? 'admission pressure';
      console.error(
        `mcp-call: operator rejected the request before dispatch (${reason}); ` +
          `retry ${admissionAttempt + 1}/${MCP_CALL_ADMISSION_MAX_ATTEMPTS} in ${delayMs}ms.`,
      );
      await sleep(delayMs);
    }
  };

  let res;
  let raw;
  let responsePort = null;
  let responseTokenPath = tokenCandidates[0].path;
  let tokenFallbackAttempted = false;
  let authorityFallback = false;
  let configuredPortError = null;
  const attempts = [];
  let tokenIndex = 0;
  let stopEndpointSearch = false;
  for (let index = 0; transport !== 'uds' && index < candidatePorts.length; index += 1) {
    const port = candidatePorts[index];
    const hasEndpointFallback = !pinned && index < candidatePorts.length - 1;
    let tryNextEndpoint = false;
    for (; tokenIndex < tokenCandidates.length; tokenIndex += 1) {
      const tokenCandidate = tokenCandidates[tokenIndex];
      responseTokenPath = tokenCandidate.path;
      try {
        let { candidateRes, candidateRaw, candidateOut } = await fetchCandidate(
          port,
          tokenCandidate.token,
          qs,
        );
        if (shouldRetryWithoutNativeSession(candidateOut.error, { client, query: qs })) {
          console.error(
            'mcp-call: operator rejected the inherited Codex native-session claim before dispatch; ' +
              'retrying once with the same client identity and no native-session claim.',
          );
          const queryWithoutNativeSession = buildMcpSessionQuery({
            ...queryArgs,
            nativeSessionOverride: null,
          });
          ({ candidateRes, candidateRaw, candidateOut } = await fetchCandidate(
            port,
            tokenCandidate.token,
            queryWithoutNativeSession,
          ));
        }
        if (hasEndpointFallback && isRecoverableAuthorityDenial(candidateRaw)) {
          authorityFallback = true;
          tryNextEndpoint = true;
          break;
        }
        if (
          isInvalidSuperuserBearerResult(candidateOut.error) &&
          tokenIndex + 1 < tokenCandidates.length
        ) {
          tokenFallbackAttempted = true;
          continue;
        }
        res = candidateRes;
        raw = candidateRaw;
        responsePort = port;
        if (!pinned && port !== String(configuredPort)) {
          console.error(buildFallbackWarning({
            configuredPort,
            port,
            proxyPort,
            configuredPortError,
            authorityFallback,
          }));
        }
        break;
      } catch (err) {
        if (index === 0) configuredPortError = err;
        attempts.push({ port, error: err });
        // ECONNREFUSED proves no MCP handler could have received this request.
        // Other transport errors leave a mutation outcome unknown: stop without
        // trying another endpoint or bearer.
        if (hasEndpointFallback && isConnectionRefusedError(err)) {
          tryNextEndpoint = true;
        } else {
          stopEndpointSearch = true;
        }
        break;
      }
    }
    if (res) break;
    if (tryNextEndpoint) continue;
    if (stopEndpointSearch) break;
  }

  let out;
  if (res) {
    if (flags.raw) { process.stdout.write(raw); return; }
    out = parseSse(raw, REQUEST_ID);
  } else if (shouldTryUdsFallback({ transport, attempts })) {
    if (transport === 'auto') console.error(buildUdsFallbackNotice(attempts));
    const uds = await callToolViaAgentMcpUds({
      ports: candidatePorts,
      tokens: tokenCandidates.map((candidate) => candidate.token),
      query: qs,
      params: callParams,
      connect: await loadAgentMcpConnect(),
      home: resolveAgentMcpDiscoveryHome(),
    });
    if (uds.kind === 'outcome-unknown') {
      console.error(`mcp-call: ${uds.message} (unix socket via port ${uds.port})`);
      process.exit(MCP_CALL_OUTCOME_UNKNOWN_EXIT);
    }
    if (uds.kind === 'unavailable') {
      if (attempts.length > 0) console.error(buildUnreachableDiagnostic({ attempts, configuredPort, pinned }));
      console.error(buildUdsUnavailableDiagnostic(uds.unavailable));
      process.exit(4);
    }
    responsePort = uds.port;
    out = uds.kind === 'result' ? { result: uds.result } : { error: uds.error };
    if (flags.raw) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, ...out }) + '\n');
      return;
    }
  } else {
    console.error(buildUnreachableDiagnostic({ attempts, configuredPort, pinned }));
    process.exit(4);
  }
  const failedPayload = out.error ?? (
    out.result && typeof out.result === 'object' &&
    (out.result.isError === true || toolResultNotOkReason(out.result) !== null)
      ? out.result
      : null
  );
  if (isInvalidSuperuserBearerResult(failedPayload)) {
    console.error(buildSuperuserBearerDiagnostic({
      tokenPath: responseTokenPath,
      port: responsePort ?? configuredPort,
      tokenFallbackAttempted,
    }));
  }
  if (out.error) {
    console.error('MCP_ERROR:', JSON.stringify(out.error));
    process.exit(1);
  }
  console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
  const notOk = toolResultNotOkReason(out.result);
  if (notOk !== null) {
    console.error(
      `mcp-call: the tool reported failure (${notOk}). The response is printed above; exiting ${MCP_CALL_TOOL_NOT_OK_EXIT} so a \`|| fail\` guard sees the failure. (EI-24654733539966460)`,
    );
    // exitCode, never process.exit(): exiting here can cut off a large stdout
    // result that is still draining into a pipe.
    process.exitCode = MCP_CALL_TOOL_NOT_OK_EXIT;
  }
  const partial = projectedResultReason(out.result);
  if (partial !== null) {
    console.error(
      `mcp-call: the result above is INCOMPLETE (${partial}). A field copied from it can be a placeholder string, not data. Re-run with a narrower \`projection: { pick: [...] }\` in the args, or read the spill named at _projection.cursor. ${flags.allowPartial ? '--allow-partial given: exit status unchanged.' : `Exiting ${MCP_CALL_PROJECTED_RESULT_EXIT}; pass --allow-partial to accept a partial read.`} (EI-24678010189721217)`,
    );
    if (!flags.allowPartial && process.exitCode == null) process.exitCode = MCP_CALL_PROJECTED_RESULT_EXIT;
  }
}

// Run ONLY when invoked as a script. `parseSse` is exported for tests, and a
// bare `main()` at module scope executed it on import — so importing the parser
// fired a real MCP call and then process.exit(1), which reads as a broken test
// rather than a non-importable module.
const invokedDirectly = isInvokedDirectly(process.argv[1], import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('mcp-call failed:', e?.message ?? e); process.exit(1); });
}
