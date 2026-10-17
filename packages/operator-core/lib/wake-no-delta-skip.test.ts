import { describe, expect, it, vi } from 'vitest';
import { readWakeDelta, wakeHasNoDelta, type WakeDelta } from './wake-no-delta-skip';
import { fireLoopWake, type LoopFireDeps } from './harness/routines/loop-fire';
import type { AgentObligationAgendaRead } from './agent-obligation-reader';

const quiet: WakeDelta = { directedMail: false, eventPayload: false, ownerDirective: false,
  heldItemChange: false, dueObligation: false };
const base = { routineId: 'rt-loop', routineName: 'loop-su-owner', targetOwnerId: 'su-owner',
  workspaceId: 'papercusp-workspace', installSlug: 'papercusp', intervalSec: 60, payloadTemplate: null };
function deps(delta: WakeDelta | null) {
  return {
    readWakeDelta: vi.fn(async () => delta), checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })),
    recordFire: vi.fn(async () => {}), recordWithheld: vi.fn(async () => {}), rescheduleSuppressedWake: vi.fn(async () => true),
    listBlockingAwaits: vi.fn(async () => []), readFireCount: vi.fn(async () => 0),
    incrementFireCount: vi.fn(async () => {}), getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: 'Continue.', updatedAtMs: Date.now() })),
    takeWallNag: vi.fn(async () => null), renderOwnerDirectives: vi.fn(async () => null),
    readGoalHolderWakeState: vi.fn(async () => null), ownerStewardsActiveGoal: vi.fn(async () => false),
    ensureWakeArmed: vi.fn(async () => ({ armed: false, reason: 'already-armed' })),
    wake: vi.fn(async () => ({ targets: ['su-owner'], keys: [], woken: 1, staged: 0 })),
  } as unknown as LoopFireDeps & { wake: ReturnType<typeof vi.fn>; recordFire: ReturnType<typeof vi.fn>;
    recordWithheld: ReturnType<typeof vi.fn>; rescheduleSuppressedWake: ReturnType<typeof vi.fn> };
}

describe('loop no-delta wake guard (R-14)', () => {
  it('records an empty wake as skipped, restores a finite schedule and starts no turn', async () => {
    const d = deps(quiet);
    expect(await fireLoopWake(base, d)).toMatchObject({ fired: false, reason: 'no-delta' });
    expect(d.wake).not.toHaveBeenCalled();
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.recordWithheld).toHaveBeenCalledWith('papercusp', 'loop-su-owner', 'no-delta', expect.any(String));
    expect(d.rescheduleSuppressedWake).toHaveBeenCalledWith(expect.objectContaining({ resumeAtMs: expect.any(Number), intervalSec: 60 }));
  });

  it.each(Object.keys(quiet) as Array<keyof WakeDelta>)('delivers when %s is new', async (kind) => {
    const d = deps({ ...quiet, [kind]: true });
    expect(await fireLoopWake(base, d)).toMatchObject({ fired: true });
    expect(d.wake).toHaveBeenCalledOnce();
  });

  it('delivers when the evidence is unknown or the finite re-arm fails', async () => {
    for (const delta of [null, quiet]) {
      const d = deps(delta);
      d.rescheduleSuppressedWake.mockResolvedValue(false);
      expect(await fireLoopWake(base, d)).toMatchObject({ fired: true });
      expect(d.wake).toHaveBeenCalledOnce();
    }
    expect(wakeHasNoDelta(null)).toBe(false);
  });
});

describe('wake evidence reader', () => {
  function fixture(over: { degraded?: boolean; due?: boolean; deadline?: string; noBaseline?: boolean } = {}) {
    const sql = vi.fn().mockResolvedValueOnce([{ last_turn_at: '2026-10-15T12:00:00Z', held: over.noBaseline ? null : 'WI-1:open:1:123:0' }])
      .mockResolvedValueOnce([{ mail: false, event: false, directive: false, held: false }]);
    const readAgenda = vi.fn(async () => ({ degradedSources: over.degraded ? ['unknown'] : [],
      agenda: { evaluations: over.due ? [{ status: 'due', dueAt: over.deadline }] : [] } } as unknown as AgentObligationAgendaRead));
    return { sql: sql as never, readAgenda };
  }
  it('reads deltas since the real prior turn and includes previously held rows to detect releases', async () => {
    const f = fixture();
    expect(await readWakeDelta({ ...f, ownerId: base.targetOwnerId, workspaceId: base.workspaceId })).toEqual(quiet);
    expect(f.readAgenda).toHaveBeenCalledWith({ workspaceId: base.workspaceId, ownerId: base.targetOwnerId });
    const sql = f.sql as ReturnType<typeof vi.fn>;
    // session-ingest.ts writes CLI transcripts into the corpus partition,
    // independently of the operational workspace used by all the other reads.
    expect(sql.mock.calls[0]![0].join(' ')).toContain("workspace_id IN ('default',");
    expect(sql.mock.calls[1]![0].join(' ')).toContain('feature_id = ANY(');
    expect(sql.mock.calls[1]).toContainEqual(['WI-1']);
  });
  it('does not mistake a missing baseline or degraded obligation read for an empty wake', async () => {
    for (const over of [{ noBaseline: true }, { degraded: true }]) {
      expect(await readWakeDelta({ ...fixture(over), ownerId: base.targetOwnerId, workspaceId: base.workspaceId })).toBeNull();
    }
  });
  it('admits a due obligation and skips a deadline that has not arrived', async () => {
    for (const [deadline, due] of [['2026-10-15T12:00:00Z', true], ['2026-10-16T12:00:00Z', false]] as const) {
      const result = await readWakeDelta({ ...fixture({ due: true, deadline }), ownerId: base.targetOwnerId,
        workspaceId: base.workspaceId, nowMs: Date.parse('2026-10-15T13:00:00Z') });
      expect(result?.dueObligation).toBe(due);
    }
  });
});
