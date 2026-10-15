import { posix as posixPath } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Validate against the installed CLI's parser before allocating review state. */
export function preflightStockCliArgs(
  cli: 'claude' | 'codex', args: string[],
  check: (cli: string, args: string[]) => void = (command, argv) => {
    execFileSync(command, argv, { encoding: 'utf8', timeout: 15_000, stdio: 'pipe' });
  },
): void {
  try { check(cli, [...args, '--help']); }
  catch (cause) {
    const stderr = (cause as { stderr?: unknown })?.stderr;
    throw new Error(`${cli} rejected its review launch arguments before startup: ${String(stderr ?? cause).slice(0, 2000)}`, { cause });
  }
}

/** Pass the review's requested route through PUI's public launch selectors. */
export function p005PuiLaunchArgs(selection: { model?: string; account?: string }): string[] {
  return ['--solo', ...(selection.model ? ['--model', selection.model] : []),
    ...(selection.account ? ['--account', selection.account] : [])];
}

export function reviewBlockingReason(screen: string): string | null {
  if (/hit your (?:weekly |daily |session |usage )?limit|usage limit reached|quota exceeded/i.test(screen)) return 'provider usage limit';
  if (/API Error (?:40[0-3]|429)|authentication (?:failed|expired)|invalid api key/i.test(screen)) return 'provider authentication or request refusal';
  if (/Connection: Unavailable|Not connected · send a message|no longer available for this backend|is not available on this operator|no longer offered by the operator|without a usable reply/i.test(screen)) return 'connection or model unavailable';
  return null;
}

export const CODEX_HOME_SOCKET_PATH_BUDGET_BYTES = 100;
export const CODEX_GREETING_EXPECTATION = /\b(?:hi|hello|hey)\b|what can i help you with|how can i help|what would you like to work on|what are you working on/i;
export const TEST_RUN_EXPECTATION = /npm test (?:passed|passes)|(?:all|the) tests (?:pass|passed)|\bboth (?:tests )?passed\b|\b[1-9]\d* tests? passed|# pass\s+[1-9]\d*\b|\b[1-9]\d* passing\b/i;
/** The resume probe asks what the earlier edit changed (add() gained an optional
 * third operand). Engines word it differently: "optional third number",
 * "third parameter", "c = 0", or "optional third argument c (default 0)". */
export const RESUME_RECALL_EXPECTATION =
  /optional third (?:number|argument|parameter|operand)|third (?:parameter|argument)|\bc\s*=\s*0|\bc\b[^.\n]{0,24}default(?:s|ing)?(?: to)?\s*(?:value\s*)?(?:of\s*)?0/i;

export function codexHomeControlSocketPath(home: string): string {
  return posixPath.join(home, 'app-server-control', 'app-server-control.sock');
}

export function codexHomeFitsControlSocket(home: string): boolean {
  return Buffer.byteLength(codexHomeControlSocketPath(home)) < CODEX_HOME_SOCKET_PATH_BUDGET_BYTES;
}

export type CodexStartupAction = {
  kind: 'trust-folder' | 'skip-update' | 'keep-approval-required' | 'create-first-task';
  keys: string;
};

export function codexStartupAction(screen: string, allowFirstTask: boolean): CodexStartupAction | null {
  if (/Trust this folder\?[\s\S]*?1\. Trust and continue/i.test(screen)) {
    return { kind: 'trust-folder', keys: '\r' };
  }
  if (/Update available[\s\S]*?Skip\b/i.test(screen)) {
    return { kind: 'skip-update', keys: '\x1b[B\r' };
  }
  if (/(?:ask me to approve|Require approval)/i.test(screen)) {
    return { kind: 'keep-approval-required', keys: '\x1b[B\r' };
  }
  if (allowFirstTask && /Agent command center[\s\S]*No tasks yet[\s\S]*\bn\s+new\b/i.test(screen)) {
    return { kind: 'create-first-task', keys: 'n' };
  }
  return null;
}

export function isCodexPromptReady(screen: string): boolean {
  if (/Installing daemon|model:\s*loading|directory:\s*loading/i.test(screen)) return false;
  return /(?:›\s*Ask Codex to do anything|The prompt is yours\.)/i.test(screen);
}

/**
 * True when the screen shows `prompt` echoed after an input glyph (Codex `›`,
 * Claude Code / pui `❯`, a `>` composer) and `expected` matches text AFTER the
 * last such echo. Matching the whole screen is a false pass: an earlier user
 * prompt or transcript line can contain the expected words (P-022's resume
 * recall matched "optional third number" in the earlier edit request while the
 * pui resume picker was still loading and nothing had been asked).
 */
export function taskAnsweredAfterPrompt(screen: string, prompt: string, expected: RegExp): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visible = normalize(screen);
  // Punctuation in the echo is optional: stock Codex 0.160.1 echoed
  // "…this conversation One sentence." for a prompt typed with "?" (P-032).
  const echoPattern = [...normalize(prompt)]
    .map((ch) => (/[?!.,;:]/.test(ch) ? `${escape(ch)}?` : escape(ch)))
    .join('');
  const echo = new RegExp(`[›❯>]\\s*${echoPattern}`, 'g');
  let end = -1;
  for (let m = echo.exec(visible); m; m = echo.exec(visible)) end = m.index + m[0].length;
  if (end < 0) return false;
  const safeExpected = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ''));
  return safeExpected.test(visible.slice(end));
}

export function codexTaskCompleted(screen: string, prompt: string, expected: RegExp): boolean {
  return isCodexPromptReady(screen) && taskAnsweredAfterPrompt(screen, prompt, expected);
}
