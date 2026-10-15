/**
 * Shared PROBE helper for the cc-hook suites — run a hook out of its own directory, or an OLD
 * version of it, without turning a crash into a false ALLOW (EI-23757282243623667).
 *
 * THE TRAP THIS EXISTS FOR. Every cc hook's cardinal contract is "never fail, and print NOTHING
 * on the allow path". That is what makes them safe in production, and it is exactly what makes
 * them silently UNMEASURABLE out of tree: most hooks resolve SIBLING files beside themselves
 * (`pc_tty.py`, `mcp_response.py`, `import('./x.mjs')`). Copy ONE hook file to `/tmp` — the
 * obvious way to A/B a pre-fix version (`git show <sha>:<path> > /tmp/hook.sh`) — and the sibling
 * import dies at startup, the hook honours fail-open, and the caller sees exit 0 + empty stdout.
 * That is BYTE-IDENTICAL to the ALLOW verdict, so EVERY probe case reads ALLOW — including the
 * one that must BLOCK — and the matrix reads as "the bug does not reproduce". It is the reading
 * that makes you close an item wrongly.
 *
 * THREE DEFENCES, all here so nobody re-derives them:
 *
 *  1. {@link materializeHookDir} — copy the WHOLE hooks directory (not one file) and overwrite
 *     just the subject with the historical bytes, so siblings resolve.
 *  2. {@link assertHookInstrument} — a POSITIVE CONTROL (a case that MUST block) run against the
 *     SAME copy before any ALLOW from it is believed. A uniformly-ALLOW matrix is the tell.
 *  3. {@link classifyHookRun} — a three-valued verdict. A BLOCK is positive evidence the hook ran;
 *     an ALLOW must be proven CLEAN (exit 0, empty stderr), so a crash is CRASHED, never ALLOW.
 *
 * Scope note: `scripts/mutation-probe.sh` has its own relocation/behaviour defences for guards in
 * general (`--relocation overlay`, `--subject-must-behave`). This helper is the in-Vitest
 * counterpart for the hook suites, which spawn the hook directly with `runHookProcess`.
 *
 * ⚠ When materialising from git, pass a SHA — never `HEAD`/`HEAD~N`. git-sync commits this tree
 * continuously, so `HEAD` is a wall-clock moving baseline: minutes after your edit it hands back
 * YOUR OWN edit, and the "pre-fix" arm silently becomes the post-fix code.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHookProcess, type HookRunResult } from './spawn-hook';

/** The real `apps/operator/scripts/hooks/cc` directory (this file lives in its `__tests__`). */
export const HOOKS_CC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `ALLOW` only ever means "ran cleanly and said nothing/allow". A crash is `CRASHED`. */
export type HookVerdict = 'ALLOW' | 'BLOCK' | 'CRASHED';

export interface ClassifyOptions {
  /** Override what counts as a block. Default: {@link defaultIsBlock}. */
  isBlock?: (run: HookRunResult) => boolean;
  /**
   * stderr lines matching this are ignored when deciding CRASHED. Use ONLY for a hook that writes
   * a known benign notice to stderr on the allow path — never a catch-all (a catch-all re-opens
   * the false-ALLOW this file exists to close).
   */
  tolerateStderr?: RegExp;
}

/**
 * The block encodings the cc hooks use: exit 2 (PreToolUse convention), a Stop/PostToolUse
 * `{ decision: 'block' }`, or a PreToolUse `hookSpecificOutput.permissionDecision: 'deny'`.
 */
export function defaultIsBlock(run: HookRunResult): boolean {
  if (run.status === 2) return true;
  const out = run.stdout.trim();
  if (!out) return false;
  try {
    const parsed = JSON.parse(out) as {
      decision?: unknown;
      hookSpecificOutput?: { permissionDecision?: unknown; decision?: unknown };
    };
    const hso = parsed?.hookSpecificOutput ?? {};
    return (
      parsed?.decision === 'block' || hso.permissionDecision === 'deny' || hso.decision === 'block'
    );
  } catch {
    return false;
  }
}

/**
 * Three-valued verdict. Order matters and is the whole point:
 *   BLOCK   — positive evidence the hook ran far enough to decide (a crash cannot print a decision).
 *   CRASHED — anything else that is not a clean zero-exit with empty stderr. Fail-open hooks print
 *             nothing on ALLOW, so a hook that died at import time looks exactly like an ALLOW on
 *             stdout; the stderr/exit-code evidence is what separates them.
 *   ALLOW   — exit 0, empty (or tolerated) stderr, no block encoding.
 */
export function classifyHookRun(run: HookRunResult, opts: ClassifyOptions = {}): HookVerdict {
  const isBlock = opts.isBlock ?? defaultIsBlock;
  if (isBlock(run)) return 'BLOCK';
  if (run.status !== 0) return 'CRASHED';
  const tolerate = opts.tolerateStderr
    ? new RegExp(opts.tolerateStderr.source, opts.tolerateStderr.flags.replace('g', ''))
    : null;
  const noisy = run.stderr
    .split('\n')
    .some((line) => line.trim() !== '' && !(tolerate && tolerate.test(line)));
  return noisy ? 'CRASHED' : 'ALLOW';
}

export interface MaterializedHooks {
  /** The temp directory holding the full hooks tree. */
  dir: string;
  /** Absolute path of the subject hook inside {@link dir}. */
  hookPath: string;
  /** Remove {@link dir}. Idempotent. */
  cleanup(): void;
}

export interface MaterializeOptions {
  /** Directory to copy whole. Default: the real hooks/cc dir. */
  hooksDir?: string;
  /** The subject, as a basename inside {@link hooksDir} (e.g. `'ask-gate-mirror.sh'`). */
  hookFile: string;
  /** Replacement bytes for the subject (e.g. a historical version). Mutually exclusive with `gitRef`. */
  content?: string | Buffer;
  /** Read the subject's bytes at this git ref (a SHA — see the file header). Exclusive with `content`. */
  gitRef?: string;
}

// Never carried into the copy: tests aren't the subject's runtime siblings, the others are caches /
// editor droppings that only add copy weight.
const SKIP_DIRS = new Set(['__tests__', '__pycache__', 'node_modules']);

/**
 * Copy the WHOLE hooks directory to a fresh temp dir and (optionally) overwrite one file in the
 * copy with other bytes. With neither `content` nor `gitRef` it is a faithful relocated copy of the
 * CURRENT subject — useful as the "post-fix" arm of an A/B so both arms live in identical dirs.
 */
export function materializeHookDir(opts: MaterializeOptions): MaterializedHooks {
  const hooksDir = resolve(opts.hooksDir ?? HOOKS_CC_DIR);
  if (opts.content !== undefined && opts.gitRef !== undefined) {
    throw new Error('materializeHookDir: pass `content` OR `gitRef`, not both');
  }
  if (opts.hookFile !== basename(opts.hookFile)) {
    throw new Error(
      `materializeHookDir: hookFile must be a basename inside hooksDir, got ${opts.hookFile}`,
    );
  }
  const original = join(hooksDir, opts.hookFile);
  if (!fs.existsSync(original)) {
    throw new Error(`materializeHookDir: ${opts.hookFile} not found in ${hooksDir}`);
  }

  let replacement: string | Buffer | undefined = opts.content;
  if (opts.gitRef !== undefined) {
    // `ref:./name` is cwd-relative, so this works from any hooksDir without knowing the repo prefix.
    replacement = execFileSync('git', ['show', `${opts.gitRef}:./${opts.hookFile}`], {
      cwd: hooksDir,
      maxBuffer: 64 * 1024 * 1024,
      env: cleanGitEnv(),
    });
  }

  const dir = fs.mkdtempSync(join(os.tmpdir(), 'hook-probe-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.cpSync(hooksDir, dir, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.has(basename(src)) && !src.endsWith('.tmp'),
    });
    const hookPath = join(dir, opts.hookFile);
    if (replacement !== undefined) {
      const mode = fs.statSync(original).mode;
      fs.writeFileSync(hookPath, replacement);
      fs.chmodSync(hookPath, mode);
    }
    return { dir, hookPath, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** How to launch a hook file by extension (the cc hooks are `.sh`, `.mjs`, and a few `.py`). */
export function interpreterFor(hookPath: string): { command: string; args: string[] } {
  switch (extname(hookPath)) {
    case '.mjs':
    case '.js':
      return { command: process.execPath, args: [hookPath] };
    case '.sh':
      return { command: 'bash', args: [hookPath] };
    case '.py':
      return { command: 'python3', args: [hookPath] };
    default:
      return { command: hookPath, args: [] };
  }
}

export interface RunVerdictOptions extends ClassifyOptions {
  input?: string;
  env: Record<string, string | undefined>;
}

/** Run a hook the way Claude Code does (stdin payload, hermetic env) and classify the outcome. */
export async function runHookVerdict(
  hookPath: string,
  opts: RunVerdictOptions,
): Promise<{ verdict: HookVerdict; run: HookRunResult }> {
  const { command, args } = interpreterFor(hookPath);
  const run = await runHookProcess(command, args, { input: opts.input, env: opts.env });
  return { verdict: classifyHookRun(run, opts), run };
}

export interface InstrumentCase {
  name: string;
  input?: string;
  env?: Record<string, string | undefined>;
}

export interface AssertInstrumentOptions extends ClassifyOptions {
  /** Env applied to every control run (a case's own `env` overlays it). */
  env: Record<string, string | undefined>;
  /** A case the subject MUST block, in EVERY version under test. */
  positiveControl: InstrumentCase;
  /** Optional: a case the subject MUST cleanly allow (proves it isn't just blocking/crashing noisily). */
  negativeControl?: InstrumentCase;
}

/** Thrown when the probe INSTRUMENT is broken — distinct from "the subject has the bug". */
export class HookInstrumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookInstrumentError';
  }
}

/**
 * Run the control(s) against THIS copy of the hook and throw {@link HookInstrumentError} unless the
 * positive control BLOCKs (and the negative control, when given, ALLOWs cleanly). Call it once per
 * materialised copy BEFORE believing any ALLOW from it. A uniformly-ALLOW matrix with a failing
 * positive control means the instrument — not the subject — is broken.
 */
export async function assertHookInstrument(
  hookPath: string,
  opts: AssertInstrumentOptions,
): Promise<void> {
  const run1 = async (c: InstrumentCase) =>
    runHookVerdict(hookPath, {
      input: c.input,
      env: { ...opts.env, ...c.env },
      isBlock: opts.isBlock,
      tolerateStderr: opts.tolerateStderr,
    });

  const pos = await run1(opts.positiveControl);
  if (pos.verdict !== 'BLOCK') {
    throw new HookInstrumentError(
      `positive control "${opts.positiveControl.name}" returned ${pos.verdict} (expected BLOCK) for ${hookPath}. ` +
        'The INSTRUMENT is broken, not the subject: every ALLOW from this hook copy is untrustworthy. ' +
        'Likeliest cause: the hook was relocated without its sibling files — use materializeHookDir ' +
        `(whole-directory copy). status=${pos.run.status} stderr=${JSON.stringify(pos.run.stderr.slice(0, 400))}`,
    );
  }
  if (opts.negativeControl) {
    const neg = await run1(opts.negativeControl);
    if (neg.verdict !== 'ALLOW') {
      throw new HookInstrumentError(
        `negative control "${opts.negativeControl.name}" returned ${neg.verdict} (expected ALLOW) for ${hookPath}. ` +
          `status=${neg.run.status} stderr=${JSON.stringify(neg.run.stderr.slice(0, 400))}`,
      );
    }
  }
}

/** `process.env` with git's per-invocation repo selectors removed, so a probe's `git` never aims at an outer repo. */
export function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}
