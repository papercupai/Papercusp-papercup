import type postgres from 'postgres';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalJson } from './external-bench/reproducibility/canonical-json';
import type { ParsedReport } from './operator-converse-tags';
import { coerceAskChoiceOptions } from './ask-choice-options';
import { canonicalToolName } from './operator-mcp-tools';
import { readSuperuserToken } from './superuser-token';
import { chatEventChannel, collectTurnResults, parseChatEnvelope, parseChatState, parseStructuredResults,
  type ChatEventEnvelope, type ChatResultBlock, type ChatTurnSource, type ChatTurnToolCall } from '@papercusp/chat-protocol';
import type { DispatchAdmission, ReplayWindow, TurnCheckpoint, TurnCheckpointStore,
  TurnIdentity } from '@papercusp/chat-protocol/recovery';
import type { InteractionIdentity, InteractionMutation, InteractionRecord, InteractionResult,
  InteractionScope, InteractionStore } from '@papercusp/chat-protocol/interactions';

type Tx = postgres.TransactionSql;
type ParentAuthority = NonNullable<UnifiedToolContext['chatParent']>['authority'];
type ChatParent = Omit<NonNullable<UnifiedToolContext['chatParent']>, 'credentialSha256'>;
/** Host-authenticated identities, never a name/argument/event-order match.
 * The current child and parent authority must still be checked by authorize. */
export interface OperatorChatInteractionBinding {
  dispatchCallId: string;
  childRunId: string;
  credentialSha256: string;
  nativeCallId?: string;
}
interface StoredTurn {
  schemaVersion: 1;
  scope: InteractionScope;
  checkpoint: TurnCheckpoint | null;
  events: ChatEventEnvelope[];
  /** Durable materialized result view survives the bounded replay window. */
  results?: ChatResultBlock[];
  interactions: Record<string, InteractionRecord>;
  interactionBindings?: Record<string, OperatorChatInteractionBinding>;
  execution?: {
    runId: string;
    source: ChatTurnSource;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    finalDigest: string | null;
    /** Lookup descriptor only. Original parent authority survives child mounts
     * and worker replacement without copying its bearer into conversation data. */
    parentAuthority?: ParentAuthority;
  };
}
interface LockedTurn { chat_state: unknown }
class OperatorChatAuthorizationError extends Error {
  constructor() { super('unauthorized'); }
}

export interface OperatorChatStoreOptions {
  sql: postgres.Sql;
  workspaceId: string;
  turn: TurnIdentity;
  scope: InteractionScope;
  /** Resolve current host authority and lock its session/ACL rows in THIS
   * transaction. Revocation must serialize with that same authority fence.
   * No permission is inferred from a turn, card, model event or scope string. */
  authorize(tx: Tx): Promise<boolean>;
  /** Existing converse replay policy is 5000. Smaller windows exercise eviction;
   * a caller cannot widen the production ceiling. */
  replayLimit?: number;
}

/** Credentials are captured by the host at admission, never supplied by a
 * card/model payload. The current rows, rather than a cached Principal, are
 * rechecked under the same lock as each read, decision and dispatch. */
export type OperatorChatCredential =
  | { kind: 'user-session'; token: string; userId: string }
  /** Host-only, captured after the existing local-request perimeter check.
   * The request adapter must also recheck current workspace/locality. */
  | { kind: 'local-desktop'; userId: string }
  | { kind: 'system'; bearer: string; name: string }
  | { kind: 'pi'; bearer: string; sessionId: string };

export function operatorChatSessionAuthority(input: {
  workspaceId: string; principalId: string; credential: OperatorChatCredential;
  capability: string; toolName: string;
}): OperatorChatStoreOptions['authorize'] {
  const { workspaceId, principalId, capability, toolName } = input;
  const credential = { ...input.credential };
  const hash = credential.kind === 'user-session' || credential.kind === 'local-desktop' ? null
    : createHash('sha256').update(credential.bearer).digest('hex');
  return async tx => {
    if (!workspaceId || !principalId || !capability || !toolName) return false;
    if (credential.kind === 'local-desktop') {
      if (!credential.userId || credential.userId !== principalId) return false;
      // The trusted desktop has no cookie or session capability row. Its
      // authority is the active seeded account, serialized with deactivation.
      const users = await tx.unsafe(`SELECT id FROM harness_shared.users
        WHERE id=$1 AND username='default' AND is_active=true FOR SHARE`, [principalId]);
      return users.length === 1;
    }
    let rows: Array<{ capabilities: unknown; allowed_tools?: unknown }>;
    if (credential.kind === 'user-session') {
      if (!credential.token || credential.userId !== principalId) return false;
      rows = await tx.unsafe(`SELECT s.capabilities FROM harness_shared.user_sessions s
        JOIN harness_shared.users u ON u.id=s.user_id
        WHERE s.token=$1 AND s.workspace_id=$2 AND s.user_id=$3
          AND s.expires_at>clock_timestamp() AND u.is_active=true FOR SHARE OF s,u`,
      [credential.token, workspaceId, principalId]);
    } else if (credential.kind === 'system') {
      if (!credential.bearer || principalId !== `system:${credential.name}`) return false;
      rows = await tx.unsafe(`SELECT capabilities FROM harness_shared.system_principals
        WHERE workspace_id=$1 AND name=$2 AND bearer_hash=$3 FOR SHARE`,
      [workspaceId, credential.name, hash]);
    } else {
      if (!credential.bearer || principalId !== `pi:${credential.sessionId}`) return false;
      rows = await tx.unsafe(`SELECT capabilities,allowed_tools FROM harness_shared.pi_sessions
        WHERE workspace_id=$1 AND session_id=$2 AND bearer_hash=$3 AND ended_at IS NULL
          AND expires_at>clock_timestamp() FOR SHARE`, [workspaceId, credential.sessionId, hash]);
    }
    const row = rows[0];
    // Match the existing dispatcher: only the exact capability or '*' grants;
    // PI allowed_tools is an exact tool-name allowlist, never a glob.
    const allowed = !!row && Array.isArray(row.capabilities)
      && (row.capabilities.includes('*') || row.capabilities.includes(capability))
      && (row.allowed_tools == null || (Array.isArray(row.allowed_tools) && row.allowed_tools.includes(toolName)));
    if (!allowed) return false;
    if (credential.kind === 'user-session') return true;
    // resolveBearer first resolves token_index identity. Recheck that identity
    // too: deleting it revokes a credential even if its capability row remains.
    // Lock session/principal first, then identity, matching endPiSession's order.
    const identities = await tx.unsafe(`SELECT token FROM harness_shared.token_index
      WHERE token=$1 AND kind=$2 AND harness_slug=$3 AND workspace_id=$4 FOR SHARE`,
    [credential.bearer, credential.kind, principalId, workspaceId]);
    return identities.length === 1;
  };
}

/** A child carries a signed fingerprint, never its parent's raw credential.
 * Resolve that exact credential only as lookup data, then reuse the existing
 * authority fence. In particular, do NOT lock token_index before the session:
 * every caller must keep session/principal -> identity lock order. */
export function operatorChatParentAuthority(input: {
  workspaceId: string;
  authority: NonNullable<UnifiedToolContext['chatParent']>['authority'];
  capability: string;
  toolName: string;
}): OperatorChatStoreOptions['authorize'] {
  const { workspaceId, capability, toolName } = input;
  const authority = { ...input.authority };
  return async tx => {
    if (!workspaceId || !['system', 'pi'].includes(authority.kind)
      || !authority.principalId.startsWith(`${authority.kind}:`)
      || !/^[a-f0-9]{64}$/.test(authority.credentialSha256)) return false;
    const name = authority.principalId.slice(authority.kind.length + 1);
    if (!name) return false;
    const rows = await tx.unsafe<{ token: string }[]>(`SELECT token FROM harness_shared.token_index
      WHERE kind=$1 AND harness_slug=$2 AND workspace_id=$3
        AND encode(sha256(convert_to(token,'UTF8')),'hex')=$4`,
    [authority.kind, authority.principalId, workspaceId, authority.credentialSha256]);
    if (rows.length !== 1) return false;
    const bearer = rows[0].token;
    return operatorChatSessionAuthority({ workspaceId, principalId: authority.principalId,
      capability, toolName, credential: authority.kind === 'system'
        ? { kind: 'system', name, bearer } : { kind: 'pi', sessionId: name, bearer } })(tx);
  };
}

/** Resolve the child mount's signed fingerprint against CURRENT credentials.
 * Owner MCP mounts use the existing SU token file, which is intentionally
 * absent from token_index. PI mounts reuse the existing session/capability
 * fence. Callers must compose this with the ORIGINAL parent authority (and
 * the human responder's current authority on decision ingress). A signed
 * fingerprint or a stored interaction is never itself a capability grant. */
export function operatorChatChildAuthority(input: {
  workspaceId: string; credentialSha256: string; capability: string; toolName: string;
}): OperatorChatStoreOptions['authorize'] {
  const { workspaceId, credentialSha256, capability, toolName } = input;
  return async tx => {
    if (!workspaceId || workspaceId === '*' || !capability || !toolName
      || !/^[a-f0-9]{64}$/.test(credentialSha256)) return false;
    const superuser = readSuperuserToken();
    if (superuser && createHash('sha256').update(superuser).digest('hex') === credentialSha256) return true;
    // Lookup without locking the identity first: endPiSession locks session
    // then token_index. Reuse that order in operatorChatSessionAuthority.
    const rows = await tx.unsafe<{ token: string; harness_slug: string }[]>(`SELECT token,harness_slug
      FROM harness_shared.token_index WHERE kind='pi' AND workspace_id=$1
        AND encode(sha256(convert_to(token,'UTF8')),'hex')=$2`, [workspaceId, credentialSha256]);
    if (rows.length !== 1 || !rows[0].harness_slug.startsWith('pi:')) return false;
    const principalId = rows[0].harness_slug;
    return operatorChatSessionAuthority({ workspaceId, principalId, capability, toolName,
      credential: { kind: 'pi', bearer: rows[0].token, sessionId: principalId.slice(3) } })(tx);
  };
}

/** Persist the existing ask_choice answered marker and card_pick user turn in
 * the decision transaction, as turn-answer does. callId is the stable host
 * interaction identity; an unrelated or already answered tool cannot advance.
 * This callback performs no external effect and needs no in-memory waiter. */
export function operatorChatTurnWorkflow(input: { workspaceId: string; turn: TurnIdentity }):
  (tx: Tx, next: InteractionRecord) => Promise<void> {
  const workspaceId = input.workspaceId;
  const turn = { ...input.turn };
  return async (tx, next) => {
    if (next.conversationId !== turn.conversationId || next.status !== 'resolved' || !next.decision) {
      throw new Error('invalid-workflow-transition');
    }
    const rows = await tx.unsafe<{ tools: unknown; chat_state: unknown }[]>(`SELECT tools,chat_state FROM harness_shared.operator_turns
      WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND role='assistant' FOR UPDATE`,
    [turn.turnId, turn.conversationId, workspaceId]);
    const tools = rows[0]?.tools;
    if (!Array.isArray(tools)) throw new Error('invalid-workflow-transition');
    const state = rows[0].chat_state;
    const bindings = object(state) && object(state.interactionBindings) ? state.interactionBindings : null;
    const binding = bindings && Object.hasOwn(bindings, next.correlationId) ? bindings[next.correlationId] : null;
    // Modern converse cards require an explicit host dispatch binding. Keep
    // correlation-as-call only for legacy rows without a parent association.
    if (object(state) && object(state.execution) && state.execution.parentAuthority && !binding) {
      throw new Error('invalid-workflow-transition');
    }
    if (binding && !validInteractionBinding(binding)) throw new Error('invalid-workflow-transition');
    const callIds = validInteractionBinding(binding)
      ? [binding.dispatchCallId, ...(binding.nativeCallId ? [binding.nativeCallId] : [])] : [next.correlationId];
    const matches = tools.filter(tool => object(tool) && callIds.includes(tool.callId as string)
      && typeof tool.name === 'string' && canonicalToolName(tool.name) === 'chat:ask_choice');
    if (matches.length !== 1 || matches[0].answered) throw new Error('invalid-workflow-transition');
    const tool = matches[0] as Record<string, unknown>;
    const args = object(tool.input) ? tool.input : object(tool.args) ? tool.args : {};
    const options = coerceAskChoiceOptions(args.options);
    const response = next.decision.response;
    const ids = response.action === 'submit' ? response.value.picks : [];
    if (!Array.isArray(ids) || (response.action === 'submit'
      && (ids.length < 1 || ids.length > 6 || (args.multi !== true && ids.length !== 1)
        || new Set(ids).size !== ids.length))) throw new Error('invalid-workflow-answer');
    const picks = ids.map(id => {
      const option = options?.find(option => typeof option.id === 'string' && option.id.toLowerCase() === id);
      if (typeof id !== 'string' || !option || typeof option.label !== 'string') throw new Error('invalid-workflow-answer');
      return { option_id: id, label: option.label };
    });
    tool.answered = { picks, ...(response.action !== 'submit' ? { declined: true } : {}), at: next.decision.decidedAt };
    await tx.unsafe(`UPDATE harness_shared.operator_turns SET tools=$1::jsonb
      WHERE id=$2 AND conversation_id=$3 AND workspace_id=$4`,
    [tx.json(tools), turn.turnId, turn.conversationId, workspaceId]);
    // OperatorChatStore holds the parent conversation FOR UPDATE, serializing
    // this sequence allocation with other shared-port decisions in the thread.
    await tx.unsafe(`INSERT INTO harness_shared.operator_turns
      (conversation_id,seq,role,text,source,created_at,workspace_id)
      SELECT $1,COALESCE(MAX(seq),-1)+1,'user',$2,'card_pick',$3,$4
        FROM harness_shared.operator_turns WHERE conversation_id=$1`,
    [turn.conversationId, response.action === 'submit' ? picks.map(pick => pick.label).join(' · ')
      : response.action === 'cancel' ? 'Cancelled' : 'Skipped', Math.trunc(next.decision.decidedAt), workspaceId]);
  };
}

const sameTurn = (a: TurnIdentity, b: TurnIdentity) =>
  a.conversationId === b.conversationId && a.turnId === b.turnId;
/** Opaque, bounded PG channel; no credential or interaction payload travels
 * on the wake bus. Subscribers always reread under current authority. */
export const operatorChatTurnChannel = (workspaceId: string, turn: TurnIdentity) =>
  `pc_chat_${createHash('sha256').update(canonicalJson({ workspaceId, ...turn })).digest('hex').slice(0, 48)}`;
/** Same wake plane for workspace snapshot readers, including new cards whose
 * turn/run was unknown when a reader connected. Payloads remain opaque hints. */
export const operatorChatWorkspaceChannel = (workspaceId: string) =>
  `pc_chat_${createHash('sha256').update(canonicalJson({ workspaceId })).digest('hex').slice(0, 48)}`;
const sameScope = (a: InteractionScope, b: InteractionScope) =>
  ['principalId', 'tenantId', 'customerId', 'publicOwnerId'].every(key =>
    a[key as keyof InteractionScope] === b[key as keyof InteractionScope]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validParentAuthority = (value: unknown): value is ParentAuthority => object(value)
  && (value.kind === 'system' || value.kind === 'pi') && typeof value.principalId === 'string'
  && value.principalId.startsWith(`${value.kind}:`) && value.principalId.length > value.kind.length + 1
  && typeof value.credentialSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.credentialSha256)
  && Object.keys(value).every(key => ['kind', 'principalId', 'credentialSha256'].includes(key));
const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const validInteractionBinding = (value: unknown): value is OperatorChatInteractionBinding => object(value)
  && validId(value.dispatchCallId) && validId(value.childRunId)
  && typeof value.credentialSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.credentialSha256)
  && (value.nativeCallId === undefined || validId(value.nativeCallId))
  && Object.keys(value).every(key => ['dispatchCallId', 'childRunId', 'credentialSha256', 'nativeCallId'].includes(key));
const sameParent = (state: StoredTurn, parent: ChatParent, workspaceId: string, turn: TurnIdentity) =>
  parent.workspaceId === workspaceId && sameTurn(parent, turn) && parent.runId === state.execution?.runId
  && !!state.execution?.parentAuthority && isDeepStrictEqual(parent.authority, state.execution.parentAuthority);

/** PG implementation of shared ports, embedded in operator_turns. Instances
 * bind to authenticated host scope and an existing turn; no local cache is an
 * authority for completed effects or decisions after worker replacement. */
export class OperatorChatStore implements TurnCheckpointStore {
  private readonly options: OperatorChatStoreOptions;
  private readonly replayLimit: number;

  constructor(options: OperatorChatStoreOptions) {
    const limit = options.replayLimit ?? 5000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('invalid-replay-limit');
    this.replayLimit = limit;
    this.options = { ...options, turn: { ...options.turn }, scope: { ...options.scope } };
  }

  /** Discover an exact persisted binding within the authenticated URL scope.
   * This is lookup data only: the returned adapter must recheck original
   * parent, current child and responder in every read/decision transaction. */
  static async findInteraction(input: {
    sql: postgres.Sql; workspaceId: string; conversationId: string; correlationId: string;
    authorize: OperatorChatStoreOptions['authorize'];
  }): Promise<{ parent: ChatParent; binding: OperatorChatInteractionBinding; tool: ChatTurnToolCall } | null> {
    const { sql, workspaceId, conversationId, correlationId, authorize } = input;
    if (!validId(workspaceId) || workspaceId === '*' || !validId(correlationId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)) return null;
    return sql.begin(async tx => {
      if (!await authorize(tx)) throw new OperatorChatAuthorizationError();
      const rows = await tx.unsafe<{ id: string; tools: ChatTurnToolCall[]; chat_state: unknown }[]>(
        `SELECT t.id,t.tools,t.chat_state FROM harness_shared.operator_turns t
          JOIN harness_shared.operator_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
          WHERE t.workspace_id=$1 AND t.conversation_id=$2 AND t.role='assistant'
            AND (t.chat_state->'interactionBindings') ? $3 LIMIT 2`,
        [workspaceId, conversationId, correlationId]);
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error('interaction-binding-conflict');
      const row = rows[0];
      if (!object(row.chat_state) || !object(row.chat_state.execution)
        || !validParentAuthority(row.chat_state.execution.parentAuthority)) throw new Error('invalid-state');
      const authority = row.chat_state.execution.parentAuthority;
      const scope: InteractionScope = { principalId: authority.principalId, tenantId: workspaceId,
        customerId: authority.principalId, publicOwnerId: authority.principalId };
      const turn = { conversationId, turnId: row.id };
      const state = new OperatorChatStore({ sql, workspaceId, turn, scope, authorize }).decode(row.chat_state);
      const binding = state.interactionBindings![correlationId];
      const matches = Array.isArray(row.tools) ? row.tools.filter(tool =>
        tool.callId === (binding.nativeCallId ?? binding.dispatchCallId)
          && canonicalToolName(tool.name) === 'chat:ask_choice') : [];
      // Before finalization the history still carries dispatch identity even
      // if a native result has just supplied its exact association.
      if (matches.length === 0 && binding.nativeCallId) matches.push(...row.tools.filter(tool =>
        tool.callId === binding.dispatchCallId && canonicalToolName(tool.name) === 'chat:ask_choice'));
      if (matches.length !== 1) throw new Error('interaction-binding-conflict');
      return structuredClone({ parent: { workspaceId, ...turn, runId: state.execution!.runId, authority },
        binding, tool: matches[0] });
    }) as Promise<{ parent: ChatParent; binding: OperatorChatInteractionBinding; tool: ChatTurnToolCall } | null>;
  }

  /** Reserve the assistant row BEFORE starting a provider. Only the creator
   * may launch it: an existing admission is recovery, never a second launch.
   * runId belongs to host execution, independently of durable turn identity. */
  async beginTurn(runId: string, source: ChatTurnSource, parentAuthority?: ParentAuthority): Promise<boolean> {
    if (!runId.trim() || !['text_typed', 'voice_stt', 'voice_tts', 'system'].includes(source)) {
      throw new Error('invalid-turn-admission');
    }
    const { turn, workspaceId, scope } = this.options;
    const authority = parentAuthority === undefined ? undefined : structuredClone(parentAuthority);
    if (authority !== undefined && (!validParentAuthority(authority) || authority.principalId !== scope.principalId)) {
      throw new OperatorChatAuthorizationError();
    }
    // Legacy appendTurn writers allocate MAX(seq)+1 without the parent lock.
    // A collision rolls back THIS transaction; retry only that unique error.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await this.options.sql.begin(async tx => {
          if (!await this.options.authorize(tx)) throw new OperatorChatAuthorizationError();
          const parents = await tx.unsafe(`SELECT id FROM harness_shared.operator_conversations
            WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [turn.conversationId, workspaceId]);
          if (!parents[0]) throw new OperatorChatAuthorizationError();
          const state: StoredTurn = { schemaVersion: 1, scope, checkpoint: null, events: [], interactions: {},
            execution: { runId, source, status: 'running', finalDigest: null,
              ...(authority ? { parentAuthority: authority } : {}) } };
          const inserted = await tx.unsafe(`INSERT INTO harness_shared.operator_turns
            (id,conversation_id,workspace_id,seq,role,text,source,created_at,tools,chat_state)
            SELECT $1,$2,$3,COALESCE(MAX(seq),-1)+1,'assistant','',$4,$5,'[]'::jsonb,$6::jsonb
              FROM harness_shared.operator_turns WHERE conversation_id=$2
            ON CONFLICT(id) DO NOTHING RETURNING id`,
          [turn.turnId, turn.conversationId, workspaceId, source, Date.now(), tx.json(state as unknown as postgres.JSONValue)]);
          if (inserted[0]) return true;
          const rows = await tx.unsafe<LockedTurn[]>(`SELECT chat_state FROM harness_shared.operator_turns
            WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND role='assistant' FOR UPDATE`,
          [turn.turnId, turn.conversationId, workspaceId]);
          if (!rows[0]) throw new OperatorChatAuthorizationError();
          const existing = this.decode(rows[0].chat_state).execution;
          // A legacy row or an unrelated execution may never be adopted.
          if (!existing || existing.runId !== runId || existing.source !== source
            || !isDeepStrictEqual(existing.parentAuthority, authority)) throw new Error('turn-run-conflict');
          return false;
        }) as boolean;
      } catch (error) {
        if ((error as { code?: string }).code !== '23505' || attempt === 9) throw error;
      }
    }
    throw new Error('turn-admission-conflict');
  }

  /** One atomic terminal transition updates the existing history row and its
   * recovery state. Retrying an acknowledged/lost commit cannot erase later
   * card answers; the immutable digest acknowledges exactly the same result. */
  async finalizeTurn(input: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    text: string;
    tools?: ChatTurnToolCall[];
    report?: ParsedReport | null;
  }): Promise<TurnIdentity & { seq: number }> {
    const runId = input.runId;
    const payload = structuredClone({ status: input.status, text: input.text, tools: input.tools ?? [], report: input.report ?? null });
    if (!['completed', 'failed', 'cancelled'].includes(payload.status) || typeof payload.text !== 'string'
      || !Array.isArray(payload.tools) || !isDeepStrictEqual(payload, JSON.parse(JSON.stringify(payload)))) {
      throw new Error('invalid-turn-result');
    }
    const callIds = new Set<string>();
    for (const tool of payload.tools) {
      if (!object(tool) || !validId(tool.name) || (tool.callId !== undefined
        && (!validId(tool.callId) || callIds.has(tool.callId)))) throw new Error('invalid-turn-result');
      if (tool.callId !== undefined) callIds.add(tool.callId);
    }
    const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return this.locked(this.options.turn, async (tx, state) => {
      const execution = state.execution;
      if (!execution || execution.runId !== runId) throw new Error('turn-run-conflict');
      const rows = await tx.unsafe<{ seq: number; tools: ChatTurnToolCall[] | null }[]>(`SELECT seq,tools FROM harness_shared.operator_turns
        WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3`,
      [this.options.turn.turnId, this.options.turn.conversationId, this.options.workspaceId]);
      const receipt = { ...this.options.turn, seq: rows[0].seq };
      if (execution.status !== 'running') {
        if (execution.status !== payload.status || execution.finalDigest !== digest) throw new Error('turn-result-conflict');
        return receipt;
      }
      if (state.checkpoint && state.checkpoint.state.phase !== 'running'
        && state.checkpoint.state.phase !== 'awaiting-input'
        && state.checkpoint.state.phase !== payload.status) throw new Error('turn-result-conflict');
      // A card can resolve while its provider turn is still streaming. Keep
      // that durable answer, but only for the exact same call and payload.
      const tools = structuredClone(payload.tools);
      const bindings = Object.values(state.interactionBindings ?? {});
      if (payload.status === 'completed' && bindings.some(binding => !binding.nativeCallId)) {
        throw new Error('interaction-call-unassociated');
      }
      for (const previous of rows[0]?.tools ?? []) {
        const binding = bindings.find(binding => binding.dispatchCallId === previous.callId);
        if (!previous.answered && !binding) continue;
        const callId = binding?.nativeCallId ?? previous.callId;
        const matches = tools.filter(tool => callId && tool.callId === callId
          && canonicalToolName(tool.name) === canonicalToolName(previous.name)
          && isDeepStrictEqual(tool.input, previous.input));
        // Abort/provider failure may precede the native completed-item event.
        // Preserve the prepared row and any committed answer under its known
        // identity; never pair it with another same-named streamed call.
        if (binding && payload.status !== 'completed' && !tools.some(tool => tool.callId === callId)) {
          tools.push({ ...previous, callId });
          continue;
        }
        if (matches.length !== 1) throw new Error('turn-result-conflict');
        if (previous.answered) matches[0].answered = previous.answered;
      }
      execution.status = payload.status;
      execution.finalDigest = digest;
      if (state.checkpoint) {
        state.checkpoint.state.phase = payload.status;
        state.checkpoint.state.revision++;
      }
      if (payload.status !== 'completed') {
        for (const [id, record] of Object.entries(state.interactions)) {
          if (record.status === 'pending') state.interactions[id] = { ...record, revision: record.revision + 1, status: 'cancelled' };
        }
      }
      await tx.unsafe(`UPDATE harness_shared.operator_turns SET text=$1,tools=$2::jsonb,report=$3::jsonb
        WHERE id=$4 AND conversation_id=$5 AND workspace_id=$6 AND role='assistant'`,
      [payload.text, tx.json(tools as unknown as postgres.JSONValue),
        payload.report === null ? null : tx.json(payload.report as unknown as postgres.JSONValue),
        this.options.turn.turnId, this.options.turn.conversationId, this.options.workspaceId]);
      await this.save(tx, state);
      return receipt;
    });
  }

  private decode(value: unknown): StoredTurn {
    if (value === null) return { schemaVersion: 1, scope: { ...this.options.scope }, checkpoint: null, events: [], interactions: {} };
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.events)
      || !object(value.interactions) || !Object.hasOwn(value, 'checkpoint')) throw new Error('invalid-state');
    if (!object(value.scope) || !sameScope(value.scope as unknown as InteractionScope, this.options.scope)) {
      throw new OperatorChatAuthorizationError();
    }
    if (value.execution !== undefined && (!object(value.execution)
      || typeof value.execution.runId !== 'string' || !value.execution.runId.trim()
      || !['text_typed', 'voice_stt', 'voice_tts', 'system'].includes(value.execution.source as string)
      || !['running', 'completed', 'failed', 'cancelled'].includes(value.execution.status as string)
      || (value.execution.status === 'running' ? value.execution.finalDigest !== null
        : typeof value.execution.finalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.execution.finalDigest)))) {
      throw new Error('invalid-state');
    }
    if (object(value.execution) && value.execution.parentAuthority !== undefined
      && (!validParentAuthority(value.execution.parentAuthority)
        || value.execution.parentAuthority.principalId !== this.options.scope.principalId)) throw new Error('invalid-state');
    if (value.checkpoint !== null && (!object(value.checkpoint)
      || !parseChatState(value.checkpoint.state).ok
      || !sameTurn(value.checkpoint.state as unknown as TurnIdentity, this.options.turn)
      || !object(value.checkpoint.effects))) throw new Error('invalid-state');
    const events = value.events;
    if (events.length > this.replayLimit || events.some((event, i) => {
      const parsed = parseChatEnvelope(event);
      return !parsed.ok || !sameTurn(parsed.value, this.options.turn)
        || chatEventChannel(parsed.value.event.type) !== 'event'
        || (i > 0 && parsed.value.sequence !== (events[i - 1] as ChatEventEnvelope).sequence + 1);
    })) throw new Error('invalid-state');
    const stored = structuredClone(value) as unknown as StoredTurn;
    if (stored.results !== undefined && (!Array.isArray(stored.results)
      || (stored.results.length > 0 && !parseStructuredResults(stored.results).ok))) throw new Error('invalid-state');
    if (stored.interactionBindings !== undefined) {
      if (!object(stored.interactionBindings)) throw new Error('invalid-state');
      const dispatches = new Set<string>(), nativeCalls = new Set<string>();
      for (const [correlationId, binding] of Object.entries(stored.interactionBindings)) {
        if (!validId(correlationId) || !Object.hasOwn(stored.interactions, correlationId)
          || !validInteractionBinding(binding) || dispatches.has(binding.dispatchCallId)
          || (binding.nativeCallId !== undefined && nativeCalls.has(binding.nativeCallId))) throw new Error('invalid-state');
        dispatches.add(binding.dispatchCallId);
        if (binding.nativeCallId !== undefined) nativeCalls.add(binding.nativeCallId);
      }
    }
    if (stored.events.length && (!stored.checkpoint
      || stored.events.at(-1)!.sequence !== stored.checkpoint.state.lastSequence)) throw new Error('invalid-state');
    return stored;
  }

  private async locked<T>(identity: TurnIdentity,
    run: (tx: Tx, state: StoredTurn) => Promise<T>): Promise<T> {
    if (!sameTurn(identity, this.options.turn)) throw new OperatorChatAuthorizationError();
    return this.options.sql.begin(async tx => {
      if (!await this.options.authorize(tx)) throw new OperatorChatAuthorizationError();
      // Admission, normal mutation and card decisions share parent→turn lock
      // order. A planner-selected join order must not invert this fence.
      const parents = await tx.unsafe(`SELECT id FROM harness_shared.operator_conversations
        WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [identity.conversationId, this.options.workspaceId]);
      if (!parents[0]) throw new OperatorChatAuthorizationError();
      const rows = await tx.unsafe<LockedTurn[]>(
        `SELECT chat_state FROM harness_shared.operator_turns
          WHERE id = $1 AND conversation_id = $2 AND workspace_id = $3 AND role='assistant'
          FOR UPDATE`,
        [identity.turnId, identity.conversationId, this.options.workspaceId]);
      if (!rows[0]) throw new OperatorChatAuthorizationError();
      return run(tx, this.decode(rows[0].chat_state));
    }) as Promise<T>;
  }

  private async save(tx: Tx, state: StoredTurn, notifyCards = false): Promise<void> {
    // Serialization failure aborts the transaction and never acknowledges success.
    const json = JSON.parse(JSON.stringify(state));
    // JSON.stringify silently turns NaN into null, drops undefined and converts
    // Dates. Those changes cannot acknowledge the original completed result.
    if (!isDeepStrictEqual(state, json)) throw new Error('invalid-json-state');
    await tx.unsafe(`UPDATE harness_shared.operator_turns SET chat_state = $1::jsonb
      WHERE id = $2 AND conversation_id = $3 AND workspace_id = $4`,
    [tx.json(json), this.options.turn.turnId, this.options.turn.conversationId, this.options.workspaceId]);
    // NOTIFY is delivered only on COMMIT, including writes whose caller loses
    // its ACK. Rollback cannot wake a waiter with an uncommitted decision.
    await tx.unsafe('SELECT pg_notify($1,$2)',
      [operatorChatTurnChannel(this.options.workspaceId, this.options.turn), 'changed']);
    if (notifyCards) await tx.unsafe('SELECT pg_notify($1,$2)',
      [operatorChatWorkspaceChannel(this.options.workspaceId), 'changed']);
  }

  async read(identity: TurnIdentity): Promise<TurnCheckpoint | null> {
    return this.locked(identity, async (_tx, state) => state.checkpoint);
  }

  async compareAndSwap(identity: TurnIdentity, revision: number | null, next: TurnCheckpoint): Promise<boolean> {
    const candidate = structuredClone(next);
    if (!parseChatState(candidate.state).ok || !sameTurn(candidate.state, identity)
      || candidate.state.revision !== (revision === null ? 0 : revision + 1)) throw new Error('invalid-state');
    return this.locked(identity, async (tx, state) => {
      if ((state.checkpoint?.state.revision ?? null) !== revision) return false;
      if (state.execution && state.execution.status !== 'running'
        && candidate.state.phase !== state.execution.status) return false;
      if (candidate.state.lastSequence !== (state.checkpoint?.state.lastSequence ?? 0)) throw new Error('invalid-state');
      state.checkpoint = candidate;
      if (candidate.state.phase === 'cancelled') {
        for (const [id, record] of Object.entries(state.interactions)) {
          if (record.status === 'pending') state.interactions[id] = { ...record, revision: record.revision + 1, status: 'cancelled' };
        }
      }
      await this.save(tx, state);
      return true;
    });
  }

  async admitDispatch<T>(identity: TurnIdentity, effectId: string, claimRevision: number,
    launch: () => Promise<T>): Promise<DispatchAdmission<T>> {
    try { return await this.locked<DispatchAdmission<T>>(identity, async (tx, state) => {
      const checkpoint = state.checkpoint;
      const effect = checkpoint && Object.hasOwn(checkpoint.effects, effectId) ? checkpoint.effects[effectId] : undefined;
      if (checkpoint?.state.phase === 'cancelled') return { admitted: false, reason: 'cancelled' };
      if (checkpoint?.state.phase !== 'running' || effect?.status !== 'dispatching'
        || effect.claimRevision !== claimRevision || effect.admitted) return { admitted: false, reason: 'conflict' };
      effect.admitted = true;
      checkpoint.state.revision++;
      await this.save(tx, state);
      // Launch once while cancellation is fenced. Never await an external
      // effect under the PG lock. A failed commit after launch is uncertain;
      // the shared coordinator refuses to retry its existing dispatch claim.
      let result: Promise<T>;
      try { result = launch(); } catch (error) { result = Promise.reject(error); }
      void result.catch(() => {});
      return { admitted: true, result };
    }); } catch (error) {
      if (error instanceof OperatorChatAuthorizationError) return { admitted: false, reason: 'unauthorized' };
      throw error;
    }
  }

  /** Sequence CAS reconciles ack loss without inventing another event id. */
  async appendEvent(input: ChatEventEnvelope): Promise<ChatEventEnvelope> {
    const parsed = parseChatEnvelope(structuredClone(input));
    if (!parsed.ok || chatEventChannel(parsed.value.event.type) !== 'event') throw new Error('invalid-frame');
    const event = parsed.value;
    return this.locked(event, async (tx, state) => {
      const checkpoint = state.checkpoint;
      if (!checkpoint) throw new Error('invalid-state');
      if (event.sequence <= checkpoint.state.lastSequence) {
        const prior = state.events.find(item => item.sequence === event.sequence);
        if (!prior) throw new Error('replay-expired');
        if (!isDeepStrictEqual(prior, event)) throw new Error('event-conflict');
        return prior;
      }
      if (checkpoint.state.phase === 'cancelled') throw new Error('cancelled');
      if (state.execution && state.execution.status !== 'running') throw new Error('turn-result-conflict');
      if (event.sequence !== checkpoint.state.lastSequence + 1
        || state.events.some(item => item.eventId === event.eventId)) throw new Error('event-conflict');
      checkpoint.state.lastSequence = event.sequence;
      checkpoint.state.revision++;
      if (event.event.type === 'result') {
        const prior = state.results === undefined ? collectTurnResults(state.events, this.options.turn)
          : { ok: true as const, value: state.results };
        const next = parseStructuredResults(event.event.blocks);
        if (!prior.ok || !next.ok) throw new Error('invalid-state');
        const results = new Map(prior.value.map(block => [block.id, block]));
        for (const block of next.value) results.set(block.id, block);
        state.results = [...results.values()];
      }
      state.events = [...state.events, event].slice(-this.replayLimit);
      await this.save(tx, state);
      return event;
    });
  }

  async replay(identity: TurnIdentity, after: number): Promise<ReplayWindow> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid-cursor');
    return this.locked(identity, async (_tx, state) => ({
      lastSequence: state.checkpoint?.state.lastSequence ?? 0,
      firstAvailableSequence: state.events[0]?.sequence ?? (state.checkpoint?.state.lastSequence ?? 0) + 1,
      events: state.events.filter(event => event.sequence > after),
    }));
  }

  /** One commit reserves the pending card, exact child dispatch, and existing
   * history row. A failed/uncertain ACK is never permission to publish or retry
   * another identity. No bearer is persisted. */
  async prepareInteraction(input: {
    record: InteractionRecord; parent: ChatParent;
    binding: Omit<OperatorChatInteractionBinding, 'nativeCallId'>;
    tool: ChatTurnToolCall;
  }): Promise<boolean> {
    const { record, parent, binding, tool } = structuredClone(input);
    if (!validInteractionBinding(binding) || Object.hasOwn(binding, 'nativeCallId')
      || !validId(record.correlationId) || record.schemaVersion !== 1 || record.revision !== 0
      || record.status !== 'pending' || record.conversationId !== this.options.turn.conversationId
      || !sameScope(record.scope, this.options.scope) || tool.callId !== binding.dispatchCallId
      || canonicalToolName(tool.name) !== 'chat:ask_choice' || tool.answered !== undefined
      || !isDeepStrictEqual(tool, JSON.parse(JSON.stringify(tool)))) throw new Error('invalid-state');
    return this.locked(this.options.turn, async (tx, state) => {
      if (!sameParent(state, parent, this.options.workspaceId, this.options.turn)) throw new OperatorChatAuthorizationError();
      const existing = state.interactionBindings ?? {};
      const rows = await tx.unsafe<{ tools: ChatTurnToolCall[] }[]>(`SELECT tools FROM harness_shared.operator_turns
        WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3`,
      [this.options.turn.turnId, this.options.turn.conversationId, this.options.workspaceId]);
      const tools = rows[0].tools;
      if (!Array.isArray(tools)) throw new Error('invalid-state');
      if (Object.hasOwn(state.interactions, record.correlationId)) {
        if (!isDeepStrictEqual(state.interactions[record.correlationId], record)
          || !isDeepStrictEqual(existing[record.correlationId], binding)
          || tools.filter(previous => isDeepStrictEqual(previous, tool)).length !== 1) {
          throw new Error('interaction-binding-conflict');
        }
        return false;
      }
      if (state.execution?.status !== 'running') return false;
      if (state.checkpoint && !['running', 'awaiting-input'].includes(state.checkpoint.state.phase)) return false;
      if (tools.some(tool => tool.callId === binding.dispatchCallId)
        || Object.values(existing).some(value => value.dispatchCallId === binding.dispatchCallId)) {
        throw new Error('interaction-binding-conflict');
      }
      state.interactions = { ...state.interactions, [record.correlationId]: record };
      state.interactionBindings = { ...existing, [record.correlationId]: binding };
      await tx.unsafe(`UPDATE harness_shared.operator_turns SET tools=$1::jsonb
        WHERE id=$2 AND conversation_id=$3 AND workspace_id=$4`,
      [tx.json([...tools, tool] as unknown as postgres.JSONValue), this.options.turn.turnId,
        this.options.turn.conversationId, this.options.workspaceId]);
      await this.save(tx, state, true);
      return true;
    });
  }

  /** Native adapters may reveal callId only AFTER the decision. This explicit
   * association comes from the authenticated tool result, never model text. */
  async associateInteractionCall(input: OperatorChatInteractionBinding & {
    parent: ChatParent; correlationId: string; nativeCallId: string;
  }): Promise<boolean> {
    const { parent, correlationId, ...binding } = structuredClone(input);
    if (!validInteractionBinding(binding) || !validId(correlationId)) throw new Error('invalid-state');
    return this.locked(this.options.turn, async (tx, state) => {
      const prior = state.interactionBindings?.[correlationId];
      if (!sameParent(state, parent, this.options.workspaceId, this.options.turn) || !prior
        || prior.dispatchCallId !== binding.dispatchCallId || prior.childRunId !== binding.childRunId
        || prior.credentialSha256 !== binding.credentialSha256) throw new OperatorChatAuthorizationError();
      if (prior.nativeCallId !== undefined) {
        if (prior.nativeCallId !== binding.nativeCallId) throw new Error('interaction-binding-conflict');
        return false;
      }
      if (state.execution?.status !== 'running') throw new Error('turn-result-conflict');
      if (Object.values(state.interactionBindings!).some(value => value.nativeCallId === binding.nativeCallId)) {
        throw new Error('interaction-binding-conflict');
      }
      state.interactionBindings = { ...state.interactionBindings, [correlationId]: binding };
      await this.save(tx, state);
      return true;
    });
  }

  async seedInteraction(record: InteractionRecord, parent?: ChatParent): Promise<boolean> {
    const candidate = structuredClone(record);
    const binding = parent === undefined ? undefined : structuredClone(parent);
    if (candidate.schemaVersion !== 1 || candidate.conversationId !== this.options.turn.conversationId
      || !sameScope(candidate.scope, this.options.scope) || candidate.status !== 'pending'
      || candidate.revision !== 0) throw new Error('invalid-state');
    return this.locked(this.options.turn, async (tx, state) => {
      if (state.execution?.parentAuthority || binding) {
        if (!binding || binding.workspaceId !== this.options.workspaceId
          || !sameTurn(binding, this.options.turn) || binding.runId !== state.execution?.runId
          || !isDeepStrictEqual(binding.authority, state.execution?.parentAuthority)) {
          throw new OperatorChatAuthorizationError();
        }
      }
      if (state.execution && state.execution.status !== 'running') return false;
      if (state.checkpoint && !['running', 'awaiting-input'].includes(state.checkpoint.state.phase)) return false;
      if (Object.hasOwn(state.interactions, candidate.correlationId)) return false;
      state.interactions = { ...state.interactions, [candidate.correlationId]: candidate };
      await this.save(tx, state, true);
      return true;
    });
  }

  /** The host MUST supply its existing persisted workflow transition. It runs
   * in the decision transaction; no external effect belongs in this callback. */
  interactions(advance: (tx: Tx, next: InteractionRecord) => Promise<void>, expected?: {
    parent: ChatParent; binding: Omit<OperatorChatInteractionBinding, 'nativeCallId'>;
  }): InteractionStore {
    const bound = expected === undefined ? undefined : structuredClone(expected);
    return { transact: async <T>(identity: InteractionIdentity, caller: InteractionScope,
      decide: (current: { record: InteractionRecord | null; now: number; authorized: boolean }) => InteractionMutation<T>,
    ): Promise<InteractionResult<T>> => {
      if (identity.conversationId !== this.options.turn.conversationId || !sameScope(caller, this.options.scope)) {
        return { ok: false, code: 'unauthorized' };
      }
      try { return await this.locked(this.options.turn, async (tx, state) => {
        if (bound) {
          const binding = state.interactionBindings?.[identity.correlationId];
          if (!sameParent(state, bound.parent, this.options.workspaceId, this.options.turn)
            || !binding || binding.dispatchCallId !== bound.binding.dispatchCallId
            || binding.childRunId !== bound.binding.childRunId
            || binding.credentialSha256 !== bound.binding.credentialSha256) {
            return { ok: false, code: 'unauthorized' };
          }
        }
        const record = Object.hasOwn(state.interactions, identity.correlationId)
          ? structuredClone(state.interactions[identity.correlationId]) : null;
        const clock = await tx.unsafe<{ now: number }[]>('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS now');
        const mutation = decide({ record, now: clock[0].now, authorized: true });
        if (mutation.next) {
          if (mutation.next.conversationId !== identity.conversationId
            || mutation.next.correlationId !== identity.correlationId
            || !sameScope(mutation.next.scope, this.options.scope)) throw new Error('invalid-state');
          state.interactions = { ...state.interactions, [identity.correlationId]: structuredClone(mutation.next) };
          await this.save(tx, state, true);
          if (mutation.next.status === 'resolved') await advance(tx, mutation.next);
        }
        return mutation.result;
      }); } catch (error) {
        if (error instanceof OperatorChatAuthorizationError) return { ok: false, code: 'unauthorized' };
        throw error;
      }
    } };
  }
}
