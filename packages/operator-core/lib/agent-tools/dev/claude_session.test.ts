/**
 * claude_session.test.ts — keeps the indexed-session fallback wired into the
 * dev:claude_session read path. Raw JSONL transcripts are disposable, while
 * session_turns remains available to sessions:read; a missing raw metadata row
 * must therefore not become a false "no session found".
 *
 * Also pins D-006 (plan personal-data-reader-set-labels-2026-10-01, WI-10005570):
 * a turn another agent recorded inside its disclosure window is withheld from
 * this raw-transcript reader too, and op=search drops a restricted session
 * BEFORE grepping it, so neither its hits nor the withheld count depend on the query.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-sessions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../claude-sessions')>();
  return {
    listClaudeSessions: vi.fn(),
    searchClaudeSessions: vi.fn(),
    readClaudeSession: vi.fn(),
    allClaudeSessionMetas: vi.fn(),
    readTranscriptFirstTs: vi.fn(async () => null),
    transcriptOwnerFromPath: (filePath: string) => real.transcriptOwnerFromPath(filePath, '/iso'),
  };
});
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller' })) }));
// The handler only destructures `sql` from getOrgPg(), so the factory hands back just that
// member from a hoisted holder instead of casting a partial OrgPgHandle at the call site.
const orgPg = vi.hoisted((): { sql: unknown } => ({ sql: null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: orgPg.sql })),
}));

import { allClaudeSessionMetas, searchClaudeSessions, type ClaudeSessionMeta } from '../../claude-sessions';

const allMetasMock = vi.mocked(allClaudeSessionMetas);
const searchMock = vi.mocked(searchClaudeSessions);
const tool = (await import('./claude_session')).default;

type Out = { content: Array<{ text: string }>; isError?: boolean };
const body = (out: Out) => JSON.parse(out.content[0]!.text) as Record<string, any>;
const ctx = {
  workspaceId: 'workspace-1',
  get tx(): never { throw new Error('the filesystem read must not retain or use an ambient tx'); },
} as never;

/** A positional fake: the Nth awaited query gets the Nth result. */
function sqlReturning(...results: unknown[][]) {
  let i = 0;
  return vi.fn(async () => results[i++] ?? []);
}

const indexedRows = [
  { turn_idx: 1, speaker: 'assistant', ts: '2026-08-24T10:01:00.000Z', owner: 'su-other', stamp_at: '2026-08-24T10:01:00.000Z', text: 'second turn' },
  { turn_idx: 0, speaker: 'user', ts: '2026-08-24T10:00:00.000Z', owner: 'su-other', stamp_at: '2026-08-24T10:00:00.000Z', text: 'first turn' },
];

describe('dev:claude_session — indexed fallback', () => {
  it('opts out of the ambient workspace transaction used to dispatch filesystem scans', () => {
    expect((tool as { needsWorkspaceTx?: boolean }).needsWorkspaceTx).not.toBe(true);
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('reads an indexed Claude session when no raw JSONL metadata exists', async () => {
    const sessionId = 'indexed-claude-session-123';
    allMetasMock.mockResolvedValue([]);
    const sql = sqlReturning(indexedRows, []);
    orgPg.sql = sql;

    const out = (await tool.handler({ op: 'read', sessionId }, ctx)) as Out;
    const result = body(out);

    expect(out.isError).toBeUndefined();
    expect(result).toMatchObject({
      sessionId,
      cwd: null,
      gitBranch: null,
      firstTs: '2026-08-24T10:00:00.000Z',
      lastTs: '2026-08-24T10:01:00.000Z',
      totalRecords: 2,
      truncated: false,
      turns: [
        { i: 0, type: 'user', role: 'user', text: 'first turn' },
        { i: 1, type: 'assistant', role: 'assistant', text: 'second turn' },
      ],
    });
    expect(result.withheld).toBeUndefined();
    // The turn read, then the recorder's disclosure windows.
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[0]!.slice(1)).toEqual(['workspace-1', sessionId, 201]);
  });
});

describe('dev:claude_session — D-006 transcript exclusion', () => {
  it('withholds an indexed turn recorded inside another agent’s disclosure window, and counts it', async () => {
    allMetasMock.mockResolvedValue([]);
    // su-other held personal data from 10:00:30 onward: its 10:01 turn is withheld.
    orgPg.sql = sqlReturning(indexedRows, [
      { owner: 'su-other', from: new Date('2026-08-24T10:00:30.000Z'), to: null },
    ]);

    const result = body((await tool.handler({ op: 'read', sessionId: 'restricted-session' }, ctx)) as Out);

    expect(result.turns.map((t: { text: string }) => t.text)).toEqual(['first turn']);
    expect(result.withheld).toMatchObject({ restricted_turns: 1 });
  });

  it('op=search drops a restricted session before its content is grepped and counts it whatever the query', async () => {
    const meta = (sessionId: string, owner: string): ClaudeSessionMeta => ({
      sessionId,
      filePath: `/iso/${owner}/projects/-home-x/${sessionId}.jsonl`,
      cwd: '/home/x',
      lastActivityMs: Date.parse('2026-08-24T12:00:00.000Z'),
      sizeBytes: 10,
    });
    const candidates = [meta('open-session', 'su-plain'), meta('sealed-session', 'su-holder'), meta('own-session', 'su-caller')];
    let admittedIds: string[] = [];
    searchMock.mockImplementation(async (opts) => {
      const admitted = await opts.admit!(candidates);
      admittedIds = admitted.map((m) => m.sessionId);
      return { matches: [], filesScanned: admitted.length, filesTotal: candidates.length, truncated: false, filesByteCapped: [] };
    });
    const ledger = () => sqlReturning(
      [], // no indexed owners beyond the isolation paths
      [
        { owner: 'su-holder', from: new Date('2026-08-24T09:00:00.000Z'), to: new Date('2026-08-24T11:00:00.000Z') },
        { owner: 'su-caller', from: new Date('2026-08-24T09:00:00.000Z'), to: null },
      ],
    );

    orgPg.sql = ledger();
    const first = body((await tool.handler({ op: 'search', query: 'anything' }, ctx)) as Out);
    expect(admittedIds).toEqual(['open-session', 'own-session']);
    expect(first.withheld).toMatchObject({ restricted_turns: 1, restricted_sessions: 1 });

    orgPg.sql = ledger();
    const second = body((await tool.handler({ op: 'search', query: 'a different guess' }, ctx)) as Out);
    expect(second.withheld).toEqual(first.withheld);
  });

  it('refuses rather than serving unfiltered turns when the disclosure ledger is unreadable', async () => {
    allMetasMock.mockResolvedValue([]);
    let i = 0;
    orgPg.sql = vi.fn(async () => {
      if (i++ === 0) return indexedRows;
      throw new Error('relation "personal_disclosures" does not exist');
    });

    const out = (await tool.handler({ op: 'read', sessionId: 'any-session' }, ctx)) as Out;

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('disclosure_ledger_unavailable');
    expect(out.content[0]!.text).not.toContain('second turn');
  });
});
