/**
 * WI-10006716 — a spawner-sidecar call whose TRANSPORT failed after `process:exec`
 * was dispatched has an UNKNOWN outcome. The child may never have started, may
 * still be running, or may already have written the index or a ref. Replaying
 * such a command locally can run a mutation twice, or race its own twin on
 * `index.lock`. A transport failure BEFORE dispatch is different: nothing ran,
 * so a local fallback is safe.
 *
 * Signal-bearing calls already handle the post-dispatch case inside
 * `runCommandViaSpawnerSidecar` (they drain and resolve "outcome unavailable").
 * Calls without a signal keep the legacy contract of rethrowing the transport
 * error, so the throw site marks the error and callers ask
 * {@link isSidecarPostDispatchFault} before replaying a mutation.
 *
 * This lives in its own module, not in git-via-sidecar.ts, because many suites
 * mock git-via-sidecar wholesale. A predicate exported from there would be
 * undefined under every such mock, and each of those suites would break.
 */

const POST_DISPATCH = Symbol.for('@papercusp/operator-core.sidecarPostDispatchFault');

export interface SidecarPostDispatchDetail {
  /** The IPC request id the sidecar assigned to the dispatched `process:exec`. */
  requestId: number;
}

/**
 * Mark `error` as a transport failure that happened after dispatch. The original
 * error object, message and `code` are preserved, so existing catch sites behave
 * exactly as before; only callers that ask the predicate change behaviour.
 */
export function markSidecarPostDispatchFault(error: unknown, requestId: number): Error {
  let marked: Error = error instanceof Error ? error : new Error(String(error));
  if (!Object.isExtensible(marked)) marked = new Error(marked.message, { cause: marked });
  Object.defineProperty(marked, POST_DISPATCH, {
    value: { requestId } satisfies SidecarPostDispatchDetail,
    enumerable: false,
  });
  return marked;
}

/** True when the sidecar may have run the command before its transport failed. */
export function isSidecarPostDispatchFault(error: unknown): boolean {
  return typeof error === 'object' && error !== null && POST_DISPATCH in error;
}

/** The dispatch detail recorded by {@link markSidecarPostDispatchFault}, if any. */
export function sidecarPostDispatchDetail(error: unknown): SidecarPostDispatchDetail | null {
  if (!isSidecarPostDispatchFault(error)) return null;
  return (error as { [POST_DISPATCH]: SidecarPostDispatchDetail })[POST_DISPATCH];
}

/** Stable stderr prefix for a mutating Git command that was deliberately NOT replayed. */
export const SIDECAR_POST_DISPATCH_NOT_REPLAYED =
  'sidecar transport lost after dispatch; outcome unknown, command not replayed locally';

/**
 * Git subcommands whose local replay cannot double-apply anything: they only
 * read repository state. Deliberately an allowlist. A subcommand that reads or
 * writes depending on its arguments (`config`, `symbolic-ref`, `tag`, `branch`)
 * is absent, and so is `fetch`, whose replay would race its still-running twin
 * on the same ref locks.
 */
const GIT_REPLAY_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'rev-parse', 'status', 'cat-file', 'ls-files', 'ls-tree', 'merge-base', 'rev-list',
  'for-each-ref', 'show-ref', 'log', 'show', 'diff', 'diff-tree', 'ls-remote',
]);

/** The Git subcommand in an argv, skipping global flags and the value `-c`/`-C` consume. */
export function gitSubcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return '';
}

/**
 * True when a Git command may be replayed locally even though a sidecar copy may
 * already have run. A post-dispatch fault on any other command must surface as
 * an unknown outcome so the caller re-reads repository state instead.
 */
export function gitReplayIsSafe(args: readonly string[]): boolean {
  return GIT_REPLAY_SAFE_SUBCOMMANDS.has(gitSubcommandOf(args));
}

/**
 * The result a git runner returns instead of replaying a command whose sidecar
 * outcome is unknown. `code: -1` keeps it on every caller's existing failure path.
 */
export function sidecarPostDispatchUnknownResult(
  args: readonly string[],
  error: unknown,
): { code: number; stdout: string; stderr: string } {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: -1,
    stdout: '',
    stderr: `git ${gitSubcommandOf(args) || '<none>'}: ${SIDECAR_POST_DISPATCH_NOT_REPLAYED} (${reason})`,
  };
}
