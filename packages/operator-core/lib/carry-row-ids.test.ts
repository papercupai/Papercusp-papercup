import { describe, expect, it } from 'vitest';
import {
  checkpointRowsMode,
  mergeCarryRows,
  parseCarryNote,
  renderCarryNote,
  withStableCarryRowIds,
} from './carry-note';

describe('checkpoint carried-row retention contract', () => {
  const initial = () => renderCarryNote({
    did: 'Initial checkpoint',
    checks: [
      { id: 'verified-proof', claim: 'The regression passed', recheck: 'Read test_runs:1', verified: 'test_runs:1 passed', sinceMs: 100 },
      { id: 'pending-proof', claim: 'Integration verification remains open', recheck: 'Run the integration suite', sinceMs: 200 },
    ],
    walls: [{ id: 'approval', claim: 'Publication awaits approval', recheck: 'Read the approval record', sinceMs: 300 }],
  });

  it('keeps an open carried row omitted from a checkpoint write unless the write closes it by id', () => {
    const write = mergeCarryRows({
      priorNote: initial(),
      baseNote: renderCarryNote({ did: 'Narrative replaced' }),
      checks: [],
      walls: [],
      hasNoteWrite: true,
      mode: checkpointRowsMode('replace'),
      nowMs: 400,
    });
    const stored = parseCarryNote(withStableCarryRowIds(write.note));

    expect(stored.did).toBe('Narrative replaced');
    expect(stored.checks).toEqual([
      { id: 'verified-proof', claim: 'The regression passed', recheck: 'Read test_runs:1', verified: 'test_runs:1 passed', sinceMs: 100 },
      { id: 'pending-proof', claim: 'Integration verification remains open', recheck: 'Run the integration suite', sinceMs: 200 },
    ]);
    expect(stored.walls).toEqual([
      { id: 'approval', claim: 'Publication awaits approval', recheck: 'Read the approval record', sinceMs: 300 },
    ]);
    expect(write.droppedChecks).toEqual([]);
    expect(write.droppedWalls).toEqual([]);
  });

  it('closes only the carried row explicitly named by its stable id', () => {
    const write = mergeCarryRows({
      priorNote: initial(),
      baseNote: 'The integration check was completed',
      hasNoteWrite: true,
      mode: checkpointRowsMode('merge', ['pending-proof']),
      retire: ['pending-proof'],
      nowMs: 500,
    });
    const stored = parseCarryNote(withStableCarryRowIds(write.note));

    expect(stored.checks?.map(row => row.id)).toEqual(['verified-proof']);
    expect(stored.walls?.map(row => row.id)).toEqual(['approval']);
    expect(write.retiredChecks).toEqual(['Integration verification remains open']);
    expect(write.retiredWalls).toEqual([]);
    expect(stored.checks?.[0]).toMatchObject({ verified: 'test_runs:1 passed', sinceMs: 100 });
  });

  it('gives legacy checks and walls distinct identities which survive another rewrite', () => {
    const legacy = renderCarryNote({
      checks: [{ claim: 'Same wording', verified: 'test_runs:2 passed', sinceMs: 100 }],
      walls: [{ claim: 'Same wording', sinceMs: 200 }],
    });
    const identified = withStableCarryRowIds(legacy);
    const first = parseCarryNote(identified);
    expect(first.checks?.[0]?.id).toEqual(expect.any(String));
    expect(first.walls?.[0]?.id).toEqual(expect.any(String));
    expect(first.checks?.[0]?.id).not.toBe(first.walls?.[0]?.id);

    const write = mergeCarryRows({
      priorNote: identified,
      baseNote: 'Another checkpoint',
      hasNoteWrite: true,
      mode: checkpointRowsMode('replace'),
      nowMs: 600,
    });
    const stored = parseCarryNote(withStableCarryRowIds(write.note));
    expect(stored.checks).toEqual(first.checks);
    expect(stored.walls).toEqual(first.walls);
  });
});
