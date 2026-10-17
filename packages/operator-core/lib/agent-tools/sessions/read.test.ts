/**
 * read.test.ts — EI-20236684982538421 regression.
 *
 * A 33-turn `sessions:read` window can exceed the MCP result-door text budget.
 * The handler historically returned only a hand-serialized JSON text block, so
 * the door cut it in the middle of a document and ptool could not parse it.
 * The typed object result below makes the same dispatch expose structuredContent
 * for programmatic callers while ordinary model-facing text remains doored.
 */
import { describe, expect, it, vi } from 'vitest';
import { deferredSqlAnswer, isDisclosureLedgerSql } from '../../../test/_fake-sql';

const refreshTargetSessionBeforeRead = vi.hoisted(() => vi.fn(async () => ({ attempted: 1, refreshed: 1 })));
const resolveSearchFilters = vi.hoisted(() => vi.fn());
const readArchivedSessionTurns = vi.hoisted(() => vi.fn(async () => null as null | {
  sourceKind: string;
  owner: string | null;
  turns: Array<{
    source_kind: string;
    turn_idx: number;
    speaker: string;
    owner: string | null;
    ts: string | null;
    text: string;
  }>;
  errors: Array<{ path: string; error: string }>;
}));
const readLiveSessionTurns = vi.hoisted(() => vi.fn(async () => null as null | {
  sourceKind: string;
  owner: string | null;
  turns: Array<{
    source_kind: string;
    turn_idx: number;
    speaker: string;
    owner: string | null;
    ts: string | null;
    text: string;
  }>;
  errors: Array<{ path: string; error: string }>;
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshTargetSessionBeforeRead,
}));

vi.mock('../search/filters', () => ({
  resolveSearchFilters: (...args: unknown[]) => resolveSearchFilters(...args),
}));

// Archive fall-through is exercised by the empty-index test below. Keep this
// unit suite database-free: the production default store opens PG, while the
// archive reader's behavior is covered by its own injected-store tests.
vi.mock('../../session-archive-read', () => ({
  readArchivedSessionTurns,
  readLiveSessionTurns,
}));

const readModule = await import('./read');
type ReadArgsParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { issues: unknown[] } };
const readArgsSchema = readModule.default.args as {
  safeParse: (value: unknown) => ReadArgsParseResult;
  shape: { text_limit: { description?: string } };
};
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('sessions:read')!;

describe('sessions:read role access', () => {
  it('admits the evidence-only judge to predecessor transcript reads', () => {
    expect(readModule.default.agentRoles).toContain('judge');
    expect(readModule.default.capability).toBe('sessions:read');
    expect(readModule.default.description).toContain(
      'evidence-only judges may read only self.',
    );
  });

  it.each([
    { session: 'another-session' },
    { ref: 'session_turn:codex:another-session:0' },
  ])('refuses judge transcript selector $session $ref', async (selector) => {
    const handler = readModule.default.handler as unknown as (
      args: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

    const result = await handler(selector, { role: 'judge' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false,
      error: 'judge_session_scope_only',
    });
  });
});

/** Every awaited transcript query answers `rows`; the D-006 ledger reads answer "no disclosures". */
function makeTx(rows: unknown[]) {
  return vi.fn((...args: unknown[]) => deferredSqlAnswer(args, () => rows));
}

describe('sessions:read EI-20236684982538421 — structured large-window response', () => {
  it.each([
    { session: 'sess-selector', source_kind: 'codex' },
    { session: 'codex:sess-selector' },
    { ref: 'session_turn:codex:sess-selector:2' },
  ])('queries the normalized indexed id for $session $ref', async (selector) => {
    // Unlike a rows-only stub, enforce the indexed session predicate. Otherwise
    // a correct response label can conceal a prefixed id sent to PostgreSQL.
    const tx = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const idIndex = parts.findIndex((part) => /\bsession_id =\s*$/.test(part));
      expect(idIndex).toBeGreaterThanOrEqual(0);
      expect(values[idIndex]).toBe('sess-selector');
      return [{
        source_kind: 'codex', session_id: 'sess-selector', turn_idx: 2,
        speaker: 'assistant', owner: 'su-self', ts: null, text: 'indexed evidence',
      }];
    });
    const dispatched = await dispatchProjectedTool(
      projected, 'sessions:read', selector,
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-normalized-selector', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      }, {},
    );
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(dispatched.result?.structuredContent).toMatchObject({
      session_id: 'sess-selector', turn_count: 1,
      turns: [{ ref: 'session_turn:codex:sess-selector:2', text: 'indexed evidence' }],
    });
  });

  it('keeps the tail exclusivity rule in the compact discovery prefix', () => {
    expect(projected.description.slice(0, 320)).toContain(
      "`tail:N` means `order:'desc', limit:N`; do not combine it with either.",
    );
  });

  it('documents Judge self scope and the multi-session self-window contract', () => {
    expect(projected.description).toContain("`session:'self'` spans your respawn chain");
    expect(projected.description).toContain('evidence-only judges may read only self.');
    expect(projected.description).toContain('A multi-session self window has `session_id` null');
    // toContain rejects an undefined receiver, so a missing guidance block still fails.
    expect(readModule.default.guidance?.returns).toContain('session_ids? (sessions represented in a self window)');
    expect(readModule.default.guidance?.returns).toContain('each turn ref identifies its source session');
  });

  it('advertises an object result and preserves all rows in structuredContent', async () => {
    const rows = Array.from({ length: 33 }, (_, turn_idx) => ({
      source_kind: 'codex',
      turn_idx,
      speaker: 'assistant',
      owner: 'su-self',
      ts: '2026-08-12T09:00:00.000Z',
      text: `turn-${turn_idx}`,
    }));

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'sess-known', around: 16, context: 16 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(rows),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      session_id: 'sess-known',
      turn_count: 33,
    });
    const structured = dispatched.result?.structuredContent as { turns: unknown[] };
    expect(structured.turns).toHaveLength(33);
    expect(structured.turns[16]).toMatchObject({
      ref: 'session_turn:codex:sess-known:16',
      turn_idx: 16,
    });
  });

  it('marks clipped turn text and provides a runnable continuation for the next chunk', async () => {
    const fullText = 'prefix '.repeat(520);
    const ref = 'session_turn:codex:sess-long:9';
    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-clipping-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex',
          session_id: 'sess-long',
          turn_idx: 9,
          speaker: 'assistant',
          owner: 'su-self',
          ts: null,
          text: fullText,
        }]),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const turn = (dispatched.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0];
    expect(turn.text).toBe(fullText.slice(0, 1_500));
    expect(turn.text_truncated).toBe(true);
    expect(turn.text_full_chars).toBe(fullText.length);
    expect(turn.readMore).toEqual({
      tool: 'sessions:read',
      args: { ref, text_offset: 1_500, text_limit: 1_500 },
    });
  });

  it('reads the continuation chunk at the supplied character offset', async () => {
    const fullText = 'x'.repeat(1_800);
    const ref = 'session_turn:codex:sess-long:9';
    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref, text_offset: 1_500 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-continuation-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex',
          session_id: 'sess-long',
          turn_idx: 9,
          speaker: 'assistant',
          owner: 'su-self',
          ts: null,
          text: fullText,
        }]),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const turn = (dispatched.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0];
    expect(turn.text).toBe(fullText.slice(1_500));
    expect(turn.text_offset).toBe(1_500);
    expect(turn.text_truncated).toBeUndefined();
    expect(turn.readMore).toBeUndefined();
  });

  it('recovers an index-capped turn from the redacted archive and paginates the full source', async () => {
    const ref = 'session_turn:codex:sess-capped:9';
    const fullText = 'p'.repeat(9_572);
    readArchivedSessionTurns.mockReset();
    readArchivedSessionTurns.mockResolvedValue({
      sourceKind: 'codex',
      owner: 'su-peer',
      turns: [{
        source_kind: 'codex', turn_idx: 9, speaker: 'assistant', owner: 'su-peer',
        ts: null, text: fullText,
      }],
      errors: [],
    });
    const dispatch = (offset: number) => dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref, text_offset: offset, text_limit: 4_000 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: `read-full-source-${offset}`, role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex', session_id: 'sess-capped', turn_idx: 9,
          speaker: 'assistant', owner: 'su-peer', ts: null,
          text: offset < 8_000 ? fullText.slice(offset, Math.min(offset + 4_000, 8_000)) : '',
          text_full_chars: 8_000, text_offset: offset,
        }]),
      },
      {},
    );

    const middle = await dispatch(4_000);
    expect(middle.ok, JSON.stringify(middle)).toBe(true);
    const middleTurn = (middle.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0]!;
    expect(middleTurn).toMatchObject({
      text: fullText.slice(4_000, 8_000),
      text_offset: 4_000,
      text_truncated: true,
      text_full_chars: 8_000,
      source_completeness: 'unknown',
      readMore: { tool: 'sessions:read', args: { ref, text_offset: 8_000, text_limit: 4_000 } },
    });
    expect(readArchivedSessionTurns).not.toHaveBeenCalled();

    const tail = await dispatch(8_000);
    expect(tail.ok, JSON.stringify(tail)).toBe(true);
    const tailTurn = (tail.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0]!;
    expect(tailTurn).toMatchObject({
      text: fullText.slice(8_000),
      text_offset: 8_000,
      source_completeness: 'complete',
    });
    expect(tailTurn.text_truncated).toBeUndefined();
    expect(tailTurn.readMore).toBeUndefined();
    expect(readArchivedSessionTurns).toHaveBeenCalledWith(
      'sess-capped', 'codex', undefined, { fullSource: true, turnIndices: [9] },
    );
  });

  it('reports unknown source completeness when a cap-length index row has no archive', async () => {
    const ref = 'session_turn:codex:sess-no-archive:3';
    readArchivedSessionTurns.mockReset();
    readArchivedSessionTurns.mockResolvedValue(null);
    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-source-unknown-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex', session_id: 'sess-no-archive', turn_idx: 3,
          speaker: 'assistant', owner: 'su-peer', ts: null,
          text: 'x'.repeat(1_500), text_full_chars: 8_000, text_offset: 0,
        }]),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const turn = (dispatched.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0]!;
    expect(turn).toMatchObject({
      text_full_chars: 8_000,
      text_truncated: true,
      source_completeness: 'unknown',
      readMore: { tool: 'sessions:read', args: { ref, text_offset: 1_500, text_limit: 1_500 } },
    });
    expect(readArchivedSessionTurns).not.toHaveBeenCalled();
  });

  it("recovers a capped live self turn from the current source before archive fallback", async () => {
    resolveSearchFilters.mockResolvedValue({
      filters: { owners: ['su-self'] },
      selfSession: {
        sourceKind: 'codex',
        sessionId: 'sess-live-self',
        filePath: '/managed/sess-live-self.jsonl',
      },
    });
    const emissionContract = 'gradingEmissionContract: emit=true';
    const prefix = 'live-source '.repeat(600);
    const fullText = `${prefix}${'x'.repeat(8_000 - prefix.length)}${emissionContract}${' tail'.repeat(1_000)}`;
    readLiveSessionTurns.mockReset();
    readLiveSessionTurns.mockResolvedValue({
      sourceKind: 'codex',
      owner: 'su-self',
      turns: [{
        source_kind: 'codex',
        turn_idx: 3,
        speaker: 'assistant',
        owner: 'su-self',
        ts: null,
        text: fullText,
      }],
      errors: [],
    });
    readArchivedSessionTurns.mockReset();
    readArchivedSessionTurns.mockResolvedValue(null);
    const dispatch = (textOffset: number) => dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', from_idx: 3, to_idx: 3, text_offset: textOffset, text_limit: 4_000 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: `read-live-self-capped-test-${textOffset}`, role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex', session_id: 'sess-live-self', turn_idx: 3,
          speaker: 'assistant', owner: 'su-self', ts: null,
          text: textOffset < 8_000 ? fullText.slice(textOffset, Math.min(textOffset + 4_000, 8_000)) : '',
          text_full_chars: 8_000, text_offset: textOffset,
        }]),
      },
      {},
    );
    const dispatched = await dispatch(4_000);

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      turn_count: 1,
      turns: [{
        text: fullText.slice(4_000, 8_000),
        text_full_chars: 8_000,
        source_completeness: 'unknown',
        text_truncated: true,
        text_offset: 4_000,
        readMore: { args: { text_offset: 8_000, text_limit: 4_000 } },
      }],
    });
    expect(readLiveSessionTurns).not.toHaveBeenCalled();
    const tail = await dispatch(8_000);
    expect(readLiveSessionTurns).toHaveBeenCalledWith(
      '/managed/sess-live-self.jsonl',
      'codex',
      'su-self',
      { fullSource: true, turnIndices: [3] },
    );
    const tailTurn = (tail.result?.structuredContent as { turns: Array<Record<string, unknown>> }).turns[0]!;
    expect(tailTurn).toMatchObject({
      text: expect.stringContaining(emissionContract),
      text_full_chars: fullText.length,
      text_offset: 8_000,
      text_truncated: true,
      source_completeness: 'complete',
      readMore: { args: { text_offset: 12_000, text_limit: 4_000 } },
    });
    expect(readArchivedSessionTurns).not.toHaveBeenCalled();
  });

  it('casts text-window bounds before PostgreSQL resolves substring overloads', async () => {
    const calls: unknown[][] = [];
    const tx = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return [];
    });

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'sess-known', tail: 1 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-substring-casts-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const query = String((calls[0]?.[0] as string[] | undefined)?.join(' ? '));
    expect(query).toMatch(/substring\(text FROM\s+\?\s+::int FOR\s+\?\s+::int\)/);
  });

  it('accepts a canonical ref with optional window controls and reads the exact turn', async () => {
    refreshTargetSessionBeforeRead.mockClear();
    const tx = makeTx([{
      source_kind: 'codex',
      turn_idx: 44,
      speaker: 'user',
      owner: 'su-peer',
      ts: '2026-08-24T01:02:03.000Z',
      text: 'the referenced requirement',
    }]);

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { ref: 'session_turn:codex:sess-with:colon:44', context: 0, limit: 1, order: 'desc' },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-ref-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(refreshTargetSessionBeforeRead).toHaveBeenCalledWith(tx, 'codex', 'sess-with:colon');
    expect(dispatched.result?.structuredContent).toMatchObject({
      session_id: 'sess-with:colon',
      turn_count: 1,
      turns: [{ ref: 'session_turn:codex:sess-with:colon:44', turn_idx: 44 }],
    });
  });

  it('accepts tail as a strict shorthand for a bounded descending read', async () => {
    const tx = makeTx([
      { source_kind: 'codex', turn_idx: 8, speaker: 'assistant', owner: null, ts: null, text: 'older' },
      { source_kind: 'codex', turn_idx: 9, speaker: 'assistant', owner: null, ts: null, text: 'newer' },
    ]);

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'sess-known', tail: 2 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-tail-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(tx.mock.calls[0]?.at(-1)).toBe(2);
    expect(dispatched.result?.structuredContent).toMatchObject({
      session_id: 'sess-known',
      turn_count: 2,
    });
  });

  it('rejects malformed or conflicting canonical-ref inputs while accepting window controls', () => {
    expect(readArgsSchema.safeParse({ ref: 'not-a-turn-ref' }).success).toBe(false);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', session: 'sess' }).success).toBe(false);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', around: 4 }).success).toBe(false);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', source_kind: 'codex' }).success).toBe(false);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', context: 3 }).success).toBe(true);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', context: 3, limit: 4, order: 'asc' }).success).toBe(true);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', context: 3, limit: 4, order: 'desc' }).success).toBe(true);
    expect(readArgsSchema.safeParse({ session: 'sess', tail: 30 }).success).toBe(true);
    expect(readArgsSchema.safeParse({ ref: 'session_turn:codex:sess:4', context: 3, tail: 4 }).success).toBe(true);
    expect(readArgsSchema.safeParse({ session: 'sess', tail: 30, limit: 30 }).success).toBe(false);
    expect(readArgsSchema.safeParse({ session: 'sess', tail: 30, order: 'desc' }).success).toBe(false);
  });

  it('advertises the enforced per-turn text chunk maximum', () => {
    expect(readArgsSchema.safeParse({ session: 'sess', text_limit: 4_000 }).success).toBe(true);
    expect(readArgsSchema.safeParse({ session: 'sess', text_limit: 4_001 }).success).toBe(false);
    expect(readArgsSchema.shape.text_limit.description).toContain('Maximum 4000');
  });

  it('rejects stale search-only mode/query arguments instead of silently accepting them', () => {
    const parsed = readArgsSchema.safeParse({
      session: 'sess-known',
      mode: 'verbatim',
      query: 'a phrase from the transcript',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unrecognized_keys', keys: expect.arrayContaining(['mode', 'query']) }),
      ]));
    }
  });

  it('refreshes a named target before querying its indexed turns', async () => {
    refreshTargetSessionBeforeRead.mockClear();
    const tx = makeTx([{
      source_kind: 'codex',
      turn_idx: 7,
      speaker: 'assistant',
      owner: 'su-peer',
      ts: null,
      text: 'fresh target turn',
    }]);

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'sess-live', source_kind: 'codex' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-target-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(refreshTargetSessionBeforeRead).toHaveBeenCalledWith(tx, 'codex', 'sess-live');
    // One transcript query; the turn belongs to a peer, so the D-006 ledger is also read.
    expect(tx.mock.calls.filter((call) => !isDisclosureLedgerSql(call))).toHaveLength(1);
    expect(tx.mock.calls.filter((call) => isDisclosureLedgerSql(call))).toHaveLength(1);
  });

  it("lets the evidence-only judge read session:'self' across predecessor and successor sessions", async () => {
    resolveSearchFilters.mockResolvedValueOnce({
      filters: { owners: ['su-self', 'su-predecessor'] },
      selfSession: {
        sourceKind: 'codex',
        sessionId: 'sess-successor',
        filePath: '/managed/sess-successor.jsonl',
      },
    });
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = vi.fn(async (...args: unknown[]) => {
      const [strings, ...values] = args;
      calls.push({
        sql: Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings),
        values,
      });
      return [
        {
          source_kind: 'codex', session_id: 'sess-predecessor', turn_idx: 8,
          speaker: 'assistant', owner: 'su-predecessor', ts: null, text: 'before compaction',
        },
        {
          source_kind: 'codex', session_id: 'sess-successor', turn_idx: 0,
          speaker: 'user', owner: 'su-self', ts: null, text: 'after respawn',
        },
      ];
    });

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', limit: 2, order: 'asc' },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-self-chain-test', role: 'judge',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(resolveSearchFilters).toHaveBeenCalledWith(
      tx,
      { session: 'self' },
      'su-self',
      { workspaceId: 'default' },
    );
    expect(calls[0]?.sql).toContain('owner = ANY');
    expect(calls[0]?.values).toContainEqual(['su-self', 'su-predecessor']);
    expect(dispatched.result?.structuredContent).toMatchObject({
      session_id: null,
      session_ids: [
        { source_kind: 'codex', session_id: 'sess-predecessor' },
        { source_kind: 'codex', session_id: 'sess-successor' },
      ],
      turn_count: 2,
      turns: [
        { ref: 'session_turn:codex:sess-predecessor:8', text: 'before compaction' },
        { ref: 'session_turn:codex:sess-successor:0', text: 'after respawn' },
      ],
    });
  });

  it("keeps session:'self' owner-scoped when a sequential range follows a resolver miss", async () => {
    resolveSearchFilters.mockReset();
    resolveSearchFilters
      .mockResolvedValueOnce({
        filters: { owners: ['su-self'] },
        selfSession: {
          sourceKind: 'codex',
          sessionId: 'sess-current',
          filePath: '/managed/sess-current.jsonl',
        },
      })
      // The resolver deliberately returns a fail-soft null when the live
      // transcript cannot be pinned. The owner filter remains usable.
      .mockResolvedValueOnce({ filters: { owners: ['su-self'] }, selfSession: null });

    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = vi.fn(async (...args: unknown[]) => {
      const [strings, ...values] = args;
      calls.push({
        sql: Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings),
        values,
      });
      return calls.length === 1
        ? [{
            source_kind: 'codex', session_id: 'sess-current', turn_idx: 4,
            speaker: 'assistant', owner: 'su-self', ts: null, text: 'tail survives',
          }]
        : [{
            source_kind: 'codex', session_id: 'sess-predecessor', turn_idx: 2,
            speaker: 'user', owner: 'su-self', ts: null, text: 'range survives resolver miss',
          }];
    });

    const context = {
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
      workspaceId: 'default', role: 'operator',
      gateBypass: { role: true, capability: true, quota: true },
      transport: 'mcp' as const, requestedFormat: 'json' as const, requestedStructured: true,
      tx,
    };
    const tail = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', tail: 1 },
      { ...context, runId: 'read-self-sequential-tail' },
      {},
    );
    const range = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', from_idx: 2, to_idx: 2 },
      { ...context, runId: 'read-self-sequential-range' },
      {},
    );

    expect(tail.ok, JSON.stringify(tail)).toBe(true);
    expect(range.ok, JSON.stringify(range)).toBe(true);
    expect(range.result?.structuredContent).toMatchObject({
      ok: true,
      turn_count: 1,
      note: 'self transcript could not be pinned; used owner-scoped session history',
      turns: [{ ref: 'session_turn:codex:sess-predecessor:2', text: 'range survives resolver miss' }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain('owner = ANY');
    expect(calls[1]?.sql).toContain('owner = ANY');
    expect(calls[1]?.values).toContainEqual(['su-self']);
  });

  it("ignores malformed session ids in self provenance metadata without rejecting the read", async () => {
    resolveSearchFilters.mockResolvedValueOnce({
      filters: { owners: ['su-self'] },
      selfSession: {
        sourceKind: 'codex',
        sessionId: 'sess-successor',
        filePath: '/managed/sess-successor.jsonl',
      },
    });
    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', tail: 1 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-self-malformed-session-id-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
        tx: makeTx([{
          source_kind: 'codex',
          session_id: null,
          turn_idx: 0,
          speaker: 'assistant',
          owner: 'su-self',
          ts: null,
          text: 'turn survives malformed provenance',
        }]),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      session_id: 'sess-successor',
      session_ids: [],
      turn_count: 1,
      turns: [{
        ref: 'session_turn:codex:sess-successor:0',
        text: 'turn survives malformed provenance',
      }],
    });
  });

  it("uses event chronology rather than turn_idx for session:'self' tail windows", async () => {
    resolveSearchFilters.mockResolvedValueOnce({
      filters: { owners: ['su-self'] },
      selfSession: {
        sourceKind: 'codex',
        sessionId: 'sess-successor',
        filePath: '/managed/sess-successor.jsonl',
      },
    });
    const rows = [
      {
        source_kind: 'codex',
        session_id: 'sess-predecessor',
        turn_idx: 99,
        speaker: 'assistant',
        owner: 'su-self',
        ts: '2026-08-24T10:00:00.000Z',
        text: 'old predecessor turn with a high index',
      },
      {
        source_kind: 'codex',
        session_id: 'sess-successor',
        turn_idx: 0,
        speaker: 'user',
        owner: 'su-self',
        ts: '2026-08-24T12:00:00.000Z',
        text: 'new successor turn',
      },
      {
        source_kind: 'codex',
        session_id: 'sess-successor',
        turn_idx: 1,
        speaker: 'assistant',
        owner: 'su-self',
        ts: '2026-08-24T13:00:00.000Z',
        text: 'newest successor turn',
      },
    ];
    const tx = vi.fn(async (...args: unknown[]) => {
      const [strings, ...values] = args;
      const sql = Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings);
      const limit = Number(values.at(-1));
      // Model the database's two ORDER BY shapes so this test fails both on
      // the old turn_idx tail and if the self-chain chronology clause regresses.
      const ordered = sql.includes('COALESCE(ts, ingested_at)')
        ? [...rows].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        : [...rows].sort((a, b) => b.turn_idx - a.turn_idx);
      return ordered.slice(0, limit);
    });

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'self', tail: 2 },
      {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'read-self-tail-chronology-test', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx,
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const query = String((tx.mock.calls[0]?.[0] as string[] | undefined)?.join(' ? '));
    expect(query).toContain('COALESCE(ts, ingested_at)');
    expect(query).toContain('source_kind');
    expect(query).toContain('session_id');
    const structured = dispatched.result?.structuredContent as {
      turns: Array<{ text: string }>;
    };
    expect(structured.turns.map((turn) => turn.text)).toEqual([
      'new successor turn',
      'newest successor turn',
    ]);
  });
});
