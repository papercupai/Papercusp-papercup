/**
 * plans:revision-transcript — the routing + envelope contract behind the
 * "conversation behind a revision" verb (plan-agent-launch-2026-05-21 P-008 /
 * D-002). The three IO helpers are mocked (their own suites cover them); this
 * pins the handler's job: route by the revision's `session_kind`, emit the
 * right `available`/`reason`, forward query/cursor/limit into the plan-run or
 * ordinary agent-session reader, and fail safe.
 *
 *   - missing revision        → isError not_found (revisionId echoed)
 *   - git_backfill            → available:false reason git_backfill
 *   - operator_chat/agent_chat→ available:false reason session_kind_unsupported
 *   - null kind / no sessionId→ available:false reason no_session
 *   - plan_run + sessionId    → available:true, forwards opts, surfaces page
 *   - claude/omp/codex        → available:true through session index/archive
 *   - thrown helper           → isError transcript_unavailable (msg ≤400 chars)
 *   - ctx.metadata            → available:false on unavailable, +turnCount on ok
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import transcriptTool from './revision-transcript';
import { resolvePlanScope } from './source';
import { getPlanRevisionById, type PlanRevisionRef } from './revisions';
import { readPlanRunTranscript, type PlanRunTranscriptPage } from './runs';
import { readAgentSessionTranscript } from './revision-session-transcript';

vi.mock('./source');
vi.mock('./revisions');
vi.mock('./runs');
vi.mock('./revision-session-transcript', async (orig) => {
  const actual = await orig<typeof import('./revision-session-transcript')>();
  return { ...actual, readAgentSessionTranscript: vi.fn() };
});

const mockScope = vi.mocked(resolvePlanScope);
const mockGetRevision = vi.mocked(getPlanRevisionById);
const mockReadTranscript = vi.mocked(readPlanRunTranscript);
const mockReadAgentTranscript = vi.mocked(readAgentSessionTranscript);

/** Build a revision ref, defaulting the unspecified fields. */
function revision(over: Partial<PlanRevisionRef> = {}): PlanRevisionRef {
  return {
    id: 42,
    planSlug: 'my-plan',
    seq: 3,
    rationale: null,
    sessionId: null,
    sessionKind: null,
    createdAt: 1_700_000_000,
    ...over,
  };
}

/** Invoke the tool handler with a `harness: 'all'` arg so the harness gate
 *  resolves without depending on ctx; returns the parsed envelope. */
async function callTool(
  args: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const res = await (
    transcriptTool as unknown as {
      handler: (
        a: unknown,
        c: unknown,
      ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    }
  ).handler({ harness: 'all', ...args }, ctx);
  return { isError: res.isError, body: JSON.parse(res.content[0].text) };
}

const emptyPage: PlanRunTranscriptPage = { turns: [], nextCursor: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockScope.mockResolvedValue({ workspaceId: 'ws-1', harnessSlug: 'papercup' });
  mockReadTranscript.mockResolvedValue(emptyPage);
  mockReadAgentTranscript.mockResolvedValue(emptyPage);
});

describe('plans:revision-transcript — missing revision', () => {
  it('returns isError not_found with the revisionId echoed back', async () => {
    mockGetRevision.mockResolvedValue(null);
    const { isError, body } = await callTool({ revisionId: 7 });
    expect(isError).toBe(true);
    expect(body).toEqual({ error: 'not_found', revisionId: 7 });
    // never reaches the transcript store on a missing revision
    expect(mockReadTranscript).not.toHaveBeenCalled();
  });
});

describe('plans:revision-transcript — unavailable routing (available:false)', () => {
  it('git_backfill → reason git_backfill, empty turns, nextCursor null', async () => {
    mockGetRevision.mockResolvedValue(revision({ id: 11, sessionKind: 'git_backfill' }));
    const { isError, body } = await callTool({ revisionId: 11 });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({
      revisionId: 11,
      available: false,
      reason: 'git_backfill',
      turns: [],
      nextCursor: null,
    });
    expect(mockReadTranscript).not.toHaveBeenCalled();
  });

  it.each(['operator_chat', 'agent_chat'] as const)(
    'sessionKind %s → reason session_kind_unsupported',
    async (kind) => {
      // even WITH a sessionId, these kinds have no retrievable writer yet
      mockGetRevision.mockResolvedValue(revision({ sessionKind: kind, sessionId: 'sess-x' }));
      const { isError, body } = await callTool({ revisionId: 42 });
      expect(isError).toBeFalsy();
      expect(body).toMatchObject({
        available: false,
        reason: 'session_kind_unsupported',
        turns: [],
        nextCursor: null,
      });
      expect(mockReadTranscript).not.toHaveBeenCalled();
    },
  );

  it('null sessionKind (direct editor save) → reason no_session', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: null, sessionId: null }));
    const { body } = await callTool({ revisionId: 42 });
    expect(body).toMatchObject({ available: false, reason: 'no_session' });
    expect(mockReadTranscript).not.toHaveBeenCalled();
  });

  it('plan_run kind but no sessionId → reason no_session', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: null }));
    const { body } = await callTool({ revisionId: 42 });
    expect(body).toMatchObject({ available: false, reason: 'no_session' });
    expect(mockReadTranscript).not.toHaveBeenCalled();
  });

  it('echoes the base fields (revisionId, planSlug, seq, sessionKind) on the unavailable branch', async () => {
    mockGetRevision.mockResolvedValue(
      revision({ id: 99, planSlug: 'p-x', seq: 5, sessionKind: 'git_backfill' }),
    );
    const { body } = await callTool({ revisionId: 99 });
    expect(body).toMatchObject({
      revisionId: 99,
      planSlug: 'p-x',
      seq: 5,
      sessionKind: 'git_backfill',
    });
  });
});

describe('plans:revision-transcript — plan_run branch (available:true)', () => {
  const page: PlanRunTranscriptPage = {
    turns: [
      { seq: 1, role: 'user', content: 'why F-2?' } as PlanRunTranscriptPage['turns'][number],
      { seq: 2, role: 'assistant', content: 'because…' } as PlanRunTranscriptPage['turns'][number],
    ],
    nextCursor: 2,
  };

  it('available:true, surfacing the page turns + nextCursor', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: 'sess-1' }));
    mockReadTranscript.mockResolvedValue(page);
    const { isError, body } = await callTool({ revisionId: 42 });
    expect(isError).toBeFalsy();
    expect(body).toMatchObject({
      available: true,
      turns: page.turns,
      nextCursor: 2,
      query: null,
    });
  });

  it('forwards query/cursor/limit into readPlanRunTranscript against the revision sessionId', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: 'sess-7' }));
    mockReadTranscript.mockResolvedValue(page);
    const { body } = await callTool({
      revisionId: 42,
      query: 'F-2',
      cursor: 5,
      limit: 10,
    });
    expect(mockReadTranscript).toHaveBeenCalledWith('sess-7', {
      query: 'F-2',
      cursor: 5,
      limit: 10,
    });
    // query is echoed back into the envelope
    expect(body).toMatchObject({ query: 'F-2', available: true });
  });

  it('passes undefined opts through when query/cursor/limit are omitted', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: 'sess-9' }));
    const { body } = await callTool({ revisionId: 42 });
    expect(mockReadTranscript).toHaveBeenCalledWith('sess-9', {
      query: undefined,
      cursor: undefined,
      limit: undefined,
    });
    expect(body).toMatchObject({ available: true, query: null, turns: [], nextCursor: null });
  });
});

describe('plans:revision-transcript — ordinary agent-session branches', () => {
  it.each(['claude', 'omp', 'codex'] as const)(
    'routes %s revisions through the indexed session/archive reader',
    async (sourceKind) => {
      const page: PlanRunTranscriptPage = {
        turns: [{ seq: 0, role: 'user', content: 'source requirement', createdAt: 100 }],
        nextCursor: null,
      };
      mockGetRevision.mockResolvedValue(revision({
        sessionKind: sourceKind,
        sessionId: `${sourceKind}-session`,
      }));
      mockReadAgentTranscript.mockResolvedValue(page);

      const { isError, body } = await callTool({ revisionId: 42, query: 'requirement', cursor: 3, limit: 9 });

      expect(isError).toBeFalsy();
      expect(mockReadAgentTranscript).toHaveBeenCalledWith(
        'ws-1',
        sourceKind,
        `${sourceKind}-session`,
        { query: 'requirement', cursor: 3, limit: 9 },
        // D-006: the caller's identities (none resolvable in this fixture: fail closed).
        [null],
      );
      expect(body).toMatchObject({
        available: true,
        sessionKind: sourceKind,
        sessionId: `${sourceKind}-session`,
        turns: page.turns,
      });
      expect(mockReadTranscript).not.toHaveBeenCalled();
    },
  );
});

describe('plans:revision-transcript — error handling', () => {
  it('catches a thrown helper and returns isError transcript_unavailable', async () => {
    mockGetRevision.mockRejectedValue(new Error('db down'));
    const { isError, body } = await callTool({ revisionId: 13 });
    expect(isError).toBe(true);
    expect(body).toMatchObject({
      error: 'transcript_unavailable',
      message: 'db down',
      revisionId: 13,
    });
  });

  it('truncates a long thrown message to 400 chars', async () => {
    const long = 'x'.repeat(1000);
    mockReadTranscript.mockRejectedValue(new Error(long));
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: 'sess-1' }));
    const { isError, body } = await callTool({ revisionId: 42 });
    expect(isError).toBe(true);
    expect(body.error).toBe('transcript_unavailable');
    expect((body.message as string).length).toBe(400);
    expect(body.message).toBe('x'.repeat(400));
  });

  it('stringifies a non-Error throw', async () => {
    mockScope.mockRejectedValue('boom-string');
    const { isError, body } = await callTool({ revisionId: 1 });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'transcript_unavailable', message: 'boom-string' });
  });
});

describe('plans:revision-transcript — ctx.metadata side-channel', () => {
  it('reports available:false (no turnCount) on an unavailable branch', async () => {
    const metadata = vi.fn();
    mockGetRevision.mockResolvedValue(revision({ id: 21, sessionKind: 'git_backfill' }));
    await callTool({ revisionId: 21 }, { metadata });
    expect(metadata).toHaveBeenCalledWith({ revisionId: 21, available: false });
  });

  it('reports available:true plus turnCount on the success branch', async () => {
    const metadata = vi.fn();
    mockGetRevision.mockResolvedValue(revision({ id: 30, sessionKind: 'plan_run', sessionId: 's' }));
    mockReadTranscript.mockResolvedValue({
      turns: [
        { seq: 1 } as PlanRunTranscriptPage['turns'][number],
        { seq: 2 } as PlanRunTranscriptPage['turns'][number],
      ],
      nextCursor: null,
    });
    await callTool({ revisionId: 30 }, { metadata });
    expect(metadata).toHaveBeenCalledWith({ revisionId: 30, available: true, turnCount: 2 });
  });

  it('does not throw when ctx has no metadata fn (optional side-channel)', async () => {
    mockGetRevision.mockResolvedValue(revision({ sessionKind: 'plan_run', sessionId: 's' }));
    const { body } = await callTool({ revisionId: 42 }, {});
    expect(body).toMatchObject({ available: true });
  });
});
