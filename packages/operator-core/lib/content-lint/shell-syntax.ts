/**
 * Shell syntax detector — the pure half of a `bash -n` check, lifted into an
 * importable module for the git-sync content guard (EI-13192).
 *
 * EI-13192: a concurrent shared-tree edit interleave duplicated ~475 lines of
 * `papercusp-desktop/bin/build-windows-on-vm.sh` (plus truncated one variable
 * assignment) and git-sync auto-committed the corrupted 1584-line file before
 * the editing agent ran `bash -n` by hand to notice. `bash -n` catches this
 * class of damage IMMEDIATELY and for free — it is the real bash parser doing
 * a syntax-only pass (no execution), the exact same command a careful agent
 * runs after a suspicious edit. Wiring it into the SAME content-guard registry
 * `mdx`/`smart-quotes` already use (git-sync-content-guard-2026-06-13) means a
 * syntactically-broken `.sh` is quarantined — never silently committed — with
 * no new mechanism.
 *
 * Not fully pure (shells out to the real `bash` binary rather than parsing in
 * JS), but deterministic and read-only: same input text always yields the same
 * verdict, and nothing on disk is touched. Mirrors `findMdxCompileError`'s
 * shape: never throws on a syntax error (caught + returned); a failure to
 * SPAWN bash at all propagates so the caller can decide (the git-sync guard's
 * detector loop already fails open on a throwing detector).
 */
import { execFileSync } from 'node:child_process';

export interface ShellSyntaxError {
  line: number | null;
  reason: string;
}

/** Bound the check so a pathological input can never hang git-sync's tick. */
export const BASH_SYNTAX_CHECK_TIMEOUT_MS = 5_000;

export interface FindShellSyntaxErrorOptions {
  /** Per-call `bash -n` timeout. Defaults to the git-sync tick bound above. */
  timeoutMs?: number;
}

/**
 * Thrown when `bash -n` produced NO verdict: it timed out, could not be spawned,
 * or was killed by a signal. That is "unknown", never "broken" (WI-10008204).
 * Before this split a 5s timeout under gate load came back as a syntax error
 * (`scripts/pc-heavy.sh:?  spawnSync bash ETIMEDOUT`), so a clean script read as
 * BROKEN, and the git-sync content guard could quarantine a good file. Both
 * guard call sites already catch a throwing detector (fail-open on the commit
 * path, fail-closed on revalidation), which is the right handling for "unknown".
 */
export class ShellSyntaxCheckUnavailableError extends Error {
  readonly code: string | null;
  readonly signal: string | null;
  constructor(message: string, code: string | null, signal: string | null) {
    super(message);
    this.name = 'ShellSyntaxCheckUnavailableError';
    this.code = code;
    this.signal = signal;
  }
}

/**
 * Run `bash -n` over `text` via stdin (no temp file — the working-tree text is
 * already in memory). Returns `null` when it parses cleanly, or the parsed
 * `{ line, reason }` from bash's own stderr on a syntax error. Throws
 * {@link ShellSyntaxCheckUnavailableError} when bash gave no verdict at all.
 */
export function findShellSyntaxError(
  text: string,
  opts: FindShellSyntaxErrorOptions = {},
): ShellSyntaxError | null {
  try {
    execFileSync('bash', ['-n'], {
      input: text,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: opts.timeoutMs ?? BASH_SYNTAX_CHECK_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    const e = err as {
      stderr?: Buffer | string | null;
      message?: string;
      status?: number | null;
      signal?: string | null;
      code?: string;
    };
    // Only a bash that RAN to completion and EXITED non-zero has judged the text.
    // A spawn-level failure carries `code` (ETIMEDOUT, ENOENT, …); a kill leaves
    // `status` null and sets `signal`. Neither is a parse verdict.
    if (e.code != null || e.signal != null || typeof e.status !== 'number') {
      throw new ShellSyntaxCheckUnavailableError(
        `bash -n gave no verdict (${e.code ?? e.signal ?? 'no exit status'}): ${e.message ?? String(err)}`,
        e.code ?? null,
        e.signal ?? null,
      );
    }
    const stderrText = e.stderr != null ? String(e.stderr) : '';
    const raw = stderrText.trim() || (e.message ?? String(err));
    // `bash -n` reading from stdin reports errors like:
    //   bash: line 4: syntax error: unexpected end of file
    //   bash: line 12: syntax error near unexpected token `fi'
    const m = /line (\d+):\s*(.+)/.exec(raw);
    return { line: m ? Number(m[1]) : null, reason: (m ? m[2] : raw).split('\n')[0] };
  }
}
