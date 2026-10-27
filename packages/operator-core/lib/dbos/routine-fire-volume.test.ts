import { describe, expect, it } from 'vitest';
import { evaluateRoutineFireVolume, ROUTINE_FIRE_VOLUME_DAY_MS as DAY,
  type RoutineFireVolumeWindow } from './routine-fire-volume';

const row = { workspaceId: 'ws', installSlug: 'pot', routineId: 'routine', targetRole: 'system:action', starts: 2000 };
const window = (overrides: Partial<RoutineFireVolumeWindow> = {}): RoutineFireVolumeWindow => ({
  startMs: DAY, endMs: 2 * DAY, observedAtMs: 2 * DAY,
  coveredFromMs: DAY - 1, triggerEnabled: true, rows: [row], ...overrides,
});
describe('committed routineFire volume', () => {
  it('uses strict >2000 and requires an individual reason above it', () => {
    expect(evaluateRoutineFireVolume(window(), []).status).toBe('pass');
    const high = window({ rows: [{ ...row, starts: 2001 }] });
    expect(evaluateRoutineFireVolume(high, []).status).toBe('fail');
    expect(evaluateRoutineFireVolume(high, [{ ...row, justification: 'Resumes committed external effects after restart.' }]).status).toBe('pass');
    expect(evaluateRoutineFireVolume(high, [{ ...row, justification: '  ' }]).status).toBe('fail');
  });
  it('requires a measured reduction and source receipt for the exact routine', () => {
    const high = window({ rows: [{ ...row, starts: 2100 }] });
    for (const baselineStarts of [2000, 2100]) expect(evaluateRoutineFireVolume(high,
      [{ ...row, reduction: { baselineStarts, evidenceRef: 'baseline-receipt' } }]).status).toBe('fail');
    expect(evaluateRoutineFireVolume(high, [{ ...row, reduction: { baselineStarts: 2200, evidenceRef: 'baseline-receipt' } }]).status).toBe('pass');
    expect(evaluateRoutineFireVolume(high, [{ ...row, reduction: { baselineStarts: 2200, evidenceRef: '' } }]).status).toBe('fail');
    expect(evaluateRoutineFireVolume(high, [{ ...row, routineId: 'other', justification: 'Other routine' }]).status).toBe('fail');
  });
  it('groups a routine across target changes before applying the threshold', () => {
    expect(evaluateRoutineFireVolume(window({ rows: [{ ...row, starts: 1001 },
      { ...row, targetRole: 'system:new', starts: 1000 }] }), []).status).toBe('fail');
  });
  it.each([
    { coveredFromMs: null }, { coveredFromMs: DAY + 1 }, { triggerEnabled: false },
    { observedAtMs: 2 * DAY - 1 }, { startMs: DAY + 1 }, { endMs: 2 * DAY - 1 },
    { observedAtMs: 9 * DAY }, { rows: [{ ...row, starts: NaN }] },
    { rows: [{ ...row, routineId: '@unattributed' }] },
  ])('keeps incomplete/unattributed observations unknown: %j', overrides => {
    expect(evaluateRoutineFireVolume(window(overrides), []).status).toBe('unknown');
  });
  it('accepts an observed zero window and rejects duplicate dispositions', () => {
    expect(evaluateRoutineFireVolume(window({ rows: [] }), []).status).toBe('pass');
    const disposition = { ...row, justification: 'Durable action' };
    expect(evaluateRoutineFireVolume(window({ rows: [{ ...row, starts: 2001 }] }),
      [disposition, disposition]).status).toBe('fail');
  });
});
