import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readIndexedConsultCitedTurns } from './consult-dispatch';

let db: FreshPgDb;
const workspace = 'cited-turn-caller';
beforeAll(async () => {
  db = await createFreshPgDb('consult-cited-turns');
  await db.sql`CREATE TABLE harness_shared.session_turns (
    workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
    turn_idx integer NOT NULL, speaker text NOT NULL, ts timestamptz, text text NOT NULL,
    PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
  )`;
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

describe('consult cited-turn corpus admission', () => {
  it.each([workspace, 'default'])('reads router-admitted exact citations from %s', async (corpus) => {
    const session = `source-${corpus}`;
    await db.sql`INSERT INTO harness_shared.session_turns
      VALUES (${corpus}, 'codex', ${session}, 57, 'assistant', '2026-10-25T04:00:00Z', 'Exact cited evidence')`;
    expect(await readIndexedConsultCitedTurns(db.sql, workspace, session, [57])).toEqual([
      { turn_idx: 57, speaker: 'assistant', ts: '2026-10-25T04:00:00.000Z', text: 'Exact cited evidence' },
    ]);
    expect(await readIndexedConsultCitedTurns(db.sql, workspace, session, [58])).toEqual([]);
  });

  it('excludes another workspace even when its session and turn match', async () => {
    await db.sql`INSERT INTO harness_shared.session_turns
      VALUES ('foreign-workspace', 'codex', 'foreign-only', 43, 'assistant', NULL, 'Foreign evidence')`;
    expect(await readIndexedConsultCitedTurns(db.sql, workspace, 'foreign-only', [43])).toEqual([]);
    const [control] = await db.sql`SELECT text FROM harness_shared.session_turns
      WHERE workspace_id = 'foreign-workspace' AND session_id = 'foreign-only' AND turn_idx = 43`;
    expect(control.text).toBe('Foreign evidence');
  });

  it('preserves ambiguous and partial results for the dispatcher to refuse', async () => {
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      (${workspace}, 'codex', 'ambiguous-source', 73, 'assistant', NULL, 'Caller copy'),
      ('default', 'codex', 'ambiguous-source', 73, 'assistant', NULL, 'Shared copy'),
      ('default', 'codex', 'partial-source', 1, 'assistant', NULL, 'Readable'),
      ('default', 'codex', 'partial-source', 2, 'assistant', NULL, '  ')`;
    const ambiguous = await readIndexedConsultCitedTurns(db.sql, workspace, 'ambiguous-source', [73]);
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.map(row => row.turn_idx)).toEqual([73, 73]);
    expect(await readIndexedConsultCitedTurns(db.sql, workspace, 'partial-source', [1, 2]))
      .toEqual([
        { turn_idx: 1, speaker: 'assistant', ts: null, text: 'Readable' },
        { turn_idx: 2, speaker: 'assistant', ts: null, text: '  ' },
      ]);
    expect(await readIndexedConsultCitedTurns(db.sql, workspace, 'partial-source', [-1, NaN]))
      .toEqual([]);
  });
});
