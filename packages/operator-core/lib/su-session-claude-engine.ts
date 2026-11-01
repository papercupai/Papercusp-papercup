/** Structured Claude transport for the existing SU host. No PTY or native pane.
 * The maintained Agent SDK owns framing, streaming input and control requests;
 * Papercusp owns SU bootstrap, process enrollment and the session's lifecycle.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type Settings } from '@anthropic-ai/claude-agent-sdk';
import { applyDefaultClaudeOAuthToken, applyGithubTokenEnv, applyPsuClaudeSettingsArgs, assertLaunchPersona, enforceDefaultClaudeAccount, healContextTrimmingEnv, persistDefaultClaudeAuthSettings, persistPsuClaudeSessionSettings, prepareSuLaunch, recordSessionOwner, startSupervisorBeat } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { SuApprovalsMode } from '@papercusp/chat-protocol';
import { splitModelSpec } from './agent-config-constants';
import { resolveChildSessionOperatorBaseUrl } from './mcp-base-url';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { syncPersonalClaudeMemory } from './interactive-claude-config';
import type { PuiSuSessionBinding } from './launch-agent';
import { createClaudeSuSessionAdapter, type ClaudeNativeCommandVerdict, type ClaudeSuSessionAdapter, type ClaudeSuSessionDescriptorOptions, type ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from './task-manager/enroll-sync';
import { probeScopeSupport } from './task-manager/managed-spawn';
import { killTask } from './task-manager/control';
import type { TaskSpec } from './task-manager/types';
import { SuSessionStartupTimeoutError, type SuSessionHost, type SuSessionEventInput } from './su-session-host';
import { claudeModelOptions } from './su-session-engine-models';
import { SuNativeCards } from './su-session-native-cards';
import { loadSuOwnerTurnReceipts } from './su-session-commands';
import { prepareSuSessionInput, SuInputRefusal } from './su-session-input';
import { admitNativeIdentityInference } from './cupboard/identity-activation-gate-io';
import { prepareTrackedClaudeFork, type TrackedClaudeForkSource } from './su-session-tracked-claude-fork';
import { resolveMcpName } from '@papercusp/agent-mcp';
import { normalizeMcpName } from '@papercusp/tooldef/tool-projection';
import type { HostRequestPrincipalResolver } from './auth/require-principal';
import { nativeInstalledPerUseTurns } from './agent-tools/per-use-chokepoint';
import { buildClaudeMcpEntry } from './desktop-install/claude-integration';
import { readSuperuserToken } from './superuser-token';

export type ClaudeEngineQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'mcpServerStatus' | 'interrupt' | 'close'>
  // P-026: the streaming-input model switch. Optional so a peer without it
  // still runs; asking that peer to switch refuses the turn instead.
  & Partial<Pick<Query, 'setModel' | 'applyFlagSettings' | 'setPermissionMode'>>;

/** D-026: the Claude permission mode for one engine-neutral approvals mode.
 * There is no full-access mode: PUI never launches with
 * allowDangerouslySkipPermissions. */
export function claudePermissionMode(mode: SuApprovalsMode): 'default' | 'acceptEdits' | 'plan' {
  switch (mode) {
    case 'ask': return 'default';
    case 'auto-edit': return 'acceptEdits';
    case 'read-only': return 'plan';
  }
}

/** P-026: the SDK calls that move a running Claude session onto `spec`
 * (`model[:effort]`) before the next owner turn. Effort is applied through the
 * flag-settings layer, which is what `query({ effort })` sets at launch. */
export async function applyClaudeModelSwitch(sdk: ClaudeEngineQuery, spec: string): Promise<void> {
  const next = splitModelSpec(spec);
  if (!next.model) throw new Error(`"${spec}" names no model`);
  if (!sdk.setModel) throw new Error('This Claude connection cannot change model mid-session');
  await sdk.setModel(next.model);
  if (next.effort) {
    if (!sdk.applyFlagSettings) throw new Error('This Claude connection cannot change effort mid-session');
    await sdk.applyFlagSettings({ effortLevel: next.effort as NonNullable<Settings['effortLevel']> });
  }
}
/** Who the engine is (plan pui-chat-first-ux-2026-09-28 D-004). `su` is the
 * workspace superuser: the su playbook as a custom prompt, the psu hook set and
 * the papercusp-su tools. `coding-assistant` is Claude Code's own session for a
 * directory outside a registered checkout: its preset prompt, no hooks and no
 * MCP servers, so a greeting is answered as Claude Code would answer it. */
export type ClaudeEngineIdentity = 'su' | 'coding-assistant';
export interface ClaudeEngineOptions extends ClaudeSuSessionDescriptorOptions {
  host?: SuSessionHost<'claude'>;
  /** Host-local launch authority; never persisted or passed to the CLI. */
  resolveRequestPrincipal?: HostRequestPrincipalResolver;
  /** Defaults to `su`. */
  identity?: ClaudeEngineIdentity;
  resume?: boolean;
  /** Fresh tracked child only; the SDK forks history and registration gates ready. */
  forkFrom?: TrackedClaudeForkSource;
  /** Acceptance-only opt-in to the native permission request/card path. */
  toolApproval?: 'prompt';
  beforeReady?: (pid: number | null) => Promise<void>;
  startupTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  /** Silence on an in-flight owner turn that is reported as a stall. */
  turnStallTimeoutMs?: number;
  /** Inject the protocol peer in tests, not the host or its event translation. */
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeEngineQuery;
  register?: boolean;
  /** Join the authoritative session-end write before reporting closed. */
  onExit?: () => Promise<void>;
}
export interface ClaudeSuEngine {
  adapter: ClaudeSuSessionAdapter;
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Bytes of child stderr retained for diagnostics. A refusal arrives at the END
 * of the stream, so the OLDEST bytes are the ones dropped. */
export const CHILD_STDERR_TAIL_LIMIT = 4_000;

/** Child stderr is a user-facing channel, but the child also inherits an env
 * carrying OAuth tokens and PATs, and CLIs do echo argv/env on some failures.
 * Redact before anything reaches an event the transcript will persist. */
const STDERR_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\b(sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g, '$1[redacted]'],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/g, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|KEY))(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, '$1$2[redacted]'],
];

export function redactChildStderr(text: string): string {
  return STDERR_REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export interface ChildStderrTail {
  append(chunk: string | Uint8Array): void;
  /** The retained tail, redacted and trimmed; empty when the child wrote nothing. */
  read(): string;
}

/** Bounded, redacted retention of the child's own stderr.
 *
 * The engine used to DISCARD this channel entirely, which made a child that
 * refuses on stderr — a quota wall answers in ~5s with plain text and exits 1 —
 * indistinguishable from a silent hang, because every diagnostic the engine
 * emitted was derived from the protocol stream that child never reached
 * (EI-22963885533180534). Retaining a bounded tail is what makes the child's own
 * stated reason observable; the bound is what keeps a noisy child from growing
 * memory without limit. */
export function createChildStderrTail(limit = CHILD_STDERR_TAIL_LIMIT): ChildStderrTail {
  let buffered = '';
  return {
    append(chunk) {
      buffered += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (buffered.length > limit) buffered = buffered.slice(buffered.length - limit);
    },
    read() { return redactChildStderr(buffered).trim(); },
  };
}

/** Drain the child's stderr into the tail. The pipe must still be consumed or a
 * noisy child deadlocks its own protocol channels — retention replaces the old
 * discard, it does not stop the draining. */
export function attachChildStderr(stderr: NodeJS.ReadableStream | null | undefined, tail: ChildStderrTail): void {
  stderr?.on('data', (chunk: Buffer | string) => tail.append(chunk));
}

/** Suffix carrying the child's own words onto a transport diagnostic. */
export function childStderrSuffix(tail: string): string {
  return tail ? ` Last child stderr: ${tail}` : '';
}

export function formatStalledTurnMessage(idleMs: number, stderrTail: string): string {
  return `Claude produced no stream frame for ${Math.round(idleMs / 1000)}s and this owner turn has not ended.`
    + (stderrTail ? childStderrSuffix(stderrTail) : ' The child wrote nothing to stderr.');
}

/** D-021: the SU tools the connected server advertises read-only, in Claude's
 * permission-name form. The host capability_* family stays out so file and code
 * reads keep native approval parity; a tool listed later asks until reconnect. */
export function claudeReadOnlySuTools(server: {
  name: string; tools?: Array<{ name: string; annotations?: { readOnly?: boolean } }>;
}): Set<string> {
  const prefix = `mcp__${server.name}__`;
  return new Set((server.tools ?? []).filter((tool) => tool.annotations?.readOnly === true)
    .map((tool) => tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name)
    .filter((name) => !name.startsWith('capability_'))
    .map((name) => prefix + name));
}

/** D-022: only the exact owner-directive bookkeeping write may skip its card,
 * and only when the papercusp-su server explicitly advertises it as writable. */
export function claudeDirectiveDispositionSuTools(server: {
  name: string; tools?: Array<{ name: string; annotations?: { readOnly?: boolean } }>;
}): Set<string> {
  const qualifiedName = 'mcp__papercusp-su__orders_disposition';
  if (server.name !== 'papercusp-su') return new Set();
  const advertised = (server.tools ?? []).filter((tool) =>
    tool.name === 'orders_disposition' || tool.name === qualifiedName);
  if (advertised.length !== 1 || advertised[0].annotations?.readOnly !== false) return new Set();
  return new Set([qualifiedName]);
}

/** psu-isolation D-002: a playbook that splices the project guide delivers it
 * itself, so project-memory auto-load must not send the same CLAUDE.md again
 * (measured: a second 39k-token copy on every full-tier launch). Returns each
 * memory file Claude would auto-load from `cwd` upward whose whole text the
 * prompt already holds; a truncated or since-edited guide stays loaded. */
export function claudeMemoryFilesInPrompt(cwd: string, systemPrompt: string): string[] {
  const found = new Set<string>();
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const file = join(dir, name);
      let body: string;
      try { body = readFileSync(file, 'utf8').trim(); } catch { continue; }
      if (body && systemPrompt.includes(body)) { found.add(file); found.add(realpathSync(file)); }
    }
    if (dirname(dir) === dir) return [...found];
  }
}

export function startClaudeSuEngine(
  boot: BootstrapSuResult,
  binding: PuiSuSessionBinding & { backend: 'claude' },
  runtime: ClaudeSuRuntimeBinding,
  options: ClaudeEngineOptions,
): ClaudeSuEngine {
  const nativeId = runtime.nativeSession.sessionId;
  if (options.forkFrom && options.resume) throw new Error('Claude fork and exact resume are mutually exclusive');
  if (boot.agent !== 'claude' || boot.sessionId !== binding.advSessionId || boot.nativeSessionId !== nativeId
    || boot.workspaceId !== binding.workspaceId || boot.harnessSlug !== binding.harnessSlug
    || boot.envelopeEnv.PAPERCUSP_SID !== binding.ownerId) {
    throw new Error('Structured Claude bootstrap does not match the durable SU identity');
  }
  assertLaunchPersona(boot.promptFile);
  const preparation = prepareSuLaunch(boot, {
    model: options.model, executionKind: 'programmatic', accountRoute: options.accountRoute,
    nativeSessionId: nativeId,
  });
  const input = new PassThrough({ objectMode: true });
  const abortController = new AbortController();
  // Readiness uses the SDK's actual control responses. A transcript-only
  // shouldQuery:false append does not promise any output receipt or result;
  // using one as a probe deadlocks before the first owner turn. Native event
  // identity remains checked on every frame, including the first system/init.
  let ready = false;
  let closed = false;
  let processId: number | null = null;
  let processTaskId: string | null = null;
  let processRegistration: Promise<void> | null = null;
  let processExit: Promise<void> = Promise.resolve();
  let heartbeat: ManagedHandle | undefined;
  let sdk: ClaudeEngineQuery;
  let inputTail = Promise.resolve();
  let interruptInFlight: Promise<ClaudeNativeCommandVerdict> | undefined;
  let interruptFailure: ClaudeNativeCommandVerdict | undefined;
  // Include the head while admission/configuration is pending, before it has
  // a native input UUID. Interrupt cancels that delivery, never later inputs.
  const deliveries: Array<{ interrupted: boolean }> = [];
  let activeInputUuid: string | undefined;
  let activeOwnerTurnId: string | undefined;
  let nativeInputEpoch = 0;
  let nativeInputOpen = false;
  let nativeInputScope: ReturnType<typeof nativeInstalledPerUseTurns.registerNativeInput> | undefined;
  let privateMcpServer: Awaited<ReturnType<typeof import('./su-session-claude-mcp').createClaudeNativeMcpServer>> | undefined;
  const observedNativeCalls = new Set<string>();
  const nativeCallWaiters = new Map<string, Set<(observed: boolean) => void>>();
  let nativeTools: Readonly<Record<string, string>> = Object.freeze(Object.create(null));
  const withdrawNativeInput = () => {
    nativeInputEpoch++;
    nativeInputOpen = false;
    observedNativeCalls.clear();
    for (const waiters of nativeCallWaiters.values()) for (const done of waiters) done(false);
    nativeCallWaiters.clear();
    const scope = nativeInputScope;
    nativeInputScope = undefined;
    // withdraw() tombstones synchronously, before any awaited cleanup.
    return scope?.withdraw();
  };
  const beforeNativeToolCall = (callId: string, signal: AbortSignal): Promise<boolean> => {
    if (!nativeInputOpen || closed || !ownsRuntime() || signal.aborted || !/^[A-Za-z0-9._:-]{1,256}$/.test(callId)) return Promise.resolve(false);
    if (observedNativeCalls.has(callId)) return Promise.resolve(true);
    if (nativeCallWaiters.size >= 1000) return Promise.resolve(false);
    return new Promise(done => {
      const finish = (observed: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        const waiting = nativeCallWaiters.get(callId); waiting?.delete(finish);
        if (waiting?.size === 0) nativeCallWaiters.delete(callId);
        done(observed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 2_000);
      const waiting = nativeCallWaiters.get(callId) ?? new Set();
      waiting.add(finish); nativeCallWaiters.set(callId, waiting);
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  // Filled once the SU tool connection is up; until then every request asks.
  let readOnlySuTools = new Set<string>();
  let directiveDispositionSuTools = new Set<string>();
  const acceptNativeTools = (tools: Array<{ name: string; annotations?: { readOnly?: boolean } }>) => {
    const server = { name: 'papercusp-su', tools };
    readOnlySuTools = claudeReadOnlySuTools(server);
    directiveDispositionSuTools = claudeDirectiveDispositionSuTools(server);
    const names: Record<string, string> = Object.create(null);
    for (const tool of tools) {
      const prefix = 'mcp__papercusp-su__';
      const advertised = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
      // Claude presents canonical MCP names (e.g. reports:get) to the model
      // with unsupported name characters replaced by underscores. Keep the
      // exact observed-call key in that native spelling, while registry
      // resolution still refuses ambiguous separator aliases.
      const name = prefix + advertised.replace(/[^a-zA-Z0-9_-]/g, '_');
      const canonical = resolveMcpName(normalizeMcpName(name))?.expose.mcp?.name;
      if (canonical) names[name] = canonical;
    }
    nativeTools = Object.freeze(names);
  };
  // Whether the active owner turn has produced any assistant frame. A turn that
  // ends having produced none is reported, never left to read as an answer.
  let activeTurnSawAssistant = false;
  // Set when the owner interrupts the active turn. Claude then ends that turn
  // with an `error_during_execution` result whose `errors` carry CLI
  // diagnostics ("[ede_diagnostic] …"); that is the interrupt landing, not a
  // failed turn, so it must not be reported as one (P-032).
  let activeTurnInterrupted = false;
  let finishActiveTurn: (() => void) | undefined;
  const pending = new Map<string, ReturnType<typeof deferred<ClaudeNativeCommandVerdict>>>();
  // P-026: the spec the session runs on, so a turn naming it again is no switch.
  let currentModel = options.model ?? null;
  // D-026: a prompted launch runs in permissionMode 'default', which is `ask`.
  let currentApprovals: SuApprovalsMode | undefined = options.toolApproval === 'prompt' ? 'ask' : undefined;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 30_000;
  // A turn that never ENDS emits no result frame, and BOTH existing detectors —
  // claude_turn_failed and claude_empty_turn — are nested under one, so neither
  // can report it. This watchdog is the detector for that third case. It is
  // observability ONLY: it never fails the turn, interrupts it, or resolves its
  // receipt; the delivery timeout and the owner remain the deciders.
  const turnStallTimeoutMs = options.turnStallTimeoutMs ?? 90_000;
  const childStderr = createChildStderrTail();
  let lastFrameAt = Date.now();
  let stallWatch: ManagedHandle | undefined;
  let stallReported = false;
  // Permission requests whose approval card is open. While one is open the turn
  // is waiting on the owner, not stalled: Claude sends no frames until it gets
  // an answer (P-028 probe 13 reported a false 114s stall under an open card).
  let awaitingOwnerAnswers = 0;
  function armStallWatch() {
    lastFrameAt = Date.now();
    stallReported = false;
    // Reported once per turn: a stall does not resolve on its own, so repeating
    // would bury the transcript without adding an observation.
    // D-004: 'timeout-reaper' — the passage of time IS the trigger here. The body
    // does nothing but compare idleMs against turnStallTimeoutMs, i.e. a deadline
    // check, which the doc lists as the definitive timeout-reaper shape. There is no
    // "turn went quiet" event to subscribe to: silence is the signal.
    stallWatch ??= managedSetInterval('su-session-claude-turn-stall',
      Math.max(50, Math.round(turnStallTimeoutMs / 3)), () => {
        if (closed || !ownsRuntime() || stallReported || !activeInputUuid || awaitingOwnerAnswers > 0) return;
        const idleMs = Date.now() - lastFrameAt;
        if (idleMs < turnStallTimeoutMs) return;
        stallReported = true;
        adapter.host.emit({
          type: 'error', scope: 'transport', code: 'claude_turn_stalled', recoverable: true,
          message: formatStalledTurnMessage(idleMs, childStderr.read()),
        });
      }, { category: 'liveness', instanced: true, classification: 'timeout-reaper' });
  }
  function disarmStallWatch() { stallWatch?.stop(); stallWatch = undefined; }
  const unavailable = (message: string): ClaudeNativeCommandVerdict => ({
    ok: false, code: 'engine_delivery_unknown', message, retryable: false,
  });
  const adapter = createClaudeSuSessionAdapter(binding, runtime, {
    ...options, executionKind: 'programmatic', typedInput: true, ready: false, runtimeReady: () => ready && !closed, ownerTurnCorrelation: 'transport', cardSource: 'transport',
    resultErrorSource: 'transport',
    ...(currentApprovals ? { approvals: currentApprovals } : {}),
    ownerTurnReceipts: (identity) => loadSuOwnerTurnReceipts(identity),
    controls: {
      async ownerTurn({ content, input: richInput, turnId, model: nextModel, approvals: nextApprovals }) {
        if (!ready || closed || !ownsRuntime()) return unavailable('The structured Claude connection is not ready');
        const uuid = randomUUID();
        const receipt = deferred<ClaudeNativeCommandVerdict>();
        pending.set(uuid, receipt);
        const delivery = { interrupted: false };
        deliveries.push(delivery);
        const deliveryStopped = () => {
          if (delivery.interrupted) {
            receipt.resolve({ ok: false, code: 'turn_interrupted', retryable: false,
              message: 'The owner interrupted this turn before native delivery' });
            return true;
          }
          if (closed || !ownsRuntime()) { receipt.resolve(unavailable('Claude closed or was replaced before this saved turn was sent')); return true; }
          return false;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        inputTail = inputTail.then(async () => {
          // The interrupted result can arrive before the SDK control receipt.
          // A follow-up must wait for both boundaries on this same session.
          await interruptInFlight;
          if (deliveryStopped()) return;
          if (interruptFailure) { receipt.resolve(interruptFailure); return; }
          if (su) {
            if (!binding.workspaceId || !binding.ownerId) {
              receipt.resolve(unavailable('Native admission requires the authenticated workspace and owner')); return;
            }
            const admission = await admitNativeIdentityInference({ workspaceId: binding.workspaceId,
              ownerId: binding.ownerId, backend: 'claude' });
            if (deliveryStopped()) return;
            if (!admission.ok) { receipt.resolve(admission); return; }
          }
          // P-026: switch in the input order, after any earlier queued turn has
          // finished (so it never changes the model under that turn) and before
          // this one is written (so a refused switch refuses this turn instead
          // of running it on a model the owner did not pick).
          if (nextModel && nextModel !== currentModel) {
            try {
              await applyClaudeModelSwitch(sdk, nextModel);
            } catch (error) {
              receipt.resolve({ ok: false, code: 'model_switch_refused', retryable: false,
                liftsWhen: 'Send a new turn with a model and effort supported by this connection, omit the model override, or start a new session with the requested model.',
                message: `Could not switch to ${nextModel}: ${error instanceof Error ? error.message : String(error)}` });
              return;
            }
            if (deliveryStopped()) return;
            currentModel = nextModel;
            adapter.host.updateModel(nextModel);
            if (deliveryStopped()) return;
          }
          // D-026: the approvals switch follows the same order and refusal rule.
          if (nextApprovals && nextApprovals !== currentApprovals) {
            try {
              if (!sdk.setPermissionMode) throw new Error('This Claude connection cannot change permission mode mid-session');
              await sdk.setPermissionMode(claudePermissionMode(nextApprovals));
            } catch (error) {
              receipt.resolve({ ok: false, code: 'approvals_switch_refused', retryable: false,
                liftsWhen: 'Send a new turn without an approvals override, or start a new Claude session with the requested approvals mode.',
                message: `Could not switch approvals to ${nextApprovals}: ${error instanceof Error ? error.message : String(error)}` });
              return;
            }
            if (deliveryStopped()) return;
            currentApprovals = nextApprovals;
            adapter.host.updateApprovals(nextApprovals);
            if (deliveryStopped()) return;
          }
          // Resolve references after admission/model/permission waits, at the
          // serialized native write boundary. Earlier validation can go stale.
          let prepared: Awaited<ReturnType<typeof prepareSuSessionInput>>;
          try {
            prepared = await prepareSuSessionInput({ content, input: richInput }, { workspaceId: boot.workspaceId, root: boot.cwd });
          } catch (error) {
            if (!(error instanceof SuInputRefusal)) throw error;
            receipt.resolve({ ok: false, code: error.code, message: error.message, retryable: false });
            return;
          }
          if (deliveryStopped()) return;
          const finished = deferred<void>();
          finishActiveTurn = () => finished.resolve();
          adapter.correlateOwnerTurn(turnId);
          activeOwnerTurnId = turnId;
          activeInputUuid = uuid;
          nativeInputOpen = true;
          activeTurnSawAssistant = false;
          activeTurnInterrupted = false;
          armStallWatch();
          try {
            timer = setTimeout(() => receipt.resolve(unavailable('Claude did not acknowledge this saved turn; reconcile delivery before retrying')), deliveryTimeoutMs);
            input.write({ type: 'user', uuid, session_id: nativeId, parent_tool_use_id: null,
              origin: { kind: 'human' }, message: { role: 'user', content: prepared.claude } } satisfies SDKUserMessage);
            await finished.promise;
          } finally {
            await withdrawNativeInput();
            disarmStallWatch();
            activeInputUuid = undefined;
            activeOwnerTurnId = undefined;
            finishActiveTurn = undefined;
          }
        }).catch((error: unknown) => receipt.resolve(unavailable(String(error))))
          .finally(() => { deliveries.shift(); });
        try {
          return await receipt.promise;
        } finally { clearTimeout(timer); pending.delete(uuid); }
      },
      async interrupt() {
        if (interruptInFlight) return interruptInFlight;
        if (interruptFailure) return interruptFailure;
        if (deliveries[0] && !activeInputUuid) {
          deliveries[0].interrupted = true;
          cards.cancel();
          return { ok: true };
        }
        const request = (async (): Promise<ClaudeNativeCommandVerdict> => {
          if (activeInputUuid) activeTurnInterrupted = true;
          await withdrawNativeInput();
          cards.cancel();
          try {
            await sdk.interrupt();
            return { ok: true };
          } catch (error) {
            interruptFailure = unavailable(`Claude interrupt acknowledgement is unknown; reconcile before sending a follow-up: ${String(error)}`);
            return interruptFailure;
          }
        })();
        interruptInFlight = request;
        try { return await request; }
        finally { if (interruptInFlight === request) interruptInFlight = undefined; }
      },
      async resume() { return ready && !closed ? { ok: true } : unavailable('Reconnect the structured Claude runtime before resuming'); },
      async focus() { return { ok: true }; },
      async end() { await close(); return { ok: true }; },
    },
  });
  // The host survives reconnects. This engine's delayed work belongs only to
  // the generation it attached, including the session-wide end callback.
  const runtimeGeneration = adapter.host.descriptor().runtimeGeneration;
  function ownsRuntime(): boolean { return adapter.host.descriptor().runtimeGeneration === runtimeGeneration; }
  const cards = new SuNativeCards(boot.workspaceId, `pui-native:${binding.advSessionId}:${options.runtimeGeneration ?? 0}`, (event) => {
    if (!ownsRuntime()) return;
    adapter.host.emit(event as SuSessionEventInput<'claude'>);
    if (event.type === 'card' && !closed && !adapter.host.snapshot().terminal) {
      adapter.host.transition(event.phase === 'opened' ? 'waiting-for-owner' : 'running', 'Claude native question');
    }
  }, {
    cwd: boot.cwd,
    // D-028: option 2 on an edit switched Claude to accept-edits for the
    // session, which is the auto-edit approvals mode (D-026).
    approvalsChanged: (mode) => { if (ownsRuntime()) { currentApprovals = mode; adapter.host.updateApprovals(mode); } },
  });
  const flagValue = (flag: string) => {
    const at = preparation.modelArgs.indexOf(flag);
    return at < 0 ? undefined : preparation.modelArgs[at + 1];
  };
  const model = { model: flagValue('--model'), effort: flagValue('--effort') };
  const launch = preparation;
  const su = (options.identity ?? 'su') === 'su';
  const systemPrompt = su ? readFileSync(boot.promptFile, 'utf8') : null;
  const env = preparation.env;
  // The per-session SessionStart hook otherwise mistakes the SDK initialize
  // channel for a dropped argv prompt and injects the full parked playbook as
  // additionalContext on every start/resume.
  env.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED = '1';
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
  env.DISABLE_AUTOUPDATER = '1';
  // WI-6554700010008332: the child's MCP and turn-end hooks follow agent routing, so a session
  // the background host runs reaches the live proxy instead of the busy :3271 main thread.
  env.PAPERCUSP_OPERATOR_URL = resolveChildSessionOperatorBaseUrl();
  // The user-level papercusp-su MCP url expands ${PAPERCUSP_TOOLS:-}; psu's CLI
  // sets it, but this engine has no psu process. Unset, the server advertises
  // the whole catalog: measured 941 tools and a 255k-token first call, which
  // autocompacted on every turn under a 200k window.
  healContextTrimmingEnv(env, 'claude');
  enforceDefaultClaudeAccount('claude', env);
  applyDefaultClaudeOAuthToken('claude', env);
  // The same per-launch overlay runWrapper prepends: default-account auth on an
  // explicit route plus the per-session settings (idleCompaction:false, D-004).
  const launchSettings = applyPsuClaudeSettingsArgs('claude', [], env);
  const settings: Settings = launchSettings[0] === '--settings' ? JSON.parse(launchSettings[1]) : {};
  if (systemPrompt) {
    const guidesInPrompt = claudeMemoryFilesInPrompt(boot.cwd, systemPrompt);
    if (guidesInPrompt.length) settings.claudeMdExcludes = [...(settings.claudeMdExcludes ?? []), ...guidesInPrompt];
  } else {
    // The per-session config dir carries the psu hook set (orientation,
    // provenance and memory injection, mid-turn context, work-item nudges).
    // Flag settings outrank that user layer, so this one key silences them all.
    settings.disableAllHooks = true;
  }
  // The on-disk per-session settings are also used on native exact resume.
  if (!options.query) {
    persistDefaultClaudeAuthSettings({ wrapperBin: 'claude', env });
    persistPsuClaudeSessionSettings({ wrapperBin: 'claude', env });
    applyGithubTokenEnv(env);
    recordSessionOwner(nativeId, binding.ownerId, { advSessionId: binding.advSessionId });
    // Claude Code's own agent reads the user's personal CLAUDE.md like stock
    // `claude`; the psu persona never does (interactive-claude-config.ts).
    if (env.CLAUDE_CONFIG_DIR) syncPersonalClaudeMemory(env.CLAUDE_CONFIG_DIR, !su, env.HOME || undefined);
  }
  // Reuse the launcher's deny policy as well as its environment sanitizer.
  const disallowedTools = launch.args.filter((a): a is string => typeof a === 'string' && a.startsWith('--disallowedTools='))
    .flatMap(a => a.slice('--disallowedTools='.length).split(','));
  const sdkOptions: Options = {
    cwd: boot.cwd,
    env,
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(options.resume ? { resume: nativeId } : { sessionId: nativeId }),
    includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    ...(options.toolApproval === 'prompt'
      ? { permissionMode: 'default' as const }
      : { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }),
    canUseTool(toolName, input, permission) {
      if (closed || !ownsRuntime() || !activeOwnerTurnId) return Promise.resolve({ behavior: 'deny', message: 'Claude has no active PUI owner turn for this permission request' });
      // D-021 allows advertised read-only SU tools; D-022 adds only the exact
      // owner directive disposition write. A user ask rule always forces the card.
      if ((readOnlySuTools.has(toolName) || directiveDispositionSuTools.has(toolName))
        && !permission.matchedAskRule) {
        return Promise.resolve({ behavior: 'allow', updatedInput: input });
      }
      // The stall clock restarts once the owner answers.
      awaitingOwnerAnswers += 1;
      return cards.handleClaude(toolName, input, activeOwnerTurnId, permission).finally(() => {
        awaitingOwnerAnswers -= 1;
        lastFrameAt = Date.now();
      });
    },
    disallowedTools,
    onElicitation(request, elicitation) {
      if (closed || !ownsRuntime() || !activeOwnerTurnId) return Promise.resolve({ action: 'cancel' });
      awaitingOwnerAnswers += 1;
      return cards.handleClaudeElicitation(request, activeOwnerTurnId, elicitation).finally(() => {
        awaitingOwnerAnswers -= 1;
        lastFrameAt = Date.now();
      });
    },
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort as Options['effort'] } : {}),
    abortController,
    ...(systemPrompt
      ? {
        // Record the exact custom SU persona once per native conversation. On an
        // exact resume the SDK then reuses that record verbatim instead of applying
        // the large prompt file afresh on top of the restored conversation.
        systemPrompt: { type: 'custom' as const, prompt: systemPrompt, snapshot: true },
        extraArgs: { 'exclude-dynamic-system-prompt-sections': null, 'replay-user-messages': null },
      }
      : {
        // Claude Code's own prompt, dynamic sections (cwd, git state, date)
        // included, and only the MCP servers passed here: none, so neither the
        // Papercusp tools nor that server's orientation instructions load.
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        strictMcpConfig: true,
        mcpServers: {},
        extraArgs: { 'replay-user-messages': null },
      }),
    spawnClaudeCodeProcess(spawnOptions) {
      const spec: TaskSpec = {
        class: 'agent-session', title: 'PUI Claude structured engine', launchedBy: 'pui-su-session',
        sessionId: nativeId, harnessSlug: binding.harnessSlug, planSlug: binding.planSlug,
        detail: { coordOwnerId: binding.ownerId, advSessionId: binding.advSessionId, transport: 'structured' },
        argv: [spawnOptions.command, ...spawnOptions.args], cwd: boot.cwd,
      };
      const enrollment = beginSyncEnrolment(spec);
      processTaskId = enrollment.taskId;
      const wrapped = enrollment.wrap(spawnOptions.command, spawnOptions.args, spawnOptions.env, boot.cwd);
      const child = spawn(wrapped.binary, wrapped.argv, {
        cwd: boot.cwd, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'pipe'], signal: spawnOptions.signal,
      });
      processId = child.pid ?? null;
      completeSyncEnrolment(enrollment, spec, processId, { workspaceId: boot.workspaceId });
      processRegistration = enrollment.registrationReady;
      const exited = deferred<void>();
      processExit = exited.promise;
      if (processId) startSupervisorBeat(binding.ownerId, {
        pid: processId, operatorUrl: env.PAPERCUSP_OPERATOR_URL,
        onTerminalSession: () => { void close().catch((error) => console.warn('[su-session] terminal engine cleanup failed', error)); },
        setIntervalImpl: (callback: () => void, ms: number) => {
          // D-004: 'must-sample' — proves the engine PROCESS is still alive, and no
          // event source exists to subscribe to for that (the doc names PID liveness
          // as the canonical must-sample case). A dead process emits nothing, which
          // is exactly why its absence can only be sampled.
          heartbeat = managedSetInterval('su-session-engine-heartbeat', ms, callback, { category: 'liveness', instanced: true, classification: 'must-sample' });
          return {};
        },
      });
      // Drain stderr so a noisy child cannot deadlock its protocol pipes, and
      // RETAIN a bounded redacted tail. A child that refuses on its own stderr —
      // a quota wall answers in ~5s and exits 1 — never reaches the protocol
      // stream, so discarding this channel left that refusal unobservable
      // everywhere (EI-22963885533180534).
      attachChildStderr(child.stderr, childStderr);
      child.once('close', (exitCode, signal) => {
        heartbeat?.stop();
        wrapped.release?.();
        finishSyncEnrolment(enrollment, { state: signal ? 'killed' : 'exited', exitCode, exitReason: signal });
        exited.resolve();
      });
      return child;
    },
  };
  let done: Promise<void> = Promise.resolve();
  async function waitForExit(ms: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([processExit.then(() => true), new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timeout!); }
  }
  async function stopChild(): Promise<void> {
    if (await waitForExit(5_000)) return;
    await processRegistration;
    if (!processTaskId) throw new Error('Claude child did not close and has no tracked teardown handle');
    const result = await killTask(processTaskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
    if (!result.ok && result.error !== 'already_gone') throw new Error(`Claude tracked teardown failed: ${result.error}`);
    if (!(await waitForExit(5_000))) throw new Error('Claude child did not exit after tracked teardown');
  }
  async function close(): Promise<void> {
    if (!closed) {
      closed = true; ready = false;
      await withdrawNativeInput();
      cards.cancel();
      heartbeat?.stop();
      disarmStallWatch();
      for (const receipt of pending.values()) receipt.resolve(unavailable('Claude connection closed before acknowledgement'));
      finishActiveTurn?.();
      input.end(); sdk?.close(); abortController.abort();
    }
    await done;
    await privateMcpServer?.close();
    await stopChild();
  }
  // A single deadline covers several independent resume steps. Retain the
  // current step so a timeout identifies the stalled boundary without logging
  // credentials, transcript content, or child argv.
  let startupStage = 'scope probe';
  let stageStartedAt = Date.now();
  const enterStartupStage = (stage: string) => { startupStage = stage; stageStartedAt = Date.now(); };
  const startup = (async () => {
    if (!options.query) await probeScopeSupport();
    if (closed || !ownsRuntime()) throw new Error('Claude startup was cancelled or replaced');
    let fork: Awaited<ReturnType<typeof prepareTrackedClaudeFork>> | undefined;
    if (options.forkFrom) {
      if (!runtime.nativeSession.configDir) throw new Error('Claude child configuration is unavailable');
      enterStartupStage('tracked fork preparation');
      fork = await prepareTrackedClaudeFork({ source: options.forkFrom, workspaceId: boot.workspaceId,
        cwd: boot.cwd, childAdvSessionId: binding.advSessionId, childOwnerId: binding.ownerId!,
        childNativeSessionId: nativeId, childConfigDir: runtime.nativeSession.configDir });
      Object.assign(sdkOptions, { resume: options.forkFrom.nativeSession.sessionId!, forkSession: true, sessionId: nativeId });
    }
    try {
    if (closed || !ownsRuntime()) throw new Error('Claude fork preparation was cancelled or replaced');
    if (options.resume) {
      // WI-10004162: show the saved conversation now, not after the SDK launch,
      // its initialization and the SU tool connection (seconds, or never when
      // startup fails). Best-effort: the replay after the SU tool connection
      // stays authoritative, adds only what the native runtime wrote since, and
      // surfaces a missing transcript; the host never shows a record twice.
      enterStartupStage('transcript restore');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true }).catch(() => undefined);
      if (closed || !ownsRuntime()) throw new Error('Claude connection closed or was replaced during startup');
    }
    enterStartupStage('SDK launch');
    const token = su && options.resolveRequestPrincipal ? readSuperuserToken() : null;
    if (su && token && options.resolveRequestPrincipal) {
      // Reuse the issuer and maintained config. Credentials never enter the
      // child environment, argv, a file or a persisted session descriptor.
      const principal = await options.resolveRequestPrincipal();
      if (principal) {
        const { provisionNativeRuntimeBearer } = await import('@papercusp/agent-mcp/provisioning');
        const issued = await provisionNativeRuntimeBearer({ workspaceId: boot.workspaceId,
          advSessionId: binding.advSessionId, issuer: principal }).catch(() => null);
        if (issued?.binding.provider === 'claude' && issued.binding.ownerId === binding.ownerId
          && issued.binding.workspaceId === boot.workspaceId && issued.binding.advSessionId === binding.advSessionId) {
          const entry = buildClaudeMcpEntry(env.PAPERCUSP_OPERATOR_URL!, token, binding.ownerId!, '');
          const values: NodeJS.ProcessEnv = { ...env, PAPERCUSP_SID: binding.ownerId!, PAPERCUSP_WORKSPACE: boot.workspaceId,
            PAPERCUSP_HARNESS_SLUG: binding.harnessSlug ?? '', PAPERCUSP_NATIVE_SESSION_ID: nativeId,
            CLAUDE_CODE_SESSION_ID: nativeId };
          const expand = (value: string) => value.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g,
            (_match, key: string, fallback: string) => values[key] || fallback);
          const { createClaudeNativeMcpServer } = await import('./su-session-claude-mcp');
          privateMcpServer = await createClaudeNativeMcpServer({ url: expand(entry.url),
            headers: Object.fromEntries(Object.entries(entry.headers).map(([key, value]) => [key.toLowerCase(), expand(value)])),
            runtimeBearer: issued.bearer, beforeToolCall: beforeNativeToolCall, onToolsListed: acceptNativeTools });
          sdkOptions.mcpServers = { 'papercusp-su': { type: 'sdk', name: 'papercusp-su', instance: privateMcpServer } };
        }
      }
    }
    if (closed || !ownsRuntime()) { await privateMcpServer?.close(); throw new Error('Claude startup was cancelled or replaced'); }
    sdk = (options.query ?? query)({ prompt: input, options: sdkOptions });
    done = (async () => {
      try {
        for await (const event of sdk) {
          if (!ownsRuntime()) break;
          // ANY frame is progress. The watchdog measures SILENCE, not the absence
          // of a reply — a long tool call streams frames and is not a stall.
          lastFrameAt = Date.now();
          // A terminal result closes the native turn before account-route
          // provenance is refreshed below. That reader can await the gateway
          // for up to 1.5s; it must not leave the silence watchdog armed during
          // that post-turn bookkeeping window.
          if (event.type === 'result') {
            await withdrawNativeInput();
            disarmStallWatch();
          }
          if (!ownsRuntime()) break;
          if ('session_id' in event && event.session_id && event.session_id !== nativeId) {
            throw new Error('Claude stream identity differs from the bootstrapped session');
          }
          if (event.type === 'system' && event.subtype === 'init'
            && (event.session_id !== nativeId || resolve(event.cwd) !== resolve(boot.cwd))) {
            throw new Error('Claude startup identity or project does not match');
          }
          if (event.type === 'user' && event.uuid) pending.get(event.uuid)?.resolve({ ok: true });
          // Delivery receipts/status/assistant IDs are not accepted-input
          // authority. Only this exact root replay can publish a capture scope.
          if (event.type === 'user' && event.uuid === activeInputUuid && activeOwnerTurnId
            && event.session_id === nativeId && event.parent_tool_use_id === null
            && nativeInputOpen && !closed && !activeTurnInterrupted && !nativeInputScope && options.resolveRequestPrincipal) {
            const epoch = nativeInputEpoch, inputId = activeInputUuid, ownerTurnId = activeOwnerTurnId;
            const principal = await options.resolveRequestPrincipal();
            if (principal && principal.workspaceId === boot.workspaceId && ['trusted', 'verified'].includes(principal.trust)
              && nativeInputOpen && !closed && ownsRuntime() && !activeTurnInterrupted && epoch === nativeInputEpoch
              && inputId === activeInputUuid && ownerTurnId === activeOwnerTurnId) {
              nativeInputScope = nativeInstalledPerUseTurns.registerNativeInput({ provider: 'claude',
                nativeInputId: inputId!, nativeSessionId: nativeId, ownerTurnId,
                workspaceId: boot.workspaceId, ownerId: binding.ownerId!, advSessionId: binding.advSessionId,
                principalId: principal.slug, mcpServer: 'papercusp-su', nativeTools,
                resolveRequestPrincipal: options.resolveRequestPrincipal });
            }
          }
          if (event.type === 'assistant' && event.session_id === nativeId && event.parent_tool_use_id === null
            && nativeInputScope && activeInputUuid && !closed && !activeTurnInterrupted) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use' && Object.hasOwn(nativeTools, block.name)) {
                await nativeInputScope.observeToolCall({ nativeSessionId: nativeId, nativeInputId: activeInputUuid,
                  server: 'papercusp-su', callId: block.id, tool: block.name, arguments: block.input });
                if (nativeInputOpen && !closed && ownsRuntime() && !activeTurnInterrupted) {
                  observedNativeCalls.add(block.id);
                  for (const done of nativeCallWaiters.get(block.id) ?? []) done(true);
                }
              }
            }
          }
          // The SDK can begin the root API request before it replays the input
          // or starts an assistant message. The live CLI does not guarantee
          // that a status message's UUID echoes the submitted input UUID. The
          // stream is session-bound and owner inputs are serialized, so a
          // same-session `requesting` status while one root input is active is
          // already a positive delivery receipt for that exact owner turn.
          if (event.type === 'system' && event.subtype === 'status' && event.status === 'requesting'
            && event.session_id === nativeId && activeInputUuid) {
            pending.get(activeInputUuid)?.resolve({ ok: true });
          }
          // Native input replay can arrive only after a long response. The
          // root model response starting also proves this serialized input
          // reached Claude; it does not mean the turn has finished.
          if (event.type === 'stream_event') {
            if (event.session_id === nativeId && event.parent_tool_use_id === null
              && event.event.type === 'message_start' && event.event.message.role === 'assistant'
              && event.event.message.id && activeInputUuid) {
              pending.get(activeInputUuid)?.resolve({ ok: true });
            }
            // The adapter projects partial text immediately and reconciles
            // each canonical block without duplicating the streamed content.
          }
          // Any assistant frame — a canonical message or the start of a streamed
          // one — is content for this turn. A turn with neither is empty.
          if ((event.type === 'assistant' && event.session_id === nativeId)
            || (event.type === 'stream_event' && event.session_id === nativeId
              && event.parent_tool_use_id === null
              && event.event.type === 'message_start' && event.event.message.role === 'assistant')) {
            activeTurnSawAssistant = true;
          }
          adapter.ingestNativeLine(JSON.stringify(event));
          if (event.type === 'result') {
            // The result is the turn's own verdict and it can report failure:
            // an error subtype, or `is_error` on a success frame whose `result`
            // carries the API error text instead of a reply. Dropping that
            // leaves a failed turn indistinguishable from an answered one — an
            // unavailable account pool ends the turn here with no assistant
            // frame and nothing else to observe. Report it as an error; a turn
            // that produced nothing at all is reported rather than inferred.
            if (activeInputUuid) {
              if (activeTurnInterrupted && event.subtype === 'error_during_execution') {
                // The owner's interrupt landed; the turn stopped as asked.
              } else if (event.is_error || event.subtype !== 'success') {
                const detail = event.subtype === 'success' ? event.result : event.errors.join('; ');
                adapter.host.emit({
                  type: 'error', scope: 'transport', code: 'claude_turn_failed', recoverable: true,
                  message: `Claude ended this turn without a usable reply (${event.subtype}${event.stop_reason ? `, stop reason ${event.stop_reason}` : ''})${detail ? `: ${detail}` : ''}${childStderrSuffix(childStderr.read())}`,
                });
              } else if (!activeTurnSawAssistant) {
                adapter.host.emit({
                  type: 'error', scope: 'transport', code: 'claude_empty_turn', recoverable: true,
                  message: `Claude completed this turn without sending any assistant content; the turn produced no reply.${childStderrSuffix(childStderr.read())}`,
                });
              }
              // The gateway resolves the account that actually served this
              // native turn outside Claude's transcript. Read it only after
              // Claude has emitted its terminal result (success or failure),
              // so the descriptor never claims a route before inference has
              // settled and the command receipt is not completed first.
              await adapter.refreshAccountServed();
            }
            finishActiveTurn?.();
          }
        }
        if (!closed && ownsRuntime()) throw new Error('Claude event stream closed unexpectedly');
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (!closed && ownsRuntime()) {
          adapter.host.emit({ type: 'error', scope: 'transport', code: 'claude_stream_failed', message: `${cause.message}${childStderrSuffix(childStderr.read())}`, recoverable: true });
          adapter.reconcileRuntimeExit({ expected: false, reason: cause.message });
          closed = true; ready = false; cards.cancel(); input.end(); sdk.close(); abortController.abort();
        }
      } finally {
        if (!ownsRuntime()) {
          closed = true; ready = false;
          cards.cancel(); heartbeat?.stop(); disarmStallWatch();
          input.end(); sdk.close(); abortController.abort();
        }
        await withdrawNativeInput();
        await privateMcpServer?.close();
        for (const receipt of pending.values()) receipt.resolve(unavailable('Claude stream ended before acknowledgement'));
        finishActiveTurn?.();
        if (closed && !adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: true });
        if (closed) {
          await stopChild();
          if (ownsRuntime()) await options.onExit?.();
        }
      }
    })();
    enterStartupStage('SDK initialization');
    const initialization = await sdk.initializationResult();
    // A coding-assistant session loads no MCP servers, so it has no SU tool
    // connection to wait for.
    if (su && !privateMcpServer) {
      enterStartupStage('SU tool connection');
      let servers = await sdk.mcpServerStatus();
      let suServer = servers.find((server) => server.name === 'papercusp-su');
      // SDK initialization can finish while an MCP connection is still pending.
      // Keep the host starting within its existing deadline until that handshake
      // settles; failed/missing/unauthenticated connections remain refusals.
      while (suServer && new Set(['pending', 'connecting']).has(suServer.status)) {
        if (closed || !ownsRuntime()) throw new Error('Claude connection closed or was replaced during SU tool initialization');
        await new Promise((resolve) => setTimeout(resolve, 100));
        servers = await sdk.mcpServerStatus();
        suServer = servers.find((server) => server.name === 'papercusp-su');
      }
      if (suServer?.status !== 'connected') {
        // Name WHY and WHERE: a bare 'failed' cannot tell a dead endpoint from a
        // refused identity. The query string is dropped because it carries the
        // session's MCP credentials.
        const configured = suServer?.config && 'url' in suServer.config ? String(suServer.config.url) : undefined;
        const endpoint = configured ? configured.split('?', 1)[0] : undefined;
        const detail = [suServer?.error, endpoint && `endpoint ${endpoint}`, suServer?.scope && `scope ${suServer.scope}`]
          .filter(Boolean).join('; ');
        throw new Error(`Claude SU tool connection is ${suServer?.status ?? 'missing'}${detail ? ` (${detail})` : ''}; reconnect the SU tool connection (servers: ${servers.map((server) => `${server.name}:${server.status}`).join(', ') || 'none'})`);
      }
      acceptNativeTools(suServer.tools ?? []);
    }
    if (!ownsRuntime()) throw new Error('Claude runtime was replaced during initialization');
    if (options.resume) {
      adapter.host.transition('resuming', 'Restoring saved conversation before attaching the executor');
      enterStartupStage('transcript restore');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
    }
    if (closed || !ownsRuntime()) throw new Error('Claude connection closed or was replaced during startup');
    enterStartupStage('resume finalization');
    await options.beforeReady?.(processId);
    if (fork) {
      enterStartupStage('fork visible history');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true, path: fork.transcriptPath });
      enterStartupStage('tracked fork registration');
      await fork.register();
    }
    if (closed || !ownsRuntime()) throw new Error('Claude connection closed or was replaced while finalizing resume');
    ready = true;
    adapter.host.transition('ready', su
      ? 'Claude structured stream, SU tools and command executor attached'
      : 'Claude structured stream and command executor attached');
    // WI-10006652: /model lists the models this Claude reports, not the
    // workspace's routing tiers. Published after every startup descriptor
    // write so none of them can drop it.
    adapter.host.updateModels(claudeModelOptions(initialization?.models));
    } catch (error) {
      // Stop the native writer before removing any unregistered fork artifacts.
      if (!adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
      await close();
      await fork?.cleanup();
      throw error;
    }
  })();
  let timer: ReturnType<typeof setTimeout>;
  const readyPromise = Promise.race([
    startup,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SuSessionStartupTimeoutError(
      `Claude startup timed out during ${startupStage} (${Date.now() - stageStartedAt}ms in this step); reconnect or choose another engine${childStderrSuffix(childStderr.read())}`,
      startupStage,
    )), options.startupTimeoutMs ?? 45_000); }),
  ]).catch(async (error: unknown) => {
    if (!adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
    await close();
    throw error;
  }).finally(() => clearTimeout(timer));
  return { adapter, ready: readyPromise, get done() { return done; }, close, pid: () => processId };
}
