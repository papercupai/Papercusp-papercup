/** PUI's attached-engine branch of the shared launch-su door. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { selectSuSessionExecution, type SuSessionBackend } from '@papercusp/chat-protocol';
import { getChat } from './agent-chats-data';
import { getAdvSession, markAdvSessionEnded, setAdvSessionPid } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { nativeSessionHandleForAdvSession } from './native-session-handles';
import { _dropSuSessionHostForTest, getRegisteredSuSessionHost, rehydrateRegisteredSuSessionHost, type SuSessionHost } from './su-session-host';
import {
  bindSuSessionToAdvSession,
  persistSuSessionDescriptor,
  readDurableSuSession,
  readSuSessionHostOwner,
  recordSuSessionHostOwner,
} from './su-session-persistence';
import { callOwnerProcess, registerOwnerRpcHandler } from './cluster-owner-rpc';
import {
  SU_SESSION_SERVED_BY_HEADER,
  isForwardableOwner,
  isLocalSuSessionOwner,
  localSuSessionHostOwner,
} from './su-session-owner-routing';
import { startClaudeSuEngine, type ClaudeEngineIdentity, type ClaudeSuEngine } from './su-session-claude-engine';
import { loadHarnessRegistry } from './harness-registry';
import type { ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';
import type { NativeSessionHandle } from './native-session-handles';
import { activeWorkspaceId } from './workspace-registry';
import { prepareStructuredSuResume } from './su-session-resume';
import { resolveCodexModelSelection } from './model-context-budget.mjs';
import { grantSuClientLease, suClientLeaseConfig, superviseSuClientLease } from './su-session-client-lease';
import { normalizeModelSpecForAgent } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { retainRequestPrincipal } from './auth/require-principal';

const state = pinModuleState('@papercusp/operator-core.su-attached-launch', () => ({
  starting: new Map<string, Promise<Record<string, unknown>>>(),
  engines: new Map<string, ClaudeSuEngine | SuRpcEngine>(),
  // Each engine's exit bookkeeping (close + ended mark); its engine entry is
  // cleared only when this settles.
  exits: new Map<string, Promise<void>>(),
}));

/**
 * A launch awaits durable writes (the WI-10003879 host owner, the descriptor)
 * between starting an engine and the bookkeeping that awaits `ready`. An
 * engine that fails at once rejects `ready` inside that gap, and Node reports
 * it as UNHANDLED even though the bookkeeping handles it a moment later
 * (agent-chat-pty P-003's startup-exit engine, 2026-10-05). Observe it the
 * moment the engine exists; every later `await engine.ready` still sees the error.
 */
export function observeReadiness(engine: Pick<ClaudeSuEngine | SuRpcEngine, 'ready'>): void {
  engine.ready.catch(() => undefined);
}

function trackExit(key: string, exit: Promise<void>): void {
  state.exits.set(key, exit);
  void exit.finally(() => { if (state.exits.get(key) === exit) state.exits.delete(key); });
}

/**
 * Test-only: simulate the death of the operator process that launched one
 * attached PUI session (pui-chat-first-ux-2026-09-28 P-002, session 31362).
 * Everything this process holds for the chat is forgotten, exactly as a fresh
 * process would find it: the in-flight launch, the engine, that engine's exit
 * bookkeeping and the live host. The durable row stays as the dead process last
 * wrote it. The forgotten engine is returned so the caller can take its native
 * process down with it and prove the state really held that engine.
 */
export function _simulateLaunchingProcessLossForTest(input: {
  harnessSlug: string;
  agentChatId: string;
}): ClaudeSuEngine | SuRpcEngine | undefined {
  const key = `${activeWorkspaceId()}:${input.harnessSlug}:${input.agentChatId}`;
  const engine = state.engines.get(key);
  state.starting.delete(key);
  state.engines.delete(key);
  state.exits.delete(key);
  if (engine) _dropSuSessionHostForTest(engine.adapter.host);
  return engine;
}

/** Why an engine ended with nobody watching it (P-009). Shown on the chat. */
export const UNATTENDED_END_REASON =
  'Ended because no client was attached. Resume the conversation to continue it; /detach keeps a session running without a client.';

/**
 * pui-chat-first-ux-2026-09-28 P-009: an attached engine lives only while a
 * client is watching it or its owner detached it. Grants the first-attach lease
 * and ends the engine once the durable client lease lapses. Returns the release
 * to call when this engine exits on its own.
 */
function superviseAttendance(advSessionId: number, engine: ClaudeSuEngine | SuRpcEngine): () => void {
  void grantSuClientLease(advSessionId, suClientLeaseConfig().initialMs);
  return superviseSuClientLease(advSessionId, async () => {
    const host = engine.adapter.host;
    try {
      if (!host.snapshot().terminal) host.transition('ended', UNATTENDED_END_REASON);
    } catch { /* a disposed host has nothing left to tell */ }
    await engine.close();
  });
}

/** Exact-resume attempts per reconnect: the original plus one automatic retry
 * after a startup-deadline timeout (P-028). A second timeout is reported. */
export const RESUME_STARTUP_ATTEMPTS = 2;

function realDir(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Scope rule of plan pui-chat-first-ux-2026-09-28 D-004/D-005: a Claude chat
 * whose directory lies inside a registered checkout keeps the SU identity,
 * because that tree is shared and the psu hooks carry its lock, secrets and
 * migration rails. Anywhere else it is Claude Code's own coding assistant. */
export function claudeEngineIdentityForCwd(cwd: string, checkoutRoots: readonly string[]): ClaudeEngineIdentity {
  const dir = realDir(cwd);
  const inside = checkoutRoots.some((root) => {
    const rel = relative(realDir(root), dir);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  return inside ? 'su' : 'coding-assistant';
}

/** Recomputed from the same inputs on launch and on resume, so a resumed chat
 * keeps its identity without persisted state. An unreadable registry keeps the
 * SU identity: dropping the rails is the choice that needs positive evidence. */
async function engineIdentityForLaunch(workspaceId: string, cwd: string | null | undefined): Promise<ClaudeEngineIdentity> {
  if (!cwd) return 'su';
  try {
    const registry = await loadHarnessRegistry(workspaceId);
    return claudeEngineIdentityForCwd(cwd, registry.projects.flatMap((project) => project.path ? [project.path] : []));
  } catch {
    return 'su';
  }
}

/** Classified by the typed error's code rather than `instanceof`, so a
 * duplicated module record or a mocked host module cannot hide the class. */
function isStartupTimeout(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'su_session_startup_timeout';
}

/** True once `key`'s previous engine has finished exiting, waiting at most `ms`. */
async function previousEngineExited(key: string, ms: number): Promise<boolean> {
  const exit = state.exits.get(key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (exit) await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
  return !state.engines.has(key);
}

// PUI sessions use native approval prompts on both creation and recovery.
// Manual/auto mode is a separate agent policy, never a permission bypass.

export interface AttachedSuLaunchInput {
  agent: string;
  /** Presence is significant: invalid explicit choices never become defaults. */
  execution_kind?: unknown;
  /** Fork into this new chat through the native Claude structured engine. */
  fork_from?: { advSessionId: number; nativeSessionId: string };
  agent_chat_id: string;
  harness_slug: string;
  plan_slug?: string | null;
  account: string;
  carry?: 'warm' | 'cold';
  model?: string | null;
  mode?: string | null;
  context_size?: string;
  compaction_limit?: number | null;
  fleet?: string | null;
  seat?: string | null;
  launch_context?: string | null;
  /** The directory the PUI was launched from. When this host can see it, the
   *  session runs there (Claude Code parity, pui-chat-first-ux P-001);
   *  otherwise bootstrap keeps the project checkout. */
  cwd?: string | null;
}

/** How long one launch may run before it reports the step it is stuck in. */
export const LAUNCH_STALL_REPORT_MS = 15_000;
/** A finished step at least this slow is reported with its duration. */
export const SLOW_LAUNCH_STAGE_MS = 5_000;
/** A stall report running at least this late says the event loop was delayed. */
export const LATE_STALL_REPORT_MS = 1_000;

export interface LaunchStageTracer {
  /** Enter the next named step, reporting the previous one if it was slow. */
  stage(next: string): void;
  /** The launch settled: report a slow final step and stop the stall report. */
  end(): void;
}

/**
 * `warn` = the launch is stuck (nothing has finished it). `info` = a step that
 * DID finish was slow: a timing note, not a fault.
 */
export type LaunchTraceLevel = 'info' | 'warn';

/** The default sink: a stall is a warning, a slow finished step is information. */
export function logLaunchTrace(line: string, level: LaunchTraceLevel): void {
  if (level === 'warn') console.warn(line);
  else console.info(line);
}

/**
 * A PUI launch that never finishes must say WHICH step it stalled in. The PUI
 * only sees "SU launch did not finish", and without this the stall left no
 * server-side evidence at all (pui-chat-first-ux P-007, 2026-09-30).
 *
 * The slow-step line is `info`, not `warn`: the step completed, so it is a
 * timing note. As a warning it failed the in-process PTY e2e suite under
 * vitest-fail-on-console whenever host load stretched bootstrap past 5s
 * (rehearsal run 15, 2026-10-01, WI-10004247), a launch that worked.
 */
export function launchStageTracer(
  key: string,
  log: (line: string, level: LaunchTraceLevel) => void = logLaunchTrace,
  now: () => number = () => performance.now(),
): LaunchStageTracer {
  const startedAt = now();
  let stage = 'read-chat';
  let stageAt = startedAt;
  const stall = setTimeout(() => {
    const at = now();
    // A report that runs late measures time in which this process ran no
    // timers at all (synchronous work, GC, or the process not being
    // scheduled), which a slow asynchronous wait cannot cause. Naming it tells
    // the two apart from the line alone (WI-10006559: a 15s report ran at 24s).
    const elapsed = at - startedAt;
    const late = elapsed - LAUNCH_STALL_REPORT_MS;
    const elapsedMs = Math.round(elapsed);
    const stageElapsedMs = Math.round(at - stageAt);
    log(`[su-launch] ${key} not finished after ${elapsedMs}ms; stalled in stage=${stage} for ${stageElapsedMs}ms`
      + (late >= LATE_STALL_REPORT_MS ? `; this report ran ${Math.round(late)}ms late (event loop delayed)` : ''), 'warn');
  }, LAUNCH_STALL_REPORT_MS);
  stall.unref?.();
  const close = (next: string | null) => {
    const at = now();
    const elapsedMs = at - stageAt;
    if (elapsedMs >= SLOW_LAUNCH_STAGE_MS) log(`[su-launch] ${key} stage=${stage} took ${Math.round(elapsedMs)}ms`, 'info');
    if (next !== null) { stage = next; stageAt = at; }
  };
  return { stage: (next) => close(next), end: () => { close(null); clearTimeout(stall); } };
}

/** cluster-owner-rpc kind: a re-attach for a session whose engine lives in another worker. */
export const SU_SESSION_ATTACH_RPC_KIND = 'su-session-attach';

type ForwardedAttachReply =
  | { status: 'ok'; httpStatus: number; body: unknown }
  | { status: 'not_owner' };

/**
 * WI-10003879: a re-attach (PUI's startup adoption, a /resume pick, a reconnect)
 * that lands on a worker which does not hold the engine must not start a second
 * engine there. When another live worker of this service recorded itself as the
 * owner, the attach runs THERE. Returns null to proceed locally: no owner, the
 * owner is gone (its engine went with it), or it no longer claims the session.
 */
async function forwardAttachToOwner(input: AttachedSuLaunchInput): Promise<Response | null> {
  const owner = await readSuSessionHostOwner({ agentChatId: input.agent_chat_id, workspaceId: activeWorkspaceId() });
  if (!isForwardableOwner(owner)) return null;
  const outcome = await callOwnerProcess({
    targetPid: owner.pid,
    kind: SU_SESSION_ATTACH_RPC_KIND,
    payload: { input, hostId: owner.hostId, nonce: owner.nonce },
    timeoutMs: 60_000,
  });
  if (outcome.ok) {
    const reply = outcome.result as ForwardedAttachReply | null;
    if (reply?.status !== 'ok') return null;
    return Response.json(reply.body, {
      status: reply.httpStatus,
      headers: { [SU_SESSION_SERVED_BY_HEADER]: `forwarded:${owner.pid}` },
    });
  }
  if (outcome.code === 'owner_gone' || outcome.code === 'no_handler' || outcome.code === 'not_clustered') return null;
  return Response.json({
    status: 'error',
    code: 'su_session_owner_unreachable',
    error: `The worker holding this session (pid ${owner.pid}) did not answer: ${outcome.message}. Nothing was started; retry.`,
    retryable: true,
  }, { status: 503 });
}

/** OWNER side of a forwarded re-attach. Never forwards again; never bootstraps. */
export async function serveForwardedSuAttach(payload: unknown): Promise<ForwardedAttachReply> {
  const p = payload as { input?: AttachedSuLaunchInput; hostId?: unknown; nonce?: unknown } | null;
  const input = p?.input;
  if (!input || typeof input.agent_chat_id !== 'string' || typeof input.harness_slug !== 'string' || typeof input.agent !== 'string') {
    throw new Error('malformed su-session attach request');
  }
  if (typeof p.hostId !== 'string' || typeof p.nonce !== 'string' || !isLocalSuSessionOwner(p.hostId, p.nonce)) {
    return { status: 'not_owner' };
  }
  // A fresh launch must run where the caller's authenticated request is; only
  // an existing durable session is ever re-attached on the caller's behalf.
  const durable = await readDurableSuSession({ workspaceId: activeWorkspaceId(), agentChatId: input.agent_chat_id });
  if (!durable) return { status: 'not_owner' };
  const response = await launchAttachedSuSession(null, input, { forwarded: true });
  return { status: 'ok', httpStatus: response.status, body: await response.json() };
}

registerOwnerRpcHandler(SU_SESSION_ATTACH_RPC_KIND, serveForwardedSuAttach);

export async function launchAttachedSuSession(
  request: Request | null,
  input: AttachedSuLaunchInput,
  options: { forwarded?: boolean } = {},
): Promise<Response> {
  if (!['claude', 'codex', 'omp'].includes(input.agent)) {
    return Response.json({ status: 'error', code: 'attached_engine_unavailable', error: `The ${input.agent} engine does not support PUI's structured connection.` }, { status: 409 });
  }
  const requested = Object.prototype.hasOwnProperty.call(input, 'execution_kind')
    ? { requestedKinds: [input.execution_kind] } : {};
  // Validate before forwarding/coalescing: a conflicting request must not join
  // another request's already-starting programmatic engine.
  const selection = selectSuSessionExecution({ provider: input.agent as SuSessionBackend,
    operation: 'create', headless: false, defaultKind: 'programmatic',
    supportedKinds: ['programmatic'], ...requested });
  if (!selection.ok) return Response.json({ status: 'error', ...selection.refusal,
    error: selection.refusal.message }, { status: selection.refusal.code === 'invalid_execution_kind' ? 400 : 409 });
  const workspaceId = activeWorkspaceId();
  const key = `${workspaceId}:${input.harness_slug}:${input.agent_chat_id}`;
  if (!options.forwarded && !state.engines.has(key) && !state.starting.has(key)) {
    const forwarded = await forwardAttachToOwner(input);
    if (forwarded) return forwarded;
  }
  let start = state.starting.get(key);
  if (start && input.fork_from) return Response.json({ status: 'error', code: 'fork_target_busy',
    error: 'A fork requires a new conversation without an in-flight launch' }, { status: 409 });
  let trace: LaunchStageTracer | null = null;
  if (!start) {
    trace = launchStageTracer(key);
    start = create();
    state.starting.set(key, start);
    void start.finally(() => {
      trace?.end();
      if (state.starting.get(key) === start) state.starting.delete(key);
    }).catch(() => undefined);
  }
  try { return Response.json(await start); }
  catch (error) {
    const refusal = (error as { executionRefusal?: { code: string; message: string; retryable: boolean } } | null)?.executionRefusal;
    if (refusal) return Response.json({ status: 'error', ...refusal, error: refusal.message }, { status: 409 });
    return Response.json({ status: 'error', code: 'attached_engine_start_failed', error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  async function create(): Promise<Record<string, unknown>> {
    const chat = await getChat({ slug: input.harness_slug, chatId: input.agent_chat_id });
    if (!chat.ok) throw new Error(chat.error);
    if (chat.data.archived_at) throw new Error('This conversation is archived; restore it before connecting');
    trace?.stage('read-durable-session');
    if (chat.data.su_runtime_class !== 'su-session') throw new Error('This conversation is not classified as an SU session; its existing history was preserved');
    const previous = await readDurableSuSession({ workspaceId, agentChatId: input.agent_chat_id });
    if (input.fork_from && previous) throw new Error('A fork requires a new, unbound conversation');
    if (previous) {
      if (previous.backend !== input.agent || previous.harnessSlug !== input.harness_slug) throw new Error('The conversation is already bound to a different engine or project');
      const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
      const existingSelection = selectSuSessionExecution({ provider: input.agent as SuSessionBackend,
        operation: 'existing', supportedKinds: ['programmatic'], ...requested,
        ...(previous.descriptor && Object.prototype.hasOwnProperty.call(previous.descriptor, 'executionKind')
          ? { savedKind: previous.descriptor.executionKind } : {}),
        // This map contains only structured engine instances. Otherwise require
        // the launcher marker written when the actual native engine became ready.
        legacyKind: state.engines.has(key) || previous.terminalBin === `pui-structured-${previous.backend}`
          ? 'programmatic' : undefined });
      if (!existingSelection.ok) throw Object.assign(new Error(existingSelection.refusal.message),
        { executionRefusal: existingSelection.refusal });
      const snapshot = host?.snapshot();
      // A resumed engine restores its transcript in 'resuming' before it is
      // ready; a second attach meanwhile (the startup adoption and a /resume
      // pick) joins it rather than waiting on it to exit (WI-10004162).
      const initializing = state.engines.has(key)
        && (snapshot?.descriptor.lifecycle === 'starting' || snapshot?.descriptor.lifecycle === 'resuming');
      if (!snapshot || snapshot.terminal || (!initializing && (!snapshot.executorAttached || !snapshot.streamReady))) {
        // A dead engine's exit bookkeeping can still be running when the
        // owner's recovery send arrives; wait for it rather than refuse.
        if (state.engines.has(key) && !await previousEngineExited(key, 10_000)) {
          throw new Error('The previous native process is still closing; reconnect after it exits');
        }
        trace?.stage('resume');
        const restored = host ?? await rehydrateRegisteredSuSessionHost({ workspaceId,
          harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
        if (!restored) throw new Error('Reconnect requires the saved session descriptor');
        const startResumedEngine = async (record: typeof previous) => {
          trace?.stage('resume-resolve-identity');
          const identity = await engineIdentityForLaunch(workspaceId, record.cwd);
          const resume = await prepareStructuredSuResume(record, {
            identity, stage: (name) => trace?.stage(name),
          });
          trace?.stage('resume-start-engine');
          let active: ClaudeSuEngine | SuRpcEngine | undefined;
          try {
            const options = { ...resume.options, host: restored, beforeReady: resume.beforeReady,
              onExit: resume.onExit, toolApproval: 'prompt' as const,
              resolveRequestPrincipal: record.backend === 'codex' || record.backend === 'claude'
                ? await retainRequestPrincipal(request?.headers ?? null, workspaceId) : undefined };
            active = record.backend === 'claude'
              ? startClaudeSuEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'claude' },
                { nativeSession: resume.nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null },
                { ...options, host: restored as SuSessionHost<'claude'>, resume: resume.exact,
                  identity })
              : startSuRpcEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' },
                { ...options, nativeSession: resume.nativeSession as Extract<NativeSessionHandle, { backend: 'codex' | 'omp' }>,
                  identity, stage: (name) => trace?.stage(name) });
            state.engines.set(key, active);
            observeReadiness(active);
            // WI-10003879: sibling workers route this session's requests here.
            trace?.stage('resume-record-host-owner');
            await recordSuSessionHostOwner(record.advSessionId, localSuSessionHostOwner(), workspaceId);
            trace?.stage('resume-persist-host-descriptor');
            await persistSuSessionDescriptor(record.advSessionId, active.adapter.host.descriptor());
          } catch (error) { await active?.close(); await resume.release(); throw error; }
          return { engine: active, resume };
        };
        // P-028: a resume whose startup deadline fires is RECOVERABLE — a fresh
        // attempt runs the exact path an owner's manual reconnect would, under
        // the same exclusivity lease. Bounded, visible on the session's own
        // event stream, and never applied to a refusal (auth, identity, a
        // missing transcript), which a repeat cannot fix.
        const supervise = async (current: Awaited<ReturnType<typeof startResumedEngine>>, attempt: number): Promise<void> => {
          const { engine, resume } = current;
          const unsupervise = superviseAttendance(previous.advSessionId, engine);
          let retryable: unknown = null;
          try {
            try { await engine.ready; } catch (error) { if (isStartupTimeout(error)) retryable = error; throw error; }
            await engine.done;
          } catch (error) {
            if (!engine.adapter.host.snapshot().terminal) engine.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
            await engine.close();
            await resume.release();
          } finally {
            unsupervise();
            // Keep the slot reserved across a retry so a concurrent reconnect
            // waits on it instead of racing a second resume for the lease.
            if (state.engines.get(key) === engine && !(retryable && attempt < RESUME_STARTUP_ATTEMPTS)) state.engines.delete(key);
          }
          if (!retryable || attempt >= RESUME_STARTUP_ATTEMPTS) return;
          const stage = (retryable as { stage?: unknown }).stage;
          engine.adapter.host.emit({ type: 'error', scope: 'transport', code: 'resume_startup_retry', recoverable: true,
            message: `Resume attempt ${attempt} of ${RESUME_STARTUP_ATTEMPTS} did not reach readiness`
              + `${typeof stage === 'string' ? ` (stalled in ${stage})` : ''}; retrying the saved conversation automatically` } as never);
          let next: Awaited<ReturnType<typeof startResumedEngine>>;
          try {
            // The failed attempt advanced the runtime generation on this host;
            // the replacement must advance it again, so resume from the host's
            // own descriptor rather than the pre-attempt durable copy.
            next = await startResumedEngine({ ...previous, descriptor: restored.snapshot().descriptor } as typeof previous);
          } catch (error) {
            if (state.engines.get(key) === engine) state.engines.delete(key);
            throw error;
          }
          return supervise(next, attempt + 1);
        };
        const first = await startResumedEngine(previous);
        trackExit(key, supervise(first, 1).catch((error: unknown) => console.warn('[su-session] resume bookkeeping failed', error)));
        return { status: 'ok', attached: true, resumed: true, transport: 'structured', ready: false,
          advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
          harnessSlug: previous.harnessSlug, planSlug: first.resume.binding.planSlug, agent: previous.backend,
          nativeSession: first.resume.nativeSession };
      }
      const row = await getAdvSession(previous.advSessionId);
      const existingEngine = state.engines.get(key);
      return { status: 'ok', attached: true, duplicate: true, transport: 'structured',
        ready: !initializing,
        advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
        harnessSlug: previous.harnessSlug, agent: previous.backend,
        nativeSession: existingEngine && 'nativeSession' in existingEngine ? existingEngine.nativeSession()
          : row ? nativeSessionHandleForAdvSession(row) : null };
    }
    let claudeForkSource: import('./su-session-tracked-claude-fork').TrackedClaudeForkSource | undefined;
    if (input.fork_from) {
      if (input.agent !== 'claude') throw new Error('Structured fork source requires Claude');
      const { getAdvSessionInWorkspace } = await import('./adv-sessions');
      const parent = await getAdvSessionInWorkspace(input.fork_from.advSessionId, workspaceId);
      const handle = parent && nativeSessionHandleForAdvSession(parent);
      if (!parent || parent.retiredAt || parent.sessionId !== input.fork_from.nativeSessionId
        || handle?.backend !== 'claude' || !handle.exactResumeSupported || !handle.configDir) {
        throw new Error('Claude fork source is unavailable or does not match its tracked identity');
      }
      claudeForkSource = { advSessionId: Number(parent.id), nativeSession: handle };
    }
    trace?.stage('bootstrap');
    // A forwarded re-attach carries no caller request; bootstrap needs its
    // authenticated principal, so it never runs on the caller's behalf.
    if (!request) throw new Error('A new session must be launched by the worker that received the request');
    const { bootstrapSu } = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
    // PUI owns the visible model picker. Its "server default" choice has the
    // same authority as the PSU picker, even though the native engine has no
    // terminal. Preserve that choice through the headless bootstrap boundary.
    const codexSelection = input.agent === 'codex'
      ? resolveCodexModelSelection(input.model, { source: input.model?.trim() ? 'explicit' : 'configured-default' })
      : null;
    // A fresh PUI launch bypasses psu's CLI argument normalization. Apply the
    // same Claude window marker before both bootstrap's saved launch spec and
    // the structured SDK receive this model; exact resume already normalizes
    // its saved model in prepareStructuredSuResume. Without this, bare sonnet
    // opens a 200k local Claude window and can reject a native-question
    // continuation before its next gateway request (WI-10003087).
    const selectedModel = input.agent === 'claude'
      ? normalizeModelSpecForAgent('claude', input.model)
      : codexSelection?.model ?? input.model;
    // Preserve the request's authenticated principal. Bootstrap remains the one
    // authority for persona, scope, account, mode, membership and native identity.
    const response = await bootstrapSu.handler(new Request(request.url, {
      method: 'POST', headers: request.headers,
      body: JSON.stringify({ ...input, workspace: workspaceId, owner_id: `su-${randomUUID()}`,
        model: selectedModel, ...(codexSelection ? { model_source: codexSelection.source } : {}),
        bootstrap_idempotency_key: `pui:${workspaceId}:${input.agent_chat_id}`,
        ...(input.cwd?.trim() ? { cwd: input.cwd.trim(), cwd_policy: 'caller' } : { cwd: null }),
        headless: true, auto: input.mode === 'auto', mode: input.mode === 'auto' ? null : input.mode,
      }),
    }), undefined as never);
    const result = await response.json() as BootstrapSuResult & { error?: string };
    if (!response.ok || result.status !== 'ok') throw new Error(result.error ?? 'SU bootstrap failed');
    if (!result.sessionId || !result.envelopeEnv.PAPERCUSP_SID
      || result.agent !== input.agent
      || (result.agent === 'claude' && (!result.nativeSessionId || !result.envelopeEnv.CLAUDE_CONFIG_DIR))) {
      if (result.sessionId) await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw new Error('SU bootstrap did not supply a matching identity and configuration');
    }
    let engine: ClaudeSuEngine | SuRpcEngine | undefined;
    try {
      const binding: PuiSuSessionBinding = {
        operation: 'created', backend: result.agent, advSessionId: result.sessionId,
        ownerId: result.envelopeEnv.PAPERCUSP_SID, workspaceId: result.workspaceId,
        harnessSlug: result.harnessSlug, planSlug: result.planSlug, nativeSession: null,
      };
      const nativeSession: NativeSessionHandle | null = result.agent === 'claude' ? {
        backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId,
        sessionId: result.nativeSessionId, configDir: result.envelopeEnv.CLAUDE_CONFIG_DIR,
        configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
        exactResumeSupported: true as const, missingReason: null,
      } : null;
      binding.nativeSession = nativeSession;
      trace?.stage('bind');
      const bound = await bindSuSessionToAdvSession({ workspaceId, advSessionId: result.sessionId, agentChatId: input.agent_chat_id });
      if (bound.status !== 'bound' && bound.status !== 'already_bound') throw new Error('Could not bind the SU session to this conversation');
      const options = {
        agentChatId: input.agent_chat_id,
        model: result.agent === 'claude'
          ? normalizeModelSpecForAgent('claude', result.model ?? selectedModel)
          : result.model ?? selectedModel,
        accountRoute: input.account,
        carry: input.carry ?? 'warm', modes: input.mode ? [input.mode] : [],
        onExit: async () => { await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true }); },
        toolApproval: 'prompt' as const,
        resolveRequestPrincipal: result.agent === 'codex' || result.agent === 'claude'
          ? await retainRequestPrincipal(request.headers, workspaceId) : undefined,
      };
      trace?.stage('engine-start');
      engine = result.agent === 'claude'
        ? startClaudeSuEngine(result, binding as PuiSuSessionBinding & { backend: 'claude' },
          { nativeSession: nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null },
          { ...options, forkFrom: claudeForkSource, identity: await engineIdentityForLaunch(workspaceId, result.cwd) })
        : startSuRpcEngine(result, binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' },
          { ...options, identity: await engineIdentityForLaunch(workspaceId, result.cwd) });
      state.engines.set(key, engine);
      observeReadiness(engine);
      // WI-10003879: recorded before the launch returns, so PUI's very first
      // snapshot poll on a sibling worker is already routed here.
      await recordSuSessionHostOwner(result.sessionId, localSuSessionHostOwner(), workspaceId);
      const unsupervise = superviseAttendance(result.sessionId, engine);
      trace?.stage('persist-descriptor');
      await persistSuSessionDescriptor(result.sessionId, engine.adapter.host.descriptor());
      const active = engine;
      // Launch publishes the durable identity; the existing host stream owns
      // bounded readiness and failure. Waiting here couples native startup to
      // the HTTP route's shorter watchdog and discards a valid launch as 408.
      trackExit(key, (async () => {
        try {
          await active.ready;
          await setAdvSessionPid(result.sessionId!, active.pid(), `pui-structured-${result.agent}`);
          await persistSuSessionDescriptor(result.sessionId!, active.adapter.host.descriptor());
          // done is initialized when the SDK actually starts. Reading it
          // before ready can observe the engine's pre-start placeholder.
          await active.done;
        } catch (error) {
          if (!active.adapter.host.snapshot().terminal) {
            active.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
          }
          await active.close();
          await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true });
        } finally {
          unsupervise();
          if (state.engines.get(key) === active) state.engines.delete(key);
        }
      })().catch((error: unknown) => console.warn('[su-session] engine exit bookkeeping failed', error)));
      return { status: 'ok', transport: 'structured', agent: result.agent, advSessionId: binding.advSessionId,
        ownerId: binding.ownerId, workspaceId: binding.workspaceId, harnessSlug: binding.harnessSlug,
        planSlug: binding.planSlug, nativeSession, ready: false };
    } catch (error) {
      await engine?.close();
      state.engines.delete(key);
      await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw error;
    }
  }
}
