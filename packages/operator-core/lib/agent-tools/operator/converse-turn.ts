import { createHash, randomUUID } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { chatEventChannel, parseChatEnvelope, parseStructuredResults, type ChatResultBlock, type ChatEventEnvelope, type ChatEventV1,
  type ChatTurnSource } from '@papercusp/chat-protocol';
import { OperatorChatStore, operatorChatSessionAuthority,
  type OperatorChatCredential, type OperatorChatStoreOptions } from '../../operator-chat-store';
import { mintConverseChatBinding, verifyConverseCardBinding, readConverseCardBinding } from './converse-chat-binding';
import { canonicalToolName } from '../../operator-mcp-tools';
import { canonicalAskChoiceInput } from '../../ask-choice-options';
import { TurnRecovery, type TurnCheckpoint, type TurnIdentity } from '@papercusp/chat-protocol/recovery';
import { operatorChatParentAuthority, operatorChatTurnChannel } from '../../operator-chat-store';
import { hubListen } from '../../pg-listen-hub';

/** References from successful native tool receipts only. Resource content and
 * access are resolved again by the host; private tool bodies never enter chat. */
export function converseToolResultBlocks(result: { name: string; output: string; isError: boolean },
  workspaceId: string): ChatResultBlock[] {
  if (result.isError || !['reports:publish', 'reports:get'].includes(canonicalToolName(result.name))
    || result.output.length > 65536 || !workspaceId) return [];
  let value: unknown = result.output;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return []; }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length !== 1) return [];
      value = value[0]; continue;
    }
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    if (record.isError === true || record.ok === false || record.error != null) return [];
    if (record.ok === true && record.workspace_id === workspaceId && typeof record.report_id === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(record.report_id)) {
      const ref = `report:${record.report_id}`;
      const parsed = parseStructuredResults([{ id: ref, kind: 'report', title: 'Report',
        sources: [{ ref }], actions: [{ id: 'open', kind: 'open', label: 'Open report', ref }] }]);
      return parsed.ok ? parsed.value : [];
    }
    if (record.structuredContent != null) value = record.structuredContent;
    else if (record.content != null) value = record.content;
    else if (record.type === 'text') value = record.text;
    else return [];
  }
  return [];
}
type Parent = Omit<NonNullable<UnifiedToolContext['chatParent']>, 'credentialSha256'>;
type Credential = Extract<OperatorChatCredential, { kind: 'system' | 'pi' }>;

/** Notifications are hints. Subscribe before the first authorized read, and
 * reread on reconnect; neither a connection nor a notification owns execution. */
export async function watchConverseTurn(input: {
  store: Pick<OperatorChatStore, 'read'>; workspaceId: string; identity: TurnIdentity;
  onChange(checkpoint: TurnCheckpoint): Promise<void> | void;
  onError(error: unknown): void;
}, listen = hubListen) {
  let stopped = false, dirty = false;
  let reading: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (reading) return reading;
    reading = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        const checkpoint = await input.store.read(input.identity);
        if (!checkpoint) throw new Error('invalid-state');
        if (!stopped) await input.onChange(checkpoint);
      }
    })().finally(() => { reading = null; });
    return reading;
  };
  const nudge = () => { void refresh().catch(error => { if (!stopped) input.onError(error); }); };
  const stop = await listen(operatorChatTurnChannel(input.workspaceId, input.identity), nudge, nudge);
  try { await refresh(); } catch (error) { stopped = true; stop(); throw error; }
  return { refresh, stop() { stopped = true; stop(); } };
}

/** Reopen only existing durable state. Both the original execution authority
 * and the current responder are checked again on every store operation. */
export async function findConverseTurn(input: {
  sql: OperatorChatStoreOptions['sql']; workspaceId: string; identity: TurnIdentity;
  authorizeAdditional: OperatorChatStoreOptions['authorize']; expectedPrincipalId?: string;
}) {
  const { sql, workspaceId, authorizeAdditional, expectedPrincipalId } = input;
  const identity = { ...input.identity };
  const row = await sql.begin(async tx => {
    if (!await authorizeAdditional(tx)) throw new Error('unauthorized');
    const rows = await tx.unsafe<{ seq: number; chat_state: { execution?: { runId: string; parentAuthority?: Parent['authority'] } } | null }[]>(
      `SELECT t.seq,t.chat_state FROM harness_shared.operator_turns t
        JOIN harness_shared.operator_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
        WHERE t.workspace_id=$1 AND t.conversation_id=$2 AND t.id=$3 AND t.role='assistant'`,
      [workspaceId, identity.conversationId, identity.turnId]);
    return rows[0] ?? null;
  });
  if (!row) return null;
  const authority = row.chat_state?.execution?.parentAuthority;
  if (!authority || !['system', 'pi'].includes(authority.kind)) throw new Error('invalid-state');
  if (expectedPrincipalId && authority.principalId !== expectedPrincipalId) throw new Error('unauthorized');
  const original = operatorChatParentAuthority({ workspaceId, authority,
    capability: 'chat:write', toolName: 'chat:ask_choice' });
  const principalId = authority.principalId;
  const store = new OperatorChatStore({ sql, workspaceId, turn: identity,
    scope: { principalId, tenantId: workspaceId, customerId: principalId, publicOwnerId: principalId },
    // Match interaction mutation's parent -> responder lock order. A current
    // responder never replaces the original execution's authority fence.
    authorize: async tx => await original(tx) && await authorizeAdditional(tx) });
  const checkpoint = await store.read(identity);
  if (!checkpoint) throw new Error('invalid-state');
  const recovery = new TurnRecovery({ capabilities: checkpoint.state.capabilities, store,
    authorize: async () => true, replay: (turn, after) => store.replay(turn, after),
    // The committed cancellation emits the existing PG notification; the
    // execution's listener aborts locally, including on another HTTP worker.
    abortExecution: async () => {} });
  return { store, recovery, identity, runId: row.chat_state!.execution!.runId,
    receipt: { ...identity, seq: row.seq },
    watch: (onChange: Parameters<typeof watchConverseTurn>[0]['onChange'], onError: (error: unknown) => void) =>
      watchConverseTurn({ store, workspaceId, identity, onChange, onError }) };
}

/** The host supplies authenticated authority and scope. No model/URL/card field
 * is an authority input. Reserve the existing PG turn before giving a provider
 * a mount, and retain the ORIGINAL parent credential across child PI mounts. */
export async function admitConverseTurn(input: {
  options: Omit<OperatorChatStoreOptions, 'authorize'>;
  credential: Credential;
  capability: string;
  toolName: string;
  runId: string;
  source: ChatTurnSource;
}) {
  const credential = { ...input.credential };
  const principalId = credential.kind === 'system' ? `system:${credential.name}` : `pi:${credential.sessionId}`;
  if (!credential.bearer || input.options.scope.principalId !== principalId) throw new Error('unauthorized');
  const options = { ...input.options, turn: { ...input.options.turn }, scope: { ...input.options.scope } };
  const runId = input.runId;
  const store = new OperatorChatStore({ ...options,
    authorize: operatorChatSessionAuthority({ workspaceId: options.workspaceId, principalId,
      credential, capability: input.capability, toolName: input.toolName }) });
  const parent: Parent = { workspaceId: options.workspaceId, ...options.turn, runId,
    authority: { kind: credential.kind, principalId,
      credentialSha256: createHash('sha256').update(credential.bearer).digest('hex') } };
  // false is an existing execution, including an uncertain admission ACK.
  // It must enter recovery; it is never permission to launch a second provider.
  if (!await store.beginTurn(runId, input.source, parent.authority)) throw new Error('needs-reconciliation');
  // The existing PG row owns the replay window. Creating its checkpoint is
  // part of admission, before any provider or effect can start. Known event
  // replay does not imply resumable provider execution or general tool replay.
  if (!await store.compareAndSwap(options.turn, null, {
    state: { schemaVersion: 1, ...options.turn, revision: 0, phase: 'running', lastSequence: 0,
      capabilities: { connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: true,
        completedToolCheckpoints: false, interruptedTurnRecovery: false } }, effects: {},
  })) throw new Error('needs-reconciliation');
  let childBearer: string | null = null;
  const associations: Promise<void>[] = [];
  let associationError: unknown = null;
  let sequence = 0, pendingEvents = 0;
  let finalizing = false;
  let eventFailure: { error: unknown } | null = null;
  let events: Promise<void> = Promise.resolve();
  return {
    store,
    identity: { ...options.turn },
    watchCancellation: (abort: () => void, onError: (error: unknown) => void) => watchConverseTurn({
      store, workspaceId: options.workspaceId, identity: options.turn,
      onChange: checkpoint => { if (checkpoint.state.phase === 'cancelled') abort(); }, onError }),
    /** Backpressure provider frames; synchronous result observers join the
     * same bounded queue. A lost commit ACK never publishes or retries an
     * event, and later frames cannot jump the uncertain sequence. */
    async publish(event: ChatEventV1, emit: (committed: ChatEventEnvelope) => void): Promise<void> {
      if (finalizing) throw new Error('turn-result-conflict');
      if (eventFailure) throw eventFailure.error;
      const parsed = parseChatEnvelope({ schemaVersion: 1, ...options.turn,
        eventId: randomUUID(), sequence: sequence + 1, event: structuredClone(event) });
      if (!parsed.ok || chatEventChannel(parsed.value.event.type) !== 'event') throw new Error('invalid-frame');
      // Reuse the existing replay ceiling as the maximum pending population.
      // Normal generator frames await this method, so only synchronous native
      // observers can accumulate more than one pending write.
      if (pendingEvents >= (options.replayLimit ?? 5000)) throw new Error('event-queue-overflow');
      sequence++;
      pendingEvents++;
      const next = events.then(async () => {
        if (eventFailure) throw eventFailure.error;
        const committed = await store.appendEvent(parsed.value);
        emit(committed);
      });
      events = next.catch(error => { eventFailure ??= { error }; }).finally(() => { pendingEvents--; });
      return next;
    },
    async bindMount(mount: { url: string; bearer: string }) {
      const url = new URL(mount.url);
      // The child keeps its own run. Only the separate signed association is
      // attached; raw run/conversation parameters never establish a parent.
      url.searchParams.set('chat_binding', await mintConverseChatBinding(parent, mount.bearer));
      childBearer = mount.bearer;
      return { ...mount, url: url.toString() };
    },
    /** runAgentChat calls this at its exact native result seam. Promise work
     * is retained here because the observer itself is synchronous. */
    observeToolResult(result: { name: string; output: string; isError: boolean; callId?: string }) {
      if (canonicalToolName(result.name) !== 'chat:ask_choice') return;
      const { output, callId, isError } = result;
      const bearer = childBearer;
      associations.push(Promise.resolve().then(async () => {
        const token = readConverseCardBinding(output);
        if (token === null) return;
        if (isError || !bearer || !callId || !callId.trim() || callId.length > 256) {
          throw new Error('invalid-card-binding');
        }
        const binding = await verifyConverseCardBinding(token, { parent, childBearer: bearer });
        if (!binding) throw new Error('invalid-card-binding');
        await store.associateInteractionCall({ ...binding, parent, nativeCallId: callId });
      }).catch(error => { associationError ??= error; }));
    },
    async finalize(result: Omit<Parameters<OperatorChatStore['finalizeTurn']>[0], 'runId'>) {
      finalizing = true;
      await events;
      if (eventFailure && result.status === 'completed') throw eventFailure.error;
      // A native result may have arrived just before the generator closed.
      // Never finalize ahead of its signed association transaction.
      let settled = 0;
      while (settled < associations.length) {
        const pending = associations.slice(settled);
        settled += pending.length;
        await Promise.all(pending);
      }
      if (associationError) throw associationError;
      const tools = result.tools?.map(tool => canonicalToolName(tool.name) === 'chat:ask_choice'
        ? { ...tool, input: canonicalAskChoiceInput(tool.input) ?? tool.input } : tool);
      return store.finalizeTurn({ ...result, ...(tools ? { tools } : {}), runId });
    },
  };
}
