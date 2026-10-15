/**
 * capability:git — run a git subcommand. A thin wrapper that spawns `git` with
 * argv directly (no shell, so no quoting hazards), routed through dispatch so a
 * distinct `capability:git` capability can be gated by the envelope separately
 * from arbitrary bash (P-010, `agent-capability-confinement-2026-06-13`).
 *
 * `push` is REFUSED — git-sync owns commit+push on the shared tree (mirrors the
 * fleet's `Bash(git push:*)` deny). Everything else (status/diff/log/add/commit
 * within a worktree) is allowed; output spills to a log if large.
 */

import { spawn as childSpawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createScratchClone as createLocalScratchClone, type ScratchCloneOptions as LocalScratchCloneOptions, type ScratchCloneResult } from '../../scratch-git-clone';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { augmentedSpawnPath, resolveBin } from '../../plugin-spawn-impl';
import { resolveCapabilityBaseDir } from './base-dir';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';
import {
  assertCapabilitySandboxAvailable,
  buildCapabilitySandboxCommand,
  capabilityExecSandboxPolicy,
  scrubExecEnv,
} from './exec-sandbox';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015): `pairs/git-read.ts` claims a
 * closed list of read subcommands as substitutable, and every one of them must
 * be a subcommand this tool actually accepts. Refusing a new subcommand here
 * without removing it there would make the registry advise a substitution that
 * returns `refused`.
 */
export const REFUSED_SUBCOMMANDS = new Set(['push']);

const scratchCloneSpec = z.object({
  source: z
    .string()
    .min(1)
    .optional()
    .describe('Local repository path (absolute, or relative to cwd). Defaults to cwd/project dir. Remote URLs are refused.'),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe('Commit-ish to pin exactly and check out detached. Defaults to HEAD.'),
  destination: z
    .string()
    .min(1)
    .optional()
    .describe('Optional absolute, non-existing destination below OS temp or the source repository\'s ignored .papercusp/scratch directory on the source filesystem. Omit to create one safely.'),
  submodules: z
    .boolean()
    .optional()
    .describe('Materialise locally checked-out submodules at their exact pins (default true). No network fallback.'),
});

const cwdArg = z
  .string()
  .optional()
  .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir. In scratchClone mode it is the default source/base.');

const gitToolArgs = z.union([
  z.object({
    args: z.array(z.string()).min(1).describe('git arguments, e.g. ["status","--porcelain"] or ["diff","--stat"].'),
    cwd: cwdArg,
    scratchClone: z.never().optional(),
  }),
  z.object({
    args: z.never().optional(),
    cwd: cwdArg,
    scratchClone: scratchCloneSpec.describe('Guarded, cheap, disposable local clone. Use instead of ad-hoc `git clone`/copy commands for scratch work.'),
  }),
]);

export { type ScratchCloneResult } from '../../scratch-git-clone';
export interface ScratchCloneOptions extends Omit<LocalScratchCloneOptions, 'runGit'> {
  stateDir?: string;
  sandboxEnabled?: boolean;
  sandboxRequired?: boolean;
}

/** Preserve capability callers and sandbox policy while sharing checkout logic. */
export function createScratchClone(options: ScratchCloneOptions): Promise<ScratchCloneResult> {
  return createLocalScratchClone({
    ...options,
    runGit: (argv, cwd, signal) => runGit(argv, cwd, options.stateDir, signal,
      options.sandboxEnabled ?? false, options.sandboxRequired ?? false),
  });
}

export default defineTool({
  name: 'capability:git',
  description:
    'Run a git subcommand (argv, no shell), or create a guarded cheap local scratch clone that borrows object stores. `push` is refused (git-sync owns push).',
  guidance: {
    when: 'Inspect/stage git state, or make an ephemeral local checkout. For scratch work use scratchClone: it pins a detached ref, borrows packs, skips untracked node_modules, materialises only resolvable local submodules, and removes origins.',
    notWhen: 'Pushing (refused — git-sync owns push). Remote/network clones or persistent product checkouts. Arbitrary shell — use capability:bash.',
    chaining: 'Read form: capability:git { args: ["status","--porcelain"] }. Scratch form: capability:git { scratchClone: { ref: "HEAD" } } → use returned path; OS temp cleanup remains the lifecycle owner.',
    seeAlso: [
      'capability:bash (run an arbitrary shell command)',
      'dev:pipeline_position (where a committed edit is in the pipeline)',
    ],
  },
  capability: 'capability:git',
  requirePrincipal: false,
  // EI-18803497769946984: shells out to git (a fetch/clone can run minutes) and never
  // reads ctx.tx — holding the ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 120,
  args: gitToolArgs,
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    // Resolve the same server-owned profile as capability:bash. A confined git
    // subprocess cannot silently downgrade to raw host execution.
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);

    if ('scratchClone' in args && args.scratchClone) {
      const requestedSource = args.scratchClone.source ?? cwd;
      const source = isAbsolute(requestedSource) ? requestedSource : resolve(cwd, requestedSource);
      try {
        const result = await createScratchClone({
          source,
          ref: args.scratchClone.ref,
          destination: args.scratchClone.destination,
          includeSubmodules: args.scratchClone.submodules,
          stateDir: ctx.stateDir,
          signal: ctx.signal,
          sandboxEnabled: sandboxPolicy.enabled,
          sandboxRequired: sandboxPolicy.required,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'scratchClone',
              ...result,
              detached: true,
              remotesRemoved: true,
              objectStorage: 'borrowed-local-alternates',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'scratch_clone_failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }
    }

    const argv = args.args;
    const sub = argv.find((a) => !a.startsWith('-')) ?? '';
    if (REFUSED_SUBCOMMANDS.has(sub)) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'refused', message: `git ${sub} is refused — git-sync owns push on the shared tree.` }) },
        ],
        isError: true,
      };
    }
    // EI-20881501070735530: this was `ctx.projectDir ?? process.cwd()` — the ONE
    // capability tool missed when EI-1754 migrated read/write/edit/inspect/bash to
    // the shared resolver. A superuser ctx has `projectDir: undefined`, so git ran
    // in the :3070 operator's own cwd — the RELEASE checkout's `apps/operator/`
    // subdir (a different worktree, pinned to green `main`). Measured: `rev-parse
    // --show-toplevel` returned papercup-release with prefix `apps/operator/`, so a
    // repo-relative pathspec after `--` resolved to `apps/operator/<path>`, matched
    // nothing, and printed nothing at exit 0 — a confident FALSE ABSENCE for every
    // agent using `git log -- <path>` for landing/containment triage.
    const r = await runGit(
      argv,
      cwd,
      ctx.stateDir,
      ctx.signal,
      sandboxPolicy.enabled,
      sandboxPolicy.required,
    );
    const truncated = r.output.length > INLINE_OUTPUT_CAP;
    let logPath: string | undefined;
    let output = r.output;
    if (truncated) {
      logPath = join(scratchDir(ctx.stateDir), `git-${crypto.randomUUID().slice(0, 12)}.log`);
      try { createWriteStream(logPath, { flags: 'w' }).end(r.output); } catch { /* ignore */ }
      output = `${r.output.slice(0, INLINE_OUTPUT_CAP)}\n… [truncated — full output: ${logPath}]`;
    }
    // The cwd is part of the ANSWER, not debug noise: every result below is scoped
    // to this directory (and, for a worktree, to ITS branch). capability:bash has
    // always printed its cwd; capability:git printing none is what let the wrong-tree
    // reading above look like a normal empty result. (EI-20881501070735530)
    const header = `git ${argv.join(' ')} · exit ${r.code ?? 'null'} · cwd ${cwd}${truncated ? ` · spilled → ${logPath}` : ''}`;
    const body = output || `(no output)${emptyPathspecNote(argv, r.code, output, cwd)}`;
    return {
      content: [{ type: 'text' as const, text: `${header}\n${body}` }],
      isError: r.code === null,
    };
  },
});

/**
 * The other half of EI-20881501070735530, kept even though the cwd bug above is
 * fixed: `git <cmd> -- <pathspec>` that matches NOTHING prints nothing and exits
 * **0**, so a wrong path (a typo, a submodule path queried from the superproject,
 * a path that only exists on another branch) is indistinguishable from a real
 * "no commits touch this file". That is the false-absence class this repo keeps
 * paying for, and here the instrument can just say which reading it is.
 *
 * Deliberately narrow: it fires ONLY when an explicit `--` pathspec was given and
 * the command still produced nothing at exit 0. It must never fire on a legitimate
 * empty result such as `git diff` over a clean tree, so no heuristic guesses at
 * bare trailing operands.
 *
 * Exported for unit testing.
 */
export function emptyPathspecNote(argv: string[], code: number | null, output: string, cwd: string): string {
  if (code !== 0 || output.trim() !== '') return '';
  const sep = argv.indexOf('--');
  if (sep === -1) return '';
  const pathspecs = argv.slice(sep + 1);
  if (pathspecs.length === 0) return '';
  return (
    `\n⚠ pathspec matched nothing in ${cwd} — git prints nothing and exits 0 for BOTH ` +
    `"no commits touch this path" and "this path does not exist here", so this is not ` +
    `evidence of absence. Pathspec: ${pathspecs.join(' ')}. Re-check with a positive ` +
    `control (the same query for a path you know is tracked), and note that a path inside ` +
    `a git SUBMODULE never matches from the superproject — run it with cwd set to the submodule.`
  );
}

/** Exported for direct unit testing (mirrors bash-jobs.ts's runForeground export) —
 *  decouples the env-scrub regression test from the flag/DB plumbing the
 *  `handler` above resolves `sandboxEnabled` through. */
export function runGit(
  argv: string[],
  cwd: string,
  _stateDir: string | undefined,
  signal: AbortSignal,
  sandboxEnabled = false,
  sandboxRequired = false,
): Promise<{ code: number | null; output: string }> {
  return runGitWithSandboxOptions(argv, cwd, signal, sandboxEnabled, sandboxRequired);
}

/**
 * Run the pinned, read-only evidence Git commands without SRT's per-command
 * Unix-socket proxy. These callers use only local `rev-parse`, `cat-file`, and
 * `merge-base` operations, so network access is unnecessary. Keeping this path
 * on bwrap avoids the SRT mux socket failure mode under concurrent evidence
 * reads while retaining filesystem and credential containment.
 */
export function runGitReadOnlyEvidence(
  argv: string[],
  cwd: string,
  _stateDir: string | undefined,
  signal: AbortSignal,
  sandboxEnabled = false,
  sandboxRequired = false,
): Promise<{ code: number | null; output: string }> {
  return runGitWithSandboxOptions(argv, cwd, signal, sandboxEnabled, sandboxRequired, {
    srtBin: null,
    denyAllEgress: true,
  });
}

interface RunGitSandboxOptions {
  srtBin?: string | null;
  denyAllEgress?: boolean;
}

function runGitWithSandboxOptions(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  sandboxEnabled: boolean,
  sandboxRequired: boolean,
  sandboxOptions: RunGitSandboxOptions = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const spawnPath = augmentedSpawnPath();
    const decision = buildCapabilitySandboxCommand(
      { cmd: [resolveBin('git', spawnPath), ...argv], cwd },
      { enabled: sandboxEnabled, required: sandboxRequired, ...sandboxOptions },
    );
    assertCapabilitySandboxAvailable(decision, cwd);
    if (sandboxEnabled && !decision.sandboxed) {
      console.warn(
        `[capability:git] exec-sandbox enabled but ${decision.reason} — running unsandboxed in the operator process (cwd ${cwd})`,
      );
    }
    const child = childSpawn(decision.binary, decision.argv, {
      cwd,
      // EI-1617: allowlist, not a full process.env passthrough — this subprocess
      // previously inherited every operator secret (DB creds, webhook/JWT
      // secrets, session keys, …) for no reason a `git status`/`diff`/`commit`
      // needs. See exec-sandbox.ts's scrubExecEnv.
      env: { ...scrubExecEnv(process.env), PATH: spawnPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const cap = 8 * 1024 * 1024;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let decodersFlushed = false;
    const append = (chunk: string): void => {
      const remaining = cap - output.length;
      if (remaining > 0) output += chunk.slice(0, remaining);
    };
    const flushDecoders = (): void => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      append(stdoutDecoder.end());
      append(stderrDecoder.end());
    };
    child.stdout?.on('data', (b: Buffer) => append(stdoutDecoder.write(b)));
    child.stderr?.on('data', (b: Buffer) => append(stderrDecoder.write(b)));
    const onAbort = (): void => { child.kill('SIGKILL'); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      flushDecoders();
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code: null, output: output + `\n[spawn error] ${err instanceof Error ? err.message : String(err)}` });
    });
    child.on('close', (code) => {
      flushDecoders();
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code, output });
    });
  });
}
