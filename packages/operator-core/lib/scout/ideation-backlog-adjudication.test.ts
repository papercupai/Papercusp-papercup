import { describe, expect, it } from 'vitest';
import {
  ADJUDICATION_MERGE_COS,
  adjudicateIdeationBacklog,
  closeReasonFor,
  ideationBacklogAdjudicationSweep,
  IDEA_DISPOSITIONS,
  type AdjudicationDecision,
  type IdeaDisposition,
  type IdeationItem,
  type SimilarityEdge,
} from './ideation-backlog-adjudication';

const NOW = 1_791_480_000_000;

function item(id: string, createdTs: number, over: Partial<IdeationItem> = {}): IdeationItem {
  return { id, harness: 'papercusp', status: 'open', createdTs, terminalReason: null, hasCompletionEvidence: false, existing: null, ...over };
}

function byId(decisions: AdjudicationDecision[]): Record<string, IdeaDisposition> {
  return Object.fromEntries(decisions.map((d) => [d.id, d.disposition]));
}

describe('adjudicateIdeationBacklog — terminal items (R-9: open or not, every item has a disposition)', () => {
  it('maps each terminal close to its recorded disposition', () => {
    const d = byId(
      adjudicateIdeationBacklog(
        [
          item('EI-1', 1, { status: 'done' }),
          item('EI-2', 2, { status: 'resolved' }),
          item('EI-3', 3, { status: 'closed', hasCompletionEvidence: true }),
          item('EI-4', 4, { status: 'closed' }),
          item('EI-5', 5, { status: 'dropped', terminalReason: 'duplicate of EI-1 (system:work-item-admission-promoter run-7)' }),
          item('EI-6', 6, { status: 'dropped', terminalReason: 'deprecated' }),
        ],
        [],
        { nowMs: NOW },
      ),
    );
    expect(d['EI-1']).toMatchObject({ disposition: 'keep', basis: 'terminal-kept' });
    expect(d['EI-2']).toMatchObject({ disposition: 'keep', basis: 'terminal-kept' });
    expect(d['EI-3']).toMatchObject({ disposition: 'keep', basis: 'terminal-kept' });
    expect(d['EI-4']).toMatchObject({ disposition: 'drop', basis: 'terminal-dropped' });
    expect(d['EI-5']).toMatchObject({ disposition: 'merge', basis: 'terminal-duplicate', relatedTo: 'EI-1' });
    expect(d['EI-6']).toMatchObject({ disposition: 'drop', basis: 'terminal-dropped' });
  });
});

describe('adjudicateIdeationBacklog — open items', () => {
  it('merges an open idea into its closest OLDER kept near-duplicate', () => {
    const edges: SimilarityEdge[] = [
      { a: 'EI-1', b: 'EI-9', cos: 0.91 },
      { a: 'EI-9', b: 'EI-2', cos: 0.95 },
    ];
    const d = byId(adjudicateIdeationBacklog([item('EI-1', 1, { status: 'done' }), item('EI-2', 2), item('EI-9', 9)], edges, { nowMs: NOW }));
    expect(d['EI-2']).toMatchObject({ disposition: 'keep', basis: 'unique' });
    expect(d['EI-9']).toMatchObject({ disposition: 'merge', basis: 'near-duplicate-of-kept', relatedTo: 'EI-2', cos: 0.95 });
  });

  it('never merges an older idea into a newer one (the oldest is canonical)', () => {
    const d = byId(adjudicateIdeationBacklog([item('EI-1', 1), item('EI-2', 2)], [{ a: 'EI-2', b: 'EI-1', cos: 0.97 }], { nowMs: NOW }));
    expect(d['EI-1'].disposition).toBe('keep');
    expect(d['EI-2']).toMatchObject({ disposition: 'merge', relatedTo: 'EI-1' });
  });

  it('drops an open idea whose only older near-duplicate was rejected, and prefers a kept one when both exist', () => {
    const items = [item('EI-1', 1, { status: 'dropped' }), item('EI-2', 2), item('EI-3', 3, { status: 'done' }), item('EI-4', 4)];
    const edges = [
      { a: 'EI-1', b: 'EI-2', cos: 0.93 },
      { a: 'EI-1', b: 'EI-4', cos: 0.99 },
      { a: 'EI-3', b: 'EI-4', cos: 0.9 },
    ];
    const d = byId(adjudicateIdeationBacklog(items, edges, { nowMs: NOW }));
    expect(d['EI-2']).toMatchObject({ disposition: 'drop', basis: 'near-duplicate-of-dropped', relatedTo: 'EI-1' });
    expect(d['EI-4']).toMatchObject({ disposition: 'merge', relatedTo: 'EI-3' });
  });

  it('ignores edges below the census duplicate floor', () => {
    const d = byId(adjudicateIdeationBacklog([item('EI-1', 1), item('EI-2', 2)], [{ a: 'EI-1', b: 'EI-2', cos: ADJUDICATION_MERGE_COS - 0.001 }], { nowMs: NOW }));
    expect(d['EI-2']).toMatchObject({ disposition: 'keep', basis: 'unique' });
  });

  it('resolves only against DIRECT kept neighbours — a merged item is not a canonical for others', () => {
    const edges = [
      { a: 'EI-1', b: 'EI-2', cos: 0.95 },
      { a: 'EI-2', b: 'EI-3', cos: 0.95 },
    ];
    const d = byId(adjudicateIdeationBacklog([item('EI-1', 1), item('EI-2', 2), item('EI-3', 3)], edges, { nowMs: NOW }));
    expect(d['EI-2'].disposition).toBe('merge');
    expect(d['EI-3']).toMatchObject({ disposition: 'keep', basis: 'unique' });
  });

  it('keeps a recorded disposition stable and does not ask to rewrite it', () => {
    const recorded: IdeaDisposition = { disposition: 'keep', basis: 'unique', version: 1, adjudicatedAtMs: 1, by: 'x' };
    const decisions = adjudicateIdeationBacklog(
      [item('EI-1', 1, { status: 'done' }), item('EI-2', 2, { existing: recorded }), item('EI-3', 3)],
      [
        { a: 'EI-1', b: 'EI-2', cos: 0.99 },
        { a: 'EI-2', b: 'EI-3', cos: 0.92 },
      ],
      { nowMs: NOW },
    );
    const d = byId(decisions);
    expect(d['EI-2']).toBe(recorded);
    expect(decisions.find((x) => x.id === 'EI-2')?.needsWrite).toBe(false);
    // A newer near-duplicate resolves against the recorded keep.
    expect(d['EI-3']).toMatchObject({ disposition: 'merge', relatedTo: 'EI-2' });
  });

  it('assigns exactly one valid disposition to every item of an arbitrary population', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const statuses = ['open', 'open', 'blocked', 'done', 'dropped', 'closed', 'resolved', 'needs-human'];
    const items = Array.from({ length: 200 }, (_, i) => item(`EI-${i}`, Math.floor(rnd() * 50), { status: statuses[Math.floor(rnd() * statuses.length)] }));
    const edges = Array.from({ length: 400 }, () => ({ a: `EI-${Math.floor(rnd() * 200)}`, b: `EI-${Math.floor(rnd() * 200)}`, cos: 0.8 + rnd() * 0.2 }));
    const decisions = adjudicateIdeationBacklog(items, edges, { nowMs: NOW });
    expect(decisions).toHaveLength(items.length);
    expect(new Set(decisions.map((d) => d.id)).size).toBe(items.length);
    for (const d of decisions) {
      expect(IDEA_DISPOSITIONS).toContain(d.disposition.disposition);
      if (d.disposition.disposition === 'merge' && d.disposition.basis === 'near-duplicate-of-kept') {
        expect(byId(decisions)[d.disposition.relatedTo!].disposition).toBe('keep');
      }
    }
  });
});

describe('closeReasonFor', () => {
  it('writes the promoter duplicate convention, so a closed merge re-adjudicates to the same target', () => {
    const merge: IdeaDisposition = { disposition: 'merge', basis: 'near-duplicate-of-kept', relatedTo: 'EI-42', cos: 0.934, version: 1, adjudicatedAtMs: NOW, by: 'x' };
    const reason = closeReasonFor(merge);
    expect(reason).toMatch(/^duplicate of EI-42 \(/);
    const [after] = adjudicateIdeationBacklog([item('EI-50', 5, { status: 'dropped', terminalReason: reason })], [], { nowMs: NOW });
    expect(after.disposition).toMatchObject({ disposition: 'merge', relatedTo: 'EI-42' });
  });

  it('a rejected near-duplicate close re-adjudicates as drop', () => {
    const drop: IdeaDisposition = { disposition: 'drop', basis: 'near-duplicate-of-dropped', relatedTo: 'EI-7', cos: 0.91, version: 1, adjudicatedAtMs: NOW, by: 'x' };
    const [after] = adjudicateIdeationBacklog([item('EI-8', 5, { status: 'dropped', terminalReason: closeReasonFor(drop) })], [], { nowMs: NOW });
    expect(after.disposition.disposition).toBe('drop');
  });
});

describe('ideationBacklogAdjudicationSweep', () => {
  const population = [item('EI-1', 1), item('EI-2', 2), item('EI-3', 3, { status: 'dropped' }), item('EI-4', 4), item('EI-5', 5, { status: 'done' })];
  const edges = [
    { a: 'EI-1', b: 'EI-2', cos: 0.96 },
    { a: 'EI-3', b: 'EI-4', cos: 0.92 },
  ];

  function fakeDeps(over: { closeThrowsFor?: string } = {}) {
    const written: AdjudicationDecision[] = [];
    const closed: string[] = [];
    return {
      written,
      closed,
      deps: {
        readItems: async () => population,
        readEdges: async () => edges,
        write: async (_ws: string, ds: readonly AdjudicationDecision[]) => {
          const pending = ds.filter((d) => d.needsWrite);
          written.push(...pending);
          return pending.length;
        },
        close: async (d: AdjudicationDecision) => {
          if (d.id === over.closeThrowsFor) throw new Error('refused');
          closed.push(d.id);
        },
      },
    };
  }

  it('records a disposition for every item and retires only non-terminal merge/drop items', async () => {
    const f = fakeDeps();
    const res = await ideationBacklogAdjudicationSweep({ workspaceId: 'ws', now: NOW, deps: f.deps });
    expect(res).toMatchObject({ outcome: 'ran', population: 5, written: 5, undisposed: 0, openToRetire: 2, closed: 2, closeFailures: 0 });
    expect(res.byDisposition).toEqual({ keep: 2, merge: 1, drop: 2 });
    expect(f.closed.sort()).toEqual(['EI-2', 'EI-4']);
  });

  it('closeBatch 0 records dispositions without closing anything', async () => {
    const f = fakeDeps();
    const res = await ideationBacklogAdjudicationSweep({ workspaceId: 'ws', now: NOW, closeBatch: 0, deps: f.deps });
    expect(res).toMatchObject({ written: 5, openToRetire: 2, closed: 0 });
    expect(f.closed).toEqual([]);
  });

  it('counts a refused close instead of aborting the sweep', async () => {
    const f = fakeDeps({ closeThrowsFor: 'EI-2' });
    const res = await ideationBacklogAdjudicationSweep({ workspaceId: 'ws', now: NOW, deps: f.deps });
    expect(res).toMatchObject({ closed: 1, closeFailures: 1 });
  });

  it('reports a read failure fail-soft', async () => {
    const res = await ideationBacklogAdjudicationSweep({
      workspaceId: 'ws',
      now: NOW,
      deps: { readItems: async () => { throw new Error('pg down'); } },
    });
    expect(res).toMatchObject({ outcome: 'error', reason: 'pg down', written: 0 });
  });

  it('honours the kill switch', async () => {
    const prev = process.env.PAPERCUSP_SCOUT_IDEATION_ADJUDICATION;
    process.env.PAPERCUSP_SCOUT_IDEATION_ADJUDICATION = '0';
    try {
      const f = fakeDeps();
      const res = await ideationBacklogAdjudicationSweep({ workspaceId: 'ws', now: NOW, deps: f.deps });
      expect(res.outcome).toBe('disabled');
      expect(f.written).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SCOUT_IDEATION_ADJUDICATION;
      else process.env.PAPERCUSP_SCOUT_IDEATION_ADJUDICATION = prev;
    }
  });
});
