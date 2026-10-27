/**
 * operator-conversation-compaction.integration.test.ts
 * (operator-context-compaction-2026-06-05 P-007)
 *
 * Proves, against a real Postgres (testcontainer) with the REAL migration
 * 168 applied on top of the baseline conversation tables:
 *   1. First compaction folds the aged-out backlog (everything except the
 *      KEEP_RECENT_TURNS tail) into a stored summary — and the summary
 *      survives a fresh read (= restart survival: PG is the store).
 *   2. The second pass is INCREMENTAL (D-003): its prompt carries the
 *      previous summary + only the newly aged-out turns — never the
 *      already-folded ones.
 *   3. up_to_date / below_threshold / force semantics.
 *   4. The CAS write (D-003): a concurrent compactor that lands first wins;
 *      the loser reports cas_lost and clobbers nothing.
 *   5. The budget gate (D-004): an exceeded daily budget skips compaction;
 *      the summarizer's cost is recorded via recordSpend.
 *   6. The long-conversation guarantee the brief names: with a conversation
 *      far past the verbatim window, an EARLY DECISION dropped by the window
 *      still reaches the model — the summary (fed the early turns) is what
 *      the prompt composes in.
 *
 * Mirrors autoloop-state.integration.test.ts's setup (getOrgPg → drizzle
 * over a per-test database).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { HaikuTurnResult } from './haiku';
import { ConversationContext, type ContextCheckpoint, type ContextHost, type ContextRecord,
  type ContextScope } from '@papercusp/chat-protocol/context';
import { OperatorConversationContext } from './operator-conversation-context';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

const WS = 'ws-compaction-test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
  budgetExceeded: false,
  spendRecorded: [] as number[],
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./operator-budget', () => ({
  checkBudget: vi.fn(async () => ({
    exceeded: h.budgetExceeded,
    todaySpendUsd: 0,
    capUsd: 20,
    state: { dailyCapUsd: 20, spend: [] },
  })),
  recordSpend: vi.fn(async (usd: number) => {
    h.spendRecorded.push(usd);
  }),
}));

const {
  getOrCreateActiveConversation,
  appendTurn,
  readConversationSummary,
  writeConversationSummary,
  maxTurnSeq,
  listTurnsBetween,
} = await import('./operator-conversations');
const { compactConversation: compactAuthenticated, KEEP_RECENT_TURNS } = await import(
  './operator-conversation-compaction'
);
const compactConversation = (id: string, opts: Parameters<typeof compactAuthenticated>[1] = {}) =>
  compactAuthenticated(id, { ...opts, context: { workspaceId: WS, ownerId: 'context-owner', authorize: async () => true,
    ...opts.context } });

let rootSql: postgres.Sql;
let testDatabaseUrl: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  testDatabaseUrl = u.toString();
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Baseline shapes (000-baseline.sql:1731 / :1922), minus the tsvector /
  // pgvector columns this module never touches (the extension isn't in the
  // test container), plus the UNIQUE(conversation_id, seq) appendTurn's
  // 23505-retry relies on and the report column (migration 160).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text,
      subject_kind text DEFAULT 'global' NOT NULL,
      subject_ref text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      started_at bigint NOT NULL,
      ended_at bigint,
      el_conversation_ids text[] DEFAULT '{}' NOT NULL,
      has_audio boolean DEFAULT false NOT NULL
    );
    CREATE TABLE harness_shared.operator_turns (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      conversation_id uuid NOT NULL,
      seq integer NOT NULL,
      role text NOT NULL,
      text text NOT NULL,
      source text DEFAULT 'text_typed' NOT NULL,
      el_conv_id text,
      audio_url text,
      created_at bigint NOT NULL,
      tools jsonb,
      report jsonb,
      workspace_id text NOT NULL, -- mig 453: appendTurn stamps activeWorkspaceId()
      CONSTRAINT operator_turns_conv_seq UNIQUE (conversation_id, seq)
    );
  `);
  // The artifact under test: the REAL migration file.
  await rootSql.unsafe(
    readFileSync(resolve(SQL_DIR, '168-operator-conversation-summary.sql'), 'utf8'),
  );
  const contextMigration = resolve(SQL_DIR, '1574-operator-conversation-context-checkpoint.sql');
  await rootSql.unsafe(readFileSync(existsSync(contextMigration) ? contextMigration : `${contextMigration}.DRAFT`, 'utf8'));
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

/** A summarize stub that records its prompt and returns a canned result. */
function stubSummarizer(text: string, costUsd = 0.0012) {
  const prompts: string[] = [];
  const fn = async (prompt: string): Promise<HaikuTurnResult | null> => {
    prompts.push(prompt);
    return { text, model: 'stub-haiku', costUsd, tokensIn: 100, tokensOut: 50 };
  };
  return { fn, prompts };
}

describe('P010 production compactor adoption', () => {
  async function seeded() {
    const [row] = await rootSql.unsafe(`INSERT INTO harness_shared.operator_conversations
      (workspace_id, started_at) VALUES ($1,$2) RETURNING id`, [WS, Date.now()]);
    const id = String(row.id);
    for (let i = 0; i < 26; i++) await appendTurn({ conversationId: id,
      role: i % 2 ? 'assistant' : 'user', text: `production turn ${i}` });
    return id;
  }
  async function stored(id: string) {
    const [row] = await rootSql.unsafe(`SELECT context_state,summary_text,summary_through_seq
      FROM harness_shared.operator_conversations WHERE id=$1`, [id]);
    return row;
  }

  it('refuses an unauthenticated compaction before a provider or history mutation', async () => {
    const id = await seeded(); const summarize = vi.fn();
    await expect(compactAuthenticated(id, { summarize })).resolves.toEqual({ outcome: 'unauthorized' });
    expect(summarize).not.toHaveBeenCalled();
    expect((await stored(id)).context_state).toBeNull();
  });

  it('journals failed measured usage without advancing coverage or replaying the same source', async () => {
    const id = await seeded();
    const summarize = vi.fn(async () => ({ status: 'failed' as const, model: 'failed-model',
      costUsd: 0.006, tokensIn: 42, tokensOut: 5 }));
    expect((await compactConversation(id, { summarize })).outcome).toBe('llm_unavailable');
    const row = await stored(id);
    expect(row.summary_text).toBeNull(); expect(row.summary_through_seq).toBeNull();
    expect(row.context_state.journal).toEqual([expect.objectContaining({ status: 'failed',
      usage: { costUsd: 0.006, inputTokens: 42, outputTokens: 5 } })]);
    expect(h.spendRecorded).toContain(0.006);
    expect((await compactConversation(id, { summarize })).outcome).toBe('llm_unavailable');
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('persists incurred usage after current authority is revoked without projecting a summary', async () => {
    const id = await seeded(); let authorized = true;
    const summarize = vi.fn(async () => { authorized = false;
      return { text: 'must not commit', model: 'stub', costUsd: 0.007, tokensIn: 10, tokensOut: 2 }; });
    const result = await compactConversation(id, { summarize,
      context: { workspaceId: WS, ownerId: 'context-owner', authorize: async () => authorized } });
    expect(result.outcome).toBe('unauthorized');
    const row = await stored(id);
    expect(row.summary_text).toBeNull(); expect(row.context_state.checkpoint.summary).toBeNull();
    expect(row.context_state.journal).toEqual([expect.objectContaining({ usage: expect.objectContaining({ costUsd: 0.007 }) })]);
    expect(h.spendRecorded).toContain(0.007);
  });

  it('cancellation after summary usage commits neither legacy nor shared coverage', async () => {
    const id = await seeded(); const controller = new AbortController();
    const result = await compactConversation(id, { signal: controller.signal, summarize: async (_prompt, signal) => {
      expect(signal).toBe(controller.signal); controller.abort();
      return { text: 'obsolete', model: 'stub', costUsd: 0.008, tokensIn: 11, tokensOut: 3 };
    } });
    expect(result.outcome).toBe('cancelled');
    const row = await stored(id);
    expect(row.summary_text).toBeNull(); expect(row.context_state.checkpoint.summary).toBeNull();
    expect(row.context_state.checkpoint.operation.failure).toBe('cancelled');
    expect(row.context_state.journal).toHaveLength(1);
  });
});

describe('P010 uncertain compaction accounting', () => {
  const policy = { budgetTokens: 1300, maxMessageChars: 120 };
  async function fixture() {
    const [row] = await rootSql.unsafe(`INSERT INTO harness_shared.operator_conversations
      (workspace_id, started_at) VALUES ($1, $2) RETURNING id`, [WS, Date.now()]);
    const scope: ContextScope = { conversationId: String(row.id), ownerId: 'context-owner' };
    const history: ContextRecord[] = Array.from({ length: 24 }, (_, i) => ({
      id: `turn-${i}`, scope: { ...scope }, role: i % 2 ? 'assistant' : 'user',
      text: `turn ${i} ${'context '.repeat(40)}`, provenance: { source: 'operator-turn', ref: `turn-${i}` },
    }));
    const summarize: ContextHost['summarize'] = async input => ({ status: 'completed',
      text: 'Remember the earlier decision.', coveredIds: input.records.map(r => r.id),
      usage: { inputTokens: 21, outputTokens: 8, costUsd: 0.002 } });
    const make = (sql: postgres.Sql = rootSql, overrides: Partial<ConstructorParameters<typeof OperatorConversationContext>[0]> = {}) =>
      new OperatorConversationContext({ sql, workspaceId: WS, scope, authorize: async () => true, summarize, ...overrides });
    const host = make();
    await host.initialize(history, 'history-v1');
    return { scope, history, host, make, summarize };
  }

  it('two PG clients admit one summary and a fresh host recovers the committed checkpoint', async () => {
    const f = await fixture();
    const clients = [postgres(testDatabaseUrl, { max: 1 }), postgres(testDatabaseUrl, { max: 1 })];
    const provider = vi.fn(f.summarize);
    try {
      const hosts = clients.map(sql => f.make(sql, { summarize: provider }));
      const claimErrors: string[] = [];
      for (const host of hosts) {
        const cas = host.compareAndSwap.bind(host);
        host.compareAndSwap = async (...args) => {
          try { return await cas(...args); }
          catch (error) {
            claimErrors.push(JSON.stringify({ error: String(error), revision: args[1], next: args[2].revision,
              scope: args[2].scope, phase: args[2].operation?.phase }));
            throw error;
          }
        };
      }
      const results = await Promise.all(hosts.map((host, i) =>
        new ConversationContext(host).compact(f.scope, `operation-${i}`, policy)));
      expect(claimErrors).toEqual([]);
      expect(results.map(r => r.ok ? r.value.outcome : r.code)).toEqual(expect.arrayContaining(['compacted']));
      expect(results.filter(r => r.ok && r.value.outcome === 'compacted')).toHaveLength(1);
      expect(provider).toHaveBeenCalledTimes(1);
      const [stored] = await clients[1].unsafe(`SELECT jsonb_typeof(context_state) AS context_type
        FROM harness_shared.operator_conversations WHERE id = $1`, [f.scope.conversationId]);
      expect(stored.context_type).toBe('object');
      const fresh = f.make(clients[1]);
      const recovered = await new ConversationContext(fresh).recover(f.scope, policy);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error(recovered.code);
      expect(recovered.value.checkpoint.summary?.coveredIds.length).toBeGreaterThan(0);
      expect(await fresh.readUsage(f.scope)).toEqual([expect.objectContaining({
        status: 'completed', usage: { inputTokens: 21, outputTokens: 8, costUsd: 0.002 },
      })]);
    } finally { await Promise.all(clients.map(sql => sql.end({ timeout: 5 }))); }
  });

  it('aborting inside a legacy projection rolls back both coverage writes while keeping liability', async () => {
    const f = await fixture(); const controller = new AbortController();
    const projecting = f.make(rootSql, { project: async (tx, next) => {
      if (next.operation?.phase !== 'completed' || !next.summary) return;
      await tx.unsafe(`UPDATE harness_shared.operator_conversations SET summary_text='partial'
        WHERE id=$1`, [f.scope.conversationId]);
      controller.abort();
    } });
    const result = await new ConversationContext(projecting).compact(f.scope, 'projection-cancel', policy, controller.signal);
    expect(result).toMatchObject({ ok: false, code: 'needs-reconciliation' });
    const [row] = await rootSql.unsafe(`SELECT context_state,summary_text
      FROM harness_shared.operator_conversations WHERE id=$1`, [f.scope.conversationId]);
    expect(row.summary_text).toBeNull();
    expect(row.context_state.checkpoint.summary).toBeNull();
    expect(row.context_state.journal).toHaveLength(1);
    expect(await new ConversationContext(f.make()).recover(f.scope, policy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
  });

  it('retains measured failed housekeeping and never calls its provider again for the same source', async () => {
    const f = await fixture();
    const provider = vi.fn(async () => ({ status: 'failed' as const, usage: { inputTokens: 17, costUsd: 0.001 } }));
    const host = f.make(rootSql, { summarize: provider });
    const first = await new ConversationContext(host).compact(f.scope, 'failed-summary', policy);
    expect(first.ok && first.value.outcome).toBe('summary-failed');
    expect((await f.host.read(f.scope))?.summary).toBeNull();
    await new ConversationContext(f.make()).compact(f.scope, 'retry-must-not-dispatch', policy);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await f.host.readUsage(f.scope)).toEqual([{ operationId: 'failed-summary', status: 'failed',
      usage: { inputTokens: 17, costUsd: 0.001 } }]);
  });

  it('preserves unknown usage as null instead of inventing a measured zero', async () => {
    const f = await fixture();
    await new ConversationContext(f.make(rootSql, { summarize: async () => ({ status: 'incomplete' }) }))
      .compact(f.scope, 'unknown-summary', policy);
    expect(await f.host.readUsage(f.scope)).toEqual([{ operationId: 'unknown-summary', status: 'incomplete', usage: null }]);
    expect((await f.host.read(f.scope))?.summary).toBeNull();
  });

  it('recovers commit success with lost acknowledgement without another summary or usage charge', async () => {
    const f = await fixture();
    const provider = vi.fn(f.summarize);
    const host = f.make(rootSql, { summarize: provider });
    const cas = host.compareAndSwap.bind(host);
    host.compareAndSwap = async (...args) => {
      const result = await cas(...args);
      if (result && args[2].operation?.phase === 'completed') throw new Error('lost ACK after commit');
      return result;
    };
    expect(await new ConversationContext(host).compact(f.scope, 'ack-lost', policy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    expect((await new ConversationContext(f.make()).recover(f.scope, policy)).ok).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    const receipt = (await f.host.readUsage(f.scope))[0];
    await f.host.observeUsage(f.scope, receipt);
    expect(await f.host.readUsage(f.scope)).toHaveLength(1);
    await expect(f.host.observeUsage(f.scope, { ...receipt, usage: { costUsd: 0 } })).rejects.toThrow('conflict');
  });

  it('leaves a pre-commit failure pending: provider completion is no proof of coverage', async () => {
    const f = await fixture();
    const provider = vi.fn(f.summarize);
    const host = f.make(rootSql, { summarize: provider });
    const cas = host.compareAndSwap.bind(host);
    host.compareAndSwap = async (...args) => {
      if (args[2].operation?.phase === 'completed') throw new Error('write unavailable before commit');
      return cas(...args);
    };
    expect(await new ConversationContext(host).compact(f.scope, 'pending-summary', policy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    const fresh = f.make();
    expect(await new ConversationContext(fresh).recover(f.scope, policy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    expect(await new ConversationContext(fresh).compact(f.scope, 'never-repeat-effect', policy))
      .toMatchObject({ ok: false, code: 'needs-reconciliation' });
    expect((await fresh.read(f.scope))?.summary).toBeNull();
    expect(await fresh.readUsage(f.scope)).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(fresh.initialize(f.history, 'new-history')).rejects.toThrow('needs-reconciliation');
  });

  it('records incurred liability after revocation while refusing coverage and scoped reads', async () => {
    const f = await fixture();
    let allowed = true;
    const host = f.make(rootSql, { authorize: async () => allowed, summarize: async input => {
      allowed = false;
      return f.summarize(input);
    } });
    expect(await new ConversationContext(host).compact(f.scope, 'revoked-summary', policy))
      .toMatchObject({ ok: false, code: 'unauthorized' });
    await expect(host.read(f.scope)).rejects.toThrow('unauthorized');
    expect((await f.host.read(f.scope))?.summary).toBeNull();
    expect(await f.host.readUsage(f.scope)).toEqual([expect.objectContaining({ operationId: 'revoked-summary',
      usage: expect.objectContaining({ costUsd: 0.002 }) })]);
    await expect(f.make(rootSql, { scope: { ...f.scope, ownerId: 'other-owner' } }).read({ ...f.scope, ownerId: 'other-owner' }))
      .rejects.toThrow('invalid-context');
    await expect(f.make(rootSql, { workspaceId: 'other-workspace' }).read(f.scope)).rejects.toThrow('unauthorized');
  });

  it('checks cancellation after the awaited authority fence and leaves coverage unchanged', async () => {
    const f = await fixture();
    const ac = new AbortController();
    let cancelAtFence = false;
    const host = f.make(rootSql, { authorize: async () => {
      await Promise.resolve();
      if (cancelAtFence) ac.abort();
      return true;
    } });
    const previous = (await host.read(f.scope))!;
    const next: ContextCheckpoint = { ...previous, revision: previous.revision + 1 };
    cancelAtFence = true;
    expect(await host.compareAndSwap(f.scope, previous.revision, next, { signal: ac.signal })).toBe(false);
    expect((await f.host.read(f.scope))?.revision).toBe(previous.revision);
    expect(await f.host.readUsage(f.scope)).toEqual([]);
  });

  it('advances history revisions, rejects source rewrites and keeps stale CAS from overwriting a receipt', async () => {
    const f = await fixture();
    const stale = (await f.host.read(f.scope))!;
    await expect(f.host.initialize(f.history.map((m, i) => i ? m : { ...m, text: 'rewritten' }), 'history-v1'))
      .rejects.toThrow('conflict');
    await new ConversationContext(f.host).compact(f.scope, 'journal-survives', policy);
    expect(await f.host.compareAndSwap(f.scope, stale.revision, { ...stale, revision: stale.revision + 1 }, {})).toBe(false);
    expect(await f.host.readUsage(f.scope)).toHaveLength(1);
    const extended = [...f.history, { ...f.history.at(-1)!, id: 'turn-24', role: 'user' as const }];
    const checkpoint = await f.host.initialize(extended, 'history-v2');
    expect(checkpoint.operation).toBeNull();
    expect(checkpoint.summary?.coveredIds.length).toBeGreaterThan(0);
    expect(checkpoint.history.at(-1)?.id).toBe('turn-24');
  });

  it('rejects malformed history versions and non-finite liability instead of serializing them as null', async () => {
    const f = await fixture();
    await expect(f.host.initialize(f.history, ' history-v2')).rejects.toThrow('invalid-context');
    await expect(f.host.observeUsage(f.scope, { operationId: 'invalid-usage', status: 'failed',
      usage: { costUsd: Number.NaN } })).rejects.toThrow('invalid-context');
    expect(await f.host.readUsage(f.scope)).toEqual([]);
  });
});

describe('conversation compaction lifecycle (PG)', () => {
  let convId: string;

  it('seeds a long conversation and the first pass folds the aged-out backlog', async () => {
    const conv = await getOrCreateActiveConversation(WS);
    convId = conv.id;
    // 30 turns, seq 0..29. The EARLY DECISION lives at seq 1 — far outside
    // the KEEP_RECENT_TURNS tail.
    for (let i = 0; i < 30; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const text =
        i === 1
          ? 'DECISION: we will name the production harness "ledger" (not "sheets").'
          : `turn ${i}: routine status chatter`;
      await appendTurn({ conversationId: convId, role, text });
    }
    expect(await maxTurnSeq(convId)).toBe(29);

    const stub = stubSummarizer(
      'Early thread: user DECIDED the production harness is named "ledger". Routine status otherwise.',
    );
    const r = await compactConversation(convId, { summarize: stub.fn });
    expect(r.outcome).toBe('compacted');
    // newest(29) − KEEP_RECENT_TURNS = the watermark.
    expect(r.summaryThroughSeq).toBe(29 - KEEP_RECENT_TURNS);
    expect(r.turnsFolded).toBe(29 - KEEP_RECENT_TURNS + 1); // seq 0..watermark

    // The summarizer SAW the early decision (it aged out of the window).
    expect(stub.prompts[0]).toContain('name the production harness "ledger"');
    expect(stub.prompts[0]).toContain('(none — conversation start)');

    // Metering: the summarizer's cost landed in recordSpend (D-004).
    expect(h.spendRecorded).toContain(0.0012);
  });

  it('the summary survives a fresh read (restart survival — PG is the store)', async () => {
    const s = await readConversationSummary(convId);
    expect(s?.summaryText).toContain('"ledger"');
    expect(s?.summaryThroughSeq).toBe(29 - KEEP_RECENT_TURNS);
    expect(s?.summaryModel).toBe('stub-haiku');
    expect(s?.summaryTurnsCovered).toBe(29 - KEEP_RECENT_TURNS + 1);
    expect(s?.summaryUpdatedAt).toBeGreaterThan(0);
  });

  it('an immediate second pass is up_to_date (nothing new aged out)', async () => {
    const stub = stubSummarizer('should never run');
    const r = await compactConversation(convId, { summarize: stub.fn });
    expect(r.outcome).toBe('up_to_date');
    expect(stub.prompts).toHaveLength(0);
  });

  it('a small new backlog is below_threshold; force overrides', async () => {
    // 2 new turns → 2 aged-out uncovered (29−12=17 covered; 31−12=19 cutoff).
    await appendTurn({ conversationId: convId, role: 'user', text: 'turn 30: small talk' });
    await appendTurn({ conversationId: convId, role: 'assistant', text: 'turn 31: ack' });

    const stub = stubSummarizer('updated tiny summary mentioning "ledger" still');
    expect((await compactConversation(convId, { summarize: stub.fn })).outcome).toBe(
      'below_threshold',
    );
    expect(stub.prompts).toHaveLength(0);

    const forced = await compactConversation(convId, { summarize: stub.fn, force: true });
    expect(forced.outcome).toBe('compacted');
    expect(forced.summaryThroughSeq).toBe(31 - KEEP_RECENT_TURNS);
  });

  it('the second real pass is INCREMENTAL: old summary in, folded turns out', async () => {
    // 10 more turns (seq 32..41) — over MIN_NEW_TURNS.
    for (let i = 32; i < 42; i++) {
      await appendTurn({
        conversationId: convId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `turn ${i}: follow-up work`,
      });
    }
    const before = await readConversationSummary(convId);
    const stub = stubSummarizer('merged summary v3 — ledger decision retained');
    const r = await compactConversation(convId, { summarize: stub.fn });
    expect(r.outcome).toBe('compacted');

    const prompt = stub.prompts[0];
    // Carries the prior summary verbatim (incremental, D-003)…
    expect(prompt).toContain(before!.summaryText!);
    // …and only the NEWLY aged-out turns: nothing already covered, none of
    // the KEEP_RECENT tail.
    expect(prompt).toContain('turn 20:'); // newly aged out (20 > 19)
    expect(prompt).not.toContain('turn 5:'); // folded long ago
    expect(prompt).not.toContain('turn 41:'); // still in the recent tail
  });

  it('CAS: a concurrent compactor that lands first wins; the loser is cas_lost', async () => {
    // 10 more turns so a pass is due.
    for (let i = 42; i < 52; i++) {
      await appendTurn({ conversationId: convId, role: 'user', text: `turn ${i}: racing` });
    }
    const winnerText = 'WINNER summary — landed first';
    // The loser's summarize step simulates a concurrent winner by advancing
    // the watermark mid-flight, then returning its own (now-stale) result.
    const loser = async (prompt: string): Promise<HaikuTurnResult | null> => {
      void prompt;
      const cur = await readConversationSummary(convId);
      const ok = await writeConversationSummary({
        conversationId: convId,
        expectedThroughSeq: cur!.summaryThroughSeq,
        summaryText: winnerText,
        summaryThroughSeq: cur!.summaryThroughSeq! + 1,
        summaryModel: 'stub-haiku',
        turnsAdded: 1,
      });
      expect(ok).toBe(true);
      return { text: 'LOSER summary — must not land', model: 'stub-haiku', costUsd: 0, tokensIn: 1, tokensOut: 1 };
    };
    const r = await compactConversation(convId, { summarize: loser });
    expect(r.outcome).toBe('cas_lost');
    expect((await readConversationSummary(convId))?.summaryText).toBe(winnerText);
  });

  it('budget gate: an exceeded daily cap skips compaction (D-004)', async () => {
    h.budgetExceeded = true;
    try {
      const stub = stubSummarizer('should never run');
      const r = await compactConversation(convId, { summarize: stub.fn, force: true });
      expect(r.outcome).toBe('budget_exceeded');
      expect(stub.prompts).toHaveLength(0);
    } finally {
      h.budgetExceeded = false;
    }
  });

  it('listTurnsBetween bounds are exclusive/inclusive as the engine assumes', async () => {
    const rows = await listTurnsBetween(convId, 2, 5);
    expect(rows.map((t) => t.seq)).toEqual([3, 4, 5]);
  });
});
