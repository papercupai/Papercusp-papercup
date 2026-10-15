/**
 * EI-22450051857376317 — exercise the sessions:read SQL through public
 * projected dispatch, not a SQL-string assertion. The shared private-PG
 * fixture uses prepare:false, as production does; untyped substring bounds
 * can resolve to PostgreSQL's pattern/escape overload instead of integers.
 *
 * Only discovery/ingestion seams are pinned: this does not test filesystem
 * self-resolution, network MCP transport, or any deployed operator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../../../test/_disclosure-ledger-fixture';

const refreshTargetSessionBeforeRead = vi.hoisted(() => vi.fn(async () => ({ attempted: 1, refreshed: 1 })));
const refreshLiveSessionsBeforeRead = vi.hoisted(() => vi.fn(async () => ({ attempted: 1, refreshed: 1 })));
const resolveSearchFilters = vi.hoisted(() => vi.fn(async () => ({
  filters: { owners: ['su-read-pg', 'su-read-pg-predecessor'] },
  selfSession: { sourceKind: 'codex', sessionId: 'successor' },
})));
const readArchivedSessionTurns = vi.hoisted(() => vi.fn(async () => null));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshTargetSessionBeforeRead,
  refreshLiveSessionsBeforeRead,
}));
vi.mock('../search/filters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSearchFilters,
}));
vi.mock('../../session-archive-read', () => ({ readArchivedSessionTurns }));

await import('./read');
await import('./search');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('sessions:read')!;
const projectedSearch = lookupByMcpName('sessions:search')!;

const WORKSPACE = 'ws-sessions-read-pg';
const OWNER = 'su-read-pg';
// BMP Unicode makes the character-window assertion non-ASCII without
// conflating PostgreSQL character offsets with UTF-16 surrogate offsets.
const LONG_TEXT = '0123456789é漢'.repeat(530);
let db: FreshPgDb;
let sql: postgres.Sql;

interface ReadResult {
  ok: boolean;
  session_id: string | null;
  session_ids?: Array<{ source_kind: string; session_id: string }>;
  turn_count: number;
  turns: Array<{
    ref: string;
    turn_idx: number;
    owner?: string;
    text: string;
    text_offset?: number;
    text_truncated?: boolean;
    text_full_chars?: number;
    readMore?: { tool: string; args: Record<string, unknown> };
  }>;
}

beforeAll(async () => {
  db = await createFreshPgDb('sessions-read');
  sql = db.sql;
  // D-006: both reads consult the disclosure ledger (empty here: nothing is withheld).
  await sql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  // Minimal projection of the indexed read table, following digest's fixture.
  // No application DB default, migrations, background ingestion or live rows.
  await sql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL,
      source_kind text NOT NULL,
      session_id text NOT NULL,
      turn_idx integer NOT NULL,
      ts timestamptz,
      owner text,
      harness_slug text,
      cwd text,
      speaker text NOT NULL,
      turn_origin_verdict text,
      text text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    )
  `);
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
    VALUES
      (${WORKSPACE}, 'codex', 'predecessor', 90, '2026-01-01T00:00:00Z', 'su-read-pg-predecessor', 'user', 'before carry'),
      (${WORKSPACE}, 'codex', 'successor', 0, '2026-01-01T00:01:00Z', ${OWNER}, 'user', 'successor kickoff'),
      (${WORKSPACE}, 'codex', 'successor', 1, '2026-01-01T00:02:00Z', ${OWNER}, 'assistant', 'successor middle'),
      (${WORKSPACE}, 'codex', 'successor', 2, '2026-01-01T00:03:00Z', ${OWNER}, 'assistant', ${LONG_TEXT}),
      ('default', 'codex', 'legacy', 0, '2025-12-31T00:00:00Z', 'su-read-pg-predecessor', 'user', 'legacy corpus row'),
      ('ws-excluded', 'codex', 'successor', 2, '2026-01-02T00:00:00Z', ${OWNER}, 'assistant', 'WRONG workspace'),
      (${WORKSPACE}, 'claude', 'successor', 2, '2026-01-03T00:00:00Z', ${OWNER}, 'assistant', 'WRONG source'),
      (${WORKSPACE}, 'codex', 'unrelated', 0, '2026-01-04T00:00:00Z', 'su-unrelated', 'assistant', 'WRONG owner')
  `;
}, 60_000);

beforeEach(() => vi.clearAllMocks());

afterAll(async () => {
  await db?.cleanup();
});

async function dispatch(args: Record<string, unknown>) {
  return dispatchProjectedTool(projected, 'sessions:read', args, {
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: WORKSPACE, uiClientId: OWNER, isSuperuser: true,
    runId: 'sessions-read-private-pg', role: 'operator',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    tx: sql,
  }, {});
}

async function read(args: Record<string, unknown>): Promise<ReadResult> {
  const result = await dispatch(args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.result?.structuredContent).toMatchObject({ ok: true });
  return result.result!.structuredContent as unknown as ReadResult;
}

describe('sessions:read private-PG substring and scoped windows', () => {
  it('reproduces the uncast escape error and distinguishes the integer repair', async () => {
    const start = 1;
    const length = 1_500;
    // Historical query, kept as a negative control without mutating source.
    await expect(sql`
      SELECT substring(text FROM ${start} FOR ${length}) AS text
      FROM harness_shared.session_turns
      WHERE workspace_id = ${WORKSPACE} AND source_kind = 'codex'
        AND session_id = 'successor' AND turn_idx = 2
    `).rejects.toMatchObject({ code: '22025', message: 'invalid escape string' });
    const rows = await sql`
      SELECT substring(text FROM ${start}::int FOR ${length}::int) AS text
      FROM harness_shared.session_turns
      WHERE workspace_id = ${WORKSPACE} AND source_kind = 'codex'
        AND session_id = 'successor' AND turn_idx = 2
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(LONG_TEXT.slice(0, length));
  });

  it('reads a named tail chronologically, excluding same-key workspace/source decoys', async () => {
    const result = await read({ session: 'successor', source_kind: 'codex', tail: 2 });
    expect(result.session_id).toBe('successor');
    expect(result.turn_count).toBe(2);
    expect(result.turns.map((turn) => turn.turn_idx)).toEqual([1, 2]);
    expect(result.turns.map((turn) => turn.text)).toEqual([
      'successor middle', LONG_TEXT.slice(0, 1_500),
    ]);
    expect(refreshTargetSessionBeforeRead).toHaveBeenCalledWith(sql, 'codex', 'successor');
    expect(readArchivedSessionTurns).not.toHaveBeenCalled();
  });

  it('executes the exact readMore args emitted by sessions:search', async () => {
    const searchResult = await dispatchProjectedTool(
      projectedSearch,
      'sessions:search',
      { query: 'successor middle', mode: 'verbatim', session: 'successor', context: 0, limit: 1 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: WORKSPACE, uiClientId: OWNER, isSuperuser: true,
        runId: 'sessions-search-readmore-contract', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: sql,
      },
      {},
    );
    expect(searchResult.ok, JSON.stringify(searchResult)).toBe(true);
    const searchText = searchResult.result?.content?.[0];
    expect(searchText?.type).toBe('text');
    const searchBody = JSON.parse((searchText as { text: string }).text) as {
      results: Array<{ readMore?: { tool: string; args: Record<string, unknown> } }>;
    };
    const readMore = searchBody.results[0]?.readMore;
    expect(readMore).toEqual({
      tool: 'sessions:read',
      args: { ref: 'session_turn:codex:successor:1', context: 10 },
    });

    const readResult = await read(readMore!.args);
    expect(readResult.turns.map((turn) => turn.turn_idx)).toEqual([0, 1, 2]);
    expect(readResult.turns[1]?.text).toBe('successor middle');
  });

  it('honors a named head/range and canonical ref context with real SQL bounds', async () => {
    const head = await read({ session: 'successor', source_kind: 'codex', order: 'asc', limit: 1 });
    expect(head.turns.map((turn) => turn.turn_idx)).toEqual([0]);
    const range = await read({ session: 'successor', source_kind: 'codex', from_idx: 1, to_idx: 1 });
    expect(range.turns.map((turn) => turn.text)).toEqual(['successor middle']);
    const around = await read({ ref: 'session_turn:codex:successor:1', context: 1 });
    expect(around.turns.map((turn) => turn.turn_idx)).toEqual([0, 1, 2]);
  });

  it('reads self across the pinned owner chain by time, not predecessor turn index', async () => {
    const result = await read({ session: 'self', tail: 4, text_limit: 10 });
    expect(resolveSearchFilters).toHaveBeenCalledWith(
      sql, { session: 'self' }, OWNER, { workspaceId: WORKSPACE },
    );
    expect(result.session_id).toBeNull();
    expect(result.session_ids).toEqual([
      { source_kind: 'codex', session_id: 'predecessor' },
      { source_kind: 'codex', session_id: 'successor' },
    ]);
    expect(result.turn_count).toBe(4);
    expect(result.turns.map((turn) => turn.ref)).toEqual([
      'session_turn:codex:predecessor:90',
      'session_turn:codex:successor:0',
      'session_turn:codex:successor:1',
      'session_turn:codex:successor:2',
    ]);
    expect(result.turns.map((turn) => turn.owner)).toEqual([
      'su-read-pg-predecessor', OWNER, OWNER, OWNER,
    ]);
    expect(refreshTargetSessionBeforeRead).not.toHaveBeenCalled();
    const head = await read({ session: 'self', order: 'asc', limit: 1 });
    expect(head.turns.map((turn) => turn.text)).toEqual(['legacy corpus row']);
    expect(head.session_id).toBe('legacy');
  });

  it('follows emitted continuations to recover the exact full text once, then ends', async () => {
    const ref = 'session_turn:codex:successor:2';
    let result = await read({ ref });
    const chunks: string[] = [];
    for (let offset = 0; offset < LONG_TEXT.length; offset += 1_500) {
      expect(result.turn_count).toBe(1);
      const turn = result.turns[0];
      expect(turn.ref).toBe(ref);
      expect(turn.text).toBe(LONG_TEXT.slice(offset, offset + 1_500));
      expect(turn.text_offset ?? 0).toBe(offset);
      chunks.push(turn.text);
      if (offset + 1_500 < LONG_TEXT.length) {
        expect(turn.text_truncated).toBe(true);
        expect(turn.text_full_chars).toBe(LONG_TEXT.length);
        expect(turn.readMore).toEqual({
          tool: 'sessions:read',
          args: { ref, text_offset: offset + 1_500, text_limit: 1_500 },
        });
        result = await read(turn.readMore!.args);
      } else {
        expect(turn.text_truncated).toBeUndefined();
        expect(turn.readMore).toBeUndefined();
      }
    }
    expect(chunks.join('')).toBe(LONG_TEXT);
    const max = await read({ ref, text_offset: 17, text_limit: 4_000 });
    expect(max.turns[0].text).toBe(LONG_TEXT.slice(17, 4_017));
    const end = await read({ ref, text_offset: LONG_TEXT.length, text_limit: 1 });
    expect(end.turns[0].text).toBe('');
    expect(end.turns[0].readMore).toBeUndefined();
  });

  it('rejects conflicting navigation and oversized chunks before any read seam', async () => {
    for (const args of [
      { session: 'successor', tail: 2, limit: 2 },
      { session: 'successor', text_limit: 4_001 },
      { session: 'self', text_offset: -1 },
    ]) {
      const result = await dispatch(args);
      expect(result.ok, JSON.stringify(result)).toBe(false);
    }
    expect(refreshTargetSessionBeforeRead).not.toHaveBeenCalled();
    expect(resolveSearchFilters).not.toHaveBeenCalled();
    expect(readArchivedSessionTurns).not.toHaveBeenCalled();
  });
});
