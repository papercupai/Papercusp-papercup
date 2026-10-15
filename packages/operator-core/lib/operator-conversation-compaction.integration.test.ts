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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { HaikuTurnResult } from './haiku';

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
const { compactConversation, KEEP_RECENT_TURNS } = await import(
  './operator-conversation-compaction'
);

let rootSql: postgres.Sql;

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

describe('conversation compaction lifecycle (PG)', () => {
  let convId: string;

  it('seeds a long conversation and the first pass folds the aged-out backlog', async () => {
    const conv = await getOrCreateActiveConversation();
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
