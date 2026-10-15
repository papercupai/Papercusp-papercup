import { describe, expect, it, vi } from 'vitest';
import { DISPLAY_TERMINAL_LAUNCH } from '../../../adv-sessions';
import {
  describeLiveSourceRefusal,
  readPrePinnedOwnerBindings,
  type PrePinnedOwnerBindingDeps,
} from './pre-pinned-owner-conflicts';

// consult-backed-parking-2026-10-12#P-010: the ONE read bootstrap-su and the
// session-port inspect route share. Measured cause: 8 claude→codex resumes
// failed AFTER preparation because the source session was still live; inspect
// now refuses those first, and must agree with bootstrap-su row for row.

const OWNER = 'su-source-owner-1';
const boundRow: { id: string; display: string | null; has_session: boolean; launched: boolean } = {
  id: '39975',
  display: null,
  has_session: true,
  launched: false,
};

function deps(over: Partial<PrePinnedOwnerBindingDeps> & { rows?: Array<typeof boundRow> } = {}) {
  const repair = vi.fn(async () => 0);
  const load = vi.fn(async () => over.rows ?? [boundRow]);
  const resolve = over.resolveOwnerSessionState ?? vi.fn(async () => 'live' as const);
  return {
    repair,
    load,
    deps: {
      repairStaleTerminalMarkers: over.repairStaleTerminalMarkers ?? repair,
      loadUnendedRows: over.loadUnendedRows ?? load,
      resolveOwnerSessionState: resolve,
    } satisfies PrePinnedOwnerBindingDeps,
  };
}

describe('readPrePinnedOwnerBindings', () => {
  it('reports a live bound source session as a blocking conflict (the measured 409 cause)', async () => {
    const { deps: d } = deps();
    const bindings = await readPrePinnedOwnerBindings(OWNER, d);
    expect(bindings.conflicts.map((r) => r.id)).toEqual(['39975']);
    expect(bindings.reclaimableConflicts).toEqual([]);
    expect(bindings.sessionState).toBe('live');
  });

  it.each(['ended', 'suspect'] as const)('treats an oracle-%s source as reclaimable, not blocking', async (state) => {
    const { deps: d } = deps({ resolveOwnerSessionState: async () => state });
    const bindings = await readPrePinnedOwnerBindings(OWNER, d);
    expect(bindings.conflicts).toEqual([]);
    expect(bindings.reclaimableConflicts.map((r) => r.id)).toEqual(['39975']);
  });

  it.each(['parked', 'recorded', 'draining', undefined] as const)('keeps a %s owner blocking', async (state) => {
    const { deps: d } = deps({ resolveOwnerSessionState: async () => state });
    expect((await readPrePinnedOwnerBindings(OWNER, d)).conflicts).toHaveLength(1);
  });

  it('keeps the binding blocking when the liveness oracle read fails', async () => {
    const { deps: d } = deps({ resolveOwnerSessionState: async () => { throw new Error('oracle down'); } });
    const bindings = await readPrePinnedOwnerBindings(OWNER, d);
    expect(bindings.conflicts).toHaveLength(1);
    expect(bindings.sessionState).toBeUndefined();
  });

  it('never counts the launcher\'s own starting precursor row as a conflict', async () => {
    const { deps: d } = deps({
      rows: [{ id: '40001', display: DISPLAY_TERMINAL_LAUNCH, has_session: false, launched: false }],
    });
    const bindings = await readPrePinnedOwnerBindings(OWNER, d);
    expect(bindings.conflicts).toEqual([]);
    expect(bindings.precursors.map((r) => r.id)).toEqual(['40001']);
  });

  it('repairs half-terminal ghosts BEFORE reading the un-ended rows, for the same owner', async () => {
    const order: string[] = [];
    const bindings = await readPrePinnedOwnerBindings(OWNER, {
      repairStaleTerminalMarkers: async (owner) => { order.push(`repair:${owner}`); },
      loadUnendedRows: async (owner) => { order.push(`load:${owner}`); return []; },
      resolveOwnerSessionState: async () => 'live',
    });
    expect(order).toEqual([`repair:${OWNER}`, `load:${OWNER}`]);
    expect(bindings.conflicts).toEqual([]);
  });
});

describe('describeLiveSourceRefusal', () => {
  it('names the running source, its verdict, the way out, and that nothing was prepared', () => {
    const text = describeLiveSourceRefusal({
      sourceAdvSessionId: 39975,
      ownerId: OWNER,
      targetBackend: 'codex',
      bindings: { conflicts: [boundRow], sessionState: 'live' },
    });
    expect(text).toContain('source session 39975');
    expect(text).toContain(OWNER);
    expect(text).toContain('sessionState=live');
    expect(text).toContain('in codex');
    expect(text).toMatch(/Exit the source session first, then rerun psu --resume/);
    expect(text).toContain('Nothing was prepared or launched');
    expect(text).toContain('[live rows: 39975(display=null,session=bound)]');
    // The launch-internal wording is exactly what this replaces.
    expect(text).not.toContain('pre-pinned owners must be fresh');
  });
});
