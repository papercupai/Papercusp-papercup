/**
 * Recurrence guards for the memory-write-latency-2026-07-26 fix (P-009).
 *
 * The defect these lock down: `memory:remember` ran a full semantic neighbour
 * search on EVERY write to feed the conflict-check — but with no
 * ANTHROPIC_API_KEY the judge is an instant no-op, so the search fed nothing.
 * Measured on the live backend: that search was 85-95% of the write path
 * (982ms at a 250-char body, 3,222ms at 3,000), while the actual embed+store
 * was a flat ~100-176ms. See plan decisions D-001/D-002.
 *
 * Two CLASSES have to stay dead, which is why there are two groups below:
 *   1. paying for a neighbour search that nothing can consume;
 *   2. letting that search's cost scale with the memory body again.
 *
 * (2) matters because (1)'s capability gate is a regression trap on its own:
 * the moment anyone sets ANTHROPIC_API_KEY the search returns, now with a real
 * judge call on top of it. A bare capability check is not a recurrence guard —
 * these tests are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../memory/surfaced-outcomes', async (original) => ({
  ...(await original<typeof import('../../memory/surfaced-outcomes')>()),
  captureSurfacedOutcome: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));
vi.mock('../../knowledge-packs/identity-learning', async (original) => ({
  ...(await original<typeof import('../../knowledge-packs/identity-learning')>()),
  wornMemoryIdentityIds: vi.fn(async () => []),
}));
// Spread the real module so pure exports survive the mock — a minimal stub
// breaks at collection when a transitive import derefs them (EI-14928; AGENT_ROLES
// in testing/run.ts did exactly that across this directory on 2026-08-17).
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('../../memory/memory-pause', () => ({
  isMemoryPaused: vi.fn(async () => false),
  MEMORY_PAUSED_REFUSAL: { ok: false, reason: 'memory_paused' },
}));
vi.mock('../../memory/ref-expand', () => ({
  expandRefsForEmbed: vi.fn(async () => undefined),
}));

import remember, { neighbourSearchQuery } from './remember';
import { captureSurfacedOutcome } from '../../memory/surfaced-outcomes';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { getOrgPg } from '@papercusp/db-org';
import { journalPendingWrite, markJournalCommitted } from '../../memory/write-journal';
import { wornMemoryIdentityIds } from '../../knowledge-packs/identity-learning';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  invalidateEntry: ReturnType<typeof vi.fn>;
};

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';

const fakeBackend = (): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['m-1'] })),
  // A neighbour is always available to return, so a test that sees zero
  // search calls is seeing the GATE, never an empty-store coincidence.
  search: vi.fn(async () => [{ id: 'n-1', text: 'an existing neighbour', scope: 'user-1', score: 0.5 }]),
  get: vi.fn(async (id: string) => id === OLD_ID
    ? { id, text: 'old fact', scope: 'user-1', metadata: { validity: { status: 'current' } } }
    : null),
  invalidateEntry: vi.fn(async () => true),
});

const fakeCtx = { principal: { workspaceId: 'ws-test' } } as unknown as Parameters<typeof remember.handler>[1];

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'PAPERCUSP_MEMORY_DEDUP',
  'PAPERCUSP_MEMORY_CONFLICT_CHECK',
  'PAPERCUSP_MEMORY_NEIGHBOUR_QUERY_CHARS',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'user-1',
    display_name: 'Test User',
  } as unknown as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
  vi.mocked(getOrgPg).mockReturnValue({
    sql: vi.fn(async () => undefined) as unknown,
  } as unknown as ReturnType<typeof getOrgPg>);
  vi.mocked(journalPendingWrite).mockResolvedValue(null);
  vi.mocked(markJournalCommitted).mockResolvedValue(undefined);
  vi.mocked(wornMemoryIdentityIds).mockResolvedValue([]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

describe('P-009 class 1 — never pay for a neighbour search nothing can consume', () => {
  it('does NOT search when conflict-check is ON (its default) but no judge key resolves', async () => {
    // This is the exact live configuration that made the defect: conflict-check
    // defaults ON, dedup defaults off, and the operator has no ANTHROPIC_API_KEY.
    const b = fakeBackend();
    useBackend(b);

    const res = await remember.handler({ content: 'a stable fact', kind: 'reference' }, fakeCtx);

    expect(b.search).not.toHaveBeenCalled();
    // …and the write itself must still land. Skipping the search must never
    // turn into skipping the store.
    expect(b.remember).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it('DOES search when dedup is on — dedup is a real consumer even with no judge', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'a stable fact', kind: 'reference' }, fakeCtx);

    expect(b.search).toHaveBeenCalledTimes(1);
  });

  it('DOES search when conflict-check is on AND a judge key resolves', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'a stable fact', kind: 'reference' }, fakeCtx);

    expect(b.search).toHaveBeenCalledTimes(1);
  });

  it('does NOT search when conflict-check is explicitly off and dedup is off, even with a key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK = 'off';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'a stable fact', kind: 'reference' }, fakeCtx);

    expect(b.search).not.toHaveBeenCalled();
  });

  it('does NOT search when force=true bypasses both consumers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'a stable fact', kind: 'reference', force: true }, fakeCtx);

    expect(b.search).not.toHaveBeenCalled();
  });
});

describe('P-009 class 2 — the neighbour-search query stays bounded', () => {
  /** Comfortably past the 512-char cap and past the real-world p95 body (2,553). */
  const LONG = 'x'.repeat(4000);

  it('does not hand the whole body to the backend as the search query', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: LONG, kind: 'reference' }, fakeCtx);

    expect(b.search).toHaveBeenCalledTimes(1);
    const query = b.search.mock.calls[0][0] as string;
    expect(query.length).toBeLessThan(LONG.length);
    expect(query.length).toBeLessThanOrEqual(512);
  });

  it('still STORES the full body verbatim — the cap is on retrieval, not on the fact', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: LONG, kind: 'reference' }, fakeCtx);

    expect(b.remember).toHaveBeenCalledTimes(1);
    expect(b.remember.mock.calls[0][0]).toBe(LONG);
  });

  it('leaves a short body untouched, so ordinary writes are unchanged', () => {
    const short = 'a short fact';
    expect(neighbourSearchQuery(short)).toBe(short);
  });

  it('caps a long body at the configured length', () => {
    expect(neighbourSearchQuery(LONG)).toHaveLength(512);
    process.env.PAPERCUSP_MEMORY_NEIGHBOUR_QUERY_CHARS = '128';
    expect(neighbourSearchQuery(LONG)).toHaveLength(128);
  });

  it('honours an explicit opt-out (<= 0 restores the old unbounded query)', () => {
    process.env.PAPERCUSP_MEMORY_NEIGHBOUR_QUERY_CHARS = '0';
    expect(neighbourSearchQuery(LONG)).toBe(LONG);
  });
});

describe('memory:remember supersession convergence', () => {
  it('records citations as used and the successfully superseded memory as contradicted in this session', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    useBackend(b);
    const ctx = { ...fakeCtx, uiClientId: 'writer' } as Parameters<typeof remember.handler>[1];
    await remember.handler({ content: `replacement citing memory:${NEW_ID}`, kind: 'reference', supersede: OLD_ID }, ctx);
    expect(captureSurfacedOutcome).toHaveBeenCalledWith(ctx, [NEW_ID], 'used');
    expect(captureSurfacedOutcome).toHaveBeenCalledWith(ctx, [OLD_ID], 'contradicted');
  });

  it('does not record a contradiction when a supersession close fails', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    b.invalidateEntry.mockRejectedValue(new Error('close failed'));
    useBackend(b);
    await remember.handler({ content: 'replacement', kind: 'reference', supersede: OLD_ID }, fakeCtx);
    expect(captureSurfacedOutcome).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'contradicted');
  });

  it('supersedes the exact near-duplicate target instead of silently dropping its outcome', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend();
    const text = 'The workspace uses the canonical embedding model.';
    b.search.mockResolvedValue([{ id: OLD_ID, text, scope: 'user-1', score: 1 }]);
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    useBackend(b);
    const res = await remember.handler({ content: text, kind: 'reference', supersede: OLD_ID }, fakeCtx);
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text)).toMatchObject({ ok: true, superseded: OLD_ID });
    expect(captureSurfacedOutcome).toHaveBeenCalledWith(fakeCtx, [OLD_ID], 'contradicted');
  });

  it.each([
    ['unknown target', null, 'supersede_not_found'],
    ['cross-scope target', { id: OLD_ID, text: 'old', scope: 'harness:other' }, 'supersede_scope_mismatch'],
    ['entity target', { id: OLD_ID, text: 'old', scope: 'user-1', metadata: { entityType: 'person' } }, 'supersede_entity_forbidden'],
  ])('rejects %s before journal or store mutation', async (_label, target, reason) => {
    const b = fakeBackend();
    b.get.mockResolvedValue(target);
    useBackend(b);

    const res = await remember.handler({ content: 'replacement', kind: 'reference', supersede: OLD_ID }, fakeCtx);
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(parsed).toMatchObject({ ok: false, reason });
    expect(journalPendingWrite).not.toHaveBeenCalled();
    expect(b.remember).not.toHaveBeenCalled();
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('journals before storing and commits only after the old row closes', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    vi.mocked(journalPendingWrite).mockResolvedValue('journal-1');
    useBackend(b);

    const res = await remember.handler({ content: 'replacement', kind: 'reference', supersede: OLD_ID }, fakeCtx);
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(parsed).toMatchObject({ ok: true, ids: [NEW_ID], superseded: OLD_ID });
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID, { supersededBy: NEW_ID });
    expect(markJournalCommitted).toHaveBeenCalledWith('journal-1', NEW_ID);
    expect(vi.mocked(journalPendingWrite).mock.invocationCallOrder[0]).toBeLessThan(b.remember.mock.invocationCallOrder[0]);
    expect(b.remember.mock.invocationCallOrder[0]).toBeLessThan(b.invalidateEntry.mock.invocationCallOrder[0]);
  });

  it('keeps a durable retry record when replacement stores but closing the old row fails', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    b.invalidateEntry.mockRejectedValue(new Error('close failed'));
    vi.mocked(journalPendingWrite).mockResolvedValue('journal-2');
    useBackend(b);

    const res = await remember.handler({ content: 'replacement', kind: 'reference', supersede: OLD_ID }, fakeCtx);
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(parsed).toMatchObject({
      ok: true,
      ids: [NEW_ID],
      superseded: false,
      journaled: true,
      will_retry: true,
      journal_id: 'journal-2',
    });
    expect(markJournalCommitted).not.toHaveBeenCalled();
  });

  it('closes a losing replacement when another immutable winner wins the race', async () => {
    const b = fakeBackend();
    b.remember.mockResolvedValue({ ids: [NEW_ID] });
    b.invalidateEntry.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    b.get
      .mockResolvedValueOnce({ id: OLD_ID, text: 'old', scope: 'user-1', metadata: { validity: { status: 'current' } } })
      .mockResolvedValueOnce({ id: OLD_ID, text: 'old', scope: 'user-1', metadata: { validity: { status: 'superseded', superseded_by: '33333333-3333-4333-8333-333333333333' } } });
    useBackend(b);

    const res = await remember.handler({ content: 'replacement', kind: 'reference', supersede: OLD_ID }, fakeCtx);
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(parsed).toMatchObject({ ok: true, ids: [NEW_ID], superseded: false });
    expect(parsed.supersede_note).toContain('another replacement won');
    expect(b.invalidateEntry).toHaveBeenNthCalledWith(1, OLD_ID, { supersededBy: NEW_ID });
    expect(b.invalidateEntry).toHaveBeenNthCalledWith(2, NEW_ID);
  });
});
