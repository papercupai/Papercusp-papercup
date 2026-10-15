/**
 * session-cursor-store.integration.test.ts — the P-001 live leg against a real
 * Postgres (ambient-semantic-push-2026-07-14; table: migration 609
 * harness_shared.session_cursor).
 *
 * What a fake-sql unit test can't prove and this does:
 *   • the `${terms}::text::jsonb` double-encode-avoidance — terms round-trips as
 *     a queryable jsonb ARRAY (jsonb_typeof = 'array'), not a string scalar;
 *   • upsert-on-session_id REPLACE semantics (one current cursor per session);
 *   • the recentSessionCursors owner / exclude / freshness filters + ordering;
 *   • the END-TO-END wiring buildAndPersistCursor rides: journal rows → the
 *     echo-guard (agent notes in, mechanical/flagged out) → buildCursor's
 *     class-weighted recency-decayed vector → persisted row → rowToCursor
 *     rehydrate. This is the P-001 "wired" evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  upsertSessionCursor,
  getSessionCursorRow,
  recentSessionCursors,
  cursorsByOwner,
  pruneSessionCursors,
  rowToCursor,
} = await import('./session-cursor-store');
const { buildAndPersistCursor } = await import('./session-cursor-io');
const { recordTurnJournal } = await import('./turn-journal-store');
const { buildCursor } = await import('./lexical-cursor');

let rootSql: postgres.Sql;

/** Insert a journal row directly (the ingest side is journal:record-turn; here
 *  we seed the notes buildAndPersistCursor reads). created_at controls the
 *  newest-first order the cursor decays over. */
async function seedJournal(over: {
  sessionId: string;
  note: string;
  source?: 'agent' | 'mechanical';
  flagged?: boolean;
  ownerId?: string | null;
  createdAt: string;
}): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.session_turn_journal
      (owner_id, agent, source_kind, session_id, turn_ts, note, source, flagged, tripwire, harness_slug, created_at)
    VALUES (
      ${over.ownerId ?? null}, 'claude', 'claude', ${over.sessionId}, ${over.createdAt}::timestamptz,
      ${over.note}, ${over.source ?? 'agent'}, ${over.flagged ?? false}, NULL, 'papercusp',
      ${over.createdAt}::timestamptz
    )`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `curs_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 609.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_cursor (
      session_id   text PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id     text,
      harness_slug text,
      turn_ts      timestamptz,
      note_count   integer NOT NULL DEFAULT 0,
      term_count   integer NOT NULL DEFAULT 0,
      terms        jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  // FAITHFUL to migration 605 (the journal rows buildAndPersistCursor reads).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_turn_journal (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id     text,
      agent        text,
      source_kind  text NOT NULL DEFAULT 'claude',
      session_id   text NOT NULL,
      turn_ts      timestamptz,
      note         text NOT NULL,
      source       text NOT NULL CHECK (source IN ('agent', 'mechanical')),
      flagged      boolean NOT NULL DEFAULT false,
      tripwire     jsonb,
      harness_slug text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`);
  // 605's dedup index. It was MISSING from this fixture despite the "FAITHFUL"
  // claim above, which made recordTurnJournal unusable here (its ON CONFLICT
  // targets exactly this expression index) — the fixture only ever seeded the
  // journal via raw INSERTs, so nothing noticed.
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX session_turn_journal_turn_uq
      ON harness_shared.session_turn_journal (session_id, COALESCE(turn_ts, 'epoch'::timestamptz))`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.session_cursor`;
  await rootSql`TRUNCATE harness_shared.session_turn_journal`;
});

/** A deliberately NON-'default' workspace: every write below must land here, so
 *  a regression to the old omit-the-column form (which silently fell back to the
 *  DDL `DEFAULT 'default'`) fails loudly instead of passing unnoticed. */
const TEST_WS = 'ws-cursor-test';

describe('workspace scoping (data-scoping-audit-2026-06-22 D-005 / P-007)', () => {
  it('writes the CALLER-SUPPLIED workspace, not the DDL default', async () => {
    const cursor = buildCursor(['scoping check WI-684'], { sessionId: 'ws1' });
    await upsertSessionCursor({
      workspaceId: TEST_WS,
      sessionId: 'ws1',
      ownerId: 'su-1',
      harnessSlug: 'papercusp',
      turnTs: null,
      cursor,
    });

    const row = (await rootSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.session_cursor WHERE session_id = 'ws1'`)[0]!;
    // The whole point of P-007 mechanism A: this used to be 'default' for EVERY
    // row because the INSERT omitted the column entirely.
    expect(row.workspace_id).toBe(TEST_WS);
    expect(row.workspace_id).not.toBe('default');
  });

  it('recordTurnJournal writes the CALLER-SUPPLIED workspace too (the sibling omitting writer)', async () => {
    // The journal is the other half of P-007 mechanism A, and the worse one: all
    // 10,361 live session_turn_journal rows are 'default' because this INSERT
    // omitted the column. Covered here because both writers share this file's
    // PG fixture (turn-journal.test.ts is the pure-core, no-PG suite).
    await recordTurnJournal({
      workspaceId: TEST_WS,
      ownerId: 'su-1',
      agent: 'claude',
      sourceKind: 'claude',
      sessionId: 'wsj1',
      turnTs: new Date('2026-07-14T10:00:00Z'),
      note: 'scoping check WI-684',
      source: 'agent',
      flagged: false,
      tripwire: null,
      harnessSlug: 'papercusp',
    });

    const row = (await rootSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.session_turn_journal WHERE session_id = 'wsj1'`)[0]!;
    expect(row.workspace_id).toBe(TEST_WS);
    expect(row.workspace_id).not.toBe('default');
  });

  it('re-scopes an existing session row on upsert (ON CONFLICT updates workspace_id)', async () => {
    const mk = (n: string) => buildCursor([`note ${n} WI-684`], { sessionId: 'ws2' });
    await upsertSessionCursor({
      workspaceId: 'default',
      sessionId: 'ws2',
      ownerId: 'su-1',
      harnessSlug: 'papercusp',
      turnTs: null,
      cursor: mk('a'),
    });
    await upsertSessionCursor({
      workspaceId: TEST_WS,
      sessionId: 'ws2',
      ownerId: 'su-1',
      harnessSlug: 'papercusp',
      turnTs: null,
      cursor: mk('b'),
    });

    const row = (await rootSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.session_cursor WHERE session_id = 'ws2'`)[0]!;
    // Self-healing: a row written before the fix does not stay stranded in
    // 'default' once the session writes again with a resolved workspace.
    expect(row.workspace_id).toBe(TEST_WS);
  });
});

describe('upsertSessionCursor (PG)', () => {
  it('stores terms as a queryable jsonb ARRAY (::text::jsonb), not a double-encoded string scalar', async () => {
    const cursor = buildCursor(['landed WI-4790 advisory-lock fix; compaction now settles cleanly'], { sessionId: 's1' });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'s1', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: '2026-07-14T10:00:00Z', cursor });

    const row = (await rootSql<{ typ: string; first_term: string; term_count: number; note_count: number }[]>`
      SELECT jsonb_typeof(terms) AS typ,
             terms->0->>'term' AS first_term,
             term_count, note_count
        FROM harness_shared.session_cursor WHERE session_id = 's1'`)[0]!;
    expect(row.typ).toBe('array'); // a real jsonb array, NOT a double-encoded string
    expect(row.first_term).toBe('WI-4790'); // highest weight (artifact-id class) survives ordering
    expect(row.term_count).toBeGreaterThan(0);
    expect(row.note_count).toBe(1);
  });

  it('rowToCursor rehydrates the full LexicalCursor (weightByTerm / classByTerm) from the stored row', async () => {
    const original = buildCursor(['debugging psu-launcher.mjs restart loop under compaction — WI-4790'], { sessionId: 's1' });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'s1', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: null, cursor: original });

    const row = await getSessionCursorRow('s1');
    expect(row).not.toBeNull();
    const hydrated = rowToCursor(row!);
    expect(hydrated.sessionId).toBe('s1');
    expect(hydrated.noteCount).toBe(1);
    expect(hydrated.terms).toEqual(original.terms);
    // The derived maps must match what buildCursor produced.
    expect(hydrated.weightByTerm.get('WI-4790')).toBe(original.weightByTerm.get('WI-4790'));
    expect(hydrated.classByTerm.get('WI-4790')).toBe('artifact-id');
    expect(hydrated.classByTerm.get('compaction')).toBe('domain-term');
  });

  it('upserts on session_id — a later turn REPLACES the cursor (one current cursor per session)', async () => {
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'s1', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['first note about WI-1111'], { sessionId: 's1' }) });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'s1', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['later note about WI-2222'], { sessionId: 's1' }) });

    const count = (await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.session_cursor`)[0]!.n;
    expect(count).toBe(1); // replaced, not appended
    const hydrated = rowToCursor((await getSessionCursorRow('s1'))!);
    expect(hydrated.weightByTerm.has('WI-2222')).toBe(true);
    expect(hydrated.weightByTerm.has('WI-1111')).toBe(false); // the old cursor is gone
  });
});

describe('recentSessionCursors (PG)', () => {
  it('filters by owner / exclude-session / freshness and orders freshest-first', async () => {
    const mk = (sid: string, owner: string) => buildCursor([`note for ${sid} about WI-4790`], { sessionId: sid });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'a', ownerId: 'su-A', harnessSlug: 'papercusp', turnTs: null, cursor: mk('a', 'su-A') });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'b', ownerId: 'su-B', harnessSlug: 'papercusp', turnTs: null, cursor: mk('b', 'su-B') });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'c', ownerId: 'su-B', harnessSlug: 'papercusp', turnTs: null, cursor: mk('c', 'su-B') });
    // Force a deterministic freshness order: a oldest, then b, then c newest.
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-14T09:00:00Z' WHERE session_id='a'`;
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-14T10:00:00Z' WHERE session_id='b'`;
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-14T11:00:00Z' WHERE session_id='c'`;

    const all = await recentSessionCursors();
    expect(all.map((r) => r.session_id)).toEqual(['c', 'b', 'a']); // freshest first

    const byOwner = await recentSessionCursors({ ownerId: 'su-B' });
    expect(byOwner.map((r) => r.session_id)).toEqual(['c', 'b']);

    const excluded = await recentSessionCursors({ excludeSessionId: 'c' });
    expect(excluded.map((r) => r.session_id)).toEqual(['b', 'a']);

    const fresh = await recentSessionCursors({ updatedSince: '2026-07-14T09:30:00Z' });
    expect(fresh.map((r) => r.session_id)).toEqual(['c', 'b']); // 'a' is below the floor
  });

  it('cursorsByOwner returns the FRESHEST cursor per owner (the P-002 presence-overlay read)', async () => {
    // su-B has two sessions; the fresher one must win. su-A has one; su-Z none.
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'b1', ownerId: 'su-B', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['older su-B note WI-1'], { sessionId: 'b1' }) });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'b2', ownerId: 'su-B', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['newer su-B note WI-2'], { sessionId: 'b2' }) });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'a1', ownerId: 'su-A', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['su-A note WI-3'], { sessionId: 'a1' }) });
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-14T09:00:00Z' WHERE session_id='b1'`;
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-14T11:00:00Z' WHERE session_id='b2'`;

    const map = await cursorsByOwner(['su-A', 'su-B', 'su-Z']);
    expect(map.size).toBe(2); // su-Z absent (no cursor)
    expect(map.get('su-B')!.session_id).toBe('b2'); // freshest session for the owner
    expect(map.get('su-A')!.session_id).toBe('a1');
    expect(map.has('su-Z')).toBe(false);
    expect(await cursorsByOwner([])).toEqual(new Map()); // empty input, no query
  });

  it('pruneSessionCursors drops stale rows and reports the count', async () => {
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'old', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['stale WI-1'], { sessionId: 'old' }) });
    await upsertSessionCursor({ workspaceId: TEST_WS, sessionId:'new', ownerId: 'su-1', harnessSlug: 'papercusp', turnTs: null, cursor: buildCursor(['fresh WI-2'], { sessionId: 'new' }) });
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = '2026-07-01T00:00:00Z' WHERE session_id='old'`;

    const removed = await pruneSessionCursors('2026-07-10T00:00:00Z');
    expect(removed).toBe(1);
    expect(await getSessionCursorRow('old')).toBeNull();
    expect(await getSessionCursorRow('new')).not.toBeNull();
  });
});

describe('buildAndPersistCursor — the end-to-end P-001 wiring', () => {
  it('mines the session journal into a persisted cursor, echo-guarding out mechanical/flagged notes', async () => {
    // Two AGENT notes (newest first by created_at) + one MECHANICAL flagged note
    // carrying a term that must NOT reach the cursor (echo-guard, ambient D-001).
    await seedJournal({ sessionId: 'sX', note: 'landed WI-4790 advisory-lock fix; compaction settles', ownerId: 'su-9', createdAt: '2026-07-14T12:00:00Z' });
    await seedJournal({ sessionId: 'sX', note: 'earlier work on the cursor pipeline and hysteresis', ownerId: 'su-9', createdAt: '2026-07-14T11:00:00Z' });
    await seedJournal({ sessionId: 'sX', note: 'mechanical fallback mentioning EI-8888 nobody authored', source: 'mechanical', flagged: true, ownerId: 'su-9', createdAt: '2026-07-14T11:30:00Z' });

    const res = await buildAndPersistCursor({ workspaceId: TEST_WS, sessionId: 'sX', ownerId: 'su-9', harnessSlug: 'papercusp', turnTs: '2026-07-14T12:00:00Z' });
    expect(res.persisted).toBe(true);
    expect(res.noteCount).toBe(2); // both agent notes, the mechanical/flagged one dropped

    const hydrated = rowToCursor((await getSessionCursorRow('sX'))!);
    expect(hydrated.weightByTerm.has('WI-4790')).toBe(true);
    expect(hydrated.weightByTerm.has('compaction')).toBe(true);
    expect(hydrated.weightByTerm.has('EI-8888')).toBe(false); // echo-guard held
    // artifact-id outweighs a domain term (class weighting survived the round-trip).
    expect(hydrated.terms[0]!.termClass).toBe('artifact-id');
    expect(hydrated.weightByTerm.get('WI-4790')!).toBeGreaterThan(hydrated.weightByTerm.get('compaction')!);

    const stored = await getSessionCursorRow('sX');
    expect(stored!.owner_id).toBe('su-9');
    expect(stored!.turn_ts).not.toBeNull();
  });

  it('persists nothing when the session has no echo-guard-eligible notes', async () => {
    await seedJournal({ sessionId: 'empty', note: 'only a mechanical note', source: 'mechanical', flagged: true, createdAt: '2026-07-14T12:00:00Z' });
    const res = await buildAndPersistCursor({ workspaceId: TEST_WS, sessionId: 'empty', ownerId: 'su-9', harnessSlug: 'papercusp', turnTs: null });
    expect(res.persisted).toBe(false);
    expect(res.cursor).toBeNull();
    expect(await getSessionCursorRow('empty')).toBeNull();
  });
});
