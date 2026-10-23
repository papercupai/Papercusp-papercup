import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CarryBrief } from './carry-brief';
const refusalMarks = vi.hoisted(() => new Map<string, number>());
const autoCheckpointStaleHeldItems = vi.hoisted(() => vi.fn(async () => [] as Array<{ id: string; mechanical: true }>));
vi.mock('./turn-end-tracking-io', () => ({ autoCheckpointStaleHeldItems }));
const setLoopCarryNote = vi.hoisted(() => vi.fn());
vi.mock('./carry-note', () => ({ setLoopCarryNote }));
vi.mock('./flush-refusal-marker', () => ({
  REFUSAL_MARKER_TTL_MS: 10 * 60_000,
  wasRecentlyRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) =>
    (refusalMarks.get(`${boundary}:${ownerId}`) ?? -1) >= nowMs,
  markRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) => {
    refusalMarks.set(`${boundary}:${ownerId}`, nowMs + 10 * 60_000);
  },
  clearRefused: async (boundary: string, ownerId: string) => {
    refusalMarks.delete(`${boundary}:${ownerId}`);
  },
  __resetRefusalMarkers: async () => { refusalMarks.clear(); },
}));
import {
  REFUSAL_MARKER_TTL_MS,
  flushGateEnabled,
  wasRecentlyRefused,
  markRefused,
  clearRefused,
  runFlushGate,
  __resetRefusalMarkers,
} from './enforcement-gate-io';
import { SAME_TURN_CHECKPOINT_FRESHNESS_MS } from './enforcement-gate';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-test',
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

/** A brief with one held item that has NO checkpoint → a missing-checkpoint tripwire. */
function unflushedBrief(): CarryBrief {
  return brief({
    heldItems: [{ id: 'WI-7', title: 't', body: null, harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null }],
  });
}

beforeEach(async () => {
  await __resetRefusalMarkers();
  autoCheckpointStaleHeldItems.mockReset().mockResolvedValue([]);
  setLoopCarryNote.mockReset().mockResolvedValue(undefined);
  // Hermetic against host load (WI-5582): runFlushGate races the inner work against
  // a bounded-timeout budget (default 4s). On an event-loop-starved green-checkpoint
  // host that 4s wall clock once beat the instant mocked inner work, degrading the
  // verdict to `clear` and emitting the bounded-timeout console.warn — a gate flake.
  // Raise the budget far past any plausible starvation so the deadline never fires.
  process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS = '600000';
});
afterEach(async () => {
  await __resetRefusalMarkers();
  vi.useRealTimers();
  delete process.env.PAPERCUSP_FLUSH_GATE;
  delete process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS;
});

describe('refusal markers', () => {
  it('records and reads a refusal within the TTL, and clears it', async () => {
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
    await markRefused('compaction', 'su-a', NOW);
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(true);
    // a different boundary / owner is independent
    expect(await wasRecentlyRefused('handoff', 'su-a', NOW)).toBe(false);
    expect(await wasRecentlyRefused('compaction', 'su-b', NOW)).toBe(false);
    await clearRefused('compaction', 'su-a');
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
  });

  it('expires a marker past the TTL', async () => {
    await markRefused('compaction', 'su-a', NOW);
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW + REFUSAL_MARKER_TTL_MS + 1)).toBe(false);
  });
});

describe('flushGateEnabled', () => {
  it('defaults ON', () => {
    delete process.env.PAPERCUSP_FLUSH_GATE;
    expect(flushGateEnabled()).toBe(true);
  });
  it('is disabled by off/0/false/no', () => {
    for (const v of ['off', '0', 'false', 'NO', 'Off']) {
      process.env.PAPERCUSP_FLUSH_GATE = v;
      expect(flushGateEnabled()).toBe(false);
    }
  });
});

describe('runFlushGate ladder', () => {
  it('clears when the brief is clean', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-c',
      workspaceId: '*',
      sessionId: 'su-c',
      sinceIso: new Date(NOW).toISOString(),
      brief: brief(),
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });

  it('refuses once, then escalates to mechanical-fallback on the un-flushed retry', async () => {
    const args = {
      boundary: 'compaction' as const,
      ownerId: 'su-d',
      workspaceId: '*',
      sessionId: 'su-d',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
      // Hermetic (WI-7 is genuinely still open — never terminal — for this test):
      // avoid the default real-DB re-check dropTerminalHeldTripwires would otherwise
      // make against a held item's CURRENT state.
      getWorkItemStateFn: async () => ({ state: 'wip' }),
    };
    const first = await runFlushGate(args);
    expect(first.verdict).toBe('refuse');
    expect(first.refusalText).toContain('WI-7');
    expect(first.tripwires[0].kind).toBe('missing-checkpoint');
    // marker is now set
    expect(await wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(true);

    // retry with the SAME unflushed brief → the system writes the fallback + proceeds
    const second = await runFlushGate(args);
    expect(second.verdict).toBe('mechanical-fallback');
    expect(second.fallback).toBeDefined();
    // the fallback write fails soft with no DB in the unit env — checkpointedItems is
    // an array either way, and the verdict/marker transition is what matters here.
    expect(Array.isArray(second.fallback?.checkpointedItems)).toBe(true);
    expect(autoCheckpointStaleHeldItems).toHaveBeenCalledWith(
      expect.objectContaining({ heldItems: args.brief?.heldItems }),
    );
    // the marker is retired after the fallback fires
    expect(await wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(false);
  });

  it('forced mode writes the mechanical fallback on the first tripwire and never refuses', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      mode: 'forced',
      ownerId: 'su-forced',
      workspaceId: '*',
      sessionId: 'su-forced',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
      // Hermetic: keep the held item live so the snapshot tripwire is retained.
      getWorkItemStateFn: async () => ({ state: 'wip' }),
    });

    expect(out.verdict).toBe('mechanical-fallback');
    expect(out.tripwires[0]?.kind).toBe('missing-checkpoint');
    expect(out.fallback).toBeDefined();
    expect(await wasRecentlyRefused('compaction', 'su-forced', NOW)).toBe(false);
  });

  it('retires a stale marker when the boundary comes back clean (flush happened)', async () => {
    await markRefused('compaction', 'su-e', NOW);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-e',
      workspaceId: '*',
      sessionId: 'su-e',
      sinceIso: new Date(NOW).toISOString(),
      brief: brief(), // clean now
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(await wasRecentlyRefused('compaction', 'su-e', NOW)).toBe(false);
  });

  it('is a no-op (clear) when disabled by env, even with tripwires', async () => {
    process.env.PAPERCUSP_FLUSH_GATE = 'off';
    const out = await runFlushGate({
      boundary: 'handoff',
      ownerId: 'su-f',
      workspaceId: '*',
      sessionId: 'su-f',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });
});

describe('mandatory host snapshot', () => {
  it('refuses a failed mandatory loop checkpoint instead of reporting a successful save', async () => {
    setLoopCarryNote.mockRejectedValueOnce(Object.assign(new Error('storage unavailable'), { code: '08006' }));
    const out = await runFlushGate({
      boundary: 'compaction', mode: 'host-snapshot', ownerId: 'su-snapshot',
      workspaceId: '*', sessionId: 'su-snapshot', sinceIso: new Date(NOW).toISOString(),
      brief: brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60,
        carry: 'cold', goal: null, carryNote: null, carryNoteUpdatedAtMs: null } }),
      nowMs: NOW,
    });
    expect(setLoopCarryNote).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ verdict: 'refuse',
      snapshotFailure: { phase: 'checkpoint-write', code: '08006' } });
    expect(out.fallback).toBeUndefined();
  });

  it('waits for every checkpoint beyond the advisory deadline before returning its receipt', async () => {
    vi.useFakeTimers();
    process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS = '4000';
    let finishSave!: (items: Array<{ id: string; mechanical: true }>) => void;
    const save = new Promise<Array<{ id: string; mechanical: true }>>(resolve => { finishSave = resolve; });
    autoCheckpointStaleHeldItems.mockReturnValueOnce(save);
    let settled = false;
    const pending = runFlushGate({
      boundary: 'compaction', mode: 'host-snapshot', ownerId: 'su-snapshot',
      workspaceId: '*', sessionId: 'su-snapshot', sinceIso: new Date(NOW).toISOString(),
      brief: brief(), nowMs: NOW,
    }).then(value => { settled = true; return value; });
    try {
      await vi.waitFor(() => expect(autoCheckpointStaleHeldItems).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(4001);
      expect(settled).toBe(false);
      finishSave([{ id: 'WI-1', mechanical: true }, { id: 'WI-12', mechanical: true }]);
      await expect(pending).resolves.toMatchObject({
        verdict: 'mechanical-fallback', fallback: { checkpointedItems: ['WI-1', 'WI-12'] },
      });
    } finally {
      finishSave([]);
      await pending;
    }
  });
});

// EI-21874665446367942: the flush gate's evidence for the 'cold-successor-no-progress'
// tripwire (real agent tool calls since the loop carry-note was written) is resolved
// via an injectable seam (countAgentToolCallsFn) so this never opens a real Postgres
// connection, and is only PAID when detectFlushTripwires's own gate would actually use
// it (an active COLD loop with a note timestamp) — asserted via call-count below.
function coldLoopBrief(over: Partial<NonNullable<CarryBrief['loop']>> = {}): CarryBrief {
  return brief({
    loop: {
      harness: 'papercusp',
      active: true,
      intervalSec: 60,
      carry: 'cold',
      goal: null,
      carryNote: '## Next action\nRun the exact backlog recipe.',
      carryNoteUpdatedAtMs: NOW - 10 * 60_000,
      ...over,
    },
  });
}

describe('runFlushGate — cold-successor-no-progress wiring', () => {
  it('reads Next action content without including following carry-note sections', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-section-boundary',
      workspaceId: '*',
      sessionId: 'su-cold-section-boundary',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({
        carryNote: '## Did\nEarlier work.\n\n## Next action\nRun the exact test.\n\n## Walls\nOwner approval is pending.',
      }),
      nowMs: NOW,
      countAgentToolCallsFn: async () => 0,
    });
    expect(out.tripwires[0]?.detail).toContain('Run the exact test.');
    expect(out.tripwires[0]?.detail).not.toContain('Owner approval is pending.');
  });

  it('logs the active and completed phases when the bounded compaction gate times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS = '4000';
    let resolveCount!: (value: number | null) => void;
    const pendingCount = new Promise<number | null>((resolve) => { resolveCount = resolve; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pendingGate = runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-timeout',
      workspaceId: '*',
      sessionId: 'su-cold-timeout',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief(),
      nowMs: NOW,
      countAgentToolCallsFn: async () => pendingCount,
    });

    try {
      await vi.advanceTimersByTimeAsync(4000);
      await expect(pendingGate).resolves.toMatchObject({ verdict: 'clear', tripwires: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        'elapsedMs=4000 activePhase=count-agent-tool-calls-since-note activePhaseElapsedMs=4000 completedPhases=none',
      ));
    } finally {
      // Finish the observed in-flight read so the unit test leaves no dangling work.
      resolveCount(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(await wasRecentlyRefused('compaction', 'su-cold-timeout', NOW)).toBe(false);
      warn.mockRestore();
    }
  });

  it('refuses, naming the next action, when the seam confirms zero tool calls since the note', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold',
      workspaceId: '*',
      sessionId: 'su-cold',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief(),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toHaveLength(1);
    expect(out.tripwires[0].kind).toBe('cold-successor-no-progress');
    expect(out.refusalText).toContain('Run the exact backlog recipe.');
    // called with the note's timestamp as the window start, `nowMs` as the end
    expect(countFn).toHaveBeenCalledWith('su-cold', NOW - 10 * 60_000, NOW);
  });

  it('does not self-refuse compaction when the first next action is the carry-respawn itself', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-compaction',
      workspaceId: '*',
      sessionId: 'su-cold-compaction',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({
        carryNote: '## Next action\nCarry-respawn at the closed continuation gate, then read the fresh carry.',
      }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
    expect(countFn).toHaveBeenCalledWith('su-cold-compaction', NOW - 10 * 60_000, NOW);
  });

  it('does not refuse compaction after a fresh carry-note writer flush with zero post-note calls', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-fresh-writer',
      workspaceId: '*',
      sessionId: 'su-cold-fresh-writer',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({ carryNoteUpdatedAtMs: NOW - 1_000 }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
    expect(countFn).toHaveBeenCalledWith('su-cold-fresh-writer', NOW - 1_000, NOW);
  });

  it('keeps refusing when the carry-note writer is stale despite zero post-note calls', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-stale-writer',
      workspaceId: '*',
      sessionId: 'su-cold-stale-writer',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({ carryNoteUpdatedAtMs: NOW - SAME_TURN_CHECKPOINT_FRESHNESS_MS - 1 }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toEqual([expect.objectContaining({ kind: 'cold-successor-no-progress' })]);
  });

  it('does not self-refuse compaction when the first next action is "Compact now"', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-compact-now',
      workspaceId: '*',
      sessionId: 'su-cold-compact-now',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({
        carryNote: '## Next action\nCompact now.',
      }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
    expect(countFn).toHaveBeenCalledWith('su-cold-compact-now', NOW - 10 * 60_000, NOW);
  });

  it('does not refuse a scheduled future next action on a non-scheduled wake', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-scheduled-future',
      workspaceId: '*',
      sessionId: 'su-cold-scheduled-future',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({
        carryNote:
          '## Next action\nOn the next scheduled loop fire, call scheduler:get_next for the lane. Do not pull from inbox wakes.',
      }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
    expect(countFn).toHaveBeenCalledWith('su-cold-scheduled-future', NOW - 10 * 60_000, NOW);
  });

  it('still refuses a runnable action that merely mentions a later scheduled fire', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold-scheduled-immediate',
      workspaceId: '*',
      sessionId: 'su-cold-scheduled-immediate',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({
        carryNote: '## Next action\nRun scheduler:get_next now; the next scheduled loop fire can follow up.',
      }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toEqual([expect.objectContaining({ kind: 'cold-successor-no-progress' })]);
  });

  it('clears when the seam reports real progress (>0 tool calls)', async () => {
    const countFn = vi.fn(async () => 2);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold2',
      workspaceId: '*',
      sessionId: 'su-cold2',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief(),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });

  it('clears (fail-open) when the seam reports evidence-unavailable (null)', async () => {
    const countFn = vi.fn(async () => null);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold3',
      workspaceId: '*',
      sessionId: 'su-cold3',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief(),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });

  it('clears (fail-open) when the seam throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const countFn = vi.fn(async () => {
      throw new Error('pg unavailable');
    });
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-cold4',
      workspaceId: '*',
      sessionId: 'su-cold4',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief(),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('never calls the seam for a WARM loop, even at "zero progress"', async () => {
    const countFn = vi.fn(async () => 0);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-warm',
      workspaceId: '*',
      sessionId: 'su-warm',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({ carry: 'warm' }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(countFn).not.toHaveBeenCalled();
    expect(out.verdict).toBe('clear');
  });

  it('never calls the seam when no loop is armed', async () => {
    const countFn = vi.fn(async () => 0);
    await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-noloop',
      workspaceId: '*',
      sessionId: 'su-noloop',
      sinceIso: new Date(NOW).toISOString(),
      brief: brief(), // loop: null
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(countFn).not.toHaveBeenCalled();
  });

  it('never calls the seam when the loop carry-note has no timestamp', async () => {
    const countFn = vi.fn(async () => 0);
    await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-notime',
      workspaceId: '*',
      sessionId: 'su-notime',
      sinceIso: new Date(NOW).toISOString(),
      brief: coldLoopBrief({ carryNoteUpdatedAtMs: null }),
      nowMs: NOW,
      countAgentToolCallsFn: countFn,
    });
    expect(countFn).not.toHaveBeenCalled();
  });
});

// EI-21861120616734083: the flush gate's tripwires are built from a snapshot brief;
// a held item can go terminal between that read and the refusal reaching the agent,
// who then hits work_items:checkpoint's own (correct) terminal_item refusal trying
// to satisfy an instruction that is no longer possible. The gate now re-verifies
// missing/stale-checkpoint subjects right before refusing and drops any that are
// already terminal, so a dead-end refusal is never issued for them.
describe('runFlushGate — terminal-held-item race guard', () => {
  it('loads the default item-state reader lazily when a held-item tripwire needs rechecking', async () => {
    const getWorkItem = vi.fn(async (_id: string, _harness?: string) => ({ state: 'done' }));
    vi.doMock('./work-items', () => ({ getWorkItem }));
    try {
      const out = await runFlushGate({
        boundary: 'compaction',
        ownerId: 'su-lazy-item-read',
        workspaceId: '*',
        sessionId: 'su-lazy-item-read',
        sinceIso: new Date(NOW).toISOString(),
        brief: unflushedBrief(),
        nowMs: NOW,
      });
      expect(getWorkItem).toHaveBeenCalledExactlyOnceWith('WI-7', 'papercusp');
      expect(out.verdict).toBe('clear');
      expect(out.tripwires).toEqual([]);
    } finally {
      vi.doUnmock('./work-items');
    }
  });

  it('clears (no refusal) when the ONLY tripwire subject already went terminal', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-g',
      workspaceId: '*',
      sessionId: 'su-g',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(), // WI-7, missing-checkpoint per the snapshot
      nowMs: NOW,
      getWorkItemStateFn: async () => ({ state: 'done' }), // ...but it's terminal NOW
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });

  it('drops only the terminal subject, keeping a refusal for a genuinely-unflushed one', async () => {
    const twoHeld = brief({
      heldItems: [
        { id: 'WI-7', title: 't', body: null, harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null },
        { id: 'WI-8', title: 't2', body: null, harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null },
      ],
    });
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-h',
      workspaceId: '*',
      sessionId: 'su-h',
      sinceIso: new Date(NOW).toISOString(),
      brief: twoHeld,
      nowMs: NOW,
      getWorkItemStateFn: async (id) => ({ state: id === 'WI-7' ? 'done' : 'wip' }),
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toHaveLength(1);
    expect(out.tripwires[0].subject).toBe('WI-8');
    expect(out.refusalText).toContain('WI-8');
    expect(out.refusalText).not.toContain('WI-7');
  });

  it('fails soft (keeps the tripwire) when the re-check itself errors', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-i',
      workspaceId: '*',
      sessionId: 'su-i',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
      getWorkItemStateFn: async () => {
        throw new Error('state lookup unavailable');
      },
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toHaveLength(1);
    expect(out.tripwires[0].subject).toBe('WI-7');
  });

  it('fails soft (keeps the tripwire) when the re-check reports the item gone (null)', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-j',
      workspaceId: '*',
      sessionId: 'su-j',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
      getWorkItemStateFn: async () => null,
    });
    expect(out.verdict).toBe('refuse');
    expect(out.tripwires).toHaveLength(1);
  });
});
