import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { readCarryBlindWindow } from './carry-blind-window';

// EI-25951615327777689: the outer tools:invoke receipt lands 1 ms after
// its inner compaction receipt. It is already represented in the carry,
// while a later business call must still produce a recovery warning.
describe('carry blind window over real invocation rows', () => {
  const workspace = 'ws-carry-blind-window';
  const owner = 'su-carry-blind-window';
  const snapshot = '2026-10-14T10:10:37.220Z';
  const wrapper = '2026-10-14T10:10:37.221Z';
  const cut = '2026-10-14T10:11:39.000Z';
  const compactionArgs = { focus: 'Preserve the accepted shipment mission.' };
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('carry-blind-window');
    await db.sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS harness_shared;
      CREATE TABLE harness_shared.tool_invocations (
        coord_owner_id text NOT NULL,
        workspace_id text NOT NULL,
        tool_name text NOT NULL,
        invoked_at timestamptz NOT NULL,
        status text NOT NULL,
        args_json jsonb,
        call_origin text
      )
    `);
  });

  afterAll(async () => { await db?.cleanup(); });

  async function invocation(tool: string, at: string, args: unknown, status = 'ok', origin = 'agent') {
    await db.sql`
      INSERT INTO harness_shared.tool_invocations
        (coord_owner_id, workspace_id, tool_name, invoked_at, status, args_json, call_origin)
      VALUES (${owner}, ${workspace}, ${tool}, ${at}, ${status}, ${db.sql.json(args as never)}, ${origin})
    `;
  }

  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.tool_invocations`; });

  async function read() {
    return readCarryBlindWindow(owner, {
      workspaceId: workspace,
      now: Date.parse(cut) + 10_000,
      prior: { outcome: 'delivered', ts: cut },
      sql: db.sql,
    });
  }

  it('does not manufacture a window from the matching wrapper and successor startup', async () => {
    await invocation('session:request-compaction', snapshot, compactionArgs);
    await invocation('tools:invoke', wrapper, { name: 'session:request-compaction', args: compactionArgs });
    await invocation('activity:report', '2026-10-14T10:11:38.248Z', {
      kind: 'lifecycle', summary: 'session started', session_id: 'successor',
    }, 'ok', 'hook');
    expect(await read()).toBeNull();
  });

  it('recognizes a successful wrapper with omitted arguments for an empty snapshot', async () => {
    await invocation('session:request-compaction', snapshot, {});
    await invocation('tools:invoke', wrapper, { name: 'session:request-compaction' });
    expect(await read()).toBeNull();
  });

  it('still warns about a real business call after the snapshot', async () => {
    await invocation('session:request-compaction', snapshot, compactionArgs);
    await invocation('tools:invoke', wrapper, { name: 'session:request-compaction', args: compactionArgs });
    await invocation('reports:publish', '2026-10-14T10:11:00.000Z', { title: 'Late owner deliverable' });
    expect(await read()).toMatchObject({ callsAfter: 1, lastToolName: 'reports:publish' });
  });

  it('retains the wrapper when the snapshot arguments were not recorded', async () => {
    await invocation('session:request-compaction', snapshot, compactionArgs);
    await db.sql`UPDATE harness_shared.tool_invocations SET args_json = NULL`;
    await invocation('tools:invoke', wrapper, { name: 'session:request-compaction', args: compactionArgs });
    expect(await read()).toMatchObject({ callsAfter: 1, lastToolName: 'tools:invoke' });
  });

  it.each([
    ['a different target', { name: 'reports:publish', args: compactionArgs }, 'ok'],
    ['different compaction arguments', { name: 'session:request-compaction', args: { focus: 'A later request' } }, 'ok'],
    ['a failed matching wrapper', { name: 'session:request-compaction', args: compactionArgs }, 'error'],
    ['an unrecognized wrapper payload', {}, 'ok'],
  ] as const)('retains %s as unseen activity', async (_label, args, status) => {
    await invocation('session:request-compaction', snapshot, compactionArgs);
    await invocation('tools:invoke', wrapper, args, status);
    expect(await read()).toMatchObject({ callsAfter: 1, lastToolName: 'tools:invoke' });
  });
});
