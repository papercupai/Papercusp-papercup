/**
 * The git-sync pipeline — git-sync-auto-commit. The pure-ish unit (inject `runGit`
 * + `repoPath` to test); `git-sync-action.ts` wraps it with locks, conflict
 * escalation + resolver, and routine-metadata recording.
 *
 * Syncs the WHOLE repo to origin — dynamically + recursively, no hardcoded list:
 *   - `syncOneRepo` is the per-repo primitive: commit dirty (whole-tree `git add -A`)
 *     → fetch → merge (handles diverged / non-fast-forward) → push. On a merge
 *     conflict it aborts to a CLEAN tree and reports the conflict (agents must never
 *     see a half-merged tree).
 *   - Submodules are discovered at runtime via `git submodule status --recursive`
 *     (auto-adjusts to whatever submodules exist, to any nesting depth — add/remove
 *     one and it's picked up with no code change) and synced **deepest-first**, so a
 *     child's commit is on its origin before any parent's pointer to it is pushed →
 *     a fresh clone of pushed `main` always resolves the entire tree. Each level's
 *     pointer bump shows up as a dirty change when its parent is synced.
 *   - The superproject is synced last.
 *   - EI-18689553108460319: whether the SUPERPROJECT pushes (`GitSyncConfig.push`) and
 *     whether SUBMODULES push to their own origins (`GitSyncConfig.pushSubmoduleOrigins`)
 *     are INDEPENDENT knobs. A bridged/p2p-only hive sets `push:false` so its bridge
 *     writer stays the sole pusher of the hive's own canonical superproject refs — that
 *     never implies submodules (unrelated, independently-hosted GitHub libs) should also
 *     go commit-only; nothing else ever pushes them, so doing so silently strands their
 *     history forever (8 days / 65 commits observed on `libs/generic/sync` before this fix).
 *
 * git-sync DELIBERATELY `git add -A`s each repo (unlike the SCOPED git-export
 * committer in `git-committer.ts`) — owning the whole-tree commit is its entire
 * purpose (it's why agents stop committing).
 *
 * WI-1416: the pass is CHECKPOINTABLE — three phases (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) run under the injectable
 * `RunGitSyncOpts.step` seam so a durable caller records one DBOS
 * operation_output per phase, and every git subprocess is time-bounded (the hang
 * guard below). See GitSyncStepRunner for the replay-safety contract.
 */
import { spawn } from 'node:child_process';
import pLimit from 'p-limit';
import { collectChildOutput } from '../../child-output.js';
import { processGroupLifetime } from '../../fleet/process-group-lifetime';
import { withGitFetchHeadroom } from './git-fetch-headroom';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { isUnderAnyPath, unpublishedNestedPotCheckouts } from './nested-pot-checkouts';
import { mapLiveLockHoldingsForRepo } from './live-lock-coordinates';
import { scanProcForOpenFile } from './proc-open-file-scan';
import { projectDirForSlug } from '../../operator-notes';
import { gitSidecarEnabled, isSidecarInfrastructureFault, noteSidecarFallback, runGitViaSpawnerSidecar, type SidecarDiagnosticTags } from '../../fleet/git-via-sidecar';
import { gitSubcommandOf } from '../../fleet/sidecar-read-only-git';
import { gitReplayIsSafe, isSidecarPostDispatchFault, sidecarPostDispatchUnknownResult } from '../../fleet/sidecar-dispatch-fault';
import {
  detectContentOffenders,
  detectUnscannedStagedOffenders,
  parseDirtyPaths,
  type ContentOffender,
} from './content-guard';
import {
  detectStagedDeletionsStillImported,
  detectUnsafeDeletions,
  normalizeModulePath,
  RESOLVABLE_EXTS,
} from './deletion-import-guard';
import { detectWholesaleDeletion } from './wholesale-deletion-guard';
import { checkIgnoreVerbatimBatches } from './check-ignore-argv';
import { runSyncBack, type SyncBackConfig, type SyncBackResult } from './sync-back';
import {
  collectDirtyImportEdges,
  detectQuarantineImporters,
  detectStagedProvidersOfHeldImporters,
} from './quarantine-import-guard';
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from '../../content-lint/registry';
import { armedMigrationFilename } from '../../migration-reservation';
import { acquireInstallBoundaryLease, type InstallBoundaryLease } from '../../install-boundary-lease';
import {
  groupFilesForAttribution,
  mergeImportLinkedGroups,
  attributionMapForRepo,
  diffDerivedSubject,
  inheritCompanionDeclarationAttribution,
  parseNumstat,
  readCommitAgents,
  COMMIT_MESSAGE_FORMAT,
  DEFAULT_GIT_SYNC_SUBJECT,
  type FileAttribution,
  type AttributionRosterEntry,
} from './git-sync-attribution';
import { attributionScopeLabel, resolveAttributionRepo } from './attribution-repo';

/**
 * Per-call options a git runner must forward to the git child.
 *
 * WI-10006705: `env` carries `GIT_INDEX_FILE` for the attributed commit's PRIVATE
 * index. A wrapping runner that drops it would silently run those commands against
 * the SHARED index, so commitAttributedGroups probes the runner (`rev-parse
 * --git-path index`) and refuses to build attributed commits when it is ignored.
 */
export interface GitRunOptions {
  env?: Readonly<Record<string, string>>;
  /** Safe correlation context for the sidecar's bounded slow-exec stage record. */
  diagnosticTags?: SidecarDiagnosticTags;
}

export type RunGit = (
  args: string[],
  cwd: string,
  options?: GitRunOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const gitFailureDetail = (result: Awaited<ReturnType<RunGit>>): string =>
  (result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code} without output`).slice(0, 300);

const envMs = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Subcommands that touch the network (a hung remote must fail fast, not stall the fire). */
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

/** Repos at the same depth have separate git dirs; parents still wait for children. */
const SUBMODULE_SYNC_CONCURRENCY = 4;

/**
 * WI-5111: git-sync commits under the box's GLOBAL git identity, which on every
 * shared dev box is the OWNER's own `user.name`/`user.email` (agents never commit
 * under their own identity — CLAUDE.md "git-sync owns commit + push — you do
 * neither"). The result: `git blame` / `git log --format=%an` on EVERY line of
 * EVERY file returns the owner's name, indistinguishable from the owner having
 * typed the change himself. This is not a harmless dead end (an agent that trusts
 * blame just gets "unknown") — it is a FALSE-POSITIVE generator (an agent gets a
 * confident, wrong, and highly plausible answer). Observed harm: a release-fixer's
 * blame-the-regression triage escalated an AGENT's own incomplete migration to the
 * owner as a blocker, in the second person ("YOUR migration ... YOU updated"),
 * entirely on the strength of `git blame` (escalation mro7nmi5, 2026-07-17).
 *
 * Fix: EVERY git-sync commit is made under this bot identity via `-c user.name=`
 * / `-c user.email=` (per-invocation override — never touches the box's global git
 * config, so an interactive `git commit` elsewhere on the box is unaffected).
 * Blame now visibly shows a bot, an agent cannot form "the owner wrote this", and
 * a REAL owner commit (there are none on this tree going forward, but historical
 * ones stay as-is) is trivially distinguishable from the automation. Prepended
 * BEFORE the subcommand in the argv (gitSubcommand already special-cases `-c`
 * pairs when reading past them for the timeout/network classification above).
 */
export const GIT_SYNC_BOT_NAME = 'papercusp-git-sync';
/**
 * GitHub rejects pushes whose commit author email is not verified on the
 * authenticated account. Keep the bot name for attribution, but use the
 * papercupai no-reply identity already used by the repository's publishing
 * path so automated superproject pushes are accepted.
 */
export const GIT_SYNC_BOT_EMAIL = 'papercupai@users.noreply.github.com';
const GIT_SYNC_IDENTITY_ARGS = ['-c', `user.name=${GIT_SYNC_BOT_NAME}`, '-c', `user.email=${GIT_SYNC_BOT_EMAIL}`];

/** The git SUBCOMMAND in an argv — skipping leading global flags AND the separate
 *  value a `-c`/`-C` option consumes (`['-c','x=y','fetch']` → 'fetch', not 'x=y'). */
const gitSubcommandIndex = (args: string[]): number => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++; // the option's value rides in the NEXT token
      continue;
    }
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
};

const gitSubcommand = (args: string[]): string => {
  const index = gitSubcommandIndex(args);
  return index >= 0 ? args[index] : '';
};

/** These read-only commands must not refresh the shared index while offloaded. */
const GIT_SIDECAR_READ_ONLY_COMMANDS = new Set([
  'rev-parse', 'status', 'cat-file', 'ls-files', 'ls-tree', 'merge-base', 'rev-list',
  'for-each-ref',
]);

/** Network commands whose native progress stream can drive the idle watchdog.
 * Git suppresses progress when stderr is not a TTY unless `--progress` is explicit;
 * git-sync always pipes stderr, so without this flag a healthy multi-GB fetch looks
 * exactly like a wedged child until it finishes. */
const GIT_PROGRESS_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone']);

const withGitProgress = (args: string[]): string[] => {
  const index = gitSubcommandIndex(args);
  if (index < 0 || !GIT_PROGRESS_SUBCOMMANDS.has(args[index])) return args;
  if (args.includes('--progress') || args.includes('--no-progress')) return args;
  return [...args.slice(0, index + 1), '--progress', ...args.slice(index + 1)];
};

/**
 * WI-1416 hang guard: the idle ceiling for one git subprocess. Local commands retain
 * the original wall-clock behavior. Network commands refresh this deadline whenever
 * their forced progress stream advances, so a healthy large transfer may outlive four
 * minutes while a silent/wedged remote still fails fast. The independent hard ceiling
 * below prevents an endlessly-chatty broken child from living forever.
 *
 * Env-tunable: PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS (idle),
 * PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS, PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS.
 */
export const gitTimeoutMsFor = (args: string[]): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? envMs('PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS', 4 * 60_000)
    : envMs('PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS', 6 * 60_000);

export const gitHardTimeoutMsFor = (args: string[], idleTimeoutMs = gitTimeoutMsFor(args)): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? Math.max(idleTimeoutMs, envMs('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', 60 * 60_000))
    : idleTimeoutMs;

/** Spawn `git <args>` in `cwd`, capturing exit code + output, bounded by `timeoutMs`
 *  (never throws, never hangs). Exported so the hang guard is directly testable.
 *  WI-3793: now backed by the shared, defensively-guarded
 *  `isSidecarEnabledFromEnv` (same enable/mode-var pattern every node-child
 *  sidecar shares) instead of a hand-rolled inline check — behavior is
 *  unchanged (this was already the ONE call site with the `_MODE` guard). */
export function gitSyncSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitSidecarEnabled('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', env);
}

export interface GitRunExecutionOptions {
  /** Called whenever the local git child emits output or the command settles. */
  onProgress?: () => void;
  /** Abort a git child when its owning git-sync fire is declared stalled. */
  signal?: AbortSignal;
  /** Extra environment for the git child (WI-10006705: a private GIT_INDEX_FILE). */
  env?: Readonly<Record<string, string>>;
  /** Safe correlation context for the sidecar's bounded slow-exec stage record. */
  diagnosticTags?: SidecarDiagnosticTags;
}

export interface GitProgressTimerHandle {
  cancel(): void;
  unref?(): void;
}

export interface GitProgressTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): GitProgressTimerHandle;
  setImmediate(callback: () => void): GitProgressTimerHandle;
}

const GIT_PROGRESS_TIMER_SCHEDULER: GitProgressTimerScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(timer),
      unref: () => timer.unref?.(),
    };
  },
  setImmediate(callback) {
    const immediate = setImmediate(callback);
    return { cancel: () => clearImmediate(immediate) };
  },
};

/**
 * Timer state machine for progress-aware Git children. Exported so its ordering
 * contract can be tested with a deterministic scheduler instead of depending on
 * host startup and event-loop timing.
 */
export function createGitProgressWatchdog(
  idleTimeoutMs: number,
  hardTimeoutMs: number,
  onTimeout: (reason: string) => void,
  scheduler: GitProgressTimerScheduler = GIT_PROGRESS_TIMER_SCHEDULER,
): { start(): void; onOutput(): void; stop(): void } {
  let idleTimer: GitProgressTimerHandle | null = null;
  let idleCheck: GitProgressTimerHandle | null = null;
  let hardTimer: GitProgressTimerHandle | null = null;
  let started = false;
  let stopped = false;

  const clear = (): void => {
    idleTimer?.cancel();
    hardTimer?.cancel();
    idleCheck?.cancel();
    idleTimer = null;
    hardTimer = null;
    idleCheck = null;
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clear();
  };
  const expire = (reason: string): void => {
    if (stopped) return;
    stop();
    onTimeout(reason);
  };
  const armIdleTimer = (): void => {
    if (!started || stopped) return;
    idleTimer?.cancel();
    idleCheck?.cancel();
    idleCheck = null;
    idleTimer = scheduler.setTimeout(() => {
      idleTimer = null;
      if (stopped) return;
      // Match the sidecar's pipe-progress contract: after a delayed parent
      // loop, POLL must see already-written bytes before this idle verdict.
      idleCheck = scheduler.setImmediate(() => {
        idleCheck = null;
        expire(`made no output progress for ${idleTimeoutMs}ms`);
      });
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      armIdleTimer();
      hardTimer = scheduler.setTimeout(
        () => expire(`exceeded the ${hardTimeoutMs}ms hard ceiling despite output progress`),
        hardTimeoutMs,
      );
      hardTimer.unref?.();
    },
    onOutput: armIdleTimer,
    stop,
  };
}

const runGitLocalBounded = (
  args: string[],
  cwd: string,
  idleTimeoutMs: number,
  hardTimeoutMs: number,
  progressAware: boolean,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
    // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
    // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
    // parsing is then reliable at the root, rather than depending on the operator's locale.
    //
    // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
    // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
    // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
    // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
    // this marker the hook would run the affected suite on the scheduled push and wedge
    // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
    // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
    const child = spawn('git', args, {
      cwd,
      // Referenced and awaited: this creates a group for cancellation, not an
      // independent job. Helpers must exit before the owning leases release.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...options.env,
        LC_ALL: 'C',
        LANG: 'C',
        PAPERCUSP_GIT_SYNC_PUSH: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...(GIT_SIDECAR_READ_ONLY_COMMANDS.has(gitSubcommand(args))
          ? { GIT_OPTIONAL_LOCKS: '0' }
          : {}),
      },
    });
    const out = collectChildOutput(child);
    const groupLifetime = processGroupLifetime(child, (message) => out.stderr.append(`\ngit ${message}`));
    let settled = false;
    let terminating = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let progressWatchdog: ReturnType<typeof createGitProgressWatchdog> | null = null;
    let removeAbortListener = (): void => {};
    const reportProgress = (): void => {
      try {
        options.onProgress?.();
      } catch {
        // Progress accounting is diagnostic-only and must never break git.
      }
    };
    const clearTimers = (): void => {
      progressWatchdog?.stop();
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (killTimer) clearTimeout(killTimer);
      removeAbortListener();
      reportProgress();
      resolve({ code: terminating ? -1 : code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const terminate = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      clearTimers();
      out.stderr.append(
        `${out.stderr.peek() ? '\n' : ''}git ${args.join(' ')} ${reason} — killed by the git-sync hang guard`,
      );
      // SIGTERM permits Git lock-file cleanup. Escalate against the same group,
      // but never equate sending a signal or exhausting a grace with actual exit.
      groupLifetime.signal('SIGTERM');
      killTimer = setTimeout(() => groupLifetime.signal('SIGKILL'), 10_000);
      killTimer.unref?.();
    };
    const armIdleTimer = (): void => {
      progressWatchdog?.onOutput();
    };

    if (progressAware) {
      progressWatchdog = createGitProgressWatchdog(idleTimeoutMs, hardTimeoutMs, terminate);
      // `collectChildOutput` owns decoding; these listeners only observe byte
      // arrival and therefore cannot split/corrupt a multi-byte character.
      const onOutput = (): void => {
        reportProgress();
        armIdleTimer();
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      progressWatchdog.start();
    } else {
      hardTimer = setTimeout(() => terminate(`timed out after ${hardTimeoutMs}ms`), hardTimeoutMs);
      hardTimer.unref?.();
    }
    if (options.signal) {
      const onAbort = (): void => terminate('aborted by the git-sync stall guard');
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => {
      out.stderr.append(String(e));
      // A failed spawn has no child to drain. Other errors are not exit proof.
      if (child.pid === undefined) finish(-1);
    });
    child.on('close', async (code, signal) => {
      if (signal) out.stderr.append(`${out.stderr.peek() ? '\n' : ''}git terminated by signal ${signal}`);
      await groupLifetime.waitForExit();
      finish(code ?? -1);
    });
  });

export const runGitBounded = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  withGitFetchHeadroom(args,
    (guardedArgs, signal) => runGitBoundedUnchecked(guardedArgs, cwd, timeoutMs, { ...options, signal }),
    options.signal);

const runGitBoundedUnchecked = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: GitRunExecutionOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  if (options.signal?.aborted) return { code: -1, stdout: '', stderr: 'git aborted before spawn' };
  // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
  // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
  // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
  // parsing is then reliable at the root, rather than depending on the operator's locale.
  //
  // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
  // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
  // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
  // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
  // this marker the hook would run the affected suite on the scheduled push and wedge
  // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
  // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
  const network = GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args));
  const effectiveArgs = network ? withGitProgress(args) : args;
  // The fetch headroom guard also runs rev-parse through this seam. Keep the
  // phase identity, but label the actual child rather than its parent fetch.
  const diagnosticSubcommand = gitSubcommandOf(effectiveArgs);
  const diagnosticTags = options.diagnosticTags ? {
    ...options.diagnosticTags,
    gitSubcommand: diagnosticSubcommand && /^[a-z][a-z0-9-]{0,63}$/.test(diagnosticSubcommand)
      ? diagnosticSubcommand
      : undefined,
  } : undefined;
  const hardTimeoutMs = gitHardTimeoutMsFor(args, timeoutMs);
  // git-sync is unattended. A credential helper may answer, but an interactive
  // prompt can never make progress and would otherwise survive until the network
  // hang guard fires.
  const env = {
    ...process.env,
    ...options.env,
    LC_ALL: 'C',
    LANG: 'C',
    PAPERCUSP_GIT_SYNC_PUSH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  // Cancellable calls bind dispatch to a verified server/connection and retain
  // this promise through transport recovery until child exit is proven. Only a
  // failure BEFORE dispatch rejects into local fallback; a lost execution result
  // resolves as unknown and must never replay a mutation.
  const readOnly = GIT_SIDECAR_READ_ONLY_COMMANDS.has(gitSubcommand(args));
  if (gitSyncSidecarEnabled()) {
    try {
      options.onProgress?.();
      const result = await runGitViaSpawnerSidecar(effectiveArgs, cwd, hardTimeoutMs,
        readOnly ? { ...env, GIT_OPTIONAL_LOCKS: '0' } : env, {
        idleTimeoutMs: network ? timeoutMs : undefined,
        signal: options.signal,
        onProgress: options.onProgress,
        diagnosticTags,
      });
      options.onProgress?.();
      return result;
    } catch (e) {
      // Was a console.warn PER CALL — the opposite failure from warn-once, and
      // just as unhelpful: a sustained outage buries the log without ever
      // stating a rate. The shared seam bounds the cadence and carries the
      // cumulative count.
      noteSidecarFallback('git-sync', e);
      if (options.signal?.aborted) {
        return { code: -1, stdout: '', stderr: 'git aborted after sidecar transport loss' };
      }
      // WI-10006716: the default runner passes no signal, so a transport loss
      // AFTER dispatch arrives here as a throw. The sidecar child may have run
      // (or still be running) — replaying a mutation locally could apply it
      // twice or race its twin on index.lock. Surface an unknown outcome and
      // let the caller re-read state; only reads may replay.
      if (isSidecarPostDispatchFault(e) && !gitReplayIsSafe(effectiveArgs)) {
        return sidecarPostDispatchUnknownResult(effectiveArgs, e);
      }
    }
  }
  return runGitLocalBounded(effectiveArgs, cwd, timeoutMs, hardTimeoutMs, network, options);
};

/** Spawn `git <args>` in `cwd` with the default per-subcommand ceiling (never throws). */
const defaultRunGit: RunGit = (args, cwd, options) =>
  runGitBounded(args, cwd, gitTimeoutMsFor(args), {
    env: options?.env,
    diagnosticTags: options?.diagnosticTags,
  });

/** No Git child ran on a sidecar admission refusal; do not diagnose a Git merge conflict. */
export function gitSyncPreDispatchError(result: Awaited<ReturnType<RunGit>>): string | null {
  return isSidecarInfrastructureFault(result)
    ? `git-sync sidecar infrastructure refusal before Git dispatch: ${result.stderr.slice(0, 300)}`
    : null;
}

const TOOL_CATALOG_GENERATOR_PATH = 'scripts/gen-tool-catalog.ts';
const TOOL_CATALOG_ARTIFACT_PATH = '.papercusp/tool-catalog.json';
const TOOL_CATALOG_TRACKED_PATHS = [TOOL_CATALOG_GENERATOR_PATH, TOOL_CATALOG_ARTIFACT_PATH] as const;

/** The exact source surface guarded by affected-tests.mjs's gen:tool-catalog:check entry. */
export function affectsToolCatalog(path: string): boolean {
  return (
    (path.startsWith('packages/operator-core/lib/agent-tools/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('packages/agent-mcp/src/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('libs/generic/tooldef/src/') && !path.endsWith('.test.ts')) ||
    path === TOOL_CATALOG_GENERATOR_PATH ||
    path === TOOL_CATALOG_ARTIFACT_PATH
  );
}

export interface ToolCatalogGeneratorResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunToolCatalogGenerator = (repoPath: string, dependencies?: GitSyncTsxDependencies) => Promise<ToolCatalogGeneratorResult>;

export interface ToolCatalogRegeneratorContext {
  runGit: RunGit;
  repoPath: string;
  log: (message: string) => void;
}

export type ToolCatalogRegenerator = (context: ToolCatalogRegeneratorContext) => Promise<void>;

export type GitSyncInstallBoundaryAcquirer = (repoPath: string) => Promise<InstallBoundaryLease>;
export interface GitSyncTsxDependencies {
  acquire?: GitSyncInstallBoundaryAcquirer;
  spawnChild?: typeof spawn;
}
export type GitSyncInstallBoundaryResult<T> =
  | { status: 'launched'; value: T }
  | { status: 'refused'; lease: InstallBoundaryLease };

/**
 * Keep git-sync children that import from node_modules inside the same
 * repo-keyed read boundary used by install:safe. If the lease cannot be
 * acquired, refuse launch instead of racing npm's dependency rewrite.
 */
export async function runGitSyncUnderInstallBoundary<T>(
  repoPath: string,
  launch: () => Promise<T>,
  acquire: GitSyncInstallBoundaryAcquirer = acquireInstallBoundaryLease,
): Promise<GitSyncInstallBoundaryResult<T>> {
  const lease = await acquire(repoPath);
  if (lease.outcome !== 'acquired' && lease.outcome !== 'nested') {
    return { status: 'refused', lease };
  }
  try {
    return { status: 'launched', value: await launch() };
  } finally {
    lease.release();
  }
}

interface GitSyncGeneratorChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

function gitSyncInstallBoundaryRefusal(
  lease: InstallBoundaryLease,
  generator: string,
): GitSyncGeneratorChildResult {
  const detail = lease.detail ? ': ' + lease.detail : '';
  return {
    code: -1,
    stdout: '',
    stderr: 'git-sync ' + generator + ' refused to start because install:safe boundary was ' + lease.outcome + detail,
  };
}

/**
 * Run the catalog writer in a bounded child. The generator cold-imports the full
 * registry, so a peer's half-written tool module can make that import hang or
 * fail; neither condition may wedge the fleet-wide git-sync commit path.
 */
export const defaultRunToolCatalogGenerator: RunToolCatalogGenerator = (repoPath, dependencies) =>
  runGitSyncUnderInstallBoundary(repoPath, () =>
    new Promise<ToolCatalogGeneratorResult>((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_TOOL_CATALOG_TIMEOUT_MS', 60_000);
    const child = (dependencies?.spawnChild ?? spawn)(join(repoPath, 'node_modules', '.bin', 'tsx'), [TOOL_CATALOG_GENERATOR_PATH], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}tool-catalog regeneration timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A broken child implementation must not defeat the timeout by never
      // emitting close after the kill.
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
    }),
    dependencies?.acquire).then((result) => result.status === 'launched'
    ? result.value
    : gitSyncInstallBoundaryRefusal(result.lease, 'tool-catalog regeneration'));

/**
 * Regenerate the tracked tool catalog immediately before the superproject
 * commit when a dirty source path can affect it. This is intentionally
 * FAIL-SOFT: status/tracking checks, generator throws, nonzero exits, and
 * timeouts are logged and return normally so a transient registry refactor can
 * never stop git-sync from committing the rest of the shared tree.
 */
export async function regenerateToolCatalogBeforeCommit(
  context: ToolCatalogRegeneratorContext,
  runGenerator: RunToolCatalogGenerator = defaultRunToolCatalogGenerator,
): Promise<void> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
    if (status.code !== 0) {
      log(`[git-sync] ${repoPath}: could not inspect dirty paths for tool-catalog regeneration — skipping fail-soft`);
      return;
    }
    const affected = parseDirtyPaths(status.stdout).filter(affectsToolCatalog);
    if (affected.length === 0) return;

    // Do not run this papercusp-specific generator in arbitrary repositories
    // that merely happen to contain a similarly named dirty path.
    const tracked = await runGit(['ls-files', '--', ...TOOL_CATALOG_TRACKED_PATHS], repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !TOOL_CATALOG_TRACKED_PATHS.every((path) => trackedPaths.has(path))) return;

    const artifactPath = join(repoPath, TOOL_CATALOG_ARTIFACT_PATH);
    let original: string | null = null;
    try {
      original = await readFile(artifactPath, 'utf8');
    } catch {
      /* missing artifact is restored to missing if the writer fails */
    }

    let result: ToolCatalogGeneratorResult;
    try {
      result = await runGenerator(repoPath);
    } catch (e) {
      result = { code: -1, stdout: '', stderr: String(e) };
    }
    if (result.code !== 0) {
      // A synchronous write can truncate before throwing. Restore the pre-run
      // artifact so a failed repair never turns a merely stale catalog into a
      // corrupt one that the catch-all commit could publish.
      try {
        if (original == null) await unlink(artifactPath).catch(() => {});
        else await writeFile(artifactPath, original, 'utf8');
      } catch (e) {
        log(`[git-sync] ${repoPath}: failed to restore tool catalog after generator failure: ${String(e)}`);
      }
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: tool-catalog regeneration failed (${detail}) — continuing with the commit fail-soft; the downstream catalog check remains the detector`,
      );
      return;
    }
    log(
      `[git-sync] ${repoPath}: regenerated ${TOOL_CATALOG_ARTIFACT_PATH} before commit (${affected.length} catalog-affecting dirty path(s))`,
    );
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
    );
  }
}

const DECLARATIONS_GENERATOR_PATH = 'scripts/gen-declarations.ts';
const DECLARATIONS_CONFIG_PATH = 'tsconfig.declarations.json';
const DECLARATIONS_PACKAGE_INPUTS = ['package.json', 'package-lock.json'] as const;
const DECLARATIONS_TRACKED_PATHS = [DECLARATIONS_GENERATOR_PATH, DECLARATIONS_CONFIG_PATH] as const;

interface DeclarationPair {
  source: string;
  artifact: string;
}

/** Map either half of an `.mjs` → generated `.d.mts` pair to both paths. */
export function generatedDeclarationPair(path: string): DeclarationPair | null {
  if (path.endsWith('.mjs')) return { source: path, artifact: path.replace(/\.mjs$/, '.d.mts') };
  if (path.endsWith('.d.mts')) return { source: path.replace(/\.d\.mts$/, '.mjs'), artifact: path };
  return null;
}

/** Expand a live-held generated declaration half to its enrolled source/artifact pair. */
export function expandGeneratedDeclarationPairHolds(
  heldPaths: readonly string[],
  generatedDeclarationPaths: readonly string[],
): { paths: string[]; pairs: Array<{ source: string; artifact: string; heldPath: string }> } {
  const generated = new Set(generatedDeclarationPaths.map((path) => path.trim()).filter(Boolean));
  const held = heldPaths.map((path) => path.trim()).filter(Boolean);
  const paths = new Set<string>();
  const pairs = new Map<string, { source: string; artifact: string; heldPath: string }>();
  for (const candidate of generated) {
    if (!candidate.endsWith('.mjs')) continue;
    const pair = generatedDeclarationPair(candidate);
    if (!pair || !generated.has(pair.source) || !generated.has(pair.artifact)) continue;
    const heldPath = [pair.source, pair.artifact].find((member) =>
      held.some((path) => gitSyncPathsOverlap(member, path)),
    );
    if (!heldPath) continue;
    paths.add(pair.source);
    paths.add(pair.artifact);
    pairs.set(pair.source, { ...pair, heldPath });
  }
  return {
    paths: [...paths].sort(),
    pairs: [...pairs.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
}

/** Inputs whose dirty working-tree bytes may change the tracked declaration projection. */
export function affectsGeneratedDeclarations(path: string): boolean {
  return (
    path === DECLARATIONS_GENERATOR_PATH ||
    path === DECLARATIONS_CONFIG_PATH ||
    DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number]) ||
    generatedDeclarationPair(path) !== null
  );
}

/**
 * WI-6554700010011061 — the declarations program compiles every source file its
 * enrolled `.mjs` inputs reach (~270 files), so a dirty TS file in that graph can fail
 * the emit or change a generated `.d.mts` without touching any path
 * `affectsGeneratedDeclarations` names. The edit hook covers Edit/Write edits; this
 * covers the rest (Bash writes, hook-less clients) at commit time.
 *
 * The graph rule and its shared 15-minute cache are owned by the edit hook, which this
 * process asks out of band. That keeps one implementation and one cache, and keeps
 * the synchronous 3-5s tsc listing off the bg-host event loop. The hook stays a
 * self-contained file because it is installed by byte copy into
 * ~/.papercusp/hooks/cc, so it cannot import a shared module.
 */
export const DECLARATIONS_GRAPH_HELPER_PATH = 'apps/operator/scripts/hooks/cc/regenerate-declaration-before-lock-release.mjs';
const DECLARATIONS_GRAPH_CANDIDATE = /\.(?:[cm]?[jt]sx?)$/;

/** A dirty path that COULD be a declarations program-graph source; only the graph lookup decides. */
export function isDeclarationsGraphCandidate(path: string): boolean {
  return DECLARATIONS_GRAPH_CANDIDATE.test(path) && !path.startsWith('../') && !path.split('/').includes('node_modules');
}

/**
 * The subset of `candidates` that are program-graph sources. Resolves `null` when this
 * repository has no graph helper, which means the lookup does not apply here; it is
 * not an empty answer. Rejects when the lookup itself failed.
 */
export type ListDeclarationsGraphMembers = (repoPath: string, candidates: readonly string[]) => Promise<string[] | null>;

export const defaultListDeclarationsGraphMembers: ListDeclarationsGraphMembers = async (repoPath, candidates) => {
  const helper = join(repoPath, DECLARATIONS_GRAPH_HELPER_PATH);
  try {
    await lstat(helper);
  } catch {
    return null;
  }
  const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_DECLARATIONS_GRAPH_TIMEOUT_MS', 90_000);
  const result = await new Promise<GeneratedDeclarationsGeneratorResult>((resolve) => {
    const child = spawn(
      process.execPath,
      [helper, '--declarations-graph-members', '--repo-root', repoPath, ...candidates.flatMap((path) => ['--path', path])],
      { cwd: repoPath, env: process.env },
    );
    const out = collectChildOutput(child);
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}declarations graph lookup timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(-1);
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300));
  }
  const parsed: unknown = JSON.parse(result.stdout.trim() || 'null');
  if (!Array.isArray(parsed) || !parsed.every((path): path is string => typeof path === 'string')) {
    throw new Error(`declarations graph lookup printed a non-array: ${result.stdout.trim().slice(0, 200)}`);
  }
  return parsed;
};

export interface GeneratedDeclarationsGeneratorResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunGeneratedDeclarationsGenerator = (repoPath: string, dependencies?: GitSyncTsxDependencies) => Promise<GeneratedDeclarationsGeneratorResult>;

export type GeneratedDeclarationsRepairResult =
  | { status: 'not-needed'; atomicPaths: string[] }
  | { status: 'regenerated'; atomicPaths: string[] }
  /**
   * Only declaration-related paths are deferred; the rest of the tree commits.
   * Either the status census was unavailable, or the generator failed
   * (WI-6554700010010659) — then `compilerErrors` lists the dirty files its
   * diagnostics named, which are deferred with the declaration surface and
   * reported as content offenders.
   */
  | { status: 'deferred'; atomicPaths: string[]; detail: string; compilerErrors?: DeclarationCompileError[] }
  | { status: 'blocked'; atomicPaths: string[]; detail: string };

export type GeneratedDeclarationsRegenerator = (
  context: ToolCatalogRegeneratorContext,
) => Promise<GeneratedDeclarationsRepairResult>;

/**
 * Run declaration emit in a bounded child. Unlike the tool-catalog repair, a
 * failure defers the declaration surface: committing the source without its
 * generated declaration is the exact torn-snapshot class this seam closes.
 */
export const defaultRunGeneratedDeclarationsGenerator: RunGeneratedDeclarationsGenerator = (repoPath, dependencies) =>
  runGitSyncUnderInstallBoundary(repoPath, () =>
    new Promise<GeneratedDeclarationsGeneratorResult>((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_DECLARATIONS_TIMEOUT_MS', 120_000);
    const child = (dependencies?.spawnChild ?? spawn)(join(repoPath, 'node_modules', '.bin', 'tsx'), [DECLARATIONS_GENERATOR_PATH], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}declaration regeneration timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
    }),
    dependencies?.acquire).then((result) => result.status === 'launched'
    ? result.value
    : gitSyncInstallBoundaryRefusal(result.lease, 'declaration regeneration'));

/** A status read is a cheap census, but it can still lose a race with the
 * sidecar/admission layer. Retry that read briefly before deciding whether the
 * declaration repair is blocked; a one-off infrastructure miss must not turn
 * into a whole-tree commit wedge. */
export const DECLARATION_STATUS_MAX_RETRIES = 3;
export const DECLARATION_STATUS_RETRY_BASE_DELAY_MS = 100;

type DeclarationStatusRead = { paths: string[] } | { detail: string };

async function readDeclarationStatus(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
  phase: 'before' | 'after',
): Promise<DeclarationStatusRead> {
  let detail = 'unknown git status failure';
  for (let attempt = 0; attempt <= DECLARATION_STATUS_MAX_RETRIES; attempt++) {
    try {
      const result = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
      if (result.code === 0) return { paths: parseDirtyPaths(result.stdout) };
      detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
    } catch (error) {
      detail = String(error).slice(0, 300);
    }
    if (attempt === DECLARATION_STATUS_MAX_RETRIES) break;
    const retry = attempt + 1;
    const delayMs = DECLARATION_STATUS_RETRY_BASE_DELAY_MS * 2 ** attempt;
    log(
      `[git-sync] ${repoPath}: declaration ${phase}-status read failed (${detail}) — ` +
        `retrying after ${delayMs}ms (attempt ${retry}/${DECLARATION_STATUS_MAX_RETRIES})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { detail: `could not inspect dirty paths ${phase} declaration regeneration: ${detail}` };
}

const declarationTrackedInventoryArgs = [
  'ls-files',
  '--',
  ...DECLARATIONS_TRACKED_PATHS,
  ...DECLARATIONS_PACKAGE_INPUTS,
  '*.mjs',
  '*.d.mts',
];

/** One file the declarations compiler rejected, with its diagnostic line(s). */
export interface DeclarationCompileError {
  /** Repo-relative path. */
  path: string;
  /** tsc's own diagnostic line(s) for this file, capped. */
  diagnostic: string;
}

/** Detector key git-sync reports a compiler-named file under (WI-6554700010010659). */
export const DECLARATION_COMPILE_DETECTOR_KEY = 'declarations-tsc';

/**
 * Files named by tsc diagnostics in `output` — `path(line,col): error TSnnnn: …` (tsc's
 * non-pretty format, which it uses when stdout is not a TTY, as in
 * `scripts/gen-declarations.ts`). An absolute path inside `repoPath` is made relative; one
 * outside it is dropped. Sorted by path. WI-6554700010010659.
 */
export function declarationCompileErrors(output: string, repoPath: string): DeclarationCompileError[] {
  const root = repoPath.endsWith('/') ? repoPath : `${repoPath}/`;
  const byPath = new Map<string, string[]>();
  for (const match of output.matchAll(/^\s*(.+?)(\(\d+,\d+\): error TS\d+:.*)$/gm)) {
    let path = match[1].trim();
    if (path.startsWith('/')) {
      if (!path.startsWith(root)) continue;
      path = path.slice(root.length);
    }
    if (path.startsWith('./')) path = path.slice(2);
    if (!path || path.startsWith('../')) continue;
    const lines = byPath.get(path) ?? [];
    lines.push(`${path}${match[2]}`.trim());
    byPath.set(path, lines);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, lines]) => ({ path, diagnostic: lines.slice(0, 3).join('\n').slice(0, 600) }));
}

/**
 * Report each compiler-named file as a content offender, so it is quarantined, escalated
 * and handed to the content-fixer like any other broken file instead of sitting
 * uncommitted with only a log line (WI-6554700010010659).
 */
export function declarationCompileOffenders(errors: readonly DeclarationCompileError[]): ContentOffender[] {
  return errors.map((error) => ({
    file: error.path,
    detectorKey: DECLARATION_COMPILE_DETECTOR_KEY,
    error:
      'the declarations program (tsconfig.declarations.json, run by scripts/gen-declarations.ts) rejects this ' +
      'file, so git-sync holds it and the generated declarations; fix the error and the next pass commits ' +
      `them:\n${error.diagnostic}`,
    fixerRole: 'content-fixer',
  }));
}

function declarationAtomicPathsFromTrackedPaths(trackedPaths: ReadonlySet<string>): string[] {
  const atomicPaths = new Set<string>();
  for (const path of [...DECLARATIONS_TRACKED_PATHS, ...DECLARATIONS_PACKAGE_INPUTS]) {
    if (trackedPaths.has(path)) atomicPaths.add(path);
  }
  for (const path of trackedPaths) {
    const pair = generatedDeclarationPair(path);
    if (pair && trackedPaths.has(pair.source) && trackedPaths.has(pair.artifact)) {
      atomicPaths.add(pair.source);
      atomicPaths.add(pair.artifact);
    }
  }
  return [...atomicPaths].sort();
}

/**
 * Regenerate tracked declaration pairs before git-sync snapshots the tree.
 *
 * The tracked-pair check keeps this Papercusp-specific writer out of arbitrary
 * repositories and avoids treating hand-written `.d.mts` siblings as generated.
 * `atomicPaths` is consumed by the attribution layer: every affected source and
 * artifact is withheld from per-agent commits and lands together in the single
 * catch-all commit. A failed emit is fail-CLOSED for the declaration surface
 * (every enrolled pair plus the generator inputs) and for the dirty files the
 * compiler names; publishing a stale pair and relying on the gate to red later is
 * not recovery. The rest of the tree still commits (WI-6554700010010659).
 *
 * A dirty source file in the declarations program graph also triggers the emit
 * (WI-6554700010011061), even when no enrolled pair or generator input is dirty. A
 * failing emit then holds that file back through the compiler-named deferral above,
 * instead of committing it and leaving the gate to red `main`. Such a source is
 * deliberately NOT added to `atomicPaths`: forcing it into the catch-all would strip
 * its attribution on every pass, and its projection change (if any) already lands in
 * the same sweep.
 */
export async function regenerateGeneratedDeclarationsBeforeCommit(
  context: ToolCatalogRegeneratorContext,
  runGenerator: RunGeneratedDeclarationsGenerator = defaultRunGeneratedDeclarationsGenerator,
  listGraphMembers: ListDeclarationsGraphMembers = defaultListDeclarationsGraphMembers,
): Promise<GeneratedDeclarationsRepairResult> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await readDeclarationStatus(runGit, repoPath, log, 'before');
    if ('detail' in status) {
      // We cannot safely infer which pair is dirty, but we can still inventory
      // the enrolled declaration surface. Defer those paths only and let the
      // rest of the tree commit; if even the inventory is unavailable, retain
      // the old fail-closed behavior because there is no safe exclusion set.
      let tracked: GeneratedDeclarationsGeneratorResult;
      try {
        tracked = await runGit(declarationTrackedInventoryArgs, repoPath);
      } catch (error) {
        return { status: 'blocked', atomicPaths: [], detail: `${status.detail}; ${String(error).slice(0, 300)}` };
      }
      if (tracked.code !== 0) {
        const inventoryDetail = (tracked.stderr || tracked.stdout || `exit ${tracked.code}`).trim().slice(0, 300);
        return {
          status: 'blocked',
          atomicPaths: [],
          detail: `${status.detail}; declaration inventory failed: ${inventoryDetail}`,
        };
      }
      const trackedPaths = new Set(
        tracked.stdout
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      );
      if (!DECLARATIONS_TRACKED_PATHS.every((path) => trackedPaths.has(path))) {
        return { status: 'not-needed', atomicPaths: [] };
      }
      const atomicPaths = declarationAtomicPathsFromTrackedPaths(trackedPaths);
      log(
        `[git-sync] ${repoPath}: declaration ${status.detail} — deferring ${atomicPaths.length} ` +
          'declaration-related path(s) while continuing with the unlocked tree',
      );
      return { status: 'deferred', atomicPaths, detail: status.detail };
    }
    const dirtyBefore = status.paths;
    const directInput = dirtyBefore.some(affectsGeneratedDeclarations);
    const graphCandidates = dirtyBefore.filter(isDeclarationsGraphCandidate);
    if (!directInput && graphCandidates.length === 0) return { status: 'not-needed', atomicPaths: [] };
    // At most one program-graph lookup per pass, and only when a decision needs it.
    // A failed lookup is fail-SOFT: it only means this pass behaves as it did before
    // the graph trigger existed, and the gate's gen:declarations:check still detects.
    let graphLookup: Promise<string[]> | undefined;
    const graphMembers = (): Promise<string[]> => {
      graphLookup ??= (async () => {
        if (graphCandidates.length === 0) return [];
        try {
          return (await listGraphMembers(repoPath, graphCandidates)) ?? [];
        } catch (error) {
          log(
            `[git-sync] ${repoPath}: declarations program-graph lookup failed (${String(error).slice(0, 300)}) — ` +
              'dirty sources outside the enrolled declaration inputs are not compiled this pass',
          );
          return [];
        }
      })();
      return graphLookup;
    };
    // Settle the graph BEFORE the inventory when it is the only possible trigger, so a
    // repository without the graph helper never pays for the inventory read.
    if (!directInput && (await graphMembers()).length === 0) return { status: 'not-needed', atomicPaths: [] };

    // One bounded inventory read gives us both canonical-surface proof and the
    // enrolled source/artifact pairs. Git's `*.mjs` pathspec recurses here.
    const tracked = await runGit(declarationTrackedInventoryArgs, repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !DECLARATIONS_TRACKED_PATHS.every((path) => trackedPaths.has(path))) {
      return { status: 'not-needed', atomicPaths: [] };
    }

    const isTrackedPair = (pair: DeclarationPair): boolean =>
      trackedPaths.has(pair.source) && trackedPaths.has(pair.artifact);
    const hasMetaInput = dirtyBefore.some(
      (path) =>
        path === DECLARATIONS_GENERATOR_PATH ||
        path === DECLARATIONS_CONFIG_PATH ||
        DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number]),
    );
    const affectedPairs = dirtyBefore
      .map(generatedDeclarationPair)
      .filter((pair): pair is DeclarationPair => pair !== null && isTrackedPair(pair));
    let graphInputCount = 0;
    if (!hasMetaInput && affectedPairs.length === 0) {
      // Enrolled pairs are already handled above; a graph source is anything else.
      const graphInputs = (await graphMembers()).filter((path) => {
        const pair = generatedDeclarationPair(path);
        return !(pair && isTrackedPair(pair));
      });
      if (graphInputs.length === 0) return { status: 'not-needed', atomicPaths: [] };
      graphInputCount = graphInputs.length;
    }

    let result: GeneratedDeclarationsGeneratorResult;
    try {
      result = await runGenerator(repoPath);
    } catch (error) {
      result = { code: -1, stdout: '', stderr: String(error) };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      // WI-6554700010010659: this used to return `blocked`, which deferred the WHOLE
      // superproject commit. The declarations program compiles every TS file its
      // `.mjs` inputs reach, so one peer's TS error anywhere in that graph froze
      // every agent's commits (measured 2026-10-13 15:50-17:14Z: a TS5097 in a dirty
      // verifier-source.ts). Torn pairs are prevented just as well by deferring the
      // declaration surface — every enrolled source/artifact pair and the generator
      // inputs — together with the dirty files the compiler names. The rest of the
      // tree commits, and the failing file stays uncommitted, beside its diagnostic.
      const surface = declarationAtomicPathsFromTrackedPaths(trackedPaths);
      const dirty = new Set(dirtyBefore);
      const compilerErrors = declarationCompileErrors(`${result.stderr}\n${result.stdout}`, repoPath).filter(
        (error) => dirty.has(error.path) && !surface.includes(error.path),
      );
      const compilerNamed = compilerErrors.map((error) => error.path);
      const atomicPaths = [...new Set([...surface, ...compilerNamed])].sort();
      log(
        `[git-sync] ${repoPath}: declaration regeneration failed (${detail}) — deferring ${atomicPaths.length} ` +
          `declaration-related path(s)` +
          (compilerNamed.length > 0
            ? `, including ${compilerNamed.length} dirty file(s) its diagnostics name (${compilerNamed.join(', ')}),`
            : '') +
          ' while committing the unlocked remainder',
      );
      return { status: 'deferred', atomicPaths, detail, compilerErrors };
    }

    // The writer may dirty several outputs after a config/compiler-input change.
    // Re-read status and expand every enrolled dirty half back to its complete pair.
    const after = await readDeclarationStatus(runGit, repoPath, log, 'after');
    if ('detail' in after) {
      const atomicPaths = declarationAtomicPathsFromTrackedPaths(trackedPaths);
      log(
        `[git-sync] ${repoPath}: ${after.detail} — deferring ${atomicPaths.length} ` +
          'declaration-related path(s) while continuing with the unlocked tree',
      );
      return { status: 'deferred', atomicPaths, detail: after.detail };
    }
    const dirtyAfter = after.paths;
    const atomicPaths = new Set<string>();
    for (const path of dirtyAfter) {
      const pair = generatedDeclarationPair(path);
      if (pair && isTrackedPair(pair)) {
        atomicPaths.add(pair.source);
        atomicPaths.add(pair.artifact);
      } else if (
        path === DECLARATIONS_GENERATOR_PATH ||
        path === DECLARATIONS_CONFIG_PATH ||
        DECLARATIONS_PACKAGE_INPUTS.includes(path as (typeof DECLARATIONS_PACKAGE_INPUTS)[number])
      ) {
        atomicPaths.add(path);
      }
    }
    log(
      `[git-sync] ${repoPath}: regenerated tracked declarations before commit (${affectedPairs.length} dirty pair(s), ` +
        `${graphInputCount} dirty program-graph source(s), ${atomicPaths.size} atomic path(s))`,
    );
    return { status: 'regenerated', atomicPaths: [...atomicPaths] };
  } catch (error) {
    const detail = String(error).slice(0, 300);
    log(
      `[git-sync] ${repoPath}: declaration pre-commit repair threw (${detail}) — deferring the superproject commit fail-closed`,
    );
    return { status: 'blocked', atomicPaths: [], detail };
  }
}

const TOOL_ROUTING_GENERATOR_PATH = 'scripts/gen-tool-routing.ts';
const TOOL_ROUTING_TABLE_PATH = 'packages/operator-core/lib/bash-substitution/routing-table.ts';
const TOOL_ROUTING_PAIRS_PREFIX = 'packages/operator-core/lib/bash-substitution/pairs/';
const TOOL_ROUTING_TRACKED_PATHS = [TOOL_ROUTING_GENERATOR_PATH, TOOL_ROUTING_TABLE_PATH] as const;

/** The exact source surface that can change the generated tool-routing projection. */
export function affectsToolRouting(path: string): boolean {
  return (
    (path.startsWith(TOOL_ROUTING_PAIRS_PREFIX) && path.endsWith('.ts') && !path.endsWith('.test.ts')) ||
    path === TOOL_ROUTING_TABLE_PATH ||
    path === TOOL_ROUTING_GENERATOR_PATH
  );
}

export interface ToolRoutingCheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunToolRoutingCheck = (repoPath: string, dependencies?: GitSyncTsxDependencies) => Promise<ToolRoutingCheckResult>;

export interface ToolRoutingCheckerContext {
  runGit: RunGit;
  repoPath: string;
  log: (message: string) => void;
}

export type ToolRoutingChecker = (context: ToolRoutingCheckerContext) => Promise<void>;

/**
 * Run the generated routing check in a bounded child. The generator reads the
 * canonical doc-part store, so a broken DB/client or a half-written peer module
 * must be observable without allowing it to wedge the fleet-wide git-sync pass.
 */
export const defaultRunToolRoutingCheck: RunToolRoutingCheck = (repoPath, dependencies) =>
  runGitSyncUnderInstallBoundary(repoPath, () =>
    new Promise<ToolRoutingCheckResult>((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_TOOL_ROUTING_TIMEOUT_MS', 60_000);
    const child = (dependencies?.spawnChild ?? spawn)(join(repoPath, 'node_modules', '.bin', 'tsx'), [TOOL_ROUTING_GENERATOR_PATH, '--check'], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}tool-routing check timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A broken child implementation must not defeat the timeout by never
      // emitting close after the kill.
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
    }),
    dependencies?.acquire).then((result) => result.status === 'launched'
    ? result.value
    : gitSyncInstallBoundaryRefusal(result.lease, 'tool-routing check'));

/**
 * Run the generated tool-routing drift check immediately before the
 * superproject commit when a routing source is dirty. This is intentionally
 * FAIL-SOFT: status/tracking checks, checker errors, nonzero exits, and timeouts
 * are logged and return normally so a stale generated projection cannot wedge
 * git-sync's commit of the rest of the shared tree.
 */
export async function checkToolRoutingBeforeCommit(
  context: ToolRoutingCheckerContext,
  runCheck: RunToolRoutingCheck = defaultRunToolRoutingCheck,
): Promise<void> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
    if (status.code !== 0) {
      log(`[git-sync] ${repoPath}: could not inspect dirty paths for tool-routing check — skipping fail-soft`);
      return;
    }
    const affected = parseDirtyPaths(status.stdout).filter(affectsToolRouting);
    if (affected.length === 0) return;

    // Do not run this Papercusp-specific check in arbitrary repositories that
    // merely happen to contain one routing-shaped dirty path.
    const tracked = await runGit(['ls-files', '--', ...TOOL_ROUTING_TRACKED_PATHS], repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !TOOL_ROUTING_TRACKED_PATHS.every((path) => trackedPaths.has(path))) return;

    let result: ToolRoutingCheckResult;
    try {
      result = await runCheck(repoPath);
    } catch (e) {
      result = { code: -1, stdout: '', stderr: String(e) };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: generated tool-routing check failed (${detail}) — continuing with the commit fail-soft; run \`npm run gen:tool-routing\` to repair`,
      );
      return;
    }
    log(
      `[git-sync] ${repoPath}: generated tool-routing check passed before commit (${affected.length} routing-affecting dirty path(s))`,
    );
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: tool-routing pre-commit check threw (${String(e)}) — continuing with the commit fail-soft`,
    );
  }
}

const GITHUB_HTTPS_INSTEAD_OF_ARGS = ['-c', 'url.https://github.com/.insteadOf=git@github.com:'] as const;

const GITHUB_SSH_HOST_RE = String.raw`github\.com(?:-[A-Za-z0-9_-]+)?`;

/** Process-local insteadOf prefix for canonical GitHub SSH URLs and simple
 * per-account SSH-config aliases such as `github.com-git-graph`. A dot is not
 * allowed in the alias suffix, so a lookalike DNS name cannot be canonicalized
 * to GitHub by this recovery path. */
const githubSshInsteadOfPrefix = (url: string): string | null => {
  const trimmed = url.trim();
  const scp = new RegExp(`^(git@${GITHUB_SSH_HOST_RE}:)`, 'i').exec(trimmed);
  if (scp?.[1]) return scp[1];
  const ssh = new RegExp(`^(ssh://git@${GITHUB_SSH_HOST_RE}/)`, 'i').exec(trimmed);
  return ssh?.[1] ?? null;
};

/**
 * The one SSH-auth failure for which git-sync has an equivalent configured
 * credential plane to try. Keep this exact: network failures, repository
 * authorization failures, and non-GitHub SSH hosts need their original error.
 */
export const isGitHubSshPublicKeyFailure = (result: { stdout: string; stderr: string }): boolean =>
  new RegExp(`git@${GITHUB_SSH_HOST_RE}:\\s*Permission denied \\(publickey\\)\\.?`, 'i').test(
    `${result.stdout}\n${result.stderr}`,
  );

/** A missing local SSH-config alias for a GitHub account is a transport-plane
 * failure with the same safe HTTPS equivalent as a missing SSH key. */
export const isGitHubSshAliasResolutionFailure = (result: { stdout: string; stderr: string }): boolean =>
  new RegExp(`ssh:\\s*Could not resolve hostname github\\.com-[A-Za-z0-9_-]+:`, 'i').test(
    `${result.stdout}\n${result.stderr}`,
  );

/** GitHub can authenticate an SSH key successfully and still reject every write because the
 *  account behind that key has no verified email. The configured HTTPS credential may belong to
 *  a different, write-capable automation account, so this is the same credential-plane failure
 *  class as a missing SSH key — but only after the configured remote is proven to be GitHub SSH. */
export const isGitHubSshEmailVerificationFailure = (result: { stdout: string; stderr: string }): boolean =>
  /(?:remote:\s*)?You must verify your email address\.?/i.test(`${result.stdout}\n${result.stderr}`);

const isGitHubSshRemoteUrl = (url: string): boolean => githubSshInsteadOfPrefix(url) !== null;

/**
 * Retry one GitHub fetch/push through the existing HTTPS credential helper when
 * SSH has no usable public key. The -c override is process-local: canonical
 * remotes and .gitmodules remain untouched, and no credential is put in argv.
 */
const runNetworkGitWithGitHubHttpsFallback = async (
  runGit: RunGit,
  args: string[],
  cwd: string,
  log: (message: string) => void,
): ReturnType<RunGit> => {
  const first = await runGit(args, cwd);
  const command = gitSubcommand(args);
  const publicKeyFailure = isGitHubSshPublicKeyFailure(first);
  const emailVerificationFailure = isGitHubSshEmailVerificationFailure(first);
  const aliasResolutionFailure = isGitHubSshAliasResolutionFailure(first);
  if (
    first.code === 0 ||
    (command !== 'fetch' && command !== 'push') ||
    (!publicKeyFailure && !emailVerificationFailure && !aliasResolutionFailure)
  ) {
    return first;
  }

  let insteadOfArgs: readonly string[] = GITHUB_HTTPS_INSTEAD_OF_ARGS;
  // Unlike the canonical public-key error, GitHub's email-policy response and an
  // unresolved account alias do not prove the configured remote URL shape. Read
  // the remote and derive its exact process-local prefix; an HTTPS, non-GitHub,
  // or dotted lookalike host must retain its original failure.
  if (emailVerificationFailure || aliasResolutionFailure) {
    const remote = args[1];
    if (!remote) return first;
    const remoteUrl = isGitHubSshRemoteUrl(remote)
      ? remote
      : (await runGit(['remote', 'get-url', remote], cwd)).stdout.trim();
    const insteadOfPrefix = githubSshInsteadOfPrefix(remoteUrl);
    if (!insteadOfPrefix) return first;
    insteadOfArgs = ['-c', `url.https://github.com/.insteadOf=${insteadOfPrefix}`];
  }

  log(
    `[git-sync] ${cwd}: GitHub SSH ${
      publicKeyFailure
        ? 'publickey authentication failed'
        : aliasResolutionFailure
          ? 'account host alias could not resolve'
          : 'account requires email verification'
    } during ${command}; retrying once through configured HTTPS credentials`,
  );
  return runGit([...insteadOfArgs, ...args], cwd);
};

/** GitHub hard-rejects blobs ≥100MB (pre-receive) — a committed oversized blob makes
 *  the whole unpushed range PERMANENTLY unpushable (EI-18: 10.4GB of Rust target/
 *  artifacts wedged the push for 20h). Stay safely under. */
export const DEFAULT_MAX_BLOB_BYTES = 95 * 1024 * 1024;
/**
 * WI-5738: cap on the CUMULATIVE size of one auto-commit's dirty set. Set well
 * under the publish guard's DEFAULT_MAX_PUBLISH_TOTAL_BYTES (500 MB) so the
 * commit-side gate — where the response is a cheap exclusion — always fires
 * BEFORE the publish-side one, where the only response was a terminal refusal.
 * The headroom also absorbs several commits accumulating between publish ticks.
 */
export const DEFAULT_MAX_COMMIT_TOTAL_BYTES = 250 * 1024 * 1024;

export interface GitSyncConfig {
  /** Push the SUPERPROJECT to its origin after committing/merging (default true).
   *  Does NOT control submodule pushes — see `pushSubmoduleOrigins` (EI-18689553108460319:
   *  these used to share one flag, so a bridged/p2p-only hive setting this false to keep
   *  the bridge writer the sole pusher of the hive's own canonical refs silently ALSO
   *  stranded every submodule's commits — unrelated vendored libraries with their own
   *  GitHub origins that nothing else ever pushes). */
  push?: boolean;
  /** Sync submodules too (default true). When true, ALL submodules are synced
   *  recursively — discovery is dynamic, never a fixed list. */
  pushSubmodules?: boolean;
  /** Push SUBMODULE repos to THEIR OWN origins (defaults to `push`) — independent of `push`,
   *  which now controls the superproject only (EI-18689553108460319). A bridged/p2p-only
   *  hive's `push:false` exists so the bridge writer stays the sole pusher of the hive's
   *  own canonical superproject refs (github-bridge-hive-egress P-003/S-1); that rationale
   *  does not extend to submodules, each an independent GitHub repo the bridge never
   *  touches. Non-legacy callers also require owning-hive authorization at each push. */
  pushSubmoduleOrigins?: boolean;
  /** WI-6554700010018380: working-copy submodules with no pot fork (set by
   *  `applyIntegrationPushTarget`). Neither they nor anything nested under them is
   *  committed, merged or pushed: nothing could publish such a commit, and committing it
   *  locally leaves the superproject pinning an unresolvable gitlink. Edits inside stay
   *  in the working tree. */
  unforkedSubmodules?: string[];
  /** WI-6554700010018602: submodules that are ANOTHER registered pot's checkout with its own
   *  git-sync (set by git-sync-action via `resolveNestedPotCheckouts`). That pot publishes
   *  them through its own delivery route, so this tick never commits, merges or pushes
   *  inside them, and leaves their gitlink unstaged while its HEAD is on no `origin` ref. */
  nestedPotCheckouts?: string[];
  /** pot-review-integration-mode P-016: a working-copy pot merges the MAIN repository's
   *  branch into its staging each tick (set by `applyIntegrationPushTarget`). Applied to
   *  the SUPERPROJECT only — submodules are the main repositories' own and never absorb. */
  syncBack?: SyncBackConfig;
  /** Reconcile the SUPERPROJECT worktree with its configured Git remote
   *  (fetch + merge) before an optional push. Default true.
   *
   *  Non-legacy P2P hives set this false: their dedicated GitHub-ingress leg
   *  imports GitHub heads into the bare P2P store and their worktree-bridge leg
   *  advances the checkout from the admitted canonical staging ref. Running a
   *  second direct origin merge here bypasses that admission path and makes an
   *  installer seed look perpetually unconverted when the two histories are
   *  intentionally unrelated. Submodule origin syncing remains independent. */
  reconcileSuperprojectOrigin?: boolean;
  /**
   * Reconcile a fully represented release `main` commit into a commit-only
   * `staging` worktree without importing any GitHub content (default false).
   *
   * Bridged hives deliberately disable `reconcileSuperprojectOrigin`: GitHub
   * ingress/admission and the P2P worktree bridge own content flow. Frozen
   * repair promotion can nevertheless leave `main` as a sibling whose exact
   * tree changes are already present on staging. When this explicit knob is
   * enabled, git-sync may record only that proven ancestry with an `ours`
   * merge. The helper declines on an unrelated lineage or any differing tree
   * entry, so this never bypasses admission for new content.
   */
  bridgeContainedReleaseMainOnCommitOnly?: boolean;
  /** Branch to sync when a repo is on a branch / for the superproject (default 'main'). */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  /** Commit subject (a default is used otherwise). */
  message?: string;
  /** Dirty files larger than this are EXCLUDED from the auto-commit and reported
   *  (`oversized` on the outcome) instead of wedging the push forever
   *  (default DEFAULT_MAX_BLOB_BYTES). */
  maxBlobBytes?: number;
  /** WI-5738: dirty files are excluded largest-first once the CUMULATIVE dirty
   *  set exceeds this (default DEFAULT_MAX_COMMIT_TOTAL_BYTES) — the gate that
   *  catches a bulk accident whose individual files are all under maxBlobBytes. */
  maxCommitTotalBytes?: number;
}

/** One (sub)repo that hit a merge conflict during a pass. */
export interface RepoConflict {
  /** Which repo conflicted: 'superproject' or a submodule path (repo-relative). */
  scope: string;
  conflictedFiles: string[];
}
/** One (sub)repo that errored (e.g. a push that wasn't a recoverable non-ff). */
export interface RepoError {
  scope: string;
  message: string;
}
/** A dirty file excluded from the auto-commit because it exceeds maxBlobBytes. */
export interface OversizedFile {
  path: string;
  sizeBytes: number;
  /**
   * Which byte guard caused this file to be left out of the commit. Per-file
   * exclusions predate this field and intentionally omit it; absence means the
   * per-file guard for backwards-compatible result shapes. The cumulative guard
   * sets `cumulative-limit` so alarms do not misattribute a small file to GitHub's
   * individual-blob ceiling.
   */
  exclusionReason?: 'cumulative-limit';
}
/** An oversized file, qualified by which repo it sits in. */
export interface ScopedOversized extends OversizedFile {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}
/** A content-guard offender (EI-438), qualified by which repo it sits in. The
 *  action layer escalates these + dispatches a content-fixer (git-sync-action). */
export interface ScopedContentError extends ContentOffender {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}

/**
 * EI-20402093158205519: a submodule that is POPULATED on disk and holds uncommitted
 * TRACKED changes, but is absent from `.git/config` (`git submodule init` never ran).
 * `git submodule status` marks it '-', discovery skips it, and git-sync therefore never
 * visits the repo at all — so the edits are invisible to every tick, forever, with no
 * error anywhere. Measured on the sidestage hive 2026-08-14: 7 of 8 submodules '-'-flagged
 * but fully populated; discovery returned 1 path; 3 tracked files sat stranded across two
 * repos while the routine reported a clean 'synced' every tick.
 *
 * This is NOT an error the pass can fix, and deliberately does NOT make the pass
 * `status:'error'` — that would defer the superproject push on EVERY tick and wedge the
 * whole hive over a condition git-sync must not auto-resolve (registering a deliberately
 * pinned worktree would fetch/merge/push it and UNPIN it). It rides its own escalation
 * row instead: visible and queryable, non-blocking, self-clearing.
 */
export interface StrandedSubmodule {
  /** Repo-relative submodule path, e.g. 'libs/papergrid'. */
  path: string;
  /** Count of TRACKED modified files. Untracked scratch (.vitest-tmp/ &c.) is excluded
   *  on purpose — counting it would cry wolf on every tick a test run is in flight. */
  trackedFiles: number;
  /** The tracked porcelain paths, capped for the escalation body. */
  files: string[];
}

/** A live edit lock that must be preserved as structured, actionable provenance. */
export interface GitSyncLockHolding {
  path: string;
  owner: string;
  intent: string;
  /** The active work-item/goal associated with this lock, when stamped by locks:acquire. */
  goalRef?: string;
  /**
   * ISO time the hold began. Set by census holds that are not real locks (the
   * turn-scoped hold stamps the edit time) so a reader can report the hold's age.
   */
  heldSince?: string;
}

/** A dirty path deferred by this pass, with lock provenance or a guard reason. */
export type GitSyncSkippedPath =
  | { scope: string; path: string; owner: string; intent: string; heldSince?: string }
  | { scope: string; path: string; reason: 'migration-reservation'; detail: string }
  | {
      scope: string;
      path: string;
      reason: 'migration-dependency-fence';
      detail: string;
      /**
       * WI-10006493: the structured provenance of the deferral, so a reader such as
       * dev:pipeline_position can name the migration that is blocking this path and
       * who owns it, instead of telling the caller to force a sync that defers the
       * path again. Each is a superproject-relative path, agent id or work-item id.
       */
      blockingMigrations?: string[];
      blockingAgents?: string[];
      blockingWorkItems?: string[];
      /** Exact migrations with missing edit attribution; reservation owners are not edit authors. */
      unattributedMigrations?: string[];
    };

/**
 * Keep a superproject edit from outrunning a migration quarantined in one of its
 * submodules. Reuse git-sync's edit-ledger attribution: same-work-item paths are
 * held together, while confidently attributed unrelated work can still commit.
 * If a refused migration or a dirty root path cannot be attributed, fail closed
 * for that root path; if the refused migration itself is unknown, hold all root
 * changes because their dependency cannot be ruled out.
 */
export function migrationDependencyFenceSkips(
  refusedMigrations: readonly Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }>[],
  dirtySuperprojectPaths: readonly string[],
  roster: readonly AttributionRosterEntry[],
  /** Superproject root, so absolute presence `current_files` normalize like every other caller's. */
  superRoot?: string,
  /** Exact root-relative live holds fill gaps when the edit-attribution roster has no path row. */
  liveLockHoldings: readonly GitSyncLockHolding[] = [],
): GitSyncSkippedPath[] {
  if (refusedMigrations.length === 0 || dirtySuperprojectPaths.length === 0) return [];

  const attributionsByScope = new Map<string, Map<string, FileAttribution>>();
  const mapFor = (scope: string): Map<string, FileAttribution> => {
    let map = attributionsByScope.get(scope);
    if (!map) {
      map = attributionMapForRepo([...roster], scope, superRoot);
      attributionsByScope.set(scope, map);
    }
    return map;
  };
  // EI-25203408414398603: the edit ledger records a NESTED repo's edit relative to THAT repo
  // with repo=NULL (edit-attribution.ts — locks:acquire never learns the true repo root), so a
  // child migration's roster entry reads 'libs/db/sql/NNNN-x.sql', never
  // '<scope>/libs/db/sql/NNNN-x.sql'. Matching only the scope-qualified form left every child
  // migration unattributed, and an unattributed migration holds EVERY dirty superproject path —
  // one stray migration froze the whole superproject. Prefer the scope-qualified match, then
  // accept the nested-relative shape the ledger actually writes.
  const migrationAttribution = (migration: { scope: string; path: string }): FileAttribution | undefined =>
    mapFor(migration.scope).get(migration.path) ??
    (migration.scope && migration.scope !== 'superproject' ? mapFor('').get(migration.path) : undefined) ??
    (() => {
      // A turn-scoped hold can name the exact editor even when that path is absent from
      // the merged edit/presence roster. Do not match the nested-relative suffix here:
      // only the root-relative, scope-qualified lock coordinate identifies this migration.
      const rootRelativePath = migration.scope && migration.scope !== 'superproject'
        ? `${migration.scope.replace(/\/+$/, '')}/${migration.path.replace(/^\/+/, '')}`
        : migration.path;
      const holding = liveLockHoldings.find((entry) => entry.path.replace(/^\.\//, '') === rootRelativePath);
      if (!holding) return undefined;
      const workItems = holding.goalRef && /^(?:WI-|EI-|F-)\d+$/.test(holding.goalRef)
        ? [holding.goalRef]
        : [];
      return { agent: holding.owner, workItems };
    })();

  const blockedWorkItems = new Set<string>();
  const blockedAgents = new Set<string>();
  const agentsWithoutWorkItem = new Set<string>();
  const unattributedMigrations: string[] = [];
  let unknownMigration = roster.length === 0;
  for (const migration of refusedMigrations) {
    const attribution = migrationAttribution(migration);
    if (!attribution) {
      unknownMigration = true;
      unattributedMigrations.push(
        migration.scope && migration.scope !== 'superproject' ? migration.scope + '/' + migration.path : migration.path,
      );
      continue;
    }
    blockedAgents.add(attribution.agent);
    const workItems = (attribution.workItems ?? []).map((id) => id.trim()).filter(Boolean);
    if (workItems.length === 0) agentsWithoutWorkItem.add(attribution.agent);
    for (const id of workItems) blockedWorkItems.add(id);
  }

  const rootAttributions = mapFor('');
  // Superproject-relative, so a reader can match them against the paths it is asked about.
  const blockingMigrations = [
    ...new Set(
      refusedMigrations.map((migration) =>
        migration.scope && migration.scope !== 'superproject' ? migration.scope + '/' + migration.path : migration.path,
      ),
    ),
  ];
  const migrationLocations = blockingMigrations.slice(0, 3).join(', ');
  const details = (path: string): GitSyncSkippedPath => {
    const rootAttribution = rootAttributions.get(path);
    const rootWorkItems = (rootAttribution?.workItems ?? []).map((id) => id.trim()).filter(Boolean);
    const sharesWorkItem = rootWorkItems.some((id) => blockedWorkItems.has(id));
    return {
      scope: 'superproject',
      path,
      reason: 'migration-dependency-fence',
      detail: unknownMigration
        ? 'deferred because a reservation-blocked migration could not be attributed; holding this path until its dependency is known'
        : sharesWorkItem
          ? 'deferred because this path shares work-item attribution with a reservation-blocked migration at ' + migrationLocations
          : 'deferred because this path is attributed to the same agent as a reservation-blocked migration at ' + migrationLocations,
      blockingMigrations,
      blockingAgents: [...blockedAgents],
      blockingWorkItems: [...blockedWorkItems],
      ...(unattributedMigrations.length > 0 ? { unattributedMigrations: [...new Set(unattributedMigrations)] } : {}),
    };
  };

  return [...new Set(dirtySuperprojectPaths)]
    .filter((path) => {
      if (unknownMigration) return true;
      const attribution = rootAttributions.get(path);
      if (!attribution) return true;
      const workItems = (attribution.workItems ?? []).map((id) => id.trim()).filter(Boolean);
      const sharesWorkItem = workItems.some((id) => blockedWorkItems.has(id));
      const sameAgentWithoutKnownWorkItem =
        blockedAgents.has(attribution.agent) &&
        (agentsWithoutWorkItem.has(attribution.agent) || workItems.length === 0 || blockedWorkItems.size === 0);
      return sharesWorkItem || sameAgentWithoutKnownWorkItem;
    })
    .map(details);
}

/** True when two repo-relative paths overlap as a file or directory lock. */
function gitSyncPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// P-009 / WI-10002596: moved to ./live-lock-coordinates (pure, dependency-free) so that
// consumers mocking this module still exercise the real coordinate mapping.
export { mapLiveLockHoldingsForRepo, nestedInstallRepoPrefix } from './live-lock-coordinates';

/**
 * Expand a live-lock exclusion to the rest of the same edit cohort.
 *
 * A live file lock is a per-file lease, but an agent's edit is often a coherent
 * multi-file change (source + test, or migration + code). The automatic hook can
 * release those leases at different times, so excluding only the rows visible in
 * this tick lets an already-unlocked sibling reach HEAD alone. The edit ledger
 * attribution map is the durable bridge to that sibling: it records each granted
 * path with the work-item active at edit time.
 *
 * Only a holding with a non-empty goalRef seeds a cohort. A legacy/null goal is
 * intentionally left at the old per-path behavior: grouping unknown work under an
 * owner would conflate unrelated edits. The caller still always protects every
 * directly live-held path, whether or not attribution is available.
 *
 * Pure and exported so the TTL-skew regression is testable without a live lock DB or
 * a git subprocess. `paths` contains only dirty paths (plus a directly held path
 * when its lock names a directory); clean files do not need a pathspec exclusion.
 */
export function expandAtomicLiveLockExclusions(
  dirtyFiles: readonly string[],
  holdings: readonly GitSyncLockHolding[],
  attribution?: ReadonlyMap<string, FileAttribution>,
  generatedDeclarationPaths: readonly string[] = [],
): {
  paths: string[];
  groups: Array<{ key: string; owner: string; goalRef: string; paths: string[] }>;
  generatedDeclarationPairs: Array<{ source: string; artifact: string; heldPath: string }>;
} {
  const dirty = [...new Set(dirtyFiles.map((path) => path.trim()).filter(Boolean))];
  const groups = new Map<string, { owner: string; goalRef: string; paths: Set<string> }>();
  const directPaths = new Set<string>();

  for (const holding of holdings) {
    const path = holding.path.trim();
    if (!path || !dirty.some((file) => gitSyncPathsOverlap(file, path))) continue;
    directPaths.add(path);
    const owner = holding.owner.trim();
    const goalRef = holding.goalRef?.trim() ?? '';
    if (!owner || !goalRef) continue;
    const key = JSON.stringify([owner, goalRef]);
    let group = groups.get(key);
    if (!group) {
      group = { owner, goalRef, paths: new Set<string>() };
      groups.set(key, group);
    }
    group.paths.add(path);
  }

  if (groups.size > 0 && attribution) {
    for (const file of dirty) {
      const a = attribution.get(file);
      if (!a || !a.agent.trim()) continue;
      for (const workItem of a.workItems ?? []) {
        const key = JSON.stringify([a.agent.trim(), workItem.trim()]);
        const group = groups.get(key);
        if (group && workItem.trim()) group.paths.add(file);
      }
    }
  }

  // Declaration repairs are forced through the catch-all commit so each
  // generated source/artifact pair normally lands atomically. A live lock can
  // arrive after the initial census, though, and exclude only one staged half
  // at the post-stage guard. The regenerator supplies this enrolled pair set;
  // close any overlapping live hold over both exact paths before either
  // attribution or catch-all staging can publish a torn pair.
  const declarationClosure = expandGeneratedDeclarationPairHolds([...directPaths], generatedDeclarationPaths);
  for (const path of declarationClosure.paths) directPaths.add(path);

  const paths = new Set(directPaths);
  const outputGroups: Array<{ key: string; owner: string; goalRef: string; paths: string[] }> = [];
  for (const [key, group] of groups) {
    const pathsForGroup = [...group.paths].sort();
    for (const path of pathsForGroup) paths.add(path);
    outputGroups.push({ key, owner: group.owner, goalRef: group.goalRef, paths: pathsForGroup });
  }
  outputGroups.sort((a, b) => a.key.localeCompare(b.key));
  return {
    paths: [...paths].sort(),
    groups: outputGroups,
    generatedDeclarationPairs: declarationClosure.pairs,
  };
}

/**
 * WI-6554700010008496: why each live-lock-excluded path is held, for the importer
 * findings queued behind it. A path covered by a holding names its holder, work-item
 * and intent (a turn hold's intent says it is one); a path pulled in only because a
 * dirty file shares a held work-item names that work-item and its holder.
 */
export function describeLiveLockExclusions(
  exclusions: {
    paths: readonly string[];
    groups: ReadonlyArray<{ owner: string; goalRef: string; paths: readonly string[] }>;
  },
  holdings: readonly GitSyncLockHolding[],
): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const path of exclusions.paths) {
    const holding = holdings.find((h) => h.path.trim().length > 0 && gitSyncPathsOverlap(path, h.path.trim()));
    if (holding) {
      const intent = holding.intent.trim().replace(/\s+/g, ' ');
      const clipped = intent.length > 120 ? `${intent.slice(0, 119)}…` : intent;
      const goal = holding.goalRef?.trim() ? ` for ${holding.goalRef.trim()}` : '';
      reasons.set(path, `held by ${holding.owner}${goal}${clipped ? ` — ${clipped}` : ''}`);
      continue;
    }
    const group = exclusions.groups.find((g) => g.paths.includes(path));
    if (group) reasons.set(path, `same work-item ${group.goalRef} as a path held by ${group.owner}`);
  }
  return reasons;
}

/**
 * A lock on one Rust source file must withhold the rest of that dirty Cargo package.
 *
 * Goal attribution is useful when it exists, but it is optional metadata and cannot
 * establish Rust module completeness. In particular, publishing callers and a new
 * sibling module while the locked crate root is withheld leaves a tree that does not
 * compile even though the directional importer guard sees no import from the old root.
 * Find the nearest Cargo package for each directly-excluded dirty file, then keep all
 * dirty paths in that package together for this repository pass. Workspace-only
 * Cargo.toml files ([workspace] without [package]) are not package boundaries.
 */
export async function expandCargoPackageLiveLockExclusions(
  dirtyFiles: readonly string[],
  excludedPaths: readonly string[],
  readText: (path: string) => Promise<string | null>,
): Promise<{ paths: string[]; packages: Array<{ root: string; paths: string[] }> }> {
  const dirty = [...new Set(dirtyFiles.map((path) => path.trim()).filter(Boolean))];
  const excluded = [...new Set(excludedPaths.map((path) => path.trim()).filter(Boolean))];
  const packageRoots = new Set<string>();
  const manifestCache = new Map<string, Promise<string | null>>();
  const readManifest = (path: string): Promise<string | null> => {
    let result = manifestCache.get(path);
    if (!result) {
      result = readText(path);
      manifestCache.set(path, result);
    }
    return result;
  };

  for (const file of dirty) {
    if (!excluded.some((path) => gitSyncPathsOverlap(file, path))) continue;
    let dir = file === 'Cargo.toml' ? '.' : file.slice(0, Math.max(0, file.lastIndexOf('/')));
    if (!dir) dir = '.';
    while (true) {
      const manifestPath = dir === '.' ? 'Cargo.toml' : `${dir}/Cargo.toml`;
      const manifest = await readManifest(manifestPath);
      if (manifest != null && /^\s*\[package\]\s*$/m.test(manifest)) {
        packageRoots.add(dir);
        break;
      }
      const parent = dir === '.' ? '.' : dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) || '.' : '.';
      if (parent === dir) break;
      dir = parent;
    }
  }

  const packages = [...packageRoots].sort().map((root) => ({
    root,
    paths: dirty.filter((file) => (root === '.' ? true : file.startsWith(`${root}/`))).sort(),
  }));
  const paths = [...new Set(packages.flatMap((pkg) => pkg.paths))].sort();
  return { paths, packages };
}

const FETCH_FAILURE_REASON_MAX_CHARS = 300;

/**
 * WI-10004103: the one line of a failed fetch's stderr worth putting in a status message.
 * A disk-headroom refusal from `withGitFetchHeadroom` wins, because it is the actionable
 * cause and git's own output around it is noise. SSH failures can append a generic
 * "make sure ... repository exists" footer after the actual auth/transport error, so
 * skip that boilerplate and keep the last concrete line. Whitespace is collapsed and
 * the result capped.
 */
export function summarizeFetchFailure(stderr: string | null | undefined): string {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const isGenericRepositoryAccessLine = (line: string) =>
    /^(?:fatal:\s*could not read from remote repository\.?|please make sure you have the correct access rights(?: and the repository exists)?\.?|and the repository exists\.?)$/i.test(line);
  const finalLine = lines[lines.length - 1]!;
  const hasRepositoryExistsFooter = /the repository exists\.?$/i.test(finalLine);
  const genericFatal = lines.find((line) => /^fatal:\s*could not read from remote repository\.?$/i.test(line));
  const chosen =
    lines.find((line) => /disk headroom/i.test(line)) ??
    (hasRepositoryExistsFooter
      ? [...lines].reverse().find((line) => !isGenericRepositoryAccessLine(line)) ?? genericFatal ?? finalLine
      : finalLine);
  return chosen.length > FETCH_FAILURE_REASON_MAX_CHARS
    ? `${chosen.slice(0, FETCH_FAILURE_REASON_MAX_CHARS - 1)}…`
    : chosen;
}

const NPM_MANIFEST_BASENAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);

/** True for an npm manifest or lockfile this repository tracks (never one inside node_modules). */
export function isNpmManifestPath(path: string): boolean {
  const segments = path.trim().split('/');
  const base = segments[segments.length - 1] ?? '';
  return NPM_MANIFEST_BASENAMES.has(base) && !segments.includes('node_modules');
}

/**
 * EI-24649116564770033 / WI-10004077: npm manifests in one repository are ONE unit.
 *
 * A dependency change touches a workspace `package.json`, usually the root `package.json`,
 * and the single root lockfile, which records every workspace at once. When any dirty
 * manifest is withheld this pass (a live lock, an oversized or content-guard exclusion),
 * committing the others lands half the change: observed, operator-core's new dependency
 * reached HEAD without its root workspace entry or lockfile, so a clean `npm ci` of that
 * commit fails. So a withheld dirty manifest withholds every other dirty manifest in the
 * same repository until they can land together.
 *
 * Returns only the ADDITIONAL paths to withhold, plus the withheld manifests that caused it.
 * A lock on a CLEAN manifest triggers nothing: no half of any change is being held back.
 */
export function expandNpmManifestClosure(
  dirtyFiles: readonly string[],
  excludedPaths: readonly string[],
): { paths: string[]; triggers: string[] } {
  const excluded = excludedPaths.map((path) => path.trim()).filter(Boolean);
  const dirtyManifests = [...new Set(dirtyFiles.map((path) => path.trim()).filter(isNpmManifestPath))].sort();
  const isExcluded = (file: string) => excluded.some((path) => gitSyncPathsOverlap(file, path));
  const triggers = dirtyManifests.filter(isExcluded);
  if (triggers.length === 0) return { paths: [], triggers: [] };
  return { paths: dirtyManifests.filter((file) => !isExcluded(file)), triggers };
}

/**
 * The aggregate result of one whole-repo pass. `pushed`/`merged` name the scopes
 * ('superproject' or submodule paths) that were pushed to / merged from origin, so
 * a caller can report exactly what moved. A pass NO LONGER stops at the first
 * conflict: it reconciles every submodule it can, COLLECTS conflicts/errors, and
 * only defers the superproject (see runGitSync). `status` is the worst outcome:
 * any conflict → 'conflict', else any error → 'error', else 'synced'/'nothing'.
 */
export interface GitSyncRootCommit {
  sha: string;
  /** Observation immediately after successful root publication, never replay time. */
  committedAtMs: number;
}

export type GitSyncOutcome = {
  /** Per-publication proof retained by the commit checkpoint, including on replay. */
  localCommits?: GitSyncRootCommit[];
  /**
   * Exact root commit created by this pass, captured before fetch/merge/push.
   * Unlike aggregate committedCount or a measured existing headSha, this proves
   * a new local commit in the checkout whose install scopes the notification.
   */
  localCommitSha?: string;
  /** Original producer observation time, persisted with the root commit phase. */
  localCommitAtMs?: number;
  /**
   * Every root commit this pass created, oldest first, ending at localCommitSha.
   * The commit phase publishes one commit per attributed group, so a waiter can
   * hold an earlier group commit's sha (WI-6554700010019053). Absent on a legacy
   * phase checkpoint or when only one commit is known.
   */
  localCommitShas?: string[];
  /**
   * Measured superproject HEAD after the local stage, including a partial
   * error/conflict pass. Absence means that stage did not supply a readable
   * HEAD; it does not mean the checkout has no committed work. Synced outcomes
   * keep their existing required headSha contract below.
   */
  headSha?: string;
  /** Number of dirty paths measured across every repo visited by this pass. */
  dirtyPathCount: number;
  /** Number of local commits created across every repo during this pass. */
  committedCount: number;
  /** Dirty files excluded from this pass's auto-commits for exceeding maxBlobBytes
   *  (EI-18). Non-empty = someone must gitignore/remove them — this NEVER self-heals;
   *  the caller escalates. Present on every status ('nothing' included: an
   *  oversized-only dirty tree commits nothing but still reports). */
  oversized: ScopedOversized[];
  /**
   * Dirty files excluded by the cumulative commit-size guard. This is a
   * compatibility-preserving view of `oversized`: the latter still carries the
   * complete quarantine set used by the commit/escalation pipeline, while this
   * field lets metadata readers distinguish individually oversized blobs from
   * individually-valid files peeled to keep one commit under the total budget.
   */
  bulkExcluded?: ScopedOversized[];
  /** Dirty files EXCLUDED from this pass's auto-commits because a content detector
   *  flagged them (EI-438 — e.g. an .mdx that won't compile). Like `oversized`, the
   *  rest of the tree still commits (D-001 quarantine-don't-stall); the action layer
   *  escalates these + dispatches a content-fixer, which self-heals on a later tick.
   *  Present on every status. */
  contentErrors: ScopedContentError[];
  /** EI-20402093158205519: populated-but-unregistered submodules holding uncommitted
   *  tracked work this pass could not see (see StrandedSubmodule). Present on every
   *  status — a strand is orthogonal to whether the visible tree synced, and reporting
   *  it ONLY on failure is precisely the silence that let it run for hours: the pass
   *  that strands work is otherwise a perfectly clean 'synced'.
   *
   *  `null` means NOT MEASURED this pass (discovery failed, or a submodulePaths override
   *  bypassed it) and is deliberately distinct from `[]` (measured, nothing stranded).
   *  Collapsing the two would let an unmeasured pass retire a live warning — the exact
   *  failure mode this whole field exists to prevent, reintroduced one level up. The
   *  nullable type forces every consumer to decide which it is. */
  strandedSubmodules: StrandedSubmodule[] | null;
  /** Live-lock paths excluded this pass. Other unlocked paths may still sync. */
  skippedPaths?: GitSyncSkippedPath[];
  /** WI-6554700010018198: one entry per repo whose attributed phase ran this pass.
   *  Absent means no phase ran (flag off, nothing attributed, or a checkpointed step was
   *  replayed): NOT measured, which callers must keep distinct from a measured success. */
  attribution?: AttributionTally[];
  /**
   * Scopes whose fetch+merge stage completed successfully this pass, even when a
   * later push failed. This is distinct from `merged`: it proves that the merge
   * stage ran without a conflict and is safe for escalation clearing.
   */
  mergeCompleted?: string[];
  /**
   * P-016: the superproject's sync-back result for this pass — upstream `main`
   * merged into the working copy's `staging` (review integration mode only).
   * Absent when sync-back is not configured or did not run this pass. The
   * action layer files a fix-it work-item when `status === 'conflict'`.
   */
  syncBack?: SyncBackResult;
} & (
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: string[]; merged: string[] }
  | { status: 'conflict'; conflicts: RepoConflict[]; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'error'; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'skipped-locked' }
);

/**
 * WI-1416: the seam a durable caller (git-sync-action inside a DBOS routineFire)
 * threads checkpointing through. Each pipeline PHASE (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) runs under `step(name, fn)` so the
 * workflow records one operation_output per phase: the executor reaper sees genuine
 * progress (function_id > 0), and a crashed/resumed fire REPLAYS completed phases
 * from their checkpoints instead of re-running them. Defaults to a passthrough
 * (unit tests / fireGitSyncNow outside any workflow).
 *
 * REPLAY SAFETY (the hard constraint): every phase is idempotent against a re-run —
 * a replayed commit finds a clean tree (`nothing to commit` is benign), a replayed
 * push is `Everything up-to-date`, a replayed merge re-fetches — so neither a DBOS
 * step retry nor a reaped-and-requeued fire can double-commit.
 */
export type GitSyncStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Where a cooperative yield ({@link RunGitSyncOpts.shouldYield}) ended the pass. */
type GitSyncSuperprojectYieldBoundary = 'before-superproject-stage' | 'before-superproject-publish';
/** Completed Git boundaries; publication's shared-index refresh and CAS remain together. */
export type GitSyncYieldBoundary = 'submodule-batch' | 'before-pointer-bump' | GitSyncSuperprojectYieldBoundary;

/**
 * WI-10007606: thrown by {@link runGitSync} when `opts.shouldYield` reports a waiting
 * exclusive at a batch or phase boundary. It is NOT a failure: the caller records a
 * skip (no error streak, no escalation) and the next tick redoes the pass, which is
 * safe because every phase is idempotent (see GitSyncStepRunner's replay contract).
 */
export class GitSyncYieldError extends Error {
  readonly reason: string;
  readonly boundary: GitSyncYieldBoundary;
  /** Submodules fully synced before the yield (all of them at `before-pointer-bump`). */
  readonly submodulesSynced: number;
  readonly submodulesTotal: number;
  /**
   * WI-6554700010018899: root commit proof when the superproject pass had ALREADY
   * published commits before it yielded. A per-agent group commit lands, then a
   * later group's `before-superproject-publish` probe yields. The action emits
   * `git-sync:committed` from this proof; without it every commit waiter slept to
   * its timeout although the commits were on the branch. Absent = nothing landed.
   */
  readonly localCommitSha?: string;
  readonly localCommitAtMs?: number;
  /** Every root commit published before the yield, oldest first (WI-6554700010019053). */
  readonly localCommitShas?: readonly string[];
  readonly localCommits?: readonly GitSyncRootCommit[];
  constructor(
    reason: string,
    boundary: GitSyncYieldBoundary,
    submodulesSynced: number,
    submodulesTotal: number,
    landed?: { localCommitSha: string; localCommitAtMs: number; localCommitShas?: readonly string[]; localCommits?: readonly GitSyncRootCommit[] },
  ) {
    super(`git-sync yielded at ${boundary} (${submodulesSynced}/${submodulesTotal} submodules synced): ${reason}`);
    this.name = 'GitSyncYieldError';
    this.reason = reason;
    this.boundary = boundary;
    this.submodulesSynced = submodulesSynced;
    this.submodulesTotal = submodulesTotal;
    if (landed) {
      this.localCommitSha = landed.localCommitSha;
      this.localCommitAtMs = landed.localCommitAtMs;
      this.localCommits = landed.localCommits;
      if (landed.localCommitShas && landed.localCommitShas.length > 0) this.localCommitShas = landed.localCommitShas;
    }
  }
}

export interface RunGitSyncOpts {
  /**
   * Override the repo path (manual-fire pin + tests); else resolve via
   * `projectDirForSlug(slug)`. An explicit null is authoritative: the caller
   * already performed a scoped lookup and found no registered tree.
   */
  repoPath?: string | null;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  /** Authorize every push at the child-process boundary, including transport and
   * non-fast-forward retries. Non-legacy hive callers must supply the owner gate.
   * A refusal leaves local commits intact and is reported as a publication error. */
  beforePush?: (args: readonly string[], cwd: string) => Promise<void>;
  /** Called whenever the default git runner observes command progress. */
  onProgress?: () => void;
  /** Best-effort notification at each successful ROOT publication, before later
   * groups/push. Replayed commit checkpoints deliver the saved producer proof. */
  onRootCommit?: (commit: GitSyncRootCommit) => void;
  /** Abort a default git child when the owning fire is declared stalled. */
  signal?: AbortSignal;
  /** WI-1416: run each pipeline phase as a checkpointed durable step (see
   *  GitSyncStepRunner). Default: plain passthrough execution. */
  step?: GitSyncStepRunner;
  /**
   * WI-10007606: cooperative yield to a waiting exclusive (dev:restart's git-sync
   * restart barrier). One papercusp pass can hold the shared barrier for many minutes
   * under load (~41 submodules at ~12s per git call), far past any bounded drain, so
   * waiting it out never converged. Polled at submodule-batch boundaries, before the
   * pointer-bump phase, and inside superproject preparation/before publication —
   * never while a git command runs or between shared-index refresh and HEAD CAS.
   * Private indexes are removed on yield; completed commits remain durable.
   * A non-null reason ends the pass with
   * {@link GitSyncYieldError}. A probe that throws fails OPEN (the pass continues): a
   * broken probe must never stop commits.
   */
  shouldYield?: () => Promise<string | null>;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Repo-relative paths. */
  submodulePaths?: string[];
  /**
   * Caller-supplied paths that must remain outside this tick's commits. Paths are
   * superproject-root-relative, matching the live roster/current_files contract;
   * submodule paths are mapped to that repo's relative coordinate space below.
   */
  excludePaths?: string[];
  /** Initial live lock holdings, including clean-held paths; replaced by a successful authoritative refresh. */
  liveLockHoldings?: GitSyncLockHolding[];
  /**
   * Re-read the live edit-lock plane immediately before staging each dirty repo.
   * The callback returns superproject-root-relative holdings; runGitSync maps
   * them into each repo's coordinate space before passing them to commitOneRepo.
   * A successful refresh replaces the initial holdings; explicit excludePaths
   * remain protected. A rejected refresh fails closed and prevents staging.
   */
  refreshLiveLockHoldings?: () => Promise<GitSyncLockHolding[]>;
  /** Override the content-guard detector registry (tests / future extension).
   *  Defaults to DEFAULT_CONTENT_DETECTORS (mdx + smart-quotes). Pass [] to disable. */
  contentDetectors?: ContentDetector[];
  /** EI-17: the deletion-import guard (kill-switch: FLAGS.GIT_SYNC_DELETION_GUARD).
   *  Default true. When false, a dirty deletion is never checked against surviving
   *  imports — byte-identical to pre-EI-17 behavior (the instant off-switch on this
   *  shared commit path, no deploy needed, mirroring GIT_SYNC_CONTENT_GUARD). */
  deletionGuard?: boolean;
  /** Read a repo-relative file's working-tree text for the content guard (tests).
   *  Defaults to fs read; null on any error. */
  readText?: (repoPath: string, relPath: string) => Promise<string | null>;
  /** Write a repo-relative file's working-tree text for deterministic content repairs (tests).
   *  Defaults to fs write; the content guard re-checks its CAS before calling this. */
  writeText?: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log?: (m: string) => void;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): the caller supplies the live roster of active
   *  agents + their declared files (built flag-gated from coord presence). When present, git-sync
   *  derives a per-repo attribution map and peels per-agent commits; when absent (flag OFF / no
   *  caller) commits are unchanged (today's single whole-tree commit). DERIVED, never authored. */
  loadRoster?: () => Promise<AttributionRosterEntry[]>;
  loadMigrationFenceRoster?: () => Promise<AttributionRosterEntry[]>;
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS, default ON): commit subjects are DIFF-derived
   *  (`sync(<areas>): <what> (<n> files, +A/-D)`) with the agent's intent line demoted to
   *  the commit body. false = the pre-WI-38594 subjects (intent line / message stem). */
  diffSubjects?: boolean;
  /** WI-EI-20224214315801764: override the age floor for crash-left `tmp_pack_*` files. */
  staleTempPackMs?: number;
  /** Test seam for proving whether a candidate temp pack is still open by a process.
   *  `null` means the state is unknown; unknown is always preserved. */
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** Test seam for the holder probe behind the stale `.git/config.lock` guard
   *  (WI-6554700010011004). Defaults to the host open-file check (fuser, then a /proc
   *  scan), whose answer depends on host process-table speed. `null` means unknown,
   *  and unknown always preserves the lock. */
  isGitLockOpen?: (path: string) => Promise<boolean | null>;
  /** WI-39922: pre-superproject-commit repair for the tracked tool catalog.
   *  Defaults to the conditional, bounded, fail-soft regenerator above. */
  toolCatalogRegenerator?: ToolCatalogRegenerator;
  /** EI-21444216858331991: pre-superproject-commit declaration projection repair.
   *  Defaults to the conditional bounded writer above. Unlike the catalog repair,
   *  this is fail-closed because a torn source/declaration pair is a false gate red. */
  generatedDeclarationsRegenerator?: GeneratedDeclarationsRegenerator;
  /** EI-20428405431869483: pre-superproject-commit generated routing drift check.
   *  Defaults to the conditional, bounded, fail-soft checker above. */
  toolRoutingChecker?: ToolRoutingChecker;
  /** Fail-closed check for newly armed migration files before git-sync stages or commits them. */
  migrationReservationChecker?: MigrationReservationChecker;
}

/** Default content-guard file reader — the working-tree bytes that `add -A` would
 *  commit; null on any error (gone/binary/permission) so the guard fails open. */
const defaultReadText = async (repoPath: string, relPath: string): Promise<string | null> => {
  try {
    return await readFile(join(repoPath, relPath), 'utf8');
  } catch {
    return null;
  }
};

/** Default content-guard writer — UTF-8 working-tree text for deterministic repairs. */
const defaultWriteText = async (repoPath: string, relPath: string, text: string): Promise<void> => {
  await writeFile(join(repoPath, relPath), text, 'utf8');
};

const isDirty = async (runGit: RunGit, repo: string): Promise<boolean> => {
  const r = await runGit(['status', '--porcelain'], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
};

/** Candidate HEAD paths for the same module resolution key used by the
 * quarantine-import guard. The exact path is checked first, then the normal JS/
 * TS extensions and directory index forms so a quarantined `foo.ts` does not
 * infect an importer when a committed `foo.js` or `foo/index.ts` still resolves. */
function headModuleCandidates(relPath: string): string[] {
  const normalized = normalizeModulePath(relPath);
  return [
    ...new Set([
      relPath,
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}${ext}`),
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}/index${ext}`),
    ]),
  ];
}

/**
 * WI-10006734: working-tree JS/TS modules that the index bound to `runGit` does not provide —
 * untracked, non-ignored files whose module path no indexed file resolves either (`foo.ts`
 * untracked while `foo.js` or `foo/index.ts` is indexed still resolves). An ignored module is
 * a build artifact by design and is never reported. Fails closed: when the index cannot be
 * read, the guard cannot tell what the commit contains.
 */
async function untrackedModulesAbsentFromIndex(
  runGit: RunGit,
  repoPath: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const others = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], repoPath);
  if (others.code !== 0) return { ok: false, error: `could not list untracked files: ${gitFailureDetail(others)}` };
  const modules = others.stdout
    .split('\0')
    .filter((path) => path && !path.endsWith('.d.ts') && RESOLVABLE_EXTS.some((ext) => path.endsWith(ext)));
  if (modules.length === 0) return { ok: true, paths: [] };
  const candidates = [...new Set(modules.flatMap((path) => headModuleCandidates(path)))];
  const indexed = new Set<string>();
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500).map((path) => `:(literal)${path}`);
    const listed = await runGit(['ls-files', '-z', '--cached', '--', ...chunk], repoPath);
    if (listed.code !== 0) return { ok: false, error: `could not read the index for untracked modules: ${gitFailureDetail(listed)}` };
    for (const path of listed.stdout.split('\0')) if (path) indexed.add(path);
  }
  return { ok: true, paths: modules.filter((path) => !headModuleCandidates(path).some((c) => indexed.has(c))) };
}

async function isModuleResolvableAtHead(
  runGit: RunGit,
  repoPath: string,
  relPath: string,
  log: (m: string) => void,
): Promise<boolean> {
  for (const candidate of headModuleCandidates(relPath)) {
    try {
      const result = await runGit(['cat-file', '-e', `HEAD:${candidate}`], repoPath);
      if (result.code === 0) return true;
    } catch (e) {
      // A HEAD probe is a safety refinement, not a reason to wedge git-sync. If
      // it cannot be measured, retain the guard's conservative quarantine.
      log(`[quarantine-import-guard] HEAD probe failed for ${relPath}: ${String(e)}`);
      return false;
    }
  }
  return false;
}

/** Current branch name, or null when HEAD is detached. */
const currentBranch = async (runGit: RunGit, repo: string): Promise<string | null> => {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The remote's default branch — `git rev-parse --abbrev-ref <remote>/HEAD` →
 *  "<remote>/main" → "main". Resolves the sync branch for a DETACHED HEAD (P-004):
 *  a fresh `git submodule update` leaves submodules detached, and they must sync to
 *  their OWN default (main), not the superproject's branch. Null when <remote>/HEAD
 *  isn't set. */
const remoteDefaultBranch = async (runGit: RunGit, repo: string, remote: string): Promise<string | null> => {
  const r = await runGit(['rev-parse', '--abbrev-ref', `${remote}/HEAD`], repo);
  if (r.code !== 0) return null;
  const ref = r.stdout.trim();
  if (!ref || ref.endsWith('/HEAD')) return null; // unset → the literal "<remote>/HEAD"
  return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
};

/**
 * Retained installer-seed snapshot refs (`origin/papercusp-seed-snapshot-<uuid>`), cut by
 * the git seed provider at depth=1 (seed-provider-git.ts). One always points at the
 * synthetic one-commit seed root, so it is the TRIGGER for `transplantInstallerSeedSnapshot`
 * below — never a preservation branch git-sync may reconcile against. Reading it as
 * "HEAD is already preserved at origin/<branch>" short-circuits the conversion into a
 * no-op `nothing` and leaves every seeded install wedged on its synthetic root
 * (measured 2026-09-06: seed-provider-git.test.ts red at tip for exactly this).
 */
const SEED_SNAPSHOT_REF_PREFIX = 'papercusp-seed-snapshot-';
const isSeedSnapshotRef = (branch: string): boolean => branch.startsWith(SEED_SNAPSHOT_REF_PREFIX);

/** Remote-tracking branches whose tip is exactly the checked-out HEAD.
 *
 * A detached submodule can be intentionally preserved on a non-default branch
 * (for example `origin/restart-pin-<sha>`), while its dormant local `main` has
 * unrelated work. Exact-tip proof lets git-sync continue the preserved branch
 * without moving or merging either history. `origin/HEAD` is a symbolic alias,
 * not a branch target, and is deliberately excluded — as is a retained
 * installer-seed snapshot ref, which is conversion input, not a branch to follow.
 */
const remoteBranchesPointingAtHead = async (runGit: RunGit, repo: string, remote: string): Promise<string[]> => {
  const refs = await runGit(
    ['for-each-ref', '--format=%(refname:strip=3)', '--points-at=HEAD', `refs/remotes/${remote}/`],
    repo,
  );
  if (refs.code !== 0) return [];
  return [
    ...new Set(
      refs.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((branch) => branch.length > 0 && branch !== 'HEAD' && !isSeedSnapshotRef(branch)),
    ),
  ].sort();
};

/** Choose only a proved-unambiguous exact-tip branch. The remote default wins
 * when it is one of several aliases; otherwise multiple candidates are a real
 * direction fork and must retain the existing fail-closed path. */
const preferredRemoteBranchAtHead = (branches: readonly string[], remoteDefault: string | null): string | null => {
  if (remoteDefault && branches.includes(remoteDefault)) return remoteDefault;
  return branches.length === 1 ? branches[0] : null;
};

type BranchAttachmentResult = { branch: string } | { error: string };

/**
 * Attach a detached repo before its first auto-commit. A submodule freshly checked
 * out by `git submodule update` is normally detached, but committing there without a
 * branch leaves the new commit reachable only through the worktree's detached HEAD.
 * Create the repo's own default branch when it is absent. When an existing local
 * branch is a strict ancestor of detached HEAD, atomically fast-forward that ref and
 * attach it: `git submodule update` can legitimately advance the detached checkout
 * without moving the dormant local branch. Never move a branch backward or across
 * divergent history: that is evidence of work git-sync must not destroy.
 */
const ensureBranchAttachedForCommit = async (
  runGit: RunGit,
  repo: string,
  remote: string,
  defaultBranch: string,
  log: (m: string) => void,
): Promise<BranchAttachmentResult> => {
  const attached = await currentBranch(runGit, repo);
  if (attached) return { branch: attached };

  const remoteDefault = await remoteDefaultBranch(runGit, repo, remote);
  const exactRemoteBranches = await remoteBranchesPointingAtHead(runGit, repo, remote);
  const preservedRemoteBranch = preferredRemoteBranchAtHead(exactRemoteBranches, remoteDefault);
  const branch = preservedRemoteBranch ?? remoteDefault ?? defaultBranch;
  if (!branch) {
    return { error: `${repo}: detached HEAD has no branch target to attach before commit` };
  }
  if (preservedRemoteBranch && preservedRemoteBranch !== remoteDefault) {
    log(
      `[git-sync] ${repo}: detached HEAD is already preserved at ${remote}/${preservedRemoteBranch}; ` +
        `attaching that exact-tip branch instead of default '${remoteDefault ?? defaultBranch}'`,
    );
  }

  const head = await runGit(['rev-parse', 'HEAD'], repo);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !headSha) {
    return {
      error: `${repo}: cannot resolve detached HEAD before attaching '${branch}': ${(head.stderr || head.stdout).trim()}`,
    };
  }

  const localRef = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo);
  if (localRef.code === 0) {
    const localTip = await runGit(['rev-parse', `refs/heads/${branch}`], repo);
    const localSha = localTip.stdout.trim();
    if (localTip.code !== 0 || !localSha) {
      return { error: `${repo}: cannot resolve existing local branch '${branch}' before attaching` };
    }
    if (localSha !== headSha) {
      const ancestry = await runGit(['merge-base', '--is-ancestor', localSha, headSha], repo);
      if (ancestry.code === 0) {
        // Compare-and-swap the dormant branch ref. The expected-old argument is
        // load-bearing: if a peer moves the branch after our ancestry read, git
        // refuses instead of overwriting their new tip.
        const fastForward = await runGit(['update-ref', `refs/heads/${branch}`, headSha, localSha], repo);
        if (fastForward.code !== 0) {
          return {
            error:
              `${repo}: failed to fast-forward existing local branch '${branch}' from ` +
              `${localSha.slice(0, 12)} to detached HEAD ${headSha.slice(0, 12)}: ` +
              `${(fastForward.stderr || fastForward.stdout).trim()}`,
          };
        }
        log(
          `[git-sync] ${repo}: fast-forwarded dormant '${branch}' from ` +
            `${localSha.slice(0, 12)} to detached HEAD ${headSha.slice(0, 12)}`,
        );
      } else if (ancestry.code === 1) {
        return {
          error:
            `${repo}: refusing to attach detached HEAD to divergent local branch '${branch}' ` +
            `(local ${localSha.slice(0, 12)} cannot fast-forward to HEAD ${headSha.slice(0, 12)})`,
        };
      } else {
        return {
          error:
            `${repo}: cannot compare existing local branch '${branch}' with detached HEAD before attaching: ` +
            `${(ancestry.stderr || ancestry.stdout).trim()}`,
        };
      }
    }
    const attach = await recoverIndexLockContention(
      await runGit(['switch', branch], repo),
      () => runGit(['switch', branch], repo),
      runGit,
      repo,
      'git switch',
      log,
    );
    if (attach.code !== 0) {
      return {
        error: `${repo}: failed to attach detached HEAD to existing '${branch}': ${(attach.stderr || attach.stdout).trim()}`,
      };
    }
    log(`[git-sync] ${repo}: attached detached HEAD to existing '${branch}' at the same tip`);
    return { branch };
  }
  if (localRef.code !== 1) {
    return {
      error: `${repo}: could not determine whether local branch '${branch}' exists: ${(localRef.stderr || localRef.stdout).trim()}`,
    };
  }

  const create = await recoverIndexLockContention(
    await runGit(['switch', '--create', branch], repo),
    () => runGit(['switch', '--create', branch], repo),
    runGit,
    repo,
    'git switch --create',
    log,
  );
  if (create.code !== 0) {
    return {
      error: `${repo}: failed to create '${branch}' from detached HEAD: ${(create.stderr || create.stdout).trim()}`,
    };
  }
  log(`[git-sync] ${repo}: created and attached '${branch}' at detached HEAD`);
  return { branch };
};

const headSha = async (runGit: RunGit, repo: string): Promise<string> => {
  const r = await runGit(['rev-parse', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : '';
};

/** Newest commits kept per pass; more than this many group commits in one phase is not expected. */
const MAX_LANDED_COMMIT_SHAS = 100;

/**
 * Commits in `before..head`, oldest first (WI-6554700010019053). The commit phase
 * publishes one commit per attributed group, so several root commits can land in
 * one pass and each needs its own `git-sync:committed:<sha>` key. Empty when either
 * end is unknown or git fails: the head key still fires, so this only adds keys.
 */
const commitsSince = async (runGit: RunGit, repo: string, before: string, head: string): Promise<string[]> => {
  if (!before || !head || before === head) return [];
  const r = await runGit(['rev-list', '--reverse', `--max-count=${MAX_LANDED_COMMIT_SHAS}`, `${before}..${head}`], repo);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
};

const conflictedFiles = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], repo);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

type SeedSnapshotTransplant =
  | { status: 'not-seed' }
  | { status: 'transplanted'; backupRef: string; replayedCommits: number }
  | { status: 'error'; message: string };

/**
 * WI-37969 / WI-6824: a depth=1 installer seed is intentionally a synthetic,
 * one-commit ROOT history. After restore, `origin` is repointed at the real
 * repository, so the first fetch necessarily produces two unrelated histories.
 * Treating that as an ordinary merge wedges every seeded install before its P2P
 * legs (`fatal: refusing to merge unrelated histories`).
 *
 * The seed provider's contract has always been "restore offline, then replace the
 * snapshot with the fetched delta" (its integration test previously did a manual
 * `reset --hard FETCH_HEAD`). This is the production-safe form of that conversion:
 *
 *  - require BOTH the exact synthetic-root subject and the bundle clone's retained
 *    `origin/papercusp-seed-snapshot-*` ref pointing at that root; an arbitrary
 *    unrelated-history rewrite therefore stays a loud error;
 *  - create a recovery ref before changing history;
 *  - with no post-restore commits, adopt the fetched branch exactly;
 *  - otherwise rebase every post-restore commit onto the fetched branch, preserving
 *    local work. A conflict aborts cleanly and leaves the recovery ref + old branch
 *    intact; it never falls through to `--allow-unrelated-histories`.
 */
async function transplantInstallerSeedSnapshot(
  runGit: RunGit,
  repo: string,
  remoteRef: string,
  remote: string,
  log: (m: string) => void,
): Promise<SeedSnapshotTransplant> {
  const roots = await runGit(['rev-list', '--max-parents=0', 'HEAD'], repo);
  const rootShas = roots.code === 0 ? roots.stdout.trim().split('\n').filter(Boolean) : [];
  if (rootShas.length !== 1) return { status: 'not-seed' };
  const seedRoot = rootShas[0];

  const subject = await runGit(['show', '-s', '--format=%s', seedRoot], repo);
  if (subject.code !== 0 || !/^papercusp seed snapshot (?:HEAD|[0-9a-f]{7,64})$/.test(subject.stdout.trim())) {
    return { status: 'not-seed' };
  }

  const snapshotRefs = await runGit(
    ['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/${SEED_SNAPSHOT_REF_PREFIX}*`],
    repo,
  );
  if (snapshotRefs.code !== 0 || !snapshotRefs.stdout.split('\n').some((sha) => sha.trim() === seedRoot)) {
    return { status: 'not-seed' };
  }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], repo);
  if (head.code !== 0 || !head.stdout.trim()) {
    return { status: 'error', message: 'seed snapshot transplant could not resolve HEAD' };
  }
  const originalHead = head.stdout.trim();
  const count = await runGit(['rev-list', '--count', `${seedRoot}..HEAD`], repo);
  if (count.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not enumerate post-restore commits: ${count.stderr.trim() || count.stdout.trim()}`,
    };
  }
  const replayedCommits = Number.parseInt(count.stdout.trim(), 10) || 0;
  const backupRef = `refs/papercusp/seed-recovery/${originalHead}`;
  const backup = await runGit(['update-ref', backupRef, originalHead], repo);
  if (backup.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not create recovery ref ${backupRef}: ${backup.stderr.trim() || backup.stdout.trim()}`,
    };
  }

  if (replayedCommits === 0) {
    // WI-10004413: `reset --hard` writes the index, so route it through the shared
    // stale-lock recovery like every other index writer in this file.
    const adoptArgs = ['reset', '--hard', remoteRef];
    const adopt = await recoverIndexLockContention(
      await runGit(adoptArgs, repo),
      () => runGit(adoptArgs, repo),
      runGit,
      repo,
      'git reset --hard (seed snapshot adopt)',
      log,
    );
    if (adopt.code !== 0) {
      return {
        status: 'error',
        message: `seed snapshot transplant could not adopt ${remoteRef} (recovery ref ${backupRef}): ${adopt.stderr.trim() || adopt.stdout.trim()}`,
      };
    }
  } else {
    const replay = await runGit(['rebase', '--rebase-merges', '--onto', remoteRef, seedRoot], repo);
    if (replay.code !== 0) {
      const replayOut = `${replay.stdout}\n${replay.stderr}`.trim();
      await runGit(['rebase', '--abort'], repo);
      return {
        status: 'error',
        message: `seed snapshot transplant could not replay ${replayedCommits} post-restore commit(s) onto ${remoteRef} (aborted clean; recovery ref ${backupRef}): ${replayOut.slice(0, 300)}`,
      };
    }
  }

  const related = await runGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], repo);
  if (related.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant did not produce a descendant of ${remoteRef} (recovery ref ${backupRef})`,
    };
  }
  log(
    `[git-sync] ${repo}: converted installer seed snapshot ${seedRoot.slice(0, 12)} to ${remoteRef}; ` +
      `${replayedCommits === 0 ? 'no post-restore commits' : `replayed ${replayedCommits} post-restore commit(s)`}; recovery ref ${backupRef}`,
  );
  return { status: 'transplanted', backupRef, replayedCommits };
}

/** WI-6824: a merge that fails with ZERO conflicted paths is classified `error`, and that
 *  message is the ONLY record of it — git-sync NULLs `last_error` on the next healthy tick,
 *  so an INTERMITTENT failure leaves nothing to correlate against afterwards (a fault that
 *  alarmed the fleet for ~10h across 39 sweeps left zero occurrences in 12h of journald, and
 *  was consequently not reproducible from any on-disk state).
 *
 *  Resolve the ref pair the merge ACTUALLY used, so the next flap identifies which pair was
 *  unrelated instead of being unfixable-by-inspection. `merge-base` is the discriminator:
 *  it exits non-zero with no output exactly when the histories are unrelated, which is the
 *  reported failure. `git-dir` + `url` are here because the cheapest way to get a genuine
 *  unrelated-history refusal between two healthy repos is to resolve the WRONG repository —
 *  a stale submodule git-dir path (libs/generic/chat-protocol still resolves its git-dir
 *  through the pre-move `.git/modules/libs/chat-protocol`) would present exactly this way,
 *  and no amount of after-the-fact inspection of the intended repo can distinguish it. */
const describeFailedMerge = async (
  runGit: RunGit,
  repo: string,
  remote: string,
  branch: string,
  attempt: 'initial' | 'non-ff-retry',
): Promise<string> => {
  const read = async (args: string[]): Promise<string> => {
    const r = await runGit(args, repo);
    const out = r.stdout.trim();
    return r.code === 0 && out ? out : '<none>';
  };
  const remoteRef = `${remote}/${branch}`;
  const head = await read(['rev-parse', '--short', 'HEAD']);
  const remoteSha = await read(['rev-parse', '--short', '--verify', remoteRef]);
  // exits 1 with empty stdout when there is NO common ancestor — i.e. the refusal itself.
  const rawBase = await read(['merge-base', 'HEAD', remoteRef]);
  const base = rawBase === '<none>' ? 'NONE(unrelated)' : rawBase.slice(0, 12);
  const gitDir = await read(['rev-parse', '--absolute-git-dir']);
  const url = await read(['config', '--get', `remote.${remote}.url`]);
  return `attempt=${attempt} HEAD=${head} ${remoteRef}=${remoteSha} merge-base=${base} git-dir=${gitDir} url=${url}`;
};

// Exported for the non-FF detection table test (test-coverage-gap G21): a git
// wording change must fail a test, not silently turn retriable rejections into
// hard escalations.
export function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/** A non-zero `git commit` that simply had nothing staged (e.g. every dirty file was
 *  excluded as oversized) — benign, NOT a real commit failure. Anything else (index.lock
 *  race, corrupt index, hook abort) IS a failure we must surface (P-002). */
function nothingToCommit(r: { stdout: string; stderr: string }): boolean {
  return /nothing to commit|no changes added to commit|nothing added to commit/i.test(`${r.stdout}\n${r.stderr}`);
}

/** Repo-relative paths that made `git add` FATAL because they are embedded git repos with no
 *  commit ("error: '<path>' does not have a commit checked out"). Extracted so git-sync can
 *  EXCLUDE them + retry rather than silently stranding the WHOLE tree (2026-06-30 root cause:
 *  one nested no-commit .git under .papercusp/.vitest-tmpdir fatal-ed `git add -A`, so nothing
 *  committed for ~7h). Exported for unit testing. */
export function addFailureStrayPaths(output: string): string[] {
  const out: string[] = [];
  const re = /error: '([^']+)' does not have a commit checked out/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out.push(m[1].replace(/\/+$/, '')); // git prints a trailing slash for a dir; pathspec wants it clean
  }
  return [...new Set(out)];
}

/** Protected paths that made `git add` fatal because they are already ignored.
 *
 * `git add -A -- . :(exclude,literal)<path>` normally lets a live editor keep a
 * dirty path out of git-sync's catch-all commit. Git still treats that negative
 * pathspec as an explicit mention, though, and refuses the whole add when the path
 * is ignored (for example a transient nested `package-lock.json`). The ignore rule
 * already protects the file, so the safe retry is to omit ONLY that redundant
 * exclusion pathspec — never `-f` the ignored artifact into the commit.
 */
export function addFailureIgnoredPaths(output: string): string[] {
  const match = output.match(
    /The following paths are ignored by one of your \.gitignore files:\s*\n([\s\S]*?)(?:\nhint:|$)/i,
  );
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean),
    ),
  ];
}

/** Protected exclusion pathspecs made redundant by an ignored-path add failure.
 *
 * Git may report the ignored directory ancestor rather than each explicitly
 * mentioned descendant (for example `apps/shop/.astro` for protected files
 * beneath that directory). Map that report back to only the exact protected
 * path or its descendants; unrelated protections must stay in the retry.
 */
export function ignoredProtectedExclusions(output: string, excludePaths: readonly string[]): string[] {
  const ignoredPaths = addFailureIgnoredPaths(output)
    .map((path) => path.replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  return excludePaths.filter((excludePath) => {
    const normalizedExclude = excludePath.replace(/^\.\/+/, '').replace(/\/+$/, '');
    return ignoredPaths.some(
      (ignoredPath) => normalizedExclude === ignoredPath || normalizedExclude.startsWith(`${ignoredPath}/`),
    );
  });
}

/** The stable fatal emitted when a pathspec tries to traverse a symlink.
 * Exported so a Git wording change fails a focused test instead of silently
 * disabling the protected-path preflight. */
export function isPathspecBeyondSymbolicLinkFailure(output: string): boolean {
  return /fatal:\s+pathspec .* is beyond a symbolic link/i.test(output);
}

/**
 * WI-6554700010018683: the stable fatal Git emits when a pathspec names a path
 * INSIDE a submodule (`fatal: Pathspec '<spec>' is in submodule '<sub>'`), from
 * `check-ignore` and from `add` alike. A superproject `add -A` never stages a
 * submodule's own files (only its gitlink), so such an exclusion is redundant
 * there, but Git rejects the whole command for it and the tick stages nothing.
 * Exported so a Git wording change fails a focused test.
 */
export function isPathspecInSubmoduleFailure(output: string): boolean {
  return /fatal:\s+pathspec .* is in submodule/i.test(output);
}

/**
 * The exclusion paths an `add` failure proves redundant because they lie strictly
 * inside a submodule Git named. Git reports only the FIRST offending pathspec, so
 * every exclusion under that same submodule is returned at once; a later retry
 * catches any other submodule. The gitlink path itself stays excluded: that
 * pathspec is valid and protects a held pointer bump.
 */
export function inSubmoduleProtectedExclusions(output: string, excludePaths: readonly string[]): string[] {
  const submodules = new Set<string>();
  for (const match of output.matchAll(/fatal:\s+pathspec '.*?' is in submodule '([^']+)'/gi)) {
    const submodule = match[1].replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (submodule) submodules.add(submodule);
  }
  if (submodules.size === 0) return [];
  return excludePaths.filter((excludePath) => {
    const normalized = excludePath.replace(/^\.\/+/, '').replace(/\/+$/, '');
    return [...submodules].some((submodule) => normalized.startsWith(`${submodule}/`));
  });
}

export type ProtectedPathExclusionPreflight = {
  ignoredUntracked: Set<string>;
  beyondSymlink: Set<string>;
  /** WI-6554700010018683: paths inside a submodule; redundant and fatal as exclusions here. */
  inSubmodule: Set<string>;
};

/**
 * Classify protected paths that cannot safely appear as negative pathspecs.
 *
 * `git check-ignore` intentionally does not report tracked paths unless
 * `--no-index` is supplied. That default is load-bearing here: a tracked file
 * may still be covered by a later ignore rule, but its exclusion pathspec must
 * remain in the staging command so git-sync does not commit the protected
 * mutation. Conversely, an ignored untracked path is already excluded by Git's
 * normal ignore handling; passing it as a negative pathspec makes `git add`
 * reject the entire command.
 *
 * WI-6554700010010584: BATCH every path Git echoes back verbatim, via
 * checkIgnoreVerbatimBatches (check-ignore-argv.ts, which documents the argv-mode
 * quoting rules and why `-z` cannot be used). Each Git call pays bg-host's
 * admission queue (measured 10-24s per `check-ignore` under load), and this
 * preflight runs inside the superproject pointer-bump phase. One call per path
 * (8 at a time) turned ~40 live locks into ~6 sequential rounds: papercusp's commit
 * phase ran 5+ minutes on 2026-10-12 and portal's 2+ minutes on 2026-10-13,
 * outlasting every restart drain that landed in it. Names Git would C-quote keep
 * the one-path probe, where the exit status is the answer.
 *
 * Exit code 1 means "not ignored". Git exits 128 when a protected path is a
 * descendant of a symlink; `git add -A` does not traverse that symlink, but the
 * explicit negative pathspec makes the entire add fatal, so classify that
 * population separately and omit only those impossible pathspecs. A 128 fails a
 * whole batch, so that batch (and any batch whose answer does not map back) is
 * re-probed one path at a time. `--` keeps leading dashes literal. Any other
 * non-zero per-path result fails open by returning no matches and preserving all
 * exclusions for the existing add-failure recovery path.
 */
export async function classifyProtectedPathExclusions(
  runGit: RunGit,
  repoPath: string,
  paths: readonly string[],
): Promise<ProtectedPathExclusionPreflight> {
  const beyondSymlink = new Set<string>();
  const inSubmodule = new Set<string>();
  const { ignored: ignoredUntracked, unresolved: singles } = await checkIgnoreVerbatimBatches(runGit, repoPath, paths);
  // Bound concurrency instead of serializing one git process per remaining path.
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(8, singles.length) }, async () => {
      while (!failed && next < singles.length) {
        const path = singles[next++];
        const result = await runGit(['check-ignore', '--', path], repoPath);
        if (result.code === 0) ignoredUntracked.add(path);
        else if (result.code === 1) continue;
        else if (isPathspecBeyondSymbolicLinkFailure(`${result.stdout}\n${result.stderr}`)) beyondSymlink.add(path);
        else if (isPathspecInSubmoduleFailure(`${result.stdout}\n${result.stderr}`)) inSubmodule.add(path);
        else failed = true;
      }
    }),
  );
  if (failed) {
    return { ignoredUntracked: new Set<string>(), beyondSymlink: new Set<string>(), inSubmodule: new Set<string>() };
  }
  return { ignoredUntracked, beyondSymlink, inSubmodule };
}

/** The `git add`/`git commit` fatal for a held index lock. Git emits both quoted
 *  relative paths and unquoted absolute paths (the latter was recorded by the
 *  bg-host on 2026-10-25); both must reach the retry and stale-lock recovery
 *  below. Exported for unit testing so wording drift cannot silently disable it. */
export function isIndexLockFailure(output: string): boolean {
  return /Unable to create (?:'[^']*index\.lock'|[^\r\n]*?index\.lock): File exists/i.test(output);
}

/** The `git submodule sync` fatal for a held repository config lock. Git names
 * the destination config file in the error even though the sentinel on disk is
 * its `.lock` sibling. Exported so wording drift fails a focused test. */
export function isConfigLockFailure(output: string): boolean {
  return /could not lock config file [^\r\n]*[/\\]config: File exists/i.test(output);
}

/** The `git add -A` fatal for a path that vanished between git's tree-walk
 *  enumeration and its stat call ("fatal: unable to stat '<path>': No such file or
 *  directory") — a benign race with ANY process in this heavily-concurrent fleet
 *  that writes atomically (write `<file>.tmp.<pid>.<hash>` sibling, then
 *  rename/remove over the real file): git enumerates the tmp sibling right before
 *  the writer renames/removes it, so the subsequent stat 404s even though the file
 *  legitimately existed a moment earlier. The window is a handful of milliseconds
 *  wide (EI-18094449017685490), so a bounded immediate retry resolves it instead of
 *  stranding the whole tick's commit on one transient, already-gone path. Exported
 *  for unit testing (a git wording change must fail a test, not silently disable
 *  the retry below). */
export function isTransientStatFailure(output: string): boolean {
  return /fatal: unable to stat '[^']*': No such file or directory/i.test(output);
}

/** Bounded retry budget for {@link isTransientStatFailure} — the race window is a
 *  few ms wide (one process's write-tmp+rename), so this is generous, not a
 *  long-poll. Exported so the unit test doesn't hardcode a magic number twice. */
export const TRANSIENT_STAT_FAILURE_MAX_RETRIES = 3;
const TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS = 150;

/** A live git writer can hold `.git/index.lock` only briefly while it replaces the
 * index. Retry that specific contention before surfacing an error, but keep the
 * budget small so a genuinely wedged writer still reaches the stale-lock guard. */
export const INDEX_LOCK_CONTENTION_MAX_RETRIES = 3;
export const INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** `git submodule sync` writes repository config through `.git/config.lock`, so
 * it can race the same short-lived local git writers as the index path above.
 * Keep the retry budget deliberately small: a live writer normally releases in
 * milliseconds, while a persistent lock still reaches the stale-lock guard and
 * the loud error path in this same tick. */
export const CONFIG_LOCK_CONTENTION_MAX_RETRIES = 3;
export const CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** A lock YOUNGER than this is treated as live contention (git rewrites the lock
 *  file as it builds the new index, so an in-flight writer keeps the mtime fresh);
 *  older = the writer is dead and the lock is an orphan. git-sync ticks run ~2min
 *  apart, so a real writer is never this old between ticks. */
export const STALE_INDEX_LOCK_MS = 90_000;

/**
 * STALE-LOCK SELF-HEAL (2026-07-04): a git process killed mid-`add -A` leaves
 * `.git/index.lock` behind, and every subsequent tick then fails with the same
 * "File exists" fatal — FOREVER, until a human deletes the file (observed live:
 * 3 consecutive failed ticks + a fleet-wide alert for a 6.8MB orphaned lock).
 * This clears the lock ONLY when it is provably stale (mtime older than
 * `staleMs` — an active writer keeps it fresh), so a live racing git process is
 * never robbed of its lock; a fresh-lock failure stays an error and the NEXT
 * tick (by which time the orphan has aged past the threshold) heals it. Resolves
 * the git dir via `rev-parse --absolute-git-dir` so submodules (whose `.git` is
 * a file, not a dir) work too. Returns true when the caller should retry.
 */
/**
 * Does any live process on this host still hold `lockPath` open? Uses the
 * targeted native Linux check first, falling back to `/proc` when unavailable;
 * hosts without /proc (macOS) use `lsof` (WI-10003529). Fails CLOSED when
 * neither instrument can answer: `true` = "assume held", because
 * a wrongly-kept orphan costs one more failed tick (the next tick re-checks)
 * while a wrongly-unlinked live lock truncates the index (EI-22703121889295786).
 */
export interface LockHolderProbe {
  held: boolean;
  source: 'fuser' | 'proc' | 'lsof' | 'unknown' | 'injected';
  verdict: 'held' | 'absent' | 'unknown';
}

export async function probeLockHolder(
  lockPath: string,
  deps: {
    platform?: NodeJS.Platform;
    targetedHolder?: (p: string) => Promise<boolean | null | 'unavailable'>;
    procHolder?: (p: string) => Promise<boolean | null>;
    lsofHolder?: (p: string) => Promise<boolean | null>;
  } = {},
): Promise<LockHolderProbe> {
  // EI-26694305758493084: reuse the native check already used by index repair.
  // A timed-out native check is unknown, not a reason to repeat the expensive
  // whole-host scan. Only a missing instrument uses the existing fallback.
  // An injected procHolder retains the historical hermetic test seam unless
  // the caller explicitly supplies a targeted check as well.
  const targetedHolder = deps.targetedHolder ?? (deps.procHolder ? undefined : fuserSeesOpenFile);
  if ((deps.platform ?? process.platform) === 'linux' && targetedHolder) {
    const targeted = await targetedHolder(lockPath);
    if (targeted !== 'unavailable') {
      return {
        held: targeted !== false,
        source: 'fuser',
        verdict: targeted === null ? 'unknown' : targeted ? 'held' : 'absent',
      };
    }
  }
  const viaProc = await (deps.procHolder ?? procLockHolder)(lockPath);
  if (viaProc !== null) {
    return { held: viaProc, source: 'proc', verdict: viaProc ? 'held' : 'absent' };
  }
  // WI-10003529: no /proc (macOS). Before this fallback the function returned
  // `true` here unconditionally, so on a Mac a lock orphaned by a restart was
  // never reclaimed and every later git-sync tick failed until a human deleted
  // it (P-203 Mac VM, 2026-09-27: two locks aged 50-70 min, lsof proved no holder).
  const viaLsof = await (deps.lsofHolder ?? lsofLockHolder)(lockPath);
  if (viaLsof !== null) {
    return { held: viaLsof, source: 'lsof', verdict: viaLsof ? 'held' : 'absent' };
  }
  return { held: true, source: 'unknown', verdict: 'unknown' };
}

/** Backward-compatible boolean seam; use probeLockHolder when the journal needs the reason. */
export async function lockHasLiveHolder(
  lockPath: string,
  deps: Parameters<typeof probeLockHolder>[1] = {},
): Promise<boolean> {
  return (await probeLockHolder(lockPath, deps)).held;
}

/** WI-10003529: ask `lsof` whether any process holds `lockPath` open.
 *  true = held, false = PROVEN not held (rc 1, no output at all), null = the
 *  instrument could not answer (binary missing, timeout, any stderr), which the
 *  caller treats as held. `-w` silences lsof's unrelated stat() warnings, which
 *  would otherwise turn every Mac answer into `null`. */
export async function lsofLockHolder(
  lockPath: string,
  run: (bin: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> = runLsof,
): Promise<boolean | null> {
  for (const bin of ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof']) {
    const r = await run(bin, ['-t', '-w', '--', lockPath]);
    if (r.missing) continue;
    if (r.code === 0 && /^\d+$/m.test(r.stdout)) return true;
    if (r.code === 1 && r.stdout.trim() === '' && r.stderr.trim() === '') return false;
    return null;
  }
  return null;
}

function runLsof(
  bin: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { code: number | null; stdout: string; stderr: string; missing?: boolean }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Boundary-safe decoding (WI-6728): lsof prints paths, which may be non-ASCII.
    const out = collectChildOutput(child);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout: out.stdout.text(), stderr: out.stderr.text() || 'lsof timed out' });
    }, 10_000);
    child.on('error', (e: NodeJS.ErrnoException) =>
      done({ code: null, stdout: out.stdout.text(), stderr: String(e.message), missing: e.code === 'ENOENT' }),
    );
    child.on('close', (code) => done({ code, stdout: out.stdout.text(), stderr: out.stderr.text() }));
  });
}

/** Linux: scan `/proc/<pid>/fd/*` for a descriptor resolving to `lockPath`.
 *  null = no usable /proc on this host, or the bounded scan ran out of time
 *  (the caller falls back to lsof, then assumes held). Parallel and
 *  deadline-bounded since WI-10006519: the old serial walk took ~10 min inside
 *  the busy bg-host while an orphaned lock froze every papercusp commit. */
export async function procLockHolder(
  lockPath: string,
  opts: Parameters<typeof scanProcForOpenFile>[1] = {},
): Promise<boolean | null> {
  return (await scanProcForOpenFile((target) => target === lockPath, opts)).held;
}

interface GitLockSnapshot {
  mtimeMs: number;
  size: number;
  dev?: number;
  ino?: number;
}

async function inspectGitLockFile(p: string): Promise<GitLockSnapshot | null> {
  try {
    const st = await lstat(p);
    return { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameGitLockFile(a: GitLockSnapshot, b: GitLockSnapshot): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.dev === b.dev && a.ino === b.ino;
}

/** A holder check slower than this is logged as SLOW, so a stall in the scan
 *  is visible in the journal instead of looking like a silent ~10-minute gap. */
export const SLOW_LOCK_HOLDER_CHECK_MS = 10_000;

async function clearStaleGitLock(
  runGit: RunGit,
  repoPath: string,
  lockName: 'index.lock' | 'config.lock',
  log: (m: string) => void,
  deps: {
    /** lstat-shaped identity of the lock file; null = it does not exist. */
    inspectLock?: (p: string) => Promise<GitLockSnapshot | null>;
    unlinkFile?: (p: string) => Promise<void>;
    now?: () => number;
    staleMs?: number;
    /** Structured holder verdict, including an inconclusive fail-closed probe. */
    probeHolder?: (lockPath: string) => Promise<LockHolderProbe>;
    /** LIVE-HOLDER GUARD (EI-22703121889295786): mtime alone is NOT proof the
     *  writer is dead — a `git add -A` walking a multi-MB tree can hold
     *  `index.lock` open for >90s without touching its mtime, and unlinking it
     *  under a live writer is exactly how the canonical index was truncated to
     *  0 bytes. Returns true when some live process still has the lock open. */
    hasLiveHolder?: (lockPath: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const inspectLock = deps.inspectLock ?? inspectGitLockFile;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), lockName);
  const before = await inspectLock(lockPath);
  if (before === null) return true; // already gone (holder finished/cleaned up) — just retry
  const ageMs = now() - before.mtimeMs;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it; this tick fails and the next one self-heals if the writer died`,
    );
    return false;
  }
  const holderCheckStarted = now();
  let holderProbe: LockHolderProbe;
  if (deps.probeHolder) {
    holderProbe = await deps.probeHolder(lockPath);
  } else if (deps.hasLiveHolder) {
    const held = await deps.hasLiveHolder(lockPath);
    holderProbe = { held, source: 'injected', verdict: held ? 'held' : 'absent' };
  } else {
    holderProbe = await probeLockHolder(lockPath);
  }
  const holderCheckMs = now() - holderCheckStarted;
  const holderCheck = `holder check ${(holderCheckMs / 1000).toFixed(1)}s${holderCheckMs >= SLOW_LOCK_HOLDER_CHECK_MS ? ' — SLOW (WI-10006519)' : ''}`;
  if (holderProbe.verdict === 'unknown') {
    log(
      `[git-sync] ${repoPath}: ${lockName} is ${Math.round(ageMs / 1000)}s old; holder probe UNKNOWN — fail-closed stale-lock guard preserved the lock (holder inspection inconclusive; ${holderCheck})`,
    );
    return false;
  }
  if (holderProbe.held) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is ${Math.round(ageMs / 1000)}s old but a LIVE process still holds it open — FRESH-BY-HOLDER, not touching it (unlinking under a live writer truncates the index; EI-22703121889295786; ${holderCheck})`,
    );
    return false;
  }
  // CHECK-THEN-ACT GUARD (WI-10006519): the holder check can take seconds or more,
  // and the orphan we aged can be removed and replaced by a DIFFERENT writer's
  // fresh lock in that window. Unlink only the exact file we judged.
  const after = await inspectLock(lockPath);
  if (after === null) return true; // removed during the holder check — just retry
  if (!sameGitLockFile(before, after)) {
    log(
      `[git-sync] ${repoPath}: ${lockName} CHANGED during the ${holderCheck} (was ${before.size}B ino ${before.ino ?? '?'}, now ${after.size}B ino ${after.ino ?? '?'}) — another writer's lock, not touching it`,
    );
    return false;
  }
  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale ${lockName}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE ${lockName} (${Math.round(ageMs / 1000)}s old — its writer is dead; ${holderCheck}) and retrying (previously: every tick failed until a human removed it)`,
  );
  return true;
}

export async function clearStaleIndexLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: Parameters<typeof clearStaleGitLock>[4] = {},
): Promise<boolean> {
  return clearStaleGitLock(runGit, repoPath, 'index.lock', log, deps);
}

type GitCommandResult = Awaited<ReturnType<RunGit>>;

/**
 * Apply the same bounded live-contention + stale-orphan recovery to every Git
 * operation that writes the index. `git add` already used this policy; keeping
 * it here also covers the immediately-following `git commit`, which can lose a
 * fresh index.lock race to a different writer after staging succeeded.
 */
async function recoverIndexLockContention(
  initial: GitCommandResult,
  runAttempt: () => Promise<GitCommandResult>,
  runGit: RunGit,
  repoPath: string,
  operation: string,
  log: (m: string) => void,
): Promise<GitCommandResult> {
  let result = initial;
  if (result.code === 0 || !isIndexLockFailure(`${result.stdout}\n${result.stderr}`)) return result;

  const cleared = await clearStaleIndexLock(runGit, repoPath, log);
  if (cleared) result = await runAttempt();

  for (
    let attempt = 1;
    result.code !== 0 &&
    isIndexLockFailure(`${result.stdout}\n${result.stderr}`) &&
    attempt <= INDEX_LOCK_CONTENTION_MAX_RETRIES;
    attempt++
  ) {
    const delayMs = INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    log(
      `[git-sync] ${repoPath}: '${operation}' hit live index.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${INDEX_LOCK_CONTENTION_MAX_RETRIES})`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await runAttempt();
  }

  // A live holder can die during the bounded retries. Re-run the age-checked
  // orphan guard once more; it never removes a still-fresh writer's lock.
  if (result.code !== 0 && isIndexLockFailure(`${result.stdout}\n${result.stderr}`)) {
    const clearedAfterRetry = await clearStaleIndexLock(runGit, repoPath, log);
    if (clearedAfterRetry) result = await runAttempt();
  }
  return result;
}

interface ClearStaleConfigLockDeps {
  inspectLock?: (p: string) => Promise<GitLockSnapshot | null>;
  isOpen?: (p: string) => Promise<boolean | null>;
  unlinkFile?: (p: string) => Promise<void>;
  now?: () => number;
  staleMs?: number;
}

/** Clear an orphaned empty Git metadata lock left by a dead writer (including
 * a sandbox mount-point artifact). These metadata locks are more sensitive than
 * the replaceable index: age alone is insufficient evidence. Delete only a
 * zero-byte lock that is old, has no open descriptor, and has not changed during
 * inspection. */
export async function clearStaleHolderlessEmptyGitLock(
  runGit: RunGit,
  repoPath: string,
  lockName: 'config.lock' | 'shallow.lock' | 'objects/maintenance.lock',
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  const inspectLock = deps.inspectLock ?? inspectGitLockFile;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;

  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), lockName);
  const before = await inspectLock(lockPath);
  if (before === null) return true;

  const ageMs = now() - before.mtimeMs;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it`,
    );
    return false;
  }
  if (before.size !== 0) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is old but NONEMPTY (${before.size} bytes) — cannot prove it is an orphan, not touching it`,
    );
    return false;
  }

  const open = await isOpen(lockPath);
  if (open !== false) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is old and empty but ${open ? 'still OPEN' : 'holder state is UNKNOWN'} — not touching it`,
    );
    return false;
  }

  // Close the inspection-to-unlink race enough to catch replacement or a writer
  // touching the sentinel while the descriptor scan ran. A changed file is no
  // longer the empty orphan we proved above, so leave it for the next tick.
  const after = await inspectLock(lockPath);
  if (after === null) return true;
  if (!sameGitLockFile(before, after)) {
    log(`[git-sync] ${repoPath}: ${lockName} changed during orphan inspection — not touching it`);
    return false;
  }

  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale ${lockName}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE empty holderless ${lockName} (${Math.round(ageMs / 1000)}s old) and retrying`,
  );
  return true;
}

/** Clear an orphaned `.git/config.lock` left by a dead config writer. */
export async function clearStaleConfigLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  return clearStaleHolderlessEmptyGitLock(runGit, repoPath, 'config.lock', log, deps);
}

/** Age floor before an orphaned `objects/maintenance.lock` may be reclaimed.
 * A live `git maintenance run` keeps the lock's descriptor open, so the
 * holderless proof already protects it; the long floor is belt-and-braces. */
export const STALE_MAINTENANCE_LOCK_MS = 60 * 60_000;

/** Clear an orphaned `objects/maintenance.lock` (WI-6554700010018201).
 *
 * Git spawns `git maintenance run --auto` after a commit, so it runs as a child
 * of git-sync's own commit. A SIGKILL (a cgroup kill or session death) skips
 * git's lockfile cleanup and strands a zero-byte lock. Git 2.43 then skips
 * every later auto-maintenance run SILENTLY (no warning under `--auto`), so
 * auto-gc stays off for the repo and every worktree sharing its object store.
 * Observed: a 5-day-old lock with 31k loose objects. Same empty + old +
 * holderless + unchanged proof as `config.lock`. */
export async function clearStaleMaintenanceLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  return clearStaleHolderlessEmptyGitLock(runGit, repoPath, 'objects/maintenance.lock', log, {
    staleMs: STALE_MAINTENANCE_LOCK_MS,
    ...deps,
  });
}

/** A crash-left `index-pack` file is safe to consider only after this age floor. */
export const STALE_TEMP_PACK_MS = 30 * 60_000;

type TempPackEntry = { name: string; size: number; mtimeMs: number; nlink: number };

async function gitDirForRepo(runGit: RunGit, repoPath: string): Promise<string> {
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  return gd.code === 0 ? gd.stdout.trim() : '';
}

const ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT = 20;

/**
 * A canonical loose object lives at `objects/<2 hex>/<38 hex>`. Git writes it
 * through a temporary file and atomically renames the completed payload, so a
 * regular zero-byte file at that final name is corruption, never an in-flight
 * writer. Detect it before fetch: otherwise Git's `bad object HEAD`/mmap error
 * is flattened into the generic "fetch failed; HEAD has unpushed commits"
 * branch and the same checkout can fail silently for dozens of routine ticks.
 *
 * Detection is deliberately non-destructive. The object may be a local-only
 * commit that no remote can restore, so automatic deletion would destroy the
 * only remaining identity needed for reflog/working-tree recovery.
 */
async function findZeroByteLooseObjects(runGit: RunGit, repoPath: string): Promise<string[]> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return [];
  let fanouts: string[];
  try {
    fanouts = await readdir(join(gitDir, 'objects'));
  } catch {
    return [];
  }

  const corrupt: string[] = [];
  for (const fanout of fanouts.sort()) {
    if (!/^[0-9a-f]{2}$/i.test(fanout)) continue;
    let names: string[];
    try {
      names = await readdir(join(gitDir, 'objects', fanout));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{38}$/i.test(name)) continue;
      try {
        const st = await lstat(join(gitDir, 'objects', fanout, name));
        if (st.isFile() && st.size === 0) corrupt.push(`${fanout}${name}`.toLowerCase());
      } catch {
        // A concurrent maintenance process may remove or repack the object.
      }
      if (corrupt.length >= ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT) return corrupt;
    }
  }
  return corrupt;
}

async function listTempPackEntries(
  runGit: RunGit,
  repoPath: string,
): Promise<{ gitDir: string; entries: TempPackEntry[] }> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return { gitDir: '', entries: [] };
  let names: string[];
  try {
    names = await readdir(join(gitDir, 'objects', 'pack'));
  } catch {
    return { gitDir, entries: [] };
  }
  const entries: TempPackEntry[] = [];
  for (const name of names) {
    if (!/^tmp_pack_[^/]+$/.test(name)) continue;
    try {
      const st = await lstat(join(gitDir, 'objects', 'pack', name));
      if (st.isFile()) entries.push({ name, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink });
    } catch {
      // A concurrent fetch may have finalized or removed the temp file.
    }
  }
  return { gitDir, entries };
}

/**
 * A failed `git fetch` can leave `index-pack`'s incoming pack at
 * `.git/objects/pack/tmp_pack_*`. The temp name is deliberately not a valid
 * reachable pack ref; Git only renames it after the pack is complete. Snapshot
 * the names before fetch and remove ONLY new regular files after a failed fetch.
 * This avoids deleting an older leak (or a peer's pre-existing temp pack) while
 * reclaiming a large partial pack immediately instead of waiting for age-based GC.
 */
export async function listTempPackFiles(runGit: RunGit, repoPath: string): Promise<Map<string, number>> {
  const { entries } = await listTempPackEntries(runGit, repoPath);
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry.name, entry.size);
  return result;
}

/**
 * `tmp_pack_*` has no Git index and therefore cannot be reached by a ref while it
 * retains its temporary name. Keep the additional checks explicit: an index/keep
 * sidecar, an advertised pack entry, or a hard link means another Git process may
 * have made the file reachable, so the scavenger must leave it alone.
 */
async function tempPackHasReferences(gitDir: string, entry: TempPackEntry): Promise<boolean> {
  if (entry.nlink > 1) return true;
  const packPath = join(gitDir, 'objects', 'pack', entry.name);
  for (const suffix of ['.idx', '.keep']) {
    try {
      await lstat(`${packPath}${suffix}`);
      return true;
    } catch {
      // No sidecar — keep checking the other proof surfaces.
    }
  }
  try {
    const advertised = await readFile(join(gitDir, 'objects', 'info', 'packs'), 'utf8');
    if (advertised.split('\n').some((line) => line.includes(entry.name))) return true;
  } catch {
    // `objects/info/packs` is optional; absence is not evidence of a reference.
  }
  return false;
}

/** Return true when `/proc` proves a descriptor currently names the candidate. */
async function procSeesOpenFile(path: string): Promise<boolean | null> {
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) return null;
  // Same bounded parallel scanner as procLockHolder (WI-10006519); past its
  // deadline the answer is null, which every caller treats as "keep the file".
  const deleted = `${canonical} (deleted)`;
  return (await scanProcForOpenFile((target) => target === canonical || target === deleted)).held;
}

/** macOS has no `/proc`; `lsof` is part of the base system and is read-only here. */
async function lsofSeesOpenFile(path: string): Promise<boolean | null> {
  return await new Promise<boolean | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('lsof', ['-t', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout = collectChildOutput(child).stdout;
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 && stdout.text().trim().length > 0));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 1000);
    timer.unref?.();
  });
}

/** A targeted native Linux descriptor check. A serial JS walk over every
 * /proc/<pid>/fd took 34s for the two index proofs on this host, and turned
 * the real-git repair guard into a 60s test timeout. fuser checks the same
 * target in one process; errors and timeouts remain unknown (fail closed).
 * A host without fuser retains the existing /proc fallback. */
async function fuserSeesOpenFile(path: string): Promise<boolean | null | 'unavailable'> {
  return await new Promise<boolean | null | 'unavailable'>((resolve) => {
    let settled = false;
    let sawStderr = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | null | 'unavailable'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('fuser', ['-s', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk) => {
      if (String(chunk).trim()) sawStderr = true;
    });
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' ? 'unavailable' : null));
    child.once('close', (code) => finish(code === 0 ? true : code === 1 && !sawStderr ? false : null));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 12_000);
    timer.unref?.();
  });
}

async function defaultOpenFileCheck(path: string): Promise<boolean | null> {
  if (process.platform === 'linux') {
    const targeted = await fuserSeesOpenFile(path);
    return targeted === 'unavailable' ? await procSeesOpenFile(path) : targeted;
  }
  if (process.platform === 'darwin') return lsofSeesOpenFile(path);
  return null;
}

/**
 * The minimum byte length of a Git index with its fixed header and SHA-1
 * checksum. Git's index starts with a 12-byte `DIRC` header and ends with a
 * 20-byte repository-hash checksum. A shorter file can only be a torn write;
 * it is not a usable empty index. (SHA-256 repositories have a larger
 * checksum, so this floor remains deliberately conservative and still catches
 * the zero/short index class this guard protects.)
 */
export const MIN_VALID_GIT_INDEX_BYTES = 12 + 20;

export interface GitIndexFileSnapshot {
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
  /** `lstat().isFile()`. Optional for injected test seams; undefined means regular. */
  isFile?: boolean;
}

export interface InvalidIndexPreflightDeps {
  /** Read one path without following a symlink. ENOENT is returned as null. */
  inspectFile?: (path: string) => Promise<GitIndexFileSnapshot | null>;
  /** `true` = a writer has the path open, `false` = no writer, `null` = unknown. */
  isOpen?: (path: string) => Promise<boolean | null>;
  /** Override the minimum size for deterministic format/edge tests. */
  minimumBytes?: number;
}

export type InvalidIndexPreflightResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'absent' | 'valid'; indexPath: string; size?: number; minimumBytes: number }
  | { status: 'repaired'; indexPath: string; previousSize: number; size: number; minimumBytes: number }
  | { status: 'refused' | 'error'; indexPath: string; reason: string; previousSize?: number; minimumBytes: number };

const defaultIndexFileSnapshot = async (path: string): Promise<GitIndexFileSnapshot | null> => {
  try {
    const st = await lstat(path);
    return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, isFile: st.isFile() };
  } catch (error) {
    // An absent index is a normal state for a newly-created repository. Other
    // errors (permissions, I/O, a disappearing mount) are uncertainty and are
    // handled by the caller as a fail-closed refusal.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const sameGitIndexSnapshot = (a: GitIndexFileSnapshot, b: GitIndexFileSnapshot): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino && a.isFile === b.isFile;

/**
 * Detect and safely rebuild a torn `.git/index` before any status/submodule
 * census can mistake the checkout for a clean tree.
 *
 * The repair is intentionally narrow and non-destructive: only an existing
 * regular index shorter than the fixed header+checksum floor is eligible, and
 * `git read-tree HEAD` rebuilds the replaceable index without changing the
 * working tree. Before invoking it we prove that no process has the index open,
 * no `index.lock` exists, and the file did not change during inspection. Any
 * unknown/live state refuses the repair. The default `runGit` supplied by
 * `runGitSync` is the bounded runner, so the read-tree itself cannot wedge a
 * scheduled tick; injected runners remain available for deterministic tests.
 */
export async function preflightInvalidIndex(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
  deps: InvalidIndexPreflightDeps = {},
): Promise<InvalidIndexPreflightResult> {
  const minimumBytes = Math.max(1, Math.floor(deps.minimumBytes ?? MIN_VALID_GIT_INDEX_BYTES));
  const inspectFile = deps.inspectFile ?? defaultIndexFileSnapshot;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;

  let gitDirResult: GitCommandResult;
  try {
    gitDirResult = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  } catch (error) {
    // A caller-supplied fake or a path that is not a Git checkout cannot be
    // preflighted. Preserve the existing fail-soft behavior for that case; a
    // real canonical checkout always resolves this command successfully.
    return { status: 'unavailable', reason: `could not resolve the Git directory: ${String(error)}` };
  }
  const gitDir = gitDirResult.stdout.trim();
  if (gitDirResult.code !== 0 || !gitDir) {
    return {
      status: 'unavailable',
      reason: `could not resolve the Git directory: ${(gitDirResult.stderr || gitDirResult.stdout || 'unknown error').trim()}`,
    };
  }

  const indexPath = join(gitDir, 'index');
  const lockPath = join(gitDir, 'index.lock');
  const refuse = (
    reason: string,
    status: 'refused' | 'error' = 'refused',
    previousSize?: number,
  ): InvalidIndexPreflightResult => {
    log(
      `[git-sync] ${repoPath}: refusing invalid Git index preflight — ${reason}; leaving the index and working tree untouched`,
    );
    return { status, indexPath, reason, previousSize, minimumBytes };
  };
  const inspect = async (path: string): Promise<GitIndexFileSnapshot | null | 'unknown'> => {
    try {
      return await inspectFile(path);
    } catch {
      return 'unknown';
    }
  };

  const before = await inspect(indexPath);
  if (before === 'unknown') return refuse(`could not inspect ${indexPath}`);
  if (before === null) return { status: 'absent', indexPath, minimumBytes };
  if (before.isFile === false) return refuse(`${indexPath} is not a regular file`, 'error', before.size);
  if (before.size >= minimumBytes) return { status: 'valid', indexPath, size: before.size, minimumBytes };

  // The lock's mere presence is enough to refuse: even a stale-looking lock
  // may belong to a writer whose descriptor we cannot observe. Existing
  // index.lock recovery remains responsible for its own age-checked path.
  const lock = await inspect(lockPath);
  if (lock === 'unknown') return refuse(`could not determine whether ${lockPath} exists`, 'refused', before.size);
  if (lock !== null) {
    let lockOpen: boolean | null = null;
    try {
      lockOpen = await isOpen(lockPath);
    } catch {
      // Unknown is deliberately retained in the message below.
      lockOpen = null;
    }
    return refuse(
      `${lockPath} is present${lockOpen === true ? ' and open by a writer' : lockOpen === null ? ' (writer state unknown)' : ''}`,
      'refused',
      before.size,
    );
  }

  let open: boolean | null;
  try {
    open = await isOpen(indexPath);
  } catch {
    open = null;
  }
  if (open !== false) {
    return refuse(
      open === true ? `${indexPath} is open by a live writer` : `could not prove that ${indexPath} has no live writer`,
      'refused',
      before.size,
    );
  }

  // Re-stat immediately before repair. A changed file may already have been
  // repaired by its owner; accept that valid replacement, but never overwrite
  // another short/torn replacement whose provenance we cannot prove.
  const stable = await inspect(indexPath);
  if (stable === 'unknown') return refuse(`could not re-stat ${indexPath} before repair`, 'refused', before.size);
  if (stable === null) return refuse(`${indexPath} disappeared during preflight`, 'refused', before.size);
  if (stable.isFile === false)
    return refuse(`${indexPath} became non-regular during preflight`, 'refused', before.size);
  if (!sameGitIndexSnapshot(before, stable)) {
    if (stable.size >= minimumBytes) {
      return { status: 'valid', indexPath, size: stable.size, minimumBytes };
    }
    return refuse(`${indexPath} changed during preflight`, 'refused', before.size);
  }

  // Repeat both safety proofs after the re-stat so a lock/writer that appeared
  // during the first inspection cannot be clobbered by read-tree.
  const lockBeforeRepair = await inspect(lockPath);
  if (lockBeforeRepair === 'unknown')
    return refuse(`could not re-check ${lockPath} before repair`, 'refused', before.size);
  if (lockBeforeRepair !== null) return refuse(`${lockPath} appeared during preflight`, 'refused', before.size);
  try {
    open = await isOpen(indexPath);
  } catch {
    open = null;
  }
  if (open !== false) {
    return refuse(
      open === true
        ? `${indexPath} became open by a live writer during preflight`
        : `writer state for ${indexPath} became unknown during preflight`,
      'refused',
      before.size,
    );
  }

  let repair: GitCommandResult;
  try {
    // This is the bounded local git seam in production (`runGitBounded` via
    // runGitSync); never use execFileSync here, which could wedge the routine.
    repair = await runGit(['read-tree', 'HEAD'], repoPath);
  } catch (error) {
    return refuse(`bounded git read-tree HEAD threw: ${String(error)}`, 'error', before.size);
  }
  if (repair.code !== 0) {
    return refuse(
      `bounded git read-tree HEAD failed: ${(repair.stderr || repair.stdout || `exit ${repair.code}`).trim().slice(0, 300)}`,
      'error',
      before.size,
    );
  }

  const after = await inspect(indexPath);
  if (after === 'unknown' || after === null || after.isFile === false || after.size < minimumBytes) {
    return refuse(`git read-tree HEAD completed but ${indexPath} is still invalid`, 'error', before.size);
  }
  const lockAfterRepair = await inspect(lockPath);
  if (lockAfterRepair === 'unknown' || lockAfterRepair !== null) {
    return refuse(`${lockPath} remained after git read-tree HEAD`, 'error', before.size);
  }
  log(
    `[git-sync] ${repoPath}: repaired invalid Git index (${before.size} bytes < ${minimumBytes}) via bounded git read-tree HEAD; working-tree content was preserved`,
  );
  return { status: 'repaired', indexPath, previousSize: before.size, size: after.size, minimumBytes };
}

export interface TempPackScavengeDeps {
  now?: () => number;
  staleMs?: number;
  isOpen?: (path: string) => Promise<boolean | null>;
  unlinkFile?: (path: string) => Promise<void>;
}

/**
 * Remove only crash-left temp packs. Every deletion requires all of these proofs:
 * the entry is an old regular `tmp_pack_*` file, has no Git sidecar/reference or
 * hard link, no process has it open, and its size/mtime/type remain unchanged across
 * a second stat. Unknown open-state is fail-closed. This is intentionally separate
 * from failed-fetch cleanup: that path is same-attempt freshness based and remains
 * unchanged so it cannot delete a peer's pre-existing file.
 */
export async function scavengeStaleTempPacks(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: TempPackScavengeDeps = {},
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_TEMP_PACK_MS;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const { gitDir, entries } = await listTempPackEntries(runGit, repoPath);
  if (!gitDir) return { removed: [], bytesReclaimed: 0 };
  const packDir = join(gitDir, 'objects', 'pack');
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const nowMs = now();

  for (const entry of entries) {
    if (entry.mtimeMs > nowMs - staleMs || entry.mtimeMs > nowMs) continue;
    const path = join(packDir, entry.name);
    try {
      if (await tempPackHasReferences(gitDir, entry)) continue;
      if ((await isOpen(path)) !== false) continue;
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.size !== entry.size ||
        current.mtimeMs !== entry.mtimeMs ||
        current.nlink > 1 ||
        (await tempPackHasReferences(gitDir, {
          ...entry,
          size: current.size,
          mtimeMs: current.mtimeMs,
          nlink: current.nlink,
        })) ||
        (await isOpen(path)) !== false
      )
        continue;
      await unlinkFile(path);
      removed.push(entry.name);
      bytesReclaimed += entry.size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune stale temp pack ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

export async function pruneFailedFetchTempPacks(
  runGit: RunGit,
  repoPath: string,
  beforeFetch: Map<string, number>,
  log: (m: string) => void,
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const afterFetch = await listTempPackFiles(runGit, repoPath);
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  const gitDir = gd.code === 0 ? gd.stdout.trim() : '';
  if (!gitDir) return { removed, bytesReclaimed };
  const packDir = join(gitDir, 'objects', 'pack');

  for (const [name, size] of afterFetch) {
    if (beforeFetch.has(name)) continue;
    try {
      // `lstat` + the anchored name filter keep this unlink scoped to a regular
      // temp pack in THIS repo's object store; symlinks and directories are left.
      const current = await lstat(join(packDir, name));
      if (!current.isFile()) continue;
      await unlink(join(packDir, name));
      removed.push(name);
      bytesReclaimed += size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune failed-fetch temp pack ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

/** `git submodule status` row → path. Row is "<flag><sha> <path> (<describe>)". */
const submoduleStatusRowPath = (l: string): string | undefined => l.slice(1).trim().split(/\s+/)[1];

/**
 * The strand census itself, over ALREADY-FETCHED `git submodule status --recursive`
 * lines. Extracted (EI-20459175302238839) so the release preflight can measure the
 * SAME condition without running a sync pass — one copy of the logic, never two.
 *
 * Callers must preserve the measured-vs-unmeasured distinction themselves: this
 * returns the census for lines it was GIVEN, so handing it the empty list from a
 * FAILED `submodule status` would manufacture a false all-clear. Both callers below
 * only reach it on the exit-0 path.
 */
const strandCensusFromStatusLines = async (
  runGit: RunGit,
  repo: string,
  lines: string[],
  log: (msg: string) => void = () => {},
): Promise<StrandedSubmodule[]> => {
  // EI-20402093158205519: a '-' row means only that `submodule.<name>.url` is absent from
  // .git/config (`git submodule init` never ran). It says NOTHING about whether the
  // worktree is POPULATED — and a populated one can hold real, uncommitted agent work.
  // This path's test is therefore strictly WEAKER than the .gitmodules fallback below,
  // which lstats `<path>/.git`; and because the fallback runs ONLY when discovery FAILS,
  // the weak test governs the normal (exit 0) case. Measured on the sidestage tree
  // 2026-08-14: 7 of 8 submodules '-'-prefixed but fully populated, discovery returned
  // exactly 1 path, and three tracked files sat uncommitted with no error on any tick —
  // git-sync never visited those repos at all. Silence is the defect: SAY SO. Reporting
  // (not auto-syncing) is deliberate — these worktrees are commonly parked on deliberate
  // detached pins, so pulling them into the normal path would fetch/merge/push and UNPIN
  // them. Registering is the operator's call; losing the work silently is not.
  const stranded: StrandedSubmodule[] = [];
  for (const l of lines) {
    if (l[0] !== '-') continue;
    const p = submoduleStatusRowPath(l);
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // populated worktree, just unregistered
    } catch {
      continue; // genuinely uninitialized — nothing on disk to strand
    }
    const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=no'], join(repo, p));
    // Count TRACKED modifications only: scratch/untracked churn (e.g. .vitest-tmp/) would
    // otherwise cry wolf on every tick that a test run happens to be in flight.
    const rows = dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean) : [];
    if (rows.length > 0) {
      stranded.push({
        path: p,
        trackedFiles: rows.length,
        // Porcelain v1 row is "XY <path>"; keep the paths so the escalation can name the
        // actual files a human must rescue, not just a count they then have to go find.
        files: rows.slice(0, 20).map((r) => r.slice(3).trim()),
      });
    }
  }
  if (stranded.length > 0) {
    const list = stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join(', ');
    log(
      `[git-sync] ⚠ STRANDED WORK: ${stranded.length} POPULATED but UNREGISTERED submodule(s) hold uncommitted tracked changes ` +
        `that git-sync cannot see and will NEVER commit: ${list} — ` +
        `they are absent from .git/config (no submodule.<name>.url), so 'git submodule status' marks them '-' and discovery skips them. ` +
        `Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into .git/config), then re-check the pin before the next tick.`,
    );
  }
  return stranded;
};

/**
 * EI-20459175302238839: measure the strand census for `repo` WITHOUT running a sync
 * pass — the read a release/deploy preflight needs, since a strand means the committed
 * state a release artifact is built FROM is missing work that exists only on this box.
 *
 * Returns `null` for NOT MEASURED (`git submodule status` failed), deliberately distinct
 * from `[]` (measured, nothing stranded) — the same contract as
 * `GitSyncOutcome.strandedSubmodules`. A consumer that collapses the two reintroduces
 * exactly the silence this census exists to break, so callers must branch on `null`
 * explicitly rather than treating a falsy/empty result as an all-clear.
 */
export const censusStrandedSubmodules = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
): Promise<StrandedSubmodule[] | null> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code !== 0) {
    log(
      `[strand-census] submodule discovery FAILED in ${repo} (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
        `census NOT MEASURED (null); this is not an all-clear.`,
    );
    return null;
  }
  return strandCensusFromStatusLines(runGit, repo, r.stdout.split('\n').filter(Boolean), log);
};

/**
 * Recursively discover submodule paths (repo-relative), DEEPEST-FIRST. Dynamic —
 * reads the live submodule tree (`git submodule status --recursive`), never a
 * hardcoded list. Skips uninitialized submodules (leading '-'). Deepest-first so a
 * child lands on its origin before a parent's pointer to it is pushed.
 */
// Exported for the stray-gitlink fallback regression test (2026-07-01).
export const discoverSubmodulesRecursive = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
  /** EI-20402093158205519: receives the strand census whenever this pass actually MEASURED
   *  it (the `git submodule status` exit-0 path), including the empty result — an empty
   *  census is a real all-clear the caller uses to clear a stale escalation. Deliberately
   *  NOT called on the discovery-failure fallback: we did not measure, and reporting an
   *  unmeasured [] there would read as an all-clear and silently retire a live warning. */
  onStrandCensus?: (stranded: StrandedSubmodule[]) => void,
): Promise<string[]> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code === 0) {
    const lines = r.stdout.split('\n').filter(Boolean);
    const paths = lines
      .filter((l) => l[0] !== '-') // skip uninitialized
      .map(submoduleStatusRowPath)
      .filter((p): p is string => Boolean(p));
    // The census body lives in `strandCensusFromStatusLines` (EI-20459175302238839) so the
    // release preflight can measure the SAME condition without running a sync pass — one
    // copy of the logic, and the same single `submodule status` call on this path.
    //
    // MUST be computed on its own statement, NOT inline as `onStrandCensus?.(await …)`:
    // an optional CALL short-circuits its own ARGUMENTS, so with no callback supplied the
    // census would never run and its ⚠ STRANDED WORK log would silently vanish — which is
    // the warning this whole mechanism exists to emit. The log is the point; the callback
    // is only delivery.
    const stranded = await strandCensusFromStatusLines(runGit, repo, lines, log);
    // Fire even when EMPTY: the caller needs the all-clear to retire a stale escalation.
    // Only on this (measured) path — see the param doc.
    onStrandCensus?.(stranded);
    return paths.sort((a, b) => b.split('/').length - a.split('/').length);
  }
  // ONE stray index gitlink with no .gitmodules mapping (e.g. a test's temp repo swept in
  // by an auto-commit) makes `git submodule status --recursive` exit 128 — and a silent []
  // here strands EVERY submodule's commits, every tick, while the routine keeps reporting
  // "synced" (2026-07-01: `.papercusp/scratch/tmp/relgit-*` did exactly this for days).
  // Never silently skip the pass: SAY SO, then fall back to the .gitmodules mapping
  // (authoritative for top-level paths; nested submodules wait until the stray is removed —
  // `git rm --cached <stray-path>` is the operator fix, named in the log line).
  log(
    `[git-sync] submodule discovery FAILED (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
      `falling back to .gitmodules top-level paths; if this names a stray gitlink, fix with: git rm --cached <path>`,
  );
  const cfg = await runGit(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], repo);
  if (cfg.code !== 0) return [];
  const paths: string[] = [];
  for (const line of cfg.stdout.split('\n')) {
    const p = line.trim().split(/\s+/)[1];
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // initialized submodules only (worktree has .git)
      paths.push(p);
    } catch {
      /* uninitialized — skip */
    }
  }
  return paths.sort((a, b) => b.split('/').length - a.split('/').length);
};

/** One `git stash` entry, identified by its underlying commit SHA (stable across
 *  ticks — unlike `stash@{N}`, which is purely POSITIONAL and shifts whenever an
 *  older entry is popped/dropped). */
export interface StashEntry {
  sha: string;
  subject: string;
  /** Committer date of the stash commit, ISO-8601 (`%cI`), or '' when git omitted it.
   *  EI-19449313204576061: WITHOUT this the detector can only report "not in my
   *  baseline", which it then RENDERED as "🚨 NEW" — a conclusion about creation time
   *  it had never observed. A stash's age is the decisive falsifier and costs one
   *  extra `--format` token, so it is carried on the entry rather than re-derived. */
  createdAt: string;
}

/**
 * WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared staging tree and it silently sat there looking like vanished work): list
 * one repo's current stash entries. Read-only, never throws — a `git stash list`
 * failure (odd env, detached/bare repo) reads as empty, same fail-open posture as
 * the other best-effort git-sync primitives in this file.
 */
export async function listStashEntries(runGit: RunGit, repoPath: string): Promise<StashEntry[]> {
  const r = await runGit(['stash', 'list', '--format=%H%x1f%cI%x1f%s'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // Subject is LAST and may itself contain the separator in pathological cases —
      // take the first two fields positionally and rejoin the remainder.
      const parts = line.split('\x1f');
      const sha = parts[0] ?? '';
      const createdAt = parts[1] ?? '';
      const subject = parts.slice(2).join('\x1f');
      return { sha, createdAt, subject };
    })
    .filter((e) => e.sha.length > 0);
}

/** How recent a stash must be for the watchdog to treat it as live, at-risk work.
 *  git-sync ticks every few minutes, so anything stashed within a day is plausibly a
 *  current agent's in-flight work (the EI-7685 case the detector exists for); older
 *  than that is archaeology, and calling it "NEW" is what trained agents to reach for
 *  `stash pop`/`drop` on a shared tree. */
export const STASH_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: split not-yet-known stash entries into the ones that are genuinely RECENT
 * (worth an urgent broadcast) and the ones that merely became VISIBLE to the detector
 * now despite predating it (worth a quiet notice at most).
 *
 * EI-19449313204576061: "not in my baseline" and "new" are different claims, and the
 * detector only ever observed the first. An entry with an unparseable/absent date is
 * treated as RECENT — fail toward surfacing, never toward silently swallowing a real
 * stash, since a missed genuine stash is the expensive direction (EI-7685).
 */
export function partitionStashEntriesByAge<T extends StashEntry>(
  entries: readonly T[],
  nowMs: number,
  recentWindowMs: number = STASH_RECENT_WINDOW_MS,
): { recent: T[]; preExisting: T[] } {
  const recent: T[] = [];
  const preExisting: T[] = [];
  for (const e of entries) {
    const t = e.createdAt ? Date.parse(e.createdAt) : Number.NaN;
    if (Number.isNaN(t) || nowMs - t <= recentWindowMs) recent.push(e);
    else preExisting.push(e);
  }
  return { recent, preExisting };
}

/** Human-readable age for an alarm line — the field whose absence let a 13-week-old
 *  stash read as an emergency. Returns 'unknown age' when the date is missing. */
export function describeStashAge(entry: StashEntry, nowMs: number): string {
  const t = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
  if (Number.isNaN(t)) return 'unknown age';
  const days = Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
  if (days >= 1) return `created ${entry.createdAt.slice(0, 10)}, ${days}d old`;
  const hours = Math.floor((nowMs - t) / (60 * 60 * 1000));
  return `created ${entry.createdAt.slice(0, 10)}, ${hours}h old`;
}

/** Pure: which of `current`'s stash entries were never in `knownShas` — i.e. genuinely
 *  NEW since the last check. Exported so the comparison logic is unit-testable with
 *  zero git subprocess involved (mirrors the other pure `*FromRows`/`*From*` helpers
 *  in this codebase). */
export function newStashEntries(current: StashEntry[], knownShas: readonly string[]): StashEntry[] {
  const known = new Set(knownShas);
  return current.filter((e) => !known.has(e.sha));
}

type RepoSyncResult = {
  /** Dirty paths measured before this repo's commit stage. */
  dirtyPathCount: number;
  /** Local commits created by this repo during this pass. */
  committedCount: number;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  mergeCompleted?: boolean;
  skippedPaths?: GitSyncSkippedPath[];
} & (
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'skipped-locked' }
  | { status: 'error'; message: string }
);

/**
 * Dirty (modified/untracked) files exceeding maxBytes — detected BEFORE `add -A` so
 * the auto-commit can EXCLUDE them (EI-18: GitHub hard-rejects >100MB blobs, and one
 * committed oversized blob makes the unpushed range permanently unpushable; recovery
 * is manual history surgery). Uses `status --porcelain -z` (NUL-separated, unquoted —
 * robust to spaces/specials in paths) with `-uall` (P-001): WITHOUT it a brand-new
 * directory collapses to a single `?? dir/` entry whose `lstat` is a directory and is
 * skipped, hiding an oversized file INSIDE it — then `add -A` commits it and wedges the
 * push forever (the exact EI-18 incident class). `-uall` lists every untracked file
 * individually so each oversized blob is seen + excluded.
 */
// Exported for the exact-boundary table test (test-coverage-gap G22): the size
// comparison is strict `>` — a file AT maxBytes must be INCLUDED, not excluded.
// Each lstat yields to the host loop. Serial scans multiplied that scheduling
// delay by the entire dirty census; bound the outstanding reads without changing
// census freshness, result order, or either size guard's exclusion rules.
const DIRTY_SIZE_STAT_CONCURRENCY = 16;

export async function findOversizedDirtyFiles(
  runGit: RunGit,
  repoPath: string,
  maxBytes: number,
): Promise<OversizedFile[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletions have no blob to size
    paths.push(path);
  }
  const limit = pLimit(DIRTY_SIZE_STAT_CONCURRENCY);
  const sized = await Promise.all(paths.map(path => limit(async () => {
    try {
      const st = await lstat(join(repoPath, path));
      return st.isFile() && st.size > maxBytes ? { path, sizeBytes: st.size } : null;
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
      return null;
    }
  })));
  return sized.filter((file): file is OversizedFile => file !== null);
}

/**
 * WI-5738 — the CUMULATIVE sibling of `findOversizedDirtyFiles`, and the gate
 * that should have stopped the 2026-07-20 incident at source.
 *
 * `findOversizedDirtyFiles` is PER-FILE. On 2026-07-20 an extracted AppImage
 * was auto-committed as **2,261 MB across thousands of files** whose largest
 * single blob was 90.3 MB — comfortably under the 95 MB per-file cap. Every
 * file passed individually, the whole thing was committed, and the aggregate
 * then breached the publish guard's 500 MB TOTAL cap one layer downstream,
 * where the only available response was to refuse (terminally). The per-file
 * cap cannot see a bulk accident; the total cap can only see it too late.
 *
 * So: measure the aggregate HERE, where the response is still cheap and
 * correct — exclude the files from the commit and leave them dirty, exactly as
 * the oversized/content guards already do ("quarantine, don't stall"): the
 * offending tree is peeled off and the fleet's real work still commits this tick.
 *
 * ORDERING (EI-21906459740652039). This used to peel purely largest-first, on the
 * stated premise that "a bulk accident is dominated by a few big artifacts while
 * genuine source edits are small". That premise is right about ACCIDENTS and wrong
 * about this repo: the largest dirty-file class here is not an accident, it is the
 * legitimate generated docs mirror. Measured 2026-08-30, 81 of 95 dirty files —
 * and all 20 of the largest — were `apps/operator/public/internal/docs/**`, so
 * largest-first peeled essentially the whole mirror EVERY time the cap tripped, by
 * construction. A `npm run docs:rebuild` therefore sat uncommitted for 13h while
 * git-sync reported success, and the served docs went stale under every agent that
 * read them.
 *
 * The premise is repaired, not abandoned: rank by "is this an UNEXPECTED artifact"
 * rather than by raw size. Declared regenerable projections are peeled LAST — only
 * once peeling every unexpected artifact still leaves the set over the cap — so the
 * guard's real purpose (a stray 90MB blob, a 2,261MB extracted AppImage) is intact
 * while a declared generated output is never starved by it.
 *
 * SMALL SOURCE LAST (WI-10004416). The repair above over-corrected: "not a projection"
 * was treated as "unexpected artifact", so every hand-written source file ranked
 * AHEAD of the mirror. Whenever a docs rebuild alone nearly filled the cap, the
 * first pass peeled ALL ordinary source down to the smallest file. Measured
 * 2026-09-30 20:17Z: the sweep commit was 249 MB, 992 of its 999 files were the
 * docs mirror, and 305 ordinary source files (532 KB down to ~3 KB) were left dirty.
 * The content guard then quarantined their importers, so the fleet's source edits
 * never reached a commit while git-sync reported success. A non-projection file now
 * ranks as an artifact only at or above `bulkArtifactMinBytes`; smaller files are
 * peeled after every projection. The mirror still commits across several ticks,
 * and a real bulk accident is still peeled first.
 *
 * Deliberately NOT a hard failure: a legitimately large commit is possible, and
 * refusing to commit at all would just relocate the wedge upstream.
 */
export async function findBulkDirtyExcess(
  runGit: RunGit,
  repoPath: string,
  maxTotalBytes: number,
  alreadyExcluded: ReadonlySet<string> = new Set(),
): Promise<OversizedFile[]> {
  const paths = await dirtyFiles(runGit, repoPath);
  const limit = pLimit(DIRTY_SIZE_STAT_CONCURRENCY);
  const measurements = await Promise.all(paths.filter(path => !alreadyExcluded.has(path)).map(path => limit(async () => {
    try {
      const st = await lstat(join(repoPath, path));
      return st.isFile() ? { path, sizeBytes: st.size } : null;
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
      return null;
    }
  })));
  const sized = measurements.filter((file): file is OversizedFile => file !== null);
  let total = sized.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total <= maxTotalBytes) return [];
  // Peel in three tiers, each largest-first, stopping as soon as the remainder fits
  // (EI-21906459740652039 + WI-10004416; see the header):
  //   1. artifact-sized files that are NOT declared projections — the accident class;
  //   2. declared regenerable projections (the docs mirror);
  //   3. small hand-written files — only when 1 and 2 together are not enough.
  sized.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const artifactMinBytes = bulkArtifactMinBytes(maxTotalBytes);
  const excluded: OversizedFile[] = [];
  const deferredProjections: OversizedFile[] = [];
  const deferredSmall: OversizedFile[] = [];
  const probe = { spent: 0 };
  for (const f of sized) {
    if (total <= maxTotalBytes) break;
    if (await isRegenerableProjection(repoPath, f.path, probe)) {
      deferredProjections.push(f);
      continue;
    }
    if (f.sizeBytes < artifactMinBytes) {
      deferredSmall.push(f);
      continue;
    }
    excluded.push({ ...f, exclusionReason: 'cumulative-limit' });
    total -= f.sizeBytes;
  }
  for (const tier of [deferredProjections, deferredSmall]) {
    for (const f of tier) {
      if (total <= maxTotalBytes) break;
      excluded.push({ ...f, exclusionReason: 'cumulative-limit' });
      total -= f.sizeBytes;
    }
  }
  return excluded;
}

/**
 * WI-10004416 — the size at which a non-projection dirty file counts as an
 * ARTIFACT (tier 1 of the peel) rather than hand-written source (tier 3).
 *
 * A fixed fraction of the cap rather than a fixed byte count: 1/250 is ~1 MB at the
 * production 250 MB cap, which is above every hand-written source file in this repo
 * (the largest are a few hundred KB) and below the files a bulk accident is made of.
 * Scaling with the cap keeps the tiering meaningful at any configured limit, and
 * keeps a byte-scale test cap from classifying every fixture as source.
 */
export function bulkArtifactMinBytes(maxTotalBytes: number): number {
  return Math.max(1, Math.floor(maxTotalBytes / 250));
}

/**
 * EI-21906459740652039 — the ONE tracked tree that is a build MIRROR rather than a
 * source of truth. Its canonical source is `apps/operator-docs/src/content/docs` (or
 * the docs datastore via `docs:author`), and `npm run docs:rebuild` regenerates it
 * wholesale. It needs a declared prefix rather than the self-declaring banner below
 * for exactly the reason the PreToolUse generated-file guard has to special-case the
 * same tree: most of its artifacts predate the banner convention, and many (pagefind
 * fragments, images) are binary and can never carry one.
 */
const INTERNAL_DOCS_MIRROR_PREFIX = 'apps/operator/public/internal/docs/';

/** Head bytes / lines / line-length of the self-declaring generated-artifact banner —
 *  the same measured predicate the PreToolUse generated-file guard keys on, so a file
 *  that opts IN there is automatically protected here too, with no second list to
 *  maintain. The 300-char line cap is load-bearing: without it a minified `.js.map`
 *  matches on a banner embedded inside its `sourcesContent` blob. */
const GENERATED_BANNER_SCAN_BYTES = 4096;
const GENERATED_BANNER_SCAN_LINES = 10;
const GENERATED_BANNER_MAX_LINE_CHARS = 300;
/** Cap on how many files one peel may OPEN to ask the banner question. Beyond it the
 *  answer degrades to the prefix rules alone (i.e. back to today's largest-first
 *  behaviour), so a pathological dirty set of hundreds of thousands of small files can
 *  never turn a size guard into an I/O storm. */
const GENERATED_BANNER_PROBE_BUDGET = 500;

/** PURE: does this header DECLARE the file a generated artifact? Both tokens must sit
 *  on ONE line — "do not edit" alone matches prose about something else, "generated"
 *  alone matches any file that discusses generation. */
export function declaresGeneratedBanner(head: string): boolean {
  const lines = head.split('\n', GENERATED_BANNER_SCAN_LINES);
  for (const raw of lines) {
    if (raw.length > GENERATED_BANNER_MAX_LINE_CHARS) continue;
    const l = raw.toLowerCase();
    if (!l.includes('generated')) continue;
    if (l.includes('do not edit') || l.includes("don't edit") || l.includes('do-not-edit')) return true;
  }
  return false;
}

/**
 * Is this dirty path a DECLARED, regenerable projection — something whose absence from
 * a commit costs a `npm run <generator>` rather than lost work? Used only to ORDER the
 * cumulative peel (above); it never excludes anything by itself, so a false positive
 * costs at most that one file being peeled later than a stray artifact would be.
 *
 * Every arm is a truth this module ALREADY declares, not a new hand-maintained list:
 * the tool-catalog artifact git-sync regenerates itself before each commit, the
 * `.d.mts` half of a generated declaration pair, the internal-docs build mirror, and —
 * self-arming, so a NEW generated artifact is covered for free — a file whose own
 * header says it is generated.
 */
export async function isRegenerableProjection(
  repoPath: string,
  path: string,
  probe: { spent: number } = { spent: 0 },
): Promise<boolean> {
  if (path === TOOL_CATALOG_ARTIFACT_PATH) return true;
  if (path.startsWith(INTERNAL_DOCS_MIRROR_PREFIX)) return true;
  if (path.endsWith('.d.mts') && generatedDeclarationPair(path) !== null) return true;
  if (probe.spent >= GENERATED_BANNER_PROBE_BUDGET) return false;
  probe.spent += 1;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(join(repoPath, path), 'r');
    const buf = Buffer.alloc(GENERATED_BANNER_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, GENERATED_BANNER_SCAN_BYTES, 0);
    return declaresGeneratedBanner(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    /* vanished mid-pass / unreadable — treat as an ordinary artifact */
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Enumerate every dirty path (modified/added/deleted/untracked), repo-relative, in the
 *  same path-space as the oversized/content excludes. `-z` keeps paths with spaces/newlines
 *  intact; a rename/copy origin path (the 2nd `-z` field) is skipped. Exported for P-004 tests. */
export async function dirtyFiles(
  runGit: RunGit,
  repoPath: string,
  options: { ignoreSubmodules?: 'dirty' } = {},
): Promise<string[]> {
  const r = await runGit([
    'status', '--porcelain', '-z', '-uall',
    ...(options.ignoreSubmodules ? [`--ignore-submodules=${options.ignoreSubmodules}`] : []),
  ], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // -z rename/copy: skip the origin path that follows
    out.push(e.slice(3));
  }
  return out;
}

/** Enumerate the paths currently in Git's index, losslessly for legal filenames. */
async function stagedFiles(runGit: RunGit, repoPath: string): Promise<string[]> {
  const r = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * EI-25535599233496771: Git successfully stages a nested repository as mode 160000
 * even when no .gitmodules entry exists. A later source materializer then cannot
 * reproduce that commit. Judge the SAME index the commit will record, including
 * an attributed commit's private index; working-tree .gitmodules is not evidence.
 */
export async function unmappedStagedGitlinkPaths(
  runGit: RunGit,
  repoPath: string,
  staged: readonly string[],
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const index = await runGit(['ls-files', '--stage', '-z'], repoPath);
  if (index.code !== 0) return { ok: false, error: `could not inspect gitlink index: ${gitFailureDetail(index)}` };
  const entries = index.stdout.split('\0').flatMap((entry) => {
    const match = /^(\d{6}) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
    return match ? [{ mode: match[1], sha: match[2], path: match[3] }] : [];
  });
  const stagedSet = new Set(staged);
  const gitlinks = entries.filter((entry) => entry.mode === '160000' &&
    (stagedSet.has(entry.path) || stagedSet.has('.gitmodules')));
  if (gitlinks.length === 0) return { ok: true, paths: [] };
  const manifest = entries.find((entry) => entry.path === '.gitmodules' && entry.mode === '100644');
  const modules = new Map<string, { path?: string; url?: string }>();
  if (manifest) {
    const config = await runGit(
      ['config', '-z', '--blob', manifest.sha, '--get-regexp', '^submodule\\..*\\.(path|url)$'], repoPath,
    );
    // Git also returns 1 for some malformed config blobs. Only the silent
    // no-match result is an empty mapping; parse errors must stay fail-closed.
    if (config.code !== 0 && (config.code !== 1 || config.stderr.trim() !== '')) {
      return { ok: false, error: `could not inspect indexed .gitmodules: ${gitFailureDetail(config)}` };
    }
    for (const record of config.stdout.split('\0').filter(Boolean)) {
      const newline = record.indexOf('\n');
      const key = /^submodule\.(.*)\.(path|url)$/.exec(record.slice(0, newline));
      if (newline < 0 || !key) return { ok: false, error: 'could not parse indexed .gitmodules fields' };
      const fields = modules.get(key[1]) ?? {};
      fields[key[2] as 'path' | 'url'] = record.slice(newline + 1);
      modules.set(key[1], fields);
    }
  }
  const mapped = new Set([...modules.values()].filter((entry) => entry.path && entry.url?.trim()).map((entry) => entry.path));
  const unmapped = gitlinks.filter((entry) => !mapped.has(entry.path)).map((entry) => entry.path);
  return { ok: true, paths: unmapped.length === 0 ? [] : [
    ...unmapped.filter((path) => stagedSet.has(path)),
    ...(stagedSet.has('.gitmodules') ? ['.gitmodules'] : []),
  ] };
}

/**
 * EI-22494259338317391: a negative pathspec only prevents `git add` from
 * changing the matching index entries; it does not remove an entry that was
 * staged earlier (for example by `git checkout <sha> -- <path>`). Since the
 * eventual `git commit` includes the whole index, clear only those pre-staged
 * protected entries before any attribution or catch-all staging phase.
 *
 * The working tree is intentionally untouched. The next tick can stage the
 * protected content once its lock is gone, while unrelated pre-staged work
 * remains available for this commit. `-z` keeps legal filenames lossless.
 */
async function unstagePreStagedProtectedPaths(
  runGit: RunGit,
  repoPath: string,
  excludePaths: readonly string[],
  log: (message: string) => void,
  preserveStagedDeletions: ReadonlySet<string> = new Set(),
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const normalizedExcludes = [
    ...new Set(excludePaths.map((path) => path.trim().replace(/^\.\/+|\/+$/g, '')).filter(Boolean)),
  ];
  if (normalizedExcludes.length === 0) return { ok: true, paths: [] };

  const staged = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], repoPath);
  if (staged.code !== 0) {
    return {
      ok: false,
      error: `could not inspect pre-staged protected paths: ${gitFailureDetail(staged)}`,
    };
  }
  const stagedDeletions = new Set<string>();
  if (preserveStagedDeletions.size > 0) {
    const deletions = await runGit(
      ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z'],
      repoPath,
    );
    if (deletions.code !== 0) {
      return { ok: false, error: 'could not inspect pre-staged deletions: ' + gitFailureDetail(deletions) };
    }
    for (const path of deletions.stdout.split('\0').filter(Boolean)) {
      if (preserveStagedDeletions.has(path)) stagedDeletions.add(path);
    }
  }
  const protectedStaged = [
    ...new Set(
      staged.stdout
        .split('\0')
        .filter(Boolean)
        .filter((path) => !stagedDeletions.has(path))
        .filter((path) => normalizedExcludes.some((exclude) => gitSyncPathsOverlap(path, exclude))),
    ),
  ];
  if (protectedStaged.length === 0) return { ok: true, paths: [] };

  // WI-10004413: this reset WRITES the index and is often the tick's first index
  // writer, so an orphaned index.lock blocks it exactly like `git add`/`git commit`.
  // Without the shared age-checked, live-holder-guarded recovery, every tick failed
  // here until someone removed the lock by hand (2026-09-30: superproject frozen for over an hour).
  const resetArgs = ['reset', '-q', 'HEAD', '--', ...protectedStaged];
  const unstage = await recoverIndexLockContention(
    await runGit(resetArgs, repoPath),
    () => runGit(resetArgs, repoPath),
    runGit,
    repoPath,
    'git reset (unstage protected paths)',
    log,
  );
  if (unstage.code !== 0) {
    return {
      ok: false,
      error: `could not unstage protected paths: ${gitFailureDetail(unstage)}`,
    };
  }
  log(
    `[git-sync] ${repoPath}: removed ${protectedStaged.length} pre-staged protected path(s) from the commit index ` +
      `(${protectedStaged.join(', ')}) — working-tree edits remain locked`,
  );
  return { ok: true, paths: protectedStaged };
}

/** Outcome of {@link guardStagedIndexBeforeCommit}. */
export type PostStageGuardResult =
  | {
      ok: true;
      /** Holdings (this repo's coordinates) that overlap a staged path but were not visible pre-stage. */
      lateLockedHoldings: GitSyncLockHolding[];
      /** Staged paths whose working-tree content changed after they were staged. */
      drifted: string[];
      /** Every path removed from the index (late-locked, drifted, importers, and incompatible staged providers). */
      unstaged: string[];
    }
  | { ok: false; error: string };

/**
 * EI-24712906810240170: close the window between STAGING and COMMIT.
 *
 * The pre-stage live-lock refresh protects every path locked BEFORE `git add`. It cannot
 * protect a path whose lock is taken after that read: a mutation probe that acquires its
 * file lock and mutates between the refresh and the add has its MUTANT staged, and a probe
 * that then restores the file and releases the lock before the commit leaves no lock for
 * anyone to see. `git commit` records the index, so either way the mutant would publish.
 * That gap is why top-level probes used to need the fleet-wide exclusive git-sync lease.
 *
 * Call this after the final add and before the commit it guards. It unstages:
 *  - LATE-LOCKED paths: staged paths that a live lock now covers;
 *  - DRIFTED paths: staged paths whose working-tree content no longer matches the index
 *    (the staged blob was a transient state, e.g. a probe's mutant since restored);
 *  - their dirty importers, so an importer never lands without the module it needs;
 *  - staged providers whose removed exports are still consumed by a held importer's HEAD
 *    text, so the old importer cannot land with a broken provider API;
 *  - WI-10006734: staged importers of an UNTRACKED module this index does not provide
 *    (84959c3039 committed `import('../integrations/ticket-integrations')` while that
 *    module stayed untracked for 39 minutes, and every isolated bundle failed).
 * Unstaged paths stay dirty in the working tree and are re-examined by the next tick,
 * with the full content guard pipeline, instead of being re-staged here unscanned.
 *
 * ⚠ ORDER IS LOAD-BEARING: the staged set is read first (the index is fixed after the add),
 * then the lock census, then the working-tree drift. A probe locks before it mutates
 * (L < M) and releases after it restores (R < Rel). A mutant is staged only when M < add.
 * If the lock is still held at the census, the late-lock check catches it. If it was
 * released before the census, the restore happened earlier still (R < Rel < census <
 * drift read), so the drift check sees worktree ≠ index. Reading drift BEFORE the census
 * would miss a restore+release that lands between the two reads.
 *
 * Submodule gitlinks are ignored by the drift read (`--ignore-submodules=all`): a moved or
 * dirty submodule is not a transient superproject blob, and its files are guarded by that
 * submodule's own pass. Fails closed (ok:false) when the lock plane or the index cannot be read.
 */
export async function guardStagedIndexBeforeCommit(opts: {
  runGit: RunGit;
  repoPath: string;
  /** Log-only label; structured scope remains the caller's public diagnostic coordinate. */
  scope: string;
  refreshLiveLockHoldings?: () => Promise<GitSyncLockHolding[]>;
  readText: (relPath: string) => Promise<string | null>;
  /** Paths excluded before staging (content/deletion/size guards, explicit exclusions, and package closures). */
  excludedDependencies?: readonly string[];
  /** Cumulative-limit paths with no overlapping exclusion; only exact staged deletions may bypass this exclusion. */
  preserveCumulativeUntracking?: ReadonlySet<string>;
  /** WI-6554700010008496: why each `excludedDependencies` path is excluded, keyed by path. */
  excludedDependencyReasons?: ReadonlyMap<string, string>;
  /** Live-lock/cohort paths remain infectious even when an older copy exists in HEAD. */
  alwaysInfectiousDependencies?: readonly string[];
  /** Enrolled source/artifact pairs forced into this commit's catch-all staging. */
  generatedDeclarationPaths?: readonly string[];
  /**
   * EI-21230011589307899: judge staged blobs the pre-stage content guard never saw (a
   * file created between that scan and the add). Each returned offender is held back like
   * a drifted path. Receives the index-bound runner. A throw fails open (logged).
   */
  rescanStagedContent?: (staged: readonly string[], indexRunGit: RunGit) => Promise<ContentOffender[]>;
  log: (message: string) => void;
}): Promise<PostStageGuardResult> {
  const { runGit, repoPath, scope, log } = opts;
  // 1. The staged set. Fixed since the add, so reading it before the census is safe.
  const stagedRes = await runGit(['diff', '--cached', '--name-only', '--no-renames', '-z'], repoPath);
  if (stagedRes.code !== 0) {
    return {
      ok: false,
      error: `post-stage guard could not read the index: ${gitFailureDetail(stagedRes)}`,
    };
  }
  const staged = stagedRes.stdout.split('\0').filter(Boolean);
  if (staged.length === 0) return { ok: true, lateLockedHoldings: [], drifted: [], unstaged: [] };
  const stagedSet = new Set(staged);
  const gitlinkGuard = await unmappedStagedGitlinkPaths(runGit, repoPath, staged);
  if (!gitlinkGuard.ok) return { ok: false, error: `post-stage guard ${gitlinkGuard.error}` };
  for (const path of gitlinkGuard.paths) {
    log(`[git-sync] ${scope}: post-stage guard holds ${path}: gitlink requires indexed .gitmodules path/url mapping`);
  }

  // 2. The lock census, AFTER the add.
  let lateLockedHoldings: GitSyncLockHolding[] = [];
  const lateLocked = new Set<string>();
  if (opts.refreshLiveLockHoldings) {
    let holdings: GitSyncLockHolding[];
    try {
      holdings = await opts.refreshLiveLockHoldings();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`[git-sync] ${scope}: post-stage live lock refresh failed (fail-closed) — ${detail}`);
      return { ok: false, error: `post-stage live lock refresh failed (fail-closed): ${detail}` };
    }
    const byPath = new Map<string, GitSyncLockHolding>();
    for (const holding of holdings) {
      const lockPath = holding.path.trim().replace(/^\.\/+|\/+$/g, '');
      if (!lockPath) continue;
      const covered = staged.filter((path) => gitSyncPathsOverlap(path, lockPath));
      if (covered.length === 0) continue;
      for (const path of covered) lateLocked.add(path);
      byPath.set(lockPath, { ...holding, path: lockPath });
    }
    lateLockedHoldings = [...byPath.values()];
  }

  // Close a post-stage lock over both generated declaration halves before
  // the index is pruned. Otherwise the source can be held while its projection
  // still lands, leaving a torn declaration snapshot at HEAD.
  const lateDeclarationClosure = expandGeneratedDeclarationPairHolds(
    [...lateLocked],
    opts.generatedDeclarationPaths ?? [],
  );
  for (const path of lateDeclarationClosure.paths) {
    if (stagedSet.has(path)) lateLocked.add(path);
  }

  // 3. Working-tree drift, AFTER the census.
  const driftRes = await runGit(['diff', '--name-only', '--no-renames', '-z', '--ignore-submodules=all'], repoPath);
  if (driftRes.code !== 0) {
    return {
      ok: false,
      error: `post-stage guard could not compare the working tree to the index: ${gitFailureDetail(driftRes)}`,
    };
  }
  const drifted = new Set(
    driftRes.stdout
      .split('\0')
      .filter(Boolean)
      .filter((path) => stagedSet.has(path) && !lateLocked.has(path)),
  );
  // A staged DELETION whose file has reappeared is untracked, so `git diff` cannot list it;
  // ask for it as a non-ignored untracked file. An IGNORED file that stays on disk is the
  // deliberate untracking of runtime state (EI-22737671025165479), not drift, and
  // `--exclude-standard` leaves it out.
  const deletedRes = await runGit(
    ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=D'],
    repoPath,
  );
  if (deletedRes.code !== 0) {
    return {
      ok: false,
      error: `post-stage guard could not read staged deletions: ${gitFailureDetail(deletedRes)}`,
    };
  }
  const stagedDeletions = deletedRes.stdout.split('\0').filter((path) => path && !lateLocked.has(path));
  for (let i = 0; i < stagedDeletions.length; i += 500) {
    const chunk = stagedDeletions.slice(i, i + 500);
    const reappeared = await runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', ...chunk], repoPath);
    if (reappeared.code !== 0) {
      return {
        ok: false,
        error: `post-stage guard could not check reappeared deletions: ${gitFailureDetail(reappeared)}`,
      };
    }
    for (const path of reappeared.stdout.split('\0').filter(Boolean)) {
      if (stagedSet.has(path)) drifted.add(path);
    }
  }

  // 4. EI-21230011589307899: staged blobs the pre-stage content guard never judged. The index
  // is fixed since the add, so this may run after the census. Paths already held are skipped.
  const contentHeld = new Map<string, string>();
  if (opts.rescanStagedContent) {
    const candidates = staged.filter((path) => !lateLocked.has(path) && !drifted.has(path));
    try {
      for (const offender of await opts.rescanStagedContent(candidates, runGit)) {
        if (stagedSet.has(offender.file) && !contentHeld.has(offender.file)) {
          contentHeld.set(offender.file, `content guard (post-stage): ${offender.detectorKey}`);
          log(`[git-sync] ${scope}: post-stage content guard holds ${offender.file}: ${offender.detectorKey}: ${offender.error}`);
        }
      }
    } catch (error) {
      // FAILS OPEN like the pre-stage content guard: a detector bug must never wedge the commit.
      const detail = error instanceof Error ? error.message : String(error);
      log(`[git-sync] ${scope}: post-stage content rescan failed (fail-open) — ${detail}`);
    }
  }

  const held = [...new Set([...lateLocked, ...drifted, ...gitlinkGuard.paths, ...contentHeld.keys()])];
  const packageClosure =
    held.length > 0 ? await expandCargoPackageLiveLockExclusions(staged, held, opts.readText) : { paths: [], packages: [] };
  // An attributed commit's private index may omit a tracked provider whose edit
  // is staged elsewhere or remains unstaged. Unlike an untracked module, that
  // path still resolves in HEAD, but only to the old API; a staged importer that
  // needs a newly added export can therefore make the committed tree unbuildable.
  // Compare the working tree with this exact commit index and keep changed source
  // modules infectious until the provider version is included in a commit.
  const changedPathsRes = await runGit(
    ['diff', '--name-only', '--no-renames', '--diff-filter=ACMT', '-z', '--ignore-submodules=all'],
    repoPath,
  );
  if (changedPathsRes.code !== 0) {
    return {
      ok: false,
      error: `post-stage guard could not read tracked changes outside this index: ${gitFailureDetail(changedPathsRes)}`,
    };
  }
  const changedTrackedModulesOutsideIndex = new Set(
    changedPathsRes.stdout
      .split('\0')
      .filter(Boolean)
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/i.test(path)),
  );
  // Re-scan the actual index immediately before commit, not only the earlier dirty
  // census. New untracked importers can arrive while the lock refresh and content
  // guards run, then enter through the later `git add -A`; they must stay with every
  // dependency this commit is excluding.
  const alwaysInfectious = new Set([
    ...(opts.alwaysInfectiousDependencies ?? []),
    ...lateLocked,
    ...drifted,
    ...gitlinkGuard.paths,
    ...contentHeld.keys(),
    ...packageClosure.paths,
    ...changedTrackedModulesOutsideIndex,
  ]);
  const excludedDependencies = [...new Set([...(opts.excludedDependencies ?? []), ...alwaysInfectious])];
  // WI-10006734: an untracked module is absent from this commit whether or not anything
  // excluded it, so a staged importer of it is as unresolvable as an importer of an excluded
  // path. `runGit` is bound to the index this commit records (an attributed group's private
  // index), so "absent" is judged against exactly that tree.
  const absent = await untrackedModulesAbsentFromIndex(runGit, repoPath);
  if (!absent.ok) return { ok: false, error: `post-stage guard ${absent.error}` };
  const absentFromIndex = new Set(absent.paths);
  // EI-25671755634126843: an ignored, untracked dependency (e.g. an edited gitignored
  // node_modules file held as a protected path) is in no commit and never in HEAD, so a staged
  // importer of it loses nothing by committing: every checkout resolves the installed copy.
  // Treating it as infectious withheld every dirty importer of the package. check-ignore
  // without --no-index never reports a TRACKED path, so a tracked module under an ignore rule
  // stays infectious; on any check-ignore failure the classifier returns an empty set and every
  // dependency stays infectious, as before.
  const { ignoredUntracked } = await classifyProtectedPathExclusions(runGit, repoPath, excludedDependencies);
  if (ignoredUntracked.size > 0) {
    log(
      `[git-sync] ${scope}: post-stage guard: not holding importers of ${ignoredUntracked.size} ignored ` +
        `untracked dependency path(s), which no commit can contain: [${[...ignoredUntracked].join(', ')}]`,
    );
  }
  const importerDependencies = [...new Set([...excludedDependencies, ...absentFromIndex])].filter(
    (path) => !ignoredUntracked.has(path),
  );
  // WI-6554700010008496: name WHY each root was excluded, so a held importer's finding
  // points at the blocking file and its cause instead of a generic phase label.
  const postStageReasons = new Map<string, string>(opts.excludedDependencyReasons ?? []);
  const notePostStage = (paths: Iterable<string>, reason: string) => {
    for (const path of paths) if (!postStageReasons.has(path)) postStageReasons.set(path, reason);
  };
  notePostStage(lateLocked, 'locked after staging');
  notePostStage(drifted, 'changed on disk after staging');
  for (const [path, reason] of contentHeld) notePostStage([path], reason);
  notePostStage(gitlinkGuard.paths, 'gitlink guard');
  notePostStage(packageClosure.paths, 'package-closure exclusion');
  notePostStage(changedTrackedModulesOutsideIndex, 'changed tracked module outside this commit\'s index');
  notePostStage(absentFromIndex, 'untracked and absent from this commit');
  const unresolvableExclusions = new Set<string>([...gitlinkGuard.paths, ...packageClosure.paths]);
  const importerOffenders = importerDependencies.length > 0
    ? await detectQuarantineImporters({
        readText: opts.readText,
        dirtyFiles: staged,
        alreadyQuarantined: importerDependencies,
        // WI-6554700010008578: the guard consults this seam ONLY for side-effect-only edges
        // (`import './x';`), which name no export, so an old provider at HEAD satisfies them.
        // A tracked provider excluded from this commit (another group's change, a late lock,
        // drift) therefore must not hold such an importer: forcing every excluded path to
        // "absent" held the agent-tools/index.ts registration hub whenever ANY tool module it
        // loads was dirty elsewhere. Named imports never reach this seam and stay held.
        // Untracked providers and gitlink/package-closure exclusions stay unresolvable.
        sideEffectTargetAtHead: async (path) => {
          if (absentFromIndex.has(path) || unresolvableExclusions.has(path)) return false;
          return isModuleResolvableAtHead(runGit, repoPath, path, log);
        },
        exclusionLabel: 'post-stage exclusion, or untracked and absent from this commit',
        exclusionReasonFor: (path) => postStageReasons.get(path),
        log,
      })
    : [];
  const importers = importerOffenders.map((offender) => offender.file).filter((file) => stagedSet.has(file));
  for (const offender of importerOffenders) {
    if (stagedSet.has(offender.file)) log(`[git-sync] ${scope}: post-stage guard: ${offender.file} ${offender.error}`);
  }
  const providerOffenders = await detectStagedProvidersOfHeldImporters({
    stagedFiles: staged,
    heldImporters: [...new Set([...excludedDependencies, ...importers])],
    readHeadText: async (path) => {
      const result = await runGit(['show', `HEAD:${path}`], repoPath);
      return result.code === 0 ? result.stdout : null;
    },
    readIndexText: async (path) => {
      const result = await runGit(['show', `:${path}`], repoPath);
      return result.code === 0 ? result.stdout : null;
    },
    log,
  });
  const heldProviders = providerOffenders.map((offender) => offender.file).filter((file) => stagedSet.has(file));
  for (const offender of providerOffenders) {
    if (stagedSet.has(offender.file)) log(`[git-sync] ${scope}: post-stage guard: ${offender.file} ${offender.error}`);
  }
  // A cumulative-size exclusion can be the reason an already-staged generated-file deletion
  // was removed from the shared index. Preserve only that exact deletion. The pre-stage set
  // has already excluded paths with another exclusion; the post-stage checks here keep late
  // locks, drift, content/gitlink/package/provider conditions authoritative. Importers and
  // staged providers are appended separately below, so this exception cannot erase their holds.
  const cumulativeDeletionExemptions = new Set(
    stagedDeletions.filter(
      (path) =>
        opts.preserveCumulativeUntracking?.has(path) &&
        !lateLocked.has(path) &&
        !drifted.has(path) &&
        !contentHeld.has(path) &&
        !gitlinkGuard.paths.includes(path) &&
        !packageClosure.paths.includes(path) &&
        !changedTrackedModulesOutsideIndex.has(path),
    ),
  );
  const pathsToUnstage = [...new Set([
    ...excludedDependencies.filter((path) => !cumulativeDeletionExemptions.has(path)),
    ...importers,
    ...heldProviders,
  ])]
    .filter((path) => stagedSet.has(path));
  let unstagedPaths: string[] = [];
  if (pathsToUnstage.length > 0) {
    const unstage = await unstagePreStagedProtectedPaths(runGit, repoPath, pathsToUnstage, log);
    if (!unstage.ok) return { ok: false, error: `post-stage guard ${unstage.error}` };
    log(
      `[git-sync] ${scope}: post-stage guard held back ${unstage.paths.length} staged path(s) from this commit — ` +
        `late-locked [${[...lateLocked].join(', ')}], drifted after staging [${[...drifted].join(', ')}]` +
        (contentHeld.size > 0 ? `, content guard (post-stage) [${[...contentHeld.keys()].join(', ')}]` : '') +
        (packageClosure.paths.length > 0
          ? `, same Cargo package [${packageClosure.paths.join(', ')}]`
          : '') +
        (importers.length > 0 ? `, dirty importers [${[...new Set(importers)].join(', ')}]` : '') +
        (heldProviders.length > 0 ? `, staged providers with held HEAD consumers [${[...new Set(heldProviders)].join(', ')}]` : '') +
        ' — they stay dirty for the next tick',
    );
    unstagedPaths = unstage.paths;
  }
  // WI-10006352: LAST, once nothing else will change the index — a staged deletion the
  // commit's own tree still imports. The first round reuses the listing read above unless
  // the hold just changed the index.
  const deletionHold = await holdStagedDeletionsStillImported({
    runGit,
    repoPath,
    scope,
    log,
    firstListing: unstagedPaths.length === 0 ? deletedRes.stdout.split('\0').filter(Boolean) : undefined,
  });
  if (!deletionHold.ok) return deletionHold;
  return {
    ok: true,
    lateLockedHoldings,
    drifted: [...drifted],
    unstaged: [...new Set([...unstagedPaths, ...deletionHold.unstaged])],
  };
}

/**
 * WI-10006352: unstage every staged module deletion that the index (the tree `git commit`
 * records) still imports, to a fixed point — a held deletion returns its HEAD text to the
 * index, which may import another staged deletion. Each round unstages at least one path or
 * stops, so it terminates. The working tree is untouched: the file stays deleted and the next
 * tick retries the deletion once its importer has landed. Fails closed like the rest of the
 * post-stage guard when the index cannot be read.
 */
export async function holdStagedDeletionsStillImported(opts: {
  runGit: RunGit;
  repoPath: string;
  scope: string;
  log: (message: string) => void;
  firstListing?: readonly string[];
}): Promise<{ ok: true; unstaged: string[] } | { ok: false; error: string }> {
  const { runGit, repoPath, scope, log } = opts;
  const unstaged: string[] = [];
  let listing = opts.firstListing;
  for (;;) {
    const scan = await detectStagedDeletionsStillImported({ runGit, repoPath, stagedDeletions: listing, log });
    listing = undefined;
    if (!scan.ok) return { ok: false, error: `post-stage guard ${scan.error}` };
    if (scan.holds.length === 0) break;
    const unstage = await unstagePreStagedProtectedPaths(
      runGit,
      repoPath,
      scan.holds.map((hold) => hold.path),
      log,
    );
    if (!unstage.ok) return { ok: false, error: `post-stage guard ${unstage.error}` };
    log(
      `[git-sync] ${scope}: post-stage guard held back ${unstage.paths.length} staged deletion(s) the commit ` +
        `would still import — ` +
        scan.holds
          .map((hold) => `${hold.path} (${hold.scanError ? `index scan failed: ${hold.scanError}` : `imported by ${hold.importedBy.join(', ')}`})`)
          .join('; ') +
        ' — they stay deleted in the working tree for the next tick',
    );
    if (unstage.paths.length === 0) break;
    unstaged.push(...unstage.paths);
  }
  return { ok: true, unstaged };
}

/** The CI-skip suffix git-sync's message carries (e.g. ` [skip ci]`), so every per-agent
 *  commit skips CI exactly like the catch-all. Empty when the message has no such marker. */
function skipCiSuffix(message: string): string {
  const m = message.match(/(\[skip ci\])\s*$/i);
  return m ? ` ${m[1]}` : '';
}

/** Where a runner's git says the index lives. `rev-parse --git-path index` honours
 *  GIT_INDEX_FILE, so with a private env it also proves the runner forwarded it. */
async function resolveIndexPath(runGit: RunGit, repoPath: string, options?: GitRunOptions): Promise<string | null> {
  const r = await runGit(['rev-parse', '--git-path', 'index'], repoPath, options);
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) return null;
  return isAbsolute(out) ? out : resolvePath(repoPath, out);
}

/** The commit message argv shared by every attributed commit (subject, intent body, trailers). */
function attributedMessageArgs(
  g: ReturnType<typeof groupFilesForAttribution>[number],
  subject: string,
  suffix: string,
  intentBody: string | null,
  sweepMessageBody: string | null = null,
): string[] {
  const args = ['-m', `${subject}${suffix}`];
  if (intentBody) args.push('-m', intentBody);
  if (sweepMessageBody) args.push('-m', sweepMessageBody);
  const trailers = attributionTrailers(g);
  if (trailers.length > 0) args.push('-m', trailers.join('\n'));
  return args;
}

/**
 * The provenance trailers of one attributed commit, as ONE final paragraph.
 *
 * P-004 (deterministic-commit-workitem-attribution-2026-06-22): bounded provenance trailers so
 * the commit↔work-item link travels IN git history (and is read back post-sync into
 * git_sync_commit_attribution). Deterministic — from the ledger-derived attribution, no LLM.
 *
 * WI-6554700010029864: they must share one paragraph. git reads trailers only from a message's
 * LAST paragraph, and until 2026-10-27 each trailer was its own `-m`, so
 * `%(trailers:key=Papercusp-Agent)` returned nothing for every git-sync commit and the delta
 * check's trailer routing and the drift sweep's attribution both read null.
 */
export function attributionTrailers(g: ReturnType<typeof groupFilesForAttribution>[number]): string[] {
  const out: string[] = [];
  for (const coAuthor of g.coAuthors ?? (g.coAuthor ? [g.coAuthor] : [])) out.push(`Co-Authored-By: ${coAuthor}`);
  for (const agent of g.agents ?? (g.agent ? [g.agent] : [])) out.push(`Papercusp-Agent: ${agent}`);
  if (g.workItems && g.workItems.length > 0) out.push(`Papercusp-Work-Item: ${g.workItems.slice(0, 20).join(', ')}`);
  if (g.sessionId) out.push(`Papercusp-Session: ${g.sessionId}`);
  if (g.planSlug) out.push(`Papercusp-Plan: ${g.planSlug}`);
  // D-001 part 2: name the import-linked files no ledger row backs, so the agent trailer above
  // is not read as having authored them.
  const absorbed = g.absorbedUnattributed ?? [];
  if (absorbed.length > 0) {
    const more = absorbed.length > 20 ? ` (+${absorbed.length - 20} more)` : '';
    out.push(`Papercusp-Unattributed-Files: ${absorbed.slice(0, 20).join(', ')}${more}`);
  }
  return out;
}

/** Where a git-sync commit builds private indexes (WI-10006705 / WI-10006725). */
interface PrivateIndexSite {
  gitDir: string;
  sharedIndex: string | null;
  newIndexFile: () => string;
  bindIndex: (indexFile: string) => RunGit;
}

/**
 * Locate the git dir and prove the runner forwards `GitRunOptions.env`. A runner that
 * drops it would run read-tree/add/reset on the SHARED index, so this fails closed.
 * `label` prefixes the errors (e.g. `attributed commits`); `tag` names the index files.
 */
async function openPrivateIndexSite(
  runGit: RunGit,
  repoPath: string,
  label: string,
  tag: string,
): Promise<{ ok: true; site: PrivateIndexSite } | { ok: false; error: string }> {
  const gitDirRes = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  const gitDir = gitDirRes.stdout.trim();
  if (gitDirRes.code !== 0 || !gitDir) {
    return { ok: false, error: `${label} could not locate the git dir: ${gitFailureDetail(gitDirRes)}` };
  }
  const newIndexFile = (): string => join(gitDir, `papercusp-git-sync-${tag}-${process.pid}-${randomUUID()}.index`);
  const bindIndex = (indexFile: string): RunGit => (args, cwd, options) =>
    runGit(args, cwd, { ...options, env: { ...options?.env, GIT_INDEX_FILE: indexFile } });
  const probe = newIndexFile();
  const seen = await resolveIndexPath(bindIndex(probe), repoPath);
  if (seen !== resolvePath(probe)) {
    return {
      ok: false,
      error:
        `${label} refused: the git runner did not forward GIT_INDEX_FILE ` +
        `(git reported ${seen ?? 'no index path'}), so a private index cannot be isolated from the shared one`,
    };
  }
  return { ok: true, site: { gitDir, sharedIndex: await resolveIndexPath(runGit, repoPath), newIndexFile, bindIndex } };
}

/**
 * Copy the shared index for its stat cache WITHOUT defeating git's racy-entry check.
 *
 * Git trusts a cached stat only when the entry's mtime is older than the INDEX FILE's own
 * mtime; an entry written in the same second as the index is "racy" and is re-hashed. A
 * plain copy gets a fresh mtime, so every racy entry in it becomes trusted: a file rewritten
 * at the same size within the second its stat was cached reads as unchanged, and `add`
 * never picks the edit up (WI-10006725, found by the WI-39922 test). So the bytes and the
 * stamp come from ONE open file (a concurrent rename cannot pair new bytes with an old
 * stamp, or the reverse), and the copy is stamped at the shared index's mtime floored to
 * the second: never later than the original, so it can only make more entries racy.
 * Any failure removes the copy, and the caller seeds without a stat cache.
 */
async function copyIndexKeepingRacyStamp(sharedIndex: string, indexFile: string): Promise<void> {
  try {
    const handle = await open(sharedIndex, 'r');
    try {
      const st = await handle.stat();
      await writeFile(indexFile, await handle.readFile());
      const stamp = Math.floor(st.mtimeMs / 1000);
      await utimes(indexFile, stamp, stamp);
    } finally {
      await handle.close();
    }
  } catch {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

/**
 * Seed `indexFile` (bound into `privateGit`) at HEAD, the CAS base. `read-tree -m` over a
 * copy of the shared index keeps its stat cache, so later diffs stay cheap; an unmerged
 * shared index refuses that merge, so it falls back to a plain read. A non-zero HEAD read
 * is an unborn branch (or an unreadable HEAD — the empty-old CAS then refuses).
 */
async function seedPrivateIndex(
  runGit: RunGit,
  privateGit: RunGit,
  repoPath: string,
  indexFile: string,
  sharedIndex: string | null,
  label: string,
): Promise<{ ok: true; base: string | null; baseTree: string } | { ok: false; error: string }> {
  const headRes = await runGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoPath);
  const base = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null;
  if (base && sharedIndex) await copyIndexKeepingRacyStamp(sharedIndex, indexFile);
  let seed = await privateGit(base ? ['read-tree', '-m', base] : ['read-tree', '--empty'], repoPath);
  if (seed.code !== 0 && base) {
    await rm(indexFile, { force: true }).catch(() => {});
    seed = await privateGit(['read-tree', base], repoPath);
  }
  if (seed.code !== 0) {
    return { ok: false, error: `${label} could not seed its private index: ${gitFailureDetail(seed)}` };
  }
  const baseTreeRes = base
    ? await runGit(['rev-parse', '--verify', '-q', `${base}^{tree}`], repoPath)
    : await privateGit(['write-tree'], repoPath); // the empty tree, in this repo's hash
  const baseTree = baseTreeRes.stdout.trim();
  if (baseTreeRes.code !== 0 || !baseTree) {
    return { ok: false, error: `${label} could not read the base tree: ${gitFailureDetail(baseTreeRes)}` };
  }
  return { ok: true, base, baseTree };
}

/** Argv batch size for `update-index` entries (keeps one call well under ARG_MAX). */
const CARRY_UPDATE_INDEX_BATCH = 200;

/**
 * WI-10006725: carry the shared index's TRACKED-SET changes into a catch-all private index
 * seeded at HEAD. `add -A` rebuilds every other staged state from the working tree, but it
 * never changes an IGNORED path's membership. Without this, a `git rm --cached` of an ignored
 * file (git-sync's own dependency-generation untracks, or an agent's) would be re-committed
 * from HEAD, and a `git add -f` of an ignored file would never be committed. So entries the
 * shared index ADDED or DELETED relative to the base tree are copied over as they are; the
 * caller's `add -A` then brings each carried entry up to the working tree, and the
 * post-stage guard inspects the result like any other staged path. Excluded additions are never
 * carried; only explicitly preserved cumulative-size untracking deletions cross that filter.
 * Read before the guard, so a later peer write to the shared index cannot reach it.
 */
async function carrySharedIndexMembership(
  runGit: RunGit,
  privateGit: RunGit,
  repoPath: string,
  baseTree: string,
  isExcluded: (path: string) => boolean,
  carryExcludedDeletions: ReadonlySet<string> = new Set(),
): Promise<{ ok: true; added: number; removed: number } | { ok: false; error: string }> {
  const diff = await runGit(['diff-index', '--cached', '-z', '--no-renames', '--diff-filter=AD', baseTree, '--'], repoPath);
  if (diff.code !== 0) {
    return { ok: false, error: `could not read the shared index's added/deleted entries: ${gitFailureDetail(diff)}` };
  }
  // Raw -z records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const fields = diff.stdout.split('\0');
  const additions: string[] = [];
  const removals: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].trim();
    const path = fields[i + 1];
    if (!meta.startsWith(':') || !path) continue;
    const [, dstMode, , dstSha, status] = meta.slice(1).split(' ');
    const excluded = isExcluded(path);
    if (status === 'A' && dstMode && dstSha && !excluded) additions.push('--cacheinfo', dstMode, dstSha, path);
    else if (status === 'D' && (!excluded || carryExcludedDeletions.has(path))) removals.push(path);
  }
  for (let i = 0; i < removals.length; i += CARRY_UPDATE_INDEX_BATCH) {
    const batch = removals.slice(i, i + CARRY_UPDATE_INDEX_BATCH);
    const res = await privateGit(['update-index', '--force-remove', '--', ...batch], repoPath);
    if (res.code !== 0) return { ok: false, error: `could not carry staged deletions: ${gitFailureDetail(res)}` };
  }
  // Four argv words per entry.
  for (let i = 0; i < additions.length; i += CARRY_UPDATE_INDEX_BATCH * 4) {
    const batch = additions.slice(i, i + CARRY_UPDATE_INDEX_BATCH * 4);
    const res = await privateGit(['update-index', '--add', '--replace', ...batch], repoPath);
    if (res.code !== 0) return { ok: false, error: `could not carry staged additions: ${gitFailureDetail(res)}` };
  }
  return { ok: true, added: additions.length / 4, removed: removals.length };
}

/**
 * Commit exactly what the private index holds and publish it only if HEAD is still `base`:
 * `write-tree` (equal to the base tree = nothing to commit), `commit-tree -p <base>`, then
 * `update-ref HEAD <new> <base>`. The message is built lazily, after the nothing check.
 * `beforePublish` runs after the commit object exists and before the CAS; a failure there
 * returns an error and publishes nothing.
 */
async function publishPrivateIndexCommit(
  runGit: RunGit,
  privateGit: RunGit,
  repoPath: string,
  p: {
    base: string | null;
    baseTree: string;
    label: string;
    reflogMessage: string;
    messageArgs: () => Promise<string[]>;
    beforePublish?: (commit: string, tree: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    onPublished?: (sha: string) => void;
  },
): Promise<
  | { status: 'nothing' }
  | { status: 'committed'; commit: string; tree: string }
  | { status: 'cas-refused'; detail: string }
  | { status: 'error'; error: string }
> {
  const treeRes = await privateGit(['write-tree'], repoPath);
  const tree = treeRes.stdout.trim();
  if (treeRes.code !== 0 || !tree) return { status: 'error', error: `${p.label} failed: ${gitFailureDetail(treeRes)}` };
  if (tree === p.baseTree) return { status: 'nothing' };
  const commitArgs = [
    ...GIT_SYNC_IDENTITY_ARGS,
    'commit-tree',
    tree,
    ...(p.base ? ['-p', p.base] : []),
    ...(await p.messageArgs()),
  ];
  const c = await runGit(commitArgs, repoPath);
  const commit = c.stdout.trim();
  if (c.code !== 0 || !commit) return { status: 'error', error: `${p.label} failed: ${gitFailureDetail(c)}` };
  if (p.beforePublish) {
    const ready = await p.beforePublish(commit, tree);
    if (!ready.ok) return { status: 'error', error: ready.error };
  }
  const cas = await runGit(['update-ref', '-m', p.reflogMessage, 'HEAD', commit, p.base ?? ''], repoPath);
  if (cas.code !== 0) return { status: 'cas-refused', detail: gitFailureDetail(cas) };
  p.onPublished?.(commit);
  return { status: 'committed', commit, tree };
}

/**
 * Commit selected paths in an isolated index before per-agent groups. Used for
 * superproject gitlinks so a root source commit can never publish against the
 * previous submodule pin.
 */
async function commitPriorityPaths(
  runGit: RunGit,
  repoPath: string,
  paths: readonly string[],
  message: string,
  diffSubjects: boolean | undefined,
  beforeCommit?: (privateRunGit: RunGit) => Promise<{ ok: true } | { ok: false; error: string }>,
  log: (m: string) => void = () => {},
  onPublished?: (sha: string) => void,
): Promise<
  | { status: 'nothing' }
  | { status: 'committed' }
  | { status: 'cas-refused'; detail: string }
  | { status: 'error'; error: string }
> {
  if (paths.length === 0) return { status: 'nothing' };
  const opened = await openPrivateIndexSite(runGit, repoPath, 'priority path commit', 'priority');
  if (!opened.ok) return { status: 'error', error: opened.error };

  const { site } = opened;
  const indexFile = site.newIndexFile();
  const privateGit = site.bindIndex(indexFile);
  try {
    const seeded = await seedPrivateIndex(runGit, privateGit, repoPath, indexFile, site.sharedIndex, 'priority path commit');
    if (!seeded.ok) return { status: 'error', error: seeded.error };
    const add = await privateGit(['add', '--', ...paths], repoPath);
    if (add.code !== 0) {
      return { status: 'error', error: 'priority path add failed: ' + gitFailureDetail(add) };
    }
    if (beforeCommit) {
      const guard = await beforeCommit(privateGit);
      if (!guard.ok) return { status: 'error', error: guard.error };
    }

    const published = await publishPrivateIndexCommit(runGit, privateGit, repoPath, {
      base: seeded.base,
      baseTree: seeded.baseTree,
      label: 'priority path commit',
      reflogMessage: 'git-sync: priority submodule gitlinks',
      onPublished,
      messageArgs: async () => {
        if (diffSubjects === false) return ['-m', message];
        const numstat = await privateGit(
          ['diff', '--cached', '--numstat', ...(seeded.base ? [seeded.base] : []), '--', ...paths],
          repoPath,
        );
        const subject =
          numstat.code === 0
            ? diffDerivedSubject([...paths], parseNumstat(numstat.stdout))
            : 'sync(submodules): update gitlinks';
        return ['-m', subject + skipCiSuffix(message), '-m', message];
      },
      beforePublish: async (commit, tree) => {
        const changed = await runGit(['diff', '--name-only', '--no-renames', '-z', seeded.baseTree, tree], repoPath);
        if (changed.code !== 0) {
          return {
            ok: false,
            error: 'priority path commit not published: could not list its paths: ' + gitFailureDetail(changed),
          };
        }
        const committedPaths = changed.stdout.split('\0').filter(Boolean);
        if (committedPaths.length === 0) return { ok: true };
        const literal = { env: { GIT_LITERAL_PATHSPECS: '1' } };
        const resetArgs = ['reset', '-q', commit, '--', ...committedPaths];
        const refresh = await recoverIndexLockContention(
          await runGit(resetArgs, repoPath, literal),
          () => runGit(resetArgs, repoPath, literal),
          runGit,
          repoPath,
          'priority shared-index refresh',
          log,
        );
        if (refresh.code === 0) return { ok: true };
        return {
          ok: false,
          error:
            'priority path commit not published: the shared index could not be refreshed for ' +
            committedPaths.length +
            ' path(s): ' +
            gitFailureDetail(refresh),
        };
      },
    });
    if (published.status === 'committed') return { status: 'committed' };
    if (published.status === 'cas-refused') return { status: 'cas-refused', detail: published.detail };
    if (published.status === 'error') return { status: 'error', error: published.error };
    return { status: 'nothing' };
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
    await rm(indexFile + '.lock', { force: true }).catch(() => {});
  }
}

/** Argv batch size for the vanished-path `ls-files` probe. */
const VANISHED_PATH_PROBE_BATCH = 500;

/** Local object custody, deliberately outside every normal branch push refspec. */
export const SOURCE_CUSTODY_REF_PREFIX = 'refs/papercusp/source-custody/';

interface SourceCustodyManifest {
  version: 1;
  repository: string;
  path: string;
  oid: string;
  mode: string;
  owner: string;
  base: string | null;
}

export type SourceCustodyResult =
  | { ok: true; protectedPaths: string[]; refs: string[] }
  | { ok: false; error: string };

/** Never include Git output here: it may contain the source being protected. */
const custodyRefused = (reason: string): { ok: false; error: string } => ({
  ok: false,
  error: `source-custody-refused:${reason}`,
});

/** The exact scratch leaves written by dependency-generation.sh, not a directory heuristic. */
function isGeneratedCustodyPhantom(path: string): boolean {
  return /^\.papercusp\/dependency-exact-ref\/[^/]+\/\.(?:live|ref)-inputs$/.test(path);
}

/**
 * Preserve readable SHARED-index objects before any index consumer can forget them.
 * The payload uses its existing blob OID, so binary/invalid-UTF8 bytes never round-trip
 * through RunGit's text stdout. An EMPTY private tree jointly roots that blob and its
 * manifest. No HEAD, shared-index or worktree write is part of taking custody.
 */
export async function preserveVanishedStagedSources(
  sharedGit: RunGit,
  repoPath: string,
  attribution: ReadonlyMap<string, FileAttribution> = new Map(),
  log: (message: string) => void = () => {},
): Promise<SourceCustodyResult> {
  try {
    return await preserveVanishedStagedSourcesPass(sharedGit, repoPath, attribution, log);
  } catch {
    return custodyRefused('preflight-exception');
  }
}

async function preserveVanishedStagedSourcesPass(
  sharedGit: RunGit,
  repoPath: string,
  attribution: ReadonlyMap<string, FileAttribution> = new Map(),
  log: (message: string) => void = () => {},
): Promise<SourceCustodyResult> {
  // Do NOT combine --deleted with --stage: --stage also enables --cached,
  // which includes still-present staged additions in Git's output.
  const deleted = await sharedGit(['ls-files', '--deleted', '-z'], repoPath);
  if (deleted.code !== 0) return custodyRefused('shared-index-read');
  const observedMissing = [...new Set(deleted.stdout.split('\0').filter(Boolean))];
  if (observedMissing.length === 0) return { ok: true, protectedPaths: [], refs: [] };
  if (observedMissing.some((path) => isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '.'))) {
    return custodyRefused('unsafe-index-path');
  }
  const entries = new Map<string, { mode: string; oid: string; stage: string }>();
  const observedSet = new Set(observedMissing);
  for (let i = 0; i < observedMissing.length; i += VANISHED_PATH_PROBE_BATCH) {
    const listed = await sharedGit(['ls-files', '--stage', '-z', '--', ...observedMissing.slice(i, i + VANISHED_PATH_PROBE_BATCH)], repoPath, { env: { GIT_LITERAL_PATHSPECS: '1' } });
    if (listed.code !== 0) return custodyRefused('shared-index-read');
    for (const record of listed.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) return custodyRefused('malformed-index-entry');
      const [, mode, oid, stage, path] = match;
      if (!observedSet.has(path)) return custodyRefused('unexpected-index-path');
      if (stage !== '0') return custodyRefused('unmerged-index-entry');
      entries.set(path, { mode, oid, stage });
    }
  }
  if (entries.size < observedMissing.length) log('[git-sync] source custody not-available for vanished path(s) without a shared-index entry');
  if (entries.size === 0) return { ok: true, protectedPaths: [], refs: [] };
  // --deleted is the observed-missing snapshot. A peer may restore the path
  // immediately after that read; lstat must not revoke custody for this pass.
  const missing = [...entries.keys()];
  const head = await sharedGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoPath);
  if (head.code !== 0 && head.code !== 1) return custodyRefused('base-read');
  if (head.code === 0 && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.stdout.trim())) return custodyRefused('base-read');
  const base = head.code === 0 ? head.stdout.trim() : null;
  const tracked = new Set<string>();
  if (base) {
    for (let i = 0; i < missing.length; i += VANISHED_PATH_PROBE_BATCH) {
      const tree = await sharedGit(
        ['ls-tree', '-z', '--full-tree', base, '--', ...missing.slice(i, i + VANISHED_PATH_PROBE_BATCH)],
        repoPath,
        { env: { GIT_LITERAL_PATHSPECS: '1' } },
      );
      if (tree.code !== 0) return custodyRefused('base-tree-read');
      for (const row of tree.stdout.split('\0').filter(Boolean)) {
        const tab = row.indexOf('\t');
        if (tab < 0) return custodyRefused('malformed-base-tree');
        tracked.add(row.slice(tab + 1));
      }
    }
  }
  const candidates = missing.filter((path) => !tracked.has(path) && !isGeneratedCustodyPhantom(path));
  if (candidates.length === 0) return { ok: true, protectedPaths: [], refs: [] };
  const opened = await openPrivateIndexSite(sharedGit, repoPath, 'source custody', 'source-custody');
  if (!opened.ok) return custodyRefused('private-index-isolation');
  const repository = await realpath(repoPath);
  const refs: string[] = [];
  for (const path of candidates) {
    const entry = entries.get(path)!;
    if (!['100644', '100755', '120000'].includes(entry.mode)) return custodyRefused('unsupported-index-mode');
    if (![40, 64].includes(entry.oid.length)) return custodyRefused('unsupported-object-format');
    const type = await sharedGit(['cat-file', '-t', entry.oid], repoPath);
    if (type.code !== 0 || type.stdout.trim() !== 'blob') return custodyRefused('source-blob-read');
    const manifest: SourceCustodyManifest = {
      version: 1, repository, path, oid: entry.oid, mode: entry.mode,
      owner: attribution.get(path)?.agent || 'unknown', base,
    };
    const manifestText = JSON.stringify(manifest) + '\n';
    const key = createHash('sha256').update(manifestText).digest('hex');
    const ref = SOURCE_CUSTODY_REF_PREFIX + key;
    const verify = async (): Promise<boolean> => {
      const objectType = await sharedGit(['cat-file', '-t', ref], repoPath);
      if (objectType.code !== 0 || objectType.stdout.trim() !== 'tree') return false;
      const target = await sharedGit(['rev-parse', '--verify', '-q', `${ref}^{tree}`], repoPath);
      if (target.code !== 0 || !target.stdout.trim()) return false;
      const tree = await sharedGit(['ls-tree', '-z', target.stdout.trim()], repoPath);
      if (tree.code !== 0) return false;
      const rows = tree.stdout.split('\0').filter(Boolean);
      if (rows.length !== 2 || !rows.includes(`${entry.mode} blob ${entry.oid}\tpayload`)) return false;
      const metadata = rows.find((row) => row.endsWith('\tmanifest.json'));
      const metadataMatch = metadata && /^100644 blob ([a-f0-9]+)\tmanifest\.json$/.exec(metadata);
      if (!metadataMatch) return false;
      const readback = await sharedGit(['cat-file', 'blob', metadataMatch[1]], repoPath);
      const payload = await sharedGit(['cat-file', '-e', `${entry.oid}^{blob}`], repoPath);
      return readback.code === 0 && readback.stdout === manifestText && payload.code === 0;
    };
    const existing = await sharedGit(['show-ref', '--verify', '--quiet', ref], repoPath);
    if (existing.code === 0) {
      if (!(await verify())) return custodyRefused('existing-ref-mismatch');
      refs.push(ref);
      continue;
    }
    if (existing.code !== 1) return custodyRefused('recovery-ref-read');
    const indexFile = opened.site.newIndexFile();
    const manifestFile = indexFile + '.manifest';
    const privateGit = opened.site.bindIndex(indexFile);
    try {
      const empty = await privateGit(['read-tree', '--empty'], repoPath);
      if (empty.code !== 0) return custodyRefused('empty-private-tree');
      await writeFile(manifestFile, manifestText, { mode: 0o600, flag: 'wx' });
      const hashed = await sharedGit(['hash-object', '-w', '--no-filters', '--', manifestFile], repoPath);
      if (hashed.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(hashed.stdout.trim())) {
        return custodyRefused('manifest-blob-write');
      }
      const inserted = await privateGit([
        'update-index', '--add', '--cacheinfo', entry.mode, entry.oid, 'payload',
        '--cacheinfo', '100644', hashed.stdout.trim(), 'manifest.json',
      ], repoPath);
      if (inserted.code !== 0) return custodyRefused('payload-manifest-root');
      const tree = await privateGit(['write-tree'], repoPath);
      const oid = tree.stdout.trim();
      if (tree.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) return custodyRefused('private-tree-write');
      // A concurrent identical creator is safe only after the same complete readback.
      const written = await sharedGit(['update-ref', ref, oid, '0'.repeat(oid.length)], repoPath);
      if (!(await verify())) return custodyRefused(written.code === 0 ? 'recovery-ref-readback' : 'recovery-ref-write');
      refs.push(ref);
    } catch {
      return custodyRefused('persistence-exception');
    } finally {
      await rm(indexFile, { force: true }).catch(() => {});
      await rm(indexFile + '.lock', { force: true }).catch(() => {});
      await rm(manifestFile, { force: true }).catch(() => {});
    }
  }
  for (const ref of refs) log(`[git-sync] source custody verified ${ref}`);
  // Keep these paths out of every subsequent private tree, including a peer's later
  // same-byte or different-byte restoration. They stay pending for the next pass.
  return { ok: true, protectedPaths: candidates, refs };
}

/**
 * WI-6554700010018197: drop the group paths that exist in NEITHER the working tree NOR the
 * HEAD-seeded private index. `dirtyFiles` reads `git status` over the SHARED index, so an
 * entry staged only there (a temp file `git add`ed and then deleted, status `AD`) is listed
 * as dirty, while the private index, seeded at HEAD, never holds it: `git add -- <path>` then
 * fails "pathspec did not match any files". One such phantom
 * (`.papercusp/dependency-exact-ref/<id>/.live-inputs`) failed the residual group on every
 * superproject tick from 2026-10-16T17:32Z to 2026-10-20T06:48Z. A path absent from the
 * working tree but present in the private index is a real deletion and is kept, so `add`
 * stages it. Only the paths lstat cannot find are probed, in literal-pathspec batches.
 */
async function dropVanishedPaths(
  privateGit: RunGit,
  repoPath: string,
  files: readonly string[],
): Promise<{ ok: true; files: string[]; vanished: string[] } | { ok: false; error: string }> {
  const missing: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        await lstat(join(repoPath, file));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') missing.push(file);
      }
    }),
  );
  if (missing.length === 0) return { ok: true, files: [...files], vanished: [] };
  const indexed = new Set<string>();
  for (let i = 0; i < missing.length; i += VANISHED_PATH_PROBE_BATCH) {
    const batch = missing.slice(i, i + VANISHED_PATH_PROBE_BATCH);
    const res = await privateGit(['ls-files', '-z', '--', ...batch], repoPath, { env: { GIT_LITERAL_PATHSPECS: '1' } });
    if (res.code !== 0) return { ok: false, error: `could not check vanished paths: ${gitFailureDetail(res)}` };
    for (const entry of res.stdout.split('\0').filter(Boolean)) indexed.add(entry);
  }
  const isIndexed = (file: string): boolean =>
    indexed.has(file) || [...indexed].some((entry) => entry.startsWith(file + '/'));
  const vanished = new Set(missing.filter((file) => !isIndexed(file)));
  return { ok: true, files: files.filter((file) => !vanished.has(file)), vanished: [...vanished] };
}

/** One attributed/residual group that did not publish, and why (WI-6554700010018197). */
export interface AttributedGroupFailure {
  /** The group's agent; null for the anonymous residual group. */
  agent: string | null;
  files: number;
  error: string;
}

/**
 * P-004 (git-sync-dx-hardening): peel each declaring agent's dirty files into its OWN commit
 * (intent subject + a Co-Authored-By trailer), preserving the CI-skip marker. Excluded files
 * (oversized / content offenders) stay quarantined. The catch-all (agent=null) group is left
 * for the caller's existing whole-tree commit. A cooperative yield from beforeCommit
 * propagates after private-index cleanup.
 *
 * WI-6554700010018197: a failure is per GROUP, not per phase. A group whose seed, add, guard
 * or publish fails is recorded in `groupFailures` and skipped (its files stay dirty for the
 * caller's catch-all), and the loop goes on to the next group, which is seeded afresh from
 * HEAD and guarded against everything outside its own index. Before, the first failing group
 * returned, and every later agent's files went to the anonymous catch-all: the residual
 * group runs first, so one bad residual path voided attribution for the whole tick (an 85h
 * superproject outage). `error` joins the per-group errors so the caller still logs them.
 * Only phase-wide refusals (no private index; a priority gitlink that cannot land) return
 * before the loop.
 * Exported for the P-004 commit-grouping test (injected runGit, no real repo).
 *
 * WI-10006705: each group is built in a PRIVATE index, never the shared one. The
 * shared index is writable by anything on the tree (an agent's `git add`, the merge
 * resolver, a second git-sync flow), and the old path ran `git add` → guard →
 * `git commit` on it. `git commit` records the whole index, so a path a peer staged
 * after the guard read (or one the guard had just unstaged) was committed anyway:
 * 84959c3039 swept a foreign pre-staged test and a guard-flagged importer, and the
 * staging bundle broke. Per group, now:
 *   1. read HEAD (the CAS base) and seed a private GIT_INDEX_FILE from it (`read-tree -m`
 *      over a copy of the shared index keeps its stat cache, so later diffs stay cheap);
 *   2. `add` only the group's files and run the guard (`beforeCommit`) against THAT index;
 *   3. `write-tree` + `commit-tree -p <base>`, so the commit is exactly what the guard saw;
 *   4. `update-ref HEAD <new> <base>`: if anything moved HEAD meanwhile the CAS refuses,
 *      nothing lands, and the files stay dirty for the catch-all / next tick;
 *   5. BEFORE that CAS (WI-10006850), reset the shared index's entries for the committed
 *      paths to the new commit, so it never holds the pre-commit blobs under the new HEAD
 *      (they read as staged reverts). A refresh that fails (a live index.lock) publishes
 *      nothing and aborts the phase.
 * The runner must forward `GitRunOptions.env`; it is probed once and the phase refuses
 * (the caller falls through to the catch-all) rather than ever touching the shared index.
 */
/** One repo's attributed phase in one tick, as carried on GitSyncOutcome.attribution
 *  (WI-6554700010018198). `scope` is the repo label git_sync_commit_attribution uses
 *  ('superproject' or the submodule path from the top-level root; WI-6554700010018409), which
 *  differs from skippedPaths' install-relative label only for a submodule install. */
export interface AttributionTally {
  scope: string;
  agentGroupCount: number;
  agentCommitCount: number;
  failedGroups: number;
  error: string | null;
  /** P-003 (gate-systems-as-designed-2026-10-27): files this pass committed that the
   *  edit ledger attributes to an agent. Absent when the share could not be measured. */
  attributableFileCount?: number;
  /** Of `attributableFileCount`, the files that landed in a commit naming an agent. */
  attributedFileCount?: number;
}

/**
 * P-003 (gate-systems-as-designed-2026-10-27): of the files a commit pass published that
 * the edit ledger attributes to an agent, how many landed in a commit that names one.
 *
 * Group counts could not see the failure P-001 measured: one sweep merged 8 groups into 2
 * and sent 36 files to the anonymous catch-all while `agentCommitCount` stayed non-zero,
 * so the zero-attribution alarm never fired. This counts files, read back from the
 * commits that actually published, so every route an attributable file takes into an
 * anonymous commit counts against the share (residual absorption, a failed or
 * CAS-refused group swept by the catch-all), and a file held out of every commit does
 * not. `forceCatchAllPaths` are anonymous on purpose (a regenerated declaration pair) and
 * are left out. A commit git cannot read is skipped; this never throws.
 */
export async function measureAttributedFileShare(
  runGit: RunGit,
  repoPath: string,
  publishedShas: readonly string[],
  attribution: ReadonlyMap<string, unknown> | undefined,
  forceCatchAllPaths: readonly string[] = [],
): Promise<{ attributableFileCount: number; attributedFileCount: number }> {
  let attributableFileCount = 0;
  let attributedFileCount = 0;
  if (!attribution || attribution.size === 0) return { attributableFileCount, attributedFileCount };
  const forced = new Set(forceCatchAllPaths);
  for (const sha of new Set(publishedShas)) {
    try {
      const message = await runGit(['log', '-1', `--format=${COMMIT_MESSAGE_FORMAT}`, sha], repoPath);
      const changed = await runGit(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--root', sha],
        repoPath,
      );
      if (message.code !== 0 || changed.code !== 0) continue;
      const named = readCommitAgents(message.stdout).agents.length > 0;
      for (const file of changed.stdout.split('\0')) {
        if (!file || forced.has(file) || !attribution.has(file)) continue;
        attributableFileCount += 1;
        if (named) attributedFileCount += 1;
      }
    } catch {
      // An unreadable commit drops out of both counts.
    }
  }
  return { attributableFileCount, attributedFileCount };
}

/** What one attributed phase did (WI-6554700010018197, WI-6554700010018198). */
export interface AttributedGroupsResult {
  committedAny: boolean;
  committedCount: number;
  /** Per-agent groups (agent !== null) that had dirty files this pass. */
  agentGroupCount: number;
  /** Of those, how many published a commit carrying the agent's trailer. Zero with a
   *  non-zero agentGroupCount is an attribution failure: the agents' work went to the
   *  anonymous catch-all. */
  agentCommitCount: number;
  error?: string;
  /** Custody failure is repository-fatal, unlike ordinary per-group failures. */
  custodyFatal?: true;
  /** Retained by the outer catch-all even if the path was restored meanwhile. */
  custodyProtectedPaths?: string[];
  /** Present only when at least one group failed (WI-6554700010018197). */
  groupFailures?: AttributedGroupFailure[];
}

export async function commitAttributedGroups(
  runGit: RunGit,
  repoPath: string,
  attribution: Map<string, FileAttribution>,
  excludePaths: string[],
  message: string,
  opts: CommitAttributedGroupsOpts = {},
): Promise<AttributedGroupsResult> {
  const tally = { agentGroupCount: 0, agentCommitCount: 0 };
  const custody = await preserveVanishedStagedSources(runGit, repoPath, attribution, opts.log);
  if (!custody.ok) return { ...tally, committedAny: false, committedCount: 0, custodyFatal: true, error: custody.error };
  const res = await commitAttributedGroupsPass(
    runGit, repoPath, attribution, [...excludePaths, ...custody.protectedPaths], message,
    { ...opts, custodyPaths: [...(opts.custodyPaths ?? []), ...custody.protectedPaths] }, tally,
  );
  return { ...res, ...tally, ...(custody.protectedPaths.length > 0 ? { custodyProtectedPaths: custody.protectedPaths } : {}) };
}

type CommitAttributedGroupsOpts = Parameters<typeof commitAttributedGroupsPass>[5];

async function commitAttributedGroupsPass(
  runGit: RunGit,
  repoPath: string,
  attribution: Map<string, FileAttribution>,
  excludePaths: string[],
  message: string,
  opts: {
    diffSubjects?: boolean;
    /** Paths that must stay in the anonymous residual group even when attributed. */
    forceCatchAllPaths?: string[];
    /** Captured paths remain unpublished even if a peer restores them during this pass. */
    custodyPaths?: readonly string[];
    /** Paths that must land before attributed source groups, normally superproject gitlinks. */
    priorityPaths?: string[];
    /** Keep attributed sources out of the catch-all when a protected priority path cannot land. */
    deferAttributedPaths?: (paths: string[]) => void;
    /** EI-24712906810240170: runs after each group's add and before its commit (see
     *  guardStagedIndexBeforeCommit). WI-10006705: it receives the runner bound to the
     *  group's PRIVATE index and must guard through it. A failure skips that group only
     *  (WI-6554700010018197). */
    beforeCommit?: (privateRunGit: RunGit) => Promise<{ ok: true } | { ok: false; error: string }>;
    onPublished?: (sha: string) => void;
    /** WI-6554700010019415: working-tree text for the import edges that merge linked groups.
     *  Defaults to reading `repoPath`. */
    readText?: (relPath: string) => Promise<string | null>;
    /** WI-10006519: receives the stale-lock recovery diagnostics. */
    log?: (m: string) => void;
  } = {},
  tally: { agentGroupCount: number; agentCommitCount: number },
): Promise<Omit<AttributedGroupsResult, 'agentGroupCount' | 'agentCommitCount'>> {
  // Flag-OFF degradation: with nothing attributed there is no per-agent work, and the
  // residual is exactly the caller's catch-all, so open no private index at all.
  if (attribution.size === 0) return { committedAny: false, committedCount: 0 };
  const excludeSet = new Set(excludePaths);
  // Child worktree edits cannot change a superproject gitlink. Status also
  // reports staged reverts when the shared index has an obsolete gitlink, so
  // even --ignore-submodules=dirty cannot establish a pending pointer change.
  const allDirty = await dirtyFiles(runGit, repoPath, { ignoreSubmodules: 'dirty' });
  const prioritySet = new Set(opts.priorityPaths ?? []);
  const pendingPriorityPaths = async (paths: string[]): Promise<string[]> => {
    const pending: string[] = [];
    for (const path of paths.filter((f) => prioritySet.has(f))) {
      const committed = await runGit(['rev-parse', '--verify', `HEAD:${path}`], repoPath);
      const childHead = await headSha(runGit, join(repoPath, path));
      // An unreadable pin is unknown, not proof that the pointer is unchanged.
      if (committed.code !== 0 || !committed.stdout.trim() || !childHead || committed.stdout.trim() !== childHead) {
        pending.push(path);
      }
    }
    return pending;
  };
  const dirtyPriorityPaths = await pendingPriorityPaths(allDirty);
  const blockedPriorityPaths = dirtyPriorityPaths.filter((f) => excludeSet.has(f));
  const dirty = allDirty.filter((f) => !excludeSet.has(f) && !prioritySet.has(f));
  // Commit the anonymous residual first. Script-created and otherwise unattributed
  // files must not wait behind every per-agent group in a long local-sync pass.
  // The caller's final add -A remains the safety net for arrivals and failed groups.
  const forceCatchAll = new Set(opts.forceCatchAllPaths ?? []);
  // WI-6554700010029864: a declaration git-sync regenerated beside an attributed source joins that
  // source's group instead of sitting in the residual and pulling the group in with it.
  const groupAttribution = inheritCompanionDeclarationAttribution(
    dirty.filter((path) => !forceCatchAll.has(path)),
    forceCatchAll.size === 0
      ? attribution
      : new Map([...attribution].filter(([path]) => !forceCatchAll.has(path))),
  );
  // The durable edit ledger supplies native-edit ages. Sample working-tree mtimes only for
  // attributed paths without a ledger row, so presence-only/script edits still get an age without
  // adding a filesystem read for normally recorded native edits. These are scheduling hints only;
  // post-stage guards still decide whether a changing path can commit.
  const workingTreeMtimeMsByFile = new Map<string, number>();
  const repoRoot = resolvePath(repoPath);
  await Promise.all(
    dirty
      .filter((file) => {
        if (!groupAttribution.has(file)) return false;
        const editedAtMs = groupAttribution.get(file)?.editedAtMs;
        return typeof editedAtMs !== 'number' || !Number.isFinite(editedAtMs);
      })
      .map(async (file) => {
        let candidate = resolvePath(repoRoot, file);
        while (candidate !== repoRoot) {
          const relativeCandidate = relative(repoRoot, candidate);
          if (
            relativeCandidate === '..' ||
            relativeCandidate.startsWith('..' + sep) ||
            isAbsolute(relativeCandidate)
          ) {
            return;
          }
          try {
            workingTreeMtimeMsByFile.set(file, (await lstat(candidate)).mtimeMs);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
            const parent = dirname(candidate);
            if (parent === candidate) return;
            candidate = parent;
          }
        }
      }),
  );
  let grouped = groupFilesForAttribution(dirty, groupAttribution, { workingTreeMtimeMsByFile });
  // WI-6554700010019415: an importer and its changed provider must share one private index.
  // Apart, each group's post-stage guard holds the other's file, and only the final catch-all
  // (which a drain yield skips) could commit them.
  if (grouped.filter((g) => g.files.length > 0).length > 1) {
    const edges = await collectDirtyImportEdges({
      readText: opts.readText ?? ((rel) => defaultReadText(repoPath, rel)),
      files: dirty,
      log: opts.log,
    });
    const linked = mergeImportLinkedGroups(grouped, edges);
    if (linked !== grouped) {
      opts.log?.(
        `[git-sync] ${repoPath}: merged import-linked attribution groups ` +
          `(${grouped.filter((g) => g.files.length > 0).length} -> ${linked.filter((g) => g.files.length > 0).length}) ` +
          'so each importer commits with its changed provider',
      );
      grouped = linked;
    }
  }
  const residual = grouped.find((g) => g.agent === null && g.files.length > 0);
  const groups = [
    ...(residual ? [residual] : []),
    ...grouped.filter((g) => g.agent !== null && g.files.length > 0),
  ];
  if (groups.length === 0) return { committedAny: false, committedCount: 0 };
  tally.agentGroupCount = groups.filter((g) => g.agent !== null).length;
  const suffix = skipCiSuffix(message);
  const log = opts.log ?? (() => {});
  let committedAny = false;
  let committedCount = 0;

  // Fail closed: a runner that drops `env` would run read-tree/add/reset on the SHARED index.
  const opened = await openPrivateIndexSite(runGit, repoPath, 'per-agent and residual commits', 'attributed');
  if (!opened.ok) return { committedAny, committedCount, error: opened.error };
  const { site } = opened;

  if (dirtyPriorityPaths.length > 0) {
    if (blockedPriorityPaths.length > 0) {
      opts.deferAttributedPaths?.([...new Set(groups.filter((g) => g.agent !== null).flatMap((g) => g.files))]);
      return {
        committedAny,
        committedCount,
        error:
          'priority gitlink path(s) are excluded; attributed sources must wait for the pointer commit: ' +
          blockedPriorityPaths.join(', '),
      };
    }
    const priority = await commitPriorityPaths(
      runGit,
      repoPath,
      dirtyPriorityPaths,
      message,
      opts.diffSubjects,
      opts.beforeCommit,
      log,
      opts.onPublished,
    );
    if (priority.status === 'committed') {
      committedAny = true;
      committedCount += 1;
    } else if (priority.status === 'cas-refused') {
      log(
        '[git-sync] ' +
          repoPath +
          ': HEAD moved while the priority gitlink commit was being built (update-ref CAS refused: ' +
          priority.detail +
          ') — skipping attributed commits and falling through to the catch-all',
      );
      return {
        committedAny,
        committedCount,
        error: 'priority gitlink commit CAS refused; the catch-all will sweep it with the root sources',
      };
    } else if (priority.status === 'error') {
      return { committedAny, committedCount, error: priority.error };
    }
    const remainingPriorityPaths = await pendingPriorityPaths(
      await dirtyFiles(runGit, repoPath, { ignoreSubmodules: 'dirty' }),
    );
    if (remainingPriorityPaths.length > 0) {
      if (priority.status === 'nothing') {
        opts.deferAttributedPaths?.([...new Set(groups.filter((g) => g.agent !== null).flatMap((g) => g.files))]);
      }
      return {
        committedAny,
        committedCount,
        error: 'priority gitlink path(s) remain dirty; skipping attributed commits and falling through to the catch-all',
      };
    }
  }

  const groupFailures: AttributedGroupFailure[] = [];
  for (const g of groups) {
    const groupLabel = g.agent ? `attributed commit for ${g.agent}` : 'residual catch-all';
    const indexFile = site.newIndexFile();
    const privateGit = site.bindIndex(indexFile);
    // WI-6554700010018197: a failing group is recorded and skipped; later groups still run.
    const fail = (error: string): void => {
      groupFailures.push({ agent: g.agent, files: g.files.length, error });
      log(
        `[git-sync] ${repoPath}: ${groupLabel} skipped (${error}); its ${g.files.length} file(s) ` +
          'stay dirty for the catch-all, and the remaining groups still commit',
      );
    };
    try {
      // 1. The CAS base and a private index seeded from it.
      const seeded = await seedPrivateIndex(runGit, privateGit, repoPath, indexFile, site.sharedIndex, groupLabel);
      if (!seeded.ok) {
        fail(seeded.error);
        continue;
      }
      const { base, baseTree } = seeded;

      // 2. Stage ONLY this group's files, then guard exactly that index. Paths that exist
      //    in neither the working tree nor this index are dropped first (dropVanishedPaths).
      const present = await dropVanishedPaths(privateGit, repoPath, g.files);
      if (!present.ok) {
        fail(`${groupLabel} ${present.error}`);
        continue;
      }
      if (present.vanished.length > 0) {
        log(
          `[git-sync] ${repoPath}: ${groupLabel} dropped ${present.vanished.length} path(s) present in neither ` +
            `the working tree nor HEAD (custody not-available or ineligible generated phantom): ${present.vanished.slice(0, 5).join(', ')}` +
            (present.vanished.length > 5 ? ', …' : ''),
        );
      }
      if (present.files.length === 0) continue;
      let add = await privateGit(['add', '--', ...present.files], repoPath);
      if (add.code !== 0 && addFailureIgnoredPaths(`${add.stdout}\n${add.stderr}`).length > 0) {
        // EI-26936210212113630: the census uses the shared index, but this add uses
        // a HEAD-seeded private index. A shared-only addition can therefore be
        // ignored here; an ignore edit after the census creates the same mismatch.
        // Ask this index which paths are ignored, preserving tracked updates even
        // beneath a reported ignored ancestor. Never force private candidates in.
        const { ignoredUntracked } = await classifyProtectedPathExclusions(privateGit, repoPath, present.files);
        if (ignoredUntracked.size > 0) {
          const eligible = present.files.filter((file) => !ignoredUntracked.has(file));
          log(`[git-sync] ${repoPath}: ${groupLabel} omitted ${ignoredUntracked.size} ignored untracked path(s) from explicit staging`);
          if (eligible.length === 0) continue;
          add = await privateGit(['add', '--', ...eligible], repoPath);
        }
      }
      if (add.code !== 0) {
        fail(`${groupLabel} add failed: ${gitFailureDetail(add)}`);
        continue;
      }
      if (opts.beforeCommit) {
        const guard = await opts.beforeCommit(privateGit);
        if (!guard.ok) {
          fail(guard.error);
          continue;
        }
      }

      // 5 (runs inside step 4, before the CAS). WI-10006850: bring the SHARED index's entries
      //    for exactly the committed paths up to the commit BEFORE it is published, as the
      //    catch-all's refreshSharedIndex does (WI-10006725). Refreshing after the CAS left a
      //    window: a live writer's index.lock failed the refresh with the commit already on
      //    HEAD, and the shared index kept the pre-commit blobs, which read as staged reverts.
      //    Now that lock fails the refresh and so the phase, nothing is published, and the
      //    caller falls through to the catch-all. If the CAS then refuses, the refreshed
      //    entries match the working tree, which is benign. Paths are read literally
      //    (GIT_LITERAL_PATHSPECS), so a `[id]` segment is not a glob.
      const refreshSharedIndex = async (
        commit: string,
        tree: string,
      ): Promise<{ ok: true } | { ok: false; error: string }> => {
        const changed = await runGit(['diff', '--name-only', '--no-renames', '-z', baseTree, tree], repoPath);
        if (changed.code !== 0) {
          return {
            ok: false,
            error: `${groupLabel} not published: could not list its paths: ${gitFailureDetail(changed)}`,
          };
        }
        const committedPaths = changed.stdout.split('\0').filter(Boolean);
        if (committedPaths.some((path) => opts.custodyPaths?.includes(path))) {
          return custodyRefused('attributed-publication-fence');
        }
        // ⚠ never reset with an EMPTY pathspec: that resets the whole shared index.
        if (committedPaths.length === 0) return { ok: true };
        const resetArgs = ['reset', '-q', commit, '--', ...committedPaths];
        const literal = { env: { GIT_LITERAL_PATHSPECS: '1' } };
        const refresh = await recoverIndexLockContention(
          await runGit(resetArgs, repoPath, literal),
          () => runGit(resetArgs, repoPath, literal),
          runGit,
          repoPath,
          'attributed shared-index refresh',
          log,
        );
        if (refresh.code === 0) return { ok: true };
        return {
          ok: false,
          error:
            `${groupLabel} not published: the shared index could not be refreshed for ` +
            `${committedPaths.length} path(s): ${gitFailureDetail(refresh)}`,
        };
      };

      // 3-4. Commit the tree the guard checked (equal to the base tree = nothing left to
      //      commit) and publish it only if HEAD is still the base it was built on.
      //      WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the subject describes the DIFF (what
      //      this commit actually contains — from the private index's numstat against the
      //      base); the agent's intent line (the pre-WI-38594 subject) rides as the first
      //      BODY paragraph, ahead of the provenance trailers, so it stays greppable without
      //      masquerading as a diff summary. A failed numstat only drops the ±counts.
      const published = await publishPrivateIndexCommit(runGit, privateGit, repoPath, {
        base,
        baseTree,
        label: groupLabel,
        reflogMessage: g.agent ? `git-sync: attributed commit for ${g.agent}` : 'git-sync: residual catch-all',
        onPublished: opts.onPublished,
        beforePublish: refreshSharedIndex,
        messageArgs: async () => {
          let subject = g.subject;
          let intentBody: string | null = null;
          let sweepMessageBody: string | null = null;
          if (opts.diffSubjects !== false) {
            const ns = await privateGit(
              ['diff', '--cached', '--numstat', ...(base ? [base] : []), '--', ...present.files],
              repoPath,
            );
            const stats = ns.code === 0 ? parseNumstat(ns.stdout) : undefined;
            if (g.agent === null && (!stats || stats.length === 0)) {
              // Match the catch-all fallback when numstat cannot describe a non-empty commit.
              return attributedMessageArgs(g, message, '', null);
            }
            subject = diffDerivedSubject(present.files, stats);
            if (g.agent === null) sweepMessageBody = message;
            else if (g.subject && g.subject !== DEFAULT_GIT_SYNC_SUBJECT) intentBody = g.subject;
          } else if (g.agent === null) {
            // The catch-all path uses the supplied sweep message as-is when diff subjects are off.
            return attributedMessageArgs(g, message, '', null);
          }
          return attributedMessageArgs(g, subject, suffix, intentBody, sweepMessageBody);
        },
      });
      if (published.status === 'nothing') continue;
      if (published.status === 'error') {
        fail(published.error);
        continue;
      }
      if (published.status === 'cas-refused') {
        log(
          `[git-sync] ${repoPath}: HEAD moved while ${groupLabel} was being built ` +
            `(update-ref CAS refused: ${published.detail}) — not published; its ${g.files.length} file(s) ` +
            'stay dirty for the catch-all or the next tick',
        );
        continue;
      }
      committedAny = true;
      committedCount += 1;
      if (g.agent !== null) tally.agentCommitCount += 1;
    } finally {
      await rm(indexFile, { force: true }).catch(() => {});
      await rm(`${indexFile}.lock`, { force: true }).catch(() => {});
    }
  }
  if (groupFailures.length === 0) return { committedAny, committedCount };
  return {
    committedAny,
    committedCount,
    error:
      `${groupFailures.length} of ${groups.length} group(s) failed: ` +
      groupFailures.map((f) => f.error).join('; '),
    groupFailures,
  };
}

/** The knobs the COMMIT half of one repo's sync needs (stage + content-guard + commit). */
interface CommitRepoOpts {
  onPublished?: (sha: string) => void;
  /** Public scope name used in skipped-path diagnostics. */
  scope: string;
  /** Harness identity for log labels; `scope` remains the repo-relative diagnostic coordinate. */
  harnessSlug: string;
  remote: string;
  defaultBranch: string;
  message: string;
  maxBlobBytes: number;
  maxCommitTotalBytes: number;
  contentDetectors: ContentDetector[];
  deletionGuard: boolean;
  readText: (repoPath: string, relPath: string) => Promise<string | null>;
  writeText: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log: (m: string) => void;
  staleTempPackMs: number;
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** Test seam: holder probe for the stale `objects/maintenance.lock` guard. */
  isGitLockOpen?: (path: string) => Promise<boolean | null>;
  /** Caller-supplied protected paths in THIS repo's relative coordinate space. */
  excludePaths: string[];
  /**
   * Offenders a caller already detected (THIS repo's coordinate space), merged with the
   * content detectors' findings so they get the same exclusion, importer guard,
   * escalation and content-fixer dispatch. WI-6554700010010659: files the
   * declarations compiler rejected.
   */
  preDetectedContentOffenders?: ContentOffender[];
  /** Protected paths in this repo's coordinate space, with holder provenance. */
  protectedHoldings: GitSyncLockHolding[];
  /** Re-read live holdings immediately before staging this repo. */
  refreshLiveLockHoldings?: () => Promise<GitSyncLockHolding[]>;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): path→agent map for THIS repo. The
   *  anonymous residual is committed first, then attributed groups; the final catch-all
   *  `git add -A` still sweeps concurrent arrivals and failed groups. */
  attribution?: Map<string, FileAttribution>;
  /** WI-6554700010018198: receives this repo's attributed-phase tally whenever the phase
   *  runs, so the tick outcome can carry it to routine metadata and the escalation. */
  onAttribution?: (t: AttributionTally) => void;
  /** Root-relative submodule gitlinks to commit before any attributed source groups. */
  priorityPaths?: string[];
  /** Source/generated pairs that must bypass per-agent peeling and land together
   *  in the catch-all commit. They remain stageable; this is NOT an exclusion. */
  forceCatchAllPaths?: string[];
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): diff-derived commit subjects (see RunGitSyncOpts). */
  diffSubjects?: boolean;
  /** Fail-closed reservation check for newly armed migration files, before staging. */
  migrationReservationChecker?: MigrationReservationChecker;
  /** Reservation refusals from child repos whose paired superproject sources must stay dirty. */
  migrationDependencyRefusals?: readonly Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }>[];
  /** Root paths that are submodule gitlinks, not superproject source files for dependency fencing. */
  migrationDependencySubmodulePaths?: readonly string[];
  migrationFenceRoster?: readonly AttributionRosterEntry[];
  /** Full root-relative lock census, including paths under submodules. */
  migrationFenceLiveLockHoldings?: readonly GitSyncLockHolding[];
  loadMigrationFenceRoster?: () => Promise<AttributionRosterEntry[]>;
  /** Superproject-only safe-boundary probe; the caller retains its anti-starvation cap. */
  yieldIfRequested?: (boundary: GitSyncSuperprojectYieldBoundary) => Promise<void>;
}

/** The commit-stage seam for the shared migration reservation admission guard. */
export interface MigrationReservationRefusal {
  path: string;
  reason: string;
}
export type MigrationReservationChecker = (
  dirtyPaths: readonly string[],
) => Promise<readonly MigrationReservationRefusal[]>;

const migrationPaths = (paths: readonly string[]): string[] =>
  paths.filter((path) => armedMigrationFilename(path) !== null);

async function checkMigrationReservations(
  options: CommitRepoOpts,
  paths: readonly string[],
): Promise<
  | { ok: true; refusals: MigrationReservationRefusal[] }
  | { ok: false; error: string }
> {
  if (!options.migrationReservationChecker) return { ok: true, refusals: [] };
  const candidates = migrationPaths(paths);
  if (candidates.length === 0) return { ok: true, refusals: [] };
  try {
    const checked = await options.migrationReservationChecker(candidates);
    if (!Array.isArray(checked)) return { ok: false, error: 'checker returned a non-array result' };
    const candidateSet = new Set(candidates);
    if (
      checked.some(
        (entry) =>
          !entry ||
          typeof entry.path !== 'string' ||
          !candidateSet.has(entry.path) ||
          typeof entry.reason !== 'string' ||
          entry.reason.length === 0,
      )
    ) {
      return { ok: false, error: 'checker returned an invalid or out-of-scope refusal' };
    }
    const byPath = new Map(checked.map((entry) => [entry.path, entry]));
    return { ok: true, refusals: [...byPath.values()] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function migrationReservationSkips(
  scope: string,
  refusals: readonly MigrationReservationRefusal[],
  skippedPaths: GitSyncSkippedPath[],
  log: (message: string) => void,
  logScope = scope,
): string[] {
  const paths: string[] = [];
  for (const refusal of refusals) {
    if (paths.includes(refusal.path)) continue;
    paths.push(refusal.path);
    if (
      !skippedPaths.some(
        (entry) => entry.path === refusal.path && 'reason' in entry && entry.reason === 'migration-reservation',
      )
    ) {
      skippedPaths.push({
        scope,
        path: refusal.path,
        reason: 'migration-reservation',
        detail: refusal.reason,
      });
    }
    log(`[git-sync] ${logScope}: deferring migration ${refusal.path} — ${refusal.reason}`);
  }
  return paths;
}


/** The network half intentionally needs fewer knobs than the commit half.
 * Keeping this contract narrow prevents a caller that already completed
 * `commitOneRepo` from fabricating commit-only scope/lock fields merely to fetch,
 * reconcile, and push. */
type ReconcileRepoOpts = Pick<
  CommitRepoOpts,
  'remote' | 'defaultBranch' | 'log' | 'staleTempPackMs' | 'isTempPackOpen' | 'isGitLockOpen'
> & {
  doPush: boolean;
  /** Disable Git's commit-graph ancestry fast path when this repo merges submodule gitlinks. */
  disableCommitGraphForSubmoduleMerge?: boolean;
  /** A child repo's stale remote-tracking ref cannot prove its current pin is publishable. */
  requireRemoteVerification?: boolean;
  /**
   * pot-review-integration-mode P-016: a working-copy pot absorbs the MAIN repository's
   * branch into its staging before pushing the fork. Set only by working-copy mode.
   */
  syncBack?: SyncBackConfig;
};

/** JSON-serializable — checkpointed as the superproject `git-sync:pointer-bump` step output. */
interface CommitRepoResult {
  committedLocal: boolean;
  dirtyPathCount: number;
  committedCount: number;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  skippedPaths?: GitSyncSkippedPath[];
  /** Persisted with the pointer-bump step so DBOS history retains the measured phase. */
  pointerBumpTiming?: {
    schemaVersion: 1;
    runId: string;
    repoRoot: string;
    pid: number;
    sourceUrl: string;
    startedAt: string;
    durationMs: number;
    commitDurationMs?: number;
    status: 'committed' | 'unchanged' | 'skipped' | 'blocked' | 'error';
  };
  /** A REAL add/commit failure (index.lock race, corrupt index, embedded-repo fatal) —
   *  surfaced by the caller as a repo error. `nothing to commit` is NOT an error. */
  error?: string;
}

const DEPENDENCY_GENERATION_STORE = '.papercusp/dependency-generations';

/**
 * WI-42354 made dependency-generation stores self-ignoring, but an ignore rule
 * cannot hide paths that an older git-sync already committed. Those legacy
 * index entries keep recording selector/pin heartbeat timestamps forever.
 *
 * Git-sync owns the index, so repair the residue at the same seam: remove the
 * reserved host-local store from the index while leaving every runtime byte on
 * disk. The store's own `*` ignore rule then prevents the catch-all add below
 * from reintroducing it. This is replay-safe; after the deletion commit,
 * `ls-files` returns nothing and the helper becomes a no-op.
 */
async function untrackLegacyDependencyGenerationStore(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
): Promise<{ ok: true; trackedCount: number } | { ok: false; error: string }> {
  const tracked = await runGit(['ls-files', '-z', '--', DEPENDENCY_GENERATION_STORE], repoPath);
  if (tracked.code !== 0) {
    return {
      ok: false,
      error: `could not census tracked dependency-generation runtime paths: ${(tracked.stderr || tracked.stdout)
        .trim()
        .slice(0, 300)}`,
    };
  }
  const paths = tracked.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return { ok: true, trackedCount: 0 };

  // WI-10004413: `rm --cached` writes the index. It is idempotent (--ignore-unmatch),
  // so the shared stale-lock recovery may safely re-run it.
  const rmArgs = ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', DEPENDENCY_GENERATION_STORE];
  const removed = await recoverIndexLockContention(
    await runGit(rmArgs, repoPath),
    () => runGit(rmArgs, repoPath),
    runGit,
    repoPath,
    'git rm --cached (dependency-generation store)',
    log,
  );
  if (removed.code !== 0) {
    return {
      ok: false,
      error: `could not untrack dependency-generation runtime paths: ${(removed.stderr || removed.stdout)
        .trim()
        .slice(0, 300)}`,
    };
  }
  log(
    `[git-sync] ${repoPath}: removed ${paths.length} legacy tracked dependency-generation runtime path(s) ` +
      'from the index; cached-only repair preserved the ignored host-local store on disk',
  );
  return { ok: true, trackedCount: paths.length };
}

/**
 * The env-named generation-store record dependency-generation.sh writes under an
 * integration root (WI-10005159). MUST equal the repo-relative form of
 * `dependencyGenerationRootRecord()` in release/dependency-generation-prebuild.ts — pinned
 * by a test, because importing that module here would drag Postgres into git-sync.
 */
export const DEPENDENCY_GENERATION_ROOT_RECORD = '.papercusp/dependency-generation-root';

/**
 * WI-10006277: the store above ignores itself through its own `.gitignore` (WI-42354),
 * but a single FILE cannot, and only Papercusp's own root `.gitignore` names this
 * record. In every other repository — a user's repo behind a repo pot — git-sync
 * therefore committed a host-local absolute path, and a working-copy pot carried it
 * into the standing PR to the user's main repository.
 *
 * Repair at the same seam as the store: make the record ignored through the repo's
 * PRIVATE `info/exclude` (never the user's tracked `.gitignore`, which would itself
 * become a change in their PR), then drop any copy an older git-sync already committed
 * from the index, leaving the file on disk. No-op when the record is absent and
 * untracked, or when the repo's own rules already ignore it (Papercusp's tree).
 */
async function excludeDependencyGenerationRootRecord(
  runGit: RunGit,
  repoPath: string,
  log: (message: string) => void,
): Promise<{ ok: true; excluded: boolean; untracked: boolean } | { ok: false; error: string }> {
  const record = DEPENDENCY_GENERATION_ROOT_RECORD;
  const fail = (what: string, r: { stdout: string; stderr: string }) => ({
    ok: false as const,
    error: `${what} (${record}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
  });
  const tracked = await runGit(['ls-files', '-z', '--', record], repoPath);
  if (tracked.code !== 0) return fail('could not census the dependency-generation root record', tracked);
  const isTracked = tracked.stdout.split('\0').some(Boolean);
  if (!isTracked) {
    try {
      await lstat(join(repoPath, record));
    } catch {
      return { ok: true, excluded: false, untracked: false };
    }
  }

  // `--no-index`: a TRACKED file is otherwise never reported ignored.
  const checkIgnored = () => runGit(['check-ignore', '-q', '--no-index', '--', record], repoPath);
  let ignored = await checkIgnored();
  let excluded = false;
  if (ignored.code === 1) {
    const gitPath = await runGit(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], repoPath);
    if (gitPath.code !== 0) return fail('could not locate info/exclude', gitPath);
    const excludeFile = gitPath.stdout.trim();
    let existing = '';
    try {
      existing = await readFile(excludeFile, 'utf8');
    } catch {
      existing = '';
    }
    const rule = `/${record}`;
    if (!existing.split('\n').includes(rule)) {
      const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
      await mkdir(dirname(excludeFile), { recursive: true });
      await writeFile(
        excludeFile,
        `${existing}${sep}# Papercusp host-local state (WI-10006277) - never committed\n${rule}\n`,
        'utf8',
      );
      excluded = true;
    }
    ignored = await checkIgnored();
  }
  if (ignored.code !== 0) {
    // Still not ignored (e.g. the repo's own rules re-include it with `!`): leave the
    // index alone — untracking a file the catch-all add re-adds would only churn.
    if (ignored.code !== 1) return fail('could not check-ignore the dependency-generation root record', ignored);
    log(`[git-sync] ${repoPath}: ${record} is re-included by the repo's own ignore rules; leaving it tracked`);
    return { ok: true, excluded, untracked: false };
  }
  if (!isTracked) {
    if (excluded) log(`[git-sync] ${repoPath}: excluded host-local ${record} via info/exclude`);
    return { ok: true, excluded, untracked: false };
  }

  const rmArgs = ['rm', '-f', '--cached', '--ignore-unmatch', '--', record];
  const removed = await recoverIndexLockContention(
    await runGit(rmArgs, repoPath),
    () => runGit(rmArgs, repoPath),
    runGit,
    repoPath,
    'git rm --cached (dependency-generation root record)',
    log,
  );
  if (removed.code !== 0) return fail('could not untrack the dependency-generation root record', removed);
  log(
    `[git-sync] ${repoPath}: removed legacy tracked ${record} from the index; ` +
      'cached-only repair kept the host-local file on disk',
  );
  return { ok: true, excluded, untracked: true };
}

/**
 * WI-1416: the COMMIT half of one repo's sync — stage (`add -A` with oversized +
 * content-guard excludes) + commit. Replay-safe by construction: on an
 * already-committed (clean) tree it is a no-op (`nothing to commit` is benign), so
 * a durable-step re-run or a reaped-and-requeued fire cannot double-commit.
 */
async function commitOneRepo(runGit: RunGit, repoPath: string, o: CommitRepoOpts): Promise<CommitRepoResult> {
  const runPass = async (): Promise<CommitRepoResult> => {
    // WI-10006725: scratch files the catch-all creates (its private index, the shared-index
    // refresh pathspec) are removed on EVERY exit path, a thrown runner included.
    const scratch: string[] = [];
    // P-003 (gate-systems-as-designed-2026-10-27): the attributed phase reports its tally
    // before the catch-all runs, but the attributed-file share depends on what the catch-all
    // sweeps too. Hold the tally until the pass ends (on every exit path) and add the share
    // measured from the commits this pass published.
    const published: string[] = [];
    const held: { tally: AttributionTally | null } = { tally: null };
    const passOpts: CommitRepoOpts = {
      ...o,
      onPublished: (sha) => {
        published.push(sha);
        o.onPublished?.(sha);
      },
      ...(o.onAttribution
        ? {
            onAttribution: (t: AttributionTally) => {
              held.tally = t;
            },
          }
        : {}),
    };
    try {
      return await commitOneRepoWithScratch(runGit, repoPath, passOpts, scratch);
    } finally {
      for (const file of scratch) {
        await rm(file, { force: true }).catch(() => {});
        await rm(`${file}.lock`, { force: true }).catch(() => {});
      }
      if (held.tally && o.onAttribution) {
        const share = await measureAttributedFileShare(
          runGit,
          repoPath,
          published,
          o.attribution,
          o.forceCatchAllPaths,
        ).catch(() => null);
        if (share && share.attributableFileCount > 0) {
          o.log(
            `[git-sync] ${o.harnessSlug}/${o.scope}: attributed-file share ` +
              `${share.attributedFileCount}/${share.attributableFileCount} ledger-attributed file(s) ` +
              'committed under an agent trailer',
          );
        }
        const attributableFileCount = share?.attributableFileCount ?? held.tally.attributableFileCount ?? 0;
        if (
          held.tally.agentGroupCount > 0 ||
          held.tally.agentCommitCount > 0 ||
          held.tally.failedGroups > 0 ||
          held.tally.error !== null ||
          attributableFileCount > 0
        ) {
          o.onAttribution({ ...held.tally, ...(share ?? {}) });
        }
      }
    }
  };

  const first = await runPass();
  const heldSkippedPaths = (first.skippedPaths ?? []).filter(
    (entry): entry is Extract<GitSyncSkippedPath, { owner: string }> => 'owner' in entry && 'intent' in entry,
  );
  if (!o.refreshLiveLockHoldings || heldSkippedPaths.length === 0) return first;

  // The pre-stage census becomes `effectiveExcludePaths` for the whole pass. A
  // hold released while the later importer/manifest/index preparation runs stays
  // excluded from every add; the post-stage guard cannot recover it because it
  // only examines paths already in an index. Re-read after the pass and, when a
  // skipped live hold has cleared, run the whole bounded repo pass once more so
  // dependency and content guards are recomputed with the released path present.
  let currentHoldings: GitSyncLockHolding[];
  try {
    currentHoldings = await o.refreshLiveLockHoldings();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    o.log(`[git-sync] ${o.harnessSlug}/${o.scope}: post-pass live-lock release check failed; no retry — ${detail}`);
    return first;
  }
  const releasedPaths = heldSkippedPaths.filter(
    (skipped) => !currentHoldings.some((holding) => gitSyncPathsOverlap(skipped.path, holding.path.trim())),
  );
  if (releasedPaths.length === 0) return first;

  o.log(
    `[git-sync] ${o.harnessSlug}/${o.scope}: ${releasedPaths.length} previously held path(s) released during repo preparation ` +
      `(${releasedPaths.slice(0, 5).map((entry) => entry.path).join(', ')}); retrying the repo commit once with guards recomputed`,
  );
  const retry = await runPass();
  return {
    ...retry,
    committedLocal: first.committedLocal || retry.committedLocal,
    dirtyPathCount: Math.max(first.dirtyPathCount, retry.dirtyPathCount),
    committedCount: first.committedCount + retry.committedCount,
    ...(first.error && retry.error ? { error: `${first.error}; retry: ${retry.error}` } :
      first.error ? { error: first.error } : retry.error ? { error: retry.error } : {}),
  };
}

async function commitOneRepoWithScratch(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts,
  scratch: string[],
): Promise<CommitRepoResult> {
  const { message } = o;
  const logScope = `${o.harnessSlug}/${o.scope}`;
  // A routine heartbeat says only that a git call settled. Name slow pre-stage
  // phases so a live lease can be diagnosed without guessing from its age.
  let phaseStartedAt = performance.now();
  const noteSlowPhase = (phase: string): void => {
    const now = performance.now();
    const elapsedMs = Math.round(now - phaseStartedAt);
    if (elapsedMs >= 10_000) o.log(`[git-sync] ${logScope}: slow commit pre-stage ${phase} (${elapsedMs}ms)`);
    phaseStartedAt = now;
  };
  let committedLocal = false;
  let committedCount = 0;
  let oversized: OversizedFile[] = [];
  let contentErrors: ContentOffender[] = [];
  let skippedPaths: GitSyncSkippedPath[] = [];
  let migrationQuarantinedPaths: string[] = [];
  // A torn index makes `git status` report an empty census and would therefore
  // strand every working-tree edit. Preflight before the first status call for
  // both the superproject and each submodule. The helper is idempotent, so the
  // root-level preflight (needed before submodule discovery) may have already
  // established a valid index.
  const indexPreflight = await preflightInvalidIndex(runGit, repoPath, o.log);
  noteSlowPhase('index preflight');
  if (indexPreflight.status === 'refused' || indexPreflight.status === 'error') {
    return {
      committedLocal: false,
      dirtyPathCount: 0,
      committedCount,
      error: `invalid-index preflight refused the commit: ${indexPreflight.reason}`,
      oversized,
      contentErrors,
      skippedPaths: [],
    };
  }
  // This must precede every shared-index consumer, including quarantine/untrack
  // repairs and both attributed and catch-all refresh/fallback boundaries.
  const custody = await preserveVanishedStagedSources(runGit, repoPath, o.attribution, o.log);
  if (!custody.ok) {
    return { committedLocal: false, dirtyPathCount: 0, committedCount, error: custody.error, oversized, contentErrors, skippedPaths: [] };
  }
  const dependencyGenerationRepair = await untrackLegacyDependencyGenerationStore(runGit, repoPath, o.log);
  noteSlowPhase('dependency generation repair');
  if (!dependencyGenerationRepair.ok) {
    return {
      committedLocal: false,
      dirtyPathCount: 0,
      committedCount,
      error: dependencyGenerationRepair.error,
      oversized,
      contentErrors,
      skippedPaths: [],
    };
  }
  const rootRecordRepair = await excludeDependencyGenerationRootRecord(runGit, repoPath, o.log);
  noteSlowPhase('dependency generation root record');
  if (!rootRecordRepair.ok) {
    return {
      committedLocal: false,
      dirtyPathCount: 0,
      committedCount,
      error: rootRecordRepair.error,
      oversized,
      contentErrors,
      skippedPaths: [],
    };
  }
  const dirty = await dirtyFiles(runGit, repoPath);
  noteSlowPhase('dirty census');
  const dirtyPathCount = dirty.length;
  const migrationCandidates = migrationPaths(dirty);
  const preStageMigrationCheck = await checkMigrationReservations(o, migrationCandidates);
  noteSlowPhase('migration reservation');
  const preStageMigrationRefusals = preStageMigrationCheck.ok
    ? preStageMigrationCheck.refusals
    : migrationCandidates.map((path) => ({
        path,
        reason: `reservation check failed; deferring fail-closed: ${preStageMigrationCheck.error}`,
      }));
  if (!preStageMigrationCheck.ok) {
    o.log(
      `[git-sync] ${logScope}: migration reservation check failed; deferring candidate migrations fail-closed: ` +
        `${preStageMigrationCheck.error}`,
    );
  }
  if (preStageMigrationRefusals.length > 0) {
    // A migration may have been staged by an earlier process before this tick's
    // reservation check. Quarantine only refused paths; leave unrelated staged
    // entries and every working-tree byte recoverable while the rest of the repo
    // continues through this tick.
    migrationQuarantinedPaths = migrationReservationSkips(
      o.scope,
      preStageMigrationRefusals,
      skippedPaths,
      o.log,
      logScope,
    );
    const unstage = await unstagePreStagedProtectedPaths(runGit, repoPath, migrationQuarantinedPaths, o.log);
    const unstageError = unstage.ok ? '' : `; could not unstage refused migration paths: ${unstage.error}`;
    if (!unstage.ok) {
      o.log(`[git-sync] ${logScope}: migration quarantine could not remove refused paths from the index${unstageError}`);
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: `migration reservation quarantine failed${unstageError}`,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
  }
  // Only a child repo's refusal creates a cross-repo dependency fence in the
  // superproject. A refusal found in this repo is already quarantined by path
  // above; treating it as a child refusal would hold every root path when its
  // attribution is unknown and strand unrelated work.
  const migrationFenceRefusals = [...(o.migrationDependencyRefusals ?? [])];
  const migrationDependencyFenceSkippedPaths: GitSyncSkippedPath[] = [];
  if (o.scope === 'superproject' && migrationFenceRefusals.length > 0 && dirty.length > 0) {
    const nestedRepoPaths = o.migrationDependencySubmodulePaths ?? [];
    const dirtySuperprojectPaths = dirty.filter(
      (path) => !nestedRepoPaths.some((submodule) => path === submodule || path.startsWith(submodule + '/')),
    );
    if (dirtySuperprojectPaths.length > 0) {
      let migrationFenceRoster = [...(o.migrationFenceRoster ?? [])];
      if (o.loadMigrationFenceRoster) {
        try {
          const loaded = await o.loadMigrationFenceRoster();
          migrationFenceRoster = Array.isArray(loaded) ? loaded : [];
        } catch (error) {
          migrationFenceRoster = [];
          o.log(
            '[git-sync] superproject: migration attribution read failed; holding dirty source paths fail-closed: ' +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      migrationDependencyFenceSkippedPaths.push(
        ...migrationDependencyFenceSkips(
          migrationFenceRefusals,
          dirtySuperprojectPaths,
          migrationFenceRoster,
          repoPath,
          o.migrationFenceLiveLockHoldings ?? [],
        ),
      );
      skippedPaths.push(...migrationDependencyFenceSkippedPaths);
      if (migrationDependencyFenceSkippedPaths.length > 0) {
        o.log(
          '[git-sync] superproject: migration dependency fence deferred ' +
            migrationDependencyFenceSkippedPaths.map((entry) => entry.path).join(', '),
        );
      }
    }
  }
  const hasDirtyFiles = await isDirty(runGit, repoPath);
  noteSlowPhase('dirty check');
  if (hasDirtyFiles) {
    const attachment = await ensureBranchAttachedForCommit(runGit, repoPath, o.remote, o.defaultBranch, o.log);
    noteSlowPhase('branch attachment');
    if ('error' in attachment) {
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: attachment.error,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    // EI-18 guard: never bake an unpushable blob into the range. Oversized dirty
    // files are excluded from the commit (`:(exclude,literal)` pathspecs) and
    // reported; everything else still syncs this tick.
    oversized = await findOversizedDirtyFiles(runGit, repoPath, o.maxBlobBytes);
    noteSlowPhase('oversized file scan');
    // WI-5738: the CUMULATIVE gate. Individually-fine files can still add up to
    // an accident (2,261 MB of extracted AppImage in files all < 95 MB, on
    // 2026-07-20) that the downstream publish guard could then only refuse,
    // terminally. Catch it here, where excluding is enough.
    const bulk = await findBulkDirtyExcess(
      runGit,
      repoPath,
      o.maxCommitTotalBytes,
      new Set(oversized.map((f) => f.path)),
    );
    noteSlowPhase('bulk size scan');
    if (bulk.length > 0) {
      o.log(
        `[git-sync] cumulative dirty set exceeds ${o.maxCommitTotalBytes} bytes — excluding ${bulk.length} large file(s) ` +
          `from this commit (left dirty): ${bulk
            .slice(0, 5)
            .map((f) => `${f.path} (${f.sizeBytes}B)`)
            .join('; ')}`,
      );
      oversized = [...oversized, ...bulk];
    }
    // EI-438 content guard (P-001/P-002, D-001): a dirty file that fails a content
    // detector (an .mdx that won't compile, a curly quote used as code) is EXCLUDED
    // from this commit and left dirty for the content-fixer — so one broken file
    // never stalls the rest of the tree's commit (quarantine, don't stall). Fails
    // OPEN: a throwing detector is skipped, never a blocker.
    // EI-21230011589307899: what this pass judged, so the post-stage guard can judge any
    // staged blob it did not see (a file created between this scan and the add).
    const contentScanned = new Map<string, string>();
    contentErrors = await detectContentOffenders({
      runGit,
      repoPath,
      readText: (rel) => o.readText(repoPath, rel),
      writeText: (rel, text) => o.writeText(repoPath, rel, text),
      detectors: o.contentDetectors,
      log: o.log,
      scanned: contentScanned,
    });
    noteSlowPhase('content detectors');
    if (o.preDetectedContentOffenders && o.preDetectedContentOffenders.length > 0) {
      const seen = new Set(contentErrors.map((c) => `${c.file}\0${c.detectorKey}`));
      for (const offender of o.preDetectedContentOffenders) {
        const key = `${offender.file}\0${offender.detectorKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contentErrors = [...contentErrors, offender];
      }
    }
    // EI-19932544083689229 quarantine-import guard (remedy #1 — ATOMICITY): a file
    // quarantined above (oversized, or excluded by a content detector — i.e. a file
    // that will have ZERO history in HEAD this tick) must not be committed WITHOUT
    // also holding back any OTHER dirty file — e.g. its own `*.test.*` sibling — that
    // imports it. Otherwise the importer commits alone and HEAD carries an
    // unresolvable relative import forever (an isolated checkout, e.g.
    // green-checkpoint's candidate build, gets the importer without its subject and
    // fails deterministically on every run). Quarantine the PAIR, never just the
    // broken half. Runs to a fixed point (a chain of dirty importers is caught too).
    //
    // Deliberately computed BEFORE the deletion guard below (not merged with its
    // output): a deletion-guard offender is a DIFFERENT shape — it excludes the
    // DELETION, so the file stays PRESENT in HEAD with its prior content, and a
    // dirty file importing it resolves FINE. Folding deletion offenders into this
    // guard's "infectious" set would falsely quarantine an unrelated clean importer.
    const preDeletionQuarantined = [...new Set([...oversized.map((f) => f.path), ...contentErrors.map((c) => c.file)])];
    // EI-17: a dirty DELETION whose module a surviving file still (relatively)
    // imports is excluded exactly like a content offender — see
    // deletion-import-guard.ts for why this can't be folded into the per-file
    // content-detector registry above (it's a cross-file check on the deletion
    // SET, not a single file's own text).
    // WI-39377: BEFORE the per-deletion import check, ask whether the deletion SET is a
    // wipe at all. detectUnsafeDeletions looks for a SURVIVING importer, so it is
    // structurally blind to a total wipe (no survivors => no finding) — which is exactly
    // how four SideStage submodules were committed down to zero-file trees and pushed.
    // Shares the deletionGuard flag: both are "should this deletion be committed?".
    if (o.deletionGuard) {
      const wipeErrors = await detectWholesaleDeletion({ runGit, repoPath, log: o.log });
      if (wipeErrors.length > 0) contentErrors = [...contentErrors, ...wipeErrors];
      noteSlowPhase('wholesale deletion guard');
    }
    if (o.deletionGuard) {
      const deletionErrors = await detectUnsafeDeletions({
        runGit,
        repoPath,
        readText: (rel) => o.readText(repoPath, rel),
        log: o.log,
      });
      if (deletionErrors.length > 0) contentErrors = [...contentErrors, ...deletionErrors];
      noteSlowPhase('unsafe deletion guard');
    }
    // WI-6554700010008496: why each path this pass excludes was excluded, so every
    // importer held behind it (here, at the live-lock guard, and post-stage) can name
    // its root's cause. First reason recorded for a path wins.
    const exclusionReasons = new Map<string, string>();
    const noteExclusion = (path: string, reason: string) => {
      if (!exclusionReasons.has(path)) exclusionReasons.set(path, reason);
    };
    for (const f of oversized) noteExclusion(f.path, 'oversized blob');
    for (const c of contentErrors) noteExclusion(c.file, `content guard: ${c.detectorKey}`);
    if (preDeletionQuarantined.length > 0) {
      const dirtyForScan = await dirtyFiles(runGit, repoPath);
      const importerErrors = await detectQuarantineImporters({
        readText: (rel) => o.readText(repoPath, rel),
        dirtyFiles: dirtyForScan,
        alreadyQuarantined: preDeletionQuarantined,
        isResolvableAtHead: (rel) => isModuleResolvableAtHead(runGit, repoPath, rel, o.log),
        exclusionReasonFor: (rel) => exclusionReasons.get(rel),
        log: o.log,
      });
      if (importerErrors.length > 0) contentErrors = [...contentErrors, ...importerErrors];
      noteSlowPhase('quarantined importer guard');
    }
    // The action's initial lock census protects the setup window, but the
    // submodule and guard phases above can take long enough for a peer to
    // acquire another edit lock. Refresh as late as possible, before any
    // attribution add or catch-all staging command, and fail closed if the
    // lock plane cannot be read.
    let protectedHoldings = o.protectedHoldings;
    let effectiveExcludePaths = [
      ...new Set([
        ...o.excludePaths,
        ...custody.protectedPaths,
        ...protectedHoldings.map((holding) => holding.path),
        ...migrationQuarantinedPaths,
        ...migrationDependencyFenceSkippedPaths.map((entry) => entry.path),
      ]),
    ];
    if (o.refreshLiveLockHoldings) {
      let refreshedHoldings: GitSyncLockHolding[];
      try {
        refreshedHoldings = await o.refreshLiveLockHoldings();
        noteSlowPhase('live lock refresh');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        o.log(`[git-sync] ${logScope}: live lock refresh failed (fail-closed) — ${detail}`);
        return {
          committedLocal: false,
          dirtyPathCount,
          committedCount,
          error: `live lock refresh failed (fail-closed): ${detail}`,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
      // The strict lock-plane read is authoritative, including releases. A
      // union with the setup snapshot would strand completed edits for the
      // rest of a long tick. Keep explicit exclusions separate from holdings.
      const byPath = new Map<string, GitSyncLockHolding>();
      for (const holding of refreshedHoldings) {
        const path = holding.path.trim();
        if (path.length > 0) byPath.set(path, { ...holding, path });
      }
      protectedHoldings = [...byPath.values()];
      effectiveExcludePaths = [
        ...new Set([
          ...o.excludePaths,
          ...custody.protectedPaths,
          ...refreshedHoldings.map((holding) => holding.path.trim()).filter(Boolean),
          ...migrationQuarantinedPaths,
          ...migrationDependencyFenceSkippedPaths.map((entry) => entry.path),
        ]),
      ];
    }
    const directSkippedHoldings = protectedHoldings.filter((holding) =>
      dirty.some((file) => gitSyncPathsOverlap(file, holding.path)),
    );
    const atomicExclusions = expandAtomicLiveLockExclusions(
      dirty,
      protectedHoldings,
      o.attribution,
      o.forceCatchAllPaths,
    );
    const directSkippedPaths = directSkippedHoldings.map((holding) => ({
      scope: o.scope,
      path: holding.path,
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.heldSince ? { heldSince: holding.heldSince } : {}),
    }));
    skippedPaths.push(...directSkippedPaths);
    if (directSkippedPaths.length > 0) {
      o.log(
        `[git-sync] ${logScope}: excluding live-locked dirty path(s) while committing the unlocked remainder: ` +
          directSkippedPaths.map((p) => `${p.path} (${p.owner}: ${p.intent})`).join('; '),
      );
      if (atomicExclusions.groups.some((group) => group.paths.length > 1)) {
        o.log(
          `[git-sync] ${logScope}: keeping ${atomicExclusions.groups.length} live edit cohort(s) atomic ` +
            `(owner + goal_ref); deferring grouped dirty path(s): ` +
            atomicExclusions.groups
              .filter((group) => group.paths.length > 1)
              .map((group) => `${group.owner}/${group.goalRef} [${group.paths.join(', ')}]`)
              .join('; '),
        );
      }
    }
    // A live lock can protect either a new module or a changed export in a
    // tracked module. In both cases, publishing a dirty importer alone can
    // produce an incomplete HEAD. Hold dirty importers and their transitive
    // chain whenever their dependency is excluded by a live lock. Unlike the
    // content guard above, resolving the old module at HEAD is not enough:
    // its old exports may not satisfy the importer's new symbols. That rationale
    // covers BINDING edges only — a bare side-effect import (`import './x'`)
    // consumes no symbols, so it holds only when its target is absent from HEAD
    // (WI-10006940: otherwise a registration hub bridges any peer lock into
    // every route that imports the hub).
    for (const [path, reason] of describeLiveLockExclusions(atomicExclusions, protectedHoldings)) {
      noteExclusion(path, reason);
    }
    for (const pair of atomicExclusions.generatedDeclarationPairs) {
      const holding = protectedHoldings.find((entry) => gitSyncPathsOverlap(pair.heldPath, entry.path.trim()));
      if (holding) {
        noteExclusion(
          pair.source === pair.heldPath ? pair.artifact : pair.source,
          `generated declaration pair with live-held ${pair.heldPath} (${holding.owner}: ${holding.intent})`,
        );
      }
    }
    if (atomicExclusions.paths.length > 0) {
      const liveLockImporterErrors = await detectQuarantineImporters({
        readText: (rel) => o.readText(repoPath, rel),
        dirtyFiles: dirty,
        alreadyQuarantined: atomicExclusions.paths,
        sideEffectTargetAtHead: (rel) => isModuleResolvableAtHead(runGit, repoPath, rel, o.log),
        exclusionLabel: 'live-lock exclusion',
        exclusionReasonFor: (rel) => exclusionReasons.get(rel),
        log: o.log,
      });
      if (liveLockImporterErrors.length > 0) contentErrors = [...contentErrors, ...liveLockImporterErrors];
      noteSlowPhase('live lock importer guard');
    }
    // Exclude BOTH oversized + content offenders (incl. unsafe deletions + quarantined
    // importers) from the auto-commit (deduped — a file can be both). Everything else
    // still syncs this tick.
    const baseExcludePaths = [
      ...new Set([
        ...effectiveExcludePaths,
        // liveLockHoldings is the provenance-rich authority. Keep its paths safe
        // even if a caller omitted the parallel excludePaths projection.
        ...atomicExclusions.paths,
        ...oversized.map((f) => f.path),
        ...contentErrors.map((c) => c.file),
      ]),
    ];
    const cargoPackageClosure = await expandCargoPackageLiveLockExclusions(
      dirty,
      baseExcludePaths,
      (rel) => o.readText(repoPath, rel),
    );
    if (cargoPackageClosure.paths.length > 0) {
      o.log(
        `[git-sync] ${logScope}: keeping dirty Rust package(s) atomic — ` +
          cargoPackageClosure.packages
            .map((pkg) => `${pkg.root} [${pkg.paths.join(', ')}]`)
            .join('; '),
      );
    }
    const packageSafeBaseExcludePaths = [...new Set([...baseExcludePaths, ...cargoPackageClosure.paths])];
    // EI-24649116564770033: a withheld dirty manifest holds back every other dirty manifest
    // in this repo, so a dependency change never lands without its root entry or lockfile.
    const manifestClosure = expandNpmManifestClosure(dirty, packageSafeBaseExcludePaths);
    if (manifestClosure.paths.length > 0) {
      o.log(
        `[git-sync] ${logScope}: keeping npm manifests atomic — ${manifestClosure.triggers.join(', ')} ` +
          `withheld this pass, so also deferring ${manifestClosure.paths.join(', ')}`,
      );
    }
    const excludePaths = [...new Set([...packageSafeBaseExcludePaths, ...manifestClosure.paths])];
    const cumulativeExcludedPaths = oversized
      .filter((file) => file.exclusionReason === 'cumulative-limit')
      .map((file) => file.path);
    const nonCumulativeExcludePaths = [
      ...effectiveExcludePaths,
      ...atomicExclusions.paths,
      ...oversized.filter((file) => file.exclusionReason !== 'cumulative-limit').map((file) => file.path),
      ...contentErrors.map((error) => error.file),
      ...cargoPackageClosure.paths,
      ...manifestClosure.paths,
    ];
    const preserveCumulativeUntracking = new Set(
      cumulativeExcludedPaths.filter(
        (path) => !nonCumulativeExcludePaths.some((excluded) => gitSyncPathsOverlap(path, excluded)),
      ),
    );
    const preStagedProtected = await unstagePreStagedProtectedPaths(
      runGit,
      repoPath,
      excludePaths,
      o.log,
      preserveCumulativeUntracking,
    );
    noteSlowPhase('protected path unstage');
    if (!preStagedProtected.ok) {
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: preStagedProtected.error,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    // EI-21026041751032400: a live protected-path lock can name an ignored
    // untracked artifact. Git already omits that artifact from `add -A`, but
    // rejects the whole command when the artifact is also mentioned as a
    // negative pathspec. Filter only that population before either the
    // attribution path-specific adds or the catch-all stage; tracked ignored
    // paths remain protected by their exclusion pathspec.
    const protectedPathPreflight = await classifyProtectedPathExclusions(runGit, repoPath, excludePaths);
    noteSlowPhase('protected path preflight');
    // EI-258149: a drain can arrive after the outer pointer-bump probe while
    // preparation is still running. All parallel preflight Git calls have settled;
    // yield before opening/staging an attributed or catch-all private index.
    await o.yieldIfRequested?.('before-superproject-stage');
    const ignoredUntrackedExcludes = protectedPathPreflight.ignoredUntracked;
    const beyondSymlinkExcludes = protectedPathPreflight.beyondSymlink;
    const inSubmoduleExcludes = protectedPathPreflight.inSubmodule;
    const omittedPreflightExcludes = new Set([
      ...ignoredUntrackedExcludes,
      ...beyondSymlinkExcludes,
      ...inSubmoduleExcludes,
    ]);
    let stagingExcludePaths = excludePaths.filter((path) => !omittedPreflightExcludes.has(path));
    if (ignoredUntrackedExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering ignored untracked protected path(s) ` +
          `[${[...ignoredUntrackedExcludes].join(', ')}] from staging pathspecs — Git already excludes them`,
      );
    }
    if (beyondSymlinkExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering protected path(s) beyond a symbolic link ` +
          `[${[...beyondSymlinkExcludes].join(', ')}] from staging pathspecs — Git cannot traverse the symlink in a pathspec and add -A does not traverse its target`,
      );
    }
    if (inSubmoduleExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering protected path(s) inside a submodule ` +
          `[${[...inSubmoduleExcludes].join(', ')}] from staging pathspecs — this repo's add -A stages only the gitlink, ` +
          'and Git rejects the whole add for an in-submodule pathspec (WI-6554700010018683)',
      );
    }
    let committedAny = false;
    // EI-24712906810240170: the post-stage guard for every commit below. A late lock is
    // reported like a pre-stage one (skippedPaths), deduped by path.
    // WI-10006705: an attributed group passes the runner bound to its PRIVATE index, so the
    // guard inspects and edits exactly the index that group's commit records.
    const postStageGuard = async (indexRunGit: RunGit = runGit): Promise<PostStageGuardResult> => {
      // Each caller owns scratch-index cleanup in finally. Stop before a slow
      // guard if the drain arrived during its completed add, and check again
      // after the guard. Never split shared-index refresh from publication CAS.
      await o.yieldIfRequested?.('before-superproject-publish');
      const guard = await guardStagedIndexBeforeCommit({
        runGit: indexRunGit,
        repoPath,
        scope: logScope,
        refreshLiveLockHoldings: o.refreshLiveLockHoldings,
        readText: (rel) => o.readText(repoPath, rel),
        excludedDependencies: excludePaths,
        preserveCumulativeUntracking,
        excludedDependencyReasons: exclusionReasons,
        generatedDeclarationPaths: o.forceCatchAllPaths,
        alwaysInfectiousDependencies: [
          ...protectedHoldings.map((holding) => holding.path),
          ...atomicExclusions.paths,
          ...cargoPackageClosure.paths,
        ],
        rescanStagedContent: (staged, guardRunGit) =>
          detectUnscannedStagedOffenders({
            runGit: guardRunGit,
            repoPath,
            staged,
            scanned: contentScanned,
            detectors: o.contentDetectors,
            log: o.log,
          }),
        log: o.log,
      });
      if (guard.ok) {
        for (const holding of guard.lateLockedHoldings) {
          if (skippedPaths.some((p) => p.path === holding.path)) continue;
          skippedPaths.push({
            scope: o.scope,
            path: holding.path,
            owner: holding.owner,
            intent: holding.intent,
            ...(holding.heldSince ? { heldSince: holding.heldSince } : {}),
          });
        }
        await o.yieldIfRequested?.('before-superproject-publish');
      }
      return guard;
    };
    // P-004: commit the anonymous residual before per-agent groups so script-written files
    // do not wait behind their full walk. The final whole-tree catch-all below still sweeps
    // concurrent arrivals and any group that failed to publish.
    if (o.attribution && o.attribution.size > 0) {
      const res = await commitAttributedGroups(
        runGit,
        repoPath,
        o.attribution,
        [...stagingExcludePaths, ...migrationCandidates],
        message,
        {
          diffSubjects: o.diffSubjects,
          forceCatchAllPaths: o.forceCatchAllPaths,
          priorityPaths: o.priorityPaths,
          deferAttributedPaths: (paths) => {
            stagingExcludePaths = [...new Set([...stagingExcludePaths, ...paths])];
            o.log(
              '[git-sync] ' +
                repoPath +
                ': deferring attributed source path(s) until protected priority gitlinks can commit: ' +
                paths.join(', '),
            );
          },
          beforeCommit: (privateRunGit) => postStageGuard(privateRunGit),
          onPublished: o.onPublished,
          custodyPaths: custody.protectedPaths,
          readText: (rel) => o.readText(repoPath, rel),
          log: o.log,
        },
      );
      if (res.custodyFatal) {
        return { committedLocal: committedAny, dirtyPathCount, committedCount, error: res.error, oversized, contentErrors, skippedPaths };
      }
      custody.protectedPaths = [...new Set([...custody.protectedPaths, ...(res.custodyProtectedPaths ?? [])])];
      stagingExcludePaths = [...new Set([...stagingExcludePaths, ...custody.protectedPaths])];
      if (res.error) {
        // STRANDING GUARD (2026-06-30): a failed per-agent attributed commit — e.g. an
        // index.lock race under heavy fleet contention — must NEVER short-circuit the
        // catch-all `git add -A` sweep below. Returning here strands the unattributed
        // REMAINDER: untracked NEW files (a new tool/module) whose `import` was already
        // committed in an earlier tick. The result is an UNBUILDABLE tree — "the agent's
        // code went missing", and every deploy preflight dies on `Cannot find module`.
        // Log it and FALL THROUGH; the catch-all commits everything still dirty (the
        // failed group's files + the remainder), so no file is ever left behind.
        o.log(
          `[git-sync] ${repoPath}: path-specific commit phase errored (${res.error}); falling through to the catch-all 'git add -A' sweep so no file strands`,
        );
      }
      committedAny = res.committedAny;
      committedCount += res.committedCount;
      o.onAttribution?.({
        scope: o.scope,
        agentGroupCount: res.agentGroupCount,
        agentCommitCount: res.agentCommitCount,
        failedGroups: res.groupFailures?.length ?? 0,
        error: res.error ?? null,
      });
    }
    // Catch-all = today's single whole-tree commit: sweeps the unattributed remainder (or
    // EVERYTHING when no attribution), including anything a path-specific add missed (rename
    // origin-sides, etc.).
    // WI-10006725: it is built in a PRIVATE index, like each attributed group. The shared
    // index is writable by anything on the tree, and `git commit` records ALL of it, so a
    // path the post-stage guard held back (a late lock, drift, an importer of an excluded
    // module) that a peer re-staged before the commit was published anyway. `stageGit` is
    // the runner for every index read and write below, and the commit is write-tree →
    // commit-tree → update-ref CAS. STRANDING GUARD: when the runner does not forward
    // GIT_INDEX_FILE, or the seed fails, it falls back to the shared index + `git commit`;
    // committing the tree outranks isolating it.
    // Attributed work can take long enough for another staged source to vanish.
    // Recheck the SHARED index before either private seeding or shared fallback.
    const catchAllCustody = await preserveVanishedStagedSources(runGit, repoPath, o.attribution, o.log);
    if (!catchAllCustody.ok) {
      return { committedLocal: committedAny, dirtyPathCount, committedCount, error: catchAllCustody.error, oversized, contentErrors, skippedPaths };
    }
    custody.protectedPaths = [...new Set([...custody.protectedPaths, ...catchAllCustody.protectedPaths])];
    stagingExcludePaths = [...new Set([...stagingExcludePaths, ...custody.protectedPaths])];
    let stageGit: RunGit = runGit;
    let catchAllPrivate: { base: string | null; baseTree: string; gitDir: string } | null = null;
    const catchAllSite = await openPrivateIndexSite(runGit, repoPath, 'catch-all commit', 'catch-all');
    if (catchAllSite.ok) {
      const indexFile = catchAllSite.site.newIndexFile();
      scratch.push(indexFile);
      const privateGit = catchAllSite.site.bindIndex(indexFile);
      const seeded = await seedPrivateIndex(runGit, privateGit, repoPath, indexFile, catchAllSite.site.sharedIndex, 'catch-all commit');
      if (seeded.ok) {
        stageGit = privateGit;
        catchAllPrivate = { base: seeded.base, baseTree: seeded.baseTree, gitDir: catchAllSite.site.gitDir };
        const carryExcludes = [...stagingExcludePaths, ...migrationQuarantinedPaths];
        const isCarryExcluded = (path: string): boolean =>
          carryExcludes.some((ex) => path === ex || path.startsWith(ex + '/'));
        const carried = await carrySharedIndexMembership(
          runGit,
          privateGit,
          repoPath,
          seeded.baseTree,
          isCarryExcluded,
          preserveCumulativeUntracking,
        );
        if (!carried.ok) {
          // Only IGNORED paths' membership depends on the carry; the rest of the tree still
          // commits from the working tree, so this degrades, it does not strand.
          o.log(`[git-sync] ${repoPath}: catch-all ${carried.error} — committing without the shared index's untracks/force-adds`);
        } else if (carried.added + carried.removed > 0) {
          o.log(
            `[git-sync] ${repoPath}: catch-all carried ${carried.removed} staged deletion(s) and ` +
              `${carried.added} staged addition(s) from the shared index`,
          );
        }
      } else {
        o.log(`[git-sync] ${repoPath}: ${seeded.error} — committing the catch-all through the shared index instead`);
      }
    } else {
      o.log(`[git-sync] ${repoPath}: ${catchAllSite.error} — committing the catch-all through the shared index instead`);
    }
    const buildAddArgs = (extraExcludes: string[], omittedExcludes: readonly string[] = []): string[] => {
      const omitted = new Set(omittedExcludes);
      const ex = [...new Set([...stagingExcludePaths, ...extraExcludes])].filter((path) => !omitted.has(path));
      return ex.length === 0 ? ['add', '-A'] : ['add', '-A', '--', '.', ...ex.map((p) => `:(exclude,literal)${p}`)];
    };
    // STRANDING GUARD (2026-06-30 ROOT CAUSE): a stray EMBEDDED git repo with no commit
    // ("error: '<path>' does not have a commit checked out") makes `git add -A` FATAL
    // (exit 128) → stages NOTHING → `git commit` reports "nothing" → the WHOLE tree strands
    // silently, every tick, for hours (a green-checkpoint test left a nested .git under
    // .papercusp/.vitest-tmpdir/). The add's exit code was previously UNCHECKED, so the fatal
    // was invisible. Now: check it; on that specific failure, parse the offending path(s),
    // EXCLUDE them, and retry ONCE so one stray repo can't strand everyone's work; if it STILL
    // fails, return a LOUD 'error' (caught by the git-sync-stall watchdog + escalation) instead
    // of silently reporting 'nothing'.
    let omittedIgnoredExcludes: string[] = [];
    let addRes = await stageGit(buildAddArgs([]), repoPath);
    if (addRes.code !== 0) {
      // WI-40170: a protected path may ALSO be ignored. Git treats even a
      // negative pathspec as an explicit ignored-path mention and aborts the
      // entire add. The ignore rule already excludes it, so remove only those
      // redundant pathspecs and retry; never force-add the ignored file.
      const ignored = ignoredProtectedExclusions(`${addRes.stdout}\n${addRes.stderr}`, excludePaths);
      if (ignored.length > 0) {
        omittedIgnoredExcludes = ignored;
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' rejected ignored protected path(s) [${ignored.join(', ')}] — ` +
            'omitting those redundant exclusion pathspecs and retrying without force-adding ignored files',
        );
        addRes = await stageGit(buildAddArgs([], omittedIgnoredExcludes), repoPath);
      }
      // WI-6554700010018683: an exclusion added after the preflight (a deferred attributed
      // path, a refused migration) can still name a file inside a submodule. Git names one
      // submodule per failure, so drop that submodule's exclusions and retry; the bound is
      // the number of exclusions, since each round removes at least one.
      for (let round = 0; addRes.code !== 0 && round < stagingExcludePaths.length; round++) {
        const inSubmodule = inSubmoduleProtectedExclusions(
          `${addRes.stdout}\n${addRes.stderr}`,
          stagingExcludePaths,
        ).filter((path) => !omittedIgnoredExcludes.includes(path));
        if (inSubmodule.length === 0) break;
        omittedIgnoredExcludes = [...omittedIgnoredExcludes, ...inSubmodule];
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' rejected protected path(s) inside a submodule [${inSubmodule.join(', ')}] — ` +
            'omitting those redundant exclusion pathspecs and retrying (this repo stages only the gitlink)',
        );
        addRes = await stageGit(buildAddArgs([], omittedIgnoredExcludes), repoPath);
      }
      const stray = addFailureStrayPaths(`${addRes.stdout}\n${addRes.stderr}`);
      if (stray.length > 0) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' FAILED on embedded/uncommitted repo(s) [${stray.join(', ')}] — excluding + retrying so the rest of the tree still commits (previously: silent strand)`,
        );
        addRes = await stageGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // TRANSIENT-ENOENT SELF-HEAL (EI-18094449017685490): git's tree-walk
      // enumerated a path an instant before some other process's atomic
      // write-tmp+rename made it vanish. This is NOT a stray embedded repo and NOT
      // a held index lock — it's a benign, fast-resolving race, so retry the exact
      // same add a bounded few times (immediate; the writer's rename completes in
      // milliseconds) rather than failing the whole tick's commit on one
      // already-gone temp file.
      for (
        let attempt = 1;
        addRes.code !== 0 &&
        isTransientStatFailure(`${addRes.stdout}\n${addRes.stderr}`) &&
        attempt <= TRANSIENT_STAT_FAILURE_MAX_RETRIES;
        attempt++
      ) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' hit a transient ENOENT (a concurrent atomic-write race enumerated a path that vanished before stat) — retrying (attempt ${attempt}/${TRANSIENT_STAT_FAILURE_MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS));
        addRes = await stageGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // STALE-LOCK SELF-HEAL (2026-07-04): a dead git process's orphaned index.lock
      // otherwise fails EVERY tick until a human clears it. Provably-stale only —
      // see clearStaleIndexLock.
      addRes = await recoverIndexLockContention(
        addRes,
        () => stageGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath),
        runGit,
        repoPath,
        'git add -A',
        o.log,
      );
      if (addRes.code !== 0) {
        return {
          committedLocal: false,
          dirtyPathCount,
          committedCount,
          error: `git add -A failed — the tree would strand uncommitted: ${gitFailureDetail(addRes)}`,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
    }
    // Recheck after staging to catch a reservation removed during the add. A
    // known conflict defers only that migration; a failed/invalid read defers all
    // staged migration candidates fail-closed while unrelated staged work commits.
    if (o.migrationReservationChecker) {
      const stagedMigrationPaths = await stagedFiles(stageGit, repoPath);
      const postStageMigrationCheck = await checkMigrationReservations(o, stagedMigrationPaths);
      const postStageMigrationRefusals = postStageMigrationCheck.ok
        ? postStageMigrationCheck.refusals
        : migrationPaths(stagedMigrationPaths).map((path) => ({
            path,
            reason: `reservation check failed; deferring fail-closed: ${postStageMigrationCheck.error}`,
          }));
      if (!postStageMigrationCheck.ok) {
        o.log(
          `[git-sync] ${logScope}: post-stage migration reservation check failed; deferring staged migrations fail-closed: ` +
            `${postStageMigrationCheck.error}`,
        );
      }
      if (postStageMigrationRefusals.length > 0) {
        const refused = migrationReservationSkips(
          o.scope,
          postStageMigrationRefusals,
          skippedPaths,
          o.log,
          logScope,
        );
        migrationQuarantinedPaths = [...new Set([...migrationQuarantinedPaths, ...refused])];
        stagingExcludePaths = [...new Set([...stagingExcludePaths, ...refused])];
        const unstage = await unstagePreStagedProtectedPaths(stageGit, repoPath, refused, o.log);
        const unstageError = unstage.ok ? '' : `; could not unstage refused migration paths: ${unstage.error}`;
        if (!unstage.ok) {
          o.log(`[git-sync] ${logScope}: post-stage migration quarantine could not remove refused paths${unstageError}`);
          return {
            committedLocal: committedAny,
            dirtyPathCount,
            committedCount,
            error: `migration reservation quarantine after staging failed${unstageError}`,
            oversized,
            contentErrors,
            skippedPaths,
          };
        }
      }
    }
    // EI-24712906810240170: a lock taken, or a transient edit made and undone, after the
    // pre-stage refresh must not publish through the index this add just built.
    const catchAllGuard = await postStageGuard(stageGit);
    if (!catchAllGuard.ok) {
      return {
        committedLocal: committedAny,
        dirtyPathCount,
        committedCount,
        error: catchAllGuard.error,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    // WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the catch-all subject too is derived from
    // what is ACTUALLY staged (numstat over the staged set); the original message (the
    // sweep's intent/default stem, incl. its own [skip ci]) is demoted to the body for
    // traceability. Numstat failure or an empty staged set falls back to `message` alone
    // — byte-identical to the pre-WI-38594 commit.
    const messageArgs: string[] = [];
    let catchAllSubjected = false;
    if (o.diffSubjects !== false) {
      // On the private path the base is explicit: the index was seeded from it, and a HEAD
      // that moved since would make an implicit `--cached` diff describe the wrong base.
      const numstatBase = catchAllPrivate?.base ? [catchAllPrivate.base] : [];
      const ns = await stageGit(['diff', '--cached', '--numstat', ...numstatBase], repoPath);
      if (ns.code === 0) {
        const stats = parseNumstat(ns.stdout);
        if (stats.length > 0) {
          const subject = diffDerivedSubject(
            stats.map((s) => s.file),
            stats,
          );
          messageArgs.push('-m', `${subject}${skipCiSuffix(message)}`, '-m', message);
          catchAllSubjected = true;
        }
      }
    }
    if (!catchAllSubjected) messageArgs.push('-m', message);
    if (catchAllPrivate) {
      const privateBase = catchAllPrivate;
      // Bring the SHARED index's entries for exactly the committed paths up to the commit
      // BEFORE it is published, so the shared index never holds pre-commit blobs under the new
      // HEAD (they read as staged reverts). A path the guard held back is not in this diff,
      // so a peer's staged entry for it is untouched. A live writer's index.lock fails the
      // refresh and so the tick, without robbing the writer and without publishing a commit
      // the shared index cannot follow (the pre-WI-10006725 contract). If the CAS then
      // refuses, the refreshed entries match the working tree, which is benign.
      // The catch-all can commit thousands of paths: they go through a NUL pathspec file
      // (no argv limit) read literally (GIT_LITERAL_PATHSPECS: no glob magic), and the
      // reset is never run with an EMPTY pathspec, which would reset the whole index.
      const refreshSharedIndex = async (
        commit: string,
        tree: string,
      ): Promise<{ ok: true } | { ok: false; error: string }> => {
        const changed = await runGit(['diff', '--name-only', '--no-renames', '-z', privateBase.baseTree, tree], repoPath);
        if (changed.code !== 0) {
          return { ok: false, error: `catch-all commit not published: could not list its paths: ${gitFailureDetail(changed)}` };
        }
        const committedPaths = changed.stdout.split('\0').filter(Boolean);
        if (committedPaths.some((path) => custody.protectedPaths.includes(path))) {
          return custodyRefused('catch-all-publication-fence');
        }
        if (committedPaths.length === 0) return { ok: true };
        const pathspecFile = join(privateBase.gitDir, `papercusp-git-sync-catch-all-${process.pid}-${randomUUID()}.pathspec`);
        scratch.push(pathspecFile);
        await writeFile(pathspecFile, `${committedPaths.join('\0')}\0`);
        const resetArgs = ['reset', '-q', commit, `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul'];
        const literal = { env: { GIT_LITERAL_PATHSPECS: '1' } };
        const refresh = await recoverIndexLockContention(
          await runGit(resetArgs, repoPath, literal),
          () => runGit(resetArgs, repoPath, literal),
          runGit,
          repoPath,
          'catch-all shared-index refresh',
          o.log,
        );
        if (refresh.code === 0) return { ok: true };
        return {
          ok: false,
          error:
            `catch-all commit not published: the shared index could not be refreshed for ` +
            `${committedPaths.length} path(s): ${gitFailureDetail(refresh)}`,
        };
      };
      const published = await publishPrivateIndexCommit(runGit, stageGit, repoPath, {
        base: privateBase.base,
        baseTree: privateBase.baseTree,
        label: 'catch-all commit',
        reflogMessage: 'git-sync: catch-all commit',
        onPublished: o.onPublished,
        messageArgs: async () => messageArgs,
        beforePublish: refreshSharedIndex,
      });
      if (published.status === 'committed') {
        committedAny = true;
        committedCount += 1;
      } else if (published.status !== 'nothing') {
        // P-002 (below): a commit that did not land must surface as an error, never fall
        // into the merge phase with a dirty tree. A refused CAS means HEAD moved while the
        // catch-all was being built; nothing was published and the next tick retries.
        return {
          committedLocal: false,
          dirtyPathCount,
          committedCount,
          error:
            published.status === 'cas-refused'
              ? `catch-all commit not published: HEAD moved while it was being built (update-ref CAS refused: ${published.detail})`
              : published.error,
          oversized,
          contentErrors,
          skippedPaths,
        };
      }
      committedLocal = committedAny;
      return { committedLocal, dirtyPathCount, committedCount, oversized, contentErrors, skippedPaths };
    }
    const commitArgs = [...GIT_SYNC_IDENTITY_ARGS, 'commit', '--no-verify', ...messageArgs];
    let c = await runGit(commitArgs, repoPath);
    c = await recoverIndexLockContention(c, () => runGit(commitArgs, repoPath), runGit, repoPath, 'git commit', o.log);
    if (c.code === 0) {
      committedAny = true;
      committedCount += 1;
      if (o.onPublished) {
        const sha = await headSha(runGit, repoPath);
        if (sha) o.onPublished(sha);
      }
    } else if (!nothingToCommit(c)) {
      // P-002: a real commit failure (index.lock race, corrupt index, a hook) is NOT
      // a merge conflict. If the still-dirty tree fell through to the merge phase it
      // would abort as a phantom 'conflict' with zero conflicted files and dispatch a
      // merge-resolver at nothing, while the true failure (agents' work not landing)
      // stayed invisible. Surface it as an error.
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount,
        error: `commit failed: ${gitFailureDetail(c)}`,
        oversized,
        contentErrors,
        skippedPaths,
      };
    }
    committedLocal = committedAny;
  }
  return { committedLocal, dirtyPathCount, committedCount, oversized, contentErrors, skippedPaths };
}

/** JSON-serializable — checkpointed as the superproject `git-sync:push` step output. */
type ReconcilePushResult =
  | { status: 'nothing'; mergeCompleted?: boolean; syncBack?: SyncBackResult }
  | { status: 'synced'; pushed: boolean; merged: boolean; mergeCompleted?: boolean; syncBack?: SyncBackResult }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string; mergeCompleted?: boolean };

export type ContainedAncestryBridgeResult =
  | { status: 'not-needed' }
  | { status: 'bridged'; sourceRef: string; joinedSha: string; changedPaths: string[] }
  | { status: 'declined'; reason: string }
  | { status: 'error'; message: string };

export type ContainedReleaseMainBridgeResult = ContainedAncestryBridgeResult;

const CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS = 200;

/**
 * Join an arbitrary source commit into the current branch's ancestry without
 * changing the current branch's tree.
 *
 * This bridge is deliberately fail-closed. It runs only for the staging branch,
 * and only when EVERY path changed exclusively on the source has the exact same
 * Git tree entry (mode + object id, including deletions and gitlinks) at local
 * HEAD. Once proven, an `ours` merge records the source as a parent while
 * preserving the current tree. A mismatch is a no-op: callers never fabricate
 * ancestry over unrepresented content.
 *
 * Frozen-repair verification calls this with its local `repairHead` BEFORE any
 * main advance. git-sync's recovery wrapper below calls it with `origin/main`
 * when an older gate already promoted a sibling repair head.
 */
export async function bridgeContainedCommitIntoCurrentBranch(
  runGit: RunGit,
  repoPath: string,
  sourceRef: string,
  opts: { log: (message: string) => void },
): Promise<ContainedAncestryBridgeResult> {
  const exists = await runGit(['rev-parse', '--verify', '--quiet', sourceRef], repoPath);
  if (exists.code !== 0) return { status: 'not-needed' };

  const alreadyContained = await runGit(['merge-base', '--is-ancestor', sourceRef, 'HEAD'], repoPath);
  if (alreadyContained.code === 0) return { status: 'not-needed' };
  if (alreadyContained.code !== 1) {
    return { status: 'error', message: `could not compare HEAD with ${sourceRef}` };
  }

  const base = await runGit(['merge-base', 'HEAD', sourceRef], repoPath);
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || !mergeBase) {
    return { status: 'declined', reason: `${sourceRef} has no merge base with HEAD` };
  }

  const changed = await runGit(['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${sourceRef}`], repoPath);
  if (changed.code !== 0) {
    return { status: 'error', message: `could not enumerate ${sourceRef}-only paths` };
  }
  const changedPaths = changed.stdout.split('\0').filter(Boolean);
  if (changedPaths.length > CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS) {
    return {
      status: 'declined',
      reason: `${sourceRef} changes ${changedPaths.length} paths (cap ${CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS})`,
    };
  }

  for (const file of changedPaths) {
    const [onSource, onHead] = await Promise.all([
      runGit(['ls-tree', sourceRef, '--', file], repoPath),
      runGit(['ls-tree', 'HEAD', '--', file], repoPath),
    ]);
    if (onSource.code !== 0 || onHead.code !== 0) {
      return { status: 'error', message: `could not compare '${file}' across ${sourceRef} and HEAD` };
    }
    if (onSource.stdout.trim() !== onHead.stdout.trim()) {
      return {
        status: 'declined',
        reason: `${sourceRef}-only path '${file}' is not represented exactly on HEAD`,
      };
    }
  }

  const merge = await runGit([...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', '-s', 'ours', sourceRef], repoPath);
  if (merge.code !== 0) {
    await runGit(['merge', '--abort'], repoPath);
    return {
      status: 'error',
      message: `contained ${sourceRef} ancestry bridge failed: ${gitFailureDetail(merge)}`,
    };
  }
  const joined = await runGit(['rev-parse', 'HEAD'], repoPath);
  const joinedSha = joined.stdout.trim();
  if (joined.code !== 0 || !joinedSha) {
    return { status: 'error', message: `contained ${sourceRef} bridge committed but HEAD could not be resolved` };
  }

  opts.log(
    `[git-sync] ${repoPath}: bridged fully-represented ${sourceRef} into current ancestry ` +
      `without changing the current tree (${changedPaths.length} source-only path(s))`,
  );
  return { status: 'bridged', sourceRef, joinedSha, changedPaths };
}

/** Refresh and reconcile the release gate's `main` lineage into canonical
 * staging. This is the post-incident wrapper; pre-promotion repair verification
 * reuses {@link bridgeContainedCommitIntoCurrentBranch} with its local head. */
export async function bridgeContainedReleaseMain(
  runGit: RunGit,
  repoPath: string,
  opts: { remote: string; branch: string; log: (message: string) => void },
): Promise<ContainedReleaseMainBridgeResult> {
  if (opts.branch !== 'staging') return { status: 'not-needed' };

  const mainRef = `${opts.remote}/main`;
  const fetched = await runNetworkGitWithGitHubHttpsFallback(
    runGit,
    ['fetch', opts.remote, 'main'],
    repoPath,
    opts.log,
  );
  if (fetched.code !== 0) {
    return {
      status: 'declined',
      reason: `could not refresh ${mainRef}: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`,
    };
  }
  return bridgeContainedCommitIntoCurrentBranch(runGit, repoPath, mainRef, {
    log: opts.log,
  });
}

/** WI-10003527: `--deepen` rung sizes for {@link deepenShallowUntilMergeBase}; `--unshallow` is the last rung. */
export const SHALLOW_MERGE_BASE_DEEPEN_RUNGS = [64, 512, 4096] as const;

type ShallowDeepenOutcome =
  | { status: 'not-shallow' }
  | { status: 'found'; rung: string }
  | { status: 'exhausted'; message: string };

/**
 * WI-10003527: a SHALLOW clone has no merge-base with `<remote>/<branch>` until
 * enough history is present, and a plain `git fetch` never supplies it once the
 * remote tip is already local. Measured on the P-203 Mac VM: depth-1 submodules
 * (HEAD 8564ae4 depth 1, origin/main 4c32764 depth 1, HEAD really 26 commits
 * behind) failed `git merge` with "refusing to merge unrelated histories" on 55
 * consecutive ticks, because the merge leg's only no-merge-base recovery was the
 * installer-seed transplant, which a plain shallow clone never matches.
 *
 * Deepen in bounded rungs until `merge-base HEAD <remoteRef>` resolves, ending
 * with `--unshallow`. If the repo is complete and there is STILL no merge-base,
 * the histories really are unrelated: report it and let the caller keep that a
 * loud error (never `--allow-unrelated-histories`).
 */
async function deepenShallowUntilMergeBase(
  runGit: RunGit,
  repo: string,
  remote: string,
  branch: string,
  remoteRef: string,
  log: (m: string) => void,
): Promise<ShallowDeepenOutcome> {
  const isShallow = async (): Promise<boolean> => {
    const r = await runGit(['rev-parse', '--is-shallow-repository'], repo);
    return r.code === 0 && r.stdout.trim() === 'true';
  };
  if (!(await isShallow())) return { status: 'not-shallow' };
  const rungs = [
    ...SHALLOW_MERGE_BASE_DEEPEN_RUNGS.map((n) => ({ label: `--deepen=${n}`, arg: `--deepen=${n}` })),
    { label: '--unshallow', arg: '--unshallow' },
  ];
  let lastError = '';
  for (const rung of rungs) {
    const fetched = await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', rung.arg, remote, branch], repo, log);
    if (fetched.code !== 0) {
      lastError = `fetch ${rung.label} failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`;
      log(`[git-sync] ${repo}: shallow deepen ${lastError}`);
      continue;
    }
    const base = await runGit(['merge-base', 'HEAD', remoteRef], repo);
    if (base.code === 0) {
      log(`[git-sync] ${repo}: shallow repo had no merge-base with ${remoteRef}; ${rung.label} recovered one`);
      return { status: 'found', rung: rung.label };
    }
    if (!(await isShallow())) {
      return { status: 'exhausted', message: `repo is complete after ${rung.label} and still has no merge-base with ${remoteRef}` };
    }
  }
  return { status: 'exhausted', message: lastError || `no merge-base with ${remoteRef} after every deepen rung` };
}

/**
 * WI-1416: the RECONCILE+PUSH half of one repo's sync — resolve branch → fetch →
 * merge (handles diverged/behind) → push (one non-FF retry). Replay-safe: a re-run
 * re-fetches, proves an already-pushed HEAD is aligned, and skips the authenticated no-op push.
 */
/**
 * WI-10008133: publish HEAD as the first commit of an EMPTY remote. Returns null when
 * the remote has any head, or cannot be listed, so the caller keeps its fail-loud
 * missing-branch path for a mistyped branch on a populated remote.
 */
async function firstPublishToEmptyRemote(
  runGit: RunGit,
  repoPath: string,
  remote: string,
  branch: string,
  log: ReconcileRepoOpts['log'],
): Promise<ReconcilePushResult | null> {
  const heads = await runNetworkGitWithGitHubHttpsFallback(runGit, ['ls-remote', '--heads', remote], repoPath, log);
  if (heads.code !== 0 || heads.stdout.trim() !== '') return null;
  log(`[git-sync] ${repoPath}: ${remote} has no branches; publishing HEAD as the first commit of '${branch}'`);
  const push = await runNetworkGitWithGitHubHttpsFallback(
    runGit,
    ['push', remote, `HEAD:refs/heads/${branch}`],
    repoPath,
    log,
  );
  if (push.code !== 0) {
    return {
      status: 'error',
      message: `first publish to empty ${remote}/${branch} failed: ${push.stderr.trim() || push.stdout.trim()}`,
    };
  }
  return { status: 'synced', pushed: true, merged: false };
}

async function reconcileAndPushOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: ReconcileRepoOpts,
  /** whether the commit half made a local commit this pass (drives the fetch-failure
   *  classification + the final nothing/synced verdict). */
  committedLocal: boolean,
): Promise<ReconcilePushResult> {
  const { remote, doPush } = o;
  // P-004: a detached HEAD (a fresh `git submodule update` leaves submodules detached)
  // must sync to the repo's OWN remote default branch (origin/HEAD → e.g. 'main'), NOT
  // the superproject's configured branch — o.defaultBranch carries 'staging' for the
  // live superproject, and using it for a detached submodule would push that submodule's
  // commits to the wrong branch and fail every tick with no clear cause. origin/HEAD
  // resolves the right branch; o.defaultBranch is only the last resort when even that is
  // unknown (and is now passed per-repo: 'main' for submodules, cfg.branch for the super).
  // P-011: HEAD's branch → the remote default (origin/HEAD) → the per-repo last-resort
  // default. If we reach the last resort the branch is a GUESS — make it LOUD (a wrong
  // guess would otherwise surface only as an opaque "push failed" escalation).
  const attachedBranch = await currentBranch(runGit, repoPath);
  const ownRemoteDefault = await remoteDefaultBranch(runGit, repoPath, remote);
  const exactRemoteBranches = await remoteBranchesPointingAtHead(runGit, repoPath, remote);
  const preservedRemoteBranch = preferredRemoteBranchAtHead(exactRemoteBranches, ownRemoteDefault);
  let resolvedBranch = attachedBranch ?? preservedRemoteBranch ?? ownRemoteDefault;

  // A clean attached branch can be a local, task-specific name whose exact HEAD
  // was deliberately published under a preservation branch. Fetching the absent
  // same-name branch falsely reports the already-safe gitlink as unpushed. Use
  // the exact remote proof only before this pass creates a new local commit; a
  // newly advanced branch still has to publish under its attached name.
  if (attachedBranch && !committedLocal && preservedRemoteBranch && preservedRemoteBranch !== attachedBranch) {
    const attachedRemoteRef = await runGit(
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${attachedBranch}`],
      repoPath,
    );
    if (attachedRemoteRef.code === 1) {
      resolvedBranch = preservedRemoteBranch;
      o.log(
        `[git-sync] ${repoPath}: local branch '${attachedBranch}' has no ${remote} tracking ref, but HEAD is ` +
          `already preserved at ${remote}/${preservedRemoteBranch}; reconciling the proved remote branch`,
      );
    }
  } else if (!attachedBranch && preservedRemoteBranch && preservedRemoteBranch !== ownRemoteDefault) {
    o.log(
      `[git-sync] ${repoPath}: detached HEAD is already preserved at ${remote}/${preservedRemoteBranch}; ` +
        'reconciling that exact-tip remote branch',
    );
  }
  const branch = resolvedBranch ?? o.defaultBranch;
  if (!resolvedBranch) {
    o.log(
      `[git-sync] ${repoPath}: could not resolve a branch from HEAD or ${remote}/HEAD — falling back to '${o.defaultBranch}' (a wrong guess will fail the push; P-011)`,
    );
  }

  const stale = await scavengeStaleTempPacks(runGit, repoPath, o.log, {
    staleMs: o.staleTempPackMs,
    isOpen: o.isTempPackOpen,
  });
  if (stale.removed.length > 0) {
    o.log(
      `[git-sync] ${repoPath}: stale tmp_pack cleanup; pruned ${stale.removed.length} unopened unreferenced file(s), reclaimed ${stale.bytesReclaimed} bytes`,
    );
  }
  // WI-6554700010018201: an orphaned objects/maintenance.lock silently disables
  // git's auto-gc for this repo. Best-effort: a failed check must never fail the sync.
  try {
    await clearStaleMaintenanceLock(runGit, repoPath, o.log, o.isGitLockOpen ? { isOpen: o.isGitLockOpen } : {});
  } catch (e) {
    o.log(
      `[git-sync] ${repoPath}: objects/maintenance.lock check failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const zeroByteLooseObjects = await findZeroByteLooseObjects(runGit, repoPath);
  if (zeroByteLooseObjects.length > 0) {
    return {
      status: 'error',
      message:
        `local Git object database corrupt: ${zeroByteLooseObjects.length} zero-byte loose object(s): ` +
        `${zeroByteLooseObjects.join(', ')}; repair required before fetch`,
    };
  }
  const tempPacksBeforeFetch = await listTempPackFiles(runGit, repoPath);
  // A single-branch clone can exclude this branch from remote.<name>.fetch.
  // A name-only fetch then writes only FETCH_HEAD: reconciliation cannot find
  // the tracking ref, and later ticks download the same unreferenced history.
  const fetchArgs = ['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
  const fetch = await runNetworkGitWithGitHubHttpsFallback(runGit, fetchArgs, repoPath, o.log);
  if (fetch.code !== 0) {
    const reclaimed = await pruneFailedFetchTempPacks(runGit, repoPath, tempPacksBeforeFetch, o.log);
    const cleanupNote =
      reclaimed.removed.length > 0
        ? `; pruned ${reclaimed.removed.length} newly-created unreferenced tmp_pack file(s), reclaimed ${reclaimed.bytesReclaimed} bytes`
        : '';
    if (cleanupNote) o.log(`[git-sync] ${repoPath}: failed fetch cleanup${cleanupNote}`);
    // WI-10008133: a missing remote branch is deliberately fatal below, so a mistyped
    // branch fails loudly. A freshly created EMPTY remote has nothing to mistype, yet the
    // same rule stranded its first publish forever (slack-asana-bug-drill: 154 failed
    // ticks). Only a remote with ZERO heads gets HEAD published as its first commit.
    if (doPush && /couldn't find remote ref/i.test(fetch.stderr)) {
      const firstPublish = await firstPublishToEmptyRemote(runGit, repoPath, remote, branch, o.log);
      if (firstPublish) return firstPublish;
    }
    // Fetch failed (offline / transient). GAP-4: when we're meant to push and HEAD has
    // commits not on the last-known origin tip, those commits are NOT on origin — return
    // 'error' so runGitSync DEFERS the superproject. Otherwise the superproject would
    // commit + push a gitlink pointing at an unpushed submodule commit, which a fresh
    // clone can't resolve (this actually corrupted origin once). With push disabled, a
    // local commit is the expected local-only result.
    if (o.requireRemoteVerification) {
      const reason = summarizeFetchFailure(fetch.stderr || fetch.stdout);
      return {
        status: 'error',
        message:
          `fetch failed; submodule remote state could not be verified before superproject publication` +
          `${reason ? `: ${reason}` : ''}${cleanupNote}`,
      };
    }
    if (doPush) {
      const rl = await runGit(['rev-list', '--count', `${remote}/${branch}..HEAD`], repoPath);
      const aheadCount = rl.code === 0 ? Number.parseInt(rl.stdout.trim(), 10) || 0 : 1; // ref missing → assume unpushed
      if (committedLocal || aheadCount > 0) {
        // WI-10004103: carry WHY the fetch failed. Without it a disk-headroom refusal
        // (withGitFetchHeadroom), a corrupt object store and a real network error all read
        // as the same "cannot reconcile", and the stall gets filed as a credentials bug.
        const reason = summarizeFetchFailure(fetch.stderr);
        return {
          status: 'error',
          message:
            `fetch failed; HEAD has unpushed commits not on ${remote}/${branch} (cannot reconcile)` +
            `${reason ? `: ${reason}` : ''}${cleanupNote}`,
        };
      }
      return { status: 'nothing' };
    }
    return committedLocal ? { status: 'synced', pushed: false, merged: false } : { status: 'nothing' };
  }

  const remoteRef = `${remote}/${branch}`;
  let seedTransplanted = false;
  const base = await runGit(['merge-base', 'HEAD', remoteRef], repoPath);
  // WI-10003527: a shallow clone first gets the history a merge-base needs; only a
  // repo that still has none (not shallow, or genuinely unrelated) reaches the seed path.
  const deepened =
    base.code !== 0
      ? await deepenShallowUntilMergeBase(runGit, repoPath, remote, branch, remoteRef, o.log)
      : null;
  if (base.code !== 0 && deepened?.status !== 'found') {
    if (deepened?.status === 'exhausted') o.log(`[git-sync] ${repoPath}: shallow deepen exhausted: ${deepened.message}`);
    const seed = await transplantInstallerSeedSnapshot(runGit, repoPath, remoteRef, remote, o.log);
    if (seed.status === 'error') return { status: 'error', message: seed.message };
    seedTransplanted = seed.status === 'transplanted';
  }

  // WI-5111: a non-fast-forward merge creates its own commit under the box's git
  // identity too — same bot-identity override as the commit calls above, so a
  // merge commit git-sync makes is never misattributed to the owner either.
  // WI-10003529: the merge writes the index too, so it gets the same stale-orphan
  // recovery as add/commit. A clean submodule never runs `git add`, so before this
  // its merge was the FIRST index writer to meet an orphaned index.lock — and it
  // returned "merge failed (no conflicted paths)" every tick forever (P-203 Mac VM,
  // libs/papercusp-db, 2026-09-27: lock 65+ min old, lsof proved no holder).
  // Git's submodule merge-ort path calls repo_in_merge_bases() on the submodule repo,
  // but the commit-graph fast path currently parses through the process-global
  // superproject repository. That makes valid submodule commits look unreadable.
  // Keep the slower object-walk fallback scoped to superprojects with submodules.
  const mergeIdentityArgs = [
    ...GIT_SYNC_IDENTITY_ARGS,
    ...(o.disableCommitGraphForSubmoduleMerge ? ['-c', 'core.commitGraph=false'] : []),
  ];
  const mergeArgs = [...mergeIdentityArgs, 'merge', '--no-edit', `${remote}/${branch}`];
  const merge = await recoverIndexLockContention(
    await runGit(mergeArgs, repoPath),
    () => runGit(mergeArgs, repoPath),
    runGit,
    repoPath,
    'git merge',
    o.log,
  );
  if (merge.code !== 0) {
    const infrastructureError = gitSyncPreDispatchError(merge);
    if (infrastructureError) return { status: 'error', message: infrastructureError };
    const conflicted = await conflictedFiles(runGit, repoPath);
    const mergeOut = `${merge.stdout}\n${merge.stderr}`.trim();
    await runGit(['merge', '--abort'], repoPath); // clean tree
    // P-002: a failed merge with NO unmerged paths is not a content conflict a
    // merge-resolver can fix (e.g. "local changes would be overwritten", "not
    // something we can merge") — surface as error, don't dispatch a resolver at it.
    if (conflicted.length === 0) {
      // WI-6824: the ref pair rides in the MESSAGE, not a second log call — runGitSync's
      // `absorb` already logs every error verbatim, so the message is what reaches both
      // the journal and `last_error`. One channel, no divergence between the two records.
      const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'initial');
      return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${mergeOut.slice(0, 300)}` };
    }
    return { status: 'conflict', conflictedFiles: conflicted };
  }
  // A successful merge is evidence that this repo's merge stage completed cleanly,
  // even when it produced no merge commit. Keep that proof alive if a later push
  // fails: conflict resolution and push success are independent facts.
  let mergeCompleted = true;
  let mergedNew = seedTransplanted || !/Already up to date/i.test(merge.stdout);

  // P-016 sync-back: a working-copy pot pushes its fork, so the main repository's
  // branch (including our merged standing PR) must be merged into staging here, or the
  // next PR re-lists already-merged work. A conflict aborts to a clean tree and is
  // reported on the result; it never blocks pushing the copy's own work.
  let syncBack: SyncBackResult | undefined;
  if (o.syncBack && doPush && branch === 'staging') {
    syncBack = await runSyncBack(runGit, repoPath, {
      ...o.syncBack,
      integrationBranch: branch,
      runNetworkGit: (args, cwd) => runNetworkGitWithGitHubHttpsFallback(runGit, args, cwd, o.log),
      identityArgs: mergeIdentityArgs,
      log: o.log,
    });
    if (syncBack.status === 'merged') mergedNew = true;
    if (syncBack.status === 'error') o.log(`[git-sync] ${repoPath}: sync-back skipped this tick — ${syncBack.message}`);
  }
  // D-017 §4 (P-014): a submodule that absorbed an upstream pin holds commits its fork has
  // not received (submodules were pushed earlier this tick). Publishing the superproject now
  // would put a gitlink on the fork that resolves nowhere, so its push waits one tick: the
  // next tick pushes those submodules first (deepest-first), then the superproject.
  const absorbedSubmodules = syncBack?.status === 'merged' ? (syncBack.absorbedSubmodules ?? []) : [];
  if (doPush && absorbedSubmodules.length > 0) {
    o.log(
      `[git-sync] ${repoPath}: holding this tick's push — submodule(s) ${absorbedSubmodules.join(', ')} absorbed ` +
        'upstream commits their forks have not received yet; the next tick pushes them first',
    );
  }

  // Frozen repair heads are allowed to prove a patch, but canonical staging remains
  // the only branch git-sync publishes. If a previously-promoted repair head is a
  // sibling whose exact content is already represented here, join only its ancestry
  // before pushing staging. The helper declines on any content uncertainty.
  if (doPush && branch === 'staging') {
    const releaseBridge = await bridgeContainedReleaseMain(runGit, repoPath, {
      remote,
      branch,
      log: o.log,
    });
    if (releaseBridge.status === 'error') {
      return { status: 'error', message: releaseBridge.message, mergeCompleted };
    }
    if (releaseBridge.status === 'bridged') mergedNew = true;
    if (releaseBridge.status === 'declined') {
      o.log(`[git-sync] ${repoPath}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
    }
  }

  let pushed = false;
  if (doPush && absorbedSubmodules.length === 0) {
    // The successful fetch + merge gives us a current remote-tracking ref. When
    // HEAD has no commits beyond it, an authenticated push can move nothing and
    // should not be allowed to fail the whole harness on an unrelated credential
    // policy (EI-20328688606935149). If the comparison itself fails, retain the
    // existing push behavior so uncertainty can never strand a real commit.
    const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], repoPath);
    const aheadText = ahead.stdout.trim();
    const aheadCount = ahead.code === 0 && /^\d+$/.test(aheadText) ? Number.parseInt(aheadText, 10) : null;
    if (aheadCount !== 0) {
      let push = await runNetworkGitWithGitHubHttpsFallback(
        runGit,
        ['push', remote, `HEAD:${branch}`],
        repoPath,
        o.log,
      );
      if (push.code !== 0 && rejectedNonFastForward(push)) {
        // A peer pushed between our fetch and push — re-fetch + re-merge once.
        await runNetworkGitWithGitHubHttpsFallback(runGit, fetchArgs, repoPath, o.log);
        const m2 = await recoverIndexLockContention(
          await runGit(mergeArgs, repoPath),
          () => runGit(mergeArgs, repoPath),
          runGit,
          repoPath,
          'git merge (non-ff retry)',
          o.log,
        );
        if (m2.code !== 0) {
          const infrastructureError = gitSyncPreDispatchError(m2);
          if (infrastructureError) return { status: 'error', message: infrastructureError };
          const conflicted = await conflictedFiles(runGit, repoPath);
          const m2Out = `${m2.stdout}\n${m2.stderr}`.trim();
          await runGit(['merge', '--abort'], repoPath);
          if (conflicted.length === 0) {
            const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'non-ff-retry');
            return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${m2Out.slice(0, 300)}` };
          }
          return { status: 'conflict', conflictedFiles: conflicted };
        }
        // The retry merge also completed cleanly; retain the positive proof for a
        // subsequent push error. A retry conflict/error returns above without proof.
        mergeCompleted = true;
        mergedNew = mergedNew || !/Already up to date/i.test(m2.stdout);
        push = await runNetworkGitWithGitHubHttpsFallback(runGit, ['push', remote, `HEAD:${branch}`], repoPath, o.log);
      }
      if (push.code !== 0) {
        return {
          status: 'error',
          message: `push failed: ${push.stderr.trim() || push.stdout.trim()}`,
          mergeCompleted,
        };
      }
      pushed = !/Everything up-to-date/i.test(`${push.stdout}\n${push.stderr}`);
    }
  }

  if (!committedLocal && !mergedNew && !pushed) return { status: 'nothing', mergeCompleted, ...(syncBack ? { syncBack } : {}) };
  return { status: 'synced', pushed, merged: mergedNew, mergeCompleted, ...(syncBack ? { syncBack } : {}) };
}

/**
 * Sync ONE repo (superproject or a single submodule) to origin: commit dirty →
 * fetch → merge (reconciling a diverged/behind remote) → push. Never throws.
 * Composed from the two halves above (each independently checkpointable for the
 * superproject; submodules run both halves inside one phase step).
 */
async function syncOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts & {
    remote: string;
    defaultBranch: string;
    doPush: boolean;
    requireRemoteVerification?: boolean;
  },
): Promise<RepoSyncResult> {
  const c = await commitOneRepo(runGit, repoPath, o);
  // A reservation refusal is a path-level quarantine: commitOneRepo has
  // excluded the migration while still committing unrelated files. Blocking
  // this repo's push here would strand that safe commit and the unrelated work.
  // Other skip kinds (such as live locks) still defer the repo's network step.
  const repoWideSkip = (c.skippedPaths ?? []).some(
    (entry) => !('reason' in entry && entry.reason === 'migration-reservation'),
  );
  if (repoWideSkip) {
    return {
      status: 'skipped-locked',
      dirtyPathCount: c.dirtyPathCount,
      committedCount: c.committedCount,
      skippedPaths: c.skippedPaths,
      oversized: c.oversized,
      contentErrors: c.contentErrors,
    };
  }
  if (c.error) {
    return {
      status: 'error',
      message: c.error,
      dirtyPathCount: c.dirtyPathCount,
      committedCount: c.committedCount,
      oversized: c.oversized,
      contentErrors: c.contentErrors,
    };
  }
  const r = await reconcileAndPushOneRepo(runGit, repoPath, o, c.committedLocal);
  return {
    ...r,
    ...(c.skippedPaths && c.skippedPaths.length > 0 ? { skippedPaths: c.skippedPaths } : {}),
    dirtyPathCount: c.dirtyPathCount,
    committedCount: c.committedCount,
    oversized: c.oversized,
    contentErrors: c.contentErrors,
  };
}

/**
 * Run one git-sync pass for `slug`. Syncs all submodules (recursively, deepest-first)
 * then the superproject. Returns a structured outcome; never throws. The caller
 * (git-sync-action) handles `conflict` (escalation + resolver, scoped to each repo
 * that conflicted) and records metadata.
 *
 * A conflict in ONE submodule no longer aborts the whole pass: every other submodule
 * still gets reconciled + pushed (a wedged libs/X must not block libs/Y). Conflicts +
 * errors are COLLECTED. The superproject, however, is only synced when EVERY submodule
 * reconciled — pushing the superproject while a submodule's local commits aren't yet on
 * its origin would publish a gitlink a fresh clone can't resolve. So a single
 * unreconciled submodule defers the superproject push to a later (clean) tick.
 */
export async function runGitSync(slug: string, opts: RunGitSyncOpts = {}): Promise<GitSyncOutcome> {
  // WI-6554700010018198: collected here rather than threaded through every return
  // branch, so no outcome path can drop it.
  const attribution: AttributionTally[] = [];
  const out = await runGitSyncPass(slug, opts, (t) => attribution.push(t));
  return attribution.length > 0 ? { ...out, attribution } : out;
}

async function runGitSyncPass(
  slug: string,
  opts: RunGitSyncOpts,
  emitAttribution: (t: AttributionTally) => void,
): Promise<GitSyncOutcome> {
  /**
   * An action-level stall guard can abort the owning fire while a git child is
   * still draining its SIGTERM/SIGKILL grace period.  Check the signal at the
   * command seam as well as in the child runner: otherwise a late child result
   * could let this pipeline start the next git phase after its locks were
   * already released.
   */
  const throwIfAborted = (): void => {
    if (!opts.signal?.aborted) return;
    const reason = opts.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error('git-sync action aborted by its liveness guard');
  };
  const reportProgress = (): void => {
    try {
      opts.onProgress?.();
    } catch {
      // Progress accounting is diagnostic-only and must never break git-sync.
    }
  };
  const baseRunGit: RunGit =
    opts.runGit ??
    ((args, cwd, gitOptions) =>
      runGitBounded(args, cwd, gitTimeoutMsFor(args), {
        onProgress: reportProgress,
        signal: opts.signal,
        env: gitOptions?.env,
        diagnosticTags: gitOptions?.diagnosticTags,
      }));
  const runGit: RunGit = async (args, cwd, gitOptions) => {
    throwIfAborted();
    reportProgress();
    if (gitSubcommand(args) === 'push' && opts.beforePush) {
      try {
        await opts.beforePush(args, cwd);
      } catch (error) {
        throwIfAborted();
        return {
          code: 1,
          stdout: '',
          stderr: `git-sync publication refused: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      throwIfAborted();
    }
    const startedAt = performance.now();
    try {
      const result = await baseRunGit(args, cwd, gitOptions);
      reportProgress();
      throwIfAborted();
      return result;
    } finally {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= 10_000) {
        const scope = repo && cwd.startsWith(`${repo}/`) ? cwd.slice(repo.length + 1) : 'superproject';
        log(`[git-sync] ${slug}/${scope}: slow git ${gitSubcommand(args)} call (${elapsedMs}ms, includes dispatch/admission/child/transport)`);
      }
    }
  };
  const cfg = opts.config ?? {};
  const remote = cfg.remote ?? 'origin';
  const branch = cfg.branch ?? 'main';
  const doPush = cfg.push !== false;
  // EI-18689553108460319: submodule origin-push is INDEPENDENT of the superproject's
  // `push` flag — see the GitSyncConfig doc comment for why they must not share one knob.
  //
  // WI-6016: but that independence is OPT-IN, not the default. Defaulting it to `true`
  // regardless of `push` made the knob fail-OPEN and silently regressed the S0
  // no-direct-push invariant (AH-6, code-plane-federation.test.ts, 2026-06-20): a
  // JOINER — `decideGitSyncPush({ joinerSide: true })`, a read-only member clone whose
  // contribution path is fork-PR — carries push:false for a completely different reason
  // than a bridged hive does, and it must push NOTHING, ANYWHERE. A bare `push:false`
  // does not say WHICH reason applies, so the safe default is to follow `push` and let
  // the one caller that genuinely wants the split (git-sync-action's hive-mode override,
  // where the bridge owns only the SUPERPROJECT's canonical refs — never an
  // independently-hosted submodule library) opt back in EXPLICITLY.
  const doSubPush = cfg.pushSubmoduleOrigins !== undefined ? cfg.pushSubmoduleOrigins : doPush;
  const doSub = cfg.pushSubmodules !== false;
  const reconcileSuperprojectOrigin = cfg.reconcileSuperprojectOrigin !== false;
  const bridgeContainedReleaseMainOnCommitOnly = cfg.bridgeContainedReleaseMainOnCommitOnly === true;
  const message = cfg.message ?? `chore(git-sync): auto-commit ${slug} [skip ci]`;
  const maxBlobBytes = cfg.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const maxCommitTotalBytes = cfg.maxCommitTotalBytes ?? DEFAULT_MAX_COMMIT_TOTAL_BYTES;
  // WI-6824: this default was `() => {}`, and the SOLE production caller
  // (git-sync-action.ts) passes no `log` — so every line below was discarded in
  // production: oversized exclusions, content quarantines, merge conflicts, merge
  // ERRORS, and the P-011 branch-guess warning whose own comment says "make it LOUD".
  // That is why an unrelated-history merge failure could alarm the fleet for ~10h
  // across 39 sweeps while leaving ZERO occurrences in journald, recorded only in
  // routine metadata that the next healthy tick nulls. Defaulting to a REAL sink fixes
  // the class rather than one call site: a caller can no longer go dark by omission,
  // only by explicitly passing a silent log. Every call site here is an exceptional
  // event — a healthy tick still logs nothing.
  const log = opts.log ?? ((m: string) => console.warn(m));
  // WI-1416: the checkpoint seam — each phase below runs under `step` so a durable
  // caller records one operation_output per phase (see GitSyncStepRunner).
  const step: GitSyncStepRunner = opts.step ?? (async (_name, fn) => fn());
  // EI-438 content guard seams (default registry + fs reader; injectable for tests).
  const contentDetectors = opts.contentDetectors ?? DEFAULT_CONTENT_DETECTORS;
  const deletionGuard = opts.deletionGuard ?? true;
  const readText = opts.readText ?? defaultReadText;
  const writeText = opts.writeText ?? defaultWriteText;
  const toolCatalogRegenerator = opts.toolCatalogRegenerator ?? regenerateToolCatalogBeforeCommit;
  const generatedDeclarationsRegenerator =
    opts.generatedDeclarationsRegenerator ?? regenerateGeneratedDeclarationsBeforeCommit;
  const toolRoutingChecker = opts.toolRoutingChecker ?? checkToolRoutingBeforeCommit;
  const protectedPaths = [...new Set((opts.excludePaths ?? []).map((path) => path.trim()).filter(Boolean))];
  const protectedHoldings = (opts.liveLockHoldings ?? [])
    .map((holding) => ({
      path: holding.path.trim(),
      owner: holding.owner,
      intent: holding.intent,
      ...(holding.goalRef?.trim() ? { goalRef: holding.goalRef.trim() } : {}),
      ...(holding.heldSince ? { heldSince: holding.heldSince } : {}),
    }))
    .filter((holding) => holding.path.length > 0);
  const refreshLiveLockHoldingsForRepo = opts.refreshLiveLockHoldings
    ? (repoRelPrefix: string, knownSubmodulePaths: readonly string[]) => async (): Promise<GitSyncLockHolding[]> =>
        mapLiveLockHoldingsForRepo(await opts.refreshLiveLockHoldings!(), repoRelPrefix, knownSubmodulePaths)
    : undefined;
  let migrationFenceRosterForTick: Promise<AttributionRosterEntry[]> | undefined;
  const loadMigrationFenceRosterForTick = (): Promise<AttributionRosterEntry[]> => {
    if (!migrationFenceRosterForTick) {
      migrationFenceRosterForTick = Promise.resolve()
        .then(() => opts.loadMigrationFenceRoster!())
        .catch((error) => {
          migrationFenceRosterForTick = undefined;
          throw error;
        });
    }
    return migrationFenceRosterForTick;
  };
  const repoO = {
    harnessSlug: slug,
    remote,
    defaultBranch: branch,
    message,
    doPush,
    maxBlobBytes,
    maxCommitTotalBytes,
    contentDetectors,
    deletionGuard,
    readText,
    writeText,
    log,
    staleTempPackMs: opts.staleTempPackMs ?? STALE_TEMP_PACK_MS,
    isTempPackOpen: opts.isTempPackOpen,
    isGitLockOpen: opts.isGitLockOpen,
    diffSubjects: opts.diffSubjects ?? true,
    migrationReservationChecker: opts.migrationReservationChecker,
    loadMigrationFenceRoster: opts.loadMigrationFenceRoster ? loadMigrationFenceRosterForTick : undefined,
    excludePaths: protectedPaths,
  };

  const repo = opts.repoPath === undefined ? await projectDirForSlug(slug) : opts.repoPath;
  if (!repo) {
    return {
      status: 'error',
      dirtyPathCount: 0,
      committedCount: 0,
      errors: [{ scope: 'superproject', message: `no repo path registered for harness '${slug}'` }],
      pushed: [],
      merged: [],
      mergeCompleted: [],
      oversized: [],
      bulkExcluded: [],
      contentErrors: [],
      // No repo to inspect: nothing was measured, so null (never []) — an all-clear we
      // did not earn would retire a live strand escalation.
      strandedSubmodules: null,
    };
  }

  // Run before `git submodule status --recursive`: that census reads the
  // superproject index and otherwise turns a torn zero-byte index into a
  // misleading empty-submodule/clean-tree result. A refusal is surfaced as a
  // normal repo error; an unavailable probe is retained as the legacy fail-soft
  // path used by injected non-repository test seams.
  const rootIndexPreflight = await preflightInvalidIndex(runGit, repo, log);
  if (rootIndexPreflight.status === 'refused' || rootIndexPreflight.status === 'error') {
    return {
      status: 'error',
      dirtyPathCount: 0,
      committedCount: 0,
      errors: [
        {
          scope: 'superproject',
          message: `invalid-index preflight refused the sync: ${rootIndexPreflight.reason}`,
        },
      ],
      pushed: [],
      merged: [],
      mergeCompleted: [],
      oversized: [],
      bulkExcluded: [],
      contentErrors: [],
      strandedSubmodules: null,
    };
  }

  // P-004: the live roster (active agents + their declared files) for THIS tick, supplied by
  // the caller flag-gated. Empty when the flag is OFF (or no caller) → no attribution, today's
  // single-commit behavior. Read ONCE; per-repo maps are derived below (super + each submodule).
  const roster = opts.loadRoster ? await opts.loadRoster() : [];

  // WI-6554700010018409: a tally carries the same repo label as git_sync_commit_attribution.
  // Scopes here are relative to `repo`, so a submodule install (slug `<top>/<submodule>`)
  // would report its own root as 'superproject'. Only an attributed phase emits a tally, and
  // that needs a non-empty roster, so an install without one pays no extra git calls.
  const installRepo = roster.length > 0 ? await resolveAttributionRepo(repo, runGit) : null;
  const onAttribution = (t: AttributionTally): void =>
    emitAttribution({ ...t, scope: attributionScopeLabel(installRepo, t.scope) });

  /** One phase's collected results — JSON-serializable so it checkpoints as a step output. */
  interface PhaseCollect {
    dirtyPathCount: number;
    committedCount: number;
    conflicts: RepoConflict[];
    errors: RepoError[];
    pushed: string[];
    merged: string[];
    mergeCompleted: string[];
    oversized: ScopedOversized[];
    contentErrors: ScopedContentError[];
    skippedPaths: GitSyncSkippedPath[];
    /** Checkpoint the census with the phase. Outer mutable state disappears on replay,
     *  turning a measured [] into null and changing the reconstructed outcome. */
    strandedSubmodules: StrandedSubmodule[] | null;
    /** Persist the discovered repo coordinates so a resumed pointer-bump can still
     * filter submodule-relative protected paths out of the superproject stage. */
    submodulePaths: string[];
    /** Bounded evidence from the execution that produced this checkpoint, not its replay. */
    submoduleTiming?: {
      schemaVersion: 1;
      runId: string;
      repoRoot: string;
      pid: number;
      sourceUrl: string;
      startedAt: string;
      setupMs: number;
      setupSteps?: Array<{ name: string; durationMs: number }>;
      batches: Array<{
        index: number;
        depth: number;
        startOffsetMs: number;
        durationMs: number;
        repositories: Array<{ scope: string; durationMs: number; status: RepoSyncResult['status'] | 'rejected' }>;
      }>;
      omittedBatches: number;
    };
    didSomething: boolean;
    /** WI-10007606: set when the walk stopped at a batch boundary to yield. Part of the
     *  checkpointed output, so a crash-replay of this step yields again instead of
     *  treating the partial walk as a complete phase. */
    yielded?: { reason: string; synced: number; total: number };
    /** A guarded, local-only root commit made before child remote sync begins. */
    earlyRootCommit?: CommitRepoResult & {
      localCommitSha?: string;
      localCommitAtMs?: number;
      localCommitShas?: string[];
      localCommits?: GitSyncRootCommit[];
    };
  }
  // WI-10007606: fail-open probe — a throwing shouldYield must never stop commits.
  const checkYield = async (): Promise<string | null> => {
    if (!opts.shouldYield) return null;
    try {
      return await opts.shouldYield();
    } catch (e) {
      log(`[git-sync] ${slug}: shouldYield probe failed (${e instanceof Error ? e.message : String(e)}) — continuing the pass`);
      return null;
    }
  };
  const emptyPhase = (): PhaseCollect => ({
    dirtyPathCount: 0,
    committedCount: 0,
    conflicts: [],
    errors: [],
    pushed: [],
    merged: [],
    mergeCompleted: [],
    oversized: [],
    contentErrors: [],
    skippedPaths: [],
    strandedSubmodules: null,
    submodulePaths: [],
    didSomething: false,
  });

  const absorb = (into: PhaseCollect, scope: string, r: RepoSyncResult): void => {
    into.dirtyPathCount += r.dirtyPathCount ?? 0;
    into.committedCount += r.committedCount ?? 0;
    if (r.mergeCompleted) into.mergeCompleted.push(scope);
    if (r.oversized.length > 0) {
      into.oversized.push(...r.oversized.map((f) => ({ scope, ...f })));
      log(
        `[git-sync] ${slug}/${scope}: EXCLUDED ${r.oversized.length} oversized file(s) from the auto-commit (${r.oversized.map((f) => `${f.path} ${(f.sizeBytes / 1048576).toFixed(1)}MB`).join(', ')}) — gitignore or remove them (${slug})`,
      );
    }
    if (r.contentErrors.length > 0) {
      // EI-438 (D-001): broken files were EXCLUDED from this commit + left dirty for the
      // content-fixer; the rest of the tree still committed. Like oversized, this does
      // NOT defer the superproject (the (sub)repo's commit WITHOUT the broken file IS on
      // its origin, so the parent gitlink resolves).
      into.contentErrors.push(...r.contentErrors.map((c) => ({ scope, ...c })));
      log(
        `[git-sync] ${slug}/${scope}: QUARANTINED ${r.contentErrors.length} broken file(s) from the auto-commit (${r.contentErrors.map((c) => `${c.file} [${c.detectorKey}]`).join(', ')}) — content-fixer dispatched (${slug})`,
      );
    }
    if (r.skippedPaths && r.skippedPaths.length > 0) into.skippedPaths.push(...r.skippedPaths);
    if (r.status === 'conflict') {
      into.conflicts.push({ scope, conflictedFiles: r.conflictedFiles });
      log(
        `[git-sync] ${slug}/${scope}: merge conflict (${r.conflictedFiles.join(', ')}) — aborted clean, continuing (${slug})`,
      );
    } else if (r.status === 'error') {
      into.errors.push({ scope, message: r.message });
      log(`[git-sync] ${slug}/${scope}: ${r.message} — continuing (${slug})`);
    } else if (r.status === 'synced') {
      into.didSomething = true;
      if (r.pushed) into.pushed.push(scope);
      if (r.merged) into.merged.push(scope);
    }
  };

  const runGitWithTiming = (runId: string): RunGit => (args, cwd, options) => {
    const subcommand = gitSubcommandOf(args);
    const gitSubcommand = subcommand && /^[a-z][a-z0-9-]{0,63}$/.test(subcommand)
      ? subcommand
      : undefined;
    return runGit(args, cwd, {
      ...(options ?? {}),
      diagnosticTags: { runId, commandClass: 'git', ...(gitSubcommand ? { gitSubcommand } : {}) },
    });
  };

  // PHASE `git-sync:submodules` — every submodule, deepest-first (dynamic recursive
  // discovery). Each is independent: a conflict/error in one is collected; the rest
  // still sync. Runs as ONE checkpointed step: the expensive multi-repo half of the
  // pass, after which a resumed fire never re-commits/re-pushes the submodules.
  const sub = await step('git-sync:submodules', async (): Promise<PhaseCollect> => {
    const out = emptyPhase();
    const phaseStartedAt = performance.now();
    const timing = out.submoduleTiming = {
      schemaVersion: 1 as const,
      runId: randomUUID(),
      repoRoot: repo,
      pid: process.pid,
      sourceUrl: import.meta.url,
      startedAt: new Date().toISOString(),
      setupMs: 0,
      setupSteps: [] as Array<{ name: string; durationMs: number }>,
      batches: [] as NonNullable<PhaseCollect['submoduleTiming']>['batches'],
      omittedBatches: 0,
    };
    // Diagnostics must not change sync behavior, including if an injected sink fails.
    const timingLog = (event: string, detail: object): void => {
      try {
        log(`[git-sync:submodule-timing] ${JSON.stringify({ event, slug, runId: timing.runId, repoRoot: repo, pid: timing.pid, ...detail })}`);
      } catch { /* diagnostic-only */ }
    };
    timingLog('phase-start', { sourceUrl: timing.sourceUrl, startedAt: timing.startedAt });
    let subPaths: string[] = [];
    let setupStepStartedAt = phaseStartedAt;
    const recordSetupStep = (name: string): void => {
      const now = performance.now();
      const durationMs = Math.max(0, Math.round(now - setupStepStartedAt));
      setupStepStartedAt = now;
      timing.setupSteps.push({ name, durationMs });
      timingLog('setup-step', { name, durationMs });
    };
    const recordSetupComplete = (): void => {
      recordSetupStep('remainder');
      timing.setupMs = Math.round(performance.now() - phaseStartedAt);
      timingLog('setup-complete', { setupMs: timing.setupMs, repositoryCount: subPaths.length });
    };
    // Keep one diagnostic identity across URL reconciliation, recursive discovery,
    // early root-commit Git calls, and the later submodule walk.
    const runGitForTiming = runGitWithTiming(timing.runId);
    if (doSub) {
      // EI-20329530284626235: `.gitmodules` is the canonical transport declaration,
      // but an initialized submodule keeps a copied URL in its own `remote.origin.url`.
      // That copy survives later `.gitmodules` changes, so git-sync could keep pushing
      // through a stale HTTPS credential path even after the canonical URL moved to SSH.
      // Reconcile the copies before discovery or any submodule fetch/push. A failure is
      // correctness-relevant: continuing would knowingly use an unverified transport,
      // so report it and defer the superproject push like every other submodule error.
      let urlSync = await runGitForTiming(['submodule', 'sync', '--recursive'], repo);
      // EI-20345390379109755: an interrupted config writer (or a fleet-sandbox
      // mask artifact) can strand a zero-byte `.git/config.lock`. The index
      // phase already self-heals its equivalent lock; apply the same age guard
      // here, then retry once. A fresh lock is never touched.
      if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
        const configLockDeps = opts.isGitLockOpen ? { isOpen: opts.isGitLockOpen } : {};
        const cleared = await clearStaleConfigLock(runGitForTiming, repo, log, configLockDeps);
        if (cleared) urlSync = await runGitForTiming(['submodule', 'sync', '--recursive'], repo);

        // EI-20347384139844425: a fresh config.lock is live contention, not an
        // orphan we may delete. It is nevertheless normally gone within a few
        // milliseconds. Retry the exact idempotent sync with the same bounded
        // exponential-backoff pattern as live index.lock contention; persistent
        // failures still surface and the next guard can remove only a lock that
        // has since become provably stale.
        for (
          let attempt = 1;
          urlSync.code !== 0 &&
          isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`) &&
          attempt <= CONFIG_LOCK_CONTENTION_MAX_RETRIES;
          attempt++
        ) {
          const delayMs = CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          log(
            `[git-sync] ${repo}: canonical submodule URL sync hit live config.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${CONFIG_LOCK_CONTENTION_MAX_RETRIES})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          urlSync = await runGitForTiming(['submodule', 'sync', '--recursive'], repo);
        }

        if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
          const clearedAfterRetry = await clearStaleConfigLock(runGitForTiming, repo, log, configLockDeps);
          if (clearedAfterRetry) urlSync = await runGitForTiming(['submodule', 'sync', '--recursive'], repo);
        }
      }
      recordSetupStep('url-sync');
      if (urlSync.code !== 0) {
        recordSetupComplete();
        const detail = (urlSync.stderr || urlSync.stdout || 'no output').trim().slice(0, 300);
        const message = `canonical submodule URL sync failed: ${detail}`;
        out.errors.push({ scope: 'submodule-config', message });
        log(`[git-sync] submodule-config: ${message} — deferring submodule work and superproject push (${slug})`);
        return out;
      }
      subPaths = opts.submodulePaths
        ? [...opts.submodulePaths].sort((a, b) => b.split('/').length - a.split('/').length)
        : await discoverSubmodulesRecursive(runGitForTiming, repo, log, (census) => {
            // EI-20402093158205519: record the strand census measured by THIS pass. An
            // explicit submodulePaths override (tests) skips discovery entirely and so
            // measures nothing — this stays null, and null never implies an all-clear.
            out.strandedSubmodules = census;
          });
      recordSetupStep('discovery');
      const unforked = cfg.unforkedSubmodules ?? [];
      if (unforked.length) {
        const kept = subPaths.filter((p) => !unforked.some((u) => p === u || p.startsWith(`${u}/`)));
        if (kept.length !== subPaths.length) {
          log(
            `[git-sync] ${slug}: skipping ${subPaths.length - kept.length} submodule(s) with no pot fork ` +
              `(${unforked.join(', ')}) — no commit, merge or push inside them (WI-6554700010018380)`,
          );
        }
        subPaths = kept;
      }
      const nested = cfg.nestedPotCheckouts ?? [];
      if (nested.length) {
        const kept = subPaths.filter((p) => !isUnderAnyPath(p, nested));
        if (kept.length !== subPaths.length) {
          log(
            `[git-sync] ${slug}: skipping ${subPaths.length - kept.length} nested pot checkout(s) ` +
              `(${nested.join(', ')}) owned by their own pot's git-sync — no commit, merge or push inside them (WI-6554700010018602)`,
          );
        }
        subPaths = kept;
      }
      out.submodulePaths = [...subPaths];

      // EI-26790085278063139: child fetch/merge/push can take minutes, but ordinary
      // superproject work is safe to commit locally before that remote walk. This pass
      // publishes nothing, and excludes every child/nested gitlink plus protected and
      // migration paths; pointer-bump and publication remain after child success.
      if (subPaths.length > 0) {
        const yieldBeforeEarlyCommit = await checkYield();
        if (yieldBeforeEarlyCommit) {
          out.yielded = { reason: yieldBeforeEarlyCommit, synced: 0, total: subPaths.length };
          recordSetupComplete();
          return out;
        }

        const nestedPotPaths = cfg.nestedPotCheckouts ?? [];
        const rootProtectedPaths = protectedPaths.filter(
          (path) => !subPaths.some((subPath) => path === subPath || path.startsWith(`${subPath}/`)),
        );
        const rootProtectedHoldings = protectedHoldings.filter(
          (holding) =>
            !subPaths.some((subPath) => holding.path === subPath || holding.path.startsWith(`${subPath}/`)) &&
            !isUnderAnyPath(holding.path, nestedPotPaths),
        );
        const earlyHeadBefore = await headSha(runGitForTiming, repo);
        const earlyLocalCommits: GitSyncRootCommit[] = [];
        const yieldEarlySuperproject = async (boundary: GitSyncSuperprojectYieldBoundary): Promise<void> => {
          const reason = await checkYield();
          if (!reason) return;
          const headNow = await headSha(runGitForTiming, repo);
          const landed =
            headNow && headNow !== earlyHeadBefore
              ? {
                  localCommitSha: headNow,
                  localCommitAtMs: earlyLocalCommits.at(-1)?.committedAtMs ?? Date.now(),
                  localCommitShas: await commitsSince(runGitForTiming, repo, earlyHeadBefore, headNow),
                  localCommits: earlyLocalCommits,
                }
              : undefined;
          recordSetupComplete();
          throw new GitSyncYieldError(reason, boundary, 0, subPaths.length, landed);
        };

        // Preserve the normal root commit guards before taking the early local snapshot.
        try {
          await toolRoutingChecker({ runGit: runGitForTiming, repoPath: repo, log });
        } catch (e) {
          log(`[git-sync] ${repo}: tool-routing pre-commit check threw (${String(e)}) — continuing with the commit fail-soft`);
        }
        await yieldEarlySuperproject('before-superproject-stage');
        try {
          await toolCatalogRegenerator({ runGit: runGitForTiming, repoPath: repo, log });
        } catch (e) {
          log(`[git-sync] ${repo}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`);
        }
        await yieldEarlySuperproject('before-superproject-stage');
        let declarationRepair: GeneratedDeclarationsRepairResult;
        try {
          declarationRepair = await generatedDeclarationsRegenerator({ runGit: runGitForTiming, repoPath: repo, log });
        } catch (e) {
          declarationRepair = { status: 'blocked', atomicPaths: [], detail: String(e).slice(0, 300) };
        }
        await yieldEarlySuperproject('before-superproject-stage');

        recordSetupStep('early-root-guards');
        if (declarationRepair.status === 'blocked') {
          log(`[git-sync] ${repo}: early superproject commit deferred because generated declaration repair is blocked — pointer-bump will retry`);
        } else {
          const earlyMigrationPaths = migrationPaths(await dirtyFiles(runGitForTiming, repo));
          // A root source with edit attribution is not "ordinary" early work: it may
          // depend on a child gitlink or be covered by the child's migration fence.
          // Leave it dirty until child sync succeeds and the final pointer-bump pass
          // can enforce those cross-repo ordering and reservation checks.
          const earlyAttribution = attributionMapForRepo(roster, '', repo);
          const earlyAttributedPaths = [...earlyAttribution.keys()];
          let earlyMigrationFenceExcludedPaths: string[] = [];
          if (repoO.migrationReservationChecker) {
            const potentialMigrationRefusals: Array<Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }>> = [];
            for (const subPath of subPaths) {
              const childDirty = await dirtyFiles(runGitForTiming, join(repo, subPath));
              potentialMigrationRefusals.push(
                ...migrationPaths(childDirty).map((path) => ({
                  scope: subPath,
                  path,
                  reason: 'migration-reservation' as const,
                  detail: 'migration reservation is checked during child sync',
                })),
              );
            }
            if (potentialMigrationRefusals.length > 0) {
              let earlyFenceRoster: AttributionRosterEntry[] = [];
              try {
                const loaded = await repoO.loadMigrationFenceRoster?.();
                earlyFenceRoster = Array.isArray(loaded) ? loaded : [];
              } catch (error) {
                log(
                  `[git-sync] superproject: early migration attribution read failed; deferring candidate-dependent root paths fail-closed: ` +
                    (error instanceof Error ? error.message : String(error)),
                );
              }
              let earlyFenceHoldings = opts.liveLockHoldings ?? [];
              if (opts.refreshLiveLockHoldings) {
                try {
                  earlyFenceHoldings = await opts.refreshLiveLockHoldings();
                } catch (error) {
                  // A lock-only migration attribution cannot safely be ruled out on a failed read.
                  earlyFenceRoster = [];
                  earlyFenceHoldings = [];
                  log(
                    `[git-sync] superproject: early migration lock refresh failed; deferring candidate-dependent root paths fail-closed: ` +
                      (error instanceof Error ? error.message : String(error)),
                  );
                }
              }
              const earlyRootDirtyPaths = (await dirtyFiles(runGitForTiming, repo)).filter(
                (path) => !subPaths.some((subPath) => path === subPath || path.startsWith(`${subPath}/`)),
              );
              earlyMigrationFenceExcludedPaths = migrationDependencyFenceSkips(
                potentialMigrationRefusals,
                earlyRootDirtyPaths,
                earlyFenceRoster,
                repo,
                earlyFenceHoldings,
              ).map((entry) => entry.path);
            }
          }
          const earlyExcludedPaths = [...new Set([
            ...rootProtectedPaths,
            ...subPaths,
            ...nestedPotPaths,
            ...earlyMigrationPaths,
            ...earlyAttributedPaths,
            ...earlyMigrationFenceExcludedPaths,
            ...(declarationRepair.status === 'deferred' ? declarationRepair.atomicPaths : []),
          ])];
          if (declarationRepair.status === 'deferred') {
            log(
              `[git-sync] ${repo}: early declaration repair deferred (${declarationRepair.detail}) — excluding ` +
                `${declarationRepair.atomicPaths.length} declaration-related path(s) from the local commit`,
            );
          }
          recordSetupStep('early-root-migration-census');
          const committed = await commitOneRepo(runGitForTiming, repo, {
            ...repoO,
            scope: 'superproject',
            migrationFenceRoster: roster,
            migrationDependencySubmodulePaths: subPaths,
            priorityPaths: subPaths,
            excludePaths: earlyExcludedPaths,
            preDetectedContentOffenders:
              declarationRepair.status === 'deferred'
                ? declarationCompileOffenders(declarationRepair.compilerErrors ?? [])
                : [],
            protectedHoldings: rootProtectedHoldings,
            refreshLiveLockHoldings: refreshLiveLockHoldingsForRepo?.('', subPaths),
            attribution: earlyAttribution,
            onAttribution,
            forceCatchAllPaths: declarationRepair.status === 'regenerated' ? declarationRepair.atomicPaths : [],
            yieldIfRequested: yieldEarlySuperproject,
            onPublished: (sha) => earlyLocalCommits.push({ sha, committedAtMs: Date.now() }),
          });
          recordSetupStep('early-root-commit');
          const earlyHeadAfter = committed.committedLocal ? await headSha(runGitForTiming, repo) : undefined;
          out.earlyRootCommit = {
            ...committed,
            localCommits: earlyLocalCommits,
            ...(earlyHeadAfter
              ? {
                  localCommitSha: earlyHeadAfter,
                  localCommitAtMs: earlyLocalCommits.at(-1)?.committedAtMs ?? Date.now(),
                  localCommitShas: await commitsSince(runGitForTiming, repo, earlyHeadBefore, earlyHeadAfter),
                }
              : {}),
          };
          recordSetupStep('early-root-proof');
        }
      }
    }
    recordSetupComplete();
    const syncSubmodule = (s: string): Promise<RepoSyncResult> =>
      // P-004: a submodule's last-resort default is its own 'main' (resolved via
      // origin/HEAD first), never the superproject's branch (cfg.branch = 'staging').
      // EI-18689553108460319: submodules push under `doSubPush`, NOT the superproject's
      // `doPush` — a bridged/p2p-only hive's push:false must not silently strand every
      // submodule's commits too (see GitSyncConfig.pushSubmoduleOrigins).
      syncOneRepo(runGitForTiming, join(repo, s), {
        ...repoO,
        scope: s,
        doPush: doSubPush,
        // A failed fetch with no commits ahead of a stale tracking ref used to
        // look like `nothing`, so the superproject could publish imports against
        // an older submodule pin. The remote must be measured before publication.
        requireRemoteVerification: true,
        defaultBranch: 'main',
        // The caller supplies workspace/superproject-root-relative paths, while
        // git commands inside a submodule use that submodule's own root. This is
        // the same coordinate mapping used by git-sync attribution.
        excludePaths: protectedPaths
          .filter((path) => path.startsWith(`${s}/`))
          .map((path) => path.slice(s.length + 1))
          .filter(Boolean),
        protectedHoldings: protectedHoldings
          .filter((holding) => holding.path.startsWith(`${s}/`))
          .map((holding) => ({ ...holding, path: holding.path.slice(s.length + 1) }))
          .filter((holding) => holding.path.length > 0),
        refreshLiveLockHoldings: refreshLiveLockHoldingsForRepo?.(s, subPaths),
        attribution: attributionMapForRepo(roster, s, repo),
        onAttribution,
      });
    // WI-10003100: syncing every repo serially delayed the superproject commit
    // behind a 338s submodule phase on a 38-submodule checkout. Sync only
    // independent repos together; finish every child depth before starting a
    // parent so a parent's pushed gitlink always resolves on the child origin.
    let synced = 0;
    for (let depthStart = 0; depthStart < subPaths.length; ) {
      const depth = subPaths[depthStart]!.split('/').length;
      let depthEnd = depthStart + 1;
      while (depthEnd < subPaths.length && subPaths[depthEnd]!.split('/').length === depth) depthEnd++;
      for (let batchStart = depthStart; batchStart < depthEnd; batchStart += SUBMODULE_SYNC_CONCURRENCY) {
        // WI-10007606: the only safe yield point inside the walk — the previous batch
        // has fully settled and the next has not started a single git command.
        const yieldReason = await checkYield();
        if (yieldReason) {
          out.yielded = { reason: yieldReason, synced, total: subPaths.length };
          return out;
        }
        const batch = subPaths.slice(batchStart, Math.min(batchStart + SUBMODULE_SYNC_CONCURRENCY, depthEnd));
        const batchStartedAt = performance.now();
        const measurement: NonNullable<PhaseCollect['submoduleTiming']>['batches'][number] = {
          index: timing.batches.length + timing.omittedBatches,
          depth,
          startOffsetMs: Math.round(batchStartedAt - phaseStartedAt),
          durationMs: 0,
          repositories: [],
        };
        timingLog('batch-start', { batch: measurement.index, depth, scopes: batch });
        // allSettled is a safety barrier: an unexpected rejection must not let a
        // sibling start more Git commands after the action releases its locks.
        const results = await Promise.allSettled(batch.map(async (scope) => {
          const startedAt = performance.now();
          let status: RepoSyncResult['status'] | 'rejected' = 'rejected';
          try {
            const result = await syncSubmodule(scope);
            status = result.status;
            return result;
          } finally {
            const repository = { scope, durationMs: Math.round(performance.now() - startedAt), status };
            measurement.repositories.push(repository);
            timingLog('repository-settled', { batch: measurement.index, ...repository });
          }
        }));
        measurement.durationMs = Math.round(performance.now() - batchStartedAt);
        // Retain at most 256 repositories in the durable phase output. Logs retain
        // later batches; the omission count makes the checkpoint's coverage explicit.
        if (timing.batches.length < 64) timing.batches.push(measurement);
        else timing.omittedBatches++;
        timingLog('batch-settled', measurement);
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          if (result.status === 'rejected') throw result.reason;
          absorb(out, batch[i]!, result.value);
        }
        synced += batch.length;
      }
      depthStart = depthEnd;
    }
    return out;
  });
  if (sub.yielded) {
    throw new GitSyncYieldError(sub.yielded.reason, 'submodule-batch', sub.yielded.synced, sub.yielded.total);
  }
  const strandedSubmodules = sub.strandedSubmodules;
  // `submodulePaths` is part of the checkpointed phase output. The fallback keeps
  // compatibility with an older in-flight checkpoint created before that field
  // existed when the caller supplied an explicit path list.
  const submodulePaths = sub.submodulePaths ?? opts.submodulePaths ?? [];
  const superprojectGitlinkPaths = submodulePaths.filter(
    (path) => !submodulePaths.some((candidate) => candidate !== path && path.startsWith(candidate + '/')),
  );

  // Superproject last. An unreconciled submodule defers its PUSH — and ONLY its push.
  // (Oversized exclusions defer nothing: the submodule's commit — without the big
  // file — IS on its origin, so the parent gitlink resolves fine.)
  //
  // EI-20182436053613562: the deferral used to gate the local COMMIT as well, which is
  // strictly more than the invariant needs. Publishing a superproject commit whose
  // gitlinks reference unpushed submodule commits is what breaks a fresh clone, so the
  // PUSH must wait. A local commit publishes nothing, cannot strand a gitlink, and is
  // what the release gate cuts its candidate from (it reads local `staging` and never
  // fetches). Gating it too meant ONE permanently-failing submodule push — a GitHub 403
  // that no retry can ever clear — froze every agent's ordinary, non-submodule work in
  // the shared dirty tree indefinitely: measured at 12h and 24 dirty paths, including
  // untracked files that existed on no other disk and were therefore not even
  // recoverable from the reflog. This log line always SAID "deferring superproject
  // push"; now the code does only that.
  const supr = emptyPhase();
  let superHeadSha: string | undefined;
  // P-016: the superproject reconcile's sync-back result, surfaced on every final outcome.
  let superSyncBack: SyncBackResult | undefined;
  const pushBlocked = sub.conflicts.length > 0 || sub.errors.length > 0;
  // A submodule-relative protected path is valid for `git add` inside that
  // submodule, but Git rejects the same pathspec from the superproject with
  // "Pathspec ... is in submodule". Keep only paths in the superproject's own
  // coordinate space for its catch-all stage; each submodule received its mapped
  // exclusions above.
  const superprojectExcludePaths = protectedPaths.filter(
    (path) => !submodulePaths.some((s) => path === s || path.startsWith(`${s}/`)),
  );
  // WI-6554700010018602: a nested pot checkout's gitlink is staged only once its HEAD is on
  // an `origin` ref (.gitmodules resolves through origin, never the pot's fork). Until its
  // own delivery route publishes it, pinning that HEAD would leave this superproject
  // pointing at a commit nobody can fetch.
  for (const nestedPath of await unpublishedNestedPotCheckouts(runGit, repo, cfg.nestedPotCheckouts ?? [])) {
    log(
      `[git-sync] ${slug}: holding gitlink ${nestedPath} — nested pot checkout HEAD is on no origin ref yet (WI-6554700010018602)`,
    );
    superprojectExcludePaths.push(nestedPath);
  }
  const superprojectProtectedHoldings = protectedHoldings.filter(
    (holding) => !submodulePaths.some((s) => holding.path === s || holding.path.startsWith(`${s}/`)),
  );

  // WI-10007606: the superproject stage/guard/commit phase alone took minutes under
  // load (single read-tree/write-tree calls of 11-25s). Yield before entering it; the
  // submodule commits above are already durable, and the next tick bumps their pointers.
  const pointerBumpYield = await checkYield();
  if (pointerBumpYield) {
    throw new GitSyncYieldError(pointerBumpYield, 'before-pointer-bump', submodulePaths.length, submodulePaths.length);
  }
  // WI-6554700010018899: a yield INSIDE the commit phase can follow published group
  // commits (the residual and earlier per-agent groups publish before a later group's
  // probe). Pin the pre-phase root HEAD so such a yield carries its commit proof.
  // The pin is taken as the FIRST act inside the pointer-bump step (every reader is
  // inside it): outside the step it ran `git rev-parse HEAD` on a full DBOS replay,
  // which must re-execute NOTHING (git-sync-checkpoint-resume.test.ts).
  let superprojectHeadBefore = '';
  const earlyRootCommits = sub.earlyRootCommit?.localCommits ?? [];
  const localCommits: GitSyncRootCommit[] = [...earlyRootCommits];
  const notifiedRootCommits = new Set<string>();
  const notifyRootCommit = (commit: GitSyncRootCommit): void => {
    if (notifiedRootCommits.has(commit.sha)) return;
    notifiedRootCommits.add(commit.sha);
    try {
      opts.onRootCommit?.(commit);
    } catch (error) {
      log(`[git-sync] ${slug}: root commit notification failed: ${String(error)}`);
    }
  };
  for (const commit of earlyRootCommits) notifyRootCommit(commit);
  const yieldSuperproject = async (
    boundary: GitSyncSuperprojectYieldBoundary,
    phaseRunGit: RunGit,
  ): Promise<void> => {
    const reason = await checkYield();
    if (!reason) return;
    const headNow = superprojectHeadBefore ? await headSha(phaseRunGit, repo) : '';
    const landed =
      headNow && headNow !== superprojectHeadBefore
        ? {
            localCommitSha: headNow,
            localCommitAtMs: localCommits.at(-1)?.committedAtMs ?? Date.now(),
            localCommitShas: await commitsSince(phaseRunGit, repo, superprojectHeadBefore, headNow),
            localCommits,
          }
        : undefined;
    throw new GitSyncYieldError(reason, boundary, submodulePaths.length, submodulePaths.length, landed);
  };

  // PHASE `git-sync:pointer-bump` — superproject stage + content-guard + commit (this
  // commit is what bakes the bumped submodule pointers in). ALWAYS runs.
  const commitRes = await step('git-sync:pointer-bump', async () => {
    const pointerBumpStartedAt = performance.now();
    const pointerBumpTimingBase = {
      schemaVersion: 1 as const,
      runId: randomUUID(),
      repoRoot: repo,
      pid: process.pid,
      sourceUrl: import.meta.url,
      startedAt: new Date().toISOString(),
    };
    const pointerBumpTiming = (
      status: NonNullable<CommitRepoResult['pointerBumpTiming']>['status'],
      commitDurationMs?: number,
    ): NonNullable<CommitRepoResult['pointerBumpTiming']> => ({
      ...pointerBumpTimingBase,
      durationMs: Math.max(0, Math.round(performance.now() - pointerBumpStartedAt)),
      ...(commitDurationMs === undefined ? {} : { commitDurationMs }),
      status,
    });
    const runGitForPointerTiming = runGitWithTiming(pointerBumpTimingBase.runId);
    const yieldPointerBump = (boundary: GitSyncSuperprojectYieldBoundary): Promise<void> =>
      yieldSuperproject(boundary, runGitForPointerTiming);
    superprojectHeadBefore = await headSha(runGitForPointerTiming, repo);
    // EI-20428405431869483: detect generated routing drift while the dirty source
    // is still present, before the catch-all commit makes the source clean.
    try {
      await toolRoutingChecker({ runGit: runGitForPointerTiming, repoPath: repo, log });
    } catch (e) {
      log(
        `[git-sync] ${repo}: tool-routing pre-commit check threw (${String(e)}) — continuing with the commit fail-soft`,
      );
    }
    await yieldPointerBump('before-superproject-stage');
    // WI-39922: close the edit→auto-commit window that let a stale tracked catalog
    // reach the green gate hours later. Keep the catch HERE even though the default
    // implementation is defensive: an injected/future regenerator must never turn
    // this repair into a fleet-wide commit wedge.
    try {
      await toolCatalogRegenerator({ runGit: runGitForPointerTiming, repoPath: repo, log });
    } catch (e) {
      log(
        `[git-sync] ${repo}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
      );
    }
    await yieldPointerBump('before-superproject-stage');
    // EI-21444216858331991: a scheduled candidate was cut two seconds after an
    // `.mjs` source commit and eleven minutes before its generated `.d.mts` repair.
    // Regenerate here, then force every affected pair past per-agent peeling so
    // the source and projection share the same catch-all commit. Failure is
    // deliberately fail-closed for the declaration surface: a dirty pair is
    // recoverable; a published torn snapshot can freeze `main` for the entire
    // fleet. It is NOT fail-closed for the rest of the tree — that froze every
    // agent's commits on one peer's TS error (WI-6554700010010659).
    let declarationRepair: GeneratedDeclarationsRepairResult;
    try {
      declarationRepair = await generatedDeclarationsRegenerator({ runGit: runGitForPointerTiming, repoPath: repo, log });
    } catch (e) {
      declarationRepair = { status: 'blocked', atomicPaths: [], detail: String(e).slice(0, 300) };
    }
    await yieldPointerBump('before-superproject-stage');
    if (declarationRepair.status === 'blocked') {
      const dirtyPathCount = (await dirtyFiles(runGitForPointerTiming, repo)).length;
      return {
        committedLocal: false,
        dirtyPathCount,
        committedCount: 0,
        error: `generated declaration repair blocked the commit: ${declarationRepair.detail}`,
        oversized: [],
        contentErrors: [],
        skippedPaths: [],
        pointerBumpTiming: pointerBumpTiming('blocked'),
      };
    }
    // A failed status census or a failed emit defers the enrolled declaration
    // surface (plus, for a failed emit, the dirty files its diagnostics name —
    // WI-6554700010010659). Keep those paths out of both attribution and
    // catch-all staging so unrelated work still lands. Only a missing inventory
    // (no safe exclusion set) still blocks the commit above.
    const deferredDeclarationPaths = declarationRepair.status === 'deferred' ? declarationRepair.atomicPaths : [];
    if (declarationRepair.status === 'deferred') {
      log(
        `[git-sync] ${repo}: declaration repair deferred (${declarationRepair.detail}) — deferring ` +
          `${deferredDeclarationPaths.length} declaration-related path(s) while committing the unlocked remainder`,
      );
    }
    const commitStartedAt = performance.now();
    const migrationDependencyRefusals = sub.skippedPaths.filter(
      (entry): entry is Extract<GitSyncSkippedPath, { reason: 'migration-reservation' }> =>
        'reason' in entry && entry.reason === 'migration-reservation',
    );
    let migrationFenceLiveLockHoldings = opts.liveLockHoldings ?? [];
    let migrationFenceRoster = roster;
    if (migrationDependencyRefusals.length > 0 && opts.refreshLiveLockHoldings) {
      try {
        migrationFenceLiveLockHoldings = await opts.refreshLiveLockHoldings();
      } catch (error) {
        // Without the refreshed child lock plane, roster-only attribution can miss the holder.
        // Empty both inputs so migrationDependencyFenceSkips fails closed on every dirty root path.
        migrationFenceLiveLockHoldings = [];
        migrationFenceRoster = [];
        log(
          `[git-sync] superproject: migration lock refresh failed; holding candidate-dependent root paths fail-closed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    const committed = await commitOneRepo(runGitForPointerTiming, repo, {
      ...repoO,
      scope: 'superproject',
      migrationFenceRoster,
      migrationFenceLiveLockHoldings,
      migrationDependencyRefusals,
      migrationDependencySubmodulePaths: submodulePaths,
      excludePaths: [...superprojectExcludePaths, ...deferredDeclarationPaths],
      preDetectedContentOffenders:
        declarationRepair.status === 'deferred' ? declarationCompileOffenders(declarationRepair.compilerErrors ?? []) : [],
      protectedHoldings: superprojectProtectedHoldings,
      refreshLiveLockHoldings: refreshLiveLockHoldingsForRepo?.('', submodulePaths),
      attribution: attributionMapForRepo(roster, '', repo),
      onAttribution,
      priorityPaths: superprojectGitlinkPaths,
      forceCatchAllPaths: declarationRepair.status === 'regenerated' ? declarationRepair.atomicPaths : [],
      yieldIfRequested: yieldPointerBump,
      onPublished: (sha) => {
        const commit = { sha, committedAtMs: Date.now() };
        localCommits.push(commit);
      },
    });
    const commitDurationMs = Math.max(0, Math.round(performance.now() - commitStartedAt));
    // Persist the proof with the commit phase itself. On a durable replay the
    // current HEAD and wall clock may already belong to a different tick.
    const localCommitAtMs = localCommits.at(-1)?.committedAtMs ?? (committed.committedLocal ? Date.now() : undefined);
    const landedHead = committed.committedLocal ? await headSha(runGitForPointerTiming, repo) : undefined;
    const pointerBumpStatus = committed.error
      ? 'error'
      : committed.skippedPaths?.length && !committed.committedLocal
        ? 'skipped'
        : committed.committedLocal
          ? 'committed'
          : 'unchanged';
    return {
      ...committed,
      localCommits,
      localCommitSha: landedHead,
      localCommitAtMs,
      // Every root commit this phase created (one per attributed group), oldest first.
      localCommitShas: landedHead ? await commitsSince(runGitForPointerTiming, repo, superprojectHeadBefore, landedHead) : undefined,
      pointerBumpTiming: pointerBumpTiming(pointerBumpStatus, commitDurationMs),
    };
  });
  // Old phase checkpoints carry only committedLocal; never manufacture their
  // missing proof from a newer checkout HEAD.
  const pointerLocalCommitSha = 'localCommitSha' in commitRes ? commitRes.localCommitSha : undefined;
  const pointerLocalCommitAtMs = 'localCommitAtMs' in commitRes ? commitRes.localCommitAtMs : undefined;
  const pointerLocalCommitShas = 'localCommitShas' in commitRes ? commitRes.localCommitShas : undefined;
  // Outside the durable step: a replay skips the body, but must recover the same
  // per-commit notifications before any later phase, with their original times.
  const pointerLocalCommits = 'localCommits' in commitRes ? commitRes.localCommits : undefined;
  const savedLocalCommits =
    earlyRootCommits.length > 0 || pointerLocalCommits
      ? [...new Map([...earlyRootCommits, ...(pointerLocalCommits ?? [])].map((commit) => [commit.sha, commit])).values()]
      : undefined;
  for (const commit of savedLocalCommits ?? []) notifyRootCommit(commit);
  const localCommitSha = pointerLocalCommitSha ?? sub.earlyRootCommit?.localCommitSha;
  const localCommitAtMs = pointerLocalCommitAtMs ?? sub.earlyRootCommit?.localCommitAtMs;
  const localCommitShas = [...new Set([
    ...(sub.earlyRootCommit?.localCommitShas ?? []),
    ...(pointerLocalCommitShas ?? []),
  ])];
  const commitMetrics = {
    dirtyPathCount: commitRes.dirtyPathCount,
    committedCount: commitRes.committedCount,
  };
  let repoResult: RepoSyncResult;
  // A partial pass may have both held paths and a failed publication. Keep the
  // failure visible; an ordinary lock skip must not hide an index/CAS error.
  if (commitRes.error) {
    repoResult = {
      status: 'error',
      ...commitMetrics,
      message: commitRes.error,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
      skippedPaths: commitRes.skippedPaths,
    };
  } else if (commitRes.skippedPaths && commitRes.skippedPaths.length > 0 && !commitRes.committedLocal) {
    repoResult = {
      status: 'skipped-locked',
      ...commitMetrics,
      skippedPaths: commitRes.skippedPaths,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
    };
  } else if (pushBlocked) {
    // Committed locally (or there was nothing to commit); the network half waits for a
    // tick on which every submodule reconciled. Same shape reconcileAndPushOneRepo
    // returns for its own committed-but-did-not-push case (the offline path).
    superHeadSha = await headSha(runGit, repo);
    repoResult = commitRes.committedLocal
      ? {
          status: 'synced',
          ...commitMetrics,
          pushed: false,
          merged: false,
          oversized: commitRes.oversized,
          contentErrors: commitRes.contentErrors,
          skippedPaths: commitRes.skippedPaths,
        }
      : {
          status: 'nothing',
          ...commitMetrics,
          oversized: commitRes.oversized,
          contentErrors: commitRes.contentErrors,
          skippedPaths: commitRes.skippedPaths,
        };
    log(
      `[git-sync] ${sub.conflicts.length} conflict(s) + ${sub.errors.length} error(s) in submodules — superproject ${commitRes.committedLocal ? 'COMMITTED locally' : 'had nothing to commit'}, deferring only its push (${slug})`,
    );
  } else if (!reconcileSuperprojectOrigin) {
    // WI-6554700010018483: the stale objects/maintenance.lock reclaim otherwise
    // runs only inside reconcileAndPushOneRepo, which this branch never calls, so a
    // bridged superproject (the canonical papercusp repo) kept git auto-gc disabled.
    // Best-effort, exactly like the legacy call: a failed check never fails the sync.
    try {
      await clearStaleMaintenanceLock(runGit, repo, log, opts.isGitLockOpen ? { isOpen: opts.isGitLockOpen } : {});
    } catch (e) {
      log(`[git-sync] ${repo}: objects/maintenance.lock check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // EI-20232774599730947: a bridged/p2p-only member is truly commit-only at
    // this layer. GitHub ingress + admission and the P2P worktree bridge own
    // remote-to-worktree flow; fetching/merging origin here is both redundant
    // and unsafe for an installer seed whose local P2P lineage intentionally
    // remains unrelated to GitHub main.
    //
    // WI-40066: a frozen repair may still have advanced release main on a
    // sibling commit after its exact patch already landed through canonical
    // staging. Legacy mode repairs that ancestry inside reconcileAndPushOneRepo,
    // but this branch deliberately never calls the origin/staging reconciler.
    // A bridged caller can opt into the same fail-closed proof as a standalone
    // checkpointed phase: fetch main, require every main-only tree entry to be
    // byte-identical, then record only the ancestry. The later P2P legs publish
    // and integrate this HEAD; this phase itself still pushes nothing.
    const releaseBridge = bridgeContainedReleaseMainOnCommitOnly
      ? await step('git-sync:push', () =>
          bridgeContainedReleaseMain(runGit, repo, {
            remote,
            branch,
            log,
          }),
        )
      : { status: 'not-needed' as const };
    superHeadSha = await headSha(runGit, repo);
    if (releaseBridge.status === 'error') {
      repoResult = {
        status: 'error',
        ...commitMetrics,
        message: releaseBridge.message,
        oversized: commitRes.oversized,
        contentErrors: commitRes.contentErrors,
        skippedPaths: commitRes.skippedPaths,
      };
    } else {
      if (releaseBridge.status === 'declined') {
        log(`[git-sync] ${repo}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
      }
      const bridged = releaseBridge.status === 'bridged';
      repoResult =
        commitRes.committedLocal || bridged
          ? {
              status: 'synced',
              ...commitMetrics,
              pushed: false,
              merged: bridged,
              oversized: commitRes.oversized,
              contentErrors: commitRes.contentErrors,
              skippedPaths: commitRes.skippedPaths,
            }
          : {
              status: 'nothing',
              ...commitMetrics,
              oversized: commitRes.oversized,
              contentErrors: commitRes.contentErrors,
              skippedPaths: commitRes.skippedPaths,
            };
    }
  } else {
    // PHASE `git-sync:push` — superproject fetch + merge + push (the network half).
    const pushRes = await step('git-sync:push', async () => ({
      ...(await reconcileAndPushOneRepo(
        runGit,
        repo,
        // P-016: sync-back rides the superproject reconcile only (never syncOneRepo's submodules).
        {
          ...repoO,
          defaultBranch: branch,
          disableCommitGraphForSubmoduleMerge: submodulePaths.length > 0,
          ...(cfg.syncBack ? { syncBack: cfg.syncBack } : {}),
        },
        commitRes.committedLocal,
      )),
      headSha: await headSha(runGit, repo),
    }));
    superHeadSha = pushRes.headSha;
    superSyncBack = 'syncBack' in pushRes ? pushRes.syncBack : undefined;
    repoResult = {
      ...pushRes,
      ...commitMetrics,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
      skippedPaths: commitRes.skippedPaths,
    };
  }
  absorb(supr, 'superproject', repoResult);

  const conflicts = [...sub.conflicts, ...supr.conflicts];
  const errors = [...sub.errors, ...supr.errors];
  const pushed = [...sub.pushed, ...supr.pushed];
  const merged = [...sub.merged, ...supr.merged];
  const mergeCompleted = [...sub.mergeCompleted, ...supr.mergeCompleted];
  const earlyRootCommit = sub.earlyRootCommit;
  const oversized = [...new Map([
    ...sub.oversized,
    ...supr.oversized,
    ...(earlyRootCommit?.oversized ?? []).map((file) => ({ scope: 'superproject', ...file })),
  ].map((file) => [`${file.scope}:${file.path}`, file])).values()];
  const bulkExcluded = oversized.filter((f) => f.exclusionReason === 'cumulative-limit');
  const contentErrors = [...new Map([
    ...sub.contentErrors,
    ...supr.contentErrors,
    ...(earlyRootCommit?.contentErrors ?? []).map((file) => ({ scope: 'superproject', ...file })),
  ].map((file) => [`${file.scope}:${file.file}`, file])).values()];
  // Older in-flight checkpoints predate the skipped-path census. Replay must
  // reconstruct those phase outputs as an empty census rather than throwing or
  // turning a clean replay into an error.
  const skippedPaths = [...new Map([
    ...(sub.skippedPaths ?? []),
    ...(supr.skippedPaths ?? []),
    ...(earlyRootCommit?.skippedPaths ?? []),
  ].map((entry) => [JSON.stringify(entry), entry])).values()];
  const dirtyPathCount = (sub.dirtyPathCount ?? 0) + (supr.dirtyPathCount ?? 0) + (earlyRootCommit?.dirtyPathCount ?? 0);
  const committedCount = (sub.committedCount ?? 0) + (supr.committedCount ?? 0) + (earlyRootCommit?.committedCount ?? 0);
  const didSomething = sub.didSomething || supr.didSomething || earlyRootCommit?.committedLocal === true;
  // P-016: present on every status so a sync-back conflict is reported even when the
  // pass itself is otherwise clean ('nothing' / 'synced' are the common cases).
  const syncBackField = superSyncBack ? { syncBack: superSyncBack } : {};
  // EI-25545265520729999: the superproject can commit successfully while a
  // sibling fetch/push fails. Keep its measured local HEAD on partial outcomes
  // so health readers do not retain a stale tip behind the whole-pass verdict.
  const measuredHead = {
    ...(superHeadSha ? { headSha: superHeadSha } : {}),
    ...(localCommitSha ? { localCommitSha } : {}),
    ...(localCommitSha && localCommitAtMs != null ? { localCommitAtMs } : {}),
    ...(localCommitSha && localCommitShas && localCommitShas.length > 0 ? { localCommitShas } : {}),
    ...(savedLocalCommits ? { localCommits: savedLocalCommits } : {}),
  };

  if (conflicts.length > 0)
    return {
      status: 'conflict',
      ...measuredHead,
      dirtyPathCount,
      committedCount,
      conflicts,
      errors,
      pushed,
      merged,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      skippedPaths,
      strandedSubmodules,
      ...syncBackField,
    };
  if (errors.length > 0)
    return {
      status: 'error',
      ...measuredHead,
      dirtyPathCount,
      committedCount,
      errors,
      pushed,
      merged,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      skippedPaths,
      strandedSubmodules,
      ...syncBackField,
    };
  // A live lock is a partial exclusion, not a fleet-wide stop. Report the legacy
  // skipped verdict only when a live-lock path prevented progress. Migration-only
  // deferrals remain visible in skippedPaths without being mislabeled as locks.
  if (skippedPaths.some((path) => 'owner' in path) && !didSomething)
    return {
      status: 'skipped-locked',
      ...measuredHead,
      dirtyPathCount,
      committedCount,
      skippedPaths,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      strandedSubmodules,
      ...syncBackField,
    };
  // NOTE 'nothing' carries the census too. A tick that commits nothing is the MOST likely
  // one to be stranding work — the visible tree is clean precisely because the dirty repo
  // is invisible — so this is the last status that should omit it.
  if (!didSomething)
    return {
      status: 'nothing',
      ...measuredHead,
      dirtyPathCount,
      committedCount,
      skippedPaths,
      mergeCompleted,
      oversized,
      bulkExcluded,
      contentErrors,
      strandedSubmodules,
      ...syncBackField,
    };
  // superHeadSha comes from the push step's checkpoint; a 'synced' verdict implies that
  // step ran (blocked/commit-error passes return above). Fallback read for safety only.
  return {
    status: 'synced',
    ...measuredHead,
    dirtyPathCount,
    committedCount,
    headSha: superHeadSha ?? (await headSha(runGit, repo)),
    pushed,
    merged,
    mergeCompleted,
    oversized,
    bulkExcluded,
    contentErrors,
    skippedPaths,
    strandedSubmodules,
    ...syncBackField,
  };
}
