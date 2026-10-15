/**
 * Coverage for agent-chats-data pure helpers: isValidChatRole (rejects
 * 'feedback', otherwise gated on the known-roles registry) and rowToChat (the
 * PG-row → ChatRow mapping with transcript JSON-parse vs passthrough, bigint→
 * Number token/cost coercion, incomplete-provider-usage preservation, bigint
 * epoch-ms → ISO timestamp coercion (migration 116), null defaults).
 *
 * Plus listChats LIMIT/OFFSET bounding + column projection (F-C1): the query
 * is always bounded — default 100, clamped to 1..100, offset for paging — AND
 * projects only the needed columns (NO `SELECT *`, no `transcript` jsonb body;
 * just `jsonb_array_length(...) AS turn_count`) so the forever-growing
 * agent_chats table can't be SELECT *'d in full and a 100-row page doesn't drag
 * every transcript body over the wire.
 *
 * WI-5383: this module was migrated off getLegacyClient(slug).prepare(...) onto
 * harnessQuery(slug, (sql) => sql.unsafe(text, params)). db-org is mocked at the
 * harnessQuery seam (spreading the real module for every other export); the
 * fake `sql` handle exposes only `.unsafe`, which is all this file's functions
 * call. Every prepared statement is captured via `unsafe.mock.calls`, read
 * through the `calls()` helper below, so a test can assert exactly which
 * statements ran (and which DIDN'T) — same intent as the old `calls[]` log,
 * now sourced from the mock's own call history instead of a hand-rolled one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./known-roles', () => ({
  getKnownRoles: () => ['worker', 'scoper', 'validator', 'orchestrator'],
}));

// The live workspace the data layer must stamp on writes / filter reads by
// (WI-5125). Deliberately NOT 'default': the bug it guards was every chat
// silently landing in 'default' regardless of the active workspace, so a test
// asserting against 'default' would pass on the broken code.
const TEST_WS = 'papercusp-workspace';
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => TEST_WS }));

// harnessQuery's callback receives a postgres.js-shaped `sql` handle; every
// function in this file calls only `.unsafe(text, params)` on it, so a fake
// exposing just that method is enough to observe what was sent — same fake
// shape as dev-data-session-detail.test.ts / harness-core-parse-features.test.ts.
const unsafe = vi.fn();
const dbMocks = vi.hoisted(() => ({ harnessQuery: vi.fn() }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
}));

import {
  isValidChatRole,
  rowToChat,
  rowToChatSummary,
  listChats,
  getChat,
  createChat,
  renameChat,
  continueChat,
  archiveChat,
  appendExternalChatTurn,
  deleteExternalChatTurns,
  LIST_CHATS_DEFAULT_LIMIT,
  toPuiSessionRuntimeClass,
} from './agent-chats-data';

/** Every (sql, boundArgs) pair `.unsafe()` was invoked with, in order. */
function calls(): Array<{ sql: string; args: unknown[] }> {
  return unsafe.mock.calls.map((call: unknown[]) => ({
    sql: String(call[0]),
    args: (call[1] as unknown[] | undefined) ?? [],
  }));
}

beforeEach(() => {
  unsafe.mockReset();
  unsafe.mockResolvedValue([]);
  dbMocks.harnessQuery.mockReset();
  dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: (sql: { unsafe: typeof unsafe }) => unknown) =>
    fn({ unsafe }),
  );
});

describe('isValidChatRole', () => {
  it('accepts a known role', () => {
    expect(isValidChatRole('worker')).toBe(true);
  });
  it("rejects 'feedback' explicitly", () => {
    expect(isValidChatRole('feedback')).toBe(false);
  });
  it('rejects an unknown role', () => {
    expect(isValidChatRole('nonexistent')).toBe(false);
  });
});

describe('rowToChat', () => {
  it('parses a string transcript + coerces bigint totals', () => {
    const c = rowToChat({
      id: 'c1',
      role: 'worker',
      feature_id: 'F-1',
      title: 'Chat',
      transcript: JSON.stringify([{ role: 'user', text: 'hi' }]),
      total_input_tokens: 100n,
      total_output_tokens: 50n,
      total_cost_usd_cents: 7n,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    });
    expect(c.transcript).toEqual([{ role: 'user', text: 'hi' }]);
    expect(c.total_input_tokens).toBe(100);
    expect(c.total_output_tokens).toBe(50);
    expect(c.total_cost_usd_cents).toBe(7);
    expect(c.usage_complete).toBe(true);
    expect(c.archived_at).toBeNull();
  });

  it('coerces bigint/number/string epoch-ms timestamps to ISO (migration 116)', () => {
    const ms = 1_700_000_000_000;
    const iso = new Date(ms).toISOString();
    // bigint (postgres-js int8), number, and numeric-string all coerce.
    expect(rowToChat({ id: 'c', role: 'worker', created_at: BigInt(ms), updated_at: ms }).created_at).toBe(iso);
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: String(ms) }).updated_at).toBe(iso);
    // archived_at: null stays null, a value coerces to ISO.
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: ms }).archived_at).toBeNull();
    expect(rowToChat({ id: 'c', role: 'worker', created_at: ms, updated_at: ms, archived_at: ms }).archived_at).toBe(iso);
  });

  it('passes an array transcript through + defaults missing fields', () => {
    const c = rowToChat({ id: 'c2', role: 'scoper', transcript: [{ role: 'a', text: 'b' }], created_at: 'c', updated_at: 'u' });
    expect(c.transcript).toEqual([{ role: 'a', text: 'b' }]);
    expect(c.feature_id).toBeNull();
    expect(c.title).toBeNull();
    expect(c.total_input_tokens).toBe(0);
    expect(c.total_cost_usd_cents).toBe(0);
    expect(c.usage_complete).toBe(true);
  });

  it('redacts a legacy raw backend failure turn when loading a chat row', () => {
    const rawError = 'codex exited 1: internal backend path and provider details';
    const c = rowToChat({
      id: 'legacy-error-chat',
      role: 'worker',
      transcript: [{ role: 'assistant', content: rawError, ts: '2026-09-27T16:01:00.000Z', error: true }],
      created_at: 'c',
      updated_at: 'u',
    });

    expect(c.transcript[0]).toMatchObject({
      role: 'assistant',
      content: 'That turn did not complete. Try asking again.',
      error: true,
    });
    expect(c.transcript[0].content).not.toContain('internal backend path');
  });

  it('defaults an absent transcript to []', () => {
    const c = rowToChat({ id: 'c3', role: 'worker', created_at: 'c', updated_at: 'u' });
    expect(c.transcript).toEqual([]);
  });
});

describe('rowToChatSummary', () => {
  it('coerces bigint/number turn_count + totals and never carries a transcript', () => {
    const s = rowToChatSummary({
      id: 'c1',
      role: 'worker',
      feature_id: 'F-1',
      title: 'Chat',
      turn_count: 12n,
      total_input_tokens: 100,
      total_output_tokens: 50n,
      total_cost_usd_cents: 7n,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      archived_at: null,
    });
    expect(s.turn_count).toBe(12);
    expect(s.total_input_tokens).toBe(100);
    expect(s.total_output_tokens).toBe(50);
    expect(s.usage_complete).toBe(false);
    expect(s).not.toHaveProperty('transcript');
    expect(s.created_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(s.archived_at).toBeNull();
  });

  it('defaults a missing turn_count to 0', () => {
    const s = rowToChatSummary({ id: 'c2', role: 'scoper', created_at: 'c', updated_at: 'u' });
    expect(s.turn_count).toBe(0);
    expect(s.feature_id).toBeNull();
    expect(s.title).toBeNull();
  });

  it('marks a detail row incomplete when an assistant turn reports missing usage', () => {
    const c = rowToChat({
      id: 'incomplete',
      role: 'worker',
      transcript: [{
        role: 'assistant',
        content: 'reply',
        ts: '2026-09-13T00:00:00Z',
        tokens_in: 0,
        tokens_out: 0,
        cost_cents: 0,
        unreportedFrames: 1,
      }],
    });
    expect(c.total_input_tokens).toBe(0);
    expect(c.usage_complete).toBe(false);
  });
});

describe('listChats — bounded query (F-C1)', () => {
  it('always applies a LIMIT + OFFSET (default 100, offset 0)', async () => {
    const r = await listChats({ slug: 'foo' });
    expect(r.ok).toBe(true);
    const [sql, args] = unsafe.mock.calls[0]!;
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    expect(sql).toContain('archived_at IS NULL'); // active-only by default
    expect(args).toEqual([TEST_WS, LIST_CHATS_DEFAULT_LIMIT, 0]);
  });

  it('projects columns (no SELECT *, no transcript body — turn_count instead)', async () => {
    await listChats({ slug: 'foo' });
    const [sql] = unsafe.mock.calls[0]!;
    expect(sql).not.toContain('SELECT *');
    // the heavy jsonb body is replaced by its length
    expect(sql).toContain('jsonb_array_length');
    expect(sql).toContain('AS turn_count');
    expect(sql).toContain('AS usage_complete');
    // `transcript` is referenced exactly ONCE — inside the length expression,
    // never selected as a bare body column.
    expect((String(sql).match(/transcript/g) ?? []).length).toBe(2);
    expect(sql).toContain('COALESCE(transcript');
  });

  it('maps projected rows via rowToChatSummary (turn_count, no transcript field)', async () => {
    unsafe.mockResolvedValueOnce([
      {
        id: 'c1',
        role: 'worker',
        feature_id: 'F-1',
        title: 'Chat',
        turn_count: 4n,
        total_input_tokens: 10n,
        total_output_tokens: 5n,
        total_cost_usd_cents: 2n,
        usage_complete: true,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        archived_at: null,
      },
    ]);
    const r = await listChats({ slug: 'foo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [chat] = r.data.chats;
    expect(chat.turn_count).toBe(4);
    expect(chat).not.toHaveProperty('transcript');
    expect(chat.total_input_tokens).toBe(10);
    expect(chat.usage_complete).toBe(true);
  });

  it('clamps limit above 100 down to 100', async () => {
    await listChats({ slug: 'foo', limit: 5000 });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([TEST_WS, 100, 0]);
  });

  it('clamps limit at/below 0 up to 1', async () => {
    await listChats({ slug: 'foo', limit: 0 });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([TEST_WS, 1, 0]);
    unsafe.mockClear();
    await listChats({ slug: 'foo', limit: -10 });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([TEST_WS, 1, 0]);
  });

  it('threads a custom limit + offset (keyset paging)', async () => {
    await listChats({ slug: 'foo', limit: 25, offset: 50 });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([TEST_WS, 25, 50]);
  });

  it('floors a negative offset to 0 and truncates fractional values', async () => {
    await listChats({ slug: 'foo', limit: 10.9, offset: -3 });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([TEST_WS, 10, 0]);
  });

  it('includeArchived drops the archived_at filter but stays bounded', async () => {
    await listChats({ slug: 'foo', includeArchived: true, limit: 30 });
    const [sql, args] = unsafe.mock.calls[0]!;
    expect(sql).toContain('LIMIT $2 OFFSET $3');
    expect(sql).not.toContain('archived_at IS NULL');
    expect(args).toEqual([TEST_WS, 30, 0]);
  });

  // WI-5125 — the list MUST be workspace-scoped, archived or not.
  //
  // The per-harness `agent_chats` view filters on harness_slug ALONE, so an
  // unscoped list returns rows from every workspace sharing the slug.
  // openFeatureChat's reuse-before-create picks an existing chat off this list:
  // an unscoped hit hands ChatPanel a foreign chat id whose workspace-scoped
  // detail read then matches nothing — the "loading chat…" spinner, reproduced
  // even with a correct create path. This is the guard for that second path.
  it.each([
    ['active-only', { slug: 'foo' }],
    ['includeArchived', { slug: 'foo', includeArchived: true }],
  ])('scopes the list to the active workspace (%s) (WI-5125)', async (_label, args) => {
    await listChats(args);
    const [sql, sqlArgs] = unsafe.mock.calls[0]!;
    expect(sql).toContain('workspace_id = $1');
    expect((sqlArgs as unknown[])[0]).toBe(TEST_WS);
  });
});

// ── write/read paths against the fake harnessQuery/sql.unsafe ──────────────
// These exercise the SQL each fn issues + the result envelope. `calls()` lets
// us assert exactly which statements ran — crucial for AC2, where the dead
// `pre` SELECT must NOT run.

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  role: 'worker',
  feature_id: null,
  title: 'Chat',
  transcript: '[]',
  total_input_tokens: 0n,
  total_output_tokens: 0n,
  total_cost_usd_cents: 0n,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  archived_at: null,
  ...over,
});

describe('getChat', () => {
  it('404s when the row is absent', async () => {
    unsafe.mockResolvedValueOnce([]);
    const r = await getChat({ slug: 'foo', chatId: 'missing' });
    expect(r).toEqual({ ok: false, status: 404, error: 'chat not found' });
    // only the chat SELECT ran — no feature-lock probe for a missing chat
    expect(calls()).toHaveLength(1);
    expect(calls()[0].sql).toContain('SELECT * FROM agent_chats WHERE id = $1');
    expect(calls()[0].args).toEqual(['missing']);
  });

  it('returns the mapped chat with feature_lock=null when no feature_id', async () => {
    unsafe.mockResolvedValueOnce([ROW({ feature_id: null })]);
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe('c1');
    expect(r.data.feature_lock).toBeNull();
    // no harness_features probe when feature_id is null
    expect(calls().some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('reads feature-lock state when the chat carries a feature_id', async () => {
    unsafe
      // 1st .unsafe → the chat row (feature-locked)
      .mockResolvedValueOnce([ROW({ feature_id: 'F-7' })])
      // 2nd .unsafe → readFeatureLockState's harness_features row
      .mockResolvedValueOnce([{ taken_by: 'worker-3', taken_at: 't', expires_at: null }]);
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toEqual({
      taken_by: 'worker-3',
      taken_at: 't',
      expires_at: null,
      active: true,
    });
    // the lock probe queried harness_features by (slug, feature_id)
    const probe = calls().find((c) => /harness_features/.test(c.sql));
    expect(probe).toBeDefined();
    expect(probe?.args).toEqual(['foo', 'F-7']);
  });

  it('wraps a thrown error as a 500 envelope', async () => {
    unsafe.mockRejectedValueOnce(new Error('pg exploded'));
    const r = await getChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to load chat: pg exploded' });
  });
});

describe('createChat', () => {
  it('rejects an unknown role before touching the db', async () => {
    const r = await createChat({ slug: 'foo', role: 'bogus' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/role must be one of/);
    expect(calls()).toHaveLength(0); // never reached the db
  });

  it('rejects a malformed feature_id before touching the db', async () => {
    const r = await createChat({ slug: 'foo', role: 'worker', feature_id: 'not a feature' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/invalid feature_id/);
    expect(calls()).toHaveLength(0);
  });

  it('inserts then re-selects the row; defaults title to role when no feature', async () => {
    unsafe
      .mockResolvedValueOnce([]) // the INSERT (return value unused)
      .mockResolvedValueOnce([ROW({ role: 'worker', title: 'worker', feature_id: null })]); // the re-SELECT
    const r = await createChat({ slug: 'foo', role: 'worker' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toBeNull();
    // one INSERT + one SELECT, no harness_features probe
    const insert = calls().find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert).toBeDefined();
    // INSERT bound args:
    // (id, workspace_id, role, feature_id, title, transcript, su_runtime_class)
    expect(insert?.args.slice(1)).toEqual([TEST_WS, 'worker', null, 'worker', '[]', 'su-session']);
    expect(calls().some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('derives "role · feature" title and probes the feature lock when feature_id given', async () => {
    unsafe
      .mockResolvedValueOnce([]) // the INSERT
      .mockResolvedValueOnce([ROW({ role: 'worker', feature_id: 'F-9', title: 'worker · F-9' })]) // the re-SELECT
      .mockResolvedValueOnce([{ taken_by: null, taken_at: null, expires_at: null }]); // readFeatureLockState
    const r = await createChat({ slug: 'foo', role: 'worker', feature_id: 'F-9' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.feature_lock).toEqual({
      taken_by: null,
      taken_at: null,
      expires_at: null,
      active: false, // taken_by null → not active
    });
    const insert = calls().find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert?.args.slice(1)).toEqual([
      TEST_WS,
      'worker',
      'F-9',
      'worker · F-9',
      '[]',
      // P-011: the dispatch policy this conversation is born under.
      'su-session',
    ]);
    expect(calls().some((c) => /harness_features/.test(c.sql))).toBe(true);
  });

  it('honors an explicit title over the derived default', async () => {
    unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW({ role: 'scoper', title: 'Custom' })]);
    await createChat({ slug: 'foo', role: 'scoper', title: 'Custom' });
    const insert = calls().find((c) => /INSERT INTO agent_chats/.test(c.sql));
    // (id, workspace_id, role, feature_id, title, …) — title is arg 4.
    expect(insert?.args[4]).toBe('Custom');
  });

  // WI-5125 — the owner-reported "loading chat… forever" bug.
  //
  // The per-harness `agent_chats` view carried
  // `ALTER COLUMN workspace_id SET DEFAULT 'default'` (migration 116), so a
  // create that OMITTED workspace_id silently succeeded with the wrong tenant:
  // every chat filed under 'default' while the UI reads the row scoped to the
  // ACTIVE workspace → zero rows → an eternal spinner. The column must be
  // stamped EXPLICITLY from the live registry; the view default cannot know it.
  it('stamps the ACTIVE workspace on the insert — never the view default (WI-5125)', async () => {
    unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW({ role: 'worker', title: 'worker', feature_id: null })]);
    await createChat({ slug: 'foo', role: 'worker' });
    const insert = calls().find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert?.sql).toMatch(/workspace_id/);
    expect(insert?.args[1]).toBe(TEST_WS);
    expect(insert?.args[1]).not.toBe('default');
  });

  it('wraps an insert failure as a 500 envelope', async () => {
    unsafe.mockRejectedValueOnce(new Error('unique violation'));
    const r = await createChat({ slug: 'foo', role: 'worker' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to create chat: unique violation' });
  });
});

// ── P-011 PUI session runtime classification ────────────────────────────────
//
// pui-su-session-runtime-correction-2026-08-27 P-011 / WI-287136. The cutover
// makes the SU-session host the default for a NEW PUI conversation, which turns
// "this chat has no adv_sessions binding" into an ambiguous reading: it is what a
// pre-cutover conversation looks like AND what a chat created two seconds ago
// looks like. The stamp is what separates them, so these cover the writer that
// produces it and the reader that refuses to guess when it is absent.
describe('PUI session runtime class (P-011)', () => {
  const CLASS_ARG = 6; // (id, workspace_id, role, feature_id, title, transcript, su_runtime_class)

  it('always stamps a newly created chat as su-session', async () => {
    unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([ROW({ role: 'worker', title: 'worker', feature_id: null })]);
    await createChat({ slug: 'foo', role: 'worker' });
    const insert = calls().find((c) => /INSERT INTO agent_chats/.test(c.sql));
    expect(insert?.sql).toMatch(/su_runtime_class/);
    expect(insert?.args[CLASS_ARG]).toBe('su-session');
  });

  it('reads only the two legal classes; anything else is UNCLASSIFIED, not a guess', () => {
    expect(toPuiSessionRuntimeClass('su-session')).toBe('su-session');
    expect(toPuiSessionRuntimeClass('legacy-owned-loop')).toBe('legacy-owned-loop');
    for (const raw of [null, undefined, '', 'owned-loop', 'SU-SESSION', 0, {}]) {
      expect(toPuiSessionRuntimeClass(raw)).toBeNull();
    }
  });

  it('surfaces the stamp on both the detail row and the list projection', () => {
    expect(rowToChat({ ...ROW({}), su_runtime_class: 'legacy-owned-loop' }).su_runtime_class).toBe(
      'legacy-owned-loop',
    );
    // A pre-stamp row reads as null — the PUI renders that as "unclassified" and
    // holds the conversation rather than re-homing it.
    expect(rowToChat(ROW({})).su_runtime_class).toBeNull();
    expect(
      rowToChatSummary({ id: 'c1', role: 'worker', su_runtime_class: 'su-session' })
        .su_runtime_class,
    ).toBe('su-session');
  });

  it('projects the class in the list query — the PUI classifies from summaries', async () => {
    // The TUI reducer derives a loaded conversation's class from the summary row
    // that arrives with it (apps/tui/src/app.rs, Event::AgentChatLoaded). If the
    // list stopped projecting the column every conversation would read as
    // unclassified and the cutover would silently never take effect. Asserted
    // through the real query rather than the private column constant, so it
    // cannot pass on a projection the list does not actually issue.
    await listChats({ slug: 'foo' });
    const select = calls().find((c) => /FROM agent_chats/.test(c.sql));
    expect(select?.sql).toMatch(/su_runtime_class/);
  });
});

describe('agent-chat rename and linked continuation (public-release P-008)', () => {
  it('renames a workspace-scoped chat with normalized bounded text', async () => {
    unsafe.mockResolvedValueOnce([{ title: 'A clearer title' }]);
    const result = await renameChat({
      slug: 'foo',
      chatId: 'source-chat',
      title: '  A\nclearer\ttitle  ',
    });
    expect(result).toEqual({ ok: true, data: { title: 'A clearer title' } });
    expect(calls()[0].sql).toMatch(/workspace_id = \$3 AND id = \$4/);
    expect(calls()[0].args).toEqual([
      'A clearer title',
      expect.any(Number),
      TEST_WS,
      'source-chat',
    ]);
  });

  it('snapshots source text into a new writable identity with durable lineage', async () => {
    const transcript = [
      { role: 'user', content: 'historic question', ts: '2026-09-01T00:00:00Z' },
      { role: 'assistant', content: 'historic answer', ts: '2026-09-01T00:00:01Z' },
    ];
    unsafe
      .mockResolvedValueOnce([
        { role: 'worker', feature_id: null, title: 'Legacy', transcript },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        ROW({
          id: 'successor',
          title: 'Legacy · continued',
          transcript,
          su_runtime_class: 'su-session',
          continued_from_chat_id: 'source-chat',
          continued_from_turn_count: 2,
        }),
      ]);

    const result = await continueChat({ slug: 'foo', sourceChatId: 'source-chat' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe('successor');
    expect(result.data.transcript).toEqual(transcript);
    expect(result.data.su_runtime_class).toBe('su-session');
    expect(result.data.continued_from_chat_id).toBe('source-chat');
    expect(result.data.continued_from_turn_count).toBe(2);

    const insert = calls().find((call) => /INSERT INTO agent_chats/.test(call.sql));
    expect(insert?.sql).toMatch(/continued_from_chat_id, continued_from_turn_count/);
    expect(insert?.args.slice(1)).toEqual([
      TEST_WS,
      'worker',
      null,
      'Legacy · continued',
      JSON.stringify(transcript),
      'source-chat',
      2,
    ]);
    expect(calls().some((call) => /UPDATE agent_chats/.test(call.sql))).toBe(false);
  });

  it('does not create a continuation when the source identity is absent', async () => {
    unsafe.mockResolvedValueOnce([]);
    await expect(continueChat({ slug: 'foo', sourceChatId: 'missing' })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'source chat not found',
    });
    expect(calls()).toHaveLength(1);
  });
});

describe('archiveChat (AC2 — orphaned `pre` SELECT removed)', () => {
  it('issues ONLY the archive UPDATE — no role/feature_id pre-SELECT', async () => {
    const r = await archiveChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: true, data: { ok: true } });
    // exactly one statement: the UPDATE. The dead `SELECT role, feature_id`
    // (orphaned by the experts-rip-out refactor) must NOT run — this test
    // FAILS against the old code, which prepared+ran that extra SELECT.
    expect(calls()).toHaveLength(1);
    expect(calls()[0].sql).toMatch(/UPDATE agent_chats SET archived_at = \$1, updated_at = \$2 WHERE id = \$3/);
    // and nobody SELECTed role/feature_id as a side-channel
    expect(calls().some((c) => /SELECT role, feature_id/.test(c.sql))).toBe(false);
    // archiving never touches a feature lock
    expect(calls().some((c) => /harness_features/.test(c.sql))).toBe(false);
  });

  it('sets archived_at and updated_at to the same epoch-ms, keyed by chatId', async () => {
    const before = Date.now();
    await archiveChat({ slug: 'foo', chatId: 'c1' });
    const after = Date.now();
    const [archivedAt, updatedAt, id] = calls()[0].args as [number, number, string];
    expect(archivedAt).toBe(updatedAt); // single now() snapshot
    expect(archivedAt).toBeGreaterThanOrEqual(before);
    expect(archivedAt).toBeLessThanOrEqual(after);
    expect(id).toBe('c1');
  });

  it('wraps an update failure as a 500 envelope', async () => {
    unsafe.mockRejectedValueOnce(new Error('deadlock'));
    const r = await archiveChat({ slug: 'foo', chatId: 'c1' });
    expect(r).toEqual({ ok: false, status: 500, error: 'failed to archive chat: deadlock' });
  });
});

describe('appendExternalChatTurn (P-010)', () => {
  it('appends a server-originated turn with source metadata and active workspace scope', async () => {
    unsafe.mockResolvedValueOnce([{ id: 'c1' }]); // UPDATE ... RETURNING id: matched
    const result = await appendExternalChatTurn({
      slug: 'portal', chatId: 'c1', role: 'user', content: 'spoken hello',
      sourceId: 'room-1:0', source: 'phone-livekit', ts: '2026-08-31T18:00:00.000Z',
    });
    expect(result).toEqual({ ok: true, data: { appended: true } });
    expect(calls()).toHaveLength(1); // matched — no fallback SELECT needed
    expect(calls()[0]?.sql).toContain('source_id');
    expect(calls()[0]?.sql).toContain('workspace_id = $3');
    expect(calls()[0]?.args[2]).toBe(TEST_WS);
    expect(JSON.parse(String(calls()[0]?.args[0]))).toEqual([expect.objectContaining({
      role: 'user', content: 'spoken hello', source: 'phone-livekit', source_id: 'room-1:0',
    })]);
  });

  it('returns appended=false for a duplicate source id without another write', async () => {
    unsafe
      .mockResolvedValueOnce([]) // UPDATE ... RETURNING: duplicate/no row matched
      .mockResolvedValueOnce([{ id: 'c1' }]); // fallback existence-check SELECT
    const result = await appendExternalChatTurn({
      slug: 'portal', chatId: 'c1', role: 'assistant', content: 'spoken reply',
      sourceId: 'room-1:0', source: 'phone-livekit',
    });
    expect(result).toEqual({ ok: true, data: { appended: false } });
    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.sql).toContain('SELECT id FROM agent_chats');
  });

  it('reports a missing chat distinctly from an idempotent duplicate', async () => {
    unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const result = await appendExternalChatTurn({
      slug: 'portal', chatId: 'missing', role: 'user', content: 'spoken',
      sourceId: 'room-1:1', source: 'phone-livekit',
    });
    expect(result).toEqual({ ok: false, status: 404, error: 'chat not found' });
  });
});

describe('deleteExternalChatTurns (WI-10006406)', () => {
  it('removes only this room\'s phone turns, scoped to the active workspace', async () => {
    unsafe.mockResolvedValueOnce([{ removed: 2 }]);
    const result = await deleteExternalChatTurns({
      slug: 'portal', chatId: 'c1', source: 'phone-livekit', roomName: 'room-1',
    });
    expect(result).toEqual({ ok: true, data: { removed: 2 } });
    expect(calls()).toHaveLength(1);
    const [call] = calls();
    expect(call?.sql).toContain('starts_with');
    expect(call?.sql).toContain('ORDER BY t.ord');
    expect(call?.sql).toContain('workspace_id = $1');
    // The trailing colon is what keeps room-1 from matching room-10's ids.
    expect(call?.args.slice(0, 4)).toEqual([TEST_WS, 'c1', 'phone-livekit', 'room-1:']);
  });

  it('reports a missing chat as 404 and a no-op deletion as removed 0', async () => {
    unsafe.mockResolvedValueOnce([]);
    expect(await deleteExternalChatTurns({ slug: 'portal', chatId: 'gone', source: 'phone-livekit', roomName: 'r' }))
      .toEqual({ ok: false, status: 404, error: 'chat not found' });
    unsafe.mockResolvedValueOnce([{ removed: '0' }]);
    expect(await deleteExternalChatTurns({ slug: 'portal', chatId: 'c1', source: 'phone-livekit', roomName: 'r' }))
      .toEqual({ ok: true, data: { removed: 0 } });
  });

  it('refuses a room name that could prefix-match another room before touching the database', async () => {
    for (const roomName of ['', '   ', 'a:b', 'x'.repeat(201)]) {
      expect(await deleteExternalChatTurns({ slug: 'portal', chatId: 'c1', source: 'phone-livekit', roomName }))
        .toEqual({ ok: false, status: 400, error: 'roomName is invalid' });
    }
    expect(calls()).toHaveLength(0);
  });
});
