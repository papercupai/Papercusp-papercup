/**
 * comment.test.ts — the work_items:comment HANDLER (commentWorkItem mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins: the inline
 * { id, body } single form → one result; the items:[…] many form → per-item results
 * keyed by id; a not-found item → that item's { ok:false } WITHOUT failing the batch;
 * a thrown engine error → { ok:false, id, error } via runBulk's keyOf.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/comment.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Only the two IO functions are stubbed; `isSettledWorkItemState` is the REAL
 * predicate, taken from the module under test's own writer.
 *
 * It used to be a hand-copied list — `['resolved','closed','done','passed','deprecated']`
 * — which had silently DRIFTED from `SETTLED_WORK_ITEM_STATES` (work-items.ts:1913):
 * the real set also contains `'dropped'`. That drift made this file assert the
 * OPPOSITE of production for every dropped item, and it under-tested the EI-8837
 * completion hint in the same direction for as long as it existed. Caught only
 * because EI-20027532687512023's nudge points filers at `dropped` specifically.
 *
 * Re-copying the list with `'dropped'` appended would fix this instance and leave
 * the trap armed for the next state the vocabulary gains, so the mock derives the
 * predicate instead — it cannot drift from the writer again.
 */
vi.mock('../../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items')>();
  return {
    commentWorkItem: vi.fn(),
    getWorkItem: vi.fn(),
    isSettledWorkItemState: actual.isSettledWorkItemState,
  };
});
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));

import type { WorkItem } from '../../work-items';
import { commentWorkItem, getWorkItem } from '../../work-items';
import { mockResolvedTyped } from '../../testing/typed-mock';
const cmtM = vi.mocked(commentWorkItem);
const getM = vi.mocked(getWorkItem);
const tool = (await import('./comment')).default;

/**
 * A FULLY-TYPED `WorkItem` fixture — the handler only reads `state`, but the value is
 * checked against `getWorkItem`'s real return type rather than cast `as never`.
 *
 * The cast form is what made WI-6673's fixtures stale invisibly: `as never` makes the
 * installed value assignable to ANY signature, so the day `WorkItem` gains a REQUIRED
 * field this file keeps compiling and fails at RUNTIME, in a run some unrelated peer's
 * change selected. Typed, that same day is a compile error HERE, at the fixture.
 * (`lint:mock-cast-escape` ratchets the count of the cast form; see
 * `packages/operator-core/lib/testing/typed-mock.ts`.)
 */
const wi = (over: Partial<WorkItem> & Pick<WorkItem, 'id' | 'state'>): WorkItem => ({
  kind: 'bug',
  family: 'issue',
  harness: null,
  title: 't',
  summary: 's',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  parent: null,
  payload: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  goalId: null,
  ...over,
});

type Out = { data: any };
const run = (args: unknown) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = async (args: unknown) => ((await run(args)).data);

beforeEach(() => vi.clearAllMocks());

describe('work_items:comment handler (bulk keyed-array)', () => {
  it('inline { id, body } posts one comment and returns a single result', async () => {
    cmtM.mockResolvedValue({ id: 'post-1' } as never);
    const b = await body({ id: 'WI-1', body: 'hello' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', post: { id: 'post-1' } });
    // P-012 / D-006: the commenter's identity rides as writerOwnerId so a restricted
    // writer's comment is sealed.
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'hello', 'me', { harness: undefined, writerOwnerId: 'me' });
  });

  it('forwards a concrete request workspace while rejecting the unscoped wildcard', async () => {
    cmtM.mockResolvedValue({ id: 'post-1' } as never);
    await tool.handler({ id: 'WI-1', body: 'hello' } as never, { workspaceId: 'ws-scoped' } as never);
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'hello', 'me', { harness: undefined, workspaceId: 'ws-scoped', writerOwnerId: 'me' });

    cmtM.mockClear();
    await tool.handler({ id: 'WI-2', body: 'hello' } as never, { workspaceId: '*' } as never);
    expect(cmtM).toHaveBeenCalledWith('WI-2', 'hello', 'me', { harness: undefined, writerOwnerId: 'me' });
  });

  it('items:[…] comments on many; a not-found item fails only itself', async () => {
    cmtM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id: `post-${id}` } as never)));
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-X', body: 'b' }, { id: 'WI-2', body: 'c' }] });
    expect(b.ok).toBe(false); // DERIVED from counts.failed — WI-X failed
    expect(b.counts).toEqual({ ok: 2, failed: 1 }); // …but the batch still RAN: 2 succeeded
    expect(b.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-1', true],
      ['WI-X', false],
      ['WI-2', true],
    ]);
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });

  it('a thrown engine error becomes that item\'s { ok:false, id, error } (batch survives)', async () => {
    cmtM.mockImplementation(async (id: string) => {
      if (id === 'WI-2') throw new Error('boom');
      return { id: `post-${id}` } as never;
    });
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toEqual({ ok: false, id: 'WI-2', error: 'boom' });
  });

  it('per-item harness overrides the batch default', async () => {
    cmtM.mockResolvedValue({ id: 'p' } as never);
    await body({ harness: 'def', items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b', harness: 'web' }] });
    expect(cmtM).toHaveBeenNthCalledWith(1, 'WI-1', 'a', 'me', { harness: 'def', writerOwnerId: 'me' });
    expect(cmtM).toHaveBeenNthCalledWith(2, 'WI-2', 'b', 'me', { harness: 'web', writerOwnerId: 'me' });
  });

  describe('EI-8837: completion-shaped post on a still-open item gets a nudge hint', () => {
    it('a "DONE + GREEN" post on a non-terminal item carries `hint`', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      mockResolvedTyped(getM, wi({ id: 'WI-1', state: 'open' }));
      const b = await body({ id: 'WI-1', body: '✅ DONE + GREEN, all tests pass.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', hint: expect.stringContaining('work_items:set_state') });
      expect(getM).toHaveBeenCalledWith('WI-1', undefined);
    });

    it.each([
      ['post 54805', 'Closing as done given: the acceptance criterion is met with fresh independent verification.'],
      [
        'post 54809',
        'Actually flipping state to done now (the prior "closing as done" comment never took effect as a state transition).',
      ],
    ])('matches the measured WI-5391 %s completion phrase (WI-6958)', async (_case, comment) => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      mockResolvedTyped(getM, wi({ id: 'WI-5391', state: 'open' }));

      const b = await body({ id: 'WI-5391', body: comment });

      expect(b.results[0]).toMatchObject({
        ok: true,
        id: 'WI-5391',
        hint: expect.stringContaining('work_items:complete'),
      });
      expect(getM).toHaveBeenCalledWith('WI-5391', undefined);
    });

    it('the SAME post on an ALREADY-terminal item carries no hint', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      mockResolvedTyped(getM, wi({ id: 'WI-1', state: 'resolved' }));
      const b = await body({ id: 'WI-1', body: 'VM-verified, fully fixed.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
    });

    it('routine, non-completion-shaped chatter never triggers the getWorkItem lookup at all', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      const b = await body({ id: 'WI-1', body: 'still investigating, no conclusion yet' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
      expect(getM).not.toHaveBeenCalled();
    });

    it('a getWorkItem failure never fails the already-landed comment', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      getM.mockRejectedValue(new Error('lookup boom'));
      const b = await body({ id: 'WI-1', body: 'fully fixed and verified.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
    });
  });

  describe('EI-20027532687512023: retraction-shaped post on a still-open item gets a DROP nudge', () => {
    beforeEach(() => cmtM.mockResolvedValue({ id: 'post-1' } as never));

    /**
     * THE CALIBRATION CASE — the VERBATIM opening of the real retraction that
     * caused this bug (harness_shared.coord_thread_posts id=56789, posted
     * 2026-08-10T01:12:46.652Z on issue-thread-EI-20026000903745625). Twelve
     * minutes after this text landed, scheduler:get_next served that item as the
     * harness's #1 critical.
     *
     * Pinned to the MEASURED string rather than phrasing invented alongside the
     * regex: a predicate tested only against examples its own author wrote is
     * calibrated to itself, and would pass just as happily while missing every
     * retraction a real filer writes.
     */
    it('MATCHES the real measured retraction text that this bug was filed for', async () => {
      mockResolvedTyped(getM, wi({ id: 'EI-1', state: 'open' }));
      const b = await body({
        id: 'EI-1',
        body: "## ⚠⚠ RETRACTION BY THE FILER — this item's central premise is WRONG. Do not act on it as written.",
      });
      expect(b.results[0].hint).toEqual(expect.stringContaining("state:'dropped'"));
      expect(b.results[0].hint).toEqual(expect.stringContaining('completionRef'));
      expect(b.results[0].hint).toEqual(expect.stringContaining("assumptions:'none'"));
      expect(b.results[0].hint).not.toEqual(expect.stringContaining('terminal_reason'));
    });

    it('the nudge names the QUEUE consequence, not just the verb', async () => {
      mockResolvedTyped(getM, wi({ id: 'EI-1', state: 'open' }));
      const b = await body({ id: 'EI-1', body: 'Retracting this — my analysis was wrong.' });
      // The whole failure was that a retraction is invisible to routing, so the
      // hint has to say THAT, or it reads as optional bookkeeping.
      expect(b.results[0].hint).toEqual(expect.stringContaining('scheduler:get_next'));
      expect(b.results[0].hint).toEqual(expect.stringContaining('ORIGINAL SEVERITY'));
    });

    it('the SAME retraction on an ALREADY-terminal item carries no hint', async () => {
      mockResolvedTyped(getM, wi({ id: 'EI-1', state: 'dropped' }));
      const b = await body({ id: 'EI-1', body: 'Retracting this — the premise is wrong.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1' });
      expect(b.results[0].hint).toBeUndefined();
    });

    /**
     * Precedence: a retraction that also carries completion-ish wording must get
     * the RETRACTION hint. The completion hint points at work_items:complete,
     * which would record a false completion on an item whose author has just
     * disproved its premise — the wrong verb in the expensive direction.
     */
    it('retraction WINS over completion when a post matches both predicates', async () => {
      mockResolvedTyped(getM, wi({ id: 'EI-1', state: 'open' }));
      const b = await body({
        id: 'EI-1',
        body: 'I retract this. Ready to close — the finding was wrong, and all tests are green so done.',
      });
      expect(b.results[0].hint).toEqual(expect.stringContaining("state:'dropped'"));
      expect(b.results[0].hint).not.toEqual(expect.stringContaining('work_items:complete'));
    });

    /**
     * THE CONTROL. Without this, every assertion above would pass just as well
     * against a regex matching /./ — the predicate has to be shown REFUSING
     * something, and the realistic false positive is an ordinary correction of
     * one detail on an item that remains entirely valid.
     */
    it('an ordinary mid-thread correction does NOT nudge, and never even looks the item up', async () => {
      const b = await body({
        id: 'EI-1',
        body: 'Correction: the timeout is 480s, not 240s as I said above. Rest of the diagnosis stands.',
      });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1' });
      expect(b.results[0].hint).toBeUndefined();
      expect(getM).not.toHaveBeenCalled();
    });
  });
});

/**
 * EI-10897 (the alias) + EI-10996 (the way the first cut of it broke the catalog).
 *
 * The tool is CALLED `comment`, so `{ id, comment }` is the spelling an agent reaches
 * for first; it used to be rejected. The alias is resolved HANDLER-side on purpose —
 * a zod `.transform()` in the args schema makes `z.toJSONSchema` throw, and that call
 * is un-try/caught in BOTH defineTool registration and the MCP tools/list handlers, so
 * one transform here takes down schema-gen for the ENTIRE tool catalog (it red-pinned
 * the release gate). The representability test below is that regression's guard.
 */
describe('body/comment alias (EI-10897) + schema representability (EI-10996)', () => {
  const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
  const safeParse = (x: unknown) => (tool.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse(x);

  beforeEach(() => {
    mockResolvedTyped(cmtM, { id: 1, thread_id: 'wi:WI-1', author_id: 'me', body: 'b', created_ts: '2026-01-01T00:00:00.000Z' });
    mockResolvedTyped(getM, wi({ id: 'WI-1', state: 'wip' }));
  });

  it('accepts { id, comment } — the obvious spelling — and posts it as the body', async () => {
    await body(parse({ id: 'WI-1', comment: 'via the alias' }));
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'via the alias', 'me', expect.anything());
  });

  it('still accepts { id, body } (the alias is additive, not a rename)', async () => {
    await body(parse({ id: 'WI-1', body: 'via body' }));
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'via body', 'me', expect.anything());
  });

  it('resolves the alias in the BULK path identically', async () => {
    await body(parse({ items: [{ id: 'WI-1', comment: 'a' }, { id: 'WI-2', body: 'b' }] }));
    expect(cmtM).toHaveBeenNthCalledWith(1, 'WI-1', 'a', 'me', expect.anything());
    expect(cmtM).toHaveBeenNthCalledWith(2, 'WI-2', 'b', 'me', expect.anything());
  });

  it('REJECTS both-with-different-text (never silently pick one)', () => {
    expect(safeParse({ id: 'WI-1', body: 'x', comment: 'y' }).success).toBe(false);
    expect(safeParse({ id: 'WI-1', body: 'same', comment: 'same' }).success).toBe(true);
  });

  it('REJECTS a comment with no text at all', () => {
    expect(safeParse({ id: 'WI-1' }).success).toBe(false);
    expect(safeParse({ items: [{ id: 'WI-1' }] }).success).toBe(false);
  });

  it('the args schema stays JSON-Schema-REPRESENTABLE — a .transform() here crashes the whole catalog (EI-10996)', async () => {
    const { z } = await import('zod');
    expect(() => z.toJSONSchema(tool.args as never)).not.toThrow();
    // …and the alias must actually be ADVERTISED, or an agent can never discover it.
    const schema = z.toJSONSchema(tool.args as never) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain('comment');
  });
});
