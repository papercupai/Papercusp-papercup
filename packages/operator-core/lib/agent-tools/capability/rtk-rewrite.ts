/**
 * RTK output compression for capability:bash (owner directives #1759 / #1764,
 * WI-6554700010009291).
 *
 * RTK (https://github.com/rtk-ai/rtk) rewrites a shell command to a wrapper that
 * runs the same command and compresses its output (`git status` → `rtk git
 * status`, `cat f` → `rtk read f`). Exit codes and porcelain formats pass through.
 * Claude's native Bash reaches RTK through a PreToolUse hook. Our own shell tool
 * replaces native Bash for fleet roles (FLEET_CAPABILITY_REPLACED_TOOLS), so
 * without this seam every command run through capability:bash would skip RTK.
 *
 * The contract is FAIL-OPEN to the verbatim command: a missing binary, a slow
 * or failing `rtk rewrite`, a denial, or the kill-switch flag being OFF all run
 * the original command unchanged. Every outcome is returned with a reason, so
 * the integration's health check can tell "RTK had nothing to compress" apart
 * from "RTK is gone". A silent no-op was how RTK disappeared last time: the
 * binary was lost on 2026-08-15 and nothing noticed.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** Override for the RTK binary location. An empty value disables RTK. */
export const RTK_BIN_ENV = 'PAPERCUSP_RTK_BIN';

/** Ceiling for one `rtk rewrite` call; measured at ~50-100 ms on this host. */
export const RTK_REWRITE_TIMEOUT_MS = 2_000;

/**
 * Commands larger than this are not offered to `rtk rewrite`. A command is
 * passed as one argv element, and an oversized argument fails the spawn with
 * E2BIG. Such commands are heredoc payloads that RTK does not rewrite anyway.
 */
export const RTK_MAX_COMMAND_CHARS = 16_384;

/** The prefix an agent writes to get raw output for one command. RTK honours it too. */
export const RTK_OPT_OUT_PREFIX = 'RTK_DISABLED=1';

/**
 * Environment for every process that runs RTK-rewritten commands
 * (WI-6554700010009529). RTK checks whether its OWN hook is installed and,
 * when it is not, periodically prints `[rtk] /!\ No hook installed — run
 * `rtk init -g`` to stderr, which lands in the agent's tool output. Our seams
 * (this capability:bash rewrite, the Claude and Codex PreToolUse hooks) are
 * deliberately not RTK's hook, and following that advice would install a
 * second, competing rewrite. Measured: the variable removes the line with a
 * fresh XDG_DATA_HOME; config.toml keys do not.
 *
 * Applied at three seams: the capability:bash child env (below), each psu
 * Claude session's settings `env` (interactive-claude-config.ts) and every
 * managed CODEX_HOME's `[shell_environment_policy.set]`
 * (orchestrator codex-gateway-config.ts, pinned to this value by a test).
 */
export const RTK_SESSION_ENV: Readonly<Record<string, string>> = Object.freeze({
  RTK_SUPPRESS_HOOK_WARNING: '1',
});

export type RtkSkipReason =
  | 'flag-off'
  | 'structured-caller'
  | 'opt-out'
  | 'vitest'
  | 'early-exit-pipe'
  | 'grep-no-filename'
  | 'too-long'
  | 'rtk-missing'
  | 'no-equivalent'
  | 'rtk-denied'
  | 'rtk-error'
  | 'rtk-timeout';

export type RtkRewriteOutcome =
  | { kind: 'rewritten'; command: string; bin: string }
  | { kind: 'unchanged'; reason: RtkSkipReason; detail?: string };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the RTK binary. Order: the explicit override, then `~/.local/bin/rtk`
 * (where the installer pins it, outside Homebrew so a prefix rebuild cannot
 * remove it again), then PATH.
 *
 * Under Vitest, the host's installed binary is never picked up implicitly: a
 * test asserting on the spawned command string must not change because rtk
 * happens to be installed on the machine running it. A test that exercises RTK
 * sets the override to a fake binary.
 */
export function resolveRtkBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[RTK_BIN_ENV];
  if (explicit !== undefined) {
    const value = explicit.trim();
    return value && isExecutable(value) ? value : null;
  }
  if (env.VITEST) return null;
  const home = env.HOME || homedir();
  const candidates = [join(home, '.local', 'bin', 'rtk')];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'rtk'));
  }
  return candidates.find(isExecutable) ?? null;
}

/**
 * A pipe (`|` or `|&`, never `||`) into a consumer that stops reading early:
 * `head`, `grep`/`rg` with a match limit (`-m N`, `--max-count`), or `sed … Nq`.
 * Kept identical to the copy in apps/operator/scripts/hooks/cc/pretooluse-restricted-egress-guard.mjs.
 */
export const RTK_EARLY_EXIT_PIPE =
  /(?:^|[^|])\|(?!\|)&?\s*(?:head\b|(?:rg|[ef]?grep)\b[^|;&\n]*\s(?:-m\s*\d|-[A-Za-z]*m\d|--max-count\b)|sed\b[^|;&\n]*\d+q\b)/;

/**
 * A grep/egrep/fgrep carrying `-h` in any short-flag cluster (`-h`, `-hn`, `-rh`)
 * or `--no-filename`. In grep that flag means "no file names"; in `rtk grep` it
 * means --help, and `rtk rewrite` still proposes the RTK form, so the agent got
 * RTK's usage text with exit 0 instead of its matches (WI-6554700010009627). The
 * scan runs to the next `;`/`&`, across `|`, so a quoted `'a|b'` before `-h`
 * cannot hide it. An over-match only costs compression.
 * Kept identical to the copy in apps/operator/scripts/hooks/cc/pretooluse-restricted-egress-guard.mjs.
 */
export const RTK_GREP_NO_FILENAME =
  /(?:^|[\s|;&(/])[ef]?grep\s(?:[^;&\n]*\s)?(?:-[A-Za-z0-9]*h[A-Za-z0-9]*|--no-filename)(?=[\s;&|)]|$)/;

/**
 * Commands RTK must never wrap, decided on the command text alone.
 * - vitest: RTK's vitest wrapper dropped a single-file filter and ran the whole
 *   suite when its parser failed (EI-9471: a 20 s check became a 10,385-suite run).
 * - early-exit pipes: RTK collects a command's whole output before printing, so
 *   `head` closing the pipe no longer ends the producer. Measured 2026-10-13
 *   (WI-6554700010009543): `rg … | head -60` took 0.5 s raw and 28.5 s as
 *   `rtk rg … | head -60`. The agent already bounded that output itself.
 * - `grep -h`: RTK reads `-h` as --help (RTK_GREP_NO_FILENAME).
 * - the opt-out prefix: the agent asked for raw output.
 */
export function rtkSkipReasonForCommand(command: string): RtkSkipReason | null {
  if (command.length > RTK_MAX_COMMAND_CHARS) return 'too-long';
  if (/(^|[\s;&|(])RTK_DISABLED=1(\s|$)/.test(command)) return 'opt-out';
  if (/\bvitest\b/.test(command)) return 'vitest';
  if (RTK_EARLY_EXIT_PIPE.test(command)) return 'early-exit-pipe';
  if (RTK_GREP_NO_FILENAME.test(command)) return 'grep-no-filename';
  return null;
}

/**
 * Ask `rtk rewrite` for the RTK form of `command`.
 *
 * rtk's exit codes: 0 = rewritten; 3 = rewritten but its own Claude permission
 * check wants to ask (irrelevant here: capability:bash applies its own gates to
 * the original command before this runs); 1 = no RTK equivalent; 2 = denied by
 * rtk's permission rules, so the verbatim command runs and the normal gates
 * decide. Only stdout carries the command; stderr holds rtk's warnings.
 */
export function rtkRewrite(
  command: string,
  opts: { bin: string; cwd: string; timeoutMs?: number },
): Promise<RtkRewriteOutcome> {
  const timeoutMs = opts.timeoutMs ?? RTK_REWRITE_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (outcome: RtkRewriteOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin, ['rewrite', command], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolvePromise({ kind: 'unchanged', reason: 'rtk-error', detail: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'unchanged', reason: 'rtk-timeout', detail: `rtk rewrite exceeded ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle({
        kind: 'unchanged',
        reason: error.code === 'ENOENT' ? 'rtk-missing' : 'rtk-error',
        detail: error.message,
      });
    });
    child.on('close', (code) => {
      const rewritten = stdout.replace(/[\r\n]+$/, '');
      if ((code === 0 || code === 3) && rewritten.trim() && rewritten !== command) {
        settle({ kind: 'rewritten', command: rewritten, bin: opts.bin });
      } else if (code === 0 || code === 1 || code === 3) {
        settle({ kind: 'unchanged', reason: 'no-equivalent' });
      } else if (code === 2) {
        settle({ kind: 'unchanged', reason: 'rtk-denied' });
      } else {
        settle({ kind: 'unchanged', reason: 'rtk-error', detail: `rtk rewrite exited ${code}` });
      }
    });
  });
}

export interface CapabilityBashRtkResult {
  /** The command to spawn: the RTK form, or the original when unchanged. */
  command: string;
  outcome: RtkRewriteOutcome;
  /**
   * Child-env additions, present only for a rewritten command: RTK_SESSION_ENV,
   * plus PATH when needed. RTK prints a bare `rtk`, so the binary's directory
   * must be on the child's PATH; it is added only when it is not already there.
   */
  env?: Record<string, string>;
}

/**
 * The single capability:bash seam. Callers that parse output (code-mode
 * scripts, clients that asked for structured content) get the verbatim command:
 * RTK's compressed text is for a model to read, and a script parsing
 * `git log` would break on it.
 */
export async function rtkCommandForCapabilityBash(
  command: string,
  opts: {
    cwd: string;
    structuredCaller: boolean;
    flagEnabled: () => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<CapabilityBashRtkResult> {
  const unchanged = (reason: RtkSkipReason, detail?: string): CapabilityBashRtkResult => ({
    command,
    outcome: detail ? { kind: 'unchanged', reason, detail } : { kind: 'unchanged', reason },
  });
  if (opts.structuredCaller) return unchanged('structured-caller');
  const skip = rtkSkipReasonForCommand(command);
  if (skip) return unchanged(skip);
  // Binary before flag: the filesystem check is cheap and local, and a host
  // without RTK (or a test that did not opt in) never reads the flag at all.
  const env = opts.env ?? process.env;
  const bin = resolveRtkBin(env);
  if (!bin) return unchanged('rtk-missing');
  let enabled = false;
  try {
    enabled = await opts.flagEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) return unchanged('flag-off');
  const outcome = await rtkRewrite(command, { bin, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  if (outcome.kind !== 'rewritten') return { command, outcome };
  const binDir = dirname(bin);
  const path = env.PATH ?? '';
  const onPath = path.split(delimiter).includes(binDir);
  return {
    command: outcome.command,
    outcome,
    env: {
      ...RTK_SESSION_ENV,
      ...(onPath ? {} : { PATH: path ? `${binDir}${delimiter}${path}` : binDir }),
    },
  };
}
