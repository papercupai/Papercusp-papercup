/**
 * agent-obligation-owner-directive-addressing.test.ts — P-004 of plan
 * `owner-directive-delivery-redesign-2026-09-22` (D-003 / D-004).
 *
 * WHAT THIS EXISTS TO CATCH. A class-B owner-directive row is a `due`,
 * `critical` obligation that re-injects on every turn until dispositioned. The
 * reader used to hand EVERY open directive in the workspace to EVERY session,
 * so each agent carried every other agent's directives as its own imperative,
 * on every turn. D-003 makes the whole team's directives visible as AWARENESS
 * (the ownerDirectives orientation class does that); obligation framing
 * belongs only to the session the owner addressed, or the one holding a live
 * work-item on the directive.
 *
 * The subject is the REAL default reader dependency, with only its two data
 * reads mocked, so the filter under test is the one that ships.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBoundedTimeout } from './bounded-timeout';
import type { OwnerDirectiveRow } from './owner-directives';

const h = vi.hoisted(() => ({
  listOwnerDirectives: vi.fn(),
  listWorkItemsByDirective: vi.fn(),
  directivesInheritedBy: vi.fn(),
}));

// P-008's fleet-leader routing has its own suite (owner-directive-routing.test.ts);
// here only its verdict is stubbed, so this file never reaches the database.
vi.mock('./owner-directive-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-directive-routing')>()),
  directivesInheritedBy: h.directivesInheritedBy,
}));

vi.mock('./owner-directives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-directives')>()),
  listOwnerDirectives: h.listOwnerDirectives,
}));

vi.mock('./work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./work-items')>()),
  listWorkItemsByDirective: h.listWorkItemsByDirective,
}));

const { defaultAgentObligationReaderDeps } = await import('./agent-obligation-reader');

const ME = 'su-me-00000000';
const PEER = 'su-peer-1111111';

function directive(id: number, recordedBy: string, verbatimText = `directive ${id}`): OwnerDirectiveRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: `turn-${id}`,
    verbatimText,
    recordedBy,
    createdAtMs: Date.parse('2026-09-22T12:00:00.000Z') + id,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    capturedByHook: true,
  };
}

async function read() {
  return defaultAgentObligationReaderDeps().ownerDirectives('papercusp-workspace', ME);
}

// The reader imports these lazily; `work-items` is large, and a cold import
// under fleet load measured 15s — pay it here, not inside the first test.
beforeAll(async () => {
  await Promise.all([import('./work-items'), import('./owner-directive-display')]);
}, 120_000);

beforeEach(() => {
  h.listOwnerDirectives.mockReset();
  h.listWorkItemsByDirective.mockReset();
  h.listWorkItemsByDirective.mockResolvedValue([]);
  h.directivesInheritedBy.mockReset();
  h.directivesInheritedBy.mockResolvedValue(new Set());
});

describe('a directive whose session ended passes to its fleet leader (P-008 / R-7)', () => {
  it('keeps an inherited peer directive and marks it as inherited', async () => {
    h.listOwnerDirectives.mockResolvedValue([directive(1, ME), directive(2, PEER), directive(3, PEER)]);
    h.directivesInheritedBy.mockResolvedValue(new Set([2]));
    const rows = await read();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.find((r) => r.id === 2)?.inheritedFromEnded).toBe(true);
    expect(rows.find((r) => r.id === 1)?.inheritedFromEnded).toBeUndefined();
  });

  it('a routing failure never hides the directives this session owns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.listOwnerDirectives.mockResolvedValue([directive(1, ME), directive(2, PEER)]);
      h.directivesInheritedBy.mockRejectedValue(new Error('pg down'));
      expect((await read()).map((r) => r.id)).toEqual([1]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner-directives:inheritance failed: pg down'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('owner-directive obligations belong only to the addressed or holding session (D-003)', () => {
  it.each(['work-item', 'routing', 'both'] as const)(
    'keeps known addressed directives inside the source deadline when %s enrichment never settles', async (stalled) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        h.listOwnerDirectives.mockResolvedValue([directive(1, ME), directive(2, PEER), directive(3, PEER)]);
        h.listWorkItemsByDirective.mockImplementation(() => stalled === 'routing'
          ? Promise.resolve([{ directiveRef: 2, id: 'WI-2', state: 'wip', assignee: ME }])
          : new Promise(() => {}));
        h.directivesInheritedBy.mockImplementation(() => stalled === 'work-item'
          ? Promise.resolve(new Set([3]))
          : new Promise(() => {}));

        const result = withBoundedTimeout(
          defaultAgentObligationReaderDeps(50).ownerDirectives('papercusp-workspace', ME),
          { fallback: null, timeoutMs: 50, label: 'test-owner-directive-source' },
        );
        await vi.advanceTimersByTimeAsync(50);
        const observed = await result;
        expect(observed.degraded).toBe(false);
        expect(observed.value?.map(row => row.id)).toEqual(
          stalled === 'work-item' ? [1, 3] : stalled === 'routing' ? [1, 2] : [1],
        );
        expect(h.directivesInheritedBy).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.flat().join(' ')).toContain('agent-obligations:owner-directives');
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('charges the canonical read against the enrichment budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.listOwnerDirectives.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return [directive(1, ME)];
      });
      h.listWorkItemsByDirective.mockImplementation(() => new Promise(() => {}));
      h.directivesInheritedBy.mockImplementation(() => new Promise(() => {}));
      const result = withBoundedTimeout(
        defaultAgentObligationReaderDeps(50).ownerDirectives('papercusp-workspace', ME),
        { fallback: null, timeoutMs: 50, label: 'test-owner-directive-source' },
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ degraded: false, value: [{ id: 1 }] });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a directive addressed to this session and drops an unclaimed peer directive', async () => {
    h.listOwnerDirectives.mockResolvedValue([directive(1, ME), directive(2, PEER)]);
    expect((await read()).map((r) => r.id)).toEqual([1]);
  });

  it('keeps a peer directive this session HOLDS through a live work-item', async () => {
    h.listOwnerDirectives.mockResolvedValue([directive(2, PEER), directive(3, PEER), directive(4, PEER)]);
    h.listWorkItemsByDirective.mockResolvedValue([
      { directiveRef: 2, id: 'WI-2', state: 'wip', assignee: ME },
      // A finished work-item no longer makes the directive this session's duty.
      { directiveRef: 3, id: 'WI-3', state: 'done', assignee: ME },
      // Held by someone else: still not this session's.
      { directiveRef: 4, id: 'WI-4', state: 'wip', assignee: PEER },
    ]);
    expect((await read()).map((r) => r.id)).toEqual([2]);
  });

  it('a failed work-item read degrades to addressed-only — it never hides the session’s own directive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.listOwnerDirectives.mockResolvedValue([directive(1, ME), directive(2, PEER)]);
      h.listWorkItemsByDirective.mockRejectedValue(new Error('pool exhausted'));
      expect((await read()).map((r) => r.id)).toEqual([1]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner-directives:held-work failed: pool exhausted'));
    } finally {
      warn.mockRestore();
    }
  });

  it('fetches the WHOLE open queue, so peer rows ahead of ours cannot starve ours out of a page', async () => {
    const peers = Array.from({ length: 30 }, (_, i) => directive(100 + i, PEER));
    h.listOwnerDirectives.mockResolvedValue([...peers, directive(999, ME)]);

    expect((await read()).map((r) => r.id)).toEqual([999]);
    expect(h.listOwnerDirectives).toHaveBeenCalledWith(
      expect.objectContaining({ state: ['open'], viewerOwnerId: ME, limit: 200 }),
    );
  });
});

describe('the row carries the D-004 display text, never a cut fragment', () => {
  it('a short directive arrives whole', async () => {
    h.listOwnerDirectives.mockResolvedValue([directive(1, ME, 'answer the question')]);
    expect((await read())[0]!.displayText).toBe('"answer the question"');
  });

  it('a long directive arrives as a summary-pending note plus the pointer, with no fragment', async () => {
    const long = 'rework the pipeline '.repeat(40);
    h.listOwnerDirectives.mockResolvedValue([directive(1, ME, long)]);
    const shown = (await read())[0]!.displayText;
    expect(shown).not.toContain('rework the pipeline');
    expect(shown).toContain('[full text: orders:get #1]');
  });
});
