#!/usr/bin/env node
/**
 * PreToolUse (matcher "Bash|WebFetch") — a restricted session may not reach a
 * mail, chat, calendar or social provider with a native tool.
 *
 * Plan personal-data-reader-set-labels-2026-10-01, P-007, BAR R-11. Once an
 * agent has read a restricted personal document, every outbound send must go
 * through a gated verb (mail:send, chat:post, …) that checks the document's
 * reader set. capability:bash enforces that server-side; Claude Code's own
 * Bash and WebFetch never reach the operator, so this hook is their gate.
 *
 * Flow:
 *   1. PREFILTER (local, no I/O): does the command / URL name anything
 *      provider-shaped? The overwhelming majority of calls stop here, allowed.
 *   2. No PAPERCUSP_SID → allow. Not a psu session, so no disclosure can be
 *      attributed to it (D-004).
 *   3. Ask the operator: POST /api/agent-mcp/restricted-egress-check. The
 *      operator holds the authoritative target rules
 *      (personal-vault/provider-egress.mjs) and the disclosure ledger.
 *   4. verdict 'refuse' → DENY with the operator's reason. An unreachable or
 *      failing operator also DENIES: a provider-shaped target was named and
 *      nothing can show this session is unrestricted.
 *
 * The prefilter is a deliberately coarse copy of the operator's rule list (an
 * installed hook cannot import repository modules). It must match every rule's
 * sample: restricted-egress-guard.test.ts pins it to PROVIDER_EGRESS_RULES.
 *
 * NETWORK LAYER (WI-10005589, plan Decision D-012). Matching names cannot see a
 * host built at run time (`'https://' + 'slack' + '.com'`, base64, a script the
 * agent wrote). So for a psu session the hook also asks whether the session is
 * RESTRICTED (`status: true`), on every call it matches, and when it is — or when
 * that cannot be shown otherwise — :
 *   - Bash is REWRITTEN (updatedInput) to run inside bwrap with `--unshare-net`:
 *     an empty network namespace whose only interface is its own loopback, so no
 *     egress exists to refuse. The user bus/systemd sockets (/run/user/<uid>), the
 *     docker socket and tmux sockets are hidden (each would let a sandboxed command
 *     ask a host-side service to run something on the host network), and the files
 *     the CLI itself executes or reads tools from (settings, hooks, MCP config, git
 *     hooks) are read-only. No bwrap → `unshare --net`; neither → deny.
 *   - WebFetch and every non-Papercusp MCP tool are DENIED (both egress from the
 *     CLI process itself, outside any shell sandbox).
 *   - Edit/Write/MultiEdit/NotebookEdit of those runtime-config paths are DENIED.
 *
 * RTK (WI-6554700010009291, owner directives #1759/#1764). This hook is ALSO the
 * one place RTK's output compression is applied to native Bash. Claude Code
 * resolves several PreToolUse hooks that each return `updatedInput` by
 * completion order (the last one to finish wins), so a separate RTK hook could
 * silently drop the network sandbox above. Here one hook produces the final
 * command: RTK rewrites first (`git status` → `rtk git status`), then the
 * sandbox wraps that, while every deny check keeps judging the ORIGINAL
 * command. RTK fails open: a missing, failing or slow binary leaves the command
 * as it was. capability:bash applies the same rewrite server-side
 * (packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { operatorBase, sessionId } from '../inject/core.mjs';

const CHECK_TIMEOUT_MS = 4000;
const STDIN_TIMEOUT_MS = 2000;

/** Override for the RTK binary location; an empty value disables RTK. */
export const RTK_BIN_ENV = 'PAPERCUSP_RTK_BIN';
export const RTK_REWRITE_TIMEOUT_MS = 2000;
const RTK_MAX_COMMAND_CHARS = 16384;

/**
 * A pipe (`|` or `|&`, never `||`) into a consumer that stops reading early:
 * `head`, `grep`/`rg` with a match limit, or `sed … Nq`. RTK collects the whole
 * output before printing, so the producer would no longer be stopped early
 * (WI-6554700010009543: `rg … | head -60` 0.5 s raw vs 28.5 s through rtk).
 * Kept identical to RTK_EARLY_EXIT_PIPE in packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts.
 */
export const RTK_EARLY_EXIT_PIPE =
  /(?:^|[^|])\|(?!\|)&?\s*(?:head\b|(?:rg|[ef]?grep)\b[^|;&\n]*\s(?:-m\s*\d|-[A-Za-z]*m\d|--max-count\b)|sed\b[^|;&\n]*\d+q\b)/;

/**
 * A grep/egrep/fgrep carrying `-h` (any short-flag cluster) or `--no-filename`.
 * `rtk grep` reads `-h` as --help, so the RTK form printed usage text with exit 0
 * instead of matches (WI-6554700010009627).
 * Kept identical to RTK_GREP_NO_FILENAME in packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts.
 */
export const RTK_GREP_NO_FILENAME =
  /(?:^|[\s|;&(/])[ef]?grep\s(?:[^;&\n]*\s)?(?:-[A-Za-z0-9]*h[A-Za-z0-9]*|--no-filename)(?=[\s;&|)]|$)/;

function isExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate RTK: the override, then `~/.local/bin/rtk` (where the installer pins
 * it), then PATH. Under Vitest the host's binary is never used implicitly, so a
 * test's expected command does not depend on what the machine has installed.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function resolveRtkBin(env = process.env) {
  const explicit = env[RTK_BIN_ENV];
  if (explicit !== undefined) {
    const value = explicit.trim();
    return value && isExecutable(value) ? value : null;
  }
  if (env.VITEST || process.env.VITEST) return null;
  const candidates = [path.join(env.HOME || homedir(), '.local', 'bin', 'rtk')];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'rtk'));
  }
  return candidates.find(isExecutable) ?? null;
}

/**
 * The RTK form of a native Bash command, or null to leave it unchanged.
 * Never offered: vitest commands (EI-9471: rtk's vitest wrapper once dropped a
 * single-file filter and ran the whole suite), commands piping into an
 * early-exit consumer (RTK_EARLY_EXIT_PIPE), commands carrying the
 * `RTK_DISABLED=1` opt-out, and oversized commands. rtk exits 0 (rewritten),
 * 3 (rewritten, rtk would ask; this hook does not delegate permission to rtk),
 * 1 (no equivalent) or 2 (denied by rtk's rules: leave it alone).
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number }} [opts]
 * @returns {string | null}
 */
export function rtkRewriteSync(command, opts = {}) {
  if (!command || command.length > RTK_MAX_COMMAND_CHARS) return null;
  if (/(^|[\s;&|(])RTK_DISABLED=1(\s|$)/.test(command)) return null;
  if (/\bvitest\b/.test(command)) return null;
  if (RTK_EARLY_EXIT_PIPE.test(command)) return null;
  if (RTK_GREP_NO_FILENAME.test(command)) return null;
  const bin = resolveRtkBin(opts.env ?? process.env);
  if (!bin) return null;
  try {
    const run = spawnSync(bin, ['rewrite', command], {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? RTK_REWRITE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (run.error || (run.status !== 0 && run.status !== 3)) return null;
    const rewritten = String(run.stdout ?? '').replace(/[\r\n]+$/, '');
    return rewritten.trim() && rewritten !== command ? rewritten : null;
  } catch {
    return null;
  }
}

/** Coarse provider-shaped tokens; a superset of provider-egress.mjs's rules. */
export const PROVIDER_PREFILTER = [
  /(?:gmail|people|calendar-json|oauth2)\.googleapis\.com/i,
  /www\.googleapis\.com\/(?:gmail|calendar|upload\/gmail)/i,
  /accounts\.google\.com\/o\/oauth2/i,
  /\b(?:imap|smtp|pop)\.gmail\.com/i,
  /graph\.microsoft\.com|outlook\.office(?:365)?\.com|login\.microsoftonline\.com/i,
  /slack\.com/i,
  /discord(?:app)?\.com/i,
  /api\.telegram\.org/i,
  /\b(?:api|upload)\.(?:twitter|x)\.com/i,
  /bsky\.(?:social|app|network)/i,
  /graph\.(?:facebook|instagram|whatsapp)\.com/i,
  /api\.linkedin\.com/i,
  /app-producer\.env/i,
  /\b(?:email|calendar)_app\b/,
  /:879[12]\b/,
];

/**
 * The text a tool call would act on.
 * @param {string} toolName
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {string[]}
 */
export function egressTexts(toolName, toolInput) {
  const input = toolInput ?? {};
  if (toolName === 'Bash' && typeof input.command === 'string') return [input.command];
  if (toolName === 'WebFetch' && typeof input.url === 'string') return [input.url];
  return [];
}

/** @param {readonly string[]} texts */
export function prefilterHits(texts) {
  return texts.some((text) => PROVIDER_PREFILTER.some((re) => re.test(text)));
}

/** The installed matcher (desktop-install/papercusp-files.ts must use this exact string). */
export const RESTRICTED_EGRESS_MATCHER = 'Bash|WebFetch|Edit|Write|MultiEdit|NotebookEdit|mcp__(?!papercusp).*';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** @param {string} toolName */
function isForeignMcp(toolName) {
  return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__papercusp');
}

/**
 * A restricted bwrap shell mounts the caller's `/run/user/<uid>` as tmpfs so a
 * command cannot route around the network boundary through the host user bus.
 * Recognize direct `systemctl --user` command forms so they fail before an
 * empty/piped result can be mistaken for the host's unit state. This is a
 * deliberately command-boundary matcher: mentioning the command in quoted text
 * is not an invocation.
 * @param {string} command
 */
function invokesUserSystemctl(command) {
  return /(?:^|[\n;&|][ \t]*|\$\(|<\(|`)(?:(?:if|then|else|elif|do|time|exec|command|sudo|env)[ \t]+)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+[ \t]+)*systemctl(?:[ \t]+--[A-Za-z0-9][A-Za-z0-9_-]*(?:=\S+)?)*[ \t]+--user(?:[ \t]|$)/m.test(command);
}

/**
 * True only for the bwrap form that hides the current user's runtime directory.
 * The `unshare --net` fallback leaves filesystem mounts alone, so user-manager
 * queries remain possible there when the bus is available.
 * @param {string} wrappedCommand
 */
function masksUserRuntime(wrappedCommand) {
  const argv = wrappedCommand.split(" '--' ", 1)[0];
  return /(?:^| )'--tmpfs' '\/run\/user\/[^']+'(?: |$)/.test(argv);
}

/**
 * Files the agent CLI itself executes or loads tools from. A restricted session
 * that could write one would run code (a hook, an MCP server, a git hook run by
 * git-sync) outside the shell sandbox.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {string[]}
 */
export function restrictedRuntimePaths(env = process.env, cwd = process.cwd()) {
  const home = env.HOME || homedir();
  const paths = [
    env.CLAUDE_CONFIG_DIR || '',
    path.join(home, '.claude'),
    path.join(home, '.claude.json'),
    path.join(home, '.papercusp', 'hooks'),
    path.join(cwd, '.claude'),
    path.join(cwd, '.mcp.json'),
    path.join(cwd, '.git', 'hooks'),
  ].filter(Boolean);
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

/**
 * @param {string} target
 * @param {readonly string[]} roots
 */
export function isRestrictedRuntimePath(target, roots) {
  const abs = path.resolve(target);
  return roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
}

/** @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Keep the original script out of the updatedInput shell text. Claude Code's
 * removal heuristic inspects that text before executing it; a nested `bash -c`
 * with a complex quoted script can make the heuristic report a false `rm`
 * match. Feeding a base64 payload over stdin preserves the exact script while
 * leaving the command that Claude inspects free of the script's tokens.
 * @param {string} command
 * @param {string[]} argv
 * @returns {string}
 */
function stdinScriptCommand(command, argv) {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return ['printf', '%s', encoded, '|', 'base64', '--decode', '|', ...argv]
    .map((part) => (part === '|' ? part : shellQuote(part)))
    .join(' ');
}

/**
 * The Bash command, wrapped so it runs with NO network (see the module header).
 * Returns null when no network sandbox is available on this host.
 * @param {string} command
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   uid?: number,
 *   exists?: (p: string) => boolean,
 *   bwrap?: string,
 *   unshare?: string,
 * }} [opts]
 * @returns {string | null}
 */
export function sandboxedBashCommand(command, opts = {}) {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const uid = opts.uid ?? userInfo().uid;
  const bwrap = opts.bwrap ?? '/usr/bin/bwrap';
  const unshare = opts.unshare ?? '/usr/bin/unshare';
  if (exists(bwrap)) {
    const args = ['--dev-bind', '/', '/', '--unshare-net'];
    for (const dir of [`/run/user/${uid}`, path.join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`), '/run/screen']) {
      if (exists(dir)) args.push('--tmpfs', dir);
    }
    if (exists('/run/docker.sock')) args.push('--ro-bind', '/dev/null', '/run/docker.sock');
    for (const p of restrictedRuntimePaths(env, opts.cwd ?? process.cwd())) {
      if (exists(p)) args.push('--ro-bind', p, p);
    }
    return stdinScriptCommand(command, [bwrap, ...args, '--', '/bin/bash']);
  }
  if (exists(unshare)) {
    return stdinScriptCommand(command, [unshare, '--user', '--map-current-user', '--net', '--', '/bin/bash']);
  }
  return null;
}

/**
 * Ask the operator for the textual verdict, session restriction and integration-tree hold.
 * Either a held or unknown source state is restricted. Missing fields from an older
 * operator build are unknown too, so the transition stays fail-closed.
 * @returns {Promise<{ refuse: string | null, restricted: boolean | null, detail: string, failure: 'timeout' | 'unavailable' | null }>}
 */
async function askOperator({ owner, toolName, texts, env, fetchImpl }) {
  try {
    const res = await fetchImpl(`${operatorBase(env)}/api/agent-mcp/restricted-egress-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, tool: toolName, texts, status: true }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = res.ok ? await res.json() : null;
    if (!body || body.ok !== true) {
      return {
        refuse: null,
        restricted: null,
        detail: `HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`,
        failure: 'unavailable',
      };
    }
    const refuse = body.verdict === 'refuse' ? String(body.reason || body.code || 'disclosure_egress_refused') : null;
    const sourceHold = body.sourceHold;
    const sessionRestricted = body.restricted !== false;
    const restricted = sessionRestricted || sourceHold !== 'clear';
    const detail =
      sourceHold === 'held'
        ? 'the integration tree has an active restricted-source hold'
        : sourceHold !== 'clear'
          ? 'the integration-tree hold state could not be confirmed'
          : body.restricted === null || body.restricted === undefined
            ? 'the disclosure ledger could not be read'
            : '';
    return { refuse, restricted, detail, failure: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const name = error !== null && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    const failure = name === 'TimeoutError' || /\btimeout\b|timed out/i.test(detail) ? 'timeout' : 'unavailable';
    return { refuse: null, restricted: null, detail, failure };
  }
}

/**
 * @param {{
 *   toolName: string,
 *   toolInput?: Record<string, unknown>,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   sandbox?: (command: string) => string | null,
 *   rtk?: (command: string) => string | null,
 * }} params
 * @returns {Promise<
 *   | { decision: 'allow' }
 *   | { decision: 'deny', reason: string }
 *   | { decision: 'rewrite', updatedInput: Record<string, unknown> }
 * >}
 */
export async function decideEgress({ toolName, toolInput, cwd, env = process.env, fetchImpl = fetch, sandbox, rtk }) {
  const input = toolInput ?? {};
  const where = cwd || process.cwd();
  // The RTK form of a Bash command. Every check below judges `input`, the
  // original; only the command finally emitted is the RTK form.
  const rtkCommand =
    toolName === 'Bash' && typeof input.command === 'string'
      ? (rtk ?? ((command) => rtkRewriteSync(command, { env, cwd: where })))(input.command)
      : null;
  /** Allow, carrying the RTK rewrite when there is one. */
  const allow = () =>
    rtkCommand ? { decision: 'rewrite', updatedInput: { ...input, command: rtkCommand } } : { decision: 'allow' };
  const owner = sessionId(env);
  if (!owner) return allow();

  if (EDIT_TOOLS.has(toolName)) {
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== 'string' || !isRestrictedRuntimePath(target, restrictedRuntimePaths(env, where))) {
      return { decision: 'allow' };
    }
  } else if (toolName !== 'Bash' && toolName !== 'WebFetch' && !isForeignMcp(toolName)) {
    return { decision: 'allow' };
  }

  const texts = egressTexts(toolName, input);
  const { refuse, restricted, detail, failure } = await askOperator({ owner, toolName, texts, env, fetchImpl });
  if (refuse) return { decision: 'deny', reason: refuse };
  if (restricted === false) return allow();
  if (restricted === null && toolName === 'WebFetch') {
    const checkFailure =
      failure === 'timeout'
        ? `timed out after ${CHECK_TIMEOUT_MS} ms`
        : `failed (${detail})`;
    const providerNote = prefilterHits(texts)
      ? ' This URL also names a provider; use the applicable gated verb for provider activity.'
      : '';
    return {
      decision: 'deny',
      reason:
        `WebFetch is unavailable because the operator restriction check ${checkFailure}; ` +
        'restriction status is unknown, not a restriction verdict. Retry after the operator responds; ' +
        `if it keeps failing, inspect operator health with dev:service_health and check ` +
        `/api/agent-mcp/restricted-egress-check.${providerNote}`,
    };
  }
  if (restricted === null && prefilterHits(texts)) {
    return {
      decision: 'deny',
      reason:
        `This ${toolName} call names a mail, chat, calendar or social provider, and the operator could not ` +
        `confirm this session is unrestricted (${detail}). ` +
        `Retry when the operator is reachable, or use the gated verb (mail:send, chat:post, …).`,
    };
  }

  const why =
    restricted === true
      ? detail || 'this session has read restricted personal data'
      : `the operator could not confirm this session or integration tree is unrestricted (${detail}), so it is treated as restricted`;
  if (toolName === 'Bash' && typeof input.command === 'string') {
    // Sandbox the RTK form, so the offline shell still gets compressed output.
    const wrapped = (sandbox ?? ((command) => sandboxedBashCommand(command, { env, cwd: where })))(
      rtkCommand ?? input.command,
    );
    if (wrapped && invokesUserSystemctl(input.command) && masksUserRuntime(wrapped)) {
      return {
        decision: 'deny',
        reason:
          'This restricted shell masks `/run/user/<uid>` to prevent host-side egress, including the user systemd/D-Bus sockets. ' +
          '`systemctl --user` cannot report host unit state here, so an empty list or zero count would be misleading. ' +
          'For process liveness, inspect `ps -eo pid,user,unit,args` or the process’s procfs cgroup entry; use Papercusp service tools for registered units.',
      };
    }
    if (wrapped) return { decision: 'rewrite', updatedInput: { ...input, command: wrapped } };
    return {
      decision: 'deny',
      reason: `Bash is unavailable: ${why}, and this host has no network sandbox (bwrap or unshare) to run it offline.`,
    };
  }
  if (toolName === 'WebFetch') {
    return {
      decision: 'deny',
      reason: `WebFetch is unavailable: ${why}. Use the gated verbs (mail:send, chat:post, …) to reach a person, or have the owner release the disclosure.`,
    };
  }
  if (isForeignMcp(toolName)) {
    return {
      decision: 'deny',
      reason: `${toolName} is unavailable: ${why}, and a non-Papercusp MCP server is an ungated route off the machine.`,
    };
  }
  return {
    decision: 'deny',
    reason: `${toolName} of an agent runtime file (settings, hooks, MCP config, git hooks) is unavailable: ${why}. Code there runs outside the shell sandbox.`,
  };
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
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
  const result = await decideEgress({
    toolName: String(payload.tool_name ?? ''),
    toolInput: payload.tool_input,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
  });
  if (result.decision === 'allow') return;
  const hookSpecificOutput =
    result.decision === 'rewrite'
      ? { hookEventName: 'PreToolUse', updatedInput: result.updatedInput }
      : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('pretooluse-restricted-egress-guard.mjs');
if (invokedDirectly) {
  main().catch(() => {
    // A crashed guard must not wedge the session; the server-side checks
    // (capability:bash, the gated verbs) still hold. decideEgress itself never
    // throws on an operator failure — it treats that as restricted.
  });
}
