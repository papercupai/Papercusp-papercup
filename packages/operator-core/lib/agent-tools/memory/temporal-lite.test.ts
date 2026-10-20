/**
 * temporal-lite.test.ts — the P-008 scenario fixture of
 * memory-temporal-lite-validity-windows-2026-07-11, at the TOOL layer: the
 * P-015 shape (a "default embedder is gemma" fact superseded by a "default
 * embedder is harrier" fact) exercised through memory:search/list read flags
 * (`as_of`, `include_superseded`), memory:update supersession
 * (`supersedes:<old-id>` → backend.invalidateEntry(old, { supersededBy: new })),
 * and memory:forget soft mode (invalidate instead of delete; the DEFAULT stays
 * hard-delete — the privacy-safe answer).
 *
 * The backend is a fake that implements the validity-window semantics the
 * real Mem0Backend + CanonicalVectorStore pair provides (windows live in
 * columns, surfaced as metadata.validity) — canonical-store.test.ts pins the
 * SQL those semantics compile to.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/temporal-lite.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// WI-39811: detached imports are now enrolled in trackDetached and DRAINED before the
// environment tears down, so this best-effort side effect — previously a floating
// `void import(...)` that never finished inside the test — now really runs and logs its
// diagnostic for a dependency this unit test never configures. Mock the collaborator
// rather than silencing console, so the diagnostic stays meaningful in production.
vi.mock('../../memory/feedback', () => ({
  recordFeedback: vi.fn(async () => {}),
  AGENT_TOOL_ACTOR_ID: 'a9e70000-0000-4000-8000-000000000001',
}));
// WI-39811: detached imports are now enrolled in trackDetached and DRAINED before the
// environment tears down, so this best-effort side effect — previously a floating
// `void import(...)` that never finished inside the test — now really runs and logs its
// diagnostic for a dependency this unit test never configures. Mock the collaborator
// rather than silencing console, so the diagnostic stays meaningful in production.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
// Spread the REAL module and override only defineTool: a hand-listed factory
// strands every export the tool graph later starts importing — AGENT_ROLES did
// exactly that (testing/run.ts), breaking collection across this directory.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
  };
});
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));
vi.mock('../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
  markJournalCommitted: vi.fn(async () => undefined),
  purgeJournalForMemory: vi.fn(async () => 0),
}));

import search from './search';
import list from './list';
import update from './update';
import forget from './forget';
import { getMemoryBackend, type MemoryEntry } from '../../memory/backend';

/** The P-015 scenario: the gemma-default fact was superseded 2026-07-10 by
 *  the harrier-default fact. Windows as the store holds them (columns). */
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const SUPERSEDED_AT = '2026-07-10T00:00:00.000Z';
const FIXTURE = [
  {
    id: OLD_ID,
    text: 'memory embed default is gemma',
    scope: 'user-1',
    score: 0.9,
    validAt: '2026-06-01T00:00:00.000Z',
    invalidAt: SUPERSEDED_AT,
    supersededBy: NEW_ID,
  },
  {
    id: NEW_ID,
    text: 'memory embed default is harrier',
    scope: 'user-1',
    score: 0.9,
    validAt: SUPERSEDED_AT,
    invalidAt: null as string | null,
    supersededBy: null as string | null,
  },
];

type Row = (typeof FIXTURE)[number];

/** The read semantics the real backend pair provides: default = current rows
 *  only; asOf = point-in-time window; includeSuperseded = everything. Rows
 *  touched by a control (or with a closed window) carry metadata.validity. */
function readFixture(opts: { asOf?: string; includeSuperseded?: boolean }): Array<{
  id: string;
  text: string;
  scope: string;
  score: number;
  metadata?: Record<string, unknown>;
}> {
  const refMs = opts.asOf !== undefined ? new Date(opts.asOf).getTime() : Date.now();
  const rows = FIXTURE.filter((r) => {
    if (opts.asOf !== undefined) {
      return new Date(r.validAt).getTime() <= refMs && (r.invalidAt === null || new Date(r.invalidAt).getTime() > refMs);
    }
    if (opts.includeSuperseded) return true;
    return r.invalidAt === null || new Date(r.invalidAt).getTime() > Date.now();
  });
  const fold = (r: Row) =>
    r.invalidAt === null && r.supersededBy === null && opts.asOf === undefined
      ? {}
      : {
          metadata: {
            validity: {
              valid_at: r.validAt,
              invalid_at: r.invalidAt,
              superseded_by: r.supersededBy,
              status: r.invalidAt !== null && new Date(r.invalidAt).getTime() <= refMs ? 'superseded' : 'current',
            },
          },
        };
  return rows.map((r) => ({ id: r.id, text: r.text, scope: r.scope, score: r.score, ...fold(r) }));
}

function fakeBackend(withInvalidateEntry = true) {
  return {
    name: 'fake-temporal',
    available: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async (_q: string, opts: { asOf?: string; includeSuperseded?: boolean }) => readFixture(opts)),
    list: vi.fn(async (opts: { asOf?: string; includeSuperseded?: boolean }) => readFixture(opts)),
    get: vi.fn(async (id: string): Promise<MemoryEntry | null> => {
      const row = FIXTURE.find((candidate) => candidate.id === id);
      if (!row) return null;
      return {
        id: row.id,
        text: row.text,
        scope: row.scope,
        metadata: {
          validity: {
            status: row.invalidAt === null ? 'current' : 'superseded',
            superseded_by: row.supersededBy,
          },
        },
      };
    }),
    remember: vi.fn(async () => ({ ids: [] })),
    update: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    ...(withInvalidateEntry ? { invalidateEntry: vi.fn(async () => true) } : {}),
  };
}

const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
// Handlers return either { data } or the MCP content envelope.
const parse = (res: unknown): any => {
  const r = res as { data?: unknown; content?: Array<{ text: string }> };
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('memory:search temporal flags (P-006 read path)', () => {
  it('DEFAULT recall returns only the CURRENT fact — the superseded one is gone', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await search.handler({ query: 'memory embed default' } as never, ctx));
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { id: string }) => r.id)).toEqual([NEW_ID]);
    // No temporal control was passed to the backend.
    const opts = b.search.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.asOf).toBeUndefined();
    expect(opts.includeSuperseded).toBeUndefined();
  });

  it('as_of 2026-06-15 answers "what did we believe then?" — the gemma fact, marked current-as-of', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await search.handler({ query: 'memory embed default', as_of: '2026-06-15T00:00:00Z' } as never, ctx),
    );
    expect(out.results.map((r: { id: string }) => r.id)).toEqual([OLD_ID]);
    expect(out.results[0].metadata.validity.status).toBe('current');
    expect((b.search.mock.calls[0][1] as { asOf?: string }).asOf).toBe('2026-06-15T00:00:00Z');
  });

  it('include_superseded returns BOTH, the old one marked superseded with its replacement id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await search.handler({ query: 'memory embed default', include_superseded: true } as never, ctx),
    );
    expect(out.results.map((r: { id: string }) => r.id).sort()).toEqual([OLD_ID, NEW_ID].sort());
    const oldHit = out.results.find((r: { id: string }) => r.id === OLD_ID);
    expect(oldHit.metadata.validity).toMatchObject({ status: 'superseded', superseded_by: NEW_ID });
    expect((b.search.mock.calls[0][1] as { includeSuperseded?: boolean }).includeSuperseded).toBe(true);
  });
});

describe('memory:list temporal flags (P-006 read path)', () => {
  it('passes as_of + include_superseded through to backend.list', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await list.handler({ as_of: '2026-06-15T00:00:00Z', include_superseded: true } as never, ctx),
    );
    expect(out.ok).toBe(true);
    expect(b.list.mock.calls[0][0]).toMatchObject({
      asOf: '2026-06-15T00:00:00Z',
      includeSuperseded: true,
    });
  });

  it('rejects invalid timestamps at both public read boundaries', () => {
    const bad = { as_of: 'not-a-timestamp' };
    expect((search.args as { safeParse: (value: unknown) => { success: boolean } }).safeParse({ query: 'q', ...bad }).success).toBe(false);
    expect((list.args as { safeParse: (value: unknown) => { success: boolean } }).safeParse(bad).success).toBe(false);
  });
});

describe('temporal memory tool guidance (P-009 agent discipline)', () => {
  it('teaches current-only defaults and the two historical read controls', () => {
    const searchGuidance = search.guidance;
    const listGuidance = list.guidance;
    expect(searchGuidance).toBeDefined();
    expect(listGuidance).toBeDefined();
    if (!searchGuidance || !listGuidance) throw new Error('memory tool guidance is required');

    expect(searchGuidance.when).toContain('Default recall returns only facts CURRENT now');
    expect(searchGuidance.when).toContain('as_of:<ISO timestamp>');
    expect(searchGuidance.when).toContain('include_superseded:true');
    expect(String((search.args as { shape?: { as_of?: { description?: string } } }).shape?.as_of?.description ?? search.args)).toContain('half-open');
    expect(searchGuidance.chaining).toContain('supersede:<old-id>');

    expect(listGuidance.when).toContain('Default listing returns only facts CURRENT now');
    expect(listGuidance.when).toContain('as_of:<ISO timestamp>');
    expect(listGuidance.when).toContain('include_superseded:true');
    expect(listGuidance.chaining).toContain('soft:true');
  });
});

describe('memory:update supersedes (P-004 write path)', () => {
  it('patches the new fact, then closes the old one with superseded_by = new id', async () => {
    const b = fakeBackend();
    b.get.mockImplementation(async (id: string) => ({
      id,
      text: id === NEW_ID ? 'memory embed default is harrier' : 'memory embed default is gemma',
      scope: 'user-1',
      metadata: { validity: { status: 'current', superseded_by: null } },
    }));
    useBackend(b);
    const out = parse(
      await update.handler(
        { id: NEW_ID, content: 'memory embed default is harrier', supersedes: OLD_ID } as never,
        ctx,
      ),
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: OLD_ID });
    // EI-10371: content edits carry the credential-flag re-stamp (clean here).
    expect(b.update).toHaveBeenCalledWith(NEW_ID, {
      text: 'memory embed default is harrier',
      metadata: { possible_secret: false, possible_secret_classes: [] },
    });
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID, { supersededBy: NEW_ID });
    // Order: the replacing fact lands in corrected form BEFORE the old closes.
    expect(b.update.mock.invocationCallOrder[0]).toBeLessThan(
      (b.invalidateEntry as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it('a supersedes-ONLY item is valid: no patch call, just the window close', async () => {
    const b = fakeBackend();
    b.get.mockImplementation(async (id: string) => ({
      id,
      text: id === NEW_ID ? 'memory embed default is harrier' : 'memory embed default is gemma',
      scope: 'user-1',
      metadata: { validity: { status: 'current', superseded_by: null } },
    }));
    useBackend(b);
    const out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: OLD_ID });
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).toHaveBeenCalledTimes(1);
  });

  it('a memory cannot supersede itself — rejected BEFORE any write', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: NEW_ID } as never, ctx),
    );
    expect(out.results[0]).toMatchObject({ ok: false, id: NEW_ID });
    expect(out.results[0].error).toContain('supersede itself');
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('supersedes on a backend WITHOUT the capability fails the item before the patch (no half-done state)', async () => {
    const b = fakeBackend(false);
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx),
    );
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain('validity-window support');
    expect(b.update).not.toHaveBeenCalled();
  });

  it('a concurrent immutable winner closes the losing replacement and reports failure', async () => {
    const b = fakeBackend();
    (b.invalidateEntry as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    // A real race: the old row is OPEN at preflight, and a different winner
    // closes it before this replacement's close lands. (A winner already named
    // at preflight is refused before any write; see the test below.)
    let oldReads = 0;
    b.get.mockImplementation(async (id: string) => {
      if (id === OLD_ID) oldReads += 1;
      return {
        id,
        text: id === NEW_ID ? 'replacement' : 'old',
        scope: 'user-1',
        metadata: id === OLD_ID && oldReads > 1
          ? { validity: { status: 'superseded', superseded_by: '33333333-3333-4333-8333-333333333333' } }
          : { validity: { status: 'current', superseded_by: null } },
      };
    });
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx),
    );
    expect(out.results[0]).toMatchObject({ ok: false, id: NEW_ID, superseded: false });
    expect(out.results[0].error).toContain('another replacement won');
    expect(b.invalidateEntry).toHaveBeenNthCalledWith(1, OLD_ID, { supersededBy: NEW_ID });
    expect(b.invalidateEntry).toHaveBeenNthCalledWith(2, NEW_ID);
  });

  // EI-26515229747561182: memory:forget { soft } closes a row with
  // superseded_by NULL. That row folds to status 'superseded' with NO winner,
  // and memory:update { supersedes } was refused with "already has a different
  // immutable winner", naming a winner that did not exist.
  it('a soft-forgotten (closed, winner-less) target passes preflight and gets the lineage link', async () => {
    const b = fakeBackend();
    b.get.mockImplementation(async (id: string) => ({
      id,
      text: id === NEW_ID ? 'replacement' : 'retracted',
      scope: 'user-1',
      metadata: id === OLD_ID
        ? { validity: { status: 'superseded', superseded_by: null } }
        : { validity: { status: 'current', superseded_by: null } },
    }));
    useBackend(b);
    const out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: OLD_ID });
    expect(b.invalidateEntry).toHaveBeenCalledTimes(1);
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID, { supersededBy: NEW_ID });
  });

  it('a target that names a DIFFERENT winner is refused before mutation, and the error names it', async () => {
    const WINNER = '33333333-3333-4333-8333-333333333333';
    const b = fakeBackend();
    b.get.mockImplementation(async (id: string) => ({
      id,
      text: 'x',
      scope: 'user-1',
      metadata: id === OLD_ID
        ? { validity: { status: 'superseded', superseded_by: WINNER } }
        : { validity: { status: 'current', superseded_by: null } },
    }));
    useBackend(b);
    const out = parse(await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: false, id: NEW_ID });
    expect(out.results[0].error).toContain(`different immutable winner (${WINNER})`);
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('a refused link with NO winner does not close the replacement (not a lost race)', async () => {
    const b = fakeBackend();
    (b.invalidateEntry as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    b.get.mockImplementation(async (id: string) => ({
      id,
      text: id === NEW_ID ? 'replacement' : 'old',
      scope: 'user-1',
      metadata: { validity: { status: 'current', superseded_by: null } },
    }));
    useBackend(b);
    const out = parse(await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: false, id: NEW_ID, superseded: false });
    expect(out.results[0].error).toContain('supersession not recorded');
    expect(out.results[0].error).not.toContain('another replacement won');
    expect(b.invalidateEntry).toHaveBeenCalledTimes(1);
    expect(b.invalidateEntry).not.toHaveBeenCalledWith(NEW_ID);
  });

  it('rejects unknown, cross-scope, and entity supersession endpoints before mutation', async () => {
    const b = fakeBackend();
    useBackend(b);

    b.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    let out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: false });
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).not.toHaveBeenCalled();

    b.get.mockReset()
      .mockResolvedValueOnce({ id: NEW_ID, text: 'new', scope: 'scope-a' } as MemoryEntry)
      .mockResolvedValueOnce({ id: OLD_ID, text: 'old', scope: 'scope-b' } as MemoryEntry);
    out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0].error).toContain('same scope');

    b.get.mockReset()
      .mockResolvedValueOnce({ id: NEW_ID, text: 'new', scope: 'scope-a' } as MemoryEntry)
      .mockResolvedValueOnce({ id: OLD_ID, text: 'old', scope: 'scope-a', metadata: { entityType: 'person' } } as MemoryEntry);
    out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0].error).toContain('entity rows');
  });
});

describe('memory:forget soft mode (P-004 write path)', () => {
  it('DEFAULT stays the HARD delete — the privacy-safe answer', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: OLD_ID });
    expect(out.results[0].soft).toBeUndefined();
    expect(b.forget).toHaveBeenCalledWith(OLD_ID);
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('soft:true closes the validity window instead of deleting', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID, soft: true } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: OLD_ID, soft: true });
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID);
    expect(b.forget).not.toHaveBeenCalled();
  });

  it('a soft forget of an already-closed / unknown id fails that item (never a silent no-op)', async () => {
    const b = fakeBackend();
    (b.invalidateEntry as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    useBackend(b);
    const out = parse(await forget.handler({ ids: [OLD_ID, NEW_ID], soft: true } as never, ctx));
    expect(out.counts).toEqual({ ok: 0, failed: 2 });
    expect(out.results[0].error).toContain('no open memory matched');
  });

  it('soft on a backend WITHOUT the capability refuses the batch — NEVER falls back to hard delete', async () => {
    const b = fakeBackend(false);
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID, soft: true } as never, ctx));
    expect(out).toMatchObject({ ok: false, reason: 'soft_forget_unsupported' });
    expect(b.forget).not.toHaveBeenCalled();
  });
});
