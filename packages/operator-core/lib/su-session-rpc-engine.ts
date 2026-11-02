/** Native structured engines for PUI. Codex owns an app-server thread; OMP
 * owns an RPC session. Bootstrap/configuration, adapters, durable commands and
 * tracked process teardown are the same seams used by other SU launches. */
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SuApprovalsMode, SuSessionInputPart, SuSessionJsonValue, SuSessionRefusal } from '@papercusp/chat-protocol';
import { prepareSuSessionInput, SuInputRefusal } from './su-session-input';
import {
  applyGithubTokenEnv, assertLaunchPersona, modelArgsFor, ompCoreToolNames,
  ompResponsesCompatibilityEnv, recordSessionOwner,
  prepareSuLaunch, resolveOmpSessionModel, suLaunchArgs, writeOmpSessionConfigDir, nativeOmpExtensionArgs,
} from '../../../apps/operator/scripts/psu-launcher.mjs';
import { agentMcpMode, prepareNativeOmpConfig, type NativeOmpConfig } from './agent-mcp-client';
import { splitModelSpec } from './agent-config-constants';
import { setAdvSessionOmpThreadId } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { resolveChildSessionOperatorBaseUrl } from './mcp-base-url';
import type { CodexNativeSessionHandle, OmpNativeSessionHandle } from './native-session-handles';
import { createCodexSuSessionAdapter, type CodexSuSessionAdapter } from './su-session-codex-adapter';
import { createOmpSuSessionAdapter, type OmpSuSessionAdapter } from './su-session-omp-adapter';
import { loadSuOwnerTurnReceipts, type SuOwnerTurn, type SuOwnerTurnReceiptRef } from './su-session-commands';
import { makeCodingAssistantCodexHome } from './role-codex-home';
import type { ClaudeEngineIdentity } from './su-session-claude-engine';
import { persistSuSessionDescriptor } from './su-session-persistence';
import { listCodexModels, ompModelOptions } from './su-session-engine-models';
import { codexAppServerTokenUsage, codexPlan, nativeToolArguments, ompMessageUsage, type SuCodexTurnAdmission, type SuCodexTurnLifecycle } from './su-session-usage';
export type { SuCodexTurnAdmission, SuCodexTurnLifecycle } from './su-session-usage';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import { SuSessionStartupTimeoutError, type SuSessionEventInput, type SuSessionHost, type SuSessionServedAccountReader } from './su-session-host';
import { startSuStdioPeer, SuStdioRequestRefusal, type RpcFrame, type SuStdioPeer, type SuNativeToolCall } from './su-session-stdio-peer';
import { SuNativeCards } from './su-session-native-cards';
import { readSuperuserToken } from './superuser-token';
import { admitNativeIdentityInference } from './cupboard/identity-activation-gate-io';
import { resolveAgentBinarySync } from './agent-bin-detect';
import { attachedInstalledToolLifecycle, nativeInstalledPerUseTurns, type AttachedInstalledToolFunding } from './agent-tools/per-use-chokepoint';
import { listAllProjectedTools } from '@papercusp/tooldef';
import { productionInstalledToolFunding } from './cupboard/installed-tool-funding';
import { synthesizeTransportPrincipal } from './endpoint-route/routes/transport/role-principal-caps';
import { canonicalJson } from './authority/authority-rpc-envelope';
import type { HostRequestPrincipalResolver } from './auth/require-principal';

type Backend = 'codex' | 'omp';
type NativeHandle = CodexNativeSessionHandle | OmpNativeSessionHandle;
export interface SuRpcEngineOptions {
  /** Launch diagnostics; names the operation currently holding readiness. */
  stage?: (name: string) => void;
  agentChatId: string;
  model?: string | null;
  accountRoute?: string | null;
  servedAccountReader?: SuSessionServedAccountReader;
  /** Acceptance-only opt-in to the native permission request/card path. */
  toolApproval?: 'prompt';
  carry?: 'warm' | 'cold';
  modes?: readonly string[];
  runtimeGeneration?: number;
  nativeSession?: NativeHandle;
  host?: SuSessionHost;
  beforeReady?: (pid: number | null) => Promise<void>;
  register?: boolean;
  startupTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  peerFactory?: typeof startSuStdioPeer;
  onExit?: () => Promise<void>;
  /** P-016: 'coding-assistant' runs the backend's own identity, with no SU
   * playbook, Papercusp hooks or papercusp-su MCP (default 'su'). */
  identity?: ClaudeEngineIdentity;
  /** Saved owner turns the resume replay pairs restored prompts with
   * (default: loadSuOwnerTurnReceipts, WI-10004254). */
  ownerTurnReceipts?: (identity: SuOwnerTurn['target']) => Promise<readonly SuOwnerTurnReceiptRef[]>;
  /** Awaited admission/binding/completion for hosts enforcing paid inference.
   * OMP has no proven native turn identity and cannot use this capability. */
  turnLifecycle?: SuCodexTurnLifecycle;
  /** Host-owned installed funding; never restored from command arguments. */
  installedToolFunding?: AttachedInstalledToolFunding;
  /** Actual launching request's host-local capability, never saved in JSON. */
  resolveRequestPrincipal?: HostRequestPrincipalResolver;
}

/** The user's own OMP MCP servers, minus papercusp-su (P-016). */
function ompUserMcpJsonWithoutSu(home: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.omp', 'agent', 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const servers = { ...(parsed.mcpServers ?? {}) };
    for (const name of Object.keys(servers)) if (/^papercusp(?:[-_]su)?$/i.test(name)) delete servers[name];
    return JSON.stringify({ ...parsed, mcpServers: servers }, null, 2);
  } catch {
    return JSON.stringify({ mcpServers: {} });
  }
}

/** OMP launch flags for its own identity: suLaunchArgs minus the SU system
 * prompt, and without the native-LSP strip (stock OMP keeps its LSP tool). */
export function ompCodingAssistantArgs(promptFile: string): string[] {
  const args = checkedNativeArgs(suLaunchArgs('omp', { promptFile, allowNativeLsp: true }).args);
  const at = args.indexOf('--system-prompt');
  if (at >= 0) args.splice(at, 2);
  return args;
}
function checkedNativeArgs(args: readonly unknown[]): string[] {
  return args.map(arg => {
    if (typeof arg !== 'string') throw new Error('Native launcher produced a non-string argument');
    return arg;
  });
}
export interface SuRpcEngine {
  adapter: CodexSuSessionAdapter | OmpSuSessionAdapter;
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
  nativeSession(): NativeHandle;
}

function object(value: unknown): RpcFrame {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }

/** D-026: the Codex turn/start overrides for one engine-neutral approvals mode.
 * Both fields apply "for this turn and subsequent turns" (TurnStartParams,
 * codex-cli 0.160.1). There is no full-access mode. */
export function codexApprovalsPolicy(mode: SuApprovalsMode): {
  approvalPolicy: 'untrusted' | 'on-request';
  sandboxPolicy: { type: 'workspaceWrite' } | { type: 'readOnly' };
} {
  switch (mode) {
    case 'ask': return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' } };
    case 'auto-edit': return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
    case 'read-only': return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } };
  }
}
/** P-026: an owner's model switch the engine refused before any turn began. */

export function startSuRpcEngine(
  boot: BootstrapSuResult,
  binding: PuiSuSessionBinding & { backend: Backend },
  options: SuRpcEngineOptions,
): SuRpcEngine {
  const backend = binding.backend;
  if (options.turnLifecycle && backend !== 'codex') {
    throw new Error('Awaited turn lifecycle requires a proven Codex native turn identity');
  }
  if (boot.agent !== backend || boot.sessionId !== binding.advSessionId
    || boot.workspaceId !== binding.workspaceId || boot.harnessSlug !== binding.harnessSlug
    || boot.envelopeEnv.PAPERCUSP_SID !== binding.ownerId) {
    throw new Error('Structured engine bootstrap does not match the durable SU identity');
  }
  if (options.nativeSession && options.nativeSession.backend !== backend) throw new Error('Resume handle has a different backend');
  if (Object.prototype.hasOwnProperty.call(options, 'forkFrom')) {
    throw new Error('Native Codex forks require the tracked launcher; attach the registered child identity');
  }
  const su = (options.identity ?? 'su') === 'su';
  if (su) assertLaunchPersona(boot.promptFile);
  const preparation = prepareSuLaunch(boot, {
    model: options.model, executionKind: 'programmatic', accountRoute: options.accountRoute,
  });
  const env = preparation.env;
  // WI-6554700010008332: same routing as the Claude engine (see resolveChildSessionOperatorBaseUrl).
  env.PAPERCUSP_OPERATOR_URL = resolveChildSessionOperatorBaseUrl();
  let selectedModel = preparation.model;
  // D-026: the prompted Codex launch below (on-request + workspace-write) is
  // `auto-edit`. An unprompted launch (never + full access) has no neutral mode.
  let selectedApprovals: SuApprovalsMode | undefined =
    backend === 'codex' && options.toolApproval === 'prompt' ? 'auto-edit' : undefined;
  let args: string[];
  let native: NativeHandle;
  let nativePath: string | null = null;
  if (backend === 'codex') {
    if (!env.CODEX_HOME) throw new Error('Codex SU bootstrap did not supply CODEX_HOME');
    if (!su) makeCodingAssistantCodexHome(env.CODEX_HOME, env.HOME || homedir());
    native =options.nativeSession ?? { backend, source: 'adv_sessions', ownerId: binding.ownerId,
      codexHome: env.CODEX_HOME, rolloutId: '', exactResumeSupported: false, missingReason: 'Codex is initializing' };
    // App-server accepts config overrides rather than the TUI's -m flag.
    const modelArgs = preparation.modelArgs;
    args = [...checkedNativeArgs(preparation.args), 'app-server'];
    for (let index = 0; index < modelArgs.length; index++) {
      if (modelArgs[index] === '-m') args.push('-c', `model=${JSON.stringify(modelArgs[++index])}`);
      else args.push(modelArgs[index]);
    }
  } else {
    selectedModel = resolveOmpSessionModel(env.PAPERCUSP_OMP_MODEL_SELECTOR || selectedModel, options.accountRoute);
    const configDir = options.nativeSession?.backend === 'omp' && options.nativeSession.agentHome
      ? null : writeOmpSessionConfigDir(binding.advSessionId, {
        discoveryOff: su, toolsAllowlist: su ? ompCoreToolNames(env) : null, model: selectedModel,
        modelsYml: env.PAPERCUSP_OMP_MODELS_YML || null, clientId: binding.ownerId,
        operatorUrl: env.PAPERCUSP_OPERATOR_URL, interactive: false,
        // WI-10003604: this engine runs INSIDE the operator it points OMP at, so the bearer the
        // session needs is exactly the one this process validates — never the user template's.
        operatorBearer: su ? readSuperuserToken() : null,
        // P-016: an explicit server map is used verbatim: the user's own servers only.
        ...(su ? {} : { mcpJsonContents: ompUserMcpJsonWithoutSu(env.HOME || homedir()) }),
      });
    const agentHome = options.nativeSession?.backend === 'omp' ? options.nativeSession.agentHome
      : configDir ? join(homedir(), configDir, 'agent') : null;
    if (!agentHome) throw new Error('OMP could not materialize its isolated SU configuration');
    env.PI_CODING_AGENT_DIR = agentHome;
    if (configDir) env.PI_CONFIG_DIR = configDir;
    Object.assign(env, ompResponsesCompatibilityEnv('omp', selectedModel, env));
    native = options.nativeSession ?? { backend, source: 'adv_sessions', ownerId: binding.ownerId,
      agentHome, ompThreadId: '', exactResumeSupported: false, missingReason: 'OMP is initializing' };
    args = [...su ? preparation.args
      : ompCodingAssistantArgs(boot.promptFile),
      // rpc-ui keeps structured stdio and installs OMP's native question
      // callbacks. Plain rpc deliberately omits that interactive capability.
      ...modelArgsFor('omp', selectedModel), '--mode', 'rpc-ui'];
    if (su && options.resolveRequestPrincipal) {
      // Both fresh and resumed profiles need the owned callback, including
      // ordinary HTTP. Keep the saved MCP URL/credentials and transport; only
      // this child receives the host-owned observation descriptor.
      const extensionArgs = nativeOmpExtensionArgs('omp', { ...env, PAPERCUSP_NATIVE_HOOK_FD: '3' });
      if (!extensionArgs.length) throw new Error('OMP original-call observation is unavailable on this runtime');
      const configPath = join(agentHome, 'mcp.json');
      const prepared = prepareNativeOmpConfig(readFileSync(configPath, 'utf8'), {
        mode: agentMcpMode(env.PAPERCUSP_MCP_TRANSPORT), home: homedir(), env, observeNativeCalls: true,
      });
      const config = JSON.parse(prepared) as NativeOmpConfig;
      if (config.papercuspNativeMcp?.version !== 1 || !config.papercuspNativeMcp.servers['papercusp-su']) {
        throw new Error('OMP original-call observation requires the owned SU MCP connection');
      }
      writeFileSync(configPath, prepared, { mode: 0o600 });
      if (!args.includes(extensionArgs[1]!)) args.push(...extensionArgs);
    }
    if (options.toolApproval === 'prompt') {
      const approvalMode = args.indexOf('--approval-mode');
      if (approvalMode < 0 || args[approvalMode + 1] !== 'yolo') {
        throw new Error('OMP structured launch is missing its managed approval mode');
      }
      args[approvalMode + 1] = 'always-ask';
    }
    if (native.backend === 'omp' && native.ompThreadId) args.push('--resume', native.ompThreadId);
  }
  options.stage?.('rpc-github-token');
  if (!options.peerFactory) applyGithubTokenEnv(env);
  options.stage?.('rpc-create-adapter');
  let peer: SuStdioPeer | undefined;
  let ready = false;
  let closed = false;
  let failureReported = false;
  let ompReadinessFailure: string | undefined;
  let ownerTurnId = '';
  let nativeTurnId = '';
  let turnCompletionSettled = false;
  let turnFinished: (() => void) | undefined;
  let turnCompletion: Promise<void> | undefined;
  let nativeStart: Promise<RpcFrame> | undefined;
  let turnAdmission: SuCodexTurnAdmission | undefined;
  let nativeBinding: Promise<void> | undefined;
  let releaseNativeBinding: (() => void) | undefined;
  let nativeBindingFailed = false;
  let nativeToolObservationTail = Promise.resolve();
  const observedNativeToolCalls = new Map<string, string>();
  const completedNativeToolTurns = new Set<string>();
  let inputTail = Promise.resolve();
  let turnEpoch = 0;
  let interruptInFlight: Promise<{ ok: true } | ({ ok: false } & SuSessionRefusal)> | undefined;
  const streams = new Map<string, string>();
  const tools = new Map<string, string>();
  const initializingFrames: RpcFrame[] = [];
  let initializingFrameBytes = 0;
  // OMP has no proven billing turn ID. This is only an independently observed
  // root-input scope; its credential and principal resolver stay in this host.
  let ompRuntimeBearer: string | undefined;
  let ompInput: { id: string; ownerTurnId: string; text: string; principalId: string;
    accepted: Promise<void>; releaseAcceptance(): void;
    originalCalls: Map<string, SuNativeToolCall>;
    executedCalls: Map<string, SuNativeToolCall>;
    rootSeen: boolean; agentStarted: boolean; nativeTools: Readonly<Record<string, string>> } | undefined;
  let ompInputScope: ReturnType<typeof nativeInstalledPerUseTurns.registerNativeInput> | undefined;
  const withdrawOmpInput = () => {
    ompInput?.releaseAcceptance();
    ompInput = undefined;
    const scope = ompInputScope;
    ompInputScope = undefined;
    // The registry tombstones before its returned cleanup promise settles.
    return scope?.withdraw();
  };
  const acceptOmpInput = () => {
    const input = ompInput;
    if (!input || !input.rootSeen || !input.agentStarted || ompInputScope || closed || !ready
      || !ownsRuntime() || interruptInFlight || turnCompletionSettled || input.ownerTurnId !== ownerTurnId
      || !options.resolveRequestPrincipal || !ompRuntimeBearer) return;
    ompInputScope = nativeInstalledPerUseTurns.registerNativeInput({ provider: 'omp',
      nativeInputId: input.id, nativeSessionId: nativeId(), ownerTurnId,
      workspaceId: boot.workspaceId, advSessionId: binding.advSessionId, ownerId: binding.ownerId!,
      principalId: input.principalId, mcpServer: 'papercusp-su', nativeTools: input.nativeTools,
      resolveRequestPrincipal: async () => {
        if (closed || !ownsRuntime() || ompInput !== input) return null;
        const principal = await options.resolveRequestPrincipal!();
        return !closed && ownsRuntime() && ompInput === input ? principal : null;
      },
      resolveRuntimeBearer: async () => !closed && ownsRuntime() && ompInput === input ? ompRuntimeBearer ?? null : null });
    input.releaseAcceptance();
  };
  const unavailable = (message: string) => ({ ok: false as const, code: 'engine_delivery_unknown', message, retryable: false });
  const turnLifecycle = options.turnLifecycle ?? (su && backend === 'codex' ? attachedInstalledToolLifecycle({
    session: { workspaceId: binding.workspaceId ?? '', ownerId: binding.ownerId ?? '', advSessionId: binding.advSessionId,
      principalId: synthesizeTransportPrincipal({ workspaceId: binding.workspaceId ?? '', role: 'operator', isSuperuser: true })?.slug ?? '' },
    funding: options.installedToolFunding,
    resolveRequestPrincipal: options.resolveRequestPrincipal,
    resolveFunding: () => productionInstalledToolFunding({ workspaceId: binding.workspaceId ?? '', ownerId: binding.ownerId ?? '',
      principalId: synthesizeTransportPrincipal({ workspaceId: binding.workspaceId ?? '', role: 'operator', isSuperuser: true })?.slug ?? '' }),
    identityLifecycle: { admit: async context => {
      const verdict = await admitNativeIdentityInference({ workspaceId: context.workspaceId, ownerId: context.ownerId, backend });
      return verdict.ok ? { ok: true, bindNativeTurn: async () => {}, complete: async () => {}, reconcile: async () => {} } : verdict;
    } },
    readNativeToolNames: async () => {
      const names: string[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await peer!.request({ method: 'mcpServerStatus/list', params: cursor ? { cursor } : {} }, options.deliveryTimeoutMs ?? 30_000);
        if (!Array.isArray(page.data)) throw new Error('Native MCP inventory is unreadable');
        for (const server of page.data.map(object)) if (server.name === 'papercusp-su') names.push(...Object.keys(object(server.tools)));
        cursor = page.nextCursor == null ? undefined : string(page.nextCursor);
        if (page.nextCursor != null && (!cursor || cursors.has(cursor)) || cursors.size >= 100)
          throw new Error('Native MCP inventory pagination is incomplete');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!names.length) throw new Error('Codex SU tools are not connected');
      return names;
    },
    recordFailure: async failure => {
      emit({ type: 'error', scope: 'transport', code: 'native_installed_reconciliation', recoverable: false,
        message: `Installed tool ${failure.phase}: ${failure.message}` });
    },
  }) : undefined);
  const controls = {
    async ownerTurn({ content, input: richInput, turnId, model: nextModel, approvals: nextApprovals }: { content: string; input?: readonly SuSessionInputPart[]; turnId: string; model?: string; approvals?: SuApprovalsMode }) {
      if (!ready || closed || !ownsRuntime()) return unavailable(`${backend} connection is not ready`);
      // D-026: Codex takes an approvals switch on this turn's turn/start. OMP has
      // no approval-mode RPC, so a switch refuses the turn instead of running it
      // in a mode the owner did not pick.
      if (nextApprovals && nextApprovals !== selectedApprovals && backend !== 'codex') {
        return { ok: false as const, code: 'approvals_switch_refused', retryable: false,
          liftsWhen: 'Send a new turn without an approvals override, or use a Claude or Codex session to select an approvals mode; OMP has no approvals-switch RPC.',
          message: `/approvals is not available for ${backend === 'omp' ? 'OMP' : backend}` };
      }
      // P-026: Codex takes the switch on this turn's turn/start; OMP takes it as
      // set_model (+ set_thinking_level) before the prompt. A refused OMP switch
      // refuses the turn rather than running it on the old model.
      const requestedModel = nextModel !== undefined ? splitModelSpec(nextModel) : null;
      if (requestedModel && !requestedModel.model) return { ok: false as const, code: 'model_switch_refused', retryable: false,
        liftsWhen: 'Send a new turn with a non-empty model name, or omit the model override.',
        message: `"${nextModel}" names no model` };
      let acknowledged!: (verdict: { ok: true } | ({ ok: false } & SuSessionRefusal)) => void;
      const receipt = new Promise<{ ok: true } | ({ ok: false } & SuSessionRefusal)>((resolve) => { acknowledged = resolve; });
      inputTail = inputTail.then(async () => {
        // An interrupt's completion can release the current turn before its
        // control receipt settles. Keep the next queued turn behind both.
        await interruptInFlight;
        if (!ready || closed || !ownsRuntime()) { acknowledged(unavailable('The engine closed or was replaced before this saved turn was sent')); return; }
        // Evaluate switches at delivery: an earlier queued turn can change the
        // selection after this command was accepted, including away and back.
        const switchTo = nextModel !== undefined && nextModel !== selectedModel ? requestedModel : null;
        const approvalsTo = nextApprovals && nextApprovals !== selectedApprovals ? nextApprovals : null;
        if (switchTo && backend === 'omp') {
          // Switch before the turn is opened: a refusal then leaves no owner
          // turn waiting on a completion that will never come. The stdio peer
          // rejects a correlated `success:false` response, so any failure of
          // either request lands here as an Error, never as a resolved frame.
          const slash = switchTo.model!.indexOf('/');
          try {
            if (slash <= 0) throw new Error(`"${nextModel}" is not a provider/model OMP spec`);
            const model = await peer!.request({ type: 'set_model', provider: switchTo.model!.slice(0, slash),
              modelId: switchTo.model!.slice(slash + 1) }, options.deliveryTimeoutMs ?? 30_000);
            if (switchTo.effort) await peer!.request({ type: 'set_thinking_level', level: switchTo.effort }, options.deliveryTimeoutMs ?? 30_000);
            updateOmpContextWindow(model);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            acknowledged({ ok: false as const, code: 'model_switch_refused', retryable: false,
              liftsWhen: 'Send a new turn with a supported provider/model and effort, omit the model override, or start a new OMP session with the requested model.',
              message: `Could not switch to ${nextModel}: ${reason}` });
            return;
          }
        }
        ownerTurnId = turnId;
        turnEpoch++;
        turnCompletionSettled = false;
        nativeBindingFailed = false;
        nativeToolObservationTail = Promise.resolve();
        observedNativeToolCalls.clear();
        completedNativeToolTurns.clear();
        nativeBinding = new Promise<void>((resolve) => { releaseNativeBinding = resolve; });
        const finished = new Promise<void>((resolve) => { turnFinished = resolve; });
        turnCompletion = finished;
        let deliveryAttempted = false;
        let failurePhase: 'delivery' | 'binding' = 'delivery';
        try {
          let prepared = await prepareSuSessionInput({ content, input: richInput }, { workspaceId: boot.workspaceId, root: boot.cwd });
          if (su && !turnLifecycle) {
            if (!binding.workspaceId || !binding.ownerId) throw new Error('Native admission requires the authenticated workspace and owner');
            const admission = await admitNativeIdentityInference({ workspaceId: binding.workspaceId,
              ownerId: binding.ownerId, backend });
            if (!admission.ok) { acknowledged(admission); return; }
          }
          if (turnLifecycle) {
            if (!binding.workspaceId || !binding.ownerId || !nativeId()) {
              throw new Error('Turn admission requires the authenticated workspace, owner and native session');
            }
            const admission = await turnLifecycle.admit({ workspaceId: binding.workspaceId,
              ownerId: binding.ownerId, nativeSessionId: nativeId(), ownerTurnId: turnId,
              model: nextModel ?? selectedModel });
            if (!admission.ok) { acknowledged(admission); return; }
            turnAdmission = admission;
          }
          if (!ready || closed || !ownsRuntime()) throw new Error('The engine closed or was replaced during turn admission');
          if (interruptInFlight) {
            await turnAdmission?.reconcile({ phase: 'delivery', message: 'Owner interrupted before native delivery' });
            acknowledged({ ok: false, code: 'turn_interrupting', retryable: false,
              message: 'The owner interrupted this turn before native delivery' });
            return;
          }
          // Admission may wait. A project reference must still be authorized
          // when these bytes cross the native boundary.
          if (richInput?.some(part => part.type === 'file')) {
            prepared = await prepareSuSessionInput({ content, input: richInput }, { workspaceId: boot.workspaceId, root: boot.cwd });
          }
          if (!ready || closed || !ownsRuntime()) throw new Error('The engine closed or was replaced during input preparation');
          if (backend === 'omp' && su && ompRuntimeBearer && options.resolveRequestPrincipal) {
            const principal = await options.resolveRequestPrincipal();
            if (!ready || closed || !ownsRuntime() || interruptInFlight) throw new Error('OMP input authority changed before delivery');
            if (principal && principal.workspaceId === boot.workspaceId && ['trusted', 'verified'].includes(principal.trust)) {
              // get_state exposes a bounded preview, not an exhaustive catalog.
              // Use the maintained host registry and the owned extension's exact
              // native spelling. Ambiguous separator aliases grant no authority.
              const names: Record<string, string> = Object.create(null), collisions = new Set<string>();
              for (const tool of listAllProjectedTools()) {
                const canonical = tool.expose.mcp?.name;
                if (!canonical) continue;
                const name = `mcp__papercusp-su_${canonical}`.replace(/[^a-zA-Z0-9_]/g, '_');
                if (collisions.has(name)) continue;
                if (Object.hasOwn(names, name) && names[name] !== canonical) {
                  delete names[name]; collisions.add(name);
                } else names[name] = canonical;
              }
              let releaseAcceptance!: () => void;
              const accepted = new Promise<void>(resolve => { releaseAcceptance = resolve; });
              ompInput = { id: `omp-input:${turnEpoch}`, ownerTurnId: turnId, text: content, accepted, releaseAcceptance,
                originalCalls: new Map(), executedCalls: new Map(),
                principalId: principal.slug, rootSeen: false, agentStarted: false, nativeTools: Object.freeze(names) };
            }
          }
          // The command is durably accepted before native delivery. Persist its
          // visible prompt before RPC can stream a reply; restored sessions use
          // these owner events to place each reply under its original prompt.
          host.transition('running', 'Saved owner input is being delivered');
          emit({ type: 'transcript', phase: 'completed', turnId, role: 'owner',
            channel: 'text', content });
          if (backend === 'codex') {
            deliveryAttempted = true;
            nativeStart = peer!.request({ method: 'turn/start', params: {
              threadId: nativeId(), input: prepared.codex,
              ...(switchTo ? { model: switchTo.model, ...(switchTo.effort ? { effort: switchTo.effort } : {}) } : {}),
              ...(approvalsTo ? codexApprovalsPolicy(approvalsTo) : {}),
            } }, options.deliveryTimeoutMs ?? 30_000);
            const result = await nativeStart;
            nativeTurnId = string(object(result.turn).id);
            if (!nativeTurnId) throw new Error('Codex accepted no identifiable native turn');
            failurePhase = 'binding';
            await turnAdmission?.bindNativeTurn(nativeTurnId);
          } else await peer!.request({ type: 'prompt', message: content }, options.deliveryTimeoutMs ?? 30_000);
          releaseNativeBinding?.();
          if (!ownsRuntime()) throw new Error('The engine was replaced during native delivery');
          if (switchTo) { selectedModel = nextModel; host.updateModel(nextModel!); }
          if (approvalsTo) { selectedApprovals = approvalsTo; host.updateApprovals(approvalsTo); }
          await refreshResumeEvidence();
          acknowledged({ ok: true });
          await finished;
        } catch (error) {
          if (error instanceof SuInputRefusal && !deliveryAttempted) {
            await turnAdmission?.reconcile({ phase: 'delivery', message: error.message });
            acknowledged({ ok: false, code: error.code, message: error.message, retryable: false });
            return;
          }
          nativeBindingFailed = true;
          releaseNativeBinding?.();
          acknowledged(unavailable(String(error)));
          // The native turn may have begun despite a lost response. Do not
          // send queued input into an uncorrelated turn or replay this one.
          ready = false;
          // Persist the uncertain outcome before teardown; never release an
          // admission merely because its native acknowledgement was lost.
          if (turnAdmission) {
            try { await turnAdmission.reconcile({ phase: deliveryAttempted ? failurePhase : 'delivery', message: String(error) }); }
            catch (reconcileError) { reportRuntimeFailure(reconcileError); }
          }
          adapter.reconcileRuntimeExit({ expected: false, reason: `Native delivery is unknown: ${String(error)}` });
          await close();
        } finally {
          void withdrawOmpInput();
          turnFinished?.();
          releaseNativeBinding?.();
          turnAdmission = undefined; nativeBinding = undefined; releaseNativeBinding = undefined;
          observedNativeToolCalls.clear();
          completedNativeToolTurns.clear();
          turnFinished = undefined; turnCompletion = undefined; nativeStart = undefined; ownerTurnId = ''; nativeTurnId = ''; streams.clear();
        }
      });
      return receipt;
    },
    async queue(input: { content: string; input?: readonly SuSessionInputPart[]; turnId: string; model?: string; approvals?: SuApprovalsMode }): Promise<{ ok: true } | ({ ok: false } & SuSessionRefusal)> {
      return controls.ownerTurn(input);
    },
    async steer({ content, input: richInput, turnId, activeTurnId, model, approvals }: {
      content: string; input?: readonly SuSessionInputPart[]; turnId: string; activeTurnId: string; model?: string; approvals?: SuApprovalsMode;
    }) {
      if (!ready || closed || !ownsRuntime() || !peer) return unavailable('The engine is disconnected');
      const refuse = (code: string, message: string) => ({ ok: false as const, code, message, retryable: false });
      if (backend !== 'codex') return refuse('unsupported', 'This runtime has no native active-turn steer');
      if (model !== undefined || approvals !== undefined) {
        return refuse('steer_overrides_unsupported', 'Queue a new turn to change model or approvals; native steering accepts input only');
      }
      const owner = ownerTurnId, epoch = turnEpoch, bindingReady = nativeBinding;
      if (!owner) return refuse('no_active_turn', 'There is no active turn to steer');
      if (activeTurnId !== owner) return refuse('active_turn_mismatch', 'The steer targets a different owner turn');
      const current = () => ready && !closed && ownsRuntime() && epoch === turnEpoch && owner === ownerTurnId
        && !interruptInFlight && !turnCompletionSettled && !nativeBindingFailed
        && Boolean(nativeTurnId) && !completedNativeToolTurns.has(nativeTurnId);
      if (interruptInFlight) return refuse('turn_interrupting', 'The expected turn is being interrupted');
      // Admission and the correlated turn/start response must bind first. This
      // never waits on inputTail (which lasts until the turn FINISHES).
      await bindingReady;
      if (!current()) return refuse('active_turn_finished', 'The expected turn finished or became unavailable before steering');
      const expectedTurnId = nativeTurnId;
      try {
        const prepared = await prepareSuSessionInput({ content, input: richInput }, { workspaceId: boot.workspaceId, root: boot.cwd });
        if (!current()) return refuse('active_turn_finished', 'The expected turn finished while validating input');
        const response = await peer.request({ method: 'turn/steer', params: {
          threadId: nativeId(), expectedTurnId, input: prepared.codex,
        } }, options.deliveryTimeoutMs ?? 30_000);
        if (response.turnId !== expectedTurnId) throw new Error('Codex steer acknowledgement did not identify the expected native turn');
        if (!current() || nativeTurnId !== expectedTurnId) {
          return refuse('steer_outcome_unknown', 'The expected turn finished or was interrupted before its steer receipt settled; do not replay this input');
        }
        emit({ type: 'transcript', phase: 'completed', turnId, role: 'owner', channel: 'text', content });
        return { ok: true as const };
      } catch (error) {
        if (error instanceof SuInputRefusal) return refuse(error.code, error.message);
        if (error instanceof SuStdioRequestRefusal) return refuse('native_steer_refused', error.message);
        // A lost or uncorrelated acknowledgement cannot authorize retry or
        // delivery to the next turn. Fence this executor like turn/start.
        ready = false;
        adapter.reconcileRuntimeExit({ expected: false, reason: `Native steer delivery is unknown: ${String(error)}` });
        await close();
        return unavailable(String(error));
      }
    },
    interrupt(): Promise<{ ok: true } | ({ ok: false } & SuSessionRefusal)> {
      if (interruptInFlight) return interruptInFlight;
      interruptInFlight = interruptNativeTurn().finally(() => { interruptInFlight = undefined; });
      return interruptInFlight;
    },
    async resume() { return ready && !closed ? { ok: true as const } : unavailable('Reconnect the saved structured session before resuming'); },
    async focus() { return { ok: true as const }; },
    async end() { await close(); return { ok: true as const }; },
  };
  async function interruptNativeTurn() {
      if (!peer || closed) return unavailable('The engine is disconnected');
      void withdrawOmpInput();
      cards.cancel();
      const completing = turnCompletion;
      const owner = ownerTurnId, starting = nativeStart;
      const bindingReady = nativeBinding;
      let interruptedTurn = nativeTurnId;
      try {
        if (backend === 'codex') {
          if (!interruptedTurn && starting) interruptedTurn = string(object((await starting).turn).id);
          await bindingReady;
          if (owner && owner === ownerTurnId && interruptedTurn && !turnCompletionSettled
            && !completedNativeToolTurns.has(interruptedTurn)) {
            await peer.request({ method: 'turn/interrupt', params: { threadId: nativeId(), turnId: interruptedTurn } });
          }
        } else {
          await peer.request({ type: 'abort' }, options.deliveryTimeoutMs ?? 30_000);
          // OMP responds only after session.abort has cancelled setup and
          // awaited native idle. A turn cancelled before agent_start has no
          // agent_end event, so that idle acknowledgement settles delivery.
          turnFinished?.();
        }
        if (completing) {
          let timer: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([completing, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Native interrupt did not finish the active turn')), options.deliveryTimeoutMs ?? 30_000);
            })]);
          } finally { clearTimeout(timer!); }
        }
      } catch (error) {
        reportRuntimeFailure(error);
        await close();
        return unavailable(String(error));
      }
      if (!ownsRuntime()) return unavailable('The engine was replaced during interrupt');
      host.transition('interrupted', 'Owner interrupted the native turn');
      return { ok: true as const };
  }
  const shared = {
    ...options, executionKind: 'programmatic' as const, controls, ready: false, runtimeReady: () => ready && !closed,
    // D-026: a prompted Codex launch is on-request + workspace-write, which is
    // `auto-edit`. OMP has no switchable mode, so its descriptor omits one.
    ...(backend === 'codex' && selectedApprovals ? { approvals: selectedApprovals } : {}),
    ownerTurnReceipts: options.ownerTurnReceipts ?? ((identity: SuOwnerTurn['target']) => loadSuOwnerTurnReceipts(identity)),
  };
  const adapter = backend === 'codex'
    ? createCodexSuSessionAdapter(binding, { nativeSession: { ...native as CodexNativeSessionHandle, rolloutId: nativeId() }, rolloutPath: null }, { ...shared, typedInput: true, host: options.host as SuSessionHost<'codex'> | undefined })
    : createOmpSuSessionAdapter(binding, { nativeSession: { ...native as OmpNativeSessionHandle, ompThreadId: nativeId() }, transcriptPath: null }, { ...shared, host: options.host as SuSessionHost<'omp'> | undefined });
  const host = adapter.host as SuSessionHost<Backend>;
  // The shared host may already have a replacement while this peer is still
  // draining frames, startup requests or its process-exit promise.
  const runtimeGeneration = host.descriptor().runtimeGeneration;
  function ownsRuntime(): boolean { return host.descriptor().runtimeGeneration === runtimeGeneration; }
  function updateOmpContextWindow(model: unknown): void {
    if (!ownsRuntime()) return;
    const reported = object(model).contextWindow;
    const contextWindow = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported : undefined;
    const descriptor = host.descriptor();
    if (descriptor.usage?.contextWindow === contextWindow) return;
    // Native get_state/set_model carries the denominator that transcript
    // usage lacks. A switch to an unmeasured model must clear the old one.
    host.emit({ type: 'session', descriptor: { ...descriptor,
      usage: { ...descriptor.usage, contextWindow },
      capabilities: { ...descriptor.capabilities, features: { ...descriptor.capabilities.features,
        context: { state: contextWindow ? 'supported' : 'conditional', implementation: 'native',
          reason: contextWindow
            ? 'The native model reports its context window; assistant message usage reports context tokens'
            : 'The current native model did not report a context window; no percentage is inferred',
        },
      } },
    } } as SuSessionEventInput<Backend>);
  }
  const cards = new SuNativeCards(binding.workspaceId!, `pui-native:${binding.advSessionId}:${options.runtimeGeneration ?? 0}`, (event) => {
    if (closed || !ownsRuntime()) return;
    emit(event as SuSessionEventInput<Backend>);
    if (event.type === 'card') host.transition(event.phase === 'opened' ? 'waiting-for-owner' : 'running',
      event.phase === 'opened' ? 'Native engine is waiting for your response' : 'Native response delivered');
    // D-028: an OMP approval answered No stops the turn, so the owner says
    // what to do instead (Codex's `cancel` decision stops its own turn).
  }, { cwd: boot.cwd, stopTurn: () => { void controls.interrupt(); } });
  function nativeId(): string { return native.backend === 'codex' ? native.rolloutId ?? '' : native.ompThreadId ?? ''; }
  function resumeHandle(): NativeHandle {
    const persisted = Boolean(nativePath && existsSync(nativePath));
    native = { ...native, exactResumeSupported: persisted,
      missingReason: persisted ? null : `${backend} has not persisted this native session yet` };
    binding.nativeSession = native;
    return native;
  }
  async function refreshResumeEvidence(): Promise<void> {
    if (native.backend === 'codex' && native.rolloutId && (!nativePath || !existsSync(nativePath))) {
      nativePath = await findCodexRolloutPathByUuid(native.rolloutId, { homeOverride: native.codexHome });
    }
    resumeHandle();
  }
  function emit(input: SuSessionEventInput<Backend>): void { if (ownsRuntime()) host.emit(input); }
  function reportRuntimeFailure(error: unknown): void {
    if (!ownsRuntime()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!failureReported) {
      failureReported = true;
      emit({ type: 'error', scope: 'transport', code: `${backend}_connection_failed`, message, recoverable: true });
    }
    if (!host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: false, reason: message });
  }
  function transcript(key: string, channel: 'text' | 'reasoning', delta: string, completed = false): void {
    if (!ownerTurnId) return;
    if (!streams.has(key)) {
      streams.set(key, '');
      emit({ type: 'transcript', phase: 'started', turnId: ownerTurnId, role: 'assistant', channel });
    }
    if (delta) {
      streams.set(key, streams.get(key)! + delta);
      emit({ type: 'transcript', phase: 'delta', turnId: ownerTurnId, role: 'assistant', channel, content: delta });
    }
    if (completed) emit({ type: 'transcript', phase: 'completed', turnId: ownerTurnId, role: 'assistant', channel, content: streams.get(key) });
  }
  async function finish(status: string, error?: string, eventNativeTurnId?: string): Promise<void> {
    const owner = ownerTurnId, admission = turnAdmission;
    const completedAtMs = Date.now();
    if (!owner || turnCompletionSettled) return;
    if (backend === 'omp') void withdrawOmpInput();
    // Close this exact turn's observation population synchronously. Waiting
    // for binding first would admit item/started frames after turn/completed.
    // An early unrelated completion closes only its own ID, not the current
    // turn whose ID still comes from the correlated turn/start response.
    if (backend === 'codex' && eventNativeTurnId) completedNativeToolTurns.add(eventNativeTurnId);
    // Completion can arrive before turn/start responds or while the durable
    // native binding is in flight. Neither may open the next inference turn.
    if (backend === 'codex') await nativeBinding;
    if (closed || !ownsRuntime() || nativeBindingFailed || owner !== ownerTurnId || turnCompletionSettled) return;
    if (backend === 'codex' && (!eventNativeTurnId || eventNativeTurnId !== nativeTurnId)) return;
    turnCompletionSettled = true;
    cards.cancel();
    // A tool announcement may have preceded turn/start's acknowledgement.
    // Its host observation must settle before closing the monetary population.
    await nativeToolObservationTail;
    if (closed || !ownsRuntime() || nativeBindingFailed || owner !== ownerTurnId) return;
    if (admission) {
      try { await admission.complete({ nativeTurnId, status, completedAtMs }); }
      catch (completionError) {
        ready = false;
        try { await admission.reconcile({ phase: 'completion', message: String(completionError) }); }
        catch (reconcileError) { reportRuntimeFailure(reconcileError); }
        reportRuntimeFailure(completionError);
        await close();
        return;
      }
    }
    if (closed || !ownsRuntime() || nativeBindingFailed || owner !== ownerTurnId) return;
    if (error) emit({ type: 'error', scope: 'turn', code: `${backend}_turn_failed`, message: error, recoverable: true });
    // The native transcript/RPC frame carries completion, but not the account
    // selected by Papercusp's inference gateway. Refresh that provenance before
    // resolving the owner command so success and known failure both publish a
    // settled descriptor. The adapter's reader is injectable and null-safe.
    await adapter.refreshAccountServed();
    if (closed || !ownsRuntime() || nativeBindingFailed || owner !== ownerTurnId) return;
    host.transition(status === 'interrupted' ? 'interrupted' : 'waiting-for-owner', error ?? `${backend} turn ${status}`);
    turnFinished?.();
  }
  function observeNativeToolCall(thread: unknown, turn: string, item: RpcFrame): void {
    const admission = turnAdmission, owner = ownerTurnId, bindingReady = nativeBinding;
    const callId = string(item.id), server = string(item.server), tool = string(item.tool);
    const boundedId = (value: string) => /^[A-Za-z0-9._:-]{1,256}$/.test(value);
    // No session-wide current-turn guess, completed-item fallback, or invented
    // call ID. Capture this admission now so an early event cannot borrow the
    // next turn's authority after an async binding wait.
    if (!admission?.observeToolCall || !owner || turnCompletionSettled ||
        completedNativeToolTurns.has(turn) ||
        thread !== nativeId() || !boundedId(turn) || !boundedId(callId) ||
        !boundedId(server) || !boundedId(tool)) return;
    const args = nativeToolArguments(item.arguments);
    const identity = canonicalJson([server, tool, args]);
    const prior = observedNativeToolCalls.get(callId);
    if (prior === identity) return;
    observedNativeToolCalls.set(callId, identity);
    nativeToolObservationTail = nativeToolObservationTail.then(async () => {
      await bindingReady;
      if (closed || !ownsRuntime() || nativeBindingFailed || owner !== ownerTurnId || admission !== turnAdmission || turn !== nativeTurnId) return;
      if (prior !== undefined) throw new Error('Native call observation changed its target or arguments');
      await admission.observeToolCall!({ nativeTurnId: turn, callId, server, tool, arguments: args });
    }).catch(async (error) => {
      // An observation failure cannot release a funded hold or open another
      // inference turn. Use the existing durable binding-recovery contract.
      nativeBindingFailed = true; ready = false;
      try { await admission.reconcile({ phase: 'binding', message: String(error) }); }
      catch (reconcileError) { reportRuntimeFailure(reconcileError); }
      reportRuntimeFailure(error);
      await close();
    });
  }
  function onMessage(frame: RpcFrame): void {
    if (closed || !ownsRuntime()) { void withdrawOmpInput(); return; }
    const frameThreadId = object(frame.params).threadId ?? object(frame.params).conversationId;
    if (backend === 'codex' && frameThreadId && !nativeId()) {
      // App-server can announce MCP startup before thread/start responds.
      // Defer these frames until that correlated response pins the identity;
      // never treat an unbound identity as permission to dispatch a request.
      initializingFrameBytes += Buffer.byteLength(JSON.stringify(frame));
      if (initializingFrames.length >= 256 || initializingFrameBytes > 1_048_576) {
        throw new Error('Codex emitted too many thread events before identifying its session');
      }
      initializingFrames.push(frame);
      return;
    }
    if (backend === 'codex' && frameThreadId && frameThreadId !== nativeId()) throw new Error('Codex event belongs to a different thread');
    const frameTurnId = string(object(frame.params).turnId);
    if (backend === 'codex' && frame.id != null && typeof frame.method === 'string'
        && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
          'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval'].includes(frame.method)
        && (frameThreadId !== nativeId() || (frame.method !== 'mcpServer/elicitation/request'
          && (!ownerTurnId || turnCompletionSettled || completedNativeToolTurns.has(nativeTurnId))))) {
      peer?.send({ id: frame.id, error: { code: -32602, message: 'Native request has no matching live session or turn' } });
      return;
    }
    if (backend === 'codex' && frame.id != null && frame.method && frameTurnId
        && (!nativeTurnId || frameTurnId !== nativeTurnId || turnCompletionSettled)) {
      peer?.send({ id: frame.id, error: { code: -32602, message: 'Native request does not belong to the active turn' } });
      return;
    }
    if (cards.handle(backend, frame, ownerTurnId || 'startup', (response) => { if (!closed && ownsRuntime()) peer?.send(response); })) return;
    if (backend === 'codex') {
      const method = string(frame.method), params = object(frame.params);
      const eventTurnId = string(params.turnId) || string(object(params.turn).id);
      if (eventTurnId && nativeTurnId && eventTurnId !== nativeTurnId) return;
      if (frame.id != null && method) {
        // Do not execute or approve a request this PUI cannot answer yet.
        peer?.send({ id: frame.id, error: { code: -32601, message: `PUI cannot answer ${method}` } });
        emit({ type: 'error', scope: 'command', code: 'native_request_unsupported', message: `This Codex request is unavailable in PUI: ${method}`, recoverable: true });
      } else if (method === 'turn/started') {
        if (ownerTurnId) host.transition('running', 'Codex native turn started');
      } else if (method === 'turn/completed') {
        const turn = object(params.turn); void finish(string(turn.status), string(object(turn.error).message) || undefined, eventTurnId);
      } else if (method === 'thread/tokenUsage/updated') {
        // WI-10006653: a live conversation's context meter. Without this the
        // descriptor carried usage only after a resume replayed the rollout.
        const usage = codexAppServerTokenUsage(params);
        if (usage) host.updateUsage(usage);
      } else if (method === 'turn/plan/updated') {
        const plan = codexPlan(params);
        if (plan) host.updatePlan(plan);
      } else if (method === 'item/agentMessage/delta') {
        transcript(string(params.itemId), 'text', string(params.delta));
      } else if (method === 'item/reasoning/summaryTextDelta') {
        transcript(`${params.itemId}:reasoning`, 'reasoning', string(params.delta));
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item), id = string(item.id), type = string(item.type);
        if (method === 'item/started' && type === 'mcpToolCall') observeNativeToolCall(frameThreadId, eventTurnId, item);
        if (type === 'agentMessage' && method === 'item/completed') {
          transcript(id, 'text', streams.has(id) ? '' : string(item.text), true);
        } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(type) && ownerTurnId) {
          const name = string(item.tool) || type;
          if (method === 'item/started') {
            tools.set(id, name);
            emit({ type: 'tool', phase: 'started', turnId: ownerTurnId, callId: id, name, input: item as SuSessionJsonValue });
          } else {
            emit({ type: 'tool', phase: 'completed', turnId: ownerTurnId, callId: id, name: tools.get(id) ?? name,
              output: item as SuSessionJsonValue, isError: item.status === 'failed' || item.exitCode != null && item.exitCode !== 0 });
            tools.delete(id);
          }
        }
      } else if (method === 'error') void finish('failed', string(object(params.error).message) || 'Codex reported an error');
    } else {
      const type = string(frame.type);
      if (type === 'message_update') {
        const event = object(frame.assistantMessageEvent);
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const channel = event.type === 'text_delta' ? 'text' : 'reasoning';
          transcript(`${channel}:${event.contentIndex ?? 0}`, channel, string(event.delta));
        }
      } else if (type === 'message_start' && object(frame.message).role === 'user') {
        const content = object(frame.message).content;
        if (ompInput && Array.isArray(content) && content.length === 1
          && object(content[0]).type === 'text' && object(content[0]).text === ompInput.text) {
          ompInput.rootSeen = true;
          acceptOmpInput();
        }
      } else if (type === 'message_end' && object(frame.message).role === 'assistant') {
        const message = object(frame.message);
        for (const [index, value] of (Array.isArray(message.content) ? message.content : []).entries()) {
          const block = object(value), channel = block.type === 'thinking' ? 'reasoning' : 'text';
          // This snapshot already contains rewritten arguments. It is display/
          // execution evidence, not an original-call scope observation. Only
          // the owned hook pipe below can register the original native call.
          if (block.type === 'text' || block.type === 'thinking') {
            const key = `${channel}:${index}`;
            transcript(key, channel, streams.has(key) ? '' : string(block.text ?? block.thinking), true);
          }
        }
        // WI-10006653 (same class): usage per assistant message. The cost is
        // added to the descriptor's running total, which a resume's transcript
        // replay has already seeded.
        const measured = ompMessageUsage(message);
        if (measured) {
          host.updateUsage(measured.cost !== undefined
            ? { ...measured.usage, costUsd: (host.descriptor().usage?.costUsd ?? 0) + measured.cost }
            : measured.usage);
        }
        if (message.errorMessage) void finish('failed', string(message.errorMessage));
        streams.clear();
      } else if ((type === 'tool_execution_start' || type === 'tool_execution_end') && ownerTurnId) {
        const callId = string(frame.toolCallId), name = string(frame.toolName);
        if (type === 'tool_execution_start') emit({ type: 'tool', phase: 'started', turnId: ownerTurnId, callId, name, input: frame.args as SuSessionJsonValue });
        else emit({ type: 'tool', phase: 'completed', turnId: ownerTurnId, callId, name, output: frame.result as SuSessionJsonValue, isError: frame.isError === true });
      } else if (type === 'agent_end' || type === 'prompt_result' && frame.agentInvoked === false) void finish('completed');
      else if (type === 'agent_start') {
        if (ompInput) { ompInput.agentStarted = true; acceptOmpInput(); }
        host.transition('running', 'OMP native turn started');
      }
      else if (type === 'auto_compaction_start') host.transition('compacting', 'OMP is compacting its native context');
      else if (type === 'response' && frame.success === false) void finish('failed', string(frame.error));
    }
  }
  let done: Promise<void> = Promise.resolve();
  let starting: Promise<void>;
  let nativeForkHistory = false;
  let closing: Promise<void> | undefined;
  async function reconcileNativeExit(): Promise<void> {
    if (!turnAdmission || turnCompletionSettled || nativeBindingFailed) return;
    // Withdraw observation authority before awaiting durable recovery. A peer
    // exit without turn/completed never proves the admitted turn was unserved.
    nativeBindingFailed = true;
    try { await turnAdmission.reconcile({ phase: nativeTurnId ? 'completion' : 'delivery',
      message: 'Native engine closed before verified turn completion' }); }
    catch (error) { reportRuntimeFailure(error); }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; ready = false; turnFinished?.(); cards.cancel();
    void withdrawOmpInput();
    ompRuntimeBearer = undefined;
    closing = (async () => { await reconcileNativeExit(); await peer?.close(); })();
    return closing;
  }
  starting = (async () => {
    if (options.nativeSession) {
      options.stage?.('rpc-restore-visible-history');
      // WI-10004162: show the saved conversation before the native peer starts
      // (seconds, or never when startup fails). Best-effort: the replay once the
      // peer is up stays authoritative and adds only what it wrote since.
      await (backend === 'codex'
        ? (adapter as CodexSuSessionAdapter).consumeRolloutSnapshot({ preserveLifecycle: true, deferForkHistory: true })
        : (adapter as OmpSuSessionAdapter).consumeTranscriptSnapshot({ preserveLifecycle: true })
      ).catch(() => undefined);
      if (closed || !ownsRuntime()) throw new Error('Structured connection closed or was replaced during startup');
    }
    options.stage?.('rpc-spawn-peer');
    const resolvedBinary = resolveAgentBinarySync(backend) ?? backend;
    peer = await (options.peerFactory ?? startSuStdioPeer)({
      stage: options.stage,
      binary: resolvedBinary, args, cwd: boot.cwd, env, ownerId: binding.ownerId!, workspaceId: boot.workspaceId, onMessage,
      ...(backend === 'omp' && su && options.resolveRequestPrincipal ? { onNativeToolCall: async (call: SuNativeToolCall) => {
        const input = ompInput;
        if (!input || call.nativeSessionId !== nativeId()) throw new Error('Native hook has no matching owner input');
        // stdout and the private hook pipe are independent streams. Join the
        // hook with the genuine root/agent-start observations before ACKing it.
        await input.accepted;
        if (closed || !ready || !ownsRuntime() || interruptInFlight || turnCompletionSettled
          || ompInput !== input || !ompInputScope || call.nativeSessionId !== nativeId()) {
          throw new Error('Native hook owner input is no longer active');
        }
        const { executedArguments, ...original } = call;
        const previous = input.originalCalls.get(call.callId);
        if (previous && canonicalJson(previous) !== canonicalJson(original)) throw new Error('Native hook changed its original call');
        if (Object.hasOwn(call, 'executedArguments')) {
          if (!previous || !executedArguments) throw new Error('Native execution has no original hook call');
          const executed = input.executedCalls.get(call.callId);
          if (executed && canonicalJson(executed) !== canonicalJson(call)) throw new Error('Native hook changed its executed call');
          // Join the two private-hook snapshots without registering a second
          // canonical observation or replacing the original input. A result
          // attests only what the native hook observed, never scope or success.
          input.executedCalls.set(call.callId, structuredClone(call));
          return;
        }
        if (!previous && input.originalCalls.size >= 1000) throw new Error('Native hook call population exceeds the bound');
        await ompInputScope.observeToolCall({ ...call, nativeInputId: input.id, server: 'papercusp-su' });
        input.originalCalls.set(call.callId, structuredClone(original));
        // Built-ins are deliberately absent from nativeTools. Their genuine
        // original input is observed here but grants no canonical target,
        // resource scope, protected capture receipt or funded turn.
      } } : {}),
      spec: { class: 'agent-session', title: `PUI ${backend} structured engine`, launchedBy: 'pui-su-session',
        sessionId: nativeId() || null,
        argv: [resolvedBinary, ...args],
        harnessSlug: binding.harnessSlug, planSlug: binding.planSlug, cwd: boot.cwd,
        detail: { coordOwnerId: binding.ownerId, advSessionId: binding.advSessionId, transport: 'structured' } },
    });
    if (closed || !ownsRuntime()) { await peer.close(); throw new Error('Structured engine startup was cancelled or replaced'); }
    done = peer.done.catch((error: unknown) => {
      if (!closed) reportRuntimeFailure(error);
      throw error;
    }).finally(async () => {
      ready = false; turnFinished?.();
      void withdrawOmpInput();
      ompRuntimeBearer = undefined;
      await reconcileNativeExit();
      if (!host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: closed, reason: `${backend} connection closed` });
      if (ownsRuntime()) await options.onExit?.();
    });
    void done.catch(() => undefined);
    let actualModel: string;
    if (backend === 'codex') {
      options.stage?.('rpc-initialize');
      await peer.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_pui', title: 'Papercusp PUI', version: '1' } } });
      peer.send({ method: 'initialized', params: {} });
      const params = { cwd: boot.cwd,
        approvalPolicy: options.toolApproval === 'prompt' ? 'on-request' : 'never',
        sandbox: options.toolApproval === 'prompt' ? 'workspace-write' : 'danger-full-access',
        ...(nativeId() ? { threadId: nativeId() } : {}) };
      options.stage?.('rpc-native-thread');
      const result = await peer.request({ method: nativeId() ? 'thread/resume' : 'thread/start', params });
      const thread = object(result.thread), id = string(thread.id);
      nativeForkHistory = thread.historyMode === 'paginated' && typeof thread.forkedFromId === 'string';
      if (!id || nativeId() && id !== nativeId()) throw new Error('Codex did not return the requested native identity');
      if (thread.cwd && resolve(string(thread.cwd)) !== resolve(boot.cwd)) throw new Error('Codex started in a different project');
      nativePath = string(thread.path) || null;
      native = { ...native as CodexNativeSessionHandle, rolloutId: id, exactResumeSupported: false, missingReason: 'Checking native persistence' };
      await (adapter as CodexSuSessionAdapter).materializeRuntime({ nativeSession: { ...native, rolloutId: id }, rolloutPath: nativePath });
      for (const frame of initializingFrames.splice(0)) onMessage(frame);
      initializingFrameBytes = 0;
      if (su) {
        options.stage?.('rpc-su-tools');
        const servers = await peer.request({ method: 'mcpServerStatus/list', params: {} });
        const suServer = (Array.isArray(servers.data) ? servers.data : []).map(object).find((server) => server.name === 'papercusp-su');
        if (!suServer || !Object.keys(object(suServer.tools)).length) throw new Error('Codex SU tools are not connected');
      }
      actualModel = string(result.model);
    } else {
      let state: RpcFrame;
      let id = '';
      let readinessDelayMs = 100;
      // RPC readiness precedes OMP's asynchronous MCP inventory updates.
      // Keep input closed until positive SU connection evidence arrives, using
      // the existing startup deadline. RPC exposes this inventory in get_state.
      while (true) {
        state = await peer.request({ type: 'get_state' });
        const observedId = string(state.sessionId), expectedId = id || nativeId();
        if (!observedId || expectedId && observedId !== expectedId) throw new Error('OMP did not return the requested native identity');
        id = observedId;
        const toolNames = Array.isArray(state.dumpTools) ? state.dumpTools.map((tool) => string(object(tool).name)) : [];
        const promptParts = (Array.isArray(state.systemPrompt) ? state.systemPrompt : [])
          .filter((part): part is string => typeof part === 'string');
        // OMP's current runtime mounts connected MCP tools as xd:// devices;
        // dumpTools lists only top-level tools. The separate generated mapping
        // section comes from its live MCP route registry. OMP can join it into
        // the base prompt string instead of returning a separate array entry.
        const mountedRoutes = promptParts
          .flatMap((part) => part.split(/^## MCP Tool Routes\r?$/m).slice(1))
          .flatMap((section) => section.split(/^#{1,2} /m, 1)[0].match(/xd:\/\/[^`\s]+/g) ?? []);
        const suRoute = mountedRoutes.some((route) => /papercusp[-_]su/i.test(route));
        // The native route map is a bounded preview and can omit this server.
        // OMP separately emits server instructions from MCPManager's connected
        // registry after initialize, including each exact server name. Like
        // Claude's connected status, this is positive native connection evidence.
        const connectedServers = promptParts
          .flatMap((part) => part.split(/^## MCP Server Instructions\r?$/m).slice(1))
          .flatMap((section) => [...section.split(/^#{1,2} /m, 1)[0].matchAll(/^### ([^\r\n]+)\r?$/gm)]
            .map((match) => match[1]));
        // P-016: a coding-assistant session has no SU server to wait for.
        if (su && !toolNames.some((name) => /papercusp/i.test(name)) && !suRoute && !connectedServers.includes('papercusp-su')) {
          ompReadinessFailure = `OMP SU tools are not connected (available: ${toolNames.slice(0, 30).join(', ') || 'none'}; mounted: ${mountedRoutes.slice(0, 8).join(', ') || 'none'})`;
          await new Promise<void>((resolve) => setTimeout(resolve, readinessDelayMs));
          readinessDelayMs = Math.min(readinessDelayMs * 2, 1_000);
          if (closed || !ownsRuntime()) throw new Error('OMP startup was cancelled or replaced before its SU tools connected');
          continue;
        }
        ompReadinessFailure = undefined;
        break;
      }
      nativePath = string(state.sessionFile) || null;
      native = { ...native as OmpNativeSessionHandle, ompThreadId: id, exactResumeSupported: false, missingReason: 'Checking native persistence' };
      const linked = await setAdvSessionOmpThreadId(binding.advSessionId, id);
      if (linked !== 'linked' && linked !== 'already_linked') throw new Error(`OMP native identity link failed (${linked})`);
      await (adapter as OmpSuSessionAdapter).materializeRuntime({ nativeSession: { ...native, ompThreadId: id }, transcriptPath: nativePath });
      if (su && options.resolveRequestPrincipal) {
        const principal = await options.resolveRequestPrincipal();
        if (principal) {
          const { provisionNativeRuntimeBearer } = await import('@papercusp/agent-mcp/provisioning');
          const issued = await provisionNativeRuntimeBearer({ workspaceId: boot.workspaceId,
            advSessionId: binding.advSessionId, issuer: principal }).catch(() => null);
          if (!closed && ownsRuntime() && issued?.binding.provider === 'omp' && issued.binding.ownerId === binding.ownerId
            && issued.binding.workspaceId === boot.workspaceId && issued.binding.advSessionId === binding.advSessionId) {
            ompRuntimeBearer = issued.bearer;
          }
        }
      }
      const model = object(state.model);
      actualModel = [string(model.provider), string(model.id)].filter(Boolean).join('/');
      updateOmpContextWindow(model);
    }
    if (!actualModel) throw new Error('Native engine did not identify its selected model');
    if (backend === 'omp') resolveOmpSessionModel(actualModel, options.accountRoute);
    const requested = splitModelSpec(selectedModel).model;
    if (backend === 'codex' && requested && actualModel !== requested) throw new Error(`Codex selected ${actualModel}, expected ${requested}`);
    if (backend === 'omp' && requested && actualModel !== requested
      && (requested.includes('/') || !actualModel.endsWith(`/${requested}`))) {
      throw new Error(`OMP selected ${actualModel}, expected ${requested}`);
    }
    if (!ownsRuntime()) throw new Error('Structured runtime was replaced during initialization');
    const descriptor = host.descriptor();
    host.emit({ type: 'session', descriptor: { ...descriptor, model: actualModel,
      capabilities: { ...descriptor.capabilities, features: { ...descriptor.capabilities.features,
        'interactive-cards': { state: 'supported', implementation: 'native' },
      } },
    } } as SuSessionEventInput<Backend>);
    options.stage?.('rpc-record-session-owner');
    if (!options.peerFactory) recordSessionOwner(nativeId(), binding.ownerId, { advSessionId: binding.advSessionId });
    options.stage?.('rpc-refresh-resume-evidence');
    await refreshResumeEvidence();
    options.stage?.('rpc-persist-native-descriptor');
    if (!await persistSuSessionDescriptor(binding.advSessionId, host.descriptor(), boot.workspaceId)) {
      throw new Error('Could not persist the native session identity and resume descriptor');
    }
    if (!ownsRuntime()) throw new Error('Structured runtime was replaced during persistence');
    if (options.nativeSession) {
      // The native runtime restores inference context; the adapter restores
      // the owner's visible history before this connection accepts new input.
      // Historical turn completion must not advertise current readiness.
      host.transition('resuming', 'Restoring saved conversation before attaching the executor');
      options.stage?.('rpc-replay-history');
      if (backend === 'codex') {
        if (nativeForkHistory) await (adapter as CodexSuSessionAdapter).consumeThreadHistory(frame => peer!.request(frame));
        else await (adapter as CodexSuSessionAdapter).consumeRolloutSnapshot({ preserveLifecycle: true });
      }
      else await (adapter as OmpSuSessionAdapter).consumeTranscriptSnapshot({ preserveLifecycle: true });
    }
    if (closed || !ownsRuntime()) throw new Error('Structured connection closed or was replaced during startup');
    options.stage?.('rpc-bind-task-identity');
    await peer.bindNativeSession?.(nativeId());
    if (closed || !ownsRuntime()) throw new Error('Structured runtime closed or was replaced while binding its process');
    options.stage?.('rpc-finalize-resume');
    await options.beforeReady?.(peer.pid());
    if (closed || !ownsRuntime()) throw new Error(`${backend} closed or was replaced while finalizing resume`);
    ready = true;
    options.stage?.('rpc-ready');
    host.transition('ready', `${backend} structured stream, SU tools and command executor attached`);
    // WI-10006652 / WI-10007855: /model lists each native engine's catalog. Not
    // awaited: the catalog only enriches the picker, so a slow or refused
    // catalog request must not delay or fail a ready session (the picker then keeps
    // its own menu).
    const listing = peer;
    const models = backend === 'codex'
      ? listCodexModels((frame) => listing.request(frame, options.deliveryTimeoutMs ?? 30_000))
      : listing.request({ type: 'get_available_models' }, options.deliveryTimeoutMs ?? 30_000)
        .then((result) => ompModelOptions(result.models));
    void models.then((rows) => { if (!closed && ownsRuntime()) host.updateModels(rows); })
      .catch(() => undefined);
  })();
  let timer: ReturnType<typeof setTimeout>;
  const readyPromise = Promise.race([starting, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(ompReadinessFailure
      ? new Error(ompReadinessFailure)
      : new SuSessionStartupTimeoutError(`${backend} initialization timed out`)), options.startupTimeoutMs ?? 45_000);
  })]).catch(async (error) => {
    reportRuntimeFailure(error);
    await close(); throw error;
  }).finally(() => clearTimeout(timer));
  return { adapter, ready: readyPromise, get done() { return done; }, close, pid: () => peer?.pid() ?? null, nativeSession: resumeHandle };
}
