import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import { parseChatEventV1 } from '@papercusp/chat-protocol';
import { selectConversationContext, type ContextCheckpoint, type ContextHost,
  type ContextRecord, type ContextScope, type ContextSummary, type HousekeepingReceipt,
  type SummaryAttempt } from '@papercusp/chat-protocol/context';

type Tx = postgres.TransactionSql;
interface StoredContext {
  schemaVersion: 1;
  scope: ContextScope;
  checkpoint: ContextCheckpoint | null;
  journal: HousekeepingReceipt[];
}

export interface OperatorConversationContextOptions {
  sql: postgres.Sql;
  workspaceId: string;
  scope: ContextScope;
  /** The same current session/ACL fence used by the surrounding chat host.
   * Lock authority rows in this transaction so revocation serializes with CAS. */
  authorize(tx: Tx): Promise<boolean>;
  summarize: ContextHost['summarize'];
  /** The legacy summary is a projection of committed coverage, in this SAME
   * transaction. A failed projection rolls back the context CAS as well. */
  project?(tx: Tx, next: ContextCheckpoint): Promise<void>;
}

const sameScope = (a: ContextScope, b: ContextScope) => a?.conversationId === b.conversationId
  && a?.ownerId === b.ownerId;
const copy = <T>(value: T): T => structuredClone(value);
const validId = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
function validReceipt(receipt: HousekeepingReceipt): boolean {
  if (!receipt || !validId(receipt.operationId) || !['completed', 'failed', 'incomplete'].includes(receipt.status)) return false;
  if (receipt.usage === null) return true;
  const event = parseChatEventV1({ type: 'done', usage: receipt.usage });
  return event?.type === 'done' && !!event.usage && Object.keys(event.usage).length > 0;
}

/** Concrete PG hooks for the shared context coordinator. Uses the conversation's
 * existing row and transaction/authority boundary, alongside its rolling summary.
 * Uncertain pending coverage refuses replay; provider usage alone cannot settle it. */
export class OperatorConversationContext implements ContextHost {
  readonly profile = 'durable' as const;
  private readonly scope: ContextScope;
  private readonly admitted = new Set<string>();
  constructor(private readonly options: OperatorConversationContextOptions) {
    this.scope = copy(options.scope);
  }

  private decode(raw: unknown): StoredContext {
    if (raw === null) return { schemaVersion: 1, scope: copy(this.scope), checkpoint: null, journal: [] };
    const value = raw as StoredContext;
    if (!value || value.schemaVersion !== 1) throw new Error(`invalid-context: stored version (${typeof raw})`);
    if (!sameScope(value.scope, this.scope)) throw new Error('invalid-context: stored scope');
    if (!Object.hasOwn(value, 'checkpoint')) throw new Error('invalid-context: missing checkpoint');
    if (!Array.isArray(value.journal)) throw new Error('invalid-context: journal is not an array');
    if (value.journal.some(receipt => !validReceipt(receipt))) throw new Error('invalid-context: journal receipt');
    if (new Set(value.journal.map(receipt => receipt.operationId)).size !== value.journal.length)
      throw new Error('invalid-context: duplicate journal operation');
    if (value.checkpoint !== null && !sameScope(value.checkpoint.scope, this.scope))
      throw new Error('invalid-context: checkpoint scope');
    return copy(value);
  }

  private async locked<T>(scope: ContextScope,
    action: (tx: Tx, state: StoredContext) => Promise<T>, liabilityOperation?: string): Promise<T> {
    if (!sameScope(scope, this.scope) || !this.options.workspaceId) throw new Error('unauthorized');
    return this.options.sql.begin(async tx => {
      // A successful pending CAS grants this host one narrowly scoped liability
      // ticket. Recording incurred usage remains possible after revocation;
      // the ticket grants no history read, coverage write or fresh model call.
      if (!liabilityOperation || !this.admitted.has(liabilityOperation)) {
        if (!await this.options.authorize(tx)) throw new Error('unauthorized');
      }
      const rows = await tx.unsafe(
        `SELECT context_state
           FROM harness_shared.operator_conversations
          WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [this.scope.conversationId, this.options.workspaceId]);
      if (!rows.length) throw new Error('unauthorized');
      return action(tx, this.decode(rows[0].context_state ?? null));
    }) as Promise<T>;
  }

  private async write(tx: Tx, state: StoredContext): Promise<void> {
    // The host pool may use a raw JSON serializer while a fresh client uses
    // postgres-js defaults. Bind serialized data as TEXT explicitly so neither
    // client can encode it twice or send an unencoded object to the byte writer.
    await tx.unsafe(`UPDATE harness_shared.operator_conversations SET context_state = $3::text::jsonb
      WHERE id = $1 AND workspace_id = $2`,
    [this.scope.conversationId, this.options.workspaceId, JSON.stringify(state)]);
  }

  async authorize(scope: ContextScope): Promise<boolean> {
    try { return await this.locked(scope, async () => true); }
    catch { return false; }
  }

  /** Supply the host's persisted, versioned history before coordinating. Never
   * replace an unsettled operation or silently rewrite a version's source bytes. */
  async initialize(history: ContextRecord[], sourceVersion: string,
    summary: ContextSummary | null = null): Promise<ContextCheckpoint> {
    history = copy(history); summary = copy(summary);
    if (!validId(sourceVersion)) throw new Error('invalid-context');
    const valid = selectConversationContext(this.scope, history,
      { budgetTokens: Number.MAX_SAFE_INTEGER }, summary);
    if (!valid.ok) throw new Error(valid.code);
    return this.locked(this.scope, async (tx, state) => {
      const previous = state.checkpoint;
      if (previous?.operation?.phase === 'pending') throw new Error('needs-reconciliation');
      if (previous?.sourceVersion === sourceVersion) {
        if (!isDeepStrictEqual(previous.history, history)) throw new Error('conflict');
        return copy(previous);
      }
      const remembered = previous?.summary ?? summary;
      const bounded = selectConversationContext(this.scope, history,
        { budgetTokens: Number.MAX_SAFE_INTEGER }, remembered);
      if (!bounded.ok) throw new Error(bounded.code);
      const checkpoint: ContextCheckpoint = {
        schemaVersion: 1, scope: copy(this.scope), revision: previous ? previous.revision + 1 : 0,
        sourceVersion, history, summary: remembered, operation: null,
        receipts: previous?.receipts ?? [],
      };
      state.checkpoint = checkpoint;
      if (!await this.options.authorize(tx)) throw new Error('unauthorized');
      await this.write(tx, state);
      return copy(checkpoint);
    });
  }

  async read(scope: ContextScope): Promise<ContextCheckpoint | null> {
    return this.locked(scope, async (_tx, state) => copy(state.checkpoint));
  }

  async compareAndSwap(scope: ContextScope, revision: number, next: ContextCheckpoint,
    options: { signal?: AbortSignal }): Promise<boolean> {
    next = copy(next);
    if (!sameScope(next.scope, this.scope) || next.schemaVersion !== 1
      || next.revision !== revision + 1) throw new Error('invalid-context: checkpoint CAS scope, schema or revision');
    const committed = await this.locked(scope, async (tx, state) => {
      if (!state.checkpoint || state.checkpoint.revision !== revision) return false;
      if (next.sourceVersion !== state.checkpoint.sourceVersion
        || !isDeepStrictEqual(next.history, state.checkpoint.history)) throw new Error('conflict');
      if (!await this.options.authorize(tx) || options.signal?.aborted) return false;
      await this.options.project?.(tx, copy(next));
      // Projection may await SQL. Abort must still roll back both writes.
      if (options.signal?.aborted) throw new Error('cancelled');
      state.checkpoint = next;
      // No await between the signal check and dispatching the durable write.
      await this.write(tx, state);
      return true;
    });
    if (committed && next.operation?.phase === 'pending') this.admitted.add(next.operation.id);
    return committed;
  }

  async summarize(input: Parameters<ContextHost['summarize']>[0]): Promise<SummaryAttempt> {
    if (!sameScope(input.scope, this.scope) || !this.admitted.has(input.operationId)
      || !await this.authorize(input.scope)) throw new Error('unauthorized');
    // Signals are host capabilities; never structuredClone an AbortSignal.
    const { signal, ...payload } = input;
    return this.options.summarize({ ...copy(payload), ...(signal ? { signal } : {}) });
  }

  async observeUsage(scope: ContextScope, receipt: HousekeepingReceipt): Promise<void> {
    receipt = copy(receipt);
    if (!validReceipt(receipt)) throw new Error('invalid-context');
    await this.locked(scope, async (tx, state) => {
      const previous = state.journal.find(r => r.operationId === receipt.operationId);
      if (previous) {
        if (!isDeepStrictEqual(previous, receipt)) throw new Error('conflict');
        return;
      }
      if (state.checkpoint?.operation?.id !== receipt.operationId) throw new Error('conflict');
      state.journal.push(receipt);
      await this.write(tx, state);
    }, receipt.operationId);
  }

  async readUsage(scope: ContextScope): Promise<HousekeepingReceipt[]> {
    return this.locked(scope, async (_tx, state) => copy(state.journal));
  }

  async reconcile(scope: ContextScope, operationId: string): Promise<SummaryAttempt | null> {
    return this.locked(scope, async (_tx, state) => {
      const receipt = state.journal.find(r => r.operationId === operationId);
      // A receipt establishes liability only. Leave pending coverage unsettled;
      // an ACK-lost successful CAS is already completed in the stored checkpoint.
      return receipt ? { status: receipt.status, ...(receipt.usage ? { usage: copy(receipt.usage) } : {}) } : null;
    });
  }
}
