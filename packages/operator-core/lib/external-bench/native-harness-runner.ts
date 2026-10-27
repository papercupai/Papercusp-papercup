/**
 * Baseline B — native-harness runner (P-007 / BRIEF 5, plan
 * `impartial-benchmark-suite-2026-06-15`). The M1 (offline diff-batch) generation arm
 * for the HEADLINE baseline: the SAME model embedded in the provider's OWN native harness
 * (Claude Code), graded by the SAME official grader as every other arm.
 *
 * It mirrors `runSingleAgentAttempt` (Baseline A, ./single-agent-attempt.ts) so the pilot
 * (P-009) treats every arm uniformly — it produces the SHARED {@link ArmAttempt} (→
 * {@link diffSubmission} → the official grader → run-result row). The ONE structural
 * difference, and the entire point of Baseline B: it does NOT call P-006's single-worker
 * primitive or any Papercusp blueprint (`instantiate`). The generation step is the `claude`
 * CLI's OWN agent loop — spawned headless via `runAgentChat({ backend:'claude-code', … })` —
 * so the row's harness is the provider's shipped agent, not a Papercusp scaffold (D-002/D-004).
 *
 * Ports (clone / extractDiff / spawnAgent / harnessVersion) are INJECTED (hive-eval live-ports
 * pattern) so the whole arm is unit-testable with a fake `claude` event stream before any live
 * spawn. Cost accounting carries ALL of the agent loop's tokens (fairness #2). Like the
 * single-agent primitive it NEVER throws on a generation failure — an infra error (clone /
 * spawn / extract) becomes `stopReason:'error'` + `generationError` with an empty diff, so the
 * scoring lib EXCLUDES it from accuracy (resolved=null) rather than scoring a spurious failure
 * (METR: retry infra failures, never score them).
 *
 * Cost note (fairness, for P-011/P-016): the claude-code backend ignores temperature/maxTokens —
 * Claude Code runs at its NATIVE recommended sampling, which is correct for "native harness at its
 * best". An iso-budget TOKEN cap therefore cannot be enforced per-call here; we enforce a
 * wall-clock ceiling ({@link GenerationBudget.maxWallClockMs}) as the hard guard, record ACTUAL
 * tokens/cost (Claude reports `total_cost_usd` directly), and let BRIEF 7 do the iso-budget /
 * Pareto normalization. A wall-clock-cap abort maps to `stopReason:'budget-exhausted'`.
 */
import { budgetExceeded, type IsoBudgetCap } from '@papercusp/bench-metrics';
import { costFromTokens } from '@papercusp/model-pricing';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createScopedNativeSandboxSpawn } from '@papercusp/orchestrator/fleet-srt-spawn';
import { SCOPED_INFERENCE_GATEWAY_ENV } from '@papercusp/orchestrator/codex-gateway-config';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { currentBenchAssignmentId, currentBenchAttemptLabel, currentStockBenchHarnessDriver, liveCurrentSuBenchPorts,
  requireCurrentBenchHostBinding, beginCurrentBenchNativeSession, type CurrentSuBenchOptions, type CurrentSuBenchObservations,
  type CurrentStockBenchPorts } from './current-su';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { DbScope } from './reproducibility/db';
import type { BenchHarnessOps } from './bench-harness-live';
import { managedSpawn } from '../task-manager/managed-spawn';
import { CONTAINER_CLAUDE_BIN_PATH, CONTAINER_CODEX_BIN_PATH, materializeDockerExecWrapper, validateDockerExecTarget } from './container-exec-target';
import { redactSensitiveText } from '../sensitive-text';
import type { ChatEvent, RunAgentChatOptions } from '../agent-chat-stream';
import {
  BASELINE_B_ARM,
  DEFAULT_NATIVE_HARNESS_CONFIG,
  NATIVE_BLUEPRINT_ID,
  buildNativeHarnessPrompt,
  type NativeHarnessConfig,
} from './native-harness-config';
import type {
  ArmAttempt,
  BenchTask,
  CloneTaskRepo,
  ExtractDiff,
  GenerationBudget,
  GenerationStopReason,
  TaskCheckout,
} from './types';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Current stock arm: native CLI only, with no Papercusp persona, MCP catalog,
 * blueprint materialization or feature pipeline. Reuse the current assignment
 * verifier, native task/session registries, sandbox and complete cost reader. */
export function createCurrentStockBenchHarness(opts: CurrentSuBenchOptions, ctx: PapercuspUnifiedToolContext,
  observations: CurrentSuBenchObservations, db: Pick<DbScope, 'sql'> = {}) {
  const agent = opts.agent;
  const homeEnv = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const containerExec = observations.containerExec && structuredClone(observations.containerExec);
  if (containerExec) {
    validateDockerExecTarget(containerExec);
    const binPath = agent === 'claude' ? CONTAINER_CLAUDE_BIN_PATH : CONTAINER_CODEX_BIN_PATH;
    if (containerExec.workdir !== '/app' || containerExec.binPath !== binPath ||
        containerExec.sessionRelocation?.sessionEnv !== homeEnv)
      throw new Error('Stock native container requires /app, its maintained agent binary, and matching clean-home relocation.');
    if (containerExec.hookBridge || !containerExec.originRewrites)
      throw new Error('Stock native container requires a relocated clean home and gateway rewrite without host hooks.');
  }
  // Stock launchNative owns its validated Docker wrapper. Reuse lifecycle and
  // accounting without configuring the separate current-su Codex launcher.
  const common = liveCurrentSuBenchPorts(ctx, { ...observations, containerExec: undefined }, opts, db);
  const pending = new Map<string, Promise<void>>();
  const taskFinishes = new Map<string, Promise<void>>();
  const streamErrors = new Map<string, string>();
  const ports: CurrentStockBenchPorts = {
    ...common,
    readCompletion: async () => null,
    async killTask(id) {
      const result = await common.killTask(id);
      await taskFinishes.get(id);
      return result;
    },
    async getTask(id) {
      const task = await common.getTask(id);
      if (task && !['pending', 'running'].includes(task.state)) await taskFinishes.get(id);
      return task && streamErrors.has(id) ? { ...task, detail: { ...task.detail, nativeStreamError: streamErrors.get(id) } } : task;
    },
    async launchNative({ handle, task, context }) {
      const verifySession = beginCurrentBenchNativeSession(observations, opts, handle);
      const [{ recordAdvSession, reanchorAdvSessionNativeId, markAdvSessionEnded }, { bindLiveAgentSessionTasksToNativeSession },
        { runAgentChat }] = await Promise.all([import('../adv-sessions'), import('../task-manager/store'), import('../agent-chat-stream')]);
      const ownerId = `benchmark-stock-${randomUUID()}`;
      const label = `${currentBenchAttemptLabel(opts.runId, handle)}solver`;
      const sessionKey = await recordAdvSession({ agent, role: null, mode: 'console', workspaceId: opts.workspaceId,
        coordOwnerId: ownerId, cwd: handle.worktreePath, label });
      if (sessionKey == null) throw new Error('Stock benchmark session enrollment failed; no native process started.');
      const home = agent === 'claude' ? sessionClaudeConfigDir(ownerId) : codexHomeForSessionKey(sessionKey);
      let child: import('node:child_process').ChildProcess | undefined, taskId: string | undefined;
      let wrapperDir: string | undefined;
      let nativeSessionId: string | undefined, linked = Promise.resolve();
      let resolveStarted!: (value: string) => void, rejectStarted!: (error: unknown) => void;
      const started = new Promise<string>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      const pump = async () => {
        let error: string | undefined;
        try {
          await fs.mkdir(dirname(home), { recursive: true });
          // Never reuse an old home or import host context/credentials.
          await fs.mkdir(home, { mode: 0o700 });
          const stream = runAgentChat({ backend: agent === 'claude' ? 'claude-code' : 'codex', agentCmd: agent, model: `${opts.model}:${opts.effort}`,
            cwd: handle.worktreePath, promptText: buildNativeHarnessPrompt(task) + context.contextText,
            isolateConfig: true, isolateDir: home,
            ...(agent === 'claude' ? { statelessGateway: observations.nativeGateway } : { codexGateway: observations.nativeGateway }),
            permissionMode: 'bypassPermissions', ownerId, signal: opts.signal,
            onNativeSession: id => {
              if (nativeSessionId && nativeSessionId !== id) { error = 'Stock native session changed during one assignment.'; child?.kill('SIGTERM'); return; }
              if (nativeSessionId) return;
              nativeSessionId = id;
              linked = linked.then(async () => {
                if (!taskId) throw new Error('Stock native session was observed before task enrollment.');
                const receipt = await reanchorAdvSessionNativeId(sessionKey, id);
                if (receipt.owner !== ownerId) throw new Error('Stock native session registry binding failed.');
                const tasks = await bindLiveAgentSessionTasksToNativeSession({ workspaceId: opts.workspaceId,
                  coordOwnerId: ownerId, sessionId: id, initialTaskId: taskId }, db.sql);
                if (!Array.isArray(tasks) || tasks.length !== 1 || tasks[0] !== taskId) throw new Error('Stock native task registry binding failed.');
              }).catch(async failure => {
                // The child handle may be only the managed launcher. Retire its
                // ledgered subtree through the same owner-aware cleanup seam.
                if (taskId) {
                  const retired = await common.killTask(taskId);
                  if (!retired.ok && retired.error !== 'already_gone' && retired.error !== 'task_not_found')
                    throw new Error(`${errMsg(failure)} Native task cleanup failed: ${retired.error}`);
                } else child?.kill('SIGTERM');
                throw failure;
              });
              // The stream and link run concurrently; pump joins the rejection
              // before finalization even if stream iteration itself throws.
              void linked.catch(() => {});
            },
            spawnProcess: async (command, args, options) => {
              const host = requireCurrentBenchHostBinding(observations, opts);
              verifySession();
              if (opts.signal?.aborted) throw new Error('Stock native assignment was cancelled before process creation.');
              // Shared isolated Claude stages its spawn in the config home.
              // Validate that exact input; the stock sandbox and managed task
              // below still launch in the owned task worktree.
              const stagedCwd = agent === 'claude' ? home : handle.worktreePath;
              if (!(agent === 'claude' ? ['claude'] : ['codex', 'codex.js']).includes(basename(command)) ||
                  options.cwd !== stagedCwd || options.env?.[homeEnv] !== home)
                throw new Error('Stock native identity transport cannot be observed in this host.');
              const env: NodeJS.ProcessEnv = { PATH: options.env.PATH, LANG: options.env.LANG, LC_ALL: options.env.LC_ALL,
                TERM: options.env.TERM, TZ: options.env.TZ, HOME: home, [homeEnv]: home, PAPERCUSP_AGENT: agent,
                PAPERCUSP_SID: ownerId, PAPERCUSP_OPERATOR_URL: observations.nativeGateway!.baseURL,
                [SCOPED_INFERENCE_GATEWAY_ENV]: JSON.stringify(observations.nativeGateway) };
              if (agent === 'claude') Object.assign(env, { XDG_CONFIG_HOME: join(home, '.config'),
                ANTHROPIC_BASE_URL: observations.nativeGateway!.baseURL, ANTHROPIC_AUTH_TOKEN: observations.nativeGateway!.token,
                // The experimental switch leaves interleaved thinking and
                // mid-conversation system betas independent in the frozen CLI.
                // Disable those through its own controls to match the API-key
                // model-limit contract; final headers/body still fail closed.
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
                // Refusal fallback can arm a credit beta independently of the
                // experimental switch and can change the frozen model.
                CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
                DISABLE_INTERLEAVED_THINKING: '1', CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system', DISABLE_AUTOUPDATER: '1' });
              if (task.instanceId !== host.taskId) throw new Error('Stock native task differs from its host assignment.');
              const register = async (binary: string, argv: string[], spawnOptions: import('node:child_process').SpawnOptions) => managedSpawn(binary, argv,
                  { class: 'agent-session', title: label, argv: [], cwd: handle.worktreePath, harnessSlug: handle.slug,
                    launchedBy: ctx.principal!.slug, workItemId: handle.featureId,
                    runtimeMaxSec: Math.max(1, Math.ceil((opts.driveTimeoutMs ?? 60_000) / 1000)), detail: { label, coordOwnerId: ownerId,
                      executionKind: 'stock-native', assignmentId: currentBenchAssignmentId(opts.runId, opts.armId, task.instanceId, opts.seed) } },
                  { workspaceId: opts.workspaceId, requireRegistration: true, spawnOptions });
              let spawned: Awaited<ReturnType<typeof register>>;
              if (containerExec) {
                // Docker is the native OS boundary. Host SRT would conceal its
                // socket/mounts; the existing wrapper relocates only this clean
                // home, rewrites its gateway and runs in the task's /app.
                const wrapper = materializeDockerExecWrapper(containerExec, agent === 'claude' ? {
                  guardClaudeEnv: true,
                  // Only this assignment's route token and clean-home selectors
                  // cross into the task. No ambient provider, MCP or host config.
                  forwardEnvPatterns: ['^CLAUDE_CONFIG_DIR$', '^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$',
                    '^CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS$', '^CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK$',
                    '^DISABLE_INTERLEAVED_THINKING$',
                    '^CLAUDE_CODE_MODEL_CAPABILITIES$', '^DISABLE_AUTOUPDATER$',
                    '^XDG_CONFIG_HOME$', '^ANTHROPIC_(BASE_URL|AUTH_TOKEN)$', '^PAPERCUSP_(AGENT|SID)$', '^LANG$', '^LC_', '^TZ$'],
                } : {});
                wrapperDir = wrapper.dir;
                spawned = await register(wrapper.wrapperPath, agent === 'codex' ? ['--no-daemon', ...args] : args,
                  { ...options, cwd: handle.worktreePath, env });
              } else {
                const sandbox = createScopedNativeSandboxSpawn({ env, cwd: handle.worktreePath });
                if (!sandbox) throw new Error('Stock native sandbox is unavailable; no process started.');
                spawned = await sandbox(command, args, { ...options, cwd: handle.worktreePath, env }, register);
              }
              child = spawned.child; taskId = spawned.taskId;
              resolveStarted(taskId!);
              return child!;
            },
          });
          for await (const event of stream) if (event.type === 'error')
            error = redactSensitiveText(`${event.message}${event.stderr?.trim() ? `\n${event.stderr.trim()}` : ''}`);
          await linked;
          if (!taskId) throw new Error(error ?? 'Stock native process never started.');
          if (error) throw new Error(error);
        } catch (failure) { error = errMsg(failure); rejectStarted(failure); }
        finally {
          try { await linked; }
          catch (failure) {
            const message = errMsg(failure);
            error = error && error !== message ? `${error}; ${message}` : message;
            rejectStarted(failure);
          }
          if (child && child.exitCode === null && child.signalCode === null && taskId) await common.killTask(taskId);
          if (taskId && error) streamErrors.set(taskId, error);
          if (wrapperDir) await fs.rm(wrapperDir, { recursive: true, force: true });
          await markAdvSessionEnded(sessionKey, child?.exitCode ?? null, child?.signalCode ? 'signal' : 'self',
            { signal: child?.signalCode, throwOnError: true });
          if (nativeSessionId) {
            const [{ ingestInteractiveUsage }, { defaultAdapters }] = await Promise.all([
              import('../interactive-usage/ingest-claude-transcripts'), import('../interactive-usage/ingest-adapters')]);
            const adapter = defaultAdapters().find(value => value.name === agent);
            if (!adapter) throw new Error(`Canonical ${agent} usage adapter is unavailable.`);
            await ingestInteractiveUsage({ adapters: [{ ...adapter, root: join(home, agent === 'claude' ? 'projects' : 'sessions'), ownerId, advSessionId: sessionKey }],
              includeIsolationRoots: false, maxFilesPerTick: 1000, maxBytesPerFile: 8_388_608 }, { ...db, workspaceId: opts.workspaceId });
          }
        }
      };
      const finishing = pump();
      pending.set(handle.slug, finishing);
      finishing.catch(rejectStarted);
      const id = await started;
      taskFinishes.set(id, finishing);
      return { agentStarted: true, tasks: [{ taskId: id }] };
    },
    async collectCost(input) {
      return common.collectCost!(input);
    },
  };
  const lifecycle: BenchHarnessOps = {
    now: Date.now,
    createHarness: async ({ checkout }) => ({ slug: `stock-native-${createHash('sha256').update(currentBenchAssignmentId(opts.runId,
      opts.armId, checkout.dir, opts.seed)).digest('hex').slice(0, 24)}`, featureId: 'native-assignment', worktreePath: checkout.dir }),
    addFeature: async () => {}, driveToDone: async () => { throw new Error('Native assignment driver was not composed.'); },
    collectCost: input => ports.collectCost!(input),
    teardown: async ({ handle }) => { await pending.get(handle.slug); pending.delete(handle.slug); },
  };
  return currentStockBenchHarnessDriver(lifecycle, ports, opts);
}

/** A spawn of the native harness — production binds `runAgentChat` (backend 'claude-code'). */
export type SpawnNativeAgent = (opts: RunAgentChatOptions) => AsyncIterable<ChatEvent>;

/** Persist a captured `claude` trajectory → a rollout-record ref (P-010). Default: no ref. */
export type PersistTrajectory = (input: {
  instanceId: string;
  seed: string;
  events: ChatEvent[];
}) => Promise<string>;

/** The injected seam a native attempt needs (fakes in tests; live fns in production). */
export interface NativeHarnessPorts {
  /** Port 1a (P-005, ./clone): clone the task repo @ base commit into a clean worktree. */
  clone: CloneTaskRepo;
  /** Port 1b (P-005, ./clone): `git diff base..HEAD`, grader test-files excluded. */
  extractDiff: ExtractDiff;
  /** Spawn the provider's native harness headless in the checkout. Production: `runAgentChat`. */
  spawnAgent: SpawnNativeAgent;
  /** `claude --version` → the row's `harness_version`. Best-effort; 'unknown' on failure. */
  harnessVersion: () => Promise<string>;
  /** Persist the trajectory → ref for the rollout card (P-010). Omit → no ref (repro layer persists). */
  persistTrajectory?: PersistTrajectory;
  /** Injected for deterministic backoff in tests. Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected wall-clock (ms). Default: `Date.now`. */
  now?: () => number;
}

/**
 * Native-arm result: the SHARED {@link ArmAttempt} (uniform across arms → `diffSubmission` →
 * grader) PLUS the native-specific accounting the lossy `ArmAttempt` has no field for. The pilot
 * folds this into the locked `emitRollout` input (BRIEF 8, su-66ad9):
 *   - `attempt` → the `generation` block's headline fields + `diffSubmission(attempt)` → submission
 *   - `model` / `harnessVersion` → `generation.model_id` / `generation.harness_version`
 *   - `armMeta` → `generation.arm_meta` (carries `tokensCacheRead/Write` → `tokens_cache_read/write`,
 *     `toolCalls`, `retriesUsed`, `costSource`, the native config)
 */
export interface NativeArmResult {
  attempt: ArmAttempt;
  /** The exact model id graded — `emit.generation.model_id`. */
  model: string;
  /** `claude --version` output — `emit.generation.harness_version`. */
  harnessVersion: string;
  /**
   * Did the run hit/exceed the iso-budget cap — `emit.generation.capped`. Computed with the SHARED
   * `budgetExceeded` (P-011) so it's identical across arms. A capped run that still produced a diff
   * is `generationStatus:'completed'` and graded normally (NOT an infra fail) — P-011's rule.
   */
  capped: boolean;
  /** Native extras for `emit.generation.arm_meta` (see {@link NativeArmResult}). */
  armMeta: Record<string, unknown>;
}

interface AttemptOutcome {
  stop: 'done' | 'budget-exhausted' | 'error';
  message?: string;
  /** Whether an `error` stop is a transient/infra failure (→ retry candidate, METR). */
  transient: boolean;
  retryAfterMs?: number;
  diff: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costSource: 'reported' | 'estimated' | 'none';
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  turns: number;
  toolCalls: number;
  wallClockMs: number;
  trajectoryRef: string;
}

/**
 * Run ONE attempt of the native harness against `task`: clone → spawn `claude` (its own agent
 * loop) in the checkout → accumulate tokens/cost/turns/trajectory → extract the diff. Pure infra
 * failures are returned as `stop:'error'` (never thrown). The caller ({@link runNativeHarnessAttempt})
 * decides whether a transient error is retried.
 */
async function runOneNativeAttempt(
  task: BenchTask,
  seed: string,
  budget: GenerationBudget,
  cfg: NativeHarnessConfig,
  ports: NativeHarnessPorts,
  now: () => number,
): Promise<AttemptOutcome> {
  const startedAt = now();
  const base = {
    transient: false,
    diff: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costSource: 'none' as const,
    turns: 0,
    toolCalls: 0,
    trajectoryRef: '',
  };

  let checkout: TaskCheckout;
  try {
    checkout = await ports.clone(task);
  } catch (e) {
    return { ...base, stop: 'error', message: `clone failed: ${errMsg(e)}`, wallClockMs: now() - startedAt };
  }

  const events: ChatEvent[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let reportedCost = 0;
  let costReported = false;
  let turns = 0;
  let toolCalls = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let sawResult = false;
  let terminalError: { message: string; transient: boolean; retryAfterMs?: number } | undefined;
  let abortedByWallClock = false;

  // Wall-clock ceiling is the ONE iso-budget lever enforceable on the native CLI (it ignores a
  // token cap). When `maxWallClockMs` is hit we abort the spawn but still extract the partial work.
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wallCap = budget.maxWallClockMs;
  if (wallCap && wallCap > 0) {
    timer = setTimeout(() => {
      abortedByWallClock = true;
      ac.abort();
    }, wallCap);
    (timer as { unref?: () => void }).unref?.();
  }

  try {
    const prompt = buildNativeHarnessPrompt(task);
    const stream = ports.spawnAgent({
      backend: 'claude-code',
      model: cfg.model,
      cwd: checkout.dir,
      promptText: prompt,
      permissionMode: cfg.permissionMode,
      isolateConfig: cfg.isolateConfig,
      signal: ac.signal,
      // NB: temperature / maxTokens intentionally unset — Claude Code uses its native recommended
      // sampling (the headline-baseline fairness point; the claude-code backend ignores them anyway).
    });

    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === 'tool_call') {
        toolCalls++;
      } else if (ev.type === 'result') {
        sawResult = true;
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
        if (ev.costUsd > 0) {
          reportedCost = ev.costUsd;
          costReported = true;
        }
        if (typeof ev.numTurns === 'number') turns = ev.numTurns;
        if (typeof ev.cacheReadTokens === 'number') cacheReadTokens = ev.cacheReadTokens;
        if (typeof ev.cacheCreationTokens === 'number') cacheCreationTokens = ev.cacheCreationTokens;
      } else if (ev.type === 'error') {
        terminalError = {
          message: ev.stderr?.trim() ? `${ev.message} — ${ev.stderr.trim()}` : ev.message,
          transient: ev.turn?.retryable === true,
          retryAfterMs: ev.turn?.retryAfterMs,
        };
      }
    }
  } catch (e) {
    terminalError = { message: `native harness spawn failed: ${errMsg(e)}`, transient: false };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Claude Code always reports `num_turns`; if a (fake / old) stream omitted it, proxy off the
  // observable tool-call count so the row still carries a non-zero turn signal.
  if (!turns) turns = toolCalls;

  // Cost: prefer Claude's reported `total_cost_usd` (more accurate than list price — subscription
  // billing differs); else estimate from tokens at list price (@papercusp/model-pricing).
  let costUsd = 0;
  let costSource: 'reported' | 'estimated' | 'none' = 'none';
  if (costReported) {
    costUsd = reportedCost;
    costSource = 'reported';
  } else {
    const est = costFromTokens(cfg.model, {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheReadTokens,
      cacheCreationTokens,
    });
    if (est.priced) {
      costUsd = est.usd;
      costSource = 'estimated';
    }
  }

  const trajectoryRef = ports.persistTrajectory
    ? await ports.persistTrajectory({ instanceId: task.instanceId, seed, events }).catch(() => '')
    : '';

  const usage = {
    tokensIn,
    tokensOut,
    costUsd,
    costSource,
    cacheReadTokens,
    cacheCreationTokens,
    turns,
    toolCalls,
    trajectoryRef,
  };

  // A terminal infra error with NO usable result event → the run never produced trustworthy work.
  if (terminalError && !sawResult && !abortedByWallClock) {
    await checkout.cleanup().catch(() => {});
    return {
      ...usage,
      stop: 'error',
      message: terminalError.message,
      transient: terminalError.transient,
      retryAfterMs: terminalError.retryAfterMs,
      diff: '',
      wallClockMs: now() - startedAt,
    };
  }

  // The agent ran (done, or wall-clock-capped after producing partial work) → extract its diff.
  let diff = '';
  let diffError: string | undefined;
  try {
    diff = await ports.extractDiff(checkout, task);
  } catch (e) {
    diffError = `diff extraction failed: ${errMsg(e)}`;
  } finally {
    await checkout.cleanup().catch(() => {});
  }

  if (diffError) {
    return { ...usage, stop: 'error', message: diffError, transient: false, diff: '', wallClockMs: now() - startedAt };
  }

  return {
    ...usage,
    stop: abortedByWallClock ? 'budget-exhausted' : 'done',
    transient: false,
    diff,
    wallClockMs: now() - startedAt,
  };
}

/**
 * Run the native harness (Claude Code) on ONE benchmark task and produce the shared
 * {@link ArmAttempt} (arm `baseline-b-native`) + native accounting. Retries transient/infra
 * failures up to {@link NativeHarnessConfig.maxRetries} (METR) with a fresh checkout each time;
 * a genuine task miss (empty/partial diff) is NOT retried — it's a real result the grader sees.
 *
 * @param task   the normalized benchmark task ({@link BenchTask})
 * @param seed   reproducibility seed — becomes the predictions-JSON `prefix` (one per seed)
 * @param budget the iso-budget ceiling; only `maxWallClockMs` is enforceable on the native CLI
 * @param ports  injected clone / extractDiff / spawnAgent / harnessVersion seam (fakes in tests)
 * @param config elicited-to-best overrides (model is pinned to the Papercusp arm's by the pilot)
 */
export async function runNativeHarnessAttempt(
  task: BenchTask,
  seed: string,
  budget: GenerationBudget,
  ports: NativeHarnessPorts,
  config: Partial<NativeHarnessConfig> = {},
): Promise<NativeArmResult> {
  const cfg: NativeHarnessConfig = { ...DEFAULT_NATIVE_HARNESS_CONFIG, ...config };
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let harnessVersion = 'unknown';
  try {
    const v = (await ports.harnessVersion()).trim();
    if (v) harnessVersion = v;
  } catch {
    /* best-effort — the row still records the model id */
  }

  let retriesUsed = 0;
  let last: AttemptOutcome;
  for (let attempt = 0; ; attempt++) {
    last = await runOneNativeAttempt(task, seed, budget, cfg, ports, now);
    if (last.stop !== 'error' || !last.transient || attempt >= cfg.maxRetries) break;
    // Transient/infra failure with retries remaining (METR): wait (honoring retryAfterMs, capped)
    // and re-run on a FRESH checkout — the failed attempt's tokens are discarded from the headline.
    retriesUsed++;
    const wait = Math.min(last.retryAfterMs ?? cfg.retryBackoffMs * (attempt + 1), cfg.maxRetryWaitMs);
    await sleep(wait);
  }

  const stopReason: GenerationStopReason =
    last.stop === 'done' ? 'done' : last.stop === 'budget-exhausted' ? 'budget-exhausted' : 'error';

  // `capped` via the SHARED check (identical across arms = real iso-budget). True on a wall-clock
  // abort OR when actual tokens/$ reached the cap. (The native CLI can't pre-empt mid-run, so this
  // is post-hoc — the wall-clock ceiling is the only mid-run lever; see the module header.)
  const cap: IsoBudgetCap = { tokens: budget.maxTokens ?? null, usd: budget.maxUsd ?? null };
  const capped =
    last.stop === 'budget-exhausted' ||
    budgetExceeded({ tokensTotal: last.tokensIn + last.tokensOut, costUsd: last.costUsd }, cap);

  const attemptRow: ArmAttempt = {
    arm: BASELINE_B_ARM,
    blueprintId: NATIVE_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: last.stop === 'error' ? '' : last.diff,
    tokensIn: last.tokensIn,
    tokensOut: last.tokensOut,
    costUsd: last.costUsd,
    turns: last.turns,
    wallClockMs: last.wallClockMs,
    trajectoryRef: last.trajectoryRef,
    stopReason,
    ...(last.stop === 'error' && last.message ? { generationError: last.message } : {}),
  };

  const armMeta: Record<string, unknown> = {
    backend: 'claude-code',
    harness: 'native',
    elicitation: 'native-best',
    permissionMode: cfg.permissionMode,
    isolateConfig: cfg.isolateConfig,
    model: cfg.model,
    harnessVersion,
    toolCalls: last.toolCalls,
    retriesUsed,
    costSource: last.costSource,
    ...(last.cacheReadTokens !== undefined ? { tokensCacheRead: last.cacheReadTokens } : {}),
    ...(last.cacheCreationTokens !== undefined ? { tokensCacheWrite: last.cacheCreationTokens } : {}),
    ...(budget.maxWallClockMs ? { budgetMaxWallClockMs: budget.maxWallClockMs } : {}),
  };

  return { attempt: attemptRow, model: cfg.model, harnessVersion, capped, armMeta };
}
